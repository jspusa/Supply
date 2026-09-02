import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import {
  assertCatalogHistoryPreserved,
  CatalogValidationError,
  compileCatalog,
  migrateCatalog,
  orderGroupForOrderSku,
  resolvePackagingVersion,
  validateCatalog,
} from '../catalog/product-catalog.js';
import {
  renderSupplyProductData,
  supplyCatalogAdapter,
} from '../catalog/supply-catalog-adapter.js';
import {
  catalogFromProductMasterRows,
  ORDER_SKU_PACKAGING_HEADERS,
  PRODUCT_MASTER_HEADERS,
} from '../catalog/product-master-workbook.js';

const repoRoot = path.resolve(import.meta.dirname, '..');

function workbookRows(dataRows) {
  return [
    ['JAM 美國產品共用主檔'],
    [],
    ['Schema Version', 3, 'Catalog Version', '2026-08-25'],
    [],
    PRODUCT_MASTER_HEADERS,
    ...dataRows,
  ];
}

function workbookAliasRows(dataRows = [workbookAliasRow()]) {
  return [
    ['JAM Order SKU 專屬箱規'],
    [],
    ['Schema Version', 3, 'Catalog Version', '2026-08-25'],
    [],
    ORDER_SKU_PACKAGING_HEADERS,
    ...dataRows,
  ];
}

function workbookAliasRow(overrides = {}) {
  const values = {
    orderSku:'7GTPD013AB', canonicalProductSku:'GTP01', lifecycle:'核准',
    version:'fba-2026-08-25', effectiveFrom:'2026-08-25', effectiveTo:null, current:'是', orderUnit:'單品',
    unitsPerCarton:100, unitsPerPack:null, unitsPerBox:null, cartonsPerPallet:null,
    length:50.8, width:40.64, height:30.48, grossWeightKg:null, grossWeightLb:21,
    sourceSheet:'初始共用主檔', sourceRow:null,
    ...overrides,
  };
  return [
    values.orderSku, values.canonicalProductSku, values.lifecycle,
    values.version, values.effectiveFrom, values.effectiveTo, values.current, values.orderUnit,
    values.unitsPerCarton, values.unitsPerPack, values.unitsPerBox, values.cartonsPerPallet,
    values.length, values.width, values.height, values.grossWeightKg, values.grossWeightLb,
    values.sourceSheet, values.sourceRow, '', '',
  ];
}

function workbookProductRow(overrides = {}) {
  const values = {
    productSku:'GTP01', productName:'Gootoe Turkey Tendon Rope', origin:'越南', factory:'越南', aliases:'7GTPD013AB',
    version:'2026-08-25', effectiveFrom:'2026-08-25', effectiveTo:null, current:'是', orderUnit:'單品',
    unitsPerCarton:100, unitsPerPack:null, unitsPerBox:null, cartonsPerPallet:42,
    length:50, width:40, height:30, grossWeightKg:10, grossWeightLb:22,
    lifecycle:'正常', sourceSheet:'AMZ 所有SKU', sourceRow:6,
    ...overrides,
  };
  return [
    values.productSku, values.productName, values.origin, values.factory, values.aliases,
    values.version, values.effectiveFrom, values.effectiveTo, values.current, values.orderUnit,
    values.unitsPerCarton, values.unitsPerPack, values.unitsPerBox, values.cartonsPerPallet,
    values.length, values.width, values.height, values.grossWeightKg, values.grossWeightLb,
    values.lifecycle, values.sourceSheet, values.sourceRow, '', '',
  ];
}

