import test from 'node:test';
import assert from 'node:assert/strict';
import '../content/doc-tools.js';
import { docsExportUrl, pageCacheKey } from '../drive-service.mjs';

const T = globalThis.ToytypeDocTools;

function pdf(body) {
  return new TextEncoder().encode('%PDF-1.4\n' + body + '\n%%EOF');
}

test('PDF 쪽수: 루트 /Pages의 가장 큰 /Count를 쓴다', () => {
  const body = [
    '1 0 obj << /Type /Pages /Kids [2 0 R 3 0 R] /Count 92 >> endobj',
    '2 0 obj << /Type /Pages /Parent 1 0 R /Count 8 >> endobj',
    '3 0 obj << /Count 84 /Type /Pages /Parent 1 0 R >> endobj',
    '4 0 obj << /Type /Page /Parent 2 0 R >> endobj'
  ].join('\n');
  assert.equal(T.countPdfPages(pdf(body)), 92);
});

test('PDF 쪽수: /Count가 없으면 /Type /Page 객체를 센다', () => {
  const body = '1 0 obj << /Type /Page >> endobj 2 0 obj << /Type /Page >> endobj 3 0 obj << /Type /Pages >> endobj';
  assert.equal(T.countPdfPages(pdf(body)), 2);
});

test('PDF 쪽수: PDF가 아니면 null', () => {
  assert.equal(T.countPdfPages(new TextEncoder().encode('<html>login</html>')), null);
});

test('md 목차: 코드 펜스 안 #은 무시하고 레벨을 지킨다', () => {
  const md = ['# 1장 정렬', '본문', '```', '# 주석', '```', '## 1.1 **버블** 정렬', '### [링크](http://x) 예제 코드', '#### 깊은 제목'].join('\n');
  const toc = T.parseMarkdownExportHeadings(md);
  assert.deepEqual(toc.headings.map(h => [h.level, h.text]), [[1, '1장 정렬'], [2, '1.1 버블 정렬'], [3, '링크 예제 코드'], [4, '깊은 제목']]);
  assert.equal(T.formatExtractedToc('x', T.filterTocLevel(toc, 3)), '1장 정렬\n_1.1 버블 정렬\n__링크 예제 코드');
});

test('export 주소: 두 번째 계정은 u/N을 붙인다', () => {
  assert.equal(docsExportUrl('abc', 'pdf', 0), 'https://docs.google.com/document/d/abc/export?format=pdf');
  assert.equal(docsExportUrl('abc', 'md', 1), 'https://docs.google.com/document/u/1/d/abc/export?format=md');
});

test('export 주소·캐시 키: 첫 탭만 셀 때는 tab=t.0과 별도 캐시 키를 쓴다', () => {
  assert.equal(docsExportUrl('abc', 'pdf', 0, 't.0'), 'https://docs.google.com/document/d/abc/export?format=pdf&tab=t.0');
  assert.equal(pageCacheKey('abc', 'all'), 'abc');
  assert.equal(pageCacheKey('abc', 'tab1'), 'abc#t.0');
});

test('최소 바꾸기: 같은 앞뒤를 덜어 서식이 있는 글자를 덮지 않는다', () => {
  // "O(n2)이다." → "O(n2)입니다." : 위첨자 2는 건드리지 않고 '이'만 '입니'로
  assert.deepEqual(T.minimalEdit('O(n2)이다.', 'O(n2)입니다.', 100), { src: '이', dst: '입니', start: 105, end: 106 });
  // 앞부분만 바뀜
  assert.deepEqual(T.minimalEdit('비교한다.', '비교합니다.', 0), { src: '한', dst: '합니', start: 2, end: 3 });
  // 삭제도 넣을 글자가 있어야 하므로 이웃 한 글자를 같이 덮는다
  assert.deepEqual(T.minimalEdit('x2 의 의', 'x2 의', 10), { src: '의 의', dst: '의', start: 13, end: 16 });
  // 앞머리 삭제: "따라서 "를 지우면서 뒤 글자 t를 함께 덮는다
  assert.deepEqual(T.minimalEdit('따라서 top이 -1인 경우', 'top이 -1인 경우', 0), { src: '따라서 t', dst: 't', start: 0, end: 5 });
  // 위첨자 병기 지우기: 뒤 글자('을')가 아니라 앞 글자('블')를 빌려 덮는다 — 뒤 글자가 위첨자로 바뀌지 않게
  assert.deepEqual(T.minimalEdit('테이블hash table을', '테이블을', 0), { src: '블hash table', dst: '블', start: 2, end: 13 });
  // 순수 삽입은 첨자가 아닐 법한 이웃 글자를 함께 덮는다(오른쪽 '다'를 고름, 왼쪽 숫자 2는 피함)
  assert.deepEqual(T.minimalEdit('n2다', 'n2이다', 0), { src: '다', dst: '이다', start: 2, end: 3 });
  // 같으면 그대로
  assert.deepEqual(T.minimalEdit('같음', '같음', 5), { src: '같음', dst: '같음', start: 5, end: 7 });
});

