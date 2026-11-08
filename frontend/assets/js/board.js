/* =============================================================================
   Tool Table — task board (kanban) + reminders
   Columns: 週期工作 (recurring) / New / On going / Pending / On hold / Complete / Canceled.
   Recurring cards: at their deadline a prompt asks whether to close them; closing
   creates the next occurrence (server side, once) in the 週期工作 column.
   Cards have optional start and due dates ("YYYY-MM-DD" = all day, or with a time)
   and a reminder relative to the due date. Reminders show as a badge on the header
   bell, in the sidebar, as highlighted cards and — when allowed — as desktop
   notifications.
   ============================================================================= */
'use strict';

const TTBoard = (() => {
  const { api, el, svg, toast, store } = TT;

  const STATUSES = [
    { key: 'recurring', label: 'Recurring', zh: '週期工作', color: '#14b8a6' },
    { key: 'new', label: 'New', zh: '新建', color: '#64748b' },
    { key: 'ongoing', label: 'On going', zh: '進行中', color: '#3b82f6' },
    { key: 'pending', label: 'Pending', zh: '待確認', color: '#f59e0b' },
    { key: 'onhold', label: 'On hold', zh: '暫緩', color: '#a855f7' },
    { key: 'complete', label: 'Complete', zh: '完成', color: '#10b981' },
    { key: 'canceled', label: 'Canceled', zh: '取消', color: '#ef4444' },
  ];
  const STATUS = Object.fromEntries(STATUSES.map(s => [s.key, s]));
  const CLOSED = new Set(['complete', 'canceled']);
  const PRIORITIES = [['low', '低'], ['normal', '一般'], ['high', '高']];
  const REMINDS = [['', '不提醒'], ['0', '到期時'], ['15', '15 分鐘前'], ['60', '1 小時前'], ['1440', '1 天前'], ['2880', '2 天前'], ['10080', '1 週前']];
  const ALL_DAY_REMIND_HOUR = 9;          // all-day cards are reminded at 09:00
  const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
  const CLOSE_PROMPT_HOUR = 18;           // all-day recurring cards ask "close it?" at 18:00 on the due day
  const REPEATS = [['', '不重複'], ['daily', '每天'], ['weekdays', '每個工作日（一～五）'], ['weekly', '每週'], ['monthly', '每月'], ['yearly', '每年']];
  const UNIT = { daily: '天', weekly: '週', monthly: '個月', yearly: '年' };

  let tasks = [];
  let settings = {};
  let loading = null;
  const boards = new Set();               // re-render functions of mounted boards
  const bells = new Set();

  const pad = n => String(n).padStart(2, '0');
  const now = () => (window.TTClock && TTClock.now ? TTClock.now() : new Date());

  // ------------------------------------------------------------------ data
  function load(force = false) {
    if (!loading || force) loading = api('/api/tasks').then(t => { tasks = t; changed(); return tasks; });
    return loading;
  }
  function changed() {
    boards.forEach(f => f());
    refreshAlerts();
  }
  const byStatus = s => tasks.filter(t => t.status === s).sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);

  async function save(id, body) {
    const before = id && tasks.find(x => x.id === id);
    const t = id ? await api(`/api/tasks/${id}`, { method: 'PUT', body }) : await api('/api/tasks', { method: 'POST', body });
    const i = tasks.findIndex(x => x.id === t.id);
    if (i >= 0) tasks[i] = t; else tasks.push(t);
    changed();
    if (t.repeat && t.status === 'complete' && before && before.status !== 'complete') {
      await load(true);
      announceNext(t);
    }
    return t;
  }
  async function remove(id) {
    await api(`/api/tasks/${id}`, { method: 'DELETE' });
    tasks = tasks.filter(t => t.id !== id);
    changed();
  }
  async function moveTo(id, status, index) {
    const t = tasks.find(x => x.id === id);
    if (!t) return;
    const col = byStatus(status).filter(x => x.id !== id);
    col.splice(Math.max(0, Math.min(index, col.length)), 0, t);
    const wasClosed = CLOSED.has(t.status);
    t.status = status;
    col.forEach((x, i) => { x.sort_order = i; });
    changed();                                            // optimistic
    try {
      const r = await api('/api/tasks/reorder', { method: 'POST', body: { status, ids: col.map(x => x.id) } });
      if (r.created && r.created.length) { await load(true); announceNext(t); }
      else if (status === 'complete' && !wasClosed) toast(`「${t.title}」完成 🎉`);
    } catch (err) { toast(err.message, true); load(true); }
  }

  /** Close a card through the server (recurring → next occurrence is created once) */
  async function complete(t) {
    const r = await api(`/api/tasks/${t.id}/complete`, { method: 'POST', body: { today: isoDate(now()) } });
    await load(true);
    if (r.next) announceNext(r.task, r.next); else toast(`「${t.title}」完成 🎉`);
    return r;
  }
  function announceNext(t, next) {
    next = next || tasks.find(x => x.id === (tasks.find(y => y.id === t.id) || t).next_id);
    toast(next ? `「${t.title}」已結案；下一次 ${fmt(next.due_at, true)} 已排入「週期工作」` : `「${t.title}」完成 🎉`);
  }

  // ----------------------------------------------------------------- dates
  function parse(v) {
    if (!v) return null;
    const [d, tm] = v.split('T');
    const [y, m, dd] = d.split('-').map(Number);
    const [h, mi] = tm ? tm.split(':').map(Number) : [0, 0];
    return { date: new Date(y, m - 1, dd, h, mi), allDay: !tm };
  }
  const endOfDay = d => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59);
  const dueMoment = v => { const p = parse(v); return p && (p.allDay ? endOfDay(p.date) : p.date); };
  function remindMoment(t) {
    if (t.remind === null || t.remind === undefined || !t.due_at) return null;
    const p = parse(t.due_at);
    const base = p.allDay ? new Date(p.date.getFullYear(), p.date.getMonth(), p.date.getDate(), ALL_DAY_REMIND_HOUR) : p.date;
    return new Date(base.getTime() - t.remind * 60000);
  }
  const dayDiff = (a, b) => Math.round((new Date(a.getFullYear(), a.getMonth(), a.getDate()) - new Date(b.getFullYear(), b.getMonth(), b.getDate())) / 86400000);
  const hm = d => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  function fmt(v, withWeekday = false) {
    const p = parse(v);
    if (!p) return '';
    const d = p.date;
    let s = `${d.getMonth() + 1}/${d.getDate()}`;
    if (d.getFullYear() !== now().getFullYear()) s = `${d.getFullYear()}/${s}`;
    if (withWeekday) s += `（${WEEK[d.getDay()]}）`;
    if (!p.allDay) s += ` ${hm(d)}`;
    return s;
  }
  const fmtMoment = d => `${d.getMonth() + 1}/${d.getDate()}（${WEEK[d.getDay()]}）${hm(d)}`;
  const isoDate = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const dayOnly = d => new Date(d.getFullYear(), d.getMonth(), d.getDate());

  // ------------------------------------------------------------ recurrence
  // Same rules as the server (app/routes/tasks.py) — used for previews and labels.
  function stepDate(d, rule, every) {
    const add = n => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
    const isoDay = x => x.getDay() || 7;
    if (rule === 'daily') return add(every);
    if (rule === 'weekdays') { let n = 1; while ([0, 6].includes(add(n).getDay())) n++; return add(n); }
    if (rule.startsWith('weekly')) {
      const days = (rule.includes(':') ? rule.split(':')[1] : String(isoDay(d))).split(',').map(Number).sort((a, b) => a - b);
      const later = days.filter(x => x > isoDay(d));
      if (later.length) return add(later[0] - isoDay(d));
      return add(1 - isoDay(d) + 7 * every + days[0] - 1);
    }
    if (rule.startsWith('monthly')) {
      const day = rule.includes(':') ? Number(rule.split(':')[1]) : d.getDate();
      const y = d.getFullYear(), m = d.getMonth() + every;
      return new Date(y, m, Math.min(day, new Date(y, m + 1, 0).getDate()));
    }
    if (rule === 'yearly') {
      const y = d.getFullYear() + every;
      return d.getMonth() === 1 && d.getDate() === 29 && new Date(y, 1, 29).getMonth() !== 1 ? new Date(y, 1, 28) : new Date(y, d.getMonth(), d.getDate());
    }
    return null;
  }
  /** Next due string (missed periods skipped, like the server) */
  function nextDue(dueAt, rule, every = 1) {
    if (!dueAt || !rule) return null;
    const today = dayOnly(now());
    let d = stepDate(dayOnly(parse(dueAt).date), rule, every);
    for (let i = 0; d && d < today && i < 5000; i++) d = stepDate(d, rule, every);
    return d ? isoDate(d) + dueAt.slice(10) : null;
  }
  function repeatText(rule, every = 1, dueAt = null) {
    if (!rule) return '';
    const kind = rule.split(':')[0];
    const each = every > 1 ? `每 ${every} ${UNIT[kind] || ''}` : { daily: '每天', weekly: '每週', monthly: '每月', yearly: '每年' }[kind];
    if (kind === 'weekdays') return '每個工作日';
    if (kind === 'weekly') {
      const days = (rule.split(':')[1] || '').split(',').filter(Boolean).map(Number);
      return each + (days.length ? days.map(x => WEEK[x % 7]).join('、') : '');
    }
    if (kind === 'monthly') { const day = rule.split(':')[1] || (dueAt ? Number(dueAt.slice(8, 10)) : ''); return `${each} ${day} 日`; }
    if (kind === 'yearly' && dueAt) { const p = parse(dueAt).date; return `${each} ${p.getMonth() + 1}/${p.getDate()}`; }
    return each;
  }
  /** When a recurring card asks "close it?" */
  function closeMoment(t) {
    const p = parse(t.due_at);
    if (!p) return null;
    return p.allDay ? new Date(p.date.getFullYear(), p.date.getMonth(), p.date.getDate(), CLOSE_PROMPT_HOUR) : p.date;
  }

  /** How a card stands right now: due / start state and their labels */
  function timing(t, at = now()) {
    const out = { due: null, dueText: '', start: null, startText: '' };
    const closed = CLOSED.has(t.status);
    const soonDays = Number(settings.board_due_soon_days ?? 2);
    if (t.due_at) {
      const p = parse(t.due_at);
      const days = dayDiff(p.date, at);
      const time = p.allDay ? '' : ` ${hm(p.date)} `;
      if (closed) { out.due = 'done'; out.dueText = `${fmt(t.due_at)} 到期`; }
      else if (at > dueMoment(t.due_at)) {
        out.due = 'overdue';
        const late = dayDiff(at, p.date);
        out.dueText = late >= 1 ? `逾期 ${late} 天` : `已逾期（${hm(p.date)}）`;
      }
      else if (days === 0) { out.due = 'today'; out.dueText = `今天${time}到期`; }
      else if (days === 1) { out.due = 'soon'; out.dueText = `明天${time}到期`; }
      else if (days <= soonDays) { out.due = 'soon'; out.dueText = `${days} 天後到期`; }
      else { out.due = 'later'; out.dueText = `${fmt(t.due_at)} 到期`; }
    }
    if (t.start_at && !closed) {
      const p = parse(t.start_at);
      if (at < p.date) {
        const d = dayDiff(p.date, at);
        out.start = 'waiting';
        out.startText = d === 0 ? `今天 ${hm(p.date)} 開始` : d === 1 ? '明天開始' : d <= 7 ? `${d} 天後開始` : `${fmt(t.start_at)} 開始`;
      } else if (t.status === 'new') {
        out.start = 'due';
        out.startText = '該開始了';
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- alerts
  /** Cards that need attention: overdue, due today, reminder time passed, or should have started */
  function alerts(at = now()) {
    const list = [];
    for (const t of tasks) {
      if (CLOSED.has(t.status)) continue;
      const tm = timing(t, at);
      const rm = remindMoment(t);
      if (tm.due === 'overdue') list.push({ t, kind: 'overdue', text: tm.dueText, rank: 0 });
      else if (rm && at >= rm) list.push({ t, kind: 'remind', text: tm.dueText || `${fmt(t.due_at)} 到期`, rank: 1 });
      else if (tm.due === 'today') list.push({ t, kind: 'today', text: tm.dueText, rank: 2 });
      else if (tm.start === 'due') list.push({ t, kind: 'start', text: `開始日 ${fmt(t.start_at)}，還在 New`, rank: 3 });
    }
    return list.sort((a, b) => a.rank - b.rank || (dueMoment(a.t.due_at) || 0) - (dueMoment(b.t.due_at) || 0));
  }
  const alertKey = a => [a.t.id, a.kind, a.t.due_at || '', a.t.start_at || '', a.t.remind ?? ''].join('|');
  const KIND = { overdue: '已逾期', remind: '到期提醒', today: '今天到期', start: '該開始了' };

  let firstCheck = true;
  function refreshAlerts() {
    const list = alerts();
    document.querySelectorAll('[data-board-badge]').forEach(b => { b.textContent = list.length; b.hidden = !list.length; });
    bells.forEach(f => f(list));
    notify(list);
    checkClosePrompts();
  }

  // ----------------------------------------------- recurring: "close it?" prompt
  let prompting = null;                                   // { id, due, close }
  const snoozed = (t, at) => { const z = store.get('board-snooze', {})[t.id]; return z && z.due === t.due_at && z.until > at.getTime(); };
  function snooze(t, minutes) {
    const all = store.get('board-snooze', {});
    for (const [k, v] of Object.entries(all)) if (v.until < Date.now()) delete all[k];   // tidy
    all[t.id] = { due: t.due_at, until: Date.now() + minutes * 60000 };
    store.set('board-snooze', all);
  }
  function dueForClose(at = now()) {
    return tasks.filter(t => t.repeat && t.due_at && !CLOSED.has(t.status) && at >= closeMoment(t) && !snoozed(t, at))
      .sort((a, b) => closeMoment(a) - closeMoment(b));
  }
  function checkClosePrompts() {
    if (!started) return;
    if (prompting) {
      const t = tasks.find(x => x.id === prompting.id);
      if (!t || CLOSED.has(t.status) || t.due_at !== prompting.due) prompting.close();   // closed elsewhere
      return;
    }
    if (document.querySelector('.modal:not([hidden])')) return;                        // never interrupt another dialog
    const t = dueForClose()[0];
    if (t) showClosePrompt(t);
  }

  function showClosePrompt(t) {
    const tm = timing(t);
    const next = nextDue(t.due_at, t.repeat, t.repeat_every || 1);
    const waiting = dueForClose().length - 1;
    const later = el('button', { class: 'btn btn-ghost', type: 'button', html: svg('clock') + '1 小時後再問' });
    const open = el('button', { class: 'btn', type: 'button', html: svg('edit') + '開啟卡片' });
    const done = el('button', { class: 'btn btn-primary', type: 'button', html: svg('check') + '結案並排下一次' });
    const wrap = el('div', { class: 'modal kb-close' },
      el('div', { class: 'modal-card kb-close-card', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': '週期工作到期' },
        el('div', { class: 'modal-head' }, el('h3', { html: svg('repeat') + '週期工作到期' })),
        el('div', { class: 'modal-body' },
          el('div', { class: 'kb-close-title' }, t.priority === 'high' ? el('span', { class: 'kb-flag', html: svg('flag') }) : null, el('strong', { text: t.title })),
          t.description ? el('p', { class: 'kb-close-desc', text: t.description }) : null,
          el('div', { class: 'kb-chips' },
            el('span', { class: `kb-chip due-${tm.due || 'later'}`, html: svg('clock') + `<span>${tm.dueText || fmt(t.due_at)}</span>` }),
            el('span', { class: 'kb-chip repeat', html: svg('repeat') + `<span>${repeatText(t.repeat, t.repeat_every, t.due_at)}</span>` })),
          el('p', { class: 'kb-close-q', text: '這一次完成了嗎？' }),
          el('p', { class: 'hint', text: `結案後這張會移到「Complete」，並自動複製一張到「週期工作」，到期日 ${fmt(next, true)}。` }),
          waiting > 0 ? el('p', { class: 'hint', text: `還有 ${waiting} 張週期工作等你確認。` }) : null),
        el('div', { class: 'modal-foot' }, later, el('span', { class: 'spacer' }), open, done)));

    const close = () => {
      wrap.remove();
      document.removeEventListener('keydown', onKey);
      if (!document.querySelector('.modal:not([hidden])')) document.body.classList.remove('modal-open');
      prompting = null;
      setTimeout(checkClosePrompts, 400);                 // next one in the queue
    };
    const onKey = e => { if (e.key === 'Escape') { snooze(t, 60); close(); } };
    prompting = { id: t.id, due: t.due_at, close };
    later.addEventListener('click', () => { snooze(t, 60); close(); toast('1 小時後會再問一次'); });
    open.addEventListener('click', () => { snooze(t, 10); close(); openEditor(t); });
    done.addEventListener('click', async () => {
      [done, later, open].forEach(b => { b.disabled = true; });
      done.innerHTML = svg('check') + '處理中…';
      try { await complete(t); close(); } catch (err) { toast(err.message, true); [done, later, open].forEach(b => { b.disabled = false; }); }
    });
    document.addEventListener('keydown', onKey);
    document.body.append(wrap);
    document.body.classList.add('modal-open');
    setTimeout(() => done.focus(), 30);

    // desktop notification once per occurrence
    const key = `${t.id}|${t.due_at}`;
    const told = store.get('board-close-told', []);
    if (canNotify() && !told.includes(key)) {
      const n = new Notification(`週期工作到期：${t.title}`, { body: '這一次完成了嗎？點這裡結案並排下一次。', tag: 'tt-close-' + key, icon: '/assets/app/icon-192.png', requireInteraction: true });
      n.onclick = () => { window.focus(); n.close(); };
      store.set('board-close-told', [...told.slice(-50), key]);
    }
  }

  function canNotify() {
    return settings.board_notify !== false && 'Notification' in window && Notification.permission === 'granted';
  }
  function notify(list) {
    const seen = new Set(store.get('board-notified', []));
    const fresh = list.filter(a => !seen.has(alertKey(a)));
    store.set('board-notified', list.map(alertKey));     // only keep what is still active
    if (!fresh.length) { firstCheck = false; return; }
    const open = () => { window.focus(); if (location.pathname === '/') location.hash = '#/board'; else location.href = '/#/board'; };
    // on page load, one summary instead of a burst
    if (firstCheck && fresh.length > 1) {
      const title = `${fresh.length} 個待辦需要注意`;
      const body = fresh.slice(0, 4).map(a => `${KIND[a.kind]}：${a.t.title}`).join('\n') + (fresh.length > 4 ? '\n…' : '');
      if (canNotify()) { const n = new Notification(title, { body, tag: 'tt-board-summary', icon: '/assets/app/icon-192.png' }); n.onclick = open; }
      else toast(`🔔 ${title}`);
    } else {
      fresh.forEach(a => {
        if (canNotify()) {
          const n = new Notification(`${KIND[a.kind]}：${a.t.title}`, { body: a.text, tag: 'tt-' + alertKey(a), icon: '/assets/app/icon-192.png' });
          n.onclick = open;
        } else toast(`🔔 ${KIND[a.kind]}：${a.t.title}（${a.text}）`);
      });
    }
    firstCheck = false;
  }

  // ------------------------------------------------------------------ init
  let started = false;
  function init(s) {
    settings = s || {};
    if (started) return;
    started = true;
    load().catch(() => {});
    setInterval(refreshAlerts, 30 * 1000);                     // time moves on: re-evaluate
    setInterval(() => load(true).catch(() => {}), 5 * 60 * 1000); // pick up edits from other people
    document.addEventListener('visibilitychange', () => { if (!document.hidden) load(true).catch(() => {}); });
  }

  // ------------------------------------------------------------------ board
  /**
   * Render a board into `root`.
   * opts.hideClosed: hide Complete / Canceled columns; opts.full: page mode (taller columns)
   */
  function mount(root, opts = {}) {
    root.classList.add('kb');
    if (opts.full) root.classList.add('kb-full');
    let hideClosed = !!opts.hideClosed;
    let drag = null;                                           // { id, from }
    const placeholder = el('div', { class: 'kb-placeholder' });

    const render = () => {
      if (!root.isConnected && root.dataset.mounted) { boards.delete(render); return; }
      root.dataset.mounted = '1';
      const cols = STATUSES.filter(s => !(hideClosed && CLOSED.has(s.key)));
      root.style.setProperty('--kb-cols', cols.length);
      root.replaceChildren(...cols.map(column));
    };

    function column(s) {
      const items = byStatus(s.key);
      const list = el('div', { class: 'kb-list', dataset: { status: s.key } }, items.map(card));
      if (!items.length) list.append(el('div', { class: 'kb-empty', text: s.key === 'recurring' ? '重複性工作會排在這裡' : CLOSED.has(s.key) ? '—' : '拖曳卡片到這裡' }));
      const add = el('button', { class: 'kb-add', type: 'button', html: svg('plus') + '<span>新增卡片</span>' });
      add.addEventListener('click', () => s.key === 'recurring'
        ? openEditor(null, { status: 'recurring', repeat: 'weekly' })
        : quickAdd(col, s.key, add));
      const col = el('section', { class: 'kb-col', dataset: { status: s.key }, style: { '--st': s.color } },
        el('header', { class: 'kb-col-head' },
          el('span', { class: 'kb-dot' }),
          el('span', { class: 'kb-name' }, el('strong', { text: s.label }), el('span', { class: 'kb-zh', text: s.zh })),
          el('span', { class: 'kb-count', text: items.length })),
        list,
        CLOSED.has(s.key) ? null : add);
      list.addEventListener('dragover', e => {
        if (!drag) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const after = [...list.querySelectorAll('.kb-card:not(.dragging)')].find(c => {
          const r = c.getBoundingClientRect();
          return e.clientY < r.top + r.height / 2;
        });
        list.querySelector('.kb-empty')?.remove();
        if (after) list.insertBefore(placeholder, after); else list.append(placeholder);
        col.classList.add('drop-over');
      });
      list.addEventListener('dragleave', e => { if (!list.contains(e.relatedTarget)) col.classList.remove('drop-over'); });
      list.addEventListener('drop', e => {
        if (!drag) return;
        e.preventDefault();
        e.stopPropagation();
        const index = [...list.children].filter(c => c.classList.contains('kb-card') && !c.classList.contains('dragging') || c === placeholder).indexOf(placeholder);
        const id = drag.id;
        drag = null;
        placeholder.remove();
        moveTo(id, s.key, index < 0 ? 0 : index);
      });
      return col;
    }

    function card(t) {
      const tm = timing(t);
      const chips = [];
      if (tm.start) chips.push(el('span', { class: `kb-chip start-${tm.start}`, title: `開始：${fmt(t.start_at, true)}`, html: svg('play') + `<span>${tm.startText}</span>` }));
      if (tm.due) chips.push(el('span', { class: `kb-chip due-${tm.due}`, title: `到期：${fmt(t.due_at, true)}`, html: svg('clock') + `<span>${tm.dueText}</span>` }));
      if (t.repeat) chips.push(el('span', { class: 'kb-chip repeat', title: `重複：${repeatText(t.repeat, t.repeat_every, t.due_at)}`, html: svg('repeat') + `<span>${repeatText(t.repeat, t.repeat_every, t.due_at)}</span>` }));
      if (t.due_at && t.remind !== null && t.remind !== undefined && !CLOSED.has(t.status)) {
        const rm = remindMoment(t);
        chips.push(el('span', { class: 'kb-chip remind', title: `提醒：${fmtMoment(rm)}`, html: svg('bell') }));
      }
      const c = el('article', {
        class: `kb-card prio-${t.priority}` + (tm.due ? ` is-${tm.due}` : '') + (tm.start === 'due' ? ' is-start' : '') + (CLOSED.has(t.status) ? ' is-closed' : ''),
        draggable: 'true', tabindex: '0', dataset: { id: t.id },
      },
        el('div', { class: 'kb-card-title' },
          t.priority === 'high' ? el('span', { class: 'kb-flag', title: '高優先', html: svg('flag') }) : null,
          el('span', { text: t.title })),
        t.description ? el('p', { class: 'kb-card-desc', text: t.description }) : null,
        chips.length ? el('div', { class: 'kb-chips' }, chips) : null);
      c.addEventListener('click', () => openEditor(t));
      c.addEventListener('keydown', e => { if (e.key === 'Enter') openEditor(t); });
      c.addEventListener('dragstart', e => {
        drag = { id: t.id };
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('application/x-tool-table-task', String(t.id));
        requestAnimationFrame(() => c.classList.add('dragging'));
      });
      c.addEventListener('dragend', () => {
        c.classList.remove('dragging');
        placeholder.remove();
        root.querySelectorAll('.drop-over').forEach(x => x.classList.remove('drop-over'));
        if (drag) { drag = null; render(); }
      });
      return c;
    }

    function quickAdd(col, status, btn) {
      const input = el('input', { class: 'input kb-quick', placeholder: '輸入標題，Enter 新增（Esc 取消）', maxlength: '200' });
      const more = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: '更多設定…' });
      const box = el('div', { class: 'kb-quick-box' }, input, more);
      btn.replaceWith(box);
      input.focus();
      const done = () => box.isConnected && render();
      more.addEventListener('mousedown', e => e.preventDefault());
      more.addEventListener('click', () => { openEditor(null, { status, title: input.value.trim() }); done(); });
      input.addEventListener('keydown', async e => {
        if (e.key === 'Escape') done();
        if (e.key !== 'Enter' || e.isComposing) return;
        const title = input.value.trim();
        if (!title) return;
        input.disabled = true;
        try {
          await save(null, { title, status });
          setTimeout(() => col.isConnected && root.querySelector(`.kb-col[data-status="${status}"] .kb-add`)?.click(), 0);
        } catch (err) { toast(err.message, true); input.disabled = false; }
      });
      input.addEventListener('blur', () => setTimeout(() => { if (!input.disabled && !input.value.trim()) done(); }, 150));
    }

    boards.add(render);
    render();
    if (!loading) load().catch(() => {});
    return {
      setHideClosed(v) { hideClosed = v; render(); },
      render,
    };
  }

  // ----------------------------------------------------------------- editor
  function openEditor(task, defaults = {}) {
    const t = task || { title: defaults.title || '', description: '', status: defaults.status || 'new', priority: 'normal', start_at: null, due_at: null, remind: 1440, repeat: defaults.repeat || null, repeat_every: 1 };
    const split = v => { const [d, tm] = (v || '').split('T'); return [d || '', tm || '']; };
    const [sd, st] = split(t.start_at);
    const [dd, dt] = split(t.due_at);

    const title = el('input', { class: 'input kb-title-input', value: t.title, maxlength: '200', placeholder: '要做什麼？' });
    const desc = el('textarea', { class: 'textarea', rows: '4', placeholder: '細節、連結、注意事項（選填）' });
    desc.value = t.description || '';
    const status = el('select', { class: 'select' }, STATUSES.map(s => el('option', { value: s.key, text: `${s.label}（${s.zh}）` })));
    status.value = t.status;
    let priority = t.priority;
    const prio = el('div', { class: 'segmented', role: 'group' }, PRIORITIES.map(([v, label]) => {
      const b = el('button', { type: 'button', dataset: { v }, html: (v === 'high' ? svg('flag') : '') + `<span>${label}</span>` });
      b.addEventListener('click', () => { priority = v; paintPrio(); });
      return b;
    }));
    const paintPrio = () => prio.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === priority)));
    paintPrio();

    const startD = el('input', { class: 'input', type: 'date', value: sd });
    const startT = el('input', { class: 'input kb-time', type: 'time', value: st, title: '時間（選填）' });
    const dueD = el('input', { class: 'input', type: 'date', value: dd });
    const dueT = el('input', { class: 'input kb-time', type: 'time', value: dt, title: '時間（選填；不填＝當天結束前）' });
    const remind = el('select', { class: 'select' }, REMINDS.map(([v, l]) => el('option', { value: v, text: l })));
    remind.value = t.remind === null || t.remind === undefined ? '' : String(t.remind);
    const hint = el('p', { class: 'hint kb-remind-hint' });

    // --- repeat
    const ruleKind = (t.repeat || '').split(':')[0];
    const repeatSel = el('select', { class: 'select' }, REPEATS.map(([v, l]) => el('option', { value: v, text: l })));
    repeatSel.value = ruleKind;
    const every = el('input', { class: 'input kb-every', type: 'number', min: '1', max: '365', value: t.repeat_every || 1 });
    const everyUnit = el('span', { class: 'kb-every-unit' });
    const everyBox = el('label', { class: 'kb-every-box' }, el('span', { text: '每' }), every, everyUnit);
    let weekDays = ruleKind === 'weekly' && t.repeat.includes(':') ? t.repeat.split(':')[1].split(',').map(Number) : [];
    const weekBox = el('div', { class: 'kb-weekdays', role: 'group', 'aria-label': '星期' }, [1, 2, 3, 4, 5, 6, 7].map(d => {
      const b = el('button', { type: 'button', class: 'kb-wd', dataset: { d }, text: WEEK[d % 7] });
      b.addEventListener('click', () => {
        weekDays = weekDays.includes(d) ? weekDays.filter(x => x !== d) : [...weekDays, d].sort((a, c) => a - c);
        paintRepeat(); paintHint();
      });
      return b;
    }));
    const repeatHint = el('p', { class: 'hint kb-repeat-hint' });
    const ruleValue = () => {
      const k = repeatSel.value;
      if (!k) return null;
      if (k === 'weekly') {
        const due = dueD.value ? new Date(dueD.value + 'T00:00') : null;
        const days = weekDays.length ? weekDays : due ? [due.getDay() || 7] : [];
        return days.length ? `weekly:${days.join(',')}` : 'weekly';
      }
      return k;
    };
    function paintRepeat() {
      const k = repeatSel.value;
      everyBox.hidden = !k || k === 'weekdays';
      everyUnit.textContent = UNIT[k] || '';
      weekBox.hidden = k !== 'weekly';
      if (k === 'weekly' && !weekDays.length && dueD.value) weekDays = [new Date(dueD.value + 'T00:00').getDay() || 7];
      weekBox.querySelectorAll('.kb-wd').forEach(b => b.setAttribute('aria-pressed', String(weekDays.includes(Number(b.dataset.d)))));
      const due = value(dueD, dueT);
      const rule = ruleValue();
      if (!k) repeatHint.textContent = '';
      else if (!due) repeatHint.textContent = '⚠ 重複需要到期日：下一次依到期日推算';
      else {
        const n = Math.max(1, Number(every.value) || 1);
        const next = nextDue(due, rule === 'monthly' ? `monthly:${Number(due.slice(8, 10))}` : rule, n);
        repeatHint.textContent = `${repeatText(rule === 'monthly' ? `monthly:${Number(due.slice(8, 10))}` : rule, n, due)}。到期時會問你是否結案；結案後下一張（${fmt(next, true)}）會自動排進「週期工作」。`;
      }
    }
    repeatSel.addEventListener('change', () => { paintRepeat(); });
    every.addEventListener('input', paintRepeat);

    const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const shortcut = (label, fn) => {
      const b = el('button', { class: 'chip kb-date-chip', type: 'button', text: label });
      b.addEventListener('click', () => { fn(); paintHint(); paintRepeat(); });
      return b;
    };
    const plus = n => { const d = now(); d.setDate(d.getDate() + n); return iso(d); };
    const nextMonday = () => { const d = now(); d.setDate(d.getDate() + ((8 - d.getDay()) % 7 || 7)); return iso(d); };
    const dueChips = el('div', { class: 'kb-date-chips' },
      shortcut('今天', () => { dueD.value = plus(0); }),
      shortcut('明天', () => { dueD.value = plus(1); }),
      shortcut('下週一', () => { dueD.value = nextMonday(); }),
      shortcut('一週後', () => { dueD.value = plus(7); }),
      shortcut('清除', () => { dueD.value = ''; dueT.value = ''; }));
    const startChips = el('div', { class: 'kb-date-chips' },
      shortcut('今天', () => { startD.value = plus(0); }),
      shortcut('明天', () => { startD.value = plus(1); }),
      shortcut('清除', () => { startD.value = ''; startT.value = ''; }));

    const value = (d, tm) => d.value ? d.value + (tm.value ? 'T' + tm.value : '') : null;
    function paintHint() {
      const due = value(dueD, dueT);
      remind.disabled = !due;
      const r = remind.value === '' ? null : Number(remind.value);
      const parts = [];
      const s = value(startD, startT);
      if (s) parts.push(`開始：${fmt(s, true)}`);
      if (due) {
        parts.push(`到期：${fmt(due, true)}${due.includes('T') ? '' : '（當天結束前）'}`);
        const rm = remindMoment({ due_at: due, remind: r });
        parts.push(rm ? `提醒：${fmtMoment(rm)}` : '不提醒');
      } else parts.push('沒有到期日就不會提醒');
      hint.textContent = parts.join(' · ');
    }
    [startD, startT, dueD, dueT, remind].forEach(x => x.addEventListener('input', () => { paintHint(); paintRepeat(); }));
    paintHint();
    paintRepeat();

    const field = (label, ...ctl) => el('label', { class: 'field' }, el('span', { class: 'field-label', text: label }), ...ctl);
    const ok = el('button', { class: 'btn btn-primary', type: 'button', html: svg('check') + (task ? '儲存' : '新增') });
    const cancel = el('button', { class: 'btn btn-ghost', type: 'button', text: '取消' });
    const del = task ? el('button', { class: 'btn btn-danger kb-del', type: 'button', html: svg('trash') + '刪除' }) : null;
    const closeBtn = el('button', { class: 'icon-btn', type: 'button', 'aria-label': '關閉', html: svg('x') });
    const meta = task ? el('p', { class: 'hint', text: `建立於 ${task.created_at?.slice(0, 16) || ''}` + (task.completed_at ? ` · 完成於 ${task.completed_at.slice(0, 16)}` : '') }) : null;

    const wrap = el('div', { class: 'modal' },
      el('div', { class: 'modal-card kb-editor', role: 'dialog', 'aria-modal': 'true', 'aria-label': task ? '編輯卡片' : '新增卡片' },
        el('div', { class: 'modal-head' }, el('h3', { html: svg('kanban') + (task ? '編輯卡片' : '新增卡片') }), closeBtn),
        el('div', { class: 'modal-body' },
          field('標題', title),
          field('說明', desc),
          el('div', { class: 'kb-row' }, field('狀態', status), el('div', { class: 'field' }, el('span', { class: 'field-label', text: '優先順序' }), prio)),
          el('div', { class: 'kb-row' },
            el('div', { class: 'field' }, el('span', { class: 'field-label', html: svg('play') + '開始日' }), el('div', { class: 'kb-dt' }, startD, startT), startChips),
            el('div', { class: 'field' }, el('span', { class: 'field-label', html: svg('clock') + '到期日' }), el('div', { class: 'kb-dt' }, dueD, dueT), dueChips)),
          el('div', { class: 'kb-row' },
            field('提醒', remind),
            el('div', { class: 'field' }, el('span', { class: 'field-label', html: svg('repeat') + '重複' }),
              el('div', { class: 'kb-repeat' }, repeatSel, everyBox))),
          weekBox,
          hint,
          repeatHint,
          meta),
        el('div', { class: 'modal-foot' }, del, el('span', { class: 'spacer' }), cancel, ok)));

    const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); document.body.classList.remove('modal-open'); };
    const onKey = e => {
      if (e.key === 'Escape') close();
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit();
    };
    wrap.addEventListener('mousedown', e => { if (e.target === wrap) close(); });
    closeBtn.addEventListener('click', close);
    cancel.addEventListener('click', close);
    title.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) submit(); });
    del?.addEventListener('click', async () => {
      if (!confirm(`刪除「${task.title}」？`)) return;
      try { await remove(task.id); close(); toast('已刪除'); } catch (err) { toast(err.message, true); }
    });

    async function submit() {
      if (!title.value.trim()) { toast('請輸入標題', true); title.focus(); return; }
      const body = {
        title: title.value.trim(),
        description: desc.value.trim() || null,
        status: status.value,
        priority,
        start_at: value(startD, startT),
        due_at: value(dueD, dueT),
        remind: remind.value === '' ? null : Number(remind.value),
        repeat: ruleValue(),
        repeat_every: Math.min(365, Math.max(1, Number(every.value) || 1)),
      };
      if (body.start_at && body.due_at && body.start_at.slice(0, 10) > body.due_at.slice(0, 10)) { toast('開始日不能晚於到期日', true); return; }
      if (body.repeat && !body.due_at) { toast('重複的卡片需要設定到期日', true); dueD.focus(); return; }
      ok.disabled = true;
      try {
        await save(task?.id, body);
        close();
        if (!task) toast(`已新增「${body.title}」`);
        if (body.due_at && body.remind !== null) askPermission(true);
      } catch (err) { toast(err.message, true); ok.disabled = false; }
    }
    ok.addEventListener('click', submit);

    document.addEventListener('keydown', onKey);
    document.body.append(wrap);
    document.body.classList.add('modal-open');
    setTimeout(() => title.focus(), 30);
  }

  /** Ask once for desktop notifications (must come from a click) */
  function askPermission(quiet = false) {
    if (settings.board_notify === false || !('Notification' in window) || Notification.permission !== 'default') return;
    if (quiet && store.get('board-asked')) return;
    store.set('board-asked', true);
    Notification.requestPermission().then(p => {
      bells.forEach(f => f(alerts()));
      if (p === 'granted') toast('已開啟桌面通知：到期與提醒時間到會通知你');
    }).catch(() => {});
  }

  // ------------------------------------------------------------------- bell
  function mountBell(btn) {
    btn.hidden = false;
    btn.innerHTML = svg('bell');
    const badge = el('span', { class: 'bell-badge', dataset: { boardBadge: '' }, hidden: true });
    btn.append(badge);
    let pop = null;
    const close = () => { pop?.remove(); pop = null; document.removeEventListener('mousedown', outside); document.removeEventListener('keydown', esc); };
    const outside = e => { if (pop && !pop.contains(e.target) && !btn.contains(e.target)) close(); };
    const esc = e => { if (e.key === 'Escape') close(); };

    const paint = list => {
      btn.title = list.length ? `${list.length} 個待辦需要注意` : '待辦提醒';
      btn.classList.toggle('has-alerts', list.length > 0);
      if (!pop) return;
      const perm = 'Notification' in window && settings.board_notify !== false ? Notification.permission : 'n/a';
      const items = list.length ? list.map(a => {
        const row = el('button', { class: `bell-item kind-${a.kind}`, type: 'button' },
          el('span', { class: 'bell-kind', text: KIND[a.kind] }),
          el('span', { class: 'bell-text' }, el('strong', { text: a.t.title }), el('small', { text: a.text })));
        row.addEventListener('click', () => { close(); openEditor(a.t); });
        return row;
      }) : [el('div', { class: 'bell-empty', text: '目前沒有需要注意的待辦 🎉' })];
      const enable = perm === 'default' ? el('button', { class: 'btn btn-sm', type: 'button', html: svg('bell') + '開啟桌面通知' }) : null;
      enable?.addEventListener('click', () => askPermission());
      const permHint = perm === 'denied' ? el('p', { class: 'hint', text: '瀏覽器已封鎖通知：點網址列左側的圖示可以重新允許。' })
        : perm === 'n/a' && 'Notification' in window ? null
        : !('Notification' in window) || !window.isSecureContext ? el('p', { class: 'hint', text: '這個連線無法使用桌面通知（需要 HTTPS 或本機），提醒會顯示在頁面上。' }) : null;
      const go = el('a', { class: 'btn btn-sm btn-ghost', href: '/#/board', html: svg('kanban') + '開啟看板' });
      go.addEventListener('click', close);
      pop.replaceChildren(...[      // DOM replaceChildren() would print a null as the text "null"
        el('div', { class: 'bell-head' }, el('strong', { text: '待辦提醒' }), el('span', { class: 'badge', text: list.length })),
        el('div', { class: 'bell-list' }, items),
        permHint,
        el('div', { class: 'bell-foot' }, enable, el('span', { class: 'spacer' }), go)].filter(Boolean));
    };
    btn.addEventListener('click', () => {
      if (pop) return close();
      pop = el('div', { class: 'bell-pop glass', role: 'dialog', 'aria-label': '待辦提醒' });
      document.body.append(pop);
      const r = btn.getBoundingClientRect();
      pop.style.top = `${r.bottom + 8}px`;
      pop.style.right = `${Math.max(8, window.innerWidth - r.right - 8)}px`;
      paint(alerts());
      setTimeout(() => { document.addEventListener('mousedown', outside); document.addEventListener('keydown', esc); }, 0);
    });
    bells.add(paint);
    paint(alerts());
  }

  /** Short summary for page headers: "3 進行中 · 1 逾期" */
  function summary() {
    const open = tasks.filter(t => !CLOSED.has(t.status)).length;
    const overdue = tasks.filter(t => timing(t).due === 'overdue').length;
    return [`${open} 張進行中的卡片`, overdue && `${overdue} 張逾期`].filter(Boolean).join(' · ');
  }

  return { init, load, mount, mountBell, openEditor, alerts, summary, timing, nextDue, repeatText, STATUSES, get tasks() { return tasks; } };
})();
