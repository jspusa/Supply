import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyCatalogChangePlan,
  createCatalogChangePlan,
  createCatalogChangeRecord,
  renderCatalogChangePlan,
  sha256,
} from '../catalog/catalog-change-plan.js';

function packaging(overrides = {}) {
  return {
    version:'2026-08-28.4', effectiveFrom:'2026-08-28', effectiveTo:null,
    unitsPerCarton:24, cartonsPerPallet:42, cartonDimensionsCm:[50.8, 40.64, 30.48],
    grossWeightKg:null, grossWeightLb:29, orderUnit:{ kind:'single', units:1 },
    ...overrides,
  };
}

function catalog(version, overrides = {}) {
  const productVersions = [packaging()];
  const aliasVersions = [packaging()];
  let productDefault = '2026-08-28.4';
  let aliasDefault = '2026-08-28.4';
  if (overrides.productPackaging) {
    productDefault = version;
    productVersions.push(packaging({ ...overrides.productPackaging, version }));
  }
  if (overrides.aliasPackaging) {
    aliasDefault = version;
    aliasVersions.push(packaging({ ...overrides.aliasPackaging, version }));
  }
  return {
    schemaVersion:3,
    catalogVersion:version,
    products:[{
      productSku:'ABC01', productName:'Product', origin:overrides.origin || 'VN',
      standardFactory:overrides.standardFactory || 'VN', lifecycle:overrides.lifecycle || 'active',
      approvedOrderSkus:overrides.approvedOrderSkus || ['ABC01', '7ABCD013AB'],
      newOrderPackagingDefaultVersion:productDefault,
      packagingVersions:productVersions,
    }],
    orderSkuAliases:[{
      orderSku:'7ABCD013AB', canonicalProductSku:'ABC01', lifecycle:'approved',
      newOrderPackagingDefaultVersion:aliasDefault,
      packagingVersions:aliasVersions,
    }],
  };
}

test('change plan preselects safe packaging but leaves high-risk identity changes for review', async () => {
  const before = catalog('2026-08-28.4');
  const after = catalog('2026-08-28.5', {
    origin:'TW', standardFactory:'TW',
    aliasPackaging:{ unitsPerCarton:30 },
  });
  const plan = await createCatalogChangePlan(before, after, {
    generatedAt:'2026-08-28T01:02:03.000Z',
    sourceFile:'/Users/private/customer/raw.xlsx',
  });

  const product = plan.entries.find(entry => entry.id === 'product:ABC01');
  const alias = plan.entries.find(entry => entry.id === 'order-sku-alias:7ABCD013AB');
  assert.equal(product.risk, 'review');
  assert.equal(product.selected, false);
  assert.equal(alias.risk, 'safe');
  assert.equal(alias.selected, true);
  assert.equal(plan.sourceFile, 'raw.xlsx');
  assert.equal(plan.baseline.sha256, await sha256(before));
  assert.match(renderCatalogChangePlan(plan), /安全 1、待確認 1、阻擋 0/);
});

test('source conflicts show competing values and source rows and block the whole release', async () => {
  const before = catalog('2026-08-28.4');
  const after = catalog('2026-08-28.5', { productPackaging:{ unitsPerCarton:30 } });
  const plan = await createCatalogChangePlan(before, after, {
    generatedAt:'2026-08-28T01:02:03.000Z',
    duplicateConflicts:1,
    conflicts:[{
      sku:'ABC01',
      fields:[{ field:'unitsPerCarton', values:[
        { value:24, sourceSheet:'2026', sourceRow:8 },
        { value:30, sourceSheet:'AMZ所有SKU', sourceRow:12 },
      ] }],
    }],
  });

  assert.equal(plan.stats.blocking, 1);
  assert.match(plan.blockers[0], /ABC01.*24.*2026 第 8 列.*30.*AMZ所有SKU 第 12 列/);
  assert.match(renderCatalogChangePlan(plan), /ABC01 \[conflict\].*2026 第 8 列.*AMZ所有SKU 第 12 列/);
  await assert.rejects(() => applyCatalogChangePlan(before, after, plan), /發布被阻擋/);
});

test('apply rejects stale baselines and applies only selected entries', async () => {
  const before = catalog('2026-08-28.4');
  const after = catalog('2026-08-28.5', {
    origin:'TW', standardFactory:'TW',
    aliasPackaging:{ unitsPerCarton:30 },
  });
  const plan = await createCatalogChangePlan(before, after, { generatedAt:'2026-08-28T01:02:03.000Z' });
  const applied = await applyCatalogChangePlan(before, after, plan);

  assert.equal(applied.catalog.catalogVersion, '2026-08-28.5');
  assert.equal(applied.catalog.products[0].origin, 'VN');
  const appliedAlias = applied.catalog.orderSkuAliases[0];
  assert.equal(
    appliedAlias.packagingVersions.find(item => item.version === appliedAlias.newOrderPackagingDefaultVersion).unitsPerCarton,
    30,
  );
  assert.deepEqual(applied.selectedEntryIds, ['order-sku-alias:7ABCD013AB']);

  const stale = catalog('2026-08-28.4');
  stale.products[0].productName = 'Changed after review';
  await assert.rejects(() => applyCatalogChangePlan(stale, after, plan), /已在計畫建立後更新/);
});

test('public change record contains evidence hashes but no local source path', async () => {
  const before = catalog('2026-08-28.4');
  const after = catalog('2026-08-28.5', { aliasPackaging:{ unitsPerCarton:30 } });
  const plan = await createCatalogChangePlan(before, after, {
    generatedAt:'2026-08-28T01:02:03.000Z',
    sourceFile:'/Users/example/Desktop/private.xlsx',
  });
  const applied = await applyCatalogChangePlan(before, after, plan);
  const record = await createCatalogChangeRecord(plan, applied.catalog, applied.selectedEntryIds, {
    appliedAt:'2026-08-28T02:03:04.000Z',
  });

  assert.equal(record.catalogSha256, await sha256(applied.catalog));
  assert.equal(record.stats.selected, 1);
  assert.deepEqual(record.changes.map(change => ({ id:change.id, fields:change.fields.map(field => field.field) })), [{
    id:'order-sku-alias:7ABCD013AB',
    fields:['packagingVersion', 'unitsPerCarton'],
  }]);
  assert.equal(JSON.stringify(record).includes('/Users/'), false);
  assert.equal(Object.hasOwn(record, 'sourceFile'), false);
});
