const TERM_REPORT_MAX_ROWS = 12;
const TERM_PROMPT_MAX_CHARS = 40000;
const LATIN_PARTICLE_ERROR_LIMIT = 12;
const HANGUL_JONG = ['', 'ㄱ', 'ㄲ', 'ㄳ', 'ㄴ', 'ㄵ', 'ㄶ', 'ㄷ', 'ㄹ', 'ㄺ', 'ㄻ', 'ㄼ', 'ㄽ', 'ㄾ', 'ㄿ', 'ㅀ', 'ㅁ', 'ㅂ', 'ㅄ', 'ㅅ', 'ㅆ', 'ㅇ', 'ㅈ', 'ㅊ', 'ㅋ', 'ㅌ', 'ㅍ', 'ㅎ'];
const HANGUL_POSTPOSITION_SUFFIXES = ['으로', '이나', '에서', '에게', '한테', '께서', '처럼', '보다', '마다', '만큼', '밖에', '조차', '마저', '하고', '이며', '이랑', '랑', '은', '는', '이', '가', '을', '를', '과', '와', '도', '만', '에', '의', '로'];

function countChars(value) {
  return Array.from(String(value || '')).length;
}

function cleanShortText(value, max) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

function extractDocId(urlOrId) {
  const value = String(urlOrId || '');
  let m = value.match(/\/document\/(?:u\/\d+\/)?d\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  m = value.match(/\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]+$/.test(value)) return value;
  return '';
}

function normalizeRecommendedTerm(value, variants) {
  const recommended = cleanShortText(value, 120);
  const variantTexts = new Set((Array.isArray(variants) ? variants : []).map(variant => variant && variant.text).filter(Boolean));
  if (recommended === 'MacOS' || recommended === 'Mac OS' || recommended === 'Mac OS X' || recommended === '맥OS' || recommended === '맥 OS' || variantTexts.has('MacOS') || variantTexts.has('Mac OS') || variantTexts.has('Mac OS X') || variantTexts.has('맥OS') || variantTexts.has('맥 OS')) {
    return 'macOS';
  }
  if (recommended === 'Linux' || recommended === 'linux' || recommended === 'LINUX' || variantTexts.has('Linux') || variantTexts.has('linux') || variantTexts.has('LINUX')) {
    return '리눅스';
  }
  if (recommended === 'Windows' || recommended === 'windows' || recommended === 'WINDOWS' || recommended === '윈도우즈' || variantTexts.has('Windows') || variantTexts.has('windows') || variantTexts.has('WINDOWS') || variantTexts.has('윈도우즈')) {
    return '윈도우';
  }
  return recommended || (variants[0] && variants[0].text) || '';
}

function createLocalTermConsistencyEngine(deps = {}) {
  let analyzerPromise = null;
  let rulesPromise = null;
  let groupsPromise = null;

  async function getAnalyzer() {
    if (!analyzerPromise) {
      analyzerPromise = Promise.resolve(deps.loadAnalyzer ? deps.loadAnalyzer() : null)
        .catch(error => {
          analyzerPromise = null;
          groupsPromise = null;
          throw error;
        });
    }
    const analyzer = await analyzerPromise;
    if (!analyzer) {
      analyzerPromise = null;
      groupsPromise = null;
      throw new Error('term consistency analyzer is unavailable');
    }
    return analyzer;
  }

  async function getRules() {
    if (!rulesPromise) {
      rulesPromise = Promise.resolve(deps.loadRules ? deps.loadRules() : null)
        .catch(error => {
          rulesPromise = null;
          groupsPromise = null;
          throw error;
        });
    }
    const rulesJson = await rulesPromise;
    if (!rulesJson || typeof rulesJson !== 'object') {
      rulesPromise = null;
      groupsPromise = null;
      throw new Error('rules.json is unavailable');
    }
    return rulesJson;
  }

  async function getGroups(analyzer, rulesJson) {
    if (!groupsPromise) {
      groupsPromise = Promise.resolve()
        .then(() => buildLocalTermGroups(analyzer, rulesJson))
        .catch(error => {
          groupsPromise = null;
          throw error;
        });
    }
    return groupsPromise;
  }

  return {
    async buildReport(document, settings = {}) {
      const analyzer = await getAnalyzer();
      const rulesJson = await getRules();
      const groups = await getGroups(analyzer, rulesJson);
      return buildLocalTermConsistencyReport(document, settings, {
        analyzer,
        rulesJson,
        groups,
        now: deps.now
      });
    }
  };
}

