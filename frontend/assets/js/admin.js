/* =============================================================================
   Tool Table — admin
   Panels (hash): #content  #home  #quick  #icons  #settings  #backup
   ============================================================================= */
'use strict';

(() => {
  const { el, svg, esc, tile, api, store, toast } = TT;
  const $ = id => document.getElementById(id);

  const COLORS = ['#6366f1', '#3b82f6', '#06b6d4', '#10b981', '#22c55e', '#84cc16', '#eab308', '#f97316', '#ef4444', '#ec4899', '#a855f7', '#64748b'];
  const EMOJI = ['📁', '📂', '🗂️', '📊', '📈', '📉', '🖥️', '💻', '🖧', '🌐', '🔐', '🔑', '🛡️', '🔥', '⚙️', '🧰', '🛠️', '🔧', '📡', '📶', '☁️', '🗄️', '💾', '🧪',
    '📚', '📘', '📝', '📋', '📌', '🗺️', '🧭', '🏢', '🏭', '🏠', '👥', '💬', '📧', '📞', '🎫', '🚀', '⭐', '❤️', '✅', '⚠️', '🧠', '🤖', '🎨', '🎬'];

  const PANELS = [
    { id: 'content', icon: 'folder', label: '內容', desc: '資料夾與連結。拖曳可排序或移到別的資料夾。' },
    { id: 'home', icon: 'layout', label: '首頁版面', desc: '首頁要顯示哪些區塊、順序如何。' },
    { id: 'quick', icon: 'zap', label: '快速連結', desc: '首頁上方的快捷按鈕列，可依群組分組。' },
    { id: 'icons', icon: 'image', label: '圖示', desc: '上傳、改名、刪除圖示。' },
    { id: 'settings', icon: 'palette', label: '外觀與設定', desc: '品牌、配色、頁首元件、導覽與卡片。' },
    { id: 'backup', icon: 'database', label: '備份與匯入', desc: '把全部內容匯出成 JSON，或從 JSON 匯入。' },
  ];

  const state = {
    settings: {},
    defaults: {},
    tree: [],
    byId: new Map(),
    parent: new Map(),
    icons: [],
    links: [],
    selected: null,
    dirty: false,
    expanded: new Set(store.get('admin-expanded', [])),
    filter: '',
  };

  // ======================================================================
  // Boot
  // ======================================================================
  document.addEventListener('DOMContentLoaded', async () => {
    try {
      [state.settings, state.defaults] = await Promise.all([api('/api/settings'), api('/api/settings/defaults')]);
    } catch (e) {
      $('stage').replaceChildren(el('div', { class: 'empty' }, el('div', { class: 'empty-icon', text: '⚠️' }), el('h3', { text: '無法連線到後端' }), el('p', { text: e.message })));
      return;
    }
    TT.applyAppearance(state.settings);
    paintBrand();
    buildRail();

    const themeBtn = $('theme-btn');
    const paintTheme = () => {
      const pref = TT.themePref(state.settings);
      themeBtn.innerHTML = svg(pref === 'auto' ? 'monitor' : pref === 'light' ? 'sun' : 'moon');
      themeBtn.title = `主題：${{ auto: '跟隨系統', light: '淺色', dark: '深色' }[pref]}`;
    };
    themeBtn.addEventListener('click', () => { TT.cycleTheme(state.settings); paintTheme(); });
    paintTheme();
    $('open-portal').innerHTML = svg('external') + '<span>開啟入口</span>';

    await Promise.all([loadTree(), loadIcons()]);
    setupLinkDrop();
    window.addEventListener('hashchange', route);
    window.addEventListener('beforeunload', e => { if (state.dirty) { e.preventDefault(); e.returnValue = ''; } });
    route();
  });

  // ======================================================================
  // Drag a link from the browser (address bar / page / bookmark) to add it
  // ======================================================================
  let linkDropHandled = false;

  let local = { enabled: false, allowed: false };
  const isAddDrag = e => dragId === null && (TT.isLinkDrag(e) || (local.allowed && TT.isFileDrag(e)));

  async function setupLinkDrop() {
    local = await TT.localStatus();
    const hint = el('div', { class: 'drop-hint', role: 'status' });
    document.body.append(hint);
    const end = () => document.body.classList.remove('link-dragging');
    document.addEventListener('dragenter', e => {
      if (!isAddDrag(e)) return;
      const files = TT.isFileDrag(e);
      hint.innerHTML = svg(files ? 'app' : 'link') + `<span>${esc({
        content: '放到資料夾上＝新增到該資料夾；放在其他地方＝新增到最上層',
        quick: files ? '快速連結只能放網址，程式請拖到「內容」' : '放開即可新增為快速連結',
      }[currentPanel] || '請先切到「內容」或「快速連結」再拖放')}</span>`;
      const zone = document.querySelector('.atree-root-drop');
      if (zone) zone.textContent = '放到這裡：新增到最上層';
      document.body.classList.add('link-dragging');
    });
    document.addEventListener('dragleave', e => { if (!e.relatedTarget) end(); });
    document.addEventListener('dragend', end);
    // allow dropping anywhere so the browser never navigates away to the dropped URL / file
    document.addEventListener('dragover', e => { if (dragId === null && (TT.isLinkDrag(e) || TT.isFileDrag(e))) e.preventDefault(); });
    document.addEventListener('drop', e => {
      end();
      if (dragId !== null) return;
      const files = TT.isFileDrag(e);
      if (!files && !TT.isLinkDrag(e)) return;
      e.preventDefault();
      if (!linkDropHandled) {
        if (files && !local.allowed) toast(local.enabled ? '拖曳程式只能在執行單機版的那台電腦上使用' : '拖曳程式需要 Windows 單機版', true);
        else toast('請先切到「內容」或「快速連結」再拖放', true);
      }
      linkDropHandled = false;
    });
  }

  /** Read the dropped link; returns null (and complains) when there is no usable URL */
  function takeDroppedLink(e) {
    e.preventDefault();
    linkDropHandled = true;
    document.body.classList.remove('link-dragging');
    clearDrop();
    const link = TT.readDroppedLink(e.dataTransfer);
    if (!link) toast('沒有讀到可用的網址（只支援 http / https）', true);
    return link;
  }

  /** Handle a drop (link or local file) → open the create dialog in `parentId` */
  async function dropToCreate(e, parentId) {
    if (TT.isFileDrag(e)) {
      e.preventDefault();
      linkDropHandled = true;
      document.body.classList.remove('link-dragging');
      clearDrop();
      if (!local.allowed) { toast(local.enabled ? '拖曳程式只能在執行單機版的那台電腦上使用' : '拖曳程式需要 Windows 單機版', true); return; }
      const file = e.dataTransfer.files[0];
      if (!file) return;
      try { createNode(parentId, await TT.inspectDroppedFile(file)); } catch (err) { toast(err.message, true); }
      return;
    }
    const link = takeDroppedLink(e);
    if (link) createNode(parentId, { kind: 'url', name: link.title, url: link.url });
  }

  /** Automatic icon: program's own icon, or the website's icon */
  async function autoIcon(target) {
    const v = (target || '').trim();
    if (TT.looksLikePath(v)) {
      const r = await api('/api/local/inspect', { method: 'POST', body: { path: v } });
      if (r.icon) return r.icon;
      throw new Error('這個程式沒有可用的圖示');
    }
    if (/^https?:\/\//i.test(v)) {
      const icon = await TT.fetchSiteIcon(v);
      if (icon) return icon;
      throw new Error('這個網站沒有可用的圖示，或伺服器連不到它');
    }
    throw new Error('請先填寫網址或程式路徑');
  }

  function folderForNewItem() {
    const sel = state.byId.get(state.selected);
    if (!sel) return null;
    if (isFolder(sel)) return sel.id;
    return state.parent.get(sel.id)?.id ?? null;
  }

  function paintBrand() {
    const s = state.settings;
    $('rail-title').textContent = s.site_title || 'Tool Table';
    $('rail-mark').replaceChildren(tile({ icon: s.favicon, name: s.site_title || 'T', size: 34 }));
    document.title = `${s.site_title || 'Tool Table'} · 管理後台`;
    if (s.favicon) TT.setFavicon(s.favicon);
  }

  function buildRail() {
    $('rail-nav').replaceChildren(...PANELS.map(p =>
      el('a', { class: 'rail-item', href: '#' + p.id, dataset: { panel: p.id } },
        el('span', { class: 'rail-icon', html: svg(p.icon) }), el('span', { text: p.label }))));
  }

  async function loadTree() {
    const tree = await api('/api/nodes/tree?include_inactive=true');
    state.tree = tree;
    state.byId.clear();
    state.parent.clear();
    const walk = (nodes, parent) => nodes.forEach(n => {
      state.byId.set(n.id, n);
      state.parent.set(n.id, parent);
      walk(n.children || [], n);
    });
    walk(tree, null);
    if (state.selected && !state.byId.has(state.selected)) state.selected = null;
  }

  async function loadIcons() {
    state.icons = await api('/api/icons');
  }

  const isFolder = n => n.node_type === 'folder';
  const pathOf = n => {
    const out = [];
    for (let p = state.parent.get(n.id); p; p = state.parent.get(p.id)) out.unshift(p);
    return out;
  };
  const descendants = n => (n.children || []).flatMap(c => [c, ...descendants(c)]);
  const iconUsage = () => {
    const m = new Map();
    state.byId.forEach(n => { if (n.icon) m.set(n.icon, (m.get(n.icon) || 0) + 1); });
    return m;
  };

  // ======================================================================
  // Router
  // ======================================================================
  let currentPanel = null;

  async function route() {
    const id = (location.hash || '#content').slice(1).split('/')[0];
    const panel = PANELS.find(p => p.id === id) || PANELS[0];
    if (currentPanel && currentPanel !== panel.id && state.dirty) {
      if (!(await confirmDialog('放棄未儲存的變更？', '這一頁有尚未儲存的修改。', '放棄變更'))) {
        history.replaceState(null, '', '#' + currentPanel);
        return;
      }
    }
    state.dirty = false;
    currentPanel = panel.id;
    document.querySelectorAll('.rail-item').forEach(a => a.classList.toggle('active', a.dataset.panel === panel.id));

    const stage = $('stage');
    const head = el('header', { class: 'stage-head' },
      el('div', {},
        el('h1', { text: panel.label }),
        el('p', { text: panel.desc })),
      el('div', { class: 'stage-actions', id: 'stage-actions' }));
    const body = el('div', { class: 'stage-body', id: 'stage-body' });
    stage.replaceChildren(head, body);
    stage.classList.remove('enter'); void stage.offsetWidth; stage.classList.add('enter');

    ({ content: renderContent, home: renderHome, quick: renderQuick, icons: renderIcons, settings: renderSettings, backup: renderBackup })[panel.id]();
  }

  // ======================================================================
  // Dialog helpers
  // ======================================================================
  function modal({ title, body, actions = [], wide = false, onClose }) {
    const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); onClose && onClose(); };
    const onKey = e => { if (e.key === 'Escape') close(); };
    const closeBtn = el('button', { class: 'icon-btn', type: 'button', 'aria-label': '關閉', html: svg('x') });
    closeBtn.addEventListener('click', close);
    const card = el('div', { class: 'modal-card' + (wide ? ' modal-wide' : ''), role: 'dialog', 'aria-modal': 'true' },
      el('div', { class: 'modal-head' }, el('h3', { text: title }), closeBtn),
      el('div', { class: 'modal-body' }, body),
      actions.length ? el('div', { class: 'modal-foot' }, actions) : null);
    const wrap = el('div', { class: 'modal' }, card);
    wrap.addEventListener('mousedown', e => { if (e.target === wrap) close(); });
    document.addEventListener('keydown', onKey);
    document.body.append(wrap);
    setTimeout(() => card.querySelector('input, textarea, select')?.focus(), 30);
    return close;
  }

  function confirmDialog(title, text, okLabel = '確定', danger = true) {
    return new Promise(resolve => {
      let done = false;
      const finish = v => { if (!done) { done = true; resolve(v); } };
      const ok = el('button', { class: 'btn ' + (danger ? 'btn-danger' : 'btn-primary'), type: 'button', text: okLabel });
      const cancel = el('button', { class: 'btn btn-ghost', type: 'button', text: '取消' });
      const close = modal({ title, body: el('p', { class: 'dialog-text', text }), actions: [cancel, ok], onClose: () => finish(false) });
      ok.addEventListener('click', () => { finish(true); close(); });
      cancel.addEventListener('click', () => { finish(false); close(); });
    });
  }

  function field(label, control, hint) {
    return el('label', { class: 'field' }, el('span', { class: 'field-label', text: label }), control, hint ? el('span', { class: 'hint', text: hint }) : null);
  }

  function switchCtl(checked, label, onChange) {
    const input = el('input', { type: 'checkbox' });
    input.checked = !!checked;
    input.addEventListener('change', () => onChange(input.checked));
    return el('label', { class: 'switch' }, input, el('span', { class: 'track' }), label ? el('span', { text: label }) : null);
  }

  function segmented(options, value, onChange) {
    const seg = el('div', { class: 'segmented', role: 'group' });
    const paint = v => seg.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === v)));
    options.forEach(([v, label, icon]) => {
      const b = el('button', { type: 'button', dataset: { v }, html: (icon ? svg(icon) : '') + `<span>${esc(label)}</span>` });
      b.addEventListener('click', () => { paint(v); onChange(v); });
      seg.append(b);
    });
    paint(value);
    seg.setValue = paint;
    return seg;
  }

  function colorPicker(value, onChange) {
    const wrap = el('div', { class: 'swatches' });
    const custom = el('input', { type: 'color', class: 'swatch-custom', title: '自訂顏色', value: value || '#6366f1' });
    const paint = v => wrap.querySelectorAll('.swatch').forEach(s => s.classList.toggle('on', (s.dataset.c || '') === (v || '')));
    const none = el('button', { type: 'button', class: 'swatch swatch-none', dataset: { c: '' }, title: '不指定（沿用上層 / 主題色）' });
    none.addEventListener('click', () => { paint(''); onChange(''); });
    wrap.append(none);
    COLORS.forEach(c => {
      const b = el('button', { type: 'button', class: 'swatch', dataset: { c }, title: c, style: { '--c': c } });
      b.addEventListener('click', () => { paint(c); onChange(c); });
      wrap.append(b);
    });
    custom.addEventListener('input', () => { paint(''); onChange(custom.value); });
    wrap.append(custom);
    paint(value || '');
    return wrap;
  }

  /** Icon picker: uploaded images, emoji, or none. Resolves to the chosen value, '' for none, undefined if cancelled. */
  function pickIcon(current) {
    return new Promise(resolve => {
      let result;
      const choose = v => { result = v; close(); };
      let mode = TT.isIconFile(current) || !current ? 'library' : 'emoji';

      const search = el('input', { class: 'input', type: 'search', placeholder: '搜尋圖示…' });
      const upload = el('input', { type: 'file', accept: '.png,.jpg,.jpeg,.svg,.webp,.gif', multiple: true, hidden: true });
      const uploadBtn = el('button', { class: 'btn btn-sm', type: 'button', html: svg('upload') + '上傳' });
      uploadBtn.addEventListener('click', () => upload.click());
      const grid = el('div', { class: 'picker-grid' });
      const paintLib = () => {
        const q = search.value.trim().toLowerCase();
        grid.replaceChildren(...state.icons.filter(i => !q || i.name.toLowerCase().includes(q)).map(i => {
          const b = el('button', { type: 'button', class: 'picker-item' + (i.name === current ? ' on' : ''), title: i.name },
            tile({ icon: i.name, name: i.name, size: 40 }), el('span', { text: i.name.replace(/\.[^.]+$/, '') }));
          b.addEventListener('click', () => choose(i.name));
          return b;
        }));
        if (!grid.childElementCount) grid.append(el('p', { class: 'hint', text: '沒有符合的圖示' }));
      };
      search.addEventListener('input', paintLib);
      upload.addEventListener('change', async () => {
        const names = await uploadIcons(upload.files);
        upload.value = '';
        paintLib();
        if (names.length === 1) choose(names[0]);
      });
      const library = el('div', { class: 'picker-pane' }, el('div', { class: 'picker-tools' }, search, uploadBtn, upload), grid);

      const emojiInput = el('input', { class: 'input emoji-input', type: 'text', maxlength: '8', placeholder: '輸入或貼上 emoji', value: TT.isIconFile(current) ? '' : (current || '') });
      const emojiOk = el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: '使用' });
      emojiOk.addEventListener('click', () => emojiInput.value.trim() && choose(emojiInput.value.trim()));
      emojiInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); emojiOk.click(); } });
      const emojiGrid = el('div', { class: 'emoji-grid' }, EMOJI.map(em => {
        const b = el('button', { type: 'button', class: 'emoji-item', text: em });
        b.addEventListener('click', () => choose(em));
        return b;
      }));
      const emoji = el('div', { class: 'picker-pane' }, el('div', { class: 'picker-tools' }, emojiInput, emojiOk), emojiGrid);

      const body = el('div', { class: 'picker' });
      const show = m => { mode = m; body.replaceChildren(tabs, m === 'library' ? library : emoji); if (m === 'library') paintLib(); };
      const tabs = segmented([['library', '圖示庫', 'image'], ['emoji', 'Emoji', 'sparkles']], mode, show);

      const clear = el('button', { class: 'btn btn-ghost', type: 'button', text: '不使用圖示' });
      clear.addEventListener('click', () => choose(''));
      const cancel = el('button', { class: 'btn', type: 'button', text: '取消' });
      cancel.addEventListener('click', () => close());
      const close = modal({ title: '選擇圖示', body, actions: [clear, el('span', { class: 'spacer' }), cancel], wide: true, onClose: () => resolve(result) });
      show(mode);
    });
  }

  async function uploadIcons(files) {
    const names = [];
    for (const f of files) {
      const form = new FormData();
      form.append('file', f);
      try {
        const r = await api('/api/icons', { method: 'POST', form });
        names.push(r.filename);
      } catch (e) { toast(`${f.name}：${e.message}`, true); }
    }
    if (names.length) { toast(`已上傳 ${names.length} 個圖示`); await loadIcons(); }
    return names;
  }

  function iconButton(value, name, onChange, opts = {}) {
    const wrap = el('div', { class: 'icon-field' });
    const paint = v => {
      wrap.replaceChildren(
        tile({ icon: v, name: name(), color: opts.color?.(), folder: opts.folder?.(), size: 44 }),
        el('div', { class: 'icon-field-text' },
          el('strong', { text: v ? (TT.isIconFile(v) ? v : `Emoji：${v}`) : '未設定' }),
          el('span', { class: 'hint', text: v ? '' : (opts.folder?.() ? '顯示資料夾圖示' : '顯示名稱縮寫') })),
        btn);
    };
    const pick = el('button', { class: 'btn btn-sm', type: 'button', text: '更換…' });
    pick.addEventListener('click', async () => {
      const v = await pickIcon(value);
      if (v === undefined) return;
      wrap.set(v);
    });
    const btn = el('div', { class: 'icon-field-tools' }, pick);
    if (opts.auto) {
      const auto = el('button', { class: 'btn btn-sm', type: 'button', title: '程式：取用程式本身的圖示；網址：抓取網站圖示', html: svg('wand') + '自動' });
      auto.addEventListener('click', async () => {
        auto.disabled = true;
        try { wrap.set(await opts.auto()); toast('已取得圖示'); await loadIcons(); }
        catch (e) { toast(e.message, true); }
        finally { auto.disabled = false; }
      });
      btn.prepend(auto);
    }
    wrap.set = v => { value = v; paint(v); onChange(v); };
    paint(value);
    wrap.repaint = () => paint(value);
    return wrap;
  }

  // ======================================================================
  // Panel: content (tree + editor)
  // ======================================================================
  let dragId = null;

  function renderContent() {
    const addRoot = el('button', { class: 'btn btn-primary', type: 'button', html: svg('plus') + '新增' });
    addRoot.addEventListener('click', () => createNode(state.selected && isFolder(state.byId.get(state.selected)) ? state.selected : null));
    $('stage-actions').append(addRoot);

    const search = el('input', { class: 'input', type: 'search', placeholder: '篩選名稱或網址…', value: state.filter });
    search.addEventListener('input', () => { state.filter = search.value; paintTree(); });
    const expandAll = el('button', { class: 'icon-btn', type: 'button', title: '全部展開', html: svg('chevron-down') });
    expandAll.addEventListener('click', () => { state.byId.forEach(n => isFolder(n) && state.expanded.add(n.id)); saveExpanded(); paintTree(); });
    const collapseAll = el('button', { class: 'icon-btn', type: 'button', title: '全部收合', html: svg('chevron-up') });
    collapseAll.addEventListener('click', () => { state.expanded.clear(); saveExpanded(); paintTree(); });

    const treeBox = el('div', { class: 'atree', id: 'atree', role: 'tree' });
    const dropRoot = el('div', { class: 'atree-root-drop', text: '拖到這裡：移到最上層' });
    setupRootDrop(dropRoot);

    const left = el('section', { class: 'panel tree-panel' },
      el('div', { class: 'panel-tools' }, search, expandAll, collapseAll),
      treeBox, dropRoot,
      el('p', { class: 'hint tree-hint', html: `${svg('grip')}<span>拖曳排序；拖到資料夾中間＝放進資料夾。也可以把瀏覽器的網址或連結直接拖進來新增。</span>` }));
    const right = el('section', { class: 'panel editor-panel', id: 'editor' });
    const grid = el('div', { class: 'content-grid' }, left, right);
    grid.addEventListener('dragover', e => { if (isAddDrag(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
    grid.addEventListener('drop', e => { if (isAddDrag(e)) dropToCreate(e, null); });   // not on a folder → top level
    $('stage-body').append(grid);
    paintTree();
    paintEditor();
  }

  const saveExpanded = () => store.set('admin-expanded', [...state.expanded]);

  function paintTree() {
    const box = $('atree');
    if (!box) return;
    const q = state.filter.trim().toLowerCase();
    const matches = n => !q || n.name.toLowerCase().includes(q) || (n.url || '').toLowerCase().includes(q);
    const visible = n => matches(n) || (n.children || []).some(visible);

    const render = (nodes, depth) => {
      const frag = document.createDocumentFragment();
      nodes.forEach(n => {
        if (!visible(n)) return;
        const folder = isFolder(n);
        const kids = n.children || [];
        const open = q ? true : state.expanded.has(n.id);
        const row = el('div', {
          class: 'arow' + (state.selected === n.id ? ' selected' : '') + (n.is_active ? '' : ' inactive') + (q && matches(n) ? ' match' : ''),
          role: 'treeitem', draggable: 'true', tabindex: '0',
          dataset: { id: n.id }, style: { '--depth': depth },
        });
        const caret = el('span', { class: 'acaret' + (kids.length ? '' : ' no-kids'), html: kids.length ? svg('chevron-right') : '' });
        if (open) caret.classList.add('open');
        caret.addEventListener('click', e => {
          e.stopPropagation();
          if (state.expanded.has(n.id)) state.expanded.delete(n.id); else state.expanded.add(n.id);
          saveExpanded();
          paintTree();
        });
        row.append(...[
          el('span', { class: 'agrip', html: svg('grip') }),
          caret,
          tile({ icon: n.icon, name: n.name, color: n.color || null, folder, size: 26 }),
          el('span', { class: 'aname', text: n.name }),
          n.is_active ? null : el('span', { class: 'atag', title: '已停用：前台不會顯示', html: svg('eye-off') }),
          folder ? el('span', { class: 'acount', text: kids.length || '' })
            : el('span', { class: 'akind' + (TT.isProgram(n.url) ? ' is-program' : ''), title: TT.isProgram(n.url) ? '本機程式' : '', html: svg(TT.isProgram(n.url) ? 'play' : 'link') }),
        ].filter(Boolean));
        row.addEventListener('click', () => select(n.id));
        row.addEventListener('keydown', e => { if (e.key === 'Enter') select(n.id); });
        setupDrag(row, n);
        const wrap = el('div', { class: 'anode' }, row);
        if (kids.length && open) wrap.append(render(kids, depth + 1));
        frag.append(wrap);
      });
      return frag;
    };
    box.replaceChildren(render(state.tree, 0));
    if (!state.tree.length) {
      box.append(el('div', { class: 'empty small' }, el('div', { class: 'empty-icon', text: '🌱' }), el('h3', { text: '從第一個資料夾開始' }), el('p', { text: '按右上角「新增」建立資料夾或連結。' })));
    }
  }

  // --- drag & drop ---
  function dropPosition(e, row, n) {
    const r = row.getBoundingClientRect();
    const y = (e.clientY - r.top) / r.height;
    if (isFolder(n)) return y < .28 ? 'before' : y > .72 ? 'after' : 'inside';
    return y < .5 ? 'before' : 'after';
  }
  function canDrop(target) {
    if (dragId === null || dragId === target.id) return false;
    const dragged = state.byId.get(dragId);
    return !descendants(dragged).some(d => d.id === target.id);
  }
  const clearDrop = () => document.querySelectorAll('.drop-before, .drop-after, .drop-inside').forEach(r => r.classList.remove('drop-before', 'drop-after', 'drop-inside'));

  function setupDrag(row, n) {
    row.addEventListener('dragstart', e => {
      dragId = n.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(n.id));
      requestAnimationFrame(() => row.classList.add('dragging'));
      document.body.classList.add('is-dragging');
    });
    row.addEventListener('dragend', () => {
      dragId = null;
      row.classList.remove('dragging');
      document.body.classList.remove('is-dragging');
      clearDrop();
    });
    row.addEventListener('dragover', e => {
      if (isAddDrag(e)) {
        e.preventDefault();
        e.stopPropagation();
        e.dataTransfer.dropEffect = 'copy';
        const cls = isFolder(n) ? 'drop-inside' : 'drop-after';
        if (!row.classList.contains(cls)) { clearDrop(); row.classList.add(cls); }
        return;
      }
      if (!canDrop(n)) return;
      e.preventDefault();
      const pos = dropPosition(e, row, n);
      if (!row.classList.contains('drop-' + pos)) { clearDrop(); row.classList.add('drop-' + pos); }
    });
    row.addEventListener('dragleave', e => { if (!row.contains(e.relatedTarget)) row.classList.remove('drop-before', 'drop-after', 'drop-inside'); });
    row.addEventListener('drop', e => {
      if (isAddDrag(e)) {
        e.stopPropagation();
        const parent = isFolder(n) ? n : state.parent.get(n.id);
        dropToCreate(e, parent ? parent.id : null);
        return;
      }
      e.preventDefault();
      if (!canDrop(n)) return;
      const pos = dropPosition(e, row, n);
      const id = dragId;
      clearDrop();
      moveNode(id, n, pos);
    });
  }

  function setupRootDrop(zone) {
    zone.addEventListener('dragenter', () => { if (dragId !== null) zone.textContent = '拖到這裡：移到最上層'; });
    zone.addEventListener('dragover', e => {
      if (dragId !== null || isAddDrag(e)) { e.preventDefault(); e.stopPropagation(); zone.classList.add('over'); }
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('over'));
    zone.addEventListener('drop', e => {
      zone.classList.remove('over');
      if (dragId !== null) { e.preventDefault(); moveNode(dragId, null, 'root'); return; }
      if (!isAddDrag(e)) return;
      e.stopPropagation();
      dropToCreate(e, null);
    });
  }

  async function moveNode(id, target, pos) {
    const node = state.byId.get(id);
    const newParent = pos === 'root' ? null : pos === 'inside' ? target : state.parent.get(target.id);
    const siblings = (newParent ? newParent.children : state.tree).filter(x => x.id !== id);
    let idx = siblings.length;
    if (pos === 'before' || pos === 'after') idx = siblings.indexOf(target) + (pos === 'after' ? 1 : 0);
    siblings.splice(idx, 0, node);
    try {
      const oldParent = state.parent.get(id);
      if ((oldParent?.id ?? null) !== (newParent?.id ?? null)) {
        await api(`/api/nodes/${id}/move`, { method: 'PUT', body: { new_parent_id: newParent ? newParent.id : null } });
      }
      await api('/api/nodes/reorder', { method: 'PUT', body: { items: siblings.map((s, i) => ({ id: s.id, sort_order: i })) } });
      if (newParent) { state.expanded.add(newParent.id); saveExpanded(); }
      await loadTree();
      paintTree();
      if (state.selected) paintEditor();
      toast(pos === 'inside' ? `已移到「${target.name}」` : '已更新順序');
    } catch (e) {
      toast(e.message, true);
      await loadTree();
      paintTree();
    }
  }

  // --- selection & editor ---
  async function select(id) {
    if (state.selected === id) return;
    if (state.dirty && !(await confirmDialog('放棄未儲存的變更？', '目前編輯的項目還沒儲存。', '放棄變更'))) return;
    state.selected = id;
    state.dirty = false;
    document.querySelectorAll('.arow.selected').forEach(r => r.classList.remove('selected'));
    document.querySelector(`.arow[data-id="${id}"]`)?.classList.add('selected');
    paintEditor();
  }

  function paintEditor() {
    const box = $('editor');
    if (!box) return;
    const n = state.byId.get(state.selected);
    if (!n) {
      box.replaceChildren(el('div', { class: 'empty' },
        el('div', { class: 'empty-icon', html: svg('edit') }),
        el('h3', { text: '選擇左邊的項目來編輯' }),
        el('p', { text: '或按「新增」建立新的資料夾、連結。' })));
      return;
    }

    const draft = { name: n.name, node_type: n.node_type, url: TT.programPath(n.url || ''), description: n.description || '', icon: n.icon || '', color: n.color || '', new_tab: n.new_tab !== false && n.new_tab !== 0, is_active: !!n.is_active, parent: state.parent.get(n.id)?.id ?? '', launch_args: n.launch_args || '', launch_cwd: n.launch_cwd || '' };
    const markDirty = () => { state.dirty = true; saveBtn.disabled = false; };
    const folderNow = () => draft.node_type === 'folder';

    // header
    const preview = el('div', { class: 'editor-preview' });
    const paintPreview = () => preview.replaceChildren(tile({ icon: draft.icon, name: draft.name, color: draft.color || null, folder: folderNow(), size: 52 }));
    paintPreview();
    const crumbs = pathOf(n).map(p => p.name).join(' › ') || '最上層';
    const head = el('div', { class: 'editor-head' }, preview,
      el('div', { class: 'editor-title' },
        el('h2', { text: n.name }),
        el('div', { class: 'hint', text: crumbs })),
      el('span', { class: 'badge', text: isFolder(n) ? '資料夾' : '連結' }));

    // fields
    const name = el('input', { class: 'input', value: draft.name, maxlength: '200' });
    name.addEventListener('input', () => { draft.name = name.value; markDirty(); paintPreview(); iconField.repaint(); });

    const hasKids = (n.children || []).length > 0;
    const type = segmented([['folder', '資料夾', 'folder'], ['link', '連結', 'link']], draft.node_type, v => {
      if (v === 'link' && hasKids) { toast('這個資料夾裡還有項目，無法改成連結', true); type.setValue('folder'); return; }
      draft.node_type = v; markDirty(); urlRow.hidden = v !== 'link'; paintPreview(); iconField.repaint();
    });

    const url = el('input', { class: 'input', type: 'text', value: draft.url, placeholder: 'https://…　或　C:\\Program Files\\…\\程式.exe', spellcheck: 'false' });
    const newTab = switchCtl(draft.new_tab, '在新分頁開啟', v => { draft.new_tab = v; markDirty(); });
    const argsIn = el('input', { class: 'input mono', value: draft.launch_args, placeholder: '選填' });
    argsIn.addEventListener('input', () => { draft.launch_args = argsIn.value; markDirty(); });
    const cwdIn = el('input', { class: 'input mono', value: draft.launch_cwd, placeholder: '預設為程式所在資料夾' });
    cwdIn.addEventListener('input', () => { draft.launch_cwd = cwdIn.value; markDirty(); });
    const programRow = el('div', { class: 'form-row' }, field('啟動參數', argsIn), field('工作資料夾', cwdIn));
    const syncKind = () => {
      const prog = TT.looksLikePath(url.value);
      programRow.hidden = !prog;
      newTab.hidden = prog;
      url.classList.toggle('mono', prog);
    };
    url.addEventListener('input', () => { draft.url = url.value; markDirty(); syncKind(); });
    const urlRow = el('div', { class: 'field-group' },
      field('網址或程式路徑', url, local.allowed ? '程式只能在執行單機版的這台電腦上啟動' : ''), newTab, programRow);
    urlRow.hidden = draft.node_type !== 'link';
    syncKind();

    const desc = el('textarea', { class: 'textarea', rows: '2', placeholder: '顯示在卡片上的簡短說明（選填）' });
    desc.value = draft.description;
    desc.addEventListener('input', () => { draft.description = desc.value; markDirty(); });

    const iconField = iconButton(draft.icon, () => draft.name, v => { draft.icon = v; markDirty(); paintPreview(); },
      { color: () => draft.color || null, folder: folderNow, auto: draft.node_type === 'link' ? () => autoIcon(url.value) : null });

    const colors = colorPicker(draft.color, v => { draft.color = v; markDirty(); paintPreview(); iconField.repaint(); });

    const parentSel = el('select', { class: 'select' });
    parentSel.append(el('option', { value: '', text: '（最上層）' }));
    const banned = new Set([n.id, ...descendants(n).map(d => d.id)]);
    const addOpts = (nodes, depth) => nodes.forEach(x => {
      if (banned.has(x.id) || !isFolder(x)) return;
      parentSel.append(el('option', { value: x.id, text: `${'　'.repeat(depth)}${x.name}` }));
      addOpts(x.children || [], depth + 1);
    });
    addOpts(state.tree, 0);
    parentSel.value = String(draft.parent);
    parentSel.addEventListener('change', () => { draft.parent = parentSel.value; markDirty(); });

    const active = switchCtl(draft.is_active, '在入口顯示', v => { draft.is_active = v; markDirty(); });

    // actions
    const saveBtn = el('button', { class: 'btn btn-primary', type: 'button', html: svg('check') + '儲存', disabled: true });
    saveBtn.addEventListener('click', save);
    const addChild = el('button', { class: 'btn', type: 'button', html: svg('plus') + '新增子項目' });
    addChild.addEventListener('click', () => createNode(n.id));
    addChild.hidden = !isFolder(n);
    const del = el('button', { class: 'btn btn-danger', type: 'button', html: svg('trash') + '刪除' });
    del.addEventListener('click', async () => {
      const count = descendants(n).length;
      if (!(await confirmDialog(`刪除「${n.name}」？`, count ? `裡面的 ${count} 個項目也會一起刪除，無法復原。` : '刪除後無法復原。', '刪除'))) return;
      try {
        await api(`/api/nodes/${n.id}`, { method: 'DELETE' });
        state.selected = null;
        state.dirty = false;
        await loadTree();
        paintTree();
        paintEditor();
        toast('已刪除');
      } catch (e) { toast(e.message, true); }
    });

    async function save() {
      if (!draft.name.trim()) return toast('請輸入名稱', true);
      if (draft.node_type === 'link' && !/^[a-z][a-z0-9+.-]*:/i.test(draft.url.trim()) && !TT.looksLikePath(draft.url)) return toast('請輸入完整網址（https://…）或程式路徑（C:\\…）', true);
      saveBtn.disabled = true;
      try {
        const newParent = draft.parent === '' ? null : Number(draft.parent);
        if (newParent !== (state.parent.get(n.id)?.id ?? null)) {
          await api(`/api/nodes/${n.id}/move`, { method: 'PUT', body: { new_parent_id: newParent } });
          if (newParent) { state.expanded.add(newParent); saveExpanded(); }
        }
        await api(`/api/nodes/${n.id}`, {
          method: 'PUT', body: {
            name: draft.name.trim(), node_type: draft.node_type,
            url: draft.node_type === 'link' ? draft.url.trim() : null,
            description: draft.description.trim() || null,
            icon: draft.icon || null, color: draft.color || '',
            new_tab: draft.new_tab, is_active: draft.is_active,
            ...(draft.node_type === 'link' && TT.looksLikePath(draft.url)
              ? { launch_args: draft.launch_args.trim() || null, launch_cwd: draft.launch_cwd.trim() || null } : {}),
          },
        });
        state.dirty = false;
        await loadTree();
        paintTree();
        paintEditor();
        toast('已儲存');
      } catch (e) { toast(e.message, true); saveBtn.disabled = false; }
    }

    const form = el('div', { class: 'editor-form' },
      el('div', { class: 'form-row' }, field('名稱', name), el('div', { class: 'field' }, el('span', { class: 'field-label', text: '類型' }), type)),
      urlRow,
      field('說明', desc),
      el('div', { class: 'field' }, el('span', { class: 'field-label', text: '圖示' }), iconField),
      el('div', { class: 'field' }, el('span', { class: 'field-label', text: '顏色' }), colors, el('span', { class: 'hint', text: '資料夾的顏色會套用到裡面沒有自訂顏色的項目' })),
      el('div', { class: 'form-row' }, field('所屬資料夾', parentSel), el('div', { class: 'field' }, el('span', { class: 'field-label', text: '狀態' }), active)));
    form.addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); if (!saveBtn.disabled) save(); } });

    box.replaceChildren(head, form, el('div', { class: 'editor-actions' }, saveBtn, addChild, el('span', { class: 'spacer' }), del));
  }

  /**
   * Create dialog. prefill (from a drop): { kind: 'url'|'app', name, url, icon?, args?, cwd?, found? }
   */
  function createNode(parentId, prefill = null) {
    const app = prefill?.kind === 'app';
    let iconPending = null;   // website icon still being fetched
    const draft = { node_type: 'link', icon: prefill?.icon || '' };
    const parentName = parentId ? state.byId.get(parentId).name : '最上層';
    const name = el('input', { class: 'input', placeholder: '例如：Grafana', maxlength: '200', value: prefill?.name || '' });
    const url = el('input', {
      class: 'input' + (app ? ' mono' : ''), type: 'text', spellcheck: 'false',
      placeholder: 'https://…　或　C:\\Program Files\\…\\程式.exe',
      value: prefill ? (app ? (prefill.found === false ? '' : TT.programPath(prefill.url)) : prefill.url) : '',
    });
    const args = el('input', { class: 'input mono', placeholder: '選填', value: prefill?.args || '' });
    const argsField = field('啟動參數', args);
    const urlField = el('div', { class: 'field-group' },
      field('網址或程式路徑', url, app && prefill.found === false
        ? `在電腦上找不到「${prefill.name}」：請在檔案總管對它按 Shift + 右鍵 →「複製為路徑」，貼到這裡` : ''),
      argsField);
    const syncKind = () => { argsField.hidden = !TT.looksLikePath(url.value); url.classList.toggle('mono', !argsField.hidden); };
    url.addEventListener('input', syncKind);
    syncKind();
    const type = segmented([['link', '連結 / 程式', 'link'], ['folder', '資料夾', 'folder']], 'link', v => { draft.node_type = v; urlField.hidden = v !== 'link'; iconField.repaint(); });
    const desc = el('input', { class: 'input', placeholder: '選填' });
    const iconField = iconButton(draft.icon, () => name.value, v => { draft.icon = v; },
      { folder: () => draft.node_type === 'folder', auto: () => autoIcon(url.value) });
    name.addEventListener('input', () => iconField.repaint());

    // dropped web link: icon from the library, else the site's own icon
    if (prefill && !app && !draft.icon) {
      const guess = TT.guessIcon(prefill.url, prefill.name, state.icons.map(i => i.name));
      if (guess) iconField.set(guess);
      else {
        iconPending = TT.fetchSiteIcon(prefill.url).then(icon => {
          if (icon && !draft.icon) { iconField.set(icon); loadIcons(); }
          iconPending = null;
        });
      }
    }
    // program dropped without a known path: fill name/icon once a path is pasted
    url.addEventListener('change', async () => {
      if (!TT.looksLikePath(url.value) || draft.icon) return;
      try {
        const r = await api('/api/local/inspect', { method: 'POST', body: { path: url.value.trim() } });
        if (r.icon) iconField.set(r.icon);
        if (!name.value.trim() && r.name) { name.value = r.name; iconField.repaint(); }
      } catch (e) { toast(e.message, true); }
    });

    const ok = el('button', { class: 'btn btn-primary', type: 'button', html: svg('plus') + '建立' });
    const cancel = el('button', { class: 'btn btn-ghost', type: 'button', text: '取消' });
    const what = app ? '程式' : prefill ? '網址' : '';
    const close = modal({
      title: what ? `把${what}新增到「${parentName}」` : `新增到「${parentName}」`,
      body: el('div', { class: 'stack' }, el('div', { class: 'field' }, el('span', { class: 'field-label', text: '類型' }), type), field('名稱', name), urlField, field('說明', desc), el('div', { class: 'field' }, el('span', { class: 'field-label', text: '圖示' }), iconField)),
      actions: [cancel, ok],
    });
    if (app && prefill.found === false) setTimeout(() => url.focus(), 60);
    cancel.addEventListener('click', () => close());
    const submit = async () => {
      const target = url.value.trim();
      const program = TT.looksLikePath(target);
      if (!name.value.trim()) return toast('請輸入名稱', true);
      if (draft.node_type === 'link' && !program && !/^[a-z][a-z0-9+.-]*:/i.test(target)) return toast('請輸入完整網址（https://…）或程式路徑（C:\\…）', true);
      if (iconPending) {                       // don't create the item before its icon arrives
        ok.disabled = true;
        ok.textContent = '取得圖示中…';
        await Promise.race([iconPending, new Promise(r => setTimeout(r, 12000))]);
        ok.disabled = false;
      }
      try {
        const created = await api('/api/nodes', {
          method: 'POST', body: {
            parent_id: parentId, name: name.value.trim(), node_type: draft.node_type,
            url: draft.node_type === 'link' ? target : null,
            icon: draft.icon || null, description: desc.value.trim() || null,
            ...(draft.node_type === 'link' && program ? { launch_args: args.value.trim() || null, launch_cwd: prefill?.cwd || null } : {}),
          },
        });
        close();
        if (parentId) { state.expanded.add(parentId); saveExpanded(); }
        await Promise.all([loadTree(), loadIcons()]);
        state.selected = created.id;
        state.dirty = false;
        paintTree();
        paintEditor();
        document.querySelector(`.arow[data-id="${created.id}"]`)?.scrollIntoView({ block: 'nearest' });
        toast('已建立');
      } catch (e) { toast(e.message, true); }
    };
    ok.addEventListener('click', submit);
    [name, url, desc, args].forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }));
  }

  // ======================================================================
  // Save bar (settings-like panels)
  // ======================================================================
  function saveBar(onSave, onRevert) {
    const save = el('button', { class: 'btn btn-primary', type: 'button', html: svg('check') + '儲存變更' });
    const revert = el('button', { class: 'btn btn-ghost', type: 'button', text: '還原' });
    const bar = el('div', { class: 'savebar' }, el('span', { class: 'savebar-text', html: `${svg('edit')}<span>有尚未儲存的變更</span>` }), revert, save);
    save.addEventListener('click', async () => {
      save.disabled = true;
      try { await onSave(); state.dirty = false; bar.classList.remove('show'); toast('已儲存'); }
      catch (e) { toast(e.message, true); }
      finally { save.disabled = false; }
    });
    revert.addEventListener('click', () => { state.dirty = false; bar.classList.remove('show'); onRevert(); });
    bar.mark = () => { state.dirty = true; bar.classList.add('show'); };
    return bar;
  }

  async function saveSettings(values) {
    state.settings = await api('/api/settings', { method: 'PUT', body: { values } });
    TT.applyAppearance(state.settings);
    paintBrand();
  }

  // ======================================================================
  // Panel: home layout
  // ======================================================================
  const SECTION_INFO = {
    message: { icon: 'megaphone', label: '公告', desc: '一段文字公告' },
    quick_links: { icon: 'zap', label: '快速連結', desc: '「快速連結」頁面管理的按鈕列' },
    favorites: { icon: 'star', label: '我的最愛', desc: '每位使用者自己收藏的連結（存在瀏覽器）' },
    recent: { icon: 'history', label: '最近使用', desc: '每位使用者最近開過的連結（存在瀏覽器）' },
    roots: { icon: 'layout', label: '所有分類', desc: '最上層的資料夾卡片' },
    folder: { icon: 'folder', label: '指定資料夾', desc: '把某個資料夾的內容直接攤在首頁' },
  };

  function renderHome() {
    const s = state.settings;
    let draft = {
      home_sections: structuredClone(s.home_sections || []),
      home_message: s.home_message || '',
      quick_links_title: s.quick_links_title || '',
      quick_links_icon: s.quick_links_icon || '',
    };
    const bar = saveBar(() => saveSettings(draft), () => { draft = { ...draft, home_sections: structuredClone(state.settings.home_sections || []), home_message: state.settings.home_message, quick_links_title: state.settings.quick_links_title, quick_links_icon: state.settings.quick_links_icon }; paint(); });
    const list = el('div', { class: 'sections-list' });

    const folderOptions = () => {
      const sel = [];
      const walk = (nodes, depth) => nodes.forEach(n => { if (isFolder(n)) { sel.push([n.id, '　'.repeat(depth) + n.name]); walk(n.children || [], depth + 1); } });
      walk(state.tree, 0);
      return sel;
    };

    const paint = () => {
      list.replaceChildren(...draft.home_sections.map((sec, i) => {
        const info = SECTION_INFO[sec.type];
        const up = el('button', { class: 'icon-btn', type: 'button', title: '上移', html: svg('chevron-up'), disabled: i === 0 });
        const down = el('button', { class: 'icon-btn', type: 'button', title: '下移', html: svg('chevron-down'), disabled: i === draft.home_sections.length - 1 });
        const remove = el('button', { class: 'icon-btn danger', type: 'button', title: '移除', html: svg('trash') });
        up.addEventListener('click', () => { [draft.home_sections[i - 1], draft.home_sections[i]] = [draft.home_sections[i], draft.home_sections[i - 1]]; bar.mark(); paint(); });
        down.addEventListener('click', () => { [draft.home_sections[i + 1], draft.home_sections[i]] = [draft.home_sections[i], draft.home_sections[i + 1]]; bar.mark(); paint(); });
        remove.addEventListener('click', () => { draft.home_sections.splice(i, 1); bar.mark(); paint(); });

        const title = el('input', { class: 'input', placeholder: `標題（預設：${sec.type === 'folder' ? '資料夾名稱' : sec.type === 'quick_links' ? (draft.quick_links_title || info.label) : info.label}）`, value: sec.title || '' });
        title.addEventListener('input', () => { sec.title = title.value; bar.mark(); });
        const opts = el('div', { class: 'section-opts' }, field('標題', title));

        if (sec.type === 'folder') {
          const sel = el('select', { class: 'select' });
          folderOptions().forEach(([id, label]) => sel.append(el('option', { value: id, text: label })));
          if (!sec.node_id && sel.options.length) sec.node_id = Number(sel.value);
          sel.value = sec.node_id;
          sel.addEventListener('change', () => { sec.node_id = Number(sel.value); bar.mark(); });
          opts.append(field('資料夾', sel));
        }
        if (sec.type === 'folder' || sec.type === 'roots') {
          opts.append(el('div', { class: 'field' }, el('span', { class: 'field-label', text: '卡片大小' }),
            segmented([['grid', '一般'], ['compact', '精簡']], sec.style || 'grid', v => { sec.style = v; bar.mark(); })));
        }
        if (['favorites', 'recent', 'folder'].includes(sec.type)) {
          const lim = el('input', { class: 'input', type: 'number', min: '1', max: '99', placeholder: '不限', value: sec.limit || '' });
          lim.addEventListener('input', () => { sec.limit = parseInt(lim.value, 10) || undefined; bar.mark(); });
          opts.append(field('最多顯示', lim));
        }
        if (sec.type === 'message') {
          const msg = el('textarea', { class: 'textarea', rows: '3', placeholder: '公告內容（空白時不顯示）' });
          msg.value = draft.home_message;
          msg.addEventListener('input', () => { draft.home_message = msg.value; bar.mark(); });
          opts.append(el('div', { class: 'span-all' }, field('內容', msg)));
        }
        if (sec.type === 'quick_links') {
          const qt = el('input', { class: 'input', value: draft.quick_links_title, placeholder: '快速連結' });
          qt.addEventListener('input', () => { draft.quick_links_title = qt.value; bar.mark(); });
          const qi = el('input', { class: 'input emoji-input', value: draft.quick_links_icon, maxlength: '8', placeholder: '⚡' });
          qi.addEventListener('input', () => { draft.quick_links_icon = qi.value; bar.mark(); });
          opts.append(field('預設名稱', qt), field('圖示（emoji）', qi));
        }

        return el('div', { class: 'section-card panel' },
          el('div', { class: 'section-card-head' },
            el('span', { class: 'section-num', text: i + 1 }),
            el('span', { class: 'section-card-icon', html: svg(info.icon) }),
            el('div', { class: 'section-card-title' }, el('strong', { text: info.label }), el('span', { class: 'hint', text: info.desc })),
            el('div', { class: 'section-card-tools' }, up, down, remove)),
          opts);
      }));
      if (!draft.home_sections.length) list.append(el('div', { class: 'empty small' }, el('div', { class: 'empty-icon', text: '🧩' }), el('h3', { text: '首頁目前是空的' }), el('p', { text: '從下面加入區塊。' })));
    };

    const adders = el('div', { class: 'section-adders' }, Object.entries(SECTION_INFO).map(([type, info]) => {
      const b = el('button', { class: 'adder', type: 'button' },
        el('span', { class: 'adder-icon', html: svg(info.icon) }),
        el('span', {}, el('strong', { text: info.label }), el('small', { text: info.desc })));
      b.addEventListener('click', () => {
        const sec = { type };
        if (type === 'folder') { const first = folderOptions()[0]; if (!first) return toast('還沒有任何資料夾', true); sec.node_id = first[0]; }
        draft.home_sections.push(sec);
        bar.mark();
        paint();
        list.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      return b;
    }));

    const preview = el('a', { class: 'btn', href: '/', target: '_blank', rel: 'noopener', html: svg('external') + '預覽首頁' });
    $('stage-actions').append(preview);
    $('stage-body').append(list, el('h3', { class: 'sub-head', text: '加入區塊' }), adders, bar);
    paint();
  }

  // ======================================================================
  // Panel: quick links
  // ======================================================================
  async function renderQuick() {
    const add = el('button', { class: 'btn btn-primary', type: 'button', html: svg('plus') + '新增連結' });
    add.addEventListener('click', () => editQuick(null));
    $('stage-actions').append(add);
    const box = el('div', { class: 'quick-admin' });
    $('stage-body').append(box);
    const body = $('stage-body');
    body.addEventListener('dragover', e => { if (TT.isLinkDrag(e) || TT.isFileDrag(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
    body.addEventListener('drop', e => {
      if (TT.isFileDrag(e)) { e.preventDefault(); linkDropHandled = true; toast('快速連結只能放網址；程式請拖到「內容」', true); return; }
      if (!TT.isLinkDrag(e)) return;
      const link = takeDroppedLink(e);
      if (link) editQuick(null, link);
    });

    const paint = async () => {
      state.links = await api('/api/auth-links/all');
      const label = state.settings.quick_links_group_label || '群組';
      const groups = new Map();
      state.links.forEach(l => { const g = l.region || ''; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(l); });
      const keys = [...groups.keys()].sort((a, b) => (!a) - (!b) || a.localeCompare(b));
      box.replaceChildren(...keys.map(g => el('section', { class: 'panel quick-group-panel' },
        el('div', { class: 'quick-group-head' }, el('strong', { text: g || `未分${label}` }), el('span', { class: 'badge', text: groups.get(g).length })),
        el('div', { class: 'qlist' }, groups.get(g).map(l => {
          const edit = el('button', { class: 'icon-btn', type: 'button', title: '編輯', html: svg('edit') });
          edit.addEventListener('click', () => editQuick(l));
          const del = el('button', { class: 'icon-btn danger', type: 'button', title: '刪除', html: svg('trash') });
          del.addEventListener('click', async () => {
            if (!(await confirmDialog(`刪除「${l.name}」？`, l.url, '刪除'))) return;
            try { await api(`/api/auth-links/${l.id}`, { method: 'DELETE' }); toast('已刪除'); paint(); } catch (e) { toast(e.message, true); }
          });
          return el('div', { class: 'qrow' + (l.is_active ? '' : ' inactive') },
            el('span', { class: 'chip-dot' }),
            el('div', { class: 'qrow-text' }, el('strong', { text: l.name }), el('a', { class: 'hint', href: l.url, target: '_blank', rel: 'noopener', text: l.url })),
            l.is_active ? null : el('span', { class: 'atag', html: svg('eye-off') }),
            edit, del);
        })))));
      if (!state.links.length) box.append(el('div', { class: 'empty' }, el('div', { class: 'empty-icon', html: svg('zap') }), el('h3', { text: '還沒有快速連結' }), el('p', { text: '常用、需要一鍵直達的網址（例如上網驗證、VPN）適合放這裡。' })));
    };

    function editQuick(l, prefill = null) {
      const label = state.settings.quick_links_group_label || '群組';
      const groups = [...new Set(state.links.map(x => x.region).filter(Boolean))];
      const dl = el('datalist', { id: 'ql-groups' }, groups.map(g => el('option', { value: g })));
      const region = el('input', { class: 'input', list: 'ql-groups', value: l?.region || '', placeholder: '選填' });
      const name = el('input', { class: 'input', value: l?.name || prefill?.title || '' });
      const url = el('input', { class: 'input', type: 'url', value: l?.url || prefill?.url || '', placeholder: 'https://' });
      const sort = el('input', { class: 'input', type: 'number', value: l?.sort_order ?? 0 });
      let active = l ? !!l.is_active : true;
      const ok = el('button', { class: 'btn btn-primary', type: 'button', text: '儲存' });
      const cancel = el('button', { class: 'btn btn-ghost', type: 'button', text: '取消' });
      const close = modal({
        title: l ? '編輯快速連結' : '新增快速連結',
        body: el('div', { class: 'stack' }, dl, field('名稱', name), field('網址', url),
          el('div', { class: 'form-row' }, field(label, region), field('排序', sort, '數字小的在前')),
          switchCtl(active, '在首頁顯示', v => { active = v; })),
        actions: [cancel, ok],
      });
      cancel.addEventListener('click', () => close());
      ok.addEventListener('click', async () => {
        if (!name.value.trim() || !url.value.trim()) return toast('請填寫名稱與網址', true);
        const body = { region: region.value.trim(), name: name.value.trim(), url: url.value.trim(), sort_order: parseInt(sort.value, 10) || 0, is_active: active };
        try {
          await api(l ? `/api/auth-links/${l.id}` : '/api/auth-links', { method: l ? 'PUT' : 'POST', body });
          close(); toast('已儲存'); paint();
        } catch (e) { toast(e.message, true); }
      });
    }

    await paint();
  }

  // ======================================================================
  // Panel: icons
  // ======================================================================
  function renderIcons() {
    const input = el('input', { type: 'file', accept: '.png,.jpg,.jpeg,.svg,.webp,.gif', multiple: true, hidden: true });
    const upBtn = el('button', { class: 'btn btn-primary', type: 'button', html: svg('upload') + '上傳圖示' });
    upBtn.addEventListener('click', () => input.click());
    input.addEventListener('change', async () => { await uploadIcons(input.files); input.value = ''; paint(); });
    $('stage-actions').append(upBtn, input);

    const search = el('input', { class: 'input', type: 'search', placeholder: '搜尋檔名…' });
    const drop = el('div', { class: 'dropzone', html: `${svg('upload')}<span>把圖片拖到這裡上傳（PNG / JPG / SVG / WebP / GIF，5 MB 內）</span>` });
    drop.addEventListener('click', () => input.click());
    ['dragenter', 'dragover'].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add('over'); }));
    ['dragleave', 'drop'].forEach(ev => drop.addEventListener(ev, () => drop.classList.remove('over')));
    drop.addEventListener('drop', async e => { e.preventDefault(); await uploadIcons(e.dataTransfer.files); paint(); });

    const grid = el('div', { class: 'icon-gallery' });
    const count = el('span', { class: 'hint' });
    search.addEventListener('input', () => paint());
    $('stage-body').append(drop, el('div', { class: 'gallery-tools' }, search, count), grid);

    function paint() {
      const usage = iconUsage();
      const q = search.value.trim().toLowerCase();
      const list = state.icons.filter(i => !q || i.name.toLowerCase().includes(q));
      count.textContent = `${list.length} / ${state.icons.length} 個`;
      grid.replaceChildren(...list.map(i => {
        const used = usage.get(i.name) || 0;
        const rename = el('button', { class: 'icon-btn', type: 'button', title: '重新命名', html: svg('edit') });
        rename.addEventListener('click', () => renameIcon(i.name));
        const del = el('button', { class: 'icon-btn danger', type: 'button', title: used ? `使用中（${used}）無法刪除` : '刪除', html: svg('trash'), disabled: used > 0 });
        del.addEventListener('click', async () => {
          if (!(await confirmDialog(`刪除圖示「${i.name}」？`, '刪除後無法復原。', '刪除'))) return;
          try { await api(`/api/icons/${encodeURIComponent(i.name)}`, { method: 'DELETE' }); await loadIcons(); paint(); toast('已刪除'); } catch (e) { toast(e.message, true); }
        });
        return el('div', { class: 'icon-card panel' },
          el('div', { class: 'icon-card-img' }, el('img', { src: TT.iconUrl(i.name), alt: '', loading: 'lazy' })),
          el('div', { class: 'icon-card-name', title: i.name, text: i.name }),
          el('div', { class: 'icon-card-meta' },
            el('span', { text: `${(i.size / 1024).toFixed(i.size < 10240 ? 1 : 0)} KB` }),
            used ? el('span', { class: 'badge', text: `使用中 ${used}` }) : el('span', { class: 'hint', text: '未使用' })),
          el('div', { class: 'icon-card-tools' }, rename, del));
      }));
    }

    async function renameIcon(name) {
      const input = el('input', { class: 'input', value: name });
      const ok = el('button', { class: 'btn btn-primary', type: 'button', text: '重新命名' });
      const cancel = el('button', { class: 'btn btn-ghost', type: 'button', text: '取消' });
      const close = modal({ title: '重新命名圖示', body: field('新檔名（含副檔名）', input, '使用這個圖示的項目會自動更新'), actions: [cancel, ok] });
      cancel.addEventListener('click', () => close());
      ok.addEventListener('click', async () => {
        const v = input.value.trim();
        if (!v || v === name) return close();
        try {
          await api(`/api/icons/${encodeURIComponent(name)}?new_name=${encodeURIComponent(v)}`, { method: 'PUT' });
          close(); await Promise.all([loadIcons(), loadTree()]); paint(); toast('已重新命名');
        } catch (e) { toast(e.message, true); }
      });
    }
    paint();
  }

  // ======================================================================
  // Panel: settings
  // ======================================================================
  const SETTINGS_GROUPS = [
    { title: '品牌', icon: 'sparkles', fields: [
      { key: 'site_title', label: '網站名稱', type: 'text' },
      { key: 'site_subtitle', label: '副標題', type: 'text', placeholder: '顯示在名稱下方（選填）' },
      { key: 'favicon', label: '網站圖示', type: 'icon', hint: '頁首與瀏覽器分頁都會使用' },
    ] },
    { title: '外觀', icon: 'palette', fields: [
      { key: 'theme', label: '預設主題', type: 'seg', options: [['auto', '跟隨系統', 'monitor'], ['light', '淺色', 'sun'], ['dark', '深色', 'moon']], hint: '使用者仍可自行切換' },
      { key: 'accent_color', label: '主題色', type: 'accent' },
      { key: 'background', label: '背景', type: 'seg', options: [['aurora', '極光'], ['gradient', '漸層'], ['plain', '純色']] },
      { key: 'density', label: '卡片密度', type: 'seg', options: [['comfortable', '舒適'], ['compact', '緊湊']] },
      { key: 'default_view', label: '預設顯示方式', type: 'seg', options: [['grid', '格狀', 'grid'], ['list', '清單', 'list']] },
    ] },
    { title: '頁首', icon: 'monitor', fields: [
      { key: 'show_clock', label: '顯示時鐘', type: 'switch' },
      { key: 'clock_style', label: '時鐘樣式', type: 'seg', options: [['flip', '翻頁'], ['simple', '簡潔']] },
      { key: 'clock_show_seconds', label: '顯示秒數', type: 'switch' },
      { key: 'show_client_ip', label: '顯示使用者 IP（本伺服器看到的位址）', type: 'switch' },
      { key: 'show_public_ip', label: '顯示對外 IP 與所在地（瀏覽器會連線 ipinfo.io）', type: 'switch' },
      { key: 'show_admin_button', label: '顯示 ⚙ 後台按鈕', type: 'switch', hint: '關閉時：快速點 Logo 或時鐘 5 次進入後台' },
    ] },
    { title: '導覽與搜尋', icon: 'search', fields: [
      { key: 'search_placeholder', label: '搜尋框提示文字', type: 'text' },
      { key: 'sidebar_show_icons', label: '側邊欄顯示圖示', type: 'switch' },
      { key: 'sidebar_show_counts', label: '側邊欄顯示項目數', type: 'switch' },
      { key: 'sidebar_show_links', label: '側邊欄也列出連結（不只資料夾）', type: 'switch' },
      { key: 'show_quick_filters', label: '顯示快速篩選', type: 'switch' },
      { key: 'quick_filters_title', label: '快速篩選標題', type: 'text' },
      { key: 'quick_filters', label: '快速篩選項目', type: 'filters', hint: '留空＝自動列出最常用的圖示' },
      { key: 'quick_filters_auto_limit', label: '自動產生時最多幾個', type: 'number' },
    ] },
    { title: '卡片與個人化', icon: 'grid', fields: [
      { key: 'show_descriptions', label: '顯示說明文字', type: 'switch' },
      { key: 'show_link_host', label: '顯示連結網域', type: 'switch' },
      { key: 'open_links_in_new_tab', label: '連結預設在新分頁開啟', type: 'switch' },
      { key: 'enable_favorites', label: '啟用「我的最愛」', type: 'switch' },
      { key: 'enable_recent', label: '啟用「最近使用」', type: 'switch' },
      { key: 'favicon_web_fallback', label: '抓不到網站圖示時，改向 Google / DuckDuckGo 圖示服務取得', type: 'switch', hint: '只用於公開網站；內網網址不會送出' },
      { key: 'allow_drop_add', label: '允許在入口直接拖曳網址新增', type: 'switch', hint: '從瀏覽器網址列、網頁連結或書籤拖到入口頁面' },
      { key: 'quick_links_group_label', label: '快速連結的「群組」名稱', type: 'text', placeholder: '例如：區域、部門' },
    ] },
  ];

  function renderSettings() {
    const keys = SETTINGS_GROUPS.flatMap(g => g.fields.map(f => f.key));
    let draft = Object.fromEntries(keys.map(k => [k, structuredClone(state.settings[k])]));
    const bar = saveBar(
      async () => { await saveSettings(draft); },
      () => { TT.applyAppearance(state.settings); paintBrand(); renderSettings0(); });

    const reset = el('button', { class: 'btn btn-ghost', type: 'button', html: svg('refresh') + '全部還原預設' });
    reset.addEventListener('click', async () => {
      if (!(await confirmDialog('還原預設設定？', '所有外觀與設定（含首頁版面）會回到預設值，內容資料不受影響。', '還原'))) return;
      state.settings = await api('/api/settings/reset', { method: 'POST' });
      TT.applyAppearance(state.settings); paintBrand(); state.dirty = false; renderSettings0(); toast('已還原預設');
    });
    $('stage-actions').append(reset);

    const holder = el('div', { class: 'settings-grid' });
    $('stage-body').append(holder, bar);

    const livePreview = () => TT.applyAppearance({ ...state.settings, ...draft });
    const set = (k, v) => { draft[k] = v; bar.mark(); if (['theme', 'accent_color', 'background', 'density'].includes(k)) livePreview(); };

    function control(f) {
      const v = draft[f.key];
      switch (f.type) {
        case 'switch': return switchCtl(v, f.label, x => set(f.key, x));
        case 'text': { const i = el('input', { class: 'input', value: v ?? '', placeholder: f.placeholder || '' }); i.addEventListener('input', () => set(f.key, i.value)); return field(f.label, i, f.hint); }
        case 'number': { const i = el('input', { class: 'input', type: 'number', min: '1', value: v ?? '' }); i.addEventListener('input', () => set(f.key, parseInt(i.value, 10) || 1)); return field(f.label, i, f.hint); }
        case 'seg': return el('div', { class: 'field' }, el('span', { class: 'field-label', text: f.label }), segmented(f.options, v, x => set(f.key, x)), f.hint ? el('span', { class: 'hint', text: f.hint }) : null);
        case 'accent': {
          const pick = colorPicker(v, x => set(f.key, x || state.defaults.accent_color));
          pick.querySelector('.swatch-none')?.remove();
          return el('div', { class: 'field' }, el('span', { class: 'field-label', text: f.label }), pick);
        }
        case 'icon': return el('div', { class: 'field' }, el('span', { class: 'field-label', text: f.label }),
          iconButton(v, () => draft.site_title || 'T', x => set(f.key, x)), f.hint ? el('span', { class: 'hint', text: f.hint }) : null);
        case 'filters': return el('div', { class: 'field span-all' }, el('span', { class: 'field-label', text: f.label }), filtersEditor(v || [], x => set(f.key, x)), el('span', { class: 'hint', text: f.hint }));
        default: return el('span');
      }
    }

    function renderSettings0() {
      draft = Object.fromEntries(keys.map(k => [k, structuredClone(state.settings[k])]));
      holder.replaceChildren(...SETTINGS_GROUPS.map(g => el('section', { class: 'panel settings-card' },
        el('h3', { class: 'settings-card-title', html: svg(g.icon) + esc(g.title) }),
        el('div', { class: 'settings-fields' }, g.fields.map(control)))));
    }
    renderSettings0();
  }

  function filtersEditor(list, onChange) {
    const items = list.map(f => ({ ...f }));
    const box = el('div', { class: 'filters-editor' });
    const paint = () => {
      box.replaceChildren(...items.map((f, i) => {
        const label = el('input', { class: 'input', value: f.label || '', placeholder: '顯示名稱' });
        label.addEventListener('input', () => { f.label = label.value; onChange(items); });
        const iconBtn = el('button', { class: 'btn btn-sm filter-icon-btn', type: 'button' }, tile({ icon: f.icon, name: f.label, size: 22 }), el('span', { text: f.icon || '選擇圖示' }));
        iconBtn.addEventListener('click', async () => { const v = await pickIcon(f.icon); if (v) { f.icon = v; onChange(items); paint(); } });
        const del = el('button', { class: 'icon-btn danger', type: 'button', html: svg('trash'), title: '移除' });
        del.addEventListener('click', () => { items.splice(i, 1); onChange(items); paint(); });
        return el('div', { class: 'filter-row' }, iconBtn, label, del);
      }));
      const add = el('button', { class: 'btn btn-sm', type: 'button', html: svg('plus') + '新增篩選' });
      add.addEventListener('click', async () => {
        const v = await pickIcon('');
        if (!v) return;
        items.push({ icon: v, label: '' });
        onChange(items);
        paint();
      });
      box.append(add);
    };
    paint();
    return box;
  }

  // ======================================================================
  // Panel: backup
  // ======================================================================
  function renderBackup() {
    const exportBtn = el('button', { class: 'btn btn-primary', type: 'button', html: svg('download') + '下載 JSON' });
    exportBtn.addEventListener('click', async () => {
      try {
        const data = await api('/api/export');
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const a = el('a', { href: URL.createObjectURL(blob), download: `tool-table-${new Date().toISOString().slice(0, 10)}.json` });
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        toast('已匯出');
      } catch (e) { toast(e.message, true); }
    });

    const file = el('input', { type: 'file', accept: '.json,application/json', hidden: true });
    let mode = 'replace';
    const pick = m => { mode = m; file.click(); };
    const replaceBtn = el('button', { class: 'btn btn-danger', type: 'button', html: svg('upload') + '匯入並取代全部' });
    replaceBtn.addEventListener('click', () => pick('replace'));
    const appendBtn = el('button', { class: 'btn', type: 'button', html: svg('plus') + '匯入並附加' });
    appendBtn.addEventListener('click', () => pick('append'));
    file.addEventListener('change', async () => {
      const f = file.files[0];
      file.value = '';
      if (!f) return;
      let data;
      try { data = JSON.parse(await f.text()); } catch { return toast('不是有效的 JSON 檔', true); }
      const nodes = (function count(list) { return (list || []).reduce((s, n) => s + 1 + count(n.children), 0); })(data.nodes);
      const msg = mode === 'replace'
        ? `會刪除目前所有內容、快速連結與設定，換成檔案中的 ${nodes} 個項目。建議先下載備份。`
        : `會把檔案中的 ${nodes} 個項目與快速連結加到現有內容後面；檔案裡的設定會覆蓋目前設定。`;
      if (!(await confirmDialog(mode === 'replace' ? '取代全部內容？' : '附加匯入？', msg, mode === 'replace' ? '取代' : '匯入', mode === 'replace'))) return;
      try {
        const r = await api('/api/import', { method: 'POST', body: { data, replace: mode === 'replace' } });
        state.settings = await api('/api/settings');
        TT.applyAppearance(state.settings); paintBrand();
        state.selected = null;
        await loadTree();
        toast(`匯入完成：${r.nodes} 個項目、${r.quick_links} 個快速連結`);
      } catch (e) { toast(e.message, true); }
    });

    const card = (icon, title, text, ...actions) => el('section', { class: 'panel backup-card' },
      el('span', { class: 'backup-icon', html: svg(icon) }),
      el('div', { class: 'backup-text' }, el('h3', { text: title }), el('p', { text })),
      el('div', { class: 'backup-actions' }, actions));

    $('stage-body').append(el('div', { class: 'backup-grid' },
      card('download', '匯出', '設定、首頁版面、所有資料夾與連結、快速連結，打包成一個 JSON。可用來備份、搬家，或做成範本給別人直接套用。（圖示檔案不包含在內）', exportBtn),
      card('upload', '匯入', '從 JSON 匯入。「取代全部」會先清空；「附加」會加在現有內容之後。', appendBtn, replaceBtn, file)));
  }
})();
