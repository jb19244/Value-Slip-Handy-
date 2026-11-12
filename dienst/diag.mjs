// Diagnose: Welche Signale haetten die letzten Handelstage nach den Live-Regeln ausgeloest? (mit echten Kursen)
import { readFileSync } from 'node:fs';
const html = readFileSync(new URL('../trade/index.html', import.meta.url), 'utf8');
const src = html.split('// BEGIN LOGIC')[1].split('// END LOGIC')[0];
const L = new Function(src + '; return { scanUniverse, marketContext, gradeMatch, gradeName, parseYahoo, backtest, berlinFast, ibs, rsiSeries, smaAt, atrSeries, SETUPS };')();
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; TradeCheck/1.0)' };
async function chart(sym, iv, rg) { for (const host of ['query1', 'query2']) { try { const r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${iv}&range=${rg}`, { headers: UA }); if (r.ok) return L.parseYahoo(await r.json()); } catch (e) {} } return []; }
const b1 = JSON.parse(readFileSync(new URL('./backtest-1h.json', import.meta.url), 'utf8')), more = JSON.parse(readFileSync(new URL('./backtest-more.json', import.meta.url), 'utf8'));
const since = Date.now() - 6 * 86400e3, day = (t) => L.berlinFast(t).key;
const vix = await chart('^VIX', '1d', '1y'), dxy = await chart('DX-Y.NYB', '1d', '1y');
console.log('VIX letzte Schluesse:', vix.slice(-6).map((x) => day(x.t) + ' ' + x.c.toFixed(1)).join(', '));
console.log('Creme:', b1.creme, 'B+:', b1.bplus, 'Stand', b1.at);
// 1) Intraday: alle Setups der letzten 6 Tage, was die Stufen getroffen haette
const hits = [], near = {};
for (const ins of L.scanUniverse()) {
  const h1 = await chart(ins.y, '60m', '60d'), d1 = await chart(ins.y, '1d', '2y'); if (h1.length < 200) { console.log('zu wenig Daten', ins.k); continue; }
  for (const setup of Object.keys(L.SETUPS)) {
    const tr = L.backtest({ instr: ins, m15: h1, h1, d1, bar: 3600e3, setup, any: true, be: setup === 'sweep' || setup === 'pullback', noCheck: setup !== 'sweep' && setup !== 'pullback', conf: ['sweep', 'pullback', 'nr7r1'].includes(setup) });
    tr.filter((t) => t.at >= since).forEach((t) => { Object.assign(t.sig, L.marketContext(t.sig.day, ins, t.sig.dir, vix, dxy));
      const c = b1.creme.filter((id) => id.startsWith(setup + ':') && L.gradeMatch(id, t.sig, t.ampel)), b = b1.bplus.filter((id) => id.startsWith(setup + ':') && L.gradeMatch(id, t.sig, t.ampel));
      if (c.length || b.length) hits.push([new Date(t.at).toISOString().slice(0, 16), ins.k, setup, t.sig.dir > 0 ? 'Long' : 'Short', c.length ? 'CREME' : 'B+', 'r=' + (t.r == null ? '-' : t.r.toFixed(2))].join(' '));
      if (setup === 'sweep') { const k = 'sweep ' + (t.sig.withBias ? 'mitTrend' : 'gegenTrend') + ' vixhi=' + (t.sig.vixHi ? 1 : 0) + ' ampel=' + t.ampel; near[k] = (near[k] || 0) + 1; } });
  }
  await new Promise((r) => setTimeout(r, 250));
}
console.log('Intraday-Treffer der letzten 6 Tage:', hits.length); hits.forEach((h) => console.log('  ' + h));
console.log('Sweep-Signale nach Merkmalen:', JSON.stringify(near));
// 2) Tages-Strategien auf den US-Maerkten
const US = ['^GSPC', '^NDX', '^DJI', '^RUT', 'XLK', 'XLF', 'XLE', 'XLV', 'XLY', 'XLP', 'XLI', 'XLB', 'XLU', 'IWM', 'DIA', 'SMH', 'XBI', 'KRE', 'ITB'];
for (const s of US) { const d1 = await chart(s, '1d', '2y'); if (d1.length < 210) continue; const rs = L.rsiSeries(d1, 2), n = d1.length;
  const row = []; for (let i = n - 4; i < n; i++) { const up = d1[i].c > L.smaAt(d1, i, 200); row.push(day(d1[i].t).slice(5) + (up ? ' ↑' : ' ↓') + ' IBS ' + L.ibs(d1[i]).toFixed(2) + ' RSI2 ' + (rs[i] || 0).toFixed(0) + (up && L.ibs(d1[i]) < 0.2 ? ' <<IBS' : '') + (up && rs[i] < 10 ? ' <<RSI2' : '')); }
  console.log(s.padEnd(6), row.join(' | ')); }