async function buildLocalTermConsistencyReport(document, settings = {}, deps = {}) {
  const analyzer = deps.analyzer;
  const rulesJson = deps.rulesJson;
  if (!analyzer) throw new Error('term consistency analyzer is required');
  if (!rulesJson || typeof rulesJson !== 'object') throw new Error('rules.json is required');

  const sourceText = String(document && document.text || '');
  const maxDocumentChars = Number.isFinite(Number(settings.maxDocumentChars)) ? Math.max(0, Math.floor(Number(settings.maxDocumentChars))) : TERM_PROMPT_MAX_CHARS;
  const maxChars = Math.min(maxDocumentChars, TERM_PROMPT_MAX_CHARS);
  const text = sourceText.slice(0, maxChars);
  const includedChars = countChars(text);
  const groups = Array.isArray(deps.groups) ? deps.groups : buildLocalTermGroups(analyzer, rulesJson);
  const lexicon = buildDocumentTermLexicon(text);
  const terms = [];

  for (const group of groups) {
    if (!localTermGroupMayAppear(group, lexicon)) continue;
    const variants = [];
    for (const variant of group.variants) {
      const count = countTermOccurrences(text, variant);
      if (count > 0) variants.push({ text: variant, count });
    }
    if (variants.length < 2) continue;
    variants.sort((a, b) => b.count - a.count || a.text.localeCompare(b.text, 'ko'));
    const recommended = normalizeRecommendedTerm(group.recommended, variants);
    terms.push({
      concept: recommended,
      recommended,
      variants,
      severity: 'minor',
      evidence: collectTermEvidence(text, variants, 2),
      reason: '사전의 같은 권장 표기에 속한 용어가 문서 안에서 함께 쓰였습니다.',
      totalCount: variants.reduce((sum, variant) => sum + variant.count, 0)
    });
  }

  terms.push(...findLatinParticleAgreementFindings(analyzer, text, rulesJson));
  terms.sort((a, b) => termSeverityRank(b) - termSeverityRank(a) || b.totalCount - a.totalCount || a.recommended.localeCompare(b.recommended, 'ko'));
  return {
    ok: true,
    checkedAt: typeof deps.now === 'function' ? deps.now() : new Date().toISOString(),
    provider: 'local',
    model: localTermModelName(analyzer),
    elapsedMs: 0,
    docId: document && (document.id || extractDocId(document.url)) || '',
    title: document && document.title || '',
    terms: terms.slice(0, TERM_REPORT_MAX_ROWS),
    notes: terms.length > TERM_REPORT_MAX_ROWS ? [`상위 ${TERM_REPORT_MAX_ROWS}건만 표시했습니다.`] : [],
    includedChars
  };
}

function buildLocalTermGroups(analyzer, rulesJson) {
  const byRecommended = new Map();
  for (const cat of Array.isArray(rulesJson.categories) ? rulesJson.categories : []) {
    for (const rule of Array.isArray(cat.rules) ? cat.rules : []) {
      if (!Array.isArray(rule) || typeof rule[0] !== 'string' || typeof rule[1] !== 'string') continue;
      const src = normalizeTermSurface(rule[0]);
      const dst = normalizeTermSurface(rule[1]);
      if (!src || !dst || src === dst) continue;
      if (!isLocalTermSurface(analyzer, src) || !isLocalTermSurface(analyzer, dst)) continue;
      addLocalTermGroupVariant(byRecommended, dst, src);
      addLocalTermGroupVariant(byRecommended, dst, dst);
    }
  }

  addExplicitLocalTermGroup(byRecommended, 'macOS', ['macOS', 'MacOS', 'Mac OS', 'Mac OS X', '맥OS', '맥 OS']);
  addExplicitLocalTermGroup(byRecommended, '리눅스', ['리눅스', 'Linux', 'linux', 'LINUX']);
  addExplicitLocalTermGroup(byRecommended, '윈도우', ['윈도우', 'Windows', 'windows', 'WINDOWS', '윈도우즈']);

  return Array.from(byRecommended.values())
    .map(group => ({
      recommended: group.recommended,
      variants: Array.from(group.variants).sort((a, b) => b.length - a.length || a.localeCompare(b, 'ko')),
      tokens: Array.from(group.tokens)
    }))
    .filter(group => group.variants.length >= 2)
    .sort((a, b) => a.recommended.localeCompare(b.recommended, 'ko'));
}

