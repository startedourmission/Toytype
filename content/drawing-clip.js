// Toytype Google Docs 그리기 클립보드 도해.
// 구글 그리기에서 도형을 복사하면 Chrome 클립보드에 구글 내부 형식
// (application/x-vnd.google-docs-drawings-object+wrapped)이 들어간다. 이 형식을 직접 만들어
// copy 이벤트로 넣으면, 사용자는 그리기 창에서 붙여넣기만 하면 편집 가능한 도형을 얻는다.
//
// 내부 형식 (편집자 견본 클립보드에서 역분석)
//   [3, id, 도형종류, [a,b,c,d,tx,ty], 속성배열, "p"]   도형 생성 (a,d 배율 / b,c 회전 / tx,ty 위치)
//   [15, id, null, 0, "텍스트"]                          텍스트 삽입
//   [17, id, null, 시작, 끝, [], [키,값...]]              텍스트 스타일 (12:2 가운데 정렬, 6:글자 pt)
//   좌표 단위 1pt = 508, 도형 배율 1.0 = 120000
//   도형종류 3 이미지, 6 사각형, 7 둥근 사각형, 145 꺾인 연결선(1회), 146 꺾인 연결선(2회), 153 직선
//   속성 14 채우기 유무, 15 채우기색, 16 채우기 불투명, 18 선 불투명, 19 선색, 22 선굵기,
//        26 시작 머리, 29 끝 머리(3 동그란 점, 7 화살촉), 43 선 모양(견본 값 2),
//        49 이미지 blob id, 8/9 이미지 픽셀 크기, 51/52 시작·끝 연결 [도형id, 연결점], 53 글 여백
//   연결점: 0 위, 1 왼쪽, 2 아래, 3 오른쪽
//   이미지는 image-clip 형식의 image_urls에 data URL을 넣으면 구글이 업로드한다.
//
// 알려진 한계: 줄바꿈이 든 텍스트는 그리기 화면에는 보이지만 저장 동기화가 거부된다.
// 형식을 확인하기 전까지 줄바꿈은 공백으로 바꾼다.
'use strict';
(() => {
  const PT = 508;
  const BASE = 120000;
  const MIME_DRAWING = 'application/x-vnd.google-docs-drawings-object+wrapped';
  const MIME_IMAGE = 'application/x-vnd.google-docs-image-clip+wrapped';
  const MIME_CLIP_ID = 'application/x-vnd.google-docs-internal-clip-id';
  const MIME_DOC_SLICE = 'application/x-vnd.google-docs-document-slice-clip+wrapped';
  const CAPTURE_TYPES = ['text/html', 'text/plain', MIME_DRAWING, MIME_IMAGE, MIME_DOC_SLICE];
  const SITE = { top: 0, left: 1, bottom: 2, right: 3 };
  const HEAD = { none: 0, dot: 3, arrow: 7 };
  const KIND = { straight: 153, elbow: 145, elbow2: 146 };
  const KIND_BY_TYPE = { 153: 'straight', 145: 'elbow', 146: 'elbow2' };
  const RED = '#FF0000';
  const LABEL_INSET = 1717;

  // 골든래빗 스크린샷 강조 스타일은 편집자 견본 그대로, 일반 도해는 견본 도해(자료구조)의 기본 스타일.
  const STYLE = {
    box: { line: RED, weight: 2.25, fill: null, round: true },
    label: { line: RED, weight: 3, fill: '#FFFFFF', round: true, size: 12 },
    annotateLine: { line: RED, weight: 1.5, dash: 2 },
    node: { line: '#000000', weight: 0.75, fill: '#CFE2F3', round: true, size: 12 },
    diagramLine: { line: '#000000', weight: 1, dash: 0 }
  };
  const NODE_FILLS = ['#CFE2F3', '#D9EAD3', '#FFF2CC', '#FCE5CD', '#F4CCCC', '#D9D2E9', '#EFEFEF', '#FFFFFF'];

  function J(o) {
    return JSON.stringify(o);
  }

  function round4(n) {
    return Math.round(n * 10000) / 10000;
  }

  function cleanText(text) {
    return String(text == null ? '' : text).replace(/\s*\n\s*/g, ' ').trim();
  }

  function textWidthPt(text, size) {
    let em = 0;
    for (const ch of Array.from(text)) em += ch.codePointAt(0) > 0x2e80 ? 1 : 0.55;
    return em * size;
  }

  function hexColor(value, fallback) {
    const v = String(value || '').trim();
    return /^#[0-9a-fA-F]{6}$/.test(v) ? v.toUpperCase() : fallback;
  }

  function randomId(bytes) {
    const a = new Uint8Array(bytes);
    globalThis.crypto.getRandomValues(a);
    return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
  }

  function randomBlobId() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    const a = new Uint8Array(11);
    globalThis.crypto.getRandomValues(a);
    return 's-blob-v1-IMAGE-' + Array.from(a, b => chars[b % 64]).join('');
  }

  function uuid() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') return globalThis.crypto.randomUUID();
    const h = randomId(16);
    return [h.slice(0, 8), h.slice(8, 12), h.slice(12, 16), h.slice(16, 20), h.slice(20)].join('-');
  }

  // ---------- 일반 도해 자동 배치 ----------

  // 노드와 화살표만 받은 도해를 층(layer) 단위로 배치한다. 계층도·흐름도 공용.
  // 결과 좌표 단위는 pt.
  function layoutDiagram(spec) {
    const direction = String(spec.direction || 'TB').toUpperCase() === 'LR' ? 'LR' : 'TB';
    const nodes = (spec.items || []).filter(it => it && it.type === 'node' && it.id);
    const byId = new Map(nodes.map(n => [String(n.id), n]));
    const edges = (spec.items || []).filter(it => it && it.type === 'arrow' && byId.has(String(it.from)) && byId.has(String(it.to)));
    const out = new Map(nodes.map(n => [String(n.id), []]));
    const indeg = new Map(nodes.map(n => [String(n.id), 0]));
    for (const e of edges) {
      out.get(String(e.from)).push(String(e.to));
      indeg.set(String(e.to), indeg.get(String(e.to)) + 1);
    }

    // 최장 경로 층 배정. 순환은 DFS 방문 중인 노드로 가는 간선을 무시해서 끊는다.
    const layer = new Map();
    const state = new Map();
    function visit(id, depth) {
      if (state.get(id) === 'active') return;
      if (layer.has(id) && layer.get(id) >= depth) return;
      layer.set(id, depth);
      state.set(id, 'active');
      for (const next of out.get(id)) visit(next, depth + 1);
      state.set(id, 'done');
    }
    for (const n of nodes) if (indeg.get(String(n.id)) === 0) visit(String(n.id), 0);
    for (const n of nodes) if (!layer.has(String(n.id))) visit(String(n.id), 0);

    const size = new Map();
    for (const n of nodes) {
      const st = Object.assign({}, STYLE.node, pickStyle(n));
      const text = cleanText(n.text);
      const w = Math.max(80, textWidthPt(text, st.size) + 28);
      const h = Math.max(30, st.size * 1.35 + 14);
      size.set(String(n.id), { w, h });
    }

    // 층 안 위치: 각 노드의 첫 부모(바로 윗층)를 트리 부모로 삼아, 자식을 먼저 놓고
    // 부모를 자식들 가운데에 둔다. 겹치면 그 하위 트리 전체를 오른쪽(LR이면 아래)으로 민다.
    const GAP_IN = 24;
    const GAP_LAYER = direction === 'TB' ? 44 : 60;
    const span = id => (direction === 'TB' ? size.get(id).w : size.get(id).h);
    const depthOf = id => (direction === 'TB' ? size.get(id).h : size.get(id).w);
    const children = new Map(nodes.map(n => [String(n.id), []]));
    const hasTreeParent = new Set();
    for (const e of edges) {
      const from = String(e.from);
      const to = String(e.to);
      if (hasTreeParent.has(to) || layer.get(to) !== layer.get(from) + 1) continue;
      hasTreeParent.add(to);
      children.get(from).push(to);
    }
    const along = new Map();
    const nextFree = [];
    function subtree(id, out) {
      out.push(id);
      for (const c of children.get(id)) subtree(c, out);
      return out;
    }
    function place(id) {
      const l = layer.get(id);
      const kids = children.get(id);
      for (const c of kids) place(c);
      let p;
      if (kids.length) {
        const first = along.get(kids[0]);
        const last = along.get(kids[kids.length - 1]) + span(kids[kids.length - 1]);
        p = (first + last) / 2 - span(id) / 2;
      } else {
        p = nextFree[l] || 0;
      }
      const shift = (nextFree[l] || 0) - p;
      if (shift > 0) {
        for (const d of subtree(id, [])) {
          along.set(d, (along.get(d) || 0) + shift);
          const dl = layer.get(d);
          nextFree[dl] = Math.max(nextFree[dl] || 0, along.get(d) + span(d) + GAP_IN);
        }
        p += shift;
      }
      along.set(id, p);
      nextFree[l] = Math.max(nextFree[l] || 0, p + span(id) + GAP_IN);
    }
    for (const n of nodes) if (!hasTreeParent.has(String(n.id))) place(String(n.id));

    const minAlong = Math.min(...nodes.map(n => along.get(String(n.id))));
    const depthSize = [];
    for (const n of nodes) {
      const l = layer.get(String(n.id));
      depthSize[l] = Math.max(depthSize[l] || 0, depthOf(String(n.id)));
    }
    const cross = [];
    for (let l = 0, c = 0; l < depthSize.length; l++) {
      cross[l] = c;
      c += (depthSize[l] || 0) + GAP_LAYER;
    }
    const rects = new Map();
    for (const n of nodes) {
      const id = String(n.id);
      const s = size.get(id);
      const a = along.get(id) - minAlong;
      const l = layer.get(id);
      if (direction === 'TB') rects.set(id, [a, cross[l], s.w, s.h]);
      else rects.set(id, [cross[l] + (depthSize[l] - s.w) / 2, a, s.w, s.h]);
    }

    const items = [];
    for (const n of nodes) items.push(Object.assign({}, n, { type: 'node', rect: rects.get(String(n.id)) }));
    for (const e of edges) {
      const lf = layer.get(String(e.from));
      const lt = layer.get(String(e.to));
      const forward = lt > lf;
      const item = Object.assign({}, e);
      if (forward && !e.fromSite && !e.toSite) {
        item.fromSite = direction === 'TB' ? 'bottom' : 'right';
        item.toSite = direction === 'TB' ? 'top' : 'left';
        if (!e.kind) {
          const a = rects.get(String(e.from));
          const b = rects.get(String(e.to));
          const aligned = direction === 'TB'
            ? Math.abs((a[0] + a[2] / 2) - (b[0] + b[2] / 2)) < 1
            : Math.abs((a[1] + a[3] / 2) - (b[1] + b[3] / 2)) < 1;
          item.kind = aligned ? 'straight' : 'elbow2';
        }
      }
      items.push(item);
    }
    return items;
  }

  function pickStyle(it) {
    const st = {};
    if (it.fill !== undefined) st.fill = it.fill === null ? null : hexColor(it.fill, null);
    if (it.line !== undefined) st.line = hexColor(it.line, undefined);
    if (Number.isFinite(Number(it.weight))) st.weight = Math.min(8, Math.max(0.25, Number(it.weight)));
    if (Number.isFinite(Number(it.size))) st.size = Math.min(36, Math.max(7, Math.round(Number(it.size))));
    if (typeof it.round === 'boolean') st.round = it.round;
    if (Number.isInteger(it.dash) && it.dash >= 0) st.dash = it.dash;
    for (const k of Object.keys(st)) if (st[k] === undefined) delete st[k];
    return st;
  }

  // ---------- 클립보드 페이로드 ----------

  // spec.mode
  //   'annotate': 좌표는 스크린샷 픽셀(왼쪽 위 원점). items: box, label, arrow
  //   'diagram' : items: node, arrow. 좌표 없이 주면 자동 배치, rect를 주면 그 pt 좌표 사용
  // image: { dataUrl, width, height } — annotate일 때 스크린샷
  function buildDrawingPayload(spec, image) {
    const mode = spec && spec.mode === 'annotate' ? 'annotate' : 'diagram';
    const pfx = 'g' + randomId(5) + '_0_';
    let counter = 0;
    const nid = () => pfx + String(++counter);
    const cmds = [];
    const autotext = {};
    const shapes = new Map();
    const ox = 20 * PT;
    const oy = 20 * PT;
    let s = PT; // 스펙 좌표 1 → 단위
    let imageClip = null;

    if (mode === 'annotate' && image && image.dataUrl && image.width > 0 && image.height > 0) {
      const widthPt = Number(spec.widthPt) > 0 ? Number(spec.widthPt) : defaultImageWidthPt(image.width);
      s = widthPt * PT / image.width;
      const blob = randomBlobId();
      cmds.push([3, nid(), 3, [round4(s), 0, 0, round4(s), Math.round(ox), Math.round(oy)],
        [15, '#CFE2F3', 18, 1, 19, '#000000', 22, 381, 49, blob, 8, image.width, 9, image.height], 'p']);
      imageClip = { image_urls: { [blob]: image.dataUrl }, placeholder_ids: {}, cosmo_ids: {} };
    }
    const ptPerUnit = s / PT; // 스펙 좌표 1이 몇 pt인지
    const U = (x, y) => [ox + x * s, oy + y * s];

    const items = mode === 'diagram' ? positionDiagramItems(spec) : (spec.items || []);
    const blobRefs = [];

    // 기존 그리기 안의 이미지. 받아 둔 픽셀(dataUrl)이 있으면 새 blob id로 직접 넣고,
    // 없으면 원래 blob id만 참조한다(같은 문서에서도 깨질 수 있어 최후 수단).
    const embedded = {};
    function addImage(it) {
      if (!it.blob || !Array.isArray(it.rect) || !Array.isArray(it.rawProps)) return;
      const props = propMap(it.rawProps);
      if (it.dataUrl && it.pixelWidth > 0 && it.pixelHeight > 0) {
        const blob = randomBlobId();
        props.set(49, blob);
        props.set(8, it.pixelWidth);
        props.set(9, it.pixelHeight);
        embedded[blob] = it.dataUrl;
      } else if (!blobRefs.includes(it.blob)) {
        blobRefs.push(it.blob);
      }
      const pw = Number(props.get(8));
      const ph = Number(props.get(9));
      const [x, y, w, h] = it.rect.map(Number);
      if (!(pw > 0 && ph > 0) || ![x, y, w, h].every(Number.isFinite)) return;
      const id = nid();
      shapes.set(String(it.id), { id, x, y, w, h });
      const [ux, uy] = U(x, y);
      cmds.push([3, id, 3, [round4(w * s / pw), 0, 0, round4(h * s / ph), Math.round(ux), Math.round(uy)], [].concat(...props.entries()), 'p']);
    }

    function addShape(it, base) {
      const st = Object.assign({}, base, pickStyle(it));
      const text = cleanText(it.text);
      let [x, y, w, h] = Array.isArray(it.rect) ? it.rect.map(v => (v == null ? null : Number(v))) : [0, 0, null, null];
      if (w == null || h == null || !(w > 0) || !(h > 0)) {
        const twPt = textWidthPt(text, st.size || 12) + 2 * LABEL_INSET / PT + 2 * st.weight + 10;
        const thPt = (st.size || 12) * 1.35 + 2 * LABEL_INSET / PT + 2 * st.weight + 6;
        if (!(w > 0)) w = twPt / ptPerUnit;
        if (!(h > 0)) h = thPt / ptPerUnit;
        if (it.anchor === 'center') {
          x -= w / 2;
          y -= h / 2;
        }
      }
      if (![x, y, w, h].every(Number.isFinite)) return;
      const id = nid();
      shapes.set(String(it.id), { id, x, y, w, h });
      const [ux, uy] = U(x, y);
      let props;
      if (Array.isArray(it.rawProps)) {
        // 기존 도형: 원래 속성에 스펙이 가진 값만 덮어쓴다(없는 선·채우기를 기본값으로 만들지 않는다)
        const m = propMap(it.rawProps);
        if (it.fill !== undefined) {
          m.set(14, it.fill ? 1 : 0);
          if (it.fill) m.set(15, it.fill);
        }
        if (it.line !== undefined && hexColor(it.line, null)) m.set(19, hexColor(it.line, null));
        if (Number.isFinite(Number(it.weight))) m.set(22, Math.round(Number(it.weight) * PT));
        props = [].concat(...m.entries());
      } else {
        props = [14, st.fill ? 1 : 0, 15, st.fill || '#EEEEEE'];
        if (st.fill) props.push(16, 1);
        props.push(18, 1, 19, st.line, 22, Math.round(st.weight * PT));
        if (text) props.push(53, [LABEL_INSET, LABEL_INSET, LABEL_INSET, LABEL_INSET]);
        props.push(60, 0);
      }
      // 기존 그리기를 고칠 때는 원래 도형 종류(타원 등)를 그대로 쓴다
      const shapeType = Number.isInteger(it.shapeType) && it.shapeType !== 3 && !KIND_BY_TYPE[it.shapeType]
        ? it.shapeType
        : (st.round ? 7 : 6);
      cmds.push([3, id, shapeType, [round4(w * s / BASE), 0, 0, round4(h * s / BASE), Math.round(ux), Math.round(uy)], props, 'p']);
      const L = text.length; // UTF-16 길이 (구글 내부 인덱스와 같다)
      if (text) cmds.push([15, id, null, 0, text]);
      cmds.push([17, id, null, L, L + 1, [], [12, Number.isInteger(it.align) ? it.align : 2]]);
      if (text) {
        const charStyle = [6, st.size || 12];
        if (hexColor(it.color, null)) charStyle.push(4, hexColor(it.color, null));
        cmds.push([17, id, null, 0, L + 1, [], charStyle]);
      }
      autotext[J({ shapeId: id })] = {};
    }

    function sitePoint(shape, site) {
      const { x, y, w, h } = shape;
      if (site === 'top') return [x + w / 2, y];
      if (site === 'bottom') return [x + w / 2, y + h];
      if (site === 'left') return [x, y + h / 2];
      return [x + w, y + h / 2];
    }

    function autoSites(a, b) {
      const dx = (b.x + b.w / 2) - (a.x + a.w / 2);
      const dy = (b.y + b.h / 2) - (a.y + a.h / 2);
      if (Math.abs(dx) * a.h >= Math.abs(dy) * a.w) return dx > 0 ? ['right', 'left'] : ['left', 'right'];
      return dy > 0 ? ['bottom', 'top'] : ['top', 'bottom'];
    }

    // 끝이 도형에 붙어 있으면 연결점 위치를, 아니면 points 좌표를 쓴다(기존 그리기 고치기).
    function addLine(it, fromKey, toKey, endHead, startHead, base) {
      const a = fromKey != null ? shapes.get(String(fromKey)) : null;
      const b = toKey != null ? shapes.get(String(toKey)) : null;
      const pts = Array.isArray(it.points) && it.points.length === 2 ? it.points : null;
      if ((!a && !pts) || (!b && !pts)) return;
      const st = Object.assign({}, base, pickStyle(it));
      const kind = KIND[it.kind] ? it.kind : 'straight';
      const [fs0, ts0] = a && b ? autoSites(a, b) : [undefined, undefined];
      const fs = SITE[it.fromSite] !== undefined ? it.fromSite : fs0;
      const ts = SITE[it.toSite] !== undefined ? it.toSite : ts0;
      const [x1, y1] = a ? sitePoint(a, fs) : pts[0];
      const [x2, y2] = b ? sitePoint(b, ts) : pts[1];
      const dx = round4((x2 - x1) * s / BASE);
      let dy = round4((y2 - y1) * s / BASE);
      // 꺾인 선은 위·아래 연결점에서 출발하면 세로부터 꺾이도록 90도 돌린 행렬을 쓴다(견본과 동일).
      const verticalFirst = kind !== 'straight' &&
        (typeof it.rotated === 'boolean' ? it.rotated : (fs === 'top' || fs === 'bottom'));
      // 같은 높이의 윗변끼리 잇는 괄호 모양 선은 높이가 0이면 꺾임 위치(adjust 비율)가 사라진다
      if (kind === 'elbow2' && verticalFirst && Math.abs(dy) < 0.0002) dy = 0.0002;
      const [ux, uy] = U(x1, y1);
      const tf = (verticalFirst ? [0, dy, dx, 0] : [dx, 0, 0, dy]).concat([Math.round(ux), Math.round(uy)]);
      const adjust = Number.isFinite(Number(it.adjust)) ? Math.round(Number(it.adjust)) : 50000;
      const props = (kind === 'elbow2' ? [0, adjust] : []).concat([14, 0, 15, '#CFE2F3', 18, 1, 19, st.line,
        22, Math.round(st.weight * PT), 27, 1.3, 30, 1.3]);
      if (st.dash) props.push(43, st.dash);
      if (HEAD[startHead]) props.push(26, HEAD[startHead]);
      if (HEAD[endHead]) props.push(29, HEAD[endHead]);
      props.push(51, a ? [a.id, SITE[fs]] : ['', 0], 52, b ? [b.id, SITE[ts]] : ['', 0]);
      cmds.push([3, nid(), KIND[kind], tf, props, 'p']);
    }

    function headOf(value, fallback) {
      return HEAD[value] !== undefined ? value : fallback;
    }

    for (const it of items) {
      if (!it || !it.id) continue;
      if (mode === 'annotate' && it.type === 'box') addShape(it, STYLE.box);
      else if (mode === 'annotate' && it.type === 'label') addShape(it, STYLE.label);
      else if (mode === 'diagram' && (it.type === 'node' || it.type === 'label')) addShape(it, STYLE.node);
      else if (mode === 'diagram' && it.type === 'image') addImage(it);
    }
    const lineBase = mode === 'annotate' ? STYLE.annotateLine : STYLE.diagramLine;
    for (const it of items) {
      if (!it) continue;
      if (it.type === 'label' && it.to && mode === 'annotate') {
        addLine(it.connector || {}, it.id, it.to, headOf(it.head, 'dot'), 'none', lineBase);
      } else if (it.type === 'arrow') {
        addLine(it, it.from, it.to, headOf(it.head, 'arrow'), headOf(it.startHead, 'none'), lineBase);
      }
    }

    const wrap = { dct: 'sketchy', ds: false, cses: false, sm: 'other' };
    const data = {
      resolved: cmds,
      autotext_content: autotext,
      did_remove_empty_picture_placeholders: false,
      copy_source_supports_inheritance_via_master: false
    };
    const custom = {
      [MIME_DRAWING]: J(Object.assign({}, wrap, { data: J(data) })),
      [MIME_CLIP_ID]: uuid()
    };
    if (blobRefs.length || Object.keys(embedded).length) {
      imageClip = imageClip || { image_urls: {}, placeholder_ids: {}, cosmo_ids: {} };
      for (const blob of blobRefs) {
        imageClip.image_urls[blob] = null;
        imageClip.cosmo_ids[blob] = 1;
      }
      Object.assign(imageClip.image_urls, embedded);
    }
    if (imageClip) custom[MIME_IMAGE] = J(Object.assign({}, wrap, { data: J(imageClip) }));
    const text = items.map(it => cleanText(it && it.text)).filter(Boolean).join('\n');
    return { custom, text, commandCount: cmds.length };
  }

  // 위치가 하나도 없으면 자동 배치, 일부만 없으면(기존 그리기에 AI가 노드를 추가한 경우) 기존 도형 아래에 한 줄로 놓는다.
  function positionDiagramItems(spec) {
    const items = spec.items || [];
    const nodes = items.filter(it => it && it.type === 'node');
    const placed = items.filter(it => it && (it.type === 'node' || it.type === 'image') && Array.isArray(it.rect));
    if (nodes.every(n => Array.isArray(n.rect))) return items;
    if (!placed.length) return layoutDiagram(spec);
    let x = Math.min(...placed.map(n => Number(n.rect[0]) || 0));
    const y = Math.max(...placed.map(n => (Number(n.rect[1]) || 0) + (Number(n.rect[3]) || 0))) + 40;
    return items.map(it => {
      if (!it || it.type !== 'node' || Array.isArray(it.rect)) return it;
      const st = Object.assign({}, STYLE.node, pickStyle(it));
      const w = Math.max(80, textWidthPt(cleanText(it.text), st.size) + 28);
      const rect = [x, y, w, Math.max(30, st.size * 1.35 + 14)];
      x += w + 24;
      return Object.assign({}, it, { rect });
    });
  }

  // 선택한 이미지를 강조할지, 이미지 속 도해를 도형으로 다시 그릴지 지시문으로 가른다.
  const REDRAW_RE = /(다시|새로|똑같이|그대로|따라|옮겨|베껴)\s*(그려|그리|구성|만들)|재구성|재현|그리기\s*(로|형식|모드|도형|에서\s*편집)|도형으로|편집\s*(가능|할\s*수|되게)|벡터|redraw|recreate|rebuild|vectori[sz]e/i;
  function isRedrawInstruction(text) {
    return REDRAW_RE.test(String(text || ''));
  }

  // 레티나 캡처는 픽셀이 두 배라 절반 폭이 실제 크기에 가깝다. 본문 폭(6.5in = 468pt)을 넘지 않게.
  function defaultImageWidthPt(pixelWidth) {
    const w = pixelWidth >= 900 ? pixelWidth / 2 : pixelWidth * 0.75;
    return Math.min(468, Math.max(120, w));
  }

  // copy 이벤트를 일으켜 커스텀 MIME을 직접 넣는다. 사용자 클릭 직후에 호출해야 한다.
  function writeDrawingClipboard(payload, doc) {
    const d = doc || globalThis.document;
    const win = d.defaultView || globalThis;
    let wrote = false;
    const onCopy = ev => {
      if (!ev.clipboardData) return;
      ev.preventDefault();
      ev.stopImmediatePropagation();
      for (const type of Object.keys(payload.custom)) ev.clipboardData.setData(type, payload.custom[type]);
      ev.clipboardData.setData('text/plain', payload.text || '');
      wrote = true;
    };
    win.addEventListener('copy', onCopy, true);
    try {
      d.execCommand('copy');
    } finally {
      win.removeEventListener('copy', onCopy, true);
    }
    return wrote;
  }

  // ---------- 독스에서 복사한 데이터 해석 ----------

  function readCopyEventData(clipboardData) {
    const out = {};
    if (!clipboardData) return out;
    for (const type of CAPTURE_TYPES) {
      try {
        const v = clipboardData.getData(type);
        if (v) out[type] = v;
      } catch (_) { /* 읽을 수 없는 형식은 건너뛴다 */ }
    }
    return out;
  }

  function parseWrapped(value) {
    try {
      const outer = JSON.parse(value);
      return outer && typeof outer.data === 'string' ? JSON.parse(outer.data) : null;
    } catch (_) {
      return null;
    }
  }

  // 복사 데이터에서 이미지 주소와 그리기 명령을 뽑는다.
  function summarizeDocsCopy(data) {
    const result = { imageUrls: [], drawingRenderUrls: [], drawingCommands: null, text: String(data['text/plain'] || '') };
    const html = String(data['text/html'] || '');
    const re = /<img\b[^>]*\bsrc\s*=\s*("([^"]*)"|'([^']*)')/gi;
    let m;
    while ((m = re.exec(html))) {
      const src = decodeHtmlAttr(m[2] || m[3] || '');
      // 본문의 그리기는 도형 정보 없이 렌더링 주소(/drawings/.../image)만 온다. 사진으로 취급하지 않는다.
      if (/^https:\/\/docs\.google\.com\/drawings\//i.test(src)) result.drawingRenderUrls.push(src);
      else if (/^(https?:|data:image\/)/i.test(src)) result.imageUrls.push(src);
    }
    const imageClip = data[MIME_IMAGE] ? parseWrapped(data[MIME_IMAGE]) : null;
    if (imageClip && imageClip.image_urls) {
      for (const url of Object.values(imageClip.image_urls)) {
        if (typeof url === 'string' && /^(https?:|data:image\/)/i.test(url) && !result.imageUrls.includes(url)) result.imageUrls.push(url);
      }
    }
    const drawing = data[MIME_DRAWING] ? parseWrapped(data[MIME_DRAWING]) : null;
    if (drawing && Array.isArray(drawing.resolved)) result.drawingCommands = drawing.resolved;
    return result;
  }

  // 독스 본문의 그리기는 복사 데이터에 렌더링 주소만 온다. 주소에서 그리기 ID를 뽑아
  // 편집 창 페이지(embeddednewedit)를 받으면 그 HTML 안에 클립보드와 같은 형식의 명령 목록이 들어 있다.
  function drawingIdFromRenderUrl(url) {
    const m = /\/drawings\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{20,})\//.exec(String(url || ''));
    return m ? m[1] : '';
  }

  function drawingEditorUrl(drawingId, docId) {
    return 'https://docs.google.com/drawings/u/0/d/' + encodeURIComponent(drawingId) +
      '/embeddednewedit?parent=' + encodeURIComponent(docId);
  }

  function drawingRenderPngUrl(drawingId, docId, width, height) {
    return 'https://docs.google.com/drawings/u/0/d/' + encodeURIComponent(drawingId) +
      '/image?w=' + Math.round(width) + '&h=' + Math.round(height) + '&fmt=png&parent=' + encodeURIComponent(docId);
  }

  // 편집 창 HTML에서 [3,"…"], [15,"…"], [17,"…"]을 담은 배열을 찾아 명령만 모은다.
  // 명령 목록에는 페이지 설정 같은 다른 명령도 섞여 있지만 drawingCommandsToSpec이 3/15/17만 쓴다.
  function extractEditorCommands(html) {
    const t = String(html || '');
    const starts = new Set();
    const re = /\[(?:3|15|17),"/g;
    let m;
    while ((m = re.exec(t))) {
      let depth = 0;
      for (let q = m.index - 1; q >= 0; q--) {
        const ch = t[q];
        if (ch === ']') depth++;
        else if (ch === '[') {
          if (depth === 0) {
            starts.add(q);
            break;
          }
          depth--;
        }
      }
    }
    const cmds = [];
    const seen = new Set();
    for (const s of starts) {
      const e = matchingBracket(t, s);
      if (e < 0) continue;
      let list;
      try {
        list = JSON.parse(t.slice(s, e + 1));
      } catch (_) {
        continue;
      }
      for (const c of list) {
        if (!Array.isArray(c) || typeof c[0] !== 'number' || typeof c[1] !== 'string') continue;
        const key = J(c);
        if (seen.has(key)) continue;
        seen.add(key);
        cmds.push(c);
      }
    }
    return cmds;
  }

  // 편집 창 HTML의 SK_config['documentImageUrls']: 이미지 blob id → 실제 이미지 주소(같은 출처라 쿠키로 받는다).
  // blob id만 다시 보내면 다른 문서는 물론 같은 문서에서도 이미지가 깨지므로, 이 주소로 픽셀을 받아 직접 넣는다.
  function extractEditorImageUrls(html) {
    const m = /SK_config\['documentImageUrls'\]\s*=\s*(\{[^;]*\})\s*;/.exec(String(html || ''));
    if (!m) return {};
    try {
      const map = JSON.parse(m[1]);
      const out = {};
      for (const [blob, url] of Object.entries(map || {})) {
        if (typeof url === 'string' && /^https:\/\/docs\.google\.com\//.test(url)) out[blob] = url;
      }
      return out;
    } catch (_) {
      return {};
    }
  }

  function matchingBracket(t, start) {
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let k = start; k < t.length; k++) {
      const ch = t[k];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '[') depth++;
      else if (ch === ']') {
        depth--;
        if (depth === 0) return k;
      }
    }
    return -1;
  }

  // 그리기 명령을 diagram 스펙(pt 좌표, rect 고정)으로 되돌린다. AI가 이걸 고쳐 다시 만든다.
  // 선은 양 끝 좌표(points)를 함께 남겨 도형에 붙지 않은 끝도 그대로 다시 그린다.
  // 이미지는 원래 blob id와 속성을 그대로 들고 있다가 같은 문서에 붙일 때 다시 연결한다.
  // bounds는 전체 내용의 범위(pt). 독스가 그리기를 이 범위로 잘라 보여 주므로 렌더링 이미지와 좌표를 맞출 때 쓴다.
  function drawingCommandsToSpec(cmds) {
    const shapes = [];
    const lines = [];
    const images = [];
    const texts = new Map();
    const sizes = new Map();
    let droppedCount = 0;
    const siteName = ['top', 'left', 'bottom', 'right'];
    const headName = v => (v === 3 ? 'dot' : v ? 'arrow' : 'none');
    for (const c of cmds || []) {
      if (!Array.isArray(c)) continue;
      if (c[0] === 15 && typeof c[4] === 'string') {
        texts.set(c[1], (texts.get(c[1]) || '') + c[4]);
      } else if (c[0] === 17 && Array.isArray(c[6])) {
        // 글자 스타일: 6 크기, 4 글자색 / 문단 스타일: 12 정렬. 여러 구간이면 앞 구간 값을 쓴다
        const st = sizes.get(c[1]) || {};
        const style = propMap(c[6]);
        for (const [key, name] of [[6, 'size'], [4, 'color'], [12, 'align']]) {
          if (style.has(key) && st[name] === undefined) st[name] = style.get(key);
        }
        sizes.set(c[1], st);
      } else if (c[0] === 3 && Array.isArray(c[3])) {
        if (c[2] === 3) images.push(c);
        else if (KIND_BY_TYPE[c[2]]) lines.push(c);
        else shapes.push(c);
      }
    }
    const items = [];
    const ids = new Set();
    for (const c of images) {
      const [a, b, cc, d, tx, ty] = c[3];
      const props = propMap(c[4]);
      const pw = Number(props.get(8));
      const ph = Number(props.get(9));
      // 회전·뒤집힌 이미지는 rect만으로 다시 놓을 수 없다
      if (!props.get(49) || !(pw > 0 && ph > 0) || b !== 0 || cc !== 0 || a <= 0 || d <= 0) {
        droppedCount++;
        continue;
      }
      items.push({
        id: c[1],
        type: 'image',
        rect: [tx / PT, ty / PT, pw * a / PT, ph * d / PT],
        blob: props.get(49),
        rawProps: c[4]
      });
      ids.add(c[1]);
    }
    for (const c of shapes) {
      const [a, , , d, tx, ty] = c[3];
      const props = propMap(c[4]);
      const w = Math.abs(a) * BASE / PT;
      const h = Math.abs(d) * BASE / PT;
      const x = (a < 0 ? tx + a * BASE : tx) / PT;
      const y = (d < 0 ? ty + d * BASE : ty) / PT;
      // rawProps는 원래 속성 전체. 다시 만들 때 채우기·선 등 스펙 값만 덮어써서 글상자(108) 같은 도형을 그대로 살린다
      const node = { id: c[1], type: 'node', text: cleanText(texts.get(c[1]) || ''), rect: [x, y, w, h], shapeType: c[2], rawProps: c[4] };
      const filled = props.has(14) ? props.get(14) !== 0 : props.has(15);
      node.fill = filled ? (props.get(15) || null) : null;
      if (props.has(19)) node.line = props.get(19);
      if (props.has(22)) node.weight = props.get(22) / PT;
      const st = sizes.get(c[1]) || {};
      if (typeof st.size === 'number') node.size = st.size;
      if (typeof st.color === 'string' && st.color) node.color = st.color;
      if (typeof st.align === 'number') node.align = st.align;
      items.push(node);
      ids.add(c[1]);
    }
    for (const c of lines) {
      const props = propMap(c[4]);
      const start = props.get(51);
      const end = props.get(52);
      const [a, b, cc, d, tx, ty] = c[3];
      // 단위 도형 (0,0)→(1,1)을 행렬로 옮긴 두 끝점
      const points = [[tx / PT, ty / PT], [(tx + (a + cc) * BASE) / PT, (ty + (b + d) * BASE) / PT]];
      const arrow = {
        type: 'arrow',
        kind: KIND_BY_TYPE[c[2]],
        points,
        rotated: a === 0 && d === 0 && (b !== 0 || cc !== 0),
        head: headName(props.get(29)),
        startHead: headName(props.get(26))
      };
      if (Array.isArray(start) && ids.has(start[0])) {
        arrow.from = start[0];
        arrow.fromSite = siteName[start[1]];
      }
      if (Array.isArray(end) && ids.has(end[0])) {
        arrow.to = end[0];
        arrow.toSite = siteName[end[1]];
      }
      if (arrow.from && arrow.from === arrow.to) continue; // 길이 0인 자기 연결선
      if (props.has(0)) arrow.adjust = props.get(0);
      if (props.has(19)) arrow.line = props.get(19);
      if (props.has(22)) arrow.weight = props.get(22) / PT;
      if (props.has(43)) arrow.dash = props.get(43);
      items.push(arrow);
    }
    // 전체 내용의 왼쪽 위가 (0,0)에 오도록 옮긴다
    const xs = [];
    const ys = [];
    for (const it of items) {
      if (it.rect) {
        xs.push(it.rect[0], it.rect[0] + it.rect[2]);
        ys.push(it.rect[1], it.rect[1] + it.rect[3]);
      }
      if (it.points) for (const [x, y] of it.points) {
        xs.push(x);
        ys.push(y);
      }
    }
    const minX = xs.length ? Math.min(...xs) : 0;
    const minY = ys.length ? Math.min(...ys) : 0;
    const r1 = v => Math.round(v * 100) / 100;
    for (const it of items) {
      if (it.rect) it.rect = [it.rect[0] - minX, it.rect[1] - minY, it.rect[2], it.rect[3]].map(r1);
      if (it.points) it.points = it.points.map(([x, y]) => [r1(x - minX), r1(y - minY)]);
    }
    const bounds = {
      width: xs.length ? r1(Math.max(...xs) - minX) : 0,
      height: ys.length ? r1(Math.max(...ys) - minY) : 0
    };
    return { mode: 'diagram', items, bounds, droppedCount };
  }

  // 속성 배열 [키, 값, 키, 값...]을 Map으로. 연결선 앞의 [0, 조정값] 같은 머리 값도 그대로 짝지어진다.
  function propMap(props) {
    const m = new Map();
    if (!Array.isArray(props)) return m;
    for (let i = 0; i + 1 < props.length; i += 2) m.set(props[i], props[i + 1]);
    return m;
  }

  function decodeHtmlAttr(value) {
    return String(value)
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>');
  }

  globalThis.ToytypeDrawingClip = {
    buildDrawingPayload,
    writeDrawingClipboard,
    readCopyEventData,
    summarizeDocsCopy,
    drawingCommandsToSpec,
    drawingIdFromRenderUrl,
    drawingEditorUrl,
    drawingRenderPngUrl,
    extractEditorCommands,
    extractEditorImageUrls,
    isRedrawInstruction,
    NODE_FILLS,
    _test: {
      layoutDiagram,
      defaultImageWidthPt,
      textWidthPt,
      cleanText,
      MIME_DRAWING,
      MIME_IMAGE
    }
  };
})();