function fixture(overrides = {}) {
  return {
    schemaVersion: 3,
    catalogVersion: '2026-08-25',
    products: [
      {
        productSku: 'GTP01',
        productName: 'Gootoe Turkey Tendon Rope',
        origin: 'VN',
        standardFactory: 'VN',
        lifecycle: 'active',
        approvedOrderSkus: ['GTP01', '7GTPD013AB'],
        newOrderPackagingDefaultVersion:'2026-08-25',
        packagingVersions: [
          {
            version: '2026-08-25',
            effectiveFrom: '2026-08-25',
            effectiveTo: null,
            unitsPerCarton: 100,
            cartonsPerPallet: 42,
            cartonDimensionsCm: [50, 40, 30],
            grossWeightLb: 22,
            orderUnit: { kind: 'single', units: 1 },
          },
        ],
      },
      {
        productSku: 'EZD011AM',
        productName: 'Herz Turkey Recipe',
        origin: 'TW',
        standardFactory: 'TW',
        lifecycle: 'active',
        approvedOrderSkus: ['EZD011AM'],
        newOrderPackagingDefaultVersion:'2026-08-25',
        packagingVersions: [
          {
            version: '2026-08-25',
            effectiveFrom: '2026-08-25',
            effectiveTo: null,
            unitsPerCarton: 18,
            cartonsPerPallet: 36,
            cartonDimensionsCm: [48, 38, 28],
            grossWeightLb: 41,
            orderUnit: { kind: 'single', units: 1 },
          },
        ],
      },
    ],
    orderSkuAliases: [
      {
        orderSku:'7GTPD013AB',
        canonicalProductSku:'GTP01',
        lifecycle:'approved',
        newOrderPackagingDefaultVersion:'fba-2026-08-25',
        packagingVersions:[
          {
            version:'fba-2026-08-25',
            effectiveFrom:'2026-08-25',
            effectiveTo:null,
            unitsPerCarton:90,
            cartonsPerPallet:42,
            cartonDimensionsCm:[50.8, 40.64, 30.48],
            grossWeightKg:null,
            grossWeightLb:21,
            orderUnit:{ kind:'single', units:1 },
          },
        ],
      },
    ],
    ...overrides,
  };
}

test('compiler validates once and projects the synchronous Supply compatibility interface', () => {
  const projected = compileCatalog(fixture(), supplyCatalogAdapter);

  assert.deepEqual(projected.meta, { schemaVersion:3, catalogVersion:'2026-08-25' });
  assert.deepEqual(projected.equivalentSkuPairs, [['GTP01', '7GTPD013AB']]);
  assert.deepEqual(projected.orderSkuPackaging.find(item => item.orderSku === '7GTPD013AB'), {
    orderSku:'7GTPD013AB',
    canonicalProductSku:'GTP01',
    packagingVersion:'fba-2026-08-25',
    perCarton:90,
    perPack:null,
    perBox:null,
    perPallet:42,
    boxSize:'50.8*40.64*30.48',
  });
  assert.deepEqual(projected.products[0], {
    productCode:'GTP01',
    packagingVersion:'2026-08-25',
    productName:'Gootoe Turkey Tendon Rope',
    boxSize:'50*40*30',
    perCarton:100,
    perPack:null,
    perBox:null,
    perPallet:42,
    country:'VN',
  });

  const context = { window:{} };
  vm.createContext(context);
  vm.runInContext(renderSupplyProductData(projected), context);
  assert.deepEqual(
    JSON.parse(JSON.stringify(context.window.SUPPLY_PRODUCT_CATALOG_META)),
    { schemaVersion:3, catalogVersion:'2026-08-25' },
  );
  assert.equal(context.window.allProductsData[0].productCode, 'GTP01');
  assert.equal(context.window.SUPPLY_EQUIVALENT_SKU_PAIRS[0][1], '7GTPD013AB');
  assert.equal(context.window.getProductByCode('gtp01').productCode, 'GTP01');
});

test('origin and standard factory are independent while 7-prefixed Order SKUs route to Subcontract', () => {
  const catalog = fixture();
  catalog.products[0].origin = 'KH';
  catalog.products[0].standardFactory = 'VN';

  const validated = validateCatalog(catalog);
  assert.equal(validated.products[0].origin, 'KH');
  assert.equal(validated.products[0].standardFactory, 'VN');
  assert.equal(orderGroupForOrderSku('7GTPD013AB', 'VN'), 'subcontract');
  assert.equal(orderGroupForOrderSku('GTP01', 'VN'), 'vietnam');
  assert.equal(orderGroupForOrderSku('EZD011AM', 'TW'), 'taiwan');

  catalog.products[0].origin = null;
  assert.equal(validateCatalog(catalog).products[0].origin, null);
});

test('schema v3 declares one default explicitly while retaining overlapping immutable history', () => {
  const catalog = fixture();
  catalog.products[0].packagingVersions = [
    {
      ...catalog.products[0].packagingVersions[0],
      version:'2025-01-01',
      effectiveFrom:'2025-01-01',
      effectiveTo:null,
      unitsPerCarton:90,
    },
    catalog.products[0].packagingVersions[0],
  ];
  const validated = validateCatalog(catalog);
  assert.equal(validated.products[0].newOrderPackaging.unitsPerCarton, 100);
  assert.equal(validated.products[0].currentPackaging, validated.products[0].newOrderPackaging);

  catalog.products[0].newOrderPackagingDefaultVersion = 'missing-version';
  assert.throws(
    () => validateCatalog(catalog),
    error => error instanceof CatalogValidationError && /newOrderPackagingDefaultVersion does not exist/.test(error.message),
  );

  catalog.products[0].newOrderPackagingDefaultVersion = '2026-08-25';
  catalog.products[0].packagingVersions[0].version = '2026-08-25';
  assert.throws(
    () => validateCatalog(catalog),
    error => error instanceof CatalogValidationError && /duplicates version/.test(error.message),
  );
});

