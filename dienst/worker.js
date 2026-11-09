// Value Slip Dienst fuer Cloudflare Workers (kostenlos). Zwei Aufgaben:
// 1) Push: Erinnerung vor Anpfiff, Value-Alarm und Schlussquote. Laeuft alle 5 Minuten, auch wenn die App zu ist.
// 2) Zwischendienst: leitet Abrufe der App an The Odds API weiter (nur noetig, wenn der direkte Abruf blockiert wird).
//
// Einrichtung (Anleitung auch in der App unter Einstellungen > Benachrichtigungen):
//   Settings > Variables and Secrets:  ALLOWED_ORIGIN (Text, PFLICHT) = Adresse deiner App ohne Pfad, z. B. https://deinname.github.io
//   Bindings > KV namespace:           Variable name VS, dazu einen neuen KV-Speicher anlegen (Name egal, z. B. value-slip)
//   Settings > Trigger Events > Cron:  */5 * * * *   (alle 5 Minuten)
//
// Sicherheit: Nur deine App-Adresse darf zugreifen. Das erste Geraet, das Push einschaltet, wird Besitzer; jedes andere Geraet
// wird abgewiesen. Zum Zuruecksetzen im KV-Speicher den Eintrag "owner" loeschen.
// Den API-Schluessel schickt die App, er liegt nur in deinem KV-Speicher und wird nur fuer die Push-Abrufe benutzt.
//
// Diese Datei wird automatisch erzeugt. Der Block "App-Logik" ist eine Kopie aus der App, damit Value hier exakt gleich gerechnet wird.

const WORKER_VER = '180d3d0c0f';
const UPSTREAM = 'https://api.the-odds-api.com';
const QUOTA_HEADERS = ['x-requests-remaining', 'x-requests-used', 'x-requests-last'];
// Nur diese Parameter und Werte reicht der Zwischendienst weiter (so kann niemand teure Abfragen ueber ihn laufen lassen)
const ALLOWED_PARAMS = ['apiKey', 'bookmakers', 'markets', 'oddsFormat', 'dateFormat', 'commenceTimeFrom', 'commenceTimeTo', 'daysFrom', 'eventIds'];
const ALLOWED_BOOKMAKERS = ['pinnacle'];
const ALLOWED_MARKETS = ['h2h', 'spreads', 'totals'];

