/*
 * Niittoraportti – satelliittihavaintojen haku selaimessa.
 *
 * HLS v2.0 (S30 ja L30) haetaan Microsoftin Planetary Computerista (STAC + SAS-token,
 * ei käyttäjätunnusta). PlanetScope haetaan Planetin Data API:sta ja tilataan
 * Orders API:lla lohkoon rajattuna ja Sentinel-2:een harmonisoituna (vaatii API-avaimen).
 * Sentinel-1-tutkan VV/VH-takaisinsironta (γ⁰, maastokorjattu) lasketaan lohkon keskiarvona
 * Copernicus Data Space Ecosystemin Sentinel Hub Statistical API:lla (maksuton CDSE-tunnus).
 *
 * Jokaisesta kuvasta lasketaan lohkon sisältä (reunapuskurin verran kutistettuna):
 *   arvo         = kelvollisten pikselien NDVI-mediaani
 *   kelvolliset  = kelvollisten pikselien osuus lohkon pikseleistä (%)
 *   muuttunut    = osuus pikseleistä, joissa NDVI laski ≥ kynnys edellisestä saman
 *                  sensoriperheen kelvollisesta havainnosta (%)
 * Tulos on sama rivimuoto kuin sovelluksen havaintotaulukossa ja CSV-tuonnissa.
 *
 * Moduulilla ei ole DOM-riippuvuuksia. Selaimessa se käyttää globaaleja GeoTIFF ja fetch,
 * Nodessa require('./vendor/geotiff.js') ja globaalia fetchiä (testeissä mockattu).
 */
