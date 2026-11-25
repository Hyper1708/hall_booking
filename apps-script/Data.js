/**
 * Google Sheet access. Every cell is stored as plain text ('@' format), so
 * Sheets never turns '2026-12-03' or '09:00' into a date or a time.
 * Columns are found by header name, so the admin can reorder them.
 */
const SHEETS = {
  Bookings: ['id', 'hall', 'date', 'start', 'end', 'name', 'department', 'tg_user_id', 'status', 'created_at', 'cancelled_at'],
  Halls: ['id', 'name_en', 'name_km', 'active'],
  Holidays: ['date', 'name_en', 'name_km', 'source', 'enabled'],
  Settings: ['key', 'value'],
};

function prop_(key) {
  return PropertiesService.getScriptProperties().getProperty(key);
}

function ss_() {
  const id = prop_('SPREADSHEET_ID');
  return id ? SpreadsheetApp.openById(id) : SpreadsheetApp.getActiveSpreadsheet();
}

function sheet_(name) {
  const sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('Missing sheet "' + name + '". Run setup() first.');
  return sh;
}

function header_(sh) {
  return sh.getRange(1, 1, 1, Math.max(sh.getLastColumn(), 1)).getDisplayValues()[0].map(h => h.trim());
}

/** Sheet -> array of objects keyed by header. Adds _row (1-based sheet row). */
function readRows_(name) {
  const values = sheet_(name).getDataRange().getDisplayValues();
  const head = values[0].map(h => h.trim());
  SHEETS[name].forEach(col => {
    if (head.indexOf(col) < 0) throw new Error('Sheet "' + name + '" has no column "' + col + '".');
  });
  return values.slice(1).map((row, i) => {
    const o = { _row: i + 2 };
    head.forEach((h, j) => { if (h) o[h] = String(row[j]).trim(); });
    return o;
  });
}

/** The Settings tab only (cheaper than loadAll_). */
function settings_() {
  const raw = {};
  readRows_('Settings').forEach(r => { if (r.key) raw[r.key] = r.value; });
  return Core.normalizeSettings(raw);
}

/** Everything a request needs, read once. */
function loadAll_() {
  return {
    settings: settings_(),
    halls: readRows_('Halls')
      .filter(h => h.id)
      .map(h => ({ id: h.id, name_en: h.name_en, name_km: h.name_km, active: Core.isOn(h.active) })),
    holidays: Core.holidayMap(readRows_('Holidays')),
    bookings: readRows_('Bookings').filter(b => b.id),
  };
}

/** getRange past the sheet's last row throws, so grow the sheet first. */
function ensureRows_(sh, lastRowNeeded) {
  const max = sh.getMaxRows();
  if (lastRowNeeded > max) sh.insertRowsAfter(max, lastRowNeeded - max + 100);
}

function appendBooking_(b) {
  const sh = sheet_('Bookings');
  const row = header_(sh).map(h => (b[h] == null ? '' : String(b[h])));
  const at = sh.getLastRow() + 1;
  ensureRows_(sh, at);
  sh.getRange(at, 1, 1, row.length).setNumberFormat('@').setValues([row]);
}

/** Write some fields of one booking row (row number from readRows_). */
function updateBooking_(rowNum, fields) {
  const sh = sheet_('Bookings');
  const head = header_(sh);
  Object.keys(fields).forEach(k => {
    const col = head.indexOf(k);
    if (col >= 0) sh.getRange(rowNum, col + 1).setNumberFormat('@').setValue(String(fields[k]));
  });
}

/** Replace all Holidays rows. */
function writeHolidays_(rows) {
  const sh = sheet_('Holidays');
  const head = header_(sh);
  const last = sh.getLastRow();
  if (last > 1) sh.getRange(2, 1, last - 1, head.length).clearContent();
  if (!rows.length) return;
  const values = rows.map(r => head.map(h => (r[h] == null ? '' : String(r[h]))));
  ensureRows_(sh, values.length + 1);
  sh.getRange(2, 1, values.length, head.length).setNumberFormat('@').setValues(values);
}

function hallById_(halls, id) {
  return halls.filter(h => h.id === id)[0] || { id: id, name_en: id, name_km: id };
}
