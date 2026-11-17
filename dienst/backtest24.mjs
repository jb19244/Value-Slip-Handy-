// Trefferquote der Kauf-Strategien (IBS, RSI-2, drei Verlusttage) heben: Gibt es Lagen, in denen sie deutlich oefter verlieren?
// Anlass 17.11.2026: Montagabend kauften fast alle Regeln auf allen US-Indizes gleichzeitig, der S&P lag nur 1 % ueber dem 200-Tage-Schnitt,
// am Dienstag ging es weiter runter. Gepruefte Merkmale (alle am Signaltag zum Schluss bekannt):
//  abstand200 (Kurs zum 200-Tage-Schnitt), cluster (wie viele der 4 US-Indizes am selben Tag ein Kaufsignal haben),
//  vix (Hoehe), vixSprung (VIX zu seinem 10-Tage-Schnitt), fall5 (Verlust der letzten 5 Tage), wochentag.
// Ehrlich gegen Ueberanpassung: Schwellen (Drittel) und schlechteste Gruppe NUR aus 2000-2012, geprueft mit 2013 bis heute.
// Ein Filter besteht nur, wenn die gestrichene Gruppe in der Lernzeit klar schlechter war (Trefferquote mind. 5 Punkte tiefer, Ø tiefer, t-Unterschied <= -2)
// UND in der Pruefzeit die behaltenen Trades eine hoehere Trefferquote UND einen hoeheren Ø haben als alle zusammen, UND die gestrichenen dort im Schnitt schlechter sind.
// Ergebnis: dienst/backtest-trefferquote.json
import { readFileSync, writeFileSync } from 'node:fs';
const html = readFileSync(new URL('../trade/index.html', import.meta.url), 'utf8');
const L = new Function(html.split('// BEGIN LOGIC')[1].split('// END LOGIC')[0] + '; return { parseYahoo, rStats, simDayTrade, dayOf, ruleSeries, ruleHit, ruleExit, smaSeries, ibs };')();
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; TradeCheck/1.0)' };
async function chart(sym) { for (const h of ['query1', 'query2', 'query1']) { try { const r = await fetch(`https://${h}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&period1=946684800&period2=${Math.floor(Date.now() / 1000)}`, { headers: UA }); if (r.ok) return L.parseYahoo(await r.json()).filter((x) => x.o > 0 && x.c > 0 && x.h >= x.l); } catch (e) {} await new Promise((r) => setTimeout(r, 1500)); } return []; }
const SYMS = ['^GSPC', '^NDX', '^DJI', '^RUT'], T = ['trend', 200];
const RULES = { ibs: { c: [T, ['ibs', 0.2]], x: ['ibs', 0.8], max: 5 }, rsi2: { c: [T, ['rsi2', 10]], x: ['sma', 5], max: 10 }, d3: { c: [T, ['mdd', 3, 3]], x: ['sma', 5], max: 10 } };
const D = {}, S = {}; for (const s of SYMS) { D[s] = await chart(s); S[s] = L.ruleSeries(D[s]); console.log(s, D[s].length); }
const vix = await chart('^VIX'), vixAt = new Map(vix.map((x, i) => [L.dayOf(x.t), { c: x.c, sma10: i >= 9 ? vix.slice(i - 9, i + 1).reduce((a, b) => a + b.c, 0) / 10 : null }]));
// Signale je Tag sammeln (fuer cluster)
const sigDay = {}; for (const s of SYMS) { const d1 = D[s]; for (let i = 201; i < d1.length - 1; i++) { const k = L.dayOf(d1[i].t); for (const [rk, r] of Object.entries(RULES)) if (L.ruleHit(d1, i, r, S[s])) { (sigDay[k] = sigDay[k] || new Set()).add(s); } } }
const trades = [];
for (const s of SYMS) { const d1 = D[s], sm = L.smaSeries(d1, S[s], 200);
  for (const [rk, r] of Object.entries(RULES)) { let busy = -1;
    for (let i = 201; i < d1.length - 1; i++) { if (i <= busy || !L.ruleHit(d1, i, r, S[s])) continue;
      const res = L.simDayTrade({ i, dir: 1, atr: S[s].atr[i] }, d1, { entry: 'close', stopAtr: 3, costPct: 0.07, maxDays: r.max, exitFn: (k) => L.ruleExit(d1, k, r, S[s]) }); if (res.pct == null) continue; busy = res.exitI;
      const k = L.dayOf(d1[i].t), v = vixAt.get(k);
      trades.push({ s, rk, day: k, y: +k.slice(0, 4), pct: res.pct, f: { abstand200: (d1[i].c / sm[i] - 1) * 100, cluster: sigDay[k] ? sigDay[k].size : 1, vix: v ? v.c : null, vixSprung: v && v.sma10 ? v.c / v.sma10 - 1 : null, fall5: (d1[i].c / d1[i - 5].c - 1) * 100, wochentag: new Date(d1[i].t + 3 * 3600e3).getUTCDay() } }); } } }
