/* IPMS — public task dashboard (no login, read only, counts only)

   Views (all in the address, so a wall screen can be bookmarked):
     /dashboard                 總覽: every department
     /dashboard?dept=資訊部       鎖定一個部門 (department head)
     /dashboard?rotate=1        輪播: 總覽 → each department → … (the boss's screen); &sec=30 per page
     &tv=1                      wall screen: larger type, no buttons, cursor hidden when still */
'use strict';
(async () => {
  const $ = id => document.getElementById(id);
  const { api, el, svg, tile } = TT;
  const LABEL = {
    overdue: [_t('過期未結案'), '#e11d48'], new: [_t('新建'), '#64748b'], ongoing: [_t('進行中'), '#3b82f6'],
    pending: [_t('待確認'), '#f59e0b'], onhold: [_t('暫緩'), '#a855f7'], complete: [_t('完成'), '#10b981'],
    canceled: [_t('取消'), '#ef4444'],
  };
  // what "better" means for each count: fewer overdue is good, more complete is good
  const GOOD_DOWN = new Set(['overdue', 'pending', 'onhold']);
  const DUE = [['overdue', _t('已過到期日'), '#e11d48'], ['today', _t('今天到期'), '#f59e0b'], ['soon', _t('3 天內'), '#3b82f6'], ['week', _t('7 天內'), '#64748b']];
  const q = new URLSearchParams(location.search);
  const view = { dept: q.get('dept') || '', rotate: q.get('rotate') === '1', tv: q.get('tv') === '1', sec: parseInt(q.get('sec'), 10) || 0 };
  document.documentElement.classList.toggle('dash-tv', view.tv);

  let settings = {};
  try {
    settings = await api('/api/public/branding');
    TTI18n.site(settings.language || 'zh-TW');
    TT.applyAppearance(settings);
    $('dash-mark').replaceChildren(tile({ icon: settings.favicon || '', name: settings.site_title || 'T', size: 44 }));
  } catch { /* defaults */ }
  const siteTitle = settings.site_title || 'IPMS';
  $('dash-sub').textContent = _t('各部門、各帳號的卡片狀態統計（不含週期工作）');
  $('dash-login').textContent = _t('登入');
  $('dash-live').title = _t('每 15 秒自動更新');
  const themeBtn = $('theme-btn');
  const paintTheme = () => {
    const pref = TT.themePref(settings);
    themeBtn.innerHTML = svg(pref === 'auto' ? 'monitor' : pref === 'light' ? 'sun' : 'moon');
    themeBtn.title = _t('切換主題');
  };
  themeBtn.addEventListener('click', () => { TT.cycleTheme(settings); paintTheme(); });
  paintTheme();
  $('tv-btn').innerHTML = svg('maximize');
  $('tv-btn').title = _t('壁掛模式（全螢幕、放大字體）');
  $('tv-btn').addEventListener('click', () => {
    view.tv = !view.tv;
    document.documentElement.classList.toggle('dash-tv', view.tv);
    if (view.tv && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(() => {});
    if (!view.tv && document.fullscreenElement) document.exitFullscreen().catch(() => {});
    saveUrl();
  });
  try { const st = await api('/api/auth/status'); $('dash-login').hidden = !st.auth; } catch { $('dash-login').hidden = true; }

  // wall screen: hide the pointer when it rests
  let idle;
  document.addEventListener('mousemove', () => {
    document.documentElement.classList.remove('dash-idle');
    clearTimeout(idle);
    idle = setTimeout(() => view.tv && document.documentElement.classList.add('dash-idle'), 3000);
  });

  // header clock (wall screens)
  const pad = n => String(n).padStart(2, '0');
  const tickClock = () => { const t = new Date(); $('dash-clock').textContent = `${pad(t.getHours())}:${pad(t.getMinutes())}`; };
  tickClock();
  setInterval(tickClock, 10000);

  let data = null, version = null;
  let page = 0;                                   // rotation: 0 = 總覽, 1… = departments
  let paused = false, timer = null, started = 0;

  const fmtDate = iso => { if (!iso) return ''; const [, m, d] = iso.split('-'); return `${+m}/${+d}`; };
  const deptOf = name => data.departments.find(d => d.department === name);

  function saveUrl() {
    const p = new URLSearchParams();
    if (view.rotate) p.set('rotate', '1');
    else if (view.dept) p.set('dept', view.dept);
    if (view.sec) p.set('sec', view.sec);
    if (view.tv) p.set('tv', '1');
    history.replaceState(null, '', '/dashboard' + (p.toString() ? '?' + p : ''));
  }

  // ------------------------------------------------------------ controls
  function paintControls() {
    const depts = data ? data.departments : [];
    const mode = view.rotate ? 'rotate' : view.dept ? 'dept' : 'all';
    const seg = (v, icon, text, title) => {
      const b = el('button', { type: 'button', 'aria-pressed': String(mode === v), title, html: svg(icon) + `<span>${TT.esc(text)}</span>` });
      b.addEventListener('click', () => setMode(v));
      return b;
    };
    const sel = el('select', { class: 'input dash-dept-sel' + (mode === 'dept' ? ' is-locked' : ''), 'aria-label': _t('鎖定部門'), title: _t('只顯示一個部門（部門主管模式）') },
      el('option', { value: '', text: mode === 'dept' ? _t('解除鎖定') : _t('鎖定部門…') }),
      ...depts.map(d => el('option', { value: d.department, text: (mode === 'dept' && d.department === view.dept ? '🔒 ' : '') + d.label, selected: d.department === view.dept && !view.rotate })));
    sel.addEventListener('change', () => { if (sel.value) { view.dept = sel.value; view.rotate = false; apply(); } else setMode('all'); });
    $('dash-controls').replaceChildren(
      el('div', { class: 'segmented dash-seg', role: 'group' },
        seg('all', 'grid', _t('總覽'), _t('所有部門')),
        seg('rotate', 'play', _t('輪播'), _t('總覽與各部門輪流顯示（大老闆模式）'))),
      sel);
  }

  function setMode(m) {
    if (m === 'all') { view.rotate = false; view.dept = ''; }
    if (m === 'rotate') { view.rotate = true; view.dept = ''; page = 0; paused = false; }
    apply();
  }

  function apply() {
    saveUrl();
    paintControls();
    if (view.rotate) startRotation(); else stopRotation();
    render();
  }

  // ------------------------------------------------------------ rotation (大老闆模式)
  const pages = () => [null, ...data.departments.map(d => d.department)];
  const seconds = () => view.sec || data?.rotate_seconds || settings.dashboard_rotate_seconds || 20;
  function startRotation() {
    stopRotation();
    started = Date.now();
    timer = setInterval(() => {
      if (paused || !data) return paintRotor();
      if (Date.now() - started >= seconds() * 1000) { step(1); return; }
      paintRotor();
    }, 250);
    paintRotor();
  }
  function stopRotation() { clearInterval(timer); timer = null; $('dash-rotor').hidden = true; }
  function step(d) {
    const n = pages().length;
    page = (page + d + n) % n;
    started = Date.now();
    render(true);
    paintRotor();
  }
  function paintRotor() {
    const r = $('dash-rotor');
    if (!view.rotate || !data) { r.hidden = true; return; }
    const list = pages();
    if (page >= list.length) page = 0;
    const left = Math.max(0, seconds() - (Date.now() - started) / 1000);
    const name = i => list[i] === null ? _t('總覽') : deptOf(list[i])?.label || list[i];
    const btn = (icon, title, fn) => { const b = el('button', { class: 'icon-btn', type: 'button', title, html: svg(icon) }); b.addEventListener('click', fn); return b; };
    r.hidden = false;
    r.replaceChildren(
      el('div', { class: 'dash-rotor-bar', style: { width: `${paused ? 100 : 100 - left / seconds() * 100}%` } }),
      el('div', { class: 'dash-rotor-row' },
        btn('chevron-left', _t('上一個'), () => step(-1)),
        btn(paused ? 'play' : 'pause', paused ? _t('繼續輪播') : _t('暫停'), () => { paused = !paused; started = Date.now(); paintRotor(); }),
        btn('chevron-right', _t('下一個'), () => step(1)),
        el('span', { class: 'dash-rotor-pages' }, ...list.map((p, i) => {
          const b = el('button', { type: 'button', class: 'dash-rotor-dot' + (i === page ? ' on' : ''), text: name(i) });
          b.addEventListener('click', () => { page = i; started = Date.now(); render(true); paintRotor(); });
          return b;
        })),
        el('span', { class: 'dash-rotor-left', text: paused ? _t('已暫停') : _t("{0} 秒後：{1}", Math.ceil(left), name((page + 1) % list.length)) })));
  }
  document.addEventListener('keydown', e => {
    if (!view.rotate || e.target.closest('input, select, textarea')) return;
    if (e.key === 'ArrowRight') step(1);
    else if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === ' ') { e.preventDefault(); paused = !paused; started = Date.now(); paintRotor(); }
  });

  // ------------------------------------------------------------ pieces
  function sparkline(values, color) {
    const pts = values.map((v, i) => [i, v]).filter(p => p[1] !== null && p[1] !== undefined);
    if (pts.length < 2) return el('span', { class: 'dash-spark-none', text: _t('趨勢累積中') });
    const W = 120, H = 34, max = Math.max(1, ...pts.map(p => p[1])), n = values.length - 1;
    const xy = pts.map(([i, v]) => `${(i / n * W).toFixed(1)},${(H - 3 - v / max * (H - 6)).toFixed(1)}`);
    const last = xy[xy.length - 1].split(',');
    const s = `<svg viewBox="0 0 ${W} ${H}" class="dash-spark" preserveAspectRatio="none" aria-hidden="true">
      <polyline points="${xy[0].split(',')[0]},${H} ${xy.join(' ')} ${last[0]},${H}" fill="${color}" fill-opacity=".12" stroke="none"/>
      <polyline points="${xy.join(' ')}" fill="none" stroke="${color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>
      <circle cx="${last[0]}" cy="${last[1]}" r="2.6" fill="${color}"/></svg>`;
    return el('span', { class: 'dash-spark-wrap', html: s });
  }

  function delta(values, status) {
    const pts = values.filter(v => v !== null && v !== undefined);
    if (pts.length < 2) return null;
    const d = pts[pts.length - 1] - pts[pts.length - 2];
    if (!d) return el('span', { class: 'dash-delta flat', text: _t('與上週持平') });
    const good = GOOD_DOWN.has(status) ? d < 0 : status === 'complete' ? d > 0 : null;
    return el('span', { class: 'dash-delta ' + (good === null ? 'flat' : good ? 'good' : 'bad'),
      text: (d > 0 ? '▲ ' : '▼ ') + _t("比上週 {0}", (d > 0 ? '+' : '') + d) });
  }

  function tiles(totals, trend) {
    return el('section', { class: 'dash-totals' }, ...data.statuses.map(s => {
      const t = trend ? trend[s] : null;
      return el('div', { class: 'dash-total', style: { '--st': LABEL[s][1] } },
        el('div', { class: 'dash-total-top' },
          el('span', { class: 'dash-total-n', text: totals[s] }),
          el('span', { class: 'dash-total-l', text: LABEL[s][0] })),
        t ? sparkline(t, LABEL[s][1]) : el('span', { class: 'dash-spark-none', text: _t('趨勢累積中') }),
        t ? delta(t, s) : null);
    }));
  }

  const panel = (cls, icon, title, extra, ...body) => el('section', { class: 'dash-panel glass ' + cls },
    el('header', {}, el('h2', { html: svg(icon) + TT.esc(title) }), extra || ''), ...body);
  const empty = text => el('div', { class: 'dash-empty', text });

  function duePanel(dep) {
    const sums = dep ? dep.due : data.due;
    const big = el('div', { class: 'dash-due-big' }, ...DUE.map(([k, t, c]) =>
      el('div', { class: 'dash-due-n' + (sums[k] ? '' : ' zero'), style: { '--st': c } }, el('strong', { text: sums[k] }), el('span', { text: t }))));
    // rows: departments on the overview, people inside a department
    const rows = dep ? dep.people.filter(p => DUE.some(([k]) => p.due[k])).map(p => [p.name, p.due])
      : data.departments.filter(d => DUE.some(([k]) => d.due[k])).map(d => [d.label, d.due]);
    const max = Math.max(1, ...rows.map(([, d]) => DUE.reduce((a, [k]) => a + d[k], 0)));
    const list = rows.length ? el('div', { class: 'dash-due-rows' }, ...rows.map(([name, d]) => {
      const sum = DUE.reduce((a, [k]) => a + d[k], 0);
      return el('div', { class: 'dash-due-row' },
        el('span', { class: 'dash-due-name', text: name, title: name }),
        el('span', { class: 'dash-bar', style: { '--w': `${sum / max * 100}%` } },
          ...DUE.filter(([k]) => d[k]).map(([k, t, c]) => el('i', { style: { flex: d[k], background: c }, title: `${t} ${d[k]}` }))),
        el('span', { class: 'dash-due-sum', text: sum }));
    })) : empty(_t('7 天內沒有到期的工作'));
    return panel('dash-due', 'calendar', _t('到期'), el('span', { class: 'muted', text: _t('未完成的卡片與子任務') }), big, list);
  }

  function projectsPanel(dep) {
    if (!data.projects) return null;
    const list = dep ? data.projects.filter(p => p.depts.includes(dep.department)) : data.projects;
    const body = list.length ? el('div', { class: 'dash-projects' }, ...list.map(p => {
      const late = p.slip > 0;
      return el('div', { class: 'dash-project' + (late ? ' is-late' : '') },
        el('div', { class: 'dash-project-head' },
          el('strong', { text: p.label }),
          el('span', { class: 'dash-chip ' + (late ? 'bad' : 'good'), text: late ? _t("落後 {0} 天", p.slip) : p.slip === null ? _t('未設基準線') : _t('準時') }),
          p.problems ? el('span', { class: 'dash-chip warn', text: _t("{0} 項問題", p.problems) }) : null),
        el('div', { class: 'dash-progress' }, el('i', { style: { width: p.pct + '%' } }), el('span', { text: p.pct + '%' })),
        el('div', { class: 'dash-project-meta' },
          p.next_due ? el('span', { text: _t("下個里程碑 {0}", fmtDate(p.next_due)) + (p.next ? ` · ${p.next}` : '') }) : null,
          p.due ? el('span', { text: _t("預計完成 {0}", fmtDate(p.due)) }) : null,
          el('span', { text: _t("{0} 項未完成", p.open) }),
          !dep ? el('span', { class: 'dash-project-depts', text: p.depts.map(d => deptOf(d)?.label || d).join('、') }) : null));
    })) : empty(dep ? _t('這個部門沒有進行中的專案') : _t('沒有進行中的專案'));
    return panel('dash-proj', 'flag', _t('專案進度'), data.project_mode === 'anon' ? el('span', { class: 'muted', text: _t('專案名稱已隱藏') }) : null, body);
  }

  function deptCard(dep, wide) {
    const max = Math.max(1, ...dep.people.map(p => p.total));
    const legend = el('div', { class: 'dash-legend' }, ...data.statuses.filter(s => dep.totals[s]).map(s =>
      el('span', { style: { '--st': LABEL[s][1] } }, el('i'), `${LABEL[s][0]} ${dep.totals[s]}`)));
    const rows = dep.people.length ? dep.people.map(p => el('div', { class: 'dash-person' + (p.active ? '' : ' is-off') },
      el('span', { class: 'dash-who' }, TT.avatar({ name: p.name, username: p.name }, wide ? 30 : 26), el('span', { text: p.name, title: p.name })),
      el('span', { class: 'dash-bar', style: { '--w': `${p.total / max * 100}%` },
        title: data.statuses.filter(s => p.counts[s]).map(s => `${LABEL[s][0]} ${p.counts[s]}`).join('\n') },
        ...data.statuses.filter(s => p.counts[s]).map(s => el('i', { style: { flex: p.counts[s], background: LABEL[s][1] } },
          wide && p.counts[s] / max > 0.08 ? el('b', { text: p.counts[s] }) : null))),
      el('span', { class: 'dash-person-n', text: p.total }),
      p.due.overdue ? el('span', { class: 'dash-chip bad', title: _t('逾期的卡片與子任務'), text: _t("逾期 {0}", p.due.overdue) }) : el('span'))) : [empty(_t('目前沒有卡片'))];
    const head = el('header', {},
      el('h2', { text: dep.label }),
      el('span', { class: 'badge', text: _t("{0} 人 · {1} 張", dep.people.length, dep.total) }));
    if (!wide && !view.tv) {
      const lock = el('button', { class: 'icon-btn dash-lock', type: 'button', title: _t("只看「{0}」", dep.label), html: svg('lock') });
      lock.addEventListener('click', () => { view.dept = dep.department; view.rotate = false; apply(); });
      head.append(lock);
    }
    return el('article', { class: 'dash-dept glass' + (wide ? ' is-wide' : '') }, head, legend, el('div', { class: 'dash-people' }, ...rows));
  }

  function loadPanel(dep) {
    if (!data.load) return null;
    const rows = data.load.people.filter(r => !dep || r.dept === dep.department);
    const w0 = new Date(data.load.week0 + 'T00:00');
    const weeks = Array.from({ length: 6 }, (_, i) => { const d = new Date(w0); d.setDate(d.getDate() + i * 7); return `${d.getMonth() + 1}/${d.getDate()}`; });
    const lim = data.load.limit;
    const cell = h => {
      const r = h / lim;
      const lvl = h === 0 ? 0 : r > 1 ? 4 : r > 0.8 ? 3 : r > 0.4 ? 2 : 1;
      return el('td', { class: 'dash-heat l' + lvl, title: _t("{0} 小時（上限 {1}）", h, lim) }, h ? el('span', { text: h % 1 ? h.toFixed(1) : h }) : '');
    };
    const body = rows.length ? el('div', { class: 'dash-heat-wrap' }, el('table', { class: 'dash-heat-table' },
      el('thead', {}, el('tr', {}, el('th', { text: _t('人員') }), ...weeks.map((w, i) => el('th', { text: i ? w : _t('本週') })))),
      el('tbody', {}, ...rows.map(r => el('tr', { class: r.over ? 'is-over' : '' },
        el('th', {}, el('span', { text: r.name }), !dep ? el('small', { text: deptOf(r.dept)?.label || r.dept }) : null),
        ...r.hours.map(cell)))))) : empty(_t('未來 6 週沒有排定到期的工作'));
    return panel('dash-load', 'users', _t('人員負載（預估工時，依到期週）'),
      el('span', { class: 'dash-heat-key' }, _t("上限 {0} 小時／週", lim), ...[1, 2, 3, 4].map(l => el('i', { class: 'dash-heat l' + l }))), body);
  }

  function healthPanel() {
    if (!data.health) return null;
    const txt = { ok: _t('正常'), warn: _t('注意'), fail: _t('異常') };
    return panel('dash-health', 'monitor', _t('系統狀態'), null,
      data.health.length ? el('div', { class: 'dash-lights' }, ...data.health.map(h =>
        el('div', { class: 'dash-light ' + h.level }, el('i'), el('span', { text: h.group }), el('small', { text: txt[h.level] || h.level })))) : empty(_t('沒有檢查項目')));
  }

  // ------------------------------------------------------------ page
  function currentDept() {
    if (view.rotate) { const p = pages()[page]; return p === null ? null : deptOf(p); }
    return view.dept ? deptOf(view.dept) || null : null;
  }

  function render(animate) {
    if (!data) return;
    const dep = currentDept();
    if (view.dept && !view.rotate && !dep) {             // locked to a department that has nothing (yet)
      $('dash-title').textContent = _t("{0} · {1}", siteTitle, view.dept);
      $('dash-main').replaceChildren(empty(_t("「{0}」目前沒有任何卡片", view.dept)));
      return;
    }
    $('dash-title').textContent = dep ? _t("{0} · {1}", siteTitle, dep.label) : _t("{0} · 任務進度", siteTitle);
    document.title = dep ? `${dep.label} · ${siteTitle}` : _t("任務進度 · {0}", siteTitle);
    const totals = dep ? dep.totals : data.totals;
    const trend = dep ? dep.trend : data.trend.all;
    const main = $('dash-main');
    const parts = [tiles(totals, trend)];
    const proj = projectsPanel(dep);
    parts.push(el('div', { class: 'dash-row2' + (proj ? '' : ' one') }, duePanel(dep), proj));
    if (dep) parts.push(deptCard(dep, true));
    else if (!data.departments.length) parts.push(empty(_t('目前沒有任何卡片')));
    else {
      const grid = el('section', { class: 'dash-grid' + (data.departments.length === 1 ? ' one' : '') }, ...data.departments.map(d => deptCard(d, data.departments.length === 1)));
      parts.push(grid);
    }
    const load = loadPanel(dep), health = healthPanel();
    if (load || health) parts.push(el('div', { class: 'dash-row3' + (load && health ? '' : ' one') }, load, health));
    main.replaceChildren(...parts);
    if (animate) { main.classList.remove('dash-swap'); void main.offsetWidth; main.classList.add('dash-swap'); }
  }

  async function refresh() {
    try {
      const d = await api('/api/public/dashboard');
      $('dash-live').classList.remove('is-error');
      const t = new Date();
      $('dash-time').textContent = _t("更新於 {0}:{1}:{2}", pad(t.getHours()), pad(t.getMinutes()), pad(t.getSeconds()));
      if (d.version === version) return;           // nothing changed: keep the page still
      const first = !data;
      version = d.version;
      data = d;
      if (first) apply(); else { paintControls(); render(); }
    } catch (e) {
      $('dash-live').classList.add('is-error');
      $('dash-time').textContent = e.message.includes('關閉') || e.message.includes('closed') ? _t('公開看板已關閉') : _t('連線中斷，稍後重試');
      if (e.message.includes('關閉') || e.message.includes('closed')) {
        $('dash-main').replaceChildren(el('div', { class: 'empty' }, el('div', { class: 'empty-icon', text: '🔒' }), el('h3', { text: _t('公開進度看板已被管理員關閉') })));
      }
    }
  }
  refresh();
  setInterval(refresh, 15000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
})();
