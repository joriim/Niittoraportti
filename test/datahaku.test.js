// Datahaun testit: geometria, projektio, tilastot sekä HLS- ja PlanetScope-ketju
// synteettisillä GeoTIFF-kuvilla ja mockatuilla rajapinnoilla (ei verkkoyhteyttä).
// Aja: npm install && node test/datahaku.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const H = require('../datahaku.js');

let GT;
try { GT = require('geotiff'); } catch (e) {
  console.log('ohitetaan rasteritestit: asenna kehitysriippuvuudet komennolla npm install');
}
if (GT) H._setGeoTIFF(GT);

const FX = path.join(__dirname, 'fixtures');
let n = 0;
async function t(name, f) { await f(); n++; console.log('ok', name); }
const field = H.parseField(fs.readFileSync(path.join(FX, 'field.geojson'), 'utf8'));

// ---------- mock-fetch ----------
const log = [];
function fileResponse(file, req) {
  const buf = fs.readFileSync(path.join(FX, file));
  const range = req && req.headers && (req.headers.Range || req.headers.range || (req.headers.get && req.headers.get('range')));
  if (range) {
    const m = /bytes=(\d+)-(\d+)?/.exec(range);
    const a = +m[1], b = Math.min(m[2] ? +m[2] : buf.length - 1, buf.length - 1);
    return new Response(buf.subarray(a, b + 1), { status: 206, headers: { 'Content-Range': `bytes ${a}-${b}/${buf.length}`, 'Content-Length': String(b - a + 1) } });
  }
  return new Response(buf, { status: 200 });
}
const json = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { 'Content-Type': 'application/json' } });
const blob = (f) => `https://hls2euwest.blob.core.windows.net/hls2/2026/${f}`;
function hlsItem(id, coll, date, prefix, nir, epsg) {
  return { id, collection: coll, properties: { datetime: date + 'T09:40:31Z', 'proj:epsg': epsg },
    assets: { B04: { href: blob(prefix + '.B04.tif') }, [nir]: { href: blob(`${prefix}.${nir}.tif`) }, Fmask: { href: blob(prefix + '.Fmask.tif') } } };
}
const PAGE1 = [
  hlsItem('HLS.S30.T35VLL.2026191T094031.v2.0', 'hls2-s30', '2026-07-10', 'hls1', 'B8A', 32635),
  hlsItem('HLS.L30.T35VLL.2026201T093522.v2.0', 'hls2-l30', '2026-07-20', 'hls2', 'B05', 32635),
  hlsItem('HLS.S30.T35VLL.2026217T094029.v2.0', 'hls2-s30', '2026-08-05', 'hls3', 'B8A', 32635),
];
const PAGE2 = [
  hlsItem('HLS.S30.T35VLK.2026217T094029.v2.0', 'hls2-s30', '2026-08-05', 'hls4', 'B8A', 32635),
  hlsItem('HLS.L30.T34VFQ.2026227T093522.v2.0', 'hls2-l30', '2026-08-15', 'hls5', 'B05', 32634),
];
const PS = ['20260801_093000_00_2475', '20260810_093100_00_2475'];
const KEY = 'PLAK-testi';
const AUTH = 'Basic ' + Buffer.from(KEY + ':').toString('base64');

