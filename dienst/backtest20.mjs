// Daytrading ab 16:30 (deine Zeit): vier neue Ideen fuer S&P 500, Nasdaq 100 und Dow, 5-Min-Kerzen seit 2013 (Dukascopy).
// Zeiten in New York: 9:30 = 15:30 bei uns, 10:30 = 16:30, 15:30 = 21:30.
//  1) Schwung der ersten Stunde: Richtung bis 10:30 (ab gestrigem Schluss oder ab Eroeffnung), Einstieg 10:30, raus 15:55.
//  2) Letzte halbe Stunde (Gao u. a.): Richtung bis 10:00 sagt die letzte halbe Stunde 15:30-16:00 voraus.
//  3) Sweep im Tag: 10:30-11:30 unter das Vortagestief (ueber das Vortageshoch) und eine 5-Min-Kerze schliesst zurueck -> Gegenrichtung.
//  4) Rueckkehr zum Tagesdurchschnitt: weit unter dem Durchschnittspreis seit Eroeffnung, im Tagestrend -> zurueck zum Durchschnitt.
//  5) Termintage: an Tagen mit wichtigen US-Zahlen um 8:30 (14:30 bei uns) der Richtung bis 10:30 folgen oder dagegen.
// Kosten: Spread je Markt (doppelt als Stresstest). Vergleich: gleiche Ein-/Ausstiegszeiten mit zufaelliger Richtung.
// Bestanden nur mit: >= 300 Trades, Ø > 0, t >= 3, alle drei Zeitraeume im Plus, mind. 2 von 3 Maerkten im Plus, doppelte Kosten im Plus,
// besser als der Zufall, und ein Nachbar (eine Stellschraube anders) ebenfalls im Plus. Ergebnis: dienst/backtest-abend.json
import { writeFileSync } from 'node:fs';
import { INS, load, prep, sim, stats } from './backtest13.mjs';
const US = INS.filter((x) => x.sess === 'us');
const rangeOf = (d, a, z) => { const s = d.b.filter((x) => x.m >= a && x.m < z); if (s.length < (z - a) / 5 * 0.6) return null; return { hi: Math.max(...s.map((x) => x.h)), lo: Math.min(...s.map((x) => x.l)), o: s[0].o, c: s[s.length - 1].c }; };
const cAt = (d, m) => { const s = d.b.filter((x) => x.m < m && x.m >= m - 30); return s.length ? s[s.length - 1].c : null; };
// US-Termine um 8:30 New York (wichtig) aus dem TradingView-Kalender
const EV = new Set();
{ const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  for (let y = 2013; y <= new Date().getUTCFullYear(); y++) for (let q = 0; q < 12; q += 3) { const from = new Date(Date.UTC(y, q, 1)).toISOString(), to = new Date(Date.UTC(y, q + 3, 1)).toISOString(); if (Date.parse(from) > Date.now()) continue;
    for (let a = 0; a < 3; a++) { try { const r = await fetch('https://economic-calendar.tradingview.com/events?from=' + from + '&to=' + to + '&countries=US', { headers: { Origin: 'https://www.tradingview.com', 'User-Agent': 'Mozilla/5.0' } });
      if (r.ok) { const j = await r.json(); (j.result || []).filter((e) => e.importance === 1).forEach((e) => { const p = {}; fmt.formatToParts(new Date(Date.parse(e.date))).forEach((x) => { p[x.type] = x.value; }); if (+p.hour * 60 + +p.minute === 510) EV.add(p.year + '-' + p.month + '-' + p.day); }); break; } } catch (e) {} await new Promise((r) => setTimeout(r, 1500)); } }
  console.log('Termintage 8:30 NY:', EV.size); }

let seed = 7; const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const C = [];
for (const base of ['prev', 'open']) for (const k of [0, 0.3]) for (const st of ['range', 'atr']) C.push({ fam: 'schwung', id: `schwung_${base}_${k}_${st}`, base, k, st });
for (const base of ['prev', 'open']) C.push({ fam: 'gao', id: `gao_${base}`, base });
for (const tr of [0, 1]) for (const tg of [2, null]) C.push({ fam: 'sweep', id: `sweep_tr${tr}_${tg || 'zeit'}`, tr, tg });
for (const k of [0.3, 0.5]) for (const tr of [0, 1]) C.push({ fam: 'twap', id: `twap_${k}_tr${tr}`, k, tr });
for (const m of ['folgen', 'gegen']) C.push({ fam: 'termin', id: `termin_${m}`, m });
C.push({ fam: 'zufall', id: 'zufall' });

