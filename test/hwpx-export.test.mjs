import assert from 'node:assert/strict';
import test from 'node:test';
import { DOMParser } from '@xmldom/xmldom';

// The exporter runs in a content script where DOMParser is a browser global; the
// OMML equation converter relies on it. Provide the same API under Node for tests.
if (typeof globalThis.DOMParser !== 'function') globalThis.DOMParser = DOMParser;

await import('../content/hwpx-export.js');

function readStoredZipText(buffer, fileName) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const decoder = new TextDecoder();
  const entry = listStoredZipEntries(bytes).find(item => item.name === fileName);
  if (!entry) throw new Error('zip entry not found: ' + fileName);
  assert.equal(entry.method, 0);
  return decoder.decode(bytes.slice(entry.dataStart, entry.dataStart + entry.compressedSize));
}

function listStoredZipEntries(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const decoder = new TextDecoder();
  const entries = [];
  let offset = 0;
  while (offset + 30 <= bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, bytes.byteLength - offset);
    if (view.getUint32(0, true) !== 0x04034b50) break;
    const method = view.getUint16(8, true);
    const compressedSize = view.getUint32(18, true);
    const nameLength = view.getUint16(26, true);
    const extraLength = view.getUint16(28, true);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const name = decoder.decode(bytes.slice(nameStart, nameStart + nameLength));
    entries.push({ name, method, compressedSize, dataStart });
    offset = dataStart + compressedSize;
  }
  return entries;
}

function fakeImg(attrs) {
  const element = {
    tagName: 'IMG',
    localName: 'img',
    parentNode: null,
    parentElement: null,
    childNodes: [],
    children: [],
    querySelectorAll() {
      return [];
    },
    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name) ? attrs[name] : '';
    }
  };
  const textSibling = { nodeType: 3, nodeValue: '본문' };
  const parent = { childNodes: [textSibling, element] };
  element.parentNode = parent;
  element.parentElement = parent;
  return element;
}

function fakeDoc(images) {
  return {
    querySelectorAll(selector) {
      return selector === 'img' ? images : [];
    }
  };
}

test('HWPX export includes a non-empty linesegarray for every paragraph', () => {
  const exporter = globalThis.ToytypeHwpxExport;
  const bytes = exporter._internal.buildHwpx([
    { type: 'heading', level: 1, runs: [{ text: '제목' }] },
    { type: 'paragraph', runs: [{ text: '본문\n둘째 줄' }] },
    {
      type: 'table',
      rowCnt: 1,
      colCnt: 2,
      rows: [[
        { rowAddr: 0, colAddr: 0, colSpan: 1, rowSpan: 1, header: true, blocks: [{ type: 'paragraph', runs: [{ text: 'A' }] }] },
        { rowAddr: 0, colAddr: 1, colSpan: 1, rowSpan: 1, header: true, blocks: [{ type: 'paragraph', runs: [{ text: 'B' }] }] }
      ]]
    }
  ], { title: 'sample', images: [] });

  const sectionXml = readStoredZipText(bytes, 'Contents/section0.xml');
  const paragraphCount = (sectionXml.match(/<hp:p\b/g) || []).length;
  const linesegArrayCount = (sectionXml.match(/<hp:linesegarray>/g) || []).length;
  const linesegCount = (sectionXml.match(/<hp:lineseg\b/g) || []).length;

  assert.equal(paragraphCount, 5);
  assert.equal(linesegArrayCount, paragraphCount);
  assert.ok(linesegCount >= paragraphCount);
  assert.doesNotMatch(sectionXml, /<hp:linesegarray>\s*<\/hp:linesegarray>/);
});

test('HWPX package includes Hancom-required container files', () => {
  const exporter = globalThis.ToytypeHwpxExport;
  const bytes = exporter._internal.buildHwpx([
    { type: 'paragraph', runs: [{ text: '본문' }] }
  ], { title: 'package', images: [] });
  const entries = listStoredZipEntries(bytes);
  const names = entries.map(entry => entry.name);
  const required = [
    'mimetype',
    'version.xml',
    'Contents/header.xml',
    'Contents/section0.xml',
    'Contents/content.hpf',
    'Preview/PrvText.txt',
    'Preview/PrvImage.png',
    'settings.xml',
    'META-INF/container.xml',
    'META-INF/container.rdf',
    'META-INF/manifest.xml'
  ];

  assert.equal(names[0], 'mimetype');
  for (const name of required) assert.ok(names.includes(name), 'missing required file: ' + name);
});

