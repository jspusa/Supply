import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LEGACY_WORKSPACE_HASHES,
  WORKSPACE_IDS,
  canonicalWorkspaceId,
  projectTodaySummary,
  resolveInitialWorkspace,
  workspaceHash,
} from '../shared/workspace-navigation.js';

test('canonical workspace ids and hashes are stable', () => {
  assert.deepEqual(WORKSPACE_IDS, ['data', 'recommendations', 'orders', 'sku-tree', 'analysis']);
  assert.equal(Object.isFrozen(WORKSPACE_IDS), true);
  for (const workspace of WORKSPACE_IDS) {
    assert.equal(workspaceHash(workspace), `#${workspace}`);
  }
  assert.equal(workspaceHash('today'), '#recommendations');
  assert.equal(workspaceHash('unknown'), '#data');
  assert.equal(canonicalWorkspaceId(' Today '), 'recommendations');
  assert.equal(canonicalWorkspaceId('SKU-TREE'), 'sku-tree');
  assert.equal(canonicalWorkspaceId('ANALYSIS'), 'analysis');
  assert.equal(canonicalWorkspaceId('unknown'), null);
  assert.equal(canonicalWorkspaceId('toString'), null);
});

test('initial workspace prefers a valid URL, then canonicalized preference, then Data', () => {
  assert.equal(resolveInitialWorkspace({ url:'https://jspusa.github.io/Supply/#reorderCard', preference:'orders' }), 'recommendations');
  assert.equal(resolveInitialWorkspace({ url:'#not-a-workspace', preference:'orders' }), 'orders');
  assert.equal(resolveInitialWorkspace({ url:'#not-a-workspace', preference:'today' }), 'recommendations');
  assert.equal(resolveInitialWorkspace({ url:'#not-a-workspace', preference:'not-a-workspace' }), 'data');
  assert.equal(resolveInitialWorkspace({ hash:'#skuDecisionTreeCard', preference:'analysis' }), 'sku-tree');
  assert.equal(resolveInitialWorkspace({ hash:'#sku-tree', preference:'analysis' }), 'sku-tree');
  assert.equal(resolveInitialWorkspace({ hash:'#analysis', preference:'data' }), 'analysis');
  assert.equal(resolveInitialWorkspace(), 'data');
});

test('every legacy card hash resolves to its canonical workspace', () => {
  assert.deepEqual(LEGACY_WORKSPACE_HASHES, {
    '#today':'recommendations',
    '#decisionDashboard':'recommendations',
    '#uploadCard':'data',
    '#reorderCard':'recommendations',
    '#generatorCard':'orders',
    '#skuDecisionTreeCard':'sku-tree',
    '#autoDecisionTreeCard':'sku-tree',
    '#mainCard':'analysis',
    '#hotCard':'analysis',
    '#newCard':'analysis',
    '#salesPieDetails':'analysis',
    '#salesGanttDetails':'analysis',
    '#otherToolsDetails':'analysis',
  });
  assert.equal(Object.isFrozen(LEGACY_WORKSPACE_HASHES), true);
  for (const [hash, workspace] of Object.entries(LEGACY_WORKSPACE_HASHES)) {
    assert.equal(resolveInitialWorkspace({ url:hash, preference:'orders' }), workspace, hash);
  }
  assert.equal(resolveInitialWorkspace({ url:'#DECISIONDASHBOARD' }), 'recommendations');
});

test('an empty or invalid Today state stays honest and points to Data', () => {
  const empty = projectTodaySummary();
  assert.equal(empty.status, 'empty');
  assert.deepEqual(empty.readiness, { state:'empty', ready:0, total:0, missing:0 });
  assert.equal(empty.priorityCount, 0);
  assert.equal(empty.velocityRiskCount, 0);
  assert.deepEqual(empty.groupCounts, { vietnam:0, taiwan:0, subcontract:0, total:0 });
  assert.equal(empty.highestPriorityVelocityRisk, null);
  assert.equal(empty.nextAction.workspace, 'data');
  assert.equal(empty.nextAction.label, '開始準備資料');
  assert.equal(empty.nextAction.reason, '尚未讀取資料。');

  const untouchedThreeSources = projectTodaySummary({
    sourceReadiness:{
      h10:{ ready:false, started:false },
      jam:{ ready:false, started:false },
      jsp:{ ready:false, started:false },
    },
  });
  assert.equal(untouchedThreeSources.status, 'empty');
  assert.deepEqual(untouchedThreeSources.readiness, { state:'empty', ready:0, total:3, missing:3 });
  assert.equal(untouchedThreeSources.nextAction.id, 'prepare-data');
  assert.equal(untouchedThreeSources.nextAction.label, '開始準備資料');

  const invalid = projectTodaySummary({
    sourceReadiness:'ready',
    priorityRows:{ length:12 },
    velocityRiskRows:[null],
    orderDraft:{ groupOrder:{ taiwan:'two', vietnam:[], subcontract:[] } },
  });
  assert.equal(invalid.status, 'invalid');
  assert.equal(invalid.priorityCount, 0);
  assert.equal(invalid.velocityRiskCount, 0);
  assert.equal(invalid.groupCounts.total, 0);
  assert.ok(invalid.issues.length >= 4);
  assert.equal(invalid.nextAction.workspace, 'data');
  assert.equal(invalid.nextAction.id, 'review-data');
  assert.equal(invalid.nextAction.label, '檢查資料');
  assert.equal(invalid.nextAction.reason, '資料狀態或輸入格式需要確認。');
  assert.doesNotMatch(invalid.nextAction.reason, /還有 0 個/);

  const invalidReadiness = projectTodaySummary({ sourceReadiness:'not-an-object' });
  assert.equal(invalidReadiness.status, 'invalid');
  assert.deepEqual(invalidReadiness.readiness, { state:'invalid', ready:0, total:0, missing:0 });
  assert.equal(invalidReadiness.nextAction.id, 'review-data');
  assert.equal(invalidReadiness.nextAction.workspace, 'data');
  assert.doesNotMatch(invalidReadiness.nextAction.reason, /還有 0 個/);
});

