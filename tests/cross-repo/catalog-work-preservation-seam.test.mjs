import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  applyCatalogChangePlan,
  createCatalogChangePlan,
} from '../../catalog/catalog-change-plan.js';
import { compileCatalog } from '../../catalog/product-catalog.js';
import { supplyCatalogAdapter } from '../../catalog/supply-catalog-adapter.js';
import {
  applyOrderDraftCommand,
  createOrderDraft,
  getPackagingAssignmentStatus,
  loadOrderDraft,
  projectOrderWorkbook,
  resolveOrderDraftRowPackaging,
  saveOrderDraft,
} from '../../shared/order-draft-state.js';

const require = createRequire(import.meta.url);
const FBA_REPO = path.resolve(process.env.FBA_REPO || path.join(import.meta.dirname, '..', '..', '..', 'FBA'));
const FbaCatalog = require(path.join(FBA_REPO, 'product-catalog.js'));
const FbaPackaging = require(path.join(FBA_REPO, 'packaging-assignment.js'));

const OLD_VERSION = '2026-08-28.4';
const NEW_VERSION = '2026-08-29.1';
const NOW = '2026-08-29T02:03:04.000Z';
const ALIAS_SKU = '7ALSD001AB';

function packaging(version, unitsPerCarton, cartonsPerPallet = 40) {
  return {
    version,
    effectiveFrom:version.slice(0, 10),
    effectiveTo:null,
    unitsPerCarton,
    cartonsPerPallet,
    cartonDimensionsCm:[50.8, 40.64, 30.48],
    grossWeightKg:null,
    grossWeightLb:25,
    orderUnit:{ kind:'single', units:1 },
    source:{ sheet:'fixture', row:8 },
  };
}

function product(productSku, { alias = false } = {}) {
  return {
    productSku,
    productName:`Product ${productSku}`,
    origin:'VN',
    standardFactory:'VN',
    lifecycle:'active',
    approvedOrderSkus:alias ? [productSku, ALIAS_SKU] : [productSku],
    newOrderPackagingDefaultVersion:OLD_VERSION,
    packagingVersions:[packaging(OLD_VERSION, 24)],
  };
}

function beforeCatalog() {
  return {
    schemaVersion:3,
    catalogVersion:OLD_VERSION,
    products:[
      product('FLOAT01'),
      product('PIN01'),
      product('EXPORT01'),
      product('ROUTE01'),
      product('ALIAS01', { alias:true }),
    ],
    orderSkuAliases:[{
      orderSku:ALIAS_SKU,
      canonicalProductSku:'ALIAS01',
      lifecycle:'approved',
      newOrderPackagingDefaultVersion:OLD_VERSION,
      packagingVersions:[packaging(OLD_VERSION, 20, 50)],
    }],
  };
}

function candidateCatalog() {
  const catalog = structuredClone(beforeCatalog());
  catalog.catalogVersion = NEW_VERSION;
  for (const owner of catalog.products) {
    owner.packagingVersions.push(packaging(NEW_VERSION, 30));
    owner.newOrderPackagingDefaultVersion = NEW_VERSION;
  }
  const route = catalog.products.find(item => item.productSku === 'ROUTE01');
  route.standardFactory = 'TW';
  const alias = catalog.orderSkuAliases[0];
  alias.packagingVersions.push(packaging(NEW_VERSION, 25, 50));
  alias.newOrderPackagingDefaultVersion = NEW_VERSION;
  return catalog;
}

function contextFor(catalog) {
  const projection = compileCatalog(catalog, supplyCatalogAdapter);
  const products = new Map(projection.products.map(item => [item.productCode, item]));
  const packagingByOrderSku = new Map(projection.orderSkuPackaging.map(item => [item.orderSku, item]));
  const approved = new Map(projection.products.map(item => [item.productCode, [item.productCode]]));
  for (const [productSku, orderSku] of projection.equivalentSkuPairs) {
    approved.set(productSku, [...(approved.get(productSku) || [productSku]), orderSku]);
  }
  return {
    now:NOW,
    catalogVersion:projection.meta.catalogVersion,
    getCatalogVersion:() => projection.meta.catalogVersion,
    getProduct:productSku => products.get(productSku) || null,
    getApprovedOrderSkus:productSku => approved.get(productSku) || [],
    getOrderSkuPackaging:orderSku => packagingByOrderSku.get(orderSku) || null,
    getCoverageDays:(_productSku, quantity) => Number(quantity) / 10,
  };
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem:key => values.has(key) ? values.get(key) : null,
    setItem:(key, value) => values.set(key, String(value)),
    removeItem:key => values.delete(key),
  };
}

