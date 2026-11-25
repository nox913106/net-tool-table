/* =============================================================================
   IPMS — projects and my work
   #/mine         everything assigned to me (every project and level, everyday cards), by due date
   #/projects     the projects side by side: managers' order, health, problems; cards that look like projects
   #/project/ID   one project: Gantt, project board (its L2… work by status), list, Excel
   All of it reads the same data as the board (TTBoard) and the server's analysis (projects' health).
   ============================================================================= */
(() => {
  const { el, api, svg, toast } = TT;
  const CLOSED = new Set(['complete', 'canceled']);
  const day = v => { if (!v) return null; const [y, m, d] = v.slice(0, 10).split('-').map(Number); return Date.UTC(y, m - 1, d) / 864e5; };
  const todayN = () => { const d = new Date(); return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 864e5; };
  const md = v => v ? `${+v.slice(5, 7)}/${+v.slice(8, 10)}` : '—';
  const st = k => (TTBoard.STATUSES || []).find(s => s.key === k) || { color: '#64748b', zh: k, label: k };
  const stChip = (k, late) => el('span', { class: 'pj-st', style: { '--c': late ? 'var(--danger)' : st(k).color }, text: late ? _t('逾期') : st(k).zh });
  const me = () => TTBoard.meInfo?.user?.id ?? null;
  const isProject = t => (t.kind || 'ops') === 'project';

  // ---------------------------------------------------------------- my work (every source)
  async function myItems() {
    const rows = await TTBoard.ganttRows().catch(() => []);
    const id = me();
    const cards = new Map(TTBoard.tasks.map(t => [t.id, t]));
    const hasKids = new Set(rows.map(r => r.card));
    const out = [];
    const pathOf = (r, byId) => { const p = []; for (let c = r, n = 0; c && n < 5; c = c.parent ? byId.get(c.parent) : null, n++) p.unshift(c.id); return p; };
    const byId = new Map(rows.map(r => [r.id, r]));
    rows.forEach(r => {
      if (CLOSED.has(r.status) || r.milestone || !(id == null || r.assignee?.id === id)) return;
      if (id == null && !r.assignee) return;
      const card = cards.get(r.card);
      if (!card) return;
      const proj = isProject(card) ? card : card.project_id ? cards.get(card.project_id) : null;
      out.push({ kind: proj ? 'proj' : 'ops', title: r.title, due: r.due_at, status: r.status,
        src: proj ? `${proj.title}${card.id !== proj.id ? ` › ${card.title}` : ''} › L${pathOf(r, byId).length + 1}` : _t("一般卡「{0}」› 子任務", card.title),
        open: () => TTBoard.openNavigator(card, pathOf(r, byId)) });
    });
    TTBoard.tasks.forEach(t => {
      if (CLOSED.has(t.status) || isProject(t) || hasKids.has(t.id)) return;
      const mine = id == null ? true : (t.assignees || []).some(p => p.id === id) || (!(t.assignees || []).length && t.owner?.id === id);
      if (!mine) return;
      const proj = t.project_id ? cards.get(t.project_id) : null;
      out.push({ kind: proj ? 'proj' : 'ops', title: t.title, due: t.due_at, status: t.status,
        src: proj ? _t("一般卡 · 歸屬「{0}」", proj.title) : _t('一般（維運）卡'), open: () => TTBoard.openEditor(t) });
    });
    return out.sort((a, b) => (day(a.due) ?? 1e9) - (day(b.due) ?? 1e9));
  }
  async function mineCounts() {
    const list = await myItems();
    const T = todayN();
    return { late: list.filter(x => x.due && day(x.due) < T).length, today: list.filter(x => x.due && day(x.due) === T).length };
  }

  async function renderMine(view) {
    const head = el('div', { class: 'page-head' }, el('div', { class: 'page-title' },
      el('span', { class: 'page-icon', html: svg('user') }),
      el('div', {}, el('h1', { text: _t('我的工作') }), el('p', { class: 'page-desc', text: _t('指派給你的所有項目：不分一般卡或專案，也不分在第幾層，依到期日排序。') }))));
    const body = el('div', { class: 'pj-mine' }, el('p', { class: 'hint', text: _t('載入中…') }));
    view.replaceChildren(head, body);
    await TTBoard.load().catch(() => {});
    const paint = async () => {
      if (!body.isConnected) return document.removeEventListener('tt:tasks', paint);
      const list = await myItems();
      const T = todayN();
      const groups = [[_t('逾期'), 'var(--danger)', x => x.due && day(x.due) < T], [_t('今天'), 'var(--warning)', x => x.due && day(x.due) === T],
        [_t('本週'), 'var(--text)', x => x.due && day(x.due) > T && day(x.due) - T <= 7], [_t('之後'), 'var(--text-3)', x => x.due && day(x.due) - T > 7],
        [_t('未排日期'), 'var(--text-3)', x => !x.due]];
      body.replaceChildren(...groups.map(([label, color, f]) => {
        const g = list.filter(f);
        if (!g.length) return null;
        return el('section', { class: 'pj-grp' }, el('h3', { style: { color }, text: `${label}（${g.length}）` }),
          ...g.map(x => {
            const late = x.due && day(x.due) < T;
            const row = el('button', { type: 'button', class: 'pj-mw', style: { '--c': x.kind === 'proj' ? 'var(--proj, #7c3aed)' : 'var(--text-3)' } },
              el('span', { class: 'pj-kind ' + x.kind, text: x.kind === 'proj' ? _t('專案') : _t('一般') }),
              el('b', { class: 'pj-mw-t', text: x.title }),
              el('span', { class: 'pj-mw-when' + (late ? ' late' : ''), text: late ? _t("逾期 {0} 天", T - day(x.due)) : md(x.due) }),
              stChip(x.status), el('small', { class: 'pj-mw-src', text: x.src }));
            row.addEventListener('click', x.open);
            return row;
          }));
      }).filter(Boolean));
      if (!list.length) body.append(el('p', { class: 'hint', text: _t('沒有指派給你的未完成項目。') }));
    };
    document.addEventListener('tt:tasks', paint);
    paint();
  }

  // ---------------------------------------------------------------- overview
  async function renderProjects(view) {
    const add = el('button', { class: 'btn btn-primary', type: 'button', html: svg('plus') + _t('新增專案') });
    add.addEventListener('click', () => TTBoard.openEditor(null, { kind: 'project' }));
    const head = el('div', { class: 'page-head' }, el('div', { class: 'page-title' },
      el('span', { class: 'page-icon', html: svg('layout') }),
      el('div', {}, el('h1', { text: _t('專案總覽') }), el('p', { class: 'page-desc', text: _t('所有專案一列一個，依主管排序；一般（維運）卡片不會混進來。') }))),
      el('div', { class: 'board-tools' }, add));
    const body = el('div', { class: 'pj-over' }, el('p', { class: 'hint', text: _t('載入中…') }));
    let tab = TT.store.get('projects-tab', 'list');
    const tabs = el('div', { class: 'pj-tabs', role: 'tablist' });
    view.replaceChildren(head, tabs, body);
    await TTBoard.load().catch(() => {});
    const paintTabs = () => tabs.replaceChildren(...[['list', _t('專案')], ['load', _t('人員負載')], ['links', _t('時段與跨專案')]].map(([k, l]) => {
      const b = el('button', { class: 'pj-tab', type: 'button', role: 'tab', 'aria-selected': String(tab === k), text: l });
      b.addEventListener('click', () => { tab = k; TT.store.set('projects-tab', k); paintTabs(); paint(); });
      return b;
    }));
    paintTabs();
    const paint = async () => {
      if (!body.isConnected) { document.removeEventListener('tt:tasks', paint); return; }
      const a = await TTBoard.projectAnalysis().catch(() => null);
      if (!a) { body.replaceChildren(el('p', { class: 'hint', text: _t('讀不到專案資料') })); return; }
      if (tab === 'load') { body.replaceChildren(...loadView(a)); return; }
      if (tab === 'links') { body.replaceChildren(...linksView(a)); return; }
      const T = todayN();
      const ps = a.projects;
      const lo = Math.min(T - 14, ...ps.map(p => day(p.start) ?? T)), hi = Math.max(T + 60, ...ps.map(p => day(p.end) ?? day(p.due) ?? T));
      const pos = v => `${((day(v) - lo) / (hi - lo) * 100).toFixed(2)}%`;
      const wid = (s, e) => `${(Math.max(1, day(e) - day(s) + 1) / (hi - lo) * 100).toFixed(2)}%`;
      const rows = ps.map((p, i) => {
        const card = TTBoard.tasks.find(t => t.id === p.id);
        const up = a.can_rank ? el('button', { class: 'pj-mv', type: 'button', 'aria-label': _t('往前'), text: '▲', disabled: i === 0 }) : null;
        const down = a.can_rank ? el('button', { class: 'pj-mv', type: 'button', 'aria-label': _t('往後'), text: '▼', disabled: i === ps.length - 1 }) : null;
        const move = async d => {
          const ids = ps.map(x => x.id); const j = i + d;
          [ids[i], ids[j]] = [ids[j], ids[i]];
          try { await api('/api/tasks/projects/order', { method: 'POST', body: { ids } }); await TTBoard.projectAnalysis(true); paint(); }
          catch (e) { toast(e.message, true); }
        };
        up?.addEventListener('click', e => { e.stopPropagation(); move(-1); });
        down?.addEventListener('click', e => { e.stopPropagation(); move(1); });
        const flags = Object.entries(p.problems).filter(([, n]) => n).map(([k, n]) => el('span', { class: 'pj-flag ' + k, text: `${TTBoard.PROBLEM_ZH[k]} ${n}` }));
        const start = p.start || p.due, end = p.end || p.due;
        const tr = el('tr', { class: 'pj-row' + (p.problem_items ? '' : ' ok'), tabindex: '0' },
          el('td', { class: 'n' }, up, down, el('span', { text: ` #${p.rank ?? '—'}` })),
          el('td', {}, el('b', { text: p.title }), card?.owner ? el('div', { class: 'hint', text: TT.nameOf(card.owner) }) : null),
          el('td', {}, stChip(p.status)),
          el('td', { class: 'n' }, el('span', { class: 'pj-bar' }, el('i', { style: { width: `${p.pct}%` } })), ` ${p.pct}%`),
          el('td', { class: 'n', style: { color: (p.slip || 0) > 0 ? 'var(--danger)' : 'inherit' }, text: p.slip == null ? '—' : p.slip > 0 ? _t("落後 {0} 天", p.slip) : p.slip < 0 ? _t("提前 {0} 天", -p.slip) : _t('準時') }),
          el('td', {}, p.next ? el('span', { text: `◆ ${p.next.title} ` }) : '—', p.next ? el('span', { class: 'hint', text: md(p.next.due) }) : null),
          el('td', {}, flags.length ? el('span', { class: 'pj-flags' }, flags) : el('span', { class: 'hint', text: _t('正常') })),
          el('td', { class: 'pj-tl' }, start ? el('div', { class: 'pj-mg' },
            el('span', { class: 'pj-mg-b' + ((p.slip || 0) > 0 ? ' late' : ''), style: { left: pos(start), width: wid(start, end) } }, el('i', { style: { width: `${p.pct}%` } })),
            p.base_due ? el('span', { class: 'pj-mg-base', style: { left: pos(start), width: wid(start, p.base_due) } }) : null,
            p.next ? el('span', { class: 'pj-mg-ms', style: { left: `calc(${pos(p.next.due)} - 5px)` } }) : null,
            el('span', { class: 'pj-mg-today', style: { left: pos(new Date(T * 864e5).toISOString()) } })) : el('span', { class: 'hint', text: _t('未排日期') })));
        tr.addEventListener('click', () => { location.hash = `#/project/${p.id}`; });
        tr.addEventListener('keydown', e => { if (e.key === 'Enter') location.hash = `#/project/${p.id}`; });
        return tr;
      });
      const table = el('div', { class: 'pj-tw' }, el('table', { class: 'pj-table' },
        el('thead', {}, el('tr', {}, ...[_t('排序'), _t('專案'), _t('狀態'), _t('完成'), _t('排程'), _t('下個里程碑'), _t('問題'), _t('時程')].map(h => el('th', { text: h })))),
        el('tbody', {}, ...rows)));
      const parts = [a.can_rank ? el('p', { class: 'hint', text: _t('用 ▲▼ 調整專案的先後：雷達、警示清單與這張表都照這個順序。') }) : null,
        ps.length ? table : el('p', { class: 'hint', text: _t('還沒有專案。按「新增專案」，或把下方看起來像專案的卡片轉為專案。') })];
      // everyday cards that look like projects
      const sus = await api('/api/tasks/projects/suspected').catch(() => []);
      if (sus.length) {
        parts.push(el('section', { class: 'pj-sus' }, el('h3', { text: _t("看起來像專案的一般卡片（{0}）", sus.length) }),
          el('p', { class: 'hint', text: _t('有基準線、前置任務、三層以上子任務或很多子任務。轉為專案後，會有自己的專案頁，在看板上以專案卡出現。') }),
          ...sus.map(x => {
            const b = el('button', { class: 'btn btn-sm', type: 'button', text: _t('轉為專案') });
            b.addEventListener('click', async () => {
              b.disabled = true;
              try { await TTBoard.save(x.id, { kind: 'project' }); toast(_t("「{0}」已轉為專案", x.title)); await TTBoard.projectAnalysis(true); paint(); }
              catch (e) { toast(e.message, true); b.disabled = false; }
            });
            return el('div', { class: 'pj-sus-row' }, el('b', { text: x.title }), el('span', { class: 'hint', text: x.why.join('、') }), b);
          })));
      }
      body.replaceChildren(...parts.filter(Boolean));
    };
    document.addEventListener('tt:tasks', paint);
    paint();
  }

  const titleOf = id => TTBoard.tasks.find(t => t.id === id)?.title || '';
  /** People × weeks: estimated hours due, across every project and everyday card. */
  function loadView(a) {
    const limit = a.load_hours, w0 = Date.parse(a.week0);
    let sel = a.load.find(r => r.over) || a.load[0];
    let wk = 0;
    const detail = el('div', { class: 'pj-load-detail' });
    const table = el('table', { class: 'pj-table pj-heat' });
    const paintTable = () => table.replaceChildren(
      el('thead', {}, el('tr', {}, el('th', { text: _t('人員') }), ...[0, 1, 2, 3, 4, 5].map(k => el('th', { text: _t("{0}{1} 週", k ? '' : _t('本週 '), md(new Date(w0 + k * 7 * 864e5).toISOString())) })))),
      el('tbody', {}, ...a.load.map(r => el('tr', {}, el('td', {}, r.name, r.over ? el('span', { class: 'pj-flag overload', text: _t('超載') }) : null),
        ...r.weeks.slice(0, 6).map((w, k) => {
          const lv = w.hours === 0 ? 0 : w.hours <= limit * .6 ? 1 : w.hours <= limit ? 2 : 3;
          const td = el('td', { class: `h l${lv}` + (sel === r && wk === k ? ' sel' : ''), tabindex: '0', title: _t("{0} 項{1}", w.count, w.no_estimate ? _t("，{0} 項未填預估", w.no_estimate) : '') },
            el('b', { text: `${w.hours}h` }), w.no_estimate ? el('small', { text: ` (${w.no_estimate}?)` }) : null);
          const go = () => { sel = r; wk = k; paintTable(); paintDetail(); };
          td.addEventListener('click', go);
          td.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
          return td;
        })))));
    const paintDetail = () => {
      if (!sel) { detail.replaceChildren(); return; }
      const w = sel.weeks[wk];
      const groups = {};
      w.items.forEach(i => { const k = i.project ? `#${i.project}` : 'ops'; (groups[k] = groups[k] || []).push(i); });
      detail.replaceChildren(el('h3', { text: _t("{0} · {1}：{2} 小時 / 上限 {3}", sel.name, wk ? _t("第 {0} 週", wk + 1) : _t('本週'), w.hours, limit) + (w.no_estimate ? _t("（{0} 項未填預估，各以 {1} 小時計）", w.no_estimate, a.default_hours) : '') }),
        ...Object.entries(groups).sort((x, y) => y[1].reduce((n, i) => n + i.hours, 0) - x[1].reduce((n, i) => n + i.hours, 0)).map(([k, list]) =>
          el('div', { class: 'pj-load-row' }, el('span', { class: k === 'ops' ? 'pj-kind ops' : 'pj-kind proj', text: k === 'ops' ? _t('一般') : titleOf(+k.slice(1)) }),
            el('span', { text: `${list.reduce((n, i) => n + i.hours, 0)}h：` + list.map(i => `${i.title}${i.estimated ? '' : _t('（未填）')}`).join('、') }))));
    };
    paintTable(); paintDetail();
    return [el('p', { class: 'hint', text: _t("每格是當週到期的未完成項目預估工時合計（跨所有專案與一般卡），上限 {0} 小時；括號是未填預估的項目數（以 {1} 小時計）。點格子看是哪些專案疊在一起。上限在後台「設定 → 待辦看板」調整。", limit, a.default_hours) }),
      a.load.length ? el('div', { class: 'pj-tw' }, table) : el('p', { class: 'hint', text: _t('這段期間沒有指派給人的到期項目。') }), detail];
  }
  /** Shared windows and cross-project dependencies: where projects get in each other's way. */
  function linksView(a) {
    const KIND = { outage: _t('停電'), maintenance: _t('維護窗口'), freeze: _t('變更凍結期') };
    const wins = a.windows.map(w => el('div', { class: 'pj-win' + (w.clash ? ' clash' : '') },
      el('div', {}, el('b', { text: w.title }), el('div', { class: 'hint', text: `${KIND[w.kind] || w.kind} · ${md(w.from)}${w.to !== w.from ? '–' + md(w.to) : ''} · ${w.kind === 'freeze' ? _t('不可排變更') : _t("可容納 {0} 個專案", w.capacity)}` })),
      el('div', { class: 'pj-win-users' }, ...(w.users.length ? w.users.map(u => el('span', {}, el('span', { class: 'pj-kind proj', text: titleOf(u.project || u.card) }), ` ${u.title}${u.who ? `（${u.who}）` : ''}`)) : [el('span', { class: 'hint', text: _t('沒有工作使用') })]),
        el('span', { class: 'pj-flag' + (w.clash ? '' : ' ok'), text: w.clash ? (w.kind === 'freeze' ? _t('衝突：排進凍結期') : _t("衝突：{0} 個專案搶用", w.projects)) : _t('正常') }))));
    const xd = a.problems.filter(p => p.type === 'xdep');
    const links = xd.map(p => {
      const row = el('button', { type: 'button', class: 'pj-chain' }, el('span', { class: 'pj-kind proj', text: p.card_title }), el('b', { text: p.title }), el('span', { text: p.text }));
      row.addEventListener('click', () => { const c = TTBoard.tasks.find(t => t.id === p.card); if (c) TTBoard.openNavigator(c); });
      return row;
    });
    return [el('h3', { class: 'pj-h3', text: _t('共用時段') }),
      ...(wins.length ? wins : [el('p', { class: 'hint', text: _t('還沒有設定共用時段：在後台「設定 → 待辦看板 → 共用時段」新增停電、維護窗口或凍結期。') })]),
      el('h3', { class: 'pj-h3', text: _t("跨專案前置延誤（{0}）", xd.length) }),
      ...(links.length ? links : [el('p', { class: 'hint', text: _t('目前沒有：前置任務在別的專案而且延誤時，會列在這裡並通知後續的負責人。') })])];
  }

  // ---------------------------------------------------------------- one project
  async function renderProject(view, id, tab = 'gantt') {
    view.replaceChildren(el('p', { class: 'hint', text: _t('載入中…') }));
    await TTBoard.load().catch(() => {});
    const card = () => TTBoard.tasks.find(t => t.id === id);
    if (!card()) { view.replaceChildren(el('p', { class: 'hint', text: _t('找不到這個專案，或你沒有權限看到它。') })); return; }
    const head = el('div', { class: 'pj-head' });
    const strip = el('div', { class: 'pj-strip' });
    const tabs = el('div', { class: 'pj-tabs', role: 'tablist' });
    const pane = el('div', { class: 'pj-pane' });
    view.replaceChildren(head, strip, tabs, pane);
    let gantt = null;
    const attached = () => TTBoard.tasks.filter(t => t.project_id === id && !isProject(t));
    async function paintHead() {
      if (!head.isConnected) return;
      const c = card();
      if (!c) return;
      const a = await TTBoard.projectAnalysis().catch(() => null);
      const p = a?.projects.find(x => x.id === id);
      const edit = el('button', { class: 'btn', type: 'button', html: svg('edit') + _t('編輯專案卡') });
      edit.addEventListener('click', () => TTBoard.openEditor(c));
      const xls = el('button', { class: 'btn', type: 'button', html: svg('download') + _t('Excel 報告') });
      xls.addEventListener('click', () => TTBoard.exportReport([id, ...attached().map(t => t.id)]));
      const nav = el('button', { class: 'btn', type: 'button', html: svg('layout') + _t('任務視窗') });
      nav.addEventListener('click', () => TTBoard.openNavigator(c));
      // my notifications for this project: all / only mine / a daily summary / off
      const bell = el('select', { class: 'select pj-watch', 'aria-label': _t('這個專案的通知'), title: _t('每天在「每日提醒時間」送出：落後基準線、跨專案前置延誤、時段衝突、3 天內到期的里程碑') },
        ...[['all', _t('通知：全部')], ['mine', _t('通知：只跟我有關')], ['digest', _t('通知：每日摘要')], ['off', _t('通知：關閉')]].map(([v, l]) => el('option', { value: v, text: l })));
      api(`/api/tasks/${id}/watch`).then(w => { bell.value = w.mode; bell.title += w.default ? _t("\n（目前是預設值：{0}）", w.lead ? _t('負責人預設「全部」') : _t('參與者預設「只跟我有關」')) : ''; }).catch(() => { bell.hidden = true; });
      bell.addEventListener('change', async () => {
        try { await api(`/api/tasks/${id}/watch`, { method: 'PUT', body: { mode: bell.value } }); toast(_t('已更新這個專案的通知設定'), 'success'); }
        catch (e) { toast(e.message, 'error'); }
      });
      head.replaceChildren(
        el('div', { class: 'pj-title' }, el('span', { class: 'pj-kicker', text: _t("L1 // 專案{0}", p?.rank ? _t(" · 排序 #{0}", p.rank) : '') }),
          el('h1', { text: c.title }),
          el('p', { class: 'page-desc', text: [c.owner ? _t("負責 {0}", TT.nameOf(c.owner)) : '', c.start_at || c.due_at ? `${md(c.start_at)} – ${md(c.due_at)}` : '', c.base_due ? _t("基準線結案 {0}", md(c.base_due)) : _t('尚未設定基準線')].filter(Boolean).join(' · ') })),
        el('div', { class: 'pj-stats' },
          el('div', { class: 'pj-stat' }, el('b', { text: `${p?.pct ?? 0}%` }), el('span', { text: _t('完成度') })),
          el('div', { class: 'pj-stat' + ((p?.slip || 0) > 0 ? ' bad' : '') }, el('b', { text: p?.slip == null ? '—' : _t("{0}{1} 天", p.slip > 0 ? '+' : '', p.slip) }), el('span', { text: _t('相對基準線') })),
          el('div', { class: 'pj-stat' }, el('b', { text: p?.next ? md(p.next.due) : '—' }), el('span', { text: p?.next ? `◆ ${p.next.title}` : _t('下個里程碑') })),
          el('div', { class: 'pj-stat' + (p?.problem_items ? ' bad' : '') }, el('b', { text: p?.problem_items ?? 0 }), el('span', { text: _t('有問題的項目') }))),
        el('div', { class: 'pj-actions' }, bell, nav, edit, xls));
      // what needs me elsewhere — no need to leave this page to find out
      const mine = await myItems();
      const T = todayN();
      const elsewhere = mine.filter(x => x.due && day(x.due) <= T && !x.src.includes(c.title));
      strip.replaceChildren(...(elsewhere.length ? [el('span', { class: 'pj-strip-l', text: _t('其他地方') }),
        el('a', { href: '#/mine', text: _t("你在其他地方還有 {0} 項今天到期或逾期", elsewhere.length) })] : []));
      strip.hidden = !elsewhere.length;
    }
    function paintTabs() {
      tabs.replaceChildren(...[['gantt', _t('甘特圖')], ['board', _t('專案看板')], ['list', _t('清單')]].map(([k, l]) => {
        const b = el('button', { class: 'pj-tab', type: 'button', role: 'tab', 'aria-selected': String(tab === k), text: l });
        b.addEventListener('click', () => { tab = k; paintTabs(); paintPane(); });
        return b;
      }));
    }
    async function paintPane() {
      if (tab === 'gantt') {
        if (!gantt || !pane.contains(gantt.host)) { pane.replaceChildren(); const box = el('div'); pane.append(box); gantt = TTGantt.mount(box, { project: id }); gantt.host = box; }
        return;
      }
      gantt = null;
      const rows = (await TTBoard.ganttRows().catch(() => [])).filter(r => r.card === id || attached().some(t => t.id === r.card));
      const byId = new Map(rows.map(r => [r.id, r]));
      const pathOf = r => { const p = []; for (let c = r, n = 0; c && n < 5; c = c.parent ? byId.get(c.parent) : null, n++) p.unshift(c.id); return p; };
      const phaseOf = r => { let c = r; while (c?.parent && byId.get(c.parent)) c = byId.get(c.parent); return c?.card === id ? c.title : (TTBoard.tasks.find(t => t.id === c?.card)?.title || ''); };
      const T = todayN();
      if (tab === 'board') {
        const items = rows.filter(r => !r.milestone).map(r => ({ r, lv: pathOf(r).length + 1, phase: phaseOf(r), card: TTBoard.tasks.find(t => t.id === r.card) }));
        const ops = attached().filter(t => !rows.some(r => r.card === t.id));
        const cols = ['new', 'ongoing', 'pending', 'onhold', 'complete'];
        const board = el('div', { class: 'kb pj-kb' }, ...cols.map(s => {
          const list = items.filter(x => (x.r.status === 'canceled' ? 'complete' : x.r.status) === s);
          const opsHere = ops.filter(t => t.status === s);
          const col = el('section', { class: 'kb-col', style: { '--st': st(s).color }, dataset: { status: s } },
            el('header', { class: 'kb-col-head' }, el('span', { class: 'kb-dot' }), el('span', { class: 'kb-name' }, el('strong', { text: st(s).label }), el('span', { class: 'kb-zh', text: st(s).zh })),
              el('span', { class: 'kb-count', text: list.length + opsHere.length })));
          const box = el('div', { class: 'kb-list' });
          [...list.map(x => {
            const late = x.r.due_at && day(x.r.due_at) < T && !CLOSED.has(x.r.status);
            const c = el('article', { class: 'kb-card pj-item', draggable: 'true', tabindex: '0', dataset: { sid: x.r.id } },
              el('div', { class: 'kb-card-title' }, el('span', { text: x.r.title })),
              el('div', { class: 'kb-chips' }, el('span', { class: 'kb-chip', text: `L${x.lv}` }), x.phase && x.lv > 2 ? el('span', { class: 'kb-chip pj-phase', text: x.phase }) : null,
                x.r.due_at ? el('span', { class: 'kb-chip' + (late ? ' due-overdue' : ''), text: late ? _t("逾期 {0} 天", T - day(x.r.due_at)) : _t("{0} 到期", md(x.r.due_at)) }) : null),
              x.r.assignee ? el('div', { class: 'hint', text: x.r.assignee.name }) : null);
            c.addEventListener('click', () => TTBoard.openNavigator(x.card, pathOf(x.r)));
            c.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', 's:' + x.r.id); });
            return c;
          }), ...opsHere.map(t => {
            const c = el('article', { class: 'kb-card pj-item', draggable: 'true', tabindex: '0' },
              el('div', { class: 'kb-card-title' }, el('span', { text: t.title })), el('div', { class: 'kb-chips' }, el('span', { class: 'kb-chip', text: _t('一般卡') }),
                t.due_at ? el('span', { class: 'kb-chip', text: _t("{0} 到期", md(t.due_at)) }) : null));
            c.addEventListener('click', () => TTBoard.openEditor(t));
            c.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', 't:' + t.id); });
            return c;
          })].forEach(x => box.append(x));
          if (!box.children.length) box.append(el('div', { class: 'kb-empty', text: _t('拖曳到這裡') }));
          col.append(box);
          col.addEventListener('dragover', e => { e.preventDefault(); col.classList.add('drop-over'); });
          col.addEventListener('dragleave', e => { if (!col.contains(e.relatedTarget)) col.classList.remove('drop-over'); });
          col.addEventListener('drop', async e => {
            e.preventDefault(); col.classList.remove('drop-over');
            const [k, v] = (e.dataTransfer.getData('text/plain') || '').split(':');
            try {
              if (k === 's') { const r = byId.get(+v); await api(`/api/tasks/${r.card}/comments/${r.id}/task`, { method: 'PUT', body: { status: s } }); }
              else if (k === 't') await TTBoard.save(+v, { status: s });
              await TTBoard.load(true);
              await TTBoard.ganttRows(true);
              paintPane(); paintHead();
            } catch (err) { toast(err.message, true); }
          });
          return col;
        }));
        pane.replaceChildren(el('p', { class: 'hint', text: _t('這個專案的各層工作（L2 以下）與歸屬的一般卡，依狀態分欄；拖到其他欄改狀態，上層狀態會自動彙總。') }), board);
      } else {
        // list with WBS numbers (the same numbering as the Excel report)
        const kids = new Map();
        rows.filter(r => r.card === id).forEach(r => { const k = r.parent || 0; if (!kids.has(k)) kids.set(k, []); kids.get(k).push(r); });
        const out = [];
        const walk = (pid, prefix, depth) => (kids.get(pid) || []).forEach((r, i) => { const n = prefix ? `${prefix}.${i + 1}` : `${i + 1}`; out.push({ r, n, depth }); walk(r.id, n, depth + 1); });
        walk(0, '', 1);
        attached().forEach(t => out.push({ r: { id: 't' + t.id, title: t.title, status: t.status, start_at: t.start_at, due_at: t.due_at, assignee: (t.assignees || [])[0] ? { id: t.assignees[0].id, name: TT.nameOf(t.assignees[0]) } : null, estimate: null, ops: t }, n: '↳', depth: 1 }));
        const myId = me();
        pane.replaceChildren(el('div', { class: 'pj-tw' }, el('table', { class: 'pj-table' },
          el('thead', {}, el('tr', {}, ...['WBS', _t('項目'), _t('負責'), _t('開始'), _t('到期'), _t('預估'), _t('狀態')].map(h => el('th', { text: h })))),
          el('tbody', {}, ...out.map(({ r, n, depth }) => {
            const late = r.due_at && day(r.due_at) < T && !CLOSED.has(r.status);
            const tr = el('tr', { class: 'pj-row' + (r.assignee && r.assignee.id === myId ? ' mine' : ''), tabindex: '0' },
              el('td', { class: 'n', text: n }),
              el('td', {}, el('span', { style: { paddingLeft: `${(depth - 1) * 16}px` } }, r.milestone ? '◆ ' : '', depth === 1 ? el('b', { text: r.title }) : r.title, r.ops ? el('span', { class: 'hint', text: _t('（一般卡）') }) : null)),
              el('td', { text: r.assignee?.name || '—' }), el('td', { class: 'n', text: r.milestone ? '' : md(r.start_at) }), el('td', { class: 'n', text: md(r.due_at) }),
              el('td', { class: 'n', text: r.estimate ? `${+(r.estimate / 60).toFixed(1)}h` : '—' }), el('td', {}, stChip(r.status, late)));
            tr.addEventListener('click', () => r.ops ? TTBoard.openEditor(r.ops) : TTBoard.openNavigator(card(), pathOf(r)));
            return tr;
          })))), el('p', { class: 'hint', text: _t('底色標出指派給你的項目；WBS 編號與 Excel 報告相同。') }));
      }
    }
    paintHead(); paintTabs(); paintPane();
    const onChange = () => { if (!head.isConnected) { document.removeEventListener('tt:tasks', onChange); document.removeEventListener('tt:analysis', onAna); return; } if (tab !== 'gantt') paintPane(); };
    const onAna = () => { if (head.isConnected) paintHead(); };
    document.addEventListener('tt:tasks', onChange);
    document.addEventListener('tt:analysis', onAna);
  }

  window.TTProjects = { renderMine, renderProjects, renderProject, mineCounts, myItems };
})();
