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
