// Tagesschwankung (ATR 14) und Stundenschwankung je Markt, fuer die Hebel-Empfehlung
import { readFileSync } from 'node:fs';
const html = readFileSync(new URL('../trade/index.html', import.meta.url), 'utf8');
const src = html.split('// BEGIN LOGIC')[1].split('// END LOGIC')[0];
const L = new Function(src + '; return { parseYahoo, atrSeries };')();
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; TradeCheck/1.0)' };
async function chart(sym, iv, rg) { for (const host of ['query1', 'query2']) { try { const r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${iv}&range=${rg}`, { headers: UA }); if (r.ok) return L.parseYahoo(await r.json()); } catch (e) {} } return []; }
const M = [['EUR/USD', 'EURUSD=X'], ['GBP/USD', 'GBPUSD=X'], ['USD/JPY', 'JPY=X'], ['Gold', 'GC=F'], ['Silber', 'SI=F'], ['Öl WTI', 'CL=F'], ['DAX', '^GDAXI'], ['Nasdaq 100', '^NDX'], ['S&P 500', '^GSPC'], ['Dow Jones', '^DJI'], ['Russell 2000', '^RUT']];
for (const [nm, s] of M) {
  const d = await chart(s, '1d', '1y'), h = await chart(s, '60m', '1mo');
  const ad = L.atrSeries(d), ah = L.atrSeries(h), pd = d.length ? ad[ad.length - 1] / d[d.length - 1].c * 100 : null, ph = h.length ? ah[ah.length - 1] / h[h.length - 1].c * 100 : null;
  // Durchschnitt der Tages-ATR ueber das Jahr, damit ein ruhiger Moment nicht taeuscht
  const avg = ad.filter((x, i) => x && d[i]).map((x, i) => x / d[ad.indexOf(x)].c * 100); const mean = avg.length ? avg.reduce((a, b) => a + b, 0) / avg.length : null;
  console.log('ATR', nm.padEnd(13), 'Tag jetzt', pd && pd.toFixed(2), '% | Tag Jahresschnitt', mean && mean.toFixed(2), '% | Stunde', ph && ph.toFixed(3), '%');
}
