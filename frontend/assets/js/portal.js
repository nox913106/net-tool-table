/* =============================================================================
   IPMS — portal
   Everything on screen comes from /api/settings, /api/nodes/tree, /api/auth-links.

   Routes (hash):
     #/                 home (sections configured in admin → 首頁版面)
     #/f/<id>           folder
     #/search/<q>       search results
     #/icon/<file>      quick filter (all links using an icon)
     #/favorites        my favourites  (per browser)
     #/recent           recently opened (per browser)
   ============================================================================= */
'use strict';

(() => {
  const { el, svg, esc, tile, api, store, hostOf } = TT;
  const $ = id => document.getElementById(id);

  const state = {
    settings: {},
    tree: [],
    byId: new Map(),
    parent: new Map(),
    quickLinks: [],
    expanded: new Set(store.get('expanded', [])),
    view: store.get('view') || null,     // grid | list (viewer override)
  };

  // ======================================================================
  // Boot
  // ======================================================================
  document.addEventListener('DOMContentLoaded', async () => {
    const mePending = TT.me();
    try {
      state.settings = await api('/api/settings');
    } catch {
      state.settings = {};
    }
    state.me = await mePending;
    const s = state.settings;
    TTI18n.site(s.language || 'zh-TW');
    TT.applyAppearance(s);
    applyBranding();
    setupChrome();

    try {
      const [tree, links] = await Promise.all([api('/api/nodes/tree'), api('/api/auth-links').catch(() => [])]);
      indexTree(tree);
      state.quickLinks = links;
    } catch (e) {
      $('view').replaceChildren(emptyState('⚠️', _t('無法讀取資料'), e.message));
      return;
    }

    buildNav();
    buildTree();
    buildFilters();
    if (s.show_clock !== false) TTClock.mount($('clock'), s);
    TTClock.mountNetInfo($('netinfo'), s);
    TTClock.secretAdmin($('clock'), $('brand-mark'));
    // adding links: administrators (public area) and everyone signed in (their own personal area)
    if (s.allow_drop_add !== false && (state.me.is_admin || personalOn())) setupLinkDrop();
    $('personal-add').innerHTML = svg('plus');
    $('personal-add').addEventListener('click', () => personalMenu(null));
    TT.userMenu($('user-menu'));
    guestNotice();
    if (boardOn()) { TTBoard.init(s); TTBoard.mountBell($('bell-btn')); if (window.TTRadar) TTRadar.float(); }

    window.addEventListener('hashchange', route);
    route();
  });

  function indexTree(tree) {
    state.tree = tree;
    state.treeSig = JSON.stringify(tree);
    state.byId.clear();
    state.parent.clear();
    const walk = (nodes, parent) => nodes.forEach(n => {
      state.byId.set(n.id, n);
      state.parent.set(n.id, parent);
      walk(n.children || [], n);
    });
    walk(tree, null);
  }

  const isFolder = n => n.node_type === 'folder';
  /** 個人區: everyone signed in on the server; on a standalone copy once it is linked to a server */
  const personalOn = () => state.me?.user?.id != null && !isGuest();
  /** 訪客: an AD account no administrator has given a level yet — the public links only, and how to get access */
  const isGuest = () => !!state.me?.guest;
  const publicRoots = () => state.tree.filter(n => !n.personal);
  const personalRoots = () => state.tree.filter(n => n.personal);
  const sideRow = id => document.querySelector(`#sidebar .tree-row[data-id="${id}"]`);
  const pathOf = n => {
    const out = [];
    for (let p = state.parent.get(n.id); p; p = state.parent.get(p.id)) out.unshift(p);
    return out;
  };
  const allNodes = () => [...state.byId.values()];
  const viewMode = () => state.view || state.settings.default_view || 'grid';
  const newTabFor = n => n.new_tab ?? state.settings.open_links_in_new_tab ?? true;
  /** inherited accent: the node's own color, else the nearest ancestor's */
  const colorOf = n => {
    for (let p = n; p; p = state.parent.get(p.id)) if (p.color) return p.color;
    return null;
  };

  // ======================================================================
  // Chrome: branding, header buttons, sidebar, keyboard
  // ======================================================================
  function applyBranding() {
    const s = state.settings;
    document.title = s.site_title || 'IPMS';
    $('brand-title').textContent = s.site_title || 'IPMS';
    $('brand-subtitle').textContent = _t(s.site_subtitle || '');
    $('brand-subtitle').hidden = !s.site_subtitle;
    $('brand-mark').replaceChildren(tile({ icon: s.favicon || '', name: s.site_title || 'T', size: 36 }));
    if (s.favicon) TT.setFavicon(s.favicon);
    $('search-trigger-text').textContent = _t(s.search_placeholder || '搜尋…');
    $('palette-input').placeholder = _t(s.search_placeholder || '搜尋…');
    $('admin-btn').hidden = !s.show_admin_button || !state.me?.is_admin;
  }

  /**
   * Sidebar: phones → slide-in drawer; desktop → full width or a collapsed icon rail.
   * Collapsed rail opens as an overlay while hovered / focused / while a link is dragged over it.
   */
  function setupSidebar() {
    const s = state.settings;
    const btn = $('menu-btn');
    const bar = $('sidebar');
    const phone = matchMedia('(max-width: 900px)');
    const collapsed = () => document.body.classList.contains('nav-collapsed');
    const paint = () => {
      const c = collapsed();
      btn.innerHTML = svg(phone.matches ? 'menu' : c ? 'sidebar-open' : 'sidebar');
      btn.title = phone.matches ? _t('開啟選單') : _t("{0}側邊欄（Ctrl+B）", c ? _t('展開') : _t('收合'));
      btn.setAttribute('aria-expanded', String(phone.matches ? document.body.classList.contains('nav-open') : !c));
    };
    const setCollapsed = (v, save = true) => {
      document.body.classList.toggle('nav-collapsed', v);
      bar.classList.remove('peek');
      if (save) store.set('sidebar', v ? 'collapsed' : 'expanded');
      paint();
    };
    setCollapsed((store.get('sidebar') || s.sidebar_default) === 'collapsed', false);
    phone.addEventListener('change', paint);
    btn.addEventListener('click', () => {
      if (phone.matches) { document.body.classList.toggle('nav-open'); paint(); }
      else setCollapsed(!collapsed());
    });

    // "trigger": the rail opens on its own while you point at it
    let timer = null;
    const peek = (on, delay) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (on && !(collapsed() && !phone.matches)) return;
        bar.classList.toggle('peek', on);
      }, delay);
    };
    if (s.sidebar_hover_expand !== false) {
      bar.addEventListener('mouseenter', () => peek(true, 140));
      bar.addEventListener('mouseleave', () => peek(false, 280));
      bar.addEventListener('focusin', () => peek(true, 0));
      bar.addEventListener('focusout', e => { if (!bar.contains(e.relatedTarget)) peek(false, 0); });
    }
    // dragging a link onto the rail opens it so folders can be targeted
    bar.addEventListener('dragenter', () => { if (collapsed()) peek(true, 0); });
    bar.addEventListener('dragleave', e => { if (!bar.contains(e.relatedTarget)) peek(false, 200); });
    document.addEventListener('drop', () => peek(false, 0));
    document.addEventListener('dragend', () => peek(false, 0));
    // after picking a folder in the overlay, let it close
    bar.addEventListener('click', e => { if (e.target.closest('a.tree-row, a.nav-item') && bar.classList.contains('peek') && s.sidebar_hover_expand === false) peek(false, 0); });
  }

  function setupChrome() {
    $('search-trigger-icon').innerHTML = svg('search');
    $('palette-icon').innerHTML = svg('search');
    $('admin-btn').innerHTML = svg('settings');
    $('mod-key').textContent = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';

    const themeBtn = $('theme-btn');
    const paintTheme = () => {
      const pref = TT.themePref(state.settings);
      themeBtn.innerHTML = svg(pref === 'auto' ? 'monitor' : pref === 'light' ? 'sun' : 'moon');
      themeBtn.title = _t("主題：{0}（點擊切換）", { auto: _t('跟隨系統'), light: _t('淺色'), dark: _t('深色') }[pref]);
    };
    themeBtn.addEventListener('click', () => { TT.cycleTheme(state.settings); paintTheme(); });
    paintTheme();

    const perfBtn = $('perf-btn');
    const paintPerf = () => {
      const low = document.documentElement.dataset.perf === 'low';
      perfBtn.innerHTML = svg(low ? 'zap-off' : 'zap');
      perfBtn.title = low ? _t('省資源模式（點擊恢復動畫效果）') : _t('一般模式（點擊切換省資源模式）');
    };
    perfBtn.addEventListener('click', () => { TT.togglePerf(); paintPerf(); });
    themeBtn.before(TT.langButton());
    paintPerf();

    const installBtn = $('install-btn');
    if (installBtn) {
      installBtn.innerHTML = svg('download');
      TT.onInstallable(ok => { installBtn.hidden = !ok; });
      installBtn.addEventListener('click', () => TT.installApp());
    }

    setupSidebar();
    $('scrim').addEventListener('click', () => document.body.classList.remove('nav-open'));
    $('search-trigger').addEventListener('click', openPalette);

    document.addEventListener('keydown', e => {
      const typing = /input|textarea|select/i.test(document.activeElement.tagName);
      if ((e.key === 'k' || e.key === 'K') && (e.ctrlKey || e.metaKey)) { e.preventDefault(); openPalette(); }
      else if (e.key === '/' && !typing) { e.preventDefault(); openPalette(); }
      else if (e.key === 'Escape' && document.body.classList.contains('nav-open')) document.body.classList.remove('nav-open');
      else if ((e.key === 'b' || e.key === 'B') && (e.ctrlKey || e.metaKey) && !typing) { e.preventDefault(); $('menu-btn').click(); }
    });

    // Record "recently opened" for any link card / row / chip in the page
    const record = e => {
      const a = e.target.closest('a[data-node]');
      if (a && !e.target.closest('.fav-btn')) pushRecent(Number(a.dataset.node));
    };
    document.addEventListener('click', record);
    document.addEventListener('auxclick', record);

    // Local programs (portable edition): clicking launches instead of navigating
    document.addEventListener('click', e => {
      const a = e.target.closest('a[data-launch]');
      if (!a || e.target.closest('.fav-btn')) return;
      e.preventDefault();
      const node = state.byId.get(Number(a.dataset.launch));
      if (node) TT.launchProgram(node);
    });

    setupPalette();
  }

  // ======================================================================
  // Favourites & recent (per browser)
  // ======================================================================
  const favorites = () => store.get('favorites', []).filter(id => state.byId.has(id));
  const isFav = id => store.get('favorites', []).includes(id);
  function toggleFav(id) {
    const list = store.get('favorites', []);
    const i = list.indexOf(id);
    if (i >= 0) list.splice(i, 1); else list.push(id);
    store.set('favorites', list);
    TT.toast(i >= 0 ? _t('已從最愛移除') : _t('已加入最愛 ★'));
    buildNav();
    // refresh views that show favourites
    if (/^#\/(favorites)?$/.test(location.hash || '#/') || !location.hash) route();
    else document.querySelectorAll(`.fav-btn[data-id="${id}"]`).forEach(b => b.classList.toggle('on', i < 0));
  }
  function pushRecent(id) {
    if (state.settings.enable_recent === false || !state.byId.has(id)) return;
    const list = store.get('recent', []).filter(r => r.id !== id);
    list.unshift({ id, t: Date.now() });
    store.set('recent', list.slice(0, 30));
  }
  const recent = (limit = 30) => store.get('recent', []).map(r => state.byId.get(r.id)).filter(Boolean).slice(0, limit);

  // ======================================================================
  // Sidebar
  // ======================================================================
  function buildNav() {
    const s = state.settings;
    const items = [
      { href: '#/', icon: 'home', label: _t('首頁') },
      s.enable_favorites !== false && { href: '#/favorites', icon: 'star', label: _t('我的最愛'), count: favorites().length },
      s.enable_recent !== false && { href: '#/recent', icon: 'history', label: _t('最近使用') },
      boardOn() && { href: '#/mine', icon: 'user', label: _t('我的工作'), mine: true },
      boardOn() && { href: '#/board', icon: 'kanban', label: _t('待辦看板'), board: true },
      boardOn() && { href: '#/projects', icon: 'layout', label: _t('專案總覽'), projects: true },
      boardOn() && { href: '#/history', icon: 'archive', label: _t('歷史區') },
      window.TTHelp && { href: '#/help', icon: 'help', label: _t('使用說明') },
    ].filter(Boolean);
    $('nav-main').replaceChildren(...items.map(it =>
      el('a', { class: 'nav-item', href: it.href, title: it.label, dataset: { route: it.href } },
        el('span', { class: 'nav-icon', html: svg(it.icon) }),
        el('span', { class: 'nav-label', text: it.label }),
        it.count ? el('span', { class: 'badge', text: it.count }) : null,
        it.board ? el('span', { class: 'badge badge-alert', dataset: { boardBadge: '' }, hidden: true, title: _t('需要注意的待辦') }) : null,
        it.mine ? el('span', { class: 'badge badge-alert', dataset: { mineBadge: '' }, hidden: true }) : null,
        it.projects ? el('span', { class: 'badge badge-alert', dataset: { projBadge: '' }, hidden: true }) : null)));
    paintNavCounts();
  }
  /** Sidebar counts that point at the other pages: my overdue / due today, projects behind or with problems. */
  let navTimer = null;
  function paintNavCounts() {
    clearTimeout(navTimer);
    navTimer = setTimeout(async () => {
      if (!boardOn() || typeof TTProjects === 'undefined') return;
      const mine = document.querySelector('[data-mine-badge]'), proj = document.querySelector('[data-proj-badge]');
      try {
        const c = await TTProjects.mineCounts();
        if (mine) { const n = c.late + c.today; mine.hidden = !n; mine.textContent = n; mine.title = _t("{0} 項逾期、{1} 項今天到期", c.late, c.today); }
        const a = await TTBoard.projectAnalysis();
        const bad = a.projects.filter(x => x.problem_items || (x.slip || 0) > 0).length;
        if (proj) { proj.hidden = !bad; proj.textContent = bad; proj.title = _t("{0} 個專案落後或有問題", bad); }
      } catch (e) { /* not signed in yet */ }
    }, 400);
  }
  document.addEventListener('tt:tasks', paintNavCounts);
  document.addEventListener('tt:analysis', paintNavCounts);
  const boardOn = () => state.settings.board_enabled !== false && typeof TTBoard !== 'undefined' && !isGuest();

  function buildTree() {
    const s = state.settings;
    const showLinks = !!s.sidebar_show_links;
    const showIcons = s.sidebar_show_icons !== false;
    const showCounts = s.sidebar_show_counts !== false;

    const render = (nodes, depth, links = showLinks) => {
      const frag = document.createDocumentFragment();
      nodes.forEach(n => {
        const folder = isFolder(n);
        if (!folder && !links) return;
        const kids = (n.children || []).filter(c => links || isFolder(c));
        const hasKids = folder && kids.length > 0;
        const open = state.expanded.has(n.id);

        const program = !folder && TT.isProgram(n.url);
        const row = el('a', {
          class: 'tree-row' + (folder ? '' : ' is-link'),
          href: folder ? `#/f/${n.id}` : program ? '#' : n.url,
          role: 'treeitem',
          title: n.name,
          'aria-expanded': hasKids ? String(open) : null,
          dataset: folder ? { id: n.id, dropFolder: n.id }
            : { node: n.id, launch: program ? n.id : null, dropFolder: state.parent.get(n.id)?.id ?? null },
          target: !folder && !program && newTabFor(n) ? '_blank' : null,
          rel: !folder ? 'noopener' : null,
          style: { '--depth': depth },
        });
        const caret = el('span', { class: 'tree-caret' + (hasKids ? '' : ' no-kids'), html: hasKids ? svg('chevron-right') : '' });
        if (hasKids) caret.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); toggleExpand(n.id); });
        row.append(caret);
        if (showIcons) row.append(tile({ icon: n.icon, name: n.name, color: colorOf(n), folder, size: 24 }));
        else row.append(el('span', { class: 'rail-only' }, tile({ icon: n.icon, name: n.name, color: colorOf(n), folder, size: 24 })));   // icon rail needs something to show
        row.append(el('span', { class: 'tree-label', text: n.name }));
        if (folder && showCounts && n.children?.length) row.append(el('span', { class: 'tree-count', text: n.children.length }));

        const wrap = el('div', { class: 'tree-node' + (open ? ' open' : '') }, row);
        if (hasKids) wrap.append(el('div', { class: 'tree-children', role: 'group' }, render(kids, depth + 1, links)));
        frag.append(wrap);
      });
      return frag;
    };

    const tree = $('tree');
    tree.replaceChildren(render(publicRoots(), 0));
    $('tree-section').hidden = !tree.childElementCount;
    $('tree-title').textContent = personalOn() ? _t('公用區') : _t('分類');
    $('tree-personal').replaceChildren(render(personalRoots(), 0, true));     // my own links: always listed
    if (personalOn() && !personalRoots().length)
      $('tree-personal').append(el('p', { class: 'nav-empty', text: _t('只有你看得到的連結，按 ＋ 新增') }));
    $('personal-section').hidden = !personalOn();
  }

  function toggleExpand(id, force) {
    const open = force ?? !state.expanded.has(id);
    if (open) state.expanded.add(id); else state.expanded.delete(id);
    store.set('expanded', [...state.expanded]);
    const node = sideRow(id)?.parentElement;
    if (node) {
      node.classList.toggle('open', open);
      node.firstElementChild.setAttribute('aria-expanded', String(open));
    }
  }

  function highlightNav() {
    const hash = location.hash || '#/';
    document.querySelectorAll('.nav-item').forEach(a => a.classList.toggle('active', a.dataset.route === hash || (hash.startsWith('#/help') && a.dataset.route === '#/help') || (hash === '#' && a.dataset.route === '#/') || (hash.startsWith('#/project/') && a.dataset.route === (window.TTBoard && TTBoard.find && TTBoard.find(Number(hash.split('/')[2]))?.history ? '#/history' : '#/projects'))));
    document.querySelectorAll('#sidebar .tree-row.active').forEach(r => r.classList.remove('active'));
    const m = hash.match(/^#\/f\/(\d+)/);
    if (m) {
      const node = state.byId.get(Number(m[1]));
      if (node) pathOf(node).forEach(p => toggleExpand(p.id, true));
      const row = sideRow(m[1]);
      if (row) { row.classList.add('active'); row.scrollIntoView({ block: 'nearest' }); }
    }
    document.querySelectorAll('.filter-chip').forEach(c => c.classList.toggle('active', hash === `#/icon/${encodeURIComponent(c.dataset.icon)}`));
  }

  // ---------------------------------------------------------- quick filters
  function quickFilters() {
    const s = state.settings;
    if (s.show_quick_filters === false) return [];
    const configured = (s.quick_filters || []).filter(f => f && f.icon);
    if (configured.length) return configured.map(f => ({ icon: f.icon, label: f.label || prettyIcon(f.icon) }));
    const counts = new Map();
    allNodes().forEach(n => { if (n.icon && !isFolder(n)) counts.set(n.icon, (counts.get(n.icon) || 0) + 1); });
    return [...counts].filter(([, c]) => c >= 2).sort((a, b) => b[1] - a[1])
      .slice(0, s.quick_filters_auto_limit || 8).map(([icon]) => ({ icon, label: prettyIcon(icon) }));
  }
  const prettyIcon = f => TT.isIconFile(f)
    ? f.replace(/\.[^.]+$/, '').replace(/[-_](icon|logo|color)$/i, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    : f;

  function buildFilters() {
    const list = quickFilters();
    $('filters-section').hidden = !list.length;
    $('filters-title').textContent = _t(state.settings.quick_filters_title || '快速篩選');
    $('filters').replaceChildren(...list.map(f =>
      el('a', { class: 'chip filter-chip', href: `#/icon/${encodeURIComponent(f.icon)}`, dataset: { icon: f.icon } },
        tile({ icon: f.icon, name: f.label, size: 18 }), f.label)));
  }

  // ======================================================================
  // Router
  // ======================================================================
  function route() {
    // app shortcut "搜尋" (right-click the taskbar icon of the installed app)
    if (location.hash === '#search') { history.replaceState(null, '', '/'); setTimeout(openPalette, 50); }
    const hash = decodeURIComponent(location.hash || '#/');
    const view = $('view');
    const open = currentFolder();
    if (open) view.dataset.dropFolder = open.id; else delete view.dataset.dropFolder;
    let m;
    document.body.classList.remove('nav-open');
    if (typeof TTBoard !== 'undefined' && TTBoard.selecting) TTBoard.setSelecting(false);   // leave select mode with the page

    if ((m = hash.match(/^#\/f\/(\d+)/)) && state.byId.has(Number(m[1]))) renderFolder(state.byId.get(Number(m[1])));
    else if ((m = hash.match(/^#\/search\/(.+)/))) renderSearch(m[1]);
    else if ((m = hash.match(/^#\/icon\/(.+)/))) renderIconFilter(m[1]);
    else if (hash === '#/favorites') renderFavorites();
    else if (hash === '#/recent') renderRecent();
    else if ((m = hash.match(/^#\/board(?:\?(.*))?$/)) && boardOn()) renderBoard(new URLSearchParams(m[1] || ''));
    else if (hash === '#/mine' && boardOn() && window.TTProjects) TTProjects.renderMine(view);
    else if (hash === '#/projects' && boardOn() && window.TTProjects) TTProjects.renderProjects(view);
    else if ((m = hash.match(/^#\/project\/(\d+)/)) && boardOn() && window.TTProjects) TTProjects.renderProject(view, Number(m[1]));
    else if (hash === '#/history' && boardOn() && window.TTProjects) TTProjects.renderHistory(view);
    else if ((m = hash.match(/^#\/help(?:\/([\w-]+))?$/)) && window.TTHelp) TTHelp.render(view, m[1]);
    else if ((m = hash.match(/^#\/card\/(\d+)/)) && boardOn()) {          // a link from Teams: the board, with the card open
      const id = Number(m[1]);
      history.replaceState(null, '', '#/board');
      renderBoard();
      TTBoard.load().then(() => TTBoard.openTask(id)).catch(() => {});
    }
    else renderHome();

    highlightNav();
    view.classList.remove('enter');
    void view.offsetWidth;
    view.classList.add('enter');
    window.scrollTo({ top: 0 });
  }

  // ======================================================================
  // Building blocks
  // ======================================================================
  function emptyState(icon, title, text, action) {
    return el('div', { class: 'empty' },
      el('div', { class: 'empty-icon', text: icon }),
      el('h3', { text: title }),
      text ? el('p', { text }) : null,
      action || null);
  }

  function favButton(n) {
    if (state.settings.enable_favorites === false) return null;
    const b = el('button', {
      class: 'fav-btn' + (isFav(n.id) ? ' on' : ''), type: 'button', dataset: { id: n.id },
      title: _t('加入 / 移除最愛'), 'aria-label': _t('加入或移除最愛'), html: svg('star'),
    });
    b.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); toggleFav(n.id); });
    return b;
  }

  /** Card (grid) or row (list) for one node */
  function card(n, { mode = viewMode(), showPath = false } = {}) {
    const s = state.settings;
    const folder = isFolder(n);
    const program = !folder && TT.isProgram(n.url);
    const color = colorOf(n);
    const where = program ? TT.programPath(n.url) : n.url;
    const a = el('a', {
      class: `card ${mode === 'list' ? 'card-row' : 'card-tile'} ${folder ? 'is-folder' : 'is-link'}${program ? ' is-program' : ''}`,
      href: folder ? `#/f/${n.id}` : program ? '#' : n.url,
      dataset: folder ? { dropFolder: n.id } : program ? { node: n.id, launch: n.id } : { node: n.id },
      target: !folder && !program && newTabFor(n) ? '_blank' : null,
      rel: !folder ? 'noopener' : null,
      title: !folder ? [n.name, n.description, program ? _t("本機程式：{0}", where) : where].filter(Boolean).join('\n') : n.name,
    });
    if (color) a.style.setProperty('--card-color', color);

    a.append(tile({ icon: n.icon, name: n.name, color, folder, size: mode === 'list' ? 34 : 46 }));

    const body = el('div', { class: 'card-body' }, el('div', { class: 'card-title', text: n.name }));
    if (s.show_descriptions !== false && n.description) body.append(el('div', { class: 'card-desc', text: n.description }));
    if (showPath) {
      const p = pathOf(n).map(x => x.name).join(' › ');
      if (p) body.append(el('div', { class: 'card-meta', text: p }));
    } else if (program && s.show_link_host !== false) {
      body.append(el('div', { class: 'card-meta', text: _t("本機程式 · {0}", where.split(/[\\/]/).pop()) }));
    } else if (!folder && s.show_link_host !== false && hostOf(n.url)) {
      body.append(el('div', { class: 'card-meta', text: hostOf(n.url) }));
    }
    if (folder) {
      const kids = n.children || [];
      const folders = kids.filter(isFolder).length;
      const links = kids.length - folders;
      body.append(el('div', { class: 'card-meta', text: [folders && _t("{0} 個資料夾", folders), links && _t("{0} 個連結", links)].filter(Boolean).join(' · ') || _t('空資料夾') }));
    }
    a.append(body);

    if (folder && mode !== 'list') {
      const preview = (n.children || []).slice(0, 4);
      if (preview.length) {
        a.append(el('div', { class: 'card-preview' }, preview.map(c => tile({ icon: c.icon, name: c.name, color: colorOf(c), folder: isFolder(c), size: 22 }))));
      }
    }
    if (n.personal) {
      const ed = el('button', { class: 'card-edit', type: 'button', title: _t('編輯'), 'aria-label': _t("編輯「{0}」", n.name), html: svg('edit') });
      ed.addEventListener('click', e => { e.preventDefault(); e.stopPropagation(); personalDialog({ node: n }); });
      a.append(ed);
    }
    if (folder) a.append(el('span', { class: 'card-go', html: svg('chevron-right') }));
    else {
      a.append(el('span', { class: 'card-go', html: svg(program ? 'play' : 'external') }));
      const fb = favButton(n);
      if (fb) a.append(fb);
    }
    return a;
  }

  function cardGrid(nodes, opts = {}) {
    const mode = opts.mode || viewMode();
    const g = el('div', { class: `cards ${mode === 'list' ? 'cards-list' : 'cards-grid'}${opts.compact ? ' cards-compact' : ''}` });
    nodes.forEach((n, i) => {
      const c = card(n, { ...opts, mode });
      c.style.setProperty('--i', Math.min(i, 24));
      g.append(c);
    });
    return g;
  }

  function section({ icon, title, action, body, cls = '', dropFolder = null }) {
    return el('section', { class: 'section ' + cls, dataset: dropFolder ? { dropFolder } : {} },
      el('div', { class: 'section-head' },
        el('h2', { class: 'section-title' }, sectionIcon(icon), title),
        action || null),
      body);
  }

  function sectionIcon(icon) {
    if (!icon) return null;
    if (icon instanceof Node) return el('span', { class: 'section-icon is-tile' }, icon);
    return el('span', { class: 'section-icon', html: icon.startsWith('<') ? icon : esc(icon) });
  }

  function viewToggle(onChange) {
    const seg = el('div', { class: 'segmented', role: 'group', 'aria-label': _t('顯示方式') });
    [['grid', _t('格狀')], ['list', _t('清單')]].forEach(([m, label]) => {
      const b = el('button', { type: 'button', 'aria-pressed': String(viewMode() === m), title: label, html: svg(m) + `<span class="seg-label">${label}</span>` });
      b.addEventListener('click', () => { state.view = m; store.set('view', m); onChange(); });
      seg.append(b);
    });
    return seg;
  }

  function breadcrumb(items) {
    const nav = el('nav', { class: 'crumbs', 'aria-label': _t('路徑') },
      el('a', { href: '#/', html: svg('home') + _t('<span>首頁</span>') }));
    items.forEach((it, i) => {
      nav.append(el('span', { class: 'crumb-sep', html: svg('chevron-right') }));
      const last = i === items.length - 1;
      nav.append(last || !it.id ? el('span', { class: 'crumb-current', text: it.name }) : el('a', { href: `#/f/${it.id}`, text: it.name }));
    });
    return nav;
  }

  function pageHead({ crumbs, tileNode, title, desc, meta, tools }) {
    const head = el('div', { class: 'page-head' });
    if (crumbs) head.append(crumbs);
    const row = el('div', { class: 'page-title-row' });
    if (tileNode) row.append(tileNode);
    row.append(el('div', { class: 'page-title-text' },
      el('h1', { class: 'page-title', text: title }),
      desc ? el('p', { class: 'page-desc', text: desc }) : null,
      meta ? el('div', { class: 'page-meta', text: meta }) : null));
    if (tools) row.append(el('div', { class: 'page-tools' }, tools));
    head.append(row);
    return head;
  }

  // ======================================================================
  // Views
  // ======================================================================
  function greeting() {
    const h = new Date().getHours();
    return h < 5 ? _t('夜深了') : h < 11 ? _t('早安') : h < 14 ? _t('午安') : h < 18 ? _t('午後愉快') : _t('晚安');
  }

  /** The guest's notice: whom to ask for access (shown on every page until an administrator gives a level) */
  function guestNotice() {
    if (!isGuest() || document.getElementById('guest-notice')) return;
    const who = state.me.contacts || [];
    const box = el('div', { class: 'guest-notice', id: 'guest-notice', role: 'status' },
      el('span', { class: 'guest-notice-icon', html: svg('lock') }),
      el('div', { class: 'guest-notice-text' },
        el('strong', { text: _t('你的帳號目前是「訪客」，尚未開通') }),
        el('p', { text: _t('可以瀏覽入口的連結；待辦看板、專案、個人區等功能需要系統管理員把帳號開通為「使用者」或以上。請聯絡：') }),
        who.length ? el('ul', { class: 'guest-contacts' }, ...who.map(c => el('li', {},
          el('b', { text: c.name }), c.department ? el('span', { class: 'muted', text: `（${c.department}）` }) : null,
          c.email ? el('span', { class: 'guest-mail', text: c.email }) : null)))
          : el('p', { class: 'muted', text: _t('（尚未指定系統管理員，請洽資訊部門）') }),
        el('p', { class: 'muted', text: _t("請提供你的帳號：{0}", state.me.user.username) })));
    document.querySelector('.main')?.prepend(box) || $('view').before(box);
  }

  function renderHome() {
    const s = state.settings;
    const view = $('view');
    const frag = document.createDocumentFragment();

    // Hero
    const hero = el('div', { class: 'hero' },
      el('div', { class: 'hero-text' },
        el('p', { class: 'hero-kicker', text: greeting() }),
        el('h1', { class: 'hero-title', text: s.site_title || 'IPMS' }),
        s.site_subtitle ? el('p', { class: 'hero-sub', text: s.site_subtitle }) : null));
    frag.append(hero);

    if (!state.tree.length && !personalOn()) {
      frag.append(state.me?.is_admin
        ? emptyState('🧭', _t('還沒有任何項目'), _t('到管理後台建立資料夾與連結，或匯入一份 JSON 範本。'),
          el('a', { class: 'btn btn-primary', href: '/admin', html: svg('settings') + _t('前往管理後台') }))
        : emptyState('🧭', _t('還沒有任何連結'), _t('管理員還沒有在入口加入連結。')));
      view.replaceChildren(frag);
      return;
    }

    const sections = Array.isArray(s.home_sections) ? s.home_sections : [];
    sections.forEach(sec => {
      const node = renderHomeSection(sec);
      if (node) frag.append(node);
    });
    if (personalOn()) frag.append(personalSection());
    view.replaceChildren(frag);
  }

  function renderHomeSection(sec) {
    const s = state.settings;
    const compact = sec.style === 'compact';
    switch (sec.type) {
      case 'message':
        if (!s.home_message) return null;
        return el('section', { class: 'section' },
          el('div', { class: 'callout glass' },
            el('span', { class: 'callout-icon', html: svg('megaphone') }),
            el('div', { class: 'callout-body' },
              sec.title ? el('strong', { text: _t(sec.title) }) : null,
              el('p', { text: s.home_message }))));

      case 'quick_links': {
        if (!state.quickLinks.length) return null;
        const body = el('div', { class: 'quick-groups' });
        [...state.quickLinks].sort((a, b) => (!a.region) - (!b.region)).forEach(g => {
          const chips = el('div', { class: 'chip-row' }, g.items.map(it =>
            el('a', { class: 'chip quick-chip', href: it.url, target: '_blank', rel: 'noopener', title: it.url },
              el('span', { class: 'chip-dot' }), it.name)));
          body.append(g.region
            ? el('div', { class: 'quick-group' }, el('div', { class: 'quick-group-label', text: g.region }), chips)
            : chips);
        });
        return section({ icon: s.quick_links_icon || svg('zap'), title: _t(sec.title || '') || _t(s.quick_links_title || '快速連結'), body, cls: 'section-quick' });
      }

      case 'favorites': {
        if (s.enable_favorites === false) return null;
        const favs = favorites().map(id => state.byId.get(id)).slice(0, sec.limit || 12);
        const body = favs.length ? cardGrid(favs, { compact: true, mode: 'grid' })
          : el('div', { class: 'hint-card', html: _t("{0}<span>在任何連結卡片上點 <b>☆</b>，就會出現在這裡。</span>", svg('star')) });
        return section({ icon: svg('star'), title: _t(sec.title || '') || _t('我的最愛'), body,
          action: favs.length ? el('a', { class: 'section-link', href: '#/favorites', html: _t('全部') + svg('chevron-right') }) : null });
      }

      case 'recent': {
        if (s.enable_recent === false) return null;
        const list = recent(sec.limit || 8);
        if (!list.length) return null;
        return section({ icon: svg('history'), title: _t(sec.title || '') || _t('最近使用'), body: cardGrid(list, { compact: true, mode: 'grid' }),
          action: el('a', { class: 'section-link', href: '#/recent', html: _t('全部') + svg('chevron-right') }) });
      }

      case 'board': {
        if (!boardOn()) return null;
        const box = el('div');
        TTBoard.mount(box, { hideClosed: !!sec.hide_closed });
        const add = el('button', { class: 'section-link', type: 'button', html: svg('plus') + _t('新增') });
        add.addEventListener('click', () => TTBoard.openEditor(null));
        return section({ icon: svg('kanban'), title: _t(sec.title || '') || _t('待辦看板'), body: box, cls: 'section-board',
          action: el('div', { class: 'section-actions' }, add,
            el('a', { class: 'section-link', href: '#/board', html: _t('開啟') + svg('chevron-right') })) });
      }

      case 'roots':
        if (!publicRoots().length) return null;
        return section({ icon: svg('layout'), title: _t(sec.title || '') || (personalOn() ? _t('公用區') : _t('所有分類')), body: cardGrid(publicRoots(), { compact, mode: 'grid' }) });

      case 'folder': {
        const node = state.byId.get(sec.node_id);
        if (!node) return null;
        const kids = (node.children || []).slice(0, sec.limit || 999);
        return section({
          icon: tile({ icon: node.icon, name: node.name, color: colorOf(node), folder: true, size: 26 }),
          title: _t(sec.title || '') || node.name,
          body: kids.length ? cardGrid(kids, { compact, mode: 'grid' }) : el('p', { class: 'hint', text: _t('這個資料夾目前沒有項目') }),
          action: el('a', { class: 'section-link', href: `#/f/${node.id}`, html: _t('開啟') + svg('chevron-right') }),
          dropFolder: node.id,
        });
      }
      default:
        return null;
    }
  }

  /** params (links from the war room, /dashboard): user=<id> | dept=<name>, kind=ops|project, status=<column> */
  function renderBoard(params = new URLSearchParams()) {
    const frag = document.createDocumentFragment();
    let hideClosed = !!store.get('board-hide-closed', false);
    const toggle = el('label', { class: 'switch' },
      el('input', { type: 'checkbox', checked: hideClosed }), el('span', { class: 'track' }), el('span', { text: _t('隱藏完成／取消') }));
    const add = el('button', { class: 'btn btn-primary', type: 'button', html: svg('plus') + _t('新增卡片') });
    add.addEventListener('click', () => TTBoard.openEditor(null));
    const pick = el('button', { class: 'btn', type: 'button', title: _t('多選卡片後匯出 Excel 工作進度報告，或匯入報告（也可以 Ctrl／⌘＋點卡片）'), html: svg('check') + _t('選取／匯出') });
    // 依人員: one row per person (me, then everyone below me), columns by status — only with accounts
    // (server, or a standalone copy linked to one); a single-person board has nobody to lay out
    const auth = state.me?.people;
    // 看板 | 依人員 (accounts only) | 甘特圖 | 看板＋甘特圖 (the Gantt below the board, linked or not)
    const MODES = [['cols', _t('看板'), 'kanban'], ...(auth ? [['lanes', _t('依人員'), 'users']] : []), ['gantt', _t('甘特圖'), 'calendar'], ['split', _t('看板＋甘特'), 'layout']];
    let mode = store.get('board-layout', store.get('board-lanes', false) ? 'lanes' : 'cols');
    if (!MODES.some(m => m[0] === mode)) mode = 'cols';
    const lanes = mode === 'lanes';
    const layout = el('div', { class: 'segmented board-layout', role: 'group', title: _t('看板版面') },
      ...MODES.map(([v, l, icon]) => {
        const b = el('button', { type: 'button', dataset: { v }, html: svg(icon) + `<span>${l}</span>` });
        b.addEventListener('click', () => { mode = v; store.set('board-layout', v); applyMode(); });
        return b;
      }));
    const paintLayout = () => layout.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === mode)));
    paintLayout();
    pick.addEventListener('click', () => TTBoard.setSelecting(!TTBoard.selecting));
    // whose cards: everyone I can see / mine / (admins) one person
    let filter = auth ? store.get('board-filter', state.me.is_admin ? 'all' : 'all') : 'all';
    if (params.get('user')) filter = `user:${params.get('user')}`;
    else if (params.get('dept')) filter = `dept:${params.get('dept')}`;
    else if ([...params.keys()].length) filter = 'all';
    const who = el('select', { class: 'select board-who', title: _t('顯示誰的卡片') });
    const paintWho = () => {
      const people = new Map();
      TTBoard.tasks.forEach(t => [t.owner, ...(t.assignees || [])].forEach(p => { if (p) people.set(String(p.id), p); }));
      const view = state.me?.board?.view || 'own';
      const depts = [...new Set(TTBoard.tasks.flatMap(t => t.departments || []))].sort((a, b) => a.localeCompare(b, 'zh-Hant'));
      const team = state.me?.team || [];
      const opts = [['all', view === 'all' ? _t('全部卡片') : _t('我看得到的全部')], ['mine', _t('只看我的')]]
        .concat(team.length ? [['team', _t("我和下級（{0} 人）", team.length)]] : [])
        .concat(view === 'own' ? team.map(p => [`user:${p.id}`, _t("下級：{0}", p.name)]) : [])
        .concat(view !== 'own' ? depts.map(d => [`dept:${d}`, _t("部門：{0}", d)]) : [])
        .concat(view !== 'own' ? [...people.values()].sort((a, b) => TT.nameOf(a).localeCompare(TT.nameOf(b), 'zh-Hant'))
          .map(p => [`user:${p.id}`, `${TT.nameOf(p)}${p.department ? '（' + p.department + '）' : ''}`]) : []);
      who.replaceChildren(...opts.map(([v, l]) => el('option', { value: v, text: l })));
      who.value = opts.some(o => o[0] === filter) ? filter : 'all';
    };
    who.addEventListener('change', () => { filter = who.value; store.set('board-filter', filter); board.setFilter(filter); });
    const meta = el('span');
    let kindF = ['all', 'ops', 'project'].includes(params.get('kind')) ? params.get('kind') : [...params.keys()].length ? 'all' : store.get('board-kind', 'all');
    const kindSeg = el('div', { class: 'segmented board-kind', role: 'group', title: _t('卡片類型') },
      ...[['all', _t('全部')], ['ops', _t('一般')], ['project', _t('專案')]].map(([v, l]) => {
        const b = el('button', { type: 'button', dataset: { v }, text: l });
        b.addEventListener('click', () => { kindF = v; store.set('board-kind', v); paintKindSeg(); board.setKind(v); });
        return b;
      }));
    const paintKindSeg = () => kindSeg.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === kindF)));
    paintKindSeg();
    // the projects' warnings brought to the board: no need to open 專案總覽 to know one is late
    const strip = el('div', { class: 'board-strip', hidden: true });
    const paintStrip = async () => {
      if (!strip.isConnected) { document.removeEventListener('tt:analysis', paintStrip); return; }
      const a = await TTBoard.projectAnalysis().catch(() => null);
      if (!a || !a.projects.length) { strip.hidden = true; return; }
      const live = a.projects.filter(p => !['complete', 'canceled'].includes(p.status));
      const late = live.filter(p => (p.slip || 0) > 0);
      const bad = live.filter(p => p.problem_items);
      const T = new Date(); const t0 = Date.UTC(T.getFullYear(), T.getMonth(), T.getDate());
      const week = live.filter(p => p.next && (Date.parse(p.next.due) - t0) / 864e5 <= 7 && Date.parse(p.next.due) >= t0);
      const link = (text, href) => el('a', { href, text });
      strip.replaceChildren(...[el('span', { class: 'board-strip-l', text: _t('專案') }), el('span', { text: _t("{0} 個進行中", live.length) }),
        late.length ? link(_t("{0} 個落後（最多 {1} 天）", late.length, Math.max(...late.map(p => p.slip))), '#/projects') : null,
        bad.length ? link(_t("{0} 個有問題", bad.length), '#/projects') : null,
        week.length ? el('span', {}, _t('本週里程碑：'), ...week.flatMap((p, i) => [i ? '、' : '', link(`${p.next.title} ${p.next.due.slice(5).replace('-', '/')}`, `#/project/${p.id}`)])) : null].filter(Boolean));
      strip.hidden = false;
    };
    document.addEventListener('tt:analysis', paintStrip);
    frag.append(pageHead({
      tileNode: el('span', { class: 'page-icon', html: svg('kanban') }),
      title: _t('待辦看板'),
      desc: _t('拖曳卡片換狀態；設定開始日與到期日，時間到會在右上角 🔔 提醒。'),
      meta: ' ',
      tools: el('div', { class: 'board-tools' }, auth ? who : null, kindSeg, layout, toggle, pick, add),
    }));
    const box = el('div');
    const board = TTBoard.mount(box, { hideClosed: params.get('status') ? false : hideClosed, full: true, filter, lanes, kind: kindF });
    if (params.get('status')) TTBoard.load().then(() => setTimeout(() => board.showStatus(params.get('status')), 50)).catch(() => {});
    toggle.querySelector('input').addEventListener('change', e => { hideClosed = e.target.checked; store.set('board-hide-closed', hideClosed); board.setHideClosed(hideClosed); });
    const gbox = el('div', { class: 'board-gantt' });
    let gantt = null;
    // opened from the war room (/dashboard): say what is filtered, with a way back to the whole board
    const from = el('div', { class: 'board-from', hidden: ![...params.keys()].length });
    if (!from.hidden) {
      const ST = Object.fromEntries(TTBoard.STATUSES.map(x => [x.key, x.zh]));
      const paintFrom = () => {
        const uid = params.get('user');
        const person = uid && TTBoard.tasks.flatMap(t => [t.owner, ...(t.assignees || [])]).find(x => x && String(x.id) === uid);
        const bits = [uid ? _t("人員：{0}", person ? TT.nameOf(person) : `#${uid}`) : null,
          params.get('dept') ? _t("部門：{0}", params.get('dept')) : null,
          params.get('status') ? _t("狀態：{0}", ST[params.get('status')] || params.get('status')) : null,
          params.get('kind') === 'ops' ? _t('一般維運') : params.get('kind') === 'project' ? _t('專案') : null].filter(Boolean);
        from.replaceChildren(el('span', { class: 'board-strip-l', text: _t('戰情室') }), el('span', { text: bits.join(' · ') }),
          el('a', { href: '#/board', text: _t('顯示全部卡片') }));
      };
      paintFrom();
      TTBoard.load().then(paintFrom).catch(() => {});
    }
    const page = el('div', { class: 'board-page' }, frag, from, strip, box, gbox);
    setTimeout(paintStrip, 0);
    function applyMode() {
      paintLayout();
      const showGantt = mode === 'gantt' || mode === 'split';
      box.hidden = mode === 'gantt';
      gbox.hidden = !showGantt;
      page.classList.toggle('board-split', mode === 'split');
      board.setLanes(mode === 'lanes');
      if (showGantt && !gantt && window.TTGantt) {
        gantt = TTGantt.mount(gbox, { board, onLinked: on => page.classList.toggle('board-gantt-solo', mode === 'gantt' && !on) });
      }
      page.classList.toggle('board-gantt-solo', mode === 'gantt' && !!gantt && !gantt.linked);
      // the board's own tools (who / hide closed / select) only matter where the board is shown or linked
      pick.hidden = mode === 'gantt';
    }
    applyMode();
    $('view').replaceChildren(page);
    const metaEl = $('view').querySelector('.page-meta');
    const paintMeta = () => { if (metaEl.isConnected) metaEl.textContent = TTBoard.summary(); };
    TTBoard.load().then(() => { paintMeta(); if (auth) { paintWho(); board.setFilter(who.value); } }).catch(() => {});
    if (auth) paintWho();
    paintMeta();
  }

  function renderFolder(node) {
    const kids = node.children || [];
    const folders = kids.filter(isFolder);
    const links = kids.filter(n => !isFolder(n));
    const frag = document.createDocumentFragment();
    frag.append(pageHead({
      crumbs: breadcrumb([...pathOf(node), node]),
      tileNode: tile({ icon: node.icon, name: node.name, color: colorOf(node), folder: true, size: 56 }),
      title: node.name,
      desc: state.settings.show_descriptions !== false ? node.description : '',
      meta: [folders.length && _t("{0} 個資料夾", folders.length), links.length && _t("{0} 個連結", links.length)].filter(Boolean).join(' · ') || _t('空資料夾'),
      tools: node.personal
        ? el('div', { class: 'section-actions' }, personalAddButtons(node.id), kids.length ? viewToggle(() => renderFolder(node)) : null)
        : kids.length ? viewToggle(() => renderFolder(node)) : null,
    }));

    if (!kids.length) frag.append(node.personal ? emptyState('📂', _t('這裡還是空的'), _t('用右上角的按鈕新增連結或資料夾，或把網址拖進來。'))
      : emptyState('📂', _t('這裡還是空的'), _t('到管理後台為這個資料夾新增項目。')));
    if (folders.length) frag.append(section({ icon: svg('folder'), title: _t('資料夾'), body: cardGrid(folders) }));
    if (links.length) frag.append(section({ icon: svg('link'), title: _t('連結'), body: cardGrid(links) }));
    $('view').replaceChildren(frag);
  }

  function search(q) {
    const kw = q.trim().toLowerCase();
    if (!kw) return [];
    const scored = [];
    for (const n of allNodes()) {
      const name = n.name.toLowerCase();
      let score = 0;
      if (name === kw) score = 100;
      else if (name.startsWith(kw)) score = 80;
      else if (name.includes(kw)) score = 60;
      else if ((n.description || '').toLowerCase().includes(kw)) score = 40;
      else if ((n.url || '').toLowerCase().includes(kw)) score = 30;
      else if ((n.icon || '').toLowerCase().replace(/[-_.]/g, ' ').includes(kw)) score = 20;
      else if (pathOf(n).some(p => p.name.toLowerCase().includes(kw))) score = 10;
      if (score) scored.push([score + (isFolder(n) ? 0 : 5), n]);
    }
    return scored.sort((a, b) => b[0] - a[0] || a[1].name.localeCompare(b[1].name)).map(x => x[1]);
  }

  function renderSearch(q) {
    const results = search(q);
    const frag = document.createDocumentFragment();
    frag.append(pageHead({
      crumbs: breadcrumb([{ name: _t('搜尋') }]),
      tileNode: el('span', { class: 'tile', style: { '--tile': '56px' }, html: svg('search') }),
      title: `「${q}」`, meta: _t("{0} 筆結果", results.length),
      tools: results.length ? viewToggle(() => renderSearch(q)) : null,
    }));
    const cardsBox = el('div');
    frag.append(cardsBox);
    const linksPart = results.length ? cardGrid(results, { showPath: true }) : emptyState('🔍', _t('找不到符合的項目'), _t('換個關鍵字試試，或搜尋網址、卡片說明、留言的一部分。'));
    frag.append(linksPart);
    $('view').replaceChildren(frag);
    if (!boardOn()) return;
    const view = $('view').firstChild;
    TTBoard.searchCards(q, 50).then(cards => {
      if (!cards.length || $('view').firstChild !== view) return;
      const list = el('div', { class: 'kb-hits' }, cards.map(r => {
        const row = TTBoard.cardHit(r);
        row.tabIndex = 0;
        row.addEventListener('click', () => TTBoard.openTask(r.id));
        row.addEventListener('keydown', e => { if (e.key === 'Enter') TTBoard.openTask(r.id); });
        return row;
      }));
      cardsBox.replaceChildren(section({ icon: svg('kanban'), title: _t("看板卡片（{0}）", cards.length), body: list }));
      if (!results.length) linksPart.remove();
      else linksPart.before(el('h3', { class: 'kb-hits-links', html: svg('link') + _t("連結（{0}）", results.length) }));
      const meta = $('view').querySelector('.page-meta, .meta');
      if (meta) meta.textContent = _t("{0} 個連結 · {1} 張卡片", results.length, cards.length);
    }).catch(() => {});
  }

  function renderIconFilter(icon) {
    const results = allNodes().filter(n => n.icon === icon && !isFolder(n));
    const f = quickFilters().find(x => x.icon === icon);
    const frag = document.createDocumentFragment();
    frag.append(pageHead({
      crumbs: breadcrumb([{ name: _t(state.settings.quick_filters_title || '快速篩選') }]),
      tileNode: tile({ icon, name: f ? f.label : icon, size: 56 }),
      title: f ? f.label : prettyIcon(icon), meta: _t("{0} 個連結", results.length),
      tools: results.length ? viewToggle(() => renderIconFilter(icon)) : null,
    }));
    frag.append(results.length ? cardGrid(results, { showPath: true }) : emptyState('🏷️', _t('沒有符合的連結')));
    $('view').replaceChildren(frag);
  }

  function renderFavorites() {
    const favs = favorites().map(id => state.byId.get(id));
    const frag = document.createDocumentFragment();
    frag.append(pageHead({
      crumbs: breadcrumb([{ name: _t('我的最愛') }]),
      tileNode: el('span', { class: 'tile', style: { '--tile': '56px', '--tile-color': '#f59e0b' }, html: svg('star') }),
      title: _t('我的最愛'), meta: favs.length ? _t("{0} 個項目 · 只存在這個瀏覽器", favs.length) : _t('只存在這個瀏覽器'),
      tools: favs.length ? viewToggle(renderFavorites) : null,
    }));
    frag.append(favs.length ? cardGrid(favs, { showPath: true }) : emptyState('⭐', _t('還沒有最愛'), _t('在任何連結卡片上點 ☆，就會收進這裡。')));
    $('view').replaceChildren(frag);
  }

  function renderRecent() {
    const list = recent();
    const frag = document.createDocumentFragment();
    const clear = list.length ? el('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: _t('清除紀錄') }) : null;
    clear?.addEventListener('click', () => { store.remove('recent'); renderRecent(); });
    frag.append(pageHead({
      crumbs: breadcrumb([{ name: _t('最近使用') }]),
      tileNode: el('span', { class: 'tile', style: { '--tile': '56px' }, html: svg('history') }),
      title: _t('最近使用'), meta: _t('只存在這個瀏覽器'),
      tools: list.length ? el('div', { class: 'tool-row' }, clear, viewToggle(renderRecent)) : null,
    }));
    frag.append(list.length ? cardGrid(list, { showPath: true }) : emptyState('🕘', _t('還沒有使用紀錄'), _t('開啟過的連結會出現在這裡。')));
    $('view').replaceChildren(frag);
  }

  // ======================================================================
  // Drag a link from the browser onto the page to add it
  // ======================================================================
  const currentFolder = () => {
    const m = (location.hash || '').match(/^#\/f\/(\d+)/);
    const n = m && state.byId.get(Number(m[1]));
    return n && isFolder(n) ? n : null;
  };
  /** Folder under the pointer (sidebar folder, folder card / section, open folder page) or null = top level */
  const dropFolderAt = target => {
    const hit = target instanceof Element ? target.closest('[data-drop-folder]') : null;
    const id = hit && Number(hit.dataset.dropFolder);
    return id && state.byId.has(id) ? { id, el: hit } : null;
  };

  async function setupLinkDrop() {
    const local = await TT.localStatus();
    let internal = false;   // dragging one of our own cards / links
    document.addEventListener('dragstart', () => { internal = true; });
    document.addEventListener('dragend', () => { internal = false; });

    const title = el('strong', { class: 'drop-title' });
    const sub = el('span', { class: 'drop-sub' });
    document.body.append(el('div', { class: 'drop-overlay', 'aria-hidden': 'true' },
      el('div', { class: 'drop-card' }, el('span', { class: 'drop-icon', html: svg('plus') }), title, sub)));
    const show = on => document.body.classList.toggle('link-dragging', on);
    const accepts = e => !internal && (TT.isLinkDrag(e) || (local.allowed && TT.isFileDrag(e)));

    let hitEl = null;
    let hitKey;
    const mark = (e) => {
      const hit = dropFolderAt(e.target);
      const key = hit ? hit.id : 0;
      if (key === hitKey) return hit;
      hitKey = key;
      hitEl?.classList.remove('drop-hit');
      hitEl = hit ? hit.el : null;
      hitEl?.classList.add('drop-hit');
      const files = TT.isFileDrag(e);
      const f = hit && state.byId.get(hit.id);
      title.textContent = _t("放開以新增{0}到{1}", files ? _t('程式') : _t('連結'), f ? `「${f.name}」` : _t('最上層'));
      sub.textContent = f
        ? (files ? _t('支援捷徑（.lnk）、網址捷徑（.url）與執行檔（.exe）') : _t('放開後可以確認名稱、圖示與資料夾'))
        : _t('拖到左側或頁面上的資料夾，就會放進那個資料夾');
      return hit;
    };
    const clear = () => { show(false); hitEl?.classList.remove('drop-hit'); hitEl = null; hitKey = undefined; };

    document.addEventListener('dragenter', e => {
      if (!accepts(e)) return;
      mark(e);
      show(true);
    });
    document.addEventListener('dragover', e => {
      if (internal) return;
      if (accepts(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; mark(e); }
      else if (TT.isFileDrag(e)) e.preventDefault();   // never let the browser navigate to a dropped file
    });
    document.addEventListener('dragleave', e => { if (!e.relatedTarget) clear(); });
    document.addEventListener('drop', async e => {
      const parentId = accepts(e) ? (dropFolderAt(e.target)?.id ?? null) : null;
      clear();
      if (internal) return;
      if (TT.isFileDrag(e)) {
        e.preventDefault();
        if (!local.allowed) {
          TT.toast(local.enabled ? _t('拖曳程式只能在執行單機版的那台電腦上使用') : _t('拖曳程式需要 Windows 單機版'), true);
          return;
        }
        const file = e.dataTransfer.files[0];
        if (!file) return;
        try { addDialog(await TT.inspectDroppedFile(file), parentId); } catch (err) { TT.toast(err.message, true); }
        return;
      }
      if (!TT.isLinkDrag(e)) return;
      e.preventDefault();
      const link = TT.readDroppedLink(e.dataTransfer);
      if (!link) { TT.toast(_t('沒有讀到可用的網址（只支援 http / https）'), true); return; }
      addDialog({ kind: 'url', name: link.title, url: link.url }, parentId);
    });
  }

  /**
   * Confirm-and-add dialog for a dropped link or program.
   * info: { kind: 'url'|'app', name, url, icon?, args?, cwd?, found? }
   */
  async function addDialog(info, parentId = null) {
    const app = info.kind === 'app';
    let icon = info.icon || '';
    let nameTouched = false;

    const name = el('input', { class: 'input', value: info.name || '', maxlength: '200' });
    const target = el('input', {
      class: 'input' + (app ? ' mono' : ''), value: app ? (info.found === false ? '' : TT.programPath(info.url)) : info.url,
      placeholder: app ? _t('C:\\Program Files\\…\\程式.exe') : 'https://',
    });
    const args = el('input', { class: 'input mono', value: info.args || '', placeholder: _t('選填，例如 --profile work') });
    const folder = folderSelect(parentId, { allowPublic: canEditPublic() && !app, allowPersonal: personalOn() });

    const status = el('span', { class: 'drop-preview-status' });
    const preview = el('div', { class: 'drop-preview' });
    const paint = () => {
      const parent = state.byId.get(Number(folder.value.replace(/^me:/, '')));
      const where = app ? (target.value.split(/[\\/]/).pop() || _t('尚未指定程式')) : (hostOf(target.value) || target.value);
      preview.replaceChildren(
        tile({ icon, name: name.value || info.name, color: parent ? colorOf(parent) : null, size: 46 }),
        el('div', { class: 'drop-preview-text' },
          el('strong', { text: name.value || _t('（未命名）') }),
          el('span', { text: (app ? _t('本機程式 · ') : '') + where }), status));
    };
    const busy = text => { status.textContent = text; };
    name.addEventListener('input', () => { nameTouched = true; paint(); });
    folder.addEventListener('change', paint);
    paint();

    // icon: library match → website favicon (links) / program icon (apps)
    let iconPending = null;   // website icon still being fetched
    if (!app && !icon) {
      try {
        const names = (await api('/api/icons')).map(i => i.name);
        icon = TT.guessIcon(info.url, info.name, names);
      } catch { /* ignore */ }
      if (!icon) {
        busy(_t('正在取得網站圖示…'));
        iconPending = TT.fetchSiteIcon(info.url).then(got => {
          if (got) icon = got;
          busy(got ? '' : _t('抓不到網站圖示，先用名稱縮寫（之後可在後台更換）'));
          iconPending = null;
          paint();
        });
      }
      paint();
    }
    const inspect = async () => {
      const v = target.value.trim();
      if (!app || !v) return;
      busy(_t('正在讀取程式資訊…'));
      try {
        const r = await api('/api/local/inspect', { method: 'POST', body: { path: v } });
        if (r.icon) icon = r.icon;
        if (!nameTouched && r.name) name.value = r.name;
        busy('');
      } catch (err) { busy(err.message); }
      paint();
    };
    target.addEventListener('input', paint);
    target.addEventListener('change', inspect);

    const label = (text, ctl, hint) => el('label', { class: 'field' }, el('span', { class: 'field-label', text }), ctl, hint ? el('span', { class: 'hint', text: hint }) : null);
    const ok = el('button', { class: 'btn btn-primary', type: 'button', html: svg('plus') + _t('新增') });
    const cancel = el('button', { class: 'btn btn-ghost', type: 'button', text: _t('取消') });
    const closeBtn = el('button', { class: 'icon-btn', type: 'button', 'aria-label': _t('關閉'), html: svg('x') });
    const fields = app
      ? [label(_t('名稱'), name),
         label(_t('程式路徑'), target, info.found === false
           ? _t("在電腦上找不到「{0}」的位置：請在檔案總管對它按 Shift + 右鍵 →「複製為路徑」，貼到這裡", info.name)
           : _t('可以改成其他程式、文件或資料夾的路徑')),
         label(_t('啟動參數'), args)]
      : [label(_t('名稱'), name), label(_t('網址'), target)];
    const wrap = el('div', { class: 'modal' },
      el('div', { class: 'modal-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': app ? _t('新增程式') : _t('新增連結') },
        el('div', { class: 'modal-head' }, el('h3', { text: app ? _t('新增程式') : _t('新增連結') }), closeBtn),
        el('div', { class: 'modal-body' }, preview, ...fields, label(_t('放到資料夾'), folder),
          el('p', { class: 'hint', text: _t('說明、顏色與圖示可以之後到管理後台修改。') })),
        el('div', { class: 'modal-foot' }, cancel, ok)));
    const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); document.body.classList.remove('modal-open'); };
    const onKey = e => { if (e.key === 'Escape') close(); };
    wrap.addEventListener('mousedown', e => { if (e.target === wrap) close(); });
    closeBtn.addEventListener('click', close);
    cancel.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    document.body.append(wrap);
    document.body.classList.add('modal-open');
    setTimeout(() => { (app && !target.value ? target : name).focus(); }, 30);

    const submit = async () => {
      const t = target.value.trim();
      if (!name.value.trim()) { TT.toast(_t('請輸入名稱'), true); return; }
      if (app ? !TT.looksLikePath(t) : !/^https?:\/\//i.test(t)) {
        TT.toast(app ? _t('請輸入完整路徑（例如 C:\\Program Files\\…）') : _t('請輸入完整網址（例如 https://…）'), true);
        return;
      }
      ok.disabled = true;
      if (iconPending) {                       // don't create the card before its icon arrives
        ok.textContent = _t('取得圖示中…');
        await Promise.race([iconPending, new Promise(r => setTimeout(r, 12000))]);
      }
      try {
        const { parentId, personal } = folderPick(folder.value);
        const created = await api(personal ? '/api/my/nodes' : '/api/nodes', {
          method: 'POST',
          body: {
            parent_id: parentId, name: name.value.trim(), node_type: 'link', url: t, icon: icon || null,
            ...(app ? { launch_args: args.value.trim() || null, launch_cwd: info.cwd || null } : {}),
          },
        });
        close();
        await reloadTree(false);
        const dest = parentId ? `#/f/${parentId}` : '#/';
        if (location.hash === dest || (!parentId && !location.hash)) route(); else location.hash = dest;
        setTimeout(() => {
          const card = document.querySelector(`.card[data-node="${created.id}"]`);
          if (card) { card.scrollIntoView({ block: 'center', behavior: 'smooth' }); card.classList.add('just-added'); }
        }, 120);
        TT.toast(_t("已新增「{0}」", created.name));
      } catch (err) {
        TT.toast(err.message, true);
        ok.disabled = false;
        ok.innerHTML = svg('plus') + _t('新增');
      }
    };
    ok.addEventListener('click', submit);
    [name, target, args].forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }));
  }

  // ======================================================================
  // 公用區 / 個人區
  // ======================================================================
  /** the public area is edited here by administrators — except on a linked standalone copy, where it is the server's */
  const canEditPublic = () => !!state.me?.is_admin && !(state.me?.auth === false && personalOn());

  /** Folder picker over both areas. Values: "" public top level, "me:" personal top level, "<id>" public, "me:<id>" personal */
  function folderSelect(parentId, { allowPublic = true, allowPersonal = false, skip = null } = {}) {
    const sel = el('select', { class: 'select' });
    const walk = (nodes, depth, prefix, into) => nodes.forEach(n => {
      if (!isFolder(n) || n.id === skip) return;
      into.append(el('option', { value: prefix + n.id, text: '\u3000'.repeat(depth) + n.name }));
      walk(n.children || [], depth + 1, prefix, into);
    });
    const both = allowPublic && allowPersonal;
    if (allowPublic) {
      const g = both ? el('optgroup', { label: _t('公用區') }) : sel;
      g.append(el('option', { value: '', text: both ? _t('公用區（最上層）') : _t('（最上層）') }));
      walk(publicRoots(), 1, '', g);
      if (both) sel.append(g);
    }
    if (allowPersonal) {
      const g = both ? el('optgroup', { label: _t('個人區') }) : sel;
      g.append(el('option', { value: 'me:', text: both ? _t('個人區（最上層）') : _t('個人區（最上層）') }));
      walk(personalRoots(), 1, 'me:', g);
      if (both) sel.append(g);
    }
    const p = parentId != null ? state.byId.get(parentId) : null;
    const want = p ? (p.personal ? 'me:' : '') + p.id : (allowPublic && !(p === null && parentId === 'me') ? '' : 'me:');
    sel.value = [...sel.options].some(o => o.value === want) ? want : (sel.options[0]?.value ?? '');
    return sel;
  }
  const folderPick = v => {
    const personal = v.startsWith('me:');
    const id = v.replace(/^me:/, '');
    return { personal, parentId: id ? Number(id) : null };
  };

  function personalAddButtons(parentId) {
    const link = el('button', { class: 'btn btn-sm', type: 'button', html: svg('link') + _t('新增連結') });
    const folder = el('button', { class: 'btn btn-sm', type: 'button', html: svg('folder') + _t('新增資料夾') });
    link.addEventListener('click', () => personalDialog({ parentId, type: 'link' }));
    folder.addEventListener('click', () => personalDialog({ parentId, type: 'folder' }));
    return el('div', { class: 'section-actions' }, link, folder);
  }

  function personalMenu(parentId) {
    personalDialog({ parentId, type: 'link' });
  }

  function personalSection() {
    const roots = personalRoots();
    const body = roots.length ? cardGrid(roots, { mode: 'grid' })
      : el('div', { class: 'hint-card', html: _t("{0}<span>這裡只有你看得到：放自己常用的連結，{1}。也可以把網址直接拖進來。</span>", svg('star'), state.me?.auth === false ? _t('會同步到伺服器上你的個人區') : _t('單機版連線後也會同步過去')) });
    return section({ icon: svg('user'), title: _t('個人區'), body, cls: 'section-personal', action: personalAddButtons(null) });
  }

  /** Add or edit a link / folder in my personal area */
  function personalDialog({ node = null, parentId = null, type = 'link' } = {}) {
    const editing = !!node;
    const kind = editing ? node.node_type : type;
    const isLink = kind === 'link';
    const program = isLink && editing && TT.isProgram(node.url);
    const name = el('input', { class: 'input', value: node?.name || '', maxlength: '200', placeholder: isLink ? _t('例如：請假系統') : _t('例如：常用報表') });
    const url = el('input', { class: 'input', type: 'url', value: node?.url || '', placeholder: 'https://', disabled: program });
    const desc = el('input', { class: 'input', value: node?.description || '', maxlength: '500', placeholder: _t('選填') });
    const parent = editing ? state.parent.get(node.id) : (parentId != null ? state.byId.get(parentId) : null);
    const folder = folderSelect(parent ? parent.id : null, { allowPublic: false, allowPersonal: true, skip: editing && !isLink ? node.id : null });
    const label = (text, ctl) => el('label', { class: 'field' }, el('span', { class: 'field-label', text }), ctl);
    const ok = el('button', { class: 'btn btn-primary', type: 'button', html: svg(editing ? 'check' : 'plus') + (editing ? _t('儲存') : _t('新增')) });
    const cancel = el('button', { class: 'btn btn-ghost', type: 'button', text: _t('取消') });
    const del = editing ? el('button', { class: 'btn btn-ghost btn-danger', type: 'button', html: svg('trash') + _t('刪除') }) : null;
    const title = (editing ? _t('編輯') : _t('新增')) + (isLink ? _t('個人連結') : _t('個人資料夾'));
    const wrap = el('div', { class: 'modal' },
      el('div', { class: 'modal-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        el('div', { class: 'modal-head' }, el('h3', { text: title })),
        el('div', { class: 'modal-body' }, label(_t('名稱'), name), isLink ? label(program ? _t('程式（在單機版修改）') : _t('網址'), url) : null,
          label(_t('說明'), desc), label(_t('放到資料夾'), folder),
          el('p', { class: 'hint', text: _t('個人區只有你自己看得到。') })),
        el('div', { class: 'modal-foot' }, del, del ? el('span', { class: 'spacer' }) : null, cancel, ok)));
    const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); document.body.classList.remove('modal-open'); };
    const onKey = e => { if (e.key === 'Escape') close(); };
    wrap.addEventListener('mousedown', e => { if (e.target === wrap) close(); });
    cancel.addEventListener('click', close);
    document.addEventListener('keydown', onKey);
    document.body.append(wrap);
    document.body.classList.add('modal-open');
    setTimeout(() => name.focus(), 30);

    async function save() {
      const n = name.value.trim();
      const u = url.value.trim();
      if (!n) { TT.toast(_t('請輸入名稱'), true); return; }
      if (isLink && !program && !/^https?:\/\//i.test(u)) { TT.toast(_t('請輸入完整網址（例如 https://…）'), true); return; }
      const { parentId: pid } = folderPick(folder.value);
      ok.disabled = true;
      try {
        if (editing) {
          await api(`/api/my/nodes/${node.id}`, { method: 'PUT', body: { name: n, description: desc.value.trim() || null, ...(isLink && !program ? { url: u } : {}) } });
          if ((state.parent.get(node.id)?.id ?? null) !== pid) await api(`/api/my/nodes/${node.id}/move`, { method: 'PUT', body: { new_parent_id: pid } });
        } else {
          let icon = null;
          if (isLink) {
            try { icon = TT.guessIcon(u, n, (await api('/api/icons')).map(i => i.name)); } catch { /* ignore */ }
            if (!icon) icon = await Promise.race([TT.fetchSiteIcon(u).catch(() => null), new Promise(r => setTimeout(() => r(null), 8000))]);
          }
          await api('/api/my/nodes', { method: 'POST', body: { parent_id: pid, name: n, node_type: kind, url: isLink ? u : null, icon, description: desc.value.trim() || null } });
        }
        close();
        await reloadTree();
        TT.toast(editing ? _t('已儲存') : _t("已新增「{0}」", n));
      } catch (err) { TT.toast(err.message, true); ok.disabled = false; }
    }
    ok.addEventListener('click', save);
    [name, url, desc].forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); save(); } }));
    if (del) del.addEventListener('click', async () => {
      const kids = (node.children || []).length;
      if (!confirm(_t("刪除「{0}」？", node.name) + (kids ? _t("\n裡面的 {0} 個項目也會一起刪除。", kids) : ''))) return;
      try {
        await api(`/api/my/nodes/${node.id}`, { method: 'DELETE' });
        close();
        if (location.hash === `#/f/${node.id}`) location.hash = '#/';
        await reloadTree();
        TT.toast(_t('已刪除'));
      } catch (err) { TT.toast(err.message, true); }
    });
  }

  /** Re-read the tree (after an edit here, or a live update from someone else / the server) */
  async function reloadTree(rerender = true) {
    let tree;
    try { tree = await api('/api/nodes/tree'); } catch { return; }
    const sig = JSON.stringify(tree);
    if (rerender === 'live' && sig === state.treeSig) return;       // live update about something else (e.g. the board)
    state.treeSig = sig;
    indexTree(tree);
    buildTree();
    buildFilters();
    if (rerender && !/^#\/board/.test(location.hash) && !document.querySelector('.modal')) route();
  }
  window.TTPortal = { reloadTree };

  // ======================================================================
  // Command palette
  // ======================================================================
  let paletteItems = [];
  let paletteIndex = 0;

  function setupPalette() {
    const modal = $('palette');
    const input = $('palette-input');
    modal.addEventListener('mousedown', e => { if (e.target === modal) closePalette(); });
    input.addEventListener('input', () => renderPalette(input.value));
    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { e.preventDefault(); movePalette(1); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); movePalette(-1); }
      else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
      else if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey || !paletteItems.length) {
          if (input.value.trim()) { closePalette(); location.hash = `#/search/${encodeURIComponent(input.value.trim())}`; }
        } else activatePalette(paletteItems[paletteIndex], e.ctrlKey || e.metaKey);
      }
    });
  }

  function openPalette() {
    $('palette').hidden = false;
    document.body.classList.add('modal-open');
    const input = $('palette-input');
    input.value = '';
    renderPalette('');
    requestAnimationFrame(() => input.focus());
  }
  function closePalette() {
    $('palette').hidden = true;
    document.body.classList.remove('modal-open');
  }

  let paletteSeq = 0;
  let paletteTimer = null;
  function renderPalette(q) {
    const seq = ++paletteSeq;
    clearTimeout(paletteTimer);
    if (q.trim() && boardOn()) {
      paletteTimer = setTimeout(async () => {
        let cards = [];
        try { cards = await TTBoard.searchCards(q.trim(), 12); } catch { return; }
        if (seq !== paletteSeq || $('palette').hidden || !cards.length) return;
        appendPaletteCards(q, cards);
      }, 120);
    }
    const box = $('palette-results');
    let groups;
    if (q.trim()) {
      groups = [{ label: _t('結果'), items: search(q).slice(0, 40) }];
    } else {
      groups = [
        { label: _t('最近使用'), items: recent(6) },
        { label: _t('我的最愛'), items: favorites().map(id => state.byId.get(id)).slice(0, 6) },
        { label: _t('分類'), items: state.tree.filter(isFolder).slice(0, 8) },
      ];
    }
    paletteItems = [];
    paletteIndex = 0;
    const frag = document.createDocumentFragment();
    groups.forEach(g => {
      const items = g.items.filter(n => !paletteItems.includes(n));
      if (!items.length) return;
      frag.append(el('div', { class: 'palette-group', text: g.label }));
      items.forEach(n => {
        const idx = paletteItems.length;
        paletteItems.push(n);
        const path = pathOf(n).map(p => p.name).join(' › ');
        const row = el('div', { class: 'palette-item', role: 'option', dataset: { idx } },
          tile({ icon: n.icon, name: n.name, color: colorOf(n), folder: isFolder(n), size: 32 }),
          el('div', { class: 'palette-item-text' },
            el('div', { class: 'palette-item-title', text: n.name }),
            el('div', { class: 'palette-item-sub', text: [path, !isFolder(n) && (TT.isProgram(n.url) ? _t('本機程式') : hostOf(n.url))].filter(Boolean).join('  ·  ') })),
          el('span', { class: 'palette-item-kind', html: isFolder(n) ? svg('folder') : svg(TT.isProgram(n.url) ? 'play' : 'external') }));
        row.addEventListener('mousemove', () => selectPalette(idx));
        row.addEventListener('click', e => activatePalette(n, e.ctrlKey || e.metaKey));
        frag.append(row);
      });
    });
    if (!paletteItems.length) {
      frag.append(el('div', { class: 'palette-empty', text: q.trim() ? _t("找不到「{0}」", q.trim()) : _t('輸入關鍵字開始搜尋') }));
    }
    box.replaceChildren(frag);
    selectPalette(0);
  }

  /** Board cards arrive a moment after the links (server search): add them as their own group. */
  function appendPaletteCards(q, cards) {
    const box = $('palette-results');
    const hadNone = !paletteItems.length;
    box.querySelector('.palette-empty')?.remove();
    const frag = document.createDocumentFragment();
    frag.append(el('div', { class: 'palette-group', text: _t('看板卡片') }));
    cards.forEach(r => {
      const item = { kind: 'task', id: r.id, name: r.title };
      const idx = paletteItems.length;
      paletteItems.push(item);
      const row = TTBoard.cardHit(r);
      row.classList.add('palette-item');
      row.setAttribute('role', 'option');
      row.dataset.idx = idx;
      row.append(el('span', { class: 'palette-item-kind', html: svg('kanban') }));
      row.addEventListener('mousemove', () => selectPalette(idx));
      row.addEventListener('click', () => activatePalette(item));
      frag.append(row);
    });
    box.append(frag);
    if (hadNone) selectPalette(0);
  }

  function selectPalette(i) {
    paletteIndex = i;
    $('palette-results').querySelectorAll('.palette-item').forEach(r => {
      const on = Number(r.dataset.idx) === i;
      r.classList.toggle('selected', on);
      r.setAttribute('aria-selected', String(on));
      if (on) r.scrollIntoView({ block: 'nearest' });
    });
  }
  function movePalette(d) {
    if (!paletteItems.length) return;
    selectPalette((paletteIndex + d + paletteItems.length) % paletteItems.length);
  }
  function activatePalette(n, forceNewTab = false) {
    if (!n) return;
    closePalette();
    if (n.kind === 'task') { TTBoard.openTask(n.id); return; }
    if (isFolder(n)) { location.hash = `#/f/${n.id}`; return; }
    pushRecent(n.id);
    if (TT.isProgram(n.url)) { TT.launchProgram(n); return; }
    if (forceNewTab || newTabFor(n)) window.open(n.url, '_blank', 'noopener');
    else location.href = n.url;
  }
})();
