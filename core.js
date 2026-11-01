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

  var VERSION = '2.0.0';

  // Lähde → sensoriperhe. Pudotus lasketaan vain saman perheen havaintojen välillä,
  // koska eri sensoreiden NDVI-tasot eivät ole suoraan vertailukelpoisia.
  var FAMILY = {
    'HLS-S30': 'HLS',          // HLS on harmonisoitu: S30 ja L30 samaa sarjaa
    'HLS-L30': 'HLS',
    'Sentinel-2': 'S2',        // Sentinel-2 L2A sellaisenaan (ei HLS)
    'PlanetScope': 'PS',
    'Sentinel-1 koherenssi': 'S1'
  };
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
    minValid: 50,       // oma: kelvollisten pikselien vähimmäisosuus %, muuten havainto hylätään
    minChanged: 90,     // oma: tukiehto koskee koko lohkoa → ≥ 90 % pikseleistä muuttunut
    confMin: 0.6,       // oma todennäköisyysraja (vrt. Ruokaviraston status-kohtainen raja)
    bufferM: 10,        // raportoitava parametri; Kolecka ym. 2018: kutistettu lohko parantaa tulosta
    cloudMask: 'HLS: Fmask (sirrus, pilvi, pilven viereinen, varjo, lumi, aerosoli korkea); PlanetScope: UDM2 clear'
  };

  function days(a, b) { return (Date.parse(b) - Date.parse(a)) / 864e5; }
  function clip(x) { return Math.max(0, Math.min(1, x)); }
  function mmdd(d) { return d.slice(5); }
  function round(x, n) { var m = Math.pow(10, n); return Math.round(x * m) / m; }

  function prepare(obs, p) {
    var out = { used: [], excluded: [] };
    obs.forEach(function (o) {
      if (!o || !o.date || !/^\d{4}-\d{2}-\d{2}$/.test(o.date) || typeof o.value !== 'number' || isNaN(o.value)) return;
      var fam = FAMILY[o.src];
      if (!fam) { out.excluded.push({ obs: o, reason: 'tuntematon lähde' }); return; }
      if (fam !== 'S1' && o.valid != null && !isNaN(o.valid) && o.valid < p.minValid) {
        out.excluded.push({ obs: o, reason: 'kelvollisia pikseleitä ' + o.valid + ' % < ' + p.minValid + ' %' });
        return;
      }
      if (fam !== 'S1' && (o.value < -1 || o.value > 1)) { out.excluded.push({ obs: o, reason: 'NDVI alueen −1…1 ulkopuolella' }); return; }
      if (fam === 'S1' && (o.value < 0 || o.value > 1)) { out.excluded.push({ obs: o, reason: 'koherenssi alueen 0…1 ulkopuolella' }); return; }
      out.used.push(Object.assign({}, o, { fam: fam }));
    });
    out.used.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
    return out;
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
      var c = series[i + 1], persistence;
      if (!c || days(b.date, c.date) > p.persistWindow) persistence = 'ei varmistettu';
      else if (c.value <= a.value - p.ndviDrop / 2) persistence = 'pysyvä';
      else persistence = 'palautui';
      if (persistence === 'palautui') {
        rej.push(Object.assign(base, { reason: 'NDVI palautui seuraavassa havainnossa (' + c.date + '), todennäköisesti pilvi, varjo tai usva' }));
        continue;
      }
      var conf = 0.5 + 0.5 * clip((drop - p.ndviDrop) / 0.25); // De Vroey: optinen 0,5–1
      var notes = [];
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

  function checkRule(ev, rule, p) {
    var checks = [];
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
    var opt = ev.dets.filter(function (d) { return d.fam !== 'S1'; });
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

  var NAMES = { HLS: 'HLS', S2: 'Sentinel-2', PS: 'PlanetScope', S1: 'Sentinel-1' };
  function nameOf(f) { return NAMES[f] || f; }
  function primaryDet(ev) {
    var opt = ev.dets.filter(function (d) { return d.fam !== 'S1'; }).sort(function (x, y) { return y.conf - x.conf; });
    return opt[0] || ev.dets.slice().sort(function (x, y) { return y.conf - x.conf; })[0];
  }

  function fiMD(md) { var p = md.split('-'); return (+p[1]) + '.' + (+p[0]) + '.'; }
  function fi(d) { var p = d.split('-'); return (+p[2]) + '.' + (+p[1]) + '.' + p[0]; }

  function analyze(obs, opts) {
    var p = Object.assign({}, DEFAULTS, opts || {});
    var rule = RULES[p.measure] || RULES['Luonnonhoitonurmi'];
    var prep = prepare(obs, p);
    var byFam = {};
    prep.used.forEach(function (o) { (byFam[o.fam] = byFam[o.fam] || []).push(o); });
    var dets = [], rejected = [];
    Object.keys(byFam).forEach(function (f) {
      var r = f === 'S1' ? s1Detect(byFam[f], p) : opticalDetect(byFam[f], f, p);
      dets = dets.concat(r.acc); rejected = rejected.concat(r.rej);
    });
    var events = merge(dets, p);
    events.forEach(function (ev) { ev.accepted = ev.conf >= p.confMin; ev.checks = checkRule(ev, rule, p); });
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
      if (nf) verdict = { level: 'fail', label: 'Niitto tunnistettu, mutta tukiehto ei täyty', detail: nf + ' hylkäävää tarkistusta' };
      else if (nw === 0) verdict = { level: 'strong', label: 'Vahva näyttö niitosta', detail: 'Kaikki tarkistukset kunnossa' };
      else if (nw <= 2) verdict = { level: 'moderate', label: 'Kohtalainen näyttö niitosta', detail: nw + ' huomautusta' };
      else verdict = { level: 'weak', label: 'Heikko näyttö niitosta', detail: nw + ' huomautusta' };
    }
    return { version: VERSION, params: p, rule: rule, used: prep.used, excluded: prep.excluded, rejected: rejected, events: events, best: best, verdict: verdict };
  }

  // Lyhyt lisätietoteksti Vipu-mobiiliin. Varovainen muotoilu: "viittaavat", ei "todennettu".
  function reportText(res, lohko, measure) {
    var b = res.best;
    if (!b || res.verdict.level === 'fail' || res.verdict.level === 'none') return '';
    var opt = primaryDet(b); if (opt && opt.fam === 'S1') opt = null;
    var parts = [];
    parts.push('Satelliittihavainnot viittaavat niittoon (' + res.verdict.label.toLowerCase() + ', luottamus ' + b.conf.toFixed(2).replace('.', ',') + ') kasvulohkolla ' + lohko + (measure ? ' (' + measure + ')' : '') + ' välillä ' + fi(b.start) + '–' + fi(b.end) + '.');
    if (opt) {
      parts.push(nameOf(opt.fam) + ': NDVI' + opt.before.value.toFixed(2).replace('.', ',') + ' → ' + opt.after.value.toFixed(2).replace('.', ',') + (opt.changed != null ? ', muuttunut ' + opt.changed + ' % lohkosta' : '') + '.');
      parts.push('Kuvat: ' + (opt.before.id || '[tunniste]') + ', ' + (opt.after.id || '[tunniste]') + '.');
    }
    if (b.fams.indexOf('S1') >= 0) parts.push('Sentinel-1-koherenssi vahvistaa.');
    parts.push('Menetelmä: Niittoraportti ' + res.version + ' (Sen4CAP-tyyppinen muutostunnistus), puskuri ' + res.params.bufferM + ' m. Täydellinen raportti ja rajatut kuvat pyydettäessä.');
    return parts.join(' ');
  }

  var api = { VERSION: VERSION, FAMILY: FAMILY, SOURCES: SOURCES, RULES: RULES, DEFAULTS: DEFAULTS, analyze: analyze, reportText: reportText, fi: fi };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.NiittoCore = api;
})(this);
