// Pruefungen zum DAX-Trend-Ausbruch (Spanne 9:00-9:15, mit Trend, Order 20 Min nach der Spanne, Stop andere Seite, Schluss 17:25):
//  A) Termin-Filter: laeuft er an Tagen mit wichtigen Terminen (US-Zahlen 14:30, EZB, deutsche/europaeische Daten) schlechter?
//     Termine aus dem Wirtschaftskalender von TradingView (wichtig = importance 1), 2013 bis heute.
//  B) Gegenprobe mit fremden Daten: Yahoo-Xetra-Kurse (5 Min, letzte 60 Tage) Trade fuer Trade gegen Dukascopy.
// Ergebnis: dienst/backtest-dtb-check.json
import { writeFileSync } from 'node:fs';
import { INS, load, prep, apply, stats } from './backtest13.mjs';
const RULE = { fam: 'orb', id: 'orb_15_trend_range__1045_v20', len: 15, f: 'trend', st: 'range', tg: null, ex: 1045, open: 540, delay: 20 };
const dax = INS.find((x) => x.k === 'DAX'), rows = await load(dax), D = prep(rows, dax);
const T = []; D.forEach((d, i) => { const a = apply(RULE, d, dax, D, i, false); if (a && !a.skip && a.r != null) T.push({ day: d.day, r: a.r, how: a.how }); });
console.log('Trades', T.length, JSON.stringify(stats(T.map((x) => x.r))));
const out = { at: new Date().toISOString(), rule: RULE.id, all: stats(T.map((x) => x.r)), news: {}, yahoo: {} };
// ---------- A) Termine
const loc = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const berlin = (ms) => { const p = {}; loc.formatToParts(new Date(ms)).forEach((x) => { p[x.type] = x.value; }); return { day: p.year + '-' + p.month + '-' + p.day, min: +p.hour * 60 + +p.minute }; };
const EV = {}; let evN = 0;
for (let y = 2013; y <= new Date().getUTCFullYear(); y++) for (let q = 0; q < 12; q += 3) {
  const from = new Date(Date.UTC(y, q, 1)).toISOString(), to = new Date(Date.UTC(y, q + 3, 1)).toISOString(); if (Date.parse(from) > Date.now()) continue;
  let ok = false; for (let a = 0; a < 3 && !ok; a++) { try { const r = await fetch('https://economic-calendar.tradingview.com/events?from=' + from + '&to=' + to + '&countries=US,EU,DE', { headers: { Origin: 'https://www.tradingview.com', 'User-Agent': 'Mozilla/5.0' } });
    if (r.ok) { const j = await r.json(); (j.result || []).filter((e) => e.importance === 1).forEach((e) => { const b = berlin(Date.parse(e.date)); if (b.min < 540 || b.min > 1050) return; evN++;
      const k = /Interest Rate Decision|Deposit Facility|Refinancing/i.test(e.title) && e.country !== 'US' ? 'ezb' : e.country === 'US' ? (b.min >= 860 && b.min <= 880 ? 'us1430' : 'us') : 'eu';
      (EV[b.day] = EV[b.day] || new Set()).add(k); }); ok = true; } } catch (e) {} if (!ok) await new Promise((r) => setTimeout(r, 2000)); }
  if (!ok) console.log('Kalender fehlt', from);
}
console.log('Termine im DAX-Handel', evN, 'Tage mit Terminen', Object.keys(EV).length);
const cut = (f) => { const a = T.filter((x) => f(EV[x.day])), b = T.filter((x) => !f(EV[x.day])), sa = stats(a.map((x) => x.r)), sb = stats(b.map((x) => x.r));
  const va = a.length > 1 ? a.reduce((s, x) => s + (x.r - sa.mean) ** 2, 0) / (a.length - 1) : 0, vb = b.length > 1 ? b.reduce((s, x) => s + (x.r - sb.mean) ** 2, 0) / (b.length - 1) : 0;
  const tDiff = a.length && b.length ? +((sa.mean - sb.mean) / Math.sqrt(va / a.length + vb / b.length)).toFixed(2) : null; return { mit: sa, ohne: sb, tDiff }; };
out.news = { anyTermin: cut((s) => !!s), us1430: cut((s) => s && s.has('us1430')), ezb: cut((s) => s && s.has('ezb')), eu: cut((s) => s && s.has('eu')), events: evN };
for (const k of ['anyTermin', 'us1430', 'ezb', 'eu']) { const x = out.news[k]; console.log('TERMIN', k.padEnd(10), 'mit', JSON.stringify(x.mit), '| ohne', JSON.stringify(x.ohne), '| t Unterschied', x.tDiff); }
// ---------- B) Yahoo Xetra 5 Min (60 Tage) gegen Dukascopy
try {
  const r = await fetch('https://query1.finance.yahoo.com/v8/finance/chart/%5EGDAXI?interval=5m&range=60d', { headers: { 'User-Agent': 'Mozilla/5.0' } }), j = await r.json(), q = j.chart.result[0], ind = q.indicators.quote[0];
  const yrows = q.timestamp.map((t, i) => [t * 1000, ind.open[i], ind.high[i], ind.low[i], ind.close[i]]).filter((x) => x[1] != null && x[4] != null);
  // Tageskennzahlen (Trend, ATR) aus den Dukascopy-Tagen, Kerzen des Tages aus Yahoo
  const YD = prep(yrows, Object.assign({}, dax)), byDay = {}; D.forEach((d, i) => { byDay[d.day] = i; });
  const cmp = [];
  YD.forEach((yd) => { const i = byDay[yd.day]; if (i == null) return; const dd = D[i], y2 = Object.assign({}, dd, { b: yd.b });
    const a = apply(RULE, dd, dax, D, i, false), b = apply(RULE, y2, dax, D, i, false);
    cmp.push({ day: yd.day, duka: a && !a.skip ? a.r : null, yahoo: b && !b.skip ? b.r : null, dskip: a && a.skip ? 1 : 0, yskip: b && b.skip ? 1 : 0 }); });
  const both = cmp.filter((x) => x.duka != null && x.yahoo != null), same = both.filter((x) => Math.sign(x.duka) === Math.sign(x.yahoo)).length;
  const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : null, corr = (() => { const a = both.map((x) => x.duka), b = both.map((x) => x.yahoo), ma = mean(a), mb = mean(b); let n = 0, da = 0, db = 0; a.forEach((x, k) => { n += (x - ma) * (b[k] - mb); da += (x - ma) ** 2; db += (b[k] - mb) ** 2; }); return da && db ? n / Math.sqrt(da * db) : null; })();
  out.yahoo = { days: cmp.length, bothTrades: both.length, onlyDuka: cmp.filter((x) => x.duka != null && x.yahoo == null).length, onlyYahoo: cmp.filter((x) => x.yahoo != null && x.duka == null).length, sameSign: same, corr: corr != null ? +corr.toFixed(3) : null,
    meanDuka: mean(both.map((x) => x.duka)), meanYahoo: mean(both.map((x) => x.yahoo)), detail: cmp };
  console.log('YAHOO Tage', cmp.length, '| beide Trades', both.length, '| gleiches Vorzeichen', same, '| Korrelation', out.yahoo.corr, '| Ø R Dukascopy', out.yahoo.meanDuka, 'Yahoo', out.yahoo.meanYahoo, '| nur Dukascopy', out.yahoo.onlyDuka, 'nur Yahoo', out.yahoo.onlyYahoo);
} catch (e) { console.log('Yahoo Fehler', e.message); out.yahoo.err = e.message; }
writeFileSync(new URL('./backtest-dtb-check.json', import.meta.url), JSON.stringify(out));
