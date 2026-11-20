const TERM_REPORT_MAX_ROWS = 12;
const TERM_PROMPT_MAX_CHARS = 40000;
const LATIN_PARTICLE_ERROR_LIMIT = 12;
// 로컬 분석은 LLM 프롬프트 제한과 무관하므로 행 수와 분석 범위를 따로 둔다.
const LOCAL_TERM_REPORT_MAX_ROWS = 60;
const LOCAL_TERM_MAX_CHARS = 200000;
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
  const maxChars = Math.min(maxDocumentChars, LOCAL_TERM_MAX_CHARS);
  const text = sourceText.slice(0, maxChars);
  const includedChars = countChars(text);
  const groups = Array.isArray(deps.groups) ? deps.groups : buildLocalTermGroups(analyzer, rulesJson);

  const ctx = createTermScanContext(analyzer, text);
  const lexicon = buildDocumentTermLexicon(ctx);
  const activeGroups = groups.filter(group => localTermGroupMayAppear(group, lexicon));

  // 후보 묶음: 사전(rules.json + 내장 IT 용어) → 문서에서 스스로 찾은 표기 차이.
  const protos = [];
  for (const group of activeGroups) {
    protos.push({
      surfaces: new Set(group.variants),
      kind: group.kind || 'dictionary',
      recommended: group.recommended,
      fixed: group.fixed !== false,
      source: group.source || 'rules'
    });
  }
  protos.push(...discoverHangulSpellingGroups(ctx));
  protos.push(...discoverSpacingGroups(ctx));
  protos.push(...discoverLatinCaseGroups(ctx));
  protos.push(...discoverGlossGroups(ctx));
  extendLatinSurfaces(ctx, protos);

  // 문서에 한 표기만 있는 묶음이 다른 묶음의 자리를 차지하지 않도록(예: "버전 관리"가 "버전"을 가림)
  // 먼저 따로 세어 혼용 후보만 남기고, 남은 묶음끼리만 겹침을 정리해 다시 센다.
  let merged = mergeTermProtoGroups(protos);
  let counts = countTermSurfaces(ctx, merged, false);
  for (let pass = 0; pass < 4; pass++) {
    const viable = merged.filter(group => Array.from(group.surfaces).filter(surface => counts.has(surface)).length >= 2);
    const stable = pass > 0 && viable.length === merged.length;
    merged = viable;
    if (stable) break;
    counts = countTermSurfaces(ctx, merged, true);
  }
  const terms = [];
  for (const group of merged) {
    const variants = [];
    for (const surface of group.surfaces) {
      const hit = counts.get(surface);
      if (hit && hit.count > 0) variants.push({ text: surface, count: hit.count });
    }
    if (variants.length < 2) continue;
    variants.sort((a, b) => b.count - a.count || a.text.localeCompare(b.text, 'ko'));
    const present = new Set(variants.map(variant => variant.text));
    const found = new Set();
    for (const proto of group.protos) {
      const used = Array.from(proto.surfaces).filter(surface => present.has(surface));
      if (used.length >= 2) found.add(proto.source === 'builtin' ? classifyTermVariants(used, proto.kind) : proto.kind);
    }
    const kinds = TERM_KIND_ORDER.filter(name => found.has(name));
    const kind = kinds[0] || primaryTermKind(group.kinds);
    const recommended = normalizeRecommendedTerm(chooseRecommendedTerm(ctx, counts, group, variants, groups), variants);
    terms.push({
      kind,
      kinds: kinds.length ? kinds : [kind],
      concept: recommended,
      recommended,
      variants,
      severity: 'minor',
      evidence: collectTermEvidence(text, variants, counts, 2),
      reason: termKindReason(kinds.length ? kinds : [kind]),
      totalCount: variants.reduce((sum, variant) => sum + variant.count, 0)
    });
  }

  terms.sort((a, b) => termKindRank(b) - termKindRank(a) || b.totalCount - a.totalCount || a.recommended.localeCompare(b.recommended, 'ko'));
  // 조사 오류 행은 자체 상한(LATIN_PARTICLE_ERROR_LIMIT)이 있으므로 혼용 행 상한과 따로 센다.
  const particles = findLatinParticleAgreementFindings(analyzer, text, rulesJson);
  const shown = terms.slice(0, LOCAL_TERM_REPORT_MAX_ROWS);
  return {
    ok: true,
    checkedAt: typeof deps.now === 'function' ? deps.now() : new Date().toISOString(),
    provider: 'local',
    model: localTermModelName(analyzer),
    elapsedMs: 0,
    docId: document && (document.id || extractDocId(document.url)) || '',
    title: document && document.title || '',
    terms: particles.concat(shown),
    notes: terms.length > shown.length ? [`혼용 용어 ${terms.length}건 중 상위 ${shown.length}건만 표시했습니다.`] : [],
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

  const toGroup = group => ({
    recommended: group.recommended,
    variants: Array.from(group.variants).sort((a, b) => b.length - a.length || a.localeCompare(b, 'ko')),
    tokens: Array.from(group.tokens)
  });
  const ruleGroups = Array.from(byRecommended.values())
    .map(toGroup)
    .filter(group => group.variants.length >= 2)
    .sort((a, b) => a.recommended.localeCompare(b.recommended, 'ko'));

  // 내장 IT 용어 묶음. rules.json과 겹치면 병합 단계에서 한 행이 되고 권장 표기는 rules.json이 이긴다.
  const builtinGroups = [];
  for (const [kind, lines] of Object.entries(BUILTIN_TERM_GROUPS)) {
    for (const line of lines) {
      const fixed = line.startsWith('!');
      const variants = (fixed ? line.slice(1) : line).split('|').map(normalizeTermSurface).filter(Boolean);
      if (variants.length < 2) continue;
      const map = new Map();
      addExplicitLocalTermGroup(map, variants[0], variants);
      const group = toGroup(map.values().next().value);
      // "셸|쉘"처럼 한 글자 용어도 문서 어휘와 맞춰 볼 수 있게 토큰 길이 제한을 두지 않는다.
      const tokens = Array.from(new Set(variants.flatMap(variant => variant.split(/[\s()[\]{}<>.,:+#/_~-]+/)).filter(Boolean)));
      builtinGroups.push({ ...group, tokens, variants, kind, fixed, source: 'builtin' });
    }
  }
  return ruleGroups.concat(builtinGroups);
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

function buildDocumentTermLexicon(ctx) {
  const lexicon = new Set();
  for (const token of ctx.tokens) {
    addDocumentTermLexiconToken(lexicon, token.s);
    if (token.latin) {
      for (const part of token.s.split(/[.\-+#]+/)) addDocumentTermLexiconToken(lexicon, part);
    } else {
      const stem = ctx.runStem.get(token.s);
      if (stem) addDocumentTermLexiconToken(lexicon, stem);
    }
  }
  return lexicon;
}

function addDocumentTermLexiconToken(lexicon, value) {
  const token = normalizeTermSurface(value);
  if (!token) return;
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

// ───────── 용어 혼용 탐지: 종류, 내장 사전 ─────────

const TERM_KIND_REASON = {
  dictionary: '사전의 같은 권장 표기에 속한 용어가 문서 안에서 함께 쓰였습니다.',
  spelling: '철자만 조금 다른 외래어 표기가 함께 쓰였습니다.',
  case: '대소문자나 구분 기호만 다른 영문 표기가 함께 쓰였습니다.',
  spacing: '띄어쓰기만 다른 표기가 함께 쓰였습니다.',
  script: '같은 이름을 한글과 영문으로 섞어 썼습니다.',
  synonym: '같은 대상을 가리키는 용어(약어·번역어)가 함께 쓰였습니다.'
};
const TERM_KIND_LABEL = { dictionary: '사전 등재 표기', spelling: '철자', case: '대소문자', spacing: '띄어쓰기', script: '한글·영문', synonym: '약어·번역어' };
const TERM_KIND_ORDER = ['dictionary', 'spelling', 'case', 'spacing', 'script', 'synonym'];
const TERM_KIND_RANK = { dictionary: 3, spelling: 3, case: 3, spacing: 2, script: 1, synonym: 1 };

// 줄 하나가 한 묶음이다. 첫 표기는 빈도가 같을 때 권장 표기가 되고, '!'로 시작하면 빈도와 무관하게 권장 표기다.
// 영문 표기는 대소문자·구분 기호가 달라도 같은 묶음으로 센다(첫 영문 표기가 정식 표기).
const BUILTIN_TERM_GROUPS = {
  spelling: [
    '!인터페이스|인터훼이스|인터패이스', '!알고리즘|알고리듬|앨거리즘', '!파일|화일', '!소프트웨어|소프트웨이|쏘프트웨어',
    '!프레임워크|프레임웍|프레임 워크', '!네트워크|네트웍|넷워크', '리포지토리|레포지토리|리파지토리|레파지토리|리포지터리',
    '파라미터|패러미터|파라메터', '릴리스|릴리즈', '어노테이션|애너테이션|애노테이션', '어댑터|아답터|어답터', '어설션|어서션',
    '레이블|라벨', '컬러|칼라|컬라', '포털|포탈', '제네릭|제너릭', '콘셉트|컨셉|컨셉트|콘셉', '심벌|심볼', '블록|블럭',
    '튜플|투플|터플', '불리언|불린|부울리언', '액세스|엑세스|억세스', '카탈로그|카달로그', '워크플로|워크플로우', '섀도|섀도우|쉐도우',
    '세마포어|세마포', '스레드|쓰레드', '타깃|타겟', '셸|쉘', '캐시|캐쉬', '시프트|쉬프트', '밸류|벨류', '컬럼|칼럼', '로봇|로보트',
    '블록체인|블럭체인', '유튜브|유투브', '파이썬|파이선', '주피터|쥬피터', '배시|배쉬', '파워셸|파워쉘', '텐서플로|텐서플로우',
    '쿠버네티스|쿠버네테스', '깃허브|깃헙', '판다스|팬더스', '코랩|콜랩', '엘라스틱서치|일래스틱서치',
    '!프로퍼티|프라퍼티', '!컨트롤|콘트롤', '!커맨드|코맨드|커멘드', '!컴파일|콤파일', '!컴퓨터|콤퓨터|컴퓨타', '!프록시|프락시',
    '!카테고리|카테거리', '!메커니즘|메카니즘', '!모니터|모니타', '!센터|센타', '!다이얼로그|다이알로그', '!엘리먼트|엘리멘트',
    '!도큐먼트|도큐멘트|다큐먼트', '!세그먼트|세그멘트', '!레퍼런스|리퍼런스', '!플랫폼|플렛폼', '!트랜잭션|트랜젝션', '!매뉴얼|메뉴얼',
    '!대시보드|대쉬보드', '!스케줄|스케쥴', '!비주얼|비쥬얼', '!버전|버젼', '!텍스처|텍스쳐', '!캡처|캡쳐', '!피처|피쳐',
    '!리더십|리더쉽', '!멤버십|멤버쉽', '!시뮬레이션|시물레이션', '!솔루션|솔류션', '!패키지|페키지|팩키지', '!태스크|테스크',
    '!렌더링|랜더링', '!플래그|플레그', '!해시|해쉬', '!플래시|플래쉬', '!대시|대쉬', '!푸시|푸쉬', '!스위치|스윗치', '!매핑|맵핑',
    '!세팅|셋팅', '!커넥션|코넥션', '!콘솔|컨솔', '컨텍스트|콘텍스트', '콘퍼런스|컨퍼런스', '팩토리|팩터리', '리팩터링|리팩토링',
    '싱글턴|싱글톤'
  ],
  script: [
    '리액트|React', '자바스크립트|JavaScript|자바 스크립트', '타입스크립트|TypeScript|타입 스크립트', '파이썬|Python', '자바|Java',
    '코틀린|Kotlin', '스위프트|Swift', '러스트|Rust', '루비|Ruby', '스칼라|Scala', '하스켈|Haskell', '다트|Dart', '플러터|Flutter',
    '도커|Docker', '쿠버네티스|Kubernetes', '깃|Git', '깃허브|GitHub|깃 허브', '깃랩|GitLab', 'Node.js|NodeJS|노드JS', 'Vue.js|VueJS|뷰JS',
    'Next.js|NextJS|넥스트JS', '앵귤러|Angular', '스벨트|Svelte', '스프링|Spring', '스프링 부트|Spring Boot|스프링부트|SpringBoot',
    '장고|Django', '플라스크|Flask', '패스트API|FastAPI', '텐서플로|TensorFlow', '파이토치|PyTorch', '케라스|Keras', '넘파이|NumPy',
    '판다스|pandas', '맷플롯립|Matplotlib', '주피터|Jupyter', '우분투|Ubuntu', '유닉스|Unix', '안드로이드|Android', 'iOS|아이오에스',
    '크롬|Chrome', '파이어폭스|Firefox', '사파리|Safari', '구글|Google', '마이크로소프트|Microsoft', '애플|Apple', '아마존|Amazon',
    '오픈AI|OpenAI|Open AI', '챗GPT|ChatGPT|Chat GPT|챗지피티', '클로드|Claude', '제미나이|Gemini', '코파일럿|Copilot',
    'VS Code|VSCode|Visual Studio Code|비주얼 스튜디오 코드|VS코드', '인텔리제이|IntelliJ', '이클립스|Eclipse', '엑셀|Excel',
    '파워포인트|PowerPoint', '노션|Notion', '슬랙|Slack', '피그마|Figma', '유니티|Unity', '아두이노|Arduino',
    '라즈베리 파이|Raspberry Pi|라즈베리파이', '레디스|Redis', '몽고DB|MongoDB|몽고디비', 'MySQL|마이SQL', 'PostgreSQL|Postgres|포스트그레SQL',
    '오라클|Oracle', '카프카|Kafka', '엘라스틱서치|Elasticsearch', '스파크|Spark', '하둡|Hadoop', '엔진엑스|Nginx', '아파치|Apache',
    '톰캣|Tomcat', '젠킨스|Jenkins', '테라폼|Terraform', '앤서블|Ansible', '그래들|Gradle', '메이븐|Maven', '웹팩|Webpack', '바벨|Babel',
    '리덕스|Redux', '제이쿼리|jQuery', '부트스트랩|Bootstrap', '테일윈드|Tailwind', '익스프레스|Express', '랭체인|LangChain',
    '허깅페이스|Hugging Face|HuggingFace|허깅 페이스', '캐글|Kaggle', '코랩|Colab', '아나콘다|Anaconda', '배시|Bash', '파워셸|PowerShell',
    '비트코인|Bitcoin', '이더리움|Ethereum', '애저|Azure', '파이어베이스|Firebase', '그래프QL|GraphQL', '웹소켓|WebSocket|웹 소켓',
    '와이파이|Wi-Fi|WiFi', '블루투스|Bluetooth', '유튜브|YouTube', '페이스북|Facebook', '인스타그램|Instagram', '링크드인|LinkedIn',
    '스택 오버플로|Stack Overflow|StackOverflow|스택오버플로|스택 오버플로우|스택오버플로우', '위키백과|위키피디아|Wikipedia',
    '프런트엔드|프론트엔드|프런트 엔드|프론트 엔드|Frontend|Front-end', '백엔드|백 엔드|Backend|Back-end', '이메일|Email|E-mail|전자우편'
  ],
  synonym: [
    '데이터베이스|DB|디비', '운영체제|OS|운영 체제|오퍼레이팅 시스템', '인공지능|AI|인공 지능', '머신러닝|ML|기계학습|기계 학습|머신 러닝',
    '딥러닝|딥 러닝|심층학습|심층 학습', '대규모 언어 모델|LLM|거대 언어 모델|대형 언어 모델', '사용자 인터페이스|UI|유저 인터페이스',
    '사용자 경험|UX|유저 경험', '자연어 처리|NLP|자연어처리', '객체 지향 프로그래밍|OOP|객체지향 프로그래밍', '통합 개발 환경|IDE',
    '가상 머신|VM|가상머신|버추얼 머신', '풀 리퀘스트|PR|풀리퀘스트|Pull Request', '명령줄 인터페이스|CLI|커맨드 라인 인터페이스',
    '사물인터넷|IoT|사물 인터넷', '검색 증강 생성|RAG', '가비지 컬렉션|GC|가비지 콜렉션|쓰레기 수집',
    '하위 클래스|서브클래스|자식 클래스|서브 클래스|하위클래스|자식클래스', '상위 클래스|슈퍼클래스|부모 클래스|수퍼클래스|슈퍼 클래스|상위클래스|부모클래스',
    '매개변수|파라미터|매개 변수', '인수|인자|아규먼트|아규멘트', '반환값|리턴값|반환 값|리턴 값', '문자열|스트링', '배열|어레이',
    '예외|익셉션', '객체|오브젝트', '명령줄|커맨드라인|커맨드 라인|명령행|명령 줄', '자료구조|데이터 구조|자료 구조',
    '자료형|데이터 타입|데이터형|데이터타입', '신경망|뉴럴 네트워크|뉴럴넷', '교착 상태|데드락|교착상태', '앱|어플'
  ]
};

// 표기만 비슷할 뿐 서로 다른 말이라 묶으면 안 되는 쌍.
const TERM_FUZZY_DENY = new Set(['퍼스트|포스트', '익스퍼트|익스포트', '언로드|온로드', '스카프|스코프', '파스타|포스터', '매트릭스|메트릭스', '트래킹|트레킹']);
// "웹 사이트/웹사이트"처럼 한 글자 앞말로도 띄어쓰기 혼용을 볼 만한 외래어.
const TERM_MONO_HEADS = new Set(Array.from('웹앱깃백풀탭폼맵셸쉘훅락큐힙핀툴봇팀칩넷빅딥핫톱탑뷰키팝킷팩록링룸랩맥줌'));

const TERM_STRONG_PARTICLES = ['이', '가', '은', '는', '을', '를', '과', '와', '도', '만', '의', '에', '로', '으로', '랑', '이랑', '이나', '에서', '에게', '한테', '께서', '부터', '까지', '마다', '처럼', '보다', '하고', '이며', '조차', '마저', '밖에', '만큼', '대로', '로서', '으로서', '로써', '으로써', '이라는', '라는', '이라고', '라고', '이란', '란', '입니다', '이다', '이고', '이지만', '이면', '이므로', '인데', '인지', '이라도', '라도'];
const TERM_WEAK_PARTICLES = ['다', '인', '일', '임', '며', '면', '나', '고', '였다', '이었다', '이어야', '여야', '이기', '이죠', '죠', '예요', '이에요'];
const TERM_PARTICLE_FOLLOW = '(?:는|도|만|의|을|를|이|가|에|과|와|로)?';
const TERM_STRONG_TAIL_RE = new RegExp('^(?:들$|(?:들)?(?:' + TERM_STRONG_PARTICLES.join('|') + ')' + TERM_PARTICLE_FOLLOW + '$)');
const TERM_WEAK_TAIL_RE = new RegExp('^(?:들$|(?:들)?(?:' + TERM_STRONG_PARTICLES.concat(TERM_WEAK_PARTICLES).join('|') + ')' + TERM_PARTICLE_FOLLOW + '$)');
const TERM_NOUN_POS = new Set(['NNG', 'NNP', 'SL', 'SH', 'SN', 'XPN']);
const TERM_FUNCTION_POS_RE = /^(?:J|E|VCP|VCN|XSV|XSA|VX)/;

function primaryTermKind(kinds) {
  for (const kind of TERM_KIND_ORDER) if (kinds.has(kind)) return kind;
  return 'dictionary';
}

function termKindRank(term) {
  const kinds = term && Array.isArray(term.kinds) ? term.kinds : [];
  return Math.max(0, ...kinds.map(kind => TERM_KIND_RANK[kind] || 0));
}

// 내장 사전 묶음은 한 줄에 여러 종류의 변형이 섞여 있으므로 실제로 쓰인 표기를 보고 종류를 정한다.
function classifyTermVariants(surfaces, fallback) {
  const latin = surfaces.filter(isLatinSurface);
  if (latin.length === surfaces.length) return 'case';
  if (latin.length) return latin.every(surface => surface === surface.toUpperCase()) ? 'synonym' : 'script';
  const joined = new Set(surfaces.map(surface => surface.replace(/\s+/g, '')));
  if (joined.size === 1) return 'spacing';
  const folds = new Set(Array.from(joined, surface => (termFuzzyKeys(surface) || {}).fold || surface));
  if (folds.size === 1) return 'spelling';
  return fallback === 'script' ? 'synonym' : fallback;
}

function termKindReason(kinds) {
  if (kinds.length <= 1) return TERM_KIND_REASON[kinds[0]] || TERM_KIND_REASON.dictionary;
  return `같은 용어를 여러 표기(${kinds.map(kind => TERM_KIND_LABEL[kind]).join(', ')})로 섞어 썼습니다.`;
}

function isHangulSyllable(char) {
  return !!char && char >= '가' && char <= '힣';
}

function isTermContinuation(char) {
  return /[0-9A-Za-z가-힣_]/.test(char);
}

function isLatinSurface(value) {
  return /^[A-Za-z][A-Za-z0-9+#.\- ]*$/.test(value);
}

function latinTermKey(value) {
  return String(value || '').replace(/[.\-\s]+/g, '').toLocaleLowerCase('en');
}

let builtinLatinCanonical = null;
// 영문 정식 표기(키 → 표기). "Javascript"가 더 많이 쓰였어도 권장 표기는 "JavaScript"로 잡는다.
function latinCanonicalSurface(value) {
  if (!builtinLatinCanonical) {
    builtinLatinCanonical = new Map();
    const lines = Object.values(BUILTIN_TERM_GROUPS).flat().concat(['macOS', 'Linux', 'Windows']);
    for (const line of lines) {
      for (const variant of line.replace(/^!/, '').split('|')) {
        const key = latinTermKey(variant);
        if (isLatinSurface(variant) && !builtinLatinCanonical.has(key)) builtinLatinCanonical.set(key, variant);
      }
    }
  }
  return builtinLatinCanonical.get(latinTermKey(value)) || '';
}

// ───────── 문서 스캔: 어절 → 용어(조사·어미 제거) ─────────

function createTermScanContext(analyzer, text) {
  const ctx = {
    analyzer,
    text,
    tokens: [],
    runInfo: new Map(),
    runStem: new Map(),
    unknownStems: new Set(),
    vocab: new Map(),
    latin: new Map(),
    tailCache: new Map()
  };
  const re = /[A-Za-z][A-Za-z0-9+#]*(?:[.\-][A-Za-z0-9+#]+)*|[가-힣]+/g;
  for (const match of text.matchAll(re)) {
    const s = match[0];
    const start = match.index;
    const prev = start > 0 ? text[start - 1] : '';
    ctx.tokens.push({ s, start, end: start + s.length, latin: s.charCodeAt(0) < 128, attached: !!prev && isTermContinuation(prev) });
  }
  buildHangulVocabulary(ctx);
  buildLatinIndex(ctx);
  return ctx;
}

// 어절 하나를 형태소 분석해 앞쪽 명사 덩어리(용어)와 뒤쪽 조사·어미를 가른다.
// 전체 문서를 한 번에 분석하면 매우 느리므로 어절 단위로 분석하고 결과를 캐시한다.
function analyzeHangulRun(ctx, run) {
  let info = ctx.runInfo.get(run);
  if (info) return info;
  info = { kind: 'other', stem: '' };
  if (run.length <= 40) {
    const tokens = safeAnalyzeTokens(ctx.analyzer, run);
    let stem = '';
    let i = 0;
    for (; i < tokens.length; i++) {
      const pos = String(tokens[i].pos || '');
      const piece = String(tokens[i].text || '');
      const nounish = TERM_NOUN_POS.has(pos) || (pos === 'XSN' && i > 0 && piece !== '들');
      if (!nounish || !run.startsWith(stem + piece)) break;
      stem += piece;
    }
    let clean = stem.length > 0;
    for (let j = i; clean && j < tokens.length; j++) {
      const pos = String(tokens[j].pos || '');
      if (!TERM_FUNCTION_POS_RE.test(pos) && !(pos === 'XSN' && tokens[j].text === '들')) clean = false;
    }
    if (clean) info = { kind: 'noun', stem };
  }
  ctx.runInfo.set(run, info);
  return info;
}

function hangulHasBatchim(char) {
  const code = String(char || '').charCodeAt(0) - 0xAC00;
  if (!(code >= 0 && code <= 11171)) return null;
  return HANGUL_JONG[code % 28] || '';
}

// "전문가"를 "전문+가"로 자르지 않도록, 받침과 조사 형태가 맞는지 본다.
function particleAgrees(lastChar, tail) {
  const jong = hangulHasBatchim(lastChar);
  if (jong === null) return true;
  const rest = tail.replace(/^들/, '');
  if (rest !== tail || !rest) return true;
  if (/^(?:은|을|과|이$|이랑|이나|이며|이라는|이라고|이란|이라도)/.test(rest)) return !!jong;
  if (/^으로/.test(rest)) return !!jong && jong !== 'ㄹ';
  if (/^로/.test(rest)) return !jong || jong === 'ㄹ';
  if (/^(?:는|를|와|가|랑|라는|라고|란|라도)/.test(rest)) return !jong;
  return true;
}

// 조사가 붙었을 가능성이 있는 어절에서 조사를 뗀 후보(짧은 것부터).
function strippedStemCandidates(run, minLength) {
  const out = [];
  for (let k = minLength; k < run.length; k++) {
    const tail = run.slice(k);
    if (TERM_STRONG_TAIL_RE.test(tail) && particleAgrees(run[k - 1], tail)) out.push(run.slice(0, k));
  }
  return out;
}

function bump(map, key, n) {
  map.set(key, (map.get(key) || 0) + n);
}

function buildHangulVocabulary(ctx) {
  const freq = new Map();
  for (const token of ctx.tokens) {
    if (!token.latin && !token.attached) bump(freq, token.s, 1);
  }
  const trusted = new Map();
  const suspects = [];
  for (const [run, n] of freq) {
    const info = analyzeHangulRun(ctx, run);
    // 분석기는 모르는 외래어 표기를 "콤포넌트가/NNG"처럼 조사째 한 명사로 내놓는다.
    // 통째 명사인데 조사로 끝나거나, 명사로 풀리지 않은 긴 어절은 일단 의심 목록에 둔다.
    const wholeNoun = info.kind === 'noun' && info.stem === run;
    if (info.kind === 'noun' && !(wholeNoun && run.length >= 3 && strippedStemCandidates(run, 2).length)) {
      bump(trusted, info.stem, n);
      ctx.runStem.set(run, info.stem);
    } else if (info.kind === 'noun' || run.length >= 4) {
      suspects.push({ run, n, noun: info.kind === 'noun' });
    } else {
      ctx.runStem.set(run, '');
    }
  }

  const accept = (item, stem) => {
    bump(trusted, stem, item.n);
    ctx.runStem.set(item.run, stem);
  };
  // (0) "결과"처럼 다른 어절("결과를")에서 이미 같은 명사로 확인된 것은 그대로 둔다.
  let pending = [];
  for (const item of suspects) {
    if (item.noun && trusted.has(item.run)) accept(item, item.run);
    else pending.push(item);
  }
  // (1) 조사를 뗀 형태가 확인된 용어와 같거나 표기만 다르면 그 형태가 용어다.
  const index = createTermFuzzyIndex(trusted.keys());
  const trustedBefore = new Set(trusted.keys());
  const resolved = [];
  let rest = [];
  for (const item of pending) {
    const alt = strippedStemCandidates(item.run, 2).find(cand => trusted.has(cand) || index.neighbors(cand).length);
    if (alt) resolved.push([item, alt]);
    else rest.push(item);
  }
  for (const [item, alt] of resolved) {
    accept(item, alt);
    if (!trustedBefore.has(alt)) ctx.unknownStems.add(alt);
  }
  // (2) 모르는 표기끼리: 같은 어간에 다른 조사가 붙었거나("인터훼이스를/인터훼이스가") 어간 표기만 다른 경우.
  const owners = new Map();
  for (const item of rest) {
    if (!item.noun) continue;
    for (const cand of strippedStemCandidates(item.run, 3)) {
      if (!owners.has(cand)) owners.set(cand, new Set());
      owners.get(cand).add(item.run);
    }
  }
  const altIndex = createTermFuzzyIndex(owners.keys());
  for (const item of rest) {
    let alt = '';
    if (item.noun) {
      alt = strippedStemCandidates(item.run, 3).find(cand => owners.get(cand).size >= 2 ||
        altIndex.neighbors(cand).some(other => !owners.get(other).has(item.run))) || '';
    }
    if (alt) {
      accept(item, alt);
      ctx.unknownStems.add(alt);
    } else if (item.noun) accept(item, item.run);
    else ctx.runStem.set(item.run, '');
  }
  ctx.vocab = trusted;
}

// 붙어 있는 어절("API를"의 "를")처럼 어휘 수집에서 빠진 어절도 필요할 때 어간을 구한다.
function resolveRunStem(ctx, run) {
  if (ctx.runStem.has(run)) return ctx.runStem.get(run);
  const info = analyzeHangulRun(ctx, run);
  return info.kind === 'noun' ? info.stem : '';
}

// ───────── 외래어 표기 변형 정규화 ─────────

const HANGUL_CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
const HANGUL_JUNG = 'ㅏㅐㅑㅒㅓㅔㅕㅖㅗㅘㅙㅚㅛㅜㅝㅞㅟㅠㅡㅢㅣ';
const TERM_CHO_FOLD = { 'ㄲ': 'ㅋ', 'ㄸ': 'ㅌ', 'ㅃ': 'ㅍ', 'ㅆ': 'ㅅ', 'ㅉ': 'ㅊ' };
const TERM_GLIDE_FOLD = { 'ㅑ': 'ㅏ', 'ㅕ': 'ㅓ', 'ㅛ': 'ㅗ', 'ㅠ': 'ㅜ' };
const TERM_VOWEL_FOLD = { 'ㅐ': 'ㅔ', 'ㅒ': 'ㅖ', 'ㅙ': 'ㅚ', 'ㅞ': 'ㅚ', 'ㅏ': 'ㅓ', 'ㅗ': 'ㅓ' };
const TERM_JONG_FOLD = { 'ㄷ': 'ㅅ', 'ㅌ': 'ㅅ', 'ㅋ': 'ㄱ', 'ㅍ': 'ㅂ' };
const termFuzzyKeyCache = new Map();

// 흔한 외래어 표기 흔들림을 한 형태로 접는다.
// 데이타/데이터·컴/콤(ㅏㅓㅗ), 액세스/엑세스(ㅐㅔ), 스케쥴/스케줄(쥬→주), 캐쉬/캐시(쉬→시), 인터훼이스(훼→페),
// 써버/서버(된소리), 포맽/포맷(받침), 셋팅/세팅·맵핑/매핑(겹받침식 표기), 윈도우/윈도(장음).
function foldHangulTerm(stem, directionalOnly) {
  const syllables = [];
  for (const char of stem) {
    const code = char.charCodeAt(0) - 0xAC00;
    if (!(code >= 0 && code <= 11171)) return null;
    syllables.push([HANGUL_CHO[Math.floor(code / 588)], HANGUL_JUNG[Math.floor((code % 588) / 28)], HANGUL_JONG[code % 28]]);
  }
  const kept = directionalOnly ? syllables : syllables.filter((syl, i) => !(i > 0 && syl[0] === 'ㅇ' && syl[1] === 'ㅜ' && !syl[2] &&
    syllables[i - 1][1] === 'ㅗ' && !syllables[i - 1][2]));
  const out = [];
  for (let i = 0; i < kept.length; i++) {
    let [c, v, j] = kept[i];
    if (c === 'ㅎ' && v === 'ㅞ') { c = 'ㅍ'; v = 'ㅔ'; }
    if (c === 'ㅈ' || c === 'ㅊ' || c === 'ㅉ') v = TERM_GLIDE_FOLD[v] || v;
    if (c === 'ㅅ') {
      if (v === 'ㅟ') v = 'ㅣ';
      else if (v === 'ㅞ') v = 'ㅖ';
    }
    if (!directionalOnly) {
      c = TERM_CHO_FOLD[c] || c;
      v = TERM_VOWEL_FOLD[v] || v;
      j = TERM_JONG_FOLD[j] || j;
      const nextCho = i + 1 < kept.length ? (TERM_CHO_FOLD[kept[i + 1][0]] || kept[i + 1][0]) : '';
      if ((j === 'ㅅ' && (nextCho === 'ㅌ' || nextCho === 'ㅊ')) || (j === 'ㅂ' && nextCho === 'ㅍ') || (j === 'ㄱ' && nextCho === 'ㅋ')) j = '';
    }
    out.push([c, v, j]);
  }
  return out;
}

// exact: 발음이 같은 표기(버젼/버전, 캐쉬/캐시, 쉘→셸)만 접은 형태. 다른 말과 겹칠 일이 없어 2음절부터 쓴다.
// fold: 접은 형태가 같으면 같은 용어(3음절 이상. 포트/파트, 코드/카드 같은 짧은 말은 제외). wild: 4음절 이상에서 끝 음절이 아닌 한 음절의 모음만 다른 경우
// (엘리먼트/엘리멘트, 파라미터/파라메터, 어플리케이션/애플리케이션).
// 끝 음절은 프로세스/프로세서, 스테이지/스테이징처럼 다른 말이 많아 제외한다.
function termFuzzyKeys(stem) {
  let keys = termFuzzyKeyCache.get(stem);
  if (keys !== undefined) return keys;
  keys = null;
  const exact = stem.length >= 2 && stem.length <= 20 ? foldHangulTerm(stem, true) : null;
  if (exact) keys = { exact: exact.map(syl => syl.join('')).join('.'), fold: '', wild: [] };
  const folded = exact && stem.length >= 3 ? foldHangulTerm(stem, false) : null;
  if (folded && folded.length >= 3) {
    const parts = folded.map(syl => syl.join(''));
    keys.fold = parts.join('.');
    if (folded.length >= 4) {
      for (let i = 0; i < folded.length - 1; i++) {
        const copy = parts.slice();
        copy[i] = folded[i][0] + '*' + folded[i][2];
        keys.wild.push(copy.join('.'));
      }
    }
  }
  if (termFuzzyKeyCache.size > 50000) termFuzzyKeyCache.clear();
  termFuzzyKeyCache.set(stem, keys);
  return keys;
}

const loanwordLikeCache = new Map();
// 한자어에는 없는 음절(트·스·크, 케·테·메, 션·쉬, 터·버·머, ㅋ 초성, ㅅ 받침 등)이 하나라도 있으면 외래어로 본다.
// 모음을 뭉개는 느슨한 비교는 외래어에만 쓴다: 확장성/확정성, 저장소/조정소 같은 한자어 쌍을 묶지 않기 위해서다.
function isLoanwordLike(stem) {
  let result = loanwordLikeCache.get(stem);
  if (result !== undefined) return result;
  result = false;
  for (const char of stem) {
    const code = char.charCodeAt(0) - 0xAC00;
    if (!(code >= 0 && code <= 11171)) continue;
    const c = HANGUL_CHO[Math.floor(code / 588)];
    const v = HANGUL_JUNG[Math.floor((code % 588) / 28)];
    const j = HANGUL_JONG[code % 28];
    if ('ㅋㄲㄸㅃㅆㅉ'.includes(c) ||
      (j && 'ㄷㅅㅆㅈㅊㅋㅌㅍㅎㄲ'.includes(j)) ||
      (v === 'ㅡ' && !j && 'ㅌㅅㄷㅂㄱㅊㅈㅎㅍ'.includes(c)) ||
      (v === 'ㅔ' && !'ㄱㅅㅈㅊ'.includes(c)) ||
      ('ㅅㅈㅊ'.includes(c) && 'ㅑㅕㅛㅠㅒㅖㅞ'.includes(v)) || (c === 'ㅅ' && v === 'ㅟ') ||
      ('ㅌㅍㅂㄷㅁㄹㄴ'.includes(c) && v === 'ㅓ' && !j) ||
      (c === 'ㅌ' && v === 'ㅣ') ||
      (v === 'ㅣ' && (j === 'ㅇ' || j === 'ㄱ') && 'ㄹㄷㄴㅁㅍ'.includes(c)) ||
      (v === 'ㅠ' && 'ㅂㅍㅌㄷㅁ'.includes(c)) ||
      (v === 'ㅝ' && !j) || v === 'ㅞ') {
      result = true;
      break;
    }
  }
  if (loanwordLikeCache.size > 50000) loanwordLikeCache.clear();
  loanwordLikeCache.set(stem, result);
  return result;
}

function termFuzzyDenied(a, b) {
  return TERM_FUZZY_DENY.has(a < b ? a + '|' + b : b + '|' + a);
}

function createTermFuzzyIndex(stems) {
  const buckets = new Map();
  const keysOf = stem => {
    const keys = termFuzzyKeys(stem);
    if (!keys) return [];
    return ['x:' + keys.exact].concat(keys.fold ? ['f:' + keys.fold] : [], keys.wild.map(key => 'w:' + key));
  };
  for (const stem of stems) {
    for (const key of keysOf(stem)) {
      if (!buckets.has(key)) buckets.set(key, new Set());
      buckets.get(key).add(stem);
    }
  }
  return {
    neighbors(stem) {
      const found = new Set();
      for (const key of keysOf(stem)) {
        for (const other of buckets.get(key) || []) {
          if (other === stem || termFuzzyDenied(stem, other)) continue;
          if (key[0] === 'x' || isLoanwordLike(stem) || isLoanwordLike(other)) found.add(other);
        }
      }
      return Array.from(found);
    }
  };
}

// ───────── 문서에서 스스로 찾는 혼용 후보 ─────────

function createUnionFind() {
  const parent = new Map();
  const find = key => {
    if (!parent.has(key)) parent.set(key, key);
    let root = key;
    while (parent.get(root) !== root) root = parent.get(root);
    let cur = key;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur);
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  return { find, union: (a, b) => parent.set(find(a), find(b)) };
}

function discoverHangulSpellingGroups(ctx) {
  const stems = Array.from(ctx.vocab.keys());
  const index = createTermFuzzyIndex(stems);
  const uf = createUnionFind();
  const linked = new Set();
  for (const stem of stems) {
    for (const other of index.neighbors(stem)) {
      uf.union(stem, other);
      linked.add(stem);
      linked.add(other);
    }
  }
  const byRoot = new Map();
  for (const stem of linked) {
    const root = uf.find(stem);
    if (!byRoot.has(root)) byRoot.set(root, new Set());
    byRoot.get(root).add(stem);
  }
  return Array.from(byRoot.values()).map(surfaces => ({ surfaces, kind: 'spelling', recommended: '', fixed: false, source: 'found' }));
}

// "로그 인/로그인", "데이터 베이스/데이터베이스": 띄어 쓴 두 어절을 붙인 말이 문서에 용어로 따로 나오는 경우.
function discoverSpacingGroups(ctx) {
  const text = ctx.text;
  const found = new Map();
  for (let i = 0; i + 1 < ctx.tokens.length; i++) {
    const a = ctx.tokens[i];
    const b = ctx.tokens[i + 1];
    if (a.latin || b.latin || a.attached || b.start !== a.end + 1 || text[a.end] !== ' ') continue;
    if (a.s.length < 2 && !TERM_MONO_HEADS.has(a.s)) continue;
    if (ctx.runStem.get(a.s) !== a.s) continue;
    const bStem = resolveRunStem(ctx, b.s);
    for (let k = 1; k <= b.s.length; k++) {
      const head = b.s.slice(0, k);
      const joined = a.s + head;
      if (joined.length < 3 || !ctx.vocab.has(joined)) continue;
      const tail = b.s.slice(k);
      const ok = !tail || bStem === head || (!bStem && TERM_STRONG_TAIL_RE.test(tail) && particleAgrees(head[head.length - 1], tail));
      if (!ok) continue;
      if (!found.has(joined)) found.set(joined, new Set([joined]));
      found.get(joined).add(a.s + ' ' + head);
      break;
    }
  }
  return Array.from(found.values()).map(surfaces => ({ surfaces, kind: 'spacing', recommended: '', fixed: false, source: 'found' }));
}

// 코드·명령어 안의 영문(obj.method, useState(), docker logs)은 용어 표기로 보지 않는다.
function latinHeadUsable(text, start) {
  const prev = start > 0 ? text[start - 1] : '';
  return !/[._/\\$@<=:#&%~`-]/.test(prev);
}

function latinTailUsable(text, end) {
  const next = end < text.length ? text[end] : '';
  if (/[_/\\=<>[{@`]/.test(next) || text.startsWith('://', end)) return false;
  if (next === '(' && !isHangulSyllable(text[end + 1])) return false;
  return true;
}

function latinCommandContext(text, start, end) {
  const surface = text.slice(start, end);
  if (surface !== surface.toLowerCase()) return false;
  return /^ [a-z-]/.test(text.slice(end, end + 2)) || /[a-z] $/.test(text.slice(Math.max(0, start - 2), start));
}

function latinOccurrenceUsable(text, start, end) {
  const prev = start > 0 ? text[start - 1] : '';
  const next = end < text.length ? text[end] : '';
  if (prev === '(' && next === ')') return false;
  return latinHeadUsable(text, start) && latinTailUsable(text, end) && !latinCommandContext(text, start, end);
}

function buildLatinIndex(ctx) {
  const text = ctx.text;
  const add = (key, surface) => {
    if (!ctx.latin.has(key)) ctx.latin.set(key, new Set());
    ctx.latin.get(key).add(surface);
  };
  for (const token of ctx.tokens) {
    if (!token.latin) continue;
    token.usable = !token.attached && latinOccurrenceUsable(text, token.start, token.end);
    if (token.usable && latinTermKey(token.s).length >= 2) add(latinTermKey(token.s), token.s);
  }
  // "Java Script", "Mac OS"처럼 띄어 쓴 영문도 붙여 쓴 표기가 문서에 있으면 같은 키로 본다.
  for (let i = 0; i + 1 < ctx.tokens.length; i++) {
    const a = ctx.tokens[i];
    const b = ctx.tokens[i + 1];
    if (!a.latin || !b.latin || !a.usable || !b.usable || b.start !== a.end + 1 || text[a.end] !== ' ') continue;
    const key = latinTermKey(a.s) + latinTermKey(b.s);
    if (key.length >= 4 && ctx.latin.has(key)) add(key, a.s + ' ' + b.s);
  }
}

// JavaScript/Javascript, JSON/json, Node.js/NodeJS. 첫 글자 대소문자만 다른 경우(String/string)는
// 코드 식별자일 때가 많아 제외한다(내장 사전에 있는 이름은 extendLatinSurfaces가 따로 잡는다).
function discoverLatinCaseGroups(ctx) {
  const out = [];
  for (const [key, surfaces] of ctx.latin) {
    if (key.length < 3 || surfaces.size < 2) continue;
    const shapes = new Set(Array.from(surfaces, surface => surface[0].toLowerCase() + surface.slice(1)));
    if (shapes.size < 2) continue;
    out.push({ surfaces: new Set(surfaces), kind: 'case', recommended: '', fixed: false, source: 'found' });
  }
  return out;
}

const LATIN_INITIAL_CHO = {
  a: 'ㅇ', e: 'ㅇ', i: 'ㅇ', o: 'ㅇ', u: 'ㅇ', w: 'ㅇ', y: 'ㅇ', x: 'ㅇㅈ', h: 'ㅎ', b: 'ㅂ', v: 'ㅂ', c: 'ㅋㅅㅊ', k: 'ㅋㄴ', q: 'ㅋ',
  d: 'ㄷ', f: 'ㅍ', p: 'ㅍㅅ', g: 'ㄱㅈ', j: 'ㅈ', z: 'ㅈ', l: 'ㄹ', r: 'ㄹ', m: 'ㅁ', n: 'ㄴ', s: 'ㅅ', t: 'ㅌㅅㅊ'
};

// "쿠버네티스(Kubernetes)"처럼 본문이 직접 짝지어 준 한글·영문 이름. 이후 둘을 섞어 쓰면 혼용이다.
// 소문자 낱말(function)과 약어(DOM)는 키워드나 여러 낱말의 줄임이라 짝짓지 않는다.
function discoverGlossGroups(ctx) {
  const out = [];
  const seen = new Set();
  const re = /([가-힣]{2,})\(([A-Z][A-Za-z0-9+#.-]*)\)/g;
  for (const match of ctx.text.matchAll(re)) {
    const hangul = match[1];
    const latin = match[2];
    if (!/[a-z]/.test(latin) || seen.has(hangul + '|' + latin)) continue;
    if (ctx.runStem.get(hangul) !== hangul) continue;
    const folded = foldHangulTerm(hangul[0], false);
    const cho = folded && folded[0][0];
    if (!cho || !(LATIN_INITIAL_CHO[latin[0].toLowerCase()] || '').includes(cho)) continue;
    seen.add(hangul + '|' + latin);
    out.push({ surfaces: new Set([hangul, latin]), kind: 'script', recommended: '', fixed: false, source: 'found' });
  }
  return out;
}

// 사전의 영문 표기는 문서에 나온 대소문자·구분 기호 변형까지 같은 묶음으로 넓힌다.
function extendLatinSurfaces(ctx, protos) {
  for (const proto of protos) {
    if (proto.kind === 'case' || proto.kind === 'spacing' || proto.kind === 'spelling') continue;
    for (const surface of Array.from(proto.surfaces)) {
      if (!isLatinSurface(surface)) continue;
      const key = latinTermKey(surface);
      for (const found of ctx.latin.get(key) || []) {
        // os, db, git 같은 짧은 소문자는 모듈·변수·명령어일 때가 많다.
        if (key.length <= 3 && found === found.toLowerCase()) continue;
        proto.surfaces.add(found);
      }
    }
  }
}

// ───────── 묶음 병합, 빈도 세기, 권장 표기 ─────────

function mergeTermProtoGroups(protos) {
  const uf = createUnionFind();
  protos.forEach((proto, i) => {
    for (const surface of proto.surfaces) uf.union('s:' + surface, 'p:' + i);
  });
  const byRoot = new Map();
  protos.forEach((proto, i) => {
    const root = uf.find('p:' + i);
    let group = byRoot.get(root);
    if (!group) {
      group = { surfaces: new Set(), kinds: new Set(), protos: [], preferred: [] };
      byRoot.set(root, group);
    }
    for (const surface of proto.surfaces) group.surfaces.add(surface);
    group.kinds.add(proto.kind);
    group.protos.push(proto);
    if (!proto.fixed && proto.recommended) group.preferred.push(proto.recommended);
  });
  return Array.from(byRoot.values()).filter(group => group.surfaces.size >= 2);
}

function hangulRunStart(text, start, end) {
  let i = end;
  while (i > start && isHangulSyllable(text[i - 1])) i--;
  return i;
}

function hangulRunEnd(text, end) {
  let i = end;
  while (i < text.length && isHangulSyllable(text[i])) i++;
  return i;
}

// 영문 뒤에 붙은 한글이 조사·서술격인지("React는", "API입니다").
function latinTailIsFunctional(ctx, tail) {
  if (TERM_WEAK_TAIL_RE.test(tail)) return true;
  let ok = ctx.tailCache.get(tail);
  if (ok === undefined) {
    const tokens = tail.length <= 12 ? safeAnalyzeTokens(ctx.analyzer, tail) : [];
    ok = tokens.length > 0 && /^(?:J|VCP)/.test(String(tokens[0].pos || ''));
    ctx.tailCache.set(tail, ok);
  }
  return ok;
}

function termOccurrenceOk(ctx, start, end) {
  const text = ctx.text;
  const prev = start > 0 ? text[start - 1] : '';
  const next = end < text.length ? text[end] : '';
  if (prev && isTermContinuation(prev)) return false;
  // "리액트(React)"의 괄호 속 병기는 사용 횟수로 세지 않는다.
  if (prev === '(' && next === ')') return false;
  if (/[A-Za-z]/.test(text[start]) && !latinHeadUsable(text, start)) return false;
  if (!isHangulSyllable(text[end - 1])) {
    if (!latinTailUsable(text, end)) return false;
    if (/^[A-Za-z][A-Za-z0-9+#.-]*$/.test(text.slice(start, end)) && latinCommandContext(text, start, end)) return false;
    if (!next || !isTermContinuation(next)) return true;
    if (!isHangulSyllable(next)) return false;
    return latinTailIsFunctional(ctx, text.slice(end, hangulRunEnd(text, end)));
  }
  if (!next || !isTermContinuation(next)) return true;
  if (!isHangulSyllable(next)) return false;
  // 어절의 어간이 표기와 같을 때만 센다: "컴포넌트입니다"는 세고 "로그인"을 "로그"로 세지 않는다.
  const runStart = hangulRunStart(text, start, end);
  const runEnd = hangulRunEnd(text, end);
  const head = text.slice(runStart, end);
  const stem = resolveRunStem(ctx, text.slice(runStart, runEnd));
  if (stem === head) return true;
  if (stem.length > head.length) return false;
  const tail = text.slice(end, runEnd);
  return TERM_STRONG_TAIL_RE.test(tail) && particleAgrees(head[head.length - 1], tail);
}

// 긴 표기부터 세고 센 자리를 표시해 둔다: "데이터 베이스"를 센 자리에서 "데이터"를 다시 세지 않는다.
function countTermSurfaces(ctx, groups, exclusive) {
  const text = ctx.text;
  const surfaces = new Set();
  for (const group of groups) for (const surface of group.surfaces) surfaces.add(surface);
  const ordered = Array.from(surfaces).sort((a, b) => b.length - a.length || a.localeCompare(b, 'ko'));
  const claimed = new Uint8Array(text.length);
  const counts = new Map();
  for (const surface of ordered) {
    let count = 0;
    let first = -1;
    let index = 0;
    while ((index = text.indexOf(surface, index)) !== -1) {
      const end = index + surface.length;
      if (!claimed[index] && !claimed[end - 1] && termOccurrenceOk(ctx, index, end)) {
        if (exclusive) claimed.fill(1, index, end);
        if (first === -1) first = index;
        count++;
        index = end;
      } else {
        index++;
      }
    }
    if (count) counts.set(surface, { count, first });
  }
  return counts;
}

function chooseRecommendedTerm(ctx, counts, group, variants, ruleGroups) {
  const countOf = new Map(variants.map(variant => [variant.text, variant.count]));
  const byCount = list => list.slice().sort((a, b) => (countOf.get(b) || 0) - (countOf.get(a) || 0))[0];
  // 사전의 권장 표기는 그 사전 묶음의 표기가 실제로 문서에 쓰였을 때만 따른다.
  // (다른 묶음과 병합되면서 딸려 온, 문서에 없는 묶음의 권장 표기를 내세우지 않는다.)
  const fixed = source => group.protos.filter(proto => proto.fixed && proto.recommended && proto.source === source).filter(proto => {
    const present = Array.from(proto.surfaces).filter(surface => countOf.has(surface)).length;
    return present >= 2 || (present >= 1 && countOf.has(proto.recommended));
  }).map(proto => proto.recommended);
  const fixedRules = fixed('rules');
  if (fixedRules.length) return byCount(fixedRules);
  const fixedBuiltin = fixed('builtin');
  if (fixedBuiltin.length) return byCount(fixedBuiltin);

  // rules.json의 표기 규칙을 합성어에도 적용한다: 프런트→프론트 규칙이 있으면 "프론트엔드"를 권장.
  for (const variant of variants) {
    if (isLatinSurface(variant.text)) continue;
    for (const rule of ruleGroups) {
      if (rule.source === 'builtin') continue;
      for (const src of rule.variants) {
        if (src === rule.recommended || src.length < 2 || !variant.text.includes(src)) continue;
        const candidate = variant.text.split(src).join(rule.recommended);
        if (candidate !== variant.text && countOf.has(candidate)) return candidate;
      }
    }
  }

  const standard = value => {
    if (isLatinSurface(value)) return value.replace(/[^A-Z]/g, '').length;
    const compact = Array.from(value.replace(/\s+/g, ''));
    const folded = foldHangulTerm(compact.join(''), true);
    if (!folded) return 0;
    return compact.every((char, i) => {
      const code = char.charCodeAt(0) - 0xAC00;
      return folded[i][0] === HANGUL_CHO[Math.floor(code / 588)] && folded[i][1] === HANGUL_JUNG[Math.floor((code % 588) / 28)];
    }) ? 1 : 0;
  };
  const preferredRank = value => {
    const i = group.preferred.indexOf(value);
    return i === -1 ? Infinity : i;
  };
  // 빈도가 같을 때: 사전 첫 표기 → 발음이 같은 쪽의 표준형(버전>버젼) → 분석기가 아는 말 → 끝 음절 ㅓ(센터>센타) → 먼저 나온 표기.
  const known = value => (ctx.unknownStems.has(value) ? 0 : 1);
  const endsWithEo = value => {
    const code = value.charCodeAt(value.length - 1) - 0xAC00;
    return code >= 0 && code <= 11171 && HANGUL_JUNG[Math.floor((code % 588) / 28)] === 'ㅓ' ? 1 : 0;
  };
  const firstAt = value => (counts.get(value) || { first: 0 }).first;
  const best = variants.slice().sort((a, b) => b.count - a.count || preferredRank(a.text) - preferredRank(b.text) ||
    standard(b.text) - standard(a.text) || known(b.text) - known(a.text) || endsWithEo(b.text) - endsWithEo(a.text) ||
    firstAt(a.text) - firstAt(b.text) || a.text.localeCompare(b.text, 'ko'))[0].text;
  // 영문 이름은 가장 많이 쓴 표기가 아니라 정식 표기를 권장한다.
  return (isLatinSurface(best) && latinCanonicalSurface(best)) || best;
}

function collectTermEvidence(text, variants, counts, limit) {
  const snippets = [];
  for (const variant of variants) {
    const hit = counts.get(variant.text);
    if (!hit || hit.first < 0) continue;
    const start = Math.max(0, hit.first - 35);
    const end = Math.min(text.length, hit.first + variant.text.length + 35);
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
