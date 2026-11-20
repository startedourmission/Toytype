import assert from 'node:assert/strict';
import test from 'node:test';

await import('../content/drawing-clip.js');
const clip = globalThis.ToytypeDrawingClip;
const { MIME_DRAWING, MIME_IMAGE } = clip._test;

function commandsOf(payload) {
  const outer = JSON.parse(payload.custom[MIME_DRAWING]);
  return JSON.parse(outer.data).resolved;
}

test('annotate payload embeds the image and keeps pixel coordinates aligned', () => {
  const payload = clip.buildDrawingPayload({
    mode: 'annotate',
    widthPt: 400,
    items: [
      { id: 'b1', type: 'box', rect: [372, 124, 176, 70] },
      { id: 'l1', type: 'label', text: '여기를 눌러 파일을 첨부하세요', rect: [180, 230, null, null], to: 'b1' }
    ]
  }, { dataUrl: 'data:image/png;base64,AAAA', width: 600, height: 300 });

  const cmds = commandsOf(payload);
  const [image, box] = cmds;
  assert.equal(image[0], 3);
  assert.equal(image[2], 3);
  const s = 400 * 508 / 600;
  assert.equal(image[3][0], Math.round(s * 10000) / 10000);
  const props = image[4];
  const blob = props[props.indexOf(49) + 1];
  assert.match(blob, /^s-blob-v1-IMAGE-[A-Za-z0-9_-]{11}$/);
  assert.equal(props[props.indexOf(8) + 1], 600);

  // 박스 왼쪽 위 = 이미지 원점 + 픽셀 × 배율
  assert.equal(box[2], 7);
  assert.equal(box[3][4], Math.round(20 * 508 + 372 * s));
  assert.equal(box[3][5], Math.round(20 * 508 + 124 * s));
  assert.deepEqual(box[4], [14, 0, 15, '#EEEEEE', 18, 1, 19, '#FF0000', 22, 1143, 60, 0]);

  const imageClip = JSON.parse(JSON.parse(payload.custom[MIME_IMAGE]).data);
  assert.equal(imageClip.image_urls[blob], 'data:image/png;base64,AAAA');

  const text = cmds.find(c => c[0] === 15);
  assert.equal(text[4], '여기를 눌러 파일을 첨부하세요');
  const connector = cmds.find(c => c[0] === 3 && c[2] === 153);
  const cprops = connector[4];
  assert.equal(cprops[cprops.indexOf(29) + 1], 3); // 끝은 동그란 점
  assert.deepEqual(cprops.slice(-4), [51, [text[1], 0], 52, [box[1], 2]]);
});

test('label text never contains a newline because Docs rejects it on sync', () => {
  const payload = clip.buildDrawingPayload({
    mode: 'annotate',
    items: [{ id: 'l', type: 'label', text: '여기를 눌러\n첨부하세요', rect: [0, 0, null, null] }]
  });
  const text = commandsOf(payload).find(c => c[0] === 15);
  assert.equal(text[4], '여기를 눌러 첨부하세요');
});

test('diagram layout stacks a tree top-down with elbow connectors', () => {
  const items = clip._test.layoutDiagram({
    direction: 'TB',
    items: [
      { id: 'root', type: 'node', text: '자료구조' },
      { id: 'a', type: 'node', text: '선형' },
      { id: 'b', type: 'node', text: '비선형' },
      { type: 'arrow', from: 'root', to: 'a' },
      { type: 'arrow', from: 'root', to: 'b' }
    ]
  });
  const rect = id => items.find(it => it.id === id).rect;
  assert.ok(rect('a')[1] > rect('root')[1] + rect('root')[3]);
  assert.equal(rect('a')[1], rect('b')[1]);
  assert.ok(rect('a')[0] + rect('a')[2] <= rect('b')[0]);
  const arrows = items.filter(it => it.type === 'arrow');
  assert.ok(arrows.every(a => a.fromSite === 'bottom' && a.toSite === 'top' && a.kind === 'elbow2'));
});

