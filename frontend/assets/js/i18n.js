/* =============================================================================
   IPMS — languages (Traditional Chinese, English)
   The source text is Traditional Chinese; _t('中文', a, b) returns the English text from
   assets/i18n/en.js when English is on, with {0} {1} … filled in. Missing entries fall back
   to the Chinese. The language: the person's own choice (saved per account and in this
   browser) → the site default chosen by an administrator (Traditional Chinese unless set
   to English or to follow the browser).
   scripts/i18n.py check lists texts that still need a translation.
   ============================================================================= */
(() => {
  const LANGS = { 'zh-TW': '繁體中文', en: 'English' };
  const read = k => { try { const v = JSON.parse(localStorage.getItem('tt:' + k)); return LANGS[v] ? v : null; } catch { return null; } };
  const browser = () => {
    const list = (navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || 'zh-TW']).map(x => String(x).toLowerCase());
    return list.some(x => x.startsWith('zh')) || !list[0] ? 'zh-TW' : 'en';
  };
  // the site default: zh-TW unless an administrator chose English or "follow the browser"
  const siteRaw = (() => { try { return JSON.parse(localStorage.getItem('tt:lang-site')); } catch { return null; } })();
  const siteLang = siteRaw === 'auto' ? browser() : LANGS[siteRaw] ? siteRaw : 'zh-TW';
  const lang = read('lang') || siteLang;
  const DICT = lang === 'en' ? (window.TT_I18N_EN || {}) : {};
  const missing = new Set();
  function _t(key, ...args) {
    let s = key;
    if (lang === 'en' && key) {
      if (DICT[key] != null) s = DICT[key];
      else missing.add(key);
    }
    return args.length ? s.replace(/\{(\d+)\}/g, (m, i) => String(args[+i])) : s;
  }
  window._t = _t;
  window.TT_LANG = lang;
  window.TTI18n = {
    lang, LANGS, missing,
    /** Change the language and reload (persisted for this browser; the caller saves it to the account). */
    set(v, reload = true) { try { localStorage.setItem('tt:lang', JSON.stringify(v)); } catch { /* private mode */ } if (reload && v !== lang) location.reload(); },
    clear(reload = true) { try { localStorage.removeItem('tt:lang'); } catch { /* ignore */ } if (reload) location.reload(); },
    /** The site default chosen by an administrator (used when the person has not chosen). */
    site(v) {
      if (!LANGS[v] && v !== 'auto') v = 'zh-TW';
      try { localStorage.setItem('tt:lang-site', JSON.stringify(v)); } catch { /* ignore */ }
      if (!read('lang') && (v === 'auto' ? browser() : v) !== lang) location.reload();
    },
    /** Dates in the current language */
    locale: lang === 'en' ? 'en-US' : 'zh-TW',
  };
  document.documentElement.lang = lang === 'en' ? 'en' : 'zh-Hant-TW';
  // pages the browser opens directly (the Microsoft sign-in callback) learn the language from this cookie
  try { document.cookie = `tt_lang=${lang}; path=/; max-age=31536000; samesite=lax`; } catch { /* ignore */ }
  // the static text of the HTML pages
  if (lang === 'en') {
    const tr = s => { const k = s.trim(); return k && DICT[k] != null ? s.replace(k, DICT[k]) : s; };
    document.title = tr(document.title);
    const walk = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_TEXT);
    for (let n = walk.nextNode(); n; n = walk.nextNode()) if (/[一-鿿]/.test(n.nodeValue)) n.nodeValue = tr(n.nodeValue);
    document.querySelectorAll('[title],[placeholder],[aria-label],[alt]').forEach(e => {
      for (const a of ['title', 'placeholder', 'aria-label', 'alt']) { const v = e.getAttribute(a); if (v && /[一-鿿]/.test(v)) e.setAttribute(a, tr(v)); }
    });
  }
})();
