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

// ===== Vertiefung: Liquiditaets-Sweep im Aufwaertstrend (Tief unter dem N-Tage-Tief, Schluss zurueck darueber) =====
// Varianten: N = 5/10/15/20/30, Ziel 1,5/2/3 R, max. 10/15 Tage. Dazu: nach Tagen gebuendelt, Maerkte, doppelte Kosten, Ueberschneidung mit IBS < 0,2.
const res = {}, VAR = []; for (const N of [5, 10, 15, 20, 30]) for (const T of [1.5, 2, 3]) for (const H of [10, 15]) VAR.push({ N, T, H, id: 'sw' + N + '_t' + T + '_h' + H });
VAR.forEach((v) => { res[v.id] = []; });
for (const s of SYMS) { const D = await chart(s); await wait(300); if (D.length < 2000) continue;
  const A = L.atrSeries(D), SS = {}, S200 = L.smaSeries(D, SS, 200), cost = COST(s);
  for (let i = 205; i < D.length - 16; i++) { const b = D[i], a = A[i]; if (!(a > 0) || !S200[i] || !(b.c > S200[i])) continue;
    const ib = b.h > b.l ? (b.c - b.l) / (b.h - b.l) : 0.5;
    for (const v of VAR) { const m = Math.min(...D.slice(i - v.N, i).map((x) => x.l)); if (!(b.l < m && b.c > m)) continue;
      const e = b.c; let st = b.l - 0.2 * a; if (e - st < 0.5 * a) st = e - 0.5 * a; const rk = e - st, tg = e + v.T * rk; let y = null;
      for (let k = i + 1; k <= i + v.H; k++) { if (D[k].l <= st) { y = Math.min(st, D[k].o); break; } if (D[k].h >= tg) { y = Math.max(tg, D[k].o); break; } } if (y == null) y = D[i + v.H].c;
      res[v.id].push({ t: b.t, s, r: ((y - e) - cost / 100 * e) / rk, c: cost / 100 * e / rk, ibs: ib < 0.2, riskPct: rk / e * 100 }); } } }
const stat = (v) => { const n = v.length; if (!n) return { n: 0, mean: 0, t: 0, win: 0 }; const m = v.reduce((a, x) => a + x, 0) / n, sd = Math.sqrt(v.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, n - 1)); return { n, mean: +m.toFixed(4), t: sd ? +(m / sd * Math.sqrt(n)).toFixed(2) : 0, win: +(v.filter((x) => x > 0).length / n).toFixed(3) }; };
const out = { at: new Date().toISOString(), res: {} };
for (const v of VAR) { const T = res[v.id], all = stat(T.map((x) => x.r)), g = {}; T.forEach((x) => { const d = L.dayOf(x.t); (g[d] = g[d] || []).push(x.r); });
  const day = stat(Object.values(g).map((a) => a.reduce((s, x) => s + x, 0) / a.length)), bys = {}; T.forEach((x) => { (bys[x.s] = bys[x.s] || []).push(x.r); });
  const mk = Object.values(bys).filter((a) => a.length >= 10), plus = mk.filter((a) => stat(a).mean > 0).length, c2 = stat(T.map((x) => x.r - x.c)).mean;
  const per = [[0, 2008], [2009, 2016], [2017, 2100]].map(([p, q]) => stat(T.filter((x) => { const y = +L.dayOf(x.t).slice(0, 4); return y >= p && y <= q; }).map((x) => x.r)).mean);
  const yrs = {}; T.forEach((x) => { const y = L.dayOf(x.t).slice(0, 4); yrs[y] = (yrs[y] || 0) + x.r; }); const yp = Object.values(yrs).filter((x) => x > 0).length;
  const ov = T.filter((x) => x.ibs).length / Math.max(1, T.length), noIbs = stat(T.filter((x) => !x.ibs).map((x) => x.r)), rp = T.map((x) => x.riskPct).sort((a, b) => a - b)[Math.floor(T.length / 2)];
  const pass = all.n >= 150 && day.t >= 3 && per.every((m) => m > 0) && plus >= 0.75 * mk.length && c2 > 0 && yp >= 0.6 * Object.keys(yrs).length;
  out.res[v.id] = { v, all, day, per, maerkte: plus + '/' + mk.length, cost2: c2, jahre: yp + '/' + Object.keys(yrs).length, ibsAnteil: +ov.toFixed(2), ohneIbs: noIbs, stopPct: +(rp || 0).toFixed(2), perYear: +(T.length / 26).toFixed(1), pass };
  console.log('SWEEP', v.id.padEnd(14), JSON.stringify(all), '| Tage-t', day.t, '| Zeitr.', per.join('/'), '| Maerkte', plus + '/' + mk.length, '| 2x Kosten', c2.toFixed(3), '| Jahre', yp + '/' + Object.keys(yrs).length, '| IBS-Anteil', ov.toFixed(2), 'ohne IBS', noIbs.mean, '| Stop Ø', (rp || 0).toFixed(2) + '%', pass ? 'BESTANDEN' : ''); }
writeFileSync(new URL('./backtest-sweep.json', import.meta.url), JSON.stringify(out));
