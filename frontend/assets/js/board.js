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

  // ------------------------------------------------ people on a card (focus mode)
  /** 主責: the creator when they are also an assignee, else the first assignee, else the creator. */
  const leadOf = t => (t.owner && (t.assignees || []).find(a => a.id === t.owner.id)) || t.assignees?.[0] || t.owner || null;
  /** Everyone involved in a card and in what role, each with the status that counts for them:
   *  main (主責, the card's status), sub (a subtask assigned to them, the subtask's status),
   *  collab (@mentioned / other assignee / creator without a subtask of their own, the card's status). */
  function involvement(t) {
    const out = [];
    const lead = leadOf(t);
    if (lead) out.push({ p: lead, kind: 'main', status: t.status });
    const subs = t.subtasks?.items || [];
    subs.forEach(s => { if (s.assignee) out.push({ p: s.assignee, kind: 'sub', status: s.status, sub: s }); });
    const withSub = new Set(subs.map(s => s.assignee?.id).filter(x => x != null));
    const seen = new Set([lead?.id]);
    [...(t.assignees || []), ...(t.mentions || []), t.owner].forEach(p => {
      if (!p || seen.has(p.id) || withSub.has(p.id)) return;
      seen.add(p.id);
      const why = (t.assignees || []).some(a => a.id === p.id) ? '共同負責' : (t.mentions || []).some(m => m.id === p.id) ? '@協作' : '建立者';
      out.push({ p, kind: 'collab', status: t.status, why, counts: why !== '建立者', done: !!p.done });
    });
    return out;
  }
  /** A card with (non-canceled) subtasks is a summary task: its status is computed from them. */
  const isSummary = t => (t.subtasks?.items || []).some(s => s.status !== 'canceled');
  const SUMMARY_HINT = '這張卡片有子任務，狀態依子任務與協作人自動計算；要放棄整個任務可以改成 Canceled';
  /** 卡住: how long a card has been stuck ("今天" / "3 天"). since is a UTC SQLite timestamp. */
  const isBlocked = t => !!t.blocked && !CLOSED.has(t.status);
  function blockedDays(since) {
    const at = Date.parse(String(since || '').replace(' ', 'T') + (/[zZ+]/.test(since || '') ? '' : 'Z'));
    const d = Number.isFinite(at) ? Math.floor((Date.now() - at) / 864e5) : 0;
    return d > 0 ? `${d} 天` : '今天';
  }
  /** Column load: 高負荷 from board_wip_high cards, 超量 from board_wip_over (admin setting; default ≤5 normal). */
  function wipLevel(n) {
    const high = Number(settings.board_wip_high) || 6, over = Math.max(Number(settings.board_wip_over) || 9, high + 1);
    return n >= over ? { cls: 'over', text: '超量', tip: `${n} 張：超量（≥ ${over}）` }
      : n >= high ? { cls: 'high', text: '高負荷', tip: `${n} 張：高負荷（${high}～${over - 1}）` } : null;
  }
  const expanded = new Set();             // cards whose task tree is open
  /** Main card %: finished subtasks + collaborators who marked their part done, over all of them
   *  (canceled subtasks and a creator who only handed the card out do not count). */
  function progressOf(t) {
    const subs = (t.subtasks?.items || []).filter(s => s.status !== 'canceled');
    const collab = involvement(t).filter(x => x.kind === 'collab' && x.counts);
    const total = subs.length + collab.length;
    if (!total) return null;
    const done = subs.filter(s => s.status === 'complete').length + collab.filter(x => x.done).length;
    return { done, total, pct: Math.round(done / total * 100), subs: subs.length, collab: collab.length };
  }
  async function setCollabDone(t, p, done) {
    try { await api(`/api/tasks/${t.id}/collab/${p.id}/done`, { method: 'POST', body: { done } }); await load(true); }
    catch (e) { toast(e.message, true); }
  }

  // -------------------------------------------------- multi-select + Excel export
  const selection = new Set();            // card ids
  let selecting = false;
  let selBar = null;
  function setSelecting(on) {
    selecting = on;
    if (!on) selection.clear();
    document.body.classList.toggle('kb-selecting', on);
    paintSelBar();
    boards.forEach(f => f());
  }
  function toggleSelect(id, on = !selection.has(id)) {
    if (on) selection.add(id); else selection.delete(id);
    document.querySelectorAll(`.kb-card[data-id="${id}"]`).forEach(c => {
      c.classList.toggle('is-selected', on);
      const box = c.querySelector('.kb-select input'); if (box) box.checked = on;
    });
    document.querySelectorAll('.kb-col').forEach(paintColCheck);
    paintSelBar();
  }
  const shownIds = (scope = document) => [...new Set([...scope.querySelectorAll('.kb .kb-card[data-id]')].map(c => Number(c.dataset.id)))];
  function paintColCheck(col) {
    const box = col.querySelector('.kb-col-select input');
    if (!box) return;
    const ids = shownIds(col);
    const n = ids.filter(i => selection.has(i)).length;
    box.checked = !!ids.length && n === ids.length;
    box.indeterminate = n > 0 && n < ids.length;
  }
  function paintSelBar() {
    if (!selecting) { selBar?.remove(); selBar = null; return; }
    if (!selBar) {
      const count = el('strong', { class: 'kb-selbar-count' });
      const all = el('button', { class: 'btn btn-sm btn-ghost', type: 'button', html: svg('check') + '全選目前顯示的' });
      const none = el('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: '清除選取' });
      const xls = el('button', { class: 'btn btn-sm btn-primary', type: 'button', title: '工作進度報告：一個分頁，主任務 > 子任務／協作（可在 Excel 左側 +／− 折疊），可直接列印', html: svg('download') + '匯出報告' });
      const imp = el('button', { class: 'btn btn-sm btn-ghost', type: 'button', title: '把匯出的報告（可在 Excel 修改、新增列）匯回看板，先預覽再套用', html: svg('upload') + '匯入報告…' });
      const done = el('button', { class: 'icon-btn', type: 'button', title: '結束選取（Esc）', 'aria-label': '結束選取', html: svg('x') });
      all.addEventListener('click', () => shownIds().forEach(i => toggleSelect(i, true)));
      none.addEventListener('click', () => [...selection].forEach(i => toggleSelect(i, false)));
      xls.addEventListener('click', async () => {
        if (!selection.size) { toast('先勾選要匯出的卡片', true); return; }
        xls.disabled = true;
        try { await exportXlsx([...selection]); } finally { xls.disabled = false; }
      });
      imp.addEventListener('click', () => importXlsx());
      done.addEventListener('click', () => setSelecting(false));
      selBar = el('div', { class: 'kb-selbar', role: 'toolbar', 'aria-label': '已選取的卡片' },
        el('span', { class: 'kb-selbar-text' }, count, el('span', { class: 'hint', text: '點卡片或欄位標題的方框勾選' })),
        all, none, el('span', { class: 'spacer' }), imp, xls, done);
      selBar.count = count;
      document.body.append(selBar);
    }
    selBar.count.textContent = `已選 ${selection.size} 張`;
  }
  document.addEventListener('keydown', e => { if (selecting && e.key === 'Escape' && !document.querySelector('.modal:not([hidden])')) setSelecting(false); });

  /** Download the cards as a one-sheet progress report (.xlsx): 主任務 > 子任務／協作. */
  async function exportXlsx(ids) {
    try {
      const res = await fetch('/api/tasks/export.xlsx', { method: 'POST', headers: { 'X-Tool-Table': '1', 'Content-Type': 'application/json' }, body: JSON.stringify({ ids }) });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { msg = (await res.json()).detail || msg; } catch { /* not json */ }
        throw new Error(msg);
      }
      const blob = await res.blob();
      const cd = res.headers.get('Content-Disposition') || '';
      const m = /filename\*=UTF-8''([^;]+)/i.exec(cd);
      const name = m ? decodeURIComponent(m[1]) : 'cards.xlsx';
      const url = URL.createObjectURL(blob);
      const a = el('a', { href: url, download: name });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      toast(`已匯出 ${ids.length} 張卡片：${name}`);
    } catch (e) { toast('匯出失敗：' + e.message, true); }
  }

  /** Import a report (same layout as the export): pick a file → preview what changes → apply. */
  function importXlsx() {
    if (selecting) setSelecting(false);          // the selection bar would sit on top of the dialog
    const KIND = { card: '主任務', sub: '子任務', collab: '協作' };
    const ACT = { create: ['新增', 'create'], update: ['更新', 'update'], unchanged: ['不變', 'same'], error: ['錯誤', 'error'], skip: ['略過', 'skip'] };
    const input = el('input', { type: 'file', accept: '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', hidden: true });
    const pickBtn = el('button', { class: 'btn', type: 'button', html: svg('upload') + '選擇 Excel 檔…' });
    const fileName = el('span', { class: 'hint', text: '用「匯出報告」產生的檔案；可在 Excel 修改狀態、日期、負責人，或新增列（系統ID 留空＝新增）' });
    const body = el('div', { class: 'kb-imp-body' });
    const apply = el('button', { class: 'btn btn-primary', type: 'button', disabled: true, html: svg('check') + '套用' });
    const cancel = el('button', { class: 'btn btn-ghost', type: 'button', text: '關閉' });
    let file = null;
    const wrap = el('div', { class: 'modal' },
      el('div', { class: 'modal-card kb-imp', role: 'dialog', 'aria-modal': 'true', 'aria-label': '匯入報告' },
        el('div', { class: 'modal-head' }, el('h3', { html: svg('upload') + '匯入工作進度報告' })),
        el('div', { class: 'modal-body' }, el('div', { class: 'kb-imp-pick' }, pickBtn, fileName, input), body),
        el('div', { class: 'modal-foot' }, cancel, apply)));
    const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey, true); };
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey, true);
    cancel.addEventListener('click', close);
    pickBtn.addEventListener('click', () => input.click());
    async function send(doApply) {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('apply', doApply ? 'true' : 'false');
      const res = await fetch('/api/tasks/import.xlsx', { method: 'POST', headers: { 'X-Tool-Table': '1' }, body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
      return data;
    }
    function paint(r) {
      const c = r.counts || {};
      const todo = (c.create || 0) + (c.update || 0);
      const chips = el('div', { class: 'kb-imp-counts' }, ...Object.entries(ACT).filter(([k]) => c[k]).map(([k, [label, cls]]) =>
        el('span', { class: `kb-imp-badge is-${cls}`, text: `${label} ${c[k]}` })));
      const rows = r.rows.map(o => {
        const [label, cls] = ACT[o.action] || [o.action, 'same'];
        const notes = [...o.changes.map(t => el('div', { text: t })), ...o.warnings.map(t => el('div', { class: 'warn', text: '⚠ ' + t })),
          ...o.errors.map(t => el('div', { class: 'err', text: '✕ ' + t }))];
        return el('tr', { class: `k-${o.kind}` + (o.done ? ' is-done' : '') },
          el('td', { class: 'num', text: o.row }), el('td', { text: KIND[o.kind] || o.kind }),
          el('td', { class: 'title', text: (o.kind === 'card' ? '' : '└ ') + (o.title || '') }),
          el('td', {}, el('span', { class: `kb-imp-badge is-${cls}`, text: o.done ? `✓ ${label}` : label })),
          el('td', { class: 'notes' }, ...notes));
      });
      body.replaceChildren(
        el('div', { class: 'kb-imp-sum' }, r.applied ? el('strong', { text: '已套用：' }) : el('strong', { text: '預覽：' }), chips,
          el('span', { class: 'hint', text: r.applied ? '' : (c.error ? '有錯誤的列不會匯入（底下的子任務一併略過），可以修正後重新選檔' : '確認無誤後按「套用」') })),
        el('div', { class: 'kb-imp-table' }, el('table', {},
          el('thead', {}, el('tr', {}, ...['列', '類型', '項目', '動作', '內容'].map(h => el('th', { text: h })))),
          el('tbody', {}, ...rows))));
      apply.disabled = r.applied || !todo;
      apply.innerHTML = svg('check') + (r.applied ? '已套用' : `套用 ${todo} 筆`);
    }
    input.addEventListener('change', async () => {
      file = input.files[0];
      input.value = '';
      if (!file) return;
      fileName.textContent = file.name;
      body.replaceChildren(el('p', { class: 'hint', text: '讀取中…' }));
      apply.disabled = true;
      try { paint(await send(false)); }
      catch (e) { body.replaceChildren(el('p', { class: 'kb-imp-error', text: e.message })); }
    });
    apply.addEventListener('click', async () => {
      apply.disabled = true;
      try {
        const r = await send(true);
        paint(r);
        await load(true);
        const n = r.rows.filter(o => o.done).length;
        toast(`已匯入 ${n} 筆` + (r.counts.error ? `，${r.counts.error} 筆有錯誤` : ''), !!r.counts.error);
      } catch (e) { toast('匯入失敗：' + e.message, true); apply.disabled = false; }
    });
    document.body.append(wrap);
  }

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
    if (t.op_project) opRefresh();
    return t;
  }
  /** Linked cards sync in the background a few seconds later: pick up the result for the chip / editor. */
  let opTimers = [];
  function opRefresh() {
    opTimers.forEach(clearTimeout);
    opTimers = [7000, 20000].map(ms => setTimeout(() => load(true).catch(() => {}), ms));
  }
  async function remove(id) {
    await api(`/api/tasks/${id}`, { method: 'DELETE' });
    tasks = tasks.filter(t => t.id !== id);
    changed();
  }
  async function moveTo(id, status, index) {
    const t = tasks.find(x => x.id === id);
    if (!t) return;
    if (status !== t.status && status !== 'canceled' && t.status !== 'canceled' && isSummary(t)) {
      toast(SUMMARY_HINT, true); changed(); return;
    }
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
  const fmtMin = m => { m = Math.round(m || 0); const h = Math.floor(m / 60); return h ? `${h}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m}m`; };
  /** SQLite CURRENT_TIMESTAMP (UTC) → local "M/D HH:MM" */
  const utcLocal = v => { const d = new Date(String(v).replace(' ', 'T') + 'Z'); return isNaN(d) ? v : `${d.getMonth() + 1}/${d.getDate()} ${hm(d)}`; };
  const isoDay = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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
    for (const card of tasks) {                                     // subtasks assigned to me, on any card I can see
      for (const sub of card.subtasks?.mine || []) {
        if (CLOSED.has(card.status)) continue;
        const t = { id: card.id, sub: sub.id, title: `${sub.title}（${card.title}）`, status: sub.status, due_at: sub.due_at, start_at: sub.start_at, remind: sub.remind ?? null };
        const tm = timing(t, at);
        const rm = remindMoment(t);
        if (tm.due === 'overdue') list.push({ t, card, kind: 'overdue', text: '子任務' + tm.dueText, rank: 0 });
        else if (rm && at >= rm) list.push({ t, card, kind: 'remind', text: '子任務' + (tm.dueText || `${fmt(t.due_at)} 到期`), rank: 1 });
        else if (tm.due === 'today') list.push({ t, card, kind: 'today', text: '子任務' + tm.dueText, rank: 2 });
        else if (tm.start === 'due') list.push({ t, card, kind: 'start', text: `子任務開始日 ${fmt(t.start_at)}，還在 New`, rank: 3 });
      }
    }
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
  const alertKey = a => [a.t.id + (a.t.sub ? `.${a.t.sub}` : ''), a.kind, a.t.due_at || '', a.t.start_at || '', a.t.remind ?? ''].join('|');
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
  // OpenProject sync (admin: 系統設定 → OpenProject): enabled flag + projects to link a card to
  let opInfo = null;
  async function loadOp(refresh = false) {
    if (opInfo && !refresh) return opInfo;
    try { opInfo = await api('/api/openproject' + (refresh ? '?refresh=1' : '')); } catch { opInfo = { enabled: false, projects: [] }; }
    return opInfo;
  }
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
    const teamIds = () => new Set([meInfo.user?.id, ...(meInfo.team || []).map(p => p.id)].filter(x => x != null));
    const pass = t => filter === 'all' ? true : filter === 'mine' ? t.mine !== false
      : filter === 'team' ? [t.owner, ...(t.assignees || [])].some(p => p && teamIds().has(p.id))
      : filter.startsWith('user:') ? [t.owner, ...(t.assignees || [])].some(p => p && String(p.id) === filter.slice(5))
      : filter.startsWith('dept:') ? (t.departments || []).includes(filter.slice(5)) : true;
    const inFocus = t => focusId == null || involvement(t).some(x => x.p.id === focusId);
    const colItems = key => byStatus(key).filter(t => pass(t) && (lanes || inFocus(t)));
    let drag = null;                                           // { id, from }
    let lanes = !!opts.lanes;                                  // meeting view: one row per person
    let focusId = null;                                        // focus mode: one person's work + what they are part of
    // created on first paint: on a direct page load the board can render before /me has answered
    let peopleBar = null, meetBar = null;
    const placeholder = el('div', { class: 'kb-placeholder' });

    const render = () => {
      if (!root.isConnected && root.dataset.mounted) { boards.delete(render); return; }
      root.dataset.mounted = '1';
      const cols = STATUSES.filter(s => !(hideClosed && CLOSED.has(s.key)) && !(s.key === 'overdue' && !colItems('overdue').length));
      root.style.setProperty('--kb-cols', cols.length);
      root.classList.toggle('kb-lanes', lanes);
      root.classList.toggle('kb-focus', focusId != null && !lanes);
      // focus: empty columns shrink to a slim strip so the cards get the width
      const empty = s => focusId != null && !lanes && !colItems(s.key).length;
      root.style.gridTemplateColumns = focusId != null && !lanes ? cols.map(s => empty(s) ? '52px' : 'minmax(0, 1fr)').join(' ') : '';
      if (lanes) renderLanes(cols);
      else root.replaceChildren(...cols.map(s => { const c = column(s); if (empty(s)) { c.classList.add('kb-col-empty'); c.title = `${s.label}（${s.zh}）：沒有卡片`; } return c; }));
      paintPeople();
      root.classList.toggle('is-selecting', selecting);
      if (selecting) root.querySelectorAll('.kb-col').forEach(paintColCheck);
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
          el('span', { class: 'kb-name' }, el('strong', { text: s.label }), el('span', { class: 'kb-zh' }, s.zh,
            ...(() => { const w = !CLOSED.has(s.key) && s.key !== 'recurring' ? wipLevel(items.length) : null;
              return w ? [el('span', { class: `kb-wip is-${w.cls}`, title: w.tip, text: w.text })] : []; })())),
          selecting && items.length ? (() => {
            const lab = el('label', { class: 'kb-col-select', title: '全選這一欄' }, el('input', { type: 'checkbox' }));
            lab.querySelector('input').addEventListener('change', e => { items.forEach(t => toggleSelect(t.id, e.target.checked)); });
            return lab;
          })() : null,
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

    // ------------------------------------------------ people bar (focus mode)
    function paintPeople() {
      if (!peopleBar && opts.full && meInfo.auth) {
        peopleBar = el('div', { class: 'kb-people-bar' });
        meetBar = el('div', { class: 'kb-meet' });
      }
      if (!peopleBar) return;
      if (!peopleBar.isConnected && root.isConnected) root.before(peopleBar);
      if (meetBar && !meetBar.isConnected && peopleBar.isConnected) peopleBar.before(meetBar);
      peopleBar.hidden = lanes;
      paintMeet();
      if (lanes) return;
      const counts = new Map();                                // person id → { p, byStatus }
      tasks.filter(pass).filter(t => !(hideClosed && CLOSED.has(t.status))).forEach(t => involvement(t).forEach(x => {
        if (x.p.id == null) return;
        const e = counts.get(x.p.id) || { p: x.p, n: {} };
        if (x.kind === 'main' && isBlocked(t)) e.blocked = (e.blocked || 0) + 1;
        if (x.kind === 'main' && isSummary(t)) { counts.set(x.p.id, e); return; }   // a summary card is not a task of its own
        const st = x.kind === 'collab' && x.done ? 'complete' : x.status;
        e.n[st] = (e.n[st] || 0) + 1;
        counts.set(x.p.id, e);
      }));
      const me = meInfo.user?.id;
      const team = new Set((meInfo.team || []).map(p => p.id));
      const rank = id => id === me ? 0 : team.has(id) ? 1 : 2;
      const people = [...counts.values()].sort((a, b) => rank(a.p.id) - rank(b.p.id) || TT.nameOf(a.p).localeCompare(TT.nameOf(b.p), 'zh-Hant'));
      if (focusId != null && !counts.has(focusId)) focusId = null;
      const pills = people.map(({ p, n, blocked }) => {
        const b = el('button', { class: 'kb-person-pill' + (focusId === p.id ? ' on' : focusId != null ? ' off' : ''), type: 'button',
          title: `${TT.nameOf(p)}：` + STATUSES.filter(s => n[s.key]).map(s => `${s.zh} ${n[s.key]}`).join('、') + '（主責、子任務、協作都算）' },
          TT.avatar(p, 26), el('span', { class: 'kb-pp-name', text: TT.nameOf(p) + (p.id === me ? '（我）' : '') }),
          el('span', { class: 'kb-pp-counts' }, ...STATUSES.filter(s => n[s.key]).map(s => el('span', { class: 'kb-pp-sq', style: { '--c': s.color }, text: n[s.key] })),
            ...(blocked ? [el('span', { class: 'kb-pp-blocked', title: `${blocked} 張主責卡片卡住`, text: `⛔${blocked}` })] : [])));
        b.addEventListener('click', () => setFocus(focusId === p.id ? null : p.id));
        return b;
      });
      const clear = focusId != null ? el('button', { class: 'btn btn-sm', type: 'button', html: svg('x') + '取消專注（Esc）' }) : null;
      clear?.addEventListener('click', () => setFocus(null));
      peopleBar.replaceChildren(...[el('span', { class: 'kb-pp-label', text: focusId != null ? '專注：' : '點人員專注：' }), ...pills,
        el('span', { class: 'spacer' }), clear || el('span', { class: 'kb-pp-legend' }, ...STATUSES.filter(s => !(hideClosed && CLOSED.has(s.key))).map(s => el('span', {}, el('i', { style: { '--c': s.color } }), s.zh)))].filter(Boolean));
    }
    // ------------------------------------------------ meeting: 卡住與逾期 first, then flow, people, decisions
    const MEET_STEPS = [
      ['卡住與逾期', '先排除阻礙：卡住的當場找人協助；逾期的決定延期、拆小還是取消'],
      ['工作流量', '看各欄的「高負荷／超量」：同時進行太多、或工作堆在某一欄，先收斂再開新工作'],
      ['逐人專注', '點上方人員逐一確認（有 ⛔ 的人先看），每人只談變化與需要的協助'],
      ['決議與指派', '把會議決議開成卡片或子任務，指派負責人與到期日'],
    ];
    function meetState() { try { return JSON.parse(sessionStorage.getItem('kb-meet') || 'null'); } catch { return null; } }
    function setMeet(v) { try { v ? sessionStorage.setItem('kb-meet', JSON.stringify(v)) : sessionStorage.removeItem('kb-meet'); } catch { /* private mode */ } }
    let meetTimer = null;
    function paintMeet() {
      if (!meetBar) return;
      meetBar.hidden = lanes;
      if (lanes) return;
      const m = meetState();
      const open = tasks.filter(pass).filter(t => !CLOSED.has(t.status));
      const blocked = open.filter(isBlocked).sort((a, b) => String(a.blocked.since).localeCompare(String(b.blocked.since)));
      const late = open.filter(t => !isBlocked(t) && (t.status === 'overdue' || timing(t).due === 'overdue'))
        .sort((a, b) => String(a.due_at || '').localeCompare(String(b.due_at || '')));
      const step = m ? m.step : -1;
      const showList = m ? step === 0 : !!store.get('kb-triage-open', false);
      clearInterval(meetTimer);
      const parts = [];
      if (m) {
        const clock = el('span', { class: 'kb-meet-clock' });
        const tick = () => { const sec = Math.max(0, Math.floor((Date.now() - m.start) / 1000)); clock.textContent = `⏱ ${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`; };
        tick(); meetTimer = setInterval(() => { if (!meetBar.isConnected) clearInterval(meetTimer); else tick(); }, 1000);
        const steps = MEET_STEPS.map(([name, tip], i) => {
          const b = el('button', { class: 'kb-meet-step' + (i === step ? ' on' : i < step ? ' done' : ''), type: 'button', title: tip },
            el('b', { text: i < step ? '✓' : String(i + 1) }), el('span', { text: i === 0 ? `${name}（${blocked.length + late.length}）` : name }));
          b.addEventListener('click', () => goStep(i));
          return b;
        });
        const end = el('button', { class: 'btn btn-sm btn-ghost', type: 'button', html: svg('x') + '結束會議' });
        end.addEventListener('click', () => { setMeet(null); root.classList.remove('kb-wip-spot'); paintMeet(); });
        const next = step < MEET_STEPS.length - 1 ? el('button', { class: 'btn btn-sm', type: 'button', text: '下一步 →' }) : null;
        next?.addEventListener('click', () => goStep(step + 1));
        parts.push(el('div', { class: 'kb-meet-head' }, el('strong', { class: 'kb-meet-title', text: '部門會議' }), ...steps,
          el('span', { class: 'spacer' }), clock, next, end),
          el('p', { class: 'kb-meet-tip', text: MEET_STEPS[step][1] + (step === 1 && !root.querySelector('.kb-wip')
            ? `。目前每一欄都在正常範圍（≤ ${(Number(settings.board_wip_high) || 6) - 1} 張）` : '') }));
        if (step === 3) {
          const add = el('button', { class: 'btn btn-sm btn-primary', type: 'button', html: svg('plus') + '新增決議卡片' });
          add.addEventListener('click', () => openEditor(null, { status: 'new' }));
          parts[parts.length - 1].append(' ', add);
        }
      } else {
        const toggle = el('button', { class: 'kb-meet-toggle', type: 'button', 'aria-expanded': String(showList) },
          el('span', { class: 'kb-meet-n is-blocked', text: `⛔ 卡住 ${blocked.length}` }), el('span', { class: 'kb-meet-n is-late', text: `⏰ 逾期 ${late.length}` }),
          el('span', { class: 'kb-tree-caret', text: showList ? '▾' : '▸' }));
        toggle.addEventListener('click', () => { store.set('kb-triage-open', !showList); paintMeet(); });
        const start = el('button', { class: 'btn btn-sm', type: 'button', html: svg('users') + '開始會議', title: '依「卡住與逾期 → 工作流量 → 逐人專注 → 決議」的順序開會，附計時' });
        start.addEventListener('click', () => { setMeet({ start: Date.now(), step: 0 }); setFocus(null); });
        parts.push(el('div', { class: 'kb-meet-head' }, el('strong', { class: 'kb-meet-title', text: '會議開場' }), toggle, el('span', { class: 'spacer' }), start));
      }
      if (showList) {
        const row = (t, tag, cls, why) => {
          const lead = leadOf(t);
          const r = el('button', { class: 'kb-meet-row', type: 'button', title: '開啟卡片' },
            el('span', { class: `kb-meet-tag ${cls}`, text: tag }), el('strong', { class: 'kb-meet-row-title', text: t.title }),
            lead ? TT.avatar(lead, 22) : el('span'), el('span', { class: 'kb-meet-why', text: why || '' }));
          r.addEventListener('click', () => openEditor(t));
          return r;
        };
        const lateDays = t => { const d = t.due_at ? Math.floor((now() - parse(t.due_at).date) / 864e5) : 0; return d > 0 ? `逾期 ${d} 天` : '逾期'; };
        parts.push(el('div', { class: 'kb-meet-lists' },
          el('div', { class: 'kb-meet-box' }, el('h4', {}, '⛔ 卡住', el('span', { class: 'hint', text: '先排除阻礙，誰能幫忙當場指派' })),
            ...(blocked.length ? blocked.map(t => row(t, `卡住 ${blockedDays(t.blocked.since)}`, 'is-blocked', `${t.blocked.reason}${t.blocked.by ? `（${t.blocked.by}）` : ''}`))
              : [el('p', { class: 'hint', text: '沒有卡住的卡片' })])),
          el('div', { class: 'kb-meet-box' }, el('h4', {}, '⏰ 逾期', el('span', { class: 'hint', text: '決定：延期、拆小、還是取消' })),
            ...(late.length ? late.map(t => row(t, lateDays(t), 'is-late', t.due_at ? `到期 ${fmt(t.due_at)}` : ''))
              : [el('p', { class: 'hint', text: '沒有逾期的卡片' })]))));
      }
      meetBar.replaceChildren(...parts);
      meetBar.classList.toggle('is-running', !!m);
    }
    function goStep(i) {
      const m = meetState() || { start: Date.now() };
      m.step = i;
      setMeet(m);
      root.classList.toggle('kb-wip-spot', i === 1);
      if (i !== 2) setFocus(null); else paintMeet();
    }

    function setFocus(id) {
      focusId = id;
      if (id != null) expanded.clear();
      render();
    }
    if (opts.full) document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && focusId != null && root.isConnected && !document.querySelector('.modal:not([hidden])')) setFocus(null);
    });

    // ------------------------------------------------ meeting view (swimlanes)
    /** Whose row a card goes in: its first assignee, else its creator. */
    const laneOf = t => leadOf(t);
    function renderLanes(cols) {
      const people = new Map();                                // id → person
      const me = meInfo.user?.id;
      const add = p => { if (p && !people.has(p.id ?? 'none')) people.set(p.id ?? 'none', p); };
      if (meInfo.auth && me != null) add({ id: me, username: meInfo.user.username, name: meInfo.user.display_name || meInfo.user.username, department: meInfo.user.department });
      if (filter === 'all' || filter === 'team') (meInfo.team || []).forEach(add);   // the team shows even with nothing on it
      const visible = cols.flatMap(s => colItems(s.key));
      visible.forEach(t => add(laneOf(t) || { id: 'none', name: '未指派' }));
      if (filter.startsWith('user:')) [...people.keys()].forEach(k => { if (String(k) !== filter.slice(5)) people.delete(k); });
      const teamSet = new Set((meInfo.team || []).map(p => p.id));
      const rank = p => p.id === me ? 0 : teamSet.has(p.id) ? 1 : p.id === 'none' ? 3 : 2;
      const order = [...people.values()].sort((a, b) => rank(a) - rank(b) || TT.nameOf(a).localeCompare(TT.nameOf(b), 'zh-Hant'));
      const head = el('div', { class: 'kb-lane kb-lane-head' }, el('div', { class: 'kb-lane-who' }, el('strong', { text: '人員' })),
        ...cols.map(s => el('div', { class: 'kb-lane-col', style: { '--st': s.color } }, el('span', { class: 'kb-dot' }), el('strong', { text: s.label }), el('span', { class: 'kb-zh', text: s.zh }),
          el('span', { class: 'kb-count', text: colItems(s.key).length }))));
      const rows = order.map(p => {
        const mineCards = visible.filter(t => (laneOf(t)?.id ?? 'none') === p.id);
        const overdue = mineCards.filter(t => timing(t).due === 'overdue').length;
        const open = mineCards.filter(t => !CLOSED.has(t.status)).length;
        const addBtn = p.id !== 'none' && (p.id === me || meInfo.board?.edit !== 'own' || meInfo.board?.team_edit)
          ? el('button', { class: 'kb-link-btn', type: 'button', title: p.id === me ? '新增我的卡片' : `新增卡片並指派給 ${TT.nameOf(p)}`, html: svg('plus') + '<span>新增</span>' }) : null;
        addBtn?.addEventListener('click', () => openEditor(null, { status: 'new', assignees: p.id === me ? [] : [{ id: p.id, username: p.username, name: TT.nameOf(p), department: p.department }] }));
        const who = el('div', { class: 'kb-lane-who' },
          p.id === 'none' ? el('span', { class: 'kb-lane-none', html: svg('user') }) : TT.avatar(p, 30),
          el('div', { class: 'kb-lane-name' }, el('strong', { text: TT.nameOf(p) + (p.id === me ? '（我）' : '') }),
            el('small', { text: [p.department, teamSet.has(p.id) ? '下級' : null].filter(Boolean).join(' · ') || ' ' }),
            el('span', { class: 'kb-lane-stats' }, el('span', { text: `${open} 進行` }), overdue ? el('span', { class: 'is-late', text: `${overdue} 逾期` }) : null)),
          addBtn);
        return el('div', { class: 'kb-lane' + (overdue ? ' has-late' : ''), dataset: { person: p.id } }, who,
          ...cols.map(s => laneCell(s, mineCards.filter(t => t.status === s.key).sort((a, b) => a.sort_order - b.sort_order || a.id - b.id))));
      });
      root.replaceChildren(head, ...(rows.length ? rows : [el('p', { class: 'hint kb-lane-empty', text: '沒有卡片' })]));
    }
    function laneCell(s, items) {
      const list = el('div', { class: 'kb-list kb-lane-cell', dataset: { status: s.key } }, items.map(card));
      list.addEventListener('dragover', e => {
        if (!drag || drag.lane !== list.parentElement.dataset.person) return;      // move between statuses, not people
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const after = [...list.querySelectorAll('.kb-card:not(.dragging)')].find(c => { const r = c.getBoundingClientRect(); return e.clientY < r.top + r.height / 2; });
        if (after) list.insertBefore(placeholder, after); else list.append(placeholder);
        list.classList.add('drop-over');
      });
      list.addEventListener('dragleave', e => { if (!list.contains(e.relatedTarget)) list.classList.remove('drop-over'); });
      list.addEventListener('drop', e => {
        if (!drag) return;
        e.preventDefault(); e.stopPropagation();
        const next = placeholder.nextElementSibling;
        const id = drag.id;
        drag = null;
        placeholder.remove();
        list.classList.remove('drop-over');
        // place it before the next card of this row in the column's overall order
        const colOrder = byStatus(s.key).filter(x => x.id !== id);
        const nextId = next?.classList.contains('kb-card') ? Number(next.dataset.id) : null;
        let index = nextId != null ? colOrder.findIndex(x => x.id === nextId) : -1;
        if (index < 0) {
          const last = [...list.querySelectorAll('.kb-card')].map(c => Number(c.dataset.id)).filter(x => x !== id).pop();
          index = last != null ? colOrder.findIndex(x => x.id === last) + 1 : colOrder.length;
        }
        moveTo(id, s.key, index);
      });
      return list;
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
      const sub = t.subtasks;
      if (sub?.total) {
        const counted = sub.total - sub.canceled;
        const pct = counted ? Math.round(sub.done / counted * 100) : 0;
        chips.push(el('span', { class: 'kb-chip kb-chip-sub' + (counted && sub.done === counted ? ' all-done' : ''),
          title: `子任務 ${sub.done}/${counted} 完成（${pct}%）` + (sub.spent || sub.estimate ? `\n工時 ${fmtMin(sub.spent)}${sub.estimate ? ` / 預估 ${fmtMin(sub.estimate)}` : ''}` : '')
            + (sub.start || sub.end ? `\n期間 ${sub.start ? fmt(sub.start) : '—'} → ${sub.end ? fmt(sub.end) : '—'}` : ''),
          style: { '--pct': `${pct}%` }, html: svg('check') + `<span>${sub.done}/${counted}</span>` }));
      }
      if (t.op?.work_package || t.op?.error) chips.push(el('span', { class: 'kb-chip kb-chip-op' + (t.op.error ? ' is-error' : ''),
        title: t.op.error ? `OpenProject 同步失敗：${t.op.error}` : `已同步到 OpenProject #${t.op.work_package}`, text: t.op.error ? 'OP ⚠' : `OP #${t.op.work_package}` }));
      if (sub?.timer) chips.push(el('span', { class: 'kb-chip kb-chip-timer', title: `計時中：${sub.timer.title}`, html: svg('clock') + '<span>計時中</span>' }));
      if (t.images?.length) chips.push(el('span', { class: 'kb-chip', title: `${t.images.length} 張圖片`, html: svg('image') + `<span>${t.images.length}</span>` }));
      if (t.files?.length) chips.push(el('span', { class: 'kb-chip', title: '附件：' + t.files.map(f => f.name).join('、'), html: svg('paperclip') + `<span>${t.files.length}</span>` }));
      const c = el('article', {
        class: `kb-card prio-${t.priority}` + (tm.due ? ` is-${tm.due}` : '') + (tm.start === 'due' ? ' is-start' : '') + (CLOSED.has(t.status) ? ' is-closed' : '') + (isBlocked(t) ? ' is-blocked' : ''),
        draggable: t.can_edit === false || selecting ? 'false' : 'true', tabindex: '0', dataset: { id: t.id },
        title: t.can_edit === false ? '唯讀：你可以檢視與留言' : null,
      },
        selecting ? el('label', { class: 'kb-select', title: '選取' }, el('input', { type: 'checkbox', checked: selection.has(t.id), tabindex: '-1' })) : null,
        t.images?.length ? el('div', { class: 'kb-cover' }, el('img', { src: t.images[0].url, alt: '', loading: 'lazy', draggable: 'false' })) : null,
        el('div', { class: 'kb-card-title' },
          t.priority === 'high' ? el('span', { class: 'kb-flag', title: '高優先', html: svg('flag') }) : null,
          el('span', { text: t.title }),
          t.team ? el('span', { class: 'kb-team-tag', title: '下級的卡片（你是上級，可以' + (meInfo.board?.team_edit ? '檢視、留言與增刪修）' : '檢視與留言）'), text: '下級' }) : null),
        isBlocked(t) ? el('div', { class: 'kb-blocked-bar', title: `卡住（${t.blocked.by || ''} 標記）：${t.blocked.reason}`,
          text: `⛔ 卡住 ${blockedDays(t.blocked.since)}：${t.blocked.reason}` }) : null,
        t.description ? el('p', { class: 'kb-card-desc', text: t.description }) : null,
        chips.length ? el('div', { class: 'kb-chips' }, chips) : null,
        (() => {
          const pr = progressOf(t);
          if (!pr) return null;
          return el('div', { class: 'kb-progress' + (pr.pct === 100 ? ' full' : ''), title: `完成 ${pr.done} / ${pr.total}（子任務 ${pr.subs}${pr.collab ? `、協作 ${pr.collab}` : ''}）` },
            el('span', { class: 'kb-progress-bar' }, el('span', { style: { width: pr.pct + '%' } })),
            el('span', { class: 'kb-progress-text', text: `${pr.pct}%` }));
        })(),
        meInfo.auth ? cardPeople(t) : null,
        taskTree(t));
      const lead = leadOf(t);
      if (focusId != null && !lanes && lead?.id !== focusId) {               // someone else's task I am part of
        c.classList.add('kb-card-part');
        const mine = involvement(t).filter(x => x.p.id === focusId);
        const name = TT.nameOf(mine[0]?.p || {});
        c.prepend(el('div', { class: 'kb-part-head' }, el('span', { class: 'kb-part-badge', text: '協作' }), el('span', { text: `主責：${TT.nameOf(lead || {})}` })));
        const what = mine.map(x => x.kind === 'sub' ? `子任務「${x.sub.title}」` : x.why).join('、');
        c.querySelector('.kb-tree-bar')?.before(el('div', { class: 'kb-part-note', text: `${name} 在這個任務：${what}` }));
      }
      if (selection.has(t.id)) c.classList.add('is-selected');
      if (t.team) c.classList.add('is-team');
      c.addEventListener('click', e => {
        if (selecting) { e.preventDefault(); toggleSelect(t.id); return; }
        if (e.ctrlKey || e.metaKey) { setSelecting(true); toggleSelect(t.id, true); return; }     // Ctrl/⌘-click starts selecting
        openEditor(t);
      });
      c.addEventListener('keydown', e => {
        if (e.key === 'Enter') openEditor(t);
        else if (e.key === ' ' && selecting) { e.preventDefault(); toggleSelect(t.id); }
      });
      c.addEventListener('dragstart', e => {
        if (t.can_edit === false) { e.preventDefault(); return; }
        drag = { id: t.id, lane: lanes ? String(laneOf(t)?.id ?? 'none') : null };
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

    /** "子任務 2/4 · 協作 1 ▸" — opens the task tree (subtasks and collaborators) inside the card. */
    function taskTree(t) {
      const subs = t.subtasks?.items || [];
      const collab = involvement(t).filter(x => x.kind === 'collab');
      if (!subs.length && !collab.length) return null;
      const open = expanded.has(t.id);
      const done = subs.filter(s => s.status === 'complete').length;
      const btn = el('button', { class: 'kb-tree-toggle' + (open ? ' open' : ''), type: 'button', title: open ? '收合任務樹' : '展開任務樹：子任務與協作人' },
        el('span', { text: [subs.length ? `子任務 ${done}/${subs.length}` : null, collab.length ? `協作 ${collab.filter(x => x.done).length}/${collab.filter(x => x.counts).length || collab.length}` : null].filter(Boolean).join(' · ') }),
        el('span', { class: 'kb-tree-caret', text: open ? '▾' : '▸' }));
      btn.addEventListener('click', e => { e.stopPropagation(); open ? expanded.delete(t.id) : expanded.add(t.id); render(); });
      btn.addEventListener('mousedown', e => e.stopPropagation());
      const bar = el('div', { class: 'kb-tree-bar' }, btn);
      if (!open) return bar;
      const last = subs.length + collab.length - 1;
      const nodes = [
        ...subs.map((s, i) => {
          const st = STATUS[s.status] || STATUS.new;
          const tm = timing({ status: s.status, due_at: s.due_at });
          return el('div', { class: 'kb-tree-node' + (focusId != null && s.assignee?.id === focusId ? ' me' : '') + (tm.due === 'overdue' ? ' late' : '') },
            el('span', { class: 'kb-tree-branch', text: i === last ? '└' : '├' }),
            el('div', { class: 'kb-tree-sub' },
              el('div', { class: 'kb-tree-row' }, el('span', { class: 'kb-tree-st', style: { '--c': st.color }, text: st.label }), el('span', { class: 'kb-tree-kind', text: '子任務' })),
              el('div', { class: 'kb-tree-title', text: s.title }),
              el('div', { class: 'kb-tree-row' },
                s.assignee ? el('span', { class: 'kb-tree-who' }, TT.avatar(s.assignee, 18), el('span', { text: TT.nameOf(s.assignee) })) : el('span', { class: 'hint', text: '未指派' }),
                s.due_at ? el('span', { class: `kb-chip due-${tm.due || ''}`, html: svg('clock') + `<span>${tm.dueText || fmt(s.due_at)}</span>` }) : null,
                s.estimate || s.spent ? el('span', { class: 'kb-chip', html: svg('clock') + `<span>${fmtMin(s.spent)}${s.estimate ? ' / ' + fmtMin(s.estimate) : ''}</span>` }) : null)));
        }),
        ...collab.map((x, i) => {
          const can = x.counts && (x.p.id === meInfo.user?.id || t.can_edit !== false);
          const box = x.counts ? el('label', { class: 'kb-collab-done' + (x.done ? ' on' : ''), title: can ? '標記這位協作人的部分已完成（計入主卡完成度）' : '協作人或能編輯卡片的人可以標記' },
            el('input', { type: 'checkbox', checked: x.done, disabled: !can }), el('span', { text: x.done ? '已完成' : '完成' })) : null;
          box?.querySelector('input').addEventListener('change', e => setCollabDone(t, x.p, e.target.checked));
          return el('div', { class: 'kb-tree-node collab' + (focusId != null && x.p.id === focusId ? ' me' : '') + (x.done ? ' done' : '') },
            el('span', { class: 'kb-tree-branch', text: subs.length + i === last ? '└' : '├' }),
            el('div', { class: 'kb-tree-sub kb-tree-collab' },
              el('div', { class: 'kb-tree-row' }, el('span', { class: 'kb-part-badge', text: '協作' }), el('span', { class: 'hint', text: x.why }), el('span', { class: 'spacer' }), box),
              el('div', { class: 'kb-tree-row' }, el('span', { class: 'kb-tree-who' }, TT.avatar(x.p, 18), el('span', { text: TT.nameOf(x.p) })))));
        }),
      ];
      const tree = el('div', { class: 'kb-tree' }, ...nodes);
      tree.addEventListener('click', e => e.stopPropagation());       // reading the tree does not open the card
      tree.addEventListener('dblclick', () => openEditor(t));
      return el('div', {}, bar, tree);
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
      setLanes(v) { lanes = v; render(); },
      setFocus,
      render,
    };
  }

  // ------------------------------------------------------------ attachments
  // Images show as thumbnails (click → viewer); documents as a list (click → open / download).
  // The server checks every file's content; these lists only spare a pointless upload.
  const IMAGE_MAX = 10 * 1024 * 1024;
  const FILE_MAX = 25 * 1024 * 1024;
  const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp)$/;
  const FILE_EXT = ['pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'md', 'json', 'yaml', 'yml', 'toml', 'txt', 'py', 'rs', 'mmd', 'mermaid'];
  const ACCEPT = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', ...FILE_EXT.map(e => '.' + e)].join(',');
  const ACCEPT_TEXT = '圖片（PNG、JPG、GIF、WebP，10 MB 內）、PDF、Word、Excel、PowerPoint、md、json、yaml、toml、txt、py、rs、mermaid（25 MB 內）';
  const extOf = name => ((name || '').includes('.') ? name.split('.').pop().toLowerCase() : '');
  const isImageFile = f => IMAGE_TYPES.test(f.type);
  const sizeText = n => (n == null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
  const EXT_COLOR = { pdf: '#dc2626', doc: '#2563eb', docx: '#2563eb', xls: '#16a34a', xlsx: '#16a34a', ppt: '#ea580c', pptx: '#ea580c' };

  /** Accepted files out of a paste / drop / file-picker (others are skipped, with a message). */
  function attachFiles(list) {
    const files = [...(list || [])].filter(f => f && f.kind !== 'string').map(f => (f.getAsFile ? f.getAsFile() : f)).filter(Boolean);
    const ok = files.filter(f => (isImageFile(f) ? f.size <= IMAGE_MAX : FILE_EXT.includes(extOf(f.name)) && f.size <= FILE_MAX));
    if (files.length > ok.length) toast(`略過 ${files.length - ok.length} 個檔案。可以加入：${ACCEPT_TEXT}`, true);
    return ok;
  }

  function pickFiles(onFiles) {
    const input = el('input', { type: 'file', accept: ACCEPT, multiple: '' });
    input.addEventListener('change', () => { const f = attachFiles(input.files); if (f.length) onFiles(f); });
    input.click();
  }

  async function uploadFile(taskId, file, target = 'card') {
    const form = new FormData();
    form.append('file', file, file.name || 'image.png');
    form.append('target', target);
    return api(`/api/tasks/${taskId}/images`, { method: 'POST', form });
  }

  /** A local file waiting to upload, shaped like a server attachment. */
  const localItem = f => ({ name: f.name, kind: isImageFile(f) ? 'image' : 'file', size: f.size, preview: isImageFile(f) ? URL.createObjectURL(f) : null, file: f });

  /** Thumbnails for images + rows for documents. onRemove(item) adds a × button. */
  function thumbs(list, { onRemove, size = 'md' } = {}) {
    const images = list.filter(x => x.kind !== 'file');
    const files = list.filter(x => x.kind === 'file');
    const removeBtn = item => {
      const x = el('button', { type: 'button', class: 'kb-thumb-x', 'aria-label': '移除附件', title: '移除', html: svg('x') });
      x.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); onRemove(item); });
      return x;
    };
    const grid = images.length ? el('div', { class: `kb-thumbs size-${size}` }, images.map((im, i) => {
      const pic = el('img', { src: im.url || im.preview, alt: im.name || '圖片', loading: 'lazy', draggable: 'false' });
      const t = el('div', { class: 'kb-thumb' + (im.uploading ? ' is-uploading' : ''), title: im.name || '' }, pic);
      pic.addEventListener('click', e => { e.stopPropagation(); viewImages(images, i); });
      if (onRemove && !im.uploading) t.append(removeBtn(im));
      return t;
    })) : null;
    const rows = files.length ? el('div', { class: 'kb-files' }, files.map(f => {
      const ext = extOf(f.name);
      const badge = el('span', { class: 'kb-file-ext', style: { '--ext': EXT_COLOR[ext] || 'var(--text-3)' }, text: (ext || 'file').slice(0, 4).toUpperCase() });
      const body = el('span', { class: 'kb-file-text' }, el('span', { class: 'kb-file-name', text: f.name || '檔案' }),
        el('small', { text: f.uploading ? '上傳中…' : sizeText(f.size) }));
      const open = f.url
        ? el('a', { class: 'kb-file-open', href: f.url, target: '_blank', rel: 'noopener', title: `開啟 ${f.name || ''}` }, badge, body)
        : el('span', { class: 'kb-file-open' }, badge, body);
      const row = el('div', { class: 'kb-file' + (f.url ? ' has-link' : '') + (f.uploading ? ' is-uploading' : '') }, open);
      if (f.url) {
        const dl = el('a', { class: 'kb-file-dl', href: f.url + '?download=1', download: f.name || '', title: '下載', 'aria-label': '下載', html: svg('download') });
        dl.addEventListener('click', e => e.stopPropagation());
        row.append(dl);
      }
      row.addEventListener('click', e => e.stopPropagation());
      if (onRemove && !f.uploading) row.append(removeBtn(f));
      return row;
    })) : null;
    return el('div', { class: 'kb-attach' }, grid, rows);
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

  // --------------------------------------------------------- subtask editor
  /** Everything a card has, for one subtask: title, description, attachments, status, priority,
   *  start / due (date + time), reminder, assignee, estimate. The comment's text is the description. */
  function openSubtaskEditor(card, c, onSaved) {
    const s = c.task;
    const edit = s.can_edit;
    const split = v => { const [d, tm] = (v || '').split('T'); return [d || '', tm || '']; };
    const [sd, stt] = split(s.start_at);
    const [dd, dtt] = split(s.due_at);
    const title = el('input', { class: 'input kb-title-input', value: s.title || '', maxlength: '200', disabled: !edit });
    const desc = el('textarea', { class: 'textarea', rows: '4', placeholder: '細節、步驟、注意事項…', disabled: !c.can_edit_body });
    desc.value = c.body && c.body.trim() !== (s.title || '').trim() ? c.body : '';
    if (meInfo.auth && c.can_edit_body) TT.mentionInput(desc);
    const status = el('select', { class: 'select', disabled: !s.can_update },
      STATUSES.filter(x => x.key !== 'recurring' && x.key !== 'overdue').map(x => el('option', { value: x.key, text: `${x.label}（${x.zh}）` })));
    status.value = s.status;
    let priority = s.priority || 'normal';
    const prio = el('div', { class: 'segmented', role: 'group' }, PRIORITIES.map(([v, label]) => {
      const b = el('button', { type: 'button', dataset: { v }, disabled: !edit, html: (v === 'high' ? svg('flag') : '') + `<span>${label}</span>` });
      b.addEventListener('click', () => { priority = v; paintPrio(); });
      return b;
    }));
    const paintPrio = () => prio.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === priority)));
    paintPrio();
    const startD = el('input', { class: 'input', type: 'date', value: sd, disabled: !edit });
    const startT = el('input', { class: 'input kb-time', type: 'time', value: stt, disabled: !edit, title: '時間（選填）' });
    const dueD = el('input', { class: 'input', type: 'date', value: dd, disabled: !edit });
    const dueT = el('input', { class: 'input kb-time', type: 'time', value: dtt, disabled: !edit, title: '時間（選填；不填＝當天結束前）' });
    const remind = el('select', { class: 'select', disabled: !edit }, REMINDS.map(([v, l]) => el('option', { value: v, text: l })));
    remind.value = s.remind == null ? '' : String(s.remind);
    const est = el('input', { class: 'input', type: 'number', min: '0', max: '1000', step: '0.5', placeholder: '小時', disabled: !edit,
      value: s.estimate_minutes ? String(+(s.estimate_minutes / 60).toFixed(2)) : '' });
    const value = (d, tm) => d.value ? d.value + (tm.value ? 'T' + tm.value : '') : null;
    const hint = el('p', { class: 'hint kb-remind-hint' });
    const paintHint = () => {
      const due = value(dueD, dueT);
      remind.disabled = !edit || !due;
      const rm = due ? remindMoment({ due_at: due, remind: remind.value === '' ? null : Number(remind.value) }) : null;
      hint.textContent = due ? `到期：${fmt(due, true)}${due.includes('T') ? '' : '（當天結束前）'} · ${rm ? '提醒：' + fmtMoment(rm) : '不提醒'}` : '沒有到期日就不會提醒';
    };
    [startD, startT, dueD, dueT, remind].forEach(x => x.addEventListener('input', paintHint));
    paintHint();

    // assignee
    let assignee = s.assignee ? { ...s.assignee } : null;
    const who = el('div', { class: 'kb-assignees' });
    const paintWho = () => {
      const chip = assignee ? el('span', { class: 'kb-person' }, TT.avatar(assignee, 22), el('span', { text: TT.nameOf(assignee) }),
        s.can_assign ? (() => { const x = el('button', { type: 'button', class: 'kb-person-x', 'aria-label': '取消指派', html: svg('x') }); x.addEventListener('click', () => { assignee = null; paintWho(); }); return x; })() : null) : null;
      const inp = s.can_assign ? TT.mentionInput(el('input', { class: 'input kb-assign-input', placeholder: assignee ? '改派給…' : '輸入姓名或帳號，指派負責人…' }),
        { onPick: p => { assignee = { username: p.username, name: TT.nameOf(p), department: p.department }; paintWho(); } }) : null;
      who.replaceChildren(...[chip || (inp ? null : el('span', { class: 'hint', text: '未指派' })), inp].filter(Boolean));
    };
    paintWho();

    // attachments: saved right away, like a card's
    let files = (c.images || []).map(x => ({ ...x }));
    const filesBox = el('div', { class: 'kb-images' });
    const paintFiles = () => {
      const add = c.can_edit_body ? el('button', { class: 'btn btn-sm kb-img-add', type: 'button', html: svg('paperclip') + '加入檔案' }) : null;
      add?.addEventListener('click', () => pickFiles(addFiles));
      filesBox.replaceChildren(...[
        files.length ? thumbs(files, { onRemove: c.can_edit_body ? removeFile : null }) : null,
        add ? el('div', { class: 'kb-img-tools' }, add, el('span', { class: 'hint', text: '也可以貼上（Ctrl+V）或拖進來；加入後立即儲存' })) : null,
        !add && !files.length ? el('span', { class: 'hint', text: '沒有附件' }) : null].filter(Boolean));
    };
    async function addFiles(list) {
      for (const f of list) {
        const item = { ...localItem(f), file: null, uploading: true };
        files.push(item); paintFiles();
        try {
          const form = new FormData();
          form.append('file', f, f.name || 'image.png'); form.append('target', 'comment'); form.append('comment_id', String(c.id));
          Object.assign(item, await api(`/api/tasks/${card.id}/images`, { method: 'POST', form }), { uploading: false });
          changed = true;
        } catch (e) { toast(e.message, true); files = files.filter(x => x !== item); }
        paintFiles();
      }
    }
    async function removeFile(im) {
      if (!confirm(`移除「${im.name || '這個附件'}」？`)) return;
      try { await api(`/api/tasks/${card.id}/images/${im.id}`, { method: 'DELETE' }); files = files.filter(x => x !== im); changed = true; paintFiles(); }
      catch (e) { toast(e.message, true); }
    }
    paintFiles();
    let changed = false;

    const field = (label, ...ctl) => el('label', { class: 'field' }, el('span', { class: 'field-label', text: label }), ...ctl);
    const ok = el('button', { class: 'btn btn-primary', type: 'button', html: svg('check') + '儲存' });
    const cancel = el('button', { class: 'btn btn-ghost', type: 'button', text: edit || c.can_edit_body ? '取消' : '關閉' });
    const closeBtn = el('button', { class: 'icon-btn', type: 'button', 'aria-label': '關閉', html: svg('x') });
    const spent = s.spent_minutes || 0;
    const wrap = el('div', { class: 'modal kb-sub-modal' },
      el('div', { class: 'modal-card kb-editor', role: 'dialog', 'aria-modal': 'true', 'aria-label': '子任務' },
        el('div', { class: 'modal-head' }, el('h3', { html: svg('check') + (edit ? '編輯子任務' : '檢視子任務') }), closeBtn),
        el('div', { class: 'modal-body' },
          el('p', { class: 'hint kb-sub-of', text: `「${card.title}」的子任務` }),
          !edit && !c.can_edit_body ? el('div', { class: 'kb-readonly', html: svg('lock') + '<span>唯讀：只有能編輯卡片的人或子任務負責人可以修改。</span>' }) : null,
          field('標題', title),
          field('說明', desc),
          el('div', { class: 'field' }, el('span', { class: 'field-label', html: svg('paperclip') + '附件' }), filesBox),
          meInfo.auth ? el('div', { class: 'field' }, el('span', { class: 'field-label', html: svg('user') + '負責人' }), who) : null,
          el('div', { class: 'kb-row' }, field('狀態', status), el('div', { class: 'field' }, el('span', { class: 'field-label', text: '優先順序' }), prio)),
          el('div', { class: 'kb-row' },
            el('div', { class: 'field' }, el('span', { class: 'field-label', html: svg('play') + '開始日' }), el('div', { class: 'kb-dt' }, startD, startT)),
            el('div', { class: 'field' }, el('span', { class: 'field-label', html: svg('clock') + '到期日' }), el('div', { class: 'kb-dt' }, dueD, dueT))),
          el('div', { class: 'kb-row' }, field('提醒', remind), field('預估工時（小時）', est)),
          hint,
          el('p', { class: 'hint', text: `已記錄工時 ${fmtMin(spent)}${s.estimate_minutes ? ` / 預估 ${fmtMin(s.estimate_minutes)}` : ''}（計時與明細在卡片的子任務區）` })),
        el('div', { class: 'modal-foot' }, el('span', { class: 'spacer' }), cancel, edit || c.can_edit_body || s.can_update ? ok : null)));

    const close = async () => {
      wrap.remove(); window.removeEventListener('keydown', onKey, true);
      if (changed) await onSaved?.();
    };
    const onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); close(); }
      else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopImmediatePropagation(); ok.click(); }
    };
    window.addEventListener('keydown', onKey, true);
    wrap.addEventListener('mousedown', e => { if (e.target === wrap) close(); });
    closeBtn.addEventListener('click', close);
    cancel.addEventListener('click', close);
    wrap.addEventListener('paste', e => {
      if (!c.can_edit_body) return;
      const items = [...(e.clipboardData?.items || [])].filter(i => i.kind === 'file');
      if (!items.length) return;
      e.preventDefault();
      const okFiles = attachFiles(items);
      if (okFiles.length) addFiles(okFiles);
    });
    wrap.addEventListener('dragover', e => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); e.stopPropagation(); } });
    wrap.addEventListener('drop', e => {
      if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
      e.preventDefault(); e.stopPropagation();
      if (!c.can_edit_body) return;
      const okFiles = attachFiles(e.dataTransfer.files);
      if (okFiles.length) addFiles(okFiles);
    });
    ok.addEventListener('click', async () => {
      if (edit && !title.value.trim()) { toast('請輸入標題', true); title.focus(); return; }
      const start = value(startD, startT), due = value(dueD, dueT);
      if (start && due && start.slice(0, 10) > due.slice(0, 10)) { toast('開始日不能晚於到期日', true); return; }
      const body = {};
      if (s.can_update && status.value !== s.status) body.status = status.value;
      if (edit) {
        if (title.value.trim() !== s.title) body.title = title.value.trim();
        if (priority !== (s.priority || 'normal')) body.priority = priority;
        if (start !== (s.start_at || null)) body.start_at = start;
        if (due !== (s.due_at || null)) body.due_at = due;
        const r = remind.value === '' ? null : Number(remind.value);
        if (r !== (s.remind ?? null)) body.remind = r;
        const h = parseFloat(est.value);
        const m = Number.isFinite(h) && h > 0 ? Math.round(h * 60) : null;
        if (m !== (s.estimate_minutes || null)) body.estimate_minutes = m;
      }
      if (s.can_assign && (assignee?.username || '') !== (s.assignee?.username || '')) body.assignee = assignee?.username || '';
      const oldDesc = c.body && c.body.trim() !== (s.title || '').trim() ? c.body : '';
      const newDesc = desc.value.trim();
      ok.disabled = true;
      try {
        if (Object.keys(body).length) await api(`/api/tasks/${card.id}/comments/${c.id}/task`, { method: 'PUT', body });
        if (c.can_edit_body && newDesc !== oldDesc.trim()) await api(`/api/tasks/${card.id}/comments/${c.id}`, { method: 'PUT', body: { body: newDesc || (body.title || s.title) } });
        changed = true;
        if (body.due_at && body.remind !== null && (body.remind ?? s.remind) != null) askPermission(true);
        await close();
        toast('子任務已儲存');
      } catch (e) { toast(e.message, true); ok.disabled = false; }
    });
    document.body.append(wrap);
    setTimeout(() => (edit ? title : cancel).focus(), 30);
  }

  // ----------------------------------------------------------------- editor
  function openEditor(task, defaults = {}) {
    let refreshComments = () => {};           // set once the comment list exists (卡住 adds a comment)
    const t = task || { title: defaults.title || '', description: '', status: defaults.status || 'new', priority: 'normal', start_at: null, due_at: null, remind: 1440, repeat: defaults.repeat || null, repeat_every: 1, assignees: defaults.assignees || [] };
    const split = v => { const [d, tm] = (v || '').split('T'); return [d || '', tm || '']; };
    const [sd, st] = split(t.start_at);
    const [dd, dt] = split(t.due_at);

    const title = el('input', { class: 'input kb-title-input', value: t.title, maxlength: '200', placeholder: '要做什麼？' });
    const desc = el('textarea', { class: 'textarea', rows: '4', placeholder: meInfo.auth ? '細節、連結、注意事項（選填）。輸入 @ 可以找同事一起協作' : '細節、連結、注意事項（選填）' });
    desc.value = t.description || '';
    if (meInfo.auth) TT.mentionInput(desc);

    // --- images (existing card: saved right away; new card: uploaded after 新增)
    const canImage = !task || task.can_edit !== false;
    let cardImages = task ? [...(task.images || []), ...(task.files || [])].map(x => ({ ...x })) : [];
    const imgBox = el('div', { class: 'kb-images' });
    const syncCache = () => {
      const cached = task && tasks.find(x => x.id === task.id);
      if (!cached) return;
      const saved = cardImages.filter(x => x.id && !x.uploading).map(({ id, name, url, kind, size }) => ({ id, name, url, kind, size }));
      cached.images = task.images = saved.filter(x => x.kind !== 'file');
      cached.files = task.files = saved.filter(x => x.kind === 'file');
      changed();
    };
    function paintImages() {
      const add = canImage ? el('button', { class: 'btn btn-sm kb-img-add', type: 'button', html: svg('paperclip') + '加入檔案' }) : null;
      add?.addEventListener('click', () => pickFiles(addCardImages));
      imgBox.replaceChildren(...[
        cardImages.length ? thumbs(cardImages, { onRemove: canImage ? removeCardImage : null }) : null,
        canImage ? el('div', { class: 'kb-img-tools' }, add, el('span', { class: 'hint', text: '圖片、PDF、Office、md／json／yaml／toml／txt／py／rs／mermaid；也可以貼上（Ctrl+V）或拖進這個視窗' + (task ? '，加入後立即儲存' : '') })) : null,
        !canImage && !cardImages.length ? el('span', { class: 'hint', text: '沒有附件' }) : null].filter(Boolean));
    }
    async function addCardImages(files) {
      for (const f of files) {
        const item = { ...localItem(f), uploading: !!task };
        cardImages.push(item);
        paintImages();
        if (!task) continue;
        try { Object.assign(item, await uploadFile(task.id, f), { uploading: false }); syncCache(); }
        catch (e) { toast(e.message, true); cardImages = cardImages.filter(x => x !== item); }
        paintImages();
      }
    }
    async function removeCardImage(im) {
      if (task && im.id) {
        if (!confirm(`移除「${im.name || '這個附件'}」？`)) return;
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
    const canAssign = meInfo.auth && (task ? task.can_assign : meInfo.board?.edit !== 'own' || !!meInfo.board?.team_edit);
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
    const summary = !!task && isSummary(t) && t.status !== 'canceled';
    if (summary) [...status.options].forEach(o => { o.disabled = o.value !== t.status && o.value !== 'canceled'; });
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
    const xlsBtn = task ? el('button', { class: 'btn btn-ghost', type: 'button', title: '把這張卡片（含子任務、留言、工時）匯出成 Excel', html: svg('download') + 'Excel' }) : null;
    xlsBtn?.addEventListener('click', () => exportXlsx([task.id]));
    const closeBtn = el('button', { class: 'icon-btn', type: 'button', 'aria-label': '關閉', html: svg('x') });
    // --- OpenProject: which project this card is pushed to (+ sync state)
    let opProject = t.op_project || null;
    const opBox = el('div', { class: 'field kb-op', hidden: true });
    const opSel = el('select', { class: 'select', disabled: readOnly });
    const opStatus = el('div', { class: 'kb-op-status' });
    function paintOpStatus(card) {
      const o = card?.op;
      if (!opProject) { opStatus.replaceChildren(el('span', { class: 'hint', text: '不同步：這張卡片只在 Tool Table。' })); return; }
      if (!o || (!o.work_package && !o.error)) { opStatus.replaceChildren(el('span', { class: 'hint', text: task && opProject === task.op_project ? '排隊中，幾秒後同步…' : '儲存後開始同步（卡片、子任務、留言、工時、附件）' })); return; }
      const link = o.work_package && opInfo?.url ? el('a', { href: `${opInfo.url}/work_packages/${o.work_package}`, target: '_blank', rel: 'noopener', html: svg('external') + `#${o.work_package}` }) : null;
      const now = !readOnly && task ? el('button', { class: 'kb-link-btn', type: 'button', html: svg('refresh') + '<span>立即同步</span>' }) : null;
      now?.addEventListener('click', async () => {
        now.disabled = true;
        try { await api(`/api/tasks/${task.id}/openproject/sync`, { method: 'POST' }); const fresh = await load(true); paintOpStatus(fresh.find(x => x.id === task.id)); toast('已同步到 OpenProject'); }
        catch (e) { toast(e.message, true); const fresh = await load(true); paintOpStatus(fresh.find(x => x.id === task.id)); }
        now.disabled = false;
      });
      opStatus.replaceChildren(...[
        o.error ? el('span', { class: 'kb-op-err', html: svg('x') + '<span></span>' }) : el('span', { class: 'kb-op-ok', html: svg('check') + `<span>${o.queued ? '有新變更，稍後同步' : '已同步'}${o.ok_at ? `（${utcLocal(o.ok_at)}）` : ''}</span>` }),
        link, now].filter(Boolean));
      if (o.error) opStatus.querySelector('.kb-op-err span').textContent = '同步失敗：' + o.error;
    }
    loadOp().then(info => {
      if (!info.enabled && !t.op_project) return;
      const projects = info.projects || [];
      const opts = [el('option', { value: '', text: '不同步' }),
        ...projects.map(p => el('option', { value: p.id, text: p.name + (p.id === info.default_project ? '（預設）' : '') }))];
      if (opProject && !projects.some(p => p.id === opProject)) opts.push(el('option', { value: opProject, text: `專案 #${opProject}` }));
      opSel.replaceChildren(...opts);
      opSel.value = opProject || '';
      opSel.addEventListener('change', () => { opProject = opSel.value || null; paintOpStatus(task); });
      opBox.replaceChildren(...[el('span', { class: 'field-label', html: svg('external') + 'OpenProject 同步' }),
        el('div', { class: 'kb-op-row' }, opSel, opStatus),
        info.error ? el('p', { class: 'hint', text: '讀取專案清單失敗：' + info.error }) : null].filter(Boolean));
      paintOpStatus(task);
      opBox.hidden = false;
    });

    const meta = task ? el('p', { class: 'hint', text: (task.owner ? `${TT.nameOf(task.owner)} 建立於 ` : '建立於 ') + (task.created_at?.slice(0, 16) || '')
      + (task.completed_at ? ` · 完成於 ${task.completed_at.slice(0, 16)}` : '')
      + (task.mentions?.length ? ` · 協作：${task.mentions.map(TT.nameOf).join('、')}` : '') }) : null;

    // --- comments → threads + subtasks (existing cards). The card is the summary task;
    //     a top-level comment can become a subtask with its own status, dates, assignee and time log.
    let addCommentImages = null;
    const comments = task ? el('section', { class: 'kb-comments' }) : null;
    let stopTicker = () => {};
    if (task) {
      const listBox = el('div', { class: 'kb-comment-list' });
      const rollBox = el('div', { class: 'kb-rollup' });
      const input = el('textarea', { class: 'textarea kb-comment-input', rows: '2', placeholder: meInfo.auth ? '留言…（輸入 @ 提到同事，他會收到通知）' : '留言…' });
      if (meInfo.auth) TT.mentionInput(input);
      const send = el('button', { class: 'btn btn-sm btn-primary', type: 'button', html: svg('message') + '送出' });
      const attach = el('button', { class: 'btn btn-sm kb-comment-attach', type: 'button', title: '附加圖片或檔案（也可以貼上或拖曳）', 'aria-label': '附加檔案', html: svg('paperclip') });
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
          const item = { ...localItem(f), file: null, uploading: true };
          pending.push(item);
          paintPending();
          try { Object.assign(item, await uploadFile(task.id, f, 'comment'), { uploading: false }); }
          catch (e) { toast(e.message, true); pending = pending.filter(x => x !== item); }
          paintPending();
        }
      };
      attach.addEventListener('click', () => pickFiles(addCommentImages));

      const ORDER_KEY = 'tt-comment-order';
      const VIEW_KEY = 'tt-comment-view';
      let newestFirst = false;
      let onlyTasks = false;
      try { newestFirst = localStorage.getItem(ORDER_KEY) === 'desc'; onlyTasks = localStorage.getItem(VIEW_KEY) === 'tasks'; } catch (e) { /* storage blocked */ }
      const orderBtn = el('button', { class: 'btn btn-sm btn-ghost kb-comment-order', type: 'button' });
      const viewBtn = el('button', { class: 'btn btn-sm btn-ghost kb-comment-order', type: 'button' });
      const paintOrder = () => {
        orderBtn.innerHTML = svg('clock') + (newestFirst ? '最新在上' : '最舊在上');
        orderBtn.title = newestFirst ? '目前依留言時間遞減（新→舊），點一下改為遞增' : '目前依留言時間遞增（舊→新），點一下改為遞減';
        viewBtn.innerHTML = svg('check') + (onlyTasks ? '只看子任務' : '全部留言');
        viewBtn.title = onlyTasks ? '目前只列出子任務，點一下顯示全部留言' : '點一下只列出子任務';
      };
      paintOrder();
      orderBtn.addEventListener('click', () => {
        newestFirst = !newestFirst;
        try { localStorage.setItem(ORDER_KEY, newestFirst ? 'desc' : 'asc'); } catch (e) { /* storage blocked */ }
        paintOrder(); paint();
      });
      viewBtn.addEventListener('click', () => {
        onlyTasks = !onlyTasks;
        try { localStorage.setItem(VIEW_KEY, onlyTasks ? 'tasks' : 'all'); } catch (e) { /* storage blocked */ }
        paintOrder(); paint();
      });

      let threads = [];
      let fetchedAt = Date.now();
      let replyTo = null;                 // { root, mention }
      let openLogs = new Set();           // subtasks whose time log is expanded
      let openTime = null;                // subtask id with the "add time" form open

      const subPut = async (c, body) => {
        try { await api(`/api/tasks/${task.id}/comments/${c.id}/task`, { method: 'PUT', body }); await loadComments(); load(true); }
        catch (e) { toast(e.message, true); await loadComments(); }
      };
      const renderBody = text => {
        const body = el('p', { class: 'kb-comment-body' });
        text.split(/(@[A-Za-z0-9._\-]+)/).forEach(part => body.append(part.startsWith('@') ? el('span', { class: 'kb-at', text: part }) : part));
        return body;
      };
      const delBtn = (c, isRoot) => {
        if (!c.can_delete) return null;
        const x = el('button', { class: 'kb-comment-del', type: 'button', title: isRoot && c.replies?.length ? '刪除留言（連同回覆）' : '刪除留言', html: svg('trash') });
        x.addEventListener('click', async () => {
          const what = c.task ? `子任務「${c.task.title}」（含工時記錄${c.replies?.length ? '與回覆' : ''}）` : c.replies?.length ? `這則留言與 ${c.replies.length} 則回覆` : '這則留言';
          if ((c.task || c.replies?.length) && !confirm(`刪除${what}？`)) return;
          try { await api(`/api/tasks/${task.id}/comments/${c.id}`, { method: 'DELETE' }); await loadComments(); load(true); } catch (e) { toast(e.message, true); }
        });
        return x;
      };
      const linkBtn = (label, icon, fn, title) => {
        const b = el('button', { class: 'kb-link-btn', type: 'button', title: title || label, html: svg(icon) + `<span>${label}</span>` });
        b.addEventListener('click', fn);
        return b;
      };

      function subtaskBox(c) {
        const s = c.task;
        const st = STATUS[s.status] || STATUS.new;
        const box = el('div', { class: `kb-sub st-${s.status}`, style: { '--st': st.color } });
        const edit = s.can_edit;
        // row 1: status + title
        const stSel = el('select', { class: 'select kb-sub-status', title: '子任務狀態', disabled: !s.can_update },
          STATUSES.filter(x => x.key !== 'recurring' && x.key !== 'overdue').map(x => el('option', { value: x.key, text: `${x.label}（${x.zh}）` })));
        stSel.value = s.status;
        stSel.addEventListener('change', () => subPut(c, { status: stSel.value }));
        const titleIn = el('input', { class: 'input kb-sub-title', value: s.title || '', maxlength: '200', disabled: !edit, title: '子任務名稱' });
        titleIn.addEventListener('change', () => { if (titleIn.value.trim() && titleIn.value.trim() !== s.title) subPut(c, { title: titleIn.value.trim() }); else titleIn.value = s.title; });
        titleIn.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); titleIn.blur(); } });
        const tm = timing({ status: s.status, due_at: s.due_at, start_at: s.start_at });
        const dueChip = tm.due && tm.due !== 'later' ? el('span', { class: `kb-chip due-${tm.due}`, html: svg('clock') + `<span>${tm.dueText}</span>` }) : null;
        const editBtn = el('button', { class: 'kb-link-btn kb-sub-edit', type: 'button', title: edit ? '編輯子任務（說明、附件、時間、提醒…）' : '檢視子任務', html: svg(edit ? 'edit' : 'external') + `<span>${edit ? '編輯' : '檢視'}</span>` });
        editBtn.addEventListener('click', () => openSubtaskEditor(task, c, async () => { await loadComments(); load(true); }));
        box.append(el('div', { class: 'kb-sub-row' }, el('span', { class: 'kb-sub-dot' }), stSel,
          s.priority === 'high' ? el('span', { class: 'kb-flag', title: '高優先', html: svg('flag') }) : null, titleIn,
          s.due_at && s.remind != null && !CLOSED.has(s.status) ? el('span', { class: 'kb-chip remind', title: `提醒：${fmtMoment(remindMoment(s))}`, html: svg('bell') }) : null,
          dueChip, editBtn));

        // row 2: assignee, start, due, estimate
        const fields = el('div', { class: 'kb-sub-fields' });
        if (meInfo.auth) {
          const who = el('div', { class: 'kb-sub-who' });
          const paintWho = () => {
            const chip = s.assignee
              ? el('span', { class: 'kb-person' }, TT.avatar(s.assignee, 20), el('span', { text: TT.nameOf(s.assignee) }),
                s.can_assign ? (() => { const x = el('button', { type: 'button', class: 'kb-person-x', 'aria-label': '取消指派', html: svg('x') }); x.addEventListener('click', () => subPut(c, { assignee: '' })); return x; })() : null)
              : null;
            const pickBtn = s.can_assign ? el('button', { class: 'kb-link-btn', type: 'button', html: svg('user') + `<span>${s.assignee ? '改派' : '指派'}</span>` }) : null;
            pickBtn?.addEventListener('click', () => {
              const inp = TT.mentionInput(el('input', { class: 'input input-sm kb-sub-assign', placeholder: '輸入姓名或帳號…' }), { onPick: p => subPut(c, { assignee: p.username }) });
              inp.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); paintWho(); } });
              inp.addEventListener('blur', () => setTimeout(() => inp.isConnected && paintWho(), 200));
              who.replaceChildren(inp);
              inp.focus();
            });
            who.replaceChildren(...[chip || el('span', { class: 'hint', text: '未指派' }), pickBtn].filter(Boolean));
          };
          paintWho();
          fields.append(el('label', { class: 'kb-sub-field' }, el('span', { html: svg('user') + '負責' }), who));
        }
        const dateIn = (key, label, icon) => {
          if (!edit) return el('label', { class: 'kb-sub-field' }, el('span', { html: svg(icon) + label }), el('span', { class: 'kb-sub-ro', text: s[key] ? fmt(s[key], true) : '—' }));
          const inp = el('input', { class: 'input input-sm', type: 'date', value: (s[key] || '').slice(0, 10), title: s[key]?.includes('T') ? `時間 ${s[key].slice(11, 16)}（在「編輯」裡修改）` : '' });
          inp.addEventListener('change', () => subPut(c, { [key]: inp.value ? inp.value + (s[key]?.includes('T') ? s[key].slice(10) : '') : null }));
          return el('label', { class: 'kb-sub-field' }, el('span', { html: svg(icon) + label }), inp);
        };
        fields.append(dateIn('start_at', '開始', 'play'), dateIn('due_at', '到期', 'clock'));
        const est = !edit ? el('span', { class: 'kb-sub-ro', text: s.estimate_minutes ? fmtMin(s.estimate_minutes) : '—' })
          : el('input', { class: 'input input-sm kb-sub-est', type: 'number', min: '0', max: '1000', step: '0.5', placeholder: '—',
            value: s.estimate_minutes ? String(+(s.estimate_minutes / 60).toFixed(2)) : '' });
        if (edit) est.addEventListener('change', () => {
          const h = parseFloat(est.value);
          subPut(c, { estimate_minutes: Number.isFinite(h) && h > 0 ? Math.round(h * 60) : null });
        });
        fields.append(el('label', { class: 'kb-sub-field' }, el('span', { html: svg('calendar') + (edit ? '預估（小時）' : '預估') }), est));
        box.append(fields);

        // row 3: time tracking
        const spent = s.spent_minutes || 0;
        const pct = s.estimate_minutes ? Math.min(100, Math.round(spent / s.estimate_minutes * 100)) : null;
        const over = s.estimate_minutes && spent > s.estimate_minutes;
        const bar = s.estimate_minutes ? el('span', { class: 'kb-bar' + (over ? ' over' : ''), title: `${pct}%` }, el('span', { style: { width: `${pct}%` } })) : null;
        const running = s.my_timer;
        const clock = running ? el('span', { class: 'kb-timer-clock', dataset: { elapsed: running.elapsed } }) : null;
        const timerBtn = s.can_update && (running || !CLOSED.has(s.status))
          ? el('button', { class: 'btn btn-sm ' + (running ? 'btn-danger' : ''), type: 'button', html: running ? '■ 停止' : '▶ 開始計時' }) : null;
        timerBtn?.addEventListener('click', async () => {
          timerBtn.disabled = true;
          try { await api(`/api/tasks/${task.id}/comments/${c.id}/timer`, { method: 'POST', body: { action: running ? 'stop' : 'start', work_date: isoDay(now()) } }); }
          catch (e) { toast(e.message, true); }
          await loadComments(); load(true);
        });
        const addBtn = s.can_update ? linkBtn('記錄工時', 'plus', () => { openTime = openTime === c.id ? null : c.id; paint(); }) : null;
        const othersRunning = s.entries.filter(e => e.running && !(running && e.id === running.id));
        const logBtn = s.entries.length ? linkBtn(`明細（${s.entries.length}）`, 'list', () => { openLogs.has(c.id) ? openLogs.delete(c.id) : openLogs.add(c.id); paint(); }) : null;
        box.append(el('div', { class: 'kb-sub-time' },
          el('span', { class: 'kb-sub-hours', html: svg('clock') + `<span>已記錄 <b>${fmtMin(spent)}</b>${s.estimate_minutes ? ` / 預估 ${fmtMin(s.estimate_minutes)}` : ''}</span>` }),
          bar, othersRunning.length ? el('span', { class: 'hint', text: `${othersRunning.map(e => TT.nameOf(e.user || {})).join('、')} 計時中` }) : null,
          el('span', { class: 'spacer' }), clock, timerBtn, addBtn, logBtn));
        if (openTime === c.id) box.append(timeForm(c));
        if (openLogs.has(c.id) && s.entries.length) {
          box.append(el('div', { class: 'kb-time-log' }, s.entries.map(e => {
            const x = e.can_delete && !e.running ? el('button', { class: 'kb-comment-del', type: 'button', title: '刪除這筆工時', html: svg('trash') }) : null;
            x?.addEventListener('click', async () => {
              try { await api(`/api/tasks/${task.id}/comments/${c.id}/time/${e.id}`, { method: 'DELETE' }); await loadComments(); load(true); } catch (err) { toast(err.message, true); }
            });
            return el('div', { class: 'kb-time-row' },
              el('span', { class: 'kb-time-date', text: e.work_date ? e.work_date.slice(5).replace('-', '/') : '' }),
              meInfo.auth && e.user ? el('span', { class: 'kb-time-user', text: TT.nameOf(e.user) }) : null,
              el('b', { text: e.running ? '計時中…' : fmtMin(e.minutes) }),
              el('span', { class: 'kb-time-note', text: e.note || '' }), x);
          })));
        }
        if (s.completed_at && s.status === 'complete') box.append(el('p', { class: 'hint kb-sub-done', text: `完成於 ${s.completed_at.slice(0, 16)}` }));
        return box;
      }

      function timeForm(c) {
        const h = el('input', { class: 'input input-sm', type: 'number', min: '0', max: '24', step: '1', value: '1', 'aria-label': '小時' });
        const m = el('input', { class: 'input input-sm', type: 'number', min: '0', max: '59', step: '5', value: '0', 'aria-label': '分鐘' });
        const day = el('input', { class: 'input input-sm', type: 'date', value: isoDay(now()) });
        const note = el('input', { class: 'input input-sm kb-time-note-in', maxlength: '200', placeholder: '做了什麼（選填）' });
        const ok = el('button', { class: 'btn btn-sm btn-primary', type: 'button', text: '記錄' });
        ok.addEventListener('click', async () => {
          const minutes = (parseInt(h.value, 10) || 0) * 60 + (parseInt(m.value, 10) || 0);
          if (minutes < 1) { toast('請輸入工時', true); return; }
          ok.disabled = true;
          try {
            await api(`/api/tasks/${task.id}/comments/${c.id}/time`, { method: 'POST', body: { minutes, note: note.value, work_date: day.value || null } });
            openTime = null; openLogs.add(c.id);
            await loadComments(); load(true);
          } catch (e) { toast(e.message, true); ok.disabled = false; }
        });
        note.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); ok.click(); } });
        return el('div', { class: 'kb-time-form' }, h, el('span', { text: '小時' }), m, el('span', { text: '分' }), day, note, ok);
      }

      let editing = null;                 // comment id being edited inline
      function editBox(c) {
        const box = el('textarea', { class: 'textarea kb-reply-input', rows: '3' });
        box.value = c.body || '';
        if (meInfo.auth) TT.mentionInput(box);
        const ok = el('button', { class: 'btn btn-sm btn-primary', type: 'button', text: '儲存' });
        const cancel = el('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: '取消' });
        cancel.addEventListener('click', () => { editing = null; paint(); });
        ok.addEventListener('click', async () => {
          ok.disabled = true;
          try { await api(`/api/tasks/${task.id}/comments/${c.id}`, { method: 'PUT', body: { body: box.value } }); editing = null; await loadComments(); load(true); }
          catch (e) { toast(e.message, true); ok.disabled = false; }
        });
        box.addEventListener('keydown', e => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); ok.click(); }
          if (e.key === 'Escape') { e.stopPropagation(); cancel.click(); }
        });
        setTimeout(() => box.focus(), 0);
        return el('div', { class: 'kb-reply-new' }, box, el('div', { class: 'kb-comment-btns' }, ok, cancel));
      }

      function replyBox(root) {
        const box = el('textarea', { class: 'textarea kb-reply-input', rows: '2', placeholder: `回覆 ${TT.nameOf(root.author)}…（Ctrl+Enter 送出，Esc 取消）` });
        if (meInfo.auth) TT.mentionInput(box);
        if (replyTo.mention) box.value = `@${replyTo.mention} `;
        const go = el('button', { class: 'btn btn-sm btn-primary', type: 'button', text: '回覆' });
        const cancel = el('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: '取消' });
        cancel.addEventListener('click', () => { replyTo = null; paint(); });
        go.addEventListener('click', async () => {
          if (!box.value.trim()) return;
          go.disabled = true;
          try { await api(`/api/tasks/${task.id}/comments`, { method: 'POST', body: { body: box.value, parent_id: root.id } }); replyTo = null; await loadComments(); load(true); }
          catch (e) { toast(e.message, true); go.disabled = false; }
        });
        box.addEventListener('keydown', e => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); go.click(); }
          if (e.key === 'Escape') { e.stopPropagation(); cancel.click(); }
        });
        setTimeout(() => { box.focus(); box.setSelectionRange(box.value.length, box.value.length); }, 0);
        return el('div', { class: 'kb-reply-new' }, box, el('div', { class: 'kb-comment-btns' }, go, cancel));
      }

      function commentNode(c, root) {
        const isRoot = !root;
        const actions = el('span', { class: 'kb-comment-actions' },
          linkBtn('回覆', 'message', () => { replyTo = { root: (root || c).id, mention: isRoot ? null : c.author?.username }; paint(); }),
          c.can_edit_body && !c.task ? linkBtn('編輯', 'edit', () => { editing = c.id; paint(); }) : null,
          isRoot && c.can_make_task ? (c.task
            ? linkBtn('取消子任務', 'x', () => { if (confirm(`把「${c.task.title}」改回一般留言？（工時記錄會保留）`)) subPut(c, { is_task: false }); }, '改回一般留言')
            : linkBtn('設為子任務', 'check', () => subPut(c, { is_task: true }), '把這則留言變成這張卡片的子任務（可設定狀態、負責人、日期與工時）')) : null,
          delBtn(c, isRoot));
        const node = el('div', { class: 'kb-comment' + (isRoot ? '' : ' is-reply') + (c.task ? ' is-task' : ''), dataset: { cid: c.id } }, TT.avatar(c.author, isRoot ? 28 : 22),
          el('div', { class: 'kb-comment-main' },
            el('div', { class: 'kb-comment-head' }, el('strong', { text: TT.nameOf(c.author) }), el('small', { text: (c.created_at || '').slice(5, 16) }), actions),
            c.task ? subtaskBox(c) : null,
            editing === c.id ? editBox(c)
              : c.body && !(c.task && c.body.trim() === (c.task.title || '').trim()) ? renderBody(c.body) : null,
            c.edited_at && editing !== c.id ? el('small', { class: 'kb-edited', text: '（已編輯）' }) : null,
            c.images?.length ? thumbs(c.images, { size: 'sm' }) : null,
            isRoot && c.replies.length ? el('div', { class: 'kb-replies' }, c.replies.map(r => commentNode(r, c))) : null,
            isRoot && replyTo?.root === c.id ? replyBox(c) : null));
        return node;
      }

      const byOrder = (a, b) => (a.task.sort_order ?? a.id) - (b.task.sort_order ?? b.id) || a.id - b.id;
      const canOrder = () => threads.some(c => c.can_make_task);
      async function saveOrder(ids) {
        try { await api(`/api/tasks/${task.id}/subtasks/order`, { method: 'POST', body: { ids } }); } catch (e) { toast(e.message, true); }
        await loadComments(); load(true);
      }
      /** Ordered outline of the subtasks: click to jump, drag (or Alt+↑/↓) to reorder. */
      function outline(subs) {
        const editable = canOrder();
        const list = el('ol', { class: 'kb-outline' + (editable ? ' can-drag' : '') });
        let dragId = null;
        subs.forEach((c, i) => {
          const s = c.task;
          const st = STATUS[s.status] || STATUS.new;
          const tm = timing({ status: s.status, due_at: s.due_at });
          const row = el('li', { class: `kb-outline-row st-${s.status}`, style: { '--st': st.color }, tabindex: '0', draggable: editable ? 'true' : 'false',
            dataset: { id: c.id }, title: editable ? '點一下跳到子任務；拖曳或 Alt+↑/↓ 調整順序' : '點一下跳到子任務' },
            editable ? el('span', { class: 'kb-outline-grip', html: svg('grip') }) : null,
            el('span', { class: 'kb-outline-no', text: String(i + 1) }),
            el('span', { class: 'kb-sub-dot' }),
            el('span', { class: 'kb-outline-title', text: s.title }),
            meInfo.auth && s.assignee ? TT.avatar(s.assignee, 18) : null,
            s.due_at ? el('span', { class: `kb-outline-due due-${tm.due || ''}`, text: fmt(s.due_at) }) : null);
          row.addEventListener('click', () => {
            const target = listBox.querySelector(`.kb-comment[data-cid="${c.id}"]`);
            if (!target) { onlyTasks = false; paintOrder(); paint(); }
            const t2 = listBox.querySelector(`.kb-comment[data-cid="${c.id}"]`);
            t2?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            t2?.classList.add('kb-flash'); setTimeout(() => t2?.classList.remove('kb-flash'), 1200);
          });
          if (editable) {
            row.addEventListener('keydown', e => {
              if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
              e.preventDefault(); e.stopPropagation();
              const ids = subs.map(x => x.id);
              const j = i + (e.key === 'ArrowUp' ? -1 : 1);
              if (j < 0 || j >= ids.length) return;
              [ids[i], ids[j]] = [ids[j], ids[i]];
              saveOrder(ids).then(() => rollBox.querySelector(`.kb-outline-row[data-id="${c.id}"]`)?.focus());
            });
            row.addEventListener('dragstart', e => {
              dragId = c.id;
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('application/x-tool-table-subtask', String(c.id));
              requestAnimationFrame(() => row.classList.add('dragging'));
            });
            row.addEventListener('dragend', () => { dragId = null; row.classList.remove('dragging'); list.querySelectorAll('.drop-before,.drop-after').forEach(x => x.classList.remove('drop-before', 'drop-after')); });
            row.addEventListener('dragover', e => {
              if (!dragId || dragId === c.id) return;
              e.preventDefault(); e.stopPropagation();
              const r = row.getBoundingClientRect();
              const after = e.clientY > r.top + r.height / 2;
              list.querySelectorAll('.drop-before,.drop-after').forEach(x => x.classList.remove('drop-before', 'drop-after'));
              row.classList.add(after ? 'drop-after' : 'drop-before');
            });
            row.addEventListener('drop', e => {
              if (!dragId || dragId === c.id) return;
              e.preventDefault(); e.stopPropagation();
              const after = row.classList.contains('drop-after');
              const ids = subs.map(x => x.id).filter(x => x !== dragId);
              ids.splice(ids.indexOf(c.id) + (after ? 1 : 0), 0, dragId);
              dragId = null;
              saveOrder(ids);
            });
          }
          list.append(row);
        });
        return list;
      }

      function paintRollup() {
        const subs = threads.filter(c => c.task).sort(byOrder);
        if (!subs.length) { rollBox.replaceChildren(); rollBox.hidden = true; return; }
        rollBox.hidden = false;
        const done = subs.filter(c => c.task.status === 'complete').length;
        const counted = subs.filter(c => c.task.status !== 'canceled').length;
        const pct = counted ? Math.round(done / counted * 100) : 0;
        const est = subs.reduce((a, c) => a + (c.task.estimate_minutes || 0), 0);
        const spent = subs.reduce((a, c) => a + (c.task.spent_minutes || 0), 0);
        const starts = subs.map(c => c.task.start_at).filter(Boolean).sort();
        const dues = subs.map(c => c.task.due_at).filter(Boolean).sort();
        const late = subs.filter(c => timing({ status: c.task.status, due_at: c.task.due_at }).due === 'overdue').length;
        rollBox.replaceChildren(
          el('div', { class: 'kb-rollup-head' },
            el('strong', { html: svg('check') + `子任務 ${done} / ${counted} 完成` }), el('span', { class: 'kb-rollup-pct', text: `${pct}%` })),
          el('span', { class: 'kb-bar big' }, el('span', { style: { width: `${pct}%` } })),
          el('div', { class: 'kb-rollup-meta' },
            el('span', { text: `工時 ${fmtMin(spent)}${est ? ` / 預估 ${fmtMin(est)}` : ''}` }),
            starts.length || dues.length ? el('span', { text: `期間 ${starts.length ? fmt(starts[0]) : '—'} → ${dues.length ? fmt(dues[dues.length - 1]) : '—'}` }) : null,
            late ? el('span', { class: 'kb-rollup-late', text: `${late} 項逾期` }) : null,
            subs.length > counted ? el('span', { text: `${subs.length - counted} 項取消` }) : null),
          outline(subs));
      }

      function paint() {
        paintRollup();
        let list = onlyTasks ? threads.filter(c => c.task).sort(byOrder) : threads.slice();
        if (newestFirst && !onlyTasks) list.reverse();
        listBox.replaceChildren(...(list.length ? list.map(c => commentNode(c, null))
          : [el('p', { class: 'hint', text: onlyTasks ? '還沒有子任務：在留言上按「設為子任務」' : '還沒有留言' })]));
        tick();
      }
      function tick() {
        const delta = Math.floor((Date.now() - fetchedAt) / 1000);
        listBox.querySelectorAll('.kb-timer-clock').forEach(x => {
          const sec = Number(x.dataset.elapsed) + delta;
          x.textContent = `${Math.floor(sec / 3600)}:${pad(Math.floor(sec / 60) % 60)}:${pad(sec % 60)}`;
        });
      }
      const ticker = setInterval(() => { if (!listBox.isConnected && fetchedAt) return; tick(); }, 1000);
      stopTicker = () => clearInterval(ticker);

      const loadComments = async () => {
        refreshComments = loadComments;
        try {
          threads = await api(`/api/tasks/${task.id}/comments`);
          fetchedAt = Date.now();
          paint();
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
          if (newestFirst) listBox.scrollTop = 0;
        }
        catch (e) { toast(e.message, true); }
        send.disabled = false;
      });
      input.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); e.stopPropagation(); send.click(); } });
      comments.append(
        el('div', { class: 'kb-comments-head' }, el('h4', { html: svg('message') + `留言與子任務${task.comments ? `（${task.comments}）` : ''}` }),
          el('span', { class: 'kb-comments-tools' }, viewBtn, orderBtn)),
        rollBox, listBox, pendingBox,
        el('div', { class: 'kb-comment-new' }, input, el('div', { class: 'kb-comment-btns' }, attach, send)));
      loadComments();
    }

    // 卡住: the card's people and their supervisors flag what it is waiting for (applies at once, not on 儲存)
    const blockBox = task && !CLOSED.has(task.status) ? el('div', { class: 'kb-block-field' }) : null;
    function paintBlock(editing = false) {
      if (!blockBox) return;
      const b = task.blocked;
      const canFlag = task.can_edit !== false;
      if (editing) {
        const reason = el('input', { class: 'input', maxlength: 300, placeholder: '卡在哪裡、在等誰？例如：等總務回覆配電容量', value: b?.reason || '' });
        const ok = el('button', { class: 'btn btn-sm btn-danger', type: 'button', text: b ? '更新原因' : '標記卡住' });
        const no = el('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: '取消' });
        const go = async () => {
          if (!reason.value.trim()) { toast('請寫一下卡在哪裡', true); reason.focus(); return; }
          ok.disabled = true;
          try { await setBlocked(true, reason.value.trim()); } catch (e) { toast(e.message, true); ok.disabled = false; }
        };
        ok.addEventListener('click', go);
        reason.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go(); } if (e.key === 'Escape') { e.stopPropagation(); paintBlock(); } });
        no.addEventListener('click', () => paintBlock());
        blockBox.replaceChildren(el('div', { class: 'kb-block-edit' }, reason, ok, no));
        setTimeout(() => reason.focus(), 20);
        return;
      }
      if (b) {
        const edit = canFlag ? el('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: '修改原因' }) : null;
        const clear = canFlag ? el('button', { class: 'btn btn-sm', type: 'button', text: '✅ 解除卡住' }) : null;
        edit?.addEventListener('click', () => paintBlock(true));
        clear?.addEventListener('click', async () => { clear.disabled = true; try { await setBlocked(false, ''); } catch (e) { toast(e.message, true); clear.disabled = false; } });
        blockBox.replaceChildren(el('div', { class: 'kb-blocked-bar is-big' },
          el('span', { text: `⛔ 卡住 ${blockedDays(b.since)}：${b.reason}` + (b.by ? `（${b.by} 標記）` : '') }), el('span', { class: 'spacer' }), edit, clear));
      } else if (canFlag) {
        const flag = el('button', { class: 'btn btn-sm btn-ghost kb-block-btn', type: 'button', text: '⛔ 標記卡住…', title: '工作卡住、在等別人時標記，會議開場會先處理，並通知負責人與上級' });
        flag.addEventListener('click', () => paintBlock(true));
        blockBox.replaceChildren(flag);
      } else blockBox.replaceChildren();
    }
    async function setBlocked(on, reason) {
      await api(`/api/tasks/${task.id}/blocked`, { method: 'POST', body: { blocked: on, reason } });
      const fresh = (await load(true)).find(x => x.id === task.id);
      task.blocked = fresh ? fresh.blocked : null;
      toast(on ? '已標記卡住，已通知負責人與上級' : '已解除卡住');
      paintBlock();
      refreshComments();
    }
    paintBlock();

    const wrap = el('div', { class: 'modal' },
      el('div', { class: 'modal-card kb-editor', role: 'dialog', 'aria-modal': 'true', 'aria-label': task ? '編輯卡片' : '新增卡片' },
        el('div', { class: 'modal-head' }, el('h3', { html: svg('kanban') + (task ? '編輯卡片' : '新增卡片') }), closeBtn),
        el('div', { class: 'modal-body' },
          field('標題', title),
          field('說明', desc),
          el('div', { class: 'field' }, el('span', { class: 'field-label', html: svg('paperclip') + '附件' }), imgBox),
          meInfo.auth ? el('div', { class: 'field' }, el('span', { class: 'field-label', html: svg('users') + '負責人' }), assignBox) : null,
          el('div', { class: 'kb-row' }, el('div', { class: 'field' }, el('span', { class: 'field-label', text: '狀態' }), status,
            summary ? el('span', { class: 'hint', text: '自動：依子任務與協作人計算' }) : null), el('div', { class: 'field' }, el('span', { class: 'field-label', text: '優先順序' }), prio)),
          blockBox,
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
          opBox,
          meta,
          comments),
        el('div', { class: 'modal-foot' }, del, xlsBtn, el('span', { class: 'spacer' }), cancel, ok)));

    const close = () => { stopTicker(); wrap.remove(); document.removeEventListener('keydown', onKey); document.body.classList.remove('modal-open'); };
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
      const ok = attachFiles(files);
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
      const ok = attachFiles(e.dataTransfer.files);
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
      if (!opBox.hidden && (opProject || null) !== (t.op_project || null)) body.op_project = opProject || '';
      if (body.start_at && body.due_at && body.start_at.slice(0, 10) > body.due_at.slice(0, 10)) { toast('開始日不能晚於到期日', true); return; }
      if (body.repeat && !body.due_at) { toast('重複的卡片需要設定到期日', true); dueD.focus(); return; }
      ok.disabled = true;
      try {
        const saved = await save(task?.id, body);
        close();
        if (!task) {
          const queued = cardImages.filter(x => x.file);
          let failed = 0;
          for (const im of queued) { try { await uploadFile(saved.id, im.file, 'card'); } catch (e) { failed++; toast(e.message, true); } }
          queued.forEach(x => x.preview && URL.revokeObjectURL(x.preview));
          if (queued.length) await load(true);
          toast(`已新增「${body.title}」` + (queued.length ? `（${queued.length - failed} 個附件）` : ''));
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
          el('span', { class: 'bell-kind kind-note', html: svg(n.kind === 'comment' ? 'message' : n.kind === 'assigned' ? 'user' : n.kind === 'subtask' ? 'check' : 'users') }),
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
        row.addEventListener('click', () => { close(); openEditor(a.card || a.t); });
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

  /** Cards matching q (title, description, comments, people) that this user may see. */
  function searchCards(q, limit = 30) {
    return api(`/api/tasks/search?q=${encodeURIComponent(q)}&limit=${limit}`);
  }
  /** One search result row: status dot, title, where it matched, due date. */
  function cardHit(r, { compact = false } = {}) {
    const st = STATUS[r.status] || STATUSES[2];
    const sub = [`${st.label}（${st.zh}）`, r.due_at ? `到期 ${fmt(r.due_at, true)}` : null,
      r.match !== '標題' ? `${r.match}：${r.snippet}` : null].filter(Boolean).join('  ·  ');
    return el('div', { class: 'kb-hit' + (compact ? ' compact' : '') },
      el('span', { class: 'kb-hit-tile', style: { '--st': st.color }, html: svg('kanban') }),
      el('div', { class: 'palette-item-text' },
        el('div', { class: 'palette-item-title', text: r.title }),
        el('div', { class: 'palette-item-sub', text: sub })));
  }

  return { init, load, mount, mountBell, openEditor, openTask, exportXlsx, importXlsx, setSelecting, get selecting() { return selecting; }, searchCards, cardHit, alerts, summary, timing, nextDue, repeatText, STATUSES, get tasks() { return tasks; } };
})();
