/* =============================================================================
   IPMS — the person's profile (loaded before everything else on every page)
   Favorites, recently opened, sidebar / board / Gantt / radar choices, export format, language …
   are kept on the server under the account — never in the browser — so they follow the person to
   any computer. The standalone copy keeps its own and syncs it with the linked account.
   Read once, synchronously, before the other scripts run (they read it while starting up);
   changes are sent a moment later, and on leaving the page.
   Someone not signed in (the sign-in page, the public dashboard) has no profile: choices last
   for the page only (the language goes in the tt_lang cookie the server reads anyway).
   ============================================================================= */
(() => {
  let data = { prefs: {}, site_lang: 'zh-TW', account: false };
  try {
    const x = new XMLHttpRequest();
    x.open('GET', '/api/profile', false);           // synchronous: the page's scripts need it to start
    x.send();
    if (x.status === 200) data = JSON.parse(x.responseText);
  } catch { /* offline page from the service worker: defaults */ }
  const prefs = data.prefs || {};
  const cookie = k => (document.cookie.split('; ').find(c => c.startsWith(k + '=')) || '').split('=')[1] || null;
  if (!data.account && cookie('tt_lang') && !prefs.lang) prefs.lang = decodeURIComponent(cookie('tt_lang'));

  // what earlier versions kept in this browser moves to the account once, then the browser copy goes
  try {
    const old = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('tt:') && k !== 'tt:lang-site') {
        try { old[k.slice(3)] = JSON.parse(localStorage.getItem(k)); } catch { /* not JSON */ }
      }
    }
    if (data.account) {
      const up = {};
      for (const [k, v] of Object.entries(old)) if (!(k in prefs) && /^[a-z0-9][a-z0-9:_.-]{0,63}$/.test(k)) { up[k] = v; prefs[k] = v; }
      if (Object.keys(up).length) {
        const keys = Object.keys(up);
        for (let i = 0; i < keys.length; i += 100) {
          const part = Object.fromEntries(keys.slice(i, i + 100).map(k => [k, up[k]]));
          const x = new XMLHttpRequest();
          x.open('PUT', '/api/profile', false);
          x.setRequestHeader('Content-Type', 'application/json');
          x.setRequestHeader('X-Tool-Table', '1');
          x.send(JSON.stringify({ values: part }));
        }
      }
      Object.keys(localStorage).filter(k => k.startsWith('tt:')).forEach(k => localStorage.removeItem(k));
    }
  } catch { /* storage blocked */ }

  let queue = {}, timer = null;
  function send(keepalive = false) {
    clearTimeout(timer); timer = null;
    const values = queue; queue = {};
    if (!data.account || !Object.keys(values).length) return Promise.resolve();
    return fetch('/api/profile', { method: 'PUT', keepalive, headers: { 'Content-Type': 'application/json', 'X-Tool-Table': '1' },
      body: JSON.stringify({ values }) }).catch(() => { Object.assign(queue, values, queue); });   // offline: try again later
  }
  addEventListener('pagehide', () => send(true));
  document.addEventListener('visibilitychange', () => { if (document.hidden) send(true); });

  // standalone copy: say this page is open, so the program stops by itself when its window is closed
  if (data.presence) {
    const page = Math.random().toString(36).slice(2, 12);
    const say = (bye = false) => fetch('/api/local/presence', { method: 'POST', keepalive: bye,
      headers: { 'Content-Type': 'application/json', 'X-Tool-Table': '1' }, body: JSON.stringify({ page, bye }) }).catch(() => {});
    say();
    setInterval(say, 20000);
    addEventListener('pagehide', () => say(true));                 // closed, or kept in the back/forward cache

    addEventListener('pageshow', e => { if (e.persisted) say(); });
  }

  window.TTProfile = {
    account: !!data.account,
    siteLang: data.site_lang || 'zh-TW',
    get(key, fallback = null) { return key in prefs ? prefs[key] : fallback; },
    set(key, value) {
      if (value === undefined) value = null;
      if (JSON.stringify(prefs[key]) === JSON.stringify(value)) return;
      if (value === null) delete prefs[key]; else prefs[key] = value;
      if (key === 'lang' && !data.account) {         // no account: the language lives in the cookie the server reads
        document.cookie = value ? `tt_lang=${value}; path=/; max-age=31536000; samesite=lax` : 'tt_lang=; path=/; max-age=0';
        return;
      }
      queue[key] = value;
      clearTimeout(timer);
      timer = setTimeout(send, 400);
    },
    remove(key) { this.set(key, null); },
    /** Send what is waiting now (before a reload). */
    flush() { return send(); },
  };
})();
