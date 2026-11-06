// Koonti: yksi itsenäinen HTML-tiedosto, jossa ovat tulos, Vipu-teksti, kuvaaja, video, kuvat ja tiedot.
// Tiedosto avautuu selaimessa ilman verkkoyhteyttä, ja sen voi lähettää sähköpostin liitteenä.
// Riippuu kuvasarja.js:stä (NiittoKuvat.drawFrame) videon ja kuvien piirrossa.
(function (root) {
  'use strict';

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function fiDate(d) { var p = String(d).split('-'); return p.length === 3 ? +p[2] + '.' + +p[1] + '.' + p[0] : String(d); }
  function fx(v, n) { return v == null || v === '' || isNaN(v) ? '–' : Number(v).toFixed(n).replace('.', ','); }

  // ---------- Video ----------
  var MIMES = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4;codecs=avc1', 'video/mp4'];
  function pickMime() {
    var MR = root.MediaRecorder;
    if (!MR || !MR.isTypeSupported) return null;
    for (var i = 0; i < MIMES.length; i++) if (MR.isTypeSupported(MIMES[i])) return MIMES[i];
    return null;
  }
  function loadImage(src) {
    return new Promise(function (res, rej) { var im = new Image(); im.onload = function () { res(im); }; im.onerror = rej; im.src = src; });
  }
  function svgUrl(svgText) { return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText); }

  /**
   * Nauhoittaa videon: ylhäällä päivä ja lähde, keskellä lohkon NDVI-kuva, alhaalla kuvaaja, jossa
   * pystyviiva kulkee kuvan päivän kohdalla. chartFor(frame) palauttaa kuvaajan SVG-tekstinä.
   * Palauttaa { blob, mime, seconds } tai null, jos selain ei tue nauhoitusta.
   */
  async function recordVideo(frames, chartFor, opts) {
    opts = opts || {};
    var mime = pickMime(), doc = opts.document || root.document;
    if (!mime || !frames.length) return null;
    var W = 960, H = 980, IMG_H = 480, per = opts.perFrame || 900;
    var cv = doc.createElement('canvas'); cv.width = W; cv.height = H;
    var ctx = cv.getContext('2d');
    if (!cv.captureStream) return null;
    // Valmistellaan ruudut etukäteen, jotta nauhoitus etenee tasaisesti.
    var prepared = [];
    for (var i = 0; i < frames.length; i++) {
      var f = frames[i], fc = doc.createElement('canvas');
      root.NiittoKuvat.drawFrame(fc, f);
      var chart = null;
      try { chart = await loadImage(svgUrl(chartFor(f))); } catch (e) { chart = null; }
      prepared.push({ f: f, img: fc, chart: chart });
      if (opts.onProgress) opts.onProgress('Valmistellaan videota ' + (i + 1) + '/' + frames.length + '…');
    }
    function paint(p, k) {
      ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = '#1d2320'; ctx.font = '600 30px Inter, system-ui, sans-serif'; ctx.textBaseline = 'top';
      ctx.fillText(fiDate(p.f.date), 24, 20);
      ctx.font = '20px Inter, system-ui, sans-serif'; ctx.fillStyle = '#5d655f';
      ctx.fillText(p.f.src + ' · NDVI ' + fx(p.f.value, 2) + ' · lohkolla kelvollisia ' + p.f.valid + ' %', 24, 60);
      ctx.textAlign = 'right'; ctx.fillText((k + 1) + '/' + prepared.length, W - 24, 28); ctx.textAlign = 'left';
      if (opts.title) { ctx.font = '16px Inter, system-ui, sans-serif'; ctx.fillText(opts.title, 24, 88); }
      ctx.fillStyle = '#eeede6'; ctx.fillRect(24, 116, W - 48, IMG_H);
      var s = Math.min((W - 64) / p.img.width, (IMG_H - 16) / p.img.height);
      var w = p.img.width * s, h = p.img.height * s;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(p.img, (W - w) / 2, 116 + (IMG_H - h) / 2, w, h);
      ctx.imageSmoothingEnabled = true;
      if (p.chart) ctx.drawImage(p.chart, 24, 116 + IMG_H + 12, W - 48, (W - 48) * p.chart.height / p.chart.width);
    }
    paint(prepared[0], 0);
    var stream = cv.captureStream(25), chunks = [];
    var rec = new root.MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: opts.bitrate || 900000 });
    rec.ondataavailable = function (e) { if (e.data && e.data.size) chunks.push(e.data); };
    var done = new Promise(function (res) { rec.onstop = res; });
    rec.start(500);
    var t0 = performance.now(), total = prepared.length * per + 400;
    await new Promise(function (resolve) {
      (function tick() {
        var t = performance.now() - t0, k = Math.min(prepared.length - 1, Math.floor(t / per));
        paint(prepared[k], k); // piirretään joka ruudulla, jotta virta tuottaa kuvia tasaisesti
        if (opts.onProgress) opts.onProgress('Nauhoitetaan videota ' + Math.min(100, Math.round(t / total * 100)) + ' %…');
        if (t >= total) return resolve();
        root.requestAnimationFrame ? root.requestAnimationFrame(tick) : setTimeout(tick, 40);
      })();
    });
    rec.stop(); await done;
    stream.getTracks().forEach(function (tr) { tr.stop(); });
    return { blob: new Blob(chunks, { type: mime.split(';')[0] }), mime: mime.split(';')[0], seconds: Math.round(total / 1000) };
  }

  function blobToDataUrl(blob) {
    return new Promise(function (res, rej) { var r = new FileReader(); r.onload = function () { res(r.result); }; r.onerror = rej; r.readAsDataURL(blob); });
  }

  // ---------- HTML ----------
  var CSS = [
    ':root{--bg:#f6f5f0;--surface:#fff;--surface-2:#eeede6;--ink:#1d2320;--muted:#5d655f;--line:#d9d8cf;--accent:#2f6f4e;--accent-soft:#e3efe7;--warn:#a5671a;--warn-soft:#f6ecdc;--bad:#a4362f;--bad-soft:#f6e1df;--blue:#2c6aa8;--blue-soft:#e3edf7;--violet:#6b4fa3}',
    '*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 Inter,system-ui,-apple-system,"Segoe UI",sans-serif}',
    '.wrap{max-width:960px;margin:0 auto;padding:24px 16px 48px}h1{font-size:28px;line-height:1.2;margin:4px 0 6px}h2{font-size:20px;margin:0 0 10px}h3{font-size:16px;margin:16px 0 6px}',
    '.kicker{font-size:13px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--accent)}.muted{color:var(--muted)}.small{font-size:14px}',
    '.card{background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:18px 20px;margin:16px 0}',
    '.verdict{font-size:24px;font-weight:700}.v-strong,.v-moderate{color:var(--accent)}.v-weak{color:var(--warn)}.v-fail,.v-none{color:var(--bad)}',
    '.facts{display:flex;flex-wrap:wrap;gap:10px;margin:12px 0 0;padding:0}.facts div{border:1px solid var(--line);border-radius:8px;padding:6px 12px}.facts dt{font-size:12px;color:var(--muted)}.facts dd{margin:0;font-weight:600}',
    '.note{border:1px solid var(--warn);background:var(--warn-soft);border-radius:10px;padding:10px 14px;margin:10px 0 0}.note.blue{border-color:var(--blue);background:var(--blue-soft)}',
    'pre.vipu{white-space:pre-wrap;font-family:inherit;font-size:15px;line-height:1.5;background:var(--surface-2);border-radius:8px;padding:12px 14px;margin:0}',
    'svg{width:100%;height:auto;display:block}video{width:100%;max-width:960px;border-radius:8px;background:#000;display:block}',
    '.legend{display:flex;flex-wrap:wrap;gap:14px;font-size:12px;color:var(--muted);margin-top:6px}.legend i{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:4px;vertical-align:-1px}',
    '.gal{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:12px}.gal figure{margin:0;background:var(--surface-2);border-radius:8px;padding:8px}',
    '.gal img{width:100%;height:auto;image-rendering:pixelated;display:block;border-radius:4px;cursor:zoom-in}.gal figcaption{font-size:13px;margin-top:6px}.gal .dim{opacity:.55}',
    'table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:6px 8px;border-top:1px solid var(--line);vertical-align:top}th{border-top:0;font-weight:600}td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}',
    '.tw{overflow-x:auto}ul.checks{margin:0;padding-left:20px}ul.checks li.fail{color:var(--bad)}ul.checks li.warn{color:var(--warn)}',
    '.grade{display:inline-block;font-size:12px;font-weight:600;padding:0 8px;border-radius:999px;border:1px solid var(--line)}',
    'details{margin-top:10px}summary{cursor:pointer;font-weight:600}pre.json{font:12px/1.45 ui-monospace,Menlo,Consolas,monospace;background:var(--surface-2);padding:12px;border-radius:8px;overflow:auto;max-height:480px}',
    '.ramp{width:56px;border-radius:2px!important}.edge{background:none!important;border:2px solid var(--ink);border-radius:2px!important}',
    'dialog{border:0;border-radius:12px;padding:12px;max-width:94vw}dialog img{max-width:90vw;max-height:80vh;image-rendering:pixelated;display:block}',
    'footer{font-size:13px;color:var(--muted);margin-top:24px}',
    '@media print{body{background:#fff}.card{break-inside:avoid}video,.noprint{display:none}}'
  ].join('\n');

  /**
   * d: { title, meta, verdict{level,label,detail}, facts[[dt,dd]], notes[{cls,html}], vipu, chartSvg, legendHtml,
   *      video{dataUrl,mime,seconds}|null, videoNote, frames[{date,src,id,value,valid,png}], minValid,
   *      obs[], excluded[], events[], checks[{s,t}], params[[k,v]], changed[], sens, report, version, created, fileBase }
   */
  function buildHtml(d) {
    var h = [];
    h.push('<!doctype html><html lang="fi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">');
    h.push('<title>' + esc(d.title) + '</title><style>' + CSS + '</style></head><body><div class="wrap">');
    h.push('<div class="kicker">Niittoraportti · koonti</div><h1>' + esc(d.title) + '</h1><p class="muted" style="margin:0">' + esc(d.meta) + '</p>');

    // Tulos
    h.push('<section class="card"><h2>Tulos</h2><div class="verdict v-' + esc(d.verdict.level) + '">' + esc(d.verdict.label) + '</div>');
    if (d.verdict.detail) h.push('<p style="margin:4px 0 0">' + esc(d.verdict.detail) + '</p>');
    if (d.facts && d.facts.length) h.push('<dl class="facts">' + d.facts.map(function (f) { return '<div><dt>' + esc(f[0]) + '</dt><dd>' + esc(f[1]) + '</dd></div>'; }).join('') + '</dl>');
    (d.notes || []).forEach(function (n) { h.push('<div class="note ' + (n.cls || '') + '">' + n.html + '</div>'); });
    h.push('</section>');

    // Vipu-teksti
    h.push('<section class="card"><h2>Teksti Vipu-mobiiliin</h2>' + (d.vipu ? '<pre class="vipu">' + esc(d.vipu) + '</pre>' : '<p class="muted">Tekstiä ei muodostettu: ' + esc(d.vipuWhy || 'niittoa ei tunnistettu tai tukiehto ei täyty') + '.</p>') + '</section>');

    // Kuvaaja
    if (d.chartSvg) h.push('<section class="card"><h2>Kasvuston vihreys</h2>' + d.chartSvg + '<div class="legend">' + (d.legendHtml || '') + '</div></section>');

    // Video
    h.push('<section class="card"><h2>Kuvasarja videona</h2>');
    if (d.video) h.push('<video controls loop muted playsinline preload="metadata" src="' + d.video.dataUrl + '"></video><p class="small muted" style="margin:6px 0 0">' + esc(d.videoNote || '') + ' Kesto noin ' + d.video.seconds + ' s.</p>');
    else h.push('<p class="muted">' + esc(d.videoNote || 'Videota ei voitu tehdä tässä selaimessa.') + '</p>');
    h.push('</section>');

    // Kuvat
    if (d.frames && d.frames.length) {
      h.push('<section class="card"><h2>Lohkon NDVI-kuvat (' + d.frames.length + ')</h2>');
      h.push('<div class="legend" style="margin:0 0 10px"><span><i class="ramp" style="background:' + esc(d.rampCss || '') + '"></i>NDVI 0 → 1</span><span><i style="background:rgb(200,204,208)"></i>pilvi tai ei dataa</span><span><i class="edge"></i>lohkon raja</span><span>himmeä kuva: lohkosta näkyy alle ' + (d.minValid || 50) + ' %</span></div>');
      h.push('<div class="gal">' + d.frames.map(function (f) {
        return '<figure' + (f.valid < (d.minValid || 50) ? ' class="dim"' : '') + '><img src="' + f.png + '" alt="NDVI ' + esc(fiDate(f.date)) + ' ' + esc(f.src) + '" loading="lazy">' +
          '<figcaption><strong>' + esc(fiDate(f.date)) + '</strong> · ' + esc(f.src) + '<br>NDVI ' + fx(f.value, 2) + ' · kelvollisia ' + f.valid + ' %</figcaption></figure>';
      }).join('') + '</div><p class="small muted" style="margin:8px 0 0">Napsauta kuvaa suurentaaksesi.</p></section>');
    }

    // Tiedot
    h.push('<section class="card"><h2>Tiedot</h2>');
    if (d.events && d.events.length) {
      h.push('<h3>Tunnistetut tapahtumat</h3><div class="tw"><table><thead><tr><th>Niittoväli</th><th>Lähteet</th><th class="num">Luottamus</th><th>Rajan yli</th></tr></thead><tbody>' +
        d.events.map(function (e) { return '<tr><td>' + esc(fiDate(e.alku)) + '–' + esc(fiDate(e.loppu)) + '</td><td>' + esc((e.lahteet || []).join(' + ')) + '</td><td class="num">' + fx(e.luottamus, 2) + '</td><td>' + (e.hyvaksytty ? 'kyllä' : 'ei') + '</td></tr>'; }).join('') + '</tbody></table></div>');
    }
    if (d.checks && d.checks.length) h.push('<h3>Tarkistukset</h3><ul class="checks small">' + d.checks.map(function (c) { return '<li class="' + esc(c.s) + '">' + esc(c.t) + '</li>'; }).join('') + '</ul>');
    if (d.changed && d.changed.length) {
      h.push('<h3>Oletuksista poikkeavat asetukset</h3><ul class="small">' + d.changed.map(function (c) {
        return '<li>' + esc(c.nimi) + ' ' + esc(c.oletus) + ' → ' + esc(c.kaytetty) + (c.perusteltavuus ? ' <span class="grade">' + esc(c.perusteltavuus) + '</span>' : '') + (c.perustelu ? '<div class="muted">' + esc(c.perustelu) + '</div>' : '') + '</li>';
      }).join('') + '</ul>');
    }
    if (d.sens && d.sens.loysennykset && d.sens.loysennykset.length) {
      h.push('<h3>Lähellä todennäköisyysrajaa: löysennykset, jotka muuttaisivat tuloksen</h3><div class="tw"><table><thead><tr><th>Löysennys</th><th>Perusteltavuus</th><th>Tulos</th></tr></thead><tbody>' +
        d.sens.loysennykset.map(function (r) {
          return '<tr><td>' + r.muutokset.map(function (m) { return esc(m.asetus) + ' ' + esc(m.oletus) + ' → ' + esc(m.uusi); }).join('<br>+ ') + '</td><td><span class="grade">' + esc(r.perusteltavuus) + '</span></td><td>' + esc(r.tulos) + '<div class="muted small">' + esc(fiDate(r.niittovali[0])) + '–' + esc(fiDate(r.niittovali[1])) + ' · luottamus ' + fx(r.luottamus, 2) + '</div></td></tr>';
        }).join('') + '</tbody></table></div>');
    }
    if (d.obs && d.obs.length) {
      h.push('<h3>Käytetyt havainnot (' + d.obs.length + ')</h3><div class="tw"><table><thead><tr><th>Päivä</th><th>Lähde</th><th>Kuvatunniste</th><th class="num">NDVI / arvo</th><th class="num">Kelvolliset %</th><th class="num">Muuttunut %</th></tr></thead><tbody>' +
        d.obs.map(function (o) { return '<tr><td>' + esc(fiDate(o.paiva)) + '</td><td>' + esc(o.lahde) + '</td><td class="small">' + esc(o.tunniste || '') + '</td><td class="num">' + fx(o.arvo, 2) + '</td><td class="num">' + (o.kelvolliset == null ? '–' : esc(o.kelvolliset)) + '</td><td class="num">' + (o.muuttunut == null ? '–' : esc(o.muuttunut)) + '</td></tr>'; }).join('') + '</tbody></table></div>');
    }
    if (d.excluded && d.excluded.length) {
      h.push('<details><summary>Pois jätetyt havainnot (' + d.excluded.length + ')</summary><ul class="small">' + d.excluded.map(function (x) { return '<li>' + esc(fiDate(x.havainto.date)) + ' ' + esc(x.havainto.src) + ': ' + esc(x.syy) + '</li>'; }).join('') + '</ul></details>');
    }
    if (d.params && d.params.length) h.push('<details><summary>Parametrit</summary><div class="tw"><table><tbody>' + d.params.map(function (p) { return '<tr><td>' + esc(p[0]) + '</td><td>' + esc(p[1]) + '</td></tr>'; }).join('') + '</tbody></table></div></details>');
    if (d.report) h.push('<details><summary>Raportti koneluettavana (JSON)</summary><pre class="json">' + esc(JSON.stringify(d.report, null, 2)) + '</pre></details>');
    h.push('</section>');

    h.push('<footer>Laadittu ' + esc(d.created) + ' · Niittoraportti ' + esc(d.version) + ' · Tiedosto ' + esc(d.fileBase) + '.html. Satelliittiaineistot: NASA HLS, ESA Copernicus Sentinel (Microsoft Planetary Computer, CDSE), Planet. Lohkorajat © Ruokavirasto (CC BY 4.0).</footer>');
    h.push('</div><dialog id="zoom"><img alt=""></dialog>');
    if (d.report) h.push('<script type="application/json" id="niittoraportti-json">' + JSON.stringify(d.report).replace(/</g, '\\u003c') + '</script>');
    h.push('<script>(function(){var dlg=document.getElementById("zoom");if(!dlg||!dlg.showModal)return;var im=dlg.querySelector("img");' +
      'document.addEventListener("click",function(e){var t=e.target;if(t.closest&&t.closest(".gal img")){im.src=t.src;im.alt=t.alt;dlg.showModal()}else if(t===dlg||t===im){dlg.close()}})})();</script>');
    h.push('</body></html>');
    return h.join('\n');
  }

  var api = { buildHtml: buildHtml, recordVideo: recordVideo, pickMime: pickMime, blobToDataUrl: blobToDataUrl, esc: esc };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.NiittoKoonti = api;
})(typeof self !== 'undefined' ? self : this);
