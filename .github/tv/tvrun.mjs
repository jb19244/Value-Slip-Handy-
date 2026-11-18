// Laedt ein Pine-Skript als Gast in einen echten TradingView-Chart und fotografiert das Ergebnis samt Fehlermeldungen.
import { chromium } from 'playwright';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
const [file, symbol, interval, tag] = process.argv.slice(2);
const code = readFileSync(file, 'utf8');
mkdirSync('out', { recursive: true });
const log = [];
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'en-US', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36' });
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'https://www.tradingview.com' });
const pg = await ctx.newPage();
pg.on('console', (m) => { if (/error|pine|script/i.test(m.text())) log.push('console: ' + m.text().slice(0, 300)); });
const shot = async (n) => { try { await pg.screenshot({ path: `out/${tag}_${n}.png` }); } catch (e) {} };
try {
  await pg.goto(`https://www.tradingview.com/chart/?symbol=${encodeURIComponent(symbol)}&interval=${interval}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.waitForTimeout(12000); await pg.keyboard.press('Escape'); await pg.waitForTimeout(1000);
  await shot('1_chart');
  // Pine-Editor oeffnen
  const cands = ['[data-name="pine-dialog-button"]', 'button[aria-label="Pine"]', 'button[aria-label*="Pine Editor"]', '[data-name="scripteditor"]', 'text=Pine Editor', '[data-tooltip*="Pine"]'];
  let opened = false;
  for (const c of cands) { const l = pg.locator(c).first(); if (await l.count()) { try { await l.click({ timeout: 3000 }); opened = true; log.push('opened via ' + c); break; } catch (e) {} } }
  await pg.waitForTimeout(5000); await shot('2_editor');
  log.push('editor opened: ' + opened + ', monaco: ' + await pg.locator('.monaco-editor').count());
  const ed = pg.locator('.monaco-editor .view-lines').first();
  await ed.click({ timeout: 10000 });
  await pg.keyboard.press('Control+A'); await pg.keyboard.press('Delete');
  await pg.evaluate((t) => navigator.clipboard.writeText(t), code);
  await pg.keyboard.press('Control+V'); await pg.waitForTimeout(2000);
  await shot('3_pasted');
  const add = ['button:has-text("Add to chart")', '[title*="Add to chart"]', '[data-name="add-script-to-chart"]', 'button:has-text("Update on chart")'];
  let added = false;
  for (const c of add) { const l = pg.locator(c).first(); if (await l.count()) { try { await l.click({ timeout: 3000 }); added = true; log.push('added via ' + c); break; } catch (e) {} } }
  if (!added) { await pg.keyboard.press('Control+Enter'); log.push('Ctrl+Enter'); }
  await pg.waitForTimeout(15000); await pg.keyboard.press('Escape');
  await shot('4_result');
  // Fehlertexte einsammeln
  const txt = await pg.evaluate(() => Array.from(document.querySelectorAll('body *')).filter((e) => e.children.length === 0 && /error|Error|cannot|Cannot|Fehler|runtime|Runtime/.test(e.textContent || '') && (e.textContent || '').length < 400).map((e) => e.textContent.trim()).slice(0, 40));
  log.push('texts: ' + JSON.stringify(txt));
  const cons = await pg.evaluate(() => Array.from(document.querySelectorAll('[class*="console"], [class*="Console"]')).map((e) => e.innerText).join('\n---\n').slice(0, 3000));
  log.push('pine console: ' + cons);
  const legend = await pg.evaluate(() => Array.from(document.querySelectorAll('[data-name="legend-source-item"]')).map((e) => e.innerText.replace(/\s+/g, ' ')).join(' | ').slice(0, 1500));
  const errIcon = await pg.evaluate(() => Array.from(document.querySelectorAll('[data-name="legend-source-item"] [class*="error"], [data-name="legend-source-item"] [class*="Error"]')).map((e) => (e.getAttribute('title') || '') + ' ' + e.className).join(' | '));
  log.push('legend-errors: ' + errIcon);
  // Fehler-Symbol anklicken, falls vorhanden, um den Text zu sehen
  const ei = pg.locator('[data-name="legend-source-item"] [class*="error"]').first(); if (await ei.count()) { try { await ei.hover(); await pg.waitForTimeout(1500); await shot('5_errhover'); const tip = await pg.evaluate(() => Array.from(document.querySelectorAll('[class*="tooltip"], [role="tooltip"]')).map((e) => e.innerText).join(' | ')); log.push('error tooltip: ' + tip); } catch (e) {} }
  log.push('legend: ' + legend);
} catch (e) { log.push('FEHLER Ablauf: ' + e.message.slice(0, 500)); await shot('9_fail'); }
writeFileSync(`out/${tag}.log`, log.join('\n')); console.log(log.join('\n'));
await b.close();
