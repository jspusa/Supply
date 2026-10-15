import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { buildPlanningVelocities } from '../shared/planning-velocity.js';
import { createOrderDraft, applyOrderDraftCommand } from '../shared/order-draft-state.js';

const root = new URL('../', import.meta.url);
const source = name => readFileSync(new URL(name, root), 'utf8');
const requested = [
  ['7GTSD013AB','GTS01'], ['7GTSD017AB','GTSL01'],
  ['7GTBD013AB','GTB01'], ['7GTBD017AB','GTBL01'],
  ['7GTBD037AB','GTBL03'], ['7GTBD053AB','GTB05'],
  ['7GTBD057AB','GTBL05'], ['7GTRD013AB','GTR01'],
  ['7GTRD017AB','GTRL01'], ['7GTRD037AB','GTRL03'],
  ['7GTPD013AB','GTP01'], ['7GTPD017AB','GTPL01'],
  ['7GTPD037AB','GTPL03'], ['7GTPD053AB','GTP05'],
  ['7GTPD057AB','GTPL05'], ['7ATSD010AB','TTS05AM-1'],
  ['7ATSD017AB','TTSL05'], ['7ATSD019AB','TTS05AM'],
  ['7ATSD011AB','ATS01'], ['7ATRD013AB','ATR01'],
  ['7VTSD513AB','VTS01-5'], ['7VTSD913AB','VTS01-10'],
  ['7VTBD410AB','VTB01-4'], ['7VTBD015AB','VTB01-10'],
  ['7VTRD015AB','VTR01-10'], ['7VTRD215AB','VTR01-20'],
];

function loadRuntime() {
  const context = vm.createContext({ Map, Set });
  context.window = context;
  for (const file of ['product-data.js', 'shared/sku-correspondence.js', 'shared/discontinued-products.js']) {
    vm.runInContext(source(file), context, { filename:file });
  }
  return context;
}

function extractFunction(html, name) {
  const start = html.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  const bodyMarker = /\)\s*\{/.exec(html.slice(start));
  const bodyStart = start + bodyMarker.index + bodyMarker[0].lastIndexOf('{');
  let depth = 0;
  for (let i = bodyStart; i < html.length; i += 1) {
    if (html[i] === '{') depth += 1;
    if (html[i] === '}') {
      depth -= 1;
      if (!depth) return html.slice(start, i + 1);
    }
  }
  throw new Error(`Cannot extract ${name}`);
}

function loadPageFunctions(page) {
  const context = loadRuntime();
  const html = source(page);
  const functions = [
    'normalizeSkuKey', 'normalizeNumber', 'fmtDateText', 'getRowOrderQty',
    'getProductBySku', 'getPhysicalUnitsPerAmazonUnit', 'physicalToAmazonUnits',
    'normalizeJamOrderName', 'excelDateToText', 'isReceivedMark', 'findLastMatchingColumn',
    'summarizeJamBreakdown', 'allocateJamBreakdownByRemainingTotal', 'parseUsSummaryRows',
    'parseSkuNumberMap', 'aggregateSkuNumberMapByEquivalent', 'convertPhysicalMapToAmazonUnits',
    'isNoOrderSku', 'getApprovedOrderSkusForProduct', 'getOrderSkuPackagingForDraft', 'mergeSkuNumberMaps',
  ];
  context.productMap = new Map(context.allProductsData.map(product => [product.productCode, product]));
  context.ordersEl = { value:'' };
  context.mainRowsAll = [];
  for (const name of functions) vm.runInContext(extractFunction(html, name), context);
  const start = html.indexOf('const equivalentSkuPairs');
  const end = html.indexOf('const hotSkuList', start);
  assert.ok(start >= 0 && end > start);
  vm.runInContext(html.slice(start, end), context);
  return { context, html };
}

test('all 26 explicitly confirmed correspondences are exact, deduplicated and preserve older catalog pairs', () => {
  const context = loadRuntime();
  const api = context.SupplySkuCorrespondence;
  assert.deepEqual(Array.from(api.confirmedPairs, ([product, order]) => [order, product]), requested);
  const registry = api.createRegistry(context.SUPPLY_EQUIVALENT_SKU_PAIRS);
  assert.equal(registry.pairs.length, 27, 'the existing VTS01-1 pair remains available');
  for (const [order, product] of requested) {
    assert.equal(registry.canonicalize(` ${order.toLowerCase()} `), product);
    assert.equal(registry.canonicalize(product), product);
  }
  assert.equal(registry.canonicalize('7VTSD013AB'), 'VTS01-1');
  assert.equal(registry.canonicalize('GTP01J'), 'GTP01J', 'similar suffixes are not aliases');
  assert.equal(registry.canonicalize('7UNKNOWN'), '7UNKNOWN');
  assert.equal(registry.getGroup('7UNKNOWN'), null);
});