test('HWPX content.hpf manifest only references package entries that exist', () => {
  const exporter = globalThis.ToytypeHwpxExport;
  const bytes = exporter._internal.buildHwpx([
    { type: 'paragraph', runs: [{ text: '본문' }] }
  ], { title: 'manifest', images: [] });
  const entries = listStoredZipEntries(bytes);
  const names = new Set(entries.map(entry => entry.name));
  const contentHpf = readStoredZipText(bytes, 'Contents/content.hpf');
  const hrefs = Array.from(contentHpf.matchAll(/href="([^"]+)"/g), match => match[1]);

  for (const href of hrefs) assert.ok(names.has(href), 'missing href target: ' + href);
  assert.match(contentHpf, /<opf:item id="settings" href="settings\.xml"/);
});

test('HWPX export precomputes multiple linesegs for long text runs', () => {
  const exporter = globalThis.ToytypeHwpxExport;
  const longText = '현재 땅꺼짐 사고의 가장 큰 문제는 지표면이 완전히 주저앉고 나서야 수습에 나선다는 점입니다. '.repeat(4);
  const bytes = exporter._internal.buildHwpx([
    { type: 'paragraph', runs: [{ text: longText }] }
  ], { title: 'long-text', images: [] });

  const sectionXml = readStoredZipText(bytes, 'Contents/section0.xml');
  const linesegCount = (sectionXml.match(/<hp:lineseg\b/g) || []).length;

  assert.ok(linesegCount > 1);
  assert.equal(exporter._internal.validateSectionXml(sectionXml).count, 0);
});

test('HWPX validation mirrors rhwp long single-lineseg warning', () => {
  const exporter = globalThis.ToytypeHwpxExport;
  const longText = '가'.repeat(41);
  const sectionXml = `<hs:sec xmlns:hs="x" xmlns:hp="y"><hp:p paraPrIDRef="0" styleIDRef="0"><hp:run charPrIDRef="0"><hp:t>${longText}</hp:t></hp:run><hp:linesegarray><hp:lineseg textpos="0" vertpos="0" vertsize="1000" textheight="1000" baseline="850" spacing="600" horzpos="0" horzsize="44000" flags="393216"/></hp:linesegarray></hp:p></hs:sec>`;
  const report = exporter._internal.validateSectionXml(sectionXml);

  assert.equal(report.count, 1);
  assert.equal(report.warnings[0].kind, 'LinesegTextRunReflow');
});

test('HWPX export does not emit rhwp textRun reflow warnings over forty chars', () => {
  const exporter = globalThis.ToytypeHwpxExport;
  const text = '가'.repeat(41);
  const bytes = exporter._internal.buildHwpx([
    { type: 'paragraph', runs: [{ text }] }
  ], { title: 'forty-one', images: [] });

  const sectionXml = readStoredZipText(bytes, 'Contents/section0.xml');
  const report = exporter._internal.validateSectionXml(sectionXml);

  assert.equal(report.count, 0);
});

test('HWPX export avoids local-check-only Latin and symbol font declarations', () => {
  const exporter = globalThis.ToytypeHwpxExport;
  const bytes = exporter._internal.buildHwpx([
    { type: 'paragraph', runs: [{ text: 'ABC 123' }] }
  ], { title: 'fonts', images: [] });

  const headerXml = readStoredZipText(bytes, 'Contents/header.xml');

  assert.doesNotMatch(headerXml, /Times New Roman|Consolas|Arial Black|Symbol/);
});

