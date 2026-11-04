// Selaintesti: lohkon valinta peruslohkotunnuksella, kartalta klikkaamalla ja piirtämällä.
// MML-, OSM- ja Ruokaviraston rajapinnat korvataan testidatalla. Vaatii Playwrightin.
// Aja: node test/kartta.selain.test.js
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

// 1×1 PNG yhdellä värillä
function png(r, g, b, a) {
  const crc = (buf) => { let c, k, crcv = 0xffffffff; for (let n = 0; n < buf.length; n++) { c = (crcv ^ buf[n]) & 0xff; for (k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcv = (crcv >>> 8) ^ c; } return (crcv ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1, 0); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.from([0, r, g, b, a]))), chunk('IEND', Buffer.alloc(0))]);
}
const sq = (x0, y0, x1, y1) => [[[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]]];
const PARCELS = [
  { type: 'Feature', id: 'p.1', properties: { PERUSLOHKOTUNNUS: 1641431471, LOHKONUMERO: 1, KASVIKOODI_SELITE_FI: 'Säilörehunurmi' }, geometry: { type: 'Polygon', coordinates: sq(22.840, 62.790, 22.843, 62.792) } },
  { type: 'Feature', id: 'p.2', properties: { PERUSLOHKOTUNNUS: 1641431471, LOHKONUMERO: 2, KASVIKOODI_SELITE_FI: 'Luonnonhoitonurmi' }, geometry: { type: 'Polygon', coordinates: sq(22.843, 62.790, 22.846, 62.792) } },
];
const cors = { 'Access-Control-Allow-Origin': '*' };

