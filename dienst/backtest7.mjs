// Daytrading-Rueckrechnung fuer Devisen, Gold, Silber, Oel und Index-CFDs (DAX, S&P 500, Nasdaq, Dow) auf 5 und 15 Min seit 2019.
// Daten: Dukascopy (frei, ohne Schluessel) in 1-Min-Kerzen; Signale aus 5/15 Min, Ausfuehrung auf 1 Min nachgespielt.
// Gleiche Setups, Stufen und Pruefung wie die US-ETF-Rechnung (backtest5). Ergebnis: dienst/backtest-fx.json
import { readFileSync, writeFileSync } from 'node:fs';
import { getHistoricalRates } from 'dukascopy-node';
const html = readFileSync(new URL('../trade/index.html', import.meta.url), 'utf8');
const src = html.split('// BEGIN LOGIC')[1].split('// END LOGIC')[0];
const L = new Function(src + '; return { marketContext, GRADES, SETUPS, setupName, gradeMatch, gradeName, parseYahoo, backtest, rStats, berlinFast, instrumentByKey, simulate, costOf };')();
const OUT = new URL('backtest-fx.json', import.meta.url);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const FROM = process.env.FX_FROM || '2019-01-01';
const MAP = { EURUSD: 'eurusd', GBPUSD: 'gbpusd', USDJPY: 'usdjpy', AUDUSD: 'audusd', USDCAD: 'usdcad', USDCHF: 'usdchf', EURJPY: 'eurjpy', GBPJPY: 'gbpjpy',
  XAUUSD: 'xauusd', XAGUSD: 'xagusd', WTI: 'lightcmdusd', DAX: 'deuidxeur', SPX: 'usa500idxusd', NDX: 'usatechidxusd', DJI: 'usa30idxusd' };
