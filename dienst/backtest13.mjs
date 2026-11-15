// Daytrading-Forschung mit 5-Minuten-Kerzen seit 2013 (Dukascopy, kostenlos): Regeln, die zu deinem Tag passen.
// Rahmen: Signale kommen per Push, du gibst die Order in 1-2 Minuten ein (gerechnet: Order erst 10 Minuten nach dem Signal aktiv;
// ist der Kurs dann schon durch, wird NICHT hinterhergekauft). Stop und Ziel stehen als Order im Markt. Zeit-Ausstiege per Push.
// Familien: Eroeffnungsspanne (DAX 9:00, London 9:00, New York 9:30 Ortszeit), Asien-Spanne zur London-Eroeffnung, Gap (Fade und Go),
// Noise-Band-Momentum fuer US-Indizes (Zarattini/Aziz/Barbon 2024), Intraday-Momentum letzte halbe Stunde (Gao/Han/Li/Zhou 2018).
// Bestanden nur, wenn ALLES gilt: mind. 200 Trades, alle drei Zeitraeume (2013-17, 2018-21, 2022-heute) im Plus, nach Handelstagen gebuendelt
// t-Wert >= 3 (viele Kandidaten), Haertetest (doppelte Kosten und 5 Minuten spaeter) im Plus, mind. 60 % der Jahre im Plus,
// Nachbar-Einstellungen ebenfalls im Plus. Probelauf auf Zufallskursen gleicher Schwankung: dort darf nichts bestehen.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
const DIR = process.env.DUKA_DIR || '/tmp/duka', FROM = 2013, NOWY = new Date().getUTCFullYear();
const INS = [
  { k: 'DAX', d: 'deuidxeur', tz: 'Europe/Berlin', name: 'DAX', cost: 1.2, sess: 'dax' },
  { k: 'NDX', d: 'usatechidxusd', tz: 'America/New_York', name: 'Nasdaq 100', cost: 2.0, sess: 'us' },
  { k: 'SPX', d: 'usa500idxusd', tz: 'America/New_York', name: 'S&P 500', cost: 0.6, sess: 'us' },
  { k: 'DJI', d: 'usa30idxusd', tz: 'America/New_York', name: 'Dow Jones', cost: 3.0, sess: 'us' },
  { k: 'XAUUSD', d: 'xauusd', tz: 'Europe/Berlin', name: 'Gold', cost: 0.35, sess: 'ldn' },
  { k: 'EURUSD', d: 'eurusd', tz: 'Europe/Berlin', name: 'EUR/USD', cost: 0.00012, sess: 'ldn' },
  { k: 'GBPUSD', d: 'gbpusd', tz: 'Europe/Berlin', name: 'GBP/USD', cost: 0.00018, sess: 'ldn' }
];
// ---------- Daten laden (Jahresdateien im Cache, laufendes Jahr immer frisch)
async function load(ins) {
  mkdirSync(DIR, { recursive: true }); const { getHistoricalRates } = await import('dukascopy-node'); const out = [];
  for (let y = FROM; y <= NOWY; y++) {
    const f = DIR + '/' + ins.d + '_' + y + '.json';
    if (!existsSync(f) || y === NOWY) {
      let d = null; for (let a = 0; a < 3 && !d; a++) { try { d = await getHistoricalRates({ instrument: ins.d, dates: { from: new Date(Date.UTC(y, 0, 1)), to: new Date(Math.min(Date.UTC(y + 1, 0, 1), Date.now())) }, timeframe: 'm5', format: 'array', batchSize: 25, pauseBetweenBatchesMs: 100 }); } catch (e) { console.log('Ladefehler', ins.d, y, e.message); } }
      if (d) writeFileSync(f, JSON.stringify(d.map((x) => [x[0], x[1], x[2], x[3], x[4]])));
    }
    if (existsSync(f)) out.push(...JSON.parse(readFileSync(f, 'utf8')));
  }
  return out.filter((x) => x[2] >= x[3] && x[1] > 0);
}
// ---------- Ortszeit je Kerze (Sommerzeit korrekt)
function localizer(tz) { const f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short' }), cache = new Map();
  return (ms) => { const hk = Math.floor(ms / 3600e3); let v = cache.get(hk); if (!v) { const p = {}; f.formatToParts(new Date(hk * 3600e3)).forEach((x) => { p[x.type] = x.value; }); v = { day: p.year + '-' + p.month + '-' + p.day, h: +p.hour, wd: p.weekday }; cache.set(hk, v); } return { day: v.day, min: v.h * 60 + new Date(ms).getUTCMinutes(), wd: v.wd }; }; }
