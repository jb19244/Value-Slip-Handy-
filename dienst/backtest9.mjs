// Rueckrechnung weiterer belegter Strategien auf Tageskerzen (Yahoo, mit Kosten, drei Zeitraeume) und Haertepruefung der laufenden:
//  Kalender: Turnaround Tuesday, Pre-FOMC-Drift (Lucca/Moench 2015), Anleihen zum Monatsende, Verfallswoche, Tag vor Feiertagen
//  Muster:   Connors Double 7, drei Verlusttage, VIX-Dehnung, Oops-Gap (Larry Williams), IBS und RSI-2 zusammen, Short-Seite
//  Trend:    Bitcoin/Ether Donchian-Ausbruch
//  Pruefung: IBS (US) und RSI-2 (Breite) noch einmal, diesmal nach Handelstagen gebuendelt (Signale am selben Tag sind nicht unabhaengig)
//            und Jahr fuer Jahr.
// Bestanden: mind. 100 Trades, alle drei Zeitraeume im Plus, sicher ueber null auch nach Tagen gebuendelt, Long-Strategien besser als einfach investiert.
import { readFileSync, writeFileSync } from 'node:fs';
const html = readFileSync(new URL('../trade/index.html', import.meta.url), 'utf8');
const src = html.split('// BEGIN LOGIC')[1].split('// END LOGIC')[0];
const L = new Function(src + '; return { parseYahoo, rStats, rsi2DailySignals, ibsSignals, ibsExit, simDayTrade, dayOf, atrSeries, rsiSeries, smaAt, ibs };')();
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; TradeCheck/1.0)' };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
async function raw(sym) {
  for (const host of ['query1', 'query2', 'query1']) {
    try { const r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&period1=946684800&period2=${Math.floor(Date.now() / 1000)}`, { headers: UA }); if (r.ok) return await r.json(); } catch (e) {}
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
const out = { at: new Date().toISOString(), sets: {}, audit: {} };
const US_IDX = ['^GSPC', '^NDX', '^DJI', '^RUT'];
const US_SYMS = ['^GSPC', '^NDX', '^DJI', '^RUT', 'XLK', 'XLF', 'XLE', 'XLV', 'XLY', 'XLP', 'XLI', 'XLB', 'XLU', 'IWM', 'DIA', 'SMH', 'XBI', 'KRE', 'ITB'];
const GAP_ETF = ['SPY', 'QQQ', 'IWM', 'DIA', 'XLK', 'XLF', 'XLE', 'XLV', 'XLY', 'XLI', 'SMH'];
const OTHER = ['^GDAXI', '^STOXX50E', 'TLT', 'IEF', 'GLD', '^VIX', 'BTC-USD', 'ETH-USD'];
const COST = 0.07, COST_ETF = 0.08, COST_BOND = 0.10, COST_CRYPTO = 1.0;
const D = {};
for (const s of [...new Set([...US_SYMS, ...GAP_ETF, ...OTHER])]) { D[s] = await chart(s); await wait(250); console.log(s, D[s].length); }
const drift = (d1) => { let s = 0; for (let k = 1; k < d1.length; k++) s += d1[k].c / d1[k - 1].c - 1; return s / (d1.length - 1) * 100; };
const wd = (t) => new Date(t + 3 * 3600e3).getUTCDay();
const idxOfDay = (d1) => { const m = {}; d1.forEach((x, i) => { m[L.dayOf(x.t)] = i; }); return m; };
function run(s, sigs, opt, cost, into) {
  const d1 = D[s], dr = drift(d1);
  sigs.forEach((g) => { const r = L.simDayTrade(g, d1, Object.assign({ entry: 'close', stopAtr: 3, costPct: cost }, opt(g))); if (r.pct != null) into.push({ t: g.t, s, cost, pct: r.pct, days: r.days, ex: r.pct - (g.dir < 0 ? 0 : dr * r.days) }); });
}
const sig = (d1, a, i, dir) => ({ i, t: d1[i].t, dir: dir || 1, atr: a[i] });

// ---- 1) Turnaround Tuesday: Montag schwaecher als Freitag -> Kauf zum Montagsschluss
{
  const basic = [], trend = [], ibsF = [], hold = [], extra = [], holdUS = [];
  for (const s of US_IDX.concat(['^GDAXI'])) {
    const d1 = D[s]; if (!d1 || d1.length < 400) continue; const a = L.atrSeries(d1);
    const mon = []; for (let i = 200; i < d1.length - 1; i++) if (wd(d1[i].t) === 1 && d1[i].c < d1[i - 1].c && a[i]) mon.push(i);
    run(s, mon.map((i) => sig(d1, a, i)), () => ({ maxDays: 1 }), COST, basic);
    run(s, mon.filter((i) => d1[i].c > L.smaAt(d1, i, 200)).map((i) => sig(d1, a, i)), () => ({ maxDays: 1 }), COST, trend);
    run(s, mon.filter((i) => L.ibs(d1[i]) < 0.3).map((i) => sig(d1, a, i)), () => ({ maxDays: 1 }), COST, ibsF);
    run(s, mon.filter((i) => L.ibs(d1[i]) < 0.3).map((i) => sig(d1, a, i)), () => ({ maxDays: 4, exitFn: (k) => d1[k].c > d1[k - 1].h }), COST, hold);
    // ohne die Tage, an denen ohnehin das IBS-Signal kommt (Aufwaertstrend und IBS unter 0,2): was bringt die Regel zusaetzlich?
    run(s, mon.filter((i) => L.ibs(d1[i]) < 0.3 && !(d1[i].c > L.smaAt(d1, i, 200) && L.ibs(d1[i]) < 0.2)).map((i) => sig(d1, a, i)), () => ({ maxDays: 4, exitFn: (k) => d1[k].c > d1[k - 1].h }), COST, extra);
    if (s !== '^GDAXI') run(s, mon.filter((i) => L.ibs(d1[i]) < 0.3).map((i) => sig(d1, a, i)), () => ({ maxDays: 4, exitFn: (k) => d1[k].c > d1[k - 1].h }), COST, holdUS);
  }
  out.sets['tt:basic'] = evalSet('Turnaround Tuesday: schwacher Montag, Verkauf Dienstag (5 Indizes)', basic);
  out.sets['tt:trend'] = evalSet('Turnaround Tuesday nur im Aufwärtstrend', trend);
  out.sets['tt:ibs'] = evalSet('Turnaround Tuesday, Montag schließt im unteren Drittel', ibsF);
  out.sets['tt:hold'] = evalSet('Turnaround Tuesday, halten bis Schluss über Vortageshoch (max. 4 Tage)', hold);
  out.sets['tt:hold_us'] = evalSet('Turnaround Tuesday (halten), nur die 4 US-Indizes', holdUS);
  out.sets['tt:hold_extra'] = evalSet('Turnaround Tuesday (halten), nur Tage ohne IBS-Signal', extra);
  { const g = {}; hold.forEach((t) => { (g[t.s] = g[t.s] || []).push(t); }); out.sets['tt:hold'].bySym = Object.fromEntries(Object.keys(g).map((k) => [k, st(g[k])])); }
}
// ---- 2) Pre-FOMC-Drift: Kauf zum Schluss am Tag vor dem Zinsentscheid, Verkauf zum Schluss am Entscheidungstag
const FOMC = ('2000-02-02 2000-03-21 2000-05-16 2000-06-28 2000-08-22 2000-10-03 2000-11-15 2000-12-19 2001-01-31 2001-03-20 2001-05-15 2001-06-27 2001-08-21 2001-10-02 2001-11-06 2001-12-11 ' +
  '2002-01-30 2002-03-19 2002-05-07 2002-06-26 2002-08-13 2002-09-24 2002-11-06 2002-12-10 2003-01-29 2003-03-18 2003-05-06 2003-06-25 2003-08-12 2003-09-16 2003-10-28 2003-12-09 ' +
  '2004-01-28 2004-03-16 2004-05-04 2004-06-30 2004-08-10 2004-09-21 2004-11-10 2004-12-14 2005-02-02 2005-03-22 2005-05-03 2005-06-30 2005-08-09 2005-09-20 2005-11-01 2005-12-13 ' +
  '2006-01-31 2006-03-28 2006-05-10 2006-06-29 2006-08-08 2006-09-20 2006-10-25 2006-12-12 2007-01-31 2007-03-21 2007-05-09 2007-06-28 2007-08-07 2007-09-18 2007-10-31 2007-12-11 ' +
  '2008-01-30 2008-03-18 2008-04-30 2008-06-25 2008-08-05 2008-09-16 2008-10-29 2008-12-16 2009-01-28 2009-03-18 2009-04-29 2009-06-24 2009-08-12 2009-09-23 2009-11-04 2009-12-16 ' +
  '2010-01-27 2010-03-16 2010-04-28 2010-06-23 2010-08-10 2010-09-21 2010-11-03 2010-12-14 2011-01-26 2011-03-15 2011-04-27 2011-06-22 2011-08-09 2011-09-21 2011-11-02 2011-12-13 ' +
  '2012-01-25 2012-03-13 2012-04-25 2012-06-20 2012-08-01 2012-09-13 2012-10-24 2012-12-12 2013-01-30 2013-03-20 2013-05-01 2013-06-19 2013-07-31 2013-09-18 2013-10-30 2013-12-18 ' +
  '2014-01-29 2014-03-19 2014-04-30 2014-06-18 2014-07-30 2014-09-17 2014-10-29 2014-12-17 2015-01-28 2015-03-18 2015-04-29 2015-06-17 2015-07-29 2015-09-17 2015-10-28 2015-12-16 ' +
  '2016-01-27 2016-03-16 2016-04-27 2016-06-15 2016-07-27 2016-09-21 2016-11-02 2016-12-14 2017-02-01 2017-03-15 2017-05-03 2017-06-14 2017-07-26 2017-09-20 2017-11-01 2017-12-13 ' +
  '2018-01-31 2018-03-21 2018-05-02 2018-06-13 2018-08-01 2018-09-26 2018-11-08 2018-12-19 2019-01-30 2019-03-20 2019-05-01 2019-06-19 2019-07-31 2019-09-18 2019-10-30 2019-12-11 ' +
  '2020-01-29 2020-04-29 2020-06-10 2020-07-29 2020-09-16 2020-11-05 2020-12-16 2021-01-27 2021-03-17 2021-04-28 2021-06-16 2021-07-28 2021-09-22 2021-11-03 2021-12-15 ' +
  '2022-01-26 2022-03-16 2022-05-04 2022-06-15 2022-07-27 2022-09-21 2022-11-02 2022-12-14 2023-02-01 2023-03-22 2023-05-03 2023-06-14 2023-07-26 2023-09-20 2023-11-01 2023-12-13 ' +
  '2024-01-31 2024-03-20 2024-05-01 2024-06-12 2024-07-31 2024-09-18 2024-11-07 2024-12-18 2025-01-29 2025-03-19 2025-05-07 2025-06-18 2025-07-30 2025-09-17 2025-10-29 2025-12-10 ' +
  '2026-01-28 2026-03-18 2026-04-29 2026-06-17 2026-07-29 2026-09-16 2026-10-28').split(' ');
{
  const spx = [], all = [];
  for (const s of ['^GSPC', '^NDX', '^DJI']) {
    const d1 = D[s]; if (!d1 || d1.length < 400) continue; const a = L.atrSeries(d1), ix = idxOfDay(d1);
    const sg = FOMC.map((d) => ix[d]).filter((j) => j != null && j > 20 && a[j - 1]).map((j) => sig(d1, a, j - 1));
    run(s, sg, () => ({ maxDays: 1 }), COST, all); if (s === '^GSPC') run(s, sg, () => ({ maxDays: 1 }), COST, spx);
  }
  out.sets['fomc:spx'] = evalSet('Pre-FOMC-Drift: S&P 500 vom Vortag bis zum Schluss am Zinsentscheid', spx);
  out.sets['fomc:us3'] = evalSet('Pre-FOMC-Drift auf S&P 500, Nasdaq 100 und Dow', all);
  out.sets['fomc:spx'].since2016 = st(spx.filter((x) => x.t >= Date.parse('2016-01-01')));
}
// ---- 3) Lange US-Anleihen zum Monatsende (Monatsend-Kaeufe grosser Fonds)
{
  for (const [key, s, n] of [['eom:tlt5', 'TLT', 5], ['eom:tlt7', 'TLT', 7], ['eom:ief5', 'IEF', 5]]) {
    const d1 = D[s], T = []; if (!d1 || d1.length < 400) continue; const a = L.atrSeries(d1), sg = [];
    for (let i = 30; i < d1.length - 1; i++) if (L.dayOf(d1[i].t).slice(0, 7) !== L.dayOf(d1[i + 1].t).slice(0, 7) && a[i - n]) sg.push(sig(d1, a, i - n));
    run(s, sg, () => ({ maxDays: n, stopAtr: 4 }), COST_BOND, T);
    out.sets[key] = evalSet((s === 'TLT' ? 'US-Anleihen 20+ Jahre' : 'US-Anleihen 7–10 Jahre') + ': die letzten ' + n + ' Handelstage im Monat', T);
  }
}
// ---- 4) Verfallswoche (dritter Freitag): Kauf zum Schluss vor der Woche, Verkauf zum Schluss am Verfallstag
{
  const T = [];
  for (const s of ['^GSPC', '^NDX']) {
    const d1 = D[s]; if (!d1) continue; const a = L.atrSeries(d1), sg = [];
    for (let i = 210; i < d1.length; i++) { const dt = new Date(d1[i].t + 3 * 3600e3); if (dt.getUTCDay() === 5 && dt.getUTCDate() >= 15 && dt.getUTCDate() <= 21) { let j = i; while (j > 0 && wd(d1[j].t) !== 1 && i - j < 5) j--; if (wd(d1[j].t) === 1 && a[j - 1]) sg.push(Object.assign(sig(d1, a, j - 1), { end: i })); } }
    run(s, sg, (g) => ({ maxDays: 6, exitFn: (k) => k >= g.end }), COST, T);
  }
  out.sets['opex:week'] = evalSet('Verfallswoche: S&P 500 und Nasdaq 100 von Freitag bis zum dritten Freitag', T);
}
// ---- 5) Tag vor einem US-Feiertag
{
  const T = [];
  for (const s of US_IDX) {
    const d1 = D[s]; if (!d1) continue; const a = L.atrSeries(d1), sg = [];
    for (let i = 210; i < d1.length - 1; i++) { let hol = 0; for (let t = d1[i].t + 86400e3; L.dayOf(t) < L.dayOf(d1[i + 1].t); t += 86400e3) { const w = wd(t); if (w >= 1 && w <= 5) hol++; } if (hol === 1 && a[i - 1]) sg.push(sig(d1, a, i - 1)); }
    run(s, sg, () => ({ maxDays: 1 }), COST, T);
  }
  out.sets['holiday:pre'] = evalSet('Tag vor einem US-Feiertag (4 US-Indizes)', T);
}
// ---- 6) Muster im Aufwaertstrend auf den 19 US-Maerkten: Double 7, drei Verlusttage, IBS und RSI-2 zusammen, dazu die Short-Seite
{
  const d7 = [], d3 = [], both = [], ibsOnly = [], rsiOnly = [], shI = [], shR = [], ibsAll = [], rsiAll = [];
  for (const s of US_SYMS) {
    const d1 = D[s]; if (!d1 || d1.length < 1500) continue; const a = L.atrSeries(d1), rs = L.rsiSeries(d1, 2), cost = s[0] === '^' ? COST : COST_ETF;
    const up = (i) => d1[i].c > L.smaAt(d1, i, 200), sma5 = (k) => { let t = 0; for (let q = k - 4; q <= k; q++) t += d1[q].c; return d1[k].c > t / 5; }, sma5dn = (k) => { let t = 0; for (let q = k - 4; q <= k; q++) t += d1[q].c; return d1[k].c < t / 5; };
    const lowC = (i, n) => { for (let q = i - n + 1; q < i; q++) if (d1[q].c < d1[i].c) return false; return true; }, highC = (k, n) => { for (let q = k - n + 1; q < k; q++) if (d1[q].c > d1[k].c) return false; return true; };
    const s7 = [], s3 = [], sb = [], si = [], sr = [], sI = [], sR = [], iAll = [], rAll = [];
    for (let i = 200; i < d1.length - 1; i++) {
      if (!a[i]) continue; const u = up(i), ib = L.ibs(d1[i]), I = u && ib < 0.2, R = u && rs[i] < 10;
      if (u && lowC(i, 7)) s7.push(sig(d1, a, i));
      if (u && d1[i].c < d1[i - 1].c && d1[i - 1].c < d1[i - 2].c && d1[i - 2].c < d1[i - 3].c) s3.push(sig(d1, a, i));
      if (I) iAll.push(sig(d1, a, i)); if (R) rAll.push(sig(d1, a, i));
      if (I && R) sb.push(sig(d1, a, i)); else if (I) si.push(sig(d1, a, i)); else if (R) sr.push(sig(d1, a, i));
      if (!u && ib > 0.8) sI.push(sig(d1, a, i, -1)); if (!u && rs[i] > 90) sR.push(sig(d1, a, i, -1));
    }
    run(s, s7, () => ({ maxDays: 15, exitFn: (k) => highC(k, 7) }), cost, d7);
    run(s, s3, () => ({ maxDays: 7, exitFn: sma5 }), cost, d3);
    run(s, sb, () => ({ maxDays: 5, exitFn: L.ibsExit(d1) }), cost, both);
    run(s, si, () => ({ maxDays: 5, exitFn: L.ibsExit(d1) }), cost, ibsOnly);
    run(s, sr, () => ({ maxDays: 5, exitFn: L.ibsExit(d1) }), cost, rsiOnly);
    run(s, sI, () => ({ maxDays: 5, exitFn: (k) => L.ibs(d1[k]) < 0.2 }), cost, shI);
    run(s, sR, () => ({ maxDays: 10, exitFn: sma5dn }), cost, shR);
    run(s, iAll, () => ({ maxDays: 5, exitFn: L.ibsExit(d1) }), cost, ibsAll);
    run(s, rAll, () => ({ entry: 'open', maxDays: 10, exitFn: sma5 }), cost, rsiAll);
  }
  out.sets['mr:double7'] = evalSet('Connors Double 7: 7-Tage-Tief im Aufwärtstrend, Verkauf am 7-Tage-Hoch (19 US-Märkte)', d7);
  out.sets['mr:down3'] = evalSet('Drei Verlusttage in Folge im Aufwärtstrend, Verkauf über dem 5er-Schnitt', d3);
  out.sets['mr:both'] = evalSet('IBS unter 0,2 und RSI-2 unter 10 am selben Tag', both);
  out.sets['mr:ibs_only'] = evalSet('IBS unter 0,2 ohne RSI-2-Bestätigung', ibsOnly);
  out.sets['mr:rsi_only'] = evalSet('RSI-2 unter 10 ohne IBS-Bestätigung (Kauf zum Schluss)', rsiOnly);
  out.sets['short:ibs'] = evalSet('Short: IBS über 0,8 im Abwärtstrend', shI, { noEx: true });
  out.sets['short:rsi2'] = evalSet('Short: RSI-2 über 90 im Abwärtstrend', shR, { noEx: true });
  // Pruefung der laufenden Strategien: gebuendelt nach Tagen und Jahr fuer Jahr
  out.audit['ibs_us'] = evalSet('IBS auf 19 US-Märkten (läuft live)', ibsAll);
  out.audit['rsi2_us'] = evalSet('RSI-2 auf 19 US-Märkten (Kauf zur Eröffnung, 5er-Schnitt)', rsiAll);
  // wie viele gleichzeitige Signale je Tag: fuer das Risikobudget
  const perDay = {}; ibsAll.forEach((t) => { const d = L.dayOf(t.t); perDay[d] = (perDay[d] || 0) + 1; }); const cnt = Object.values(perDay).sort((x, y) => x - y);
  out.audit.ibsCluster = { days: cnt.length, median: cnt[Math.floor(cnt.length / 2)], p90: cnt[Math.floor(cnt.length * 0.9)], max: cnt[cnt.length - 1] };
  // schlechteste Phasen: groesster Rueckgang der Summe (in Prozentpunkten, 1 Trade = 1 Einheit) und laengste Verlustserie nach Tagen
  const dd = (trades) => { const g = {}; trades.forEach((t) => { const d = L.dayOf(t.t); g[d] = (g[d] || 0) + t.pct; }); let eq = 0, pk = 0, mx = 0, streak = 0, ms = 0; Object.keys(g).sort().forEach((d) => { eq += g[d]; pk = Math.max(pk, eq); mx = Math.max(mx, pk - eq); if (g[d] < 0) { streak++; ms = Math.max(ms, streak); } else streak = 0; }); return { maxDD: +mx.toFixed(1), lossDays: ms, total: +eq.toFixed(1) }; };
  out.audit.ibsRisk = dd(ibsAll); out.audit.rsiRisk = dd(rsiAll);
}
// ---- 6b) Mehr Signale: mildere Schwellen (wie stark faellt der Vorteil ab?) und weitere US-gehandelte ETF-Gruppen (Laender, Branchen).
//      Gruppen sind nach Art festgelegt, nicht nach Ergebnis; eine Gruppe zaehlt nur als Ganzes.
{
  const tier = (lo, hi) => { const T = []; for (const s of US_SYMS) { const d1 = D[s]; if (!d1 || d1.length < 1500) continue; const a = L.atrSeries(d1), cost = s[0] === '^' ? COST : COST_ETF, sg = [];
    for (let i = 200; i < d1.length - 1; i++) { const ib = L.ibs(d1[i]); if (a[i] && d1[i].c > L.smaAt(d1, i, 200) && ib >= lo && ib < hi) sg.push(sig(d1, a, i)); }
    run(s, sg, () => ({ maxDays: 5, exitFn: L.ibsExit(d1) }), cost, T); } return T; };
  out.sets['ibs:t00_10'] = evalSet('IBS unter 0,1 (19 US-Märkte)', tier(0, 0.1));
  out.sets['ibs:t10_20'] = evalSet('IBS 0,1 bis 0,2', tier(0.1, 0.2));
  out.sets['ibs:t20_30'] = evalSet('IBS 0,2 bis 0,3 (milder, mehr Signale)', tier(0.2, 0.3));
  out.sets['ibs:t30_40'] = evalSet('IBS 0,3 bis 0,4', tier(0.3, 0.4));
  const GROUPS = { 'ibs:laender': ['Länder-ETFs (US-gehandelt): Schwellenländer, Brasilien, Japan, China, Europa, Deutschland, Korea, Taiwan, Indien, Mexiko', ['EEM', 'EWZ', 'EWJ', 'FXI', 'EFA', 'EWG', 'EWY', 'EWT', 'INDA', 'EWW']],
    'ibs:branchen': ['Weitere US-Branchen-ETFs: Öl-Förderer, Einzelhandel, Metalle, Immobilien, Goldminen, Transport, Rüstung, Software, Kommunikation', ['XOP', 'XRT', 'XME', 'IYR', 'GDX', 'IYT', 'ITA', 'IGV', 'XLC', 'XLRE']] };
  for (const key of Object.keys(GROUPS)) { const T = [], used = [];
    for (const s of GROUPS[key][1]) { if (!D[s]) { D[s] = await chart(s); await wait(250); } const d1 = D[s]; if (!d1 || d1.length < 1500) continue; used.push(s);
      run(s, L.ibsSignals(d1), () => ({ maxDays: 5, exitFn: L.ibsExit(d1) }), COST_ETF, T); }
    out.sets[key] = evalSet('IBS auf ' + GROUPS[key][0], T, { syms: used });
    { const g = {}; T.forEach((t) => { (g[t.s] = g[t.s] || []).push(t); }); out.sets[key].bySym = Object.fromEntries(Object.keys(g).map((k) => [k, st(g[k])])); } }
}
// ---- 7) VIX-Dehnung: VIX drei Tage mind. 5 % ueber seinem 10-Tage-Schnitt, S&P 500 im Aufwaertstrend
{
  const T = [], v = D['^VIX'], d1 = D['^GSPC'];
  if (v && d1) { const vi = idxOfDay(v), a = L.atrSeries(d1), rs = L.rsiSeries(d1, 2), sg = [];
    const str = (j) => { if (j == null || j < 10) return false; let t = 0; for (let q = j - 9; q <= j; q++) t += v[q].c; return v[j].c > 1.05 * t / 10; };
    for (let i = 210; i < d1.length - 1; i++) { const j = vi[L.dayOf(d1[i].t)]; if (j != null && str(j) && str(j - 1) && str(j - 2) && d1[i].c > L.smaAt(d1, i, 200) && a[i]) sg.push(sig(d1, a, i)); }
    // nur das erste Signal einer Serie
    const first = sg.filter((g, k) => !k || g.i - sg[k - 1].i > 1);
    run('^GSPC', first, () => ({ maxDays: 7, exitFn: (k) => rs[k] > 65 }), COST, T); }
  out.sets['vix:stretch'] = evalSet('VIX-Dehnung: VIX 3 Tage über seinem 10-Tage-Schnitt, Kauf S&P 500', T);
}
// ---- 8) Oops-Gap (Larry Williams): Eroeffnung unter dem Vortagestief, Kauf wenn der Kurs das Vortagestief zurueckerobert, Verkauf zum Schluss
{
  const T = [], Tt = [];
  for (const s of GAP_ETF) {
    const d1 = D[s]; if (!d1 || d1.length < 400) continue;
    for (let i = 200; i < d1.length; i++) { const p = d1[i - 1], x = d1[i]; if (x.o < p.l && x.h >= p.l) { const pct = (x.c / p.l - 1) * 100 - COST_ETF, o = { t: x.t, s, cost: COST_ETF, pct, days: 1 }; T.push(o); if (p.c > L.smaAt(d1, i - 1, 200)) Tt.push(o); } }
  }
  out.sets['gap:oops'] = evalSet('Oops-Gap: Eröffnung unter Vortagestief, Kauf bei Rückeroberung, Verkauf zum Schluss (11 US-ETFs)', T, { noEx: true });
  out.sets['gap:oops_trend'] = evalSet('Oops-Gap nur im Aufwärtstrend', Tt, { noEx: true });
}
// ---- 9) Bitcoin und Ether: Ausbruch ueber das 20-Tage-Hoch, Ausstieg unter dem 10-Tage-Tief (Trendfolge)
{
  const T = [], T55 = [];
  const don = (s, nIn, nOut, into) => { const d1 = D[s]; if (!d1 || d1.length < 300) return; let pos = null;
    for (let i = nIn + 1; i < d1.length; i++) { let hh = -Infinity, ll = Infinity; for (let q = i - nIn; q < i; q++) hh = Math.max(hh, d1[q].h); for (let q = i - nOut; q < i; q++) ll = Math.min(ll, d1[q].l);
      if (!pos && d1[i].c > hh) pos = { e: d1[i].c, t: d1[i].t, i }; else if (pos && d1[i].c < ll) { into.push({ t: pos.t, s, cost: COST_CRYPTO, pct: (d1[i].c / pos.e - 1) * 100 - COST_CRYPTO, days: i - pos.i }); pos = null; } } };
  for (const s of ['BTC-USD', 'ETH-USD']) { don(s, 20, 10, T); don(s, 55, 20, T55); }
  out.sets['crypto:don20'] = evalSet('Bitcoin und Ether: Ausbruch über das 20-Tage-Hoch, raus unter dem 10-Tage-Tief', T, { noEx: true });
  out.sets['crypto:don55'] = evalSet('Bitcoin und Ether: Ausbruch über das 55-Tage-Hoch, raus unter dem 20-Tage-Tief', T55, { noEx: true });
}
out.passed = Object.keys(out.sets).filter((k) => out.sets[k].passed);
writeFileSync(new URL('./backtest-cal.json', import.meta.url), JSON.stringify(out));
for (const k of Object.keys(out.sets)) { const x = out.sets[k]; console.log((x.passed ? 'OK  ' : '--  ') + k.padEnd(18), 'n', String(x.all.n).padStart(5), 'win', x.all.win, 'mean', x.all.mean, '| tr', x.train.mean, 'te', x.test.mean, 'ho', x.hold.mean, '| dayLo', x.day.lo, '| ex', x.ex ? x.ex.all.mean : '-', '| Jahre', x.yearsUp + '/' + x.yearsN); }
for (const k of ['ibs_us', 'rsi2_us']) { const x = out.audit[k]; console.log('AUDIT', k, 'n', x.all.n, 'win', x.all.win, 'mean', x.all.mean, 'lo', x.all.lo, 'dayLo', x.day.lo, 'Jahre', x.yearsUp + '/' + x.yearsN, 'cost2', x.cost2.mean, 'ex', x.ex.all.mean); }
console.log('Cluster', JSON.stringify(out.audit.ibsCluster), 'Risiko', JSON.stringify(out.audit.ibsRisk), JSON.stringify(out.audit.rsiRisk));