(function (root) {
  'use strict';

  // Selaimessa vendor/geotiff.js asettaa globaalin GeoTIFF; Nodessa (testit) se annetaan _setGeoTIFF-funktiolla.
  var GT = root.GeoTIFF || null;

  var PC_STAC = 'https://planetarycomputer.microsoft.com/api/stac/v1';
  var PC_SAS = 'https://planetarycomputer.microsoft.com/api/sas/v1/token';
  var PL_DATA = 'https://api.planet.com/data/v1';
  var PL_ORDERS = 'https://api.planet.com/compute/ops/orders/v2';
  var CDSE_TOKEN = 'https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token';
  var CDSE_STATS = 'https://sh.dataspace.copernicus.eu/statistics/v1';
  var CDSE_CATALOG = 'https://sh.dataspace.copernicus.eu/api/v1/catalog/1.0.0/search';
  var S1_MIN_PIXELS = 30;   // oma: alle 30 tutkapikseliä (≈ 0,3 ha) → speckle hallitsee keskiarvoa

  // ---------- Projektio: WGS84 ↔ UTM (pohjoinen) ja ETRS-TM35FIN ----------
  // ETRS-TM35FIN (EPSG:3067) = UTM-vyöhyke 35 GRS80-ellipsoidilla; ero WGS84:ään on alle millimetrin.
  var A = 6378137, F = 1 / 298.257223563, K0 = 0.9996;
  var E2 = F * (2 - F), EP2 = E2 / (1 - E2), DEG = Math.PI / 180;

  function zoneOf(epsg) {
    epsg = +epsg;
    if (epsg === 3067) return { zone: 35, south: false };
    if (epsg >= 32601 && epsg <= 32660) return { zone: epsg - 32600, south: false };
    if (epsg >= 32701 && epsg <= 32760) return { zone: epsg - 32700, south: true };
    if (epsg >= 25828 && epsg <= 25838) return { zone: epsg - 25800, south: false }; // ETRS89 / UTM
    throw new Error('Koordinaatisto EPSG:' + epsg + ' ei ole tuettu (tuetut: UTM ja EPSG:3067).');
  }

  function toUtm(lon, lat, epsg) {
    var z = zoneOf(epsg), lon0 = ((z.zone - 1) * 6 - 180 + 3) * DEG;
    var phi = lat * DEG, s = Math.sin(phi), c = Math.cos(phi), t = Math.tan(phi);
    var N = A / Math.sqrt(1 - E2 * s * s), T = t * t, C = EP2 * c * c, Aa = c * (lon * DEG - lon0);
    var e4 = E2 * E2, e6 = e4 * E2;
    var M = A * ((1 - E2 / 4 - 3 * e4 / 64 - 5 * e6 / 256) * phi - (3 * E2 / 8 + 3 * e4 / 32 + 45 * e6 / 1024) * Math.sin(2 * phi) +
      (15 * e4 / 256 + 45 * e6 / 1024) * Math.sin(4 * phi) - (35 * e6 / 3072) * Math.sin(6 * phi));
    var x = K0 * N * (Aa + (1 - T + C) * Math.pow(Aa, 3) / 6 + (5 - 18 * T + T * T + 72 * C - 58 * EP2) * Math.pow(Aa, 5) / 120) + 500000;
    var y = K0 * (M + N * t * (Aa * Aa / 2 + (5 - T + 9 * C + 4 * C * C) * Math.pow(Aa, 4) / 24 + (61 - 58 * T + T * T + 600 * C - 330 * EP2) * Math.pow(Aa, 6) / 720));
    if (z.south) y += 10000000;
    return [x, y];
  }

  function toLonLat(x, y, epsg) {
    var z = zoneOf(epsg), lon0 = ((z.zone - 1) * 6 - 180 + 3) * DEG;
    if (z.south) y -= 10000000;
    var e4 = E2 * E2, e6 = e4 * E2, e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
    var mu = (y / K0) / (A * (1 - E2 / 4 - 3 * e4 / 64 - 5 * e6 / 256));
    var p1 = mu + (3 * e1 / 2 - 27 * Math.pow(e1, 3) / 32) * Math.sin(2 * mu) + (21 * e1 * e1 / 16 - 55 * Math.pow(e1, 4) / 32) * Math.sin(4 * mu) +
      (151 * Math.pow(e1, 3) / 96) * Math.sin(6 * mu) + (1097 * Math.pow(e1, 4) / 512) * Math.sin(8 * mu);
    var s = Math.sin(p1), c = Math.cos(p1), t = Math.tan(p1);
    var N1 = A / Math.sqrt(1 - E2 * s * s), T1 = t * t, C1 = EP2 * c * c, R1 = A * (1 - E2) / Math.pow(1 - E2 * s * s, 1.5);
    var D = (x - 500000) / (N1 * K0);
    var lat = p1 - (N1 * t / R1) * (D * D / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * EP2) * Math.pow(D, 4) / 24 +
      (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * EP2 - 3 * C1 * C1) * Math.pow(D, 6) / 720);
    var lon = lon0 + (D - (1 + 2 * T1 + C1) * Math.pow(D, 3) / 6 + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * EP2 + 24 * T1 * T1) * Math.pow(D, 5) / 120) / c;
    return [lon / DEG, lat / DEG];
  }

  function reproject(x, y, from, to) {
    if (+from === +to) return [x, y];
    var ll = +from === 4326 ? [x, y] : toLonLat(x, y, from);
    return +to === 4326 ? ll : toUtm(ll[0], ll[1], to);
  }

  // ---------- Lohkon geometria ----------
  // Palauttaa monikulmiot muodossa [[rengas, reikä, ...], ...], renkaat [[x,y], ...].
  function polygonsOf(g) {
    if (!g) return [];
    if (g.type === 'FeatureCollection') return g.features.reduce(function (a, f) { return a.concat(polygonsOf(f)); }, []);
    if (g.type === 'Feature') return polygonsOf(g.geometry);
    if (g.type === 'Polygon') return [g.coordinates];
    if (g.type === 'MultiPolygon') return g.coordinates.slice();
    if (g.type === 'GeometryCollection') return g.geometries.reduce(function (a, x) { return a.concat(polygonsOf(x)); }, []);
    return [];
  }

  function mapPolys(polys, fn) {
    return polys.map(function (p) { return p.map(function (r) { return r.map(function (c) { return fn(c[0], c[1]); }); }); });
  }

  function ringArea(r) {
    var s = 0;
    for (var i = 0, j = r.length - 1; i < r.length; j = i++) s += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
    return Math.abs(s / 2);
  }

  /**
   * Lukee lohkon rajauksen GeoJSON-tekstistä tai -oliosta. Koordinaatisto päätellään:
   * astekoordinaatit → WGS84, metrit → ETRS-TM35FIN (EPSG:3067), ellei crs-kenttä kerro muuta.
   */
  function parseField(input) {
    var g = typeof input === 'string' ? JSON.parse(input) : input;
    var polys = polygonsOf(g);
    if (!polys.length) throw new Error('GeoJSONista ei löytynyt monikulmiota (Polygon tai MultiPolygon).');
    var crsName = g.crs && g.crs.properties && g.crs.properties.name || '';
    var m = /EPSG:{1,2}(\d+)/i.exec(crsName);
    var x0 = polys[0][0][0][0], y0 = polys[0][0][0][1];
    var epsg = m ? +m[1] : (Math.abs(x0) <= 180 && Math.abs(y0) <= 90 ? 4326 : 3067);
    if (epsg === 4258 || epsg === 4326 || epsg === 84) epsg = 4326;
    var wgs = epsg === 4326 ? polys : mapPolys(polys, function (x, y) { return toLonLat(x, y, epsg); });
    var tm = mapPolys(wgs, function (lon, lat) { return toUtm(lon, lat, 3067); });
    var area = tm.reduce(function (s, p) { return s + ringArea(p[0]) - p.slice(1).reduce(function (h, r) { return h + ringArea(r); }, 0); }, 0);
    var lons = [], lats = [];
    wgs.forEach(function (p) { p[0].forEach(function (c) { lons.push(c[0]); lats.push(c[1]); }); });
    var props = (g.type === 'Feature' ? g.properties : g.type === 'FeatureCollection' && g.features[0] ? g.features[0].properties : null) || {};
    return {
      polys: wgs,
      geometry: wgs.length === 1 ? { type: 'Polygon', coordinates: wgs[0] } : { type: 'MultiPolygon', coordinates: wgs },
      bbox: [Math.min.apply(null, lons), Math.min.apply(null, lats), Math.max.apply(null, lons), Math.max.apply(null, lats)],
      areaM2: area,
      sourceEpsg: epsg,
      properties: props
    };
  }

  function pointInPolys(x, y, polys) {
    for (var k = 0; k < polys.length; k++) {
      var inside = false;
      polys[k].forEach(function (r) {
        for (var i = 0, j = r.length - 1; i < r.length; j = i++) {
          if ((r[i][1] > y) !== (r[j][1] > y) && x < (r[j][0] - r[i][0]) * (y - r[i][1]) / (r[j][1] - r[i][1]) + r[i][0]) inside = !inside;
        }
      });
      if (inside) return true;
    }
    return false;
  }

  function distToEdges(x, y, polys) {
    var best = Infinity;
    polys.forEach(function (p) {
      p.forEach(function (r) {
        for (var i = 0, j = r.length - 1; i < r.length; j = i++) {
          var ax = r[j][0], ay = r[j][1], bx = r[i][0], by = r[i][1], dx = bx - ax, dy = by - ay;
          var L = dx * dx + dy * dy, t = L ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / L)) : 0;
          var ex = ax + t * dx - x, ey = ay + t * dy - y, d = ex * ex + ey * ey;
          if (d < best) best = d;
        }
      });
    });
    return Math.sqrt(best);
  }

  // ---------- Rasterit ----------
  function epsgOf(image, hint) {
    var k = image.geoKeys || {};
    var e = k.ProjectedCSTypeGeoKey;
    if (e && e !== 32767) return e;
    if (hint) return hint;
    throw new Error('Kuvan koordinaatistoa ei voitu päätellä.');
  }

  /**
   * Lohkon ikkuna ja maski rasterin ruudukossa. Pikseli kuuluu lohkoon, jos sen keskipiste on
   * lohkon sisällä vähintään reunapuskurin etäisyydellä reunasta.
   */
  function fieldWindow(image, epsg, field, bufferM) {
    var o = image.getOrigin(), res = image.getResolution(), W = image.getWidth(), H = image.getHeight();
    var polys = mapPolys(field.polys, function (lon, lat) { return toUtm(lon, lat, epsg); });
    var xs = [], ys = [];
    polys.forEach(function (p) { p[0].forEach(function (c) { xs.push(c[0]); ys.push(c[1]); }); });
    var minx = Math.min.apply(null, xs), maxx = Math.max.apply(null, xs), miny = Math.min.apply(null, ys), maxy = Math.max.apply(null, ys);
    var c0 = Math.max(0, Math.floor((minx - o[0]) / res[0])), c1 = Math.min(W, Math.ceil((maxx - o[0]) / res[0]));
    var r0 = Math.max(0, Math.floor((maxy - o[1]) / res[1])), r1 = Math.min(H, Math.ceil((miny - o[1]) / res[1]));
    if (c1 <= c0 || r1 <= r0) return null;
    var w = c1 - c0, h = r1 - r0, mask = new Uint8Array(w * h), n = 0;
    for (var r = 0; r < h; r++) for (var c = 0; c < w; c++) {
      var x = o[0] + (c0 + c + 0.5) * res[0], y = o[1] + (r0 + r + 0.5) * res[1];
      if (pointInPolys(x, y, polys) && (!bufferM || distToEdges(x, y, polys) >= bufferM)) { mask[r * w + c] = 1; n++; }
    }
    return { window: [c0, r0, c1, r1], w: w, h: h, mask: mask, n: n, origin: o, res: res, epsg: epsg };
  }

  // HLS v2 Fmask: bitti 0 sirrus, 1 pilvi, 2 pilven/varjon vieressä, 3 pilven varjo, 4 lumi/jää,
  // 5 vesi, 6–7 aerosolitaso (11 = korkea). Hylätään 0–4 ja korkea aerosoli.
  function fmaskValid(v) { return (v & 0x1F) === 0 && ((v >> 6) & 3) !== 3; }

  function median(arr) {
    if (!arr.length) return null;
    var a = Float64Array.from(arr).sort(), m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  /**
   * Laskee havainnon tilastot. ndvi: Float32Array (NaN = ei kelvollinen), fw: fieldWindow,
   * prev: edellinen kelvollinen saman perheen havainto (raster) tai null.
   */
  function stats(ndvi, fw, prev, drop) {
    var vals = [], compared = 0, changed = 0;
    for (var i = 0; i < ndvi.length; i++) {
      if (!fw.mask[i] || isNaN(ndvi[i])) continue;
      vals.push(ndvi[i]);
      if (prev) {
        var r = Math.floor(i / fw.w), c = i - r * fw.w;
        var x = fw.origin[0] + (fw.window[0] + c + 0.5) * fw.res[0], y = fw.origin[1] + (fw.window[1] + r + 0.5) * fw.res[1];
        var q = reproject(x, y, fw.epsg, prev.fw.epsg);
        var pc = Math.floor((q[0] - prev.fw.origin[0]) / prev.fw.res[0]) - prev.fw.window[0];
        var pr = Math.floor((q[1] - prev.fw.origin[1]) / prev.fw.res[1]) - prev.fw.window[1];
        if (pc >= 0 && pr >= 0 && pc < prev.fw.w && pr < prev.fw.h) {
          var pv = prev.ndvi[pr * prev.fw.w + pc];
          if (!isNaN(pv)) { compared++; if (pv - ndvi[i] >= drop) changed++; }
        }
      }
    }
    var med = median(vals);
    return {
      value: med == null ? null : Math.round(med * 1000) / 1000,
      valid: fw.n ? Math.round(vals.length / fw.n * 100) : 0,
      changed: compared >= Math.max(3, vals.length * 0.5) ? Math.round(changed / compared * 100) : null,
      nValid: vals.length
    };
  }

  // ---------- Verkko ----------
  function netError(e, service) {
    if (e && e.name === 'TypeError') {
      return new Error(service + ': yhteys epäonnistui. Syy voi olla verkkoyhteys tai se, että palvelu ei salli kutsua selaimesta (CORS). ' +
        'Käytä silloin skriptiä scripts/hae_havainnot.py ja tuo tulos CSV:nä.');
    }
    return e;
  }

  async function getJson(url, opts, service) {
    var r;
    try { r = await fetch(url, opts); } catch (e) { throw netError(e, service); }
    if (!r.ok) {
      var body = ''; try { body = (await r.text()).slice(0, 300); } catch (e) { /* tyhjä */ }
      var msg = service + ': HTTP ' + r.status;
      if (r.status === 401 || r.status === 403) msg += ' – tarkista API-avain ja käyttöoikeudet';
      if (r.status === 429) msg += ' – liikaa pyyntöjä, yritä hetken päästä';
      throw new Error(msg + (body ? ' (' + body + ')' : ''));
    }
    return r.json();
  }

  async function pool(items, n, fn, signal) {
    var out = new Array(items.length), next = 0;
    async function worker() {
      while (next < items.length) {
        if (signal && signal.aborted) throw new Error('Haku keskeytettiin.');
        var i = next++;
        out[i] = await fn(items[i], i);
      }
    }
    var ws = []; for (var k = 0; k < Math.min(n, items.length); k++) ws.push(worker());
    await Promise.all(ws);
    return out;
  }

  function dateOf(s) { return String(s).slice(0, 10); }

  // Valitsee päivää ja sensoriperhettä kohden kuvan, jossa on eniten kelvollisia pikseleitä,
  // ja laskee muuttuneen osuuden edellisestä kelvollisesta havainnosta.
  // Kuvat, joissa lohkolla ei ole yhtään kelvollista pikseliä, palautetaan arvolla null ja
  // kelvollisuudella 0 %, jotta ne näkyvät pois jätettyjen listassa eivätkä katoa hiljaa.
  function finalize(raw, opts) {
    var byDay = {};
    raw.forEach(function (o) {
      if (!o) return;
      var k = o.fam + '|' + o.date, cur = byDay[k];
      if (!cur || (cur.value == null && o.value != null) || (o.value != null && o.nValid > cur.nValid)) byDay[k] = o;
    });
    var list = Object.keys(byDay).map(function (k) { return byDay[k]; }).sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    var prev = {};
    return list.map(function (o) {
      if (o.value == null) return { date: o.date, src: o.src, id: o.id, value: null, valid: 0, changed: null };
      var s = stats(o.ndvi, o.fw, prev[o.fam] || null, opts.ndviDrop);
      if (s.valid >= opts.minValid) prev[o.fam] = o;
      return { date: o.date, src: o.src, id: o.id, value: s.value, valid: s.valid, changed: s.changed };
    });
  }

  function defaults(opts) {
    opts = opts || {};
    return {
      bufferM: opts.bufferM == null ? 10 : opts.bufferM,
      ndviDrop: opts.ndviDrop == null ? 0.12 : opts.ndviDrop,
      minValid: opts.minValid == null ? 50 : opts.minValid,
      maxCloud: opts.maxCloud == null ? 90 : opts.maxCloud,
      concurrency: opts.concurrency || 4,
      signal: opts.signal || null,
      onProgress: opts.onProgress || function () {}
    };
  }

  // ---------- HLS (Planetary Computer) ----------
  var HLS_BANDS = { 'hls2-s30': { red: 'B04', nir: 'B8A', src: 'HLS-S30' }, 'hls2-l30': { red: 'B04', nir: 'B05', src: 'HLS-L30' } };

  async function hlsSearch(field, start, end, opts) {
    var o = defaults(opts), items = [];
    var body = {
      collections: Object.keys(HLS_BANDS), intersects: field.geometry,
      datetime: start + 'T00:00:00Z/' + end + 'T23:59:59Z', limit: 250,
      query: { 'eo:cloud_cover': { lte: o.maxCloud } }
    };
    var url = PC_STAC + '/search', req = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    for (var page = 0; page < 20 && url; page++) {
      var js = await getJson(url, req, 'Planetary Computer (HLS-haku)');
      items = items.concat(js.features || []);
      var nx = (js.links || []).filter(function (l) { return l.rel === 'next'; })[0];
      if (!nx) break;
      url = nx.href;
      req = nx.method === 'POST' ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({}, body, nx.body || {})) } : {};
    }
    return items;
  }

  var sasCache = {};
  async function signHref(href) {
    var m = /^https:\/\/([^.]+)\.blob\.core\.windows\.net\/([^/?]+)/.exec(href);
    if (!m) return href;
    var key = m[1] + '/' + m[2], c = sasCache[key];
    // Lupaus tallennetaan heti, jotta rinnakkaiset haut käyttävät samaa tokenia.
    if (!c || (c.expiry && Date.parse(c.expiry) - Date.now() < 5 * 60e3)) {
      c = sasCache[key] = { expiry: null, p: getJson(PC_SAS + '/' + key, {}, 'Planetary Computer (SAS-token)') };
      c.p.then(function (js) { c.expiry = js['msft:expiry'] || new Date(Date.now() + 30 * 60e3).toISOString(); },
        function () { if (sasCache[key] === c) delete sasCache[key]; });
    }
    var js = await c.p;
    return href + (href.indexOf('?') >= 0 ? '&' : '?') + js.token;
  }

  async function openTiff(url, service) {
    try { return await GT.fromUrl(url, { allowFullFile: false }); } catch (e) { throw netError(e, service); }
  }

  function epsgHint(item) {
    var p = item.properties || {};
    if (p['proj:epsg']) return +p['proj:epsg'];
    var m = /EPSG:(\d+)/.exec(p['proj:code'] || ''); return m ? +m[1] : null;
  }

  async function hlsItem(item, field, o) {
    var b = HLS_BANDS[item.collection];
    if (!b) return null;
    var a = item.assets || {};
    if (!a[b.red] || !a[b.nir] || !a.Fmask) throw new Error('HLS-kuvasta ' + item.id + ' puuttuu kaista (' + b.red + ', ' + b.nir + ' tai Fmask).');
    var urls = await Promise.all([a[b.red].href, a[b.nir].href, a.Fmask.href].map(signHref));
    var tiffs = await Promise.all(urls.map(function (u) { return openTiff(u, 'Planetary Computer (HLS-kuva)'); }));
    var imgs = await Promise.all(tiffs.map(function (t) { return t.getImage(); }));
    var epsg = epsgOf(imgs[0], epsgHint(item));
    var fw = fieldWindow(imgs[0], epsg, field, o.bufferM);
    if (!fw || !fw.n) return null;
    var rs = await Promise.all(imgs.map(function (im) { return im.readRasters({ window: fw.window, samples: [0] }); }));
    var red = rs[0][0], nir = rs[1][0], fm = rs[2][0], ndvi = new Float32Array(fw.w * fw.h);
    for (var i = 0; i < ndvi.length; i++) {
      var R = red[i], N = nir[i];
      ndvi[i] = fw.mask[i] && fmaskValid(fm[i]) && R > 0 && N > 0 && R !== -9999 && N !== -9999 ? (N - R) / (N + R) : NaN;
    }
    var st = stats(ndvi, fw, null, 0);
    return { date: dateOf(item.properties.datetime), src: b.src, fam: 'HLS', id: item.id, ndvi: ndvi, fw: fw, value: st.value, nValid: st.nValid };
  }

  /** Hakee ja laskee HLS-havainnot. Palauttaa { obs, searched, skipped }. */
  async function fetchHls(field, start, end, opts) {
    var o = defaults(opts);
    o.onProgress('Haetaan HLS-kuvalista Planetary Computerista…');
    var items = await hlsSearch(field, start, end, o);
    o.onProgress('Löytyi ' + items.length + ' HLS-kuvaa. Luetaan lohkon pikselit…', 0, items.length);
    var done = 0, skipped = [];
    var raw = await pool(items, o.concurrency, async function (it) {
      var r = null;
      try { r = await hlsItem(it, field, o); } catch (e) { skipped.push(it.id + ': ' + e.message); }
      done++; o.onProgress('HLS: ' + done + '/' + items.length + ' kuvaa käsitelty', done, items.length);
      return r;
    }, o.signal);
    return { obs: finalize(raw, o), searched: items.length, skipped: skipped };
  }

  // ---------- Sentinel-2 L2A (Planetary Computer) ----------
  // Pelkkä Sentinel-2 ilman HLS:n harmonisointia: 10 m punainen (B04) ja NIR (B08), pilvet
  // Scene Classification -kerroksesta (SCL, 20 m). Kelvollisia luokkia ovat 4 kasvillisuus ja
  // 5 paljas maa. Luokka 6 (vesi) hylätään: pellolla se on yleensä pilven varjo tai märkä usva.
  // Lisäksi sininen kanava (B02) hylkää ohuen pilven ja usvan, jota SCL ei tunnista:
  // kasvillisuuden ja sängen pintaheijastus sinisellä on alle 0,10. Planetary Computerissa ei ole
  // pilvitodennäköisyyskerrosta (MSK_CLDPRB), joten sinistä kanavaa käytetään sen sijaan.
  var S2_COLL = 'sentinel-2-l2a';
  var S2_BLUE_MAX = 0.10;
  function sclValid(v) { return v === 4 || v === 5; }
  // Prosessointiversiosta 04.00 alkaen (25.1.2022) L2A-arvoissa on +1000 siirtymä (BOA_ADD_OFFSET).
  function s2Offset(item) {
    var b = parseFloat((item.properties || {})['s2:processing_baseline']);
    if (!isNaN(b)) return b >= 4 ? 1000 : 0;
    return dateOf((item.properties || {}).datetime) >= '2022-01-25' ? 1000 : 0;
  }

  async function s2Search(field, start, end, opts) {
    var o = defaults(opts), items = [];
    var body = {
      collections: [S2_COLL], intersects: field.geometry,
      datetime: start + 'T00:00:00Z/' + end + 'T23:59:59Z', limit: 250,
      query: { 'eo:cloud_cover': { lte: o.maxCloud } }
    };
    var url = PC_STAC + '/search', req = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
    for (var page = 0; page < 20 && url; page++) {
      var js = await getJson(url, req, 'Planetary Computer (Sentinel-2-haku)');
      items = items.concat(js.features || []);
      var nx = (js.links || []).filter(function (l) { return l.rel === 'next'; })[0];
      if (!nx) break;
      url = nx.href;
      req = nx.method === 'POST' ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({}, body, nx.body || {})) } : {};
    }
    return items;
  }

  async function s2Item(item, field, o) {
    var a = item.assets || {};
    if (!a.B04 || !a.B08 || !a.SCL) throw new Error('Sentinel-2-kuvasta ' + item.id + ' puuttuu kaista (B04, B08 tai SCL).');
    var hasBlue = !!a.B02;
    var urls = await Promise.all([a.B04.href, a.B08.href, a.SCL.href].concat(hasBlue ? [a.B02.href] : []).map(signHref));
    var tiffs = await Promise.all(urls.map(function (u) { return openTiff(u, 'Planetary Computer (Sentinel-2-kuva)'); }));
    var imgs = await Promise.all(tiffs.map(function (t) { return t.getImage(); }));
    var epsg = epsgOf(imgs[0], epsgHint(item));
    var fw = fieldWindow(imgs[0], epsg, field, o.bufferM);
    if (!fw || !fw.n) return null;
    var rs = await Promise.all([imgs[0], imgs[1]].concat(hasBlue ? [imgs[3]] : []).map(function (im) { return im.readRasters({ window: fw.window, samples: [0] }); }));
    // SCL on karkeammassa ruudukossa: luetaan sama alue ja haetaan kullekin 10 m pikselille sen 20 m solu.
    var sImg = imgs[2], sRes = sImg.getResolution(), sOri = sImg.getOrigin();
    var x0 = fw.origin[0] + fw.window[0] * fw.res[0], y0 = fw.origin[1] + fw.window[1] * fw.res[1];
    var x1 = fw.origin[0] + fw.window[2] * fw.res[0], y1 = fw.origin[1] + fw.window[3] * fw.res[1];
    var sc0 = Math.max(0, Math.floor((x0 - sOri[0]) / sRes[0])), sr0 = Math.max(0, Math.floor((y0 - sOri[1]) / sRes[1]));
    var sc1 = Math.min(sImg.getWidth(), Math.ceil((x1 - sOri[0]) / sRes[0])), sr1 = Math.min(sImg.getHeight(), Math.ceil((y1 - sOri[1]) / sRes[1]));
    var sw = sc1 - sc0, scl = (await sImg.readRasters({ window: [sc0, sr0, sc1, sr1], samples: [0] }))[0];
    var red = rs[0][0], nir = rs[1][0], blue = hasBlue ? rs[2][0] : null, off = s2Offset(item), ndvi = new Float32Array(fw.w * fw.h);
    var blueMax = (o.blueMax != null ? o.blueMax : S2_BLUE_MAX) * 10000;
    for (var i = 0; i < ndvi.length; i++) {
      if (!fw.mask[i]) { ndvi[i] = NaN; continue; }
      var r = Math.floor(i / fw.w), c = i - r * fw.w;
      var x = fw.origin[0] + (fw.window[0] + c + 0.5) * fw.res[0], y = fw.origin[1] + (fw.window[1] + r + 0.5) * fw.res[1];
      var qc = Math.floor((x - sOri[0]) / sRes[0]) - sc0, qr = Math.floor((y - sOri[1]) / sRes[1]) - sr0;
      var sv = qc >= 0 && qr >= 0 && qc < sw && qr < sr1 - sr0 ? scl[qr * sw + qc] : 0;
      var R = red[i] - off, N = nir[i] - off;
      var hazy = blue && blue[i] - off > blueMax;
      ndvi[i] = sclValid(sv) && !hazy && red[i] > 0 && nir[i] > 0 && R > 0 && N > 0 ? (N - R) / (N + R) : NaN;
    }
    var st = stats(ndvi, fw, null, 0);
    return { date: dateOf(item.properties.datetime), src: 'Sentinel-2', fam: 'S2', id: item.id, ndvi: ndvi, fw: fw, value: st.value, nValid: st.nValid };
  }

  /** Hakee ja laskee Sentinel-2 L2A -havainnot. Palauttaa { obs, searched, skipped }. */
  async function fetchS2(field, start, end, opts) {
    var o = defaults(opts);
    o.onProgress('Haetaan Sentinel-2-kuvalista Planetary Computerista…');
    var items = await s2Search(field, start, end, o);
    o.onProgress('Löytyi ' + items.length + ' Sentinel-2-kuvaa. Luetaan lohkon pikselit…', 0, items.length);
    var done = 0, skipped = [];
    var raw = await pool(items, o.concurrency, async function (it) {
      var r = null;
      try { r = await s2Item(it, field, o); } catch (e) { skipped.push(it.id + ': ' + e.message); }
      done++; o.onProgress('Sentinel-2: ' + done + '/' + items.length + ' kuvaa käsitelty', done, items.length);
      return r;
    }, o.signal);
    return { obs: finalize(raw, o), searched: items.length, skipped: skipped };
  }


  // ---------- Sentinel-1 (Copernicus Data Space Ecosystem, Statistical API) ----------
  // Ruokavirasto käyttää Sentinel-1:n takaisinsirontaa ja 12 vrk koherenssia. Selaimesta saatavilla on
  // takaisinsironta: CDSE laskee maastokorjatun γ⁰-arvon (GAMMA0_TERRAIN) ja palauttaa lohkon
  // keskiarvon kuvauspäivittäin. Nousevat ja laskevat radat haetaan erikseen, koska kuvausgeometria
  // muuttaa tasoa. Koherenssia CDSE ei laske; sen voi tuoda CSV:nä (lähde "Sentinel-1 koherenssi").
  var S1_EVAL = '//VERSION=3\nfunction setup(){return{input:[{bands:["VV","VH","dataMask"]}],' +
    'output:[{id:"s1",bands:2,sampleType:"FLOAT32"},{id:"dataMask",bands:1}]}}\n' +
    'function evaluatePixel(s){return{s1:[s.VV,s.VH],dataMask:[s.dataMask]}}';
  var cdseCache = {};

  function jwtExp(tok) {
    try {
      var b = tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
      var js = JSON.parse(typeof atob === 'function' ? atob(b) : Buffer.from(b, 'base64').toString('utf8'));
      return js.exp ? js.exp * 1000 : null;
    } catch (e) { return null; }
  }

  // Suora kutsu; jos selain estää sen (CORS tai verkko) ja välityspalvelin on annettu, yritetään sen kautta.
  async function cdseFetch(url, path, req, service, proxy) {
    try { return await getJson(url, req, service); } catch (e) {
      if (!proxy || !(e && /yhteys epäonnistui/.test(e.message))) throw e;
      return getJson(proxy.replace(/\/+$/, '') + '/cdse/' + path, req, service + ' välityspalvelimen kautta');
    }
  }

  async function cdseToken(id, secret, opts) {
    if (!id || !secret) throw new Error('Syötä Copernicus Data Space -tunnuksen client id ja client secret. Ohjeet: Tunnukset ja ohjeet.');
    var c = cdseCache[id];
    if (c && c.secret === secret && (!c.exp || c.exp - Date.now() > 60e3)) return c.p;
    var body = 'grant_type=client_credentials&client_id=' + encodeURIComponent(id) + '&client_secret=' + encodeURIComponent(secret);
    c = cdseCache[id] = { secret: secret, exp: null, p: null };
    c.p = cdseFetch(CDSE_TOKEN, 'token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body },
      'Copernicus Data Space (tunnus)', opts && opts.proxy).then(function (js) {
      if (!js.access_token) throw new Error('Copernicus Data Space ei palauttanut tokenia.');
      c.exp = jwtExp(js.access_token) || (Date.now() + (js.expires_in || 600) * 1000);
      return js.access_token;
    });
    c.p.catch(function () { if (cdseCache[id] === c) delete cdseCache[id]; });
    return c.p;
  }

  function utmEpsgFor(field) {
    var lon = (field.bbox[0] + field.bbox[2]) / 2;
    return 32600 + Math.min(60, Math.max(1, Math.floor((lon + 180) / 6) + 1));
  }

  function s1Geometry(field) {
    var epsg = utmEpsgFor(field);
    var polys = mapPolys(field.polys, function (lon, lat) { return toUtm(lon, lat, epsg); });
    return { epsg: epsg, geometry: polys.length === 1 ? { type: 'Polygon', coordinates: polys[0] } : { type: 'MultiPolygon', coordinates: polys } };
  }

  // Aikaväli päättyy loppupäivää seuraavan vuorokauden alkuun, jotta viimeinen P1D-väli ei jää vajaaksi
  // (Statistical API ohittaa vajaan viimeisen välin oletuksena).
  function nextDay(d) { return new Date(Date.parse(d + 'T00:00:00Z') + 864e5).toISOString().slice(0, 10); }

  function s1Request(field, start, end, dir) {
    var g = s1Geometry(field);
    return {
      input: {
        bounds: { geometry: g.geometry, properties: { crs: 'http://www.opengis.net/def/crs/EPSG/0/' + g.epsg } },
        data: [{ type: 'sentinel-1-grd',
          dataFilter: { acquisitionMode: 'IW', polarization: 'DV', resolution: 'HIGH', orbitDirection: dir },
          processing: { backCoeff: 'GAMMA0_TERRAIN', orthorectify: true, demInstance: 'COPERNICUS_30' } }]
      },
      aggregation: { timeRange: { from: start + 'T00:00:00Z', to: nextDay(end) + 'T00:00:00Z' }, aggregationInterval: { of: 'P1D', lastIntervalBehavior: 'SHORTEN' },
        evalscript: S1_EVAL, resx: 10, resy: 10 },
      calculations: { default: {} }
    };
  }

  // ---------- Sentinel-1: kuvausgeometria Catalog API:sta ----------
  // Saman suunnan (ASC/DESC) kuvauksia tulee Suomessa useilta suhteellisilta radoilta, joiden tulokulma
  // eroaa. Takaisinsirontaa verrataan vain saman radan kuvauksiin. Rata luetaan kuvan tiedoista
  // (sat:relative_orbit). Jos sitä ei ole, radat erotetaan kuvausajan kellonajasta: sama rata ohittaa
  // lohkon samaan aikaan (± muutama sekunti) 6–12 vrk välein riippumatta satelliitista.
  function catalogBody(field, start, end, next) {
    var b = { collections: ['sentinel-1-grd'], datetime: start + 'T00:00:00Z/' + nextDay(end) + 'T00:00:00Z', intersects: field.geometry, limit: 100 };
    if (next != null) b.next = next;
    return b;
  }

  async function s1Catalog(field, start, end, tok, o) {
    var feats = [], next = null;
    for (var page = 0; page < 20; page++) {
      var js = await cdseFetch(CDSE_CATALOG, 'catalog', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
        body: JSON.stringify(catalogBody(field, start, end, next)) }, 'Copernicus Data Space (Sentinel-1-luettelo)', o.proxy);
      feats = feats.concat(js.features || []);
      next = js.context && js.context.next != null ? js.context.next : null;
      if (next == null) break;
    }
    return feats.filter(function (f) {
      var p = f.properties || {}, mode = p['sar:instrument_mode'], pol = p['sar:polarizations'] || p['s1:polarization'];
      return (!mode || mode === 'IW') && (!pol || String(pol).indexOf('VH') >= 0);
    }).map(function (f) {
      var p = f.properties || {}, dt = String(p.datetime || ''), st = String(p['sat:orbit_state'] || '').toUpperCase();
      return { date: dt.slice(0, 10), min: (+dt.slice(11, 13)) * 60 + (+dt.slice(14, 16)) + (+dt.slice(17, 19) || 0) / 60, dir: /^ASC/.test(st) ? 'ASCENDING' : /^DESC/.test(st) ? 'DESCENDING' : null,
        rel: p['sat:relative_orbit'] != null ? +p['sat:relative_orbit'] : null, platform: p.platform || p['sat:platform'] || null };
    }).filter(function (a) { return a.date && a.dir; });
  }

  function hhmm(m) { m = Math.round(m); return ('0' + Math.floor(m / 60) % 24).slice(-2) + ':' + ('0' + m % 60).slice(-2); }

  /** Antaa kullekin (päivä, suunta) -parille rataleiman: "rata 87" tai "klo 16:05". Kellonajat ryhmitellään ± 3 min. */
  function s1Tracks(acq) {
    var byDir = {}, out = {};
    acq.forEach(function (a) { (byDir[a.dir] = byDir[a.dir] || []).push(a); });
    Object.keys(byDir).forEach(function (dir) {
      var list = byDir[dir].slice().sort(function (a, b) { return a.min - b.min; }), clusters = [];
      list.forEach(function (a) {
        var c = clusters[clusters.length - 1];
        if (c && a.min - c.last <= 3) { c.items.push(a); c.last = a.min; } else clusters.push({ first: a.min, last: a.min, items: [a] });
      });
      clusters.forEach(function (c) {
        var mid = (c.first + c.last) / 2;
        c.items.forEach(function (a) {
          var label = a.rel != null ? 'rata ' + a.rel : 'klo ' + hhmm(mid), k = a.date + '|' + dir, cur = out[k];
          // sama päivä ja suunta kahdelta radalta: päivän mosaiikki sekoittaa geometrioita
          out[k] = cur && cur !== label ? 'sekoitus' : label;
        });
      });
    });
    return out;
  }

  function db(x) { return 10 * Math.log10(x); }

  /** Muuntaa Statistical API -vastauksen havainnoiksi (lähde "Sentinel-1 VH", arvo dB). tracks: s1Tracks-tulos. */
  function s1Parse(js, dir, opts, tracks) {
    var obs = [], skipped = [], tag = dir === 'ASCENDING' ? 'ASC' : 'DESC', minValid = opts && opts.minValid != null ? opts.minValid : 50;
    (js.data || []).forEach(function (d) {
      var date = dateOf(d.interval && d.interval.from);
      if (d.error) { skipped.push(date + ' ' + tag + ': ' + (d.error.message || d.error.type || 'virhe')); return; }
      var b = d.outputs && d.outputs.s1 && d.outputs.s1.bands;
      var vv = b && b.B0 && b.B0.stats, vh = b && b.B1 && b.B1.stats;
      if (!vv || !vh) return;
      var n = vh.sampleCount || 0, nd = vh.noDataCount || 0, valid = n ? Math.round((n - nd) / n * 100) : 0;
      var mVh = +vh.mean, mVv = +vv.mean;
      if (!(n - nd > 0) || !isFinite(mVh) || !(mVh > 0)) return;   // ei kuvausta tänä päivänä
      if (valid < minValid) { skipped.push(date + ' ' + tag + ': kelvollisia pikseleitä ' + valid + ' %'); return; }
      var tr = tracks && tracks[date + '|' + dir];
      if (tr === 'sekoitus') { skipped.push(date + ' ' + tag + ': kaksi rataa samana päivänä, kuvausgeometria sekoittuu'); return; }
      var vvDb = isFinite(mVv) && mVv > 0 ? Math.round(db(mVv) * 100) / 100 : null;
      obs.push({ date: date, src: 'Sentinel-1 VH', id: 'S1 GRD ' + tag + (tr ? ' ' + tr : '') + ' ' + date + (vvDb != null ? ' VV ' + vvDb.toFixed(2) + ' dB' : ''),
        value: Math.round(db(mVh) * 100) / 100, valid: valid, changed: null, vv: vvDb, track: tag + (tr ? ' ' + tr : ''), pixels: n - nd });
    });
    return { obs: obs, skipped: skipped };
  }

  /**
   * Hakee Sentinel-1 VH/VV-takaisinsironnan lohkon keskiarvona kuvauspäivittäin ja radoittain.
   * creds: { id, secret } (CDSE OAuth -asiakas). opts.proxy: välityspalvelimen osoite CORS-esteen varalle.
   * Palauttaa { obs, searched, skipped, tracks: [{ track, n }], pixels, notes }.
   */
  async function fetchS1(field, start, end, creds, opts) {
    var o = defaults(opts); o.proxy = opts && opts.proxy;
    o.onProgress('Haetaan Sentinel-1-tunnus Copernicus Data Spacesta…');
    var tok = await cdseToken(creds && creds.id, creds && creds.secret, o);
    var obs = [], skipped = [], notes = [], tracks = null, done = 0;
    o.onProgress('Sentinel-1: haetaan kuvausluettelo ja radat…', 0, 3);
    try { tracks = s1Tracks(await s1Catalog(field, start, end, tok, o)); }
    catch (e) { notes.push('Ratatietoa ei saatu (' + e.message + '), joten kuvaukset erotellaan vain suunnan (ASC/DESC) mukaan.'); }
    for (var dir of ['ASCENDING', 'DESCENDING']) {
      if (o.signal && o.signal.aborted) throw new Error('Haku keskeytettiin.');
      o.onProgress('Sentinel-1: lasketaan lohkon takaisinsironta (' + (dir === 'ASCENDING' ? 'nousevat' : 'laskevat') + ' radat)…', ++done, 3);
      var js = await cdseFetch(CDSE_STATS, 'statistics', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
        body: JSON.stringify(s1Request(field, start, end, dir)) }, 'Copernicus Data Space (Sentinel-1)', o.proxy);
      var r = s1Parse(js, dir, o, tracks);
      obs = obs.concat(r.obs); skipped = skipped.concat(r.skipped);
    }
    obs.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : a.id < b.id ? -1 : 1; });
    var cnt = {};
    obs.forEach(function (x) { cnt[x.track] = (cnt[x.track] || 0) + 1; });
    var trackList = Object.keys(cnt).sort().map(function (k) { return { track: k, n: cnt[k] }; });
    var px = obs.length ? Math.round(median(obs.map(function (x) { return x.pixels; }))) : 0;
    if (obs.length && px < S1_MIN_PIXELS) notes.push('Lohkolla on vain noin ' + px + ' tutkapikseliä (10 m). Speckle-kohina on pienellä lohkolla suuri, joten tutkan muutokset ovat epävarmoja.');
    var short = trackList.filter(function (t) { return t.n < 4; }).length;
    if (short) notes.push(short + ' radalla on alle 4 kuvausta; niiden muutoksia ei voi verrata trendiin.');
    return { obs: obs, searched: obs.length + skipped.length, skipped: skipped, tracks: trackList, pixels: px, notes: notes };
  }

  // ---------- PlanetScope ----------
  function plAuth(key) {
    var b = typeof btoa === 'function' ? btoa(key + ':') : Buffer.from(key + ':').toString('base64');
    return { Authorization: 'Basic ' + b };
  }

  /** Hakee PlanetScope-kuvat ja valitsee päivää kohden selkeimmän. */
  async function psSearch(key, field, start, end, opts) {
    var o = defaults(opts);
    if (!key) throw new Error('Planet-API-avain puuttuu.');
    var body = {
      item_types: ['PSScene'],
      filter: { type: 'AndFilter', config: [
        { type: 'GeometryFilter', field_name: 'geometry', config: field.geometry },
        { type: 'DateRangeFilter', field_name: 'acquired', config: { gte: start + 'T00:00:00Z', lte: end + 'T23:59:59Z' } },
        { type: 'RangeFilter', field_name: 'cloud_cover', config: { lte: Math.min(1, o.maxCloud / 100) } },
        { type: 'AssetFilter', config: ['ortho_analytic_4b_sr'] },
        { type: 'PermissionFilter', config: ['assets:download'] }
      ] }
    };
    var hdr = Object.assign({ 'Content-Type': 'application/json' }, plAuth(key));
    var js = await getJson(PL_DATA + '/quick-search?_page_size=250', { method: 'POST', headers: hdr, body: JSON.stringify(body) }, 'Planet Data API');
    var feats = js.features || [];
    for (var page = 0; page < 20 && js._links && js._links._next; page++) {
      js = await getJson(js._links._next, { headers: plAuth(key) }, 'Planet Data API');
      feats = feats.concat(js.features || []);
    }
    var best = {};
    feats.forEach(function (f) {
      var p = f.properties || {}, d = dateOf(p.acquired);
      var score = p.clear_percent != null ? p.clear_percent : 100 * (1 - (p.cloud_cover || 0));
      if (!best[d] || score > best[d].score) best[d] = { id: f.id, date: d, score: score, instrument: p.instrument };
    });
    var chosen = Object.keys(best).sort().map(function (d) { return best[d]; });
    return { all: feats.length, chosen: chosen, areaKm2: field.areaM2 / 1e6, estimateKm2: chosen.length * field.areaM2 / 1e6 };
  }

  async function psOrder(key, field, ids, name) {
    if (!ids.length) throw new Error('Ei tilattavia kuvia.');
    var body = {
      name: name || 'Niittoraportti',
      products: [{ item_ids: ids, item_type: 'PSScene', product_bundle: 'analytic_sr_udm2' }],
      tools: [{ clip: { aoi: field.geometry } }, { harmonize: { target_sensor: 'Sentinel-2' } }]
    };
    var hdr = Object.assign({ 'Content-Type': 'application/json' }, plAuth(key));
    var js = await getJson(PL_ORDERS, { method: 'POST', headers: hdr, body: JSON.stringify(body) }, 'Planet Orders API');
    return js.id;
  }

  async function psOrderStatus(key, id) {
    var js = await getJson(PL_ORDERS + '/' + encodeURIComponent(id), { headers: plAuth(key) }, 'Planet Orders API');
    var res = (js._links && js._links.results) || [];
    return { state: js.state, results: res, message: js.error_hints || js.last_message || '' };
  }

  async function fetchBuffer(url, service) {
    var r;
    try { r = await fetch(url); } catch (e) { throw netError(e, service); }
    if (!r.ok) throw new Error(service + ': HTTP ' + r.status);
    return r.arrayBuffer();
  }

  /** Laskee valmiin tilauksen tuloksista PlanetScope-havainnot. */
  async function psProcess(results, field, ids, opts) {
    var o = defaults(opts), pairs = {};
    results.forEach(function (r) {
      var nm = r.name || '';
      if (!/\.tif$/i.test(nm)) return;
      var id = ids.filter(function (x) { return nm.indexOf(x) >= 0; })[0] || (/(\d{8}_\d{6}_\d+_[0-9a-f]{4})/.exec(nm) || [])[1];
      if (!id) return;
      pairs[id] = pairs[id] || { id: id };
      if (/udm2/i.test(nm)) pairs[id].udm = r.location;
      else if (/AnalyticMS_SR/i.test(nm)) pairs[id].sr = r.location;
    });
    var list = Object.keys(pairs).map(function (k) { return pairs[k]; }).filter(function (p) { return p.sr && p.udm; });
    o.onProgress('Käsitellään ' + list.length + ' PlanetScope-kuvaa…', 0, list.length);
    var done = 0, skipped = [];
    var raw = await pool(list, Math.min(o.concurrency, 3), async function (p) {
      var out = null;
      try {
        var bufs = await Promise.all([fetchBuffer(p.sr, 'Planet (lataus)'), fetchBuffer(p.udm, 'Planet (lataus)')]);
        var sr = await (await GT.fromArrayBuffer(bufs[0])).getImage();
        var udm = await (await GT.fromArrayBuffer(bufs[1])).getImage();
        var epsg = epsgOf(sr);
        var fw = fieldWindow(sr, epsg, field, o.bufferM);
        if (fw && fw.n) {
          var a = await sr.readRasters({ window: fw.window, samples: [2, 3] });
          var u = await udm.readRasters({ window: fw.window, samples: [0] });
          var ndvi = new Float32Array(fw.w * fw.h);
          for (var i = 0; i < ndvi.length; i++) {
            var R = a[0][i], N = a[1][i];
            ndvi[i] = fw.mask[i] && u[0][i] === 1 && R > 0 && N > 0 ? (N - R) / (N + R) : NaN;
          }
          var st = stats(ndvi, fw, null, 0);
          out = { date: p.id.slice(0, 4) + '-' + p.id.slice(4, 6) + '-' + p.id.slice(6, 8), src: 'PlanetScope', fam: 'PS', id: p.id, ndvi: ndvi, fw: fw, value: st.value, nValid: st.nValid };
        }
      } catch (e) { skipped.push(p.id + ': ' + e.message); }
      done++; o.onProgress('PlanetScope: ' + done + '/' + list.length + ' kuvaa käsitelty', done, list.length);
      return out;
    }, o.signal);
    return { obs: finalize(raw, o), skipped: skipped };
  }

  var api = {
    parseField: parseField, toUtm: toUtm, toLonLat: toLonLat, reproject: reproject,
    pointInPolys: pointInPolys, distToEdges: distToEdges, fieldWindow: fieldWindow,
    fmaskValid: fmaskValid, median: median, stats: stats, finalize: finalize,
    hlsSearch: hlsSearch, fetchHls: fetchHls, signHref: signHref,
    s2Search: s2Search, fetchS2: fetchS2, sclValid: sclValid, s2Offset: s2Offset,
    fetchS1: fetchS1, s1Request: s1Request, s1Parse: s1Parse, s1Tracks: s1Tracks, s1Catalog: s1Catalog, cdseToken: cdseToken, _clearCdse: function () { cdseCache = {}; },
    psSearch: psSearch, psOrder: psOrder, psOrderStatus: psOrderStatus, psProcess: psProcess,
    _setGeoTIFF: function (g) { GT = g; }, _clearSas: function () { sasCache = {}; },
    ENDPOINTS: { PC_STAC: PC_STAC, PC_SAS: PC_SAS, PL_DATA: PL_DATA, PL_ORDERS: PL_ORDERS, CDSE_TOKEN: CDSE_TOKEN, CDSE_STATS: CDSE_STATS, CDSE_CATALOG: CDSE_CATALOG }
  };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.NiittoHaku = api;
})(typeof self !== 'undefined' ? self : this);
