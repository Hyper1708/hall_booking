/**
 * Hall booking: pure rules shared by every Apps Script file.
 * No Apps Script services here (SpreadsheetApp, UrlFetchApp, ...), so the
 * Node tests in /test can load this file directly.
 */
var Core = (function () {
  'use strict';

  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const HOUR_RE = /^([01]\d|2[0-3]):00$/;
  const MAX_TEXT = 60;
  const DAY_MS = 86400000;

  const pad2 = n => (n < 10 ? '0' : '') + n;
  const hourStr = h => pad2(h) + ':00';

  /** 'HH:MM' (or 'H:MM' typed by hand in the sheet) -> minutes, NaN if unreadable. */
  function toMinutes(s) {
    const m = /^(\d{1,2}):(\d{2})/.exec(String(s));
    return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
  }
  const byStart = (a, b) => toMinutes(a.start) - toMinutes(b.start);
  const byDateStart = (a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : byStart(a, b));

  /** 'YYYY-MM-DD' -> UTC ms, or null if it is not a real calendar date. */
  function parseDate(s) {
    if (typeof s !== 'string' || !DATE_RE.test(s)) return null;
    const y = Number(s.slice(0, 4)), m = Number(s.slice(5, 7)), d = Number(s.slice(8, 10));
    const t = Date.UTC(y, m - 1, d);
    const dt = new Date(t);
    return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d ? t : null;
  }
  function formatYmd(t) {
    const dt = new Date(t);
    return dt.getUTCFullYear() + '-' + pad2(dt.getUTCMonth() + 1) + '-' + pad2(dt.getUTCDate());
  }
  const addDays = (s, n) => formatYmd(parseDate(s) + n * DAY_MS);
  const daysBetween = (a, b) => Math.round((parseDate(b) - parseDate(a)) / DAY_MS);

  /** Sheet flag -> boolean. Empty counts as on; FALSE / NO / 0 / OFF count as off. */
  const isOn = v => ['FALSE', 'NO', '0', 'OFF'].indexOf(String(v == null ? '' : v).trim().toUpperCase()) < 0;

  /** Trim, collapse spaces, drop control characters and leading spreadsheet-formula signs. */
  function cleanText(v) {
    if (typeof v !== 'string') return '';
    return v.replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^[=+\-@]+\s*/, '')
      .slice(0, MAX_TEXT)
      .trim();
  }

  /** Settings tab (key -> string) -> numbers with safe bounds. */
  function normalizeSettings(raw) {
    raw = raw || {};
    const int = (v, def) => { const n = parseInt(v, 10); return isNaN(n) ? def : n; };
    const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);
    const openHour = clamp(int(raw.OPEN_HOUR, 7), 0, 22);
    return {
      openHour: openHour,
      closeHour: clamp(int(raw.CLOSE_HOUR, 18), openHour + 1, 23),
      maxDaysAhead: clamp(int(raw.MAX_DAYS_AHEAD, 180), 1, 730),
      noticeDays: clamp(int(raw.NOTICE_DAYS, 3), 1, 30),
      morningHour: clamp(int(raw.MORNING_HOUR, 7), 0, 23),
      botLang: ['en', 'km', 'both'].indexOf(raw.BOT_LANG) >= 0 ? raw.BOT_LANG : 'both',
      remindDays: clamp(int(raw.REMIND_DAYS, 7), 1, 31),
    };
  }

  /**
   * Check a booking request against every rule.
   * ctx: { halls, holidays (date -> {en, km}), bookings, settings, now: {date, minutes} }
   * Returns { ok, reasons, req }. Each broken rule adds one reason, so the
   * person sees every problem at once. Back-to-back bookings (09-10, 10-11) are fine.
   */
  function checkBooking(input, ctx) {
    input = input || {};
    const req = {
      hall: String(input.hall || ''),
      date: String(input.date || ''),
      start: String(input.start || ''),
      end: String(input.end || ''),
      name: cleanText(input.name),
      department: cleanText(input.department),
    };
    const reasons = [];
    if (!ctx.halls.some(h => h.id === req.hall && h.active)) reasons.push({ code: 'BAD_HALL' });
    if (!req.name) reasons.push({ code: 'MISSING', field: 'name' });
    if (!req.department) reasons.push({ code: 'MISSING', field: 'department' });
    const dateOk = parseDate(req.date) !== null;
    const timeOk = HOUR_RE.test(req.start) && HOUR_RE.test(req.end);
    if (!dateOk) reasons.push({ code: 'BAD_DATE' });
    if (!timeOk) reasons.push({ code: 'BAD_TIME' });
    if (!dateOk || !timeOk) return { ok: false, reasons: reasons, req: req };

    const s = toMinutes(req.start), e = toMinutes(req.end), st = ctx.settings;
    const rangeOk = e > s;
    if (!rangeOk) {
      reasons.push({ code: 'END_BEFORE_START' });
    } else if (s < st.openHour * 60 || e > st.closeHour * 60) {
      reasons.push({ code: 'OUTSIDE_HOURS', open: hourStr(st.openHour), close: hourStr(st.closeHour) });
    }

    const ahead = daysBetween(ctx.now.date, req.date);
    if (ahead < 0 || (ahead === 0 && s < ctx.now.minutes)) reasons.push({ code: 'PAST' });
    else if (ahead > st.maxDaysAhead) reasons.push({ code: 'TOO_FAR', days: st.maxDaysAhead });

    const hol = ctx.holidays[req.date];
    if (hol) reasons.push({ code: 'HOLIDAY', en: hol.en, km: hol.km });

    if (rangeOk) {
      ctx.bookings
        .filter(b => b.status === 'active' && b.hall === req.hall && b.date === req.date &&
          s < toMinutes(b.end) && toMinutes(b.start) < e)
        .sort(byStart)
        .forEach(b => reasons.push({ code: 'CLASH', start: b.start, end: b.end, department: b.department, name: b.name }));
    }
    return { ok: reasons.length === 0, reasons: reasons, req: req };
  }

  /** Only the person who booked can cancel, and only before the booking starts. */
  function checkCancel(booking, userId, now) {
    if (!booking) return [{ code: 'NOT_FOUND' }];
    if (String(booking.tg_user_id) !== String(userId)) return [{ code: 'NOT_OWNER' }];
    if (booking.status !== 'active') return [{ code: 'ALREADY_CANCELLED' }];
    const ahead = daysBetween(now.date, booking.date);
    if (ahead < 0 || (ahead === 0 && toMinutes(booking.start) <= now.minutes)) return [{ code: 'STARTED' }];
    return [];
  }

  // ---------------------------------------------------------------- holidays

  const unescapeIcs = s => s.replace(/\\([\\;,nN])/g, (m, c) => (c === 'n' || c === 'N' ? ' ' : c));

  /**
   * iCalendar text (Google's public holiday feed) -> [{date, en}].
   * Skips events marked "Observance" (not a day off). Expands multi-day events.
   */
  function parseIcsHolidays(text) {
    const raw = String(text).replace(/\r\n?/g, '\n').replace(/\n[ \t]/g, '');
    const out = [];
    raw.split('BEGIN:VEVENT').slice(1).forEach(chunk => {
      const body = chunk.split('END:VEVENT')[0];
      const field = key => {
        const m = body.match(new RegExp('^' + key + '(?:;[^:\\n]*)?:(.*)$', 'm'));
        return m ? m[1].trim() : '';
      };
      if (/^observance/i.test(field('DESCRIPTION'))) return;
      const ymd = v => (/^\d{8}/.test(v) ? v.slice(0, 4) + '-' + v.slice(4, 6) + '-' + v.slice(6, 8) : null);
      const start = ymd(field('DTSTART'));
      if (!start || parseDate(start) === null) return;
      let end = ymd(field('DTEND'));
      if (!end || parseDate(end) === null || end <= start) end = addDays(start, 1);
      const name = unescapeIcs(field('SUMMARY')) || 'Holiday';
      for (let d = start, i = 0; d < end && i < 31; d = addDays(d, 1), i++) out.push({ date: d, en: name });
    });
    return out;
  }

  /** Khmer names for holidays that Nager.Date does not list (Google gives English only). */
  const KM_FALLBACK = {
    'Visak Bochea Day': 'ពិធីបុណ្យវិសាខបូជា',
  };

  /** Nager.Date JSON -> [{date, en, km}]. */
  function parseNager(list) {
    if (!Array.isArray(list)) return [];
    return list
      .filter(h => h && parseDate(h.date) !== null)
      .map(h => ({ date: h.date, en: String(h.name || ''), km: String(h.localName || '') }));
  }

  /**
   * Build the new Holidays tab.
   * - Dates come from both feeds (a day is a holiday if either feed says so).
   * - English names from Google, Khmer names from Nager (matched by date).
   * - Rows whose source is not "auto" are the admin's own rows: kept as they are.
   * - An auto row keeps its "enabled" value, so the admin can switch a day off.
   * - An auto row keeps a Khmer name the admin typed, when the feeds have none.
   * - complete=false (a feed failed): no auto row is removed.
   * Only dates in [fromDate, toDate] are written for auto rows.
   */
  function mergeHolidays(existing, google, nager, complete, fromDate, toDate) {
    const auto = {};
    const slot = d => auto[d] || (auto[d] = { en: [], km: [] });
    const addUnique = (arr, v) => { if (v && arr.indexOf(v) < 0) arr.push(v); };
    const googleDates = {};
    google.forEach(h => { googleDates[h.date] = true; addUnique(slot(h.date).en, h.en); });
    nager.forEach(h => {
      const s = slot(h.date);
      if (!googleDates[h.date]) addUnique(s.en, h.en);
      addUnique(s.km, h.km);
    });
    google.forEach(h => addUnique(auto[h.date].km, KM_FALLBACK[h.en]));

    const prev = {};
    existing.filter(r => r.source === 'auto').forEach(r => { prev[r.date] = r; });
    const rows = existing.filter(r => r.source !== 'auto' && (r.date || r.name_en || r.name_km));
    Object.keys(auto).forEach(d => {
      if (d < fromDate || d > toDate) return;
      rows.push({
        date: d,
        name_en: auto[d].en.join(' / '),
        name_km: auto[d].km.join(' / ') || (prev[d] ? prev[d].name_km : ''),
        source: 'auto',
        enabled: prev[d] && !isOn(prev[d].enabled) ? 'FALSE' : 'TRUE',
      });
    });
    if (!complete) Object.keys(prev).forEach(d => { if (!rows.some(r => r.source === 'auto' && r.date === d)) rows.push(prev[d]); });
    rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return rows;
  }

  /** Holidays tab rows -> { date: {en, km} } for enabled rows only. */
  function holidayMap(rows) {
    const acc = {};
    rows.forEach(r => {
      if (!isOn(r.enabled) || parseDate(r.date) === null) return;
      const m = acc[r.date] || (acc[r.date] = { en: [], km: [] });
      if (r.name_en) m.en.push(r.name_en);
      if (r.name_km) m.km.push(r.name_km);
    });
    const map = {};
    Object.keys(acc).forEach(d => {
      const en = acc[d].en.join(' / '), km = acc[d].km.join(' / ');
      map[d] = { en: en || km || 'Holiday', km: km || en || 'ថ្ងៃឈប់សម្រាក' };
    });
    return map;
  }

  // ------------------------------------------------------------ bot messages

  const BOT_TEXT = {
    en: {
      newBooking: 'New booking',
      cancelled: 'Booking cancelled',
      today: 'Halls to prepare today',
      ahead: 'Bookings in {n} days',
      week: 'Bookings for the next {n} days',
      holiday: 'Holiday',
      none: '—',
      days: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
      months: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
    },
    km: {
      newBooking: 'ការកក់ថ្មី',
      cancelled: 'ការកក់ត្រូវបានលុបចោល',
      today: 'សាលត្រូវរៀបចំថ្ងៃនេះ',
      ahead: 'ការកក់ {n} ថ្ងៃទៀត',
      week: 'ការកក់ {n} ថ្ងៃខាងមុខ',
      holiday: 'ថ្ងៃឈប់សម្រាក',
      none: '—',
      days: ['អាទិត្យ', 'ច័ន្ទ', 'អង្គារ', 'ពុធ', 'ព្រហស្បតិ៍', 'សុក្រ', 'សៅរ៍'],
      months: ['មករា', 'កុម្ភៈ', 'មីនា', 'មេសា', 'ឧសភា', 'មិថុនា', 'កក្កដា', 'សីហា', 'កញ្ញា', 'តុលា', 'វិច្ឆិកា', 'ធ្នូ'],
    },
  };

  /** Telegram parse_mode=HTML needs only &, < and > escaped. */
  const escapeHtml = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  /** lang 'both' -> "khmer / english" (once if both are the same). */
  function inLang(lang, fn) {
    if (lang !== 'both') return fn(BOT_TEXT[lang] ? lang : 'en');
    const km = fn('km'), en = fn('en');
    return km === en ? en : km + ' / ' + en;
  }
  const label = (key, lang, n) => inLang(lang, l => BOT_TEXT[l][key].replace('{n}', n));
  const dateLabel = (s, lang) => inLang(lang, l => {
    const T = BOT_TEXT[l], dt = new Date(parseDate(s));
    return T.days[dt.getUTCDay()] + ' ' + dt.getUTCDate() + ' ' + T.months[dt.getUTCMonth()] + ' ' + dt.getUTCFullYear();
  });
  const hallLabel = (hall, lang) => inLang(lang, l => (hall && (hall['name_' + l] || hall.name_en || hall.id)) || '?');
  const holidayLabel = (h, lang) => inLang(lang, l => h[l] || h.en);

  /** kind: 'newBooking' | 'cancelled'. Returns Telegram HTML. */
  function bookingMessage(kind, b, hall, lang) {
    return [
      '<b>' + escapeHtml(label(kind, lang)) + '</b>',
      escapeHtml(hallLabel(hall, lang)),
      escapeHtml(dateLabel(b.date, lang) + ', ' + b.start + '–' + b.end),
      escapeHtml(b.department + ' (' + b.name + ')'),
    ].join('\n');
  }

  /** Morning post: today's halls for the cleaners, then bookings noticeDays ahead. */
  function dailyDigest(o) {
    const section = (date, title) => {
      const lines = ['<b>' + escapeHtml(title) + '</b>', escapeHtml(dateLabel(date, o.lang))];
      const hol = o.holidays[date];
      if (hol) lines.push(escapeHtml(label('holiday', o.lang) + ': ' + holidayLabel(hol, o.lang)));
      o.halls.forEach(h => {
        const list = o.bookings
          .filter(b => b.status === 'active' && b.hall === h.id && b.date === date)
          .sort(byStart);
        const name = '<b>' + escapeHtml(hallLabel(h, o.lang)) + '</b>';
        if (!list.length) { lines.push(name + ': ' + escapeHtml(label('none', o.lang))); return; }
        lines.push(name);
        list.forEach(b => lines.push('• ' + escapeHtml(b.start + '–' + b.end + ' ' + b.department + ' (' + b.name + ')')));
      });
      return lines.join('\n');
    };
    return section(o.today, label('today', o.lang)) + '\n\n' +
      section(addDays(o.today, o.noticeDays), label('ahead', o.lang, o.noticeDays));
  }

  /** Telegram allows 4096 characters; stay below it so the message is never refused. */
  const MAX_MESSAGE = 3900;

  /**
   * /remind answer: each day from today for o.days days (today included),
   * bookings sorted by start time, holidays marked. Cut at a day boundary
   * with '…' if it would be too long for one Telegram message.
   */
  function weekReport(o) {
    const hallOf = id => o.halls.filter(h => h.id === id)[0] || { id: id };
    const order = id => { const i = o.halls.findIndex(h => h.id === id); return i < 0 ? 99 : i; };
    const blocks = ['<b>' + escapeHtml(label('week', o.lang, o.days)) + '</b>'];
    let size = blocks[0].length;
    for (let i = 0; i < o.days; i++) {
      const date = addDays(o.today, i);
      const hol = o.holidays[date];
      const list = o.bookings
        .filter(b => b.status === 'active' && b.date === date)
        .sort((a, b) => toMinutes(a.start) - toMinutes(b.start) || order(a.hall) - order(b.hall));
      const lines = ['<b>' + escapeHtml(dateLabel(date, o.lang)) + '</b>' + (list.length ? '' : ': ' + escapeHtml(label('none', o.lang)))];
      if (hol) lines.push(escapeHtml(label('holiday', o.lang) + ': ' + holidayLabel(hol, o.lang)));
      list.forEach(b => lines.push('• ' + escapeHtml(hallLabel(hallOf(b.hall), o.lang) + ' ' + b.start + '–' + b.end + ' ' + b.department + ' (' + b.name + ')')));
      const block = lines.join('\n');
      if (size + block.length + 2 > MAX_MESSAGE) { blocks.push('…'); break; }
      blocks.push(block);
      size += block.length + 2;
    }
    return blocks.join('\n\n');
  }

  /**
   * Bot command name from a message: "/remind" or "/remind@MyBot ..." -> "remind".
   * A command addressed to another bot (or to any bot when ours is unknown) -> null.
   */
  function parseCommand(text, botUsername) {
    const m = /^\/([A-Za-z0-9_]{1,32})(?:@([A-Za-z0-9_]{3,64}))?(?:\s|$)/.exec(String(text || '').trim());
    if (!m) return null;
    if (m[2] && (!botUsername || m[2].toLowerCase() !== String(botUsername).toLowerCase())) return null;
    return m[1].toLowerCase();
  }

  // -------------------------------------------------------------------- auth

  /** Byte array (signed, as Apps Script returns, or unsigned) -> lowercase hex. */
  function toHex(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += ((bytes[i] & 0xff) + 0x100).toString(16).slice(1);
    return s;
  }
  function safeEqual(a, b) {
    if (a.length !== b.length) return false;
    let r = 0;
    for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
    return r === 0;
  }
  /** Query string -> object, decoded the way URLSearchParams does ('+' is a space). */
  function parseQuery(q) {
    const out = {};
    q.split('&').forEach(part => {
      if (!part) return;
      const i = part.indexOf('=');
      const k = i < 0 ? part : part.slice(0, i);
      const v = i < 0 ? '' : part.slice(i + 1);
      out[decodeURIComponent(k.replace(/\+/g, ' '))] = decodeURIComponent(v.replace(/\+/g, ' '));
    });
    return out;
  }

  /**
   * Check Telegram Mini App initData (core.telegram.org/bots/webapps, "Validating data").
   *   secret = HMAC_SHA256(key "WebAppData", msg botToken)
   *   hash   = hex(HMAC_SHA256(key secret, msg data_check_string))
   * hmac(key, msg) -> byte array; key is a string or a byte array, msg is a string.
   * Returns { user } or null.
   */
  function verifyInitData(initData, botToken, hmac, nowSec, maxAgeSec) {
    if (typeof initData !== 'string' || !initData || !botToken) return null;
    let params;
    try { params = parseQuery(initData); } catch (e) { return null; }
    const hash = params.hash;
    if (!/^[0-9a-f]{64}$/.test(hash || '')) return null;
    delete params.hash;
    const dataCheck = Object.keys(params).sort().map(k => k + '=' + params[k]).join('\n');
    const calc = toHex(hmac(hmac('WebAppData', botToken), dataCheck));
    if (!safeEqual(calc, hash)) return null;
    const authDate = Number(params.auth_date);
    if (!authDate || nowSec - authDate > maxAgeSec || authDate - nowSec > 300) return null;
    let user;
    try { user = JSON.parse(params.user); } catch (e) { return null; }
    if (!user || typeof user.id !== 'number') return null;
    return { user: user };
  }

  return {
    parseDate: parseDate,
    addDays: addDays,
    daysBetween: daysBetween,
    isOn: isOn,
    cleanText: cleanText,
    normalizeSettings: normalizeSettings,
    checkBooking: checkBooking,
    checkCancel: checkCancel,
    byDateStart: byDateStart,
    parseIcsHolidays: parseIcsHolidays,
    parseNager: parseNager,
    mergeHolidays: mergeHolidays,
    holidayMap: holidayMap,
    escapeHtml: escapeHtml,
    bookingMessage: bookingMessage,
    dailyDigest: dailyDigest,
    weekReport: weekReport,
    parseCommand: parseCommand,
    toHex: toHex,
    verifyInitData: verifyInitData,
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = Core;
