'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const Core = require('../apps-script/Core.js');

const settings = Core.normalizeSettings({});
const halls = [
  { id: 'H1', name_en: 'Hall 1', name_km: 'សាល ១', active: true },
  { id: 'H2', name_en: 'Hall 2', name_km: 'សាល ២', active: true },
  { id: 'H3', name_en: 'Hall 3', name_km: 'សាល ៣', active: false },
];
const existing = [
  { id: 'a', hall: 'H2', date: '2026-12-02', start: '09:00', end: '11:00', name: 'Dara', department: 'Finance', status: 'active', tg_user_id: '1' },
  { id: 'b', hall: 'H2', date: '2026-12-02', start: '13:00', end: '14:00', name: 'Sok', department: 'IT', status: 'cancelled', tg_user_id: '2' },
];
const ctx = (extra) => Object.assign({
  halls, holidays: {}, bookings: existing, settings, now: { date: '2026-11-25', minutes: 8 * 60 },
}, extra);
const req = (extra) => Object.assign({ hall: 'H2', date: '2026-12-02', start: '11:00', end: '12:00', name: 'Vanna', department: 'HR' }, extra);
const codes = r => r.reasons.map(x => x.code);

test('settings defaults and bounds', () => {
  assert.deepEqual(settings, { openHour: 7, closeHour: 18, maxDaysAhead: 180, noticeDays: 3, morningHour: 7, botLang: 'both', remindDays: 7 });
  assert.equal(Core.normalizeSettings({ REMIND_DAYS: '99' }).remindDays, 31);
  const s = Core.normalizeSettings({ OPEN_HOUR: '20', CLOSE_HOUR: '5', BOT_LANG: 'fr' });
  assert.equal(s.openHour, 20);
  assert.equal(s.closeHour, 21);
  assert.equal(s.botLang, 'both');
});

test('dates: real calendar only, add and diff', () => {
  assert.equal(Core.parseDate('2026-02-30'), null);
  assert.equal(Core.parseDate('2026-2-3'), null);
  assert.notEqual(Core.parseDate('2028-02-29'), null);
  assert.equal(Core.addDays('2026-12-30', 3), '2027-01-02');
  assert.equal(Core.daysBetween('2026-11-25', '2026-11-28'), 3);
});

test('back-to-back booking is accepted', () => {
  const r = Core.checkBooking(req(), ctx());
  assert.equal(r.ok, true, JSON.stringify(r.reasons));
  assert.equal(r.req.name, 'Vanna');
});

test('overlap is incomplete and names the other department', () => {
  const r = Core.checkBooking(req({ start: '10:00', end: '12:00' }), ctx());
  assert.equal(r.ok, false);
  assert.deepEqual(r.reasons, [{ code: 'CLASH', start: '09:00', end: '11:00', department: 'Finance', name: 'Dara' }]);
});

test('a booking that covers another one fully also clashes', () => {
  assert.deepEqual(codes(Core.checkBooking(req({ start: '08:00', end: '12:00' }), ctx())), ['CLASH']);
});

test('cancelled bookings and other halls do not clash', () => {
  assert.equal(Core.checkBooking(req({ start: '13:00', end: '14:00' }), ctx()).ok, true);
  assert.equal(Core.checkBooking(req({ hall: 'H1', start: '09:00', end: '11:00' }), ctx()).ok, true);
});

test('holiday and clash are both reported', () => {
  const holidays = { '2026-12-02': { en: 'Test Day', km: 'ថ្ងៃសាកល្បង' } };
  const r = Core.checkBooking(req({ start: '09:00', end: '10:00' }), ctx({ holidays }));
  assert.deepEqual(codes(r), ['HOLIDAY', 'CLASH']);
  assert.equal(r.reasons[0].km, 'ថ្ងៃសាកល្បង');
});

