import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { buildPlanningVelocities } from '../shared/planning-velocity.js';

const repoRoot = path.resolve(import.meta.dirname, '..');

function loadApprovedEquivalentSkuPairs() {
  const context = { window:{} };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(repoRoot, 'product-data.js'), 'utf8'), context);
  return Array.from(context.window.SUPPLY_EQUIVALENT_SKU_PAIRS, pair => Array.from(pair));
}

function buildInput(overrides = {}) {
  return {
    asOfDate: '2026-08-27',
    sourceObservedOn: '2026-08-27',
    rawH10Text: '',
    inventoryRows: [],
    productSkuAliases: {},
    hotProductSkus: [],
    historySamples: [],
    ...overrides,
  };
}

test('GTP03 preserves conflicting H10 Source Velocity evidence and plans with the higher value', () => {
  const result = buildPlanningVelocities(buildInput({
    rawH10Text: [
      'United StatesB0C3C3D1W6GTP03',
      '0.36',
      'United StatesB0C3C3D1W6GTP03',
      '18.39',
    ].join('\n'),
    inventoryRows: [
      ['SKU', 'Days of Supply', 'Sellable Inventory', 'Inbound'],
      ['GTP03', 0, 0, 0],
      ['GTP03', 205, 3199, 402],
    ],
  }));

  const assessment = result.assessments.find(item => item.productSku === 'GTP03');
  assert.ok(assessment);
  assert.deepEqual(result.h10Observations, [
    { productSku: 'GTP03', sourceSku: 'GTP03', asin: 'B0C3C3D1W6', value: 0.36, rawValue: '0.36' },
    { productSku: 'GTP03', sourceSku: 'GTP03', asin: 'B0C3C3D1W6', value: 18.39, rawValue: '18.39' },
  ]);
  assert.deepEqual(assessment.h10SourceVelocity.values, [0.36, 18.39]);
  assert.equal(assessment.h10SourceVelocity.min, 0.36);
  assert.equal(assessment.h10SourceVelocity.max, 18.39);
  assert.equal(assessment.planningVelocity, 18.39);
  assert.deepEqual(assessment.winningEvidence, [{ kind: 'h10-source', value: 18.39 }]);
  assert.ok(assessment.velocityRisks.some(risk => risk.code === 'POSITIVE_SIGNAL_DISAGREEMENT'));
  assert.ok(assessment.velocityRisks.some(risk => risk.code === 'ZERO_SELLABLE'));
  assert.ok(assessment.velocityRisks.some(risk => risk.code === 'LOW_DAYS_OF_SUPPLY'));
  assert.ok(assessment.candidates.some(candidate => (
    candidate.kind === 'sellable-over-days-of-supply'
      && Math.abs(candidate.value - 15.604878048780488) < 1e-12
  )));
});

test('H10 observations retain every source occurrence in original text order', () => {
  const result = buildPlanningVelocities(buildInput({
    rawH10Text: [
      'United StatesB000000010MIX01', '1',
      'B000000011 MIX01 2',
      'United StatesB000000010MIX01', '1',
    ].join('\n'),
  }));

  assert.deepEqual(result.h10Observations.map(item => ({ asin: item.asin, value: item.value })), [
    { asin: 'B000000010', value: 1 },
    { asin: 'B000000011', value: 2 },
    { asin: 'B000000010', value: 1 },
  ]);
  assert.deepEqual(result.assessments[0].h10SourceVelocity.values, [1, 2, 1]);
  assert.deepEqual(result.assessments[0].candidates, [{ kind: 'h10-source', value: 2 }]);
});

test('approved Order SKU evidence is normalized to its Product SKU before velocity comparison', () => {
  const approvedPairs = loadApprovedEquivalentSkuPairs();
  const [productSku, orderSku] = approvedPairs.find(pair => pair[0] === 'GTP01');
  const result = buildPlanningVelocities(buildInput({
    productSkuAliases:approvedPairs,
    rawH10Text:`B000000034 ${orderSku} 5`,
    inventoryRows:[
      ['SKU', 'Days of Supply', 'Sellable Inventory', 'Inbound'],
      [orderSku, 10, 80, 0],
    ],
    historySamples:[
      { productSku:orderSku, date:'2026-08-26', h10SourceVelocity:11 },
    ],
  }));

  assert.equal(result.assessments.length, 1, 'equivalent evidence must not split into separate Product and Order SKU assessments');
  const assessment = result.assessments[0];
  assert.equal(assessment.productSku, productSku);
  assert.deepEqual(result.h10Observations, [{
    productSku,
    sourceSku:orderSku,
    asin:'B000000034',
    value:5,
    rawValue:'5',
  }]);
  assert.deepEqual(result.inventorySummary.evidence.map(({ productSku:normalized, sourceSku, sellable, daysOfSupply }) => ({
    productSku:normalized,
    sourceSku,
    sellable,
    daysOfSupply,
  })), [{ productSku, sourceSku:orderSku, sellable:80, daysOfSupply:10 }]);
  assert.deepEqual(assessment.candidates, [
    { kind:'h10-source', value:5 },
    { kind:'sellable-over-days-of-supply', value:8, rowIndex:1 },
    { kind:'local-28-day-median', value:11 },
  ]);
  assert.equal(assessment.historyMedian, 11);
  assert.equal(assessment.planningVelocity, 11);
  assert.deepEqual(assessment.winningEvidence, [{ kind:'local-28-day-median', value:11 }]);
  assert.deepEqual(result.nextHistorySamples, [
    { productSku, date:'2026-08-26', h10SourceVelocity:11 },
    { productSku, date:'2026-08-27', h10SourceVelocity:5 },
  ]);
});

