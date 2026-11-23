/* =============================================================================
   Tool Table — task radar (floating, tactical skin)
   Distance = urgency: the closer to the centre, the sooner it is due
     centre ring = overdue · today · ≤3 days · ≤7 days · ≤30 days · outer edge = later / no due date
   Quadrant = the card:  I high priority · II normal · III low · IV Pending / On hold / Canceled
   A card is a diamond, its open subtasks (every level) small dots around it; a card sits on the ring of
   its most urgent open item, and overdue subtasks count as overdue. A sweep turns every 6 s; a blip
   lights up as the beam passes it; overdue blips also pulse. Hover shows the item, click opens it.
   ============================================================================= */
(() => {
  const { el } = TT;
  const NS = 'http://www.w3.org/2000/svg';
  const PERIOD = 6;                                    // seconds per sweep
  const start = performance.now();
  const RINGS = [                                      // [label, outer radius 0..1, class]
    ['逾期', .24, 'crit'], ['今天', .38, 'warn'], ['3 天', .52, 'warn'], ['7 天', .67, 'ok'], ['30 天', .84, 'ok'], ['之後', 1, 'idle'],
  ];
  const s = (tag, attrs = {}) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
  const hash = n => { let h = 2166136261; for (const c of String(n)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return (h >>> 0) / 4294967296; };

  function daysLeft(due) {
    if (!due) return null;
    const [d, tm] = due.split('T');
    const [y, m, dd] = d.split('-').map(Number);
    const end = new Date(y, m - 1, dd, ...(tm ? tm.split(':').map(Number) : [23, 59]));
    return (end - new Date()) / 864e5;
  }
  function ringOf(t) {
    if (t.status === 'overdue') return 0;
    const d = daysLeft(t.due_at);
    if (d == null) return 5;
    if (d < 0) return 0;
    const today = new Date(); today.setHours(23, 59, 59, 999);
    if (new Date(Date.now() + d * 864e5) <= today) return 1;
    return d <= 3 ? 2 : d <= 7 ? 3 : d <= 30 ? 4 : 5;
  }

  const CLOSED = new Set(['complete', 'canceled']);
  const PAUSED = new Set(['pending', 'onhold', 'canceled']);
  // quadrant → bearing range (clockwise from north): I top-right, II top-left, III bottom-left, IV bottom-right
  const QUADS = [
    { key: 'high', label: 'I 高優先', from: 0 },
    { key: 'normal', label: 'II 一般', from: 270 },
    { key: 'low', label: 'III 低', from: 180 },
    { key: 'paused', label: 'IV 暫停', from: 90 },
  ];
  const quadOf = t => PAUSED.has(t.status) ? 3 : t.priority === 'high' ? 0 : t.priority === 'low' ? 2 : 1;
  /** A card's open subtasks at every level, with the path from the card (for the task window). */
  function subsOf(t) {
    const top = (t.subtasks?.items || []).map(x => ({ ...x, parent: null }));
    const all = [...top, ...(t.subtasks?.below || [])];
    const byId = new Map(all.map(x => [x.id, x]));
    const path = x => { const p = []; for (let c = x, n = 0; c && n < 5; c = c.parent ? byId.get(c.parent) : null, n++) p.unshift(c.id); return p; };
    return all.filter(x => !CLOSED.has(x.status)).map(x => ({ ...x, path: path(x) }));
  }
  /** Every open item the radar knows about, for the counts (also used by the collapsed square). */
  function items() {
    const cards = (typeof TTBoard !== 'undefined' ? TTBoard.tasks : []).filter(t => t.status !== 'complete');
    return cards.map(t => {
      const subs = t.status === 'canceled' ? [] : subsOf(t).map(x => ({ ...x, ring: ringOf(x) }));
      const own = t.status === 'canceled' ? RINGS.length - 1 : ringOf(t);
      return { t, own, subs, ring: Math.min(own, ...subs.map(x => x.ring)) };
    });
  }
  const overdueCount = list => list.reduce((n, c) => n + (c.t.status !== 'canceled' && c.own === 0 ? 1 : 0) + c.subs.filter(x => x.ring === 0).length, 0);
  const whenText = (ring, due) => RINGS[ring][0] === '之後' ? (due ? '到期 ' + due.replace('T', ' ') : '未設到期日') : RINGS[ring][0];

  function mount(host) {
    const R = 100;
    const svg = s('svg', { viewBox: '-112 -112 224 224', class: 'radar-svg', role: 'img', 'aria-label': '任務雷達：越靠近中心越緊急；象限依主任務優先順序與狀態' });
    const grid = s('g', { class: 'radar-grid' });
    // quadrant shading + labels
    QUADS.forEach((q, i) => {
      const a0 = q.from * Math.PI / 180, a1 = (q.from + 90) * Math.PI / 180;
      grid.append(s('path', { class: `radar-quad q${i + 1}`, d: `M0 0 L${Math.sin(a0) * R} ${-Math.cos(a0) * R} A${R} ${R} 0 0 1 ${Math.sin(a1) * R} ${-Math.cos(a1) * R} Z` }));
      const mid = (q.from + 45) * Math.PI / 180;
      const tx = s('text', { x: (Math.sin(mid) * R * 1.02).toFixed(1), y: (-Math.cos(mid) * R * 1.02 + (i < 2 ? -2 : 7)).toFixed(1),
        class: 'radar-qlabel', 'text-anchor': i === 0 || i === 3 ? 'start' : 'end' });
      tx.textContent = q.label; grid.append(tx);
    });
    RINGS.forEach(([label, r], i) => {
      grid.append(s('circle', { r: r * R, class: i === RINGS.length - 1 ? 'radar-ring outer' : 'radar-ring' + (i % 2 ? ' dash' : '') }));
      if (i < RINGS.length - 1) {
        const tx = s('text', { x: 3, y: -r * R + 8, class: 'radar-label' }); tx.textContent = label; grid.append(tx);
      }
    });
    grid.append(s('line', { x1: -R, y1: 0, x2: R, y2: 0, class: 'radar-axis' }), s('line', { x1: 0, y1: -R, x2: 0, y2: R, class: 'radar-axis' }));
    for (let a = 0; a < 360; a += 10) {
      const rad = a * Math.PI / 180, long = a % 90 === 0 ? 8 : a % 30 === 0 ? 5 : 2.5;
      grid.append(s('line', { x1: Math.sin(rad) * R, y1: -Math.cos(rad) * R, x2: Math.sin(rad) * (R + long), y2: -Math.cos(rad) * (R + long), class: 'radar-tick' }));
    }
    const blips = s('g', { class: 'radar-blips' });
    svg.append(grid, blips, s('circle', { r: 2.6, class: 'radar-home' }));

    const sweep = el('div', { class: 'radar-sweep' });
    sweep.style.animationDelay = `-${((performance.now() - start) / 1000) % PERIOD}s`;
    const tip = el('div', { class: 'radar-tip', hidden: true });
    const scope = el('div', { class: 'radar-scope' }, sweep, svg, tip);
    const legend = el('div', { class: 'radar-legend' });
    const head = el('div', { class: 'radar-head' }, el('span', { class: 'radar-title', text: '任務雷達' }), el('span', { class: 'radar-sub', text: 'TASK RADAR // SWEEP 6S' }));
    host.replaceChildren(head, el('div', { class: 'radar-body' }, scope, legend));

    const hover = (g, label) => {
      g.addEventListener('mouseenter', () => { tip.textContent = label; tip.hidden = false; });
      g.addEventListener('mouseleave', () => { tip.hidden = true; });
      g.addEventListener('focus', () => { tip.textContent = label; tip.hidden = false; });
      g.addEventListener('blur', () => { tip.hidden = true; });
    };
    let shown = false;                                     // mounted before it is on the page: wait for it
    function paint() {
      if (!host.isConnected) { if (shown) document.removeEventListener('tt:tasks', paint); return; }
      shown = true;
      const list = items();
      const phase = ((performance.now() - start) / 1000) % PERIOD;
      const counts = RINGS.map(() => 0);
      const quadN = QUADS.map(() => 0);
      const nodes = [];
      list.forEach(({ t, own, subs, ring }) => {
        if (t.status !== 'canceled') counts[own]++;
        subs.forEach(x => counts[x.ring]++);
        const q = quadOf(t);
        quadN[q]++;
        const inner = ring ? RINGS[ring - 1][1] : .07, outer = RINGS[ring][1] - .04;
        const r = (inner + (outer - inner) * (.2 + .6 * hash('r' + t.id))) * R;
        const a = QUADS[q].from + 10 + hash(t.id) * 70;   // inside its quadrant, away from the axes
        const rad = a * Math.PI / 180;
        const x = Math.sin(rad) * r, y = -Math.cos(rad) * r;
        const delay = `${(a / 360 * PERIOD - phase).toFixed(2)}s`;   // flash when the beam passes
        // subtasks: small dots on a little orbit around their card
        const orbit = subs.slice(0, 10);
        orbit.forEach((sx, k) => {
          const oa = (k / orbit.length) * Math.PI * 2 + hash('o' + t.id) * Math.PI;
          const ox = x + Math.cos(oa) * 11, oy = y + Math.sin(oa) * 11;
          const g = s('g', { class: `radar-blip radar-kid is-${RINGS[sx.ring][2]}`, transform: `translate(${ox.toFixed(1)} ${oy.toFixed(1)})`, tabindex: '0' });
          const dot = s('circle', { r: 3, class: 'radar-dot' });
          dot.style.animationDelay = delay;
          g.append(s('line', { x1: 0, y1: 0, x2: (x - ox).toFixed(1), y2: (y - oy).toFixed(1), class: 'radar-tether' }),
            s('circle', { r: 6.5, class: 'radar-hit' }), ...(sx.ring === 0 ? [s('circle', { r: 3, class: 'radar-pulse' })] : []), dot);
          hover(g, `↳ ${sx.title}　${whenText(sx.ring, sx.due_at)}（${t.title}）`);
          const go = () => TTBoard.openNavigator(t, sx.path);
          g.addEventListener('click', go);
          g.addEventListener('keydown', e => { if (e.key === 'Enter') go(); });
          nodes.push(g);
        });
        const cls = t.status === 'canceled' ? 'idle is-canceled' : RINGS[ring][2];
        const g = s('g', { class: `radar-blip radar-card is-${cls}`, transform: `translate(${x.toFixed(1)} ${y.toFixed(1)})`, tabindex: '0' });
        const dia = s('polygon', { points: '0,-6.4 6.4,0 0,6.4 -6.4,0', class: 'radar-dot' });
        dia.style.animationDelay = delay;
        g.append(s('circle', { r: 11, class: 'radar-hit' }), ...(ring === 0 && t.status !== 'canceled' ? [s('circle', { r: 6, class: 'radar-pulse' })] : []), dia);
        const lateSubs = subs.filter(sx => sx.ring === 0).length;
        hover(g, `◆ ${t.title}　${t.status === 'canceled' ? '已取消' : whenText(own, t.due_at)}`
          + (subs.length ? `　子任務 ${subs.length}${lateSubs ? `（逾期 ${lateSubs}）` : ''}` : ''));
        g.addEventListener('click', () => TTBoard.openTask(t.id));
        g.addEventListener('keydown', e => { if (e.key === 'Enter') TTBoard.openTask(t.id); });
        nodes.push(g);
      });
      blips.replaceChildren(...nodes);
      legend.replaceChildren(
        ...RINGS.map(([label, , cls], i) => el('span', { class: `radar-key is-${cls}` }, el('i'), `${label} `, el('b', { text: counts[i] }))),
        el('span', { class: 'radar-key-sep' }),
        ...QUADS.map((q, i) => el('span', { class: 'radar-key is-quad' }, el('span', { text: q.label }), el('b', { text: quadN[i] }))),
        el('span', { class: 'radar-key-help', text: '◆ 主任務　● 子任務' }));
    }
    document.addEventListener('tt:tasks', paint);
    requestAnimationFrame(paint);
    if (typeof TTBoard !== 'undefined') TTBoard.load().catch(() => {});
  }

  /** Floating radar in the bottom-right corner of every portal page; collapses to a small square. */
  function float() {
    if (document.querySelector('.radar-float')) return;
    const box = el('div', { class: 'radar-float', role: 'complementary', 'aria-label': '任務雷達' });
    const panel = el('div', { class: 'radar-panel' });
    const min = el('button', { class: 'radar-min', type: 'button', title: '縮小', 'aria-label': '縮小任務雷達', text: '—' });
    const mini = el('button', { class: 'radar-mini', type: 'button', title: '展開任務雷達', 'aria-label': '展開任務雷達' },
      el('span', { class: 'radar-mini-scope' }, el('span', { class: 'radar-mini-sweep' })),
      el('span', { class: 'radar-mini-n', hidden: true }));
    box.append(panel, mini);
    document.body.append(box);
    mount(panel);
    panel.querySelector('.radar-head').append(min);
    const narrow = matchMedia('(max-width: 720px)').matches;
    let open = TT.store.get('radar-open', !narrow);
    const paint = () => { box.classList.toggle('is-open', open); box.classList.toggle('is-closed', !open); };
    const set = v => { open = v; TT.store.set('radar-open', v); paint(); };
    min.addEventListener('click', () => set(false));
    mini.addEventListener('click', () => set(true));
    // the collapsed square shows how many cards are overdue
    const badge = mini.querySelector('.radar-mini-n');
    const count = () => {
      const n = overdueCount(items());                    // overdue cards and overdue subtasks (every level)
      badge.textContent = n; badge.hidden = !n;
      mini.title = n ? `展開任務雷達（${n} 項逾期）` : '展開任務雷達';
    };
    document.addEventListener('tt:tasks', count);
    count();
    paint();
  }

  window.TTRadar = { mount, float };
})();
