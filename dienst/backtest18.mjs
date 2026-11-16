// Price Action im Test: alle gaengigen Kerzen- und Chartmuster auf 15-Min-Kerzen seit 2013 (Dukascopy, 7 Maerkte),
// jeweils allein, nur in 4h-Trendrichtung, nur in einer 1h-Zone (FVG / Order Block wie im Indikator "TC Zonen")
// und mit beidem. Einstieg zur naechsten Kerze, Stop hinter dem Muster (mind. 0,5 ATR), Ziel 2 R, sonst nach 4 Stunden raus.
// Nur waehrend der Haupthandelszeit des Marktes. Kosten: Spread je Markt. Vorsichtig: Stop vor Ziel in derselben Kerze.
// Bestanden nur mit: mind. 200 Trades, Ø > 0 nach Kosten, t >= 3, mind. 5 von 7 Maerkten im Plus, alle drei Zeitraeume im Plus.
// Ergebnis: dienst/backtest-pa.json (die Bewertung jedes Musters steht danach im Indikator)
import { writeFileSync } from 'node:fs';
import { INS, load } from './backtest13.mjs';

const agg = (rows, ms) => { const out = []; let c = null;
  for (const r of rows) { const k = Math.floor(r[0] / ms) * ms; if (!c || c.t !== k) { if (c) out.push(c); c = { t: k, o: r[1], h: r[2], l: r[3], c: r[4] }; } else { if (r[2] > c.h) c.h = r[2]; if (r[3] < c.l) c.l = r[3]; c.c = r[4]; } }
  if (c) out.push(c); return out; };
const atrOf = (B) => { const a = []; let v = null; for (let i = 0; i < B.length; i++) { const b = B[i], tr = i ? Math.max(b.h - b.l, Math.abs(b.h - B[i - 1].c), Math.abs(b.l - B[i - 1].c)) : b.h - b.l; v = v == null ? tr : (v * 13 + tr) / 14; a.push(v); } return a; };
const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' }), hc = new Map();
const berlin = (ms) => { const k = Math.floor(ms / 3600e3); let v = hc.get(k); if (!v) { const p = {}; fmt.formatToParts(new Date(k * 3600e3)).forEach((x) => { p[x.type] = x.value; }); v = { h: +p.hour, wd: p.weekday }; hc.set(k, v); } return v.h * 60 + new Date(ms).getUTCMinutes(); };
const SESS = { dax: [540, 1050], us: [930, 1320], ldn: [480, 1200] };

// 4h-Struktur wie in der Ampel: Schluss ueber dem letzten Swing-Hoch = aufwaerts, Schluss unter dem geschuetzten Tief = Wende
function htfTrend(H, L) { const S = []; let tr = 0, lo = null, hi = null, ph = null, pl = null;
  for (let i = 0; i < H.length; i++) { const b = H[i];
    if (i >= 2 * L) { const j = i - L, w = H.slice(j - L, i + 1); if (w.every((x) => x.h <= H[j].h)) ph = H[j].h; if (w.every((x) => x.l >= H[j].l)) pl = H[j].l; }
    if (tr === 1) { if (b.c < lo) { tr = -1; hi = Math.max(hi, b.h); lo = b.l; } else if (b.h > hi) { hi = b.h; if (pl != null && pl > lo) lo = pl; } }
    else if (tr === -1) { if (b.c > hi) { tr = 1; lo = Math.min(lo, b.l); hi = b.h; } else if (b.l < lo) { lo = b.l; if (ph != null && ph < hi) hi = ph; } }
    else if (ph != null && pl != null) { if (b.c > ph) { tr = 1; lo = pl; hi = b.h; } else if (b.c < pl) { tr = -1; hi = ph; lo = b.l; } }
    S.push({ end: b.t + 4 * 3600e3, tr }); }
  return S; }
