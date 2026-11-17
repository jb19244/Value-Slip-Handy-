// Tagesrueckblick: Was haben die Strategien der App in den letzten Handelstagen gemeldet und wie lief es?
// DAX-Trend-Ausbruch und DAX-Nachmittag mit 5-Min-Kerzen (Dukascopy, wie in der Rueckrechnung),
// Tagesregeln (IBS, RSI-2, drei Verlusttage, Turnaround Tuesday, Neu entdeckt) mit Tageskerzen (Yahoo, inkl. laufendem Tag).
// Ergebnis: dienst/backtest-heute.json
process.env.PM = '1';
const { readFileSync, writeFileSync } = await import('node:fs');
const { INS, load, prep, apply, cands } = await import('./backtest13.mjs');
const html = readFileSync(new URL('../trade/index.html', import.meta.url), 'utf8');
const L = new Function(html.split('// BEGIN LOGIC')[1].split('// END LOGIC')[0] + '; return { parseYahoo, ruleSeries, ruleHit, ruleExit, ruleText, rsiSeries, smaSeries, ibs };')();
const out = { at: new Date().toISOString(), dax: [], daily: [] };
const DTB = { fam: 'orb', id: 'orb_15_trend_range__1045_v20', len: 15, f: 'trend', st: 'range', tg: null, ex: 1045, open: 540, delay: 20 };
const dax = INS.find((x) => x.k === 'DAX'), D = prep(await load(dax), dax);
const DPM = cands(dax).find((c) => c.id === 'pm_930_60_gap_range__1045');
for (let i = Math.max(0, D.length - 8); i < D.length; i++) { const d = D[i];
  for (const [nm, r] of [['DAX-Trend-Ausbruch', DTB], ['DAX-Nachmittag', DPM]]) { if (!r) continue; let a = null; try { a = apply(r, d, dax, D, i, false); } catch (e) { a = { err: String(e) }; }
    const row = { day: d.day, strat: nm, sig: !!(a && !a.skip && a.r != null), r: a && a.r != null ? +a.r.toFixed(2) : null, dir: a && a.dir, info: a && (a.skip || a.err || a.why) || null, dayMove: d.close && d.prev ? +((d.close / d.prev.close - 1) * 100).toFixed(2) : null };
    out.dax.push(row); console.log('DAX', JSON.stringify(row)); } }
// ---------- Tagesregeln
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; TradeCheck/1.0)' };
async function chart(sym) { for (const h of ['query1', 'query2']) { try { const r = await fetch(`https://${h}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1d&range=2y`, { headers: UA }); if (r.ok) return L.parseYahoo(await r.json()).filter((x) => x.c > 0); } catch (e) {} } return []; }
const su = JSON.parse(readFileSync(new URL('./backtest-suche.json', import.meta.url), 'utf8'));
const SYMS = { '^GSPC': 'S&P 500', '^NDX': 'Nasdaq 100', '^DJI': 'Dow Jones', '^RUT': 'Russell 2000', '^GDAXI': 'DAX' };
for (const [y, name] of Object.entries(SYMS)) { const d1 = await chart(y); if (d1.length < 220) { console.log('fehlt', y); continue; } const S = L.ruleSeries(d1), sm = L.smaSeries(d1, S, 200);
  for (let i = d1.length - 6; i < d1.length; i++) { const x = d1[i], p = d1[i - 1], up = sm[i] != null && x.c > sm[i], ib = L.ibs(x), wd = new Date(x.t + 3 * 3600e3).getUTCDay();
    const hits = []; if (up && ib < 0.2) hits.push('IBS'); if (up && S.rsi2[i] != null && S.rsi2[i] < 10) hits.push('RSI-2');
    if (up && x.c < p.c && p.c < d1[i - 2].c && d1[i - 2].c < d1[i - 3].c) hits.push('3 Verlusttage'); if (up && wd === 1 && x.c < p.c) hits.push('Turnaround Tuesday (Montag rot)');
    (su.live || []).forEach((r) => { if ((r.syms || []).includes(y) && L.ruleHit(d1, i, r.rule, S)) hits.push(r.name); });
    // was ist seitdem passiert (bis zum letzten Kurs)
    const last = d1[d1.length - 1], since = i < d1.length - 1 ? +((last.c / x.c - 1) * 100).toFixed(2) : null;
    const row = { y, name, day: new Date(x.t).toISOString().slice(0, 10), chg: +((x.c / p.c - 1) * 100).toFixed(2), ibs: +ib.toFixed(2), rsi2: S.rsi2[i] != null ? +S.rsi2[i].toFixed(1) : null, trend: up, abstand200: sm[i] ? +((x.c / sm[i] - 1) * 100).toFixed(1) : null, hits, seitdem: since };
    out.daily.push(row); console.log('TAG', JSON.stringify(row)); } }
writeFileSync(new URL('./backtest-heute.json', import.meta.url), JSON.stringify(out));
