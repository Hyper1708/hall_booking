'use strict';
// Loads the real Apps Script files into Node with fake Google services, to test
// the glue that unit tests of Core.js cannot reach: request routing, the
// webhook secret, group-only answers, duplicate updates.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

/** Apps Script's Utilities, as far as the code uses it. Bytes are SIGNED, like in Apps Script. */
const signed = buf => Array.from(buf, b => (b > 127 ? b - 256 : b));
const FakeUtilities = {
  newBlob: () => ({
    setDataFromString(s, charset) {
      assert.equal(charset, 'UTF-8');
      return { getBytes: () => signed(Buffer.from(s, 'utf8')) };
    },
  }),
  computeHmacSha256Signature(value, key) {
    assert.ok(Array.isArray(value) && Array.isArray(key), 'byte[] overload');
    const u = a => Buffer.from(a.map(b => b & 0xff));
    return signed(crypto.createHmac('sha256', u(key)).update(u(value)).digest());
  },
};

const DIR = path.join(__dirname, '..', 'apps-script');
const FILES = ['Core.js', 'Data.js', 'Telegram.js', 'Code.js', 'Bot.js', 'Jobs.js'];
const GROUP = '-100555';
const SECRET = 'abc123secret';

function makeGas() {
  const props = { BOT_TOKEN: '1:T', GROUP_CHAT_ID: GROUP, HOOK_SECRET: SECRET, BOT_USERNAME: 'HRU_info_bot' };
  const cache = {};
  const sent = [];
  const ctx = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    PropertiesService: { getScriptProperties: () => ({ getProperty: k => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = v; } }) },
    CacheService: { getScriptCache: () => ({ get: k => cache[k] || null, put: (k, v) => { cache[k] = v; } }) },
    UrlFetchApp: {
      fetch(url, opts) {
        const method = url.split('/').pop();
        sent.push({ method, payload: JSON.parse(opts.payload) });
        const result = method === 'getChatMember' ? { status: 'member' } : { message_id: 1 };
        return { getContentText: () => JSON.stringify({ ok: true, result }), getResponseCode: () => 200 };
      },
    },
    Utilities: FakeUtilities,
    HtmlService: { createHtmlOutput: s => ({ kind: 'html', body: s }) },
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: s => ({ kind: 'text', body: s, setMimeType() { return this; } }),
    },
  });
  FILES.forEach(f => vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), ctx, { filename: f }));
  // Replace the sheet and clock with fixed data.
  ctx.now_ = () => ({ date: '2026-11-26', minutes: 9 * 60 });
  ctx.loadAll_ = () => ({
    settings: ctx.Core.normalizeSettings({ BOT_LANG: 'en' }),
    halls: [{ id: 'H1', name_en: 'Hall 1', name_km: 'សាល ១', active: true }],
    holidays: {},
    bookings: [{ id: 'x', hall: 'H1', date: '2026-11-27', start: '08:00', end: '09:00', name: 'A', department: 'HR', status: 'active', tg_user_id: '7' }],
  });
  return { ctx, props, sent };
}

const update = (id, text, chatId) => ({
  update_id: id,
  message: { message_id: 50 + id, text: text, chat: { id: Number(chatId || GROUP), type: 'supergroup' }, from: { id: 7 } },
});
const post = (ctx, body, query) => ctx.doPost({ parameter: query || {}, postData: { contents: JSON.stringify(body) } });

test('/remind with the secret, in the group: one reply with the week report', () => {
  const { ctx, sent } = makeGas();
  const out = post(ctx, update(1, '/remind@HRU_info_bot'), { hook: SECRET });
  assert.equal(out.kind, 'html', 'Telegram must get a 200 page, not a redirecting JSON output');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].method, 'sendMessage');
  assert.equal(sent[0].payload.chat_id, GROUP);
  assert.equal(sent[0].payload.parse_mode, 'HTML');
  assert.deepEqual(sent[0].payload.reply_parameters, { message_id: 51, allow_sending_without_reply: true });
  assert.match(sent[0].payload.text, /^<b>Bookings for the next 7 days<\/b>/);
  assert.match(sent[0].payload.text, /Fri 27 Nov 2026<\/b>\n• Hall 1 08:00–09:00 HR \(A\)/);
});

test('same update sent twice by Telegram: answered once', () => {
  const { ctx, sent } = makeGas();
  post(ctx, update(2, '/remind'), { hook: SECRET });
  post(ctx, update(2, '/remind'), { hook: SECRET });
  assert.equal(sent.length, 1);
});

test('ignored: wrong or missing secret, other chat, other bot, other command, plain text', () => {
  const { ctx, sent } = makeGas();
  assert.equal(post(ctx, update(3, '/remind'), { hook: 'wrong' }).kind, 'html');
  post(ctx, update(4, '/remind'));
  post(ctx, update(5, '/remind', '-100999'), { hook: SECRET });
  post(ctx, update(6, '/remind@OtherBot'), { hook: SECRET });
  post(ctx, update(7, '/start'), { hook: SECRET });
  post(ctx, update(8, 'remind me'), { hook: SECRET });
  post(ctx, { update_id: 9, edited_message: { text: '/remind', chat: { id: Number(GROUP) } } }, { hook: SECRET });
  assert.equal(sent.length, 0);
});

test('webhook is off when HOOK_SECRET is not set', () => {
  const { ctx, props, sent } = makeGas();
  delete props.HOOK_SECRET;
  post(ctx, update(10, '/remind'), { hook: '' });
  post(ctx, update(11, '/remind'), {});
  assert.equal(sent.length, 0);
});

test('mini app requests still get JSON; bad signature is refused', () => {
  const { ctx, sent } = makeGas();
  const out = post(ctx, { action: 'list', initData: 'user=%7B%7D&hash=' + 'a'.repeat(64) });
  assert.equal(out.kind, 'text');
  assert.deepEqual(JSON.parse(out.body), { ok: false, error: 'AUTH' });
  const bad = ctx.doPost({ parameter: {}, postData: { contents: 'not json' } });
  assert.deepEqual(JSON.parse(bad.body), { ok: false, error: 'SERVER' });
  assert.equal(sent.length, 0);
});

test('mini app: a correctly signed request from a group member gets the month', () => {
  const { ctx, sent } = makeGas();
  const fields = { auth_date: String(Math.floor(Date.now() / 1000) - 10), user: JSON.stringify({ id: 7, first_name: 'សុខា' }) };
  const dcs = Object.keys(fields).sort().map(k => k + '=' + fields[k]).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update('1:T').digest();
  const hash = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  const initData = Object.keys(fields).map(k => k + '=' + encodeURIComponent(fields[k])).join('&') + '&hash=' + hash;
  const out = JSON.parse(post(ctx, { action: 'list', initData: initData, from: '2026-11-01', to: '2026-11-30' }).body);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.bookings.length, 1);
  assert.equal(out.bookings[0].mine, true);
  assert.equal(out.bookings[0].tg_user_id, undefined, 'Telegram ids stay on the server');
  assert.deepEqual(sent.map(s => s.method), ['getChatMember']);
});

test('a request with update_id but no secret cannot reach the booking API either', () => {
  const { ctx, sent } = makeGas();
  const out = post(ctx, { update_id: 1, action: 'book', booking: {} });
  assert.equal(out.kind, 'html');
  assert.equal(sent.length, 0);
});
