// Selaintesti: datahaun käyttöliittymä Chromiumissa, rajapinnat korvattu synteettisillä kuvilla.
// Vaatii Playwrightin (npm install -D playwright && npx playwright install chromium).
// Aja: node test/selain.test.js
const fs = require('fs');
const path = require('path');
const http = require('http');
const assert = require('assert');
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { console.log('ohitetaan: Playwright puuttuu'); process.exit(0); }

const ROOT = path.join(__dirname, '..');
const FX = path.join(__dirname, 'fixtures');
const PS = ['20260801_093000_00_2475', '20260810_093100_00_2475'];

const server = http.createServer((req, res) => {
  const f = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/^\/$/, '/index.html'));
  if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  const type = f.endsWith('.html') ? 'text/html' : f.endsWith('.js') ? 'text/javascript' : 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type + '; charset=utf-8' }); fs.createReadStream(f).pipe(res);
});

function tiff(route, file) {
  const buf = fs.readFileSync(path.join(FX, file));
  const range = route.request().headers().range;
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Range' };
  if (range) {
    const m = /bytes=(\d+)-(\d+)?/.exec(range); const a = +m[1]; const b = Math.min(m[2] ? +m[2] : buf.length - 1, buf.length - 1);
    return route.fulfill({ status: 206, body: buf.subarray(a, b + 1), headers: { ...cors, 'Content-Range': `bytes ${a}-${b}/${buf.length}` } });
  }
  return route.fulfill({ status: 200, body: buf, headers: cors });
}
const J = (route, o) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(o), headers: { 'Access-Control-Allow-Origin': '*' } });
const blob = (f) => `https://hls2euwest.blob.core.windows.net/hls2/x/${f}`;
const item = (id, c, d, p, nir, e) => ({ id, collection: c, properties: { datetime: d + 'T09:40:00Z', 'proj:epsg': e },
  assets: { B04: { href: blob(p + '.B04.tif') }, [nir]: { href: blob(`${p}.${nir}.tif`) }, Fmask: { href: blob(p + '.Fmask.tif') } } });

