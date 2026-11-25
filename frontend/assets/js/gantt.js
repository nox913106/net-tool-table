/* =============================================================================
   IPMS — Gantt view of the board
   Cards (L1) and their subtasks (L2–L4) on a day scale: bars by status, milestones as diamonds,
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
      el('span', { class: 'hint', text: _t('拖曳長條改日期，拖邊緣改開始／到期') }));
    const undatedSw = el('label', { class: 'switch', title: _t('沒有開始日、到期日，子任務也都沒有日期的卡片不列出') },
      el('input', { type: 'checkbox', checked: hideUndated }), el('span', { class: 'track' }), el('span', { text: _t('隱藏未排日期') }));
    undatedSw.querySelector('input').addEventListener('change', e => { hideUndated = e.target.checked; TT.store.set('gantt-hide-undated', hideUndated); paint(); });
    const tools = el('div', { class: 'gantt-tools' }, linkSw, soloTools, undatedSw, el('span', { class: 'spacer' }), expand, collapse, todayBtn, zoomSeg, exportBtn);
    const well = el('div', { class: 'gantt-well', tabindex: '-1' });
    const tip = el('div', { class: 'gantt-tip', hidden: true });
    host.classList.add('gantt-host');
    host.replaceChildren(tools, legend, well, tip);

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
      if (opts.project) return TTBoard.tasks.filter(t => t.id === opts.project || (t.project_id === opts.project && (t.kind || 'ops') !== 'project'));
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
      built.sort((x, y) => x[0] - y[0]).forEach(([, card]) => {
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

    // ---------------------------------------------------------------- paint
    let range = null;
    function paint(keepCenter = false) {
      const list = items();
      const dw = ZOOM[zoom] || 26;
      const T = todayNum();
      // range: everything shown (and their baselines), today, a margin
      let lo = T - 14, hi = T + 45;
      list.forEach(x => { const [a, b] = span(x); [a, b, dayNum(x.base_start), dayNum(x.base_due), dayNum(x.started_at)].forEach(n => { if (n != null) { lo = Math.min(lo, n - 7); hi = Math.max(hi, n + 14); } }); });
      if (zoom !== 'day') { lo -= (new Date(lo * 864e5).getUTCDay() + 6) % 7; }
      const center = keepCenter && range ? range.lo + (well.scrollLeft + well.clientWidth / 2 - lw()) / range.dw : null;
      range = { lo, hi, dw };
      const days = hi - lo + 1, W = days * dw;

      // scale
      const months = [], weeks = [], dcells = [];
      for (let n = lo; n <= hi; n++) {
        const d = new Date(n * 864e5), s = isoOf(n), dow = d.getUTCDay();
        if (!months.length || s.endsWith('-01')) months.push({ n: 0, label: zoom === 'month' ? _t("{0} 月", +s.slice(5, 7)) : _t("{0} 年 {1} 月", s.slice(0, 4), +s.slice(5, 7)) });
        months[months.length - 1].n++;
        if (!weeks.length || dow === 1) {
          const t = new Date(d); t.setUTCDate(t.getUTCDate() + 3 - ((dow + 6) % 7));
          const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
          weeks.push({ n: 0, label: zoom === 'month' ? '' : `W${Math.ceil(((t - y0) / 864e5 + 1) / 7)}${zoom === 'day' ? ' · ' + md(s) : ''}` });
        }
        weeks[weeks.length - 1].n++;
        if (zoom === 'day') dcells.push(`<div class="${dow === 0 || dow === 6 ? 'we' : ''}${n === T ? ' now' : ''}" style="width:${dw}px">${+s.slice(8)}</div>`);
      }
      const scale = `<div class="gantt-scale" style="width:${W}px">
        <div class="gs-row gs-m">${months.map(m => `<div style="width:${m.n * dw}px">${m.label}</div>`).join('')}</div>
        ${zoom !== 'month' ? `<div class="gs-row">${weeks.map(w => `<div style="width:${w.n * dw}px">${w.label}</div>`).join('')}</div>` : ''}
        ${zoom === 'day' ? `<div class="gs-row gs-d">${dcells.join('')}</div>` : ''}</div>`;
      // weekend shading + week lines as one background
      const bg = zoom === 'month'
        ? `repeating-linear-gradient(90deg, transparent 0 ${7 * dw - 1}px, var(--g-grid) ${7 * dw - 1}px ${7 * dw}px)`
        : `repeating-linear-gradient(90deg, transparent 0 ${5 * dw}px, var(--g-weekend) ${5 * dw}px ${7 * dw - 1}px, var(--g-grid) ${7 * dw - 1}px ${7 * dw}px)`;
      const bgOffset = ((lo - (lo - ((new Date(lo * 864e5).getUTCDay() + 6) % 7))) * -dw);   // align to Monday

      const at = new Map(list.map((x, i) => [x.key, i]));
      const rows = list.map(x => {
        const [a, b, derived] = span(x);
        const st = statusOf(x.status);
        const lt = late(x, b);
        let bar = '';
        if (a != null) {
          const left = (a - lo) * dw, width = (b - a + 1) * dw;
          if (x.milestone) {
            bar = `<span class="g-ms${lt ? ' is-late' : ''}${x.canEdit ? ' can-drag' : ''}" data-drag="move" style="left:${left + dw / 2 - 8}px;--c:${st.color}"></span>
                   <span class="g-ms-lbl" style="left:${left + dw + 6}px">${esc(x.title)} ${md(x.due)}</span>`;
          } else {
            const p = pct(x);
            const drag = x.canEdit && !derived && !x.kids.length;
            bar = `<span class="g-bar${x.kids.length ? ' is-parent' : ''}${derived ? ' is-derived' : ''}${lt ? ' is-late' : ''}${drag ? ' can-drag' : ''}"
                     data-drag="move" style="left:${left}px;width:${width}px;--c:${st.color}">
                     <span class="g-fill" style="width:${p}%"></span>${width > 46 ? `<span class="g-pct">${p}%</span>` : ''}
                     ${drag ? '<span class="g-h g-h-l" data-drag="start"></span><span class="g-h g-h-r" data-drag="end"></span>' : ''}</span>`;
          }
        }
        const bs = dayNum(x.base_start || x.base_due), be = dayNum(x.base_due || x.base_start);
        const base = bs != null ? `<span class="g-base" style="left:${(bs - lo) * dw}px;width:${(be - bs + 1) * dw}px"></span>` : '';
        const sa = dayNum(x.started_at);
        const started = sa != null ? _t("<span class=\"g-start\" style=\"left:{0}px\" title=\"實際開始 {1}\"></span>", (sa - lo) * dw, md(x.started_at)) : '';
        // the whole left part (indent, arrow, level) is one large target for folding
        const lv = `<span class="g-caret" aria-hidden="true">${x.kids.length ? (open.has(x.key) ? '▾' : '▸') : ''}</span><span class="g-lv">L${x.depth}</span>`;
        const caret = x.kids.length
          ? `<button class="g-tog" type="button" data-toggle="${x.key}" aria-expanded="${open.has(x.key)}" title="${open.has(x.key) ? _t('收合') : _t('展開')}" aria-label="${open.has(x.key) ? _t('收合') : _t('展開')}">${lv}</button>`
          : `<span class="g-tog">${lv}</span>`;
        return `<div class="g-row g-l${x.depth}${hot && (hot === x.key) ? ' is-hot' : ''}" data-key="${x.key}">
          <div class="g-cell" style="--ind:${x.depth - 1}">${caret}
            <button class="g-name" type="button" data-open="${x.key}" title="${esc(x.title)}">${x.milestone ? '◆ ' : ''}${esc(x.title)}</button>
            <span class="g-who">${esc(x.who || '')}</span>
            <span class="g-st" style="--c:${lt ? 'var(--danger)' : st.color}">${lt ? _t('逾期') : x.milestone ? _t('里程碑') : esc(st.zh || '')}</span></div>
          <div class="g-track" style="width:${W}px">${base}${started}${bar}</div></div>`;
      }).join('');
      const unscheduled = list.filter(x => span(x)[0] == null).length;
      well.innerHTML = _t("<div class=\"gantt\" style=\"--dw:{0}px;--g-bg:{1};--g-bgx:{2}px\">\n        <div class=\"g-head\"><div class=\"g-corner\"><span>工作項目</span><span class=\"g-who\">負責</span><span>狀態</span></div>{3}</div>\n        <div class=\"g-body\">{4}\n          <span class=\"g-today\" style=\"left:calc(var(--g-lw) + {5}px)\"></span>\n          <svg class=\"g-deps\" width=\"{6}\" height=\"{7}\"></svg></div></div>", dw, bg, bgOffset, scale, rows || _t('<p class="hint g-empty">沒有可顯示的卡片</p>'), (T - lo) * dw + dw / 2 - 1, W, list.length * RH);
      host.querySelector('.gantt-count')?.remove();
      tools.append(el('span', { class: 'hint gantt-count', text: _t("{0} 張卡片{1}", list.filter(x => x.kind === 't').length, unscheduled ? _t("，{0} 項未排日期", unscheduled) : '') }));
      drawDeps(list, at);
      if (center != null) well.scrollLeft = (center - lo) * dw - well.clientWidth / 2 + lw();
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
    function openItem(x) {
      if (linked && board) board.flash(x.cardId);
      if (x.kind === 't') TTBoard.openEditor(TTBoard.tasks.find(t => t.id === x.id) || x.card);
      else TTBoard.openNavigator(x.card, x.path);
    }
    well.addEventListener('click', e => {
      if (drag?.moved) return;
      const t = e.target.closest('[data-toggle]');
      if (t) { const k = t.dataset.toggle; open.has(k) ? open.delete(k) : open.add(k); saveOpen(); paint(); return; }
      const o = e.target.closest('[data-open], .g-bar, .g-ms');
      if (!o) return;
      const key = o.dataset.open || o.closest('.g-row')?.dataset.key;
      const x = key && find(key);
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
        ${x.kids.length ? _t('<div class="hint">期間由下層推算 · 點一下開啟</div>') : x.canEdit && !span(x)[2] ? _t('<div class="hint">拖曳改日期 · 點一下開啟</div>') : _t('<div class="hint">點一下開啟</div>')}`;
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
      try { subs = await TTBoard.ganttRows(force); } catch (e) { subs = []; }
      if (force) await TTBoard.load(true).catch(() => {});
      paint(true);
    }
    const onTasks = () => { clearTimeout(pending); pending = setTimeout(() => { if (!host.isConnected) return cleanup(); refresh(true); }, 250); };
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

    TTBoard.load().catch(() => {}).then(async () => { await refresh(false); scrollToday(false); });
    return {
      refresh: () => refresh(true),
      setLinked(v) { linked = !!v && !!board; if (linkSw) linkSw.querySelector('input').checked = linked; paintTools(); paint(); },
      get linked() { return linked; },
    };
  }

  window.TTGantt = { mount };
})();
