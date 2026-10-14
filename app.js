/* 작은 좋아요 하나 · 배송 체험
   세계 좌표(2300x1000)의 SVG 하나를 viewBox 로 따라가는 카메라 구조다.
   배달부는 "다리(leg)" 경로 위의 거리 t 로만 움직이고, 경로 위 지점마다 게이트가 걸려 있다.
   게이트는 패널을 띄우고 멈추는 것(block)과 자막만 띄우는 것이 있다.
   이벤트 핸들러와 rAF 루프는 init 때 한 번만 건다. 재시작은 reset() 이 상태 · DOM · 타이머 · 효과를 되돌린다. */
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const NS = 'http://www.w3.org/2000/svg';
  const W = 2300, H = 1000;
  const SPEED = 125;                       // 걸음 기준 속도 (세계 단위 / 초)
  const KIND = { walk: 1, slope: 0.56, wade: 0.32, shallow: 0.45, ladder: 0.45, rubble: 0.42, road: 1.1, haul: 0.55, drive: 2.6 };
  const NEED = 600;                        // 국도 복구에 드는 금속 · 세라믹 (각각, 예시 수치)
  const STOCK = { metal: 680, ceramic: 640 };
  const TRIPS = 3;                         // 창고와 복구 장치 사이를 오가는 횟수
  const LIKE_CAP = 10;                     // 사다리에 한 번에 보낼 수 있는 좋아요
  const TOWN_LIKES = 2, CABIN_LIKES = 1;
  const ROAD_LIKES = [5, 4, 5];            // 다음 날 들어오는 알림 세 건 (예시 숫자)
  const HOLO = '#8fdcff';

  const motionMQ = matchMedia('(prefers-reduced-motion: reduce)');
  let reduced = motionMQ.matches;
  motionMQ.addEventListener && motionMQ.addEventListener('change', (e) => { reduced = e.matches; });

  // 지점 (세계 좌표)
  const P = {
    BASE: [180, 640], A: [380, 630], FORK: [540, 600],
    F1: [690, 612], FW: [772, 616], FE: [905, 602], F2: [990, 594],
    U1: [600, 500], U2: [700, 420], UW: [804, 384], UE: [878, 380], U3: [980, 420], U4: [1030, 520],
    C: [1062, 596], LW: [1166, 604], LE: [1282, 600],
    R0: [1380, 586], RB0: [1460, 578], RB1: [1880, 552], TOWN: [2060, 540],
    K1: [420, 760], CABIN: [560, 842],
  };

  const ROUTE = {
    ford: { names: ['FORK', 'F1', 'FW', 'FE', 'F2', 'C'], kinds: ['walk', 'walk', 'wade', 'walk', 'walk'] },
    up: { names: ['FORK', 'U1', 'U2', 'UW', 'UE', 'U3', 'U4', 'C'], kinds: ['slope', 'slope', 'slope', 'shallow', 'slope', 'slope', 'slope'] },
  };
  const SHALLOW = [[818, 383], [841, 382], [864, 381]];   // 상류의 얕은 물 (스캔 표시 자리)
  const TAIL = { names: ['C', 'LW', 'LE', 'R0', 'RB0', 'RB1', 'TOWN'], kinds: ['walk', 'ladder', 'walk', 'road', 'rubble', 'road'] };

  const LIKE_PATH = 'M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z';
  const LIKE_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${LIKE_PATH}"/></svg>`;

  // ---------- 상태 ----------
  let S;
  const timers = new Set();
  function later(fn, ms) {
    const id = setTimeout(() => { timers.delete(id); fn(); }, ms);
    timers.add(id);
  }
  function fresh() {
    return {
      leg: null, t: 0, gateIdx: 0, blocked: false, auto: false, autoRest: false,
      route: null, mode: 'foot', load: 'cargo', cargo: 100, balance: 0, stun: 0, stumbleT: 0, stumbles: 0,
      moveTime: 0, timing: true,
      sentLikes: 0, likes: 0, roadLikes: 0,
      deposits: 0, built: 0, builtShown: 0, stock: { ...STOCK },
      day: 1, extra: false, done: false, choice: null,
      cam: null, zoom: 1, focus: null, facing: 1, phase: 0, moved: false, panelOpen: false, panelH: 0,
      walking: false, lastPos: null,
    };
  }

  // ---------- 경로 ----------
  function makeLeg(names, kinds) {
    const pts = names.map((n) => P[n]);
    const cum = [0];
    for (let i = 1; i < pts.length; i++) {
      cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    }
    const leg = { names, pts, kinds, cum, len: cum[cum.length - 1], gates: [] };
    leg.at = (name, off) => cum[names.indexOf(name)] + (off || 0);
    leg.idx = (i, off) => cum[i] + (off || 0);
    return leg;
  }
  function segIndex(leg, t) {
    let i = 0;
    while (i < leg.cum.length - 2 && t > leg.cum[i + 1]) i++;
    return i;
  }
  function pointAt(leg, t) {
    const i = segIndex(leg, t);
    const a = leg.pts[i], b = leg.pts[i + 1];
    const span = leg.cum[i + 1] - leg.cum[i] || 1;
    const k = Math.min(1, Math.max(0, (t - leg.cum[i]) / span));
    return { x: a[0] + (b[0] - a[0]) * k, y: a[1] + (b[1] - a[1]) * k, kind: leg.kinds[i], dx: b[0] - a[0] };
  }
  function addGates(leg, list) {
    leg.gates = list.map((g) => ({ ...g })).sort((a, b) => a.at - b.at);
  }
  function startLeg(leg) {
    S.leg = leg; S.t = 0; S.gateIdx = 0;
  }

  // ---------- DOM ----------
  const svg = $('#world');
  const stage = $('#stage');
  const panel = $('#panel');
  const caption = $('#caption');
  const objMain = $('#obj-main');
  const objSub = $('#obj-sub');
  const likesChip = $('#likes');
  const likesN = $('#likes-n');
  const toasts = $('#toasts');
  const walkBtn = $('#walk');
  const autoBtn = $('#auto');
  const soundBtn = $('#sound');
  const dayfade = $('#dayfade');
  const hud = $('.hud');
  const qChoice = $('#q-choice');
  const qMain = $('#q-main');
  const Q_DEFAULT = { choice: qChoice.textContent, main: qMain.textContent };
  const el = { holos: [] };

  function node(tag, attrs, parent) {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    if (parent) parent.appendChild(n);
    return n;
  }
  const poly = (names) => names.map((n) => P[n].join(',')).join(' ');

  // 결정적 난수 (풍경 장식이 매번 같게)
  function rng(seed) {
    return () => {
      seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // 홀로그램 엄지: 하늘색 반투명. 좋아요를 보내면 밝아지고, 복제본이 위로 떠오르며 흩어진다.
  function makeHolo(x, y, s) {
    const g = node('g', { opacity: 0 }, el.holoLayer);
    node('path', { d: `M-2.5 ${s * 0.9} L${-s * 0.45} 0 L${s * 0.45} 0 L2.5 ${s * 0.9}Z`, fill: 'url(#g-beam)', opacity: 0.55 }, g);
    const core = node('g', {}, g);
    node('use', { href: '#s-like', x: -s / 2, y: -s * 1.05, width: s, height: s, fill: HOLO, opacity: 0.6, filter: 'url(#f-glow)' }, core);
    node('use', { href: '#s-like', x: -s / 2, y: -s * 1.05, width: s, height: s, fill: 'url(#p-scan)', opacity: 0.75 }, core);
    const h = { g, core, x, y, s, show: false, vis: 0, flash: 0, ph: (x * 0.013) % 6 };
    el.holos.push(h);
    return h;
  }

  function drawWorld() {
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid slice');
    const defs = node('defs', {}, svg);
    defs.innerHTML = `
      <linearGradient id="g-ground" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#3a4d50"/><stop offset=".22" stop-color="#2b3d3e"/>
        <stop offset=".6" stop-color="#22322f"/><stop offset="1" stop-color="#1b2826"/>
      </linearGradient>
      <linearGradient id="g-sky" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#5d7276"/><stop offset="1" stop-color="#3a4d50"/>
      </linearGradient>
      <linearGradient id="g-river" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="#5a7f84"/><stop offset=".5" stop-color="#7aa1a3"/><stop offset="1" stop-color="#557a7e"/>
      </linearGradient>
      <radialGradient id="g-mist" cx=".5" cy=".5" r=".5">
        <stop offset="0" stop-color="#cfdcd8" stop-opacity=".16"/><stop offset="1" stop-color="#cfdcd8" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="g-beam" x1="0" y1="1" x2="0" y2="0">
        <stop offset="0" stop-color="${HOLO}" stop-opacity=".6"/><stop offset="1" stop-color="${HOLO}" stop-opacity="0"/>
      </linearGradient>
      <pattern id="p-scan" width="4" height="3" patternUnits="userSpaceOnUse">
        <rect width="4" height="1.1" fill="#eafcff" opacity=".6"/>
      </pattern>
      <filter id="f-glow" x="-60%" y="-60%" width="220%" height="220%">
        <feGaussianBlur stdDeviation="2.2" result="b"/>
        <feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
      <linearGradient id="g-crack" gradientUnits="userSpaceOnUse" x1="0" y1="430" x2="0" y2="520">
        <stop offset="0" stop-color="#0c1415" stop-opacity="0"/><stop offset="1" stop-color="#0c1415"/>
      </linearGradient>
      <symbol id="s-like" viewBox="0 0 24 24"><path d="${LIKE_PATH}"/></symbol>`;

    // 하늘 · 땅 · 먼 산
    node('rect', { x: -400, y: -400, width: W + 800, height: H + 1600, fill: '#1b2826' }, svg);
    node('rect', { x: -400, y: -400, width: W + 800, height: 520, fill: 'url(#g-sky)' }, svg);
    node('rect', { x: -400, y: 110, width: W + 800, height: H + 1100, fill: 'url(#g-ground)' }, svg);
    // 강
    node('path', { d: 'M818 60 Q802 200 800 300 Q790 460 770 615 Q760 800 790 1100 L935 1100 Q905 800 905 600 Q890 450 870 295 Q882 200 884 60Z', fill: 'url(#g-river)' }, svg);
    const ripple = node('g', { stroke: '#cfe3e0', 'stroke-width': 1.2, fill: 'none', opacity: .35 }, svg);
    for (let y = 190; y < 1000; y += 46) {
      const x = y < 330 ? 828 : 800 + (y - 330) * 0.02 + 14;
      node('path', { d: `M${x} ${y} q12 -5 24 0 t24 0` }, ripple);
    }
    const foam = node('g', { opacity: .9 }, svg);           // 가까운 곳(깊은 물)의 흰 물살
    for (let i = 0; i < 7; i++) node('path', { d: `M${782 + i * 17} ${606 + (i % 2) * 14} q6 -4 12 0`, stroke: '#eef6f3', 'stroke-width': 2, fill: 'none' }, foam);
    // 상류의 얕은 물: 물빛이 옅고 바닥 자갈이 비친다
    node('ellipse', { cx: 841, cy: 382, rx: 52, ry: 15, fill: '#b9d5d0', opacity: .45 }, svg);
    const pebbles = node('g', { fill: '#8c9a94', opacity: .7 }, svg);
    [[812, 378], [826, 388], [846, 376], [860, 389], [872, 380]].forEach(([x, y]) => node('ellipse', { cx: x, cy: y, rx: 3.5, ry: 2 }, pebbles));

    const far = node('g', { fill: '#4a5f62', opacity: '.75' }, svg);
    node('path', { d: 'M-400 120 L-200 70 L40 100 L260 40 L420 90 L640 30 L900 100 L1120 50 L1380 105 L1600 45 L1860 100 L2100 35 L2360 95 L2700 60 L2700 140 L-400 140Z' }, far);
    node('path', { d: 'M-400 140 L-120 110 L180 136 L480 100 L760 140 L1040 108 L1300 140 L1580 102 L1900 142 L2200 110 L2700 130 L2700 172 L-400 172Z', fill: '#3d5254' }, far);

    // 언덕 얼룩 · 바위 · 풀
    const deco = node('g', {}, svg);
    const r = rng(7);
    for (let i = 0; i < 24; i++) {
      node('ellipse', { cx: r() * W, cy: 220 + r() * 760, rx: 120 + r() * 220, ry: 30 + r() * 60, fill: r() > .5 ? '#2f4341' : '#1f2e2c', opacity: .55 }, deco);
    }
    for (let i = 0; i < 120; i++) {
      const x = r() * W, y = 200 + r() * 780, s = 3 + r() * 9;
      node('ellipse', { cx: x, cy: y, rx: s * 1.4, ry: s * .8, fill: r() > .4 ? '#45595a' : '#3a4b4b' }, deco);
    }
    const grass = node('g', { stroke: '#51685b', 'stroke-width': 1.2, fill: 'none', opacity: .45, 'stroke-linecap': 'round' }, svg);
    for (let i = 0; i < 120; i++) {
      const x = r() * W, y = 220 + r() * 760, h = 3 + r() * 5, lean = (r() - .5) * 3;
      node('path', { d: `M${x} ${y}q${lean} ${-h / 2} ${lean * 1.6 - 1.5} ${-h}M${x + 3} ${y}q${lean} ${-h / 2} ${lean * 1.6 + 1} ${-h * 1.2}` }, grass);
    }

    // 틈
    node('path', { d: 'M1216 430 L1198 500 L1176 600 L1190 690 L1172 780 L1186 880 L1196 1000 L1262 1000 L1252 880 L1268 780 L1250 690 L1270 600 L1250 500 L1232 430Z', fill: 'url(#g-crack)' }, svg);
    node('path', { d: 'M1198 500 L1176 600 L1190 690 L1172 780 L1186 880 L1196 1000', fill: 'none', stroke: '#6d8483', 'stroke-width': 2.5 }, svg);
    node('path', { d: 'M1250 500 L1270 600 L1250 690 L1268 780 L1252 880 L1262 1000', fill: 'none', stroke: '#3c4f4f', 'stroke-width': 2 }, svg);

    // 오솔길 (걷는 경로를 그대로 그린다)
    const trail = { fill: 'none', stroke: '#a7bdb1', 'stroke-width': 3, 'stroke-dasharray': '2 9', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: .8 };
    node('polyline', { points: poly(['BASE', 'A', 'FORK']), ...trail }, svg);
    node('polyline', { points: poly(ROUTE.ford.names), ...trail }, svg);
    node('polyline', { points: poly(ROUTE.up.names), ...trail }, svg);
    node('polyline', { points: poly(['C', 'LW']), ...trail }, svg);
    node('polyline', { points: poly(['LE', 'R0']), ...trail }, svg);
    node('polyline', { points: poly(['A', 'K1', 'CABIN']), ...trail }, svg);

    // 카이랄 네트워크 영역 (마을 배송 뒤에 드러난다)
    el.netRegion = node('g', { opacity: 0 }, svg);
    node('circle', { cx: P.TOWN[0], cy: P.TOWN[1], r: 560, fill: HOLO, opacity: .05 }, el.netRegion);
    node('circle', { cx: P.TOWN[0], cy: P.TOWN[1], r: 560, fill: 'none', stroke: HOLO, 'stroke-width': 1.5, 'stroke-dasharray': '6 10', opacity: .35 }, el.netRegion);

    // 국도: 성한 구간 · 무너진 구간 · 새로 이을 구간
    const roadStyle = { fill: 'none', 'stroke-linecap': 'butt', 'stroke-linejoin': 'round' };
    const roadPart = (names) => {
      node('polyline', { points: poly(names), stroke: '#66746f', 'stroke-width': 30, ...roadStyle }, svg);
      node('polyline', { points: poly(names), stroke: '#9aa79f', 'stroke-width': 1.5, 'stroke-dasharray': '14 12', ...roadStyle }, svg);
    };
    roadPart(['R0', 'RB0']);
    roadPart(['RB1', 'TOWN']);
    el.rubble = node('g', {}, svg);
    const rr = rng(21);
    for (let i = 0; i < 64; i++) {
      const k = rr(), x = P.RB0[0] + (P.RB1[0] - P.RB0[0]) * k, y = P.RB0[1] + (P.RB1[1] - P.RB0[1]) * k + (rr() - .5) * 36;
      node('path', { d: `M${x} ${y} l${6 + rr() * 8} ${-4 - rr() * 6} l${6 + rr() * 6} ${5 + rr() * 4}Z`, fill: rr() > .5 ? '#55625e' : '#47524f' }, el.rubble);
    }
    // 복구는 마을 쪽(RB1)에서 시작해 서쪽으로 뻗는다
    const newLen = Math.hypot(P.RB1[0] - P.RB0[0], P.RB1[1] - P.RB0[1]);
    el.newLen = newLen;
    el.newRoad = node('polyline', { points: poly(['RB1', 'RB0']), stroke: '#7f918a', 'stroke-width': 30, ...roadStyle, 'stroke-dasharray': `${newLen} ${newLen}`, 'stroke-dashoffset': newLen }, svg);
    el.newRoadLine = node('polyline', { points: poly(['RB1', 'RB0']), stroke: '#d6e6dc', 'stroke-width': 1.5, ...roadStyle, 'stroke-dasharray': `${newLen} ${newLen}`, 'stroke-dashoffset': newLen }, svg);
    // 도로 가운데 선: 이 위를 달리면 배터리가 닳지 않는다 (복구 뒤에 켜진다)
    el.energy = node('polyline', { points: poly(['R0', 'RB0', 'RB1', 'TOWN']), stroke: HOLO, 'stroke-width': 2.2, fill: 'none', opacity: 0 }, svg);

    // 다음 날의 흔적: 발자국 · 바퀴 자국 (이은 구간 위)
    el.traces = node('g', { opacity: 0 }, svg);
    for (let i = 0; i < 26; i++) {
      const k = (i + .5) / 26, x = P.RB0[0] + (P.RB1[0] - P.RB0[0]) * k, y = P.RB0[1] + (P.RB1[1] - P.RB0[1]) * k;
      node('ellipse', { cx: x, cy: y - 7 + (i % 2) * 5, rx: 3, ry: 1.8, fill: '#26302e' }, el.traces);
    }
    [9, 3].forEach((dy) => node('polyline', { points: `${P.RB0[0]},${P.RB0[1] + dy} ${P.RB1[0]},${P.RB1[1] + dy}`, stroke: '#3d4945', 'stroke-width': 2.5, fill: 'none', 'stroke-dasharray': '18 6' }, el.traces));

    // 도로 복구 장치
    const pav = node('g', { transform: `translate(${P.RB1[0] - 6} ${P.RB1[1] - 70})` }, svg);
    node('rect', { x: 0, y: 0, width: 34, height: 26, rx: 3, fill: '#8d9993', stroke: '#c9d4cd', 'stroke-width': 1.5 }, pav);
    node('rect', { x: 6, y: 6, width: 22, height: 6, fill: '#3f4c48' }, pav);
    el.pavLight = node('circle', { cx: 28, cy: 20, r: 3, fill: '#d9a35a' }, pav);

    // 사다리 (틈 앞에서 둘러볼 때 드러난다)
    el.ladder = node('g', { stroke: '#d8e3dc', 'stroke-width': 3, 'stroke-linecap': 'round', opacity: 0 }, svg);
    const [lx0, ly0] = [P.LW[0] - 8, P.LW[1]], [lx1, ly1] = [P.LE[0] + 8, P.LE[1]];
    node('line', { x1: lx0, y1: ly0 - 7, x2: lx1, y2: ly1 - 7 }, el.ladder);
    node('line', { x1: lx0, y1: ly0 + 7, x2: lx1, y2: ly1 + 7 }, el.ladder);
    for (let i = 1; i < 10; i++) {
      const x = lx0 + (lx1 - lx0) * i / 10, y = ly0 + (ly1 - ly0) * i / 10;
      node('line', { x1: x, y1: y - 7, x2: x, y2: y + 7, 'stroke-width': 2 }, el.ladder);
    }

    // 스캔 표시: 노란 네모 = 깊은 물, 파란 동그라미 = 얕은 물 (색과 모양으로 함께 구분)
    el.scan = node('g', { opacity: 0 }, svg);
    [0.15, 0.4, 0.65, 0.88].forEach((k) => {
      const x = P.FW[0] + (P.FE[0] - P.FW[0]) * k, y = P.FW[1] + (P.FE[1] - P.FW[1]) * k;
      node('rect', { x: x - 7, y: y - 7, width: 14, height: 14, fill: 'none', stroke: '#f0c36a', 'stroke-width': 2.4 }, el.scan);
    });
    SHALLOW.forEach(([x, y]) => node('circle', { cx: x, cy: y, r: 9, fill: 'none', stroke: '#7fc8ff', 'stroke-width': 2.4 }, el.scan));
    const scanLabel = (x, y, text, color) => {
      const t = node('text', { x, y, fill: color, 'font-size': 15, 'text-anchor': 'middle', 'paint-order': 'stroke', stroke: '#162224', 'stroke-width': 4 }, el.scan);
      t.textContent = text;
    };
    scanLabel(838, 660, '깊은 물', '#f0c36a');
    scanLabel(841, 414, '얕은 물', '#7fc8ff');
    el.scanRing = node('circle', { cx: 0, cy: 0, r: 0, fill: 'none', stroke: HOLO, 'stroke-width': 2, opacity: 0 }, svg);
    el.netPulse = node('circle', { cx: 0, cy: 0, r: 0, fill: 'none', stroke: HOLO, 'stroke-width': 3, opacity: 0 }, svg);

    // 배송 센터 · 마을 · 오두막
    const base = node('g', { transform: `translate(${P.BASE[0]} ${P.BASE[1]})` }, svg);
    node('path', { d: 'M-46 0 Q-46 -48 0 -54 Q46 -48 46 0Z', fill: '#617370', stroke: '#b9c9c1', 'stroke-width': 1.5 }, base);
    node('rect', { x: -10, y: -20, width: 20, height: 20, fill: '#22302e' }, base);
    node('circle', { cx: 0, cy: -38, r: 4, fill: '#e6c88a' }, base);
    const town = node('g', { transform: `translate(${P.TOWN[0]} ${P.TOWN[1]})` }, svg);
    // 건물은 배달부의 발(0) 뒤쪽, 위로 그린다 [x, 바닥, 폭, 높이]
    [[-30, -14, 30, 34], [6, -20, 40, 46], [52, -12, 28, 26], [-68, -8, 28, 22]].forEach(([x, b, w, h]) => {
      node('rect', { x, y: b - h, width: w, height: h, fill: '#5c6d69', stroke: '#b9c9c1', 'stroke-width': 1.2 }, town);
    });
    el.townLight = node('rect', { x: 20, y: -52, width: 10, height: 10, fill: '#e6c88a', opacity: .4 }, town);
    // 마을 창고의 자재 상자
    const store = node('g', { transform: 'translate(-58 14)' }, town);
    node('rect', { x: 0, y: 0, width: 18, height: 12, fill: '#6f7f87', stroke: '#b5c3c9', 'stroke-width': 1 }, store);
    node('rect', { x: 20, y: 2, width: 16, height: 10, fill: '#8a7a66', stroke: '#c2b4a0', 'stroke-width': 1 }, store);
    node('rect', { x: 9, y: -9, width: 16, height: 10, fill: '#6f7f87', stroke: '#b5c3c9', 'stroke-width': 1 }, store);
    const cabin = node('g', { transform: `translate(${P.CABIN[0]} ${P.CABIN[1]})` }, svg);
    node('path', { d: 'M-24 0 V-22 L0 -40 L24 -22 V0Z', fill: '#5d6a62', stroke: '#b9c9c1', 'stroke-width': 1.2 }, cabin);
    el.cabinLight = node('rect', { x: -5, y: -16, width: 10, height: 10, fill: '#e6c88a', opacity: .35 }, cabin);

    const label = (x, y, text, size) => {
      const t = node('text', { x, y, fill: '#dfe8e2', 'font-size': size || 17, 'text-anchor': 'middle', 'paint-order': 'stroke', stroke: '#162224', 'stroke-width': 4 }, svg);
      t.textContent = text;
      return t;
    };
    label(P.BASE[0], P.BASE[1] + 30, '배송 센터');
    label(P.TOWN[0], P.TOWN[1] + 46, '마을');
    label(P.CABIN[0], P.CABIN[1] + 28, '강가 오두막');
    label(P.RB1[0] + 11, P.RB1[1] - 82, '도로 복구 장치', 14);
    el.brokenLabel = label(P.RB0[0] + 210, P.RB0[1] + 50, '무너진 국도');

    // 세워 둔 오토바이 (다음 날, 도로 끝)
    el.parked = node('g', { transform: `translate(${P.R0[0] + 14} ${P.R0[1] + 30})`, opacity: 0 }, svg);
    drawTrike(el.parked, false);

    // 홀로그램 층: 사다리 표지판 · 내가 이은 국도 표지판
    el.holoLayer = node('g', {}, svg);
    el.ladderHolo = makeHolo(P.LE[0] - 4, P.LE[1] - 40, 30);
    el.roadHolo = makeHolo(P.RB1[0] + 11, P.RB1[1] - 100, 30);

    // 배달부
    el.porter = node('g', {}, svg);
    node('ellipse', { cx: 0, cy: 2, rx: 9, ry: 3, fill: '#000', opacity: .35 }, el.porter);
    el.body = node('g', {}, el.porter);
    el.legL = node('line', { x1: -2, y1: -10, x2: -3, y2: 0, stroke: '#c7d3cc', 'stroke-width': 2.6, 'stroke-linecap': 'round' }, el.body);
    el.legR = node('line', { x1: 2, y1: -10, x2: 3, y2: 0, stroke: '#c7d3cc', 'stroke-width': 2.6, 'stroke-linecap': 'round' }, el.body);
    node('path', { d: 'M-5 -11 Q-6 -22 0 -24 Q6 -22 5 -11Z', fill: '#d9e3dd' }, el.body);
    node('circle', { cx: 1, cy: -28, r: 4.2, fill: '#e9efe9' }, el.body);
    el.cargo = node('rect', { x: -14, y: -32, width: 11, height: 20, rx: 1.5, fill: '#c9a76b', stroke: '#f0dcb0', 'stroke-width': 1 }, el.body);
    el.mats = node('g', { opacity: 0 }, el.body);         // 자재 짐: 크고 무겁다
    node('rect', { x: -19, y: -40, width: 15, height: 30, rx: 1.5, fill: '#6f7f87', stroke: '#b5c3c9', 'stroke-width': 1 }, el.mats);
    node('line', { x1: -19, y1: -25, x2: -4, y2: -25, stroke: '#b5c3c9', 'stroke-width': 1 }, el.mats);
    el.trike = node('g', { opacity: 0 }, el.porter);
    drawTrike(el.trike, true);

    // 균형 게이지 (깊은 물에서 화물을 지고 있을 때만)
    el.bal = node('g', { opacity: 0 }, svg);
    node('rect', { x: -16, y: 0, width: 32, height: 5, rx: 2.5, fill: '#0c1517', stroke: '#ffffff55', 'stroke-width': 1 }, el.bal);
    el.balFill = node('rect', { x: -16, y: 0, width: 0, height: 5, rx: 2.5, fill: '#9fe0b8' }, el.bal);

    el.fx = node('g', { 'pointer-events': 'none' }, svg);
    // 시간 색조 · 안개
    el.tint = node('rect', { x: -400, y: -400, width: W + 800, height: H + 800, fill: '#10203a', opacity: 0, 'pointer-events': 'none' }, svg);
    node('ellipse', { cx: W / 2, cy: 420, rx: 1800, ry: 520, fill: 'url(#g-mist)', 'pointer-events': 'none' }, svg);
  }

  function drawTrike(g, withRider) {
    node('circle', { cx: -12, cy: -5, r: 5, fill: '#2a3534', stroke: '#c7d3cc', 'stroke-width': 1.6 }, g);
    node('circle', { cx: 14, cy: -5, r: 5, fill: '#2a3534', stroke: '#c7d3cc', 'stroke-width': 1.6 }, g);
    node('path', { d: 'M-17 -9 L9 -9 L15 -17 L11 -19 L5 -12 L-15 -14Z', fill: '#c9d4cd' }, g);
    node('rect', { x: -20, y: -18, width: 9, height: 8, rx: 1, fill: '#7f918a' }, g);
    if (withRider) {
      node('path', { d: 'M-5 -13 Q-7 -25 -1 -27 Q5 -25 4 -15Z', fill: '#d9e3dd' }, g);
      node('circle', { cx: 0, cy: -31, r: 4, fill: '#e9efe9' }, g);
      node('line', { x1: 3, y1: -21, x2: 11, y2: -18, stroke: '#d9e3dd', 'stroke-width': 2.2, 'stroke-linecap': 'round' }, g);
    }
  }

  // ---------- 효과 ----------
  const fx = [];
  function addFx(dur, elm, fn) { const f = { t: 0, dur, el: elm, fn, dead: false }; fx.push(f); return f; }
  function updateFx(dt) {
    for (let i = fx.length - 1; i >= 0; i--) {
      const f = fx[i];
      if (f.dead) { fx.splice(i, 1); continue; }
      f.t += dt;
      const k = Math.min(1, f.t / f.dur);
      f.fn(k);
      if (k >= 1) { if (f.el) f.el.remove(); fx.splice(i, 1); }
    }
  }
  const ease = (k) => 1 - (1 - k) * (1 - k);

  // 엄지 하나가 밝게 떠오르며 흩어진다 (보낼 때와 받을 때 같은 모양)
  function spawnRise(x, y, s) {
    if (reduced) return;
    const g = node('g', { transform: `translate(${x} ${y})` }, el.fx);
    node('use', { href: '#s-like', x: -s / 2, y: -s / 2, width: s, height: s, fill: '#d6f5ff', filter: 'url(#f-glow)' }, g);
    addFx(1.05, g, (k) => {
      const e = ease(k);
      g.setAttribute('transform', `translate(${x} ${(y - e * 62).toFixed(1)}) scale(${(1 + e * 0.35).toFixed(3)})`);
      g.setAttribute('opacity', ((1 - k) * 0.95).toFixed(3));
    });
    for (let i = 0; i < 7; i++) {
      const a = -Math.PI * (0.12 + 0.76 * (i / 6));
      const d = 16 + Math.random() * 22;
      const dot = node('circle', { cx: x, cy: y, r: 1.8, fill: '#bfefff' }, el.fx);
      addFx(0.9, dot, (k) => {
        const e = ease(k);
        dot.setAttribute('cx', (x + Math.cos(a) * d * e).toFixed(1));
        dot.setAttribute('cy', (y - 10 + Math.sin(a) * d * e - e * 26).toFixed(1));
        dot.setAttribute('opacity', (1 - k).toFixed(3));
      });
    }
  }
  function pulseRing(circle, cx, cy, r1, dur) {
    if (reduced) return;
    circle.setAttribute('cx', cx);
    circle.setAttribute('cy', cy);
    addFx(dur, null, (k) => {
      circle.setAttribute('r', (r1 * ease(k)).toFixed(1));
      circle.setAttribute('opacity', ((1 - k) * 0.85).toFixed(3));
    });
  }
  // 같은 요소에 새 페이드가 걸리면 이전 페이드는 취소한다 (나타나는 중에 사라지기가 시작돼도 덮어쓰지 않게)
  const fades = new Map();
  function fadeTo(elm, to, dur, flicker) {
    const prev = fades.get(elm);
    if (prev) prev.dead = true;
    if (reduced) { elm.setAttribute('opacity', to); fades.delete(elm); return; }
    const from = parseFloat(elm.getAttribute('opacity')) || 0;
    fades.set(elm, addFx(dur, null, (k) => {
      const f = flicker && k < 1 ? 0.65 + 0.35 * Math.abs(Math.sin(k * 38)) : 1;
      elm.setAttribute('opacity', ((from + (to - from) * k) * f).toFixed(3));
      if (k >= 1) fades.delete(elm);
    }));
  }
  const fadeIn = (elm, dur, flicker) => fadeTo(elm, 1, dur, flicker);
  const fadeOut = (elm) => fadeTo(elm, 0, 0.8, false);

  function addLikes(n) {
    S.likes += n;
    likesN.textContent = S.likes;
    if (!reduced) {
      likesChip.classList.remove('pulse');
      void likesChip.offsetWidth;
      likesChip.classList.add('pulse');
    }
  }
  // 받은 좋아요: 준 쪽에서 엄지가 떠오르고, 화면 위 숫자가 하나씩 오른다
  function receive(x, y, n, onEach, gap) {
    chime();
    for (let i = 0; i < n; i++) {
      const fire = () => { spawnRise(x + (Math.random() - .5) * 30, y, 22); addLikes(1); if (onEach) onEach(); };
      if (reduced) fire(); else later(fire, i * (gap || 240));
    }
  }
  function toast(text) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.innerHTML = LIKE_ICON + '<span></span>';
    t.querySelector('span').textContent = text;
    toasts.prepend(t);
    while (toasts.children.length > 3) toasts.lastChild.remove();
    later(() => { t.classList.add('out'); later(() => t.remove(), 500); }, 4200);
  }

  // ---------- 화면 문구 ----------
  function setObjective(main, sub) {
    objMain.textContent = main;
    objSub.textContent = sub || '';
  }
  function cargoSub() { return `화물 상태 ${S.cargo}%`; }
  function buildSub() {
    return `복구 ${Math.round(S.built * 100)}% · 금속 ${S.stock.metal} · 세라믹 ${S.stock.ceramic}`;
  }
  function setCaption(text, ms) {
    caption.textContent = text;
    if (ms) {
      const mine = text;
      later(() => { if (caption.textContent === mine) caption.textContent = ''; }, ms);
    }
  }
  const fmtTime = (s) => { const n = Math.round(s); return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`; };
  function resultLine() {
    return `<p class="stats"><span>이동 시간 ${fmtTime(S.moveTime)}</span><span>화물 상태 ${S.cargo}%</span></p>`;
  }
  function memCard(text) {
    return `<div class="mem-card"><span class="tag tag-mem">기억</span><p>${text}</p></div>`;
  }

  // opts: { tag, title, html, buttons:[{label, sub, cls, id, fn}], focus }
  function showPanel(opts) {
    panel.innerHTML = '';
    if (opts.tag) panel.insertAdjacentHTML('beforeend', opts.tag);
    if (opts.title) {
      const h = document.createElement('h3');
      h.textContent = opts.title;
      panel.appendChild(h);
      panel.setAttribute('aria-label', opts.title);
    }
    if (opts.html) panel.insertAdjacentHTML('beforeend', opts.html);
    const btns = [];
    if (opts.buttons && opts.buttons.length) {
      const row = document.createElement('div');
      row.className = 'opts';
      opts.buttons.forEach((b) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'opt' + (b.cls ? ' ' + b.cls : '');
        if (b.id) btn.id = b.id;
        btn.innerHTML = b.label + (b.sub ? `<small>${b.sub}</small>` : '');
        if (b.fn) btn.addEventListener('click', b.fn);
        row.appendChild(btn);
        btns.push(btn);
      });
      panel.appendChild(row);
    }
    panel.hidden = false;
    panel.scrollTop = 0;
    S.panelOpen = true;
    S.panelH = panel.offsetHeight;
    // 고르는 패널은 어느 쪽도 미리 고르지 않도록 패널 자체에 초점을 둔다
    if (opts.focus === false) return;
    if (btns.length === 1) btns[0].focus({ preventScroll: true });
    else panel.focus({ preventScroll: true });
  }
  function hidePanel() {
    panel.hidden = true;
    panel.innerHTML = '';
    S.panelOpen = false;
  }
  function block() {
    caption.textContent = '';                // 패널이 열리면 걷는 동안의 자막은 거둔다
    S.blocked = true;
    walkBtn.disabled = true;
    holdKey = false; holdPtr = false;
    walkBtn.classList.remove('active');
  }
  function unblock() {
    hidePanel();
    S.focus = null;
    S.blocked = false;
    walkBtn.disabled = false;
  }

  const TAG = {
    sim: '<span class="tag tag-sim">체험</span>',
    npc: '<span class="tag tag-sim">NPC 반응</span>',
    others: '<span class="tag tag-sim">다른 배달부의 반응</span>',
  };
  const MEM = {
    ladder: '실제로 플레이할 때, 다른 유저가 시의적절한 곳에 남긴 사다리에 좋아요를 눌러 본 적이 있다.',
    npc: 'NPC가 자동으로 남기는 반응인 줄 알면서도, 퀘스트를 끝낼 때마다 받는 작은 좋아요에 성취감을 느꼈다. 그래서 서브퀘스트까지 스스로 찾아다녔던 것 같다.',
    road: '국도를 연결하고 나면, 다음에 그 길을 지날 때마다 좋아요가 쌓여 있었다. 그걸 보면서 뿌듯했다.',
  };

  // 판단이 필요한 장면에서 카메라가 비춰야 할 세계 영역 (패널에 가리지 않는 빈 공간에 맞춘다)
  const FOCUS = {
    scan: { x0: 740, y0: 340, x1: 940, y1: 668 },
    net: { x0: 1850, y0: 440, x1: 2100, y1: 590 },
    road: { x0: 1440, y0: 430, x1: 1950, y1: 610 },
  };

  // ---------- 다리(leg) 구성 ----------
  function legOut1() {
    const leg = makeLeg(['BASE', 'A', 'FORK'], ['walk', 'walk']);
    addGates(leg, [{ at: leg.len, block: true, fn: gateFork }]);
    return leg;
  }

  function legOut2(route) {
    const R = ROUTE[route];
    const leg = makeLeg(R.names.concat(TAIL.names.slice(1)), R.kinds.concat(TAIL.kinds));
    const g = [];
    if (route === 'ford') {
      g.push({ at: leg.at('FW', -4), fn: () => setCaption('물이 깊다. 계속 밀고 가면 균형이 무너진다. 잠깐씩 손을 떼면 균형을 되찾는다.', 7000) });
      g.push({ at: leg.at('FE', 4), fn: () => setCaption(`건넜다. 화물 상태 ${S.cargo}%.`, 3500) });
    } else {
      g.push({ at: 20, fn: () => setCaption('상류 쪽으로 오른다. 오르막이라 걸음이 느리다.', 5000) });
      g.push({ at: leg.at('UW', -4), fn: () => setCaption('물이 얕다. 화물이 젖을 걱정 없이 걸어서 건넌다.', 4000) });
    }
    g.push({ at: leg.at('C', 0), fn: () => fadeOut(el.scan) });
    g.push({ at: leg.at('LW', -14), block: true, fn: gateCrevasse });
    g.push({ at: leg.at('LW', 2), fn: () => setCaption('사다리 위에서는 천천히 간다.', 3000) });
    g.push({ at: leg.at('LE', 58), block: true, fn: gateLadderLike });
    g.push({ at: leg.at('LE', 150), fn: () => { el.ladderHolo.show = false; } });
    g.push({ at: leg.at('RB0', -4), fn: () => setCaption('국도가 무너진 구간이다. 잔해를 밟고 가느라 느리다.', 5500) });
    g.push({ at: leg.at('RB1', -90), fn: () => setCaption('길가에 도로 복구 장치가 있다. 꺼져 있다. 이 일대가 아직 카이랄 네트워크에 연결되지 않아서다.', 7000) });
    g.push({ at: leg.len, block: true, fn: gateDeliver });
    addGates(leg, g);
    return leg;
  }

  function legToPaver() {
    const leg = makeLeg(['TOWN', 'RB1'], ['road']);
    addGates(leg, [{ at: leg.len, block: true, fn: gateBuild }]);
    return leg;
  }

  // 창고(TOWN)와 장치(RB1) 사이를 TRIPS 번 오간다
  function legHaul() {
    const names = ['RB1'], kinds = [];
    for (let i = 0; i < TRIPS; i++) { names.push('TOWN', 'RB1'); kinds.push('road', 'haul'); }
    const leg = makeLeg(names, kinds);
    const g = [];
    for (let i = 0; i < TRIPS; i++) {
      g.push({ at: leg.idx(1 + i * 2), fn: () => loadMaterials(i) });
      const last = i === TRIPS - 1;
      g.push({ at: leg.idx(2 + i * 2), block: last, fn: () => deposit(last) });
    }
    addGates(leg, g);
    return leg;
  }

  function legRide() {
    const R = ROUTE[S.route];
    const back = R.names.slice().reverse();               // C 부터 FORK 까지
    const names = ['TOWN', 'RB1', 'RB0', 'R0', 'LE', 'LW'].concat(back, ['A', 'BASE']);
    const kinds = ['drive', 'drive', 'drive', 'walk', 'ladder', 'walk'].concat(R.kinds.slice().reverse(), ['walk', 'walk']);
    const leg = makeLeg(names, kinds);
    const g = [
      { at: leg.idx(1, 30), block: true, fn: gateRoadReaction },
      { at: leg.idx(3), fn: dismount },
      { at: leg.idx(4, -60), fn: () => { el.ladderHolo.show = true; setCaption(S.sentLikes ? '어제 좋아요를 보낸 사다리다. 그대로 걸려 있다.' : '사다리는 그대로 걸려 있다.', 4500); } },
      { at: leg.idx(5, 40), fn: () => { el.ladderHolo.show = false; } },
      { at: leg.len, block: true, fn: gateHome },
    ];
    if (S.route === 'ford') g.push({ at: leg.at('FE', -4), fn: () => setCaption('짐이 없어서 균형을 잃을 걱정이 없다.', 4000) });
    addGates(leg, g);
    return leg;
  }

  function legExtra() {
    const leg = makeLeg(['BASE', 'A', 'K1', 'CABIN'], ['walk', 'walk', 'walk']);
    addGates(leg, [
      { at: 20, fn: () => setCaption('가까운 길이다.', 3000) },
      { at: leg.len, block: true, fn: gateCabin },
    ]);
    return leg;
  }

  // ---------- 게이트: 가는 길 ----------
  function gateFork() {
    showPanel({
      tag: TAG.sim,
      title: '갈림길',
      html: '<p>강을 건너야 한다. 어디로 건널지 정하기 전에 지형을 스캔할 수 있다.</p>',
      buttons: [{ label: '지형 스캔', cls: 'go', fn: doScan }],
    });
  }
  function doScan() {
    S.focus = FOCUS.scan;
    pulseRing(el.scanRing, P.FORK[0], P.FORK[1], 520, 1.3);
    fadeIn(el.scan, 0.9, false);
    sfxScan();
    showPanel({
      tag: TAG.sim,
      title: '스캔 결과',
      html: '<p>가까운 곳에는 노란 네모가 떴다. 물이 깊다는 뜻이다. 상류 쪽에는 파란 동그라미가 떴다. 물은 얕지만, 오르막을 한참 돌아가야 한다.</p>',
      buttons: [
        { label: '가까운 곳으로 건너기', sub: '빠르다. 물이 깊어서 균형을 잃으면 넘어지고 화물이 상한다.', fn: () => chooseRoute('ford') },
        { label: '상류로 돌아가기', sub: '느리다. 물이 얕아서 화물은 안전하다.', fn: () => chooseRoute('up') },
      ],
    });
  }
  function chooseRoute(route) {
    S.route = route;
    unblock();
    startLeg(legOut2(route));
  }

  function gateCrevasse() {
    showPanel({
      tag: TAG.sim,
      title: '깊은 틈',
      html: '<p>땅이 갈라져 길이 끊겼다. 화물을 지고는 건널 수 없다.</p>',
      buttons: [{ label: '주변 살피기', cls: 'go', fn: revealLadder }],
    });
  }
  function revealLadder() {
    fadeIn(el.ladder, 0.9, true);
    el.ladderHolo.show = true;
    sfxScan();
    showPanel({
      tag: TAG.sim,
      title: '누군가 놓아 둔 사다리',
      html: '<p>틈 위에 사다리 하나가 걸쳐 있다. 다른 배달부가 놓고 간 것이다. 이게 없었으면 틈을 따라 한참 돌아가야 했다.</p>',
      buttons: [{ label: '사다리로 건너기', cls: 'go', fn: unblock }],
    });
  }

  function gateLadderLike() {
    showPanel({
      tag: TAG.sim,
      title: '사다리 표지판',
      html: '<p>사다리 끝에 놓은 사람의 표지판이 떠 있다. 좋아요를 보낼 수 있고, 누르는 만큼 간다.</p>' +
        '<p class="note">보내지 않고 지나가도 된다.</p><p class="sent" id="sent" aria-live="polite"></p><div id="mem-slot"></div>',
      buttons: [
        { label: LIKE_ICON + '좋아요', cls: 'like-btn', id: 'like-btn', fn: sendLike },
        { label: '그냥 지나가기', id: 'pass-btn', fn: passLadder },
      ],
    });
  }
  function sendLike() {
    if (S.sentLikes >= LIKE_CAP) return;
    S.sentLikes++;
    const h = el.ladderHolo;
    h.flash = 1;
    spawnRise(h.x, h.y - h.s * 0.55, h.s);
    sfxLike();
    const sent = document.getElementById('sent');
    if (sent) sent.textContent = `보낸 좋아요 ${S.sentLikes}` + (S.sentLikes >= LIKE_CAP ? ' · 한 번에 보낼 수 있는 만큼 다 보냈다.' : '');
    if (S.sentLikes >= LIKE_CAP) { const b = document.getElementById('like-btn'); if (b) b.disabled = true; }
    if (S.sentLikes === 1) {
      const slot = document.getElementById('mem-slot');
      if (slot) slot.innerHTML = memCard(MEM.ladder);
      const pass = document.getElementById('pass-btn');
      if (pass) pass.textContent = '계속 가기';
      S.panelH = panel.offsetHeight;
    }
  }
  function passLadder() {
    if (S.sentLikes > 0) { unblock(); return; }
    showPanel({
      tag: TAG.sim,
      title: '사다리를 지나간다',
      html: memCard(MEM.ladder),
      buttons: [{ label: '계속 가기', cls: 'go', fn: unblock }],
    });
  }

  // ---------- 게이트: 마을 · 국도 ----------
  function gateDeliver() {
    S.load = 'none';
    S.timing = false;
    el.townLight.setAttribute('opacity', 1);
    const good = S.cargo >= 95;
    showPanel({
      tag: TAG.npc,
      title: '배송 완료',
      html: '<p class="who">마을의 수령인 (게임 속 인물)</p>' +
        `<p class="say">${good ? '"먼 길 오셨네요. 잘 받았습니다."' : '"상자가 좀 젖었네요. 그래도 와 주셔서 다행이에요."'}</p>` +
        resultLine() +
        `<p class="like-line">${LIKE_ICON}<span>수령인이 좋아요 ${TOWN_LIKES}개를 보냈다. 게임이 정해 둔 반응이다.</span></p>` +
        memCard(MEM.npc),
      buttons: [{ label: '다음', cls: 'go', fn: showNetwork }],
    });
    setObjective('배송 완료', cargoSub());
    receive(P.TOWN[0] + 10, P.TOWN[1] - 64, TOWN_LIKES);
  }
  function showNetwork() {
    S.focus = FOCUS.net;
    pulseRing(el.netPulse, P.TOWN[0], P.TOWN[1], 620, 1.8);
    fadeIn(el.netRegion, 1.4, false);
    el.pavLight.setAttribute('fill', HOLO);
    sfxScan();
    showPanel({
      tag: TAG.sim,
      title: '마을이 네트워크에 연결됐다',
      html: '<p>배송을 마치면서 마을이 카이랄 네트워크에 연결됐다. 이 세계의 통신망이다. 연결된 곳에서는 도로 복구 장치 같은 시설이 작동한다.</p>' +
        '<p>아까 지나온 장치에도 불이 들어왔다.</p>',
      buttons: [{ label: '장치로 가기', cls: 'go', fn: () => { unblock(); setObjective('도로 복구 장치로'); startLeg(legToPaver()); } }],
    });
  }

  function gateBuild() {
    setObjective('국도 복구', buildSub());
    showPanel({
      tag: TAG.sim,
      title: '국도 복구',
      html: `<p>무너진 구간을 다시 이으려면 금속 ${NEED}, 세라믹 ${NEED}이 든다. 마을 창고에 둔 내 자재는 금속 ${STOCK.metal}, 세라믹 ${STOCK.ceramic}. 그동안 배송하면서 모은 것이다. 거의 다 들어간다.</p>` +
        '<p>길이 이어지면 이 구간을 차로 달릴 수 있다. 도로 가운데 선을 따라 달리면 배터리도 닳지 않는다. 다른 배달부들도 이 길을 쓰게 된다.</p>' +
        `<p class="note">한 번에 질 수 있는 양이 정해져 있어서 창고와 장치를 ${TRIPS}번 오가야 한다. 이 체험에서는 여기서 길을 잇고 넘어간다.</p>`,
      buttons: [{ label: '자재 가지러 가기', cls: 'go', fn: () => { unblock(); S.load = 'none'; setObjective(`자재 나르기 1/${TRIPS} · 창고로`, buildSub()); startLeg(legHaul()); } }],
    });
  }
  function loadMaterials(i) {
    S.load = 'materials';
    S.stun = 0.4;
    setObjective(`자재 나르기 ${i + 1}/${TRIPS} · 장치로`, buildSub());
    setCaption(i === 0 ? '자재를 졌다. 무거워서 걸음이 느리다.' : i === TRIPS - 1 ? '마지막 짐이다.' : `${i + 1}번째 짐이다.`, 3200);
  }
  function deposit(last) {
    const per = Math.round(NEED / TRIPS);
    S.deposits++;
    S.stock.metal -= per;
    S.stock.ceramic -= per;
    S.built = Math.min(1, S.deposits / TRIPS);
    S.load = 'none';
    S.stun = 0.7;
    sfxDeposit();
    if (last) {
      S.stock = { metal: STOCK.metal - NEED, ceramic: STOCK.ceramic - NEED };
      S.built = 1;
      finishBuild();
      return;
    }
    setObjective(`자재 나르기 ${S.deposits + 1}/${TRIPS} · 창고로`, buildSub());
  }
  function finishBuild() {
    S.focus = FOCUS.road;
    setObjective('국도 복구 완료', buildSub());
    el.energy.setAttribute('opacity', 0.3);
    el.tint.setAttribute('fill', '#10203a');
    el.tint.setAttribute('opacity', 0.26);
    showPanel({
      tag: TAG.sim,
      title: '국도가 이어졌다',
      html: `<p>남은 자재는 금속 ${S.stock.metal}, 세라믹 ${S.stock.ceramic}. 다음 장비를 만들 여유는 당분간 없다.</p>` +
        '<p>아직 이 길을 지나간 사람은 없다. 날이 저물었다.</p>',
      buttons: [{ label: '마을에서 하룻밤 쉬기', cls: 'go', fn: goNextDay }],
    });
  }

  function goNextDay() {
    hidePanel();
    const after = () => {
      S.focus = null;
      S.day = 2;
      S.mode = 'trike';
      S.load = 'none';
      el.tint.setAttribute('fill', '#f2c995');
      el.tint.setAttribute('opacity', 0.08);
      el.traces.setAttribute('opacity', 0.9);
      el.roadHolo.show = true;
      setObjective('배송 센터로 돌아가기', '오토바이');
      setCaption('다음 날 아침. 마을 차고에서 오토바이를 빌렸다. 어제 이은 길로 배송 센터에 돌아간다.', 6000);
      startLeg(legRide());
      S.cam = null;
      S.blocked = false;
      walkBtn.disabled = false;
      walkBtn.focus({ preventScroll: true });
    };
    if (reduced) { after(); return; }
    dayfade.classList.add('on');
    later(() => { after(); later(() => dayfade.classList.remove('on'), 400); }, 1100);
  }

  // ---------- 게이트: 다음 날 ----------
  function gateRoadReaction() {
    S.roadLikes = 0;
    S.focus = FOCUS.road;
    showPanel({
      tag: TAG.others,
      title: '어제 이은 구간',
      html: '<p>길 위에 바퀴 자국과 발자국이 나 있다. 밤사이 다른 배달부들이 이 길로 지나갔다.</p>' +
        `<p class="like-line big">${LIKE_ICON}<span>이 구간에 쌓인 좋아요 <b id="road-count">0</b></span></p>` +
        memCard(MEM.road),
      buttons: [{ label: '계속 달리기', cls: 'go', fn: unblock }],
    });
    const bump = () => { S.roadLikes++; const c = document.getElementById('road-count'); if (c) c.textContent = S.roadLikes; };
    ROAD_LIKES.forEach((n, i) => {
      const go = () => {
        toast(`배달부 한 명이 당신의 국도를 지나갔다 · 좋아요 ${n}`);
        const k = (i + 0.5) / ROAD_LIKES.length;
        const x = P.RB1[0] + (P.RB0[0] - P.RB1[0]) * k, y = P.RB1[1] + (P.RB0[1] - P.RB1[1]) * k - 26;
        receive(x, y, n, bump, 150);
      };
      if (reduced) go(); else later(go, 500 + i * 1000);
    });
  }
  function dismount() {
    S.mode = 'foot';
    S.stun = 0.6;
    el.parked.setAttribute('opacity', 1);
    el.roadHolo.show = false;
    setObjective('배송 센터로 돌아가기', '걸어서');
    setCaption('도로가 끝나는 곳이다. 오토바이를 세워 두고 걸어간다.', 4500);
  }

  function gateHome() {
    setObjective('배송 센터 도착');
    showPanel({
      tag: TAG.sim,
      title: '배송 센터에 돌아왔다',
      html: `<p>첫 배송이 끝났다. 이번에 받은 좋아요는 모두 ${S.likes}개다.</p>` +
        '<p>작은 배송이 하나 더 있다. 강가 오두막에 상자 하나를 전하는 짧은 길이다.</p>' +
        '<p class="note">여기서 마쳐도 아래 글과 질문은 그대로 이어진다.</p>',
      buttons: [
        { label: '여기서 마치기', fn: () => finish(false) },
        { label: '작은 배송 하나 더 하기', fn: startExtra },
      ],
    });
  }
  function startExtra() {
    S.extra = true;
    S.load = 'cargo';
    S.cargo = 100;
    S.moveTime = 0;
    S.timing = true;
    unblock();
    setObjective('상자 1개 · 강가 오두막으로', cargoSub());
    startLeg(legExtra());
  }
  function gateCabin() {
    S.load = 'none';
    S.timing = false;
    el.cabinLight.setAttribute('opacity', 1);
    showPanel({
      tag: TAG.npc,
      title: '배송 완료',
      html: '<p class="who">오두막의 수령인 (게임 속 인물)</p><p class="say">"와 주셨네요. 고마워요."</p>' + resultLine() +
        `<p class="like-line">${LIKE_ICON}<span>수령인이 좋아요 ${CABIN_LIKES}개를 보냈다.</span></p>`,
      buttons: [{ label: '기록 읽기', cls: 'go', fn: () => finish(true) }],
    });
    receive(P.CABIN[0], P.CABIN[1] - 56, CABIN_LIKES);
  }
  function finish(extraDone) {
    S.done = true;
    S.choice = extraDone ? 'extra' : 'end';
    S.leg = null;
    block();
    setObjective(extraDone ? '배송 2건 완료' : '배송 1건 완료');
    setCaption('');
    qChoice.textContent = extraDone ? '당신은 방금 작은 배송을 하나 더 했다.' : '당신은 첫 배송을 마치고 거기서 멈췄다.';
    qMain.textContent = '배송 끝에 좋아요가 뜨지 않았다면, 그 선택은 달라졌을까?';
    showPanel({
      tag: TAG.sim,
      title: '체험이 끝났다',
      html: '<p>아래에 이 체험을 만든 이유와, 묻고 싶은 질문이 있다.</p>',
      buttons: [
        { label: '기록 읽기', cls: 'go', fn: () => document.getElementById('essay').scrollIntoView({ behavior: reduced ? 'auto' : 'smooth' }) },
        { label: '처음부터 다시', fn: reset },
      ],
    });
    if (extraDone) document.getElementById('essay').scrollIntoView({ behavior: reduced ? 'auto' : 'smooth' });
  }

  // ---------- 입력 ----------
  let holdKey = false, holdPtr = false;
  const WALK_KEYS = new Set(['ArrowRight', 'd', 'D', 'ArrowUp', 'w', 'W']);

  // 무대가 화면에 충분히 보일 때만 방향키를 이동에 쓴다 (글을 읽을 때는 방향키를 빼앗지 않는다)
  function stageInView() {
    const r = stage.getBoundingClientRect();
    const seen = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
    return seen > Math.min(r.height, innerHeight) * 0.35;
  }

  function bindInput() {
    walkBtn.addEventListener('pointerdown', (e) => {
      if (walkBtn.disabled) return;
      e.preventDefault();
      holdPtr = true; walkBtn.classList.add('active');
      if (walkBtn.setPointerCapture) walkBtn.setPointerCapture(e.pointerId);
    });
    const stopPtr = () => { holdPtr = false; if (!holdKey) walkBtn.classList.remove('active'); };
    walkBtn.addEventListener('pointerup', stopPtr);
    walkBtn.addEventListener('pointercancel', stopPtr);
    walkBtn.addEventListener('lostpointercapture', stopPtr);
    walkBtn.addEventListener('contextmenu', (e) => e.preventDefault());
    walkBtn.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); holdKey = true; walkBtn.classList.add('active'); }
    });
    walkBtn.addEventListener('keyup', (e) => {
      if (e.key === ' ' || e.key === 'Enter') { holdKey = false; walkBtn.classList.remove('active'); }
    });
    document.addEventListener('keydown', (e) => {
      if (!WALK_KEYS.has(e.key) || e.altKey || e.ctrlKey || e.metaKey) return;
      const t = e.target;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
      if (!S.leg || S.blocked || !stageInView()) return;
      e.preventDefault();
      holdKey = true; walkBtn.classList.add('active');
    });
    document.addEventListener('keyup', (e) => {
      if (WALK_KEYS.has(e.key)) { holdKey = false; if (!holdPtr) walkBtn.classList.remove('active'); }
    });
    const releaseAll = () => { holdKey = false; holdPtr = false; walkBtn.classList.remove('active'); };
    window.addEventListener('blur', releaseAll);
    document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });

    autoBtn.addEventListener('click', () => {
      S.auto = !S.auto;
      autoBtn.setAttribute('aria-pressed', String(S.auto));
      autoBtn.textContent = S.auto ? '자동 진행 켜짐' : '자동 진행 꺼짐';
    });
    soundBtn.addEventListener('click', toggleSound);
    $('#restart').addEventListener('click', reset);
  }

  // ---------- 소리 (기본 꺼짐, 브라우저에서 합성) ----------
  let ac = null, windGain = null, soundOn = false;
  function toggleSound() {
    soundOn = !soundOn;
    soundBtn.setAttribute('aria-pressed', String(soundOn));
    soundBtn.textContent = soundOn ? '소리 켜짐' : '소리 꺼짐';
    if (soundOn) {
      if (!ac) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        ac = new Ctx();
        // 갈색 잡음을 낮은 음역만 남겨 바람 소리로 쓴다
        const len = ac.sampleRate * 4, buf = ac.createBuffer(1, len, ac.sampleRate), d = buf.getChannelData(0);
        let last = 0;
        for (let i = 0; i < len; i++) { last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02; d[i] = last * 3.2; }
        const src = ac.createBufferSource(); src.buffer = buf; src.loop = true;
        const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 520;
        windGain = ac.createGain(); windGain.gain.value = 0;
        src.connect(lp).connect(windGain).connect(ac.destination);
        src.start();
      }
      ac.resume();
      windGain.gain.setTargetAtTime(0.32, ac.currentTime, 0.8);
    } else if (ac) {
      windGain.gain.setTargetAtTime(0, ac.currentTime, 0.2);
    }
  }
  function tone(freqs, gap, peak, decay, type) {
    if (!soundOn || !ac) return;
    const t = ac.currentTime;
    freqs.forEach((f, i) => {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = type || 'sine'; o.frequency.value = f;
      const t0 = t + i * gap;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(peak, t0 + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + decay);
      o.connect(g).connect(ac.destination);
      o.start(t0); o.stop(t0 + decay + 0.05);
    });
  }
  const chime = () => tone([660, 990], 0.09, 0.06, 1.2);
  const sfxLike = () => tone([1180, 1570], 0.05, 0.05, 0.35);
  const sfxScan = () => tone([440, 660, 880], 0.07, 0.035, 0.6, 'triangle');
  const sfxDeposit = () => tone([196, 147], 0.08, 0.08, 0.4, 'triangle');
  const sfxThud = () => tone([110], 0, 0.12, 0.3, 'triangle');

  // ---------- 루프 ----------
  let vw = 1000, vh = 500, stageW = 1000, stageH = 500, clock = 0;
  function measure() {
    const r = stage.getBoundingClientRect();
    if (!r.width) return;
    stageH = r.height;
    stageW = r.width;
    vw = r.width >= 1000 ? 1050 : r.width >= 640 ? 780 : 470;
    vh = vw * (r.height / r.width);
    if (vh > H + 200) { vh = H + 200; vw = vh * (r.width / r.height); }
    if (S && S.panelOpen) S.panelH = panel.offsetHeight;
  }

  let lastTs = 0;
  function frame(ts) {
    const dt = Math.min(0.05, (ts - lastTs) / 1000 || 0);
    lastTs = ts;
    step(dt);
    render(dt);
    requestAnimationFrame(frame);
  }

  function speedFor(kind) {
    let k = KIND[kind] || 1;
    if (S.load === 'none') {
      if (kind === 'walk' || kind === 'road') k *= 1.15;
      if (kind === 'wade') k = 0.45;
    }
    return SPEED * k;
  }
  function recoverBalance(dt) {
    if (S.balance > 0) S.balance = Math.max(0, S.balance - dt * 1.5);
  }
  function stumble() {
    S.stumbles++;
    S.cargo = Math.max(40, S.cargo - 12);
    S.balance = 0.3;
    S.stun = 0.8;
    S.stumbleT = 0.8;
    sfxThud();
    setObjective('화물 1개 · 강 건너 마을로', cargoSub());
    setCaption(`넘어졌다. 화물이 젖었다. 화물 상태 ${S.cargo}%.`, 3500);
  }

  function step(dt) {
    if (S.builtShown < S.built) { S.builtShown = Math.min(S.built, S.builtShown + dt * 0.9); renderBuild(); }
    const leg = S.leg;
    if (!leg || S.blocked) { S.walking = false; recoverBalance(dt); return; }
    if (S.stun > 0) { S.stun -= dt; S.walking = false; recoverBalance(dt); return; }
    const p = pointAt(leg, S.t);
    const balancing = p.kind === 'wade' && S.load === 'cargo';
    const manual = holdKey || holdPtr;
    let want = manual || S.auto;
    // 자동 진행은 균형이 무너지기 전에 스스로 멈춰 쉰다 (자동 진행을 쓰는 사람이 벌을 받지 않게)
    if (balancing && S.auto && !manual) {
      if (S.autoRest) { if (S.balance <= 0.15) S.autoRest = false; else want = false; }
      else if (S.balance >= 0.7) { S.autoRest = true; want = false; }
    }
    S.walking = want;
    if (!want) { recoverBalance(dt); return; }
    if (!S.moved) { S.moved = true; if (S.panelOpen && !S.blocked) hidePanel(); }
    if (balancing) {
      S.balance += dt * 0.6;
      if (S.balance >= 1) { stumble(); return; }
    } else recoverBalance(dt);
    const speed = speedFor(p.kind);
    S.t = Math.min(leg.len, S.t + speed * dt);
    if (S.timing) S.moveTime += dt;
    S.phase += speed * dt * 0.09;
    while (S.gateIdx < leg.gates.length && S.t >= leg.gates[S.gateIdx].at) {
      const g = leg.gates[S.gateIdx++];
      if (g.block) { S.t = g.at; block(); g.fn(); break; }
      g.fn();
    }
  }

  function renderBuild() {
    const off = el.newLen * (1 - S.builtShown);
    el.newRoad.setAttribute('stroke-dashoffset', off.toFixed(1));
    el.newRoadLine.setAttribute('stroke-dashoffset', off.toFixed(1));
    el.rubble.setAttribute('opacity', (1 - S.builtShown * 0.85).toFixed(3));
    el.brokenLabel.setAttribute('opacity', (1 - S.builtShown).toFixed(3));
  }

  function render(dt) {
    clock += dt;
    updateFx(dt);
    let pos;
    if (S.leg) pos = pointAt(S.leg, S.t);
    else pos = S.lastPos || { x: P.BASE[0], y: P.BASE[1], kind: 'walk', dx: 1 };
    S.lastPos = pos;
    if (Math.abs(pos.dx) > 2) S.facing = pos.dx > 0 ? 1 : -1;

    const riding = S.mode === 'trike';
    const walking = S.walking;
    const swing = walking && !riding ? Math.sin(S.phase) : 0;
    const bob = walking && !riding ? Math.abs(Math.sin(S.phase)) * -1.4 : 0;
    let tilt = 0;
    if (!reduced && walking && !riding) {
      if (pos.kind === 'wade') tilt = Math.sin(S.phase * 0.5) * (3 + S.balance * 9);
      if (pos.kind === 'ladder') tilt = Math.sin(S.phase * 0.7) * 3;
      if (pos.kind === 'rubble' || pos.kind === 'haul') tilt = Math.sin(S.phase * 0.6) * 4;
    }
    if (S.stumbleT > 0) { S.stumbleT = Math.max(0, S.stumbleT - dt); tilt = reduced ? 0 : 55 * (S.stumbleT / 0.8); }
    el.porter.setAttribute('transform', `translate(${pos.x.toFixed(1)} ${pos.y.toFixed(1)}) scale(${S.facing * 1.25} 1.25)`);
    el.body.setAttribute('opacity', riding ? 0 : 1);
    el.trike.setAttribute('opacity', riding ? 1 : 0);
    el.body.setAttribute('transform', `translate(0 ${bob.toFixed(2)}) rotate(${tilt.toFixed(2)} 0 -6)`);
    el.legL.setAttribute('x2', (-3 + swing * 4).toFixed(2));
    el.legR.setAttribute('x2', (3 - swing * 4).toFixed(2));
    el.cargo.setAttribute('opacity', S.load === 'cargo' ? 1 : 0);
    el.mats.setAttribute('opacity', S.load === 'materials' ? 1 : 0);

    // 균형 게이지: 길이와 색이 함께 바뀐다
    const showBal = !!S.leg && pos.kind === 'wade' && S.load === 'cargo';
    el.bal.setAttribute('opacity', showBal ? 1 : 0);
    if (showBal) {
      el.bal.setAttribute('transform', `translate(${pos.x.toFixed(1)} ${(pos.y - 56).toFixed(1)})`);
      el.balFill.setAttribute('width', (32 * Math.min(1, S.balance)).toFixed(1));
      el.balFill.setAttribute('fill', S.balance < 0.6 ? '#9fe0b8' : '#f0c36a');
    }

    // 도로 가운데 선은 오토바이가 그 위를 달릴 때 밝아진다
    if (S.built >= 1) el.energy.setAttribute('opacity', riding && walking ? 0.85 : 0.3);

    // 홀로그램
    for (const h of el.holos) {
      const target = h.show ? 1 : 0;
      h.vis = reduced ? target : h.vis + (target - h.vis) * Math.min(1, dt * 4);
      h.flash = Math.max(0, h.flash - dt * 1.8);
      const hb = reduced ? 0 : Math.sin(clock * 2 + h.ph) * 2.5;
      h.g.setAttribute('transform', `translate(${h.x} ${(h.y + hb).toFixed(2)})`);
      h.g.setAttribute('opacity', (h.vis * (0.72 + 0.28 * h.flash)).toFixed(3));
      h.core.setAttribute('transform', `scale(${(1 + 0.16 * h.flash).toFixed(3)})`);
    }

    // 카메라: 평소에는 배달부를 따라가고, 패널이 열리면 배달부를 HUD 아래 ~ 패널 위 빈 공간 가운데에 둔다.
    // 판단 장면(S.focus)에서는 그 영역 전체가 빈 공간에 들어오도록 맞추고, 모자라면 조금 멀리서 본다.
    let targetX, targetY, zoom = 1;
    if (S.focus && stageH) {
      const f = S.focus, sw = stageW;
      const wide = sw >= 900 && S.panelOpen;
      const fl = wide ? panel.offsetLeft + panel.offsetWidth + 16 : 0;
      const fr = sw - 12, ft = hud.offsetTop + hud.offsetHeight + 8;   // 목표 칩이 여러 줄로 늘어도 그 아래부터
      const fb = !wide && S.panelOpen ? stageH - S.panelH - 20 : stageH - 12;
      const freeW = Math.max(80, fr - fl), freeH = Math.max(80, fb - ft);
      zoom = Math.max(1, ((f.x1 - f.x0) * sw / freeW) / vw, ((f.y1 - f.y0) * stageH / freeH) / vh);
      const vwz = vw * zoom, vhz = vh * zoom;
      targetX = (f.x0 + f.x1) / 2 + (sw / 2 - (fl + fr) / 2) * (vwz / sw);
      targetY = (f.y0 + f.y1) / 2 + (stageH / 2 - (ft + fb) / 2) * (vhz / stageH);
    } else if (S.panelOpen && stageH) {
      if (stageW >= 900) {
        // 넓은 화면: 패널은 왼쪽 아래에 있으니 배달부를 패널 오른쪽 빈 공간 가운데로
        const fl = panel.offsetLeft + panel.offsetWidth + 16, fr = stageW - 12;
        targetX = pos.x + (stageW / 2 - (fl + fr) / 2) * (vw / stageW);
        targetY = pos.y;
      } else {
        // 좁은 화면: 패널 위 빈 공간 가운데로. 홀로그램이 떠오를 자리를 위에 남긴다
        const free = Math.max(stageH * 0.3, stageH - S.panelH - 24);
        const top = hud.offsetTop + hud.offsetHeight;
        const want = Math.max(top + 50, (top + free) / 2);
        targetX = pos.x;
        targetY = pos.y + (stageH / 2 - want) * (vh / stageH);
      }
    } else {
      const lead = riding ? 0.2 : 0.12;
      targetX = pos.x + S.facing * vw * lead;
      targetY = pos.y;
    }
    if (!S.cam || reduced) { S.cam = { x: targetX, y: targetY }; S.zoom = zoom; }
    else {
      const k = Math.min(1, dt * 3);
      S.cam.x += (targetX - S.cam.x) * k;
      S.cam.y += (targetY - S.cam.y) * k;
      S.zoom += (zoom - S.zoom) * k;
    }
    const zw = vw * S.zoom, zh = vh * S.zoom;
    // 평소에는 세계 가장자리 밖을 거의 보여 주지 않고, 판단 장면에서는 배경이 깔린 범위까지 허용한다
    const mx = S.focus ? 380 : 60, myTop = S.focus ? 380 : 260, myBot = S.focus ? 1100 : 260;
    const cx = Math.max(zw / 2 - mx, Math.min(W - zw / 2 + mx, S.cam.x));
    const cy = Math.max(zh / 2 - myTop, Math.min(H - zh / 2 + myBot, S.cam.y));
    svg.setAttribute('viewBox', `${(cx - zw / 2).toFixed(1)} ${(cy - zh / 2).toFixed(1)} ${zw.toFixed(1)} ${zh.toFixed(1)}`);
  }

  // ---------- 시작 · 재시작 ----------
  function reset(e) {
    timers.forEach(clearTimeout);
    timers.clear();
    fx.forEach((f) => { if (f.el) f.el.remove(); });
    fx.length = 0;
    fades.clear();
    const auto = S ? S.auto : false;
    S = fresh();
    S.auto = auto;
    holdKey = false; holdPtr = false;
    walkBtn.classList.remove('active');
    walkBtn.disabled = false;
    dayfade.classList.remove('on');
    toasts.innerHTML = '';
    likesN.textContent = '0';
    likesChip.classList.remove('pulse');
    el.tint.setAttribute('opacity', 0);
    el.traces.setAttribute('opacity', 0);
    el.energy.setAttribute('opacity', 0);
    el.netRegion.setAttribute('opacity', 0);
    el.scan.setAttribute('opacity', 0);
    el.ladder.setAttribute('opacity', 0);
    el.parked.setAttribute('opacity', 0);
    [el.scanRing, el.netPulse].forEach((c) => { c.setAttribute('r', 0); c.setAttribute('opacity', 0); });
    el.holos.forEach((h) => { h.show = false; h.vis = 0; h.flash = 0; });
    el.townLight.setAttribute('opacity', .4);
    el.cabinLight.setAttribute('opacity', .35);
    el.pavLight.setAttribute('fill', '#d9a35a');
    renderBuild();
    qChoice.textContent = Q_DEFAULT.choice;
    qMain.textContent = Q_DEFAULT.main;
    setCaption('');
    setObjective('화물 1개 · 강 건너 마을로', cargoSub());
    startLeg(legOut1());
    showPanel({
      tag: TAG.sim,
      title: '배송 의뢰',
      html: '<p>배송 센터에 있는 화물 하나를 강 건너 마을까지 옮긴다.</p>' +
        '<p class="note">아래 "앞으로 가기"를 누르고 있으면 움직인다. 키보드는 → 키를 누르고 있으면 된다. 골라야 하는 곳에서는 저절로 멈춘다.</p>',
      focus: false,
    });
    if (e instanceof Event) {
      document.getElementById('play').scrollIntoView({ behavior: reduced ? 'auto' : 'smooth' });
      walkBtn.focus({ preventScroll: true });
    }
  }

  function init() {
    drawWorld();
    bindInput();
    measure();
    window.addEventListener('resize', measure);
    if ('ResizeObserver' in window) new ResizeObserver(measure).observe(stage);
    reset();
    requestAnimationFrame(frame);
  }
  init();

  // 검수용 훅 (상태 읽기 + 빠른 진행). 화면 동작에는 영향 없음.
  window.__ds = {
    get state() {
      return {
        leg: S.leg && S.leg.names.join('>'), t: Math.round(S.t), blocked: S.blocked, route: S.route,
        sentLikes: S.sentLikes, likes: S.likes, cargo: S.cargo, stumbles: S.stumbles, mode: S.mode, load: S.load,
        deposits: S.deposits, built: S.built, stock: { ...S.stock }, day: S.day, extra: S.extra, done: S.done, choice: S.choice,
        gates: S.leg ? S.leg.gates.length : 0, gateIdx: S.gateIdx, fx: fx.length,
      };
    },
    walkTo(t) { if (S.leg && !S.blocked) { S.t = Math.max(S.t, Math.min(t, S.leg.len) - 1); } },
    timers: () => timers.size,
    tick(dt) { step(dt); render(dt); },   // 탭이 가려져 rAF 가 멈춘 상태에서 검수할 때만 쓴다
  };
})();