test('diagram payload rotates vertical-first elbows like the captured sample', () => {
  const payload = clip.buildDrawingPayload({
    mode: 'diagram',
    items: [
      { id: 'root', type: 'node', text: '자료구조' },
      { id: 'a', type: 'node', text: '선형' },
      { id: 'b', type: 'node', text: '비선형', fill: '#d9ead3' },
      { type: 'arrow', from: 'root', to: 'a' },
      { type: 'arrow', from: 'root', to: 'b' }
    ]
  });
  const cmds = commandsOf(payload);
  const elbows = cmds.filter(c => c[0] === 3 && c[2] === 146);
  assert.equal(elbows.length, 2);
  for (const e of elbows) {
    assert.equal(e[3][0], 0);
    assert.equal(e[3][3], 0);
    assert.ok(e[3][1] > 0);
  }
  const fills = cmds.filter(c => c[0] === 3 && c[2] === 7).map(c => c[4][c[4].indexOf(15) + 1]);
  assert.deepEqual(fills, ['#CFE2F3', '#CFE2F3', '#D9EAD3']);
  assert.equal(JSON.parse(payload.custom[MIME_DRAWING]).dih, undefined);
});

test('summarizeDocsCopy finds image sources and drawing commands', () => {
  const data = {
    'text/html': '<b><img src="https://lh7-rt.googleusercontent.com/docsz/abc?key=x&amp;y=1" width="300"></b>',
    'text/plain': '첨부 버튼 강조',
    [MIME_DRAWING]: JSON.stringify({ data: JSON.stringify({ resolved: [[3, 'g1', 7, [1, 0, 0, 1, 0, 0], [], 'p']] }) })
  };
  const summary = clip.summarizeDocsCopy(data);
  assert.deepEqual(summary.imageUrls, ['https://lh7-rt.googleusercontent.com/docsz/abc?key=x&y=1']);
  assert.equal(summary.drawingCommands.length, 1);
  assert.equal(summary.text, '첨부 버튼 강조');
});

test('a copied drawing round-trips through the spec, keeping free endpoints and elbow adjust', () => {
  // 편집자 견본(자료구조 그리기)에서 뽑은 명령 일부
  const cmds = [
    [3, 'g_2', 7, [1.3738, 0, 0, 0.2114, 172753, 111534], [15, '#CFE2F3', 19, '#000000', 22, 381], 'p'],
    [15, 'g_2', null, 0, '자료구조'],
    [3, 'g_7', 7, [0.9729, 0, 0, 0.2114, 116437, 153556], [15, '#CFE2F3', 19, '#000000', 22, 381], 'p'],
    [3, 'g_8', 7, [0.9729, 0, 0, 0.2114, 282232, 153556], [15, '#CFE2F3', 19, '#000000', 22, 381], 'p'],
    [3, 'g_10', 146, [0, 0.0002, 1.3816, 0, 174811, 153556], [0, -39687500, 14, 0, 19, '#000000', 22, 381, 51, ['g_7', 0], 52, ['g_8', 0]], 'p'],
    [3, 'g_12', 153, [-0.0033, 0, 0, -0.0594, 255577, 144030], [14, 0, 19, '#000000', 22, 381, 51, ['', 0], 52, ['g_2', 2]], 'p']
  ];
  const spec = clip.drawingCommandsToSpec(cmds);
  assert.equal(spec.items.filter(it => it.type === 'node').length, 3);
  const bracket = spec.items.find(it => it.kind === 'elbow2');
  assert.equal(bracket.adjust, -39687500);
  assert.equal(bracket.rotated, true);
  const free = spec.items.find(it => it.kind === 'straight');
  assert.equal(free.from, undefined);
  assert.equal(free.to, 'g_2');

  const out = commandsOf(clip.buildDrawingPayload(spec));
  const outBracket = out.find(c => c[0] === 3 && c[2] === 146);
  assert.deepEqual(outBracket[3].slice(0, 4), [0, 0.0002, 1.3816, 0]);
  assert.deepEqual(outBracket[4].slice(0, 2), [0, -39687500]);
  const outFree = out.find(c => c[0] === 3 && c[2] === 153);
  assert.deepEqual(outFree[4].slice(-4, -2), [51, ['', 0]]);
  assert.ok(Math.abs(outFree[3][3] - -0.0594) < 0.001);
});

