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
    TTI18n.site(b.language || 'zh-TW');
    document.querySelector('.login-card')?.append(TT.langButton('btn btn-ghost btn-sm login-lang'));
    TT.applyAppearance(b);
    document.title = _t("登入 · {0}", b.site_title || 'Tool Table');
    $('login-title').textContent = b.site_title || 'Tool Table';
    $('login-mark').replaceChildren(tile({ icon: b.favicon || '', name: b.site_title || 'T', size: 48 }));
    $('login-dash').hidden = b.public_dashboard === false;
  } catch { /* defaults */ }
  try {
    const st = await api('/api/auth/status');
    if (!st.auth) { location.replace(nextUrl); return; }
    $('login-hint').innerHTML = st.ldap
      ? _t("用 Windows / AD 帳號密碼登入（也可以輸入 <code>網域\\帳號</code> 或 <code>帳號@網域</code>）。")
      : _t("尚未設定 AD 連線，目前只能用本機管理員帳號 <code>{0}</code> 登入。", TT.esc(st.local_admin));
  } catch { /* ignore */ }

  // The local admin's generated password must be replaced on first sign-in
  function changePasswordStep(current) {
    const old = $('login-form');
    const card = old.cloneNode(false);              // fresh element: drops the sign-in submit handler
    old.replaceWith(card);
    const cur = el('input', { class: 'input', type: 'password', autocomplete: 'current-password' });
    const nw = el('input', { class: 'input', type: 'password', autocomplete: 'new-password', placeholder: _t('至少 12 個字元') });
    const nw2 = el('input', { class: 'input', type: 'password', autocomplete: 'new-password' });
    if (current) cur.value = current;
    const err = el('p', { class: 'login-error', hidden: true });
    const btn = el('button', { class: 'btn btn-primary login-btn', type: 'submit', text: _t('設定新密碼並繼續') });
    const field = (t, i) => el('label', { class: 'field' }, el('span', { class: 'field-label', text: t }), i);
    card.replaceChildren(
      el('div', { class: 'login-brand' }, el('div', {}, el('h1', { text: _t('設定新密碼') }), el('p', { text: _t('這是安裝時產生的密碼，第一次登入請換成你自己的。') }))),
      current ? null : field(_t('目前的密碼'), cur), field(_t('新密碼'), nw), field(_t('再輸入一次'), nw2), err, btn);
    setTimeout(() => (current ? nw : cur).focus(), 30);
    card.onsubmit = async e => {
      e.preventDefault();
      err.hidden = true;
      if (nw.value !== nw2.value) { err.textContent = _t('兩次輸入的新密碼不一樣'); err.hidden = false; return; }
      btn.disabled = true;
      try {
        await api('/api/auth/password', { method: 'POST', body: { current: cur.value, new: nw.value } });
        location.replace(nextUrl);
      } catch (ex) { err.textContent = ex.message; err.hidden = false; btn.disabled = false; }
    };
  }
  if (new URLSearchParams(location.search).get('change') === '1') {
    try { const m = await api('/api/auth/me'); if (m.user?.must_change_password) { changePasswordStep(''); return; } } catch { /* not signed in */ }
  }

  const form = $('login-form');
  const err = $('login-error');
  const btn = $('login-btn');
  setTimeout(() => $('username').focus(), 50);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    err.hidden = true;
    const username = $('username').value.trim();
    const password = $('password').value;
    if (!username || !password) { err.textContent = _t('請輸入帳號與密碼'); err.hidden = false; return; }
    btn.disabled = true;
    btn.textContent = _t('登入中…');
    try {
      const r = await api('/api/auth/login', { method: 'POST', body: { username, password } });
      if (r.user?.must_change_password) { changePasswordStep(password); return; }
      location.replace(nextUrl);
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
      $('password').select();
      btn.disabled = false;
      btn.textContent = _t('登入');
    }
  });
})();
