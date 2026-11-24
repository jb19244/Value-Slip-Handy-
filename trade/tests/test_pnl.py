import sys
from playwright.sync_api import sync_playwright
html = open(sys.argv[1] if len(sys.argv) > 1 else 'index.html').read()
P = F = 0
def ok(c, m):
    global P, F
    if c: P += 1
    else: F += 1; print('FAIL:', m)
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={'width': 390, 'height': 900})
    errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.route('**/*', lambda r: r.fulfill(body=html, content_type='text/html') if r.request.url.endswith('/trade/') else r.fulfill(status=404, body=''))
    pg.goto('http://app.test/trade/'); pg.wait_for_timeout(700)
    if pg.locator('[data-oa=skip]').count(): pg.click('[data-oa=skip]')
    now = 'Date.now()'
    base = "() => { S.onb = 1; S.cfg.account = 5000; S.cfg.risk = 1; S.cfg.fee = 1; V.rates = { EURUSD: 1.08, USDJPY: 150, GBPUSD: 1.27 }; S.trades = []; S.imp = []; S.trf = []; S.trBooked = {}; S.real = {}; S.fold = {}; window.syncTrade = function(){}; "
    # 1) Schaetzung getrennt vom echten Geld
    pg.evaluate(base + "var t = Date.now(); V.trackLog = [{ id: 's1', t: t - 3*864e5, x: t - 2*864e5, name: 'Dow Jones', k: 'DJI', y: '^DJI', cls: 'IBS', dir: 1, r: -1, e: 48900, sp: 0.01 }, { id: 's2', t: t - 2*864e5, x: t - 864e5, name: 'Nasdaq 100', k: 'NDX', y: '^NDX', cls: 'IBS', dir: 1, r: 0.5, e: 25600, sp: 0.01 }];"
                " S.real = { s1: { traded: true, eur: null }, s2: { traded: true, prod: 'ko', buy: 5.81, sell: 0, qty: 10, fee: 1, eur: -59.1 } }; S.tab = 'buch'; rerender(); }")
    pg.wait_for_timeout(300); t1 = pg.inner_text('section.real')
    ok('−59 €' in t1 and 'geschätzt −52 €' in t1, 'Gesamt nur echt (−59 €), Schätzung (−52 €) getrennt: ' + t1[:400].replace('\n', ' | '))
    # 2) execCost: beide Schreibweisen und Dollar
    r = pg.evaluate("() => { var x = { k: 'DJI', y: '^DJI', dir: 1, e: 48900, xp: 48500 }; var a = execCost(x, { prod: 'ko', buy: 10.5, sell: 6.8, qty: 10, ratio: 0.01, ko: 47775, fee: 1 }); var b = execCost(x, { prod: 'ko', buy: 10.5, sell: 6.8, qty: 10, ratio: 100, ko: 47775, fee: 1 }); return [a.plan, b.plan, a.entry, a.act]; }")
    ok(abs(r[0] - (-400 * 0.01 / 1.08 * 10)) < 0.01 and abs(r[0] - r[1]) < 1e-9 and abs(r[2] - (10.5 - 1125 * 0.01 / 1.08) * 10) < 0.01 and abs(r[3] - (-39)) < 1e-9, 'Kostenrechnung KO, 0,01 = 100, Dollar umgerechnet: ' + str(r))
    r = pg.evaluate("() => { var x = { k: 'DAX', y: '^GDAXI', dir: 1, e: 25000, xp: 25200 }; return execCost(x, { prod: 'ko', buy: 6.1, sell: 8.0, qty: 10, ratio: 0.01, ko: 24400, fee: 1 }).plan; }")
    ok(abs(r - 20) < 1e-9, 'DAX in Euro: Plan +20 € ' + str(r))
    r = pg.evaluate("() => { var x = { k: 'DJI', y: '^DJI', dir: 1, e: 48900, xp: 47700 }; var c = execCost(x, { prod: 'ko', buy: 10.5, sell: 0, qty: 10, ratio: 0.01, ko: 47775, fee: 1 }); return [c.act, c.fee, c.plan]; }")
    ok(abs(r[0] - (-106)) < 1e-9 and r[1] == 1, 'ausgeknockt: −105 € Einsatz −1 € Gebühr ' + str(r))
    # 3) Eingabe "Ausgeknockt" im Formular
    pg.evaluate("() => { S.real = {}; rerender(); }"); pg.wait_for_timeout(200)
    pg.evaluate("() => { var b = document.querySelector('[data-act=realyes][data-id=s1]'); b.click(); }"); pg.wait_for_timeout(200)
    pg.fill('#realbuy', '5,81'); pg.fill('#realqty', '10'); pg.click('[data-act=realknock]'); pg.click('[data-act=realsave]'); pg.wait_for_timeout(200)
    m = pg.evaluate("() => S.real.s1")
    ok(m and m.get('eur') == -59.1 and m.get('sell') == 0, 'Formular ausgeknockt: −59,10 € ' + str(m))
    # 4) PDF: Kauf ohne Verkauf -> Ausgeknockt buchen
    pg.evaluate("() => { S.real = {}; V.trackLog = []; S.trf = [{ side: 'buy', type: 'Market-Order', at: Date.now() - 4*864e5, isin: 'DE000TEST0001', name: 'Long 25.115,81 PKT', qty: 10, price: 5.81, amount: 58.1, fee: 1, tax: 0, total: 59.1, gross: null, dir: 1, ko: 25115.81, prod: 'ko', exec: 'aaaa-1111' }]; rerender(); }"); pg.wait_for_timeout(200)
    ok(pg.locator('[data-act=trko]').count() == 1 and 'Knock-outs ohne Verkauf' in pg.inner_text('section.real'), 'offener KO aus PDF mit Knopf')
    pg.click('[data-act=trko]'); pg.wait_for_timeout(300)
    st = pg.inner_text('.sheet') if pg.locator('.sheet').count() else pg.inner_text('body')
    ok('−59,10 €' in st, 'Zuordnung zeigt −59,10 € ' + st[:200].replace('\n', ' | '))
    pg.click('[data-act=trsave]'); pg.wait_for_timeout(300)
    t4 = pg.inner_text('section.real')
    ok('−59 €' in t4 and pg.locator('[data-act=trko]').count() == 0, 'nach Buchung im Gesamt, Knopf weg: ' + t4[:200].replace('\n', ' | '))
    # 5) normaler PDF-Verkauf unveraendert
    r = pg.evaluate("() => pairTrFills([{ side: 'buy', at: 1, isin: 'X', name: 'Long', qty: 20, price: 2.23, fee: 1, prod: 'ko', dir: 1, exec: 'b' }, { side: 'sell', at: 2, isin: 'X', name: 'Long', qty: 20, price: 2.33, fee: 1, prod: 'ko', dir: 1, exec: 's', gross: 0 }])[0].eur")
    ok(abs(r - 0) < 1e-9, 'Kauf 2,23 / Verkauf 2,33 x 20 − 2 € = 0,00 €: ' + str(r))
    ok(not errs, 'keine JS-Fehler: ' + str(errs[:3]))
    b.close()
print('pnl: %d ok, %d fehlgeschlagen' % (P, F)); sys.exit(1 if F else 0)
