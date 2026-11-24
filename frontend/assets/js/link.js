/* IPMS — approve a standalone copy's link to my account (opened from the copy; sign-in required) */
'use strict';
(async () => {
  const { api, el, svg } = TT;
  const card = document.getElementById('link-card');
  const code = new URLSearchParams(location.search).get('code') || '';
  try { const b = await api('/api/public/branding'); TTI18n.site(b.language || 'zh-TW'); TT.applyAppearance(b); } catch { /* defaults */ }
  const head = (title, text) => el('div', { class: 'login-brand' }, el('div', {}, el('h1', { text: title }), el('p', { text })));
  const done = (title, text) => card.replaceChildren(head(title, text), el('a', { class: 'btn login-btn', href: '/', text: _t('回到入口') }));
  let me, req;
  try {
    me = await TT.me();
    req = await api('/api/sync/link/request?code=' + encodeURIComponent(code));
  } catch (e) { done(_t('無法連結'), e.message); return; }
  if (req.approved || req.denied) { done(_t('連結單機版'), _t('這個連結代碼已經處理過了')); return; }
  const who = TT.nameOf(me.user);
  const allow = el('button', { class: 'btn btn-primary login-btn', type: 'button', html: svg('check') + _t('允許連結') });
  const deny = el('button', { class: 'btn btn-ghost', type: 'button', text: _t('拒絕') });
  card.replaceChildren(
    head(_t('連結單機版'), _t('有一台電腦要用你的帳號和伺服器同步。')),
    el('dl', { class: 'link-facts' },
      el('dt', { text: _t('電腦') }), el('dd', { text: req.name || '—' }),
      el('dt', { text: _t('來源 IP') }), el('dd', { text: req.ip || '—' }),
      el('dt', { text: _t('代碼') }), el('dd', { class: 'mono', text: code }),
      el('dt', { text: _t('帳號') }), el('dd', { text: who })),
    el('p', { class: 'login-hint', text: _t('請確認代碼和單機版上顯示的一樣。允許後，這台電腦的看板會以你的身分同步；不認得就按「拒絕」。') }),
    allow, deny);
  const send = async ok => {
    allow.disabled = deny.disabled = true;
    try {
      await api('/api/sync/link/approve', { method: 'POST', body: { code, allow: ok } });
      done(ok ? _t('已允許') : _t('已拒絕'), ok ? _t('回到單機版，幾秒內就會完成連線。這個分頁可以關閉。') : _t('這台電腦不會連結到你的帳號。'));
    } catch (e) { done(_t('無法連結'), e.message); }
  };
  allow.addEventListener('click', () => send(true));
  deny.addEventListener('click', () => send(false));
})();
