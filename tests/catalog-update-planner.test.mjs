import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  createCatalogChangePlan,
  publicCatalogSha256,
  publicCatalogSnapshot,
  stableJson,
} from '../catalog/catalog-change-plan.js';
import {
  applyExplicitRawClears,
  overlayRawProductCatalog,
} from '../catalog/raw-product-catalog-overlay.js';
import {
  assertReviewedPlan,
  explicitClearsFromReviewedPlan,
} from '../scripts/release-product-catalog.mjs';
import { planRawProductCatalogUpdate } from '../shared/catalog-update-planner.mjs';

await import(`../shared/shared-product-catalog.js?catalog-update-planner=${Date.now()}`);
const rawApi = globalThis.JSPSharedProductCatalog;
const root = path.resolve(import.meta.dirname, '..');

function packaging(version, overrides = {}) {
  return {
    version,
    effectiveFrom:'2026-08-28',
    effectiveTo:null,
    unitsPerCarton:24,
    cartonsPerPallet:42,
    cartonDimensionsCm:[50, 40, 30],
    grossWeightKg:null,
    grossWeightLb:29,
    orderUnit:{ kind:'single', units:1 },
    source:{ sheet:'private canonical source', row:99 },
    ...overrides,
  };
}

function fullBaseline() {
  return {
    schemaVersion:3,
    catalogVersion:'2026-08-28.4',
    products:[{
      productSku:'ABC01',
      productName:'Product',
      origin:'VN',
      standardFactory:'VN',
      lifecycle:'active',
      approvedOrderSkus:['ABC01'],
      newOrderPackagingDefaultVersion:'2026-08-28.4',
      packagingVersions:[packaging('2026-08-28.4')],
    }],
    orderSkuAliases:[],
  };
}

function fullBaselineWithAlias() {
  const baseline = fullBaseline();
  baseline.products[0].approvedOrderSkus.push('7ABC0101');
  baseline.orderSkuAliases.push({
    orderSku:'7ABC0101',
    canonicalProductSku:'ABC01',
    lifecycle:'approved',
    newOrderPackagingDefaultVersion:'2026-08-28.4',
    packagingVersions:[packaging('2026-08-28.4')],
  });
  return baseline;
}

function rawWorkbook({ cartons = '' } = {}) {
  const top = Array(23).fill('');
  const headers = Array(23).fill('');
  const row = Array(23).fill('');
  top[2] = '產地';
  top[4] = '包數/箱';
  top[17] = '紙箱規格';
  top[18] = '箱/棧板';
  top[21] = '每箱產品的毛重';
  headers[1] = 'SKU';
  headers[22] = 'GW (lb)';
  row[1] = 'ABC01';
  row[2] = '越南';
  row[4] = 30;
  row[17] = '50*40*30';
  row[18] = cartons;
  row[22] = 29;
  return { SheetNames:['AMZ 所有SKU'], Sheets:{ 'AMZ 所有SKU':{ rows:[top, headers, row] } } };
}

function rawAliasWorkbook() {
  const top = Array(23).fill('');
  const headers = Array(23).fill('');
  const row = Array(23).fill('');
  top[2] = '產地';
  top[4] = '包數/箱';
  top[17] = '紙箱規格';
  top[18] = '箱/棧板';
  top[21] = '每箱產品的毛重';
  headers[1] = 'SKU';
  headers[22] = 'GW (lb)';
  row[1] = '7ABC0101';
  return { SheetNames:['AMZ 所有SKU'], Sheets:{ 'AMZ 所有SKU':{ rows:[top, headers, row] } } };
}

function fakeXlsx(workbook) {
  return {
    read:() => workbook,
    utils:{ sheet_to_json:sheet => sheet.rows },
  };
}

const generatedAt = '2026-08-29T01:02:03.000Z';

test('public browser baseline strips canonical source while keeping the exact public catalog hash', async () => {
  const full = fullBaseline();
  const sanitized = publicCatalogSnapshot(full);
  assert.doesNotMatch(JSON.stringify(sanitized), /private canonical source|"source"/);
  assert.equal(await publicCatalogSha256(full), await publicCatalogSha256(sanitized));

  const artifact = fs.readFileSync(path.join(root, 'shared', 'catalog-update-baseline.js'), 'utf8');
  assert.doesNotMatch(artifact, /"source"\s*:|\/Users\/|private canonical source/);
});

