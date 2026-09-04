import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const repoRoot = path.resolve(import.meta.dirname, '..');
const indexHtml = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');
const bossHtml = fs.readFileSync(path.join(repoRoot, 'Boss', 'index.html'), 'utf8');
const sharedThemeCss = fs.readFileSync(path.join(repoRoot, 'shared', 'supply-fba-theme.css'), 'utf8');

test('manual sales velocity highlights the entire planning value instead of a small dot', () => {
  assert.match(sharedThemeCss, /\.generatorPlanningDetails\.hasManualVelocity > summary\s*\{[^}]*border:1px solid #f59e0b!important;[^}]*background:#fef3c7!important;/s);
  assert.match(sharedThemeCss, /\.order-generator \.palletDaysCell\s*\{[^}]*text-align:center;/s);
  assert.match(sharedThemeCss, /\.order-generator \.generatorPlanningDetails\s*\{[^}]*inline-size:84px;/s);
  assert.match(sharedThemeCss, /\.order-generator \.generatorPlanningDetails > summary\s*\{[^}]*justify-content:center;[^}]*inline-size:100%;/s);
});

test('order table header remains frozen inside the vertical scroll area', () => {
  assert.match(sharedThemeCss, /\.order-generator table\s*\{[^}]*overflow:visible;/s);
  assert.match(sharedThemeCss, /\.order-generator \.table-responsive thead th\s*\{[^}]*position:sticky;[^}]*top:0;[^}]*z-index:5;/s);
});

