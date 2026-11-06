// Kuvasarja: lohkon NDVI-kuvat aikajärjestyksessä, toisto ja kaikkien kuvien lataus ZIP-pakettina.
// Ruudut tulevat datahaku.js:n framesOf-funktiosta (HLS, Sentinel-2, PlanetScope). Ei DOM-riippuvuutta
// moduulin lataushetkellä; käyttöliittymä rakennetaan init-kutsussa.
(function (root) {
  'use strict';

  // ---------- Väriasteikko ----------
  // Paljas maa ja sänki ruskeasta, niukka kasvusto keltaisesta, tiheä kasvusto tummanvihreään.
  var STOPS = [
    [-0.1, [140, 109, 79]], [0.2, [201, 179, 122]], [0.4, [230, 217, 107]],
    [0.6, [140, 194, 101]], [0.8, [47, 143, 70]], [1.0, [20, 90, 44]]
  ];
  var CLOUD = [200, 204, 208];
  function ndviColor(v) {
    if (v <= STOPS[0][0]) return STOPS[0][1];
    for (var i = 1; i < STOPS.length; i++) {
      if (v <= STOPS[i][0]) {
        var a = STOPS[i - 1], b = STOPS[i], t = (v - a[0]) / (b[0] - a[0]);
        return [0, 1, 2].map(function (k) { return Math.round(a[1][k] + (b[1][k] - a[1][k]) * t); });
      }
    }
    return STOPS[STOPS.length - 1][1];
  }
  function gradientCss() {
    return 'linear-gradient(90deg,' + STOPS.map(function (s) {
      return 'rgb(' + s[1].join(',') + ') ' + Math.round((s[0] + 0.1) / 1.1 * 100) + '%';
    }).join(',') + ')';
  }

  // Kokonaislukuskaalaus: pisin sivu vähintään noin 320 px, enintään 1200 px.
  function scaleOf(f) {
    var m = Math.max(f.w, f.h);
    return Math.max(1, Math.min(Math.ceil(320 / m), Math.floor(1200 / m) || 1));
  }

  /** Piirtää ruudun canvasiin. Lohkon ulkopuoli himmennettynä, pilvet harmaana, rajaus viivana. */
  function drawFrame(canvas, f, scale) {
    var s = scale || scaleOf(f), W = f.w * s, H = f.h * s;
    canvas.width = W; canvas.height = H;
    var ctx = canvas.getContext('2d');
    var img = ctx.createImageData(f.w, f.h), d = img.data;
    for (var i = 0; i < f.w * f.h; i++) {
      var v = f.ndvi ? f.ndvi[i] : NaN, c = isNaN(v) ? CLOUD : ndviColor(v), j = i * 4;
      d[j] = c[0]; d[j + 1] = c[1]; d[j + 2] = c[2];
      d[j + 3] = f.inside[i] ? 255 : (isNaN(v) ? 60 : 120);
    }
    // Pikselöity suurennos: piirretään natiivikokoon väliaikaiseen canvasiin ja skaalataan ilman pehmennystä.
    var tmp = canvas.ownerDocument.createElement('canvas');
    tmp.width = f.w; tmp.height = f.h; tmp.getContext('2d').putImageData(img, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(tmp, 0, 0, W, H);
    // Lohkon raja (rasterin koordinaatistossa) kuvan pikseleiksi.
    var px = function (c) { return [(c[0] - f.x0) / f.res[0] * s, (c[1] - f.y0) / f.res[1] * s]; };
    ctx.lineJoin = 'round';
    [[3, 'rgba(255,255,255,.9)'], [1.5, 'rgba(20,24,22,.95)']].forEach(function (st) {
      ctx.lineWidth = st[0]; ctx.strokeStyle = st[1]; ctx.beginPath();
      (f.polys || []).forEach(function (p) {
        p.forEach(function (ring) {
          ring.forEach(function (c, k) { var q = px(c); if (k) ctx.lineTo(q[0], q[1]); else ctx.moveTo(q[0], q[1]); });
          ctx.closePath();
        });
      });
      ctx.stroke();
    });
    return s;
  }

  // ---------- ZIP (tallennus ilman pakkausta; PNG on jo pakattu) ----------
  var CRC = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return t;
  })();
  function crc32(u8) { var c = 0xFFFFFFFF; for (var i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
  function utf8(s) { return new TextEncoder().encode(s); }
  /** files: [{name, data: Uint8Array}] → Uint8Array (ZIP, store). */
  function zip(files) {
    var parts = [], central = [], off = 0, now = new Date();
    var dt = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xFFFF;
    var dd = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xFFFF;
    files.forEach(function (f) {
      var name = utf8(f.name), crc = crc32(f.data), n = f.data.length;
      var h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true);
      h.setUint16(10, dt, true); h.setUint16(12, dd, true); h.setUint32(14, crc, true); h.setUint32(18, n, true); h.setUint32(22, n, true);
      h.setUint16(26, name.length, true); h.setUint16(28, 0, true);
      parts.push(new Uint8Array(h.buffer), name, f.data);
      var c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true);
      c.setUint16(12, dt, true); c.setUint16(14, dd, true); c.setUint32(16, crc, true); c.setUint32(20, n, true); c.setUint32(24, n, true);
      c.setUint16(28, name.length, true); c.setUint32(42, off, true);
      central.push(new Uint8Array(c.buffer), name);
      off += 30 + name.length + n;
    });
    var cSize = central.reduce(function (s, p) { return s + p.length; }, 0);
    var e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
    e.setUint32(12, cSize, true); e.setUint32(16, off, true);
    var all = parts.concat(central, [new Uint8Array(e.buffer)]), len = all.reduce(function (s, p) { return s + p.length; }, 0);
    var out = new Uint8Array(len), pos = 0;
    all.forEach(function (p) { out.set(p, pos); pos += p.length; });
    return out;
  }

  function fiDate(d) { var p = String(d).split('-'); return +p[2] + '.' + +p[1] + '.' + p[0]; }
  function fx(v, n) { return v == null || isNaN(v) ? '–' : v.toFixed(n).replace('.', ','); }
  function safe(s) { return String(s || '').replace(/[^\w.-]+/g, '_').slice(0, 80); }
  function fileName(f) { return f.date + '_' + safe(f.src) + '_' + safe(f.id); }
  function key(f) { return f.src + '|' + f.date + '|' + f.id; }

  /** Rakentaa ZIP-paketin: PNG + world file (.pgw) jokaisesta ruudusta, kuvat.csv ja LUEMINUT.txt. */
  async function buildZip(frames, opts) {
    opts = opts || {};
    var doc = opts.document || root.document, files = [], rows = ['paiva;lahde;tunniste;ndvi_mediaani;kelvolliset_pct;epsg;pikselikoko_m;tiedosto'];
    for (var i = 0; i < frames.length; i++) {
      var f = frames[i], cv = doc.createElement('canvas'), s = drawFrame(cv, f), nm = fileName(f);
      var blob = await new Promise(function (res) { cv.toBlob(res, 'image/png'); });
      files.push({ name: nm + '.png', data: new Uint8Array(await blob.arrayBuffer()) });
      var A = f.res[0] / s, E = f.res[1] / s;
      files.push({ name: nm + '.pgw', data: utf8([A, 0, 0, E, f.x0 + A / 2, f.y0 + E / 2].map(function (x) { return x.toFixed(6); }).join('\r\n') + '\r\n') });
      rows.push([f.date, f.src, f.id, f.value == null ? '' : f.value, f.valid, f.epsg, Math.abs(f.res[0]), nm + '.png'].join(';'));
      if (opts.onProgress) opts.onProgress(i + 1, frames.length);
    }
    files.push({ name: 'kuvat.csv', data: utf8('﻿' + rows.join('\r\n') + '\r\n') });
    files.push({ name: 'LUEMINUT.txt', data: utf8([
      'Niittoraportti: lohkon NDVI-kuvat' + (opts.lohko ? ' (' + opts.lohko + ')' : ''),
      '',
      'Jokainen PNG on yhden satelliittikuvan NDVI lohkon ympäriltä. Värit: ruskea = paljas maa tai sänki (NDVI < 0,2),',
      'keltainen = niukka kasvusto (noin 0,4), vihreä = tiheä kasvusto (yli 0,6). Harmaa = pilvi, varjo tai ei dataa.',
      'Lohkon ulkopuoli on himmennetty, ja lohkon raja on piirretty mustavalkoisena viivana.',
      '',
      'Kuvat ovat suurennettuja (pikselöity kokonaislukukertoimella). Jokaisen PNG:n vieressä on world file (.pgw),',
      'jolla kuvan voi avata paikkatieto-ohjelmassa (esim. QGIS). Koordinaattijärjestelmä on kuvat.csv:n EPSG-sarakkeessa',
      '(UTM-vyöhyke; aseta se kuvalle käsin, koska .pgw ei sisällä sitä).',
      '',
      'kuvat.csv: päivä, lähde, kuvatunniste, lohkon NDVI-mediaani (reunapuskurin sisältä) ja kelvollisten pikselien osuus.',
      'Kuvat on rajattu ja maskattu selaimessa samoilla asetuksilla kuin raportin havainnot.'
    ].join('\r\n') + '\r\n') });
    return zip(files);
  }

  // ---------- Näkymä ----------
  function create(el, opts) {
    opts = opts || {};
    var doc = el.ownerDocument, all = [], list = [], idx = 0, timer = null, onlyClear = true;
    el.innerHTML =
      '<div class="seq-top"><h4 class="seq-h">Kuvasarja</h4><span class="seq-cap small" aria-live="polite"></span></div>' +
      '<div class="seq-stage"><canvas class="seq-cv" role="img" aria-label="Lohkon NDVI-kuva"></canvas><p class="seq-empty small muted" hidden></p></div>' +
      '<div class="seq-ctl">' +
      '<button class="btn sm seq-prev" type="button" aria-label="Edellinen kuva">◀</button>' +
      '<button class="btn sm seq-play" type="button" aria-label="Toista">▶ Toista</button>' +
      '<button class="btn sm seq-next" type="button" aria-label="Seuraava kuva">▶</button>' +
      '<input class="seq-range" type="range" min="0" max="0" value="0" aria-label="Kuvan valinta">' +
      '<select class="seq-speed" aria-label="Toistonopeus"><option value="1600">hidas</option><option value="900" selected>normaali</option><option value="450">nopea</option></select>' +
      '</div>' +
      '<div class="seq-opts"><label class="small"><input type="checkbox" class="seq-clear" checked> Vain selkeät kuvat (lohkosta näkyy ≥ 50 %)</label>' +
      '<button class="btn sm seq-dl" type="button">Lataa kaikki kuvat (ZIP)</button></div>' +
      '<div class="legend small seq-leg"><span><i class="seq-ramp" style="background:' + gradientCss() + '"></i>NDVI 0 → 1</span>' +
      '<span><i style="background:rgb(' + CLOUD.join(',') + ')"></i>pilvi tai ei dataa</span><span><i class="seq-edge"></i>lohkon raja</span></div>' +
      '<p class="small muted" style="margin:6px 0 0">Kuvaajan pystyviiva näyttää kuvan päivän. Napsauta kuvaajan pistettä, niin sarja siirtyy sen päivän kuvaan.</p>';
    var q = function (c) { return el.querySelector('.' + c); };
    var cv = q('seq-cv'), cap = q('seq-cap'), rng = q('seq-range'), play = q('seq-play'), empty = q('seq-empty'), dl = q('seq-dl');

    function stop() { if (timer) { clearInterval(timer); timer = null; } play.textContent = '▶ Toista'; play.setAttribute('aria-label', 'Toista'); }
    function show(i, quiet) {
      if (!list.length) return;
      idx = (i + list.length) % list.length;
      var f = list[idx];
      drawFrame(cv, f);
      rng.value = idx;
      cap.innerHTML = '<strong>' + fiDate(f.date) + '</strong> · ' + f.src + ' · NDVI ' + fx(f.value, 2) +
        ' · lohkolla kelvollisia ' + f.valid + ' % <span class="muted">(' + (idx + 1) + '/' + list.length + ')</span>';
      cv.setAttribute('aria-label', 'NDVI ' + fiDate(f.date) + ' ' + f.src);
      if (!quiet && opts.onChange) opts.onChange(f);
    }
    function rebuild(keepKey) {
      list = all.filter(function (f) { return !onlyClear || f.valid >= (opts.minValid || 50); });
      el.hidden = !all.length;
      rng.max = Math.max(0, list.length - 1);
      [q('seq-prev'), play, q('seq-next'), rng].forEach(function (b) { b.disabled = list.length < 2; });
      dl.disabled = !all.length;
      dl.textContent = 'Lataa kaikki kuvat (' + all.length + ', ZIP)';
      empty.hidden = !!list.length; cv.hidden = !list.length;
      if (!list.length) {
        stop(); cap.textContent = '';
        empty.textContent = all.length ? 'Yhdessäkään kuvassa lohko ei näy riittävästi. Poista rajaus, niin näet myös pilviset kuvat.' : '';
        if (opts.onChange) opts.onChange(null);
        return;
      }
      var k = keepKey ? list.map(key).indexOf(keepKey) : -1;
      show(k >= 0 ? k : Math.min(idx, list.length - 1));
    }
    q('seq-prev').addEventListener('click', function () { stop(); show(idx - 1); });
    q('seq-next').addEventListener('click', function () { stop(); show(idx + 1); });
    rng.addEventListener('input', function () { stop(); show(+rng.value); });
    play.addEventListener('click', function () {
      if (timer) { stop(); return; }
      if (idx >= list.length - 1) show(0);
      play.textContent = '❚❚ Tauko'; play.setAttribute('aria-label', 'Pysäytä');
      timer = setInterval(function () { if (idx >= list.length - 1) { stop(); return; } show(idx + 1); }, +q('seq-speed').value);
    });
    q('seq-speed').addEventListener('change', function () { if (timer) { stop(); play.click(); } });
    q('seq-clear').addEventListener('change', function () { onlyClear = this.checked; rebuild(list[idx] && key(list[idx])); });
    dl.addEventListener('click', async function () {
      if (!all.length) return;
      var t = dl.textContent; dl.disabled = true;
      try {
        var z = await buildZip(all, { document: doc, lohko: opts.lohko && opts.lohko(), onProgress: function (a, b) { dl.textContent = 'Muodostetaan ' + a + '/' + b + '…'; } });
        var a = doc.createElement('a'); a.href = URL.createObjectURL(new Blob([z], { type: 'application/zip' }));
        a.download = ((opts.fileBase && opts.fileBase()) || 'niittoraportti') + '_kuvat.zip';
        doc.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(a.href); }, 10000);
      } finally { dl.disabled = false; dl.textContent = t; }
    });

    return {
      /** Asettaa ruudut; säilyttää näytettävän kuvan, jos se on yhä mukana. */
      set: function (frames) {
        var cur = list[idx] && key(list[idx]);
        all = (frames || []).slice().sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : a.src < b.src ? -1 : 1; });
        rebuild(cur);
      },
      /** Siirtyy päivän (ja lähteen) kuvaan; jos se on rajattu pois, näytetään lähin päivä. */
      goTo: function (date, src) {
        stop();
        var i = list.map(function (f) { return f.date + '|' + f.src; }).indexOf(date + '|' + src);
        if (i < 0) i = list.map(function (f) { return f.date; }).indexOf(date);
        if (i < 0 && list.length) {
          var t = Date.parse(date), best = 0;
          list.forEach(function (f, k) { if (Math.abs(Date.parse(f.date) - t) < Math.abs(Date.parse(list[best].date) - t)) best = k; });
          i = best;
        }
        if (i >= 0) { show(i); el.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }
      },
      current: function () { return list[idx] || null; },
      stop: stop
    };
  }

  var api = { gradientCss: gradientCss, ndviColor: ndviColor, scaleOf: scaleOf, drawFrame: drawFrame, crc32: crc32, zip: zip, buildZip: buildZip, create: create };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.NiittoKuvat = api;
})(typeof self !== 'undefined' ? self : this);
