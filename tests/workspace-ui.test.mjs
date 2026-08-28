import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { createWorkspaceUi } from '../shared/workspace-ui.js';

const repoRoot = path.resolve(import.meta.dirname, '..');
const workspaceUiSource = fs.readFileSync(path.join(repoRoot, 'shared', 'workspace-ui.js'), 'utf8');
const pages = Object.freeze([
  Object.freeze({ name:'public', source:fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8') }),
  Object.freeze({ name:'Boss', source:fs.readFileSync(path.join(repoRoot, 'Boss', 'index.html'), 'utf8') }),
]);

function elementSourceById(source, id) {
  const opening = new RegExp(`<([a-z][a-z0-9-]*)\\b[^>]*\\bid="${id}"[^>]*>`, 'i').exec(source);
  assert.ok(opening, `${id} should exist`);
  const tagName = opening[1];
  const tokenPattern = new RegExp(`<\\/?${tagName}\\b[^>]*>`, 'gi');
  tokenPattern.lastIndex = opening.index;
  let depth = 0;
  let token;
  while ((token = tokenPattern.exec(source)) !== null) {
    if (token[0].startsWith('</')) depth -= 1;
    else if (!token[0].endsWith('/>')) depth += 1;
    if (depth === 0) return source.slice(opening.index, tokenPattern.lastIndex);
  }
  throw new Error(`${id} should have a closing ${tagName} tag`);
}

function createElement(id = '') {
  return {
    id,
    textContent:'',
    innerHTML:'',
    dataset:{},
    attributes:{},
    hidden:false,
    tabIndex:-1,
    listeners:{},
    scrollCalls:[],
    addEventListener(name, listener) { this.listeners[name] = listener; },
    focus() {},
    scrollIntoView(options) { this.scrollCalls.push(options); },
    setAttribute(name, value) { this.attributes[name] = String(value); },
  };
}

function createWorkspaceUiHarness(initialSummary, { href = 'https://supply.test/#today' } = {}) {
  let summaryInput = initialSummary;
  const ids = [
    'workspaceNavMount', 'todayWorkspaceMount', 'todaySourceReadiness', 'todaySourceReadinessHint',
    'todayPriorityCount', 'todayVelocityRiskCount', 'todayOrderGroupTotal', 'todayOrderGroupCounts',
    'todaySummaryState', 'todayHighestRisk', 'todayNextActionReason', 'todayNextAction',
    'decisionDashboard',
  ];
  const elements = new Map(ids.map(id => [id, createElement(id)]));
  const navTabs = ['data', 'recommendations', 'orders', 'analysis'].map(workspace => {
    const element = createElement();
    element.dataset.workspace = workspace;
    return element;
  });
  const panels = ['data', 'recommendations', 'recommendations', 'orders', 'analysis'].map(workspace => {
    const element = createElement();
    element.dataset.workspacePanel = workspace;
    return element;
  });
  const nav = createElement();
  const navTabsContainer = createElement();
  const documentRef = {
    activeElement:null,
    documentElement:createElement(),
    getElementById:id => elements.get(id) || null,
    querySelectorAll(selector) {
      if (selector === '.workspaceNavTab[data-workspace]') return navTabs;
      if (selector === '[data-workspace-panel]') return panels;
      return [];
    },
    querySelector(selector) {
      if (selector === '.workspaceNavTabs') return navTabsContainer;
      if (selector === '.workspaceTopNav') return nav;
      return null;
    },
  };
  const initialUrl = new URL(href);
  const location = {
    href:initialUrl.href,
    pathname:initialUrl.pathname,
    search:initialUrl.search,
    hash:initialUrl.hash,
  };
  const updateLocation = nextUrl => {
    const parsed = new URL(nextUrl, location.href);
    location.href = parsed.href;
    location.pathname = parsed.pathname;
    location.search = parsed.search;
    location.hash = parsed.hash;
  };
  const windowRef = {
    location,
    history:{
      pushState(_state, _title, nextUrl) { updateLocation(nextUrl); },
      replaceState(_state, _title, nextUrl) { updateLocation(nextUrl); },
    },
    addEventListener() {},
    matchMedia:() => ({ matches:false }),
  };
  const controller = createWorkspaceUi({
    getSummaryInput:() => summaryInput,
    documentRef,
    windowRef,
  });
  return {
    controller,
    elements,
    location,
    setSummaryInput(value) { summaryInput = value; },
  };
}

test('workspace UI exposes one narrow frozen controller', () => {
  assert.throws(() => createWorkspaceUi(), /getSummaryInput must be a function/);
  assert.throws(() => createWorkspaceUi({ getSummaryInput:() => ({}), onWorkspaceChanged:null }), /onWorkspaceChanged must be a function/);
  const controller = createWorkspaceUi({
    getSummaryInput:() => ({}),
    documentRef:{},
    windowRef:{},
  });
  assert.equal(Object.isFrozen(controller), true);
  assert.deepEqual(Object.keys(controller).sort(), ['activate', 'getActiveWorkspace', 'renderToday', 'start']);
  for (const value of Object.values(controller)) assert.equal(typeof value, 'function');
});

test('browser consumers receive the frozen shared workspace UI factory', async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};
  try {
    await import(`../shared/workspace-ui.js?browser-interface=${Date.now()}`);
    const browserInterface = globalThis.window.SupplyWorkspaceUI;
    assert.equal(Object.isFrozen(browserInterface), true);
    assert.equal(typeof browserInterface.createWorkspaceUi, 'function');
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test('shared UI canonicalizes the old Today hash and preference and defaults invalid activation to Data', () => {
  const legacyHash = createWorkspaceUiHarness({});
  assert.equal(legacyHash.controller.start(), 'recommendations');
  assert.equal(legacyHash.controller.getActiveWorkspace(), 'recommendations');
  assert.equal(legacyHash.location.hash, '#recommendations');

  const legacyPreference = createWorkspaceUiHarness({}, { href:'https://supply.test/' });
  assert.equal(legacyPreference.controller.start({ preference:'today' }), 'recommendations');
  assert.equal(legacyPreference.controller.getActiveWorkspace(), 'recommendations');
  assert.equal(legacyPreference.location.hash, '#recommendations');
  assert.equal(legacyPreference.controller.activate('unknown'), 'data');
  assert.equal(legacyPreference.controller.getActiveWorkspace(), 'data');
  assert.equal(legacyPreference.location.hash, '#data');
});

test('shared Today renders one next action and honest empty, loading, warning, and invalid states', () => {
  assert.equal((workspaceUiSource.match(/id="todayNextAction"/g) || []).length, 1);
  const harness = createWorkspaceUiHarness({
    sourceReadiness:{ h10:false, jam:false, jsp:false },
  });
  harness.controller.start();
  assert.equal(harness.controller.getActiveWorkspace(), 'recommendations');
  assert.equal(harness.elements.get('todaySummaryState').textContent, '等待資料');
  assert.equal(harness.elements.get('todaySourceReadinessHint').textContent, '等待 H10、JAM、JSP');
  assert.equal(harness.elements.get('todayNextAction').textContent, '開始準備資料');
  assert.equal(harness.elements.get('todayNextAction').dataset.workspace, 'data');

  harness.setSummaryInput({
    sourceReadiness:{ h10:{ status:'loading' }, jam:true, jsp:false },
  });
  harness.controller.renderToday();
  assert.equal(harness.elements.get('todaySummaryState').textContent, '資料未齊');
  assert.equal(harness.elements.get('todaySourceReadinessHint').textContent, '尚缺 2 個來源');
  assert.equal(harness.elements.get('todayNextAction').textContent, '補齊資料');

  harness.setSummaryInput({
    sourceReadiness:{ h10:true, jam:true, jsp:true },
    priorityRows:[{ productSku:'GTP03' }],
    velocityRiskRows:[{
      productSku:'GTP03',
      planningVelocity:18.39,
      velocityAssessment:{
        h10SourceVelocity:{ values:[0.36, 18.39] },
        velocityRisks:[{ code:'POSITIVE_SIGNAL_DISAGREEMENT' }],
      },
    }],
  });
  harness.controller.renderToday();
  assert.equal(harness.elements.get('todaySummaryState').textContent, '可開始');
  assert.equal(harness.elements.get('todayHighestRisk').dataset.state, 'risk');
  assert.match(harness.elements.get('todayHighestRisk').textContent, /速度證據可能衝突或被低估/);
  assert.equal(harness.elements.get('todayNextAction').textContent, '查看 GTP03 的 Velocity Risk');
  assert.equal(harness.elements.get('todayNextAction').dataset.targetId, 'decisionDashboard');
  harness.elements.get('todayNextAction').listeners.click({ currentTarget:harness.elements.get('todayNextAction') });
  assert.deepEqual(harness.elements.get('decisionDashboard').scrollCalls, [{ behavior:'smooth', block:'start' }]);

  harness.setSummaryInput({ sourceReadiness:'invalid' });
  harness.controller.renderToday();
  assert.equal(harness.elements.get('todaySummaryState').textContent, '資料需確認');
  assert.equal(harness.elements.get('todayNextAction').textContent, '檢查資料');
  assert.doesNotMatch(harness.elements.get('todayNextActionReason').textContent, /還有 0 個/);
});

test('public and Boss expose one designated primary task for every non-Today workspace', () => {
  const tasks = [
    { workspace:'data', containerId:'workflowTop', action:/<button(?=[^>]*\bid="btnBuild")[^>]*>[\s\S]*?整理表格[\s\S]*?<\/button>/g },
    { workspace:'recommendations', containerId:'decisionDashboard', action:/<button(?=[^>]*\bid="btnAddPriorityToGenerator")[^>]*>[\s\S]*?一鍵加入訂單產生器[\s\S]*?<\/button>/g },
    { workspace:'orders', containerId:'generatorCard', action:/<button(?=[^>]*\bonclick="exportGeneratorToExcel\(\)")[^>]*>[\s\S]*?匯出訂單 Excel[\s\S]*?<\/button>/g },
    { workspace:'analysis', containerId:'skuDecisionTreeCard', action:/<button(?=[^>]*\bid="btnRenderSkuTree")[^>]*>[\s\S]*?查詢[\s\S]*?<\/button>/g },
  ];
  for (const page of pages) {
    for (const task of tasks) {
      const container = elementSourceById(page.source, task.containerId);
      assert.match(container.slice(0, container.indexOf('>') + 1), new RegExp(`data-workspace-panel="${task.workspace}"`), `${page.name} ${task.workspace}`);
      assert.equal((container.match(task.action) || []).length, 1, `${page.name} ${task.workspace} should expose its primary task exactly once`);
    }
  }
});

test('public and Boss state surfaces use concise plain-language lifecycle evidence', () => {
  const stateEvidence = {
    public:[
      ['loading', /正在載入本週資料/],
      ['restored', /已從本機還原 Workspace Snapshot/],
      ['empty', /這個瀏覽器尚無 Workspace Snapshot/],
      ['warning', /已從本機還原可讀資料；請重新選擇/],
      ['success', /已安全保存在此瀏覽器/],
      ['storage-error', /本機儲存空間不足；目前畫面可繼續使用，但這次變更尚未保存/],
    ],
    Boss:[
      ['loading', /正在載入本週資料/],
      ['restored', /已從已驗證雲端還原/],
      ['empty', /訂單草稿尚未載入/],
      ['warning', /雲端還原不完整：[\s\S]*?只套用可讀資料/],
      ['success', /已同步至雲端/],
      ['storage-error', /同步失敗[\s\S]*?雲端仍保留前一版[\s\S]*?重試/],
    ],
  };
  for (const page of pages) {
    assert.match(page.source, /id="bossLoadingMask"[^>]*role="status"[^>]*aria-live="polite"/);
    assert.match(page.source, /id="workspaceSnapshotState"[^>]*role="status"[^>]*aria-live="polite"/);
    assert.match(page.source, /id="generatorDraftStatus"/);
    for (const [state, pattern] of stateEvidence[page.name]) {
      assert.match(page.source, pattern, `${page.name} should expose a plain-language ${state} state`);
    }
  }
});
