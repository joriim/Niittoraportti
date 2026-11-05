/**
 * Niittoraportti – Ruokaviraston INSPIRE-rajapinnan välityspalvelin (Cloudflare Worker).
 *
 * Ruokaviraston GeoServer ei lähetä CORS-otsakkeita eikä tue JSONP:tä, joten selain ei voi lukea
 * sen vastauksia suoraan. Tämä Worker välittää vain sovelluksen tarvitsemat lukukyselyt ja lisää
 * vastaukseen CORS-otsakkeen. Se ei ole avoin välityspalvelin:
 *   - vain GET, vain polut /wfs ja /wms, kohde aina inspire.ruokavirasto-awsa.com/geoserver
 *   - vain sallitut kyselyt: WFS GetFeature / DescribeFeatureType, WMS GetFeatureInfo / GetMap
 *   - WFS GetFeature vaatii suodattimen (CQL_FILTER tai BBOX) ja rajoittaa osumat (count ≤ 100)
 *   - kutsun Origin-otsakkeen on oltava sallittujen listalla (ALLOWED_ORIGINS)
 * Vastaukset välimuistitetaan (kasvulohkoaineisto päivittyy harvoin).
 *
 * Lisäksi Copernicus Data Space Ecosystemin (CDSE) tunnus- ja Statistical API -kutsut voi välittää
 * poluilla POST /cdse/token, /cdse/statistics ja /cdse/catalog, jos CDSE ei salli kutsua selaimesta.
 * Näitä ei välimuistiteta eikä kirjata; tunnukset kulkevat läpi muuttamattomina.
 */

const UPSTREAM = 'https://inspire.ruokavirasto-awsa.com/geoserver/';
const DEFAULT_ORIGINS = 'https://joriim.github.io,http://localhost:8000,http://127.0.0.1:8000';
const ALLOWED = {
  wfs: ['GetFeature', 'DescribeFeatureType'],
  wms: ['GetFeatureInfo', 'GetMap']
};
const MAX_COUNT = 100;
const CDSE = {
  token: 'https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token',
  statistics: 'https://sh.dataspace.copernicus.eu/statistics/v1',
  catalog: 'https://sh.dataspace.copernicus.eu/api/v1/catalog/1.0.0/search'
};
const CDSE_MAX_BODY = 200000;
const CACHE_SECONDS = 86400;

function origins(env) {
  return String((env && env.ALLOWED_ORIGINS) || DEFAULT_ORIGINS).split(',').map((s) => s.trim()).filter(Boolean);
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}

function error(status, message, origin) {
  const headers = { 'Content-Type': 'application/json; charset=utf-8', ...(origin ? corsHeaders(origin) : {}) };
  return new Response(JSON.stringify({ error: message }), { status, headers });
}

// Parametrien nimet ovat OGC-palveluissa kirjainkoosta riippumattomia.
function param(sp, name) {
  for (const [k, v] of sp) if (k.toLowerCase() === name.toLowerCase()) return v;
  return null;
}
function setParam(sp, name, value) {
  for (const k of [...sp.keys()]) if (k.toLowerCase() === name.toLowerCase()) sp.delete(k);
  sp.set(name, value);
}

/** Tarkistaa CDSE-välityksen. Palauttaa { url } tai { status, message }. */
export function checkCdse(url, request) {
  const m = /^\/cdse\/(token|statistics|catalog)\/?$/.exec(url.pathname);
  if (!m) return { status: 404, message: 'Sallitut CDSE-polut: /cdse/token, /cdse/statistics ja /cdse/catalog.' };
  if (request.method !== 'POST') return { status: 405, message: 'CDSE-välitys: vain POST.' };
  const ct = (request.headers.get('Content-Type') || '').toLowerCase();
  if (m[1] === 'token' && !ct.startsWith('application/x-www-form-urlencoded')) return { status: 400, message: 'Tunnuskutsun sisältötyyppi on application/x-www-form-urlencoded.' };
  if (m[1] !== 'token' && !ct.startsWith('application/json')) return { status: 400, message: 'Statistical- ja Catalog API -kutsun sisältötyyppi on application/json.' };
  if (m[1] !== 'token' && !/^Bearer\s+\S+$/.test(request.headers.get('Authorization') || '')) return { status: 401, message: 'Statistical API vaatii Bearer-tokenin.' };
  const len = parseInt(request.headers.get('Content-Length') || '0', 10);
  if (len > CDSE_MAX_BODY) return { status: 413, message: 'Kutsu on liian suuri.' };
  return { url: CDSE[m[1]], kind: m[1] };
}