(async () => {
  await new Promise((r) => server.listen(0, r));
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } });
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  const seen = { mml: 0, osm: 0, gfi: 0, wfs: 0 };

  await page.route('https://avoin-karttakuva.maanmittauslaitos.fi/**', (r) => {
    seen.mml++; assert.ok(r.request().url().includes('api-key=TESTIAVAIN'));
    return r.fulfill({ status: 200, contentType: 'image/png', body: png(230, 225, 210, 255) });
  });
  await page.route('https://tile.openstreetmap.org/**', (r) => { seen.osm++; return r.fulfill({ status: 200, contentType: 'image/png', body: png(240, 240, 240, 255) }); });
  await page.route('https://inspire.ruokavirasto-awsa.com/**', (r) => {
    const u = new URL(r.request().url()); const q = Object.fromEntries([...u.searchParams].map(([k, v]) => [k.toLowerCase(), v]));
    const layer = q.layers || q.typenames || '';
    const year = +layer.split('.').pop();
    if (year > 2025) return r.fulfill({ status: 200, contentType: 'application/vnd.ogc.se_xml', body: '<ServiceExceptionReport/>', headers: cors });
    if (q.request === 'GetMap') return r.fulfill({ status: 200, contentType: 'image/png', body: png(194, 65, 12, 90), headers: cors });
    if (q.request === 'GetFeatureInfo') {
      seen.gfi++;
      const b = q.bbox.split(',').map(Number); const lon = (b[0] + b[2]) / 2, lat = (b[1] + b[3]) / 2;
      const hit = PARCELS.filter((f) => { const c = f.geometry.coordinates[0]; return lon >= c[0][0] && lon <= c[1][0] && lat >= c[0][1] && lat <= c[2][1]; });
      // GeoServer voi palauttaa lat/lon-järjestyksen: testataan myös sitä
      const swapped = JSON.parse(JSON.stringify(hit)); swapped.forEach((f) => { f.geometry.coordinates[0] = f.geometry.coordinates[0].map(([x, y]) => [y, x]); });
      return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ type: 'FeatureCollection', features: swapped }), headers: cors });
    }
    if (q.request === 'DescribeFeatureType') return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ featureTypes: [{ properties: [{ name: 'PERUSLOHKOTUNNUS' }] }] }), headers: cors });
    if (q.request === 'GetFeature') { seen.wfs++; return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ type: 'FeatureCollection', features: q.typenames.includes('GSAA') ? PARCELS : [] }), headers: cors }); }
    return r.fulfill({ status: 404 });
  });

  await page.goto(`http://127.0.0.1:${server.address().port}/index.html#tyokalu`);
  await page.fill('#dStart', '2026-05-01');

  // 1) Peruslohkotunnus → kaksi kasvulohkoa → valitaan luonnonhoitonurmi
  await page.fill('#pltIn', '1641431471');
  await page.click('#pltGo');
  await page.waitForSelector('#pltList:not([hidden]) button');
  const opts = await page.$$eval('#pltList button', (b) => b.map((x) => x.textContent));
  assert.strictEqual(opts.length, 2);
  assert.match(opts[1], /1641431471-2 · Luonnonhoitonurmi · 3,\d\d ha/);
  await page.click('#pltList button:nth-child(2)');
  assert.strictEqual(await page.inputValue('#lohko'), '1641431471-2');
  assert.strictEqual(await page.inputValue('#measure'), 'Luonnonhoitonurmi');
  assert.match(await page.textContent('#geoMsg'), /3,\d\d ha · WGS84/);
  assert.match(await page.textContent('#pickMsg'), /Valittu kasvulohko 1641431471-2 · Luonnonhoitonurmi .* 2025/);
  console.log('ok peruslohkotunnus: kasvulohkon valinta, tunnus, toimenpide ja rajaus');

  // 2) Kartta MML-avaimella, klikkaus lohkoon
  await page.fill('#geo', ''); await page.dispatchEvent('#geo', 'input');
  await page.fill('#lohko', '');
  await page.click('#mapOpen');
  await page.fill('#mmlKey', 'TESTIAVAIN'); await page.dispatchEvent('#mmlKey', 'change');
  await page.waitForFunction(() => /Kasvulohkot vuodelta 2025/.test(document.getElementById('pickMsg').textContent), null, { timeout: 10000 });
  const mapBox = await page.$('#map');
  // Liitetty rajaus näytetään kartalla ja kartta zoomaa siihen; sen jälkeen klikataan keskeltä
  await page.fill('#geo', JSON.stringify(PARCELS[1])); await page.dispatchEvent('#geo', 'input');
  await page.waitForTimeout(400);
  assert.ok(seen.mml > 0, 'MML-tiilet ladattiin');
  await page.fill('#geo', ''); await page.dispatchEvent('#geo', 'input'); await page.fill('#lohko', '');
  const bb = await mapBox.boundingBox();
  await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
  await page.waitForFunction(() => /Valittu kasvulohko/.test(document.getElementById('pickMsg').textContent), null, { timeout: 10000 });
  assert.ok(seen.gfi >= 1);
  assert.strictEqual(await page.inputValue('#lohko'), '1641431471-2');
  const g = JSON.parse(await page.inputValue('#geo'));
  assert.deepStrictEqual(g.geometry.coordinates[0][0], [22.843, 62.79], 'akselijärjestys korjattu');
  console.log('ok kartta: MML-tiilet avaimella, klikkaus hakee kasvulohkon');
  await page.screenshot({ path: path.join(process.env.SHOT_DIR || require('os').tmpdir(), 'kartta_valinta.png') });

  // 3) Piirto
  await page.click('#drawBtn');
  for (const [dx, dy] of [[-60, -40], [60, -40], [60, 40], [-60, 40]]) await page.mouse.click(bb.x + bb.width / 2 + dx, bb.y + bb.height / 2 + dy);
  await page.click('#drawDone');
  const d = JSON.parse(await page.inputValue('#geo'));
  assert.strictEqual(d.geometry.coordinates[0].length, 5);
  assert.match(await page.textContent('#pickMsg'), /Rajaus piirretty käsin · \d+,\d\d ha/);
  console.log('ok piirto: neljä pistettä → suljettu monikulmio');

  // 4) Väärä MML-avain → OSM
  await page.unroute('https://avoin-karttakuva.maanmittauslaitos.fi/**');
  await page.route('https://avoin-karttakuva.maanmittauslaitos.fi/**', (r) => r.fulfill({ status: 401, body: '' }));
  await page.fill('#mmlKey', 'VÄÄRÄ'); await page.dispatchEvent('#mmlKey', 'change');
  await page.waitForFunction(() => /OpenStreetMap/.test(document.getElementById('pickMsg').textContent), null, { timeout: 10000 });
  console.log('ok väärä MML-avain vaihtaa OpenStreetMapiin');

  assert.ok(!(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)));
  assert.deepStrictEqual(errors, []);
  await browser.close(); server.close();
  console.log('kartan selaintesti läpi');
})().catch((e) => { console.error(e); process.exit(1); });
