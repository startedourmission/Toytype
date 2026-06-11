// Toytype — 매칭 엔진 (빌더2)
// content script(클래식 스크립트)와 Node CJS 양쪽에서 그대로 로드되므로
// import/export·chrome.*·DOM 사용 금지. 부수효과는 globalThis.TypoEngine 할당 하나뿐.
(function () {
  'use strict';

  // 가드 B 특수문자: . / _ = : @ ( ) { } [ ] < > ; \  (코드·URL·이메일 토큰 판정)
  const CODE_SPECIALS = new Set([46, 47, 95, 61, 58, 64, 40, 41, 123, 125, 91, 93, 60, 62, 59, 92]);

  function isAsciiAlnum(code) {
    return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
  }

  // 공백류: space, \t, \n, \r, NBSP
  function isSpaceCode(code) {
    return code === 32 || code === 9 || code === 10 || code === 13 || code === 160;
  }

  const state = {
    ready: false,
    version: null,
    meta: [],         // [{id,label,ruleCount,enabled}] — rules.json 순서
    map2: null,       // 첫 2문자 키 → 후보 버킷 (len 내림차순, ord 오름차순)
    map1: null,       // 길이 1 src 전용 1문자 키
    firstCodes: null  // 모든 src의 첫 코드유닛 집합 (위치별 빠른 스킵)
  };

  function validate(rulesJson, enabledCategoryIds) {
    if (!rulesJson || typeof rulesJson !== 'object' || !Array.isArray(rulesJson.categories)) {
      throw new Error('TypoEngine.init: invalid rulesJson');
    }
    if (!Array.isArray(enabledCategoryIds)) {
      throw new Error('TypoEngine.init: enabledCategoryIds must be an array');
    }
    for (let i = 0; i < rulesJson.categories.length; i++) {
      const cat = rulesJson.categories[i];
      if (!cat || typeof cat !== 'object' || typeof cat.id !== 'string' || cat.id === '' || !Array.isArray(cat.rules)) {
        throw new Error('TypoEngine.init: invalid category at index ' + i);
      }
      for (let j = 0; j < cat.rules.length; j++) {
        const r = cat.rules[j];
        if (!Array.isArray(r) || typeof r[0] !== 'string' || typeof r[1] !== 'string') {
          throw new Error('TypoEngine.init: invalid rule in category "' + cat.id + '" at index ' + j);
        }
      }
    }
  }

  function byLenDescOrdAsc(a, b) {
    return b.len - a.len || a.ord - b.ord;
  }

  function init(rulesJson, enabledCategoryIds) {
    // 검증을 통과하기 전에는 기존 상태를 건드리지 않는다 (실패한 init은 무해)
    validate(rulesJson, enabledCategoryIds);
    const enabled = new Set(enabledCategoryIds);
    const map2 = new Map();
    const map1 = new Map();
    const firstCodes = new Set();
    const meta = [];
    let ord = 0;     // 전역 순번 = 카테고리 순서 → 카테고리 내 규칙 순서 (동률 타이브레이크)
    let total = 0;
    let active = 0;

    for (const cat of rulesJson.categories) {
      const isOn = enabled.has(cat.id);
      total += cat.rules.length;
      meta.push({
        id: cat.id,
        label: typeof cat.label === 'string' ? cat.label : cat.id,
        ruleCount: cat.rules.length,
        enabled: isOn
      });
      if (!isOn) continue;
      for (const rule of cat.rules) {
        const src = rule[0];
        const dst = rule[1];
        if (src.trim() === '') continue; // 빈/공백-only src 무시
        if (src === dst) continue;       // 무변환 규칙 무시 (dst '' 는 삭제 규칙이라 허용)
        // 선두 공백 삽입형(dst === ' '+src, 예: "것"→" 것", "변수"→" 변수")은 시트의
        // 순차 치환 매크로다: 일단 전부 띄운 뒤 보정 규칙("이 것"→"이것", "매개 변수"→"매개변수")으로
        // 합성어를 되돌리는 전제라, 단독 점검출로 쓰면 정상 표기(이것·그때·한때·매개변수 등)에서
        // 전부 발화한다 — 같은 시트의 보정 규칙과 정면 모순. 검출 대상에서 제외한다.
        // (붙여쓰기 오류는 "는것"·"할때"·"콜백함수" 같은 명시적 합성 규칙들이 따로 잡는다.)
        if (dst === ' ' + src) continue;
        const entry = {
          src: src,
          dst: dst,
          cat: cat.id,
          len: src.length,
          ord: ord++,
          headAlnum: isAsciiAlnum(src.charCodeAt(0)),
          tailAlnum: isAsciiAlnum(src.charCodeAt(src.length - 1)),
          // 가드 D용: 후미 공백만 추가하는 규칙 ("➊"→"➊ ")
          addsTailSpace: dst === src + ' '
        };
        if (src.length === 1) {
          const b1 = map1.get(src);
          if (b1) b1.push(entry); else map1.set(src, [entry]);
        } else {
          const key = src.slice(0, 2);
          const b2 = map2.get(key);
          if (b2) b2.push(entry); else map2.set(key, [entry]);
        }
        firstCodes.add(src.charCodeAt(0));
        active++;
      }
    }
    map2.forEach(function (bucket) { bucket.sort(byLenDescOrdAsc); });
    map1.forEach(function (bucket) { bucket.sort(byLenDescOrdAsc); });

    state.ready = true;
    state.version = typeof rulesJson.version === 'string' ? rulesJson.version : null;
    state.meta = meta;
    state.map2 = map2;
    state.map1 = map1;
    state.firstCodes = firstCodes;
    return { version: state.version, totalRules: total, activeRules: active };
  }

  // 가드 A(ASCII 단어 경계) + 가드 B(URL·이메일·코드 토큰) + 가드 D(공백 추가 no-op).
  // true면 해당 후보 탈락.
  function rejected(text, start, end, entry) {
    // 가드 A: CamelCase 식별자 내부 오검출 방지
    if (entry.headAlnum && start > 0 && isAsciiAlnum(text.charCodeAt(start - 1))) return true;
    if (entry.tailAlnum && end < text.length && isAsciiAlnum(text.charCodeAt(end))) return true;

    // 가드 D: 후미 공백 추가 규칙("➊"→"➊ ", "인지를"→"인지를 ")은
    // 바로 뒤가 단어 문자(한글·영숫자)에 붙어 있을 때만 오류다.
    // 공백·문말·구두점 앞이면 이미 올바른 사용이므로 표시하지 않는다.
    if (entry.addsTailSpace) {
      if (end >= text.length) return true;
      const nc = text.charCodeAt(end);
      if (!(isAsciiAlnum(nc) || (nc > 160 && nc !== 0x3000))) return true;
    }

    // 가드 B: 양끝 공백을 깎은 코어 기준으로 토큰 확장 (space1의 선행 공백이 토큰에 안 섞이게)
    let cs = start;
    let ce = end;
    while (cs < ce && isSpaceCode(text.charCodeAt(cs))) cs++;
    while (ce > cs && isSpaceCode(text.charCodeAt(ce - 1))) ce--;
    if (cs === ce) return false;
    let ts = cs;
    while (ts > 0 && !isSpaceCode(text.charCodeAt(ts - 1))) ts--;
    let te = ce;
    const n = text.length;
    while (te < n && !isSpaceCode(text.charCodeAt(te))) te++;
    const tokenLen = te - ts;
    if (tokenLen < 4) return false;
    let hasSpecial = false;
    let hasNonAscii = false;
    let urlish = false;
    for (let k = ts; k < te; k++) {
      const c = text.charCodeAt(k);
      if (c < 0x21 || c > 0x7e) { hasNonAscii = true; continue; }
      if (CODE_SPECIALS.has(c)) {
        hasSpecial = true;
        // '://' 포함 토큰은 한글 경로 URL(예: https://ko.wiki/쉘)이어도 URL로 취급
        if (c === 58 && k + 2 < te && text.charCodeAt(k + 1) === 47 && text.charCodeAt(k + 2) === 47) {
          urlish = true;
        }
      }
    }
    if (urlish) return true;
    if (hasNonAscii) return false; // URL이 아닌 비ASCII 포함 토큰(한글 단어 등)은 탈락 대상 아님
    return hasSpecial || tokenLen >= 20;
  }

  function scan(text, opts) {
    if (!state.ready) throw new Error('TypoEngine not initialized');
    if (typeof text !== 'string') throw new Error('TypoEngine.scan: text must be a string');
    const limit = opts && typeof opts.limit === 'number' ? opts.limit : 500;
    const findings = [];
    if (limit <= 0) return { findings: findings, truncated: true };

    const n = text.length;
    const map2 = state.map2;
    const map1 = state.map1;
    const firstCodes = state.firstCodes;
    let truncated = false;
    let i = 0;
    while (i < n) {
      if (!firstCodes.has(text.charCodeAt(i))) { i++; continue; }
      let hit = null;
      // leftmost-longest: 2문자+ 버킷(len 내림차순) 먼저, 그다음 1문자 버킷
      let bucket = i + 1 < n ? map2.get(text[i] + text[i + 1]) : undefined;
      if (bucket) {
        for (let k = 0; k < bucket.length; k++) {
          const e = bucket[k];
          if (i + e.len <= n && text.startsWith(e.src, i) && !rejected(text, i, i + e.len, e)) {
            hit = e;
            break;
          }
        }
      }
      if (!hit) {
        bucket = map1.get(text[i]);
        if (bucket) {
          for (let k = 0; k < bucket.length; k++) {
            const e = bucket[k];
            if (!rejected(text, i, i + 1, e)) {
              hit = e;
              break;
            }
          }
        }
      }
      if (hit) {
        // limit번째까지 채운 뒤에도 스캔을 이어가 (limit+1)번째 매치가 실제로
        // 존재할 때만 truncated를 세운다 — 정확히 limit건이면 "초과" 오표시 금지.
        if (findings.length >= limit) { truncated = true; break; }
        const end = i + hit.len;
        findings.push({ start: i, end: end, src: hit.src, dst: hit.dst, cat: hit.cat });
        i = end; // 비중첩: 채택 구간 끝으로 점프
      } else {
        i++;
      }
    }
    return { findings: findings, truncated: truncated };
  }

  function categories() {
    return state.meta.map(function (m) {
      return { id: m.id, label: m.label, ruleCount: m.ruleCount, enabled: m.enabled };
    });
  }

  globalThis.TypoEngine = {
    init: init,
    scan: scan,
    categories: categories,
    isReady: function () { return state.ready; },
    get version() { return state.version; }
  };
})();