function cors(allowed) {
  return {
    'Access-Control-Allow-Origin': allowed,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Accept, Content-Type',
    'Access-Control-Expose-Headers': QUOTA_HEADERS.join(', '),
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
}
const json = (status, msg, headers) => new Response(JSON.stringify({ message: msg }), { status, headers: { ...headers, 'Content-Type': 'application/json' } });
const jsonData = (data, headers) => new Response(JSON.stringify(data), { status: 200, headers: { ...headers, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
const listOk = (v, allowed) => v.split(',').every((x) => allowed.includes(x)) && v.split(',').length <= allowed.length;
const originOf = (env) => (env.ALLOWED_ORIGIN || '').trim().replace(/\/+$/, '');

// OddsPapi weiterleiten (falls der Browser den direkten Abruf blockiert); nur Lese-Endpunkte, Schluessel kommt von der App
const OP_PATHS = ['account', 'sports', 'bookmakers', 'tournaments', 'markets', 'odds-by-tournaments'];
const OP_PARAMS = ['apiKey', 'sportId', 'bookmaker', 'tournamentIds', 'oddsFormat', 'language'];
async function opProxy(request, headers) {
  if (request.method !== 'GET') return json(405, 'Method not allowed', headers);
  const url = new URL(request.url);
  const m = /^\/op\/v4\/([a-z-]+)$/.exec(url.pathname);
  if (!m || !OP_PATHS.includes(m[1])) return json(404, 'Not found', headers);
  const target = new URL('https://api.oddspapi.io/v4/' + m[1]);
  for (const [k, v] of url.searchParams) {
    if (!OP_PARAMS.includes(k)) return json(400, 'Parameter not allowed: ' + k, headers);
    target.searchParams.set(k, v);
  }
  if (!target.searchParams.get('apiKey')) return json(401, 'Missing API key', headers);
  const upstream = await fetch(target.toString(), { headers: { Accept: 'application/json' } });
  const out = new Headers(headers);
  out.set('Content-Type', upstream.headers.get('Content-Type') || 'application/json');
  out.set('Cache-Control', 'no-store');
  return new Response(upstream.body, { status: upstream.status, headers: out });
}
async function proxy(request, headers, env) {
  if (request.method !== 'GET') return json(405, 'Method not allowed', headers);
  const url = new URL(request.url);
  if (!/^\/v4\/sports\/([a-z0-9_]+\/(odds|events|scores)\/)?$/.test(url.pathname)) return json(404, 'Not found', headers);
  const target = new URL(UPSTREAM + url.pathname);
  for (const [k, v] of url.searchParams) {
    if (!ALLOWED_PARAMS.includes(k)) return json(400, 'Parameter not allowed: ' + k, headers);
    if (k === 'bookmakers' && !listOk(v, ALLOWED_BOOKMAKERS)) return json(400, 'Bookmaker not allowed', headers);
    if (k === 'markets' && !listOk(v, ALLOWED_MARKETS)) return json(400, 'Market not allowed', headers);
    target.searchParams.set(k, v);
  }
  if (url.pathname.endsWith('/odds/') && !target.searchParams.get('bookmakers')) return json(400, 'bookmakers required', headers);
  if (target.searchParams.has('daysFrom') && !/^[1-3]$/.test(target.searchParams.get('daysFrom'))) return json(400, 'daysFrom 1-3', headers);
  if (env.ODDS_API_KEY) target.searchParams.set('apiKey', env.ODDS_API_KEY);
  if (!target.searchParams.get('apiKey')) return json(401, 'Missing API key', headers);
  const upstream = await fetch(target.toString(), { headers: { Accept: 'application/json' } });
  const out = new Headers(headers);
  out.set('Content-Type', upstream.headers.get('Content-Type') || 'application/json');
  for (const h of QUOTA_HEADERS) {
    const v = upstream.headers.get(h);
    if (v != null) out.set(h, v);
  }
  out.set('Cache-Control', 'no-store');
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

// ---------------------------------------------------------------------------------------------------------------
// App-Logik (automatisch aus index.html eingefuegt, nicht von Hand aendern)
const APP = (function () {
function parseNum(v){ var n = parseFloat(String(v == null ? '' : v).replace(',', '.')); return isFinite(n) ? n : NaN; }

var SPORTS = {
  fb: { name: 'Fußball',    unit: 'Tore',    ph: '2,5' },
  bb: { name: 'Basketball', unit: 'Punkte',  ph: '224,5' },
  ih: { name: 'Eishockey',  unit: 'Tore',    ph: '5,5' }
};

// Wahrscheinlichkeiten ohne Buchmacher-Marge. prop = proportional, power = Potenz-Methode (beruecksichtigt Favoriten-Aussenseiter-Verzerrung)
function fairProbs(odds, method){
  var inv = odds.map(function(o){ return 1 / o; });
  var s = inv.reduce(function(a, b){ return a + b; }, 0);
  if (method === 'prop' || s <= 1) return inv.map(function(x){ return x / s; });
  var lo = 1, hi = 12;
  for (var i = 0; i < 70; i++){
    var k = (lo + hi) / 2;
    var f = inv.reduce(function(a, x){ return a + Math.pow(x, k); }, 0);
    if (f > 1) lo = k; else hi = k;
  }
  var kk = (lo + hi) / 2;
  var p = inv.map(function(x){ return Math.pow(x, kk); });
  var t = p.reduce(function(a, b){ return a + b; }, 0);
  return p.map(function(x){ return x / t; });
}

// Nur halbe Linien (2,5 / 5,5 / 224,5): kein Push, also genau zwei Ausgaenge.
function isHalfLine(line){
  if (!(line > 0)) return false;
  var d = line * 2;
  return Math.abs(d - Math.round(d)) < 1e-9 && Math.round(d) % 2 === 1;
}
function fmtLine(line){ return String(line).replace('.', ','); }
// Handicap-Linie mit Vorzeichen: -5.5 -> "−5,5", 1.5 -> "+1,5"
function fmtHc(line){ return line === 0 ? '0' : (line > 0 ? '+' : '−') + fmtLine(Math.abs(line)); }
function isHcLine(line){ return typeof line === 'number' && isHalfLine(Math.abs(line)); }
// Asiatisches Handicap (Fussball): Viertel-, halbe und ganze Linien bis +-5
function isAhLine(line){ return typeof line === 'number' && isFinite(line) && Math.abs(line) <= 5 && Math.abs(line * 4 - Math.round(line * 4)) < 1e-9; }
function hcLineOk(sport, line){ return (sport || 'fb') === 'fb' ? isAhLine(line) : isHcLine(line); }

var MARKETS = { res: 'Ergebnis', dc: 'Doppelte Chance', ou: 'Über/Unter', hc: 'Handicap', x: 'Weitere Märkte' };

// Torverteilungsmodell (Dixon-Coles): Torerwartung beider Teams so bestimmen, dass das Modell die marginfreien
// Marktchancen fuer 1, X, 2 und Ueber/Unter trifft. Daraus folgen Chancen fuer weitere Fussballmaerkte.
var DC_RHO = -0.06, MAXG = 10;
function poissonPmf(l){ var p = [Math.exp(-l)]; for (var k = 1; k <= MAXG; k++) p[k] = p[k - 1] * l / k; return p; }
function scoreMatrix(lh, la){
  var ph = poissonPmf(lh), pa = poissonPmf(la), M = [], tot = 0;
  for (var i = 0; i <= MAXG; i++){
    M[i] = [];
    for (var j = 0; j <= MAXG; j++){
      var t = 1;
      if (i === 0 && j === 0) t = 1 - lh * la * DC_RHO; else if (i === 0 && j === 1) t = 1 + lh * DC_RHO;
      else if (i === 1 && j === 0) t = 1 + la * DC_RHO; else if (i === 1 && j === 1) t = 1 - DC_RHO;
      M[i][j] = Math.max(0, ph[i] * pa[j] * t); tot += M[i][j];
    }
  }
  for (i = 0; i <= MAXG; i++) for (j = 0; j <= MAXG; j++) M[i][j] /= tot;
  return M;
}
function sumWhere(M, f){ var s = 0; for (var i = 0; i <= MAXG; i++) for (var j = 0; j <= MAXG; j++) if (f(i, j)) s += M[i][j]; return s; }
function modelErr(M, tg){
  var e = Math.pow(sumWhere(M, function(i, j){ return i > j; }) - tg.h, 2) + Math.pow(sumWhere(M, function(i, j){ return i === j; }) - tg.d, 2) +
          Math.pow(sumWhere(M, function(i, j){ return i < j; }) - tg.a, 2);
  if (tg.ouLine != null) e += Math.pow(sumWhere(M, function(i, j){ return i + j > tg.ouLine; }) - tg.ouP, 2);
  return e;
}
var fitCache = {};
function fitGoals(tg){
  var ck = [tg.h, tg.d, tg.a, tg.ouLine, tg.ouP].map(function(x){ return x == null ? '-' : x.toFixed(6); }).join('|');
  if (fitCache[ck]) return fitCache[ck];
  var x = [Math.log(1.4), Math.log(1.1)], step = 0.5;
  var cur = modelErr(scoreMatrix(Math.exp(x[0]), Math.exp(x[1])), tg);
  for (var it = 0; it < 400 && step > 1e-5; it++){
    var improved = false;
    for (var d = 0; d < 2; d++) for (var sg = -1; sg <= 1; sg += 2){
      var y = x.slice(); y[d] += sg * step;
      if (y[d] < Math.log(0.05) || y[d] > Math.log(6)) continue;
      var e = modelErr(scoreMatrix(Math.exp(y[0]), Math.exp(y[1])), tg);
      if (e < cur){ cur = e; x = y; improved = true; }
    }
    if (!improved) step /= 2;
  }
  var res = { lh: Math.exp(x[0]), la: Math.exp(x[1]), M: scoreMatrix(Math.exp(x[0]), Math.exp(x[1])), err: Math.sqrt(cur / (tg.ouLine != null ? 4 : 3)) };
  var keys = Object.keys(fitCache); if (keys.length > 300) fitCache = {};
  fitCache[ck] = res;
  return res;
}
// Weitere Fussballmaerkte mit Modell-Chance. Nur halbe Linien, also immer genau Gewinn oder Verlust.
// Faire Chancen aus geladenen Pinnacle-Paaren (z. B. Beide treffen Ja/Nein), Schluessel wie in extraMarkets
function pinExtraProbs(m, method){
  var out = {};
  (Array.isArray(m.xpairs) ? m.xpairs : []).forEach(function(pr){
    if (!pr || !Array.isArray(pr.keys) || !Array.isArray(pr.odds) || pr.odds.length !== 2 || !(pr.odds[0] > 1 && pr.odds[1] > 1)) return;
    var f = fairProbs(pr.odds, method);
    pr.keys.forEach(function(k, i){ if (k && f[i] > 0.001 && f[i] < 0.999) out[k] = f[i]; });
  });
  return out;
}
function extraMarkets(m, method){
  var ref = m.ref || {};
  if ((m.sport || 'fb') !== 'fb' || !(ref.h > 1 && ref.d > 1 && ref.a > 1)) return [];
  var f = fairProbs([ref.h, ref.d, ref.a], method);
  var tg = { h: f[0], d: f[1], a: f[2], ouLine: null, ouP: null };
  if (m.ou && isHalfLine(m.ou.line) && m.ou.ref && m.ou.ref.o > 1 && m.ou.ref.u > 1){ tg.ouLine = m.ou.line; tg.ouP = fairProbs([m.ou.ref.o, m.ou.ref.u], method)[0]; }
  var fit = fitGoals(tg), M = fit.M, H = m.home, A = m.away;
  var P = function(fn){ return sumWhere(M, fn); };
  var out = [];
  // Vorsichtsabschlag: Modell-Chancen sind unsicherer als Marktquoten (ohne Ue/U-Markt noch mehr)
  var unc = 0.02 + fit.err + (tg.ouLine == null ? 0.03 : 0);
  // Geladene Pinnacle-Quoten fuer weitere Maerkte ersetzen die Modell-Chance (ohne Abschlag, es ist der Markt selbst)
  var pin = pinExtraProbs(m, method);
  var add = function(key, group, label, p){
    if (pin[key] != null){ out.push({ key: key, group: group, label: label, praw: pin[key], p: pin[key], model: false }); return; }
    if (p > 0.001 && p < 0.999) out.push({ key: key, group: group, label: label, praw: p, p: Math.max(0.002, p - unc), model: true });
  };
  [0.5, 1.5, 2.5, 3.5, 4.5].forEach(function(L){
    if (tg.ouLine === L) return;
    var po = P(function(i, j){ return i + j > L; }), k = String(L).replace('.', '');
    add('o' + k, 'Tore', 'Über ' + fmtLine(L) + ' Tore', po); add('u' + k, 'Tore', 'Unter ' + fmtLine(L) + ' Tore', 1 - po);
  });
  var bt = P(function(i, j){ return i > 0 && j > 0; });
  add('btsy', 'Beide treffen', 'Beide treffen: Ja', bt); add('btsn', 'Beide treffen', 'Beide treffen: Nein', 1 - bt);
  add('h05', 'Team-Tore', H + ' trifft (Über 0,5)', P(function(i){ return i > 0; }));
  add('h15', 'Team-Tore', H + ' Über 1,5 Tore', P(function(i){ return i > 1; }));
  add('a05', 'Team-Tore', A + ' trifft (Über 0,5)', P(function(i, j){ return j > 0; }));
  add('a15', 'Team-Tore', A + ' Über 1,5 Tore', P(function(i, j){ return j > 1; }));
  var hm = P(function(i, j){ return i - j >= 2; }), am = P(function(i, j){ return j - i >= 2; });
  add('hm15', 'Handicap', H + ' −1,5', hm); add('ap15', 'Handicap', A + ' +1,5', 1 - hm);
  add('am15', 'Handicap', A + ' −1,5', am); add('hp15', 'Handicap', H + ' +1,5', 1 - am);
  add('ho15', 'Kombi', H + ' siegt & Über 1,5', P(function(i, j){ return i > j && i + j > 1; }));
  add('ao15', 'Kombi', A + ' siegt & Über 1,5', P(function(i, j){ return j > i && i + j > 1; }));
  add('hxu35', 'Kombi', H + ' oder Remis & Unter 3,5', P(function(i, j){ return i >= j && i + j < 4; }));
  add('xau35', 'Kombi', 'Remis oder ' + A + ' & Unter 3,5', P(function(i, j){ return j >= i && i + j < 4; }));
  out.fitErr = fit.err; out.lh = fit.lh; out.la = fit.la; out.unc = unc; out.noOu = tg.ouLine == null;
  return out;
}
var DC_KEYS = ['hx', 'xa', 'ha'];

function selectionsFor(m, method){
  var out = [];
  var sport = m.sport && SPORTS[m.sport] ? m.sport : 'fb';
  var sp = SPORTS[sport];
  var prov = m.bookName || 'Betano';
  // Wettsteuer des Anbieters: Anteil der Auszahlung, der bei dir ankommt (Betano: 0,947; bet365: 1)
  var tf = m.taxF > 0 && m.taxF <= 1 ? m.taxF : 1;
  var base = { mid: m.id, game: m.home + ' – ' + m.away, league: m.league, lkey: m.lkey || '', kickoff: m.kickoff || null, sport: sport, sample: !!m.sample, prov: prov };
  var ref = m.ref || {}, book = m.book || {};
  var push = function(market, key, label, p, b, line){
    var tag = market + '.' + key;
    var src = (m.ovf && m.ovf[tag]) ? prov : ((m.bsrc && m.bsrc[tag]) || prov);
    out.push(Object.assign({}, base, { market: market, key: key, label: label, p: p, fairOdds: 1 / p, book: b, tf: tf, evRaw: p * b - 1, ev: p * b * tf - 1, src: src, line: line == null ? null : line }));
  };
  // Ergebnis-Markt
  if (ref.h > 1 && ref.a > 1){
    var three = ref.d > 1;
    var keys = three ? ['h', 'd', 'a'] : ['h', 'a'];
    var fair = fairProbs(keys.map(function(k){ return ref[k]; }), method);
    keys.forEach(function(k, i){
      var b = book[k];
      if (!(b > 1)) return;
      push('res', k, k === 'h' ? m.home : (k === 'a' ? m.away : 'Unentschieden'), fair[i], b);
    });
    // Doppelte Chance (nur Fussball): Chance = Summe zweier fairer 1X2-Chancen
    if (sport === 'fb' && three && m.dc){
      var pdc = { hx: fair[0] + fair[1], xa: fair[1] + fair[2], ha: fair[0] + fair[2] };
      var ldc = { hx: m.home + ' oder Remis', xa: 'Remis oder ' + m.away, ha: m.home + ' oder ' + m.away };
      DC_KEYS.forEach(function(k){
        var b = m.dc && m.dc[k];
        if (b > 1 && pdc[k] < 1) push('dc', k, ldc[k], pdc[k], b);
      });
    }
  }
  // Handicap (Basketball, Eishockey): Linie gilt fuer das Heimteam, nur halbe Linien (kein Push)
  var hc = m.hc;
  // Fussball: asiatisches Handicap auch mit Viertel- und ganzen Linien. Dort ist die "Chance" die faire Chance ohne
  // Rueckerstattungen (aus Pinnacle ohne Marge); Value = Quote / faire Quote - 1, wie im Markt ueblich.
  if (hc && hcLineOk(sport, hc.line) && hc.ref && hc.ref.h > 1 && hc.ref.a > 1){
    var fh = fairProbs([hc.ref.h, hc.ref.a], method);
    var split = !isHalfLine(Math.abs(hc.line));
    if (hc.book && hc.book.h > 1){ push('hc', 'h', m.home + ' ' + fmtHc(hc.line), fh[0], hc.book.h, hc.line); out[out.length - 1].split = split; }
    if (hc.book && hc.book.a > 1){ push('hc', 'a', m.away + ' ' + fmtHc(-hc.line), fh[1], hc.book.a, hc.line); out[out.length - 1].split = split; }
  }
  // Ueber/Unter-Markt
  var ou = m.ou;
  if (ou && isHalfLine(ou.line) && ou.ref && ou.ref.o > 1 && ou.ref.u > 1){
    var f = fairProbs([ou.ref.o, ou.ref.u], method);
    [['o', 'Über', 0], ['u', 'Unter', 1]].forEach(function(t){
      var b = ou.book && ou.book[t[0]];
      if (b > 1) push('ou', t[0], t[1] + ' ' + fmtLine(ou.line) + ' ' + sp.unit, f[t[2]], b, ou.line);
    });
  }
  return out;
}

function passes(sel, st){
  return (!st.sport || st.sport === 'all' || sel.sport === st.sport) &&
         (!st.market || st.market === 'all' || sel.market === st.market);
}

var MODES = {
  hit:      { name: 'Treffer',    leg: function(s){ return s.ev >= -0.05; },                  score: function(p, o){ return p; } },
  safe:     { name: 'Sicher',     leg: function(s){ return s.ev >= 0 && s.p >= 0.5; },        score: function(p, o){ return p; } },
  balanced: { name: 'Ausgewogen', leg: function(s, st){ return s.ev >= st.minEdge; },        score: function(p, o){ return p; } },
  value:    { name: 'Value',      leg: function(s, st){ return s.ev >= st.minEdge; },        score: function(p, o){ return p * o - 1; } }
};

// Pro Spiel hoechstens ein Tipp: alle Maerkte desselben Spiels haengen zusammen.
// Exakte Suche mit Schranken (Branch and Bound): jeder Tipp jedes Spiels wird beruecksichtigt,
// Aeste werden nur abgeschnitten, wenn sie beweisbar keinen besseren Schein mehr liefern koennen.
var MAX_MATCHES = 60;
// Sicherheitsnetz: bei kuenstlich gleichfoermigen Daten (viele exakt gleiche Spiele) stoppt die Suche nach so vielen Schritten
// und liefert die besten bis dahin gefundenen Scheine (approx = true). Bei echten Spieltagen wird die Grenze nicht erreicht.
var SEARCH_BUDGET = 1500000;
function buildSlips(matches, st){
  var mode = MODES[st.mode];
  var byP = st.mode !== 'value';
  var cands = [], singles = [];
  matches.forEach(function(m){
    var list = selectionsFor(m, st.devig).filter(function(x){ return passes(x, st) && mode.leg(x, st); });
    list.forEach(function(x){ singles.push(x); });
    if (!list.length) return;
    list.sort(byP ? function(a, b){ return (b.p - a.p) || (b.ev - a.ev); } : function(a, b){ return (b.ev - a.ev) || (b.p - a.p); });
    cands.push(list);
  });
  singles.sort(function(a, b){ return b.ev - a.ev; });
  // Bei mehr als MAX_MATCHES Spielen: in Chance-Modi die Spiele mit den sichersten Tipps behalten, sonst die mit dem meisten Value
  var bestOf = function(l){ return l.reduce(function(a, x){ return Math.max(a, byP ? x.p : x.ev); }, -1); };
  cands.sort(function(a, b){ return bestOf(b) - bestOf(a); });
  cands = cands.slice(0, MAX_MATCHES);
  var n = cands.length, K = st.maxLegs;
  // Fuer jede Startposition i: die groessten Quoten bzw. Value-Faktoren der restlichen Spiele (je Spiel das Maximum), absteigend
  var sufBook = [], sufFac = [];
  for (var i = n; i >= 0; i--){
    var bk = [], fc = [];
    for (var j = i; j < n; j++){
      var mb = 1, mf = 1;
      cands[j].forEach(function(x){ if (x.book > mb) mb = x.book; if (1 + x.ev > mf) mf = 1 + x.ev; });
      bk.push(mb); fc.push(mf);
    }
    bk.sort(function(a, b){ return b - a; }); fc.sort(function(a, b){ return b - a; });
    sufBook[i] = bk; sufFac[i] = fc;
  }
  var prodTop = function(arr, k){ var r = 1; for (var q = 0; q < k && q < arr.length; q++) r *= arr[q]; return r; };
  var top = [], steps = 0, approx = false;
  function cmp(a, b){ return (b.score - a.score) || (b.ev - a.ev); }
  function consider(legs, odds, p){
    var sl = { legs: legs.slice(), odds: odds, p: p, ev: p * odds - 1, score: mode.score(p, odds) };
    if (top.length < 3 || cmp(sl, top[top.length - 1]) < 0){
      top.push(sl); top.sort(cmp); if (top.length > 3) top.pop();
    }
  }
  function dfs(i, chosen, odds, p){
    if (++steps > SEARCH_BUDGET){ approx = true; return; }
    if (chosen.length && odds >= st.target - 1e-9) consider(chosen, odds, p);
    var left = K - chosen.length;
    if (left <= 0 || i >= n) return;
    // Zielquote mit den verbleibenden Tipps ueberhaupt erreichbar?
    if (odds * prodTop(sufBook[i], left) < st.target - 1e-9) return;
    if (top.length === 3){
      var worst = top[2].score;
      var fac = prodTop(sufFac[i], left);
      // Chance-Modi: jeder Tipp hat Chance = (1 + Value) / Quote. Wer noch den Faktor target/odds an Quote braucht,
      // verliert mindestens diesen Faktor an Chance, gewinnt aber hoechstens die besten Value-Faktoren zurueck.
      // Value-Modus: der Score steigt hoechstens um die besten verbleibenden Value-Faktoren.
      var bound = byP ? p * Math.min(1, odds >= st.target ? 1 : fac * odds / st.target) : p * odds * fac - 1;
      if (bound <= worst + 1e-15) return;
    }
    for (var j = i; j < n; j++){
      for (var c = 0; c < cands[j].length; c++){
        var s = cands[j][c];
        chosen.push(s);
        dfs(j + 1, chosen, odds * s.book, p * s.p);
        chosen.pop();
      }
    }
  }
  dfs(0, [], 1, 1);
  return { slips: top, singles: singles, approx: approx };
}

// Feste Regel fuer die besten Wetten (keine Zielquote, keine Modi):
// 1. Nur 2er- und 3er-Kombis, pro Spiel hoechstens ein Tipp.
// 2. Jeder Tipp braucht mindestens den Mindest-Value (Einstellung, Standard 2 %) und eine Quote ab RULE.minLeg.
// 3. Gesamtquote mindestens RULE.minSlip.
// 4. Rangfolge: erwartetes Bankroll-Wachstum (Kelly-Wachstum) mit dem Einsatz, den die App empfiehlt.
//    Das gewichtet Trefferchance und Value gemeinsam: hoher Value bei kleiner Chance zaehlt weniger als
//    etwas weniger Value bei deutlich hoeherer Chance.
// 5. Hoechstens 3 Scheine; zwei Scheine teilen sich hoechstens einen Tipp, damit sie wirklich verschieden sind.
var RULE = { minLeg: 1.2, minSlip: 1.5, minLegs: 2, maxLegs: 3, show: 3, maxCands: 150, pool: 60 };
// Zweite feste Regel "Hohe Trefferchance": jeder Tipp mit mindestens 60 % Chance und nicht negativem Value (0 % oder mehr),
// 2er/3er-Kombi mit Gesamtquote ab 1,50, sortiert nach Trefferchance. Einzelwetten ab 65 % Chance.
var SAFE = { minP: 0.6, minEv: 0, show: 2, singleMinP: 0.65 };
function slipStakeFrac(p, o, st){ var k = kellyFull(p, o); return k > 0 ? Math.min(k * (st.kelly || 0.25), 0.03) : 0; }
function slipGrowth(p, o, st){
  var f = slipStakeFrac(p, o, st);
  if (!(f > 0)) return 0;
  return p * Math.log(1 + f * (o - 1)) + (1 - p) * Math.log(1 - f);
}
function legSig(l){ return l.mid + '|' + l.market + '|' + l.key; }
// Alle 2er- und 3er-Kombis aus den Kandidaten durchgehen; score(p, odds) bewertet, keep(p, odds) filtert.
// score(p, effektive Quote); keep(p, Quote); minEv: Mindest-Value des ganzen Scheins nach Steuer
function enumCombos(legs, score, keep, poolSize, minEv){
  var n = legs.length, pool = [], worst = -Infinity;
  function add(ls, p, o){
    if (!keep(p, o)) return;
    var tf = ls[0].tf || 1;
    if (minEv != null && p * o * tf - 1 < minEv - 1e-12) return;
    var sc = score(p, o * tf);
    if (pool.length >= poolSize && sc <= worst) return;
    pool.push({ legs: ls, odds: o, eff: o * (ls[0].tf || 1), p: p, ev: p * o * (ls[0].tf || 1) - 1, score: sc });
    if (pool.length > poolSize * 2){ pool.sort(cmpSlip); pool.length = poolSize; worst = pool[poolSize - 1].score; }
  }
  for (var i = 0; i < n; i++){
    var a = legs[i];
    for (var j = i + 1; j < n; j++){
      var b = legs[j];
      // eine Kombi setzt du bei einem Anbieter: alle Tipps muessen vom selben Anbieter sein
      if (b.mid === a.mid || b.prov !== a.prov) continue;
      var p2 = a.p * b.p, o2 = a.book * b.book;
      if (RULE.minLegs <= 2) add([a, b], p2, o2);
      if (RULE.maxLegs < 3) continue;
      for (var k = j + 1; k < n; k++){
        var c = legs[k];
        if (c.mid === a.mid || c.mid === b.mid || c.prov !== a.prov) continue;
        add([a, b, c], p2 * c.p, o2 * c.book);
      }
    }
  }
  pool.sort(cmpSlip);
  return pool.slice(0, poolSize);
}
function cmpSlip(a, b){ return (b.score - a.score) || (b.p - a.p) || (b.ev - a.ev); }
// Aus der Rangliste die besten Scheine, die sich hoechstens einen Tipp teilen
function diverse(pool, count){
  var out = [];
  for (var i = 0; i < pool.length && out.length < count; i++){
    var sigs = pool[i].legs.map(legSig);
    var clash = out.some(function(o){ var os = o.legs.map(legSig); return sigs.filter(function(x){ return os.indexOf(x) >= 0; }).length >= 2; });
    if (!clash) out.push(pool[i]);
  }
  return out;
}
function bestBets(matches, st){
  var all = [];
  matches.forEach(function(m){ selectionsFor(m, st.devig).forEach(function(x){ if (passes(x, st) && x.book >= RULE.minLeg) all.push(x); }); });
  var minEdge = st.minEdge == null ? 0.02 : st.minEdge;
  // Einzeltipp: Value nach Steuer. In Kombis zieht der Anbieter die Steuer nur einmal ab, daher gilt dort:
  // jeder Tipp mit Value vor Steuer UND der ganze Schein mit Value nach Steuer.
  var value = all.filter(function(x){ return x.ev >= minEdge; });
  var comboLegs = all.filter(function(x){ return (x.evRaw != null ? x.evRaw : x.ev) >= minEdge && !x.split; });
  value.sort(function(a, b){ return b.ev - a.ev || b.p - a.p; });
  comboLegs.sort(function(a, b){ return slipGrowth(b.p, b.book, st) - slipGrowth(a.p, a.book, st) || b.p - a.p; });
  var capped = comboLegs.length > RULE.maxCands;
  var vc = comboLegs.slice(0, RULE.maxCands);
  var pool = enumCombos(vc, function(p, o){ return slipGrowth(p, o, st); }, function(p, o){ return o >= RULE.minSlip - 1e-9; }, RULE.pool, minEdge);
  var slips = diverse(pool, RULE.show);
  // Hohe Trefferchance: sichere Tipps mit kleinem, aber nie negativem Value; Scheine, die schon oben stehen, nicht doppelt
  var sure = all.filter(function(x){ return x.p >= SAFE.minP && (x.evRaw != null ? x.evRaw : x.ev) >= SAFE.minEv - 1e-12 && !x.split; });
  var sureSingles = all.filter(function(x){ return x.p >= SAFE.minP && x.ev >= SAFE.minEv - 1e-12; });
  sure.sort(function(a, b){ return (b.p - a.p) || (b.ev - a.ev); });
  var sigOf = function(sl){ return sl.legs.map(legSig).sort().join(','); };
  var taken = {}; slips.forEach(function(sl){ taken[sigOf(sl)] = true; });
  var spool = enumCombos(sure.slice(0, RULE.maxCands), function(p, o){ return p + (p * o - 1) * 1e-6; }, function(p, o){ return o >= RULE.minSlip - 1e-9; }, RULE.pool, SAFE.minEv)
    .filter(function(sl){ return !taken[sigOf(sl)]; });
  var safeSlips = diverse(spool, SAFE.show);
  var singles = value.slice().sort(function(a, b){ return b.ev - a.ev; });
  var safeSingles = sureSingles.filter(function(x){ return x.p >= SAFE.singleMinP && x.ev < minEdge; }).sort(function(a, b){ return (b.p - a.p) || (b.ev - a.ev); });
  return { slips: slips, safeSlips: safeSlips, singles: singles, safeSingles: safeSingles, capped: capped, valueLegs: value.length, sureLegs: sure.length };
}

// Geladene Tagesdaten (von Claude in den Datenspeicher geschrieben) pruefen und vereinheitlichen.
function feedOdd(x){ return typeof x === 'number' && isFinite(x) && x > 1 && x < 1000 ? Math.round(x * 1000) / 1000 : null; }
function feedStr(x, max){ return typeof x === 'string' ? x.slice(0, max || 80) : ''; }
var SRC_KEYS = ['res.h', 'res.d', 'res.a', 'ou.o', 'ou.u', 'hc.h', 'hc.a'];
// Keine automatischen Buchmacher-Quoten: Betano traegst du selbst ein. Aeltere gespeicherte automatische Quoten werden verworfen.
var AUTO_BOOK_NAME = '';
function cleanSrc(o){
  var out = {};
  if (o && typeof o === 'object') SRC_KEYS.forEach(function(k){ if (typeof o[k] === 'string') out[k] = o[k].slice(0, 20); });
  return out;
}
function normalizeFeed(raw){
  if (!raw || typeof raw !== 'object') return null;
  var list = Array.isArray(raw.matches) ? raw.matches.slice(0, 1500) : [];
  var seen = {};
  var matches = [];
  list.forEach(function(r, i){
    if (!r || typeof r !== 'object') return;
    var home = feedStr(r.home), away = feedStr(r.away);
    if (!home || !away) return;
    var rr = r.ref || {}, rb = r.book || {};
    var ref = { h: feedOdd(rr.h), d: feedOdd(rr.d), a: feedOdd(rr.a) };
    var book = { h: feedOdd(rb.h), d: feedOdd(rb.d), a: feedOdd(rb.a) };
    var ou = null;
    if (r.ou && typeof r.ou === 'object'){
      var line = typeof r.ou.line === 'number' ? r.ou.line : NaN;
      var ro = r.ou.ref || {}, bo = r.ou.book || {};
      var oref = { o: feedOdd(ro.o), u: feedOdd(ro.u) };
      if (isHalfLine(line) && oref.o && oref.u) ou = { line: line, ref: oref, book: { o: feedOdd(bo.o), u: feedOdd(bo.u) } };
    }
    var sport = SPORTS[r.sport] ? r.sport : 'fb';
    var dc = null;
    if (sport === 'fb' && r.dc && typeof r.dc === 'object'){
      dc = { hx: feedOdd(r.dc.hx), xa: feedOdd(r.dc.xa), ha: feedOdd(r.dc.ha) };
    }
    var hc = null;
    if (r.hc && typeof r.hc === 'object' && hcLineOk(sport, r.hc.line)){
      var hr = r.hc.ref || {}, hb = r.hc.book || {};
      var href = { h: feedOdd(hr.h), a: feedOdd(hr.a) };
      if (href.h && href.a) hc = { line: r.hc.line, ref: href, book: { h: feedOdd(hb.h), a: feedOdd(hb.a) } };
    }
    var fixture = r.fixture === true;
    // Nur Pinnacle als Referenz: aeltere Daten mit anderer Referenz werden zu Spielen ohne Quoten (beim naechsten Laden neu)
    var srcName = feedStr(r.src, 40);
    if (srcName && srcName !== 'Pinnacle'){ ref = { h: null, d: null, a: null }; book = { h: null, d: null, a: null }; ou = null; hc = null; dc = null; fixture = true; srcName = ''; }
    if (!(ref.h && ref.a) && !ou && !hc && !fixture) return;
    var bookSrcName = feedStr(r.bookSrc, 40), bsrcClean = cleanSrc(r.bsrc);
    var foreign = Object.keys(bsrcClean).some(function(k){ return bsrcClean[k] !== AUTO_BOOK_NAME; }) || (bookSrcName && bookSrcName !== AUTO_BOOK_NAME);
    if (foreign){ book = { h: null, d: null, a: null }; if (ou) ou.book = { o: null, u: null }; if (hc) hc.book = { h: null, a: null }; bookSrcName = ''; bsrcClean = {}; }
    var id = feedStr(r.id, 120) || ('f' + i + '-' + (home + '-' + away).toLowerCase().replace(/[^a-z0-9]+/g, '-'));
    if (seen[id]) id += '-' + i;
    seen[id] = true;
    var ko = typeof r.kickoff === 'string' ? Date.parse(r.kickoff) : NaN;
    matches.push({ id: id, feed: true, sport: sport, league: feedStr(r.league, 40), time: feedStr(r.time, 20),
      kickoff: isFinite(ko) ? ko : null, home: home, away: away, ref: ref, book: book, ou: ou, dc: dc, hc: hc, src: srcName, bookSrc: bookSrcName, noRef: r.noRef === true, refAt: typeof r.refAt === 'number' && isFinite(r.refAt) ? r.refAt : null, bsrc: bsrcClean, lkey: feedStr(r.lkey, 60), fixture: fixture && !(ref.h && ref.a) && !ou && !hc,
      oddsAt: typeof r.oddsAt === 'number' && isFinite(r.oddsAt) ? r.oddsAt : (typeof r.oddsAt === 'string' && isFinite(Date.parse(r.oddsAt)) ? Date.parse(r.oddsAt) : null) });
  });
  matches.sort(function(a, b){ return (a.kickoff || 0) - (b.kickoff || 0); });
  return { date: feedStr(raw.date, 10), fetchedAt: feedStr(raw.fetchedAt, 40), notes: feedStr(raw.notes, 600), matches: matches };
}
// Eigene Betano-Quoten des Nutzers ueberschreiben die geladenen.
// Eigene (Betano-)Quoten ueberschreiben nur die Felder, die der Nutzer eingetragen hat. Leere Felder = automatische Quote.
// m.ovf merkt sich, welche Ausgaenge eigene Quoten sind (fuer die Quellenangabe).
function applyOverride(m, ov){
  if (!ov) return m;
  var out = Object.assign({}, m), ovf = {};
  var pick = function(auto, val, tag){ var v = feedOdd(val); if (v){ ovf[tag] = true; return v; } return auto > 1 ? auto : null; };
  // Ue/U- und Handicap-Quoten gelten nur fuer die Linie, zu der sie eingetragen wurden. Hat sich die Linie verschoben, verfallen sie.
  var sameLine = function(a, b){ return a === undefined || a === b; };
  // Eigene Referenzquoten (z. B. Pinnacle von OddsPortal) nur, wenn keine geladen sind
  var hasRef = m.ref && m.ref.h > 1 && m.ref.a > 1;
  if (!hasRef && ov.ref && feedOdd(ov.ref.h) && feedOdd(ov.ref.a)){
    out.ref = { h: feedOdd(ov.ref.h), d: feedOdd(ov.ref.d), a: feedOdd(ov.ref.a) }; ovf.ref = true;
  }
  if (!m.ou && ov.ouRef && isHalfLine(ov.ouRef.line) && feedOdd(ov.ouRef.o) && feedOdd(ov.ouRef.u)){
    out.ou = { line: ov.ouRef.line, ref: { o: feedOdd(ov.ouRef.o), u: feedOdd(ov.ouRef.u) }, book: { o: null, u: null } }; ovf.ouRef = true;
  }
  if (!m.hc && (out.sport || 'fb') !== 'fb' && ov.hcRef && isHcLine(ov.hcRef.line) && feedOdd(ov.hcRef.h) && feedOdd(ov.hcRef.a)){
    out.hc = { line: ov.hcRef.line, ref: { h: feedOdd(ov.hcRef.h), a: feedOdd(ov.hcRef.a) }, book: { h: null, a: null } }; ovf.hcRef = true;
  }
  if (ovf.ref || ovf.ouRef || ovf.hcRef) out.fixture = false;
  m = out;
  if (ov.book){ var b = m.book || {}; out.book = { h: pick(b.h, ov.book.h, 'res.h'), d: pick(b.d, ov.book.d, 'res.d'), a: pick(b.a, ov.book.a, 'res.a') }; }
  if (m.ou && ov.ou && sameLine(ov.ou.line, m.ou.line)){ var ob = m.ou.book || {}; out.ou = Object.assign({}, m.ou, { book: { o: pick(ob.o, ov.ou.o, 'ou.o'), u: pick(ob.u, ov.ou.u, 'ou.u') } }); }
  if (out.sport === 'fb' && ov.dc){ var d = m.dc || {}; out.dc = { hx: pick(d.hx, ov.dc.hx, 'dc.hx'), xa: pick(d.xa, ov.dc.xa, 'dc.xa'), ha: pick(d.ha, ov.dc.ha, 'dc.ha') }; }
  if (out.sport === 'fb' && ov.x && typeof ov.x === 'object'){
    out.xb = Object.assign({}, m.xb || {});
    Object.keys(ov.x).forEach(function(k){ var v = feedOdd(ov.x[k]); if (v){ out.xb[k] = v; ovf['x.' + k] = true; } });
  }
  if (m.hc && ov.hc && sameLine(ov.hc.line, m.hc.line)){ var hb = m.hc.book || {}; out.hc = Object.assign({}, m.hc, { book: { h: pick(hb.h, ov.hc.h, 'hc.h'), a: pick(hb.a, ov.hc.a, 'hc.a') } }); }
  out.ovf = ovf;
  out.mine = Object.keys(ovf).filter(function(k){ return k !== 'ref' && k !== 'ouRef' && k !== 'hcRef'; }).length > 0;
  out.ownRef = !!(ovf.ref || ovf.ouRef || ovf.hcRef);
  return out;
}
function hasStarted(m, now){ return m.kickoff != null && now >= m.kickoff; }
// Faire Quoten je Ausgang, auch ohne Buchmacher-Quote (fuer "Value ab ...").
function fairOddsFor(m, method){
  var out = { res: {}, ou: {}, dc: {}, hc: {}, x: {} };
  var ref = m.ref || {};
  if (ref.h > 1 && ref.a > 1){
    var keys = ref.d > 1 ? ['h', 'd', 'a'] : ['h', 'a'];
    var f = fairProbs(keys.map(function(k){ return ref[k]; }), method);
    keys.forEach(function(k, i){ out.res[k] = 1 / f[i]; });
    if (ref.d > 1 && (m.sport || 'fb') === 'fb'){
      out.dc = { hx: 1 / (f[0] + f[1]), xa: 1 / (f[1] + f[2]), ha: 1 / (f[0] + f[2]) };
    }
  }
  if (m.hc && hcLineOk(m.sport, m.hc.line) && m.hc.ref && m.hc.ref.h > 1 && m.hc.ref.a > 1){
    var hf = fairProbs([m.hc.ref.h, m.hc.ref.a], method);
    out.hc = { h: 1 / hf[0], a: 1 / hf[1] };
  }
  if (m.ou && m.ou.ref && m.ou.ref.o > 1 && m.ou.ref.u > 1){
    var g = fairProbs([m.ou.ref.o, m.ou.ref.u], method);
    out.ou.o = 1 / g[0]; out.ou.u = 1 / g[1];
  }
  return out;
}

function allPicks(m, method){
  var real = {};
  selectionsFor(m, method).forEach(function(s){ real[s.market + '|' + s.key] = s; });
  var q = 2;
  var fill = Object.assign({}, m, {
    book: { h: q, d: q, a: q },
    dc: (m.sport || 'fb') === 'fb' ? { hx: q, xa: q, ha: q } : null,
    ou: m.ou ? Object.assign({}, m.ou, { book: { o: q, u: q } }) : null,
    hc: m.hc ? Object.assign({}, m.hc, { book: { h: q, a: q } }) : null,
    xb: {}
  });
  var groups = {};
  return selectionsFor(fill, method).filter(function(s){ return s.p < 0.999; }).map(function(s){
    var r = real[s.market + '|' + s.key];
    return Object.assign({}, s, { book: r ? r.book : null, ev: r ? r.ev : null, src: r ? r.src : '', est: !!(r && r.est), model: s.market === 'x' && !!s.model, group: s.market === 'x' ? groups[s.key] : MARKETS[s.market] });
  });
}

// Tipp nach Endstand abrechnen: 'won' | 'lost' | null (unbekannt). hs/as = Tore/Punkte Heim/Gast.
function settleLeg(l, hs, as){
  if (!(hs >= 0) || !(as >= 0)) return null;
  var t = hs + as, d = hs - as, k = l.key, w;
  switch (l.market){
    case 'res':
      if (d === 0 && l.sport && l.sport !== 'fb') return null; // Sieger inkl. Verlaengerung: Gleichstand = Endstand unvollstaendig
      w = k === 'h' ? d > 0 : (k === 'a' ? d < 0 : d === 0); break;
    case 'dc': w = k === 'hx' ? d >= 0 : (k === 'xa' ? d <= 0 : d !== 0); break;
    case 'ou': if (!isHalfLine(l.line)) return null; w = k === 'o' ? t > l.line : t < l.line; break;
    case 'hc': {
      if (!(isHcLine(l.line) || isAhLine(l.line))) return null;
      // Marge aus Sicht des Tipps; Viertel-Linien = je halber Einsatz auf die beiden Nachbarlinien
      var base2 = k === 'h' ? d : -d, L2 = k === 'h' ? l.line : -l.line;
      var q = Math.abs(L2 * 4 - Math.round(L2 * 4)) < 1e-9 && Math.abs((L2 * 2) - Math.round(L2 * 2)) > 1e-9;
      var one = function(L){ var mm = base2 + L; return mm > 0 ? 1 : (mm < 0 ? -1 : 0); };
      if (!q){ var r1 = one(L2); return r1 > 0 ? 'won' : (r1 < 0 ? 'lost' : 'void'); }
      var a1 = one(L2 - 0.25), a2 = one(L2 + 0.25), sum = a1 + a2;
      return sum === 2 ? 'won' : (sum === -2 ? 'lost' : (sum === 1 ? 'halfwon' : (sum === -1 ? 'halflost' : 'void')));
    }
    case 'x': {
      var mo = /^([ou])(\d)(\d)$/.exec(k);
      if (mo){ var L = +(mo[2] + '.' + mo[3]); w = mo[1] === 'o' ? t > L : t < L; break; }
      var X = { btsy: hs > 0 && as > 0, btsn: !(hs > 0 && as > 0), h05: hs > 0, h15: hs > 1, a05: as > 0, a15: as > 1,
        hm15: d >= 2, ap15: d <= 1, am15: d <= -2, hp15: d >= -1, ho15: d > 0 && t > 1, ao15: d < 0 && t > 1,
        hxu35: d >= 0 && t < 4, xau35: d <= 0 && t < 4 };
      if (!(k in X)) return null;
      w = X[k]; break;
    }
    default: return null;
  }
  return w ? 'won' : 'lost';
}
// Zustaende je Tipp: open, won, lost, void (Einsatz zurueck), halfwon, halflost (Viertel-Linien)
function slipResult(legStates){
  if (legStates.some(function(s){ return s === 'lost'; })) return 'lost';
  if (!legStates.length || legStates.some(function(s){ return s === 'open' || s == null; })) return 'open';
  if (legStates.every(function(s){ return s === 'void'; })) return 'void';
  if (legStates.some(function(s){ return s === 'halfwon' || s === 'halflost'; })) return 'part';
  return 'won';
}
function legFactor(l){ return l.state === 'won' ? l.book : (l.state === 'void' ? 1 : (l.state === 'halfwon' ? (l.book + 1) / 2 : (l.state === 'halflost' ? 0.5 : 0))); }
// Auszahlung eines Scheins: stornierte Tipps zaehlen mit Quote 1
// Wettsteuer (z. B. Betano) wird von der Auszahlung eines gewonnenen Scheins abgezogen, nicht von Rueckerstattungen
function slipPayout(bet){
  if (bet.status === 'lost') return 0;
  if (bet.status === 'void') return bet.stake;
  if (bet.status !== 'won' && bet.status !== 'part') return null;
  // Gesamtquote, wie du sie eingetragen hast; Tipps mit Rueckerstattung oder halbem Ergebnis anteilig herausrechnen
  var o = bet.odds > 1 ? bet.odds : bet.legs.reduce(function(a, l){ return a * l.book; }, 1);
  bet.legs.forEach(function(l){ if (l.state !== 'won' && l.book > 1) o *= legFactor(l) / l.book; });
  var tf = bet.tax > 0 && bet.tax <= 1 ? bet.tax : 1;
  return bet.stake * o * (o > 1 ? tf : 1);
}

function kellyFull(p, o){ return o > 1 ? (p * o - 1) / (o - 1) : 0; }
function stakeFor(p, o, bank, frac){
  var k = kellyFull(p, o);
  if (!(k > 0) || !(bank > 0)) return 0;
  return Math.round(bank * Math.min(k * frac, 0.03) * 10) / 10;
}
// Eingetragene Betano-Quoten (ov.bt) als eigenes Spiel-Objekt mit Betano-Quoten zur aktuellen Linie
function withBetano(m, bt){
  if (!bt || typeof bt !== 'object') return null;
  var g = function(t){ return bt[t] > 1 ? bt[t] : null; };
  return Object.assign({}, m, { book: { h: g('res.h'), d: g('res.d'), a: g('res.a') }, dc: (m.sport || 'fb') === 'fb' ? { hx: g('dc.hx'), xa: g('dc.xa'), ha: g('dc.ha') } : null,
    ou: m.ou ? Object.assign({}, m.ou, { book: bt.ouLine === m.ou.line ? { o: g('ou.o'), u: g('ou.u') } : { o: null, u: null } }) : null,
    hc: m.hc ? Object.assign({}, m.hc, { book: bt.hcLine === m.hc.line ? { h: g('hc.h'), a: g('hc.a') } : { h: null, a: null } }) : null,
    bsrc: {}, ovf: {}, btClone: true });
}
// Surebets zwischen deinen Anbietern: je Ausgang die beste Quote (nach Wettsteuer); Summe der Kehrwerte unter 1 = sicherer Gewinn.
// books: [{ name, tf, m }] (m = Spiel mit den Quoten dieses Anbieters). Auch 1X2 gegen Doppelte Chance (z. B. 1 bei bet365, X2 bei Betano).
function sbOdd(m, mk, k){
  if (mk === 'res') return m.book && m.book[k];
  if (mk === 'dc') return m.dc && m.dc[k];
  if (mk === 'ou') return m.ou && m.ou.book && m.ou.book[k];
  if (mk === 'hc') return m.hc && m.hc.book && m.hc.book[k];
  return null;
}
function sbLabel(m, mk, k){
  if (mk === 'res') return k === 'h' ? m.home : (k === 'a' ? m.away : 'Unentschieden');
  if (mk === 'dc') return { hx: m.home + ' oder Remis', xa: 'Remis oder ' + m.away, ha: m.home + ' oder ' + m.away }[k];
  if (mk === 'ou') return (k === 'o' ? 'Über ' : 'Unter ') + fmtLine(m.ou.line);
  if (mk === 'hc') return (k === 'h' ? m.home + ' ' + fmtHc(m.hc.line) : m.away + ' ' + fmtHc(-m.hc.line));
  return k;
}
function findSurebets(m, books){
  var out = [], sport = m.sport || 'fb', ref = m.ref || {};
  var groups = [];
  if (sport === 'fb' && ref.d > 1){
    groups.push({ market: 'res', parts: [['res', 'h'], ['res', 'd'], ['res', 'a']] });
    groups.push({ market: 'res+dc', parts: [['res', 'h'], ['dc', 'xa']] }, { market: 'res+dc', parts: [['res', 'a'], ['dc', 'hx']] }, { market: 'res+dc', parts: [['res', 'd'], ['dc', 'ha']] });
  } else groups.push({ market: 'res', parts: [['res', 'h'], ['res', 'a']] });
  if (m.ou) groups.push({ market: 'ou', parts: [['ou', 'o'], ['ou', 'u']], line: m.ou.line });
  if (m.hc) groups.push({ market: 'hc', parts: [['hc', 'h'], ['hc', 'a']], line: m.hc.line });
  groups.forEach(function(g){
    var legs = g.parts.map(function(pt){
      var best = null;
      books.forEach(function(bk){
        var bm = bk.m;
        if (pt[0] === 'ou' && !(bm.ou && bm.ou.line === g.line)) return;
        if (pt[0] === 'hc' && !(bm.hc && bm.hc.line === g.line)) return;
        var o = sbOdd(bm, pt[0], pt[1]);
        if (!(o > 1)) return;
        var e = o * (bk.tf > 0 && bk.tf <= 1 ? bk.tf : 1);
        if (!best || e > best.eff) best = { book: bk.name, market: pt[0], key: pt[1], odds: o, eff: e, label: sbLabel(m, pt[0], pt[1]) };
      });
      return best;
    });
    if (legs.some(function(l){ return !l; })) return;
    var S = legs.reduce(function(a, l){ return a + 1 / l.eff; }, 0);
    if (S < 1 - 1e-9) out.push({ mid: m.id, game: m.home + ' – ' + m.away, sport: sport, league: m.league, kickoff: m.kickoff, market: g.market, legs: legs, S: S, profit: 1 / S - 1 });
  });
  return out.sort(function(a, b){ return b.profit - a.profit; });
}
// Einsaetze fuer einen Gesamtbetrag: gleiche Auszahlung bei jedem Ausgang, auf 10 Cent gerundet; Gewinn = schlechtester Fall
function surebetStakes(sb, total){
  var stakes = sb.legs.map(function(l){ return Math.round(total / (l.eff * sb.S) * 10) / 10; });
  var sum = stakes.reduce(function(a, x){ return a + x; }, 0);
  var pays = stakes.map(function(x, i){ return x * sb.legs[i].eff; });
  var minPay = Math.min.apply(null, pays);
  return { stakes: stakes, sum: Math.round(sum * 100) / 100, pays: pays, profit: Math.round((minPay - sum) * 100) / 100 };
}
// Profi-Auswertung des Tagebuchs: erwarteter gegen tatsaechlichen Gewinn, Schwankungsband, Drawdown, Aufschluesselung.
// Gewinn eines Scheins ist zweiwertig: +Einsatz*(Quote*Steuer-1) mit Chance p, sonst -Einsatz. Varianz = Einsatz^2 * (Quote*Steuer)^2 * p*(1-p).
var EDGE_TIERS = [[-Infinity, 0.02, 'unter 2 %'], [0.02, 0.05, '2–5 %'], [0.05, 0.1, '5–10 %'], [0.1, Infinity, 'ab 10 %']];
function betTax(b){ return b.tax > 0 && b.tax <= 1 ? b.tax : 1; }
function betEdge(b){ return b.p * b.odds * betTax(b) - 1; }
function betGroupKey(b, by){
  var legs = b.legs || [];
  var one = function(f){ var v = legs.map(f).filter(function(x, i, a){ return a.indexOf(x) === i; }); return v.length === 1 ? v[0] : null; };
  if (by === 'sport'){ var sp = one(function(l){ return l.sport || 'fb'; }); return sp ? (SPORTS[sp] ? SPORTS[sp].name : sp) : 'Gemischt'; }
  if (by === 'market'){ var mk = one(function(l){ return l.market; }); return mk ? (MARKETS[mk] || mk) : 'Gemischt'; }
  if (by === 'book') return b.book || 'Betano';
  if (by === 'legs') return legs.length <= 1 ? 'Einzelwette' : (legs.length >= 4 ? '4er und mehr' : legs.length + 'er-Kombi');
  var e = betEdge(b);
  for (var i = 0; i < EDGE_TIERS.length; i++) if (e >= EDGE_TIERS[i][0] && e < EDGE_TIERS[i][1]) return EDGE_TIERS[i][2];
  return EDGE_TIERS[0][2];
}
function clvStats(vals){
  var n = vals.length; if (!n) return null;
  var mean = vals.reduce(function(a, x){ return a + x; }, 0) / n;
  var sd = n > 1 ? Math.sqrt(vals.reduce(function(a, x){ return a + (x - mean) * (x - mean); }, 0) / (n - 1)) : 0;
  var se = n > 1 ? sd / Math.sqrt(n) : 0;
  return { n: n, mean: mean, sd: sd, lo: mean - 1.96 * se, hi: mean + 1.96 * se };
}
function legClv(l){ return l.close > 1 && l.book > 1 ? l.book / l.close - 1 : null; }
function analyzeBets(bets, by){
  var played = (bets || []).filter(function(b){ return b && b.status !== 'open' && b.status !== 'void' && b.stake > 0 && b.odds > 1 && b.p > 0 && b.p < 1 && slipPayout(b) != null; })
    .slice().sort(function(a, b){ return (a.at || 0) - (b.at || 0); });
  var stake = 0, profit = 0, exp = 0, vr = 0, peak = 0, maxDD = 0, curve = [{ act: 0, exp: 0, sd: 0 }];
  var groups = {};
  played.forEach(function(b){
    var eff = b.odds * betTax(b), pr = slipPayout(b) - b.stake, ex = b.stake * (b.p * eff - 1), v = b.stake * b.stake * eff * eff * b.p * (1 - b.p);
    stake += b.stake; profit += pr; exp += ex; vr += v;
    if (profit > peak) peak = profit;
    if (peak - profit > maxDD) maxDD = peak - profit;
    curve.push({ act: profit, exp: exp, sd: Math.sqrt(vr) });
    var k = betGroupKey(b, by || 'sport');
    var g = groups[k] || (groups[k] = { key: k, n: 0, stake: 0, profit: 0, exp: 0, clv: [] });
    g.n++; g.stake += b.stake; g.profit += pr; g.exp += ex;
    (b.legs || []).forEach(function(l){ var c = legClv(l); if (c != null) g.clv.push(c); });
  });
  var allClv = [];
  (bets || []).forEach(function(b){ (b.legs || []).forEach(function(l){ var c = legClv(l); if (c != null) allClv.push(c); }); });
  var sd = Math.sqrt(vr);
  var list = Object.keys(groups).map(function(k){ var g = groups[k]; return { key: k, n: g.n, stake: g.stake, profit: g.profit, roi: g.stake ? g.profit / g.stake : 0, exp: g.exp, clv: clvStats(g.clv) }; })
    .sort(function(a, b){ return b.stake - a.stake; });
  return { n: played.length, stake: stake, profit: profit, exp: exp, sd: sd, z: sd > 0 ? (profit - exp) / sd : 0,
    roi: stake ? profit / stake : 0, roiExp: stake ? exp / stake : 0,
    roiLo: stake ? (profit - 1.96 * sd) / stake : 0, roiHi: stake ? (profit + 1.96 * sd) / stake : 0,
    maxDD: maxDD, curve: curve, groups: list, clv: clvStats(allClv) };
}



// Abruf bei The Odds API (v4). Referenz: Pinnacle, Ersatz: Betfair-Boerse. Betano liefert die API nicht, diese Quoten traegst du selbst ein.
var API_BASE = 'https://api.the-odds-api.com';
// Referenz (scharf, ohne/mit kleiner Marge) in dieser Reihenfolge; deutsche Buchmacher liefern eine automatische Quote.
// Alle fuenf zusammen kosten wie einer (bis 10 Buchmacher zaehlen als 1 Region).
// Referenz: ausschliesslich Pinnacle. Spiele ohne Pinnacle-Quote bekommen keine automatische Chance.
var REF_BOOKS = ['pinnacle'];
// Buchmacher-Quoten werden nicht geladen: die Betano-Quote traegst du selbst ein (sicherer)
var DE_BOOKS = [];
var BOOK_VER = 2;
var BOOK_NAMES = { betano_uk: 'Betano UK', pinnacle: 'Pinnacle', betfair_ex_eu: 'Betfair-Börse', matchbook: 'Matchbook', tipico_de: 'Tipico', winamax_de: 'Winamax' };
var LEAGUES = [
  { key: 'soccer_germany_bundesliga', name: 'Bundesliga', sport: 'fb', on: true },
  { key: 'soccer_germany_bundesliga2', name: '2. Bundesliga', sport: 'fb', on: true },
  { key: 'soccer_epl', name: 'Premier League', sport: 'fb', on: true },
  { key: 'soccer_spain_la_liga', name: 'La Liga', sport: 'fb', on: true },
  { key: 'soccer_italy_serie_a', name: 'Serie A', sport: 'fb', on: true },
  { key: 'soccer_france_ligue_one', name: 'Ligue 1', sport: 'fb', on: true },
  { key: 'soccer_uefa_champs_league', name: 'Champions League', sport: 'fb', on: true, cup: true },
  { key: 'soccer_germany_dfb_pokal', name: 'DFB-Pokal', sport: 'fb', on: true, cup: true },
  { key: 'soccer_fa_cup', name: 'FA Cup', sport: 'fb', on: true, cup: true },
  { key: 'soccer_england_efl_cup', name: 'EFL Cup', sport: 'fb', on: true, cup: true },
  { key: 'soccer_spain_copa_del_rey', name: 'Copa del Rey', sport: 'fb', on: true, cup: true },
  { key: 'soccer_italy_coppa_italia', name: 'Coppa Italia', sport: 'fb', on: true, cup: true },
  { key: 'soccer_france_coupe_de_france', name: 'Coupe de France', sport: 'fb', on: true, cup: true },
  { key: 'soccer_uefa_europa_league', name: 'Europa League', sport: 'fb', on: false, cup: true },
  { key: 'soccer_uefa_europa_conference_league', name: 'Conference League', sport: 'fb', on: false, cup: true },
  { key: 'basketball_nba', name: 'NBA', sport: 'bb', on: true },
  { key: 'basketball_euroleague', name: 'Euroleague', sport: 'bb', on: false },
  { key: 'icehockey_nhl', name: 'NHL', sport: 'ih', on: true },
  { key: 'icehockey_sweden_hockey_league', name: 'SHL (Schweden)', sport: 'ih', on: false },
  { key: 'icehockey_liiga', name: 'Liiga (Finnland)', sport: 'ih', on: false }
];
function leagueByKey(k){ return LEAGUES.filter(function(l){ return l.key === k; })[0] || null; }
// Asiatisches Handicap im Fussball: 1 Abruf mehr je Liga (in den Einstellungen abschaltbar)
var AH_FB = true;
function marketsFor(sport){ return sport === 'fb' ? (AH_FB ? ['h2h', 'totals', 'spreads'] : ['h2h', 'totals']) : ['h2h', 'spreads', 'totals']; }
// Kosten pro Laden: Anzahl Maerkte je Liga (bis 10 Buchmacher zaehlen wie 1 Region)
function costFor(leagues){ return leagues.reduce(function(a, l){ return a + marketsFor(l.sport).length; }, 0); }
function isoNoMs(ms){ return new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z'); }
function apiRoot(base){ var b = String(base || '').trim().replace(/\/+$/, ''); return b || API_BASE; }
function qs(o){ return Object.keys(o).filter(function(k){ return o[k] != null && o[k] !== ''; }).map(function(k){ return encodeURIComponent(k) + '=' + encodeURIComponent(o[k]); }).join('&'); }
function sportsUrl(base, key){ return apiRoot(base) + '/v4/sports/?' + qs({ apiKey: key }); }
function oddsUrl(base, key, league, fromMs, toMs){
  return apiRoot(base) + '/v4/sports/' + encodeURIComponent(league.key) + '/odds/?' + qs({
    apiKey: key, bookmakers: REF_BOOKS.concat(DE_BOOKS).join(','), markets: marketsFor(league.sport).join(','),
    oddsFormat: 'decimal', dateFormat: 'iso', commenceTimeFrom: isoNoMs(fromMs), commenceTimeTo: isoNoMs(toMs) });
}
// Spielplan (kostenlos) und Endstaende (2 Abrufe je Liga)
function eventsUrl(base, key, league, fromMs, toMs){
  return apiRoot(base) + '/v4/sports/' + encodeURIComponent(league.key) + '/events/?' + qs({ apiKey: key, dateFormat: 'iso', commenceTimeFrom: isoNoMs(fromMs), commenceTimeTo: isoNoMs(toMs) });
}
function scoresUrl(base, key, sportKey, ids){
  return apiRoot(base) + '/v4/sports/' + encodeURIComponent(sportKey) + '/scores/?' + qs({ apiKey: key, daysFrom: 3, dateFormat: 'iso', eventIds: ids.join(',') });
}
function fixturesFromEvents(events, league, nowMs){
  var out = [];
  (Array.isArray(events) ? events : []).forEach(function(ev){
    if (!ev || typeof ev.id !== 'string' || typeof ev.home_team !== 'string' || typeof ev.away_team !== 'string') return;
    var ko = Date.parse(ev.commence_time);
    if (!isFinite(ko) || ko <= nowMs) return;
    out.push({ id: ev.id, sport: league.sport, league: league.name, lkey: league.key, kickoff: new Date(ko).toISOString(), time: timeLabel(ko, nowMs),
      home: ev.home_team, away: ev.away_team, ref: { h: null, d: null, a: null }, book: { h: null, d: null, a: null }, ou: null, hc: null, dc: null, fixture: true, src: '' });
  });
  return out;
}
// Endstand aus der Scores-Antwort: { hs, as } nur bei abgeschlossenen Spielen
function scoreOf(ev){
  if (!ev || ev.completed !== true || !Array.isArray(ev.scores)) return null;
  var get = function(n){ var x = ev.scores.filter(function(s){ return s && s.name === n; })[0]; var v = x ? parseFloat(x.score) : NaN; return isFinite(v) && v >= 0 ? v : null; };
  var hs = get(ev.home_team), as = get(ev.away_team);
  return hs == null || as == null ? null : { hs: hs, as: as };
}
function priceOk(x){ return typeof x === 'number' && isFinite(x) && x > 1 && x < 1000; }
function findOutcome(mk, name){ var o = (mk && Array.isArray(mk.outcomes) ? mk.outcomes : []).filter(function(x){ return x && x.name === name; }); return o.length === 1 ? o[0] : null; }
function convH2h(mk, ev, sport){
  var h = findOutcome(mk, ev.home_team), a = findOutcome(mk, ev.away_team), d = findOutcome(mk, 'Draw');
  if (!h || !a || !priceOk(h.price) || !priceOk(a.price)) return null;
  if (sport === 'fb' && !(d && priceOk(d.price))) return null;
  return { h: h.price, d: d && priceOk(d.price) ? d.price : null, a: a.price };
}
function convTotals(mk){
  var o = findOutcome(mk, 'Over'), u = findOutcome(mk, 'Under');
  if (!o || !u || !priceOk(o.price) || !priceOk(u.price) || o.point !== u.point || !isHalfLine(o.point)) return null;
  return { line: o.point, o: o.price, u: u.price };
}
function convSpreads(mk, ev, sport){
  var h = findOutcome(mk, ev.home_team), a = findOutcome(mk, ev.away_team);
  if (!h || !a || !priceOk(h.price) || !priceOk(a.price) || typeof h.point !== 'number' || typeof a.point !== 'number') return null;
  if (Math.abs(h.point + a.point) > 1e-9 || !hcLineOk(sport || 'bb', h.point)) return null;
  return { line: h.point, h: h.price, a: a.price };
}
// Erster Referenz-Buchmacher (Pinnacle vor Betfair), dessen Markt vollstaendig und gueltig ist
function refMarket(ev, mkey, conv){
  var books = Array.isArray(ev.bookmakers) ? ev.bookmakers : [];
  for (var i = 0; i < REF_BOOKS.length; i++){
    var bm = books.filter(function(b){ return b && b.key === REF_BOOKS[i]; })[0];
    var mk = bm && Array.isArray(bm.markets) ? bm.markets.filter(function(m){ return m && m.key === mkey; })[0] : null;
    var v = mk ? conv(mk) : null;
    if (v){ var at = Date.parse(mk.last_update || bm.last_update || ''); return { v: v, book: REF_BOOKS[i], at: isFinite(at) ? at : null }; }
  }
  return null;
}
// Beste Quote deutscher Buchmacher je Ausgang. Ue/U und Handicap nur bei derselben Linie wie die Referenz.
// Beste Quote deutscher Buchmacher je Ausgang (mit Quelle je Ausgang). Ue/U und Handicap nur bei derselben Linie wie die Referenz.
// twoWay: Referenz hat kein Remis (z. B. Sieger inkl. Verlaengerung) -> 3-Weg-Maerkte der Buchmacher passen nicht und werden verworfen.
function deMarket(ev, mkey, conv, keys, line, twoWay){
  var books = Array.isArray(ev.bookmakers) ? ev.bookmakers : [];
  var best = {}, src = {};
  DE_BOOKS.forEach(function(bk){
    var bm = books.filter(function(b){ return b && b.key === bk; })[0];
    var mk = bm && Array.isArray(bm.markets) ? bm.markets.filter(function(m){ return m && m.key === mkey; })[0] : null;
    var v = mk ? conv(mk) : null;
    if (!v || (line != null && v.line !== line)) return;
    if (twoWay && v.d != null) return;
    keys.forEach(function(k){ if (v[k] > 1 && !(best[k] >= v[k])){ best[k] = v[k]; src[k] = BOOK_NAMES[bk]; } });
  });
  return { best: best, src: src };
}
function timeLabel(ms, nowMs){
  try {
    var d = new Date(ms);
    var hm = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' }).format(d);
    var day = function(x){ return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(x); };
    if (day(d) === day(new Date(nowMs))) return hm;
    return new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', weekday: 'short' }).format(d).replace('.', '') + ' ' + hm;
  } catch (e) { return ''; }
}
function convertEvents(events, league, nowMs){
  var out = [];
  (Array.isArray(events) ? events : []).forEach(function(ev){
    if (!ev || typeof ev.id !== 'string' || typeof ev.home_team !== 'string' || typeof ev.away_team !== 'string') return;
    var ko = Date.parse(ev.commence_time);
    if (!isFinite(ko) || ko <= nowMs) return;
    var sport = league.sport;
    var r = refMarket(ev, 'h2h', function(mk){ return convH2h(mk, ev, sport); });
    var t = refMarket(ev, 'totals', convTotals);
    var s = refMarket(ev, 'spreads', function(mk){ return convSpreads(mk, ev, sport); });
    if (!r && !t && !s) return;
    var used = [r, t, s].filter(Boolean).map(function(x){ return BOOK_NAMES[x.book]; });
    used = used.filter(function(x, i){ return used.indexOf(x) === i; });
    var none = { best: {}, src: {} };
    var dr = r ? deMarket(ev, 'h2h', function(mk){ return convH2h(mk, ev, sport); }, r.v.d == null ? ['h', 'a'] : ['h', 'd', 'a'], null, r.v.d == null) : none;
    var dt = t ? deMarket(ev, 'totals', convTotals, ['o', 'u'], t.v.line) : none;
    var ds = s ? deMarket(ev, 'spreads', function(mk){ return convSpreads(mk, ev, sport); }, ['h', 'a'], s.v.line) : none;
    var bsrc = {};
    Object.keys(dr.src).forEach(function(k){ bsrc['res.' + k] = dr.src[k]; });
    Object.keys(dt.src).forEach(function(k){ bsrc['ou.' + k] = dt.src[k]; });
    Object.keys(ds.src).forEach(function(k){ bsrc['hc.' + k] = ds.src[k]; });
    var ats = [r, t, s].filter(function(x){ return x && x.at; }).map(function(x){ return x.at; });
    var refAt = ats.length ? Math.min.apply(null, ats) : null;
    var bused = Object.keys(bsrc).map(function(k){ return bsrc[k]; }).filter(function(x, i, arr){ return arr.indexOf(x) === i; });
    out.push({
      id: ev.id, sport: sport, league: league.name, kickoff: new Date(ko).toISOString(), time: timeLabel(ko, nowMs),
      home: ev.home_team, away: ev.away_team,
      ref: r ? { h: r.v.h, d: r.v.d, a: r.v.a } : { h: null, d: null, a: null },
      book: { h: dr.best.h || null, d: dr.best.d || null, a: dr.best.a || null },
      ou: t ? { line: t.v.line, ref: { o: t.v.o, u: t.v.u }, book: { o: dt.best.o || null, u: dt.best.u || null } } : null,
      hc: s ? { line: s.v.line, ref: { h: s.v.h, a: s.v.a }, book: { h: ds.best.h || null, a: ds.best.a || null } } : null,
      dc: null, src: used.join(' + '), bookSrc: bused.join(' / '), bsrc: bsrc, lkey: league.key, oddsAt: nowMs, refAt: refAt
    });
  });
  return out;
}
function buildFeed(matches, nowMs, leagueCount){
  var notes = 'Referenz ist ausschließlich Pinnacle (' + matches.length + ' Spiele mit Pinnacle-Quoten, ' + leagueCount + (leagueCount === 1 ? ' Liga' : ' Ligen') + ' abgefragt). ' +
    'Die Quoten deines Anbieters (Betano oder bet365) trägst du selbst ein. ' +
    'Doppelte Chance, Beide treffen, Tore und Team-Tore: Chance aus Pinnacle 1X2 und Über/Unter berechnet (kein zusätzlicher Abruf), die Quote deines Anbieters aus deinen 1X2-Quoten geschätzt.';
  var date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date(nowMs));
  return { date: date, fetchedAt: new Date(nowMs).toISOString(), notes: notes, matches: matches };
}
function parseQuota(get){
  var n = function(k){ var v = get(k); var x = v == null ? NaN : parseFloat(v); return isFinite(x) ? x : null; };
  return { remaining: n('x-requests-remaining'), used: n('x-requests-used'), last: n('x-requests-last') };
}
function apiErrorText(status, body){
  var b = String(body || '').toLowerCase();
  if (status === -1) return 'Die Antwort hatte ein unerwartetes Format. Prüfe die Adresse des Zwischendienstes in den Einstellungen.';
  if (status === -2) return 'Keine Liga konnte geladen werden. Versuch es später noch einmal.';
  if (status === -3) return 'Zu wenige Abrufe übrig für alle Quoten. Spielplan ist aktuell; lade Quoten gezielt pro Liga.';
  if (status === 0) return 'Keine Verbindung zu The Odds API. Prüfe dein Internet. Klappt es mit Internet trotzdem nicht, blockiert der Browser den direkten Abruf: richte dann den Zwischendienst ein (Anleitung, Schritt 6).';
  if (b.indexOf('quota') >= 0 || b.indexOf('usage') >= 0) return 'Dein Kontingent bei The Odds API ist aufgebraucht. Es füllt sich mit dem nächsten Abrechnungsmonat wieder auf.';
  if (status === 401) return 'Der API-Schlüssel wird nicht akzeptiert. Prüfe ihn in den Einstellungen.';
  if (status === 429) return 'Zu viele Abrufe in kurzer Zeit. Versuch es in einer Minute noch einmal.';
  if (status === 422) return 'The Odds API hat die Anfrage abgelehnt (ungültige Liga oder Einstellung).';
  return 'The Odds API antwortet mit Fehler ' + status + '. Versuch es später noch einmal.';
}
// Spar-Modus: Tagesanteil am Restkontingent (20 Abrufe Reserve fuer Ergebnisse und Knopfdruck)
// Spar-Modus fuer 500 Abrufe im Monat:
// - Quoten einer Liga erst, wenn ihr naechstes Spiel in hoechstens 6 Std anpfeift (fruehere Quoten waeren bis dahin veraltet).
// - Danach hoechstens alle 4 Std neu, in den 90 Min vor Anpfiff noch einmal, wenn die Quoten aelter als 2 Std sind.
// - Tagesbudget nach Wochentag gewichtet: am Wochenende spielen viel mehr Ligen.
var SMART_RESERVE = 20, SMART_AHEAD = 6 * 3600000, SMART_FRESH = 4 * 3600000, SMART_SOON = 90 * 60000, SMART_FRESH_SOON = 2 * 3600000;
// Gewicht je Wochentag (So, Mo, ..., Sa)
var DAY_WEIGHT = [2, 1, 1, 1, 1, 1.5, 2.5];
function berlinDay(ms){ try { var w = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', weekday: 'short' }).format(new Date(ms)); return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(w); } catch (e) { return new Date(ms).getDay(); } }
function daysLeftInMonth(nowMs){
  var d = new Date(nowMs), end = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  return Math.max(1, Math.ceil((end - d) / 86400000));
}
// Summe der Gewichte von heute bis Monatsende
function weightLeft(nowMs){
  var n = daysLeftInMonth(nowMs), w = 0;
  for (var i = 0; i < n; i++) w += DAY_WEIGHT[berlinDay(nowMs + i * 86400000)];
  return w;
}
function dailyBudget(remaining, spentToday, nowMs){
  if (remaining == null || !isFinite(remaining)) return null;
  var spent = Math.max(0, spentToday || 0), start = remaining + spent;
  var allow = Math.floor(Math.max(0, start - SMART_RESERVE) * DAY_WEIGHT[berlinDay(nowMs)] / weightLeft(nowMs));
  return { allow: allow, spent: spent, left: Math.max(0, Math.min(allow - spent, remaining - SMART_RESERVE)) };
}
// Welche Ligen jetzt Quoten brauchen (siehe oben); zuerst Anpfiff-nah, dann Ligen, die dich interessieren, dann nach Anstosszeit.
// Schlussquote: Hast du in einer Liga eine offene Wette, deren Spiel in hoechstens 30 Min anpfeift, und sind die Quoten
// aelter als 15 Min, laedt die App diese Liga zuerst. Das zaehlt nicht gegen den Tagesanteil, nur gegen das Restkontingent (closeLeft).
var SMART_CLOSE = 30 * 60000, SMART_CLOSE_FRESH = 15 * 60000;
function closeDue(x, nowMs){
  var age = x.oddsAt ? nowMs - x.oddsAt : Infinity;
  return x.close > nowMs && x.close - nowMs <= SMART_CLOSE && age > SMART_CLOSE_FRESH;
}
function planSmart(infos, budgetLeft, nowMs, closeLeft){
  var out = [], cl = closeLeft == null ? Infinity : closeLeft;
  var closing = (infos || []).filter(function(x){ return closeDue(x, nowMs); }).sort(function(a, b){ return a.close - b.close; });
  closing.forEach(function(x){ if (x.cost <= cl){ out.push(x.key); cl -= x.cost; } });
  var need = (infos || []).filter(function(x){
    if (out.indexOf(x.key) >= 0) return false;
    if (!(x.next > nowMs) || x.next - nowMs > SMART_AHEAD) return false;
    var age = x.oddsAt ? nowMs - x.oddsAt : Infinity;
    var soon = x.next - nowMs <= SMART_SOON;
    return age > SMART_FRESH || (soon && age > SMART_FRESH_SOON);
  }).map(function(x){ return Object.assign({}, x, { prio: (x.next - nowMs <= SMART_SOON ? 0 : 2) + (x.interest ? 0 : 1) }); });
  need.sort(function(a, b){ return (a.prio - b.prio) || (a.next - b.next); });
  var left = budgetLeft == null ? Infinity : budgetLeft;
  need.forEach(function(x){ if (x.cost <= left){ out.push(x.key); left -= x.cost; } });
  return out;
}
// ---------------------------------------------------------------------------------------------------------------
// bet365 automatisch ueber OddsPapi (eigener Schluessel, eigenes Kontingent, unabhaengig von The Odds API)
// Ein Abruf "odds-by-tournaments" liefert bet365 fuer alle gewaehlten Ligen auf einmal (alle Maerkte).
// Zuordnung zu den Pinnacle-Spielen: gleiche Liga, gleiche Anstosszeit, Namen und vor allem aehnliche Quoten.
// Jede automatische Quote muss zur Pinnacle-Quote passen (Plausibilitaet), sonst wird sie verworfen.
var OP_BASE = 'https://api.oddspapi.io';
var OP_BOOK = 'bet365';
var AUTO_LABEL = 'bet365 auto';
var AUTO_MAX_AGE = 2 * 3600000;   // aeltere automatische Quoten zaehlen nicht (bet365 bewegt sich staendig)
var OP_LEAGUES = {
  soccer_germany_bundesliga: { cat: ['germany'], names: ['bundesliga', '1 bundesliga'] },
  soccer_germany_bundesliga2: { cat: ['germany'], names: ['2 bundesliga', 'bundesliga 2', '2nd bundesliga'] },
  soccer_epl: { cat: ['england'], names: ['premier league'] },
  soccer_spain_la_liga: { cat: ['spain'], names: ['laliga', 'la liga', 'primera division', 'laliga ea sports'] },
  soccer_italy_serie_a: { cat: ['italy'], names: ['serie a'] },
  soccer_france_ligue_one: { cat: ['france'], names: ['ligue 1', 'ligue 1 mcdonald s'] },
  soccer_uefa_champs_league: { cat: null, names: ['uefa champions league', 'champions league'] },
  soccer_germany_dfb_pokal: { cat: ['germany'], names: ['dfb pokal', 'dfb cup'] },
  soccer_fa_cup: { cat: ['england'], names: ['fa cup'] },
  soccer_england_efl_cup: { cat: ['england'], names: ['efl cup', 'league cup', 'carabao cup'] },
  soccer_spain_copa_del_rey: { cat: ['spain'], names: ['copa del rey'] },
  soccer_italy_coppa_italia: { cat: ['italy'], names: ['coppa italia'] },
  soccer_france_coupe_de_france: { cat: ['france'], names: ['coupe de france'] },
  soccer_uefa_europa_league: { cat: null, names: ['uefa europa league', 'europa league'] },
  soccer_uefa_europa_conference_league: { cat: null, names: ['uefa conference league', 'uefa europa conference league', 'conference league'] },
  basketball_nba: { cat: ['usa'], names: ['nba'] },
  basketball_euroleague: { cat: null, names: ['euroleague'] },
  icehockey_nhl: { cat: ['usa'], names: ['nhl'] },
  icehockey_sweden_hockey_league: { cat: ['sweden'], names: ['shl'] },
  icehockey_liiga: { cat: ['finland'], names: ['liiga'] }
};
function opNorm(s){
  var t = String(s == null ? '' : s).toLowerCase();
  try { t = t.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (e) {}
  return t.replace(/ß/g, 'ss').replace(/[^a-z0-9]+/g, ' ').trim();
}
function opUrl(base, path, params){
  var b = String(base || '').trim().replace(/\/+$/, '');
  return (b ? b + '/op' : OP_BASE) + path + '?' + qs(params);
}
// Sportarten-IDs aus /v4/sports
function opSportIds(list){
  var out = {};
  (Array.isArray(list) ? list : []).forEach(function(s){
    if (!s || typeof s.sportId !== 'number') return;
    var n = opNorm(s.slug) + ' ' + opNorm(s.sportName);
    if (!out.fb && /\b(soccer|football)\b/.test(n) && !/american|australian/.test(n)) out.fb = s.sportId;
    else if (!out.bb && /\bbasketball\b/.test(n)) out.bb = s.sportId;
    else if (!out.ih && /\b(ice hockey|icehockey|ice\-hockey)\b/.test(n.replace(/-/g, ' ')) ) out.ih = s.sportId;
  });
  return out;
}
// Ligen der App -> OddsPapi-Turnier-IDs (aus /v4/tournaments je Sportart)
function opMapTournaments(tours, sport){
  var out = {};
  LEAGUES.filter(function(l){ return l.sport === sport; }).forEach(function(l){
    var spec = OP_LEAGUES[l.key];
    if (!spec) return;
    var best = null, bestN = -1;
    (Array.isArray(tours) ? tours : []).forEach(function(t){
      if (!t || typeof t.tournamentId !== 'number') return;
      var nm = opNorm(t.tournamentName), slug = opNorm(t.tournamentSlug), cat = opNorm(t.categoryName) + ' ' + opNorm(t.categorySlug);
      if (spec.names.indexOf(nm) < 0 && spec.names.indexOf(slug) < 0) return;
      if (spec.cat && !spec.cat.some(function(c){ return (' ' + cat + ' ').indexOf(' ' + c + ' ') >= 0; })) return;
      var n = (t.upcomingFixtures || 0) + (t.futureFixtures || 0);
      if (n > bestN){ best = t; bestN = n; }
    });
    if (best) out[l.key] = best.tournamentId;
  });
  return out;
}
// Maerkte aus /v4/markets -> Index je Sportart: { marketId: { kind, line, ot, out: { outcomeId: key } } }
// kind: res3 (1X2), res2 (Sieger 2-Weg), dc, ou (Ueber/Unter), hc (Handicap; Linie = Heimteam)
function opOutcomeKey(name){
  var n = opNorm(name).replace(/\s+/g, '');
  if (n === '1' || n === 'home' || /^(competitor|team|participant)1$/.test(n)) return 'h';
  if (n === '2' || n === 'away' || /^(competitor|team|participant)2$/.test(n)) return 'a';
  if (n === 'x' || n === 'draw') return 'd';
  if (n === 'over') return 'o';
  if (n === 'under') return 'u';
  if (n === '1x' || n === 'homeordraw') return 'hx';
  if (n === 'x2' || n === 'draworaway') return 'xa';
  if (n === '12' || n === 'homeoraway') return 'ha';
  return null;
}
// OddsPapi-Perioden (echte Daten): "result" = ganzes Spiel, "p1"/"p1+p2" = Viertel/Haelfte, "ot" = nur Verlaengerung.
// "inkl. Verlaengerung" steht im Marktnamen, z. B. "Winner (incl. overtime)".
function opPeriodOk(p, name){
  var n = opNorm(p), nm = opNorm(name), both = n + ' ' + nm;
  var incl = /\bincl|\bincluding\b/.test(both) && /overtime|\bot\b|extra/.test(both);
  if (/^(ot|overtime|extra time|et|penalties|so|shootout)$/.test(n)) return { ok: false };
  if (!n || /^(result|fulltime|full time|ft|match|regular time|regulartime|regulation|game|full match|whole match)$/.test(n)) return { ok: true, ot: incl };
  if (incl && !/half|quarter|period|\bp\d|1st|2nd|3rd|4th/.test(n)) return { ok: true, ot: true };
  return { ok: false };
}
function opMarketIndex(markets, sportIds){
  var out = { fb: {}, bb: {}, ih: {} }, bySport = {};
  Object.keys(sportIds || {}).forEach(function(k){ bySport[sportIds[k]] = k; });
  (Array.isArray(markets) ? markets : []).forEach(function(mk){
    if (!mk || mk.playerProp === true) return;
    var sp = bySport[mk.sportId];
    if (!sp || !Array.isArray(mk.outcomes)) return;
    var per = opPeriodOk(mk.period, mk.marketName);
    if (!per.ok) return;
    var map = {}, keys = [];
    mk.outcomes.forEach(function(o){ var k = o ? opOutcomeKey(o.outcomeName) : null; if (k && keys.indexOf(k) < 0){ map[String(o.outcomeId)] = k; keys.push(k); } });
    if (keys.length !== mk.outcomes.length) return;
    var set = keys.slice().sort().join(','), type = opNorm(mk.marketType) + ' ' + opNorm(mk.marketName);
    var hcap = typeof mk.handicap === 'number' && isFinite(mk.handicap) ? mk.handicap : 0;
    var kind = null, line = null;
    if (/draw no bet|\bdnb\b|corner|card|booking|team total|odd even|exact|margin|race|both teams/.test(type)) return;
    if (set === 'a,d,h' && hcap === 0 && !/handicap|spread/.test(type)) kind = 'res3';
    else if (set === 'ha,hx,xa') kind = 'dc';
    else if (set === 'o,u'){ kind = 'ou'; line = hcap; }
    else if (set === 'a,h'){
      if (/handicap|spread|asian|\bline\b|puck|run line/.test(type) && !/moneyline|money line/.test(type)){ kind = 'hc'; line = hcap; }
      else if (hcap === 0) kind = 'res2';
    }
    if (!kind) return;
    out[sp][String(mk.marketId)] = { kind: kind, line: line, ot: !!per.ot, out: map };
  });
  return out;
}
function opPrice(o){
  if (!o || typeof o !== 'object') return null;
  var pl = o.players && typeof o.players === 'object' ? (o.players['0'] || o.players[Object.keys(o.players)[0]]) : o;
  if (!pl || pl.active === false) return null;
  var p = typeof pl.price === 'number' ? pl.price : parseFloat(pl.price);
  return isFinite(p) && p > 1 && p < 1000 ? Math.round(p * 1000) / 1000 : null;
}
// Antwort von odds-by-tournaments -> bet365-Quoten je Spiel
function opParse(list, idx, tid2lkey, book){
  var out = [];
  (Array.isArray(list) ? list : []).forEach(function(f){
    if (!f || f.fixtureId == null) return;
    var lkey = tid2lkey[f.tournamentId], lg = lkey ? leagueByKey(lkey) : null;
    if (!lg) return;
    var ko = Date.parse(f.startTime);
    if (!isFinite(ko)) return;
    var bo = f.bookmakerOdds && f.bookmakerOdds[book || OP_BOOK];
    if (!bo || bo.bookmakerIsActive === false || !bo.markets || typeof bo.markets !== 'object') return;
    var defs = idx[lg.sport] || {}, res3 = null, res2 = {}, dc = null, ou = {}, hc = {}, at = 0;
    Object.keys(bo.markets).forEach(function(mid){
      var def = defs[mid], mk = bo.markets[mid];
      if (!def || !mk || !mk.outcomes || typeof mk.outcomes !== 'object') return;
      var v = {}, n = 0;
      Object.keys(mk.outcomes).forEach(function(oid){
        var k = def.out[oid], pr = k ? opPrice(mk.outcomes[oid]) : null;
        if (!pr) return;
        v[k] = pr; n++;
        var pl = mk.outcomes[oid].players && mk.outcomes[oid].players['0'];
        var ch = pl && Date.parse(pl.changedAt); if (isFinite(ch) && ch > at) at = ch;
      });
      if (n !== Object.keys(def.out).length) return;
      var ot = def.ot ? 'ot' : 'ft';
      if (def.kind === 'res3') res3 = v;
      else if (def.kind === 'res2') res2[ot] = v;
      else if (def.kind === 'dc') dc = v;
      else if (def.kind === 'ou') (ou[ot] = ou[ot] || {})[String(def.line)] = v;
      else if (def.kind === 'hc') (hc[ot] = hc[ot] || {})[String(def.line)] = v;
    });
    var two = lg.sport !== 'fb';
    // Basketball/Eishockey: Maerkte inkl. Verlaengerung bevorzugen (wie Pinnacle)
    var pick = function(o){ return two ? (o.ot || o.ft || null) : (o.ft || null); };
    var res = two ? pick(res2) : res3;
    if (!res && !pick(ou) && !pick(hc)) return;
    out.push({ fid: String(f.fixtureId), lkey: lkey, sport: lg.sport, ko: ko, home: String(f.participant1Name || ''), away: String(f.participant2Name || ''),
      res: res, dc: two ? null : dc, ou: pick(ou) || {}, hc: pick(hc) || {}, at: at });
  });
  return out;
}
var OP_STOP = ['fc', 'sc', 'sv', 'cf', 'afc', 'ac', 'as', 'ss', 'us', 'rc', 'fk', 'bk', 'vfb', 'vfl', 'tsg', 'club', 'de', 'la', 'the', 'calcio', 'cd', 'ud', 'sd', 'rcd', 'ogc', 'osc', 'stade', '1', '04', '05', '1899', '1846', '1860', '1909', '1910'];
var OP_ALIAS = { munchen: 'munich', koln: 'cologne', monchengladbach: 'gladbach', nurnberg: 'nuremberg', hertha: 'hertha', inter: 'internazionale', internazionale: 'internazionale', man: 'manchester', utd: 'united', wolverhampton: 'wolves', spurs: 'tottenham', psg: 'paris' };
function opTokens(s){
  return opNorm(s).split(' ').filter(function(t){ return t && OP_STOP.indexOf(t) < 0; }).map(function(t){ return OP_ALIAS[t] || t; });
}
function opNameScore(a, b){
  var x = opTokens(a), y = opTokens(b);
  if (!x.length || !y.length) return 0;
  var hit = 0;
  x.forEach(function(t){ if (y.some(function(u){ return u === t || (t.length >= 4 && u.length >= 4 && (u.indexOf(t) === 0 || t.indexOf(u) === 0)); })) hit++; });
  return hit / Math.max(x.length, y.length);
}
// Abstand der 1X2-/Sieger-Chancen zwischen Pinnacle und bet365 (gleiches Spiel: meist unter 0,04)
function opOddsDist(ref, res){
  if (!ref || !res || !(ref.h > 1 && ref.a > 1 && res.h > 1 && res.a > 1)) return null;
  return Math.abs(1 / ref.h - 1 / res.h) + Math.abs(1 / ref.a - 1 / res.a);
}
// Zuordnung: raws = Spiele der App (Rohformat, mit Pinnacle), parsed = opParse-Ergebnis. Liefert { spielId: bet365-Quoten }
function opMatch(raws, parsed){
  var out = {}, used = {};
  (Array.isArray(raws) ? raws : []).forEach(function(m){
    if (!m || !m.lkey || m.fixture) return;
    var ko = typeof m.kickoff === 'number' ? m.kickoff : Date.parse(m.kickoff);
    if (!isFinite(ko)) return;
    var cands = parsed.filter(function(c){ return c.lkey === m.lkey && !used[c.fid] && Math.abs(c.ko - ko) <= 15 * 60000; }).map(function(c){
      var ns = (opNameScore(m.home, c.home) + opNameScore(m.away, c.away)) / 2, d = opOddsDist(m.ref, c.res);
      return { c: c, ns: ns, d: d, s: ns - (d == null ? 0.3 : 4 * d) };
    }).sort(function(a, b){ return b.s - a.s; });
    if (!cands.length) return;
    var top = cands[0], second = cands[1];
    var oddsOk = top.d != null && top.d <= 0.08;
    var namesOk = top.ns >= 0.5;
    // ohne passende Quoten nur bei sehr klaren Namen; mit Quoten muss das zweitbeste Spiel deutlich schlechter sein
    if (top.d != null && top.d > 0.15) return;
    if (!(oddsOk || (namesOk && top.d == null))) return;
    if (second && top.s - second.s < 0.25 && !(namesOk && second.ns < 0.3)) return;
    used[top.c.fid] = true;
    out[m.id] = { fid: top.c.fid, res: top.c.res, dc: top.c.dc, ou: top.c.ou, hc: top.c.hc, at: top.c.at };
  });
  return out;
}
function opSane(b, ref){ return b > 1 && ref > 1 && Math.abs(1 / b - 1 / ref) <= 0.08 && b / ref <= 1.35 && ref / b <= 1.35; }
function opMargin(arr, lo, hi){ var s = arr.reduce(function(a, x){ return a + 1 / x; }, 0); return s >= lo && s <= hi; }
// Automatische bet365-Quoten in ein Spiel (Rohformat) einsetzen; nur plausible, nur zur Pinnacle-Linie, nur frische
function withAuto(m, a, now, at){
  var t = a && (at || a.fetched || a.at);
  if (!a || !m || !(t > 0) || now - t > AUTO_MAX_AGE) return m;
  var out = Object.assign({}, m), bsrc = Object.assign({}, m.bsrc || {}), any = false;
  var ref = m.ref || {};
  if (a.res && ref.h > 1 && ref.a > 1){
    var keys = ref.d > 1 ? ['h', 'd', 'a'] : ['h', 'a'];
    if (keys.every(function(k){ return a.res[k] > 1; }) && opMargin(keys.map(function(k){ return a.res[k]; }), 1.0, keys.length === 3 ? 1.2 : 1.15)){
      var bk = Object.assign({}, m.book || {});
      keys.forEach(function(k){ if (opSane(a.res[k], ref[k])){ bk[k] = a.res[k]; bsrc['res.' + k] = AUTO_LABEL; any = true; } });
      out.book = bk;
      if (m.sport === 'fb' && a.dc && ref.d > 1){
        var fp = fairProbs([ref.h, ref.d, ref.a], 'power'), pdc = { hx: fp[0] + fp[1], xa: fp[1] + fp[2], ha: fp[0] + fp[2] }, dc = Object.assign({}, m.dc || {});
        DC_KEYS.forEach(function(k){ var b = a.dc[k]; if (b > 1 && Math.abs(1 / b - pdc[k]) <= 0.08 && 1 / b >= pdc[k] - 0.06){ dc[k] = b; bsrc['dc.' + k] = AUTO_LABEL; any = true; } });
        out.dc = dc;
      }
    }
  }
  if (m.ou && m.ou.ref && a.ou){
    var o = a.ou[String(m.ou.line)];
    if (o && o.o > 1 && o.u > 1 && opMargin([o.o, o.u], 1.0, 1.15) && opSane(o.o, m.ou.ref.o) && opSane(o.u, m.ou.ref.u)){
      out.ou = Object.assign({}, m.ou, { book: { o: o.o, u: o.u } }); bsrc['ou.o'] = bsrc['ou.u'] = AUTO_LABEL; any = true;
    }
  }
  if (m.hc && m.hc.ref && a.hc){
    var hh = a.hc[String(m.hc.line)];
    if (hh && hh.h > 1 && hh.a > 1 && opMargin([hh.h, hh.a], 1.0, 1.15) && opSane(hh.h, m.hc.ref.h) && opSane(hh.a, m.hc.ref.a)){
      out.hc = Object.assign({}, m.hc, { book: { h: hh.h, a: hh.a } }); bsrc['hc.h'] = bsrc['hc.a'] = AUTO_LABEL; any = true;
    }
  }
  if (!any) return m;
  out.bsrc = bsrc; out.autoAt = t;
  return out;
}
// Tagesanteil am OddsPapi-Kontingent (nach Wochentag gewichtet); reservePerDay bleibt fuer den Push-Dienst
function opBudget(remaining, spentToday, nowMs, reservePerDay){
  if (remaining == null || !isFinite(remaining)) return null;
  var spent = Math.max(0, spentToday || 0), start = remaining + spent;
  var res = Math.max(0, reservePerDay || 0) * daysLeftInMonth(nowMs);
  var allow = Math.floor(Math.max(0, start - 3 - res) * DAY_WEIGHT[berlinDay(nowMs)] / weightLeft(nowMs));
  return { allow: allow, spent: spent, left: Math.max(0, Math.min(allow - spent, remaining - 3)) };
}
  return { normalizeFeed, applyOverride, selectionsFor, fairOddsFor, convertEvents, leagueByKey, marketsFor, oddsUrl, fmtLine, fmtHc, RULE, SMART_RESERVE,
    opParse, opMatch, withAuto, opUrl, OP_BOOK, OP_BASE, withBetano, findSurebets,
    setAh: function (v) { AH_FB = v !== false; } };
})();

// ---------------------------------------------------------------------------------------------------------------
// Web Push (RFC 8291 Verschluesselung, RFC 8292 VAPID) mit WebCrypto
const enc = new TextEncoder();
function b64u(buf) {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function unb64u(str) {
  const s = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s + '='.repeat((4 - s.length % 4) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function concat(...parts) {
  const n = parts.reduce((a, p) => a + p.length, 0), out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
async function hkdf(salt, ikm, info, bytes) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}
async function vapidKeys(env) {
  let k = await env.VS.get('vapid', 'json');
  if (k && k.pub && k.jwk) return k;
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  k = { pub: b64u(await crypto.subtle.exportKey('raw', pair.publicKey)), jwk: await crypto.subtle.exportKey('jwk', pair.privateKey) };
  await env.VS.put('vapid', JSON.stringify(k));
  return k;
}
async function vapidHeader(endpoint, keys, subject, nowMs) {
  const head = b64u(enc.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const body = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(nowMs / 1000) + 12 * 3600, sub: subject })));
  const key = await crypto.subtle.importKey('jwk', keys.jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc.encode(head + '.' + body));
  return 'vapid t=' + head + '.' + body + '.' + b64u(sig) + ', k=' + keys.pub;
}
// fixed (nur fuer Tests): { salt, local } um das Beispiel aus RFC 8291 Anhang A nachzurechnen
async function encryptPayload(sub, text, fixed) {
  const uaPub = unb64u(sub.keys.p256dh), auth = unb64u(sub.keys.auth);
  const uaKey = await crypto.subtle.importKey('raw', uaPub, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const local = fixed ? fixed.local : await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPub = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));
  const ikm = await hkdf(auth, secret, concat(enc.encode('WebPush: info\0'), uaPub, asPub), 32);
  const salt = fixed ? fixed.salt : crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const plain = concat(enc.encode(text), new Uint8Array([2]));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aes, plain));
  const rs = new Uint8Array([0, 0, 16, 0]); // Datensatzgroesse 4096
  return concat(salt, rs, new Uint8Array([asPub.length]), asPub, ct);
}
function validSub(s) {
  try {
    return !!(s && typeof s.endpoint === 'string' && /^https:\/\//.test(s.endpoint) && s.endpoint.length < 1000 && s.keys &&
      unb64u(s.keys.p256dh).length === 65 && unb64u(s.keys.auth).length === 16);
  } catch (e) { return false; }
}
async function sendPush(env, sub, msg, nowMs, ttl) {
  const keys = await vapidKeys(env);
  const body = await encryptPayload(sub, JSON.stringify(msg));
  const r = await fetch(sub.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await vapidHeader(sub.endpoint, keys, originOf(env), nowMs),
      'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream',
      TTL: String(ttl || 3600), Urgency: 'high'
    },
    body
  });
  let text = '';
  try { text = (await r.text()).slice(0, 300); } catch (e) { /* leer */ }
  return { status: r.status, body: text };
}

// ---------------------------------------------------------------------------------------------------------------
// Push-Logik
const MIN = 60000;
const APP_AUTO_LABEL = 'bet365 auto';
// Erinnerung X Min vor Anpfiff: Dann sind Aufstellungen (Fussball ~60 Min, NBA 30 Min) bzw. Startgoalies (NHL) bekannt.
// Pinnacle preist sie in Minuten ein, bet365 und Betano oft spaeter: das beste Fenster fuer Value.
const DEFAULT_LEAD = { fb: 55, bb: 25, ih: 45 };
const WHY = {
  fb: 'Aufstellungen sind raus. Pinnacle hat sie eingepreist, bet365 und Betano ziehen oft erst später nach.',
  bb: 'Startformationen stehen. Späte Ausfälle bewegen die Linie, bet365 und Betano reagieren oft verzögert.',
  ih: 'Startgoalies sind bestätigt. Der Goalie bewegt die Quote am stärksten, bet365 und Betano reagieren oft verzögert.'
};
const DATA_FRESH = 30 * MIN; // juenger: kein neuer Abruf fuer die Erinnerung noetig
const CLOSE_WINDOW = 12 * MIN; // Schlussquote: Abruf in den letzten 12 Min vor Anpfiff
const KEEP_SNAPS = 24 * 3600000;
const WATCH_EXTRA = 30;          // Beobachtung beginnt 30 Min vor dem Vorlauf
const WATCH_EVERY = 20 * MIN;    // je Liga hoechstens alle 20 Min ein Blick
const MOVE_P = 0.03;             // Bewegung: faire Chance aendert sich um mindestens 3 Prozentpunkte

function berlinDay(ms) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date(ms)); } catch (e) { return new Date(ms).toISOString().slice(0, 10); }
}
function berlinHm(ms) {
  try { return new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' }).format(new Date(ms)); } catch (e) { return ''; }
}
const f2 = (n) => n.toFixed(2).replace('.', ',');
const pctS = (x) => (x >= 0 ? '+' : '−') + Math.abs(x * 100).toFixed(1).replace('.', ',') + ' %';
const num = (x, lo, hi, d) => (typeof x === 'number' && isFinite(x) && x >= lo && x <= hi ? x : d);

function normCfg(c) {
  c = c && typeof c === 'object' ? c : {};
  const lead = {}, prov = {};
  for (const sp of ['fb', 'bb', 'ih']) {
    lead[sp] = num(c.lead && c.lead[sp], 0, 240, DEFAULT_LEAD[sp]);
    const p = c.prov && c.prov[sp];
    prov[sp] = { book: p && typeof p.book === 'string' ? p.book.slice(0, 20) : 'bet365', tf: num(p && p.tf, 0.5, 1, 1) };
  }
  return { lead, prov, mode: c.mode === 'smart' ? 'smart' : 'always', value: c.value !== false, calls: num(c.calls, 0, 50, 6), minEdge: num(c.minEdge, 0, 0.5, 0.02),
    devig: c.devig === 'prop' ? 'prop' : 'power', btTf: num(c.btTf, 0.5, 1, 0.947), ah: c.ah !== false, windowH: num(c.windowH, 6, 72, 24) };
}
function quotaOf(r) {
  const n = (k) => { const v = parseFloat(r.headers.get(k)); return isFinite(v) ? v : null; };
  return { remaining: n('x-requests-remaining'), used: n('x-requests-used'), last: n('x-requests-last') };
}
function newestQuota(a, b) {
  if (!a || a.remaining == null) return b && b.remaining != null ? b : null;
  if (!b || b.remaining == null) return a;
  return (b.at || 0) > (a.at || 0) ? b : a;
}
// Spiele (Rohformat der App) zu Spielen mit deinen Quoten und deinem Anbieter
function prepMatches(raw, user, cfg, auto, nowMs) {
  const f = APP.normalizeFeed({ matches: raw });
  return (f ? f.matches : []).map((m) => {
    const p = cfg.prov[m.sport] || cfg.prov.fb;
    const a = auto && auto[m.id];
    const base = a && p.book === APP.OP_BOOK ? APP.withAuto(m, a, nowMs, a.fetched) : m;
    return Object.assign(APP.applyOverride(base, user.ov && user.ov[m.id]), { bookName: p.book, taxF: p.tf });
  });
}
function valueLegs(m, cfg) {
  return APP.selectionsFor(m, cfg.devig).filter((s) => s.ev >= cfg.minEdge && s.book >= APP.RULE.minLeg && !s.split);
}
function fairText(m, cfg) {
  const f = APP.fairOddsFor(m, cfg.devig);
  if (!(f.res.h && f.res.a)) return '';
  const parts = [m.home.split(' ')[0] + ' ' + f2(f.res.h)];
  if (f.res.d) parts.push('X ' + f2(f.res.d));
  parts.push(m.away.split(' ')[0] + ' ' + f2(f.res.a));
  return 'Fair: ' + parts.join(' · ');
}
function shortGame(m) { return m.home + ' – ' + m.away; }

async function runCron(env, nowMs) {
  if (!env.VS) return { skipped: 'kv' };
  const user = await env.VS.get('user', 'json');
  if (!user || !validSub(user.sub)) return { skipped: 'nosub' };
  const st = (await env.VS.get('state', 'json')) || {};
  st.sent = st.sent || {}; st.closeDone = st.closeDone || {}; st.log = Array.isArray(st.log) ? st.log : [];
  // Schnappschuesse nur laden, wenn dieser Durchlauf sie braucht (spart Rechenzeit, Cloudflare-Limit 10 ms)
  let snaps = null;
  const loadSnaps = async () => { if (!snaps) snaps = (await env.VS.get('snaps', 'json')) || []; return snaps; };
  let dirtyState = false, dirtySnaps = false, dirtyUser = false;
  const cfg = normCfg(user.cfg);
  APP.setAh(cfg.ah);
  const day = berlinDay(nowMs);
  if (!st.spent || st.spent.day !== day) { st.spent = { day, n: 0 }; dirtyState = true; }
  const apiKey = env.ODDS_API_KEY || (typeof user.apiKey === 'string' ? user.apiKey : '');
  let fatal = false;
  const report = { fetched: [], pushed: 0 };
  const quota = () => newestQuota(st.quota, user.quota);
  const canSpend = (cost, kind) => {
    if (!apiKey || fatal) return false;
    const q = quota();
    if (q && q.remaining != null && q.remaining - cost < (kind === 'close' ? 5 : APP.SMART_RESERVE)) return false;
    if (kind !== 'close' && st.spent.n + cost > cfg.calls) return false;
    return true;
  };
  const logAdd = (txt) => { st.log.push({ at: nowMs, t: txt.slice(0, 160) }); st.log = st.log.slice(-15); dirtyState = true; };
  const fetchLeague = async (lkey, markets, fromMs, toMs, full, kind) => {
    const lg = APP.leagueByKey(lkey);
    if (!lg) return null;
    const u = new URL(APP.oddsUrl('', apiKey, lg, fromMs, toMs));
    u.searchParams.set('markets', markets.join(','));
    const cost = markets.length;
    if (!canSpend(cost, kind)) return null;
    let r;
    try { r = await fetch(u.toString(), { headers: { Accept: 'application/json' } }); } catch (e) { logAdd('Abruf fehlgeschlagen: ' + lg.name); return null; }
    const q = quotaOf(r);
    if (q.remaining != null) st.quota = { remaining: q.remaining, used: q.used, at: nowMs };
    if (!r.ok) {
      if (r.status === 401 || r.status === 429) fatal = true;
      logAdd('The Odds API Fehler ' + r.status + ' (' + lg.name + ')');
      return null;
    }
    st.spent.n += q.last != null ? q.last : cost; dirtyState = true;
    let ev;
    try { ev = await r.json(); } catch (e) { return null; }
    if (!Array.isArray(ev)) return null;
    const snap = { id: lkey + ':' + nowMs, lkey, at: nowMs, mk: markets, full, ev };
    (await loadSnaps()).push(snap); dirtySnaps = true;
    report.fetched.push(lkey + (full ? '' : ' (Schluss)'));
    return snap;
  };

  const games = Array.isArray(user.games) ? user.games : [];
  const koOf = (g) => Date.parse(g.kickoff);

  // 1) Schlussquote fuer offene Tipps: Abruf in den letzten 12 Min vor Anpfiff, nur die noetigen Maerkte
  const legs = (Array.isArray(user.legs) ? user.legs : []).filter((l) => l && typeof l.mid === 'string' && l.ko - nowMs > 0 && l.ko - nowMs <= CLOSE_WINDOW && !st.closeDone[l.mid]);
  const byLeague = {};
  legs.forEach((l) => { (byLeague[l.lkey] = byLeague[l.lkey] || []).push(l); });
  for (const lkey of Object.keys(byLeague)) {
    const ls = byLeague[lkey], need = {};
    ls.forEach((l) => { need[l.market === 'ou' ? 'totals' : (l.market === 'hc' ? 'spreads' : 'h2h')] = 1; });
    const lg = APP.leagueByKey(lkey);
    if (!lg) continue;
    const markets = APP.marketsFor(lg.sport).filter((k) => need[k]);
    const maxKo = Math.max.apply(null, ls.map((l) => l.ko));
    const snap = await fetchLeague(lkey, markets, nowMs, maxKo + MIN, false, 'close');
    if (snap) ls.forEach((l) => { st.closeDone[l.mid] = nowMs; });
  }

  // 2) Vor Anpfiff beobachten: Fenster von (Vorlauf + 30 Min) bis 8 Min vor Anpfiff, je Liga hoechstens alle 20 Min ein Blick.
  //    Gemeldet wird, wenn sich ein Blick lohnt: Value (bet365 automatisch oder deine Quoten) oder Pinnacle hat sich deutlich bewegt
  //    (dann haengen bet365/Betano oft hinterher). Modus "always": zusaetzlich die Erinnerung zum Vorlauf, auch ohne Signal.
  st.base = st.base || {}; st.valSent = st.valSent || {}; st.chk = st.chk || {};
  const inWin = (g) => { const lead = cfg.lead[g.sport] || 0, ms = koOf(g) - nowMs; return lead > 0 && isFinite(ms) && ms > 8 * MIN && ms <= (lead + WATCH_EXTRA) * MIN; };
  const mainDue = (g) => { const ms = koOf(g) - nowMs; return ms <= (cfg.lead[g.sport] || 0) * MIN && ms > 3 * MIN && !st.sent[g.id]; };
  const watch = games.filter(inWin);
  const leaguesAll = [...new Set(watch.map((g) => g.lkey))];
  const checkLeagues = leaguesAll.filter((k) => watch.some((g) => g.lkey === k && mainDue(g)) || nowMs - (st.chk[k] || 0) >= WATCH_EVERY);
  if (checkLeagues.length) {
    await loadSnaps();
    const hasOv = (k) => watch.some((g) => g.lkey === k && user.ov && user.ov[g.id]);
    checkLeagues.sort((a, b) => (watch.some((g) => g.lkey === b && mainDue(g)) - watch.some((g) => g.lkey === a && mainDue(g))) || (hasOv(b) - hasOv(a)) ||
      (watch.filter((g) => g.lkey === b).length - watch.filter((g) => g.lkey === a).length));
    // Pinnacle: zum Vorlauf alle Maerkte, dazwischen nur 1X2 (1 Abruf) als Bewegungs-Waechter
    for (const lkey of checkLeagues) {
      const lg = APP.leagueByKey(lkey);
      if (!lg) continue;
      st.chk[lkey] = nowMs; dirtyState = true;
      const appAt = Math.max(0, ...games.filter((g) => g.lkey === lkey && typeof g.oddsAt === 'number').map((g) => g.oddsAt));
      const snapAt = Math.max(0, ...snaps.filter((s) => s.lkey === lkey && s.ev).map((s) => s.at));
      if (nowMs - Math.max(appAt, snapAt) < 15 * MIN) continue;
      const full = watch.some((g) => g.lkey === lkey && mainDue(g));
      await fetchLeague(lkey, full ? APP.marketsFor(lg.sport) : ['h2h'], nowMs, nowMs + cfg.windowH * 3600000, full, 'remind');
    }
    // neueste Pinnacle-Daten je Spiel: 1X2 aus dem juengsten Abruf, Ue/U und Handicap aus dem juengsten vollen Abruf
    const rawById = {};
    games.forEach((g) => { rawById[g.id] = g; });
    const wl = new Set(leaguesAll);
    snaps.filter((s) => s.ev && wl.has(s.lkey)).sort((a, b) => a.at - b.at).forEach((s) => {
      const lg = APP.leagueByKey(s.lkey);
      if (!lg) return;
      APP.convertEvents(s.ev, lg, s.at).forEach((m) => {
        const old = rawById[m.id];
        if (old && old.oddsAt >= m.oddsAt) return;
        rawById[m.id] = s.full || !old ? m : Object.assign({}, old, { ref: m.ref.h > 1 ? m.ref : old.ref, oddsAt: m.oddsAt, refAt: m.refAt || old.refAt });
      });
    });
    // bet365 automatisch (OddsPapi): bei der Erinnerung oder wenn sich Pinnacle bewegt hat
    const moves = [];
    watch.forEach((g) => {
      const m = rawById[g.id];
      if (!m || !m.ref || !(m.ref.h > 1 && m.ref.a > 1)) return;
      const f = APP.fairOddsFor(APP.normalizeFeed({ matches: [m] }).matches[0] || {}, cfg.devig);
      const keys = m.ref.d > 1 ? ['h', 'd', 'a'] : ['h', 'a'];
      const now = {}; keys.forEach((k) => { now[k] = f.res[k] > 1 ? 1 / f.res[k] : null; });
      const b0 = st.base[g.id];
      if (!b0) { st.base[g.id] = { p: now, o: m.ref, at: m.oddsAt || nowMs }; dirtyState = true; return; }
      if (!((m.oddsAt || 0) > (b0.at || 0))) return;
      let best = null;
      keys.forEach((k) => { if (now[k] != null && b0.p[k] != null) { const d = now[k] - b0.p[k]; if (Math.abs(d) >= MOVE_P && (!best || Math.abs(d) > Math.abs(best.d))) best = { k, d }; } });
      if (best) { moves.push({ g, m, k: best.k, d: best.d, from: b0.o[best.k], to: m.ref[best.k] }); st.base[g.id] = { p: now, o: m.ref, at: m.oddsAt }; dirtyState = true; }
    });
    const auto = Object.assign({}, user.auto || {});
    const op = user.op;
    const wantOp = watch.filter((g) => mainDue(g) || moves.some((x) => x.g.id === g.id));
    if (op && op.key && op.tours && op.idx && wantOp.length) {
      const opDay = berlinDay(nowMs);
      if (!st.opSpent || st.opSpent.day !== opDay) st.opSpent = { day: opDay, n: 0 };
      const wantL = new Set(wantOp.map((g) => g.lkey));
      const tids = [...wantL].filter((k) => { const lg = APP.leagueByKey(k); return lg && op.tours[k] && (cfg.prov[lg.sport] || {}).book === APP.OP_BOOK; }).map((k) => op.tours[k]);
      const haveFresh = wantOp.every((g) => auto[g.id] && nowMs - (auto[g.id].fetched || 0) < 15 * MIN);
      const opLeft = op.remaining == null ? Infinity : op.remaining - (st.opTotal || 0) + (op.seen || 0);
      if (tids.length && !haveFresh && st.opSpent.n < (op.calls == null ? 3 : op.calls) && opLeft > 3) {
        try {
          const all = [...new Set(tids)], size = op.maxT > 0 ? op.maxT : 3, list = [];
          let okAny = false, lastStatus = 0;
          for (let i = 0; i < all.length && st.opSpent.n < (op.calls == null ? 3 : op.calls); i += size) {
            const u = APP.opUrl('', '/v4/odds-by-tournaments', { bookmaker: op.book || APP.OP_BOOK, tournamentIds: all.slice(i, i + size).join(','), oddsFormat: 'decimal', apiKey: op.key });
            if (i) await new Promise((res) => setTimeout(res, 1100));
            const r = await fetch(u, { headers: { Accept: 'application/json' } });
            st.opSpent.n++; st.opTotal = (st.opTotal || 0) + 1; dirtyState = true; lastStatus = r.status;
            if (r.ok) { okAny = true; const part = await r.json(); if (Array.isArray(part)) list.push(...part); }
          }
          if (okAny) {
            const tid2l = {};
            Object.keys(op.tours).forEach((k) => { tid2l[op.tours[k]] = k; });
            const parsed = APP.opParse(list, op.idx, tid2l, op.book || APP.OP_BOOK);
            const hit = APP.opMatch(Object.values(rawById).filter((g) => wantL.has(g.lkey)), parsed);
            Object.keys(hit).forEach((id) => { hit[id].fetched = nowMs; auto[id] = hit[id]; });
            if (Object.keys(hit).length) { snaps.push({ id: 'auto:' + nowMs, kind: 'auto', at: nowMs, auto: hit }); dirtySnaps = true; }
            report.fetched.push('bet365 (' + Object.keys(hit).length + ')');
          } else logAdd('OddsPapi Fehler ' + lastStatus);
        } catch (e) { logAdd('OddsPapi nicht erreichbar'); }
      }
    }
    // Value: nur neue (oder deutlich gestiegene) Tipps melden
    const ms = prepMatches(watch.map((g) => rawById[g.id] || g), user, cfg, auto, nowMs);
    const vals = [];
    if (cfg.value) ms.forEach((m) => valueLegs(m, cfg).forEach((s) => {
      const key = m.id + '|' + s.market + '|' + s.key + '|' + (s.line == null ? '' : s.line);
      const prev = st.valSent[key];
      if (!prev || s.ev >= prev.ev + 0.02 || nowMs - prev.at > 90 * MIN) vals.push({ m, s, key });
    }));
    vals.sort((a, b) => b.s.ev - a.s.ev);
    // Surebets: dein Anbieter gegen deine eingetragenen Betano-Quoten
    st.sbSent = st.sbSent || {};
    const sbs = [];
    ms.forEach((m) => {
      const bt = user.ov && user.ov[m.id] && user.ov[m.id].bt;
      if (!bt || m.bookName === 'Betano') return;
      const b = APP.withBetano(m, bt);
      APP.findSurebets(m, [{ name: m.bookName, tf: m.taxF, m }, { name: 'Betano', tf: cfg.btTf, m: b }]).forEach((sb) => {
        const key = m.id + '|' + sb.legs.map((l) => l.book + l.market + l.key).join(',');
        const prev = st.sbSent[key];
        if (!prev || sb.profit >= prev.p + 0.01 || nowMs - prev.at > 90 * MIN) sbs.push({ sb, key });
      });
    });
    sbs.sort((a, b) => b.sb.profit - a.sb.profit);
    const main = watch.filter(mainDue);
    let msg = null;
    if (sbs.length) {
      const sb = sbs[0].sb;
      msg = { title: '🔒 Surebet +' + (sb.profit * 100).toFixed(1).replace('.', ',') + ' %: ' + sb.game,
        body: sb.legs.map((l) => l.book + ': ' + l.label + ' @ ' + f2(l.odds)).join('\n') + '\nSicherer Gewinn, egal wie das Spiel ausgeht. Öffne die App für die Einsätze und prüf beide Quoten vor dem Setzen.',
        tag: 'sure', url: './' };
      sbs.forEach((x) => { st.sbSent[x.key] = { p: x.sb.profit, at: nowMs }; });
    } else if (vals.length) {
      const top = vals[0], prov = top.m.bookName;
      const lines = vals.slice(0, 3).map((v) => v.s.label + ' @ ' + f2(v.s.book) + ' (' + pctS(v.s.ev) + ')');
      const at = top.m.refAt || top.m.oddsAt;
      const viaAuto = top.s.src === APP_AUTO_LABEL;
      const mins = Math.round((top.m.kickoff - nowMs) / MIN);
      msg = { title: '💰 Value bei ' + prov + ': ' + vals.length + (vals.length === 1 ? ' Tipp' : ' Tipps'),
        body: lines.join('\n') + '\n' + (viaAuto ? prov + '-Quoten automatisch von ' + berlinHm(top.m.autoAt) : 'Mit deinen eingetragenen Quoten') + ', Pinnacle ' + (at ? 'von ' + berlinHm(at) : '') + '. Prüf, ob ' + prov + ' sie noch bietet. Anpfiff in ' + mins + ' Min.',
        tag: 'value', url: './' };
      vals.forEach((v) => { st.valSent[v.key] = { ev: v.s.ev, at: nowMs }; });
    } else if (moves.length) {
      moves.sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
      const mv = moves[0], g = mv.g, mins = Math.round((koOf(g) - nowMs) / MIN);
      const who = mv.k === 'h' ? g.home : (mv.k === 'a' ? g.away : 'Remis');
      const more = moves.length > 1 ? ' (+' + (moves.length - 1) + ' weitere)' : '';
      msg = { title: '📈 Pinnacle bewegt sich: ' + shortGame(g),
        body: who + ' ' + f2(mv.from) + ' → ' + f2(mv.to) + more + '. Meist steckt eine News dahinter (Aufstellung, Ausfall). bet365 und Betano ziehen oft erst später nach: Jetzt lohnt sich ein Blick. Anpfiff in ' + mins + ' Min.',
        tag: 'move', url: './' };
    } else if (main.length && cfg.mode === 'always') {
      const mins = Math.round((Math.min(...main.map(koOf)) - nowMs) / MIN);
      const mm = prepMatches(main.map((g) => rawById[g.id] || g), user, cfg, auto, nowMs);
      const sports = [...new Set(main.map((g) => g.sport))];
      const names = mm.slice(0, 3).map(shortGame).join(', ') + (mm.length > 3 ? ' (+' + (mm.length - 3) + ')' : '');
      const one = mm.length === 1 ? fairText(mm[0], cfg) : '';
      msg = { title: '⏱ Anpfiff in ' + mins + ' Min', body: names + '\n' + (sports.length === 1 ? WHY[sports[0]] : 'Aufstellungen sind raus, bet365 und Betano ziehen oft erst später nach.') + ' Jetzt Quoten prüfen.' + (one ? '\n' + one : ''), tag: 'kickoff', url: './' };
    }
    main.forEach((g) => { st.sent[g.id] = nowMs; });
    if (main.length) dirtyState = true;
    if (msg) {
      const r = await sendPush(env, user.sub, msg, nowMs, 3600);
      if (r.status === 404 || r.status === 410) { user.sub = null; dirtyUser = true; logAdd('Abo abgelaufen: Push in der App neu einschalten'); }
      else if (r.status >= 200 && r.status < 300) { report.pushed++; logAdd(msg.title); }
      else logAdd('Push abgelehnt (' + r.status + '): ' + r.body);
    } else if (main.length) logAdd('Geprüft, nichts Lohnendes: ' + main.slice(0, 2).map(shortGame).join(', '));
  }

  // 3) Aufraeumen
  const old = nowMs - 2 * 86400000;
  for (const k of Object.keys(st.sent)) if (st.sent[k] < old) { delete st.sent[k]; dirtyState = true; }
  for (const k of Object.keys(st.closeDone)) if (st.closeDone[k] < old) { delete st.closeDone[k]; dirtyState = true; }
  for (const k of Object.keys(st.base || {})) if (!(st.base[k].at > old)) { delete st.base[k]; dirtyState = true; }
  for (const k of Object.keys(st.valSent || {})) if (st.valSent[k].at < old) { delete st.valSent[k]; dirtyState = true; }
  for (const k of Object.keys(st.sbSent || {})) if (st.sbSent[k].at < old) { delete st.sbSent[k]; dirtyState = true; }
  for (const k of Object.keys(st.chk || {})) if (st.chk[k] < old) { delete st.chk[k]; dirtyState = true; }
  // alte Schnappschuesse aufraeumen: wenn sie ohnehin geladen sind, sonst alle 6 Stunden
  const cleanDue = !st.cleanAt || nowMs - st.cleanAt > 6 * 3600000;
  if (snaps || cleanDue) {
    await loadSnaps();
    const keep = snaps.filter((s) => nowMs - s.at < KEEP_SNAPS).slice(-15);
    if (keep.length !== snaps.length) { snaps = keep; dirtySnaps = true; }
    if (cleanDue) { st.cleanAt = nowMs; dirtyState = true; }
  }
  if (dirtySnaps) await env.VS.put('snaps', JSON.stringify(snaps));
  if (dirtyState) await env.VS.put('state', JSON.stringify(st));
  if (dirtyUser) await env.VS.put('user', JSON.stringify(user));
  return report;
}

async function sha256hex(s) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(s)));
  return Array.from(h, (b) => b.toString(16).padStart(2, '0')).join('');
}
async function readBody(request) {
  const t = await request.text();
  if (t.length > 600000) throw new Error('size');
  return JSON.parse(t);
}
async function checkOwner(env, token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{32,64}$/.test(token)) return false;
  const h = await sha256hex(token), own = await env.VS.get('owner');
  if (!own) { await env.VS.put('owner', h); return true; }
  return own === h;
}
const FOREIGN = 'Dieser Push-Dienst ist schon mit einem anderen Gerät verbunden. Zum Zurücksetzen im KV-Speicher den Eintrag „owner“ löschen.';