test('editor page HTML yields drawing commands and images keep their blob for same-doc paste', () => {
  // embeddednewedit 페이지는 명령 목록을 다른 설정 명령과 섞어 스크립트 안에 넣어 둔다
  const html = '<script>x.y(null,[[1,"p",{}],[3,"h_0",3,[261.9,0.0,0.0,261.9,24056.0,6096.0],[18,1,8,538,9,1350,22,381,49,"s-blob-v1-IMAGE-i45eGb3tNUo",15,"#CFE2F3",19,"#000000"],"p"],' +
    '[3,"h_1",6,[0.5,0,0,0.2,30000,20000],[14,0,19,"#FF0000",22,1143],"p"],[45,"z"]],"a]b");</script>';
  const cmds = clip.extractEditorCommands(html);
  assert.deepEqual(cmds.filter(c => c[0] === 3).map(c => c[1]), ['h_0', 'h_1']);

  const spec = clip.drawingCommandsToSpec(cmds);
  const image = spec.items.find(it => it.type === 'image');
  assert.equal(image.blob, 's-blob-v1-IMAGE-i45eGb3tNUo');
  assert.ok(spec.bounds.width > 0 && spec.bounds.height > 0);

  const payload = clip.buildDrawingPayload(spec);
  const out = commandsOf(payload);
  const img = out.find(c => c[0] === 3 && c[2] === 3);
  assert.equal(img[4][img[4].indexOf(49) + 1], 's-blob-v1-IMAGE-i45eGb3tNUo');
  assert.ok(Math.abs(img[3][0] - 261.9) < 0.01);
  const imageClip = JSON.parse(JSON.parse(payload.custom[MIME_IMAGE]).data);
  assert.deepEqual(imageClip.cosmo_ids, { 's-blob-v1-IMAGE-i45eGb3tNUo': 1 });
  assert.equal(imageClip.image_urls['s-blob-v1-IMAGE-i45eGb3tNUo'], null);

  assert.equal(clip.drawingIdFromRenderUrl('https://docs.google.com/drawings/u/0/d/17qwdTtHlEHhgv8Lpt4dEUThA2kq/image?w=1'), '17qwdTtHlEHhgv8Lpt4dEUThA2kq');
});

test('drawing images fetched from the editor URL map are embedded as data, not blob references', () => {
  const html = "<script>SK_config['documentImageUrls'] = {\"s-blob-v1-IMAGE-i45eGb3tNUo\":\"https://docs.google.com/u/0/drawings-images-rt/abc\\u003ds2048\"};</script>";
  assert.deepEqual(clip.extractEditorImageUrls(html), { 's-blob-v1-IMAGE-i45eGb3tNUo': 'https://docs.google.com/u/0/drawings-images-rt/abc=s2048' });

  const spec = clip.drawingCommandsToSpec([
    [3, 'h_0', 3, [261.9, 0, 0, 261.9, 24056, 6096], [18, 1, 8, 538, 9, 1350, 22, 381, 49, 's-blob-v1-IMAGE-i45eGb3tNUo'], 'p']
  ]);
  // 확장이 이미지 주소에서 받은 픽셀(긴 변이 줄어든 경우)
  Object.assign(spec.items[0], { dataUrl: 'data:image/png;base64,AAAA', pixelWidth: 269, pixelHeight: 675 });
  const payload = clip.buildDrawingPayload(spec);
  const img = commandsOf(payload).find(c => c[0] === 3 && c[2] === 3);
  const props = img[4];
  const blob = props[props.indexOf(49) + 1];
  assert.notEqual(blob, 's-blob-v1-IMAGE-i45eGb3tNUo');
  assert.equal(props[props.indexOf(8) + 1], 269);
  // 표시 크기는 그대로: 269px × 배율 = 538px × 261.9
  assert.ok(Math.abs(269 * img[3][0] - 538 * 261.9) < 10);
  const imageClip = JSON.parse(JSON.parse(payload.custom[MIME_IMAGE]).data);
  assert.equal(imageClip.image_urls[blob], 'data:image/png;base64,AAAA');
  assert.deepEqual(imageClip.cosmo_ids, {});
});

