// Prueft nach dem Hochladen, ob die Marktdaten fuer Trade Check ankommen (schreibt dienst/mkt-check.json, ohne Schluessel)
import { readFileSync, writeFileSync } from 'node:fs';
const st = JSON.parse(readFileSync(new URL('status.json', import.meta.url), 'utf8'));
const origin = 'https://' + String(process.env.GITHUB_REPOSITORY_OWNER || '').toLowerCase() + '.github.io';
const out = { at: new Date().toISOString(), url: st.url, checks: [] };
const get = async (path) => {
  const t0 = Date.now();
  try { const r = await fetch(st.url + path, { headers: { Origin: origin } }); const txt = await r.text(); let j = null; try { j = JSON.parse(txt); } catch (e) {} return { status: r.status, ms: Date.now() - t0, j, txt: j ? '' : txt.slice(0, 200) }; }
  catch (e) { return { status: 0, ms: Date.now() - t0, err: String(e.message || e) }; }
};
await new Promise((r) => setTimeout(r, 8000));
const syms = ['EURUSD=X', 'GBPUSD=X', 'JPY=X', 'GC=F', 'SI=F', 'CL=F', '^GDAXI', '^NDX', '^GSPC', 'SAP.DE', 'NVDA'];
for (const s of syms) for (const [iv, rg] of [['15m', '5d'], ['60m', '1mo'], ['1d', '2y']]) {
  const r = await get('/mkt/chart?sym=' + encodeURIComponent(s) + '&interval=' + iv + '&range=' + rg);
  const res = r.j && r.j.chart && r.j.chart.result && r.j.chart.result[0];
  out.checks.push({ what: s + ' ' + iv, status: r.status, ms: r.ms, n: res && res.timestamp ? res.timestamp.length : 0, last: res && res.meta ? res.meta.regularMarketPrice : null, err: r.err || (r.j && r.j.chart && r.j.chart.error) || r.txt || (r.j && r.j.message) || '' });
}
const c = await get('/mkt/cal'); out.checks.push({ what: 'Kalender', status: c.status, n: c.j && c.j.events ? c.j.events.length : 0, err: c.err || (c.j && c.j.message) || c.txt || '' , sample: c.j && c.j.events ? c.j.events.slice(0, 2) : null });
for (const code of ['099741', '088691', '13874A', '209742']) { const r = await get('/mkt/cot?code=' + code); out.checks.push({ what: 'COT ' + code, status: r.status, n: r.j && r.j.rows ? r.j.rows.length : 0, sample: r.j && r.j.rows ? r.j.rows[0] : null, err: r.err || (r.j && r.j.message) || r.txt || '' }); }
const s = await get('/mkt/search?q=rheinmetall'); out.checks.push({ what: 'Suche', status: s.status, sample: s.j && s.j.quotes ? s.j.quotes.slice(0, 3) : null, err: s.err || (s.j && s.j.message) || s.txt || '' });
writeFileSync(new URL('mkt-check.json', import.meta.url), JSON.stringify(out, null, 2) + '\n');
console.log(out.checks.map((x) => x.what + ' ' + x.status + ' ' + (x.n || '')).join('\n'));