test('schema v2 migrates to explicit defaults without losing identities or packaging facts', () => {
  const legacy = fixture({ schemaVersion:2 });
  for (const product of legacy.products) delete product.newOrderPackagingDefaultVersion;
  for (const alias of legacy.orderSkuAliases) delete alias.newOrderPackagingDefaultVersion;
  const before = structuredClone(legacy);

  const migrated = migrateCatalog(legacy);
  const validated = validateCatalog(legacy);

  assert.equal(migrated.schemaVersion, 3);
  assert.deepEqual(legacy, before, 'migration must not mutate the released input');
  assert.deepEqual(migrated.products[0].packagingVersions, before.products[0].packagingVersions);
  assert.deepEqual(migrated.orderSkuAliases[0].packagingVersions, before.orderSkuAliases[0].packagingVersions);
  assert.equal(migrated.products[0].newOrderPackagingDefaultVersion, '2026-08-25');
  assert.equal(migrated.orderSkuAliases[0].newOrderPackagingDefaultVersion, 'fba-2026-08-25');
  assert.equal(validated.schemaVersion, 3);
});

test('released packaging history is immutable while a correction may append and become default', () => {
  const before = fixture();
  const after = structuredClone(before);
  after.catalogVersion = '2026-08-25.2';
  after.products[0].packagingVersions.push({
    ...structuredClone(after.products[0].packagingVersions[0]),
    version:'2026-08-25.2',
    unitsPerCarton:96,
  });
  after.products[0].newOrderPackagingDefaultVersion = '2026-08-25.2';
  assert.equal(assertCatalogHistoryPreserved(before, after), true);
  assert.equal(resolvePackagingVersion(after, 'GTP01').unitsPerCarton, 96);
  assert.equal(resolvePackagingVersion(after, 'GTP01', '2026-08-25').unitsPerCarton, 100);

  const rewritten = structuredClone(after);
  rewritten.products[0].packagingVersions[0].unitsPerCarton = 95;
  assert.throws(
    () => assertCatalogHistoryPreserved(before, rewritten),
    error => error instanceof CatalogValidationError && /is immutable; create another version/.test(error.message),
  );

  const replacement = structuredClone(after);
  replacement.products[0].packagingVersions = [replacement.products[0].packagingVersions.at(-1)];
  assert.equal(assertCatalogHistoryPreserved(before, replacement, {
    packagingHistoryReplacements:[{ sku:'GTP01', removedVersionIds:['2026-08-25'] }],
  }), true);

  const replacementWithMutation = structuredClone(replacement);
  replacementWithMutation.products[0].packagingVersions[0].unitsPerCarton = 97;
  assert.throws(
    () => assertCatalogHistoryPreserved(after, replacementWithMutation, {
      packagingHistoryReplacements:[{ sku:'GTP01', removedVersionIds:['2026-08-25'] }],
    }),
    error => error instanceof CatalogValidationError && /is immutable/.test(error.message),
  );

  const removed = structuredClone(after);
  removed.products = removed.products.filter(product => product.productSku !== 'GTP01');
  removed.orderSkuAliases = [];
  assert.throws(
    () => assertCatalogHistoryPreserved(before, removed),
    error => error instanceof CatalogValidationError && /must be retired instead of removed/.test(error.message),
  );
});

test('retirement excludes an identity from new Supply work but preserves historical resolution', () => {
  const catalog = fixture();
  catalog.products[0].lifecycle = 'retired';
  const projection = compileCatalog(catalog, supplyCatalogAdapter);

  assert.equal(projection.products.some(product => product.productCode === 'GTP01'), false);
  assert.equal(projection.equivalentSkuPairs.some(pair => pair.includes('GTP01')), false);
  assert.equal(projection.orderSkuPackaging.some(item => item.canonicalProductSku === 'GTP01'), false);
  assert.equal(resolvePackagingVersion(catalog, 'GTP01', '2026-08-25').unitsPerCarton, 100);
});

test('Order SKU Alias owns its packaging while approved ownership stays on the canonical Product SKU', () => {
  const validated = validateCatalog(fixture());
  const alias = validated.orderSkuAliases[0];

  assert.equal(alias.orderSku, '7GTPD013AB');
  assert.equal(alias.canonicalProductSku, 'GTP01');
  assert.equal(alias.lifecycle, 'approved');
  assert.equal(alias.currentPackaging.unitsPerCarton, 90);
  assert.deepEqual(alias.currentPackaging.cartonDimensionsCm, [50.8, 40.64, 30.48]);
  assert.equal(validated.products[0].currentPackaging.unitsPerCarton, 100);
});