test('HWPX header mirrors real Hangul OWPML structure', () => {
  const exporter = globalThis.ToytypeHwpxExport;
  const bytes = exporter._internal.buildHwpx([
    { type: 'paragraph', runs: [{ text: '굵게', bold: true }] }
  ], { title: 'owpml', images: [] });
  const headerXml = readStoredZipText(bytes, 'Contents/header.xml');

  assert.doesNotMatch(headerXml, /<hh:binDataList|<hh:fillInfo|centerLine="0"|bold="1"|italic="1"|<hh:bullets/);
  assert.match(headerXml, /<hh:margin><hc:intent value="\d+" unit="HWPUNIT"\/>/);
  assert.match(headerXml, /<hp:case hp:required-namespace="http:\/\/www\.hancom\.co\.kr\/hwpml\/2016\/HwpUnitChar">/);
  assert.match(headerXml, /<hh:bold\/>/);
  assert.match(headerXml, /<hh:borderFill id="1" [^>]*centerLine="NONE"/);
  assert.doesNotMatch(headerXml, /<hh:borderFill id="0"/);
  assert.match(headerXml, /<hh:tabPr id="0"/);
  assert.match(headerXml, /<hh:numbering id="1"/);
});

test('HWPX picture element follows the Hangul hp:pic layout', () => {
  const exporter = globalThis.ToytypeHwpxExport;
  const image = {
    data: new Uint8Array([1, 2, 3]),
    mime: 'image/png',
    ext: 'png',
    widthPx: 200,
    heightPx: 100,
    alt: '스크린샷',
    index: 1,
    binaryId: 'BIN0001',
    fileName: 'BIN0001.png',
    packagePath: 'BinData/BIN0001.png'
  };
  const bytes = exporter._internal.buildHwpx([
    { type: 'paragraph', runs: [{ image }] }
  ], { title: 'pic', images: [image] });

  const sectionXml = readStoredZipText(bytes, 'Contents/section0.xml');
  assert.match(sectionXml, /<hp:pic [^>]*href="" groupLevel="0" instid="\d+" reverse="0">/);
  assert.match(sectionXml, /<hp:offset x="0" y="0"\/><hp:orgSz width="\d+" height="\d+"\/><hp:curSz/);
  assert.match(sectionXml, /<hp:renderingInfo><hc:transMatrix/);
  assert.match(sectionXml, /<hp:imgRect><hc:pt0 /);
  assert.match(sectionXml, /<hp:imgDim dimwidth="15000" dimheight="7500"\/>/);
  assert.match(sectionXml, /<hc:img binaryItemIDRef="BIN0001" [^>]*alpha="0"\/>/);
  assert.doesNotMatch(sectionXml, /<hp:shapePr|<hp:img |<hp:pt0/);

  const entries = listStoredZipEntries(bytes).map(entry => entry.name);
  assert.ok(entries.includes('BinData/BIN0001.png'));
  const contentHpf = readStoredZipText(bytes, 'Contents/content.hpf');
  assert.match(contentHpf, /<opf:item id="BIN0001" href="BinData\/BIN0001\.png" media-type="image\/png" isEmbeded="1"\/>/);
});

test('HWPX export emits native Hangul equation controls', () => {
  const exporter = globalThis.ToytypeHwpxExport;
  const bytes = exporter._internal.buildHwpx([
    {
      type: 'paragraph',
      runs: [
        { text: '피타고라스: ' },
        { equation: { script: 'x^{2}+y^{2}=z^{2}', baseUnit: 900 } },
        { text: ' 입니다.' }
      ]
    }
  ], { title: 'equation', images: [] });

  const sectionXml = readStoredZipText(bytes, 'Contents/section0.xml');
  assert.match(sectionXml, /<hp:equation [^>]*numberingType="EQUATION"[^>]*version="Equation Version 60"[^>]*baseUnit="900"[^>]*font="HYhwpEQ"/);
  assert.match(sectionXml, /<hp:pos treatAsChar="1"[^>]*flowWithText="1"/);
  assert.match(sectionXml, /<hp:shapeComment>수식입니다\.<\/hp:shapeComment>/);
  assert.match(sectionXml, /<hp:script xml:space="preserve">x\^\{2\}\+y\^\{2\}=z\^\{2\}<\/hp:script>/);
  assert.match(sectionXml, /<\/hp:equation><hp:t\/>/);
  assert.doesNotMatch(sectionXml, /<hp:pic\b/);
  assert.equal(exporter._internal.validateSectionXml(sectionXml).count, 0);

  const preview = readStoredZipText(bytes, 'Preview/PrvText.txt');
  assert.match(preview, /피타고라스: x\^\{2\}\+y\^\{2\}=z\^\{2\} 입니다\./);
});

