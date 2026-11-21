/* =============================================================================
   Tool Table — task radar (home page, tactical skin)
   Every open card is a blip. The closer to the centre, the more urgent:
     centre ring = overdue · today · ≤3 days · ≤7 days · ≤30 days · outer edge = later / no due date
   The bearing is stable per card. A sweep turns every 6 s; a blip lights up as the beam
   passes it; overdue blips also pulse. Hover shows the card, click opens it.
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

  function mount(host) {
    const R = 100;
    const svg = s('svg', { viewBox: '-110 -110 220 220', class: 'radar-svg', role: 'img', 'aria-label': '任務雷達：越靠近中心越緊急' });
    // rings, crosshair, ticks
    const grid = s('g', { class: 'radar-grid' });
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
    [['000', 0, -R - 4], ['090', R + 4, 3], ['180', 0, R + 10], ['270', -R - 4, 3]].forEach(([t, x, y], i) => {
      const tx = s('text', { x, y, class: 'radar-bearing', 'text-anchor': i === 1 ? 'start' : i === 3 ? 'end' : 'middle' }); tx.textContent = t; grid.append(tx);
    });
    const blips = s('g', { class: 'radar-blips' });
    svg.append(grid, blips, s('circle', { r: 2.6, class: 'radar-home' }));

    const sweep = el('div', { class: 'radar-sweep' });
    sweep.style.animationDelay = `-${((performance.now() - start) / 1000) % PERIOD}s`;
    const tip = el('div', { class: 'radar-tip', hidden: true });
    const scope = el('div', { class: 'radar-scope' }, sweep, svg, tip);
    const legend = el('div', { class: 'radar-legend' });
    const head = el('div', { class: 'radar-head' }, el('span', { class: 'radar-title', text: '任務雷達' }), el('span', { class: 'radar-sub', text: 'TASK RADAR // SWEEP 6S' }));
    host.replaceChildren(head, el('div', { class: 'radar-body' }, scope, legend));

    let shown = false;                                     // mounted before it is on the page: wait for it
    function paint() {
      if (!host.isConnected) { if (shown) document.removeEventListener('tt:tasks', paint); return; }
      shown = true;
      const open = (typeof TTBoard !== 'undefined' ? TTBoard.tasks : []).filter(t => t.status !== 'complete' && t.status !== 'canceled');
      const phase = ((performance.now() - start) / 1000) % PERIOD;
      const counts = RINGS.map(() => 0);
      blips.replaceChildren(...open.map(t => {
        const ring = ringOf(t);
        counts[ring]++;
        const inner = ring ? RINGS[ring - 1][1] : .05, outer = RINGS[ring][1] - .03;
        const r = (inner + (outer - inner) * (.25 + .6 * hash('r' + t.id))) * R;
        const a = hash(t.id) * 360;                       // bearing, clockwise from north
        const rad = a * Math.PI / 180;
        const cls = RINGS[ring][2];
        const g = s('g', { class: `radar-blip is-${cls}`, transform: `translate(${(Math.sin(rad) * r).toFixed(1)} ${(-Math.cos(rad) * r).toFixed(1)})`, tabindex: '0' });
        const lit = s('circle', { r: ring === 0 ? 3.4 : 2.8, class: 'radar-dot' });
        lit.style.animationDelay = `${(a / 360 * PERIOD - phase).toFixed(2)}s`;   // flash when the beam passes
        g.append(...(ring === 0 ? [s('circle', { r: 3.4, class: 'radar-pulse' })] : []), lit);
        const label = `${t.title}　${RINGS[ring][0] === '之後' ? (t.due_at ? '到期 ' + t.due_at.replace('T', ' ') : '未設到期日') : RINGS[ring][0]}`;
        g.addEventListener('mouseenter', () => { tip.textContent = label; tip.hidden = false; });
        g.addEventListener('mouseleave', () => { tip.hidden = true; });
        g.addEventListener('focus', () => { tip.textContent = label; tip.hidden = false; });
        g.addEventListener('blur', () => { tip.hidden = true; });
        g.addEventListener('click', () => TTBoard.openTask(t.id));
        g.addEventListener('keydown', e => { if (e.key === 'Enter') TTBoard.openTask(t.id); });
        return g;
      }));
      legend.replaceChildren(...RINGS.map(([label, , cls], i) => el('span', { class: `radar-key is-${cls}` }, el('i'), `${label} `, el('b', { text: counts[i] }))));
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
      const n = (typeof TTBoard !== 'undefined' ? TTBoard.tasks : []).filter(t => !['complete', 'canceled'].includes(t.status) && ringOf(t) === 0).length;
      badge.textContent = n; badge.hidden = !n;
      mini.title = n ? `展開任務雷達（${n} 張逾期）` : '展開任務雷達';
    };
    document.addEventListener('tt:tasks', count);
    count();
    paint();
  }

  window.TTRadar = { mount, float };
})();
