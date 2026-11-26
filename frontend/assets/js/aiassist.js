/* IPMS — AI 助理 (#/ai, #/ai/project/<id>) and the 「AI 建議」 dialog of the card / subtask editors.
   The server (app/ai_assist.py) builds the context from what this person may see and asks the AI 接入點;
   in 並行 mode every model's answer comes back and is shown in its own tab. */
(() => {
  const { el, svg, api, toast, esc } = TT;
  let status = null, loading = null;

  /** Whether AI features are on for this person (cached; GET /api/ai/status). */
  function load(force = false) {
    if (loading && !force) return loading;
    loading = api('/api/ai/status').then(s => { status = s; return s; }).catch(() => { status = { enabled: false }; return status; });
    return loading;
  }

  // ---------------------------------------------------------------- Markdown (headings, lists, tables, bold, code)
  function inline(s) {
    return esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>');
  }
  function md(text) {
    const lines = String(text || '').replace(/\r/g, '').split('\n');
    const out = [];
    let list = null, table = null;
    const flush = () => {
      if (list) { out.push(`<${list.t}>${list.items.map(x => `<li>${x}</li>`).join('')}</${list.t}>`); list = null; }
      if (table) {
        const [h, ...rows] = table.filter(r => !/^\s*\|?\s*:?-{2,}/.test(r.join('')));
        out.push(`<div class="ai-md-table"><table><thead><tr>${h.map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
        table = null;
      }
    };
    for (const raw of lines) {
      const line = raw.trimEnd();
      let m;
      if (/^\s*\|.*\|\s*$/.test(line)) {
        if (list) flush();
        (table = table || []).push(line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim()));
        continue;
      }
      if (table) flush();
      if ((m = line.match(/^(#{1,4})\s+(.*)$/))) { flush(); out.push(`<h${Math.min(6, m[1].length + 2)}>${inline(m[2])}</h${Math.min(6, m[1].length + 2)}>`); }
      else if ((m = line.match(/^\s*[-*•]\s+(.*)$/))) { if (!list || list.t !== 'ul') { flush(); list = { t: 'ul', items: [] }; } list.items.push(inline(m[1])); }
      else if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) { if (!list || list.t !== 'ol') { flush(); list = { t: 'ol', items: [] }; } list.items.push(inline(m[1])); }
      else if (!line.trim()) flush();
      else { flush(); out.push(`<p>${inline(line)}</p>`); }
    }
    flush();
    return out.join('');
  }

  /** One /api/ai answer: tabs per model in parallel mode; meta line; Markdown; copy. */
  function resultView(res, { onUse } = {}) {
    const box = el('div', { class: 'ai-view' });
    if (!res || !res.results) return box;
    const shown = res.mode === 'parallel' ? res.results : [res.answer || res.results[res.results.length - 1]].filter(Boolean);
    const failedBefore = res.mode !== 'parallel' ? res.results.filter(r => !r.ok) : [];
    let cur = 0;
    const tabs = el('div', { class: 'ai-tabs', hidden: shown.length < 2 });
    const pane = el('div', { class: 'ai-pane' });
    const paint = () => {
      const r = shown[cur];
      tabs.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-pressed', String(i === cur)));
      const copy = el('button', { class: 'btn btn-sm btn-ghost', type: 'button', html: svg('copy') + _t('複製') });
      copy.addEventListener('click', async () => { try { await navigator.clipboard.writeText(r.text); toast(_t('已複製')); } catch { /* ignore */ } });
      const use = onUse && r.ok ? el('button', { class: 'btn btn-sm', type: 'button', html: svg('plus') + _t('加到說明') }) : null;
      use?.addEventListener('click', () => onUse(r.text));
      pane.replaceChildren(
        el('div', { class: 'ai-meta' }, el('span', { class: 'ai-loc ai-loc-' + (r.location || 'onprem'), text: r.location === 'cloud' ? _t('雲端') : _t('地端') }),
          el('b', { text: r.name }), el('span', { class: 'hint', text: `${r.model || ''} · ${(r.latency_ms / 1000).toFixed(1)}s` + (r.ok ? ` · ${r.input_tokens}+${r.output_tokens} token` : '') }),
          el('span', { class: 'spacer' }), use, r.ok ? copy : null),
        r.ok ? el('div', { class: 'ai-md', html: md(r.text) }) : el('p', { class: 'ai-err', text: r.error }));
    };
    shown.forEach((r, i) => {
      const b = el('button', { type: 'button', class: 'ai-tab' + (r.ok ? '' : ' fail'), text: r.name });
      b.addEventListener('click', () => { cur = i; paint(); });
      tabs.append(b);
    });
    if (shown.length) paint();
    box.append(tabs, pane);
    if (failedBefore.length) box.append(el('p', { class: 'hint', text: _t('已略過無法回覆的服務：{0}', failedBefore.map(r => `${r.name}（${r.error}）`).join('；')) }));
    return box;
  }

  // ---------------------------------------------------------------- 「AI 建議」 for one card / subtask
  async function suggest({ card_id, comment_id = null, title = '' }, onUse) {
    const body = el('div', {}, el('p', { class: 'hint', text: _t('AI 正在整理建議內容、任務執行流程與紀錄所需截圖…') }));
    const wrap = el('div', { class: 'modal' });
    const closeBtn = el('button', { class: 'icon-btn', type: 'button', 'aria-label': _t('關閉'), html: svg('x') });
    const card = el('div', { class: 'modal-card modal-wide ai-modal', role: 'dialog', 'aria-modal': 'true' },
      el('div', { class: 'modal-head' }, el('h3', { html: svg('sparkles') + esc(_t('AI 建議：{0}', title)) }), closeBtn), el('div', { class: 'modal-body' }, body));
    wrap.append(card);
    const done = () => { wrap.remove(); document.removeEventListener('keydown', onKey, true); };
    const onKey = e => { if (e.key === 'Escape') { e.stopImmediatePropagation(); done(); } };
    closeBtn.addEventListener('click', done);
    wrap.addEventListener('mousedown', e => { if (e.target === wrap) done(); });
    document.addEventListener('keydown', onKey, true);
    document.body.append(wrap);
    try {
      const r = await api('/api/ai/task-suggest', { method: 'POST', body: { card_id, comment_id } });
      body.replaceChildren(resultView(r.result, onUse ? { onUse: text => { onUse(text); toast(_t('已加到說明，記得儲存')); done(); } } : {}),
        el('p', { class: 'hint', text: _t('AI 的建議僅供參考，請確認後再採用。') }));
    } catch (e) { body.replaceChildren(el('p', { class: 'ai-err', text: e.message })); }
  }

  // ---------------------------------------------------------------- the page
  const KINDS = [['summary', 'grid', _t('進度摘要')], ['blocked', 'zap', _t('卡住或逾期項目的處理建議')], ['week', 'calendar', _t('週進度（完成／未完成）')], ['next_week', 'flag', _t('下週排程工作建議')]];

  async function render(view, args = {}) {
    await load();
    const head = el('div', { class: 'page-head' }, el('div', { class: 'page-title-row' }, el('span', { class: 'page-icon', html: svg('sparkles') }),
      el('div', { class: 'page-title-text' }, el('h1', { class: 'page-title', text: _t('AI 助理') }), el('p', { class: 'page-desc', text: _t('用後台設定的 AI 接入點整理進度、給處理建議、排下週工作，或生成整個專案。只會送出你看得到的工作。') }))));
    if (!status.enabled) {
      view.replaceChildren(head, el('div', { class: 'empty' }, el('div', { class: 'empty-icon', html: svg('sparkles') }), el('h3', { text: _t('AI 助理尚未啟用') }),
        el('p', { text: _t('請系統管理員到後台「系統設定 → AI 接入點」新增至少一個可用的服務並啟用。') })));
      return;
    }
    const cards = (window.TTBoard ? await TTBoard.load().catch(() => []) : []) || [];
    const projects = (TTBoard.tasks || cards || []).filter(t => t.kind === 'project');
    let scope = args.project ? 'project' : 'mine';
    const projSel = el('select', { class: 'select' }, ...projects.map(p => el('option', { value: p.id, text: p.title, selected: p.id === args.project })));
    projSel.hidden = scope !== 'project';
    const scopeSeg = el('div', { class: 'segmented', role: 'group' }, ...[['mine', _t('我的工作')], ['project', _t('專案')], ['all', _t('我看得到的全部')]].map(([v, l]) => {
      const b = el('button', { type: 'button', dataset: { v }, text: l, disabled: v === 'project' && !projects.length });
      b.addEventListener('click', () => { scope = v; paintScope(); });
      return b;
    }));
    const paintScope = () => { scopeSeg.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.v === scope))); projSel.hidden = scope !== 'project'; };
    paintScope();
    const out = el('div', { class: 'ai-out' });
    const btns = KINDS.map(([k, icon, label]) => {
      const b = el('button', { class: 'btn', type: 'button', html: svg(icon) + esc(label) });
      b.addEventListener('click', () => runReport(k, label, b));
      return b;
    });
    async function runReport(kind, label, btn) {
      btns.forEach(b => { b.disabled = true; });
      out.replaceChildren(el('div', { class: 'ai-wait', html: svg('sparkles') + esc(_t('AI 正在整理「{0}」…', label)) }));
      try {
        const r = await api('/api/ai/report', { method: 'POST', body: { kind, scope, project_id: scope === 'project' ? Number(projSel.value) : null } });
        out.replaceChildren(reportView(r));
      } catch (e) { out.replaceChildren(el('p', { class: 'ai-err', text: e.message })); }
      btns.forEach(b => { b.disabled = false; });
      void btn;
    }
    const reportCard = el('section', { class: 'ai-card' },
      el('h2', { html: svg('grid') + esc(_t('進度與排程')) }),
      el('div', { class: 'ai-row' }, el('span', { class: 'ai-label', text: _t('範圍') }), scopeSeg, projSel),
      el('div', { class: 'ai-row ai-btns' }, ...btns), out);
    view.replaceChildren(head, reportCard, projectCard());
    window.TTAIPM?.inbox().then(box => { if (box && reportCard.isConnected) reportCard.before(box); });
    if (args.project && args.run) runReport(args.run, (KINDS.find(k => k[0] === args.run) || [])[2] || '', null);
  }

  function itemList(title, xs) {
    const ST = { recurring: _t('週期工作'), overdue: _t('過期未結案'), new: _t('新建'), ongoing: _t('進行中'), pending: _t('待確認'), onhold: _t('暫緩'), complete: _t('完成'), canceled: _t('取消') };
    return el('details', { class: 'ai-list', open: xs.length && xs.length <= 12 }, el('summary', { text: `${title}（${xs.length}）` }),
      xs.length ? el('ul', {}, ...xs.slice(0, 200).map(x => el('li', {}, el('code', { text: x.code }), ' ', el('span', { text: x.title }),
        el('small', { class: 'hint', text: ` · ${ST[x.status] || x.status}${x.who ? ' · ' + x.who : ''}${x.due ? ' · ' + _t('到期 {0}', x.due.slice(5)) : ''}${x.done_at && x.status === 'complete' ? ' · ' + _t('完成 {0}', x.done_at.slice(5)) : ''}${x.blocked ? ' · ⛔ ' + x.blocked : ''}` }))))
        : el('p', { class: 'hint', text: _t('無') }));
  }

  function reportView(r) {
    const L = r.lists, c = L.counts;
    const chips = el('div', { class: 'ai-chips' }, ...[[_t('項目'), c.items], [_t('完成'), `${c.done}（${c.pct}%）`], [_t('逾期'), c.overdue], [_t('卡住'), c.blocked],
      [_t('本週完成'), c.done_week], [_t('本週未完成'), c.undone_week]].map(([k, v]) => el('span', { class: 'ai-chip' }, el('small', { text: k }), el('b', { text: String(v) }))));
    const lists = el('div', { class: 'ai-lists' },
      itemList(_t('本週已完成（{0}～{1}）', L.week[0].slice(5), L.week[1].slice(5)), L.done_week),
      itemList(_t('本週未完成'), L.undone_week), itemList(_t('逾期'), L.overdue), itemList(_t('卡住'), L.blocked),
      itemList(_t('下週候選工作（{0}～{1}）', L.next_week[0].slice(5), L.next_week[1].slice(5)), L.candidates_next));
    return el('div', {}, el('h3', { class: 'ai-title', text: r.title }), chips,
      r.empty ? el('p', { class: 'hint', text: _t('這個範圍沒有任何工作。') }) : resultView(r.result),
      el('p', { class: 'hint', text: _t('下面的清單由系統直接計算（不是 AI 產生），可以用來核對 AI 的內容。') }), lists);
  }

  // ---------------------------------------------------------------- 生成專案
  function projectCard() {
    const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const name = el('input', { class: 'input', maxlength: '200', placeholder: _t('例如：核心交換器汰換、主機房 UPS 更換') });
    const brief = el('textarea', { class: 'textarea', rows: '5', placeholder: _t('目標、範圍、限制與已知條件：設備型號、數量、停機窗口、驗收方式、參與部門…（越具體，規劃越準）') });
    const start = el('input', { class: 'input', type: 'date', value: iso(new Date()) });
    const end = el('input', { class: 'input', type: 'date' });
    const levels = el('select', { class: 'select' }, ...[2, 3, 4, 5].map(n => el('option', { value: n, text: _t('{0} 層', n), selected: n === 3 })));
    const go = el('button', { class: 'btn btn-primary', type: 'button', html: svg('sparkles') + _t('生成專案規劃') });
    const out = el('div', { class: 'ai-out' });
    go.addEventListener('click', async () => {
      if (!name.value.trim()) { toast(_t('請輸入專案名稱'), true); name.focus(); return; }
      go.disabled = true;
      out.replaceChildren(el('div', { class: 'ai-wait', html: svg('sparkles') + esc(_t('AI 正在規劃專案（工作項目、執行流程、截圖紀錄）…可能需要一兩分鐘')) }));
      try {
        const r = await api('/api/ai/project/draft', { method: 'POST', body: { name: name.value, brief: brief.value, start: start.value || null, end: end.value || null, levels: Number(levels.value) } });
        out.replaceChildren(draftsView(r.drafts, start.value));
      } catch (e) { out.replaceChildren(el('p', { class: 'ai-err', text: e.message })); }
      go.disabled = false;
    });
    const f = (label, c) => el('label', { class: 'field' }, el('span', { class: 'field-label', text: label }), c);
    return el('section', { class: 'ai-card' }, el('h2', { html: svg('layout') + esc(_t('生成專案')) }),
      el('p', { class: 'hint', text: _t('描述專案，AI 會規劃主任務、子任務與時程，並為每一項寫出建議內容、任務執行流程與需要保留的截圖紀錄。先預覽、勾選要的項目，按「建立專案」才會真的建立。') }),
      el('div', { class: 'ai-form' }, f(_t('專案名稱'), name), f(_t('開始日'), start), f(_t('希望完成日（選填）'), end), f(_t('拆到第幾層'), levels)),
      f(_t('需求與範圍'), brief), el('div', { class: 'ai-row' }, go), out);
  }

  function draftsView(drafts, startDate) {
    const ok = drafts.filter(d => d.ok);
    const box = el('div', { class: 'ai-drafts' });
    const failed = drafts.filter(d => !d.ok);
    if (!ok.length) {
      box.append(el('p', { class: 'ai-err', text: _t('沒有可用的規劃：{0}', failed.map(d => `${d.name}（${d.error}）`).join('；')) }));
      return box;
    }
    let cur = 0;
    const tabs = el('div', { class: 'ai-tabs', hidden: ok.length < 2 });
    const pane = el('div', {});
    ok.forEach((d, i) => { const b = el('button', { type: 'button', class: 'ai-tab', text: `${d.name}` }); b.addEventListener('click', () => { cur = i; paint(); }); tabs.append(b); });
    const paint = () => {
      tabs.querySelectorAll('button').forEach((b, i) => b.setAttribute('aria-pressed', String(i === cur)));
      pane.replaceChildren(planView(ok[cur], startDate));
    };
    paint();
    box.append(tabs, pane);
    if (failed.length) box.append(el('p', { class: 'hint', text: _t('無法產生規劃的服務：{0}', failed.map(d => `${d.name}（${d.error}）`).join('；')) }));
    return box;
  }

  function planView(d, startDate) {
    const plan = JSON.parse(JSON.stringify(d.plan));
    const s0 = new Date((startDate || new Date().toISOString().slice(0, 10)) + 'T00:00');
    const day = n => { const x = new Date(s0); x.setDate(x.getDate() + n); return `${x.getMonth() + 1}/${x.getDate()}`; };
    const title = el('input', { class: 'input ai-plan-title', value: plan.title, maxlength: '200' });
    const node = (t, code, depth) => {
      t.keep = true;
      const chk = el('input', { type: 'checkbox', checked: true });
      const kids = el('div', { class: 'ai-plan-kids' }, ...t.children.map((c, i) => node(c, depth === 1 ? `${code}-${i + 1}` : `${code}.${i + 1}`, depth + 1)));
      chk.addEventListener('change', () => { t.keep = chk.checked; row.classList.toggle('off', !chk.checked); kids.querySelectorAll('input[type=checkbox]').forEach(x => { x.disabled = !chk.checked; }); });
      const info = el('details', { class: 'ai-plan-info' }, el('summary', {},
        el('code', { text: code }), ' ', el('b', { text: t.title }), t.milestone ? ' ◆' : '',
        el('small', { class: 'hint', text: ` · ${t.milestone ? day(t.start_day) : `${day(t.start_day)}–${day(t.start_day + Math.max(0, t.days - 1))}（${t.days} ${_t('天')}）`}` })),
        t.description ? el('p', { text: t.description }) : null,
        t.flow.length ? el('div', {}, el('small', { class: 'ai-sub', text: _t('執行流程') }), el('ol', {}, ...t.flow.map(x => el('li', { text: x })))) : null,
        t.screenshots.length ? el('div', {}, el('small', { class: 'ai-sub', text: _t('紀錄所需截圖') }), el('ul', {}, ...t.screenshots.map(x => el('li', { text: '📷 ' + x })))) : null);
      const row = el('div', { class: 'ai-plan-node', style: { '--depth': depth } }, el('label', { class: 'ai-plan-chk' }, chk), info);
      return el('div', {}, row, kids);
    };
    const tree = el('div', { class: 'ai-plan-tree' }, ...plan.tasks.map((t, i) => node(t, `A${i + 1}`, 1)));
    const count = ts => ts.reduce((n, t) => n + 1 + count(t.children), 0);
    const mk = () => el('button', { class: 'btn btn-primary', type: 'button', html: svg('check') + esc(_t('建立專案')) });
    const create = mk(), create2 = mk();
    create2.addEventListener('click', () => create.click());
    create.addEventListener('click', async () => {
      const prune = ts => ts.filter(t => t.keep).map(t => ({ ...t, children: prune(t.children) }));
      const body = { plan: { ...plan, title: title.value.trim() || plan.title, tasks: prune(plan.tasks) }, start: startDate || null };
      if (!body.plan.tasks.length) { toast(_t('至少保留一項工作'), true); return; }
      create.disabled = create2.disabled = true;
      try {
        const r = await api('/api/ai/project/create', { method: 'POST', body });
        toast(_t('已建立專案「{0}」：{1} 個項目', body.plan.title, r.items));
        if (window.TTBoard) await TTBoard.load(true).catch(() => {});
        location.hash = `#/project/${r.id}`;
      } catch (e) { toast(e.message, true); create.disabled = create2.disabled = false; }
    });
    return el('div', { class: 'ai-plan' },
      el('div', { class: 'ai-meta' }, el('span', { class: 'hint', text: `${d.model || ''} · ${(d.latency_ms / 1000).toFixed(1)}s · ${_t('{0} 項工作', count(plan.tasks))}` }), el('span', { class: 'spacer' }), create2),
      el('label', { class: 'field' }, el('span', { class: 'field-label', text: _t('專案名稱') }), title),
      plan.description ? el('p', { class: 'ai-plan-desc', text: plan.description }) : null,
      el('p', { class: 'hint', text: _t('點項目展開建議內容、執行流程與截圖；取消勾選的項目（連同底下）不會建立。日期依開始日推算，之後可以在專案頁調整。') }),
      tree, el('div', { class: 'ai-row' }, create));
  }

  window.TTAI = { load, get on() { return !!status?.enabled; }, render, suggest, resultView, md };
})();
