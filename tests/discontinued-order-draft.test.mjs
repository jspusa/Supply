import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LEGACY_ORDER_DRAFT_STORAGE_KEY,
  ORDER_DRAFT_STORAGE_KEY,
  PREVIOUS_ORDER_DRAFT_STORAGE_KEY,
  applyOrderDraftCommand,
  createOrderDraft,
  loadOrderDraft,
  pinOrderDraftForExport,
  previewPackagingReassignment,
  projectOrderWorkbook,
  saveOrderDraft,
} from '../shared/order-draft-state.js';

const NOW = '2026-10-15T07:00:00.000Z';
const products = new Map(['ACA01', 'ATS01', 'ATR01', 'GTRL03', 'ACTIVE'].map(productSku => [
  productSku,
  {
    productCode:productSku, productName:productSku, country:'VN', packagingVersion:`${productSku}-v1`,
    perCarton:24, perPack:null, perBox:null, perPallet:40, boxSize:'50*40*30',
  },
]));
const approved = new Map([
  ['ATS01', ['7ATSD011AB']],
  ['ATR01', ['7ATRD013AB']],
  ['GTRL03', ['7GTRD037AB']],
]);
const context = {
  now:NOW,
  getProduct:sku => products.get(sku) || null,
  getApprovedOrderSkus:sku => approved.get(sku) || [],
};

function restrictedContext(...blockedSkus) {
  const blocked = new Set(blockedSkus);
  return { ...context, isDiscontinuedSku:sku => blocked.has(sku) };
}

function createMemoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem:key => values.get(key) ?? null,
    setItem:(key, value) => values.set(key, String(value)),
    removeItem:key => values.delete(key),
  };
}

function addRow(draft, productSku, options = {}) {
  const result = applyOrderDraftCommand(draft, {
    type:'upsert-row',
    row:{
      productSku,
      quantities:{ packages:960, cartons:40, orderDraft:960 },
      pallet:{ value:1, mode:'manual' },
      ...options,
    },
  }, context);
  assert.equal(result.ok, true);
  return result.draft;
}

test('new orders reject discontinued Product SKUs and approved Order SKUs, including Chewy', () => {
  const draft = createOrderDraft({ now:NOW });
  for (const [productSku, orderSku, blockedSku] of [
    [' aca01 ', 'aca01', 'ACA01'],
    ['ats01', '7atsd011ab', 'ATS01'],
    ['GTRL03', '7GTRD037AB', 'GTRL03'],
    ['ATR01', '7ATRD013AB', '7ATRD013AB'],
  ]) {
    const result = applyOrderDraftCommand(draft, {
      type:'upsert-row', row:{ productSku, orderSku, quantities:{ orderDraft:960 } },
    }, restrictedContext(blockedSku));
    assert.equal(result.ok, false);
    assert.equal(result.status, 'discontinued-sku');
    assert.strictEqual(result.draft, draft);
    assert.deepEqual(result.issue.blockedSkus, [blockedSku]);
  }
  assert.deepEqual(draft.rowsByProductSku, {});
});

test('an optional restriction does not infer SKU aliases or change unrelated products', () => {
  const draft = createOrderDraft({ now:NOW });
  for (const currentContext of [context, restrictedContext('ACA01')]) {
    const result = applyOrderDraftCommand(draft, {
      type:'upsert-row', row:{ productSku:'ACTIVE', quantities:{ orderDraft:960 } },
    }, currentContext);
    assert.equal(result.ok, true);
    assert.equal(projectOrderWorkbook(result.draft, currentContext).ok, true);
  }
  const allowedStandard = applyOrderDraftCommand(draft, {
    type:'upsert-row', row:{ productSku:'ATR01', orderSku:'ATR01' },
  }, restrictedContext('7ATRD013AB'));
  assert.equal(allowedStandard.ok, true, 'an alias restriction alone does not guess restrictions on its owner');
});

test('changing quantities, refreshing recommendations, and switching Order SKU cannot bypass restrictions', () => {
  const draft = addRow(createOrderDraft({ now:NOW }), 'ATS01', { pinPackaging:true });
  const before = structuredClone(draft);
  for (const command of [
    { type:'upsert-row', row:{ productSku:'ATS01', quantities:{ orderDraft:1920 } } },
    { type:'patch-row', productSku:'ATS01', patch:{ quantities:{ orderDraft:1920 } } },
    { type:'switch-order-sku', productSku:'ATS01', orderSku:'7ATSD011AB' },
    { type:'reassign-packaging', productSku:'ATS01', orderSku:'7ATSD011AB' },
  ]) {
    const result = applyOrderDraftCommand(draft, command, restrictedContext('ATS01'));
    assert.equal(result.ok, false);
    assert.equal(result.status, 'discontinued-sku');
    assert.strictEqual(result.draft, draft);
  }
  const blockedAlias = previewPackagingReassignment(draft, {
    productSku:'ATS01', orderSku:'7ATSD011AB',
  }, restrictedContext('7ATSD011AB'));
  assert.equal(blockedAlias.ok, false);
  assert.equal(blockedAlias.status, 'discontinued-sku');
  assert.deepEqual(draft, before);
});

