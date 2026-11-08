/* =============================================================================
   Tool Table — task board (kanban) + reminders
   Columns: 週期工作 (recurring) / New / On going / Pending / On hold / Complete / Canceled.
   Recurring cards: at their deadline a prompt asks whether to close them; closing
   creates the next occurrence (server side, once) in the 週期工作 column.
   One-off cards past due move to 過期未結案 (server /sweep with the viewer's local time)
   and are listed in a reminder every day at board_overdue_remind_time (09:30) until closed.
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
    { key: 'overdue', label: 'Overdue', zh: '過期未結案', color: '#e11d48' },
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
    if (body.due_at !== undefined || body.status) sweep();
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

  const localNow = () => { const d = now(); return `${isoDate(d)}T${hm(d)}`; };
  const isPast = (dueAt, at = now()) => {
    if (!dueAt) return false;
    const n = `${isoDate(at)}T${hm(at)}`;
    return dueAt.length === 10 ? dueAt < n.slice(0, 10) : dueAt < n;
  };
  /** Ask the server to move past-due one-off cards to 過期未結案 (and back when postponed) */
  let sweeping = null;
  function sweep() {
    if (sweeping) return sweeping;
    sweeping = api('/api/tasks/sweep', { method: 'POST', body: { now: localNow() } })
      .then(async r => {
        if (r.moved.length || r.restored.length) {
          await load(true);
          if (r.moved.length) toast(`⏰ ${r.moved.length} 張卡片已過期未結案，移到「過期未結案」`);
        }
      })
      .catch(() => {})
      .finally(() => { sweeping = null; });
    return sweeping;
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
      if (CLOSED.has(t.status) || t.mine === false) continue;     // admins see every card, but are reminded of their own
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
    const unread = notes.filter(n => !n.read).length;
    document.querySelectorAll('[data-board-badge]').forEach(b => { b.textContent = list.length + unread; b.hidden = !(list.length + unread); });
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
    return tasks.filter(t => t.mine !== false && t.repeat && t.due_at && !CLOSED.has(t.status) && at >= closeMoment(t) && !snoozed(t, at))
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
    else checkOverdueDaily();
  }

  // ------------------------------------- one-off cards past due: daily reminder
  const overdueOpen = () => tasks.filter(t => t.mine !== false && !t.repeat && t.due_at && !CLOSED.has(t.status) && isPast(t.due_at))
    .sort((a, b) => a.due_at.localeCompare(b.due_at));
  function remindTimeToday(at = now()) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(settings.board_overdue_remind_time || '') || [0, 9, 30];
    return new Date(at.getFullYear(), at.getMonth(), at.getDate(), Number(m[1]), Number(m[2]));
  }
  function checkOverdueDaily() {
    const at = now();
    const list = overdueOpen();
    if (!list.length || at < remindTimeToday(at) || store.get('board-overdue-day') === isoDate(at)) return;
    if (document.querySelector('.modal:not([hidden])')) return;
    showOverdueDialog(list);
  }

  function showOverdueDialog(list) {
    store.set('board-overdue-day', isoDate(now()));            // once a day (also when the page is reloaded)
    const rows = el('div', { class: 'kb-od-list' });
    const paintRows = () => {
      const open = overdueOpen().filter(t => list.some(x => x.id === t.id));
      if (!open.length) { close(); toast('過期的卡片都結案了 🎉'); return; }
      count.textContent = open.length;
      rows.replaceChildren(...open.map(t => {
        const tm = timing(t);
        const doneBtn = el('button', { class: 'btn btn-sm btn-primary', type: 'button', html: svg('check') + '結案' });
        const openBtn = el('button', { class: 'btn btn-sm', type: 'button', html: svg('edit') + '開啟' });
        doneBtn.addEventListener('click', async () => {
          doneBtn.disabled = openBtn.disabled = true;
          try { await complete(t); paintRows(); } catch (err) { toast(err.message, true); doneBtn.disabled = openBtn.disabled = false; }
        });
        openBtn.addEventListener('click', () => { close(); openEditor(t); });
        return el('div', { class: 'kb-od-row' },
          el('div', { class: 'kb-od-text' },
            el('strong', {}, t.priority === 'high' ? el('span', { class: 'kb-flag', html: svg('flag') }) : null, t.title),
            el('span', { class: 'kb-od-meta' },
              el('span', { class: 'kb-chip due-overdue', html: svg('clock') + `<span>${tm.dueText}</span>` }),
              el('span', { text: `到期 ${fmt(t.due_at, true)} · ${STATUS[t.status]?.zh || ''}` }))),
          el('div', { class: 'kb-od-actions' }, openBtn, doneBtn));
      }));
    };
    const count = el('span', { class: 'badge badge-alert' });
    const ok = el('button', { class: 'btn btn-primary', type: 'button', text: '知道了' });
    const goBoard = el('a', { class: 'btn btn-ghost', href: '/#/board', html: svg('kanban') + '開啟看板' });
    const time = settings.board_overdue_remind_time || '09:30';
    const wrap = el('div', { class: 'modal kb-close kb-od' },
      el('div', { class: 'modal-card kb-close-card kb-od-card', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': '過期未結案提醒' },
        el('div', { class: 'modal-head' }, el('h3', { html: svg('bell') + '過期未結案提醒' }), count),
        el('div', { class: 'modal-body' },
          el('p', { class: 'kb-close-q', text: '這些卡片已經過了到期日，還沒結案：' }),
          rows,
          el('p', { class: 'hint', text: `每天 ${time} 會再提醒一次，直到結案為止。若要延後，請在卡片裡改到期日。` })),
        el('div', { class: 'modal-foot' }, goBoard, el('span', { class: 'spacer' }), ok)));
    function close() {
      if (!wrap.isConnected) return;
      wrap.remove();
      document.removeEventListener('keydown', onKey);
      if (!document.querySelector('.modal:not([hidden])')) document.body.classList.remove('modal-open');
    }
    const onKey = e => { if (e.key === 'Escape') close(); };
    ok.addEventListener('click', close);
    goBoard.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    document.body.append(wrap);
    document.body.classList.add('modal-open');
    paintRows();
    setTimeout(() => ok.focus(), 30);
    if (canNotify()) {
      const n = new Notification(`過期未結案：${list.length} 張卡片`, {
        body: list.slice(0, 4).map(t => `• ${t.title}（${timing(t).dueText}）`).join('\n') + (list.length > 4 ? '\n…' : ''),
        tag: 'tt-overdue-daily', icon: '/assets/app/icon-192.png', requireInteraction: true,
      });
      n.onclick = () => { window.focus(); n.close(); };
    }
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
  let meInfo = { auth: false, is_admin: true, user: {}, board: { view: 'all', edit: 'all', depts: [] } };
  let notes = [];
  async function loadNotes() {
    if (!meInfo.auth) return;
    try {
      const list = await api('/api/notifications');
      const seen = store.get('board-notes-seen', 0);
      const fresh = list.filter(n => !n.read && n.id > seen);
      notes = list;
      if (fresh.length) {
        store.set('board-notes-seen', Math.max(...list.map(n => n.id)));
        if (seen) fresh.slice(0, 3).forEach(n => {           // not on the very first load
          if (canNotify()) { const x = new Notification('Tool Table', { body: n.text, tag: 'tt-note-' + n.id, icon: '/assets/app/icon-192.png' }); x.onclick = () => { window.focus(); openTask(n.task_id); }; }
          else toast('💬 ' + n.text);
        });
      }
      refreshAlerts();
    } catch { /* ignore */ }
  }
  async function openTask(id) {
    let t = tasks.find(x => x.id === id);
    if (!t) { await load(true); t = tasks.find(x => x.id === id); }
    if (t) openEditor(t); else toast('這張卡片已被刪除，或你已經看不到它了', true);
  }

  async function init(s) {
    settings = s || {};
    if (started) return;
    started = true;
    meInfo = await TT.me();
    load().then(sweep).catch(() => {});
    loadNotes();
    setInterval(loadNotes, 60 * 1000);
    setInterval(refreshAlerts, 30 * 1000);                     // time moves on: re-evaluate
    setInterval(sweep, 60 * 1000);
    setInterval(() => load(true).catch(() => {}), 5 * 60 * 1000); // pick up edits from other people
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { load(true).catch(() => {}); loadNotes(); } });
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
    let filter = opts.filter || 'all';                          // all | mine | user:<id>
    const pass = t => filter === 'all' ? true : filter === 'mine' ? t.mine !== false
      : filter.startsWith('user:') ? [t.owner, ...(t.assignees || [])].some(p => p && String(p.id) === filter.slice(5))
      : filter.startsWith('dept:') ? (t.departments || []).includes(filter.slice(5)) : true;
    const colItems = key => byStatus(key).filter(pass);
    let drag = null;                                           // { id, from }
    const placeholder = el('div', { class: 'kb-placeholder' });

    const render = () => {
      if (!root.isConnected && root.dataset.mounted) { boards.delete(render); return; }
      root.dataset.mounted = '1';
      const cols = STATUSES.filter(s => !(hideClosed && CLOSED.has(s.key)) && !(s.key === 'overdue' && !colItems('overdue').length));
      root.style.setProperty('--kb-cols', cols.length);
      root.replaceChildren(...cols.map(column));
    };

    function column(s) {
      const items = colItems(s.key);
      const list = el('div', { class: 'kb-list', dataset: { status: s.key } }, items.map(card));
      if (!items.length) list.append(el('div', { class: 'kb-empty', text: s.key === 'recurring' ? '重複性工作會排在這裡' : CLOSED.has(s.key) ? '—' : '拖曳卡片到這裡' }));
      if (s.key === 'overdue' && items.length) list.prepend(el('p', { class: 'kb-col-note', text: '過了到期日還沒結案的卡片。拖到其他欄就不會再被移回來。' }));
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
        CLOSED.has(s.key) || s.key === 'overdue' ? null : add);
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
      if (t.images?.length) chips.push(el('span', { class: 'kb-chip', title: `${t.images.length} 張圖片`, html: svg('image') + `<span>${t.images.length}</span>` }));
      const c = el('article', {
        class: `kb-card prio-${t.priority}` + (tm.due ? ` is-${tm.due}` : '') + (tm.start === 'due' ? ' is-start' : '') + (CLOSED.has(t.status) ? ' is-closed' : ''),
        draggable: t.can_edit === false ? 'false' : 'true', tabindex: '0', dataset: { id: t.id },
        title: t.can_edit === false ? '唯讀：你可以檢視與留言' : null,
      },
        t.images?.length ? el('div', { class: 'kb-cover' }, el('img', { src: t.images[0].url, alt: '', loading: 'lazy', draggable: 'false' })) : null,
        el('div', { class: 'kb-card-title' },
          t.priority === 'high' ? el('span', { class: 'kb-flag', title: '高優先', html: svg('flag') }) : null,
          el('span', { text: t.title })),
        t.description ? el('p', { class: 'kb-card-desc', text: t.description }) : null,
        chips.length ? el('div', { class: 'kb-chips' }, chips) : null,
        meInfo.auth ? cardPeople(t) : null);
      c.addEventListener('click', () => openEditor(t));
      c.addEventListener('keydown', e => { if (e.key === 'Enter') openEditor(t); });
      c.addEventListener('dragstart', e => {
        if (t.can_edit === false) { e.preventDefault(); return; }
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

    function cardPeople(t) {
      const people = t.assignees?.length ? t.assignees : t.owner ? [t.owner] : [];
      if (!people.length && !t.comments && !t.mentions?.length) return null;
      return el('div', { class: 'kb-people' },
        t.comments ? el('span', { class: 'kb-meta', title: `${t.comments} 則留言`, html: svg('message') + t.comments }) : null,
        t.mentions?.length ? el('span', { class: 'kb-meta', title: '協作：' + t.mentions.map(TT.nameOf).join('、'), html: '@' + t.mentions.length }) : null,
        el('span', { class: 'spacer' }),
        el('span', { class: 'avatars' + (t.assignees?.length ? '' : ' is-owner'), title: (t.assignees?.length ? '負責：' : '建立：') + people.map(TT.nameOf).join('、') },
          people.slice(0, 4).map(p => TT.avatar(p, 22))));
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
      setFilter(v) { filter = v; render(); },
      render,
    };
  }

  // ----------------------------------------------------------------- images
  const IMAGE_MAX = 10 * 1024 * 1024;
  const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp)$/;

  /** Image files out of a paste / drop / file-picker (others are ignored, with a message). */
  function imageFiles(list) {
    const files = [...(list || [])].filter(f => f && f.kind !== 'string').map(f => (f.getAsFile ? f.getAsFile() : f)).filter(Boolean);
    const ok = files.filter(f => IMAGE_TYPES.test(f.type) && f.size <= IMAGE_MAX);
    if (files.length > ok.length) toast(`只能加入 PNG、JPG、GIF、WebP 圖片，每張 10 MB 以內（略過 ${files.length - ok.length} 個檔案）`, true);
    return ok;
  }

  function pickImages(onFiles) {
    const input = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/gif,image/webp', multiple: '' });
    input.addEventListener('change', () => { const f = imageFiles(input.files); if (f.length) onFiles(f); });
    input.click();
  }

  async function uploadImage(taskId, file, target = 'card') {
    const form = new FormData();
    form.append('file', file, file.name || 'image.png');
    form.append('target', target);
    return api(`/api/tasks/${taskId}/images`, { method: 'POST', form });
  }

  /** Thumbnails; click opens the viewer. onRemove(img) adds a × button. */
  function thumbs(list, { onRemove, size = 'md' } = {}) {
    return el('div', { class: `kb-thumbs size-${size}` }, list.map((im, i) => {
      const pic = el('img', { src: im.url || im.preview, alt: im.name || '圖片', loading: 'lazy', draggable: 'false' });
      const t = el('div', { class: 'kb-thumb' + (im.uploading ? ' is-uploading' : ''), title: im.name || '' }, pic);
      pic.addEventListener('click', e => { e.stopPropagation(); viewImages(list, i); });
      if (onRemove && !im.uploading) {
        const x = el('button', { type: 'button', class: 'kb-thumb-x', 'aria-label': '移除圖片', title: '移除圖片', html: svg('x') });
        x.addEventListener('click', e => { e.stopPropagation(); onRemove(im); });
        t.append(x);
      }
      return t;
    }));
  }

  /** Full-size viewer (←/→ between images, Esc closes; does not close the card editor). */
  function viewImages(list, start = 0) {
    let i = start;
    const pic = el('img', { class: 'kb-viewer-img', alt: '' });
    const count = el('span', { class: 'kb-viewer-count' });
    const open = el('a', { class: 'btn btn-sm', target: '_blank', rel: 'noopener', html: svg('external') + '原圖' });
    const prev = el('button', { class: 'icon-btn kb-viewer-nav prev', type: 'button', 'aria-label': '上一張', html: '‹' });
    const next = el('button', { class: 'icon-btn kb-viewer-nav next', type: 'button', 'aria-label': '下一張', html: '›' });
    const closeBtn = el('button', { class: 'icon-btn', type: 'button', 'aria-label': '關閉', html: svg('x') });
    const box = el('div', { class: 'kb-viewer', role: 'dialog', 'aria-modal': 'true', 'aria-label': '圖片' },
      el('div', { class: 'kb-viewer-bar' }, count, el('span', { class: 'spacer' }), open, closeBtn),
      list.length > 1 ? prev : null, pic, list.length > 1 ? next : null);
    const show = () => {
      const im = list[i];
      pic.src = im.url || im.preview;
      pic.alt = im.name || '圖片';
      open.href = im.url || im.preview;
      count.textContent = (im.name ? im.name + '　' : '') + (list.length > 1 ? `${i + 1} / ${list.length}` : '');
    };
    const go = d => { i = (i + d + list.length) % list.length; show(); };
    const close = () => { box.remove(); window.removeEventListener('keydown', onKey, true); };
    const onKey = e => {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowLeft') go(-1);
      else if (e.key === 'ArrowRight') go(1);
      else return;
      e.preventDefault(); e.stopImmediatePropagation();
    };
    prev.addEventListener('click', e => { e.stopPropagation(); go(-1); });
    next.addEventListener('click', e => { e.stopPropagation(); go(1); });
    closeBtn.addEventListener('click', close);
    box.addEventListener('click', e => { if (e.target === box || e.target === pic) close(); });
    window.addEventListener('keydown', onKey, true);
    show();
    document.body.append(box);
  }

  // ----------------------------------------------------------------- editor
  function openEditor(task, defaults = {}) {
    const t = task || { title: defaults.title || '', description: '', status: defaults.status || 'new', priority: 'normal', start_at: null, due_at: null, remind: 1440, repeat: defaults.repeat || null, repeat_every: 1 };
    const split = v => { const [d, tm] = (v || '').split('T'); return [d || '', tm || '']; };
    const [sd, st] = split(t.start_at);
    const [dd, dt] = split(t.due_at);

    const title = el('input', { class: 'input kb-title-input', value: t.title, maxlength: '200', placeholder: '要做什麼？' });
    const desc = el('textarea', { class: 'textarea', rows: '4', placeholder: meInfo.auth ? '細節、連結、注意事項（選填）。輸入 @ 可以找同事一起協作' : '細節、連結、注意事項（選填）' });
    desc.value = t.description || '';
    if (meInfo.auth) TT.mentionInput(desc);

    // --- images (existing card: saved right away; new card: uploaded after 新增)
    const canImage = !task || task.can_edit !== false;
    let cardImages = task ? (task.images || []).map(x => ({ ...x })) : [];
    const imgBox = el('div', { class: 'kb-images' });
    const syncCache = () => {
      const cached = task && tasks.find(x => x.id === task.id);
      if (!cached) return;
      cached.images = cardImages.filter(x => x.id && !x.uploading).map(({ id, name, url }) => ({ id, name, url }));
      task.images = cached.images;
      changed();
    };
    function paintImages() {
      const add = canImage ? el('button', { class: 'btn btn-sm kb-img-add', type: 'button', html: svg('image') + '加入圖片' }) : null;
      add?.addEventListener('click', () => pickImages(addCardImages));
      imgBox.replaceChildren(...[
        cardImages.length ? thumbs(cardImages, { onRemove: canImage ? removeCardImage : null }) : null,
        canImage ? el('div', { class: 'kb-img-tools' }, add, el('span', { class: 'hint', text: '也可以直接貼上（Ctrl+V）或把圖片拖進這個視窗' + (task ? '；圖片會立即儲存' : '') })) : null,
        !canImage && !cardImages.length ? el('span', { class: 'hint', text: '沒有圖片' }) : null].filter(Boolean));
    }
    async function addCardImages(files) {
      for (const f of files) {
        const item = { name: f.name, preview: URL.createObjectURL(f), file: f, uploading: !!task };
        cardImages.push(item);
        paintImages();
        if (!task) continue;
        try { Object.assign(item, await uploadImage(task.id, f), { uploading: false }); syncCache(); }
        catch (e) { toast(e.message, true); cardImages = cardImages.filter(x => x !== item); }
        paintImages();
      }
    }
    async function removeCardImage(im) {
      if (task && im.id) {
        if (!confirm('移除這張圖片？')) return;
        try { await api(`/api/tasks/${task.id}/images/${im.id}`, { method: 'DELETE' }); }
        catch (e) { toast(e.message, true); return; }
      }
      cardImages = cardImages.filter(x => x !== im);
      if (im.preview) URL.revokeObjectURL(im.preview);
      paintImages();
      syncCache();
    }
    paintImages();

    // --- people (server edition)
    const canAssign = meInfo.auth && (task ? task.can_assign : meInfo.board?.edit !== 'own');
    const readOnly = !!task && task.can_edit === false;          // RO managers: view + comment
    let assignees = (t.assignees || []).map(p => ({ ...p }));
    const assignBox = el('div', { class: 'kb-assignees' });
    const assignInput = canAssign ? TT.mentionInput(el('input', { class: 'input kb-assign-input', placeholder: '輸入姓名或帳號，指派負責人…' }), {
      onPick: p => { if (!assignees.some(a => a.username === p.username)) assignees.push({ username: p.username, name: TT.nameOf(p), department: p.department }); paintAssignees(); },
    }) : null;
    function paintAssignees() {
      assignBox.replaceChildren(...assignees.map(p => el('span', { class: 'kb-person' }, TT.avatar(p, 22), el('span', { text: TT.nameOf(p) }),
        canAssign ? (() => { const x = el('button', { type: 'button', class: 'kb-person-x', 'aria-label': '移除', html: svg('x') }); x.addEventListener('click', () => { assignees = assignees.filter(a => a.username !== p.username); paintAssignees(); }); return x; })() : null)),
        ...(assignInput ? [assignInput] : assignees.length ? [] : [el('span', { class: 'hint', text: task ? '未指派（只有管理員可以指派）' : '新卡片會指派給你自己' })]));
    }
    paintAssignees();
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
    const del = task && task.can_delete !== false ? el('button', { class: 'btn btn-danger kb-del', type: 'button', html: svg('trash') + '刪除' }) : null;
    const closeBtn = el('button', { class: 'icon-btn', type: 'button', 'aria-label': '關閉', html: svg('x') });
    const meta = task ? el('p', { class: 'hint', text: (task.owner ? `${TT.nameOf(task.owner)} 建立於 ` : '建立於 ') + (task.created_at?.slice(0, 16) || '')
      + (task.completed_at ? ` · 完成於 ${task.completed_at.slice(0, 16)}` : '')
      + (task.mentions?.length ? ` · 協作：${task.mentions.map(TT.nameOf).join('、')}` : '') }) : null;

    // --- comments (existing cards)
    let addCommentImages = null;
    const comments = task ? el('section', { class: 'kb-comments' }) : null;
    if (task) {
      const listBox = el('div', { class: 'kb-comment-list' });
      const input = el('textarea', { class: 'textarea kb-comment-input', rows: '2', placeholder: meInfo.auth ? '留言…（輸入 @ 提到同事，他會收到通知）' : '留言…' });
      if (meInfo.auth) TT.mentionInput(input);
      const send = el('button', { class: 'btn btn-sm btn-primary', type: 'button', html: svg('message') + '送出' });
      const attach = el('button', { class: 'btn btn-sm kb-comment-attach', type: 'button', title: '附加圖片（也可以貼上或拖曳）', 'aria-label': '附加圖片', html: svg('image') });
      const pendingBox = el('div', { class: 'kb-comment-pending' });
      let pending = [];
      const paintPending = () => {
        pendingBox.replaceChildren(...(pending.length ? [thumbs(pending, { size: 'sm', onRemove: dropPending })] : []));
        send.disabled = pending.some(x => x.uploading);
      };
      async function dropPending(im) {
        pending = pending.filter(x => x !== im);
        paintPending();
        if (im.id) api(`/api/tasks/${task.id}/images/${im.id}`, { method: 'DELETE' }).catch(() => {});
      }
      addCommentImages = async files => {
        for (const f of files) {
          const item = { name: f.name, preview: URL.createObjectURL(f), uploading: true };
          pending.push(item);
          paintPending();
          try { Object.assign(item, await uploadImage(task.id, f, 'comment'), { uploading: false }); }
          catch (e) { toast(e.message, true); pending = pending.filter(x => x !== item); }
          paintPending();
        }
      };
      attach.addEventListener('click', () => pickImages(addCommentImages));
      const ORDER_KEY = 'tt-comment-order';
      let newestFirst = false;
      try { newestFirst = localStorage.getItem(ORDER_KEY) === 'desc'; } catch (e) { /* storage blocked */ }
      const orderBtn = el('button', { class: 'btn btn-sm btn-ghost kb-comment-order', type: 'button' });
      const paintOrder = () => {
        orderBtn.innerHTML = svg('clock') + (newestFirst ? '最新在上' : '最舊在上');
        orderBtn.title = newestFirst ? '目前依留言時間遞減（新→舊），點一下改為遞增' : '目前依留言時間遞增（舊→新），點一下改為遞減';
      };
      paintOrder();
      orderBtn.addEventListener('click', () => {
        newestFirst = !newestFirst;
        try { localStorage.setItem(ORDER_KEY, newestFirst ? 'desc' : 'asc'); } catch (e) { /* storage blocked */ }
        paintOrder();
        loadComments();
      });
      const loadComments = async () => {
        try {
          const list = await api(`/api/tasks/${task.id}/comments`);
          if (newestFirst) list.reverse();
          listBox.replaceChildren(...(list.length ? list.map(c => {
            const x = c.can_delete ? el('button', { class: 'kb-comment-del', type: 'button', title: '刪除留言', html: svg('trash') }) : null;
            x?.addEventListener('click', async () => { try { await api(`/api/tasks/${task.id}/comments/${c.id}`, { method: 'DELETE' }); loadComments(); } catch (e) { toast(e.message, true); } });
            const body = el('p', { class: 'kb-comment-body' });
            c.body.split(/(@[A-Za-z0-9._\-]+)/).forEach(part => body.append(part.startsWith('@') ? el('span', { class: 'kb-at', text: part }) : part));
            return el('div', { class: 'kb-comment' }, TT.avatar(c.author, 28),
              el('div', {}, el('div', { class: 'kb-comment-head' }, el('strong', { text: TT.nameOf(c.author) }), el('small', { text: (c.created_at || '').slice(5, 16) }), x),
                c.body ? body : null, c.images?.length ? thumbs(c.images, { size: 'sm' }) : null));
          }) : [el('p', { class: 'hint', text: '還沒有留言' })]));
          listBox.scrollTop = newestFirst ? 0 : listBox.scrollHeight;
        } catch (e) { listBox.replaceChildren(el('p', { class: 'hint', text: e.message })); }
      };
      send.addEventListener('click', async () => {
        if (!input.value.trim() && !pending.length) return;
        send.disabled = true;
        try {
          await api(`/api/tasks/${task.id}/comments`, { method: 'POST', body: { body: input.value, images: pending.map(x => x.id) } });
          input.value = '';
          pending.forEach(x => x.preview && URL.revokeObjectURL(x.preview));
          pending = [];
          paintPending();
          await loadComments(); load(true);
        }
        catch (e) { toast(e.message, true); }
        send.disabled = false;
      });
      input.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); send.click(); } });
      comments.append(el('div', { class: 'kb-comments-head' }, el('h4', { html: svg('message') + `留言${task.comments ? `（${task.comments}）` : ''}` }), orderBtn), listBox,
        pendingBox, el('div', { class: 'kb-comment-new' }, input, el('div', { class: 'kb-comment-btns' }, attach, send)));
      loadComments();
    }

    const wrap = el('div', { class: 'modal' },
      el('div', { class: 'modal-card kb-editor', role: 'dialog', 'aria-modal': 'true', 'aria-label': task ? '編輯卡片' : '新增卡片' },
        el('div', { class: 'modal-head' }, el('h3', { html: svg('kanban') + (task ? '編輯卡片' : '新增卡片') }), closeBtn),
        el('div', { class: 'modal-body' },
          field('標題', title),
          field('說明', desc),
          el('div', { class: 'field' }, el('span', { class: 'field-label', html: svg('image') + '圖片' }), imgBox),
          meInfo.auth ? el('div', { class: 'field' }, el('span', { class: 'field-label', html: svg('users') + '負責人' }), assignBox) : null,
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
          meta,
          comments),
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

    // paste / drop images: into the comment box → comment; anywhere else → the card
    const inComments = node => comments && comments.contains(node);
    wrap.addEventListener('paste', e => {
      const files = [...(e.clipboardData?.items || [])].filter(i => i.kind === 'file');
      if (!files.length) return;
      const target = inComments(e.target) ? addCommentImages : canImage ? addCardImages : null;
      if (!target) return;
      const ok = imageFiles(files);
      e.preventDefault();
      if (ok.length) target(ok);
    });
    const hasFiles = e => [...(e.dataTransfer?.types || [])].includes('Files');
    wrap.addEventListener('dragenter', e => { if (hasFiles(e)) e.stopPropagation(); });   // not the portal's "add a program" overlay
    wrap.addEventListener('dragover', e => {
      if (!hasFiles(e)) return;
      e.stopPropagation();
      const target = inComments(e.target) ? addCommentImages : canImage ? addCardImages : null;
      e.preventDefault();
      e.dataTransfer.dropEffect = target ? 'copy' : 'none';
      wrap.querySelectorAll('.kb-drop-hot').forEach(x => x.classList.remove('kb-drop-hot'));
      if (target) (inComments(e.target) ? comments : imgBox).classList.add('kb-drop-hot');
    });
    wrap.addEventListener('dragleave', e => { if (e.target === wrap || !wrap.contains(e.relatedTarget)) wrap.querySelectorAll('.kb-drop-hot').forEach(x => x.classList.remove('kb-drop-hot')); });
    wrap.addEventListener('drop', e => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      wrap.querySelectorAll('.kb-drop-hot').forEach(x => x.classList.remove('kb-drop-hot'));
      const target = inComments(e.target) ? addCommentImages : canImage ? addCardImages : null;
      const ok = imageFiles(e.dataTransfer.files);
      if (target && ok.length) target(ok);
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
      if (canAssign) body.assignees = assignees.map(p => p.username);
      if (body.start_at && body.due_at && body.start_at.slice(0, 10) > body.due_at.slice(0, 10)) { toast('開始日不能晚於到期日', true); return; }
      if (body.repeat && !body.due_at) { toast('重複的卡片需要設定到期日', true); dueD.focus(); return; }
      ok.disabled = true;
      try {
        const saved = await save(task?.id, body);
        close();
        if (!task) {
          const queued = cardImages.filter(x => x.file);
          let failed = 0;
          for (const im of queued) { try { await uploadImage(saved.id, im.file, 'card'); } catch (e) { failed++; toast(e.message, true); } }
          queued.forEach(x => URL.revokeObjectURL(x.preview));
          if (queued.length) await load(true);
          toast(`已新增「${body.title}」` + (queued.length ? `（${queued.length - failed} 張圖片）` : ''));
        }
        if (body.due_at && body.remind !== null) askPermission(true);
      } catch (err) { toast(err.message, true); ok.disabled = false; }
    }
    ok.addEventListener('click', submit);

    if (readOnly) {                                               // view + comment only
      wrap.querySelectorAll('.modal-body input, .modal-body select, .modal-body textarea:not(.kb-comment-input), .modal-body .segmented button, .kb-date-chip, .kb-wd, .kb-person-x')
        .forEach(x => { x.disabled = true; });
      ok.hidden = true;
      cancel.textContent = '關閉';
      wrap.querySelector('.modal-head h3').innerHTML = svg('kanban') + '檢視卡片';
      wrap.querySelector('.modal-body').prepend(el('div', { class: 'kb-readonly', html: svg('lock') + '<span>唯讀：這張卡片你可以檢視與留言，不能修改。</span>' }));
      if (comments) comments.querySelectorAll('input, textarea, button').forEach(x => { x.disabled = false; });
    }

    document.addEventListener('keydown', onKey);
    document.body.append(wrap);
    document.body.classList.add('modal-open');
    setTimeout(() => (readOnly ? wrap.querySelector('.kb-comment-input') || cancel : title).focus(), 30);
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
      const unread = notes.filter(n => !n.read);
      btn.title = [list.length && `${list.length} 個待辦需要注意`, unread.length && `${unread.length} 則新通知`].filter(Boolean).join('、') || '待辦提醒';
      btn.classList.toggle('has-alerts', list.length + unread.length > 0);
      if (!pop) return;
      const noteRows = notes.slice(0, 12).map(n => {
        const row = el('button', { class: 'bell-item bell-note' + (n.read ? ' is-read' : ''), type: 'button' },
          el('span', { class: 'bell-kind kind-note', html: svg(n.kind === 'comment' ? 'message' : n.kind === 'assigned' ? 'user' : 'users') }),
          el('span', { class: 'bell-text' }, el('strong', { text: n.text }), el('small', { text: (n.created_at || '').slice(5, 16) })));
        row.addEventListener('click', async () => {
          close();
          if (!n.read) { n.read = 1; api('/api/notifications/read', { method: 'POST', body: { ids: [n.id] } }).catch(() => {}); refreshAlerts(); }
          openTask(n.task_id);
        });
        return row;
      });
      const readAll = unread.length ? el('button', { class: 'section-link', type: 'button', text: '全部已讀' }) : null;
      readAll?.addEventListener('click', async () => {
        notes.forEach(n => { n.read = 1; });
        api('/api/notifications/read', { method: 'POST', body: {} }).catch(() => {});
        refreshAlerts();
      });
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
        noteRows.length ? el('div', { class: 'bell-head' }, el('strong', { text: '通知' }), readAll || el('span', { class: 'badge', text: '0' })) : null,
        noteRows.length ? el('div', { class: 'bell-list bell-notes' }, noteRows) : null,
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