async function proxyCdse(request, url, okOrigin) {
  const chk = checkCdse(url, request);
  if (!chk.url) return error(chk.status, chk.message, okOrigin);
  const body = await request.text();
  if (body.length > CDSE_MAX_BODY) return error(413, 'Kutsu on liian suuri.', okOrigin);
  if (chk.kind === 'token' && !/(^|&)grant_type=client_credentials(&|$)/.test(body)) return error(400, 'Vain client_credentials-tunnus.', okOrigin);
  const headers = { 'Content-Type': request.headers.get('Content-Type'), 'User-Agent': 'Niittoraportti-proxy' };
  if (chk.kind !== 'token') headers.Authorization = request.headers.get('Authorization');
  let up;
  try { up = await fetch(chk.url, { method: 'POST', headers, body }); } catch (e) { return error(502, 'Copernicus Data Space ei vastannut.', okOrigin); }
  const out = new Response(up.body, { status: up.status, headers: { 'Content-Type': up.headers.get('Content-Type') || 'application/json', 'Cache-Control': 'no-store' } });
  for (const [k, v] of Object.entries(corsHeaders(okOrigin))) out.headers.set(k, v);
  return out;
}

/** Tarkistaa kyselyn. Palauttaa { url } tai { status, message }. */
export function checkRequest(url) {
  const service = url.pathname.replace(/^\/+|\/+$/g, '').toLowerCase();
  if (!ALLOWED[service]) return { status: 404, message: 'Sallitut polut: /wfs ja /wms.' };
  const sp = new URLSearchParams(url.search);
  const req = param(sp, 'request');
  const okReq = ALLOWED[service].find((r) => r.toLowerCase() === String(req || '').toLowerCase());
  if (!okReq) return { status: 400, message: `Sallitut ${service.toUpperCase()}-kyselyt: ${ALLOWED[service].join(', ')}.` };
  const layer = param(sp, 'typeNames') || param(sp, 'typeName') || param(sp, 'layers') || param(sp, 'query_layers') || '';
  if (!/^inspire:[A-Za-z.]+\.\d{4}(,inspire:[A-Za-z.]+\.\d{4})*$/.test(layer)) return { status: 400, message: 'Tuntematon taso.' };
  if (okReq === 'GetFeature') {
    if (!param(sp, 'CQL_FILTER') && !param(sp, 'BBOX') && !param(sp, 'FILTER')) return { status: 400, message: 'GetFeature vaatii suodattimen (CQL_FILTER tai BBOX).' };
    const n = parseInt(param(sp, 'count') || param(sp, 'maxFeatures') || '0', 10);
    setParam(sp, 'count', String(Math.min(n > 0 ? n : MAX_COUNT, MAX_COUNT)));
  }
  if (okReq === 'GetMap') {
    const w = parseInt(param(sp, 'width') || '0', 10), h = parseInt(param(sp, 'height') || '0', 10);
    if (!(w > 0 && h > 0 && w <= 1024 && h <= 1024)) return { status: 400, message: 'GetMap-kuvan koko 1–1024 px.' };
  }
  return { url: UPSTREAM + service + '?' + sp.toString() };
}

export default {
  async fetch(request, env, ctx) {
    const origin = request.headers.get('Origin');
    const allowed = origins(env);
    const okOrigin = origin && allowed.includes(origin) ? origin : null;
    const url = new URL(request.url);

    if (url.pathname === '/' || url.pathname === '') {
      return new Response('Niittoraportti: Ruokaviraston INSPIRE-rajapinnan välityspalvelin. Polut /wfs ja /wms.\n', { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    if (request.method === 'OPTIONS') {
      return okOrigin ? new Response(null, { status: 204, headers: corsHeaders(okOrigin) }) : error(403, 'Origin ei ole sallittu.');
    }
    if (!okOrigin) return error(403, 'Origin ei ole sallittu. Lisää se ALLOWED_ORIGINS-muuttujaan.');
    if (url.pathname.startsWith('/cdse/')) return proxyCdse(request, url, okOrigin);
    if (request.method !== 'GET') return error(405, 'Vain GET.', okOrigin);

    const chk = checkRequest(url);
    if (!chk.url) return error(chk.status, chk.message, okOrigin);

    const cache = typeof caches !== 'undefined' ? caches.default : null;
    const key = new Request(chk.url, { method: 'GET' });
    let res = cache ? await cache.match(key) : null;
    if (!res) {
      let up;
      try {
        up = await fetch(chk.url, { headers: { 'User-Agent': 'Niittoraportti-proxy' }, cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true } });
      } catch (e) {
        return error(502, 'Ruokaviraston rajapinta ei vastannut.', okOrigin);
      }
      const ct = up.headers.get('Content-Type') || 'application/octet-stream';
      res = new Response(up.body, { status: up.status, headers: { 'Content-Type': ct, 'Cache-Control': `public, max-age=${up.ok ? CACHE_SECONDS : 60}` } });
      if (cache && up.ok && ctx && ctx.waitUntil) ctx.waitUntil(cache.put(key, res.clone()));
    }
    const out = new Response(res.body, res);
    for (const [k, v] of Object.entries(corsHeaders(okOrigin))) out.headers.set(k, v);
    return out;
  }
};
