// Richtet den Push-Dienst automatisch bei Cloudflare ein (laeuft in GitHub Actions, siehe .github/workflows/push-dienst.yml).
// Braucht nur das GitHub-Secret CLOUDFLARE_API_TOKEN (Vorlage "Edit Cloudflare Workers").
// Ergebnis (Adresse oder Fehler) landet in dienst/status.json; die App liest daraus die Adresse.
import { readFileSync, writeFileSync } from 'node:fs';

const API = 'https://api.cloudflare.com/client/v4';
const NAME = 'value-slip';
const CRON = '*/5 * * * *';
const DIR = new URL('./', import.meta.url);

export async function deploy({ token, owner, code, fetchFn = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = () => Date.now() }) {
  const status = { ok: false, at: new Date(now()).toISOString(), step: '', msg: '', url: '' };
  const fail = (step, msg) => Object.assign(status, { ok: false, step, msg });
  if (!token) return fail('token', 'Das GitHub-Secret CLOUDFLARE_API_TOKEN fehlt.');
  const call = async (method, path, body, raw) => {
    const headers = { Authorization: 'Bearer ' + token };
    let payload = body;
    if (body !== undefined && !raw) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const r = await fetchFn(API + path, { method, headers, body: payload });
    let j = null;
    try { j = await r.json(); } catch (e) { j = null; }
    const err = j && Array.isArray(j.errors) && j.errors.length ? j.errors.map((e) => (e.code ? e.code + ': ' : '') + e.message).join('; ') : '';
    return { ok: r.ok && !!(j && j.success !== false), status: r.status, j, err, code: j && j.errors && j.errors[0] ? j.errors[0].code : null };
  };
  const origin = 'https://' + String(owner || '').toLowerCase() + '.github.io';
  if (!/^https:\/\/[a-z0-9-]+\.github\.io$/.test(origin)) return fail('origin', 'GitHub-Name unbekannt.');

  // 1) Konto
  const acc = await call('GET', '/accounts?per_page=50');
  if (!acc.ok) return fail('konto', acc.status === 401 || acc.status === 403 || acc.code === 1000 || acc.code === 9109 ? 'Der Cloudflare-Token wird nicht akzeptiert. Leg ihn mit der Vorlage „Edit Cloudflare Workers“ neu an und ersetze das Secret.' : 'Cloudflare-Konto nicht lesbar (' + acc.status + ' ' + acc.err + ').');
  const list = Array.isArray(acc.j.result) ? acc.j.result : [];
  if (!list.length) return fail('konto', 'Der Token hat keinen Zugriff auf ein Cloudflare-Konto. Wähle beim Token unter „Account Resources“ dein Konto aus.');
  const id = list[0].id;

  // 2) KV-Speicher (vorhandenen wiederverwenden, damit Schluessel und Abo erhalten bleiben)
  const kvs = await call('GET', '/accounts/' + id + '/storage/kv/namespaces?per_page=100');
  if (!kvs.ok) return fail('speicher', 'KV-Speicher nicht lesbar (' + kvs.status + ' ' + kvs.err + '). Der Token braucht „Workers KV Storage: Edit“ (in der Vorlage enthalten).');
  let ns = (kvs.j.result || []).find((n) => n.title === NAME);
  if (!ns) {
    const c = await call('POST', '/accounts/' + id + '/storage/kv/namespaces', { title: NAME });
    if (!c.ok) return fail('speicher', 'KV-Speicher konnte nicht angelegt werden (' + c.status + ' ' + c.err + ').');
    ns = c.j.result;
  }

  // 3) Worker hochladen (mit Speicher VS und ALLOWED_ORIGIN)
  const meta = { main_module: 'worker.js', compatibility_date: '2024-09-23',
    bindings: [{ type: 'kv_namespace', name: 'VS', namespace_id: ns.id }, { type: 'plain_text', name: 'ALLOWED_ORIGIN', text: origin }] };
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify(meta)], { type: 'application/json' }));
  form.append('worker.js', new Blob([code], { type: 'application/javascript+module' }), 'worker.js');
  const up = await call('PUT', '/accounts/' + id + '/workers/scripts/' + NAME, form, true);
  if (!up.ok) return fail('worker', 'Hochladen fehlgeschlagen (' + up.status + ' ' + up.err + ').');

  // 4) Takt alle 5 Minuten
  const cr = await call('PUT', '/accounts/' + id + '/workers/scripts/' + NAME + '/schedules', [{ cron: CRON }]);
  if (!cr.ok) return fail('takt', 'Takt alle 5 Minuten konnte nicht gesetzt werden (' + cr.status + ' ' + cr.err + ').');

  // 5) Adresse *.workers.dev: Konto-Subdomain anlegen, falls noch keine da ist
  let sub = await call('GET', '/accounts/' + id + '/workers/subdomain');
  let name = sub.ok && sub.j.result && sub.j.result.subdomain;
  if (!name) {
    const base = String(owner).toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 40) || 'valueslip';
    for (const cand of [base, base + '-vs', base + '-vs' + String(now()).slice(-4)]) {
      const s = await call('PUT', '/accounts/' + id + '/workers/subdomain', { subdomain: cand });
      if (s.ok) { name = (s.j.result && s.j.result.subdomain) || cand; break; }
    }
    if (!name) return fail('adresse', 'Konnte keine workers.dev-Adresse anlegen. Öffne einmal dash.cloudflare.com → Workers & Pages, dann noch einmal starten.');
  }
  const en = await call('POST', '/accounts/' + id + '/workers/scripts/' + NAME + '/subdomain', { enabled: true, previews_enabled: false });
  if (!en.ok) return fail('adresse', 'Adresse konnte nicht freigeschaltet werden (' + en.status + ' ' + en.err + ').');
  status.url = 'https://' + NAME + '.' + name + '.workers.dev';

  // 6) Pruefen, ob der Dienst antwortet (neue Adressen brauchen manchmal etwas)
  for (let i = 0; i < 12; i++) {
    try {
      const r = await fetchFn(status.url + '/push/key', { headers: { Origin: origin } });
      if (r.ok) { const j = await r.json(); if (j && j.key) { status.ok = true; status.step = 'fertig'; status.msg = 'Push-Dienst läuft.'; return status; } }
    } catch (e) { /* noch nicht erreichbar */ }
    await sleep(10000);
  }
  status.ok = true; status.step = 'fertig';
  status.msg = 'Eingerichtet. Die Adresse ist evtl. erst in ein paar Minuten erreichbar.';
  return status;
}

