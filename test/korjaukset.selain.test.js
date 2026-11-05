// Selaintesti käytettävyysarvion (4.11.2026) löydöksille. Rajapinnat korvataan testidatalla.
// Aja: node test/korjaukset.selain.test.js (vaatii Playwrightin)
const fs = require('fs');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const assert = require('assert');
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { console.log('ohitetaan: Playwright puuttuu'); process.exit(0); }

const ROOT = path.join(__dirname, '..');
const server = http.createServer((req, res) => {
  const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/^\/$/, '/index.html'));
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  const type = f.endsWith('.html') ? 'text/html' : f.endsWith('.js') ? 'text/javascript' : f.endsWith('.css') ? 'text/css' : f.endsWith('.png') ? 'image/png' : 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type }); fs.createReadStream(f).pipe(res);
});
function png(r, g, b, a) {
  const crc = (buf) => { let c, k, v = 0xffffffff; for (let n = 0; n < buf.length; n++) { c = (v ^ buf[n]) & 0xff; for (k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; v = (v >>> 8) ^ c; } return (v ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const h = Buffer.alloc(13); h.writeUInt32BE(1, 0); h.writeUInt32BE(1, 4); h[8] = 8; h[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', h), chunk('IDAT', zlib.deflateSync(Buffer.from([0, r, g, b, a]))), chunk('IEND', Buffer.alloc(0))]);
}
const sq = (x0, y0, x1, y1) => [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]];
const REHU = { type: 'Feature', properties: { PERUSLOHKOTUNNUS: 9750548215, LOHKONUMERO: 1, KASVIKOODI_SELITE_FI: 'Rehuohra' }, geometry: { type: 'Polygon', coordinates: sq(25.70, 62.40, 25.71, 62.405) } };
const LHN = { type: 'Feature', properties: { PERUSLOHKOTUNNUS: 1641431471, LOHKONUMERO: 2, KASVIKOODI_SELITE_FI: 'Luonnonhoitonurmi' }, geometry: { type: 'Polygon', coordinates: sq(22.843, 62.790, 22.846, 62.792) } };
const cors = { 'Access-Control-Allow-Origin': '*' };

(async () => {
  await new Promise((r) => server.listen(0, r));
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  const sld = [];
  await page.route('https://tile.openstreetmap.org/**', (r) => r.fulfill({ status: 200, contentType: 'image/png', body: png(240, 240, 240, 255) }));
  await page.route('https://nominatim.openstreetmap.org/**', (r) => r.fulfill({ status: 200, contentType: 'application/json', headers: cors,
    body: JSON.stringify([{ display_name: 'Seinäjoki, Etelä-Pohjanmaa', lat: '62.7903', lon: '22.8403' }, { display_name: 'Seinäjoen asema', lat: '62.7860', lon: '22.8330' }]) }));
  await page.route('https://inspire.ruokavirasto-awsa.com/**', (r) => {
    const u = new URL(r.request().url()); const q = Object.fromEntries([...u.searchParams].map(([k, v]) => [k.toLowerCase(), v]));
    const year = +((q.layers || q.typenames || '').split('.').pop());
    if (year > 2025) return r.fulfill({ status: 200, contentType: 'application/xml', body: '<ServiceExceptionReport/>', headers: cors });
    if (q.request === 'GetMap') { if (q.sld_body) sld.push(q.sld_body); return r.fulfill({ status: 200, contentType: 'image/png', body: png(194, 65, 12, 90), headers: cors }); }
    if (q.request === 'GetFeatureInfo') return r.fulfill({ status: 200, contentType: 'application/json', body: '{"type":"FeatureCollection","features":[]}', headers: cors });
    if (q.request === 'DescribeFeatureType') return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ featureTypes: [{ properties: [{ name: 'PERUSLOHKOTUNNUS' }, { name: 'LOHKONUMERO' }, { name: 'KASVIKOODI_SELITE_FI' }] }] }), headers: cors });
    if (q.request === 'GetFeature') {
      const id = (q.cql_filter || '').match(/'(\d+)'/); const kasvu = (q.typenames || '').includes('GSAA');
      const feats = !kasvu || !id ? [] : id[1] === '9750548215' ? [REHU] : id[1] === '1641431471' ? [LHN] : [];
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ type: 'FeatureCollection', features: feats }), headers: cors });
    }
    return r.fulfill({ status: 404 });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html?rvproxy=off#tyokalu`);
  await page.evaluate(() => { document.getElementById('dStart').value = '2026-05-01'; document.getElementById('dEnd').value = '2026-09-30'; });
  const measure = () => page.evaluate(() => (document.querySelector('input[name="measureR"]:checked') || {}).value || '');
  const step = (n) => page.click(`#stepNav button[data-step="${n}"]`);

  // 1) Kolmivaiheinen polku: aluksi näkyy vain lohkon valinta; raja-arvot ja PlanetScope lisäasetuksissa
  assert.ok(await page.isVisible('#pltIn'), 'lohkohaku ensimmäisenä');
  assert.ok(await page.isVisible('#map'), 'kartta näkyy heti');
  assert.ok(!(await page.isVisible('#step2')) && !(await page.isVisible('#step3')), 'muut vaiheet piilossa');
  assert.ok(await page.isDisabled('#toStep2'), 'jatko vasta lohkon valinnan jälkeen');
  assert.ok(await page.isDisabled('#stepNav button[data-step="2"]'));
  console.log('ok vaiheet: lohko ensin, jatko vasta valinnan jälkeen');

  // 2) Rehuohra: toimenpide ei saa jäädä oletukseksi; vuosivaroitus
  await page.fill('#pltIn', '9750548215'); await page.click('#pltGo');
  await page.waitForFunction(() => /Valittu/.test(document.getElementById('pickMsg').textContent));
  assert.ok(await page.isVisible('#parcelCard'), 'valittu lohko näkyy kortissa');
  assert.match(await page.textContent('#parcelCard'), /Rehuohra.*vuoden 2025 aineistosta/);
  await page.click('#toStep2');
  assert.ok(await page.isVisible('#step2') && !(await page.isVisible('#step1')));
  assert.ok(!(await page.isVisible('#p_ndviDrop')), 'raja-arvot piilossa lisäasetuksissa');
  assert.ok(!(await page.isVisible('#plKey')), 'PlanetScope suljettuna');
  assert.strictEqual(await measure(), '', 'toimenpide tyhjä, koska kasvi ei ole niittovelvoitteinen');
  assert.ok(await page.isVisible('#cropWarn'));
  assert.match(await page.textContent('#cropWarnText'), /Rehuohra.*sadonkorjuuta, puintia tai tuleentumista/);
  const pm = await page.textContent('#pickMsg');
  assert.match(pm, /vuoden 2025 aineistosta, arvioitava kausi on 2026/);
  assert.match(pm, /vain yksi kasvulohko/);
  // muu kasvi: raportti ei sovellu, hakua ei voi käynnistää
  await page.check('input[name="measureR"][value="muu"]');
  assert.ok(await page.isVisible('#notSuited'));
  assert.ok(await page.isDisabled('#runGo'));
  await page.click('#manualGo');
  await page.click('#example');
  assert.strictEqual(await page.inputValue('#out'), '', 'Vipu-tekstiä ei muodosteta ristiriidassa');
  assert.match(await page.textContent('#bigwarns'), /Tarkista toimenpide/);
  assert.match(await page.textContent('#bigwarns'), /vuoden 2025 aineistosta/);
  assert.match(await page.textContent('#outEmpty'), /Vahvista toimenpide vaiheessa 2/);
  // käyttäjä vahvistaa toimenpiteen
  await step(2);
  await page.check('input[name="measureR"][value="Luonnonhoitonurmi"]');
  assert.ok(!(await page.isDisabled('#runGo')));
  assert.strictEqual(await page.inputValue('#out'), '', 'pelkkä valinta ei riitä');
  await page.check('#cropOk');
  const vipu = await page.inputValue('#out');
  assert.match(vipu, /Rajaus: Ruokaviraston kasvulohkoaineisto 2025 \(kasvi Rehuohra\)\. Toimenpide Luonnonhoitonurmi viljelijän ilmoituksen mukaan\./);
  console.log('ok kasvin ja toimenpiteen ristiriita: varoitus, Vipu-teksti vasta vahvistuksella, lähde ja vuosi tekstissä');

  // 3) Huomautukset: pois jätetyt yhdellä rivillä, otsikon määrä täsmää
  const ck = await page.$$eval('#checks > li', (ls) => ls.map((l) => ({ c: l.className, t: l.textContent })));
  const excl = ck.filter((c) => /jätettiin pois/.test(c.t));
  assert.strictEqual(excl.length, 1, 'pois jätetyt yhdellä rivillä');
  assert.match(excl[0].t, /^1 havainto jätettiin pois/);
  const head = ck[0].t.match(/(\d+) huomautus/);
  const nWarn = ck.filter((c) => c.c === 'warn').length;
  assert.ok(head ? +head[1] === nWarn : nWarn === 0, 'otsikon huomautusmäärä täsmää listaan');
  console.log('ok huomautukset: määrä ja taivutus täsmäävät, poistot yhdellä rivillä');

  // 4) Lohkon vaihto tyhjentää havainnot ja tuloksen
  await step(1);
  await page.fill('#pltIn', '1641431471-2'); await page.click('#pltGo');
  await page.waitForFunction(() => /1641431471-2/.test(document.getElementById('pickMsg').textContent));
  const rows = await page.$$eval('#obsTable tbody tr', (trs) => trs.filter((tr) => tr.querySelector('.d').value).length);
  assert.strictEqual(rows, 0, 'edellisen lohkon havainnot poistettu');
  assert.match(await page.textContent('#fetchLog'), /Lohko vaihtui: edellisen lohkon havainnot ja tulos poistettiin/);
  assert.match(await page.textContent('#verdict'), /Lisää vähintään kaksi/);
  assert.strictEqual(await measure(), 'Luonnonhoitonurmi');
  assert.match(await page.evaluate(() => getComputedStyle(document.getElementById('cropWarn')).display), /none/);
  console.log('ok lohkon vaihto tyhjentää havainnot ja tuloksen');

  // 5) Tuleentumisvaroitus omana laatikkonaan
  await step(2); await page.click('#manualGo');
  await page.click('#csvBox > summary');
  await page.fill('#csv', '2026-07-01;HLS-S30;a;0.80;100;\n2026-07-20;HLS-S30;b;0.45;100;95\n2026-07-25;HLS-S30;c;0.47;100;');
  await page.click('#importCsv');
  assert.match(await page.textContent('#bigwarns'), /Hidas muutos: tarkista, että kyse on niitosta/);
  assert.ok(!(await page.$$eval('#checks > li', (ls) => ls.some((l) => /tuleentum/.test(l.textContent)))), 'ei toistu listassa');
  console.log('ok tuleentumisvaroitus erottuu');

  // 6) Kartta: alustus piilosta, valittu lohko näkyy, rullazoomi vasta klikkauksen jälkeen, korostus, paikkahaku
  await step(1);
  await page.waitForTimeout(400);
  const st = await page.evaluate(() => { const el = document.getElementById('map'), m = el._niittoMap, s = m.getSize(); return { w: s.x, h: s.y, cw: el.clientWidth, ch: el.clientHeight, z: m.getZoom(), c: m.getCenter() }; });
  assert.strictEqual(st.w, st.cw); assert.strictEqual(st.h, st.ch);
  assert.ok(st.z >= 14 && Math.abs(st.c.lat - 62.791) < 0.01, 'kartta kohdistettu valittuun lohkoon: ' + JSON.stringify(st));
  await page.waitForFunction(() => document.querySelectorAll('#map img.leaflet-tile-loaded').length >= 6, null, { timeout: 10000 });
  await page.waitForTimeout(300);
  assert.ok(sld.length > 0, 'korostustaso pyydetty');
  assert.ok(/luonnonhoito/.test(sld[0]) && /KASVIKOODI_SELITE_FI/.test(sld[0]) && /GSAAAgriculturalParcel\.2025/.test(sld[0]));
  assert.match(await page.textContent('#niittoLegend'), /Luonnonhoitonurmi.*Viherlannoitusnurmi.*Monimuotoisuuskasvi.*Nurmi tai kesanto/);
  const niittoTiles = () => page.$$eval('#map img', (is) => is.filter((i) => /sld_body/i.test(i.src)).length);
  assert.ok(await niittoTiles() > 0, 'korostustason tiilet kartalla');
  await page.uncheck('#niittoOn'); await page.waitForTimeout(200);
  assert.strictEqual(await niittoTiles(), 0, 'kytkin poistaa korostuksen');
  await page.check('#niittoOn'); await page.waitForTimeout(400);
  assert.ok(await niittoTiles() > 0, 'kytkin palauttaa korostuksen');
  await page.$eval('#map', (e) => e.scrollIntoView({ block: 'center' }));
  const bb = await (await page.$('#map')).boundingBox();
  await page.mouse.move(bb.x + bb.width / 2, bb.y + bb.height / 2);
  const z0 = await page.evaluate(() => document.getElementById('map')._niittoMap.getZoom());
  await page.mouse.wheel(0, 400); await page.waitForTimeout(400);
  assert.strictEqual(await page.evaluate(() => document.getElementById('map')._niittoMap.getZoom()), z0, 'rulla ei zoomaa ennen klikkausta');
  // rullaus vieritti sivua (oikein), joten kartan paikka lasketaan uudelleen
  await page.$eval('#map', (e) => e.scrollIntoView({ block: 'center' }));
  const bb3 = await (await page.$('#map')).boundingBox();
  await page.mouse.click(bb3.x + bb3.width / 2, bb3.y + bb3.height / 2);
  await page.mouse.move(bb3.x + bb3.width / 2, bb3.y + bb3.height / 2);
  await page.mouse.wheel(0, 400); await page.waitForTimeout(600);
  assert.ok(await page.evaluate(() => document.getElementById('map')._niittoMap.getZoom()) < z0, 'klikkauksen jälkeen rulla zoomaa');
  await page.fill('#pltIn', 'Seinäjoki'); await page.click('#pltGo');
  await page.waitForSelector('#placeList:not([hidden]) button');
  await page.click('#placeList button:nth-child(1)');
  const c2 = await page.evaluate(() => document.getElementById('map')._niittoMap.getCenter());
  assert.ok(Math.abs(c2.lat - 62.7903) < 0.001 && Math.abs(c2.lng - 22.8403) < 0.001);
  await page.fill('#pltIn', '6965000 290000'); await page.click('#pltGo'); await page.waitForTimeout(200);
  const c3 = await page.evaluate(() => document.getElementById('map')._niittoMap.getCenter());
  assert.ok(Math.abs(c3.lat - 62.79) < 0.05, 'ETRS-TM35FIN-koordinaatit: ' + JSON.stringify(c3));
  console.log('ok kartta: koko ja kohdistus, korostus, rullazoomi, paikkahaku nimellä ja koordinaateilla');
  await page.screenshot({ path: path.join(process.env.SHOT_DIR || require('os').tmpdir(), 'korjaukset_kartta.png') });

  // 7) Mobiili 390 px
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.waitForTimeout(300);
  assert.ok(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)), 'ei vaakavieritystä');
  const mw = await page.evaluate(() => { const m = document.getElementById('map')._niittoMap; return m.getSize().x === document.getElementById('map').clientWidth; });
  assert.ok(mw, 'kartta päivittää kokonsa kapealle näytölle');
  await page.$eval('#pltIn', (e) => e.scrollIntoView({ block: 'start' }));
  await page.screenshot({ path: path.join(process.env.SHOT_DIR || require('os').tmpdir(), 'korjaukset_mobiili.png') });
  console.log('ok mobiili 390 px');

  assert.deepStrictEqual(errors, []);
  await browser.close(); server.close();
  console.log('korjausten selaintesti läpi');
})().catch((e) => { console.error(e); process.exit(1); });
