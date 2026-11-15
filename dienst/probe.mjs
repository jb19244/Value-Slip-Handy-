// Prueft kostenlose Kalender-Quellen mit Ist-Werten (einmalig)
const now = new Date(), from = new Date(now - 7 * 864e5).toISOString(), to = new Date(+now + 864e5).toISOString();
const tries = [
  ['TradingView', `https://economic-calendar.tradingview.com/events?from=${from}&to=${to}&countries=US,EU,DE,GB,JP`, { Origin: 'https://www.tradingview.com', 'User-Agent': 'Mozilla/5.0' }],
  ['FF XML', 'https://nfs.faireconomy.media/ff_calendar_thisweek.xml', { 'User-Agent': 'Mozilla/5.0' }],
  ['FF JSON', 'https://nfs.faireconomy.media/ff_calendar_thisweek.json', { 'User-Agent': 'Mozilla/5.0' }],
];
for (const [n, u, h] of tries) {
  try { const r = await fetch(u, { headers: h }); const t = await r.text(); console.log('==', n, r.status, t.length); console.log(t.slice(0, 900).replace(/\s+/g, ' '));
    if (n === 'TradingView' && r.ok) { const j = JSON.parse(t); const ev = j.result || []; console.log('Events', ev.length, 'mit actual', ev.filter((e) => e.actual != null && e.actual !== '').length); console.log(JSON.stringify(ev.filter((e) => e.importance >= 1 && e.actual != null).slice(0, 4))); }
    if (n === 'FF XML') console.log('actual-Tags mit Wert', (t.match(/<actual><!\[CDATA\[[^\]]+\]\]><\/actual>/g) || []).length);
  } catch (e) { console.log('==', n, 'Fehler', e.message); }
}