// ---------- Tage aufbereiten
function prep(rows, ins) {
  const loc = localizer(ins.tz), days = [], byDay = new Map();
  for (const r of rows) { const l = loc(r[0]); if (l.wd === 'Sat' || l.wd === 'Sun') continue; let d = byDay.get(l.day); if (!d) { d = { day: l.day, b: [] }; byDay.set(l.day, d); days.push(d); } d.b.push({ t: r[0], m: l.min, o: r[1], h: r[2], l: r[3], c: r[4] }); }
  // Tageskennzahlen: Handelsspanne der Kernzeit fuer die ATR, Schluss der Kernzeit
  const core = ins.sess === 'us' ? [570, 960] : ins.sess === 'dax' ? [540, 1050] : [0, 1320];
  days.forEach((d) => { const cb = d.b.filter((x) => x.m >= core[0] && x.m < core[1]); d.ok = cb.length >= (ins.sess === 'ldn' ? 150 : 60); if (!d.ok) return; d.hi = Math.max(...cb.map((x) => x.h)); d.lo = Math.min(...cb.map((x) => x.l)); d.open = cb[0].o; d.close = cb[cb.length - 1].c; });
  const D = days.filter((d) => d.ok); for (let i = 0; i < D.length; i++) { const w = D.slice(Math.max(0, i - 14), i); D[i].atr = w.length >= 10 ? w.reduce((a, x) => a + x.hi - x.lo, 0) / w.length : null; const c20 = D.slice(Math.max(0, i - 20), i); D[i].sma20 = c20.length >= 20 ? c20.reduce((a, x) => a + x.close, 0) / 20 : null; D[i].prev = D[i - 1] || null; D[i].prev2 = D[i - 2] || null; }
  return D.filter((d) => d.atr && d.sma20 && d.prev);
}
// ---------- Trade simulieren (5-Min-Kerzen, vorsichtig: Stop vor Ziel in derselben Kerze, Fuellkerze nur gegen uns)
// e: { dir, kind: 'stop'|'market', px, from (Minute ab der die Order gilt), until (Verfall), stop, tgt (null = nur Zeit), exitMin, cost, delayBars }
function sim(d, e) {
  const b = d.b, n = b.length; let i = b.findIndex((x) => x.m >= e.from); if (i < 0) return null;
  let entry = null, k = i;
  if (e.kind === 'market') { if (b[i].m > e.from + 15) return null; entry = b[i].o; }
  else { // Kauf-/Verkaufsstopp: schon durch beim Aktivieren -> auslassen
    if ((b[i].o - e.px) * e.dir > 0) return { skip: 'zu spät' };
    for (; k < n && b[k].m < e.until; k++) { if (e.dir > 0 ? b[k].h >= e.px : b[k].l <= e.px) { entry = e.dir > 0 ? Math.max(e.px, b[k].o) : Math.min(e.px, b[k].o); break; } }
    if (entry == null) return null; }
  const risk = (entry - e.stop) * e.dir; if (!(risk > e.cost * 3) || risk > 3 * d.atr) return null;
  for (let j = k; j < n; j++) { const x = b[j];
    if (x.m >= e.exitMin) { const xp = (e.delayBars && b[j + e.delayBars - 1] ? b[j + e.delayBars - 1].c : x.o); return { r: ((xp - entry) * e.dir - e.cost) / risk, pct: ((xp - entry) * e.dir - e.cost) / entry * 100, how: 'Zeit' }; }
    if (e.dir > 0 ? x.l <= e.stop : x.h >= e.stop) { const xp = e.dir > 0 ? Math.min(e.stop, x.o) : Math.max(e.stop, x.o); return { r: ((xp - entry) * e.dir - e.cost) / risk, pct: ((xp - entry) * e.dir - e.cost) / entry * 100, how: 'Stop' }; }
    if (j > k && e.tgt != null && (e.dir > 0 ? x.h >= e.tgt : x.l <= e.tgt)) { const xp = e.dir > 0 ? Math.max(e.tgt, Math.min(x.o, x.h)) : Math.min(e.tgt, Math.max(x.o, x.l)); return { r: ((xp - entry) * e.dir - e.cost) / risk, pct: ((xp - entry) * e.dir - e.cost) / entry * 100, how: 'Ziel' }; } }
  const xp = b[n - 1].c; return { r: ((xp - entry) * e.dir - e.cost) / risk, pct: ((xp - entry) * e.dir - e.cost) / entry * 100, how: 'Ende' };
}
const range = (d, a, z) => { const s = d.b.filter((x) => x.m >= a && x.m < z); if (s.length < Math.max(2, (z - a) / 5 * 0.6)) return null; return { hi: Math.max(...s.map((x) => x.h)), lo: Math.min(...s.map((x) => x.l)), o: s[0].o, c: s[s.length - 1].c }; };
const firstAt = (d, m) => d.b.find((x) => x.m >= m && x.m < m + 15);
// Richtung: Trend (gestern ueber/unter 20-Tage-Schnitt), Gap (Eroeffnung ueber/unter gestrigem Schluss), Spanne (Kerze der Eroeffnungsspanne)
function dirOf(f, d, r, sess) { if (f === 'trend') return d.prev.close > d.sma20 ? 1 : -1; if (f === 'gap') { const g = sess - d.prev.close; return g > 0 ? 1 : g < 0 ? -1 : 0; } if (f === 'bar') return r.c > r.o ? 1 : r.c < r.o ? -1 : 0; return 0; }
// ---------- Kandidaten erzeugen
function cands(ins) {
  const C = [], S = ins.sess, open = S === 'us' ? 570 : 540, delay = 10;
  const exits = S === 'us' ? [[720, '12:00 NY'], [955, 'US-Schluss']] : S === 'dax' ? [[990, '16:30'], [1045, 'DAX-Schluss']] : [[990, '16:30'], [1310, '21:50']];
  for (const len of [15, 30, 60]) for (const f of ['trend', 'gap', 'bar']) for (const st of ['range', 'half']) for (const tg of [1, 1.5, 2, 3, null]) for (const [ex, exn] of exits)
    C.push({ fam: 'orb', id: ['orb', len, f, st, tg, ex].join('_'), name: 'Eröffnungsspanne ' + len + ' Min, ' + ({ trend: 'mit Trend', gap: 'mit Gap', bar: 'mit Spanne' })[f] + ', Stop ' + (st === 'range' ? 'andere Seite' : 'Mitte') + ', ' + (tg ? 'Ziel ' + tg + ' R' : 'ohne Ziel') + ', raus ' + exn, len, f, st, tg, ex, open, delay });
  if (S !== 'us') for (const f of ['trend', 'bar', 'gap']) for (const st of ['range', 'half']) for (const tg of [1, 1.5, 2, 3, null]) for (const [ex, exn] of exits)
    C.push({ fam: 'asia', id: ['asia', f, st, tg, ex].join('_'), name: 'Asien-Spanne zur London-Eröffnung, ' + ({ trend: 'mit Trend', gap: 'mit Gap', bar: 'mit Asien-Richtung' })[f] + ', Stop ' + (st === 'range' ? 'andere Seite' : 'Mitte') + ', ' + (tg ? 'Ziel ' + tg + ' R' : 'ohne Ziel') + ', raus ' + exn, f, st, tg, ex, delay });
  if (S !== 'ldn') for (const g of [0.3, 0.5, 0.8]) for (const mode of ['fade', 'go']) for (const [ex, exn] of exits)
    C.push({ fam: 'gap', id: ['gap', g, mode, ex].join('_'), name: 'Gap ab ' + String(g).replace('.', ',') + ' ATR, ' + (mode === 'fade' ? 'gegen das Gap (Ziel Vortagesschluss)' : 'mit dem Gap (Ziel 2 R)') + ', raus ' + exn, g, mode, ex, open, delay });
  if (S === 'us') { for (const mult of [1, 1.5]) for (const step of [30, 60]) C.push({ fam: 'noise', id: ['noise', mult, step].join('_'), name: 'Noise-Band-Momentum (Zarattini 2024), Band ' + String(mult).replace('.', ',') + 'x, Prüfung alle ' + step + ' Min', mult, step });
    C.push({ fam: 'mom', id: 'mom_first', name: 'Intraday-Momentum (Gao 2018): Richtung bis 10:00 NY, letzte halbe Stunde handeln', v: 'first' }); C.push({ fam: 'mom', id: 'mom_late', name: 'Intraday-Momentum: Richtung 9:30 bis 15:00 NY, letzte halbe Stunde handeln', v: 'late' }); }
  return C;
}
// ---------- eine Regel auf einen Tag anwenden
function apply(c, d, ins, D, di, stress) {
  const cost = ins.cost * (stress ? 2 : 1), dl = (stress ? 5 : 0);
  if (c.fam === 'orb' || c.fam === 'asia') {
    const r = c.fam === 'orb' ? range(d, c.open, c.open + c.len) : range(d, 60, 540); if (!r) return null;
    const sOpen = c.fam === 'orb' ? (firstAt(d, c.open) || {}).o : (firstAt(d, 540) || {}).o; if (!sOpen) return null;
    const dir = dirOf(c.f, d, r, c.fam === 'orb' ? sOpen : (firstAt(d, 60) || {}).o || sOpen); if (!dir) return null;
    const buf = d.atr * 0.03, px = dir > 0 ? r.hi + buf : r.lo - buf, stop = c.st === 'range' ? (dir > 0 ? r.lo - buf : r.hi + buf) : (r.hi + r.lo) / 2;
    const risk = Math.abs(px - stop), from = (c.fam === 'orb' ? c.open + c.len : 540) + c.delay + dl;
    return sim(d, { dir, kind: 'stop', px, from, until: c.fam === 'orb' ? Math.min(c.ex, from + 180) : 720, stop, tgt: c.tg ? px + dir * c.tg * risk : null, exitMin: c.ex, cost, delayBars: 1 + (stress ? 1 : 0) });
  }
  if (c.fam === 'gap') {
    const o = firstAt(d, c.open); if (!o) return null; const g = o.o - d.prev.close; if (Math.abs(g) < c.g * d.atr) return null;
    const dir = c.mode === 'fade' ? -Math.sign(g) : Math.sign(g), e = firstAt(d, c.open + c.delay + dl); if (!e) return null;
    const stop = e.o - dir * Math.abs(g), risk = Math.abs(e.o - stop), tgt = c.mode === 'fade' ? d.prev.close : e.o + dir * 2 * risk;
    if ((tgt - e.o) * dir <= 0) return null;
    return sim(d, { dir, kind: 'market', from: c.open + c.delay + dl, stop, tgt, exitMin: c.ex, cost, delayBars: 1 + (stress ? 1 : 0) });
  }
  if (c.fam === 'noise') { // Band um den Eroeffnungskurs: Ø Abstand vom Eroeffnungskurs zur selben Uhrzeit der letzten 14 Tage
    const o = firstAt(d, 570); if (!o || di < 15) return null; const op = o.o, up0 = Math.max(op, d.prev.close), dn0 = Math.min(op, d.prev.close);
    const sig = (m) => { let s = 0, k = 0; for (let q = di - 14; q < di; q++) { const dd = D[q], x = dd.b.find((z) => z.m >= m && z.m < m + 5), oo = firstAt(dd, 570); if (x && oo) { s += Math.abs(x.c / oo.o - 1); k++; } } return k >= 10 ? s / k * c.mult : null; };
    let pos = 0, entry = 0, res = 0, n = 0, tot = 0;
    for (let m = 600; m <= 930; m += c.step) { const x = d.b.find((z) => z.m >= m - 5 && z.m < m), sg = sig(m - 5); if (!x || sg == null) continue; const px = x.c, up = up0 * (1 + sg), dn = dn0 * (1 - sg);
      const want = px > up ? 1 : px < dn ? -1 : 0;
      if (pos && want !== pos) { tot += ((px - entry) * pos - cost) / entry * 100; pos = 0; n++; }
      if (want && !pos) { pos = want; entry = px; } }
    if (pos) { const l = d.b.filter((z) => z.m < 960).pop(); if (l) { tot += ((l.c - entry) * pos - cost) / entry * 100; n++; } }
    return n ? { pct: tot, r: null, how: 'Band' } : null;
  }
  if (c.fam === 'mom') { const a = c.v === 'first' ? d.prev.close : (firstAt(d, 570) || {}).o, bm = c.v === 'first' ? d.b.find((z) => z.m >= 595 && z.m < 600) : d.b.find((z) => z.m >= 895 && z.m < 900);
    const e = d.b.find((z) => z.m >= 930 + dl && z.m < 935 + dl), x = d.b.filter((z) => z.m < 960).pop(); if (!a || !bm || !e || !x) return null; const dir = Math.sign(bm.c - a); if (!dir) return null;
    return { pct: ((x.c - e.o) * dir - cost) / e.o * 100, r: null, how: 'Zeit' }; }
  return null;
}
// ---------- Statistik
function stats(arr) { const n = arr.length; if (!n) return { n: 0 }; const m = arr.reduce((a, x) => a + x, 0) / n, sd = Math.sqrt(arr.reduce((a, x) => a + (x - m) * (x - m), 0) / Math.max(1, n - 1)); return { n, mean: +m.toFixed(4), win: +(arr.filter((x) => x > 0).length / n).toFixed(3), t: sd ? +(m / (sd / Math.sqrt(n))).toFixed(2) : 0 }; }
function evaluate(c, ins, D) {
  const tr = [], trS = [];
  D.forEach((d, i) => { const a = apply(c, d, ins, D, i, false); if (a && !a.skip && (a.r != null || a.pct != null)) tr.push({ day: d.day, v: a.r != null ? a.r : a.pct }); const s = apply(c, d, ins, D, i, true); if (s && !s.skip && (s.r != null || s.pct != null)) trS.push(s.r != null ? s.r : s.pct); });
  const v = tr.map((x) => x.v), per = (a, z) => stats(tr.filter((x) => x.day >= a && x.day < z).map((x) => x.v));
  const years = {}; tr.forEach((x) => { const y = x.day.slice(0, 4); years[y] = (years[y] || 0) + x.v; }); const yk = Object.keys(years);
  const o = { all: stats(v), p1: per('2013', '2018'), p2: per('2018', '2022'), p3: per('2022', '2100'), stress: stats(trS), yearsUp: yk.filter((y) => years[y] > 0).length, yearsN: yk.length, unit: c.fam === 'noise' || c.fam === 'mom' ? '%' : 'R', perYear: +(tr.length / Math.max(1, yk.length)).toFixed(1) };
  o.core = o.all.n >= 200 && o.all.t >= 3 && [o.p1, o.p2, o.p3].every((p) => p.n >= 30 && p.mean > 0) && o.stress.mean > 0 && o.yearsUp >= 0.6 * o.yearsN;
  return o;
}
// Nachbarn: eine Einstellung eine Stufe weiter
function neighbors(c, C) { const keys = ['len', 'f', 'st', 'tg', 'ex', 'g', 'mode', 'mult', 'step']; return C.filter((x) => x.fam === c.fam && x.id !== c.id && keys.filter((k) => x[k] !== c[k]).length === 1 && ['len', 'tg', 'g', 'mult', 'step', 'ex'].some((k) => x[k] !== c[k])); }
// ---------- Zufallskurse gleicher Schwankung (Probelauf): Renditen der echten Kerzen je Tag zufaellig vertauscht
function placeboRows(rows) { let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }; const out = []; let px = rows[0][4];
  const rets = rows.map((r, i) => i ? [r[1] / rows[i - 1][4], r[2] / r[1], r[3] / r[1], r[4] / r[1]] : [1, r[2] / r[1], r[3] / r[1], r[4] / r[1]]);
  for (let i = rows.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [rets[i], rets[j]] = [rets[j], rets[i]]; }
  rows.forEach((r, i) => { const q = rets[i], o = px * q[0]; out.push([r[0], o, o * q[1], o * q[2], o * q[3]]); px = o * q[3]; }); return out; }