test('multiple aliases retain a complete group and conflicting ownership is not silently accepted', () => {
  const api = loadRuntime().SupplySkuCorrespondence;
  const registry = api.createRegistry([['GTP01','7GTPD013AB'], ['GTP01','7EXTRA']]);
  assert.deepEqual(Array.from(registry.getGroup('7GTPD013AB')), ['GTP01','7GTPD013AB','7EXTRA']);
  assert.throws(() => api.createRegistry([['GTP01','7GTPD013AB'], ['OTHER','7GTPD013AB']]), /Conflicting Product SKU owners/);
  const updated = api.createRegistry([['OTHER','7GTPD013AB']]);
  assert.equal(updated.canonicalize('7GTPD013AB'), 'OTHER', 'released ownership supersedes the dated planning supplement');
});

test('planning identity overlay leaves all catalog product and alias packaging facts untouched', () => {
  const context = loadRuntime();
  const before = JSON.stringify([context.allProductsData, context.SUPPLY_ORDER_SKU_PACKAGING, context.SUPPLY_EQUIVALENT_SKU_PAIRS]);
  context.SupplySkuCorrespondence.createRegistry(context.SUPPLY_EQUIVALENT_SKU_PAIRS);
  assert.equal(JSON.stringify([context.allProductsData, context.SUPPLY_ORDER_SKU_PACKAGING, context.SUPPLY_EQUIVALENT_SKU_PAIRS]), before);
});

test('demand and inventory evidence merge under GTP01 while preserving the original source SKU', () => {
  const context = loadRuntime();
  const registry = context.SupplySkuCorrespondence.createRegistry(context.SUPPLY_EQUIVALENT_SKU_PAIRS);
  const result = buildPlanningVelocities({
    asOfDate:'2026-10-15', sourceObservedOn:'2026-10-15',
    rawH10Text:'B000000034 GTP01 5\nB000000034 7GTPD013AB 7',
    inventoryRows:[['SKU','Days of Supply','Sellable Inventory','Inbound'], ['7GTPD013AB',10,80,0]],
    productSkuAliases:registry.aliasToCanonical,
    hotProductSkus:[], historySamples:[],
  });
  assert.equal(result.assessments.length, 1);
  assert.equal(result.assessments[0].productSku, 'GTP01');
  assert.equal(result.assessments[0].planningVelocity, 8);
  assert.deepEqual(result.h10Observations.map(row => row.sourceSku), ['GTP01','7GTPD013AB']);
  assert.equal(result.inventorySummary.evidence[0].sourceSku, '7GTPD013AB');
  assert.equal(result.inventorySummary.evidence[0].productSku, 'GTP01');
});