(async () => {
  await new Promise((r) => server.listen(0, r));
  const url = `http://127.0.0.1:${server.address().port}/index.html#tyokalu`;
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = []; page.on('pageerror', (e) => errors.push(e.message));
  let orderBody = null, authOk = true;

  await page.route('https://planetarycomputer.microsoft.com/**', (route) => {
    const u = route.request().url();
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'POST,GET' } });
    if (u.endsWith('/search')) return J(route, { features: [
      item('HLS.S30.T35VLL.2026191T094031.v2.0', 'hls2-s30', '2026-07-10', 'hls1', 'B8A', 32635),
      item('HLS.L30.T35VLL.2026201T093522.v2.0', 'hls2-l30', '2026-07-20', 'hls2', 'B05', 32635),
      item('HLS.S30.T35VLL.2026217T094029.v2.0', 'hls2-s30', '2026-08-05', 'hls3', 'B8A', 32635),
      item('HLS.L30.T34VFQ.2026227T093522.v2.0', 'hls2-l30', '2026-08-15', 'hls5', 'B05', 32634)], links: [] });
    if (u.includes('/sas/v1/token/')) return J(route, { token: 'sig=abc', 'msft:expiry': new Date(Date.now() + 3600e3).toISOString() });
    return route.fulfill({ status: 404 });
  });
  await page.route('https://hls2euwest.blob.core.windows.net/**', (route) => tiff(route, route.request().url().split('/').pop().split('?')[0]));
  await page.route('https://api.planet.com/**', (route) => {
    const r = route.request(), u = r.url();
    if (r.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'POST,GET' } });
    if (u.includes('/compute/ops/download/')) { const t = u.split('token=')[1]; const id = t.replace(/_(sr|udm)$/, ''); return tiff(route, t.endsWith('_sr') ? `${id}_3B_AnalyticMS_SR_harmonized_clip.tif` : `${id}_3B_udm2_clip.tif`); }
    if (r.headers().authorization !== 'Basic ' + Buffer.from('PLAK-testi:').toString('base64')) authOk = false;
    if (u.includes('/quick-search')) return J(route, { features: PS.map((id, i) => ({ id, properties: { acquired: (i ? '2026-08-10' : '2026-08-01') + 'T09:30:00Z', clear_percent: 95 } })), _links: {} });
    if (u.endsWith('/orders/v2') && r.method() === 'POST') { orderBody = JSON.parse(r.postData()); return J(route, { id: 'ord-9' }); }
    if (u.endsWith('/orders/v2/ord-9')) return J(route, { state: 'success', _links: { results: PS.flatMap((id) => [
      { name: `ord-9/PSScene/${id}_3B_AnalyticMS_SR_harmonized_clip.tif`, location: `https://api.planet.com/compute/ops/download/?token=${id}_sr` },
      { name: `ord-9/PSScene/${id}_3B_udm2_clip.tif`, location: `https://api.planet.com/compute/ops/download/?token=${id}_udm` }]) } });
    return route.fulfill({ status: 404 });
  });

  await page.goto(url);
  await page.fill('#geo', fs.readFileSync(path.join(FX, 'field.geojson'), 'utf8'));
  await page.dispatchEvent('#geo', 'input');
  assert.match(await page.textContent('#geoMsg'), /6,00 ha · EPSG:3067/);
  assert.strictEqual(await page.inputValue('#lohko'), 'TESTI-1');
  await page.fill('#dStart', '2026-07-01'); await page.fill('#dEnd', '2026-08-31');

  await page.click('#hlsGo');
  await page.waitForSelector('#fetchLog li.ok', { timeout: 20000 });
  const rows = await page.$$eval('#obsTable tbody tr', (trs) => trs.map((tr) => [tr.querySelector('.d').value, tr.querySelector('.s').value, tr.querySelector('.v').value, tr.querySelector('.va').value, tr.querySelector('.ch').value]));
  assert.deepStrictEqual(rows.map((r) => r[0]), ['2026-07-10', '2026-07-20', '2026-08-05', '2026-08-15']);
  assert.deepStrictEqual(rows[2], ['2026-08-05', 'HLS-S30', '0.45', '100', '94']);
  const verdict = await page.textContent('#verdict');
  assert.match(verdict, /10\.7\.2026–5\.8\.2026/);
  console.log('ok HLS-haku täyttää taulukon ja tunnistus löytää niiton:', verdict.replace(/\s+/g, ' ').slice(0, 120));
  await page.screenshot({ path: path.join(process.env.SHOT_DIR || require('os').tmpdir(), 'selain_hls.png'), fullPage: false });

  await page.fill('#plKey', 'PLAK-testi');
  await page.click('#psSearch');
  await page.waitForFunction(() => !document.getElementById('psOrder').disabled, null, { timeout: 10000 });
  assert.match(await page.textContent('#psOrder'), /Tilaa 2 kuvaa \(≈ 0,12 km²\)/);
  page.once('dialog', (d) => d.accept());
  await page.click('#psOrder');
  await page.waitForFunction(() => /PlanetScope: 2 havaintoa/.test(document.getElementById('fetchLog').textContent), null, { timeout: 20000 });
  assert.ok(authOk, 'Basic-tunnistautuminen');
  assert.deepStrictEqual(orderBody.products[0].item_ids, PS);
  assert.strictEqual(await page.inputValue('#psOrderId'), 'ord-9');
  const srcs = await page.$$eval('#obsTable tbody tr .s', (s) => s.map((x) => x.value));
  assert.strictEqual(srcs.filter((s) => s === 'PlanetScope').length, 2);
  assert.strictEqual(srcs.length, 6);
  const key = await page.evaluate(() => sessionStorage.getItem('niitto_plkey'));
  assert.strictEqual(key, null, 'avainta ei tallenneta ilman valintaa');
  assert.ok(await page.$eval('#fetchStop', (b) => getComputedStyle(b).display === 'none'), 'Keskeytä piilossa');
  console.log('ok PlanetScope-haku, tilaus ja käsittely; avain ei päädy tallennukseen');
  await page.click('#toCreds');
  assert.ok(await page.$eval('#tunnukset', (d) => d.open));
  await page.setViewportSize({ width: 390, height: 900 });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  assert.ok(!overflow, 'ei vaakavieritystä puhelinleveydellä');
  await page.screenshot({ path: path.join(process.env.SHOT_DIR || require('os').tmpdir(), 'selain_mobiili.png'), fullPage: false });
  console.log('ok ohjeet avautuvat ja asettelu toimii 390 px leveydellä');
  assert.deepStrictEqual(errors, []);
  await browser.close(); server.close();
  console.log('selaintesti läpi');
})().catch((e) => { console.error(e); process.exit(1); });
