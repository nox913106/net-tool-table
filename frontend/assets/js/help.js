/* IPMS — 使用說明頁（#/help、#/help/<section>）
   內容在 help-zh.js / help-en.js（依介面語言），這裡只負責目錄、搜尋與展開收合。 */
(() => {
  const { el, svg } = TT;
  const content = () => (window.TT_LANG === 'en' && window.TT_HELP_EN) || window.TT_HELP_ZH || [];
  const plain = html => { const d = document.createElement('div'); d.innerHTML = html; return d.textContent; };

  function render(view, anchor) {
    const secs = content();
    const q = el('input', { class: 'input', type: 'search', placeholder: _t('搜尋說明…'), 'aria-label': _t('搜尋說明') });
    const openAll = el('button', { class: 'btn', type: 'button', text: _t('全部展開') });
    const closeAll = el('button', { class: 'btn', type: 'button', text: _t('全部收合') });
    const head = el('div', { class: 'page-head' }, el('div', { class: 'page-title-row' },
      el('span', { class: 'page-icon', html: svg('help') }),
      el('div', { class: 'page-title-text' }, el('h1', { class: 'page-title', text: _t('使用說明') }),
        el('p', { class: 'page-desc', text: _t('依功能分類說明每一個頁面；卡片的每個標示、欄位、按鈕與選項在「看板上的卡片」「卡片編輯視窗」「子任務」「任務視窗」「留言」各節，編號規則在「卡片編號規則」。') }))));
    const toc = el('nav', { class: 'help-toc', 'aria-label': _t('目錄') });
    const empty = el('p', { class: 'hint', hidden: true, text: _t('找不到符合的說明。') });
    const body = el('div', { class: 'help-body' });
    const parts = secs.map(s => {
      const items = s.items.map(it => {
        const d = el('details', { class: 'help-item', open: true },
          el('summary', { text: it.h }), el('div', { class: 'help-text', html: it.b }));
        d._text = (it.h + ' ' + plain(it.b)).toLowerCase();
        return d;
      });
      const sec = el('section', { class: 'help-sec', id: 'help-' + s.id },
        el('h2', {}, el('span', { class: 'help-ico', html: svg(s.icon) }), s.title),
        s.intro ? el('p', { class: 'help-intro', text: s.intro }) : null, ...items);
      sec._intro = (s.title + ' ' + (s.intro || '')).toLowerCase();
      const link = el('a', { href: '#/help/' + s.id, class: 'help-toc-item' }, el('span', { html: svg(s.icon) }), s.title);
      link.addEventListener('click', e => { e.preventDefault(); history.replaceState(null, '', '#/help/' + s.id); jump(sec); });
      toc.append(link);
      return { sec, items, link };
    });
    body.append(...parts.map(p => p.sec), empty);
    view.replaceChildren(head, el('div', { class: 'help-tools' }, q, openAll, closeAll), el('div', { class: 'help-wrap' }, toc, body));

    const jump = sec => { sec.querySelectorAll('details').forEach(d => { d.open = true; }); sec.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
    openAll.addEventListener('click', () => body.querySelectorAll('details').forEach(d => { d.open = true; }));
    closeAll.addEventListener('click', () => body.querySelectorAll('details').forEach(d => { d.open = false; }));
    q.addEventListener('input', () => {
      const words = q.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      let any = false;
      for (const p of parts) {
        const secHit = words.length && words.every(w => p.sec._intro.includes(w));
        let n = 0;
        for (const d of p.items) {
          const hit = !words.length || secHit || words.every(w => d._text.includes(w));
          d.hidden = !hit; if (hit) { n++; if (words.length) d.open = true; }
        }
        p.sec.hidden = !n; p.link.hidden = !n; any = any || n > 0;
      }
      empty.hidden = any;
    });
    const target = anchor && parts.find(p => p.sec.id === 'help-' + anchor);
    if (target) requestAnimationFrame(() => target.sec.scrollIntoView({ block: 'start' }));
  }

  window.TTHelp = { render };
})();