test('past, today-earlier-hour, too far, outside hours, end before start', () => {
  assert.deepEqual(codes(Core.checkBooking(req({ date: '2026-11-24' }), ctx())), ['PAST']);
  assert.deepEqual(codes(Core.checkBooking(req({ date: '2026-11-25', start: '07:00', end: '09:00' }), ctx())), ['PAST']);
  assert.equal(Core.checkBooking(req({ date: '2026-11-25', start: '08:00', end: '09:00' }), ctx()).ok, true);
  assert.deepEqual(codes(Core.checkBooking(req({ date: '2027-06-01' }), ctx())), ['TOO_FAR']);
  assert.deepEqual(codes(Core.checkBooking(req({ start: '17:00', end: '19:00' }), ctx())), ['OUTSIDE_HOURS']);
  assert.deepEqual(codes(Core.checkBooking(req({ start: '12:00', end: '12:00' }), ctx())), ['END_BEFORE_START']);
});

test('missing fields, inactive hall, bad formats', () => {
  assert.deepEqual(codes(Core.checkBooking(req({ name: '  ', department: '' }), ctx())), ['MISSING', 'MISSING']);
  assert.deepEqual(codes(Core.checkBooking(req({ hall: 'H3' }), ctx())), ['BAD_HALL']);
  assert.deepEqual(codes(Core.checkBooking(req({ date: '2026-13-01', start: '9:30' }), ctx())), ['BAD_DATE', 'BAD_TIME']);
  assert.deepEqual(codes(Core.checkBooking(null, ctx())), ['BAD_HALL', 'MISSING', 'MISSING', 'BAD_DATE', 'BAD_TIME']);
});

test('text cleaning blocks formulas and control characters, keeps Khmer', () => {
  assert.equal(Core.cleanText('=HYPERLINK("x")'), 'HYPERLINK("x")');
  assert.equal(Core.cleanText('  a\n\tb  '), 'a b');
  assert.equal(Core.cleanText('នាយកដ្ឋាន​ហិរញ្ញវត្ថុ'), 'នាយកដ្ឋាន​ហិរញ្ញវត្ថុ');
  assert.equal(Core.cleanText('x'.repeat(100)).length, 60);
  assert.equal(Core.cleanText(42), '');
});

test('hand-typed hours like 9:00 in the sheet still clash', () => {
  const hand = [{ id: 'z', hall: 'H1', date: '2026-12-02', start: '9:00', end: '10:00', name: 'A', department: 'B', status: 'active' }];
  assert.deepEqual(codes(Core.checkBooking(req({ hall: 'H1', start: '09:00', end: '10:00' }), ctx({ bookings: hand }))), ['CLASH']);
});

test('cancel rules', () => {
  const now = { date: '2026-12-02', minutes: 8 * 60 };
  assert.deepEqual(Core.checkCancel(existing[0], '1', now), []);
  assert.equal(Core.checkCancel(existing[0], '9', now)[0].code, 'NOT_OWNER');
  assert.equal(Core.checkCancel(existing[1], '2', now)[0].code, 'ALREADY_CANCELLED');
  assert.equal(Core.checkCancel(undefined, '1', now)[0].code, 'NOT_FOUND');
  assert.equal(Core.checkCancel(existing[0], '1', { date: '2026-12-02', minutes: 9 * 60 })[0].code, 'STARTED');
});

// ------------------------------------------------------------------ holidays

