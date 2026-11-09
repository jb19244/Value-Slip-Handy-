// Grosse Rueckrechnung: alle Setups (Liquidity Sweep, Trend-Pullback und klassische Strategien) auf 1-Std-Kerzen, ~30 Maerkte, seit 2024.
// Ehrlicher Ablauf: feste Stufenliste, eine Stufe gilt nur als gut, wenn sie in BEIDEN Zeit-Haelften im Plus liegt
// und insgesamt mit 95 % ueber null. Ergebnis: dienst/backtest-1h.json (ohne Schluessel). Laeuft woechentlich.
import { readFileSync, writeFileSync } from 'node:fs';
const html = readFileSync(new URL('../trade/index.html', import.meta.url), 'utf8');
const src = html.split('// BEGIN LOGIC')[1].split('// END LOGIC')[0];
const L = new Function(src + '; return { INSTRUMENTS, scanUniverse, marketContext, GRADES, SETUPS, setupName, gradeMatch, gradeName, parseYahoo, backtest, rStats, berlinFast };')();
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; TradeCheck/1.0)' };
async function chart(sym, iv, rg) {
  for (const host of ['query1', 'query2', 'query1']) {
    try {
      const r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${iv}&range=${rg}`, { headers: UA });
      if (r.ok) return L.parseYahoo(await r.json());
    } catch (e) { /* naechster Versuch */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return [];
}
const all = [], info = {};
const vix = await chart('^VIX', '1d', '5y'), dxy = await chart('DX-Y.NYB', '1d', '5y');
for (const ins of L.scanUniverse()) {
  const h1 = await chart(ins.y, '60m', '730d'), d1 = await chart(ins.y, '1d', '5y');
  info[ins.k] = { h1: h1.length, d1: d1.length, from: h1.length ? new Date(h1[0].t).toISOString().slice(0, 10) : null };
  if (h1.length < 500) continue;
  for (const setup of Object.keys(L.SETUPS)) all.push(...L.backtest({ instr: ins, m15: h1, h1, d1, bar: 3600e3, setup, any: true, be: setup === 'sweep' || setup === 'pullback', noCheck: setup !== 'sweep' && setup !== 'pullback' }).map((t) => { Object.assign(t.sig, L.marketContext(t.sig.day, ins, t.sig.dir, vix, dxy)); return Object.assign(t, { type: setup }); }));
  await new Promise((r) => setTimeout(r, 400));
}
const ts = all.map((t) => t.at).sort((a, b) => a - b);
const split = ts.length ? ts[Math.floor(ts.length / 2)] : 0;
const days = new Set(all.map((t) => L.berlinFast(t.at).key)).size;
const t0 = ts[0] || 0, t1 = ts[ts.length - 1] || 0, tradingDays = Math.max(1, (t1 - t0) / 86400e3 * 5 / 7);
const pick = (a) => a ? { n: a.n, mean: +a.mean.toFixed(3), win: +a.win.toFixed(3), sum: +a.sum.toFixed(1), lo: a.lo != null ? +a.lo.toFixed(3) : null, hi: a.hi != null ? +a.hi.toFixed(3) : null } : { n: 0 };
const st = (arr) => pick(arr.length ? L.rStats(arr.map((t) => t.r)) : null);
const grades = [];
for (const type of Object.keys(L.SETUPS)) for (const g of L.GRADES) {
  const id = type + ':' + g.id, f = (arr) => arr.filter((t) => L.gradeMatch(id, t.sig, t.ampel));
  const sel = f(all);
  grades.push({ id, type, name: L.gradeName(id), all: st(sel), train: st(sel.filter((t) => t.at < split)), test: st(sel.filter((t) => t.at >= split)), perDay: +(sel.length / tradingDays).toFixed(2) });
}
// A+ = Stufe, die in beiden Haelften klar im Plus liegt UND insgesamt mit 95 % ueber null (beste davon).
// A  = weitere Stufen, die in beiden Haelften im Plus liegen und im Schnitt mindestens +0,1 R bringen (noch nicht sicher belegt).
const strong = grades.filter((g) => g.train.n >= 5 && g.test.n >= 10 && g.train.mean > 0.1 && g.test.mean > 0.1 && g.all.lo > 0).sort((a, b) => b.all.mean - a.all.mean);
const chosen = strong[0] ? strong[0].id : null;
const aIds = grades.filter((g) => g.id !== chosen && g.all.n >= 50 && g.train.mean > 0 && g.test.mean > 0 && g.all.mean >= 0.1).sort((a, b) => b.all.mean - a.all.mean).map((g) => g.id);
const good0 = grades.filter((g) => g.id === chosen || aIds.includes(g.id));
// 60-%-Stufen: in BEIDEN Haelften mindestens 60 % Gewinner und im Plus, mindestens 30 Trades
const w60 = grades.filter((g) => g.all.n >= 30 && g.train.n >= 10 && g.test.n >= 10 && g.train.win >= 0.6 && g.test.win >= 0.6 && g.train.mean > 0 && g.test.mean > 0).sort((a, b) => b.all.mean - a.all.mean).map((g) => g.id);
const good = grades.filter((g) => good0.includes(g) || w60.includes(g.id));
const inA = all.filter((t) => good.some((g) => L.gradeMatch(g.id, t.sig, t.ampel)));
const inTop = chosen ? all.filter((t) => L.gradeMatch(chosen, t.sig, t.ampel)) : [];
const byInstr = {}; inA.forEach((t) => { (byInstr[t.instr] = byInstr[t.instr] || []).push(t); });
const out = {
  at: new Date().toISOString(), data: info, split: new Date(split).toISOString().slice(0, 10), tradingDays: Math.round(tradingDays), markets: Object.keys(info).filter((k) => info[k].h1 >= 500).length,
  n: Object.assign({ all: all.length }, Object.fromEntries(Object.keys(L.SETUPS).map((k) => [k, all.filter((t) => t.type === k).length]))),
  byType: Object.fromEntries(Object.keys(L.SETUPS).map((k) => [k, { name: L.setupName(k), ...st(all.filter((t) => t.type === k)), train: st(all.filter((t) => t.type === k && t.at < split)), test: st(all.filter((t) => t.type === k && t.at >= split)) }])),
  all: st(all), grades, passed: !!chosen, chosen, second: aIds[0] || null, aIds, w60, ctx: { vix: vix.length, dxy: dxy.length },
  top: { ...st(inTop), perDay: +(inTop.length / tradingDays).toFixed(2) },
  good: { ...st(inA), perDay: +(inA.length / tradingDays).toFixed(2), train: st(inA.filter((t) => t.at < split)), test: st(inA.filter((t) => t.at >= split)) },
  goodByInstr: Object.fromEntries(Object.entries(byInstr).map(([k, v]) => [k, st(v)]))
};
// Positionsfuehrung und Dossier je guter Stufe: Stop bei 1R auf Einstand vs. stehen lassen; Trefferbilder
const q = (arr, p) => { if (!arr.length) return null; const a = arr.slice().sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p * a.length))]; };
const stR = (arr, key) => pick(arr.length ? L.rStats(arr.map((t) => t[key] != null ? t[key] : t.r)) : null);
out.dossier = {};
good.forEach((g) => {
  const sel = all.filter((t) => L.gradeMatch(g.id, t.sig, t.ampel)), tr = sel.filter((t) => t.at < split), te = sel.filter((t) => t.at >= split);
  const fixed = { all: stR(sel, 'r'), train: stR(tr, 'r'), test: stR(te, 'r') }, be = { all: stR(sel, 'rBe'), train: stR(tr, 'rBe'), test: stR(te, 'rBe') };
  const beBetter = be.train.n && be.train.mean > fixed.train.mean && be.test.mean > fixed.test.mean;
  const wins = sel.filter((t) => t.r > 0), hold = sel.filter((t) => t.closedAt).map((t) => (t.closedAt - t.at) / 3600e3);
  out.dossier[g.id] = { n: sel.length, fixed, be, mgmt: beBetter ? 'be' : 'fixed',
    pTarget: +(sel.filter((t) => t.how === 'Ziel').length / Math.max(1, sel.length)).toFixed(3),
    pStop: +(sel.filter((t) => t.how === 'Stop').length / Math.max(1, sel.length)).toFixed(3),
    pEod: +(sel.filter((t) => t.how === 'Tagesende').length / Math.max(1, sel.length)).toFixed(3),
    p1R: +(sel.filter((t) => t.mfe >= 1).length / Math.max(1, sel.length)).toFixed(3),
    maeWinMed: wins.length ? +q(wins.map((t) => t.mae), 0.5).toFixed(2) : null, maeWin20: wins.length ? +q(wins.map((t) => t.mae), 0.2).toFixed(2) : null,
    holdMed: hold.length ? +q(hold, 0.5).toFixed(1) : null, rrMed: +q(sel.map((t) => t.sig.rr), 0.5).toFixed(2),
    longs: stR(sel.filter((t) => t.dir > 0), 'r'), shorts: stR(sel.filter((t) => t.dir < 0), 'r'),
    london: stR(sel.filter((t) => t.sig.session === 'London'), 'r'), ny: stR(sel.filter((t) => t.sig.session === 'New York'), 'r'),
    byInstr: Object.fromEntries(Object.entries(sel.reduce((m, t) => { (m[t.instr] = m[t.instr] || []).push(t); return m; }, {})).map(([k, v]) => [k, stR(v, 'r')])) };
});
writeFileSync(new URL('backtest-1h.json', import.meta.url), JSON.stringify(out) + '\n');
console.log(JSON.stringify({ w60, dossier: out.dossier, split: out.split, tradingDays: out.tradingDays, markets: out.markets, n: out.n, all: out.all, chosen, aIds, top: out.top, good: out.good,
  grades: grades.map((g) => [g.id, g.all.n, g.all.mean, g.train.n, g.train.mean, g.test.n, g.test.mean, g.all.lo, g.perDay]) }, null, 1));
