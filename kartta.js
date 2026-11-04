/*
 * Niittoraportti – lohkon valinta kartalta.
 *
 * Taustakartta: Maanmittauslaitoksen avoin karttakuvapalvelu (WMTS, API-avain, CC BY 4.0).
 * Ilman avainta käytetään OpenStreetMapia.
 * Lohkot: Ruokaviraston INSPIRE-WMS, kasvulohkot (GSAAAgriculturalParcel.<vuosi>, CC BY 4.0).
 * Klikkaus hakee lohkon rajauksen ja tiedot GetFeatureInfo-kutsulla (application/json).
 * Jos palvelu ei salli kutsua selaimesta, rajauksen voi piirtää käsin.
 *
 * Puhtaat apufunktiot (osoitteet, vastauksen tulkinta) ovat testattavissa Nodessa;
 * karttaosa käyttää Leafletia (vendor/leaflet) ja vain selaimessa.
 */
(function (root) {
  'use strict';

  var MML = 'https://avoin-karttakuva.maanmittauslaitos.fi/avoin/wmts/1.0.0/';
  var RV_WMS = 'https://inspire.ruokavirasto-awsa.com/geoserver/wms';
  var MML_LAYERS = {
    taustakartta: { title: 'MML taustakartta', ext: 'png' },
    ortokuva: { title: 'MML ortokuva', ext: 'jpg' },
    maastokartta: { title: 'MML maastokartta', ext: 'png' },
    selkokartta: { title: 'MML selkokartta', ext: 'png' }
  };
  var ATTR_MML = '&copy; <a href="https://www.maanmittauslaitos.fi/avoindata-lisenssi-cc40" target="_blank" rel="noopener">Maanmittauslaitos</a>';
  var ATTR_RV = 'Kasvulohkot &copy; <a href="https://www.ruokavirasto.fi/" target="_blank" rel="noopener">Ruokavirasto</a> (CC BY 4.0)';
  var ATTR_OSM = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';

  function mmlUrl(layer, key) {
    var l = MML_LAYERS[layer] || MML_LAYERS.taustakartta;
    return MML + (MML_LAYERS[layer] ? layer : 'taustakartta') + '/default/WGS84_Pseudo-Mercator/{z}/{y}/{x}.' + l.ext + '?api-key=' + encodeURIComponent(key);
  }

  function parcelLayer(year) { return 'inspire:LandUse.ExistingLandUse.GSAAAgriculturalParcel.' + year; }

  /** GetFeatureInfo pisteeseen (WMS 1.1.1, EPSG:4326, lon/lat-järjestys). */
  function gfiUrl(lon, lat, year, base) {
    var d = 0.0005, w = 101;
    var q = {
      service: 'WMS', version: '1.1.1', request: 'GetFeatureInfo',
      layers: parcelLayer(year), query_layers: parcelLayer(year), styles: '',
      srs: 'EPSG:4326', bbox: [lon - d, lat - d, lon + d, lat + d].map(function (v) { return v.toFixed(7); }).join(','),
      width: w, height: w, x: 50, y: 50, info_format: 'application/json', feature_count: 10
    };
    return (base || RV_WMS) + '?' + Object.keys(q).map(function (k) { return k + '=' + encodeURIComponent(q[k]); }).join('&');
  }

  /** Pieni GetMap-kuva, jolla tarkistetaan, onko vuoden taso olemassa. */
  function probeUrl(year, base) {
    return (base || RV_WMS) + '?service=WMS&version=1.1.1&request=GetMap&layers=' + encodeURIComponent(parcelLayer(year)) +
      '&styles=&srs=EPSG:4326&bbox=22.8,62.7,22.9,62.8&width=8&height=8&format=image/png&transparent=true';
  }

  function prop(p, names) {
    var keys = Object.keys(p || {});
    for (var i = 0; i < names.length; i++) {
      var k = keys.filter(function (x) { return x.toLowerCase() === names[i].toLowerCase(); })[0];
      if (k && p[k] != null && p[k] !== '') return p[k];
    }
    return null;
  }

  // GeoServer voi palauttaa EPSG:4326-koordinaatit lat/lon-järjestyksessä; Suomessa järjestyksen voi päätellä.
  function fixAxis(geom) {
    var first = null;
    (function walk(c) { if (first) return; if (typeof c[0] === 'number') first = c; else c.forEach(walk); })(geom.coordinates);
    if (!first || !(first[0] > 55 && first[0] < 72 && first[1] > 15 && first[1] < 35)) return geom;
    (function swap(c) { if (typeof c[0] === 'number') { var t = c[0]; c[0] = c[1]; c[1] = t; } else c.forEach(swap); })(geom.coordinates);
    return geom;
  }

  function inRing(x, y, r) {
    var ins = false;
    for (var i = 0, j = r.length - 1; i < r.length; j = i++) {
      if ((r[i][1] > y) !== (r[j][1] > y) && x < (r[j][0] - r[i][0]) * (y - r[i][1]) / (r[j][1] - r[i][1]) + r[i][0]) ins = !ins;
    }
    return ins;
  }
  function contains(geom, x, y) {
    var polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
    return polys.some(function (p) { return inRing(x, y, p[0]) && !p.slice(1).some(function (h) { return inRing(x, y, h); }); });
  }

  var MEASURES = [
    [/luonnonhoito/i, 'Luonnonhoitonurmi'],
    [/viherlannoitus/i, 'Viherlannoitusnurmi (ekojärjestelmätuki)'],
    [/monimuotoisuus|niitty|pölyttäjä|riista|maisema/i, 'Monimuotoisuuskasvi'],
    [/nurmi|kesanto/i, 'Nurmi tai kesanto (niittovaatimus)']
  ];
  function measureFor(text) {
    for (var i = 0; i < MEASURES.length; i++) if (MEASURES[i][0].test(text || '')) return MEASURES[i][1];
    return null;
  }

  /**
   * Tulkitsee GetFeatureInfo-vastauksen: valitsee lohkon, joka sisältää pisteen, ja palauttaa
   * GeoJSON-Featuren (WGS84) sekä tunnuksen, kasvin ja toimenpiteen.
   */
  function pickParcel(fc, lon, lat, year) {
    var feats = (fc && fc.features || []).filter(function (f) { return f.geometry && /Polygon/.test(f.geometry.type); });
    if (!feats.length) return null;
    feats.forEach(function (f) { fixAxis(f.geometry); });
    var f = feats.filter(function (x) { return contains(x.geometry, lon, lat); })[0] || feats[0];
    var p = f.properties || {};
    var plt = prop(p, ['PERUSLOHKOTUNNUS', 'peruslohkotunnus']);
    var nro = prop(p, ['LOHKONUMERO', 'lohkonumero', 'KASVULOHKOTUNNUS', 'kasvulohkotunnus']);
    var kasvi = prop(p, ['KASVIKOODI_SELITE_FI', 'kasvikoodi_selite_fi', 'KASVI', 'kasvi', 'cropDescription']);
    var tunnus = plt ? String(plt) + (nro != null && String(nro) !== String(plt) ? '-' + nro : '') : (f.id || null);
    return {
      feature: { type: 'Feature', properties: { tunnus: tunnus, kasvi: kasvi, vuosi: year, lahde: 'Ruokavirasto, kasvulohkot ' + year + ' (CC BY 4.0)' }, geometry: f.geometry },
      tunnus: tunnus, kasvi: kasvi, measure: measureFor(kasvi), year: year
    };
  }

  // ---------- haku peruslohkotunnuksella (WFS) ----------
  var RV_WFS = 'https://inspire.ruokavirasto-awsa.com/geoserver/wfs';
  function lpisLayer(year) { return 'inspire:LC.LandCoverSurfaces.LPIS.' + year; }

  function wfsUrl(typeName, cql, base) {
    var q = { service: 'WFS', version: '2.0.0', request: 'GetFeature', typeNames: typeName, outputFormat: 'application/json',
      srsName: 'urn:ogc:def:crs:EPSG::4326', count: 50, CQL_FILTER: cql };
    return (base || RV_WFS) + '?' + Object.keys(q).map(function (k) { return k + '=' + encodeURIComponent(q[k]); }).join('&');
  }
  function describeUrl(typeName, base) {
    return (base || RV_WFS) + '?service=WFS&version=2.0.0&request=DescribeFeatureType&outputFormat=application/json&typeNames=' + encodeURIComponent(typeName);
  }

  /** Normalisoi peruslohkotunnuksen: vain numerot; hyväksyy myös muodon "1641431471-2" (lohkonumero perään). */
  function parseTunnus(s) {
    var m = /^\s*(\d{10})(?:\s*[-/ ]\s*(\w+))?\s*$/.exec(String(s || ''));
    if (!m) return null;
    return { peruslohko: m[1], lohko: m[2] || null };
  }

  // Etsii taulun sarakkeen, jossa on peruslohkotunnus (palvelun sarakenimiä ei ole dokumentoitu).
  function tunnusField(desc) {
    var props = [];
    ((desc && desc.featureTypes) || []).forEach(function (ft) { (ft.properties || []).forEach(function (p) { props.push(p.name); }); });
    return props.filter(function (n) { return /peruslohko|plohko/i.test(n); })[0] ||
      props.filter(function (n) { return /lohko.*tunnus|tunnus/i.test(n); })[0] || null;
  }

  function areaHa(geom) {
    var polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates, s = 0;
    polys.forEach(function (p) {
      p.forEach(function (r, k) {
        var a = 0, lat0 = r[0][1] * Math.PI / 180, kx = 111320 * Math.cos(lat0), ky = 110574;
        for (var i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] * kx + r[i][0] * kx) * (r[j][1] * ky - r[i][1] * ky);
        s += (k ? -1 : 1) * Math.abs(a / 2);
      });
    });
    return s / 1e4;
  }

  /** Muuntaa WFS-vastauksen lohkovaihtoehdoiksi. */
  function parcelsFromWfs(fc, year, kind) {
    return ((fc && fc.features) || []).filter(function (f) { return f.geometry && /Polygon/.test(f.geometry.type); }).map(function (f) {
      fixAxis(f.geometry);
      var p = f.properties || {};
      var plt = prop(p, ['PERUSLOHKOTUNNUS', 'peruslohkotunnus']);
      var nro = prop(p, ['LOHKONUMERO', 'lohkonumero', 'KASVULOHKOTUNNUS', 'kasvulohkotunnus']);
      var kasvi = kind === 'kasvulohko' ? prop(p, ['KASVIKOODI_SELITE_FI', 'kasvikoodi_selite_fi', 'KASVI', 'kasvi']) : null;
      var tunnus = plt ? String(plt) + (nro != null && String(nro) !== String(plt) ? '-' + nro : '') : (f.id || null);
      return {
        feature: { type: 'Feature', properties: { tunnus: tunnus, kasvi: kasvi, vuosi: year, lahde: 'Ruokavirasto, ' + (kind === 'kasvulohko' ? 'kasvulohkot' : 'peruslohkot') + ' ' + year + ' (CC BY 4.0)' }, geometry: f.geometry },
        tunnus: tunnus, lohkonumero: nro, kasvi: kasvi, measure: measureFor(kasvi), year: year, kind: kind, ha: areaHa(f.geometry)
      };
    });
  }

  // ---------- kuljetus: fetch (CORS) ja varalla JSONP ----------
  // Ruokaviraston GeoServer ei välttämättä lähetä CORS-otsakkeita. GeoServer voi kuitenkin palauttaa
  // vastauksen JSONP-muodossa (text/javascript + format_options=callback:…), jos JSONP on palvelimella päällä.
  // JSONP:ssä script-elementti ladataan suoraan; jos palvelin palauttaa poikkeuksen, callbackia ei kutsuta.
  var jsonpSeq = 0;
  function toJsonp(url, cb) {
    var u = url.replace(/(outputFormat|info_format)=application%2Fjson/i, '$1=text%2Fjavascript');
    return u + '&format_options=' + encodeURIComponent('callback:' + cb);
  }
  function jsonpBrowser(url, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var doc = root.document; if (!doc) { reject(new Error('JSONP vaatii selaimen')); return; }
      var cb = '__niittoJsonp' + (++jsonpSeq) + '_' + Date.now().toString(36);
      var s = doc.createElement('script'), done = false, timer;
      function end(err, val) {
        if (done) return; done = true; clearTimeout(timer);
        try { delete root[cb]; } catch (e) { root[cb] = undefined; }
        if (s.parentNode) s.parentNode.removeChild(s);
        if (err) reject(err); else resolve(val);
      }
      root[cb] = function (data) { end(null, data); };
      s.onerror = function () { end(new Error('JSONP: lataus epäonnistui')); };
      // Jos skripti latautuu mutta callbackia ei kutsuta (poikkeus-XML tai JSONP pois päältä), annetaan hetki aikaa.
      s.onload = function () { setTimeout(function () { end(new Error('JSONP: ei vastausta')); }, 50); };
      timer = setTimeout(function () { end(new Error('JSONP: aikakatkaisu')); }, timeoutMs || 20000);
      s.src = toJsonp(url, cb);
      doc.head.appendChild(s);
    });
  }

  // ---------- välityspalvelin (Cloudflare Worker, ks. worker/README.md) ----------
  var RV_PREFIX = 'https://inspire.ruokavirasto-awsa.com/geoserver/';
  /** Välityspalvelimen osoite: URL-parametri ?rvproxy=… (tallentuu selaimeen; off = ei välityspalvelinta), muuten config.js. */
  function proxyBase() {
    var v = null;
    try {
      var m = root.location && /[?&]rvproxy=([^&#]*)/.exec(root.location.search || '');
      if (m) { v = decodeURIComponent(m[1]); if (v) root.localStorage.setItem('niitto_rvproxy', v); else root.localStorage.removeItem('niitto_rvproxy'); }
      if (!v && root.localStorage) v = root.localStorage.getItem('niitto_rvproxy');
    } catch (e) { /* tallennus estetty */ }
    if (v === 'off') return null;                                   // ?rvproxy=off ohittaa välityspalvelimen
    if (!v && root.NIITTO_CONFIG && root.NIITTO_CONFIG.rvProxy) v = root.NIITTO_CONFIG.rvProxy;
    return v ? String(v).replace(/\/+$/, '') : null;
  }
  function viaProxy(url, base) {
    return base && url.indexOf(RV_PREFIX) === 0 ? base + '/' + url.slice(RV_PREFIX.length) : url;
  }

  async function readJson(r) {
    var txt = await r.text();
    try { return JSON.parse(txt); } catch (e) { return null; } // poikkeus-XML = tasoa ei ole tai suodatin väärä
  }

  /**
   * Luo JSON-hakijan Ruokaviraston rajapintaan. Reitit kokeillaan järjestyksessä:
   * suora kutsu ('fetch') → välityspalvelin ('proxy', jos määritetty) → JSONP ('jsonp').
   * Toimiva reitti muistetaan. JSONP otetaan käyttöön vain, jos koekutsu tunnetulle tasolle
   * (GSAA 2023) onnistuu, jotta "JSONP pois päältä" ei näy tuloksena "lohkoa ei löytynyt".
   */
  function makeTransport(opts) {
    opts = opts || {};
    var get = opts.fetch || (typeof fetch === 'function' ? fetch : null);
    var jsonp = opts.jsonp || jsonpBrowser;
    var proxy = 'proxy' in opts ? opts.proxy : proxyBase();
    var t = { mode: opts.mode || null, proxy: proxy };
    var probe = null;
    function probeJsonp() {
      if (!probe) probe = jsonp(wfsUrl(parcelLayer(2023), 'INCLUDE').replace('count=50', 'count=1')).then(function (d) { return !!(d && d.features); }, function () { return false; });
      return probe;
    }
    async function tryGet(u) { try { return await get(u); } catch (e) { return null; } }
    t.json = async function (url) {
      var r;
      if (t.mode === 'fetch' || t.mode === 'proxy') {
        r = await tryGet(t.mode === 'proxy' ? viaProxy(url, proxy) : url);
        if (!r) throw new Error('NET');                           // toimi aiemmin, nyt yhteysvirhe
        if (t.mode === 'proxy' && r.status === 403) throw new Error('PROXY403');
        return readJson(r);
      }
      if (t.mode === 'jsonp') { try { return await jsonp(url); } catch (e) { return null; } }
      r = await tryGet(url);
      if (r) { t.mode = 'fetch'; return readJson(r); }
      if (proxy) {
        r = await tryGet(viaProxy(url, proxy));
        if (r && r.status === 403) throw new Error('PROXY403');
        if (r) { t.mode = 'proxy'; return readJson(r); }
      }
      if (!(await probeJsonp())) throw new Error(proxy ? 'PROXYDOWN' : 'CORS');
      t.mode = 'jsonp';
      try { return await jsonp(url); } catch (e) { return null; }
    };
    return t;
  }
  var sharedTransport = null;
  function transport() { return sharedTransport || (sharedTransport = makeTransport()); }

  function corsMessage(tunnus, code) {
    var tail = 'Piirrä rajaus kartalle tai hae se skriptillä: python scripts/hae_kasvulohkot.py --peruslohko ' + (tunnus || '<tunnus>');
    if (code === 'PROXY403') return 'Välityspalvelin ei hyväksy tätä sivua (Origin ei ole sallittu). Lisää osoite Workerin ALLOWED_ORIGINS-muuttujaan. ' + tail;
    if (code === 'PROXYDOWN') return 'Välityspalvelin ei vastannut, eikä Ruokaviraston rajapinta salli hakua selaimesta. Tarkista välityspalvelimen osoite. ' + tail;
    return 'Ruokaviraston rajapinta ei salli hakua selaimesta: CORS on estetty eikä JSONP ole käytössä, eikä välityspalvelinta ole määritetty (ks. worker/README.md). ' + tail;
  }

  /**
   * Hakee peruslohkon kasvulohkot (uusin saatavilla oleva vuosi). Jos kasvulohkoja ei löydy,
   * palauttaa peruslohkon rajauksen. Palauttaa { year, kind, parcels, via } tai heittää virheen.
   */
  async function findByTunnus(input, opts) {
    opts = opts || {};
    var t = parseTunnus(input);
    if (!t) throw new Error('Anna peruslohkotunnus kymmenellä numerolla, esim. 1641431471, tai kasvulohkon kanssa 1641431471-2.');
    var tr = opts.fetch || opts.jsonp ? makeTransport(opts) : transport();
    var from = opts.year || new Date().getFullYear(), fieldCache = {};
    async function json(url) {
      try { return await tr.json(url); } catch (e) {
        if (/^(CORS|PROXY403|PROXYDOWN)$/.test(e.message)) throw new Error(corsMessage(t.peruslohko, e.message));
        throw new Error('Yhteys Ruokaviraston rajapintaan katkesi. Yritä uudelleen tai hae rajaus skriptillä: python scripts/hae_kasvulohkot.py --peruslohko ' + t.peruslohko);
      }
    }
    async function query(typeName) {
      if (!(typeName in fieldCache)) fieldCache[typeName] = tunnusField(await json(describeUrl(typeName)));
      var names = [fieldCache[typeName], 'PERUSLOHKOTUNNUS', 'peruslohkotunnus'].filter(function (x, i, a) { return x && a.indexOf(x) === i; });
      for (var i = 0; i < names.length; i++) {
        var js = await json(wfsUrl(typeName, names[i] + "='" + t.peruslohko + "'"));
        if (js && js.features && js.features.length) return js;
        if (js && js.features) return js; // kelvollinen vastaus ilman osumia
      }
      return null;
    }
    for (var kindIx = 0; kindIx < 2; kindIx++) {
      var kind = kindIx === 0 ? 'kasvulohko' : 'peruslohko';
      for (var y = from; y >= 2021; y--) {
        var js = await query(kind === 'kasvulohko' ? parcelLayer(y) : lpisLayer(y));
        if (!js) continue;                      // vuoden tasoa ei ole
        var list = parcelsFromWfs(js, y, kind);
        if (!list.length) continue;             // ei osumaa tältä vuodelta, kokeillaan edellistä
        if (t.lohko) {
          var hit = list.filter(function (p) { return String(p.lohkonumero) === String(t.lohko) || p.tunnus === t.peruslohko + '-' + t.lohko; });
          if (hit.length) list = hit;
        }
        return { year: y, kind: kind, parcels: list, tunnus: t, via: tr.mode };
      }
    }
    throw new Error('Peruslohkoa ' + t.peruslohko + ' ei löytynyt Ruokaviraston aineistosta vuosilta 2021–' + from + '.');
  }

  // ---------- niittovelvoitteisten lohkojen korostus (SLD Ruokaviraston WMS:ään) ----------
  // Sama luokittelu kuin measureFor(): kasvin nimen perusteella. Värit näkyvät kartan selitteessä.
  var NIITTO_CLASSES = [
    { key: 'lhn', name: 'Luonnonhoitonurmi', fill: '#2e7d32', stroke: '#1b5e20', like: ['luonnonhoito'] },
    { key: 'vln', name: 'Viherlannoitusnurmi', fill: '#1565c0', stroke: '#0d47a1', like: ['viherlannoitus'] },
    { key: 'mmk', name: 'Monimuotoisuuskasvi', fill: '#8e24aa', stroke: '#6a1b9a', like: ['monimuotoisuus', 'niitty', 'pölyttäjä', 'riista', 'maisema'] },
    { key: 'nk', name: 'Nurmi tai kesanto', fill: '#f9a825', stroke: '#b57a00', like: ['nurmi', 'kesanto'] }
  ];
  function xmlEsc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function likeF(field, word) {
    return '<ogc:PropertyIsLike wildCard="*" singleChar="." escape="!" matchCase="false"><ogc:PropertyName>' + xmlEsc(field) +
      '</ogc:PropertyName><ogc:Literal>*' + xmlEsc(word) + '*</ogc:Literal></ogc:PropertyIsLike>';
  }
  function anyLike(field, words) { return words.length === 1 ? likeF(field, words[0]) : '<ogc:Or>' + words.map(function (w) { return likeF(field, w); }).join('') + '</ogc:Or>'; }
  /** SLD, joka piirtää vain niittovelvoitteiset kasvulohkot luokittain. Aiempi luokka voittaa (Not-ehdot). */
  function niittoSld(year, field) {
    field = field || 'KASVIKOODI_SELITE_FI';
    // Vain nurmi/kesanto-luokan sanat ("nurmi") esiintyvät muiden luokkien nimissä (luonnonhoito-, viherlannoitusnurmi),
    // joten vain sille tarvitaan poissulkeva ehto. Lyhyt SLD pitää tiilipyynnön osoitteen alle palvelimen rajan.
    var rules = NIITTO_CLASSES.map(function (c) {
      var f = anyLike(field, c.like);
      if (c.key === 'nk') f = '<ogc:And>' + f + '<ogc:Not>' + anyLike(field, ['luonnonhoito', 'viherlannoitus']) + '</ogc:Not></ogc:And>';
      return '<Rule><Name>' + c.key + '</Name><ogc:Filter>' + f + '</ogc:Filter>' +
        '<PolygonSymbolizer><Fill><CssParameter name="fill">' + c.fill + '</CssParameter><CssParameter name="fill-opacity">0.45</CssParameter></Fill>' +
        '<Stroke><CssParameter name="stroke">' + c.stroke + '</CssParameter><CssParameter name="stroke-width">1.5</CssParameter></Stroke></PolygonSymbolizer></Rule>';
    }).join('');
    return '<StyledLayerDescriptor version="1.0.0" xmlns="http://www.opengis.net/sld" xmlns:ogc="http://www.opengis.net/ogc">' +
      '<NamedLayer><Name>' + xmlEsc(parcelLayer(year)) + '</Name><UserStyle><FeatureTypeStyle>' + rules +
      '</FeatureTypeStyle></UserStyle></NamedLayer></StyledLayerDescriptor>';
  }
  function cropField(desc) {
    var props = [];
    ((desc && desc.featureTypes) || []).forEach(function (ft) { (ft.properties || []).forEach(function (p) { props.push(p.name); }); });
    return props.filter(function (n) { return /kasvi.*selite.*fi|selite_fi/i.test(n); })[0] || props.filter(function (n) { return /selite|kasvi/i.test(n) && !/koodi$/i.test(n); })[0] || null;
  }

  // ---------- paikkahaku ----------
  /** Tulkitsee koordinaatit: "62.79, 22.84" (lat, lon), "22.84 62.79" tai ETRS-TM35FIN "6965000 290000". */
  function parseCoords(q) {
    var m = /^\s*(-?\d+(?:[.,]\d+)?)\s*[,;\s]\s*(-?\d+(?:[.,]\d+)?)\s*$/.exec(q || '');
    if (!m) return null;
    var a = parseFloat(m[1].replace(',', '.')), b = parseFloat(m[2].replace(',', '.'));
    if (Math.abs(a) <= 90 && Math.abs(b) <= 180) {
      if (a >= 58 && a <= 71) return { lat: a, lon: b };
      if (b >= 58 && b <= 71) return { lat: b, lon: a };
      return { lat: a, lon: b };
    }
    var H = root.NiittoHaku;
    if (H && H.toLonLat) {
      var n = Math.max(a, b), e = Math.min(a, b);         // Suomessa N 6,6–7,8 milj., E 0,05–0,75 milj.
      if (n > 6.5e6 && n < 7.9e6 && e > 0 && e < 8e5) { var ll = H.toLonLat(e, n, 3067); return { lat: ll[1], lon: ll[0] }; }
    }
    return null;
  }
  function geocodeUrl(q, key) {
    return key
      ? 'https://avoin-paikkatieto.maanmittauslaitos.fi/geocoding/v2/pelias/search?text=' + encodeURIComponent(q) + '&size=6&lang=fin&api-key=' + encodeURIComponent(key)
      : 'https://nominatim.openstreetmap.org/search?format=jsonv2&countrycodes=fi&limit=6&accept-language=fi&q=' + encodeURIComponent(q);
  }
  function parseGeocode(js) {
    if (Array.isArray(js)) return js.map(function (r) { return { label: r.display_name, lat: +r.lat, lon: +r.lon }; });
    return ((js && js.features) || []).filter(function (f) { return f.geometry && f.geometry.coordinates; }).map(function (f) {
      var c = f.geometry.coordinates, lon = +c[0], lat = +c[1], p = f.properties || {};
      if (Math.abs(lon) > 180 && root.NiittoHaku) { var ll = root.NiittoHaku.toLonLat(lon, lat, 3067); lon = ll[0]; lat = ll[1]; }
      var label = p.label || p.name || [p['label:fin'], p.municipality].filter(Boolean).join(', ') || 'paikka';
      return { label: label, lat: lat, lon: lon };
    });
  }
  /** Hakee paikan nimellä tai osoitteella: MML:n geokoodaus avaimella, muuten OpenStreetMap (Nominatim). */
  async function geocode(q, key, opts) {
    var c = parseCoords(q);
    if (c) return [{ label: 'Koordinaatit ' + c.lat.toFixed(5) + ', ' + c.lon.toFixed(5), lat: c.lat, lon: c.lon }];
    var get = (opts && opts.fetch) || fetch;
    async function one(k) { var r = await get(geocodeUrl(q, k)); if (!r.ok) throw new Error('HTTP ' + r.status); return parseGeocode(await r.json()); }
    if (key) { try { var res = await one(key); if (res.length) return res; } catch (e) { /* MML ei vastannut: kokeillaan OSM */ } }
    return one(null);
  }

  // ---------- selainosa ----------
  function createMap(el, opts) {
    var L = root.L; if (!L) throw new Error('Leaflet puuttuu.');
    opts = opts || {};
    var say = opts.onMessage || function () {};
    var map = L.map(el, { zoomControl: true, attributionControl: true, scrollWheelZoom: false }).setView([62.8, 23.5], 6);
    el._niittoMap = map; // testejä ja vianetsintää varten
    var base = null, parcels = null, niitto = null, selected = null, draft = null, drawPts = [], drawing = false, year = null;
    var highlight = opts.highlight !== false, cropName = 'KASVIKOODI_SELITE_FI', niittoErrors = 0, needFit = false;
    // Rullazoomi vasta, kun karttaa on klikattu, jotta sivun vieritys ei zoomaa karttaa.
    map.on('click focus', function () { map.scrollWheelZoom.enable(); });
    map.on('mouseout blur', function () { map.scrollWheelZoom.disable(); });
    // Kartta alustetaan usein piilossa olevaan elementtiin: koko päivitetään aina, kun se muuttuu.
    function fitSelected() {
      if (!selected) return;
      if (!el.clientWidth || !el.clientHeight) { needFit = true; return; }
      needFit = false;
      try { map.fitBounds(selected.getBounds(), { maxZoom: 17, padding: [20, 20] }); } catch (e) { /* tyhjä */ }
    }
    function resized() { map.invalidateSize(); if (needFit) fitSelected(); }
    if (typeof ResizeObserver === 'function') new ResizeObserver(resized).observe(el);
    setTimeout(resized, 0);
    var state = { key: opts.key || '', layer: opts.layer || 'taustakartta', tileErrors: 0 };

    function setBase() {
      if (base) map.removeLayer(base);
      state.tileErrors = 0;
      if (state.key) {
        base = L.tileLayer(mmlUrl(state.layer, state.key), { maxZoom: 19, maxNativeZoom: 16, attribution: ATTR_MML });
        base.on('tileerror', function () {
          if (++state.tileErrors === 3) say('MML:n karttakuvat eivät lataudu. Tarkista API-avain. Kartta vaihdetaan OpenStreetMapiin.', 'warn'), useOsm();
        });
      } else {
        base = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: ATTR_OSM });
      }
      base.addTo(map); base.bringToBack();
    }
    function useOsm() { state.key = ''; setBase(); }

    function setParcels(y) {
      year = y;
      if (parcels) map.removeLayer(parcels);
      parcels = L.tileLayer.wms(RV_WMS, { layers: parcelLayer(y), styles: '', format: 'image/png', transparent: true, opacity: 0.7, minZoom: 12, attribution: ATTR_RV });
      parcels.addTo(map);
      setNiitto();
    }
    function setNiitto() {
      if (niitto) { map.removeLayer(niitto); niitto = null; }
      if (!highlight || !year) return;
      niittoErrors = 0;
      niitto = L.tileLayer.wms(RV_WMS, { layers: parcelLayer(year), styles: '', sld_body: niittoSld(year, cropName), format: 'image/png', transparent: true, minZoom: 11, attribution: ATTR_RV });
      niitto.on('tileerror', function () { if (++niittoErrors === 3) say('Niittovelvoitteisten lohkojen korostusta ei voitu piirtää: palvelu ei hyväksynyt tyyliä.', 'warn'); });
      niitto.addTo(map);
    }
    // Tarkistetaan kasvisarakkeen nimi kerran (vaatii välityspalvelimen tai CORSin; muuten oletusnimi).
    (async function () {
      try {
        var d = await transport().json(describeUrl(parcelLayer(opts.year || new Date().getFullYear() - 1)));
        var f = cropField(d); if (f && f !== cropName) { cropName = f; setNiitto(); }
      } catch (e) { /* oletusnimi jää käyttöön */ }
    })();

    // Etsii uusimman vuoden, jolle kasvulohkotaso on olemassa (kuvan lataus ei vaadi CORSia).
    function resolveYear(from, done) {
      var y = from;
      (function tryYear() {
        if (y < 2021) { done(null); return; }
        var img = new Image();
        img.onload = function () { done(y); };
        img.onerror = function () { y--; tryYear(); };
        img.src = probeUrl(y);
      })();
    }

    function show(feature) {
      if (selected) map.removeLayer(selected);
      selected = L.geoJSON(feature, { style: { color: '#c2410c', weight: 3, fillOpacity: 0.12 } }).addTo(map);
      map.invalidateSize();
      fitSelected();
    }

    function finishDraw() {
      if (drawPts.length < 3) { say('Piirrä vähintään kolme pistettä.', 'warn'); return null; }
      var ring = drawPts.map(function (p) { return [+p.lng.toFixed(7), +p.lat.toFixed(7)]; });
      ring.push(ring[0].slice());
      var f = { type: 'Feature', properties: { tunnus: null, lahde: 'käsin piirretty' }, geometry: { type: 'Polygon', coordinates: [ring] } };
      stopDraw(); show(f);
      return f;
    }
    function startDraw() { drawing = true; drawPts = []; if (draft) map.removeLayer(draft); draft = null; el.style.cursor = 'crosshair'; }
    function stopDraw() { drawing = false; if (draft) map.removeLayer(draft); draft = null; drawPts = []; el.style.cursor = ''; }

    map.on('click', async function (e) {
      if (drawing) {
        drawPts.push(e.latlng);
        if (draft) map.removeLayer(draft);
        draft = L.polygon(drawPts, { color: '#c2410c', dashArray: '4 4', weight: 2 }).addTo(map);
        return;
      }
      if (map.getZoom() < 12) { say('Lähennä karttaa, jotta lohkot näkyvät, ja klikkaa sitten lohkoa.', 'info'); return; }
      if (!year) { say('Kasvulohkotasoa ei löytynyt. Piirrä rajaus itse.', 'warn'); return; }
      var lon = e.latlng.lng, lat = e.latlng.lat;
      say('Haetaan lohkoa…', 'info');
      var js;
      try { js = await transport().json(gfiUrl(lon, lat, year)); } catch (err) {
        say(/^(CORS|PROXY403|PROXYDOWN)$/.test(err.message)
          ? corsMessage(null, err.message).replace(/Piirrä rajaus kartalle tai hae se skriptillä.*$/, 'Piirrä rajaus itse tai liitä GeoJSON.')
          : 'Yhteys Ruokaviraston palveluun katkesi. Yritä uudelleen tai piirrä rajaus itse.', 'fail');
        return;
      }
      if (!js) { say('Lohkopalvelu palautti virheen. Piirrä rajaus itse tai kokeile toista kohtaa.', 'fail'); return; }
      var pick = pickParcel(js, lon, lat, year);
      if (!pick) { say('Klikatusta kohdasta ei löytynyt kasvulohkoa vuodelta ' + year + '.', 'warn'); return; }
      show(pick.feature);
      if (opts.onSelect) opts.onSelect(pick);
    });

    setBase();
    resolveYear(opts.year || new Date().getFullYear(), function (y) {
      if (y) { setParcels(y); say('Kasvulohkot vuodelta ' + y + ' (Ruokavirasto). Lähennä ja klikkaa lohkoa.', 'info'); if (opts.onYear) opts.onYear(y); }
      else say('Ruokaviraston kasvulohkotasoa ei saatu. Voit piirtää rajauksen itse.', 'warn');
    });

    return {
      map: map,
      setKey: function (k) { state.key = k || ''; setBase(); },
      setLayer: function (l) { state.layer = l; if (state.key) setBase(); },
      setYear: function (y) { resolveYear(y, function (r) { if (r) { setParcels(r); if (opts.onYear) opts.onYear(r); } else say('Vuoden ' + y + ' kasvulohkoja ei löytynyt.', 'warn'); }); },
      getYear: function () { return year; },
      show: show, startDraw: startDraw, finishDraw: finishDraw, stopDraw: stopDraw,
      isDrawing: function () { return drawing; },
      invalidate: resized,
      setHighlight: function (on) { highlight = !!on; setNiitto(); },
      goTo: function (lat, lon, z) { map.invalidateSize(); map.setView([lat, lon], z || 15, { animate: false }); },
      key: function () { return state.key; }
    };
  }

  var api = { mmlUrl: mmlUrl, gfiUrl: gfiUrl, probeUrl: probeUrl, parcelLayer: parcelLayer, pickParcel: pickParcel,
    measureFor: measureFor, fixAxis: fixAxis, contains: contains, createMap: createMap, MML_LAYERS: MML_LAYERS, RV_WMS: RV_WMS,
    RV_WFS: RV_WFS, wfsUrl: wfsUrl, describeUrl: describeUrl, parseTunnus: parseTunnus, tunnusField: tunnusField,
    parcelsFromWfs: parcelsFromWfs, findByTunnus: findByTunnus, lpisLayer: lpisLayer, areaHa: areaHa,
    NIITTO_CLASSES: NIITTO_CLASSES, niittoSld: niittoSld, cropField: cropField, parseCoords: parseCoords, geocodeUrl: geocodeUrl, parseGeocode: parseGeocode, geocode: geocode,
    toJsonp: toJsonp, makeTransport: makeTransport, viaProxy: viaProxy, proxyBase: proxyBase, corsMessage: corsMessage, transportMode: function () { return sharedTransport ? sharedTransport.mode : null; } };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.NiittoKartta = api;
})(typeof self !== 'undefined' ? self : this);