// ---------- Lauf
const out = { at: new Date().toISOString(), data: {}, tested: 0, passed: [], top: [], placebo: { tested: 0, core: 0, passed: 0 } };
for (const ins of INS) {
  const rows = await load(ins); if (rows.length < 50000) { console.log('zu wenig Daten', ins.k, rows.length); continue; }
  const D = prep(rows, ins); out.data[ins.k] = { from: D[0].day, to: D[D.length - 1].day, days: D.length, bars: rows.length };
  console.log('Daten', ins.k, out.data[ins.k]);
  const C = cands(ins), R = new Map(); out.tested += C.length;
  for (const c of C) R.set(c.id, evaluate(c, ins, D));
  for (const c of C) { const o = R.get(c.id); if (!o.core) continue; const nb = neighbors(c, C).map((x) => R.get(x.id)); const robust = nb.length >= 2 && nb.every((x) => x.all.n >= 100 && x.all.mean > 0);
    const e = { k: ins.k, ins: ins.name, id: c.id, fam: c.fam, name: c.name, rule: c, unit: o.unit, all: o.all, p: [o.p1, o.p2, o.p3].map((p) => p.mean), stress: o.stress.mean, years: o.yearsUp + '/' + o.yearsN, perYear: o.perYear, robust };
    if (robust) out.passed.push(e); out.top.push(e); }
  // Probelauf: dieselben Regeln auf vertauschten Kursen
  const DP = prep(placeboRows(rows), ins); for (const c of C) { const o = evaluate(c, ins, DP); out.placebo.tested++; if (o.core) { out.placebo.core++; const nb = neighbors(c, C).map((x) => evaluate(x, ins, DP)); if (nb.length >= 2 && nb.every((x) => x.all.n >= 100 && x.all.mean > 0)) out.placebo.passed++; } }
  console.log(ins.k, 'Kandidaten', C.length, 'streng', out.top.filter((x) => x.k === ins.k).length, 'bestanden', out.passed.filter((x) => x.k === ins.k).length, '| Placebo bisher streng', out.placebo.core, 'bestanden', out.placebo.passed);
}
out.passed.sort((a, b) => b.all.t - a.all.t); out.top.sort((a, b) => b.all.t - a.all.t); out.top = out.top.slice(0, 40);
writeFileSync(new URL('./backtest-daytrade.json', import.meta.url), JSON.stringify(out));
console.log('GESAMT getestet', out.tested, 'bestanden', out.passed.length, '| Placebo', JSON.stringify(out.placebo));
out.passed.slice(0, 30).forEach((e) => console.log('OK ', e.k.padEnd(7), e.name.padEnd(95).slice(0, 95), 'n', e.all.n, 'win', e.all.win, 'Ø', e.all.mean, e.unit, 't', e.all.t, 'Zeitraeume', e.p.join(' / '), 'Haerte', e.stress, 'Jahre', e.years, 'pro Jahr', e.perYear));