test('Hot SKU floor raises 9.99 to 10 while a non-hot 5 remains 5', () => {
  const result = buildPlanningVelocities(buildInput({
    rawH10Text: [
      'United StatesB000000001HOT01',
      '9.99',
      'United StatesB000000002REG01',
      '5',
    ].join('\n'),
    hotProductSkus: ['HOT01'],
  }));

  const hot = result.assessments.find(item => item.productSku === 'HOT01');
  const regular = result.assessments.find(item => item.productSku === 'REG01');
  assert.equal(hot.planningVelocity, 10);
  assert.deepEqual(hot.winningEvidence, [{ kind: 'hot-sku-floor', value: 10 }]);
  assert.ok(hot.velocityRisks.some(risk => risk.code === 'HOT_SOURCE_BELOW_FLOOR'));
  assert.deepEqual(hot.adjustmentReasons.map(reason => reason.code), ['HOT_SKU_FLOOR_APPLIED']);
  assert.equal(regular.planningVelocity, 5);
  assert.deepEqual(regular.winningEvidence, [{ kind: 'h10-source', value: 5 }]);
  assert.deepEqual(regular.adjustmentReasons, []);
});

test('a listed Hot SKU is assessed at the floor even without H10 or inventory evidence', () => {
  const result = buildPlanningVelocities(buildInput({ hotProductSkus: ['HOT-NO-SOURCE'] }));
  assert.equal(result.assessments.length, 1);
  assert.equal(result.assessments[0].productSku, 'HOT-NO-SOURCE');
  assert.equal(result.assessments[0].planningVelocity, 10);
  assert.deepEqual(result.assessments[0].winningEvidence, [{ kind: 'hot-sku-floor', value: 10 }]);
});

test('valid Sellable divided by Days of Supply can conservatively raise Planning Velocity', () => {
  const result = buildPlanningVelocities(buildInput({
    rawH10Text: 'United StatesB000000004DOS01\n5',
    inventoryRows: [
      ['SKU', 'Days of Supply', 'Sellable Inventory', 'Inbound'],
      ['DOS01', 10, 60, 0],
    ],
  }));

  const assessment = result.assessments.find(item => item.productSku === 'DOS01');
  assert.equal(assessment.planningVelocity, 6);
  assert.deepEqual(assessment.winningEvidence, [{ kind: 'sellable-over-days-of-supply', value: 6 }]);
  assert.deepEqual(assessment.adjustmentReasons.map(reason => reason.code), ['INVENTORY_DOS_APPLIED']);
});

test('invalid evidence cannot create zero, extreme, or infinite Planning Velocity', () => {
  const result = buildPlanningVelocities(buildInput({
    rawH10Text: [
      'United StatesB000000005BAD01', 'Infinity',
      'United StatesB000000006BAD01', '-5',
      'United StatesB000000007BAD01', 'not-a-number',
      'United StatesB000000008BAD01', '0',
      'United StatesB000000009SAFE01', '5',
    ].join('\n'),
    inventoryRows: [
      ['SKU', 'Days of Supply', 'Sellable Inventory', 'Inbound'],
      ['BAD01', 0, 100, 0],
      ['BAD01', -1, 100, 0],
      ['BAD01', 10, 'Infinity', 0],
      ['SAFE01', 0, 100, 0],
    ],
  }));

  const invalid = result.assessments.find(item => item.productSku === 'BAD01');
  assert.equal(invalid.status, 'no-valid-candidate');
  assert.equal(invalid.planningVelocity, null);
  assert.deepEqual(invalid.candidates, []);
  assert.deepEqual(invalid.winningEvidence, []);
  assert.ok(invalid.ignoredEvidence.some(item => item.code === 'INVALID_H10_SOURCE'));
  assert.ok(invalid.ignoredEvidence.some(item => item.code === 'INVALID_INVENTORY_DOS'));

  const safe = result.assessments.find(item => item.productSku === 'SAFE01');
  assert.equal(safe.planningVelocity, 5);
  assert.equal(Number.isFinite(safe.planningVelocity), true);
});

