/*
 * Niittoraportti – niiton tunnistuksen ydin (ei DOM-riippuvuuksia, testattavissa Nodella).
 *
 * Malli seuraa Ruokaviraston satelliittiseurannan rakennetta (lohkon aikasarjat →
 * statuksen muutos → muutoksen pysyvyyden varmistus → todennäköisyysraja) ja
 * toteuttaa muutostunnistuksen Sen4CAP-niittoalgoritmin mukaan
 * (De Vroey ym. 2022, https://doi.org/10.1016/j.rse.2022.113145).
 * Lisälähteinä HLS (Claverie ym. 2018) ja PlanetScope. Yksityiskohdat: METHOD.md.
 */
(function (root) {
  'use strict';

  var VERSION = '2.2.0';

  // Lähde → sensoriperhe. Pudotus lasketaan vain saman perheen havaintojen välillä,
  // koska eri sensoreiden NDVI-tasot eivät ole suoraan vertailukelpoisia.
  var FAMILY = {
    'HLS-S30': 'HLS',          // HLS on harmonisoitu: S30 ja L30 samaa sarjaa
    'HLS-L30': 'HLS',
    'Sentinel-2': 'S2',        // Sentinel-2 L2A sellaisenaan (ei HLS)
    'PlanetScope': 'PS',
    'Sentinel-1 koherenssi': 'S1',  // 12 pv VH-koherenssi (Ruokavirasto saa sen Ilmatieteen laitokselta); vain CSV-tuonti
    'Sentinel-1 VH': 'S1B',          // VH-takaisinsironta γ⁰ (dB), haetaan Copernicus Data Space Ecosystemistä
    'Sentinel-2 L2A (HLS-täydennys)': 'HLS'  // sisäinen: L2A-kuva päivältä, jolta HLS-S30-granuli puuttuu (fuse)
  };
  var RADAR = { S1: true, S1B: true };
  function isRadar(f) { return !!RADAR[f]; }
  var SOURCES = Object.keys(FAMILY);

  // Tukiehtojen päivämääräsäännöt (MM-DD). Lähde: Ruokaviraston peltovalvontaohje 2026.
  var RULES = {
    'Luonnonhoitonurmi': { earliest: null, latest: '09-15', note: 'Niitto tai laidunnus vähintään joka toinen vuosi viimeistään 15.9.' },
    'Viherlannoitusnurmi (ekojärjestelmätuki)': { earliest: null, latest: '09-15', note: 'Niitto vähintään joka toinen vuosi viimeistään 15.9.' },
    'Monimuotoisuuskasvi': { earliest: '08-01', latest: null, note: 'Niitto pääasiallisen kukinnan jälkeen, aikaisintaan 1.8.' },
    'Nurmi tai kesanto (niittovaatimus)': { earliest: null, latest: '09-15', note: 'Niitto, laidunnus tai sadonkorjuu viimeistään 15.9.' }
  };

  var DEFAULTS = {
    ndviDrop: 0.12,     // De Vroey ym. 2022: pohjoisten maiden kynnys 0,12 (eteläisten 0,15)
    maxGap: 60,         // De Vroey ym. 2022: Δt_max 60 vrk
    warnGap: 14,        // oma: yli 2 viikon väli heikentää ajoitusta
    persistWindow: 10,  // oma: pysyvyys tarkistetaan seuraavasta ≤ 10 vrk päässä olevasta havainnosta
    minSeparation: 28,  // De Vroey ym. 2022: Δt_min 28 vrk peräkkäisten niittojen välillä
    maxEvents: 4,       // De Vroey ym. 2022: enintään 4 varminta tapahtumaa
    s1k: 5.0,           // De Vroey ym. 2022: CFAR, P_fa 3,0e-7 → yksipuolinen z ≈ 5,0
    s1Window: 6,        // De Vroey ym. 2022: lineaarisovite kuuteen edelliseen arvoon
    s1MinPrev: 4,       // oma: sovite vaatii vähintään 4 aiempaa arvoa
    s1SigmaFloor: 0.02, // oma: estää nollahajonnan pienissä sarjoissa
    s1bDrop: 1.0,       // oma: VH-takaisinsironnan lasku ≥ 1 dB trendistä (niitto vähentää tilavuussirontaa)
    s1bK: 2.0,          // oma: ja ≥ 2σ saman kuvausgeometrian sarjan hajonnasta
    s1bSigmaFloor: 0.5, // oma: speckle ja kosteus → hajonta vähintään 0,5 dB
    s1bMinPrev: 3,      // oma: saman kuvausgeometrian sarjasta vähintään 3 aiempaa arvoa
    trendWindow: 30,    // Ruokavirasto/CGI: pudotus suhteessa trendiin; trendi edellisen 30 vrk havainnoista (oma ikkuna)
    trendK: 2.0,        // oma: trendi ± 2σ -kaista
    trendSigmaFloor: 0.03, // oma: NDVI-hajonnan alaraja
    trendLead: 10,      // oma: trendiä jatketaan enintään 10 vrk viimeisestä havainnosta
    seeGap: 10,         // oma: ≤ 10 vrk optinen väli → niitto näkyy varmasti ennen kuin nurmi palautuu
    plausibleDrop: 0.2, // oma: nurmen niitto laskee NDVI:tä tyypillisesti ≥ 0,2; pienempi pudotus on epävarma
    maxRecovery: 0.03,  // oma: NDVI voi palautua niiton jälkeen enintään 0,03/vrk (nopeampi = pilvi tai varjo)
    postDeadline: 2,    // oma: määräpäivän jälkeen vähintään 2 selkeää kuvaa, jotta pysyvyys voidaan todeta
    fuseConflict: 0.15, // oma: saman päivän HLS- ja L2A-arvojen ero > 0,15 → havainto epävarma
    minValid: 50,       // oma: kelvollisten pikselien vähimmäisosuus %, muuten havainto hylätään
    minChanged: 90,     // oma: tukiehto koskee koko lohkoa → ≥ 90 % pikseleistä muuttunut
    confMin: 0.6,       // oma todennäköisyysraja (vrt. Ruokaviraston status-kohtainen raja)
    bufferM: 10,        // raportoitava parametri; Kolecka ym. 2018: kutistettu lohko parantaa tulosta
    cloudMask: 'HLS: Fmask (sirrus, pilvi, pilven viereinen, varjo, lumi, aerosoli korkea); Sentinel-2 L2A: SCL (kelpaavat luokat 4–6); PlanetScope: UDM2 clear'
  };

  function days(a, b) { return (Date.parse(b) - Date.parse(a)) / 864e5; }
  function clip(x) { return Math.max(0, Math.min(1, x)); }
  function mmdd(d) { return d.slice(5); }
  function round(x, n) { var m = Math.pow(10, n); return Math.round(x * m) / m; }

  function prepare(obs, p) {
    var out = { used: [], excluded: [] };
    obs.forEach(function (o) {
      if (o && o.date && /^\d{4}-\d{2}-\d{2}$/.test(o.date) && (o.value == null || (typeof o.value === 'number' && isNaN(o.value))) && typeof o.valid === 'number' && FAMILY[o.src]) {
        out.excluded.push({ obs: o, reason: 'ei kelvollisia pikseleitä (' + o.valid + ' %): pilvi, varjo tai maskin hylkäämä kuva' });
        return;
      }
      if (!o || !o.date || !/^\d{4}-\d{2}-\d{2}$/.test(o.date) || typeof o.value !== 'number' || isNaN(o.value)) return;
      var fam = FAMILY[o.src];
      if (!fam) { out.excluded.push({ obs: o, reason: 'tuntematon lähde' }); return; }
      if (!isRadar(fam) && o.valid != null && !isNaN(o.valid) && o.valid < p.minValid) {
        out.excluded.push({ obs: o, reason: 'kelvollisia pikseleitä ' + o.valid + ' % < ' + p.minValid + ' %' });
        return;
      }
      if (!isRadar(fam) && (o.value < -1 || o.value > 1)) { out.excluded.push({ obs: o, reason: 'NDVI alueen −1…1 ulkopuolella' }); return; }
      if (fam === 'S1' && (o.value < 0 || o.value > 1)) { out.excluded.push({ obs: o, reason: 'koherenssi alueen 0…1 ulkopuolella' }); return; }
      if (fam === 'S1B' && (o.value < -40 || o.value > 10)) { out.excluded.push({ obs: o, reason: 'takaisinsironta alueen −40…10 dB ulkopuolella' }); return; }
      if (fam === 'S1B' && o.valid != null && !isNaN(o.valid) && o.valid < p.minValid) {
        out.excluded.push({ obs: o, reason: 'kelvollisia pikseleitä ' + o.valid + ' % < ' + p.minValid + ' %' });
        return;
      }
      out.used.push(Object.assign({}, o, { fam: fam }));
    });
    out.used.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    return out;
  }

  // Pysyvyys: seuraavan ≤ persistWindow vrk päässä olevan havainnon on pysyttävä matalana tai
  // palauduttava asteittain (≤ maxRecovery NDVI/vrk). Nopea paluu viittaa pilveen tai varjoon.
  function persistOf(b, c, low, p) {
    if (!c || days(b.date, c.date) > p.persistWindow) return { s: 'ei varmistettu' };
    var rate = (c.value - b.value) / Math.max(1, days(b.date, c.date));
    if (c.value > low) return { s: 'palautui', why: 'NDVI palautui seuraavassa havainnossa (' + c.date + ')' };
    if (rate > p.maxRecovery) return { s: 'palautui', why: 'NDVI nousi seuraavaan havaintoon (' + c.date + ') ' + rate.toFixed(3).replace('.', ',') + '/vrk, nopeammin kuin nurmi kasvaa' };
    return { s: 'pysyvä' };
  }
  // Uskottavuus ja maskien ristiriidat: alentavat luottamusta ja lisäävät huomautuksen.
  function doubts(drop, a, b, p) {
    var f = 1, notes = [];
    if (drop < p.plausibleDrop) { f *= 0.8; notes.push('pudotus ' + drop.toFixed(2).replace('.', ',') + ' on alle nurmen niitolle tyypillisen ' + String(p.plausibleDrop).replace('.', ',') + ':n, joten muutos on epävarma'); }
    [a, b].forEach(function (o) { if (o.conflict) { f *= 0.85; notes.push(o.date + ': ' + o.conflict); } });
    return { f: f, notes: notes };
  }

  // Optinen ilmaisin: NDVI-pudotus edelliseen saman sensoriperheen pilvettömään havaintoon.
  function opticalDetect(series, fam, p) {
    var acc = [], rej = [];
    for (var i = 1; i < series.length; i++) {
      var a = series[i - 1], b = series[i];
      var drop = a.value - b.value, gap = days(a.date, b.date);
      if (drop < p.ndviDrop) continue;
      var base = { fam: fam, start: a.date, end: b.date, drop: round(drop, 3), gap: gap, before: a, after: b };
      if (gap > p.maxGap) { rej.push(Object.assign(base, { reason: 'havaintoväli ' + gap + ' vrk > ' + p.maxGap + ' vrk' })); continue; }
      // Pysyvyys (Ruokaviraston periaate: muutoksen pysyvyys varmistetaan)
      // Vain lähellä oleva seuraava havainto kelpaa: nurmi kasvaa takaisin 2–4 viikossa.
      var ps = persistOf(b, series[i + 1], a.value - p.ndviDrop / 2, p), persistence = ps.s;
      if (persistence === 'palautui') {
        rej.push(Object.assign(base, { reason: ps.why + ', todennäköisesti pilvi, varjo tai usva' }));
        continue;
      }
      var conf = 0.5 + 0.5 * clip((drop - p.ndviDrop) / 0.25); // De Vroey: optinen 0,5–1
      var dq = doubts(drop, a, b, p), notes = dq.notes; conf *= dq.f;
      if (persistence === 'ei varmistettu') { conf *= 0.85; notes.push('pysyvyyttä ei voitu varmistaa (ei havaintoa ' + p.persistWindow + ' vrk sisällä)'); }
      if (gap > p.warnGap) { conf *= 0.9; notes.push('väli ' + gap + ' vrk: hidas muutos voi olla myös tuleentumista tai kuivuutta'); }
      acc.push(Object.assign(base, { persistence: persistence, conf: conf, notes: notes, changed: b.changed != null && !isNaN(b.changed) ? b.changed : null }));
    }
    return { acc: acc, rej: rej };
  }

  // Tutkailmaisin: VH-koherenssin nousu lineaarisovitteen ennusteen yli kσ (CFAR).
  function s1Detect(series, p) {
    var acc = [];
    for (var i = p.s1MinPrev; i < series.length; i++) {
      var prev = series.slice(Math.max(0, i - p.s1Window), i);
      if (prev.length < p.s1MinPrev) continue;
      var t0 = Date.parse(prev[0].date) / 864e5;
      var xs = prev.map(function (o) { return Date.parse(o.date) / 864e5 - t0; });
      var ys = prev.map(function (o) { return o.value; });
      var n = xs.length, mx = 0, my = 0;
      for (var j = 0; j < n; j++) { mx += xs[j] / n; my += ys[j] / n; }
      var sxx = 0, sxy = 0;
      for (j = 0; j < n; j++) { sxx += (xs[j] - mx) * (xs[j] - mx); sxy += (xs[j] - mx) * (ys[j] - my); }
      var slope = sxx > 0 ? sxy / sxx : 0, icpt = my - slope * mx;
      var ss = 0;
      for (j = 0; j < n; j++) { var r = ys[j] - (icpt + slope * xs[j]); ss += r * r; }
      var sigma = Math.max(p.s1SigmaFloor, Math.sqrt(ss / Math.max(1, n - 2)));
      // Ennuste edelliselle ajanhetkelle (t−1), kuten De Vroey ym. 2022
      var pred = icpt + slope * xs[n - 1];
      var z = (series[i].value - pred) / sigma;
      if (z >= p.s1k) {
        acc.push({
          fam: 'S1', start: series[i - 1].date, end: series[i].date, z: round(z, 2), gap: days(series[i - 1].date, series[i].date),
          before: series[i - 1], after: series[i], persistence: 'ei sovellu',
          conf: 0.25 + 0.25 * clip((z - p.s1k) / p.s1k), // De Vroey: tutka 0–0,5
          notes: ['sade voi peittää koherenssin nousun (Tamm ym. 2016)'], changed: null
        });
      }
    }
    return { acc: acc, rej: [] };
  }

  // Lineaarisovite: palauttaa { slope, icpt, sigma, t0, xs }.
  function linfit(prev, floor) {
    var t0 = Date.parse(prev[0].date) / 864e5;
    var xs = prev.map(function (o) { return Date.parse(o.date) / 864e5 - t0; });
    var ys = prev.map(function (o) { return o.value; });
    var n = xs.length, mx = 0, my = 0, j;
    for (j = 0; j < n; j++) { mx += xs[j] / n; my += ys[j] / n; }
    var sxx = 0, sxy = 0;
    for (j = 0; j < n; j++) { sxx += (xs[j] - mx) * (xs[j] - mx); sxy += (xs[j] - mx) * (ys[j] - my); }
    var slope = sxx > 0 ? sxy / sxx : 0, icpt = my - slope * mx, ss = 0;
    for (j = 0; j < n; j++) { var r = ys[j] - (icpt + slope * xs[j]); ss += r * r; }
    return { slope: slope, icpt: icpt, t0: t0, xs: xs, sigma: Math.max(floor, Math.sqrt(ss / Math.max(1, n - 2))) };
  }

  // Tutkan kuvausgeometria tunnisteesta: "ASC"/"DESC" tai "rata 22". Takaisinsirontaa verrataan vain
  // saman geometrian havaintoihin, koska tulokulma ja suunta muuttavat tasoa.
  function trackOf(o) {
    var id = String(o.id || ''), m = /\brata\s*(\d+)/i.exec(id);
    if (m) return 'rata ' + m[1];
    m = /\b(ASC|DESC)\b/i.exec(id);
    return m ? m[1].toUpperCase() : 'kaikki';
  }

  // Tutkailmaisin 2: VH-takaisinsironnan (dB) lasku saman kuvausgeometrian trendistä.
  // Niitto poistaa kasvimassaa, jolloin tilavuussironta ja VH heikkenevät; sade ja maan
  // kosteus muuttavat tasoa myös, joten signaali on vain tukinäyttöä (luottamus 0,2–0,4).
  function s1bDetect(series, p) {
    var groups = {}, acc = [];
    series.forEach(function (o) { var k = trackOf(o); (groups[k] = groups[k] || []).push(o); });
    Object.keys(groups).forEach(function (k) {
      var g = groups[k];
      for (var i = p.s1bMinPrev; i < g.length; i++) {
        var prev = g.slice(Math.max(0, i - p.s1Window), i);
        var gap = days(g[i - 1].date, g[i].date);
        if (prev.length < p.s1bMinPrev || gap > p.maxGap) continue;
        var f = linfit(prev, p.s1bSigmaFloor);
        var pred = f.icpt + f.slope * f.xs[f.xs.length - 1];
        var drop = pred - g[i].value, z = drop / f.sigma;
        if (drop >= p.s1bDrop && z >= p.s1bK) {
          acc.push({
            fam: 'S1B', track: k, start: g[i - 1].date, end: g[i].date, z: round(z, 2), drop: round(drop, 2), gap: gap,
            before: g[i - 1], after: g[i], persistence: 'ei sovellu',
            conf: 0.2 + 0.2 * clip((z - p.s1bK) / p.s1bK),
            notes: ['sade, kaste ja maan kosteus muuttavat takaisinsirontaa, joten tutkan lasku on vain tukinäyttöä'], changed: null
          });
        }
      }
    });
    return { acc: acc, rej: [] };
  }

  // Optinen ilmaisin, Ruokaviraston tapa: NDVI-pudotus suhteessa trendiin. Trendi sovitetaan edellisen
  // trendWindow vuorokauden saman perheen havaintoihin; pudotuksen on ylitettävä sekä ndviDrop että
  // trendK·σ (trendi ± hajonta -kaista). Alle kolmella havainnolla verrataan edelliseen havaintoon.
  // Hidas lasku (tuleentuminen, kuivuus) siirtää trendiä, joten se ei laukaise ilmaisinta yhtä helposti.
  function trendDetect(series, fam, p) {
    var acc = [], rej = [];
    for (var i = 1; i < series.length; i++) {
      var a = series[i - 1], b = series[i], gap = days(a.date, b.date);
      var prev = series.slice(0, i).filter(function (o) { return days(o.date, b.date) <= p.trendWindow; });
      var expected, sigma, mode;
      if (prev.length >= 3) {
        var f = linfit(prev, p.trendSigmaFloor);
        var tb = Date.parse(b.date) / 864e5 - f.t0, tl = f.xs[f.xs.length - 1];
        expected = f.icpt + f.slope * Math.min(tb, tl + p.trendLead);
        expected = Math.min(expected, Math.max.apply(null, prev.map(function (o) { return o.value; })));
        sigma = f.sigma; mode = 'trendi';
      } else { expected = a.value; sigma = p.trendSigmaFloor; mode = 'edellinen'; }
      var thr = Math.max(p.ndviDrop, p.trendK * sigma), drop = expected - b.value;
      if (drop < thr) continue;
      var base = { fam: fam, start: a.date, end: b.date, drop: round(drop, 3), expected: round(expected, 3), sigma: round(sigma, 3), threshold: round(thr, 3), mode: mode, gap: gap, before: a, after: b };
      if (gap > p.maxGap) { rej.push(Object.assign(base, { reason: 'havaintoväli ' + gap + ' vrk > ' + p.maxGap + ' vrk' })); continue; }
      var ps = persistOf(b, series[i + 1], expected - thr / 2, p), persistence = ps.s;
      if (persistence === 'palautui') {
        rej.push(Object.assign(base, { reason: ps.why.replace('palautui', 'palautui trendin tasolle') + ', todennäköisesti pilvi, varjo tai usva' }));
        continue;
      }
      var conf = 0.5 + 0.5 * clip((drop - thr) / 0.25);
      var dq = doubts(drop, a, b, p), notes = dq.notes; conf *= dq.f;
      if (persistence === 'ei varmistettu') { conf *= 0.85; notes.push('pysyvyyttä ei voitu varmistaa (ei havaintoa ' + p.persistWindow + ' vrk sisällä)'); }
      if (gap > p.warnGap) { conf *= 0.9; notes.push('väli ' + gap + ' vrk: hidas muutos voi olla myös tuleentumista tai kuivuutta'); }
      acc.push(Object.assign(base, { persistence: persistence, conf: conf, notes: notes, changed: b.changed != null && !isNaN(b.changed) ? b.changed : null }));
    }
    return { acc: acc, rej: rej };
  }

  function overlap(a, b) { return a.start <= b.end && b.start <= a.end; }

  // Päällekkäiset tunnistukset yhdistetään yhdeksi tapahtumaksi (De Vroey: S1, S2 tai S1+S2).
  function merge(dets, p) {
    var sorted = dets.slice().sort(function (a, b) { return b.conf - a.conf; });
    var events = [];
    sorted.forEach(function (d) {
      var hit = null;
      for (var i = 0; i < events.length; i++) if (overlap(events[i], d)) { hit = events[i]; break; }
      if (!hit) {
        events.push({ start: d.start, end: d.end, conf: d.conf, fams: [d.fam], dets: [d] });
      } else {
        var s = d.start > hit.start ? d.start : hit.start, e = d.end < hit.end ? d.end : hit.end;
        if (s <= e) { hit.start = s; hit.end = e; }        // tarkennetaan leikkaukseen
        if (hit.fams.indexOf(d.fam) < 0) { hit.fams.push(d.fam); hit.conf = Math.min(1, hit.conf + 0.15 * d.conf / 0.5); }
        hit.dets.push(d);
      }
    });
    // Δt_min: lähempänä kuin 28 vrk olevista pidetään varmempi
    events.sort(function (a, b) { return b.conf - a.conf; });
    var kept = [];
    events.forEach(function (ev) {
      var clash = kept.some(function (k) { return Math.abs(days(k.end, ev.end)) < p.minSeparation; });
      if (!clash) kept.push(ev);
    });
    kept = kept.slice(0, p.maxEvents);
    kept.forEach(function (ev) { ev.conf = round(ev.conf, 2); ev.fams.sort(); });
    kept.sort(function (a, b) { return a.start < b.start ? -1 : 1; });
    return kept;
  }

  function checkRule(ev, rule, p, post) {
    var checks = [];
    if (rule.latest && post && post.n < p.postDeadline && days(ev.end, post.deadline) < 21) {
      checks.push({ s: 'warn', t: 'Määräpäivän ' + fiMD(rule.latest) + ' jälkeen ' + (post.n ? 'vain ' + post.n + ' selkeä kuva' : 'ei yhtään selkeää kuvaa') + ': jatka hakujaksoa, jotta nähdään, pysyykö NDVI matalana' });
    }
    if (rule.latest) {
      if (mmdd(ev.end) <= rule.latest) checks.push({ s: 'ok', t: 'Niitto ennen määräpäivää ' + fiMD(rule.latest) });
      else if (mmdd(ev.start) <= rule.latest) checks.push({ s: 'warn', t: 'Niittoväli ulottuu määräpäivän ' + fiMD(rule.latest) + ' yli, ajoitus epävarma' });
      else checks.push({ s: 'fail', t: 'Niitto vasta määräpäivän ' + fiMD(rule.latest) + ' jälkeen' });
    }
    if (rule.earliest) {
      if (mmdd(ev.start) >= rule.earliest) checks.push({ s: 'ok', t: 'Niitto aikaisintaan ' + fiMD(rule.earliest) });
      else if (mmdd(ev.end) >= rule.earliest) checks.push({ s: 'warn', t: 'Niittoväli alkaa ennen ' + fiMD(rule.earliest) + ', ajoitus epävarma' });
      else checks.push({ s: 'fail', t: 'Niitto ennen sallittua ajankohtaa ' + fiMD(rule.earliest) });
    }
    var opt = ev.dets.filter(function (d) { return !isRadar(d.fam); });
    var ch = opt.map(function (d) { return d.changed; }).filter(function (x) { return x != null; });
    if (!ch.length) checks.push({ s: 'warn', t: 'Muuttuneiden pikselien osuutta ei annettu, joten koko lohkon niittoa ei voi todeta' });
    else {
      var mx = Math.max.apply(null, ch);
      if (mx >= p.minChanged) checks.push({ s: 'ok', t: 'Muuttunut osuus ' + mx + ' % (vaatimus ≥ ' + p.minChanged + ' %)' });
      else if (mx >= 50) checks.push({ s: 'warn', t: 'Muuttunut osuus ' + mx + ' %: lohko mahdollisesti vain osittain niitetty' });
      else checks.push({ s: 'fail', t: 'Muuttunut osuus vain ' + mx + ' %: niitto ei kata lohkoa' });
    }
    if (ev.fams.length > 1) checks.push({ s: 'ok', t: 'Useampi riippumaton lähde vahvistaa (' + ev.fams.map(nameOf).join(' + ') + ')' });
    // Vain päätunnistuksen (varmin optinen, muuten tutka) huomautukset vaikuttavat näytön tasoon.
    // Tukihavaintojen huomautukset näytetään tietona.
    var primary = primaryDet(ev);
    ev.dets.forEach(function (d) {
      (d.notes || []).forEach(function (n) { checks.push({ s: d === primary ? 'warn' : 'info', t: nameOf(d.fam) + ': ' + n }); });
    });
    return checks;
  }

  var NAMES = { HLS: 'HLS', S2: 'Sentinel-2', PS: 'PlanetScope', S1: 'Sentinel-1-koherenssi', S1B: 'Sentinel-1-takaisinsironta' };
  function nameOf(f) { return NAMES[f] || f; }
  function primaryDet(ev) {
    var opt = ev.dets.filter(function (d) { return !isRadar(d.fam); }).sort(function (x, y) { return y.conf - x.conf; });
    return opt[0] || ev.dets.slice().sort(function (x, y) { return y.conf - x.conf; })[0];
  }

  function huom(n) { return n + (n === 1 ? ' huomautus' : ' huomautusta'); }

  function fiMD(md) { var p = md.split('-'); return (+p[1]) + '.' + (+p[0]) + '.'; }
  function fi(d) { var p = d.split('-'); return (+p[2]) + '.' + (+p[1]) + '.' + p[0]; }

  // Selkeät optiset kuvat määräpäivän jälkeen.
  function postDeadline(used, rule) {
    if (!rule.latest || !used.length) return null;
    var dl = used[0].date.slice(0, 4) + '-' + rule.latest;
    var after = used.filter(function (o) { return !isRadar(o.fam) && o.date > dl; }).map(function (o) { return o.date; });
    return { deadline: dl, n: after.filter(function (d, i) { return after.indexOf(d) === i; }).length };
  }

  function analyze(obs, opts) {
    var p = Object.assign({}, DEFAULTS, opts || {});
    var rule = RULES[p.measure] || RULES['Luonnonhoitonurmi'];
    var prep = prepare(obs, p);
    var byFam = {};
    prep.used.forEach(function (o) { (byFam[o.fam] = byFam[o.fam] || []).push(o); });
    var dets = [], rejected = [];
    Object.keys(byFam).forEach(function (f) {
      var r = f === 'S1' ? s1Detect(byFam[f], p) : f === 'S1B' ? s1bDetect(byFam[f], p) : opticalDetect(byFam[f], f, p);
      dets = dets.concat(r.acc); rejected = rejected.concat(r.rej);
    });
    var events = merge(dets, p), post = postDeadline(prep.used, rule);
    events.forEach(function (ev) { ev.accepted = ev.conf >= p.confMin; ev.checks = checkRule(ev, rule, p, post); });
    var accepted = events.filter(function (e) { return e.accepted; });
    // Tukiehtoon arvioidaan varmin hyväksytty tapahtuma, jossa ei ole hylkääviä tarkistuksia
    var best = null, bestF = 0;
    accepted.forEach(function (e) {
      var fails = e.checks.filter(function (c) { return c.s === 'fail'; }).length;
      if (!best || fails < bestF || (fails === bestF && e.conf > best.conf)) { best = e; bestF = fails; }
    });
    var verdict;
    if (!best) verdict = { level: 'none', label: 'Niittoa ei tunnistettu', detail: 'Yksikään tapahtuma ei ylittänyt todennäköisyysrajaa ' + p.confMin + '.' };
    else {
      var nf = best.checks.filter(function (c) { return c.s === 'fail'; }).length;
      var nw = best.checks.filter(function (c) { return c.s === 'warn'; }).length;
      if (nf) verdict = { level: 'fail', label: 'Niitto tunnistettu, mutta tukiehto ei täyty', detail: nf + (nf === 1 ? ' hylkäävä tarkistus' : ' hylkäävää tarkistusta') };
      else if (nw === 0) verdict = { level: 'strong', label: 'Vahva näyttö niitosta', detail: 'Kaikki tarkistukset kunnossa' };
      else if (nw <= 2) verdict = { level: 'moderate', label: 'Kohtalainen näyttö niitosta', detail: huom(nw) + ' päätunnistuksessa' };
      else verdict = { level: 'weak', label: 'Heikko näyttö niitosta', detail: huom(nw) + ' päätunnistuksessa' };
    }
    return { version: VERSION, params: p, rule: rule, used: prep.used, excluded: prep.excluded, rejected: rejected, events: events, best: best, verdict: verdict, post: post };
  }

  // ---------- HLS:n ja Sentinel-2 L2A:n yhdistäminen ----------
  // HLS-S30 ja L2A ovat samoja Sentinel-2-kuvauksia eri käsittelyllä. Pääsarja on HLS (S30 + L30);
  // L2A täyttää päivät, joilta HLS-S30-granuli puuttuu. Jos saman päivän maskit ovat ristiriidassa
  // (toinen hylkää kuvan pilvenä, toinen pitää sitä selkeänä) tai arvot poikkeavat, havainto merkitään
  // epävarmaksi. Ilman HLS-havaintoja L2A on pääsarja sellaisenaan.
  function fuse(obs, opts) {
    var p = Object.assign({}, DEFAULTS, opts || {});
    var ok = function (o) { return o && typeof o.value === 'number' && !isNaN(o.value) && (o.valid == null || isNaN(o.valid) || o.valid >= p.minValid); };
    var hls = obs.filter(function (o) { return o && o.src === 'HLS-S30'; }), l2a = obs.filter(function (o) { return o && o.src === 'Sentinel-2'; });
    var info = { filled: 0, conflicts: 0, mode: hls.length ? 'HLS + L2A' : 'L2A' };
    if (!hls.length || !l2a.length) return { obs: obs.slice(), info: info };
    var byDate = {};
    l2a.forEach(function (o) { if (!byDate[o.date] || (ok(o) && !ok(byDate[o.date]))) byDate[o.date] = o; });
    var hDates = {}, out = [];
    obs.forEach(function (o) {
      if (!o || o.src === 'Sentinel-2') return;
      if (o.src !== 'HLS-S30') { out.push(o); return; }
      hDates[o.date] = true;
      var s = byDate[o.date], c = null;
      if (s && ok(o) !== ok(s)) c = 'maskit ristiriidassa: ' + (ok(o) ? 'HLS Fmask selkeä, L2A SCL hylkää (' + s.valid + ' %)' : 'L2A SCL selkeä, HLS Fmask hylkää (' + o.valid + ' %)');
      else if (s && ok(o) && ok(s) && Math.abs(o.value - s.value) > p.fuseConflict) c = 'HLS ja L2A poikkeavat (' + o.value.toFixed(2) + ' vs ' + s.value.toFixed(2) + ')';
      if (c) info.conflicts++;
      if (!ok(o) && s && ok(s)) { info.filled++; out.push(Object.assign({}, s, { src: 'Sentinel-2 L2A (HLS-täydennys)', conflict: c })); }
      else out.push(c ? Object.assign({}, o, { conflict: c }) : o);
    });
    l2a.forEach(function (s) {
      if (hDates[s.date] || byDate[s.date] !== s) return;
      out.push(ok(s) ? Object.assign({}, s, { src: 'Sentinel-2 L2A (HLS-täydennys)' }) : s);
      if (ok(s)) info.filled++;
    });
    out.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    return { obs: out, info: info };
  }

  // ---------- Lähdevertailu ----------
  // Ajaa saman tunnistuksen kullekin lähdeyhdistelmälle ja vertaa, kuinka tiheästi lohko nähtiin,
  // tunnistettiinko niitto ja kuinka tarkasti sen ajankohta rajautui (niittovälin pituus).
  var SCENARIOS = [
    { key: 'S2', label: 'Sentinel-2 L2A', srcs: ['Sentinel-2'] },
    { key: 'HLS-S30', label: 'HLS ilman Landsatia (S30)', srcs: ['HLS-S30'], needs: ['HLS-L30'] },
    { key: 'HLS', label: 'HLS (Sentinel-2 + Landsat)', srcs: ['HLS-S30', 'HLS-L30'] },
    { key: 'PS', label: 'PlanetScope', srcs: ['PlanetScope'] },
    { key: 'S2+PS', label: 'Sentinel-2 + PlanetScope', srcs: ['Sentinel-2', 'PlanetScope'] },
    { key: 'HLS+PS', label: 'HLS + PlanetScope', srcs: ['HLS-S30', 'HLS-L30', 'PlanetScope'] },
    { key: 'ALL', label: 'HLS + PlanetScope + Sentinel-1', srcs: ['HLS-S30', 'HLS-L30', 'PlanetScope', 'Sentinel-1 koherenssi', 'Sentinel-1 VH'] }
  ];
  function gapStats(dates) {
    var u = dates.filter(function (d, i) { return dates.indexOf(d) === i; }).sort(), g = [];
    for (var i = 1; i < u.length; i++) g.push(days(u[i - 1], u[i]));
    if (!g.length) return { n: u.length, median: null, max: null };
    var s = g.slice().sort(function (a, b) { return a - b; }), m = s.length >> 1;
    return { n: u.length, median: s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2, max: s[s.length - 1] };
  }
  function compareSources(obs, opts) {
    var p = Object.assign({}, DEFAULTS, opts || {});
    var present = {};
    prepare(obs, p).used.forEach(function (o) { present[o.src] = true; });
    var famsPresent = {};
    Object.keys(present).forEach(function (s) { famsPresent[FAMILY[s]] = true; });
    var rows = [];
    SCENARIOS.forEach(function (sc) {
      var fams = {}; sc.srcs.forEach(function (s) { fams[FAMILY[s]] = true; });
      // jokaisen perheen on oltava mukana, ja HLS vaatii vähintään yhden HLS-lähteen
      if (!Object.keys(fams).every(function (f) { return isRadar(f) || famsPresent[f]; })) return;
      if ((sc.needs || []).some(function (s) { return !present[s]; })) return;
      if (sc.key === 'ALL' && (!famsPresent.PS || !(famsPresent.S1 || famsPresent.S1B))) return;
      var sub = obs.filter(function (o) { return o && sc.srcs.indexOf(o.src) >= 0; });
      var res = analyze(sub, p);
      var opt = res.used.filter(function (o) { return !isRadar(o.fam); });
      var g = gapStats(opt.map(function (o) { return o.date; }));
      var b = res.best;
      rows.push({ key: sc.key, label: sc.label, fams: Object.keys(fams).length, nObs: g.n, excluded: res.excluded.length,
        gapMedian: g.median, gapMax: g.max, detected: !!b, start: b ? b.start : null, end: b ? b.end : null,
        windowDays: b ? days(b.start, b.end) : null, conf: b ? b.conf : null, level: res.verdict.level, label2: res.verdict.label });
    });
    return { rows: rows, summary: compareSummary(rows) };
  }
  // Johtopäätös: verrataan jokaista vaihtoehtoa perustasoon, joka on pelkkä Sentinel-2
  // (sama aineisto kuin Ruokaviraston seurannassa) tai sen puuttuessa HLS S30.
  function compareSummary(rows) {
    if (rows.length < 2) return null;
    var base = rows.filter(function (r) { return r.key === 'S2'; })[0] || rows.filter(function (r) { return r.key === 'HLS-S30'; })[0] || rows[0];
    var others = rows.filter(function (r) { return r !== base && !(base.key === 'S2' && r.key === 'HLS-S30'); });
    var fiD = function (n) { return Math.round(n) + ' vrk'; }, c2 = function (x) { return x.toFixed(2).replace('.', ','); };
    var out = [];
    out.push(base.label + (base.detected ? ': niittoväli ' + fi(base.start) + '–' + fi(base.end) + ' (' + fiD(base.windowDays) + '), luottamus ' + c2(base.conf) + '.' : ' yksinään ei tunnistanut niittoa.'));
    var s2 = rows.filter(function (r) { return r.key === 'S2' || r.key === 'HLS-S30'; })[0], hls = rows.filter(function (r) { return r.key === 'HLS'; })[0];
    if (s2 && hls && s2.gapMedian != null && hls.gapMedian != null && hls.nObs > s2.nObs) {
      out.push('Landsat tihensi kuvausta: HLS:ssä ' + hls.nObs + ' kelvollista päivää, ' + (s2.key === 'S2' ? 'Sentinel-2:ssa ' : 'S30:ssä ') + s2.nObs + ' (mediaaniväli ' + fiD(hls.gapMedian) + ' vs ' + fiD(s2.gapMedian) + ').');
    }
    var det = others.filter(function (r) { return r.detected; }).sort(function (a, b) { return a.windowDays - b.windowDays || b.conf - a.conf; });
    var best = det[0] || null, verdict = 'same';
    if (!best) out.push('Muutkaan lähteet tai yhdistelmät eivät tunnistaneet niittoa.');
    else if (!base.detected) { verdict = 'better'; out.push('Niitto tunnistettiin vasta lisälähteillä: ' + best.label + ' (niittoväli ' + fiD(best.windowDays) + ').'); }
    else {
      var d = base.windowDays - best.windowDays;
      if (d >= 2) { verdict = 'better'; out.push(best.label + ' rajasi niiton ' + fiD(best.windowDays) + ' väliin, ' + fiD(d) + ' tarkemmin kuin ' + base.label + '.'); }
      else if (best.conf > base.conf + 0.05) { verdict = 'better'; out.push('Lisälähteet eivät kaventaneet niittoväliä, mutta nostivat luottamusta ' + c2(base.conf) + ' → ' + c2(best.conf) + ' (' + best.label + ').'); }
      else out.push('Lisälähteet eivät kaventaneet niittoväliä eivätkä nostaneet luottamusta.');
    }
    others.filter(function (r) { return !r.detected && base.detected; }).forEach(function (r) { out.push(r.label + ' ei tunnistanut niittoa.'); });
    return { verdict: verdict, base: base.key, best: best ? best.key : null, text: out };
  }


  // ---------- Ruokaviraston kaltainen seuranta ----------
  // Rakenne Ruokaviraston ja CGI:n julkisten kuvausten mukaan: lohkon aikasarja (Sentinel-2 NDVI
  // 2–4 vrk välein, Sentinel-1 tutka 12 vrk välein), NDVI-pudotus suhteessa trendiin (trendi ± hajonta),
  // tulos päivittäin, liikennevalo ja luotettavuustaso. Ruokaviraston koneoppimismallia ei ole julkaistu,
  // joten luokittelu tehdään läpinäkyvillä säännöillä. Sama laskenta ajetaan HLS:lle ja PlanetScopelle.
  var LIGHTS = { green: 'vihreä', yellow: 'keltainen', red: 'punainen' };

  function addDays(d, n) { return new Date(Date.parse(d) + n * 864e5).toISOString().slice(0, 10); }

  // Optisten havaintojen aukot jaksolla [from, to]. Aukko > warnGap vrk on katvejakso:
  // niitto voi jäädä siinä näkemättä, koska nurmi ehtii vihertyä takaisin.
  function coverage(dates, from, to, p) {
    var u = dates.filter(function (d, i) { return d >= from && d <= to && dates.indexOf(d) === i; }).sort();
    var pts = [from].concat(u, [to]), gaps = [], katve = [], seen = 0, total = Math.max(1, days(from, to));
    for (var i = 1; i < pts.length; i++) {
      var g = days(pts[i - 1], pts[i]);
      if (g <= 0) continue;
      gaps.push(g);
      seen += Math.min(g, p.seeGap);
      if (g > p.warnGap) katve.push({ from: pts[i - 1], to: pts[i], days: g, edge: i === 1 || i === pts.length - 1 });
    }
    return { n: u.length, maxGap: gaps.length ? Math.max.apply(null, gaps) : total, katve: katve, katveDays: katve.reduce(function (s, k) { return s + k.days; }, 0), pct: Math.round(Math.min(1, seen / total) * 100) };
  }

  function reliabilityOf(light, ev, cov, p) {
    if (light === 'green' || (light === 'red' && ev)) {
      var prim = primaryDet(ev), timingWarn = ev.checks.some(function (c) { return c.s === 'warn' && /ajoitus|tuleentum/.test(c.t); });
      if (ev.conf >= 0.8 && (ev.fams.length > 1 || (prim && prim.persistence === 'pysyvä')) && !timingWarn) return 'Korkea';
      return timingWarn || ev.conf < 0.7 ? 'Matala' : 'Keskitaso';
    }
    if (light === 'red') return cov.maxGap <= p.seeGap ? 'Korkea' : 'Keskitaso';
    return 'Matala';
  }

  function monitorCore(obs, p, rule) {
    var prep = prepare(obs, p), byFam = {};
    prep.used.forEach(function (o) { if (!p.end || o.date <= p.end) (byFam[o.fam] = byFam[o.fam] || []).push(o); });
    var dets = [], rejected = [];
    Object.keys(byFam).forEach(function (f) {
      var r = f === 'S1' ? s1Detect(byFam[f], p) : f === 'S1B' ? s1bDetect(byFam[f], p) : trendDetect(byFam[f], f, p);
      dets = dets.concat(r.acc); rejected = rejected.concat(r.rej);
    });
    var events = merge(dets, p);
    var used0 = [].concat.apply([], Object.keys(byFam).map(function (f) { return byFam[f]; })).sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    var post = postDeadline(used0, rule);
    events.forEach(function (ev) { ev.accepted = ev.conf >= p.confMin; ev.checks = checkRule(ev, rule, p, post); });
    var used = [].concat.apply([], Object.keys(byFam).map(function (f) { return byFam[f]; })).sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    return { prep: prep, used: used, dets: dets, rejected: rejected, events: events, post: post };
  }

  function classify(core, p, rule, from, to) {
    var opt = core.used.filter(function (o) { return !isRadar(o.fam); }), radar = core.used.filter(function (o) { return isRadar(o.fam); });
    var year = (from || (core.used[0] || {}).date || '2000').slice(0, 4);
    var deadline = rule.latest ? year + '-' + rule.latest : null;
    var start = from || (core.used[0] ? core.used[0].date : null), end = to || (core.used.length ? core.used[core.used.length - 1].date : null);
    var horizon = deadline && end && end > deadline ? deadline : end;
    var cov = start && horizon && horizon > start ? coverage(opt.map(function (o) { return o.date; }), start, horizon, p) : { n: opt.length, maxGap: null, katve: [], katveDays: 0, pct: 0 };
    var acc = core.events.filter(function (e) { return e.accepted; }), best = null, bestF = 0;
    acc.forEach(function (e) {
      var nf = e.checks.filter(function (c) { return c.s === 'fail'; }).length;
      if (!best || nf < bestF || (nf === bestF && e.conf > best.conf)) { best = e; bestF = nf; }
    });
    var maybe = core.events.filter(function (e) { return !e.accepted; }).sort(function (a, b) { return b.conf - a.conf; })[0] || null;
    var light, label, why = [];
    var nPost = core.post ? core.post.n : 0;
    var ended = !deadline || (end && end >= deadline && nPost >= p.postDeadline);
    if (best && !bestF) {
      light = 'green'; label = 'Niitto havaittu';
      why.push('Kasvusto väheni ' + fi(best.start) + '–' + fi(best.end) + ' (' + best.fams.map(nameOf).join(' + ') + ').');
    } else if (best) {
      light = 'red'; label = 'Niitto havaittu, mutta ehto ei täyty';
      why.push(best.checks.filter(function (c) { return c.s === 'fail'; }).map(function (c) { return c.t; }).join('. ') + '.');
    } else if (maybe) {
      light = 'yellow'; label = 'Mahdollinen niitto, ei varmistettu';
      why.push('Heikko signaali ' + fi(maybe.start) + '–' + fi(maybe.end) + ' (' + maybe.fams.map(nameOf).join(' + ') + ', luottamus ' + String(maybe.conf).replace('.', ',') + ') jäi alle rajan ' + String(p.confMin).replace('.', ',') + '.');
    } else if (!opt.length) {
      light = 'yellow'; label = 'Ei voitu todeta';
      why.push('Lohkolta ei saatu yhtään kelvollista optista havaintoa.');
    } else if (cov.katve.length) {
      light = 'yellow'; label = 'Ei voitu todeta';
      why.push('Niittoa ei havaittu, mutta kuvissa on katvejaksoja, joissa niitto olisi voinut jäädä näkemättä: ' + cov.katve.map(function (k) { return fi(k.from) + '–' + fi(k.to) + ' (' + Math.round(k.days) + ' vrk)'; }).join(', ') + '.');
    } else if (!ended) {
      light = 'yellow'; label = 'Niittoa ei ole vielä havaittu';
      why.push(end && end >= deadline ? 'Määräpäivän ' + fi(deadline) + ' jälkeen ' + nPost + ' selkeää kuvaa; tarvitaan vähintään ' + p.postDeadline + ', jotta niiton puuttuminen voidaan todeta.' : 'Seuranta jatkuu määräpäivään ' + fi(deadline) + ' asti ja vähintään ' + p.postDeadline + ' selkeään kuvaan sen jälkeen.');
    } else {
      light = 'red'; label = 'Niittoa ei havaittu';
      why.push('Lohko kuvattiin koko jakson ajan (pisin väli ' + Math.round(cov.maxGap) + ' vrk), eikä kasvustossa näkynyt niiton kaltaista pudotusta.');
    }
    if (radar.length && cov.katve.length && light !== 'green') {
      var inK = radar.filter(function (o) { return cov.katve.some(function (k) { return o.date > k.from && o.date < k.to; }); }).length;
      if (inK) why.push('Sentinel-1 kuvasi katvejaksoilla ' + inK + ' kertaa, mutta tutka ei yksin riitä varmistamaan niittoa.');
    }
    var ev = best || null;
    return { light: light, lightFi: LIGHTS[light], label: label, reliability: reliabilityOf(light, ev, cov, p), why: why, event: ev, maybe: maybe,
      coverage: cov, deadline: deadline, start: start, end: end, nOptical: opt.length, nRadar: radar.length };
  }

  // Päivittäinen tila: jaksot (from–to) tiloissa 'seurannassa', 'katve', 'niitto' ja 'niitetty'.
  function dailySegments(cls) {
    if (!cls.start || !cls.end) return [];
    var segs = [], cur = null, ev = cls.event;
    for (var d = cls.start; d <= cls.end; d = addDays(d, 1)) {
      var st = 'seurannassa';
      if (ev && d >= ev.start && d <= ev.end) st = 'niitto';
      else if (ev && d > ev.end) st = 'niitetty';
      else if (cls.coverage.katve.some(function (k) { return d > k.from && d < k.to; })) st = 'katve';
      if (cur && cur.state === st) cur.to = d; else { cur = { from: d, to: d, state: st }; segs.push(cur); }
    }
    return segs;
  }

  function monitor(obs, opts) {
    var p = Object.assign({}, DEFAULTS, opts || {});
    var rule = RULES[p.measure] || RULES['Luonnonhoitonurmi'];
    var core = monitorCore(obs, p, rule);
    var cls = classify(core, p, rule, p.start || null, p.end || null);
    // Tulos päivittäin: luokitus lasketaan jokaisen havaintopäivän tiedoilla (kuten päivittyvä tulos Vipussa).
    var history = [];
    if (!p._noHistory) {
      var ds = core.used.map(function (o) { return o.date; }).filter(function (d, i, a) { return a.indexOf(d) === i; });
      ds.forEach(function (d) {
        var q = Object.assign({}, p, { end: d, _noHistory: true });
        var c = classify(monitorCore(obs, q, rule), q, rule, p.start || null, d);
        var last = history[history.length - 1];
        if (!last || last.light !== c.light || last.label !== c.label) history.push({ date: d, light: c.light, label: c.label, reliability: c.reliability });
      });
    }
    var signals = core.dets.map(function (d) {
      var t = d.fam === 'S1' ? 'VH-koherenssi nousi (z = ' + d.z + ')' : d.fam === 'S1B' ? 'VH-takaisinsironta laski ' + String(d.drop).replace('.', ',') + ' dB (' + d.track + ', z = ' + d.z + ')' :
        'NDVI ' + d.after.value.toFixed(2) + ' alle trendin ' + d.expected.toFixed(2) + ' (raja ' + d.threshold.toFixed(2) + (d.mode === 'edellinen' ? ', verrattu edelliseen' : '') + ')';
      return { fam: d.fam, start: d.start, end: d.end, text: t.replace(/(\d)\.(\d)/g, '$1,$2'), conf: round(d.conf, 2) };
    }).sort(function (a, b) { return a.end < b.end ? -1 : 1; });
    var firstGreen = history.filter(function (h) { return h.light === 'green'; })[0];
    return Object.assign(cls, { version: VERSION, params: p, rule: rule, used: core.used, excluded: core.prep.excluded, rejected: core.rejected,
      events: core.events, signals: signals, daily: dailySegments(cls), history: history, firstGreen: firstGreen ? firstGreen.date : null });
  }

  // Sama seuranta lähde kerrallaan. Ensimmäinen rivi vastaa Ruokaviraston aineistoa (Sentinel-2 + Sentinel-1).
  var MON_SCENARIOS = [
    { key: 'RV', label: 'Sentinel-2 + Sentinel-1 (Ruokaviraston tapaan)', opt: ['Sentinel-2'], radar: true },
    { key: 'S2', label: 'Pelkkä Sentinel-2', opt: ['Sentinel-2'] },
    { key: 'S1', label: 'Pelkkä Sentinel-1', opt: [], radar: true },
    { key: 'HLS', label: 'HLS (Sentinel-2 + Landsat) + Sentinel-1', opt: ['HLS-S30', 'HLS-L30'], radar: true },
    { key: 'PS', label: 'PlanetScope + Sentinel-1', opt: ['PlanetScope'], radar: true },
    { key: 'ALL', label: 'Kaikki lähteet', opt: ['HLS-S30', 'HLS-L30', 'PlanetScope'], alt: ['Sentinel-2', 'PlanetScope'], radar: true }
  ];
  var RADAR_SRCS = ['Sentinel-1 koherenssi', 'Sentinel-1 VH'];
  var LIGHT_RANK = { green: 3, red: 2, yellow: 1 };
  var REL_RANK = { Korkea: 3, Keskitaso: 2, Matala: 1 };

  function monitorCompare(obs, opts) {
    var p = Object.assign({}, DEFAULTS, opts || {}), present = {};
    prepare(obs, p).used.forEach(function (o) { present[o.src] = true; });
    var hasRadar = RADAR_SRCS.some(function (s) { return present[s]; });
    var hasFam = function (srcs) { return srcs.some(function (s) { return present[s]; }); };
    var rows = [];
    MON_SCENARIOS.forEach(function (sc) {
      var optS = sc.opt;
      if (sc.key === 'ALL' && !hasFam(['HLS-S30', 'HLS-L30'])) optS = sc.alt;
      if (sc.key === 'S1' && !hasRadar) return;
      if (sc.key === 'RV' && !hasRadar) return;
      if (optS.length && !hasFam(optS)) return;
      if (sc.key === 'ALL') {
        var nf = (hasFam(['HLS-S30', 'HLS-L30']) || hasFam(['Sentinel-2']) ? 1 : 0) + (present.PlanetScope ? 1 : 0) + (hasRadar ? 1 : 0);
        if (nf < 3) return;
      }
      var srcs = optS.concat(sc.radar ? RADAR_SRCS : []);
      var m = monitor(obs.filter(function (o) { return o && srcs.indexOf(o.src) >= 0; }), p);
      var label = sc.radar && !hasRadar ? sc.label.replace(' + Sentinel-1', '') : sc.label;
      rows.push({ key: sc.key, label: label, light: m.light, lightFi: m.lightFi, status: m.label, reliability: m.reliability,
        start: m.event ? m.event.start : null, end: m.event ? m.event.end : null, conf: m.event ? m.event.conf : null,
        firstGreen: m.firstGreen, maxGap: m.coverage.maxGap, katveDays: Math.round(m.coverage.katveDays), pct: m.coverage.pct,
        nOptical: m.nOptical, nRadar: m.nRadar });
    });
    return { rows: rows, summary: monitorSummary(rows) };
  }

  function monitorSummary(rows) {
    var base = rows.filter(function (r) { return r.key === 'RV'; })[0] || rows.filter(function (r) { return r.key === 'S2'; })[0];
    if (!base) return null;
    var out = [];
    out.push(base.label + ': ' + base.lightFi + ' – ' + base.status.toLowerCase() + ', luotettavuus ' + base.reliability.toLowerCase() + '.');
    rows.forEach(function (r) {
      if (r === base || r.key === 'S2' || r.key === 'S1') return;
      var better = (LIGHT_RANK[r.light] > LIGHT_RANK[base.light] && r.light === 'green') ||
        (r.light === base.light && REL_RANK[r.reliability] > REL_RANK[base.reliability]);
      var earlier = r.firstGreen && base.firstGreen && r.firstGreen < base.firstGreen;
      var t = r.label + ': ' + r.lightFi + ', luotettavuus ' + r.reliability.toLowerCase();
      if (better) t += ' – parempi kuin ' + base.label.replace(/ \(.*\)/, '');
      else if (earlier) t += ' – niitto näkyi aiemmin (' + fi(r.firstGreen) + ' vs ' + fi(base.firstGreen) + ')';
      if (r.katveDays < base.katveDays) t += '; katvetta ' + r.katveDays + ' vrk (vs ' + base.katveDays + ')';
      out.push(t + '.');
    });
    var s1 = rows.filter(function (r) { return r.key === 'S1'; })[0];
    if (s1) out.push('Pelkkä Sentinel-1: ' + s1.lightFi + '. Tutka näkee pilvien läpi, mutta ei yksin riitä niiton varmistamiseen.');
    return { base: base.key, text: out };
  }

  // Lyhyt lisätietoteksti Vipu-mobiiliin. Varovainen muotoilu: "viittaavat", ei "todennettu".
  function reportText(res, lohko, measure) {
    var b = res.best;
    if (!b || res.verdict.level === 'fail' || res.verdict.level === 'none') return '';
    var opt = primaryDet(b); if (opt && isRadar(opt.fam)) opt = null;
    var parts = [];
    parts.push('Satelliittihavainnot viittaavat niittoon (' + res.verdict.label.toLowerCase() + ', luottamus ' + b.conf.toFixed(2).replace('.', ',') + ') kasvulohkolla ' + lohko + (measure ? ' (' + measure + ')' : '') + ' välillä ' + fi(b.start) + '–' + fi(b.end) + '.');
    if (opt) {
      parts.push(nameOf(opt.fam) + ': NDVI ' + opt.before.value.toFixed(2).replace('.', ',') + ' → ' + opt.after.value.toFixed(2).replace('.', ',') + (opt.changed != null ? ', muuttunut ' + opt.changed + ' % lohkosta' : '') + '.');
      parts.push('Kuvat: ' + (opt.before.id || '[tunniste]') + ', ' + (opt.after.id || '[tunniste]') + '.');
    }
    if (b.fams.indexOf('S1') >= 0) parts.push('Sentinel-1-koherenssi vahvistaa.');
    if (b.fams.indexOf('S1B') >= 0) parts.push('Sentinel-1-takaisinsironta tukee.');
    parts.push('Menetelmä: Niittoraportti ' + res.version + ' (Sen4CAP-tyyppinen muutostunnistus), puskuri ' + res.params.bufferM + ' m. Täydellinen raportti ja rajatut kuvat pyydettäessä.');
    return parts.join(' ');
  }

  var api = { VERSION: VERSION, FAMILY: FAMILY, SOURCES: SOURCES, RULES: RULES, DEFAULTS: DEFAULTS, analyze: analyze, reportText: reportText, fi: fi, compareSources: compareSources, SCENARIOS: SCENARIOS,
    monitor: monitor, monitorCompare: monitorCompare, fuse: fuse, MON_SCENARIOS: MON_SCENARIOS, isRadar: isRadar, _trendDetect: function (s, f, o) { return trendDetect(s, f, Object.assign({}, DEFAULTS, o || {})); },
    _s1bDetect: function (s, o) { return s1bDetect(s, Object.assign({}, DEFAULTS, o || {})); }, _coverage: function (d, a, b, o) { return coverage(d, a, b, Object.assign({}, DEFAULTS, o || {})); } };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NiittoCore = api;
})(this);