async function push(request, headers, env, nowMs) {
  if (!env.VS) return json(500, 'KV-Speicher fehlt: Lege beim Worker unter Bindings einen KV namespace mit dem Namen VS an.', headers);
  const path = new URL(request.url).pathname;
  if (path === '/push/key' && request.method === 'GET') return jsonData({ key: (await vapidKeys(env)).pub }, headers);
  if (request.method !== 'POST') return json(405, 'Method not allowed', headers);
  let b;
  try { b = await readBody(request); } catch (e) { return json(400, 'Ungültige Anfrage', headers); }
  if (!b || typeof b !== 'object') return json(400, 'Ungültige Anfrage', headers);
  if (!(await checkOwner(env, b.token))) return json(403, FOREIGN, headers);
  const user = (await env.VS.get('user', 'json')) || {};

  if (path === '/push/sync') {
    if (b.sub != null && !validSub(b.sub)) return json(400, 'Ungültiges Push-Abo', headers);
    const next = {
      sub: b.sub || user.sub || null,
      apiKey: typeof b.apiKey === 'string' && b.apiKey ? b.apiKey.slice(0, 80) : (user.apiKey || ''),
      cfg: normCfg(b.cfg),
      games: Array.isArray(b.games) ? b.games.slice(0, 300) : [],
      ov: b.ov && typeof b.ov === 'object' ? b.ov : {},
      legs: Array.isArray(b.legs) ? b.legs.slice(0, 100).filter((l) => l && typeof l.mid === 'string').map((l) => ({ mid: l.mid.slice(0, 120), lkey: String(l.lkey || '').slice(0, 60), market: String(l.market || '').slice(0, 4), ko: +l.ko })) : [],
      quota: b.quota && typeof b.quota.remaining === 'number' ? { remaining: b.quota.remaining, used: b.quota.used, at: +b.quota.at || 0 } : (user.quota || null),
      op: b.op && typeof b.op === 'object' && typeof b.op.key === 'string' && b.op.key ? { key: b.op.key.slice(0, 100), book: String(b.op.book || 'bet365').slice(0, 30), tours: b.op.tours || {}, idx: b.op.idx || null,
        maxT: num(b.op.maxT, 1, 10, 3),
        calls: num(b.op.calls, 0, 20, 3), remaining: typeof b.op.remaining === 'number' ? b.op.remaining : null, seen: +b.op.seen || 0 } : null,
      auto: b.auto && typeof b.auto === 'object' ? b.auto : {},
      dg: b.dg && typeof b.dg === 'object' && JSON.stringify(b.dg).length < 4000 ? b.dg : null
    };
    if (JSON.stringify(next) !== JSON.stringify(user)) await env.VS.put('user', JSON.stringify(next));
    const st = (await env.VS.get('state', 'json')) || {};
    const snaps = (await env.VS.get('snaps', 'json')) || [];
    const since = +b.since || 0;
    return jsonData({ ok: true, ver: WORKER_VER, active: validSub(next.sub), snaps: snaps.filter((s) => s.at > since), quota: st.quota || null, opTotal: st.opTotal || 0, log: (st.log || []).slice(-10), spent: st.spent || null, now: nowMs }, headers);
  }
  if (path === '/push/test') {
    if (!validSub(user.sub)) return json(409, 'Kein Push-Abo gespeichert. Schalte Benachrichtigungen in der App ein.', headers);
    const r = await sendPush(env, user.sub, { title: 'Value Slip', body: 'Test: Benachrichtigungen funktionieren.', tag: 'test', url: './' }, nowMs, 600);
    if (r.status === 404 || r.status === 410) { user.sub = null; await env.VS.put('user', JSON.stringify(user)); }
    return jsonData({ status: r.status, body: r.body }, headers);
  }
  if (path === '/push/off') {
    if (user.sub) { user.sub = null; await env.VS.put('user', JSON.stringify(user)); }
    return jsonData({ ok: true }, headers);
  }
  if (path === '/push/run') {
    // Zum Pruefen: einen Durchlauf sofort ausfuehren (wie der 5-Minuten-Takt)
    return jsonData(await runCron(env, nowMs), headers);
  }
  return json(404, 'Not found', headers);
}

