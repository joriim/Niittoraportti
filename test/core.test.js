const assert = require('assert');
const C = require('../core.js');
let n = 0; function t(name, f) { f(); n++; console.log('ok', name); }

const mow = [
  { date: '2026-07-20', src: 'HLS-S30', id: 'a', value: 0.79, valid: 95 },
  { date: '2026-07-28', src: 'HLS-L30', id: 'b', value: 0.81, valid: 90 },
  { date: '2026-08-04', src: 'PlanetScope', id: 'p1', value: 0.84, valid: 100 },
  { date: '2026-08-11', src: 'PlanetScope', id: 'p2', value: 0.51, valid: 98, changed: 96 },
  { date: '2026-08-18', src: 'PlanetScope', id: 'p3', value: 0.58, valid: 99 },
  { date: '2026-08-14', src: 'HLS-S30', id: 'c', value: 0.49, valid: 92, changed: 93 },
];

t('tunnistaa niiton ja yhdistää lähteet', () => {
  const r = C.analyze(mow, { measure: 'Luonnonhoitonurmi' });
  assert.ok(r.best, 'paras tapahtuma');
  assert.deepStrictEqual(r.best.fams, ['HLS', 'PS']);
  assert.strictEqual(r.best.start, '2026-08-04');
  assert.strictEqual(r.best.end, '2026-08-11');
  assert.strictEqual(r.verdict.level !== 'fail' && r.verdict.level !== 'none', true);
});

t('sensoriraja: PS→HLS pudotus ei synny, koska perheet erikseen', () => {
  const r = C.analyze([
    { date: '2026-08-01', src: 'PlanetScope', value: 0.85 },
    { date: '2026-08-05', src: 'HLS-S30', value: 0.70 },
    { date: '2026-08-12', src: 'HLS-S30', value: 0.69 },
  ], {});
  assert.strictEqual(r.events.length, 0);
});

t('palautuva pudotus hylätään (pilvi)', () => {
  const r = C.analyze([
    { date: '2026-08-01', src: 'Sentinel-2', value: 0.80 },
    { date: '2026-08-04', src: 'Sentinel-2', value: 0.55 },
    { date: '2026-08-09', src: 'Sentinel-2', value: 0.79 },
  ], {});
  assert.strictEqual(r.events.length, 0);
  assert.strictEqual(r.rejected.length, 1);
});

t('liian vähän kelvollisia pikseleitä → havainto pois', () => {
  const r = C.analyze([
    { date: '2026-08-01', src: 'Sentinel-2', value: 0.80, valid: 90 },
    { date: '2026-08-04', src: 'Sentinel-2', value: 0.40, valid: 20 },
  ], {});
  assert.strictEqual(r.excluded.length, 1);
  assert.strictEqual(r.events.length, 0);
});

t('niitto 15.9. jälkeen → tukiehto ei täyty', () => {
  const r = C.analyze([
    { date: '2026-09-17', src: 'PlanetScope', value: 0.75 },
    { date: '2026-09-20', src: 'PlanetScope', value: 0.45, changed: 95 },
    { date: '2026-09-25', src: 'PlanetScope', value: 0.47 },
  ], { measure: 'Luonnonhoitonurmi' });
  assert.strictEqual(r.verdict.level, 'fail');
});

t('monimuotoisuuskasvi niitetty ennen 1.8. → ei täyty', () => {
  const r = C.analyze([
    { date: '2026-07-10', src: 'PlanetScope', value: 0.8 },
    { date: '2026-07-14', src: 'PlanetScope', value: 0.4, changed: 95 },
    { date: '2026-07-20', src: 'PlanetScope', value: 0.45 },
  ], { measure: 'Monimuotoisuuskasvi' });
  assert.strictEqual(r.verdict.level, 'fail');
});

t('osittainen niitto → huomautus tai hylkäys', () => {
  const r = C.analyze([
    { date: '2026-08-01', src: 'PlanetScope', value: 0.8 },
    { date: '2026-08-05', src: 'PlanetScope', value: 0.6, changed: 40 },
    { date: '2026-08-10', src: 'PlanetScope', value: 0.6 },
  ], {});
  assert.strictEqual(r.verdict.level, 'fail');
});