function addExplicitLocalTermGroup(map, recommended, variants) {
  for (const variant of variants) addLocalTermGroupVariant(map, recommended, variant);
}

function addLocalTermGroupVariant(map, recommendedText, variantText) {
  const recommended = normalizeTermSurface(recommendedText);
  const variant = normalizeTermSurface(variantText);
  if (!recommended || !variant) return;
  const key = normalizeTermKey(recommended);
  let group = map.get(key);
  if (!group) {
    group = { recommended, variants: new Set(), tokens: new Set() };
    map.set(key, group);
  }
  group.variants.add(variant);
  for (const token of termSurfaceTokens(variant)) group.tokens.add(token);
}

function isLocalTermSurface(analyzer, value) {
  const text = normalizeTermSurface(value);
  if (text.length < 2 || text.length > 40) return false;
  if (/[\n\r\t]/.test(text)) return false;
  if (/[?!,;:“”"‘’`]/.test(text)) return false;
  if (/^[\d\s.,:+#/_()~-]+$/.test(text)) return false;
  if (/\s{2,}/.test(text)) return false;
  const tokens = safeAnalyzeTokens(analyzer, text);
  if (!tokens.length) return /[가-힣A-Za-z]/.test(text);
  let significant = 0;
  for (const token of tokens) {
    const pos = String(token.pos || '');
    const tokenText = String(token.text || '');
    if (!tokenText.trim()) continue;
    if (/^[\s()[\]{}<>.,:+#/_~-]+$/.test(tokenText)) continue;
    if (pos === 'NNG' || pos === 'NNP' || pos === 'SL' || pos === 'SN' || pos === 'SH' || pos === 'XSN') {
      significant++;
      continue;
    }
    return false;
  }
  return significant > 0;
}

function safeAnalyzeTokens(analyzer, text) {
  try {
    const result = analyzer.analyze(text);
    return result && Array.isArray(result.tokens) ? result.tokens : [];
  } catch (_) {
    return [];
  }
}

function buildDocumentTermLexicon(text) {
  const lexicon = new Set();
  const source = normalizeTermSurface(text);
  const tokenPattern = /[A-Za-z][A-Za-z0-9+#.-]{1,40}|[가-힣]{2,40}/g;
  for (const match of source.matchAll(tokenPattern)) {
    addDocumentTermLexiconToken(lexicon, match[0]);
  }
  return lexicon;
}

function addDocumentTermLexiconToken(lexicon, value) {
  const token = normalizeTermSurface(value);
  if (token.length < 2) return;
  lexicon.add(token);
  lexicon.add(normalizeTermKey(token));
  if (!/^[가-힣]+$/.test(token) || token.length < 3) return;
  for (const stem of hangulPostpositionStems(token)) {
    lexicon.add(stem);
    lexicon.add(normalizeTermKey(stem));
  }
}

function hangulPostpositionStems(token) {
  const stems = [];
  for (const suffix of HANGUL_POSTPOSITION_SUFFIXES) {
    if (token.length <= suffix.length + 1 || !token.endsWith(suffix)) continue;
    stems.push(token.slice(0, -suffix.length));
  }
  return stems;
}

function localTermGroupMayAppear(group, lexicon) {
  if (!lexicon.size) return true;
  for (const token of group.tokens) {
    if (lexicon.has(token) || lexicon.has(normalizeTermKey(token))) return true;
  }
  return false;
}

function termSurfaceTokens(value) {
  return normalizeTermSurface(value)
    .split(/[\s()[\]{}<>.,:+#/_~-]+/)
    .map(token => normalizeTermSurface(token))
    .filter(token => token.length >= 2);
}

function normalizeTermSurface(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeTermKey(value) {
  return normalizeTermSurface(value).replace(/\s+/g, '').toLocaleLowerCase('ko');
}

function countTermOccurrences(text, needle) {
  const source = String(text || '');
  const target = normalizeTermSurface(needle);
  if (!target) return 0;
  let count = 0;
  let index = 0;
  while ((index = source.indexOf(target, index)) !== -1) {
    if (termBoundaryOk(source, index, index + target.length, target)) count++;
    index += Math.max(1, target.length);
  }
  return count;
}

function termBoundaryOk(text, start, end, target) {
  const prev = start > 0 ? text[start - 1] : '';
  const next = end < text.length ? text[end] : '';
  if (prev && isTermContinuation(prev)) return false;
  if (!next) return true;
  if (!isTermContinuation(next)) return true;
  if (isAllowedPostpositionStart(next)) return true;
  return false;
}

function isTermContinuation(char) {
  return /[0-9A-Za-z가-힣_]/.test(char);
}

function isAllowedPostpositionStart(char) {
  return '은는이가을를과와도만에의로랑이나'.includes(char);
}

function collectTermEvidence(text, variants, limit) {
  const snippets = [];
  for (const variant of variants) {
    const needle = variant && variant.text;
    if (!needle) continue;
    const index = text.indexOf(needle);
    if (index === -1) continue;
    const start = Math.max(0, index - 35);
    const end = Math.min(text.length, index + needle.length + 35);
    const snippet = text.slice(start, end).replace(/\s+/g, ' ').trim();
    if (snippet) snippets.push(snippet);
    if (snippets.length >= limit) break;
  }
  return snippets;
}

function localTermModelName(analyzer) {
  try {
    const info = analyzer.modelInfo();
    return info && info.version ? `garu-ko ${info.version}` : 'garu-ko';
  } catch (_) {
    return 'garu-ko';
  }
}

function termSeverityRank(term) {
  return term && term.severity === 'major' ? 1 : 0;
}

function findLatinParticleAgreementFindings(analyzer, text, rulesJson) {
  const source = String(text || '');
  const readings = buildLatinReadingInfoMap(analyzer, rulesJson);
  const found = new Map();
  const re = /([A-Za-z][A-Za-z0-9+#-]{1,24})(으로|[이가은는을를과와로])/g;
  let match = null;
  while ((match = re.exec(source)) !== null) {
    const token = match[1];
    const particle = match[2];
    const start = match.index;
    const end = start + token.length + particle.length;
    if (skipLatinParticleCandidate(source, start, start + token.length, end)) continue;
    const surface = token + particle;
    if (!garuSeesLatinParticleEojeol(analyzer, surface, particle)) continue;
    const info = latinTokenParticleInfo(token, readings);
    if (!info) continue;
    const expected = expectedParticleForInfo(info, particle);
    if (!expected || expected === particle) continue;
    const replacement = token + expected;
    const key = surface + '\u0000' + replacement;
    let item = found.get(key);
    if (!item) {
      item = {
        kind: 'particle',
        concept: token + ' 조사',
        recommended: replacement,
        variants: [{ text: surface, count: 0 }],
        severity: 'major',
        evidence: [],
        reason: `영문/약어 "${token}"의 읽기 기준 조사는 "${expected}"가 자연스럽습니다.`,
        totalCount: 0
      };
      found.set(key, item);
    }
    item.variants[0].count++;
    item.totalCount++;
    if (item.evidence.length < 2) {
      const snippet = source.slice(Math.max(0, start - 35), Math.min(source.length, end + 35)).replace(/\s+/g, ' ').trim();
      if (snippet) item.evidence.push(snippet);
    }
  }
  return Array.from(found.values())
    .sort((a, b) => b.totalCount - a.totalCount || a.recommended.localeCompare(b.recommended, 'ko'))
    .slice(0, LATIN_PARTICLE_ERROR_LIMIT);
}

function buildLatinReadingInfoMap(analyzer, rulesJson) {
  const map = new Map();
  const add = (key, reading) => {
    const info = hangulParticleInfo(reading);
    if (!key || !info) return;
    map.set(key, info);
    map.set(key.toLocaleLowerCase('en'), info);
  };
  for (const [key, reading] of Object.entries({
    Git: '깃',
    Mac: '맥',
    Linux: '리눅스',
    Windows: '윈도우',
    Docker: '도커',
    React: '리액트',
    Rust: '러스트',
    Python: '파이썬',
    Java: '자바',
    JavaScript: '자바스크립트',
    TypeScript: '타입스크립트',
    Kubernetes: '쿠버네티스'
  })) {
    add(key, reading);
  }

  for (const cat of Array.isArray(rulesJson.categories) ? rulesJson.categories : []) {
    for (const rule of Array.isArray(cat.rules) ? cat.rules : []) {
      if (!Array.isArray(rule) || typeof rule[0] !== 'string' || typeof rule[1] !== 'string') continue;
      const src = normalizeTermSurface(rule[0]);
      const dst = normalizeTermSurface(rule[1]);
      if (!/^[A-Za-z][A-Za-z0-9+#-]{1,24}$/.test(src) || !/[가-힣]/.test(dst)) continue;
      if (!isLocalTermSurface(analyzer, dst)) continue;
      add(src, dst);
    }
  }
  return map;
}

function latinTokenParticleInfo(token, readings) {
  const text = String(token || '');
  if (!text) return null;
  const fromMap = readings.get(text) || readings.get(text.toLocaleLowerCase('en'));
  if (fromMap) return fromMap;
  if (!isSafeAcronymLikeToken(text)) return null;
  const last = lastPronouncedLatinTokenChar(text);
  if (!last) return null;
  if (/[0-9]/.test(last)) return digitParticleInfo(last);
  if (last === '#') return { hasBatchim: true, jong: 'ㅂ' };
  if (last === '+') return { hasBatchim: false, jong: '' };
  return latinLetterParticleInfo(last);
}

function isSafeAcronymLikeToken(token) {
  const text = String(token || '');
  if (text.length < 2 || text.length > 25) return false;
  if (!/^[A-Z0-9+#-]+$/.test(text)) return false;
  if (!/[A-Z]/.test(text)) return false;
  if (/--|\+\+.+\+|##/.test(text)) return false;
  return true;
}

function lastPronouncedLatinTokenChar(token) {
  const chars = Array.from(String(token || '')).filter(ch => /[A-Z0-9+#]/.test(ch));
  return chars.length ? chars[chars.length - 1] : '';
}

function latinLetterParticleInfo(letter) {
  const ch = String(letter || '').toUpperCase();
  if (ch === 'L' || ch === 'R') return { hasBatchim: true, jong: 'ㄹ' };
  if (ch === 'M') return { hasBatchim: true, jong: 'ㅁ' };
  if (ch === 'N') return { hasBatchim: true, jong: 'ㄴ' };
  return { hasBatchim: false, jong: '' };
}

function digitParticleInfo(digit) {
  const jongByDigit = {
    '0': 'ㅇ',
    '1': 'ㄹ',
    '2': '',
    '3': 'ㅁ',
    '4': '',
    '5': '',
    '6': 'ㄱ',
    '7': 'ㄹ',
    '8': 'ㄹ',
    '9': ''
  };
  const jong = jongByDigit[String(digit)] || '';
  return { hasBatchim: !!jong, jong };
}

function hangulParticleInfo(value) {
  const chars = Array.from(String(value || '')).filter(ch => /[가-힣]/.test(ch));
  if (!chars.length) return null;
  const code = chars[chars.length - 1].charCodeAt(0) - 0xAC00;
  if (code < 0 || code > 11171) return null;
  const jong = HANGUL_JONG[code % 28] || '';
  return { hasBatchim: !!jong, jong };
}

function expectedParticleForInfo(info, particle) {
  const has = !!(info && info.hasBatchim);
  const jong = info && info.jong || '';
  const p = String(particle || '');
  if (p === '이' || p === '가') return has ? '이' : '가';
  if (p === '은' || p === '는') return has ? '은' : '는';
  if (p === '을' || p === '를') return has ? '을' : '를';
  if (p === '과' || p === '와') return has ? '과' : '와';
  if (p === '으로' || p === '로') return has && jong !== 'ㄹ' ? '으로' : '로';
  return '';
}

function garuSeesLatinParticleEojeol(analyzer, surface, particle) {
  const tokens = safeAnalyzeTokens(analyzer, surface);
  if (!tokens.length) return false;
  const hasLatin = tokens.some(token => token && token.pos === 'SL');
  const hasParticle = tokens.some(token => token && String(token.text || '') === particle && /^J/.test(String(token.pos || '')));
  if (!hasLatin || !hasParticle) return false;
  return tokens.every(token => {
    const pos = String(token && token.pos || '');
    return pos === 'SL' || pos === 'SN' || pos === 'SW' || /^J/.test(pos);
  });
}

function skipLatinParticleCandidate(text, tokenStart, tokenEnd, end) {
  const prev = tokenStart > 0 ? text[tokenStart - 1] : '';
  const next = end < text.length ? text[end] : '';
  if (prev && /[0-9A-Za-z_./:@-]/.test(prev)) return true;
  if (next && /[0-9A-Za-z_]/.test(next)) return true;
  const token = text.slice(tokenStart, tokenEnd);
  if (/^-|-$/.test(token)) return true;
  if (/https?$/i.test(text.slice(Math.max(0, tokenStart - 8), tokenStart))) return true;
  return false;
}

export {
  TERM_REPORT_MAX_ROWS,
  TERM_PROMPT_MAX_CHARS,
  createLocalTermConsistencyEngine,
  buildLocalTermConsistencyReport,
  extractDocId,
  normalizeRecommendedTerm
};
