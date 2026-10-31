// Einmalige Analyse (GitHub Actions): frische Pinnacle- und bet365-Quoten fuer gewaehlte Ligen, Value je Tipp.
// Liest die Schluessel aus dem Push-Speicher (KV), schreibt nur Quoten und Ergebnisse nach dienst/analyse.json.
import { readFileSync, writeFileSync } from 'node:fs';
import { findToken } from './deploy.mjs';
const API = 'https://api.cloudflare.com/client/v4';
const DIR = new URL('./', import.meta.url);
const html = readFileSync(new URL('../index.html', DIR), 'utf8');
const code = html.split('// BEGIN LOGIC')[1].split('// END API')[0].replace('// END LOGIC', '').replace('// BEGIN API', '');
const L = new Function(code + '; return {convertEvents,normalizeFeed,selectionsFor,fairOddsFor,leagueByKey,oddsUrl,opUrl,opParse,opMatch,withAuto,bestBets,marketsFor,berlinDay};')();
const token = findToken(process.env);
const H = { Authorization: 'Bearer ' + token };
const j = async (u, o) => { const r = await fetch(u, o); const t = await r.text(); try { return { ok: r.ok, status: r.status, body: JSON.parse(t), headers: r.headers }; } catch (e) { return { ok: r.ok, status: r.status, body: t, headers: r.headers }; } };
const acc = await j(API + '/accounts?per_page=50', { headers: H });
const id = acc.body.result[0].id;
const kvs = await j(API + '/accounts/' + id + '/storage/kv/namespaces?per_page=100', { headers: H });
const ns = kvs.body.result.find((n) => n.title === 'value-slip');
const user = (await j(API + '/accounts/' + id + '/storage/kv/namespaces/' + ns.id + '/values/user', { headers: H })).body;
const leagues = (process.env.LEAGUES || 'basketball_nba,icehockey_nhl').split(',');
const now = Date.now(), to = now + 14 * 3600e3;
const out = { at: new Date(now).toISOString(), leagues, quota: null, op: null, games: [], picks: [], errors: [] };
const raws = [];
for (const lk of leagues) {
  const lg = L.leagueByKey(lk);
  const r = await j(L.oddsUrl('', user.apiKey, lg, now, to));
  out.quota = r.headers.get('x-requests-remaining');
  if (!r.ok) { out.errors.push(lk + ' Pinnacle ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 200)); continue; }
  raws.push(...L.convertEvents(r.body, lg, now));
  await new Promise((s) => setTimeout(s, 600));
}
let auto = {};
if (user.op && user.op.key) {
  const tids = leagues.map((k) => user.op.tours[k]).filter(Boolean);
  const r = await j(L.opUrl('', '/v4/odds-by-tournaments', { bookmaker: user.op.book || 'bet365', tournamentIds: tids.join(','), oddsFormat: 'decimal', apiKey: user.op.key }));
  if (!r.ok) out.errors.push('OddsPapi ' + r.status + ' ' + JSON.stringify(r.body).slice(0, 200));
  else {
    const tid2l = {}; Object.keys(user.op.tours).forEach((k) => { tid2l[user.op.tours[k]] = k; });
    const parsed = L.opParse(r.body, user.op.idx, tid2l, user.op.book || 'bet365');
    auto = L.opMatch(raws, parsed);
    out.op = { fixtures: Array.isArray(r.body) ? r.body.length : 0, parsed: parsed.length, matched: Object.keys(auto).length,
      unmatched: parsed.filter((p) => !Object.values(auto).some((a) => a.fid === p.fid)).map((p) => p.home + ' – ' + p.away + ' ' + new Date(p.ko).toISOString()) };
  }
}
const ms = L.normalizeFeed({ matches: raws }).matches.map((m) => {
  const a = auto[m.id];
  const mm = a ? L.withAuto(m, Object.assign({}, a, { fetched: now }), now, now) : m;
  return Object.assign(mm, { bookName: 'bet365', taxF: 1 });
});
const hm = (t) => new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', weekday: 'short' }).format(new Date(t));
ms.forEach((m) => {
  const f = L.fairOddsFor(m, 'power');
  const sels = L.selectionsFor(m, 'power');
  const raw = auto[m.id];
  out.games.push({ game: m.home + ' – ' + m.away, league: m.league, ko: hm(m.kickoff), pin: { ref: m.ref, ou: m.ou && { line: m.ou.line, ref: m.ou.ref }, hc: m.hc && { line: m.hc.line, ref: m.hc.ref } },
    fair: { res: f.res, ou: f.ou, hc: f.hc }, b365raw: raw ? { res: raw.res, ou: raw.ou, hc: raw.hc } : null,
    sels: sels.map((s) => ({ label: s.label, market: s.market, line: s.line, p: +s.p.toFixed(4), fair: +(1 / s.p).toFixed(3), book: s.book, ev: +s.ev.toFixed(4) })) });
  sels.forEach((s) => out.picks.push({ game: m.home + ' – ' + m.away, ko: hm(m.kickoff), label: s.label, market: s.market, line: s.line, p: +s.p.toFixed(4), fair: +(1 / s.p).toFixed(3), book: s.book, ev: +s.ev.toFixed(4) }));
});
out.picks.sort((a, b) => b.ev - a.ev);
const bb = L.bestBets(ms, { minEdge: 0.02, kelly: 0.25, bankroll: 500, devig: 'power' });
out.combos = bb.slips.map((sl) => ({ odds: +sl.odds.toFixed(2), p: +sl.p.toFixed(3), ev: +sl.ev.toFixed(4), legs: sl.legs.map((l) => l.label + ' @ ' + l.book + ' (' + l.game + ')') }));
writeFileSync(new URL('analyse.json', DIR), JSON.stringify(out, null, 1) + '\n');
console.log('Spiele', out.games.length, 'Tipps', out.picks.length, 'Fehler', out.errors.length);
