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

function createLeadTimeHarness(jamItems, html = indexHtml) {
  const context = {
    console,
    generatorSpeed: 10,
    mainRowsAll: [],
    daysThresholdEl: { value: '180' },
    leadTimeDaysEl: { value: '90' },
    fbaTransferDaysEl: { value: '21' },
    ordersEl: { value: 'ready' },
    metaIsReady: () => true,
    addDays(date, days) {
      return new Date(date.getTime() + days * 86400000);
    },
    parseYmdDate(value) {
      const text = String(value ?? '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
      const parsed = new Date(`${text}T00:00:00`);
      return Number.isNaN(parsed.getTime()) ? null : parsed;
    },
    physicalToAmazonUnits(_sku, quantity) {
      return Number(quantity || 0);
    },
    getJamBreakdownForSku() {
      return jamItems;
    },
    getOrderIncrementInAmazonUnits() {
      return 28;
    },
    getCanonicalSku(value) {
      return value;
    },
    getSpeedForProduct() {
      return context.generatorSpeed;
    },
    getAvailForProduct() {
      return 0;
    },
    escapeHtml(value) {
      return String(value);
    },
    fmtQty(value) {
      return String(Number(value));
    },
    formatDateYMD(value) {
      if (!(value instanceof Date) || Number.isNaN(value.getTime())) return 'N/A';
      return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
    },
    roundToExecutableOrderQty(_sku, quantity) {
      return Math.ceil(Math.max(0, quantity) / 28) * 28;
    },
  };

  vm.createContext(context);
  for (const name of [
    'getLeadTimeDays',
    'getFbaTransferDays',
    'consumeStockForDays',
    'projectStockAcrossEvents',
    'getRequiredQtyAcrossEvents',
    'getFirstStockoutDateAcrossEvents',
    'getJamOrderState',
    'getJamSupplyDecision',
    'getJamSupplyDecisionLabel',
    'getLeadTimePlan',
    'formatPostArrivalDays',
    'renderGeneratorArrivalCoverage',
  ]) {
    vm.runInContext(`${extractFunctionSource(html, name)}\nthis.${name} = ${name};`, context);
  }
  return context;
}

test('public and Boss planning functions stay in sync', () => {
  for (const name of [
    'getJamOrderState',
    'getJamOrderStateLabel',
    'getJamSupplyDecision',
    'getJamSupplyDecisionLabel',
    'projectStockAcrossEvents',
    'getLeadTimePlan',
    'renderIncludedLeadTimeSupply',
    'renderLeadTimeSupplyWarnings',
    'formatPostArrivalDays',
    'renderGeneratorArrivalCoverage',
    'exportReorderRowsFiltered',
  ]) {
    assert.equal(extractFunctionSource(indexHtml, name), extractFunctionSource(bossHtml, name), `${name} should match in both entrypoints`);
  }
});

test('decision tree uses the reorder target instead of its stockout display threshold', () => {
  for (const [entrypoint, html] of [['public', indexHtml], ['Boss', bossHtml]]) {
    assert.doesNotMatch(html, /getJamSupplyDecisionLabel\(item,\s*treeDaysThreshold\)/, `${entrypoint} should not use the decision-tree stockout threshold for supply buckets`);
  }
});

for (const [entrypoint, html] of [['public', indexHtml], ['Boss', bossHtml]]) {
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
    vm.runInContext(`${extractFunctionSource(html, 'exportReorderRowsFiltered')}\nthis.exportReorderRowsFiltered = exportReorderRowsFiltered;`, exportContext);
    const result = exportContext.exportReorderRowsFiltered();
    assert.equal(result.body.length, 1);
    assert.equal(result.headers.length, result.body[0].length);
    assert.ok(result.headers.includes('舊單假設早於新單_已納入合計_勿與其中欄重複加總'));
    assert.ok(result.headers.includes('全部待確認供給_含已納入與未納入_僅供追蹤勿橫向加總'));
  });

  test(`${entrypoint}: an existing placed order without ETA is assumed to precede a new order`, () => {
    const harness = createLeadTimeHarness([
      {
        orderName: 'JAM-101',
        qty: 1176,
        loadingDate: '2026-08-27',
        arrivalDate: 'N/A',
        isReceived: false,
      },
      {
        orderName: 'JAM-108',
        qty: 1848,
        loadingDate: 'N/A',
        arrivalDate: 'N/A',
        isReceived: false,
      },
    ], html);

    const plan = harness.getLeadTimePlan({
      sku: 'GCTL03',
      speed: 8.83,
      usAmz: 369,
      usAmzInbound: 0,
      usJsp: 0,
      order: 3024,
    }, 180);

    assert.equal(plan.assumedBeforeNew, 3024);
    assert.equal(plan.plannedNotPlaced, 0);
    assert.equal(plan.unknownStatusInbound, 1848);
    assert.ok(Math.abs(plan.projectedStock - 2412.87) < 0.001);
    assert.equal(plan.suggestedQty, 0);
    assert.ok(Math.abs(plan.postArrivalDays - 273.2582) < 0.001);
    assert.ok(plan.shortageDays > 69 && plan.shortageDays < 70);
    assert.match(harness.getJamSupplyDecisionLabel({ loadingDate: 'N/A', arrivalDate: 'N/A' }), /依舊單假設納入/);

    harness.mainRowsAll.push({ sku: 'GCTL03', speed: 8.83, usAmz: 369, usAmzInbound: 0, usJsp: 0, order: 3024 });
    harness.generatorSpeed = 8.83;
    assert.match(harness.renderGeneratorArrivalCoverage({ productCode: 'GCTL03' }, 1596, 0), /高於最新建議 0/);
  });

  test(`${entrypoint}: not-placed and STOP supply stay out of the recommendation`, () => {
    const harness = createLeadTimeHarness([
      {
        orderName: 'FY-2612',
        qty: 1512,
        loadingDate: '還沒下單',
        arrivalDate: 'N/A',
        isReceived: false,
      },
      {
        orderName: 'HS-2601',
        qty: 1512,
        loadingDate: 'STOP',
        arrivalDate: 'N/A',
        isReceived: false,
      },
    ], html);

    const plan = harness.getLeadTimePlan({
      sku: 'GCTL03',
      speed: 8.83,
      usAmz: 369,
      usAmzInbound: 0,
      usJsp: 0,
      order: 3024,
    }, 180);

    assert.equal(plan.assumedBeforeNew, 0);
    assert.equal(plan.plannedNotPlaced, 1512);
    assert.equal(plan.stoppedInbound, 1512);
    assert.equal(plan.projectedStock, 0);
    assert.equal(plan.suggestedQty, 1596);
    assert.ok(Math.abs(plan.postArrivalDays - 180.7475) < 0.001);
    assert.match(harness.getJamSupplyDecisionLabel({ loadingDate: '還沒下單', arrivalDate: 'N/A' }), /未納入/);
    assert.match(harness.getJamSupplyDecisionLabel({ loadingDate: 'STOP', arrivalDate: 'N/A' }), /未納入/);
  });

  test(`${entrypoint}: H10 inbound remains separate to avoid double-counting a JAM shipment`, () => {
    const harness = createLeadTimeHarness([], html);
    const plan = harness.getLeadTimePlan({
      sku: 'SAMPLE01',
      speed: 10,
      usAmz: 0,
      usAmzInbound: 3000,
      usJsp: 0,
      order: 0,
    }, 180);

    assert.equal(plan.amzInboundNoEta, 3000);
    assert.equal(plan.assumedBeforeNew, 0);
    assert.equal(plan.projectedStock, 0);
    assert.equal(plan.suggestedQty, 1820);
  });

  test(`${entrypoint}: an overdue ETA is included in assumed supply but remains a risk`, () => {
    const harness = createLeadTimeHarness([
      {
        orderName: 'JAM-101',
        qty: 3024,
        loadingDate: '2026-08-01',
        arrivalDate: '2000-01-01',
        isReceived: false,
      },
    ], html);

    const plan = harness.getLeadTimePlan({
      sku: 'GCTL03',
      speed: 8.83,
      usAmz: 369,
      usAmzInbound: 0,
      usJsp: 0,
      order: 3024,
    }, 180);

    assert.equal(plan.assumedBeforeNew, 3024);
    assert.equal(plan.overdueInbound, 3024);
    assert.ok(plan.shortageDays > 69 && plan.shortageDays < 70);
    assert.match(harness.getJamSupplyDecisionLabel({ loadingDate: '2026-08-01', arrivalDate: '2000-01-01' }), /ETA 已逾期.*依舊單假設納入/);
  });

  test(`${entrypoint}: a port ETA from yesterday is overdue even during the FBA transfer window`, () => {
    const yesterday = new Date();
    yesterday.setHours(0, 0, 0, 0);
    yesterday.setDate(yesterday.getDate() - 1);
    const ymd = `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, '0')}-${String(yesterday.getDate()).padStart(2, '0')}`;
    const harness = createLeadTimeHarness([
      { orderName: 'JAM-YESTERDAY', qty: 1000, loadingDate: '2026-08-01', arrivalDate: ymd, isReceived: false },
    ], html);
    const plan = harness.getLeadTimePlan({ sku: 'OVERDUE01', speed: 10, usAmz: 0, usAmzInbound: 0, usJsp: 0, order: 1000 }, 180);

    assert.equal(plan.overdueInbound, 1000);
    assert.equal(plan.assumedBeforeNew, 1000);
    assert.equal(plan.inboundBefore, 0);
  });

  test(`${entrypoint}: a port ETA of today remains a confirmed transfer event`, () => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    const harness = createLeadTimeHarness([
      { orderName: 'JAM-TODAY', qty: 1000, loadingDate: '2026-08-01', arrivalDate: ymd, isReceived: false },
    ], html);
    const plan = harness.getLeadTimePlan({ sku: 'TODAY01', speed: 10, usAmz: 0, usAmzInbound: 0, usJsp: 0, order: 1000 }, 180);

    assert.equal(plan.overdueInbound, 0);
    assert.equal(plan.assumedBeforeNew, 0);
    assert.equal(plan.inboundBefore, 1000);
    assert.equal(plan.projectedStock, 100);
  });

  test(`${entrypoint}: confirmed dated supply keeps its chronological remaining stock`, () => {
    const portDate = new Date();
    portDate.setHours(0, 0, 0, 0);
    portDate.setDate(portDate.getDate() + 50);
    const ymd = `${portDate.getFullYear()}-${String(portDate.getMonth() + 1).padStart(2, '0')}-${String(portDate.getDate()).padStart(2, '0')}`;
    const harness = createLeadTimeHarness([
      { orderName: 'JAM-DATED', qty: 1000, loadingDate: '2026-08-27', arrivalDate: ymd, isReceived: false },
    ], html);
    const plan = harness.getLeadTimePlan({ sku: 'DATED01', speed: 10, usAmz: 0, usAmzInbound: 0, usJsp: 0, order: 1000 }, 180);

    assert.equal(plan.assumedBeforeNew, 0);
    assert.equal(plan.inboundBefore, 1000);
    assert.equal(plan.projectedStock, 600);
    assert.equal(plan.rawSuggestedQty, 1200);
    assert.equal(plan.suggestedQty, 1204);
  });

  test(`${entrypoint}: the real TTS05 mix includes placed supply and excludes planned supply`, () => {
    const harness = createLeadTimeHarness([
      { orderName: 'FY-2608', qty: 84000, loadingDate: '2026-08-10', arrivalDate: 'N/A', isReceived: false },
      { orderName: 'FY-2611', qty: 84000, loadingDate: '下單了', arrivalDate: 'N/A', isReceived: false },
      { orderName: 'FY-2614', qty: 42000, loadingDate: '還沒下單', arrivalDate: 'N/A', isReceived: false },
    ], html);

    const plan = harness.getLeadTimePlan({
      sku: 'TTS05AM-1',
      speed: 495.18,
      usAmz: 19628,
      usAmzInbound: 3900,
      usJsp: 0,
      order: 210000,
    }, 180);

    assert.equal(plan.assumedBeforeNew, 168000);
    assert.equal(plan.plannedNotPlaced, 42000);
    assert.equal(plan.amzInboundNoEta, 3900);
    assert.ok(Math.abs(plan.projectedStock - 132663.02) < 0.001);
    assert.equal(plan.suggestedQty, 0);
    assert.ok(Math.abs(plan.postArrivalDays - 267.9088) < 0.001);
    assert.ok(plan.shortageDays > 71 && plan.shortageDays < 72);
  });

  test(`${entrypoint}: a loading date later than the new order arrival is not assumed early`, () => {
    const lateLoading = new Date();
    lateLoading.setHours(0, 0, 0, 0);
    lateLoading.setDate(lateLoading.getDate() + 120);
    const ymd = `${lateLoading.getFullYear()}-${String(lateLoading.getMonth() + 1).padStart(2, '0')}-${String(lateLoading.getDate()).padStart(2, '0')}`;
    const harness = createLeadTimeHarness([
      { orderName: 'FY-LATE', qty: 3024, loadingDate: ymd, arrivalDate: 'N/A', isReceived: false },
    ], html);
    const plan = harness.getLeadTimePlan({ sku: 'GCTL03', speed: 8.83, usAmz: 369, usAmzInbound: 0, usJsp: 0, order: 3024 }, 180);

    assert.equal(plan.assumedBeforeNew, 0);
    assert.equal(plan.conflictingScheduleInbound, 3024);
    assert.equal(plan.suggestedQty, 1596);
    assert.match(harness.getJamSupplyDecisionLabel({ loadingDate: ymd, arrivalDate: 'N/A' }), /晚於本次新單到港.*未納入/);
  });

  test(`${entrypoint}: generator coverage includes confirmed supply scheduled inside the target window`, () => {
    const portDate = new Date();
    portDate.setHours(0, 0, 0, 0);
    portDate.setDate(portDate.getDate() + 120);
    const ymd = `${portDate.getFullYear()}-${String(portDate.getMonth() + 1).padStart(2, '0')}-${String(portDate.getDate()).padStart(2, '0')}`;
    const harness = createLeadTimeHarness([
      { orderName: 'JAM-SCHEDULED', qty: 1000, loadingDate: '2026-08-27', arrivalDate: ymd, isReceived: false },
    ], html);
    const sourceRow = { sku: 'SCHEDULED01', speed: 10, usAmz: 3000, usAmzInbound: 0, usJsp: 0, order: 1000 };
    harness.mainRowsAll.push(sourceRow);
    harness.generatorSpeed = 10;

    assert.equal(harness.formatPostArrivalDays({ productCode: 'SCHEDULED01' }, 0, 0), '289.0 天');
  });
}
