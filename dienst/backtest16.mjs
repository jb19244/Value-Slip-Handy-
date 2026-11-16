// Pruefung der TradingView-Ampel (Trade Check · Ampel) mit 5-Min-Kerzen seit 2013 (Dukascopy).
// Genau die Regel des Indikators:
//  1) Richtung aus der 4h-Struktur (Bruch des letzten 4h-Hochs = aufwaerts, Schluss unter dem geschuetzten Tief = Wende).
//  2) Korrektur: Kurs muss in die guenstige Haelfte der letzten 4h-Bewegung zurueckkommen (Discount bei Long, Premium bei Short),
//     ohne das geschuetzte Tief/Hoch zu brechen.
//  3) Wende bestaetigt: 15-Min-Schluss ueber dem letzten 15-Min-Swing-Hoch (bei Long) nach dem Ruecklauf.
//  4) Einstieg zur naechsten Kerze, Stop unter dem Korrektur-Tief (0,1 ATR Puffer, mind. 0,5 ATR vom Einstieg), Ziel = 4h-Hoch (Liquiditaet), nur ab CRV 2.
// Kosten: Spread je Markt wie in der Daytrading-Forschung. Vorsichtig: Stop vor Ziel in derselben Kerze.
// Ergebnis: dienst/backtest-ampel.json
import { writeFileSync } from 'node:fs';
import { INS, load } from './backtest13.mjs';

function agg(rows, ms) { const out = []; let cur = null;
  for (const r of rows) { const k = Math.floor(r[0] / ms) * ms; if (!cur || cur.t !== k) { if (cur) out.push(cur); cur = { t: k, o: r[1], h: r[2], l: r[3], c: r[4] }; } else { if (r[2] > cur.h) cur.h = r[2]; if (r[3] < cur.l) cur.l = r[3]; cur.c = r[4]; } }
  if (cur) out.push(cur); return out; }

// 4h-Zustand nach jeder abgeschlossenen 4h-Kerze
function htfStates(H, L) {
  const S = []; let trend = 0, legLow = null, legHigh = null, legHighT = 0, lastPH = null, lastPHt = 0, lastPL = null, lastPLt = 0;
  for (let i = 0; i < H.length; i++) {
    const b = H[i];
    if (i >= 2 * L) { const j = i - L, w = H.slice(j - L, i + 1);
      if (w.every((x) => x.h <= H[j].h)) { lastPH = H[j].h; lastPHt = H[j].t; }
      if (w.every((x) => x.l >= H[j].l)) { lastPL = H[j].l; lastPLt = H[j].t; } }
    if (trend === 1) {
      if (b.c < legLow) { trend = -1; legLow = b.l; legHighT = b.t; /* legHigh bleibt Spitze */ }
      else if (b.h > legHigh) { if (lastPL != null && lastPLt > legHighT && lastPL > legLow) legLow = lastPL; legHigh = b.h; legHighT = b.t; }
    } else if (trend === -1) {
      if (b.c > legHigh) { trend = 1; legHigh = b.h; legHighT = b.t; }
      else if (b.l < legLow) { if (lastPH != null && lastPHt > legHighT && lastPH < legHigh) legHigh = lastPH; legLow = b.l; legHighT = b.t; }
    } else {
      if (lastPH != null && b.c > lastPH && lastPL != null) { trend = 1; legLow = lastPL; legHigh = b.h; legHighT = b.t; }
      else if (lastPL != null && b.c < lastPL && lastPH != null) { trend = -1; legHigh = lastPH; legLow = b.l; legHighT = b.t; }
    }
    S.push({ t: b.t, end: b.t + 4 * 3600e3, trend, legLow, legHigh, extT: legHighT });
  }
  return S;
}