const SYMS = (process.env.FX_SYMS || Object.keys(MAP).join(',')).split(',');
const feed = 'dukascopy';
async function m1Of(id) {
  const out = []; const from = new Date(FROM + 'T00:00:00Z'), to = new Date(Date.now() - 86400e3);
  // in Jahresstuecken laden (weniger Speicher, Wiederholung bei Fehlern)
  for (let y = from.getUTCFullYear(); y <= to.getUTCFullYear(); y++) {
    const a = new Date(Math.max(from, Date.UTC(y, 0, 1))), b = new Date(Math.min(to, Date.UTC(y + 1, 0, 1)));
    for (let tries = 0; tries < 3; tries++) {
      try { const d = await getHistoricalRates({ instrument: id, dates: { from: a, to: b }, timeframe: 'm1', format: 'array', priceType: 'bid', batchSize: 25, pauseBetweenBatchesMs: 50, ignoreFlats: true });
        d.forEach((x) => out.push({ t: x[0], o: x[1], h: x[2], l: x[3], c: x[4], v: x[5] || 0 })); break; } catch (e) { console.log('Dukascopy', id, y, String(e).slice(0, 120)); await wait(5000); }
    }
  }
  return out;
}
function agg(bars, key) {
  const out = []; let cur = null, ck = null;
  for (const b of bars) { const k = key(b); if (k !== ck) { if (cur) out.push(cur); cur = { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }; ck = k; } else { cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.v += b.v; } }
  if (cur) out.push(cur); return out;
}
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; TradeCheck/1.0)' };
async function yahoo(sym) { for (const h of ['query1', 'query2']) { try { const r = await fetch(`https://${h}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&period1=1451606400&period2=${Math.floor(Date.now() / 1000)}`, { headers: UA }); if (r.ok) return L.parseYahoo(await r.json()); } catch (e) {} await wait(1500); } return []; }
const vix = await yahoo('^VIX'), dxy = await yahoo('DX-Y.NYB');
const all = { m5: [], m15: [] }, info = {};
const T0 = Date.now();
for (const sym of SYMS) {
  const ins = L.instrumentByKey(sym); if (!ins || !MAP[sym]) continue;
  const m1 = await m1Of(MAP[sym]); info[sym] = { m1: m1.length, from: m1.length ? new Date(m1[0].t).toISOString().slice(0, 10) : null };
  console.log(sym, m1.length, '1-Min-Kerzen', Math.round((Date.now() - T0) / 1000), 's');
  if (m1.length < 100000) continue;
  const raw = agg(m1, (b) => Math.floor(b.t / 300e3)), m15 = agg(m1, (b) => Math.floor(b.t / 900e3)), h1 = agg(m1, (b) => Math.floor(b.t / 3600e3));
  const d1 = agg(m1, (b) => L.berlinFast(b.t).key).map((x) => Object.assign(x, { t: Date.parse(L.berlinFast(x.t).key + 'T12:00:00Z') - 12 * 3600e3 + 6 * 3600e3 }));
  const m1t = m1.map((x) => x.t);
  const before = (t) => { let lo = 0, hi = m1t.length - 1, r = -1; while (lo <= hi) { const md = (lo + hi) >> 1; if (m1t[md] + 60e3 <= t) { r = md; lo = md + 1; } else hi = md - 1; } return r; };
  const replay = (t) => {
    const s = t.sig, j = before(s.t); if (j < 0) return false;
    const s1 = Object.assign({}, s, { i: j }), cost = L.costOf(ins, s.entry), a = L.simulate(s1, m1, cost); if (!a.filled || a.r == null) return false;
    const b = L.simulate(Object.assign({}, s1, { part: true }), m1, cost), cst = cost * ((s.mode || 'limit') === 'limit' ? 1 : 1.5) / s.risk;
    t.r = a.r; t.rPart = b.r != null ? b.r : a.r; t.rG = t.r + cst; t.rPG = t.rPart + cst + (b.part ? cost * 0.25 / s.risk : 0); t.riskPct = s.risk / s.entry * 100; return true;
  };
  for (const [tf, c, bar] of [['m5', raw, 300e3], ['m15', m15, 900e3]]) {
    for (const setup of Object.keys(L.SETUPS)) {
      const res = L.backtest({ instr: ins, m15: c, h1, d1, bar, setup, any: true, be: false, noCheck: setup !== 'sweep' && setup !== 'pullback', conf: ['sweep', 'pullback', 'nr7r1'].includes(setup) });
      res.forEach((t) => { Object.assign(t.sig, L.marketContext(t.sig.day, ins, t.sig.dir, vix, dxy)); t.type = setup; t.sym = sym; t.cls = ins.type; delete t.checks; if (replay(t)) all[tf].push(t); });
    }
    console.log(sym, tf, c.length, 'Kerzen,', all[tf].length, 'Trades bisher,', Math.round((Date.now() - T0) / 1000), 's');
  }
}
const pick = (a) => a ? { n: a.n, mean: +a.mean.toFixed(3), win: +a.win.toFixed(3), lo: a.lo != null ? +a.lo.toFixed(3) : null } : { n: 0 };
const st = (arr, k) => pick(arr.length ? L.rStats(arr.map((t) => (k && t[k] != null) ? t[k] : t.r)) : null);
const out = { at: new Date().toISOString(), from: FROM, symbols: SYMS, info, feed, tf: {}, creme: [], bplus: [], calm: { creme: [], bplus: [] } };
for (const tf of ['m5', 'm15']) {
  const A = all[tf].filter((t) => t.r != null).sort((a, b) => a.at - b.at); if (!A.length) continue;
  const cut = A[Math.floor(A.length * 0.75)].at, split = A[Math.floor(A.length * 0.375)].at, days = new Set(A.map((t) => L.berlinFast(t.at).key)).size;
  const grades = [];
  for (const type of Object.keys(L.SETUPS)) for (const g of L.GRADES) for (const calm of [false, true]) {
    const id = tf + ':' + type + ':' + g.id + (calm ? ':calm' : ''), gid = type + ':' + g.id;
    const sel = A.filter((t) => L.gradeMatch(gid, t.sig, t.ampel) && (!calm || t.sig.vixLo === true)); if (sel.length < 20) continue;
    const tr = sel.filter((t) => t.at < split), te = sel.filter((t) => t.at >= split && t.at < cut), ho = sel.filter((t) => t.at >= cut);
    const P = { both: st(sel, 'rPart'), train: st(tr, 'rPart'), test: st(te, 'rPart'), hold: st(ho, 'rPart') };
    const G = { both: st(sel, 'rPG'), train: st(tr, 'rPG'), test: st(te, 'rPG'), hold: st(ho, 'rPG') };
    grades.push({ id, tf, type, grade: g.id, calm, name: L.gradeName(gid) + (calm ? ' (VIX unter 20)' : ''), fixed: st(sel), part: P, gross: G, perDay: +(sel.length / days).toFixed(2) });
  }
  const ok = (g, w) => g.part.both.n >= 60 && g.part.hold.n >= 15 && g.part.both.win >= w && g.part.train.mean > 0 && g.part.test.mean > 0 && g.part.hold.mean > 0 && g.part.both.lo > 0;
  // Bonferroni-light: bei so vielen Varianten zusaetzlich insgesamt sicher ueber null (lo > 0)
  const cr = grades.filter((g) => ok(g, 0.6)), bp = grades.filter((g) => !cr.includes(g) && ok(g, 0.5));
  out.tf[tf] = { n: A.length, days, split: new Date(split).toISOString().slice(0, 10), holdFrom: new Date(cut).toISOString().slice(0, 10),
    byType: Object.fromEntries(Object.keys(L.SETUPS).map((k) => [k, st(A.filter((t) => t.type === k), 'rPart')])),
    byTypeGross: Object.fromEntries(Object.keys(L.SETUPS).map((k) => { const a = A.filter((t) => t.type === k); const rp = a.map((t) => t.riskPct).sort((x, y) => x - y); return [k, Object.assign(st(a, 'rPG'), { riskPctMed: rp.length ? +rp[Math.floor(rp.length / 2)].toFixed(3) : null })]; })),
    grades: grades.filter((g) => g.part.both.n >= 60).sort((a, b) => b.part.both.mean - a.part.both.mean).slice(0, 80) };
  cr.forEach((g) => (g.calm ? out.calm.creme : out.creme).push(g.id)); bp.forEach((g) => (g.calm ? out.calm.bplus : out.bplus).push(g.id));
  // Ohne Kosten bestanden (zeigt, ob guenstigere Ausfuehrung, z. B. Futures, etwas aendern wuerde)
  out.tf[tf].grossPass = grades.filter((g) => g.gross.both.n >= 60 && g.gross.hold.n >= 15 && g.gross.both.win >= 0.5 && g.gross.train.mean > 0 && g.gross.test.mean > 0 && g.gross.hold.mean > 0 && g.gross.both.lo > 0).sort((a, b) => b.gross.both.mean - a.gross.both.mean).slice(0, 30).map((g) => ({ id: g.id, gross: g.gross, part: g.part.both, perDay: g.perDay }));
  out.tf[tf].keep = Object.fromEntries(cr.concat(bp).map((g) => [g.id, g]));
}

