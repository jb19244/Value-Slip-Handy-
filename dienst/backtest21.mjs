// Tagesfilter fuer den DAX-Trend-Ausbruch: Laesst sich um 9:35 erkennen, welche Tage schlecht laufen?
// Merkmale (alle um 9:35 bekannt): Wochentag, Kursluecke am Morgen (mit/gegen die Trade-Richtung), Groesse der Eroeffnungsspanne,
// Schwankung gestern, gestrige Tagesrichtung (mit/gegen), Abstand zum 20-Tage-Schnitt (Trendstaerke), Lage der Eroeffnung in der gestrigen Spanne.
// Ehrlich gegen Ueberanpassung: Schwellen und "schlechteste Gruppe" werden NUR mit 2013-2019 bestimmt,
// geprueft wird danach mit 2020 bis heute, das die Auswahl nie gesehen hat. Ein Filter besteht nur, wenn
//  - die gestrichene Gruppe 2013-2019 klar schlechter war (Ø < 0 und t-Unterschied >= 2) UND
//  - die gestrichenen Trades 2020-heute zusammen im Minus liegen (der Filter haette dort Geld gespart) UND
//  - der Ø der behaltenen Trades 2020-heute hoeher ist als ohne Filter.
// Ergebnis: dienst/backtest-dtbfilter.json
import { writeFileSync } from 'node:fs';
import { INS, load, prep, apply, stats } from './backtest13.mjs';
const RULE = { fam: 'orb', id: 'orb_15_trend_range__1045_v20', len: 15, f: 'trend', st: 'range', tg: null, ex: 1045, open: 540, delay: 20 };
const dax = INS.find((x) => x.k === 'DAX'), D = prep(await load(dax), dax);
const T = [];
D.forEach((d, i) => { const a = apply(RULE, d, dax, D, i, false); if (!a || a.skip || a.r == null) return;
  const dir = d.prev.close > d.sma20 ? 1 : -1, rg = d.b.filter((x) => x.m >= 540 && x.m < 555), oh = Math.max(...rg.map((x) => x.h)), ol = Math.min(...rg.map((x) => x.l));
  const wd = new Date(d.day + 'T12:00:00Z').getUTCDay();
  T.push({ day: d.day, y: +d.day.slice(0, 4), r: a.r,
    f: { wochentag: wd, luecke: (d.open - d.prev.close) / d.atr * dir, spanne: (oh - ol) / d.atr, gesternSchwankung: (d.prev.hi - d.prev.lo) / d.atr,
      gesternRichtung: (d.prev.close - d.prev.open) / d.atr * dir, trendStaerke: (d.prev.close - d.sma20) / d.atr * dir,
      lageGestern: d.prev.hi > d.prev.lo ? (d.open - d.prev.lo) / (d.prev.hi - d.prev.lo) : 0.5,
      // Nachtest (einzige neue Hypothese nach Runde 1): Lage der Eroeffnung in der gestrigen Spanne, auf die Trade-Richtung bezogen (0 = ungünstig, 1 = günstig)
      lageRichtung: d.prev.hi > d.prev.lo ? (dir > 0 ? (d.open - d.prev.lo) / (d.prev.hi - d.prev.lo) : (d.prev.hi - d.open) / (d.prev.hi - d.prev.lo)) : 0.5 } }); });
const train = T.filter((x) => x.y <= 2019), test = T.filter((x) => x.y >= 2020);
const tdiff = (a, b) => { const sa = stats(a), sb = stats(b), v = (s, arr) => arr.reduce((q, x) => q + (x - s.mean) ** 2, 0) / Math.max(1, arr.length - 1); return (sa.mean - sb.mean) / Math.sqrt(v(sa, a) / a.length + v(sb, b) / b.length); };
const out = { at: new Date().toISOString(), rule: RULE.id, alle: { train: stats(train.map((x) => x.r)), test: stats(test.map((x) => x.r)) }, filter: {}, passed: [] };
console.log('ALLE', 'Lernzeit 2013-2019', JSON.stringify(out.alle.train), '| Pruefzeit 2020-heute', JSON.stringify(out.alle.test));
for (const k of Object.keys(T[0].f)) {
  // Gruppen: Wochentag einzeln, sonst Drittel nach den Schwellen der Lernzeit
  let groups;
  if (k === 'wochentag') groups = [1, 2, 3, 4, 5].map((w) => ({ name: ['', 'Mo', 'Di', 'Mi', 'Do', 'Fr'][w], test: (x) => x.f.wochentag === w }));
  else { const v = train.map((x) => x.f[k]).sort((a, b) => a - b), q1 = v[Math.floor(v.length / 3)], q2 = v[Math.floor(v.length * 2 / 3)];
    groups = [{ name: 'niedrig (< ' + q1.toFixed(2) + ')', test: (x) => x.f[k] < q1 }, { name: 'mittel', test: (x) => x.f[k] >= q1 && x.f[k] < q2 }, { name: 'hoch (>= ' + q2.toFixed(2) + ')', test: (x) => x.f[k] >= q2 }]; }
  const rows = groups.map((g) => { const a = train.filter(g.test).map((x) => x.r), b = train.filter((x) => !g.test(x)).map((x) => x.r), c = test.filter(g.test).map((x) => x.r), e = test.filter((x) => !g.test(x)).map((x) => x.r);
    return { name: g.name, train: stats(a), tDiff: +tdiff(a, b).toFixed(2), test: stats(c), testRest: stats(e), testSum: +c.reduce((s, x) => s + x, 0).toFixed(1) }; });
  const worst = rows.slice().sort((a, b) => a.train.mean - b.train.mean)[0];
  const pass = worst.train.mean < 0 && worst.tDiff <= -2 && worst.testSum < 0 && worst.testRest.mean > out.alle.test.mean;
  out.filter[k] = { rows, streichen: worst.name, pass }; if (pass) out.passed.push({ k, streichen: worst.name, testOhne: worst.testRest, testAlle: out.alle.test });
  rows.forEach((r) => console.log('FILTER', k.padEnd(18), r.name.padEnd(18), '| Lernzeit', JSON.stringify(r.train), 't-Unterschied', r.tDiff, '| Pruefzeit', JSON.stringify(r.test), 'Summe', r.testSum));
  console.log('  ->', k, 'schlechteste Gruppe in der Lernzeit:', worst.name, pass ? 'BESTANDEN (spart auch in der Pruefzeit)' : 'nicht bestanden');
}
console.log('BESTANDEN:', out.passed.length ? out.passed.map((x) => x.k + ' ohne ' + x.streichen).join(', ') : 'keiner');
writeFileSync(new URL('./backtest-dtbfilter.json', import.meta.url), JSON.stringify(out));
