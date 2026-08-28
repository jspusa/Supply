import assert from 'node:assert/strict';
import test from 'node:test';

import { compileCatalog } from '../catalog/product-catalog.js';
import { overlayRawProductCatalog } from '../catalog/raw-product-catalog-overlay.js';
import { supplyCatalogAdapter } from '../catalog/supply-catalog-adapter.js';

function packaging(overrides = {}) {
  return {
    version:'2026-08-25',
    effectiveFrom:'2026-08-25',
    effectiveTo:null,
    unitsPerCarton:overrides.unitsPerCarton ?? null,
    cartonsPerPallet:overrides.cartonsPerPallet ?? null,
    cartonDimensionsCm:overrides.cartonDimensionsCm ?? null,
    grossWeightKg:null,
    grossWeightLb:overrides.grossWeightLb ?? null,
    orderUnit:{ kind:'single', units:1 },
  };
}

function baseCatalog() {
  return {
    schemaVersion:3,
    catalogVersion:'2026-08-28.3',
    products:[
      {
        productSku:'NEW01',
        productName:'New product',
        origin:null,
        standardFactory:null,
        lifecycle:'incomplete',
        approvedOrderSkus:['NEW01'],
        newOrderPackagingDefaultVersion:'2026-08-25',
        packagingVersions:[packaging({ unitsPerCarton:24, cartonDimensionsCm:[48, 38, 28], grossWeightLb:29 })],
      },
      {
        productSku:'GTP01',
        productName:'Gootoe Pork',
        origin:'VN',
        standardFactory:'VN',
        lifecycle:'active',
        approvedOrderSkus:['GTP01', '7GTPD013AB'],
        newOrderPackagingDefaultVersion:'2026-08-25',
        packagingVersions:[packaging({ unitsPerCarton:90, cartonsPerPallet:42, cartonDimensionsCm:[50, 40, 30], grossWeightLb:25 })],
      },
    ],
    orderSkuAliases:[
      {
        orderSku:'7GTPD013AB',
        canonicalProductSku:'GTP01',
        lifecycle:'approved',
        newOrderPackagingDefaultVersion:'2026-08-25',
        packagingVersions:[packaging({ unitsPerCarton:90, cartonDimensionsCm:[50, 40, 30], grossWeightLb:25 })],
      },
    ],
  };
}

test('raw workbook facts become versioned built-in product data and activate complete products', () => {
  const result = overlayRawProductCatalog(baseCatalog(), { records:[{
    sku:'NEW01', origin:'TW', unitsPerCarton:24, cartonsPerPallet:30,
    cartonDimensionsCm:[48, 38, 28], grossWeightLb:29,
    sourceSheet:'2026', sourceRow:3,
  }] }, { catalogVersion:'2026-08-28.4' });

  const product = result.catalog.products.find(item => item.productSku === 'NEW01');
  assert.equal(result.catalog.catalogVersion, '2026-08-28.4');
  assert.equal(product.lifecycle, 'active');
  assert.equal(product.origin, 'TW');
  assert.equal(product.standardFactory, 'TW');
  assert.equal(product.packagingVersions.length, 2);
  assert.equal(product.packagingVersions[0].cartonsPerPallet, null, 'released incomplete history stays intact');
  assert.equal(product.newOrderPackagingDefaultVersion, '2026-08-28.4');
  assert.equal(product.packagingVersions[1].cartonsPerPallet, 30);
  assert.deepEqual(product.packagingVersions[1].source, { sheet:'2026', row:3 });
  assert.equal(result.stats.activatedProducts, 1);
});

test('unseen raw SKUs do not invent product names or order-unit business facts', () => {
  const result = overlayRawProductCatalog(baseCatalog(), { records:[{
    sku:'UNSEEN01', origin:'VN', unitsPerCarton:24, cartonsPerPallet:42,
    cartonDimensionsCm:[50, 40, 30], grossWeightLb:27,
    sourceSheet:'AMZ 所有SKU', sourceRow:120,
  }] }, { catalogVersion:'2026-08-28.4' });
  const product = result.catalog.products.find(item => item.productSku === 'UNSEEN01');
  const selected = product.packagingVersions.find(item => item.version === product.newOrderPackagingDefaultVersion);
  assert.equal(product.productName, '');
  assert.equal(product.lifecycle, 'incomplete');
  assert.equal(selected.orderUnit, null);
  const supply = compileCatalog(result.catalog, supplyCatalogAdapter);
  assert.equal(supply.products.some(item => item.productCode === 'UNSEEN01'), false);
  assert.equal(supply.orderSkuPackaging.some(item => item.orderSku === 'UNSEEN01'), false);
});

test('an existing incomplete product with no real name stays unnamed after raw packaging refresh', () => {
  const catalog = baseCatalog();
  catalog.products[0].productName = '';
  catalog.products[0].lifecycle = 'incomplete';
  const result = overlayRawProductCatalog(catalog, { records:[{
    sku:'NEW01', origin:'TW', unitsPerCarton:24, cartonsPerPallet:30,
    cartonDimensionsCm:[48, 38, 28], grossWeightLb:29,
    sourceSheet:'2026', sourceRow:3,
  }] }, { catalogVersion:'2026-08-28.4' });
  const product = result.catalog.products.find(item => item.productSku === 'NEW01');
  assert.equal(product.productName, '');
  assert.equal(product.lifecycle, 'incomplete');
});