test('redraw instructions are told apart from screenshot annotation', () => {
  for (const t of ['이 도해를 그리기로 다시 그려줘', '그림을 편집 가능하게 도형으로 바꿔 줘', '똑같이 그려줘', '재구성해줘']) {
    assert.equal(clip.isRedrawInstruction(t), true, t);
  }
  for (const t of ['첨부 버튼에 빨간 박스 쳐 줘', '여기를 눌러 파일을 첨부하세요', '메뉴 위치를 강조해줘']) {
    assert.equal(clip.isRedrawInstruction(t), false, t);
  }
});

test('a redrawn text item becomes a borderless text box with its measured color', () => {
  const out = commandsOf(clip.buildDrawingPayload({
    mode: 'diagram',
    items: [
      { id: 'n1', type: 'node', text: '캐시', rect: [0, 0, 100, 40], shapeType: 7, fill: '#434343', line: '#434343', weight: 1, color: '#FFFFFF' },
      { id: 't1', type: 'node', text: '조회 실패 시', rect: [120, 10, 60, 16], shapeType: 108, size: 10, color: '#686868', rawProps: [44, 0, 165, 0, 166, 1] }
    ]
  }));
  const box = out.find(c => c[0] === 3 && c[2] === 108);
  assert.deepEqual(box[4], [44, 0, 165, 0, 166, 1]);
  const style = out.filter(c => c[0] === 17 && c[1] === box[1]).map(c => c[6]);
  assert.ok(style.some(s => s[0] === 6 && s[1] === 10 && s[3] === '#686868'));
  const node = out.find(c => c[0] === 3 && c[2] === 7);
  assert.equal(node[4][node[4].indexOf(15) + 1], '#434343');
});

test('tree of ellipse nodes attaches edges like the chapter 7 drawings (parent lower corner → child top)', () => {
  const D = 32.8;
  const node = (id, text, cx, cy) => ({ id, type: 'node', text, rect: [cx - D / 2, cy - D / 2, D, D], shapeType: 8, fill: '#FFFFFF', line: '#000000', weight: 0.53, size: 10 });
  const cmds = commandsOf(clip.buildDrawingPayload({
    mode: 'diagram',
    items: [
      node('r', '7', 100, 20), node('a', '5', 50, 70), node('b', '13', 150, 70), node('c', '12', 220, 100), node('d', '1', 100, 70),
      { type: 'arrow', from: 'r', to: 'a', head: 'small' },
      { type: 'arrow', from: 'r', to: 'b', head: 'small' },
      { type: 'arrow', from: 'b', to: 'c', head: 'none' },
      { type: 'arrow', from: 'r', to: 'd', head: 'none' }
    ]
  }));
  const shapes = cmds.filter(c => c[0] === 3 && c[2] === 8);
  assert.equal(shapes.length, 5);
  const idOf = text => cmds.find(c => c[0] === 15 && c[4] === text)[1];
  const lines = cmds.filter(c => c[0] === 3 && c[2] === 153);
  const ends = l => { const p = l[4]; return [p[p.indexOf(51) + 1], p[p.indexOf(52) + 1], p.includes(29) ? p[p.indexOf(29) + 1] : 0]; };
  assert.deepEqual(ends(lines[0]), [[idOf('7'), 3], [idOf('5'), 0], 5]); // 왼쪽 아래 → 위, 작은 화살촉
  assert.deepEqual(ends(lines[1]), [[idOf('7'), 5], [idOf('13'), 0], 5]); // 오른쪽 아래 → 위
  assert.deepEqual(ends(lines[2]), [[idOf('13'), 5], [idOf('12'), 1], 0]); // 비스듬히 내려가면 자식 왼쪽 위
  assert.deepEqual(ends(lines[3]), [[idOf('7'), 4], [idOf('1'), 0], 0]); // 바로 아래 자식은 아래 → 위

  // 선의 시작점이 원 둘레의 왼쪽 아래(225도)에 있다
  const [, , , , tx, ty] = lines[0][3];
  const r = D / 2;
  assert.ok(Math.abs(tx / 508 - (20 + 100 - r * Math.SQRT1_2)) < 0.01);
  assert.ok(Math.abs(ty / 508 - (20 + 20 + r * Math.SQRT1_2)) < 0.01);
});