// 1h-Zonen wie im Indikator: FVG (Luecke >= 0,15 ATR) und Order Block (letzte Gegenkerze vor einem Strukturbruch), bis gefuellt / durchbrochen
function zones1h(H) { const A = atrOf(H), Z = []; let lastH = null, hOpen = false, lastL = null, lOpen = false; const L = 3;
  for (let i = 3; i < H.length; i++) { const b = H[i], end = b.t + 3600e3;
    if (i >= 2 * L) { const j = i - L, w = H.slice(j - L, i + 1); if (w.every((x) => x.h <= H[j].h)) { lastH = H[j].h; hOpen = true; } if (w.every((x) => x.l >= H[j].l)) { lastL = H[j].l; lOpen = true; } }
    if (b.l > H[i - 2].h && b.l - H[i - 2].h >= 0.15 * A[i - 1]) Z.push({ d: 1, top: b.l, bot: H[i - 2].h, from: end, to: Infinity, k: 'fvg' });
    if (b.h < H[i - 2].l && H[i - 2].l - b.h >= 0.15 * A[i - 1]) Z.push({ d: -1, top: H[i - 2].l, bot: b.h, from: end, to: Infinity, k: 'fvg' });
    if (hOpen && lastH != null && b.c > lastH) { hOpen = false; for (let k = i - 1; k >= Math.max(0, i - 30); k--) if (H[k].c < H[k].o) { Z.push({ d: 1, top: H[k].h, bot: H[k].l, from: end, to: Infinity, k: 'ob' }); break; } }
    if (lOpen && lastL != null && b.c < lastL) { lOpen = false; for (let k = i - 1; k >= Math.max(0, i - 30); k--) if (H[k].c > H[k].o) { Z.push({ d: -1, top: H[k].h, bot: H[k].l, from: end, to: Infinity, k: 'ob' }); break; } }
    // Zonen schliessen: FVG gefuellt, OB mit Schluss durchbrochen
    for (const z of Z) if (z.to === Infinity && z.from <= b.t) { if (z.d > 0 ? (z.k === 'fvg' ? b.l <= z.bot : b.c < z.bot) : (z.k === 'fvg' ? b.h >= z.top : b.c > z.top)) z.to = end; }
  }
  return Z; }

