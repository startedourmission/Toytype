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