test('an incomplete alias default is excluded from new Supply work while immutable history remains readable', () => {
  const catalog = fixture();
  const alias = catalog.orderSkuAliases[0];
  alias.packagingVersions.push({
    ...structuredClone(alias.packagingVersions[0]),
    version:'2026-08-29',
    effectiveFrom:'2026-08-29',
    unitsPerCarton:null,
    cartonDimensionsCm:null,
  });
  alias.newOrderPackagingDefaultVersion = '2026-08-29';

  const projection = compileCatalog(catalog, supplyCatalogAdapter);
  assert.equal(projection.equivalentSkuPairs.some(pair => pair.includes(alias.orderSku)), false);
  assert.equal(projection.orderSkuPackaging.some(item => item.orderSku === alias.orderSku), false);
  assert.equal(resolvePackagingVersion(catalog, alias.orderSku, 'fba-2026-08-25').unitsPerCarton, 90);
  assert.deepEqual(resolvePackagingVersion(catalog, alias.orderSku, 'fba-2026-08-25').cartonDimensionsCm, [50.8, 40.64, 30.48]);
});

test('schema v3 permits unknown order unit only for incomplete work while schema v2 stays strict', () => {
  const incomplete = fixture();
  incomplete.products[0].lifecycle = 'incomplete';
  incomplete.products[0].packagingVersions[0].orderUnit = null;
  assert.doesNotThrow(() => validateCatalog(incomplete));
  assert.equal(compileCatalog(incomplete, supplyCatalogAdapter).products.some(item => item.productCode === 'GTP01'), false);

  const active = structuredClone(incomplete);
  active.products[0].lifecycle = 'active';
  assert.throws(
    () => validateCatalog(active),
    error => error instanceof CatalogValidationError && /active default packaging must know orderUnit/.test(error.message),
  );

  const legacy = structuredClone(incomplete);
  legacy.schemaVersion = 2;
  delete legacy.products[0].newOrderPackagingDefaultVersion;
  for (const alias of legacy.orderSkuAliases) delete alias.newOrderPackagingDefaultVersion;
  assert.throws(
    () => validateCatalog(legacy),
    error => error instanceof CatalogValidationError && /orderUnit must be known in schemaVersion 2/.test(error.message),
  );
});

test('Order SKU Alias validation rejects invalid owners, duplicates, and missing declared defaults', () => {
  const missingApproval = fixture();
  missingApproval.products[0].approvedOrderSkus = ['GTP01'];
  assert.throws(
    () => validateCatalog(missingApproval),
    error => error instanceof CatalogValidationError && /must be listed in GTP01\.approvedOrderSkus/.test(error.message),
  );

  const duplicate = fixture();
  duplicate.orderSkuAliases.push(structuredClone(duplicate.orderSkuAliases[0]));
  assert.throws(
    () => validateCatalog(duplicate),
    error => error instanceof CatalogValidationError && /orderSku duplicates 7GTPD013AB/.test(error.message),
  );

  const missingDefault = fixture();
  missingDefault.orderSkuAliases[0].newOrderPackagingDefaultVersion = 'missing';
  assert.throws(
    () => validateCatalog(missingDefault),
    error => error instanceof CatalogValidationError && /newOrderPackagingDefaultVersion does not exist/.test(error.message),
  );
});

test('unmapped legacy aliases have no guessed owner and 7-prefixed Product SKUs are rejected', () => {
  const catalog = fixture();
  catalog.orderSkuAliases.push({
    orderSku:'7VTSD913AB',
    canonicalProductSku:null,
    lifecycle:'unmapped-legacy',
    newOrderPackagingDefaultVersion:'fba-2026-08-25',
    packagingVersions:[{
      version:'fba-2026-08-25',
      effectiveFrom:'2026-08-25',
      effectiveTo:null,
      unitsPerCarton:10,
      cartonsPerPallet:null,
      cartonDimensionsCm:[50.8, 40.64, 30.48],
      grossWeightKg:null,
      grossWeightLb:24,
      orderUnit:{ kind:'single', units:1 },
    }],
  });
  assert.equal(validateCatalog(catalog).orderSkuAliases[1].canonicalProductSku, null);

  catalog.orderSkuAliases[1].canonicalProductSku = 'GTP01';
  assert.throws(
    () => validateCatalog(catalog),
    error => error instanceof CatalogValidationError && /must be null for an unmapped-legacy alias/.test(error.message),
  );

  const falselyUnmapped = fixture();
  falselyUnmapped.orderSkuAliases[0].canonicalProductSku = null;
  falselyUnmapped.orderSkuAliases[0].lifecycle = 'unmapped-legacy';
  assert.throws(
    () => validateCatalog(falselyUnmapped),
    error => error instanceof CatalogValidationError && /is already approved by GTP01/.test(error.message),
  );

  const sevenProduct = fixture();
  sevenProduct.products[1].productSku = '7LEGACY';
  sevenProduct.products[1].approvedOrderSkus = ['7LEGACY'];
  assert.throws(
    () => validateCatalog(sevenProduct),
    error => error instanceof CatalogValidationError && /must not be 7-prefixed/.test(error.message),
  );
});

