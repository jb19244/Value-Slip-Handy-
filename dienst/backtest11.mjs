// Woechentliche Strategiesuche (Sonntag): jede Woche ein neuer Stapel Regel-Kandidaten aus festen Bausteinen, streng geprueft.
// Bausteine: Aufwaertstrend-Filter, Schwaeche-Ausloeser (IBS, RSI-2, Verlusttage, Tiefs, Ruecksetzer, Gap, weite und enge Spannen, Bollinger, Wochentag),
// Ausstiege (5-Tage-Schnitt, IBS, Vortageshoch, RSI-2, erster Plustag), 5 oder 10 Tage. Einstieg zum Schluss, Notstop 3 ATR, eine Position je Markt.
// Gruppen: US-Indizes (Knock-out) und US-Sektoren (ETF). Daten seit 2000, Kosten wie in den anderen Rueckrechnungen.
// Bestanden nur, wenn ALLES gilt:
//  1. die normale Hürde: >= 100 Trades, alle drei Zeitraeume im Plus, nach Handelstagen gebuendelt sicher ueber null, besser als investiert zu sein
//  2. strengere Sicherheit wegen der vielen Kandidaten: t-Wert nach Tagen gebuendelt >= 3 (statt 2)
//  3. Breite: in mind. 75 % der Maerkte der Gruppe im Plus
//  4. doppelte Kosten: weiter im Plus;  5. mind. 60 % der Jahre im Plus;  6. mind. 5 Trades pro Jahr
//  7. robust: die Nachbarn (Schwelle eine Stufe enger/weiter, 5 statt 10 Tage, anderer Ausstieg) sind ebenfalls im Plus, die Haelfte davon sicher
//  8. neu: hoechstens die Haelfte der Signale faellt auf Tage, an denen schon IBS, RSI-2, drei Verlusttage oder Turnaround Tuesday kaufen
// Was besteht, geht im Dienst als "Neu entdeckt" in Bewaehrung (hoechstens 5 Regeln), mit Live-Pruefung gegen diese Rueckrechnung.
import { readFileSync, writeFileSync } from 'node:fs';
const html = readFileSync(new URL('../trade/index.html', import.meta.url), 'utf8');
const src = html.split('// BEGIN LOGIC')[1].split('// END LOGIC')[0];
const L = new Function(src + '; return { parseYahoo, rStats, rsi2DailySignals, ibsSignals, ibsExit, simDayTrade, dayOf, atrSeries, rsiSeries, smaAt, ibs, ruleSeries, ruleHit, ruleExit, ruleText, ruleId, smaSeries };')();
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
function byDay(trades) { const g = {}; trades.forEach((t) => { const d = L.dayOf(t.t); (g[d] = g[d] || []).push(t.pct); }); const m = Object.values(g).map((a) => a.reduce((x, y) => x + y, 0) / a.length); const s = L.rStats(m); return s ? { days: s.n, mean: +s.mean.toFixed(4), lo: s.lo != null ? +s.lo.toFixed(4) : null, win: +s.win.toFixed(3) } : { days: 0 }; }
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
const US_IDX = ['^GSPC', '^NDX', '^DJI', '^RUT'];
const US_SYMS = ['^GSPC', '^NDX', '^DJI', '^RUT', 'XLK', 'XLF', 'XLE', 'XLV', 'XLY', 'XLP', 'XLI', 'XLB', 'XLU', 'IWM', 'DIA', 'SMH', 'XBI', 'KRE', 'ITB'];
const GAP_ETF = ['SPY', 'QQQ', 'IWM', 'DIA', 'XLK', 'XLF', 'XLE', 'XLV', 'XLY', 'XLI', 'SMH'];
const OTHER = ['^GDAXI', '^STOXX50E', 'TLT', 'IEF', 'GLD', '^VIX', 'BTC-USD', 'ETH-USD'];
const COST = 0.07, COST_ETF = 0.08, BATCH = +(process.env.BATCH || 400);
const GROUPS = { us4: { name: 'US-Indizes', syms: ['^GSPC', '^NDX', '^DJI', '^RUT'], cost: COST }, sek: { name: 'US-Sektoren', syms: ['XLK', 'XLF', 'XLE', 'XLV', 'XLY', 'XLP', 'XLI', 'XLB', 'XLU'], cost: COST_ETF } };
const D = {}, SER = {};
for (const g of Object.values(GROUPS)) for (const s of g.syms) { if (!D[s]) { D[s] = await chart(s); await wait(250); } }
for (const s of Object.keys(D)) { if (!D[s] || D[s].length < 2000) { console.log('fehlt', s); delete D[s]; continue; } SER[s] = L.ruleSeries(D[s]); }
const readJ = (f, d) => { try { return JSON.parse(readFileSync(new URL(f, import.meta.url), 'utf8')); } catch (e) { return d; } };
const reg = readJ('./suche-registry.json', { tested: {} }), prev = readJ('./backtest-suche.json', {});
const wk = (() => { const d = new Date(); const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); const day = t.getUTCDay() || 7; t.setUTCDate(t.getUTCDate() + 4 - day); const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1)); return t.getUTCFullYear() + '-W' + String(Math.ceil(((t - y0) / 864e5 + 1) / 7)).padStart(2, '0'); })();
// ---- Bausteine
const TRIG = [['ibs', 0.1], ['ibs', 0.15], ['ibs', 0.2], ['ibs', 0.25], ['ibs', 0.3], ['rsi2', 5], ['rsi2', 10], ['rsi2', 15], ['rsi2', 20], ['down', 2], ['down', 3], ['down', 4], ['low', 5], ['low', 10], ['low', 20],
  ['ret', 3, -2], ['ret', 5, -3], ['ret', 5, -5], ['ret', 10, -5], ['gap', -0.5], ['gap', -1], ['wide', 1.25], ['wide', 1.5], ['wide', 2], ['nr', 4], ['nr', 7], ['bb', 20, 2], ['bb', 20, 1.5], ['wd', 1], ['wd', 2], ['wd', 3], ['wd', 4], ['wd', 5], ['insideDn']];