test('ordinary raw blanks preserve known facts while an explicit clear becomes review-only', async () => {
  const baseline = publicCatalogSnapshot(fullBaseline());
  const options = {
    workbookData:new Uint8Array([1]).buffer,
    sourceFile:'/Users/example/private/raw-product.xlsx',
    baselineCatalog:baseline,
    xlsxRef:fakeXlsx(rawWorkbook()),
    rawCatalogApi:rawApi,
    generatedAt,
  };
  const preserved = await planRawProductCatalogUpdate(options);
  const preservedProduct = preserved.candidateCatalog.products[0];
  const preservedPackaging = preservedProduct.packagingVersions.find(item => item.version === preservedProduct.newOrderPackagingDefaultVersion);
  assert.equal(preservedPackaging.cartonsPerPallet, 42, 'ordinary blank must preserve the known value');
  assert.ok(preserved.clearCandidates.find(item => item.sku === 'ABC01')?.fields.some(item => item.field === 'cartonsPerPallet'));
  assert.doesNotMatch(JSON.stringify(preserved.plan), /\/Users\/jasper/);

  const cleared = await planRawProductCatalogUpdate({
    ...options,
    explicitClears:[{ sku:'ABC01', fields:['cartonsPerPallet'] }],
  });
  const clearedEntry = cleared.plan.entries.find(entry => entry.sku === 'ABC01');
  const clearedField = clearedEntry.fields.find(field => field.field === 'cartonsPerPallet');
  assert.deepEqual(clearedField, { field:'cartonsPerPallet', before:42, after:null });
  assert.equal(clearedEntry.risk, 'review');
  assert.equal(clearedEntry.selected, false);
  assert.equal(clearedEntry.selectable, true);

  const localClearIntent = explicitClearsFromReviewedPlan(cleared.plan);
  assert.deepEqual(localClearIntent, [{ sku:'ABC01', fields:['cartonsPerPallet'] }]);
  const rawPayload = rawApi.createPayload(rawWorkbook(), options.xlsxRef, {
    sourceFile:'raw-product.xlsx', updatedAt:generatedAt, baseCatalogVersion:baseline.catalogVersion,
  });
  const localPayload = applyExplicitRawClears(rawPayload, localClearIntent);
  const localCandidate = overlayRawProductCatalog(fullBaseline(), localPayload, { catalogVersion:'2026-08-29' }).catalog;
  const localPlan = await createCatalogChangePlan(fullBaseline(), localCandidate, {
    sourceFile:'raw-product.xlsx', generatedAt,
    conflicts:localPayload.conflicts, duplicateConflicts:localPayload.stats.duplicateConflicts,
    rawSources:localPayload.records.map(record => ({ sku:record.sku, sourceSheet:record.sourceSheet, sourceRow:record.sourceRow })),
  });
  await assert.doesNotReject(() => assertReviewedPlan(cleared.plan, localPlan));
});

