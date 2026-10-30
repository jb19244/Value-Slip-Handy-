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

const WORKER_VER = 'f6bbc54d8e';
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
  return { normalizeFeed, applyOverride, selectionsFor, fairOddsFor, convertEvents, leagueByKey, marketsFor, oddsUrl, fmtLine, fmtHc, RULE, SMART_RESERVE,
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
  return { lead, prov, value: c.value !== false, calls: num(c.calls, 0, 50, 6), minEdge: num(c.minEdge, 0, 0.5, 0.02),
    devig: c.devig === 'prop' ? 'prop' : 'power', ah: c.ah !== false, windowH: num(c.windowH, 6, 72, 24) };
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
function prepMatches(raw, user, cfg) {
  const f = APP.normalizeFeed({ matches: raw });
  return (f ? f.matches : []).map((m) => {
    const p = cfg.prov[m.sport] || cfg.prov.fb;
    return Object.assign(APP.applyOverride(m, user.ov && user.ov[m.id]), { bookName: p.book, taxF: p.tf });
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

  // 2) Erinnerung vor Anpfiff (alle Spiele, die in diesem Durchlauf faellig werden, in einer Nachricht)
  const due = games.filter((g) => {
    const lead = cfg.lead[g.sport] || 0, ms = koOf(g) - nowMs;
    return lead > 0 && isFinite(ms) && ms <= lead * MIN && ms > 3 * MIN && !st.sent[g.id];
  });
  if (due.length) {
    await loadSnaps();
    const hasOv = (g) => !!(user.ov && user.ov[g.id]);
    const leagues = [...new Set(due.map((g) => g.lkey))].sort((a, b) =>
      (due.some((g) => g.lkey === b && hasOv(g)) - due.some((g) => g.lkey === a && hasOv(g))) ||
      (due.filter((g) => g.lkey === b).length - due.filter((g) => g.lkey === a).length));
    const fresh = {};
    for (const lkey of leagues) {
      const lg = APP.leagueByKey(lkey);
      if (!lg) continue;
      const appAt = Math.max(0, ...games.filter((g) => g.lkey === lkey && typeof g.oddsAt === 'number').map((g) => g.oddsAt));
      const snapAt = Math.max(0, ...snaps.filter((s) => s.lkey === lkey && s.full).map((s) => s.at));
      if (nowMs - Math.max(appAt, snapAt) < DATA_FRESH) continue;
      const snap = await fetchLeague(lkey, APP.marketsFor(lg.sport), nowMs, nowMs + cfg.windowH * 3600000, true, 'remind');
      if (snap) fresh[lkey] = snap;
    }
    // neueste Daten je Spiel: frischer Abruf, sonst juengster gespeicherter, sonst die Quoten aus der App
    const rawById = {};
    games.forEach((g) => { rawById[g.id] = g; });
    const dueLeagues = new Set(due.map((g) => g.lkey));
    snaps.filter((s) => s.full && dueLeagues.has(s.lkey)).sort((a, b) => a.at - b.at).forEach((s) => {
      const lg = APP.leagueByKey(s.lkey);
      if (!lg) return;
      APP.convertEvents(s.ev, lg, s.at).forEach((m) => { const old = rawById[m.id]; if (!old || !(old.oddsAt >= m.oddsAt)) rawById[m.id] = m; });
    });
    const ms = prepMatches(due.map((g) => rawById[g.id] || g), user, cfg);
    const vals = [];
    ms.forEach((m) => valueLegs(m, cfg).forEach((s) => vals.push({ m, s })));
    vals.sort((a, b) => b.s.ev - a.s.ev);
    const mins = Math.round((Math.min(...due.map(koOf)) - nowMs) / MIN);
    const sports = [...new Set(due.map((g) => g.sport))];
    const names = ms.slice(0, 3).map(shortGame).join(', ') + (ms.length > 3 ? ' (+' + (ms.length - 3) + ')' : '');
    let msg;
    if (cfg.value && vals.length) {
      const top = vals[0], prov = top.m.bookName;
      const lines = vals.slice(0, 3).map((v) => v.s.label + ' @ ' + f2(v.s.book) + ' (' + pctS(v.s.ev) + ')');
      const at = top.m.refAt || top.m.oddsAt;
      msg = { title: '💰 Value bei ' + prov + ': ' + vals.length + (vals.length === 1 ? ' Tipp' : ' Tipps'),
        body: lines.join('\n') + '\nMit deinen eingetragenen Quoten, Pinnacle ' + (at ? 'von ' + berlinHm(at) : '') + '. Prüf, ob ' + prov + ' sie noch bietet. Anpfiff in ' + mins + ' Min.',
        tag: 'value', url: './' };
    } else {
      const one = ms.length === 1 ? fairText(ms[0], cfg) : '';
      msg = { title: '⏱ Anpfiff in ' + mins + ' Min', body: names + '\n' + (sports.length === 1 ? WHY[sports[0]] : 'Aufstellungen sind raus, bet365 und Betano ziehen oft erst später nach.') + ' Jetzt Quoten prüfen.' + (one ? '\n' + one : ''), tag: 'kickoff', url: './' };
    }
    const r = await sendPush(env, user.sub, msg, nowMs, Math.max(60, mins * 60));
    due.forEach((g) => { st.sent[g.id] = nowMs; });
    dirtyState = true;
    if (r.status === 404 || r.status === 410) { user.sub = null; dirtyUser = true; logAdd('Abo abgelaufen: Push in der App neu einschalten'); }
    else if (r.status >= 200 && r.status < 300) { report.pushed++; logAdd(msg.title); }
    else logAdd('Push abgelehnt (' + r.status + '): ' + r.body);
  }

  // 3) Aufraeumen
  const old = nowMs - 2 * 86400000;
  for (const k of Object.keys(st.sent)) if (st.sent[k] < old) { delete st.sent[k]; dirtyState = true; }
  for (const k of Object.keys(st.closeDone)) if (st.closeDone[k] < old) { delete st.closeDone[k]; dirtyState = true; }
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
      quota: b.quota && typeof b.quota.remaining === 'number' ? { remaining: b.quota.remaining, used: b.quota.used, at: +b.quota.at || 0 } : (user.quota || null)
    };
    if (JSON.stringify(next) !== JSON.stringify(user)) await env.VS.put('user', JSON.stringify(next));
    const st = (await env.VS.get('state', 'json')) || {};
    const snaps = (await env.VS.get('snaps', 'json')) || [];
    const since = +b.since || 0;
    return jsonData({ ok: true, ver: WORKER_VER, active: validSub(next.sub), snaps: snaps.filter((s) => s.at > since), quota: st.quota || null, log: (st.log || []).slice(-10), spent: st.spent || null, now: nowMs }, headers);
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
    return proxy(request, headers, env);
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runCron(env, event && event.scheduledTime ? event.scheduledTime : Date.now()));
  }
};