test('approved Order SKU alternatives must be 7-prefixed so Supply and FBA share one alias set', () => {
  const catalog = fixture();
  catalog.products[1].approvedOrderSkus.push('LEGACY-ALT');

  assert.throws(
    () => validateCatalog(catalog),
    error => error instanceof CatalogValidationError
      && /approvedOrderSkus alternative LEGACY-ALT must be 7-prefixed/.test(error.message),
  );
});

test('canonical public catalog rejects fields outside the explicit allowlist', () => {
  for (const [field, value] of [
    ['cost', 4.2],
    ['supplier', 'private factory'],
    ['inventory', 100],
  ]) {
    const catalog = fixture();
    catalog.products[0][field] = value;
    assert.throws(
      () => validateCatalog(catalog),
      error => error instanceof CatalogValidationError && error.message.includes(`unsupported field ${field}`),
      field,
    );
  }
});

test('ProductMasterTable rows compile into the canonical catalog without relying on row overwrite order', () => {
  const catalog = catalogFromProductMasterRows(workbookRows([
    workbookProductRow({
      version:'supply-2026-07-19',
      effectiveFrom:'2026-07-19',
      effectiveTo:'2026-08-24',
      current:'否',
      unitsPerCarton:90,
    }),
    workbookProductRow(),
  ]), workbookAliasRows());

  assert.equal(catalog.products.length, 1);
  assert.deepEqual(catalog.products[0].approvedOrderSkus, ['GTP01', '7GTPD013AB']);
  assert.deepEqual(catalog.products[0].packagingVersions.map(item => item.unitsPerCarton), [90, 100]);
  assert.equal(catalog.products[0].newOrderPackagingDefaultVersion, '2026-08-25');
  assert.equal(catalog.products[0].origin, 'VN');
  assert.equal(catalog.products[0].standardFactory, 'VN');
  assert.equal(catalog.orderSkuAliases[0].orderSku, '7GTPD013AB');
  assert.equal(catalog.orderSkuAliases[0].packagingVersions[0].unitsPerCarton, 100);
  assert.equal(catalog.orderSkuAliases[0].newOrderPackagingDefaultVersion, 'fba-2026-08-25');
});

test('legacy schema v2 workbook headers migrate to schema v3 defaults', () => {
  const productRows = workbookRows([workbookProductRow()]);
  const aliasRows = workbookAliasRows();
  productRows[2][1] = 2;
  aliasRows[2][1] = 2;
  productRows[4] = [...PRODUCT_MASTER_HEADERS];
  productRows[4][8] = '現行版本';
  aliasRows[4] = [...ORDER_SKU_PACKAGING_HEADERS];
  aliasRows[4][6] = '現行版本';

  const catalog = catalogFromProductMasterRows(productRows, aliasRows);
  assert.equal(catalog.schemaVersion, 3);
  assert.equal(catalog.products[0].newOrderPackagingDefaultVersion, '2026-08-25');
  assert.equal(catalog.orderSkuAliases[0].newOrderPackagingDefaultVersion, 'fba-2026-08-25');
});

test('OrderSkuPackagingTable supports approved and unmapped legacy rows without changing product ownership', () => {
  const catalog = catalogFromProductMasterRows(
    workbookRows([workbookProductRow()]),
    workbookAliasRows([
      workbookAliasRow(),
      workbookAliasRow({
        orderSku:'7VTSD913AB', canonicalProductSku:'', lifecycle:'未映射舊品號',
        unitsPerCarton:10, grossWeightLb:24,
      }),
    ]),
  );

  assert.deepEqual(catalog.products[0].approvedOrderSkus, ['GTP01', '7GTPD013AB']);
  assert.deepEqual(
    catalog.orderSkuAliases.map(alias => [alias.orderSku, alias.canonicalProductSku, alias.lifecycle]),
    [
      ['7GTPD013AB', 'GTP01', 'approved'],
      ['7VTSD913AB', null, 'unmapped-legacy'],
    ],
  );
});

