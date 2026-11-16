// Strategien aus dem Netz, die (fast) taeglich Signale geben: jede mit ihren veroeffentlichten Regeln, ohne Nachjustieren, streng geprueft.
// Quellen: Connors/Alvarez (Short Term Trading Strategies That Work, High Probability ETF Trading), Quantified Strategies, Quantpedia,
// Turtle-Regeln (Faith), gaengige Indikator-Strategien (MACD, Golden Cross, Supertrend, Bollinger, Stochastik, 52-Wochen-Hoch).
// Tageskerzen seit 2000 (Yahoo), Einstieg zum Schluss, Notstop 3 ATR (Knock-out-Schwelle), Kosten wie in den anderen Rueckrechnungen.
// Gruppen: US-Indizes (Knock-out), US-Sektoren (ETF), Europa (DAX, Euro Stoxx 50, FTSE, CAC) und fuer Trendfolge zusaetzlich Rohstoffe, Anleihen, Devisen, Bitcoin.
// Bestanden nur, wenn ALLES gilt (wie die Sonntags-Suche):
//  >= 100 Trades, alle drei Zeitraeume im Plus, nach Handelstagen gebuendelt sicher ueber null, besser als einfach investiert zu sein,
//  t-Wert nach Tagen >= 3, Vorteil gegen einfach investiert nach Tagen sicher (t >= 2), in >= 75 % der Maerkte im Plus, doppelte Kosten im Plus, >= 60 % der Jahre im Plus, >= 5 Trades pro Jahr,
//  alle Nachbarn (eine Stellschraube anders) im Plus und die Haelfte davon sicher,
//  und hoechstens die Haelfte der Signale an Tagen, an denen die App schon kauft (IBS, RSI-2, drei Verlusttage, Turnaround Tuesday).
// Was besteht (Mean-Reversion, US), kommt in backtest-suche.json als "Neu entdeckt" und laeuft im Dienst mit Live-Pruefung.
import { readFileSync, writeFileSync } from 'node:fs';
const html = readFileSync(new URL('../trade/index.html', import.meta.url), 'utf8');
const src = html.split('// BEGIN LOGIC')[1].split('// END LOGIC')[0];
const L = new Function(src + '; return { parseYahoo, rStats, simDayTrade, dayOf, atrSeries, rsiSeries, smaAt, ibs, ruleSeries, ruleHit, ruleExit, ruleText, ruleId, smaSeries };')();
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
function byDay(trades) { const g = {}; trades.forEach((t) => { const d = L.dayOf(t.t); (g[d] = g[d] || []).push(t.pct); }); const m = Object.values(g).map((a) => a.reduce((x, y) => x + y, 0) / a.length); const s = L.rStats(m); return s ? { days: s.n, mean: +s.mean.toFixed(4), lo: s.lo != null ? +s.lo.toFixed(4) : null, win: +s.win.toFixed(3) } : { days: 0 }; }
function byYear(trades) { const g = {}; trades.forEach((t) => { const y = L.dayOf(t.t).slice(0, 4); (g[y] = g[y] || []).push(t.pct); }); const o = {}; Object.keys(g).sort().forEach((y) => { o[y] = { n: g[y].length, sum: +g[y].reduce((a, b) => a + b, 0).toFixed(1) }; }); return o; }

