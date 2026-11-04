// Lohkon valinnan testit: osoitteet, vastausten tulkinta ja haku peruslohkotunnuksella mockatulla WFS:llä.
// Aja: node test/kartta.test.js
const assert = require('assert');
const K = require('../kartta.js');

let n = 0;
async function t(name, f) { await f(); n++; console.log('ok', name); }

const sq = (x0, y0, x1, y1) => [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]];
const fc = (feats) => ({ type: 'FeatureCollection', features: feats });
const feat = (props, coords) => ({ type: 'Feature', id: 'x.' + props.LOHKONUMERO, properties: props, geometry: { type: 'Polygon', coordinates: coords } });
const A = feat({ PERUSLOHKOTUNNUS: 1641431471, LOHKONUMERO: 1, KASVIKOODI_SELITE_FI: 'Säilörehunurmi' }, sq(22.840, 62.790, 22.843, 62.792));
const B = feat({ PERUSLOHKOTUNNUS: 1641431471, LOHKONUMERO: 2, KASVIKOODI_SELITE_FI: 'Luonnonhoitonurmi' }, sq(22.843, 62.790, 22.846, 62.792));

(async () => {
  await t('MML-osoite: taso, Pseudo-Mercator, tiedostomuoto ja avain', () => {
    assert.strictEqual(K.mmlUrl('taustakartta', 'a b'), 'https://avoin-karttakuva.maanmittauslaitos.fi/avoin/wmts/1.0.0/taustakartta/default/WGS84_Pseudo-Mercator/{z}/{y}/{x}.png?api-key=a%20b');
    assert.ok(K.mmlUrl('ortokuva', 'k').includes('/ortokuva/default/WGS84_Pseudo-Mercator/{z}/{y}/{x}.jpg'));
    assert.ok(K.mmlUrl('tuntematon', 'k').includes('/taustakartta/'));
  });

  await t('GetFeatureInfo-osoite: taso, piste keskellä, JSON', () => {
    const u = new URL(K.gfiUrl(22.8445, 62.791, 2023));
    const q = Object.fromEntries(u.searchParams);
    assert.strictEqual(q.query_layers, 'inspire:LandUse.ExistingLandUse.GSAAAgriculturalParcel.2023');
    assert.strictEqual(q.info_format, 'application/json');
    assert.strictEqual(q.srs, 'EPSG:4326');
    const b = q.bbox.split(',').map(Number);
    assert.ok(Math.abs((b[0] + b[2]) / 2 - 22.8445) < 1e-6 && Math.abs((b[1] + b[3]) / 2 - 62.791) < 1e-6);
  });

  await t('klikkaus: valitaan pisteen sisältävä lohko ja päätellään toimenpide', () => {
    const p = K.pickParcel(JSON.parse(JSON.stringify(fc([A, B]))), 22.8445, 62.791, 2023);
    assert.strictEqual(p.tunnus, '1641431471-2');
    assert.strictEqual(p.kasvi, 'Luonnonhoitonurmi');
    assert.strictEqual(p.measure, 'Luonnonhoitonurmi');
    assert.strictEqual(p.feature.properties.vuosi, 2023);
    assert.strictEqual(K.pickParcel(fc([]), 0, 0, 2023), null);
  });

  await t('lat/lon-järjestyksessä tullut geometria käännetään', () => {
    const swapped = JSON.parse(JSON.stringify(B));
    swapped.geometry.coordinates[0] = swapped.geometry.coordinates[0].map(([x, y]) => [y, x]);
    const p = K.pickParcel(fc([swapped]), 22.8445, 62.791, 2023);
    assert.deepStrictEqual(p.feature.geometry.coordinates[0][0], [22.843, 62.79]);
  });

  await t('toimenpide kasvin nimestä', () => {
    assert.strictEqual(K.measureFor('Viherlannoitusnurmi'), 'Viherlannoitusnurmi (ekojärjestelmätuki)');
    assert.strictEqual(K.measureFor('Monimuotoisuuspelto, niittykasvit'), 'Monimuotoisuuskasvi');
    assert.strictEqual(K.measureFor('Kesanto'), 'Nurmi tai kesanto (niittovaatimus)');
    assert.strictEqual(K.measureFor('Kevätvehnä'), null);
  });

  await t('peruslohkotunnus: muodot ja virheet', () => {
    assert.deepStrictEqual(K.parseTunnus('1641431471'), { peruslohko: '1641431471', lohko: null });
    assert.deepStrictEqual(K.parseTunnus(' 1641431471-2 '), { peruslohko: '1641431471', lohko: '2' });
    assert.deepStrictEqual(K.parseTunnus('1641431471 / A'), { peruslohko: '1641431471', lohko: 'A' });
    assert.strictEqual(K.parseTunnus('164143'), null);
  });

  await t('pinta-ala-arvio WGS84-geometriasta', () => {
    const ha = K.areaHa(B.geometry); // 0,003° × 0,002° 62,79°N ≈ 153 m × 222 m
    assert.ok(Math.abs(ha - 3.40) < 0.1, 'ha ' + ha);
  });

  // Mock-WFS: kasvulohkotasoa 2026 ei ole, 2025:ssä on; sarakenimi selviää DescribeFeatureTypesta.
  function mockFetch(log, opts = {}) {
    return async (url) => {
      const u = new URL(url); const q = Object.fromEntries(u.searchParams); log.push(q.request + ' ' + (q.typeNames || ''));
      const exc = () => ({ text: async () => '<?xml version="1.0"?><ows:ExceptionReport/>' });
      const ok = (o) => ({ text: async () => JSON.stringify(o) });
      if (opts.cors) throw new TypeError('Failed to fetch');
      const year = +q.typeNames.split('.').pop();
      const kasvu = q.typeNames.includes('GSAAAgriculturalParcel');
      if (kasvu && year > (opts.maxYear || 2025)) return exc();
      if (!kasvu && year > 2025) return exc();
      if (q.request === 'DescribeFeatureType') return ok({ featureTypes: [{ properties: [{ name: 'geom' }, { name: 'PERUSLOHKOTUNNUS' }, { name: 'LOHKONUMERO' }] }] });
      assert.strictEqual(q.outputFormat, 'application/json');
      if (q.CQL_FILTER === 'INCLUDE') return ok(fc([JSON.parse(JSON.stringify(A))]));
      assert.match(q.CQL_FILTER, /^PERUSLOHKOTUNNUS='\d{10}'$/);
      const id = q.CQL_FILTER.match(/'(\d+)'/)[1];
      if (opts.noKasvu && kasvu) return ok(fc([]));
      if (id !== '1641431471') return ok(fc([]));
      return ok(fc(kasvu ? [A, B].map((x) => JSON.parse(JSON.stringify(x))) : [feat({ PERUSLOHKOTUNNUS: 1641431471 }, sq(22.840, 62.790, 22.846, 62.792))]));
    };
  }

  await t('haku tunnuksella: uusin vuosi, kaikki kasvulohkot', async () => {
    const log = [];
    const r = await K.findByTunnus('1641431471', { year: 2026, fetch: mockFetch(log) });
    assert.strictEqual(r.year, 2025);
    assert.strictEqual(r.kind, 'kasvulohko');
    assert.deepStrictEqual(r.parcels.map((p) => p.tunnus), ['1641431471-1', '1641431471-2']);
    assert.strictEqual(r.parcels[1].measure, 'Luonnonhoitonurmi');
  });

  await t('haku tunnuksella ja lohkonumerolla: yksi kasvulohko', async () => {
    const r = await K.findByTunnus('1641431471-2', { year: 2025, fetch: mockFetch([]) });
    assert.strictEqual(r.parcels.length, 1);
    assert.strictEqual(r.parcels[0].tunnus, '1641431471-2');
  });

  await t('ei kasvulohkoja → peruslohkon rajaus', async () => {
    const r = await K.findByTunnus('1641431471', { year: 2025, fetch: mockFetch([], { noKasvu: true }) });
    assert.strictEqual(r.kind, 'peruslohko');
    assert.strictEqual(r.parcels.length, 1);
    assert.strictEqual(r.parcels[0].tunnus, '1641431471');
  });

  await t('tuntematon tunnus, väärä muoto ja CORS antavat selkeän virheen', async () => {
    await assert.rejects(() => K.findByTunnus('1640000000', { year: 2025, fetch: mockFetch([]) }), /ei löytynyt Ruokaviraston aineistosta/);
    await assert.rejects(() => K.findByTunnus('abc', { fetch: mockFetch([]) }), /kymmenellä numerolla/);
    await assert.rejects(() => K.findByTunnus('1641431471', { year: 2025, fetch: mockFetch([], { cors: true }) }), /hae_kasvulohkot\.py --peruslohko 1641431471/);
  });

  await t('JSONP-varareitti: CORS estää fetchin, JSONP-koekutsu onnistuu', async () => {
    const calls = [];
    const corsFetch = async () => { throw new TypeError('Failed to fetch'); };
    const inner = mockFetch([]);
    // mockFetch odottaa application/json -muotoa; muunnetaan kutsu takaisin ennen sitä
    const r = await K.findByTunnus('1641431471-2', { year: 2025, fetch: corsFetch, jsonp: async (u) => {
      const back = u.replace('outputFormat=text%2Fjavascript', 'outputFormat=application%2Fjson').replace(/&format_options=[^&]*/, '');
      calls.push(u);
      let txt; try { txt = await (await inner(back)).text(); } catch (e) { throw new Error('x'); }
      try { return JSON.parse(txt); } catch (e) { throw new Error('poikkeus'); }
    } });
    assert.strictEqual(r.via, 'jsonp');
    assert.strictEqual(r.parcels[0].tunnus, '1641431471-2');
    assert.ok(calls[0].includes('GSAAAgriculturalParcel.2023') && calls[0].includes('count=1'), 'koekutsu tunnetulle tasolle');
  });

  await t('JSONP-varareitti: koekutsu epäonnistuu → selkeä CORS-viesti', async () => {
    await assert.rejects(() => K.findByTunnus('1641431471', { year: 2025, fetch: async () => { throw new TypeError('x'); }, jsonp: async () => { throw new Error('ei'); } }),
      /CORS on estetty eikä JSONP ole käytössä.*--peruslohko 1641431471/);
  });

  await t('JSONP-osoite: muoto ja callback', () => {
    const u = K.toJsonp(K.wfsUrl('inspire:x', "A='1'"), 'cb1');
    assert.ok(u.includes('outputFormat=text%2Fjavascript') && u.endsWith('&format_options=callback%3Acb1'));
    const g = K.toJsonp(K.gfiUrl(22.8, 62.8, 2023), 'cb2');
    assert.ok(g.includes('info_format=text%2Fjavascript'));
  });

  await t('välityspalvelin: suora kutsu estyy → haku kulkee Workerin kautta', async () => {
    const seen = [];
    const inner = mockFetch([]);
    const PX = 'https://rv.example.workers.dev';
    const f = async (url) => {
      seen.push(url);
      if (url.startsWith('https://inspire.ruokavirasto-awsa.com/')) throw new TypeError('Failed to fetch');
      assert.ok(url.startsWith(PX + '/wfs?'), 'osoite käännetty: ' + url);
      const r = await inner(url.replace(PX + '/', 'https://inspire.ruokavirasto-awsa.com/geoserver/'));
      return { status: 200, text: r.text };
    };
    const r = await K.findByTunnus('1641431471-2', { year: 2025, fetch: f, proxy: PX, jsonp: async () => { throw new Error('ei kuulu käyttää'); } });
    assert.strictEqual(r.via, 'proxy');
    assert.strictEqual(r.parcels[0].tunnus, '1641431471-2');
    assert.strictEqual(seen.filter((u) => u.startsWith('https://inspire')).length, 1, 'suoraa kutsua kokeillaan vain kerran');
  });

  await t('välityspalvelin hylkää originin → ohje ALLOWED_ORIGINS-muuttujasta', async () => {
    const f = async (url) => { if (url.startsWith('https://inspire')) throw new TypeError('x'); return { status: 403, text: async () => '{"error":"Origin ei ole sallittu."}' }; };
    await assert.rejects(() => K.findByTunnus('1641431471', { year: 2025, fetch: f, proxy: 'https://rv.example.workers.dev' }), /ALLOWED_ORIGINS/);
  });

  await t('välityspalvelin ei vastaa → ohje tarkistaa osoite', async () => {
    const f = async () => { throw new TypeError('x'); };
    await assert.rejects(() => K.findByTunnus('1641431471', { year: 2025, fetch: f, proxy: 'https://rv.example.workers.dev', jsonp: async () => { throw new Error('ei'); } }), /Välityspalvelin ei vastannut/);
  });

  await t('osoitteen kääntö välityspalvelimelle', () => {
    assert.strictEqual(K.viaProxy('https://inspire.ruokavirasto-awsa.com/geoserver/wms?a=1', 'https://p.dev'), 'https://p.dev/wms?a=1');
    assert.strictEqual(K.viaProxy('https://muu.fi/x', 'https://p.dev'), 'https://muu.fi/x');
    assert.strictEqual(K.viaProxy('https://inspire.ruokavirasto-awsa.com/geoserver/wfs?b', null), 'https://inspire.ruokavirasto-awsa.com/geoserver/wfs?b');
  });

  await t('korostustyyli: neljä luokkaa, nurmi ei kata luonnonhoito- eikä viherlannoitusnurmea, pituus kohtuullinen', () => {
    const x = K.niittoSld(2025);
    assert.strictEqual((x.match(/<Rule>/g) || []).length, 4);
    assert.ok(x.includes('inspire:LandUse.ExistingLandUse.GSAAAgriculturalParcel.2025'));
    const nk = x.slice(x.indexOf('<Name>nk</Name>'));
    assert.ok(/<ogc:Not>.*\*luonnonhoito\*.*\*viherlannoitus\*.*<\/ogc:Not>/.test(nk));
    assert.ok(encodeURIComponent(x).length < 6000, 'tiiliosoite pysyy palvelimen rajan alla');
    assert.ok(K.niittoSld(2025, 'KASVI').includes('<ogc:PropertyName>KASVI</ogc:PropertyName>'));
    assert.strictEqual(K.cropField({ featureTypes: [{ properties: [{ name: 'KASVIKOODI' }, { name: 'KASVIKOODI_SELITE_FI' }] }] }), 'KASVIKOODI_SELITE_FI');
  });

  await t('paikkahaku: OSM- ja MML-vastaukset sekä koordinaatit', async () => {
    assert.deepStrictEqual(K.parseGeocode([{ display_name: 'Seinäjoki', lat: '62.79', lon: '22.84' }]), [{ label: 'Seinäjoki', lat: 62.79, lon: 22.84 }]);
    assert.deepStrictEqual(K.parseGeocode({ features: [{ geometry: { coordinates: [22.84, 62.79] }, properties: { label: 'Seinäjoki, Seinäjoki' } }] }), [{ label: 'Seinäjoki, Seinäjoki', lat: 62.79, lon: 22.84 }]);
    assert.ok(K.geocodeUrl('Ylistaro', 'abc').startsWith('https://avoin-paikkatieto.maanmittauslaitos.fi/geocoding/v2/pelias/search?text=Ylistaro'));
    assert.ok(K.geocodeUrl('Ylistaro', null).includes('nominatim.openstreetmap.org'));
    const r = await K.geocode('62,79; 22,84', null, { fetch: async () => { throw new Error('ei kutsuta'); } });
    assert.strictEqual(r[0].lat, 62.79);
    // MML ei vastaa → OpenStreetMap
    const urls = [];
    const r2 = await K.geocode('Ylistaro', 'avain', { fetch: async (u) => { urls.push(u); if (u.includes('maanmittauslaitos')) throw new TypeError('x'); return { ok: true, json: async () => [{ display_name: 'Ylistaro', lat: '62.94', lon: '22.51' }] }; } });
    assert.strictEqual(r2[0].label, 'Ylistaro'); assert.strictEqual(urls.length, 2);
  });

  console.log(n + ' testiä läpi');
})().catch((e) => { console.error(e); process.exit(1); });