// ===================== Trade Check: Marktdaten, News-Warnung, Kurs-Alarme, Scanner, Trade-Betreuung =====================
const TL = (function () {
// Rechenkern von Trade Check: Indikatoren, Marktstruktur (SMC), Tageslevels, Sessions, News, COT, Positionsgroesse, Setup-Check.
// Reine Funktionen ohne Bildschirm, damit sie getestet und im Push-Dienst wiederverwendet werden koennen.

var INSTRUMENTS = [
  { k: 'EURUSD', name: 'EUR/USD', y: 'EURUSD=X', type: 'fx', ccy: ['EUR', 'USD'], quote: 'USD', cot: '099741', cotSign: 1, dec: 5, zone: 'eu' },
  { k: 'GBPUSD', name: 'GBP/USD', y: 'GBPUSD=X', type: 'fx', ccy: ['GBP', 'USD'], quote: 'USD', cot: '096742', cotSign: 1, dec: 5, zone: 'eu' },
  { k: 'USDJPY', name: 'USD/JPY', y: 'JPY=X', type: 'fx', ccy: ['USD', 'JPY'], quote: 'JPY', cot: '097741', cotSign: -1, dec: 3, zone: 'asia' },
  { k: 'XAUUSD', name: 'Gold', y: 'GC=F', type: 'cmd', ccy: ['USD'], quote: 'USD', cot: '088691', cotSign: 1, dec: 2, zone: 'us', basis: true },
  { k: 'XAGUSD', name: 'Silber', y: 'SI=F', type: 'cmd', ccy: ['USD'], quote: 'USD', cot: '084691', cotSign: 1, dec: 3, zone: 'us', basis: true },
  { k: 'WTI', name: 'Öl (WTI)', y: 'CL=F', type: 'cmd', ccy: ['USD'], quote: 'USD', cot: '067651', cotSign: 1, dec: 2, zone: 'us', basis: true, kw: /crude|oil|opec/i },
  { k: 'DAX', name: 'DAX', y: '^GDAXI', type: 'idx', ccy: ['EUR'], quote: 'EUR', cot: null, dec: 1, zone: 'eu' },
  { k: 'NDX', name: 'Nasdaq 100', y: '^NDX', type: 'idx', ccy: ['USD'], quote: 'USD', cot: '209742', cotSign: 1, dec: 1, zone: 'us' },
  { k: 'SPX', name: 'S&P 500', y: '^GSPC', type: 'idx', ccy: ['USD'], quote: 'USD', cot: '13874A', cotSign: 1, dec: 1, zone: 'us' },
  { k: 'DJI', name: 'Dow Jones', y: '^DJI', type: 'idx', ccy: ['USD'], quote: 'USD', cot: null, dec: 1, zone: 'us' },
  { k: 'AUDUSD', name: 'AUD/USD', y: 'AUDUSD=X', type: 'fx', ccy: ['AUD', 'USD'], quote: 'USD', cot: '232741', cotSign: 1, dec: 5, zone: 'eu' },
  { k: 'USDCAD', name: 'USD/CAD', y: 'CAD=X', type: 'fx', ccy: ['USD', 'CAD'], quote: 'CAD', cot: '090741', cotSign: -1, dec: 5, zone: 'us' },
  { k: 'USDCHF', name: 'USD/CHF', y: 'CHF=X', type: 'fx', ccy: ['USD', 'CHF'], quote: 'CHF', cot: '092741', cotSign: -1, dec: 5, zone: 'eu' },
  { k: 'NZDUSD', name: 'NZD/USD', y: 'NZDUSD=X', type: 'fx', ccy: ['NZD', 'USD'], quote: 'USD', cot: '112741', cotSign: 1, dec: 5, zone: 'eu' },
  { k: 'EURJPY', name: 'EUR/JPY', y: 'EURJPY=X', type: 'fx', ccy: ['EUR', 'JPY'], quote: 'JPY', cot: null, dec: 3, zone: 'eu' },
  { k: 'GBPJPY', name: 'GBP/JPY', y: 'GBPJPY=X', type: 'fx', ccy: ['GBP', 'JPY'], quote: 'JPY', cot: null, dec: 3, zone: 'eu' },
  { k: 'EURGBP', name: 'EUR/GBP', y: 'EURGBP=X', type: 'fx', ccy: ['EUR', 'GBP'], quote: 'GBP', cot: null, dec: 5, zone: 'eu' },
  { k: 'BRENT', name: 'Öl (Brent)', y: 'BZ=F', type: 'cmd', ccy: ['USD'], quote: 'USD', cot: null, dec: 2, zone: 'us', basis: true, kw: /crude|oil|opec/i },
  { k: 'COPPER', name: 'Kupfer', y: 'HG=F', type: 'cmd', ccy: ['USD'], quote: 'USD', cot: '085692', cotSign: 1, dec: 4, zone: 'us', basis: true }
];
// Liquide Aktien, die der Scanner zusaetzlich durchsucht (alle bei Trade Republic mit Knock-outs handelbar)
var SCAN_STOCKS = ['NVDA', 'TSLA', 'AAPL', 'MSFT', 'AMZN', 'META', 'GOOGL', 'AMD', 'SAP.DE', 'RHM.DE', 'SIE.DE', 'ALV.DE'];
function scanUniverse(){ return INSTRUMENTS.concat(SCAN_STOCKS.map(stockInstrument)); }
// Eigene Aktie: Symbol wie bei Yahoo (AAPL, NVDA, SAP.DE, RHM.DE)
function stockInstrument(sym){
  var s = String(sym || '').trim().toUpperCase();
  if (!/^[A-Z0-9^.\-=]{1,15}$/.test(s)) return null;
  var de = /\.(DE|F)$/.test(s);
  return { k: 'S:' + s, name: s, y: s, type: 'stock', ccy: [de ? 'EUR' : 'USD'], quote: de ? 'EUR' : 'USD', cot: null, dec: 2, zone: de ? 'eu' : 'usstock', bench: de ? '^GDAXI' : '^GSPC' };
}
function instrumentByKey(k){
  for (var i = 0; i < INSTRUMENTS.length; i++) if (INSTRUMENTS[i].k === k) return INSTRUMENTS[i];
  return String(k || '').indexOf('S:') === 0 ? stockInstrument(k.slice(2)) : null;
}

// ---- Kursdaten
function parseYahoo(j){
  var r = j && j.chart && j.chart.result && j.chart.result[0];
  if (!r || !Array.isArray(r.timestamp)) return [];
  var q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {}, out = [];
  for (var i = 0; i < r.timestamp.length; i++){
    var o = q.open && q.open[i], h = q.high && q.high[i], l = q.low && q.low[i], c = q.close && q.close[i];
    if ([o, h, l, c].every(function(x){ return typeof x === 'number' && isFinite(x); })) out.push({ t: r.timestamp[i] * 1000, o: o, h: Math.max(h, o, c), l: Math.min(l, o, c), c: c, v: (q.volume && q.volume[i]) || 0 });
  }
  return out;
}
function ema(vals, n){
  var k = 2 / (n + 1), out = [], e = null;
  for (var i = 0; i < vals.length; i++){
    if (e == null){ if (i === n - 1){ var s = 0; for (var j = 0; j < n; j++) s += vals[j]; e = s / n; out.push(e); } else out.push(null); }
    else { e = vals[i] * k + e * (1 - k); out.push(e); }
  }
  return out;
}
// ATR nach Wilder
function atr(c, n){
  n = n || 14;
  if (c.length < n + 1) return null;
  var tr = [];
  for (var i = 1; i < c.length; i++) tr.push(Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c)));
  var a = 0; for (var j = 0; j < n; j++) a += tr[j]; a /= n;
  for (var k = n; k < tr.length; k++) a = (a * (n - 1) + tr[k]) / n;
  return a;
}
// Swing-Hochs/-Tiefs (Fraktal: hoeher/tiefer als k Kerzen links und rechts)
function swings(c, k){
  k = k || 2;
  var hi = [], lo = [];
  for (var i = k; i < c.length - k; i++){
    var isH = true, isL = true;
    for (var j = 1; j <= k; j++){
      if (!(c[i].h > c[i - j].h && c[i].h >= c[i + j].h)) isH = false;
      if (!(c[i].l < c[i - j].l && c[i].l <= c[i + j].l)) isL = false;
    }
    if (isH) hi.push({ i: i, p: c[i].h, t: c[i].t });
    if (isL) lo.push({ i: i, p: c[i].l, t: c[i].t });
  }
  return { hi: hi, lo: lo };
}
// Marktstruktur: Schlusskurs ueber dem letzten Swing-Hoch = Bruch nach oben (BOS in Trendrichtung, sonst CHoCH)
function structure(c, k){
  k = k || 2;
  var sw = swings(c, k), trend = null, last = null, events = [];
  var hiIdx = 0, loIdx = 0, refH = null, refL = null;
  for (var j = 0; j < c.length; j++){
    while (hiIdx < sw.hi.length && sw.hi[hiIdx].i + k <= j){ refH = sw.hi[hiIdx]; hiIdx++; }
    while (loIdx < sw.lo.length && sw.lo[loIdx].i + k <= j){ refL = sw.lo[loIdx]; loIdx++; }
    if (refH && c[j].c > refH.p){
      var ev = { dir: 1, kind: trend === 1 ? 'BOS' : 'CHoCH', level: refH.p, t: c[j].t, i: j };
      events.push(ev); last = ev; trend = 1; refH = null;
    } else if (refL && c[j].c < refL.p){
      var ev2 = { dir: -1, kind: trend === -1 ? 'BOS' : 'CHoCH', level: refL.p, t: c[j].t, i: j };
      events.push(ev2); last = ev2; trend = -1; refL = null;
    }
  }
  return { trend: trend, last: last, events: events, swings: sw };
}
// Fair Value Gaps (3-Kerzen-Luecke), nur noch offene
function fvgs(c, maxAge){
  var out = [], from = Math.max(2, c.length - (maxAge || 60));
  for (var i = from; i < c.length; i++){
    var a = c[i - 2], b = c[i];
    if (b.l > a.h) out.push({ dir: 1, lo: a.h, hi: b.l, i: i, t: b.t });
    else if (b.h < a.l) out.push({ dir: -1, lo: b.h, hi: a.l, i: i, t: b.t });
  }
  return out.filter(function(g){
    for (var j = g.i + 1; j < c.length; j++){
      if (g.dir === 1 && c[j].l <= g.lo) return false;
      if (g.dir === -1 && c[j].h >= g.hi) return false;
    }
    return true;
  });
}

