/* IPMS — AiPM: the AI project manager panel (app/aipm.py, /api/aipm), for every department.
   Left: the conversation — paste screenshots, say what happened, pick the item it is about; AiPM answers,
   forecasts and asks. Right: what is waiting — questions (answered by the person asked), suggested changes
   (核准採用 / 略過 / 復原 only by the project's lead or a board administrator — AiPM changes nothing by itself),
   things to follow up, and what the system sees. Everyone sees only what is about cards they can see.
   Opened from the project page, the card / subtask editors, a notification, or the AI 助理 page. */
(() => {
  const { el, svg, api, toast, esc } = TT;
  const SEV = { high: _t('高'), medium: _t('中'), low: _t('低') };
  const ACT = { append_note: _t('補充說明'), add_subtask: _t('新增工作'), set_dates: _t('調整日期'), set_status: _t('變更狀態'),
    set_assignee: _t('指派負責人'), set_priority: _t('調整優先度'), set_blocked: _t('標記卡住') };
  const SRC = { chat: _t('對話'), manual: _t('手動檢視'), event: _t('變動後'), patrol: _t('每日巡檢') };
  const md = t => (window.TTAI ? TTAI.md(t) : esc(t));
  let panel = null;

  function close() {
    if (!panel) return;
    panel.wrap.remove();
    document.removeEventListener('keydown', panel.onKey, true);
    (panel.pics || []).forEach(p => URL.revokeObjectURL(p.preview));
    const after = panel.onClose, changed = panel.changed;
    panel = null;
    if (changed) window.TTBoard?.load(true).catch(() => {});      // the board, Gantt and project page show AiPM's changes
    after?.(changed);
  }

  /** Open the panel for a card (its project when it belongs to one). target: { card, sub } to point the note at. */
  async function open(cardId, { target = null, onClose = null } = {}) {
    close();
    const wrap = el('div', { class: 'modal aipm-wrap' });
    const box = el('div', { class: 'aipm', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'AiPM' },
      el('div', { class: 'aipm-wait', html: svg('sparkles') + esc(_t('AiPM 正在讀取專案…')) }));
    wrap.append(box);
    const onKey = e => { if (e.key === 'Escape' && !e.target.closest?.('.modal:not(.aipm-wrap)')) { e.stopImmediatePropagation(); close(); } };
    document.addEventListener('keydown', onKey, true);
    wrap.addEventListener('mousedown', e => { if (e.target === wrap) close(); });
    document.body.append(wrap);
    panel = { wrap, box, onKey, cardId, target, pics: [], tab: 'chat', onClose, changed: false };
    try {
      paint(await api(`/api/aipm/${cardId}`));
    } catch (e) {
      box.replaceChildren(head(null), el('p', { class: 'ai-err aipm-pad', text: e.message }));
    }
  }

  function head(st) {
    const x = el('button', { class: 'icon-btn', type: 'button', 'aria-label': _t('關閉'), html: svg('x') });
    x.addEventListener('click', close);
    const meta = st ? el('div', { class: 'aipm-sub' },
      el('span', { text: st.root.kind === 'project' ? _t('專案') : _t('卡片') }),
      el('span', { text: st.can_approve ? _t('你可以核准 AiPM 的變更') : _t('變更由 {0} 核准', st.approvers.join('、') || _t('專案負責人或看板管理人')) }),
      el('span', { text: st.vision ? _t('可以看截圖') : _t('看不到截圖（只依文字）') }),
      el('span', { text: _t('每日巡檢 {0}', st.patrol) }),
      st.run?.last_at ? el('span', { text: _t('上次檢視 {0}', st.run.last_at.slice(5, 16)) }) : null,
      st.run?.last_error ? el('span', { class: 'aipm-bad', text: _t('上次背景檢視失敗：{0}', st.run.last_error) }) : null) : null;
    const review = st && st.enabled && !st.history ? el('button', { class: 'btn btn-sm', type: 'button', html: svg('sparkles') + _t('請 AiPM 檢視') }) : null;
    review?.addEventListener('click', () => run(review, () => api(`/api/aipm/${st.root.id}/review`, { method: 'POST' }), _t('AiPM 正在檢視整個專案…')));
    return el('div', { class: 'aipm-head' },
      el('div', { class: 'aipm-title' }, el('span', { class: 'aipm-logo', html: svg('sparkles') }),
        el('div', {}, el('h2', {}, el('b', { text: 'AiPM' }), st ? el('span', { text: ' · ' + st.root.title }) : null), meta)),
      el('span', { class: 'spacer' }), review, x);
  }

  async function run(btn, call, waitText) {
    const st = panel?.st;
    if (!st) return;
    panel.box.querySelectorAll('button').forEach(b => { if (!b.classList.contains('icon-btn')) b.disabled = true; });
    const w = panel.box.querySelector('.aipm-thinking');
    if (w) { w.hidden = false; w.querySelector('span').textContent = waitText || _t('AiPM 正在思考…'); }
    try {
      const r = await call();
      panel.changed = true;
      paint(r);
      if (r.warning) toast(r.warning, true);
      return true;
    } catch (e) {
      toast(e.message, true);
      paint(st);
      return false;
    } finally { void btn; }
  }

  // ---------------------------------------------------------------- layout
  function paint(st) {
    if (!panel) return;
    panel.st = st;
    const pend = st.items.filter(i => i.status === 'pending');
    const tabs = el('div', { class: 'aipm-tabs segmented', role: 'group' },
      ...[['chat', _t('對話')], ['board', _t('待處理') + (pend.length ? ` ${pend.length}` : '')]].map(([v, l]) => {
        const b = el('button', { type: 'button', dataset: { v }, text: l, 'aria-pressed': String(panel.tab === v) });
        b.addEventListener('click', () => { panel.tab = v; panel.box.dataset.tab = v; tabs.querySelectorAll('button').forEach(x => x.setAttribute('aria-pressed', String(x.dataset.v === v))); });
        return b;
      }));
    panel.box.dataset.tab = panel.tab;
    panel.box.replaceChildren(head(st), tabs,
      el('div', { class: 'aipm-body' }, chatPane(st), boardPane(st)));
    const list = panel.box.querySelector('.aipm-msgs');
    if (list) list.scrollTop = list.scrollHeight;
  }

  // ---------------------------------------------------------------- conversation
  function chatPane(st) {
    const msgs = el('div', { class: 'aipm-msgs' });
    if (!st.messages.length) {
      msgs.append(el('div', { class: 'aipm-intro' },
        el('h3', { html: svg('sparkles') + esc(_t('我是 AiPM，這個專案的 AI 專案經理')) }),
        el('p', { text: _t('貼上截圖、用一兩句話說發生了什麼（完成了什麼、遇到什麼、下一步），選它屬於哪個項目。我會整理成紀錄、預估接下來的風險、問你需要補的資訊，並建議該補的工作與該留的截圖。') }),
        el('p', { class: 'hint', text: _t('你專心做自己的專業，文件與追蹤交給我。我不會自己改任何東西：每一項變更都要專案負責人或看板管理人核准，已完成或取消的項目不會被變更。') })));
    }
    for (const m of st.messages) msgs.append(m.role === 'user' ? userMsg(m) : aipmMsg(m));
    msgs.append(el('div', { class: 'aipm-thinking', hidden: true }, el('i', { html: svg('sparkles') }), el('span', { text: _t('AiPM 正在思考…') })));
    return el('section', { class: 'aipm-chat' }, msgs, st.enabled && !st.history ? composer(st) : el('p', { class: 'hint aipm-pad', text: st.history ? _t('歷史區的專案只能查看。') : _t('AiPM 尚未啟用：請系統管理員到後台「AI 接入點」啟用 AI 與 AiPM。') }));
  }

  function userMsg(m) {
    const pics = (m.images || []).map(p => el('a', { href: `/api/tasks/${p.task}/images/${p.id}`, target: '_blank', rel: 'noopener', class: 'aipm-pic' },
      el('img', { src: `/api/tasks/${p.task}/images/${p.id}`, alt: _t('截圖'), loading: 'lazy' })));
    return el('div', { class: 'aipm-msg me' },
      el('div', { class: 'aipm-bubble' }, m.text ? el('div', { class: 'aipm-text', text: m.text }) : null, pics.length ? el('div', { class: 'aipm-pics' }, ...pics) : null),
      el('small', { class: 'hint', text: `${m.who || ''} · ${m.at.slice(5, 16)}` }));
  }

  function aipmMsg(m) {
    const p = m.payload || {};
    const fc = (p.forecast || []).map(f => el('li', { class: 'sev-' + f.severity }, el('b', { text: SEV[f.severity] || '' }), f.code ? el('code', { text: f.code }) : null, el('span', { text: f.text })));
    return el('div', { class: 'aipm-msg ai' },
      el('div', { class: 'aipm-bubble' },
        p.understanding ? el('p', { class: 'aipm-und', text: _t('我的理解：') + p.understanding }) : null,
        el('div', { class: 'ai-md', html: md(m.text) }),
        fc.length ? el('div', { class: 'aipm-fc' }, el('h4', { html: svg('zap') + esc(_t('預估與風險')) }), el('ul', {}, ...fc)) : null),
      el('small', { class: 'hint', text: [SRC[m.source] || '', m.at.slice(5, 16), p.model || '', p.images_seen ? _t('已看過截圖') : ''].filter(Boolean).join(' · ') }));
  }

  function composer(st) {
    const sel = el('select', { class: 'select aipm-target', title: _t('這段說明屬於哪個項目') },
      ...st.targets.map(t => el('option', { value: `${t.card}:${t.sub || ''}`, text: `${'　'.repeat(Math.max(0, t.level - 1))}${t.code} ${t.title}` })));
    const want = panel.target;
    if (want) {
      const k = `${want.card}:${want.sub || ''}`;
      if ([...sel.options].some(o => o.value === k)) sel.value = k;
    }
    sel.addEventListener('change', () => { const [c, s] = sel.value.split(':'); panel.target = { card: Number(c), sub: s ? Number(s) : null }; });
    const text = el('textarea', { class: 'textarea', rows: '3', placeholder: _t('發生了什麼？例如：廠商報價已收到，比預算高 8%；測試環境部署失敗（可以直接貼上截圖）') });
    text.value = panel.draft || '';
    text.addEventListener('input', () => { panel.draft = text.value; });
    const record = el('input', { type: 'checkbox', checked: true });
    const thumbs = el('div', { class: 'aipm-thumbs' });
    const paintPics = () => thumbs.replaceChildren(...panel.pics.map(p => {
      const x = el('button', { type: 'button', class: 'kb-thumb-x', 'aria-label': _t('移除'), html: svg('x') });
      x.addEventListener('click', () => { URL.revokeObjectURL(p.preview); panel.pics = panel.pics.filter(q => q !== p); paintPics(); });
      return el('span', { class: 'aipm-thumb' }, el('img', { src: p.preview, alt: p.file.name }), x);
    }));
    const addFiles = files => {
      for (const f of files) {
        if (!/^image\//.test(f.type)) continue;
        if (panel.pics.length >= 6) { toast(_t('一次最多 6 張截圖'), true); break; }
        panel.pics.push({ file: f, preview: URL.createObjectURL(f) });
      }
      paintPics();
    };
    paintPics();
    text.addEventListener('paste', e => {
      const files = [...(e.clipboardData?.files || [])].filter(f => /^image\//.test(f.type));
      if (files.length) { e.preventDefault(); addFiles(files); }
    });
    const zone = el('div', { class: 'aipm-compose' });
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
    zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('drag'); addFiles([...(e.dataTransfer?.files || [])]); });
    const attach = el('button', { class: 'btn btn-sm btn-ghost', type: 'button', html: svg('image') + _t('截圖') });
    attach.addEventListener('click', () => {
      const input = el('input', { type: 'file', accept: 'image/*', multiple: '' });
      input.addEventListener('change', () => addFiles([...input.files]));
      input.click();
    });
    const send = el('button', { class: 'btn btn-primary btn-sm', type: 'button', html: svg('send') + _t('送出') });
    const go = async () => {
      if (!text.value.trim() && !panel.pics.length) { text.focus(); return; }
      const [c, s] = sel.value.split(':');
      const card = Number(c), sub = s ? Number(s) : null;
      const code = (st.targets.find(t => t.card === card && (t.sub || null) === sub) || {}).code || null;
      const ok = await run(send, async () => {
        const ids = [];
        for (const p of panel.pics) {
          const form = new FormData();
          form.append('file', p.file, p.file.name || 'screenshot.png');
          form.append('target', 'comment');
          ids.push((await api(`/api/tasks/${card}/images`, { method: 'POST', form })).id);
        }
        const r = await api(`/api/aipm/${st.root.id}/chat`, { method: 'POST', body: { text: text.value.trim(), images: ids, card, sub, code, record: record.checked } });
        panel.pics.forEach(p => URL.revokeObjectURL(p.preview));
        panel.pics = []; panel.draft = '';
        return r;
      }, panel.pics.length ? _t('AiPM 正在看截圖、讀專案…') : _t('AiPM 正在讀專案…'));
      void ok;
    };
    send.addEventListener('click', go);
    text.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); go(); } });
    zone.append(
      el('div', { class: 'aipm-row' }, el('span', { class: 'ai-label', text: _t('關於') }), sel),
      text, thumbs,
      el('div', { class: 'aipm-row' }, attach,
        el('label', { class: 'aipm-check', title: _t('文字與截圖會變成這個項目的一則留言，留下紀錄') }, record, el('span', { text: _t('同時記錄為留言') })),
        el('span', { class: 'spacer' }), el('small', { class: 'hint', text: 'Ctrl+Enter' }), send),
      ...(st.vision ? [] : [el('p', { class: 'hint', text: _t('目前的 AI 服務看不到圖片（或不允許把圖片送到雲端）：截圖會留在留言，AiPM 只依文字判斷。') })]));
    return zone;
  }

  // ---------------------------------------------------------------- what is waiting
  function boardPane(st) {
    const pend = st.items.filter(i => i.status === 'pending');
    const qs = pend.filter(i => i.kind === 'question'), props = pend.filter(i => i.kind === 'proposal'), track = pend.filter(i => i.kind === 'tracking');
    const applied = st.items.filter(i => i.kind === 'proposal' && ['applied', 'auto'].includes(i.status) && i.undo);
    const done = st.items.filter(i => i.status !== 'pending');
    const c = st.counts || {};
    const sec = (icon, title, n, body, open = true) => el('details', { class: 'aipm-sec', open },
      el('summary', {}, el('i', { html: svg(icon) }), el('b', { text: title }), n != null ? el('span', { class: 'aipm-n', text: String(n) }) : null), body);
    const empty = t => el('p', { class: 'hint', text: t });
    return el('section', { class: 'aipm-board' },
      el('div', { class: 'ai-chips aipm-chips' }, ...[[_t('項目'), c.items], [_t('完成'), `${c.done ?? 0}（${c.pct ?? 0}%）`], [_t('逾期'), c.overdue], [_t('卡住'), c.blocked]]
        .map(([k, v]) => el('span', { class: 'ai-chip' }, el('small', { text: k }), el('b', { text: String(v ?? 0) })))),
      sec('message', _t('AiPM 的問題'), qs.length, qs.length ? questions(qs) : empty(_t('目前沒有問題。'))),
      sec('edit', _t('建議的變更（待核准）'), props.length, el('div', {},
        el('p', { class: 'hint aipm-rule', text: st.can_approve ? _t('你是這個專案的核准人：按「核准採用」才會變更。') : _t('只有專案負責人或看板管理人可以核准（{0}）。', st.approvers.join('、') || '—') }),
        ...(props.length ? props.map(proposal) : [empty(_t('目前沒有待核准的變更。'))]))),
      applied.length && st.can_approve ? sec('check', _t('已核准的變更（可復原）'), applied.length, el('div', {}, ...applied.slice(0, 12).map(proposal)), false) : null,
      sec('flag', _t('待追蹤事項'), track.length, track.length ? el('div', {}, ...track.map(tracking)) : empty(_t('目前沒有要追蹤的事。'))),
      sec('zap', _t('系統偵測到的狀況'), st.signals.length, st.signals.length ? el('ul', { class: 'aipm-sig' }, ...st.signals.slice(0, 40).map(s =>
        el('li', { class: 'sev-' + s.severity }, el('code', { text: s.code }), el('span', { text: `${s.title}：${s.text}` })))) : empty(_t('沒有偵測到問題。')), st.signals.some(s => s.severity === 'high')),
      done.length ? sec('clock', _t('已處理'), done.length, el('ul', { class: 'aipm-done' }, ...done.slice(0, 30).map(i => el('li', {},
        el('span', { class: 'aipm-st st-' + i.status, text: { applied: _t('已採用'), dismissed: _t('已略過'), undone: _t('已復原'), resolved: _t('已完成'), answered: _t('已回答') }[i.status] || i.status }),
        el('span', { text: i.title }), i.answer ? el('small', { class: 'hint', text: ' → ' + i.answer }) : null,
        i.done_by_name ? el('small', { class: 'hint', text: ` · ${i.done_by_name}` }) : null))), false) : null);
  }

  const itemApi = (id, what, body) => api(`/api/aipm/items/${id}/${what}`, { method: 'POST', body });

  /**
   * AiPM's questions are answered together: picking an option or typing only fills in a draft (nothing is
   * locked or sent), then one button sends every answer filled in and AiPM re-plans once with all of them.
   * Questions left blank stay for later. Drafts survive repaints of the panel.
   */
  const canAnswer = i => i.assignee_id === panel.st.me || panel.st.can_approve;
  function questions(qs) {
    const drafts = panel.drafts || (panel.drafts = new Map());
    for (const id of [...drafts.keys()]) if (!qs.some(q => q.id === id)) drafts.delete(id);
    const mine = qs.filter(canAnswer);
    const send = el('button', { class: 'btn btn-sm btn-primary', type: 'button' });
    const count = el('span', { class: 'aipm-qcount' });
    const filled = () => mine.map(q => ({ id: q.id, text: (drafts.get(q.id) || '').trim() })).filter(a => a.text);
    const paintBar = () => {
      const n = filled().length;
      send.disabled = !n;
      send.innerHTML = svg('send') + esc(n ? _t('送出 {0} 個回答，讓 AiPM 一起調整', n) : _t('送出回答'));
      count.textContent = _t('已填 {0} / {1} 題', n, mine.length);
    };
    send.addEventListener('click', () => {
      const answers = filled();
      if (!answers.length) return;
      run(send, async () => {
        const r = await api(`/api/aipm/${panel.st.root.id}/answers`, { method: 'POST', body: { answers } });
        answers.forEach(a => drafts.delete(a.id));
        return r;
      }, _t('AiPM 正在依你的 {0} 個回答一起調整…', answers.length));
    });
    const list = qs.map(q => question(q, paintBar));
    paintBar();
    return el('div', { class: 'aipm-qs' },
      mine.length > 1 ? el('p', { class: 'hint', text: _t('可以一次回答多題，也可以只回答幾題（沒填的會留著）。選項與自己寫的回答都只是先填好，按下方「送出」才會一起交給 AiPM。') }) : null,
      ...list,
      mine.length ? el('div', { class: 'aipm-qbar' }, count, el('span', { class: 'spacer' }), send) : null);
  }

  function question(i, onChange) {
    const st = panel.st;
    if (!canAnswer(i)) {
      return el('div', { class: 'aipm-item q' },
        el('div', { class: 'aipm-it-head' }, i.code ? el('code', { text: i.code }) : null, el('b', { text: i.title })),
        el('small', { class: 'hint', text: _t('等 {0} 回答', i.assignee || _t('專案負責人')) }));
    }
    const drafts = panel.drafts;
    const opts = i.options || [];
    const cur = drafts.get(i.id) || '';
    const input = el('input', { class: 'input', maxlength: '2000', placeholder: opts.length ? _t('或自己寫回答…') : _t('寫下回答…'),
      value: opts.includes(cur) ? '' : cur });
    const optBtns = opts.map(o => el('button', { class: 'btn btn-sm aipm-opt', type: 'button', text: o, 'aria-pressed': String(cur === o) }));
    const box = el('div', { class: 'aipm-item q' + (cur.trim() ? ' is-filled' : '') });
    const set = v => {
      if (v.trim()) drafts.set(i.id, v); else drafts.delete(i.id);
      optBtns.forEach(b => b.setAttribute('aria-pressed', String(drafts.get(i.id) === b.textContent)));
      box.classList.toggle('is-filled', !!v.trim());
      onChange();
    };
    optBtns.forEach(b => b.addEventListener('click', () => {                // click again to unpick
      const on = drafts.get(i.id) === b.textContent;
      input.value = '';
      set(on ? '' : b.textContent);
    }));
    input.addEventListener('input', () => set(input.value));
    input.addEventListener('keydown', e => { if (e.key === 'Enter') e.preventDefault(); });
    const skip = el('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: _t('略過'), title: _t('不回答這題（AiPM 不會再問）') });
    skip.addEventListener('click', () => { drafts.delete(i.id); run(null, () => itemApi(i.id, 'dismiss')); });
    box.append(...[
      el('div', { class: 'aipm-it-head' }, i.code ? el('code', { text: i.code }) : null, el('b', { text: i.title }), el('span', { class: 'aipm-q-ok', text: _t('已填') })),
      i.detail ? el('p', { class: 'hint', text: _t('為什麼問：') + i.detail }) : null,
      i.assignee ? el('small', { class: 'hint', text: _t('請 {0} 回答', i.assignee) }) : null,
      opts.length ? el('div', { class: 'aipm-opts' }, ...optBtns) : null,
      el('div', { class: 'aipm-row' }, input, skip)].filter(Boolean));
    return box;
  }

  function proposal(i) {
    const a = i.action || {};
    const preview = a.text && ['append_note', 'add_subtask', 'set_blocked'].includes(a.action) ? el('pre', { class: 'aipm-pre', text: a.text }) : null;
    const facts = [a.start && _t('開始 {0}', a.start), a.due && _t('到期 {0}', a.due), a.assignee && a.action === 'add_subtask' && _t('負責 {0}', a.assignee)].filter(Boolean);
    const btns = [];
    if (!panel.st.can_approve) {
      if (i.status === 'pending') btns.push(el('small', { class: 'aipm-wait-ok', text: _t('等待核准') }));
    } else if (i.status === 'pending') {
      const ok = el('button', { class: 'btn btn-sm btn-primary', type: 'button', html: svg('check') + _t('核准採用') });
      ok.addEventListener('click', () => run(ok, () => itemApi(i.id, 'apply')));
      const no = el('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: _t('略過') });
      no.addEventListener('click', () => run(no, () => itemApi(i.id, 'dismiss')));
      btns.push(ok, no);
    } else if (i.undo) {
      const un = el('button', { class: 'btn btn-sm btn-ghost', type: 'button', html: svg('rotate-ccw') + _t('復原') });
      un.addEventListener('click', () => run(un, () => itemApi(i.id, 'undo')));
      btns.push(un);
    }
    return el('div', { class: `aipm-item p risk-${i.risk}` },
      el('div', { class: 'aipm-it-head' }, el('span', { class: 'aipm-tag', text: ACT[a.action] || '' }), el('b', { text: i.title }),
        el('span', { class: 'aipm-risk', text: i.risk === 'high' ? _t('影響較大') : _t('影響較小') })),
      i.detail ? el('p', { class: 'hint', text: i.detail }) : null,
      facts.length ? el('small', { class: 'hint', text: facts.join(' · ') }) : null,
      preview,
      i.error ? el('p', { class: 'ai-err', text: _t('無法套用：{0}', i.error) }) : null,
      el('div', { class: 'aipm-row' }, el('small', { class: 'hint', text: `${SRC[i.source] || ''} · ${i.created_at.slice(5, 16)}` }), el('span', { class: 'spacer' }), ...btns));
  }

  function tracking(i) {
    const ok = el('button', { class: 'btn btn-sm', type: 'button', html: svg('check') + _t('已完成') });
    ok.addEventListener('click', () => run(ok, () => itemApi(i.id, 'resolve')));
    const no = el('button', { class: 'btn btn-sm btn-ghost', type: 'button', text: _t('不用追') });
    no.addEventListener('click', () => run(no, () => itemApi(i.id, 'dismiss')));
    return el('div', { class: 'aipm-item t' },
      el('div', { class: 'aipm-it-head' }, i.code ? el('code', { text: i.code }) : null, el('b', { text: i.title }), i.due ? el('span', { class: 'aipm-due', text: _t('{0} 前', i.due.slice(5)) }) : null),
      i.detail ? el('p', { class: 'hint', text: i.detail }) : null,
      el('div', { class: 'aipm-row' }, el('span', { class: 'spacer' }), ok, no));
  }

  /** For the AI 助理 page: my questions from AiPM and projects with suggestions waiting. */
  async function inbox() {
    let d;
    try { d = await api('/api/aipm/inbox'); } catch { return null; }
    if (!d.enabled) return null;
    const box = el('section', { class: 'ai-card aipm-inbox' }, el('h2', { html: svg('sparkles') + esc(_t('AiPM 待處理')) }));
    if (!d.questions.length && !d.projects.length) {
      box.append(el('p', { class: 'hint', text: _t('目前沒有 AiPM 的問題或待確認的建議。在專案頁按「AiPM」開始對話。') }));
      return box;
    }
    const row = (title, sub, id) => {
      const b = el('button', { class: 'aipm-inrow', type: 'button' }, el('b', { text: title }), el('small', { class: 'hint', text: sub }));
      b.addEventListener('click', () => open(id));
      return b;
    };
    box.append(...d.questions.map(q => row(q.title, `${q.card_title}${q.code ? ' · ' + q.code : ''} · ${_t('AiPM 的問題')}`, q.card_id)),
      ...d.projects.map(p => row(p.title, _t('{0} 項建議待確認', p.n), p.card_id)));
    return box;
  }

  /** A button for the project page / card editors. */
  function button(cardId, opts = {}, cls = 'btn') {
    if (!window.TTAI?.on) return null;
    const b = el('button', { class: cls, type: 'button', title: _t('AiPM：AI 專案經理（截圖、對話、預估、補齊專案內容）'), html: svg('sparkles') + 'AiPM' });
    b.addEventListener('click', () => open(cardId, opts));
    return b;
  }

  window.TTAIPM = { open, close, inbox, button };
})();
