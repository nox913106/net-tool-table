/* =============================================================================
   IPMS — task board (kanban) + reminders
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

const TTBoard = window.TTBoard = (() => {
  const { api, el, svg, toast, store } = TT;

  const STATUSES = [
    { key: 'recurring', label: 'Recurring', zh: _t('週期工作'), color: '#14b8a6' },
    { key: 'overdue', label: 'Overdue', zh: _t('過期未結案'), color: '#e11d48' },
    { key: 'new', label: 'New', zh: _t('新建'), color: '#64748b' },
    { key: 'ongoing', label: 'On going', zh: _t('進行中'), color: '#3b82f6' },
    { key: 'pending', label: 'Pending', zh: _t('待確認'), color: '#f59e0b' },
    { key: 'onhold', label: 'On hold', zh: _t('暫緩'), color: '#a855f7' },
    { key: 'complete', label: 'Complete', zh: _t('完成'), color: '#10b981' },
    { key: 'canceled', label: 'Canceled', zh: _t('取消'), color: '#ef4444' },
  ];
  /** "On going（進行中）" in Chinese; just "On going" in English */
  const stName = s => TT_LANG === 'en' ? s.label : `${s.label}（${s.zh}）`;
  const STATUS = Object.fromEntries(STATUSES.map(s => [s.key, s]));
  const CLOSED = new Set(['complete', 'canceled']);
  const PRIORITIES = [['low', _t('低')], ['normal', _t('一般')], ['high', _t('高')]];
  const REMINDS = [['', _t('不提醒')], ['0', _t('到期時')], ['15', _t('15 分鐘前')], ['60', _t('1 小時前')], ['1440', _t('1 天前')], ['2880', _t('2 天前')], ['10080', _t('1 週前')]];
  const ALL_DAY_REMIND_HOUR = 9;          // all-day cards are reminded at 09:00
  const WEEK = [_t('日'), _t('一'), _t('二'), _t('三'), _t('四'), _t('五'), _t('六')];
  const CLOSE_PROMPT_HOUR = 18;           // all-day recurring cards ask "close it?" at 18:00 on the due day
  const REPEATS = [['', _t('不重複')], ['daily', _t('每天')], ['weekdays', _t('每個工作日（一～五）')], ['weekly', _t('每週')], ['monthly', _t('每月')], ['yearly', _t('每年')]];
  const UNIT = { daily: _t('天'), weekly: _t('週'), monthly: _t('個月'), yearly: _t('年') };

  let tasks = [];
  let settings = {};
  let loading = null;
  const boards = new Set();               // re-render functions of mounted boards
  const bells = new Set();

  // ------------------------------------------------------------ custom tags
  // Free-text labels on a card; each name always gets the same colour, so a tag is recognised at a glance.
  // Clicking one filters every board to that tag (store 'kb-tag'); click again or ✕ to clear.
  const tagHue = TT.tagHue;
  let tagFilter = TT.store.get('kb-tag', null);
  const tagPass = t => !tagFilter || (t.tags || []).some(x => x.toLowerCase() === tagFilter.toLowerCase());
  function setTagFilter(name) {
    tagFilter = name && (!tagFilter || tagFilter.toLowerCase() !== name.toLowerCase()) ? name : null;
    TT.store.set('kb-tag', tagFilter);
    boards.forEach(fn => fn());
  }
  /** an administrator's colour for this tag (後台 → 設定 → 待辦看板), else none: automatic */
  const tagColor = name => ((settings && settings.board_tag_colors) || {})[name.toLowerCase()] || null;
  function tagChip(name, { onClick, onRemove } = {}) {
    const on = tagFilter && tagFilter.toLowerCase() === name.toLowerCase();
    const custom = tagColor(name);
    const c = el(onClick ? 'button' : 'span', { class: 'kb-tag' + (on ? ' on' : '') + (custom ? ' custom' : ''), type: onClick ? 'button' : null,
      style: custom ? { '--tag-c': custom } : { '--tag-h': tagHue(name) }, title: onClick ? (on ? _t("取消篩選 #{0}", name) : _t("只看標籤 #{0}", name)) : `#${name}` },
      el('span', { class: 'kb-tag-hash', text: '#' }), el('span', { text: name }));
    if (onClick) c.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); onClick(name); });
    if (onRemove) {
      const x = el('button', { class: 'kb-tag-x', type: 'button', 'aria-label': _t("移除標籤 {0}", name), html: svg('x') });
      x.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); onRemove(name); });
      c.append(x);
    }
    return c;
  }
  /** every tag in use on the cards loaded here, most used first */
  const knownTags = () => {
    const n = new Map();
    tasks.forEach(t => (t.tags || []).forEach(x => { const k = x.toLowerCase(); const v = n.get(k) || [x, 0]; v[1]++; n.set(k, v); }));
    return [...n.values()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(v => v[0]);
  };

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
      const why = (t.assignees || []).some(a => a.id === p.id) ? _t('共同負責') : (t.mentions || []).some(m => m.id === p.id) ? _t('@協作') : _t('建立者');
      out.push({ p, kind: 'collab', status: t.status, why, counts: why !== _t('建立者'), done: !!p.done });
    });
    return out;
  }
  /** A card with (non-canceled) subtasks is a summary task: its status is computed from them. */
  const isSummary = t => (t.subtasks?.items || []).some(s => s.status !== 'canceled');
  const SUMMARY_HINT = _t('有子任務：子任務或協作人有變動時，狀態會自動更新；也可以自己改');
  const openSubs = t => (t.subtasks?.items || []).filter(s => s.status !== 'complete' && s.status !== 'canceled').length;
  /** 卡住: how long a card has been stuck ("今天" / "3 天"). since is a UTC SQLite timestamp. */
  const isBlocked = t => !!t.blocked && !CLOSED.has(t.status);
  function blockedDays(since) {
    const at = Date.parse(String(since || '').replace(' ', 'T') + (/[zZ+]/.test(since || '') ? '' : 'Z'));
    const d = Number.isFinite(at) ? Math.floor((Date.now() - at) / 864e5) : 0;
    return d > 0 ? _t("{0} 天", d) : _t('今天');
  }
  /** Column load: 高負荷 from board_wip_high cards, 超量 from board_wip_over (admin setting; default ≤5 normal). */
  function wipLevel(n) {
    const high = Number(settings.board_wip_high) || 6, over = Math.max(Number(settings.board_wip_over) || 9, high + 1);
    return n >= over ? { cls: 'over', text: _t('超量'), tip: _t("{0} 張：超量（≥ {1}）", n, over) }
      : n >= high ? { cls: 'high', text: _t('高負荷'), tip: _t("{0} 張：高負荷（{1}～{2}）", n, high, over - 1) } : null;
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
      const all = el('button', { class: 'btn btn-sm btn-ghost', type: 'button', html: svg('check') + _t('全選目前顯示的') });
      const none = el('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: _t('清除選取') });
      const xls = el('button', { class: 'btn btn-sm btn-primary', type: 'button', title: _t('工作進度報告：一個分頁，主任務 > 子任務／協作（可在 Excel 左側 +／− 折疊），可直接列印'), html: svg('download') + _t('匯出報告') });
      const imp = el('button', { class: 'btn btn-sm btn-ghost', type: 'button', title: _t('把匯出的報告（可在 Excel 修改、新增列）匯回看板，先預覽再套用'), html: svg('upload') + _t('匯入報告…') });
      const byPeople = el('button', { class: 'btn btn-sm', type: 'button', title: _t('選人員或部門，匯出他們參與的所有卡片'), html: svg('users') + _t('依人員匯出…') });
      byPeople.addEventListener('click', () => exportByPeople());
      const done = el('button', { class: 'icon-btn', type: 'button', title: _t('結束選取（Esc）'), 'aria-label': _t('結束選取'), html: svg('x') });
      all.addEventListener('click', () => shownIds().forEach(i => toggleSelect(i, true)));
      none.addEventListener('click', () => [...selection].forEach(i => toggleSelect(i, false)));
      xls.addEventListener('click', async () => {
        exportReport([...selection]);
      });
      imp.addEventListener('click', () => importXlsx());
      done.addEventListener('click', () => setSelecting(false));
      selBar = el('div', { class: 'kb-selbar', role: 'toolbar', 'aria-label': _t('已選取的卡片') },
        el('span', { class: 'kb-selbar-text' }, count, el('span', { class: 'hint', text: _t('點卡片或欄位標題的方框勾選') })),
        all, none, el('span', { class: 'spacer' }), imp, byPeople, xls, done);
      selBar.count = count;
      document.body.append(selBar);
    }
    selBar.count.textContent = _t("已選 {0} 張", selection.size);
  }
  document.addEventListener('keydown', e => { if (selecting && e.key === 'Escape' && !document.querySelector('.modal:not([hidden])')) setSelecting(false); });

  /** Download the cards as a one-sheet progress report (.xlsx): 主任務 > 子任務／協作. */
  async function exportXlsx(ids, extra = null) {
    try {
      const res = await fetch('/api/tasks/export', { method: 'POST', headers: { 'X-Tool-Table': '1', 'X-Lang': TT_LANG, 'Content-Type': 'application/json' }, body: JSON.stringify({ ids, ...(extra || {}) }) });
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { msg = (await res.json()).detail || msg; } catch { /* not json */ }
        throw new Error(msg);
      }
      const blob = await res.blob();
      const cd = res.headers.get('Content-Disposition') || '';
      const m = /filename\*=UTF-8''([^;]+)/i.exec(cd);
      const name = m ? decodeURIComponent(m[1]) : extra?.format === 'mspdi' ? 'project.xml' : 'cards.xlsx';
      const url = URL.createObjectURL(blob);
      const a = el('a', { href: url, download: name });
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      toast(extra ? _t("已匯出：{0}", name) : _t("已匯出 {0} 張卡片：{1}", ids.length, name));
    } catch (e) { toast(_t('匯出失敗：') + e.message, true); }
  }

  /** Export format: the report (Excel), the report + a 甘特圖 sheet (Excel), or Microsoft Project XML. Remembers the last choice. */
  function formatField() {
    const FORMATS = [['xlsx', _t('工作進度報告（Excel）'), _t('樹狀表，可在 Excel 修改後匯回')],
      ['gantt', _t('報告＋甘特圖（Excel）'), _t('多一個「甘特圖」分頁：狀態色長條、里程碑、今天、基準線，A3 橫向列印')],
      ['mspdi', _t('MS Project（XML）'), _t('Microsoft Project、ProjectLibre 可直接開啟：階層、前置任務、里程碑、基準線、負責人')]];
    let fmt = TT.store.get('export-format', 'xlsx');
    if (!FORMATS.some(f => f[0] === fmt)) fmt = 'xlsx';
    const scale = el('select', { class: 'select input-sm', 'aria-label': _t('甘特圖刻度') },
      ...[['auto', _t('自動（依期間長短）')], ['day', _t('每欄一天')], ['week', _t('每欄一週')], ['month', _t('每欄一個月')]]
        .map(([v, l]) => el('option', { value: v, text: l, selected: v === TT.store.get('export-scale', 'auto') })));
    scale.addEventListener('change', () => TT.store.set('export-scale', scale.value));
    const box = el('div', { class: 'kb-fmt', role: 'radiogroup', 'aria-label': _t('匯出格式') });
    const paint = () => box.replaceChildren(...FORMATS.map(([v, l, h]) => {
      const r = el('input', { type: 'radio', name: 'kb-fmt', value: v, checked: v === fmt });
      r.addEventListener('change', () => { fmt = v; TT.store.set('export-format', v); paint(); });
      return el('label', { class: 'kb-fmt-opt' + (v === fmt ? ' is-on' : '') }, r,
        el('span', {}, el('strong', { text: l }), el('small', { text: h }), v === 'gantt' && fmt === 'gantt' ? scale : null));
    }));
    paint();
    return { el: box, value: () => ({ format: fmt, scale: scale.value }) };
  }

  /** Ask for the format, then export these cards. */
  function exportReport(ids) {
    if (!ids.length) { toast(_t('先勾選要匯出的卡片'), true); return; }
    const f = formatField();
    const go = el('button', { class: 'btn btn-primary', type: 'button', html: svg('download') + _t('匯出') });
    const cancel = el('button', { class: 'btn btn-ghost', type: 'button', text: _t('取消') });
    const wrap = el('div', { class: 'modal' },
      el('div', { class: 'modal-card kb-exp', role: 'dialog', 'aria-modal': 'true', 'aria-label': _t('匯出') },
        el('div', { class: 'modal-head' }, el('h3', { html: svg('download') + _t("匯出 {0} 張卡片", ids.length) })),
        el('div', { class: 'modal-body' }, f.el),
        el('div', { class: 'modal-foot' }, cancel, go)));
    const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey, true); };
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey, true);
    cancel.addEventListener('click', close);
    go.addEventListener('click', async () => { go.disabled = true; try { await exportXlsx(ids, f.value()); close(); } finally { go.disabled = false; } });
    document.body.append(wrap);
    go.focus();
  }

  /** 依人員匯出: pick people (or whole departments), statuses and the kind of work → one report of what they take part in. */
  function exportByPeople(preset = []) {
    if (selecting) setSelecting(false);
    const people = new Map();
    const add = p => { if (p && p.id != null && !people.has(p.id)) people.set(p.id, p); };
    tasks.forEach(t => { add(t.owner); (t.assignees || []).forEach(add); (t.mentions || []).forEach(add); (t.subtasks?.items || []).forEach(x => add(x.assignee)); });
    (meInfo.team || []).forEach(add);
    if (meInfo.user) add(meInfo.user);
    const noDept = _t('未設定部門');
    const byDept = new Map();
    [...people.values()].sort((a, b) => TT.nameOf(a).localeCompare(TT.nameOf(b), 'zh-Hant'))
      .forEach(p => { const d = p.department || noDept; if (!byDept.has(d)) byDept.set(d, []); byDept.get(d).push(p); });
    const depts = [...byDept.keys()].sort((a, b) => (a === noDept) - (b === noDept) || a.localeCompare(b, 'zh-Hant'));
    const chosen = new Set(preset.filter(id => people.has(id)));
    const pickedStatus = new Set();
    let kind = 'all';
    const search = el('input', { class: 'input', type: 'search', placeholder: _t('搜尋姓名或帳號…') });
    const list = el('div', { class: 'kb-exp-people' });
    const go = el('button', { class: 'btn btn-primary', type: 'button' });
    const only = el('label', { class: 'switch' }, el('input', { type: 'checkbox', checked: true }), el('span', { class: 'track' }),
      el('span', { text: _t('只列這些人負責的子任務（他們主責或共同負責的卡片列出全部）') }));
    const paintGo = () => { go.disabled = !chosen.size; go.innerHTML = svg('download') + _t("匯出 {0} 人的報告", chosen.size); };
    function paintList() {
      const q = search.value.trim().toLowerCase();
      list.replaceChildren(...depts.map(d => {
        const ps = byDept.get(d).filter(p => !q || TT.nameOf(p).toLowerCase().includes(q) || (p.username || '').toLowerCase().includes(q));
        if (!ps.length) return null;
        const all = ps.every(p => chosen.has(p.id));
        const head = el('label', { class: 'kb-exp-dept' }, el('input', { type: 'checkbox', checked: all }), el('strong', { text: d }), el('span', { class: 'hint', text: _t("{0} 人", ps.length) }));
        head.querySelector('input').addEventListener('change', e => { ps.forEach(p => e.target.checked ? chosen.add(p.id) : chosen.delete(p.id)); paintList(); });
        return el('div', { class: 'kb-exp-group' }, head, el('div', { class: 'kb-exp-names' }, ...ps.map(p => {
          const box = el('input', { type: 'checkbox', checked: chosen.has(p.id) });
          box.addEventListener('change', () => { box.checked ? chosen.add(p.id) : chosen.delete(p.id); paintList(); });
          return el('label', { class: 'kb-exp-name' }, box, TT.avatar(p, 20), el('span', { text: TT.nameOf(p) }));
        })));
      }).filter(Boolean));
      paintGo();
    }
    search.addEventListener('input', paintList);
    const stBox = el('div', { class: 'kb-exp-status' }, ...STATUSES.filter(x => x.key !== 'recurring').map(x => {
      const b = el('input', { type: 'checkbox' });
      b.addEventListener('change', () => { b.checked ? pickedStatus.add(x.key) : pickedStatus.delete(x.key); });
      return el('label', { class: 'kb-exp-st', style: { '--c': x.color } }, b, el('i'), el('span', { text: x.zh }));
    }));
    const kindSeg = el('div', { class: 'segmented', role: 'group' }, ...[['all', _t('全部')], ['ops', _t('一般')], ['project', _t('專案')]].map(([v, l]) => {
      const b = el('button', { type: 'button', dataset: { v }, text: l, 'aria-pressed': String(v === kind) });
      b.addEventListener('click', () => { kind = v; kindSeg.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.v === kind))); });
      return b;
    }));
    const cancel = el('button', { class: 'btn btn-ghost', type: 'button', text: _t('取消') });
    const fmtField = formatField();
    const wrap = el('div', { class: 'modal' },
      el('div', { class: 'modal-card kb-exp', role: 'dialog', 'aria-modal': 'true', 'aria-label': _t('依人員匯出') },
        el('div', { class: 'modal-head' }, el('h3', { html: svg('download') + _t('依人員匯出工作進度報告') })),
        el('div', { class: 'modal-body' },
          el('div', { class: 'field' }, el('span', { class: 'field-label', text: _t('人員（勾部門＝整個部門）') }), search, list),
          el('div', { class: 'field' }, el('span', { class: 'field-label', text: _t('狀態（不勾＝全部）') }), stBox),
          el('div', { class: 'field' }, el('span', { class: 'field-label', text: _t('類型') }), kindSeg),
          only,
          el('div', { class: 'field' }, el('span', { class: 'field-label', text: _t('格式') }), fmtField.el)),
        el('div', { class: 'modal-foot' }, cancel, go)));
    const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey, true); };
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey, true);
    cancel.addEventListener('click', close);
    go.addEventListener('click', async () => {
      go.disabled = true;
      try {
        await exportXlsx([], { people: [...chosen], statuses: [...pickedStatus], kind, only_people: only.querySelector('input').checked, ...fmtField.value() });
        close();
      } finally { paintGo(); }
    });
    paintList();
    document.body.append(wrap);
    search.focus();
  }

  /** Import a report (same layout as the export): pick a file → preview what changes → apply. */
  function importXlsx() {
    if (selecting) setSelecting(false);          // the selection bar would sit on top of the dialog
    const KIND = { card: _t('主任務'), sub: _t('子任務'), collab: _t('協作') };
    const ACT = { create: [_t('新增'), 'create'], update: [_t('更新'), 'update'], unchanged: [_t('不變'), 'same'], error: [_t('錯誤'), 'error'], skip: [_t('略過'), 'skip'] };
    const input = el('input', { type: 'file', accept: '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', hidden: true });
    const pickBtn = el('button', { class: 'btn', type: 'button', html: svg('upload') + _t('選擇 Excel 檔…') });
    const fileName = el('span', { class: 'hint', text: _t('用「匯出報告」產生的檔案；可在 Excel 修改狀態、日期、負責人，或新增列（系統ID 留空＝新增）') });
    const body = el('div', { class: 'kb-imp-body' });
    const apply = el('button', { class: 'btn btn-primary', type: 'button', disabled: true, html: svg('check') + _t('套用') });
    const cancel = el('button', { class: 'btn btn-ghost', type: 'button', text: _t('關閉') });
    let file = null;
    const wrap = el('div', { class: 'modal' },
      el('div', { class: 'modal-card kb-imp', role: 'dialog', 'aria-modal': 'true', 'aria-label': _t('匯入報告') },
        el('div', { class: 'modal-head' }, el('h3', { html: svg('upload') + _t('匯入工作進度報告') })),
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
      const res = await fetch('/api/tasks/import.xlsx', { method: 'POST', headers: { 'X-Tool-Table': '1', 'X-Lang': TT_LANG }, body: fd });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.detail || `HTTP ${res.status}`);
      return data;
    }
    function paint(r) {
      const c = r.counts || {};
      const ppl = r.people || { rows: [], create: 0, departments: [] };
      const todo = (c.create || 0) + (c.update || 0) + (r.applied ? 0 : ppl.create || 0);
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
        el('div', { class: 'kb-imp-sum' }, r.applied ? el('strong', { text: _t('已套用：') }) : el('strong', { text: _t('預覽：') }), chips,
          el('span', { class: 'hint', text: r.applied ? '' : (c.error ? _t('有錯誤的列不會匯入（底下的子任務一併略過），可以修正後重新選檔') : _t('確認無誤後按「套用」')) })),
        ppl.rows.length ? el('div', { class: 'kb-imp-people' },
          el('strong', { text: _t("人員（{0} 個部門）", ppl.departments.length) }),
          el('span', { text: (r.applied ? _t("已建立 {0} 位", ppl.rows.filter(p => p.done).length) : _t("新增 {0} 位", ppl.create))
            + (ppl.rows.some(p => p.action === 'exists') ? _t("，{0} 位已存在", ppl.rows.filter(p => p.action === 'exists').length) : '') + '：'
            + ppl.departments.join('、') }),
          ...ppl.rows.filter(p => p.errors.length).map(p => el('div', { class: 'err', text: `✕ ${p.username}：${p.errors.join('；')}` })),
          el('span', { class: 'hint', text: _t('示範人員只存在這個系統，不能登入，也不會寫入 AD；可在後台「備份與匯入 → 示範資料」一鍵移除') })) : null,
        el('div', { class: 'kb-imp-table' }, el('table', {},
          el('thead', {}, el('tr', {}, ...[_t('列'), _t('類型'), _t('項目'), _t('動作'), _t('內容')].map(h => el('th', { text: h })))),
          el('tbody', {}, ...rows))));
      apply.disabled = r.applied || !todo;
      apply.innerHTML = svg('check') + (r.applied ? _t('已套用') : _t("套用 {0} 筆", todo));
    }
    input.addEventListener('change', async () => {
      file = input.files[0];
      input.value = '';
      if (!file) return;
      fileName.textContent = file.name;
      body.replaceChildren(el('p', { class: 'hint', text: _t('讀取中…') }));
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
        toast(_t("已匯入 {0} 筆", n) + (r.counts.error ? _t("，{0} 筆有錯誤", r.counts.error) : ''), !!r.counts.error);
      } catch (e) { toast(_t('匯入失敗：') + e.message, true); apply.disabled = false; }
    });
    document.body.append(wrap);
  }

  // ------------------------------------------------------------------ data
  function load(force = false) {
    if (!loading || force) loading = api('/api/tasks').then(t => { tasks = t; changed(); return tasks; });
    return loading;
  }
  let anaCache = { at: 0, data: null, wait: null };
  async function projectAnalysis(force = false) {
    if (!force && anaCache.data && Date.now() - anaCache.at < 15000) return anaCache.data;
    if (!anaCache.wait) anaCache.wait = api('/api/tasks/projects/analysis').then(d => {
      const first = !anaCache.data;
      anaCache = { at: Date.now(), data: d, wait: null };
      if (first) boards.forEach(f => f());                 // project cards show their health once it is known
      document.dispatchEvent(new Event('tt:analysis'));
      return d;
    }).catch(e => { anaCache.wait = null; throw e; });
    return anaCache.wait;
  }
  const projHealth = id => anaCache.data?.projects.find(p => p.id === id) || null;
  const isProject = t => (t.kind || 'ops') === 'project';
  function changed() {
    anaCache.at = 0; ganttCache.at = 0;
    setTimeout(() => projectAnalysis(true).catch(() => {}), 300);
    boards.forEach(f => f());
    refreshAlerts();
    document.dispatchEvent(new Event('tt:tasks'));            // e.g. the home page radar
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
    if (status === 'complete' && t.status !== 'complete' && openSubs(t) && !confirm(_t("「{0}」還有 {1} 個子任務沒完成，仍要把整張卡片改成 Complete？", t.title, openSubs(t)))) {
      changed(); return;
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
      else if (status === 'complete' && !wasClosed) toast(_t("「{0}」完成 🎉", t.title));
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
          if (r.moved.length) toast(_t("⏰ {0} 張卡片已過期未結案，移到「過期未結案」", r.moved.length));
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
    if (r.next) announceNext(r.task, r.next); else toast(_t("「{0}」完成 🎉", t.title));
    return r;
  }
  function announceNext(t, next) {
    next = next || tasks.find(x => x.id === (tasks.find(y => y.id === t.id) || t).next_id);
    toast(next ? _t("「{0}」已結案；下一次 {1} 已排入「週期工作」", t.title, fmt(next.due_at, true)) : _t("「{0}」完成 🎉", t.title));
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
    const each = every > 1 ? _t("每 {0} {1}", every, UNIT[kind] || '') : { daily: _t('每天'), weekly: _t('每週'), monthly: _t('每月'), yearly: _t('每年') }[kind];
    if (kind === 'weekdays') return _t('每個工作日');
    if (kind === 'weekly') {
      const days = (rule.split(':')[1] || '').split(',').filter(Boolean).map(Number);
      return each + (days.length ? days.map(x => WEEK[x % 7]).join('、') : '');
    }
    if (kind === 'monthly') { const day = rule.split(':')[1] || (dueAt ? Number(dueAt.slice(8, 10)) : ''); return _t("{0} {1} 日", each, day); }
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
      if (closed) { out.due = 'done'; out.dueText = _t("{0} 到期", fmt(t.due_at)); }
      else if (at > dueMoment(t.due_at)) {
        out.due = 'overdue';
        const late = dayDiff(at, p.date);
        out.dueText = late >= 1 ? _t("逾期 {0} 天", late) : _t("已逾期（{0}）", hm(p.date));
      }
      else if (days === 0) { out.due = 'today'; out.dueText = _t("今天{0}到期", time); }
      else if (days === 1) { out.due = 'soon'; out.dueText = _t("明天{0}到期", time); }
      else if (days <= soonDays) { out.due = 'soon'; out.dueText = _t("{0} 天後到期", days); }
      else { out.due = 'later'; out.dueText = _t("{0} 到期", fmt(t.due_at)); }
    }
    if (t.start_at && !closed) {
      const p = parse(t.start_at);
      if (at < p.date) {
        const d = dayDiff(p.date, at);
        out.start = 'waiting';
        out.startText = d === 0 ? _t("今天 {0} 開始", hm(p.date)) : d === 1 ? _t('明天開始') : d <= 7 ? _t("{0} 天後開始", d) : _t("{0} 開始", fmt(t.start_at));
      } else if (t.status === 'new') {
        out.start = 'due';
        out.startText = _t('該開始了');
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
        if (tm.due === 'overdue') list.push({ t, card, kind: 'overdue', text: _t('子任務') + tm.dueText, rank: 0 });
        else if (rm && at >= rm) list.push({ t, card, kind: 'remind', text: _t('子任務') + (tm.dueText || _t("{0} 到期", fmt(t.due_at))), rank: 1 });
        else if (tm.due === 'today') list.push({ t, card, kind: 'today', text: _t('子任務') + tm.dueText, rank: 2 });
        else if (tm.start === 'due') list.push({ t, card, kind: 'start', text: _t("子任務開始日 {0}，還在 New", fmt(t.start_at)), rank: 3 });
      }
    }
    for (const t of tasks) {
      if (CLOSED.has(t.status) || t.mine === false) continue;     // admins see every card, but are reminded of their own
      const tm = timing(t, at);
      const rm = remindMoment(t);
      if (tm.due === 'overdue') list.push({ t, kind: 'overdue', text: tm.dueText, rank: 0 });
      else if (rm && at >= rm) list.push({ t, kind: 'remind', text: tm.dueText || _t("{0} 到期", fmt(t.due_at)), rank: 1 });
      else if (tm.due === 'today') list.push({ t, kind: 'today', text: tm.dueText, rank: 2 });
      else if (tm.start === 'due') list.push({ t, kind: 'start', text: _t("開始日 {0}，還在 New", fmt(t.start_at)), rank: 3 });
    }
    return list.sort((a, b) => a.rank - b.rank || (dueMoment(a.t.due_at) || 0) - (dueMoment(b.t.due_at) || 0));
  }
  const alertKey = a => [a.t.id + (a.t.sub ? `.${a.t.sub}` : ''), a.kind, a.t.due_at || '', a.t.start_at || '', a.t.remind ?? ''].join('|');
  const KIND = { overdue: _t('已逾期'), remind: _t('到期提醒'), today: _t('今天到期'), start: _t('該開始了') };

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
      if (!open.length) { close(); toast(_t('過期的卡片都結案了 🎉')); return; }
      count.textContent = open.length;
      rows.replaceChildren(...open.map(t => {
        const tm = timing(t);
        const doneBtn = el('button', { class: 'btn btn-sm btn-primary', type: 'button', html: svg('check') + _t('結案') });
        const openBtn = el('button', { class: 'btn btn-sm', type: 'button', html: svg('edit') + _t('開啟') });
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
              el('span', { text: _t("到期 {0} · {1}", fmt(t.due_at, true), STATUS[t.status]?.zh || '') }))),
          el('div', { class: 'kb-od-actions' }, openBtn, doneBtn));
      }));
    };
    const count = el('span', { class: 'badge badge-alert' });
    const ok = el('button', { class: 'btn btn-primary', type: 'button', text: _t('知道了') });
    const goBoard = el('a', { class: 'btn btn-ghost', href: '/#/board', html: svg('kanban') + _t('開啟看板') });
    const time = settings.board_overdue_remind_time || '09:30';
    const wrap = el('div', { class: 'modal kb-close kb-od' },
      el('div', { class: 'modal-card kb-close-card kb-od-card', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': _t('過期未結案提醒') },
        el('div', { class: 'modal-head' }, el('h3', { html: svg('bell') + _t('過期未結案提醒') }), count),
        el('div', { class: 'modal-body' },
          el('p', { class: 'kb-close-q', text: _t('這些卡片已經過了到期日，還沒結案：') }),
          rows,
          el('p', { class: 'hint', text: _t("每天 {0} 會再提醒一次，直到結案為止。若要延後，請在卡片裡改到期日。", time) })),
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
      const n = new Notification(_t("過期未結案：{0} 張卡片", list.length), {
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
    const later = el('button', { class: 'btn btn-ghost', type: 'button', html: svg('clock') + _t('1 小時後再問') });
    const open = el('button', { class: 'btn', type: 'button', html: svg('edit') + _t('開啟卡片') });
    const done = el('button', { class: 'btn btn-primary', type: 'button', html: svg('check') + _t('結案並排下一次') });
    const wrap = el('div', { class: 'modal kb-close' },
      el('div', { class: 'modal-card kb-close-card', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': _t('週期工作到期') },
        el('div', { class: 'modal-head' }, el('h3', { html: svg('repeat') + _t('週期工作到期') })),
        el('div', { class: 'modal-body' },
          el('div', { class: 'kb-close-title' }, t.priority === 'high' ? el('span', { class: 'kb-flag', html: svg('flag') }) : null, el('strong', { text: t.title })),
          t.description ? el('p', { class: 'kb-close-desc', text: t.description }) : null,
          el('div', { class: 'kb-chips' },
            el('span', { class: `kb-chip due-${tm.due || 'later'}`, html: svg('clock') + `<span>${tm.dueText || fmt(t.due_at)}</span>` }),
            el('span', { class: 'kb-chip repeat', html: svg('repeat') + `<span>${repeatText(t.repeat, t.repeat_every, t.due_at)}</span>` })),
          el('p', { class: 'kb-close-q', text: _t('這一次完成了嗎？') }),
          el('p', { class: 'hint', text: _t("結案後這張會移到「Complete」，並自動複製一張到「週期工作」，到期日 {0}。", fmt(next, true)) }),
          waiting > 0 ? el('p', { class: 'hint', text: _t("還有 {0} 張週期工作等你確認。", waiting) }) : null),
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
    later.addEventListener('click', () => { snooze(t, 60); close(); toast(_t('1 小時後會再問一次')); });
    open.addEventListener('click', () => { snooze(t, 10); close(); openEditor(t); });
    done.addEventListener('click', async () => {
      [done, later, open].forEach(b => { b.disabled = true; });
      done.innerHTML = svg('check') + _t('處理中…');
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
      const n = new Notification(_t("週期工作到期：{0}", t.title), { body: _t('這一次完成了嗎？點這裡結案並排下一次。'), tag: 'tt-close-' + key, icon: '/assets/app/icon-192.png', requireInteraction: true });
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
      const title = _t("{0} 個待辦需要注意", fresh.length);
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
  let meInfo = { auth: false, people: false, is_admin: true, user: {}, board: { view: 'all', edit: 'all', depts: [] } };
  let notes = [];
  async function loadNotes() {
    if (!meInfo.people) return;
    try {
      const list = await api('/api/notifications');
      const seen = store.get('board-notes-seen', 0);
      const fresh = list.filter(n => !n.read && n.id > seen);
      notes = list;
      if (fresh.length) {
        store.set('board-notes-seen', Math.max(...list.map(n => n.id)));
        if (seen) fresh.slice(0, 3).forEach(n => {           // not on the very first load
          if (canNotify()) { const x = new Notification('IPMS', { body: n.text, tag: 'tt-note-' + n.id, icon: '/assets/app/icon-192.png' }); x.onclick = () => { window.focus(); openTask(n.task_id); }; }
          else toast('💬 ' + n.text);
        });
      }
      refreshAlerts();
    } catch { /* ignore */ }
  }
  async function openTask(id) {
    let t = find(id);
    if (!t) { await load(true); t = find(id); }
    if (!t) t = await api(`/api/tasks/${id}`).then(x => { remember([x]); return x; }).catch(() => null);   // a history case
    if (t) openEditor(t); else toast(_t('這張卡片已被刪除，或你已經看不到它了'), true);
  }

  // 歷史區: cards closed longer ago than board_history_hours are not in `tasks` (the board); the ones a page has
  // fetched are kept here, so the editor, the task window and a history project's page find them.
  const extra = new Map();
  function remember(list) { (list || []).forEach(t => extra.set(t.id, t)); }
  function find(id) { return tasks.find(x => x.id === id) || extra.get(id); }
  /** How long after closing a main card goes to the 歷史區 (setting board_history_hours), as text. */
  function historyHours() { return Math.max(1, Number(settings.board_history_hours ?? 72) || 72); }
  function historyText() { const h = historyHours(); return h % 24 === 0 && h >= 48 ? _t("{0} 天", h / 24) : _t("{0} 小時", h); }
  function all() { return [...tasks, ...[...extra.values()].filter(t => !tasks.some(x => x.id === t.id))]; }

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
    let kindFilter = opts.kind || 'all';                        // all | ops | project
    const teamIds = () => new Set([meInfo.user?.id, ...(meInfo.team || []).map(p => p.id)].filter(x => x != null));
    const pass = t => !tagPass(t) || (kindFilter !== 'all' && (t.kind || 'ops') !== kindFilter) ? false : filter === 'all' ? true : filter === 'mine' ? t.mine !== false
      : filter === 'team' ? [t.owner, ...(t.assignees || [])].some(p => p && teamIds().has(p.id))
      : filter.startsWith('user:') ? [t.owner, ...(t.assignees || [])].some(p => p && String(p.id) === filter.slice(5))
      : filter.startsWith('dept:') ? (t.departments || []).includes(filter.slice(5)) : true;
    const inFocus = t => focusId == null || involvement(t).some(x => x.p.id === focusId);
    const colItems = key => byStatus(key).filter(t => pass(t) && (lanes || inFocus(t)));
    let drag = null;                                           // { id, from }
    let lanes = !!opts.lanes;                                  // 依人員: one row per person
    let focusId = null;                                        // focus mode: one person's work + what they are part of
    const opened = new Set();                                  // empty columns the user unfolded (until the page reloads)
    // created on first paint: on a direct page load the board can render before /me has answered
    let peopleBar = null;
    const placeholder = el('div', { class: 'kb-placeholder' });

    const render = () => {
      // a board that was on the page and has been taken off stops listening; one not yet placed on the
      // page (the data can arrive first, e.g. the standalone copy's local server) keeps rendering
      if (!root.isConnected && root.dataset.mounted) { boards.delete(render); return; }
      if (root.isConnected) root.dataset.mounted = '1';
      const cols = STATUSES.filter(s => !(hideClosed && CLOSED.has(s.key)) && !(s.key === 'overdue' && !colItems('overdue').length));
      root.style.setProperty('--kb-cols', cols.length);
      root.classList.toggle('kb-lanes', lanes);
      root.classList.toggle('kb-focus', focusId != null && !lanes);
      // a column without cards folds into a slim strip so the others get the width; click it to unfold
      // (it stays unfolded until the page is reloaded; in focus mode empty columns always fold)
      const empty = s => !lanes && !colItems(s.key).length && (focusId != null || !opened.has(s.key));
      const anyEmpty = !lanes && cols.some(empty);
      root.style.gridTemplateColumns = anyEmpty ? cols.map(s => empty(s) ? '52px' : 'minmax(var(--kb-col-min), 1fr)').join(' ') : '';
      root.classList.toggle('kb-has-folded', anyEmpty);
      if (lanes) renderLanes(cols);
      else root.replaceChildren(...cols.map(s => {
        const c = column(s);
        if (empty(s)) {
          c.classList.add('kb-col-empty');
          c.title = _t("{0}（{1}）：沒有卡片，點一下展開", s.label, s.zh);
          c.tabIndex = 0;
          const unfold = () => { opened.add(s.key); render(); };
          c.addEventListener('click', unfold);
          c.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); unfold(); } });
          // a card can still be dropped on the folded strip
          c.addEventListener('dragover', e => { if (!drag) return; e.preventDefault(); e.dataTransfer.dropEffect = 'move'; c.classList.add('drop-over'); });
          c.addEventListener('dragleave', e => { if (!c.contains(e.relatedTarget)) c.classList.remove('drop-over'); });
          c.addEventListener('drop', e => { if (!drag) return; e.preventDefault(); const id = drag.id; drag = null; moveTo(id, s.key, 0); });
        } else if (opened.has(s.key) && !colItems(s.key).length && focusId == null) {
          const fold = el('button', { class: 'kb-col-fold', type: 'button', title: _t('收合這一欄'), 'aria-label': _t('收合這一欄'), html: svg('chevron-left') });
          fold.addEventListener('click', e => { e.stopPropagation(); opened.delete(s.key); render(); });
          c.querySelector('.kb-col-head').append(fold);
        }
        return c;
      }));
      paintPeople();
      paintTagBar();
      root.classList.toggle('is-selecting', selecting);
      if (selecting) root.querySelectorAll('.kb-col').forEach(paintColCheck);
      root.dispatchEvent(new CustomEvent('kb:view'));               // a linked Gantt follows
    };

    function column(s) {
      const items = colItems(s.key);
      const list = el('div', { class: 'kb-list', dataset: { status: s.key } }, items.map(card));
      if (!items.length) list.append(el('div', { class: 'kb-empty', text: s.key === 'recurring' ? _t('重複性工作會排在這裡') : CLOSED.has(s.key) ? '—' : _t('拖曳卡片到這裡') }));
      if (s.key === 'overdue' && items.length) list.prepend(el('p', { class: 'kb-col-note', text: _t('過了到期日還沒結案的卡片。拖到其他欄就不會再被移回來。') }));
      const add = el('button', { class: 'kb-add', type: 'button', html: svg('plus') + _t('<span>新增卡片</span>') });
      add.addEventListener('click', () => s.key === 'recurring'
        ? openEditor(null, { status: 'recurring', repeat: 'weekly' })
        : quickAdd(col, s.key, add));
      const col = el('section', { class: 'kb-col', dataset: { status: s.key }, style: { '--st': s.color } },
        el('header', { class: 'kb-col-head' },
          el('span', { class: 'kb-dot' }),
          el('span', { class: 'kb-name' }, el('strong', { text: s.label }), el('span', { class: 'kb-zh' }, TT_LANG === 'en' ? null : s.zh,
            ...(() => { const w = !CLOSED.has(s.key) && s.key !== 'recurring' ? wipLevel(items.length) : null;
              return w ? [el('span', { class: `kb-wip is-${w.cls}`, title: w.tip, text: w.text })] : []; })())),
          selecting && items.length ? (() => {
            const lab = el('label', { class: 'kb-col-select', title: _t('全選這一欄') }, el('input', { type: 'checkbox' }));
            // read the wanted state once: each toggleSelect repaints this box (partly ticked after the first card)
            lab.querySelector('input').addEventListener('change', e => { const on = e.target.checked; items.forEach(t => toggleSelect(t.id, on)); });
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

    // ------------------------------------------------ tag filter bar
    let tagBar = null;
    function paintTagBar() {
      if (!tagFilter) { tagBar?.remove(); return; }
      if (!tagBar) tagBar = el('div', { class: 'kb-tagbar' });
      if (!tagBar.isConnected && root.isConnected) root.before(tagBar);
      const n = tasks.filter(t => tagPass(t) && !(hideClosed && CLOSED.has(t.status))).length;
      const clear = el('button', { class: 'btn btn-sm btn-ghost', type: 'button', html: svg('x') + _t('清除') });
      clear.addEventListener('click', () => setTagFilter(null));
      tagBar.replaceChildren(el('span', { class: 'kb-tagbar-label', text: _t('篩選標籤') }), tagChip(tagFilter, { onClick: () => setTagFilter(null) }),
        el('span', { class: 'hint', text: _t("{0} 張卡片", n) }), el('span', { class: 'spacer' }), clear);
    }

    // ------------------------------------------------ people bar (focus mode)
    function paintPeople() {
      if (!peopleBar && opts.full && meInfo.people) {
        peopleBar = el('div', { class: 'kb-people-bar' });
      }
      if (!peopleBar) return;
      if (!peopleBar.isConnected && root.isConnected) root.before(peopleBar);
      peopleBar.hidden = lanes;
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
      // a supervisor sees every person below them, also those with nothing on the board yet
      if (filter !== 'mine' && !tagFilter) (meInfo.team || []).forEach(p => { if (!counts.has(p.id)) counts.set(p.id, { p, n: {} }); });
      const rank = id => id === me ? 0 : team.has(id) ? 1 : 2;
      const people = [...counts.values()].sort((a, b) => rank(a.p.id) - rank(b.p.id) || TT.nameOf(a.p).localeCompare(TT.nameOf(b.p), 'zh-Hant'));
      if (focusId != null && !counts.has(focusId)) focusId = null;
      const pills = people.map(({ p, n, blocked }) => {
        const b = el('button', { class: 'kb-person-pill' + (focusId === p.id ? ' on' : focusId != null ? ' off' : ''), type: 'button',
          title: `${TT.nameOf(p)}：` + STATUSES.filter(s => n[s.key]).map(s => `${s.zh} ${n[s.key]}`).join('、') + _t('（主責、子任務、協作都算）') },
          TT.avatar(p, 26), el('span', { class: 'kb-pp-name', text: TT.nameOf(p) + (p.id === me ? _t('（我）') : '') }),
          team.has(p.id) && !Object.keys(n).length ? el('span', { class: 'kb-pp-zero', text: '0' }) : null,
          el('span', { class: 'kb-pp-counts' }, ...STATUSES.filter(s => n[s.key]).map(s => el('span', { class: 'kb-pp-sq', style: { '--c': s.color }, text: n[s.key] })),
            ...(blocked ? [el('span', { class: 'kb-pp-blocked', title: _t("{0} 張主責卡片卡住", blocked), text: `⛔${blocked}` })] : [])));
        b.addEventListener('click', () => setFocus(focusId === p.id ? null : p.id));
        return b;
      });
      const clear = focusId != null ? el('button', { class: 'btn btn-sm', type: 'button', html: svg('x') + _t('取消專注（Esc）') }) : null;
      clear?.addEventListener('click', () => setFocus(null));
      const teamN = people.filter(x => team.has(x.p.id)).length;
      peopleBar.replaceChildren(...[el('span', { class: 'kb-pp-label', text: focusId != null ? _t('專注：') : teamN ? _t("點人員專注（下級 {0} 人）：", teamN) : _t('點人員專注：') }), ...pills,
        el('span', { class: 'spacer' }), clear || el('span', { class: 'kb-pp-legend' }, ...STATUSES.filter(s => !(hideClosed && CLOSED.has(s.key))).map(s => el('span', {}, el('i', { style: { '--c': s.color } }), s.zh)))].filter(Boolean));
    }
    function setFocus(id) {
      focusId = id;
      if (id != null) expanded.clear();
      render();
    }
    if (opts.full) document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && focusId != null && root.isConnected && !document.querySelector('.modal:not([hidden])')) setFocus(null);
    });

    // ------------------------------------------------ 依人員 view (swimlanes)
    /** Whose row a card goes in: its first assignee, else its creator. */
    const laneOf = t => leadOf(t);
    function renderLanes(cols) {
      const people = new Map();                                // id → person
      const me = meInfo.user?.id;
      const add = p => { if (p && !people.has(p.id ?? 'none')) people.set(p.id ?? 'none', p); };
      if (meInfo.people && me != null) add({ id: me, username: meInfo.user.username, name: meInfo.user.display_name || meInfo.user.username, department: meInfo.user.department });
      if (filter === 'all' || filter === 'team') (meInfo.team || []).forEach(add);   // the team shows even with nothing on it
      const visible = cols.flatMap(s => colItems(s.key));
      visible.forEach(t => add(laneOf(t) || { id: 'none', name: _t('未指派') }));
      if (filter.startsWith('user:')) [...people.keys()].forEach(k => { if (String(k) !== filter.slice(5)) people.delete(k); });
      const teamSet = new Set((meInfo.team || []).map(p => p.id));
      const rank = p => p.id === me ? 0 : teamSet.has(p.id) ? 1 : p.id === 'none' ? 3 : 2;
      const order = [...people.values()].sort((a, b) => rank(a) - rank(b) || TT.nameOf(a).localeCompare(TT.nameOf(b), 'zh-Hant'));
      const head = el('div', { class: 'kb-lane kb-lane-head' }, el('div', { class: 'kb-lane-who' }, el('strong', { text: _t('人員') })),
        ...cols.map(s => el('div', { class: 'kb-lane-col', style: { '--st': s.color } }, el('span', { class: 'kb-dot' }), el('strong', { text: s.label }), el('span', { class: 'kb-zh', text: s.zh }),
          el('span', { class: 'kb-count', text: colItems(s.key).length }))));
      const rows = order.map(p => {
        const mineCards = visible.filter(t => (laneOf(t)?.id ?? 'none') === p.id);
        const overdue = mineCards.filter(t => timing(t).due === 'overdue').length;
        const open = mineCards.filter(t => !CLOSED.has(t.status)).length;
        const addBtn = p.id !== 'none' && (p.id === me || meInfo.board?.edit !== 'own' || meInfo.board?.team_edit)
          ? el('button', { class: 'kb-link-btn', type: 'button', title: p.id === me ? _t('新增我的卡片') : _t("新增卡片並指派給 {0}", TT.nameOf(p)), html: svg('plus') + _t('<span>新增</span>') }) : null;
        addBtn?.addEventListener('click', () => openEditor(null, { status: 'new', assignees: p.id === me ? [] : [{ id: p.id, username: p.username, name: TT.nameOf(p), department: p.department }] }));
        const who = el('div', { class: 'kb-lane-who' },
          p.id === 'none' ? el('span', { class: 'kb-lane-none', html: svg('user') }) : TT.avatar(p, 30),
          el('div', { class: 'kb-lane-name' }, el('strong', { text: TT.nameOf(p) + (p.id === me ? _t('（我）') : '') }),
            el('small', { text: [p.department, teamSet.has(p.id) ? _t('下級') : null].filter(Boolean).join(' · ') || ' ' }),
            el('span', { class: 'kb-lane-stats' }, el('span', { text: _t("{0} 進行", open) }), overdue ? el('span', { class: 'is-late', text: _t("{0} 逾期", overdue) }) : null)),
          addBtn);
        return el('div', { class: 'kb-lane' + (overdue ? ' has-late' : ''), dataset: { person: p.id } }, who,
          ...cols.map(s => laneCell(s, mineCards.filter(t => t.status === s.key).sort((a, b) => a.sort_order - b.sort_order || a.id - b.id))));
      });
      root.replaceChildren(head, ...(rows.length ? rows : [el('p', { class: 'hint kb-lane-empty', text: _t('沒有卡片') })]));
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
      if (tm.start) chips.push(el('span', { class: `kb-chip start-${tm.start}`, title: _t("開始：{0}", fmt(t.start_at, true)), html: svg('play') + `<span>${tm.startText}</span>` }));
      if (tm.due) chips.push(el('span', { class: `kb-chip due-${tm.due}`, title: _t("到期：{0}", fmt(t.due_at, true)), html: svg('clock') + `<span>${tm.dueText}</span>` }));
      if (t.repeat) chips.push(el('span', { class: 'kb-chip repeat', title: _t("重複：{0}", repeatText(t.repeat, t.repeat_every, t.due_at)), html: svg('repeat') + `<span>${repeatText(t.repeat, t.repeat_every, t.due_at)}</span>` }));
      if (t.due_at && t.remind !== null && t.remind !== undefined && !CLOSED.has(t.status)) {
        const rm = remindMoment(t);
        chips.push(el('span', { class: 'kb-chip remind', title: _t("提醒：{0}", fmtMoment(rm)), html: svg('bell') }));
      }
      const sub = t.subtasks;
      if (sub?.total) {
        const counted = sub.total - sub.canceled;
        const pct = counted ? Math.round(sub.done / counted * 100) : 0;
        chips.push(el('span', { class: 'kb-chip kb-chip-sub' + (counted && sub.done === counted ? ' all-done' : ''),
          title: _t("子任務 {0}/{1} 完成（{2}%）", sub.done, counted, pct) + (sub.spent || sub.estimate ? _t("\n工時 {0}{1}", fmtMin(sub.spent), sub.estimate ? _t(" / 預估 {0}", fmtMin(sub.estimate)) : '') : '')
            + (sub.start || sub.end ? _t("\n期間 {0} → {1}", sub.start ? fmt(sub.start) : '—', sub.end ? fmt(sub.end) : '—') : ''),
          style: { '--pct': `${pct}%` }, html: svg('check') + `<span>${sub.done}/${counted}</span>` }));
      }
      if (sub?.timer) chips.push(el('span', { class: 'kb-chip kb-chip-timer', title: _t("計時中：{0}", sub.timer.title), html: svg('clock') + _t('<span>計時中</span>') }));
      if (t.images?.length) chips.push(el('span', { class: 'kb-chip', title: _t("{0} 張圖片", t.images.length), html: svg('image') + `<span>${t.images.length}</span>` }));
      if (t.files?.length) chips.push(el('span', { class: 'kb-chip', title: _t('附件：') + t.files.map(f => f.name).join('、'), html: svg('paperclip') + `<span>${t.files.length}</span>` }));
      const c = el('article', {
        class: `kb-card prio-${t.priority}` + (isProject(t) ? ' is-project' : '') + (tm.due ? ` is-${tm.due}` : '') + (tm.start === 'due' ? ' is-start' : '') + (CLOSED.has(t.status) ? ' is-closed' : '') + (isBlocked(t) ? ' is-blocked' : ''),
        draggable: t.can_edit === false || selecting ? 'false' : 'true', tabindex: '0', dataset: { id: t.id },
        title: t.can_edit === false ? _t('唯讀：你可以檢視與留言') : null,
      },
        selecting ? (() => {
          const box = el('input', { type: 'checkbox', checked: selection.has(t.id), tabindex: '-1' });
          box.addEventListener('change', () => toggleSelect(t.id, box.checked));
          return el('label', { class: 'kb-select', title: _t('選取') }, box);
        })() : null,
        t.images?.length ? el('div', { class: 'kb-cover' }, el('img', { src: t.images[0].url, alt: '', loading: 'lazy', draggable: 'false' })) : null,
        el('div', { class: 'kb-card-title' },
          t.priority === 'high' ? el('span', { class: 'kb-flag', title: _t('高優先'), html: svg('flag') }) : null,
          el('span', { text: t.title }),
          t.team ? el('span', { class: 'kb-team-tag', title: _t('下級的卡片（你是上級，可以') + (meInfo.board?.team_edit ? _t('檢視、留言與增刪修）') : _t('檢視與留言）')), text: _t('下級') }) : null),
        t.tags?.length ? el('div', { class: 'kb-tags' }, t.tags.map(x => tagChip(x, { onClick: setTagFilter }))) : null,
        isProject(t) ? projectBlock(t) : null,
        !isProject(t) && t.project_id ? (() => {
          const pj = tasks.find(x => x.id === t.project_id);
          const a = el('a', { class: 'kb-belongs', href: `#/project/${t.project_id}`, title: _t('歸屬的專案：點一下開啟專案頁'), text: `↳ ${pj ? pj.title : _t('專案')}` });
          a.addEventListener('click', e => e.stopPropagation());
          return a;
        })() : null,
        isBlocked(t) ? el('div', { class: 'kb-blocked-bar', title: _t("卡住（{0} 標記）：{1}", t.blocked.by || '', t.blocked.reason),
          text: _t("⛔ 卡住 {0}：{1}", blockedDays(t.blocked.since), t.blocked.reason) }) : null,
        t.description ? el('p', { class: 'kb-card-desc', text: t.description }) : null,
        chips.length ? el('div', { class: 'kb-chips' }, chips) : null,
        (() => {
          const pr = progressOf(t);
          if (!pr) return null;
          return el('div', { class: 'kb-progress' + (pr.pct === 100 ? ' full' : ''), title: _t("完成 {0} / {1}（子任務 {2}{3}）", pr.done, pr.total, pr.subs, pr.collab ? _t("、協作 {0}", pr.collab) : '') },
            el('span', { class: 'kb-progress-bar' }, el('span', { style: { width: pr.pct + '%' } })),
            el('span', { class: 'kb-progress-text', text: `${pr.pct}%` }));
        })(),
        meInfo.people ? cardPeople(t) : null,
        taskTree(t));
      const lead = leadOf(t);
      if (focusId != null && !lanes && lead?.id !== focusId) {               // someone else's task I am part of
        c.classList.add('kb-card-part');
        const mine = involvement(t).filter(x => x.p.id === focusId);
        const name = TT.nameOf(mine[0]?.p || {});
        c.prepend(el('div', { class: 'kb-part-head' }, el('span', { class: 'kb-part-badge', text: _t('協作') }), el('span', { text: _t("主責：{0}", TT.nameOf(lead || {})) })));
        const what = mine.map(x => x.kind === 'sub' ? _t("子任務「{0}」", x.sub.title) : x.why).join('、');
        c.querySelector('.kb-tree-bar')?.before(el('div', { class: 'kb-part-note', text: _t("{0} 在這個任務：{1}", name, what) }));
      }
      if (selection.has(t.id)) c.classList.add('is-selected');
      if (t.team) c.classList.add('is-team');
      c.addEventListener('click', e => {
        if (selecting) {
          // the checkbox itself: let it toggle natively (its change event updates the selection); preventing
          // the default here made the box snap back to unchecked although the card was selected
          if (e.target.closest('.kb-select')) return;
          e.preventDefault(); toggleSelect(t.id); return;
        }
        if (e.ctrlKey || e.metaKey) { setSelecting(true); toggleSelect(t.id, true); return; }     // Ctrl/⌘-click starts selecting
        if (isProject(t) && opts.full) { location.hash = `#/project/${t.id}`; return; }            // a project opens its page
        openEditor(t);
      });
      c.addEventListener('keydown', e => {
        if (e.key === 'Enter') { if (isProject(t) && opts.full) location.hash = `#/project/${t.id}`; else openEditor(t); }
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
      const btn = el('button', { class: 'kb-tree-toggle' + (open ? ' open' : ''), type: 'button', title: open ? _t('收合任務樹') : _t('展開任務樹：子任務與協作人') },
        el('span', { text: [subs.length ? _t("子任務 {0}/{1}", done, subs.length) : null, collab.length ? _t("協作 {0}/{1}", collab.filter(x => x.done).length, collab.filter(x => x.counts).length || collab.length) : null].filter(Boolean).join(' · ') }),
        el('span', { class: 'kb-tree-caret', text: '⧉' }));
      btn.title = _t('開啟任務視窗：子任務由左至右展開（工時、留言、下層子任務）');
      btn.addEventListener('click', e => { e.stopPropagation(); openNavigator(t); });
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
              el('div', { class: 'kb-tree-row' }, el('span', { class: 'kb-tree-st', style: { '--c': st.color }, text: st.label }), el('span', { class: 'kb-tree-kind', text: _t('子任務') })),
              el('div', { class: 'kb-tree-title', text: s.title }),
              el('div', { class: 'kb-tree-row' },
                s.assignee ? el('span', { class: 'kb-tree-who' }, TT.avatar(s.assignee, 18), el('span', { text: TT.nameOf(s.assignee) })) : el('span', { class: 'hint', text: _t('未指派') }),
                s.due_at ? el('span', { class: `kb-chip due-${tm.due || ''}`, html: svg('clock') + `<span>${tm.dueText || fmt(s.due_at)}</span>` }) : null,
                s.estimate || s.spent ? el('span', { class: 'kb-chip', html: svg('clock') + `<span>${fmtMin(s.spent)}${s.estimate ? ' / ' + fmtMin(s.estimate) : ''}</span>` }) : null)));
        }),
        ...collab.map((x, i) => {
          const can = x.counts && (x.p.id === meInfo.user?.id || t.can_edit !== false);
          const box = x.counts ? el('label', { class: 'kb-collab-done' + (x.done ? ' on' : ''), title: can ? _t('標記這位協作人的部分已完成（計入主卡完成度）') : _t('協作人或能編輯卡片的人可以標記') },
            el('input', { type: 'checkbox', checked: x.done, disabled: !can }), el('span', { text: x.done ? _t('已完成') : _t('完成') })) : null;
          box?.querySelector('input').addEventListener('change', e => setCollabDone(t, x.p, e.target.checked));
          return el('div', { class: 'kb-tree-node collab' + (focusId != null && x.p.id === focusId ? ' me' : '') + (x.done ? ' done' : '') },
            el('span', { class: 'kb-tree-branch', text: subs.length + i === last ? '└' : '├' }),
            el('div', { class: 'kb-tree-sub kb-tree-collab' },
              el('div', { class: 'kb-tree-row' }, el('span', { class: 'kb-part-badge', text: _t('協作') }), el('span', { class: 'hint', text: x.why }), el('span', { class: 'spacer' }), box),
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
        t.comments ? el('span', { class: 'kb-meta', title: _t("{0} 則留言", t.comments), html: svg('message') + t.comments }) : null,
        t.mentions?.length ? el('span', { class: 'kb-meta', title: _t('協作：') + t.mentions.map(TT.nameOf).join('、'), html: '@' + t.mentions.length }) : null,
        el('span', { class: 'spacer' }),
        el('span', { class: 'avatars' + (t.assignees?.length ? '' : ' is-owner'), title: (t.assignees?.length ? _t('負責：') : _t('建立：')) + people.map(TT.nameOf).join('、') },
          people.slice(0, 4).map(p => TT.avatar(p, 22))));
    }

    function quickAdd(col, status, btn) {
      const input = el('input', { class: 'input kb-quick', placeholder: _t('輸入標題，Enter 新增（Esc 取消）'), maxlength: '200' });
      const more = el('button', { class: 'btn btn-ghost btn-sm', type: 'button', text: _t('更多設定…') });
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
      setKind(v) { kindFilter = v; render(); },
      setFocus,
      render,
      root,
      /** The cards this board shows right now (filter, focus, tag, hidden closed): the Gantt follows them when linked. */
      cards() {
        return STATUSES.filter(s => !(hideClosed && CLOSED.has(s.key))).flatMap(s => byStatus(s.key).filter(t => pass(t) && inFocus(t)));
      },
      /** Bring a card into view and flash it (the Gantt's "show on the board"). */
      /** Unfold a column, bring it into view and flash it (links from the war room). */
      showStatus(key) {
        if (!STATUSES.some(s => s.key === key)) return;
        opened.add(key);
        render();
        const col = root.querySelector(`.kb-list[data-status="${key}"]`)?.closest('.kb-col');
        if (!col) return;
        col.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'center' });
        col.classList.add('kb-flash'); setTimeout(() => col.classList.remove('kb-flash'), 1600);
      },
      flash(id) {
        const c = root.querySelector(`.kb-card[data-id="${id}"]`);
        if (!c) return false;
        c.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
        c.classList.add('kb-flash'); setTimeout(() => c.classList.remove('kb-flash'), 1400);
        return true;
      },
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
  const ACCEPT_TEXT = _t('圖片（PNG、JPG、GIF、WebP，10 MB 內）、PDF、Word、Excel、PowerPoint、md、json、yaml、toml、txt、py、rs、mermaid（25 MB 內）');
  const extOf = name => ((name || '').includes('.') ? name.split('.').pop().toLowerCase() : '');
  const isImageFile = f => IMAGE_TYPES.test(f.type);
  const sizeText = n => (n == null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1048576).toFixed(1)} MB`);
  const EXT_COLOR = { pdf: '#dc2626', doc: '#2563eb', docx: '#2563eb', xls: '#16a34a', xlsx: '#16a34a', ppt: '#ea580c', pptx: '#ea580c' };

  /** Accepted files out of a paste / drop / file-picker (others are skipped, with a message). */
  function attachFiles(list) {
    const files = [...(list || [])].filter(f => f && f.kind !== 'string').map(f => (f.getAsFile ? f.getAsFile() : f)).filter(Boolean);
    const ok = files.filter(f => (isImageFile(f) ? f.size <= IMAGE_MAX : FILE_EXT.includes(extOf(f.name)) && f.size <= FILE_MAX));
    if (files.length > ok.length) toast(_t("略過 {0} 個檔案。可以加入：{1}", files.length - ok.length, ACCEPT_TEXT), true);
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
      const x = el('button', { type: 'button', class: 'kb-thumb-x', 'aria-label': _t('移除附件'), title: _t('移除'), html: svg('x') });
      x.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); onRemove(item); });
      return x;
    };
    const grid = images.length ? el('div', { class: `kb-thumbs size-${size}` }, images.map((im, i) => {
      const pic = el('img', { src: im.url || im.preview, alt: im.name || _t('圖片'), loading: 'lazy', draggable: 'false' });
      const t = el('div', { class: 'kb-thumb' + (im.uploading ? ' is-uploading' : ''), title: im.name || '' }, pic);
      pic.addEventListener('click', e => { e.stopPropagation(); viewImages(images, i); });
      if (onRemove && !im.uploading) t.append(removeBtn(im));
      return t;
    })) : null;
    const rows = files.length ? el('div', { class: 'kb-files' }, files.map(f => {
      const ext = extOf(f.name);
      const badge = el('span', { class: 'kb-file-ext', style: { '--ext': EXT_COLOR[ext] || 'var(--text-3)' }, text: (ext || 'file').slice(0, 4).toUpperCase() });
      const body = el('span', { class: 'kb-file-text' }, el('span', { class: 'kb-file-name', text: f.name || _t('檔案') }),
        el('small', { text: f.uploading ? _t('上傳中…') : sizeText(f.size) }));
      const open = f.url
        ? el('a', { class: 'kb-file-open', href: f.url, target: '_blank', rel: 'noopener', title: _t("開啟 {0}", f.name || '') }, badge, body)
        : el('span', { class: 'kb-file-open' }, badge, body);
      const row = el('div', { class: 'kb-file' + (f.url ? ' has-link' : '') + (f.uploading ? ' is-uploading' : '') }, open);
      if (f.url) {
        const dl = el('a', { class: 'kb-file-dl', href: f.url + '?download=1', download: f.name || '', title: _t('下載'), 'aria-label': _t('下載'), html: svg('download') });
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
    const open = el('a', { class: 'btn btn-sm', target: '_blank', rel: 'noopener', html: svg('external') + _t('原圖') });
    const prev = el('button', { class: 'icon-btn kb-viewer-nav prev', type: 'button', 'aria-label': _t('上一張'), html: '‹' });
    const next = el('button', { class: 'icon-btn kb-viewer-nav next', type: 'button', 'aria-label': _t('下一張'), html: '›' });
    const closeBtn = el('button', { class: 'icon-btn', type: 'button', 'aria-label': _t('關閉'), html: svg('x') });
    const box = el('div', { class: 'kb-viewer', role: 'dialog', 'aria-modal': 'true', 'aria-label': _t('圖片') },
      el('div', { class: 'kb-viewer-bar' }, count, el('span', { class: 'spacer' }), open, closeBtn),
      list.length > 1 ? prev : null, pic, list.length > 1 ? next : null);
    const show = () => {
      const im = list[i];
      pic.src = im.url || im.preview;
      pic.alt = im.name || _t('圖片');
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
  // ----------------------------------------------------------------- schedule (Gantt fields)
  // every subtask of the visible cards, for the predecessor picker and the Gantt view (short cache)
  let ganttCache = { at: 0, rows: null, wait: null };
  async function ganttRows(force = false) {
    if (!force && ganttCache.rows && Date.now() - ganttCache.at < 15000) return ganttCache.rows;
    if (!ganttCache.wait) ganttCache.wait = api('/api/tasks/gantt').then(r => { ganttCache = { at: Date.now(), rows: r, wait: null }; return r; })
      .catch(e => { ganttCache.wait = null; throw e; });
    return ganttCache.wait;
  }
  const dayNum = v => { if (!v) return null; const [y, m, d] = v.slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d) / 864e5; };
  /** "原定 12/1–12/31，延誤 3 天" from the planned (baseline) and the current dates. */
  function baselineText(x) {
    if (!x.base_due && !x.base_start) return '';
    const md = v => v ? `${+v.slice(5, 7)}/${+v.slice(8, 10)}` : '—';
    const slip = x.base_due && x.due_at ? dayNum(x.due_at) - dayNum(x.base_due) : null;
    return _t("原定 {0}", x.milestone || x.base_start === x.base_due ? md(x.base_due) : `${md(x.base_start)}–${md(x.base_due)}`)
      + (slip == null ? '' : slip > 0 ? _t("，延誤 {0} 天", slip) : slip < 0 ? _t("，提前 {0} 天", -slip) : _t('，準時'));
  }
  /** Milestone, predecessors, actual start and baseline of a card ("t:id") or subtask ("s:id").
   *  opts: { key, item, editable, card (for the baseline buttons), onChange(body) → saves at once; omitted → value() } */
  function scheduleBlock(opts) {
    const { key, item, editable } = opts;
    let milestone = !!item.milestone;
    let deps = (item.deps || []).map(d => ({ key: d.key, lag: d.lag || 0, title: d.title }));
    let started = item.started_at || '';
    const changed = {};
    const emit = part => { Object.assign(changed, part); opts.onChange?.(part); };
    const box = el('div', { class: 'kb-sched' });
    const ms = el('label', { class: 'kb-sched-ms' }, el('input', { type: 'checkbox', checked: milestone, disabled: !editable }),
      el('span', { html: svg('flag') + _t('里程碑') }), el('small', { class: 'hint', text: _t('只看到期日，甘特圖畫成菱形') }));
    ms.querySelector('input').addEventListener('change', e => { milestone = e.target.checked; emit({ milestone }); });
    const chips = el('div', { class: 'kb-dep-chips' });
    const paintChips = () => {
      chips.replaceChildren(...deps.map((d, i) => {
        const lag = el('input', { class: 'input input-sm kb-dep-lag', type: 'number', min: '-365', max: '365', value: String(d.lag || 0), disabled: !editable,
          title: _t('前置完成後間隔幾天才開始（0 = 隔天就開始；可為負數）') });
        lag.addEventListener('change', () => { deps[i].lag = parseInt(lag.value, 10) || 0; emit({ deps: deps.map(({ key: k, lag: l }) => ({ key: k, lag: l })) }); });
        const x = editable ? el('button', { class: 'kb-person-x', type: 'button', 'aria-label': _t('移除前置任務'), html: svg('x') }) : null;
        x?.addEventListener('click', () => { deps.splice(i, 1); paintChips(); emit({ deps: deps.map(({ key: k, lag: l }) => ({ key: k, lag: l })) }); });
        return el('span', { class: 'kb-dep-chip' }, el('span', { class: 'kb-dep-kind', text: d.key.startsWith('t:') ? _t('卡') : _t('子') }),
          el('span', { class: 'kb-dep-title', text: d.title || d.key }), el('span', { class: 'hint', text: '+' }), lag, el('span', { class: 'hint', text: _t('天') }), x);
      }));
      if (!deps.length) chips.append(el('span', { class: 'hint', text: _t('沒有前置任務') }));
    };
    paintChips();
    const find = editable ? el('input', { class: 'input input-sm kb-dep-find', placeholder: _t('＋ 前置任務：輸入名稱搜尋卡片或子任務') }) : null;
    const sug = el('div', { class: 'kb-dep-sug', hidden: true });
    let pool = null;
    async function candidates() {
      if (pool) return pool;
      const rows = await ganttRows().catch(() => []);
      const byCard = new Map(tasks.map(t => [t.id, t]));
      pool = [...tasks.map(t => ({ key: `t:${t.id}`, title: t.title, where: _t('卡片') })),
        ...rows.map(r => ({ key: `s:${r.id}`, title: r.title, where: _t("「{0}」的子任務", byCard.get(r.card)?.title || _t('卡片')) }))]
        .filter(x => x.key !== key);
      return pool;
    }
    find?.addEventListener('input', async () => {
      const q = find.value.trim().toLowerCase();
      const list = (await candidates()).filter(x => !deps.some(d => d.key === x.key) && (!q || x.title.toLowerCase().includes(q))).slice(0, 8);
      sug.replaceChildren(...list.map(x => {
        const b = el('button', { type: 'button', class: 'kb-dep-opt' }, el('span', { text: x.title }), el('small', { class: 'hint', text: x.where }));
        b.addEventListener('mousedown', e => {
          e.preventDefault();
          deps.push({ key: x.key, lag: 0, title: x.title });
          find.value = ''; sug.hidden = true; paintChips();
          emit({ deps: deps.map(({ key: k, lag: l }) => ({ key: k, lag: l })) });
        });
        return b;
      }));
      sug.hidden = !list.length;
    });
    find?.addEventListener('focus', () => find.dispatchEvent(new Event('input')));
    find?.addEventListener('blur', () => setTimeout(() => { sug.hidden = true; }, 150));
    find?.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); sug.hidden = true; } });
    const wins = settings.board_windows || [];
    const winSel = el('select', { class: 'select input-sm kb-win-sel', disabled: !editable, title: _t('這項工作要用的共用時段（停電、維護窗口）；排進凍結期也在這裡標記') },
      el('option', { value: '', text: _t('不使用共用時段') }),
      ...wins.map(w => el('option', { value: w.id, selected: w.id === item.win,
        text: `${w.title}（${w.from.slice(5).replace('-', '/')}${w.to !== w.from ? '–' + w.to.slice(5).replace('-', '/') : ''}${w.kind === 'freeze' ? _t('，凍結期') : _t("，可容納 {0}", w.capacity)}）` })));
    if (item.win && !wins.some(w => w.id === item.win)) winSel.append(el('option', { value: item.win, selected: true, text: _t('（已刪除的時段）') }));
    winSel.addEventListener('change', () => emit({ win: winSel.value }));
    const st = el('input', { class: 'input input-sm', type: 'date', value: started.slice(0, 10), disabled: !editable, title: _t('第一次改成進行中或第一次記工時時自動記錄，也可以修正') });
    st.addEventListener('change', () => { started = st.value; emit({ started_at: started || null }); });
    const base = el('span', { class: 'kb-sched-base', text: baselineText(item) || _t('還沒有設定基準線') });
    let baseBtns = null;
    if (opts.card && editable) {
      const set = el('button', { class: 'kb-link-btn', type: 'button', html: svg('flag') + `<span>${item.base_due || item.base_start ? _t('重設基準線') : _t('設定基準線')}</span>`,
        title: _t('把這張卡片與所有子任務目前的開始／到期日存成原定日期，之後可以看延誤天數') });
      const clear = item.base_due || item.base_start ? el('button', { class: 'kb-link-btn', type: 'button', html: svg('x') + _t('<span>清除</span>') }) : null;
      const run = async clearIt => {
        if (!clearIt && (item.base_due || item.base_start) && !confirm(_t('用目前的日期取代原本的基準線？'))) return;
        try {
          const fresh = await api(`/api/tasks/${opts.card.id}/baseline`, { method: 'POST', body: { clear: !!clearIt } });
          Object.assign(item, { base_start: fresh.base_start, base_due: fresh.base_due });
          base.textContent = baselineText(fresh) || _t('還沒有設定基準線');
          ganttCache.at = 0; load(true).catch(() => {}); opts.onBaseline?.();
          toast(clearIt ? _t('已清除基準線') : _t('已設定基準線（卡片與所有子任務）'));
        } catch (e) { toast(e.message, true); }
      };
      set.addEventListener('click', () => run(false));
      clear?.addEventListener('click', () => run(true));
      baseBtns = el('span', { class: 'kb-sched-btns' }, set, clear);
    }
    box.append(...[
      el('div', { class: 'kb-sched-row' }, ms),
      el('div', { class: 'kb-sched-row' }, el('span', { class: 'kb-sched-label', html: svg('link') + _t('前置任務') }), el('div', { class: 'kb-dep-box' }, chips, find, sug)),
      wins.length || item.win ? el('div', { class: 'kb-sched-row' }, el('span', { class: 'kb-sched-label', html: svg('zap') + _t('共用時段') }), winSel) : null,
      el('div', { class: 'kb-sched-row' }, el('span', { class: 'kb-sched-label', html: svg('play') + _t('實際開始') }), st,
        el('span', { class: 'kb-sched-label', html: svg('calendar') + _t('基準線') }), base, baseBtns)].filter(Boolean));
    return { el: box, value: () => ({ ...changed }) };
  }

  /** Project card on the board: health from the analysis (behind / ahead of the baseline, next milestone, problems) and my part. */
  function projectBlock(t) {
    const h = projHealth(t.id);
    const mine = (t.subtasks?.mine || []).length;
    const slip = h?.slip;
    const md = v => v ? `${+v.slice(5, 7)}/${+v.slice(8, 10)}` : '';
    return el('div', { class: 'kb-proj' },
      el('div', { class: 'kb-proj-row' },
        el('span', { class: 'kb-proj-badge', text: _t('◇ 專案') }),
        h?.rank ? el('span', { class: 'kb-proj-rank', title: _t('主管排序'), text: `#${h.rank}` }) : null,
        slip != null ? el('span', { class: 'kb-chip ' + (slip > 0 ? 'due-overdue' : 'kb-chip-ok'), text: slip > 0 ? _t("落後 {0} 天", slip) : slip < 0 ? _t("提前 {0} 天", -slip) : _t('準時') }) : null,
        h?.problem_items ? el('span', { class: 'kb-chip due-overdue', title: Object.entries(h.problems).filter(([, n]) => n).map(([k, n]) => `${PROBLEM_ZH[k]} ${n}`).join('、'), text: _t("問題 {0}", h.problem_items) }) : null),
      h?.next ? el('div', { class: 'kb-proj-next', text: `◆ ${h.next.title} ${md(h.next.due)}` }) : null,
      el('div', { class: 'kb-proj-row' },
        el('span', { class: 'kb-proj-bar' }, el('i', { style: { width: `${h?.pct ?? 0}%` } })), el('span', { class: 'kb-proj-pct', text: `${h?.pct ?? 0}%` })),
      mine ? el('div', { class: 'kb-proj-mine', text: _t("我在這個專案的工作 {0} 項 ›", mine) }) : null);
  }
  const PROBLEM_ZH = { overdue: _t('逾期'), blocked: _t('卡住'), conflict: _t('排程衝突'), xdep: _t('跨專案前置'), window: _t('時段衝突'), overload: _t('超載') };

  function openSubtaskEditor(card, c, onSaved) {
    const s = c.task;
    const edit = s.can_edit;
    const split = v => { const [d, tm] = (v || '').split('T'); return [d || '', tm || '']; };
    const [sd, stt] = split(s.start_at);
    const [dd, dtt] = split(s.due_at);
    const title = el('input', { class: 'input kb-title-input', value: s.title || '', maxlength: '200', disabled: !edit });
    const desc = el('textarea', { class: 'textarea', rows: '4', placeholder: _t('細節、步驟、注意事項…'), disabled: !c.can_edit_body });
    desc.value = c.body && c.body.trim() !== (s.title || '').trim() ? c.body : '';
    if (meInfo.people && c.can_edit_body) TT.mentionInput(desc);
    const status = el('select', { class: 'select', disabled: !s.can_update },
      STATUSES.filter(x => x.key !== 'recurring' && x.key !== 'overdue').map(x => el('option', { value: x.key, text: stName(x) })));
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
    const startT = el('input', { class: 'input kb-time', type: 'time', value: stt, disabled: !edit, title: _t('時間（選填）') });
    const dueD = el('input', { class: 'input', type: 'date', value: dd, disabled: !edit });
    const dueT = el('input', { class: 'input kb-time', type: 'time', value: dtt, disabled: !edit, title: _t('時間（選填；不填＝當天結束前）') });
    const remind = el('select', { class: 'select', disabled: !edit }, REMINDS.map(([v, l]) => el('option', { value: v, text: l })));
    remind.value = s.remind == null ? '' : String(s.remind);
    const est = el('input', { class: 'input', type: 'number', min: '0', max: '1000', step: '0.5', placeholder: _t('小時'), disabled: !edit,
      value: s.estimate_minutes ? String(+(s.estimate_minutes / 60).toFixed(2)) : '' });
    const value = (d, tm) => d.value ? d.value + (tm.value ? 'T' + tm.value : '') : null;
    const hint = el('p', { class: 'hint kb-remind-hint' });
    const paintHint = () => {
      const due = value(dueD, dueT);
      remind.disabled = !edit || !due;
      const rm = due ? remindMoment({ due_at: due, remind: remind.value === '' ? null : Number(remind.value) }) : null;
      hint.textContent = due ? _t("到期：{0}{1} · {2}", fmt(due, true), due.includes('T') ? '' : _t('（當天結束前）'), rm ? _t('提醒：') + fmtMoment(rm) : _t('不提醒')) : _t('沒有到期日就不會提醒');
    };
    [startD, startT, dueD, dueT, remind].forEach(x => x.addEventListener('input', paintHint));
    paintHint();

    // assignee
    let assignee = s.assignee ? { ...s.assignee } : null;
    const who = el('div', { class: 'kb-assignees' });
    const paintWho = () => {
      const chip = assignee ? el('span', { class: 'kb-person' }, TT.avatar(assignee, 22), el('span', { text: TT.nameOf(assignee) }),
        s.can_assign ? (() => { const x = el('button', { type: 'button', class: 'kb-person-x', 'aria-label': _t('取消指派'), html: svg('x') }); x.addEventListener('click', () => { assignee = null; paintWho(); }); return x; })() : null) : null;
      const inp = s.can_assign ? TT.mentionInput(el('input', { class: 'input kb-assign-input', placeholder: assignee ? _t('改派給…') : _t('輸入姓名或帳號，指派負責人…') }),
        { onPick: p => { assignee = { username: p.username, name: TT.nameOf(p), department: p.department }; paintWho(); } }) : null;
      who.replaceChildren(...[chip || (inp ? null : el('span', { class: 'hint', text: _t('未指派') })), inp].filter(Boolean));
    };
    paintWho();

    // attachments: saved right away, like a card's
    let files = (c.images || []).map(x => ({ ...x }));
    const filesBox = el('div', { class: 'kb-images' });
    const paintFiles = () => {
      const add = c.can_edit_body ? el('button', { class: 'btn btn-sm kb-img-add', type: 'button', html: svg('paperclip') + _t('加入檔案') }) : null;
      add?.addEventListener('click', () => pickFiles(addFiles));
      filesBox.replaceChildren(...[
        files.length ? thumbs(files, { onRemove: c.can_edit_body ? removeFile : null }) : null,
        add ? el('div', { class: 'kb-img-tools' }, add, el('span', { class: 'hint', text: _t('也可以貼上（Ctrl+V）或拖進來；加入後立即儲存') })) : null,
        !add && !files.length ? el('span', { class: 'hint', text: _t('沒有附件') }) : null].filter(Boolean));
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
      if (!confirm(_t("移除「{0}」？", im.name || _t('這個附件')))) return;
      try { await api(`/api/tasks/${card.id}/images/${im.id}`, { method: 'DELETE' }); files = files.filter(x => x !== im); changed = true; paintFiles(); }
      catch (e) { toast(e.message, true); }
    }
    paintFiles();
    let changed = false;

    const field = (label, ...ctl) => el('label', { class: 'field' }, el('span', { class: 'field-label', text: label }), ...ctl);
    const sched = scheduleBlock({ key: `s:${c.id}`, item: { ...s, deps: s.deps || [] }, editable: !!edit });
    const ok = el('button', { class: 'btn btn-primary', type: 'button', html: svg('check') + _t('儲存') });
    const cancel = el('button', { class: 'btn btn-ghost', type: 'button', text: edit || c.can_edit_body ? _t('取消') : _t('關閉') });
    const closeBtn = el('button', { class: 'icon-btn', type: 'button', 'aria-label': _t('關閉'), html: svg('x') });
    const spent = s.spent_minutes || 0;
    const wrap = el('div', { class: 'modal kb-sub-modal' },
      el('div', { class: 'modal-card kb-editor', role: 'dialog', 'aria-modal': 'true', 'aria-label': _t('子任務') },
        el('div', { class: 'modal-head' }, el('h3', { html: svg('check') + (edit ? _t('編輯子任務') : _t('檢視子任務')) }), closeBtn),
        el('div', { class: 'modal-body' },
          el('p', { class: 'hint kb-sub-of', text: _t("「{0}」的子任務", card.title) }),
          !edit && !c.can_edit_body ? el('div', { class: 'kb-readonly', html: svg('lock') + _t('<span>唯讀：只有能編輯卡片的人或子任務負責人可以修改。</span>') }) : null,
          field(_t('標題'), title),
          field(_t('說明'), desc),
          el('div', { class: 'field' }, el('span', { class: 'field-label', html: svg('paperclip') + _t('附件') }), filesBox),
          meInfo.people ? el('div', { class: 'field' }, el('span', { class: 'field-label', html: svg('user') + _t('負責人') }), who) : null,
          el('div', { class: 'kb-row' }, field(_t('狀態'), status), el('div', { class: 'field' }, el('span', { class: 'field-label', text: _t('優先順序') }), prio)),
          el('div', { class: 'kb-row' },
            el('div', { class: 'field' }, el('span', { class: 'field-label', html: svg('play') + _t('開始日') }), el('div', { class: 'kb-dt' }, startD, startT)),
            el('div', { class: 'field' }, el('span', { class: 'field-label', html: svg('clock') + _t('到期日') }), el('div', { class: 'kb-dt' }, dueD, dueT))),
          el('div', { class: 'kb-row' }, field(_t('提醒'), remind), field(_t('預估工時（小時）'), est)),
          el('div', { class: 'field' }, el('span', { class: 'field-label', html: svg('calendar') + _t('排程（甘特圖）') }), sched.el),
          hint,
          el('p', { class: 'hint', text: _t("已記錄工時 {0}{1}（計時與明細在卡片的子任務區）", fmtMin(spent), s.estimate_minutes ? _t(" / 預估 {0}", fmtMin(s.estimate_minutes)) : '') })),
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
      if (edit && !title.value.trim()) { toast(_t('請輸入標題'), true); title.focus(); return; }
      const start = value(startD, startT), due = value(dueD, dueT);
      if (start && due && start.slice(0, 10) > due.slice(0, 10)) { toast(_t('開始日不能晚於到期日'), true); return; }
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
        Object.assign(body, sched.value());
        if (body.milestone ?? s.milestone) delete body.start_at;
        if ((body.milestone ?? s.milestone) && !(body.due_at ?? s.due_at)) { toast(_t('里程碑需要到期日'), true); return; }
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
        toast(_t('子任務已儲存'));
      } catch (e) { toast(e.message, true); ok.disabled = false; }
    });
    document.body.append(wrap);
    setTimeout(() => (edit ? title : cancel).focus(), 30);
  }

  // ----------------------------------------------------------------- editor
  function openEditor(task, defaults = {}) {
    let refreshComments = () => {};           // set once the comment list exists (卡住 adds a comment)
    const t = task || { title: defaults.title || '', description: '', status: defaults.status || 'new', priority: 'normal', start_at: null, due_at: null, remind: 1440, repeat: defaults.repeat || null, repeat_every: 1, assignees: defaults.assignees || [], kind: defaults.kind || 'ops', project_id: defaults.project_id || null };
    const split = v => { const [d, tm] = (v || '').split('T'); return [d || '', tm || '']; };
    const [sd, st] = split(t.start_at);
    const [dd, dt] = split(t.due_at);

    const title = el('input', { class: 'input kb-title-input', value: t.title, maxlength: '200', placeholder: _t('要做什麼？') });
    const desc = el('textarea', { class: 'textarea', rows: '4', placeholder: meInfo.people ? _t('細節、連結、注意事項（選填）。輸入 @ 可以找同事一起協作') : _t('細節、連結、注意事項（選填）') });
    desc.value = t.description || '';
    if (meInfo.people) TT.mentionInput(desc);

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
      const add = canImage ? el('button', { class: 'btn btn-sm kb-img-add', type: 'button', html: svg('paperclip') + _t('加入檔案') }) : null;
      add?.addEventListener('click', () => pickFiles(addCardImages));
      imgBox.replaceChildren(...[
        cardImages.length ? thumbs(cardImages, { onRemove: canImage ? removeCardImage : null }) : null,
        canImage ? el('div', { class: 'kb-img-tools' }, add, el('span', { class: 'hint', text: _t('圖片、PDF、Office、md／json／yaml／toml／txt／py／rs／mermaid；也可以貼上（Ctrl+V）或拖進這個視窗') + (task ? _t('，加入後立即儲存') : '') })) : null,
        !canImage && !cardImages.length ? el('span', { class: 'hint', text: _t('沒有附件') }) : null].filter(Boolean));
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
        if (!confirm(_t("移除「{0}」？", im.name || _t('這個附件')))) return;
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
    const canAssign = meInfo.people && (task ? task.can_assign : meInfo.board?.edit !== 'own' || !!meInfo.board?.team_edit);
    const readOnly = !!task && task.can_edit === false;          // RO managers: view + comment
    // --- tags: type and press Enter (or pick a suggestion); Backspace in an empty box removes the last one
    let tagList = [...(t.tags || [])];
    const tagInput = el('input', { class: 'kb-tag-input', type: 'text', maxlength: '24', placeholder: _t('輸入標籤後按 Enter'), autocomplete: 'off', list: 'kb-tag-list' });
    const tagData = el('datalist', { id: 'kb-tag-list' });
    const tagBox = el('div', { class: 'kb-tag-edit' });
    const tagSug = el('div', { class: 'kb-tag-sugs' });
    function addTag(raw) {
      const v = String(raw || '').trim().replace(/^[#＃]+/, '').replace(/\s+/g, ' ').trim();
      if (!v) return;
      if (v.length > 24) { toast(_t('標籤最多 24 個字'), true); return; }
      if (tagList.some(x => x.toLowerCase() === v.toLowerCase())) return;
      if (tagList.length >= 8) { toast(_t('一張卡片最多 8 個標籤'), true); return; }
      tagList.push(v);
      paintTags();
    }
    function paintTags() {
      tagBox.replaceChildren(...tagList.map(x => tagChip(x, { onRemove: n => { tagList = tagList.filter(y => y !== n); paintTags(); } })), tagInput);
      const used = new Set(tagList.map(x => x.toLowerCase()));
      const free = knownTags().filter(x => !used.has(x.toLowerCase()));
      tagData.replaceChildren(...free.map(x => el('option', { value: x })));
      tagSug.replaceChildren(...(free.length ? [el('span', { class: 'hint', text: _t('常用：') }), ...free.slice(0, 8).map(x => {
        const b = tagChip(x, { onClick: () => { addTag(x); tagInput.focus(); } });
        b.classList.add('kb-tag-sug');
        b.title = _t("加上 #{0}", x);
        return b;
      })] : []));
    }
    tagInput.addEventListener('keydown', e => {
      if ((e.key === 'Enter' || e.key === ',' || e.key === '，') && !e.isComposing) {
        e.preventDefault(); e.stopPropagation();
        addTag(tagInput.value); tagInput.value = '';
      } else if (e.key === 'Backspace' && !tagInput.value && tagList.length) {
        tagList.pop(); paintTags();
      }
    });
    tagInput.addEventListener('change', () => { if (knownTags().some(x => x === tagInput.value)) { addTag(tagInput.value); tagInput.value = ''; } });
    tagBox.addEventListener('click', e => { if (e.target === tagBox) tagInput.focus(); });
    paintTags();

    let assignees = (t.assignees || []).map(p => ({ ...p }));
    const assignBox = el('div', { class: 'kb-assignees' });
    const assignInput = canAssign ? TT.mentionInput(el('input', { class: 'input kb-assign-input', placeholder: _t('輸入姓名或帳號，指派負責人…') }), {
      onPick: p => { if (!assignees.some(a => a.username === p.username)) assignees.push({ username: p.username, name: TT.nameOf(p), department: p.department }); paintAssignees(); },
    }) : null;
    function paintAssignees() {
      assignBox.replaceChildren(...assignees.map(p => el('span', { class: 'kb-person' }, TT.avatar(p, 22), el('span', { text: TT.nameOf(p) }),
        canAssign ? (() => { const x = el('button', { type: 'button', class: 'kb-person-x', 'aria-label': _t('移除'), html: svg('x') }); x.addEventListener('click', () => { assignees = assignees.filter(a => a.username !== p.username); paintAssignees(); }); return x; })() : null)),
        ...(assignInput ? [assignInput] : assignees.length ? [] : [el('span', { class: 'hint', text: task ? _t('未指派（只有管理員可以指派）') : _t('新卡片會指派給你自己') })]));
    }
    paintAssignees();
    const status = el('select', { class: 'select' }, STATUSES.map(s => el('option', { value: s.key, text: stName(s) })));
    status.value = t.status;
    const summary = !!task && isSummary(t) && t.status !== 'canceled';

    let priority = t.priority;
    const prio = el('div', { class: 'segmented', role: 'group' }, PRIORITIES.map(([v, label]) => {
      const b = el('button', { type: 'button', dataset: { v }, html: (v === 'high' ? svg('flag') : '') + `<span>${label}</span>` });
      b.addEventListener('click', () => { priority = v; paintPrio(); });
      return b;
    }));
    const paintPrio = () => prio.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === priority)));
    paintPrio();

    const startD = el('input', { class: 'input', type: 'date', value: sd });
    const startT = el('input', { class: 'input kb-time', type: 'time', value: st, title: _t('時間（選填）') });
    const dueD = el('input', { class: 'input', type: 'date', value: dd });
    const dueT = el('input', { class: 'input kb-time', type: 'time', value: dt, title: _t('時間（選填；不填＝當天結束前）') });
    const remind = el('select', { class: 'select' }, REMINDS.map(([v, l]) => el('option', { value: v, text: l })));
    remind.value = t.remind === null || t.remind === undefined ? '' : String(t.remind);
    const hint = el('p', { class: 'hint kb-remind-hint' });

    // --- repeat
    const ruleKind = (t.repeat || '').split(':')[0];
    const repeatSel = el('select', { class: 'select' }, REPEATS.map(([v, l]) => el('option', { value: v, text: l })));
    repeatSel.value = ruleKind;
    const every = el('input', { class: 'input kb-every', type: 'number', min: '1', max: '365', value: t.repeat_every || 1 });
    const everyUnit = el('span', { class: 'kb-every-unit' });
    const everyBox = el('label', { class: 'kb-every-box' }, el('span', { text: _t('每') }), every, everyUnit);
    let weekDays = ruleKind === 'weekly' && t.repeat.includes(':') ? t.repeat.split(':')[1].split(',').map(Number) : [];
    const weekBox = el('div', { class: 'kb-weekdays', role: 'group', 'aria-label': _t('星期') }, [1, 2, 3, 4, 5, 6, 7].map(d => {
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
      else if (!due) repeatHint.textContent = _t('⚠ 重複需要到期日：下一次依到期日推算');
      else {
        const n = Math.max(1, Number(every.value) || 1);
        const next = nextDue(due, rule === 'monthly' ? `monthly:${Number(due.slice(8, 10))}` : rule, n);
        repeatHint.textContent = _t("{0}。到期時會問你是否結案；結案後下一張（{1}）會自動排進「週期工作」。", repeatText(rule === 'monthly' ? `monthly:${Number(due.slice(8, 10))}` : rule, n, due), fmt(next, true));
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
      shortcut(_t('今天'), () => { dueD.value = plus(0); }),
      shortcut(_t('明天'), () => { dueD.value = plus(1); }),
      shortcut(_t('下週一'), () => { dueD.value = nextMonday(); }),
      shortcut(_t('一週後'), () => { dueD.value = plus(7); }),
      shortcut(_t('清除'), () => { dueD.value = ''; dueT.value = ''; }));
    const startChips = el('div', { class: 'kb-date-chips' },
      shortcut(_t('今天'), () => { startD.value = plus(0); }),
      shortcut(_t('明天'), () => { startD.value = plus(1); }),
      shortcut(_t('清除'), () => { startD.value = ''; startT.value = ''; }));

    const value = (d, tm) => d.value ? d.value + (tm.value ? 'T' + tm.value : '') : null;
    function paintHint() {
      const due = value(dueD, dueT);
      remind.disabled = !due;
      const r = remind.value === '' ? null : Number(remind.value);
      const parts = [];
      const s = value(startD, startT);
      if (s) parts.push(_t("開始：{0}", fmt(s, true)));
      if (due) {
        parts.push(_t("到期：{0}{1}", fmt(due, true), due.includes('T') ? '' : _t('（當天結束前）')));
        const rm = remindMoment({ due_at: due, remind: r });
        parts.push(rm ? _t("提醒：{0}", fmtMoment(rm)) : _t('不提醒'));
      } else parts.push(_t('沒有到期日就不會提醒'));
      hint.textContent = parts.join(' · ');
    }
    [startD, startT, dueD, dueT, remind].forEach(x => x.addEventListener('input', () => { paintHint(); paintRepeat(); }));
    paintHint();
    paintRepeat();

    const field = (label, ...ctl) => el('label', { class: 'field' }, el('span', { class: 'field-label', text: label }), ...ctl);
    const sched = scheduleBlock({ key: task ? `t:${task.id}` : null, item: { ...t, deps: t.deps || [] }, editable: !readOnly, card: task || null });
    // kind: everyday card or project; an everyday card may belong to a project
    let kind = t.kind || 'ops';
    const kindSeg = el('div', { class: 'segmented', role: 'group', 'aria-label': _t('卡片類型') },
      ...[['ops', _t('一般（維運）')], ['project', _t('專案')]].map(([v, l]) => {
        const b = el('button', { type: 'button', dataset: { v }, text: l, disabled: readOnly });
        b.addEventListener('click', () => { kind = v; paintKind(); });
        return b;
      }));
    const projSel = el('select', { class: 'select', disabled: readOnly, 'aria-label': _t('歸屬專案') },
      el('option', { value: '', text: _t('不歸屬任何專案') }),
      ...tasks.filter(x => isProject(x) && x.id !== task?.id).map(x => el('option', { value: x.id, text: x.title, selected: x.id === t.project_id })));
    const projField = el('div', { class: 'field' }, el('span', { class: 'field-label', html: svg('layout') + _t('歸屬專案') }), projSel,
      el('span', { class: 'hint', text: _t('這張卡片也會出現在該專案的甘特圖與專案看板') }));
    const kindHint = el('span', { class: 'hint' });
    const paintKind = () => {
      kindSeg.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === kind)));
      projField.hidden = kind === 'project';
      kindHint.textContent = kind === 'project' ? _t('專案有自己的專案頁（甘特圖、專案看板、清單），在待辦看板上以一張專案卡出現') : '';
    };
    paintKind();
    const ok = el('button', { class: 'btn btn-primary', type: 'button', html: svg('check') + (task ? _t('儲存') : _t('新增')) });
    const cancel = el('button', { class: 'btn btn-ghost', type: 'button', text: _t('取消') });
    const del = task && task.can_delete !== false ? el('button', { class: 'btn btn-danger kb-del', type: 'button', html: svg('trash') + _t('刪除') }) : null;
    const xlsBtn = task ? el('button', { class: 'btn btn-ghost', type: 'button', title: _t('把這張卡片（含子任務、留言、工時）匯出成 Excel'), html: svg('download') + 'Excel' }) : null;
    const navBtn = task ? el('button', { class: 'btn btn-ghost', type: 'button', title: _t('任務視窗：子任務由左至右逐層展開'), html: svg('layout') + _t('任務視窗') }) : null;
    navBtn?.addEventListener('click', () => { close(); openNavigator(task); });
    xlsBtn?.addEventListener('click', () => exportReport([task.id]));
    const closeBtn = el('button', { class: 'icon-btn', type: 'button', 'aria-label': _t('關閉'), html: svg('x') });
    const meta = task ? el('p', { class: 'hint', text: (task.owner ? _t("{0} 建立於 ", TT.nameOf(task.owner)) : _t('建立於 ')) + (task.created_at?.slice(0, 16) || '')
      + (task.completed_at ? _t(" · 完成於 {0}", task.completed_at.slice(0, 16)) : '')
      + (task.mentions?.length ? _t(" · 協作：{0}", task.mentions.map(TT.nameOf).join('、')) : '') }) : null;

    // --- comments → threads + subtasks (existing cards). The card is the summary task;
    //     a top-level comment can become a subtask with its own status, dates, assignee and time log.
    let addCommentImages = null;
    const comments = task ? el('section', { class: 'kb-comments' }) : null;
    let stopTicker = () => {};
    if (task) {
      const listBox = el('div', { class: 'kb-comment-list' });
      const rollBox = el('div', { class: 'kb-rollup' });
      const input = el('textarea', { class: 'textarea kb-comment-input', rows: '2', placeholder: meInfo.people ? _t('留言…（輸入 @ 提到同事，他會收到通知）') : _t('留言…') });
      if (meInfo.people) TT.mentionInput(input);
      const send = el('button', { class: 'btn btn-sm btn-primary', type: 'button', html: svg('message') + _t('送出') });
      const attach = el('button', { class: 'btn btn-sm kb-comment-attach', type: 'button', title: _t('附加圖片或檔案（也可以貼上或拖曳）'), 'aria-label': _t('附加檔案'), html: svg('paperclip') });
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
      newestFirst = TT.store.get(ORDER_KEY) === 'desc'; onlyTasks = TT.store.get(VIEW_KEY) === 'tasks';
      const orderBtn = el('button', { class: 'btn btn-sm btn-ghost kb-comment-order', type: 'button' });
      const viewBtn = el('button', { class: 'btn btn-sm btn-ghost kb-comment-order', type: 'button' });
      const paintOrder = () => {
        orderBtn.innerHTML = svg('clock') + (newestFirst ? _t('最新在上') : _t('最舊在上'));
        orderBtn.title = newestFirst ? _t('目前依留言時間遞減（新→舊），點一下改為遞增') : _t('目前依留言時間遞增（舊→新），點一下改為遞減');
        viewBtn.innerHTML = svg('check') + (onlyTasks ? _t('只看子任務') : _t('全部留言'));
        viewBtn.title = onlyTasks ? _t('目前只列出子任務，點一下顯示全部留言') : _t('點一下只列出子任務');
      };
      paintOrder();
      orderBtn.addEventListener('click', () => {
        newestFirst = !newestFirst;
        TT.store.set(ORDER_KEY, newestFirst ? 'desc' : 'asc');
        paintOrder(); paint();
      });
      viewBtn.addEventListener('click', () => {
        onlyTasks = !onlyTasks;
        TT.store.set(VIEW_KEY, onlyTasks ? 'tasks' : 'all');
        paintOrder(); paint();
      });

      let threads = [], allThreads = [];
      let fetchedAt = Date.now();
      let replyTo = null;                 // { root, mention }
      let openLogs = new Set();           // subtasks whose time log is expanded
      let openTime = null;                // subtask id with the "add time" form open
      let editTime = null;                // { cid, entry, prompt }: fixing a work-log entry (opens by itself when a timer stops)

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
        const x = el('button', { class: 'kb-comment-del', type: 'button', title: isRoot && c.replies?.length ? _t('刪除留言（連同回覆）') : _t('刪除留言'), html: svg('trash') });
        x.addEventListener('click', async () => {
          const what = c.task ? _t("子任務「{0}」（含工時記錄{1}）", c.task.title, c.replies?.length ? _t('與回覆') : '') : c.replies?.length ? _t("這則留言與 {0} 則回覆", c.replies.length) : _t('這則留言');
          if ((c.task || c.replies?.length) && !confirm(_t("刪除{0}？", what))) return;
          try { await api(`/api/tasks/${task.id}/comments/${c.id}`, { method: 'DELETE' }); await loadComments(); load(true); } catch (e) { toast(e.message, true); }
        });
        return x;
      };
      const linkBtn = (label, icon, fn, title) => {
        const b = el('button', { class: 'kb-link-btn', type: 'button', title: title || label, html: svg(icon) + `<span>${label}</span>` });
        b.addEventListener('click', fn);
        return b;
      };

      function subtaskBox(c, level = 2) {
        const s = c.task;
        const st = STATUS[s.status] || STATUS.new;
        const box = el('div', { class: `kb-sub st-${s.status}`, style: { '--st': st.color } });
        const edit = s.can_edit;
        // row 1: status + title
        const stSel = el('select', { class: 'select kb-sub-status', title: _t('子任務狀態'), disabled: !s.can_update },
          STATUSES.filter(x => x.key !== 'recurring' && x.key !== 'overdue').map(x => el('option', { value: x.key, text: stName(x) })));
        stSel.value = s.status;
        stSel.addEventListener('change', () => subPut(c, { status: stSel.value }));
        const titleIn = el('input', { class: 'input kb-sub-title', value: s.title || '', maxlength: '200', disabled: !edit, title: _t('子任務名稱') });
        titleIn.addEventListener('change', () => { if (titleIn.value.trim() && titleIn.value.trim() !== s.title) subPut(c, { title: titleIn.value.trim() }); else titleIn.value = s.title; });
        titleIn.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); titleIn.blur(); } });
        const tm = timing({ status: s.status, due_at: s.due_at, start_at: s.start_at });
        const dueChip = tm.due && tm.due !== 'later' ? el('span', { class: `kb-chip due-${tm.due}`, html: svg('clock') + `<span>${tm.dueText}</span>` }) : null;
        const editBtn = el('button', { class: 'kb-link-btn kb-sub-edit', type: 'button', title: edit ? _t('編輯子任務（說明、附件、時間、提醒…）') : _t('檢視子任務'), html: svg(edit ? 'edit' : 'external') + `<span>${edit ? _t('編輯') : _t('檢視')}</span>` });
        editBtn.addEventListener('click', () => openSubtaskEditor(task, c, async () => { await loadComments(); load(true); }));
        box.append(el('div', { class: 'kb-sub-row' }, el('span', { class: 'kb-lv', title: _t("第 {0} 層（主卡為 L1）", level), text: `L${level}` }), stSel,
          s.priority === 'high' ? el('span', { class: 'kb-flag', title: _t('高優先'), html: svg('flag') }) : null, titleIn,
          s.due_at && s.remind != null && !CLOSED.has(s.status) ? el('span', { class: 'kb-chip remind', title: _t("提醒：{0}", fmtMoment(remindMoment(s))), html: svg('bell') }) : null,
          dueChip, editBtn));

        // row 2: assignee, start, due, estimate
        const fields = el('div', { class: 'kb-sub-fields' });
        if (meInfo.people) {
          const who = el('div', { class: 'kb-sub-who' });
          const paintWho = () => {
            const chip = s.assignee
              ? el('span', { class: 'kb-person' }, TT.avatar(s.assignee, 20), el('span', { text: TT.nameOf(s.assignee) }),
                s.can_assign ? (() => { const x = el('button', { type: 'button', class: 'kb-person-x', 'aria-label': _t('取消指派'), html: svg('x') }); x.addEventListener('click', () => subPut(c, { assignee: '' })); return x; })() : null)
              : null;
            const pickBtn = s.can_assign ? el('button', { class: 'kb-link-btn', type: 'button', html: svg('user') + `<span>${s.assignee ? _t('改派') : _t('指派')}</span>` }) : null;
            pickBtn?.addEventListener('click', () => {
              const inp = TT.mentionInput(el('input', { class: 'input input-sm kb-sub-assign', placeholder: _t('輸入姓名或帳號…') }), { onPick: p => subPut(c, { assignee: p.username }) });
              inp.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); paintWho(); } });
              inp.addEventListener('blur', () => setTimeout(() => inp.isConnected && paintWho(), 200));
              who.replaceChildren(inp);
              inp.focus();
            });
            who.replaceChildren(...[chip || el('span', { class: 'hint', text: _t('未指派') }), pickBtn].filter(Boolean));
          };
          paintWho();
          fields.append(el('label', { class: 'kb-sub-field' }, el('span', { html: svg('user') + _t('負責') }), who));
        }
        const dateIn = (key, label, icon) => {
          if (!edit) return el('label', { class: 'kb-sub-field' }, el('span', { html: svg(icon) + label }), el('span', { class: 'kb-sub-ro', text: s[key] ? fmt(s[key], true) : '—' }));
          const inp = el('input', { class: 'input input-sm', type: 'date', value: (s[key] || '').slice(0, 10), title: s[key]?.includes('T') ? _t("時間 {0}（在「編輯」裡修改）", s[key].slice(11, 16)) : '' });
          inp.addEventListener('change', () => subPut(c, { [key]: inp.value ? inp.value + (s[key]?.includes('T') ? s[key].slice(10) : '') : null }));
          return el('label', { class: 'kb-sub-field' }, el('span', { html: svg(icon) + label }), inp);
        };
        fields.append(dateIn('start_at', _t('開始'), 'play'), dateIn('due_at', _t('到期'), 'clock'));
        const est = !edit ? el('span', { class: 'kb-sub-ro', text: s.estimate_minutes ? fmtMin(s.estimate_minutes) : '—' })
          : el('input', { class: 'input input-sm kb-sub-est', type: 'number', min: '0', max: '1000', step: '0.5', placeholder: '—',
            value: s.estimate_minutes ? String(+(s.estimate_minutes / 60).toFixed(2)) : '' });
        if (edit) est.addEventListener('change', () => {
          const h = parseFloat(est.value);
          subPut(c, { estimate_minutes: Number.isFinite(h) && h > 0 ? Math.round(h * 60) : null });
        });
        fields.append(el('label', { class: 'kb-sub-field' }, el('span', { html: svg('calendar') + (edit ? _t('預估（小時）') : _t('預估')) }), est));
        box.append(fields);

        // row 3: time tracking
        const spent = s.spent_minutes || 0;
        const pct = s.estimate_minutes ? Math.min(100, Math.round(spent / s.estimate_minutes * 100)) : null;
        const over = s.estimate_minutes && spent > s.estimate_minutes;
        const bar = s.estimate_minutes ? el('span', { class: 'kb-bar' + (over ? ' over' : ''), title: `${pct}%` }, el('span', { style: { width: `${pct}%` } })) : null;
        const running = s.my_timer;
        const clock = running ? el('span', { class: 'kb-timer-clock', dataset: { elapsed: running.elapsed } }) : null;
        const timerBtn = s.can_update && (running || !CLOSED.has(s.status))
          ? el('button', { class: 'btn btn-sm ' + (running ? 'btn-danger' : ''), type: 'button', html: running ? _t('■ 停止') : _t('▶ 開始計時') }) : null;
        timerBtn?.addEventListener('click', async () => {
          timerBtn.disabled = true;
          try {
            const r = await api(`/api/tasks/${task.id}/comments/${c.id}/timer`, { method: 'POST', body: { action: running ? 'stop' : 'start', work_date: isoDay(now()) } });
            // stopped: ask right away what the time was for (otherwise the log is just a number)
            if (running && r && r.entry) { editTime = { cid: c.id, entry: r.entry, prompt: true }; openTime = null; openLogs.add(c.id); }
          }
          catch (e) { toast(e.message, true); }
          await loadComments(); load(true);
        });
        const addBtn = s.can_update ? linkBtn(_t('記錄工時'), 'plus', () => { openTime = openTime === c.id ? null : c.id; paint(); }) : null;
        const othersRunning = s.entries.filter(e => e.running && !(running && e.id === running.id));
        const logBtn = s.entries.length ? linkBtn(_t("明細（{0}）", s.entries.length), 'list', () => { openLogs.has(c.id) ? openLogs.delete(c.id) : openLogs.add(c.id); paint(); }) : null;
        box.append(el('div', { class: 'kb-sub-time' },
          el('span', { class: 'kb-sub-hours', html: svg('clock') + _t("<span>已記錄 <b>{0}</b>{1}</span>", fmtMin(spent), s.estimate_minutes ? _t(" / 預估 {0}", fmtMin(s.estimate_minutes)) : '') }),
          bar, othersRunning.length ? el('span', { class: 'hint', text: _t("{0} 計時中", othersRunning.map(e => TT.nameOf(e.user || {})).join('、')) }) : null,
          el('span', { class: 'spacer' }), clock, timerBtn, addBtn, logBtn));
        if (openTime === c.id) box.append(timeForm(c));
        if (editTime && editTime.cid === c.id) box.append(timeForm(c, editTime.entry, editTime.prompt));
        if (openLogs.has(c.id) && s.entries.length) {
          box.append(el('div', { class: 'kb-time-log' }, s.entries.map(e => {
            const x = e.can_delete && !e.running ? el('button', { class: 'kb-comment-del', type: 'button', title: _t('刪除這筆工時'), html: svg('trash') }) : null;
            const ed = e.can_delete && !e.running ? el('button', { class: 'kb-comment-del', type: 'button', title: _t('修改這筆工時（說明、時數、日期）'), html: svg('edit') }) : null;
            ed?.addEventListener('click', () => { editTime = { cid: c.id, entry: e }; openTime = null; paint(); });
            x?.addEventListener('click', async () => {
              try { await api(`/api/tasks/${task.id}/comments/${c.id}/time/${e.id}`, { method: 'DELETE' }); await loadComments(); load(true); } catch (err) { toast(err.message, true); }
            });
            return el('div', { class: 'kb-time-row' },
              el('span', { class: 'kb-time-date', text: e.work_date ? e.work_date.slice(5).replace('-', '/') : '' }),
              meInfo.people && e.user ? el('span', { class: 'kb-time-user', text: TT.nameOf(e.user) }) : null,
              el('b', { text: e.running ? _t('計時中…') : fmtMin(e.minutes) }),
              el('span', { class: 'kb-time-note' + (e.note ? '' : ' is-empty'), text: e.note || (e.running ? '' : _t('（沒有說明）')) }), ed, x);
          })));
        }
        if (s.completed_at && s.status === 'complete') box.append(el('p', { class: 'hint kb-sub-done', text: _t("完成於 {0}", s.completed_at.slice(0, 16)) }));
        return box;
      }

      /** New entry, or (entry given) fix one — after stopping the timer it opens by itself with the note focused. */
      function timeForm(c, entry = null, prompt = false) {
        const mins = entry ? entry.minutes || 0 : 60;
        const h = el('input', { class: 'input input-sm', type: 'number', min: '0', max: '24', step: '1', value: String(Math.floor(mins / 60)), 'aria-label': _t('小時') });
        const m = el('input', { class: 'input input-sm', type: 'number', min: '0', max: '59', step: '5', value: String(mins % 60), 'aria-label': _t('分鐘') });
        const day = el('input', { class: 'input input-sm', type: 'date', value: entry?.work_date || isoDay(now()) });
        const note = el('input', { class: 'input input-sm kb-time-note-in', maxlength: '200', value: entry?.note || '',
          placeholder: entry ? _t('這段時間做了什麼？例如：編寫腳本、測試、與廠商確認') : _t('做了什麼（選填）') });
        const ok = el('button', { class: 'btn btn-sm btn-primary', type: 'button', text: entry ? _t('儲存') : _t('記錄') });
        const skip = entry ? el('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: prompt ? _t('略過') : _t('取消') }) : null;
        skip?.addEventListener('click', () => { editTime = null; paint(); });
        ok.addEventListener('click', async () => {
          const minutes = (parseInt(h.value, 10) || 0) * 60 + (parseInt(m.value, 10) || 0);
          if (minutes < 1) { toast(_t('請輸入工時'), true); return; }
          ok.disabled = true;
          try {
            if (entry) await api(`/api/tasks/${task.id}/comments/${c.id}/time/${entry.id}`, { method: 'PUT', body: { minutes, note: note.value, work_date: day.value || null } });
            else await api(`/api/tasks/${task.id}/comments/${c.id}/time`, { method: 'POST', body: { minutes, note: note.value, work_date: day.value || null } });
            openTime = null; editTime = null; openLogs.add(c.id);
            await loadComments(); load(true);
          } catch (e) { toast(e.message, true); ok.disabled = false; }
        });
        note.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); ok.click(); } });
        if (entry) setTimeout(() => note.isConnected && note.focus(), 40);
        const head = entry ? el('div', { class: 'kb-time-form-head', text: prompt ? _t("計時已停止：{0}。這段時間做了什麼？", fmtMin(entry.minutes)) : _t('修改這筆工時') }) : null;
        return el('div', { class: 'kb-time-form' + (entry ? ' is-edit' : '') }, head, h, el('span', { text: _t('小時') }), m, el('span', { text: _t('分') }), day, note, skip, ok);
      }

      let editing = null;                 // comment id being edited inline
      function editBox(c) {
        const box = el('textarea', { class: 'textarea kb-reply-input', rows: '3' });
        box.value = c.body || '';
        if (meInfo.people) TT.mentionInput(box);
        const ok = el('button', { class: 'btn btn-sm btn-primary', type: 'button', text: _t('儲存') });
        const cancel = el('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: _t('取消') });
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
        const box = el('textarea', { class: 'textarea kb-reply-input', rows: '2', placeholder: _t("回覆 {0}…（Ctrl+Enter 送出，Esc 取消）", TT.nameOf(root.author)) });
        if (meInfo.people) TT.mentionInput(box);
        if (replyTo.mention) box.value = `@${replyTo.mention} `;
        const go = el('button', { class: 'btn btn-sm btn-primary', type: 'button', text: _t('回覆') });
        const cancel = el('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: _t('取消') });
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

      let addBelow = null;                // subtask id with the "new subtask below" input open
      /** The subtasks below subtask c (L3 and deeper), each a full subtask with its own comments, time and children. */
      function subTree(c, level) {
        const kids = allThreads.filter(x => x.task_parent_id === c.id).sort(byOrder);
        const canAdd =  (task.can_edit !== false || c.task.can_edit);
        if (!kids.length && !canAdd) return null;
        const box = el('div', { class: 'kb-subtree' });
        if (kids.length) box.append(el('div', { class: 'kb-subtree-head', text: _t("下層子任務（L{0}）· {1}", level + 1, kids.length) }), ...kids.map(k => commentNode(k, null, level + 1)));
        if (canAdd) {
          if (addBelow === c.id) {
            const input = el('input', { class: 'input input-sm', maxlength: '200', placeholder: _t("新增 L{0} 子任務名稱（Enter 新增，Esc 取消）", level + 1) });
            input.addEventListener('keydown', async e => {
              if (e.key === 'Escape') { e.stopPropagation(); addBelow = null; paint(); return; }
              if (e.key !== 'Enter' || e.isComposing || !input.value.trim()) return;
              e.preventDefault(); e.stopPropagation(); input.disabled = true;
              try { await api(`/api/tasks/${task.id}/subtasks`, { method: 'POST', body: { title: input.value.trim(), parent: c.id } }); await loadComments(); load(true); }
              catch (err) { toast(err.message, true); input.disabled = false; }
              setTimeout(() => box.querySelector('input')?.focus(), 0);
            });
            setTimeout(() => input.isConnected && input.focus(), 0);
            box.append(input);
          } else box.append(linkBtn(_t("新增 L{0} 子任務", level + 1), 'plus', () => { addBelow = c.id; paint(); }));
        }
        return box;
      }

      function commentNode(c, root, level = 2) {
        const isRoot = !root;
        const actions = el('span', { class: 'kb-comment-actions' },
          linkBtn(_t('回覆'), 'message', () => { replyTo = { root: (root || c).id, mention: isRoot ? null : c.author?.username }; paint(); }),
          c.task ? linkBtn(_t("任務樹{0}", (() => { const n = allThreads.filter(x => x.task_parent_id === c.id).length; return n ? `（${n}）` : ''; })()), 'layout',
            () => openNavigator(task, [c.id]), _t('在任務視窗展開：工時、留言與下層子任務')) : null,
          c.can_edit_body && !c.task ? linkBtn(_t('編輯'), 'edit', () => { editing = c.id; paint(); }) : null,
          isRoot && c.can_make_task && !c.task_parent_id ? (c.task
            ? linkBtn(_t('取消子任務'), 'x', () => { if (confirm(_t("把「{0}」改回一般留言？（工時記錄會保留）", c.task.title))) subPut(c, { is_task: false }); }, _t('改回一般留言'))
            : linkBtn(_t('設為子任務'), 'check', () => subPut(c, { is_task: true }), _t('把這則留言變成這張卡片的子任務（可設定狀態、負責人、日期與工時）'))) : null,
          delBtn(c, isRoot));
        const node = el('div', { class: 'kb-comment' + (isRoot ? '' : ' is-reply') + (c.task ? ' is-task' : ''), dataset: { cid: c.id } }, TT.avatar(c.author, isRoot ? 28 : 22),
          el('div', { class: 'kb-comment-main' },
            el('div', { class: 'kb-comment-head' }, el('strong', { text: TT.nameOf(c.author) }), el('small', { text: (c.created_at || '').slice(5, 16) }), actions),
            c.task ? subtaskBox(c, level) : null,
            editing === c.id ? editBox(c)
              : c.body && !(c.task && c.body.trim() === (c.task.title || '').trim()) ? renderBody(c.body) : null,
            c.edited_at && editing !== c.id ? el('small', { class: 'kb-edited', text: _t('（已編輯）') }) : null,
            c.images?.length ? thumbs(c.images, { size: 'sm' }) : null,
            isRoot && c.replies.length ? el('div', { class: 'kb-replies' }, c.replies.map(r => commentNode(r, c))) : null,
            isRoot && replyTo?.root === c.id ? replyBox(c) : null,
            isRoot && c.task ? subTree(c, level) : null));
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
            dataset: { id: c.id }, title: editable ? _t('點一下跳到子任務；拖曳或 Alt+↑/↓ 調整順序') : _t('點一下跳到子任務') },
            editable ? el('span', { class: 'kb-outline-grip', html: svg('grip') }) : null,
            el('span', { class: 'kb-outline-no', text: String(i + 1) }),
            el('span', { class: 'kb-sub-dot' }),
            el('span', { class: 'kb-outline-title', text: s.title }),
            meInfo.people && s.assignee ? TT.avatar(s.assignee, 18) : null,
            s.due_at ? el('span', { class: `kb-outline-due due-${tm.due || ''}`, text: fmt(s.due_at) }) : null);
          row.addEventListener('click', () => jump(c.id));
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
          nested(c.id, String(i + 1), 1);
        });
        function nested(pid, prefix, depth) {
          allThreads.filter(x => x.task_parent_id === pid).sort(byOrder).forEach((k, j) => {
            const ks = k.task;
            const no = `${prefix}.${j + 1}`;
            const r = el('li', { class: `kb-outline-row is-nested st-${ks.status}`, style: { '--st': (STATUS[ks.status] || STATUS.new).color, '--depth': depth },
              tabindex: '0', dataset: { id: k.id }, title: _t("L{0}：點一下跳到子任務", depth + 2) },
              el('span', { class: 'kb-outline-no', text: no }), el('span', { class: 'kb-sub-dot' }),
              el('span', { class: 'kb-outline-title', text: ks.title }),
              meInfo.people && ks.assignee ? TT.avatar(ks.assignee, 18) : null,
              ks.due_at ? el('span', { class: `kb-outline-due due-${timing({ status: ks.status, due_at: ks.due_at }).due || ''}`, text: fmt(ks.due_at) }) : null);
            r.addEventListener('click', () => jump(k.id));
            r.addEventListener('keydown', e => { if (e.key === 'Enter') jump(k.id); });
            list.append(r);
            nested(k.id, no, depth + 1);
          });
        }
        return list;
      }
      function jump(id) {
        if (!listBox.querySelector(`.kb-comment[data-cid="${id}"]`)) { onlyTasks = false; paintOrder(); paint(); }
        const t2 = listBox.querySelector(`.kb-comment[data-cid="${id}"]`);
        t2?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        t2?.classList.add('kb-flash'); setTimeout(() => t2?.classList.remove('kb-flash'), 1200);
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
            el('strong', { html: svg('check') + _t("子任務 {0} / {1} 完成", done, counted) }), el('span', { class: 'kb-rollup-pct', text: `${pct}%` })),
          el('span', { class: 'kb-bar big' }, el('span', { style: { width: `${pct}%` } })),
          el('div', { class: 'kb-rollup-meta' },
            el('span', { text: _t("工時 {0}{1}", fmtMin(spent), est ? _t(" / 預估 {0}", fmtMin(est)) : '') }),
            starts.length || dues.length ? el('span', { text: _t("期間 {0} → {1}", starts.length ? fmt(starts[0]) : '—', dues.length ? fmt(dues[dues.length - 1]) : '—') }) : null,
            late ? el('span', { class: 'kb-rollup-late', text: _t("{0} 項逾期", late) }) : null,
            subs.length > counted ? el('span', { text: _t("{0} 項取消", subs.length - counted) }) : null),
          outline(subs));
      }

      function paint() {
        paintRollup();
        let list = onlyTasks ? threads.filter(c => c.task).sort(byOrder) : threads.slice();
        if (newestFirst && !onlyTasks) list.reverse();
        listBox.replaceChildren(...(list.length ? list.map(c => commentNode(c, null))
          : [el('p', { class: 'hint', text: onlyTasks ? _t('還沒有子任務：在留言上按「設為子任務」') : _t('還沒有留言') })]));
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
          allThreads = await api(`/api/tasks/${task.id}/comments`);
          threads = allThreads.filter(c => !c.task_parent_id);          // subtasks of subtasks: shown under their parent
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
        el('div', { class: 'kb-comments-head' }, el('h4', { html: svg('message') + _t("留言與子任務{0}", task.comments ? `（${task.comments}）` : '') }),
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
        const reason = el('input', { class: 'input', maxlength: 300, placeholder: _t('卡在哪裡、在等誰？例如：等總務回覆配電容量'), value: b?.reason || '' });
        const ok = el('button', { class: 'btn btn-sm btn-danger', type: 'button', text: b ? _t('更新原因') : _t('標記卡住') });
        const no = el('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: _t('取消') });
        const go = async () => {
          if (!reason.value.trim()) { toast(_t('請寫一下卡在哪裡'), true); reason.focus(); return; }
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
        const edit = canFlag ? el('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: _t('修改原因') }) : null;
        const clear = canFlag ? el('button', { class: 'btn btn-sm', type: 'button', text: _t('✅ 解除卡住') }) : null;
        edit?.addEventListener('click', () => paintBlock(true));
        clear?.addEventListener('click', async () => { clear.disabled = true; try { await setBlocked(false, ''); } catch (e) { toast(e.message, true); clear.disabled = false; } });
        blockBox.replaceChildren(el('div', { class: 'kb-blocked-bar is-big' },
          el('span', { text: _t("⛔ 卡住 {0}：{1}", blockedDays(b.since), b.reason) + (b.by ? _t("（{0} 標記）", b.by) : '') }), el('span', { class: 'spacer' }), edit, clear));
      } else if (canFlag) {
        const flag = el('button', { class: 'btn btn-sm btn-ghost kb-block-btn', type: 'button', text: _t('⛔ 標記卡住…'), title: _t('工作卡住、在等別人時標記：卡片會標紅並通知負責人與上級') });
        flag.addEventListener('click', () => paintBlock(true));
        blockBox.replaceChildren(flag);
      } else blockBox.replaceChildren();
    }
    async function setBlocked(on, reason) {
      await api(`/api/tasks/${task.id}/blocked`, { method: 'POST', body: { blocked: on, reason } });
      const fresh = (await load(true)).find(x => x.id === task.id);
      task.blocked = fresh ? fresh.blocked : null;
      toast(on ? _t('已標記卡住，已通知負責人與上級') : _t('已解除卡住'));
      paintBlock();
      refreshComments();
    }
    paintBlock();

    const wrap = el('div', { class: 'modal' },
      el('div', { class: 'modal-card kb-editor', role: 'dialog', 'aria-modal': 'true', 'aria-label': task ? _t('編輯卡片') : _t('新增卡片') },
        el('div', { class: 'modal-head' }, el('h3', { html: svg('kanban') + (task ? _t('編輯卡片') : _t('新增卡片')) }), closeBtn),
        el('div', { class: 'modal-body' },
          field(_t('標題'), title),
          field(_t('說明'), desc),
          el('div', { class: 'field' }, el('span', { class: 'field-label', text: _t('標籤') }), tagBox, tagSug, tagData),
          el('div', { class: 'field' }, el('span', { class: 'field-label', text: _t('類型') }), kindSeg, kindHint),
          projField,
          el('div', { class: 'field' }, el('span', { class: 'field-label', html: svg('paperclip') + _t('附件') }), imgBox),
          meInfo.people ? el('div', { class: 'field' }, el('span', { class: 'field-label', html: svg('users') + _t('負責人') }), assignBox) : null,
          el('div', { class: 'kb-row' }, el('div', { class: 'field' }, el('span', { class: 'field-label', text: _t('狀態') }), status,
            summary ? el('span', { class: 'hint', text: SUMMARY_HINT }) : null), el('div', { class: 'field' }, el('span', { class: 'field-label', text: _t('優先順序') }), prio)),
          blockBox,
          el('div', { class: 'kb-row' },
            el('div', { class: 'field' }, el('span', { class: 'field-label', html: svg('play') + _t('開始日') }), el('div', { class: 'kb-dt' }, startD, startT), startChips),
            el('div', { class: 'field' }, el('span', { class: 'field-label', html: svg('clock') + _t('到期日') }), el('div', { class: 'kb-dt' }, dueD, dueT), dueChips)),
          el('div', { class: 'field' }, el('span', { class: 'field-label', html: svg('calendar') + _t('排程（甘特圖）') }), sched.el),
          el('div', { class: 'kb-row' },
            field(_t('提醒'), remind),
            el('div', { class: 'field' }, el('span', { class: 'field-label', html: svg('repeat') + _t('重複') }),
              el('div', { class: 'kb-repeat' }, repeatSel, everyBox))),
          weekBox,
          hint,
          repeatHint,
          meta,
          comments),
        el('div', { class: 'modal-foot' }, del, xlsBtn, navBtn, el('span', { class: 'spacer' }), cancel, ok)));

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
      if (!confirm(_t("刪除「{0}」？", task.title))) return;
      try { await remove(task.id); close(); toast(_t('已刪除')); } catch (err) { toast(err.message, true); }
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
      if (!title.value.trim()) { toast(_t('請輸入標題'), true); title.focus(); return; }
      if (task && status.value === 'complete' && t.status !== 'complete' && openSubs(t)
          && !confirm(_t("還有 {0} 個子任務沒完成，仍要把整張卡片改成 Complete？", openSubs(t)))) return;
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
      if (tagInput.value.trim()) { addTag(tagInput.value); tagInput.value = ''; }
      body.tags = tagList;
      if (!readOnly) {
        Object.assign(body, sched.value());
        // a new card always says what it is (the form may start as 專案 / inside a project: that is not a change to leave out)
        if (!task || kind !== (t.kind || 'ops')) body.kind = kind;
        const pid = kind === 'project' ? null : (Number(projSel.value) || null);
        if (!task ? pid : pid !== (t.project_id || null)) body.project_id = pid || 0;
      }
      if (body.milestone ?? t.milestone) { body.start_at = null; if (!body.due_at) { toast(_t('里程碑需要到期日'), true); dueD.focus(); return; } }
      if (canAssign) body.assignees = assignees.map(p => p.username);
      if (body.start_at && body.due_at && body.start_at.slice(0, 10) > body.due_at.slice(0, 10)) { toast(_t('開始日不能晚於到期日'), true); return; }
      if (body.repeat && !body.due_at) { toast(_t('重複的卡片需要設定到期日'), true); dueD.focus(); return; }
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
          toast(_t("已新增「{0}」", body.title) + (queued.length ? _t("（{0} 個附件）", queued.length - failed) : ''));
        }
        if (body.due_at && body.remind !== null) askPermission(true);
      } catch (err) { toast(err.message, true); ok.disabled = false; }
    }
    ok.addEventListener('click', submit);

    if (readOnly) {                                               // view + comment only
      wrap.querySelectorAll('.modal-body input, .modal-body select, .modal-body textarea:not(.kb-comment-input), .modal-body .segmented button, .kb-date-chip, .kb-wd, .kb-person-x, .kb-tag-x, .kb-tag-sug')
        .forEach(x => { x.disabled = true; });
      ok.hidden = true;
      cancel.textContent = _t('關閉');
      wrap.querySelector('.modal-head h3').innerHTML = svg('kanban') + (task.history ? _t('歷史案件') : _t('檢視卡片'));
      if (task.history) {                                       // 歷史區: view only, for everyone
        const day = (task.closed_at || '').slice(0, 10);
        const note = el('div', { class: 'kb-readonly is-history', html: svg('archive') });
        note.append(el('span', { text: _t("歷史案件：{0} 結案，超過 {1}，只能檢視，不能修改或留言。", day, historyText()) }));
        wrap.querySelector('.modal-body').prepend(note);
        if (comments) {
          comments.querySelectorAll('button').forEach(x => { x.disabled = false; });   // open / fold threads, files
          const inp = comments.querySelector('.kb-comment-input');                       // no new comments
          let box = inp && inp.parentElement;
          while (box && box !== comments && !box.querySelector('.kb-comment-attach')) box = box.parentElement;
          if (box && box !== comments) box.style.display = 'none'; else if (inp) inp.style.display = 'none';
          comments.querySelectorAll('.kb-comment-attach, .kb-comment-pending').forEach(x => { x.style.display = 'none'; });
        }
      } else {
        wrap.querySelector('.modal-body').prepend(el('div', { class: 'kb-readonly', html: svg('lock') + _t('<span>唯讀：這張卡片你可以檢視與留言，不能修改。</span>') }));
        if (comments) comments.querySelectorAll('input, textarea, button').forEach(x => { x.disabled = false; });
      }
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
      if (p === 'granted') toast(_t('已開啟桌面通知：到期與提醒時間到會通知你'));
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
      btn.title = [list.length && _t("{0} 個待辦需要注意", list.length), unread.length && _t("{0} 則新通知", unread.length)].filter(Boolean).join('、') || _t('待辦提醒');
      btn.classList.toggle('has-alerts', list.length + unread.length > 0);
      if (!pop) return;
      const noteRows = notes.slice(0, 12).map(n => {
        const row = el('button', { class: 'bell-item bell-note' + (n.read ? ' is-read' : ''), type: 'button' },
          el('span', { class: 'bell-kind kind-note', html: svg(n.kind === 'comment' ? 'message' : n.kind === 'assigned' ? 'user' : n.kind === 'subtask' ? 'check' : ['project', 'card'].includes(n.kind) ? 'flag' : 'users') }),
          el('span', { class: 'bell-text' }, el('strong', { text: n.text }), el('small', { text: (n.created_at || '').slice(5, 16) })));
        row.addEventListener('click', async () => {
          close();
          if (!n.read) { n.read = 1; api('/api/notifications/read', { method: 'POST', body: { ids: [n.id] } }).catch(() => {}); refreshAlerts(); }
          if (n.kind === 'project') { if (n.task_id) location.hash = `#/project/${n.task_id}`; else { TT.store.set('projects-tab', 'load'); location.hash = '#/projects'; } return; }
          openTask(n.task_id);
        });
        return row;
      });
      const readAll = unread.length ? el('button', { class: 'section-link', type: 'button', text: _t('全部已讀') }) : null;
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
      }) : [el('div', { class: 'bell-empty', text: _t('目前沒有需要注意的待辦 🎉') })];
      const enable = perm === 'default' ? el('button', { class: 'btn btn-sm', type: 'button', html: svg('bell') + _t('開啟桌面通知') }) : null;
      enable?.addEventListener('click', () => askPermission());
      const permHint = perm === 'denied' ? el('p', { class: 'hint', text: _t('瀏覽器已封鎖通知：點網址列左側的圖示可以重新允許。') })
        : perm === 'n/a' && 'Notification' in window ? null
        : !('Notification' in window) || !window.isSecureContext ? el('p', { class: 'hint', text: _t('這個連線無法使用桌面通知（需要 HTTPS 或本機），提醒會顯示在頁面上。') }) : null;
      const go = el('a', { class: 'btn btn-sm btn-ghost', href: '/#/board', html: svg('kanban') + _t('開啟看板') });
      go.addEventListener('click', close);
      pop.replaceChildren(...[      // DOM replaceChildren() would print a null as the text "null"
        noteRows.length ? el('div', { class: 'bell-head' }, el('strong', { text: _t('通知') }), readAll || el('span', { class: 'badge', text: '0' })) : null,
        noteRows.length ? el('div', { class: 'bell-list bell-notes' }, noteRows) : null,
        el('div', { class: 'bell-head' }, el('strong', { text: _t('待辦提醒') }), el('span', { class: 'badge', text: list.length })),
        el('div', { class: 'bell-list' }, items),
        permHint,
        el('div', { class: 'bell-foot' }, enable, el('span', { class: 'spacer' }), go)].filter(Boolean));
    };
    btn.addEventListener('click', () => {
      if (pop) return close();
      pop = el('div', { class: 'bell-pop glass', role: 'dialog', 'aria-label': _t('待辦提醒') });
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
    return [_t("{0} 張進行中的卡片", open), overdue && _t("{0} 張逾期", overdue)].filter(Boolean).join(' · ');
  }

  /** Cards matching q (title, description, comments, people) that this user may see. */
  function searchCards(q, limit = 30) {
    return api(`/api/tasks/search?q=${encodeURIComponent(q)}&limit=${limit}`);
  }
  /** One search result row: status dot, title, where it matched, due date. */
  function cardHit(r, { compact = false } = {}) {
    const st = STATUS[r.status] || STATUSES[2];
    const sub = [stName(st), r.due_at ? _t("到期 {0}", fmt(r.due_at, true)) : null,
      r.match !== '標題' ? `${r.match}：${r.snippet}` : null].filter(Boolean).join('  ·  ');
    return el('div', { class: 'kb-hit' + (compact ? ' compact' : '') },
      el('span', { class: 'kb-hit-tile', style: { '--st': st.color }, html: svg('kanban') }),
      el('div', { class: 'palette-item-text' },
        el('div', { class: 'palette-item-title', text: r.title }),
        el('div', { class: 'palette-item-sub', text: sub })));
  }

  /** Someone changed something (live update): reload quietly unless the person is mid-drag. */
  function refresh() {
    if (!started) return;
    if (document.querySelector('.kb-card.dragging, .kb-dragging')) { setTimeout(refresh, 1500); return; }
    load(true).catch(() => {});
    loadNotes();
  }


  // ------------------------------------------------------------ task window (navigator)
  // A floating window: the card on the left, its subtasks as title-only cards to the right; clicking one
  // opens its details (status, time log, comments, its own subtasks) in the next column. One open path:
  // clicking another card of the same level folds the previous one back. Card + 4 levels at most.
    function openNavigator(card, startPath = []) {
    document.querySelector('.kb-nav-modal')?.remove();
    let threads = [];
    let path = [...startPath];                       // selected subtask id per level (level 2, 3, 4)
    let fetchedAt = Date.now();
    let timeOpen = null, editEntry = null, replyOpen = null, editCmt = null, editDesc = null;
    const cols = el('div', { class: 'kb-nav-cols' });
    const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey, true); clearInterval(tick);
      if (!document.querySelector('.modal:not([hidden])')) document.body.classList.remove('modal-open'); };
    const onKey = e => { if (e.key === 'Escape' && !e.defaultPrevented) { e.stopPropagation(); close(); } };
    const closeBtn = el('button', { class: 'icon-btn', type: 'button', 'aria-label': _t('關閉'), html: svg('x') });
    closeBtn.addEventListener('click', close);
    const full = el('button', { class: 'btn btn-sm', type: 'button', html: svg('edit') + _t('完整編輯') });
    full.addEventListener('click', () => { close(); openEditor(find(card.id) || card); });
    const wrap = el('div', { class: 'modal kb-nav-modal' },
      el('div', { class: 'modal-card kb-nav', role: 'dialog', 'aria-modal': 'true', 'aria-label': _t('任務視窗') },
        el('div', { class: 'modal-head' }, el('h3', { html: svg('layout') + _t('任務視窗') }), el('span', { class: 'kb-nav-crumbs' }), el('span', { class: 'spacer' }), full, closeBtn),
        cols));
    wrap.addEventListener('mousedown', e => { if (e.target === wrap) close(); });
    document.addEventListener('keydown', onKey, true);
    document.body.append(wrap);
    document.body.classList.add('modal-open');
    const tick = setInterval(() => wrap.querySelectorAll('[data-elapsed]').forEach(x => {
      const sec = Number(x.dataset.elapsed) + Math.floor((Date.now() - fetchedAt) / 1000);
      x.textContent = `${Math.floor(sec / 3600)}:${String(Math.floor(sec / 60) % 60).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
    }), 1000);

    const subs = () => threads.filter(c => c.task);
    const byId = id => threads.find(c => c.id === id);
    const kids = pid => subs().filter(c => (c.task_parent_id || null) === pid)
      .sort((a, b) => (a.task.sort_order ?? a.id) - (b.task.sort_order ?? b.id) || a.id - b.id);
    const treeMinutes = id => { const c = byId(id); return (c ? c.task.spent_minutes || 0 : 0) + kids(id).reduce((n, k) => n + treeMinutes(k.id), 0); };
    const cardNow = () => find(card.id) || card;
    async function reload(board = true) {
      try { threads = await api(`/api/tasks/${card.id}/comments`); fetchedAt = Date.now(); }
      catch (e) { toast(e.message, true); return; }
      path = path.filter((id, i) => { const c = byId(id); return c && (c.task_parent_id || null) === (i ? path[i - 1] : null); });
      paint();
      if (board) load(true).catch(() => {});
    }
    const call = async (url, opts) => { try { const r = await api(url, opts); await reload(); return r; } catch (e) { toast(e.message, true); return null; } };
    const base = `/api/tasks/${card.id}/comments`;

    function stChip(status) { const st = STATUS[status] || STATUS.new; return el('span', { class: 'kb-nav-st', style: { '--c': st.color }, text: st.label }); }

    function childList(pid, level, colIndex) {
      const list = kids(pid);
      const box = el('div', { class: 'kb-nav-list' });
      list.forEach((c, i) => {
        const st = STATUS[c.task.status] || STATUS.new;
        const tm = timing({ status: c.task.status, due_at: c.task.due_at });
        const n = kids(c.id).length;
        const on = path[colIndex] === c.id;
        const b = el('button', { class: 'kb-nav-item' + (on ? ' on' : '') + (CLOSED.has(c.task.status) ? ' is-closed' : ''), type: 'button', style: { '--c': st.color },
          title: `${c.task.title}（${st.zh}）` },
          el('span', { class: 'kb-nav-item-title', text: c.task.title }),
          el('span', { class: 'kb-nav-item-meta' },
            c.task.assignee ? TT.avatar(c.task.assignee, 18) : null,
            c.task.due_at ? el('span', { class: `kb-nav-due due-${tm.due || ''}`, text: tm.dueText || fmt(c.task.due_at) }) : null,
            n ? el('span', { class: 'kb-nav-n', text: `${kids(c.id).filter(k => k.task.status === 'complete').length}/${n}` }) : null),
          el('span', { class: 'kb-nav-go', text: on ? '◂' : '▸' }));
        b.addEventListener('click', () => {
          // focus: open this one, fold whatever was open at this level and below
          path = on ? path.slice(0, colIndex) : [...path.slice(0, colIndex), c.id];
          timeOpen = editEntry = replyOpen = null;
          paint(true);
        });
        box.append(b);
      });
      const canAdd = (pid == null ? cardNow().can_edit !== false
        : (cardNow().can_edit !== false || !!byId(pid)?.task.can_edit));
      if (canAdd) {
        const input = el('input', { class: 'input input-sm', maxlength: '200', placeholder: pid == null ? _t('＋ 新增 L2 子任務（Enter）') : _t("＋ 新增 L{0} 子任務（Enter）", level + 1) });
        input.addEventListener('keydown', async e => {
          if (e.key !== 'Enter' || e.isComposing || !input.value.trim()) return;
          e.preventDefault(); input.disabled = true;
          const r = await call(`/api/tasks/${card.id}/subtasks`, { method: 'POST', body: { title: input.value.trim(), parent: pid } });
          if (!r) input.disabled = false;
        });
        box.append(input);
      } else if (!list.length) box.append(el('p', { class: 'hint', text: _t('沒有子任務') }));
      return box;
    }

    function cardColumn() {
      const t = cardNow();
      const sub = t.subtasks;
      const pr = sub && sub.total ? Math.round(sub.done / Math.max(1, sub.total - (sub.canceled || 0)) * 100) : null;
      return el('section', { class: 'kb-nav-col is-card' },
        el('div', { class: 'kb-nav-kicker', text: _t('L1 // 主卡') }),
        el('div', { class: 'kb-nav-head' }, stChip(t.status), el('h4', { class: 'kb-nav-title', text: t.title })),
        t.tags?.length ? el('div', { class: 'kb-tags' }, t.tags.map(x => tagChip(x))) : null,
        el('div', { class: 'kb-nav-meta' },
          t.start_at ? el('span', { text: _t("開始 {0}", fmt(t.start_at)) }) : null,
          t.due_at ? el('span', { text: _t("到期 {0}", fmt(t.due_at)) }) : null,
          el('span', { text: _t("工時 {0}", fmtMin(subs().reduce((n, c) => n + (c.task.spent_minutes || 0), 0))) })),
        pr != null ? el('div', { class: 'kb-progress' }, el('span', { class: 'kb-progress-bar' }, el('span', { style: { width: pr + '%' } })), el('span', { class: 'kb-progress-text', text: `${pr}%` })) : null,
        t.description ? el('p', { class: 'kb-nav-desc', text: t.description }) : null,
        el('div', { class: 'kb-nav-sec', text: _t('子任務（L2）') }),
        childList(null, 1, 0),
        el('div', { class: 'kb-nav-sec', text: _t("卡片留言（{0}）", threads.filter(c => !c.task).length) }),
        cardComments());
    }

    /** One comment (or reply): author, time, text, edit / delete for whoever may. */
    function cmt(r, onReply) {
      const editing = editCmt === r.id;
      const ed = r.can_edit_body && !r.task ? el('button', { class: 'kb-comment-del', type: 'button', title: _t('修改留言'), html: svg('edit') }) : null;
      const del = r.can_delete && !r.task ? el('button', { class: 'kb-comment-del', type: 'button', title: _t('刪除留言'), html: svg('trash') }) : null;
      const rp = onReply ? el('button', { class: 'kb-comment-del', type: 'button', title: _t('回覆'), html: svg('message') }) : null;
      ed?.addEventListener('click', () => { editCmt = editing ? null : r.id; paint(); });
      del?.addEventListener('click', () => confirm(r.replies?.length ? _t("刪除這則留言與 {0} 則回覆？", r.replies.length) : _t('刪除這則留言？')) && call(`${base}/${r.id}`, { method: 'DELETE' }));
      rp?.addEventListener('click', onReply);
      let body;
      if (editing) {
        const ta = el('textarea', { class: 'textarea kb-nav-reply', rows: '3' });
        ta.value = r.body || '';
        if (meInfo.people) TT.mentionInput(ta);
        const ok = el('button', { class: 'btn btn-sm btn-primary', type: 'button', text: _t('儲存') });
        const no = el('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: _t('取消') });
        no.addEventListener('click', () => { editCmt = null; paint(); });
        ok.addEventListener('click', async () => { ok.disabled = true; editCmt = null; await call(`${base}/${r.id}`, { method: 'PUT', body: { body: ta.value } }); });
        ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); ok.click(); } if (e.key === 'Escape') { e.stopPropagation(); no.click(); } });
        setTimeout(() => ta.isConnected && ta.focus(), 30);
        body = el('div', { class: 'kb-nav-edit' }, ta, el('div', { class: 'kb-nav-edit-btns' }, no, ok));
      } else body = el('div', { class: 'kb-nav-cmt-body', text: r.body });
      return el('div', { class: 'kb-nav-cmt' },
        el('div', { class: 'kb-nav-cmt-head' }, TT.avatar(r.author, 18), el('strong', { text: TT.nameOf(r.author) }),
          el('small', { text: (r.created_at || '').slice(5, 16) + (r.edited_at ? _t('（已編輯）') : '') }), el('span', { class: 'spacer' }), rp, ed, del),
        body, r.images?.length ? thumbs(r.images, { size: 'sm' }) : null);
    }

    function newBox(parent, placeholder) {
      const input = el('textarea', { class: 'textarea kb-nav-reply', rows: '2', placeholder: placeholder + (meInfo.people ? _t('（@ 提到同事，Ctrl+Enter 送出）') : _t('（Ctrl+Enter 送出）')) });
      if (meInfo.people) TT.mentionInput(input);
      const send = el('button', { class: 'btn btn-sm', type: 'button', text: _t('送出') });
      send.addEventListener('click', async () => {
        if (!input.value.trim()) return;
        send.disabled = true;
        if (replyOpen === parent) replyOpen = null;
        const r = await call(base, { method: 'POST', body: parent ? { body: input.value, parent_id: parent } : { body: input.value } });
        if (!r) send.disabled = false;
      });
      input.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send.click(); } });
      return el('div', { class: 'kb-nav-reply-row' }, input, send);
    }

    /** Comments on the card itself (threads that are not subtasks), with replies. */
    function cardComments() {
      const box = el('div', { class: 'kb-nav-comments' });
      const list = threads.filter(c => !c.task);
      list.forEach(c => {
        box.append(cmt(c, () => { replyOpen = replyOpen === c.id ? null : c.id; paint(); }));
        if (c.replies?.length || replyOpen === c.id) {
          box.append(el('div', { class: 'kb-nav-replies' }, (c.replies || []).map(r => cmt(r)),
            replyOpen === c.id ? newBox(c.id, _t("回覆 {0}…", TT.nameOf(c.author))) : null));
        }
      });
      if (!list.length) box.append(el('p', { class: 'hint', text: _t('還沒有留言') }));
      box.append(newBox(null, _t('在卡片留言…')));
      return box;
    }

    function timeBlock(c) {
      const s = c.task;
      const running = s.my_timer;
      const below = treeMinutes(c.id) - (s.spent_minutes || 0);
      const box = el('div', { class: 'kb-nav-time' });
      const head = el('div', { class: 'kb-nav-time-head' },
        el('span', { html: svg('clock') + `<b>${fmtMin(s.spent_minutes)}</b>` + (below ? _t("<span class=\"hint\">　含下層 {0}</span>", fmtMin(treeMinutes(c.id))) : '') }),
        el('span', { class: 'spacer' }),
        running ? el('span', { class: 'kb-timer-clock', dataset: { elapsed: running.elapsed } }) : null);
      if (s.can_update && (running || !CLOSED.has(s.status))) {
        const tb = el('button', { class: 'btn btn-sm' + (running ? ' btn-danger' : ''), type: 'button', html: running ? _t('■ 停止') : _t('▶ 計時') });
        tb.addEventListener('click', async () => {
          tb.disabled = true;
          const r = await call(`${base}/${c.id}/timer`, { method: 'POST', body: { action: running ? 'stop' : 'start', work_date: isoDay(now()) } });
          if (running && r && r.entry) { editEntry = { cid: c.id, entry: r.entry, prompt: true }; paint(); }
        });
        const add = el('button', { class: 'btn btn-sm btn-ghost', type: 'button', html: svg('plus') + _t('記錄') });
        add.addEventListener('click', () => { timeOpen = timeOpen === c.id ? null : c.id; editEntry = null; paint(); });
        head.append(tb, add);
      }
      box.append(head);
      if (timeOpen === c.id) box.append(timeForm(c, null, false));
      if (editEntry && editEntry.cid === c.id) box.append(timeForm(c, editEntry.entry, editEntry.prompt));
      const log = el('div', { class: 'kb-nav-log' });
      (s.entries || []).forEach(e => {
        const ed = e.can_delete && !e.running ? el('button', { class: 'kb-comment-del', type: 'button', title: _t('修改'), html: svg('edit') }) : null;
        const del = e.can_delete && !e.running ? el('button', { class: 'kb-comment-del', type: 'button', title: _t('刪除'), html: svg('trash') }) : null;
        ed?.addEventListener('click', () => { editEntry = { cid: c.id, entry: e }; timeOpen = null; paint(); });
        del?.addEventListener('click', () => confirm(_t('刪除這筆工時？')) && call(`${base}/${c.id}/time/${e.id}`, { method: 'DELETE' }));
        log.append(el('div', { class: 'kb-time-row' },
          el('span', { class: 'kb-time-date', text: e.work_date ? e.work_date.slice(5).replace('-', '/') : '' }),
          el('b', { text: e.running ? _t('計時中…') : fmtMin(e.minutes) }),
          el('span', { class: 'kb-time-note' + (e.note ? '' : ' is-empty'), text: e.note || (e.running ? '' : _t('（沒有說明）')) }),
          meInfo.people && e.user ? el('span', { class: 'kb-time-user', text: TT.nameOf(e.user) }) : null, ed, del));
      });
      if (!(s.entries || []).length) log.append(el('p', { class: 'hint', text: _t('還沒有工時紀錄') }));
      box.append(log);
      return box;
    }

    function timeForm(c, entry, prompt) {
      const mins = entry ? entry.minutes || 0 : 60;
      const h = el('input', { class: 'input input-sm', type: 'number', min: '0', max: '24', value: String(Math.floor(mins / 60)), 'aria-label': _t('小時') });
      const m = el('input', { class: 'input input-sm', type: 'number', min: '0', max: '59', step: '5', value: String(mins % 60), 'aria-label': _t('分鐘') });
      const day = el('input', { class: 'input input-sm', type: 'date', value: entry?.work_date || isoDay(now()) });
      const note = el('input', { class: 'input input-sm kb-time-note-in', maxlength: '200', value: entry?.note || '', placeholder: _t('這段時間做了什麼？') });
      const ok = el('button', { class: 'btn btn-sm btn-primary', type: 'button', text: entry ? _t('儲存') : _t('記錄') });
      const skip = el('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: prompt ? _t('略過') : _t('取消') });
      skip.addEventListener('click', () => { timeOpen = editEntry = null; paint(); });
      ok.addEventListener('click', async () => {
        const minutes = (parseInt(h.value, 10) || 0) * 60 + (parseInt(m.value, 10) || 0);
        if (minutes < 1) { toast(_t('請輸入工時'), true); return; }
        ok.disabled = true;
        timeOpen = editEntry = null;
        await call(entry ? `${base}/${c.id}/time/${entry.id}` : `${base}/${c.id}/time`,
          { method: entry ? 'PUT' : 'POST', body: { minutes, note: note.value, work_date: day.value || null } });
      });
      note.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); ok.click(); } });
      setTimeout(() => note.isConnected && (entry || timeOpen) && note.focus(), 40);
      return el('div', { class: 'kb-time-form is-edit' },
        entry ? el('div', { class: 'kb-time-form-head', text: prompt ? _t("計時已停止：{0}。這段時間做了什麼？", fmtMin(entry.minutes)) : _t('修改這筆工時') }) : null,
        h, el('span', { text: _t('時') }), m, el('span', { text: _t('分') }), day, note, skip, ok);
    }

    function comments(c) {
      const box = el('div', { class: 'kb-nav-comments' });
      (c.replies || []).forEach(r => box.append(cmt(r)));
      if (!(c.replies || []).length) box.append(el('p', { class: 'hint', text: _t('還沒有留言') }));
      box.append(newBox(c.id, _t('留言…')));
      return box;
    }

    /** Editable fields of a subtask at any level (assignee, priority, dates, estimate). */
    function fieldsBlock(c) {
      const s = c.task;
      const put = body => call(`${base}/${c.id}/task`, { method: 'PUT', body });
      const box = el('div', { class: 'kb-nav-fields' });
      const row = (label, ctl) => el('label', { class: 'kb-nav-field' }, el('span', { text: label }), ctl);
      if (meInfo.people) {
        const who = el('div', { class: 'kb-nav-who' });
        const paintWho = () => {
          const chip = s.assignee ? el('span', { class: 'kb-tree-who' }, TT.avatar(s.assignee, 18), el('span', { text: TT.nameOf(s.assignee) })) : el('span', { class: 'hint', text: _t('未指派') });
          const pick = s.can_assign ? el('button', { class: 'kb-link-btn', type: 'button', html: svg('user') + `<span>${s.assignee ? _t('改派') : _t('指派')}</span>` }) : null;
          const clear = s.can_assign && s.assignee ? el('button', { class: 'kb-comment-del', type: 'button', title: _t('取消指派'), html: svg('x') }) : null;
          clear?.addEventListener('click', () => put({ assignee: '' }));
          pick?.addEventListener('click', () => {
            const inp = TT.mentionInput(el('input', { class: 'input input-sm', placeholder: _t('輸入姓名或帳號…') }), { onPick: p => put({ assignee: p.username }) });
            inp.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); paintWho(); } });
            inp.addEventListener('blur', () => setTimeout(() => inp.isConnected && paintWho(), 200));
            who.replaceChildren(inp); inp.focus();
          });
          who.replaceChildren(...[chip, clear, pick].filter(Boolean));
        };
        paintWho();
        box.append(el('div', { class: 'kb-nav-field is-wide' }, el('span', { text: _t('負責') }), who));
      }
      const prio = el('select', { class: 'select input-sm', disabled: !s.can_edit }, PRIORITIES.map(([v, l]) => el('option', { value: v, text: l, selected: v === (s.priority || 'normal') })));
      prio.addEventListener('change', () => put({ priority: prio.value }));
      box.append(row(_t('優先'), prio));
      const spans = kids(c.id).length > 0;              // its dates are its subtasks' span
      const date = key => {
        const inp = el('input', { class: 'input input-sm', type: 'date', value: (s[key] || '').slice(0, 10), disabled: !s.can_edit || spans,
          title: spans ? _t('由下層子任務推算：改下層的日期') : '' });
        inp.addEventListener('change', () => put({ [key]: inp.value ? inp.value + (s[key]?.includes('T') ? s[key].slice(10) : '') : null }));
        return inp;
      };
      box.append(row(_t('開始'), date('start_at')), row(_t('到期'), date('due_at')));
      if (spans) box.append(el('span', { class: 'hint kb-nav-field is-wide', text: _t('開始／到期由下層子任務推算') }));
      const est = el('input', { class: 'input input-sm', type: 'number', min: '0', max: '1000', step: '0.5', placeholder: '—', disabled: !s.can_edit,
        value: s.estimate_minutes ? String(+(s.estimate_minutes / 60).toFixed(2)) : '' });
      est.addEventListener('change', () => { const h = parseFloat(est.value); put({ estimate_minutes: Number.isFinite(h) && h > 0 ? Math.round(h * 60) : null }); });
      box.append(row(_t('預估（時）'), est));
      const sched = scheduleBlock({ key: `s:${c.id}`, item: { ...s, deps: s.deps || [] }, editable: !!s.can_edit,
        onChange: body => { if (body.milestone && !s.due_at) { toast(_t('里程碑需要到期日'), true); return; } put(body); } });
      box.append(el('div', { class: 'kb-nav-field is-wide' }, el('span', { text: _t('排程') }), sched.el));
      return box;
    }

    function descBlock(c) {
      const s = c.task;
      const text = c.body && c.body.trim() !== (s.title || '').trim() ? c.body : '';
      if (editDesc === c.id) {
        const ta = el('textarea', { class: 'textarea kb-nav-reply', rows: '4', placeholder: _t('細節、步驟、注意事項…') });
        ta.value = text;
        if (meInfo.people) TT.mentionInput(ta);
        const ok = el('button', { class: 'btn btn-sm btn-primary', type: 'button', text: _t('儲存') });
        const no = el('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: _t('取消') });
        no.addEventListener('click', () => { editDesc = null; paint(); });
        ok.addEventListener('click', async () => { ok.disabled = true; editDesc = null; await call(`${base}/${c.id}`, { method: 'PUT', body: { body: ta.value } }); });
        ta.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); ok.click(); } if (e.key === 'Escape') { e.stopPropagation(); no.click(); } });
        setTimeout(() => ta.isConnected && ta.focus(), 30);
        return el('div', { class: 'kb-nav-edit' }, ta, el('div', { class: 'kb-nav-edit-btns' }, no, ok));
      }
      const ed = c.can_edit_body ? el('button', { class: 'kb-link-btn', type: 'button', html: svg('edit') + `<span>${text ? _t('修改說明') : _t('加說明')}</span>` }) : null;
      ed?.addEventListener('click', () => { editDesc = c.id; paint(); });
      return el('div', { class: 'kb-nav-descbox' },
        text ? el('p', { class: 'kb-nav-desc', text }) : (ed ? null : el('p', { class: 'hint', text: _t('沒有說明') })),
        c.images?.length ? thumbs(c.images, { size: 'sm' }) : null, ed);
    }

    function detailColumn(c, level, colIndex) {
      const s = c.task;
      const stSel = el('select', { class: 'select kb-nav-status', disabled: !s.can_update, title: _t('狀態') },
        ...STATUSES.filter(x => !['recurring', 'overdue'].includes(x.key)).map(x => el('option', { value: x.key, text: stName(x), selected: x.key === s.status })));
      stSel.addEventListener('change', () => {
        if (stSel.value === 'complete' && kids(c.id).some(k => !CLOSED.has(k.task.status)) && !confirm(_t('底下還有子任務沒完成，仍要改成 Complete？'))) { stSel.value = s.status; return; }
        call(`${base}/${c.id}/task`, { method: 'PUT', body: { status: stSel.value } });
      });
      const tm = timing({ status: s.status, due_at: s.due_at });
      const del = c.can_delete ? el('button', { class: 'kb-comment-del', type: 'button', title: _t('刪除這個子任務（含下層子任務、工時與留言）'), html: svg('trash') }) : null;
      del?.addEventListener('click', () => {
        const n = kids(c.id).length;
        if (confirm(_t("刪除「{0}」？", s.title) + (n ? _t("\n底下 {0} 個子任務也會一起刪除。", n) : ''))) { path = path.slice(0, colIndex - 1); call(`${base}/${c.id}`, { method: 'DELETE' }); }
      });
      let title;
      if (s.can_edit) {
        title = el('input', { class: 'input kb-nav-title-in', value: s.title || '', maxlength: '200', title: _t('子任務名稱（Enter 儲存）') });
        title.addEventListener('change', () => {
          const v = title.value.trim();
          if (v && v !== s.title) call(`${base}/${c.id}/task`, { method: 'PUT', body: { title: v } }); else title.value = s.title;
        });
        title.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); title.blur(); } });
      } else title = el('h4', { class: 'kb-nav-title', text: s.title });
      const more = el('button', { class: 'kb-link-btn', type: 'button', title: _t('附件、時間、提醒等完整設定'), html: svg(s.can_edit ? 'edit' : 'external') + `<span>${s.can_edit ? _t('更多設定') : _t('檢視')}</span>` });
      more.addEventListener('click', () => openSubtaskEditor(cardNow(), c, () => reload()));
      return el('section', { class: 'kb-nav-col', style: { '--c': (STATUS[s.status] || STATUS.new).color } },
        el('div', { class: 'kb-nav-kicker' }, el('span', { text: _t("L{0} // 子任務", level) }), el('span', { class: 'spacer' }), more, del),
        title,
        el('div', { class: 'kb-nav-strow' }, stSel,
          tm.due && tm.due !== 'later' ? el('span', { class: `kb-nav-due due-${tm.due}`, text: tm.dueText }) : null),
        fieldsBlock(c),
        el('div', { class: 'kb-nav-sec', text: _t('說明') }), descBlock(c),
        el('div', { class: 'kb-nav-sec', text: _t('工時紀錄') }), timeBlock(c),
        el('div', { class: 'kb-nav-sec', text: _t("留言（{0}）", (c.replies || []).length) }), comments(c),
        el('div', { class: 'kb-nav-sec', text: _t("下層子任務（L{0}）", level + 1) }),
        childList(c.id, level, colIndex));
    }

    function paint(scroll = false) {
      const keep = cols.scrollLeft;
      const list = [cardColumn()];
      path.forEach((id, i) => { const c = byId(id); if (c) list.push(detailColumn(c, i + 2, i + 1)); });
      cols.replaceChildren(...list);
      const crumbs = wrap.querySelector('.kb-nav-crumbs');
      crumbs.replaceChildren(...[cardNow().title, ...path.map(id => byId(id)?.task.title)].filter(Boolean)
        .flatMap((x, i) => [i ? el('span', { class: 'sep', text: '›' }) : null, el('span', { text: x })]).filter(Boolean));
      cols.scrollLeft = keep;
      if (scroll) requestAnimationFrame(() => cols.scrollTo({ left: cols.scrollWidth, behavior: 'smooth' }));
    }
    paint();
    reload(false).then(() => { if (path.length) paint(true); });
  }

  return { init, load, refresh, openNavigator, exportByPeople, exportReport, ganttRows, baselineText, save, projectAnalysis, isProject, PROBLEM_ZH, get meInfo() { return meInfo; }, mount, mountBell, openEditor, openTask, exportXlsx, importXlsx, setSelecting, get selecting() { return selecting; }, searchCards, cardHit, alerts, summary, timing, nextDue, repeatText, STATUSES, get tasks() { return tasks; }, find, all, remember, historyHours, historyText };
})();
