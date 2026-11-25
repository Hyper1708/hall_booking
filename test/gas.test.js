'use strict';
// Loads the real Apps Script files into Node with fake Google and Telegram
// services, to test the glue that unit tests of Core.js cannot reach:
// the once-a-minute /remind check, group-only answers, handling each message
// once, and the mini app request path.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const DIR = path.join(__dirname, '..', 'apps-script');
const FILES = ['Core.js', 'Data.js', 'Telegram.js', 'Code.js', 'Bot.js', 'Jobs.js'];
const GROUP = '-100555';

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

function makeGas(opts) {
  opts = opts || {};
  const props = { BOT_TOKEN: '1:T', GROUP_CHAT_ID: GROUP, BOT_USERNAME: 'HRU_info_bot' };
  const cache = {};
  const sent = [];
  const queue = [];           // updates waiting at "Telegram"
  const tg = {
    getUpdates: p => queue.filter(u => u.update_id >= (p.offset || 0)),
    getChatMember: () => ({ status: 'member' }),
  };
  const ctx = vm.createContext({
    console: { log() {}, warn() {}, error() {} },
    PropertiesService: { getScriptProperties: () => ({
      getProperty: k => (k in props ? props[k] : null),
      setProperty: (k, v) => { props[k] = String(v); },
      deleteProperty: k => { delete props[k]; },
    }) },
    CacheService: { getScriptCache: () => ({
      get: k => cache[k] || null, put: (k, v) => { cache[k] = v; }, remove: k => { delete cache[k]; },
    }) },
    UrlFetchApp: {
      fetch(url, o) {
        const method = url.split('/').pop();
        const payload = JSON.parse(o.payload);
        sent.push({ method, payload });
        if (opts.fail && opts.fail(method, payload)) {
          return { getContentText: () => JSON.stringify({ ok: false, description: 'Bad Request: test failure' }), getResponseCode: () => 400 };
        }
        const result = tg[method] ? tg[method](payload) : { message_id: 1 };
        return { getContentText: () => JSON.stringify({ ok: true, result }), getResponseCode: () => 200 };
      },
    },
    Utilities: FakeUtilities,
    ContentService: {
      MimeType: { JSON: 'json' },
      createTextOutput: s => ({ kind: 'text', body: s, setMimeType() { return this; } }),
    },
  });
  FILES.forEach(f => vm.runInContext(fs.readFileSync(path.join(DIR, f), 'utf8'), ctx, { filename: f }));
  // Replace the sheet and clock with fixed data.
  ctx.now_ = () => ({ date: '2026-11-26', minutes: 9 * 60 });
  ctx.settings_ = () => ctx.Core.normalizeSettings({ BOT_LANG: 'en' });
  ctx.loadAll_ = () => ({
    settings: ctx.settings_(),
    halls: [{ id: 'H1', name_en: 'Hall 1', name_km: 'សាល ១', active: true }],
    holidays: {},
    bookings: [{ id: 'x', hall: 'H1', date: '2026-11-27', start: '08:00', end: '09:00', name: 'A', department: 'HR', status: 'active', tg_user_id: '7' }],
  });
  const replies = () => sent.filter(s => s.method === 'sendMessage');
  return { ctx, props, cache, sent, queue, replies };
}

const update = (id, text, chatId) => ({
  update_id: id,
  message: { message_id: 50 + id, text: text, chat: { id: Number(chatId || GROUP), type: 'supergroup' }, from: { id: 7 } },
});

test('/remind in the group: one reply with the week report, then never again', () => {
  const g = makeGas();
  g.queue.push(update(100, '/remind@HRU_info_bot'));
  g.ctx.pollBot();
  assert.equal(g.replies().length, 1);
  const p = g.replies()[0].payload;
  assert.equal(p.chat_id, GROUP);
  assert.equal(p.parse_mode, 'HTML');
  assert.deepEqual(p.reply_parameters, { message_id: 150, allow_sending_without_reply: true });
  assert.match(p.text, /^<b>Bookings for the next 7 days<\/b>/);
  assert.match(p.text, /Fri 27 Nov 2026<\/b>\n• Hall 1 08:00–09:00 HR \(A\)/);
  assert.equal(g.props.UPDATE_OFFSET, '101');
  g.ctx.pollBot();
  g.ctx.pollBot();
  assert.equal(g.replies().length, 1, 'handled once');
  assert.deepEqual(g.sent.filter(s => s.method === 'getUpdates').map(s => s.payload.offset), [0, 101, 101]);
});