for (const pinned of [false, true]) {
  test(`restored ${pinned ? 'pinned' : 'untouched'} discontinued rows retain their quantities but cannot export`, () => {
    let draft = addRow(createOrderDraft({ now:NOW }), 'ACA01', { pinPackaging:pinned });
    draft = addRow(draft, 'ACTIVE');
    const original = JSON.stringify(draft);
    const storage = createMemoryStorage({ [ORDER_DRAFT_STORAGE_KEY]:original });
    const policy = restrictedContext('ACA01');
    const loaded = loadOrderDraft({ storage, context:policy });
    assert.equal(loaded.ok, true);
    assert.equal(loaded.status, 'repair-required');
    assert.deepEqual(loaded.draft.repairOrder, ['ACA01']);
    assert.deepEqual(loaded.draft.groupOrder.vietnam, ['ACTIVE']);
    const retained = loaded.draft.rowsByProductSku.ACA01;
    assert.equal(retained.orderGroup, null);
    assert.deepEqual(retained.quantities, draft.rowsByProductSku.ACA01.quantities);
    assert.deepEqual(retained.packagingAssignment, draft.rowsByProductSku.ACA01.packagingAssignment);
    assert.ok(retained.issues.some(issue => issue.code === 'DISCONTINUED_SKU'));
    assert.equal(storage.getItem(ORDER_DRAFT_STORAGE_KEY), original, 'loading must not overwrite the saved draft');
    assert.equal(projectOrderWorkbook(loaded.draft, policy).ok, false);
    assert.equal(saveOrderDraft({ storage, draft:loaded.draft, context:policy }).ok, true);

    const removed = applyOrderDraftCommand(loaded.draft, { type:'remove-row', productSku:'ACA01' }, policy);
    assert.equal(removed.ok, true);
    const workbook = projectOrderWorkbook(removed.draft, policy);
    assert.equal(workbook.ok, true);
    assert.deepEqual(workbook.sheets.flatMap(sheet => sheet.rows.map(row => row[1])), ['ACTIVE']);
  });
}

test('an existing pinned alias-only draft is blocked before export and on restore', () => {
  const draft = addRow(createOrderDraft({ now:NOW }), 'ATR01', { orderSku:'7ATRD013AB', pinPackaging:true });
  const policy = restrictedContext('7ATRD013AB');
  const before = structuredClone(draft);
  assert.equal(pinOrderDraftForExport(draft, policy).ok, false);
  const exported = projectOrderWorkbook(draft, policy);
  assert.equal(exported.ok, false);
  assert.deepEqual(exported.sheets, []);
  assert.deepEqual(draft, before);
  const storage = createMemoryStorage({ [ORDER_DRAFT_STORAGE_KEY]:JSON.stringify(draft) });
  const loaded = loadOrderDraft({ storage, context:policy });
  assert.equal(loaded.ok, true);
  assert.deepEqual(loaded.draft.repairOrder, ['ATR01']);
  assert.equal(loaded.draft.rowsByProductSku.ATR01.orderSku, '7ATRD013AB');
});

test('v2 draft migration preserves discontinued rows in the repair list', () => {
  const draft = addRow(createOrderDraft({ now:NOW }), 'ACA01');
  draft.schemaVersion = 2;
  delete draft.rowsByProductSku.ACA01.packagingAssignment;
  const original = JSON.stringify(draft);
  const storage = createMemoryStorage({ [PREVIOUS_ORDER_DRAFT_STORAGE_KEY]:original });
  const policy = restrictedContext('ACA01');
  const loaded = loadOrderDraft({ storage, context:policy });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.status, 'migrated');
  assert.deepEqual(loaded.draft.repairOrder, ['ACA01']);
  assert.equal(loaded.draft.rowsByProductSku.ACA01.quantities.orderDraft, 960);
  assert.ok(loaded.issues.some(issue => issue.code === 'DISCONTINUED_SKU'));
  assert.equal(projectOrderWorkbook(loaded.draft, policy).ok, false);
  assert.equal(saveOrderDraft({ storage, draft:loaded.draft, context:policy }).ok, true);
});

test('legacy draft migration retains Chewy alias quantities with a discontinued reason', () => {
  const legacy = { VN:{ savedAt:NOW, rows:[{
    product:'ATR01', orderCode:'7ATRD013AB', quantity:960, cartons:40,
    pallets:1, orderDraftQuantity:960, locked:true,
  }] } };
  const storage = createMemoryStorage({ [LEGACY_ORDER_DRAFT_STORAGE_KEY]:JSON.stringify(legacy) });
  const policy = restrictedContext('7ATRD013AB');
  const loaded = loadOrderDraft({ storage, context:policy });
  assert.equal(loaded.ok, true);
  assert.equal(loaded.status, 'migrated');
  assert.deepEqual(loaded.draft.repairOrder, ['ATR01']);
  const row = loaded.draft.rowsByProductSku.ATR01;
  assert.equal(row.orderSku, '7ATRD013AB');
  assert.equal(row.quantities.orderDraft, 960);
  assert.equal(row.locked, true);
  assert.ok(row.issues.some(issue => issue.code === 'DISCONTINUED_SKU'));
  assert.equal(row.issues.some(issue => issue.code === 'UNAPPROVED_ORDER_SKU'), false);
  assert.equal(projectOrderWorkbook(loaded.draft, policy).ok, false);
  assert.equal(saveOrderDraft({ storage, draft:loaded.draft, context:policy }).ok, true);
});

test('a restriction lookup failure blocks ordering and export without erasing saved quantities', () => {
  const draft = addRow(createOrderDraft({ now:NOW }), 'ACTIVE', { pinPackaging:true });
  const policy = { ...context, isDiscontinuedSku:() => { throw new Error('restriction unavailable'); } };
  const added = applyOrderDraftCommand(draft, { type:'upsert-row', row:{ productSku:'ACA01' } }, policy);
  assert.equal(added.ok, false);
  assert.equal(added.status, 'validation-unavailable');
  assert.equal(projectOrderWorkbook(draft, policy).ok, false);
  assert.equal(draft.rowsByProductSku.ACTIVE.quantities.orderDraft, 960);
});