test('Order SKU Alias blanks preserve packaging while explicit carton clears are review-only and keep history', async () => {
  const full = fullBaselineWithAlias();
  const baseline = publicCatalogSnapshot(full);
  const workbook = rawAliasWorkbook();
  const xlsxRef = fakeXlsx(workbook);
  const options = {
    workbookData:new Uint8Array([1]).buffer,
    sourceFile:'raw-alias.xlsx',
    baselineCatalog:baseline,
    xlsxRef,
    rawCatalogApi:rawApi,
    generatedAt,
  };

  const preserved = await planRawProductCatalogUpdate(options);
  const candidates = preserved.clearCandidates.find(item => item.sku === '7ABC0101')?.fields.map(item => item.field) || [];
  assert.ok(candidates.includes('unitsPerCarton'));
  assert.ok(candidates.includes('cartonDimensionsCm'));
  assert.equal(preserved.plan.entries.length, 0, 'ordinary blank must preserve alias packaging');

  const cleared = await planRawProductCatalogUpdate({
    ...options,
    explicitClears:[{ sku:'7ABC0101', fields:['unitsPerCarton', 'cartonDimensionsCm'] }],
  });
  const entry = cleared.plan.entries.find(item => item.id === 'order-sku-alias:7ABC0101');
  assert.equal(entry.risk, 'review');
  assert.equal(entry.selected, false);
  assert.deepEqual(entry.fields.filter(field => ['unitsPerCarton', 'cartonDimensionsIn'].includes(field.field)), [
    { field:'unitsPerCarton', before:24, after:null },
    { field:'cartonDimensionsIn', before:[20, 16, 12], after:null },
  ]);
  const alias = cleared.candidateCatalog.orderSkuAliases[0];
  const selected = alias.packagingVersions.find(item => item.version === alias.newOrderPackagingDefaultVersion);
  assert.equal(alias.lifecycle, 'approved', 'identity ownership remains separate from packaging completeness');
  assert.equal(selected.unitsPerCarton, null);
  assert.equal(selected.cartonDimensionsCm, null);
  assert.equal(alias.packagingVersions[0].unitsPerCarton, 24, 'released alias history remains immutable');

  const clearIntent = explicitClearsFromReviewedPlan(cleared.plan);
  assert.deepEqual(clearIntent, [{ sku:'7ABC0101', fields:['unitsPerCarton', 'cartonDimensionsCm'] }]);
  const rawPayload = rawApi.createPayload(workbook, xlsxRef, {
    sourceFile:'raw-alias.xlsx', updatedAt:generatedAt, baseCatalogVersion:full.catalogVersion,
  });
  const localPayload = applyExplicitRawClears(rawPayload, clearIntent);
  const localCandidate = overlayRawProductCatalog(full, localPayload, { catalogVersion:'2026-08-29' }).catalog;
  const localPlan = await createCatalogChangePlan(full, localCandidate, {
    sourceFile:'raw-alias.xlsx', generatedAt,
    conflicts:localPayload.conflicts, duplicateConflicts:localPayload.stats.duplicateConflicts,
    rawSources:localPayload.records.map(record => ({ sku:record.sku, sourceSheet:record.sourceSheet, sourceRow:record.sourceRow })),
  });
  await assert.doesNotReject(() => assertReviewedPlan(cleared.plan, localPlan));
});

test('projected browser planner and canonical local release rebuild byte-equivalent signed evidence', async () => {
  const full = fullBaseline();
  const workbook = rawWorkbook({ cartons:40 });
  const xlsxRef = fakeXlsx(workbook);
  const browser = await planRawProductCatalogUpdate({
    workbookData:new Uint8Array([1]).buffer,
    sourceFile:'raw-product.xlsx',
    baselineCatalog:publicCatalogSnapshot(full),
    xlsxRef,
    rawCatalogApi:rawApi,
    generatedAt,
  });

  const payload = rawApi.createPayload(workbook, xlsxRef, {
    sourceFile:'raw-product.xlsx',
    updatedAt:generatedAt,
    baseCatalogVersion:full.catalogVersion,
  });
  const canonicalCandidate = overlayRawProductCatalog(full, payload, { catalogVersion:'2026-08-29' }).catalog;
  const canonicalPlan = await createCatalogChangePlan(full, canonicalCandidate, {
    sourceFile:'raw-product.xlsx',
    generatedAt,
    conflicts:payload.conflicts,
    duplicateConflicts:payload.stats.duplicateConflicts,
    rawSources:payload.records.map(record => ({
      sku:record.sku,
      sourceSheet:record.sourceSheet,
      sourceRow:record.sourceRow,
    })),
  });

  assert.equal(stableJson(browser.plan), stableJson(canonicalPlan));
  await assert.doesNotReject(() => assertReviewedPlan(browser.plan, canonicalPlan));
  assert.match(browser.plan.entries[0].evidence.sources[0].sheet, /AMZ/);
  assert.equal(browser.plan.entries[0].evidence.sources[0].row, 3);
});

test('explicit clear rejects a field that is not blank in the raw workbook', async () => {
  await assert.rejects(
    () => planRawProductCatalogUpdate({
      workbookData:new Uint8Array([1]).buffer,
      sourceFile:'raw.xlsx',
      baselineCatalog:publicCatalogSnapshot(fullBaseline()),
      xlsxRef:fakeXlsx(rawWorkbook({ cartons:40 })),
      rawCatalogApi:rawApi,
      generatedAt,
      explicitClears:[{ sku:'ABC01', fields:['cartonsPerPallet'] }],
    }),
    error => error.code === 'INVALID_EXPLICIT_CLEAR',
  );
});