test('keywords answer too; sentences, other chats, other bots and edits do not', () => {
  const g = makeGas();
  g.queue.push(
    update(1, 'remind'),
    update(2, 'រំលឹក'),
    update(3, 'Remind!'),
    update(4, 'please remind me'),
    update(5, '/remind', '-100999'),
    update(6, '/remind@OtherBot'),
    update(7, '/start'),
    { update_id: 8, edited_message: { text: '/remind', chat: { id: Number(GROUP) } } },
    { update_id: 9, message: { message_id: 1, chat: { id: Number(GROUP) }, photo: [] } },
  );
  g.ctx.pollBot();
  assert.deepEqual(g.replies().map(r => r.payload.reply_parameters.message_id), [51, 52, 53]);
  assert.equal(g.props.UPDATE_OFFSET, '10');
});

test('a reply that fails does not block the next messages or repeat', () => {
  const g = makeGas({ fail: (m, p) => m === 'sendMessage' && p.reply_parameters.message_id === 51 });
  g.queue.push(update(1, '/remind'), update(2, '/remind'));
  g.ctx.pollBot();
  g.ctx.pollBot();
  assert.deepEqual(g.replies().map(r => r.payload.reply_parameters.message_id), [51, 52]);
  assert.equal(g.props.UPDATE_OFFSET, '3');
});

test('Telegram error is saved for "Check /remind"; offset does not move', () => {
  const g = makeGas({ fail: m => m === 'getUpdates' });
  g.queue.push(update(1, '/remind'));
  g.ctx.pollBot();
  assert.equal(g.props.LAST_POLL_ERROR, 'Bad Request: test failure');
  assert.equal(g.props.UPDATE_OFFSET, undefined);
  assert.equal(g.replies().length, 0);
  assert.ok(g.props.LAST_POLL);
});

test('a run that overlaps a busy one does nothing; the busy flag is cleared after a run', () => {
  const g = makeGas();
  g.queue.push(update(1, '/remind'));
  g.cache.polling = '1';
  g.ctx.pollBot();
  assert.equal(g.sent.length, 0);
  delete g.cache.polling;
  g.ctx.pollBot();
  assert.equal(g.replies().length, 1);
  assert.equal(g.cache.polling, undefined);
});

test('mini app: bad signature refused, bad JSON is a server error, Telegram-style bodies get nothing', () => {
  const g = makeGas();
  const post = body => g.ctx.doPost({ parameter: {}, postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } });
  assert.deepEqual(JSON.parse(post({ action: 'list', initData: 'user=%7B%7D&hash=' + 'a'.repeat(64) }).body), { ok: false, error: 'AUTH' });
  assert.deepEqual(JSON.parse(post('not json').body), { ok: false, error: 'SERVER' });
  assert.deepEqual(JSON.parse(post(update(1, '/remind')).body), { ok: false, error: 'AUTH' });
  assert.equal(g.sent.length, 0);
});

test('mini app: a correctly signed request from a group member gets the month', () => {
  const g = makeGas();
  const fields = { auth_date: String(Math.floor(Date.now() / 1000) - 10), user: JSON.stringify({ id: 7, first_name: 'សុខា' }) };
  const dcs = Object.keys(fields).sort().map(k => k + '=' + fields[k]).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update('1:T').digest();
  const hash = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  const initData = Object.keys(fields).map(k => k + '=' + encodeURIComponent(fields[k])).join('&') + '&hash=' + hash;
  const out = JSON.parse(g.ctx.doPost({ parameter: {}, postData: { contents: JSON.stringify({ action: 'list', initData, from: '2026-11-01', to: '2026-11-30' }) } }).body);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.bookings.length, 1);
  assert.equal(out.bookings[0].mine, true);
  assert.equal(out.bookings[0].tg_user_id, undefined, 'Telegram ids stay on the server');
  assert.deepEqual(g.sent.map(s => s.method), ['getChatMember']);
});