function upsert(draft, row, context) {
  const result = applyOrderDraftCommand(draft, { type:'upsert-row', row }, context);
  assert.equal(result.ok, true, `${row.productSku} must enter the Order Draft`);
  return result.draft;
}

test('the same catalog change preserves untouched, touched, pre-exported, routed, FBA legacy, Historical Imported, and alias work', async () => {
  const before = beforeCatalog();
  const beforeContext = contextFor(before);
  let activeDraft = createOrderDraft({ now:NOW });
  activeDraft = upsert(activeDraft, {
    productSku:'FLOAT01',
    quantities:{ orderDraft:300 },
    pallet:{ value:0.25, mode:'whole-pallet' },
    pinPackaging:false,
  }, beforeContext);
  activeDraft = upsert(activeDraft, {
    productSku:'PIN01',
    quantities:{ orderDraft:240 },
    pallet:{ value:0.25, mode:'manual' },
    pinPackaging:true,
  }, beforeContext);
  activeDraft = upsert(activeDraft, {
    productSku:'ROUTE01',
    quantities:{ orderDraft:240 },
    pallet:{ value:0.25, mode:'manual' },
    pinPackaging:true,
  }, beforeContext);
  activeDraft = upsert(activeDraft, {
    productSku:'ALIAS01',
    quantities:{ orderDraft:200 },
    pallet:{ value:0.2, mode:'manual' },
    pinPackaging:false,
  }, beforeContext);
  const aliasSwitch = applyOrderDraftCommand(activeDraft, {
    type:'switch-order-sku',
    productSku:'ALIAS01',
    orderSku:ALIAS_SKU,
  }, beforeContext);
  assert.equal(aliasSwitch.ok, true);
  activeDraft = aliasSwitch.draft;

  let exportDraft = createOrderDraft({ now:NOW });
  exportDraft = upsert(exportDraft, {
    productSku:'EXPORT01',
    quantities:{ orderDraft:240 },
    pallet:{ value:0.25, mode:'whole-pallet' },
    pinPackaging:false,
  }, beforeContext);
  const exportedBeforeUpdate = projectOrderWorkbook(exportDraft, beforeContext);
  assert.equal(exportedBeforeUpdate.ok, true);
  assert.equal(exportedBeforeUpdate.draft.rowsByProductSku.EXPORT01.packagingAssignment.packagingVersion, OLD_VERSION);

  const storage = memoryStorage();
  assert.equal(saveOrderDraft({ storage, draft:activeDraft, context:beforeContext }).ok, true);

  const candidate = candidateCatalog();
  const plan = await createCatalogChangePlan(before, candidate, { generatedAt:NOW, sourceFile:'fixture.xlsx' });
  const selectedEntryIds = plan.entries.filter(entry => entry.kind === 'catalog-change').map(entry => entry.id);
  const applied = await applyCatalogChangePlan(before, candidate, plan, { selectedEntryIds });
  const currentContext = contextFor(applied.catalog);

  const loaded = loadOrderDraft({ storage, context:currentContext });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.status, 'loaded-with-warnings');
  assert.equal(loaded.draft.rowsByProductSku.ROUTE01.standardFactory, 'vietnam');
  assert.equal(loaded.draft.rowsByProductSku.ROUTE01.orderGroup, 'vietnam');
  assert.equal(loaded.draft.rowsByProductSku.ROUTE01.packagingAssignment.packagingVersion, OLD_VERSION);
  assert.deepEqual(
    loaded.issues.filter(issue => issue.productSku === 'ROUTE01').map(issue => issue.code),
    ['STANDARD_FACTORY_CHANGED', 'ORDER_GROUP_DEFAULT_CHANGED'],
  );

  assert.equal(resolveOrderDraftRowPackaging(loaded.draft.rowsByProductSku.FLOAT01, currentContext).packagingVersion, NEW_VERSION);
  assert.equal(getPackagingAssignmentStatus(loaded.draft.rowsByProductSku.PIN01, currentContext).assignedVersion, OLD_VERSION);
  assert.equal(getPackagingAssignmentStatus(loaded.draft.rowsByProductSku.PIN01, currentContext).newerAvailable, true);
  assert.equal(getPackagingAssignmentStatus(loaded.draft.rowsByProductSku.ALIAS01, currentContext).assignedVersion, OLD_VERSION);
  assert.equal(getPackagingAssignmentStatus(loaded.draft.rowsByProductSku.ALIAS01, currentContext).currentVersion, NEW_VERSION);

  const reExported = projectOrderWorkbook(exportedBeforeUpdate.draft, currentContext);
  assert.equal(reExported.ok, true);
  const exportedRow = reExported.sheets.flatMap(sheet => sheet.rows).find(row => row[1] === 'EXPORT01');
  assert.equal(exportedRow[3], 24, 'a row exported before release retains its exact old carton fact');
  assert.equal(reExported.draft.rowsByProductSku.EXPORT01.packagingAssignment.packagingVersion, OLD_VERSION);

  const afterWorkbook = projectOrderWorkbook(loaded.draft, currentContext);
  assert.equal(afterWorkbook.ok, true);
  const supplyRows = Object.fromEntries(afterWorkbook.sheets.flatMap(sheet => sheet.rows.map(row => [row[1], {
    sheet:sheet.name,
    perCarton:row[3],
  }])));
  assert.deepEqual(supplyRows, {
    FLOAT01:{ sheet:'越南', perCarton:30 },
    PIN01:{ sheet:'越南', perCarton:24 },
    ROUTE01:{ sheet:'越南', perCarton:24 },
    [ALIAS_SKU]:{ sheet:'代工', perCarton:20 },
  });

  const oldSnapshot = FbaCatalog.projectCanonicalCatalog(before);
  const oldIndex = FbaPackaging.createCatalogIndex(oldSnapshot);
  const fbaStorage = memoryStorage();
  const ledger = FbaPackaging.createLedger(fbaStorage, { batchId:'catalog-work-seam', now:NOW });
  const oldWork = ledger.assignCurrent({ rowKey:'old-work', sku:'PIN01', current:oldIndex.PIN01 });
  const oldAlias = ledger.assignCurrent({ rowKey:'old-alias', sku:ALIAS_SKU, current:oldIndex[ALIAS_SKU] });
  assert.equal(oldWork.packagingVersion, OLD_VERSION);
  assert.equal(oldAlias.packagingVersion, OLD_VERSION);

  const newSnapshot = FbaCatalog.projectCanonicalCatalog(applied.catalog);
  const newIndex = FbaPackaging.createCatalogIndex(newSnapshot);
  const reloadedLedger = FbaPackaging.createLedger(fbaStorage, { batchId:'catalog-work-seam', now:NOW });
  const knownOld = reloadedLedger.migrateLegacy({
    rowKey:'known-old',
    sku:'PIN01',
    knownFacts:{ unitsPerCarton:24 },
    candidates:newIndex.PIN01.candidates,
    fallbackFacts:newIndex.PIN01.facts,
    catalogVersion:newSnapshot.catalogVersion,
  });
  const historical = reloadedLedger.migrateLegacy({
    rowKey:'historical-imported',
    sku:'PIN01',
    knownFacts:{ unitsPerCarton:27 },
    candidates:newIndex.PIN01.candidates,
    fallbackFacts:newIndex.PIN01.facts,
    catalogVersion:newSnapshot.catalogVersion,
  });
  const newWork = reloadedLedger.assignCurrent({ rowKey:'new-work', sku:'PIN01', current:newIndex.PIN01 });

  assert.deepEqual({
    old:[reloadedLedger.get('old-work').packagingVersion, reloadedLedger.get('old-work').facts.unitsPerCarton],
    oldAlias:[reloadedLedger.get('old-alias').packagingVersion, reloadedLedger.get('old-alias').facts.unitsPerCarton],
    knownOld:[knownOld.kind, knownOld.packagingVersion, knownOld.migrationMethod],
    historical:[historical.kind, historical.packagingVersion, historical.facts.unitsPerCarton, historical.reviewRequired],
    newWork:[newWork.packagingVersion, newWork.facts.unitsPerCarton],
  }, {
    old:[OLD_VERSION, 24],
    oldAlias:[OLD_VERSION, 20],
    knownOld:['catalog-version', OLD_VERSION, 'known-facts-exact-match'],
    historical:['historical-imported', null, 27, true],
    newWork:[NEW_VERSION, 30],
  });

  const coldReload = FbaPackaging.createLedger(fbaStorage, { batchId:'catalog-work-seam', now:NOW });
  assert.equal(coldReload.get('historical-imported').kind, 'historical-imported');
  assert.equal(coldReload.get('historical-imported').reviewRequired, true);
});
