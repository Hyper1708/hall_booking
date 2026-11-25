/**
 * Web API for the mini app. Deploy as a web app: Execute as "Me", access "Anyone".
 * Every request must carry Telegram initData; it is checked here, and the
 * sender must be a member of the group.
 */
const TZ = 'Asia/Phnom_Penh';
const AUTH_MAX_AGE_SEC = 24 * 3600;
const LOCK_WAIT_MS = 10000;

function doGet() {
  return ContentService.createTextOutput('Hall booking API is running.');
}

function doPost(e) {
  let body = null;
  try { body = JSON.parse((e && e.postData && e.postData.contents) || '{}'); } catch (err) { body = null; }

  // A Telegram bot update (webhook, see Bot.js), not a mini app request.
  if (body && body.update_id !== undefined) {
    try { handleWebhook_(e, body); } catch (err) { console.error(err && err.stack ? err.stack : String(err)); }
    // HtmlService answers 200 directly. ContentService would answer with a 302
    // redirect, which Telegram counts as a failure and sends the update again.
    return HtmlService.createHtmlOutput('ok');
  }

  let out;
  try {
    if (!body) throw new Error('Request body is not JSON.');
    const auth = authenticate_(body.initData);
    out = auth.user ? route_(body, auth.user) : { ok: false, error: auth.error };
  } catch (err) {
    console.error(err && err.stack ? err.stack : String(err));
    out = { ok: false, error: 'SERVER' };
  }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}

function route_(body, user) {
  switch (body.action) {
    case 'list': return apiList_(body, user);
    case 'book': return apiBook_(body, user);
    case 'cancel': return apiCancel_(body, user);
    default: return { ok: false, error: 'BAD_ACTION' };
  }
}

/** HMAC-SHA256 for Core.verifyInitData. key: string or byte[]; msg: string (UTF-8). */
function gasHmac_(key, msg) {
  const utf8 = s => Utilities.newBlob('').setDataFromString(s, 'UTF-8').getBytes();
  return Utilities.computeHmacSha256Signature(utf8(msg), typeof key === 'string' ? utf8(key) : key);
}

function authenticate_(initData) {
  const token = prop_('BOT_TOKEN');
  if (!token) throw new Error('BOT_TOKEN is not set in Script Properties.');
  const v = Core.verifyInitData(initData, token, gasHmac_, Math.floor(Date.now() / 1000), AUTH_MAX_AGE_SEC);
  if (!v) return { error: 'AUTH' };
  if (!isGroupMember_(v.user.id)) return { error: 'NOT_MEMBER' };
  return { user: v.user };
}

/** Current date and minute of day in Phnom Penh. */
function now_() {
  const d = new Date();
  return {
    date: Utilities.formatDate(d, TZ, 'yyyy-MM-dd'),
    minutes: Number(Utilities.formatDate(d, TZ, 'H')) * 60 + Number(Utilities.formatDate(d, TZ, 'm')),
  };
}

/** What the mini app may see. Telegram user ids stay on the server. */
function publicBooking_(b, uid) {
  return {
    id: b.id, hall: b.hall, date: b.date, start: b.start, end: b.end,
    name: b.name, department: b.department, mine: String(b.tg_user_id) === String(uid),
  };
}

function apiList_(body, user) {
  const now = now_();
  const from = Core.parseDate(body.from) !== null ? body.from : now.date;
  let to = Core.parseDate(body.to) !== null ? body.to : from;
  const span = Core.daysBetween(from, to);
  if (span < 0 || span > 31) to = from;

  const db = loadAll_();
  const active = db.bookings.filter(b => b.status === 'active');
  const holidays = {};
  Object.keys(db.holidays).forEach(d => { if (d >= from && d <= to) holidays[d] = db.holidays[d]; });
  return {
    ok: true,
    now: now,
    settings: { openHour: db.settings.openHour, closeHour: db.settings.closeHour, maxDaysAhead: db.settings.maxDaysAhead },
    halls: db.halls.filter(h => h.active).map(h => ({ id: h.id, name_en: h.name_en, name_km: h.name_km })),
    holidays: holidays,
    bookings: active.filter(b => b.date >= from && b.date <= to).map(b => publicBooking_(b, user.id)),
    mine: active
      .filter(b => String(b.tg_user_id) === String(user.id) && b.date >= now.date)
      .sort(Core.byDateStart)
      .map(b => publicBooking_(b, user.id)),
  };
}

/**
 * First come, first served: the script lock makes check-and-write one step,
 * so two people can never both get the same hour. flush() before unlocking
 * so the next request reads the new row.
 */
function apiBook_(body, user) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) return { ok: false, error: 'BUSY' };
  let db, booking;
  try {
    db = loadAll_();
    const res = Core.checkBooking(body.booking, {
      halls: db.halls, holidays: db.holidays, bookings: db.bookings, settings: db.settings, now: now_(),
    });
    if (!res.ok) return { ok: false, status: 'incomplete', reasons: res.reasons };
    booking = Object.assign({}, res.req, {
      id: Utilities.getUuid(),
      tg_user_id: String(user.id),
      status: 'active',
      created_at: new Date().toISOString(),
      cancelled_at: '',
    });
    appendBooking_(booking);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  notify_(Core.bookingMessage('newBooking', booking, hallById_(db.halls, booking.hall), db.settings.botLang));
  return { ok: true, booking: publicBooking_(booking, user.id) };
}

function apiCancel_(body, user) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(LOCK_WAIT_MS)) return { ok: false, error: 'BUSY' };
  let db, booking;
  try {
    db = loadAll_();
    booking = db.bookings.filter(b => b.id === String(body.id || ''))[0];
    const reasons = Core.checkCancel(booking, user.id, now_());
    if (reasons.length) return { ok: false, status: 'incomplete', reasons: reasons };
    updateBooking_(booking._row, { status: 'cancelled', cancelled_at: new Date().toISOString() });
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  notify_(Core.bookingMessage('cancelled', booking, hallById_(db.halls, booking.hall), db.settings.botLang));
  return { ok: true };
}