test('HWPX equation converter maps common LaTeX to Hangul equation script', () => {
  const exporter = globalThis.ToytypeHwpxExport;
  const script = exporter._internal.latexToEquationScript(String.raw`\frac{x^2+\mu}{\sqrt[n]{y}} \leq \infty`);

  assert.equal(script, '{x^{2}+ mu} over {root {n} of {y}} LEQ INF');
});

test('HWPX equation registry maps Google Docs exported equation images from hints', () => {
  const exporter = globalThis.ToytypeHwpxExport;
  const img = fakeImg({
    src: 'images/image1.png',
    width: '96',
    height: '24',
    style: 'vertical-align: middle;'
  });

  const registry = exporter._internal.buildEquationRegistry(fakeDoc([img]), [
    { script: 'x^{2}+y^{2}=z^{2}' }
  ]);

  assert.equal(registry.count, 1);
  assert.deepEqual(registry.byElement.get(img), {
    script: 'x^{2}+y^{2}=z^{2}',
    baseUnit: 900
  });
});

test('HWPX equation hints read Markdown image alt text', () => {
  const exporter = globalThis.ToytypeHwpxExport;
  const hints = exporter._internal.collectMarkdownEquationHints(String.raw`![\frac{x}{y}](images/image1.png)`);

  assert.equal(hints.length, 1);
  assert.equal(hints[0].script, '{x} over {y}');
});

// OMML samples below are taken verbatim in shape from the DOCX export of a real
// Google Docs document, which keeps native equations as <m:oMath> even though the
// HTML/Markdown exports flatten them to PNG images.
const OMML_RPR = '<w:rPr><w:rFonts w:ascii="Arimo"/><w:sz w:val="20"/></w:rPr>';
const ommlRun = t => `<m:r>${OMML_RPR}<m:t xml:space="preserve">${t}</m:t></m:r>`;

test('HWPX OMML converter maps every equation shape used by Google Docs', () => {
  const to = globalThis.ToytypeHwpxExport._internal.ommlToEquationScript;

  assert.equal(
    to(`<m:oMath><m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:e>${ommlRun('Var(X)')}</m:e></m:rad></m:oMath>`),
    'sqrt {Var(X)}');
  assert.equal(
    to(`<m:oMath>${ommlRun('P(X=x)=')}<m:sSup><m:e>${ommlRun('p')}</m:e><m:sup>${ommlRun('x')}</m:sup></m:sSup></m:oMath>`),
    'P(X=x)= p^{x}');
  assert.equal(
    to(`<m:oMath>${ommlRun('E(X)=')}<m:f><m:num>${ommlRun('1')}</m:num><m:den>${ommlRun('p')}</m:den></m:f></m:oMath>`),
    'E(X)= {1} over {p}');
  assert.equal(
    to(`<m:oMath>${ommlRun('Var(X)=')}<m:f><m:num>${ommlRun('1-p')}</m:num><m:den><m:sSup><m:e>${ommlRun('p')}</m:e><m:sup>${ommlRun('2')}</m:sup></m:sSup></m:den></m:f></m:oMath>`),
    'Var(X)= {1-p} over {p^{2}}');
  assert.equal(
    to(`<m:oMath><m:nary><m:naryPr><m:chr m:val="∑"/></m:naryPr><m:sub/><m:sup/></m:nary>${ommlRun('p(x)=1')}</m:oMath>`),
    'SUM p(x)=1');
  assert.equal(
    to(`<m:oMath><m:sSub><m:e>${ommlRun('Z')}</m:e><m:sub>${ommlRun('1')}</m:sub></m:sSub>${ommlRun(',… ,')}<m:sSub><m:e>${ommlRun('Z')}</m:e><m:sub>${ommlRun('n')}</m:sub></m:sSub></m:oMath>`),
    'Z_{1},…, Z_{n}');
  assert.equal(
    to(`<m:oMath><m:d><m:dPr><m:begChr m:val="("/><m:endChr m:val=")"/></m:dPr><m:e>${ommlRun('x+y')}</m:e></m:d></m:oMath>`),
    'left (x+y right)');
});

