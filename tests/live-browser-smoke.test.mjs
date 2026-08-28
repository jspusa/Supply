import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildLiveBrowserUrls,
  verifyLiveBrowserDeployment,
} from '../scripts/verify-live-browser.mjs';

const BASE_URL = 'https://jspusa.github.io/Supply/';
const REVISION = '0123456789abcdef0123456789abcdef01234567';

function createFakeBrowserType({ failures = [] } = {}) {
  const log = {
    launches:[],
    contexts:[],
    releaseRequests:[],
    pages:[],
    locators:[],
    waits:[],
    closes:{ browser:0, context:0 },
  };
  let launchIndex = 0;

  const browserType = {
    async launch(options) {
      const attemptIndex = launchIndex;
      launchIndex += 1;
      log.launches.push(options);
      if (failures[attemptIndex]?.phase === 'launch') throw new Error(failures[attemptIndex].message);
      return {
        async newContext(options) {
          log.contexts.push(options);
          const requestListeners = [];
          return {
            request:{
              async get(url, options) {
                log.releaseRequests.push({ url, options, attemptIndex });
                const failure = failures[attemptIndex];
                const revision = failure?.phase === 'revision' ? failure.revision : REVISION;
                return {
                  ok:() => true,
                  status:() => 200,
                  json:async () => ({ schemaVersion:1, revision }),
                };
              },
            },
            on(eventName, listener) {
              assert.equal(eventName, 'request');
              requestListeners.push(listener);
            },
            async newPage() {
              const pageIndex = log.pages.length;
              let currentUrl = 'about:blank';
              const pageLog = { gotos:[], selectors:[], pageIndex, attemptIndex };
              log.pages.push(pageLog);
              return {
                async goto(url, options) {
                  pageLog.gotos.push({ url, options });
                  const failure = failures[attemptIndex];
                  if (failure?.phase === 'goto' && failure.page === pageIndex % 4) {
                    throw new Error(failure.message);
                  }
                  currentUrl = url.endsWith('#decisionDashboard')
                    ? url.replace(/#decisionDashboard$/, '#recommendations')
                    : url.endsWith('#today')
                      ? url.replace(/#today$/, '#recommendations')
                      : url;
                  if (failure?.phase === 'mutation' && /\/Boss\//.test(url)) {
                    requestListeners.forEach(listener => listener({
                      method:() => failure.method || 'POST',
                      url:() => failure.url || 'https://supply-boss.example/api/snapshot',
                    }));
                  }
                },
                url() { return currentUrl; },
                locator(selector) {
                  pageLog.selectors.push(selector);
                  log.locators.push(selector);
                  const isSidebar = selector === '.appSidebar';
                  const isWorkspaceTabs = selector === '.workspaceNavTab';
                  return {
                    async count() { return isSidebar ? 0 : isWorkspaceTabs ? 5 : 1; },
                    async allTextContents() {
                      return isWorkspaceTabs ? ['資料', '今日建議', '訂單', 'SKU 決策樹', '資料分析'] : [];
                    },
                    async waitFor(options) { log.waits.push({ selector, ...options }); },
                    async isVisible() { return true; },
                  };
                },
              };
            },
            async close() { log.closes.context += 1; },
          };
        },
        async close() { log.closes.browser += 1; },
      };
    },
  };

  return { browserType, log };
}

test('URL contract keeps the live revision cache buster and separates legacy, canonical, and Boss entrypoints', () => {
  assert.deepEqual(buildLiveBrowserUrls({
    baseUrl:'https://jspusa.github.io/Supply',
    expectedRevision:REVISION,
    attempt:3,
  }), {
    releaseUrl:`${BASE_URL}release.json?supply-release=${REVISION}-3`,
    legacyPublicUrl:`${BASE_URL}?supply-release=${REVISION}-3#decisionDashboard`,
    legacyTodayUrl:`${BASE_URL}?supply-release=${REVISION}-3#today`,
    legacyCanonicalUrl:`${BASE_URL}?supply-release=${REVISION}-3#recommendations`,
    canonicalPublicUrl:`${BASE_URL}?supply-release=${REVISION}-3#recommendations`,
    bossUrl:`${BASE_URL}Boss/?supply-release=${REVISION}-3#today`,
    bossCanonicalUrl:`${BASE_URL}Boss/?supply-release=${REVISION}-3#recommendations`,
  });
});

test('browser smoke proves legacy canonicalization, canonical public UI, absent sidebar, and Boss auth gate without actions', async () => {
  const { browserType, log } = createFakeBrowserType();
  const result = await verifyLiveBrowserDeployment({
    baseUrl:BASE_URL,
    expectedRevision:REVISION,
    browserType,
    attempts:1,
    retryDelayMs:0,
    navigationTimeoutMs:3210,
    assertionTimeoutMs:987,
  });

  assert.deepEqual(result, {
    ok:true,
    revision:REVISION,
    attempts:1,
    publicUrl:BASE_URL,
    bossUrl:`${BASE_URL}Boss/`,
  });
  assert.deepEqual(log.launches, [{ headless:true }]);
  assert.deepEqual(log.contexts, [{
    locale:'zh-TW',
    timezoneId:'Asia/Taipei',
    viewport:{ width:1280, height:900 },
  }]);
  assert.deepEqual(log.releaseRequests, [{
    url:`${BASE_URL}release.json?supply-release=${REVISION}-1`,
    options:{
      headers:{ accept:'application/json', 'cache-control':'no-cache' },
      timeout:3210,
    },
    attemptIndex:0,
  }]);
  assert.deepEqual(log.pages.map(page => page.gotos[0].url), [
    `${BASE_URL}?supply-release=${REVISION}-1#decisionDashboard`,
    `${BASE_URL}?supply-release=${REVISION}-1#today`,
    `${BASE_URL}?supply-release=${REVISION}-1#recommendations`,
    `${BASE_URL}Boss/?supply-release=${REVISION}-1#today`,
  ]);
  assert.deepEqual(log.pages.map(page => page.gotos[0].options), Array(4).fill({
    waitUntil:'domcontentloaded',
    timeout:3210,
  }));

  for (const publicPage of log.pages.slice(0, 3)) {
    assert.deepEqual(publicPage.selectors, [
      'html[data-workspace-ui-ready="true"]',
      '.workspaceNavTab',
      '.workspaceNavTab[data-workspace="sku-tree"]',
      '.workspaceNavTab[data-workspace="recommendations"][aria-selected="true"]',
      '#decisionDashboard[data-workspace-panel="recommendations"]',
      '#todayWorkspaceSummary[data-workspace-panel="recommendations"]',
      '.appSidebar',
    ]);
  }
  assert.deepEqual(log.pages[3].selectors, ['#bossAuthGate:not([hidden])', '#bossLoginForm']);
  assert.equal(log.locators.some(selector => /submit|save|delete/i.test(selector)), false);
  assert.deepEqual(log.closes, { browser:1, context:1 });
});

test('browser smoke retries with a fresh revision-tagged context and succeeds within the explicit bound', async () => {
  const { browserType, log } = createFakeBrowserType({
    failures:[{ phase:'revision', revision:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }],
  });
  const waits = [];
  const result = await verifyLiveBrowserDeployment({
    baseUrl:BASE_URL,
    expectedRevision:REVISION,
    browserType,
    attempts:3,
    retryDelayMs:25,
    navigationTimeoutMs:250,
    assertionTimeoutMs:250,
    wait:milliseconds => { waits.push(milliseconds); },
  });

  assert.equal(result.attempts, 2);
  assert.equal(log.launches.length, 2);
  assert.equal(log.contexts.length, 2);
  assert.deepEqual(log.closes, { browser:2, context:2 });
  assert.deepEqual(waits, [25]);
  assert.deepEqual(log.releaseRequests.map(request => request.url), [
    `${BASE_URL}release.json?supply-release=${REVISION}-1`,
    `${BASE_URL}release.json?supply-release=${REVISION}-2`,
  ]);
  assert.equal(log.pages[0].gotos[0].url, `${BASE_URL}?supply-release=${REVISION}-2#decisionDashboard`);
});

test('browser smoke stops at the bounded attempt count, closes every browser, and reports the last error', async () => {
  const { browserType, log } = createFakeBrowserType({
    failures:[
      { phase:'launch', message:'first launch failed' },
      { phase:'launch', message:'second launch failed' },
      { phase:'launch', message:'final launch failed' },
    ],
  });
  const waits = [];
  await assert.rejects(verifyLiveBrowserDeployment({
    baseUrl:BASE_URL,
    expectedRevision:REVISION,
    browserType,
    attempts:3,
    retryDelayMs:10,
    navigationTimeoutMs:250,
    assertionTimeoutMs:250,
    wait:milliseconds => { waits.push(milliseconds); },
  }), /failed after 3 attempts: final launch failed/);
  assert.equal(log.launches.length, 3);
  assert.deepEqual(log.closes, { browser:0, context:0 });
  assert.deepEqual(waits, [10, 10]);
});

test('browser smoke fails closed if opening the unauthenticated Boss gate emits a mutation request', async () => {
  const { browserType, log } = createFakeBrowserType({
    failures:[{ phase:'mutation', method:'DELETE', url:'https://supply-boss.example/api/snapshot' }],
  });
  await assert.rejects(verifyLiveBrowserDeployment({
    baseUrl:BASE_URL,
    expectedRevision:REVISION,
    browserType,
    attempts:1,
    retryDelayMs:0,
    navigationTimeoutMs:250,
    assertionTimeoutMs:250,
  }), /forbidden mutation request\(s\): DELETE https:\/\/supply-boss\.example\/api\/snapshot/);
  assert.deepEqual(log.closes, { browser:1, context:1 });
});

test('browser smoke rejects unbounded or incomplete CLI contract inputs before launch', async () => {
  const { browserType, log } = createFakeBrowserType();
  await assert.rejects(verifyLiveBrowserDeployment({
    baseUrl:'file:///tmp/Supply/',
    expectedRevision:REVISION,
    browserType,
  }), /baseUrl must use HTTP or HTTPS/);
  await assert.rejects(verifyLiveBrowserDeployment({
    baseUrl:BASE_URL,
    expectedRevision:'',
    browserType,
  }), /expectedRevision must be a non-empty string/);
  await assert.rejects(verifyLiveBrowserDeployment({
    baseUrl:BASE_URL,
    expectedRevision:REVISION,
    browserType,
    attempts:21,
  }), /attempts must be an integer from 1 to 20/);
  assert.equal(log.launches.length, 0);
});