const EXITS = [['sma', 5], ['ibs', 0.8], ['ph'], ['rsi2', 70], ['up']], MAXS = [5, 10];
const cands = [];
for (const filt of [[['trend', 200]], []]) for (let a = 0; a < TRIG.length; a++) for (let b = a; b < TRIG.length; b++) {
  if (b > a && TRIG[a][0] === TRIG[b][0]) continue;
  const c = filt.concat(b === a ? [TRIG[a]] : [TRIG[a], TRIG[b]]);
  for (const x of EXITS) for (const max of MAXS) cands.push({ c, x, max });
}
// feste Reihenfolge, gut gemischt (gleicher Startwert jede Woche), ungetestete zuerst
let seed = 20261115; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
for (let i = cands.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [cands[i], cands[j]] = [cands[j], cands[i]]; }
let todo = cands.filter((r) => !reg.tested[L.ruleId(r)]).slice(0, BATCH);
// Raum einmal durch: neue Runde mit frischen Daten
if (!todo.length) { reg.cycle = (reg.cycle || 1) + 1; reg.tested = {}; todo = cands.slice(0, BATCH); console.log('neue Runde', reg.cycle); }
console.log('Raum', cands.length, 'schon geprueft', Object.keys(reg.tested).length, 'diese Woche', todo.length);
// ---- bestehende Strategien (fuer die Neuheit)
const famHit = (d1, i, S) => { const x = d1[i], sm = L.smaSeries(d1, S, 200); if (!(sm[i] != null && x.c > sm[i])) return false; const ib = L.ibs(x);
  return ib < 0.2 || (S.rsi2[i] != null && S.rsi2[i] < 10) || (x.c < d1[i - 1].c && d1[i - 1].c < d1[i - 2].c && d1[i - 2].c < d1[i - 3].c) || (new Date(x.t + 3 * 3600e3).getUTCDay() === 1 && ib < 0.3 && x.c < d1[i - 1].c); };