test('raw 7-prefixed rows update packaging without guessing or changing approved ownership', () => {
  const result = overlayRawProductCatalog(baseCatalog(), { records:[
    {
      sku:'7GTPD013AB', origin:'KH', unitsPerCarton:100, cartonsPerPallet:42,
      cartonDimensionsCm:[50, 40, 30], grossWeightLb:21,
      sourceSheet:'2026', sourceRow:70,
    },
    {
      sku:'7NEWSKU01', origin:'KH', unitsPerCarton:50, cartonsPerPallet:42,
      cartonDimensionsCm:[50, 40, 30], grossWeightLb:17,
      sourceSheet:'2026', sourceRow:71,
    },
  ] }, { catalogVersion:'2026-08-28.4' });

  const approved = result.catalog.orderSkuAliases.find(item => item.orderSku === '7GTPD013AB');
  const unmapped = result.catalog.orderSkuAliases.find(item => item.orderSku === '7NEWSKU01');
  assert.equal(approved.canonicalProductSku, 'GTP01');
  assert.equal(approved.lifecycle, 'approved');
  assert.equal(approved.packagingVersions.at(-1).unitsPerCarton, 100);
  assert.equal(approved.newOrderPackagingDefaultVersion, '2026-08-28.4');
  assert.equal(unmapped.canonicalProductSku, null);
  assert.equal(unmapped.lifecycle, 'unmapped-legacy');
  assert.equal(unmapped.newOrderPackagingDefaultVersion, '2026-08-28.4');
  assert.equal(result.stats.updatedAliases, 1);
  assert.equal(result.stats.addedAliases, 1);
});

test('sparse raw facts preserve known values while clearFields is explicit', () => {
  const sparse = overlayRawProductCatalog(baseCatalog(), { records:[{
    sku:'GTP01',
    unitsPerCarton:100,
    cartonsPerPallet:null,
    cartonDimensionsCm:null,
    grossWeightLb:null,
    sourceSheet:'2026',
    sourceRow:80,
  }] }, { catalogVersion:'2026-08-28.4' });
  const sparseProduct = sparse.catalog.products.find(product => product.productSku === 'GTP01');
  const sparseDefault = sparseProduct.packagingVersions.find(packaging => packaging.version === sparseProduct.newOrderPackagingDefaultVersion);
  assert.equal(sparseDefault.unitsPerCarton, 100);
  assert.equal(sparseDefault.cartonsPerPallet, 42);
  assert.deepEqual(sparseDefault.cartonDimensionsCm, [50, 40, 30]);
  assert.equal(sparseDefault.grossWeightLb, 25);

  const cleared = overlayRawProductCatalog(baseCatalog(), { records:[{
    sku:'GTP01',
    clearFields:['grossWeightLb'],
    sourceSheet:'2026',
    sourceRow:81,
  }] }, { catalogVersion:'2026-08-28.4' });
  const clearedProduct = cleared.catalog.products.find(product => product.productSku === 'GTP01');
  const clearedDefault = clearedProduct.packagingVersions.find(packaging => packaging.version === clearedProduct.newOrderPackagingDefaultVersion);
  assert.equal(clearedDefault.grossWeightLb, null);
  assert.equal(clearedDefault.unitsPerCarton, 90);
  assert.equal(clearedProduct.packagingVersions[0].grossWeightLb, 25, 'explicit clear creates history instead of rewriting it');
});

test('reimporting the same rounded FBA weight is idempotent and creates no version-only churn', () => {
  const result = overlayRawProductCatalog(baseCatalog(), { records:[{
    sku:'GTP01', origin:'VN', unitsPerCarton:90, cartonsPerPallet:42,
    cartonDimensionsCm:[50, 40, 30], grossWeightLb:25.49,
    sourceSheet:'AMZ 所有SKU', sourceRow:99,
  }] }, { catalogVersion:'2026-08-28.4' });
  const product = result.catalog.products.find(item => item.productSku === 'GTP01');

  assert.equal(result.stats.updatedProducts, 0);
  assert.equal(product.newOrderPackagingDefaultVersion, '2026-08-25');
  assert.equal(product.packagingVersions.length, 1);
  assert.equal(product.packagingVersions[0].grossWeightLb, 25);
});

test('a correction appends a new version and refuses to rewrite a released version id', () => {
  const first = overlayRawProductCatalog(baseCatalog(), { records:[{
    sku:'GTP01', unitsPerCarton:100, sourceSheet:'2026', sourceRow:90,
  }] }, { catalogVersion:'2026-08-28.4' });
  const original = structuredClone(first.catalog.products.find(product => product.productSku === 'GTP01').packagingVersions[0]);
  const correction = overlayRawProductCatalog(first.catalog, { records:[{
    sku:'GTP01', unitsPerCarton:96, sourceSheet:'2026', sourceRow:91,
  }] }, { catalogVersion:'2026-08-28.5', effectiveFrom:'2026-08-28' });
  const corrected = correction.catalog.products.find(product => product.productSku === 'GTP01');
  assert.deepEqual(corrected.packagingVersions[0], original);
  assert.equal(corrected.packagingVersions.length, 3);
  assert.equal(corrected.newOrderPackagingDefaultVersion, '2026-08-28.5');

  assert.throws(
    () => overlayRawProductCatalog(first.catalog, { records:[{
      sku:'GTP01', unitsPerCarton:95, sourceSheet:'2026', sourceRow:92,
    }] }, { catalogVersion:'2026-08-28.4' }),
    /already a released immutable packaging version/,
  );
});
