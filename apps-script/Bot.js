/**
 * Bot commands (/remind). Telegram sends group messages that start with "/"
 * to the web app (a webhook); doPost in Code.js passes them here.
 *
 * Safety:
 * - The webhook URL carries a secret (HOOK_SECRET). Requests without it are ignored,
 *   so nobody can post fake commands to the public web app URL.
 * - Only the hall booking group (GROUP_CHAT_ID) gets an answer.
 * - Telegram may send the same update twice; each update_id is handled once.
 */
const WEBAPP_URL_RE = /^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/;

function handleWebhook_(e, update) {
  const secret = prop_('HOOK_SECRET');
  if (!secret || !e || !e.parameter || e.parameter.hook !== secret) return;

  const cache = CacheService.getScriptCache();
  const seen = 'update:' + update.update_id;
  if (cache.get(seen)) return;
  cache.put(seen, '1', 21600);

  const msg = update.message;
  if (!msg || typeof msg.text !== 'string' || !msg.chat) return;
  if (String(msg.chat.id) !== String(prop_('GROUP_CHAT_ID'))) return;
  if (Core.parseCommand(msg.text, prop_('BOT_USERNAME')) === 'remind') sendWeekReport_(msg.message_id);
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

/** Menu: Turn on /remind. Asks for the web app URL, then connects Telegram to it. */
function connectBot() {
  const ui = SpreadsheetApp.getUi();
  const asked = ui.prompt('Turn on /remind',
    'Paste the web app URL (the same one as in config.js, ending in /exec):', ui.ButtonSet.OK_CANCEL);
  if (asked.getSelectedButton() !== ui.Button.OK) return;
  const url = asked.getResponseText().trim();
  if (!WEBAPP_URL_RE.test(url)) {
    ui.alert('That is not a web app URL. It starts with https://script.google.com/macros/s/ and ends with /exec.');
    return;
  }
  if (!prop_('GROUP_CHAT_ID')) { ui.alert('Set GROUP_CHAT_ID in Script Properties first.'); return; }

  const props = PropertiesService.getScriptProperties();
  let secret = props.getProperty('HOOK_SECRET');
  if (!secret) {
    secret = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
    props.setProperty('HOOK_SECRET', secret);
  }
  const me = tg_('getMe', {});
  if (!me || !me.ok) { ui.alert('Telegram did not answer. Check BOT_TOKEN in Script Properties.'); return; }
  props.setProperty('BOT_USERNAME', me.result.username);

  const hook = tg_('setWebhook', {
    url: url + '?hook=' + secret,
    allowed_updates: ['message'],
    drop_pending_updates: true,
  });
  if (!hook || !hook.ok) {
    ui.alert('Telegram did not accept the web app URL: ' + ((hook && hook.description) || 'no answer'));
    return;
  }
  addMissingSettings_();
  const days = loadAll_().settings.remindDays;
  tg_('setMyCommands', { commands: [{ command: 'remind', description: 'Bookings for the next ' + days + ' days' }] });
  tg_('setMyCommands', { commands: [{ command: 'remind', description: 'ការកក់ ' + days + ' ថ្ងៃខាងមុខ' }], language_code: 'km' });
  ui.alert('/remind is on.\n\nIn the group, send /remind or /remind@' + me.result.username +
    '\n\nIf the bot does not answer, use "Check /remind".');
}

/** Menu: Check /remind. Shows Telegram's own report on the webhook. Never shows the secret URL. */
function checkBot() {
  const info = tg_('getWebhookInfo', {});
  if (!info || !info.ok) { say_('Telegram did not answer. Check BOT_TOKEN in Script Properties.'); return; }
  const r = info.result;
  const lines = [
    r.url ? '/remind is ON.' : '/remind is OFF. Use "Turn on /remind".',
    'Messages waiting at Telegram: ' + (r.pending_update_count || 0),
  ];
  if (r.last_error_date) {
    lines.push('Last error: ' + r.last_error_message + ' (' + new Date(r.last_error_date * 1000).toLocaleString() + ')');
  } else if (r.url) {
    lines.push('No errors.');
  }
  say_(lines.join('\n'));
}

/** Menu: Turn off /remind. The app, bookings and morning posts keep working. */
function disconnectBot() {
  const res = tg_('deleteWebhook', { drop_pending_updates: true });
  say_(res && res.ok ? '/remind is off.' : 'Telegram did not answer. Try again.');
}