// ---- Gewinner gegen Verlierer: Welche Umstaende unterscheiden sie? Suche nur auf der 1. Haelfte (Training),
// Pruefung auf 2. Haelfte und Haertetest. Bestanden nur, wenn beide spaeteren Zeitraeume im Plus sind und zusammen 60 %+ Gewinner haben.
const FEAT = {
  zeit: (t) => { const m = L.berlinFast(t.sig.t).min; return m < 600 ? 'vor 10' : m < 780 ? '10-13' : m < 960 ? '13-16' : m < 1140 ? '16-19' : 'ab 19'; },
  tag: (t) => ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'][L.berlinFast(t.sig.t).wd],
  vix: (t) => t.sig.vix == null ? '?' : t.sig.vix < 15 ? 'unter 15' : t.sig.vix < 20 ? '15-20' : t.sig.vix < 25 ? '20-25' : 'ab 25',
  usd: (t) => t.sig.usdOk == null ? 'egal' : t.sig.usdOk ? 'Dollar passt' : 'Dollar dagegen',
  crv: (t) => t.sig.rr < 2.5 ? 'CRV unter 2,5' : t.sig.rr < 4 ? 'CRV 2,5-4' : 'CRV ab 4',
  stop: (t) => t.riskPct < 0.15 ? 'Stop eng' : t.riskPct < 0.35 ? 'Stop mittel' : 'Stop weit',
  smc: (t) => { const s = t.sig.conf && t.sig.conf.score; return s == null ? '?' : s <= 2 ? 'SMC 0-2' : s <= 4 ? 'SMC 3-4' : 'SMC 5-6'; },
  trend: (t) => t.sig.withBias ? 'mit Tagestrend' : 'gegen Tagestrend',
  markt: (t) => ({ fx: 'Devisen', cmd: 'Rohstoffe', idx: 'Indizes' })[t.cls] || t.cls,
  ziel: (t) => t.sig.liqTarget ? 'Ziel an Liquidität' : 'Ziel fest',
  ampel: (t) => t.ampel || '?',
  richtung: (t) => t.sig.dir > 0 ? 'Long' : 'Short'
};
const rStat = (a) => { const n = a.length; if (!n) return { n: 0 }; const m = a.reduce((x, y) => x + y, 0) / n, sd = Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, n - 1)); return { n, mean: +m.toFixed(3), win: +(a.filter((x) => x > 0).length / n).toFixed(3), lo: +(m - 1.96 * sd / Math.sqrt(n)).toFixed(3), t: sd ? m / sd * Math.sqrt(n) : 0 }; };
out.mining = {};
for (const tf of Object.keys(all)) for (const type of ['topdown', 'sweep', 'pullback', 'orb', 'lbo', 'donch', 'nr7']) {
  const A = all[tf].filter((t) => t.type === type && t.r != null).sort((a, b) => a.at - b.at); if (A.length < 300) continue;
  A.forEach((t) => { t.f = {}; for (const k of Object.keys(FEAT)) t.f[k] = FEAT[k](t); t.rp = t.rPart != null ? t.rPart : t.r; });
  const s1 = A[Math.floor(A.length * 0.375)].at, s2 = A[Math.floor(A.length * 0.75)].at;
  const TR = A.filter((t) => t.at < s1), TE = A.filter((t) => t.at >= s1 && t.at < s2), HO = A.filter((t) => t.at >= s2);
  const keys = Object.keys(FEAT), vals = {}; keys.forEach((k) => { vals[k] = [...new Set(A.map((t) => t.f[k]))]; });
  const conds = []; keys.forEach((k) => vals[k].forEach((v) => conds.push([[k, v]])));
  for (let a = 0; a < keys.length; a++) for (let b = a + 1; b < keys.length; b++) vals[keys[a]].forEach((v1) => vals[keys[b]].forEach((v2) => conds.push([[keys[a], v1], [keys[b], v2]])));
  const match = (t, c) => c.every(([k, v]) => t.f[k] === v), minN = Math.max(30, Math.floor(TR.length * 0.03));
  const scored = conds.map((c) => ({ c, tr: rStat(TR.filter((t) => match(t, c)).map((t) => t.rp)) })).filter((x) => x.tr.n >= minN && x.tr.mean > 0 && x.tr.win >= 0.55).sort((a, b) => b.tr.t - a.tr.t).slice(0, 12);
  const top = scored.map((x) => { const te = rStat(TE.filter((t) => match(t, x.c)).map((t) => t.rp)), ho = rStat(HO.filter((t) => match(t, x.c)).map((t) => t.rp)), both = rStat(TE.concat(HO).filter((t) => match(t, x.c)).map((t) => t.rp));
    return { cond: x.c.map(([k, v]) => v).join(' + '), spec: x.c, train: x.tr, test: te, hold: ho, later: both, ok: te.n >= 15 && ho.n >= 10 && te.mean > 0 && ho.mean > 0 && both.win >= 0.6 && both.lo > 0 }; });
  // Beschreibend: Anteil je Merkmal bei Gewinnern und Verlierern (alle Zeitraeume)
  const W = A.filter((t) => t.rp > 0), Lz = A.filter((t) => t.rp <= 0), diff = [];
  keys.forEach((k) => vals[k].forEach((v) => { const pw = W.filter((t) => t.f[k] === v).length / Math.max(1, W.length), pl = Lz.filter((t) => t.f[k] === v).length / Math.max(1, Lz.length); if (pw + pl > 0.04) diff.push({ k, v, gewinner: +pw.toFixed(3), verlierer: +pl.toFixed(3), d: +(pw - pl).toFixed(3) }); }));
  out.mining[tf + ':' + type] = { n: A.length, base: rStat(A.map((t) => t.rp)), tested: conds.length, top, diff: diff.sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 12) };
}
out.minedOk = Object.entries(out.mining).flatMap(([k, m]) => m.top.filter((x) => x.ok).map((x) => ({ id: k, cond: x.cond, spec: x.spec, later: x.later })));
writeFileSync(OUT, JSON.stringify(out) + '\n');
console.log('Gefundene Filter, die spaeter bestehen:', JSON.stringify(out.minedOk));
console.log(JSON.stringify({ info, creme: out.creme, bplus: out.bplus, calm: out.calm }, null, 1));
for (const tf of Object.keys(out.tf)) { console.log(tf, out.tf[tf].n, 'Trades', out.tf[tf].days, 'Tage'); console.log(JSON.stringify(out.tf[tf].byType)); out.tf[tf].grades.slice(0, 15).forEach((g) => console.log(g.id.padEnd(40), g.part.both.n, 'win', g.part.both.win, 'mean', g.part.both.mean, '|', g.part.train.mean, g.part.test.mean, g.part.hold.mean, 'lo', g.part.both.lo, g.perDay)); }