test('workbook compiler rejects inconsistent product facts, missing defaults, and shared aliases', () => {
  assert.throws(
    () => catalogFromProductMasterRows(workbookRows([
      workbookProductRow({ effectiveTo:'2026-08-24', current:'否' }),
      workbookProductRow({ version:'2026-08-26', effectiveFrom:'2026-08-25', productName:'changed' }),
    ]), workbookAliasRows()),
    /changes stable fields/,
  );
  assert.throws(
    () => catalogFromProductMasterRows(workbookRows([workbookProductRow({ current:'否' })]), workbookAliasRows()),
    /newOrderPackagingDefaultVersion must name one Packaging Specification Version/,
  );
  assert.throws(
    () => catalogFromProductMasterRows(workbookRows([
      workbookProductRow(),
      workbookProductRow({ productSku:'GTP02', version:'2026-08-25.2' }),
    ]), workbookAliasRows()),
    /reuses 7GTPD013AB/,
  );
});

test('workbook compiler keeps unknown origin separate and requires a factory only for active products', () => {
  const incomplete = catalogFromProductMasterRows(workbookRows([
    workbookProductRow({
      productName:'',
      origin:'待補',
      factory:'待補',
      aliases:'',
      lifecycle:'資料待補',
      unitsPerCarton:null,
      cartonsPerPallet:null,
      length:null,
      width:null,
      height:null,
    }),
  ]), workbookAliasRows([]));
  assert.equal(incomplete.products[0].origin, null);
  assert.equal(incomplete.products[0].standardFactory, null);
  assert.equal(incomplete.products[0].packagingVersions[0].unitsPerCarton, null);
  assert.equal(incomplete.products[0].packagingVersions[0].cartonsPerPallet, null);
  assert.equal(incomplete.products[0].packagingVersions[0].cartonDimensionsCm, null);

  assert.throws(
    () => catalogFromProductMasterRows(workbookRows([
      workbookProductRow({ factory:'待補' }),
    ]), workbookAliasRows()),
    /standardFactory must be known for an active product/,
  );

  assert.throws(
    () => catalogFromProductMasterRows(workbookRows([
      workbookProductRow({ cartonsPerPallet:null }),
    ]), workbookAliasRows()),
    /active default packaging must know cartonsPerPallet/,
  );
});

test('checked canonical catalog and generated Supply snapshot stay in sync', () => {
  const canonical = JSON.parse(fs.readFileSync(path.join(repoRoot, 'catalog', 'product-catalog.json'), 'utf8'));
  const expected = renderSupplyProductData(compileCatalog(canonical, supplyCatalogAdapter));
  const actual = fs.readFileSync(path.join(repoRoot, 'product-data.js'), 'utf8');

  assert.equal(actual, expected);
  assert.equal(canonical.schemaVersion, 3);
  assert.match(canonical.catalogVersion, /^(?:2026-08-28\.4|2026-09-02)$/);
  assert.match(canonical.catalogVersion, /^\d{4}-\d{2}-\d{2}(?:\.\d+)?$/);
});

test('the 15 duplicate SKUs match the exact packaging facts for the checked release', () => {
  const canonical = JSON.parse(fs.readFileSync(path.join(repoRoot, 'catalog', 'product-catalog.json'), 'utf8'));
  const cleaned = canonical.catalogVersion === '2026-09-02';
  const expectedUnits = new Map(Object.entries(cleaned ? {
    '1ABRD002A0':36, GTAL01:30, GTB05:90, GTBL01:26, GTBL03:28,
    GTBL05:24, GTCL01:28, GTP03:90, GTP05:90, GTPL01:24,
    GTPL03:24, GTPL05:24, GTRL01:22, GTRL03:28, GTSL01:24,
  } : {
    '1ABRD002A0':42, GTAL01:38, GTB05:100, GTBL01:30, GTBL03:30,
    GTBL05:30, GTCL01:30, GTP03:100, GTP05:100, GTPL01:30,
    GTPL03:30, GTPL05:30, GTRL01:30, GTRL03:30, GTSL01:30,
  }));

  for (const [productSku, expectedUnitsPerCarton] of expectedUnits) {
    const product = canonical.products.find(item => item.productSku === productSku);
    const current = product.packagingVersions.find(packaging => packaging.version === product.newOrderPackagingDefaultVersion);
    assert.equal(current.unitsPerCarton, expectedUnitsPerCarton, product.productSku);
    if (cleaned) assert.equal(product.packagingVersions.length, 1, product.productSku);
    else assert.ok(product.packagingVersions.length >= 2, product.productSku);
    assert.equal(current.effectiveFrom, cleaned ? '2026-09-02' : '2026-08-28', product.productSku);
    assert.equal(current.effectiveTo, null, product.productSku);
    assert.equal(current.source.sheet, 'AMZ 所有SKU', product.productSku);
  }

  const gtp03 = canonical.products.find(product => product.productSku === 'GTP03').packagingVersions.at(-1);
  assert.deepEqual(gtp03.cartonDimensionsCm, cleaned ? [50, 40, 30] : [58.5, 34.5, 35]);
  assert.equal(gtp03.cartonsPerPallet, cleaned ? 42 : 36);
  assert.equal(gtp03.grossWeightLb, cleaned ? 24 : 26);

  const unknownOrigin = canonical.products.find(product => product.productSku === '1AWDD010A0');
  assert.equal(unknownOrigin.standardFactory, 'VN');
  assert.equal(unknownOrigin.origin, null);
});

