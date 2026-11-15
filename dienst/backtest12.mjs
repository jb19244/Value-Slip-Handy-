// Pruefung des SMC-Leitfadens (quantum-algo.com) gegen unseren Sweep-Scanner, 1-Std-Kerzen, ~30 Maerkte, 2 Jahre, mit Kosten.
// Leitfaden: (1) nur mit dem Trend der hoeheren Zeitebene, (2) Liquiditaet markieren, (3) auf den Sweep warten, (4) CHoCH und Einstieg im FVG,
// (5) Stop 1,5 bis 2 ATR hinter dem Sweep, Ziel an der naechsten Liquiditaet mit mindestens 1:3, Haelfte am ersten Ziel, Rest mit Stop auf Einstand.
// Verglichen wird mit unserem Standard (Stop 0,1 ATR hinter dem Sweep, Ziel ab 1:2, sonst 2,5 R). Drei Zeitabschnitte, Haertetest (unguenstigste
// Ausfuehrung, doppelte Kosten), nach Handelstagen gebuendelt. Ergebnis: dienst/backtest-smc.json
import { readFileSync, writeFileSync } from 'node:fs';
const html = readFileSync(new URL('../trade/index.html', import.meta.url), 'utf8');
const src = html.split('// BEGIN LOGIC')[1].split('// END LOGIC')[0];
const L = new Function(src + '; return { scanUniverse, parseYahoo, backtest, rStats, berlinFast };')();
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; TradeCheck/1.0)' };
async function chart(sym, iv, rg) {
  for (const host of ['query1', 'query2', 'query1']) {
    try { const r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${iv}&range=${rg}`, { headers: UA }); if (r.ok) return L.parseYahoo(await r.json()); } catch (e) {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  return [];
}
const V = {
  standard: { name: 'Unser Standard: Stop 0,1 ATR hinter dem Sweep, Ziel ab 1:2' },
  ziel3: { name: 'Nur Ziel an der Liquidität mit mind. 1:3', minRR: 3, needLiq: true },
  stop15: { name: 'Nur Stop 1,5 ATR hinter dem Sweep', stopBuf: 1.5 },
  leitfaden15: { name: 'Leitfaden: Stop 1,5 ATR, Ziel Liquidität mind. 1:3', stopBuf: 1.5, minRR: 3, needLiq: true },
  leitfaden20: { name: 'Leitfaden: Stop 2 ATR, Ziel Liquidität mind. 1:3', stopBuf: 2, minRR: 3, needLiq: true },
  stop05: { name: 'Stop 0,5 ATR hinter dem Sweep', stopBuf: 0.5 }
};
const T = {}; Object.keys(V).forEach((k) => { T[k] = []; });
let nIns = 0;
for (const ins of L.scanUniverse()) {
  const h1 = await chart(ins.y, '60m', '730d'), d1 = await chart(ins.y, '1d', '5y');
  if (h1.length < 500) continue; nIns++;
  for (const k of Object.keys(V)) T[k].push(...L.backtest(Object.assign({ instr: ins, m15: h1, h1, d1, bar: 3600e3, setup: 'sweep', any: true, stress: true, be: true, noCheck: true }, V[k])).map((t) => ({ at: t.at, k: ins.k, r: t.r, rPart: t.rPart, rStress: t.rStress, wb: !!t.sig.withBias })));
  await new Promise((r) => setTimeout(r, 300));
}
const pick = (a) => a ? { n: a.n, mean: +a.mean.toFixed(3), win: +a.win.toFixed(3), lo: a.lo != null ? +a.lo.toFixed(3) : null } : { n: 0 };
const stat = (arr, f) => pick(arr.length ? L.rStats(arr.map(f)) : null);
const byDay = (arr, f) => { const g = {}; arr.forEach((t) => { const d = L.berlinFast(t.at).key; (g[d] = g[d] || []).push(f(t)); }); return pick(L.rStats(Object.values(g).map((a) => a.reduce((x, y) => x + y, 0) / a.length))); };
const out = { at: new Date().toISOString(), markets: nIns, sets: {} };
for (const k of Object.keys(V)) for (const flt of ['alle', 'mitTrend']) {
  const a = T[k].filter((t) => flt === 'alle' || t.wb).sort((x, y) => x.at - y.at); if (!a.length) continue;
  const c1 = a[Math.floor(a.length / 3)].at, c2 = a[Math.floor(a.length * 2 / 3)].at, P = (t) => t.rPart, F = (t) => t.r, S = (t) => t.rStress != null ? t.rStress : t.rPart;
  const o = { name: V[k].name + (flt === 'mitTrend' ? ', nur mit dem Tagestrend' : ''), part: stat(a, P), full: stat(a, F), stress: stat(a, S), day: byDay(a, P),
    thirds: [a.filter((t) => t.at < c1), a.filter((t) => t.at >= c1 && t.at < c2), a.filter((t) => t.at >= c2)].map((x) => stat(x, P)), perDay: +(a.length / (new Set(a.map((t) => L.berlinFast(t.at).key)).size || 1)).toFixed(2) };
  o.passed = o.part.n >= 100 && o.day.lo > 0 && o.thirds.every((x) => x.n && x.mean > 0) && o.stress.mean > 0;
  out.sets[k + ':' + flt] = o;
  console.log((o.passed ? 'OK  ' : '--  ') + (k + ':' + flt).padEnd(22), 'n', String(o.part.n).padStart(5), 'win', o.part.win, 'Ø', o.part.mean, '(voll', o.full.mean + ')', 'Haertetest', o.stress.mean, 'Tage-lo', o.day.lo, 'Drittel', o.thirds.map((x) => x.mean).join(' / '));
}
writeFileSync(new URL('./backtest-smc.json', import.meta.url), JSON.stringify(out));
