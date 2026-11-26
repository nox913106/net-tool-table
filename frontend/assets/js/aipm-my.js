/* IPMS — 我的 AiPM (#/aipm): each person's work secretary and project manager (app/aipm_my.py, /api/aipm-my).
   對話: say what happened (paste screenshots); AiPM sorts it onto the right items — one click records them as my
   own comments; changes it suggests wait for the project's lead / a board administrator; ask it what was said or
   decided before (answers cite their sources). 會議: paste a meeting's notes → minutes, decisions, action items.
   結案對齊: items finished recently — checklist and a 結案摘要 (AiPM can draft it). Right: today's work. */
(() => {
  const { el, svg, api, toast, esc } = TT;
  const md = t => (window.TTAI ? TTAI.md(t) : esc(t));
  const ST = { recurring: _t('週期工作'), overdue: _t('過期未結案'), new: _t('新建'), ongoing: _t('進行中'), pending: _t('待確認'), onhold: _t('暫緩'), complete: _t('完成'), canceled: _t('取消') };
  const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  let S = null, pics = [], draft = '';

  /** Sidebar badge: closures waiting for me. */
  async function badge() {
    const b = document.querySelector('[data-aipm-badge]');
    if (!b) return;
    try { const c = await api('/api/aipm-my/count'); b.textContent = c.closures; b.hidden = !c.closures; } catch { b.hidden = true; }
  }

  async function render(view, { tab = 'chat', id = null } = {}) {
    const head = el('div', { class: 'page-head' }, el('div', { class: 'page-title-row' }, el('span', { class: 'page-icon', html: svg('message') }),
      el('div', { class: 'page-title-text' }, el('h1', { class: 'page-title', text: _t('我的 AiPM') }),
        el('p', { class: 'page-desc', text: _t('你的工作秘書兼專案經理：跟它說發生了什麼、貼截圖、貼會議筆記，它幫你記到對的項目、追蹤、提醒，也記得之前說過與決定過的事。') }))));
    view.replaceChildren(head, el('p', { class: 'hint', text: _t('載入中…') }));
    try { S = await api('/api/aipm-my'); } catch (e) { view.replaceChildren(head, el('p', { class: 'ai-err', text: e.message })); return; }
    if (!S.enabled) {
      view.replaceChildren(head, el('div', { class: 'empty' }, el('div', { class: 'empty-icon', html: svg('sparkles') }), el('h3', { text: _t('AiPM 尚未啟用') }),
        el('p', { text: _t('請系統管理員到後台「AI 接入點」啟用 AI 與 AiPM。') })));
      return;
    }
    const tabs = [['chat', _t('對話')], ['meetings', _t('會議')], ['closures', _t('結案對齊')]];
    const nav = el('div', { class: 'pj-tabs', role: 'tablist' }, ...tabs.map(([k, label]) =>
      el('a', { class: 'pj-tab my-tab', href: `#/aipm/${k}`, role: 'tab', 'aria-selected': String(k === tab) }, label,
        k === 'closures' && S.closures.length ? el('span', { class: 'hist-n', text: String(S.closures.length) }) : null)));
    const main = el('div', { class: 'my-main' });
    const side = workPane();
    view.replaceChildren(head, nav, el('div', { class: 'my-grid' }, main, side));
    if (tab === 'meetings') main.append(...(id ? [await meetingView(id)] : [meetingForm(), meetingList()]));
    else if (tab === 'closures') main.append(closuresView());
    else main.append(chatView());
    const list = main.querySelector('.aipm-msgs');
    if (list) list.scrollTop = list.scrollHeight;
    badge();
  }

  function parse(h) {
    const m = h.match(/^#\/aipm(?:\/(\w+)(?:\/(\d+))?)?$/) || [];
    return { tab: m[1] || 'chat', id: m[2] ? Number(m[2]) : null };
  }
  async function refresh() {
    const v = document.querySelector('.my-grid')?.parentElement;
    if (v) await render(v, parse(location.hash));
  }

  // ---------------------------------------------------------------- today's work (right)
  function workPane() {
    const w = S.work;
    const row = x => {
      const b = el('button', { type: 'button', class: 'my-work' + (x.blocked ? ' blocked' : x.late ? ' late' : '') },
        el('b', { text: x.title }), el('small', { class: 'hint', text: [x.project, ST[x.status] || x.status, x.due ? _t('到期 {0}', x.due.slice(5)) : '', x.blocked ? '⛔ ' + x.blocked : ''].filter(Boolean).join(' · ') }));
      b.addEventListener('click', () => { if (window.TTAIPM) TTAIPM.open(x.card, { target: { card: x.card, sub: x.sub } }); });
      return b;
    };
    return el('aside', { class: 'my-side' }, el('h3', { html: svg('calendar') + esc(_t('今天的工作（{0}）', w.length)) }),
      w.length ? el('div', { class: 'my-works' }, ...w.slice(0, 40).map(row)) : el('p', { class: 'hint', text: _t('目前沒有進行中的工作。') }),
      el('p', { class: 'hint', text: _t('點一項開啟該專案的 AiPM。卡住、逾期的排在前面。') }));
  }

  // ---------------------------------------------------------------- conversation
  function chatView() {
    const msgs = el('div', { class: 'aipm-msgs my-msgs' });
    if (!S.messages.length) {
      msgs.append(el('div', { class: 'aipm-intro' }, el('h3', { html: svg('sparkles') + esc(_t('{0}，我是你的 AiPM', S.name)) }),
        el('p', { text: _t('有什麼事直接跟我說：做了什麼、遇到什麼、下一步、需要誰幫忙，可以貼截圖。一段話裡有好幾件事也沒關係，我會分別記到對的項目，你按一下確認就好。') }),
        el('p', { text: _t('也可以問我：「上週跟廠商開會決定了什麼？」「這台交換器之前出過什麼問題？」我會從會議紀錄、留言與你說過的話裡找，並附上來源。') }),
        el('p', { class: 'hint', text: _t('每天巡檢時間我會跟你對齊一次今天的工作。我建議的變更（日期、負責人、新增工作…）要專案負責人或看板管理人核准才會生效。') })));
    }
    for (const m of S.messages) msgs.append(m.role === 'user' ? userMsg(m) : aiMsg(m));
    msgs.append(el('div', { class: 'aipm-thinking', hidden: true }, el('i', { html: svg('sparkles') }), el('span', { text: _t('AiPM 正在思考…') })));
    return el('section', { class: 'my-chat' }, msgs, composer(msgs));
  }

  function userMsg(m) {
    return el('div', { class: 'aipm-msg me' }, el('div', { class: 'aipm-bubble' }, m.text ? el('div', { class: 'aipm-text', text: m.text }) : null,
      m.uploads.length ? el('small', { class: 'hint', text: _t('附 {0} 張截圖', m.uploads.length) }) : null),
      el('small', { class: 'hint', text: m.at.slice(5, 16) }));
  }

  function aiMsg(m) {
    const p = m.payload || {};
    const label = { daily: _t('每日對齊'), meeting: _t('會議紀錄'), closure: _t('結案對齊') }[m.kind];
    const extra = [];
    if (m.kind === 'meeting' && p.meeting) {
      const a = el('a', { class: 'btn btn-sm', href: `#/aipm/meetings/${p.meeting}`, html: svg('file') + _t('打開會議紀錄') });
      extra.push(a);
    }
    if ((p.records || []).length) extra.push(recordsBox(p.records, pick => api(`/api/aipm-my/messages/${m.id}/record`, { method: 'POST', body: pick }), p.uploads?.length));
    if ((p.sent || []).length) extra.push(el('div', { class: 'my-sent' }, el('b', { text: _t('已送交核准：') }),
      el('ul', {}, ...p.sent.map(s => el('li', { text: `${s.title}${s.approvers?.length ? _t('（核准人：{0}）', s.approvers.join('、')) : ''}` })))));
    if ((p.tracking || []).length) extra.push(el('small', { class: 'hint', text: _t('已加入追蹤：{0}', p.tracking.join('、')) }));
    return el('div', { class: 'aipm-msg ai' + (m.kind === 'daily' ? ' daily' : '') },
      el('div', { class: 'aipm-bubble' }, label ? el('span', { class: 'aipm-tag', text: label }) : null, el('div', { class: 'ai-md', html: md(m.text) }), ...extra),
      el('small', { class: 'hint', text: [m.at.slice(5, 16), p.model || '', p.images_seen ? _t('已看過截圖') : ''].filter(Boolean).join(' · ') }));
  }

  /** Entries AiPM wants to record: tick, change the item or the text, press 記錄. */
  function recordsBox(records, send, nPics) {
    const box = el('div', { class: 'my-records' });
    const paint = () => {
      const rows = records.map((r, i) => {
        if (r.done) return el('div', { class: 'my-rec done' }, el('span', { class: 'aipm-st st-applied', text: _t('已記錄') }), el('b', { text: r.title }), el('small', { class: 'hint', text: r.note }));
        const chk = el('input', { type: 'checkbox', checked: true, dataset: { i } });
        const sel = el('select', { class: 'select', dataset: { i } }, ...S.targets.map(t => el('option', { value: t.ref, text: `${'　'.repeat(Math.max(0, t.level - 1))}${t.title}${t.level === 1 && t.project && t.project !== t.title ? ' · ' + t.project : ''}` })));
        sel.value = r.ref;
        if (sel.value !== r.ref) sel.prepend(el('option', { value: r.ref, text: r.title, selected: true }));
        const ta = el('textarea', { class: 'textarea', rows: '2', dataset: { i } });
        ta.value = r.note;
        return el('div', { class: 'my-rec' }, el('label', { class: 'my-rec-head' }, chk, el('span', { text: _t('記到') })), sel, ta);
      });
      const open = records.some(r => !r.done);
      const go = open ? el('button', { class: 'btn btn-sm btn-primary', type: 'button', html: svg('check') + _t('記錄到項目') }) : null;
      go?.addEventListener('click', async () => {
        const pick = [], edits = {};
        box.querySelectorAll('.my-rec input[type=checkbox]').forEach(c => { if (c.checked) pick.push(Number(c.dataset.i)); });
        box.querySelectorAll('.my-rec select').forEach(s => { const i = s.dataset.i; edits[i] = { ...(edits[i] || {}), ref: s.value }; });
        box.querySelectorAll('.my-rec textarea').forEach(t => { const i = t.dataset.i; edits[i] = { ...(edits[i] || {}), note: t.value }; });
        if (!pick.length) { toast(_t('請勾選要記錄的項目'), true); return; }
        go.disabled = true;
        try {
          const r = await send({ pick, edits });
          records.splice(0, records.length, ...r.records);
          toast(_t('已記錄 {0} 項', pick.length)); paint();
        } catch (e) { toast(e.message, true); go.disabled = false; }
      });
      box.replaceChildren(el('h4', { html: svg('edit') + esc(_t('要記到這些項目')) }),
        el('p', { class: 'hint', text: _t('會用你的名義記成各項目的留言') + (nPics ? _t('，附上這次的 {0} 張截圖', nPics) : '') + _t('。可以改項目或文字。') }),
        ...rows, go ? el('div', { class: 'aipm-row' }, el('span', { class: 'spacer' }), go) : null);
    };
    paint();
    return box;
  }

  function composer(msgs) {
    const text = el('textarea', { class: 'textarea', rows: '3', placeholder: _t('跟 AiPM 說：例如「UPS 報價收到了，比預算高 8%，要等主管簽核；機房門禁卡今天發完了」或「上次跟廠商開會決定了什麼？」') });
    text.value = draft;
    text.addEventListener('input', () => { draft = text.value; });
    const thumbs = el('div', { class: 'aipm-thumbs' });
    const paintPics = () => thumbs.replaceChildren(...pics.map(p => {
      const x = el('button', { type: 'button', class: 'kb-thumb-x', 'aria-label': _t('移除'), html: svg('x') });
      x.addEventListener('click', () => { URL.revokeObjectURL(p.preview); pics = pics.filter(q => q !== p); paintPics(); });
      return el('span', { class: 'aipm-thumb' }, el('img', { src: p.preview, alt: p.file.name }), x);
    }));
    const add = files => {
      for (const f of files) {
        if (!/^image\//.test(f.type)) continue;
        if (pics.length >= 6) { toast(_t('一次最多 6 張截圖'), true); break; }
        pics.push({ file: f, preview: URL.createObjectURL(f) });
      }
      paintPics();
    };
    paintPics();
    text.addEventListener('paste', e => { const f = [...(e.clipboardData?.files || [])].filter(x => /^image\//.test(x.type)); if (f.length) { e.preventDefault(); add(f); } });
    const zone = el('div', { class: 'aipm-compose' });
    zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
    zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('drag'); add([...(e.dataTransfer?.files || [])]); });
    const attach = el('button', { class: 'btn btn-sm btn-ghost', type: 'button', html: svg('image') + _t('截圖') });
    attach.addEventListener('click', () => { const i = el('input', { type: 'file', accept: 'image/*', multiple: '' }); i.addEventListener('change', () => add([...i.files])); i.click(); });
    const send = el('button', { class: 'btn btn-primary btn-sm', type: 'button', html: svg('send') + _t('送出') });
    const go = async () => {
      if (!text.value.trim() && !pics.length) { text.focus(); return; }
      const form = new FormData();
      form.append('text', text.value.trim());
      pics.forEach(p => form.append('files', p.file, p.file.name || 'screenshot.png'));
      send.disabled = true;
      const w = msgs.querySelector('.aipm-thinking');
      w.hidden = false; msgs.scrollTop = msgs.scrollHeight;
      try {
        await api('/api/aipm-my/chat', { method: 'POST', form });
        pics.forEach(p => URL.revokeObjectURL(p.preview)); pics = []; draft = '';
        await refresh();
      } catch (e) { toast(e.message, true); send.disabled = false; w.hidden = true; }
    };
    send.addEventListener('click', go);
    text.addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); go(); } });
    zone.append(text, thumbs, el('div', { class: 'aipm-row' }, attach, el('span', { class: 'spacer' }), el('small', { class: 'hint', text: 'Ctrl+Enter' }), send),
      ...(S.vision ? [] : [el('p', { class: 'hint', text: _t('目前的 AI 服務看不到圖片（或不允許把圖片送到雲端）：截圖會在記錄時附上，AiPM 只依文字判斷。') })]));
    return zone;
  }

  // ---------------------------------------------------------------- meetings
  function meetingForm() {
    const title = el('input', { class: 'input', maxlength: '200', placeholder: _t('例如：UPS 更換協調會') });
    const day = el('input', { class: 'input', type: 'date', value: iso(new Date()) });
    const projects = (window.TTBoard?.all?.() || []).filter(t => t.kind === 'project' && !t.history);
    const proj = el('select', { class: 'select' }, el('option', { value: '', text: _t('（由 AiPM 判斷）') }), ...projects.map(p => el('option', { value: p.id, text: p.title })));
    const text = el('textarea', { class: 'textarea', rows: '10', placeholder: _t('貼上會議筆記、逐字稿或重點（誰說了什麼、決定了什麼、誰要做什麼、什麼時候）') });
    const go = el('button', { class: 'btn btn-primary', type: 'button', html: svg('sparkles') + _t('整理會議紀錄') });
    const out = el('div', {});
    go.addEventListener('click', async () => {
      if (text.value.trim().length < 10) { toast(_t('請貼上會議內容'), true); text.focus(); return; }
      go.disabled = true;
      out.replaceChildren(el('div', { class: 'ai-wait', html: svg('sparkles') + esc(_t('AiPM 正在整理會議紀錄…')) }));
      try {
        const r = await api('/api/aipm-my/meetings', { method: 'POST', body: { title: title.value.trim(), held_on: day.value || null, text: text.value, project_id: proj.value ? Number(proj.value) : null } });
        location.hash = `#/aipm/meetings/${r.id}`;
      } catch (e) { out.replaceChildren(el('p', { class: 'ai-err', text: e.message })); go.disabled = false; }
    });
    return el('section', { class: 'ai-card' }, el('h2', { html: svg('users') + esc(_t('整理一場會議')) }),
      el('p', { class: 'hint', text: _t('不錄音：開完會把筆記或重點貼上來，AiPM 整理出摘要、決議、待辦與未決問題。待辦會變成建議的新工作，由專案負責人或看板管理人核准；相關項目可以一鍵記錄。') }),
      el('div', { class: 'sys-form' }, el('label', { class: 'field' }, el('span', { class: 'field-label', text: _t('會議名稱') }), title),
        el('label', { class: 'field' }, el('span', { class: 'field-label', text: _t('日期') }), day),
        el('label', { class: 'field' }, el('span', { class: 'field-label', text: _t('相關專案') }), proj)),
      text, el('div', { class: 'ai-row ai-btns' }, go), out);
  }

  function meetingList() {
    const ms = S.meetings;
    return el('section', { class: 'ai-card' }, el('h2', { html: svg('file') + esc(_t('會議紀錄（{0}）', ms.length)) }),
      ms.length ? el('div', { class: 'my-works' }, ...ms.map(m => el('a', { class: 'my-work', href: `#/aipm/meetings/${m.id}` }, el('b', { text: m.title }),
        el('small', { class: 'hint', text: `${m.held_on || m.at.slice(0, 10)}${m.mine ? '' : ' · ' + _t('別人整理的')}` }))))
        : el('p', { class: 'hint', text: _t('還沒有會議紀錄。') }));
  }

  async function meetingView(id) {
    let m;
    try { m = await api(`/api/aipm-my/meetings/${id}`); } catch (e) { return el('p', { class: 'ai-err', text: e.message }); }
    const n = m.minutes;
    const list = (title, xs, f = x => x) => xs?.length ? el('div', { class: 'my-sec' }, el('h4', { text: title }), el('ul', {}, ...xs.map(x => el('li', { text: f(x) })))) : null;
    const back = el('a', { class: 'btn btn-sm btn-ghost', href: '#/aipm/meetings', html: svg('chevron-left') + _t('所有會議') });
    const raw = el('details', { class: 'my-raw' }, el('summary', { text: _t('原始內容') }), el('pre', { class: 'aipm-pre', text: m.raw || '' }));
    return el('section', { class: 'ai-card my-meeting' },
      el('div', { class: 'aipm-row' }, back, el('span', { class: 'spacer' }), el('small', { class: 'hint', text: n.model || '' })),
      el('h2', { html: svg('users') + esc(n.title) }), el('p', { class: 'hint', text: `${m.held_on}${n.attendees?.length ? ' · ' + _t('出席：{0}', n.attendees.join('、')) : ''}` }),
      n.summary ? el('div', { class: 'ai-md', html: md(n.summary) }) : null,
      list(_t('討論重點'), n.points), list(_t('決議'), n.decisions, d => d.text),
      list(_t('待辦'), n.actions, a => [a.title, a.owner && _t('負責 {0}', a.owner), a.due && _t('{0} 前', a.due)].filter(Boolean).join(' · ')),
      list(_t('未決問題'), n.open_questions),
      n.sent?.length ? el('div', { class: 'my-sent' }, el('b', { text: _t('已送交核准：') }), el('ul', {}, ...n.sent.map(s => el('li', { text: `${s.title}${s.approvers?.length ? _t('（核准人：{0}）', s.approvers.join('、')) : ''}` })))) : null,
      n.records?.length && m.mine ? recordsBox(n.records, pick => api(`/api/aipm-my/meetings/${id}/record`, { method: 'POST', body: pick }), 0) : null,
      raw);
  }

  // ---------------------------------------------------------------- closures
  function closuresView() {
    const cs = S.closures;
    if (!cs.length) return el('section', { class: 'ai-card' }, el('h2', { html: svg('check') + esc(_t('結案對齊')) }),
      el('p', { class: 'hint', text: _t('沒有等你對齊的結案。項目完成後，AiPM 會請負責的人在這裡確認完成條件與紀錄，並留下結案摘要；沒對齊的會被標記，但不會擋住結案。') }));
    return el('section', { class: 'ai-card' }, el('h2', { html: svg('check') + esc(_t('結案對齊（{0}）', cs.length)) }),
      el('p', { class: 'hint', text: _t('確認完成條件與紀錄，寫一段結案摘要（可以請 AiPM 先寫草稿）。摘要會用你的名義記成該項目的留言。') }),
      ...cs.map(closure));
  }

  function closure(c) {
    const ta = el('textarea', { class: 'textarea', rows: '4', placeholder: _t('做了什麼、結果、是否達到完成條件、留下哪些紀錄、遺留事項') });
    const draftBtn = el('button', { class: 'btn btn-sm', type: 'button', html: svg('sparkles') + _t('AiPM 幫我寫') });
    draftBtn.addEventListener('click', async () => {
      draftBtn.disabled = true;
      try { const r = await api(`/api/aipm-my/closures/${c.id}/draft`, { method: 'POST' }); ta.value = r.text; } catch (e) { toast(e.message, true); }
      draftBtn.disabled = false;
    });
    const ok = el('button', { class: 'btn btn-sm btn-primary', type: 'button', html: svg('check') + _t('完成對齊') });
    ok.addEventListener('click', async () => {
      if (ta.value.trim().length < 4) { toast(_t('請寫一段結案摘要'), true); ta.focus(); return; }
      ok.disabled = true;
      try { await api(`/api/aipm-my/closures/${c.id}/align`, { method: 'POST', body: { summary: ta.value.trim() } }); toast(_t('已完成結案對齊')); await refresh(); } catch (e) { toast(e.message, true); ok.disabled = false; }
    });
    return el('div', { class: 'my-close' },
      el('div', { class: 'aipm-it-head' }, el('b', { text: c.title }), el('small', { class: 'hint', text: `${c.card_title !== c.title ? c.card_title + ' · ' : ''}${_t('完成於 {0}', String(c.closed_at || '').slice(0, 10))}` })),
      el('ul', { class: 'my-checks' }, ...c.checks.map(x => el('li', { class: x.ok ? 'ok' : 'no', html: svg(x.ok ? 'check' : 'x') + esc(x.text) }))),
      ta, el('div', { class: 'aipm-row' }, draftBtn, el('span', { class: 'spacer' }), ok));
  }

  window.TTAIPMMY = { render, badge };
})();
