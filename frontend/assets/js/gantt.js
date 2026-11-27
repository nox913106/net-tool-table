/* =============================================================================
   IPMS — Gantt view of the board
   Cards (L1) and their subtasks (L2 and deeper) on a day scale: bars by status, milestones as diamonds,
   predecessor arrows (red when the schedule breaks them), the baseline as a thin line under a bar,
   the actual start as a small mark, today as a red line.
   Drag a bar to move it, drag its edges to change start / due (saved at once, the board follows).
   Linked: shows exactly the board's cards (filter, focus, tag, hidden closed) and points at the card
   on the board; independent: its own filter and search.
   ============================================================================= */
(() => {
  const { el, api, toast, svg } = TT;
  const ZOOM = { day: 26, week: 11, month: 4 };
  const CLOSED = new Set(['complete', 'canceled']);
  const DONE = { complete: 100, ongoing: 50, pending: 30, onhold: 20, overdue: 40 };
  const RH = 30;
  const dayNum = v => { if (!v) return null; const [y, m, d] = v.slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d) / 864e5; };
  const isoOf = n => new Date(n * 864e5).toISOString().slice(0, 10);
  const md = v => v ? `${+v.slice(5, 7)}/${+v.slice(8, 10)}` : '—';
  const todayNum = () => { const d = new Date(); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5; };
  const withDay = (orig, n) => isoOf(n) + (orig && orig.includes('T') ? orig.slice(10) : '');
  const statusOf = k => (TTBoard.STATUSES || []).find(s => s.key === k) || { color: '#64748b', zh: k };

  function mount(host, opts = {}) {
    const board = opts.board || null;
    let linked = !!board && TT.store.get('gantt-linked', true);
    const fixed = !!opts.project;                        // a project page: fixed scope, nothing to filter
    let zoom = TT.store.get('gantt-zoom', 'day');
    let solo = { q: '', who: 'all', hideClosed: TT.store.get('gantt-hide-closed', true) };
    let hideUndated = !fixed && TT.store.get('gantt-hide-undated', true);
    const open = new Set(TT.store.get('gantt-open', []));
    if (opts.project) open.add(`t:${opts.project}`);
    let subs = [];
    let hot = null;                                        // hovered item key (its arrows light up)
    let drag = null;

    // ---------------------------------------------------------------- toolbar
    const linkSw = board ? el('label', { class: 'switch gantt-link', title: _t('開啟：顯示與看板相同的卡片（篩選、人員專注、標籤），點長條會在看板上指出卡片；關閉：甘特圖獨立篩選') },
      el('input', { type: 'checkbox', checked: linked }), el('span', { class: 'track' }), el('span', { text: _t('與看板連動') })) : null;
    const zoomSeg = el('div', { class: 'segmented', role: 'group', title: _t('時間刻度') },
      ...[['day', _t('日')], ['week', _t('週')], ['month', _t('月')]].map(([v, l]) => {
        const b = el('button', { type: 'button', dataset: { v }, text: l });
        b.addEventListener('click', () => { zoom = v; TT.store.set('gantt-zoom', v); paint(true); });
        return b;
      }));
    const search = el('input', { class: 'input input-sm gantt-q', type: 'search', placeholder: _t('搜尋卡片或子任務'), 'aria-label': _t('搜尋') });
    const who = el('select', { class: 'select input-sm gantt-who', 'aria-label': _t('顯示誰的工作') },
      el('option', { value: 'all', text: _t('全部') }), el('option', { value: 'mine', text: _t('只看我的') }));
    const hideSw = el('label', { class: 'switch' }, el('input', { type: 'checkbox', checked: solo.hideClosed }), el('span', { class: 'track' }), el('span', { text: _t('隱藏完成／取消') }));
    const soloTools = el('span', { class: 'gantt-solo-tools' }, search, who, hideSw);
    const expand = el('button', { class: 'btn btn-sm', type: 'button', html: svg('chevron-down') + _t('全部展開') });
    const collapse = el('button', { class: 'btn btn-sm', type: 'button', html: svg('chevron-right') + _t('全部收合') });
    const todayBtn = el('button', { class: 'btn btn-sm', type: 'button', html: svg('clock') + _t('今天') });
    const exportBtn = el('button', { class: 'btn btn-sm', type: 'button', title: _t('匯出目前甘特圖上的卡片：Excel 甘特圖或 MS Project'), html: svg('download') + _t('匯出') });
    const legend = el('div', { class: 'gantt-legend' },
      el('span', { class: 'gl gl-ms', text: _t('里程碑') }), el('span', { class: 'gl gl-dep', text: _t('前置相依') }),
      el('span', { class: 'gl gl-bad', text: _t('排程衝突') }), el('span', { class: 'gl gl-base', text: _t('基準線') }),
      el('span', { class: 'gl gl-start', text: _t('實際開始') }), el('span', { class: 'gl gl-late', text: _t('逾期') }),
      el('span', { class: 'hint', text: opts.project && TTBoard.find(opts.project)?.history ? _t('歷史案件，只能檢視') : _t('拖曳長條改日期，拖邊緣改開始／到期') }));
    const undatedSw = el('label', { class: 'switch', title: _t('沒有開始日、到期日，子任務也都沒有日期的卡片不列出') },
      el('input', { type: 'checkbox', checked: hideUndated }), el('span', { class: 'track' }), el('span', { text: _t('隱藏未排日期') }));
    undatedSw.querySelector('input').addEventListener('change', e => { hideUndated = e.target.checked; TT.store.set('gantt-hide-undated', hideUndated); paint(); });
    const colBtn = el('button', { class: 'btn btn-sm', type: 'button', title: _t('選擇表格要顯示的欄位'), html: svg('list') + _t('欄位') });
    colBtn.addEventListener('click', e => { e.stopPropagation(); columnMenu(); });
    const tools = el('div', { class: 'gantt-tools' }, linkSw, soloTools, undatedSw, el('span', { class: 'spacer' }), expand, collapse, todayBtn, zoomSeg, colBtn, exportBtn);
    const well = el('div', { class: 'gantt-well', tabindex: '-1' });
    const side = el('aside', { class: 'gantt-side', hidden: true, 'aria-label': _t('項目詳情') });
    const tip = el('div', { class: 'gantt-tip', hidden: true });
    host.classList.add('gantt-host');
    host.replaceChildren(tools, legend, el('div', { class: 'gantt-main' }, well, side), tip);

    linkSw?.querySelector('input').addEventListener('change', e => { linked = e.target.checked; TT.store.set('gantt-linked', linked); paintTools(); paint(); opts.onLinked?.(linked); });
    search.addEventListener('input', () => { solo.q = search.value.trim().toLowerCase(); paint(); });
    who.addEventListener('change', () => { solo.who = who.value; paint(); });
    hideSw.querySelector('input').addEventListener('change', e => { solo.hideClosed = e.target.checked; TT.store.set('gantt-hide-closed', solo.hideClosed); paint(); });
    const saveOpen = () => TT.store.set('gantt-open', [...open].slice(-300));
    expand.addEventListener('click', () => { const rec = x => { if (x.kids.length) { open.add(x.key); x.kids.forEach(rec); } }; items().forEach(rec); saveOpen(); paint(); });
    collapse.addEventListener('click', () => { open.clear(); saveOpen(); paint(); });
    todayBtn.addEventListener('click', () => scrollToday(true));
    exportBtn.addEventListener('click', () => {
      if (TT.store.get('export-format', 'xlsx') === 'xlsx') TT.store.set('export-format', 'gantt');   // from here the Gantt is what is wanted
      TTBoard.exportReport([...new Set(items().map(x => x.cardId))]);
    });
    const paintTools = () => {
      soloTools.hidden = linked || fixed;
      undatedSw.hidden = fixed;
      zoomSeg.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === zoom)));
      opts.onLinked?.(linked);
    };
    paintTools();

    // ---------------------------------------------------------------- data
    function cardsShown() {
      // one project's page: the project and the everyday cards attached to it, finished work included
      if (opts.project) return TTBoard.all().filter(t => t.id === opts.project || (t.project_id === opts.project && (t.kind || 'ops') !== 'project'));
      if (linked && board) return board.cards();
      return TTBoard.tasks.filter(t => !(solo.hideClosed && CLOSED.has(t.status))
        && (solo.who !== 'mine' || t.mine !== false));
    }
    /** Flat list of items (cards and subtasks) with their tree, in display order. */
    function items() {
      const cards = cardsShown();
      const byCard = new Map();
      subs.forEach(r => { if (!byCard.has(r.card)) byCard.set(r.card, []); byCard.get(r.card).push(r); });
      const out = [];
      const q = !linked ? solo.q : '';
      const built = [];
      cards.forEach(t => {
        const card = {
          key: `t:${t.id}`, kind: 't', id: t.id, cardId: t.id, card: t, depth: 1, title: t.title, status: t.status, priority: t.priority,
          start: t.milestone ? null : t.start_at, due: t.due_at, milestone: !!t.milestone, deps: t.deps || [], base_start: t.base_start,
          base_due: t.base_due, started_at: t.started_at, who: t.owner ? TT.nameOf(t.owner) : '', canEdit: t.can_edit !== false, kids: [],
        };
        const rows = byCard.get(t.id) || [];
        const nodes = new Map(rows.map(r => [r.id, {
          key: `s:${r.id}`, kind: 's', id: r.id, cardId: t.id, card: t, raw: r, title: r.title, status: r.status, priority: r.priority,
          start: r.milestone ? null : r.start_at, due: r.due_at, milestone: r.milestone, deps: r.deps || [], base_start: r.base_start,
          base_due: r.base_due, started_at: r.started_at, who: r.assignee ? TT.nameOf(r.assignee) : '', canEdit: t.can_edit !== false || r.mine_edit, kids: [],
        }]));
        rows.forEach(r => (r.parent && nodes.get(r.parent) ? nodes.get(r.parent) : card).kids.push(nodes.get(r.id)));
        const match = x => !q || x.title.toLowerCase().includes(q) || x.kids.some(match);
        if (!match(card)) return;
        const [a] = span(card);
        if (hideUndated && a == null) return;
        built.push([a ?? Infinity, card]);
      });
      // scheduled cards by start date, then the rest in board order
      // 編號: the project (or card) is 0 and everything below it is numbered 1, 2, 3 … top to bottom (folded rows
      // included, so a number never changes when rows open or close). On a project's page the project and the cards
      // attached to it form one run; on the board every card starts again at 0. The level prefix before each title
      // follows the style chosen on the card or its project (A / A1 …, 1 / 1.1 …, 一、/（一）…, P1 / T1.2 …).
      let serial = 0;
      built.sort((x, y) => (opts.project ? (y[1].id === opts.project) - (x[1].id === opts.project) : 0) || x[0] - y[0]).forEach(([, card]) => {
        if (!opts.project) serial = 0;
        const style = TT.wbs.styleOf(card.card);
        const number = (x, lvl) => {
          x.code = String(serial++); x.lvl = lvl; x.prefix = TT.wbs.label(style, lvl);
          x.kids.forEach((k, i) => number(k, [...lvl, i + 1]));
        };
        number(card, []);
        const walk = (x, depth, path) => {
          x.depth = depth; x.path = path;
          out.push(x);
          if (open.has(x.key) || q) x.kids.forEach(k => walk(k, depth + 1, [...path, k.id]));
        };
        walk(card, 1, []);
      });
      return out;
    }
    // a parent without its own dates spans its children (drawn as a bracket)
    function span(x) {
      if (x.start || x.due) return [dayNum(x.start || x.due), dayNum(x.due || x.start), false];
      const all = []; const rec = y => { y.kids.forEach(k => { if (k.start || k.due) all.push(dayNum(k.start || k.due), dayNum(k.due || k.start)); rec(k); }); };
      rec(x);
      return all.length ? [Math.min(...all), Math.max(...all), true] : [null, null, false];
    }
    function pct(x) {
      if (!x.kids.length) return DONE[x.status] || 0;
      const k = x.kids.filter(c => c.status !== 'canceled');
      return k.length ? Math.round(k.reduce((s, c) => s + pct(c), 0) / k.length) : (DONE[x.status] || 0);
    }
    const late = (x, end) => !CLOSED.has(x.status) && end != null && end < todayNum();

    // ---------------------------------------------------------------- paint (laid out like OpenProject's Gantt)
    // Left: a table — number, type, name (tree), status, owner, start, finish, duration; the columns that fit
    // the table's width are shown (drag the divider to widen it). Right: the time line — year, month and week
    // rows, today as a red dashed line, bars coloured by type with the start date on their left and the finish
    // date (red when late) and the name on their right.
    const COLS = [                                        // [key, label, width] — when the table is narrow, the first ones stay
      ['name', _t('名稱'), 200], ['code', _t('編號'), 58], ['status', _t('狀態'), 100], ['type', _t('類型'), 78],
      ['due', _t('完成日期'), 92], ['start', _t('起始日期'), 92], ['dur', _t('時長'), 58], ['who', _t('負責'), 92],
      ['prio', _t('優先'), 60], ['pct', _t('完成度'), 66]];
    const DEFAULT_ORDER = ['code', 'type', 'name', 'status', 'who', 'prio', 'start', 'due', 'dur', 'pct'];   // left to right
    // the order this person dragged the columns into (kept with their profile); new columns join at the end
    let ORDER = (() => {
      const saved = TT.store.get('gantt-col-order', null);
      const ok = Array.isArray(saved) ? saved.filter(k => DEFAULT_ORDER.includes(k)) : [];
      return [...ok, ...DEFAULT_ORDER.filter(k => !ok.includes(k))];
    })();
    const DEFAULT_COLS = ['code', 'type', 'status', 'start', 'due', 'dur', 'who'];
    // the columns this person chose (名稱 is always there); kept with their profile
    let chosen = new Set(Array.isArray(TT.store.get('gantt-cols', null)) ? TT.store.get('gantt-cols') : DEFAULT_COLS);
    const widthFor = set => 24 + COLS.filter(([k]) => k === 'name' || set.has(k)).reduce((n, c) => n + c[2], 0);
    let leftW = Math.max(260, Math.min(1400, Number(TT.store.get('gantt-lw', 0)) || widthFor(chosen)));
    const colsFor = w => {
      let used = 24;
      const keep = new Set();
      for (const [k, , cw] of COLS) {                     // by priority: stop at the first that no longer fits
        if (k !== 'name' && !chosen.has(k)) continue;
        if (k !== 'name' && used + cw > w) break;
        keep.add(k); used += cw;
      }
      return ORDER.filter(k => keep.has(k));
    };
    /** 「欄位」: tick the columns to show; the table widens to hold them (drag the divider to change it). */
    function columnMenu() {
      document.querySelector('.gantt-colmenu')?.remove();
      const pop = el('div', { class: 'gantt-colmenu', role: 'dialog', 'aria-label': _t('表格欄位') });
      const apply = () => {
        TT.store.set('gantt-cols', [...chosen]);
        leftW = Math.max(260, Math.min(1400, widthFor(chosen)));
        TT.store.set('gantt-lw', leftW);
        paint(true);
      };
      // drag the rows (⋮⋮) to change the order of the columns, left to right = top to bottom
      let dragKey = null;
      const rowOf = k => {
        const box = el('input', { type: 'checkbox', checked: k === 'name' || chosen.has(k), disabled: k === 'name' });
        box.addEventListener('change', () => { if (box.checked) chosen.add(k); else chosen.delete(k); apply(); });
        const r = el('label', { class: 'gcm-row' + (k === 'name' ? ' is-fixed' : ''), draggable: 'true', dataset: { k } },
          el('span', { class: 'gcm-grip', 'aria-hidden': 'true', text: '⋮⋮' }), box,
          el('span', { text: k === 'name' ? _t('名稱（固定）') : COLS.find(c => c[0] === k)[1] }));
        r.addEventListener('dragstart', e => { dragKey = k; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', k); requestAnimationFrame(() => r.classList.add('is-drag')); });
        r.addEventListener('dragend', () => { dragKey = null; paintMenu(); });
        r.addEventListener('dragover', e => {
          if (!dragKey || dragKey === k) return;
          e.preventDefault();
          const b = r.getBoundingClientRect(), after = e.clientY > b.top + b.height / 2;
          const next = ORDER.filter(x => x !== dragKey);
          next.splice(next.indexOf(k) + (after ? 1 : 0), 0, dragKey);
          if (next.join() !== ORDER.join()) {
            ORDER = next;
            TT.store.set('gantt-col-order', ORDER);
            list.replaceChildren(...ORDER.map(rowOf));
            list.querySelector(`[data-k="${dragKey}"]`)?.classList.add('is-drag');
            paint(true);
          }
        });
        return r;
      };
      const list = el('div', { class: 'gcm-list' });
      const paintMenu = () => pop.replaceChildren(
        el('div', { class: 'gcm-head', text: _t('表格欄位（拖曳 ⋮⋮ 調整順序）') }),
        (list.replaceChildren(...ORDER.map(rowOf)), list),
        (() => {
          const all = el('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: _t('全選') });
          all.addEventListener('click', () => { chosen = new Set(ORDER.filter(k => k !== 'name')); apply(); paintMenu(); });
          const reset = el('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: _t('恢復預設') });
          reset.addEventListener('click', () => { chosen = new Set(DEFAULT_COLS); ORDER = [...DEFAULT_ORDER]; TT.store.set('gantt-col-order', ORDER); apply(); paintMenu(); });
          return el('div', { class: 'gcm-foot' }, all, reset);
        })(),
        el('p', { class: 'hint', text: _t('表格太窄時，次要的欄位會先收起來；拖曳表格與時間軸之間的分隔線可以加寬。') }));
      paintMenu();
      document.body.append(pop);
      const r = colBtn.getBoundingClientRect();
      pop.style.top = `${Math.min(r.bottom + 6, innerHeight - pop.offsetHeight - 8)}px`;
      pop.style.left = `${Math.max(8, Math.min(r.right - pop.offsetWidth, innerWidth - pop.offsetWidth - 8))}px`;
      const off = e => { if (!pop.contains(e.target) && e.target !== colBtn) { pop.remove(); document.removeEventListener('mousedown', off); } };
      setTimeout(() => document.addEventListener('mousedown', off), 0);
    }
    const ymd = v => v ? v.slice(0, 10).replaceAll('-', '/') : '';
    const typeOf = x => x.kind === 't' && (x.card?.kind === 'project') ? 'project' : x.milestone ? 'milestone' : x.kids.length ? 'summary' : 'task';
    const TYPE_LABEL = { project: _t('專案'), summary: _t('摘要任務'), task: _t('工作'), milestone: _t('里程碑') };

    let range = null;
    let sel = null;                                        // the item shown in the side panel
    function paint(keepCenter = false) {
      const list = items();
      const dw = ZOOM[zoom] || 26;
      const T = todayNum();
      // range: everything shown (and their baselines), today, a margin
      let lo = T - 14, hi = T + 45;
      list.forEach(x => { const [a, b] = span(x); [a, b, dayNum(x.base_start), dayNum(x.base_due), dayNum(x.started_at)].forEach(n => { if (n != null) { lo = Math.min(lo, n - 10); hi = Math.max(hi, n + 30); } }); });
      if (zoom !== 'day') { lo -= (new Date(lo * 864e5).getUTCDay() + 6) % 7; }
      const center = keepCenter && range ? range.lo + (well.scrollLeft + well.clientWidth / 2 - lw()) / range.dw : null;
      range = { lo, hi, dw };
      const days = hi - lo + 1, W = days * dw;
      const fit = well.clientWidth ? Math.max(240, Math.round(well.clientWidth * .62)) : leftW;   // leave room for the time line
      const lwNow = Math.min(leftW, fit);
      const cols = colsFor(lwNow);

      // time scale: year / month / ISO week (/ day)
      const years = [], months = [], weeks = [], dcells = [];
      for (let n = lo; n <= hi; n++) {
        const d = new Date(n * 864e5), s = isoOf(n), dow = d.getUTCDay();
        if (!years.length || s.endsWith('-01-01')) years.push({ n: 0, label: s.slice(0, 4) });
        years[years.length - 1].n++;
        if (!months.length || s.endsWith('-01')) months.push({ n: 0, label: _t('{0}月', +s.slice(5, 7)) });
        months[months.length - 1].n++;
        if (!weeks.length || dow === 1) {
          const t = new Date(d); t.setUTCDate(t.getUTCDate() + 3 - ((dow + 6) % 7));
          const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
          weeks.push({ n: 0, label: String(Math.ceil(((t - y0) / 864e5 + 1) / 7)).padStart(2, '0') });
        }
        weeks[weeks.length - 1].n++;
        if (zoom === 'day') dcells.push(`<div class="${dow === 0 || dow === 6 ? 'we' : ''}${n === T ? ' now' : ''}" style="width:${dw}px">${+s.slice(8)}</div>`);
      }
      const scale = `<div class="gantt-scale" style="width:${W}px">
        <div class="gs-row gs-y">${years.map(m => `<div style="width:${m.n * dw}px">${m.label}</div>`).join('')}</div>
        <div class="gs-row gs-m">${months.map(m => `<div style="width:${m.n * dw}px">${m.label}</div>`).join('')}</div>
        ${zoom !== 'month' ? `<div class="gs-row gs-w">${weeks.map(w => `<div style="width:${w.n * dw}px">${w.n * dw >= 16 ? w.label : ''}</div>`).join('')}</div>` : ''}
        ${zoom === 'day' ? `<div class="gs-row gs-d">${dcells.join('')}</div>` : ''}</div>`;
      // week lines (and weekends at the day scale) as one background
      const bg = zoom === 'month'
        ? `repeating-linear-gradient(90deg, transparent 0 ${7 * dw - 1}px, var(--g-grid) ${7 * dw - 1}px ${7 * dw}px)`
        : `repeating-linear-gradient(90deg, transparent 0 ${5 * dw}px, var(--g-weekend) ${5 * dw}px ${7 * dw - 1}px, var(--g-grid) ${7 * dw - 1}px ${7 * dw}px)`;
      const bgOffset = ((lo - (lo - ((new Date(lo * 864e5).getUTCDay() + 6) % 7))) * -dw);   // align to Monday

      const at = new Map(list.map((x, i) => [x.key, i]));
      const head = cols.map(k => `<div class="g-h-${k}">${COLS.find(c => c[0] === k)[1]}</div>`).join('');
      const tmpl = cols.map(k => k === 'name' ? 'minmax(0, 1fr)' : `${COLS.find(c => c[0] === k)[2]}px`).join(' ');
      const rows = list.map(x => {
        const [a, b, derived] = span(x);
        const st = statusOf(x.status);
        const lt = late(x, b);
        const ty = typeOf(x);
        let bar = '';
        if (a != null) {
          const left = (a - lo) * dw, width = (b - a + 1) * dw;
          const endTxt = `<span class="g-d${lt ? ' is-late' : ''}">${ymd(isoOf(b))}</span>`;
          if (x.milestone) {
            bar = `<span class="g-ms${lt ? ' is-late' : ''}${x.canEdit ? ' can-drag' : ''}" data-drag="move" style="left:${left + dw / 2 - 7}px"></span>
                   <span class="g-lbl g-lbl-r" style="left:${left + dw / 2 + 12}px">${endTxt}<i>◆ ${esc(x.title)}</i></span>`;
          } else {
            const drag = x.canEdit && !derived && !x.kids.length;
            bar = `<span class="g-lbl g-lbl-l" style="right:${W - left + 6}px">${ymd(isoOf(a))}</span>
                   <span class="g-bar t-${ty}${CLOSED.has(x.status) ? ' is-closed' : ''}${x.status === 'canceled' ? ' is-canceled' : ''}${derived ? ' is-derived' : ''}${drag ? ' can-drag' : ''}"
                     data-drag="move" style="left:${left}px;width:${width}px">
                     ${drag ? '<span class="g-h g-h-l" data-drag="start"></span><span class="g-h g-h-r" data-drag="end"></span>' : ''}</span>
                   <span class="g-lbl g-lbl-r" style="left:${left + width + 6}px">${endTxt}<i>${esc(x.title)}</i></span>`;
          }
        }
        const bs = dayNum(x.base_start || x.base_due), be = dayNum(x.base_due || x.base_start);
        const base = bs != null ? `<span class="g-base" style="left:${(bs - lo) * dw}px;width:${(be - bs + 1) * dw}px"></span>` : '';
        const sa = dayNum(x.started_at);
        const started = sa != null ? _t("<span class=\"g-start\" style=\"left:{0}px\" title=\"實際開始 {1}\"></span>", (sa - lo) * dw, md(x.started_at)) : '';
        const caret = x.kids.length
          ? `<button class="g-tog" type="button" data-toggle="${x.key}" aria-expanded="${open.has(x.key)}" aria-label="${open.has(x.key) ? _t('收合') : _t('展開')}">${open.has(x.key) ? '⌄' : '›'}</button>`
          : '<span class="g-tog"></span>';
        const cell = {
          code: `<span class="g-c-code" title="${esc(_t('第 {0} 層', x.depth))}">${esc(x.code ?? '')}</span>`,
          type: `<span class="g-type ty-${ty}">${TYPE_LABEL[ty]}</span>`,
          name: `<span class="g-c-name" style="--ind:${x.depth - 1}">${caret}<button class="g-name" type="button" data-open="${x.key}" title="${esc((x.prefix ? x.prefix + ' ' : '') + x.title)}">${x.prefix ? `<span class="g-pfx">${esc(x.prefix)}</span>` : ''}${x.milestone ? '◆ ' : ''}${esc(x.title)}</button></span>`,
          status: `<span class="g-st" style="--c:${st.color}"><i></i>${esc(st.zh || '')}</span>`,
          who: `<span class="g-who">${esc(x.who || '')}</span>`,
          start: `<span class="g-date${derived ? ' is-derived' : ''}">${x.milestone ? '' : a != null ? ymd(isoOf(a)) : ''}</span>`,
          due: `<span class="g-date${lt ? ' is-late' : ''}${derived ? ' is-derived' : ''}">${b != null ? ymd(isoOf(b)) : ''}</span>`,
          dur: `<span class="g-dur">${a != null && !x.milestone ? _t('{0} 天', b - a + 1) : ''}</span>`,
          prio: `<span class="g-prio pr-${x.priority || 'normal'}">${{ low: _t('低'), normal: _t('一般'), high: _t('高') }[x.priority || 'normal'] || ''}</span>`,
          pct: `<span class="g-pct-c"><i style="width:${pct(x)}%"></i><b>${pct(x)}%</b></span>`,
        };
        return `<div class="g-row g-l${x.depth}${hot && (hot === x.key) ? ' is-hot' : ''}${sel === x.key ? ' is-sel' : ''}" data-key="${x.key}">
          <div class="g-cell">${cols.map(k => cell[k]).join('')}</div>
          <div class="g-track" style="width:${W}px">${base}${started}${bar}</div></div>`;
      }).join('');
      const unscheduled = list.filter(x => span(x)[0] == null).length;
      well.innerHTML = `<div class="gantt" style="--dw:${dw}px;--g-bg:${bg};--g-bgx:${bgOffset}px;--g-lw:${lwNow}px;--g-cols:${tmpl}">
        <div class="g-head"><div class="g-corner">${head}<span class="g-split" title="${esc(_t('拖曳調整表格寬度'))}"></span></div>${scale}</div>
        <div class="g-body">${rows || `<p class="hint g-empty">${esc(_t('沒有可顯示的卡片'))}</p>`}
          <span class="g-today" style="left:calc(var(--g-lw) + ${(T - lo) * dw + dw / 2}px)"></span>
          <svg class="g-deps" width="${W}" height="${list.length * RH}"></svg></div></div>`;
      host.querySelector('.gantt-count')?.remove();
      tools.append(el('span', { class: 'hint gantt-count', text: _t("{0} 張卡片{1}", list.filter(x => x.kind === 't').length, unscheduled ? _t("，{0} 項未排日期", unscheduled) : '') }));
      drawDeps(list, at);
      if (center != null) well.scrollLeft = (center - lo) * dw - well.clientWidth / 2 + lw();
      if (sel && !side.contains(document.activeElement)) paintSide();    // not while a field there is being edited
    }
    const lw = () => parseFloat(getComputedStyle(well.querySelector('.gantt') || well).getPropertyValue('--g-lw')) || 0;
    const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

    function drawDeps(list, at) {
      const svgEl = well.querySelector('.g-deps');
      if (!svgEl) return;
      const { lo, dw } = range;
      const byKey = new Map(list.map(x => [x.key, x]));
      // a hidden (folded) item is drawn at its closest visible ancestor
      const all = new Map(); list.forEach(x => { const rec = y => { all.set(y.key, y); y.kids.forEach(rec); }; rec(x); });
      const parentOf = new Map(); all.forEach(y => y.kids.forEach(k => parentOf.set(k.key, y)));
      const shown = key => { let y = all.get(key); while (y && !at.has(y.key)) y = parentOf.get(y.key); return y; };
      const out = [];
      list.forEach(x => (x.deps || []).forEach(d => {
        const a = shown(d.key) || null;
        if (!a || a.key === x.key) return;
        const [as, ae] = span(a), [bs] = span(x);
        if (ae == null || bs == null) return;
        const real = all.get(d.key) || a;
        const realEnd = span(real)[1];
        // a milestone may fall on its predecessor's last day; other work starts the day after (+ lag)
        const bad = realEnd != null && bs < realEnd + (d.lag || 0) + (x.milestone ? 0 : 1) && !CLOSED.has(real.status);
        const x1 = (ae - lo + 1) * dw - (a.milestone ? dw / 2 : 0), y1 = at.get(a.key) * RH + RH / 2;
        const x2 = (bs - lo) * dw + (x.milestone ? dw / 2 - 8 : 0), y2 = at.get(x.key) * RH + RH / 2;
        const lit = hot && (hot === a.key || hot === x.key || hot === d.key);
        const path = x2 - 8 >= x1 + 6
          ? `M${x1} ${y1} H${x1 + 6} V${y2} H${x2 - 4}`
          : `M${x1} ${y1} H${x1 + 6} V${y2 + (y2 > y1 ? -RH / 2 : RH / 2)} H${x2 - 10} V${y2} H${x2 - 4}`;
        const cls = `${bad ? 'bad' : ''}${lit ? ' hot' : ''}`;
        out.push(`<path class="${cls}" d="${path}"><title>${esc(real.title)} → ${esc(x.title)}${d.lag ? _t("（間隔 {0} 天）", d.lag) : ''}${bad ? _t('：開始得比前置任務完成還早') : ''}</title></path>
                  <polygon class="${cls}" points="${x2 - 5},${y2 - 4} ${x2 + 1},${y2} ${x2 - 5},${y2 + 4}"/>`);
      }));
      svgEl.innerHTML = out.join('');
    }

    function scrollToday(smooth) {
      if (!range) return;
      const x = (todayNum() - range.lo) * range.dw - well.clientWidth * .3;
      well.scrollTo({ left: Math.max(0, x), behavior: smooth ? 'smooth' : 'auto' });
    }

    // ---------------------------------------------------------------- interaction
    const find = key => { let hit = null; items().forEach(x => { const rec = y => { if (y.key === key) hit = y; y.kids.forEach(rec); }; rec(x); }); return hit; };
    const parentOfKey = key => { let hit = null; items().forEach(x => { const rec = y => { y.kids.forEach(k => { if (k.key === key) hit = y; rec(k); }); }; rec(x); }); return hit; };

    /** The details of one item on the right (as OpenProject's split view), edited in place: each field is saved as
     *  soon as it changes (the same permissions as the card / subtask editor). Double-click a row for the full editor. */
    const subBodies = new Map();                           // card id → Promise of its subtasks' text (loaded when needed)
    const subBody = cardId => {
      if (!subBodies.has(cardId)) subBodies.set(cardId, api(`/api/tasks/${cardId}/comments`).then(cs => new Map(cs.map(c => [c.id, c]))).catch(() => new Map()));
      return subBodies.get(cardId);
    };
    async function saveItem(x, body, what) {
      try {
        if (x.kind === 't') await TTBoard.save(x.id, body);
        else await api(`/api/tasks/${x.cardId}/comments/${x.id}/task`, { method: 'PUT', body });
        toast(_t('已儲存：{0}', what));
      } catch (e) { toast(e.message, true); }
      if (side.contains(document.activeElement)) document.activeElement.blur();   // so the panel shows what was saved
      await refresh(true);
    }
    function paintSide() {
      const x = sel && find(sel);
      if (!x) { side.hidden = true; host.classList.remove('has-side'); return; }
      const [a, b, derived] = span(x);
      const st = statusOf(x.status), ty = typeOf(x), up = parentOfKey(x.key);
      const lt = late(x, b);
      const edit = x.canEdit && !(opts.project && TTBoard.find(opts.project)?.history);
      const tips = TTBoard.TIPS || {};
      // a field row; `tip` adds a「!」with the same explanations as the card editor
      const row = (k, v, tip) => v == null || v === '' ? null : el('div', { class: 'gs-f' },
        el('span', {}, k, tip && tips[tip] ? TT.helpTip(tips[tip]) : null), typeof v === 'string' ? el('b', { text: v }) : v);
      const close = el('button', { class: 'icon-btn', type: 'button', 'aria-label': _t('關閉'), html: svg('x') });
      close.addEventListener('click', () => { sel = null; paintSide(); well.querySelectorAll('.g-row.is-sel').forEach(r => r.classList.remove('is-sel')); });
      const openBtn = el('button', { class: 'btn btn-sm', type: 'button', html: svg('external') + _t('開啟完整編輯') });
      openBtn.addEventListener('click', () => openItem(x));
      const upBtn = up ? el('button', { class: 'gs-up', type: 'button', text: (up.prefix ? up.prefix + ' ' : '') + up.title }) : null;
      upBtn?.addEventListener('click', () => { sel = up.key; paint(); });
      const deps = (x.deps || []).map(d => d.title + (d.lag ? _t("（+{0} 天）", d.lag) : ''));

      // ---- title
      let title;
      if (edit) {
        title = el('input', { class: 'input gs-title-in', value: x.title, maxlength: '200', 'aria-label': _t('名稱') });
        title.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); title.blur(); } if (e.key === 'Escape') { title.value = x.title; title.blur(); } });
        title.addEventListener('change', () => { const v = title.value.trim(); if (v && v !== x.title) saveItem(x, { title: v }, _t('名稱')); else title.value = x.title; });
      } else title = el('h3', { text: x.title });
      // ---- status (an item with items below follows them)
      let status;
      if (edit && !x.kids.length) {
        status = el('select', { class: 'select gs-in', 'aria-label': _t('狀態') },
          ...(TTBoard.STATUSES || []).filter(s => s.key !== 'recurring' && (s.key !== 'overdue' || x.status === 'overdue'))
            .map(s => el('option', { value: s.key, text: s.zh || s.label, selected: s.key === x.status })));
        status.addEventListener('change', () => saveItem(x, { status: status.value }, _t('狀態')));
      } else status = el('span', { class: 'g-st', style: { '--c': st.color }, title: x.kids.length ? _t('由下層彙總') : '' }, el('i'), st.zh || x.status);
      // ---- owner
      const owners = x.kind === 't' ? (x.card?.assignees || []) : (x.raw?.assignee ? [x.raw.assignee] : []);
      let who = el('b', { text: owners.map(TT.nameOf).join('、') || x.who || '—' });
      if (edit && (x.kind !== 't' || x.card?.can_assign !== false)) {
        const pick = TT.mentionInput(el('input', { class: 'input gs-in', placeholder: owners.length ? _t('改派給…') : _t('輸入姓名或帳號指派…') }),
          { onPick: p => saveItem(x, x.kind === 't' ? { assignees: [p.username] } : { assignee: p.username }, _t('負責')) });
        const clear = owners.length ? el('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: _t('取消指派') }) : null;
        clear?.addEventListener('click', () => saveItem(x, x.kind === 't' ? { assignees: [] } : { assignee: '' }, _t('負責')));
        who = el('div', { class: 'gs-who' }, owners.length ? el('b', { text: owners.map(TT.nameOf).join('、') }) : null, pick, clear);
      }
      // ---- priority
      const pr = x.priority || 'normal';
      const PR = { low: _t('低'), normal: _t('一般'), high: _t('高') };
      let prio = el('b', { text: PR[pr] || pr });
      if (edit) {
        prio = el('select', { class: 'select gs-in', 'aria-label': _t('優先') }, ...Object.entries(PR).map(([k, l]) => el('option', { value: k, text: l, selected: k === pr })));
        prio.addEventListener('change', () => saveItem(x, { priority: prio.value }, _t('優先')));
      }
      // ---- dates (an item with items below spans them: not set by hand here)
      const clearVal = x.kind === 't' ? null : '';
      const dateIn = (v, field, label) => {
        const inp = el('input', { class: 'input gs-in gs-date', type: 'date', value: v ? v.slice(0, 10) : '', 'aria-label': label });
        inp.addEventListener('change', () => {
          const orig = field === 'start_at' ? x.start : x.due;
          saveItem(x, { [field]: inp.value ? withDay(orig, dayNum(inp.value)) : clearVal }, label);
        });
        return inp;
      };
      let dates;
      if (edit && !x.kids.length) {
        dates = x.milestone ? dateIn(x.due, 'due_at', _t('日期'))
          : el('div', { class: 'gs-dates' }, dateIn(x.start, 'start_at', _t('起始日期')), el('span', { text: '–' }), dateIn(x.due, 'due_at', _t('完成日期')),
            a != null ? el('small', { class: 'hint', text: _t('{0} 天', b - a + 1) }) : null);
      } else {
        dates = a == null ? _t('未排日期') : x.milestone ? ymd(isoOf(b)) : `${ymd(isoOf(a))} – ${ymd(isoOf(b))}（${_t('{0} 天', b - a + 1)}）${derived || x.kids.length ? _t('，由下層推算') : ''}`;
      }
      let ms = null;
      if (edit && !x.kids.length) {
        ms = el('label', { class: 'gs-check' }, el('input', { type: 'checkbox', checked: !!x.milestone }), el('span', { text: _t('里程碑（只有一個日期）') }), TT.helpTip(tips.milestone));
        ms.querySelector('input').addEventListener('change', e => saveItem(x, { milestone: e.target.checked }, _t('里程碑')));
      }
      // ---- description
      const descBox = el('div', { class: 'gs-descbox' });
      const paintDesc = (text, canEdit, save) => {
        if (!canEdit) { descBox.replaceChildren(text ? el('div', { class: 'gs-desc' }, TT.mentionText(text)) : el('p', { class: 'hint', text: _t('沒有說明') })); return; }
        const ta = el('textarea', { class: 'textarea gs-desc-in', rows: '4', placeholder: _t('細節、步驟、注意事項…（輸入 @ 提到同事）') });
        ta.value = text || '';
        TT.mentionInput(ta);
        const ok = el('button', { class: 'btn btn-sm btn-primary', type: 'button', html: svg('check') + _t('儲存說明'), hidden: true });
        ta.addEventListener('input', () => { ok.hidden = ta.value === (text || ''); });
        ok.addEventListener('click', () => save(ta.value));
        descBox.replaceChildren(ta, el('div', { class: 'gs-actions-inline' }, ok));
      };
      if (x.kind === 't') {
        paintDesc(x.card?.description || '', edit && x.card?.can_edit_body !== false, v => saveItem(x, { description: v }, _t('說明')));
      } else {
        descBox.append(el('p', { class: 'hint', text: _t('讀取中…') }));
        subBody(x.cardId).then(m => {
          const c = m.get(x.id);
          const body = c && c.body && c.body.trim() !== (x.title || '').trim() ? c.body : '';
          paintDesc(body, edit && c?.can_edit_body, async v => {
            try { await api(`/api/tasks/${x.cardId}/comments/${x.id}`, { method: 'PUT', body: { body: v } }); toast(_t('已儲存：{0}', _t('說明'))); }
            catch (e) { toast(e.message, true); }
            subBodies.delete(x.cardId);
            if (side.contains(document.activeElement)) document.activeElement.blur();
            await refresh(true);
          });
        });
      }

      side.replaceChildren(...[
        el('div', { class: 'gs-head' }, up ? el('div', { class: 'gs-parent' }, el('span', { text: _t('上層：') }), upBtn) : el('span', { class: 'hint', text: x.kind === 't' ? _t('主卡') : '' }), el('span', { class: 'spacer' }), close),
        el('div', { class: 'gs-title' }, el('span', { class: `g-type ty-${ty}`, text: TYPE_LABEL[ty] }), el('code', { text: `#${x.code}` }), x.prefix ? el('span', { class: 'g-pfx', text: x.prefix }) : null, title),
        el('div', { class: 'gs-status' }, status, TT.helpTip(tips.status), lt ? el('span', { class: 'g-d is-late', text: _t('逾期') }) : null),
        el('h4', { text: _t('人員') }), row(_t('負責'), who, 'owner'),
        el('h4', { text: _t('日期與進度') }),
        row(x.milestone ? _t('日期') : _t('期間'), dates, x.kids.length ? 'derived' : x.milestone ? 'milestone' : null), ms,
        row(_t('優先'), prio),
        row(_t('完成度'), `${pct(x)}%`, 'pct'),
        row(_t('實際開始'), x.started_at ? ymd(x.started_at) : _t('還沒開始'), 'started'),
        row(_t('基準線'), x.base_due || x.base_start ? TTBoard.baselineText({ ...x, due_at: x.due }) : _t('還沒有設定'), 'baseline'),
        row(_t('前置'), deps.length ? deps.join('、') : _t('沒有'), 'deps'),
        x.kids.length ? row(_t('下層'), _t('{0} 項', x.kids.length), 'below') : null,
        el('h4', { text: _t('說明') }), descBox,
        el('div', { class: 'gs-actions' }, openBtn,
          edit ? el('span', { class: 'hint', text: _t('改了就存；前置、附件、提醒等請開完整編輯') }) : el('span', { class: 'hint', text: _t('你只能檢視這個項目') }))].filter(Boolean));
      side.hidden = false;
      host.classList.add('has-side');
    }
    function select(key) {
      sel = key;
      well.querySelectorAll('.g-row.is-sel').forEach(r => r.classList.remove('is-sel'));
      well.querySelector(`.g-row[data-key="${CSS.escape(key)}"]`)?.classList.add('is-sel');
      paintSide();
    }
    // the divider between the table and the time line: drag to widen the table (more columns appear)
    well.addEventListener('pointerdown', e => {
      const h = e.target.closest('.g-split');
      if (!h || e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      const x0 = e.clientX, w0 = lw(), g = well.querySelector('.gantt');
      h.setPointerCapture(e.pointerId);
      const move = ev => { leftW = Math.max(260, Math.min(1100, w0 + ev.clientX - x0)); g.style.setProperty('--g-lw', leftW + 'px'); };
      const up = () => { h.removeEventListener('pointermove', move); h.removeEventListener('pointerup', up); TT.store.set('gantt-lw', leftW); paint(true); };
      h.addEventListener('pointermove', move);
      h.addEventListener('pointerup', up);
    }, true);
    function openItem(x) {
      if (linked && board) board.flash(x.cardId);
      if (x.kind === 't') TTBoard.openEditor(TTBoard.find(x.id) || x.card);
      else TTBoard.openNavigator(x.card, x.path);
    }
    well.addEventListener('click', e => {
      if (drag?.moved) return;
      const t = e.target.closest('[data-toggle]');
      if (t) { const k = t.dataset.toggle; open.has(k) ? open.delete(k) : open.add(k); saveOpen(); paint(); return; }
      const o = e.target.closest('.g-row');
      if (!o || e.target.closest('.g-split')) return;
      if (linked && board) { const x = find(o.dataset.key); if (x) board.flash(x.cardId); }
      select(o.dataset.key);
    });
    well.addEventListener('dblclick', e => {
      const o = e.target.closest('.g-row');
      const x = o && find(o.dataset.key);
      if (x) openItem(x);
    });
    well.addEventListener('mousemove', e => {
      if (drag) return;
      const row = e.target.closest('.g-row');
      const key = row?.dataset.key || null;
      if (key !== hot) {
        hot = key;
        well.querySelectorAll('.g-row.is-hot').forEach(r => r.classList.remove('is-hot'));
        row?.classList.add('is-hot');
        const list = items(); drawDeps(list, new Map(list.map((x, i) => [x.key, i])));
        if (linked && board) {
          board.root.querySelectorAll('.kb-card.gantt-hot').forEach(c => c.classList.remove('gantt-hot'));
          const x = key && find(key);
          if (x) board.root.querySelector(`.kb-card[data-id="${x.cardId}"]`)?.classList.add('gantt-hot');
        }
      }
      const bar = e.target.closest('.g-bar, .g-ms');
      if (!bar || !key) { tip.hidden = true; return; }
      const x = find(key);
      if (!x) return;
      const [a, b] = span(x);
      const deps = (x.deps || []).map(d => d.title + (d.lag ? _t("（+{0} 天）", d.lag) : ''));
      tip.innerHTML = `<b>${x.milestone ? '◆ ' : ''}${esc(x.title)}</b>
        <div>${x.milestone ? md(x.due) : _t("{0} – {1}（{2} 天）", md(isoOf(a)), md(isoOf(b)), b - a + 1)} · ${esc(statusOf(x.status).zh || '')} · ${pct(x)}%${x.who ? ' · ' + esc(x.who) : ''}</div>
        ${x.base_due || x.base_start ? `<div>${esc(TTBoard.baselineText({ ...x, due_at: x.due }))}</div>` : ''}
        ${x.started_at ? _t("<div>實際開始 {0}</div>", md(x.started_at)) : ''}
        ${deps.length ? _t("<div>前置：{0}</div>", esc(deps.join('、'))) : ''}
        ${x.kids.length ? _t('<div class="hint">期間由下層推算 · 點一下看詳情，雙擊開啟</div>') : x.canEdit && !span(x)[2] ? _t('<div class="hint">拖曳改日期 · 點一下看詳情，雙擊開啟</div>') : _t('<div class="hint">點一下看詳情，雙擊開啟</div>')}`;
      tip.hidden = false;
      const r = tip.getBoundingClientRect();
      tip.style.left = Math.min(innerWidth - r.width - 8, e.clientX + 14) + 'px';
      tip.style.top = Math.min(innerHeight - r.height - 8, e.clientY + 16) + 'px';
    });
    well.addEventListener('mouseleave', () => {
      tip.hidden = true; hot = null;
      board?.root.querySelectorAll('.kb-card.gantt-hot').forEach(c => c.classList.remove('gantt-hot'));
    });

    // drag: move the bar, or one of its edges; saved when released
    well.addEventListener('pointerdown', e => {
      const h = e.target.closest('[data-drag]');
      const bar = h && h.closest('.g-bar, .g-ms');
      if (!bar || !bar.classList.contains('can-drag') || e.button !== 0) return;
      const x = find(bar.closest('.g-row').dataset.key);
      if (!x) return;
      const [a, b] = span(x);
      drag = { x, mode: h.dataset.drag, a, b, x0: e.clientX, bar, left: parseFloat(bar.style.left), width: parseFloat(bar.style.width) || 0, delta: 0, moved: false };
      bar.setPointerCapture(e.pointerId);
      tip.hidden = true;
      e.preventDefault();
    });
    well.addEventListener('pointermove', e => {
      if (!drag) return;
      const dw = range.dw;
      const delta = Math.round((e.clientX - drag.x0) / dw);
      if (delta === drag.delta && drag.moved) return;
      drag.delta = delta;
      if (Math.abs(e.clientX - drag.x0) > 3) drag.moved = true;
      const { mode, bar } = drag;
      if (mode === 'move') bar.style.left = `${drag.left + delta * dw}px`;
      else if (mode === 'end') bar.style.width = `${Math.max(dw, drag.width + delta * dw)}px`;
      else if (mode === 'start') { const d = Math.min(delta, drag.b - drag.a); bar.style.left = `${drag.left + d * dw}px`; bar.style.width = `${drag.width - d * dw}px`; }
      bar.classList.add('is-dragging');
      bar.title = dragText();
    });
    const dragText = () => {
      const { mode, a, b, delta, x } = drag;
      if (x.milestone) return md(isoOf(b + delta));
      const s = mode === 'end' ? a : Math.min(a + delta, mode === 'start' ? b : a + delta), e2 = mode === 'start' ? b : Math.max(a, b + delta);
      return `${md(isoOf(mode === 'move' ? a + delta : s))} – ${md(isoOf(mode === 'move' ? b + delta : e2))}`;
    };
    well.addEventListener('pointerup', async () => {
      if (!drag) return;
      const d = drag;
      setTimeout(() => { drag = null; }, 0);
      if (!d.moved || !d.delta) { d.bar.classList.remove('is-dragging'); return; }       // a plain click opens it (click handler)
      const { x, mode, a, b, delta } = d;
      const body = {};
      if (x.milestone) body.due_at = withDay(x.due, b + delta);
      else if (mode === 'move') { if (x.start) body.start_at = withDay(x.start, a + delta); if (x.due) body.due_at = withDay(x.due, b + delta); }
      else if (mode === 'end') { const n = Math.max(a, b + delta); if (x.due) body.due_at = withDay(x.due, n); else body.start_at = withDay(x.start, n); }
      else { const n = Math.min(b, a + delta); if (x.start) body.start_at = withDay(x.start, n); else body.due_at = withDay(x.due, n); }
      try {
        if (x.kind === 't') await TTBoard.save(x.id, body);
        else await api(`/api/tasks/${x.cardId}/comments/${x.id}/task`, { method: 'PUT', body });
        toast(_t("「{0}」改為 {1}", x.title, x.milestone ? md(body.due_at) : `${md(body.start_at || x.start || body.due_at)} – ${md(body.due_at || x.due || body.start_at)}`));
        const newEnd = x.milestone ? b + delta : mode === 'move' ? b + delta : mode === 'end' ? Math.max(a, b + delta) : b;
        if (newEnd > b) await offerShift(x, newEnd, newEnd - b);
        await refresh(true);
      } catch (err) { toast(err.message, true); paint(); }
    });

    /** The successors (and theirs) that now start before their predecessor ends: shift them by the same days? */
    async function offerShift(x, newEnd, days) {
      const all = new Map();
      items().forEach(r => { const rec = y => { all.set(y.key, y); y.kids.forEach(rec); }; rec(r); });
      const succ = key => [...all.values()].filter(y => (y.deps || []).some(d => d.key === key));
      const direct = succ(x.key).filter(y => { const d = y.deps.find(v => v.key === x.key); const st = span(y)[0]; return st != null && st < newEnd + (d.lag || 0) + (y.milestone ? 0 : 1); });
      if (!direct.length) return;
      const chain = new Map(direct.map(y => [y.key, y]));
      const queue = [...direct];
      while (queue.length) { const y = queue.shift(); succ(y.key).forEach(z => { if (!chain.has(z.key) && z.key !== x.key) { chain.set(z.key, z); queue.push(z); } }); }
      const list = [...chain.values()];
      const names = list.slice(0, 5).map(y => `「${y.title}」`).join('、') + (list.length > 5 ? _t(" 等 {0} 項", list.length) : '');
      if (!confirm(_t("「{0}」延後了 {1} 天，後續 {2} 項會比它更早開始：\n{3}\n\n要把它們一起順延 {4} 天嗎？", x.title, days, list.length, names, days))) return;
      try {
        const r = await api('/api/tasks/shift', { method: 'POST', body: { keys: list.filter(y => !y.kids.length || y.kind === 't').map(y => y.key), days } });
        toast(_t("已順延 {0} 項", r.moved.length) + (r.skipped.length ? _t("；{0} 項你沒有權限修改，未順延", r.skipped.length) : ''));
      } catch (e) { toast(e.message, true); }
    }

    // ---------------------------------------------------------------- refresh
    let pending = null;
    async function refresh(force = false) {
      if (force) subBodies.clear();
      // a history project (歷史區) is not on the board: its own subtasks, history included
      const archived = opts.project && !TTBoard.tasks.some(t => t.id === opts.project);
      try { subs = archived ? await TT.api(`/api/tasks/gantt?project=${opts.project}`) : await TTBoard.ganttRows(force); } catch (e) { subs = []; }
      if (force) await TTBoard.load(true).catch(() => {});
      paint(true);
    }
    // the board's cards were just (re)loaded — that is what 'tt:tasks' says: fetch only the Gantt's own rows.
    // (Reloading the cards here would fire 'tt:tasks' again: an endless loop that redraws the radar, the alert
    // list and the board several times a second.)
    const onTasks = () => { clearTimeout(pending); pending = setTimeout(() => { if (!host.isConnected) return cleanup(); refresh(false); }, 250); };
    const onView = () => { if (!host.isConnected) return cleanup(); if (linked) paint(true); };
    const cleanup = () => { document.removeEventListener('tt:tasks', onTasks); board?.root.removeEventListener('kb:view', onView); };
    document.addEventListener('tt:tasks', onTasks);
    board?.root.addEventListener('kb:view', onView);
    // the board points back: hovering a card lights up its rows
    board?.root.addEventListener('mouseover', e => {
      if (!linked) return;
      const c = e.target.closest('.kb-card');
      well.querySelectorAll('.g-row.is-linked').forEach(r => r.classList.remove('is-linked'));
      if (c) well.querySelectorAll(`.g-row[data-key="t:${c.dataset.id}"]`).forEach(r => r.classList.add('is-linked'));
    });

    // the columns that fit depend on the width: lay out again when it changes (window, split view, side panel)
    let lastW = 0;
    new ResizeObserver(() => {
      const w = well.clientWidth;
      if (!host.isConnected || Math.abs(w - lastW) < 40) return;
      lastW = w;
      if (range) paint(true);
    }).observe(well);
    TTBoard.load().catch(() => {}).then(async () => { await refresh(false); scrollToday(false); });
    return {
      refresh: () => refresh(true),
      setLinked(v) { linked = !!v && !!board; if (linkSw) linkSw.querySelector('input').checked = linked; paintTools(); paint(); },
      get linked() { return linked; },
    };
  }

  window.TTGantt = { mount };
})();