// Token auch finden, wenn das Secret leicht anders heisst oder als Variable angelegt wurde (nur Namen werden gemeldet, nie Werte)
function parse(j) { try { const o = JSON.parse(j || '{}'); return o && typeof o === 'object' ? o : {}; } catch (e) { return {}; } }
function names(j) { return Object.keys(parse(j)).filter((k) => k.toLowerCase() !== 'github_token'); }
export function findToken(env) {
  for (const k of ['CLOUDFLARE_API_TOKEN', 'CF_API_TOKEN', 'CLOUDFLARE_TOKEN', 'CLOUDFLARE_API_TOKEN_VAR', 'CLOUFLARE_API_TOKEN', 'CLOUFLARE_API_KEY']) if (env[k] && env[k].trim()) return env[k].trim();
  const all = Object.assign({}, parse(env.ALL_VARS), parse(env.ALL_SECRETS));
  delete all.github_token; delete all.GITHUB_TOKEN;
  const keys = Object.keys(all);
  const named = keys.find((k) => /cloud|^cf|token/i.test(k) && typeof all[k] === 'string' && all[k].trim());
  if (named) return all[named].trim();
  const shaped = keys.filter((k) => typeof all[k] === 'string' && /^[A-Za-z0-9_-]{35,80}$/.test(all[k].trim()));
  return shaped.length === 1 ? all[shaped[0]].trim() : '';
}
// Kurzbericht aus dem Push-Speicher (ohne Schluessel, Abo oder eingetragene Quoten): hilft bei der Fehlersuche
export async function diag({ token, fetchFn = fetch }) {
  const H = { Authorization: 'Bearer ' + token };
  const get = async (path) => { const r = await fetchFn(API + path, { headers: H }); try { return await r.json(); } catch (e) { return null; } };
  const acc = await get('/accounts?per_page=50'); const id = acc && acc.result && acc.result[0] && acc.result[0].id;
  if (!id) return { ok: false };
  const kvs = await get('/accounts/' + id + '/storage/kv/namespaces?per_page=100');
  const ns = kvs && (kvs.result || []).find((n) => n.title === NAME);
  if (!ns) return { ok: false };
  const val = async (k) => { const r = await fetchFn(API + '/accounts/' + id + '/storage/kv/namespaces/' + ns.id + '/values/' + k, { headers: H }); if (!r.ok) return null; try { return JSON.parse(await r.text()); } catch (e) { return null; } };
  const user = (await val('user')) || {}, st = (await val('state')) || {};
  const leagues = {};
  (user.games || []).forEach((g) => {
    const l = leagues[g.lkey] || (leagues[g.lkey] = { games: 0, withOdds: 0, lastOdds: 0, next: null });
    l.games++; if (g.ref && g.ref.h > 1) { l.withOdds++; l.lastOdds = Math.max(l.lastOdds, g.oddsAt || 0); }
    const ko = Date.parse(g.kickoff); if (!l.next || ko < l.next) l.next = ko;
  });
  Object.values(leagues).forEach((l) => { l.lastOdds = l.lastOdds ? new Date(l.lastOdds).toISOString() : null; l.next = l.next ? new Date(l.next).toISOString() : null; });
  const cfg = Object.assign({}, user.cfg || {}); delete cfg.prov;
  return { ok: true, at: new Date().toISOString(), synced: !!user.games, subscribed: !!(user.sub && user.sub.endpoint), cfg, books: user.cfg && user.cfg.prov,
    quotaApp: user.quota || null, quotaWorker: st.quota || null, spent: st.spent || null, opSpent: st.opSpent || null,
    op: user.op ? { tours: Object.keys(user.op.tours || {}), remaining: user.op.remaining, calls: user.op.calls } : null,
    autoMatched: Object.keys(user.auto || {}).length, ownOdds: Object.keys(user.ov || {}).length, openLegs: (user.legs || []).length,
    leagues, log: (st.log || []).slice(-15).map((x) => ({ at: new Date(x.at).toISOString(), t: x.t })) };
}
if (process.argv[1] && process.argv[1].endsWith('deploy.mjs')) {
  const code = readFileSync(new URL('worker.js', DIR), 'utf8');
  const st = await deploy({ token: findToken(process.env), owner: process.env.GITHUB_REPOSITORY_OWNER, code });
  writeFileSync(new URL('status.json', DIR), JSON.stringify(st, null, 2) + '\n');
  try { if (st.ok) writeFileSync(new URL('diag.json', DIR), JSON.stringify(await diag({ token: findToken(process.env) }), null, 2) + '\n'); } catch (e) { console.log('diag', e.message); }
  console.log(JSON.stringify(st));
  if (!st.ok) process.exitCode = 1;
}