test('HWPX OMML converter escapes literal braces and normalizes symbols in run text', () => {
  const to = globalThis.ToytypeHwpxExport._internal.ommlToEquationScript;
  const wrap = t => `<m:oMath>${ommlRun(t)}</m:oMath>`;

  // Literal { } would otherwise be read as Hangul grouping operators and vanish.
  assert.equal(to(wrap('X∈{0,1}')), 'X IN LBRACE 0,1 RBRACE');
  // U+2223 divides, U+2229 intersection.
  assert.equal(to(wrap('P(B∣A)=P(B∩A)/P(A)')), 'P(B VERT A)=P(B CAP A)/P(A)');
  // U+2212 minus is normalized to ASCII hyphen; U+200B zero-width space is dropped.
  assert.equal(to(wrap('(1−p)')), '(1-p)');
  assert.equal(to(wrap('a​)')), 'a)');
  // Structural grouping braces built by the converter must survive untouched.
  assert.equal(
    to(`<m:oMath><m:f><m:num>${ommlRun('1')}</m:num><m:den>${ommlRun('p')}</m:den></m:f></m:oMath>`),
    '{1} over {p}');
});

test('HWPX OMML converter groups multi-atom bases but not single characters', () => {
  const to = globalThis.ToytypeHwpxExport._internal.ommlToEquationScript;

  assert.equal(
    to(`<m:oMath><m:sSup><m:e>${ommlRun('a+b')}</m:e><m:sup>${ommlRun('2')}</m:sup></m:sSup></m:oMath>`),
    '{a+b}^{2}');
  // Google Docs sometimes hangs a superscript off a lone bracket; it must not become "{)}".
  assert.equal(
    to(`<m:oMath>${ommlRun('(1-p')}<m:sSup><m:e>${ommlRun(')')}</m:e><m:sup>${ommlRun('1-x')}</m:sup></m:sSup></m:oMath>`),
    '(1-p)^{1-x}');
});

test('HWPX OMML converter handles a nested fraction-over-radical', () => {
  const to = globalThis.ToytypeHwpxExport._internal.ommlToEquationScript;
  const script = to(
    `<m:oMath>${ommlRun('f(x)=')}<m:f><m:num>${ommlRun('1')}</m:num>` +
    `<m:den><m:rad><m:radPr><m:degHide m:val="1"/></m:radPr>` +
    `<m:e>${ommlRun('2')}<m:r>${OMML_RPR}<m:t>π</m:t></m:r><m:r>${OMML_RPR}<m:t>σ</m:t></m:r></m:e>` +
    `</m:rad></m:den></m:f></m:oMath>`);

  assert.equal(script, 'f(x)= {1} over {sqrt {2 pi sigma}}');
});

test('HWPX registry maps DOCX OMML scripts onto equation images in order', () => {
  const internal = globalThis.ToytypeHwpxExport._internal;
  const eqA = fakeImg({ src: 'images/image1.png', width: '96', height: '24', style: 'vertical-align: middle;' });
  const eqB = fakeImg({ src: 'images/image2.png', width: '80', height: '22', style: 'vertical-align: middle;' });

  const registry = internal.buildEquationRegistry(fakeDoc([eqA, eqB]), [
    { script: 'sqrt {Var(X)}', source: 'docx-omml' },
    { script: '{1} over {p}', source: 'docx-omml' }
  ]);

  assert.equal(registry.count, 2);
  assert.equal(registry.byElement.get(eqA).script, 'sqrt {Var(X)}');
  assert.equal(registry.byElement.get(eqB).script, '{1} over {p}');
});

