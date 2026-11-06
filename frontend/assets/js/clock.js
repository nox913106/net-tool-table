/* =============================================================================
   Tool Table — header clock + network info
   Time is synced against this server (/api/time), not a third-party service.
   ============================================================================= */
'use strict';

const TTClock = (() => {
  const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
  let offset = 0;

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

  function mount(root, settings) {
    root.hidden = false;
    root.classList.toggle('clock-flip', settings.clock_style !== 'simple');
    const showSec = settings.clock_show_seconds !== false;
    const time = TT.el('div', { class: 'clock-time' });
    const date = TT.el('div', { class: 'clock-date' });
    root.replaceChildren(time, date);

    const now = () => new Date(Date.now() + offset);
    const parts = d => [pad(d.getHours()), pad(d.getMinutes()), ...(showSec ? [pad(d.getSeconds())] : [])];
    const dateText = d => `${d.getMonth() + 1}/${d.getDate()} 週${WEEK[d.getDay()]}`;

    let digits = null;
    if (settings.clock_style !== 'simple') {
      digits = [];
      parts(now()).forEach((p, i) => {
        if (i) time.append(TT.el('span', { class: 'clock-sep', text: ':' }));
        const pair = TT.el('span', { class: 'flip-pair' });
        for (const ch of p) { const fd = flipDigit(ch); digits.push(fd); pair.append(fd); }
        time.append(pair);
      });
    }

    const tick = () => {
      const d = now();
      if (digits) parts(d).join('').split('').forEach((ch, i) => setDigit(digits[i], ch));
      else time.textContent = parts(d).join(':');
      date.textContent = dateText(d);
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
        const { ip } = await TT.api('/api/whoami');
        if (ip) chips.push(TT.el('span', { class: 'net-chip', title: '你的 IP（本伺服器看到的位址）' },
          TT.el('span', { class: 'net-dot' }), ip));
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
            title: '對外 IP（ipinfo.io）', html: TT.svg('globe') + TT.esc(j.ip) + (place ? ` <span class="muted">· ${TT.esc(place)}</span>` : ''),
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

  return { mount, mountNetInfo, secretAdmin };
})();