test('raw release promotes 14 complete products while 11 incomplete rows stay out of Supply', () => {
  const canonical = JSON.parse(fs.readFileSync(path.join(repoRoot, 'catalog', 'product-catalog.json'), 'utf8'));
  const promoted = [
    '1AWDD773A0', '1AWDD775A0', '1AXXD001A0', '1AXXD002A0', '1GLTD011A0',
    '1GXXD001A0', '1GXXD002A0', '1VFPD010A0', '1VFPD018A0', '1VFPD050A0',
    '1VFPD058A0', '1VFRD010A0', '1VFSD010A0', '1VFSD018A0',
  ];
  const stillIncomplete = [
    'ED011AM', 'EZD010', 'EZD010-3', 'EZD020', 'EZD020-3', 'EZD040', 'EZD040-3',
    'EZD050', 'EZD050-3', 'EZD060', 'EZD060-3',
  ];
  const bySku = new Map(canonical.products.map(product => [product.productSku, product]));

  assert.match(canonical.catalogVersion, /^(?:2026-08-28\.4|2026-09-02)$/);
  assert.equal(canonical.products.length, 360);
  for (const productSku of promoted) {
    const product = bySku.get(productSku);
    assert.ok(product, productSku);
    assert.equal(product.productName, productSku, productSku);
    assert.ok(product.origin, productSku);
    assert.ok(product.standardFactory, productSku);
    assert.equal(product.lifecycle, 'active', productSku);
    assert.deepEqual(product.approvedOrderSkus, [productSku], productSku);
    assert.ok(product.packagingVersions.at(-1).cartonsPerPallet, productSku);
  }
  for (const productSku of stillIncomplete) {
    const product = bySku.get(productSku);
    assert.equal(product.lifecycle, 'incomplete', productSku);
    assert.equal(product.packagingVersions.at(-1).cartonsPerPallet, null, productSku);
  }

  const projected = compileCatalog(canonical, supplyCatalogAdapter);
  assert.equal(projected.products.length, 349);
  assert.equal(promoted.every(productSku => projected.products.some(product => product.productCode === productSku)), true);
  assert.equal(projected.products.some(product => stillIncomplete.includes(product.productCode)), false);

  const airDried = bySku.get('1AWDD773A0').packagingVersions.at(-1);
  assert.equal(airDried.unitsPerCarton, 38);
  assert.deepEqual(airDried.cartonDimensionsCm, [50, 40, 30]);
  assert.equal(airDried.grossWeightLb, 43);

  const aliasLikeProduct = bySku.get('ED011AM').packagingVersions.at(-1);
  assert.equal(aliasLikeProduct.unitsPerCarton, null);
  assert.equal(aliasLikeProduct.cartonDimensionsCm, null);
  assert.equal(aliasLikeProduct.grossWeightLb, null);
});

test('FBA HEAD positive-weight baseline remains complete in canonical new-order defaults', () => {
  const canonical = JSON.parse(fs.readFileSync(path.join(repoRoot, 'catalog', 'product-catalog.json'), 'utf8'));
  const currentPackaging = new Map(canonical.products.map(product => [
    product.productSku,
    product.packagingVersions.find(packaging => packaging.version === product.newOrderPackagingDefaultVersion),
  ]));
  const positiveWeights = [...currentPackaging.values()]
    .filter(packaging => typeof packaging.grossWeightLb === 'number' && packaging.grossWeightLb > 0);

  // Derived from FBA HEAD 07cf8cd after BUILTIN_CATALOG_ADDITIONS overwrites BUILTIN_CATALOG.
  assert.equal(positiveWeights.length, 269);
  assert.equal(currentPackaging.get('AFA12AM').grossWeightLb, 34);
  assert.equal(currentPackaging.get('VBS03').grossWeightLb, 40);
  assert.equal(currentPackaging.get('GTB03').grossWeightLb, 26);
});

