// Profi-Strategien, die Privatanleger nachbauen koennen:
//  A) Pairs Trading / statistische Arbitrage (Gatev/Goetzmann/Rouwenhorst 2006): zwei eng verwandte Werte, Spread = ln A - beta * ln B
//     (Beta aus den letzten 60 Tagen), z-Wert ueber 60 Tage. |z| > 2 -> teuren Wert verkaufen, billigen kaufen; raus bei |z| < 0,5,
//     Notausstieg bei |z| > 4 oder nach 20 Tagen. Nur wenn die Korrelation der letzten 250 Tage ueber 0,7 liegt. Kosten fuer 4 Orders.
//  B) Small-Cap-Momentum (Gap and Go): US-Nebenwerte 1-20 USD mit Eroeffnungsluecke ab 20 %, Kauf beim Bruch des Hochs der ersten
//     5-Min-Kerze, Stop unter deren Tief, Haelfte bei +1R, Rest bis +2R oder 11:00 New York. Universum inkl. delisteter Aktien (Alpaca).
// Pruefung wie immer: 1. Haelfte, 2. Haelfte, Haertetest (letzte 25 %), nach Kosten. Ergebnis: dienst/backtest-pro.json
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
const OUT = new URL('backtest-pro.json', import.meta.url);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; TradeCheck/1.0)' };
const out = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : {};
out.at = new Date().toISOString(); out.sets = out.sets || {};
const rS = (a) => { const n = a.length; if (!n) return { n: 0 }; const m = a.reduce((x, y) => x + y, 0) / n, sd = Math.sqrt(a.reduce((x, y) => x + (y - m) ** 2, 0) / Math.max(1, n - 1)); return { n, mean: +m.toFixed(4), win: +(a.filter((x) => x > 0).length / n).toFixed(3), lo: +(m - 1.96 * sd / Math.sqrt(n)).toFixed(4) }; };
function evalSet(name, trades, unit, days) {
  trades = trades.filter((t) => isFinite(t.v)).sort((a, b) => a.t - b.t); if (trades.length < 20) return { name, unit, all: { n: trades.length }, passed: false };
  const s1 = trades[Math.floor(trades.length * 0.375)].t, s2 = trades[Math.floor(trades.length * 0.75)].t;
  const st = (a) => rS(a.map((t) => t.v));
  const o = { name, unit, all: st(trades), train: st(trades.filter((t) => t.t < s1)), test: st(trades.filter((t) => t.t >= s1 && t.t < s2)), hold: st(trades.filter((t) => t.t >= s2)),
    from: new Date(trades[0].t).toISOString().slice(0, 10), holdFrom: new Date(s2).toISOString().slice(0, 10), perDay: days ? +(trades.length / days).toFixed(2) : null };
  o.passed = o.all.n >= 100 && o.all.lo > 0 && [o.train, o.test, o.hold].every((x) => x.n >= 15 && x.mean > 0); o.creme = o.passed && o.all.win >= 0.6;
  return o;
}
const PART = process.env.PRO_PART || 'all';
// ---------------- A) Pairs Trading (Tageskerzen, Yahoo, seit 2005) ----------------
if (PART === 'all' || PART === 'pairs') {
  async function daily(sym) {
    for (const h of ['query1', 'query2', 'query1']) { try { const r = await fetch(`https://${h}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&period1=1104537600&period2=${Math.floor(Date.now() / 1000)}`, { headers: UA }); if (r.ok) { const j = await r.json(), x = j.chart.result[0], q = x.indicators.quote[0], ac = (x.indicators.adjclose && x.indicators.adjclose[0].adjclose) || q.close, m = new Map(); x.timestamp.forEach((t, k) => { if (ac[k] != null) m.set(new Date(t * 1000 + 3 * 3600e3).toISOString().slice(0, 10), ac[k]); }); return m; } } catch (e) {} await wait(1500); }
    return new Map();
  }
  const PAIRS = [['KO', 'PEP', 'Coca-Cola / Pepsi'], ['V', 'MA', 'Visa / Mastercard'], ['XOM', 'CVX', 'Exxon / Chevron'], ['HD', 'LOW', 'Home Depot / Lowe’s'], ['GS', 'MS', 'Goldman Sachs / Morgan Stanley'],
    ['JPM', 'BAC', 'JPMorgan / Bank of America'], ['UNP', 'CSX', 'Union Pacific / CSX'], ['UPS', 'FDX', 'UPS / FedEx'], ['MCD', 'YUM', 'McDonald’s / Yum'], ['BHP', 'RIO', 'BHP / Rio Tinto'],
    ['GLD', 'SLV', 'Gold / Silber'], ['BZ=F', 'CL=F', 'Brent / WTI'], ['^GSPC', '^DJI', 'S&P 500 / Dow'], ['^GDAXI', '^STOXX50E', 'DAX / Euro Stoxx 50'], ['EWA', 'EWC', 'Australien / Kanada'],
    ['PG', 'CL', 'Procter & Gamble / Colgate'], ['WMT', 'TGT', 'Walmart / Target'], ['LMT', 'NOC', 'Lockheed / Northrop'], ['SAP', 'ORCL', 'SAP / Oracle'], ['BMW.DE', 'MBG.DE', 'BMW / Mercedes']];
  const COST = 0.20; // Prozent auf das Gesamtvolumen: 4 Orders (je 1 EUR) plus Spreads beider Beine, ein Bein als Knock-out-Put
  const trades = [], per = {}; let days = 0;
  for (const [a, b, nm] of PAIRS) {
    const A = await daily(a), B = await daily(b); await wait(300);
    const keys = [...A.keys()].filter((k) => B.has(k)).sort(); if (keys.length < 400) continue; days = Math.max(days, keys.length);
    const la = keys.map((k) => Math.log(A.get(k))), lb = keys.map((k) => Math.log(B.get(k))), ra = keys.map((k, i) => i ? A.get(k) / A.get(keys[i - 1]) - 1 : 0), rb = keys.map((k, i) => i ? B.get(k) / B.get(keys[i - 1]) - 1 : 0);
    let pos = null; per[nm] = [];
    for (let i = 250; i < keys.length; i++) {
      // Beta, Spread-Mittel und -Streuung nur aus den 60 Tagen bis gestern
      const W = 60, xs = lb.slice(i - W, i), ys = la.slice(i - W, i), mx = xs.reduce((s, v) => s + v, 0) / W, my = ys.reduce((s, v) => s + v, 0) / W;
      let cov = 0, vx = 0; for (let k = 0; k < W; k++) { cov += (xs[k] - mx) * (ys[k] - my); vx += (xs[k] - mx) ** 2; }
      const beta = vx > 0 ? cov / vx : 1, sp = ys.map((y, k) => y - beta * xs[k]), sm = sp.reduce((s, v) => s + v, 0) / W, sd = Math.sqrt(sp.reduce((s, v) => s + (v - sm) ** 2, 0) / W);
      const z = sd > 0 ? (la[i] - beta * lb[i] - sm) / sd : 0;
      if (pos) {
        pos.pnl += pos.dir * (0.5 * ra[i] - 0.5 * rb[i]); pos.days++;
        if (Math.abs(z) < 0.5 || Math.abs(z) > 4 || pos.days >= 20) { const v = pos.pnl * 100 - COST; trades.push({ t: Date.parse(keys[i]), v, pair: nm }); per[nm].push(v); pos = null; }
        continue;
      }
      // Korrelation der Tagesrenditen ueber 250 Tage
      const x2 = ra.slice(i - 250, i), y2 = rb.slice(i - 250, i), m1 = x2.reduce((s, v) => s + v, 0) / 250, m2 = y2.reduce((s, v) => s + v, 0) / 250;
      let c12 = 0, v1 = 0, v2 = 0; for (let k = 0; k < 250; k++) { c12 += (x2[k] - m1) * (y2[k] - m2); v1 += (x2[k] - m1) ** 2; v2 += (y2[k] - m2) ** 2; }
      const corr = c12 / Math.sqrt(v1 * v2);
      if (corr > 0.7 && Math.abs(z) > 2) pos = { dir: z > 0 ? -1 : 1, pnl: 0, days: 0 };  // z > 2: A teuer -> A verkaufen, B kaufen
    }
  }
  out.sets['pairs:daily'] = evalSet('Pairs Trading, 20 klassische Paare (Tageskerzen seit 2005), Ø in % je Trade nach Kosten', trades, '%', days);
  out.pairsBy = Object.fromEntries(Object.entries(per).map(([k, v]) => [k, rS(v)]));
  console.log('pairs', JSON.stringify(out.sets['pairs:daily']));
}
// ---------------- B) Small-Cap-Momentum (Alpaca) ----------------
const KEY = process.env.ALPACA_KEY_ID, SEC = process.env.ALPACA_SECRET_KEY;
if ((PART === 'all' || PART === 'smallcap') && KEY && SEC) {
  const H = { 'APCA-API-KEY-ID': KEY, 'APCA-API-SECRET-KEY': SEC };
  async function getJ(u) { for (let k = 0; k < 6; k++) { try { const r = await fetch(u, { headers: H }); if (r.status === 429) { await wait(15000); continue; } if (!r.ok) { console.log('Alpaca', r.status, u.slice(0, 120)); return null; } return await r.json(); } catch (e) { await wait(3000); } } return null; }
  // Universum: aktive UND delistete US-Aktien (gegen Ueberlebens-Verzerrung)
  let assets = [];
  for (const status of ['active', 'inactive']) { const j = await getJ(`https://paper-api.alpaca.markets/v2/assets?status=${status}&asset_class=us_equity`); if (j) assets = assets.concat(j); }
  const syms = [...new Set(assets.filter((a) => ['NASDAQ', 'NYSE', 'AMEX', 'ARCA', 'BATS'].includes(a.exchange) && /^[A-Z]{1,5}$/.test(a.symbol)).map((a) => a.symbol))];
  console.log('Universum', syms.length, 'davon delistet', assets.filter((a) => a.status === 'inactive').length);
  const FROM = process.env.SC_FROM || '2019-01-01', events = [];
  for (let k = 0; k < syms.length; k += 100) {
    const chunk = syms.slice(k, k + 100); let token = null; const bars = {};
    do {
      const j = await getJ(`https://data.alpaca.markets/v2/stocks/bars?symbols=${chunk.join(',')}&timeframe=1Day&start=${FROM}T00:00:00Z&limit=10000&adjustment=split&feed=sip` + (token ? '&page_token=' + encodeURIComponent(token) : ''));
      if (!j) break; Object.entries(j.bars || {}).forEach(([s, a]) => { (bars[s] = bars[s] || []).push(...a); }); token = j.next_page_token; await wait(300);
    } while (token);
    for (const [s, a] of Object.entries(bars)) for (let i = 21; i < a.length; i++) {
      const pc = a[i - 1].c, gap = a[i].o / pc - 1, av = a.slice(i - 20, i).reduce((x, y) => x + y.v, 0) / 20;
      if (gap >= 0.2 && pc >= 1 && pc <= 20 && av >= 100000) events.push({ s, day: a[i].t.slice(0, 10), gap, pc });
    }
    if (k % 2000 === 0) console.log('Tageskerzen', k, '/', syms.length, 'Luecken bisher', events.length);
  }
  // hoechstens 3000 Ereignisse (zufaellig, fester Startwert), sonst dauert es zu lange
  let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const ev = events.length > 3000 ? events.map((e) => [rnd(), e]).sort((x, y) => x[0] - y[0]).slice(0, 3000).map((x) => x[1]) : events;
  const nyF = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const nyMin = (t) => { const p = {}; nyF.formatToParts(new Date(t)).forEach((x) => { p[x.type] = x.value; }); return (+p.hour) * 60 + (+p.minute); };
  const COST = 0.6; // Prozent je Hin und Rueck: breiter Spread bei Nebenwerten plus Schlupf beim Stopp-Kauf
  const tr = [], trR = [];
  for (const e of ev) {
    const j = await getJ(`https://data.alpaca.markets/v2/stocks/${e.s}/bars?timeframe=5Min&start=${e.day}T13:00:00Z&end=${e.day}T21:00:00Z&limit=200&adjustment=split&feed=sip`); await wait(310);
    const b = ((j && j.bars) || []).map((x) => ({ t: Date.parse(x.t), o: x.o, h: x.h, l: x.l, c: x.c })).filter((x) => { const m = nyMin(x.t); return m >= 570 && m < 960; });
    if (b.length < 20 || nyMin(b[0].t) !== 570) continue;
    const f = b[0], entry = f.h, stop = f.l, risk = entry - stop; if (!(risk > 0) || risk / entry > 0.15) continue;
    let fill = -1, ex = null, part = false;
    for (let k = 1; k < b.length; k++) {
      const x = b[k], m = nyMin(x.t);
      if (fill < 0) { if (m >= 660) break; if (x.h >= entry) { fill = k; } else continue; }
      const e0 = Math.max(entry, b[fill].o);
      if (x.l <= (part ? e0 : stop) && !(k === fill && x.c > stop)) { ex = { px: part ? e0 : Math.min(stop, x.o), how: 'stop' }; break; }
      if (!part && x.h >= e0 + risk) part = true;
      if (x.h >= e0 + 2 * risk) { ex = { px: e0 + 2 * risk, how: 'ziel' }; break; }
      if (m >= 655) { ex = { px: x.c, how: 'zeit' }; break; }
    }
    if (fill < 0) continue;
    const e0 = Math.max(entry, b[fill].o); if (!ex) ex = { px: b[b.length - 1].c, how: 'zeit' };
    const full = (ex.px / e0 - 1) * 100, pp = part ? 0.5 * (risk / e0 * 100) + 0.5 * full : full, v = pp - COST;
    tr.push({ t: Date.parse(e.day), v, sym: e.s }); trR.push({ t: Date.parse(e.day), v: v / (risk / e0 * 100) });
  }
  out.smallcap = { universe: syms.length, delisted: assets.filter((a) => a.status === 'inactive').length, events: events.length, tested: ev.length };
  out.sets['smallcap:gapgo'] = evalSet('Small-Cap Gap and Go (Lücke ab 20 %, 1-20 USD), Ø in % je Trade nach Kosten', tr, '%', null);
  out.sets['smallcap:gapgoR'] = evalSet('Small-Cap Gap and Go, Ø in R je Trade', trR, 'R', null);
  console.log('smallcap', JSON.stringify(out.smallcap), JSON.stringify(out.sets['smallcap:gapgo']));
}
writeFileSync(OUT, JSON.stringify(out) + '\n');