t('S1-koherenssi yksin ei ylitä rajaa 0,6, mutta vahvistaa optista', () => {
  const s1 = ['2026-07-01','2026-07-07','2026-07-13','2026-07-19','2026-07-25','2026-07-31','2026-08-06'].map((d,i)=>({date:d,src:'Sentinel-1 koherenssi',value:[0.20,0.21,0.19,0.20,0.22,0.21,0.55][i]}));
  const r1 = C.analyze(s1, {});
  assert.strictEqual(r1.events.length, 1);
  assert.strictEqual(r1.events[0].accepted, false);
  const r2 = C.analyze(s1.concat([
    { date: '2026-07-30', src: 'PlanetScope', value: 0.8 },
    { date: '2026-08-05', src: 'PlanetScope', value: 0.55, changed: 95 },
    { date: '2026-08-12', src: 'PlanetScope', value: 0.58 },
  ]), {});
  assert.ok(r2.best.fams.includes('S1') && r2.best.fams.includes('PS'));
});

t('kaksi niittoa ≥ 28 vrk välein säilyvät', () => {
  const r = C.analyze([
    { date: '2026-06-10', src: 'PlanetScope', value: 0.8 },
    { date: '2026-06-14', src: 'PlanetScope', value: 0.45, changed: 95 },
    { date: '2026-07-20', src: 'PlanetScope', value: 0.82 },
    { date: '2026-07-24', src: 'PlanetScope', value: 0.46, changed: 95 },
    { date: '2026-07-30', src: 'PlanetScope', value: 0.5 },
  ], {});
  assert.strictEqual(r.events.filter(e => e.accepted).length, 2);
});

t('raporttiteksti on varovainen ja sisältää tunnisteet', () => {
  const r = C.analyze(mow, { measure: 'Luonnonhoitonurmi' });
  const s = C.reportText(r, 'L-1', 'Luonnonhoitonurmi');
  assert.ok(s.startsWith('Satelliittihavainnot viittaavat niittoon'));
  assert.ok(!/todennettu/.test(s));
  assert.ok(s.includes('p1') && s.includes('p2'));
  console.log('   pituus', s.length, 'merkkiä');
});
console.log(n, 'testiä läpi');

t('tukihavaintojen huomautukset eivät heikennä vahvaa tapahtumaa', () => {
  const r = C.analyze([
    { date: '2026-07-23', src: 'HLS-L30', value: 0.80 },
    { date: '2026-08-13', src: 'HLS-S30', value: 0.50, changed: 94 },
    { date: '2026-08-04', src: 'PlanetScope', value: 0.84 },
    { date: '2026-08-11', src: 'PlanetScope', value: 0.51, changed: 96 },
    { date: '2026-08-16', src: 'PlanetScope', value: 0.55 },
  ], {});
  assert.strictEqual(r.verdict.level, 'strong');
  assert.ok(r.best.checks.some(c => c.s === 'info'));
});
console.log('lisätesti läpi');

t('näytön tason selite taipuu oikein', () => {
  const r = C.analyze([
    { date: '2026-07-01', src: 'HLS-S30', value: 0.80 },
    { date: '2026-07-20', src: 'HLS-S30', value: 0.45, changed: 95 },
    { date: '2026-07-25', src: 'HLS-S30', value: 0.47 },
  ], {});
  assert.strictEqual(r.verdict.level, 'moderate');
  assert.strictEqual(r.verdict.detail, '1 huomautus päätunnistuksessa');
});
console.log('taivutustesti läpi');

t('huomautusten taivutus: 1 huomautus, 2 huomautusta', () => {
  const one = C.analyze([
    { date: '2026-07-01', src: 'HLS-S30', value: 0.80, valid: 100 },
    { date: '2026-07-20', src: 'HLS-S30', value: 0.45, valid: 100, changed: 95 },
    { date: '2026-07-25', src: 'HLS-S30', value: 0.47, valid: 100 },
  ], {});
  assert.strictEqual(one.verdict.level, 'moderate');
  assert.match(one.verdict.detail, /^1 huomautus päätunnistuksessa$/);
});
console.log('taivutustesti läpi');

