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

  // ---------- 서식 점검 ----------
  // DOCX export의 문단·글자 서식을 요소(제목·본문·코드·노트·프롬프트·AI 답변·코너…)별로 정리하고,
  // 규칙으로 확실히 잡을 수 있는 불일치(크기·글꼴·코드 펜스·첨자·표기 변형)를 먼저 뽑는다.
  const MONO_FONT_RE = /mono|consol|courier|menlo|d2coding|source code|fira code|jetbrains|inconsolata|coding|ubuntu mono|monaco/i;
  const NOTE_RE = /^\s*(<\s*NOTE\s*>|\[\s*NOTE\s*\]|NOTE\b|Note\b|노트\b|TIP\b|Tip\b|팁\b|➝|→|💡)/;
  const PROMPT_RE = /^\s*(\[\s*프롬프트\s*\]|프롬프트\s*[:：]|\[\s*prompt\s*\]|prompt\s*[:：])/i;
  const AI_RE = /^\s*(\[\s*ai\s*\]|ai\s*[:：]|\[\s*답변\s*\])|\[\s*\/\s*ai\s*\]\s*$/i;
  const CORNER_RE = /^\s*\[([^\]\n]{1,24})\]/;
  const HEADING_PT = { h1: 25, h2: 16, h3: 14, h4: 12, h5: 10 };

  function summarizeDocxFormat(documentXml, stylesXml, Parser) {
    const P = Parser || globalThis.DOMParser;
    const parse = xml => new P().parseFromString(String(xml || ''), 'application/xml');
    const list = nodes => Array.prototype.slice.call(nodes || []);
    const attr = (node, name) => (node && node.getAttribute && node.getAttribute(name)) || '';
    const child = (node, tag) => node ? list(node.childNodes).find(n => n.nodeName === tag) || null : null;

    // 스타일: basedOn을 따라 글꼴·크기·굵게를 물려받는다
    const styles = new Map();
    let defaults = { font: '', size: 0 };
    if (stylesXml) {
      const sdoc = parse(stylesXml);
      const runProps = rPr => {
        if (!rPr) return {};
        const f = child(rPr, 'w:rFonts');
        const sz = child(rPr, 'w:sz');
        const b = child(rPr, 'w:b');
        return {
          font: f ? attr(f, 'w:ascii') || attr(f, 'w:hAnsi') || attr(f, 'w:eastAsia') : undefined,
          size: sz ? Number(attr(sz, 'w:val')) / 2 : undefined,
          bold: b ? attr(b, 'w:val') !== '0' && attr(b, 'w:val') !== 'false' : undefined
        };
      };
      const dd = list(sdoc.getElementsByTagName('w:rPrDefault'))[0];
      if (dd) {
        const r = runProps(child(dd, 'w:rPr'));
        defaults = { font: r.font || '', size: r.size || 0 };
      }
      for (const st of list(sdoc.getElementsByTagName('w:style'))) {
        const name = child(st, 'w:name');
        const based = child(st, 'w:basedOn');
        styles.set(attr(st, 'w:styleId'), Object.assign({ name: name ? attr(name, 'w:val') : '', basedOn: based ? attr(based, 'w:val') : '' }, runProps(child(st, 'w:rPr'))));
      }
    }
    const resolveStyle = id => {
      const out = { name: '', font: defaults.font, size: defaults.size, bold: false };
      const chain = [];
      for (let cur = styles.get(id), guard = 0; cur && guard < 10; cur = styles.get(cur.basedOn), guard++) chain.unshift(cur);
      for (const st of chain) {
        if (st.font) out.font = st.font;
        if (st.size) out.size = st.size;
        if (st.bold !== undefined) out.bold = st.bold;
      }
      const own = styles.get(id);
      out.name = own ? own.name : '';
      return out;
    };

    const paragraphs = [];
    const doc = parse(documentXml);
    let inFence = false;
    for (const p of list(doc.getElementsByTagName('w:p'))) {
      const pPr = child(p, 'w:pPr');
      const pStyle = pPr ? child(pPr, 'w:pStyle') : null;
      const styleId = pStyle ? attr(pStyle, 'w:val') : '';
      const base = resolveStyle(styleId);
      // 문단 기호의 글자 서식(pPr/rPr) — 구글 DOCX는 한글이 섞인 줄의 글자 단위 글꼴을 "Arial Unicode MS"로 내보내서
      // 실제 글꼴은 여기와 HTML에만 남는다
      const markRPr = pPr ? child(pPr, 'w:rPr') : null;
      const markFonts = markRPr ? child(markRPr, 'w:rFonts') : null;
      const markFont = markFonts ? attr(markFonts, 'w:ascii') || attr(markFonts, 'w:hAnsi') || attr(markFonts, 'w:eastAsia') : '';
      let text = '';
      const fontChars = new Map();
      const sizeChars = new Map();
      const scripts = [];
      for (const r of list(p.getElementsByTagName('w:r'))) {
        if (r.parentNode && r.parentNode.nodeName === 'w:del') continue;
        const t = list(r.childNodes).map(n => n.nodeName === 'w:t' ? n.textContent || '' : n.nodeName === 'w:tab' ? '\t' : '').join('');
        if (!t) continue;
        const rPr = child(r, 'w:rPr');
        const f = rPr ? child(rPr, 'w:rFonts') : null;
        const sz = rPr ? child(rPr, 'w:sz') : null;
        const va = rPr ? child(rPr, 'w:vertAlign') : null;
        let font = (f && (attr(f, 'w:ascii') || attr(f, 'w:hAnsi') || attr(f, 'w:eastAsia'))) || '';
        if (!font || font === 'Arial Unicode MS') font = markFont && markFont !== 'Arial Unicode MS' ? markFont : base.font || font || '';
        const size = sz ? Number(attr(sz, 'w:val')) / 2 : base.size;
        if (t.trim()) {
          // 글꼴은 한글이 아닌 글자로 정한다 — 코드 안 한글 주석은 한글 대체 글꼴로 찍혀 코드 글꼴을 가린다
          const latin = t.replace(/[가-힣ㄱ-ㅎㅏ-ㅣ\s]/g, '').length;
          if (latin) fontChars.set(font, (fontChars.get(font) || 0) + latin);
          sizeChars.set(size, (sizeChars.get(size) || 0) + t.length);
        }
        const v = va ? attr(va, 'w:val') : '';
        if (v === 'superscript' || v === 'subscript') scripts.push({ kind: v === 'superscript' ? 'sup' : 'sub', text: t, at: text.length });
        text += t;
      }
      const top = m => Array.from(m.entries()).sort((a, b) => b[1] - a[1])[0];
      const font = (top(fontChars) || [base.font])[0];
      const size = (top(sizeChars) || [base.size])[0];
      for (const sc of scripts) sc.context = text.slice(Math.max(0, sc.at - 10), sc.at) + '‹' + sc.text + '›' + text.slice(sc.at + sc.text.length, sc.at + sc.text.length + 10);
      let inTable = false;
      for (let a = p.parentNode; a; a = a.parentNode) if (a.nodeName === 'w:tc') { inTable = true; break; }
      const styleName = base.name || styleId;
      const headingMatch = /^heading\s*(\d)$/i.exec(styleName) || /^Heading(\d)$/.exec(styleId);
      const fence = /^\s*```/.test(text);
      let kind = 'body';
      if (fence) { kind = 'fence'; inFence = !inFence; }
      else if (!text.trim()) kind = 'empty'; // 코드 블록 안 빈 줄도 크기·글꼴 비교에서 뺀다
      else if (inFence || MONO_FONT_RE.test(font)) kind = 'code';
      else if (headingMatch) kind = 'h' + headingMatch[1];
      else if (/^title$/i.test(styleName)) kind = 'title';
      else if (PROMPT_RE.test(text)) kind = 'prompt';
      else if (AI_RE.test(text)) kind = 'ai';
      else if (NOTE_RE.test(text)) kind = 'note';
      else if (CORNER_RE.test(text)) kind = 'corner';
      else if (!text.trim()) kind = 'empty';
      paragraphs.push({ i: paragraphs.length, kind, style: styleName, font, size, inTable, text, scripts, list: !!(pPr && child(pPr, 'w:numPr')) });
    }
    return { paragraphs, unclosedFence: inFence };
  }

  // HTML export로 서식을 읽는다. DOCX는 한글이 섞인 줄의 글자 단위 글꼴을 자리표시용 글꼴로 내보내 믿을 수 없지만,
  // HTML은 화면에 그려지는 글꼴·크기·첨자를 클래스 CSS로 그대로 담는다. 결과 모양은 summarizeDocxFormat과 같다.
  function summarizeHtmlFormat(html, Parser) {
    const P = Parser || globalThis.DOMParser;
    const doc = new P().parseFromString(String(html || ''), 'text/html');
    const list = nodes => Array.prototype.slice.call(nodes || []);
    const css = list(doc.getElementsByTagName('style')).map(st => st.textContent || '').join('\n');
    const propsOf = body => {
      const out = {};
      const ff = /font-family:\s*([^;]+)/.exec(body);
      if (ff) out.font = ff[1].split(',')[0].replace(/["']/g, '').trim();
      const fs = /font-size:\s*([\d.]+)pt/.exec(body);
      if (fs) out.size = Number(fs[1]);
      const va = /vertical-align:\s*(super|sub)/.exec(body);
      if (va) out.va = va[1];
      return out;
    };
    const classProps = new Map();
    const tagProps = new Map();
    const ruleRe = /([^{}]+)\{([^}]*)\}/g;
    let m;
    while ((m = ruleRe.exec(css))) {
      for (const sel of m[1].split(',').map(x => x.trim())) {
        const cm = /^\.([\w-]+)$/.exec(sel);
        if (cm) classProps.set(cm[1], Object.assign(classProps.get(cm[1]) || {}, propsOf(m[2])));
        const tm = /^(p|li|h[1-6])$/.exec(sel);
        if (tm) tagProps.set(tm[1], Object.assign(tagProps.get(tm[1]) || {}, propsOf(m[2])));
      }
    }
    const propsFor = el => {
      const out = {};
      for (const c of String(el.getAttribute && el.getAttribute('class') || '').split(/\s+/)) {
        if (classProps.has(c)) Object.assign(out, classProps.get(c));
      }
      return out;
    };
    const blocks = [];
    const BLOCK = /^(p|li|h[1-6])$/i;
    // 문서 끝에 붙는 댓글·각주 본문(div 안, a#cmnt1·a#ftnt1로 시작)은 본문이 아니다
    const skipBoxes = new Set();
    for (const a of list(doc.getElementsByTagName('a'))) {
      if (!/^(cmnt|ftnt)\d+$/.test(String(a.getAttribute('id') || ''))) continue;
      for (let up = a.parentNode; up; up = up.parentNode) {
        if (up.nodeName && up.nodeName.toLowerCase() === 'div') { skipBoxes.add(up); break; }
        if (up.nodeName && up.nodeName.toLowerCase() === 'body') { if (a.parentNode) skipBoxes.add(a.parentNode); break; }
      }
    }
    const walk = node => {
      for (const ch of list(node.childNodes)) {
        if (ch.nodeType !== 1 || skipBoxes.has(ch)) continue;
        if (BLOCK.test(ch.nodeName)) blocks.push(ch);
        else walk(ch);
      }
    };
    const body = doc.getElementsByTagName('body')[0] || doc.documentElement;
    walk(body);

    const paragraphs = [];
    let inFence = false;
    for (const b of blocks) {
      const tag = b.nodeName.toLowerCase();
      const blockProps = Object.assign({}, tagProps.get(tag) || {}, propsFor(b));
      const spans = list(b.getElementsByTagName('span'));
      const parts = spans.length ? spans.filter(sp => !list(sp.getElementsByTagName('span')).length) : [b];
      let text = '';
      const fontChars = new Map();
      const sizeChars = new Map();
      const scripts = [];
      for (const sp of parts) {
        const t = (sp.textContent || '').replace(/ /g, ' ');
        if (!t) continue;
        const pr = Object.assign({}, blockProps, sp === b ? {} : propsFor(sp));
        if (t.trim()) {
          const latin = t.replace(/[가-힣ㄱ-ㅎㅏ-ㅣ\s]/g, '').length;
          if (latin && pr.font) fontChars.set(pr.font, (fontChars.get(pr.font) || 0) + latin);
          if (pr.size) sizeChars.set(pr.size, (sizeChars.get(pr.size) || 0) + t.length);
        }
        if (pr.va) scripts.push({ kind: pr.va === 'super' ? 'sup' : 'sub', text: t, at: text.length });
        text += t;
      }
      const top = mm => { const e = Array.from(mm.entries()).sort((a, c) => c[1] - a[1])[0]; return e ? e[0] : undefined; };
      const font = top(fontChars) || blockProps.font || '';
      const size = top(sizeChars) || blockProps.size || 0;
      for (const sc of scripts) sc.context = text.slice(Math.max(0, sc.at - 10), sc.at) + '‹' + sc.text + '›' + text.slice(sc.at + sc.text.length, sc.at + sc.text.length + 10);
      let inTable = false;
      for (let a = b.parentNode; a; a = a.parentNode) if (a.nodeName && a.nodeName.toLowerCase() === 'td') { inTable = true; break; }
      const cls = String(b.getAttribute('class') || '');
      const fence = /^\s*```/.test(text);
      let kind = 'body';
      if (fence) { kind = 'fence'; inFence = !inFence; }
      else if (!text.trim()) kind = 'empty';
      else if (inFence || MONO_FONT_RE.test(font)) kind = 'code';
      else if (/^h[1-6]$/.test(tag)) kind = tag;
      else if (/\btitle\b/.test(cls)) kind = 'title';
      else if (PROMPT_RE.test(text)) kind = 'prompt';
      else if (AI_RE.test(text)) kind = 'ai';
      else if (NOTE_RE.test(text)) kind = 'note';
      else if (CORNER_RE.test(text)) kind = 'corner';
      paragraphs.push({ i: paragraphs.length, kind, style: /^h[1-6]$/.test(tag) ? tag : '', font, size, inTable, text, scripts, list: tag === 'li' });
    }
    return { paragraphs, unclosedFence: inFence };
  }

  // 규칙으로 잡는 불일치. at은 문단 번호(위치 이동은 그 문단 글자로 찾는다)
  function formatRuleFindings(summary) {
    const ps = summary.paragraphs.filter(p => p.kind !== 'empty');
    const out = [];
    // fix: [적용]으로 고칠 방법(fontSize·fontFamily·script) / edit: 글자 바꾸기(src → dst)
    const add = (p, category, issue, suggestion, extra) => out.push(Object.assign({ at: p ? p.i : -1, category, issue, suggestion, text: p ? p.text.slice(0, 80) : '' }, extra || {}));
    const modeOf = (items, key) => {
      const m = new Map();
      for (const p of items) m.set(p[key], (m.get(p[key]) || 0) + Math.max(1, p.text.length));
      const best = Array.from(m.entries()).sort((a, b) => b[1] - a[1])[0];
      return best ? best[0] : undefined;
    };
    const byKind = k => ps.filter(p => p.kind === k);
    const body = byKind('body').filter(p => !p.inTable);
    const bodySize = modeOf(body, 'size');
    const bodyFont = modeOf(body, 'font');

    // 같은 요소인데 크기·글꼴이 다른 문단(소수파)
    const outliers = (items, label, key, unit) => {
      items = items.filter(p => key !== 'size' || p.size > 0); // 크기를 알 수 없는 문단은 빼고 본다
      if (items.length < 3) return;
      const mode = modeOf(items, key);
      const odd = items.filter(p => p[key] !== mode);
      if (!odd.length || odd.length > items.length / 2) return;
      const what = key === 'size' ? '크기가' : '글꼴이';
      for (const p of odd.slice(0, 12)) add(p, '서식', label + ' ' + what + ' 다릅니다 (' + p[key] + unit + ')', '다른 ' + label + '처럼 ' + mode + unit + (unit ? '로' : '(으)로') + ' 맞추세요', { fix: key === 'size' ? { type: 'fontSize', value: mode } : { type: 'fontFamily', value: mode } });
      if (odd.length > 12) add(null, '서식', label + ' ' + what + ' 다른 곳이 ' + (odd.length - 12) + '곳 더 있습니다', '');
    };
    outliers(body, '본문', 'size', 'pt');
    outliers(body, '본문', 'font', '');
    outliers(byKind('code'), '코드', 'size', 'pt');
    outliers(byKind('note'), '노트', 'size', 'pt');

    // 노트(팁)는 본문보다 작게
    const notes = byKind('note');
    const noteSize = modeOf(notes, 'size');
    if (notes.length && bodySize && noteSize >= bodySize) add(notes[0], '서식', '노트가 본문(' + bodySize + 'pt)보다 작지 않습니다 (' + noteSize + 'pt)', '노트·팁은 본문보다 작은 글자로 두세요');
    // 코드는 고정폭 글꼴, 펜스는 짝이 맞게
    const codeFont = modeOf(byKind('code').filter(p => MONO_FONT_RE.test(p.font)), 'font');
    for (const p of byKind('code').filter(p => !MONO_FONT_RE.test(p.font)).slice(0, 10)) add(p, '서식', '코드 줄이 고정폭 글꼴이 아닙니다 (' + (p.font || '기본') + ')', '코드 블록 글꼴' + (codeFont ? '(' + codeFont + ')' : '') + '로 맞추세요', codeFont ? { fix: { type: 'fontFamily', value: codeFont } } : null);
    if (summary.unclosedFence) add(null, '서식', '``` 코드 펜스가 열리고 닫히지 않았습니다', '마지막 코드 블록 끝에 ```를 넣으세요');
    // 제목은 프리셋 크기
    for (const p of ps.filter(p => HEADING_PT[p.kind] && p.size && p.size !== HEADING_PT[p.kind]).slice(0, 10)) add(p, '서식', '제목 ' + p.kind.slice(1) + ' 크기가 ' + p.size + 'pt입니다', '단락 스타일 셋팅 기준 ' + HEADING_PT[p.kind] + 'pt로 맞추세요', { fix: { type: 'fontSize', value: HEADING_PT[p.kind] } });

    // 첨자: 한글·공백이 첨자로 올라간 곳, 첨자로 써야 할 것 같은데 그냥 쓴 곳
    for (const p of ps) {
      for (const sc of p.scripts) {
        // 공백만 첨자인 것은 보이지 않으니 넘어가고, 한글이 첨자로 올라간 것만 잡는다(원어 병기 위첨자는 정상)
        if (/[가-힣]/.test(sc.text)) add(p, '첨자', (sc.kind === 'sup' ? '위첨자' : '아래첨자') + '로 잘못 올라간 한글: ' + sc.context, '첨자 서식을 풀어 주세요', { quote: p.text.slice(Math.max(0, sc.at - 4), sc.at + sc.text.length), fix: { type: 'script', kind: sc.kind, text: sc.text, off: sc.at } });
      }
      const plain = [];
      const re = /O\([^)\n]*?[a-zA-Z]([2-9])\)|\b(?:cm|mm|km|m)([23])\b|\b[a-zA-Z]\^\(?[0-9a-z]+\)?|\b\d+\^\(?[0-9a-z]+\)?/g;
      let m;
      while ((m = re.exec(p.text)) && plain.length < 3) {
        const at = m.index;
        // 이미 첨자로 된 글자면 건너뛴다
        if (p.scripts.some(sc => at <= sc.at && sc.at < at + m[0].length)) continue;
        plain.push(m[0]);
      }
      for (const t of plain) {
        // 위첨자로 올릴 글자: O(n2)의 2, cm2의 2, n^2의 2(^는 그대로 두고 판단은 사람에게)
        const m2 = /^(?:O\([^)]*?[a-zA-Z]|(?:cm|mm|km|m))([0-9])\)?$/.exec(t);
        const off = m2 ? p.text.indexOf(t) + t.lastIndexOf(m2[1]) : -1;
        add(p, '첨자', '첨자로 써야 할 수 있는 표기: ' + t, '지수·단위는 위첨자로 쓰거나 표기를 확인하세요', Object.assign({ quote: t }, m2 && off >= 0 ? { fix: { type: 'script', kind: 'sup', text: m2[1], off, on: true } } : {}));
      }
    }

    // 표기 변형: 같은 요소를 여러 방식으로 쓰고 있으면 알린다
    const variants = (label, items, keyOf) => {
      const m = new Map();
      for (const p of items) {
        const k = keyOf(p);
        if (!k) continue;
        if (!m.has(k)) m.set(k, []);
        m.get(k).push(p);
      }
      if (m.size < 2) return;
      const sorted = Array.from(m.entries()).sort((a, b) => b[1].length - a[1].length);
      const main = sorted[0][0];
      for (const [k, list] of sorted.slice(1)) {
        for (const p of list.slice(0, 6)) {
          // 머리 표기만 다른 것은 글자 바꾸기로 바로 고친다(문단 앞쪽의 원래 철자 그대로)
          const raw = (p.text.match(new RegExp(k.split('').map(ch => ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s*'))) || [])[0];
          add(p, '표기', label + ' 표기가 섞여 있습니다: “' + k + '” (대부분은 “' + main + '”)', '“' + main + '”로 통일하세요', raw ? { edit: { src: raw, dst: main } } : null);
        }
      }
    };
    const head = (re, p) => { const m = re.exec(p.text); return m ? m[1].replace(/\s+/g, '') : ''; };
    variants('노트', notes, p => head(NOTE_RE, p));
    variants('프롬프트', byKind('prompt'), p => head(PROMPT_RE, p));
    variants('AI 답변', byKind('ai'), p => { const m = AI_RE.exec(p.text); return m ? (m[1] || m[0]).replace(/\s+/g, '') : ''; });
    // 화살표: ptr->score, (x) => y 같은 코드 연산자는 빼고 본문 화살표만 본다
    const ARROW_RE = /→|⇒|(?<![\w)\]])\s*->\s*(?![\w(])|(?<![\w)\]])\s*=>\s*(?![\w(])|\s->\s|\s=>\s/;
    const arrows = ps.filter(p => p.kind !== 'code' && p.kind !== 'fence' && ARROW_RE.test(p.text.replace(/\w+->\w+/g, '')));
    for (const p of arrows.slice(0, 10)) {
      const arrow = (p.text.replace(/\w+->\w+/g, '').match(/→|⇒|->|=>/) || [''])[0];
      add(p, '표기', '화살표가 ➝가 아닙니다: ' + arrow, '➝로 통일하세요', arrow ? { edit: { src: arrow, dst: '➝' } } : null);
    }
    return out;
  }

  // AI에게 보낼 문서 서식 요약(문단마다 한 줄). 코드 블록은 첫 줄과 줄 수만 남긴다.
  function formatTranscript(summary, from, to) {
    const lines = [];
    const ps = summary.paragraphs;
    for (let k = from; k < Math.min(to, ps.length); k++) {
      const p = ps[k];
      if (p.kind === 'empty') continue;
      if (p.kind === 'code') {
        let n = 1;
        while (ps[k + n] && ps[k + n].kind === 'code') n++;
        lines.push('#' + p.i + ' [code ' + p.size + 'pt ' + p.font + ', ' + n + ' lines] ' + p.text.slice(0, 80));
        k += n - 1;
        continue;
      }
      const tags = [p.kind, p.style && p.style !== 'Normal' ? p.style : '', p.size ? p.size + 'pt' : '', p.font || '', p.inTable ? 'box/table' : '', p.list ? 'list' : ''].filter(Boolean).join(' ');
      // 첨자는 본문 안에 ^(위첨자) _(아래첨자)로 표시한다 — 이미 첨자인 글자를 AI가 "첨자가 아니다"라고 오탐하지 않게
      let marked = '';
      let last = 0;
      for (const sc of p.scripts) {
        if (sc.at < last) continue;
        marked += p.text.slice(last, sc.at) + (sc.kind === 'sup' ? '^(' : '_(') + sc.text + ')';
        last = sc.at + sc.text.length;
      }
      marked += p.text.slice(last);
      lines.push('#' + p.i + ' [' + tags + '] ' + marked.replace(/\s+/g, ' ').slice(0, 260));
    }
    return lines.join('\n');
  }

  globalThis.ToytypeDocTools = {
    summarizeHtmlFormat,
    summarizeDocxFormat,
    formatRuleFindings,
    formatTranscript,
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
