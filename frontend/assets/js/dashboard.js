/* IPMS — public task dashboard (no login, read only, counts only) */
'use strict';
(async () => {
  const $ = id => document.getElementById(id);
  const { api, el, svg, tile } = TT;
  const LABEL = {
    overdue: ['Overdue', _t('過期未結案'), '#e11d48'], new: ['New', _t('新建'), '#64748b'], ongoing: ['On going', _t('進行中'), '#3b82f6'],
    pending: ['Pending', _t('待確認'), '#f59e0b'], onhold: ['On hold', _t('暫緩'), '#a855f7'], complete: ['Complete', _t('完成'), '#10b981'],
    canceled: ['Canceled', _t('取消'), '#ef4444'],
  };
  let settings = {};
  try {
    settings = await api('/api/public/branding');
    TTI18n.site(settings.language || 'zh-TW');
    TT.applyAppearance(settings);
    $('dash-mark').replaceChildren(tile({ icon: settings.favicon || '', name: settings.site_title || 'T', size: 44 }));
    $('dash-title').textContent = _t("{0} · 任務進度", settings.site_title || 'IPMS');
    document.title = _t("任務進度 · {0}", settings.site_title || 'IPMS');
  } catch { /* defaults */ }
  const themeBtn = $('theme-btn');
  const paintTheme = () => {
    const pref = TT.themePref(settings);
    themeBtn.innerHTML = svg(pref === 'auto' ? 'monitor' : pref === 'light' ? 'sun' : 'moon');
    themeBtn.title = _t('切換主題');
  };
  themeBtn.addEventListener('click', () => { TT.cycleTheme(settings); paintTheme(); });
  paintTheme();
  try { const st = await api('/api/auth/status'); $('dash-login').hidden = !st.auth; } catch { $('dash-login').hidden = true; }

  let version = null;
  const n = v => el('span', { class: 'dash-n' + (v ? '' : ' zero'), text: v });

  function render(d) {
    const shown = d.statuses;
    $('dash-totals').replaceChildren(...shown.map(s => el('div', { class: 'dash-total', style: { '--st': LABEL[s][2] } },
      el('span', { class: 'dash-total-n', text: d.totals[s] }),
      el('span', { class: 'dash-total-l' }, el('strong', { text: LABEL[s][0] }), el('small', { text: LABEL[s][1] })))));
    if (!d.departments.length) {
      $('dash-grid').replaceChildren(el('div', { class: 'empty' }, el('div', { class: 'empty-icon', text: '📋' }), el('h3', { text: _t('目前沒有任何卡片') })));
      return;
    }
    $('dash-grid').replaceChildren(...d.departments.map(dep => el('article', { class: 'dash-dept glass' },
      el('header', {}, el('h2', { text: dep.department }), el('span', { class: 'badge', text: _t("{0} 人 · {1} 張", dep.people.length, dep.total) })),
      el('div', { class: 'dash-table', style: { '--cols': shown.length } },
        el('div', { class: 'dash-row dash-th' }, el('span', { text: _t('帳號') }),
          ...shown.map(s => el('span', { class: 'dash-st', title: LABEL[s][1], style: { '--st': LABEL[s][2] } }, el('i'), LABEL[s][1]))),
        ...dep.people.map(p => el('div', { class: 'dash-row' + (p.active ? '' : ' is-off') },
          el('span', { class: 'dash-who' }, TT.avatar({ name: p.name, username: p.name }, 26), el('span', { text: p.name })),
          ...shown.map(s => el('span', { class: 'dash-cell', style: { '--st': LABEL[s][2] } }, n(p.counts[s]))))),
        el('div', { class: 'dash-row dash-sum' }, el('span', { text: _t('小計') }),
          ...shown.map(s => el('span', { class: 'dash-cell', style: { '--st': LABEL[s][2] } }, n(dep.totals[s]))))))));
  }

  async function refresh() {
    try {
      const d = await api('/api/public/dashboard');
      $('dash-live').classList.remove('is-error');
      const t = new Date();
      $('dash-time').textContent = _t("更新於 {0}:{1}:{2}", String(t.getHours()).padStart(2, '0'), String(t.getMinutes()).padStart(2, '0'), String(t.getSeconds()).padStart(2, '0'));
      if (d.version === version) return;           // nothing changed: keep the page still
      version = d.version;
      render(d);
    } catch (e) {
      $('dash-live').classList.add('is-error');
      $('dash-time').textContent = e.message.includes('關閉') ? _t('公開看板已關閉') : _t('連線中斷，稍後重試');
      if (e.message.includes('關閉')) $('dash-grid').replaceChildren(el('div', { class: 'empty' }, el('div', { class: 'empty-icon', text: '🔒' }), el('h3', { text: _t('公開進度看板已被管理員關閉') })));
    }
  }
  refresh();
  setInterval(refresh, 15000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
})();
