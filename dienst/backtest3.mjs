// Rueckrechnung der Strategien aus der Forschung (eigene Zeitebenen):
//  - ORB "Stocks in Play" (5-Min, 45 liquide US-Aktien, Auswahl nach relativem Volumen)
//  - Connors RSI-2 auf Tageskerzen (Indizes, Gold, US-Aktien, 10 Jahre)
//  - News-Fehlausbruch / News-Momentum (15-Min, Forex, Gold, Indizes)
// Pruefung wie ueberall: drei Zeitraeume (1. Haelfte, 2. Haelfte der ersten 75 %, Haertetest = letzte 25 %), mit Kosten.
import { readFileSync, writeFileSync } from 'node:fs';
const html = readFileSync(new URL('../trade/index.html', import.meta.url), 'utf8');
const src = html.split('// BEGIN LOGIC')[1].split('// END LOGIC')[0];
const L = new Function(src + '; return { INSTRUMENTS, PLAY_STOCKS, stockInstrument, instrumentByKey, parseYahoo, orbPlayDay, rsi2DailySignals, simDaily, scanNews, simulate, costOf, rStats, berlinFast, biasAt };')();
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; TradeCheck/1.0)' };
async function chart(sym, iv, rg) {
  for (const host of ['query1', 'query2', 'query1']) {
    try { const r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${iv}&range=${rg}`, { headers: UA }); if (r.ok) return L.parseYahoo(await r.json()); } catch (e) {}
    await new Promise((r) => setTimeout(r, 1500));
  }
  return [];
}
const pick = (a) => a ? { n: a.n, mean: +a.mean.toFixed(3), win: +a.win.toFixed(3), sum: +a.sum.toFixed(1), lo: a.lo != null ? +a.lo.toFixed(3) : null, hi: a.hi != null ? +a.hi.toFixed(3) : null } : { n: 0 };
const st = (arr) => pick(arr.length ? L.rStats(arr.map((t) => t.r)) : null);
function evalSet(name, trades, days) {
  const ts = trades.map((t) => t.at).sort((a, b) => a - b);
  const cut = ts[Math.floor(ts.length * 0.75)] || 0, split = ts[Math.floor(ts.length * 0.375)] || 0;
  const tr = trades.filter((t) => t.at < split), te = trades.filter((t) => t.at >= split && t.at < cut), ho = trades.filter((t) => t.at >= cut);
  const o = { name, all: st(trades), train: st(tr), test: st(te), hold: st(ho), perDay: +(trades.length / Math.max(1, days)).toFixed(2) };
  o.passed = o.all.n >= 30 && o.hold.n >= 10 && [o.train, o.test, o.hold].every((x) => x.n && x.mean >= 0.05);
  return o;
}
const out = { at: new Date().toISOString(), sets: {} };
// ---- ORB Stocks in Play
const play = {};
for (const sym of L.PLAY_STOCKS) { play[sym] = { m5: await chart(sym, '5m', '60d'), d1: await chart(sym, '1d', '1y') }; await new Promise((r) => setTimeout(r, 300)); }
const days = [...new Set(Object.values(play).flatMap((p) => p.m5.map((x) => L.berlinFast(x.t).key)))].sort();
const orbAll = [];
for (const day of days) {
  const cands = [];
  for (const sym of L.PLAY_STOCKS) { const p = play[sym]; if (!p.m5.length || !p.d1.length) continue; const g = L.orbPlayDay(p.m5, p.d1, day); if (g) cands.push(Object.assign(g, { sym })); }
  cands.sort((a, b) => b.rvol - a.rvol);
  cands.forEach((g, rank) => {
    const p = play[g.sym], ins = L.stockInstrument(g.sym), sim = L.simulate(g, p.m5, L.costOf(ins, g.entry));
    if (!sim.filled || sim.r == null) return;
    const bias = L.biasAt(p.d1, day);
    orbAll.push({ at: g.t, day, sym: g.sym, rank, rvol: g.rvol, dir: g.dir, withBias: bias === g.dir, r: sim.r, rGross: sim.r + L.costOf(ins, g.entry) * 1.5 / g.risk });
  });
}
const nd = days.length;
out.orbDays = nd;
out.sets['orbplay:top3_rvol2'] = evalSet('ORB Stocks in Play: Top 3 nach rel. Volumen (mind. 2-fach)', orbAll.filter((t) => t.rank < 3 && t.rvol >= 2), nd);
out.sets['orbplay:top5_rvol1'] = evalSet('ORB Stocks in Play: Top 5 (mind. 1-fach)', orbAll.filter((t) => t.rank < 5 && t.rvol >= 1), nd);
out.sets['orbplay:top3_trend'] = evalSet('ORB Stocks in Play: Top 3, mit Tagestrend', orbAll.filter((t) => t.rank < 3 && t.rvol >= 2 && t.withBias), nd);
out.sets['orbplay:alle'] = evalSet('ORB ohne Volumenfilter (zum Vergleich)', orbAll, nd);
out.orbGross = st(orbAll.filter((t) => t.rank < 3 && t.rvol >= 2).map((t) => ({ r: t.rGross })));
// ---- Connors RSI-2 auf Tageskerzen
const rsiUni = ['SPX', 'NDX', 'DJI', 'DAX', 'XAUUSD'].map((k) => L.instrumentByKey(k)).concat(L.PLAY_STOCKS.slice(0, 30).map(L.stockInstrument));
const rsiT = []; let rsiDays = 0;
for (const ins of rsiUni) {
  const d1 = await chart(ins.y, '1d', '10y'); if (d1.length < 300) continue; rsiDays = Math.max(rsiDays, d1.length);
  L.rsi2DailySignals(d1).forEach((g) => { const sim = L.simDaily(g, d1, L.costOf(ins, g.close)); if (sim.filled && sim.r != null) rsiT.push({ at: g.t, dir: g.dir, idx: ins.type !== 'stock', r: sim.r }); });
  await new Promise((r) => setTimeout(r, 300));
}
out.rsiDays = rsiDays;
out.sets['rsi2d:long'] = evalSet('Connors RSI-2 (Tag), nur Long', rsiT.filter((t) => t.dir > 0), rsiDays);
out.sets['rsi2d:long_idx'] = evalSet('Connors RSI-2 (Tag), Long, nur Indizes und Gold', rsiT.filter((t) => t.dir > 0 && t.idx), rsiDays);
out.sets['rsi2d:short'] = evalSet('Connors RSI-2 (Tag), nur Short', rsiT.filter((t) => t.dir < 0), rsiDays);
// ---- News (15 Min)
const newsUni = ['EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'XAUUSD', 'WTI', 'DAX', 'NDX', 'SPX'].map((k) => L.instrumentByKey(k)).filter(Boolean);
const newsT = []; let newsDays = 0;
for (const ins of newsUni) {
  const c = await chart(ins.y, '15m', '60d'), d1 = await chart(ins.y, '1d', '1y'); if (c.length < 200) continue;
  newsDays = Math.max(newsDays, new Set(c.map((x) => L.berlinFast(x.t).key)).size);
  L.scanNews(c, { instr: ins, d1 }).forEach((g) => { const sim = L.simulate(g, c, L.costOf(ins, g.entry)); if (sim.filled && sim.r != null) newsT.push({ at: g.t, type: g.type, withBias: g.withBias, r: sim.r }); });
}
out.newsDays = newsDays;
out.sets['news:fade'] = evalSet('News-Fehlausbruch (Gegenrichtung zur Spitze)', newsT.filter((t) => t.type === 'newsfade'), newsDays);
out.sets['news:mom'] = evalSet('News-Momentum (Richtung der Spitze)', newsT.filter((t) => t.type === 'newsmom'), newsDays);
out.sets['news:fade_trend'] = evalSet('News-Fehlausbruch, mit Tagestrend', newsT.filter((t) => t.type === 'newsfade' && t.withBias), newsDays);
out.passed = Object.keys(out.sets).filter((k) => out.sets[k].passed);
// Swing-Stufe (mehrtaegig): mind. 60 % Gewinner, in allen drei Zeitraeumen im Plus und insgesamt sicher ueber null
out.swing = Object.keys(out.sets).filter((k) => { const x = out.sets[k]; return k.startsWith('rsi2d') && x.all.n >= 100 && x.all.win >= 0.6 && x.all.lo > 0 && [x.train, x.test, x.hold].every((y) => y.n && y.mean > 0); });
writeFileSync(new URL('backtest-extra.json', import.meta.url), JSON.stringify(out) + '\n');
console.log(JSON.stringify(out, null, 1));
