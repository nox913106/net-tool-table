/* =============================================================================
   Tool Table — shared helpers (portal + admin)
   ============================================================================= */
'use strict';

const TT = (() => {
  // ---------------------------------------------------------------- storage
  const store = {
    get(key, fallback = null) {
      try {
        const v = localStorage.getItem('tt:' + key);
        return v === null ? fallback : JSON.parse(v);
      } catch { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem('tt:' + key, JSON.stringify(value)); } catch { /* private mode */ }
    },
    remove(key) {
      try { localStorage.removeItem('tt:' + key); } catch { /* ignore */ }
    },
  };

  // -------------------------------------------------------------------- api
  async function api(path, { method = 'GET', body, form } = {}) {
    // X-Tool-Table forces a CORS preflight for cross-site requests (which the server never
    // approves), so other websites cannot call local-only endpoints such as /api/launch.
    const opts = { method, headers: { 'X-Tool-Table': '1', 'X-Lang': window.TT_LANG || 'zh-TW' } };
    if (form) opts.body = form;
    else if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(path, opts);
    let data = null;
    const text = await res.text();
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (res.status === 401 && !path.startsWith('/api/auth/') && location.pathname !== '/login') {
      location.href = '/login?next=' + encodeURIComponent(location.pathname + location.search + location.hash);   // session expired
      throw new Error(_t('請重新登入'));
    }
    if (!res.ok) {
      const detail = data && data.detail;
      const msg = typeof detail === 'string' ? detail
        : Array.isArray(detail) ? detail.map(d => d.msg).join('；')
        : `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return data;
  }

  // ---------------------------------------------------------------- escape
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const el = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'style' && typeof v === 'object') {
        for (const [prop, val] of Object.entries(v)) {
          if (prop.startsWith('--')) node.style.setProperty(prop, val); else node.style[prop] = val;
        }
      }
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (k === 'dataset') { for (const [dk, dv] of Object.entries(v)) if (dv != null) node.dataset[dk] = dv; }
      else node.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c === null || c === undefined || c === false) continue;
      node.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return node;
  };

  // ------------------------------------------------------------------ icons
  // Line icons (24×24, stroke = currentColor)
  const P = {
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/><path d="m15 10-2 2 2 2"/>',
    'sidebar-open': '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/><path d="m13 10 2 2-2 2"/>',
    repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    users: '<circle cx="9" cy="8" r="4"/><path d="M1 21a8 8 0 0 1 16 0"/><path d="M17 4a4 4 0 0 1 0 8"/><path d="M23 21a8 8 0 0 0-5-7.4"/>',
    lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
    message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
    calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><path d="M16 2v4M8 2v4M3 10h18"/>',
    kanban: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M8 7v7M12 7v4M16 7v9"/>',
    flag: '<path d="M4 22V4"/><path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
    'folder-open': '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h6a2 2 0 0 1 2 2v1"/><path d="M3 19 5.6 11.4A2 2 0 0 1 7.5 10H20a1 1 0 0 1 1 1.3L18.6 18a2 2 0 0 1-1.9 1.4H5a2 2 0 0 1-2-2Z"/>',
    paperclip: '<path d="m21.4 11.1-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/>',
    external: '<path d="M14 4h6v6"/><path d="M20 4 10 14"/><path d="M19 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4"/>',
    star: '<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9Z"/>',
    history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>',
    monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
    zap: '<path d="M13 2 4 14h7l-1 8 9-12h-7Z"/>',
    'zap-off': '<path d="M12.4 6.6 13 2l-3 4M17.3 11.8 20 10h-5.6M8 8l-4 6h7l-1 8 5-6.7"/><path d="m2 2 20 20"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/>',
    grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13"/><circle cx="3.5" cy="6" r="1"/><circle cx="3.5" cy="12" r="1"/><circle cx="3.5" cy="18" r="1"/>',
    'chevron-right': '<path d="m9 6 6 6-6 6"/>',
    'chevron-down': '<path d="m6 9 6 6 6-6"/>',
    'chevron-up': '<path d="m6 15 6-6 6 6"/>',
    'chevron-left': '<path d="m15 6-6 6 6 6"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    home: '<path d="m3 11 9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/>',
    'arrow-left': '<path d="M19 12H5M12 19l-7-7 7-7"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m17 8-5-5-5 5M12 3v12"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5M12 15V3"/>',
    grip: '<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>',
    'eye-off': '<path d="M9.9 4.2A10 10 0 0 1 12 4c7 0 10 8 10 8a17 17 0 0 1-3.2 4.2M6.6 6.6C3.6 8.6 2 12 2 12s3 8 10 8a9.7 9.7 0 0 0 5.4-1.6"/><path d="m2 2 20 20M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
    image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21"/>',
    palette: '<circle cx="13.5" cy="6.5" r="1"/><circle cx="17.5" cy="10.5" r="1"/><circle cx="8.5" cy="7.5" r="1"/><circle cx="6.5" cy="12.5" r="1"/><path d="M12 2a10 10 0 0 0 0 20c1 0 1.5-.8 1.5-1.7 0-.4-.2-.8-.4-1.1-.3-.3-.4-.7-.4-1.1 0-.9.8-1.7 1.7-1.7H16a6 6 0 0 0 6-6c0-4.9-4.5-8.4-10-8.4Z"/>',
    layout: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 21V9"/>',
    globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    filter: '<path d="M3 5h18l-7 8v6l-4 2v-8Z"/>',
    sparkles: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9Z"/><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9Z"/>',
    megaphone: '<path d="m3 11 15-6v14L3 13Z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/>',
    database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5"/><path d="M3 12c0 1.7 4 3 9 3s9-1.3 9-3"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/>',
    play: '<path d="M7 4v16l13-8Z"/>',
    app: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M3 9h18"/><circle cx="6.5" cy="6.5" r=".6"/><circle cx="9" cy="6.5" r=".6"/>',
    wand: '<path d="m15 4 5 5L9 20H4v-5Z"/><path d="m13 6 5 5"/><path d="M19 2v3M20.5 3.5h-3"/>',
  };
  const svg = (name, attrs = '') =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${attrs}>${P[name] || ''}</svg>`;

  const ICON_FILE = /\.(png|jpe?g|svg|webp|gif)$/i;
  const isIconFile = icon => !!icon && ICON_FILE.test(icon);
  const iconUrl = icon => `/resource/icon/${encodeURIComponent(icon)}`;

  function initials(name) {
    const s = String(name || '').replace(/^[\d\-.\s]+/, '').trim();   // drop "3-2." style prefixes
    if (!s) return '?';
    const cjk = s.match(/[㐀-鿿]/);
    if (cjk && s.indexOf(cjk[0]) === 0) return s.slice(0, 1);
    const words = s.split(/[\s\-_/]+/).filter(Boolean);
    return (words.length > 1 ? words[0][0] + words[1][0] : s.slice(0, 2)).toUpperCase();
  }

  /** Icon tile: uploaded image, emoji/text icon, folder glyph or initials */
  function tile({ icon, name, color, folder = false, size = 44 } = {}) {
    const t = el('span', { class: 'tile' });
    t.style.setProperty('--tile', size + 'px');
    if (color) t.style.setProperty('--tile-color', color);
    const fallback = () => {
      t.innerHTML = folder ? svg('folder') : `<span class="initials">${esc(initials(name))}</span>`;
    };
    if (isIconFile(icon)) {
      const img = el('img', { src: iconUrl(icon), alt: '', loading: 'lazy', decoding: 'async' });
      img.addEventListener('error', fallback, { once: true });
      t.append(img);
    } else if (icon) {
      t.append(el('span', { class: 'emoji', text: icon }));
    } else {
      fallback();
    }
    return t;
  }

  // ------------------------------------------------------------------- misc
  function hostOf(url) {
    try { return new URL(url).host; } catch { return ''; }
  }

  function toast(msg, isError = false) {
    let box = document.querySelector('.toasts');
    if (!box) { box = el('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.append(box); }
    const t = el('div', { class: 'toast' + (isError ? ' error' : ''), text: msg });
    box.append(t);
    setTimeout(() => { t.classList.add('leaving'); setTimeout(() => t.remove(), 300); }, isError ? 4500 : 2400);
  }

  // ----------------------------------------------------------- tactical scan line
  // a glowing line sweeps down the background grid only: it lives in the backdrop, so the header,
  // sidebar, panels and cards (all opaque) stay clear of it (styling: tactical.css)
  document.addEventListener('DOMContentLoaded', () => {
    const grid = document.querySelector('.backdrop');
    if (grid && !grid.querySelector('.tt-scan')) grid.append(el('div', { class: 'tt-scan', 'aria-hidden': 'true' }, el('i')));
  });

  // ----------------------------------------------------------- card tags
  // a tag without an administrator's colour always gets the same automatic hue from its name
  const TAG_HUES = [212, 145, 28, 280, 345, 188, 48, 100, 250, 0, 165, 312, 232, 120, 12, 295];
  const tagHue = name => { let h = 0; for (const ch of String(name).toLowerCase()) h = (h * 31 + ch.codePointAt(0)) >>> 0; return TAG_HUES[h % TAG_HUES.length]; };

  // ----------------------------------------------------------- appearance
  const media = window.matchMedia('(prefers-color-scheme: dark)');

  /** Effective theme: viewer override > site setting; "auto" follows the OS */
  function resolveTheme(siteTheme) {
    const pref = store.get('theme') || siteTheme || 'auto';
    return pref === 'auto' ? (media.matches ? 'dark' : 'light') : pref;
  }

  function applyAppearance(settings) {
    const root = document.documentElement;
    root.dataset.theme = resolveTheme(settings.theme);
    root.dataset.bg = settings.background || 'aurora';
    root.dataset.density = settings.density || 'comfortable';
    root.dataset.perf = store.get('perf') === 'low' ? 'low' : 'normal';
    // accent: the theme's own (戰術綠 / 墨綠) unless an administrator picked another; the old default violet counts as unset
    const ac = settings.accent_color || '';
    if (/^#[0-9a-f]{6}$/i.test(ac) && ac.toLowerCase() !== '#6366f1') root.style.setProperty('--accent', ac);
    else root.style.removeProperty('--accent');
    media.onchange = () => { root.dataset.theme = resolveTheme(settings.theme); document.dispatchEvent(new Event('tt:theme')); };
    syncThemeColor();
  }

  /** Cycle theme preference: auto → light → dark → auto */
  function cycleTheme(settings) {
    const order = ['auto', 'light', 'dark'];
    const cur = store.get('theme') || settings.theme || 'auto';
    const next = order[(order.indexOf(cur) + 1) % order.length];
    store.set('theme', next);
    document.documentElement.dataset.theme = resolveTheme(settings.theme);
    document.dispatchEvent(new Event('tt:theme'));
    return next;
  }
  const themePref = settings => store.get('theme') || settings.theme || 'auto';

  function togglePerf() {
    const next = store.get('perf') === 'low' ? 'normal' : 'low';
    store.set('perf', next);
    document.documentElement.dataset.perf = next;
    return next;
  }

  function setFavicon(icon) {
    let link = document.querySelector('link[rel="icon"]');
    if (!link) { link = el('link', { rel: 'icon' }); document.head.append(link); }
    if (isIconFile(icon)) link.href = iconUrl(icon);
    else if (icon) {
      const s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">${esc(icon)}</text></svg>`;
      link.href = 'data:image/svg+xml,' + encodeURIComponent(s);
    }
  }

  // ------------------------------------------------------- dropped links
  /** Is this drag carrying a link from a browser (address bar, page link, bookmark)? */
  function isLinkDrag(e) {
    const types = [...(e.dataTransfer?.types || [])];
    return !types.includes('Files') && (types.includes('text/uri-list') || types.includes('text/x-moz-url'));
  }

  function nameFromUrl(url) {
    try {
      const host = new URL(url).hostname.replace(/^www\./, '');
      const first = host.split('.')[0] || host;
      return first.charAt(0).toUpperCase() + first.slice(1);
    } catch { return url; }
  }

  /** Read { url, title } from a drop event's dataTransfer (Chrome, Edge, Firefox, Safari) */
  function readDroppedLink(dt) {
    let url = '';
    let title = '';
    const moz = dt.getData('text/x-moz-url');                  // Firefox: "url\ntitle"
    if (moz) [url, title = ''] = moz.split(/\r?\n/);
    if (!url) url = (dt.getData('text/uri-list') || '').split(/\r?\n/).find(l => l && !l.startsWith('#')) || '';
    const html = dt.getData('text/html');                       // link text / page title
    if (html) {
      const a = new DOMParser().parseFromString(html, 'text/html').querySelector('a[href]');
      if (a) {
        url = url || a.getAttribute('href');
        title = title || a.textContent.trim() || a.getAttribute('title') || a.querySelector('img')?.alt || '';
      }
    }
    if (!url) {
      const t = (dt.getData('text/plain') || '').trim();
      if (/^https?:\/\/\S+$/i.test(t)) url = t;
    }
    url = (url || '').trim();
    if (!/^https?:\/\//i.test(url)) return null;
    title = title.replace(/\s+/g, ' ').trim();
    if (!title || title === url) title = nameFromUrl(url);
    return { url, title: title.slice(0, 200) };
  }

  /** Pick the uploaded icon whose name appears in the URL or title (e.g. grafana_icon.svg ↔ grafana.example.com) */
  function guessIcon(url, title, iconNames) {
    const host = hostOf(url).toLowerCase();
    const labels = host.split('.');
    const hay = `${host} ${url} ${title}`.toLowerCase();
    let best = '';
    let bestLen = 0;
    for (const name of iconNames) {
      const base = name.toLowerCase().replace(/\.[^.]+$/, '').replace(/([-_](icon|logo|color|org))+$/, '');
      const tokens = new Set([base, ...base.split(/[-_]/)]);
      for (const tok of tokens) {
        const hit = tok.length >= 4 ? hay.includes(tok) : tok.length === 3 && labels.includes(tok);
        if (hit && tok.length > bestLen) { best = name; bestLen = tok.length; }
      }
    }
    return best;
  }

  // ---------------------------------------------------- local programs
  // Only the Windows portable edition can launch programs / read shortcuts, and only for
  // the browser on that same PC. /api/local/status says whether that applies here.
  const isProgram = url => /^file:/i.test(url || '');
  const isFileDrag = e => [...(e.dataTransfer?.types || [])].includes('Files');

  /** file:///C:/Program Files/x.exe → C:\Program Files\x.exe (for display / editing) */
  function programPath(url) {
    if (!isProgram(url)) return url || '';
    let p = url.replace(/^file:/i, '');
    if (p.startsWith('///')) p = p.slice(3);
    else if (p.startsWith('//')) p = '\\\\' + p.slice(2);
    try { p = decodeURIComponent(p); } catch { /* keep */ }
    return /^[A-Za-z]:/.test(p) || p.startsWith('\\\\') ? p.replace(/\//g, '\\') : (p.startsWith('/') ? p : '/' + p);
  }
  // C:\…, \\server\share\…, file:…, or an absolute POSIX path (development on Linux / macOS)
  const looksLikePath = v => /^[A-Za-z]:[\\/]/.test(v || '') || /^\\\\/.test(v || '') || isProgram(v) || /^\/(?!\/)/.test(v || '');

  let localStatusCache = null;
  function localStatus() {
    if (!localStatusCache) localStatusCache = api('/api/local/status').catch(() => ({ enabled: false, allowed: false }));
    return localStatusCache;
  }

  async function launchProgram(node) {
    const st = await localStatus();
    if (!st.allowed) {
      toast(st.enabled ? _t('程式只能在執行單機版的那台電腦上啟動') : _t('這是本機程式，只能在 Windows 單機版啟動'), true);
      return false;
    }
    try {
      await api(`/api/launch/${node.id}`, { method: 'POST' });
      toast(_t("已啟動「{0}」", node.name));
      return true;
    } catch (e) { toast(e.message, true); return false; }
  }

  const SHORTCUT_EXT = /\.(lnk|url)$/i;
  const PROGRAM_EXT = /\.(exe|bat|cmd|msc|cpl|ps1|vbs|jar|appref-ms)$/i;

  /**
   * A file dropped from Explorer → { kind: 'app'|'url', name, url, icon, args, cwd, found }.
   * Shortcuts are read on the server; for an .exe the server looks it up by name + size.
   */
  async function inspectDroppedFile(file) {
    if (SHORTCUT_EXT.test(file.name)) {
      const form = new FormData();
      form.append('file', file);
      return { found: true, ...(await api('/api/local/shortcut', { method: 'POST', form })) };
    }
    if (PROGRAM_EXT.test(file.name)) {
      return api('/api/local/resolve', { method: 'POST', body: { name: file.name, size: file.size } });
    }
    throw new Error(_t('請拖曳程式的捷徑（.lnk）、網址捷徑（.url）或執行檔（.exe）'));
  }

  /** Website favicon → icon library. Resolves to the icon name or '' */
  const fetchSiteIcon = url => api('/api/icons/fetch', { method: 'POST', body: { url } }).then(r => r.icon || '').catch(() => '');

  /* ---------- install as an app (Chrome / Edge) ---------- */
  let installPrompt = null;
  const installListeners = new Set();
  const installed = () => matchMedia('(display-mode: standalone)').matches || matchMedia('(display-mode: window-controls-overlay)').matches;
  document.addEventListener('tt:theme', () => syncThemeColor());
  if ('serviceWorker' in navigator && window.isSecureContext) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => { /* e.g. untrusted certificate */ }));
  }
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();               // show our own button instead of the mini-infobar
    installPrompt = e;
    installListeners.forEach(f => f(true));
  });
  window.addEventListener('appinstalled', () => {
    installPrompt = null;
    installListeners.forEach(f => f(false));
    toast(_t('已安裝為應用程式，可從開始功能表或桌面開啟'));
  });
  /** fn(available) is called whenever the browser offers / withdraws installation */
  function onInstallable(fn) { installListeners.add(fn); fn(!!installPrompt && !installed()); }
  async function installApp() {
    if (!installPrompt) return false;
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice;
    installPrompt = null;
    installListeners.forEach(f => f(false));
    return outcome === 'accepted';
  }
  /** keep the window title bar of the installed app in the page colour */
  function syncThemeColor() {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim() || '#0a0d1a';
  }

  /* ---------- accounts (server edition) ---------- */
  let mePromise = null;
  /** { user, auth, is_admin, needs_ad_admin } — portable / no-login: an implicit local admin */
  const me = () => (mePromise ||= api('/api/auth/me').then(m => {
    if (m.user?.must_change_password && location.pathname !== '/login') {     // first sign-in of the local admin
      location.replace('/login?change=1&next=' + encodeURIComponent(location.pathname + location.hash));
    }
    if (m.user?.lang && m.user.lang !== TTI18n.lang) TTI18n.set(m.user.lang);      // the account's language wins
    return m;
  }).catch(() => ({ user: { username: 'local', display_name: _t('本機'), role: 'superadmin' }, auth: false, is_admin: true, board: { view: 'all', edit: 'all', depts: [] } })));
  const ROLE = { superadmin: _t('本機最高管理員'), sysadmin: _t('系統管理者'), board_admin: _t('看板總管理者（RW）'), board_viewer: _t('看板總管理者（RO）'),
    dept_admin: _t('部門看板管理者（RW）'), dept_viewer: _t('部門看板管理者（RO）'), user: _t('使用者') };
  const nameOf = p => (p && (p.name || p.display_name || p.username)) || '';
  function avatar(person, size = 24) {
    const name = nameOf(person) || '?';
    let h = 0;
    for (const ch of person?.username || name) h = (h * 31 + ch.charCodeAt(0)) % 360;
    const text = /[\u3400-\u9fff]/.test(name) ? name.slice(-2) : name.split(/[\s._-]+/).map(w => w[0]).join('').slice(0, 2).toUpperCase();
    return el('span', { class: 'avatar', title: name + (person?.department ? `（${person.department}）` : ''), text,
      style: { '--av': `hsl(${h} 62% 52%)`, width: size + 'px', height: size + 'px', fontSize: Math.round(size * 0.42) + 'px' } });
  }

  /** Language switch (中 ⇄ EN): saved to the account when signed in, and in this browser. Its label is in the language it switches to. */
  function langButton(cls = 'icon-btn lang-btn') {
    const to = TTI18n.lang === 'en' ? 'zh-TW' : 'en';
    const b = el('button', { class: cls, type: 'button', text: to === 'en' ? 'EN' : '中',
      title: to === 'en' ? 'Switch to English' : '切換為繁體中文', 'aria-label': to === 'en' ? 'Switch to English' : '切換為繁體中文' });
    b.addEventListener('click', async () => {
      try { await api('/api/auth/lang', { method: 'PUT', body: { lang: to } }); } catch (e) { /* not signed in: this browser only */ }
      TTI18n.set(to);
    });
    return b;
  }

  /** Header user menu: name / role, admin link, public dashboard, password (local account), sign out */
  async function userMenu(host) {
    const info = await me();
    if (!info.auth || !host) return info;
    const u = info.user;
    const btn = el('button', { class: 'user-btn', type: 'button', 'aria-haspopup': 'menu', title: `${nameOf(u)}（${ROLE[u.role] || u.role}）` },
      avatar(u, 30), el('span', { class: 'user-btn-name', text: nameOf(u) }));
    host.replaceChildren(btn);
    host.hidden = false;
    let pop = null;
    const close = () => { pop?.remove(); pop = null; document.removeEventListener('mousedown', outside); };
    const outside = e => { if (pop && !pop.contains(e.target) && !btn.contains(e.target)) close(); };
    btn.addEventListener('click', () => {
      if (pop) return close();
      const item = (icon, text, onClick, href) => {
        const a = el(href ? 'a' : 'button', { class: 'menu-item', type: href ? null : 'button', href: href || null, html: svg(icon) + `<span>${esc(text)}</span>` });
        if (onClick) a.addEventListener('click', e => { close(); onClick(e); });
        return a;
      };
      pop = el('div', { class: 'user-pop', role: 'menu' },
        el('div', { class: 'user-pop-head' }, avatar(u, 40),
          el('div', {}, el('strong', { text: nameOf(u) }), el('small', { text: [u.username, u.department].filter(Boolean).join(' · ') }),
            el('span', { class: `role-badge role-${u.role}`, text: ROLE[u.role] || u.role }),
            ['dept_admin', 'dept_viewer'].includes(u.role) && info.board?.depts?.length ? el('small', { text: _t('管理部門：') + info.board.depts.join('、') }) : null)),
        info.is_admin && location.pathname !== '/admin' ? item('settings', _t('管理後台'), null, '/admin') : null,
        location.pathname !== '/' ? item('home', _t('回到入口'), null, '/') : null,
        item('layout', _t('公開進度看板'), null, '/dashboard'),
        u.source === 'local' ? item('edit', _t('修改密碼'), () => changePassword()) : null,
        item('logout', _t('登出'), async () => { try { await api('/api/auth/logout', { method: 'POST' }); } finally { location.href = '/login'; } }));
      document.body.append(pop);
      const r = btn.getBoundingClientRect();
      pop.style.top = `${r.bottom + 8}px`;
      pop.style.right = `${Math.max(8, innerWidth - r.right)}px`;
      setTimeout(() => document.addEventListener('mousedown', outside), 0);
    });
    return info;
  }

  function changePassword() {
    const cur = el('input', { class: 'input', type: 'password', autocomplete: 'current-password' });
    const nw = el('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: _t('至少 12 個字元') });
    const nw2 = el('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
    const ok = el('button', { class: 'btn btn-primary', type: 'button', text: _t('變更密碼') });
    const cancel = el('button', { class: 'btn btn-ghost', type: 'button', text: _t('取消') });
    const field = (t, i) => el('label', { class: 'field' }, el('span', { class: 'field-label', text: t }), i);
    const wrap = el('div', { class: 'modal' }, el('div', { class: 'modal-card', role: 'dialog', 'aria-modal': 'true' },
      el('div', { class: 'modal-head' }, el('h3', { text: _t('修改本機管理員密碼') })),
      el('div', { class: 'modal-body' }, field(_t('目前的密碼'), cur), field(_t('新密碼'), nw), field(_t('再輸入一次'), nw2)),
      el('div', { class: 'modal-foot' }, cancel, ok)));
    const close = () => wrap.remove();
    cancel.addEventListener('click', close);
    ok.addEventListener('click', async () => {
      if (nw.value !== nw2.value) return toast(_t('兩次輸入的新密碼不一樣'), true);
      try { await api('/api/auth/password', { method: 'POST', body: { current: cur.value, new: nw.value } }); close(); toast(_t('密碼已變更')); }
      catch (err) { toast(err.message, true); }
    });
    document.body.append(wrap);
    setTimeout(() => cur.focus(), 30);
  }

  /**
   * @mention autocomplete for a textarea / input: typing "@ab" lists accounts (known ones and,
   * when the AD service account is set, the directory); Enter / click inserts "@username ".
   */
  function mentionInput(input, { onPick } = {}) {
    const box = el('div', { class: 'mention-pop', hidden: true, role: 'listbox' });
    document.body.append(box);
    let items = [], index = 0, start = -1, timer = null, seq = 0;
    const hide = () => { box.hidden = true; items = []; start = -1; };
    const place = () => {
      const r = input.getBoundingClientRect();
      box.style.left = `${r.left}px`;
      box.style.top = `${r.bottom + 4}px`;
      box.style.width = `${Math.min(340, r.width)}px`;
    };
    const paint = () => {
      box.replaceChildren(...items.map((p, i) => {
        const row = el('div', { class: 'mention-item' + (i === index ? ' active' : ''), role: 'option' },
          avatar(p, 24), el('span', { class: 'mention-text' }, el('strong', { text: nameOf(p) }), el('small', { text: `@${p.username}` + (p.department ? ` · ${p.department}` : '') })),
          p.relation ? el('em', { class: `mention-rel rel-${{ 上級: 'up', 下級: 'down', 同級: 'peer' }[p.relation] || 'x'}`, text: p.relation }) : null);
        row.addEventListener('mousedown', e => { e.preventDefault(); pick(i); });
        return row;
      }));
      box.hidden = !items.length;
      place();
    };
    const pick = i => {
      const p = items[i];
      if (!p) return;
      if (onPick) { input.value = ''; hide(); onPick(p); input.focus(); return; }   // picker mode
      const v = input.value, caret = input.selectionStart;
      input.value = v.slice(0, start) + '@' + p.username + ' ' + v.slice(caret);
      const pos = start + p.username.length + 2;
      input.setSelectionRange(pos, pos);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      hide();
      input.focus();
    };
    input.addEventListener('input', () => {
      const caret = input.selectionStart;
      let m;
      if (onPick) {                                 // picker mode: the whole box is the search text
        const whole = /^@?([A-Za-z0-9._\-\u3400-\u9fff]{1,30})$/.exec(input.value.slice(0, caret));
        m = whole ? [whole[0], '', whole[1]] : null;
      } else m = /(^|[^\w@])@([A-Za-z0-9._\-\u3400-\u9fff]{0,30})$/.exec(input.value.slice(0, caret));
      if (!m) return hide();
      start = caret - m[2].length - 1;
      const q = m[2];
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const my = ++seq;
        try {
          const res = await api('/api/people?q=' + encodeURIComponent(q));
          if (my !== seq) return;
          items = res; index = 0; paint();
        } catch { hide(); }
      }, 160);
    });
    input.addEventListener('keydown', e => {
      if (box.hidden) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); index = (index + 1) % items.length; paint(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); index = (index - 1 + items.length) % items.length; paint(); }
      else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); pick(index); }
      else if (e.key === 'Escape') { e.stopPropagation(); hide(); }
    }, true);
    input.addEventListener('blur', () => setTimeout(hide, 120));
    const obs = new MutationObserver(() => { if (!input.isConnected) { box.remove(); obs.disconnect(); } });
    obs.observe(document.body, { childList: true, subtree: true });
    return input;
  }

  return {
    me, userMenu, avatar, nameOf, mentionInput, ROLE,
    onInstallable, installApp, installed, syncThemeColor,
    langButton, store, api, esc, el, svg, tile, tagHue, isIconFile, iconUrl, initials, hostOf, toast, applyAppearance, cycleTheme, themePref,
    togglePerf, setFavicon, isLinkDrag, readDroppedLink, guessIcon, nameFromUrl,
    isProgram, isFileDrag, programPath, looksLikePath, localStatus, launchProgram, inspectDroppedFile, fetchSiteIcon,
  };
})();
