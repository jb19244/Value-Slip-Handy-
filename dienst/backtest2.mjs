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
let all = [], info = {}, hp = [];
const HP_TYPES = ['sweep', 'pullback', 'orb', 'donch', 'rsi2', 'nr7', 'gap'], HP_R = [0.5, 0.75, 1];
const vix = await chart('^VIX', '1d', '5y'), dxy = await chart('DX-Y.NYB', '1d', '5y');
for (const ins of L.scanUniverse()) {
  const h1 = await chart(ins.y, '60m', '730d'), d1 = await chart(ins.y, '1d', '5y');
  info[ins.k] = { h1: h1.length, d1: d1.length, from: h1.length ? new Date(h1[0].t).toISOString().slice(0, 10) : null };
  if (h1.length < 500) continue;
  for (const setup of Object.keys(L.SETUPS)) all.push(...L.backtest({ instr: ins, m15: h1, h1, d1, bar: 3600e3, setup, any: true, be: setup === 'sweep' || setup === 'pullback', noCheck: setup !== 'sweep' && setup !== 'pullback', conf: ['sweep', 'pullback', 'nr7r1'].includes(setup) }).map((t) => { Object.assign(t.sig, L.marketContext(t.sig.day, ins, t.sig.dir, vix, dxy)); return Object.assign(t, { type: setup }); }));
  // Hohe Trefferquote: gleiche Signale, Ziel naeher (0,5 / 0,75 / 1 R), Stop unveraendert
  for (const setup of HP_TYPES) for (const k of HP_R) hp.push(...L.backtest({ instr: ins, m15: h1, h1, d1, bar: 3600e3, setup, any: true, noCheck: true, tgtR: k }).map((t) => { Object.assign(t.sig, L.marketContext(t.sig.day, ins, t.sig.dir, vix, dxy)); return Object.assign(t, { type: setup, k }); }));
  await new Promise((r) => setTimeout(r, 400));
}
const ts = all.map((t) => t.at).sort((a, b) => a - b);
// Drei Zeitraeume: Auswahl nur auf den ersten 75 % (1. und 2. Haelfte davon), die letzten 25 % bleiben unberuehrt (Haertetest)
const cut = ts.length ? ts[Math.floor(ts.length * 0.75)] : 0;
const split = ts.length ? ts[Math.floor(ts.length * 0.375)] : 0;
const full = all; all = all.filter((t) => t.at < cut); const hold = full.filter((t) => t.at >= cut);
const days = new Set(all.map((t) => L.berlinFast(t.at).key)).size;
const t0 = ts[0] || 0, t1 = cut || 0, tradingDays = Math.max(1, (t1 - t0) / 86400e3 * 5 / 7);
const pick = (a) => a ? { n: a.n, mean: +a.mean.toFixed(3), win: +a.win.toFixed(3), sum: +a.sum.toFixed(1), lo: a.lo != null ? +a.lo.toFixed(3) : null, hi: a.hi != null ? +a.hi.toFixed(3) : null } : { n: 0 };
const st = (arr) => pick(arr.length ? L.rStats(arr.map((t) => t.r)) : null);
const grades = [];
for (const type of Object.keys(L.SETUPS)) for (const g of L.GRADES) {
  const id = type + ':' + g.id, f = (arr) => arr.filter((t) => L.gradeMatch(id, t.sig, t.ampel));
  const sel = f(all);
  const hs = st(f(hold));
  grades.push({ id, type, name: L.gradeName(id), hold: hs, all: st(sel), train: st(sel.filter((t) => t.at < split)), test: st(sel.filter((t) => t.at >= split)), perDay: +(sel.length / tradingDays).toFixed(2) });
}
// A+ = Stufe, die in beiden Haelften klar im Plus liegt UND insgesamt mit 95 % ueber null (beste davon).
// A  = weitere Stufen, die in beiden Haelften im Plus liegen und im Schnitt mindestens +0,1 R bringen (noch nicht sicher belegt).
const strong = grades.filter((g) => g.train.n >= 5 && g.test.n >= 10 && g.train.mean > 0.1 && g.test.mean > 0.1 && g.all.lo > 0).sort((a, b) => b.all.mean - a.all.mean);
const chosen = strong[0] ? strong[0].id : null;
const aIds = grades.filter((g) => g.id !== chosen && g.all.n >= 50 && g.train.mean > 0 && g.test.mean > 0 && g.all.mean >= 0.1).sort((a, b) => b.all.mean - a.all.mean).map((g) => g.id);
const good0 = grades.filter((g) => g.id === chosen || aIds.includes(g.id));
// 60-%-Stufen: insgesamt mindestens 60 % Gewinner, in keiner Haelfte unter 55 %, in beiden Haelften im Plus, mindestens 30 Trades
const w60 = grades.filter((g) => g.all.n >= 30 && g.train.n >= 10 && g.test.n >= 10 && g.all.win >= 0.6 && g.train.win >= 0.55 && g.test.win >= 0.55 && g.train.mean > 0 && g.test.mean > 0).sort((a, b) => b.all.mean - a.all.mean).map((g) => g.id);
// Dreifach geprueft: im Plus in 1. Haelfte, 2. Haelfte UND im unberuehrten Zeitraum (ab jetzt ist die Live-Bilanz der einzige unberuehrte Test)
const triple = grades.filter((g) => g.all.n >= 30 && g.hold.n >= 10 && g.train.mean >= 0.05 && g.test.mean >= 0.05 && g.hold.mean >= 0.05).sort((a, b) => (b.all.mean + b.hold.mean) - (a.all.mean + a.hold.mean)).map((g) => g.id);
// 5. Stufe (vom Nutzer gewaehlt): NR7-Ausbruch, Ziel 1 R, mit Tagestrend bei VIX ab 20 - solange in allen drei Zeitraeumen im Plus
const fifthG = grades.find((g) => g.id === 'nr7r1:trend_vixhi');
const extra = fifthG && fifthG.train.mean > 0 && fifthG.test.mean > 0 && fifthG.hold.mean > 0 ? ['nr7r1:trend_vixhi'] : [];
const good = grades.filter((g) => good0.includes(g) || w60.includes(g.id) || triple.includes(g.id) || extra.includes(g.id));
const inA = all.filter((t) => good.some((g) => L.gradeMatch(g.id, t.sig, t.ampel)));
const inTop = chosen ? all.filter((t) => L.gradeMatch(chosen, t.sig, t.ampel)) : [];
const byInstr = {}; inA.forEach((t) => { (byInstr[t.instr] = byInstr[t.instr] || []).push(t); });
const out = {
  at: new Date().toISOString(), data: info, split: new Date(split).toISOString().slice(0, 10), tradingDays: Math.round(tradingDays), markets: Object.keys(info).filter((k) => info[k].h1 >= 500).length,
  n: Object.assign({ all: all.length }, Object.fromEntries(Object.keys(L.SETUPS).map((k) => [k, all.filter((t) => t.type === k).length]))),
  byType: Object.fromEntries(Object.keys(L.SETUPS).map((k) => [k, { name: L.setupName(k), ...st(all.filter((t) => t.type === k)), train: st(all.filter((t) => t.type === k && t.at < split)), test: st(all.filter((t) => t.type === k && t.at >= split)) }])),
  all: st(all), holdFrom: new Date(cut).toISOString().slice(0, 10), holdAll: st(hold), tests: grades.length, grades, passed: !!chosen, chosen, second: aIds[0] || null, aIds, w60, triple, extra, ctx: { vix: vix.length, dxy: dxy.length },
  top: { ...st(inTop), perDay: +(inTop.length / tradingDays).toFixed(2) },
  good: { ...st(inA), perDay: +(inA.length / tradingDays).toFixed(2), train: st(inA.filter((t) => t.at < split)), test: st(inA.filter((t) => t.at >= split)) },
  goodByInstr: Object.fromEntries(Object.entries(byInstr).map(([k, v]) => [k, st(v)]))
};
const Phi = (x) => { const t = 1 / (1 + 0.2316419 * Math.abs(x)), d = 0.3989423 * Math.exp(-x * x / 2), p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; };
grades.forEach((g) => { if (g.all.n >= 10 && g.all.hi != null){ const se = (g.all.hi - g.all.lo) / (2 * 1.96), tv = se > 0 ? g.all.mean / se : 0; g.p = +(1 - Phi(tv)).toFixed(5); g.pAdj = +Math.min(1, g.p * grades.length).toFixed(4); } });
// Haertetest der gemeldeten Stufen auf dem unberuehrten Zeitraum
const holdOf = (ids) => st(hold.filter((t) => ids.some((id) => L.gradeMatch(id, t.sig, t.ampel))));
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
out.holdTop = chosen ? holdOf([chosen]) : null; out.holdTriple = triple.length ? holdOf(triple) : null; out.holdGood = holdOf(good.map((g) => g.id)); out.holdW60 = w60.length ? holdOf(w60) : null;
// Alle Trades der gemeldeten Stufen (R und Zeit) fuer die Risiko-Simulation in der App
out.rSeries = full.filter((t) => good.some((g) => L.gradeMatch(g.id, t.sig, t.ampel))).sort((a, b) => a.at - b.at).map((t) => [Math.round(t.at / 60000), +t.r.toFixed(2), w60.some((id) => L.gradeMatch(id, t.sig, t.ampel)) ? 1 : 0, triple.some((id) => L.gradeMatch(id, t.sig, t.ampel)) ? 1 : 0]);
// Auswertung hohe Trefferquote: je Setup x Ziel x Filter; bestanden = in 1. Haelfte, 2. Haelfte und Haertetest mindestens 60 % Gewinner und im Plus
const HP_G = ['alle', 'trend', 'trend_lon', 'trend_ny', 'trend_vixhi', 'trend_vix', 'trend_usd'];
out.hp = [];
for (const type of HP_TYPES) for (const k of HP_R) for (const gid of HP_G) {
  const sel = hp.filter((t) => t.type === type && t.k === k && L.gradeMatch(gid, t.sig, null));
  const tr = sel.filter((t) => t.at < split), te = sel.filter((t) => t.at >= split && t.at < cut), ho = sel.filter((t) => t.at >= cut);
  out.hp.push({ id: type + '@' + k + ':' + gid, type, k, grade: gid, name: L.setupName(type) + ', Ziel ' + String(k).replace('.', ',') + ' R, ' + L.gradeName(gid), all: st(sel), train: st(tr), test: st(te), hold: st(ho), perDay: +(sel.length / (tradingDays / 0.75)).toFixed(2) });
}
// Zusatzstufen mit naeherem Ziel: in allen drei Zeitraeumen im Plus, mindestens 58 % Gewinner je Zeitraum, mindestens 100 Trades
out.hpTiers = out.hp.filter((g) => g.all.n >= 100 && [g.train, g.test, g.hold].every((x) => x.n >= 15 && x.mean > 0 && x.win >= 0.58)).sort((a, b) => b.all.mean - a.all.mean).slice(0, 3)
  .map((g) => ({ id: g.id, type: g.type, k: g.k, grade: g.grade, name: g.name, n: g.all.n + g.hold.n, win: +((g.all.win * g.all.n + g.hold.win * g.hold.n) / (g.all.n + g.hold.n)).toFixed(3), mean: +((g.all.mean * g.all.n + g.hold.mean * g.hold.n) / (g.all.n + g.hold.n)).toFixed(3), hold: g.hold, perDay: g.perDay }));
