/**
 * Bot commands (/remind), checked once a minute by a timer (pollBot).
 *
 * Why a timer and not a Telegram webhook: Apps Script answers every web app
 * request with a 302 redirect, which Telegram counts as a failed delivery.
 * Asking Telegram for new messages (getUpdates) avoids that, needs no public
 * entry point, and runs the saved code without a new deployment.
 * The cost: an answer can take up to about a minute.
 *
 * Safety: only the hall booking group (GROUP_CHAT_ID) gets an answer, and
 * each update is handled once (UPDATE_OFFSET moves past it before handling).
 */
const POLL_HANDLER = 'pollBot';

/** Timer, every minute: fetch new messages and answer /remind. */
function pollBot() {
  const cache = CacheService.getScriptCache();
  if (cache.get('polling')) return;          // the previous run is still busy
  cache.put('polling', '1', 50);
  try {
    const props = PropertiesService.getScriptProperties();
    const offset = Number(props.getProperty('UPDATE_OFFSET') || 0);
    const res = tg_('getUpdates', { offset: offset, timeout: 0, allowed_updates: ['message'] });
    props.setProperty('LAST_POLL', new Date().toISOString());
    if (!res || !res.ok) {
      props.setProperty('LAST_POLL_ERROR', (res && res.description) || 'no answer from Telegram');
      return;
    }
    props.deleteProperty('LAST_POLL_ERROR');
    if (!res.result.length) return;
    const keywords = settings_().remindWords;
    res.result.forEach(update => {
      // Move past this update first, so a failing one is never handled again and again.
      props.setProperty('UPDATE_OFFSET', String(update.update_id + 1));
      try { handleUpdate_(update, keywords); } catch (e) { console.error(e && e.stack ? e.stack : String(e)); }
    });
  } finally {
    cache.remove('polling');
  }
}

/**
 * Answer /remind, or a message that is exactly a keyword (REMIND_WORDS), in the group.
 * Everything else is ignored. Keywords reach the bot only if it is a group admin
 * (otherwise Telegram sends a bot only the messages that start with "/").
 */
function handleUpdate_(update, keywords) {
  const msg = update.message;
  if (!msg || typeof msg.text !== 'string' || !msg.chat) return;
  if (String(msg.chat.id) !== String(prop_('GROUP_CHAT_ID'))) return;
  if (Core.isRemindRequest(msg.text, prop_('BOT_USERNAME'), keywords)) sendWeekReport_(msg.message_id);
}

/** Post the next REMIND_DAYS days of bookings to the group, as a reply when replyTo is given. */
function sendWeekReport_(replyTo) {
  const db = loadAll_();
  const payload = {
    chat_id: prop_('GROUP_CHAT_ID'),
    text: Core.weekReport({
      today: now_().date,
      days: db.settings.remindDays,
      halls: db.halls,
      bookings: db.bookings,
      holidays: db.holidays,
      lang: db.settings.botLang,
    }),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  if (replyTo) payload.reply_parameters = { message_id: replyTo, allow_sending_without_reply: true };
  tg_('sendMessage', payload);
}

function pollTriggers_() {
  return ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === POLL_HANDLER);
}

/** Menu: Turn on /remind. Safe to run again. */
function connectBot() {
  if (!prop_('GROUP_CHAT_ID')) { say_('Set GROUP_CHAT_ID in Script Properties first.'); return; }
  const me = tg_('getMe', {});
  if (!me || !me.ok) { say_('Telegram did not answer. Check BOT_TOKEN in Script Properties.'); return; }
  const props = PropertiesService.getScriptProperties();
  props.setProperty('BOT_USERNAME', me.result.username);

  // Remove an old webhook (it blocks getUpdates) and drop messages it left waiting.
  tg_('deleteWebhook', { drop_pending_updates: true });
  props.deleteProperty('HOOK_SECRET');
  props.deleteProperty('UPDATE_OFFSET');

  pollTriggers_().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger(POLL_HANDLER).timeBased().everyMinutes(1).create();

  addMissingSettings_();
  const days = loadAll_().settings.remindDays;
  tg_('setMyCommands', { commands: [{ command: 'remind', description: 'Bookings for the next ' + days + ' days' }] });
  tg_('setMyCommands', { commands: [{ command: 'remind', description: 'ការកក់ ' + days + ' ថ្ងៃខាងមុខ' }], language_code: 'km' });
  const words = settings_().remindWords;
  say_('/remind is on.\n\nIn the group, send /remind' +
    (words.length ? ' or just: ' + words.join(' / ') + '\n(For words without "/", make the bot a group admin.)' : '') +
    '\n\nThe bot checks once a minute, so the answer can take up to about a minute.');
}

/** Menu: Check /remind. */
function checkBot() {
  const on = pollTriggers_().length > 0;
  const last = prop_('LAST_POLL');
  const err = prop_('LAST_POLL_ERROR');
  const lines = [on ? '/remind is ON (checks every minute).' : '/remind is OFF. Use "Turn on /remind".'];
  if (on) lines.push('Last check: ' + (last ? new Date(last).toLocaleString() : 'not yet, wait a minute'));
  if (err) lines.push('Last error: ' + err);
  else if (on && last) lines.push('No errors.');
  const info = tg_('getWebhookInfo', {});
  if (info && info.ok && info.result.url) lines.push('Problem: an old webhook is still set. Click "Turn on /remind" again.');
  say_(lines.join('\n'));
}

/** Menu: Turn off /remind. The app, bookings and morning posts keep working. */
function disconnectBot() {
  pollTriggers_().forEach(t => ScriptApp.deleteTrigger(t));
  tg_('deleteWebhook', { drop_pending_updates: true });
  say_('/remind is off.');
}