global.fetch = async (url, req) => {
  url = String(url); req = req || {};
  log.push((req.method || 'GET') + ' ' + url);
  const E = H.ENDPOINTS;
  if (url === E.PC_STAC + '/search') {
    const b = JSON.parse(req.body);
    assert.deepStrictEqual(b.collections, ['hls2-s30', 'hls2-l30']);
    assert.strictEqual(b.intersects.type, 'Polygon');
    if (b.token === 'p2') return json({ features: PAGE2, links: [] });
    return json({ features: PAGE1, links: [{ rel: 'next', method: 'POST', href: E.PC_STAC + '/search', body: { token: 'p2' } }] });
  }
  if (url === E.PC_SAS + '/hls2euwest/hls2') return json({ token: 'sv=2024&sig=abc', 'msft:expiry': new Date(Date.now() + 3600e3).toISOString() });
  if (url.startsWith('https://hls2euwest.blob.core.windows.net/')) {
    assert.ok(url.includes('sig=abc'), 'blob-osoite allekirjoitettu');
    return fileResponse(url.split('/').pop().split('?')[0], req);
  }
  if (url.startsWith(E.PL_DATA + '/quick-search') || url === E.PL_DATA + '/searches/next') {
    assert.strictEqual(req.headers.Authorization, AUTH);
    if (url.endsWith('/next')) return json({ features: [
      { id: PS[1], properties: { acquired: '2026-08-10T09:31:00Z', clear_percent: 90, cloud_cover: 0.1 } }], _links: {} });
    return json({ features: [
      { id: PS[0], properties: { acquired: '2026-08-01T09:30:00Z', clear_percent: 98, cloud_cover: 0.02 } },
      { id: '20260801_100000_00_24aa', properties: { acquired: '2026-08-01T10:00:00Z', clear_percent: 60, cloud_cover: 0.4 } }],
      _links: { _next: E.PL_DATA + '/searches/next' } });
  }
  if (url === E.PL_ORDERS && req.method === 'POST') {
    assert.strictEqual(req.headers.Authorization, AUTH);
    const b = JSON.parse(req.body);
    assert.deepStrictEqual(b.products[0].item_ids, PS);
    assert.strictEqual(b.products[0].product_bundle, 'analytic_sr_udm2');
    assert.deepStrictEqual(b.tools.map((x) => Object.keys(x)[0]), ['clip', 'harmonize']);
    return json({ id: 'ord-1', state: 'queued' }, 202);
  }
  if (url === E.PL_ORDERS + '/ord-1') {
    const results = [];
    PS.forEach((id) => {
      results.push({ name: `ord-1/PSScene/${id}_3B_AnalyticMS_SR_harmonized_clip.tif`, location: `https://api.planet.com/compute/ops/download/?token=${id}_sr` });
      results.push({ name: `ord-1/PSScene/${id}_3B_udm2_clip.tif`, location: `https://api.planet.com/compute/ops/download/?token=${id}_udm` });
      results.push({ name: `ord-1/PSScene/${id}_metadata.json`, location: 'https://api.planet.com/compute/ops/download/?token=meta' });
    });
    return json({ id: 'ord-1', state: 'success', _links: { results } });
  }
  if (url.startsWith('https://api.planet.com/compute/ops/download/?token=')) {
    const tok = url.split('token=')[1];
    const id = tok.replace(/_(sr|udm)$/, '');
    return fileResponse(tok.endsWith('_sr') ? `${id}_3B_AnalyticMS_SR_harmonized_clip.tif` : `${id}_3B_udm2_clip.tif`);
  }
  return new Response('not found: ' + url, { status: 404 });
};

