// Workerin testit ilman verkkoa: Ruokaviraston vastaus korvataan mockilla. Aja: node worker/test.js
import assert from 'node:assert';
import worker, { checkRequest } from './src/index.js';

let n = 0;
const t = async (name, f) => { await f(); n++; console.log('ok', name); };
const ORIGIN = 'https://joriim.github.io';
const BASE = 'https://niittoraportti-rv.example.workers.dev';
const calls = [];
globalThis.fetch = async (url) => {
  calls.push(String(url));
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

console.log(n + ' testiä läpi');