function extractFunctionSource(html, name) {
  const marker = `function ${name}(`;
  const start = html.indexOf(marker);
  assert.notEqual(start, -1, `page should define ${name}`);
  const signatureEnd = html.indexOf(') {', start);
  assert.notEqual(signatureEnd, -1, `page should define a body for ${name}`);
  const bodyStart = signatureEnd + 2;
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
  test(`${entrypoint}: Order Draft exposes Vietnam, Taiwan, and outsourced groups in display order`, () => {
    const generatorStart = html.indexOf('class="order-generator"');
    const generatorEnd = html.indexOf('</section>', generatorStart);
    assert.notEqual(generatorStart, -1);
    assert.notEqual(generatorEnd, -1);
    const generatorMarkup = html.slice(generatorStart, generatorEnd);
    const tabs = Array.from(generatorMarkup.matchAll(/<input type="radio" name="orderGroupSelect" value="([^"]+)"[^>]*>\s*<span>([^<]+)<\/span>/g))
      .map(match => [match[1], match[2].trim()]);
    assert.deepEqual(tabs, [
      ['vietnam', '越南'],
      ['taiwan', '台灣'],
      ['subcontract', '委外'],
    ]);
    assert.doesNotMatch(generatorMarkup, /name="countrySelect"|value="VN"|value="TW"|value="Others"|越南廠|台灣廠|其他/);
  });

  test(`${entrypoint}: Order Draft loads the shared versioned state adapter and approved SKU pairs`, () => {
    const expectedStateSource = entrypoint === 'public'
      ? './shared/order-draft-state.js'
      : '../shared/order-draft-state.js';
    assert.match(html, new RegExp(`<script type="module" src="${expectedStateSource.replaceAll('.', '\\.')}"></script>`));
    assert.match(html, /const equivalentSkuPairs = Array\.from\(window\.SUPPLY_EQUIVALENT_SKU_PAIRS/);
    assert.doesNotMatch(html, /const equivalentSkuPairs = \[\s*\["TTS05AM-1", "7ATSD010AB"\]/);
  });

  test(`${entrypoint}: order generator uses compact labels and one combined quantity column`, () => {
    const tableStart = html.indexOf('<table id="productTable"');
    const tableEnd = html.indexOf('</table>', tableStart);
    assert.notEqual(tableStart, -1);
    assert.notEqual(tableEnd, -1);
    const generatorMarkup = html.slice(html.lastIndexOf('id="generatorColumnBar"', tableStart), tableEnd);
    assert.match(generatorMarkup, /<th>序號<\/th><th>品號<\/th><th>數量<\/th>/);
    assert.doesNotMatch(generatorMarkup, /品號 \/ 下單品號|<th>包數<\/th><th>袋數\/盒數<\/th>/);
    assert.match(generatorMarkup, /舊訂單可售天數/);
    assert.doesNotMatch(generatorMarkup, /含舊訂單可售天數/);
    assert.match(generatorMarkup, /新訂單到港後總可售天數/);
  });

  test(`${entrypoint}: order generator links to the configured H10 sales velocity page`, () => {
    const generatorStart = html.indexOf('class="order-generator"');
    const generatorEnd = html.indexOf('</section>', generatorStart);
    assert.notEqual(generatorStart, -1);
    assert.notEqual(generatorEnd, -1);
    const generatorMarkup = html.slice(generatorStart, generatorEnd);
    assert.match(generatorMarkup, /href="https:\/\/members\.helium10\.com\/inventory-management\/restock-suggestions-new\/index\?accountId=1547156136"/);
    assert.match(generatorMarkup, /target="_blank" rel="noopener noreferrer"/);
    assert.match(generatorMarkup, /> H10銷售速度查詢<\/a>/);
    assert.doesNotMatch(generatorMarkup, /onclick="openModal\(\)"/);
  });

  test(`${entrypoint}: Order Draft gives row number, SKU copy, and Seller Central distinct actions`, () => {
    const expectedSource = entrypoint === 'public'
      ? './shared/order-velocity-overrides.js'
      : '../shared/order-velocity-overrides.js';
    assert.match(html, new RegExp(`<script type="module" src="${expectedSource.replaceAll('.', '\\.')}"`));

    const addProductSource = extractFunctionSource(html, 'addProduct');
    const disclosureSource = extractFunctionSource(html, 'renderGeneratorPlanningDetails');
    const velocitySource = extractFunctionSource(html, 'getPlanningVelocityForProduct');
    const leadTimeSource = extractFunctionSource(html, 'getLeadTimePlan');
    const sourceClickSource = extractFunctionSource(html, 'showGeneratorOrderSources');
    const copySkuSource = extractFunctionSource(html, 'copyGeneratorOrderCode');
    const numberingSource = extractFunctionSource(html, 'updateRowNumbers');
    assert.match(addProductSource, /renderGeneratorPlanningDetails/);
    assert.match(addProductSource, /generatorRowNumberButton/);
    assert.match(addProductSource, /generatorSkuCopyButton/);
    assert.match(addProductSource, /generatorInventoryLink/);
    assert.match(addProductSource, /sellercentral\.amazon\.com\/myinventory\/inventory\?fulfilledBy=all&amp;searchTerm=/);
    assert.doesNotMatch(addProductSource, /generatorSkuSourceButton/);
    assert.match(disclosureSource, /manual-velocity-input/);
    assert.match(disclosureSource, /pallet-days-value/);
    assert.doesNotMatch(html, /hasManualVelocity > summary::after/);
    assert.doesNotMatch(disclosureSource, /訂單來源|generatorOrderSource/);
    assert.match(velocitySource, /getOrderVelocityOverride/);
    assert.match(leadTimeSource, /getPlanningVelocityForProduct/);
    assert.match(sourceClickSource, /showSkuJamBreakdown/);
    assert.match(copySkuSource, /navigator\.clipboard\?\.writeText/);
    assert.match(copySkuSource, /dataset\.orderCode/);
    assert.match(numberingSource, /generatorRowNumberButton/);
    assert.match(html, /點序號查看訂單來源；點品號直接複製；右上箭頭前往 Seller Central。/);
  });

  test(`${entrypoint}: generator quantity rows and pallet controls use semantic compact markup`, () => {
    const addProductSource = extractFunctionSource(html, 'addProduct');
    const totalsSource = extractFunctionSource(html, 'updateTotals');
    const saveDraftSource = extractFunctionSource(html, 'saveGeneratorDraft');
    const serializeDraftSource = extractFunctionSource(html, 'serializeGeneratorRow');
    const persistDraftSource = extractFunctionSource(html, 'persistGeneratorDraft');
    const restoreDraftSource = extractFunctionSource(html, 'restoreGeneratorDraft');
    const loadDraftSource = extractFunctionSource(html, 'loadGeneratorDraftState');
    const equivalentToggleSource = extractFunctionSource(html, 'renderEquivalentOrderToggle');
    const hydrateRowSource = extractFunctionSource(html, 'hydrateGeneratorRow');
    const syncLockSource = extractFunctionSource(html, 'syncGeneratorLockButton');
    const lockSource = extractFunctionSource(html, 'toggleLock');
    const palletStepSource = extractFunctionSource(html, 'stepGeneratorPallets');
    const palletKeySource = extractFunctionSource(html, 'handleGeneratorPalletKey');
    const nativePalletSource = extractFunctionSource(html, 'useNativePalletStepper');
    const exportSource = extractFunctionSource(html, 'exportGeneratorToExcel');
    const draftContextSource = extractFunctionSource(html, 'getGeneratorDraftContext');
    const syncRowsSource = extractFunctionSource(html, 'syncVisibleGeneratorRowsToDraft');
    const switchOrderSkuSource = extractFunctionSource(html, 'toggleEquivalentOrderCode');
    const confirmPackagingSource = extractFunctionSource(html, 'confirmPackagingReassignment');
    const reassignPackagingSource = extractFunctionSource(html, 'reassignGeneratorPackaging');
    const assignmentStatusSource = extractFunctionSource(html, 'renderPackagingAssignmentStatus');
    assert.match(assignmentStatusSource, /return action \?[^:]+: '';/s);
    assert.doesNotMatch(assignmentStatusSource, /包裝 \$\{version\}|packagingAssignmentStatus/);
    assert.match(addProductSource, /generatorQuantityGroup/);
    assert.match(addProductSource, /class="palletStepControl"/);
    assert.match(addProductSource, /useNativePalletStepper\(row\)/);
    assert.match(nativePalletSource, /input\.step = '0\.5'/);
    assert.match(nativePalletSource, /removeAttribute\('onkeydown'\)/);
    assert.match(nativePalletSource, /querySelector\('\.palletStepButtons'\)\?\.remove\(\)/);
    assert.match(addProductSource, /normalizeGeneratorPallets\(this,/);
    assert.match(addProductSource, /class="box-size-cell"/);
    assert.match(addProductSource, /class="generatorActionGroup"/);
    assert.match(addProductSource, /class="drag-handle"[^>]*aria-label="按住拖曳排序"/);
    assert.match(addProductSource, /class="lock-button"[^>]*aria-label="鎖定這列"[^>]*aria-pressed="false"[^>]*title="鎖定這列"/);
    assert.match(addProductSource, /class="remove-button"[^>]*aria-label="刪除這列"[^>]*title="刪除這列"/);
    assert.match(totalsSource, /querySelector\('\.box-size-cell'\)/);
    assert.doesNotMatch(totalsSource, /row\.cells\[7\]/);
    assert.match(html, /\.generatorQuantityGroup \{[^}]*display:flex;[^}]*flex-direction:column/);
    assert.match(html, /\.palletStepControl \{[^}]*width:88px;[^}]*height:34px;/);
    assert.match(html, /\.order-generator \.action-button,[^{]+\{[^}]*inline-size:28px;[^}]*block-size:28px;/);
    assert.match(html, /\.generatorActionGroup \{[^}]*inline-size:90px;/);
    assert.match(html, /@media \(pointer:coarse\) \{[\s\S]*?\.order-generator \.generatorActionGroup > button, \.order-generator \.miniBtn \{[^}]*inline-size:40px;[^}]*block-size:40px;/);
    const coverageBase = entrypoint === 'public' ? './shared/' : '../shared/';
    assert.match(html, new RegExp(`<link rel="stylesheet" href="${coverageBase.replaceAll('.', '\\.')}coverage-indicator\\.css">`));
    assert.match(html, new RegExp(`<script type="module" src="${coverageBase.replaceAll('.', '\\.')}coverage-indicator\\.js"></script>`));
    assert.doesNotMatch(html, /generatorCoverageStatus/);
    assert.match(html, /wireGeneratorRowSorting\(\);/);
    assert.doesNotMatch(html, /function roundUpToHalfPallet\(/);
    assert.doesNotMatch(html, /最小 0\.5 棧板/);
    assert.match(serializeDraftSource, /guidance:/);
    assert.match(serializeDraftSource, /warningCode:/);
    assert.match(serializeDraftSource, /orderDraft:/);
    assert.match(serializeDraftSource, /authoritativeField:/);
    assert.match(saveDraftSource, /syncVisibleGeneratorRowsToDraft\(options\)/);
    assert.match(saveDraftSource, /persistGeneratorDraft\(\)/);
    assert.match(draftContextSource, /getOrderSkuPackaging:getOrderSkuPackagingForDraft/);
    assert.match(draftContextSource, /catalogVersion:window\.SUPPLY_PRODUCT_CATALOG_META/);
    assert.match(draftContextSource, /getCoverageDays:\(productSku, orderDraftQuantity\)/);
    assert.match(syncRowsSource, /pinProductSku/);
    assert.match(syncRowsSource, /pinPackaging/);
    assert.match(switchOrderSkuSource, /previewPackagingReassignment/);
    assert.match(switchOrderSkuSource, /confirmPackagingReassignment/);
    assert.match(switchOrderSkuSource, /expectedPackagingVersion/);
    assert.match(confirmPackagingSource, /箱數/);
    assert.match(confirmPackagingSource, /棧板/);
    assert.match(confirmPackagingSource, /到港覆蓋/);
    assert.match(confirmPackagingSource, /訂單群組/);
    assert.match(reassignPackagingSource, /type:'reassign-packaging'/);
    assert.match(assignmentStatusSource, /reassignmentRecommended/);
    assert.match(assignmentStatusSource, /reviewRequired/);
    assert.match(persistDraftSource, /saveOrderDraft/);
    assert.match(loadDraftSource, /loadOrderDraft/);
    assert.match(loadDraftSource, /result\.needsSave/);
    assert.match(loadDraftSource, /saveOrderDraft/);
    assert.match(loadDraftSource, /countOrderDraftRepairItems/);
    assert.doesNotMatch(loadDraftSource, /\(result\.issues \|\| \[\]\)\.length \+ \(generatorDraft\.repairOrder \|\| \[\]\)\.length/);
    assert.match(restoreDraftSource, /setActiveOrderGroup/);
    assert.match(restoreDraftSource, /renderActiveOrderGroup/);
    assert.match(equivalentToggleSource, /class="miniBtn equivalentOrderToggle"/);
    assert.match(equivalentToggleSource, /aria-label="切換下單品號為 \$\{safeNextCode\}"/);
    assert.match(equivalentToggleSource, /title="切換為 \$\{safeNextCode\}"/);
    assert.match(equivalentToggleSource, /data-next-order-sku="\$\{safeNextCode\}"/);
    assert.match(equivalentToggleSource, /fa-repeat/);
    assert.match(equivalentToggleSource, /<span>\$\{safeNextCode\}<\/span>/);
    assert.match(html, /\.order-generator \.equivalentOrderToggle \{[^}]*inline-size:auto;[^}]*white-space:nowrap;/);
    assert.match(hydrateRowSource, /syncGeneratorLockButton\(row\)/);
    assert.match(syncLockSource, /locked \? '解除鎖定這列' : '鎖定這列'/);
    assert.match(syncLockSource, /setAttribute\('aria-label', label\)/);
    assert.match(syncLockSource, /setAttribute\('title', label\)/);
    assert.match(syncLockSource, /setAttribute\('aria-pressed', String\(locked\)\)/);
    assert.match(syncLockSource, /aria-hidden="true"/);
    assert.match(lockSource, /setGeneratorPalletState/);
    assert.match(lockSource, /row\.querySelectorAll\('input'\)/);
    assert.match(lockSource, /syncGeneratorLockButton\(row\)/);
    assert.doesNotMatch(lockSource, /btn\.disabled|querySelectorAll\('button'\)/);
    assert.match(palletStepSource, /currentPallets:input\.value/);
    assert.match(palletStepSource, /delta,/);
    assert.match(palletKeySource, /event\.key === 'ArrowUp' \? 1 : -1/);
    assert.match(exportSource, /projectOrderWorkbook/);
    assert.match(exportSource, /generatorDraft = projection\.draft/);
    assert.match(exportSource, /persistGeneratorDraft\(\{ announce:false \}\)/);
    assert.doesNotMatch(exportSource, /getRowExactMetrics/);
    assert.doesNotMatch(extractFunctionSource(html, 'updateFields'), /perPallet\s*\|\|\s*1/);
    assert.match(extractFunctionSource(html, 'updateFields'), /changedField === 'pallets' && catalogIssue/);
  });

  test(`${entrypoint}: generator draft is restored during initial startup`, () => {
    const startup = html.slice(html.lastIndexOf("window.addEventListener('DOMContentLoaded'"));
    assert.match(startup, /buildTables\(\);\s*loadGeneratorDraftState\(\);/);
    assert.doesNotMatch(startup, /if \(!IS_BOSS_PORTAL\) restoreGeneratorDraft/);
    assert.match(startup, /\[name="orderGroupSelect"\]/);
    assert.doesNotMatch(startup, /currentCountry|countrySelect/);
  });

  test(`${entrypoint}: inline JavaScript parses`, () => {
    const scripts = Array.from(html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi));
    assert.ok(scripts.length > 0);
    scripts.forEach((match, index) => new vm.Script(match[1], { filename: `${entrypoint}#inline-${index + 1}` }));
  });

  test(`${entrypoint}: reorder export headers match every data row`, () => {
    const reorderRows = [{ sku: 'EXPORT01', asin: 'B000000000', planningVelocity: 10, arrivalDate: 'N/A' }];
    const exportContext = {
      daysThresholdEl: { value: '180' },
      mainRowsAll: reorderRows,
      applyFilters: rows => rows,
      getReorderRowsForAction:() => reorderRows,
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
      getVelocityExportFields: row => ['10', row.planningVelocity, '最高有效 H10 10', '未調高', '無'],
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
    assert.ok(result.headers.includes('H10 Source Velocity'));
    assert.ok(result.headers.includes('Planning Velocity'));
    assert.ok(result.headers.includes('Velocity Risk'));
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
    assert.match(extractFunctionSource(html, 'getPostArrivalCoverageDays'), /newOrderPortArrivalCoverageDays/);
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
      getPlanningVelocityForProduct: () => 12.5,
      getPlanningPolicy: (targetDays, sku) => ({ targetDays, sku }),
      getProductSpecByCode: sku => ({ productCode: sku }),
      getUnitsPerPallet: () => 840,
      ordersEl: { value: 'ready' },
      metaIsReady: () => false,
      getReorderTargetDays: () => 180,
    };
    vm.createContext(context);
    vm.runInContext(`${extractFunctionSource(html, 'getLeadTimePlan')}\nthis.getLeadTimePlan = getLeadTimePlan;`, context);
    const row = { sku: 'GCTL03', planningVelocity: 8.83, usAmz: 369, usJsp: 0 };
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
  assert.deepEqual(publicInput.packaging, { unitsPerPallet: 840 });
  assert.equal(publicInput.row.planningVelocity, 12.5);
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
      maximumCoverageDays: 365,
      executableOrderIncrement: 28,
    });
    context.normalizePlanningDayInputs();
    assert.deepEqual([
      context.daysThresholdEl.value,
      context.leadTimeDaysEl.value,
      context.fbaTransferDaysEl.value,
    ], ['181', '91', '22']);
    context.daysThresholdEl.value = '';
    context.leadTimeDaysEl.value = '';
    context.fbaTransferDaysEl.value = '';
    assert.equal(context.getReorderTargetDays(), 180, `${entrypoint} blank target`);
    assert.equal(context.getLeadTimeDays(), 90, `${entrypoint} blank lead time`);
    assert.equal(context.getFbaTransferDays(), 0, `${entrypoint} blank transfer`);
  }
});

