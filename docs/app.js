/* Hall booking mini app. Talks to the Apps Script API set in config.js.
 * The server re-checks every rule; this page only shows the result.
 * User text is always written with textContent, never innerHTML. */
(function () {
  'use strict';

  const I18N = window.I18N;
  const LANGS = Object.keys(I18N);
  const API = (window.APP_CONFIG && window.APP_CONFIG.apiUrl) || '';
  const tg = window.Telegram && window.Telegram.WebApp;
  const initData = (tg && tg.initData) || '';
  const tgUser = (tg && tg.initDataUnsafe && tg.initDataUnsafe.user) || null;
  const $ = id => document.getElementById(id);

  // Browser storage is a convenience only (language, last name/department); it may be blocked.
  const store = {
    get(k) { try { return window.localStorage.getItem('hb.' + k); } catch (e) { return null; } },
    set(k, v) { try { window.localStorage.setItem('hb.' + k, v); } catch (e) { /* ignore */ } },
  };

  const state = { lang: pickLang(), day: null, data: null, busy: false, result: null };

  // ------------------------------------------------------------- helpers

  function pickLang() {
    const saved = store.get('lang');
    if (saved && I18N[saved]) return saved;
    const code = String((tgUser && tgUser.language_code) || navigator.language || 'en').toLowerCase();
    return code.indexOf('km') === 0 && I18N.km ? 'km' : LANGS[0];
  }
  const nextLang = () => LANGS[(LANGS.indexOf(state.lang) + 1) % LANGS.length];

  function t(key, vars) {
    const dict = I18N[state.lang] || I18N.en;
    let s = dict[key] != null ? dict[key] : I18N.en[key] != null ? I18N.en[key] : key;
    if (vars && typeof s === 'string') {
      Object.keys(vars).forEach(k => { s = s.split('{' + k + '}').join(String(vars[k])); });
    }
    return s;
  }

  const pad2 = n => (n < 10 ? '0' : '') + n;
  const hourStr = h => pad2(h) + ':00';
  const hourOf = s => parseInt(String(s).slice(0, 2), 10);
  function parseYmd(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s || '');
    return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
  }
  function ymd(ms) {
    const d = new Date(ms);
    return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
  }
  const addDays = (s, n) => ymd(parseYmd(s) + n * 86400000);
  function fmtDate(s) {
    const ms = parseYmd(s);
    if (ms === null) return s;
    const d = new Date(ms);
    return t('days')[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + t('months')[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
  }
  const hallName = h => (h && (h['name_' + state.lang] || h.name_en || h.id)) || '?';
  const hallById = id => (state.data && state.data.halls.filter(h => h.id === id)[0]) || { id: id };

  function el(tag, props, kids) {
    const n = document.createElement(tag);
    Object.keys(props || {}).forEach(k => {
      const v = props[k];
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k.indexOf('on') === 0) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    });
    (kids || []).forEach(c => { if (c) n.appendChild(c); });
    return n;
  }

  function haptic(kind) {
    try { tg.HapticFeedback.notificationOccurred(kind); } catch (e) { /* not in Telegram */ }
  }

  function showNotice(text, kind) {
    const n = $('notice');
    n.textContent = text;
    n.className = 'notice ' + (kind || '');
    n.hidden = !text;
  }

  function confirmBox(msg) {
    return new Promise(resolve => {
      if (tg && tg.showConfirm) {
        try { tg.showConfirm(msg, ok => resolve(!!ok)); return; } catch (e) { /* old Telegram: fall back */ }
      }
      resolve(window.confirm(msg));
    });
  }

  async function api(action, payload) {
    try {
      const res = await fetch(API, {
        method: 'POST',
        // text/plain keeps this a "simple" request: no CORS preflight, which Apps Script cannot answer.
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(Object.assign({ action: action, initData: initData }, payload)),
      });
      return await res.json();
    } catch (e) {
      return { ok: false, error: 'NETWORK' };
    }
  }

  // ------------------------------------------------------------- rendering

  function render() {
    document.documentElement.lang = state.lang;
    document.title = t('title');
    document.querySelectorAll('[data-t]').forEach(n => { n.textContent = t(n.getAttribute('data-t')); });
    $('lang').textContent = I18N[nextLang()]._name;
    if (!state.data) return;
    $('day').value = state.day;
    $('dayLabel').textContent = fmtDate(state.day);
    renderHoliday();
    renderGrid();
    renderMine();
    if (!$('formbox').hidden) fillForm(false);
    renderResult();
  }

  function renderHoliday() {
    const h = state.data.holidays[state.day];
    $('holiday').hidden = !h;
    $('holiday').textContent = h ? t('holiday') + ': ' + (h[state.lang] || h.en) : '';
  }

  function isPastHour(h) {
    const now = state.data.now;
    return state.day < now.date || (state.day === now.date && h * 60 < now.minutes);
  }

  function renderGrid() {
    const d = state.data, grid = $('grid');
    grid.textContent = '';
    grid.appendChild(el('thead', null, [
      el('tr', null, [el('th', { text: t('time') })].concat(d.halls.map(h => el('th', { text: hallName(h) })))),
    ]));
    const body = el('tbody');
    const covered = {};
    const holiday = !!d.holidays[state.day];
    for (let h = d.settings.openHour; h < d.settings.closeHour; h++) {
      const row = el('tr', null, [el('th', { class: 'time', text: hourStr(h) })]);
      d.halls.forEach(hall => {
        if (covered[hall.id + '|' + h]) return;
        const b = d.bookings.filter(x => x.hall === hall.id && x.date === state.day &&
          hourOf(x.start) <= h && h < hourOf(x.end))[0];
        if (b) {
          const span = Math.max(1, Math.min(hourOf(b.end), d.settings.closeHour) - h);
          for (let k = 1; k < span; k++) covered[hall.id + '|' + (h + k)] = true;
          row.appendChild(el('td', { class: 'busy' + (b.mine ? ' mine' : ''), rowspan: String(span) }, [
            el('div', { class: 'who', text: b.department }),
            el('div', { class: 'sub', text: b.name }),
            el('div', { class: 'sub', text: b.start + '–' + b.end }),
          ]));
        } else if (holiday || isPastHour(h)) {
          row.appendChild(el('td', { class: 'closed' }));
        } else {
          const open = () => openForm(hall.id, h);
          row.appendChild(el('td', {
            class: 'free', role: 'button', tabindex: '0', 'aria-label': hallName(hall) + ' ' + hourStr(h),
            onclick: open,
            onkeydown: e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } },
          }));
        }
      });
      body.appendChild(row);
    }
    grid.appendChild(body);
  }

  function renderMine() {
    const list = $('mine');
    list.textContent = '';
    if (!state.data.mine.length) { list.appendChild(el('li', { class: 'empty', text: t('noBookings') })); return; }
    state.data.mine.forEach(b => {
      list.appendChild(el('li', null, [
        el('div', null, [
          el('div', { class: 'who', text: fmtDate(b.date) + ' · ' + b.start + '–' + b.end }),
          el('div', { class: 'sub', text: hallName(hallById(b.hall)) + ' · ' + b.department }),
        ]),
        el('button', { type: 'button', class: 'danger', text: t('cancelBooking'), onclick: () => cancel(b.id) }),
      ]));
    });
  }

  function reasonText(r) {
    switch (r.code) {
      case 'MISSING': return t('r_MISSING_' + r.field);
      case 'OUTSIDE_HOURS': return t('r_OUTSIDE_HOURS', { open: r.open, close: r.close });
      case 'TOO_FAR': return t('r_TOO_FAR', { days: r.days });
      case 'HOLIDAY': return t('r_HOLIDAY', { name: r[state.lang] || r.en });
      case 'CLASH': return t('r_CLASH', { start: r.start, end: r.end, department: r.department, name: r.name });
      default: return t('r_' + r.code);
    }
  }

  /** state.result: null | {reasons:[...]} | {error:'CODE'}. Kept so a language switch re-renders it. */
  function renderResult() {
    const box = $('result'), r = state.result;
    box.textContent = '';
    box.hidden = !r;
    if (!r) return;
    if (r.error) { box.appendChild(el('p', { text: t('e_' + r.error) })); return; }
    box.appendChild(el('strong', { text: t('incomplete') }));
    box.appendChild(el('ul', null, r.reasons.map(x => el('li', { text: reasonText(x) }))));
  }

  // ------------------------------------------------------------- form

  function fillForm(reset, hallId, hour) {
    const d = state.data;
    const hallSel = $('f-hall'), keepHall = hallId || hallSel.value;
    hallSel.textContent = '';
    d.halls.forEach(h => hallSel.appendChild(el('option', { value: h.id, text: hallName(h) })));
    if (keepHall) hallSel.value = keepHall;

    const dateIn = $('f-date');
    dateIn.min = d.now.date;
    dateIn.max = addDays(d.now.date, d.settings.maxDaysAhead);
    if (reset) dateIn.value = state.day < d.now.date ? d.now.date : state.day;

    const startSel = $('f-start'), keepStart = hour != null ? hourStr(hour) : startSel.value;
    startSel.textContent = '';
    for (let h = d.settings.openHour; h < d.settings.closeHour; h++) {
      startSel.appendChild(el('option', { value: hourStr(h), text: hourStr(h) }));
    }
    if (keepStart) startSel.value = keepStart;
    fillEnd(hour != null ? hourStr(hour + 1) : $('f-end').value);

    if (reset) {
      const tgName = tgUser ? [tgUser.first_name, tgUser.last_name].filter(Boolean).join(' ') : '';
      $('f-name').value = store.get('name') || tgName;
      $('f-dept').value = store.get('dept') || '';
    }
  }

  function fillEnd(keep) {
    const d = state.data, endSel = $('f-end');
    const s = hourOf($('f-start').value || hourStr(d.settings.openHour));
    endSel.textContent = '';
    for (let h = s + 1; h <= d.settings.closeHour; h++) {
      endSel.appendChild(el('option', { value: hourStr(h), text: hourStr(h) }));
    }
    endSel.value = keep && hourOf(keep) > s && hourOf(keep) <= d.settings.closeHour ? keep : hourStr(s + 1);
  }

  function openForm(hallId, hour) {
    if (!state.data || !state.data.halls.length) return;
    state.result = null;
    $('formbox').hidden = false;
    fillForm(true, hallId, hour);
    renderResult();
    $('formbox').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function defaultHour() {
    const d = state.data, now = d.now;
    let h = d.settings.openHour;
    if (state.day <= now.date) h = Math.max(h, Math.ceil(now.minutes / 60));
    return Math.min(h, d.settings.closeHour - 1);
  }

  function setBusy(on) {
    state.busy = on;
    $('f-submit').disabled = on;
  }

  async function submit(ev) {
    ev.preventDefault();
    if (state.busy) return;
    const booking = {
      hall: $('f-hall').value,
      date: $('f-date').value,
      start: $('f-start').value,
      end: $('f-end').value,
      name: $('f-name').value.trim(),
      department: $('f-dept').value.trim(),
    };
    if (booking.name) store.set('name', booking.name);
    if (booking.department) store.set('dept', booking.department);
    setBusy(true);
    const res = await api('book', { booking: booking });
    setBusy(false);
    if (res.ok) {
      haptic('success');
      state.result = null;
      $('formbox').hidden = true;
      const b = res.booking;
      showNotice(t('booked', { hall: hallName(hallById(b.hall)), date: fmtDate(b.date), start: b.start, end: b.end }), 'ok');
      load(b.date);
      return;
    }
    haptic('error');
    state.result = res.status === 'incomplete' ? { reasons: res.reasons || [] } : { error: res.error || 'SERVER' };
    renderResult();
  }

  async function cancel(id) {
    if (!(await confirmBox(t('confirmCancel')))) return;
    const res = await api('cancel', { id: id });
    if (res.ok) {
      haptic('success');
      showNotice(t('cancelled'), 'ok');
      load(state.day);
    } else {
      haptic('error');
      showNotice(res.reasons ? res.reasons.map(reasonText).join(' ') : t('e_' + (res.error || 'SERVER')), 'error');
    }
  }

  // ------------------------------------------------------------- data

  async function load(day) {
    if (!API || API.indexOf('PASTE_') >= 0) { showNotice(t('e_CONFIG'), 'error'); return; }
    $('dayLabel').textContent = t('loading');
    const res = await api('list', day ? { from: day, to: day } : {});
    if (!res.ok) {
      showNotice(t('e_' + (res.error || 'SERVER')), 'error');
      $('dayLabel').textContent = day ? fmtDate(day) : '';
      return;
    }
    state.data = res;
    state.day = day || res.now.date;
    render();
  }

  // ------------------------------------------------------------- events

  $('lang').addEventListener('click', () => {
    state.lang = nextLang();
    store.set('lang', state.lang);
    render();
  });
  $('prev').addEventListener('click', () => { if (state.day) load(addDays(state.day, -1)); });
  $('next').addEventListener('click', () => { if (state.day) load(addDays(state.day, 1)); });
  $('today').addEventListener('click', () => load(null));
  $('day').addEventListener('change', e => { if (parseYmd(e.target.value) !== null) load(e.target.value); });
  $('openForm').addEventListener('click', () => { if (state.data) openForm(state.data.halls[0] && state.data.halls[0].id, defaultHour()); });
  $('f-start').addEventListener('change', () => fillEnd($('f-end').value));
  $('f-close').addEventListener('click', () => { $('formbox').hidden = true; state.result = null; });
  $('form').addEventListener('submit', submit);

  if (tg) { tg.ready(); tg.expand(); }
  render();
  load(null);
})();
