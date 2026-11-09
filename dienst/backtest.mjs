// Rueckrechnung des Trade-Check-Scanners mit echten Kursen (laeuft woechentlich in GitHub Actions).
// Ergebnis: dienst/backtest.json (Trefferquote, Ø R, Ampel-Wirkung, abgeleitete Gewichte). Ohne Schluessel.
import { readFileSync, writeFileSync } from 'node:fs';
const html = readFileSync(new URL('../trade/index.html', import.meta.url), 'utf8');
const src = html.split('// BEGIN LOGIC')[1].split('// END LOGIC')[0];
const L = new Function(src + '; return { INSTRUMENTS, parseYahoo, backtest, calibrate, rStats, analyzeTrades, excursionAdvice };')();
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; TradeCheck/1.0)' };
async function chart(sym, iv, rg) {
  for (const host of ['query1', 'query2']) {
    try {
      const r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${iv}&range=${rg}`, { headers: UA });
      if (r.ok) return L.parseYahoo(await r.json());
    } catch (e) { /* naechster Versuch */ }
    await new Promise((r) => setTimeout(r, 1500));
  }
  return [];
}
const all = [], per = {}, info = {};
for (const ins of L.INSTRUMENTS) {
  const [m15, h1, d1] = [await chart(ins.y, '15m', '60d'), await chart(ins.y, '60m', '6mo'), await chart(ins.y, '1d', '2y')];
  info[ins.k] = { m15: m15.length, h1: h1.length, d1: d1.length, from: m15.length ? new Date(m15[0].t).toISOString() : null };
  if (m15.length < 200) continue;
  const res = L.backtest({ instr: ins, m15, h1, d1 });
  per[ins.k] = res; all.push(...res);
}
// Gewichte aus allen Ergebnissen, dann noch einmal mit diesen Gewichten (zeigt, ob die Ampel besser trennt)
const cal = L.calibrate(all, 10);
const pick = (a) => a ? { n: a.n, mean: +a.mean.toFixed(3), win: +a.win.toFixed(3), sum: +a.sum.toFixed(2), lo: a.lo != null ? +a.lo.toFixed(3) : null, hi: a.hi != null ? +a.hi.toFixed(3) : null } : null;
const group = (fn) => { const g = {}; all.forEach((t) => { const k = fn(t); (g[k] = g[k] || []).push(t.r); }); return Object.fromEntries(Object.entries(g).map(([k, v]) => [k, pick(L.rStats(v))])); };
const berlinH = (t) => +new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', hourCycle: 'h23' }).format(new Date(t));
const out = {
  at: new Date().toISOString(), data: info, n: all.length, all: pick(L.rStats(all.map((t) => t.r))),
  byInstr: group((t) => t.instr), byAmpel: group((t) => t.ampel), byBias: group((t) => t.setups[1]), bySweep: group((t) => t.setups[0]),
  bySession: group((t) => berlinH(t.at) < 12 ? 'London' : 'New York'), byHow: group((t) => t.how),
  wmul: cal.wmul, calib: cal.info.map((x) => ({ key: x.key, title: x.title, d: +x.d.toFixed(3), m: x.m, yes: x.yes, no: x.no })),
  excursion: (() => { const a = L.excursionAdvice(all); return a ? { tips: a.tips, mfeMed: a.mfeMed, winMaeMed: a.winMaeMed } : null; })(),
  trades: all.sort((a, b) => b.at - a.at).slice(0, 150).map((t) => ({ k: t.instr, t: t.at, dir: t.dir, r: +t.r.toFixed(2), ampel: t.ampel, how: t.how, sweep: t.setups[0], bias: t.setups[1] === 'mit Tagestrend' ? 1 : 0, mfe: +t.mfe.toFixed(2), mae: +t.mae.toFixed(2) }))
};
writeFileSync(new URL('backtest.json', import.meta.url), JSON.stringify(out) + '\n');
console.log(JSON.stringify({ n: out.n, all: out.all, byAmpel: out.byAmpel, byBias: out.byBias, bySession: out.bySession, byInstr: out.byInstr, byHow: out.byHow, calib: out.calib, data: info }, null, 1));