function run(rows, ins, P) {
  const M = agg(rows, 15 * 60e3), H = agg(rows, 4 * 3600e3), S = htfStates(H, P.hl), trades = [];
  // ATR(14) auf 15 Min
  const atr = []; let a = null; for (let i = 0; i < M.length; i++) { const tr = i ? Math.max(M[i].h - M[i].l, Math.abs(M[i].h - M[i - 1].c), Math.abs(M[i].l - M[i - 1].c)) : M[i].h - M[i].l; a = a == null ? tr : (a * 13 + tr) / 14; atr.push(a); }
  let si = -1, lastLH = null, lastLHt = 0, lastHL = null, lastHLt = 0, usedPiv = 0, pos = null, pbEx = null, pbKey = null;
  for (let i = 0; i < M.length; i++) {
    const b = M[i];
    while (si + 1 < S.length && S[si + 1].end <= b.t) si++;   // nur abgeschlossene 4h-Kerzen
    const st = si >= 0 ? S[si] : null;
    // offene Position abwickeln (ab der Kerze nach dem Einstieg)
    if (pos && i > pos.i) {
      const hitS = pos.dir > 0 ? b.l <= pos.stop : b.h >= pos.stop, hitT = pos.dir > 0 ? b.h >= pos.tgt : b.l <= pos.tgt;
      let x = null; if (hitS) x = pos.stop; else if (hitT) x = pos.tgt; else if (b.t - pos.t > 5 * 864e5) x = b.c;
      if (x != null) { const R = ((x - pos.e) * pos.dir - ins.cost) / pos.risk; trades.push({ t: pos.t, y: new Date(pos.t).getUTCFullYear(), R, dir: pos.dir }); pos = null; }
    }
    // 15-Min-Pivots (L Kerzen links und rechts)
    const L = P.ll; if (i >= 2 * L) { const j = i - L, w = M.slice(j - L, i + 1);
      if (w.every((x) => x.h <= M[j].h)) { lastLH = M[j].h; lastLHt = M[j].t; }
      if (w.every((x) => x.l >= M[j].l)) { lastHL = M[j].l; lastHLt = M[j].t; } }
    if (!st || !st.trend || pos) continue;
    const dir = st.trend, rng = st.legHigh - st.legLow; if (!(rng > 0)) continue;
    const key = st.extT + ':' + dir; if (key !== pbKey) { pbKey = key; pbEx = null; }
    // Korrektur-Extrem seit der letzten 4h-Spitze
    pbEx = pbEx == null ? (dir > 0 ? b.l : b.h) : (dir > 0 ? Math.min(pbEx, b.l) : Math.max(pbEx, b.h));
    const lvl = dir > 0 ? st.legHigh - P.disc * rng : st.legLow + P.disc * rng;
    const inZone = dir > 0 ? pbEx <= lvl : pbEx >= lvl, intact = dir > 0 ? pbEx > st.legLow : pbEx < st.legHigh;
    if (!inZone || !intact) continue;
    let trig = false;
    if (P.noTrig) trig = true;
    else if (dir > 0) trig = lastLH != null && lastLHt > st.extT && lastLHt !== usedPiv && b.c > lastLH;
    else trig = lastHL != null && lastHLt > st.extT && lastHLt !== usedPiv && b.c < lastHL;
    if (!trig || i + 1 >= M.length) continue;
    usedPiv = dir > 0 ? lastLHt : lastHLt;
    const e = M[i + 1].o, s0 = pbEx - dir * P.buf * atr[i], stop = dir > 0 ? Math.min(s0, e - 0.5 * atr[i]) : Math.max(s0, e + 0.5 * atr[i]), risk = (e - stop) * dir; // Stop mind. 0,5 ATR weg, sonst fliegt er im Rauschen raus
    const tgt = P.fixR ? e + dir * P.fixR * risk : (dir > 0 ? st.legHigh : st.legLow), crv = (tgt - e) * dir / risk;
    if (!(risk > ins.cost * 3) || crv < P.crv) continue;
    pos = { i: i + 1, t: M[i + 1].t, dir, e, stop, tgt, risk };
  }
  return trades;
}
const stats = (R) => { const n = R.length; if (!n) return { n: 0 }; const m = R.reduce((s, x) => s + x, 0) / n, sd = Math.sqrt(R.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, n - 1));
  return { n, win: +(R.filter((x) => x > 0).length / n).toFixed(3), mean: +m.toFixed(3), t: sd ? +(m / sd * Math.sqrt(n)).toFixed(2) : 0, sum: +R.reduce((s, x) => s + x, 0).toFixed(1) }; };