// ---------- Lähdevertailu ----------
// Keksitty kausi: niitto 6.8. Sentinel-2 näkee lohkon harvoin pilvien takia, Landsat ja PlanetScope tihentävät.
const season = [
  { date: '2026-07-10', src: 'Sentinel-2', id: 's1', value: 0.80, valid: 100 },
  { date: '2026-07-10', src: 'HLS-S30', id: 'h1', value: 0.78, valid: 100 },
  { date: '2026-07-28', src: 'Sentinel-2', id: 's2', value: 0.12, valid: 10 },   // pilvessä
  { date: '2026-07-28', src: 'HLS-S30', id: 'h2', value: 0.10, valid: 10 },
  { date: '2026-08-01', src: 'HLS-L30', id: 'l1', value: 0.79, valid: 95 },
  { date: '2026-08-09', src: 'HLS-L30', id: 'l2', value: 0.47, valid: 96, changed: 95 },
  { date: '2026-08-17', src: 'Sentinel-2', id: 's3', value: 0.50, valid: 100, changed: 96 },
  { date: '2026-08-17', src: 'HLS-S30', id: 'h3', value: 0.48, valid: 100, changed: 94 },
  { date: '2026-08-22', src: 'Sentinel-2', id: 's4', value: 0.53, valid: 100 },
  { date: '2026-08-22', src: 'HLS-S30', id: 'h4', value: 0.51, valid: 100 },
  { date: '2026-08-04', src: 'PlanetScope', id: 'p1', value: 0.84, valid: 100 },
  { date: '2026-08-07', src: 'PlanetScope', id: 'p2', value: 0.50, valid: 99, changed: 97 },
  { date: '2026-08-12', src: 'PlanetScope', id: 'p3', value: 0.55, valid: 98 },
];

t('lähdevertailu: skenaariot vain saatavilla oleville lähteille', () => {
  const only = C.compareSources(season.filter((o) => o.src === 'Sentinel-2' || o.src === 'HLS-S30'), {});
  assert.deepStrictEqual(only.rows.map((r) => r.key), ['S2', 'HLS']);
  const all = C.compareSources(season, {});
  assert.deepStrictEqual(all.rows.map((r) => r.key), ['S2', 'HLS-S30', 'HLS', 'PS', 'S2+PS', 'HLS+PS']);
});

t('lähdevertailu: lisälähteet kaventavat niittoväliä', () => {
  const r = C.compareSources(season, { measure: 'Luonnonhoitonurmi' });
  const by = Object.fromEntries(r.rows.map((x) => [x.key, x]));
  assert.strictEqual(by.S2.windowDays, 38);           // 10.7.–17.8.
  assert.strictEqual(by.HLS.windowDays, 8);           // Landsat: 1.8.–9.8.
  assert.strictEqual(by.PS.windowDays, 3);            // 4.8.–7.8.
  assert.ok(by.HLS.nObs > by.S2.nObs, 'Landsat tihentää');
  assert.ok(by.S2.gapMedian > by.HLS.gapMedian);
  assert.strictEqual(r.summary.verdict, 'better');
  assert.ok(r.summary.text.some((s) => /Landsat tihensi kuvausta/.test(s)));
  assert.strictEqual(r.summary.base, 'S2');
  assert.strictEqual(r.summary.best, 'S2+PS', 'yhdistelmä: sama 3 vrk väli kuin PlanetScopella, korkeampi luottamus');
  assert.ok(r.summary.text.some((s) => /Sentinel-2 \+ PlanetScope rajasi niiton 3 vrk väliin, 35 vrk tarkemmin/.test(s)));
});

t('lähdevertailu: sama tulos, jos lisälähde ei tuo uutta', () => {
  const same = [
    { date: '2026-07-01', src: 'HLS-S30', value: 0.80, valid: 100 },
    { date: '2026-07-06', src: 'HLS-S30', value: 0.45, valid: 100, changed: 95 },
    { date: '2026-07-11', src: 'HLS-S30', value: 0.47, valid: 100 },
    { date: '2026-07-01', src: 'PlanetScope', value: 0.82, valid: 100 },
    { date: '2026-07-06', src: 'PlanetScope', value: 0.46, valid: 100, changed: 96 },
    { date: '2026-07-11', src: 'PlanetScope', value: 0.48, valid: 100 },
  ];
  const r = C.compareSources(same, {});
  assert.strictEqual(r.summary.base, 'HLS', 'ilman Sentinel-2:ta ja Landsatia perustaso on HLS');
  assert.ok(['same', 'better'].includes(r.summary.verdict));
  assert.strictEqual(r.rows.find((x) => x.key === 'HLS+PS').windowDays, 5);
});
t('lähdevertailu: Landsat (HLS) tarkentaa pelkkää Sentinel-2:ta', () => {
  const r = C.compareSources(season.filter((o) => o.src !== 'PlanetScope'), {});
  assert.strictEqual(r.summary.verdict, 'better');
  assert.strictEqual(r.summary.best, 'HLS');
  assert.ok(r.summary.text.some((s) => /HLS \(Sentinel-2 \+ Landsat\) rajasi niiton 8 vrk väliin, 30 vrk tarkemmin/.test(s)));
});
console.log('lähdevertailutestit läpi');
