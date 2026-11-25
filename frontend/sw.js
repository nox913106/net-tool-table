/* IPMS service worker — makes the portal installable as an app.
   Network first: the portal always shows the latest data; when the server cannot be
   reached the last copy of the pages, scripts and icons is shown instead.
   API responses are never cached. */
const CACHE = 'tool-table-v46';
const SHELL = ['/', '/admin', '/assets/css/base.css', '/assets/css/portal.css', '/assets/css/admin.css', '/assets/css/tactical.css',
  '/assets/js/profile.js', '/assets/i18n/en.js', '/assets/js/i18n.js', '/assets/js/common.js', '/assets/js/clock.js', '/assets/js/board.js', '/assets/js/radar.js', '/assets/js/gantt.js', '/assets/js/projects.js', '/assets/js/help-zh.js', '/assets/js/help-en.js', '/assets/js/help.js', '/assets/js/portal.js', '/assets/js/sync.js', '/assets/js/admin.js',
  '/assets/app/icon-192.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {}).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  e.respondWith((async () => {
    try {
      const res = await fetch(req);
      if (res.ok && res.type === 'basic') {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
      }
      return res;
    } catch (err) {
      const hit = await caches.match(req, { ignoreSearch: req.mode === 'navigate' });
      if (hit) return hit;
      if (req.mode === 'navigate') return (await caches.match(url.pathname.startsWith('/admin') ? '/admin' : '/')) || Response.error();
      throw err;
    }
  })());
});