test('no-velocity plans remain unavailable without an empty missing-data message', () => {
  for (const [entrypoint, html] of [['public', indexHtml], ['Boss', bossHtml]]) {
    const context = {};
    vm.createContext(context);
    vm.runInContext(`${extractFunctionSource(html, 'getPlanningUnavailableReason')}\nthis.getPlanningUnavailableReason = getPlanningUnavailableReason;`, context);
    assert.equal(context.getPlanningUnavailableReason({ status: 'no-velocity', missingSources: [] }), '無有效速度證據，無法建議', entrypoint);
    assert.equal(context.getPlanningUnavailableReason({ status: 'missing-data', missingSources: ['AMZ庫存', 'JAM訂單'] }), '缺 AMZ庫存、JAM訂單', entrypoint);
    assert.match(extractFunctionSource(html, 'getDecisionRows'), /getPlanningUnavailableReason\(supplyPlan\)/, entrypoint);
  }
});

test('Order Draft coverage is unavailable instead of bypassing the shared planner', () => {
  for (const [entrypoint, html] of [['public', indexHtml], ['Boss', bossHtml]]) {
    const source = extractFunctionSource(html, 'getPostArrivalCoverageDays');
    const context = {
      getCanonicalSku: value => value,
      getPlanningVelocityForProduct: () => 10,
      mainRowsAll: [],
      getLeadTimePlan: () => { throw new Error('planner should not be called without a normalized source row'); },
    };
    vm.createContext(context);
    vm.runInContext(`${source}\nthis.getPostArrivalCoverageDays = getPostArrivalCoverageDays;`, context);
    assert.equal(context.getPostArrivalCoverageDays({ productCode: 'NO-ROW' }, 1000, 1000), null, entrypoint);
    assert.doesNotMatch(source, /getAvailForProduct|getLeadTimeDays|getFbaTransferDays/, entrypoint);
  }
});

