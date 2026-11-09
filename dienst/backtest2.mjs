// Grosse Rueckrechnung: Scanner auf 1-Std-Kerzen ueber 2 Jahre, alle Maerkte.
// Ehrlicher Ablauf: Qualitaetsstufe nur auf der ersten Haelfte auswaehlen, auf der zweiten Haelfte und auf 15-Min-Daten pruefen.
// Ergebnis: dienst/backtest-1h.json (ohne Schluessel). Laeuft woechentlich in GitHub Actions.
import { readFileSync, writeFileSync } from 'node:fs';
const html = readFileSync(new URL('../trade/index.html', import.meta.url), 'utf8');
const src = html.split('// BEGIN LOGIC')[1].split('// END LOGIC')[0];
const L = new Function(src + '; return { INSTRUMENTS, GRADES, parseYahoo, backtest, calibrate, rStats, analyzeTrades };')();
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
const h1all = [], m15all = [], info = {};
for (const ins of L.INSTRUMENTS) {
  const h1 = await chart(ins.y, '60m', '730d'), d1 = await chart(ins.y, '1d', '5y'), m15 = await chart(ins.y, '15m', '60d');
  info[ins.k] = { h1: h1.length, d1: d1.length, m15: m15.length, from: h1.length ? new Date(h1[0].t).toISOString().slice(0, 10) : null };
  if (h1.length > 500) h1all.push(...L.backtest({ instr: ins, m15: h1, h1: h1, d1, bar: 3600e3 }));
  if (m15.length > 500) m15all.push(...L.backtest({ instr: ins, m15, h1, d1 }));
}
const ts = h1all.map((t) => t.at).sort((a, b) => a - b);
const split = ts.length ? ts[Math.floor(ts.length / 2)] : 0;
const train = h1all.filter((t) => t.at < split), test = h1all.filter((t) => t.at >= split);
const pick = (a) => a ? { n: a.n, mean: +a.mean.toFixed(3), win: +a.win.toFixed(3), sum: +a.sum.toFixed(1), lo: a.lo != null ? +a.lo.toFixed(3) : null, hi: a.hi != null ? +a.hi.toFixed(3) : null } : { n: 0 };
const st = (arr) => pick(arr.length ? L.rStats(arr.map((t) => t.r)) : null);
const grades = L.GRADES.map((g) => {
  const f = (arr) => arr.filter((t) => g.fn(t.sig, t.ampel));
  return { id: g.id, name: g.name, train: st(f(train)), test: st(f(test)), m15: st(f(m15all)), all: st(f(h1all)) };
});
// Auswahl nur nach Trainingsteil: mindestens 25 Trades, bester Schnitt
const cand = grades.filter((g) => g.train.n >= 25 && g.train.mean > 0).sort((a, b) => b.train.mean - a.train.mean);
const chosen = cand[0] || null;
const passed = !!(chosen && chosen.test.n >= 15 && chosen.test.mean > 0 && (chosen.m15.n < 8 || chosen.m15.mean > -0.1));
// Ampel-Gewichte nur uebernehmen, wenn sie auf dem Testteil besser trennen als ohne
const cal = L.calibrate(train, 15);
const sep = (arr, w) => { const g = arr.filter((t) => t.ampel === 'gruen').map((t) => t.r), r = arr.filter((t) => t.ampel !== 'gruen').map((t) => t.r); const m = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0; return { green: g.length, d: m(g) - m(r) }; };
const out = {
  at: new Date().toISOString(), data: info, split: new Date(split).toISOString().slice(0, 10),
  n: { h1: h1all.length, train: train.length, test: test.length, m15: m15all.length },
  all: st(h1all), trainAll: st(train), testAll: st(test), m15All: st(m15all),
  grades, chosen: chosen ? chosen.id : null, passed,
  ampelSep: { train: sep(train), test: sep(test) },
  byInstr: Object.fromEntries(L.INSTRUMENTS.map((i) => [i.k, st(h1all.filter((t) => t.instr === i.k))])),
  calibTrain: cal.info.map((x) => ({ key: x.key, title: x.title, d: +x.d.toFixed(3), m: x.m }))
};
writeFileSync(new URL('backtest-1h.json', import.meta.url), JSON.stringify(out) + '\n');
console.log(JSON.stringify({ split: out.split, n: out.n, all: out.all, train: out.trainAll, test: out.testAll, chosen: out.chosen, passed, grades: grades.map((g) => [g.id, g.train.n, g.train.mean, g.test.n, g.test.mean, g.m15.n, g.m15.mean]), sep: out.ampelSep, data: info }, null, 1));