(async () => {
  await t('projektio vastaa pyprojia (mm-tarkkuus) ja palautuu', () => {
    const [x, y] = H.toUtm(22.84, 62.79, 3067);
    assert.ok(Math.abs(x - 287881.712) < 0.01 && Math.abs(y - 6969044.590) < 0.01);
    const [x2, y2] = H.toUtm(22.84, 62.79, 32634);
    assert.ok(Math.abs(x2 - 593860.174) < 0.01 && Math.abs(y2 - 6963532.477) < 0.01);
    const [lon, lat] = H.toLonLat(x, y, 3067);
    assert.ok(Math.abs(lon - 22.84) < 1e-7 && Math.abs(lat - 62.79) < 1e-7);
  });

  await t('lohko: EPSG:3067 tunnistetaan, pinta-ala ja WGS84-geometria', () => {
    assert.strictEqual(field.sourceEpsg, 3067);
    assert.ok(Math.abs(field.areaM2 - 60000) < 1, 'ala ' + field.areaM2);
    assert.ok(field.bbox[0] > 22 && field.bbox[2] < 23 && field.bbox[1] > 62.7 && field.bbox[3] < 62.9);
    assert.strictEqual(field.properties.tunnus, 'TESTI-1');
    const w = H.parseField({ type: 'Polygon', coordinates: field.polys[0] });
    assert.strictEqual(w.sourceEpsg, 4326);
    assert.ok(Math.abs(w.areaM2 - 60000) < 1);
  });

  await t('lohko: virheellinen syöte antaa selkeän virheen', () => {
    assert.throws(() => H.parseField({ type: 'Point', coordinates: [1, 2] }), /monikulmiota/);
  });

  await t('Fmask: pilvi, varjo, lumi, sirrus ja korkea aerosoli hylätään; vesi ja matala aerosoli kelpaavat', () => {
    [0, 32, 64, 128].forEach((v) => assert.ok(H.fmaskValid(v), 'kelpaa ' + v));
    [1, 2, 4, 8, 16, 192, 194].forEach((v) => assert.ok(!H.fmaskValid(v), 'hylätään ' + v));
  });

  if (!GT) { console.log(n + ' testiä läpi (rasteritestit ohitettu)'); return; }

  let hls;
  await t('HLS: haku sivuttaa, allekirjoittaa ja laskee havainnot', async () => {
    const prog = [];
    hls = await H.fetchHls(field, '2026-07-01', '2026-08-31', { bufferM: 10, onProgress: (m) => prog.push(m) });
    assert.strictEqual(hls.searched, 5);
    assert.deepStrictEqual(hls.skipped, []);
    assert.strictEqual(log.filter((l) => l.includes('/api/sas/')).length, 1, 'SAS-token välimuistissa');
    assert.ok(prog.some((m) => /5\/5/.test(m)));
    const by = Object.fromEntries(hls.obs.map((o) => [o.date, o]));
    assert.deepStrictEqual(Object.keys(by), ['2026-07-10', '2026-07-20', '2026-08-05', '2026-08-15']);
    assert.deepStrictEqual(by['2026-07-10'], { date: '2026-07-10', src: 'HLS-S30', id: PAGE1[0].id, value: 0.8, valid: 100, changed: null });
    assert.strictEqual(by['2026-07-20'].src, 'HLS-L30');
    assert.strictEqual(by['2026-07-20'].value, 0.45);
    assert.strictEqual(by['2026-07-20'].valid, 33, 'pilvinen pohjoisosa hylätty');
    // 5.8.: pilvetön ruutu valitaan, ja muutosta verrataan 10.7. kuvaan (20.7. kelvollisia < 50 %)
    assert.strictEqual(by['2026-08-05'].id, PAGE1[2].id);
    assert.strictEqual(by['2026-08-05'].value, 0.45);
    assert.strictEqual(by['2026-08-05'].valid, 100);
    assert.strictEqual(by['2026-08-05'].changed, 94);
    // 15.8.: vyöhykkeen 34 ruudukko, itäreunan korkea aerosoli hylätty, vesi kelpaa
    assert.strictEqual(by['2026-08-15'].value, 0.55);
    assert.strictEqual(by['2026-08-15'].valid, 84); // sama kuin Python-skriptissä
    // 5.8. kuvan kolmessa 0,80-pikselissä 0,80 → 0,55 on aito pudotus; muualla nousu
    assert.strictEqual(by['2026-08-15'].changed, 6);
  });

  await t('reunapuskuri: pikselin keskipisteen on oltava vähintään puskurin päässä reunasta', async () => {
    const img = await (await GT.fromArrayBuffer(fs.readFileSync(path.join(FX, 'hls1.B04.tif')).buffer)).getImage();
    assert.strictEqual(H.fieldWindow(img, 32635, field, 0).n, 60);
    assert.strictEqual(H.fieldWindow(img, 32635, field, 10).n, 54);
    assert.strictEqual(H.fieldWindow(img, 32635, field, 40).n, 28);
  });

  await t('HLS-havainnot kelpaavat suoraan niiton tunnistukseen', () => {
    const C = require('../core.js');
    const r = C.analyze(hls.obs, { measure: 'Luonnonhoitonurmi' });
    assert.ok(r.best, 'tapahtuma löytyy');
    assert.strictEqual(r.best.start, '2026-07-10');
    assert.strictEqual(r.best.end, '2026-08-05');
  });

  let sel;
  await t('PlanetScope: haku valitsee päivän selkeimmän kuvan ja arvioi alan', async () => {
    sel = await H.psSearch(KEY, field, '2026-07-01', '2026-08-31', { maxCloud: 50 });
    assert.strictEqual(sel.all, 3);
    assert.deepStrictEqual(sel.chosen.map((c) => c.id), PS);
    assert.ok(Math.abs(sel.estimateKm2 - 0.12) < 1e-6);
  });

  await t('PlanetScope: tilaus, tila ja käsittely', async () => {
    const id = await H.psOrder(KEY, field, sel.chosen.map((c) => c.id), 'Niittoraportti TESTI-1');
    assert.strictEqual(id, 'ord-1');
    const st = await H.psOrderStatus(KEY, id);
    assert.strictEqual(st.state, 'success');
    const res = await H.psProcess(st.results, field, PS, { bufferM: 10 });
    assert.deepStrictEqual(res.skipped, []);
    assert.strictEqual(res.obs.length, 2);
    const [a, b] = res.obs;
    assert.deepStrictEqual([a.date, a.src, a.id, a.value, a.valid, a.changed], ['2026-08-01', 'PlanetScope', PS[0], 0.83, 100, null]);
    assert.deepStrictEqual([b.date, b.value, b.changed], ['2026-08-10', 0.4, 100]);
    assert.strictEqual(b.valid, 93); // sama kuin Python-skriptissä
  });

  await t('PlanetScope: puuttuva avain ja väärä avain antavat ymmärrettävän virheen', async () => {
    await assert.rejects(() => H.psSearch('', field, '2026-07-01', '2026-08-31'), /API-avain puuttuu/);
    const real = global.fetch;
    global.fetch = async () => new Response('{"message":"Unauthorized"}', { status: 401 });
    await assert.rejects(() => H.psSearch('väärä', field, '2026-07-01', '2026-08-31'), /HTTP 401 – tarkista API-avain/);
    global.fetch = async () => { throw new TypeError('Failed to fetch'); };
    await assert.rejects(() => H.psSearch('x', field, '2026-07-01', '2026-08-31'), /CORS.*hae_havainnot\.py/);
    global.fetch = real;
  });

  console.log(n + ' testiä läpi');
})().catch((e) => { console.error(e); process.exit(1); });
