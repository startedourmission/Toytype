// 오탈자 레이더 — background service worker
// 역할: 탭 배지 갱신 + rules.json 로드·배포. settings는 읽지도 쓰지도 않는다.
'use strict';

chrome.action.setBadgeBackgroundColor({ color: '#d93025' });

// SW 재기동 시 사라지는 모듈 레벨 캐시 — 재fetch가 정상 동작이다.
let rulesCache = null;

async function loadRules() {
  if (rulesCache) return rulesCache;
  const res = await fetch(chrome.runtime.getURL('rules.json'));
  if (!res.ok) throw new Error('rules.json fetch failed: ' + res.status);
  rulesCache = await res.json();
  return rulesCache;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'typo:count') {
    const tabId = sender.tab && sender.tab.id;
    if (typeof tabId !== 'number') return; // 탭 외 발신은 무시
    const count = typeof msg.count === 'number' && msg.count > 0 ? msg.count : 0;
    chrome.action.setBadgeText({ tabId: tabId, text: count > 0 ? String(count) : '' });
    return; // 응답 없음. 탭 배지는 내비게이션 시 크롬이 자동 초기화.
  }

  if (msg.type === 'typo:getRules') {
    loadRules()
      .then((rules) => sendResponse({ ok: true, rules: rules }))
      .catch(() => {
        rulesCache = null;
        sendResponse({ ok: false, error: 'rules_load_failed' });
      });
    return true; // 비동기 응답
  }

  if (msg.type === 'typo:getCategories') {
    loadRules()
      .then((rules) => sendResponse({
        ok: true,
        categories: rules.categories.map((c) => ({
          id: c.id,
          label: c.label,
          ruleCount: c.rules.length
        }))
      }))
      .catch(() => {
        rulesCache = null;
        sendResponse({ ok: false, error: 'rules_load_failed' });
      });
    return true; // 비동기 응답
  }
});
