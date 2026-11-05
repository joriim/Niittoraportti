// Workerin testit ilman verkkoa: Ruokaviraston vastaus korvataan mockilla. Aja: node worker/test.js
import assert from 'node:assert';
import worker, { checkRequest, checkCdse } from './src/index.js';

let n = 0;
const t = async (name, f) => { await f(); n++; console.log('ok', name); };
const ORIGIN = 'https://joriim.github.io';
const BASE = 'https://niittoraportti-rv.example.workers.dev';
const calls = [];
globalThis.fetch = async (url, init) => {
  calls.push(String(url)); calls.init = init;
  return new Response(JSON.stringify({ type: 'FeatureCollection', features: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
const get = (path, origin = ORIGIN, method = 'GET') =>
  worker.fetch(new Request(BASE + path, { method, headers: origin ? { Origin: origin } : {} }), {}, { waitUntil() {} });
const WFS = '/wfs?service=WFS&version=2.0.0&request=GetFeature&typeNames=inspire:LandUse.ExistingLandUse.GSAAAgriculturalParcel.2025&outputFormat=application/json&CQL_FILTER=' + encodeURIComponent("PERUSLOHKOTUNNUS='9750548215'");

await t('sallittu origin: kysely välitetään ja CORS-otsake lisätään', async () => {
  const r = await get(WFS + '&count=50');
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  assert.strictEqual(r.headers.get('Vary'), 'Origin');
  assert.deepStrictEqual(await r.json(), { type: 'FeatureCollection', features: [] });
  const up = new URL(calls.at(-1));
  assert.strictEqual(up.origin + up.pathname, 'https://inspire.ruokavirasto-awsa.com/geoserver/wfs');
  assert.strictEqual(up.searchParams.get('CQL_FILTER'), "PERUSLOHKOTUNNUS='9750548215'");
  assert.strictEqual(up.searchParams.get('count'), '50');
});

await t('kielletty tai puuttuva origin → 403, ei välitystä', async () => {
  const before = calls.length;
  assert.strictEqual((await get(WFS, 'https://example.com')).status, 403);
  assert.strictEqual((await get(WFS, null)).status, 403);
  assert.strictEqual(calls.length, before);
});

await t('esikysely (OPTIONS) sallitulta originilta', async () => {
  const r = await get(WFS, ORIGIN, 'OPTIONS');
  assert.strictEqual(r.status, 204);
  assert.strictEqual(r.headers.get('Access-Control-Allow-Origin'), ORIGIN);
});

await t('vain sallitut polut, kyselyt ja tasot', () => {
  const u = (p) => checkRequest(new URL(BASE + p));
  assert.strictEqual(u('/ows?request=GetFeature').status, 404);
  assert.strictEqual(u('/wfs?request=Transaction&typeNames=inspire:A.2025').status, 400);
  assert.strictEqual(u('/wfs?request=GetCapabilities').status, 400);
  assert.strictEqual(u('/wfs?request=GetFeature&typeNames=muu:taso').status, 400);
  assert.match(u('/wfs?request=GetFeature&typeNames=inspire:LandUse.ExistingLandUse.GSAAAgriculturalParcel.2025').message, /suodattimen/);
  assert.ok(u('/wfs?request=DescribeFeatureType&typeNames=inspire:LC.LandCoverSurfaces.LPIS.2025').url);
  assert.ok(u('/wms?request=GetFeatureInfo&layers=inspire:LandUse.ExistingLandUse.GSAAAgriculturalParcel.2023&query_layers=inspire:LandUse.ExistingLandUse.GSAAAgriculturalParcel.2023').url);
  assert.strictEqual(u('/wms?request=GetMap&layers=inspire:LandUse.ExistingLandUse.GSAAAgriculturalParcel.2023&width=5000&height=5000').status, 400);
});

await t('osumamäärä rajataan 100:aan', () => {
  const c = checkRequest(new URL(BASE + WFS + '&count=100000'));
  assert.strictEqual(new URL(c.url).searchParams.get('count'), '100');
  const d = checkRequest(new URL(BASE + WFS));
  assert.strictEqual(new URL(d.url).searchParams.get('count'), '100');
});

await t('vain GET', async () => {
  assert.strictEqual((await get(WFS, ORIGIN, 'POST')).status, 405);
});

await t('Ruokavirasto ei vastaa → 502 CORS-otsakkeella', async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('connect failed'); };
  const r = await get(WFS);
  assert.strictEqual(r.status, 502);
  assert.strictEqual(r.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  globalThis.fetch = real;
});

await t('ALLOWED_ORIGINS-muuttuja ohittaa oletuksen', async () => {
  const r = await worker.fetch(new Request(BASE + WFS, { headers: { Origin: 'https://oma.example' } }), { ALLOWED_ORIGINS: 'https://oma.example' }, { waitUntil() {} });
  assert.strictEqual(r.status, 200);
});

const post = (path, body, headers = {}, origin = ORIGIN) =>
  worker.fetch(new Request(BASE + path, { method: 'POST', body, headers: { ...(origin ? { Origin: origin } : {}), ...headers } }), {}, { waitUntil() {} });

await t('CDSE: tunnus ja Statistical API välitetään POSTina, ei välimuistia', async () => {
  let r = await post('/cdse/token', 'grant_type=client_credentials&client_id=a&client_secret=b', { 'Content-Type': 'application/x-www-form-urlencoded' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(calls.at(-1), 'https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token');
  assert.strictEqual(calls.init.method, 'POST');
  assert.match(calls.init.body, /client_secret=b/);
  assert.strictEqual(r.headers.get('Cache-Control'), 'no-store');
  assert.strictEqual(r.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  r = await post('/cdse/statistics', '{"input":{}}', { 'Content-Type': 'application/json', Authorization: 'Bearer abc' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(calls.at(-1), 'https://sh.dataspace.copernicus.eu/statistics/v1');
  assert.strictEqual(calls.init.headers.Authorization, 'Bearer abc');
  r = await post('/cdse/catalog', '{"collections":["sentinel-1-grd"]}', { 'Content-Type': 'application/json', Authorization: 'Bearer abc' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(calls.at(-1), 'https://sh.dataspace.copernicus.eu/api/v1/catalog/1.0.0/search');
});

await t('CDSE: väärät kutsut hylätään', async () => {
  const before = calls.length;
  assert.strictEqual((await post('/cdse/token', 'grant_type=password&username=x', { 'Content-Type': 'application/x-www-form-urlencoded' })).status, 400);
  assert.strictEqual((await post('/cdse/statistics', '{}', { 'Content-Type': 'application/json' })).status, 401);
  assert.strictEqual((await post('/cdse/process', '{}', { 'Content-Type': 'application/json', Authorization: 'Bearer a' })).status, 404);
  assert.strictEqual((await post('/cdse/token', 'grant_type=client_credentials', { 'Content-Type': 'application/x-www-form-urlencoded' }, 'https://example.com')).status, 403);
  assert.strictEqual((await get('/cdse/token')).status, 405);
  assert.strictEqual(calls.length, before);
  assert.strictEqual(checkCdse(new URL(BASE + '/cdse/statistics'), new Request(BASE, { method: 'POST', headers: { 'Content-Type': 'text/plain' } })).status, 400);
});

console.log(n + ' testiä läpi');
