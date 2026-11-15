// Positionsgroesse nach Marktlage fuer die Tages-Strategien (IBS, Doppelsignal, RSI-2, drei Verlusttage, Turnaround Tuesday) auf den 4 US-Indizes seit 2000:
//  1) Ergebnis je Trade (in R, Stop 3 ATR) nach VIX-Stufe beim Signal
//  2) Kapitalkurve mit festem Risiko gegen Risiko nach VIX (weniger bei hohem VIX) und umgekehrt (mehr bei hohem VIX), gleiches Durchschnittsrisiko
//  3) Kelly-Anteil aus der Verteilung der R-Ergebnisse (voller und viertel Kelly)
// Ergebnis: dienst/backtest-size.json
import { readFileSync, writeFileSync } from 'node:fs';
const html = readFileSync(new URL('../trade/index.html', import.meta.url), 'utf8');
const src = html.split('// BEGIN LOGIC')[1].split('// END LOGIC')[0];
const L = new Function(src + '; return { parseYahoo, rStats, rsi2DailySignals, ibsSignals, ibsExit, simDayTrade, dayOf, atrSeries, rsiSeries, smaAt, ibs };')();
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; TradeCheck/1.0)' };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function raw(sym) {
  for (const host of ['query1', 'query2', 'query1']) {
    try { const r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&period1=946684800&period2=${Math.floor(Date.now() / 1000)}`, { headers: UA }); if (r.ok) return await r.json(); } catch (e) {}
    await wait(1500);
  }
  return null;
}
const chart = async (sym) => { const j = await raw(sym); return j ? L.parseYahoo(j).filter((x) => x.o > 0 && x.h >= x.l && x.c > 0) : []; };
const pick = (a) => a ? { n: a.n, mean: +a.mean.toFixed(4), win: +a.win.toFixed(3), sum: +a.sum.toFixed(2), lo: a.lo != null ? +a.lo.toFixed(4) : null } : { n: 0 };
const st = (arr) => pick(arr.length ? L.rStats(arr.map((t) => t.pct)) : null);
// Signale am selben Tag haengen zusammen: je Handelstag den Mittelwert bilden und die Sicherheit ueber die Tage rechnen
function byDay(trades) { const g = {}; trades.forEach((t) => { const d = L.dayOf(t.t); (g[d] = g[d] || []).push(t.pct); }); const m = Object.values(g).map((a) => a.reduce((x, y) => x + y, 0) / a.length); const s = L.rStats(m); return s ? { days: s.n, mean: +s.mean.toFixed(4), lo: +s.lo.toFixed(4), win: +s.win.toFixed(3) } : { days: 0 }; }
function byYear(trades) { const g = {}; trades.forEach((t) => { const y = L.dayOf(t.t).slice(0, 4); (g[y] = g[y] || []).push(t.pct); }); const o = {}; Object.keys(g).sort().forEach((y) => { o[y] = { n: g[y].length, mean: +(g[y].reduce((a, b) => a + b, 0) / g[y].length).toFixed(3), sum: +g[y].reduce((a, b) => a + b, 0).toFixed(1) }; }); return o; }
function evalSet(name, trades, extra) {
  trades = trades.filter((t) => t.pct != null && isFinite(t.pct)); extra = extra || {};
  const ts = trades.map((t) => t.t).sort((a, b) => a - b), cut = ts[Math.floor(ts.length * 0.75)] || 0, split = ts[Math.floor(ts.length * 0.375)] || 0;
  const tr = trades.filter((t) => t.t < split), te = trades.filter((t) => t.t >= split && t.t < cut), ho = trades.filter((t) => t.t >= cut);
  const o = Object.assign({ name, unit: '%', all: st(trades), train: st(tr), test: st(te), hold: st(ho), from: ts.length ? L.dayOf(ts[0]) : null, day: byDay(trades), years: byYear(trades) }, extra);
  const yk = Object.keys(o.years); o.yearsUp = yk.filter((y) => o.years[y].sum > 0).length; o.yearsN = yk.length;
  if (trades.length && trades[0].cost != null) o.cost2 = st(trades.map((t) => ({ pct: t.pct - t.cost })));
  const hasEx = trades.length && trades[0].ex != null && !extra.noEx;
  if (hasEx) { const ex = (a) => st(a.map((t) => ({ pct: t.ex }))); o.ex = { all: ex(trades), train: ex(tr), test: ex(te), hold: ex(ho) }; }
  if (trades.length) { const span = (ts[ts.length - 1] - ts[0]) / 86400e3 / 365.25; o.perYear = +(trades.length / Math.max(0.5, span)).toFixed(1); }
  o.passed = o.all.n >= 100 && o.hold.n >= 20 && o.all.lo > 0 && o.day.lo > 0 && [o.train, o.test, o.hold].every((x) => x.n && x.mean > 0) && (!hasEx || [o.ex.train, o.ex.test, o.ex.hold].every((x) => x.n && x.mean > 0));
  return o;
}

const COST = 0.07, IDX = ['^GSPC', '^NDX', '^DJI', '^RUT'];
const D = {}; for (const s of IDX.concat(['^VIX'])) { D[s] = await chart(s); await wait(300); }
const vixOf = {}; (D['^VIX'] || []).forEach((x) => { vixOf[L.dayOf(x.t)] = x.c; });
const SETS = { ibs: [], dbl: [], rsi2: [], d3: [], tt: [] };
for (const s of IDX) { const d1 = D[s]; if (!d1 || d1.length < 1000) continue; const a = L.atrSeries(d1), rs = L.rsiSeries(d1, 2);
  const s5 = (k) => { let t = 0; for (let q = k - 4; q <= k; q++) t += d1[q].c; return d1[k].c > t / 5; };
  const push = (key, i, opt) => { const r = L.simDayTrade({ i, dir: 1, atr: a[i] }, d1, Object.assign({ entry: 'close', stopAtr: 3, costPct: COST }, opt)); if (r.pct == null) return; const riskPct = 3 * a[i] / d1[i].c * 100; SETS[key].push({ t: d1[i].t, day: L.dayOf(d1[i].t), s, pct: r.pct, r: r.pct / riskPct, vix: vixOf[L.dayOf(d1[i].t)] || null }); };
  for (let i = 210; i < d1.length - 1; i++) { if (!a[i]) continue; const up = d1[i].c > L.smaAt(d1, i, 200), ib = L.ibs(d1[i]), wd = new Date(d1[i].t + 3 * 3600e3).getUTCDay();
    if (up && ib < 0.2) push('ibs', i, { maxDays: 5, exitFn: L.ibsExit(d1) });
    if (up && ib < 0.2 && rs[i] < 10) push('dbl', i, { maxDays: 5, exitFn: L.ibsExit(d1) });
    if (up && rs[i] < 10) push('rsi2', i, { maxDays: 10, exitFn: s5 });
    if (up && d1[i].c < d1[i - 1].c && d1[i - 1].c < d1[i - 2].c && d1[i - 2].c < d1[i - 3].c) push('d3', i, { maxDays: 7, exitFn: s5 });
    if (wd === 1 && d1[i].c < d1[i - 1].c && ib < 0.3) push('tt', i, { maxDays: 4, exitFn: (k) => d1[k].c > d1[k - 1].h }); } }
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null, sd = (a) => { const m = mean(a); return a.length > 1 ? Math.sqrt(a.reduce((x, y) => x + (y - m) * (y - m), 0) / (a.length - 1)) : null; };
const BUCK = [[0, 15], [15, 20], [20, 30], [30, 999]];
// Kapitalkurve: Trades nach Datum, Risiko je Trade base% * Faktor; Ergebnis je Trade = R * Risiko
function curve(T, f, base) { let eq = 1, pk = 1, dd = 0; const rets = []; T.forEach((x) => { const rk = base * f(x) / 100, g = x.r * rk; eq *= 1 + g; rets.push(g); pk = Math.max(pk, eq); dd = Math.max(dd, 1 - eq / pk); }); const yrs = T.length ? (T[T.length - 1].t - T[0].t) / 31557600e3 : 1;
  return { cagr: +((Math.pow(eq, 1 / yrs) - 1) * 100).toFixed(2), maxDD: +(dd * 100).toFixed(1), ratio: dd ? +((Math.pow(eq, 1 / yrs) - 1) / dd).toFixed(3) : null }; }
const out = { at: new Date().toISOString(), sets: {} };
for (const k of Object.keys(SETS)) { const T = SETS[k].filter((x) => x.vix != null).sort((a, b) => a.t - b.t); if (T.length < 100) continue;
  const byV = BUCK.map(([a, b]) => { const s = T.filter((x) => x.vix >= a && x.vix < b), r = s.map((x) => x.r); return { vix: a + '-' + (b > 100 ? '' : b), n: s.length, meanR: r.length ? +mean(r).toFixed(3) : null, win: r.length ? +(r.filter((x) => x > 0).length / r.length).toFixed(3) : null }; });
  // gleiches Durchschnittsrisiko: Faktoren normieren
  const fDown = (x) => Math.max(0.5, Math.min(1.5, 20 / x.vix)), fUp = (x) => Math.max(0.5, Math.min(1.5, x.vix / 20)), nD = mean(T.map(fDown)), nU = mean(T.map(fUp));
  const R = T.map((x) => x.r), m = mean(R), s2 = sd(R) ** 2, kelly = s2 ? m / s2 : null;
  out.sets[k] = { n: T.length, meanR: +m.toFixed(3), sdR: +Math.sqrt(s2).toFixed(3), byVix: byV, fixed: curve(T, () => 1, 1), vixDown: curve(T, (x) => fDown(x) / nD, 1), vixUp: curve(T, (x) => fUp(x) / nU, 1), kellyPct: kelly != null ? +(kelly * 100).toFixed(1) : null, quarterKellyPct: kelly != null ? +(kelly * 25).toFixed(1) : null };
  console.log(k.padEnd(5), 'n', T.length, 'ØR', m.toFixed(3), '| VIX-Stufen', byV.map((b) => b.vix + ': ' + b.meanR + ' (' + b.n + ')').join('  '), '| fest', JSON.stringify(out.sets[k].fixed), 'VIX runter', JSON.stringify(out.sets[k].vixDown), 'VIX rauf', JSON.stringify(out.sets[k].vixUp), '| Kelly', out.sets[k].kellyPct + ' %, viertel', out.sets[k].quarterKellyPct + ' %'); }
writeFileSync(new URL('./backtest-size.json', import.meta.url), JSON.stringify(out));
