/* =============================================================================
   Tool Table — live updates and server sync
   Both editions: the board refreshes as soon as anything changes (long poll on
   /api/sync/wait), so edits by other people — or arriving from a standalone copy —
   show up at once.
   Standalone copy (portable edition): a header pill shows the sync state
   (已同步 / 同步中 / 離線 · N 筆待同步 / 衝突) and opens a panel to link this
   computer to a server, sync now, and settle conflicts (both versions are kept
   until someone picks one).
   ============================================================================= */
(() => {
  const { el, svg, api, toast } = TT;
  let st = null;
  let pill = null;
  let panel = null;

  // --------------------------------------------------------------- live board refresh
  async function watch() {
    let since = -1, timer = null, fails = 0;
    for (;;) {
      try {
        const r = await api('/api/sync/wait?since=' + since);
        fails = 0;
        if (since >= 0 && r.seq > since && window.TTBoard) {
          clearTimeout(timer);
          timer = setTimeout(() => TTBoard.refresh && TTBoard.refresh(), 600);      // a burst of changes → one reload
          if (panel && panel.isConnected) refreshStatus();
        }
        since = r.seq;
      } catch {
        fails += 1;
        await new Promise(res => setTimeout(res, Math.min(30000, 2000 * fails)));
      }
      if (document.hidden) await new Promise(res => document.addEventListener('visibilitychange', res, { once: true }));
    }
  }

  // --------------------------------------------------------------- status pill (standalone copy)
  const ago = s => {
    if (!s) return '尚未同步';
    const d = Math.max(0, Math.round(Date.now() / 1000 - s));
    return d < 10 ? '剛剛' : d < 60 ? `${d} 秒前` : d < 3600 ? `${Math.round(d / 60)} 分鐘前` : new Date(s * 1000).toLocaleString('zh-TW', { hour12: false });
  };

  function look(s) {
    if (!s.linked) return { cls: 'is-local', text: '單機', title: '尚未連線到伺服器：點這裡設定同步' };
    if (s.syncing) return { cls: 'is-busy', text: '同步中…', title: '正在與伺服器同步' };
    if (s.online === false) return { cls: 'is-off', text: s.pending ? `離線 · ${s.pending} 筆待同步` : '離線', title: (s.error || '連不到伺服器') + '\n恢復連線後會自動送出' };
    if (s.error) return { cls: 'is-err', text: '同步錯誤', title: s.error };
    if (s.pending) return { cls: 'is-busy', text: `${s.pending} 筆待同步`, title: '稍後自動送出' };
    return { cls: 'is-ok', text: '已同步', title: `已與 ${s.server} 同步（${ago(s.last_ok)}）` };
  }

  function paintPill() {
    if (!pill || !st) return;
    const v = look(st);
    pill.className = 'sync-pill ' + v.cls;
    pill.title = v.title + (st.conflicts ? `\n${st.conflicts} 筆衝突等你選擇保留哪個版本` : '');
    pill.replaceChildren(el('span', { class: 'sync-dot' }), el('span', { class: 'sync-text', text: v.text }),
      st.conflicts ? el('span', { class: 'sync-conf', text: `${st.conflicts} 衝突` }) : '');
  }

  async function refreshStatus() {
    try {
      st = await api('/api/sync/client');
    } catch { return; }
    paintPill();
    if (panel && panel.isConnected) panel.paint();
  }

  async function mountPill() {
    try { st = await api('/api/sync/client'); } catch { return; }
    if (!st.available) return;
    const right = document.querySelector('.topbar-right');
    if (!right) return;
    pill = el('button', { class: 'sync-pill', type: 'button', 'aria-label': '同步狀態' });
    right.prepend(pill);
    pill.addEventListener('click', openPanel);
    paintPill();
    let n = 0;
    setInterval(() => { n += 1; if (st && (st.syncing || st.pending || n % 3 === 0) && !document.hidden) refreshStatus(); }, 2000);
  }

  // --------------------------------------------------------------- panel
  function openPanel() {
    if (panel && panel.isConnected) return;
    const body = el('div', { class: 'modal-body sync-body' });
    const foot = el('div', { class: 'modal-foot' });
    const wrap = el('div', { class: 'modal' },
      el('div', { class: 'modal-card sync-card', role: 'dialog', 'aria-modal': 'true', 'aria-label': '伺服器同步' },
        el('div', { class: 'modal-head' }, el('h3', { html: svg('refresh') + '伺服器同步' })), body, foot));
    const close = () => { wrap.remove(); document.removeEventListener('keydown', onKey, true); if (!document.querySelector('.modal:not([hidden])')) document.body.classList.remove('modal-open'); };
    const onKey = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    document.addEventListener('keydown', onKey, true);
    wrap.addEventListener('mousedown', e => { if (e.target === wrap) close(); });
    document.body.append(wrap);
    document.body.classList.add('modal-open');
    panel = wrap;
    let logRows = null, form = null, loading = false;

    const closeBtn = () => { const b = el('button', { class: 'btn btn-ghost', type: 'button', text: '關閉' }); b.addEventListener('click', close); return b; };

    function connectForm() {
      const server = el('input', { class: 'input', type: 'url', placeholder: 'https://tools.corp.local', value: st.server || '', autocomplete: 'url' });
      const user = el('input', { class: 'input', type: 'text', placeholder: 'AD 帳號', value: (st.user && st.user.username) || '', autocomplete: 'username' });
      const pass = el('input', { class: 'input', type: 'password', placeholder: '密碼', autocomplete: 'current-password' });
      const verify = el('input', { type: 'checkbox', checked: st.verify !== false });
      const go = el('button', { class: 'btn btn-primary', type: 'submit', html: svg('refresh') + '連線並同步' });
      const err = el('p', { class: 'sync-err', hidden: true });
      const f = el('form', { class: 'sync-form' },
        el('p', { class: 'hint', text: '連線後，這台電腦的看板會和伺服器雙向同步：有連線時即時同步；離線時照常使用，恢復連線後自動送出。看得到哪些卡片依帳號在伺服器上的權限而定。' }),
        st.was_linked ? null : el('p', { class: 'hint', text: '這台電腦上已有的卡片會歸到這個帳號，並上傳到伺服器。' }),
        el('label', { class: 'field' }, el('span', { class: 'field-label', text: '伺服器網址' }), server),
        el('div', { class: 'form-row' },
          el('label', { class: 'field' }, el('span', { class: 'field-label', text: '帳號' }), user),
          el('label', { class: 'field' }, el('span', { class: 'field-label', text: '密碼' }), pass)),
        el('label', { class: 'sync-check' }, verify, el('span', { text: '驗證伺服器憑證（伺服器用自簽憑證時才取消）' })),
        err);
      f.addEventListener('submit', async e => {
        e.preventDefault();
        go.disabled = true; err.hidden = true;
        go.innerHTML = svg('refresh') + '連線中…';
        try {
          st = await api('/api/sync/client/connect', { method: 'POST', body: { server: server.value, username: user.value, password: pass.value, verify: verify.checked } });
          paintPill(); paint();
          toast(st.error ? '已連結，但同步失敗：' + st.error : '已連線，開始同步', !!st.error);
          window.TTBoard && TTBoard.refresh && TTBoard.refresh();
        } catch (ex) {
          err.textContent = ex.message; err.hidden = false;
        } finally {
          go.disabled = false; go.innerHTML = svg('refresh') + '連線並同步';
        }
      });
      go.setAttribute('form', 'sync-connect');
      f.id = 'sync-connect';
      setTimeout(() => (st.server ? (user.value ? pass : user) : server).focus(), 30);
      return { f, go };
    }

    function statusRows() {
      const v = look(st);
      const row = (k, val) => el('div', { class: 'sync-kv' }, el('span', { text: k }), val);
      return el('div', { class: 'sync-status' },
        row('狀態', el('span', { class: 'sync-pill sync-inline ' + v.cls }, el('span', { class: 'sync-dot' }), el('span', { text: v.text }))),
        row('伺服器', el('span', { text: st.server })),
        row('帳號', el('span', { text: `${st.user.display_name || st.user.username}（${st.user.username}）` })),
        row('上次同步', el('span', { text: ago(st.last_ok) })),
        st.error ? row('訊息', el('span', { class: 'sync-err-text', text: st.error })) : null);
    }

    async function loadLog() {
      loading = true;
      try { logRows = await api('/api/sync/client/log'); } catch { logRows = logRows || []; }
      loading = false;
      if (wrap.isConnected) paint();
    }

    function conflictList() {
      const open = (logRows || []).filter(r => r.kind === 'conflict' && r.status === 'open');
      const past = (logRows || []).filter(r => !(r.kind === 'conflict' && r.status === 'open')).slice(0, 40);
      const box = el('div', { class: 'sync-log' });
      if (logRows === null) { box.append(el('p', { class: 'hint', text: '讀取中…' })); return box; }
      box.append(el('h4', { text: open.length ? `衝突：${open.length} 筆等你選擇` : '衝突' }));
      if (!open.length) box.append(el('p', { class: 'hint', text: '沒有衝突。兩邊改了同一個欄位時，會先套用時間較晚的修改，兩個版本都留在這裡讓你選。' }));
      open.forEach(r => {
        const pick = keep => async () => {
          try {
            await api('/api/sync/client/resolve', { method: 'POST', body: { id: r.id, keep } });
            toast(keep === 'mine' ? '已改回你的版本，會同步到伺服器' : '已保留對方的版本');
            await loadLog(); refreshStatus();
            window.TTBoard && TTBoard.refresh && TTBoard.refresh();
          } catch (ex) { toast(ex.message, true); }
        };
        const mineBtn = el('button', { class: 'btn btn-sm', type: 'button', text: '用我的' });
        const theirsBtn = el('button', { class: 'btn btn-sm', type: 'button', text: '用對方的' });
        mineBtn.addEventListener('click', pick('mine'));
        theirsBtn.addEventListener('click', pick('theirs'));
        const ver = (label, val, who) => el('div', { class: 'sync-ver' + (r.winner === who ? ' is-now' : '') },
          el('span', { class: 'sync-ver-k', text: label + (r.winner === who ? '（目前）' : '') }), el('span', { class: 'sync-ver-v', text: val }));
        const open_ = r.card_id ? el('button', { class: 'link-btn', type: 'button', text: r.card || '（卡片）' }) : el('strong', { text: r.card || '（已刪除）' });
        if (r.card_id) open_.addEventListener('click', () => { close(); window.TTBoard && TTBoard.openTask(r.card_id); });
        box.append(el('div', { class: 'sync-conflict' },
          el('div', { class: 'sync-c-head' }, open_, el('span', { class: 'hint', text: `${r.what} · ${r.field}` })),
          el('div', { class: 'sync-vers' }, ver('我的', r.mine, 'mine'), ver('對方', r.theirs, 'theirs')),
          el('div', { class: 'sync-c-act' }, mineBtn, theirsBtn)));
      });
      if (past.length) {
        const det = el('details', { class: 'sync-past' }, el('summary', { text: `同步紀錄（${past.length}）` }));
        past.forEach(r => {
          const what = r.kind === 'conflict' ? `衝突已處理：保留${r.status === 'kept-mine' ? '我的' : '對方的'}版本（${r.field}）`
            : r.kind === 'refused' ? `伺服器拒絕：${r.note || ''}${r.field ? `（${r.field}：${r.mine} → 維持 ${r.theirs}）` : ''}`
            : r.note || r.kind;
          det.append(el('div', { class: 'sync-past-row' }, el('span', { class: 'hint', text: r.at.slice(5, 16) }),
            el('span', { text: `${r.card || r.what}：${what}` })));
        });
        box.append(det);
      }
      return box;
    }

    function paint() {
      if (!st.linked) {
        if (!form) form = connectForm();
        body.replaceChildren(form.f);
        foot.replaceChildren(closeBtn(), form.go);
        return;
      }
      form = null;
      if (logRows === null && !loading) loadLog();
      const now = el('button', { class: 'btn btn-primary', type: 'button', html: svg('refresh') + '立即同步' });
      const off = el('button', { class: 'btn btn-ghost btn-danger', type: 'button', text: '中斷連線' });
      now.disabled = !!st.syncing;
      now.addEventListener('click', async () => {
        now.disabled = true; now.innerHTML = svg('refresh') + '同步中…';
        try {
          st = await api('/api/sync/client/now', { method: 'POST' });
          paintPill();
          toast(st.online === false ? '連不到伺服器，修改會保留到恢復連線' : st.error ? st.error : '同步完成', st.online === false || !!st.error);
          await loadLog();
        } catch (ex) { toast(ex.message, true); paint(); }
      });
      off.addEventListener('click', async () => {
        if (!confirm('中斷和伺服器的連線？\n這台電腦上的資料會保留，之後可以重新連線。' + (st.pending ? `\n注意：還有 ${st.pending} 筆修改沒送出，重新連線後才會送出。` : ''))) return;
        st = await api('/api/sync/client/disconnect', { method: 'POST' });
        paintPill(); paint();
      });
      body.replaceChildren(statusRows(), conflictList());
      foot.replaceChildren(off, el('span', { class: 'spacer' }), closeBtn(), now);
    }
    panel.paint = paint;
    paint();
    refreshStatus();
  }

  document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => { mountPill(); watch(); }, 300);
  });
  window.TTSync = { openPanel, refresh: refreshStatus };
})();
