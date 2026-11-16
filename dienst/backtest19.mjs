// Boden finden mit Price Action, SMC und Elliott: Tageskerzen seit 2000 (US-Indizes, US-Sektoren, DAX, Euro Stoxx, Gold-ETF).
// Frage: Gibt es Price-Action-/SMC-Muster, die einen Boden besser treffen als "einfach im Aufwaertstrend nach Schwaeche kaufen"?
// Muster (nur Long, am Boden): Hammer, Engulfing, Sweep des 10- und 20-Tage-Tiefs mit Schluss zurueck (Spring / 2B / Turtle Soup),
// Doppelboden-Test, Morning Star, Outside-Reversal, Inside-Bar-Ausbruch nach Schwaeche, Elliott-ABC (dritte Welle nach unten unter A, dann Drehung),
// Fibonacci-Golden-Zone (50-61,8 % Ruecklauf) mit Umkehrkerze.
// Zusammenhang: alle Tage / Aufwaertstrend (ueber 200-Tage-Schnitt) / Trend + Ruecksetzer (unter 10-Tage-Schnitt) / Trend + an Unterstuetzung (altes Swing-Tief).
// Ausstiege: A) wie die bewaehrten Regeln: Schluss ueber dem 5-Tage-Schnitt, spaetestens 10 Tage, Notstop 3 ATR.
//            B) klassisch: Stop unter dem Muster (0,2 ATR Puffer), Ziel 2 R, spaetestens 10 Tage.
// Einstieg zum Schluss des Signaltags. Kosten wie in den anderen Rueckrechnungen (doppelt als Stresstest).
// Bestanden nur mit: >= 150 Trades, alle drei Zeitraeume im Plus, t (nach Tagen gebuendelt) >= 3, >= 75 % der Maerkte im Plus,
// doppelte Kosten im Plus UND besser als der Vergleich "gleicher Zusammenhang ohne Muster". Ergebnis: dienst/backtest-boden.json
import { readFileSync, writeFileSync } from 'node:fs';
const html = readFileSync(new URL('../trade/index.html', import.meta.url), 'utf8');
const src = html.split('// BEGIN LOGIC')[1].split('// END LOGIC')[0];
const L = new Function(src + '; return { parseYahoo, rStats, dayOf, atrSeries, smaSeries };')();
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; TradeCheck/1.0)' }, wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function chart(sym) { for (const host of ['query1', 'query2', 'query1']) { try { const r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&period1=946684800&period2=${Math.floor(Date.now() / 1000)}`, { headers: UA }); if (r.ok) return L.parseYahoo(await r.json()).filter((x) => x.o > 0 && x.h >= x.l && x.c > 0); } catch (e) {} await wait(1500); } return []; }
const SYMS = ['^GSPC', '^NDX', '^DJI', '^RUT', 'XLK', 'XLF', 'XLE', 'XLV', 'XLY', 'XLP', 'XLI', 'XLB', 'XLU', '^GDAXI', '^STOXX50E', 'GLD'];
const COST = (s) => /^\^/.test(s) ? 0.07 : 0.08;
const body = (b) => Math.abs(b.c - b.o), up = (b) => b.c > b.o, dn = (b) => b.c < b.o;
// Swing-Tiefs/-Hochs (2 Kerzen links und rechts), bestaetigt erst 2 Tage spaeter
function swings(D) { const lo = [], hi = []; for (let i = 4; i < D.length; i++) { const j = i - 2, w = D.slice(j - 2, i + 1); if (w.every((x) => x.l >= D[j].l)) lo.push({ i: j, v: D[j].l, seen: i }); if (w.every((x) => x.h <= D[j].h)) hi.push({ i: j, v: D[j].h, seen: i }); } return { lo, hi }; }
const PAT = {
  hammer: (D, i, A) => { const b = D[i], r = b.h - b.l, lw = Math.min(b.o, b.c) - b.l; return r > 0.6 * A && lw >= 2 * body(b) && lw >= 0.55 * r && (b.c - b.l) >= 0.6 * r ? b.l : null; },
  engulf: (D, i, A) => { const a = D[i - 1], b = D[i]; return dn(a) && up(b) && b.c >= a.o && b.o <= a.c && body(b) >= 0.4 * A ? Math.min(a.l, b.l) : null; },
  sweep10: (D, i) => { const m = Math.min(...D.slice(i - 10, i).map((x) => x.l)); return D[i].l < m && D[i].c > m ? D[i].l : null; },
  sweep20: (D, i) => { const m = Math.min(...D.slice(i - 20, i).map((x) => x.l)); return D[i].l < m && D[i].c > m ? D[i].l : null; },
  doubleTest: (D, i, A, SW) => { const b = D[i]; if ((b.c - b.l) < 0.5 * (b.h - b.l)) return null; const c = SW.lo.filter((s) => s.seen < i && i - s.i >= 8 && i - s.i <= 60);
    for (const s of c) { const between = Math.min(...D.slice(s.i + 1, i).map((x) => x.l)); if (Math.abs(b.l - s.v) <= 0.5 * A && between > s.v && between > b.l - 0.01 * A) return Math.min(b.l, s.v); } return null; },
  star: (D, i, A) => { const a = D[i - 2], m = D[i - 1], b = D[i]; return dn(a) && body(a) >= 0.6 * A && body(m) <= 0.35 * body(a) && up(b) && b.c > (a.o + a.c) / 2 ? Math.min(a.l, m.l, b.l) : null; },
  outsideRev: (D, i) => { const a = D[i - 1], b = D[i]; return b.l < a.l && b.c > a.h ? b.l : null; },
  insideUp: (D, i) => { const m = D[i - 2], x = D[i - 1], b = D[i]; return x.h < m.h && x.l > m.l && b.c > m.h && D[i - 2].c < D[i - 5].c ? x.l : null; },
  elliottABC: (D, i, A, SW) => { // A-Tief, B-Hoch darunter liegend vom Hoch davor, heute neues Tief unter A (C-Welle) und Schluss ueber dem Vortageshoch
    const lo = SW.lo.filter((s) => s.seen < i && i - s.i <= 40), hi = SW.hi.filter((s) => s.seen < i && i - s.i <= 60); if (!lo.length || hi.length < 2) return null;
    const a = lo[lo.length - 1], b = hi.filter((h) => h.i > a.i).pop(), top = hi.filter((h) => h.i < a.i).pop(); if (!b || !top || !(b.v < top.v)) return null;
    const cLow = Math.min(...D.slice(b.i + 1, i + 1).map((x) => x.l)); return cLow < a.v && D[i].c > D[i - 1].h && D[i].l <= cLow + 0.5 * A ? cLow : null; },
  fibGolden: (D, i, A) => { const w = D.slice(i - 60, i), lo = Math.min(...w.map((x) => x.l)), li = w.findIndex((x) => x.l === lo), hi = Math.max(...w.slice(li).map((x) => x.h)), rg = hi - lo; if (rg < 3 * A) return null;
    const b = D[i], z1 = hi - 0.5 * rg, z2 = hi - 0.618 * rg; return b.l <= z1 && b.l >= z2 - 0.25 * A && up(b) && (b.c - b.l) >= 0.6 * (b.h - b.l) ? b.l : null; }
};
const CTX = ['alle', 'trend', 'trend+ruecksetzer', 'trend+unterstuetzung'];
const res = {}; [...Object.keys(PAT), '_basis'].forEach((p) => { res[p] = {}; CTX.forEach((c) => { res[p][c] = { A: [], B: [] }; }); });
for (const s of SYMS) {
  const D = await chart(s); await wait(300); if (D.length < 2000) { console.log('fehlt', s); continue; }
  const A = L.atrSeries(D), SS = {}, S200 = L.smaSeries(D, SS, 200), S10 = L.smaSeries(D, SS, 10), S5 = L.smaSeries(D, SS, 5), SW = swings(D), cost = COST(s);
  console.log(s, D.length, 'Tage seit', L.dayOf(D[0].t));
  for (let i = 205; i < D.length - 11; i++) {
    const b = D[i], a = A[i]; if (!(a > 0) || !S200[i]) continue;
    const trend = b.c > S200[i], pull = b.c < S10[i], supp = SW.lo.some((x) => x.seen < i && i - x.i >= 10 && i - x.i <= 120 && Math.abs(b.l - x.v) <= 1 * a);
    const ctx = ['alle'].concat(trend ? ['trend'] : [], trend && pull ? ['trend+ruecksetzer'] : [], trend && supp ? ['trend+unterstuetzung'] : []);
    const hits = []; for (const p of Object.keys(PAT)) { const ext = PAT[p](D, i, A[i - 1] || a, SW); if (ext != null) hits.push([p, ext]); }
    hits.push(['_basis', b.l]);
    for (const [p, ext] of hits) {
      const e = b.c; let x = null, k = 0;
      // A) Ausstieg wie die bewaehrten Regeln
      const ns = e - 3 * a; for (k = i + 1; k <= i + 10; k++) { if (D[k].l <= ns) { x = Math.min(ns, D[k].o); break; } if (D[k].c > S5[k]) { x = D[k].c; break; } } if (x == null) x = D[i + 10].c;
      const pA = (x / e - 1) * 100 - cost;
      // B) Stop unter dem Muster, Ziel 2 R
      let st = ext - 0.2 * a; if (e - st < 0.5 * a) st = e - 0.5 * a; const rk = e - st, tg = e + 2 * rk; let y = null;
      for (k = i + 1; k <= i + 10; k++) { if (D[k].l <= st) { y = Math.min(st, D[k].o); break; } if (D[k].h >= tg) { y = Math.max(tg, D[k].o); break; } } if (y == null) y = D[i + 10].c;
      const rB = ((y - e) - cost / 100 * e) / rk;
      for (const c of ctx) { res[p][c].A.push({ t: b.t, s, pct: pA, cost }); res[p][c].B.push({ t: b.t, s, r: rB }); }
    }
  }
}
const stat = (v) => { const n = v.length; if (!n) return { n: 0, mean: 0, t: 0, win: 0 }; const m = v.reduce((a, x) => a + x, 0) / n, sd = Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, n - 1)); return { n, mean: +m.toFixed(4), t: sd ? +(m / sd * Math.sqrt(n)).toFixed(2) : 0, win: +(v.filter((x) => x > 0).length / n).toFixed(3) }; };
const byDay = (T, f) => { const g = {}; T.forEach((x) => { const d = L.dayOf(x.t); (g[d] = g[d] || []).push(f(x)); }); return stat(Object.values(g).map((a) => a.reduce((s, x) => s + x, 0) / a.length)); };
const per = (T, f) => [[0, 2008], [2009, 2016], [2017, 2100]].map(([p, q]) => stat(T.filter((x) => { const y = +L.dayOf(x.t).slice(0, 4); return y >= p && y <= q; }).map(f)).mean);
const out = { at: new Date().toISOString(), res: {}, passed: [] };
for (const p of Object.keys(res)) { out.res[p] = {};
  for (const c of CTX) { const R = res[p][c], base = res._basis[c];
    const aAll = stat(R.A.map((x) => x.pct)), aDay = byDay(R.A, (x) => x.pct), aPer = per(R.A, (x) => x.pct), a2 = stat(R.A.map((x) => x.pct - x.cost));
    const bys = {}; R.A.forEach((x) => { (bys[x.s] = bys[x.s] || []).push(x.pct); }); const sp = Object.values(bys).filter((v) => v.length >= 5), plus = sp.filter((v) => stat(v).mean > 0).length;
    const bAll = stat(R.B.map((x) => x.r)), bPer = per(R.B, (x) => x.r), baseA = stat(base.A.map((x) => x.pct)).mean, baseB = stat(base.B.map((x) => x.r)).mean;
    const passA = p !== '_basis' && aAll.n >= 150 && aDay.t >= 3 && aPer.every((m) => m > 0) && plus >= 0.75 * sp.length && a2.mean > 0 && aAll.mean > baseA;
    const passB = p !== '_basis' && bAll.n >= 150 && bAll.t >= 3 && bPer.every((m) => m > 0) && bAll.mean > baseB;
    out.res[p][c] = { A: { all: aAll, day: aDay, per: aPer, cost2: a2.mean, maerkte: plus + '/' + sp.length, basis: baseA, pass: passA }, B: { all: bAll, per: bPer, basis: baseB, pass: passB } };
    if (passA) out.passed.push({ p, c, exit: 'A', all: aAll }); if (passB) out.passed.push({ p, c, exit: 'B', all: bAll });
    console.log('BODEN', p.padEnd(12), c.padEnd(21), '| A (Ausstieg 5-Tage-Schnitt):', JSON.stringify(aAll), 'Tage-t', aDay.t, 'Zeitr.', aPer.join('/'), 'Maerkte', plus + '/' + sp.length, 'Basis', baseA, passA ? 'BESTANDEN' : '',
      '| B (Stop Muster, 2R):', JSON.stringify(bAll), 'Zeitr.', bPer.join('/'), 'Basis', baseB, passB ? 'BESTANDEN' : ''); } }
console.log('BESTANDEN:', out.passed.length ? out.passed.map((x) => x.p + ' [' + x.c + ', Ausstieg ' + x.exit + ']').join(', ') : 'keins');
writeFileSync(new URL('./backtest-boden.json', import.meta.url), JSON.stringify(out));
