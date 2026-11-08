/* Tool Table — sign-in page */
'use strict';
(async () => {
  const $ = id => document.getElementById(id);
  const { api, el, tile, svg } = TT;
  const nextUrl = (() => {                     // same-origin paths only (no //host, /\host, javascript:)
    const n = new URLSearchParams(location.search).get('next') || '/';
    try {
      const u = new URL(n, location.origin);
      return /^\/(?![\/\\])/.test(n) && u.origin === location.origin ? u.pathname + u.search + u.hash : '/';
    } catch { return '/'; }
  })();

  try {
    const b = await api('/api/public/branding');
    TT.applyAppearance(b);
    document.title = `登入 · ${b.site_title || 'Tool Table'}`;
    $('login-title').textContent = b.site_title || 'Tool Table';
    $('login-mark').replaceChildren(tile({ icon: b.favicon || '', name: b.site_title || 'T', size: 48 }));
    $('login-dash').hidden = b.public_dashboard === false;
  } catch { /* defaults */ }
  try {
    const st = await api('/api/auth/status');
    if (!st.auth) { location.replace(nextUrl); return; }
    $('login-hint').innerHTML = st.ldap
      ? `用 Windows / AD 帳號密碼登入（也可以輸入 <code>網域\\帳號</code> 或 <code>帳號@網域</code>）。`
      : `尚未設定 AD 連線，目前只能用本機管理員帳號 <code>${TT.esc(st.local_admin)}</code> 登入。`;
  } catch { /* ignore */ }

  const form = $('login-form');
  const err = $('login-error');
  const btn = $('login-btn');
  setTimeout(() => $('username').focus(), 50);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    err.hidden = true;
    const username = $('username').value.trim();
    const password = $('password').value;
    if (!username || !password) { err.textContent = '請輸入帳號與密碼'; err.hidden = false; return; }
    btn.disabled = true;
    btn.textContent = '登入中…';
    try {
      await api('/api/auth/login', { method: 'POST', body: { username, password } });
      location.replace(nextUrl);
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      $('password').select();
      btn.disabled = false;
      btn.textContent = '登入';
    }
  });
})();
