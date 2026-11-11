// Rueckrechnung weiterer Strategien aus Studien (eigene Daten von Yahoo, mit Kosten, drei Zeitraeume):
//  Tag:     IBS-Mean-Reversion, Turn of the Month, Overnight-Effekt
//  Stunde:  Market Intraday Momentum (Gao/Han/Li/Zhou 2018), Noise Area (Zarattini/Aziz/Barbon 2024)
//  Depot:   200-Tage/10-Monats-Trend (Faber 2007), Dual Momentum (Antonacci), Sektor-Rotation (Faber 2010)
// Bestanden (Trades): mind. 100 Trades, in allen drei Zeitraeumen im Plus und insgesamt sicher ueber null (95 %).
// Bestanden (Depot): bessere Sharpe Ratio und kleinerer groesster Verlust als Kaufen und Halten, in jedem Zeitraum im Plus.
import { readFileSync, writeFileSync } from 'node:fs';
const html = readFileSync(new URL('../trade/index.html', import.meta.url), 'utf8');
const src = html.split('// BEGIN LOGIC')[1].split('// END LOGIC')[0];
const L = new Function(src + '; return { parseYahoo, rStats, rsi2DailySignals, PLAY_STOCKS, ibsSignals, ibsExit, tomSignals, tomExit, overnightTrades, simDayTrade, imomTrades, noiseTrades, allocBacktest, perf, retOver, dayOf };')();
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; TradeCheck/1.0)' };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function raw(sym, iv, rg) {
  for (const host of ['query1', 'query2', 'query1']) {
    try { // range=max liefert bei Yahoo nur grobe Kerzen; fuer die ganze Historie Tageskerzen mit period1/period2 holen
      const q = rg === 'max' ? `interval=${iv}&period1=946684800&period2=${Math.floor(Date.now() / 1000)}` : `interval=${iv}&range=${rg}`;
      const r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?${q}`, { headers: UA }); if (r.ok) return await r.json(); } catch (e) {}
    await wait(1500);
  }
  return null;
}
const chart = async (sym, iv, rg) => { const j = await raw(sym, iv, rg); return j ? L.parseYahoo(j) : []; };
// Monatsschluesse mit Dividenden (adjclose), noetig fuer Anleihen und Depot-Vergleiche
async function monthly(sym) {
  const j = await raw(sym, '1d', 'max'); const res = j && j.chart && j.chart.result && j.chart.result[0]; if (!res) return {};
  const ts = res.timestamp || [], ac = (res.indicators.adjclose && res.indicators.adjclose[0].adjclose) || res.indicators.quote[0].close, o = {};
  ts.forEach((t, k) => { if (ac[k] != null) o[L.dayOf(t * 1000).slice(0, 7)] = ac[k]; });
  return o;
}
const pick = (a) => a ? { n: a.n, mean: +a.mean.toFixed(4), win: +a.win.toFixed(3), sum: +a.sum.toFixed(2), lo: a.lo != null ? +a.lo.toFixed(4) : null, hi: a.hi != null ? +a.hi.toFixed(4) : null } : { n: 0 };
const st = (arr) => pick(arr.length ? L.rStats(arr.map((t) => t.pct)) : null);
function evalSet(name, trades, days, extra) {
  trades = trades.filter((t) => t.pct != null && isFinite(t.pct));
  const ts = trades.map((t) => t.t).sort((a, b) => a - b);
  const cut = ts[Math.floor(ts.length * 0.75)] || 0, split = ts[Math.floor(ts.length * 0.375)] || 0;
  const tr = trades.filter((t) => t.t < split), te = trades.filter((t) => t.t >= split && t.t < cut), ho = trades.filter((t) => t.t >= cut);
  const o = Object.assign({ name, unit: '%', all: st(trades), train: st(tr), test: st(te), hold: st(ho), perDay: +(trades.length / Math.max(1, days)).toFixed(2),
    from: ts.length ? L.dayOf(ts[0]) : null }, extra || {});
  // Long-Strategien auf Tageskerzen muessen mehr bringen als einfach investiert zu sein (Ueberrendite gegen die mittlere Tagesrendite)
  if (trades.length && trades[0].ex != null) { const ex = (a) => st(a.map((t) => ({ pct: t.ex }))); o.ex = { all: ex(trades), train: ex(tr), test: ex(te), hold: ex(ho) }; }
  o.passed = o.all.n >= 100 && o.hold.n >= 20 && o.all.lo > 0 && [o.train, o.test, o.hold].every((x) => x.n && x.mean > 0) && (!o.ex || [o.ex.train, o.ex.test, o.ex.hold].every((x) => x.n && x.mean > 0));
  return o;
}
const out = { at: new Date().toISOString(), sets: {}, depot: {} };
const IDX = ['^GSPC', '^NDX', '^DJI', '^GDAXI'];
const COST_IDX = 0.07, COST_STK = 0.12, COST_INTRA = 0.05; // Prozent je Hin und Rueck: Spread des Knock-outs plus Ordergebuehr
// ---- Tageskerzen, 25 Jahre
const day = {};
for (const s of IDX.concat(['SPY', 'QQQ'])) { const d = await chart(s, '1d', 'max'); day[s] = d.slice(-6300); await wait(300); }
const nDays = Math.max(...Object.values(day).map((d) => d.length));
const ibsT = [], tomT = [], onT = [], onTr = [];
const drift = (d1) => { let s = 0; for (let k = 1; k < d1.length; k++) s += d1[k].c / d1[k - 1].c - 1; return s / (d1.length - 1) * 100; };
for (const s of IDX) {
  const d1 = day[s]; if (!d1 || d1.length < 400) continue; const dr = drift(d1);
  L.ibsSignals(d1).forEach((g) => { const r = L.simDayTrade(g, d1, { entry: 'close', exitFn: L.ibsExit(d1), maxDays: 5, stopAtr: 3, costPct: COST_IDX }); if (r.pct != null) ibsT.push({ t: g.t, s, pct: r.pct, days: r.days, ex: r.pct - dr * r.days }); });
  L.tomSignals(d1).forEach((g) => { const r = L.simDayTrade(g, d1, { entry: 'close', exitFn: L.tomExit(d1, g), maxDays: 6, stopAtr: 4, costPct: COST_IDX }); if (r.pct != null) tomT.push({ t: g.t, s, pct: r.pct, days: r.days, ex: r.pct - dr * r.days }); });
}
for (const s of ['SPY', 'QQQ']) { const d1 = day[s]; if (!d1 || d1.length < 400) continue; const dr = drift(d1); L.overnightTrades(d1, { costPct: COST_IDX }).forEach((x) => onT.push(Object.assign({ s, ex: x.pct - dr }, x))); L.overnightTrades(d1, { costPct: COST_IDX, trend: true }).forEach((x) => onTr.push(Object.assign({ s, ex: x.pct - dr }, x))); }
out.sets['ibs:idx'] = evalSet('IBS unter 0,2 im Aufwärtstrend (S&P 500, Nasdaq 100, Dow, DAX)', ibsT, nDays);
out.sets['tom:idx'] = evalSet('Turn of the Month (vorletzter Handelstag bis 3. Handelstag)', tomT, nDays);
out.sets['overnight:all'] = evalSet('Overnight: Kauf zum Schluss, Verkauf zur Eröffnung (SPY, QQQ)', onT, nDays);
out.sets['overnight:trend'] = evalSet('Overnight nur über dem 200-Tage-Schnitt', onTr, nDays);
out.overnightGross = st(onT.map((x) => ({ pct: x.pct + COST_IDX })));
// Einzelaktien (10 Jahre; Achtung: heutige Gewinner-Auswahl, die Zahlen sind deshalb zu gut)
const stkT = [];
for (const s of L.PLAY_STOCKS.slice(0, 30)) { const d1 = await chart(s, '1d', '10y'); await wait(250); if (d1.length < 400) continue; const dr = drift(d1); L.ibsSignals(d1).forEach((g) => { const r = L.simDayTrade(g, d1, { entry: 'close', exitFn: L.ibsExit(d1), maxDays: 5, stopAtr: 3, costPct: COST_STK }); if (r.pct != null) stkT.push({ t: g.t, s, pct: r.pct, ex: r.pct - dr * r.days }); }); }
out.sets['ibs:stocks'] = evalSet('IBS unter 0,2 im Aufwärtstrend (30 große US-Aktien)', stkT, 2520, { bias: 'survivor' });
// ---- 1-Std-Kerzen, 2 Jahre
const INTRA = ['SPY', 'QQQ', 'IWM', 'DIA', 'AAPL', 'MSFT', 'NVDA', 'AMZN', 'META', 'GOOGL', 'TSLA', 'AMD'];
const imT = [], imC = [], imM = [], nzT = [], nzL = [], nzE = [];
let iDays = 0;
for (const s of INTRA) {
  const h1 = await chart(s, '60m', '730d'); await wait(300); if (h1.length < 500) continue;
  iDays = Math.max(iDays, new Set(h1.map((x) => L.dayOf(x.t))).size);
  const etf = ['SPY', 'QQQ', 'IWM', 'DIA'].includes(s);
  L.imomTrades(h1, { costPct: COST_INTRA }).forEach((x) => imT.push(Object.assign({ s, etf }, x)));
  L.imomTrades(h1, { costPct: COST_INTRA, confirm: true }).forEach((x) => imC.push(Object.assign({ s, etf }, x)));
  L.imomTrades(h1, { costPct: COST_INTRA, minMove: 0.005 }).forEach((x) => imM.push(Object.assign({ s, etf }, x)));
  L.noiseTrades(h1, { costPct: COST_INTRA }).forEach((x) => (etf ? nzE : nzT).push(Object.assign({ s }, x)));
  L.noiseTrades(h1, { costPct: COST_INTRA, dirs: 1 }).forEach((x) => { if (etf) nzL.push(Object.assign({ s }, x)); });
}
out.sets['imom:etf'] = evalSet('Intraday-Momentum: 1. Stunde bestimmt letzte halbe Stunde (SPY, QQQ, IWM, DIA)', imT.filter((x) => x.etf), iDays);
out.sets['imom:etf_confirm'] = evalSet('Intraday-Momentum, vorletzte Stunde bestätigt (ETFs)', imC.filter((x) => x.etf), iDays);
out.sets['imom:etf_big'] = evalSet('Intraday-Momentum, nur wenn 1. Stunde mind. 0,5 % (ETFs)', imM.filter((x) => x.etf), iDays);
out.sets['imom:stocks'] = evalSet('Intraday-Momentum (8 große US-Aktien)', imT.filter((x) => !x.etf), iDays);
out.sets['noise:etf'] = evalSet('Noise Area „Beat the Market“ (SPY, QQQ, IWM, DIA)', nzE, iDays);
out.sets['noise:etf_long'] = evalSet('Noise Area, nur Long (ETFs)', nzL, iDays);
out.sets['noise:stocks'] = evalSet('Noise Area (8 große US-Aktien)', nzT, iDays);
out.intraDays = iDays;
// ---- Breite: RSI-2 und IBS auf vielen Maerkten, die nicht miteinander laufen. Maerkte werden nur nach den Jahren bis 2013
// ausgewaehlt (mind. 60 % Gewinner, im Plus); gezaehlt wird ausschliesslich ab 2014 (echte Vorhersage, kein Rosinenpicken).
const BREIT = [
  ['^GSPC', 'S&P 500', 'idx'], ['^NDX', 'Nasdaq 100', 'idx'], ['^DJI', 'Dow Jones', 'idx'], ['^RUT', 'Russell 2000', 'idx'], ['^GDAXI', 'DAX', 'idx'], ['^MDAXI', 'MDAX', 'idx'],
  ['^STOXX50E', 'Euro Stoxx 50', 'idx'], ['^FTSE', 'FTSE 100', 'idx'], ['^FCHI', 'CAC 40', 'idx'], ['^SSMI', 'SMI', 'idx'], ['^AEX', 'AEX', 'idx'], ['^IBEX', 'IBEX 35', 'idx'],
  ['FTSEMIB.MI', 'FTSE MIB', 'idx'], ['^N225', 'Nikkei 225', 'idx'], ['^HSI', 'Hang Seng', 'idx'], ['^AXJO', 'ASX 200', 'idx'],
  ['GC=F', 'Gold', 'cmd'], ['SI=F', 'Silber', 'cmd'], ['HG=F', 'Kupfer', 'cmd'],
  ['XLK', 'US-Technologie', 'etf'], ['XLF', 'US-Finanzen', 'etf'], ['XLE', 'US-Energie', 'etf'], ['XLV', 'US-Gesundheit', 'etf'], ['XLY', 'US-Zykl. Konsum', 'etf'], ['XLP', 'US-Basiskonsum', 'etf'],
  ['XLI', 'US-Industrie', 'etf'], ['XLB', 'US-Grundstoffe', 'etf'], ['XLU', 'US-Versorger', 'etf'], ['EEM', 'Schwellenländer', 'etf'], ['EWZ', 'Brasilien', 'etf'], ['EWJ', 'Japan', 'etf'],
  ['FXI', 'China', 'etf'], ['TLT', 'US-Staatsanleihen 20J', 'etf'], ['IWM', 'US-Nebenwerte (ETF)', 'etf'], ['DIA', 'Dow (ETF)', 'etf'], ['SMH', 'Halbleiter', 'etf'], ['XBI', 'Biotech', 'etf'], ['KRE', 'US-Regionalbanken', 'etf'], ['ITB', 'US-Hausbau', 'etf']
];
// Devisen (Tageskerzen von Yahoo mit unpassendem Schlusskurs) und Erdgas/Oel (Spruenge beim Kontraktwechsel) bewusst nicht dabei
const COST = { idx: 0.07, cmd: 0.10, etf: 0.08, fx: 0.03 }, CUT = Date.parse('2014-01-01');
const sma5Exit = (d1) => (k) => { if (k < 4) return false; let t = 0; for (let q = k - 4; q <= k; q++) t += d1[q].c; return d1[k].c > t / 5; };
const bm = [], oosR = [], oosI = [], ibsUS = [], ibsEU = [];
// Regionen fest nach Boersenplatz (nicht nach Ergebnis): US = US-Indizes und US-ETFs, Europa = europaeische Indizes
const US_SYMS = ['^GSPC', '^NDX', '^DJI', '^RUT', 'XLK', 'XLF', 'XLE', 'XLV', 'XLY', 'XLP', 'XLI', 'XLB', 'XLU', 'IWM', 'DIA', 'SMH', 'XBI', 'KRE', 'ITB'];
const EU_SYMS = ['^GDAXI', '^MDAXI', '^STOXX50E', '^FTSE', '^FCHI', '^SSMI', '^AEX', '^IBEX', 'FTSEMIB.MI'];
let oosDays = 0;
for (const [s, nm, cls] of BREIT) {
  const d1 = await chart(s, '1d', 'max'); await wait(300); if (d1.length < 1500) continue;
  const dr = drift(d1), cost = COST[cls], rs = [], is = [];
  L.rsi2DailySignals(d1).filter((g) => g.dir > 0).forEach((g) => { const r = L.simDayTrade(g, d1, { entry: 'open', exitFn: sma5Exit(d1), maxDays: 10, stopAtr: 3, costPct: cost }); if (r.pct != null) rs.push({ t: g.t, s, nm, pct: r.pct, ex: r.pct - dr * r.days, days: r.days }); });
  L.ibsSignals(d1).forEach((g) => { const r = L.simDayTrade(g, d1, { entry: 'close', exitFn: L.ibsExit(d1), maxDays: 5, stopAtr: 3, costPct: cost }); if (r.pct != null) is.push({ t: g.t, s, nm, pct: r.pct, ex: r.pct - dr * r.days, days: r.days }); });
  const ins = (a) => a.filter((x) => x.t < CUT), oos = (a) => a.filter((x) => x.t >= CUT), sel = (a) => { const x = st(ins(a)), e = st(ins(a).map((y) => ({ pct: y.ex }))); return x.n >= 30 && x.win >= 0.6 && x.mean > 0 && e.mean > 0; };
  const m = { s, nm, cls, from: L.dayOf(d1[0].t), rsi2: { is: st(ins(rs)), oos: st(oos(rs)), sel: sel(rs) }, ibs: { is: st(ins(is)), oos: st(oos(is)), sel: sel(is) } };
  bm.push(m); oosDays = Math.max(oosDays, d1.filter((x) => x.t >= CUT).length);
  if (m.rsi2.sel) oos(rs).forEach((x) => oosR.push(x));
  if (m.ibs.sel) oos(is).forEach((x) => oosI.push(x));
  if (US_SYMS.includes(s)) is.forEach((x) => ibsUS.push(x)); if (EU_SYMS.includes(s)) is.forEach((x) => ibsEU.push(x));
}
out.breadth = { markets: bm, cut: '2014-01-01', oosDays };
out.sets['breit:rsi2'] = evalSet('RSI-2 auf ' + bm.filter((m) => m.rsi2.sel).length + ' ausgewählten Märkten (nur ab 2014 gezählt)', oosR, oosDays);
out.sets['breit:ibs_us'] = evalSet('IBS auf allen US-Indizes und US-Sektoren (19 Märkte, seit 2000)', ibsUS, nDays);
out.sets['breit:ibs_eu'] = evalSet('IBS auf europäischen Indizes (9 Märkte, seit 2000)', ibsEU, nDays);
{ const x = out.sets['breit:ibs_us']; x.swingOk = x.all.n >= 100 && x.all.win >= 0.6 && x.all.lo > 0 && [x.train, x.test, x.hold].every((y) => y.n && y.mean > 0); x.syms = US_SYMS; }
out.sets['breit:ibs'] = evalSet('IBS auf ' + bm.filter((m) => m.ibs.sel).length + ' ausgewählten Märkten (nur ab 2014 gezählt)', oosI, oosDays);
// Swing-Freigabe wie bei RSI-2 (Tag): mind. 100 Trades, 60 % Gewinner, sicher ueber null, in allen drei Zeitraeumen im Plus
{ const x = out.sets['breit:rsi2']; x.swingOk = x.all.n >= 100 && x.all.win >= 0.6 && x.all.lo > 0 && [x.train, x.test, x.hold].every((y) => y.n && y.mean > 0); }
out.sets['breit:mix'] = evalSet('RSI-2 und IBS zusammen (ab 2014)', oosR.concat(oosI), oosDays);
// ---- Depot-Strategien (Monatsschluesse mit Dividenden)
const M = {};
for (const s of ['^GSPC', '^NDX', '^GDAXI', 'GC=F', 'SPY', 'EFA', 'AGG', 'BIL', 'XLK', 'XLF', 'XLE', 'XLV', 'XLY', 'XLP', 'XLI', 'XLB', 'XLU']) { M[s] = await monthly(s); await wait(300); }
const monthsOf = (syms, from) => Object.keys(M[syms[0]]).filter((m) => (!from || m >= from) && syms.every((s) => M[s][m])).sort();
function thirds(rets) { const n = rets.length, a = Math.floor(n * 0.375), b = Math.floor(n * 0.75); return [rets.slice(0, a), rets.slice(a, b), rets.slice(b)].map((x) => L.perf(x)); }
function depot(key, name, ms, pickFn, bench, note, benchW) {
  const s = L.allocBacktest(M, ms, pickFn, 0.1), b = L.allocBacktest(M, ms, benchW || (() => ({ [bench]: 1 })), 0);
  const p = L.perf(s.rets), pb = L.perf(b.rets), ps = thirds(s.rets), pbs = thirds(b.rets);
  const passed = p.n >= 60 && p.sharpe > pb.sharpe && p.maxdd < pb.maxdd && ps.every((x) => x.cagr > 0);
  const r = (x) => ({ n: x.n, cagr: +(x.cagr * 100).toFixed(1), maxdd: +(x.maxdd * 100).toFixed(1), sharpe: +x.sharpe.toFixed(2), from: x.from, to: x.to });
  out.depot[key] = { name, note, bench, all: r(p), bh: r(pb), periods: ps.map(r), bhPeriods: pbs.map(r), passed, now: s.picks.length ? pickFn(ms.length - 1) : null, nowMonth: ms[ms.length - 1] };
}
const sma = (s, ms, k, n) => { if (k < n - 1) return null; let t = 0; for (let q = k - n + 1; q <= k; q++) t += M[s][ms[q]]; return t / n; };
for (const [s, nm] of [['^GSPC', 'S&P 500'], ['^NDX', 'Nasdaq 100'], ['^GDAXI', 'DAX'], ['GC=F', 'Gold']]) {
  const ms = monthsOf([s], '2000-01');
  depot('trend:' + s, nm + ' über dem 10-Monats-Schnitt halten, sonst Cash', ms, (k) => (M[s][ms[k]] > (sma(s, ms, k, 10) || Infinity) ? { [s]: 1 } : {}), s, 'Faber 2007');
}
{ const ms = monthsOf(['SPY', 'EFA', 'AGG']);
  depot('gem', 'Dual Momentum: S&P 500 oder Welt ohne USA, sonst Anleihen', ms, (k) => {
    if (k < 12) return { AGG: 1 };
    const rs = L.retOver(M, 'SPY', ms, k, 12), re = L.retOver(M, 'EFA', ms, k, 12), rb = M.BIL[ms[k]] && M.BIL[ms[k - 12]] ? L.retOver(M, 'BIL', ms, k, 12) : 0;
    return rs > rb ? (rs >= re ? { SPY: 1 } : { EFA: 1 }) : { AGG: 1 };
  }, 'SPY', 'Antonacci 2014'); }
{ const SEC = ['XLK', 'XLF', 'XLE', 'XLV', 'XLY', 'XLP', 'XLI', 'XLB', 'XLU'], ms = monthsOf(SEC.concat(['SPY', 'AGG']));
  depot('sector', 'Sektor-Rotation: Top 3 nach 3/6/12-Monats-Stärke, unter dem 10-Monats-Schnitt Anleihen', ms, (k) => {
    if (k < 12) return { SPY: 1 };
    if (M.SPY[ms[k]] < sma('SPY', ms, k, 10)) return { AGG: 1 };
    const sc = SEC.map((s) => ({ s, v: (L.retOver(M, s, ms, k, 3) + L.retOver(M, s, ms, k, 6) + L.retOver(M, s, ms, k, 12)) / 3 })).sort((a, b) => b.v - a.v).slice(0, 3);
    const w = {}; sc.forEach((x) => { w[x.s] = 1 / 3; }); return w;
  }, 'alle 9 Sektoren gleich gewichtet', 'Faber 2010, Moskowitz/Grinblatt 1999', () => { const w = {}; SEC.forEach((s) => { w[s] = 1 / 9; }); return w; }); }
out.passed = Object.keys(out.sets).filter((k) => out.sets[k].passed);
out.depotPassed = Object.keys(out.depot).filter((k) => out.depot[k].passed);
writeFileSync(new URL('backtest-more.json', import.meta.url), JSON.stringify(out) + '\n');
console.log(JSON.stringify({ passed: out.passed, depot: out.depotPassed }, null, 1));
for (const k of Object.keys(out.sets)) { const x = out.sets[k]; console.log(k.padEnd(20), x.all.n, 'win', x.all.win, 'mean%', x.all.mean, 'lo', x.all.lo, '|', x.train.mean, x.test.mean, x.hold.mean, x.passed ? 'PASS' : ''); }
for (const k of Object.keys(out.depot)) { const x = out.depot[k]; console.log(k.padEnd(14), 'CAGR', x.all.cagr, 'DD', x.all.maxdd, 'Sh', x.all.sharpe, '| B&H', x.bh.cagr, x.bh.maxdd, x.bh.sharpe, x.passed ? 'PASS' : '', JSON.stringify(x.now)); }