const ICS = [
  'BEGIN:VCALENDAR',
  'BEGIN:VEVENT',
  'DTSTART;VALUE=DATE:20270414',
  'DTEND;VALUE=DATE:20270417',
  'SUMMARY:Khmer New Year',
  'DESCRIPTION:Public holiday',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART;VALUE=DATE:20270520',
  'DTEND;VALUE=DATE:20270521',
  'SUMMARY:Visak Bochea\\, Day',
  'DESCRIPTION:Public holiday',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART;VALUE=DATE:20270214',
  'DTEND;VALUE=DATE:20270215',
  'SUMMARY:Valentine',
  'DESCRIPTION:Observance\\nTo hide observances',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

test('ICS: multi-day expanded, observances skipped, escapes undone', () => {
  assert.deepEqual(Core.parseIcsHolidays(ICS), [
    { date: '2027-04-14', en: 'Khmer New Year' },
    { date: '2027-04-15', en: 'Khmer New Year' },
    { date: '2027-04-16', en: 'Khmer New Year' },
    { date: '2027-05-20', en: 'Visak Bochea, Day' },
  ]);
});

test('merge: union of feeds, Khmer from Nager, admin rows and switches kept', () => {
  const google = Core.parseIcsHolidays(ICS);
  const nager = Core.parseNager([
    { date: '2027-04-14', name: 'Khmer New Year', localName: 'ចូលឆ្នាំ' },
    { date: '2027-01-01', name: "New Year's Day", localName: 'ចូលឆ្នាំសកល' },
  ]);
  const existingRows = [
    { date: '2027-04-15', name_en: 'Khmer New Year', name_km: 'ចូលឆ្នាំ ថ្ងៃទី២', source: 'auto', enabled: 'FALSE' },
    { date: '2027-03-01', name_en: 'University closed', name_km: '', source: 'manual', enabled: 'TRUE' },
    { date: '2026-12-31', name_en: 'Old auto row', name_km: '', source: 'auto', enabled: 'TRUE' },
    { date: '', name_en: '', name_km: '', source: '', enabled: '' },
  ];
  const rows = Core.mergeHolidays(existingRows, google, nager, true, '2027-01-01', '2027-12-31');
  assert.deepEqual(rows.map(r => [r.date, r.source, r.enabled, r.name_km]), [
    ['2027-01-01', 'auto', 'TRUE', 'ចូលឆ្នាំសកល'],
    ['2027-03-01', 'manual', 'TRUE', ''],
    ['2027-04-14', 'auto', 'TRUE', 'ចូលឆ្នាំ'],
    ['2027-04-15', 'auto', 'FALSE', 'ចូលឆ្នាំ ថ្ងៃទី២'],
    ['2027-04-16', 'auto', 'TRUE', ''],
    ['2027-05-20', 'auto', 'TRUE', ''],
  ]);
  const map = Core.holidayMap(rows);
  assert.equal(map['2027-04-15'], undefined, 'switched-off day is not a holiday');
  assert.deepEqual(map['2027-05-20'], { en: 'Visak Bochea, Day', km: 'Visak Bochea, Day' });
  const visak = Core.mergeHolidays([], [{ date: '2027-05-20', en: 'Visak Bochea Day' }], [], true, '2027-01-01', '2027-12-31');
  assert.equal(visak[0].name_km, 'ពិធីបុណ្យវិសាខបូជា');
  assert.deepEqual(map['2027-03-01'], { en: 'University closed', km: 'University closed' });
});

test('merge: when a feed failed, old auto rows are not removed', () => {
  const old = [{ date: '2027-05-20', name_en: 'Visak Bochea Day', name_km: '', source: 'auto', enabled: 'TRUE' }];
  const nager = Core.parseNager([{ date: '2027-01-01', name: 'NY', localName: 'ចូលឆ្នាំសកល' }]);
  const rows = Core.mergeHolidays(old, [], nager, false, '2027-01-01', '2027-12-31');
  assert.deepEqual(rows.map(r => r.date), ['2027-01-01', '2027-05-20']);
});

// ------------------------------------------------------------------ messages

test('messages escape HTML from user input', () => {
  const b = { hall: 'H1', date: '2026-12-02', start: '09:00', end: '10:00', name: '<b>x</b>', department: 'R&D' };
  const msg = Core.bookingMessage('newBooking', b, halls[0], 'en');
  assert.equal(msg, '<b>New booking</b>\nHall 1\nWed 2 Dec 2026, 09:00–10:00\nR&amp;D (&lt;b&gt;x&lt;/b&gt;)');
  assert.match(Core.bookingMessage('newBooking', b, halls[0], 'both'), /^<b>ការកក់ថ្មី \/ New booking<\/b>\nសាល ១ \/ Hall 1\nពុធ 2 ធ្នូ 2026 \/ Wed 2 Dec 2026/);
});

test('daily digest: today for cleaners, then notice days ahead, with holiday line', () => {
  const text = Core.dailyDigest({
    today: '2026-11-29', noticeDays: 3, lang: 'en',
    halls: halls.filter(h => h.active),
    bookings: existing,
    holidays: { '2026-12-02': { en: 'Test Day', km: 'ថ្ងៃសាកល្បង' } },
  });
  assert.equal(text, [
    '<b>Halls to prepare today</b>', 'Sun 29 Nov 2026', '<b>Hall 1</b>: —', '<b>Hall 2</b>: —', '',
    '<b>Bookings in 3 days</b>', 'Wed 2 Dec 2026', 'Holiday: Test Day', '<b>Hall 1</b>: —', '<b>Hall 2</b>',
    '• 09:00–11:00 Finance (Dara)',
  ].join('\n'));
});

test('/remind: 7 days from today, sorted by time, holidays marked, empty days short', () => {
  const list = [
    { hall: 'H2', date: '2026-11-26', start: '13:00', end: '14:00', name: 'B', department: 'IT', status: 'active' },
    { hall: 'H1', date: '2026-11-26', start: '08:00', end: '10:00', name: 'A', department: 'HR', status: 'active' },
    { hall: 'H1', date: '2026-11-27', start: '08:00', end: '10:00', name: 'X', department: 'Gone', status: 'cancelled' },
    { hall: 'H1', date: '2026-12-02', start: '09:00', end: '10:00', name: 'Z', department: 'R&D', status: 'active' },
    { hall: 'H1', date: '2026-12-03', start: '09:00', end: '10:00', name: 'Late', department: 'Out', status: 'active' },
  ];
  const text = Core.weekReport({
    today: '2026-11-26', days: 7, lang: 'en', halls,
    bookings: list, holidays: { '2026-11-28': { en: 'Test Day', km: 'ថ្ងៃសាកល្បង' } },
  });
  assert.equal(text, [
    '<b>Bookings for the next 7 days</b>',
    '<b>Thu 26 Nov 2026</b>\n• Hall 1 08:00–10:00 HR (A)\n• Hall 2 13:00–14:00 IT (B)',
    '<b>Fri 27 Nov 2026</b>: —',
    '<b>Sat 28 Nov 2026</b>: —\nHoliday: Test Day',
    '<b>Sun 29 Nov 2026</b>: —',
    '<b>Mon 30 Nov 2026</b>: —',
    '<b>Tue 1 Dec 2026</b>: —',
    '<b>Wed 2 Dec 2026</b>\n• Hall 1 09:00–10:00 R&amp;D (Z)',
  ].join('\n\n'));
  assert.match(Core.weekReport({ today: '2026-11-26', days: 1, lang: 'km', halls, bookings: list, holidays: {} }),
    /^<b>ការកក់ 1 ថ្ងៃខាងមុខ<\/b>\n\n<b>ព្រហស្បតិ៍ 26 វិច្ឆិកា 2026<\/b>\n• សាល ១ 08:00–10:00/);
});

test('/remind: a very long week is cut at a day boundary below Telegram\'s limit', () => {
  const many = [];
  for (let d = 0; d < 7; d++) {
    for (let h = 7; h < 18; h++) {
      many.push({ hall: 'H1', date: Core.addDays('2026-11-26', d), start: (h < 10 ? '0' : '') + h + ':00', end: (h + 1 < 10 ? '0' : '') + (h + 1) + ':00',
        name: 'Someone with a long name', department: 'A department with a rather long name', status: 'active' });
    }
  }
  const text = Core.weekReport({ today: '2026-11-26', days: 7, lang: 'both', halls, bookings: many, holidays: {} });
  assert.ok(text.length <= 3900, 'length ' + text.length);
  assert.ok(text.endsWith('\n\n…'));
  assert.equal((text.match(/<b>/g) || []).length, (text.match(/<\/b>/g) || []).length, 'no tag cut in half');
});

test('command parsing', () => {
  assert.equal(Core.parseCommand('/remind', 'HRU_info_bot'), 'remind');
  assert.equal(Core.parseCommand('/remind@HRU_info_bot', 'HRU_info_bot'), 'remind');
  assert.equal(Core.parseCommand('/REMIND@hru_INFO_bot please', 'HRU_info_bot'), 'remind');
  assert.equal(Core.parseCommand('/remind@OtherBot', 'HRU_info_bot'), null);
  assert.equal(Core.parseCommand('/remind@HRU_info_bot', ''), null);
  assert.equal(Core.parseCommand('please /remind', 'HRU_info_bot'), null);
  assert.equal(Core.parseCommand('/reminder', 'HRU_info_bot'), 'reminder');
  assert.equal(Core.parseCommand(undefined, 'x'), null);
});

// ---------------------------------------------------------------------- auth

const TOKEN = '123456:TEST-token';
/** Build initData exactly as the Telegram docs describe, using Node's crypto. */
function makeInitData(fields) {
  const dcs = Object.keys(fields).sort().map(k => k + '=' + fields[k]).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  const hash = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  return Object.keys(fields).map(k => k + '=' + encodeURIComponent(fields[k])).join('&') + '&hash=' + hash;
}
/** Same contract as Apps Script's Utilities.computeHmacSha256Signature: returns SIGNED bytes. */
function signedHmac(key, msg) {
  const k = typeof key === 'string' ? Buffer.from(key, 'utf8') : Buffer.from(key.map(b => b & 0xff));
  return Array.from(crypto.createHmac('sha256', k).update(msg, 'utf8').digest(), b => (b > 127 ? b - 256 : b));
}
const NOW = 1764000000;
const user = JSON.stringify({ id: 42, first_name: 'សុខា', last_name: 'Chan', language_code: 'km' });

test('initData: valid signature accepted (Khmer name, signed bytes)', () => {
  const data = makeInitData({ auth_date: String(NOW - 60), query_id: 'AAE', user: user, signature: 'sig' });
  const v = Core.verifyInitData(data, TOKEN, signedHmac, NOW, 86400);
  assert.ok(v);
  assert.equal(v.user.id, 42);
  assert.equal(v.user.first_name, 'សុខា');
});

test('initData: tampered, wrong token, expired, future, garbage all rejected', () => {
  const good = makeInitData({ auth_date: String(NOW - 60), user: user });
  assert.equal(Core.verifyInitData(good.replace('%22id%22%3A42', '%22id%22%3A43'), TOKEN, signedHmac, NOW, 86400), null);
  assert.equal(Core.verifyInitData(good, '999:other', signedHmac, NOW, 86400), null);
  assert.equal(Core.verifyInitData(makeInitData({ auth_date: String(NOW - 90000), user: user }), TOKEN, signedHmac, NOW, 86400), null);
  assert.equal(Core.verifyInitData(makeInitData({ auth_date: String(NOW + 3600), user: user }), TOKEN, signedHmac, NOW, 86400), null);
  assert.equal(Core.verifyInitData('', TOKEN, signedHmac, NOW, 86400), null);
  assert.equal(Core.verifyInitData('%E0%A4%A&hash=' + 'a'.repeat(64), TOKEN, signedHmac, NOW, 86400), null);
  assert.equal(Core.verifyInitData(good, '', signedHmac, NOW, 86400), null);
});