// ---- Zeit (Berlin)
function berlinParts(ms){
  var f = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' });
  var p = {}; f.formatToParts(new Date(ms)).forEach(function(x){ p[x.type] = x.value; });
  return { key: p.year + '-' + p.month + '-' + p.day, hh: +p.hour, mm: +p.minute, wd: p.weekday, min: (+p.hour) * 60 + (+p.minute) };
}
// Vortag, heute, Asien-Range (00:00-08:00 Berlin) aus Intraday-Kerzen
function dayLevels(c, now){
  var today = berlinParts(now).key, days = {}, order = [];
  var wk = {};
  c.forEach(function(x){ var b = berlinParts(x.t), k = b.key; if (!days[k]){ days[k] = []; order.push(k); wk[k] = b.wd; } days[k].push(x); });
  // Vortag = letzter Handelstag (Wochenend-Reste wie die Freitag-23-Uhr-Kerze zaehlen nicht)
  var prevKey = order.filter(function(k){ return k < today && wk[k] !== 'Sat' && wk[k] !== 'Sun'; }).pop();
  var rng = function(arr){ return arr && arr.length ? { hi: Math.max.apply(null, arr.map(function(x){ return x.h; })), lo: Math.min.apply(null, arr.map(function(x){ return x.l; })) } : null; };
  var td = days[today] || [];
  var asia = td.filter(function(x){ return berlinParts(x.t).hh < 8; });
  return { prev: rng(days[prevKey]), today: rng(td), asia: rng(asia), prevKey: prevKey, todayKey: today };
}
// Handelszeiten fuer Daytrader (Berlin)
function sessionInfo(now, instr){
  var b = berlinParts(now), m = b.min, zone = (instr && instr.zone) || 'eu';
  if (b.wd === 'Sat' || (b.wd === 'Sun' && m < 23 * 60) || (b.wd === 'Fri' && m >= 23 * 60)) return { label: 'Wochenende', q: -2, text: 'Markt geschlossen' };
  var lon = m >= 8 * 60 && m < 11 * 60, ny = m >= 14 * 60 + 30 && m < 17 * 60, lunch = m >= 11 * 60 + 30 && m < 14 * 60;
  var label = m < 8 * 60 ? (m < 60 ? 'Nacht' : 'Asien') : (lon ? 'London-Eröffnung' : (ny ? 'New-York-Eröffnung' : (lunch ? 'Mittagspause' : (m >= 17 * 60 && m < 22 * 60 ? 'US-Nachmittag' : (m >= 22 * 60 ? 'Nacht' : 'Vormittag')))));
  var q = 0;
  if (zone === 'eu') q = lon || ny ? 1 : (lunch || m < 7 * 60 || m >= 22 * 60 ? -1 : 0);
  else if (zone === 'us') q = ny ? 1 : (lon ? 0 : (m < 8 * 60 || m >= 22 * 60 || lunch ? -1 : 0));
  else if (zone === 'usstock') q = m >= 15 * 60 + 30 && m < 17 * 60 + 30 ? 1 : (m < 15 * 60 + 30 || m >= 22 * 60 ? -1 : 0);
  else if (zone === 'asia') q = (m >= 1 * 60 && m < 4 * 60) || lon || ny ? 1 : (lunch ? -1 : 0);
  return { label: label, q: q, text: q > 0 ? 'Hauptzeit mit viel Bewegung und Liquidität' : (q < 0 ? 'Ruhige Zeit: Ausbrüche scheitern öfter, Spreads sind breiter' : 'Normale Handelszeit') };
}
// Wirtschaftskalender (Forex-Factory-Format): wichtige Termine fuer das Instrument
function newsFor(instr, events, now){
  var ccy = instr.ccy || [];
  var rel = (Array.isArray(events) ? events : []).filter(function(e){
    if (!e || !e.date) return false;
    if (instr.kw && instr.kw.test(e.title || '')) return true;
    return ccy.indexOf(e.country) >= 0 && (e.impact === 'High' || e.impact === 'Medium');
  }).map(function(e){ return { t: Date.parse(e.date), title: e.title, ccy: e.country, impact: e.impact, forecast: e.forecast, previous: e.previous }; })
    .filter(function(e){ return isFinite(e.t); }).sort(function(a, b){ return a.t - b.t; });
  var high = rel.filter(function(e){ return e.impact === 'High'; });
  var next = high.filter(function(e){ return e.t >= now - 5 * 60000; })[0] || null;
  var recent = high.filter(function(e){ return e.t < now && e.t >= now - 20 * 60000; }).pop() || null;
  var todayKey = berlinParts(now).key;
  return { next: next, recent: recent, today: rel.filter(function(e){ return berlinParts(e.t).key === todayKey; }), all: rel };
}
// COT-Index: Netto-Position der grossen Spekulanten im Vergleich zu den letzten 3 Jahren (0 = so short wie nie, 100 = so long wie nie)
function cotIndex(rows, sign){
  var r = (Array.isArray(rows) ? rows : []).map(function(x){
    return { d: x.report_date_as_yyyy_mm_dd, net: (+x.noncomm_positions_long_all) - (+x.noncomm_positions_short_all) };
  }).filter(function(x){ return isFinite(x.net) && x.d; }).sort(function(a, b){ return a.d < b.d ? 1 : -1; }).slice(0, 156);
  if (r.length < 26) return null;
  var nets = r.map(function(x){ return x.net * (sign || 1); });
  var mx = Math.max.apply(null, nets), mn = Math.min.apply(null, nets);
  var idx = mx > mn ? (nets[0] - mn) / (mx - mn) * 100 : 50;
  return { idx: idx, net: nets[0], chg: nets[0] - nets[1], date: r[0].d, weeks: r.length };
}
// Umrechnung: Wert von 1 Einheit Kurswaehrung in Euro
function eurPer(ccy, rates){
  if (ccy === 'EUR') return 1;
  if (!rates || !(rates.EURUSD > 0)) return null;
  if (ccy === 'USD') return 1 / rates.EURUSD;
  if (ccy === 'JPY') return rates.USDJPY > 0 ? 1 / (rates.EURUSD * rates.USDJPY) : null;
  if (ccy === 'GBP') return rates.GBPUSD > 0 ? rates.GBPUSD / rates.EURUSD : null;
  if (ccy === 'CAD') return rates.USDCAD > 0 ? 1 / (rates.EURUSD * rates.USDCAD) : null;
  if (ccy === 'CHF') return rates.USDCHF > 0 ? 1 / (rates.EURUSD * rates.USDCHF) : null;
  return null;
}
// Positionsgroesse: Risiko in Euro geteilt durch Verlust je Einheit bis zum Stop; optional Knock-out mit Bezugsverhaeltnis
function positionSize(p){
  var dist = Math.abs(p.entry - p.stop), conv = p.conv;
  if (!(dist > 0) || !(conv > 0) || !(p.account > 0) || !(p.riskPct > 0)) return null;
  var riskEur = p.account * p.riskPct, perUnit = dist * conv, units = riskEur / perUnit;
  var out = { riskEur: riskEur, units: units, perUnitEur: perUnit, valueEur: units * p.entry * conv };
  if (p.ratio > 0){ out.certs = Math.floor(units / p.ratio); out.certRiskEur = out.certs * p.ratio * perUnit; }
  if (p.type === 'fx') out.lots = units / 100000;
  return out;
}

// ---- Setup-Check
var CHECKS = {
  trend_d: 'Tagestrend', struct_h1: 'Struktur 1 Std', struct_m15: 'Struktur 15 Min', pd: 'Premium/Discount', liq: 'Liquidität',
  fvg: 'Fair Value Gap', atr: 'Stop gegen Schwankung', rr: 'Chance-Risiko', news: 'News', session: 'Handelszeit', cot: 'COT (Großspekulanten)', rs: 'Relative Stärke', vol: 'Tagesbewegung', price: 'Einstieg', corr: 'Gebündeltes Risiko'
};
var W = { pro: 1, contra: -1, warn: -0.5, neutral: 0 };
function fmtP(x, dec){ return x == null || !isFinite(x) ? '–' : x.toFixed(dec == null ? 2 : dec).replace('.', ','); }
function scoreCheck(p){
  var instr = p.instr, dir = p.dir, items = [], wm = p.wmul || {}, add = function(key, verdict, weight, text, block){ items.push({ key: key, title: CHECKS[key], verdict: verdict, weight: weight * (wm[key] != null ? wm[key] : 1), text: text, block: !!block }); };
  var dec = instr.dec;
  var price = p.m15 && p.m15.length ? p.m15[p.m15.length - 1].c : (p.h1 && p.h1.length ? p.h1[p.h1.length - 1].c : null);
  // Einstieg auf unsere Kursreihe abbilden (bei Rohstoffen liefert die Quelle den Future, Trade Republic den Kassakurs)
  var off = 0;
  if (price && instr.basis && Math.abs(p.entry - price) / price < 0.02) off = p.entry - price;
  var e = p.entry - off, s = p.stop - off, tg = p.target - off;
  var risk = (e - s) * dir, reward = (tg - e) * dir;
  if (!(risk > 0) || !(reward > 0)) return { error: dir > 0 ? 'Bei Long muss der Stop unter und das Ziel über dem Einstieg liegen.' : 'Bei Short muss der Stop über und das Ziel unter dem Einstieg liegen.' };
  var rr = reward / risk;
  if (price && Math.abs(e - price) / price > 0.03) add('price', 'warn', 0.5, 'Einstieg liegt ' + fmtP(Math.abs(e - price) / price * 100, 1) + ' % vom aktuellen Kurs ' + fmtP(price, dec) + ' entfernt. Die Prüfung gilt für den aktuellen Markt.');
  // 1) Tagestrend
  if (p.d1 && p.d1.length >= 60){
    var cl = p.d1.map(function(x){ return x.c; }), last = cl[cl.length - 1];
    var e50 = ema(cl, 50).pop(), e200 = cl.length >= 200 ? ema(cl, 200).pop() : null;
    var lb = Math.min(cl.length - 1, 252), mom = last / cl[cl.length - 1 - lb] - 1;
    var votes = [last > e50 ? 1 : -1, e200 ? (last > e200 ? 1 : -1) : 0, mom > 0 ? 1 : -1].reduce(function(a, x){ return a + x; }, 0);
    var al = votes * dir;
    var txt = 'Kurs ' + (last > e50 ? 'über' : 'unter') + ' EMA 50' + (e200 ? ', ' + (last > e200 ? 'über' : 'unter') + ' EMA 200' : '') + ', ' + (lb >= 250 ? '12' : Math.round(lb / 21)) + '-Monats-Momentum ' + (mom >= 0 ? '+' : '−') + fmtP(Math.abs(mom) * 100, 1) + ' %.';
    if (al >= 2) add('trend_d', 'pro', 2, 'Trade mit dem Tagestrend. ' + txt);
    else if (al <= -2) add('trend_d', 'contra', 2, 'Trade gegen den Tagestrend. ' + txt);
    else add('trend_d', 'neutral', 0, 'Tagestrend gemischt. ' + txt);
  }
  // 2) Struktur 1 Std / 15 Min (BOS/CHoCH)
  [['struct_h1', p.h1, 2, '1 Std'], ['struct_m15', p.m15, 1, '15 Min']].forEach(function(z){
    if (!z[1] || z[1].length < 30) return;
    var st = structure(z[1], 2);
    if (!st.last) return add(z[0], 'neutral', 0, 'Noch kein klarer Strukturbruch.');
    var ago = Math.round((p.now - st.last.t) / 3600000 * 10) / 10;
    var t = st.last.kind + ' ' + (st.last.dir > 0 ? 'nach oben' : 'nach unten') + ' bei ' + fmtP(st.last.level, dec) + ' (vor ' + fmtP(ago, ago < 10 ? 1 : 0) + ' Std).';
    if (st.last.dir === dir) add(z[0], 'pro', z[2], 'Struktur in deine Richtung: ' + t);
    else add(z[0], 'contra', z[2], 'Struktur gegen dich: ' + t);
  });
  // 3) Premium/Discount in der Range (heute, sonst Vortag)
  var lv = p.m15 && p.m15.length ? dayLevels(p.m15, p.now) : null;
  var rg = lv && lv.today && lv.prev ? { hi: Math.max(lv.today.hi, lv.prev.hi), lo: Math.min(lv.today.lo, lv.prev.lo) } : (lv && (lv.today || lv.prev));
  if (rg && rg.hi > rg.lo){
    var pos = (e - rg.lo) / (rg.hi - rg.lo), pd = dir > 0 ? pos : 1 - pos;
    var where = pos <= 0.5 ? 'Discount (untere Hälfte)' : 'Premium (obere Hälfte)';
    var t2 = 'Einstieg bei ' + fmtP(pos * 100, 0) + ' % der Range Vortag/heute (' + fmtP(rg.lo, dec) + '–' + fmtP(rg.hi, dec) + '): ' + where + '.';
    if (pd <= 0.5) add('pd', 'pro', 1, t2 + (dir > 0 ? ' Günstig kaufen.' : ' Teuer verkaufen.'));
    else if (pd >= 0.75) add('pd', 'contra', 1, t2 + (dir > 0 ? ' Du kaufst teuer.' : ' Du verkaufst billig.'));
    else add('pd', 'neutral', 0, t2);
  }
  // 4) Liquiditaet: Sweep eines Levels in deine Richtung, Ziel hinter einem Level
  if (lv){
    var lvls = [];
    if (lv.prev){ lvls.push({ n: 'Vortageshoch', p: lv.prev.hi, side: 1 }, { n: 'Vortagestief', p: lv.prev.lo, side: -1 }); }
    if (lv.asia){ lvls.push({ n: 'Asien-Hoch', p: lv.asia.hi, side: 1 }, { n: 'Asien-Tief', p: lv.asia.lo, side: -1 }); }
    var recent = p.m15.slice(-8), lastC = p.m15[p.m15.length - 1].c, sweep = null;
    lvls.forEach(function(L){
      if (dir > 0 && L.side < 0 && recent.some(function(x){ return x.l < L.p; }) && lastC > L.p) sweep = L;
      if (dir < 0 && L.side > 0 && recent.some(function(x){ return x.h > L.p; }) && lastC < L.p) sweep = L;
    });
    var block = lvls.filter(function(L){ return L.side === dir && (L.p - e) * dir > 0 && (tg - L.p) * dir > 0; }).sort(function(a, b){ return (a.p - b.p) * dir; })[0];
    if (sweep) add('liq', 'pro', 1, 'Liquidity Sweep: ' + sweep.n + ' (' + fmtP(sweep.p, dec) + ') wurde kurz unterschritten bzw. überschritten und zurückerobert.' + (block ? ' Achtung: Ziel liegt hinter dem ' + block.n + '.' : ''));
    else if (block) add('liq', 'warn', 0.5, 'Dein Ziel liegt hinter dem ' + block.n + ' (' + fmtP(block.p, dec) + '). Dort sitzen viele Orders, der Kurs dreht dort oft. Teilgewinn davor überlegen.');
    else add('liq', 'neutral', 0, 'Kein Sweep, freie Bahn bis zum Ziel.');
  }
  // 5) Fair Value Gap nahe am Einstieg in deine Richtung
  var a15 = p.m15 ? atr(p.m15, 14) : null;
  if (p.m15 && a15){
    var gaps = fvgs(p.m15, 60).filter(function(g){ return g.dir === dir && e >= g.lo - a15 && e <= g.hi + a15; });
    if (gaps.length) add('fvg', 'pro', 1, 'Offenes ' + (dir > 0 ? 'bullisches' : 'bärisches') + ' FVG auf 15 Min bei ' + fmtP(gaps[gaps.length - 1].lo, dec) + '–' + fmtP(gaps[gaps.length - 1].hi, dec) + ' nahe deinem Einstieg.');
    else add('fvg', 'neutral', 0, 'Kein offenes FVG in deiner Richtung nahe am Einstieg.');
  }
  // 6) Stop gegen ATR
  var a60 = p.h1 ? atr(p.h1, 14) : null;
  if (a15){
    var sd = risk, x15 = sd / a15, x60 = a60 ? sd / a60 : null;
    var t3 = 'Stop ' + fmtP(sd, dec) + ' = ' + fmtP(x15, 1) + '× ATR 15 Min' + (x60 ? ', ' + fmtP(x60, 1) + '× ATR 1 Std' : '') + '.';
    if (x15 < 1) add('atr', 'contra', 1, t3 + ' Sehr eng: Normales Rauschen kann dich ausstoppen.');
    else if (x60 && x60 > 3) add('atr', 'warn', 0.5, t3 + ' Weiter Stop: Positionsgröße entsprechend klein halten.');
    else add('atr', 'pro', 1, t3 + ' Passend zur aktuellen Schwankung.');
  }
  // 7) Chance-Risiko
  if (rr >= 2) add('rr', 'pro', 1, 'CRV ' + fmtP(rr, 1) + ' : 1.');
  else if (rr >= 1.5) add('rr', 'neutral', 0, 'CRV ' + fmtP(rr, 1) + ' : 1, unter deinem Ziel von 2 : 1.');
  else add('rr', 'contra', 2, 'CRV nur ' + fmtP(rr, 1) + ' : 1. Auf Dauer braucht das eine sehr hohe Trefferquote.', true);
  // 8) News
  var nw = p.events ? newsFor(instr, p.events, p.now) : null;
  if (nw){
    var nx = nw.next, mins = nx ? Math.round((nx.t - p.now) / 60000) : null;
    var nm = nx ? nx.ccy + ' ' + nx.title : '';
    if (nx && mins <= 30) add('news', 'contra', 3, (mins <= 0 ? 'Gerade jetzt: ' : 'In ' + mins + ' Min: ') + nm + '. Kurz vor wichtigen Daten springt der Kurs, Stops werden mit Schlupf ausgeführt.', true);
    else if (nx && mins <= 90) add('news', 'warn', 0.5, 'In ' + mins + ' Min: ' + nm + '. Plane, ob du vorher schließt oder den Stop nachziehst.');
    else if (nw.recent) add('news', 'warn', 0.5, 'Vor ' + Math.round((p.now - nw.recent.t) / 60000) + ' Min: ' + nw.recent.ccy + ' ' + nw.recent.title + '. Der Markt kann noch unruhig sein.');
    else add('news', 'pro', 1, 'Keine wichtigen Termine in den nächsten 90 Min' + (nx ? ' (nächster: ' + nm + ')' : '') + '.');
  }
  // 9) Handelszeit
  var ss = sessionInfo(p.now, instr);
  if (ss.q <= -2) add('session', 'neutral', 0, 'Wochenende, der Markt ist zu. Prüf das Setup zur Eröffnung noch einmal, die Kurse vom Freitag sind dann schon alt.');
  else add('session', ss.q > 0 ? 'pro' : (ss.q < 0 ? 'contra' : 'neutral'), ss.q ? 1 : 0, ss.label + ': ' + ss.text + '.');
  // 10) COT (woechentlich, Hintergrund)
  if (p.cot){
    var ci = p.cot.idx, side = dir > 0 ? ci : 100 - ci;
    var t4 = 'Großspekulanten-Index ' + fmtP(ci, 0) + ' von 100 (Stand ' + p.cot.date.slice(0, 10).split('-').reverse().join('.') + ').';
    if (side >= 90) add('cot', 'warn', 0.5, t4 + ' Die Masse liegt schon extrem in deiner Richtung: Umkehrgefahr.');
    else if (side <= 15) add('cot', 'pro', 1, t4 + ' Die Großspekulanten liegen extrem gegen deine Richtung: Solche Extreme gehen oft Wenden voraus.');
    else add('cot', 'neutral', 0, t4 + ' Keine extreme Positionierung.');
  }
  // 11) Relative Staerke (Aktien gegen Index, heute)
  if (instr.type === 'stock' && p.bench && p.bench.length && p.d1 && p.d1.length > 1){
    var chg = function(d){ return d[d.length - 1].c / d[d.length - 2].c - 1; };
    var diff = (chg(p.d1) - chg(p.bench)) * dir;
    var t5 = 'Heute ' + (chg(p.d1) >= 0 ? '+' : '−') + fmtP(Math.abs(chg(p.d1)) * 100, 1) + ' % gegen Index ' + (chg(p.bench) >= 0 ? '+' : '−') + fmtP(Math.abs(chg(p.bench)) * 100, 1) + ' %.';
    if (diff >= 0.005) add('rs', 'pro', 1, t5 + ' Relative Stärke in deine Richtung.');
    else if (diff <= -0.005) add('rs', 'contra', 1, t5 + ' Relative Schwäche gegen dich.');
    else add('rs', 'neutral', 0, t5);
  }
  // 12) Wie weit ist der Tag schon gelaufen (Tagesrange gegen durchschnittliche Range)
  if (p.d1 && p.d1.length > 21 && lv && lv.today){
    var adr = p.d1.slice(-21, -1).reduce(function(a, x){ return a + (x.h - x.l); }, 0) / 20;
    var used = (lv.today.hi - lv.today.lo) / adr;
    if (used >= 1.2) add('vol', 'warn', 0.5, 'Heute schon ' + fmtP(used * 100, 0) + ' % der üblichen Tagesbewegung gelaufen. Weite Ziele werden unwahrscheinlicher.');
    else add('vol', 'neutral', 0, 'Heute ' + fmtP(used * 100, 0) + ' % der üblichen Tagesbewegung.');
  }
  // 13) Gebuendeltes Risiko mit offenen Trades (gleiche Waehrung in gleiche Richtung)
  if (p.openTrades && p.openTrades.length){
    var same = overlap(exposure(instr, dir), p.openTrades);
    if (same.length) add('corr', 'warn', 0.5, 'Zusammen mit ' + same.map(function(x){ return x.name; }).join(', ') + ' setzt du doppelt auf ' + same.map(function(x){ return x.what; }).filter(function(v, i, a){ return a.indexOf(v) === i; }).join(' und ') + '. Geht es schief, verlierst du beide. Risiko je Trade halbieren überlegen.');
  }
  var score = items.reduce(function(a, it){ return a + (it.verdict === 'pro' ? it.weight : (it.verdict === 'contra' ? -it.weight : (it.verdict === 'warn' ? -0.5 : 0))); }, 0);
  var blocked = items.some(function(it){ return it.block; });
  var maxPro = items.reduce(function(a, it){ return a + (it.weight || 0) * (it.verdict === 'pro' || it.verdict === 'contra' ? 1 : 0); }, 0);
  var ampel = blocked ? 'rot' : (score >= 4 ? 'gruen' : (score >= 1.5 ? 'gelb' : 'rot'));
  // Gegen Tages- UND Stundentrend: hoechstens gelb (Umkehr-Trades brauchen mehr als ein gutes Einstiegsbild)
  var v = function(k){ var it = items.filter(function(i){ return i.key === k; })[0]; return it && it.verdict; };
  var against = v('trend_d') === 'contra' && v('struct_h1') === 'contra';
  if (against && ampel === 'gruen') ampel = 'gelb';
  return { items: items, against: against, score: score, ampel: ampel, rr: rr, risk: risk, price: price, offset: off, blocked: blocked, pros: items.filter(function(i){ return i.verdict === 'pro'; }).length, cons: items.filter(function(i){ return i.verdict === 'contra'; }).length, maxPro: maxPro };
}

