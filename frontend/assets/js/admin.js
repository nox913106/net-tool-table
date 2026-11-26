/* =============================================================================
   IPMS — admin
   Panels (hash): 入口網站 #content #home #quick #icons #settings
                  系統設定 (same tabs as CFXD_DailyReportDocSys) #status #auth #users #audit #backup #tls #delivery #ai #sysinfo #versions
   ============================================================================= */
'use strict';

(() => {
  const { el, svg, esc, tile, api, store, toast } = TT;
  const $ = id => document.getElementById(id);

  const COLORS = ['#6366f1', '#3b82f6', '#06b6d4', '#10b981', '#22c55e', '#84cc16', '#eab308', '#f97316', '#ef4444', '#ec4899', '#a855f7', '#64748b'];
  const EMOJI = ['📁', '📂', '🗂️', '📊', '📈', '📉', '🖥️', '💻', '🖧', '🌐', '🔐', '🔑', '🛡️', '🔥', '⚙️', '🧰', '🛠️', '🔧', '📡', '📶', '☁️', '🗄️', '💾', '🧪',
    '📚', '📘', '📝', '📋', '📌', '🗺️', '🧭', '🏢', '🏭', '🏠', '👥', '💬', '📧', '📞', '🎫', '🚀', '⭐', '❤️', '✅', '⚠️', '🧠', '🤖', '🎨', '🎬'];

  const PANELS = [
    { id: 'content', group: 'portal', icon: 'folder', label: _t('內容'), desc: _t('資料夾與連結。拖曳可排序或移到別的資料夾。') },
    { id: 'home', icon: 'layout', label: _t('首頁版面'), desc: _t('首頁要顯示哪些區塊、順序如何。') },
    { id: 'quick', icon: 'zap', label: _t('快速連結'), desc: _t('首頁上方的快捷按鈕列，可依群組分組。') },
    { id: 'icons', icon: 'image', label: _t('圖示'), desc: _t('上傳、改名、刪除圖示。') },
    { id: 'settings', icon: 'palette', label: _t('外觀與設定'), desc: _t('品牌、配色、頁首元件、導覽與卡片。') },
    { id: 'status', group: 'system', icon: 'zap', label: _t('系統狀態'), desc: _t('健康檢查、最近的維護工作與安裝時決定的項目。所有設定都在後台完成，儲存後立即套用，不需要登入主機；每一項變更都記錄在「稽核紀錄」。') },
    { id: 'auth', icon: 'lock', label: _t('AD 驗證'), desc: _t('AD（LDAP）登入、Microsoft Entra ID 登入與登入安全。'), auth: true },
    { id: 'users', icon: 'users', label: _t('帳號管理'), desc: _t('AD 帳號第一次登入後會出現在這裡，預設是「訪客」（只能看入口連結）；在這裡開通為「使用者」或指定管理員。'), auth: true },
    { id: 'audit', icon: 'list', label: _t('稽核紀錄'), desc: _t('誰在什麼時候做了什麼：登入、帳號權限、系統設定、備份還原、憑證、匯入匯出、刪除卡片。不能在畫面上修改或刪除。') },
    { id: 'backup', icon: 'database', label: _t('備份還原'), desc: _t('自動與手動備份、下載、還原；入口內容匯出成 JSON 或從 JSON 匯入；示範資料。') },
    { id: 'tls', icon: 'globe', label: _t('HTTPS 憑證'), desc: _t('目前的憑證、更換憑證、連線埠與伺服器名稱。') },
    { id: 'delivery', icon: 'megaphone', label: _t('發送與通知'), desc: _t('Microsoft Teams 頻道：卡片異動、專案事件、系統與硬體警示、定時狀態報告。'), auth: true },
    { id: 'ai', icon: 'sparkles', label: _t('AI 接入點'), desc: _t('雲端與地端的 AI 服務，可同時接入多種模型：依優先順序備援，或並行比較。') },
    { id: 'sysinfo', icon: 'monitor', label: _t('系統資訊'), desc: _t('硬體、作業系統、執行環境、服務、系統套件與 Python 套件（每次開頁即時讀取）。') },
    { id: 'versions', icon: 'history', label: _t('版本紀錄'), desc: _t('目前版本、GitHub 上的新版與升級、全部版本的變更內容。') },
  ];
  const GROUPS = { portal: _t('入口網站'), system: _t('系統設定') };
  const ALIAS = { system: 'status' };            // older links (#system) → 系統狀態

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
      $('stage').replaceChildren(el('div', { class: 'empty' }, el('div', { class: 'empty-icon', text: '⚠️' }), el('h3', { text: _t('無法連線到後端') }), el('p', { text: e.message })));
      return;
    }
    TTI18n.site(state.settings.language || 'zh-TW');
    TT.applyAppearance(state.settings);
    state.me = await TT.me();
    paintBrand();
    buildRail();
    if (state.me.auth) {
      const host = el('div', { class: 'rail-user', id: 'rail-user' });
      $('rail').querySelector('.rail-foot').before(host);
      TT.userMenu(host);
      if (state.me.needs_ad_admin) {
        const bar = el('a', { class: 'notice-bar admin-notice', href: '#users', html: svg('lock') + _t('<span>還沒有任何 AD 帳號是管理員。請到「帳號管理」至少指定一位 AD 管理員；本機管理員帳號只留作緊急使用。</span>') });
        document.body.append(bar);
      }
    }
    healthBanner();

    const themeBtn = $('theme-btn');
    themeBtn.before(TT.langButton());
    const paintTheme = () => {
      const pref = TT.themePref(state.settings);
      themeBtn.innerHTML = svg(pref === 'auto' ? 'monitor' : pref === 'light' ? 'sun' : 'moon');
      themeBtn.title = _t("主題：{0}", { auto: _t('跟隨系統'), light: _t('淺色'), dark: _t('深色') }[pref]);
    };
    themeBtn.addEventListener('click', () => { TT.cycleTheme(state.settings); paintTheme(); });
    paintTheme();
    $('open-portal').innerHTML = svg('arrow-left') + _t('<span>返回入口</span>');
    // API documentation (Swagger UI): shown when this server serves it
    const docs = $('api-docs');
    if (docs) {
      docs.innerHTML = svg('file');
      fetch('/docs', { method: 'HEAD', credentials: 'same-origin', redirect: 'manual' }).then(r => { docs.hidden = !r.ok; }).catch(() => {});
    }

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
        content: _t('放到資料夾上＝新增到該資料夾；放在其他地方＝新增到最上層'),
        quick: files ? _t('快速連結只能放網址，程式請拖到「內容」') : _t('放開即可新增為快速連結'),
      }[currentPanel] || _t('請先切到「內容」或「快速連結」再拖放'))}</span>`;
      const zone = document.querySelector('.atree-root-drop');
      if (zone) zone.textContent = _t('放到這裡：新增到最上層');
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
        if (files && !local.allowed) toast(local.enabled ? _t('拖曳程式只能在執行單機版的那台電腦上使用') : _t('拖曳程式需要 Windows 單機版'), true);
        else toast(_t('請先切到「內容」或「快速連結」再拖放'), true);
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
    if (!link) toast(_t('沒有讀到可用的網址（只支援 http / https）'), true);
    return link;
  }

  /** Handle a drop (link or local file) → open the create dialog in `parentId` */
  async function dropToCreate(e, parentId) {
    if (TT.isFileDrag(e)) {
      e.preventDefault();
      linkDropHandled = true;
      document.body.classList.remove('link-dragging');
      clearDrop();
      if (!local.allowed) { toast(local.enabled ? _t('拖曳程式只能在執行單機版的那台電腦上使用') : _t('拖曳程式需要 Windows 單機版'), true); return; }
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
      throw new Error(_t('這個程式沒有可用的圖示'));
    }
    if (/^https?:\/\//i.test(v)) {
      const icon = await TT.fetchSiteIcon(v);
      if (icon) return icon;
      throw new Error(_t('這個網站沒有可用的圖示，或伺服器連不到它'));
    }
    throw new Error(_t('請先填寫網址或程式路徑'));
  }

  function folderForNewItem() {
    const sel = state.byId.get(state.selected);
    if (!sel) return null;
    if (isFolder(sel)) return sel.id;
    return state.parent.get(sel.id)?.id ?? null;
  }

  function paintBrand() {
    const s = state.settings;
    $('rail-title').textContent = s.site_title || 'IPMS';
    $('rail-mark').replaceChildren(tile({ icon: s.favicon, name: s.site_title || 'T', size: 34 }));
    document.title = _t("{0} · 管理後台", s.site_title || 'IPMS');
    if (s.favicon) TT.setFavicon(s.favicon);
  }

  function buildRail() {
    $('rail-nav').replaceChildren(...PANELS.filter(p => !p.auth || state.me?.auth).flatMap(p => [
      p.group ? el('div', { class: 'rail-group', text: GROUPS[p.group] }) : null,
      el('a', { class: 'rail-item', href: '#' + p.id, dataset: { panel: p.id } },
        el('span', { class: 'rail-icon', html: svg(p.icon) }), el('span', { text: p.label }))].filter(Boolean)));
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
    let id = (location.hash || '#content').slice(1).split('/')[0];
    if (ALIAS[id]) { id = ALIAS[id]; history.replaceState(null, '', '#' + id); }
    const panel = PANELS.find(p => p.id === id && (!p.auth || state.me?.auth)) || PANELS[0];
    if (currentPanel && currentPanel !== panel.id && state.dirty) {
      if (!(await confirmDialog(_t('放棄未儲存的變更？'), _t('這一頁有尚未儲存的修改。'), _t('放棄變更')))) {
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
    paintHealthBar();
    stage.classList.remove('enter'); void stage.offsetWidth; stage.classList.add('enter');

    ({ content: renderContent, home: renderHome, quick: renderQuick, icons: renderIcons, settings: renderSettings, backup: renderBackup, users: renderUsers,
       status: renderStatus, auth: () => renderSystem('auth'), tls: () => renderSystem('tls'), delivery: () => renderSystem('delivery'),
       audit: renderAudit, sysinfo: renderSysinfo, versions: renderVersions, ai: renderAI })[panel.id]();
  }

  // ======================================================================
  // Dialog helpers
  // ======================================================================
  function modal({ title, body, actions = [], wide = false, onClose }) {
    const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey); onClose && onClose(); };
    const onKey = e => { if (e.key === 'Escape') close(); };
    const closeBtn = el('button', { class: 'icon-btn', type: 'button', 'aria-label': _t('關閉'), html: svg('x') });
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

  function confirmDialog(title, text, okLabel = _t('確定'), danger = true) {
    return new Promise(resolve => {
      let done = false;
      const finish = v => { if (!done) { done = true; resolve(v); } };
      const ok = el('button', { class: 'btn ' + (danger ? 'btn-danger' : 'btn-primary'), type: 'button', text: okLabel });
      const cancel = el('button', { class: 'btn btn-ghost', type: 'button', text: _t('取消') });
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
    const custom = el('input', { type: 'color', class: 'swatch-custom', title: _t('自訂顏色'), value: value || '#6366f1' });
    const paint = v => wrap.querySelectorAll('.swatch').forEach(s => s.classList.toggle('on', (s.dataset.c || '') === (v || '')));
    const none = el('button', { type: 'button', class: 'swatch swatch-none', dataset: { c: '' }, title: _t('不指定（沿用上層 / 主題色）') });
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

  /** Card tag colours: every tag in use (plus ones already given a colour) with a colour picker each. */
  /** Shared windows: name, kind, from–to, how many projects may use it at once. */
  function windowsEditor(value, onChange) {
    let list = value.map(w => ({ ...w }));
    const box = el('div', { class: 'win-ed' });
    const KINDS = [['outage', _t('停電')], ['maintenance', _t('維護窗口')], ['freeze', _t('變更凍結期')]];
    const emit = () => onChange(list.map(w => ({ ...w })));
    function paint() {
      box.replaceChildren(...list.map((w, i) => {
        const title = el('input', { class: 'input', value: w.title || '', placeholder: _t('名稱，例如 機房停電施工（週六）'), maxlength: '60' });
        const kind = el('select', { class: 'select' }, ...KINDS.map(([k, l]) => el('option', { value: k, text: l, selected: (w.kind || 'outage') === k })));
        const from = el('input', { class: 'input', type: 'date', value: w.from || '' });
        const to = el('input', { class: 'input', type: 'date', value: w.to || w.from || '' });
        const cap = el('input', { class: 'input', type: 'number', min: '0', max: '20', value: String(w.capacity ?? 1), title: _t('同時可容納幾個專案'), disabled: (w.kind || 'outage') === 'freeze' });
        const del = el('button', { class: 'icon-btn', type: 'button', 'aria-label': _t('刪除這個時段'), html: svg('trash') });
        title.addEventListener('input', () => { w.title = title.value; emit(); });
        kind.addEventListener('change', () => { w.kind = kind.value; if (w.kind === 'freeze') w.capacity = 0; paint(); emit(); });
        from.addEventListener('change', () => { w.from = from.value; if (!w.to || w.to < w.from) { w.to = w.from; to.value = w.from; } emit(); });
        to.addEventListener('change', () => { w.to = to.value; emit(); });
        cap.addEventListener('input', () => { w.capacity = Math.max(0, Math.min(20, parseInt(cap.value, 10) || 0)); emit(); });
        del.addEventListener('click', () => { list.splice(i, 1); paint(); emit(); });
        return el('div', { class: 'win-row' }, el('div', { class: 'win-top' }, title, kind, del),
          el('div', { class: 'win-bot' }, from, el('span', { text: _t('至') }), to,
            el('label', { class: 'win-cap' }, el('span', { text: _t('可容納') }), cap, el('span', { text: _t('個專案') }))));
      }), (() => {
        const add = el('button', { class: 'btn btn-sm', type: 'button', html: svg('plus') + _t('新增時段') });
        add.addEventListener('click', () => { const d = new Date().toISOString().slice(0, 10); list.push({ title: '', kind: 'outage', from: d, to: d, capacity: 1 }); paint(); emit(); });
        return add;
      })());
    }
    paint();
    return box;
  }

  function tagColorsEditor(value, onChange) {
    const colors = { ...value };
    const box = el('div', { class: 'tagc' });
    const list = el('div', { class: 'tagc-list' });
    const input = el('input', { class: 'input', placeholder: _t('新增標籤名稱，例如 資安'), maxlength: '24' });
    const add = el('button', { class: 'btn btn-sm', type: 'button', html: svg('plus') + _t('加入') });
    let names = [];
    const counts = {};
    const preview = (name, c) => {
      const chip = el('span', { class: 'kb-tag' + (c ? ' custom' : ''), style: c ? { '--tag-c': c } : { '--tag-h': TT.tagHue(name) } },
        el('span', { class: 'kb-tag-hash', text: '#' }), el('span', { text: name }));
      return chip;
    };
    function paint() {
      const all = [...new Set([...names, ...Object.keys(colors)].map(n => n.toLowerCase()))];
      const label = n => names.find(x => x.toLowerCase() === n) || n;
      list.replaceChildren(...(all.length ? all.map(n => {
        const holder = el('span', { class: 'tagc-chip' }, preview(label(n), colors[n]));
        const pick = el('input', { type: 'color', class: 'tagc-color', value: colors[n] || '#6366f1', title: _t('選擇顏色') });
        const auto = el('button', { class: 'btn btn-sm btn-ghost tagc-auto' + (colors[n] ? '' : ' on'), type: 'button', text: _t('自動'), title: _t('依名稱自動配色') });
        const apply = c => {
          if (c) colors[n] = c; else delete colors[n];
          holder.replaceChildren(preview(label(n), colors[n]));
          auto.classList.toggle('on', !c);
          onChange({ ...colors });
        };
        pick.addEventListener('input', () => apply(pick.value));
        auto.addEventListener('click', () => apply(''));
        return el('div', { class: 'tagc-row' }, holder, el('span', { class: 'hint', text: counts[n] ? _t("{0} 張", counts[n]) : _t('尚未使用') }), pick, auto);
      }) : [el('p', { class: 'hint', text: _t('還沒有卡片使用標籤。') })]));
    }
    add.addEventListener('click', () => {
      const n = input.value.trim().replace(/^[#＃]+/, '').trim();
      if (!n) return;
      if (!names.some(x => x.toLowerCase() === n.toLowerCase())) names.push(n);
      input.value = '';
      paint();
    });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); add.click(); } });
    api('/api/tasks/tags').then(rows => {
      rows.forEach(r => { counts[r.name.toLowerCase()] = r.count; });
      names = [...rows.map(r => r.name), ...names];
      paint();
    }).catch(paint);
    box.append(list, el('div', { class: 'tagc-add' }, input, add));
    paint();
    return box;
  }

  /** Icon picker: uploaded images, emoji, or none. Resolves to the chosen value, '' for none, undefined if cancelled. */
  function pickIcon(current) {
    return new Promise(resolve => {
      let result;
      const choose = v => { result = v; close(); };
      let mode = TT.isIconFile(current) || !current ? 'library' : 'emoji';

      const search = el('input', { class: 'input', type: 'search', placeholder: _t('搜尋圖示…') });
      const upload = el('input', { type: 'file', accept: '.png,.jpg,.jpeg,.svg,.webp,.gif', multiple: true, hidden: true });
      const uploadBtn = el('button', { class: 'btn btn-sm', type: 'button', html: svg('upload') + _t('上傳') });
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
        if (!grid.childElementCount) grid.append(el('p', { class: 'hint', text: _t('沒有符合的圖示') }));
      };
      search.addEventListener('input', paintLib);
      upload.addEventListener('change', async () => {
        const names = await uploadIcons(upload.files);
        upload.value = '';
        paintLib();
        if (names.length === 1) choose(names[0]);
      });
      const library = el('div', { class: 'picker-pane' }, el('div', { class: 'picker-tools' }, search, uploadBtn, upload), grid);

      const emojiInput = el('input', { class: 'input emoji-input', type: 'text', maxlength: '8', placeholder: _t('輸入或貼上 emoji'), value: TT.isIconFile(current) ? '' : (current || '') });
      const emojiOk = el('button', { class: 'btn btn-primary btn-sm', type: 'button', text: _t('使用') });
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
      const tabs = segmented([['library', _t('圖示庫'), 'image'], ['emoji', 'Emoji', 'sparkles']], mode, show);

      const clear = el('button', { class: 'btn btn-ghost', type: 'button', text: _t('不使用圖示') });
      clear.addEventListener('click', () => choose(''));
      const cancel = el('button', { class: 'btn', type: 'button', text: _t('取消') });
      cancel.addEventListener('click', () => close());
      const close = modal({ title: _t('選擇圖示'), body, actions: [clear, el('span', { class: 'spacer' }), cancel], wide: true, onClose: () => resolve(result) });
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
    if (names.length) { toast(_t("已上傳 {0} 個圖示", names.length)); await loadIcons(); }
    return names;
  }

  function iconButton(value, name, onChange, opts = {}) {
    const wrap = el('div', { class: 'icon-field' });
    const paint = v => {
      wrap.replaceChildren(
        tile({ icon: v, name: name(), color: opts.color?.(), folder: opts.folder?.(), size: 44 }),
        el('div', { class: 'icon-field-text' },
          el('strong', { text: v ? (TT.isIconFile(v) ? v : `Emoji：${v}`) : _t('未設定') }),
          el('span', { class: 'hint', text: v ? '' : (opts.folder?.() ? _t('顯示資料夾圖示') : _t('顯示名稱縮寫')) })),
        btn);
    };
    const pick = el('button', { class: 'btn btn-sm', type: 'button', text: _t('更換…') });
    pick.addEventListener('click', async () => {
      const v = await pickIcon(value);
      if (v === undefined) return;
      wrap.set(v);
    });
    const btn = el('div', { class: 'icon-field-tools' }, pick);
    if (opts.auto) {
      const auto = el('button', { class: 'btn btn-sm', type: 'button', title: _t('程式：取用程式本身的圖示；網址：抓取網站圖示'), html: svg('wand') + _t('自動') });
      auto.addEventListener('click', async () => {
        auto.disabled = true;
        try { wrap.set(await opts.auto()); toast(_t('已取得圖示')); await loadIcons(); }
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
    const addRoot = el('button', { class: 'btn btn-primary', type: 'button', html: svg('plus') + _t('新增') });
    addRoot.addEventListener('click', () => createNode(state.selected && isFolder(state.byId.get(state.selected)) ? state.selected : null));
    $('stage-actions').append(addRoot);

    const search = el('input', { class: 'input', type: 'search', placeholder: _t('篩選名稱或網址…'), value: state.filter });
    search.addEventListener('input', () => { state.filter = search.value; paintTree(); });
    const expandAll = el('button', { class: 'icon-btn', type: 'button', title: _t('全部展開'), html: svg('chevron-down') });
    expandAll.addEventListener('click', () => { state.byId.forEach(n => isFolder(n) && state.expanded.add(n.id)); saveExpanded(); paintTree(); });
    const collapseAll = el('button', { class: 'icon-btn', type: 'button', title: _t('全部收合'), html: svg('chevron-up') });
    collapseAll.addEventListener('click', () => { state.expanded.clear(); saveExpanded(); paintTree(); });

    const treeBox = el('div', { class: 'atree', id: 'atree', role: 'tree' });
    const dropRoot = el('div', { class: 'atree-root-drop', text: _t('拖到這裡：移到最上層') });
    setupRootDrop(dropRoot);

    const left = el('section', { class: 'panel tree-panel' },
      el('div', { class: 'panel-tools' }, search, expandAll, collapseAll),
      treeBox, dropRoot,
      el('p', { class: 'hint tree-hint', html: _t("{0}<span>拖曳排序；拖到資料夾中間＝放進資料夾。也可以把瀏覽器的網址或連結直接拖進來新增。</span>", svg('grip')) }));
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
          n.is_active ? null : el('span', { class: 'atag', title: _t('已停用：前台不會顯示'), html: svg('eye-off') }),
          n.visible_to ? el('span', { class: 'atag atag-lock', title: _t('限定可見：{0}', [...(n.visible_to.departments || []), ...(n.visible_to.users || [])].join('、')), html: svg('lock') }) : null,
          folder ? el('span', { class: 'acount', text: kids.length || '' })
            : el('span', { class: 'akind' + (TT.isProgram(n.url) ? ' is-program' : ''), title: TT.isProgram(n.url) ? _t('本機程式') : '', html: svg(TT.isProgram(n.url) ? 'play' : 'link') }),
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
      box.append(el('div', { class: 'empty small' }, el('div', { class: 'empty-icon', text: '🌱' }), el('h3', { text: _t('從第一個資料夾開始') }), el('p', { text: _t('按右上角「新增」建立資料夾或連結。') })));
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
    zone.addEventListener('dragenter', () => { if (dragId !== null) zone.textContent = _t('拖到這裡：移到最上層'); });
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
      toast(pos === 'inside' ? _t("已移到「{0}」", target.name) : _t('已更新順序'));
    } catch (e) {
      toast(e.message, true);
      await loadTree();
      paintTree();
    }
  }

  // --- selection & editor ---
  async function select(id) {
    if (state.selected === id) return;
    if (state.dirty && !(await confirmDialog(_t('放棄未儲存的變更？'), _t('目前編輯的項目還沒儲存。'), _t('放棄變更')))) return;
    state.selected = id;
    state.dirty = false;
    document.querySelectorAll('.arow.selected').forEach(r => r.classList.remove('selected'));
    document.querySelector(`.arow[data-id="${id}"]`)?.classList.add('selected');
    paintEditor();
  }

  // Who sees a public folder / link (server edition): everyone, or only some departments / people.
  // A limit on a folder covers everything in it; each limited level must let the person in.
  let visOptions = null;
  async function loadVisOptions() {
    if (visOptions) return visOptions;
    const d = await api('/api/users');
    visOptions = { departments: d.departments || [], users: (d.users || []).filter(u => u.active && !u.local_admin && u.source !== 'local') };
    return visOptions;
  }

  function visibilityField(n, draft, markDirty) {
    const box = el('div', { class: 'vis-box' });
    const inherited = pathOf(n).filter(p => p.visible_to);
    const note = inherited.length ? el('p', { class: 'hint vis-inherit', html: svg('lock') + _t('上層「{0}」已限定可見範圍；這裡的限定再加上去（兩者都符合才看得到）', inherited.map(p => p.name).join('、')) }) : null;
    const mode = segmented([['all', _t('所有人'), 'users'], ['some', _t('指定部門或人員'), 'lock']], draft.visible ? 'some' : 'all', v => {
      draft.visible = v === 'some' ? (draft.visible || { departments: [], users: [] }) : null;
      markDirty(); paint();
    });
    const body = el('div', { class: 'vis-body' });
    async function paint() {
      if (!draft.visible) {
        body.replaceChildren(el('p', { class: 'hint', text: isFolder(n) ? _t('所有登入的人都看得到這個資料夾（除非上層有限定）') : _t('所有登入的人都看得到（除非上層有限定）') }));
        return;
      }
      let o;
      try { o = await loadVisOptions(); } catch (e) { body.replaceChildren(el('p', { class: 'hint', text: e.message })); return; }
      const v = draft.visible;
      const depts = [...new Set([...o.departments, ...v.departments])];
      const chips = el('div', { class: 'scope-box' }, ...depts.map(d => {
        const b = el('button', { type: 'button', class: 'scope-chip', 'aria-pressed': String(v.departments.includes(d)), text: d });
        b.addEventListener('click', () => {
          v.departments = v.departments.includes(d) ? v.departments.filter(x => x !== d) : [...v.departments, d];
          b.setAttribute('aria-pressed', String(v.departments.includes(d))); markDirty(); summary();
        });
        return b;
      }), depts.length ? null : el('span', { class: 'hint', text: _t('帳號都還沒有部門資料（AD 的 department）') }));
      const people = el('div', { class: 'scope-box' });
      const nameOf = u => { const x = o.users.find(p => p.username === u); return x ? (x.display_name || x.username) + (x.department ? ` · ${x.department}` : '') : u; };
      const paintPeople = () => people.replaceChildren(...v.users.map(u => {
        const b = el('button', { type: 'button', class: 'scope-chip', 'aria-pressed': 'true', title: _t('移除'), text: nameOf(u) + ' ✕' });
        b.addEventListener('click', () => { v.users = v.users.filter(x => x !== u); markDirty(); paintPeople(); summary(); });
        return b;
      }));
      paintPeople();
      const pick = el('select', { class: 'select' }, el('option', { value: '', text: _t('＋ 加入人員…') }),
        ...o.users.map(u => el('option', { value: u.username, text: `${u.display_name || u.username}（${u.username}）${u.department ? ' · ' + u.department : ''}` })));
      pick.addEventListener('change', () => {
        if (pick.value && !v.users.includes(pick.value)) { v.users = [...v.users, pick.value]; markDirty(); paintPeople(); summary(); }
        pick.value = '';
      });
      const sum = el('p', { class: 'hint vis-sum' });
      const summary = () => { sum.textContent = v.departments.length || v.users.length
        ? _t('看得到：{0} 個部門、{1} 位人員（系統管理員一律看得到）', v.departments.length, v.users.length)
        : _t('尚未選擇：儲存後等同所有人'); };
      summary();
      body.replaceChildren(el('span', { class: 'field-label', text: _t('部門') }), chips,
        el('span', { class: 'field-label', text: _t('人員') }), people, pick, sum);
    }
    paint();
    box.append(el('span', { class: 'field-label', text: _t('可見範圍') }), mode, note || '', body);
    return box;
  }

  function paintEditor() {
    const box = $('editor');
    if (!box) return;
    const n = state.byId.get(state.selected);
    if (!n) {
      box.replaceChildren(el('div', { class: 'empty' },
        el('div', { class: 'empty-icon', html: svg('edit') }),
        el('h3', { text: _t('選擇左邊的項目來編輯') }),
        el('p', { text: _t('或按「新增」建立新的資料夾、連結。') })));
      return;
    }

    const vis = n.visible_to || null;
    const draft = { visible: vis ? { departments: [...(vis.departments || [])], users: [...(vis.users || [])] } : null, name: n.name, node_type: n.node_type, url: TT.programPath(n.url || ''), description: n.description || '', icon: n.icon || '', color: n.color || '', new_tab: n.new_tab !== false && n.new_tab !== 0, is_active: !!n.is_active, parent: state.parent.get(n.id)?.id ?? '', launch_args: n.launch_args || '', launch_cwd: n.launch_cwd || '' };
    const markDirty = () => { state.dirty = true; saveBtn.disabled = false; };
    const folderNow = () => draft.node_type === 'folder';

    // header
    const preview = el('div', { class: 'editor-preview' });
    const paintPreview = () => preview.replaceChildren(tile({ icon: draft.icon, name: draft.name, color: draft.color || null, folder: folderNow(), size: 52 }));
    paintPreview();
    const crumbs = pathOf(n).map(p => p.name).join(' › ') || _t('最上層');
    const head = el('div', { class: 'editor-head' }, preview,
      el('div', { class: 'editor-title' },
        el('h2', { text: n.name }),
        el('div', { class: 'hint', text: crumbs })),
      el('span', { class: 'badge', text: isFolder(n) ? _t('資料夾') : _t('連結') }));

    // fields
    const name = el('input', { class: 'input', value: draft.name, maxlength: '200' });
    name.addEventListener('input', () => { draft.name = name.value; markDirty(); paintPreview(); iconField.repaint(); });

    const hasKids = (n.children || []).length > 0;
    const type = segmented([['folder', _t('資料夾'), 'folder'], ['link', _t('連結'), 'link']], draft.node_type, v => {
      if (v === 'link' && hasKids) { toast(_t('這個資料夾裡還有項目，無法改成連結'), true); type.setValue('folder'); return; }
      draft.node_type = v; markDirty(); urlRow.hidden = v !== 'link'; paintPreview(); iconField.repaint();
    });

    const url = el('input', { class: 'input', type: 'text', value: draft.url, placeholder: _t('https://…　或　C:\\Program Files\\…\\程式.exe'), spellcheck: 'false' });
    const newTab = switchCtl(draft.new_tab, _t('在新分頁開啟'), v => { draft.new_tab = v; markDirty(); });
    const argsIn = el('input', { class: 'input mono', value: draft.launch_args, placeholder: _t('選填') });
    argsIn.addEventListener('input', () => { draft.launch_args = argsIn.value; markDirty(); });
    const cwdIn = el('input', { class: 'input mono', value: draft.launch_cwd, placeholder: _t('預設為程式所在資料夾') });
    cwdIn.addEventListener('input', () => { draft.launch_cwd = cwdIn.value; markDirty(); });
    const programRow = el('div', { class: 'form-row' }, field(_t('啟動參數'), argsIn), field(_t('工作資料夾'), cwdIn));
    const syncKind = () => {
      const prog = TT.looksLikePath(url.value);
      programRow.hidden = !prog;
      newTab.hidden = prog;
      url.classList.toggle('mono', prog);
    };
    url.addEventListener('input', () => { draft.url = url.value; markDirty(); syncKind(); });
    const urlRow = el('div', { class: 'field-group' },
      field(_t('網址或程式路徑'), url, local.allowed ? _t('程式只能在執行單機版的這台電腦上啟動') : ''), newTab, programRow);
    urlRow.hidden = draft.node_type !== 'link';
    syncKind();

    const desc = el('textarea', { class: 'textarea', rows: '2', placeholder: _t('顯示在卡片上的簡短說明（選填）') });
    desc.value = draft.description;
    desc.addEventListener('input', () => { draft.description = desc.value; markDirty(); });

    const iconField = iconButton(draft.icon, () => draft.name, v => { draft.icon = v; markDirty(); paintPreview(); },
      { color: () => draft.color || null, folder: folderNow, auto: draft.node_type === 'link' ? () => autoIcon(url.value) : null });

    const colors = colorPicker(draft.color, v => { draft.color = v; markDirty(); paintPreview(); iconField.repaint(); });

    const parentSel = el('select', { class: 'select' });
    parentSel.append(el('option', { value: '', text: _t('（最上層）') }));
    const banned = new Set([n.id, ...descendants(n).map(d => d.id)]);
    const addOpts = (nodes, depth) => nodes.forEach(x => {
      if (banned.has(x.id) || !isFolder(x)) return;
      parentSel.append(el('option', { value: x.id, text: `${'　'.repeat(depth)}${x.name}` }));
      addOpts(x.children || [], depth + 1);
    });
    addOpts(state.tree, 0);
    parentSel.value = String(draft.parent);
    parentSel.addEventListener('change', () => { draft.parent = parentSel.value; markDirty(); });

    const active = switchCtl(draft.is_active, _t('在入口顯示'), v => { draft.is_active = v; markDirty(); });
    const visField = state.me?.auth ? visibilityField(n, draft, markDirty) : null;

    // actions
    const saveBtn = el('button', { class: 'btn btn-primary', type: 'button', html: svg('check') + _t('儲存'), disabled: true });
    saveBtn.addEventListener('click', save);
    const addChild = el('button', { class: 'btn', type: 'button', html: svg('plus') + _t('新增子項目') });
    addChild.addEventListener('click', () => createNode(n.id));
    addChild.hidden = !isFolder(n);
    const del = el('button', { class: 'btn btn-danger', type: 'button', html: svg('trash') + _t('刪除') });
    del.addEventListener('click', async () => {
      const count = descendants(n).length;
      if (!(await confirmDialog(_t("刪除「{0}」？", n.name), count ? _t("裡面的 {0} 個項目也會一起刪除，無法復原。", count) : _t('刪除後無法復原。'), _t('刪除')))) return;
      try {
        await api(`/api/nodes/${n.id}`, { method: 'DELETE' });
        state.selected = null;
        state.dirty = false;
        await loadTree();
        paintTree();
        paintEditor();
        toast(_t('已刪除'));
      } catch (e) { toast(e.message, true); }
    });

    async function save() {
      if (!draft.name.trim()) return toast(_t('請輸入名稱'), true);
      if (draft.node_type === 'link' && !/^[a-z][a-z0-9+.-]*:/i.test(draft.url.trim()) && !TT.looksLikePath(draft.url)) return toast(_t('請輸入完整網址（https://…）或程式路徑（C:\\…）'), true);
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
            ...(state.me?.auth ? { visible_to: draft.visible && (draft.visible.departments.length || draft.visible.users.length) ? draft.visible : null } : {}),
            ...(draft.node_type === 'link' && TT.looksLikePath(draft.url)
              ? { launch_args: draft.launch_args.trim() || null, launch_cwd: draft.launch_cwd.trim() || null } : {}),
          },
        });
        state.dirty = false;
        await loadTree();
        paintTree();
        paintEditor();
        toast(_t('已儲存'));
      } catch (e) { toast(e.message, true); saveBtn.disabled = false; }
    }

    const form = el('div', { class: 'editor-form' },
      el('div', { class: 'form-row' }, field(_t('名稱'), name), el('div', { class: 'field' }, el('span', { class: 'field-label', text: _t('類型') }), type)),
      urlRow,
      field(_t('說明'), desc),
      el('div', { class: 'field' }, el('span', { class: 'field-label', text: _t('圖示') }), iconField),
      el('div', { class: 'field' }, el('span', { class: 'field-label', text: _t('顏色') }), colors, el('span', { class: 'hint', text: _t('資料夾的顏色會套用到裡面沒有自訂顏色的項目') })),
      el('div', { class: 'form-row' }, field(_t('所屬資料夾'), parentSel), el('div', { class: 'field' }, el('span', { class: 'field-label', text: _t('狀態') }), active)),
      visField);
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
    const parentName = parentId ? state.byId.get(parentId).name : _t('最上層');
    const name = el('input', { class: 'input', placeholder: _t('例如：Grafana'), maxlength: '200', value: prefill?.name || '' });
    const url = el('input', {
      class: 'input' + (app ? ' mono' : ''), type: 'text', spellcheck: 'false',
      placeholder: _t('https://…　或　C:\\Program Files\\…\\程式.exe'),
      value: prefill ? (app ? (prefill.found === false ? '' : TT.programPath(prefill.url)) : prefill.url) : '',
    });
    const args = el('input', { class: 'input mono', placeholder: _t('選填'), value: prefill?.args || '' });
    const argsField = field(_t('啟動參數'), args);
    const urlField = el('div', { class: 'field-group' },
      field(_t('網址或程式路徑'), url, app && prefill.found === false
        ? _t("在電腦上找不到「{0}」：請在檔案總管對它按 Shift + 右鍵 →「複製為路徑」，貼到這裡", prefill.name) : ''),
      argsField);
    const syncKind = () => { argsField.hidden = !TT.looksLikePath(url.value); url.classList.toggle('mono', !argsField.hidden); };
    url.addEventListener('input', syncKind);
    syncKind();
    const type = segmented([['link', _t('連結 / 程式'), 'link'], ['folder', _t('資料夾'), 'folder']], 'link', v => { draft.node_type = v; urlField.hidden = v !== 'link'; iconField.repaint(); });
    const desc = el('input', { class: 'input', placeholder: _t('選填') });
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

    const ok = el('button', { class: 'btn btn-primary', type: 'button', html: svg('plus') + _t('建立') });
    const cancel = el('button', { class: 'btn btn-ghost', type: 'button', text: _t('取消') });
    const what = app ? _t('程式') : prefill ? _t('網址') : '';
    const close = modal({
      title: what ? _t("把{0}新增到「{1}」", what, parentName) : _t("新增到「{0}」", parentName),
      body: el('div', { class: 'stack' }, el('div', { class: 'field' }, el('span', { class: 'field-label', text: _t('類型') }), type), field(_t('名稱'), name), urlField, field(_t('說明'), desc), el('div', { class: 'field' }, el('span', { class: 'field-label', text: _t('圖示') }), iconField)),
      actions: [cancel, ok],
    });
    if (app && prefill.found === false) setTimeout(() => url.focus(), 60);
    cancel.addEventListener('click', () => close());
    const submit = async () => {
      const target = url.value.trim();
      const program = TT.looksLikePath(target);
      if (!name.value.trim()) return toast(_t('請輸入名稱'), true);
      if (draft.node_type === 'link' && !program && !/^[a-z][a-z0-9+.-]*:/i.test(target)) return toast(_t('請輸入完整網址（https://…）或程式路徑（C:\\…）'), true);
      if (iconPending) {                       // don't create the item before its icon arrives
        ok.disabled = true;
        ok.textContent = _t('取得圖示中…');
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
        toast(_t('已建立'));
      } catch (e) { toast(e.message, true); }
    };
    ok.addEventListener('click', submit);
    [name, url, desc, args].forEach(i => i.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }));
  }

  // ======================================================================
  // Save bar (settings-like panels)
  // ======================================================================
  function saveBar(onSave, onRevert) {
    const save = el('button', { class: 'btn btn-primary', type: 'button', html: svg('check') + _t('儲存變更') });
    const revert = el('button', { class: 'btn btn-ghost', type: 'button', text: _t('還原') });
    const bar = el('div', { class: 'savebar' }, el('span', { class: 'savebar-text', html: _t("{0}<span>有尚未儲存的變更</span>", svg('edit')) }), revert, save);
    save.addEventListener('click', async () => {
      save.disabled = true;
      try { await onSave(); state.dirty = false; bar.classList.remove('show'); toast(_t('已儲存')); }
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
    message: { icon: 'megaphone', label: _t('公告'), desc: _t('一段文字公告') },
    quick_links: { icon: 'zap', label: _t('快速連結'), desc: _t('「快速連結」頁面管理的按鈕列') },
    favorites: { icon: 'star', label: _t('我的最愛'), desc: _t('每位使用者自己收藏的連結（存在瀏覽器）') },
    recent: { icon: 'history', label: _t('最近使用'), desc: _t('每位使用者最近開過的連結（存在瀏覽器）') },
    roots: { icon: 'layout', label: _t('所有分類'), desc: _t('最上層的資料夾卡片') },
    folder: { icon: 'folder', label: _t('指定資料夾'), desc: _t('把某個資料夾的內容直接攤在首頁') },
    board: { icon: 'kanban', label: _t('待辦看板'), desc: _t('週期工作 / 過期未結案 / New / On going / Pending / On hold / Complete / Canceled 卡片看板') },
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
        const up = el('button', { class: 'icon-btn', type: 'button', title: _t('上移'), html: svg('chevron-up'), disabled: i === 0 });
        const down = el('button', { class: 'icon-btn', type: 'button', title: _t('下移'), html: svg('chevron-down'), disabled: i === draft.home_sections.length - 1 });
        const remove = el('button', { class: 'icon-btn danger', type: 'button', title: _t('移除'), html: svg('trash') });
        up.addEventListener('click', () => { [draft.home_sections[i - 1], draft.home_sections[i]] = [draft.home_sections[i], draft.home_sections[i - 1]]; bar.mark(); paint(); });
        down.addEventListener('click', () => { [draft.home_sections[i + 1], draft.home_sections[i]] = [draft.home_sections[i], draft.home_sections[i + 1]]; bar.mark(); paint(); });
        remove.addEventListener('click', () => { draft.home_sections.splice(i, 1); bar.mark(); paint(); });

        const title = el('input', { class: 'input', placeholder: _t("標題（預設：{0}）", sec.type === 'folder' ? _t('資料夾名稱') : sec.type === 'quick_links' ? (draft.quick_links_title || info.label) : info.label), value: sec.title || '' });
        title.addEventListener('input', () => { sec.title = title.value; bar.mark(); });
        const opts = el('div', { class: 'section-opts' }, field(_t('標題'), title));

        if (sec.type === 'folder') {
          const sel = el('select', { class: 'select' });
          folderOptions().forEach(([id, label]) => sel.append(el('option', { value: id, text: label })));
          if (!sec.node_id && sel.options.length) sec.node_id = Number(sel.value);
          sel.value = sec.node_id;
          sel.addEventListener('change', () => { sec.node_id = Number(sel.value); bar.mark(); });
          opts.append(field(_t('資料夾'), sel));
        }
        if (sec.type === 'folder' || sec.type === 'roots') {
          opts.append(el('div', { class: 'field' }, el('span', { class: 'field-label', text: _t('卡片大小') }),
            segmented([['grid', _t('一般')], ['compact', _t('精簡')]], sec.style || 'grid', v => { sec.style = v; bar.mark(); })));
        }
        if (sec.type === 'board') {
          opts.append(el('div', { class: 'field' }, el('span', { class: 'field-label', text: _t('完成／取消欄位') }),
            segmented([['show', _t('顯示')], ['hide', _t('隱藏')]], sec.hide_closed ? 'hide' : 'show', v => { sec.hide_closed = v === 'hide'; bar.mark(); })));
        }
        if (['favorites', 'recent', 'folder'].includes(sec.type)) {
          const lim = el('input', { class: 'input', type: 'number', min: '1', max: '99', placeholder: _t('不限'), value: sec.limit || '' });
          lim.addEventListener('input', () => { sec.limit = parseInt(lim.value, 10) || undefined; bar.mark(); });
          opts.append(field(_t('最多顯示'), lim));
        }
        if (sec.type === 'message') {
          const msg = el('textarea', { class: 'textarea', rows: '3', placeholder: _t('公告內容（空白時不顯示）') });
          msg.value = draft.home_message;
          msg.addEventListener('input', () => { draft.home_message = msg.value; bar.mark(); });
          opts.append(el('div', { class: 'span-all' }, field(_t('內容'), msg)));
        }
        if (sec.type === 'quick_links') {
          const qt = el('input', { class: 'input', value: draft.quick_links_title, placeholder: _t('快速連結') });
          qt.addEventListener('input', () => { draft.quick_links_title = qt.value; bar.mark(); });
          const qi = el('input', { class: 'input emoji-input', value: draft.quick_links_icon, maxlength: '8', placeholder: '⚡' });
          qi.addEventListener('input', () => { draft.quick_links_icon = qi.value; bar.mark(); });
          opts.append(field(_t('預設名稱'), qt), field(_t('圖示（emoji）'), qi));
        }

        return el('div', { class: 'section-card panel' },
          el('div', { class: 'section-card-head' },
            el('span', { class: 'section-num', text: i + 1 }),
            el('span', { class: 'section-card-icon', html: svg(info.icon) }),
            el('div', { class: 'section-card-title' }, el('strong', { text: info.label }), el('span', { class: 'hint', text: info.desc })),
            el('div', { class: 'section-card-tools' }, up, down, remove)),
          opts);
      }));
      if (!draft.home_sections.length) list.append(el('div', { class: 'empty small' }, el('div', { class: 'empty-icon', text: '🧩' }), el('h3', { text: _t('首頁目前是空的') }), el('p', { text: _t('從下面加入區塊。') })));
    };

    const adders = el('div', { class: 'section-adders' }, Object.entries(SECTION_INFO).map(([type, info]) => {
      const b = el('button', { class: 'adder', type: 'button' },
        el('span', { class: 'adder-icon', html: svg(info.icon) }),
        el('span', {}, el('strong', { text: info.label }), el('small', { text: info.desc })));
      b.addEventListener('click', () => {
        const sec = { type };
        if (type === 'folder') { const first = folderOptions()[0]; if (!first) return toast(_t('還沒有任何資料夾'), true); sec.node_id = first[0]; }
        draft.home_sections.push(sec);
        bar.mark();
        paint();
        list.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
      return b;
    }));

    const preview = el('a', { class: 'btn', href: '/', target: '_blank', rel: 'noopener', html: svg('external') + _t('預覽首頁') });
    $('stage-actions').append(preview);
    $('stage-body').append(list, el('h3', { class: 'sub-head', text: _t('加入區塊') }), adders, bar);
    paint();
  }

  // ======================================================================
  // Panel: quick links
  // ======================================================================
  async function renderQuick() {
    const add = el('button', { class: 'btn btn-primary', type: 'button', html: svg('plus') + _t('新增連結') });
    add.addEventListener('click', () => editQuick(null));
    $('stage-actions').append(add);
    const box = el('div', { class: 'quick-admin' });
    $('stage-body').append(box);
    const body = $('stage-body');
    body.addEventListener('dragover', e => { if (TT.isLinkDrag(e) || TT.isFileDrag(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
    body.addEventListener('drop', e => {
      if (TT.isFileDrag(e)) { e.preventDefault(); linkDropHandled = true; toast(_t('快速連結只能放網址；程式請拖到「內容」'), true); return; }
      if (!TT.isLinkDrag(e)) return;
      const link = takeDroppedLink(e);
      if (link) editQuick(null, link);
    });

    const paint = async () => {
      state.links = await api('/api/auth-links/all');
      const label = state.settings.quick_links_group_label || _t('群組');
      const groups = new Map();
      state.links.forEach(l => { const g = l.region || ''; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(l); });
      const keys = [...groups.keys()].sort((a, b) => (!a) - (!b) || a.localeCompare(b));
      box.replaceChildren(...keys.map(g => el('section', { class: 'panel quick-group-panel' },
        el('div', { class: 'quick-group-head' }, el('strong', { text: g || _t("未分{0}", label) }), el('span', { class: 'badge', text: groups.get(g).length })),
        el('div', { class: 'qlist' }, groups.get(g).map(l => {
          const edit = el('button', { class: 'icon-btn', type: 'button', title: _t('編輯'), html: svg('edit') });
          edit.addEventListener('click', () => editQuick(l));
          const del = el('button', { class: 'icon-btn danger', type: 'button', title: _t('刪除'), html: svg('trash') });
          del.addEventListener('click', async () => {
            if (!(await confirmDialog(_t("刪除「{0}」？", l.name), l.url, _t('刪除')))) return;
            try { await api(`/api/auth-links/${l.id}`, { method: 'DELETE' }); toast(_t('已刪除')); paint(); } catch (e) { toast(e.message, true); }
          });
          return el('div', { class: 'qrow' + (l.is_active ? '' : ' inactive') },
            el('span', { class: 'chip-dot' }),
            el('div', { class: 'qrow-text' }, el('strong', { text: l.name }), el('a', { class: 'hint', href: l.url, target: '_blank', rel: 'noopener', text: l.url })),
            l.is_active ? null : el('span', { class: 'atag', html: svg('eye-off') }),
            edit, del);
        })))));
      if (!state.links.length) box.append(el('div', { class: 'empty' }, el('div', { class: 'empty-icon', html: svg('zap') }), el('h3', { text: _t('還沒有快速連結') }), el('p', { text: _t('常用、需要一鍵直達的網址（例如上網驗證、VPN）適合放這裡。') })));
    };

    function editQuick(l, prefill = null) {
      const label = state.settings.quick_links_group_label || _t('群組');
      const groups = [...new Set(state.links.map(x => x.region).filter(Boolean))];
      const dl = el('datalist', { id: 'ql-groups' }, groups.map(g => el('option', { value: g })));
      const region = el('input', { class: 'input', list: 'ql-groups', value: l?.region || '', placeholder: _t('選填') });
      const name = el('input', { class: 'input', value: l?.name || prefill?.title || '' });
      const url = el('input', { class: 'input', type: 'url', value: l?.url || prefill?.url || '', placeholder: 'https://' });
      const sort = el('input', { class: 'input', type: 'number', value: l?.sort_order ?? 0 });
      let active = l ? !!l.is_active : true;
      const ok = el('button', { class: 'btn btn-primary', type: 'button', text: _t('儲存') });
      const cancel = el('button', { class: 'btn btn-ghost', type: 'button', text: _t('取消') });
      const close = modal({
        title: l ? _t('編輯快速連結') : _t('新增快速連結'),
        body: el('div', { class: 'stack' }, dl, field(_t('名稱'), name), field(_t('網址'), url),
          el('div', { class: 'form-row' }, field(label, region), field(_t('排序'), sort, _t('數字小的在前'))),
          switchCtl(active, _t('在首頁顯示'), v => { active = v; })),
        actions: [cancel, ok],
      });
      cancel.addEventListener('click', () => close());
      ok.addEventListener('click', async () => {
        if (!name.value.trim() || !url.value.trim()) return toast(_t('請填寫名稱與網址'), true);
        const body = { region: region.value.trim(), name: name.value.trim(), url: url.value.trim(), sort_order: parseInt(sort.value, 10) || 0, is_active: active };
        try {
          await api(l ? `/api/auth-links/${l.id}` : '/api/auth-links', { method: l ? 'PUT' : 'POST', body });
          close(); toast(_t('已儲存')); paint();
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
    const upBtn = el('button', { class: 'btn btn-primary', type: 'button', html: svg('upload') + _t('上傳圖示') });
    upBtn.addEventListener('click', () => input.click());
    input.addEventListener('change', async () => { await uploadIcons(input.files); input.value = ''; paint(); });
    $('stage-actions').append(upBtn, input);

    const search = el('input', { class: 'input', type: 'search', placeholder: _t('搜尋檔名…') });
    const drop = el('div', { class: 'dropzone', html: _t("{0}<span>把圖片拖到這裡上傳（PNG / JPG / SVG / WebP / GIF，5 MB 內）</span>", svg('upload')) });
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
      count.textContent = _t("{0} / {1} 個", list.length, state.icons.length);
      grid.replaceChildren(...list.map(i => {
        const used = usage.get(i.name) || 0;
        const rename = el('button', { class: 'icon-btn', type: 'button', title: _t('重新命名'), html: svg('edit') });
        rename.addEventListener('click', () => renameIcon(i.name));
        const del = el('button', { class: 'icon-btn danger', type: 'button', title: used ? _t("使用中（{0}）無法刪除", used) : _t('刪除'), html: svg('trash'), disabled: used > 0 });
        del.addEventListener('click', async () => {
          if (!(await confirmDialog(_t("刪除圖示「{0}」？", i.name), _t('刪除後無法復原。'), _t('刪除')))) return;
          try { await api(`/api/icons/${encodeURIComponent(i.name)}`, { method: 'DELETE' }); await loadIcons(); paint(); toast(_t('已刪除')); } catch (e) { toast(e.message, true); }
        });
        return el('div', { class: 'icon-card panel' },
          el('div', { class: 'icon-card-img' }, el('img', { src: TT.iconUrl(i.name), alt: '', loading: 'lazy' })),
          el('div', { class: 'icon-card-name', title: i.name, text: i.name }),
          el('div', { class: 'icon-card-meta' },
            el('span', { text: `${(i.size / 1024).toFixed(i.size < 10240 ? 1 : 0)} KB` }),
            used ? el('span', { class: 'badge', text: _t("使用中 {0}", used) }) : el('span', { class: 'hint', text: _t('未使用') })),
          el('div', { class: 'icon-card-tools' }, rename, del));
      }));
    }

    async function renameIcon(name) {
      const input = el('input', { class: 'input', value: name });
      const ok = el('button', { class: 'btn btn-primary', type: 'button', text: _t('重新命名') });
      const cancel = el('button', { class: 'btn btn-ghost', type: 'button', text: _t('取消') });
      const close = modal({ title: _t('重新命名圖示'), body: field(_t('新檔名（含副檔名）'), input, _t('使用這個圖示的項目會自動更新')), actions: [cancel, ok] });
      cancel.addEventListener('click', () => close());
      ok.addEventListener('click', async () => {
        const v = input.value.trim();
        if (!v || v === name) return close();
        try {
          await api(`/api/icons/${encodeURIComponent(name)}?new_name=${encodeURIComponent(v)}`, { method: 'PUT' });
          close(); await Promise.all([loadIcons(), loadTree()]); paint(); toast(_t('已重新命名'));
        } catch (e) { toast(e.message, true); }
      });
    }
    paint();
  }

  // ======================================================================
  // Panel: settings
  // ======================================================================
  const SETTINGS_GROUPS = [
    { title: _t('品牌'), icon: 'sparkles', fields: [
      { key: 'site_title', label: _t('網站名稱'), type: 'text' },
      { key: 'site_subtitle', label: _t('副標題'), type: 'text', placeholder: _t('顯示在名稱下方（選填）') },
      { key: 'favicon', label: _t('網站圖示'), type: 'icon', hint: _t('頁首與瀏覽器分頁都會使用') },
    ] },
    { title: _t('外觀'), icon: 'palette', fields: [
      { key: 'theme', label: _t('預設主題'), type: 'seg', options: [['auto', _t('跟隨系統'), 'monitor'], ['light', _t('淺色'), 'sun'], ['dark', _t('深色'), 'moon']], hint: _t('使用者仍可自行切換') },
      { key: 'language', label: _t('預設語言'), type: 'seg', options: [['zh-TW', '繁體中文', 'globe'], ['en', 'English', 'globe'], ['auto', _t('跟隨瀏覽器'), 'globe']], hint: _t('使用者可以用頁首的「中／EN」按鈕自行切換，會記在自己的帳號') },
      { key: 'accent_color', label: _t('主題色'), type: 'accent' },
      { key: 'background', label: _t('背景'), type: 'seg', options: [['aurora', _t('戰術方格')], ['gradient', _t('方格（中央淡出）')], ['plain', _t('純色')]] },
      { key: 'density', label: _t('卡片密度'), type: 'seg', options: [['comfortable', _t('舒適')], ['compact', _t('緊湊')]] },
      { key: 'default_view', label: _t('預設顯示方式'), type: 'seg', options: [['grid', _t('格狀'), 'grid'], ['list', _t('清單'), 'list']] },
    ] },
    { title: _t('頁首'), icon: 'monitor', fields: [
      { key: 'show_clock', label: _t('顯示時鐘'), type: 'switch' },
      { key: 'clock_style', label: _t('時鐘樣式'), type: 'seg', options: [['hud', _t('戰術數位 00:00:00.000')], ['simple', _t('簡潔')]] },
      { key: 'clock_show_seconds', label: _t('顯示秒數（簡潔樣式）'), type: 'switch' },
      { key: 'show_client_ip', label: _t('顯示使用者 IP（本伺服器看到的位址）'), type: 'switch' },
      { key: 'show_public_ip', label: _t('顯示對外 IP 與所在地（瀏覽器會連線 ipinfo.io）'), type: 'switch' },
      { key: 'show_admin_button', label: _t('顯示 ⚙ 後台按鈕'), type: 'switch', hint: _t('關閉時：快速點 Logo 或時鐘 5 次進入後台') },
    ] },
    { title: _t('公開進度看板'), icon: 'monitor', fields: [
      { key: 'public_dashboard', label: _t('公開進度看板 /dashboard（不需登入、只顯示數量）'), type: 'switch', hint: _t('依部門 → 帳號 → 狀態顯示卡片數，不含任何卡片內容與週期工作；關閉後該頁顯示「已關閉」') },
      { key: 'dashboard_projects', label: _t('專案進度'), type: 'seg', options: [['anon', _t('只顯示進度（專案 A、B…）')], ['names', _t('顯示專案名稱')], ['off', _t('不顯示')]], hint: _t('進度、落後天數與下個里程碑日期；選「顯示專案名稱」時也會顯示里程碑名稱') },
      { key: 'dashboard_load', label: _t('顯示人員負載（每人每週的預估工時）'), type: 'switch' },
      { key: 'dashboard_health', label: _t('顯示系統狀態燈號（儲存空間、記憶體、備份、憑證…）'), type: 'switch', hint: _t('只顯示正常／注意／異常，不顯示數值與主機資訊') },
      { key: 'dashboard_rotate_seconds', label: _t('輪播：每頁停留秒數'), type: 'number', hint: _t('網址：/dashboard（總覽）、/dashboard?rotate=1（總覽與各部門輪流顯示）、/dashboard?dept=部門名稱（只看一個部門）；加 &tv=1 為壁掛模式（字體放大、隱藏按鈕）') },
    ] },
    { title: _t('待辦看板'), icon: 'kanban', fields: [
      { key: 'board_enabled', label: _t('啟用待辦看板（側邊欄入口與右上角 🔔 提醒）'), type: 'switch' },
      { key: 'board_notify', label: _t('桌面通知'), type: 'switch', hint: _t('到期、提醒時間或開始日到了會跳出系統通知；每位使用者第一次要在瀏覽器按「允許」') },
      { key: 'board_due_soon_days', label: _t('幾天內到期算「即將到期」'), type: 'number' },
      { key: 'board_history_hours', label: _t('結案多久後移到歷史區（小時）'), type: 'number', hint: _t('主卡完成或取消超過這個時間，就從看板移到「歷史區」，只能檢視不能修改。預設 72 小時；1～8760（一年）') },
      { key: 'board_supervisor', label: _t('上級對下級卡片的權限'), type: 'seg', options: [['rw', _t('可編輯')], ['ro', _t('檢視＋留言')], ['off', _t('不分享')]], hint: _t('上級＝帳號的上級（AD 的 manager 或在「帳號管理」設定），可以多層。可編輯：瀏覽、留言、增刪修、指派給下級；檢視＋留言：只能看與留言') },
      { key: 'board_wip_high', label: _t('工作量：每欄幾張起算「高負荷」'), type: 'number', hint: _t('預設 6：每欄 ≤5 張為正常、6～8 張顯示「高負荷」') },
      { key: 'board_wip_over', label: _t('工作量：每欄幾張起算「超量」'), type: 'number', hint: _t('預設 9：≥9 張顯示「超量」，顯示在看板欄位標題') },
      { key: 'board_load_hours', label: _t('人員負載：每週上限（小時）'), type: 'hours', hint: _t('每人每週到期的未完成工作，預估工時合計超過這個數字就算「超載」（跨所有專案與一般卡），會列入雷達的警示清單') },
      { key: 'board_default_estimate_hours', label: _t('人員負載：沒填預估的項目以幾小時計'), type: 'hours', hint: _t('負載表會另外標出「未填預估」的項目數，提醒大家補填') },
      { key: 'board_windows', label: _t('共用時段（停電、維護窗口、變更凍結期）'), type: 'windows', hint: _t('工作可以在「排程」選要用哪個時段。停電／維護：超過「可容納幾個專案」就算衝突；凍結期：任何排進來的工作都算衝突。') },
      { key: 'board_tag_colors', label: _t('卡片標籤顏色'), type: 'tagcolors', hint: _t('列出卡片上用過的標籤；沒指定的標籤依名稱自動配色。也可以先為還沒用過的標籤設定顏色。') },
      { key: 'board_overdue_remind_time', label: _t('過期未結案：每天提醒時間'), type: 'text', hint: _t('格式 HH:MM（預設 09:30）。單次卡片過了到期日還沒結案，會移到「過期未結案」，每天這個時間跳出提醒直到結案') },
    ] },
    { title: _t('導覽與搜尋'), icon: 'search', fields: [
      { key: 'search_placeholder', label: _t('搜尋框提示文字'), type: 'text' },
      { key: 'sidebar_default', label: _t('側邊欄預設'), type: 'seg', options: [['expanded', _t('展開')], ['collapsed', _t('收合成圖示列')]], hint: _t('每位使用者按左上角按鈕（或 Ctrl+B）切換後，會記住自己的選擇') },
      { key: 'sidebar_hover_expand', label: _t('收合時，滑鼠移到圖示列上自動展開'), type: 'switch' },
      { key: 'sidebar_show_icons', label: _t('側邊欄顯示圖示'), type: 'switch' },
      { key: 'sidebar_show_counts', label: _t('側邊欄顯示項目數'), type: 'switch' },
      { key: 'sidebar_show_links', label: _t('側邊欄也列出連結（不只資料夾）'), type: 'switch' },
      { key: 'show_quick_filters', label: _t('顯示快速篩選'), type: 'switch' },
      { key: 'quick_filters_title', label: _t('快速篩選標題'), type: 'text' },
      { key: 'quick_filters', label: _t('快速篩選項目'), type: 'filters', hint: _t('留空＝自動列出最常用的圖示') },
      { key: 'quick_filters_auto_limit', label: _t('自動產生時最多幾個'), type: 'number' },
    ] },
    { title: _t('卡片與個人化'), icon: 'grid', fields: [
      { key: 'show_descriptions', label: _t('顯示說明文字'), type: 'switch' },
      { key: 'show_link_host', label: _t('顯示連結網域'), type: 'switch' },
      { key: 'open_links_in_new_tab', label: _t('連結預設在新分頁開啟'), type: 'switch' },
      { key: 'enable_favorites', label: _t('啟用「我的最愛」'), type: 'switch' },
      { key: 'enable_recent', label: _t('啟用「最近使用」'), type: 'switch' },
      { key: 'favicon_web_fallback', label: _t('抓不到網站圖示時，改向 Google / DuckDuckGo 圖示服務取得'), type: 'switch', hint: _t('只用於公開網站；內網網址不會送出') },
      { key: 'allow_drop_add', label: _t('允許在入口直接拖曳網址新增'), type: 'switch', hint: _t('從瀏覽器網址列、網頁連結或書籤拖到入口頁面') },
      { key: 'quick_links_group_label', label: _t('快速連結的「群組」名稱'), type: 'text', placeholder: _t('例如：區域、部門') },
    ] },
  ];

  function renderSettings() {
    const keys = SETTINGS_GROUPS.flatMap(g => g.fields.map(f => f.key));
    let draft = Object.fromEntries(keys.map(k => [k, structuredClone(state.settings[k])]));
    const bar = saveBar(
      async () => { await saveSettings(draft); },
      () => { TT.applyAppearance(state.settings); paintBrand(); renderSettings0(); });

    const reset = el('button', { class: 'btn btn-ghost', type: 'button', html: svg('refresh') + _t('全部還原預設') });
    reset.addEventListener('click', async () => {
      if (!(await confirmDialog(_t('還原預設設定？'), _t('所有外觀與設定（含首頁版面）會回到預設值，內容資料不受影響。'), _t('還原')))) return;
      state.settings = await api('/api/settings/reset', { method: 'POST' });
      TT.applyAppearance(state.settings); paintBrand(); state.dirty = false; renderSettings0(); toast(_t('已還原預設'));
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
        case 'seg': return el('div', { class: 'field' }, el('span', { class: 'field-label', text: f.label }), segmented(f.options, f.key === 'clock_style' && v === 'flip' ? 'hud' : v, x => set(f.key, x)), f.hint ? el('span', { class: 'hint', text: f.hint }) : null);
        case 'accent': {
          const pick = colorPicker(v === '#6366f1' ? '' : v, x => set(f.key, x || ''));
          pick.querySelector('.swatch-none').title = _t('主題預設（深色：戰術綠 #10B981，淺色：墨綠 #2B4C3F）');
          return el('div', { class: 'field' }, el('span', { class: 'field-label', text: f.label }), pick);
        }
        case 'icon': return el('div', { class: 'field' }, el('span', { class: 'field-label', text: f.label }),
          iconButton(v, () => draft.site_title || 'T', x => set(f.key, x)), f.hint ? el('span', { class: 'hint', text: f.hint }) : null);
        case 'hours': { const i = el('input', { class: 'input', type: 'number', min: '0.5', max: '200', step: '0.5', value: v ?? '' }); i.addEventListener('input', () => set(f.key, parseFloat(i.value) || 1)); return field(f.label, i, f.hint); }
        case 'windows': return el('div', { class: 'field span-all' }, el('span', { class: 'field-label', text: f.label }),
          windowsEditor(v || [], x => set(f.key, x)), el('span', { class: 'hint', text: f.hint }));
        case 'tagcolors': return el('div', { class: 'field span-all' }, el('span', { class: 'field-label', text: f.label }),
          tagColorsEditor(v || {}, x => set(f.key, x)), el('span', { class: 'hint', text: f.hint }));
        case 'filters': return el('div', { class: 'field span-all' }, el('span', { class: 'field-label', text: f.label }), filtersEditor(v || [], x => set(f.key, x)), el('span', { class: 'hint', text: f.hint }));
        default: return el('span');
      }
    }

    function renderSettings0() {
      draft = Object.fromEntries(keys.map(k => [k, structuredClone(state.settings[k])]));
      cards = SETTINGS_GROUPS.map(g => el('section', { class: 'panel settings-card' },
        el('h3', { class: 'settings-card-title', html: svg(g.icon) + esc(g.title) }),
        el('div', { class: 'settings-fields' }, g.fields.map(control))));
      layout(true);
    }
    // masonry: each card goes, in order, under the shortest column (a plain grid leaves
    // tall gaps next to the long 待辦看板 card)
    let cards = [], cols = 0;
    function layout(force) {
      if (!holder.isConnected && !force) return;
      const n = Math.max(1, Math.floor(((holder.clientWidth || $('stage-body').clientWidth) + 16) / (420 + 16)));
      if (n === cols && !force) return;
      cols = n;
      const columns = Array.from({ length: n }, () => el('div', { class: 'settings-col' }));
      holder.replaceChildren(...columns);
      for (const c of cards) {
        const target = columns.reduce((a, b) => (b.offsetHeight < a.offsetHeight ? b : a));
        target.append(c);
      }
    }
    const ro = new ResizeObserver(() => { if (!holder.isConnected) return ro.disconnect(); layout(false); });
    ro.observe(holder);
    renderSettings0();
  }

  function filtersEditor(list, onChange) {
    const items = list.map(f => ({ ...f }));
    const box = el('div', { class: 'filters-editor' });
    const paint = () => {
      box.replaceChildren(...items.map((f, i) => {
        const label = el('input', { class: 'input', value: f.label || '', placeholder: _t('顯示名稱') });
        label.addEventListener('input', () => { f.label = label.value; onChange(items); });
        const iconBtn = el('button', { class: 'btn btn-sm filter-icon-btn', type: 'button' }, tile({ icon: f.icon, name: f.label, size: 22 }), el('span', { text: f.icon || _t('選擇圖示') }));
        iconBtn.addEventListener('click', async () => { const v = await pickIcon(f.icon); if (v) { f.icon = v; onChange(items); paint(); } });
        const del = el('button', { class: 'icon-btn danger', type: 'button', html: svg('trash'), title: _t('移除') });
        del.addEventListener('click', () => { items.splice(i, 1); onChange(items); paint(); });
        return el('div', { class: 'filter-row' }, iconBtn, label, del);
      }));
      const add = el('button', { class: 'btn btn-sm', type: 'button', html: svg('plus') + _t('新增篩選') });
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
  // ======================================================================
  // Accounts & roles (server edition)
  // ======================================================================
  async function renderUsers() {
    const body = $('stage-body');
    let data;
    try { data = await api('/api/users'); } catch (e) { body.append(el('p', { class: 'hint', text: e.message })); return; }
    const filter = el('input', { class: 'input', placeholder: _t('篩選帳號、姓名或部門…') });
    const addBox = el('div', { class: 'users-add' });
    if (data.directory) {
      const addInput = TT.mentionInput(el('input', { class: 'input', placeholder: _t('輸入 @ 搜尋 AD 帳號，預先加入（還沒登入過的人）') }));
      const addBtn = el('button', { class: 'btn', type: 'button', html: svg('plus') + _t('加入') });
      addBtn.addEventListener('click', async () => {
        const name = addInput.value.trim().replace(/^@/, '');
        if (!name) return;
        try { await api('/api/users', { method: 'POST', body: { username: name } }); toast(_t("已加入 {0}", name)); route(); }
        catch (e) { toast(e.message, true); }
      });
      addBox.append(addInput, addBtn);
    } else {
      addBox.append(el('p', { class: 'hint', text: data.ldap
        ? _t('AD 帳號在第一次登入後才會出現在這裡。（設定 AD 服務帳號 TOOL_TABLE_LDAP_BIND_DN 後，就能在這裡預先加入、在看板 @ 還沒登入過的人。）')
        : _t('尚未設定 AD 連線：請在 /etc/tool-table/tool-table.env 填入 TOOL_TABLE_LDAP_* 設定後重新啟動服務。') }));
    }
    const summary = el('div', { class: 'users-summary' },
      el('span', { class: 'badge', text: _t("{0} 個帳號", data.users.length) }),
      el('span', { class: 'badge' + (data.ad_admins ? '' : ' badge-alert'), text: _t("{0} 位 AD 系統管理", data.ad_admins) }),
      data.users.some(u => u.role === 'guest' && u.active)
        ? el('span', { class: 'badge badge-warn', title: _t('AD 帳號第一次登入時是「訪客」：只能看入口連結。把權限改成「使用者」或以上即可開通'),
          text: _t("{0} 位訪客待開通", data.users.filter(u => u.role === 'guest' && u.active).length) }) : null);
    const list = el('div', { class: 'users-list panel' });
    const paint = () => {
      const q = filter.value.trim().toLowerCase();
      const rows = data.users.filter(u => !q || [u.username, u.display_name, u.department].some(v => (v || '').toLowerCase().includes(q)))
        .sort((a, b) => (b.role === 'guest' && b.active) - (a.role === 'guest' && a.active));      // waiting for a level: first
      list.replaceChildren(el('div', { class: 'users-row users-head' },
        el('span', { text: _t('帳號') }), el('span', { text: _t('部門') }), el('span', { text: _t('上級') }), el('span', { text: _t('卡片') }), el('span', { text: _t('最後登入') }), el('span', { text: _t('權限') }), el('span', { text: _t('啟用') })),
        ...rows.map(u => {
          const local = u.role === 'superadmin';
          const label = k => (data.roles.find(r => r.key === k) || {}).label || k;
          let role;
          if (local) role = el('span', { class: 'role-badge role-superadmin', text: _t('本機最高管理員') });
          else {
            const sel = el('select', { class: 'select role-select' }, data.roles.map(r => el('option', { value: r.key, text: r.label })));
            sel.value = u.role;
            const scope = el('div', { class: 'scope-box', hidden: !['dept_admin', 'dept_viewer'].includes(u.role) });
            const paintScope = () => {
              const mine = (u.scope_departments && u.scope_departments.length) ? u.scope_departments : (u.department ? [u.department] : []);
              const all = [...new Set([...data.departments, ...mine])];
              scope.replaceChildren(...[el('span', { class: 'scope-label', text: _t('管理部門：') }), ...all.map(d => {
                const b = el('button', { type: 'button', class: 'scope-chip', 'aria-pressed': String(mine.includes(d)), text: d });
                b.addEventListener('click', async () => {
                  const next = mine.includes(d) ? mine.filter(x => x !== d) : [...mine, d];
                  try { Object.assign(u, await api(`/api/users/${u.id}`, { method: 'PUT', body: { scope_departments: next } })); paintScope(); }
                  catch (e) { toast(e.message, true); }
                });
                return b;
              }), all.length ? null : el('span', { class: 'hint', text: _t('此帳號在 AD 沒有部門，請勾選要管理的部門') })].filter(Boolean));
            };
            paintScope();
            sel.addEventListener('change', async () => {
              try {
                Object.assign(u, await api(`/api/users/${u.id}`, { method: 'PUT', body: { role: sel.value } }));
                toast(`${u.display_name || u.username} → ${label(u.role)}`);
                scope.hidden = !['dept_admin', 'dept_viewer'].includes(u.role);
                paintScope();
              } catch (e) { toast(e.message, true); sel.value = u.role; }
              data = { ...data, ...(await api('/api/users')) };
              summary.lastChild.textContent = _t("{0} 位 AD 系統管理", data.ad_admins); summary.lastChild.classList.toggle('badge-alert', !data.ad_admins);
            });
            // 系統管理: an extra identity on top of the level (any level except guest) — the admin panel only
            const sa = el('label', { class: 'sa-toggle' + (u.sys_admin ? ' on' : ''), title: _t('系統管理：可以進後台調整設定與查詢（稽核紀錄、系統狀態…）；看板上的權限仍依左邊的等級') },
              el('input', { type: 'checkbox', checked: !!u.sys_admin, disabled: u.role === 'guest' }), el('span', { text: _t('＋系統管理') }));
            if (u.role === 'guest') sa.title = _t('訪客不能被賦予系統管理，請先開通為使用者或以上');
            sa.querySelector('input').addEventListener('change', async e => {
              const on = e.target.checked;
              try {
                Object.assign(u, await api(`/api/users/${u.id}`, { method: 'PUT', body: { sys_admin: on } }));
                toast(on ? _t('{0}：已賦予系統管理', u.display_name || u.username) : _t('{0}：已移除系統管理', u.display_name || u.username));
              } catch (err) { toast(err.message, true); e.target.checked = !on; }
              sa.classList.toggle('on', !!u.sys_admin);
              data = { ...data, ...(await api('/api/users')) };
              summary.lastChild.textContent = _t("{0} 位 AD 系統管理", data.ad_admins); summary.lastChild.classList.toggle('badge-alert', !data.ad_admins);
            });
            sel.addEventListener('change', () => {
              const g = sel.value === 'guest';
              sa.querySelector('input').disabled = g;
              if (g) { sa.querySelector('input').checked = false; sa.classList.remove('on'); }
            });
            role = el('div', { class: 'role-cell' }, el('div', { class: 'role-line' }, sel, sa), scope);
          }
          const active = local ? el('span') : switchInput(!!u.active, async v => {
            try { Object.assign(u, await api(`/api/users/${u.id}`, { method: 'PUT', body: { active: v } })); toast(v ? _t('已啟用') : _t('已停用（已登出）')); }
            catch (e) { toast(e.message, true); paint(); }
          });
          // 上級 (reporting line): from AD's manager attribute, or picked here (then AD leaves it alone)
          const boss = el('div', { class: 'boss-cell' });
          const paintBoss = () => {
            if (local) { boss.replaceChildren(el('span', { class: 'muted', text: '—' })); return; }
            const pick = el('button', { class: 'boss-btn', type: 'button', title: _t('設定上級') },
              u.manager ? TT.avatar({ ...u.manager }, 20) : null, el('span', { text: u.manager ? u.manager.name : _t('（無）') }),
              u.manager_source ? el('small', { class: 'boss-src', text: u.manager_source === 'manual' ? _t('手動') : 'AD' }) : null);
            pick.addEventListener('click', () => {
              const inp = TT.mentionInput(el('input', { class: 'input input-sm', placeholder: _t('輸入上級的姓名或帳號…') }), {
                onPick: async p => {
                  try { Object.assign(u, await api(`/api/users/${u.id}`, { method: 'PUT', body: { manager: p.username } })); data = { ...data, ...(await api('/api/users')) }; paint(); toast(_t("{0} 的上級：{1}", u.display_name || u.username, TT.nameOf(p))); }
                  catch (e) { toast(e.message, true); paintBoss(); }
                } });
              const none = el('button', { class: 'kb-link-btn', type: 'button', text: _t('無上級') });
              none.addEventListener('mousedown', e => e.preventDefault());
              none.addEventListener('click', async () => { try { await api(`/api/users/${u.id}`, { method: 'PUT', body: { manager: '' } }); data = { ...data, ...(await api('/api/users')) }; paint(); } catch (e) { toast(e.message, true); } });
              const ad = u.manager_source === 'manual' && data.sync_manager ? el('button', { class: 'kb-link-btn', type: 'button', text: _t('改回依 AD') }) : null;
              ad?.addEventListener('mousedown', e => e.preventDefault());
              ad?.addEventListener('click', async () => { try { await api(`/api/users/${u.id}`, { method: 'PUT', body: { manager: '@ad' } }); toast(_t('下次登入時依 AD 更新')); data = { ...data, ...(await api('/api/users')) }; paint(); } catch (e) { toast(e.message, true); } });
              inp.addEventListener('keydown', e => { if (e.key === 'Escape') paintBoss(); });
              inp.addEventListener('blur', () => setTimeout(() => boss.isConnected && boss.contains(inp) && paintBoss(), 250));
              boss.replaceChildren(...[inp, none, ad].filter(Boolean));
              inp.focus();
            });
            boss.replaceChildren(...[pick, u.reports ? el('small', { class: 'muted', text: _t("下級 {0} 人", u.reports) }) : null].filter(Boolean));
          };
          paintBoss();
          return el('div', { class: 'users-row' + (u.active ? '' : ' is-off') + (u.role === 'guest' ? ' is-guest' : '') },
            el('span', { class: 'users-who' }, TT.avatar({ ...u, name: u.display_name }, 32),
              el('span', {}, el('strong', { text: u.display_name || u.username }, u.role === 'guest' ? el('span', { class: 'users-guest', text: _t('待開通') }) : null), el('small', { text: `${u.username}${u.source === 'local' ? _t(' · 本機帳號') : u.source === 'demo' ? _t(' · 示範帳號') : ''}${u.email ? ' · ' + u.email : ''}` }))),
            el('span', { text: u.department || '—' }),
            boss,
            el('span', { class: 'muted', text: _t("建 {0} · 負責 {1}", u.created_cards, u.assigned_cards) }),
            el('span', { class: 'muted', text: u.last_login ? u.last_login.slice(0, 16) : _t('尚未登入') }),
            role, active);
        }));
    };
    filter.addEventListener('input', paint);
    body.append(
      el('div', { class: 'users-tools' }, filter, summary),
      addBox,
      list,
      el('table', { class: 'role-table' },
        el('thead', {}, el('tr', {}, ...[_t('權限'), _t('後台'), _t('看板：看得到'), _t('看板：可編輯 / 刪除 / 指派')].map(t => el('th', { text: t })))),
        el('tbody', {}, ...[
          [_t('看板總管理者（RW）'), '—', _t('所有卡片'), _t('所有卡片')],
          [_t('看板總管理者（RO）'), '—', _t('所有部門的卡片'), _t('只有自己的卡片；其他卡片可留言')],
          [_t('部門看板管理者（RW）'), '—', _t('管理部門的卡片 ＋ 自己的'), _t('管理部門的卡片（只能指派該部門的人）＋ 自己的')],
          [_t('部門看板管理者（RO）'), '—', _t('管理部門的卡片 ＋ 自己的'), _t('只有自己的卡片；其他卡片可留言')],
          [_t('使用者'), '—', _t('自己建立、被指派、被 @ 的卡片'), _t('同左（不能指派）')],
          [_t('訪客（未開通）'), '—', _t('只有入口的公用連結'), _t('無')],
          [_t('＋ 系統管理（使用者以上任何等級都可另外賦予）'), _t('全部設定與查詢'), _t('不增加：依原本的等級'), _t('不增加：依原本的等級')],
          [_t('＋ 上級（任何權限都適用）'), '—', _t('另外加上所有下級（多層）的卡片'), _t('依「外觀與設定 → 上級對下級卡片的權限」：可編輯（增刪修、指派給下級）／檢視＋留言')],
        ].map(r => el('tr', {}, ...r.map(c => el('td', { text: c })))))),
      el('p', { class: 'hint', html: _t("卡片屬於「建立者」與「負責人」所在的部門（AD 的 department）。部門看板管理者預設管理自己的部門，可以在上面勾選其他部門。<br>「系統管理」是附加在等級上的身分：只能操作後台的設定與查詢，看板上看得到、能改什麼仍依原本的等級（例如「使用者＋系統管理」在看板上只看得到自己的卡片）；訪客不能被賦予。至少要保留一位 AD 帳號有系統管理。本機最高管理員（{0}）只在緊急時使用，密碼可在右上角選單修改，或在伺服器執行 <code>tool-table.sh reset-admin</code>。", esc((data.users.find(u => u.role === 'superadmin') || {}).username || 'localadmin')) }));
    paint();
  }

  async function renderAutoBackup(box) {
    let B;
    try { B = await api('/api/system/backup'); } catch (e) { box.replaceChildren(el('p', { class: 'hint', text: e.message })); return; }
    const on = switchCtl(B.enabled, _t('完整備份'), () => {});
    const time = input(B.time, { type: 'time' });
    const DAYS = [_t('一'), _t('二'), _t('三'), _t('四'), _t('五'), _t('六'), _t('日')];
    let days = [...(B.full_days || [6])];
    const dayBox = el('div', { class: 'scope-box' }, ...DAYS.map((d, i) => {
      const b = el('button', { type: 'button', class: 'scope-chip', 'aria-pressed': String(days.includes(i)), text: d });
      b.addEventListener('click', () => { days = days.includes(i) ? days.filter(x => x !== i) : [...days, i]; b.setAttribute('aria-pressed', String(days.includes(i))); });
      return b;
    }));
    const incOn = switchCtl(B.inc_enabled !== false, _t('增量備份'), () => {});
    const every = el('select', { class: 'select' }, ...[1, 2, 3, 4, 6, 8, 12, 24].map(h => el('option', { value: h, text: _t("每 {0} 小時", h), selected: h === (B.inc_every_hours || 6) })));
    const keep = input(B.keep_days, { type: 'number', min: '1', max: '3650' });
    const save = el('button', { class: 'btn btn-primary', type: 'button', html: svg('check') + _t('儲存排程') });
    save.addEventListener('click', async () => {
      try {
        B = await api('/api/system/backup', { method: 'PUT', body: { enabled: on.querySelector('input').checked, time: time.value, keep_days: Number(keep.value),
          full_days: days, inc_enabled: incOn.querySelector('input').checked, inc_every_hours: Number(every.value) } });
        toast(_t('已儲存'));
      } catch (e) { toast(e.message, true); }
    });
    const nowBtn = (kind, label) => {
      const b = el('button', { class: 'btn', type: 'button', html: svg('database') + label });
      b.addEventListener('click', async () => {
        b.disabled = true;
        try { const r = await api('/api/system/backups', { method: 'POST', body: { kind } }); toast(_t("已備份：{0}", r.name) + (r.check ? `（${r.check}）` : ''), r.check_ok === false); renderAutoBackup(box); }
        catch (e) { toast(e.message, true); b.disabled = false; }
      });
      return b;
    };
    const upFile = el('input', { type: 'file', accept: '.gz,.tgz,application/gzip', hidden: true });
    const upBtn = el('button', { class: 'btn btn-ghost', type: 'button', html: svg('upload') + _t('上傳備份檔') });
    upBtn.addEventListener('click', () => upFile.click());
    upFile.addEventListener('change', async () => {
      const f = upFile.files[0]; upFile.value = '';
      if (!f) return;
      const form = new FormData(); form.append('file', f);
      try { const b = await api('/api/system/backups/upload', { method: 'POST', form }); toast(_t("已上傳：{0}，可以按「還原」", b.name)); renderAutoBackup(box); }
      catch (e) { toast(e.message, true); }
    });
    const size = n => n > 1073741824 ? `${(n / 1073741824).toFixed(2)} GB` : n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
    const rows = B.backups.length ? B.backups.map(b => {
      const restore = el('button', { class: 'btn btn-sm', type: 'button', html: svg('refresh') + _t('還原'), disabled: b.complete === false,
        title: b.complete === false ? _t('這份增量備份需要的備份檔不見了，無法還原') : '' });
      const del = el('button', { class: 'icon-btn danger', type: 'button', title: _t('刪除'), html: svg('trash') });
      restore.addEventListener('click', async () => {
        if (!(await confirmDialog(_t("還原 {0} 的備份？", b.created.replace('T', ' ')),
          _t('資料庫、圖示、所有附件與加密設定會換成這份備份的內容（帳號、看板、連結、設定）。還原前會先驗證每個檔案的檢查碼，並自動再備份一次目前的狀態。還原後需要重新登入。'), _t('還原')))) return;
        try { const r = await api(`/api/system/backups/${encodeURIComponent(b.name)}/restore`, { method: 'POST' }); toast(_t("已還原（還原前的狀態存成 {0}）", r.safety_backup)); setTimeout(() => location.reload(), 1200); }
        catch (e) { toast(e.message, true); }
      });
      del.addEventListener('click', async () => {
        const warn = b.needed_by ? _t("有 {0} 份增量備份需要這份備份的檔案，刪掉後它們就無法還原。", b.needed_by) : '';
        if (!(await confirmDialog(_t('刪除這份備份？'), (warn ? warn + '\n' : '') + b.name, _t('刪除')))) return;
        try { await api(`/api/system/backups/${encodeURIComponent(b.name)}${b.needed_by ? '?force=true' : ''}`, { method: 'DELETE' }); renderAutoBackup(box); } catch (e) { toast(e.message, true); }
      });
      const info = [b.type === 'inc' ? _t("新增／變更 {0} 個檔案，共 {1}", b.added ?? 0, size(b.total || 0)) : b.files != null ? _t("{0} 個檔案，共 {1}", b.files, size(b.total || 0)) : '',
        b.type === 'inc' && b.chain?.length ? _t("需要 {0} 份較早的備份", b.chain.length) : '', b.needed_by ? _t("{0} 份增量依賴它", b.needed_by) : ''].filter(Boolean).join(' · ');
      return el('div', { class: 'bk-row' + (b.type === 'inc' ? ' is-inc' : '') },
        el('span', { class: 'bk-when', text: b.created.replace('T', ' ') }),
        el('span', { class: 'bk-kind' + (b.type === 'inc' ? ' inc' : ''), text: b.kind }),
        el('span', { class: 'bk-size', text: size(b.size) }),
        el('span', { class: 'bk-info' }, info ? el('span', { text: info }) : '',
          b.check ? el('span', { class: 'bk-check' + (b.check_ok ? ' ok' : ' bad'), text: (b.check_ok ? '✓ ' : '⚠ ') + b.check }) : ''),
        el('span', { class: 'bk-actions' }, el('a', { class: 'btn btn-sm btn-ghost', href: `/api/system/backups/${encodeURIComponent(b.name)}`, download: b.name,
          title: b.type === 'inc' ? _t('下載時會把它需要的較早備份合成一份完整的檔案') : '', html: svg('download') + _t('下載') }), restore, del));
    }) : [el('p', { class: 'hint', text: _t('還沒有備份') })];
    box.replaceChildren(
      el('h3', { class: 'settings-card-title', html: svg('database') + _t('自動備份（資料庫、所有附件與圖示、帳號與加密設定）') }),
      el('div', { class: 'sys-form' }, el('div', { class: 'field' }, on), field(_t('時間'), time),
        el('div', { class: 'field' }, el('span', { class: 'field-label', text: _t('完整備份：每週') }), dayBox)),
      el('div', { class: 'sys-form' }, el('div', { class: 'field' }, incOn), field(_t('間隔'), every), field(_t('保留天數'), keep)),
      el('p', { class: 'hint', text: _t('完整備份包含所有檔案；增量備份每次都有完整的資料庫，檔案只存上次備份後新增或變更的，還原時自動從較早的備份補齊並逐一核對檢查碼。每次備份都會檢查資料庫記錄的附件是否都在。超過保留天數的備份會刪除，但還有增量備份需要的會保留。') }),
      el('p', { class: 'hint', text: B.last_run ? _t("上次自動備份：{0}　{1}", B.last_run.replace('T', ' '), B.last_result) : _t('尚未執行過自動備份') }),
      el('div', { class: 'sys-actions' }, nowBtn('full', _t('立即完整備份')), nowBtn('inc', _t('立即增量備份')), upBtn, upFile, el('span', { class: 'spacer' }), save),
      el('div', { class: 'bk-list' }, rows),
      el('p', { class: 'hint', text: _t("備份存放在伺服器的 {0}。下載的備份檔含有解密金鑰，請妥善保管。", B.dir) }));
  }




  // ======================================================================
  // System settings (AD, sign-in security, HTTPS certificate, ports)
  // ======================================================================
  function sysCard(icon, title, intro, ...body) {
    return el('section', { class: 'panel settings-card sys-card' },
      el('h3', { class: 'settings-card-title', html: svg(icon) + esc(title) }),
      intro ? el('p', { class: 'hint sys-intro', html: intro }) : null, ...body);
  }
  const input = (value, attrs = {}) => { const i = el('input', { class: 'input', ...attrs }); i.value = value ?? ''; return i; };
  const resultBox = () => el('div', { class: 'sys-result', hidden: true });
  function showSteps(box, res) {
    box.hidden = false;
    box.replaceChildren(...res.steps.map(st => el('div', { class: `sys-step is-${st.status}`, html: svg(st.status === 'ok' ? 'check' : st.status === 'fail' ? 'x' : 'sparkles') + `<span>${esc(st.text)}</span>` })));
  }
  async function waitApply(id, box, done) {
    box.hidden = false;
    box.replaceChildren(el('div', { class: 'sys-step is-info', html: svg('refresh') + _t('<span>套用中…（由伺服器的管理服務執行，通常幾秒內完成）</span>') }));
    for (let i = 0; i < 40; i++) {
      await new Promise(r => setTimeout(r, 1500));
      let r;
      try { r = await api(`/api/system/apply/${id}`); } catch { continue; }      // nginx may be reloading
      if (r.pending) continue;
      box.replaceChildren(el('div', { class: `sys-step is-${r.ok ? 'ok' : 'fail'}`, html: svg(r.ok ? 'check' : 'x') + `<span>${esc(r.message)}</span>` }));
      done?.(r);
      return r;
    }
    box.replaceChildren(el('div', { class: 'sys-step is-fail', html: svg('x') + _t('<span>等候逾時：伺服器的管理服務（tool-table-apply.path）沒有回應。請重新執行一次升級（upgrade）讓它安裝。</span>') }));
  }

  function teamsCard(TM) {
    const EVENTS = [['changes', _t('卡片與專案的變更')], ['project', _t('每日專案事件')], ['system', _t('系統與硬體告警')], ['health', _t('定時系統狀態報告')]];
    let projects = [];
    api('/api/tasks').then(list => { projects = (list || []).filter(t => (t.kind || 'ops') === 'project').map(t => ({ id: t.id, title: t.title })); paintChannels(); }).catch(() => {});
    const chans = TM.channels.map(c => ({ ...c, url: null }));
    const box = el('div', { class: 'tm-channels' });
    const chk = (on, label, onChange) => { const i = el('input', { type: 'checkbox', checked: !!on }); i.addEventListener('change', () => onChange(i.checked)); return el('label', { class: 'tm-check' }, i, el('span', { text: label })); };
    function paintChannels() {
      box.replaceChildren(...chans.map((c, idx) => {
        const name = input(c.name, { placeholder: _t('頻道名稱，例如 網管部 / 專案群組'), maxlength: '60' });
        name.addEventListener('input', () => { c.name = name.value; });
        const url = input('', { type: 'url', placeholder: c.url_set ? _t('已設定：{0}（留空 = 不變）', c.url_host || 'Teams') : 'https://…logic.azure.com/… 或 https://…/workflows/…' });
        url.addEventListener('input', () => { c.url = url.value.trim() || null; });
        const scope = el('select', { class: 'select' }, ...[['projects', _t('只有專案（含歸屬卡片）')], ['all', _t('所有卡片')], ['chosen', _t('指定的專案')]].map(([v, l]) => el('option', { value: v, text: l, selected: (c.scope || 'projects') === v })));
        const picks = el('div', { class: 'tm-projects', hidden: (c.scope || 'projects') !== 'chosen' },
          ...(projects.length ? projects.map(p => chk((c.projects || []).includes(p.id), p.title, on => { c.projects = (c.projects || []).filter(x => x !== p.id).concat(on ? [p.id] : []); }))
            : [el('span', { class: 'hint', text: _t('還沒有專案') })]));
        scope.addEventListener('change', () => { c.scope = scope.value; picks.hidden = scope.value !== 'chosen'; });
        const test = el('button', { class: 'btn btn-sm', type: 'button', html: svg('zap') + _t('測試') });
        const res = resultBox();
        test.addEventListener('click', async () => {
          test.disabled = true;
          try { showSteps(res, await api('/api/system/teams/test', { method: 'POST', body: { id: c.id || '', url: c.url || null } })); }
          catch (e) { showSteps(res, { steps: [{ status: 'fail', text: e.message }] }); }
          test.disabled = false;
        });
        const del = el('button', { class: 'icon-btn', type: 'button', 'aria-label': _t('刪除這個頻道'), html: svg('trash') });
        del.addEventListener('click', () => { chans.splice(idx, 1); paintChannels(); });
        return el('div', { class: 'tm-channel' },
          el('div', { class: 'tm-row' }, chk(c.enabled !== false, _t('啟用'), on => { c.enabled = on; }), name, del),
          el('div', { class: 'tm-row' }, url, test),
          el('div', { class: 'tm-row tm-events' }, el('span', { class: 'field-label', text: _t('傳送') }),
            ...EVENTS.map(([k, l]) => chk((c.events || []).includes(k), l, on => { c.events = (c.events || []).filter(x => x !== k).concat(on ? [k] : []); }))),
          el('div', { class: 'tm-row' }, el('span', { class: 'field-label', text: _t('卡片變更的範圍') }), scope), picks, res);
      }), (() => {
        const add = el('button', { class: 'btn btn-sm', type: 'button', html: svg('plus') + _t('新增頻道') });
        add.addEventListener('click', () => { chans.push({ id: '', name: '', url: null, enabled: true, events: ['changes', 'project', 'system'], scope: 'projects', projects: [] }); paintChannels(); });
        return add;
      })());
    }
    paintChannels();
    const o = {
      lang: el('select', { class: 'select' }, ...[['site', _t('同網站預設語言')], ['zh-TW', '繁體中文'], ['en', 'English']].map(([v, l]) => el('option', { value: v, text: l, selected: TM.lang === v }))),
      site_url: input(TM.site_url, { placeholder: TM.default_site_url }),
      quiet_seconds: input(TM.quiet_seconds, { type: 'number', min: '10', max: '3600' }),
      health_times: input(TM.health_times, { placeholder: '08:30,17:30' }),
      health_only_abnormal: switchCtl(TM.health_only_abnormal, _t('全部正常時不送報告'), () => {}),
      repeat_hours: input(TM.repeat_hours, { type: 'number', min: '0', max: '168', step: '0.5' }),
    };
    const TH = [['disk_warn', 'disk_fail', _t('磁碟使用率（%）')], ['mem_warn', 'mem_fail', _t('可用記憶體（%，低於）')], ['load_warn', 'load_fail', _t('CPU 負載（每核 5 分鐘平均）')],
      ['temp_warn', 'temp_fail', _t('溫度（°C）')], ['cert_warn', 'cert_fail', _t('HTTPS 憑證剩餘天數（低於）')]];
    const th = {};
    TH.forEach(([a, b]) => { th[a] = input(TM[a], { type: 'number', step: 'any' }); th[b] = input(TM[b], { type: 'number', step: 'any' }); });
    th.backup_hours = input(TM.backup_hours, { type: 'number', min: '1' });
    const status = el('div', { class: 'tm-status' }, el('p', { class: 'hint', text: _t('讀取中…') }));
    const LV = { ok: _t('正常'), warn: _t('注意'), fail: _t('告警') };
    const loadStatus = async () => {
      try {
        const r = await api('/api/system/monitor');
        status.replaceChildren(el('table', { class: 'tm-table' }, el('tbody', {}, ...r.items.map(it =>
          el('tr', {}, el('td', {}, el('span', { class: `tm-lv lv-${it.level}`, text: LV[it.level] })), el('td', { text: `${it.group} / ${it.name}` }), el('td', { text: it.detail }))))));
      } catch (e) { status.replaceChildren(el('p', { class: 'hint', text: e.message })); }
    };
    loadStatus();
    const report = el('button', { class: 'btn', type: 'button', html: svg('megaphone') + _t('立即送出狀態報告') });
    report.addEventListener('click', async () => { try { const r = await api('/api/system/teams/report', { method: 'POST' }); toast(_t('已排入 {0} 個頻道', r.queued)); } catch (e) { toast(e.message, true); } });
    const refresh = el('button', { class: 'btn btn-ghost', type: 'button', html: svg('refresh') + _t('重新檢查') });
    refresh.addEventListener('click', loadStatus);
    const save = el('button', { class: 'btn btn-primary', type: 'button', html: svg('check') + _t('儲存 Teams 設定') });
    const last = el('p', { class: 'hint', text: TM.last_result ? _t('最近一次傳送：{0}', TM.last_result) : '' });
    save.addEventListener('click', async () => {
      const num = x => Number(x.value);
      try {
        TM = await api('/api/system/teams', { method: 'PUT', body: {
          channels: chans.map(c => ({ id: c.id || '', name: c.name || '', url: c.url, enabled: c.enabled !== false, events: c.events || [], scope: c.scope || 'projects', projects: c.projects || [] })),
          lang: o.lang.value, site_url: o.site_url.value.trim(), quiet_seconds: num(o.quiet_seconds), health_times: o.health_times.value.trim(),
          health_only_abnormal: o.health_only_abnormal.querySelector('input').checked, repeat_hours: num(o.repeat_hours),
          ...Object.fromEntries(Object.entries(th).map(([k, v]) => [k, num(v)])) } });
        chans.splice(0, chans.length, ...TM.channels.map(c => ({ ...c, url: null })));
        paintChannels();
        toast(_t('Teams 設定已儲存'));
      } catch (e) { toast(e.message, true); }
    });
    return sysCard('megaphone', _t('Microsoft Teams 通知'),
      _t('在 Teams 頻道新增工作流程「收到 webhook 要求時張貼到頻道」（Post to a channel when a webhook request is received），把它產生的網址貼到下面。不需要 Entra ID 應用程式；網址等同密碼，加密保存。') + '<br>' +
      _t('卡片變更：同一張卡片一分鐘內的修改合成一則，列出「欄位：原本 → 現在」與修改的人（單機版同步上來的修改也算）。系統告警：異常時、持續異常時（定時提醒）與恢復時各通知一次。'),
      el('div', { class: 'span-all' }, box),
      el('div', { class: 'sys-form' },
        field(_t('訊息語言'), o.lang), field(_t('網站網址（訊息裡的連結）'), o.site_url, _t('留空 = 依伺服器名稱與連接埠')),
        field(_t('卡片靜止幾秒後送出變更'), o.quiet_seconds), field(_t('狀態報告時間'), o.health_times, _t('多個時間用逗號分開')),
        el('div', { class: 'field' }, o.health_only_abnormal), field(_t('持續異常每隔幾小時提醒（0 = 不提醒）'), o.repeat_hours),
        el('details', { class: 'sys-advanced span-all' }, el('summary', { text: _t('告警門檻（注意 / 告警）') }),
          el('div', { class: 'sys-form' }, ...TH.map(([a, b, l]) => el('div', { class: 'field' }, el('span', { class: 'field-label', text: l }), el('div', { class: 'sys-test-row' }, th[a], th[b]))),
            field(_t('超過幾小時沒有成功的自動備份'), th.backup_hours)))),
      el('div', { class: 'sys-test' }, el('span', { class: 'field-label', text: _t('目前的系統狀態') }), status, el('div', { class: 'sys-test-row' }, refresh, report)),
      last, el('div', { class: 'sys-actions' }, save));
  }

  /** part: 'auth' (AD 驗證: AD, Entra ID, 登入安全), 'tls' (HTTPS 憑證: certificate, ports), 'delivery' (發送與通知: Teams) */
  async function renderSystem(part) {
    const body = $('stage-body');
    const grid = el('div', { class: 'sys-grid' });
    body.append(grid);
    const auth = state.me?.auth;

    // ---------------- Microsoft Teams: channels, what they get, system / hardware alerts
    if (part === 'delivery') {
      let TM;
      try { TM = await api('/api/system/teams'); } catch (e) { grid.append(el('p', { class: 'hint', text: e.message })); return; }
      grid.append(teamsCard(TM));
      return;
    }

    // ---------------- AD / LDAP
    if (auth && part === 'auth') {
      let L;
      try { L = await api('/api/system/ldap'); } catch (e) { grid.append(el('p', { class: 'hint', text: e.message })); return; }
      const f = {
        enabled: switchCtl(L.enabled, _t('啟用 AD 登入'), () => {}),
        url: input(L.url, { placeholder: 'ldaps://dc1.corp.local' }),
        base_dn: input(L.base_dn, { placeholder: 'DC=corp,DC=local' }),
        bind_dn: input(L.bind_dn, { placeholder: 'CN=svc-tooltable,OU=Service Accounts,DC=corp,DC=local' }),
        bind_password: input('', { type: 'password', autocomplete: 'new-password', placeholder: L.bind_password_set ? _t('••••••••（已設定；留空 = 不變）') : _t('服務帳號密碼') }),
        domain: input(L.domain, { placeholder: 'corp.local' }),
        user_filter: input(L.user_filter, { placeholder: '(memberOf=CN=ToolTable-Users,OU=Groups,DC=corp,DC=local)' }),
        login_attr: input(L.login_attr), name_attr: input(L.name_attr), dept_attr: input(L.dept_attr), mail_attr: input(L.mail_attr),
        manager_attr: input(L.manager_attr || 'manager'),
        sync_manager: switchCtl(L.sync_manager !== false, _t('從 AD 同步上級（manager 屬性；登入時更新，在「帳號管理」手動設定的不受影響）'), () => {}),
        starttls: switchCtl(L.starttls, _t('ldap:// 時使用 StartTLS 加密'), () => {}),
        tls_verify: switchCtl(L.tls_verify, _t('驗證網域控制站憑證（建議）'), () => {}),
        ca_pem: el('textarea', { class: 'textarea mono', rows: '4', placeholder: _t('-----BEGIN CERTIFICATE-----\n（內部 CA 簽發時貼上，可多張）') }),
        timeout: input(L.timeout, { type: 'number', min: '2', max: '30' }),
      };
      f.ca_pem.value = L.ca_pem || '';
      let clearPw = false;
      const clearBtn = L.bind_password_set ? el('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: _t('清除已存的密碼') }) : null;
      clearBtn?.addEventListener('click', () => { clearPw = true; f.bind_password.placeholder = _t('（儲存後清除）'); toast(_t('儲存後會清除服務帳號密碼')); });
      const chk = el => el.querySelector('input').checked;
      const values = () => ({
        enabled: chk(f.enabled), url: f.url.value.trim(), base_dn: f.base_dn.value.trim(), bind_dn: f.bind_dn.value.trim(),
        bind_password: f.bind_password.value ? f.bind_password.value : (clearPw ? '' : null),
        domain: f.domain.value.trim(), user_filter: f.user_filter.value.trim(),
        login_attr: f.login_attr.value.trim(), name_attr: f.name_attr.value.trim(), dept_attr: f.dept_attr.value.trim(), mail_attr: f.mail_attr.value.trim(),
        manager_attr: f.manager_attr.value.trim() || 'manager', sync_manager: chk(f.sync_manager),
        starttls: chk(f.starttls), tls_verify: chk(f.tls_verify), ca_pem: f.ca_pem.value, timeout: Number(f.timeout.value) || 6,
      });
      const res = resultBox();
      const tUser = input('', { placeholder: _t('測試帳號（選填）'), autocomplete: 'off' });
      const tPass = input('', { type: 'password', placeholder: _t('密碼'), autocomplete: 'new-password' });
      const tSearch = input('', { placeholder: _t('搜尋目錄（選填，例如 王）') });
      const testBtn = el('button', { class: 'btn', type: 'button', html: svg('zap') + _t('測試') });
      const saveBtn = el('button', { class: 'btn btn-primary', type: 'button', html: svg('check') + _t('儲存 AD 設定') });
      testBtn.addEventListener('click', async () => {
        testBtn.disabled = true;
        res.hidden = false; res.replaceChildren(el('div', { class: 'sys-step is-info', html: svg('refresh') + _t('<span>連線中…</span>') }));
        try { showSteps(res, await api('/api/system/ldap/test', { method: 'POST', body: { ...values(), username: tUser.value.trim(), password: tPass.value, search: tSearch.value.trim() } })); }
        catch (e) { showSteps(res, { steps: [{ status: 'fail', text: e.message }] }); }
        testBtn.disabled = false;
      });
      saveBtn.addEventListener('click', async () => {
        try {
          L = await api('/api/system/ldap', { method: 'PUT', body: values() });
          f.bind_password.value = ''; clearPw = false;
          f.bind_password.placeholder = L.bind_password_set ? _t('••••••••（已設定；留空 = 不變）') : _t('服務帳號密碼');
          toast(L.enabled ? _t('AD 設定已儲存並啟用') : _t('AD 設定已儲存（未啟用）'));
        } catch (e) { toast(e.message, true); }
      });
      grid.append(sysCard('users', _t('AD 登入（LDAP）'),
        _t('使用者用 Windows / AD 帳號密碼登入；第一次登入自動建立為「使用者」。服務帳號密碼加密保存，不會再顯示。<br>建議使用 <b>ldaps://</b>（636）；用 <b>ldap://</b>（389）時請開 StartTLS，否則密碼以明文傳送。'),
        f.enabled,
        el('div', { class: 'sys-form' },
          field(_t('伺服器'), f.url, _t('可填多台中的一台；IP 或主機名稱皆可')),
          field(_t('Base DN（搜尋起點）'), f.base_dn),
          field(_t('服務帳號 DN（建議）'), f.bind_dn, _t('唯讀帳號即可。有它才能在看板 @ 還沒登入過的同事、在「帳號管理」預先加入帳號')),
          el('div', { class: 'field' }, el('span', { class: 'field-label', text: _t('服務帳號密碼') }), f.bind_password, clearBtn),
          field(_t('網域（UPN 後綴）'), f.domain, _t('登入頁會在帳號後面自動帶入「@網域」，例如 ad.corp.local；不用服務帳號時也用它登入 AD。本機帳號不會加上後綴')),
          field(_t('只允許這些帳號登入（選填）'), f.user_filter, _t('LDAP 篩選，例如某個群組的成員')),
          el('details', { class: 'sys-advanced' }, el('summary', { text: _t('進階：屬性名稱、TLS、逾時') }),
            el('div', { class: 'sys-form' },
              field(_t('帳號屬性'), f.login_attr), field(_t('姓名屬性'), f.name_attr), field(_t('部門屬性（公開看板分組）'), f.dept_attr), field(_t('信箱屬性'), f.mail_attr),
              field(_t('上級屬性'), f.manager_attr), el('div', { class: 'field span-all' }, f.sync_manager),
              el('div', { class: 'field span-all' }, f.starttls, f.tls_verify),
              el('div', { class: 'span-all' }, field(_t('內部 CA 憑證（PEM）'), f.ca_pem, L.ca_subjects?.length ? _t('目前信任：') + L.ca_subjects.join('；') : _t('網域控制站的憑證由內部 CA 簽發時才需要'))),
              field(_t('逾時（秒）'), f.timeout)))),
        el('div', { class: 'sys-test' }, el('span', { class: 'field-label', text: _t('測試（用目前表單的內容，不必先儲存）') }), el('div', { class: 'sys-test-row' }, tUser, tPass, tSearch, testBtn)),
        res,
        el('div', { class: 'sys-actions' }, saveBtn)));

      // ---------------- Microsoft Entra ID
      let E;
      try { E = await api('/api/system/entra'); } catch (e) { E = null; }
      if (E) {
        const ef = {
          enabled: switchCtl(E.enabled, _t('啟用 Microsoft 帳號登入'), () => {}),
          tenant_id: input(E.tenant_id, { placeholder: '00000000-0000-0000-0000-000000000000' }),
          client_id: input(E.client_id, { placeholder: '00000000-0000-0000-0000-000000000000' }),
          client_secret: input('', { type: 'password', autocomplete: 'new-password', placeholder: E.client_secret_set ? _t('••••••••（已設定；留空 = 不變）') : _t('用戶端密碼的「值」') }),
          redirect_uri: input(E.redirect_uri, { placeholder: E.default_redirect_uri }),
          allowed_groups: el('textarea', { class: 'textarea mono', rows: '2', placeholder: _t('群組物件 ID，一行一個（留空 = 租用戶內的人都能登入）') }),
          sync_profile: switchCtl(E.sync_profile !== false, _t('登入時從 Entra 更新姓名、部門、信箱與上級（只讀取，不會寫回）'), () => {}),
          directory: switchCtl(!!E.directory, _t('看板 @ 與指派可以搜尋 Entra 目錄（需要應用程式權限 User.Read.All）'), () => {}),
          button_label: input(E.button_label, { placeholder: _t('以 Microsoft 帳號登入'), maxlength: '40' }),
        };
        ef.allowed_groups.value = E.allowed_groups || '';
        const chk = x => x.querySelector('input').checked;
        const evals = () => ({
          enabled: chk(ef.enabled), tenant_id: ef.tenant_id.value.trim(), client_id: ef.client_id.value.trim(),
          client_secret: ef.client_secret.value ? ef.client_secret.value : null, redirect_uri: ef.redirect_uri.value.trim(),
          allowed_groups: ef.allowed_groups.value.trim(), sync_profile: chk(ef.sync_profile), directory: chk(ef.directory), button_label: ef.button_label.value.trim(),
        });
        const eres = resultBox();
        const etest = el('button', { class: 'btn', type: 'button', html: svg('zap') + _t('測試') });
        const esave = el('button', { class: 'btn btn-primary', type: 'button', html: svg('check') + _t('儲存 Microsoft 登入設定') });
        etest.addEventListener('click', async () => {
          etest.disabled = true;
          eres.hidden = false; eres.replaceChildren(el('div', { class: 'sys-step is-info', html: svg('refresh') + _t('<span>連線中…</span>') }));
          try { showSteps(eres, await api('/api/system/entra/test', { method: 'POST', body: evals() })); }
          catch (e) { showSteps(eres, { steps: [{ status: 'fail', text: e.message }] }); }
          etest.disabled = false;
        });
        esave.addEventListener('click', async () => {
          try {
            E = await api('/api/system/entra', { method: 'PUT', body: evals() });
            ef.client_secret.value = '';
            ef.client_secret.placeholder = E.client_secret_set ? _t('••••••••（已設定；留空 = 不變）') : _t('用戶端密碼的「值」');
            toast(E.enabled ? _t('Microsoft 登入已儲存並啟用') : _t('Microsoft 登入設定已儲存（未啟用）'));
          } catch (e) { toast(e.message, true); }
        });
        const copyUri = el('button', { class: 'btn btn-sm btn-ghost', type: 'button', html: svg('copy') + _t('複製') });
        copyUri.addEventListener('click', async () => {
          try { await navigator.clipboard.writeText(ef.redirect_uri.value.trim() || E.default_redirect_uri); toast(_t('已複製')); } catch { ef.redirect_uri.select(); }
        });
        grid.append(sysCard('globe', _t('Microsoft Entra ID 登入'),
          _t('使用者按登入頁的「以 Microsoft 帳號登入」，用公司的 Microsoft 帳號（含多重要素驗證）登入；和 AD 登入可以同時使用。混合式環境中，內部部署帳號名稱相同的人會登入成同一個帳號。只讀取 Entra 的資料，不會寫回。') +
          '<br>' + _t('在 Entra 系統管理中心 →「應用程式註冊」新增應用程式：重新導向 URI 選「Web」並填下方的網址，建立一組用戶端密碼，API 權限保留 Microsoft Graph 的 User.Read（委派）。'),
          ef.enabled,
          el('div', { class: 'sys-form' },
            field(_t('租用戶（Tenant）ID'), ef.tenant_id, _t('目錄（租用戶）識別碼，或網域，例如 contoso.onmicrosoft.com')),
            field(_t('應用程式（Client）ID'), ef.client_id),
            field(_t('用戶端密碼（Client secret）'), ef.client_secret, _t('加密保存，不會再顯示；密碼到期前記得換新')),
            el('div', { class: 'field span-all' }, el('span', { class: 'field-label', text: _t('重新導向 URI') }), el('div', { class: 'sys-test-row' }, ef.redirect_uri, copyUri),
              el('span', { class: 'hint', text: _t('留空 = 使用這個網站的網址；在應用程式註冊填一模一樣的值') })),
            el('div', { class: 'span-all' }, field(_t('只允許這些群組登入（選填）'), ef.allowed_groups, _t('需要在應用程式註冊的「權杖設定」加上 groups 宣告，或授與 GroupMember.Read.All'))),
            el('div', { class: 'field span-all' }, ef.sync_profile, ef.directory),
            field(_t('登入按鈕文字（選填）'), ef.button_label)),
          el('div', { class: 'sys-test' }, el('span', { class: 'field-label', text: _t('測試（用目前表單的內容，不必先儲存）') }), el('div', { class: 'sys-test-row' }, etest)),
          eres,
          el('div', { class: 'sys-actions' }, esave)));
      }

      // ---------------- sign-in security
      const S = await api('/api/system/security');
      const sf = {
        session_hours: input(S.session_hours, { type: 'number', min: '0.25', step: '0.25' }),
        session_max_days: input(S.session_max_days, { type: 'number', min: '0.1', step: '0.5' }),
        lock_attempts: input(S.lock_attempts, { type: 'number', min: '3' }),
        lock_minutes: input(S.lock_minutes, { type: 'number', min: '1' }),
        ip_attempts: input(S.ip_attempts, { type: 'number', min: '5' }),
      };
      const secSave = el('button', { class: 'btn btn-primary', type: 'button', html: svg('check') + _t('儲存') });
      secSave.addEventListener('click', async () => {
        try { await api('/api/system/security', { method: 'PUT', body: Object.fromEntries(Object.entries(sf).map(([k, i]) => [k, Number(i.value)])) }); toast(_t('已儲存')); }
        catch (e) { toast(e.message, true); }
      });
      grid.append(sysCard('lock', _t('登入安全'), _t('工作階段與密碼錯誤鎖定。本機管理員的密碼請從右上角帳號選單修改。'),
        el('div', { class: 'sys-form' },
          field(_t('閒置多久自動登出（小時）'), sf.session_hours), field(_t('最長登入天數'), sf.session_max_days),
          field(_t('同一帳號連續錯幾次就鎖定'), sf.lock_attempts), field(_t('鎖定 / 計算時間（分鐘）'), sf.lock_minutes),
          field(_t('同一來源 IP 最多錯幾次'), sf.ip_attempts)),
        el('div', { class: 'sys-actions' }, secSave)));
    }

    if (part !== 'tls') return;
    // ---------------- HTTPS certificate
    let T;
    try { T = await api('/api/system/tls'); } catch { T = { helper: false }; }
    if (!T.helper) {
      grid.append(sysCard('globe', _t('HTTPS 憑證與連線埠'), _t('這個環境沒有由安裝腳本設定的 nginx（Windows 單機版或開發模式），這一區不適用。')));
    } else {
      const c = T.cert;
      const info = c ? el('div', { class: 'cert-info' },
        el('div', {}, el('strong', { text: c.self_signed ? _t('自簽憑證') : _t('正式憑證') }), el('span', { class: 'badge' + (c.days_left < 30 ? ' badge-alert' : ''), text: _t("剩 {0} 天", c.days_left) })),
        el('small', { text: _t("主旨：{0}", c.subject) }),
        c.self_signed ? null : el('small', { text: _t("簽發者：{0}", c.issuer) }),
        el('small', { text: _t("名稱：{0}", c.names.join('、') || '—') }),
        el('small', { text: _t("到期：{0}", c.not_after.slice(0, 10)) })) : el('p', { class: 'hint', text: _t('讀不到目前的憑證') });
      const crt = el('textarea', { class: 'textarea mono', rows: '4', placeholder: _t('-----BEGIN CERTIFICATE-----（伺服器憑證在前，接著中繼憑證：fullchain）') });
      const key = el('textarea', { class: 'textarea mono', rows: '4', placeholder: _t('-----BEGIN PRIVATE KEY-----（不能有密碼保護）') });
      const fileBtn = (target, label) => {
        const fi = el('input', { type: 'file', accept: '.pem,.crt,.cer,.key,.txt', hidden: true });
        fi.addEventListener('change', async () => { if (fi.files[0]) target.value = await fi.files[0].text(); fi.value = ''; });
        const b = el('button', { class: 'btn btn-sm btn-ghost', type: 'button', html: svg('upload') + label });
        b.addEventListener('click', () => fi.click());
        return [b, fi];
      };
      const res = resultBox();
      const up = el('button', { class: 'btn btn-primary', type: 'button', html: svg('upload') + _t('套用新憑證') });
      const self = el('button', { class: 'btn', type: 'button', html: svg('refresh') + _t('重新產生自簽憑證') });
      const reload = () => setTimeout(() => route(), 1200);
      up.addEventListener('click', async () => {
        try { const r = await api('/api/system/tls', { method: 'POST', body: { cert_pem: crt.value, key_pem: key.value } }); crt.value = key.value = ''; waitApply(r.id, res, x => x.ok && reload()); }
        catch (e) { toast(e.message, true); }
      });
      self.addEventListener('click', async () => {
        if (!(await confirmDialog(_t('重新產生自簽憑證？'), _t('會換掉目前使用中的憑證（舊的會留一份在 previous/）。'), _t('產生'), false))) return;
        try { const r = await api('/api/system/tls', { method: 'POST', body: { selfsigned: true } }); waitApply(r.id, res, x => x.ok && reload()); }
        catch (e) { toast(e.message, true); }
      });
      grid.append(sysCard('lock', _t('HTTPS 憑證'), _t('貼上或選擇正式憑證（PEM），會先檢查憑證與私鑰是否成對、是否過期；nginx 不接受時自動換回原本的。'),
        info,
        el('div', { class: 'sys-form' },
          el('div', { class: 'field span-all' }, el('span', { class: 'field-label', text: _t('憑證（fullchain）') }), crt, el('div', {}, ...fileBtn(crt, _t('從檔案讀取')))),
          el('div', { class: 'field span-all' }, el('span', { class: 'field-label', text: _t('私鑰') }), key, el('div', {}, ...fileBtn(key, _t('從檔案讀取'))))),
        res,
        el('div', { class: 'sys-actions' }, self, el('span', { class: 'spacer' }), up)));

      // ---------------- ports / name
      const N = await api('/api/system/network');
      const nf = { https: input(N.https_port, { type: 'number', min: '1', max: '65535' }), http: input(N.http_port, { type: 'number', min: '0', max: '65535' }), fqdn: input(N.fqdn, { placeholder: _t('portal.corp.local（留空 = 任何名稱）') }) };
      const nres = resultBox();
      const nsave = el('button', { class: 'btn btn-primary', type: 'button', html: svg('check') + _t('套用') });
      nsave.addEventListener('click', async () => {
        const https = Number(nf.https.value), http = Number(nf.http.value), fqdn = nf.fqdn.value.trim();
        if (!(await confirmDialog(_t('變更連線埠與名稱？'), _t("套用後網址會變成 https://{0}:{1}/。若埠號被占用或 nginx 不接受，會自動還原。", fqdn || location.hostname, https), _t('套用'), false))) return;
        try {
          const r = await api('/api/system/network', { method: 'PUT', body: { https_port: https, http_port: http, fqdn } });
          const host = fqdn || location.hostname;
          waitApply(r.id, nres, x => {
            if (x.ok && (String(https) !== location.port || (fqdn && fqdn !== location.hostname))) {
              nres.append(el('a', { class: 'btn btn-sm', href: `https://${host}:${https}/admin#tls`, html: svg('external') + _t("前往新網址 https://{0}:{1}/", host, https) }));
            }
          });
        } catch (e) { toast(e.message, true); }
      });
      grid.append(sysCard('globe', _t('連線埠與名稱'), _t("HTTP 一律轉到 HTTPS。服務本身只聽 127.0.0.1:{0}，不對外開放。", N.app_port),
        el('div', { class: 'sys-form' }, field(_t('HTTPS 埠'), nf.https), field(_t('HTTP 埠（0 = 不開，只用 HTTPS）'), nf.http), field(_t('伺服器名稱（FQDN）'), nf.fqdn, _t('用於 nginx server_name；重新產生自簽憑證時也會用它'))),
        nres,
        el('div', { class: 'sys-actions' }, nsave)));
    }

  }

  function switchInput(checked, onChange) {
    const input = el('input', { type: 'checkbox', checked });
    input.addEventListener('change', () => onChange(input.checked));
    return el('label', { class: 'switch' }, input, el('span', { class: 'track' }));
  }

  // ======================================================================
  // 系統狀態 · 稽核紀錄 · 系統資訊 · 版本紀錄 (same tabs as CFXD_DailyReportDocSys)
  // ======================================================================
  const LV = () => ({ ok: _t('正常'), warn: _t('注意'), fail: _t('失敗') });
  const lvBadge = lv => el('span', { class: `tm-lv lv-${lv}`, text: LV()[lv] || lv });
  const countBadges = c => ['ok', 'warn', 'fail'].filter(k => c[k] || k === 'ok').map(k => el('span', { class: `tm-lv lv-${k}`, text: `${LV()[k]} ${c[k] || 0}` }));
  const cardHead = (title, ...right) => el('div', { class: 'adm-card-head' }, el('h3', { class: 'settings-card-title', text: title }), el('span', { class: 'spacer' }), ...right);
  const kvTable = rows => el('table', { class: 'adm-table kv' }, el('tbody', {}, ...rows.map(r =>
    el('tr', {}, el('th', { text: r[0] }), el('td', {}, el('span', { text: r[1] }), r[2] ? el('small', { class: 'hint adm-sub', text: r[2] }) : null)))));

  /** Health banner on every admin page (like the report system): the last check's failures, link to 系統狀態 */
  async function healthBanner() {
    try {
      const r = await api('/api/system/status');
      state.health = { at: r.at, bad: r.items.filter(x => x.level === 'fail') };
    } catch { state.health = null; }
    paintHealthBar();
  }
  function paintHealthBar() {
    document.querySelector('.health-bar')?.remove();
    const h = state.health;
    if (!h || !h.bad.length) return;
    $('stage').prepend(el('a', { class: 'notice-bar health-bar', href: '#status',
      html: svg('zap') + `<span>${esc(_t('健康檢查有 {0} 個失敗項目（{1}）：{2}。', h.bad.length, h.at, h.bad.map(x => x.name).join('、')))}</span><u>${esc(_t('查看與修正方式'))}</u>` }));
  }

  async function renderStatus() {
    const body = $('stage-body');
    const checkBtn = el('button', { class: 'btn btn-primary', type: 'button', html: svg('refresh') + _t('立即檢查') });
    $('stage-actions').append(checkBtn);
    const healthCard = el('section', { class: 'panel settings-card' }, el('p', { class: 'hint', text: _t('讀取中…') }));
    const jobsCard = el('section', { class: 'panel settings-card' });
    const installCard = el('section', { class: 'panel settings-card' });
    body.append(healthCard, el('div', { class: 'sys-grid' }, jobsCard, installCard));
    const paint = r => {
      const groups = [];
      r.items.forEach(it => { let g = groups.find(x => x.name === it.group); if (!g) groups.push(g = { name: it.group, items: [] }); g.items.push(it); });
      healthCard.replaceChildren(
        cardHead(_t('健康檢查'), el('span', { class: 'hint', text: `${r.at}（${r.manual ? _t('手動') : _t('自動')}）` }), ...countBadges(r.counts || {})),
        el('table', { class: 'adm-table health' }, el('tbody', {}, ...groups.flatMap(g => [
          el('tr', { class: 'grp' }, el('td', { colspan: '3', text: g.name })),
          ...g.items.map(it => el('tr', { class: `lv-row-${it.level}` }, el('td', { class: 'lv' }, lvBadge(it.level)), el('td', { class: 'nm', text: it.name }),
            el('td', {}, el('span', { text: it.detail }), it.hint ? el('small', { class: 'adm-hint', text: '→ ' + it.hint }) : null)))]))),
        el('p', { class: 'hint', text: _t('每小時自動檢查一次；有失敗項目時後台每一頁上方都會提醒。硬體與服務告警另外依「發送與通知」的設定送到 Teams。') }));
      jobsCard.replaceChildren(el('h3', { class: 'settings-card-title', html: svg('history') + _t('最近的維護工作') }),
        (r.jobs || []).length ? el('table', { class: 'adm-table' }, el('tbody', {}, ...r.jobs.map(j => el('tr', {},
          el('td', { class: 'nowrap', text: j.at }), el('td', {}, lvBadge(j.ok === false ? 'fail' : 'ok')), el('td', { class: 'nowrap', text: j.what }), el('td', { class: 'mono-sm', text: j.detail || '' })))))
          : el('p', { class: 'hint', text: _t('還沒有維護紀錄') }),
        el('p', { class: 'hint', text: _t('備份、憑證／連線埠套用與升級的結果；詳細內容在「備份還原」「HTTPS 憑證」「版本紀錄」。') }));
      installCard.replaceChildren(el('h3', { class: 'settings-card-title', html: svg('lock') + _t('安裝時決定的項目（唯讀）') }),
        kvTable(r.install || []),
        el('p', { class: 'hint', text: _t('這些在安裝時決定，畫面上不能改；連線埠與名稱可在「HTTPS 憑證」變更。') }));
    };
    const load = async () => { try { paint(await api('/api/system/status')); } catch (e) { healthCard.replaceChildren(el('p', { class: 'hint', text: e.message })); } };
    checkBtn.addEventListener('click', async () => {
      checkBtn.disabled = true; checkBtn.innerHTML = svg('refresh') + _t('檢查中…');
      try { await api('/api/system/status/check', { method: 'POST' }); await load(); const r = await api('/api/system/status'); toast(_t('健康檢查完成：正常 {0}、注意 {1}、失敗 {2}。', r.counts.ok, r.counts.warn, r.counts.fail), r.counts.fail > 0); healthBanner(); }
      catch (e) { toast(e.message, true); }
      checkBtn.disabled = false; checkBtn.innerHTML = svg('refresh') + _t('立即檢查');
    });
    await load();
  }

  async function renderAudit() {
    const body = $('stage-body');
    const today = new Date(), iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const ago = n => { const d = new Date(today); d.setDate(d.getDate() - n); return iso(d); };
    const f = { date_from: ago(6), date_to: iso(today), action: '', actor: '', target: '', q: '', failed: false, page: 1 };
    const keepIn = input('', { type: 'number', style: 'width:7em' });
    const keepBtn = el('button', { class: 'btn', type: 'button', text: _t('儲存') });
    const keepHint = el('span', { class: 'hint' });
    const keepCard = el('section', { class: 'panel settings-card' }, el('h3', { class: 'settings-card-title', text: _t('保存期限') }),
      el('div', { class: 'adm-inline' }, el('span', { text: _t('稽核紀錄保存') }), keepIn, el('span', { text: _t('天') }), keepBtn), keepHint);
    const from = input(f.date_from, { type: 'date' }), to = input(f.date_to, { type: 'date' });
    const actSel = el('select', { class: 'select' }), whoSel = el('select', { class: 'select' });
    const tgt = input('', { placeholder: _t('帳號、備份名稱、卡片編號…') }), q = input('', { placeholder: _t('關鍵字') });
    const failed = switchCtl(false, _t('只看失敗'), () => {});
    const go = el('button', { class: 'btn btn-primary', type: 'button', html: svg('search') + _t('查詢') });
    const csv = el('a', { class: 'btn', html: svg('download') + _t('匯出 CSV') });
    const clear = el('button', { class: 'btn btn-ghost', type: 'button', text: _t('清除條件') });
    const quick = el('span', { class: 'hint adm-quick' });
    const QUICK = [[_t('今天'), 0, 0], [_t('昨天'), 1, 1], [_t('近 7 天'), 6, 0], [_t('近 30 天'), 29, 0], [_t('本月'), today.getDate() - 1, 0]];
    quick.append(_t('快速區間：'), ...QUICK.flatMap(([l, a, b], i) => { const x = el('a', { href: '#audit', text: l }); x.addEventListener('click', e => { e.preventDefault(); from.value = ago(a); to.value = ago(b); f.page = 1; run(); }); return i ? [' · ', x] : [x]; }));
    const queryCard = el('section', { class: 'panel settings-card' }, el('h3', { class: 'settings-card-title', text: _t('稽核紀錄查詢') }),
      el('p', { class: 'hint', text: _t('以天為單位查詢（起訖日期都包含，最多 366 天），可再依動作、操作者、對象、內容篩選。稽核紀錄不會隨卡片或帳號刪除，也不能在畫面上修改或刪除；匯出 CSV 本身也會記錄一筆。') }),
      el('div', { class: 'sys-form adm-filter' }, field(_t('起日'), from), field(_t('迄日'), to), field(_t('動作'), actSel), field(_t('操作者'), whoSel),
        field(_t('對象（包含）'), tgt), field(_t('內容（包含）'), q)),
      el('div', { class: 'sys-actions adm-actions-left' }, go, csv, clear, failed, quick));
    const resCard = el('section', { class: 'panel settings-card' });
    body.append(keepCard, queryCard, resCard);
    const params = () => {
      Object.assign(f, { date_from: from.value, date_to: to.value, action: actSel.value, actor: whoSel.value, target: tgt.value.trim(), q: q.value.trim(), failed: failed.querySelector('input').checked });
      const p = new URLSearchParams(); Object.entries(f).forEach(([k, v]) => { if (v !== '' && v !== false) p.set(k, v); });
      return p;
    };
    let filled = false;
    async function run() {
      const p = params();
      csv.href = '/api/system/audit.csv?' + p.toString();
      let r;
      try { r = await api('/api/system/audit?' + p.toString()); } catch (e) { resCard.replaceChildren(el('p', { class: 'hint', text: e.message })); return; }
      if (!filled) {
        filled = true;
        actSel.replaceChildren(el('option', { value: '', text: _t('（全部）') }), ...r.actions.map(a => el('option', { value: a.code, text: a.label })));
        whoSel.replaceChildren(el('option', { value: '', text: _t('（全部）') }), ...r.actors.map(a => el('option', { value: a.id, text: a.name })), el('option', { value: '-', text: _t('未登入／系統') }));
        keepIn.value = r.keep; keepIn.min = r.keep_min; keepIn.max = r.keep_max;
      }
      from.value = r.filters.date_from; to.value = r.filters.date_to;
      keepHint.textContent = _t('至少 {0} 天、最多 {1} 天。每天清除超過期限的紀錄（清除本身也會記一筆），目前最早一筆是 {2}。需要更久請定期「匯出 CSV」或靠備份保存；還原備份不會刪掉比備份新的稽核紀錄。', r.keep_min, r.keep_max, r.earliest || '—');
      let day = null;
      const W = [_t('日'), _t('一'), _t('二'), _t('三'), _t('四'), _t('五'), _t('六')];
      const rows = [];
      r.rows.forEach(x => {
        const d = x.at.slice(0, 10);
        if (d !== day) { day = d; rows.push(el('tr', { class: 'grp' }, el('td', { colspan: '6', text: `${d}（${W[new Date(d + 'T00:00').getDay()]}）` }))); }
        rows.push(el('tr', { class: x.ok ? '' : 'lv-row-fail' }, el('td', { class: 'nowrap', text: x.at.slice(11, 19) }), el('td', { class: 'nowrap', text: x.label }),
          el('td', { text: x.actor || '—' }), el('td', { text: x.target || '' }), el('td', { text: x.detail || '' }), el('td', { class: 'mono-sm', text: x.ip || '' })));
      });
      const pager = r.pages > 1 ? el('div', { class: 'sys-actions adm-actions-left' },
        r.page > 1 ? (() => { const b = el('button', { class: 'btn btn-sm', type: 'button', text: _t('← 較新') }); b.addEventListener('click', () => { f.page = r.page - 1; run(); }); return b; })() : null,
        el('span', { class: 'hint', text: _t('第 {0} / {1} 頁', r.page, r.pages) }),
        r.page < r.pages ? (() => { const b = el('button', { class: 'btn btn-sm', type: 'button', text: _t('較舊 →') }); b.addEventListener('click', () => { f.page = r.page + 1; run(); }); return b; })() : null) : null;
      resCard.replaceChildren(...[
        cardHead(r.filters.date_from === r.filters.date_to ? _t('{0}：共 {1} 筆', r.filters.date_from, r.total) : _t('{0} ～ {1}：共 {2} 筆', r.filters.date_from, r.filters.date_to, r.total)),
        r.per_day.length > 1 ? el('p', { class: 'hint adm-quick' }, _t('每天筆數：'), ...r.per_day.flatMap(([d, n], i) => {
          const a = el('a', { href: '#audit', text: `${d.slice(5)}（${n}）` }); a.addEventListener('click', e => { e.preventDefault(); from.value = to.value = d; f.page = 1; run(); });
          return i ? ['、', a] : [a]; })) : null,
        el('div', { class: 'adm-scroll' }, el('table', { class: 'adm-table audit' },
          el('thead', {}, el('tr', {}, ...[_t('時間'), _t('動作'), _t('操作者'), _t('對象'), _t('內容'), _t('來源 IP')].map(h => el('th', { text: h })))),
          el('tbody', {}, ...(rows.length ? rows : [el('tr', {}, el('td', { colspan: '6', class: 'hint', text: _t('這個條件沒有稽核紀錄。') }))])))),
        pager].filter(Boolean));
    }
    go.addEventListener('click', () => { f.page = 1; run(); });
    [tgt, q].forEach(x => x.addEventListener('keydown', e => { if (e.key === 'Enter') { f.page = 1; run(); } }));
    clear.addEventListener('click', () => { from.value = ago(6); to.value = iso(today); actSel.value = whoSel.value = ''; tgt.value = q.value = ''; failed.querySelector('input').checked = false; f.page = 1; run(); });
    keepBtn.addEventListener('click', async () => {
      try { const r = await api('/api/system/audit/retention', { method: 'PUT', body: { days: Number(keepIn.value) } }); toast(_t('稽核紀錄保存天數已改為 {0} 天。', r.keep)); run(); }
      catch (e) { toast(e.message, true); }
    });
    await run();
  }

  async function renderSysinfo() {
    const body = $('stage-body');
    const dl = el('a', { class: 'btn', href: '/api/system/sysinfo.json', html: svg('download') + _t('下載 JSON') });
    const again = el('button', { class: 'btn btn-ghost', type: 'button', html: svg('refresh') + _t('重新讀取') });
    again.addEventListener('click', () => route());
    $('stage-actions').append(again, dl);
    body.append(el('p', { class: 'hint', text: _t('讀取中…') }));
    let I;
    try { I = await api('/api/system/sysinfo'); } catch (e) { body.replaceChildren(el('p', { class: 'hint', text: e.message })); return; }
    const sec = (icon, title, ...content) => el('section', { class: 'panel settings-card' }, el('h3', { class: 'settings-card-title', html: svg(icon) + esc(title) }), ...content);
    const table = (heads, rows) => el('div', { class: 'adm-scroll' }, el('table', { class: 'adm-table' },
      el('thead', {}, el('tr', {}, ...heads.map(h => el('th', { text: h })))), el('tbody', {}, ...rows)));
    const fs = (I.filesystems || []).filter(x => x.label);
    const pk = I.python_packages || [];
    const [direct, other] = [pk.filter(p => p.direct), pk.filter(p => !p.direct)];
    const pyRow = p => el('tr', { class: p.mismatch ? 'lv-row-warn' : '' }, el('td', { class: 'nowrap', text: p.name }), el('td', { class: 'nowrap', text: p.version }),
      el('td', { class: 'nowrap', text: p.required ? (p.mismatch ? _t('需要 {0}', p.required) : p.required) : '' }), el('td', { class: 'hint', text: p.summary || '' }));
    body.replaceChildren(...[
      el('p', { class: 'hint', text: _t('讀取時間 {0}（{1} 秒）。讀不到的項目顯示「無法取得」；下載 JSON 可附在問題回報或資產盤點（會記錄在稽核紀錄）。', I.generated, I.elapsed) }),
      el('div', { class: 'sys-grid' },
        sec('monitor', _t('硬體'), kvTable(I.hardware || [])),
        sec('settings', _t('作業系統'), kvTable(I.os || [])),
        sec('app', _t('執行環境與工具'), kvTable(I.runtime || []))),
      fs.length ? sec('database', _t('檔案系統'), table([_t('用途'), _t('路徑'), _t('掛載點'), _t('裝置'), _t('格式'), _t('容量'), _t('可用'), _t('已用')],
        fs.map(x => el('tr', { class: x.used_pct >= 90 ? 'lv-row-fail' : x.used_pct >= 80 ? 'lv-row-warn' : '' }, el('td', { class: 'nowrap', text: x.label }), el('td', { class: 'mono-sm', text: x.path }),
          el('td', { class: 'mono-sm', text: x.dup ? _t('（同上）') : x.mount }), el('td', { class: 'mono-sm', text: x.device }), el('td', { text: x.fstype }), el('td', { class: 'nowrap', text: x.total }),
          el('td', { class: 'nowrap', text: x.free }), el('td', { class: 'nowrap', text: `${x.used_pct}%` }))))) : null,
      sec('zap', _t('服務'), (I.services || []).length ? table([_t('服務'), _t('狀態'), _t('開機啟動'), 'PID', _t('啟動時間'), _t('記憶體'), _t('重新啟動次數')],
        I.services.map(s => el('tr', { class: s.ok === false && !String(s.state).includes('未安裝') ? 'lv-row-fail' : '' }, el('td', { class: 'mono-sm', text: s.unit }), el('td', { text: s.state }), el('td', { text: s.enabled || '' }),
          el('td', { text: s.pid || '' }), el('td', { class: 'nowrap', text: s.since || '' }), el('td', { class: 'nowrap', text: s.memory || '' }), el('td', { text: s.restarts || '' }))))
        : el('p', { class: 'hint', text: _t('不是以 systemd 執行（Windows 單機版、容器或開發模式），沒有服務資訊。') })),
      I.system_packages ? sec('grid', _t('系統套件（安裝腳本使用的；主機共 {0} 個套件，完整清單在下載的 JSON）', I.system_packages_total),
        table([_t('套件'), _t('版本'), _t('說明')], I.system_packages.map(p => el('tr', { class: p.installed ? '' : 'lv-row-warn' },
          el('td', { class: 'mono-sm', text: p.name }), el('td', { class: 'mono-sm', text: p.version }), el('td', { class: 'hint', text: p.summary }))))) : null,
      sec('list', _t('Python 套件（{0}，其中直接相依 {1}）', pk.length, direct.length),
        table([_t('套件'), _t('版本'), 'requirements.txt', _t('說明')], direct.map(pyRow)),
        other.length ? el('details', { class: 'sys-advanced' }, el('summary', { text: _t('其他 {0} 個（間接相依）', other.length) }), table([_t('套件'), _t('版本'), '', _t('說明')], other.map(pyRow))) : null)].filter(Boolean));
  }

  async function renderVersions() {
    const body = $('stage-body');
    body.append(el('p', { class: 'hint', text: _t('讀取中…') }));
    let V;
    try { V = await api('/api/system/versions'); } catch (e) { body.replaceChildren(el('p', { class: 'hint', text: e.message })); return; }
    const TY = { X: _t('核心架構'), Y: _t('功能'), Z: _t('修正'), '—': _t('初版') };
    const vtype = t => el('span', { class: `vtype vtype-${['X', 'Y', 'Z'].includes(t) ? t : 'init'}`, text: `${t} ${TY[t] || ''}` });
    const cur = `v${V.current.version}`;
    const head = el('section', { class: 'panel settings-card' },
      el('h3', { class: 'settings-card-title' }, _t('目前版本：{0}', cur), V.current.commit ? el('span', { class: 'hint' }, ' commit ', el('code', { text: V.current.commit })) : null),
      el('p', { class: 'hint', text: _t('版號 vX.Y.Z，從 11 月第一個 commit（v1.0.0）起，每個 commit 依類型進一版（只改文件、網站或 CI 的不計）：') }),
      el('ul', { class: 'hint adm-ul' },
        el('li', {}, el('b', { text: _t('X 核心架構與大型功能') }), _t('：核心架構與大型功能的變動、新增、刪除，Y、Z 歸零。共 {0} 次。', V.counts.X)),
        el('li', {}, el('b', { text: _t('Y 功能') }), _t('：現有功能的變動、新增、刪除，Z 歸零。共 {0} 次。', V.counts.Y)),
        el('li', {}, el('b', { text: _t('Z 修正') }), _t('：現有功能的錯誤、漏洞、故障修正。共 {0} 次。', V.counts.Z))));
    const up = el('section', { class: 'panel settings-card upgrade-card' });
    const upBtn = el('button', { class: 'btn btn-primary', type: 'button', html: svg('download') + _t('升級到最新版') });
    const msg = el('p', { class: 'up-msg' });
    const logBox = el('pre', { class: 'upgrade-log' });
    const logWrap = el('details', { class: 'sys-advanced' }, el('summary', { text: _t('升級記錄') }), logBox);
    const progress = el('div', { class: 'upgrade-progress' }, msg, logWrap);
    const paintStatus = st => {
      const s = st || {};
      progress.hidden = !(s.pending || s.state);
      msg.textContent = s.pending ? _t('已送出升級要求，等待主機開始…') : s.state === 'running' ? _t('升級中（{0} 開始）…', s.at)
        : s.state === 'done' ? _t('上次升級：{0} 完成，v{1} → v{2}', s.at, s.from, s.to) : s.state === 'error' ? _t('上次升級失敗（{0}），請看下方記錄', s.at) : '';
      logBox.textContent = s.log || '';
      logWrap.open = !!(s.pending || ['running', 'error'].includes(s.state));
      upBtn.disabled = !!(s.pending || s.state === 'running');
    };
    let polling = false;
    const poll = async () => {
      if (polling) return; polling = true;
      const was = V.current.version;
      for (let i = 0; i < 400 && currentPanel === 'versions'; i++) {
        await new Promise(r => setTimeout(r, 3000));
        let s;
        try { s = await api('/api/system/upgrade/status'); } catch { msg.textContent = _t('服務重新啟動中…'); continue; }
        paintStatus(s);
        if (!s.pending && s.state !== 'running') { if (s.running_version !== was || s.state === 'done') { toast(_t('升級完成，重新載入…')); setTimeout(() => location.reload(), 1500); } break; }
      }
      polling = false;
    };
    upBtn.addEventListener('click', async () => {
      if (!(await confirmDialog(_t('升級到 GitHub 上的最新版？'), _t('會先自動備份，再更新程式並重新啟動服務，約需 1–5 分鐘，期間網頁會短暫無法使用。請確認目前沒有人正在編輯。'), _t('升級'), false))) return;
      try { await api('/api/system/upgrade', { method: 'POST' }); toast(_t('已開始升級：會先備份，再更新程式並重新啟動服務；這一頁會自動更新。')); paintStatus({ pending: true, log: '' }); poll(); }
      catch (e) { toast(e.message, true); }
    });
    const upTop = el('div', { class: 'adm-card-head' }, el('h3', { class: 'settings-card-title', text: _t('升級') }), el('span', { class: 'spacer' }));
    up.append(upTop);
    if (!V.server) up.append(el('p', { class: 'hint', text: _t('單機版不在這裡升級：連線到伺服器後，會自動從伺服器下載與伺服器相同的版本。') }));
    else if (!V.remote) up.append(el('p', { class: 'hint', text: _t('無法連線到 GitHub 檢查新版（主機需要能連到 github.com）。') }));
    else if (V.up_to_date) up.append(el('p', {}, el('span', { class: 'tm-lv lv-ok', text: _t('已是最新版') }), ' ', el('span', { class: 'hint' }, 'GitHub main ', el('code', { text: V.remote }))));
    else {
      if (V.available) upTop.append(upBtn);
      up.append(el('p', {}, _t('GitHub 上有新版 '), el('code', { text: V.remote }), V.new && V.new.length ? _t('，共 {0} 個版本：', V.new.length) : '：'));
      if (V.new && V.new.length) up.append(el('ul', { class: 'upgrade-new' }, ...V.new.map(r => el('li', {}, el('b', { text: r.version }), ' ', vtype(r.type), ' ', el('span', { class: 'hint', text: r.date }), el('br'), r.text))));
      else if (V.new === null) up.append(el('p', { class: 'hint', text: _t('（無法讀取新版的版本紀錄）') }));
      if (!V.available) up.append(el('p', { class: 'notice-inline' }, _t('主機尚未安裝升級服務，這次請在主機執行：'), el('code', { class: 'wrap', text: V.cmd }), el('br'), _t('升級到這一版以後，之後都可以直接按這裡的按鈕升級。')));
    }
    up.append(progress,
      el('p', { class: 'hint', text: _t('按鈕與主機指令 tool-table.sh upgrade 做的事完全相同：升級前自動備份 → 更新程式（git pull）→ 安裝相依套件 → 重新啟動服務 → 健康檢查。只有系統管理員可以升級，每次升級都記錄在稽核紀錄。') }));
    paintStatus(V.status);
    if (V.status && (V.status.pending || V.status.state === 'running')) poll();
    const all = el('section', { class: 'panel settings-card' }, el('h3', { class: 'settings-card-title', text: _t('全部版本（{0}）', V.rows.length) }),
      el('div', { class: 'adm-scroll' }, el('table', { class: 'adm-table versions' },
        el('thead', {}, el('tr', {}, ...[_t('版本'), _t('日期'), 'commit', _t('類型'), _t('內容')].map(h => el('th', { text: h })))),
        el('tbody', {}, ...(V.rows.length ? V.rows.map(r => {
          const c = r.commit.startsWith('（') && r.version === cur && V.current.commit ? V.current.commit : r.commit;
          return el('tr', { class: (r.version === cur ? 'current ' : '') + (r.type === 'X' ? 'major' : '') },
            el('td', { class: 'nowrap' }, el('b', { text: r.version }), r.version === cur ? el('span', { class: 'tm-lv lv-ok', text: _t('目前') }) : null),
            el('td', { class: 'nowrap', text: r.date }),
            el('td', {}, c && !c.startsWith('（') ? el('a', { href: `https://github.com/${V.repo}/commit/${c}`, target: '_blank', rel: 'noopener' }, el('code', { text: c })) : c),
            el('td', { class: 'nowrap' }, vtype(r.type)), el('td', { text: r.text }));
        }) : [el('tr', {}, el('td', { colspan: '5', class: 'hint', text: _t('找不到 CHANGELOG.md。') }))])))));
    body.replaceChildren(head, up, all);
  }

  // ======================================================================
  // AI 接入點: cloud and on-premises AI services, fallback or in parallel (app/ai.py)
  // ======================================================================
  async function renderAI() {
    const body = $('stage-body');
    let D;
    try { D = await api('/api/ai'); } catch (e) { body.append(el('p', { class: 'hint', text: e.message })); return; }
    const LOC = { cloud: _t('雲端'), onprem: _t('地端') };
    const locBadge = l => el('span', { class: `ai-loc ai-loc-${l}`, text: LOC[l] || l });
    const S = D.settings;

    // ---------------- settings
    const sf = {
      enabled: switchCtl(S.enabled, _t('啟用 AI 接入點'), () => {}),
      allow_cloud: switchCtl(S.allow_cloud, _t('允許使用雲端服務（資料會送到公司外部）'), () => {}),
      timeout: input(S.timeout, { type: 'number', min: '5', max: '900' }),
      max_output_tokens: input(S.max_output_tokens, { type: 'number', min: '64', max: '128000' }),
      temperature: input(S.temperature, { type: 'number', min: '0', max: '2', step: '0.1' }),
      system_prompt: el('textarea', { class: 'textarea', rows: '4' }),
      images_to_cloud: switchCtl(S.images_to_cloud, _t('允許把截圖送到雲端服務（預設只送地端）'), () => {}),
      aipm_enabled: switchCtl(S.aipm_enabled, _t('啟用 AiPM（AI 專案經理）'), () => {}),
      aipm_patrol: input(S.aipm_patrol || '08:30', { type: 'time' }),
      aipm_daily: switchCtl(S.aipm_daily !== false, _t('每日對齊：巡檢時間私訊每個手上有進行中工作的人（只列他自己的項目）'), () => {}),
    };
    sf.system_prompt.value = S.system_prompt || '';
    let mode = S.mode;
    const modeSeg = segmented([['fallback', _t('備援：依優先順序，失敗換下一個'), 'refresh'], ['parallel', _t('並行：所有可用的服務同時回答'), 'grid']], mode, v => { mode = v; });
    const saveS = el('button', { class: 'btn btn-primary', type: 'button', html: svg('check') + _t('儲存設定') });
    saveS.addEventListener('click', async () => {
      try {
        await api('/api/ai/settings', { method: 'PUT', body: { enabled: sf.enabled.querySelector('input').checked, allow_cloud: sf.allow_cloud.querySelector('input').checked, mode,
          timeout: Number(sf.timeout.value), max_output_tokens: Number(sf.max_output_tokens.value), temperature: Number(sf.temperature.value), system_prompt: sf.system_prompt.value,
          images_to_cloud: sf.images_to_cloud.querySelector('input').checked, aipm_enabled: sf.aipm_enabled.querySelector('input').checked,
          aipm_patrol: sf.aipm_patrol.value || '08:30', aipm_daily: sf.aipm_daily.querySelector('input').checked } });
        toast(_t('已儲存')); route();
      } catch (e) { toast(e.message, true); }
    });
    const setCard = sysCard('sparkles', _t('AI 接入點設定'),
      _t('可以同時接入多個雲端與地端的 AI 服務、多種模型。<b>地端</b>（Ollama、vLLM、LM Studio、llama.cpp、LocalAI、公司 AI 閘道）的資料不離開公司；<b>雲端</b>（Claude、OpenAI、Gemini、Azure OpenAI、AWS Bedrock…）要打開下面的「允許使用雲端服務」才會使用。金鑰加密保存，不會再顯示；每次呼叫都記錄用量與費用。'),
      sf.enabled, sf.allow_cloud,
      el('div', { class: 'field' }, el('span', { class: 'field-label', text: _t('呼叫方式') }), modeSeg,
        el('span', { class: 'hint', text: _t('備援：先用優先順序最前面的可用服務，失敗、超過預算或額度時自動換下一個。並行：同時問所有可用的服務，每個模型的回答都會回傳，可以比較或彙整。') })),
      el('div', { class: 'sys-form' }, field(_t('逾時（秒）'), sf.timeout), field(_t('每次最多輸出（token）'), sf.max_output_tokens),
        field(_t('溫度（只送給勾選「傳送溫度」的服務）'), sf.temperature)),
      field(_t('系統提示詞（預設）'), sf.system_prompt, _t('功能沒有指定時使用；用來約束語氣、語言與「只根據提供的內容回答」')),
      sf.images_to_cloud,
      el('h4', { class: 'sys-sub', text: 'AiPM' }),
      el('p', { class: 'hint', text: _t('AiPM 會讀整個專案、預估風險、追問、建議補充的工作與截圖紀錄；專案有變動時（每 10 分鐘檢查，同一專案最多每 30 分鐘一次）與每天的巡檢時間會主動檢視。硬性規則：AiPM 不會自己改任何東西，每一項變更都要專案負責人或看板管理人（看板總管理者 RW、該部門的部門看板管理者 RW）核准，已完成或取消的項目不會被變更；通知只送給相關、而且本來就看得到該卡片的帳號。') }),
      sf.aipm_enabled, sf.aipm_daily,
      el('div', { class: 'sys-form' }, field(_t('每日巡檢時間'), sf.aipm_patrol, _t('進行中的專案每天檢視一次，結果通知專案負責人'))),
      el('div', { class: 'sys-actions' }, saveS));

    // ---------------- services
    const presetSel = el('select', { class: 'select' }, ...Object.entries(D.groups).map(([g, gl]) =>
      el('optgroup', { label: gl }, ...Object.entries(D.presets).filter(([, p]) => p.group === g).map(([k, p]) => el('option', { value: k, text: p.label })))));
    const addBtn = el('button', { class: 'btn btn-primary', type: 'button', html: svg('plus') + _t('新增服務') });
    addBtn.addEventListener('click', () => editProvider(null, presetSel.value));
    const rows = D.providers.map(p => {
      const res = el('div', { class: 'ai-test-res', hidden: true });
      const test = el('button', { class: 'btn btn-sm', type: 'button', html: svg('zap') + _t('測試') });
      test.addEventListener('click', async () => {
        test.disabled = true; res.hidden = false; res.className = 'ai-test-res'; res.textContent = _t('測試中…');
        try {
          const r = await api(`/api/ai/providers/${p.id}/test`, { method: 'POST' });
          res.className = 'ai-test-res ' + (r.ok ? 'ok' : 'fail');
          res.textContent = r.ok ? _t('成功（{0}，{1} 秒）：{2}', r.model, (r.latency_ms / 1000).toFixed(1), r.text) : _t('失敗（{0} 秒）：{1}', (r.latency_ms / 1000).toFixed(1), r.error);
        } catch (e) { res.className = 'ai-test-res fail'; res.textContent = e.message; }
        test.disabled = false;
      });
      const edit = el('button', { class: 'btn btn-sm btn-ghost', type: 'button', html: svg('edit') + _t('編輯') });
      edit.addEventListener('click', () => editProvider(p));
      const del = el('button', { class: 'btn btn-sm btn-ghost', type: 'button', html: svg('trash') });
      del.addEventListener('click', async () => {
        if (!(await confirmDialog(_t('刪除「{0}」？', p.name), _t('用量紀錄會保留。'), _t('刪除')))) return;
        try { await api(`/api/ai/providers/${p.id}`, { method: 'DELETE' }); route(); } catch (e) { toast(e.message, true); }
      });
      const on = switchInput(!!p.enabled, async v => { try { await api(`/api/ai/providers/${p.id}`, { method: 'PUT', body: { values: { enabled: v } } }); route(); } catch (e) { toast(e.message, true); } });
      const u = p.usage;
      const money = p.billing === 'token' ? `${u.cost.toFixed(2)} ${p.currency || ''}${p.monthly_budget ? ' / ' + p.monthly_budget + ' ' + (p.currency || '') : ''}`
        : p.billing === 'monthly' ? (p.monthly_token_quota ? `${u.tokens.toLocaleString()} / ${p.monthly_token_quota.toLocaleString()} token` : _t('月費 {0} {1}', p.monthly_fee || 0, p.currency || ''))
          : _t('自建');
      return [el('tr', { class: p.blocked ? 'is-off' : '' },
        el('td', { class: 'nowrap', text: p.priority }),
        el('td', {}, el('b', { text: p.name }), p.note ? el('small', { class: 'adm-sub', text: p.note }) : null),
        el('td', {}, locBadge(p.location)),
        el('td', {}, el('span', { text: D.kinds[p.kind] || p.kind }), el('small', { class: 'adm-sub mono-sm', text: p.model || p.deployment || '—' })),
        el('td', { class: 'nowrap' }, el('span', { text: D.billing[p.billing] || p.billing }), el('small', { class: 'adm-sub', text: money })),
        el('td', { class: 'nowrap', text: _t('{0} 次（成功 {1}）', u.calls, u.ok) }),
        el('td', {}, p.blocked ? el('span', { class: 'tm-lv lv-warn', title: p.blocked, text: _t('不可用') }) : el('span', { class: 'tm-lv lv-ok', text: _t('可用') }),
          p.blocked ? el('small', { class: 'adm-sub', text: p.blocked }) : null),
        el('td', {}, on),
        el('td', { class: 'nowrap' }, test, edit, del)),
      el('tr', { class: 'ai-test-row' }, el('td', { colspan: '9' }, res))];
    });
    const list = el('section', { class: 'panel settings-card' },
      el('div', { class: 'adm-card-head' }, el('h3', { class: 'settings-card-title', html: svg('grid') + esc(_t('AI 服務（{0} 個，可用 {1} 個）', D.providers.length, D.usable)) }), el('span', { class: 'spacer' }), presetSel, addBtn),
      D.providers.length ? el('div', { class: 'adm-scroll' }, el('table', { class: 'adm-table ai-table' },
        el('thead', {}, el('tr', {}, ...[_t('優先'), _t('名稱'), _t('位置'), _t('協定／模型'), _t('計費／本期'), _t('本期呼叫'), _t('狀態'), _t('啟用'), ''].map(h => el('th', { text: h })))),
        el('tbody', {}, ...rows.flat())))
        : el('p', { class: 'hint', text: _t('還沒有任何 AI 服務。從右上角選一個範本（雲端或地端），按「新增服務」。') }),
      el('p', { class: 'hint', text: _t('優先數字小的先用（備援模式）。「測試」用固定的短句測試連線，不會送出公司資料，也不受總開關與雲端限制影響。') }));

    // ---------------- playground
    const prompt = el('textarea', { class: 'textarea', rows: '4', placeholder: _t('輸入問題，例如：請把下面的機房巡檢紀錄整理成三點重點…') });
    let pmode = S.mode;
    const pSeg = segmented([['fallback', _t('備援')], ['parallel', _t('並行比較')]], pmode, v => { pmode = v; });
    const picks = el('div', { class: 'scope-box' }, ...D.providers.map(p => {
      const b = el('button', { type: 'button', class: 'scope-chip', 'aria-pressed': String(!p.blocked), dataset: { id: p.id }, disabled: !!p.blocked, title: p.blocked || '' },
        `${p.name}（${LOC[p.location]}）`);
      b.addEventListener('click', () => b.setAttribute('aria-pressed', String(b.getAttribute('aria-pressed') !== 'true')));
      return b;
    }));
    const runBtn = el('button', { class: 'btn btn-primary', type: 'button', html: svg('sparkles') + _t('送出') });
    const out = el('div', { class: 'ai-results' });
    runBtn.addEventListener('click', async () => {
      const ids = [...picks.querySelectorAll('[aria-pressed="true"]')].map(b => Number(b.dataset.id));
      if (!prompt.value.trim()) return toast(_t('請輸入要問的內容'), true);
      if (!ids.length) return toast(_t('至少選一個可用的服務'), true);
      runBtn.disabled = true; out.replaceChildren(el('p', { class: 'hint', text: _t('等待回覆…') }));
      try {
        const r = await api('/api/ai/playground', { method: 'POST', body: { prompt: prompt.value, mode: pmode, ids } });
        out.replaceChildren(...r.results.map(x => el('div', { class: 'ai-result ' + (x.ok ? 'ok' : 'fail') + (r.answer && r.answer.provider_id === x.provider_id && r.mode === 'fallback' ? ' chosen' : '') },
          el('div', { class: 'ai-result-head' }, el('b', { text: x.name }), locBadge(x.location), el('span', { class: 'spacer' }),
            el('small', { class: 'hint', text: `${x.model || ''} · ${(x.latency_ms / 1000).toFixed(1)}s` + (x.ok ? ` · ${x.input_tokens}+${x.output_tokens} token` + (x.cost ? ` · ${x.cost} ${x.currency || ''}` : '') : '') })),
          el('div', { class: 'ai-result-text', text: x.ok ? x.text : x.error }))));
      } catch (e) { out.replaceChildren(el('p', { class: 'hint', text: e.message })); }
      runBtn.disabled = false;
    });
    const play = sysCard('sparkles', _t('測試台'), _t('實際問一次，比較不同模型的回答、速度與用量。會使用預設系統提示詞；雲端服務要先允許才會出現。這裡的呼叫也記錄在用量裡。'),
      field(_t('問題'), prompt), el('div', { class: 'field' }, el('span', { class: 'field-label', text: _t('使用的服務') }), picks),
      el('div', { class: 'sys-actions adm-actions-left' }, pSeg, el('span', { class: 'spacer' }), runBtn), out);

    // ---------------- recent usage
    let U = [];
    try { U = await api('/api/ai/usage'); } catch { /* ignore */ }
    const PURPOSE = { test: _t('測試'), playground: _t('測試台'), ask: _t('提問') };
    const usage = el('section', { class: 'panel settings-card' }, el('h3', { class: 'settings-card-title', html: svg('history') + esc(_t('最近的呼叫')) }),
      U.length ? el('div', { class: 'adm-scroll' }, el('table', { class: 'adm-table' },
        el('thead', {}, el('tr', {}, ...[_t('時間'), _t('服務'), _t('模型'), _t('用途'), _t('結果'), 'token', _t('費用'), _t('耗時')].map(h => el('th', { text: h })))),
        el('tbody', {}, ...U.map(r => el('tr', { class: r.ok ? '' : 'lv-row-fail' },
          el('td', { class: 'nowrap', text: r.at.slice(5, 16) }), el('td', { text: r.provider_name }), el('td', { class: 'mono-sm', text: r.model || '' }),
          el('td', { text: PURPOSE[r.purpose] || r.purpose }), el('td', { text: r.ok ? _t('成功') : r.error || _t('失敗') }),
          el('td', { class: 'nowrap', text: r.ok ? `${r.input_tokens}+${r.output_tokens}` : '' }), el('td', { class: 'nowrap', text: r.cost ? `${r.cost} ${r.currency || ''}` : '' }),
          el('td', { class: 'nowrap', text: r.latency_ms != null ? `${(r.latency_ms / 1000).toFixed(1)}s` : '' }))))))
        : el('p', { class: 'hint', text: _t('還沒有呼叫紀錄') }));

    body.append(setCard, list, play, usage);

    // ---------------- editor
    function editProvider(p, presetKey) {
      const pre = p ? {} : (D.presets[presetKey] || {});
      const v = p ? { ...p } : { name: pre.label, preset: presetKey, kind: pre.kind, location: pre.location || 'cloud', billing: pre.billing || (pre.location === 'onprem' ? 'self_hosted' : 'token'),
        base_url: pre.base_url || '', model: pre.model || '', deployment: '', api_version: pre.api_version || '', region: pre.region || '',
        token_param: pre.token_param || 'max_tokens', send_temperature: pre.kind === 'anthropic' ? 0 : 1, extra_body: '', enabled: 1, vision: pre.vision ? 1 : 0,
        priority: (D.providers.reduce((m, x) => Math.max(m, x.priority), 0) || 0) + 10, price_in: pre.price_in || 0, price_out: pre.price_out || 0,
        currency: 'USD', monthly_budget: 0, monthly_fee: 0, monthly_token_quota: 0, reset_day: 1, note: '' };
      const f = {};
      const txt = (k, attrs = {}) => (f[k] = input(v[k], attrs));
      const sel = (k, opts) => { f[k] = el('select', { class: 'select' }, ...Object.entries(opts).map(([a, b]) => el('option', { value: a, text: b }))); f[k].value = v[k]; return f[k]; };
      const key = input('', { type: 'password', autocomplete: 'new-password', placeholder: p?.key_set ? _t('••••••••（已設定；留空 = 不變）') : (v.location === 'onprem' ? _t('地端服務通常不需要') : _t('API 金鑰')) });
      let clearKey = false;
      const clearBtn = p?.key_set ? el('button', { class: 'kb-link-btn', type: 'button', text: _t('清除金鑰') }) : null;
      clearBtn?.addEventListener('click', () => { clearKey = true; key.value = ''; key.placeholder = _t('（儲存後清除）'); });
      f.extra_body = el('textarea', { class: 'textarea mono', rows: '2', placeholder: '{"top_p": 0.9}' }); f.extra_body.value = v.extra_body || '';
      f.note = el('textarea', { class: 'textarea', rows: '2' }); f.note.value = v.note || '';
      f.send_temperature = switchCtl(!!v.send_temperature, _t('傳送溫度（目前的 Claude 模型不接受，預設不傳）'), () => {});
      f.vision = switchCtl(!!v.vision, _t('可看圖片（模型支援看圖；AiPM 的截圖只送給勾選的服務）'), () => {});
      const kindSel = sel('kind', D.kinds);
      const billSel = sel('billing', D.billing);
      const rowsFor = {};
      const grid = el('div', { class: 'sys-form' },
        field(_t('名稱'), txt('name')),
        field(_t('位置'), sel('location', { cloud: _t('雲端（資料送到公司外部）'), onprem: _t('地端（資料不離開公司）') })),
        field(_t('呼叫協定'), kindSel, _t('OpenAI 相容涵蓋 Ollama、vLLM、LM Studio、llama.cpp、LocalAI、公司閘道與多數雲端服務')),
        (rowsFor.base_url = field(_t('服務網址'), txt('base_url', { placeholder: 'https://… 或 http://ai-host:11434/v1' }), pre.hint || '')),
        (rowsFor.model = field(_t('模型名稱'), txt('model', { placeholder: 'claude-opus-5-5、qwen3:32b…' }))),
        (rowsFor.deployment = field(_t('部署名稱（Azure）'), txt('deployment'))),
        (rowsFor.api_version = field(_t('API 版本（Azure）'), txt('api_version'))),
        (rowsFor.region = field(_t('區域（Bedrock）'), txt('region'))),
        el('div', { class: 'field' }, el('span', { class: 'field-label', text: _t('API 金鑰') }), key, clearBtn),
        (rowsFor.token_param = field(_t('輸出上限參數'), sel('token_param', { max_tokens: 'max_tokens', max_completion_tokens: 'max_completion_tokens', none: _t('不傳送') }))),
        field(_t('優先順序（小的先用）'), txt('priority', { type: 'number' })),
        field(_t('計費方式'), billSel),
        (rowsFor.price = el('div', { class: 'field' }, el('span', { class: 'field-label', text: _t('單價（每 100 萬 token：輸入／輸出）') }),
          el('div', { class: 'sys-test-row' }, txt('price_in', { type: 'number', step: 'any', min: '0' }), txt('price_out', { type: 'number', step: 'any', min: '0' }), txt('currency', { style: 'max-width:6em' })))),
        (rowsFor.budget = field(_t('每期預算上限（0 = 不限）'), txt('monthly_budget', { type: 'number', step: 'any', min: '0' }), _t('用完就跳過，改用下一個服務'))),
        (rowsFor.fee = field(_t('月費（包月／自建攤提，供比較）'), txt('monthly_fee', { type: 'number', step: 'any', min: '0' }))),
        (rowsFor.quota = field(_t('每期 token 額度（0 = 不限）'), txt('monthly_token_quota', { type: 'number', min: '0' }))),
        field(_t('每期起算日（每月幾號）'), txt('reset_day', { type: 'number', min: '1', max: '28' })),
        el('div', { class: 'field span-all' }, f.send_temperature),
        el('div', { class: 'field span-all' }, f.vision),
        el('div', { class: 'span-all' }, field(_t('額外參數（JSON，合併到請求內容）'), f.extra_body, _t('例如 Claude 的 {"output_config": {"effort": "high"}}，或 OpenAI 相容服務的 {"top_p": 0.9}'))),
        el('div', { class: 'span-all' }, field(_t('備註'), f.note)));
      const paint = () => {
        const k = kindSel.value, b = billSel.value;
        rowsFor.base_url.hidden = k === 'anthropic' && false;
        rowsFor.deployment.hidden = rowsFor.api_version.hidden = k !== 'azure_openai';
        rowsFor.region.hidden = k !== 'bedrock';
        rowsFor.token_param.hidden = !['openai', 'azure_openai'].includes(k);
        rowsFor.price.hidden = rowsFor.budget.hidden = b !== 'token';
        rowsFor.fee.hidden = b === 'token';
        rowsFor.quota.hidden = b !== 'monthly';
      };
      kindSel.addEventListener('change', paint); billSel.addEventListener('change', paint); paint();
      const save = el('button', { class: 'btn btn-primary', type: 'button', html: svg('check') + _t('儲存') });
      const cancel = el('button', { class: 'btn btn-ghost', type: 'button', text: _t('取消') });
      const close = modal({ title: p ? _t('編輯 AI 服務') : _t('新增 AI 服務：{0}', pre.label || ''), body: grid, actions: [cancel, save], wide: true });
      cancel.addEventListener('click', close);
      save.addEventListener('click', async () => {
        const values = {};
        for (const [k, c] of Object.entries(f)) {
          if (k === 'send_temperature' || k === 'vision') values[k] = c.querySelector('input').checked ? 1 : 0;
          else values[k] = ['priority', 'price_in', 'price_out', 'monthly_budget', 'monthly_fee', 'monthly_token_quota', 'reset_day'].includes(k) ? Number(c.value || 0) : c.value;
        }
        if (!p) values.preset = presetKey;
        const apiKey = clearKey ? '' : (key.value ? key.value : (p ? null : ''));
        save.disabled = true;
        try {
          await api(p ? `/api/ai/providers/${p.id}` : '/api/ai/providers', { method: p ? 'PUT' : 'POST', body: { values, api_key: apiKey } });
          close(); toast(_t('已儲存')); route();
        } catch (e) { toast(e.message, true); save.disabled = false; }
      });
    }
  }

  function renderBackup() {
    const exportBtn = el('button', { class: 'btn btn-primary', type: 'button', html: svg('download') + _t('下載 JSON') });
    exportBtn.addEventListener('click', async () => {
      try {
        const data = await api('/api/export');
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const a = el('a', { href: URL.createObjectURL(blob), download: `tool-table-${new Date().toISOString().slice(0, 10)}.json` });
        document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 1000);
        toast(_t('已匯出'));
      } catch (e) { toast(e.message, true); }
    });

    const file = el('input', { type: 'file', accept: '.json,application/json', hidden: true });
    let mode = 'replace';
    const pick = m => { mode = m; file.click(); };
    const replaceBtn = el('button', { class: 'btn btn-danger', type: 'button', html: svg('upload') + _t('匯入並取代全部') });
    replaceBtn.addEventListener('click', () => pick('replace'));
    const appendBtn = el('button', { class: 'btn', type: 'button', html: svg('plus') + _t('匯入並附加') });
    appendBtn.addEventListener('click', () => pick('append'));
    file.addEventListener('change', async () => {
      const f = file.files[0];
      file.value = '';
      if (!f) return;
      let data;
      try { data = JSON.parse(await f.text()); } catch { return toast(_t('不是有效的 JSON 檔'), true); }
      const nodes = (function count(list) { return (list || []).reduce((s, n) => s + 1 + count(n.children), 0); })(data.nodes);
      const msg = mode === 'replace'
        ? _t("會刪除目前所有內容、快速連結與設定（檔案內有待辦卡片時也會取代看板），換成檔案中的 {0} 個項目。建議先下載備份。", nodes)
        : _t("會把檔案中的 {0} 個項目與快速連結加到現有內容後面；檔案裡的設定會覆蓋目前設定。", nodes);
      if (!(await confirmDialog(mode === 'replace' ? _t('取代全部內容？') : _t('附加匯入？'), msg, mode === 'replace' ? _t('取代') : _t('匯入'), mode === 'replace'))) return;
      try {
        const r = await api('/api/import', { method: 'POST', body: { data, replace: mode === 'replace' } });
        state.settings = await api('/api/settings');
        TT.applyAppearance(state.settings); paintBrand();
        state.selected = null;
        await loadTree();
        toast(_t("匯入完成：{0} 個項目、{1} 個快速連結", r.nodes, r.quick_links) + (r.tasks ? _t("、{0} 張待辦卡片", r.tasks) : ''));
      } catch (e) { toast(e.message, true); }
    });

    const card = (icon, title, text, ...actions) => el('section', { class: 'panel backup-card' },
      el('span', { class: 'backup-icon', html: svg(icon) }),
      el('div', { class: 'backup-text' }, el('h3', { text: title }), el('p', { text })),
      el('div', { class: 'backup-actions' }, actions));

    const auto = el('section', { class: 'panel settings-card sys-card auto-backup' });
    renderAutoBackup(auto);
    $('stage-body').append(auto, el('div', { class: 'backup-grid' },
      card('download', _t('匯出'), _t('設定、首頁版面、所有資料夾與連結、快速連結，打包成一個 JSON。可用來備份、搬家，或做成範本給別人直接套用。（圖示檔案不包含在內）'), exportBtn),
      card('upload', _t('匯入'), _t('從 JSON 匯入。「取代全部」會先清空；「附加」會加在現有內容之後。'), appendBtn, replaceBtn, file),
      demoCard(card)));
  }

  /** 示範資料: demo staff in 7 departments + a one-year data-centre rebuild project (app/demo.py) */
  function demoCard(card) {
    const loadBtn = el('button', { class: 'btn btn-primary', type: 'button', html: svg('sparkles') + _t('建立示範資料') });
    const dropBtn = el('button', { class: 'btn btn-ghost', type: 'button', html: svg('trash') + _t('移除示範資料') });
    const state = el('p', { class: 'hint' });
    const paint = st => {
      loadBtn.hidden = st.loaded; dropBtn.hidden = !st.loaded;
      state.textContent = st.loaded ? _t("已建立：{0} 位示範人員、{1} 張卡片", st.people, st.tasks) : _t('尚未建立');
    };
    api('/api/system/demo').then(paint).catch(() => { state.textContent = ''; });
    loadBtn.addEventListener('click', async () => {
      if (!(await confirmDialog(_t('建立示範資料？'), _t('會建立 16 位示範人員（管理部、專案管理部、現場部、網路部、資安部、稽核部、會計部）、一年期的主機房改建專案與 23 張日常卡片，卡片都標上 #示範。示範人員只存在這個系統裡，不能登入，也不會寫入 AD。建議只在測試機使用。'), _t('建立'), false))) return;
      loadBtn.disabled = true;
      try { const r = await api('/api/system/demo', { method: 'POST' }); toast(_t("已建立示範資料：{0} 個專案項目、{1} 位人員", r.items, r.people)); paint(await api('/api/system/demo')); }
      catch (e) { toast(e.message, true); }
      finally { loadBtn.disabled = false; }
    });
    dropBtn.addEventListener('click', async () => {
      if (!(await confirmDialog(_t('移除示範資料？'), _t('會刪除示範專案、日常卡片與示範人員（包含之後在這些卡片上的留言與工時）。其他資料不受影響。'), _t('移除'), true))) return;
      dropBtn.disabled = true;
      try { const r = await api('/api/system/demo', { method: 'DELETE' }); toast(_t("已移除 {0} 張卡片、{1} 位示範人員", r.tasks, r.people)); paint(await api('/api/system/demo')); }
      catch (e) { toast(e.message, true); }
      finally { dropBtn.disabled = false; }
    });
    const c = card('sparkles', _t('示範資料'), _t('測試用：7 個部門的示範人員，加上一年期的主機房改建專案（設備採購、網路架構設計、施工、設定、分期驗收、總結驗收）與各部門的日常卡片，狀態有進行中、待確認、暫緩、逾期、卡住與取消。'), loadBtn, dropBtn);
    c.querySelector('.backup-text').append(state);
    return c;
  }
})();
