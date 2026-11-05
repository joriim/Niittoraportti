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
const s2blob = (f) => `https://sentinel2l2a01.blob.core.windows.net/sentinel2-l2/35/V/LL/2026/${f}`;
function s2ItemFx(id, date, prefix, baseline, blue) {
  return { id, collection: 'sentinel-2-l2a', properties: { datetime: date + 'T09:50:31Z', 'proj:epsg': 32635, 's2:processing_baseline': baseline },
    assets: Object.assign({ B04: { href: s2blob(prefix + '.B04.tif') }, B08: { href: s2blob(prefix + '.B08.tif') }, SCL: { href: s2blob(prefix + '.SCL.tif') } },
      blue ? { B02: { href: s2blob(prefix + '.B02.tif') } } : {}) };
}
const S2_ITEMS = [
  s2ItemFx('S2B_MSIL2A_20260710T095029_N0511_R079_T35VLL_20260710T120000', '2026-07-10', 's2a', '05.11'),
  s2ItemFx('S2A_MSIL2A_20260728T095031_N0511_R079_T35VLL_20260728T120000', '2026-07-28', 's2b', '05.11'),
  s2ItemFx('S2C_MSIL2A_20260817T095029_N0511_R079_T35VLL_20260817T120000', '2026-08-17', 's2c', '05.11', true),
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
    if (b.collections[0] === 'sentinel-2-l2a') { assert.strictEqual(b.collections.length, 1); return json({ features: S2_ITEMS, links: [] }); }
    assert.deepStrictEqual(b.collections, ['hls2-s30', 'hls2-l30']);
    assert.strictEqual(b.intersects.type, 'Polygon');
    if (b.token === 'p2') return json({ features: PAGE2, links: [] });
    return json({ features: PAGE1, links: [{ rel: 'next', method: 'POST', href: E.PC_STAC + '/search', body: { token: 'p2' } }] });
  }
  if (url === E.PC_SAS + '/hls2euwest/hls2') return json({ token: 'sv=2024&sig=abc', 'msft:expiry': new Date(Date.now() + 3600e3).toISOString() });
  if (url === E.PC_SAS + '/sentinel2l2a01/sentinel2-l2') return json({ token: 'sv=2024&sig=s2', 'msft:expiry': new Date(Date.now() + 3600e3).toISOString() });
  if (url.startsWith('https://sentinel2l2a01.blob.core.windows.net/')) {
    assert.ok(url.includes('sig=s2'), 'Sentinel-2-blob allekirjoitettu');
    return fileResponse(url.split('/').pop().split('?')[0], req);
  }
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
    const img = await (await GT.fromArrayBuffer((() => { const b = fs.readFileSync(path.join(FX, 'hls1.B04.tif')); return b.buffer.slice(b.byteOffset, b.byteOffset + b.length); })())).getImage();
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

  let s2;
  const VALID_0817 = 78; // 14 / 18 riviä usvan alapuolella
  await t('Sentinel-2 L2A: SCL-maski, 20 m → 10 m ja +1000 siirtymä', async () => {
    s2 = await H.fetchS2(field, '2026-07-01', '2026-08-31', { bufferM: 10 });
    assert.strictEqual(s2.searched, 3);
    assert.deepStrictEqual(s2.skipped, []);
    const by = Object.fromEntries(s2.obs.map((o) => [o.date, o]));
    assert.deepStrictEqual(Object.keys(by), ['2026-07-10', '2026-07-28', '2026-08-17']);
    assert.deepStrictEqual([by['2026-07-10'].src, by['2026-07-10'].value, by['2026-07-10'].valid], ['Sentinel-2', 0.8, 100]);
    assert.ok(by['2026-07-28'].valid < 50, 'pilvinen pohjoisosa hylätty: ' + by['2026-07-28'].valid);
    assert.strictEqual(by['2026-08-17'].value, 0.45, 'siirtymä vähennetty ennen NDVI:tä');
    assert.strictEqual(by['2026-08-17'].valid, VALID_0817, 'paljas maa (SCL 5) kelpaa, sininen kanava hylkää usvaisen pohjoisreunan');
    assert.strictEqual(by['2026-08-17'].changed, 100, 'muutos verrataan 10.7. kuvaan');
    assert.strictEqual(by['2026-07-28'].src, 'Sentinel-2');
  });

  await t('Sentinel-2: pilvimaski ensin – kokonaan pilvisestä kuvasta ei avata NIR-kaistaa', async () => {
    const seen = [], real = global.fetch;
    global.fetch = (url, req) => { seen.push(String(url)); return real(url, req); };
    S2_ITEMS.push(s2ItemFx('S2A_MSIL2A_20260820T095031_N0511_R079_T35VLL_20260820T120000', '2026-08-20', 's2d', '05.11'));
    try {
      const r = await H.fetchS2(field, '2026-07-01', '2026-08-31', { bufferM: 10 });
      const d = r.obs.find((o) => o.date === '2026-08-20');
      assert.deepStrictEqual([d.value, d.valid], [null, 0], 'pilvinen päivä näkyy pois jätettynä');
      assert.ok(seen.some((u) => u.includes('s2d.SCL.tif')), 'maski luettiin');
      assert.ok(!seen.some((u) => u.includes('s2d.B08.tif')), 'NIR-kaistaa ei avattu');
      assert.ok(seen.some((u) => u.includes('s2c.B08.tif')), 'selkeän kuvan NIR luettiin');
    } finally { S2_ITEMS.pop(); global.fetch = real; }
  });

  await t('Sentinel-2: SCL-luokat ja prosessointiversion siirtymä', () => {
    [4, 5].forEach((v) => assert.ok(H.sclValid(v)));
    [0, 1, 2, 3, 6, 7, 8, 9, 10, 11].forEach((v) => assert.ok(!H.sclValid(v), 'hylätään ' + v));
    assert.strictEqual(H.s2Offset({ properties: { 's2:processing_baseline': '05.11' } }), 1000);
    assert.strictEqual(H.s2Offset({ properties: { 's2:processing_baseline': '03.01' } }), 0);
    assert.strictEqual(H.s2Offset({ properties: { datetime: '2021-07-01T10:00:00Z' } }), 0);
  });

  await t('lähdevertailu: Sentinel-2 vs HLS samalle lohkolle', () => {
    const C = require('../core.js');
    const r = C.compareSources(hls.obs.concat(s2.obs), { measure: 'Luonnonhoitonurmi' });
    assert.deepStrictEqual(r.rows.map((x) => x.key), ['S2', 'HLS-S30', 'HLS']);
    const by = Object.fromEntries(r.rows.map((x) => [x.key, x]));
    assert.ok(by.S2.detected && by.HLS.detected);
    assert.strictEqual(by.S2.windowDays, 38);
    assert.strictEqual(by.HLS.windowDays, 26);
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

  await t('0 % kelvollisia: kuva palautetaan tyhjällä arvolla eikä katoa', () => {
    const fw = { mask: new Uint8Array([1, 1]), n: 2, w: 2, h: 1, origin: [0, 0], res: [10, -10], window: [0, 0, 2, 1], epsg: 32635 };
    const out = H.finalize([
      { date: '2026-07-01', src: 'HLS-S30', fam: 'HLS', id: 'pilvi', ndvi: new Float32Array([NaN, NaN]), fw, value: null, nValid: 0 },
      { date: '2026-07-05', src: 'HLS-S30', fam: 'HLS', id: 'a', ndvi: new Float32Array([0.8, 0.8]), fw, value: 0.8, nValid: 2 },
      { date: '2026-07-05', src: 'HLS-S30', fam: 'HLS', id: 'b', ndvi: new Float32Array([NaN, NaN]), fw, value: null, nValid: 0 }
    ], { ndviDrop: 0.12, minValid: 50 });
    assert.deepStrictEqual(out.map((o) => [o.date, o.id, o.value, o.valid]), [['2026-07-01', 'pilvi', null, 0], ['2026-07-05', 'a', 0.8, 100]]);
  });

  await t('Sentinel-1: tunnus, kuvausluettelo, radat ja Statistical API -vastauksen muunnos dB:ksi', async () => {
    H._clearCdse();
    const real = global.fetch, seen = [];
    const exp = Math.floor(Date.now() / 1000) + 600;
    const jwt = 'x.' + Buffer.from(JSON.stringify({ exp })).toString('base64url') + '.y';
    const stat = (mean, n, nd) => ({ stats: { min: 0, max: 1, mean, stDev: 0.01, sampleCount: n, noDataCount: nd } });
    const cat = (dt, st, rel) => ({ properties: Object.assign({ datetime: dt, 'sat:orbit_state': st, 'sar:instrument_mode': 'IW', 'sar:polarizations': ['VV', 'VH'] }, rel ? { 'sat:relative_orbit': rel } : {}) });
    global.fetch = async (url, req) => {
      seen.push({ url: String(url), req });
      if (/openid-connect\/token$/.test(url)) return json({ access_token: jwt, expires_in: 600 });
      if (/catalog/.test(url)) {
        const body = JSON.parse(req.body);
        if (body.next == null) return json({ features: [cat('2026-07-02T16:05:10Z', 'ascending'), cat('2026-07-05T04:40:00Z', 'descending', 160)], context: { next: 2 } });
        return json({ features: [cat('2026-07-08T16:05:14Z', 'ascending'), cat('2026-07-08T15:47:00Z', 'ascending'), cat('2026-07-09T15:47:20Z', 'ascending'),
          { properties: { datetime: '2026-07-09T10:00:00Z', 'sat:orbit_state': 'ascending', 'sar:instrument_mode': 'EW' } }], context: {} });
      }
      const body = JSON.parse(req.body), dir = body.input.data[0].dataFilter.orbitDirection;
      return json({ data: dir === 'ASCENDING' ? [
        { interval: { from: '2026-07-02T00:00:00Z', to: '2026-07-03T00:00:00Z' }, outputs: { s1: { bands: { B0: stat(0.1, 100, 0), B1: stat(0.02, 100, 0) } } } },
        { interval: { from: '2026-07-03T00:00:00Z', to: '2026-07-04T00:00:00Z' }, outputs: { s1: { bands: { B0: stat('NaN', 100, 100), B1: stat('NaN', 100, 100) } } } },
        { interval: { from: '2026-07-08T00:00:00Z', to: '2026-07-09T00:00:00Z' }, outputs: { s1: { bands: { B0: stat(0.1, 100, 0), B1: stat(0.02, 100, 0) } } } },
        { interval: { from: '2026-07-09T00:00:00Z', to: '2026-07-10T00:00:00Z' }, outputs: { s1: { bands: { B0: stat(0.1, 100, 70), B1: stat(0.02, 100, 70) } } } }
      ] : [
        { interval: { from: '2026-07-05T00:00:00Z', to: '2026-07-06T00:00:00Z' }, outputs: { s1: { bands: { B0: stat(0.05, 100, 2), B1: stat(0.01, 100, 2) } } } },
        { interval: { from: '2026-07-11T00:00:00Z', to: '2026-07-12T00:00:00Z' }, error: { type: 'EXECUTION_ERROR', message: 'ei dataa' } }
      ] });
    };
    const res = await H.fetchS1(field, '2026-07-01', '2026-07-31', { id: 'cid', secret: 's' }, {});
    assert.deepStrictEqual(seen.map((x) => x.url.replace(/^.*\//, '')), ['token', 'search', 'search', 'v1', 'v1'], 'token, kaksi luettelosivua, kaksi tilastokutsua');
    assert.match(seen[0].req.body, /grant_type=client_credentials&client_id=cid&client_secret=s/);
    assert.strictEqual(JSON.parse(seen[2].req.body).next, 2, 'sivutus');
    const st = JSON.parse(seen[3].req.body);
    assert.strictEqual(seen[3].url, H.ENDPOINTS.CDSE_STATS);
    assert.strictEqual(seen[3].req.headers.Authorization, 'Bearer ' + jwt);
    assert.strictEqual(st.input.data[0].type, 'sentinel-1-grd');
    assert.strictEqual(st.input.data[0].processing.backCoeff, 'GAMMA0_TERRAIN');
    assert.deepStrictEqual(st.aggregation.aggregationInterval, { of: 'P1D', lastIntervalBehavior: 'SHORTEN' });
    assert.deepStrictEqual(st.aggregation.timeRange, { from: '2026-07-01T00:00:00Z', to: '2026-08-01T00:00:00Z' }, 'viimeinen päivä mukana kokonaan');
    assert.match(st.input.bounds.properties.crs, /^http:\/\/www\.opengis\.net\/def\/crs\/EPSG\/0\/326\d\d$/);
    assert.ok(st.input.bounds.geometry.coordinates[0][0][0] > 1e5, 'geometria metreinä UTM:ssä');
    assert.deepStrictEqual(res.obs.map((o) => [o.date, o.value, o.valid, o.track]), [
      ['2026-07-02', -16.99, 100, 'ASC klo 16:05'],
      ['2026-07-05', -20, 98, 'DESC rata 160']
    ]);
    assert.strictEqual(res.obs[0].id, 'S1 GRD ASC klo 16:05 2026-07-02 VV -10.00 dB');
    assert.deepStrictEqual(res.skipped.map((x) => x.replace(/:.*/, '')), ['2026-07-08 ASC', '2026-07-09 ASC', '2026-07-11 DESC'], 'kaksi rataa samana päivänä, vähän pikseleitä, virhe');
    assert.match(res.skipped[0], /kaksi rataa samana päivänä/);
    assert.deepStrictEqual(res.tracks, [{ track: 'ASC klo 16:05', n: 1 }, { track: 'DESC rata 160', n: 1 }]);
    assert.ok(res.notes.some((x) => /alle 4 kuvausta/.test(x)));
    // toinen haku käyttää samaa tokenia
    await H.fetchS1(field, '2026-07-01', '2026-07-31', { id: 'cid', secret: 's' }, {});
    assert.strictEqual(seen.filter((x) => /token$/.test(x.url)).length, 1);
    global.fetch = real;
  });

  await t('Sentinel-1: radat kellonajasta, kun ratanumero puuttuu (± 3 min)', () => {
    const tr = H.s1Tracks([
      { date: '2026-07-02', min: 965.2, dir: 'ASCENDING', rel: null }, { date: '2026-07-08', min: 965.4, dir: 'ASCENDING', rel: null },
      { date: '2026-07-14', min: 967.0, dir: 'ASCENDING', rel: null }, { date: '2026-07-03', min: 947.5, dir: 'ASCENDING', rel: null },
      { date: '2026-07-04', min: 285, dir: 'DESCENDING', rel: 22 }]);
    assert.deepStrictEqual(tr, { '2026-07-03|ASCENDING': 'klo 15:48', '2026-07-02|ASCENDING': 'klo 16:06', '2026-07-08|ASCENDING': 'klo 16:06', '2026-07-14|ASCENDING': 'klo 16:06', '2026-07-04|DESCENDING': 'rata 22' });
  });

  await t('Sentinel-1: CORS-esteessä haku menee välityspalvelimen kautta; luettelon virhe ei kaada hakua', async () => {
    H._clearCdse();
    const real = global.fetch, seen = [];
    global.fetch = async (url) => {
      seen.push(String(url));
      if (!/workers\.dev/.test(url)) throw new TypeError('Failed to fetch');
      if (/\/cdse\/token$/.test(url)) return json({ access_token: 'a.b.c', expires_in: 600 });
      if (/\/cdse\/catalog$/.test(url)) return new Response('{"error":"x"}', { status: 500 });
      return json({ data: [] });
    };
    const res = await H.fetchS1(field, '2026-07-01', '2026-07-31', { id: 'cid', secret: 's' }, { proxy: 'https://x.workers.dev/' });
    assert.deepStrictEqual(res.obs, []);
    assert.deepStrictEqual(seen.filter((u) => /workers/.test(u)), ['https://x.workers.dev/cdse/token', 'https://x.workers.dev/cdse/catalog', 'https://x.workers.dev/cdse/statistics', 'https://x.workers.dev/cdse/statistics']);
    assert.match(res.notes[0], /Ratatietoa ei saatu.*ASC\/DESC/);
    await assert.rejects(() => H.fetchS1(field, '2026-07-01', '2026-07-31', { id: '', secret: '' }, {}), /client id ja client secret/);
    global.fetch = real;
  });

  console.log(n + ' testiä läpi');
})().catch((e) => { console.error(e); process.exit(1); });
