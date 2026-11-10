// Daytrading-Rueckrechnung auf 5- und 15-Min-Kerzen seit 2018 (Alpaca, kostenloser Zugang; Schluessel nur als GitHub-Secret).
// US-ETFs als Stellvertreter: SPY (S&P 500), QQQ (Nasdaq 100), DIA (Dow), IWM (Russell 2000), GLD (Gold), SLV (Silber), TLT, EWG (Deutschland).
// Gleiche Setups und Stufen wie auf 1 Std, gleiche Pruefung: 1. Haelfte, 2. Haelfte, Haertetest (letzte 25 %), mit Kosten.
// Creme: mit Teilgewinn (Haelfte bei +1R) mind. 60 % Gewinner und in allen drei Zeitraeumen im Plus; B+: mind. 50 %.
// Extra: dieselbe Auswertung nur fuer ruhige Maerkte (VIX unter 20), um die Luecke ausserhalb unruhiger Phasen zu schliessen.
import { readFileSync, writeFileSync } from 'node:fs';
const html = readFileSync(new URL('../trade/index.html', import.meta.url), 'utf8');
const src = html.split('// BEGIN LOGIC')[1].split('// END LOGIC')[0];
const L = new Function(src + '; return { marketContext, GRADES, SETUPS, setupName, gradeMatch, gradeName, parseYahoo, backtest, rStats, berlinFast, stockInstrument };')();
const OUT = new URL('backtest-intra.json', import.meta.url);
const KEY = process.env.ALPACA_KEY_ID, SEC = process.env.ALPACA_SECRET_KEY;
if (!KEY || !SEC) { writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), error: 'ALPACA_KEY_ID oder ALPACA_SECRET_KEY fehlt' }) + '\n'); console.log('Schluessel fehlen'); process.exit(0); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const FROM = process.env.INTRA_FROM || '2018-01-01';
const SYMS = (process.env.INTRA_SYMS || 'SPY,QQQ,DIA,IWM,GLD,SLV,TLT,EWG').split(',');
let feed = 'sip';
async function alpaca(sym, tf, start, end) {
  const out = []; let token = null, tries = 0;
  do {
    const u = `https://data.alpaca.markets/v2/stocks/${sym}/bars?timeframe=${tf}&start=${start}&end=${end}&limit=10000&adjustment=split&feed=${feed}` + (token ? '&page_token=' + encodeURIComponent(token) : '');
    let r;
    try { r = await fetch(u, { headers: { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SEC } }); } catch (e) { if (++tries > 5) break; await wait(3000); continue; }
    if (r.status === 429) { await wait(15000); continue; }
    if ((r.status === 403 || r.status === 422) && feed === 'sip') { console.log('SIP nicht freigegeben, nehme IEX:', r.status, (await r.text()).slice(0, 120)); feed = 'iex'; continue; }
    if (!r.ok) { console.log('Alpaca', sym, r.status, (await r.text()).slice(0, 200)); break; }
    const j = await r.json();
    (j.bars || []).forEach((b) => out.push({ t: Date.parse(b.t), o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
    token = j.next_page_token; await wait(320);
  } while (token);
  return out;
}
// Nur regulaere US-Handelszeit 09:30-16:00 New York
const nyF = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const ny = (t) => { const p = {}; nyF.formatToParts(new Date(t)).forEach((x) => { p[x.type] = x.value; }); return { day: p.year + '-' + p.month + '-' + p.day, min: (+p.hour) * 60 + (+p.minute) }; };
const rth = (bars) => bars.filter((b) => { const n = ny(b.t); return n.min >= 570 && n.min < 960; });
function agg(bars, key) {
  const out = []; let cur = null, ck = null;
  for (const b of bars) { const k = key(b); if (k !== ck) { if (cur) out.push(cur); cur = { t: b.t, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }; ck = k; } else { cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; cur.v += b.v; } }
  if (cur) out.push(cur); return out;
}
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; TradeCheck/1.0)' };
async function yahoo(sym) { for (const h of ['query1', 'query2']) { try { const r = await fetch(`https://${h}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&period1=1451606400&period2=${Math.floor(Date.now() / 1000)}`, { headers: UA }); if (r.ok) return L.parseYahoo(await r.json()); } catch (e) {} await wait(1500); } return []; }
const vix = await yahoo('^VIX'), dxy = await yahoo('DX-Y.NYB');
const end = new Date(Date.now() - 20 * 60e3).toISOString();
const all = { m5: [], m15: [] }, info = {};
const T0 = Date.now();
for (const sym of SYMS) {
  const raw = rth(await alpaca(sym, '5Min', FROM + 'T00:00:00Z', end));
  info[sym] = { m5: raw.length, from: raw.length ? new Date(raw[0].t).toISOString().slice(0, 10) : null, feed };
  if (raw.length < 5000) continue;
  const m15 = agg(raw, (b) => Math.floor((b.t) / 900e3));
  const h1 = agg(raw, (b) => { const n = ny(b.t); return n.day + ':' + Math.floor((n.min - 570) / 60); });
  const d1 = agg(raw, (b) => ny(b.t).day).map((x) => Object.assign(x, { t: Date.parse(ny(x.t).day + 'T14:30:00Z') }));
  const ins = Object.assign(L.stockInstrument(sym), { name: sym });
  for (const [tf, c, bar] of [['m5', raw, 300e3], ['m15', m15, 900e3]]) {
    for (const setup of Object.keys(L.SETUPS)) {
      const res = L.backtest({ instr: ins, m15: c, h1, d1, bar, setup, any: true, be: false, noCheck: setup !== 'sweep' && setup !== 'pullback', conf: ['sweep', 'pullback', 'nr7r1'].includes(setup) });
      res.forEach((t) => { Object.assign(t.sig, L.marketContext(t.sig.day, ins, t.sig.dir, vix, dxy)); t.type = setup; t.sym = sym; delete t.checks; all[tf].push(t); });
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
    grades.push({ id, tf, type, grade: g.id, calm, name: L.gradeName(gid) + (calm ? ' (VIX unter 20)' : ''), fixed: st(sel), part: P, perDay: +(sel.length / days).toFixed(2) });
  }
  const ok = (g, w) => g.part.both.n >= 60 && g.part.hold.n >= 15 && g.part.both.win >= w && g.part.train.mean > 0 && g.part.test.mean > 0 && g.part.hold.mean > 0 && g.part.both.lo > 0;
  // Bonferroni-light: bei so vielen Varianten zusaetzlich insgesamt sicher ueber null (lo > 0)
  const cr = grades.filter((g) => ok(g, 0.6)), bp = grades.filter((g) => !cr.includes(g) && ok(g, 0.5));
  out.tf[tf] = { n: A.length, days, split: new Date(split).toISOString().slice(0, 10), holdFrom: new Date(cut).toISOString().slice(0, 10),
    byType: Object.fromEntries(Object.keys(L.SETUPS).map((k) => [k, st(A.filter((t) => t.type === k), 'rPart')])),
    grades: grades.filter((g) => g.part.both.n >= 60).sort((a, b) => b.part.both.mean - a.part.both.mean).slice(0, 80) };
  cr.forEach((g) => (g.calm ? out.calm.creme : out.creme).push(g.id)); bp.forEach((g) => (g.calm ? out.calm.bplus : out.bplus).push(g.id));
  out.tf[tf].keep = Object.fromEntries(cr.concat(bp).map((g) => [g.id, g]));
}
writeFileSync(OUT, JSON.stringify(out) + '\n');
console.log(JSON.stringify({ info, creme: out.creme, bplus: out.bplus, calm: out.calm }, null, 1));
for (const tf of Object.keys(out.tf)) { console.log(tf, out.tf[tf].n, 'Trades', out.tf[tf].days, 'Tage'); console.log(JSON.stringify(out.tf[tf].byType)); out.tf[tf].grades.slice(0, 15).forEach((g) => console.log(g.id.padEnd(40), g.part.both.n, 'win', g.part.both.win, 'mean', g.part.both.mean, '|', g.part.train.mean, g.part.test.mean, g.part.hold.mean, 'lo', g.part.both.lo, g.perDay)); }