const drift = (d1) => { let s = 0; for (let k = 1; k < d1.length; k++) s += d1[k].c / d1[k - 1].c - 1; return s / (d1.length - 1) * 100; };
const DR = {}; Object.keys(D).forEach((s) => { DR[s] = drift(D[s]); });
function evalRule(rule, gk) {
  const G = GROUPS[gk], trades = [], per = {}, sig = new Set(); let ov = 0, nsig = 0;
  for (const s of G.syms) { const d1 = D[s], S = SER[s]; if (!d1) continue; per[s] = { n: 0, sum: 0 }; let busy = -1;
    for (let i = 201; i < d1.length - 1; i++) {
      if (i <= busy || !L.ruleHit(d1, i, rule, S)) continue;
      const r = L.simDayTrade({ i, dir: 1, atr: S.atr[i] }, d1, { entry: 'close', stopAtr: 3, costPct: G.cost, maxDays: rule.max, exitFn: (k) => L.ruleExit(d1, k, rule, S) });
      if (r.pct == null) continue; busy = r.exitI; nsig++; sig.add(s + '|' + i); if (famHit(d1, i, S)) ov++;
      trades.push({ t: d1[i].t, s, cost: G.cost, pct: r.pct, days: r.days, ex: r.pct - DR[s] * r.days }); per[s].n++; per[s].sum += r.pct; } }
  const o = evalSet(L.ruleText(rule), trades);
  const se = o.day && o.day.mean != null && o.day.lo != null && o.day.mean > o.day.lo ? (o.day.mean - o.day.lo) / 1.96 : null;
  o.tval = se ? +(o.day.mean / se).toFixed(2) : 0; const ps = Object.values(per).filter((p) => p.n >= 10);
  o.breadth = ps.length ? +(ps.filter((p) => p.sum > 0).length / ps.length).toFixed(2) : 0; o.overlap = nsig ? +(ov / nsig).toFixed(2) : 0;
  o.core = !!(o.passed && o.tval >= 3 && o.breadth >= 0.75 && o.cost2 && o.cost2.mean > 0 && o.yearsUp >= 0.6 * o.yearsN && o.perYear >= 5);
  delete o.years; Object.defineProperty(o, 'sig', { value: sig, enumerable: false }); return o;
}
function neighbors(rule) {
  const out = [], key = (c) => c[0];
  rule.c.forEach((c, ci) => { if (c[0] === 'trend' || c[0] === 'wd' || c[0] === 'insideDn') return;
    const same = TRIG.filter((t) => key(t) === key(c) && (c[0] !== 'ret' || t[1] === c[1] || true)), pos = same.findIndex((t) => JSON.stringify(t) === JSON.stringify(c));
    [pos - 1, pos + 1].forEach((p) => { if (p >= 0 && p < same.length && !rule.c.some((z) => JSON.stringify(z) === JSON.stringify(same[p]))) { const c2 = rule.c.slice(); c2[ci] = same[p]; out.push({ c: c2, x: rule.x, max: rule.max }); } }); });
  out.push({ c: rule.c, x: rule.x, max: rule.max === 5 ? 10 : 5 });
  out.push({ c: rule.c, x: rule.x[0] === 'sma' ? ['ibs', 0.8] : ['sma', 5], max: rule.max });
  return out;
}
const shortName = (rule) => rule.c.filter((c) => c[0] !== 'trend').map((c) => ({ ibs: 'IBS ' + String(c[1]).replace('.', ','), rsi2: 'RSI-2 ' + c[1], down: c[1] + ' Verlusttage', low: c[1] + '-Tage-Tief', ret: String(c[2]).replace('.', ',') + ' % in ' + c[1] + ' T.', gap: 'Gap ' + String(c[1]).replace('.', ',') + ' %', wide: 'weite Spanne', nr: 'NR' + c[1], bb: 'Bollinger ' + String(c[2]).replace('.', ','), wd: ['', 'Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag'][c[1]], insideDn: 'Innenstab' })[c[0]] || c[0]).join(' + ');
const res = [], t0 = Date.now();
for (const rule of todo) { const id = L.ruleId(rule); reg.tested[id] = wk;
  for (const gk of Object.keys(GROUPS)) { const o = evalRule(rule, gk); res.push({ id, gk, rule, o }); } }
