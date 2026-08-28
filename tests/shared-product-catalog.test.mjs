import assert from 'node:assert/strict';
import test from 'node:test';

await import(`../shared/shared-product-catalog.js?test=${Date.now()}`);
const api = globalThis.JSPSharedProductCatalog;

function rawWorkbook() {
  const top = Array(23).fill('');
  const headers = Array(23).fill('');
  top[2] = '產地';
  top[4] = '包數/箱';
  top[17] = '紙箱規格';
  top[18] = '箱/棧板';
  top[21] = '每箱產品的毛重';
  headers[1] = 'SKU';
  headers[22] = 'GW (lb)';
  const newer = Array(23).fill('');
  const stale = Array(23).fill('');
  const added = Array(23).fill('');
  const alias = Array(23).fill('');
  newer[1] = 'GTP03'; newer[2] = '越南'; newer[4] = 100; newer[17] = '58.5*34.5*35'; newer[18] = 36; newer[22] = 26.46;
  stale[1] = 'GTP03'; stale[2] = '越南'; stale[4] = 90; stale[17] = '50*40*30'; stale[18] = 42; stale[22] = 24;
  added[1] = 'NEW01'; added[2] = '台灣'; added[4] = 24; added[17] = '48*38*28'; added[18] = 30; added[22] = 29;
  alias[1] = '7GTPD013AB'; alias[2] = '越南'; alias[4] = 90; alias[17] = '50*40*30'; alias[18] = 42; alias[22] = 25;
  return {
    SheetNames:['AMZ 所有SKU'],
    Sheets:{ 'AMZ 所有SKU':{ rows:[top, headers, newer, stale, added, alias] } },
  };
}

const xlsx = { utils:{ sheet_to_json:sheet => sheet.rows } };

test('raw workbook parser keeps the first complete duplicate and reads origin and pallet count', () => {
  const payload = api.createPayload(rawWorkbook(), xlsx, { sourceFile:'raw.xlsx', updatedAt:'2026-08-28T00:00:00Z' });
  const gtp03 = payload.records.find(record => record.sku === 'GTP03');

  assert.equal(payload.records.length, 3);
  assert.equal(payload.stats.duplicateConflicts, 1);
  assert.deepEqual(gtp03, {
    sku:'GTP03', origin:'VN', unitsPerCarton:100, cartonsPerPallet:36,
    cartonDimensionsCm:[58.5, 34.5, 35], grossWeightLb:26.46,
    sourceSheet:'AMZ 所有SKU', sourceRow:3,
  });
});

test('one browser payload overlays Supply, excludes 7-prefixed aliases, and persists safely', () => {
  const payload = api.createPayload(rawWorkbook(), xlsx, { sourceFile:'raw.xlsx', updatedAt:'2026-08-28T00:00:00Z' });
  const storage = new Map();
  const browserStorage = {
    getItem:key => storage.get(key) || null,
    setItem:(key, value) => storage.set(key, value),
    removeItem:key => storage.delete(key),
  };
  api.saveToStorage(payload, browserStorage);
  const restored = api.loadFromStorage(browserStorage);
  const products = [{
    productCode:'GTP03', productName:'Turkey Tendon', boxSize:'50*40*30',
    perCarton:90, perPack:null, perBox:null, perPallet:42, country:'VN',
  }];
  const result = api.applyToSupplyProducts(products, restored);

  assert.equal(result.updated, 1);
  assert.equal(result.added, 1);
  assert.equal(products.length, 2);
  assert.equal(products[0].productName, 'Turkey Tendon');
  assert.equal(products[0].perCarton, 100);
  assert.equal(products[0].perPallet, 36);
  assert.equal(products[0].boxSize, '58.5*34.5*35');
  assert.deepEqual(products[1], {
    productCode:'NEW01', productName:'NEW01', boxSize:'48*38*28',
    perCarton:24, perPack:null, perBox:null, perPallet:30, country:'TW',
  });
  assert.equal(products.some(product => product.productCode.startsWith('7')), false);
});

test('FBA overlay preserves built-in fields when the raw row leaves a value blank', () => {
  const payload = api.validatePayload({
    schemaVersion:1,
    sourceFile:'raw.xlsx',
    updatedAt:'2026-08-28T00:00:00Z',
    records:[{
      sku:'PARTIAL01', origin:'VN', unitsPerCarton:24, cartonsPerPallet:null,
      cartonDimensionsCm:null, grossWeightLb:null, sourceSheet:'2026', sourceRow:8,
    }],
  });
  const result = api.applyToFbaCatalog({
    PARTIAL01:{ units:20, length:20, width:16, height:12, weight:30, source:'內建' },
  }, payload);

  assert.deepEqual(result.catalog.PARTIAL01, {
    units:24, length:20, width:16, height:12, weight:30, source:'raw.xlsx · 2026',
  });
});
