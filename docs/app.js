/* Hall booking mini app. Talks to the Apps Script API set in config.js.
 * The server re-checks every rule; this page only shows the result.
 * User text is always written with textContent, never innerHTML.
 *
 * Speed: data is loaded one month per request and kept in memory, so moving
 * between days of a loaded month needs no request. A month older than
 * STALE_MS is shown at once and refreshed in the background. */
(function () {
  'use strict';

  const I18N = window.I18N;
  const LANGS = Object.keys(I18N);
  const API = (window.APP_CONFIG && window.APP_CONFIG.apiUrl) || '';
  const TZ = 'Asia/Phnom_Penh';
  const STALE_MS = 60 * 1000;
  const tg = window.Telegram && window.Telegram.WebApp;
  const initData = (tg && tg.initData) || '';
  const tgUser = (tg && tg.initDataUnsafe && tg.initDataUnsafe.user) || null;
  const $ = id => document.getElementById(id);

  // Browser storage is a convenience only (language, last name/department); it may be blocked.
  const store = {
    get(k) { try { return window.localStorage.getItem('hb.' + k); } catch (e) { return null; } },
    set(k, v) { try { window.localStorage.setItem('hb.' + k, v); } catch (e) { /* ignore */ } },
  };

  const state = {
    lang: pickLang(),
    day: null,        // selected day 'YYYY-MM-DD'
    today: null,      // server's today (Phnom Penh)
    months: {},       // 'YYYY-MM' -> list response (+ _at timestamp)
    pending: {},      // 'YYYY-MM' -> in-flight promise
    mine: [],         // my upcoming bookings, from the newest response
    data: null,       // response of the selected day's month
    calOpen: false,
    calMonth: null,   // month shown in the calendar
    busy: false,
    result: null,
  };

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
  const monthOf = s => s.slice(0, 7);
  const shiftMonth = (ym, n) => ymd(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1 + n, 1)).slice(0, 7);
  /** ['YYYY-MM-01', last day of month] */
  const monthRange = ym => [ym + '-01', addDays(shiftMonth(ym, 1) + '-01', -1)];

  function fmtDate(s) {
    const ms = parseYmd(s);
    if (ms === null) return s;
    const d = new Date(ms);
    return t('days')[d.getUTCDay()] + ' ' + d.getUTCDate() + ' ' + t('months')[d.getUTCMonth()] + ' ' + d.getUTCFullYear();
  }
  const fmtMonth = ym => t('months')[Number(ym.slice(5, 7)) - 1] + ' ' + ym.slice(0, 4);
  const hallName = h => (h && (h['name_' + state.lang] || h.name_en || h.id)) || '?';
  const hallById = id => (state.data && state.data.halls.filter(h => h.id === id)[0]) || { id: id };

  /** Best guess of today in Phnom Penh before the server answers. */
  function guessToday() {
    try {
      const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' })
        .formatToParts(new Date());
      const get = type => parts.filter(p => p.type === type)[0].value;
      return get('year') + '-' + get('month') + '-' + get('day');
    } catch (e) {
      const d = new Date();
      return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    }
  }

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

  // ------------------------------------------------------------- data

  /** Load one month. Same month asked twice at once -> one request. */
  function fetchMonth(ym, force) {
    if (!force && state.months[ym]) return Promise.resolve(state.months[ym]);
    if (state.pending[ym]) {
      return force ? state.pending[ym].then(() => fetchMonth(ym, true)) : state.pending[ym];
    }
    const range = monthRange(ym);
    const p = api('list', { from: range[0], to: range[1] }).then(res => {
      delete state.pending[ym];
      if (res.ok) {
        res._at = Date.now();
        state.months[ym] = res;
        state.today = res.now.date;
        state.mine = res.mine;
      }
      return res;
    });
    state.pending[ym] = p;
    return p;
  }

  /** Show a day. Instant when its month is loaded; otherwise load it. */
  function goDay(day) {
    if (!API || API.indexOf('PASTE_') >= 0) { showNotice(t('e_CONFIG'), 'error'); return; }
    state.day = day;
    state.calMonth = monthOf(day);
    const ym = monthOf(day);
    const cached = state.months[ym];
    render();
    if (!cached || Date.now() - cached._at > STALE_MS) {
      fetchMonth(ym, !!cached).then(res => {
        if (!res.ok) showNotice(t('e_' + (res.error || 'SERVER')), 'error');
        render();
        if (res.ok) fetchMonth(shiftMonth(ym, 1)).then(renderCalendar);  // next month in the background
      });
    }
  }

  /** Mark a month old so the next visit refreshes it in the background. */
  function markStale(ym) { if (state.months[ym]) state.months[ym]._at = 0; }

  // ------------------------------------------------------------- rendering

  function render() {
    document.documentElement.lang = state.lang;
    document.title = t('title');
    document.querySelectorAll('[data-t]').forEach(n => { n.textContent = t(n.getAttribute('data-t')); });
    $('lang').textContent = I18N[nextLang()]._name;
    renderCalendar();
    if (!state.day) return;
    $('dayLabel').textContent = fmtDate(state.day);
    const d = state.months[monthOf(state.day)];
    $('loading').hidden = !!d;
    if (!d) {
      $('grid').textContent = '';
      $('holiday').hidden = true;
      return;
    }
    state.data = d;
    renderHoliday();
    renderGrid();
    renderMine();
    if (!$('formbox').hidden) fillForm(false);
    renderResult();
  }

  function renderCalendar() {
    const box = $('cal');
    box.hidden = !state.calOpen;
    $('dayBtn').setAttribute('aria-expanded', String(state.calOpen));
    if (!state.calOpen || !state.calMonth) return;
    const ym = state.calMonth;
    const d = state.months[ym];
    $('calTitle').textContent = fmtMonth(ym);
    $('calLoading').hidden = !!d;
    const grid = $('calGrid');
    grid.textContent = '';
    t('daysShort').forEach(w => grid.appendChild(el('span', { class: 'wd', text: w })));
    const range = monthRange(ym);
    const lead = new Date(parseYmd(range[0])).getUTCDay();
    for (let i = 0; i < lead; i++) grid.appendChild(el('span', { class: 'blank' }));
    const days = Number(range[1].slice(8));
    for (let i = 1; i <= days; i++) {
      const date = ym + '-' + pad2(i);
      const cls = ['day'];
      const hol = d && d.holidays[date];
      const count = d ? d.bookings.filter(b => b.date === date).length : 0;
      if (state.today && date < state.today) cls.push('past');
      if (hol) cls.push('hol');
      if (date === state.today) cls.push('today');
      if (date === state.day) cls.push('sel');
      let label = fmtDate(date);
      if (hol) label += ' · ' + t('holiday') + ': ' + (hol[state.lang] || hol.en);
      if (count) label += ' · ' + t('nBookings', { n: count });
      grid.appendChild(el('button', {
        type: 'button', class: cls.join(' '), 'aria-label': label, title: label,
        onclick: () => { state.calOpen = false; goDay(date); },
      }, [el('span', { text: String(i) }), count ? el('i', { class: 'dot' }) : null]));
    }
  }

  function openCalendarMonth(ym) {
    state.calMonth = ym;
    renderCalendar();
    if (!state.months[ym]) fetchMonth(ym).then(renderCalendar);
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
    if (!state.mine.length) { list.appendChild(el('li', { class: 'empty', text: t('noBookings') })); return; }
    state.mine.forEach(b => {
      list.appendChild(el('li', null, [
        el('div', { class: 'jump', role: 'button', tabindex: '0', onclick: () => goDay(b.date) }, [
          el('div', { class: 'who', text: fmtDate(b.date) + ' · ' + b.start + '–' + b.end }),
          el('div', { class: 'sub', text: hallName(hallById(b.hall)) + ' · ' + b.department }),
        ]),
        el('button', { type: 'button', class: 'danger', text: t('cancelBooking'), onclick: () => cancel(b) }),
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
      // Show it at once, then refresh that month from the server in the background.
      const m = state.months[monthOf(b.date)];
      if (m) m.bookings.push(b);
      state.mine = state.mine.concat([b]).sort((x, y) => (x.date + x.start < y.date + y.start ? -1 : 1));
      markStale(monthOf(b.date));
      showNotice(t('booked', { hall: hallName(hallById(b.hall)), date: fmtDate(b.date), start: b.start, end: b.end }), 'ok');
      goDay(b.date);
      return;
    }
    haptic('error');
    state.result = res.status === 'incomplete' ? { reasons: res.reasons || [] } : { error: res.error || 'SERVER' };
    renderResult();
  }

  async function cancel(b) {
    if (!(await confirmBox(t('confirmCancel')))) return;
    const res = await api('cancel', { id: b.id });
    if (res.ok) {
      haptic('success');
      const m = state.months[monthOf(b.date)];
      if (m) m.bookings = m.bookings.filter(x => x.id !== b.id);
      state.mine = state.mine.filter(x => x.id !== b.id);
      markStale(monthOf(b.date));
      showNotice(t('cancelled'), 'ok');
      goDay(state.day);
    } else {
      haptic('error');
      showNotice(res.reasons ? res.reasons.map(reasonText).join(' ') : t('e_' + (res.error || 'SERVER')), 'error');
    }
  }

  // ------------------------------------------------------------- events

  $('lang').addEventListener('click', () => {
    state.lang = nextLang();
    store.set('lang', state.lang);
    render();
  });
  $('prev').addEventListener('click', () => { if (state.day) goDay(addDays(state.day, -1)); });
  $('next').addEventListener('click', () => { if (state.day) goDay(addDays(state.day, 1)); });
  $('today').addEventListener('click', () => { state.calOpen = false; goDay(state.today || guessToday()); });
  $('dayBtn').addEventListener('click', () => {
    state.calOpen = !state.calOpen;
    if (state.calOpen && state.day) openCalendarMonth(monthOf(state.day));
    else renderCalendar();
  });
  $('calPrev').addEventListener('click', () => openCalendarMonth(shiftMonth(state.calMonth, -1)));
  $('calNext').addEventListener('click', () => openCalendarMonth(shiftMonth(state.calMonth, 1)));
  $('openForm').addEventListener('click', () => { if (state.data) openForm(state.data.halls[0] && state.data.halls[0].id, defaultHour()); });
  $('f-start').addEventListener('change', () => fillEnd($('f-end').value));
  $('f-close').addEventListener('click', () => { $('formbox').hidden = true; state.result = null; });
  $('form').addEventListener('submit', submit);

  if (tg) { tg.ready(); tg.expand(); }
  render();
  // Start on today. If the phone's clock disagrees with the server, follow the server.
  const guess = guessToday();
  goDay(guess);
  fetchMonth(monthOf(guess)).then(res => {
    if (res.ok && state.day === guess && res.now.date !== guess) goDay(res.now.date);
  });
})();