for (const page of ['index.html', 'Boss/index.html']) {
  test(`${page}: JAM parsing retains alias source and combines open orders under GTP01`, () => {
    const { context } = loadPageFunctions(page);
    const result = context.parseUsSummaryRows([
      ['對應品號','品號 (productCode)','JAM 100','FY 200','尚未到美國倉庫(包含預計補貨品)'],
      ['','','下單了','下單了',''],
      ['','','2026-11-01','2026-11-15',''],
      ['','','','',''],
      ['', '7GTPD013AB', 120, 180, 300],
      ['', 'GTP01', 60, 0, 60],
    ]);
    context.ordersEl.value = result.orderText;
    const quantityMap = context.aggregateSkuNumberMapByEquivalent(context.parseSkuNumberMap(result.orderText));
    assert.deepEqual(Array.from(quantityMap), [['GTP01',360]]);
    assert.equal(result.breakdownMap.size, 1);
    const rows = result.breakdownMap.get('GTP01');
    assert.deepEqual(Array.from(rows, row => row.sourceSku), ['7GTPD013AB','7GTPD013AB','GTP01']);
    assert.deepEqual(Array.from(rows, row => row.orderSku), ['7GTPD013AB','7GTPD013AB','GTP01']);
    assert.equal(rows.reduce((sum, row) => sum + row.qty, 0), 360);
    context.mainRowsAll = [{ sku:'GTP01', order:360, orderRaw:360 }];
    assert.equal(context.isNoOrderSku('GTP01'), false);
    assert.equal(context.isNoOrderSku('7GTPD013AB'), false, 'querying the Order SKU must find its Product SKU order');
    assert.equal(context.isNoOrderSku('GTP05'), true);
  });

  test(`${page}: all five newly confirmed identities merge quantities without granting missing packaging`, () => {
    const { context } = loadPageFunctions(page);
    const newlyMapped = requested.filter(([order]) => !context.SUPPLY_EQUIVALENT_SKU_PAIRS.some(pair => pair[1] === order));
    assert.equal(newlyMapped.length, 5);
    for (const [order, product] of newlyMapped) {
      const combined = context.aggregateSkuNumberMapByEquivalent(new Map([[order,100],[product,25]]));
      assert.deepEqual(Array.from(combined), [[product,125]]);
      assert.equal(context.getOrderSkuPackagingForDraft(order), null);
      assert.equal(context.getApprovedOrderSkusForProduct(product).includes(order), false);
      context.ordersEl.value = `${order}\t125`;
      context.mainRowsAll = [{ sku:product, order:null, orderRaw:125 }];
      assert.equal(context.isNoOrderSku(order), false, 'known physical open order is not mistaken for no order');
    }
  });

  test(`${page}: approved GTP alias order keeps its released packaging and subcontract group`, () => {
    const { context } = loadPageFunctions(page);
    const draftContext = {
      getProduct:sku => context.productMap.get(sku),
      getApprovedOrderSkus:context.getApprovedOrderSkusForProduct,
      getOrderSkuPackaging:context.getOrderSkuPackagingForDraft,
      catalogVersion:context.SUPPLY_PRODUCT_CATALOG_META.catalogVersion,
      now:() => new Date('2026-10-15T00:00:00Z'),
    };
    const result = applyOrderDraftCommand(createOrderDraft(draftContext), {
      type:'upsert-row', row:{ productSku:'GTP01', orderSku:'7GTPD013AB', quantities:{ packages:180 }, pinPackaging:true },
    }, draftContext);
    assert.equal(result.ok, true, JSON.stringify(result.error));
    const row = result.draft.rowsByProductSku.GTP01;
    assert.equal(row.orderSku, '7GTPD013AB');
    assert.equal(row.orderGroup, 'subcontract');
    const packaging = context.getOrderSkuPackagingForDraft('7GTPD013AB');
    assert.equal(row.packagingAssignment.packagingVersion, packaging.packagingVersion);
    assert.equal(row.packagingAssignment.perCarton, packaging.perCarton);
  });

  test(`${page}: missing owner specifications preserve unknown units and prevent invented recommendations`, () => {
    const { context, html } = loadPageFunctions(page);
    assert.equal(context.physicalToAmazonUnits('7GTPD013AB', 180), 180);
    assert.equal(context.physicalToAmazonUnits('7VTBD410AB', 180), 45, 'known four-pack owner retains conversion');
    assert.equal(context.physicalToAmazonUnits('7VTSD513AB', 180), null);
    const converted = context.convertPhysicalMapToAmazonUnits(new Map([['7VTSD513AB',100],['VTS01-5',25]]));
    assert.deepEqual(Array.from(converted), [['VTS01-5',null]]);
    assert.equal(context.mergeSkuNumberMaps(new Map([['VTS01-5',10]]), converted).get('VTS01-5'), null);
    Object.assign(context, {
      SupplyPlanningLegacy:{ planLegacyReplenishment:() => ({ canRecommend:true, suggestedQty:999, bookCoverageDays:180 }) },
      getJamBreakdownForSku:() => [{ orderName:'JAM 100', qty:125, sourceSku:'7VTSD513AB' }],
      getPlanningVelocityForProduct:() => 10,
      getPlanningAsOfDate:() => '2026-10-15',
      getPlanningPolicy:() => ({}),
      getProductSpecByCode:sku => context.productMap.get(sku),
      getUnitsPerPallet:() => null,
      metaIsReady:() => true,
    });
    vm.runInContext(extractFunction(html, 'getLeadTimePlan'), context);
    const plan = context.getLeadTimePlan({ sku:'VTS01-5', order:null, orderRaw:125, usAmz:10, usJsp:null }, 180);
    assert.equal(plan.canRecommend, false);
    assert.equal(plan.suggestedQty, 0);
    assert.equal(plan.bookCoverageDays, null);
    assert.equal(plan.status, 'missing-product-spec');
    assert.ok(plan.missingSources.includes('產品單位換算規格'));
  });

  test(`${page}: alias decision-tree lookup retains known raw orders when AMZ conversion is unavailable`, () => {
    const { context, html } = loadPageFunctions(page);
    const row = { sku:'VTS01-5', planningVelocity:10, amz:0, jsp:null, order:null, orderRaw:125 };
    const jam = [{ sku:'VTS01-5', sourceSku:'7VTSD513AB', orderSku:'7VTSD513AB', orderName:'JAM 100', qty:125 }];
    context.mainRowsAll = [row];
    context.ordersEl.value = '7VTSD513AB\t125';
    Object.assign(context, {
      getDecisionRows:() => [row],
      getJamBreakdownForSku:() => jam,
      renderTreeNode:(_kind, title, desc) => `${title} ${desc}`,
    });
    for (const name of ['safeNumber', 'escapeHtml', 'fmtQty', 'findDecisionRowBySku', 'getSkuDecisionTreeAnalysis']) {
      vm.runInContext(extractFunction(html, name), context);
    }
    assert.strictEqual(context.findDecisionRowBySku('7VTSD513AB'), row);
    const result = context.getSkuDecisionTreeAnalysis('7VTSD513AB', 14);
    assert.equal(result.hasAlert, false);
    assert.match(result.html, /已辨識未到貨訂單/);
    assert.match(result.html, /125 實體包/);
    assert.match(result.html, /產品單位換算待確認/);
    assert.doesNotMatch(result.html, /沒有未到貨訂單/);
  });
}
