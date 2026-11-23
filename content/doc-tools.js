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
    // 순수 삽입(덮을 글자 없음)이나 순수 삭제(넣을 글자 없음)는 문서에 글자를 "입력"하는 방식으로 처리할 수 없다.
    // 이웃 글자 하나를 같이 덮어 입력할 글자가 생기게 한다. 첨자일 가능성이 낮은 이웃(한글·공백·문장부호)을 고른다.
    if (!s || !d) {
      const right = q > 0 ? src[src.length - q] : '';
      const left = p > 0 ? src[p - 1] : '';
      const plain = c => !!c && !/[A-Za-z0-9]/.test(c);
      if (right && (plain(right) || !plain(left))) {
        s = s + right;
        d = d + right;
      } else if (left) {
        s = left + s;
        d = left + d;
        at -= 1;
      }
    }
    return { src: s, dst: d, start: at, end: at + s.length };
  }

  // DOCX export에서 댓글과 제안(변경 내용 추적)을 뽑는다. 구글 문서는 본문을 캔버스에 그려서
  // 댓글이 걸린 문구(앵커)와 앞뒤 문맥은 화면 DOM에 없다 — export의 commentRange·w:ins·w:del에서 읽는다.
  // Parser: 브라우저는 DOMParser, Node 테스트는 @xmldom/xmldom의 DOMParser를 넘긴다.
  function parseDocxReview(documentXml, commentsXml, Parser) {
    const P = Parser || globalThis.DOMParser;
    const parse = xml => new P().parseFromString(String(xml || ''), 'application/xml');
    const list = nodes => Array.prototype.slice.call(nodes || []);
    const attr = (node, name) => (node.getAttribute && node.getAttribute(name)) || '';
    const textOf = (node, tag) => list(node.getElementsByTagName(tag)).map(t => t.textContent || '').join('');

    const comments = new Map();
    if (commentsXml) {
      for (const c of list(parse(commentsXml).getElementsByTagName('w:comment'))) {
        const id = attr(c, 'w:id');
        const text = list(c.getElementsByTagName('w:p')).map(p => textOf(p, 'w:t')).join('\n').trim();
        comments.set(id, { id, author: attr(c, 'w:author'), date: attr(c, 'w:date'), text, anchor: '', context: '' });
      }
    }

    const suggestions = [];
    const open = new Set();
    const doc = parse(documentXml);
    for (const p of list(doc.getElementsByTagName('w:p'))) {
      let marked = ''; // 제안을 ⟦-지움⟧⟦+넣음⟧으로 표시한 문단
      let plain = ''; // 지운 글자도 남긴 문단(문서 모델 본문과 가깝다)
      const touched = new Set(open);
      const local = [];
      const addText = t => {
        marked += t;
        plain += t;
        for (const id of open) { const c = comments.get(id); if (c) c.anchor += t; }
      };
      const walk = node => {
        for (const ch of list(node.childNodes)) {
          const n = ch.nodeName;
          if (n === 'w:p') continue; // 문단 안 문단(글상자)은 따로 돈다
          if (n === 'w:commentRangeStart') { open.add(attr(ch, 'w:id')); touched.add(attr(ch, 'w:id')); continue; }
          if (n === 'w:commentRangeEnd') { open.delete(attr(ch, 'w:id')); continue; }
          if (n === 'w:ins' || n === 'w:del') {
            const kind = n === 'w:ins' ? 'insert' : 'delete';
            const t = textOf(ch, kind === 'insert' ? 'w:t' : 'w:delText');
            if (t) {
              const author = attr(ch, 'w:author');
              const last = local[local.length - 1];
              // 같은 사람이 바로 붙여 지우고 넣은 것은 한 건의 "바꾸기"다
              if (last && last.author === author && last.end === marked.length && last.kind !== kind && last.kind !== 'replace') {
                last.kind = 'replace';
                if (kind === 'insert') last.inserted = t; else last.deleted = t;
              } else {
                local.push({ kind, author, date: attr(ch, 'w:date'), inserted: kind === 'insert' ? t : '', deleted: kind === 'delete' ? t : '', at: marked.length, end: 0 });
              }
              marked += kind === 'insert' ? '⟦+' + t + '⟧' : '⟦-' + t + '⟧';
              plain += t;
              local[local.length - 1].end = marked.length;
            }
            continue;
          }
          if (n === 'w:t') { addText(ch.textContent || ''); continue; }
          if (n === 'w:tab') { addText('\t'); continue; }
          if (n === 'w:br') { addText('\n'); continue; }
          if (n === 'w:delText' || n === 'w:instrText') continue;
          if (ch.childNodes && ch.childNodes.length) walk(ch);
        }
      };
      walk(p);
      for (const id of touched) {
        const c = comments.get(id);
        if (c && !c.context) c.context = plain.slice(0, 600);
      }
      for (const s of local) {
        const from = Math.max(0, s.at - 200);
        suggestions.push({ kind: s.kind, author: s.author, date: s.date, inserted: s.inserted, deleted: s.deleted, context: marked.slice(from, s.end + 200) });
      }
    }
    for (const c of comments.values()) c.anchor = c.anchor.slice(0, 400);
    return { comments: Array.from(comments.values()), suggestions };
  }

  globalThis.ToytypeDocTools = {
    parseDocxReview,
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