test('docx 댓글·제안: 앵커 문구와 문맥, 바꾸기 묶음을 뽑는다', async () => {
  const { DOMParser } = await import('@xmldom/xmldom');
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const documentXml = `<w:document ${W}><w:body>
    <w:p><w:r><w:t>스택은 </w:t></w:r><w:commentRangeStart w:id="0"/><w:r><w:t>후입선출</w:t></w:r><w:commentRangeEnd w:id="0"/><w:r><w:t> 구조다.</w:t></w:r></w:p>
    <w:p><w:r><w:t>배열을 </w:t></w:r><w:del w:id="1" w:author="편집자" w:date="2026-11-20T00:00:00Z"><w:r><w:delText>사용한다</w:delText></w:r></w:del><w:ins w:id="2" w:author="편집자" w:date="2026-11-20T00:00:00Z"><w:r><w:t>사용합니다</w:t></w:r></w:ins><w:r><w:t>.</w:t></w:r></w:p>
    <w:p><w:ins w:id="3" w:author="저자"><w:r><w:t>새 문장.</w:t></w:r></w:ins></w:p>
  </w:body></w:document>`;
  const commentsXml = `<w:comments ${W}><w:comment w:id="0" w:author="검토자" w:date="2026-11-21T00:00:00Z"><w:p><w:r><w:t>LIFO도 같이 적어 주세요</w:t></w:r></w:p></w:comment></w:comments>`;
  const r = T.parseDocxReview(documentXml, commentsXml, DOMParser);
  assert.equal(r.comments.length, 1);
  assert.equal(r.comments[0].author, '검토자');
  assert.equal(r.comments[0].anchor, '후입선출');
  assert.equal(r.comments[0].context, '스택은 후입선출 구조다.');
  assert.equal(r.suggestions.length, 2);
  assert.deepEqual([r.suggestions[0].kind, r.suggestions[0].author, r.suggestions[0].deleted, r.suggestions[0].inserted], ['replace', '편집자', '사용한다', '사용합니다']);
  assert.equal(r.suggestions[0].context, '배열을 ⟦-사용한다⟧⟦+사용합니다⟧.');
  assert.deepEqual([r.suggestions[1].kind, r.suggestions[1].author, r.suggestions[1].inserted], ['insert', '저자', '새 문장.']);
});

