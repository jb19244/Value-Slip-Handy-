// Rueckrechnung fuer Einzelaktien (Tageskerzen, Yahoo, mit Kosten, drei Zeitraeume).
// Fairer Test: nicht die heutigen Gewinner, sondern die Index-Mitglieder von 2010 (S&P 100, DAX 30), getestet ab 2010.
// So sind auch spaetere Verlierer dabei (General Electric, Intel, Citigroup, Commerzbank, Thyssenkrupp ...). Uebernommene Firmen fehlen (bei Yahoo geloescht).
//  Kurzfristig: RSI-2, IBS tief, Doppelsignal, drei Verlusttage, Ruecksetzer in starken Aktien, Ausbruch auf 52-Wochen-Hoch
//  Monatlich:   Momentum-Korb (die 5 staerksten der letzten 12 Monate, nur wenn der Index ueber dem 200-Tage-Schnitt liegt)
import { readFileSync, writeFileSync } from 'node:fs';
const html = readFileSync(new URL('../trade/index.html', import.meta.url), 'utf8');
const src = html.split('// BEGIN LOGIC')[1].split('// END LOGIC')[0];
const L = new Function(src + '; return { parseYahoo, rStats, rsi2DailySignals, ibsSignals, ibsExit, simDayTrade, dayOf, atrSeries, rsiSeries, smaAt, ibs };')();
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; TradeCheck/1.0)' };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function raw(sym) {
  for (const host of ['query1', 'query2', 'query1']) {
    try { const r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&period1=1167609600&period2=${Math.floor(Date.now() / 1000)}`, { headers: UA }); if (r.ok) return await r.json(); } catch (e) {}
    await wait(1500);
  }
  return null;
}
const chart = async (sym) => { const j = await raw(sym); return j ? L.parseYahoo(j).filter((x) => x.o > 0 && x.h >= x.l && x.c > 0) : []; };
const pick = (a) => a ? { n: a.n, mean: +a.mean.toFixed(4), win: +a.win.toFixed(3), sum: +a.sum.toFixed(2), lo: a.lo != null ? +a.lo.toFixed(4) : null } : { n: 0 };
const st = (arr) => pick(arr.length ? L.rStats(arr.map((t) => t.pct)) : null);
// Signale am selben Tag haengen zusammen: je Handelstag den Mittelwert bilden und die Sicherheit ueber die Tage rechnen
function byDay(trades) { const g = {}; trades.forEach((t) => { const d = L.dayOf(t.t); (g[d] = g[d] || []).push(t.pct); }); const m = Object.values(g).map((a) => a.reduce((x, y) => x + y, 0) / a.length); const s = L.rStats(m); return s ? { days: s.n, mean: +s.mean.toFixed(4), lo: +s.lo.toFixed(4), win: +s.win.toFixed(3) } : { days: 0 }; }
function byYear(trades) { const g = {}; trades.forEach((t) => { const y = L.dayOf(t.t).slice(0, 4); (g[y] = g[y] || []).push(t.pct); }); const o = {}; Object.keys(g).sort().forEach((y) => { o[y] = { n: g[y].length, mean: +(g[y].reduce((a, b) => a + b, 0) / g[y].length).toFixed(3), sum: +g[y].reduce((a, b) => a + b, 0).toFixed(1) }; }); return o; }
function evalSet(name, trades, extra) {
  trades = trades.filter((t) => t.pct != null && isFinite(t.pct)); extra = extra || {};
  const ts = trades.map((t) => t.t).sort((a, b) => a - b), cut = ts[Math.floor(ts.length * 0.75)] || 0, split = ts[Math.floor(ts.length * 0.375)] || 0;
  const tr = trades.filter((t) => t.t < split), te = trades.filter((t) => t.t >= split && t.t < cut), ho = trades.filter((t) => t.t >= cut);
  const o = Object.assign({ name, unit: '%', all: st(trades), train: st(tr), test: st(te), hold: st(ho), from: ts.length ? L.dayOf(ts[0]) : null, day: byDay(trades), years: byYear(trades) }, extra);
  const yk = Object.keys(o.years); o.yearsUp = yk.filter((y) => o.years[y].sum > 0).length; o.yearsN = yk.length;
  if (trades.length && trades[0].cost != null) o.cost2 = st(trades.map((t) => ({ pct: t.pct - t.cost })));
  const hasEx = trades.length && trades[0].ex != null && !extra.noEx;
  if (hasEx) { const ex = (a) => st(a.map((t) => ({ pct: t.ex }))); o.ex = { all: ex(trades), train: ex(tr), test: ex(te), hold: ex(ho) }; }
  if (trades.length) { const span = (ts[ts.length - 1] - ts[0]) / 86400e3 / 365.25; o.perYear = +(trades.length / Math.max(0.5, span)).toFixed(1); }
  o.passed = o.all.n >= 100 && o.hold.n >= 20 && o.all.lo > 0 && o.day.lo > 0 && [o.train, o.test, o.hold].every((x) => x.n && x.mean > 0) && (!hasEx || [o.ex.train, o.ex.test, o.ex.hold].every((x) => x.n && x.mean > 0));
  return o;
}

const US = ('AAPL ABT AEP ALL AMGN AMZN AXP BA BAC BAX BK BMY BRK-B C CAT CL CMCSA COF COP COST CSCO CVS CVX DD DIS DVN ETR EXC F FCX FDX GD GE GILD GOOGL GS HAL HD HON HPQ IBM INTC JNJ JPM KO LMT LOW MA MCD MDT MET MMM MO MRK MS MSFT NKE NOV NSC ORCL OXY PEP PFE PG PM QCOM RTX SLB SO T TGT TXN UNH UNP UPS USB V VZ WBA WFC WMB WMT XOM XRX MDLZ CPB RF BKR APA AA WY LLY EMR').split(' ');
const DE = ('ADS ALV BAS BAYN BEI BMW CBK MBG DB1 DBK DHL DTE EOAN FME FRE HEI HEN3 IFX SDF LHA MRK MUV2 RWE SZG SAP SIE TKA VOW3').split(' ').map((x) => x + '.DE');
const COST_ST = 0.15, START = Date.parse('2010-01-01');
const out = { at: new Date().toISOString(), from: '2010-01-01', sets: {}, basket: {}, uni: {} };
const D = {};
for (const s of [...US, ...DE, '^GSPC', '^GDAXI']) { D[s] = await chart(s); await wait(200); }
const have = (list) => list.filter((s) => D[s] && D[s].length > 2500);
out.uni = { us: have(US), de: have(DE), missing: [...US, ...DE].filter((s) => !(D[s] && D[s].length > 2500)) };
console.log('US', out.uni.us.length, 'DE', out.uni.de.length, 'fehlen', out.uni.missing.join(','));
const drift = (d1) => { let s = 0; for (let k = 1; k < d1.length; k++) s += d1[k].c / d1[k - 1].c - 1; return s / (d1.length - 1) * 100; };
const idxOfDay = (d1) => { const m = {}; d1.forEach((x, i) => { m[L.dayOf(x.t)] = i; }); return m; };
const sig = (d1, a, i) => ({ i, t: d1[i].t, dir: 1, atr: a[i] });
function run(s, sigs, opt, into) {
  const d1 = D[s], dr = drift(d1);
  sigs.forEach((g) => { const r = L.simDayTrade(g, d1, Object.assign({ entry: 'close', stopAtr: 3, costPct: COST_ST }, opt(g))); if (r.pct != null) into.push({ t: g.t, s, cost: COST_ST, pct: r.pct, days: r.days, ex: r.pct - dr * r.days }); });
}
// ---- Kurzfristige Signale je Region, Einstieg zum Schluss und zur naechsten Eroeffnung
for (const [reg, list, ix] of [['us', out.uni.us, '^GSPC'], ['de', out.uni.de, '^GDAXI']]) {
  const I = D[ix], ii = idxOfDay(I), mktUp = (t) => { const j = ii[L.dayOf(t)]; return j != null && j > 200 && I[j].c > L.smaAt(I, j, 200); };
  for (const ent of ['close', 'open']) {
    const T = { rsi2: [], deep: [], both: [], d3: [], leader: [], hoch52: [], hoch52m: [] };
    for (const s of list) {
      const d1 = D[s], a = L.atrSeries(d1), rs = L.rsiSeries(d1, 2);
      const sma5 = (k) => { let t = 0; for (let q = k - 4; q <= k; q++) t += d1[q].c; return d1[k].c > t / 5; };
      const S = { rsi2: [], deep: [], both: [], d3: [], leader: [], hoch52: [], hoch52m: [] };
      for (let i = 260; i < d1.length - 1; i++) {
        if (!a[i] || d1[i].t < START) continue; const up = d1[i].c > L.smaAt(d1, i, 200), ib = L.ibs(d1[i]), g = sig(d1, a, i);
        if (up && rs[i] < 10) S.rsi2.push(g);
        if (up && ib < 0.1) S.deep.push(g);
        if (up && ib < 0.2 && rs[i] < 10) S.both.push(g);
        if (up && d1[i].c < d1[i - 1].c && d1[i - 1].c < d1[i - 2].c && d1[i - 2].c < d1[i - 3].c) S.d3.push(g);
        // Ruecksetzer in einer starken Aktie: +20 % in 6 Monaten, ueber dem 200-Tage-Schnitt, RSI-2 unter 10
        if (up && rs[i] < 10 && d1[i].c / d1[i - 126].c > 1.2) S.leader.push(g);
        // Ausbruch: Schluss auf neuem 52-Wochen-Hoch (erstes Mal seit 20 Tagen)
        if (ent === 'close') { let hh = 0; for (let q = i - 252; q < i; q++) hh = Math.max(hh, d1[q].c); let recent = false; for (let q = i - 20; q < i; q++) { let h2 = 0; for (let z = q - 252; z < q; z++) h2 = Math.max(h2, d1[z].c); if (d1[q].c > h2) { recent = true; break; } }
          if (d1[i].c > hh && !recent) { S.hoch52.push(g); if (mktUp(d1[i].t)) S.hoch52m.push(g); } }
      }
      const mr = () => ({ entry: ent, maxDays: 10, exitFn: sma5 });
      run(s, S.rsi2, mr, T.rsi2); run(s, S.deep, () => ({ entry: ent, maxDays: 5, exitFn: L.ibsExit(d1) }), T.deep); run(s, S.both, () => ({ entry: ent, maxDays: 5, exitFn: L.ibsExit(d1) }), T.both); run(s, S.d3, () => ({ entry: ent, maxDays: 7, exitFn: sma5 }), T.d3); run(s, S.leader, mr, T.leader);
      // Ausbruch halten, bis ein Schluss unter dem 50-Tage-Schnitt liegt (max. 120 Tage), Notstop 3 ATR
      const below50 = (k) => d1[k].c < L.smaAt(d1, k, 50);
      if (ent === 'close') { run(s, S.hoch52, () => ({ entry: 'close', maxDays: 120, exitFn: below50 }), T.hoch52); run(s, S.hoch52m, () => ({ entry: 'close', maxDays: 120, exitFn: below50 }), T.hoch52m); }
    }
    const NM = { rsi2: 'RSI-2 unter 10', deep: 'IBS unter 0,1', both: 'IBS + RSI-2', d3: 'Drei Verlusttage', leader: 'Rücksetzer in starker Aktie (+20 % in 6 Monaten, RSI-2 unter 10)', hoch52: 'Ausbruch auf 52-Wochen-Hoch, halten über dem 50-Tage-Schnitt', hoch52m: 'Ausbruch auf 52-Wochen-Hoch, nur wenn der Index im Aufwärtstrend ist' };
    for (const k of Object.keys(T)) { if (!T[k].length) continue; const key = 'aktien:' + reg + ':' + k + ':' + ent;
      out.sets[key] = evalSet((reg === 'us' ? 'US-Aktien' : 'DAX-Aktien') + ': ' + NM[k] + (ent === 'open' ? ' (Kauf zur nächsten Eröffnung)' : ' (Kauf zum Schluss)'), T[k], { perStock: +(T[k].length / list.length / 16.8).toFixed(1) });
      out.sets[key].days = +(T[k].reduce((p, q) => p + q.days, 0) / T[k].length).toFixed(1); }
  }
}
// ---- Monatlicher Momentum-Korb
for (const [reg, list, ix] of [['us', out.uni.us, '^GSPC'], ['de', out.uni.de, '^GDAXI']]) {
  const I = D[ix], days = I.filter((x) => x.t >= Date.parse('2008-06-01')).map((x) => L.dayOf(x.t)), ii = idxOfDay(I);
  const P = {}; list.forEach((s) => { const m = idxOfDay(D[s]); let last = null; P[s] = days.map((d) => { if (m[d] != null) last = D[s][m[d]].c; return last; }); });
  const ends = []; for (let k = 0; k < days.length - 1; k++) if (days[k].slice(0, 7) !== days[k + 1].slice(0, 7)) ends.push(k);
  for (const [nm, N, filt, lb, cst] of [['mom5', 5, true, 252, COST_ST], ['mom10', 10, true, 252, COST_ST], ['mom5roh', 5, false, 252, COST_ST], ['mom8', 8, true, 252, COST_ST], ['mom12', 12, true, 252, COST_ST], ['mom10k6', 10, true, 126, COST_ST], ['mom8k6', 8, true, 126, COST_ST], ['mom10k9', 10, true, 189, COST_ST], ['mom10teuer', 10, true, 252, 0.4], ['mom10roh', 10, false, 252, COST_ST], ['mom8roh', 8, false, 252, COST_ST], ['mom12roh', 12, false, 252, COST_ST], ['mom10rohk6', 10, false, 126, COST_ST], ['mom10rohk9', 10, false, 189, COST_ST], ['mom5rohk6', 5, false, 126, COST_ST], ['mom10rohteuer', 10, false, 252, 0.5], ['mom5rohteuer', 5, false, 252, 0.5]]) {
    const rs = [], bs = [], ms = []; let prev = [];
    for (let e = 0; e < ends.length - 1; e++) { const t = ends[e], t2 = ends[e + 1]; if (t < 252 || days[t] < '2010-01-01') continue;
      const cand = list.filter((s) => P[s][t - 252] && P[s][t - 21] && P[s][t] && P[s][t2]).map((s) => ({ s, m: P[s][t - 21] / P[s][t - lb] - 1, r: P[s][t2] / P[s][t] - 1 }));
      if (cand.length < 15) continue; const bench = cand.reduce((p, q) => p + q.r, 0) / cand.length;
      const j = ii[days[t]], on = !filt || (I[j].c > L.smaAt(I, j, 200));
      const top = on ? cand.slice().sort((x, y) => y.m - x.m).slice(0, N) : [], names = top.map((x) => x.s), turn = names.filter((x) => !prev.includes(x)).length + prev.filter((x) => !names.includes(x)).length;
      const r = (top.length ? top.reduce((p, q) => p + q.r, 0) / top.length : 0) - turn / Math.max(1, 2 * N) * 2 * cst / 100; prev = names;
      rs.push(r); bs.push(bench); ms.push(days[t2].slice(0, 7)); }
    const perf = (a) => { if (!a.length) return null; let eq = 1, pk = 1, dd = 0; a.forEach((x) => { eq *= 1 + x; pk = Math.max(pk, eq); dd = Math.max(dd, 1 - eq / pk); }); const m = a.reduce((p, q) => p + q, 0) / a.length, sd = Math.sqrt(a.reduce((p, q) => p + (q - m) * (q - m), 0) / a.length);
      return { n: a.length, cagr: +((Math.pow(eq, 12 / a.length) - 1) * 100).toFixed(1), sharpe: sd ? +(m / sd * Math.sqrt(12)).toFixed(2) : null, maxDD: +(dd * 100).toFixed(0) }; };
    const th = Math.floor(rs.length / 3), parts = [[0, th], [th, 2 * th], [2 * th, rs.length]].map(([x, y]) => ({ s: perf(rs.slice(x, y)), b: perf(bs.slice(x, y)), from: ms[x], to: ms[y - 1] }));
    const o = { name: (reg === 'us' ? 'US-Aktien' : 'DAX-Aktien') + ': die ' + N + ' stärksten der letzten 12 Monate, monatlicher Tausch' + (filt ? ', nur wenn der Index über dem 200-Tage-Schnitt liegt' : ''), all: perf(rs), bh: perf(bs), parts };
    o.passed = !!(o.all && o.all.sharpe > o.bh.sharpe && o.all.cagr > o.bh.cagr && parts.every((p) => p.s && p.b && p.s.sharpe > p.b.sharpe));
    { const t = ends[ends.length - 1], c2 = list.filter((s) => P[s][t - lb] && P[s][t - 21] && P[s][t]).map((s) => ({ s, m: +((P[s][t - 21] / P[s][t - lb] - 1) * 100).toFixed(1) })).sort((x, y) => y.m - x.m); o.now = { day: days[t], top: c2.slice(0, N) }; }
    out.basket[reg + ':' + nm] = o;
    console.log((o.passed ? 'KORB OK ' : 'KORB -- ') + (reg + ':' + nm).padEnd(12), 'Strategie', JSON.stringify(o.all), '| alle gleich gewichtet', JSON.stringify(o.bh), '|', parts.map((p) => p.from + ' S ' + p.s.sharpe + '/' + p.b.sharpe + ' R ' + p.s.cagr + '/' + p.b.cagr).join(' | '));
  }
}
// ---- Aktueller Korb fuer die App: heutige DAX-Aktien, die 10 staerksten der letzten 12 Monate (ohne den letzten Monat)
{
  const DAX = { ADS: 'Adidas', AIR: 'Airbus', ALV: 'Allianz', BAS: 'BASF', BAYN: 'Bayer', BEI: 'Beiersdorf', BMW: 'BMW', BNR: 'Brenntag', CBK: 'Commerzbank', CON: 'Continental', DTG: 'Daimler Truck', DBK: 'Deutsche Bank', DB1: 'Deutsche Börse', DHL: 'DHL', DTE: 'Deutsche Telekom', EOAN: 'E.ON', FRE: 'Fresenius', FME: 'Fresenius Medical Care', G1A: 'GEA', G24: 'Scout24', HNR1: 'Hannover Rück', HEI: 'Heidelberg Materials', HEN3: 'Henkel', IFX: 'Infineon', MBG: 'Mercedes-Benz', MRK: 'Merck', MTX: 'MTU Aero Engines', MUV2: 'Munich Re', P911: 'Porsche AG', PAH3: 'Porsche Holding', QIA: 'Qiagen', RHM: 'Rheinmetall', RWE: 'RWE', SAP: 'SAP', SIE: 'Siemens', ENR: 'Siemens Energy', SHL: 'Siemens Healthineers', SY1: 'Symrise', VOW3: 'Volkswagen', VNA: 'Vonovia', ZAL: 'Zalando' };
  for (const k of Object.keys(DAX)) { const s = k + '.DE'; if (!D[s]) { D[s] = await chart(s); await wait(200); } }
  const I = D['^GDAXI'], days = I.slice(-400).map((x) => L.dayOf(x.t)), ends = []; for (let k = 0; k < days.length - 1; k++) if (days[k].slice(0, 7) !== days[k + 1].slice(0, 7)) ends.push(k);
  const rank = (t) => Object.keys(DAX).map((k) => { const d = D[k + '.DE']; if (!d || d.length < 260) return null; const m = idxOfDay(d); let j = m[days[t]]; for (let q = t; j == null && q > t - 5; q--) j = m[days[q]]; if (j == null || j < 252) return null; return { s: k, name: DAX[k], m: +((d[j - 21].c / d[j - 252].c - 1) * 100).toFixed(1), px: d[j].c }; }).filter(Boolean).sort((x, y) => y.m - x.m);
  const t1 = ends[ends.length - 1], t0 = ends[ends.length - 2], now = rank(t1), top = now.slice(0, 10), prev = rank(t0).slice(0, 10), b = out.basket['de:mom10roh'];
  out.korb = { key: 'de:mom10roh', day: days[t1], month: days[t1 + 1].slice(0, 7), n: now.length, top, in: top.filter((x) => !prev.some((y) => y.s === x.s)).map((x) => x.name), out: prev.filter((x) => !top.some((y) => y.s === x.s)).map((x) => x.name),
    passed: !!(b && b.passed && ['de:mom8roh', 'de:mom12roh', 'de:mom10rohk9', 'de:mom10rohteuer'].filter((k) => out.basket[k] && out.basket[k].passed).length >= 3), perf: b ? { s: b.all, b: b.bh, parts: b.parts } : null };
  console.log('KORB JETZT', out.korb.passed ? 'bestanden' : 'nicht bestanden', out.korb.day, top.map((x) => x.name + ' ' + x.m).join(', '), '| rein', out.korb.in.join(','), '| raus', out.korb.out.join(','), '| Aktien', now.length);
}
out.passed = Object.keys(out.sets).filter((k) => out.sets[k].passed);
Object.values(out.sets).forEach((x) => { delete x.years; });
writeFileSync(new URL('./backtest-stocks.json', import.meta.url), JSON.stringify(out));
for (const k of Object.keys(out.sets)) { const x = out.sets[k]; console.log((x.passed ? 'OK  ' : '--  ') + k.padEnd(28), 'n', String(x.all.n).padStart(6), 'win', x.all.win, 'mean', x.all.mean, '| tr', x.train.mean, 'te', x.test.mean, 'ho', x.hold.mean, '| dayLo', x.day.lo, '| ex', x.ex.train.mean, x.ex.test.mean, x.ex.hold.mean, '| cost2', x.cost2.mean, '| Tage', x.days, 'Jahre', x.yearsUp + '/' + x.yearsN); }