// Muster auf 15 Min: gibt { d (1/-1), ext (Extrem fuer den Stop) } oder null. B = Kerzen, i = gerade geschlossene Kerze, A = ATR
const body = (b) => Math.abs(b.c - b.o), rng = (b) => b.h - b.l, bull = (b) => b.c > b.o, bear = (b) => b.c < b.o;
const PAT = {
  pin: (B, i, A) => { const b = B[i], r = rng(b); if (r < 0.6 * A) return null; const lw = Math.min(b.o, b.c) - b.l, uw = b.h - Math.max(b.o, b.c);
    if (lw >= 2 * body(b) && lw >= 0.6 * r && (b.c - b.l) >= 0.66 * r) return { d: 1, ext: b.l }; if (uw >= 2 * body(b) && uw >= 0.6 * r && (b.h - b.c) >= 0.66 * r) return { d: -1, ext: b.h }; return null; },
  engulf: (B, i, A) => { const a = B[i - 1], b = B[i]; if (body(b) < 0.5 * A) return null;
    if (bear(a) && bull(b) && b.c >= a.o && b.o <= a.c) return { d: 1, ext: Math.min(a.l, b.l) }; if (bull(a) && bear(b) && b.c <= a.o && b.o >= a.c) return { d: -1, ext: Math.max(a.h, b.h) }; return null; },
  insideBreak: (B, i) => { const m = B[i - 2], x = B[i - 1], b = B[i]; if (!(x.h < m.h && x.l > m.l)) return null;
    if (b.c > m.h) return { d: 1, ext: x.l }; if (b.c < m.l) return { d: -1, ext: x.h }; return null; },
  outside: (B, i, A) => { const a = B[i - 1], b = B[i]; if (!(b.h > a.h && b.l < a.l) || rng(b) < A) return null; const pos = (b.c - b.l) / rng(b);
    if (pos > 0.75 && b.c > a.h) return { d: 1, ext: b.l }; if (pos < 0.25 && b.c < a.l) return { d: -1, ext: b.h }; return null; },
  star: (B, i, A) => { const a = B[i - 2], m = B[i - 1], b = B[i]; if (body(a) < 0.6 * A || body(m) > 0.3 * body(a)) return null;
    if (bear(a) && bull(b) && b.c > (a.o + a.c) / 2) return { d: 1, ext: Math.min(m.l, b.l, a.l) }; if (bull(a) && bear(b) && b.c < (a.o + a.c) / 2) return { d: -1, ext: Math.max(m.h, b.h, a.h) }; return null; },
  soldiers: (B, i, A) => { const s = [B[i - 2], B[i - 1], B[i]]; const near = (b, up) => up ? (b.h - b.c) <= 0.25 * rng(b) : (b.c - b.l) <= 0.25 * rng(b);
    if (s.every((b) => bull(b) && body(b) >= 0.4 * A && near(b, true)) && s[1].c > s[0].c && s[2].c > s[1].c && s[1].o >= s[0].o && s[2].o >= s[1].o) return { d: 1, ext: s[0].l };
    if (s.every((b) => bear(b) && body(b) >= 0.4 * A && near(b, false)) && s[1].c < s[0].c && s[2].c < s[1].c && s[1].o <= s[0].o && s[2].o <= s[1].o) return { d: -1, ext: s[0].h }; return null; },
  tweezer: (B, i, A) => { const a = B[i - 1], b = B[i];
    if (bear(a) && bull(b) && Math.abs(a.l - b.l) <= 0.05 * A && body(a) >= 0.3 * A) return { d: 1, ext: Math.min(a.l, b.l) }; if (bull(a) && bear(b) && Math.abs(a.h - b.h) <= 0.05 * A && body(a) >= 0.3 * A) return { d: -1, ext: Math.max(a.h, b.h) }; return null; },
  piercing: (B, i, A) => { const a = B[i - 1], b = B[i]; if (body(a) < 0.5 * A) return null;
    if (bear(a) && bull(b) && b.o <= a.c && b.c > (a.o + a.c) / 2 && b.c < a.o) return { d: 1, ext: Math.min(a.l, b.l) }; if (bull(a) && bear(b) && b.o >= a.c && b.c < (a.o + a.c) / 2 && b.c > a.o) return { d: -1, ext: Math.max(a.h, b.h) }; return null; },
  harami: (B, i, A) => { const a = B[i - 1], b = B[i]; if (body(a) < 0.6 * A || body(b) > 0.5 * body(a)) return null;
    if (bear(a) && bull(b) && b.o >= a.c && b.c <= a.o) return { d: 1, ext: a.l }; if (bull(a) && bear(b) && b.o <= a.c && b.c >= a.o) return { d: -1, ext: a.h }; return null; },
  doji: (B, i) => { const d = B[i - 1], b = B[i]; if (rng(d) <= 0 || body(d) > 0.1 * rng(d)) return null; const dn = B[i - 2].c < B[i - 3].c && B[i - 3].c < B[i - 4].c, up = B[i - 2].c > B[i - 3].c && B[i - 3].c > B[i - 4].c;
    if (dn && b.c > d.h) return { d: 1, ext: Math.min(d.l, b.l) }; if (up && b.c < d.l) return { d: -1, ext: Math.max(d.h, b.h) }; return null; },
  marubozu: (B, i, A) => { const b = B[i]; if (rng(b) < 1.2 * A || body(b) < 0.9 * rng(b)) return null; return bull(b) ? { d: 1, ext: b.l } : { d: -1, ext: b.h }; },
  fakey: (B, i) => { const m = B[i - 2], x = B[i - 1], b = B[i]; if (!(x.h < m.h && x.l > m.l)) return null;
    if (b.l < x.l && b.c > x.l && b.c > b.o) return { d: 1, ext: b.l }; if (b.h > x.h && b.c < x.h && b.c < b.o) return { d: -1, ext: b.h }; return null; },
  flag: (B, i, A) => { // Impuls (>= 2 ATR in 3 Kerzen), danach 3-8 Kerzen Pause im oberen Teil, Schluss ueber der Pause
    for (let n = 3; n <= 8; n++) { const s = i - n, p = B.slice(s, i), i0 = s - 3; if (i0 < 1) break; const mv = B[s - 1].c - B[i0].o;
      const ph = Math.max(...p.map((x) => x.h)), pl = Math.min(...p.map((x) => x.l));
      if (mv >= 2 * A && pl >= B[i0].o + 0.5 * mv && B[i].c > ph) return { d: 1, ext: pl };
      if (mv <= -2 * A && ph <= B[i0].o + 0.5 * mv && B[i].c < pl) return { d: -1, ext: ph }; }
    return null; }
};
// Muster mit Swing-Punkten (Doppelboden/-top, Liquiditaets-Sweep) brauchen den Verlauf: eigener Zustand je Markt
function swingPatterns(B, A) { const L = 3, out = new Map(); let pls = [], phs = [];
  for (let i = 2 * L; i < B.length; i++) { const j = i - L, w = B.slice(j - L, i + 1);
    if (w.every((x) => x.l >= B[j].l)) pls.push({ i: j, v: B[j].l }); if (w.every((x) => x.h <= B[j].h)) phs.push({ i: j, v: B[j].h });
    pls = pls.slice(-6); phs = phs.slice(-6); const b = B[i], a = A[i - 1], res = [];
    // Sweep: Tief des letzten Swing-Tiefs unterschritten, Schluss wieder darueber (2B / Liquiditaet geholt)
    const lp = pls[pls.length - 1], hp = phs[phs.length - 1];
    if (lp && i - lp.i <= 60 && b.l < lp.v && b.c > lp.v && !lp.used) { lp.used = 1; res.push(['sweep', { d: 1, ext: b.l }]); }
    if (hp && i - hp.i <= 60 && b.h > hp.v && b.c < hp.v && !hp.used) { hp.used = 1; res.push(['sweep', { d: -1, ext: b.h }]); }
    // Doppelboden: zwei Swing-Tiefs mit hoechstens 0,15 ATR Abstand, mind. 5 Kerzen auseinander; Signal beim Schluss ueber der Nackenlinie
    if (pls.length >= 2) { const p1 = pls[pls.length - 2], p2 = pls[pls.length - 1]; if (!p2.db && p2.i - p1.i >= 5 && Math.abs(p1.v - p2.v) <= 0.15 * a) { const neck = Math.max(...B.slice(p1.i, p2.i + 1).map((x) => x.h)); if (b.c > neck && i - p2.i <= 30) { p2.db = 1; res.push(['double', { d: 1, ext: Math.min(p1.v, p2.v) }]); } } }
    if (phs.length >= 2) { const p1 = phs[phs.length - 2], p2 = phs[phs.length - 1]; if (!p2.db && p2.i - p1.i >= 5 && Math.abs(p1.v - p2.v) <= 0.15 * a) { const neck = Math.min(...B.slice(p1.i, p2.i + 1).map((x) => x.l)); if (b.c < neck && i - p2.i <= 30) { p2.db = 1; res.push(['double', { d: -1, ext: Math.max(p1.v, p2.v) }]); } } }
    if (res.length) out.set(i, res); }
  return out; }

