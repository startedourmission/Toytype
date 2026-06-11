(function () {
  'use strict';

  function safeGet(obj, key) {
    try {
      return obj[key];
    } catch (e) {
      return undefined;
    }
  }

  function safeGetPath(path) {
    const parts = path.split('.');
    let cur = window;
    for (const part of parts) {
      if (part === 'window') continue;
      cur = safeGet(cur, part);
      if (cur === undefined || cur === null) break;
    }
    return cur;
  }

  function toPromise(value) {
    if (value && typeof value.then === 'function') return value;
    return Promise.resolve(value);
  }

  function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  window.addEventListener('message', event => {
    if (event.source !== window || !event.data || event.data.kind !== 'typo-radar:page-model-request') return;
    handleRequest(event.data);
  });

  function handleRequest(data) {
    getAnnotatedTextObject(data).then(obj => {
      if (data.action === 'getText') {
        return getText(obj).then(text => {
          return getSelection(obj).then(selection => {
            postResponse(data, { ok: true, action: data.action, text, selection });
          });
        });
      }
      if (data.action === 'setSelection') {
        const range = readRange(data);
        return setSelection(obj, range.start, range.end).then(result => {
          focusDocsEditor();
          return delay(80).then(() => getSelection(obj)).then(selection => {
            postResponse(data, { ok: true, action: data.action, result, selection });
          });
        });
      }
      throw new Error('unknown page model action: ' + data.action);
    }).catch(error => {
      postResponse(data, {
        ok: false,
        action: data.action || '',
        errorName: error && error.name ? error.name : '',
        errorMessage: error && error.message ? String(error.message).slice(0, 500) : String(error).slice(0, 500)
      });
    });
  }

  function readRange(data) {
    const start = Number(data.start);
    const end = Number(data.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) {
      throw new Error('invalid selection range');
    }
    return { start, end };
  }

  function getAnnotatedTextObject(data) {
    const fn = safeGetPath('_docs_annotate_getAnnotatedText');
    if (typeof fn !== 'function') return Promise.reject(new Error('_docs_annotate_getAnnotatedText unavailable'));
    const ids = annotatedTextArgCandidates(data);
    if (!ids.length) return Promise.reject(new Error('no annotated text id candidates'));
    let index = 0;
    const tryNext = lastError => {
      if (index >= ids.length) return Promise.reject(lastError || new Error('annotated text object unavailable'));
      const id = ids[index++];
      return Promise.resolve().then(() => {
        return toPromise(fn(id)).then(obj => {
          if (!obj || typeof obj.getText !== 'function' || typeof obj.setSelection !== 'function') {
            throw new Error('annotated text object missing methods for id ' + id);
          }
          return obj;
        });
      }).catch(tryNext);
    };
    return tryNext();
  }

  function annotatedTextArgCandidates(data) {
    const out = [];
    const add = value => {
      if (typeof value !== 'string' || !value || out.includes(value)) return;
      out.push(value);
    };
    add(data && data.extensionId);
    add(data && data.docId);
    const match = location.pathname.match(/\/d\/([a-zA-Z0-9_-]+)/);
    add(match && match[1]);
    add('docs');
    add('kix');
    return out;
  }

  function getText(obj) {
    return callAnnotatedMethod(obj, 'getText').then(text => {
      if (typeof text !== 'string') throw new Error('getText returned non-string');
      return text;
    });
  }

  function getSelection(obj) {
    return callAnnotatedMethod(obj, 'getSelection').then(selection => {
      if (!Array.isArray(selection)) return null;
      return selection.map(item => ({
        start: item && typeof item.start === 'number' ? item.start : null,
        end: item && typeof item.end === 'number' ? item.end : null
      }));
    }).catch(() => null);
  }

  function setSelection(obj, start, end) {
    return callAnnotatedMethod(obj, 'setSelection', [start, end]);
  }

  function focusDocsEditor() {
    try { window.focus(); } catch (e) { /* best effort */ }
    const iframe = document.querySelector('iframe.docs-texteventtarget-iframe');
    try {
      if (iframe && iframe.contentWindow) iframe.contentWindow.focus();
    } catch (e) { /* best effort */ }
    const editor = document.querySelector('.kix-appview-editor');
    try {
      if (editor && typeof editor.focus === 'function') editor.focus();
    } catch (e) { /* best effort */ }
  }

  function callAnnotatedMethod(obj, name, args) {
    const fn = obj && obj[name];
    if (typeof fn !== 'function') return Promise.reject(new Error(name + ' is not a function'));
    try {
      return toPromise(fn.apply(obj, Array.isArray(args) ? args : []));
    } catch (error) {
      return Promise.reject(error);
    }
  }

  function postResponse(request, payload) {
    window.postMessage(Object.assign({
      kind: 'typo-radar:page-model-response',
      requestId: request && request.requestId
    }, payload), '*');
  }

  window.postMessage({ kind: 'typo-radar:page-bridge-ready' }, '*');
})();
