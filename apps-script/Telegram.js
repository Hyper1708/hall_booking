/**
 * Telegram Bot API calls. The bot only sends; it needs no webhook.
 * BOT_TOKEN and GROUP_CHAT_ID live in Script Properties, never in code.
 */
function tg_(method, payload) {
  const token = prop_('BOT_TOKEN');
  if (!token) throw new Error('BOT_TOKEN is not set in Script Properties.');
  const res = UrlFetchApp.fetch('https://api.telegram.org/bot' + token + '/' + method, {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload || {}),
    muteHttpExceptions: true,
  });
  let data = null;
  try { data = JSON.parse(res.getContentText()); } catch (e) { /* not JSON: leave null */ }
  if (!data || !data.ok) {
    // Never log the URL: it contains the token.
    console.warn('Telegram ' + method + ' failed: HTTP ' + res.getResponseCode() + ' ' + ((data && data.description) || ''));
  }
  return data;
}

/** Post to the group. A Telegram failure is logged, never thrown: the booking itself already succeeded. */
function notify_(html) {
  try {
    tg_('sendMessage', {
      chat_id: prop_('GROUP_CHAT_ID'),
      text: html,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
  } catch (e) {
    console.error('notify failed: ' + e);
  }
}

/** True if the Telegram user is in the group. Cached 10 minutes; Telegram errors are not cached. */
function isGroupMember_(userId) {
  const cache = CacheService.getScriptCache();
  const key = 'member:' + userId;
  const hit = cache.get(key);
  if (hit) return hit === '1';
  const res = tg_('getChatMember', { chat_id: prop_('GROUP_CHAT_ID'), user_id: userId });
  if (!res || !res.ok) return false;
  const st = res.result.status;
  const ok = st === 'creator' || st === 'administrator' || st === 'member' || (st === 'restricted' && res.result.is_member === true);
  cache.put(key, ok ? '1' : '0', 600);
  return ok;
}
