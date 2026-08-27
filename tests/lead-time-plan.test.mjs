import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const repoRoot = path.resolve(import.meta.dirname, '..');
const indexHtml = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');
const bossHtml = fs.readFileSync(path.join(repoRoot, 'Boss', 'index.html'), 'utf8');

function extractFunctionSource(html, name) {
  const marker = `function ${name}(`;
  const start = html.indexOf(marker);
  assert.notEqual(start, -1, `page should define ${name}`);
  const bodyStart = html.indexOf('{', start);
  let depth = 0;
  for (let index = bodyStart; index < html.length; index += 1) {
    const char = html[index];
    if (char === '{') depth += 1;
    if (char === '}') {
      depth -= 1;
      if (depth === 0) return html.slice(start, index + 1);
    }
  }
  throw new Error(`Could not extract ${name}`);
}

for (const [entrypoint, html] of [['public', indexHtml], ['Boss', bossHtml]]) {
  test(`${entrypoint}: order generator uses compact labels and one combined quantity column`, () => {
    const tableStart = html.indexOf('<table id="productTable"');
    const tableEnd = html.indexOf('</table>', tableStart);
    assert.notEqual(tableStart, -1);
    assert.notEqual(tableEnd, -1);
    const generatorMarkup = html.slice(html.lastIndexOf('id="generatorColumnBar"', tableStart), tableEnd);
    assert.match(generatorMarkup, /<th>序號<\/th><th>品號<\/th><th>數量<\/th>/);
    assert.doesNotMatch(generatorMarkup, /品號 \/ 下單品號|<th>包數<\/th><th>袋數\/盒數<\/th>/);
    assert.match(generatorMarkup, /含舊訂單可售天數/);
    assert.match(generatorMarkup, /新訂單到港後總可售天數/);
  });

  test(`${entrypoint}: generator quantity rows and pallet controls use semantic compact markup`, () => {
    const addProductSource = extractFunctionSource(html, 'addProduct');
    const totalsSource = extractFunctionSource(html, 'updateTotals');
    assert.match(addProductSource, /generatorQuantityGroup/);
    assert.match(addProductSource, /class="edit-pallets-input"[^>]*step="0\.5"/);
    assert.match(addProductSource, /class="box-size-cell"/);
    assert.match(addProductSource, /class="drag-handle"[^>]*aria-label="按住拖曳排序"/);
    assert.match(totalsSource, /querySelector\('\.box-size-cell'\)/);
    assert.doesNotMatch(totalsSource, /row\.cells\[7\]/);
    assert.match(html, /\.generatorQuantityGroup \{[^}]*grid-template-columns:repeat\(2,/);
    assert.match(html, /\.generatorCoverageStatus\.healthy \{ color:#15803d; \}/);
    assert.match(html, /\.generatorCoverageStatus\.excess \{ color:#b91c1c; \}/);
    assert.match(html, /wireGeneratorRowSorting\(\);/);
  });

  test(`${entrypoint}: inline JavaScript parses`, () => {
    const scripts = Array.from(html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi));
    assert.ok(scripts.length > 0);
    scripts.forEach((match, index) => new vm.Script(match[1], { filename: `${entrypoint}#inline-${index + 1}` }));
  });

  test(`${entrypoint}: reorder export headers match every data row`, () => {
    const exportContext = {
      daysThresholdEl: { value: '180' },
      mainRowsAll: [{ sku: 'EXPORT01', asin: 'B000000000', speed: 10, arrivalDate: 'N/A' }],
      applyFilters: rows => rows,
      getFbaTransferDays: () => 21,
      getLeadTimePlan: () => ({
        currentAmzStock: 100, jspReserve: 0, inboundBefore: 0, assumedBeforeNew: 50,
        plannedNotPlaced: 20, stoppedInbound: 0, unknownStatusInbound: 50, overdueInbound: 0,
        conflictingScheduleInbound: 0, unmatchedInbound: 0, amzInboundNoEta: 10,
        leadDemand: 1110, projectedStock: 0, shortageDays: 101, orderByDate: new Date(),
        rawSuggestedQty: 1800, suggestedQty: 1820, orderIncrement: 28, postArrivalDays: 182,
        scheduledWithinTarget: 0, uncertainInbound: 80, uncertainDeadline: new Date(), laterInbound: 0,
        newArrivalDate: new Date(), newSellableDate: new Date(),
      }),
      formatDateYMD: () => '2026-08-27',
      fmtDateText: value => value,
    };
    vm.createContext(exportContext);
    vm.runInContext(`${extractFunctionSource(html, 'getBoundedWholeDays')}\nthis.getBoundedWholeDays = getBoundedWholeDays;`, exportContext);
    vm.runInContext(`${extractFunctionSource(html, 'getReorderTargetDays')}\nthis.getReorderTargetDays = getReorderTargetDays;`, exportContext);
    vm.runInContext(`${extractFunctionSource(html, 'exportReorderRowsFiltered')}\nthis.exportReorderRowsFiltered = exportReorderRowsFiltered;`, exportContext);
    const result = exportContext.exportReorderRowsFiltered();
    assert.equal(result.body.length, 1);
    assert.equal(result.headers.length, result.body[0].length);
    assert.ok(result.headers.includes('舊單假設早於新單_已納入合計_勿與其中欄重複加總'));
    assert.ok(result.headers.includes('全部待確認供給_含已納入與未納入_僅供追蹤勿橫向加總'));
  });
}

test('both entrypoints load the same planner Module and contain only thin planner adapters', () => {
  assert.match(indexHtml, /<script type="module" src="\.\/shared\/legacy-planning-adapter\.js"><\/script>/);
  assert.match(bossHtml, /<script type="module" src="\.\.\/shared\/legacy-planning-adapter\.js"><\/script>/);
  for (const [entrypoint, html] of [['public', indexHtml], ['Boss', bossHtml]]) {
    for (const removedImplementation of [
      'roundToExecutableOrderQty',
      'consumeStockForDays',
      'projectStockAcrossEvents',
      'getRequiredQtyAcrossEvents',
      'getFirstStockoutDateAcrossEvents',
      'getContinuousCoverageDays',
    ]) {
      assert.equal(html.includes(`function ${removedImplementation}(`), false, `${entrypoint} should not copy ${removedImplementation}`);
    }
    assert.match(extractFunctionSource(html, 'getLeadTimePlan'), /SupplyPlanningLegacy\.planLegacyReplenishment/);
    assert.match(extractFunctionSource(html, 'getPostArrivalCoverageDays'), /continuousPostOrderCoverageDays/);
  }
});

test('public and Boss adapters send the same normalized row to the shared planner Interface', () => {
  function runAdapter(html) {
    const calls = [];
    const context = {
      window: { SupplyPlanningLegacy: { planLegacyReplenishment(input) { calls.push(input); return { marker: 'shared-result' }; } } },
      getJamBreakdownForSku: () => [{ orderName: 'JAM-1', qty: 280, arrivalDate: '2026-10-16', isReceived: false }],
      physicalToAmazonUnits: (_sku, qty) => qty / 2,
      getPlanningAsOfDate: () => '2026-08-27',
      getPlanningPolicy: (targetDays, sku) => ({ targetDays, sku }),
      ordersEl: { value: 'ready' },
      metaIsReady: () => false,
      getReorderTargetDays: () => 180,
    };
    vm.createContext(context);
    vm.runInContext(`${extractFunctionSource(html, 'getLeadTimePlan')}\nthis.getLeadTimePlan = getLeadTimePlan;`, context);
    const row = { sku: 'GCTL03', speed: 8.83, usAmz: 369, usJsp: 0 };
    assert.deepEqual(context.getLeadTimePlan(row, 365, 500), { marker: 'shared-result' });
    assert.equal(calls.length, 1);
    return structuredClone(calls[0]);
  }
  const publicInput = runAdapter(indexHtml);
  const bossInput = runAdapter(bossHtml);
  assert.deepEqual(publicInput, bossInput);
  assert.equal(publicInput.asOfDate, '2026-08-27');
  assert.equal(publicInput.openOrders[0].quantity, 140);
  assert.equal(publicInput.openOrders[0].portArrivalDate, '2026-10-16');
  assert.equal(publicInput.orderDraftQuantity, 500);
});

test('planning-day compatibility adapters clamp, round, and sync persisted decimal values', () => {
  for (const [entrypoint, html] of [['public', indexHtml], ['Boss', bossHtml]]) {
    const context = {
      daysThresholdEl: { value: '180.6' },
      leadTimeDaysEl: { value: '90.5' },
      fbaTransferDaysEl: { value: '21.5' },
      getOrderIncrementInAmazonUnits: () => 28,
    };
    vm.createContext(context);
    for (const name of [
      'getBoundedWholeDays',
      'getReorderTargetDays',
      'getLeadTimeDays',
      'getFbaTransferDays',
      'normalizePlanningDayInputs',
      'getPlanningPolicy',
    ]) {
      vm.runInContext(`${extractFunctionSource(html, name)}\nthis.${name} = ${name};`, context);
    }
    assert.equal(context.getReorderTargetDays(), 181, entrypoint);
    assert.equal(context.getLeadTimeDays(), 91, entrypoint);
    assert.equal(context.getFbaTransferDays(), 22, entrypoint);
    assert.deepEqual(structuredClone(context.getPlanningPolicy(180.6, 'SKU01')), {
      leadTimeDays: 91,
      transferTimeDays: 22,
      targetDays: 181,
      executableOrderIncrement: 28,
    });
    context.normalizePlanningDayInputs();
    assert.deepEqual([
      context.daysThresholdEl.value,
      context.leadTimeDaysEl.value,
      context.fbaTransferDaysEl.value,
    ], ['181', '91', '22']);
  }
});

test('no-velocity plans remain unavailable without an empty missing-data message', () => {
  for (const [entrypoint, html] of [['public', indexHtml], ['Boss', bossHtml]]) {
    const context = {};
    vm.createContext(context);
    vm.runInContext(`${extractFunctionSource(html, 'getPlanningUnavailableReason')}\nthis.getPlanningUnavailableReason = getPlanningUnavailableReason;`, context);
    assert.equal(context.getPlanningUnavailableReason({ status: 'no-velocity', missingSources: [] }), '無速度，無法判斷', entrypoint);
    assert.equal(context.getPlanningUnavailableReason({ status: 'missing-data', missingSources: ['AMZ庫存', 'JAM訂單'] }), '缺 AMZ庫存、JAM訂單', entrypoint);
    assert.match(extractFunctionSource(html, 'getDecisionRows'), /getPlanningUnavailableReason\(supplyPlan\)/, entrypoint);
  }
});

test('Order Draft coverage is unavailable instead of bypassing the shared planner', () => {
  for (const [entrypoint, html] of [['public', indexHtml], ['Boss', bossHtml]]) {
    const source = extractFunctionSource(html, 'getPostArrivalCoverageDays');
    const context = {
      getCanonicalSku: value => value,
      getSpeedForProduct: () => 10,
      mainRowsAll: [],
      getLeadTimePlan: () => { throw new Error('planner should not be called without a normalized source row'); },
    };
    vm.createContext(context);
    vm.runInContext(`${source}\nthis.getPostArrivalCoverageDays = getPostArrivalCoverageDays;`, context);
    assert.equal(context.getPostArrivalCoverageDays({ productCode: 'NO-ROW' }, 1000, 1000), null, entrypoint);
    assert.doesNotMatch(source, /getAvailForProduct|getLeadTimeDays|getFbaTransferDays/, entrypoint);
  }
});

test('coverage colors use the displayed 180 and 365 day boundaries', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${extractFunctionSource(indexHtml, 'getGeneratorCoverageBand')}\nthis.getGeneratorCoverageBand = getGeneratorCoverageBand;`, context);
  assert.equal(context.getGeneratorCoverageBand(null, 180), 'neutral');
  assert.equal(context.getGeneratorCoverageBand(179.94, 180), 'low');
  assert.equal(context.getGeneratorCoverageBand(179.96, 180), 'healthy');
  assert.equal(context.getGeneratorCoverageBand(365.04, 180), 'healthy');
  assert.equal(context.getGeneratorCoverageBand(365.06, 180), 'excess');
});

test('recommended pallet counts still round up to the smallest half pallet before #57 migration', () => {
  const context = {};
  vm.createContext(context);
  vm.runInContext(`${extractFunctionSource(indexHtml, 'roundUpToHalfPallet')}\nthis.roundUpToHalfPallet = roundUpToHalfPallet;`, context);
  assert.equal(context.roundUpToHalfPallet(0), 0);
  assert.equal(context.roundUpToHalfPallet(3.01), 3.5);
  assert.equal(context.roundUpToHalfPallet(3.5), 3.5);
  assert.equal(context.roundUpToHalfPallet(3.5001), 4);
});

test('planned quantity application skips zero suggestions and drives valid plans from pallets', () => {
  let addCalls = 0;
  let updatedInput = null;
  const palletInput = { value: '' };
  const quantityInput = { value: '' };
  const row = { querySelector(selector) { if (selector === '.edit-pallets-input') return palletInput; if (selector === '.edit-quantity-input') return quantityInput; return null; } };
  const context = {
    addProduct() { addCalls += 1; return row; },
    updateFields(input) { updatedInput = input; },
  };
  vm.createContext(context);
  for (const name of ['roundUpToHalfPallet', 'applyPlannedQuantityToGenerator']) {
    vm.runInContext(`${extractFunctionSource(indexHtml, name)}\nthis.${name} = ${name};`, context);
  }
  assert.equal(context.applyPlannedQuantityToGenerator({ productCode: 'ZERO' }, 0, null), null);
  assert.equal(addCalls, 0);
  context.applyPlannedQuantityToGenerator({ productCode: 'PLAN' }, 1000, 3.01);
  assert.equal(addCalls, 1);
  assert.equal(palletInput.value, '3.5');
  assert.equal(updatedInput, palletInput);
});

test('drag sorting renumbers rows and persists the new order', () => {
  const source = extractFunctionSource(indexHtml, 'wireGeneratorRowSorting');
  assert.match(source, /pointerdown/);
  assert.match(source, /pointermove/);
  assert.match(source, /pointerup/);
  assert.match(source, /setPointerCapture/);
  assert.match(source, /document\.elementFromPoint/);
  assert.match(source, /insertBefore/);
  assert.match(source, /document\.addEventListener\('pointerup', finishDrag\)/);
  assert.match(source, /document\.addEventListener\('pointercancel', finishDrag\)/);
  assert.match(source, /updateRowNumbers\(\)/);
  assert.match(source, /saveGeneratorDraft\(\)/);
});