test('서식 점검: 요소를 나누고 크기·글꼴·첨자·표기 불일치를 잡는다', async () => {
  const { DOMParser } = await import('@xmldom/xmldom');
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const stylesXml = `<w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arimo"/><w:sz w:val="20"/></w:rPr></w:rPrDefault></w:docDefaults>
    <w:style w:styleId="Heading2"><w:name w:val="heading 2"/><w:rPr><w:sz w:val="32"/></w:rPr></w:style></w:styles>`;
  const p = (t, rpr = '', ppr = '') => `<w:p>${ppr}<w:r>${rpr ? '<w:rPr>' + rpr + '</w:rPr>' : ''}<w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
  const body = [
    `<w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>2.1 스택</w:t></w:r></w:p>`,
    p('본문 하나입니다.'), p('본문 둘입니다.'), p('본문 셋입니다.'), p('본문 넷은 크기가 다릅니다.', '<w:sz w:val="24"/>'),
    p('&lt;NOTE&gt; 노트는 작게 씁니다.', '<w:sz w:val="18"/>'), p('NOTE 표기가 다른 노트', '<w:sz w:val="18"/>'),
    p('```'), p('int a = 1;', '<w:rFonts w:ascii="Consolas"/><w:sz w:val="18"/>'), p('```'),
    `<w:p><w:r><w:t>복잡도는 O(n</w:t></w:r><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:t>2</w:t></w:r><w:r><w:t>)이고 O(m2)도 있다 </w:t></w:r><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:t>입니다</w:t></w:r></w:p>`,
    p('A -&gt; B로 갑니다.')
  ].join('');
  const sum = T.summarizeDocxFormat(`<w:document ${W}><w:body>${body}</w:body></w:document>`, stylesXml, DOMParser);
  assert.deepEqual(sum.paragraphs.map(x => x.kind), ['h2', 'body', 'body', 'body', 'body', 'note', 'note', 'fence', 'code', 'fence', 'body', 'body']);
  assert.equal(sum.paragraphs[0].size, 16);
  assert.equal(sum.paragraphs[1].font, 'Arimo');
  assert.equal(sum.paragraphs[8].font, 'Consolas');
  const f = T.formatRuleFindings(sum);
  const issues = f.map(x => x.issue).join('\n');
  assert.match(issues, /본문 크기가 다릅니다 \(12pt\)/);
  assert.match(issues, /위첨자로 잘못 올라간 한글/);
  assert.match(issues, /첨자로 써야 할 수 있는 표기: O\(m2\)/);
  assert.doesNotMatch(issues, /O\(n2\)/); // 이미 위첨자
  assert.match(issues, /노트 표기가 섞여/);
  assert.match(issues, /화살표가 ➝가 아닙니다/);
  assert.match(T.formatTranscript(sum, 0, 99), /#8 \[code 9pt Consolas, 1 lines\]/);
});

test('서식 점검: 코드 안 한글 주석·C 화살표 연산자는 지적하지 않는다', async () => {
  const { DOMParser } = await import('@xmldom/xmldom');
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  // 구글 DOCX처럼: 문단 기호에는 실제 코드 글꼴, 한글 섞인 글자 단위에는 Arial Unicode MS
  const code = (t, k) => `<w:p><w:pPr><w:rPr><w:rFonts w:ascii="Roboto Mono"/></w:rPr></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Arial Unicode MS"/><w:sz w:val="16"/></w:rPr><w:t xml:space="preserve">${t}${k}</w:t></w:r></w:p>`;
  const body = '<w:p><w:r><w:t>```</w:t></w:r></w:p>' + code('int *p; ', '// 정수를 가리키는 포인터를 선언하는 긴 한글 주석입니다') + code('p = &amp;a; ', '// 주소 저장') + '<w:p><w:r><w:t>```</w:t></w:r></w:p>' +
    '<w:p><w:r><w:t>화살표 연산자를 쓰면 ptr-&gt;score로 씁니다.</w:t></w:r></w:p>';
  const sum = T.summarizeDocxFormat(`<w:document ${W}><w:body>${body}</w:body></w:document>`, '', DOMParser);
  assert.equal(sum.paragraphs[1].font, 'Roboto Mono');
  const issues = T.formatRuleFindings(sum).map(f => f.issue).join('\n');
  assert.doesNotMatch(issues, /고정폭/);
  assert.doesNotMatch(issues, /화살표/);
});

test('서식 점검(HTML): 클래스 CSS로 글꼴·크기·첨자를 읽는다', async () => {
  const { DOMParser } = await import('@xmldom/xmldom');
  const html = `<html><head><style>.c1{font-family:"Arimo";font-size:10pt}.c2{font-family:"Roboto Mono";font-size:8pt}.c3{vertical-align:super;font-size:10pt}.c4{font-size:12pt;font-family:"Arimo"}h2{font-size:16pt}</style></head><body>
    <h2 class="c0"><span class="c1">2.1 스택</span></h2>
    <p><span class="c1">본문 하나</span></p><p><span class="c1">본문 둘</span></p><p><span class="c1">본문 셋</span></p><p><span class="c4">본문 넷은 크다</span></p>
    <p><span class="c2">\`\`\`</span></p><p><span class="c2">int *p; // 한글 주석이 아주 길게 붙어 있다</span></p><p><span class="c2">\`\`\`</span></p>
    <p><span class="c1">복잡도는 O(n</span><span class="c3">2</span><span class="c1">)이다</span></p>
    <table><tr><td><p><span class="c1">[경고] 상자 안</span></p></td></tr></table>
  </body></html>`;
  const sum = T.summarizeHtmlFormat(html, DOMParser);
  assert.deepEqual(sum.paragraphs.map(p => p.kind), ['h2', 'body', 'body', 'body', 'body', 'fence', 'code', 'fence', 'body', 'corner']);
  assert.equal(sum.paragraphs[6].font, 'Roboto Mono');
  assert.equal(sum.paragraphs[6].size, 8);
  assert.equal(sum.paragraphs[9].inTable, true);
  assert.equal(sum.paragraphs[8].scripts[0].text, '2');
  const issues = T.formatRuleFindings(sum).map(f => f.issue).join('\n');
  assert.match(issues, /본문 크기가 다릅니다 \(12pt\)/);
  assert.doesNotMatch(issues, /고정폭/);
  assert.doesNotMatch(issues, /O\(n2\)/);
});

