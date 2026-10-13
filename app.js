/* 작은 좋아요 하나 · 배송 체험
   구조: 세계 좌표(2600x1000)의 SVG 하나를 viewBox 로 따라가는 카메라.
   배달부는 "다리(leg)" 경로 위의 거리 t 로만 움직이고, 경로 위 지점마다 게이트가 걸려 있다.
   이벤트 핸들러와 rAF 루프는 init 때 한 번만 건다. 재시작은 reset() 이 상태 · DOM · 타이머를 되돌린다. */
(() => {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const NS = 'http://www.w3.org/2000/svg';
  const W = 2600, H = 1000;
  const SPEED = 125;                       // 세계 단위 / 초
  const KIND = { walk: 1, wade: 0.3, stones: 0.7, ladder: 0.45, road: 1.6 };
  const BUILD_SECONDS = 2.4;               // 길게 누를 때 길이 이어지는 시간
  const ROAD_LIKES = 14;                   // 귀환길 예시 숫자 (페이지가 만든 값)

  const motionMQ = matchMedia('(prefers-reduced-motion: reduce)');
  let reduced = motionMQ.matches;
  motionMQ.addEventListener && motionMQ.addEventListener('change', (e) => { reduced = e.matches; });

  // 지점 (세계 좌표)
  const P = {
    BASE: [180, 640], A: [380, 630], FORK: [540, 600],
    F1: [690, 612], FW: [772, 616], FE: [905, 602], F2: [990, 594],
    U1: [612, 476], U2: [716, 360], UW: [800, 306], UE: [872, 300], U3: [950, 362], U4: [1012, 500],
    C: [1062, 596], LW: [1166, 604], LE: [1282, 600],
    R0: [1380, 586], RB0: [1478, 576], RB1: [1780, 556], R1: [2150, 540], TOWN: [2330, 530],
    K1: [420, 760], CABIN: [560, 842],
  };

  const ROUTE = {
    ford: { names: ['FORK', 'F1', 'FW', 'FE', 'F2', 'C'], kinds: ['walk', 'walk', 'wade', 'walk', 'walk'] },
    up: { names: ['FORK', 'U1', 'U2', 'UW', 'UE', 'U3', 'U4', 'C'], kinds: ['walk', 'walk', 'walk', 'stones', 'walk', 'walk', 'walk'] },
  };
  const TAIL = { names: ['C', 'LW', 'LE', 'R0', 'RB0', 'RB1', 'R1', 'TOWN'], kinds: ['walk', 'ladder', 'walk', 'road', 'road', 'road', 'road'] };

  const LIKE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z"/></svg>';

  // ---------- 상태 ----------
  let S;
  const timers = new Set();
  function later(fn, ms) {
    const id = setTimeout(() => { timers.delete(id); fn(); }, ms);
    timers.add(id);
  }
  function fresh() {
    return {
      leg: null, t: 0, gateIdx: 0, blocked: false,
      route: null, liked: false, built: 0, building: false, buildDone: false,
      day: 1, carrying: true, extra: false, done: false,
      cam: null, facing: 1, phase: 0, moved: false, panelOpen: false,
      count: null,
    };
  }

  // ---------- 경로 ----------
  function makeLeg(names, kinds, opts) {
    const pts = names.map((n) => P[n]);
    const cum = [0];
    for (let i = 1; i < pts.length; i++) {
      cum.push(cum[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
    }
    const leg = { names, pts, kinds, cum, len: cum[cum.length - 1], gates: [], empty: !!(opts && opts.empty) };
    leg.at = (name, off) => leg.cum[names.indexOf(name)] + (off || 0);
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

  // ---------- DOM ----------
  const svg = $('#world');
  const stage = $('#stage');
  const panel = $('#panel');
  const caption = $('#caption');
  const objective = $('#objective');
  const walkBtn = $('#walk');
  const autoBtn = $('#auto');
  const soundBtn = $('#sound');
  const dayfade = $('#dayfade');
  const el = {};

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
      <symbol id="s-like" viewBox="0 0 24 24"><path d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z"/></symbol>`;

    // 땅과 먼 산
    node('rect', { x: -400, y: -400, width: W + 800, height: H + 800, fill: '#1b2826' }, svg);
    node('rect', { x: -400, y: -400, width: W + 800, height: 560, fill: 'url(#g-sky)' }, svg);
    node('rect', { x: -400, y: 150, width: W + 800, height: H + 250, fill: 'url(#g-ground)' }, svg);
    const far = node('g', { fill: '#4a5f62', opacity: '.75' }, svg);
    node('path', { d: 'M-400 170 L-200 110 L40 150 L260 70 L420 130 L640 60 L900 140 L1120 90 L1380 150 L1600 80 L1860 140 L2100 60 L2360 130 L2600 90 L3000 150 L3000 200 L-400 200Z' }, far);
    node('path', { d: 'M-400 200 L-120 160 L180 196 L480 150 L760 205 L1040 160 L1300 200 L1580 150 L1900 205 L2200 160 L2500 200 L3000 170 L3000 240 L-400 240Z', fill: '#3d5254' }, far);

    // 언덕 얼룩 · 바위 · 풀
    const deco = node('g', {}, svg);
    const r = rng(7);
    for (let i = 0; i < 26; i++) {
      node('ellipse', { cx: r() * W, cy: 260 + r() * 720, rx: 120 + r() * 220, ry: 30 + r() * 60, fill: r() > .5 ? '#2f4341' : '#1f2e2c', opacity: .55 }, deco);
    }
    for (let i = 0; i < 140; i++) {
      const x = r() * W, y = 240 + r() * 740, s = 3 + r() * 9;
      node('ellipse', { cx: x, cy: y, rx: s * 1.4, ry: s * .8, fill: r() > .4 ? '#45595a' : '#3a4b4b' }, deco);
    }
    const grass = node('g', { stroke: '#51685b', 'stroke-width': 1.2, fill: 'none', opacity: .45, 'stroke-linecap': 'round' }, svg);
    for (let i = 0; i < 130; i++) {
      const x = r() * W, y = 250 + r() * 740, h = 3 + r() * 5, lean = (r() - .5) * 3;
      node('path', { d: `M${x} ${y}q${lean} ${-h / 2} ${lean * 1.6 - 1.5} ${-h}M${x + 3} ${y}q${lean} ${-h / 2} ${lean * 1.6 + 1} ${-h * 1.2}` }, grass);
    }

    // 강
    node('path', { d: 'M815 150 Q800 230 800 300 Q790 460 770 615 Q760 800 790 1100 L935 1100 Q905 800 905 600 Q890 450 870 295 Q880 220 885 150Z', fill: 'url(#g-river)' }, svg);
    const ripple = node('g', { stroke: '#cfe3e0', 'stroke-width': 1.2, fill: 'none', opacity: .35 }, svg);
    for (let y = 200; y < 1000; y += 46) {
      const x = y < 330 ? 830 : 800 + (y - 330) * 0.02 + 14;
      node('path', { d: `M${x} ${y} q12 -5 24 0 t24 0` }, ripple);
    }
    el.ford = node('g', { opacity: .9 }, svg);           // 여울의 흰 물살
    for (let i = 0; i < 7; i++) node('path', { d: `M${782 + i * 17} ${606 + (i % 2) * 14} q6 -4 12 0`, stroke: '#eef6f3', 'stroke-width': 2, fill: 'none' }, el.ford);
    const stones = node('g', { fill: '#7d8b86' }, svg);  // 징검돌
    [[812, 306], [834, 300], [852, 304]].forEach(([x, y]) => node('ellipse', { cx: x, cy: y, rx: 9, ry: 5 }, stones));

    // 틈
    node('path', { d: 'M1200 360 L1184 440 L1196 520 L1176 600 L1190 690 L1172 780 L1186 880 L1196 1000 L1262 1000 L1252 880 L1268 780 L1250 690 L1270 600 L1252 520 L1264 440 L1246 360 L1222 300Z', fill: '#0c1415' }, svg);
    node('path', { d: 'M1222 300 L1200 360 L1184 440 L1196 520 L1176 600 L1190 690 L1172 780 L1186 880 L1196 1000', fill: 'none', stroke: '#6d8483', 'stroke-width': 2.5 }, svg);
    node('path', { d: 'M1222 300 L1246 360 L1264 440 L1252 520 L1270 600 L1250 690 L1268 780 L1252 880 L1262 1000', fill: 'none', stroke: '#3c4f4f', 'stroke-width': 2 }, svg);

    // 오솔길 (걷는 경로를 그대로 그린다)
    const trail = { fill: 'none', stroke: '#a7bdb1', 'stroke-width': 3, 'stroke-dasharray': '2 9', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', opacity: .8 };
    node('polyline', { points: poly(['BASE', 'A', 'FORK']), ...trail }, svg);
    node('polyline', { points: poly(ROUTE.ford.names), ...trail }, svg);
    node('polyline', { points: poly(ROUTE.up.names), ...trail }, svg);
    node('polyline', { points: poly(['C', 'LW']), ...trail }, svg);
    node('polyline', { points: poly(['LE', 'R0']), ...trail }, svg);
    node('polyline', { points: poly(['A', 'K1', 'CABIN']), ...trail }, svg);

    // 국도: 성한 구간 · 무너진 구간 · 새로 이을 구간
    const roadStyle = { fill: 'none', 'stroke-linecap': 'butt', 'stroke-linejoin': 'round' };
    node('polyline', { points: poly(['R0', 'RB0']), stroke: '#66746f', 'stroke-width': 30, ...roadStyle }, svg);
    node('polyline', { points: poly(['RB1', 'R1', 'TOWN']), stroke: '#66746f', 'stroke-width': 30, ...roadStyle }, svg);
    node('polyline', { points: poly(['R0', 'RB0']), stroke: '#9aa79f', 'stroke-width': 1.5, 'stroke-dasharray': '14 12', ...roadStyle }, svg);
    node('polyline', { points: poly(['RB1', 'R1', 'TOWN']), stroke: '#9aa79f', 'stroke-width': 1.5, 'stroke-dasharray': '14 12', ...roadStyle }, svg);
    el.rubble = node('g', {}, svg);
    const rr = rng(21);
    for (let i = 0; i < 46; i++) {
      const k = rr(), x = P.RB0[0] + (P.RB1[0] - P.RB0[0]) * k, y = P.RB0[1] + (P.RB1[1] - P.RB0[1]) * k + (rr() - .5) * 34;
      node('path', { d: `M${x} ${y} l${6 + rr() * 8} ${-4 - rr() * 6} l${6 + rr() * 6} ${5 + rr() * 4}Z`, fill: rr() > .5 ? '#55625e' : '#47524f' }, el.rubble);
    }
    const newLen = Math.hypot(P.RB1[0] - P.RB0[0], P.RB1[1] - P.RB0[1]);
    el.newRoad = node('polyline', { points: poly(['RB0', 'RB1']), stroke: '#7f918a', 'stroke-width': 30, ...roadStyle, 'stroke-dasharray': `${newLen} ${newLen}`, 'stroke-dashoffset': newLen }, svg);
    el.newRoadLine = node('polyline', { points: poly(['RB0', 'RB1']), stroke: '#d6e6dc', 'stroke-width': 1.5, ...roadStyle, 'stroke-dasharray': `${newLen} ${newLen}`, 'stroke-dashoffset': newLen }, svg);
    el.newLen = newLen;

    // 다음 날의 흔적: 발자국 · 바퀴 자국 (이은 구간 위)
    el.traces = node('g', { opacity: 0 }, svg);
    for (let i = 0; i < 20; i++) {
      const k = (i + .5) / 20, x = P.RB0[0] + (P.RB1[0] - P.RB0[0]) * k, y = P.RB0[1] + (P.RB1[1] - P.RB0[1]) * k;
      node('ellipse', { cx: x, cy: y - 6 + (i % 2) * 6, rx: 3, ry: 1.8, fill: '#26302e' }, el.traces);
    }
    node('polyline', { points: `${P.RB0[0]},${P.RB0[1] + 9} ${P.RB1[0]},${P.RB1[1] + 9}`, stroke: '#3d4945', 'stroke-width': 2.5, fill: 'none', 'stroke-dasharray': '18 6' }, el.traces);
    node('polyline', { points: `${P.RB0[0]},${P.RB0[1] + 3} ${P.RB1[0]},${P.RB1[1] + 3}`, stroke: '#3d4945', 'stroke-width': 2.5, fill: 'none', 'stroke-dasharray': '18 6' }, el.traces);

    // 도로 복구 장치와 자재 보관함
    const pav = node('g', { transform: `translate(${P.RB0[0] - 30} ${P.RB0[1] - 64})` }, svg);
    node('rect', { x: 0, y: 0, width: 34, height: 26, rx: 3, fill: '#8d9993', stroke: '#c9d4cd', 'stroke-width': 1.5 }, pav);
    node('rect', { x: 6, y: 6, width: 22, height: 6, fill: '#3f4c48' }, pav);
    el.pavLight = node('circle', { cx: 28, cy: 20, r: 3, fill: '#d9a35a' }, pav);
    const crate = node('g', { transform: `translate(${P.RB0[0] - 82} ${P.RB0[1] - 52})` }, svg);
    node('rect', { x: 0, y: 0, width: 26, height: 18, fill: '#6d6152', stroke: '#a59a88', 'stroke-width': 1.2 }, crate);
    node('rect', { x: 4, y: -10, width: 20, height: 12, fill: '#7a6d5c', stroke: '#a59a88', 'stroke-width': 1.2 }, crate);

    // 사다리
    const lad = node('g', { stroke: '#d8e3dc', 'stroke-width': 3, 'stroke-linecap': 'round' }, svg);
    const [lx0, ly0] = [P.LW[0] - 8, P.LW[1]], [lx1, ly1] = [P.LE[0] + 8, P.LE[1]];
    node('line', { x1: lx0, y1: ly0 - 7, x2: lx1, y2: ly1 - 7 }, lad);
    node('line', { x1: lx0, y1: ly0 + 7, x2: lx1, y2: ly1 + 7 }, lad);
    for (let i = 1; i < 10; i++) {
      const x = lx0 + (lx1 - lx0) * i / 10, y = ly0 + (ly1 - ly0) * i / 10;
      node('line', { x1: x, y1: y - 7, x2: x, y2: y + 7, 'stroke-width': 2 }, lad);
    }
    // 사다리 옆 표지: 좋아요를 보냈다면 작은 표시가 남는다
    // 사다리 끝의 표지(늘 보인다)와, 좋아요를 보냈을 때만 붙는 작은 표시. 배달부의 길 아래쪽에 둔다.
    const post = node('g', { transform: `translate(${P.LE[0] + 4} ${P.LE[1] + 14})` }, svg);
    node('line', { x1: 0, y1: 0, x2: 0, y2: 22, stroke: '#9fb2a9', 'stroke-width': 2 }, post);
    node('rect', { x: -9, y: 0, width: 18, height: 11, rx: 2, fill: '#c9d4cd' }, post);
    el.ladderSign = node('g', { transform: 'translate(13 -2)', opacity: 0 }, post);
    node('rect', { x: 0, y: 0, width: 40, height: 22, rx: 3, fill: '#0d1719', stroke: '#bfe5cf', 'stroke-width': 1 }, el.ladderSign);
    node('use', { href: '#s-like', x: 5, y: 4, width: 14, height: 14, fill: '#bfe5cf' }, el.ladderSign);
    node('text', { x: 24, y: 16, fill: '#bfe5cf', 'font-size': 13 }, el.ladderSign).textContent = '1';

    // 이은 길 옆 표지 (다음 날)
    const mid = [(P.RB0[0] + P.RB1[0]) / 2, (P.RB0[1] + P.RB1[1]) / 2];
    el.roadSign = node('g', { transform: `translate(${mid[0] - 30} ${mid[1] - 66})`, opacity: 0 }, svg);
    node('line', { x1: 30, y1: 30, x2: 30, y2: 50, stroke: '#9fb2a9', 'stroke-width': 2 }, el.roadSign);
    node('rect', { x: 0, y: 0, width: 60, height: 30, rx: 3, fill: '#0d1719', stroke: '#bfe5cf', 'stroke-width': 1 }, el.roadSign);
    node('use', { href: '#s-like', x: 6, y: 6, width: 18, height: 18, fill: '#bfe5cf' }, el.roadSign);
    el.roadSignText = node('text', { x: 30, y: 21, fill: '#bfe5cf', 'font-size': 15 }, el.roadSign);

    // 거점 · 마을 · 오두막
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
    const cabin = node('g', { transform: `translate(${P.CABIN[0]} ${P.CABIN[1]})` }, svg);
    node('path', { d: 'M-24 0 V-22 L0 -40 L24 -22 V0Z', fill: '#5d6a62', stroke: '#b9c9c1', 'stroke-width': 1.2 }, cabin);
    el.cabinLight = node('rect', { x: -5, y: -16, width: 10, height: 10, fill: '#e6c88a', opacity: .35 }, cabin);

    const label = (x, y, text) => {
      const t = node('text', { x, y, fill: '#dfe8e2', 'font-size': 17, 'text-anchor': 'middle', 'paint-order': 'stroke', stroke: '#162224', 'stroke-width': 4 }, svg);
      t.textContent = text;
      return t;
    };
    label(P.BASE[0], P.BASE[1] + 30, '거점');
    label(P.TOWN[0], P.TOWN[1] + 30, '마을');
    label(P.CABIN[0], P.CABIN[1] + 28, '강가 오두막');
    label(P.FW[0] - 18, P.FW[1] + 40, '여울');
    label(P.UW[0] + 30, P.UW[1] - 22, '징검돌');
    el.brokenLabel = label(P.RB0[0] + 150, P.RB0[1] + 46, '무너진 국도');

    // 배달부
    el.porter = node('g', {}, svg);
    node('ellipse', { cx: 0, cy: 2, rx: 9, ry: 3, fill: '#000', opacity: .35 }, el.porter);
    el.body = node('g', {}, el.porter);
    el.legL = node('line', { x1: -2, y1: -10, x2: -3, y2: 0, stroke: '#c7d3cc', 'stroke-width': 2.6, 'stroke-linecap': 'round' }, el.body);
    el.legR = node('line', { x1: 2, y1: -10, x2: 3, y2: 0, stroke: '#c7d3cc', 'stroke-width': 2.6, 'stroke-linecap': 'round' }, el.body);
    node('path', { d: 'M-5 -11 Q-6 -22 0 -24 Q6 -22 5 -11Z', fill: '#d9e3dd' }, el.body);
    node('circle', { cx: 1, cy: -28, r: 4.2, fill: '#e9efe9' }, el.body);
    el.cargo = node('rect', { x: -14, y: -32, width: 11, height: 20, rx: 1.5, fill: '#c9a76b', stroke: '#f0dcb0', 'stroke-width': 1 }, el.body);

    // 시간 색조 (다음 날 아침)
    el.tint = node('rect', { x: -400, y: -400, width: W + 800, height: H + 800, fill: '#f2c995', opacity: 0, 'pointer-events': 'none' }, svg);
    el.mist = node('ellipse', { cx: W / 2, cy: 420, rx: 1800, ry: 520, fill: 'url(#g-mist)', 'pointer-events': 'none' }, svg);
  }

  // ---------- 화면 문구 ----------
  function setObjective(text) { objective.textContent = text; }
  function setCaption(text, ms) {
    caption.textContent = text;
    if (ms) {
      const mine = text;
      later(() => { if (caption.textContent === mine) caption.textContent = ''; }, ms);
    }
  }

  function memCard(text) {
    return `<div class="mem-card"><span class="tag tag-mem">기억</span><p>${text}</p></div>`;
  }
  function likeLine(n, id) {
    return `<p class="like${reduced ? '' : ' pop'}">${LIKE_ICON}<span${id ? ` id="${id}"` : ''}>${n}</span></p>`;
  }

  // opts: { tag, title, html, buttons:[{label, sub, cls, fn}], block }
  function showPanel(opts) {
    panel.innerHTML = '';
    if (opts.tag) panel.insertAdjacentHTML('beforeend', opts.tag);
    if (opts.title) {
      const h = document.createElement('h3');
      h.textContent = opts.title;
      panel.appendChild(h);
    }
    if (opts.html) panel.insertAdjacentHTML('beforeend', opts.html);
    let first = null;
    if (opts.buttons && opts.buttons.length) {
      const row = document.createElement('div');
      row.className = 'opts';
      opts.buttons.forEach((b) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'opt' + (b.cls ? ' ' + b.cls : '');
        btn.innerHTML = b.label + (b.sub ? `<small>${b.sub}</small>` : '');
        if (b.fn) btn.addEventListener('click', b.fn);
        row.appendChild(btn);
        if (b.setup) b.setup(btn);
        if (!first) first = btn;
      });
      panel.appendChild(row);
    }
    panel.hidden = false;
    panel.scrollTop = 0;
    S.panelOpen = true;
    S.panelH = panel.offsetHeight;
    if (first && opts.focus !== false) first.focus({ preventScroll: true });
  }
  function hidePanel() {
    panel.hidden = true;
    panel.innerHTML = '';
    S.panelOpen = false;
  }
  function unblock() {
    hidePanel();
    S.blocked = false;
    walkBtn.disabled = false;
  }
  function block() {
    S.blocked = true;
    walkBtn.disabled = true;
    holdKey = false; holdPtr = false;
    walkBtn.classList.remove('active');
  }

  const TAG = {
    sim: '<span class="tag tag-sim">체험</span>',
    npc: '<span class="tag tag-sim">NPC 반응</span>',
    others: '<span class="tag tag-sim">다른 배달부의 반응 · 예시</span>',
  };

  // ---------- 다리(leg) 구성 ----------
  function startLeg(leg) {
    S.leg = leg; S.t = 0; S.gateIdx = 0;
  }

  function legOut1() {
    const leg = makeLeg(['BASE', 'A', 'FORK'], ['walk', 'walk']);
    addGates(leg, [
      { at: leg.len, block: true, fn: gateFork },
    ]);
    return leg;
  }

  function legOut2(route) {
    const R = ROUTE[route];
    const names = R.names.concat(TAIL.names.slice(1));
    const kinds = R.kinds.concat(TAIL.kinds);
    const leg = makeLeg(names, kinds);
    const g = [];
    if (route === 'ford') {
      g.push({ at: leg.at('FW', -4), fn: () => setCaption('물이 허리까지 온다. 물살에 등의 화물이 흔들린다. 한 걸음씩.', 6000) });
      g.push({ at: leg.at('FE', 4), fn: () => setCaption('건넜다. 젖은 발이 무겁다.', 3500) });
    } else {
      g.push({ at: leg.at('U1', 10), fn: () => setCaption('돌아가는 길은 멀다. 대신 발밑이 단단하다.', 5000) });
      g.push({ at: leg.at('UW', -4), fn: () => setCaption('물이 좁아진 곳. 젖은 돌을 하나씩 밟는다.', 4000) });
    }
    g.push({ at: leg.at('LW', -95), fn: () => setCaption('앞이 깊게 갈라져 있다. 그 위에 사다리 하나가 걸쳐 있다. 누군가 먼저 여기를 지나갔다.', 7000) });
    g.push({ at: leg.at('LW', 0), fn: () => setCaption('사다리 위에서는 천천히.', 3000) });
    g.push({ at: leg.at('LE', 26), block: true, fn: gateLadder });
    g.push({ at: leg.at('R0', -10), fn: () => setCaption('오래된 국도가 나왔다. 앞쪽 구간이 무너져 있다.', 5000) });
    g.push({ at: leg.at('RB0', 0), block: true, fn: gateBuild });
    g.push({ at: leg.at('RB0', 30), fn: () => setCaption('이은 길 위에서는 발이 가볍다.', 4000) });
    g.push({ at: leg.len, block: true, fn: gateDeliver });
    addGates(leg, g);
    return leg;
  }

  function legReturn() {
    const R = ROUTE[S.route];
    const out = R.names.concat(TAIL.names.slice(1));
    const kinds = R.kinds.concat(TAIL.kinds);
    const names = out.slice().reverse().concat(['A', 'BASE']);
    const k = kinds.slice().reverse().concat(['walk', 'walk']);
    const leg = makeLeg(names, k, { empty: true });
    addGates(leg, [
      { at: 30, fn: () => setCaption('빈 몸으로 거점에 돌아간다. 어제 걸은 길 그대로.', 5000) },
      { at: leg.at('RB1', 40), block: true, fn: gateRoadReaction },
      { at: leg.at('LE', -60), fn: () => setCaption(S.liked ? '사다리는 그대로 있다. 어제 보낸 좋아요도 표지에 남아 있다.' : '사다리는 그대로 걸려 있다.', 5000) },
      { at: leg.len, block: true, fn: gateHome },
    ]);
    return leg;
  }

  function legExtra() {
    const leg = makeLeg(['BASE', 'A', 'K1', 'CABIN'], ['walk', 'walk', 'walk']);
    addGates(leg, [
      { at: 20, fn: () => setCaption('작은 상자 하나. 강가 오두막까지 짧은 길이다.', 4500) },
      { at: leg.len, block: true, fn: gateCabin },
    ]);
    return leg;
  }

  // ---------- 게이트 ----------
  function gateFork() {
    showPanel({
      tag: TAG.sim,
      title: '강이 길을 가로막는다. 어디로 건널까?',
      html: '<p class="note">어느 쪽이든 마을에 닿는다. 길의 감촉이 다를 뿐이다.</p>',
      buttons: [
        { label: '여울로 건너기', sub: '가깝다. 허리까지 오는 물살에 화물이 흔들린다.', fn: () => chooseRoute('ford') },
        { label: '상류로 돌아가기', sub: '멀다. 물이 좁아지는 곳에 징검돌이 있다.', fn: () => chooseRoute('up') },
      ],
    });
  }
  function chooseRoute(route) {
    S.route = route;
    unblock();
    startLeg(legOut2(route));
    setCaption(route === 'ford' ? '여울 쪽으로 내려간다.' : '상류 쪽으로 오른다.', 3000);
  }

  function gateLadder() {
    showPanel({
      tag: TAG.sim,
      title: '사다리를 건넜다.',
      html: '<p>사다리 끝에 이것을 놓은 배달부의 표지가 붙어 있다. 이름은 알 수 없다. 좋아요를 보낼 수 있다.</p>' +
        '<p class="note">보내지 않아도 길은 그대로 이어진다.</p>',
      buttons: [
        { label: '좋아요 보내기', fn: () => answerLadder(true) },
        { label: '그냥 지나가기', fn: () => answerLadder(false) },
      ],
    });
  }
  function answerLadder(liked) {
    S.liked = liked;
    if (liked) { el.ladderSign.setAttribute('opacity', 1); chime(); }
    showPanel({
      tag: TAG.sim,
      title: liked ? '좋아요를 보냈다.' : '사다리를 뒤로하고 걷는다.',
      html: (liked ? likeLine(1) + '<p class="note">이 페이지 안에서만 표시된다. 어디에도 전송되지 않는다.</p>' : '') +
        memCard('실제 플레이에서, 다른 유저가 시의적절한 곳에 남긴 사다리에 좋아요를 눌러본 적이 있다.'),
      buttons: [{ label: '계속 걷기', cls: 'go', fn: unblock }],
    });
  }

  function gateBuild() {
    S.building = false;
    showPanel({
      tag: TAG.sim,
      title: '국도가 무너진 구간이다.',
      html: '<p>화물을 지고 이 잔해를 넘어가기는 어렵다. 옆에 도로 복구 장치가 있고, 보관함에 자재가 남아 있다.' +
        ' 자재를 넣으면 이 구간이 다시 이어진다. 이은 길은 내 배송에 먼저 쓰이고, 그 뒤에도 남는다.</p>' +
        '<p class="note">이 체험에서는 길을 이어야 앞으로 갈 수 있다.</p>' +
        '<div class="meter" aria-hidden="true"><i id="build-meter"></i></div>',
      buttons: [{ label: '자재 넣기', sub: '길게 누르기 · 탭하거나 Enter 를 눌러도 조금씩 들어간다', cls: 'hold', setup: setupHold }],
    });
  }
  function setupHold(btn) {
    btn.id = 'build-btn';
    btn.setAttribute('aria-describedby', 'build-progress');
    const start = (e) => { e.preventDefault(); S.building = true; btn.classList.add('active'); if (e.pointerId != null && btn.setPointerCapture) btn.setPointerCapture(e.pointerId); };
    const stop = () => { S.building = false; btn.classList.remove('active'); };
    btn.addEventListener('pointerdown', start);
    btn.addEventListener('pointerup', stop);
    btn.addEventListener('pointercancel', stop);
    btn.addEventListener('lostpointercapture', stop);
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
    btn.addEventListener('keydown', (e) => {
      if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); if (!e.repeat) addBuild(0.2); S.building = true; }
    });
    btn.addEventListener('keyup', (e) => { if (e.key === ' ' || e.key === 'Enter') stop(); });
    btn.addEventListener('click', (e) => { if (e.detail === 0) return; addBuild(0.12); });
    const prog = document.createElement('span');
    prog.id = 'build-progress';
    prog.className = 'note';
    prog.setAttribute('aria-live', 'polite');
    btn.after(prog);
  }
  function addBuild(d) {
    if (S.buildDone) return;
    S.built = Math.min(1, S.built + d);
    renderBuild();
  }
  let lastProgAnnounce = -1;
  function renderBuild() {
    const off = el.newLen * (1 - S.built);
    el.newRoad.setAttribute('stroke-dashoffset', off);
    el.newRoadLine.setAttribute('stroke-dashoffset', off);
    el.rubble.setAttribute('opacity', 1 - S.built * 0.85);
    el.brokenLabel.setAttribute('opacity', 1 - S.built);
    const m = document.getElementById('build-meter');
    if (m) m.style.width = (S.built * 100).toFixed(1) + '%';
    const step = Math.floor(S.built * 4);
    const p = document.getElementById('build-progress');
    if (p && step !== lastProgAnnounce) { lastProgAnnounce = step; p.textContent = `  ${Math.round(S.built * 100)}% 이어짐`; }
    if (S.built >= 1 && !S.buildDone) finishBuild();
  }
  function finishBuild() {
    S.buildDone = true;
    S.building = false;
    el.pavLight.setAttribute('fill', '#9fe0b8');
    showPanel({
      tag: TAG.sim,
      title: '구간이 이어졌다.',
      html: '<p>무너졌던 자리에 길이 놓였다. 아직 아무도 이 길을 지나가지 않았다.</p>',
      buttons: [{ label: '이은 길로 걷기', cls: 'go', fn: unblock }],
    });
  }

  function gateDeliver() {
    S.carrying = false;
    el.townLight.setAttribute('opacity', 1);
    chime();
    showPanel({
      tag: TAG.npc,
      title: '배송 완료',
      html: '<p class="who">마을의 수령인 (게임 속 인물)</p><p class="say">"먼 길이었죠. 잘 받았습니다."</p>' +
        likeLine(1) +
        '<p class="note">수령인이 좋아요 하나를 보냈다. 게임이 정해 둔 반응이다.</p>' +
        memCard('NPC가 자동으로 남기는 반응인 줄 알면서도, 퀘스트를 끝낼 때마다 받는 작은 좋아요에 성취감을 느꼈다. 그래서 서브퀘스트까지 스스로 찾아다녔던 것 같다.'),
      buttons: [{ label: '거점으로 돌아가기', cls: 'go', fn: goNextDay }],
    });
    setObjective('배송 완료 · 거점으로 돌아가기');
  }
  function goNextDay() {
    hidePanel();
    const after = () => {
      S.day = 2;
      el.tint.setAttribute('opacity', .1);
      el.traces.setAttribute('opacity', .9);
      el.roadSign.setAttribute('opacity', 1);
      el.roadSignText.textContent = '0';
      setObjective('다음 날 · 빈 몸으로 거점까지');
      startLeg(legReturn());
      S.blocked = false;
      walkBtn.disabled = false;
      walkBtn.focus({ preventScroll: true });
    };
    if (reduced) { after(); return; }
    dayfade.classList.add('on');
    later(() => { after(); S.cam = null; later(() => dayfade.classList.remove('on'), 400); }, 1100);
  }

  function gateRoadReaction() {
    showPanel({
      tag: TAG.others,
      title: '어제 이은 구간이다.',
      html: '<p>길 위에 발자국과 바퀴 자국이 나 있다. 내가 자리를 비운 사이, 다른 배달부들이 이 길을 지나갔다.' +
        ' 길가 표지에 좋아요가 쌓여 있다.</p>' + likeLine(0, 'road-count') +
        '<p class="note">이 숫자는 체험을 위해 페이지가 만든 예시다. 실제 사람의 반응이 아니다.</p>' +
        memCard('국도를 연결하고, 다음에 그곳을 지날 때마다 쌓여 있는 좋아요를 보며 뿌듯했다.'),
      buttons: [{ label: '계속 걷기', cls: 'go', fn: unblock }],
    });
    countUp(ROAD_LIKES);
    chime();
  }
  function countUp(to) {
    const target = document.getElementById('road-count');
    if (reduced) { target.textContent = to; el.roadSignText.textContent = to; return; }
    S.count = { v: 0, to, el: target, acc: 0 };
  }

  function gateHome() {
    setObjective('거점 도착');
    showPanel({
      tag: TAG.sim,
      title: '거점에 돌아왔다. 첫 배송이 끝났다.',
      html: '<p>작은 배송이 하나 더 있다. 강가 오두막에 상자 하나를 전하는 짧은 길이다.</p>' +
        '<p class="note">하지 않아도 아래의 글과 질문은 그대로 이어진다.</p>',
      buttons: [
        { label: '여기서 마치기', fn: () => finish(false) },
        { label: '작은 배송 하나 더 하기', fn: startExtra },
      ],
    });
  }
  function startExtra() {
    S.extra = true;
    S.carrying = true;
    unblock();
    setObjective('상자 1개 · 강가 오두막으로');
    startLeg(legExtra());
  }
  function gateCabin() {
    S.carrying = false;
    el.cabinLight.setAttribute('opacity', 1);
    chime();
    showPanel({
      tag: TAG.npc,
      title: '배송 완료',
      html: '<p class="who">오두막의 수령인 (게임 속 인물)</p><p class="say">"와 주셨네요. 고마워요."</p>' + likeLine(1),
      buttons: [{ label: '기록 읽기', cls: 'go', fn: () => finish(true) }],
    });
  }
  function finish(extraDone) {
    S.done = true;
    S.leg = null;
    block();
    setObjective(extraDone ? '배송 2건 완료' : '배송 1건 완료');
    setCaption('');
    showPanel({
      tag: TAG.sim,
      title: '체험이 끝났다.',
      html: '<p>아래로 내려가면 이 체험이 어디서 왔는지, 그리고 묻고 싶은 것이 있다.</p>',
      buttons: [
        { label: '기록 읽기', cls: 'go', fn: () => document.getElementById('essay').scrollIntoView({ behavior: reduced ? 'auto' : 'smooth' }) },
        { label: '처음부터 다시', fn: reset },
      ],
      focus: true,
    });
    if (extraDone) document.getElementById('essay').scrollIntoView({ behavior: reduced ? 'auto' : 'smooth' });
  }

  // ---------- 입력 ----------
  let holdKey = false, holdPtr = false;
  const WALK_KEYS = new Set(['ArrowRight', 'd', 'D', 'ArrowUp', 'w', 'W']);

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
    const releaseAll = () => { holdKey = false; holdPtr = false; S.building = false; walkBtn.classList.remove('active'); };
    window.addEventListener('blur', releaseAll);
    document.addEventListener('visibilitychange', () => { if (document.hidden) releaseAll(); });

    autoBtn.addEventListener('click', () => {
      S.auto = !S.auto;
      autoBtn.setAttribute('aria-pressed', String(S.auto));
      autoBtn.textContent = S.auto ? '자동 걷기 켜짐' : '자동 걷기 꺼짐';
    });
    soundBtn.addEventListener('click', toggleSound);
    $('#restart').addEventListener('click', reset);
  }

  // 무대가 화면에 충분히 보일 때만 방향키를 걷기로 쓴다 (글을 읽을 때는 방향키를 빼앗지 않는다)
  function stageInView() {
    const r = stage.getBoundingClientRect();
    const seen = Math.min(r.bottom, innerHeight) - Math.max(r.top, 0);
    return seen > Math.min(r.height, innerHeight) * 0.35;
  }

  // ---------- 소리 (기본 꺼짐, 브라우저 합성) ----------
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
  function chime() {
    if (!soundOn || !ac) return;
    const t = ac.currentTime;
    [660, 990].forEach((f, i) => {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = 'sine'; o.frequency.value = f;
      g.gain.setValueAtTime(0, t + i * 0.09);
      g.gain.linearRampToValueAtTime(0.07, t + i * 0.09 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.09 + 1.2);
      o.connect(g).connect(ac.destination);
      o.start(t + i * 0.09); o.stop(t + i * 0.09 + 1.3);
    });
  }

  // ---------- 루프 ----------
  let vw = 1000, vh = 500, stageH = 500;
  function measure() {
    const r = stage.getBoundingClientRect();
    if (!r.width) return;
    stageH = r.height;
    if (S && S.panelOpen) S.panelH = panel.offsetHeight;
    vw = r.width >= 1000 ? 1050 : r.width >= 640 ? 780 : 470;
    vh = vw * (r.height / r.width);
    if (vh > H + 200) { vh = H + 200; vw = vh * (r.width / r.height); }
  }

  let lastTs = 0;
  function frame(ts) {
    const dt = Math.min(0.05, (ts - lastTs) / 1000 || 0);
    lastTs = ts;
    step(dt);
    render(dt);
    requestAnimationFrame(frame);
  }

  function step(dt) {
    if (S.building && !S.buildDone) { S.built = Math.min(1, S.built + dt / BUILD_SECONDS); renderBuild(); }
    if (S.count) {
      S.count.acc += dt;
      if (S.count.acc > 0.11) {
        S.count.acc = 0;
        S.count.v++;
        S.count.el.textContent = S.count.v;
        el.roadSignText.textContent = S.count.v;
        if (S.count.v >= S.count.to) S.count = null;
      }
    }
    const leg = S.leg;
    if (!leg || S.blocked) { S.walking = false; return; }
    const moving = holdKey || holdPtr || S.auto;
    S.walking = moving;
    if (!moving) return;
    if (!S.moved) { S.moved = true; if (S.panelOpen && !S.blocked) hidePanel(); }
    const p = pointAt(leg, S.t);
    const speed = SPEED * (KIND[p.kind] || 1) * (leg.empty && p.kind === 'walk' ? 1.15 : 1);
    S.t = Math.min(leg.len, S.t + speed * dt);
    S.phase += speed * dt * 0.09;
    while (S.gateIdx < leg.gates.length && S.t >= leg.gates[S.gateIdx].at) {
      const g = leg.gates[S.gateIdx++];
      if (g.block) { S.t = g.at; block(); g.fn(); break; }
      g.fn();
    }
  }

  function render(dt) {
    let pos;
    if (S.leg) pos = pointAt(S.leg, S.t);
    else pos = S.lastPos || { x: P.BASE[0], y: P.BASE[1], kind: 'walk', dx: 1 };
    S.lastPos = pos;
    if (Math.abs(pos.dx) > 2) S.facing = pos.dx > 0 ? 1 : -1;

    const walking = S.walking;
    const swing = walking ? Math.sin(S.phase) : 0;
    const bob = walking ? Math.abs(Math.sin(S.phase)) * -1.4 : 0;
    let tilt = 0;
    if (walking && !reduced && pos.kind === 'wade') tilt = Math.sin(S.phase * 0.5) * 7;
    if (walking && !reduced && pos.kind === 'ladder') tilt = Math.sin(S.phase * 0.7) * 3;
    el.porter.setAttribute('transform', `translate(${pos.x.toFixed(1)} ${pos.y.toFixed(1)}) scale(${S.facing * 1.25} 1.25)`);
    el.body.setAttribute('transform', `translate(0 ${bob.toFixed(2)}) rotate(${tilt.toFixed(2)} 0 -6)`);
    el.legL.setAttribute('x2', (-3 + swing * 4).toFixed(2));
    el.legR.setAttribute('x2', (3 - swing * 4).toFixed(2));
    el.cargo.setAttribute('opacity', S.carrying ? 1 : 0);

    // 카메라: 패널이 열리면 배달부를 화면 위쪽에 둔다
    const targetX = pos.x + S.facing * vw * 0.12;
    // 패널이 열리면 배달부를 HUD 아래 ~ 패널 위 빈 공간의 가운데에 둔다
    let shift = 0;
    if (S.panelOpen && stageH) {
      const free = Math.max(stageH * 0.3, stageH - S.panelH - 24);
      const want = Math.max(70, (56 + free) / 2);
      shift = (stageH / 2 - want) * (vh / stageH);
    }
    const targetY = pos.y + shift;
    if (!S.cam || reduced) S.cam = { x: targetX, y: targetY };
    else {
      const k = Math.min(1, dt * 3);
      S.cam.x += (targetX - S.cam.x) * k;
      S.cam.y += (targetY - S.cam.y) * k;
    }
    const cx = Math.max(vw / 2 - 60, Math.min(W - vw / 2 + 60, S.cam.x));
    const cy = Math.max(vh / 2 - 260, Math.min(H - vh / 2 + 260, S.cam.y));
    svg.setAttribute('viewBox', `${(cx - vw / 2).toFixed(1)} ${(cy - vh / 2).toFixed(1)} ${vw.toFixed(1)} ${vh.toFixed(1)}`);
  }

  // ---------- 시작 · 재시작 ----------
  function reset() {
    timers.forEach(clearTimeout);
    timers.clear();
    const auto = S ? S.auto : false;
    S = fresh();
    S.auto = auto;
    holdKey = false; holdPtr = false;
    lastProgAnnounce = -1;
    walkBtn.classList.remove('active');
    walkBtn.disabled = false;
    dayfade.classList.remove('on');
    el.tint.setAttribute('opacity', 0);
    el.traces.setAttribute('opacity', 0);
    el.roadSign.setAttribute('opacity', 0);
    el.ladderSign.setAttribute('opacity', 0);
    el.townLight.setAttribute('opacity', .4);
    el.cabinLight.setAttribute('opacity', .35);
    el.pavLight.setAttribute('fill', '#d9a35a');
    renderBuild();
    setCaption('');
    setObjective('화물 1개 · 강 건너 마을로');
    startLeg(legOut1());
    showPanel({
      tag: TAG.sim,
      title: '거점에서 출발한다.',
      html: '<p>등에 진 화물 하나를 강 건너 마을에 전하는 것이 목표다.</p>' +
        '<p class="note">아래 "앞으로 걷기"를 길게 누르거나, 키보드 → 키를 누르고 있으면 걷는다. 길을 고르는 곳에서는 저절로 멈춘다.</p>',
      focus: false,
    });
    if (arguments.length && arguments[0] instanceof Event) {
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

  // 검수용 훅 (게임 상태 읽기 전용 + 빠른 진행). 화면에는 영향 없음.
  window.__ds = {
    get state() { return { leg: S.leg && S.leg.names.join('>'), t: Math.round(S.t), blocked: S.blocked, route: S.route, liked: S.liked, built: S.built, day: S.day, extra: S.extra, done: S.done, gates: S.leg ? S.leg.gates.length : 0, gateIdx: S.gateIdx }; },
    walkTo(t) { if (S.leg && !S.blocked) { S.t = Math.max(S.t, Math.min(t, S.leg.len) - 1); } },
    timers: () => timers.size,
    tick(dt) { step(dt); render(dt); },   // 탭이 가려져 rAF 가 멈춘 상태에서 검수할 때만 쓴다
  };
})();
