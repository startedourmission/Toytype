// Toytype Google Docs -> HWPX exporter.
// Runs entirely in the extension content script: no local bridge and no DOCX round-trip.
'use strict';
(() => {
  const FETCH_TIMEOUT = 180000;
  const HWPX_MIME = 'application/hwp+zip';
  const NS_SECTION = 'http://www.hancom.co.kr/hwpml/2011/section';
  const NS_PARA = 'http://www.hancom.co.kr/hwpml/2011/paragraph';
  const NS_HEAD = 'http://www.hancom.co.kr/hwpml/2011/head';
  const NS_OPF = 'http://www.idpf.org/2007/opf/';
  const NS_HPF = 'http://www.hancom.co.kr/schema/2011/hpf';
  const NS_OCF = 'urn:oasis:names:tc:opendocument:xmlns:container';

  const CHAR_NORMAL = 0;
  const CHAR_BOLD = 1;
  const CHAR_ITALIC = 2;
  const CHAR_BOLD_ITALIC = 3;
  const CHAR_CODE = 4;
  const CHAR_H1 = 5;
  const CHAR_H2 = 6;
  const CHAR_H3 = 7;
  const CHAR_H4 = 8;
  const CHAR_TABLE_HEAD = 9;
  const CHAR_TABLE_BODY = 10;
  const CHAR_CALLOUT = 11;
  const CHAR_CALLOUT_HEAD = 12;
  const CHAR_FOOTNOTE = 13;
  const CHAR_SUPER = 14;
  const CHAR_ACCENT = 15;
  const CHAR_HIGHLIGHT = 16;

  const PARA_NORMAL = 0;
  const PARA_H1 = 1;
  const PARA_H2 = 2;
  const PARA_H3 = 3;
  const PARA_H4 = 4;
  const PARA_LIST = 5;
  const PARA_CODE = 6;
  const PARA_TABLE_HEAD = 7;
  const PARA_TABLE_BODY = 8;
  const PARA_CALLOUT = 9;
  const PARA_CALLOUT_HEAD = 10;
  const PARA_FOOTNOTE = 11;

  const STYLE_BASE = 0;
  const STYLE_CODE = 6;
  const STYLE_TABLE_HEAD = 13;
  const STYLE_TABLE_BODY = 14;
  const STYLE_CALLOUT = 36;
  const STYLE_CALLOUT_HEAD = 37;
  const STYLE_H2_BAR = 45;
  const STYLE_H3 = 47;
  const STYLE_LIST = 50;
  const STYLE_H4 = 56;
  const STYLE_H1 = 58;
  const STYLE_BODY = 61;
  const STYLE_FOOTNOTE = 72;

  const FONT_HAMCHO_BATANG = 0;
  const FONT_HAMCHO_DOTUM = 1;
  const FONT_HY_GOTHIC = 2;
  const FONT_NANUM_SQUARE_EXTRABOLD = 3;
  const FONT_D2CODING = 4;
  const FONT_PRETENDARD_MEDIUM = 5;
  const FONT_KOPUB_BATANG_LIGHT = 6;
  const FONT_KOPUB_DODUM_BOLD = 7;
  const FONT_KOPUB_DODUM_MEDIUM = 8;
  const FONT_KOPUB_BATANG_PRO_MEDIUM = 9;
  const FONT_KOPUB_DODUM_PRO_LIGHT = 10;

  const BORDER_PAGE = 1;
  const BORDER_TEXT = 2;
  const BORDER_TABLE = 3;
  const BORDER_TABLE_HEAD = 4;
  const BORDER_TABLE_STUB = 5;
  const BORDER_CODE_GUTTER = 6;
  const BORDER_CODE_BODY = 7;
  const BORDER_CALLOUT = 8;
  const BORDER_HIGHLIGHT = 9;

  const BODY_WIDTH = 42520;
  const TABLE_CELL_MARGIN = 498;
  const TABLE_CELL_TEXT_INSET = 1020;
  const DEFAULT_IMAGE_WIDTH = 24000;
  const DEFAULT_IMAGE_HEIGHT = 12000;
  const MAX_IMAGE_WIDTH = BODY_WIDTH;
  const DEFAULT_EQUATION_BASE_UNIT = 900;
  const MIN_EQUATION_WIDTH = 525;
  const MAX_EQUATION_WIDTH = BODY_WIDTH;
  const PRV_IMAGE_PNG = new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
    0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x04, 0x00, 0x00, 0x00, 0xb5, 0x1c, 0x0c, 0x02, 0x00, 0x00, 0x00,
    0x0b, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x64, 0x60, 0x00, 0x00,
    0x00, 0x05, 0x00, 0x01, 0x6f, 0x68, 0x67, 0xbc, 0x00, 0x00, 0x00, 0x00,
    0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82
  ]);
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8');
  let crc32TableCache = null;
  let paragraphId = 3121190000;

  async function exportGoogleDoc(options) {
    const docId = options && options.docId ? String(options.docId) : '';
    if (!docId) throw new Error('document id unavailable');
    const progress = typeof options.onProgress === 'function' ? options.onProgress : () => {};

    progress('HTML export downloading');
    const source = await fetchGoogleDocsHtmlSource(docId);
    progress('HTML parsing');
    const htmlDoc = new DOMParser().parseFromString(source.html, 'text/html');
    removeExportNoise(htmlDoc);

    progress('equations scanning');
    const equationHints = collectEquationHints(typeof document !== 'undefined' ? document : null);
    // Google Docs bakes native equations into flat PNG images for its HTML/Markdown
    // exports, so the only lossless source of the equation itself is the DOCX export,
    // whose word/document.xml keeps the equations as native OMML (<m:oMath>). We only
    // pay for that extra download when the HTML actually contains equation-like images.
    if (htmlHasEquationImages(htmlDoc)) {
      try {
        const omml = await fetchGoogleDocsOmmlScripts(docId);
        equationHints.push(...omml.map(script => ({ script, source: 'docx-omml' })));
      } catch (_) {
        // DOCX export is a best-effort source; fall back to the image otherwise.
      }
    }
    try {
      const markdown = await fetchGoogleDocsMarkdownSource(docId);
      equationHints.push(...collectMarkdownEquationHints(markdown));
    } catch (_) {
      // Markdown export is a best-effort extra source for Google Docs native equations.
    }
    equationHints.push(...collectEquationHints(htmlDoc));
    const equationRegistry = buildEquationRegistry(htmlDoc, equationHints);

    progress('images loading');
    const imageRegistry = await collectImages(htmlDoc, source, equationRegistry);

    progress('HWPX structure building');
    const blocks = htmlToBlocks(htmlDoc.body || htmlDoc.documentElement, { imageRegistry, equationRegistry });
    const normalizedBlocks = blocks.length ? blocks : [{ type: 'paragraph', runs: [{ text: '' }] }];
    const hwpx = buildHwpx(normalizedBlocks, {
      title: options.title || readHtmlTitle(htmlDoc) || docId,
      url: options.url || location.href,
      images: imageRegistry.images
    });
    return {
      fileName: safeFileName((options.title || readHtmlTitle(htmlDoc) || docId) + '.hwpx'),
      bytes: hwpx,
      stats: {
        source: source.source,
        blockCount: normalizedBlocks.length,
        equationCount: equationRegistry.count,
        imageCount: imageRegistry.images.length,
        skippedImageCount: imageRegistry.skipped
      }
    };
  }

  async function fetchGoogleDocsMarkdownSource(docId) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
    try {
      const res = await fetch(googleDocsExportUrl(docId, 'md'), { signal: ctrl.signal });
      if (!res.ok) throw new Error('md export http ' + res.status);
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (ct.indexOf('text/html') !== -1) throw new Error('md export content-type: ' + ct);
      const text = await res.text();
      return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    } finally {
      clearTimeout(timer);
    }
  }

  function htmlHasEquationImages(doc) {
    if (!doc || typeof doc.querySelectorAll !== 'function') return false;
    for (const img of Array.from(doc.querySelectorAll('img'))) {
      if (isLikelyEquationImage(img)) return true;
    }
    return false;
  }

  // Downloads the DOCX export and returns its equations as Hangul equation scripts,
  // in document order. Google Docs redirects the export to a googleusercontent host
  // that only allows credential-less CORS, so the request must omit credentials; the
  // one-time token in the redirect URL authorizes it. Only word/document.xml is
  // inflated — the bundled images and fonts (the bulk of the archive) are skipped.
  async function fetchGoogleDocsOmmlScripts(docId) {
    const buffer = await fetchArrayBuffer(googleDocsExportUrl(docId, 'docx'), { credentials: 'omit' });
    if (!looksLikeZip(buffer)) throw new Error('docx export is not a zip');
    const data = new Uint8Array(buffer);
    const entries = readZipEntries(data);
    const docEntry = entries.find(entry => normalizeZipPath(entry.name) === 'word/document.xml');
    if (!docEntry) throw new Error('word/document.xml missing from docx export');
    let bytes = data.slice(docEntry.dataStart, docEntry.dataStart + docEntry.compressedSize);
    if (docEntry.method === 8) bytes = await inflateRaw(bytes);
    else if (docEntry.method !== 0) throw new Error('unsupported docx compression method');
    const xml = decoder.decode(bytes);
    return extractOmmlEquationScripts(xml);
  }

  function extractOmmlEquationScripts(documentXml) {
    const scripts = [];
    const oMathRe = /<m:oMath\b[\s\S]*?<\/m:oMath>/g;
    let match;
    while ((match = oMathRe.exec(String(documentXml || '')))) {
      const script = ommlToEquationScript(match[0]);
      if (script) scripts.push(script);
    }
    return scripts;
  }

  function downloadBytes(fileName, bytes, mimeType) {
    const blob = new Blob([bytes], { type: mimeType || HWPX_MIME });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = safeFileName(fileName || 'document.hwpx');
    a.style.display = 'none';
    (document.body || document.documentElement).appendChild(a);
    a.click();
    setTimeout(() => {
      try { a.remove(); } catch (_) {}
      try { URL.revokeObjectURL(url); } catch (_) {}
    }, 1000);
  }

  async function fetchGoogleDocsHtmlSource(docId) {
    const zipUrl = googleDocsExportUrl(docId, 'zip');
    try {
      const zipBuffer = await fetchArrayBuffer(zipUrl);
      if (looksLikeZip(zipBuffer)) {
        const pkg = await readZipPackage(zipBuffer);
        const htmlEntry = findHtmlEntry(pkg);
        if (htmlEntry) {
          return {
            source: 'zip-html-export',
            html: decoder.decode(htmlEntry.data),
            baseUrl: zipUrl,
            htmlPath: htmlEntry.name,
            files: pkg.files
          };
        }
      }
    } catch (_) {
      // Google occasionally disables zipped HTML export for some accounts/docs.
    }

    const htmlUrl = googleDocsExportUrl(docId, 'html');
    const html = await fetchText(htmlUrl);
    return {
      source: 'html-export',
      html,
      baseUrl: htmlUrl,
      htmlPath: '',
      files: new Map()
    };
  }

  function googleDocsExportUrl(docId, format) {
    const account = location.pathname.match(/\/document\/u\/(\d+)\//);
    return 'https://docs.google.com/document/' + (account ? 'u/' + account[1] + '/' : '') +
      'd/' + encodeURIComponent(docId) + '/export?format=' + encodeURIComponent(format);
  }

  async function fetchArrayBuffer(url, opts) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
    try {
      const init = { signal: ctrl.signal };
      if (opts && opts.credentials) init.credentials = opts.credentials;
      const res = await fetch(url, init);
      if (!res.ok) throw new Error('export http ' + res.status);
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (ct.indexOf('text/html') !== -1) throw new Error('export content-type: ' + ct);
      return await res.arrayBuffer();
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchText(url) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error('html export http ' + res.status);
      const ct = (res.headers.get('content-type') || '').toLowerCase();
      if (ct.indexOf('text/html') === -1 && ct.indexOf('application/xhtml') === -1) {
        throw new Error('html export content-type: ' + ct);
      }
      const text = await res.text();
      return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    } finally {
      clearTimeout(timer);
    }
  }

  function removeExportNoise(doc) {
    for (const node of Array.from(doc.querySelectorAll('script, style, noscript'))) node.remove();
  }

  function readHtmlTitle(doc) {
    const title = doc.querySelector('title');
    return normalizeWhitespace(title ? title.textContent : '');
  }

  async function collectImages(doc, source, equationRegistry) {
    const images = [];
    const byElement = new Map();
    let skipped = 0;
    const nodes = Array.from(doc.querySelectorAll('img'));
    for (const node of nodes) {
      try {
        if (equationRegistry && equationRegistry.byElement && equationRegistry.byElement.has(node)) continue;
        const image = await resolveImage(node, source);
        if (!image) {
          skipped++;
          continue;
        }
        image.index = images.length + 1;
        image.binaryId = 'BIN' + String(image.index).padStart(4, '0');
        image.fileName = image.binaryId + '.' + image.ext;
        image.packagePath = 'BinData/' + image.fileName;
        images.push(image);
        byElement.set(node, image);
      } catch (_) {
        skipped++;
      }
    }
    return { images, byElement, skipped };
  }

  async function resolveImage(img, source) {
    const rawSrc = img.getAttribute('src') || '';
    if (!rawSrc) return null;
    let data = null;
    let mime = '';
    const dataUri = parseDataUri(rawSrc);
    if (dataUri) {
      data = dataUri.data;
      mime = dataUri.mime;
    } else {
      const zipData = resolveZipImage(rawSrc, source);
      if (zipData) {
        data = zipData.data;
        mime = zipData.mime || mimeFromPath(zipData.name);
      } else {
        const absolute = new URL(rawSrc, source.baseUrl || location.href).href;
        const res = await fetch(absolute);
        if (!res.ok) return null;
        data = new Uint8Array(await res.arrayBuffer());
        mime = res.headers.get('content-type') || mimeFromPath(rawSrc);
      }
    }
    if (!data || data.length === 0) return null;
    const ext = imageExt(mime, rawSrc, data);
    const dims = imageSizeFromElement(img, data);
    return {
      data,
      mime: mime || mimeFromExt(ext),
      ext,
      widthPx: dims.width,
      heightPx: dims.height,
      alt: img.getAttribute('alt') || img.getAttribute('title') || ''
    };
  }

  function resolveZipImage(src, source) {
    if (!source || !source.files || source.files.size === 0) return null;
    const htmlDir = source.htmlPath ? source.htmlPath.replace(/[^/]*$/, '') : '';
    const candidates = [
      normalizeZipPath(src),
      normalizeZipPath(decodeURIComponentSafe(src)),
      normalizeZipPath(htmlDir + src),
      normalizeZipPath(htmlDir + decodeURIComponentSafe(src))
    ];
    for (const key of candidates) {
      const item = source.files.get(key);
      if (item) return { name: item.name, data: item.data, mime: mimeFromPath(item.name) };
    }
    const base = normalizeZipPath(src).split('/').pop();
    if (!base) return null;
    for (const item of source.files.values()) {
      if (item.name.split('/').pop() === base) return { name: item.name, data: item.data, mime: mimeFromPath(item.name) };
    }
    return null;
  }

  function htmlToBlocks(root, ctx) {
    const blocks = [];
    for (const child of Array.from(root ? root.childNodes : [])) {
      appendNodeBlocks(child, blocks, ctx);
    }
    return compactBlocks(blocks);
  }

  function appendNodeBlocks(node, blocks, ctx) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = normalizeInlineText(node.nodeValue || '');
      if (text) blocks.push({ type: 'paragraph', runs: [{ text }] });
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node;
    const tag = el.tagName.toLowerCase();
    if (isFootnoteElement(el)) {
      appendFootnoteBlock(el, blocks, ctx);
      return;
    }
    if (tag === 'pre') {
      blocks.push(preToCodeBlock(el));
      return;
    }
    if (isCalloutElement(el)) {
      blocks.push(calloutToBlock(el, ctx));
      return;
    }
    if (tag === 'table') {
      blocks.push(tableToBlock(el, ctx));
      return;
    }
    if (tag === 'img') {
      const equation = ctx.equationRegistry && ctx.equationRegistry.byElement && ctx.equationRegistry.byElement.get(el) || equationFromElement(el);
      if (equation) {
        blocks.push({ type: 'paragraph', runs: [{ equation }] });
        return;
      }
      const image = ctx.imageRegistry.byElement.get(el);
      if (image) blocks.push({ type: 'paragraph', runs: [{ image }] });
      else appendAltText(el, blocks);
      return;
    }
    if (tag === 'hr') {
      blocks.push({ type: 'paragraph', runs: [{ text: '----------------------------------------' }] });
      return;
    }
    if (tag === 'ul' || tag === 'ol') {
      appendListBlocks(el, blocks, ctx, tag === 'ol', 0);
      return;
    }
    if (/^h[1-6]$/.test(tag)) {
      const runs = inlineRuns(el, baseInlineStyleFor(el), ctx);
      blocks.push({ type: 'heading', level: Math.min(4, Number(tag.slice(1)) || 1), runs });
      return;
    }
    if (tag === 'blockquote') {
      blocks.push(calloutToBlock(el, ctx));
      return;
    }
    if (tag === 'p' || (tag === 'div' && !hasBlockChild(el))) {
      const runs = inlineRuns(el, baseInlineStyleFor(el), ctx);
      if (runs.length) {
        blocks.push({ type: tag === 'blockquote' ? 'paragraph' : 'paragraph', runs });
      }
      return;
    }
    for (const child of Array.from(el.childNodes)) appendNodeBlocks(child, blocks, ctx);
  }

  function appendFootnoteBlock(el, blocks, ctx) {
    const runs = inlineRuns(el, Object.assign({}, baseInlineStyleFor(el), { footnote: true }), ctx);
    const cleaned = stripLeadingFootnoteBacklink(runs);
    if (cleaned.length) {
      blocks.push({ type: 'footnote', runs: cleaned });
      return;
    }
    const text = normalizeWhitespace(el.textContent || '');
    if (text) blocks.push({ type: 'footnote', runs: [{ text, footnote: true }] });
  }

  function stripLeadingFootnoteBacklink(runs) {
    const out = runs.map(run => isObjectRun(run) ? run : Object.assign({}, run));
    while (out.length && !isObjectRun(out[0])) {
      out[0].text = String(out[0].text || '').replace(/^\s*(?:\[\d+\]|\d+\.?)\s*/, '');
      if (out[0].text) break;
      out.shift();
    }
    return out;
  }

  function appendAltText(el, blocks) {
    const alt = normalizeWhitespace(el.getAttribute('alt') || el.getAttribute('title') || '');
    if (alt) blocks.push({ type: 'paragraph', runs: [{ text: alt }] });
  }

  function preToCodeBlock(el) {
    let text = typeof el.innerText === 'string' ? el.innerText : (el.textContent || '');
    text = String(text || '').replace(/\r\n?/g, '\n').replace(/\n+$/, '');
    return { type: 'code', text: text || ' ' };
  }

  function calloutToBlock(el, ctx) {
    const inner = [];
    for (const child of Array.from(el.childNodes || [])) appendNodeBlocks(child, inner, ctx);
    const blocks = inner.length ? inner : [{ type: 'paragraph', runs: inlineRuns(el, baseInlineStyleFor(el), ctx) }];
    return { type: 'callout', blocks: compactBlocks(blocks).map((block, index) => styleCalloutBlock(block, index === 0)) };
  }

  function styleCalloutBlock(block, head) {
    if (!block || block.type !== 'paragraph') return block;
    return Object.assign({}, block, {
      paraPrId: head ? PARA_CALLOUT_HEAD : PARA_CALLOUT,
      defaultCharPrId: head ? CHAR_CALLOUT_HEAD : CHAR_CALLOUT,
      styleId: head ? STYLE_CALLOUT_HEAD : STYLE_CALLOUT,
      runs: (block.runs || []).map(run => isObjectRun(run) ? run : Object.assign({}, run, head ? { accent: true } : {}))
    });
  }

  function appendListBlocks(listEl, blocks, ctx, ordered, depth) {
    let index = 1;
    for (const item of Array.from(listEl.children)) {
      if (item.tagName.toLowerCase() !== 'li') continue;
      const direct = document.createElement('span');
      for (const child of Array.from(item.childNodes)) {
        if (child.nodeType === Node.ELEMENT_NODE && ['ul', 'ol'].includes(child.tagName.toLowerCase())) continue;
        direct.appendChild(child.cloneNode(true));
      }
      const prefix = (ordered ? index + '. ' : '\u2219 ') + (depth > 0 ? '  '.repeat(depth) : '');
      const runs = [{ text: prefix, accent: true }].concat(inlineRuns(direct, {}, ctx));
      blocks.push({ type: 'paragraph', paraPrId: PARA_LIST, runs });
      for (const childList of Array.from(item.children).filter(n => ['ul', 'ol'].includes(n.tagName.toLowerCase()))) {
        appendListBlocks(childList, blocks, ctx, childList.tagName.toLowerCase() === 'ol', depth + 1);
      }
      index++;
    }
  }

  function tableToBlock(table, ctx) {
    const rows = [];
    const occupied = [];
    let rowIndex = 0;
    for (const tr of Array.from(table.querySelectorAll(':scope > tbody > tr, :scope > thead > tr, :scope > tr'))) {
      if (!rows[rowIndex]) rows[rowIndex] = [];
      let colIndex = 0;
      while (occupied[rowIndex] && occupied[rowIndex][colIndex]) colIndex++;
      for (const cell of Array.from(tr.children).filter(el => /^(td|th)$/i.test(el.tagName))) {
        while (occupied[rowIndex] && occupied[rowIndex][colIndex]) colIndex++;
        const colSpan = clampInt(cell.getAttribute('colspan'), 1, 1, 32);
        const rowSpan = clampInt(cell.getAttribute('rowspan'), 1, 1, 64);
        const cellBlocks = htmlToBlocks(cell, ctx);
        rows[rowIndex].push({
          rowAddr: rowIndex,
          colAddr: colIndex,
          colSpan,
          rowSpan,
          header: cell.tagName.toLowerCase() === 'th' || rowIndex === 0,
          blocks: cellBlocks.length ? cellBlocks : [{ type: 'paragraph', runs: [{ text: '' }] }]
        });
        for (let r = rowIndex; r < rowIndex + rowSpan; r++) {
          if (!occupied[r]) occupied[r] = [];
          for (let c = colIndex; c < colIndex + colSpan; c++) occupied[r][c] = true;
        }
        colIndex += colSpan;
      }
      rowIndex++;
    }
    const colCnt = occupied.reduce((max, row) => Math.max(max, row ? row.length : 0), 1);
    return { type: 'table', rows: rows.filter(Boolean), rowCnt: rows.length || 1, colCnt: Math.max(1, colCnt) };
  }

  function isFootnoteElement(el) {
    const id = String(el.id || el.getAttribute('id') || '').toLowerCase();
    const cls = String(el.className || el.getAttribute('class') || '').toLowerCase();
    return /^ftnt\d+/.test(id) || /\b(?:footnote|doc-footnote)\b/.test(cls);
  }

  function isCalloutElement(el) {
    const tag = el.tagName.toLowerCase();
    if (tag === 'aside') return true;
    const cls = String(el.className || el.getAttribute('class') || '').toLowerCase();
    if (/\b(?:callout|corner|note|tip|warning|notice|cheat|summary)\b/.test(cls)) return true;
    const style = String(el.getAttribute('style') || '').toLowerCase();
    if (/border-left\s*:|background(?:-color)?\s*:/.test(style) && hasBlockChild(el)) return true;
    return false;
  }

  function inlineRuns(node, inheritedStyle, ctx) {
    const runs = [];
    for (const child of Array.from(node.childNodes || [])) {
      appendInlineRuns(child, inheritedStyle || {}, runs, ctx);
    }
    return compactRuns(runs);
  }

  function appendInlineRuns(node, style, runs, ctx) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = normalizeInlineText(node.nodeValue || '');
      if (text) runs.push(Object.assign({ text }, style));
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node;
    const tag = el.tagName.toLowerCase();
    if (tag === 'br') {
      runs.push(Object.assign({ text: '\n' }, style));
      return;
    }
    if (tag === 'img') {
      const equation = ctx.equationRegistry && ctx.equationRegistry.byElement && ctx.equationRegistry.byElement.get(el) || equationFromElement(el);
      if (equation) {
        runs.push({ equation });
        return;
      }
      const image = ctx.imageRegistry.byElement.get(el);
      if (image) runs.push({ image });
      else {
        const alt = normalizeWhitespace(el.getAttribute('alt') || el.getAttribute('title') || '');
        if (alt) runs.push(Object.assign({ text: alt }, style));
      }
      return;
    }
    if (tag === 'table') return;
    const nextStyle = Object.assign({}, style, inlineStyleFor(el));
    if (tag === 'math') {
      const equation = equationFromElement(el);
      if (equation) runs.push({ equation });
      return;
    }
    for (const child of Array.from(el.childNodes)) appendInlineRuns(child, nextStyle, runs, ctx);
  }

  function baseInlineStyleFor(el) {
    return inlineStyleFor(el);
  }

  function inlineStyleFor(el) {
    const tag = el.tagName.toLowerCase();
    const style = {};
    if (tag === 'strong' || tag === 'b' || tag === 'th') style.bold = true;
    if (tag === 'em' || tag === 'i') style.italic = true;
    if (tag === 'code' || tag === 'kbd' || tag === 'samp') style.code = true;
    if (tag === 'sup') style.superscript = true;
    if (tag === 'mark') style.highlight = true;
    const inline = String(el.getAttribute('style') || '').toLowerCase();
    if (/font-weight\s*:\s*(bold|[6-9]00)/.test(inline)) style.bold = true;
    if (/font-style\s*:\s*italic/.test(inline)) style.italic = true;
    if (/text-decoration[^;]*underline/.test(inline) || tag === 'u') style.underline = true;
    if (/background(?:-color)?\s*:/.test(inline)) style.highlight = true;
    if (/color\s*:\s*(?:#(?:ff00ff|d000d0|c000c0)|rgb\(\s*255\s*,\s*0\s*,\s*255\s*\))/.test(inline)) style.accent = true;
    return style;
  }

  function hasBlockChild(el) {
    return Array.from(el.children).some(child => {
      const tag = child.tagName.toLowerCase();
      return /^(p|div|table|ul|ol|h[1-6]|blockquote|hr)$/.test(tag);
    });
  }

  function compactBlocks(blocks) {
    return blocks.filter(block => {
      if (!block) return false;
      if (block.type === 'table') return block.rows && block.rows.length;
      if (block.type === 'code') return String(block.text || '').trim();
      if (block.type === 'callout') return block.blocks && block.blocks.length;
      return block.runs && block.runs.some(run => isObjectRun(run) || String(run.text || '').trim());
    });
  }

  function compactRuns(runs) {
    const out = [];
    for (const run of runs) {
      if (!run) continue;
      if (isObjectRun(run)) {
        out.push(run);
        continue;
      }
      const text = String(run.text || '');
      if (!text) continue;
      const prev = out[out.length - 1];
      if (prev && !isObjectRun(prev) && sameRunStyle(prev, run)) {
        prev.text += text;
      } else {
        out.push(Object.assign({}, run, { text }));
      }
    }
    return out;
  }

  function sameRunStyle(a, b) {
    return !!a.bold === !!b.bold &&
      !!a.italic === !!b.italic &&
      !!a.code === !!b.code &&
      !!a.underline === !!b.underline &&
      !!a.superscript === !!b.superscript &&
      !!a.accent === !!b.accent &&
      !!a.highlight === !!b.highlight &&
      !!a.footnote === !!b.footnote;
  }

  function isObjectRun(run) {
    return !!(run && (run.image || run.equation));
  }

  function buildEquationRegistry(doc, hints) {
    const byElement = new Map();
    const images = doc && typeof doc.querySelectorAll === 'function' ? Array.from(doc.querySelectorAll('img')) : [];
    for (const image of images) {
      const direct = equationFromElement(image);
      if (direct) byElement.set(image, direct);
    }

    // OMML from the DOCX export is the authoritative, in-document-order list of the
    // document's native equations. When present, prefer it exclusively so the flat
    // PNG equation images map to their real equations by position; mixing it with the
    // lower-confidence DOM/Markdown hints would desync the ordering.
    const ommlHints = (hints || []).filter(hint => hint && typeof hint === 'object' && hint.source === 'docx-omml');
    const queue = normalizeEquationHints(ommlHints.length ? ommlHints : hints);
    if (queue.length) {
      const candidates = images.filter(image => !byElement.has(image) && isLikelyEquationImage(image));
      const fallbackAllImages = images.length === 1 && queue.length === 1 ? images.filter(image => !byElement.has(image)) : [];
      const targets = candidates.length ? candidates : fallbackAllImages;
      for (const image of targets) {
        if (!queue.length) break;
        byElement.set(image, queue.shift());
      }
    }
    return { byElement, count: byElement.size };
  }

  function normalizeEquationHints(hints) {
    const out = [];
    const seenObjects = new Set();
    for (const hint of hints || []) {
      if (!hint) continue;
      if (typeof hint === 'object' && hint.node) {
        if (seenObjects.has(hint.node)) continue;
        seenObjects.add(hint.node);
      }
      const raw = typeof hint === 'string' ? hint : (hint.script || hint.text || hint.value || '');
      const script = sanitizeEquationScript(raw);
      if (script) out.push({ script, baseUnit: DEFAULT_EQUATION_BASE_UNIT });
    }
    return out;
  }

  function collectEquationHints(root) {
    const hints = [];
    if (!root || typeof root.querySelectorAll !== 'function') return hints;
    const selectors = [
      'math',
      'script[type*="math" i]',
      'script[type*="tex" i]',
      '[role="math"]',
      '[data-latex]',
      '[data-tex]',
      '[data-math]',
      '[data-equation]',
      '[data-formula]',
      '[aria-label*="equation" i]',
      '[aria-label*="formula" i]',
      '[aria-label*="latex" i]',
      '[aria-label*="수식"]',
      '[class*="equation" i]',
      '[class*="math" i]',
      '[class*="latex" i]',
      '[class*="katex" i]',
      '[class*="mathjax" i]',
      '[id*="equation" i]',
      '[id*="math" i]',
      '[id*="latex" i]'
    ];
    const nodes = [];
    const seen = new Set();
    for (const selector of selectors) {
      try {
        for (const node of Array.from(root.querySelectorAll(selector))) {
          if (seen.has(node)) continue;
          seen.add(node);
          nodes.push(node);
        }
      } catch (_) {}
    }
    for (const node of nodes) {
      const equation = equationFromElement(node);
      if (equation) hints.push({ node, script: equation.script });
    }
    return hints;
  }

  function collectMarkdownEquationHints(markdown) {
    const hints = [];
    const text = String(markdown || '');
    const imageRe = /!\[([^\]]*)\]\(([^)]*)\)/g;
    let match;
    while ((match = imageRe.exec(text))) {
      const alt = normalizeWhitespace(match[1] || '');
      if (!alt || /^(?:image|그림|이미지|수식|equation|formula)$/i.test(alt)) continue;
      const script = formulaTextToEquationScript(alt);
      if (script) hints.push({ script });
    }
    const latexRe = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g;
    while ((match = latexRe.exec(text))) {
      const raw = match[1] || match[2] || '';
      if (!looksLikeFormulaText(raw)) continue;
      const script = formulaTextToEquationScript(raw);
      if (script) hints.push({ script });
    }
    return hints;
  }

  function isLikelyEquationImage(img) {
    if (!img || elementName(img) !== 'img') return false;
    if (isEquationLikeElement(img)) return true;
    const alt = normalizeWhitespace(img.getAttribute('alt') || img.getAttribute('title') || img.getAttribute('aria-label') || '');
    if (/^(?:equation|formula|math|수식)$/i.test(alt)) return true;
    // In the Google Docs HTML export, native equations are inline images with NO
    // explicit size and no transform (an empty style attribute), whereas real
    // figures/drawings carry an explicit "width: NNpx; height: NNpx; transform: ..."
    // style and a docs.google.com/drawings/ source. The image src is a relative
    // path (images/imageN.png) in the zipped export and a data: URI in the plain
    // HTML export, so key off the size/transform shape, not the src scheme.
    const src = String(img.getAttribute('src') || '');
    const style = String(img.getAttribute('style') || '').toLowerCase();
    if (/\/drawings\//.test(src) || /transform\s*:/.test(style)) return false;
    const size = readElementPixelSize(img);
    if (!size.width && !size.height) return true;
    const inline = isInlineImageContext(img);
    if (size.height && size.height <= 160 && (!size.width || size.width <= 1800)) return true;
    if (inline && (!size.height || size.height <= 220) && (!size.width || size.width <= 2200)) return true;
    return false;
  }

  function isInlineImageContext(img) {
    const style = String(img.getAttribute('style') || '').toLowerCase();
    if (/vertical-align|display\s*:\s*inline|baseline/.test(style)) return true;
    const parent = img.parentNode || img.parentElement;
    if (!parent || !parent.childNodes) return false;
    const siblings = Array.from(parent.childNodes);
    return siblings.some(node => node !== img && node.nodeType === 3 && normalizeWhitespace(node.nodeValue || ''));
  }

  function readElementPixelSize(el) {
    const style = el.getAttribute ? String(el.getAttribute('style') || '') : '';
    const width = parseCssPx(el.getAttribute && el.getAttribute('width')) ||
      parseCssPx((style.match(/(?:^|;)\s*width\s*:\s*([^;]+)/i) || [])[1]);
    const height = parseCssPx(el.getAttribute && el.getAttribute('height')) ||
      parseCssPx((style.match(/(?:^|;)\s*height\s*:\s*([^;]+)/i) || [])[1]);
    return { width, height };
  }

  function equationFromElement(el) {
    if (!el || !el.tagName) return null;
    const tag = elementName(el);
    let script = '';
    if (tag === 'math') {
      script = mathElementToEquationScript(el);
    } else if (tag === 'script' && /(?:math\/tex|latex|tex)/i.test(el.getAttribute('type') || '')) {
      script = formulaTextToEquationScript(el.textContent || '');
    } else {
      const annotated = equationAnnotationText(el);
      if (annotated) script = formulaTextToEquationScript(annotated);
      if (!script) {
        const attrText = equationAttributeText(el);
        if (attrText) script = formulaTextToEquationScript(attrText);
      }
      if (!script && tag !== 'img' && isEquationLikeElement(el)) {
        const text = normalizeWhitespace(el.textContent || '');
        if (looksLikeFormulaText(text)) script = formulaTextToEquationScript(text);
      }
    }
    script = sanitizeEquationScript(script);
    return script ? { script, baseUnit: DEFAULT_EQUATION_BASE_UNIT } : null;
  }

  function equationAnnotationText(el) {
    if (!el || typeof el.querySelectorAll !== 'function') return '';
    try {
      for (const node of Array.from(el.querySelectorAll('annotation'))) {
        const encoding = String(node.getAttribute('encoding') || node.getAttribute('type') || '').toLowerCase();
        if (/(?:tex|latex)/.test(encoding)) {
          const text = normalizeWhitespace(node.textContent || '');
          if (text) return text;
        }
      }
    } catch (_) {}
    return '';
  }

  function equationAttributeText(el) {
    const explicitAttrs = [
      'data-latex',
      'data-tex',
      'data-math',
      'data-equation',
      'data-formula',
      'data-value',
      'data-annotation',
      'data-alt'
    ];
    for (const name of explicitAttrs) {
      const value = normalizeWhitespace(el.getAttribute(name) || '');
      if (value && looksLikeFormulaText(value)) return value;
    }
    const tag = elementName(el);
    const implicitAttrs = tag === 'img' ? ['alt', 'title', 'aria-label'] : ['title', 'aria-label'];
    for (const name of implicitAttrs) {
      const value = normalizeWhitespace(el.getAttribute(name) || '');
      if (!value || /^(?:equation|formula|math|수식|이미지|그림)$/i.test(value)) continue;
      if ((tag === 'img' ? isEquationLikeElement(el) || looksLikeFormulaText(value) : looksLikeFormulaText(value))) {
        return value;
      }
    }
    return '';
  }

  function isEquationLikeElement(el) {
    const fields = [
      el.getAttribute('class') || '',
      el.getAttribute('id') || '',
      el.getAttribute('role') || '',
      el.getAttribute('type') || '',
      el.getAttribute('src') || ''
    ].join(' ').toLowerCase();
    return /\b(?:math|mathml|equation|formula|latex|tex|katex|mathjax|codecogs|wiris)\b/.test(fields);
  }

  function looksLikeFormulaText(text) {
    const value = stripMathDelimiters(decodeXmlText(text));
    if (!value || value.length > 1200) return false;
    if (/\\(?:frac|sqrt|sum|int|begin|alpha|beta|gamma|delta|mu|chi|leq|geq|neq|pm|times|left|right)\b/.test(value)) return true;
    if (/[α-ωΑ-Ω∑∏∫√≤≥≠∞±×÷→←↔]/.test(value)) return true;
    if (/[A-Za-z0-9가-힣]\s*[_^=+\-*/<>]\s*[A-Za-z0-9가-힣{\\]/.test(value)) return true;
    if (/\{[^{}]+\}\s*(?:over|OVER)\s*\{[^{}]+\}/.test(value)) return true;
    return false;
  }

  function formulaTextToEquationScript(value) {
    let text = stripMathDelimiters(decodeXmlText(value));
    text = text.replace(/^\s*(?:LaTeX|TeX|Formula|Equation|수식)\s*[:：]\s*/i, '');
    if (!text) return '';
    if (/^\s*<math[\s>]/i.test(text) && typeof DOMParser === 'function') {
      try {
        const doc = new DOMParser().parseFromString(text, 'application/xml');
        const math = doc.documentElement;
        if (math) return mathElementToEquationScript(math);
      } catch (_) {}
    }
    if (/\\[A-Za-z,;:!]|\\\(|\\\[|\\begin|[$]/.test(text)) return latexToEquationScript(text);
    return unicodeFormulaToHwpeq(text);
  }

  function mathElementToEquationScript(el) {
    const annotated = equationAnnotationText(el);
    if (annotated) return formulaTextToEquationScript(annotated);
    return sanitizeEquationScript(mathMlNodeToEquationScript(el));
  }

  // Converts one OOXML math block (<m:oMath> ... </m:oMath>, as produced by the
  // Google Docs DOCX export) into a Hangul equation script. OMML uses the same
  // structural shapes as MathML (fraction, sub/sup, radical, n-ary, accent, bar),
  // so the mapping mirrors mathMlNodeToEquationScript but keyed on OMML tag names.
  function ommlToEquationScript(ommlXml) {
    if (typeof DOMParser !== 'function') return '';
    let root = null;
    try {
      const wrapped = '<root xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" ' +
        'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' + ommlXml + '</root>';
      const doc = new DOMParser().parseFromString(wrapped, 'application/xml');
      if (doc.getElementsByTagName('parsererror').length) return '';
      root = doc.documentElement;
    } catch (_) {
      return '';
    }
    const oMath = findOmmlChild(root, 'oMath') || root;
    return sanitizeEquationScript(ommlNodeToEquationScript(oMath));
  }

  function ommlNodeToEquationScript(node) {
    if (!node) return '';
    if (node.nodeType === 3) return mathTextToHwpeq(node.nodeValue || '');
    if (node.nodeType !== 1) return '';
    const tag = ommlLocalName(node);
    // Property/control nodes carry only formatting, never renderable content.
    if (/Pr$/.test(tag) || tag === 'ctrlPr') return '';
    const kids = ommlElementChildren(node);
    if (tag === 'oMath' || tag === 'oMathPara' || tag === 'e' || tag === 'num' || tag === 'den' || tag === 'lim') {
      return joinEquationParts(kids.map(ommlNodeToEquationScript));
    }
    if (tag === 'r') return mathTextToHwpeq(ommlRunText(node));
    if (tag === 't') return mathTextToHwpeq(node.textContent || '');
    if (tag === 'f') {
      return '{' + ommlPartScript(node, 'num') + '} over {' + ommlPartScript(node, 'den') + '}';
    }
    if (tag === 'rad') {
      const body = ommlPartScript(node, 'e');
      if (ommlDegreeHidden(node)) return 'sqrt {' + body + '}';
      const deg = ommlPartScript(node, 'deg');
      return deg ? 'root {' + deg + '} of {' + body + '}' : 'sqrt {' + body + '}';
    }
    if (tag === 'sSup') return wrapEquationBase(ommlPartScript(node, 'e')) + '^{' + ommlPartScript(node, 'sup') + '}';
    if (tag === 'sSub') return wrapEquationBase(ommlPartScript(node, 'e')) + '_{' + ommlPartScript(node, 'sub') + '}';
    if (tag === 'sSubSup') {
      return wrapEquationBase(ommlPartScript(node, 'e')) + '_{' + ommlPartScript(node, 'sub') + '}^{' + ommlPartScript(node, 'sup') + '}';
    }
    if (tag === 'sPre') {
      return '_{' + ommlPartScript(node, 'sub') + '}^{' + ommlPartScript(node, 'sup') + '}' + wrapEquationBase(ommlPartScript(node, 'e'));
    }
    if (tag === 'nary') return ommlNaryScript(node);
    if (tag === 'acc') {
      const body = ommlPartScript(node, 'e');
      const chr = ommlAccentChar(node);
      if (chr === '→' || chr === '⃗') return 'vec{' + body + '}';
      if (chr === '^' || chr === '̂') return 'hat{' + body + '}';
      if (chr === '~' || chr === '̃') return 'tilde{' + body + '}';
      if (chr === '˙' || chr === '.') return 'dot{' + body + '}';
      return 'hat{' + body + '}';
    }
    if (tag === 'bar') return 'bar{' + ommlPartScript(node, 'e') + '}';
    if (tag === 'd') {
      const beg = ommlDelimiterChar(node, 'begChr', '(');
      const end = ommlDelimiterChar(node, 'endChr', ')');
      return 'left ' + beg + ' ' + joinEquationParts(ommlDelimiterParts(node).map(ommlNodeToEquationScript)) + ' right ' + end;
    }
    if (tag === 'func') {
      return joinEquationParts([ommlPartScript(node, 'fName'), ommlPartScript(node, 'e')]);
    }
    if (tag === 'm') return ommlMatrixScript(node);
    if (tag === 'mr') return kids.filter(k => ommlLocalName(k) === 'e').map(ommlNodeToEquationScript).join('#');
    if (tag === 'groupChr') return ommlPartScript(node, 'e');
    return joinEquationParts(kids.map(ommlNodeToEquationScript));
  }

  function ommlNaryScript(node) {
    const chr = ommlNaryChar(node);
    const symbol = ommlNarySymbolName(chr);
    const sub = ommlPartScript(node, 'sub');
    const sup = ommlPartScript(node, 'sup');
    const body = ommlPartScript(node, 'e');
    let head = symbol;
    if (sub) head += '_{' + sub + '}';
    if (sup) head += '^{' + sup + '}';
    return joinEquationParts([head, body]);
  }

  function ommlMatrixScript(node) {
    const rows = ommlElementChildren(node)
      .filter(child => ommlLocalName(child) === 'mr')
      .map(ommlNodeToEquationScript)
      .filter(Boolean);
    return 'matrix{' + rows.join(';') + '}';
  }

  function ommlPartScript(node, partName) {
    const part = findOmmlChild(node, partName);
    return part ? joinEquationParts(ommlElementChildren(part).map(ommlNodeToEquationScript)) : '';
  }

  function ommlRunText(runNode) {
    return ommlElementChildren(runNode)
      .filter(child => ommlLocalName(child) === 't')
      .map(child => child.textContent || '')
      .join('');
  }

  function ommlDegreeHidden(radNode) {
    const pr = findOmmlChild(radNode, 'radPr');
    const degHide = pr && findOmmlChild(pr, 'degHide');
    if (degHide && ommlVal(degHide) !== '0') return true;
    // Degree is also implicitly hidden when no <m:deg> content is present.
    const deg = findOmmlChild(radNode, 'deg');
    return !deg || !ommlElementChildren(deg).length;
  }

  function ommlAccentChar(accNode) {
    const pr = findOmmlChild(accNode, 'accPr');
    const chr = pr && findOmmlChild(pr, 'chr');
    return chr ? ommlVal(chr) : '̂';
  }

  function ommlNaryChar(naryNode) {
    const pr = findOmmlChild(naryNode, 'naryPr');
    const chr = pr && findOmmlChild(pr, 'chr');
    return chr ? ommlVal(chr) : '∫';
  }

  function ommlNarySymbolName(chr) {
    const mapped = UNICODE_EQUATION_SYMBOLS[chr];
    if (mapped) return mapped;
    return unicodeFormulaToHwpeq(chr) || 'INT';
  }

  function ommlDelimiterChar(dNode, attrName, fallback) {
    const pr = findOmmlChild(dNode, 'dPr');
    const chrNode = pr && findOmmlChild(pr, attrName);
    const value = chrNode ? ommlVal(chrNode) : '';
    return value || fallback;
  }

  function ommlDelimiterParts(dNode) {
    return ommlElementChildren(dNode).filter(child => ommlLocalName(child) === 'e');
  }

  function ommlVal(node) {
    if (!node || typeof node.getAttribute !== 'function') return '';
    return node.getAttribute('m:val') || node.getAttribute('val') || '';
  }

  function ommlLocalName(node) {
    return String(node && (node.localName || '') || '').toLowerCase() === ''
      ? String(node && node.nodeName || '').replace(/^.*:/, '')
      : node.localName;
  }

  function ommlElementChildren(node) {
    return Array.from(node && node.childNodes || []).filter(child => child.nodeType === 1);
  }

  function findOmmlChild(node, localName) {
    for (const child of ommlElementChildren(node)) {
      if (ommlLocalName(child) === localName) return child;
    }
    return null;
  }

  function mathMlNodeToEquationScript(node) {
    if (!node) return '';
    if (node.nodeType === 3) return mathTextToHwpeq(node.nodeValue || '');
    if (node.nodeType !== 1) return '';
    const tag = elementName(node);
    const children = Array.from(node.childNodes || []);
    const child = index => children[index] ? mathMlNodeToEquationScript(children[index]) : '';
    if (tag === 'annotation') return '';
    if (tag === 'math' || tag === 'semantics' || tag === 'mrow' || tag === 'mstyle' || tag === 'mpadded' || tag === 'mphantom') {
      return joinEquationParts(children.map(mathMlNodeToEquationScript));
    }
    if (tag === 'mi' || tag === 'mn' || tag === 'mo' || tag === 'mtext' || tag === 'ms') {
      return mathTextToHwpeq(node.textContent || '');
    }
    if (tag === 'msup') return wrapEquationBase(child(0)) + '^{' + child(1) + '}';
    if (tag === 'msub') return wrapEquationBase(child(0)) + '_{' + child(1) + '}';
    if (tag === 'msubsup') return wrapEquationBase(child(0)) + '_{' + child(1) + '}^{' + child(2) + '}';
    if (tag === 'mfrac') return '{' + child(0) + '} over {' + child(1) + '}';
    if (tag === 'msqrt') return 'sqrt {' + joinEquationParts(children.map(mathMlNodeToEquationScript)) + '}';
    if (tag === 'mroot') return 'root {' + child(1) + '} of {' + child(0) + '}';
    if (tag === 'mover') {
      const over = mathTextToHwpeq(children[1] ? children[1].textContent || '' : '');
      const body = child(0);
      if (/^(?:¯|bar|overline)$/.test(over)) return 'bar{' + body + '}';
      if (/^(?:\^|hat)$/.test(over)) return 'hat{' + body + '}';
      if (/^(?:→|rarrow|vec)$/.test(over)) return 'vec{' + body + '}';
      return wrapEquationBase(body) + '^{' + child(1) + '}';
    }
    if (tag === 'munder') return wrapEquationBase(child(0)) + '_{' + child(1) + '}';
    if (tag === 'munderover') return wrapEquationBase(child(0)) + '_{' + child(1) + '}^{' + child(2) + '}';
    if (tag === 'mfenced') {
      const open = mathTextToHwpeq(node.getAttribute('open') || '(');
      const close = mathTextToHwpeq(node.getAttribute('close') || ')');
      return 'left ' + open + ' ' + joinEquationParts(children.map(mathMlNodeToEquationScript)) + ' right ' + close;
    }
    if (tag === 'mtable') return mathMlTableToEquationScript(node);
    if (tag === 'mtr' || tag === 'mlabeledtr') return children.map(mathMlNodeToEquationScript).filter(Boolean).join('#');
    if (tag === 'mtd') return joinEquationParts(children.map(mathMlNodeToEquationScript));
    return joinEquationParts(children.map(mathMlNodeToEquationScript));
  }

  function mathMlTableToEquationScript(table) {
    const rows = Array.from(table.children || [])
      .filter(row => ['mtr', 'mlabeledtr'].includes(elementName(row)))
      .map(row => Array.from(row.children || [])
        .filter(cell => elementName(cell) === 'mtd')
        .map(cell => mathMlNodeToEquationScript(cell))
        .filter(Boolean)
        .join('#'))
      .filter(Boolean);
    return 'matrix{' + rows.join(';') + '}';
  }

  function latexToEquationScript(value) {
    let script = stripMathDelimiters(decodeXmlText(value)).replace(/\r\n?/g, '\n').trim();
    if (!script) return '';
    for (let i = 0; i < 8; i++) {
      const before = script;
      script = replaceLatexEnvironments(script);
      script = replaceLatexSqrt(script);
      script = replaceLatexCommandGroups(script, ['frac', 'dfrac', 'tfrac'], 2, args =>
        '{' + latexToEquationScript(args[0]) + '} over {' + latexToEquationScript(args[1]) + '}'
      );
      script = replaceLatexCommandGroups(script, ['binom'], 2, args =>
        'binom {' + latexToEquationScript(args[0]) + '} {' + latexToEquationScript(args[1]) + '}'
      );
      script = replaceLatexCommandGroups(script, ['mathrm', 'textrm', 'text', 'operatorname'], 1, args =>
        'rm{' + latexToEquationScript(args[0]) + '}'
      );
      script = replaceLatexCommandGroups(script, ['mathbf', 'textbf'], 1, args =>
        'bold{' + latexToEquationScript(args[0]) + '}'
      );
      script = replaceLatexCommandGroups(script, ['mathit', 'textit'], 1, args =>
        'it{' + latexToEquationScript(args[0]) + '}'
      );
      script = replaceLatexCommandGroups(script, ['hat', 'bar', 'overline', 'underline', 'vec', 'tilde', 'dot', 'ddot'], 1, (args, _optional, name) =>
        latexOneArgCommandName(name) + '{' + latexToEquationScript(args[0]) + '}'
      );
      if (script === before) break;
    }
    script = script
      .replace(/\\left\b/g, ' left ')
      .replace(/\\right\b/g, ' right ')
      .replace(/\\(?:bigl|bigr|Bigl|Bigr|big|Big|bigg|Bigg)\b/g, ' ')
      .replace(/\\,/g, '`')
      .replace(/\\:/g, '~')
      .replace(/\\;/g, '~')
      .replace(/\\!/g, '')
      .replace(/\\\\/g, '#')
      .replace(/\\([{}&#_%$])/g, '$1')
      .replace(/\\([A-Za-z]+)/g, (_, name) => ' ' + latexCommandReplacement(name) + ' ');
    return unicodeFormulaToHwpeq(script);
  }

  function replaceLatexEnvironments(script) {
    return String(script || '').replace(/\\begin\{([A-Za-z*]+)\}(?:\{[^{}]*\})?([\s\S]*?)\\end\{\1\}/g, (_, env, body) => {
      const name = env.replace(/\*$/, '');
      const rows = String(body || '').trim().split(/\\\\/).map(row => row.trim()).filter(Boolean);
      if (['matrix', 'smallmatrix', 'array', 'pmatrix', 'bmatrix', 'vmatrix', 'Vmatrix'].includes(name)) {
        const matrixName = name === 'pmatrix' ? 'pmatrix' : name === 'bmatrix' ? 'bmatrix' : name === 'vmatrix' || name === 'Vmatrix' ? 'dmatrix' : 'matrix';
        return matrixName + '{' + rows.map(row => row.split('&').map(cell => latexToEquationScript(cell)).join('#')).join(';') + '}';
      }
      if (name === 'cases') return 'cases{' + rows.map(row => row.split('&').map(cell => latexToEquationScript(cell)).join('&')).join('#') + '}';
      if (['aligned', 'align', 'split', 'gathered'].includes(name)) {
        return 'eqalign{' + rows.map(row => row.split('&').map(cell => latexToEquationScript(cell)).join('&')).join('#') + '}';
      }
      return rows.map(row => latexToEquationScript(row)).join('#');
    });
  }

  function replaceLatexSqrt(script) {
    return replaceLatexCommandGroups(script, ['sqrt'], 1, (args, optional) => {
      const body = latexToEquationScript(args[0]);
      return optional ? 'root {' + latexToEquationScript(optional) + '} of {' + body + '}' : 'sqrt {' + body + '}';
    }, { optionalBracket: true });
  }

  function replaceLatexCommandGroups(script, names, argCount, transform, opts) {
    const source = String(script || '');
    let out = '';
    let i = 0;
    while (i < source.length) {
      const command = readLatexCommandAt(source, i, names);
      if (!command) {
        out += source[i++];
        continue;
      }
      let pos = skipAsciiSpaces(source, command.end);
      let optional = '';
      if (opts && opts.optionalBracket) {
        const bracket = readLatexBracketGroup(source, pos);
        if (bracket) {
          optional = bracket.value;
          pos = skipAsciiSpaces(source, bracket.end);
        }
      }
      const args = [];
      let ok = true;
      for (let a = 0; a < argCount; a++) {
        const group = readLatexGroup(source, pos);
        if (!group) {
          ok = false;
          break;
        }
        args.push(group.value);
        pos = skipAsciiSpaces(source, group.end);
      }
      if (!ok) {
        out += source[i++];
        continue;
      }
      out += transform(args, optional, command.name);
      i = pos;
    }
    return out;
  }

  function readLatexCommandAt(source, index, names) {
    if (source[index] !== '\\') return null;
    const sorted = names.slice().sort((a, b) => b.length - a.length);
    for (const name of sorted) {
      if (source.slice(index + 1, index + 1 + name.length) !== name) continue;
      const next = source[index + 1 + name.length] || '';
      if (/[A-Za-z]/.test(next)) continue;
      return { name, end: index + 1 + name.length };
    }
    return null;
  }

  function readLatexGroup(source, index) {
    let pos = skipAsciiSpaces(source, index);
    if (source[pos] === '{') {
      const end = findMatchingDelimiter(source, pos, '{', '}');
      if (end > pos) return { value: source.slice(pos + 1, end), end: end + 1 };
      return null;
    }
    if (source[pos] === '\\') {
      let end = pos + 1;
      while (/[A-Za-z]/.test(source[end] || '')) end++;
      return end > pos + 1 ? { value: source.slice(pos, end), end } : { value: source.slice(pos, pos + 2), end: pos + 2 };
    }
    if (source[pos]) return { value: source[pos], end: pos + 1 };
    return null;
  }

  function readLatexBracketGroup(source, index) {
    let pos = skipAsciiSpaces(source, index);
    if (source[pos] !== '[') return null;
    const end = findMatchingDelimiter(source, pos, '[', ']');
    return end > pos ? { value: source.slice(pos + 1, end), end: end + 1 } : null;
  }

  function findMatchingDelimiter(source, start, open, close) {
    let depth = 0;
    for (let i = start; i < source.length; i++) {
      if (source[i] === '\\') {
        i++;
        continue;
      }
      if (source[i] === open) depth++;
      else if (source[i] === close) {
        depth--;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  function skipAsciiSpaces(source, index) {
    let pos = index;
    while (/\s/.test(source[pos] || '')) pos++;
    return pos;
  }

  function latexOneArgCommandName(name) {
    if (name === 'overline') return 'overline';
    return name;
  }

  function latexCommandReplacement(name) {
    if (Object.prototype.hasOwnProperty.call(LATEX_COMMANDS, name)) return LATEX_COMMANDS[name];
    return name;
  }

  function unicodeFormulaToHwpeq(value) {
    let out = '';
    for (const ch of String(value || '')) {
      const mapped = UNICODE_EQUATION_SYMBOLS[ch];
      if (mapped) out += needsEquationWordSpace(mapped) ? ' ' + mapped + ' ' : mapped;
      else out += ch;
    }
    out = out
      .replace(/\u00a0/g, ' ')
      .replace(/[−‐‑‒–—]/g, '-')
      .replace(/\^\s*([A-Za-z0-9가-힣]+)/g, '^{$1}')
      .replace(/_\s*([A-Za-z0-9가-힣]+)/g, '_{$1}');
    return sanitizeEquationScript(out);
  }

  // Literal text inside an equation run (from OMML <m:t> or MathML token elements).
  // Curly braces are grouping operators in the Hangul equation syntax, so a literal
  // "{0,1}" must become "{0,1}" spelled with the LBRACE/RBRACE keywords, or Hangul
  // silently swallows the braces. Zero-width spaces that Google Docs sprinkles in
  // are dropped. This escaping applies only to literal run text — never to the
  // grouping braces the structural converters build.
  function mathTextToHwpeq(value) {
    const cleaned = String(value || '').replace(/[​‌‍﻿]/g, '');
    const escaped = cleaned.replace(/\{/g, ' LBRACE ').replace(/\}/g, ' RBRACE ');
    return unicodeFormulaToHwpeq(escaped);
  }

  function joinEquationParts(parts) {
    return sanitizeEquationScript((parts || []).filter(Boolean).join(' '));
  }

  function wrapEquationBase(value) {
    const script = sanitizeEquationScript(value);
    if (!script) return '';
    // A sub/superscript base only needs grouping braces when it is more than one
    // atom. A run of word characters, an already-braced group, or a lone character
    // (including a stray bracket like ")") stands on its own — wrapping ")" as "{)}"
    // just adds noise Hangul renders literally.
    if (/^[A-Za-z0-9가-힣]+$/.test(script)) return script;
    if (/^\{[\s\S]*\}$/.test(script)) return script;
    if (Array.from(script).length === 1) return script;
    return '{' + script + '}';
  }

  function stripMathDelimiters(value) {
    let text = normalizeWhitespace(value || '');
    text = text.replace(/^\\\(/, '').replace(/\\\)$/, '');
    text = text.replace(/^\\\[/, '').replace(/\\\]$/, '');
    if (/^\$\$[\s\S]*\$\$$/.test(text)) text = text.slice(2, -2);
    else if (/^\$[\s\S]*\$$/.test(text)) text = text.slice(1, -1);
    return text.trim();
  }

  function sanitizeEquationScript(value) {
    return String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t\r\n]+/g, ' ')
      .replace(/\s+([,;:)\]}])/g, '$1')
      .replace(/([({\[])\s+/g, '$1')
      .trim();
  }

  function elementName(el) {
    return String(el && (el.localName || el.tagName) || '').toLowerCase();
  }

  const LATEX_COMMANDS = {
    alpha: 'alpha',
    beta: 'beta',
    gamma: 'gamma',
    delta: 'delta',
    epsilon: 'epsilon',
    varepsilon: 'varepsilon',
    zeta: 'zeta',
    eta: 'eta',
    theta: 'theta',
    vartheta: 'vartheta',
    iota: 'iota',
    kappa: 'kappa',
    lambda: 'lambda',
    mu: 'mu',
    nu: 'nu',
    xi: 'xi',
    pi: 'pi',
    rho: 'rho',
    sigma: 'sigma',
    tau: 'tau',
    upsilon: 'upsilon',
    phi: 'phi',
    varphi: 'varphi',
    chi: 'chi',
    psi: 'psi',
    omega: 'omega',
    Gamma: 'Gamma',
    Delta: 'Delta',
    Theta: 'Theta',
    Lambda: 'Lambda',
    Xi: 'Xi',
    Pi: 'Pi',
    Sigma: 'Sigma',
    Phi: 'Phi',
    Psi: 'Psi',
    Omega: 'Omega',
    pm: 'PLUSMINUS',
    mp: 'MINUSPLUS',
    times: 'TIMES',
    div: 'DIV',
    cdot: 'CDOT',
    le: 'LEQ',
    leq: 'LEQ',
    ge: 'GEQ',
    geq: 'GEQ',
    ne: 'NEQ',
    neq: 'NEQ',
    approx: 'APPROX',
    sim: 'SIM',
    equiv: 'EQUIV',
    infty: 'INF',
    inf: 'inf',
    partial: 'PARTIAL',
    nabla: 'nabla',
    sum: 'SUM',
    prod: 'PROD',
    coprod: 'COPROD',
    int: 'INT',
    iint: 'DINT',
    iiint: 'TINT',
    oint: 'OINT',
    lim: 'lim',
    sin: 'sin',
    cos: 'cos',
    tan: 'tan',
    cot: 'cot',
    sec: 'sec',
    csc: 'csc',
    log: 'log',
    ln: 'ln',
    exp: 'exp',
    min: 'min',
    max: 'max',
    leftarrow: 'larrow',
    rightarrow: 'rarrow',
    to: 'rarrow',
    gets: 'larrow',
    Leftrightarrow: 'LRARROW',
    leftrightarrow: 'lrarrow',
    Rightarrow: 'RARROW',
    Leftarrow: 'LARROW',
    implies: 'RARROW',
    iff: 'LRARROW',
    in: 'IN',
    notin: 'NOTIN',
    subset: 'SUBSET',
    subseteq: 'SUBSETEQ',
    superset: 'SUPERSET',
    supseteq: 'SUPSETEQ',
    cup: 'CUP',
    cap: 'CAP',
    bigcup: 'BIGCUP',
    bigcap: 'BIGCAP',
    forall: 'FORALL',
    exists: 'EXIST',
    emptyset: 'EMPTYSET',
    therefore: 'THEREFORE',
    because: 'BECAUSE',
    cdots: 'CDOTS',
    ldots: 'LDOTS',
    vdots: 'VDOTS',
    ddots: 'DDOTS',
    degree: 'DEG',
    deg: 'DEG',
    prime: 'prime',
    lbrace: 'LBRACE',
    rbrace: 'RBRACE',
    lceil: 'LCEIL',
    rceil: 'RCEIL',
    lfloor: 'LFLOOR',
    rfloor: 'RFLOOR',
    langle: 'LANGLE',
    rangle: 'RANGLE'
  };

  const UNICODE_EQUATION_SYMBOLS = {
    α: 'alpha',
    β: 'beta',
    γ: 'gamma',
    δ: 'delta',
    ε: 'epsilon',
    ζ: 'zeta',
    η: 'eta',
    θ: 'theta',
    ι: 'iota',
    κ: 'kappa',
    λ: 'lambda',
    μ: 'mu',
    ν: 'nu',
    ξ: 'xi',
    π: 'pi',
    ρ: 'rho',
    σ: 'sigma',
    τ: 'tau',
    υ: 'upsilon',
    φ: 'phi',
    χ: 'chi',
    ψ: 'psi',
    ω: 'omega',
    Γ: 'Gamma',
    Δ: 'Delta',
    Θ: 'Theta',
    Λ: 'Lambda',
    Ξ: 'Xi',
    Π: 'Pi',
    Σ: 'Sigma',
    Φ: 'Phi',
    Ψ: 'Psi',
    Ω: 'Omega',
    '±': 'PLUSMINUS',
    '∓': 'MINUSPLUS',
    '×': 'TIMES',
    '÷': 'DIV',
    '·': 'CDOT',
    '≤': 'LEQ',
    '≥': 'GEQ',
    '≠': 'NEQ',
    '≈': 'APPROX',
    '≡': 'EQUIV',
    '∞': 'INF',
    '∂': 'PARTIAL',
    '∑': 'SUM',
    '∏': 'PROD',
    '∫': 'INT',
    '∬': 'DINT',
    '∭': 'TINT',
    '∮': 'OINT',
    '√': 'sqrt',
    '→': 'rarrow',
    '←': 'larrow',
    '↔': 'lrarrow',
    '⇒': 'RARROW',
    '⇐': 'LARROW',
    '⇔': 'LRARROW',
    '∈': 'IN',
    '∉': 'NOTIN',
    '⊂': 'SUBSET',
    '⊆': 'SUBSETEQ',
    '⊃': 'SUPERSET',
    '⊇': 'SUPSETEQ',
    '∪': 'CUP',
    '∩': 'CAP',
    '∀': 'FORALL',
    '∃': 'EXIST',
    '∅': 'EMPTYSET',
    '∴': 'THEREFORE',
    '∵': 'BECAUSE',
    '∣': 'VERT',
    '∥': 'PARALLEL',
    '°': 'DEG',
    '′': 'prime'
  };

  function needsEquationWordSpace(value) {
    return /^[A-Za-z]+$/.test(value);
  }

  function buildHwpx(blocks, meta) {
    objectId = 1000;
    paragraphId = 3121190000;
    const images = (meta && meta.images) || [];
    const entries = [
      { name: 'mimetype', data: encoder.encode(HWPX_MIME) },
      { name: 'version.xml', data: xmlBytes(versionXml()) },
      { name: 'Contents/header.xml', data: xmlBytes(headerXml()) },
      { name: 'Contents/section0.xml', data: xmlBytes(sectionXml(blocks)) },
      { name: 'Preview/PrvText.txt', data: encoder.encode(previewText(blocks) || '\r\n') },
      { name: 'Preview/PrvImage.png', data: PRV_IMAGE_PNG },
      { name: 'settings.xml', data: xmlBytes(settingsXml()) }
    ];
    for (const image of images) entries.push({ name: image.packagePath, data: image.data });
    entries.push(
      { name: 'Contents/content.hpf', data: xmlBytes(manifestXml(images)) },
      { name: 'META-INF/container.xml', data: xmlBytes(containerXml()) },
      { name: 'META-INF/container.rdf', data: xmlBytes(containerRdfXml()) },
      { name: 'META-INF/manifest.xml', data: xmlBytes(metaInfManifestXml()) }
    );
    return createStoredZip(entries);
  }

  function sectionXml(blocks) {
    const paraXmls = [];
    let secInserted = false;
    for (const block of blocks) {
      let xml = blockXml(block);
      if (!xml) continue;
      if (!secInserted) {
        xml = insertSecPr(xml);
        secInserted = true;
      }
      paraXmls.push(xml);
    }
    if (!paraXmls.length) paraXmls.push(paragraphXml({ runs: [{ text: '' }] }, PARA_NORMAL, CHAR_NORMAL, true));
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<hs:sec xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:hp="${NS_PARA}" xmlns:hp10="http://www.hancom.co.kr/hwpml/2016/paragraph" xmlns:hs="${NS_SECTION}" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" xmlns:hh="${NS_HEAD}" xmlns:hhs="http://www.hancom.co.kr/hwpml/2011/history" xmlns:hm="http://www.hancom.co.kr/hwpml/2011/master-page" xmlns:hpf="${NS_HPF}" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="${NS_OPF}" xmlns:ooxmlchart="http://www.hancom.co.kr/hwpml/2016/ooxmlchart" xmlns:hwpunitchar="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar" xmlns:epub="http://www.idpf.org/2007/ops" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0">
  ${paraXmls.join('\n  ')}
</hs:sec>`;
  }

  function insertSecPr(xml) {
    return xml.replace(/<hp:run charPrIDRef="(\d+)">/, '<hp:run charPrIDRef="$1">' + secPrXml());
  }

  function blockXml(block) {
    if (block.type === 'table') return tableXml(block);
    if (block.type === 'code') return codeBlockXml(block);
    if (block.type === 'callout') return calloutXml(block);
    if (block.type === 'footnote') {
      return paragraphXml(block, block.paraPrId || PARA_FOOTNOTE, block.defaultCharPrId || CHAR_FOOTNOTE, false);
    }
    if (block.type === 'heading') {
      const level = clampInt(block.level, 1, 1, 4);
      return paragraphXml(block, headingParaPrId(level), headingCharPrId(level), false);
    }
    return paragraphXml(block, block.paraPrId || PARA_NORMAL, block.defaultCharPrId || CHAR_NORMAL, false);
  }

  function paragraphXml(block, paraPrId, defaultCharPrId, forceSecPr) {
    const runs = block.runs && block.runs.length ? block.runs : [{ text: '' }];
    const body = runs.map(run => runXml(run, defaultCharPrId)).join('');
    const sec = forceSecPr ? `<hp:run charPrIDRef="${defaultCharPrId}">${secPrXml()}</hp:run>` : '';
    const styleId = Number.isFinite(Number(block && block.styleId)) ? Number(block.styleId) : styleIdForParaPr(paraPrId);
    return `<hp:p id="${nextParagraphId()}" paraPrIDRef="${paraPrId}" styleIDRef="${styleId}" pageBreak="0" columnBreak="0" merged="0">${sec}${body}${lineSegArrayXml(block, paraPrId, defaultCharPrId)}</hp:p>`;
  }

  function runXml(run, defaultCharPrId) {
    if (run.equation) return `<hp:run charPrIDRef="${defaultCharPrId}">${equationXml(run.equation)}<hp:t/></hp:run>`;
    if (run.image) return `<hp:run charPrIDRef="${defaultCharPrId}">${picXml(run.image)}</hp:run>`;
    const text = String(run.text || '').replace(/\n+/g, '\n');
    const pieces = text.split('\n');
    const charPrId = charPrIdForRun(run, defaultCharPrId);
    return `<hp:run charPrIDRef="${charPrId}">` + pieces.map((piece, index) => {
      const textXml = `<hp:t>${escapeXml(piece)}</hp:t>`;
      return index === 0 ? textXml : `<hp:lineBreak/>${textXml}`;
    }).join('') + '</hp:run>';
  }

  function charPrIdForRun(run, fallback) {
    if (run.superscript) return CHAR_SUPER;
    if (run.code) return CHAR_CODE;
    if (run.highlight || run.underline) return CHAR_HIGHLIGHT;
    if (run.footnote) return CHAR_FOOTNOTE;
    if (fallback === CHAR_CODE) return CHAR_CODE;
    if (fallback === CHAR_TABLE_HEAD) return CHAR_TABLE_HEAD;
    if (fallback === CHAR_TABLE_BODY && run.bold) return CHAR_TABLE_HEAD;
    if (fallback === CHAR_CALLOUT || fallback === CHAR_CALLOUT_HEAD) return fallback;
    if (fallback === CHAR_FOOTNOTE) return CHAR_FOOTNOTE;
    if (run.accent) return CHAR_ACCENT;
    if (run.bold && run.italic) return CHAR_BOLD_ITALIC;
    if (run.bold) return CHAR_BOLD;
    if (run.italic) return CHAR_ITALIC;
    return fallback || CHAR_NORMAL;
  }

  function styleIdForParaPr(paraPrId) {
    if (paraPrId === PARA_H1) return STYLE_H1;
    if (paraPrId === PARA_H2) return STYLE_H2_BAR;
    if (paraPrId === PARA_H3) return STYLE_H3;
    if (paraPrId === PARA_H4) return STYLE_H4;
    if (paraPrId === PARA_LIST) return STYLE_LIST;
    if (paraPrId === PARA_CODE) return STYLE_CODE;
    if (paraPrId === PARA_TABLE_HEAD) return STYLE_TABLE_HEAD;
    if (paraPrId === PARA_TABLE_BODY) return STYLE_TABLE_BODY;
    if (paraPrId === PARA_CALLOUT_HEAD) return STYLE_CALLOUT_HEAD;
    if (paraPrId === PARA_CALLOUT) return STYLE_CALLOUT;
    if (paraPrId === PARA_FOOTNOTE) return STYLE_FOOTNOTE;
    return paraPrId === PARA_NORMAL ? STYLE_BODY : STYLE_BASE;
  }

  function headingParaPrId(level) {
    return level === 1 ? PARA_H1 : level === 2 ? PARA_H2 : level === 3 ? PARA_H3 : PARA_H4;
  }

  function headingCharPrId(level) {
    return level === 1 ? CHAR_H1 : level === 2 ? CHAR_H2 : level === 3 ? CHAR_H3 : CHAR_H4;
  }

  function tableXml(block) {
    const rowCnt = Math.max(1, block.rowCnt || block.rows.length);
    const colCnt = Math.max(1, block.colCnt || 1);
    const cellW = Math.floor(BODY_WIDTH / colCnt);
    const cellH = 1650;
    const tblW = cellW * colCnt;
    const tblH = cellH * rowCnt;
    const hasHeader = block.rows.some(row => row.some(cell => cell.header));
    const rows = block.rows.map((row, rowIdx) => {
      const cells = row.map(cell => {
        const width = cellW * Math.max(1, cell.colSpan || 1);
        const height = cellH * Math.max(1, cell.rowSpan || 1);
        const cellKind = cell.header ? 'head' : ((cell.colAddr || 0) === 0 && colCnt > 1 ? 'stub' : 'body');
        const borderFillId = cellKind === 'head' ? BORDER_TABLE_HEAD : (cellKind === 'stub' ? BORDER_TABLE_STUB : BORDER_TABLE);
        const contentWidth = Math.max(1000, width - TABLE_CELL_TEXT_INSET);
        const paragraphs = styleTableCellBlocks(cell.blocks || [{ type: 'paragraph', runs: [{ text: '' }] }], cellKind)
          .map(childBlock => blockXml(blockWithHorzSize(childBlock, contentWidth)))
          .join('');
        return `<hp:tc name="" header="${cell.header ? 1 : 0}" hasMargin="0" protect="0" editable="1" dirty="0" borderFillIDRef="${borderFillId}">` +
          `<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="${cellKind === 'body' ? 'CENTER' : 'CENTER'}" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${paragraphs}</hp:subList>` +
          `<hp:cellAddr colAddr="${cell.colAddr || 0}" rowAddr="${cell.rowAddr || rowIdx}"/>` +
          `<hp:cellSpan colSpan="${Math.max(1, cell.colSpan || 1)}" rowSpan="${Math.max(1, cell.rowSpan || 1)}"/>` +
          `<hp:cellSz width="${width}" height="${height}"/>` +
          `<hp:cellMargin left="${TABLE_CELL_MARGIN}" right="${TABLE_CELL_MARGIN}" top="${TABLE_CELL_MARGIN}" bottom="${TABLE_CELL_MARGIN}"/></hp:tc>`;
      }).join('');
      return `<hp:tr>${cells}</hp:tr>`;
    }).join('');
    const inner = `<hp:sz width="${tblW}" widthRelTo="ABSOLUTE" height="${tblH}" heightRelTo="ABSOLUTE" protect="0"/>` +
      '<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="0" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>' +
      '<hp:outMargin left="0" right="0" top="0" bottom="0"/><hp:inMargin left="283" right="283" top="283" bottom="283"/>' + rows;
    const tableBlock = { type: 'table-line', lineHeight: Math.max(cellH, tblH), horzSize: tblW };
    return `<hp:p id="${nextParagraphId()}" paraPrIDRef="${PARA_LIST}" styleIDRef="${STYLE_LIST}" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="${CHAR_NORMAL}"><hp:tbl id="${nextObjectId()}" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="${hasHeader ? 1 : 0}" rowCnt="${rowCnt}" colCnt="${colCnt}" cellSpacing="0" borderFillIDRef="${BORDER_TABLE}" noAdjust="0">${inner}</hp:tbl></hp:run>${lineSegArrayXml(tableBlock, PARA_NORMAL, CHAR_NORMAL)}</hp:p>`;
  }

  function styleTableCellBlocks(blocks, kind) {
    const head = kind === 'head' || kind === 'stub';
    return (blocks || []).map(block => {
      if (!block || (block.type !== 'paragraph' && block.type !== 'heading')) return block;
      return Object.assign({}, block, {
        type: 'paragraph',
        paraPrId: head ? PARA_TABLE_HEAD : PARA_TABLE_BODY,
      defaultCharPrId: head ? CHAR_TABLE_HEAD : CHAR_TABLE_BODY,
      styleId: head ? STYLE_TABLE_HEAD : STYLE_TABLE_BODY,
        runs: (block.runs || []).map(run => isObjectRun(run) ? run : Object.assign({}, run, head ? { bold: true } : {}))
      });
    });
  }

  function codeBlockXml(block) {
    const text = String(block.text || ' ');
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const lineNums = lines.map((_, index) => String(index + 1)).join('\n');
    const codeText = lines.join('\n') || ' ';
    const gutterW = Math.min(3000, Math.max(1700, 900 + String(lines.length).length * 420));
    const codeW = Math.max(1000, BODY_WIDTH - gutterW);
    const rowH = Math.max(1650, lines.length * 1200 + 566);
    const gutterBlock = {
      type: 'paragraph',
      paraPrId: PARA_CODE,
      defaultCharPrId: CHAR_CODE,
      styleId: STYLE_CODE,
      horzSize: Math.max(1000, gutterW - 574),
      runs: [{ text: lineNums, code: true }]
    };
    const codeBlock = {
      type: 'paragraph',
      paraPrId: PARA_CODE,
      defaultCharPrId: CHAR_CODE,
      styleId: STYLE_CODE,
      horzSize: Math.max(1000, codeW - 2267),
      runs: [{ text: codeText, code: true }]
    };
    const cells =
      `<hp:tc name="" header="0" hasMargin="1" protect="0" editable="1" dirty="0" borderFillIDRef="${BORDER_CODE_GUTTER}">` +
      `<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${paragraphXml(gutterBlock, PARA_CODE, CHAR_CODE, false)}</hp:subList>` +
      '<hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/>' +
      `<hp:cellSz width="${gutterW}" height="${rowH}"/><hp:cellMargin left="283" right="8" top="8" bottom="8"/></hp:tc>` +
      `<hp:tc name="" header="0" hasMargin="1" protect="0" editable="1" dirty="0" borderFillIDRef="${BORDER_CODE_BODY}">` +
      `<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${paragraphXml(codeBlock, PARA_CODE, CHAR_CODE, false)}</hp:subList>` +
      '<hp:cellAddr colAddr="1" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/>' +
      `<hp:cellSz width="${codeW}" height="${rowH}"/><hp:cellMargin left="1275" right="992" top="283" bottom="141"/></hp:tc>`;
    const inner = `<hp:sz width="${BODY_WIDTH}" widthRelTo="ABSOLUTE" height="${rowH}" heightRelTo="ABSOLUTE" protect="0"/>` +
      '<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>' +
      '<hp:outMargin left="0" right="0" top="0" bottom="0"/><hp:inMargin left="510" right="510" top="141" bottom="141"/>' +
      `<hp:tr>${cells}</hp:tr>`;
    const tableBlock = { type: 'table-line', lineHeight: rowH, horzSize: BODY_WIDTH };
    return `<hp:p id="${nextParagraphId()}" paraPrIDRef="${PARA_CODE}" styleIDRef="${STYLE_CODE}" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="${CHAR_CODE}"><hp:tbl id="${nextObjectId()}" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="1" rowCnt="1" colCnt="2" cellSpacing="0" borderFillIDRef="${BORDER_TABLE}" noAdjust="0">${inner}</hp:tbl></hp:run>${lineSegArrayXml(tableBlock, PARA_CODE, CHAR_CODE)}</hp:p>`;
  }

  function calloutXml(block) {
    const blocks = (block.blocks && block.blocks.length ? block.blocks : [{ type: 'paragraph', runs: [{ text: '' }] }])
      .map((child, index) => styleCalloutBlock(child, index === 0));
    const contentWidth = BODY_WIDTH - 2834;
    const paragraphs = blocks.map(child => blockXml(blockWithHorzSize(child, contentWidth))).join('');
    const height = Math.max(1800, blocks.length * 1500 + 991);
    const inner = `<hp:sz width="${BODY_WIDTH}" widthRelTo="ABSOLUTE" height="${height}" heightRelTo="ABSOLUTE" protect="0"/>` +
      '<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>' +
      '<hp:outMargin left="0" right="0" top="0" bottom="0"/><hp:inMargin left="283" right="283" top="283" bottom="283"/>' +
      `<hp:tr><hp:tc name="" header="0" hasMargin="1" protect="0" editable="1" dirty="0" borderFillIDRef="${BORDER_CALLOUT}">` +
      `<hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">${paragraphs}</hp:subList>` +
      `<hp:cellAddr colAddr="0" rowAddr="0"/><hp:cellSpan colSpan="1" rowSpan="1"/><hp:cellSz width="${BODY_WIDTH}" height="${height}"/><hp:cellMargin left="1417" right="1417" top="566" bottom="425"/></hp:tc></hp:tr>`;
    const tableBlock = { type: 'table-line', lineHeight: height, horzSize: BODY_WIDTH };
    return `<hp:p id="${nextParagraphId()}" paraPrIDRef="${PARA_CALLOUT}" styleIDRef="${STYLE_CALLOUT}" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="${CHAR_CALLOUT}"><hp:tbl id="${nextObjectId()}" zOrder="0" numberingType="TABLE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" pageBreak="CELL" repeatHeader="0" rowCnt="1" colCnt="1" cellSpacing="0" borderFillIDRef="${BORDER_CALLOUT}" noAdjust="0">${inner}</hp:tbl></hp:run>${lineSegArrayXml(tableBlock, PARA_CALLOUT, CHAR_CALLOUT)}</hp:p>`;
  }

  function lineSegArrayXml(block, paraPrId, defaultCharPrId) {
    const metrics = lineMetricsForBlock(block, paraPrId, defaultCharPrId);
    const lines = lineTextPositions(block, metrics, defaultCharPrId);
    if (!lines.length) lines.push(0);
    const xml = lines.map((textpos, index) => {
      const vertpos = index * metrics.advance;
      const flags = index === 0 ? 393216 : 1441792;
      return `<hp:lineseg textpos="${textpos}" vertpos="${vertpos}" vertsize="${metrics.height}" textheight="${metrics.height}" baseline="${metrics.baseline}" spacing="${metrics.spacing}" horzpos="0" horzsize="${metrics.horzSize}" flags="${flags}"/>`;
    }).join('');
    return `<hp:linesegarray>${xml}</hp:linesegarray>`;
  }

  function lineMetricsForBlock(block, paraPrId, defaultCharPrId) {
    if (block && block.type === 'table-line') {
      const height = Math.max(1000, Math.round(block.lineHeight || 1500));
      return {
        height,
        baseline: Math.round(height * 0.85),
        spacing: Math.round(height * 0.6),
        advance: Math.max(height, Math.round(height * 1.6)),
        horzSize: Math.max(0, Math.round(block.horzSize || BODY_WIDTH))
      };
    }
    const charHeight = dominantCharHeight(block, paraPrId, defaultCharPrId);
    const lineSpacing = paraLineSpacing(paraPrId);
    const height = Math.max(100, charHeight);
    return {
      height,
      baseline: Math.round(height * 0.85),
      spacing: Math.round(height * Math.max(0.4, (lineSpacing - 100) / 100)),
      advance: Math.round(height * (lineSpacing / 100)),
      horzSize: Math.max(1000, Math.round(block && block.horzSize || BODY_WIDTH))
    };
  }

  function blockWithHorzSize(block, horzSize) {
    if (!block || block.type === 'table') return block;
    return Object.assign({}, block, { horzSize });
  }

  function dominantCharHeight(block, paraPrId, defaultCharPrId) {
    const runs = block && Array.isArray(block.runs) ? block.runs : [];
    let maxHeight = charHeightById(defaultCharPrId);
    if (paraPrId === PARA_H1) maxHeight = Math.max(maxHeight, charHeightById(CHAR_H1));
    else if (paraPrId === PARA_H2) maxHeight = Math.max(maxHeight, charHeightById(CHAR_H2));
    else if (paraPrId === PARA_H3) maxHeight = Math.max(maxHeight, charHeightById(CHAR_H3));
    else if (paraPrId === PARA_H4) maxHeight = Math.max(maxHeight, charHeightById(CHAR_H4));
    for (const run of runs) {
      if (run.equation) {
        maxHeight = Math.max(maxHeight, equationHwpxSize(run.equation).height);
      } else if (run.image) {
        maxHeight = Math.max(maxHeight, imageHwpxSize(run.image).height);
      } else {
        maxHeight = Math.max(maxHeight, charHeightById(charPrIdForRun(run, defaultCharPrId)));
      }
    }
    return maxHeight;
  }

  function charHeightById(charPrId) {
    const id = Number(charPrId);
    if (id === CHAR_CODE) return 800;
    if (id === CHAR_H1) return 2200;
    if (id === CHAR_H2) return 1350;
    if (id === CHAR_H3) return 1000;
    if (id === CHAR_H4) return 950;
    if (id === CHAR_TABLE_HEAD || id === CHAR_TABLE_BODY) return 800;
    if (id === CHAR_CALLOUT || id === CHAR_CALLOUT_HEAD) return 800;
    if (id === CHAR_FOOTNOTE) return 700;
    if (id === CHAR_SUPER) return 650;
    return 900;
  }

  function paraLineSpacing(paraPrId) {
    if (paraPrId === PARA_H1) return 120;
    if (paraPrId === PARA_H2) return 100;
    if (paraPrId === PARA_CODE) return 150;
    if (paraPrId === PARA_TABLE_HEAD || paraPrId === PARA_TABLE_BODY) return 160;
    if (paraPrId === PARA_CALLOUT || paraPrId === PARA_CALLOUT_HEAD) return 150;
    if (paraPrId === PARA_FOOTNOTE) return 140;
    return 200;
  }

  function lineTextPositions(block, metrics, defaultCharPrId) {
    if (!block || !Array.isArray(block.runs)) return [0];
    const positions = [0];
    let pos = 0;
    let lineWidth = 0;
    let charsInLine = 0;
    const limit = effectiveLineLimit(metrics);
    const charBudget = conservativeLineCharBudget(metrics);
    for (const run of block.runs) {
      if (run.equation || run.image) {
        const objectWidth = run.equation ? equationHwpxSize(run.equation).width : imageHwpxSize(run.image).width;
        if (lineWidth > 0 && (lineWidth + objectWidth > limit || charsInLine >= charBudget)) {
          pushLinePosition(positions, pos);
          lineWidth = 0;
          charsInLine = 0;
        }
        lineWidth += objectWidth;
        pos += 1;
        charsInLine += 1;
        continue;
      }
      const text = String(run.text || '');
      const charHeight = charHeightById(charPrIdForRun(run, defaultCharPrId));
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '\n') {
          pos++;
          pushLinePosition(positions, pos);
          lineWidth = 0;
          charsInLine = 0;
          continue;
        }
        const charWidth = estimatedCharWidth(ch, charHeight);
        if (lineWidth > 0 && (lineWidth + charWidth > limit || charsInLine >= charBudget)) {
          pushLinePosition(positions, pos);
          lineWidth = 0;
          charsInLine = 0;
        }
        lineWidth += charWidth;
        pos++;
        charsInLine++;
      }
    }
    return positions;
  }

  function pushLinePosition(positions, pos) {
    if (pos > positions[positions.length - 1]) positions.push(pos);
  }

  function effectiveLineLimit(metrics) {
    const raw = Math.max(1000, Number(metrics && metrics.horzSize) || BODY_WIDTH);
    return Math.max(800, Math.floor(raw * 0.92));
  }

  function conservativeLineCharBudget(metrics) {
    const height = Math.max(100, Number(metrics && metrics.height) || 1000);
    const width = effectiveLineLimit(metrics);
    return Math.max(6, Math.floor(width / Math.max(1, height * 1.12)));
  }

  function estimatedCharWidth(ch, charHeight) {
    if (!ch) return 0;
    if (/\s/.test(ch)) return Math.round(charHeight * 0.5);
    const code = ch.codePointAt(0);
    if (code >= 0xac00 && code <= 0xd7af) return Math.round(charHeight * 1.12);
    if ((code >= 0x1100 && code <= 0x11ff) || (code >= 0x3130 && code <= 0x318f)) return Math.round(charHeight * 1.12);
    if ((code >= 0x2e80 && code <= 0x9fff) || (code >= 0xff00 && code <= 0xffef)) return Math.round(charHeight * 1.12);
    if (/[A-Z0-9]/.test(ch)) return Math.round(charHeight * 0.72);
    if (/[a-z]/.test(ch)) return Math.round(charHeight * 0.62);
    if (/[.,;:!?'"()[\]{}<>/\\|`~_-]/.test(ch)) return Math.round(charHeight * 0.42);
    return Math.round(charHeight * 0.72);
  }

  function validateSectionXml(sectionXml) {
    const warnings = [];
    let paraIndex = 0;
    const paragraphRe = /<hp:p\b[\s\S]*?<\/hp:p>/g;
    let match;
    while ((match = paragraphRe.exec(String(sectionXml || '')))) {
      const xml = match[0];
      const text = paragraphPlainText(xml);
      const linesegArrayMatch = xml.match(/<hp:linesegarray\b[^>]*>([\s\S]*?)<\/hp:linesegarray>/);
      const linesegBody = linesegArrayMatch ? linesegArrayMatch[1] : '';
      const linesegMatches = Array.from(linesegBody.matchAll(/<hp:lineseg\b[^>]*>/g), item => item[0]);
      if (text.length && !linesegMatches.length) {
        warnings.push({ section: 0, paragraph: paraIndex, kind: 'LinesegArrayEmpty', cell: null });
      } else if (linesegMatches.length === 1 && /(?:\bvertsize|\btextheight)="0"/.test(linesegMatches[0])) {
        warnings.push({ section: 0, paragraph: paraIndex, kind: 'LinesegUncomputed', cell: null });
      } else if (linesegMatches.length === 1 && text.length > 40 && text.indexOf('\n') === -1) {
        warnings.push({ section: 0, paragraph: paraIndex, kind: 'LinesegTextRunReflow', cell: null });
      }
      paraIndex++;
    }
    const summary = {};
    for (const warning of warnings) {
      const label = validationWarningLabel(warning.kind);
      summary[label] = (summary[label] || 0) + 1;
    }
    return { count: warnings.length, summary, warnings };
  }

  function paragraphPlainText(xml) {
    const parts = [];
    const textRe = /<hp:t\b[^>]*\/>|<hp:t\b[^>]*>([\s\S]*?)<\/hp:t>|<hp:lineBreak\s*\/?>/g;
    let match;
    while ((match = textRe.exec(xml))) {
      if (match[0].indexOf('<hp:lineBreak') === 0) parts.push('\n');
      else if (/\/>$/.test(match[0])) parts.push('');
      else parts.push(decodeXmlText(match[1] || ''));
    }
    return parts.join('');
  }

  function decodeXmlText(text) {
    return String(text || '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
  }

  function validationWarningLabel(kind) {
    if (kind === 'LinesegArrayEmpty') return 'lineseg 배열이 비어있음';
    if (kind === 'LinesegUncomputed') return 'lineseg 가 미계산 상태 (line_height=0)';
    return 'lineseg 가 문단당 1개 (한컴 textRun reflow 의존)';
  }

  let objectId = 1000;
  function nextObjectId() {
    objectId++;
    return objectId;
  }

  function nextParagraphId() {
    paragraphId++;
    return paragraphId;
  }

  function equationXml(equation) {
    const size = equationHwpxSize(equation);
    const baseUnit = equationBaseUnit(equation);
    const script = sanitizeEquationScript(equation && equation.script);
    const baseline = equationBaselineAttr(script);
    return `<hp:equation id="${nextObjectId()}" zOrder="0" numberingType="EQUATION" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" version="Equation Version 60" baseLine="${baseline}" textColor="#000000" baseUnit="${baseUnit}" lineMode="CHAR" font="HYhwpEQ">` +
      `<hp:sz width="${size.width}" widthRelTo="ABSOLUTE" height="${size.height}" heightRelTo="ABSOLUTE" protect="0"/>` +
      '<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>' +
      '<hp:outMargin left="56" right="56" top="0" bottom="0"/>' +
      '<hp:shapeComment>수식입니다.</hp:shapeComment>' +
      `<hp:script xml:space="preserve">${escapeXml(script)}</hp:script>` +
      '</hp:equation>';
  }

  function equationHwpxSize(equation) {
    const script = sanitizeEquationScript(equation && equation.script);
    const baseUnit = equationBaseUnit(equation);
    const lower = script.toLowerCase();
    const hasFraction = /\bover\b/.test(lower);
    const hasRoot = /\b(?:sqrt|root)\b/.test(lower);
    const hasMatrix = /\b(?:matrix|pmatrix|bmatrix|dmatrix|cases|eqalign|pile)\b/.test(lower) || /[#;]/.test(script);
    const hasScript = /[_^]\s*\{?/.test(script);
    let height = Math.round(baseUnit * 1.15);
    if (hasScript) height = Math.max(height, Math.round(baseUnit * 1.3));
    if (hasRoot) height = Math.max(height, Math.round(baseUnit * 1.35));
    if (hasFraction) height = Math.max(height, Math.round(baseUnit * 2.05));
    if (hasMatrix) {
      const rows = Math.max(2, (script.match(/[#;]/g) || []).length + 1);
      height = Math.max(height, Math.round(baseUnit * (1.6 + rows * 0.55)));
    }

    let width = 0;
    for (const ch of script) width += estimatedEquationCharWidth(ch, baseUnit);
    if (hasFraction) width += Math.round(baseUnit * 1.2);
    if (hasRoot) width += Math.round(baseUnit * 0.9);
    if (hasMatrix) width += Math.round(baseUnit * 1.5);
    width = Math.max(MIN_EQUATION_WIDTH, Math.round(width + baseUnit * 0.7));
    width = Math.min(MAX_EQUATION_WIDTH, width);
    return { width, height: Math.max(Math.round(baseUnit * 0.95), height) };
  }

  function equationBaseUnit(equation) {
    return clampInt(equation && equation.baseUnit, DEFAULT_EQUATION_BASE_UNIT, 700, 1200);
  }

  function equationBaselineAttr(script) {
    const lower = String(script || '').toLowerCase();
    if (/\bover\b/.test(lower) && !/[_^]\s*\{[^}]*\bover\b/.test(lower)) return 66;
    if (/\b(?:sqrt|root)\b/.test(lower)) return 88;
    if (/[_^]\s*\{?/.test(lower)) return 87;
    return 85;
  }

  function estimatedEquationCharWidth(ch, baseUnit) {
    if (!ch) return 0;
    if (/\s/.test(ch)) return Math.round(baseUnit * 0.25);
    if (ch === '`') return Math.round(baseUnit * 0.15);
    const code = ch.codePointAt(0);
    if (code >= 0xac00 && code <= 0xd7af) return Math.round(baseUnit * 0.95);
    if ((code >= 0x2e80 && code <= 0x9fff) || (code >= 0xff00 && code <= 0xffef)) return Math.round(baseUnit * 0.95);
    if (/[A-Z]/.test(ch)) return Math.round(baseUnit * 0.65);
    if (/[a-z0-9]/.test(ch)) return Math.round(baseUnit * 0.55);
    if (/[{}()[\]]/.test(ch)) return Math.round(baseUnit * 0.28);
    if (/[_^]/.test(ch)) return Math.round(baseUnit * 0.2);
    if (/[+\-=<>/*:,.|]/.test(ch)) return Math.round(baseUnit * 0.42);
    return Math.round(baseUnit * 0.55);
  }

  function picXml(image) {
    const size = imageHwpxSize(image);
    const w = size.width;
    const h = size.height;
    const dimW = image.widthPx ? pxToHwp(image.widthPx) : w;
    const dimH = image.heightPx ? pxToHwp(image.heightPx) : h;
    return `<hp:pic id="${nextObjectId()}" zOrder="0" numberingType="PICTURE" textWrap="TOP_AND_BOTTOM" textFlow="BOTH_SIDES" lock="0" dropcapstyle="None" href="" groupLevel="0" instid="${nextObjectId()}" reverse="0">` +
      '<hp:offset x="0" y="0"/>' +
      `<hp:orgSz width="${w}" height="${h}"/>` +
      `<hp:curSz width="${w}" height="${h}"/>` +
      '<hp:flip horizontal="0" vertical="0"/>' +
      `<hp:rotationInfo angle="0" centerX="${Math.round(w / 2)}" centerY="${Math.round(h / 2)}" rotateimage="1"/>` +
      '<hp:renderingInfo><hc:transMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:scaMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/><hc:rotMatrix e1="1" e2="0" e3="0" e4="0" e5="1" e6="0"/></hp:renderingInfo>' +
      `<hp:imgRect><hc:pt0 x="0" y="0"/><hc:pt1 x="${w}" y="0"/><hc:pt2 x="${w}" y="${h}"/><hc:pt3 x="0" y="${h}"/></hp:imgRect>` +
      `<hp:imgClip left="0" right="${dimW}" top="0" bottom="${dimH}"/>` +
      '<hp:inMargin left="0" right="0" top="0" bottom="0"/>' +
      `<hp:imgDim dimwidth="${dimW}" dimheight="${dimH}"/>` +
      `<hc:img binaryItemIDRef="${escapeXml(image.binaryId)}" bright="0" contrast="0" effect="REAL_PIC" alpha="0"/>` +
      `<hp:sz width="${w}" widthRelTo="ABSOLUTE" height="${h}" heightRelTo="ABSOLUTE" protect="0"/>` +
      '<hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>' +
      '<hp:outMargin left="0" right="0" top="0" bottom="0"/>' +
      `<hp:shapeComment>${escapeXml(image.alt || '')}</hp:shapeComment>` +
      '</hp:pic>';
  }

  function imageHwpxSize(image) {
    let width = image.widthPx ? pxToHwp(image.widthPx) : DEFAULT_IMAGE_WIDTH;
    let height = image.heightPx ? pxToHwp(image.heightPx) : DEFAULT_IMAGE_HEIGHT;
    if (width > MAX_IMAGE_WIDTH) {
      const ratio = MAX_IMAGE_WIDTH / width;
      width = MAX_IMAGE_WIDTH;
      height = Math.max(1000, Math.round(height * ratio));
    }
    return { width: Math.max(1000, width), height: Math.max(1000, height) };
  }

  function pxToHwp(px) {
    return Math.round(Number(px || 0) * 75);
  }

  function containerXml() {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<ocf:container xmlns:ocf="${NS_OCF}" xmlns:hpf="${NS_HPF}">
  <ocf:rootfiles>
    <ocf:rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/>
    <ocf:rootfile full-path="Preview/PrvText.txt" media-type="text/plain"/>
    <ocf:rootfile full-path="META-INF/container.rdf" media-type="application/rdf+xml"/>
  </ocf:rootfiles>
</ocf:container>`;
  }

  function manifestXml(images) {
    const imageItems = images.map(image =>
      `    <opf:item id="${image.binaryId}" href="${image.packagePath}" media-type="${escapeXml(image.mime || mimeFromExt(image.ext))}" isEmbeded="1"/>`
    ).join('\n');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<opf:package xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:hp="${NS_PARA}" xmlns:hp10="http://www.hancom.co.kr/hwpml/2016/paragraph" xmlns:hs="${NS_SECTION}" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" xmlns:hh="${NS_HEAD}" xmlns:hhs="http://www.hancom.co.kr/hwpml/2011/history" xmlns:hm="http://www.hancom.co.kr/hwpml/2011/master-page" xmlns:hpf="${NS_HPF}" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="${NS_OPF}" xmlns:ooxmlchart="http://www.hancom.co.kr/hwpml/2016/ooxmlchart" xmlns:hwpunitchar="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar" xmlns:epub="http://www.idpf.org/2007/ops" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0" version="" unique-identifier="" id="">
  <opf:metadata>
    <opf:title/>
    <opf:language>ko</opf:language>
    <opf:meta name="creator" content="text">Toytype</opf:meta>
    <opf:meta name="CreatedDate" content="text"/>
    <opf:meta name="ModifiedDate" content="text"/>
  </opf:metadata>
  <opf:manifest>
    <opf:item id="header" href="Contents/header.xml" media-type="application/xml"/>
    <opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/>
    <opf:item id="settings" href="settings.xml" media-type="application/xml"/>
${imageItems}
  </opf:manifest>
  <opf:spine>
    <opf:itemref idref="header" linear="yes"/>
    <opf:itemref idref="section0" linear="yes"/>
  </opf:spine>
</opf:package>`;
  }

  function versionXml() {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><hv:HCFVersion xmlns:hv="http://www.hancom.co.kr/hwpml/2011/version" tagetApplication="WORDPROCESSOR" major="5" minor="1" micro="0" buildNumber="1" os="1" xmlVersion="1.4" application="Hancom Office Hangul" appVersion="11, 0, 0, 3524 WIN32LEWindows_8"/>';
  }

  function settingsXml() {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><ha:HWPApplicationSetting xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"><ha:CaretPosition listIDRef="0" paraIDRef="0" pos="0"/></ha:HWPApplicationSetting>';
  }

  function containerRdfXml() {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>' +
      '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
      '<rdf:Description rdf:about=""><ns0:hasPart xmlns:ns0="http://www.hancom.co.kr/hwpml/2016/meta/pkg#" rdf:resource="Contents/header.xml"/></rdf:Description>' +
      '<rdf:Description rdf:about="Contents/header.xml"><rdf:type rdf:resource="http://www.hancom.co.kr/hwpml/2016/meta/pkg#HeaderFile"/></rdf:Description>' +
      '<rdf:Description rdf:about=""><ns0:hasPart xmlns:ns0="http://www.hancom.co.kr/hwpml/2016/meta/pkg#" rdf:resource="Contents/section0.xml"/></rdf:Description>' +
      '<rdf:Description rdf:about="Contents/section0.xml"><rdf:type rdf:resource="http://www.hancom.co.kr/hwpml/2016/meta/pkg#SectionFile"/></rdf:Description>' +
      '<rdf:Description rdf:about=""><rdf:type rdf:resource="http://www.hancom.co.kr/hwpml/2016/meta/pkg#Document"/></rdf:Description>' +
      '</rdf:RDF>';
  }

  function metaInfManifestXml() {
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><odf:manifest xmlns:odf="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"/>';
  }

  const FONT_FACES = [
    { face: '함초롬바탕', weight: 6 },
    { face: '함초롬돋움', weight: 6 },
    { face: 'HY견고딕', weight: 9 },
    { face: '나눔스퀘어 ExtraBold', weight: 9 },
    { face: 'D2Coding', weight: 6 },
    { face: 'Pretendard Medium', weight: 6 },
    { face: 'KoPubWorld바탕체 Light', weight: 3 },
    { face: 'KoPubWorld돋움체 Bold', weight: 8 },
    { face: 'KoPubWorld돋움체 Medium', weight: 6 },
    { face: 'KoPubWorld바탕체_Pro Medium', weight: 6 },
    { face: 'KoPubWorld돋움체_Pro Light', weight: 3 }
  ];

  function fontfaceXml(lang) {
    const fonts = FONT_FACES.map((font, id) =>
      `        <hh:font id="${id}" face="${escapeXml(font.face)}" type="TTF" isEmbedded="0"><hh:typeInfo familyType="FCAT_GOTHIC" weight="${font.weight}" proportion="4" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/></hh:font>`
    ).join('\n');
    return `      <hh:fontface lang="${lang}" fontCnt="${FONT_FACES.length}">
${fonts}
      </hh:fontface>`;
  }

  function headerXml() {
    const fontfaces = ['HANGUL', 'LATIN', 'HANJA', 'JAPANESE', 'OTHER', 'SYMBOL', 'USER'].map(fontfaceXml).join('\n');
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<hh:head xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app" xmlns:hp="${NS_PARA}" xmlns:hp10="http://www.hancom.co.kr/hwpml/2016/paragraph" xmlns:hs="${NS_SECTION}" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core" xmlns:hh="${NS_HEAD}" xmlns:hhs="http://www.hancom.co.kr/hwpml/2011/history" xmlns:hm="http://www.hancom.co.kr/hwpml/2011/master-page" xmlns:hpf="${NS_HPF}" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="${NS_OPF}" xmlns:ooxmlchart="http://www.hancom.co.kr/hwpml/2016/ooxmlchart" xmlns:hwpunitchar="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar" xmlns:epub="http://www.idpf.org/2007/ops" xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0" version="1.4" secCnt="1">
  <hh:beginNum page="1" footnote="1" endnote="1" pic="1" tbl="1" equation="1"/>
  <hh:refList>
    <hh:fontfaces itemCnt="7">
${fontfaces}
    </hh:fontfaces>
    <hh:borderFills itemCnt="9">
      ${borderFillXml(BORDER_PAGE, { left: 'NONE', right: 'NONE', top: 'NONE', bottom: 'NONE', color: '#000000' })}
      ${borderFillXml(BORDER_TEXT, { left: 'NONE', right: 'NONE', top: 'NONE', bottom: 'NONE', color: '#000000', fill: 'none' })}
      ${borderFillXml(BORDER_TABLE, { left: 'SOLID', right: 'SOLID', top: 'SOLID', bottom: 'SOLID', color: '#FF00FF', fill: '#FFFFFF' })}
      ${borderFillXml(BORDER_TABLE_HEAD, { left: 'SOLID', right: 'SOLID', top: 'SOLID', bottom: 'SOLID', color: '#FF00FF', fill: '#FFE6FF' })}
      ${borderFillXml(BORDER_TABLE_STUB, { left: 'SOLID', right: 'SOLID', top: 'SOLID', bottom: 'SOLID', color: '#FF00FF', fill: '#FFF0FF' })}
      ${borderFillXml(BORDER_CODE_GUTTER, { left: 'NONE', right: 'SOLID', top: 'NONE', bottom: 'NONE', color: '#D9D9D9', fill: '#F2F2F2' })}
      ${borderFillXml(BORDER_CODE_BODY, { left: 'NONE', right: 'NONE', top: 'NONE', bottom: 'NONE', color: '#D9D9D9', fill: '#FFFFFF' })}
      ${borderFillXml(BORDER_CALLOUT, { left: 'NONE', right: 'NONE', top: 'SOLID', bottom: 'NONE', color: '#FF00FF', fill: '#FFF0FF', topWidth: '0.6 mm' })}
      ${borderFillXml(BORDER_HIGHLIGHT, { left: 'NONE', right: 'NONE', top: 'NONE', bottom: 'NONE', color: '#FF00FF', fill: '#FFE6FF' })}
    </hh:borderFills>
    <hh:charProperties itemCnt="17">
${charPr(CHAR_NORMAL, { height: 900, fontId: FONT_KOPUB_BATANG_LIGHT, spacing: -5, useFontSpace: 1 })}
${charPr(CHAR_BOLD, { height: 900, fontId: FONT_KOPUB_BATANG_PRO_MEDIUM, bold: true, spacing: -5, useFontSpace: 1 })}
${charPr(CHAR_ITALIC, { height: 900, fontId: FONT_KOPUB_BATANG_LIGHT, italic: true, spacing: -5, useFontSpace: 1 })}
${charPr(CHAR_BOLD_ITALIC, { height: 900, fontId: FONT_KOPUB_BATANG_PRO_MEDIUM, bold: true, italic: true, spacing: -5, useFontSpace: 1 })}
${charPr(CHAR_CODE, { height: 800, fontId: FONT_D2CODING, useFontSpace: 1 })}
${charPr(CHAR_H1, { height: 2200, fontId: FONT_NANUM_SQUARE_EXTRABOLD, bold: true, color: '#FF00FF', useFontSpace: 1 })}
${charPr(CHAR_H2, { height: 1350, fontId: FONT_PRETENDARD_MEDIUM, bold: true, color: '#FF00FF' })}
${charPr(CHAR_H3, { height: 1000, fontId: FONT_KOPUB_DODUM_BOLD, bold: true, color: '#000000', useFontSpace: 1 })}
${charPr(CHAR_H4, { height: 950, fontId: FONT_NANUM_SQUARE_EXTRABOLD, bold: true, color: '#FF00FF', useKerning: 1, useFontSpace: 1 })}
${charPr(CHAR_TABLE_HEAD, { height: 800, fontId: FONT_KOPUB_DODUM_BOLD, bold: true })}
${charPr(CHAR_TABLE_BODY, { height: 800, fontId: FONT_KOPUB_BATANG_LIGHT, useFontSpace: 1 })}
${charPr(CHAR_CALLOUT, { height: 800, fontId: FONT_KOPUB_DODUM_MEDIUM, useFontSpace: 1 })}
${charPr(CHAR_CALLOUT_HEAD, { height: 800, fontId: FONT_KOPUB_DODUM_BOLD, bold: true, color: '#FF00FF', useFontSpace: 1 })}
${charPr(CHAR_FOOTNOTE, { height: 700, fontId: FONT_HAMCHO_BATANG })}
${charPr(CHAR_SUPER, { height: 650, fontId: FONT_HAMCHO_BATANG, superscript: true })}
${charPr(CHAR_ACCENT, { height: 900, fontId: FONT_KOPUB_DODUM_BOLD, bold: true, color: '#FF00FF', useFontSpace: 1 })}
${charPr(CHAR_HIGHLIGHT, { height: 900, fontId: FONT_KOPUB_BATANG_PRO_MEDIUM, bold: true, borderFillId: BORDER_HIGHLIGHT, underline: true, underlineColor: '#FF00FF', useFontSpace: 1 })}
    </hh:charProperties>
    <hh:tabProperties itemCnt="2">
      <hh:tabPr id="0" autoTabLeft="0" autoTabRight="0"/>
      <hh:tabPr id="1" autoTabLeft="1" autoTabRight="0"/>
    </hh:tabProperties>
    <hh:numberings itemCnt="1">
      <hh:numbering id="1" start="0"><hh:paraHead start="1" level="1" align="LEFT" useInstWidth="1" autoIndent="1" widthAdjust="0" textOffsetType="PERCENT" textOffset="50" numFormat="DIGIT" charPrIDRef="4294967295" checkable="0">^1.</hh:paraHead><hh:paraHead start="1" level="2" align="LEFT" useInstWidth="1" autoIndent="1" widthAdjust="0" textOffsetType="PERCENT" textOffset="50" numFormat="HANGUL_SYLLABLE" charPrIDRef="4294967295" checkable="0">^2.</hh:paraHead><hh:paraHead start="1" level="3" align="LEFT" useInstWidth="1" autoIndent="1" widthAdjust="0" textOffsetType="PERCENT" textOffset="50" numFormat="DIGIT" charPrIDRef="4294967295" checkable="0">^3)</hh:paraHead><hh:paraHead start="1" level="4" align="LEFT" useInstWidth="1" autoIndent="1" widthAdjust="0" textOffsetType="PERCENT" textOffset="50" numFormat="HANGUL_SYLLABLE" charPrIDRef="4294967295" checkable="0">^4)</hh:paraHead><hh:paraHead start="1" level="5" align="LEFT" useInstWidth="1" autoIndent="1" widthAdjust="0" textOffsetType="PERCENT" textOffset="50" numFormat="DIGIT" charPrIDRef="4294967295" checkable="0">(^5)</hh:paraHead><hh:paraHead start="1" level="6" align="LEFT" useInstWidth="1" autoIndent="1" widthAdjust="0" textOffsetType="PERCENT" textOffset="50" numFormat="HANGUL_SYLLABLE" charPrIDRef="4294967295" checkable="0">(^6)</hh:paraHead><hh:paraHead start="1" level="7" align="LEFT" useInstWidth="1" autoIndent="1" widthAdjust="0" textOffsetType="PERCENT" textOffset="50" numFormat="CIRCLED_DIGIT" charPrIDRef="4294967295" checkable="1">^7</hh:paraHead></hh:numbering>
    </hh:numberings>
    <hh:paraProperties itemCnt="12">
${paraPr(PARA_NORMAL, { lineSpacing: 200, spaceAfter: 150, borderFillId: BORDER_TEXT })}
${paraPr(PARA_H1, { align: 'LEFT', lineSpacing: 120, spaceBefore: 1200, spaceAfter: 600, borderFillId: BORDER_TEXT })}
${paraPr(PARA_H2, { align: 'LEFT', lineSpacing: 100, left: 1039, spaceAfter: 1500, borderFillId: BORDER_TEXT })}
${paraPr(PARA_H3, { align: 'LEFT', lineSpacing: 160, spaceBefore: 500, spaceAfter: 300, borderFillId: BORDER_TEXT })}
${paraPr(PARA_H4, { align: 'LEFT', lineSpacing: 160, spaceBefore: 400, spaceAfter: 150, borderFillId: BORDER_TEXT })}
${paraPr(PARA_LIST, { lineSpacing: 200, indent: -900, spaceAfter: 150, borderFillId: BORDER_TEXT })}
${paraPr(PARA_CODE, { align: 'LEFT', lineSpacing: 150, condense: 15, borderFillId: BORDER_TEXT })}
${paraPr(PARA_TABLE_HEAD, { align: 'CENTER', lineSpacing: 160, condense: 15, borderFillId: BORDER_TEXT })}
${paraPr(PARA_TABLE_BODY, { align: 'JUSTIFY', lineSpacing: 160, condense: 15, borderFillId: BORDER_TEXT })}
${paraPr(PARA_CALLOUT, { lineSpacing: 150, condense: 50, spaceBefore: 300, borderFillId: BORDER_CALLOUT, borderOffset: 566, connect: 1, ignoreMargin: 1 })}
${paraPr(PARA_CALLOUT_HEAD, { lineSpacing: 150, condense: 50, indent: -1230, borderFillId: BORDER_CALLOUT, borderOffset: 566, connect: 1, ignoreMargin: 1 })}
${paraPr(PARA_FOOTNOTE, { align: 'JUSTIFY', lineSpacing: 140, indent: -600, left: 600, borderFillId: BORDER_TEXT })}
    </hh:paraProperties>
    <hh:styles itemCnt="13">
${styleXml(STYLE_BASE, '바탕글', 'Normal', PARA_NORMAL, CHAR_NORMAL, STYLE_BODY)}
${styleXml(STYLE_CODE, '코드', '', PARA_CODE, CHAR_CODE, STYLE_CODE)}
${styleXml(STYLE_TABLE_HEAD, '표구분', '', PARA_TABLE_HEAD, CHAR_TABLE_HEAD, STYLE_TABLE_HEAD)}
${styleXml(STYLE_TABLE_BODY, '표내용', '', PARA_TABLE_BODY, CHAR_TABLE_BODY, STYLE_TABLE_BODY)}
${styleXml(STYLE_CALLOUT, '노베이스-내용', '', PARA_CALLOUT, CHAR_CALLOUT, STYLE_CALLOUT)}
${styleXml(STYLE_CALLOUT_HEAD, '노베이스-제목', '', PARA_CALLOUT_HEAD, CHAR_CALLOUT_HEAD, STYLE_CALLOUT)}
${styleXml(STYLE_H2_BAR, '바-123', '', PARA_H2, CHAR_H2, STYLE_BODY)}
${styleXml(STYLE_H3, '123', '', PARA_H3, CHAR_H3, STYLE_BODY)}
${styleXml(STYLE_LIST, '본문-점', '', PARA_LIST, CHAR_NORMAL, STYLE_BODY)}
${styleXml(STYLE_H4, '본문목차-제목', '', PARA_H4, CHAR_H4, STYLE_BODY)}
${styleXml(STYLE_H1, '장제목', '', PARA_H1, CHAR_H1, STYLE_BODY)}
${styleXml(STYLE_BODY, '본문', '', PARA_NORMAL, CHAR_NORMAL, STYLE_BODY)}
${styleXml(STYLE_FOOTNOTE, '각주', 'Footnote', PARA_FOOTNOTE, CHAR_FOOTNOTE, STYLE_BODY)}
    </hh:styles>
  </hh:refList>
  <hh:compatibleDocument targetProgram="HWP201X"><hh:layoutCompatibility/></hh:compatibleDocument>
  <hh:docOption><hh:linkinfo path="" pageInherit="0" footnoteInherit="0"/></hh:docOption>
  <hh:trackchageConfig flags="56"/>
</hh:head>`;
  }

  function styleXml(id, name, engName, paraPrId, charPrId, nextStyleId) {
    return `      <hh:style id="${id}" type="PARA" name="${escapeXml(name)}" engName="${escapeXml(engName || '')}" paraPrIDRef="${paraPrId}" charPrIDRef="${charPrId}" nextStyleIDRef="${nextStyleId}" langID="1042" lockForm="0"/>`;
  }

  function borderFillXml(id, opts) {
    const o = opts || {};
    const color = o.color || '#000000';
    const left = o.left || 'NONE';
    const right = o.right || 'NONE';
    const top = o.top || 'NONE';
    const bottom = o.bottom || 'NONE';
    const leftWidth = o.leftWidth || '0.12 mm';
    const rightWidth = o.rightWidth || '0.12 mm';
    const topWidth = o.topWidth || '0.12 mm';
    const bottomWidth = o.bottomWidth || '0.12 mm';
    const fill = Object.prototype.hasOwnProperty.call(o, 'fill') ?
      `<hc:fillBrush><hc:winBrush faceColor="${escapeXml(o.fill)}" hatchColor="#999999" alpha="0"/></hc:fillBrush>` : '';
    return `<hh:borderFill id="${id}" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0"><hh:slash type="NONE" Crooked="0" isCounter="0"/><hh:backSlash type="NONE" Crooked="0" isCounter="0"/><hh:leftBorder type="${left}" width="${leftWidth}" color="${color}"/><hh:rightBorder type="${right}" width="${rightWidth}" color="${color}"/><hh:topBorder type="${top}" width="${topWidth}" color="${color}"/><hh:bottomBorder type="${bottom}" width="${bottomWidth}" color="${color}"/><hh:diagonal type="SOLID" width="0.1 mm" color="#000000"/>${fill}</hh:borderFill>`;
  }

  function charPr(id, opts) {
    const o = opts || {};
    const height = o.height || 900;
    const effFont = Number.isFinite(Number(o.fontId)) ? Number(o.fontId) : FONT_KOPUB_BATANG_LIGHT;
    const spacing = Number.isFinite(Number(o.spacing)) ? Number(o.spacing) : 0;
    const ratio = Number.isFinite(Number(o.ratio)) ? Number(o.ratio) : 100;
    const relSz = Number.isFinite(Number(o.relSz)) ? Number(o.relSz) : 100;
    const offset = Number.isFinite(Number(o.offset)) ? Number(o.offset) : 0;
    const underline = o.underline ? 'BOTTOM' : 'NONE';
    const underlineColor = o.underlineColor || '#000000';
    const borderFillId = o.borderFillId || BORDER_TEXT;
    return `      <hh:charPr id="${id}" height="${height}" textColor="${o.color || '#000000'}" shadeColor="none" useFontSpace="${o.useFontSpace || 0}" useKerning="${o.useKerning || 0}" symMark="NONE" borderFillIDRef="${borderFillId}">
        <hh:fontRef hangul="${effFont}" latin="${effFont}" hanja="${effFont}" japanese="${effFont}" other="${effFont}" symbol="${effFont}" user="${effFont}"/>
        <hh:ratio hangul="${ratio}" latin="${ratio}" hanja="${ratio}" japanese="${ratio}" other="${ratio}" symbol="${ratio}" user="${ratio}"/>
        <hh:spacing hangul="${spacing}" latin="${spacing}" hanja="${spacing}" japanese="${spacing}" other="${spacing}" symbol="${spacing}" user="${spacing}"/>
        <hh:relSz hangul="${relSz}" latin="${relSz}" hanja="${relSz}" japanese="${relSz}" other="${relSz}" symbol="${relSz}" user="${relSz}"/>
        <hh:offset hangul="${offset}" latin="${offset}" hanja="${offset}" japanese="${offset}" other="${offset}" symbol="${offset}" user="${offset}"/>
        ${o.italic ? '<hh:italic/>' : ''}${o.bold ? '<hh:bold/>' : ''}<hh:underline type="${underline}" shape="SOLID" color="${underlineColor}"/>
        <hh:strikeout shape="NONE" color="#000000"/>
        <hh:outline type="NONE"/>
        <hh:shadow type="NONE" color="#B2B2B2" offsetX="10" offsetY="10"/>
        ${o.superscript ? '<hh:supscript/>' : ''}
      </hh:charPr>`;
  }

  function paraPr(id, opts) {
    const o = opts || {};
    const align = o.align || 'JUSTIFY';
    const spaceBefore = o.spaceBefore || 0;
    const spaceAfter = o.spaceAfter || 0;
    const lineSpacing = o.lineSpacing || 160;
    const indent = o.indent || 0;
    const left = o.left || 0;
    const right = o.right || 0;
    const borderFillId = o.borderFillId || BORDER_TEXT;
    const borderOffset = o.borderOffset || 0;
    const connect = o.connect || 0;
    const ignoreMargin = o.ignoreMargin || 0;
    const marginXml = `<hh:margin><hc:intent value="${indent}" unit="HWPUNIT"/><hc:left value="${left}" unit="HWPUNIT"/><hc:right value="${right}" unit="HWPUNIT"/><hc:prev value="${spaceBefore}" unit="HWPUNIT"/><hc:next value="${spaceAfter}" unit="HWPUNIT"/></hh:margin><hh:lineSpacing type="PERCENT" value="${lineSpacing}" unit="HWPUNIT"/>`;
    return `      <hh:paraPr id="${id}" tabPrIDRef="${o.tabPrIDRef || 0}" condense="${o.condense || 0}" fontLineHeight="0" snapToGrid="${Object.prototype.hasOwnProperty.call(o, 'snapToGrid') ? o.snapToGrid : 1}" suppressLineNumbers="0" checked="0" textDir="AUTO">
        <hh:align horizontal="${align}" vertical="BASELINE"/>
        <hh:heading type="NONE" idRef="0" level="0"/>
        <hh:breakSetting breakLatinWord="KEEP_WORD" breakNonLatinWord="${o.breakNonLatinWord || 'KEEP_WORD'}" widowOrphan="0" keepWithNext="0" keepLines="0" pageBreakBefore="0" lineWrap="BREAK"/>
        <hh:autoSpacing eAsianEng="0" eAsianNum="0"/>
        <hp:switch><hp:case hp:required-namespace="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar">${marginXml}</hp:case><hp:default>${marginXml}</hp:default></hp:switch>
        <hh:border borderFillIDRef="${borderFillId}" offsetLeft="${borderOffset}" offsetRight="${borderOffset}" offsetTop="${borderOffset}" offsetBottom="${borderOffset}" connect="${connect}" ignoreMargin="${ignoreMargin}"/>
      </hh:paraPr>`;
  }

  function secPrXml() {
    return '<hp:secPr id="" textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" tabStopVal="4000" tabStopUnit="HWPUNIT" outlineShapeIDRef="1" memoShapeIDRef="0" textVerticalWidthHead="0" masterPageCnt="0"><hp:grid lineGrid="0" charGrid="0" wonggojiFormat="0"/><hp:startNum pageStartsOn="BOTH" page="0" pic="0" tbl="0" equation="0"/><hp:visibility hideFirstHeader="0" hideFirstFooter="0" hideFirstMasterPage="0" border="SHOW_ALL" fill="SHOW_ALL" hideFirstPageNum="0" hideFirstEmptyLine="0" showLineNumber="0"/><hp:lineNumberShape restartType="0" countBy="0" distance="0" startNumber="0"/><hp:pagePr landscape="WIDELY" width="59528" height="84186" gutterType="LEFT_ONLY"><hp:margin header="4252" footer="4252" gutter="0" left="8504" right="8504" top="5668" bottom="4252"/></hp:pagePr><hp:footNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="-1" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="283" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="EACH_COLUMN" beneathText="0"/></hp:footNotePr><hp:endNotePr><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/><hp:noteLine length="14692344" type="SOLID" width="0.12 mm" color="#000000"/><hp:noteSpacing betweenNotes="0" belowLine="567" aboveLine="850"/><hp:numbering type="CONTINUOUS" newNum="1"/><hp:placement place="END_OF_DOCUMENT" beneathText="0"/></hp:endNotePr><hp:pageBorderFill type="BOTH" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill><hp:pageBorderFill type="EVEN" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill><hp:pageBorderFill type="ODD" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER"><hp:offset left="1417" right="1417" top="1417" bottom="1417"/></hp:pageBorderFill></hp:secPr><hp:ctrl><hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/></hp:ctrl>';
  }

  function previewText(blocks) {
    const lines = [];
    for (const block of blocks) {
      const text = blockText(block);
      if (text) lines.push(text);
      if (lines.join('\n').length > 1024) break;
    }
    return lines.join('\n').slice(0, 1024);
  }

  function blockText(block) {
    if (block.type === 'table') {
      return block.rows.map(row => row.map(cell => (cell.blocks || []).map(blockText).join(' ')).join(' ')).join('\n');
    }
    if (block.type === 'code') return block.text || '';
    if (block.type === 'callout') return (block.blocks || []).map(blockText).join('\n');
    return (block.runs || []).map(run => {
      if (run.equation) return sanitizeEquationScript(run.equation.script);
      if (run.image) return run.image.alt || '[image]';
      return run.text || '';
    }).join('');
  }

  function xmlBytes(xml) {
    return encoder.encode(xml);
  }

  function createStoredZip(files) {
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    const { time, date } = dosDateTime(new Date());
    for (const file of files) {
      const nameBuffer = encoder.encode(file.name);
      const data = file.data instanceof Uint8Array ? file.data : encoder.encode(String(file.data || ''));
      const crc = crc32(data);
      const local = new Uint8Array(30 + nameBuffer.length);
      const localView = new DataView(local.buffer);
      localView.setUint32(0, 0x04034b50, true);
      localView.setUint16(4, 20, true);
      localView.setUint16(6, 0x0800, true);
      localView.setUint16(8, 0, true);
      localView.setUint16(10, time, true);
      localView.setUint16(12, date, true);
      localView.setUint32(14, crc, true);
      localView.setUint32(18, data.length, true);
      localView.setUint32(22, data.length, true);
      localView.setUint16(26, nameBuffer.length, true);
      localView.setUint16(28, 0, true);
      local.set(nameBuffer, 30);
      localParts.push(local, data);

      const central = new Uint8Array(46 + nameBuffer.length);
      const centralView = new DataView(central.buffer);
      centralView.setUint32(0, 0x02014b50, true);
      centralView.setUint16(4, 20, true);
      centralView.setUint16(6, 20, true);
      centralView.setUint16(8, 0x0800, true);
      centralView.setUint16(10, 0, true);
      centralView.setUint16(12, time, true);
      centralView.setUint16(14, date, true);
      centralView.setUint32(16, crc, true);
      centralView.setUint32(20, data.length, true);
      centralView.setUint32(24, data.length, true);
      centralView.setUint16(28, nameBuffer.length, true);
      centralView.setUint16(30, 0, true);
      centralView.setUint16(32, 0, true);
      centralView.setUint16(34, 0, true);
      centralView.setUint16(36, 0, true);
      centralView.setUint32(38, 0, true);
      centralView.setUint32(42, offset, true);
      central.set(nameBuffer, 46);
      centralParts.push(central);
      offset += local.length + data.length;
    }
    const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
    const eocd = new Uint8Array(22);
    const eocdView = new DataView(eocd.buffer);
    eocdView.setUint32(0, 0x06054b50, true);
    eocdView.setUint16(8, files.length, true);
    eocdView.setUint16(10, files.length, true);
    eocdView.setUint32(12, centralSize, true);
    eocdView.setUint32(16, offset, true);
    return concatUint8(localParts.concat(centralParts, eocd));
  }

  async function readZipPackage(arrayBuffer) {
    const data = new Uint8Array(arrayBuffer);
    const entries = readZipEntries(data);
    const files = new Map();
    for (const entry of entries) {
      if (entry.dir) continue;
      const raw = data.slice(entry.dataStart, entry.dataStart + entry.compressedSize);
      let bytes = raw;
      if (entry.method === 8) bytes = await inflateRaw(raw);
      else if (entry.method !== 0) continue;
      const item = { name: entry.name, data: bytes };
      files.set(normalizeZipPath(entry.name), item);
    }
    return { files };
  }

  function readZipEntries(data) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const eocdOffset = findEocd(view);
    const total = view.getUint16(eocdOffset + 10, true);
    const cdSize = view.getUint32(eocdOffset + 12, true);
    const cdOffset = view.getUint32(eocdOffset + 16, true);
    if (cdOffset + cdSize > data.length) throw new Error('invalid zip central directory');
    const entries = [];
    let offset = cdOffset;
    for (let i = 0; i < total; i++) {
      if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('invalid zip central entry');
      const flags = view.getUint16(offset + 8, true);
      const method = view.getUint16(offset + 10, true);
      const compressedSize = view.getUint32(offset + 20, true);
      const nameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const commentLength = view.getUint16(offset + 32, true);
      const localOffset = view.getUint32(offset + 42, true);
      const nameBytes = data.slice(offset + 46, offset + 46 + nameLength);
      const name = (flags & 0x0800 ? decoder : new TextDecoder()).decode(nameBytes);
      if (view.getUint32(localOffset, true) !== 0x04034b50) throw new Error('invalid zip local entry');
      const localNameLength = view.getUint16(localOffset + 26, true);
      const localExtraLength = view.getUint16(localOffset + 28, true);
      entries.push({
        name: normalizeZipPath(name),
        method,
        compressedSize,
        dataStart: localOffset + 30 + localNameLength + localExtraLength,
        dir: /\/$/.test(name)
      });
      offset += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  }

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream !== 'function') throw new Error('zip deflate is not supported in this browser');
    const attempts = ['deflate-raw', 'deflate'];
    let lastError = null;
    for (const format of attempts) {
      try {
        const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
        return new Uint8Array(await new Response(stream).arrayBuffer());
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError || new Error('zip inflate failed');
  }

  function findHtmlEntry(pkg) {
    for (const item of pkg.files.values()) {
      if (/\.html?$/i.test(item.name)) return item;
    }
    return null;
  }

  function looksLikeZip(arrayBuffer) {
    const data = new Uint8Array(arrayBuffer);
    return data.length > 4 && data[0] === 0x50 && data[1] === 0x4b;
  }

  function findEocd(view) {
    const min = Math.max(0, view.byteLength - 0xffff - 22);
    for (let offset = view.byteLength - 22; offset >= min; offset--) {
      if (view.getUint32(offset, true) === 0x06054b50) return offset;
    }
    throw new Error('invalid zip footer');
  }

  function dosDateTime(dateObj) {
    const date = dateObj instanceof Date ? dateObj : new Date();
    const year = Math.max(1980, date.getFullYear());
    return {
      time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
      date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate()
    };
  }

  function crc32(buffer) {
    const table = crc32Table();
    let crc = 0xffffffff;
    for (let i = 0; i < buffer.length; i++) crc = table[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function crc32Table() {
    if (crc32TableCache) return crc32TableCache;
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c >>> 0;
    }
    crc32TableCache = table;
    return table;
  }

  function concatUint8(parts) {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  }

  function parseDataUri(uri) {
    const match = String(uri || '').match(/^data:([^;,]+)?((?:;[^,]+)*?),(.*)$/i);
    if (!match) return null;
    const mime = match[1] || 'application/octet-stream';
    const flags = match[2] || '';
    const body = match[3] || '';
    if (/;base64/i.test(flags)) {
      const binary = atob(body.replace(/\s/g, ''));
      const data = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) data[i] = binary.charCodeAt(i);
      return { mime, data };
    }
    return { mime, data: encoder.encode(decodeURIComponent(body)) };
  }

  function imageSizeFromElement(img, data) {
    const attrW = parseCssPx(img.getAttribute('width')) || parseCssPx((img.getAttribute('style') || '').match(/width\s*:\s*([^;]+)/i)?.[1]);
    const attrH = parseCssPx(img.getAttribute('height')) || parseCssPx((img.getAttribute('style') || '').match(/height\s*:\s*([^;]+)/i)?.[1]);
    const intrinsic = imageDimensions(data) || {};
    return {
      width: attrW || intrinsic.width || 320,
      height: attrH || intrinsic.height || Math.round((attrW || intrinsic.width || 320) * 0.6)
    };
  }

  function parseCssPx(value) {
    if (!value) return 0;
    const text = String(value).trim();
    const n = parseFloat(text);
    if (!Number.isFinite(n) || n <= 0) return 0;
    if (/cm$/i.test(text)) return n * 37.795;
    if (/mm$/i.test(text)) return n * 3.7795;
    if (/in$/i.test(text)) return n * 96;
    if (/pt$/i.test(text)) return n * 96 / 72;
    return n;
  }

  function imageDimensions(data) {
    if (!data || data.length < 10) return null;
    if (data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47 && data.length >= 24) {
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      return { width: view.getUint32(16), height: view.getUint32(20) };
    }
    if (data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) {
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
    }
    if (data[0] === 0x42 && data[1] === 0x4d && data.length >= 26) {
      const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
      return { width: Math.abs(view.getInt32(18, true)), height: Math.abs(view.getInt32(22, true)) };
    }
    if (data[0] === 0xff && data[1] === 0xd8) return jpegDimensions(data);
    return null;
  }

  function jpegDimensions(data) {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    let offset = 2;
    while (offset + 9 < data.length) {
      if (data[offset] !== 0xff) {
        offset++;
        continue;
      }
      const marker = data[offset + 1];
      if (marker === 0xd9 || marker === 0xda) break;
      const length = view.getUint16(offset + 2);
      if (length < 2 || offset + 2 + length > data.length) break;
      if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
        return { width: view.getUint16(offset + 7), height: view.getUint16(offset + 5) };
      }
      offset += 2 + length;
    }
    return null;
  }

  function imageExt(mime, sourcePath, data) {
    const fromMime = mimeToExt(mime || '');
    if (fromMime !== 'bin') return fromMime;
    const fromPath = pathExt(sourcePath);
    if (/^(png|jpe?g|gif|bmp|webp|svg)$/i.test(fromPath)) return fromPath.toLowerCase() === 'jpeg' ? 'jpg' : fromPath.toLowerCase();
    if (data && data[0] === 0x89 && data[1] === 0x50) return 'png';
    if (data && data[0] === 0xff && data[1] === 0xd8) return 'jpg';
    if (data && data[0] === 0x47 && data[1] === 0x49) return 'gif';
    if (data && data[0] === 0x42 && data[1] === 0x4d) return 'bmp';
    return 'bin';
  }

  function mimeToExt(mime) {
    const text = String(mime || '').toLowerCase();
    if (text.includes('jpeg')) return 'jpg';
    if (text.includes('png')) return 'png';
    if (text.includes('gif')) return 'gif';
    if (text.includes('bmp')) return 'bmp';
    if (text.includes('webp')) return 'webp';
    if (text.includes('svg')) return 'svg';
    return 'bin';
  }

  function mimeFromExt(ext) {
    const e = String(ext || '').toLowerCase();
    if (e === 'jpg' || e === 'jpeg') return 'image/jpeg';
    if (e === 'png') return 'image/png';
    if (e === 'gif') return 'image/gif';
    if (e === 'bmp') return 'image/bmp';
    if (e === 'webp') return 'image/webp';
    if (e === 'svg') return 'image/svg+xml';
    return 'application/octet-stream';
  }

  function mimeFromPath(path) {
    return mimeFromExt(pathExt(path));
  }

  function pathExt(path) {
    const match = String(path || '').split(/[?#]/)[0].match(/\.([A-Za-z0-9]+)$/);
    return match ? match[1].toLowerCase() : '';
  }

  function normalizeInlineText(text) {
    return String(text || '').replace(/\s+/g, ' ');
  }

  function normalizeWhitespace(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function escapeXml(text) {
    return String(text || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function normalizeZipPath(value) {
    const raw = String(value || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const out = [];
    for (const part of raw.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') continue;
      out.push(part);
    }
    return out.join('/');
  }

  function decodeURIComponentSafe(value) {
    try {
      return decodeURIComponent(value);
    } catch (_) {
      return value;
    }
  }

  function clampInt(value, fallback, min, max) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(min, Math.min(max, Math.floor(n)));
  }

  function safeFileName(name) {
    return String(name || 'document.hwpx')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'document.hwpx';
  }

  globalThis.ToytypeHwpxExport = {
    exportGoogleDoc,
    downloadBytes,
    _internal: {
      buildHwpx,
      createStoredZip,
      htmlToBlocks,
      buildEquationRegistry,
      collectEquationHints,
      collectMarkdownEquationHints,
      latexToEquationScript,
      formulaTextToEquationScript,
      ommlToEquationScript,
      extractOmmlEquationScripts,
      validateSectionXml
    }
  };
})();