test('서식 점검(HTML): 끝에 붙는 댓글 본문은 빼고, 고칠 방법(fix·edit)을 붙인다', async () => {
  const { DOMParser } = await import('@xmldom/xmldom');
  const html = `<html><head><style>.c1{font-family:"Arimo";font-size:10pt}.c4{font-family:"Arimo";font-size:11pt}</style></head><body>
    <p><span class="c1">본문 하나</span><sup><a href="#cmnt1" id="cmnt_ref1">[a]</a></sup></p><p><span class="c1">본문 둘</span></p><p><span class="c1">본문 셋 A -&gt; B</span></p><p><span class="c4">본문 넷</span></p>
    <div class="c9"><p><a href="#cmnt_ref1" id="cmnt1">[a]</a><span class="c4">@@ 댓글 본문</span></p><p><span class="c4">댓글 둘째 줄</span></p></div>
  </body></html>`;
  const sum = T.summarizeHtmlFormat(html, DOMParser);
  assert.deepEqual(sum.paragraphs.map(p => p.text), ['본문 하나', '본문 둘', '본문 셋 A -> B', '본문 넷']);
  const f = T.formatRuleFindings(sum);
  const size = f.find(x => /크기가 다릅니다/.test(x.issue));
  assert.deepEqual(size.fix, { type: 'fontSize', value: 10 });
  assert.deepEqual(f.find(x => /화살표/.test(x.issue)).edit, { src: '->', dst: '➝' });
});

test('통째 삭제: 문서의 이웃 글자를 빌려 덮어 입력할 글자를 만든다', () => {
  const apply = (text, c) => text.slice(0, c.start) + c.dst + text.slice(c.start + c.src.length);
  const cases = [
    ['앞 문장. 지울 문장. 뒷 문장.', '지울 문장.', '앞 문장. 뒷 문장.'],         // 앞뒤 공백 → 공백 하나 남김
    ['앞 문장.지울 문장.\n다음', '지울 문장.', '앞 문장.\n다음'],                // 앞 글자로 덮음
    ['해시 테이블hash table을 쓴다', 'hash table', '해시 테이블을 쓴다'],        // 병기 삭제 → 앞 글자로 덮음
    ['앞 문단\n지울 문단 전체\n다음 문단', '지울 문단 전체', '앞 문단\n다음 문단'], // 문단 통째 → 앞 문단 끝 글자+줄바꿈
    ['지울 첫 문단\n다음 문단', '지울 첫 문단', '다음 문단'],                     // 첫 문단 → 다음 문단 첫 글자
    ['힌트: 이것 끝', '힌트: ', '이것 끝']                                        // 뒤 글자로 덮음
  ];
  for (const [text, src, want] of cases) {
    const c = T.coverDeletion(text, src, text.indexOf(src));
    assert.ok(c && c.dst, src);
    assert.equal(apply(text, c), want);
    // minimalEdit을 거쳐도 덮을 글자가 남는다
    const m = T.minimalEdit(c.src, c.dst, c.start);
    assert.ok(m.dst.length > 0 && m.src.length > m.dst.length);
    assert.equal(apply(text, m), want);
  }
  // 병기 삭제는 앞 글자로 시작하는 선택이어야 한다(선택 첫 글자의 서식을 따르므로)
  assert.deepEqual(T.coverDeletion('테이블hash table을', 'hash table', 3), { src: '블hash table', dst: '블', start: 2 });
  assert.equal(T.coverDeletion('다른 글', '없는 글', 0), null);
});