console.log('geprueft in', Math.round((Date.now() - t0) / 1000), 's');
const found = [];
for (const r of res.filter((x) => x.o.core)) {
  if (r.o.overlap > 0.5) { r.status = 'Variante'; continue; }
  const nb = neighbors(r.rule).map((n) => evalRule(n, r.gk)), robust = nb.length >= 2 && nb.every((n) => n.all.n >= 50 && n.all.mean > 0) && nb.filter((n) => n.all.lo > 0).length >= Math.ceil(nb.length / 2);
  r.nb = nb.map((n) => ({ mean: n.all.mean, lo: n.all.lo, n: n.all.n }));
  r.status = robust ? 'bestanden' : 'nicht robust'; if (robust) found.push(r);
}
res.forEach((r) => { if (!r.status) r.status = 'durchgefallen'; });
// ---- Live-Liste: bisherige Regeln jede Woche neu pruefen, neue dazu, hoechstens 5 (nach t-Wert)
const pool = [];
for (const p of (prev.live || []).concat((prev.reserveRules || []))) { const o = evalRule(p.rule, p.gk); if (o.core && o.overlap <= 0.5) pool.push({ e: Object.assign({}, p, { stats: { n: o.all.n, win: o.all.win, mean: o.all.mean, lo: o.all.lo }, tval: o.tval, perYear: o.perYear, checked: wk }), sig: o.sig }); else console.log('raus', p.id, p.gk); }
for (const r of found) if (!pool.some((p) => p.e.id === r.id && p.e.gk === r.gk)) pool.push({ e: { id: r.id, gk: r.gk, name: shortName(r.rule) + ' · ' + GROUPS[r.gk].name, text: L.ruleText(r.rule), rule: r.rule, syms: GROUPS[r.gk].syms, stats: { n: r.o.all.n, win: r.o.all.win, mean: r.o.all.mean, lo: r.o.all.lo }, tval: r.o.tval, perYear: r.o.perYear, since: wk, checked: wk }, sig: r.o.sig });
pool.sort((a, b) => b.e.tval - a.e.tval);
// nur deutlich verschiedene Regeln: hoechstens die Haelfte gemeinsamer Signale mit einer schon gewaehlten
const ovl = (a, b) => { let n = 0; a.forEach((k) => { if (b.has(k)) n++; }); return n / Math.max(1, Math.min(a.size, b.size)); };
const live = [], reserveRules = [];
for (const p of pool) { if (live.some((q) => q.e.gk === p.e.gk && ovl(q.sig, p.sig) > 0.5)) continue; (live.length < 5 ? live : reserveRules).push(p); }
const top = res.slice().sort((a, b) => (b.o.core - a.o.core) || (b.o.tval - a.o.tval)).slice(0, 15).map((r) => ({ name: shortName(r.rule) || 'nur Trend', text: L.ruleText(r.rule), grp: GROUPS[r.gk].name, n: r.o.all.n, win: r.o.all.win, mean: r.o.all.mean, tval: r.o.tval, breadth: r.o.breadth, overlap: r.o.overlap, perYear: r.o.perYear, status: r.status,
  why: r.status === 'durchgefallen' ? [!r.o.passed && 'Grundhürde', r.o.tval < 3 && 't-Wert ' + String(r.o.tval).replace('.', ','), r.o.breadth < 0.75 && 'zu wenig Märkte', r.o.cost2 && r.o.cost2.mean <= 0 && 'doppelte Kosten', r.o.perYear < 5 && 'zu selten'].filter(Boolean).join(', ') : r.status === 'Variante' ? 'gleiche Tage wie bestehende Strategien' : r.status === 'nicht robust' ? 'Nachbar-Einstellungen halten nicht' : '' }));
const out = { at: new Date().toISOString(), week: wk, space: cands.length, testedTotal: Object.keys(reg.tested).length, batch: todo.length, groups: Object.fromEntries(Object.entries(GROUPS).map(([k, g]) => [k, g.name])),
  found: found.map((r) => ({ id: r.id, gk: r.gk, name: shortName(r.rule) + ' · ' + GROUPS[r.gk].name, text: L.ruleText(r.rule), n: r.o.all.n, win: r.o.all.win, mean: r.o.all.mean, tval: r.o.tval })),
  live: live.map((p) => p.e), reserveRules: reserveRules.slice(0, 10).map((p) => p.e), top, history: (prev.history || []).filter((h) => h.week !== wk).concat([{ week: wk, tested: todo.length, passed: found.length, core: res.filter((r) => r.o.core).length }]).slice(-52) };
writeFileSync(new URL('./backtest-suche.json', import.meta.url), JSON.stringify(out));
writeFileSync(new URL('./suche-registry.json', import.meta.url), JSON.stringify(reg));
console.log('Woche', wk, '| geprueft', todo.length, '| Grundhuerde+streng', res.filter((r) => r.o.core).length, '| bestanden', found.length, '| live', out.live.length);
top.slice(0, 10).forEach((x) => console.log((x.status === 'bestanden' ? 'NEU ' : '    ') + x.status.padEnd(14), x.grp.padEnd(12), (x.name || '').padEnd(34), 'n', x.n, 'win', x.win, 'mean', x.mean, 't', x.tval, 'breite', x.breadth, 'ueberl', x.overlap, x.why));
