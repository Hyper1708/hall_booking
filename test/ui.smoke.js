'use strict';
// Browser smoke test for the mini app, with a fake API. Needs Playwright:
//   npm i -D playwright && npx playwright install chromium
// Usage: node test/ui.smoke.js [screenshot-dir]
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..', 'docs');
const SHOTS = process.argv[2];
const API = 'https://api.example.test/exec';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };

const halls = [
  { id: 'H1', name_en: 'Hall 1', name_km: 'សាល ១' },
  { id: 'H2', name_en: 'Hall 2', name_km: 'សាល ២' },
  { id: 'H3', name_en: 'Hall 3', name_km: 'សាល ៣' },
];
const bookings = [
  { id: 'a', hall: 'H2', date: '2026-11-27', start: '09:00', end: '11:00', name: 'Dara', department: 'Finance', mine: false },
  { id: 'b', hall: 'H1', date: '2026-11-27', start: '13:00', end: '15:00', name: 'Me', department: 'IT', mine: true },
];
const calls = [];

function fakeApi(body) {
  calls.push(body);
  if (body.action === 'list') {
    const day = body.from || '2026-11-27';
    return {
      ok: true,
      now: { date: '2026-11-27', minutes: 8 * 60 + 30 },
      settings: { openHour: 7, closeHour: 18, maxDaysAhead: 180 },
      halls,
      holidays: day === '2026-11-28' ? { '2026-11-28': { en: 'Test Holiday', km: 'ថ្ងៃឈប់សាកល្បង' } } : {},
      bookings: bookings.filter(b => b.date === day),
      mine: bookings.filter(b => b.mine),
    };
  }
  if (body.action === 'book') {
    if (body.booking.hall === 'H2') {
      return { ok: false, status: 'incomplete', reasons: [
        { code: 'HOLIDAY', en: 'Test Holiday', km: 'ថ្ងៃឈប់សាកល្បង' },
        { code: 'CLASH', start: '09:00', end: '11:00', department: 'Finance', name: 'Dara' },
      ] };
    }
    return { ok: true, booking: Object.assign({ id: 'new', mine: true }, body.booking) };
  }
  if (body.action === 'cancel') return { ok: true };
  return { ok: false, error: 'BAD_ACTION' };
}

(async () => {
  const server = http.createServer((req, res) => {
    const file = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]) === '/' ? 'index.html' : req.url.split('?')[0]);
    if (!file.startsWith(ROOT) || !fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(fs.readFileSync(file));
  }).listen(0);
  const base = 'http://127.0.0.1:' + server.address().port + '/';

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, locale: 'en-US' });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  await page.route('https://telegram.org/**', r => r.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
  await page.route('https://fonts.googleapis.com/**', r => r.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  await page.route('**/config.js', r => r.fulfill({ status: 200, contentType: 'text/javascript', body: 'window.APP_CONFIG={apiUrl:' + JSON.stringify(API) + '};' }));
  await page.route(API, async r => {
    const out = fakeApi(JSON.parse(r.request().postData() || '{}'));
    await r.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(out) });
  });

  await page.goto(base);
  await page.waitForSelector('#grid tbody tr');

  // Grid: 3 halls, 11 hours (07-17), Finance block spans 2 rows, past hours closed.
  assert.deepEqual(await page.$$eval('#grid thead th', ths => ths.map(t => t.textContent)), ['Time', 'Hall 1', 'Hall 2', 'Hall 3']);
  assert.equal(await page.$$eval('#grid tbody tr', r => r.length), 11);
  assert.equal(await page.$eval('#grid td.busy', td => td.getAttribute('rowspan')), '2');
  assert.match(await page.textContent('#grid'), /Finance/);
  assert.equal(await page.$$eval('#grid tbody tr:first-child td.closed', t => t.length), 3, '07:00 is past');
  assert.match(await page.textContent('#mine'), /IT/);

  // Tap Hall 2 at 11:00 -> form prefilled -> server says incomplete with reasons.
  const row11 = (await page.$$('#grid tbody tr'))[4];
  const cells = await row11.$$('td.free');
  await cells[1].click();
  assert.equal(await page.isVisible('#formbox'), true);
  assert.equal(await page.inputValue('#f-hall'), 'H2');
  assert.equal(await page.inputValue('#f-start'), '11:00');
  assert.equal(await page.inputValue('#f-end'), '12:00');
  await page.fill('#f-name', 'Vanna');
  await page.fill('#f-dept', 'HR');
  await page.click('#f-submit');
  await page.waitForSelector('#result:not([hidden])');
  assert.match(await page.textContent('#result'), /^Incomplete/);
  assert.equal(await page.$$eval('#result li', l => l.length), 2);
  assert.match(await page.textContent('#result'), /Already booked 09:00–11:00 by Finance \(Dara\)/);
  const sent = calls.filter(c => c.action === 'book')[0].booking;
  assert.deepEqual(sent, { hall: 'H2', date: '2026-11-27', start: '11:00', end: '12:00', name: 'Vanna', department: 'HR' });
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'ui-en-incomplete.png'), fullPage: true });

  // Language button: everything, including the open reasons, switches to Khmer.
  assert.equal(await page.textContent('#lang'), 'ខ្មែរ');
  await page.click('#lang');
  assert.equal(await page.textContent('h1'), 'ការកក់សាល');
  assert.match(await page.textContent('#result'), /^មិនពេញលេញ/);
  assert.match(await page.textContent('#result'), /ថ្ងៃឈប់សាកល្បង/);
  assert.match(await page.textContent('#grid thead'), /សាល ២/);
  assert.equal(await page.textContent('#lang'), 'English');
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'ui-km-incomplete.png'), fullPage: true });

  // Successful booking closes the form and shows a notice.
  await page.selectOption('#f-hall', 'H3');
  await page.click('#f-submit');
  await page.waitForSelector('#notice.ok:not([hidden])');
  assert.equal(await page.isVisible('#formbox'), false);

  // Next day is a holiday: banner shown, no free cells.
  await page.click('#next');
  await page.waitForSelector('#holiday:not([hidden])');
  assert.match(await page.textContent('#holiday'), /ថ្ងៃឈប់សាកល្បង/);
  assert.equal(await page.$$eval('#grid td.free', t => t.length), 0);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'ui-km-holiday.png'), fullPage: true });

  // Every request carried initData (empty outside Telegram) and an action.
  calls.forEach(c => assert.ok('initData' in c && c.action));

  assert.deepEqual(errors, []);
  await browser.close();
  server.close();
  console.log('UI smoke test passed (' + calls.length + ' API calls).');
})().catch(e => { console.error(e); process.exit(1); });
