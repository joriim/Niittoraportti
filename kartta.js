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

  /**
   * Hakee peruslohkon kasvulohkot (uusin saatavilla oleva vuosi). Jos kasvulohkoja ei löydy,
   * palauttaa peruslohkon rajauksen. Palauttaa { year, kind, parcels } tai heittää virheen.
   */
  async function findByTunnus(input, opts) {
    opts = opts || {};
    var t = parseTunnus(input);
    if (!t) throw new Error('Anna peruslohkotunnus kymmenellä numerolla, esim. 1641431471, tai kasvulohkon kanssa 1641431471-2.');
    var get = opts.fetch || fetch, from = opts.year || new Date().getFullYear(), fieldCache = {};
    async function json(url) {
      var r;
      try { r = await get(url); } catch (e) {
        throw new Error('Ruokaviraston rajapinta ei salli hakua selaimesta (CORS) tai yhteys katkesi. Hae rajaus skriptillä: python scripts/hae_kasvulohkot.py --peruslohko ' + t.peruslohko);
      }
      var txt = await r.text();
      try { return JSON.parse(txt); } catch (e) { return null; } // poikkeus-XML = tasoa ei ole tai suodatin väärä
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
        return { year: y, kind: kind, parcels: list, tunnus: t };
      }
    }
    throw new Error('Peruslohkoa ' + t.peruslohko + ' ei löytynyt Ruokaviraston aineistosta vuosilta 2021–' + from + '.');
  }

  // ---------- selainosa ----------
  function createMap(el, opts) {
    var L = root.L; if (!L) throw new Error('Leaflet puuttuu.');
    opts = opts || {};
    var say = opts.onMessage || function () {};
    var map = L.map(el, { zoomControl: true, attributionControl: true }).setView([62.8, 23.5], 6);
    var base = null, parcels = null, selected = null, draft = null, drawPts = [], drawing = false, year = null;
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
    }

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
      try { map.fitBounds(selected.getBounds(), { maxZoom: 17, padding: [20, 20] }); } catch (e) { /* tyhjä */ }
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
      var r, js;
      try { r = await fetch(gfiUrl(lon, lat, year)); } catch (err) {
        say('Ruokaviraston palvelu ei salli lohkon hakua selaimesta (CORS) tai yhteys katkesi. Piirrä rajaus itse tai liitä GeoJSON.', 'fail');
        return;
      }
      try { js = await r.json(); } catch (err) { say('Lohkopalvelu palautti virheen (HTTP ' + r.status + ').', 'fail'); return; }
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
      invalidate: function () { map.invalidateSize(); }
    };
  }

  var api = { mmlUrl: mmlUrl, gfiUrl: gfiUrl, probeUrl: probeUrl, parcelLayer: parcelLayer, pickParcel: pickParcel,
    measureFor: measureFor, fixAxis: fixAxis, contains: contains, createMap: createMap, MML_LAYERS: MML_LAYERS, RV_WMS: RV_WMS,
    RV_WFS: RV_WFS, wfsUrl: wfsUrl, describeUrl: describeUrl, parseTunnus: parseTunnus, tunnusField: tunnusField,
    parcelsFromWfs: parcelsFromWfs, findByTunnus: findByTunnus, lpisLayer: lpisLayer, areaHa: areaHa };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.NiittoKartta = api;
})(typeof self !== 'undefined' ? self : this);