const VAR = [
  { id: 'basis', hl: 3, ll: 2, disc: 0.5, buf: 0.1, crv: 2 },
  { id: 'tief618', hl: 3, ll: 2, disc: 0.618, buf: 0.1, crv: 2 },
  { id: 'crv1.5', hl: 3, ll: 2, disc: 0.5, buf: 0.1, crv: 1.5 },
  { id: 'crv3', hl: 3, ll: 2, disc: 0.5, buf: 0.1, crv: 3 },
  { id: 'ziel2R', hl: 3, ll: 2, disc: 0.5, buf: 0.1, crv: 0, fixR: 2 },
  { id: 'ohneWende', hl: 3, ll: 2, disc: 0.5, buf: 0.1, crv: 2, noTrig: true },
  { id: 'swing5', hl: 5, ll: 3, disc: 0.5, buf: 0.1, crv: 2 }
];
const out = { at: new Date().toISOString(), rule: 'Ampel: 4h-Struktur, Korrektur in die guenstige Haelfte, 15-Min-Wende, Ziel 4h-Extrem', res: {} };
for (const ins of INS) {
  const rows = await load(ins); console.log(ins.k, rows.length);
  out.res[ins.k] = {};
  for (const P of VAR) {
    const T = run(rows, ins, P), R = T.map((x) => x.R), per = [[0, 2017], [2018, 2021], [2022, 2100]].map(([a, b]) => stats(T.filter((x) => x.y >= a && x.y <= b).map((x) => x.R)));
    const yrs = {}; T.forEach((x) => { yrs[x.y] = (yrs[x.y] || 0) + x.R; }); const yp = Object.values(yrs).filter((v) => v > 0).length;
    out.res[ins.k][P.id] = { all: stats(R), long: stats(T.filter((x) => x.dir > 0).map((x) => x.R)), short: stats(T.filter((x) => x.dir < 0).map((x) => x.R)), per, years: yp + '/' + Object.keys(yrs).length };
    const s = out.res[ins.k][P.id];
    console.log('AMPEL', ins.k.padEnd(7), P.id.padEnd(10), JSON.stringify(s.all), '| long', s.long.mean, 'short', s.short.mean, '| Zeitraeume', per.map((x) => x.mean).join(' / '), '| Jahre', s.years);
  }
  // Gegenprobe auf Zufallskursen gleicher Schwankung (5-Min-Bewegungen gemischt): so sieht "kein Vorteil" aus
  let sd = 12345; const rnd = () => { sd |= 0; sd = (sd + 0x6D2B79F5) | 0; let x = Math.imul(sd ^ (sd >>> 15), 1 | sd); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
  const mv = rows.map((r, k) => k ? [r[4] / rows[k - 1][4], r[1] / rows[k - 1][4], r[2] / r[4], r[3] / r[4]] : null).filter(Boolean);
  for (let k = mv.length - 1; k > 0; k--) { const j = Math.floor(rnd() * (k + 1)); [mv[k], mv[j]] = [mv[j], mv[k]]; }
  let pc = rows[0][4]; const fake = mv.map((m, k) => { const c = pc * m[0], o = pc * m[1]; pc = c; return [rows[k + 1][0], o, Math.max(o, c, c * m[2]), Math.min(o, c, c * m[3]), c]; });
  out.res[ins.k].placebo = {};
  for (const P of VAR.filter((v) => ['basis', 'ziel2R', 'swing5'].includes(v.id))) { const st = stats(run(fake, ins, P).map((x) => x.R)); out.res[ins.k].placebo[P.id] = st; console.log('PLACEBO', ins.k.padEnd(7), P.id.padEnd(10), JSON.stringify(st)); }
}
writeFileSync(new URL('./backtest-ampel.json', import.meta.url), JSON.stringify(out));
