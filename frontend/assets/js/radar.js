/* =============================================================================
   Tool Table — task radar (floating, tactical skin)
   Distance = urgency: the closer to the centre, the sooner it is due
     centre ring = overdue · today · ≤3 days · ≤7 days · ≤30 days · outer edge = later / no due date
   Quadrant = the card:  I high priority · II normal · III low · IV Pending / On hold / Canceled
   Only what needs attention is drawn: an everyday card shows when it (or a subtask) has a problem
   (overdue, blocked, schedule conflict, late cross-project predecessor, window clash); the rest are one
   "N 正常" bubble (click: show everything). A project is one hexagon, placed by its next milestone,
   coloured by health, with its number of problem items; click it for the project radar, whose sectors
   are the project's phases. The list tab is every alert (type filter, only mine), people overload included.
   Counts in the legend are per item: every overdue subtask counts.
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

  const SIZE = 6.4;
  const PROB_TYPES = ['overdue', 'blocked', 'conflict', 'xdep', 'window', 'overload'];
  const ZH = { overdue: '逾期', blocked: '卡住', conflict: '排程衝突', xdep: '跨專案前置', window: '時段衝突', overload: '超載' };
  const hexPts = r => [0, 1, 2, 3, 4, 5].map(k => { const a = Math.PI / 6 + k * Math.PI / 3; return `${(Math.cos(a) * r).toFixed(2)},${(Math.sin(a) * r).toFixed(2)}`; }).join(' ');
  const md = v => v ? `${+v.slice(5, 7)}/${+v.slice(8, 10)}` : '';
  const meId = () => (typeof TTBoard !== 'undefined' && TTBoard.meInfo?.user?.id) || null;

  function mount(host) {
    const R = 100;
    const state = { project: null, all: false, tab: 'radar', type: 'all', mine: TT.store.get('radar-mine', false) };
    const svg = s('svg', { viewBox: '-112 -112 224 224', class: 'radar-svg', role: 'img', 'aria-label': '任務雷達：越靠近中心越緊急；只畫出有問題的項目' });
    const grid = s('g', { class: 'radar-grid' });
    const blips = s('g', { class: 'radar-blips' });
    svg.append(grid, blips, s('circle', { r: 2.6, class: 'radar-home' }));
    const sweep = el('div', { class: 'radar-sweep' });
    sweep.style.animationDelay = `-${((performance.now() - start) / 1000) % PERIOD}s`;
    const tip = el('div', { class: 'radar-tip', hidden: true });
    const scope = el('div', { class: 'radar-scope' }, sweep, svg, tip);
    const legend = el('div', { class: 'radar-legend' });
    const crumb = el('div', { class: 'radar-crumb', hidden: true });
    const list = el('div', { class: 'radar-list', hidden: true });
    const tabs = el('div', { class: 'radar-tabs', role: 'tablist' });
    const head = el('div', { class: 'radar-head' }, el('span', { class: 'radar-title', text: '任務雷達' }), tabs);
    const body = el('div', { class: 'radar-body' }, scope, legend);
    host.replaceChildren(head, crumb, body, list);

    const hover = (g, label) => {
      g.addEventListener('mouseenter', () => { tip.textContent = label; tip.hidden = false; });
      g.addEventListener('mouseleave', () => { tip.hidden = true; });
      g.addEventListener('focus', () => { tip.textContent = label; tip.hidden = false; });
      g.addEventListener('blur', () => { tip.hidden = true; });
    };
    const act = (g, fn) => { g.addEventListener('click', fn); g.addEventListener('keydown', e => { if (e.key === 'Enter') fn(); }); };
    const ringR = (ring, seed) => { const inner = ring ? RINGS[ring - 1][1] : .07, outer = RINGS[ring][1] - .04; return (inner + (outer - inner) * (.2 + .6 * hash(seed))) * R; };
    const polar = (deg, r) => { const rad = deg * Math.PI / 180; return [Math.sin(rad) * r, -Math.cos(rad) * r]; };
    let phase0 = 0;
    const delayOf = a => `${(a / 360 * PERIOD - phase0).toFixed(2)}s`;
    function drawRings() {
      RINGS.forEach(([label, r], i) => {
        grid.append(s('circle', { r: r * R, class: i === RINGS.length - 1 ? 'radar-ring outer' : 'radar-ring' + (i % 2 ? ' dash' : '') }));
        if (i < RINGS.length - 1) { const tx = s('text', { x: 3, y: -r * R + 8, class: 'radar-label' }); tx.textContent = label; grid.append(tx); }
      });
      for (let a = 0; a < 360; a += 10) {
        const long = a % 90 === 0 ? 8 : a % 30 === 0 ? 5 : 2.5;
        const [x1, y1] = polar(a, R), [x2, y2] = polar(a, R + long);
        grid.append(s('line', { x1, y1, x2, y2, class: 'radar-tick' }));
      }
    }
    function drawQuads() {
      QUADS.forEach((q, i) => {
        const [ax, ay] = polar(q.from, R), [bx, by] = polar(q.from + 90, R);
        grid.append(s('path', { class: `radar-quad q${i + 1}`, d: `M0 0 L${ax} ${ay} A${R} ${R} 0 0 1 ${bx} ${by} Z` }));
        const [tx0, ty0] = polar(q.from + 45, R * 1.02);
        const tx = s('text', { x: tx0.toFixed(1), y: (ty0 + (i < 2 ? -2 : 7)).toFixed(1), class: 'radar-qlabel', 'text-anchor': i === 0 || i === 3 ? 'start' : 'end' });
        tx.textContent = q.label; grid.append(tx);
      });
      grid.append(s('line', { x1: -R, y1: 0, x2: R, y2: 0, class: 'radar-axis' }), s('line', { x1: 0, y1: -R, x2: 0, y2: R, class: 'radar-axis' }));
    }
    /** A dot (subtask), diamond (card / milestone) or hexagon (project) at x, y. */
    function blip({ x, y, shape, cls, label, onGo, pulse, n, tether, a }) {
      const g = s('g', { class: `radar-blip ${shape === 'dot' ? 'radar-kid' : shape === 'hex' ? 'radar-proj' : 'radar-card'} is-${cls}`, transform: `translate(${x.toFixed(1)} ${y.toFixed(1)})`, tabindex: '0' });
      const mark = shape === 'dot' ? s('circle', { r: 3.2, class: 'radar-dot' })
        : shape === 'hex' ? s('polygon', { points: hexPts(9), class: 'radar-dot' })
          : s('polygon', { points: `0,-${SIZE} ${SIZE},0 0,${SIZE} -${SIZE},0`, class: 'radar-dot' });
      mark.style.animationDelay = delayOf(a);
      if (tether) g.append(s('line', { x1: 0, y1: 0, x2: tether[0].toFixed(1), y2: tether[1].toFixed(1), class: 'radar-tether' }));
      g.append(s('circle', { r: shape === 'dot' ? 6.5 : 12, class: 'radar-hit' }), ...(pulse ? [s('circle', { r: shape === 'dot' ? 3 : 7, class: 'radar-pulse' })] : []), mark);
      if (n) { const t = s('text', { class: 'radar-n', 'text-anchor': 'middle', y: 2.6 }); t.textContent = n; g.append(t); }
      hover(g, label); act(g, onGo);
      return g;
    }
    function normalBubble(n) {
      const g = s('g', { class: 'radar-normal', transform: `translate(${-R + 4} ${R - 4})`, tabindex: '0' });
      const t = s('text', { 'text-anchor': 'start', y: 3 }); t.textContent = state.all ? '只看問題' : `${n} 正常`;
      g.append(s('rect', { x: -4, y: -6, width: state.all ? 34 : 12 + String(n).length * 4 + 16, height: 12, rx: 6 }), t);
      hover(g, state.all ? '回到只顯示有問題的項目' : `${n} 項沒有問題（點一下全部顯示）`);
      act(g, () => { state.all = !state.all; paint(); });
      return g;
    }

    // ---------- data
    let ana = null, rows = null;
    const probMap = () => {
      const m = new Map();
      (ana?.problems || []).forEach(p => { if (p.type !== 'overload') (m.get(p.key) || m.set(p.key, []).get(p.key)).push(p.type); });
      return m;
    };
    const projIds = () => new Set((typeof TTBoard !== 'undefined' ? TTBoard.tasks : []).filter(t => (t.kind || 'ops') === 'project').map(t => t.id));

    function paintGlobal(list) {
      grid.replaceChildren(); drawQuads(); drawRings();
      const probs = probMap(), pids = projIds();
      const nodes = []; let normal = 0;
      list.forEach(({ t, own, subs, ring }) => {
        const root = (t.kind || 'ops') === 'project' ? t.id : pids.has(t.project_id) ? t.project_id : null;
        if (root) return;                                     // inside a project: the hexagon speaks for it
        const bad = x => (probs.get(x) || []).length;
        const badSubs = subs.filter(x => x.ring === 0 || bad(`s:${x.id}`));
        const cardBad = t.status !== 'canceled' && (own === 0 || bad(`t:${t.id}`));
        if (!cardBad && !badSubs.length && !state.all) { normal += 1 + subs.length; return; }
        const showSubs = state.all ? subs : badSubs;
        const r0 = state.all ? ring : Math.min(cardBad ? own : 5, ...badSubs.map(x => x.ring));
        const q = quadOf(t);
        const a = QUADS[q].from + 10 + hash(t.id) * 70;
        const [x, y] = polar(a, ringR(r0, 'r' + t.id));
        showSubs.slice(0, 10).forEach((sx, k, arr) => {
          const oa = (k / arr.length) * Math.PI * 2 + hash('o' + t.id) * Math.PI;
          const ox = x + Math.cos(oa) * 12, oy = y + Math.sin(oa) * 12;
          const types = probs.get(`s:${sx.id}`) || [];
          nodes.push(blip({ x: ox, y: oy, shape: 'dot', cls: RINGS[sx.ring][2], a, pulse: sx.ring === 0, tether: [x - ox, y - oy],
            label: `↳ ${sx.title}　${whenText(sx.ring, sx.due_at)}${types.length ? '　' + types.map(k => ZH[k]).join('、') : ''}（${t.title}）`,
            onGo: () => TTBoard.openNavigator(t, sx.path) }));
        });
        const types = probs.get(`t:${t.id}`) || [];
        const cls = t.status === 'canceled' ? 'idle is-canceled' : types.includes('blocked') && r0 > 0 ? 'warn' : RINGS[r0][2];
        nodes.push(blip({ x, y, shape: 'dia', cls, a, pulse: r0 === 0 && t.status !== 'canceled',
          label: `◆ ${t.title}　${t.status === 'canceled' ? '已取消' : whenText(own, t.due_at)}${types.length ? '　' + types.map(k => ZH[k]).join('、') : ''}`
            + (badSubs.length ? `　有問題的子任務 ${badSubs.length}` : ''), onGo: () => TTBoard.openTask(t.id) }));
      });
      (ana?.projects || []).filter(p => !CLOSED.has(p.status)).forEach(p => {
        const due = p.next?.due;
        const ring = due ? ringOf({ due_at: due, status: '' }) : 5;
        const q = PAUSED.has(p.status) ? 3 : p.priority === 'high' ? 0 : p.priority === 'low' ? 2 : 1;
        const a = QUADS[q].from + 12 + hash('p' + p.id) * 66;
        const [x, y] = polar(a, ringR(ring, 'pr' + p.id));
        const hard = (p.problems.overdue || 0) + (p.problems.blocked || 0) + (p.problems.xdep || 0);
        const cls = PAUSED.has(p.status) ? 'idle' : hard || (p.slip || 0) > 3 ? 'crit' : p.problem_items || (p.slip || 0) > 0 ? 'warn' : 'ok';
        nodes.push(blip({ x, y, shape: 'hex', cls, a, n: p.problem_items || '', pulse: cls === 'crit',
          label: `⬡ ${p.title}　${p.next ? `下個里程碑 ${p.next.title} ${md(p.next.due)}` : '沒有里程碑'}　${p.slip > 0 ? `落後 ${p.slip} 天` : '進度正常'}　問題 ${p.problem_items}（點一下看專案雷達）`,
          onGo: () => { state.project = p.id; paint(); } }));
      });
      if (normal || state.all) nodes.push(normalBubble(normal));
      blips.replaceChildren(...nodes);
    }

    async function paintProject(pid) {
      const p = ana?.projects.find(x => x.id === pid);
      const card = TTBoard.tasks.find(t => t.id === pid);
      if (!p || !card) { state.project = null; return paint(); }
      rows = await TTBoard.ganttRows().catch(() => []);
      const attached = new Set(p.attached || []);
      const mine = rows.filter(r => r.card === pid || attached.has(r.card));
      const by = new Map(mine.map(r => [r.id, r]));
      const phases = mine.filter(r => r.card === pid && !r.parent);
      const sectors = [...phases.map(r => ({ id: r.id, title: r.title })), ...(attached.size ? [{ id: 'att', title: '歸屬卡片' }] : [])];
      if (!sectors.length) sectors.push({ id: 'none', title: p.title });
      const W = 360 / sectors.length;
      grid.replaceChildren();
      sectors.forEach((sc, i) => {
        const [ax, ay] = polar(i * W, R);
        grid.append(s('line', { x1: 0, y1: 0, x2: ax, y2: ay, class: 'radar-axis' }));
        const [tx0, ty0] = polar(i * W + W / 2, R * 1.07);
        const tx = s('text', { x: tx0.toFixed(1), y: (ty0 + 2.5).toFixed(1), class: 'radar-qlabel', 'text-anchor': 'middle' });
        tx.textContent = sc.id === 'att' ? '＋' : String(i + 1); grid.append(tx);
      });
      drawRings();
      const probs = probMap();
      const phaseOf = r => { let c = r, n = 0; while (c.parent && by.get(c.parent) && n++ < 6) c = by.get(c.parent); return c.card !== pid ? 'att' : c.id; };
      const pathOf = r => { const out = []; for (let c = r, n = 0; c && n < 6; c = c.parent ? by.get(c.parent) : null, n++) out.unshift(c.id); return out; };
      const isParent = new Set(mine.map(r => r.parent).filter(Boolean));
      const nodes = []; let normal = 0;
      const counts = new Map(), open = new Map();
      mine.forEach(r => {
        if (CLOSED.has(r.status) || (!r.parent && r.card === pid && isParent.has(r.id))) return;   // phases are the sectors
        const ring = ringOf(r);
        const types = probs.get(`s:${r.id}`) || [];
        const bad = ring === 0 || types.length;
        const si = Math.max(0, sectors.findIndex(sc => sc.id === phaseOf(r)));
        open.set(si, (open.get(si) || 0) + 1);
        if (bad) counts.set(si, (counts.get(si) || 0) + 1);
        if (!bad && !state.all) { normal++; return; }
        const a = si * W + W * (.12 + .76 * hash('a' + r.id));
        const [x, y] = polar(a, ringR(ring, 'q' + r.id));
        const c = r.card === pid ? card : TTBoard.tasks.find(t => t.id === r.card);
        nodes.push(blip({ x, y, shape: r.milestone ? 'dia' : 'dot', cls: types.includes('blocked') && ring > 0 ? 'warn' : RINGS[ring][2], a, pulse: ring === 0,
          label: `${r.milestone ? '◆' : '●'} ${r.title}　${whenText(ring, r.due_at)}${types.length ? '　' + types.map(k => ZH[k]).join('、') : ''}`,
          onGo: () => c && TTBoard.openNavigator(c, pathOf(r)) }));
      });
      // overdue/problem count per phase, on the rim
      counts.forEach((n, si) => {
        const [x, y] = polar(si * W + W / 2, R * .93);
        const t = s('text', { x: x.toFixed(1), y: (y + 2).toFixed(1), class: 'radar-phase-n', 'text-anchor': 'middle' }); t.textContent = n; grid.append(t);
      });
      if (normal || state.all) nodes.push(normalBubble(normal));
      blips.replaceChildren(...nodes);
      legend.replaceChildren(...sectors.map((sc, i) => el('span', { class: `radar-key radar-phase is-${counts.get(i) ? 'crit' : 'ok'}`, title: `${sc.title}：未完成 ${open.get(i) || 0} 項，有問題 ${counts.get(i) || 0} 項` },
        el('span', { class: 'radar-phase-i', text: sc.id === 'att' ? '＋' : String(i + 1) }), el('span', { class: 'radar-phase-t', text: sc.title }), el('b', { text: counts.get(i) || '' }))),
        el('span', { class: 'radar-key-help', text: '數字＝有問題的項目　◆ 里程碑' }));
      crumb.replaceChildren((() => { const b = el('button', { type: 'button', class: 'radar-back', text: '‹ 全部' }); b.addEventListener('click', () => { state.project = null; paint(); }); return b; })(),
        el('a', { href: `#/project/${pid}`, class: 'radar-crumb-t', text: `⬡ ${p.title}` }),
        el('span', { class: 'radar-crumb-s', text: p.next ? `◆ ${p.next.title} ${md(p.next.due)}` : '' }));
    }

    function alerts() {
      const me = meId();
      return (ana?.problems || []).filter(p => (!state.project || p.project === state.project)
        && (state.type === 'all' || p.type === state.type) && (!state.mine || (me && p.who === me)));
    }
    function paintList() {
      const me = meId();
      const base = (ana?.problems || []).filter(p => !state.project || p.project === state.project);
      const n = k => base.filter(p => (k === 'all' || p.type === k) && (!state.mine || (me && p.who === me))).length;
      const chip = (k, label) => {
        const b = el('button', { type: 'button', class: 'radar-chip', 'aria-pressed': String(state.type === k) }, label, el('b', { text: n(k) }));
        b.addEventListener('click', () => { state.type = k; paintList(); });
        return b;
      };
      const mineBox = el('input', { type: 'checkbox', checked: state.mine });
      mineBox.addEventListener('change', () => { state.mine = mineBox.checked; TT.store.set('radar-mine', state.mine); paintList(); });
      const rowsEl = alerts().slice(0, 200).map(p => {
        const b = el('button', { type: 'button', class: `radar-alert t-${p.type}` },
          el('span', { class: 'radar-alert-k', text: ZH[p.type] }),
          el('span', { class: 'radar-alert-b' }, el('b', { text: p.title }), el('small', { text: [p.card_title, p.text, p.who_name].filter(Boolean).join(' · ') })));
        b.addEventListener('click', async () => {
          if (p.type === 'overload') { TT.store.set('projects-tab', 'load'); location.hash = '#/projects'; return; }
          const c = TTBoard.tasks.find(t => t.id === p.card); if (!c) return;
          if (p.key.startsWith('t:')) return TTBoard.openTask(c.id);
          const rs = await TTBoard.ganttRows().catch(() => []); const by = new Map(rs.map(r => [r.id, r]));
          const path = []; for (let x = by.get(+p.key.slice(2)), k = 0; x && k < 6; x = x.parent ? by.get(x.parent) : null, k++) path.unshift(x.id);
          TTBoard.openNavigator(c, path);
        });
        return b;
      });
      list.replaceChildren(
        el('div', { class: 'radar-chips' }, chip('all', '全部'), ...PROB_TYPES.filter(k => n(k)).map(k => chip(k, ZH[k])),
          el('label', { class: 'radar-mine' }, mineBox, '只看我的')),
        el('div', { class: 'radar-alerts' }, ...(rowsEl.length ? rowsEl : [el('p', { class: 'radar-empty', text: ana ? '沒有警示' : '載入中…' })])));
    }
    function paintTabs() {
      const n = (ana?.problems || []).filter(p => !state.project || p.project === state.project).length;
      tabs.replaceChildren(...[['radar', '雷達'], ['list', `警示 ${n}`]].map(([k, l]) => {
        const b = el('button', { type: 'button', role: 'tab', class: 'radar-tab', 'aria-selected': String(state.tab === k), text: l });
        b.addEventListener('click', () => { state.tab = k; paint(); });
        return b;
      }));
    }
    function paintLegend(listAll) {
      const counts = RINGS.map(() => 0);
      listAll.forEach(({ t, own, subs }) => { if (t.status !== 'canceled') counts[own]++; subs.forEach(x => counts[x.ring]++); });
      const over = (ana?.load || []).filter(r => r.over).length;
      legend.replaceChildren(...[
        ...RINGS.map(([label, , cls], i) => el('span', { class: `radar-key is-${cls}` }, el('i'), `${label} `, el('b', { text: counts[i] }))),
        el('span', { class: 'radar-key-sep' }),
        over ? (() => { const b = el('button', { type: 'button', class: 'radar-key is-warn radar-over' }, el('i'), '超載 ', el('b', { text: over })); b.title = `${over} 人本週預估工時超過上限`; b.addEventListener('click', () => { state.tab = 'list'; state.type = 'overload'; paint(); }); return b; })() : null,
        el('span', { class: 'radar-key-help', text: '⬡ 專案　◆ 卡片　● 子任務' })].filter(Boolean));
    }

    let shown = false;                                     // mounted before it is on the page: wait for it
    async function paint() {
      if (!host.isConnected) { if (shown) { document.removeEventListener('tt:tasks', paint); document.removeEventListener('tt:analysis', onAna); } return; }
      shown = true;
      phase0 = ((performance.now() - start) / 1000) % PERIOD;
      const all = items();
      paintTabs();
      body.hidden = state.tab !== 'radar'; list.hidden = state.tab !== 'list';
      crumb.hidden = !state.project;
      if (!state.project) paintLegend(all);
      if (state.tab === 'list') paintList();
      else if (state.project) await paintProject(state.project);
      else paintGlobal(all);
      if (state.tab === 'list' && state.project) await paintProject(state.project);
    }
    const onAna = async () => { ana = await TTBoard.projectAnalysis().catch(() => ana); paint(); };
    document.addEventListener('tt:tasks', paint);
    document.addEventListener('tt:analysis', onAna);
    requestAnimationFrame(paint);
    if (typeof TTBoard !== 'undefined') TTBoard.load().then(() => onAna()).catch(() => {});
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