out.hpPass = out.hp.filter((g) => [g.train, g.test, g.hold].every((x) => x.n >= 15 && x.win >= 0.6 && x.mean > 0)).map((g) => g.id);
out.hpNear = out.hp.filter((g) => g.all.n >= 100).sort((a, b) => b.all.win - a.all.win).slice(0, 15).map((g) => ({ id: g.id, n: g.all.n, win: g.all.win, mean: g.all.mean, tr: [g.train.win, g.train.mean], te: [g.test.win, g.test.mean], ho: [g.hold.win, g.hold.mean], perDay: g.perDay }));
out.hpBestMean = out.hp.filter((g) => g.all.n >= 100).sort((a, b) => b.all.mean - a.all.mean).slice(0, 10).map((g) => ({ id: g.id, n: g.all.n, win: g.all.win, mean: g.all.mean, tr: [g.train.win, g.train.mean], te: [g.test.win, g.test.mean], ho: [g.hold.win, g.hold.mean], perDay: g.perDay }));
writeFileSync(new URL('backtest-1h.json', import.meta.url), JSON.stringify(out) + '\n');
console.log(JSON.stringify({ extra, conf: grades.filter((g) => /conf|_ote|_ew|_ob/.test(g.id) && g.all.n >= 20).map((g) => [g.id, g.all.n, g.all.win, g.all.mean, g.train.mean, g.test.mean, g.hold.n, g.hold.mean]), hpTiers: out.hpTiers, hpPass: out.hpPass, hpNear: out.hpNear, hpBestMean: out.hpBestMean, triple, hold: { from: out.holdFrom, all: out.holdAll, top: out.holdTop, good: out.holdGood, w60: out.holdW60 }, pAdj: grades.filter((g) => g.pAdj != null && g.pAdj < 0.5).map((g) => [g.id, g.p, g.pAdj]), w60, dossier: out.dossier, split: out.split, tradingDays: out.tradingDays, markets: out.markets, n: out.n, all: out.all, chosen, aIds, top: out.top, good: out.good,
  grades: grades.map((g) => [g.id, g.all.n, g.all.mean, g.train.n, g.train.mean, g.test.n, g.test.mean, g.all.lo, g.perDay]) }, null, 1));