test('previous-28-day median can win and same Product SKU/date history is replaced', () => {
  const result = buildPlanningVelocities(buildInput({
    rawH10Text: 'United StatesB000000003HIST01\n5',
    historySamples: [
      { productSku: 'HIST01', date: '2026-07-29', h10SourceVelocity: 100 },
      { productSku: 'HIST01', date: '2026-08-25', h10SourceVelocity: 8 },
      { productSku: 'HIST01', date: '2026-08-26', h10SourceVelocity: 12 },
      { productSku: 'HIST01', date: '2026-08-27', h10SourceVelocity: 4 },
    ],
  }));

  const assessment = result.assessments.find(item => item.productSku === 'HIST01');
  assert.equal(assessment.historyMedian, 10);
  assert.equal(assessment.planningVelocity, 10);
  assert.deepEqual(assessment.winningEvidence, [{ kind: 'local-28-day-median', value: 10 }]);
  assert.ok(assessment.velocityRisks.some(risk => risk.code === 'HISTORICAL_DECLINE'));

  const currentSamples = result.nextHistorySamples.filter(sample => (
    sample.productSku === 'HIST01' && sample.date === '2026-08-27'
  ));
  assert.deepEqual(currentSamples, [{ productSku: 'HIST01', date: '2026-08-27', h10SourceVelocity: 5 }]);
  assert.equal(result.nextHistorySamples.some(sample => sample.date === '2026-07-29'), false);
});

test('history median follows the H10 observation date rather than the later viewer date', () => {
  const result = buildPlanningVelocities(buildInput({
    asOfDate: '2026-08-27',
    sourceObservedOn: '2026-08-01',
    rawH10Text: 'United StatesB000000012DATE01\n5',
    historySamples: [
      { productSku: 'DATE01', date: '2026-07-03', h10SourceVelocity: 100 },
      { productSku: 'DATE01', date: '2026-07-04', h10SourceVelocity: 8 },
      { productSku: 'DATE01', date: '2026-07-31', h10SourceVelocity: 12 },
      { productSku: 'DATE01', date: '2026-08-01', h10SourceVelocity: 4 },
      { productSku: 'DATE01', date: '2026-08-02', h10SourceVelocity: 200 },
    ],
  }));

  const assessment = result.assessments.find(item => item.productSku === 'DATE01');
  assert.equal(assessment.historyMedian, 10);
  assert.equal(assessment.planningVelocity, 10);
  assert.deepEqual(result.nextHistorySamples.filter(sample => sample.date === '2026-08-01'), [
    { productSku: 'DATE01', date: '2026-08-01', h10SourceVelocity: 5 },
  ]);
  assert.equal(result.nextHistorySamples.some(sample => sample.date === '2026-08-27'), false);
});

test('Velocity Risk boundaries are strict at 20%, 7 DOS days, and 40% decline', () => {
  const result = buildPlanningVelocities(buildInput({
    rawH10Text: [
      'United StatesB000000020EDGE20', '10',
      'United StatesB000000021EDGE20', '12',
      'United StatesB000000022OVER20', '10',
      'United StatesB000000023OVER20', '12.01',
      'United StatesB000000024DROP40', '6',
      'United StatesB000000025DROP41', '5.99',
    ].join('\n'),
    inventoryRows: [
      ['SKU', 'Days of Supply', 'Sellable Inventory', 'Inbound'],
      ['DOS7', 7, 70, 0],
      ['DOS701', 7.01, 70.1, 0],
    ],
    historySamples: [
      { productSku:'DROP40', date:'2026-08-26', h10SourceVelocity:10 },
      { productSku:'DROP41', date:'2026-08-26', h10SourceVelocity:10 },
    ],
  }));
  const bySku = new Map(result.assessments.map(item => [item.productSku, item]));
  assert.equal(bySku.get('EDGE20').velocityRisks.some(risk => risk.code === 'POSITIVE_SIGNAL_DISAGREEMENT'), false);
  assert.equal(bySku.get('OVER20').velocityRisks.some(risk => risk.code === 'POSITIVE_SIGNAL_DISAGREEMENT'), true);
  assert.equal(bySku.get('DOS7').velocityRisks.some(risk => risk.code === 'LOW_DAYS_OF_SUPPLY'), true);
  assert.equal(bySku.get('DOS701').velocityRisks.some(risk => risk.code === 'LOW_DAYS_OF_SUPPLY'), false);
  assert.equal(bySku.get('DROP40').velocityRisks.some(risk => risk.code === 'HISTORICAL_DECLINE'), false);
  assert.equal(bySku.get('DROP41').velocityRisks.some(risk => risk.code === 'HISTORICAL_DECLINE'), true);
});