const st = (a) => { const x = L.rStats(a.map((t) => t.pct)); return x ? { n: x.n, win: +x.win.toFixed(3), mean: +x.mean.toFixed(3) } : { n: 0 }; };
const tdiff = (a, b) => { const m = (v) => v.reduce((q, x) => q + x, 0) / v.length, va = (v) => { const mm = m(v); return v.reduce((q, x) => q + (x - mm) ** 2, 0) / Math.max(1, v.length - 1); }; const A = a.map((t) => t.pct), B = b.map((t) => t.pct); return A.length > 5 && B.length > 5 ? (m(A) - m(B)) / Math.sqrt(va(A) / A.length + va(B) / B.length) : 0; };
const train = trades.filter((t) => t.y <= 2012), test = trades.filter((t) => t.y >= 2013);
const out = { at: new Date().toISOString(), alle: { train: st(train), test: st(test) }, merkmale: {}, passed: [] };
console.log('ALLE Lernzeit', JSON.stringify(out.alle.train), 'Pruefzeit', JSON.stringify(out.alle.test));
for (const k of Object.keys(trades[0].f)) {
  const ok = (t) => t.f[k] != null; let groups;
  if (k === 'cluster') groups = [{ name: '1 Index', fn: (t) => t.f.cluster === 1 }, { name: '2 Indizes', fn: (t) => t.f.cluster === 2 }, { name: '3-4 Indizes', fn: (t) => t.f.cluster >= 3 }];
  else if (k === 'wochentag') groups = [1, 2, 3, 4, 5].map((w) => ({ name: ['', 'Mo', 'Di', 'Mi', 'Do', 'Fr'][w], fn: (t) => t.f.wochentag === w }));
  else { const v = train.filter(ok).map((t) => t.f[k]).sort((a, b) => a - b), q1 = v[Math.floor(v.length / 3)], q2 = v[Math.floor(v.length * 2 / 3)];
    groups = [{ name: 'niedrig (< ' + q1.toFixed(2) + ')', fn: (t) => ok(t) && t.f[k] < q1 }, { name: 'mittel', fn: (t) => ok(t) && t.f[k] >= q1 && t.f[k] < q2 }, { name: 'hoch (>= ' + q2.toFixed(2) + ')', fn: (t) => ok(t) && t.f[k] >= q2 }]; }
  const rows = groups.map((g) => ({ name: g.name, fn: g.fn, train: st(train.filter(g.fn)), test: st(test.filter(g.fn)), td: +tdiff(train.filter(g.fn), train.filter((t) => !g.fn(t))).toFixed(2) }));
  const worst = rows.filter((r) => r.train.n >= 30).sort((a, b) => a.train.win - b.train.win)[0];
  const keepT = test.filter((t) => !worst.fn(t)), keep = st(keepT), cutT = st(test.filter(worst.fn));
  const pass = worst.train.win <= out.alle.train.win - 0.05 && worst.train.mean < out.alle.train.mean && worst.td <= -2 && keep.win > out.alle.test.win && keep.mean > out.alle.test.mean && cutT.mean < out.alle.test.mean;
  out.merkmale[k] = { rows: rows.map((r) => ({ name: r.name, train: r.train, test: r.test, td: r.td })), streichen: worst.name, testBehalten: keep, testGestrichen: cutT, pass };
  if (pass) out.passed.push({ k, streichen: worst.name, testBehalten: keep, testAlle: out.alle.test });
  rows.forEach((r) => console.log('MERKMAL', k.padEnd(10), r.name.padEnd(20), 'Lernzeit', JSON.stringify(r.train), 't', r.td, '| Pruefzeit', JSON.stringify(r.test)));
  console.log('  ->', k, 'streichen:', worst.name, '| Pruefzeit behalten', JSON.stringify(keep), 'gestrichen', JSON.stringify(cutT), pass ? 'BESTANDEN' : 'nicht bestanden');
}
// Trefferquote je Regel in der Pruefzeit (Kontext fuer den 7-von-10-Modus)
for (const rk of Object.keys(RULES)) console.log('REGEL', rk, 'Lernzeit', JSON.stringify(st(train.filter((t) => t.rk === rk))), 'Pruefzeit', JSON.stringify(st(test.filter((t) => t.rk === rk))));
console.log('BESTANDEN:', out.passed.length ? out.passed.map((x) => x.k + ' ohne ' + x.streichen).join(', ') : 'keiner');
writeFileSync(new URL('./backtest-trefferquote.json', import.meta.url), JSON.stringify(out));