test('missing source readiness takes precedence over downstream work', () => {
  const summary = projectTodaySummary({
    sourceReadiness:{ h10:true, openOrders:false, inventory:{ status:'ready' } },
    priorityRows:[{ sku:'AFA12AM' }],
    velocityRiskRows:[{ sku:'AFA12AM', velocityRiskCount:1 }],
    orderDraft:{ groupOrder:{ taiwan:['TW01'], vietnam:[], subcontract:[] } },
  });
  assert.equal(summary.status, 'incomplete');
  assert.deepEqual(summary.readiness, { state:'incomplete', ready:2, total:3, missing:1 });
  assert.equal(summary.nextAction.id, 'complete-data');
  assert.equal(summary.nextAction.workspace, 'data');
});

test('Today selects the highest-priority matching Velocity Risk and uses non-conclusive wording', () => {
  const summary = projectTodaySummary({
    sourceReadiness:{ h10:true, openOrders:true, inventory:true },
    priorityRows:[
      { sku:'GTP03', priorityScore:1700 },
      { sku:'AFA12AM', priorityScore:900 },
    ],
    velocityRiskRows:[
      { sku:'AFA12AM', planningVelocity:10, velocityAssessment:{ h10SourceVelocity:{ values:[5] }, velocityRisks:[{ code:'HOT_SOURCE_BELOW_FLOOR' }] } },
      { sku:'GTP03', planningVelocity:18.39, velocityAssessment:{ h10SourceVelocity:{ values:[0.36, 18.39] }, velocityRisks:[{ code:'POSITIVE_SIGNAL_DISAGREEMENT' }, { code:'ZERO_SELLABLE' }] } },
    ],
    orderDraft:{ groupOrder:{ taiwan:['TW01'], vietnam:['VN01'], subcontract:['GTB03', 'GTP03'] } },
  });
  assert.equal(summary.status, 'ready');
  assert.equal(summary.priorityCount, 2);
  assert.equal(summary.velocityRiskCount, 2);
  assert.deepEqual(summary.groupCounts, { vietnam:1, taiwan:1, subcontract:2, total:4 });
  assert.equal(summary.highestPriorityVelocityRisk.productSku, 'GTP03');
  assert.equal(summary.highestPriorityVelocityRisk.signalCount, 2);
  assert.match(summary.highestPriorityVelocityRisk.text, /H10 Source Velocity 0\.36 \/ 18\.39/);
  assert.match(summary.highestPriorityVelocityRisk.text, /Planning Velocity 18\.39/);
  assert.match(summary.highestPriorityVelocityRisk.text, /可能衝突或被低估/);
  assert.match(summary.highestPriorityVelocityRisk.text, /不代表已證實斷貨或損失銷售/);
  assert.doesNotMatch(summary.highestPriorityVelocityRisk.text, /(?:必定|一定|已經|確定)斷貨/);
  assert.equal(summary.nextAction.id, 'review-velocity-risk');
  assert.equal(summary.nextAction.workspace, 'recommendations');
  assert.equal(summary.nextAction.hash, '#recommendations');
  assert.equal(summary.nextAction.targetId, 'decisionDashboard');
});

test('Today priority action targets the merged recommendation dashboard', () => {
  const summary = projectTodaySummary({
    sourceReadiness:{ h10:true, openOrders:true, inventory:true },
    priorityRows:[{ sku:'AFA12AM' }],
    velocityRiskRows:[],
  });
  assert.equal(summary.nextAction.id, 'review-priorities');
  assert.equal(summary.nextAction.workspace, 'recommendations');
  assert.equal(summary.nextAction.hash, '#recommendations');
  assert.equal(summary.nextAction.targetId, 'decisionDashboard');
});

test('three Order Draft groups are counted and become the one next action after priorities clear', () => {
  const summary = projectTodaySummary({
    sourceReadiness:[
      { id:'h10', ready:true },
      { id:'openOrders', status:'ready' },
      { id:'inventory', ready:true },
    ],
    priorityRows:[],
    velocityRiskRows:[],
    orderDraft:{ groupOrder:{ taiwan:['TW01', 'TW02'], vietnam:['VN01'], subcontract:['GT01', 'GT02', 'GT03'] } },
  });
  assert.deepEqual(summary.readiness, { state:'ready', ready:3, total:3, missing:0 });
  assert.deepEqual(summary.groupCounts, { vietnam:1, taiwan:2, subcontract:3, total:6 });
  assert.equal(summary.nextAction.id, 'continue-order');
  assert.equal(summary.nextAction.workspace, 'orders');
  assert.equal(Object.hasOwn(summary, 'nextActions'), false);
});

test('browser consumers receive one frozen workspace-navigation interface', async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};
  try {
    await import(`../shared/workspace-navigation.js?browser-interface=${Date.now()}`);
    const browserInterface = globalThis.window.SupplyWorkspaceNavigation;
    assert.equal(Object.isFrozen(browserInterface), true);
    assert.deepEqual(browserInterface.WORKSPACE_IDS, WORKSPACE_IDS);
    assert.equal(browserInterface.LEGACY_WORKSPACE_HASHES['#decisionDashboard'], 'recommendations');
    for (const name of ['canonicalWorkspaceId', 'resolveInitialWorkspace', 'workspaceHash', 'projectTodaySummary']) {
      assert.equal(typeof browserInterface[name], 'function', name);
    }
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