test('schema v3 retains the 27 FBA legacy 7-SKU packages plus the initialized ATS01 alias', () => {
  const canonical = JSON.parse(fs.readFileSync(path.join(repoRoot, 'catalog', 'product-catalog.json'), 'utf8'));
  const validated = validateCatalog(canonical);
  const expectedFba = {
    '7ATRD013AB':[100, 21], '7ATSD010AB':[100, 24], '7ATSD017AB':[30, 22], '7ATSD019AB':[8, 22],
    '7GTBD013AB':[100, 21], '7GTBD017AB':[26, 30], '7GTBD037AB':[28, 32], '7GTBD053AB':[90, 25],
    '7GTBD057AB':[24, 27], '7GTPD013AB':[100, 21], '7GTPD017AB':[24, 27], '7GTPD037AB':[24, 27],
    '7GTPD053AB':[90, 25], '7GTPD057AB':[24, 27], '7GTRD013AB':[100, 21], '7GTRD017AB':[22, 25],
    '7GTRD037AB':[28, 32], '7GTSD013AB':[100, 24], '7GTSD017AB':[24, 24], '7VTBD015AB':[50, 17],
    '7VTBD410AB':[90, 18], '7VTRD015AB':[50, 17], '7VTRD215AB':[25, 18], '7VTSD013AB':[100, 24],
    '7VTSD017AB':[24, 29], '7VTSD513AB':[20, 24], '7VTSD913AB':[10, 24],
  };
  const aliases = new Map(validated.orderSkuAliases.map(alias => [alias.orderSku, alias]));
  const products = new Map(validated.products.map(product => [product.productSku, product]));

  assert.equal(canonical.schemaVersion, 3);
  assert.match(canonical.catalogVersion, /^(?:2026-08-28\.4|2026-09-02)$/);
  assert.equal(aliases.size, 28);
  assert.equal(validated.orderSkuAliases.filter(alias => alias.lifecycle === 'approved').length, 22);
  assert.deepEqual(
    validated.orderSkuAliases.filter(alias => alias.lifecycle === 'unmapped-legacy').map(alias => alias.orderSku).sort(),
    ['7VTBD015AB', '7VTRD015AB', '7VTRD215AB', '7VTSD017AB', '7VTSD513AB', '7VTSD913AB'],
  );

  for (const [orderSku, [unitsPerCarton, grossWeightLb]] of Object.entries(expectedFba)) {
    const alias = aliases.get(orderSku);
    assert.ok(alias, orderSku);
    assert.equal(alias.currentPackaging.unitsPerCarton, unitsPerCarton, orderSku);
    assert.deepEqual(alias.currentPackaging.cartonDimensionsCm, [50, 40, 30], orderSku);
    assert.equal(alias.currentPackaging.cartonsPerPallet, 42, orderSku);
    assert.equal(alias.currentPackaging.grossWeightLb, grossWeightLb, orderSku);
  }

  const fbaBackedMapped = validated.orderSkuAliases.filter(alias => alias.lifecycle === 'approved'
    && alias.orderSku !== '7ATSD011AB');
  assert.equal(fbaBackedMapped.length, 21);
  const aliasesWithDistinctPackaging = fbaBackedMapped.filter(alias => {
    const owner = products.get(alias.canonicalProductSku).currentPackaging;
    return alias.currentPackaging.unitsPerCarton !== owner.unitsPerCarton
      || JSON.stringify(alias.currentPackaging.cartonDimensionsCm) !== JSON.stringify(owner.cartonDimensionsCm)
      || alias.currentPackaging.grossWeightLb !== owner.grossWeightLb;
  });
  assert.equal(aliasesWithDistinctPackaging.length, 20);
  assert.equal(aliasesWithDistinctPackaging.some(alias => alias.orderSku === '7VTBD410AB'), false);

  const ats = aliases.get('7ATSD011AB');
  const atsOwner = products.get('ATS01');
  assert.equal(ats.canonicalProductSku, 'ATS01');
  assert.equal(ats.currentPackaging.unitsPerCarton, atsOwner.currentPackaging.unitsPerCarton);
  assert.deepEqual(ats.currentPackaging.cartonDimensionsCm, atsOwner.currentPackaging.cartonDimensionsCm);
  assert.equal(ats.currentPackaging.grossWeightLb, null);
  assert.equal(atsOwner.currentPackaging.grossWeightLb, 26);
});