const COST = 0.07, COST_ETF = 0.08, COST_EU = 0.08, COST_X = 0.1;
const GROUPS = {
  us4: { name: 'US-Indizes', syms: ['^GSPC', '^NDX', '^DJI', '^RUT'], cost: COST, auto: true },
  sek: { name: 'US-Sektoren', syms: ['XLK', 'XLF', 'XLE', 'XLV', 'XLY', 'XLP', 'XLI', 'XLB', 'XLU'], cost: COST_ETF, auto: true },
  eu: { name: 'Europa', syms: ['^GDAXI', '^STOXX50E', '^FTSE', '^FCHI'], cost: COST_EU },
  mix: { name: 'Rohstoffe, Anleihen, Devisen, Bitcoin', syms: ['GLD', 'SLV', 'USO', 'TLT', 'IEF', 'EURUSD=X', 'GBPUSD=X', 'USDJPY=X', 'AUDUSD=X', 'BTC-USD'], cost: COST_X }
};
const D = {}, SER = {};
for (const g of Object.values(GROUPS)) for (const s of g.syms) { if (!D[s]) { D[s] = await chart(s); await wait(250); } }
for (const s of Object.keys(D)) { if (!D[s] || D[s].length < 1500) { console.log('fehlt', s, D[s] && D[s].length); delete D[s]; continue; } SER[s] = L.ruleSeries(D[s]); }
const drift = (d1) => { let s = 0; for (let k = 1; k < d1.length; k++) s += d1[k].c / d1[k - 1].c - 1; return s / (d1.length - 1) * 100; };
const DR = {}; Object.keys(D).forEach((s) => { DR[s] = drift(D[s]); });
// Tage, an denen die App schon kauft
const famHit = (d1, i, S) => { const x = d1[i], sm = L.smaSeries(d1, S, 200); if (!(sm[i] != null && x.c > sm[i])) return false; const ib = L.ibs(x);
  return ib < 0.2 || (S.rsi2[i] != null && S.rsi2[i] < 10) || (x.c < d1[i - 1].c && d1[i - 1].c < d1[i - 2].c && d1[i - 2].c < d1[i - 3].c) || (new Date(x.t + 3 * 3600e3).getUTCDay() === 1 && ib < 0.3 && x.c < d1[i - 1].c); };

// ---------- Trendfolge-Bausteine (eigene kleine Engine, Einstieg zum Schluss, Ausstieg zum Schluss nach Regel, Notstop 3 ATR)
const emaS = (d1, n) => { const a = [], k = 2 / (n + 1); let e = null; for (let i = 0; i < d1.length; i++) { e = e == null ? d1[i].c : d1[i].c * k + e * (1 - k); a.push(i >= n - 1 ? e : null); } return a; };
const cache = new Map(); const memo = (s, key, f) => { const k = s + '|' + key; if (!cache.has(k)) cache.set(k, f()); return cache.get(k); };
const smaA = (s, n) => memo(s, 'sma' + n, () => L.smaSeries(D[s], { sm: {} }, n));
const macd = (s) => memo(s, 'macd', () => { const d1 = D[s], a = emaS(d1, 12), b = emaS(d1, 26), m = d1.map((_, i) => a[i] != null && b[i] != null ? a[i] - b[i] : null); let e = null; const sig = m.map((v) => { if (v == null) return null; e = e == null ? v : v * 0.2 + e * 0.8; return e; }); return { m, sig }; });
const hiN = (d1, i, n) => { let h = -Infinity; for (let k = i - n; k < i; k++) h = Math.max(h, d1[k].h); return h; };
const loN = (d1, i, n) => { let l = Infinity; for (let k = i - n; k < i; k++) l = Math.min(l, d1[k].l); return l; };
const supertrend = (s, n, m) => memo(s, 'st' + n + m, () => { const d1 = D[s], a = L.atrSeries(d1), dir = []; let up = null, dn = null, dr = 1;
  for (let i = 0; i < d1.length; i++) { if (a[i] == null) { dir.push(null); continue; } const mid = (d1[i].h + d1[i].l) / 2, u = mid - m * a[i], l = mid + m * a[i];
    up = up == null || d1[i - 1].c < up ? u : Math.max(u, up); dn = dn == null || d1[i - 1].c > dn ? l : Math.min(l, dn);
    if (dr === 1 && d1[i].c < up) dr = -1; else if (dr === -1 && d1[i].c > dn) dr = 1; dir.push(dr); } return dir; });