const NAMES = { pin: 'Pin Bar / Hammer / Shooting Star', engulf: 'Engulfing', insideBreak: 'Inside-Bar-Ausbruch', outside: 'Outside Bar', star: 'Morning / Evening Star', soldiers: 'Drei Soldaten / Drei Krähen',
  tweezer: 'Tweezer Bottom / Top', piercing: 'Piercing Line / Dark Cloud', harami: 'Harami', doji: 'Doji-Wende', marubozu: 'Marubozu (Momentum)', fakey: 'Fakey (falscher Inside-Bar-Ausbruch)',
  flag: 'Flagge (Ausbruch nach Impuls)', sweep: 'Liquiditäts-Sweep (2B)', double: 'Doppelboden / Doppeltop' };
const FILTERS = ['alle', 'trend', 'zone', 'trend+zone'];
const st = (R) => { const n = R.length; if (!n) return { n: 0, mean: 0, t: 0, win: 0 }; const m = R.reduce((a, x) => a + x, 0) / n, sd = Math.sqrt(R.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, n - 1));
  return { n, mean: +m.toFixed(3), t: sd ? +(m / sd * Math.sqrt(n)).toFixed(2) : 0, win: +(R.filter((x) => x > 0).length / n).toFixed(3) }; };

const all = {}; Object.keys(NAMES).forEach((p) => { all[p] = {}; FILTERS.forEach((f) => { all[p][f] = { R: [], byM: {}, per: [[], [], []], long: [], short: [] }; }); });
const rand = { R: [] }; let seed = 99; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
for (const ins of INS) {
  const rows = await load(ins); const M = agg(rows, 15 * 60e3), H1 = agg(rows, 3600e3), H4 = agg(rows, 4 * 3600e3), A = atrOf(M);
  const T4 = htfTrend(H4, 3), Z = zones1h(H1), SW = swingPatterns(M, A), ses = SESS[ins.sess]; console.log(ins.k, M.length, 'Kerzen,', Z.length, 'Zonen');
  let ti = -1, zi = 0; const act = [];
  for (let i = 5; i < M.length - 17; i++) {
    const b = M[i], end = b.t + 15 * 60e3, mn = berlin(b.t); while (ti + 1 < T4.length && T4[ti + 1].end <= end) ti++;
    while (zi < Z.length && Z[zi].from <= end) { act.push(Z[zi]); zi++; }
    if (mn < ses[0] || mn >= ses[1] - 15) continue;
    const found = []; for (const p of Object.keys(PAT)) { const r = PAT[p](M, i, A[i - 1]); if (r) found.push([p, r]); } (SW.get(i) || []).forEach((x) => found.push(x));
    if (rnd() < 0.02) found.push(['_rand', { d: rnd() < 0.5 ? 1 : -1, ext: null }]);
    if (!found.length) continue;
    const trend = ti >= 0 ? T4[ti].tr : 0;
    for (const [p, r] of found) {
      const e = M[i + 1].o, a = A[i]; let stop = r.ext == null ? e - r.d * a : r.ext - r.d * 0.1 * a; if ((e - stop) * r.d < 0.5 * a) stop = e - r.d * 0.5 * a;
      const risk = (e - stop) * r.d; if (!(risk > ins.cost * 3) || risk > 4 * a) continue; const tgt = e + r.d * 2 * risk; let x = null;
      for (let j = i + 1; j <= i + 16; j++) { const c = M[j]; if (r.d > 0 ? c.l <= stop : c.h >= stop) { x = stop; break; } if (r.d > 0 ? c.h >= tgt : c.l <= tgt) { x = tgt; break; } }
      if (x == null) x = M[i + 16].c; const R = ((x - e) * r.d - ins.cost) / risk;
      if (p === '_rand') { rand.R.push(R); continue; }
      const inZone = act.some((z) => z.d === r.d && z.from <= end && z.to > b.t && b.l <= z.top && b.h >= z.bot), inTrend = trend === r.d;
      const y = new Date(b.t).getUTCFullYear(), per = y <= 2017 ? 0 : y <= 2021 ? 1 : 2;
      for (const f of FILTERS) { if ((f === 'trend' || f === 'trend+zone') && !inTrend) continue; if ((f === 'zone' || f === 'trend+zone') && !inZone) continue;
        const q = all[p][f]; q.R.push(R); (q.byM[ins.k] = q.byM[ins.k] || []).push(R); q.per[per].push(R); (r.d > 0 ? q.long : q.short).push(R); }
    }
    // abgelaufene Zonen aufraeumen
    if (i % 200 === 0) for (let k = act.length - 1; k >= 0; k--) if (act[k].to < b.t || b.t - act[k].from > 30 * 864e5) act.splice(k, 1);
  }
}
const out = { at: new Date().toISOString(), rule: '15 Min, Einstieg naechste Kerze, Stop hinter dem Muster (mind. 0,5 ATR), Ziel 2 R, max. 4 h, Haupthandelszeit, Spread als Kosten', zufall: st(rand.R), res: {}, passed: [] };
console.log('ZUFALL (gleiche Stop/Ziel-Regel, Richtung zufaellig)', JSON.stringify(out.zufall));
for (const p of Object.keys(NAMES)) { out.res[p] = { name: NAMES[p] };
  for (const f of FILTERS) { const q = all[p][f], s = st(q.R), mk = Object.entries(q.byM).map(([k, v]) => [k, st(v).mean]), pos = mk.filter(([, m]) => m > 0).length, per = q.per.map(st);
    const pass = s.n >= 200 && s.mean > 0 && s.t >= 3 && pos >= 5 && per.every((x) => x.n >= 30 && x.mean > 0);
    out.res[p][f] = { all: s, long: st(q.long), short: st(q.short), maerkte: Object.fromEntries(mk), plus: pos + '/' + mk.length, per: per.map((x) => x.mean), pass };
    if (pass) out.passed.push({ p, f, name: NAMES[p], all: s });
    console.log('PA', NAMES[p].slice(0, 30).padEnd(30), f.padEnd(10), JSON.stringify(s), '| Maerkte im Plus', pos + '/' + mk.length, '| Zeitraeume', per.map((x) => x.mean).join(' / '), '| long', st(q.long).mean, 'short', st(q.short).mean, pass ? 'BESTANDEN' : ''); } }
console.log('BESTANDEN:', out.passed.length ? out.passed.map((x) => x.name + ' [' + x.f + ']').join(', ') : 'keins');
writeFileSync(new URL('./backtest-pa.json', import.meta.url), JSON.stringify(out));