test('reading a drawing names ellipse connection sites and the small arrowhead', () => {
  const spec = clip.drawingCommandsToSpec([
    [3, 'p', 8, [0.1389, 0, 0, 0.1389, 91711, 57084], [14, 1, 22, 268, 15, '#FFFFFF', 19, '#000000'], 'p'],
    [3, 'c', 8, [0.1389, 0, 0, 0.1389, 57301, 84533], [14, 1, 22, 268, 15, '#FFFFFF', 19, '#000000'], 'p'],
    [3, 'e', 153, [-0.2376, 0, 0, 0.1102, 94152, 71311], [14, 0, 22, 268, 51, ['p', 3], 52, ['c', 0], 19, '#000000', 29, 5], 'p']
  ]);
  const edge = spec.items.find(it => it.type === 'arrow');
  assert.equal(edge.fromSite, 'bottomLeft');
  assert.equal(edge.toSite, 'top');
  assert.equal(edge.head, 'small');
  const out = commandsOf(clip.buildDrawingPayload(spec)).find(c => c[0] === 3 && c[2] === 153)[4];
  assert.equal(out[out.indexOf(29) + 1], 5);
  assert.deepEqual(out[out.indexOf(51) + 1][1], 3);
});

test('text diagram draws tree nodes as house-style circles and leans a lone child to its side', () => {
  const items = clip._test.layoutDiagram({
    mode: 'diagram',
    direction: 'TB',
    items: [
      { id: 'n50', type: 'node', shape: 'ellipse', text: '50' },
      { id: 'n30', type: 'node', shape: 'ellipse', text: '30' },
      { id: 'n70', type: 'node', shape: 'ellipse', text: '70' },
      { id: 'n60', type: 'node', shape: 'ellipse', text: '60' },
      { type: 'arrow', from: 'n50', to: 'n70', head: 'arrow', side: 'right' },
      { type: 'arrow', from: 'n50', to: 'n30', head: 'arrow', side: 'left' },
      { type: 'arrow', from: 'n70', to: 'n60', head: 'arrow', side: 'left' }
    ]
  });
  const node = id => items.find(it => it.id === id);
  const cx = id => node(id).rect[0] + node(id).rect[2] / 2;
  for (const id of ['n50', 'n30', 'n70', 'n60']) {
    assert.equal(node(id).shapeType, 8);
    assert.equal(node(id).rect[2], 32.8);
    assert.equal(node(id).rect[3], 32.8);
    assert.equal(node(id).fill, '#FFFFFF');
    assert.equal(node(id).weight, 0.53);
  }
  // 왼쪽 자식이 먼저, 외자식 60은 70의 왼쪽 아래
  assert.ok(cx('n30') < cx('n50') && cx('n50') < cx('n70'));
  assert.ok(cx('n60') < cx('n70'));
  const edges = items.filter(it => it.type === 'arrow');
  for (const e of edges) {
    assert.equal(e.kind, 'straight');
    assert.equal(e.head, 'small');
    assert.equal(e.side, undefined);
    assert.equal(e.fromSite, undefined);
  }
  const cmds = commandsOf(clip.buildDrawingPayload({ mode: 'diagram', direction: 'TB', items: [
    { id: 'a', type: 'node', shape: 'ellipse', text: '1' },
    { id: 'b', type: 'node', shape: 'ellipse', text: '2' },
    { type: 'arrow', from: 'a', to: 'b', head: 'arrow', side: 'left' }
  ] }));
  assert.equal(cmds.filter(c => c[0] === 3 && c[2] === 8).length, 2);
  const line = cmds.find(c => c[0] === 3 && c[2] === 153)[4];
  assert.equal(line[line.indexOf(29) + 1], 5);
  assert.equal(line[line.indexOf(51) + 1][1], 3); // 왼쪽 아래 연결점
});