test('HWPX registry treats sizeless inline images as equations, not sized figures', () => {
  const internal = globalThis.ToytypeHwpxExport._internal;
  // Exact shapes observed in a real Google Docs zipped HTML export: equations are
  // inline images/imageN.png runs with an empty style and no width/height, while
  // figures carry an explicit "width: NNpx; height: NNpx; transform: ..." style.
  // The src is a relative path here (data: URI only in the plain HTML export), so
  // classification must key off the style, not the src scheme.
  const eq1 = fakeImg({ src: 'images/image1.png', style: '' });
  const figure = fakeImg({
    src: 'images/image237.png',
    style: 'width: 601.70px; height: 269.33px; margin-left: 0.00px; transform: rotate(0.00rad) translateZ(0px);'
  });
  const eq2 = fakeImg({ src: 'images/image2.png', style: '' });

  const registry = internal.buildEquationRegistry(fakeDoc([eq1, figure, eq2]), [
    { script: 'sqrt {Var(X)}', source: 'docx-omml' },
    { script: '{1} over {p}', source: 'docx-omml' }
  ]);

  assert.equal(registry.count, 2);
  assert.equal(registry.byElement.get(eq1).script, 'sqrt {Var(X)}');
  assert.equal(registry.byElement.get(eq2).script, '{1} over {p}');
  assert.ok(!registry.byElement.has(figure), 'sized drawing must not be treated as an equation');
});

test('HWPX registry prefers DOCX OMML over lower-confidence hints', () => {
  const internal = globalThis.ToytypeHwpxExport._internal;
  const eq = fakeImg({ src: 'images/image1.png', width: '96', height: '24', style: 'vertical-align: middle;' });

  // When OMML hints are present, DOM/Markdown hints must not consume the image slot.
  const registry = internal.buildEquationRegistry(fakeDoc([eq]), [
    { script: 'WRONG_FROM_ALT' },
    { script: 'sqrt {Var(X)}', source: 'docx-omml' }
  ]);

  assert.equal(registry.count, 1);
  assert.equal(registry.byElement.get(eq).script, 'sqrt {Var(X)}');
});

test('HWPX extracts OMML equations from word/document.xml in document order', () => {
  const internal = globalThis.ToytypeHwpxExport._internal;
  const documentXml =
    `<w:document><w:body><w:p><w:r><w:t>본문</w:t></w:r></w:p>` +
    `<w:p><m:oMath>${ommlRun('E(X)=')}<m:f><m:num>${ommlRun('1')}</m:num><m:den>${ommlRun('p')}</m:den></m:f></m:oMath></w:p>` +
    `<w:p><m:oMath><m:rad><m:radPr><m:degHide m:val="1"/></m:radPr><m:e>${ommlRun('Var(X)')}</m:e></m:rad></m:oMath></w:p>` +
    `</w:body></w:document>`;

  assert.deepEqual(internal.extractOmmlEquationScripts(documentXml), [
    'E(X)= {1} over {p}',
    'sqrt {Var(X)}'
  ]);
});

test('HWPX export wraps table cell linesegs using cell width', () => {
  const exporter = globalThis.ToytypeHwpxExport;
  const longCell = '좁은 표 셀에 들어가는 긴 문장입니다. '.repeat(8);
  const bytes = exporter._internal.buildHwpx([
    {
      type: 'table',
      rowCnt: 1,
      colCnt: 2,
      rows: [[
        { rowAddr: 0, colAddr: 0, colSpan: 1, rowSpan: 1, header: false, blocks: [{ type: 'paragraph', runs: [{ text: longCell }] }] },
        { rowAddr: 0, colAddr: 1, colSpan: 1, rowSpan: 1, header: false, blocks: [{ type: 'paragraph', runs: [{ text: 'B' }] }] }
      ]]
    }
  ], { title: 'cell-wrap', images: [] });

  const sectionXml = readStoredZipText(bytes, 'Contents/section0.xml');
  const match = sectionXml.match(/<hp:tc\b[\s\S]*?<hp:linesegarray>([\s\S]*?)<\/hp:linesegarray>/);

  assert.ok(match);
  assert.ok((match[1].match(/<hp:lineseg\b/g) || []).length > 1);
  assert.match(match[1], /horzsize="20240"/);
  assert.equal(exporter._internal.validateSectionXml(sectionXml).count, 0);
});