const bbU = (d1, i, n, m) => { const a = L.smaAt(d1, i, n); let v = 0; for (let k = i - n + 1; k <= i; k++) v += (d1[k].c - a) ** 2; return a + m * Math.sqrt(v / n); };
const TREND = {
  golden: { name: 'Golden Cross 50/200', src: 'Klassiker', p: [50, 200], in: (s, i, p) => { const a = smaA(s, p[0]), b = smaA(s, p[1]); return a[i - 1] != null && b[i - 1] != null && a[i - 1] <= b[i - 1] && a[i] > b[i]; }, out: (s, k, p) => { const a = smaA(s, p[0]), b = smaA(s, p[1]); return a[k] < b[k]; }, nb: [[40, 200], [50, 150], [60, 200]] },
  macd: { name: 'MACD-Kreuzung 12/26/9', src: 'Appel', p: [0], in: (s, i, p) => { const q = macd(s); return q.sig[i - 1] != null && q.m[i - 1] <= q.sig[i - 1] && q.m[i] > q.sig[i] && (p[0] === 0 || q.m[i] < 0); }, out: (s, k) => { const q = macd(s); return q.m[k] < q.sig[k]; }, nb: [[1]] },
  turtle1: { name: 'Turtle 20-Tage-Ausbruch', src: 'Turtle-Regeln (Faith)', p: [20, 10], in: (s, i, p) => D[s][i].c > hiN(D[s], i, p[0]), out: (s, k, p) => D[s][k].c < loN(D[s], k, p[1]), nb: [[15, 10], [25, 10], [20, 5], [20, 15]] },
  turtle2: { name: 'Turtle 55-Tage-Ausbruch', src: 'Turtle-Regeln (Faith)', p: [55, 20], in: (s, i, p) => D[s][i].c > hiN(D[s], i, p[0]), out: (s, k, p) => D[s][k].c < loN(D[s], k, p[1]), nb: [[50, 20], [60, 20], [55, 15], [55, 25]] },
  bbout: { name: 'Bollinger-Ausbruch 20/2', src: 'Quantified Strategies', p: [20, 2], in: (s, i, p) => i > 20 && D[s][i].c > bbU(D[s], i, p[0], p[1]) && D[s][i - 1].c <= bbU(D[s], i - 1, p[0], p[1]), out: (s, k, p) => D[s][k].c < L.smaAt(D[s], k, p[0]), nb: [[20, 1.5], [20, 2.5], [30, 2]] },
  hi52: { name: '52-Wochen-Hoch', src: 'George/Hwang 2004', p: [250, 50], in: (s, i, p) => i > p[0] && D[s][i].c > hiN(D[s], i, p[0]) && !(D[s][i - 1].c > hiN(D[s], i - 1, p[0])), out: (s, k, p) => D[s][k].c < smaA(s, p[1])[k], nb: [[250, 20], [250, 100], [200, 50]] },
  super: { name: 'Supertrend 10/3', src: 'Seban', p: [10, 3], in: (s, i, p) => { const d = supertrend(s, p[0], p[1]); return d[i - 1] === -1 && d[i] === 1; }, out: (s, k, p) => supertrend(s, p[0], p[1])[k] === -1, nb: [[10, 2], [10, 4], [14, 3]] },
  ma2050: { name: 'Gleitende Schnitte 20/50', src: 'Klassiker', p: [20, 50], in: (s, i, p) => { const a = smaA(s, p[0]), b = smaA(s, p[1]); return a[i - 1] != null && b[i - 1] != null && a[i - 1] <= b[i - 1] && a[i] > b[i]; }, out: (s, k, p) => { const a = smaA(s, p[0]), b = smaA(s, p[1]); return a[k] < b[k]; }, nb: [[10, 50], [20, 40], [30, 50]] },
  sma200: { name: 'Kurs kreuzt 200-Tage-Schnitt', src: 'Faber 2007 (taeglich)', p: [200], in: (s, i, p) => { const a = smaA(s, p[0]); return a[i - 1] != null && D[s][i - 1].c <= a[i - 1] && D[s][i].c > a[i]; }, out: (s, k, p) => D[s][k].c < smaA(s, p[0])[k], nb: [[150], [250]] }
};
function trendTrades(def, p, gk, opt) {
  const G = GROUPS[gk], trades = [], per = {}; let ov = 0, nsig = 0;
  for (const s of G.syms) { const d1 = D[s], S = SER[s]; if (!d1) continue; per[s] = { n: 0, sum: 0 }; let busy = -1;
    for (let i = 260; i < d1.length - 1; i++) { if (i <= busy || !S.atr[i] || !def.in(s, i, p)) continue;
      const r = L.simDayTrade({ i, dir: 1, atr: opt.stop ? S.atr[i] : null }, d1, { entry: 'close', stopAtr: 3, costPct: G.cost, maxDays: 400, exitFn: (k) => def.out(s, k, p) });
      if (r.pct == null) continue; busy = r.exitI; nsig++; if (famHit(d1, i, S)) ov++;
      trades.push({ t: d1[i].t, s, cost: G.cost, pct: r.pct, days: r.days, ex: r.pct - DR[s] * r.days }); per[s].n++; per[s].sum += r.pct; } }
  return { trades, per, ov, nsig };
}
function ruleTrades(rule, gk) {
  const G = GROUPS[gk], trades = [], per = {}; let ov = 0, nsig = 0;
  for (const s of G.syms) { const d1 = D[s], S = SER[s]; if (!d1) continue; per[s] = { n: 0, sum: 0 }; let busy = -1;
    for (let i = 201; i < d1.length - 1; i++) {
      if (i <= busy || !L.ruleHit(d1, i, rule, S)) continue;
      const r = L.simDayTrade({ i, dir: 1, atr: S.atr[i] }, d1, { entry: 'close', stopAtr: 3, costPct: G.cost, maxDays: rule.max, exitFn: (k) => L.ruleExit(d1, k, rule, S) });
      if (r.pct == null) continue; busy = r.exitI; nsig++; if (famHit(d1, i, S)) ov++;
      trades.push({ t: d1[i].t, s, cost: G.cost, pct: r.pct, days: r.days, ex: r.pct - DR[s] * r.days }); per[s].n++; per[s].sum += r.pct; } }
  return { trades, per, ov, nsig };
}
function judge(x) {
  const trades = x.trades.filter((t) => t.pct != null && isFinite(t.pct));
  const ts = trades.map((t) => t.t).sort((a, b) => a - b), cut = ts[Math.floor(ts.length * 0.75)] || 0, split = ts[Math.floor(ts.length * 0.375)] || 0;
  const tr = trades.filter((t) => t.t < split), te = trades.filter((t) => t.t >= split && t.t < cut), ho = trades.filter((t) => t.t >= cut);
  const o = { all: st(trades), train: st(tr), test: st(te), hold: st(ho), day: byDay(trades), years: byYear(trades) };
  const yk = Object.keys(o.years); o.yearsUp = yk.filter((y) => o.years[y].sum > 0).length; o.yearsN = yk.length;
  o.cost2 = st(trades.map((t) => ({ pct: t.pct - t.cost })));
  const ex = (a) => st(a.map((t) => ({ pct: t.ex }))); o.ex = { all: ex(trades), train: ex(tr), test: ex(te), hold: ex(ho) };
  o.perYear = trades.length ? +(trades.length / Math.max(0.5, (ts[ts.length - 1] - ts[0]) / 86400e3 / 365.25)).toFixed(1) : 0;
  o.days = trades.length ? +(trades.reduce((a, t) => a + t.days, 0) / trades.length).toFixed(1) : 0;
  o.passed = o.all.n >= 100 && o.hold.n >= 20 && o.all.lo > 0 && o.day.lo > 0 && [o.train, o.test, o.hold].every((q) => q.n && q.mean > 0) && [o.ex.train, o.ex.test, o.ex.hold].every((q) => q.n && q.mean > 0);
  const se = o.day && o.day.mean != null && o.day.lo != null && o.day.mean > o.day.lo ? (o.day.mean - o.day.lo) / 1.96 : null;
  o.tval = se ? +(o.day.mean / se).toFixed(2) : 0;
  // Vorteil gegen einfach investiert, ebenfalls nach Tagen gebuendelt: sonst sieht jede lange Kaufposition im steigenden Markt gut aus
  const dx = byDay(trades.map((t) => ({ t: t.t, pct: t.ex }))), sx = dx.mean != null && dx.lo != null && dx.mean > dx.lo ? (dx.mean - dx.lo) / 1.96 : null; o.tex = sx ? +(dx.mean / sx).toFixed(2) : 0; const ps = Object.values(x.per).filter((p) => p.n >= 10);
  o.breadth = ps.length ? +(ps.filter((p) => p.sum > 0).length / ps.length).toFixed(2) : 0; o.overlap = x.nsig ? +(x.ov / x.nsig).toFixed(2) : 0;
  o.why = [!o.passed && 'Grundhürde (' + [o.all.n < 100 && 'zu wenige Trades', !(o.all.lo > 0) && 'nicht sicher über null', [o.train, o.test, o.hold].some((q) => !(q.mean > 0)) && 'ein Zeitraum im Minus', [o.ex.train, o.ex.test, o.ex.hold].some((q) => !(q.mean > 0)) && 'nicht besser als investiert'].filter(Boolean).join(', ') + ')',
    o.tval < 3 && 't-Wert ' + o.tval, o.tex < 2 && 'Vorteil gegen investiert nicht sicher (t ' + o.tex + ')', o.breadth < 0.75 && 'nur ' + Math.round(o.breadth * 100) + ' % der Märkte im Plus', !(o.cost2.mean > 0) && 'doppelte Kosten im Minus', o.yearsUp < 0.6 * o.yearsN && 'zu wenige gute Jahre', o.perYear < 5 && 'zu selten'].filter(Boolean);
  o.core = o.why.length === 0; delete o.years; return o;
}
// ---------- Katalog Mean-Reversion (veroeffentlichte Regeln), mit Nachbarn
const T = ['trend', 200];
const MR = [
  { k: 'rsi2', name: 'Connors RSI-2 (Kontrolle, schon in der App)', src: 'Connors/Alvarez', r: { c: [T, ['rsi2', 5]], x: ['sma', 5], max: 10 }, nb: [{ c: [T, ['rsi2', 10]] }, { c: [T, ['rsi2', 2]] }, { x: ['rsi2', 70] }] },
  { k: 'cum', name: 'Cumulative RSI', src: 'Connors/Alvarez', r: { c: [T, ['cum', 2, 35]], x: ['rsi2', 65], max: 10 }, nb: [{ c: [T, ['cum', 2, 30]] }, { c: [T, ['cum', 2, 45]] }, { c: [T, ['cum', 3, 45]] }, { x: ['rsi2', 70] }] },
  { k: 'd7', name: 'Double 7s', src: 'Connors/Alvarez', r: { c: [T, ['low', 7]], x: ['hi', 7], max: 15 }, nb: [{ c: [T, ['low', 5]], x: ['hi', 5] }, { c: [T, ['low', 10]], x: ['hi', 10] }, { x: ['hi', 5] }] },
  { k: 'tps', name: 'TPS (RSI-2 zwei Tage unter 25)', src: 'Connors/Alvarez, High Probability ETF Trading', r: { c: [T, ['rsiN', 2, 25]], x: ['rsi2', 70], max: 10 }, nb: [{ c: [T, ['rsiN', 2, 20]] }, { c: [T, ['rsiN', 2, 30]] }, { c: [T, ['rsiN', 3, 25]] }] },
  { k: 'r3', name: 'R3', src: 'Connors/Alvarez', r: { c: [T, ['r3', 60, 10]], x: ['rsi2', 70], max: 10 }, nb: [{ c: [T, ['r3', 60, 15]] }, { c: [T, ['r3', 60, 5]] }, { x: ['sma', 5] }] },
  { k: 'pb', name: '%b-Strategie', src: 'Connors/Alvarez', r: { c: [T, ['pb', 3, 0.2]], x: ['pb', 0.8], max: 10 }, nb: [{ c: [T, ['pb', 2, 0.2]] }, { c: [T, ['pb', 3, 0.3]] }, { x: ['pb', 0.7] }] },
  { k: 'mdd', name: 'Multiple Days Down', src: 'Connors/Alvarez', r: { c: [T, ['below', 5], ['mdd', 4, 5]], x: ['sma', 5], max: 10 }, nb: [{ c: [T, ['below', 5], ['mdd', 3, 5]] }, { c: [T, ['below', 5], ['mdd', 5, 6]] }, { x: ['rsi2', 70] }] },
  { k: 'crsi', name: 'ConnorsRSI', src: 'Connors Research', r: { c: [T, ['crsi', 10]], x: ['crsi', 70], max: 10 }, nb: [{ c: [T, ['crsi', 5]] }, { c: [T, ['crsi', 15]] }, { x: ['sma', 5] }] },
  { k: 'hl3', name: '3-Tage-Hoch/Tief', src: 'Connors', r: { c: [T, ['below', 5], ['hl', 3]], x: ['sma', 5], max: 10 }, nb: [{ c: [T, ['below', 5], ['hl', 2]] }, { c: [T, ['below', 5], ['hl', 4]] }, { x: ['rsi2', 70] }] },
  { k: 'low5', name: '5-Tage-Tief', src: 'Quantified Strategies', r: { c: [['low', 5]], x: ['ph'], max: 10 }, nb: [{ c: [['low', 4]] }, { c: [['low', 7]] }, { c: [T, ['low', 5]] }] },
  { k: 'wr2', name: 'Williams %R(2) unter -90', src: 'Quantified Strategies', r: { c: [['wr', 2, -90]], x: ['ph'], max: 10 }, nb: [{ c: [['wr', 2, -95]] }, { c: [['wr', 3, -90]] }, { c: [T, ['wr', 2, -90]] }] },
  { k: 'bbl', name: 'Schluss unter dem unteren Bollinger-Band', src: 'Quantified Strategies', r: { c: [['bb', 20, 2]], x: ['sma', 5], max: 10 }, nb: [{ c: [['bb', 20, 1.5]] }, { c: [T, ['bb', 20, 2]] }, { x: ['ph'] }] },
  { k: 'deep', name: 'Tiefer Ruecksetzer (10-Tage-Tief im Aufwaertstrend)', src: 'Quantified Strategies', r: { c: [T, ['low', 10]], x: ['ph'], max: 10 }, nb: [{ c: [T, ['low', 8]] }, { c: [T, ['low', 15]] }, { x: ['sma', 5] }] },
  { k: 'nr7', name: 'NR7 (engste Spanne seit 7 Tagen)', src: 'Crabel / Quantified Strategies', r: { c: [T, ['nr', 7], ['below', 5]], x: ['ph'], max: 10 }, nb: [{ c: [T, ['nr', 6], ['below', 5]] }, { c: [T, ['nr', 8], ['below', 5]] }, { x: ['sma', 5] }] },
  { k: 'stoch', name: 'Stochastik(14) unter 20', src: 'Lane / gaengige Indikator-Strategie', r: { c: [T, ['stoch', 14, 20]], x: ['wr', 14, -20], max: 15 }, nb: [{ c: [T, ['stoch', 14, 10]] }, { c: [T, ['stoch', 10, 20]] }, { x: ['sma', 5] }] },
  { k: 'gap', name: 'Kurslücke nach unten (Gap-Fill)', src: 'Quantified Strategies / Larry Williams', r: { c: [T, ['gap', -1]], x: ['ph'], max: 10 }, nb: [{ c: [T, ['gap', -0.5]] }, { c: [T, ['gap', -1.5]] }, { x: ['sma', 5] }] }
];
const res = [], t0 = Date.now();
const nbRule = (r, d) => ({ c: d.c || r.c, x: d.x || r.x, max: d.max || r.max });
for (const m of MR) for (const gk of ['us4', 'sek', 'eu']) {
  const o = judge(ruleTrades(m.r, gk));
  if (o.core) { const nb = m.nb.map((d) => judge(ruleTrades(nbRule(m.r, d), gk))); o.nb = nb.map((n) => ({ n: n.all.n, mean: n.all.mean, lo: n.all.lo }));
    o.robust = nb.every((n) => n.all.n >= 50 && n.all.mean > 0 && n.ex.all.mean > 0) && nb.filter((n) => n.all.lo > 0).length >= Math.ceil(nb.length / 2); if (!o.robust) o.why.push('Nachbarn nicht robust'); }
  const novel = o.overlap <= 0.5; if (o.core && o.robust && !novel) o.why.push('gleiche Tage wie die App (' + Math.round(o.overlap * 100) + ' %)');
  const pass = !!(o.core && o.robust && novel);
  res.push({ fam: 'mr', k: m.k, name: m.name, src: m.src, gk, grp: GROUPS[gk].name, rule: m.r, text: L.ruleText(m.r), pass, o });
  console.log((pass ? 'BESTANDEN ' : '          ') + m.name.padEnd(48), GROUPS[gk].name.padEnd(12), 'n', o.all.n, 'Ø', o.all.mean, '% win', o.all.win, 't', o.tval, 't-ex', o.tex, 'breite', o.breadth, 'ueberl', o.overlap, '|', o.why.join('; '));
}
for (const [k, def] of Object.entries(TREND)) for (const gk of ['us4', 'sek', 'eu', 'mix']) for (const stop of [true, false]) {
  const o = judge(trendTrades(def, def.p, gk, { stop }));
  if (o.core) { const nb = def.nb.map((p) => judge(trendTrades(def, p, gk, { stop }))); o.nb = nb.map((n) => ({ n: n.all.n, mean: n.all.mean, lo: n.all.lo }));
    o.robust = nb.every((n) => n.all.n >= 50 && n.all.mean > 0 && n.ex.all.mean > 0) && nb.filter((n) => n.all.lo > 0).length >= Math.ceil(nb.length / 2); if (!o.robust) o.why.push('Nachbarn nicht robust'); }
  const pass = !!(o.core && o.robust);
  res.push({ fam: 'trend', k, name: def.name + (stop ? '' : ' (ohne Notstop)'), src: def.src, gk, grp: GROUPS[gk].name, p: def.p, stop, pass, o });
  console.log((pass ? 'BESTANDEN ' : '          ') + (def.name + (stop ? '' : ' o.St.')).padEnd(48), GROUPS[gk].name.padEnd(12), 'n', o.all.n, 'Ø', o.all.mean, '% win', o.all.win, 't', o.tval, 't-ex', o.tex, 'breite', o.breadth, 'Tage', o.days, '|', o.why.join('; '));
}
console.log('geprueft in', Math.round((Date.now() - t0) / 1000), 's');
const passed = res.filter((r) => r.pass);
console.log('BESTANDEN:', passed.length ? passed.map((r) => r.name + ' · ' + r.grp).join(', ') : 'keine');
// ---------- Bestandene Mean-Reversion-Regeln fuer US-Maerkte in die Live-Liste der Sonntags-Suche (hoechstens 5 insgesamt, nach t-Wert)
const readJ = (f, d) => { try { return JSON.parse(readFileSync(new URL(f, import.meta.url), 'utf8')); } catch (e) { return d; } };
const su = readJ('./backtest-suche.json', null), added = [];
if (su) {
  const live = su.live || [];
  for (const r of passed.filter((x) => x.fam === 'mr' && GROUPS[x.gk].auto).sort((a, b) => b.o.tval - a.o.tval)) {
    const id = L.ruleId(r.rule); if (live.some((q) => q.id === id && q.gk === r.gk)) continue;
    const e = { id, gk: r.gk, name: r.name + ' · ' + r.grp, text: r.text, rule: r.rule, syms: GROUPS[r.gk].syms, stats: { n: r.o.all.n, win: r.o.all.win, mean: r.o.all.mean, lo: r.o.all.lo }, tval: r.o.tval, perYear: r.o.perYear, checked: 'netz', src: r.src };
    live.push(e); added.push(e.name);
  }
  live.sort((a, b) => b.tval - a.tval); su.live = live.slice(0, 5); su.reserveRules = (su.reserveRules || []).concat(live.slice(5)).slice(0, 10); su.netz = { at: new Date().toISOString(), added };
  writeFileSync(new URL('./backtest-suche.json', import.meta.url), JSON.stringify(su));
}
console.log('In die App (Neu entdeckt):', added.length ? added.join(', ') : 'keine');
writeFileSync(new URL('./backtest-netz.json', import.meta.url), JSON.stringify({ at: new Date().toISOString(), n: res.length, passed: passed.map((r) => ({ name: r.name, grp: r.grp, gk: r.gk, fam: r.fam, k: r.k, src: r.src, n: r.o.all.n, win: r.o.all.win, mean: r.o.all.mean, tval: r.o.tval })), added,
  res: res.map((r) => ({ fam: r.fam, k: r.k, name: r.name, src: r.src, grp: r.grp, gk: r.gk, pass: r.pass, n: r.o.all.n, win: r.o.all.win, mean: r.o.all.mean, ex: r.o.ex.all.mean, tval: r.o.tval, tex: r.o.tex, breadth: r.o.breadth, overlap: r.o.overlap, perYear: r.o.perYear, days: r.o.days, cost2: r.o.cost2.mean, why: r.o.why, nb: r.o.nb || null })) }));