test('speech bubble keeps its callout shape type and points its tail at the target', () => {
  const cmds = commandsOf(clip.buildDrawingPayload({
    mode: 'diagram',
    items: [
      { id: 'n50', type: 'node', text: '50', shapeType: 8, rect: [100, 100, 32.8, 32.8] },
      { id: 'b1', type: 'node', text: '루트 노드', shapeType: 107, fill: '#FFFFFF', line: '#000000', weight: 0.75, rect: [180, 40, 80, 30], tailTo: 'n50' },
      { id: 'b2', type: 'node', text: '여기', shapeType: 162, rect: [0, 0, 40, 20], tail: [20, 60] }
    ]
  }));
  const shape = id => cmds.filter(c => c[0] === 3 && [107, 162].includes(c[2]));
  const [b1, b2] = shape();
  assert.equal(b1[2], 107);
  const props = c => { const m = new Map(); for (let i = 0; i + 1 < c[4].length; i += 2) m.set(c[4][i], c[4][i + 1]); return m; };
  const p1 = props(b1);
  // 말풍선(중심 220,55)에서 왼쪽 아래 50 노드(중심 116.4,116.4) 쪽: 꼬리 끝은 왼쪽 아래, 노드 테두리 근처
  assert.ok(p1.get(0) < -100000 && p1.get(0) > -130000, String(p1.get(0)));
  assert.ok(p1.get(1) > 100000 && p1.get(1) < 200000, String(p1.get(1)));
  assert.equal(b2[2], 162);
  const p2 = props(b2);
  assert.equal(p2.get(0), 0);
  assert.equal(p2.get(1), 250000);
});

test('preview model reads back shapes, text and connectors from the payload', () => {
  const payload = clip.buildDrawingPayload({
    mode: 'diagram',
    items: [
      { id: 'a', type: 'node', text: '요청' },
      { id: 'b', type: 'node', text: '서버' },
      { id: 'c', type: 'node', text: '응답' },
      { id: 'e1', type: 'arrow', from: 'a', to: 'b' },
      { id: 'e2', type: 'arrow', from: 'a', to: 'c' }
    ]
  });
  const model = clip.previewModel(payload);
  const boxes = model.shapes.filter(s => s.kind === 'rect');
  const lines = model.shapes.filter(s => s.kind === 'line');
  assert.deepEqual(boxes.map(b => b.text).sort(), ['서버', '요청', '응답']);
  assert.equal(lines.length, 2);
  const a = boxes.find(b => b.text === '요청');
  const b = boxes.find(x => x.text === '서버');
  for (const line of lines) {
    // 선은 부모 아래 가운데에서 출발해 자식 윗변에 닿는다
    assert.ok(Math.abs(line.x1 - (a.x + a.w / 2)) < 0.1);
    assert.ok(Math.abs(line.y1 - (a.y + a.h)) < 0.1);
    assert.equal(line.endHead, 7);
  }
  const toB = lines.find(l => Math.abs(l.x2 - (b.x + b.w / 2)) < 0.1);
  assert.ok(toB && Math.abs(toB.y2 - b.y) < 0.1);
  assert.ok(model.box[2] > 0 && model.box[3] > 0);
});

test('preview svg is built with DOM calls only', () => {
  const made = [];
  const fakeDoc = {
    createElementNS(ns, tag) {
      const node = { tag, attrs: {}, children: [], textContent: '',
        setAttribute(k, v) { this.attrs[k] = v; },
        appendChild(c) { this.children.push(c); return c; } };
      made.push(node);
      return node;
    }
  };
  const payload = clip.buildDrawingPayload({
    mode: 'annotate',
    items: [{ id: 'b1', type: 'box', rect: [10, 10, 50, 20] }]
  }, { dataUrl: 'data:image/png;base64,AAAA', width: 200, height: 100 });
  const svg = clip.buildPreviewSvg(payload, fakeDoc);
  assert.equal(svg.tag, 'svg');
  assert.ok(made.some(n => n.tag === 'image' && n.attrs.href === 'data:image/png;base64,AAAA'));
  assert.ok(made.some(n => n.tag === 'rect' && n.attrs.stroke === '#FF0000'));
});
