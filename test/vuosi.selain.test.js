// Selaintesti tarkasteluvuoden valinnalle. Rajapinnat korvataan testidatalla.
// Aja: node test/vuosi.selain.test.js (vaatii Playwrightin)
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
  const wfsYears = [];
  await page.route('https://inspire.ruokavirasto-awsa.com/**', (r) => {
    const u = new URL(r.request().url()); const q = Object.fromEntries([...u.searchParams].map(([k, v]) => [k.toLowerCase(), v]));
    const year = +((q.layers || q.typenames || '').split('.').pop());
    if (year > 2025) return r.fulfill({ status: 200, contentType: 'application/xml', body: '<ServiceExceptionReport/>', headers: cors });
    if (q.request === 'GetMap') { if (q.sld_body) sld.push(q.sld_body); return r.fulfill({ status: 200, contentType: 'image/png', body: png(194, 65, 12, 90), headers: cors }); }
    if (q.request === 'GetFeatureInfo') return r.fulfill({ status: 200, contentType: 'application/json', body: '{"type":"FeatureCollection","features":[]}', headers: cors });
    if (q.request === 'DescribeFeatureType') return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ featureTypes: [{ properties: [{ name: 'PERUSLOHKOTUNNUS' }, { name: 'LOHKONUMERO' }, { name: 'KASVIKOODI_SELITE_FI' }] }] }), headers: cors });
    if (q.request === 'GetFeature') {
      wfsYears.push(year);
      const id = (q.cql_filter || '').match(/'(\d+)'/); const kasvu = (q.typenames || '').includes('GSAA');
      const feats = !kasvu || !id ? [] : id[1] === '9750548215' ? [REHU] : id[1] === '1641431471' ? [LHN] : [];
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ type: 'FeatureCollection', features: feats }), headers: cors });
    }
    return r.fulfill({ status: 404 });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/index.html?rvproxy=off#tyokalu`);
  const val = (id) => page.evaluate((i) => document.getElementById(i).value, id);
  const defY = await val('yearSel');
  const opts = await page.$$eval('#yearSel option', (o) => o.map((x) => +x.value));
  assert.strictEqual(opts[opts.length - 1], 2016, 'vuodet 2016 alkaen');
  assert.ok(opts[0] >= +defY);
  assert.strictEqual((await val('dStart')).slice(0, 4), defY, 'hakujakso oletusvuodelta');

  // Valitaan 2024 → hakujakso 1.5.–15.10.2024, Ruokaviraston aineisto 2024
  await page.selectOption('#yearSel', '2024');
  assert.strictEqual(await val('dStart'), '2024-05-01');
  assert.strictEqual(await val('dEnd'), '2024-10-15');
  await page.fill('#pltIn', '1641431471-2'); await page.click('#pltGo');
  await page.waitForFunction(() => /Valittu/.test(document.getElementById('pickMsg').textContent));
  assert.match(await page.textContent('#pickMsg'), /Ruokavirasto 2024/);
  assert.ok(!/Huom: rajaus/.test(await page.textContent('#pickMsg')), 'ei vuosivaroitusta, kun vuodet täsmäävät');
  assert.strictEqual(wfsYears[wfsYears.length - 1], 2024);
  console.log('ok vuosi 2024: hakujakso ja kasvulohkoaineisto');

  // Lisätään havainto vuodelta 2024 ja vaihdetaan vuodeksi 2023 → havainnot poistuvat, lohko haetaan uudelleen
  await page.evaluate(() => { document.getElementById('csv').value = '2024-07-01;Sentinel-2;a;0,8;100;\n2024-07-10;Sentinel-2;b;0,5;100;'; document.getElementById('importCsv').click(); });
  assert.strictEqual(await page.evaluate(() => document.querySelectorAll('#obsTable tbody tr .d').length && [...document.querySelectorAll('#obsTable tbody tr .d')].filter((d) => d.value).length), 2);
  const before = wfsYears.length;
  await page.selectOption('#yearSel', '2023');
  await page.waitForFunction(() => /Ruokavirasto 2023/.test(document.getElementById('pickMsg').textContent));
  assert.ok(wfsYears.slice(before).includes(2023), 'lohko haettiin vuoden 2023 aineistosta');
  assert.strictEqual(await page.evaluate(() => [...document.querySelectorAll('#obsTable tbody tr .d')].filter((d) => d.value).length), 0, 'toisen vuoden havainnot poistettiin');
  assert.strictEqual(await val('dStart'), '2023-05-01');
  console.log('ok vuoden vaihto: havainnot pois, rajaus uudelleen');

  // Alkupäivän muutos toiselle vuodelle päivittää vuosivalinnan
  await page.click('#toStep2');
  await page.fill('#dStart', '2022-05-01'); await page.dispatchEvent('#dStart', 'change');
  assert.strictEqual(await val('yearSel'), '2022');
  assert.strictEqual(await val('dStart'), '2022-05-01');
  assert.strictEqual(await val('dEnd'), '2022-10-15', 'loppupäivä samalle vuodelle');
  await page.waitForFunction(() => /Ruokavirasto 2022/.test(document.getElementById('pickMsg').textContent));
  console.log('ok alkupäivä ja vuosivalinta pysyvät samassa');

  assert.deepStrictEqual(errors, []);
  await browser.close(); server.close();
  console.log('vuosivalinnan selaintesti läpi');
})().catch((e) => { console.error(e); process.exit(1); });