test('Book coverage comes from the shared planner and excludes the current Order Draft', () => {
  for (const [entrypoint, html] of [['public', indexHtml], ['Boss', bossHtml]]) {
    const calls = [];
    const sourceRow = { sku: 'BOOK01' };
    const context = {
      getCanonicalSku: value => value,
      mainRowsAll: [sourceRow],
      getLeadTimePlan(...args) { calls.push(args); return { bookCoverageDays: 150 }; },
    };
    vm.createContext(context);
    vm.runInContext(`${extractFunctionSource(html, 'formatEstimatedDays')}\nthis.formatEstimatedDays = formatEstimatedDays;`, context);
    assert.equal(context.formatEstimatedDays({ productCode: 'BOOK01' }, 1000, 1000), '150.0 天', entrypoint);
    assert.equal(calls.length, 1, entrypoint);
    assert.equal(calls[0][0], sourceRow, entrypoint);
    assert.equal(calls[0][1], 365, entrypoint);
    assert.equal(calls[0][2], undefined, `${entrypoint} must not pass the current draft quantity into Book coverage`);
    assert.doesNotMatch(extractFunctionSource(html, 'formatEstimatedDays'), /getAvailForProduct|quantity|units/, entrypoint);
  }
});

test('coverage surfaces delegate the fixed 180 and 365 day bands to one shared indicator', () => {
  for (const [entrypoint, html] of [['public', indexHtml], ['Boss', bossHtml]]) {
    const renderMeter = extractFunctionSource(html, 'renderCoverageMeterHtml');
    const renderArrival = extractFunctionSource(html, 'renderGeneratorArrivalCoverage');
    const renderBook = extractFunctionSource(html, 'renderGeneratorBookCoverage');
    assert.match(renderMeter, /SupplyCoverageIndicator/);
    assert.match(renderMeter, /api\.renderCoverageMeter\(\{ coverageDays:/);
    assert.match(renderArrival, /renderCoverageMeterHtml\(days,/);
    assert.match(renderBook, /renderCoverageMeterHtml\(plan\.bookCoverageDays,/);
    assert.doesNotMatch(`${renderMeter}\n${renderArrival}\n${renderBook}`, /getReorderTargetDays|classifyCoverageDays/);
    assert.match(html, /低於 180 天黃色、180–365 天綠色、超過 365 天紅色/);
    assert.doesNotMatch(html, /generatorCoverageStatus/);
    assert.match(html, /coverageHealthCell/);
    assert.ok(entrypoint);
  }
});

test('planned quantity application updates the shared Product SKU row without using the active tab as factory truth', () => {
  const commands = [];
  let persists = 0;
  let renders = 0;
  const context = {
    generatorDraft: { rowsByProductSku:{} },
    currentOrderGroup:'subcontract',
    loadGeneratorDraftState() { throw new Error('already loaded'); },
    normalizeSkuKey: value => value,
    createGeneratorDraftRow(prod, { recommendation }) {
      return {
        productSku:prod.productCode,
        orderSku:prod.productCode,
        quantities:{ orderDraft:recommendation.quantity },
        pallet:{ value:recommendation.pallets, strategy:recommendation.strategy || '' },
        locked:false,
      };
    },
    applyGeneratorDraftCommand(command) {
      commands.push(structuredClone(command));
      const row = { ...command.row, orderGroup:'vietnam' };
      context.generatorDraft.rowsByProductSku[row.productSku] = row;
      return { ok:true, row };
    },
    persistGeneratorDraft() { persists += 1; },
    renderActiveOrderGroup() { renders += 1; },
  };
  vm.createContext(context);
  vm.runInContext(`${extractFunctionSource(indexHtml, 'applyPlannedQuantityToGenerator')}\nthis.applyPlannedQuantityToGenerator = applyPlannedQuantityToGenerator;`, context);
  assert.equal(context.applyPlannedQuantityToGenerator({ productCode: 'ZERO' }, { quantity: 0, pallets: 0, applyBy: 'none' }), null);
  assert.equal(commands.length, 0);
  const added = context.applyPlannedQuantityToGenerator({ productCode: 'PLAN' }, { quantity: 2000, pallets: 2, applyBy: 'pallets' });
  assert.equal(commands.length, 1);
  assert.equal(commands[0].type, 'upsert-row');
  assert.equal(commands[0].row.productSku, 'PLAN');
  assert.equal(added.orderGroup, 'vietnam');
  assert.equal(persists, 1);
  assert.equal(renders, 0, 'an inactive factory group must not be rendered into the current tab');

  context.generatorDraft.rowsByProductSku.PLAN = {
    ...context.generatorDraft.rowsByProductSku.PLAN,
    orderSku:'7PLAN',
    orderGroup:'subcontract',
    locked:false,
  };
  context.applyPlannedQuantityToGenerator({ productCode: 'PLAN' }, { quantity: 180, pallets: 0.45, applyBy: 'quantity' });
  assert.equal(commands[1].row.orderSku, '7PLAN', 'batch refresh must preserve an approved alternate Order SKU');

  context.generatorDraft.rowsByProductSku.PLAN.locked = true;
  assert.equal(context.applyPlannedQuantityToGenerator({ productCode: 'PLAN' }, { quantity: 999, pallets: 1, applyBy: 'quantity' }), null);
  assert.equal(commands.length, 2, 'locked rows must not be overwritten');
});

test('pallet arrow adapter calls the shared one-pallet step without snapping fractions', () => {
  for (const [entrypoint, html] of [['public', indexHtml], ['Boss', bossHtml]]) {
    let updatedInput = null;
    let updatedState = null;
    let saved = 0;
    const input = { value: '2.35' };
    const quantityInput = { value: '940' };
    const guidance = { textContent: '', hidden: true };
    const row = { dataset: { product: 'PLAN', orderDraftQuantity:'940' }, querySelector(selector) { if (selector === '.edit-pallets-input') return input; if (selector === '.edit-quantity-input') return quantityInput; if (selector === '.pallet-guidance') return guidance; return null; } };
    const button = { closest: selector => selector === 'tr' ? row : null };
    let catalogIssue = null;
    const context = {
      window: { SupplyOrderDraft: { stepPalletDraft: ({ currentOrderDraftQuantity, delta, unitsPerPallet }) => ({ pallets:3.35, orderDraftQuantity:currentOrderDraftQuantity + delta * unitsPerPallet }) } },
      getProductSpecByCode: () => ({ productCode: 'PLAN' }),
      getGeneratorProductSpecForRowElement: () => ({ productCode: 'PLAN' }),
      getProductPalletCatalogIssue: () => catalogIssue,
      getUnitsPerPallet: () => 400,
      updateFields(value, _productCode, state) { updatedInput = value; updatedState = state; },
      formatPalletValue: value => String(value),
      formatDraftNumber: value => String(value),
      getPalletRecommendationWarning: () => 'repair pallet catalog',
      setGeneratorPalletState(_row, state) { guidance.textContent = state.warningCode === 'INVALID_PALLET_CATALOG' ? 'repair pallet catalog' : ''; guidance.hidden = !guidance.textContent; },
      saveGeneratorDraft() { saved += 1; },
    };
    vm.createContext(context);
    vm.runInContext(`${extractFunctionSource(html, 'stepGeneratorPallets')}\nthis.stepGeneratorPallets = stepGeneratorPallets;`, context);
    context.stepGeneratorPallets(button, 1);
    assert.equal(quantityInput.value, '1340', entrypoint);
    assert.equal(updatedInput, quantityInput, entrypoint);
    assert.deepEqual(JSON.parse(JSON.stringify(updatedState)), {
      mode:'manual', authoritativeField:'pallets', exactOrderDraftQuantity:1340,
    }, `${entrypoint} arrow state`);

    catalogIssue = { code:'INVALID_PALLET_CATALOG' };
    updatedInput = null;
    updatedState = null;
    input.value = '2.35';
    context.stepGeneratorPallets(button, 1);
    assert.equal(input.value, '2.35', `${entrypoint} invalid catalog preserves pallets`);
    assert.equal(updatedInput, null, `${entrypoint} invalid catalog does not fabricate quantities`);
    assert.equal(updatedState, null, `${entrypoint} invalid catalog does not claim a pallet mode`);
    assert.equal(guidance.hidden, false, entrypoint);
    assert.equal(guidance.textContent, 'repair pallet catalog', entrypoint);
    assert.equal(saved, 1, entrypoint);
  }
});

test('manual fractional pallets keep every synchronized value at consistent precision', () => {
  for (const [entrypoint, html] of [['public', indexHtml], ['Boss', bossHtml]]) {
    const context = {};
    vm.createContext(context);
    vm.runInContext(`${extractFunctionSource(html, 'recalcValues')}\nthis.recalcValues = recalcValues;`, context);
    vm.runInContext(`${extractFunctionSource(html, 'formatDraftNumber')}\nthis.formatDraftNumber = formatDraftNumber;`, context);
    const values = context.recalcValues('pallets', {
      quantity:0, units:0, cartons:0, pallets:2.35,
      perPack:3, perBox:0, perCarton:8, perPallet:42,
    });
    assert.deepEqual(structuredClone(values), { quantity:789.6, units:263.2, cartons:98.7, pallets:2.35 }, entrypoint);
    assert.deepEqual(Object.values(values).map(context.formatDraftNumber), ['789.6', '263.2', '98.7', '2.35'], entrypoint);
  }
});

test('fractional totals sum canonical pallet precision before formatting once', () => {
  for (const [entrypoint, html] of [['public', indexHtml], ['Boss', bossHtml]]) {
    const outputs = Object.fromEntries(['totalQuantity','totalCartons','totalPallets','boxCounts'].map(id => [id, { textContent:'', innerHTML:'' }]));
    const rows = [1, 2].map(() => ({ querySelector(selector) { return selector === '.box-size-cell' ? { textContent:'60 cm' } : null; } }));
    let containerPallets = null;
    const context = {
      document: {
        querySelectorAll: selector => selector === '#productTable tbody tr' ? rows : [],
        getElementById: id => outputs[id],
      },
      getRowExactMetrics: () => ({ quantity:80, cartons:4, pallets:80 / 300 }),
      formatDraftNumber: value => { const rounded = Math.round((Number(value) || 0) * 100) / 100; return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/0+$/, '').replace(/\.$/, ''); },
      formatPalletValue: value => { const rounded = Math.round((Number(value) || 0) * 100) / 100; return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(2).replace(/0+$/, '').replace(/\.$/, ''); },
      escapeHtml: value => value,
      updateContainerInfo(value) { containerPallets = value; },
      updateWorkflowUi() {},
    };
    vm.createContext(context);
    vm.runInContext(`${extractFunctionSource(html, 'updateTotals')}\nthis.updateTotals = updateTotals;`, context);
    context.updateTotals();
    assert.equal(outputs.totalPallets.textContent, '0.53', entrypoint);
    assert.match(outputs.boxCounts.innerHTML, />0\.53</, entrypoint);
    assert.ok(Math.abs(containerPallets - 160 / 300) < 1e-12, entrypoint);
  }
});

test('main and generator coverage surfaces preserve values and assessment while delegating rendering', () => {
  for (const [entrypoint, html] of [['public', indexHtml], ['Boss', bossHtml]]) {
    const calls = [];
    const context = {
      window:{ SupplyCoverageIndicator:{ renderCoverageMeter(options) { calls.push(options); return `<meter>${options.coverageDays ?? 'none'}:${options.assessment}</meter>`; } } },
      fmtDays: value => `${value} 天`,
      escapeHtml: value => value,
    };
    vm.createContext(context);
    vm.runInContext(`${extractFunctionSource(html, 'renderCoverageMeterHtml')}\n${extractFunctionSource(html, 'renderCoverageDaysCell')}\nthis.renderCoverageDaysCell = renderCoverageDaysCell;`, context);
    const healthyCell = context.renderCoverageDaysCell(365);
    const unavailableCell = context.renderCoverageDaysCell(null);
    assert.match(healthyCell, /class="coverageHealthCell"/);
    assert.match(healthyCell, /<meter>365:ready<\/meter>/);
    assert.match(unavailableCell, /<meter>none:unavailable<\/meter>/);
    assert.deepEqual(calls.map(call => ({ ...call })), [
      { coverageDays:365, assessment:'ready' },
      { coverageDays:null, assessment:'unavailable' },
    ], entrypoint);
  }
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