// ---- Tagebuch-Auswertung (in R: Gewinn geteilt durch das Anfangsrisiko)
function tradeR(t){
  if (t.status !== 'closed' || !(t.exit > 0)) return null;
  var risk = Math.abs(t.entry - t.stop);
  return risk > 0 ? (t.exit - t.entry) * t.dir / risk : null;
}
function rStats(rs){
  var n = rs.length; if (!n) return null;
  var sum = rs.reduce(function(a, x){ return a + x; }, 0), mean = sum / n;
  var sd = n > 1 ? Math.sqrt(rs.reduce(function(a, x){ return a + (x - mean) * (x - mean); }, 0) / (n - 1)) : 0;
  var wins = rs.filter(function(x){ return x > 0; });
  return { n: n, sum: sum, mean: mean, sd: sd, lo: n > 1 ? mean - 1.96 * sd / Math.sqrt(n) : null, hi: n > 1 ? mean + 1.96 * sd / Math.sqrt(n) : null, win: wins.length / n,
    avgWin: wins.length ? wins.reduce(function(a, x){ return a + x; }, 0) / wins.length : 0,
    avgLoss: n - wins.length ? rs.filter(function(x){ return x <= 0; }).reduce(function(a, x){ return a + x; }, 0) / (n - wins.length) : 0 };
}
function analyzeTrades(trades){
  var closed = (trades || []).filter(function(t){ return tradeR(t) != null; }).sort(function(a, b){ return (a.closedAt || a.at) - (b.closedAt || b.at); });
  var rs = closed.map(tradeR), curve = [0], eq = 0, peak = 0, dd = 0;
  rs.forEach(function(r){ eq += r; curve.push(eq); if (eq > peak) peak = eq; if (peak - eq > dd) dd = peak - eq; });
  var group = function(keyFn){
    var g = {};
    closed.forEach(function(t, i){ [].concat(keyFn(t)).filter(Boolean).forEach(function(k){ (g[k] = g[k] || []).push(rs[i]); }); });
    return Object.keys(g).map(function(k){ return Object.assign({ key: k }, rStats(g[k])); }).sort(function(a, b){ return b.n - a.n; });
  };
  // Je Bestaetigung: Trades, bei denen sie dafuer sprach, gegen alle anderen
  var checks = Object.keys(CHECKS).map(function(k){
    var yes = [], no = [];
    closed.forEach(function(t, i){ var v = t.checks && t.checks[k]; if (!v) return; (v === 'pro' ? yes : no).push(rs[i]); });
    return { key: k, title: CHECKS[k], yes: rStats(yes), no: rStats(no) };
  }).filter(function(x){ return x.yes || x.no; });
  return { all: rStats(rs), curve: curve, maxDD: dd, bySetup: group(function(t){ return t.setups && t.setups.length ? t.setups : ['ohne Setup']; }),
    byAmpel: group(function(t){ return t.ampel || 'ohne Check'; }), byInstr: group(function(t){ return t.name || t.instr; }), checks: checks, open: (trades || []).filter(function(t){ return t.status === 'open'; }).length };
}
// ---- Fibonacci / Elliott-Helfer: A = Start der Bewegung, B = Ende, C = Ende der Korrektur (optional)
function fibPlan(a, b, c){
  a = +a; b = +b;
  if (!(a > 0) || !(b > 0) || a === b) return null;
  var leg = b - a, dir = leg > 0 ? 1 : -1;
  var retr = [0.382, 0.5, 0.618, 0.705, 0.786].map(function(f){ return { f: f, p: b - leg * f }; });
  var out = { dir: dir, leg: Math.abs(leg), retr: retr, ote: [b - leg * 0.62, b - leg * 0.79] };
  if (c != null && c !== '' && +c > 0){
    c = +c;
    var r = (b - c) / leg;
    out.c = c; out.retrC = r;
    out.ext = [1, 1.272, 1.618, 2.618].map(function(f){ return { f: f, p: c + leg * f }; });
    out.valid = r > 0 && r < 1;
    out.note = !out.valid ? (r >= 1 ? 'C liegt hinter A: Als Welle 2 ungültig (Welle 2 darf nie unter den Start von Welle 1).' : 'C liegt hinter B: Das ist keine Korrektur.')
      : (r >= 0.5 && r <= 0.79 ? 'Korrektur ' + fmtP(r * 100, 1) + ' %: typischer Bereich für Welle 2 bzw. B (50–78,6 %).' : (r < 0.382 ? 'Flache Korrektur ' + fmtP(r * 100, 1) + ' %: eher Welle 4 oder ein starker Trend.' : 'Korrektur ' + fmtP(r * 100, 1) + ' %.'));
  }
  return out;
}
// ---- Wichtige Kursmarken fuer die Leiter (zum Antippen als Einstieg, Stop oder Ziel)
function keyLevels(m15, h1, now, dec){
  var out = [], add = function(name, p, kind){ if (p > 0 && isFinite(p)) out.push({ name: name, p: p, kind: kind }); };
  if (m15 && m15.length){
    var lv = dayLevels(m15, now);
    if (lv.prev){ add('Vortageshoch', lv.prev.hi, 'liq'); add('Vortagestief', lv.prev.lo, 'liq'); }
    if (lv.asia){ add('Asien-Hoch', lv.asia.hi, 'liq'); add('Asien-Tief', lv.asia.lo, 'liq'); }
    if (lv.today){ add('Tageshoch', lv.today.hi, 'day'); add('Tagestief', lv.today.lo, 'day'); }
    fvgs(m15, 60).slice(-3).forEach(function(g){ add('FVG 15 Min ' + (g.dir > 0 ? 'bullisch' : 'bärisch'), (g.lo + g.hi) / 2, g.dir > 0 ? 'fvgU' : 'fvgD'); out[out.length - 1].lo = g.lo; out[out.length - 1].hi = g.hi; });
  }
  if (h1 && h1.length > 10){
    var st = structure(h1, 2), sw = st.swings;
    if (sw.hi.length) add('Swing-Hoch 1 Std', sw.hi[sw.hi.length - 1].p, 'swing');
    if (sw.lo.length) add('Swing-Tief 1 Std', sw.lo[sw.lo.length - 1].p, 'swing');
    fvgs(h1, 48).slice(-2).forEach(function(g){ add('FVG 1 Std ' + (g.dir > 0 ? 'bullisch' : 'bärisch'), (g.lo + g.hi) / 2, g.dir > 0 ? 'fvgU' : 'fvgD'); out[out.length - 1].lo = g.lo; out[out.length - 1].hi = g.hi; });
  }
  // doppelte Marken (gleicher Preis) zusammenfassen
  out.sort(function(a, b){ return b.p - a.p; });
  var tol = Math.pow(10, -(dec == null ? 5 : dec)) * 0.5, res = [];
  out.forEach(function(x){ var y = res[res.length - 1]; if (y && Math.abs(y.p - x.p) <= tol){ y.name += ' · ' + x.name; } else res.push(x); });
  return res;
}
// ---- Gebuendeltes Risiko: worauf setzt ein Trade? (+1 = steigt, -1 = faellt)
var EXPO_NAMES = { USD: 'den Dollar', EUR: 'den Euro', GBP: 'das Pfund', JPY: 'den Yen', RISK: 'steigende Aktien', XAU: 'Edelmetalle', OIL: 'Öl' };
function exposure(instr, dir){
  var e = {};
  if (!instr) return e;
  if (instr.type === 'fx'){ e[instr.ccy[0]] = dir; e[instr.ccy[1]] = -dir; }
  else if (instr.type === 'cmd'){ e[instr.k === 'WTI' ? 'OIL' : 'XAU'] = dir; e.USD = -dir; }
  else e.RISK = dir;
  return e;
}
function overlap(exp, open){
  var out = [];
  (open || []).forEach(function(t){
    var ex = exposure(instrumentByKey(t.instr), t.dir);
    Object.keys(exp).forEach(function(k){ if (ex[k] && ex[k] === exp[k]) out.push({ name: t.name || t.instr, what: (exp[k] > 0 ? 'steigende' : 'fallende') + ' ' + ({ USD: 'Dollar', EUR: 'Euro', GBP: 'Pfund', JPY: 'Yen', RISK: 'Aktien', XAU: 'Edelmetalle', OIL: 'Ölpreise' }[k] || k), key: k }); });
  });
  return out;
}

// ---- Schnelle Berlin-Zeit fuer viele Kerzen (Sommerzeit: letzter Sonntag Maerz bis letzter Sonntag Oktober, 01:00 UTC)
function lastSunUTC(y, m){ var d = new Date(Date.UTC(y, m + 1, 0, 1)); d.setUTCDate(d.getUTCDate() - d.getUTCDay()); return d.getTime(); }
var _dstCache = {};
function berlinFast(ms){
  var y = new Date(ms).getUTCFullYear(), c = _dstCache[y] || (_dstCache[y] = [lastSunUTC(y, 2), lastSunUTC(y, 9)]);
  var off = ms >= c[0] && ms < c[1] ? 2 : 1, d = new Date(ms + off * 3600e3);
  var key = d.getUTCFullYear() + '-' + ('0' + (d.getUTCMonth() + 1)).slice(-2) + '-' + ('0' + d.getUTCDate()).slice(-2);
  return { key: key, min: d.getUTCHours() * 60 + d.getUTCMinutes(), wd: d.getUTCDay() };
}
// Hauptzeiten je Markt (Minuten Berlin)
function killzones(instr){
  var z = (instr && instr.zone) || 'eu';
  if (z === 'usstock') return [[930, 1050]];
  if (instr && instr.type === 'stock') return [[540, 690], [870, 1020]];
  return [[480, 660], [870, 1020]];
}
// Tagestendenz aus Tageskerzen: Schluss ueber/unter EMA 50 (nur Tage vor dem Stichtag)
// Marktumfeld zum Handelstag (Schlusskurse des Vortags): VIX-Niveau und ob der Dollar-Index die Richtung stuetzt
function usdSign(instr){ if (!instr || instr.type === 'idx' || instr.type === 'stock') return 0; if (instr.ccy[0] === 'USD' && instr.ccy.length > 1) return 1; return instr.quote === 'USD' || (instr.ccy.length === 1 && instr.ccy[0] === 'USD') ? -1 : 0; }
function marketContext(dayKey, instr, dir, vix, dxy){
  var out = {}, last = function(d){ var v = null; if (!d) return v; for (var i = 0; i < d.length; i++){ if (berlinFast(d[i].t + 12 * 3600e3).key >= dayKey) break; v = d[i].c; } return v; };
  var v = last(vix); if (v != null){ out.vix = v; out.vixLo = v < 20; }
  var us = usdSign(instr);
  if (us && dxy){ var b = biasAt(dxy, dayKey); if (b) out.usdOk = b * us === dir; }
  return out;
}
function biasAt(d1, dayKey){
  if (!d1 || d1.length < 60) return 0;
  var cl = [], i;
  for (i = 0; i < d1.length; i++){ if (berlinFast(d1[i].t + 12 * 3600e3).key >= dayKey) break; cl.push(d1[i].c); }
  if (cl.length < 55) return 0;
  var e = ema(cl, 50); return cl[cl.length - 1] > e[e.length - 1] ? 1 : -1;
}
// Typische Kosten (Spread des Knock-outs) in Kurspunkten
function costOf(instr, px){
  var c = { EURUSD: 0.0001, GBPUSD: 0.00015, USDJPY: 0.015, XAUUSD: 0.5, XAGUSD: 0.03, WTI: 0.04, DAX: 3, NDX: 4, SPX: 1, DJI: 4, AUDUSD: 0.00012, USDCAD: 0.00015, USDCHF: 0.00015, NZDUSD: 0.00015, EURJPY: 0.02, GBPJPY: 0.03, EURGBP: 0.0001, BRENT: 0.04, COPPER: 0.002 }[instr.k];
  return c != null ? c : px * 0.0006;
}

