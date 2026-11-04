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
 */

const UPSTREAM = 'https://inspire.ruokavirasto-awsa.com/geoserver/';
const DEFAULT_ORIGINS = 'https://joriim.github.io,http://localhost:8000,http://127.0.0.1:8000';
const ALLOWED = {
  wfs: ['GetFeature', 'DescribeFeatureType'],
  wms: ['GetFeatureInfo', 'GetMap']
};
const MAX_COUNT = 100;
const CACHE_SECONDS = 86400;

function origins(env) {
  return String((env && env.ALLOWED_ORIGINS) || DEFAULT_ORIGINS).split(',').map((s) => s.trim()).filter(Boolean);
}

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
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
    if (request.method !== 'GET') return error(405, 'Vain GET.', okOrigin);
    if (!okOrigin) return error(403, 'Origin ei ole sallittu. Lisää se ALLOWED_ORIGINS-muuttujaan.');

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
