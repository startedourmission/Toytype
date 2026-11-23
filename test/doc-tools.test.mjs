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
