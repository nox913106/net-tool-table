/* =============================================================================
   IPMS — header clock + network info
   Time is synced against this server (/api/time), not a third-party service.
   ============================================================================= */
'use strict';

const TTClock = (() => {
  const WEEK = [_t('日'), _t('一'), _t('二'), _t('三'), _t('四'), _t('五'), _t('六')];
  let offset = 0;

  /** ISO-8601 week number (weeks start on Monday; week 1 contains the first Thursday) */
  function isoWeek(date) {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const day = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - day);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return { year: d.getUTCFullYear(), week: Math.ceil(((d - yearStart) / 86400000 + 1) / 7) };
  }

  async function sync() {
    try {
      const t0 = Date.now();
      const { now } = await TT.api('/api/time');
      const t1 = Date.now();
      offset = now - Math.round((t0 + t1) / 2);
      if (Math.abs(offset) < 500) offset = 0;   // within half a second: trust the local clock
    } catch { /* keep local time */ }
  }

  const pad = n => String(n).padStart(2, '0');

  // Each half is a clipping box holding a full-height glyph; the bottom halves shift the
  // glyph up by half a tile. Only the correct half of the digit can ever be visible.
  //   .flip-top     new digit, upper half (revealed as the leaf falls)
  //   .flip-bottom  old digit, lower half (covered by the leaf at the end)
  //   .flip-leaf    front = old upper half, back = new lower half; rotates 0 → -180°
  function flipDigit(initial) {
    const d = TT.el('span', { class: 'flip' });
    d.innerHTML =
      '<span class="flip-half flip-top"><span class="g"></span></span>' +
      '<span class="flip-half flip-bottom"><span class="g"></span></span>' +
      '<span class="flip-leaf">' +
        '<span class="flip-half leaf-front"><span class="g"></span></span>' +
        '<span class="flip-half leaf-back"><span class="g"></span></span>' +
      '</span>';
    setDigit(d, initial, false);
    return d;
  }

  function setDigit(d, v, animate = true) {
    const old = d.dataset.v;
    if (old === v) return;
    d.dataset.v = v;
    const glyph = sel => d.querySelector(sel + ' > .g');
    const top = glyph('.flip-top'), bottom = glyph('.flip-bottom');
    const front = glyph('.leaf-front'), back = glyph('.leaf-back');
    const leaf = d.querySelector('.flip-leaf');
    if (!animate || old === undefined) {
      top.textContent = bottom.textContent = front.textContent = back.textContent = v;
      return;
    }
    top.textContent = v;
    bottom.textContent = old;
    front.textContent = old;
    back.textContent = v;
    d.classList.remove('flipping');
    void d.offsetWidth;            // restart the animation
    d.classList.add('flipping');
    leaf.addEventListener('animationend', () => {
      bottom.textContent = front.textContent = v;
      d.classList.remove('flipping');
    }, { once: true });
  }

  // HUD readout HH:MM:SS.mmm — each character in a fixed-width cell (no jitter as digits change),
  // zero drawn with a slash; striped phosphor glyphs and glow come from tactical.css
  function mountHud(time, now, perfLow) {
    const cell = ch => TT.el('span', { class: 'hud-c' + (ch === ':' || ch === '.' ? ' hud-sep' : '') + (ch === '.' ? ' dot' : '') + (ch === '0' ? ' z' : ''), text: ch });
    const main = TT.el('span', { class: 'hud-main' });
    const ms = TT.el('span', { class: 'hud-ms' });
    time.replaceChildren(main, ms);
    const cells = [];
    for (const ch of '00:00:00') { const c = cell(ch); cells.push(c); main.append(c); }
    for (const ch of '.000') { const c = cell(ch); cells.push(c); ms.append(c); }
    const pad3 = n => String(n).padStart(3, '0');
    const draw = () => {
      const d = now();
      const text = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad3(d.getMilliseconds())}`;
      for (let i = 0; i < text.length; i++) {
        const c = cells[i];
        if (c.textContent !== text[i]) { c.textContent = text[i]; c.classList.toggle('z', text[i] === '0'); }
      }
    };
    const loop = () => { if (time.isConnected) { draw(); requestAnimationFrame(loop); } };
    if (perfLow) { draw(); setInterval(draw, 250); }          // low-performance mode: 4 updates a second
    else requestAnimationFrame(loop);
    return draw;
  }

  function mount(root, settings) {
    root.hidden = false;
    // 'hud' (default) — the old 'flip' default counts as hud too; 'simple' = plain text
    const style = settings.clock_style === 'simple' ? 'simple' : 'hud';
    root.classList.toggle('clock-flip', false);
    root.classList.toggle('clock-hud', style === 'hud');
    const showSec = settings.clock_show_seconds !== false;
    const time = TT.el('div', { class: 'clock-time' });
    const date = TT.el('div', { class: 'clock-date' });
    root.replaceChildren(time, date);

    const now = () => new Date(Date.now() + offset);
    const parts = d => [pad(d.getHours()), pad(d.getMinutes()), ...(showSec ? [pad(d.getSeconds())] : [])];
    const ymd = TT.el('span', { class: 'clock-ymd' });
    const wk = TT.el('span', { class: 'clock-wk' });
    date.append(ymd, wk);
    const paintDate = d => {
      const w = isoWeek(d);
      ymd.textContent = `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())}`;
      wk.textContent = _t("第 {0} 週 · 星期{1}", w.week, WEEK[d.getDay()]);
      date.title = _t("{0} 年 {1} 月 {2} 日，星期{3}\nISO 週次：{4} 年第 {5} 週", d.getFullYear(), d.getMonth() + 1, d.getDate(), WEEK[d.getDay()], w.year, w.week);
    };

    const hud = style === 'hud' ? mountHud(time, now, document.documentElement.dataset.perf === 'low') : null;

    let lastDay = -1;
    const tick = () => {
      const d = now();
      if (hud) hud();
      else time.textContent = parts(d).join(':');
      if (d.getDate() !== lastDay) { lastDay = d.getDate(); paintDate(d); }
    };
    tick();
    // align ticks to the second boundary
    setTimeout(() => { tick(); setInterval(tick, 1000); }, 1000 - (now().getMilliseconds()));

    sync().then(tick);
    setInterval(sync, 30 * 60 * 1000);
  }

  async function mountNetInfo(root, settings) {
    const chips = [];
    if (settings.show_client_ip) {
      try {
        const w = await TT.api('/api/whoami');
        const title = w.local
          ? _t("這台電腦的 IP（{0}）", w.host || '') + ((w.all || []).length > 1 ? _t('\n全部：') + w.all.join('、') : '')
          : _t('你的 IP（本伺服器看到的位址）');
        if (w.ip) chips.push(TT.el('span', { class: 'net-chip', title },
          TT.el('span', { class: 'net-dot' }), w.ip));
      } catch { /* ignore */ }
    }
    if (settings.show_public_ip) {
      try {
        const res = await fetch('https://ipinfo.io/json', { cache: 'no-store' });
        const j = await res.json();
        if (j && j.ip) {
          const place = [j.city, j.country].filter(Boolean).join(', ');
          chips.push(TT.el('a', {
            class: 'net-chip', href: `https://ipinfo.io/${encodeURIComponent(j.ip)}`, target: '_blank', rel: 'noopener',
            title: _t('對外 IP（ipinfo.io）'), html: TT.svg('globe') + TT.esc(j.ip) + (place ? ` <span class="muted">· ${TT.esc(place)}</span>` : ''),
          }));
        }
      } catch { /* offline / blocked */ }
    }
    if (chips.length) { root.replaceChildren(...chips); root.hidden = false; }
  }

  /** 5 quick clicks on any of these elements opens the admin page */
  function secretAdmin(...els) {
    let count = 0, timer = null;
    els.filter(Boolean).forEach(e => e.addEventListener('click', () => {
      count++;
      clearTimeout(timer);
      if (count >= 5) { count = 0; location.href = '/admin'; }
      else timer = setTimeout(() => { count = 0; }, 3000);
    }));
  }

  return { mount, mountNetInfo, secretAdmin, isoWeek, now: () => new Date(Date.now() + offset) };
})();
