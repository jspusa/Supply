import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertNewCatalogVersion,
  catalogReleaseBlockers,
  createCatalogReleaseReport,
  nextCatalogVersion,
  renderCatalogReleaseReport,
} from '../catalog/product-catalog-release.js';

function packaging(overrides = {}) {
  return {
    version:'2026-08-28.4', effectiveFrom:'2026-08-28', effectiveTo:null,
    unitsPerCarton:24, cartonsPerPallet:42, cartonDimensionsCm:[50.8, 40.64, 30.48],
    grossWeightKg:null, grossWeightLb:29, orderUnit:{ kind:'single', units:1 },
    ...overrides,
  };
}

function catalog(version, overrides = {}) {
  return {
    schemaVersion:2,
    catalogVersion:version,
    products:[{
      productSku:'ABC01', productName:'Product', origin:'VN', standardFactory:'VN', lifecycle:'active',
      approvedOrderSkus:['ABC01', '7ABCD013AB'], packagingVersions:[packaging(overrides.productPackaging)],
    }],
    orderSkuAliases:[{
      orderSku:'7ABCD013AB', canonicalProductSku:'ABC01', lifecycle:'approved',
      packagingVersions:[packaging(overrides.aliasPackaging)],
    }],
  };
}

test('next catalog version advances the day or same-day sequence', () => {
  assert.equal(nextCatalogVersion('2026-08-28.4', '2026-08-28'), '2026-08-28.5');
  assert.equal(nextCatalogVersion('2026-08-28.4', '2026-08-29'), '2026-08-29');
  assert.throws(() => nextCatalogVersion('2026-08-28.4', '2026-08-27'), /precedes current catalog/);
  assert.equal(assertNewCatalogVersion('2026-08-28.4', '2026-08-28.5'), '2026-08-28.5');
  assert.throws(() => assertNewCatalogVersion('2026-08-28.4', '2026-08-28.4'), /must be newer/);
});

test('release report ignores a version-only change', () => {
  const report = createCatalogReleaseReport(catalog('2026-08-28.4'), catalog('2026-08-28.5'), {
    generatedAt:'2026-08-28T00:00:00.000Z', sourceFile:'raw.xlsx',
  });
  assert.equal(report.stats.changedEntries, 0);
  assert.equal(report.sourceFile, 'raw.xlsx');
});

test('release report shows product and Order SKU packaging old to new in FBA units', () => {
  const before = catalog('2026-08-28.4');
  const after = catalog('2026-08-28.5', {
    productPackaging:{ unitsPerCarton:30, cartonsPerPallet:36, cartonDimensionsCm:[58.5, 34.5, 35], grossWeightLb:35 },
    aliasPackaging:{ unitsPerCarton:26, grossWeightLb:30 },
  });
  const report = createCatalogReleaseReport(before, after, { generatedAt:'2026-08-28T00:00:00.000Z' });

  assert.equal(report.stats.changedEntries, 2);
  const product = report.changes.find(change => change.sku === 'ABC01');
  assert.deepEqual(product.before.cartonDimensionsIn, [20, 16, 12]);
  assert.deepEqual(product.after.cartonDimensionsIn, [23, 14, 14]);
  assert.deepEqual(product.fields.find(field => field.field === 'unitsPerCarton'), {
    field:'unitsPerCarton', before:24, after:30,
  });
  const alias = report.changes.find(change => change.sku === '7ABCD013AB');
  assert.equal(alias.after.canonicalProductSku, 'ABC01');
  assert.match(renderCatalogReleaseReport(report), /ABC01 \[updated\].*unitsPerCarton: 24 → 30/);
});

test('release blockers stop removals, alias owner changes, and packaging data loss', () => {
  const report = {
    changes:[
      { sku:'OLD01', entryType:'product', changeType:'removed', fields:[] },
      { sku:'7ABCD013AB', entryType:'order-sku-alias', changeType:'updated', fields:[
        { field:'canonicalProductSku', before:'ABC01', after:'ABC02' },
      ] },
      { sku:'ABC01', entryType:'product', changeType:'updated', fields:[
        { field:'unitsPerCarton', before:24, after:null },
        { field:'lifecycle', before:'active', after:'incomplete' },
      ] },
    ],
  };
  assert.deepEqual(catalogReleaseBlockers(report), [
    'OLD01 would be removed',
    '7ABCD013AB approved alias owner would change from ABC01 to ABC02',
    'ABC01.unitsPerCarton would lose a known value',
    'ABC01 would regress from active to incomplete',
  ]);
});