test('a future observation date cannot consume future history or create a sample', () => {
  const result = buildPlanningVelocities(buildInput({
    asOfDate:'2026-08-27',
    sourceObservedOn:'2026-08-28',
    rawH10Text:'United StatesB000000026FUTURE1\n5',
    historySamples:[{ productSku:'FUTURE1', date:'2026-08-27', h10SourceVelocity:100 }],
  }));
  const assessment = result.assessments.find(item => item.productSku === 'FUTURE1');
  assert.equal(assessment.historyMedian, null);
  assert.equal(assessment.planningVelocity, 5);
  assert.equal(result.nextHistorySamples.some(sample => sample.date === '2026-08-28'), false);
});

test('history retention keeps exactly today plus the prior 27 dates', () => {
  const historySamples = Array.from({ length:29 }, (_, index) => ({
    productSku:'KEEP28',
    date:new Date(Date.UTC(2026, 6, 31 + index)).toISOString().slice(0, 10),
    h10SourceVelocity:index + 1,
  }));
  const result = buildPlanningVelocities(buildInput({
    asOfDate:'2026-08-28',
    sourceObservedOn:'2026-08-28',
    rawH10Text:'United StatesB000000030KEEP28\n99',
    historySamples,
  }));

  const retained = result.nextHistorySamples.filter(sample => sample.productSku === 'KEEP28');
  assert.equal(retained.length, 28);
  assert.equal(retained.some(sample => sample.date === '2026-07-31'), false);
  assert.equal(retained.some(sample => sample.date === '2026-08-01'), true);
  assert.deepEqual(retained.filter(sample => sample.date === '2026-08-28'), [
    { productSku:'KEEP28', date:'2026-08-28', h10SourceVelocity:99 },
  ]);
});

test('an observation on as-of minus 28 is not reinserted outside the 28-sample retention window', () => {
  const historySamples = Array.from({ length:28 }, (_, index) => ({
    productSku:'OLDOBS1',
    date:new Date(Date.UTC(2026, 7, 1 + index)).toISOString().slice(0, 10),
    h10SourceVelocity:index + 1,
  }));
  const result = buildPlanningVelocities(buildInput({
    asOfDate:'2026-08-28',
    sourceObservedOn:'2026-07-31',
    rawH10Text:'United StatesB000000032OLDOBS1\n99',
    historySamples,
  }));
  const retained = result.nextHistorySamples.filter(sample => sample.productSku === 'OLDOBS1');
  assert.equal(retained.length, 28);
  assert.equal(retained.some(sample => sample.date === '2026-07-31'), false);
  assert.equal(retained[0].date, '2026-08-01');
});

test('missing canonical observation metadata cannot activate a local-history candidate', () => {
  const result = buildPlanningVelocities(buildInput({
    sourceObservedOn:null,
    rawH10Text:'United StatesB000000033NODATE1\n5',
    historySamples:[{ productSku:'NODATE1', date:'2026-08-26', h10SourceVelocity:100 }],
  }));
  const assessment = result.assessments.find(item => item.productSku === 'NODATE1');
  assert.equal(assessment.historyMedian, null);
  assert.equal(assessment.planningVelocity, 5);
  assert.equal(result.nextHistorySamples.some(sample => sample.date === '2026-08-27'), false);
});

test('invalid same-day H10 evidence removes a stale valid sample for that Product SKU', () => {
  const result = buildPlanningVelocities(buildInput({
    rawH10Text:'United StatesB000000031STALE01\nN/A',
    historySamples:[
      { productSku:'STALE01', date:'2026-08-27', h10SourceVelocity:77 },
      { productSku:'STALE01', date:'2026-08-26', h10SourceVelocity:8 },
    ],
  }));

  assert.equal(result.h10Observations.length, 1);
  assert.equal(result.h10Observations[0].value, null);
  assert.equal(result.nextHistorySamples.some(sample => sample.productSku === 'STALE01' && sample.date === '2026-08-27'), false);
  assert.equal(result.nextHistorySamples.some(sample => sample.productSku === 'STALE01' && sample.date === '2026-08-26'), true);
});

test('browser pages receive the same frozen Planning Velocity Interface as ESM callers', async () => {
  globalThis.window = {};
  try {
    const module = await import('../shared/planning-velocity.js?browser-interface-test=1');
    assert.equal(window.SupplyVelocity.buildPlanningVelocities, module.buildPlanningVelocities);
    assert.equal(Object.isFrozen(window.SupplyVelocity), true);
  } finally {
    delete globalThis.window;
  }
});
