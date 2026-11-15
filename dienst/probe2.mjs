// Einmalige Probe: Dukascopy-Minutendaten und Verzoegerung der Yahoo-Kurse
import { getHistoricalRates } from 'dukascopy-node';
const t0 = Date.now();
for (const inst of ['deuidxeur', 'usatechidxusd', 'xauusd', 'eurusd']) {
  try {
    const d = await getHistoricalRates({ instrument: inst, dates: { from: new Date('2015-01-05'), to: new Date('2015-01-10') }, timeframe: 'm5', format: 'json', priceType: 'bid' });
    console.log('DUKA', inst, d.length, JSON.stringify(d[0]), JSON.stringify(d[d.length - 1]), Math.round((Date.now() - t0) / 1000) + 's');
  } catch (e) { console.log('DUKA', inst, 'Fehler', e.message); }
}
try { const d = await getHistoricalRates({ instrument: 'deuidxeur', dates: { from: new Date('2026-11-10'), to: new Date('2026-11-14') }, timeframe: 'm5', format: 'json' }); console.log('DUKA aktuell', d.length, JSON.stringify(d[d.length - 1]), new Date(d[d.length - 1].timestamp).toISOString()); } catch (e) { console.log('DUKA aktuell Fehler', e.message); }
// ein ganzes Jahr DAX 5 Min: Dauer
const t1 = Date.now();
try { const d = await getHistoricalRates({ instrument: 'deuidxeur', dates: { from: new Date('2020-01-01'), to: new Date('2021-01-01') }, timeframe: 'm5', format: 'json', batchSize: 20, pauseBetweenBatchesMs: 200 }); console.log('DUKA Jahr', d.length, Math.round((Date.now() - t1) / 1000) + 's'); } catch (e) { console.log('DUKA Jahr Fehler', e.message); }
const UA = { 'User-Agent': 'Mozilla/5.0' };
for (const s of ['^GDAXI', 'NQ=F', 'GC=F', 'EURUSD=X', '^NDX', 'ES=F']) {
  try { const r = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(s)}?interval=1m&range=1d`, { headers: UA }); const j = await r.json(); const m = j.chart.result[0].meta; const ts = j.chart.result[0].timestamp || [];
    console.log('YAHOO', s, 'exchange', m.exchangeName, 'delay', m.exchangeDataDelayedBy, 'letzte Kerze', ts.length ? new Date(ts[ts.length - 1] * 1000).toISOString() : '-', 'jetzt', new Date().toISOString(), 'regMarketTime', new Date(m.regularMarketTime * 1000).toISOString());
  } catch (e) { console.log('YAHOO', s, 'Fehler', e.message); }
}