test('HWPX export emits reference-style fonts, code blocks, and callout boxes', () => {
  const exporter = globalThis.ToytypeHwpxExport;
  const bytes = exporter._internal.buildHwpx([
    { type: 'heading', level: 1, runs: [{ text: '장 제목' }] },
    { type: 'paragraph', runs: [{ text: '본문 강조', bold: true }] },
    { type: 'code', text: 'x <- 1\nprint(x)' },
    {
      type: 'callout',
      blocks: [
        { type: 'paragraph', runs: [{ text: '꼭 알아둘 점' }] },
        { type: 'paragraph', runs: [{ text: '코너 본문입니다.' }] }
      ]
    }
  ], { title: 'styles', images: [] });

  const headerXml = readStoredZipText(bytes, 'Contents/header.xml');
  const sectionXml = readStoredZipText(bytes, 'Contents/section0.xml');

  assert.match(headerXml, /나눔스퀘어 ExtraBold/);
  assert.match(headerXml, /D2Coding/);
  assert.match(headerXml, /Pretendard Medium/);
  assert.match(headerXml, /KoPubWorld바탕체 Light/);
  assert.match(headerXml, /<hh:style id="6" type="PARA" name="코드"/);
  assert.match(headerXml, /<hh:style id="36" type="PARA" name="노베이스-내용"/);
  assert.match(sectionXml, /styleIDRef="6"[\s\S]*?<hp:tbl [^>]*rowCnt="1" colCnt="2"/);
  assert.match(sectionXml, /styleIDRef="36"[\s\S]*?borderFillIDRef="8"/);
  assert.equal(exporter._internal.validateSectionXml(sectionXml).count, 0);
});

function fakePng(width, height) {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

function fakeDocx(exporter, documentXml, relsXml, media) {
  return exporter._internal.createStoredZip([
    { name: 'word/document.xml', data: documentXml },
    { name: 'word/_rels/document.xml.rels', data: relsXml },
    ...media
  ]);
}

test('image extraction keeps document order and skips placeholders', async () => {
  const exporter = globalThis.ToytypeHwpxExport;
  const imageB = fakePng(5, 5);
  const imageC = fakePng(6, 7);
  const imageA = fakePng(3, 4);
  const docx = fakeDocx(
    exporter,
    '<w:document><w:body>' +
      '<w:p><w:drawing><a:blip r:embed="rId20"/></w:drawing></w:p>' +
      '<w:p><w:pict><v:imagedata r:id="rId30"/></w:pict></w:p>' +
      '<w:p><w:drawing><a:blip r:embed="rId10"/></w:drawing></w:p>' +
      '<w:p><w:drawing><a:blip r:embed="rId40"/></w:drawing></w:p>' +
      '<w:p><w:drawing><a:blip r:embed="rId50"/></w:drawing></w:p>' +
      '</w:body></w:document>',
    '<Relationships>' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
      '<Relationship Id="rId10" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/imageA.png"/>' +
      '<Relationship Id="rId20" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/imageB.png"/>' +
      '<Relationship Id="rId30" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/imageC.png"/>' +
      '<Relationship Id="rId40" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/tiny.png"/>' +
      '<Relationship Id="rId50" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://example.com/x.png" TargetMode="External"/>' +
      '</Relationships>',
    [
      { name: 'word/media/imageA.png', data: imageA },
      { name: 'word/media/imageB.png', data: imageB },
      { name: 'word/media/imageC.png', data: imageC },
      { name: 'word/media/tiny.png', data: fakePng(1, 1) }
    ]
  );

  const result = await exporter._internal.extractImagesFromDocx(docx);
  assert.equal(result.imageCount, 3);
  assert.equal(result.skippedImageCount, 1);

  const entries = listStoredZipEntries(result.bytes);
  assert.deepEqual(entries.map(entry => entry.name), ['001.png', '002.png', '003.png']);
  const bytes = result.bytes;
  const dataOf = entry => bytes.slice(entry.dataStart, entry.dataStart + entry.compressedSize);
  assert.deepEqual(dataOf(entries[0]), imageB);
  assert.deepEqual(dataOf(entries[1]), imageC);
  assert.deepEqual(dataOf(entries[2]), imageA);
});

test('image extraction reports zero images without creating a zip', async () => {
  const exporter = globalThis.ToytypeHwpxExport;
  const docx = fakeDocx(
    exporter,
    '<w:document><w:body><w:p>텍스트만</w:p></w:body></w:document>',
    '<Relationships></Relationships>',
    []
  );
  const result = await exporter._internal.extractImagesFromDocx(docx);
  assert.equal(result.imageCount, 0);
  assert.equal(result.skippedImageCount, 0);
  assert.equal(result.bytes, null);
});
