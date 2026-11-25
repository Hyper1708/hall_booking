/**
 * Timed jobs, one-time setup, and the "Hall booking" menu in the sheet.
 */
const GOOGLE_KH_ICS = 'https://calendar.google.com/calendar/ical/en.kh%23holiday%40group.v.calendar.google.com/public/basic.ics';
const NAGER_KH = year => 'https://date.nager.at/api/v3/PublicHolidays/' + year + '/KH';

const DEFAULT_HALLS = [
  ['H1', 'Hall 1', 'សាល ១', 'TRUE'],
  ['H2', 'Hall 2', 'សាល ២', 'TRUE'],
  ['H3', 'Hall 3', 'សាល ៣', 'TRUE'],
];
const DEFAULT_SETTINGS = [
  ['OPEN_HOUR', '7'],
  ['CLOSE_HOUR', '18'],
  ['MAX_DAYS_AHEAD', '180'],
  ['NOTICE_DAYS', '3'],
  ['MORNING_HOUR', '7'],
  ['BOT_LANG', 'both'],
];

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Hall booking')
    .addItem('Set up sheets and timers', 'setup')
    .addItem('Find group chat ID', 'findGroupId')
    .addItem('Sync holidays now', 'syncHolidays')
    .addItem("Post today's list now", 'dailyDigest')
    .addToUi();
}

/** Morning post (timer): today's halls for cleaners + bookings NOTICE_DAYS ahead. */
function dailyDigest() {
  const db = loadAll_();
  notify_(Core.dailyDigest({
    today: now_().date,
    noticeDays: db.settings.noticeDays,
    halls: db.halls.filter(h => h.active),
    bookings: db.bookings,
    holidays: db.holidays,
    lang: db.settings.botLang,
  }));
}

function fetchText_(url) {
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
  if (res.getResponseCode() !== 200) throw new Error('HTTP ' + res.getResponseCode());
  return res.getContentText('UTF-8');
}

/**
 * Weekly timer: refresh Cambodian public holidays for this year and next.
 * If a feed fails, existing rows stay. Runs under the script lock so a
 * booking never reads a half-written Holidays tab.
 */
function syncHolidays() {
  const year = Number(now_().date.slice(0, 4));
  let google = [], nager = [], complete = true;
  try {
    google = Core.parseIcsHolidays(fetchText_(GOOGLE_KH_ICS));
    if (!google.length) complete = false;
  } catch (e) {
    complete = false;
    console.warn('Google holidays failed: ' + e);
  }
  [year, year + 1].forEach(y => {
    try {
      nager = nager.concat(Core.parseNager(JSON.parse(fetchText_(NAGER_KH(y)))));
    } catch (e) {
      complete = false;
      console.warn('Nager ' + y + ' failed: ' + e);
    }
  });
  if (!google.length && !nager.length) {
    console.warn('No holiday data fetched. Holidays tab unchanged.');
    return;
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const rows = Core.mergeHolidays(readRows_('Holidays'), google, nager, complete, year + '-01-01', (year + 1) + '-12-31');
    writeHolidays_(rows);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }
  console.log('Holidays synced: ' + google.length + ' Google, ' + nager.length + ' Nager, complete=' + complete);
}

/** Run once from the sheet menu (or the editor). Safe to run again. */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  PropertiesService.getScriptProperties().setProperty('SPREADSHEET_ID', ss.getId());
  Object.keys(SHEETS).forEach(name => ensureSheet_(ss, name, SHEETS[name]));
  seed_(ss.getSheetByName('Halls'), DEFAULT_HALLS);
  seed_(ss.getSheetByName('Settings'), DEFAULT_SETTINGS);
  installTriggers_();
  syncHolidays();
  const missing = ['BOT_TOKEN', 'GROUP_CHAT_ID'].filter(k => !prop_(k));
  say_(missing.length
    ? 'Sheets and timers are ready. Still missing in Script Properties: ' + missing.join(', ')
    : 'Setup done.');
}

function ensureSheet_(ss, name, columns) {
  const sh = ss.getSheetByName(name) || ss.insertSheet(name);
  if (sh.getMaxColumns() < columns.length) sh.insertColumnsAfter(sh.getMaxColumns(), columns.length - sh.getMaxColumns());
  if (sh.getMaxRows() < 100) sh.insertRowsAfter(sh.getMaxRows(), 100 - sh.getMaxRows());
  sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).setNumberFormat('@');
  if (!sh.getRange(1, 1).getDisplayValue()) {
    sh.getRange(1, 1, 1, columns.length).setValues([columns]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  const flagCol = columns.indexOf(name === 'Holidays' ? 'enabled' : 'active');
  if (flagCol >= 0) {
    const rule = SpreadsheetApp.newDataValidation().requireValueInList(['TRUE', 'FALSE'], true).build();
    sh.getRange(2, flagCol + 1, sh.getMaxRows() - 1, 1).setDataValidation(rule);
  }
}

function seed_(sh, rows) {
  if (sh.getLastRow() > 1) return;
  sh.getRange(2, 1, rows.length, rows[0].length).setValues(rows);
}

function installTriggers_() {
  const morningHour = loadAll_().settings.morningHour;
  ScriptApp.getProjectTriggers().forEach(t => {
    if (['dailyDigest', 'syncHolidays'].indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('dailyDigest').timeBased().everyDays(1).atHour(morningHour).inTimezone(TZ).create();
  ScriptApp.newTrigger('syncHolidays').timeBased().everyWeeks(1).onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(3).inTimezone(TZ).create();
}

/** Lists the groups the bot has seen, so you can copy GROUP_CHAT_ID. */
function findGroupId() {
  const res = tg_('getUpdates', {});
  const chats = {};
  ((res && res.result) || []).forEach(u => {
    const c = (u.message && u.message.chat) || (u.my_chat_member && u.my_chat_member.chat);
    if (c && (c.type === 'group' || c.type === 'supergroup')) chats[c.id] = c.title;
  });
  const ids = Object.keys(chats);
  say_(ids.length
    ? 'Groups seen by the bot:\n' + ids.map(id => id + '   ' + chats[id]).join('\n') +
      '\n\nCopy the ID (with the minus sign) into Script Properties as GROUP_CHAT_ID.'
    : 'No group found yet. Add the bot to the group, send /start@YourBotName in the group, then run this again.');
}

function say_(msg) {
  try { SpreadsheetApp.getUi().alert(msg); } catch (e) { console.log(msg); }
}