// ---- Setup-Scanner: Liquidity Sweep (Asien/Vortag) in der Hauptzeit -> CHoCH auf 15 Min -> Einstieg im neuen FVG
// c = 15-Min-Kerzen, opt = { instr, d1, from (Index ab dem gesucht wird) }
function scanSetups(c, opt){
  opt = opt || {};
  var instr = opt.instr, kz = killzones(instr), out = [], n = c.length, bar = opt.bar || 15 * 60e3, win = Math.max(4, Math.round(3 * 3600e3 / bar));
  if (n < 40) return out;
  var bp = c.map(function(x){ return berlinFast(x.t); });
  // Tageswerte vorbereiten
  var days = {}, order = [];
  for (var i = 0; i < n; i++){
    var k = bp[i].key, d = days[k];
    if (!d){ d = days[k] = { hi: -Infinity, lo: Infinity, ahi: -Infinity, alo: Infinity, lhi: -Infinity, llo: Infinity, wd: bp[i].wd, first: i, wk: Math.floor((Date.UTC(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10)) / 864e5 + 3) / 7) }; order.push(k); }
    if (c[i].h > d.hi) d.hi = c[i].h; if (c[i].l < d.lo) d.lo = c[i].l;
    if (bp[i].min < 480){ if (c[i].h > d.ahi) d.ahi = c[i].h; if (c[i].l < d.alo) d.alo = c[i].l; }
    if (bp[i].min >= 480 && bp[i].min < 720){ if (c[i].h > d.lhi) d.lhi = c[i].h; if (c[i].l < d.llo) d.llo = c[i].l; }
  }
  var prevOf = {}, last = null, weeks = {};
  order.forEach(function(k){ prevOf[k] = last; if (days[k].wd !== 0 && days[k].wd !== 6) last = k; var w = weeks[days[k].wk] || (weeks[days[k].wk] = { hi: -Infinity, lo: Infinity }); w.hi = Math.max(w.hi, days[k].hi); w.lo = Math.min(w.lo, days[k].lo); });
  var biasCache = {};
  var a14 = [], trs = 0;
  for (i = 0; i < n; i++){ var tr = i ? Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c)) : c[i].h - c[i].l; trs = i < 14 ? trs + tr : trs; a14.push(i < 13 ? null : (i === 13 ? (trs) / 14 : (a14[i - 1] * 13 + tr) / 14)); }
  var inKz = function(m){ return kz.some(function(z){ return m >= z[0] && m < z[1]; }); };
  var swept = {}, pending = [];
  var from = Math.max(20, opt.from || 0);
  for (i = 20; i < n; i++){
    var b = bp[i], day = b.key, pk = prevOf[day], dd = days[day], pd = pk && days[pk];
    // offene Kandidaten weiterfuehren (CHoCH und FVG suchen)
    pending = pending.filter(function(s){
      if (i - s.i > win || bp[i].key !== s.day) return false;
      if (s.dir > 0 ? c[i].l < s.ext - (a14[i] || 0) * 0.05 && !s.broke : c[i].h > s.ext + (a14[i] || 0) * 0.05 && !s.broke){ s.ext = s.dir > 0 ? Math.min(s.ext, c[i].l) : Math.max(s.ext, c[i].h); if (Math.abs(c[i].c - s.level) > (a14[i] || 0) * 0.8 && (c[i].c - s.level) * s.dir < 0) return false; }
      if (!s.broke && (c[i].c - s.ref) * s.dir > 0){ s.broke = i; }
      if (s.broke){
        // FVG in Richtung zwischen Sweep und jetzt
        // groesstes FVG der Verdraengung (Mini-Luecken unter 0,3 ATR zaehlen nicht)
        var g = null, minG = (a14[i] || 0) * 0.3;
        for (var j = Math.max(s.i + 2, s.broke - 3); j <= i; j++){
          var cand = null;
          if (s.dir > 0 && c[j].l > c[j - 2].h) cand = { lo: c[j - 2].h, hi: c[j].l, j: j };
          if (s.dir < 0 && c[j].h < c[j - 2].l) cand = { lo: c[j].h, hi: c[j - 2].l, j: j };
          if (cand && cand.hi - cand.lo >= minG && (!g || cand.hi - cand.lo > g.hi - g.lo)) g = cand;
        }
        if (g){
          var a = a14[i] || (g.hi - g.lo);
          var entry = (g.lo + g.hi) / 2, stop = s.ext - s.dir * a * 0.1, risk = (entry - stop) * s.dir;
          if (risk > a * 0.3 && risk < a * 4 && i >= from){
            var cands = s.dir > 0 ? [dd.ahi, pd && pd.hi, s.dayHi] : [dd.alo, pd && pd.lo, s.dayLo];
            var tgt = null;
            cands.filter(function(x){ return x && isFinite(x); }).map(function(x){ return { p: x, rr: (x - entry) * s.dir / risk }; }).filter(function(x){ return x.rr >= 2 && x.rr <= 6; }).sort(function(x, y){ return x.rr - y.rr; }).slice(0, 1).forEach(function(x){ tgt = x; });
            var target = tgt ? tgt.p : entry + s.dir * risk * 2.5;
            if (!biasCache[day]) biasCache[day] = biasAt(opt.d1, day) || 'x';
            var bias = biasCache[day] === 'x' ? 0 : biasCache[day];
            out.push({ k: instr && instr.k, type: 'sweep', i: i, t: c[i].t + bar, day: day, dir: s.dir, entry: entry, stop: stop, target: target, rr: (target - entry) * s.dir / risk, risk: risk,
              sweep: s.name, level: s.level, liqTarget: !!tgt, bias: bias, withBias: bias === s.dir, fvg: [g.lo, g.hi], expires: c[i].t + bar + 3 * 3600e3,
              gapAtr: (g.hi - g.lo) / a, depthAtr: Math.abs(s.ext - s.level) / a, session: s.min < 720 ? 'London' : 'New York', prevDay: /Vortag/.test(s.name) });
          }
          return false;
        }
        return i - s.broke < 3;
      }
      return true;
    });
    if (!inKz(b.min) || b.wd === 0 || b.wd === 6) continue;
    var lv = [];
    if (dd && isFinite(dd.alo) && b.min >= 480){ lv.push({ n: 'Asien-Tief', p: dd.alo, dir: 1 }, { n: 'Asien-Hoch', p: dd.ahi, dir: -1 }); }
    if (pd){ lv.push({ n: 'Vortagestief', p: pd.lo, dir: 1 }, { n: 'Vortageshoch', p: pd.hi, dir: -1 }); }
    // in der New Yorker Zeit: Hoch/Tief der Londoner Sitzung; immer: Vorwochenhoch/-tief
    if (dd && b.min >= 870 && isFinite(dd.llo)){ lv.push({ n: 'London-Tief', p: dd.llo, dir: 1 }, { n: 'London-Hoch', p: dd.lhi, dir: -1 }); }
    var pw = weeks[dd.wk - 1];
    if (pw && isFinite(pw.lo)){ lv.push({ n: 'Vorwochentief', p: pw.lo, dir: 1 }, { n: 'Vorwochenhoch', p: pw.hi, dir: -1 }); }
    // Tageshoch/-tief bis vor dieser Kerze
    var dHi = -Infinity, dLo = Infinity;
    for (var q = dd.first; q < i; q++){ if (c[q].h > dHi) dHi = c[q].h; if (c[q].l < dLo) dLo = c[q].l; }
    lv.forEach(function(L){
      var key = day + L.n;
      if (swept[key]) return;
      var pierced = L.dir > 0 ? c[i].l < L.p : c[i].h > L.p;
      var back = L.dir > 0 ? c[i].c > L.p : c[i].c < L.p;
      var prevPierce = L.dir > 0 ? c[i - 1].c < L.p && c[i - 1].l < L.p : c[i - 1].c > L.p && c[i - 1].h > L.p;
      if (!(pierced && back) && !(prevPierce && back)) return;
      swept[key] = 1;
      var lo = Math.min(c[i].l, c[i - 1].l), hi = Math.max(c[i].h, c[i - 1].h);
      // Referenz fuer den Strukturbruch: Extrem der letzten Kerzen vor dem Sweep
      var ref = L.dir > 0 ? -Infinity : Infinity;
      for (var r = Math.max(0, i - 5); r < i; r++) ref = L.dir > 0 ? Math.max(ref, c[r].h) : Math.min(ref, c[r].l);
      pending.push({ min: b.min, i: i, day: day, dir: L.dir, name: L.n, level: L.p, ext: L.dir > 0 ? lo : hi, ref: ref, broke: 0, dayHi: dHi, dayLo: dLo });
    });
  }
  return out;
}
// ---- Setup 2: Trend-Pullback. In der Hauptzeit bricht der Kurs mit Verdraengung ein Swing-Hoch (Long) bzw. -Tief (Short)
// in Richtung Tagestrend (BOS). Einstieg per Limit im FVG der Verdraengung, Stop hinter dem letzten Gegen-Swing.
function scanPullbacks(c, opt){
  opt = opt || {};
  var instr = opt.instr, kz = killzones(instr), out = [], n = c.length, bar = opt.bar || 3600e3, from = Math.max(30, opt.from || 0);
  if (n < 60) return out;
  var bp = c.map(function(x){ return berlinFast(x.t); }), inKz = function(m){ return kz.some(function(z){ return m >= z[0] && m < z[1]; }); };
  var a14 = [], trs = 0;
  for (var i = 0; i < n; i++){ var tr = i ? Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c)) : c[i].h - c[i].l; trs = i < 14 ? trs + tr : trs; a14.push(i < 13 ? null : (i === 13 ? trs / 14 : (a14[i - 1] * 13 + tr) / 14)); }
  // Tageswerte fuer Ziele (Vortageshoch/-tief)
  var days = {}, order = [];
  for (i = 0; i < n; i++){ var k = bp[i].key, d = days[k]; if (!d){ d = days[k] = { hi: -Infinity, lo: Infinity, wd: bp[i].wd }; order.push(k); } if (c[i].h > d.hi) d.hi = c[i].h; if (c[i].l < d.lo) d.lo = c[i].l; }
  var prevOf = {}, last = null; order.forEach(function(k){ prevOf[k] = last; if (days[k].wd !== 0 && days[k].wd !== 6) last = k; });
  var sw = swings(c, 2), hiIdx = 0, loIdx = 0, refH = null, refL = null, biasCache = {}, used = {};
  var lastHi = function(j){ var r = null; for (var q = 0; q < sw.hi.length && sw.hi[q].i + 2 <= j; q++) r = sw.hi[q]; return r; };
  var lastLo = function(j){ var r = null; for (var q = 0; q < sw.lo.length && sw.lo[q].i + 2 <= j; q++) r = sw.lo[q]; return r; };
  for (i = 2; i < n; i++){
    while (hiIdx < sw.hi.length && sw.hi[hiIdx].i + 2 <= i){ refH = sw.hi[hiIdx]; hiIdx++; }
    while (loIdx < sw.lo.length && sw.lo[loIdx].i + 2 <= i){ refL = sw.lo[loIdx]; loIdx++; }
    var dir = 0;
    if (refH && c[i].c > refH.p && !used['h' + refH.i]){ dir = 1; used['h' + refH.i] = 1; }
    else if (refL && c[i].c < refL.p && !used['l' + refL.i]){ dir = -1; used['l' + refL.i] = 1; }
    if (!dir || i < from) continue;
    var b = bp[i]; if (!inKz(b.min) || b.wd === 0 || b.wd === 6) continue;
    var day = b.key;
    if (!biasCache[day]) biasCache[day] = biasAt(opt.d1, day) || 'x';
    var bias = biasCache[day] === 'x' ? 0 : biasCache[day];
    if (bias !== dir && !opt.any) continue;
    var a = a14[i]; if (!a) continue;
    var g = null;
    for (var j = Math.max(2, i - 2); j <= i; j++){
      var cand = null;
      if (dir > 0 && c[j].l > c[j - 2].h) cand = { lo: c[j - 2].h, hi: c[j].l };
      if (dir < 0 && c[j].h < c[j - 2].l) cand = { lo: c[j].h, hi: c[j - 2].l };
      if (cand && cand.hi - cand.lo >= a * 0.3 && (!g || cand.hi - cand.lo > g.hi - g.lo)) g = cand;
    }
    if (!g) continue;
    var opp = dir > 0 ? lastLo(i) : lastHi(i); if (!opp) continue;
    var entry = (g.lo + g.hi) / 2, stop = opp.p - dir * a * 0.1, risk = (entry - stop) * dir;
    if (!(risk > a * 0.3 && risk < a * 4)) continue;
    var pd = prevOf[day] && days[prevOf[day]], cands = [];
    if (pd) cands.push(dir > 0 ? pd.hi : pd.lo);
    for (var q = sw.hi.length - 1, m = 0; dir > 0 && q >= 0 && m < 6; q--) if (sw.hi[q].i + 2 <= i && sw.hi[q].i > i - 120){ cands.push(sw.hi[q].p); m++; }
    for (q = sw.lo.length - 1, m = 0; dir < 0 && q >= 0 && m < 6; q--) if (sw.lo[q].i + 2 <= i && sw.lo[q].i > i - 120){ cands.push(sw.lo[q].p); m++; }
    var tgt = cands.map(function(x){ return { p: x, rr: (x - entry) * dir / risk }; }).filter(function(x){ return x.rr >= 2 && x.rr <= 6; }).sort(function(x, y){ return x.rr - y.rr; })[0];
    var target = tgt ? tgt.p : entry + dir * risk * 2.5;
    out.push({ k: instr && instr.k, type: 'pullback', i: i, t: c[i].t + bar, day: day, dir: dir, entry: entry, stop: stop, target: target, rr: (target - entry) * dir / risk, risk: risk,
      sweep: 'Trend-Pullback', level: dir > 0 ? refH.p : refL.p, liqTarget: !!tgt, bias: bias, withBias: bias === dir, fvg: [g.lo, g.hi], expires: c[i].t + bar + 4 * 3600e3,
      gapAtr: (g.hi - g.lo) / a, depthAtr: 0, session: b.min < 720 ? 'London' : 'New York', prevDay: false });
  }
  return out;
}
// ================= Klassische Profi-Strategien (alle auf 1-Std-Kerzen, Ausstieg spaetestens zum Tagesende) =================
function atrSeries(c){ var a = [], trs = 0; for (var i = 0; i < c.length; i++){ var tr = i ? Math.max(c[i].h - c[i].l, Math.abs(c[i].h - c[i - 1].c), Math.abs(c[i].l - c[i - 1].c)) : c[i].h - c[i].l; trs = i < 14 ? trs + tr : trs; a.push(i < 13 ? null : (i === 13 ? trs / 14 : (a[i - 1] * 13 + tr) / 14)); } return a; }
function rsiSeries(c, n){ var out = [], g = 0, l = 0; for (var i = 0; i < c.length; i++){ if (!i){ out.push(null); continue; } var d = c[i].c - c[i - 1].c, up = Math.max(d, 0), dn = Math.max(-d, 0); if (i <= n){ g += up / n; l += dn / n; out.push(i < n ? null : (l === 0 ? 100 : 100 - 100 / (1 + g / l))); } else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; out.push(l === 0 ? 100 : 100 - 100 / (1 + g / l)); } } return out; }
function sessionMarket(instr){ return instr && (instr.type === 'stock' || instr.type === 'idx'); }
// Gemeinsame Vorbereitung: Berlin-Zeit, ATR, Tage, Tagestendenz
function prep(c, opt){
  var bp = c.map(function(x){ return berlinFast(x.t); }), a = atrSeries(c), days = {}, order = [];
  for (var i = 0; i < c.length; i++){ var k = bp[i].key, d = days[k]; if (!d){ d = days[k] = { first: i, last: i, hi: -Infinity, lo: Infinity, ahi: -Infinity, alo: Infinity, wd: bp[i].wd }; order.push(k); } d.last = i; if (c[i].h > d.hi) d.hi = c[i].h; if (c[i].l < d.lo) d.lo = c[i].l; if (bp[i].min < 480){ if (c[i].h > d.ahi) d.ahi = c[i].h; if (c[i].l < d.alo) d.alo = c[i].l; } }
  var prevOf = {}, last = null; order.forEach(function(k){ prevOf[k] = last; if (days[k].wd !== 0 && days[k].wd !== 6) last = k; });
  var bc = {}; var bias = function(day){ if (!bc[day]) bc[day] = biasAt(opt.d1, day) || 'x'; return bc[day] === 'x' ? 0 : bc[day]; };
  return { bp: bp, a: a, days: days, order: order, prevOf: prevOf, bias: bias, bar: opt.bar || 3600e3, from: Math.max(20, opt.from || 0) };
}
function endOfDay(P, c, i){ var d = P.days[P.bp[i].key]; return c[d.last].t + P.bar; }
function mk(P, instr, c, i, type, name, dir, mode, entry, stop, target, extra){
  var risk = (entry - stop) * dir; if (!(risk > 0)) return null;
  var day = P.bp[i].key, b = P.bias(day);
  return Object.assign({ k: instr && instr.k, type: type, i: i, t: c[i].t + P.bar, day: day, dir: dir, mode: mode, entry: entry, stop: stop, target: target, rr: (target - entry) * dir / risk, risk: risk,
    sweep: name, level: entry, liqTarget: false, bias: b, withBias: b === dir, fvg: null, expires: endOfDay(P, c, i), gapAtr: 0, depthAtr: 0, session: P.bp[i].min < 720 ? 'London' : 'New York', prevDay: false }, extra || {});
}
// 1) Opening Range Breakout (Toby Crabel): Spanne der ersten Handelsstunde, Kauf-/Verkaufsstopp knapp darueber/darunter,
//    Stop auf der anderen Seite der Spanne, Ziel 2R. Fuer Indizes und Aktien (Daten nur zur Boersenzeit).
function scanORB(c, opt){
  opt = opt || {}; var instr = opt.instr, out = []; if (!sessionMarket(instr) || c.length < 40) return out;
  var P = prep(c, opt);
  P.order.forEach(function(k){
    var d = P.days[k], i = d.first; if (i < P.from || d.wd === 0 || d.wd === 6 || i + 1 > d.last) return;
    var a = P.a[i]; if (!a) return;
    var hi = c[i].h, lo = c[i].l, rng = hi - lo, buf = a * 0.05;
    if (rng < a * 0.4 || rng > a * 3) return;
    [1, -1].forEach(function(dir){
      var e = dir > 0 ? hi + buf : lo - buf, st = dir > 0 ? lo - buf : hi + buf, r = Math.abs(e - st);
      var s = mk(P, instr, c, i, 'orb', 'Eröffnungsspanne', dir, 'stop', e, st, e + dir * r * 2, { oco: k }); if (s) out.push(s);
    });
  });
  return out;
}
// 2) London-Breakout: Asien-Spanne (0–8 Uhr), Stopp-Orders an Hoch und Tief ab 8 Uhr, Stop in der Mitte der Spanne, Ziel 2R, bis 12 Uhr.
function scanLBO(c, opt){
  opt = opt || {}; var instr = opt.instr, out = []; if (sessionMarket(instr) || c.length < 40) return out;
  var P = prep(c, opt);
  for (var i = P.from; i < c.length; i++){
    var b = P.bp[i]; if (b.min !== 480 || b.wd === 0 || b.wd === 6) continue;
    var d = P.days[b.key], a = P.a[i - 1]; if (!a || !isFinite(d.alo)) continue;
    var hi = d.ahi, lo = d.alo, rng = hi - lo, mid = (hi + lo) / 2;
    if (rng < a * 1 || rng > a * 6) continue;
    var j = i - 1; // Signal mit Schluss der letzten Asien-Kerze
    [1, -1].forEach(function(dir){
      var e = dir > 0 ? hi + a * 0.05 : lo - a * 0.05, r = Math.abs(e - mid);
      var s = mk(P, instr, c, j, 'lbo', 'Asien-Spanne', dir, 'stop', e, mid, e + dir * r * 2, { oco: b.key, expires: c[i].t + 4 * 3600e3 }); if (s) out.push(s);
    });
  }
  return out;
}
// 3) Donchian/Turtle-Ausbruch: Schluss ueber dem 20-Std-Hoch (bzw. unter dem Tief) in der Hauptzeit, Stop 2 ATR, Ziel 3 ATR.
function scanDonchian(c, opt){
  opt = opt || {}; var instr = opt.instr, out = [], kz = killzones(instr); if (c.length < 40) return out;
  var P = prep(c, opt), done = {};
  for (var i = Math.max(21, P.from); i < c.length; i++){
    var b = P.bp[i]; if (b.wd === 0 || b.wd === 6 || !kz.some(function(z){ return b.min >= z[0] && b.min < z[1]; })) continue;
    var a = P.a[i]; if (!a) continue;
    var hh = -Infinity, ll = Infinity; for (var q = i - 20; q < i; q++){ hh = Math.max(hh, c[q].h); ll = Math.min(ll, c[q].l); }
    var dir = c[i].c > hh ? 1 : (c[i].c < ll ? -1 : 0); if (!dir || done[b.key + dir]) continue; done[b.key + dir] = 1;
    var s = mk(P, instr, c, i, 'donch', '20-Std-Ausbruch', dir, 'market', c[i].c, c[i].c - dir * 2 * a, c[i].c + dir * 3 * a); if (s) out.push(s);
  }
  return out;
}
// 4) RSI-2 nach Larry Connors: im Tagestrend nach kurzem Ruecksetzer (RSI(2) unter 10 bzw. ueber 90) kaufen/verkaufen,
//    Ausstieg, sobald der Kurs ueber/unter dem 5er-Schnitt schliesst; Notstop 2 ATR.
function scanRSI2(c, opt){
  opt = opt || {}; var instr = opt.instr, out = [], kz = killzones(instr); if (c.length < 40) return out;
  var P = prep(c, opt), rs = rsiSeries(c, 2), done = {};
  for (var i = P.from; i < c.length; i++){
    var b = P.bp[i]; if (b.wd === 0 || b.wd === 6 || !kz.some(function(z){ return b.min >= z[0] && b.min < z[1]; })) continue;
    var a = P.a[i], r = rs[i]; if (!a || r == null) continue;
    var dir = r < 10 ? 1 : (r > 90 ? -1 : 0); if (!dir || done[b.key + dir]) continue;
    var bias = P.bias(b.key); if (bias !== dir && !opt.any) continue; done[b.key + dir] = 1;
    var s = mk(P, instr, c, i, 'rsi2', 'RSI-2-Rücksetzer', dir, 'market', c[i].c, c[i].c - dir * 2 * a, c[i].c + dir * 4 * a, { exit: 'sma5' }); if (s) out.push(s);
  }
  return out;
}
// 5) Gap-Fade: Indizes/Aktien eroeffnen mit Luecke zum Vortagesschluss; bleibt die Luecke in der ersten Stunde offen,
//    Handel Richtung Vortagesschluss (Ziel), Stop hinter dem Extrem der ersten Stunde.
function scanGap(c, opt){
  opt = opt || {}; var instr = opt.instr, out = []; if (!sessionMarket(instr) || c.length < 40) return out;
  var P = prep(c, opt);
  P.order.forEach(function(k){
    var d = P.days[k], i = d.first, pk = P.prevOf[k]; if (!pk || i < P.from || d.wd === 0 || d.wd === 6) return;
    var prevClose = c[P.days[pk].last].c, a = P.a[i - 1] || P.a[i]; if (!a) return;
    var gap = c[i].o - prevClose, dir = gap > 0 ? -1 : 1;
    if (Math.abs(gap) < a * 1 || Math.abs(gap) > a * 5) return;
    if ((c[i].c - prevClose) * -dir <= 0) return; // Luecke in der ersten Stunde schon zu
    var st = dir < 0 ? c[i].h + a * 0.1 : c[i].l - a * 0.1;
    var s = mk(P, instr, c, i, 'gap', 'Eröffnungslücke', dir, 'market', c[i].c, st, prevClose); if (s && s.rr >= 1) out.push(s);
  });
  return out;
}
// 6) NR7-Ausbruch: Der Vortag hatte die kleinste Spanne der letzten 7 Tage; Stopp-Orders an seinem Hoch und Tief,
//    Stop auf der anderen Seite, Ziel 2R.
function scanNR7(c, opt){
  opt = opt || {}; var instr = opt.instr, out = []; if (c.length < 40) return out;
  var P = prep(c, opt), td = P.order.filter(function(k){ var w = P.days[k].wd; return w !== 0 && w !== 6; });
  for (var x = 7; x < td.length; x++){
    var k = td[x], y = P.days[td[x - 1]], d = P.days[k], i = d.first; if (i < P.from) continue;
    var r = y.hi - y.lo, nr = true;
    for (var q = 2; q <= 7; q++){ var z = P.days[td[x - q]]; if (z.hi - z.lo <= r){ nr = false; break; } }
    if (!nr) continue;
    var a = P.a[i]; if (!a || r < a * 1) continue;
    var j = Math.max(0, i - 1);
    [1, -1].forEach(function(dir){
      var e = dir > 0 ? y.hi : y.lo, st = dir > 0 ? y.lo : y.hi;
      var s = mk(P, instr, c, j, 'nr7', 'NR7-Ausbruch', dir, 'stop', e, st, e + dir * r * 2, { oco: k, day: k, expires: c[d.last].t + P.bar }); if (s) out.push(s);
    });
  }
  return out;
}
var SETUPS = {
  sweep: { name: 'Liquidity Sweep', fn: function(c, o){ return scanSetups(c, o); } },
  pullback: { name: 'Trend-Pullback', fn: function(c, o){ return scanPullbacks(c, o); } },
  orb: { name: 'Opening Range Breakout', fn: scanORB },
  lbo: { name: 'London-Breakout', fn: scanLBO },
  donch: { name: 'Donchian-Ausbruch', fn: scanDonchian },
  rsi2: { name: 'RSI-2 (Connors)', fn: scanRSI2 },
  gap: { name: 'Gap-Fade', fn: scanGap },
  nr7: { name: 'NR7-Ausbruch', fn: scanNR7 }
};
function setupName(type){ return (SETUPS[type || 'sweep'] || {}).name || type; }
function scanAll(c, opt){ var out = []; Object.keys(SETUPS).forEach(function(k){ var o = Object.assign({}, opt, { any: true }); out = out.concat(SETUPS[k].fn(c, o).map(function(s){ s.type = s.type || 'sweep'; return s; })); }); return out; }
// ---- Qualitaetsstufen: feste Liste, die Auswahl trifft die Rueckrechnung (Jahr 1), geprueft wird auf Jahr 2
var GRADES = [
  { id: 'alle', name: 'Alle Signale', fn: function(s, a){ return true; } },
  { id: 'trend', name: 'Mit Tagestrend', fn: function(s){ return s.withBias; } },
  { id: 'trend_liq', name: 'Trend + Ziel an Liquidität', fn: function(s){ return s.withBias && s.liqTarget; } },
  { id: 'trend_liq_rr', name: 'Trend + Liquiditätsziel + CRV ab 2,5', fn: function(s){ return s.withBias && s.liqTarget && s.rr >= 2.5; } },
  { id: 'trend_disp', name: 'Trend + starke Verdrängung', fn: function(s){ return s.withBias && s.gapAtr >= 0.6; } },
  { id: 'trend_green', name: 'Trend + Ampel grün', fn: function(s, a){ return s.withBias && a === 'gruen'; } },
  { id: 'trend_liq_green', name: 'Trend + Liquiditätsziel + Ampel grün', fn: function(s, a){ return s.withBias && s.liqTarget && a === 'gruen'; } },
  { id: 'trend_pd', name: 'Trend + Vortages-Sweep', fn: function(s){ return s.withBias && s.prevDay; } },
  { id: 'trend_lon', name: 'Trend + London', fn: function(s){ return s.withBias && s.session === 'London'; } },
  { id: 'trend_ny', name: 'Trend + New York', fn: function(s){ return s.withBias && s.session === 'New York'; } },
  { id: 'aplus', name: 'Trend + Liquiditätsziel + Verdrängung + Ampel grün', fn: function(s, a){ return s.withBias && s.liqTarget && s.gapAtr >= 0.6 && a === 'gruen'; } },
  // Marktumfeld wie bei Banken: Volatilitaets-Regime (VIX) und Dollar-Richtung (Dollar-Index) als Bestaetigung
  { id: 'trend_vix', name: 'Trend + ruhiger Markt (VIX unter 20)', fn: function(s){ return s.withBias && s.vixLo === true; } },
  { id: 'trend_liq_vix', name: 'Trend + Liquiditätsziel + VIX unter 20', fn: function(s){ return s.withBias && s.liqTarget && s.vixLo === true; } },
  { id: 'trend_liq_rr_vix', name: 'Trend + Liquiditätsziel + CRV ab 2,5 + VIX unter 20', fn: function(s){ return s.withBias && s.liqTarget && s.rr >= 2.5 && s.vixLo === true; } },
  { id: 'trend_usd', name: 'Trend + Dollar-Index bestätigt', fn: function(s){ return s.withBias && s.usdOk === true; } },
  { id: 'trend_liq_usd', name: 'Trend + Liquiditätsziel + Dollar-Index bestätigt', fn: function(s){ return s.withBias && s.liqTarget && s.usdOk === true; } },
  { id: 'trend_liq_rr_usd', name: 'Trend + Liquiditätsziel + CRV ab 2,5 + Dollar-Index bestätigt', fn: function(s){ return s.withBias && s.liqTarget && s.rr >= 2.5 && s.usdOk === true; } },
  { id: 'trend_vixhi', name: 'Trend + unruhiger Markt (VIX ab 20)', fn: function(s){ return s.withBias && s.vixLo === false; } }
];
function gradeById(id){ return GRADES.filter(function(g){ return g.id === id; })[0] || null; }
// Stufe mit Setup-Typ, z. B. 'pullback:trend_liq' (ohne Typ: beide Setups)
function gradeMatch(id, sig, ampel){
  if (!id) return false;
  var p = String(id).split(':'), type = p.length > 1 ? p[0] : null, g = gradeById(p.length > 1 ? p[1] : p[0]);
  if (!g || (type && (sig.type || 'sweep') !== type)) return false;
  return !!g.fn(sig, ampel);
}
function gradeName(id){ var p = String(id || '').split(':'), g = gradeById(p.length > 1 ? p[1] : p[0]); return (p.length > 1 ? setupName(p[0]) + ': ' : '') + (g ? g.name : id); }
// Ein Signal auf den folgenden Kerzen durchspielen (konservativ: Stop und Ziel in derselben Kerze = Stop)
function simulate(sig, c, cost){
  var fill = -1, n = c.length, r = { filled: false, r: null, mae: 0, mfe: 0, how: 'offen' }, mode = sig.mode || 'limit';
  var start = sig.i + 1, entry = sig.entry, i;
  for (i = start; i < n && c[i].t < sig.expires; i++){
    if (mode === 'market'){ fill = i; entry = c[i].o; break; }
    if (mode === 'stop'){
      if (sig.dir > 0 ? c[i].h >= sig.entry : c[i].l <= sig.entry){ fill = i; entry = sig.dir > 0 ? Math.max(sig.entry, c[i].o) : Math.min(sig.entry, c[i].o); break; }
      continue;
    }
    if (sig.dir > 0 ? c[i].h >= sig.target : c[i].l <= sig.target){ r.how = 'verpasst'; return r; }
    if (sig.dir > 0 ? c[i].l <= sig.entry : c[i].h >= sig.entry){ fill = i; break; }
  }
  if (fill < 0){ if (i < n) r.how = 'nicht gefüllt'; return r; }
  var risk = (entry - sig.stop) * sig.dir;
  if (!(risk > 0)){ r.how = 'ungültig'; return r; }
  r.filled = true; r.fillT = c[fill].t; r.entry = entry;
  var day = berlinFast(c[fill].t).key, rr = (sig.target - entry) * sig.dir / risk, beOn = false;
  for (i = fill; i < n; i++){
    var x = c[i], bpx = berlinFast(x.t);
    var adv = ((sig.dir > 0 ? x.l : x.h) - entry) * sig.dir / risk, fav = ((sig.dir > 0 ? x.h : x.l) - entry) * sig.dir / risk;
    if (i === fill && mode === 'limit') fav = Math.max(0, ((x.c - entry) * sig.dir) / risk);
    if (adv < r.mae) r.mae = adv;
    // Stop auf Einstand, sobald 1R erreicht war (gilt ab der Kerze danach)
    if (beOn && adv <= 0){ r.r = 0; r.how = 'Einstand'; r.exitT = x.t; break; }
    if (adv <= -1){ r.r = -1; r.how = 'Stop'; r.exitT = x.t; break; }
    if (fav > r.mfe) r.mfe = fav;
    if (sig.be && fav >= 1 && !beOn && rr > 1) beOn = true;
    if ((i > fill || mode !== 'limit') && fav >= rr){ r.r = rr; r.how = 'Ziel'; r.exitT = x.t; break; }
    if (sig.exit === 'sma5' && i >= 4){
      var m5 = (c[i].c + c[i - 1].c + c[i - 2].c + c[i - 3].c + c[i - 4].c) / 5;
      if ((x.c - m5) * sig.dir > 0){ r.r = (x.c - entry) * sig.dir / risk; r.how = '5er-Schnitt'; r.exitT = x.t + 3600e3; break; }
    }
    if (bpx.key !== day || bpx.min >= 21 * 60 + 45){ r.r = ((i > fill ? x.o : x.c) - entry) * sig.dir / risk; r.how = 'Tagesende'; r.exitT = x.t; break; }
  }
  if (r.r == null){ r.filled = true; r.how = 'läuft'; return r; }
  r.mae = Math.max(r.mae, -1);
  r.r -= (cost || 0) * (mode === 'limit' ? 1 : 1.5) / risk;
  return r;
}
// Rueckrechnung fuer ein Instrument: Signale finden, durchspielen, Ampel zum Signalzeitpunkt bestimmen
function backtest(p){
  var bar = p.bar || 15 * 60e3, c = p.m15, res = [], o = { instr: p.instr, d1: p.d1, bar: bar, any: p.any };
  var sigs = p.setup === 'all' ? scanAll(c, o) : (SETUPS[p.setup || 'sweep'] || SETUPS.sweep).fn(c, o).map(function(s){ s.type = s.type || p.setup || 'sweep'; return s; });
  var cost = costOf(p.instr, c.length ? c[c.length - 1].c : 0), first = {};
  // OCO-Paare (Kauf- und Verkaufsstopp): nur die zuerst ausgeloeste Order zaehlt
  var sims = sigs.map(function(s){ var sim = simulate(s, c, cost); if (s.oco && sim.filled){ var k = s.type + s.oco; if (!first[k] || sim.fillT < first[k]) first[k] = sim.fillT; } return sim; });
  sigs.forEach(function(s, ix){
    var sim = sims[ix];
    if (!sim.filled || sim.r == null) return;
    if (s.oco && sim.fillT !== first[s.type + s.oco]) return;
    if (p.be){ var s2 = Object.assign({}, s, { be: true }), simBe = simulate(s2, c, cost); sim.rBe = simBe.r != null ? simBe.r : sim.r; }
    var t = s.t, m15 = c.slice(Math.max(0, s.i - 400), s.i + 1);
    var h1 = p.h1 ? (p.h1 === p.m15 ? c.slice(Math.max(0, s.i - 300), s.i + 1) : p.h1.filter(function(x){ return x.t + 3600e3 <= t; }).slice(-300)) : null;
    var d1 = p.d1 && !p.noCheck ? p.d1.filter(function(x){ return berlinFast(x.t + 12 * 3600e3).key < s.day; }) : null;
    var chk = p.noCheck ? { ampel: null, score: null, items: [] } : scoreCheck({ instr: p.instr, dir: s.dir, entry: s.entry, stop: s.stop, target: s.target, now: t, d1: d1, h1: h1, m15: m15, events: null, wmul: p.wmul });
    var checks = {}; (chk.items || []).forEach(function(it){ checks[it.key] = it.verdict; });
    res.push({ status: 'closed', instr: s.k, name: p.instr.name, dir: s.dir, entry: sim.entry || s.entry, stop: s.stop, target: s.target, exit: (sim.entry || s.entry) + s.dir * ((sim.entry || s.entry) - s.stop) * s.dir * sim.r,
      at: t, closedAt: sim.exitT, ampel: chk.ampel, score: chk.score, checks: checks, setups: [s.sweep, s.withBias ? 'mit Tagestrend' : 'gegen Tagestrend'], type: s.type, r: sim.r, rBe: sim.rBe, mae: sim.mae, mfe: sim.mfe, how: sim.how, sig: s });
  });
  return res;
}
// Gewichte aus Ergebnissen ableiten: hilft eine Bestaetigung (Ø R mit minus ohne), zaehlt sie mehr
function calibrate(trades, minN){
  minN = minN || 8;
  var a = analyzeTrades(trades), w = {}, info = [];
  a.checks.forEach(function(x){
    if (!x.yes || !x.no || x.yes.n < minN || x.no.n < minN) return;
    var d = x.yes.mean - x.no.mean, m = Math.max(0.25, Math.min(2, 1 + d));
    w[x.key] = Math.round(m * 100) / 100; info.push({ key: x.key, title: x.title, d: d, m: w[x.key], yes: x.yes.n, no: x.no.n });
  });
  return { wmul: w, info: info.sort(function(x, y){ return y.d - x.d; }), stats: a };
}
// Wie weit lief der Kurs waehrend eines Trades? (in R, aus 15-Min-Kerzen)
function excursion(t, c){
  var risk = Math.abs(t.entry - t.stop); if (!(risk > 0) || !c) return null;
  var off = t.off || 0, end = t.closedAt || Infinity, mae = 0, mfe = 0, any = false;
  c.forEach(function(x){
    if (x.t + 15 * 60e3 <= t.at || x.t > end) return;
    any = true;
    var adv = ((t.dir > 0 ? x.l : x.h) + off - t.entry) * t.dir / risk, fav = ((t.dir > 0 ? x.h : x.l) + off - t.entry) * t.dir / risk;
    if (adv < mae) mae = adv; if (fav > mfe) mfe = fav;
  });
  return any ? { mae: Math.max(mae, -1.5), mfe: mfe } : null;
}
// Hinweise aus MAE/MFE: Stops zu eng? Ziele zu kurz?
function excursionAdvice(trades){
  var t = trades.filter(function(x){ return x.mfe != null && tradeR(x) != null; });
  if (t.length < 8) return null;
  var losers = t.filter(function(x){ return tradeR(x) < 0; }), winners = t.filter(function(x){ return tradeR(x) > 0; });
  var med = function(a){ if (!a.length) return null; var s = a.slice().sort(function(x, y){ return x - y; }); return s[Math.floor(s.length / 2)]; };
  var out = { n: t.length, lossesWithProfit: losers.filter(function(x){ return x.mfe >= 1; }).length, losers: losers.length,
    winMaeMed: med(winners.map(function(x){ return x.mae; })), winMfeMed: med(winners.map(function(x){ return x.mfe; })), mfeMed: med(t.map(function(x){ return x.mfe; })), tips: [] };
  if (losers.length >= 3 && out.lossesWithProfit / losers.length >= 0.3) out.tips.push(out.lossesWithProfit + ' von ' + losers.length + ' Verlusttrades lagen vorher mindestens 1R im Plus. Ab 1R den Stop auf Einstand zu ziehen hätte sie gerettet.');
  if (out.winMaeMed != null && out.winMaeMed > -0.3) out.tips.push('Deine Gewinner liefen im Mittel nur ' + fmtP(-out.winMaeMed, 2) + 'R gegen dich. Dein Stop könnte enger sein, das vergrößert die Position bei gleichem Risiko.');
  if (out.winMfeMed != null && winners.length >= 4){
    var rrMed = med(winners.map(function(x){ return tradeR(x); }));
    if (out.winMfeMed > rrMed * 1.5) out.tips.push('Deine Gewinner liefen im Mittel bis ' + fmtP(out.winMfeMed, 1) + 'R, du nimmst ' + fmtP(rrMed, 1) + 'R mit. Ein Teil der Position mit weiterem Ziel lohnt sich.');
  }
  return out;
}
  return { marketContext, scanSetups, scanPullbacks, scanAll, setupName, scanUniverse, gradeMatch, gradeName, parseYahoo, instrumentByKey, biasAt, killzones, berlinFast, simulate, scoreCheck, gradeById, GRADES, INSTRUMENTS };
})();
const MKT_INTERVALS = ['5m', '15m', '30m', '60m', '1h', '1d', '1wk'];
const MKT_RANGES = ['1d', '5d', '1mo', '3mo', '6mo', '1y', '2y', '5y'];
const FF_URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const COT_URL = 'https://publicreporting.cftc.gov/resource/6dca-aqww.json';
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; TradeCheck/1.0)', Accept: 'application/json' };
const symOk = (s) => typeof s === 'string' && /^[A-Za-z0-9^=.\-]{1,20}$/.test(s);
async function yahooChart(sym, interval, range) {
  const u = 'https://query1.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(sym) + '?interval=' + interval + '&range=' + range + '&includePrePost=false';
  let r = await fetch(u, { headers: UA, cf: { cacheTtl: interval === '1d' || interval === '1wk' ? 900 : 60, cacheEverything: true } });
  if (r.status === 429 || r.status >= 500) r = await fetch(u.replace('query1.', 'query2.'), { headers: UA });
  return r;
}
async function cachedKV(env, key, maxAgeMs, nowMs, load) {
  const c = env.VS ? await env.VS.get(key, 'json') : null;
  if (c && nowMs - c.at < maxAgeMs) return { data: c.data, at: c.at, cached: true };
  try {
    const data = await load();
    if (env.VS) await env.VS.put(key, JSON.stringify({ at: nowMs, data }));
    return { data, at: nowMs, cached: false };
  } catch (e) {
    if (c) return { data: c.data, at: c.at, cached: true, stale: true };
    throw e;
  }
}
async function getCalendar(env, nowMs) {
  return cachedKV(env, 'mkt:cal', 30 * 60e3, nowMs, async () => {
    // Forex Factory sperrt geteilte Cloudflare-Adressen oft (429); dann die Kopie nehmen, die GitHub alle paar Stunden ablegt
    let j = null, why = '';
    try { const r = await fetch(FF_URL, { headers: UA }); if (r.ok) j = await r.json(); else why = 'FF ' + r.status; } catch (e) { why = 'FF ' + (e && e.message); }
    if (!Array.isArray(j) && env.PAGES_URL) {
      try { const r = await fetch(env.PAGES_URL + 'dienst/calendar.json?t=' + Math.floor(nowMs / 600e3), { headers: UA }); if (r.ok) j = await r.json(); else why += ', Kopie ' + r.status; } catch (e) { why += ', Kopie ' + (e && e.message); }
    }
    if (!Array.isArray(j)) throw new Error('Kalender ' + why);
    return j.filter((e) => e && (e.impact === 'High' || e.impact === 'Medium' || e.impact === 'Low')).slice(0, 400)
      .map((e) => ({ title: String(e.title || '').slice(0, 80), country: String(e.country || '').slice(0, 4), date: e.date, impact: e.impact, forecast: e.forecast || '', previous: e.previous || '' }));
  });
}
async function mkt(request, headers, env, nowMs) {
  if (request.method !== 'GET') return json(405, 'Method not allowed', headers);
  const url = new URL(request.url), q = url.searchParams;
  try {
    if (url.pathname === '/mkt/chart') {
      const sym = q.get('sym'), iv = q.get('interval') || '15m', rg = q.get('range') || '5d';
      if (!symOk(sym) || !MKT_INTERVALS.includes(iv) || !MKT_RANGES.includes(rg)) return json(400, 'Ungültige Abfrage', headers);
      const r = await yahooChart(sym, iv, rg);
      const out = new Headers(headers); out.set('Content-Type', 'application/json'); out.set('Cache-Control', 'no-store');
      return new Response(r.body, { status: r.status, headers: out });
    }
    if (url.pathname === '/mkt/search') {
      const term = (q.get('q') || '').slice(0, 40);
      if (!term.trim()) return json(400, 'Suchbegriff fehlt', headers);
      const r = await fetch('https://query1.finance.yahoo.com/v1/finance/search?q=' + encodeURIComponent(term) + '&quotesCount=8&newsCount=0&listsCount=0', { headers: UA });
      if (!r.ok) return json(r.status, 'Suche nicht erreichbar', headers);
      const j = await r.json();
      return jsonData({ quotes: (j.quotes || []).filter((x) => x.symbol && /EQUITY|ETF|INDEX|FUTURE|CURRENCY/.test(x.quoteType || '')).map((x) => ({ symbol: x.symbol, name: x.shortname || x.longname || x.symbol, type: x.quoteType, exch: x.exchDisp || x.exchange })) }, headers);
    }
    if (url.pathname === '/mkt/cal') {
      const c = await getCalendar(env, nowMs);
      return jsonData({ events: c.data, at: c.at, stale: !!c.stale }, headers);
    }
    if (url.pathname === '/mkt/cot') {
      const code = q.get('code') || '';
      if (!/^[0-9A-Z]{6}$/.test(code)) return json(400, 'Ungültiger Code', headers);
      const c = await cachedKV(env, 'mkt:cot:' + code, 12 * 3600e3, nowMs, async () => {
        const u = COT_URL + '?cftc_contract_market_code=' + code + '&$order=report_date_as_yyyy_mm_dd%20DESC&$limit=160&$select=report_date_as_yyyy_mm_dd,noncomm_positions_long_all,noncomm_positions_short_all,comm_positions_long_all,comm_positions_short_all,open_interest_all';
        const r = await fetch(u, { headers: UA });
        if (!r.ok) throw new Error('COT ' + r.status);
        const j = await r.json();
        if (!Array.isArray(j)) throw new Error('COT leer');
        return j;
      });
      return jsonData({ rows: c.data, at: c.at, stale: !!c.stale }, headers);
    }
  } catch (e) {
    return json(502, 'Datenquelle nicht erreichbar: ' + String(e && e.message || e).slice(0, 80), headers);
  }
  return json(404, 'Not found', headers);
}
// Eigener Besitzer-Schluessel fuer Trade Check (eigene App auf dem Home-Bildschirm, eigener Speicher)
async function checkTradeOwner(env, token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{32,64}$/.test(token)) return false;
  const h = await sha256hex(token), own = await env.VS.get('towner');
  if (!own) { await env.VS.put('towner', h); return true; }
  return own === h;
}
function normAlert(a, nowMs) {
  if (!a || typeof a !== 'object' || !symOk(a.sym)) return null;
  const lo = +a.lo, hi = +a.hi;
  if (!(lo > 0) || !(hi >= lo)) return null;
  return { id: String(a.id || '').slice(0, 24) || String(nowMs), sym: a.sym, name: String(a.name || a.sym).slice(0, 30), lo, hi, note: String(a.note || '').slice(0, 60), since: +a.since || nowMs, hit: +a.hit || 0, hitPx: +a.hitPx || 0 };
}
function normTrade(x) {
  if (!x || typeof x !== 'object' || typeof x.id !== 'string' || !TL.instrumentByKey(x.k)) return null;
  const n = (v) => +v;
  if (!(n(x.entry) > 0) || !(n(x.stop) > 0) || !(n(x.target) > 0) || (x.dir !== 1 && x.dir !== -1)) return null;
  return { id: x.id.slice(0, 24), k: x.k, name: String(x.name || x.k).slice(0, 30), dir: x.dir, entry: n(x.entry), stop: n(x.stop), target: n(x.target), off: +x.off || 0, at: +x.at || 0, ko: +x.ko > 0 ? +x.ko : 0, sig: typeof x.sig === 'string' ? x.sig.slice(0, 60) : null };
}
async function tradeRoute(request, headers, env, nowMs) {
  if (!env.VS) return json(500, 'KV-Speicher fehlt', headers);
  const path = new URL(request.url).pathname;
  if (path === '/trade/key' && request.method === 'GET') return jsonData({ key: (await vapidKeys(env)).pub }, headers);
  if (request.method !== 'POST') return json(405, 'Method not allowed', headers);
  let b;
  try { b = await readBody(request); } catch (e) { return json(400, 'Ungültige Anfrage', headers); }
  if (!b || typeof b !== 'object') return json(400, 'Ungültige Anfrage', headers);
  if (!(await checkTradeOwner(env, b.token))) return json(403, 'Trade Check ist schon mit einem anderen Gerät verbunden. Zum Zurücksetzen im KV-Speicher den Eintrag „towner“ löschen.', headers);
  const t = (await env.VS.get('trade', 'json')) || {};
  if (path === '/trade/sync') {
    if (b.sub != null && !validSub(b.sub)) return json(400, 'Ungültiges Push-Abo', headers);
    const old = {}; (t.alerts || []).forEach((a) => { old[a.id] = a; });
    const alerts = (Array.isArray(b.alerts) ? b.alerts : []).slice(0, 20).map((a) => normAlert(a, nowMs)).filter(Boolean)
      .map((a) => old[a.id] && old[a.id].hit && !a.hit ? Object.assign(a, { hit: old[a.id].hit, hitPx: old[a.id].hitPx }) : a);
    const next = { sub: b.off ? null : (b.sub || t.sub || null), on: b.on !== false,
      ccys: (Array.isArray(b.ccys) ? b.ccys : []).filter((c) => /^[A-Z]{3}$/.test(c)).slice(0, 10),
      kw: (Array.isArray(b.kw) ? b.kw : []).filter((k) => /^[a-z|]{2,40}$/.test(k)).slice(0, 5),
      lead: num(b.lead, 5, 60, 15), kz: b.kz !== false, alerts, sent: t.sent || {},
      watch: (Array.isArray(b.watch) ? b.watch : []).filter((k) => typeof k === 'string' && TL.instrumentByKey(k)).slice(0, 8),
      scan: b.scan !== false, scanAll: !!b.scanAll, quality: ['all', 'a', 'top', 'w60', 'triple'].includes(b.quality) ? b.quality : 'triple',
      trades: (Array.isArray(b.trades) ? b.trades : []).slice(0, 10).map(normTrade).filter(Boolean),
      tev: t.tev || {}, signals: t.signals || [], scanAt: t.scanAt || {}, bias: t.bias || {}, log: t.log || [], track: t.track || [], trackLog: t.trackLog || [] };
    // Ereignisse nur fuer noch offene Trades behalten
    const ids = new Set(next.trades.map((x) => x.id)); Object.keys(next.tev).forEach((id) => { if (!ids.has(id)) delete next.tev[id]; });
    await env.VS.put('trade', JSON.stringify(next));
    return jsonData({ ok: true, ver: WORKER_VER, active: validSub(next.sub), alerts: next.alerts, signals: next.signals, tev: next.tev, track: next.track, trackLog: next.trackLog.slice(-60), log: (t.log || []).slice(-10), now: nowMs }, headers);
  }
  if (path === '/trade/test') {
    if (!validSub(t.sub)) return json(409, 'Kein Push-Abo gespeichert. Schalte Benachrichtigungen in Trade Check ein.', headers);
    const r = await sendPush(env, t.sub, { title: 'Trade Check', body: 'Test: Benachrichtigungen funktionieren.', tag: 'ttest', url: './' }, nowMs, 600);
    if (r.status === 404 || r.status === 410) { t.sub = null; await env.VS.put('trade', JSON.stringify(t)); }
    return jsonData({ status: r.status, body: r.body }, headers);
  }
  if (path === '/trade/run') return jsonData(await runTrade(env, nowMs), headers);
  return json(404, 'Not found', headers);
}
function berlinClock(ms) {
  const f = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' });
  const p = {}; f.formatToParts(new Date(ms)).forEach((x) => { p[x.type] = x.value; });
  return { min: (+p.hour) * 60 + (+p.minute), wd: p.weekday };
}
const hhmm = (ms) => new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' }).format(new Date(ms));
// Belegte Qualitaetsstufe aus der grossen Rueckrechnung (GitHub legt sie woechentlich ab)
async function qualityCfg(env, nowMs) {
  try {
    const c = await cachedKV(env, 'mkt:q', 12 * 3600e3, nowMs, async () => {
      if (!env.PAGES_URL) return {};
      const r = await fetch(env.PAGES_URL + 'dienst/backtest-1h.json?t=' + Math.floor(nowMs / 3600e3), { headers: UA });
      if (!r.ok) return {};
      const j = await r.json();
      const stats = {}; (j.grades || []).forEach((g) => { stats[g.id] = g.all && g.all.n ? { n: g.all.n, mean: g.all.mean, win: g.all.win } : null; });
      const dossier = {}; Object.keys(j.dossier || {}).forEach((k) => { dossier[k] = { mgmt: j.dossier[k].mgmt }; });
      return { chosen: j.passed ? j.chosen : null, aIds: j.passed ? (j.aIds || []) : [], w60: j.w60 || [], triple: j.triple || [], stats, top: j.top || null, good: j.good || null, dossier };
    });
    return c.data || {};
  } catch (e) { return {}; }
}
async function runTrade(env, nowMs) {
  if (!env.VS) return { skipped: 'kv' };
  const t = await env.VS.get('trade', 'json');
  if (!t || !t.on || !validSub(t.sub)) return { skipped: 'nosub' };
  t.sent = t.sent || {}; t.log = Array.isArray(t.log) ? t.log : [];
  const rep = { pushed: 0, checked: 0 };
  let dirty = false, gone = false;
  const send = async (key, msg) => {
    if (t.sent[key] || gone) return false;
    const r = await sendPush(env, t.sub, Object.assign({ title: 'Trade Check', url: './' }, msg), nowMs, 1800);
    t.sent[key] = nowMs; dirty = true;
    t.log.push({ at: nowMs, t: (msg.body || '').slice(0, 260) }); t.log = t.log.slice(-15);
    if (r.status === 404 || r.status === 410) { t.sub = null; gone = true; }
    else rep.pushed++;
    return true;
  };
  const clk = berlinClock(nowMs), weekday = !['Sat', 'Sun'].includes(clk.wd);
  const dayKey = berlinDay(nowMs);
  // 1) Wichtige Termine kurz vorher
  let cal = null;
  const needCal = (t.ccys && t.ccys.length) || t.kz || (t.trades && t.trades.length);
  if (needCal) { try { cal = (await getCalendar(env, nowMs)).data; } catch (e) { cal = null; } }
  if (cal && t.ccys && t.ccys.length) {
    const lead = (t.lead || 15) * 60e3;
    const soon = cal.filter((e) => e.impact === 'High' && t.ccys.includes(e.country)).map((e) => Object.assign({}, e, { t: Date.parse(e.date) }))
      .filter((e) => isFinite(e.t) && e.t > nowMs && e.t - nowMs <= lead);
    const groups = {};
    soon.forEach((e) => { (groups[e.t] = groups[e.t] || []).push(e); });
    for (const ts of Object.keys(groups)) {
      const g = groups[ts], mins = Math.max(1, Math.round((+ts - nowMs) / 60e3));
      const names = g.map((e) => e.country + ' ' + e.title + (e.forecast ? ' (Prognose ' + e.forecast + ')' : '')).join(', ');
      await send('n:' + ts + ':' + g.map((e) => e.country).sort().join(''), { body: 'In ' + mins + ' Min (' + hhmm(+ts) + '): ' + names + '. Starke Ausschläge und breite Spreads möglich.', tag: 'news' });
    }
  }
  // 2) Start der Hauptzeiten (London 08:00, New York 14:30) mit den Terminen des Tages
  if (t.kz && weekday) {
    const zones = [{ k: 'lon', at: 8 * 60, name: 'London-Eröffnung' }, { k: 'ny', at: 14 * 60 + 30, name: 'New-York-Eröffnung' }];
    for (const z of zones) {
      if (clk.min >= z.at && clk.min < z.at + 10) {
        const next = (cal || []).filter((e) => e.impact === 'High' && (!t.ccys || !t.ccys.length || t.ccys.includes(e.country)))
          .map((e) => Object.assign({}, e, { t: Date.parse(e.date) })).filter((e) => e.t > nowMs && e.t - nowMs < 6 * 3600e3).slice(0, 3);
        const txt = next.length ? ' Heute wichtig: ' + next.map((e) => hhmm(e.t) + ' ' + e.country + ' ' + e.title).join(', ') + '.' : ' Keine wichtigen Termine in den nächsten Stunden.';
        await send('kz:' + dayKey + ':' + z.k, { body: z.name + ': Jetzt ist am meisten Bewegung im Markt.' + txt, tag: 'kz' });
      }
    }
  }
  // Kurse je Symbol nur einmal laden
  const cache = {};
  const candlesOf = async (sym, iv, rg) => {
    const key = sym + iv + rg;
    if (key in cache) return cache[key];
    cache[key] = null;
    try { const r = await yahooChart(sym, iv, rg); if (r.ok) cache[key] = TL.parseYahoo(await r.json()); } catch (e) { /* Quelle aus */ }
    return cache[key];
  };
  const fmtp = (x, k) => { const i = TL.instrumentByKey(k); return (+x).toFixed(i ? i.dec : 2).replace('.', ','); };
  // 3) Kurs-Alarme: Preis erreicht deine Zone
  const open = (t.alerts || []).filter((a) => !a.hit);
  const syms = [...new Set(open.map((a) => a.sym))].slice(0, 8);
  for (const sym of syms) {
    const candles = await candlesOf(sym, '5m', '1d');
    if (!candles || !candles.length) continue;
    rep.checked++;
    for (const a of open.filter((x) => x.sym === sym)) {
      const hit = candles.find((x) => x.t + 5 * 60e3 > a.since && x.l <= a.hi && x.h >= a.lo);
      if (hit) {
        const px = candles[candles.length - 1].c;
        a.hit = nowMs; a.hitPx = px; dirty = true;
        await send('a:' + a.id, { body: a.name + ' ist in deiner Zone ' + a.lo + '–' + a.hi + (a.note ? ' (' + a.note + ')' : '') + '. Aktuell ' + px + '. Jetzt Setup prüfen.', tag: 'alert-' + a.id });
      }
    }
  }
  // 4) Offene Trades betreuen: 1R erreicht, nahe am Stop, Stop/Ziel erreicht, News waehrend des Trades
  t.tev = t.tev || {};
  for (const tr of (t.trades || []).slice(0, 8)) {
    const ins = TL.instrumentByKey(tr.k); if (!ins) continue;
    const c = await candlesOf(ins.y, '5m', '5d');
    const ev = t.tev[tr.id] || (t.tev[tr.id] = {});
    const risk = Math.abs(tr.entry - tr.stop);
    if (c && c.length && risk > 0 && !ev.done) {
      let best = 0, worst = 0, doneHow = null, doneAt = 0, donePx = 0;
      for (const x of c) {
        if (x.t + 5 * 60e3 <= tr.at) continue;
        const adv = ((tr.dir > 0 ? x.l : x.h) + tr.off - tr.entry) * tr.dir / risk, fav = ((tr.dir > 0 ? x.h : x.l) + tr.off - tr.entry) * tr.dir / risk;
        if (adv <= -1) { doneHow = 'stop'; doneAt = x.t; donePx = tr.stop; break; }
        if (fav >= (tr.target - tr.entry) * tr.dir / risk) { doneHow = 'ziel'; doneAt = x.t; donePx = tr.target; break; }
        if (fav > best) best = fav; if (adv < worst) worst = adv;
      }
      const last = c[c.length - 1], nowR = ((last.c + tr.off) - tr.entry) * tr.dir / risk;
      const nm = tr.name + ' ' + (tr.dir > 0 ? 'Long' : 'Short');
      if (Math.abs(best) > Math.abs(ev.mfe || 0)) { ev.mfe = Math.round(best * 100) / 100; dirty = true; }
      if (worst < (ev.mae || 0)) { ev.mae = Math.round(worst * 100) / 100; dirty = true; }
      if (doneHow) {
        Object.assign(ev, { done: doneHow, doneAt, donePx }); dirty = true;
        await send('t:' + tr.id + ':' + doneHow, { body: nm + ': ' + (doneHow === 'ziel' ? 'Ziel ' + fmtp(tr.target, tr.k) + ' erreicht (+' + ((tr.target - tr.entry) * tr.dir / risk).toFixed(1).replace('.', ',') + 'R).' : 'Stop ' + fmtp(tr.stop, tr.k) + ' erreicht (−1R).') + ' Tippe, um es ins Tagebuch zu übernehmen.', tag: 'trade-' + tr.id });
      } else {
        if (best >= 1 && !ev.r1) { ev.r1 = nowMs; dirty = true; await send('t:' + tr.id + ':r1', { body: nm + ' ist 1R im Plus (' + fmtp(last.c + tr.off, tr.k) + '). Stop auf Einstand ' + fmtp(tr.entry, tr.k) + ' ziehen, dann kann der Trade nicht mehr verlieren.', tag: 'trade-' + tr.id }); }
        if (tr.ko > 0 && !ev.ko) {
          const gap = ((last.c + tr.off) - tr.ko) * tr.dir;
          if (gap <= risk * 0.5) { ev.ko = nowMs; dirty = true; await send('t:' + tr.id + ':ko', { body: nm + ': Der Kurs ist nur noch ' + fmtp(gap, tr.k) + ' von der KO-Schwelle ' + fmtp(tr.ko, tr.k) + ' entfernt. Bei Berührung ist der Schein wertlos.', tag: 'trade-' + tr.id }); }
        }
        if (nowR <= -0.75 && !ev.near) { ev.near = nowMs; dirty = true; await send('t:' + tr.id + ':near', { body: nm + ' steht kurz vor dem Stop (' + fmtp(last.c + tr.off, tr.k) + ', Stop ' + fmtp(tr.stop, tr.k) + '). Plan einhalten, Stop nicht verschieben.', tag: 'trade-' + tr.id }); }
      }
    }
    // News waehrend des Trades
    if (cal && !ev.done) {
      const lead = (t.lead || 15) * 60e3;
      const nx = cal.filter((e) => e.impact === 'High' && ins.ccy.includes(e.country)).map((e) => Object.assign({}, e, { t: Date.parse(e.date) })).find((e) => e.t > nowMs && e.t - nowMs <= lead);
      if (nx) await send('t:' + tr.id + ':n' + nx.t, { body: 'In ' + Math.max(1, Math.round((nx.t - nowMs) / 60e3)) + ' Min: ' + nx.country + ' ' + nx.title + '. Dein ' + tr.name + '-Trade ist offen: Teilgewinn nehmen oder Stop nachziehen?', tag: 'trade-' + tr.id });
    }
  }
  // 5) Setup-Scanner in den Hauptzeiten: Sweep -> CHoCH -> FVG auf 1-Std-Kerzen (in der Rueckrechnung ueber 2 Jahre deutlich besser als 15 Min)
  if (t.scan !== false && weekday) {
    t.scanAt = t.scanAt || {}; t.bias = t.bias || {}; t.signals = Array.isArray(t.signals) ? t.signals : [];
    const keys = [...new Set(TL.scanUniverse().map((i) => i.k).concat((t.watch || []).filter((k) => /^S:/.test(k))))];
    const due = keys.map((k) => TL.instrumentByKey(k)).filter((ins) => ins && TL.killzones(ins).some((z) => clk.min >= z[0] && clk.min < z[1] + 75) && nowMs - (t.scanAt[ins.k] || 0) >= 14 * 60e3)
      .sort((a, b) => (t.scanAt[a.k] || 0) - (t.scanAt[b.k] || 0)).slice(0, 6);
    for (const ins of due) {
      t.scanAt[ins.k] = nowMs; dirty = true; rep.scanned = (rep.scanned || 0) + 1;
      const d1 = await candlesOf(ins.y, '1d', '1y');
      if (d1 && d1.length && (!t.bias[ins.k] || t.bias[ins.k].day !== dayKey)) t.bias[ins.k] = { day: dayKey, b: TL.biasAt(d1, dayKey) };
      const bias = t.bias[ins.k] ? t.bias[ins.k].b : 0;
      const c = await candlesOf(ins.y, '60m', '1mo');
      if (!c || c.length < 60) continue;
      const sigs = TL.scanAll(c, { instr: ins, d1, bar: 3600e3, from: c.length - 3 }).filter((g) => g.day === dayKey && nowMs - g.t < 80 * 60e3 && g.t < nowMs + 60e3);
      for (const g of sigs) {
        const sim = TL.simulate(g, c, 0);
        if (sim.how === 'verpasst' || (sim.filled && sim.r != null)) continue;
        const id = ins.k + ':' + (g.type || 'sweep') + ':' + g.t;
        if (t.signals.some((x) => x.id === id)) continue;
        const ko = g.stop - g.dir * g.risk * 0.5;
        g.bias = bias; g.withBias = bias === g.dir;
        Object.assign(g, TL.marketContext(dayKey, ins, g.dir, await candlesOf('^VIX', '1d', '6mo'), await candlesOf('DX-Y.NYB', '1d', '1y')));
        const q = await qualityCfg(env, nowMs);
        const m15 = await candlesOf(ins.y, '15m', '5d');
        let calNow = null; try { calNow = (await getCalendar(env, nowMs)).data; } catch (e) { calNow = null; }
        let chk = null; try { chk = TL.scoreCheck({ instr: ins, dir: g.dir, entry: g.entry, stop: g.stop, target: g.target, now: nowMs, d1, h1: c, m15: m15 && m15.length ? m15 : null, events: calNow }); } catch (e) { chk = null; }
        const ampel = chk && !chk.error ? chk.ampel : null;
        const newsSoon = (calNow || []).some((e) => e.impact === 'High' && ins.ccy.includes(e.country) && Date.parse(e.date) > nowMs - 15 * 60e3 && Date.parse(e.date) - nowMs < 60 * 60e3);
        const aId = q.chosen || 'sweep:trend_liq_rr', bIds = q.chosen ? (q.aIds || []) : ['sweep:trend_liq'];
        const bHit = bIds.find((id) => TL.gradeMatch(id, g, ampel));
        const wHit = (q.w60 || []).find((id) => TL.gradeMatch(id, g, ampel));
        const tHit = (q.triple || []).find((id) => TL.gradeMatch(id, g, ampel));
        const cls = newsSoon ? 'B' : (TL.gradeMatch(aId, g, ampel) ? 'A+' : (bHit ? 'A' : 'B'));
        const sig = { id, type: g.type || 'sweep', mode: g.mode || 'limit', k: ins.k, name: ins.name, t: g.t, dir: g.dir, entry: g.entry, stop: g.stop, target: g.target, ko, rr: Math.round(g.rr * 10) / 10, sweep: g.sweep, level: g.level, withBias: g.withBias, liqTarget: g.liqTarget, bias, expires: g.expires, filled: sim.filled,
          ampel, score: chk && chk.score != null ? Math.round(chk.score * 10) / 10 : null, cls, top: cls === 'A+', newsSoon, w60: !newsSoon && !!wHit, wGrade: wHit || null, triple: !newsSoon && !!tHit, tGrade: tHit || null, vix: g.vix != null ? Math.round(g.vix * 10) / 10 : null, usdOk: g.usdOk };
        t.signals.unshift(sig); t.signals = t.signals.slice(0, 30); dirty = true;
        const want = t.quality === 'triple' ? sig.triple : t.quality === 'w60' ? sig.w60 : t.quality === 'all' ? ((sig.type === 'sweep' || sig.type === 'pullback') && (sig.withBias || t.scanAll)) : (t.quality === 'a' ? cls !== 'B' : cls === 'A+');
        if (want && (cls !== 'B' || sig.w60 || sig.triple)) {
          const gSel = t.quality === 'triple' ? tHit : (sig.w60 && t.quality === 'w60' ? wHit : (cls === 'A+' ? aId : bHit));
          const dz = q.dossier && q.dossier[gSel];
          t.track = Array.isArray(t.track) ? t.track : [];
          t.track.push({ id, k: ins.k, y: ins.y, name: ins.name, dir: g.dir, mode: g.mode || 'limit', entry: g.entry, stop: g.stop, target: g.target, ko, t: g.t, expires: g.expires, cls, grade: gSel,
            be: !!(dz && dz.mgmt === 'be'), state: 'wartet', at: nowMs });
          if (t.quality === 'w60') t.track[t.track.length - 1].cls = '60 %+';
          if (t.quality === 'triple') t.track[t.track.length - 1].cls = '3× geprüft';
          t.track = t.track.slice(-20);
        }
        if (want) {
          const gid = t.quality === 'triple' ? tHit : t.quality === 'w60' ? wHit : (cls === 'A+' ? aId : (cls === 'A' ? bHit : ''));
          const gs = q.stats && q.stats[gid];
          const proof = gs && gs.n ? ' Rückrechnung: ' + gs.n + ' Trades, ' + Math.round(gs.win * 100) + ' % Treffer, Ø ' + (gs.mean >= 0 ? '+' : '') + gs.mean.toFixed(2).replace('.', ',') + ' R.' : '';
          await send('s:' + id, { title: (t.quality === 'triple' ? 'Geprüftes Setup' : t.quality === 'w60' ? '60 %+ Setup' : (cls !== 'B' ? cls + ' Setup' : 'Setup')) + ' · ' + ins.name, body: ins.name + ' ' + (g.dir > 0 ? 'Long' : 'Short') + ': ' + (g.type === 'pullback' ? 'Trend-Pullback ins FVG nach Bruch auf 1 Std' : (g.type === 'sweep' || !g.type ? 'Sweep ' + g.sweep + ', Strukturbruch auf 1 Std' : TL.setupName(g.type))) + (sig.withBias ? ', mit Tagestrend' : ', gegen den Tagestrend') + '. ' + (g.mode === 'stop' ? (g.dir > 0 ? 'Kauf-Stopp ' : 'Verkaufs-Stopp ') : (g.mode === 'market' ? 'Einstieg jetzt ca. ' : 'Limit ')) + fmtp(g.entry, ins.k) + ' · Stop ' + fmtp(g.stop, ins.k) + ' · Ziel ' + fmtp(g.target, ins.k) + ' (CRV ' + sig.rr.toFixed(1).replace('.', ',') + '). Knock-out mit Schwelle ' + (g.dir > 0 ? 'unter ' : 'über ') + fmtp(ko, ins.k) + '. Gilt bis ' + hhmm(g.expires) + '.' + proof, tag: 'sig-' + ins.k, url: './?sig=' + encodeURIComponent(id) });
        }
      }
    }
    t.signals = t.signals.filter((x) => nowMs - x.t < 3 * 86400e3);
  }
  // 6) Gemeldete Signale verfolgen: ausgeloest, 1R, Ziel, Stop, Einstand, Tagesende, verfallen
  const live = (t.track || []).filter((x) => x.state === 'wartet' || x.state === 'offen');
  for (const x of live) {
    const c5 = await candlesOf(x.y, '5m', '5d');
    if (!c5 || !c5.length) continue;
    rep.tracked = (rep.tracked || 0) + 1;
    let i0 = -1; for (let i = 0; i < c5.length; i++) { if (c5[i].t < x.t) i0 = i; else break; }
    const sim = TL.simulate({ i: i0, dir: x.dir, mode: x.mode, entry: x.entry, stop: x.stop, target: x.target, expires: x.expires, be: x.be }, c5, 0);
    const mine = (t.trades || []).some((tr) => tr.sig === x.id); // eigener Tagebuch-Trade meldet sich schon selbst
    const nm = x.name + ' ' + (x.dir > 0 ? 'Long' : 'Short') + ' (' + x.cls + ')';
    const done = (state, txt) => { x.state = state; x.r = sim.r; x.exitAt = sim.exitT || nowMs; dirty = true; t.trackLog = (t.trackLog || []).concat([{ id: x.id, k: x.k, name: x.name, dir: x.dir, cls: x.cls, grade: x.grade, t: x.t, fillT: x.fillT || null, state, r: sim.r != null ? Math.round(sim.r * 100) / 100 : null }]).slice(-200); return txt; };
    if (sim.filled && x.state === 'wartet') { x.state = 'offen'; x.fillT = sim.fillT; dirty = true; if (!mine) await send('k:' + x.id + ':fill', { body: nm + ': Order ausgelöst bei ' + fmtp(sim.entry, x.k) + '. SL ' + fmtp(x.stop, x.k) + ' · TP ' + fmtp(x.target, x.k) + '. Ich melde mich bei TP oder SL.', tag: 'trk-' + x.id }); }
    if (sim.filled && sim.mfe >= 1 && !x.r1) { x.r1 = nowMs; dirty = true; if (!mine && (sim.r == null || sim.r > 0)) await send('k:' + x.id + ':r1', { body: nm + ' liegt 1R im Plus.' + (x.be ? ' Laut Rückrechnung lohnt es sich jetzt, den Stop auf Einstand ' + fmtp(sim.entry, x.k) + ' zu ziehen.' : ' Laut Rückrechnung ist es besser, den Stop stehen zu lassen.'), tag: 'trk-' + x.id }); }
    if (sim.filled && sim.r != null) {
      const how = sim.how === 'Ziel' ? 'ziel' : (sim.how === 'Stop' ? 'stop' : (sim.how === 'Einstand' ? 'einstand' : 'tagesende'));
      const txt = how === 'ziel' ? '✅ TP erreicht: ' + nm + ' bei ' + fmtp(x.target, x.k) + ' (+' + sim.r.toFixed(1).replace('.', ',') + 'R).'
        : how === 'stop' ? '❌ SL erreicht: ' + nm + ' bei ' + fmtp(x.stop, x.k) + ' (−1R).'
        : how === 'einstand' ? 'Einstand: ' + nm + ' wurde bei ' + fmtp(sim.entry, x.k) + ' ausgestoppt (0R).'
        : 'Tagesende: ' + nm + ' jetzt schließen, Stand ' + (sim.r >= 0 ? '+' : '') + sim.r.toFixed(1).replace('.', ',') + 'R.';
      done(how, txt);
      if (!mine) await send('k:' + x.id + ':done', { body: txt, tag: 'trk-' + x.id });
    } else if (!sim.filled && (sim.how === 'verpasst' || nowMs > x.expires)) {
      done(sim.how === 'verpasst' ? 'verpasst' : 'verfallen');
      if (!mine) await send('k:' + x.id + ':exp', { body: nm + ': ' + (sim.how === 'verpasst' ? 'Kurs lief ohne Ausführung zum Ziel. Order löschen.' : 'Order nicht ausgelöst und jetzt verfallen. Order löschen.'), tag: 'trk-' + x.id });
    }
  }
  if (t.track) t.track = t.track.filter((x) => x.state === 'wartet' || x.state === 'offen' || nowMs - (x.exitAt || x.at) < 86400e3);
  // Aufraeumen: alte Sendungen vergessen
  for (const k of Object.keys(t.sent)) if (nowMs - t.sent[k] > 3 * 86400e3) { delete t.sent[k]; dirty = true; }
  if (dirty) await env.VS.put('trade', JSON.stringify(t));
  return rep;
}

export default {
  async fetch(request, env) {
    const allowed = originOf(env);
    if (!/^https:\/\/[^/]+$/.test(allowed)) {
      return json(500, 'ALLOWED_ORIGIN fehlt oder ist ungueltig (Beispiel: https://deinname.github.io)', {});
    }
    const headers = cors(allowed);
    // Nur Anfragen aus deiner App (Browser setzen Origin bei diesen Abrufen immer)
    if ((request.headers.get('Origin') || '') !== allowed) return json(403, 'Origin not allowed', headers);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (new URL(request.url).pathname.startsWith('/push/')) return push(request, headers, env, Date.now());
    if (new URL(request.url).pathname.startsWith('/op/')) return opProxy(request, headers);
    if (new URL(request.url).pathname.startsWith('/mkt/')) return mkt(request, headers, env, Date.now());
    if (new URL(request.url).pathname.startsWith('/trade/')) return tradeRoute(request, headers, env, Date.now());
    return proxy(request, headers, env);
  },
  async scheduled(event, env, ctx) {
    const at = event && event.scheduledTime ? event.scheduledTime : Date.now();
    ctx.waitUntil(runCron(env, at));
    ctx.waitUntil(runTrade(env, at).catch(() => null));
  }
};