function trade(c, d, ins, cost) {
  const a = d.atr, pc = d.prev.close, trend = d.prev.close > d.sma20 ? 1 : -1;
  if (c.fam === 'schwung' || c.fam === 'termin' || c.fam === 'zufall') {
    if (c.fam === 'termin' && !EV.has(d.day)) return null;
    const r1 = rangeOf(d, 570, 630); if (!r1) return null; const mv = r1.c - (c.base === 'open' ? r1.o : pc);
    let dir = mv > 0 ? 1 : mv < 0 ? -1 : 0; if (c.fam === 'zufall') dir = rnd() < 0.5 ? 1 : -1; if (!dir || Math.abs(mv) < (c.k || 0) * a) return null; if (c.m === 'gegen') dir = -dir;
    const e0 = r1.c, stop = c.st === 'range' ? (dir > 0 ? r1.lo : r1.hi) : e0 - dir * 0.5 * a;
    return sim(d, { dir, kind: 'market', from: 630, stop, tgt: null, exitMin: 955, cost }); }
  if (c.fam === 'gao') { const r0 = rangeOf(d, 570, 600); if (!r0) return null; const mv = r0.c - (c.base === 'open' ? r0.o : pc), dir = mv > 0 ? 1 : mv < 0 ? -1 : 0; if (!dir) return null;
    const e0 = cAt(d, 930); if (e0 == null) return null; return sim(d, { dir, kind: 'market', from: 930, stop: e0 - dir * 0.5 * a, tgt: null, exitMin: 960, cost }); }
  if (c.fam === 'sweep') { const s = d.b.filter((x) => x.m >= 630 && x.m < 690); let lowSoFar = Math.min(...d.b.filter((x) => x.m >= 570 && x.m < 630).map((x) => x.l)), hiSoFar = Math.max(...d.b.filter((x) => x.m >= 570 && x.m < 630).map((x) => x.h));
    if (!isFinite(lowSoFar)) return null;
    for (const x of s) { lowSoFar = Math.min(lowSoFar, x.l); hiSoFar = Math.max(hiSoFar, x.h);
      let dir = 0; if (x.l < d.prev.lo && x.c > d.prev.lo) dir = 1; else if (x.h > d.prev.hi && x.c < d.prev.hi) dir = -1;
      if (!dir) continue; if (c.tr && dir !== trend) return null;
      const stop = dir > 0 ? lowSoFar - 0.05 * a : hiSoFar + 0.05 * a, risk = Math.abs(x.c - stop);
      return sim(d, { dir, kind: 'market', from: x.m + 5, stop, tgt: c.tg ? x.c + dir * c.tg * risk : null, exitMin: 955, cost }); }
    return null; }
  if (c.fam === 'twap') { let n = 0, sum = 0;
    for (const x of d.b) { if (x.m < 570) continue; if (x.m >= 780) break; sum += (x.h + x.l + x.c) / 3; n++; if (x.m < 630) continue;
      const tw = sum / n; let dir = 0; if (x.c < tw - c.k * a) dir = 1; else if (x.c > tw + c.k * a) dir = -1; if (!dir) continue; if (c.tr && dir !== trend) continue;
      return sim(d, { dir, kind: 'market', from: x.m + 5, stop: x.c - dir * c.k * a, tgt: tw, exitMin: 955, cost }); }
    return null; }
  return null;
}
const out = { at: new Date().toISOString(), termintage: EV.size, res: {}, passed: [] };
const T = {}; C.forEach((c) => { T[c.id] = { all: [], c2: [], byM: {}, per: [[], [], []] }; });
for (const ins of US) { const rows = await load(ins), D = prep(rows, ins); console.log(ins.k, D.length, 'Tage');
  for (const d of D) { const y = +d.day.slice(0, 4), p = y <= 2017 ? 0 : y <= 2021 ? 1 : 2;
    for (const c of C) { const a = trade(c, d, ins, ins.cost); if (!a || a.skip || a.r == null) continue; const b = trade(c, d, ins, ins.cost * 2);
      const q = T[c.id]; q.all.push(a.r); if (b && b.r != null) q.c2.push(b.r); (q.byM[ins.k] = q.byM[ins.k] || []).push(a.r); q.per[p].push(a.r); } } }
const rand = stats(T.zufall.all);
console.log('ZUFALL', JSON.stringify(rand));
for (const c of C) { if (c.fam === 'zufall') continue; const q = T[c.id], s = stats(q.all), c2 = stats(q.c2), per = q.per.map((x) => stats(x).mean || 0), mk = Object.entries(q.byM).map(([k, v]) => [k, stats(v).mean]), plus = mk.filter(([, m]) => m > 0).length;
  const base = s.n >= 300 && s.mean > 0 && s.t >= 3 && per.every((m) => m > 0) && plus >= 2 && c2.mean > 0 && s.mean > (rand.mean || 0);
  out.res[c.id] = { c, all: s, cost2: c2.mean, per, maerkte: Object.fromEntries(mk), ok: base }; }
// Nachbar-Pruefung: in derselben Familie mind. eine andere Variante mit Ø > 0
for (const id of Object.keys(out.res)) { const r = out.res[id]; const nb = Object.values(out.res).filter((x) => x.c.fam === r.c.fam && x.c.id !== id); r.pass = r.ok && nb.some((x) => x.all.mean > 0);
  if (r.pass) out.passed.push({ id, all: r.all });
  console.log('ABEND', id.padEnd(24), JSON.stringify(r.all), '| 2x Kosten', r.cost2, '| Zeitr.', r.per.join(' / '), '| Maerkte', JSON.stringify(r.maerkte), r.pass ? 'BESTANDEN' : ''); }
console.log('BESTANDEN:', out.passed.length ? out.passed.map((x) => x.id).join(', ') : 'keins');
writeFileSync(new URL('./backtest-abend.json', import.meta.url), JSON.stringify(out));
