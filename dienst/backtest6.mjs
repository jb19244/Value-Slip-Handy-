// Kurzfrist-/Scalping-Rueckrechnung auf 5-Min-Kerzen seit 2018 (Alpaca), breites Universum: 23 ETFs (Indizes, Gold, Silber, Oel,
// Gas, Anleihen, Devisen-ETFs, Sektoren, Laender) und 40 liquide US-Aktien. Feste Regeln aus Studien und Praxis, keine Parameter-Suche:
//  orbplay  ORB "Stocks in Play" (Zarattini/Aziz/Barbon 2024): erste 5-Min-Kerze, Top 3 nach rel. Volumen (mind. 2-fach), Stop 0,1 ATR
//  noise    Noise Area (Zarattini/Aziz/Barbon 2024, "Beat the Market"): Pruefung alle 30 Min, Ausstieg hinter Grenze/VWAP
//  imom     Market Intraday Momentum (Gao/Han/Li/Zhou 2018): Rendite bis 10:00 bestimmt die letzte halbe Stunde
//  gapfill  Kleine Eroeffnungsluecken (0,15-0,6 %) schliessen: Gegenrichtung, Ziel Vortagesschluss, Stop = Lueckengroesse, bis 11:30
//  vwaprev  VWAP-Rueckkehr: Schluss 2 Standardabweichungen vom VWAP und RSI(2) extrem -> Ziel VWAP, Stop gleich weit, bis 15:45
//  orb30    30-Min-Eroeffnungsspanne, Ausbruch mit Tagestrend (50-Tage-Schnitt), Stop andere Seite, bis Tagesende
// Pruefung: 1. Haelfte, 2. Haelfte, Haertetest (letzte 25 %), mit Kosten. Creme: mind. 60 % Gewinner, alle drei Zeitraeume im Plus,
// insgesamt sicher ueber null. Ergebnis: dienst/backtest-scalp.json
import { writeFileSync } from 'node:fs';
const OUT = new URL('backtest-scalp.json', import.meta.url);
const KEY = process.env.ALPACA_KEY_ID, SEC = process.env.ALPACA_SECRET_KEY;
if (!KEY || !SEC) { writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), error: 'Schluessel fehlen' }) + '\n'); process.exit(0); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const FROM = process.env.SCALP_FROM || '2018-01-01';
const ETF = (process.env.SCALP_ETF || 'SPY,QQQ,DIA,IWM,GLD,SLV,USO,UNG,TLT,EWG,EWJ,FXI,EEM,XLE,XLF,XLK,XLV,SMH,XBI,FXE,FXB,FXY,UUP').split(',');
const STK = (process.env.SCALP_STK || 'AAPL,MSFT,NVDA,AMZN,META,GOOGL,TSLA,AMD,NFLX,AVGO,JPM,BAC,XOM,CVX,WMT,COST,LLY,UNH,V,MA,INTC,MU,QCOM,CRM,ORCL,ADBE,PYPL,BA,DIS,NKE,UBER,SHOP,PLTR,COIN,MRVL,PANW,CRWD,SNOW,ABNB,SMCI').split(',').filter(Boolean);
let feed = 'sip';
async function alpaca(sym, tf, start, end) {
  const out = []; let token = null, tries = 0;
  do {
    const u = `https://data.alpaca.markets/v2/stocks/${sym}/bars?timeframe=${tf}&start=${start}&end=${end}&limit=10000&adjustment=all&feed=${feed}` + (token ? '&page_token=' + encodeURIComponent(token) : '');
    let r; try { r = await fetch(u, { headers: { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SEC } }); } catch (e) { if (++tries > 5) break; await wait(3000); continue; }
    if (r.status === 429) { await wait(15000); continue; }
    if ((r.status === 403 || r.status === 422) && feed === 'sip') { feed = 'iex'; continue; }
    if (!r.ok) { console.log('Alpaca', sym, r.status); break; }
    const j = await r.json(); (j.bars || []).forEach((b) => out.push([Date.parse(b.t), b.o, b.h, b.l, b.c, b.v]));
    token = j.next_page_token; await wait(300);
  } while (token);
  return out;
}
const nyF = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const nyCache = new Map();
const ny = (t) => { const h = Math.floor(t / 300e3); let v = nyCache.get(h); if (!v) { const p = {}; nyF.formatToParts(new Date(t)).forEach((x) => { p[x.type] = x.value; }); v = { day: p.year + '-' + p.month + '-' + p.day, min: (+p.hour) * 60 + (+p.minute) }; nyCache.set(h, v); } return v; };
// Handelstage mit vollstaendigen 5-Min-Kerzen 09:30-16:00 (Index k = 0..77)
function daysOf(raw) {
  const m = new Map();
  for (const b of raw) { const n = ny(b[0]); if (n.min < 570 || n.min >= 960) continue; let d = m.get(n.day); if (!d) { d = { day: n.day, bars: new Array(78).fill(null) }; m.set(n.day, d); } d.bars[(n.min - 570) / 5] = { t: b[0], o: b[1], h: b[2], l: b[3], c: b[4], v: b[5] }; }
  const days = [...m.values()].sort((a, b) => a.day < b.day ? -1 : 1).filter((d) => d.bars.filter(Boolean).length >= 70);
  days.forEach((d) => { for (let k = 0; k < 78; k++) if (!d.bars[k]) { const p = d.bars[k - 1] || d.bars.find(Boolean); d.bars[k] = { t: p.t + 300e3, o: p.c, h: p.c, l: p.c, c: p.c, v: 0 }; } d.o = d.bars[0].o; d.c = d.bars[77].c; d.h = Math.max(...d.bars.map((x) => x.h)); d.l = Math.min(...d.bars.map((x) => x.l)); d.v = d.bars.reduce((a, x) => a + x.v, 0); });
  for (let i = 0; i < days.length; i++) {
    const d = days[i], p = days[i - 1]; d.pc = p ? p.c : null;
    if (i >= 14) { let tr = 0; for (let q = i - 14; q < i; q++) { const a = days[q], b = days[q - 1]; tr += Math.max(a.h - a.l, b ? Math.abs(a.h - b.c) : 0, b ? Math.abs(a.l - b.c) : 0); } d.atr = tr / 14; d.fv = days.slice(i - 14, i).reduce((a, x) => a + x.bars[0].v, 0) / 14; }
    if (i >= 50) { let s = 0; for (let q = i - 50; q < i; q++) s += days[q].c; d.sma50 = s / 50; }
  }
  return days;
}
// Trade durchspielen: Einstieg zum Eroeffnungskurs von Kerze k0 (oder Stop-Order), Stop/Ziel, Zwangsausstieg zum Schluss von kEnd
function run(d, k0, dir, entry, stop, target, kEnd, cost, opt) {
  opt = opt || {}; const B = d.bars, risk = Math.abs(entry - stop); if (!(risk > 0)) return null;
  let k = k0, e = entry;
  if (opt.stopEntry) { for (; k <= kEnd; k++) { const x = B[k]; if (dir > 0 ? x.h >= entry : x.l <= entry) { e = dir > 0 ? Math.max(entry, x.o) : Math.min(entry, x.o); break; } } if (k > kEnd) return null; }
  for (let q = k; q <= kEnd; q++) {
    const x = B[q], adv = dir > 0 ? x.l <= stop : x.h >= stop, fav = target != null && (dir > 0 ? x.h >= target : x.l <= target);
    // Fuellkerze bei Stop-Order: laeuft sie in Einstiegsrichtung, lag das Gegenextrem davor
    const advReal = adv && !(opt.stopEntry && q === k && (x.c - x.o) * dir > 0 && (dir > 0 ? x.c > stop : x.c < stop));
    if (advReal) { const px = dir > 0 ? Math.min(stop, x.o) : Math.max(stop, x.o); return done(px); }
    if (fav && !(q === k0 && opt.noTargetFirstBar)) return done(dir > 0 ? Math.max(target, x.o) : Math.min(target, x.o));
    if (opt.trail) { const lv = opt.trail(q); if (lv != null && (x.c - lv) * dir < 0) return done(x.c); }
  }
  return done(B[kEnd].c);
  function done(px) { const pct = (px / e - 1) * 100 * dir - cost; return { pct, r: pct / (risk / e * 100), riskPct: risk / e * 100 }; }
}
const COST = { etf: 0.04, stk: 0.08 }; // Prozent je Hin und Rueck (Knock-out-Spread plus Gebuehr bzw. Aktie mit 1 EUR)
const T = { orbplay: [], noise: [], imom: [], gapfill: [], vwaprev: [], orb30: [] };
const add = (name, d, sym, cls, res) => { if (res && isFinite(res.r)) T[name].push({ t: Date.parse(d.day + 'T15:00:00Z'), day: d.day, sym, cls, r: res.r, pct: res.pct }); };
const end = new Date(Date.now() - 20 * 60e3).toISOString();
const orbCand = new Map(); const info = {};
const T0 = Date.now();
for (const [list, cls] of [[ETF, 'etf'], [STK, 'stk']]) for (const sym of list) {
  const raw = await alpaca(sym, '5Min', FROM + 'T00:00:00Z', end); const days = daysOf(raw); info[sym] = days.length;
  if (days.length < (+process.env.SCALP_MINDAYS || 100)) continue; const cost = COST[cls];
  for (let i = 15; i < days.length; i++) {
    const d = days[i], B = d.bars, pc = d.pc; if (!pc || !d.atr) continue;
    // ORB Stocks in Play: Kandidat merken, Auswahl je Tag ueber alle Aktien
    if (cls === 'stk' && d.fv > 0) { const f = B[0], dir = f.c > f.o ? 1 : (f.c < f.o ? -1 : 0); if (dir && f.c > 5 && d.atr > 0.5) { const e = dir > 0 ? f.h : f.l, st = e - dir * 0.1 * d.atr; const res = run(d, 1, dir, e, st, null, 77, cost, { stopEntry: true }); if (res) { if (!orbCand.has(d.day)) orbCand.set(d.day, []); orbCand.get(d.day).push({ d, sym, rvol: f.v / d.fv, res }); } } }
    // Noise Area (nur Index-ETFs)
    if (['SPY', 'QQQ', 'DIA', 'IWM'].includes(sym)) {
      const sig = []; for (let k = 0; k < 78; k++) { let s = 0; for (let q = i - 14; q < i; q++) s += Math.abs(days[q].bars[k].c / days[q].o - 1); sig.push(s / 14); }
      const up = (k) => Math.max(d.o, pc) * (1 + sig[k]), dn = (k) => Math.min(d.o, pc) * (1 - sig[k]);
      let pv = 0, vv = 0; const vw = []; for (let k = 0; k < 78; k++) { const x = B[k]; pv += (x.h + x.l + x.c) / 3 * (x.v || 1); vv += (x.v || 1); vw.push(pv / vv); }
      for (let k = 5; k < 75; k += 6) { // Schluss 10:00, 10:30, ... (Kerzen 5, 11, 17, ...)
        const x = B[k], dir = x.c > up(k) ? 1 : (x.c < dn(k) ? -1 : 0); if (!dir) continue;
        const stop0 = dir > 0 ? Math.max(up(k), vw[k]) : Math.min(dn(k), vw[k]);
        const e0 = B[k + 1].o, res = run(d, k + 1, dir, e0, dir > 0 ? Math.min(stop0, e0 * 0.9995) : Math.max(stop0, e0 * 1.0005), null, 77, cost, { trail: (q) => ((q + 1) % 6 === 0 ? (dir > 0 ? Math.max(up(q), vw[q]) : Math.min(dn(q), vw[q])) : null) });
        add('noise', d, sym, cls, res); break;
      }
    }
    // Intraday-Momentum: Rendite Vortagesschluss bis 10:00 -> letzte halbe Stunde
    { const r1 = B[5].c / pc - 1, dir = r1 > 0 ? 1 : (r1 < 0 ? -1 : 0); if (dir) { const e = B[72].o, risk = e * 0.0025; add('imom', d, sym, cls, run(d, 72, dir, e, e - dir * risk * 4, null, 77, cost)); } }
    // Kleine Luecke schliessen
    { const gap = d.o / pc - 1, ag = Math.abs(gap); if (ag >= 0.0015 && ag <= 0.006) { const dir = gap > 0 ? -1 : 1; add('gapfill', d, sym, cls, run(d, 0, dir, d.o, d.o - dir * Math.abs(d.o - pc), pc, 23, cost)); } }
    // VWAP-Rueckkehr
    { let pv = 0, vv = 0, s2 = 0, n = 0, done = { 1: false, '-1': false }; const cl = B.map((x) => x.c);
      for (let k = 0; k < 70; k++) { const x = B[k], tp = (x.h + x.l + x.c) / 3; pv += tp * (x.v || 1); vv += (x.v || 1); const vw = pv / vv; s2 += (tp - vw) ** 2; n++;
        if (k < 6) continue; const sd = Math.sqrt(s2 / n); if (!(sd > 0)) continue;
        const g1 = cl[k] - cl[k - 1], g2 = cl[k - 1] - cl[k - 2], up = Math.max(g1, 0) + Math.max(g2, 0), dn2 = Math.max(-g1, 0) + Math.max(-g2, 0), rsi = up + dn2 > 0 ? up / (up + dn2) * 100 : 50;
        const dir = x.c < vw - 2 * sd && rsi < 10 ? 1 : (x.c > vw + 2 * sd && rsi > 90 ? -1 : 0);
        if (!dir || done[dir]) continue; done[dir] = true;
        const e = B[k + 1].o, dist = Math.abs(vw - e); if (dist <= e * 0.0005 || (vw - e) * dir <= 0) continue;
        add('vwaprev', d, sym, cls, run(d, k + 1, dir, e, e - dir * dist, vw, 75, cost)); } }
    // 30-Min-Eroeffnungsspanne mit Tagestrend
    if (d.sma50) { const hi = Math.max(...B.slice(0, 6).map((x) => x.h)), lo = Math.min(...B.slice(0, 6).map((x) => x.l)), tr = pc > d.sma50 ? 1 : -1;
      for (let k = 6; k < 60; k++) { const x = B[k]; const dir = x.c > hi ? 1 : (x.c < lo ? -1 : 0); if (!dir) continue; if (dir === tr) add('orb30', d, sym, cls, run(d, k + 1, dir, B[k + 1].o, dir > 0 ? lo : hi, null, 77, cost)); break; } }
  }
  console.log(sym, days.length, 'Tage', Math.round((Date.now() - T0) / 1000) + 's', Object.fromEntries(Object.entries(T).map(([k, v]) => [k, v.length])));
}
for (const [day, c] of orbCand) c.sort((a, b) => b.rvol - a.rvol).slice(0, 3).filter((x) => x.rvol >= 2).forEach((x) => add('orbplay', x.d, x.sym, 'stk', x.res));
const pick = (a) => a ? { n: a.n, mean: +a.mean.toFixed(3), win: +a.win.toFixed(3), lo: a.lo != null ? +a.lo.toFixed(3) : null, pct: null } : { n: 0 };
const rS = (rs) => { const n = rs.length; if (!n) return null; const m = rs.reduce((a, b) => a + b, 0) / n, sd = Math.sqrt(rs.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, n - 1)); return { n, mean: m, win: rs.filter((x) => x > 0).length / n, lo: m - 1.96 * sd / Math.sqrt(n) }; };
// Bewertung in Prozent je Trade nach Kosten (R zusaetzlich, bei sehr engen Stops aber wenig aussagekraeftig)
const st = (a) => { const x = pick(rS(a.map((t) => t.pct))); if (x.n) { x.pct = x.mean; x.mean = +(a.reduce((s2, t) => s2 + t.pct, 0) / a.length).toFixed(4); x.lo = +x.lo.toFixed(4); x.r = +(a.reduce((s2, t) => s2 + Math.max(-3, Math.min(10, t.r)), 0) / a.length).toFixed(3); } return x; };
const NAMES = { orbplay: 'ORB Stocks in Play (5 Min)', noise: 'Noise Area „Beat the Market“', imom: 'Intraday-Momentum letzte halbe Stunde', gapfill: 'Kleine Eröffnungslücke schließen', vwaprev: 'VWAP-Rückkehr (2 Standardabweichungen)', orb30: '30-Min-Ausbruch mit Tagestrend' };
const out = { at: new Date().toISOString(), from: FROM, feed, info, sets: {} };
const allDays = new Set([...Object.values(T)].flat().map((t) => t.day)).size;
for (const [name, arr0] of Object.entries(T)) for (const cls of ['all', 'etf', 'stk']) {
  const arr = arr0.filter((t) => cls === 'all' || t.cls === cls).sort((a, b) => a.t - b.t); if (arr.length < 30) continue;
  const cut = arr[Math.floor(arr.length * 0.75)].t, split = arr[Math.floor(arr.length * 0.375)].t;
  const o = { name: NAMES[name] + (cls === 'etf' ? ' · ETFs' : cls === 'stk' ? ' · Aktien' : ''), all: st(arr), train: st(arr.filter((t) => t.t < split)), test: st(arr.filter((t) => t.t >= split && t.t < cut)), hold: st(arr.filter((t) => t.t >= cut)), perDay: +(arr.length / allDays).toFixed(2), holdFrom: new Date(cut).toISOString().slice(0, 10) };
  const pos = o.all.lo > 0 && [o.train, o.test, o.hold].every((x) => x.n >= 10 && x.mean > 0);
  o.passed = pos; o.creme = pos && o.all.win >= 0.6;
  // Je Markt: wo funktioniert es (nur Information, Auswahl nach Markt waere Rosinenpicken)
  const bySym = {}; arr.forEach((t) => (bySym[t.sym] = bySym[t.sym] || []).push(t)); o.bySym = Object.fromEntries(Object.entries(bySym).map(([k, v]) => [k, st(v)]).filter(([k, v]) => v.n >= 20));
  out.sets[name + ':' + cls] = o;
}
out.passed = Object.keys(out.sets).filter((k) => out.sets[k].passed); out.creme = Object.keys(out.sets).filter((k) => out.sets[k].creme);
writeFileSync(OUT, JSON.stringify(out) + '\n');
console.log(JSON.stringify({ passed: out.passed, creme: out.creme }));
for (const [k, o] of Object.entries(out.sets)) console.log(k.padEnd(16), o.all.n, 'win', o.all.win, 'R', o.all.mean, 'pct', o.all.pct, '|', o.train.mean, o.test.mean, o.hold.mean, 'lo', o.all.lo, o.perDay, o.passed ? (o.creme ? 'CREME' : 'PASS') : '');
