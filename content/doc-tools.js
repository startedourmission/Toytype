// 토인비 편집 — 문서 도구 공용 함수 (Docs 패널·드라이브 버블·Node 테스트에서 같이 쓴다)
// 클래식 스크립트로 로드되므로 import/export·chrome.* 사용 금지. 부수효과는 globalThis.ToytypeDocTools 하나.
(function () {
  'use strict';

  function normalizeTocLine(line) {
    const s = String(line || '')
      .replace(/[​‌‍﻿]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!s || s.length > 90) return '';
    if (/^[.\-_=*•·\s]+$/.test(s)) return '';
    if (/^https?:\/\//i.test(s)) return '';
    return s;
  }

  function isFenceLine(line) {
    return /^(```|~~~)/.test(line || '');
  }

  function isBadTocText(line) {
    const s = String(line || '').trim();
    if (!s) return true;
    if (/^<\/?[^>]+>$/.test(s)) return true;
    if (/^[{}[\]();,./\\|`~@$%^&*_+=-]+$/.test(s)) return true;
    if (/^(양식|예시|예제|샘플|템플릿|출력|입력)$/.test(s)) return true;
    if (/^(회의록 요약|1분 꿀팁)$/.test(s)) return true;
    return false;
  }

  function cleanMarkdownHeadingText(text) {
    let s = String(text || '').trim();
    s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'); // 링크는 표시 텍스트만
    // 강조 마커 제거 — \*처럼 이스케이프된 리터럴은 건드리지 않는다
    s = s.replace(/(?<!\\)\*\*(.+?)\*\*/g, '$1');
    s = s.replace(/(?<!\\)\*([^*]+)\*/g, '$1');
    s = s.replace(/(?<!\\)~~(.+?)~~/g, '$1');
    s = s.replace(/(?<!\\)`([^`]+)`/g, '$1');
    s = s.replace(/\\([!-/:-@[-`{-~])/g, '$1'); // export가 이스케이프한 특수문자 복원
    return normalizeTocLine(s);
  }

  // md export의 #/##/### 개수가 정확한 헤딩 레벨이다.
  function parseMarkdownExportHeadings(markdown) {
    const lines = String(markdown || '').split('\n');
    const headings = [];
    let inFence = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (isFenceLine(line)) {
        inFence = !inFence;
        continue;
      }
      if (inFence) continue;
      const m = line.match(/^(#{1,6})\s+(\S.*)$/);
      if (!m) continue;
      const level = m[1].length;
      if (level > 5) continue;
      const text = cleanMarkdownHeadingText(m[2]);
      if (!text || isBadTocText(text)) continue;
      headings.push({ level, text, raw: line, line: i + 1 });
    }
    return { headings, lineCount: lines.length, source: 'md-export' };
  }

  function tocIndentPrefix(level) {
    return level <= 1 ? '' : '_'.repeat(level - 1);
  }

  function formatExtractedToc(title, result) {
    const lines = [];
    if (!result || !result.headings || !result.headings.length) {
      lines.push('목차를 찾지 못했습니다.');
      return lines.join('\n');
    }
    for (const h of result.headings) {
      const rawLevel = Math.max(1, Number(h.level) || 1);
      if (rawLevel > 5) continue;
      lines.push(tocIndentPrefix(Math.min(5, rawLevel)) + h.text);
    }
    return lines.join('\n');
  }

  function filterTocLevel(result, maxLevel) {
    const cap = Number.isFinite(Number(maxLevel)) && Number(maxLevel) >= 1 ? Math.min(5, Math.floor(Number(maxLevel))) : 5;
    return Object.assign({}, result, { headings: (result.headings || []).filter(h => Number(h.level) <= cap) });
  }

  // Google Docs PDF export의 쪽수. 루트 /Pages 노드의 /Count가 가장 크다.
  // 객체 스트림으로 압축된 PDF면 /Count가 안 보이므로 /Type /Page 객체 수로 대신 센다.
  function countPdfPages(bytes) {
    const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || 0);
    if (data.length < 5 || String.fromCharCode(data[0], data[1], data[2], data[3]) !== '%PDF') return null;
    let text = '';
    // 서비스워커는 호출 스택이 작아 apply 인자를 8KB씩만 넘긴다
    for (let i = 0; i < data.length; i += 8192) {
      text += String.fromCharCode.apply(null, data.subarray(i, i + 8192));
    }
    let best = 0;
    const re = /\/Type\s*\/Pages\b[^>]*?\/Count\s+(\d+)|\/Count\s+(\d+)[^>]*?\/Type\s*\/Pages\b/g;
    let m;
    while ((m = re.exec(text))) best = Math.max(best, Number(m[1] || m[2]) || 0);
    if (best > 0) return best;
    const pages = (text.match(/\/Type\s*\/Page(?![s\w])/g) || []).length;
    return pages || null;
  }

  // 바꿀 문구에서 원문과 같은 앞뒤를 덜어 실제로 달라지는 부분만 남긴다.
  // 구글 문서는 선택 영역을 새 글자로 덮어쓸 때 첫 글자의 서식을 따르므로, 범위를 넓게 잡으면
  // 그 안의 위첨자·아래첨자·굵게 같은 서식이 지워진다. 바뀌는 글자만 덮으면 나머지 서식은 그대로 남는다.
  function minimalEdit(src, dst, start) {
    src = String(src || '');
    dst = String(dst || '');
    start = Number(start) || 0;
    if (!src || src === dst) return { src, dst, start, end: start + src.length };
    const max = Math.min(src.length, dst.length);
    let p = 0;
    while (p < max && src[p] === dst[p]) p++;
    let q = 0;
    while (q < max - p && src[src.length - 1 - q] === dst[dst.length - 1 - q]) q++;
    // 서로게이트 쌍(이모지 등)을 가르지 않는다
    const isHigh = c => c >= 0xd800 && c <= 0xdbff;
    const isLow = c => c >= 0xdc00 && c <= 0xdfff;
    if (p > 0 && isHigh(src.charCodeAt(p - 1))) p--;
    if (q > 0 && isLow(src.charCodeAt(src.length - q))) q--;
    let s = src.slice(p, src.length - q);
    let d = dst.slice(p, dst.length - q);
    let at = start + p;
    if (!s) {
      // 순수 삽입: 덮어쓸 글자가 하나는 있어야 한다. 첨자일 가능성이 낮은 이웃(한글·공백·문장부호)을 고른다
      const right = q > 0 ? src[src.length - q] : '';
      const left = p > 0 ? src[p - 1] : '';
      const plain = c => !!c && !/[A-Za-z0-9]/.test(c);
      if (right && (plain(right) || !plain(left))) {
        s = right;
        d = d + right;
      } else if (left) {
        s = left;
        d = left + d;
        at -= 1;
      }
    }
    return { src: s, dst: d, start: at, end: at + s.length };
  }

  globalThis.ToytypeDocTools = {
    minimalEdit,
    normalizeTocLine,
    isFenceLine,
    isBadTocText,
    cleanMarkdownHeadingText,
    parseMarkdownExportHeadings,
    formatExtractedToc,
    filterTocLevel,
    countPdfPages
  };
})();
