import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LEGACY_ORDER_DRAFT_STORAGE_KEY,
  ORDER_DRAFT_SCHEMA_VERSION,
  ORDER_DRAFT_STORAGE_KEY,
  PREVIOUS_ORDER_DRAFT_STORAGE_KEY,
  ORDER_EXPORT_HEADERS,
  ORDER_GROUP_IDS,
  applyOrderDraftCommand,
  countOrderDraftRepairItems,
  createOrderDraft,
  getOrderGroupRows,
  getPackagingAssignmentStatus,
  loadOrderDraft,
  previewPackagingReassignment,
  projectOrderWorkbook,
  resolveOrderDraftRowPackaging,
  saveOrderDraft,
} from '../shared/order-draft-state.js';

const NOW = '2026-08-28T03:00:00.000Z';
const catalog = new Map([
  ['TW-01', { productCode:'TW-01', productName:'Taiwan item', country:'TW', packagingVersion:'TW-01-v1', perCarton:10, perPack:null, perBox:null, perPallet:40, boxSize:'50*40*30' }],
  ['VN-01', { productCode:'VN-01', productName:'Vietnam item', country:'VN', packagingVersion:'VN-01-v1', perCarton:8, perPack:3, perBox:null, perPallet:42, boxSize:'50*40*30' }],
  ['VN-02', { productCode:'VN-02', productName:'Second Vietnam item', country:'VN', packagingVersion:'VN-02-v1', perCarton:12, perPack:null, perBox:null, perPallet:42, boxSize:'50*40*30' }],
  ['VN-03', { productCode:'VN-03', productName:'Third Vietnam item', country:'VN', packagingVersion:'VN-03-v1', perCarton:16, perPack:null, perBox:null, perPallet:42, boxSize:'50*40*30' }],
  ['VN-BOX', { productCode:'VN-BOX', productName:'Boxed Vietnam item', country:'VN', packagingVersion:'VN-BOX-v1', perCarton:8, perPack:null, perBox:6, perPallet:42, boxSize:'50*40*30' }],
  ['VN-FRAC-1', { productCode:'VN-FRAC-1', productName:'Fraction one', country:'VN', packagingVersion:'VN-FRAC-1-v1', perCarton:10, perPack:null, perBox:null, perPallet:30, boxSize:'50*40*30' }],
  ['VN-FRAC-2', { productCode:'VN-FRAC-2', productName:'Fraction two', country:'VN', packagingVersion:'VN-FRAC-2-v1', perCarton:10, perPack:null, perBox:null, perPallet:30, boxSize:'50*40*30' }],
]);
const approved = new Map([
  ['TW-01', ['7XX-TW-01']],
  ['VN-01', ['7AT-VN-01', '7GT-VN-01', '7VT-VN-01']],
  ['UNKNOWN-7', ['7Q-UNKNOWN-7']],
]);
const context = {
  now:NOW,
  getProduct:productSku => catalog.get(productSku) || null,
  getApprovedOrderSkus:productSku => approved.get(productSku) || [],
};

function createMemoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem:key => values.has(key) ? values.get(key) : null,
    setItem:(key, value) => values.set(key, String(value)),
    removeItem:key => values.delete(key),
    values,
  };
}

test('repair status counts each Product SKU once and truly global issues separately', () => {
  assert.equal(countOrderDraftRepairItems({
    issues:[
      { code:'MISSING_PRODUCT_CATALOG', productSku:'UNKNOWN-01' },
      { code:'UNAPPROVED_ORDER_SKU', productSku:'UNKNOWN-01' },
      { code:'MISSING_PRODUCT_CATALOG', productSku:'UNKNOWN-02' },
      { code:'STORAGE_WARNING' },
    ],
    repairOrder:['UNKNOWN-01', 'UNKNOWN-02'],
  }), 3);
});

test('Order Draft keeps one Product SKU while routing standard and approved 7-prefixed orders', () => {
  let draft = createOrderDraft({ now:NOW });
  assert.equal(draft.schemaVersion, ORDER_DRAFT_SCHEMA_VERSION);
  assert.deepEqual(Object.keys(draft.groupOrder), ORDER_GROUP_IDS);

  let result = applyOrderDraftCommand(draft, {
    type:'upsert-row',
    row:{ productSku:'vn-01', quantities:{ orderDraft:263.2 }, pallet:{ value:2.35, mode:'manual' }, locked:true },
  }, context);
  assert.equal(result.ok, true);
  draft = result.draft;
  assert.deepEqual(getOrderGroupRows(draft, 'vietnam').map(row => row.productSku), ['VN-01']);

  result = applyOrderDraftCommand(draft, {
    type:'switch-order-sku', productSku:'VN-01', orderSku:'7gt-vn-01',
  }, context);
  assert.equal(result.ok, true);
  draft = result.draft;
  assert.deepEqual(getOrderGroupRows(draft, 'vietnam'), []);
  assert.deepEqual(getOrderGroupRows(draft, 'subcontract').map(row => row.orderSku), ['7GT-VN-01']);
  assert.equal(Object.keys(draft.rowsByProductSku).length, 1);
  assert.equal(draft.rowsByProductSku['VN-01'].quantities.orderDraft, 263.2);
  assert.equal(draft.rowsByProductSku['VN-01'].pallet.value, 2.35);
  assert.equal(draft.rowsByProductSku['VN-01'].locked, true);
});

test('7AT, 7GT, 7VT, and another approved 7 prefix share one Subcontract group and switch back by catalog factory', () => {
  for (const orderSku of ['7AT-VN-01', '7GT-VN-01', '7VT-VN-01']) {
    let draft = applyOrderDraftCommand(createOrderDraft({ now:NOW }), {
      type:'upsert-row', row:{ productSku:'VN-01' },
    }, context).draft;
    draft = applyOrderDraftCommand(draft, {
      type:'switch-order-sku', productSku:'VN-01', orderSku,
    }, context).draft;
    assert.equal(draft.rowsByProductSku['VN-01'].orderGroup, 'subcontract');
    draft = applyOrderDraftCommand(draft, {
      type:'switch-order-sku', productSku:'VN-01', orderSku:'VN-01',
    }, context).draft;
    assert.equal(draft.rowsByProductSku['VN-01'].orderGroup, 'vietnam');
  }

  let taiwan = applyOrderDraftCommand(createOrderDraft({ now:NOW }), {
    type:'upsert-row', row:{ productSku:'TW-01' },
  }, context).draft;
  taiwan = applyOrderDraftCommand(taiwan, {
    type:'switch-order-sku', productSku:'TW-01', orderSku:'7XX-TW-01',
  }, context).draft;
  assert.equal(taiwan.rowsByProductSku['TW-01'].orderGroup, 'subcontract');
  taiwan = applyOrderDraftCommand(taiwan, {
    type:'switch-order-sku', productSku:'TW-01', orderSku:'TW-01',
  }, context).draft;
  assert.equal(taiwan.rowsByProductSku['TW-01'].orderGroup, 'taiwan');
});

test('reordering changes only the requested Order Group and rejects cross-group membership', () => {
  let draft = createOrderDraft({ now:NOW });
  for (const productSku of ['VN-01', 'TW-01', 'VN-02', 'VN-03']) {
    const result = applyOrderDraftCommand(draft, { type:'upsert-row', row:{ productSku } }, context);
    assert.equal(result.ok, true);
    draft = result.draft;
  }

  const reordered = applyOrderDraftCommand(draft, {
    type:'reorder-group', group:'vietnam', productSkus:['VN-03', 'VN-01', 'VN-02'],
  }, context);
  assert.equal(reordered.ok, true);
  assert.deepEqual(getOrderGroupRows(reordered.draft, 'vietnam').map(row => row.productSku), ['VN-03', 'VN-01', 'VN-02']);
  assert.deepEqual(getOrderGroupRows(reordered.draft, 'taiwan').map(row => row.productSku), ['TW-01']);

  const invalid = applyOrderDraftCommand(reordered.draft, {
    type:'reorder-group', group:'vietnam', productSkus:['VN-01', 'TW-01', 'VN-02'],
  }, context);
  assert.equal(invalid.ok, false);
  assert.equal(invalid.status, 'invalid-group-order');
  assert.strictEqual(invalid.draft, reordered.draft);

  const refreshed = applyOrderDraftCommand(reordered.draft, {
    type:'upsert-row', row:{ productSku:'VN-01', quantities:{ orderDraft:168 } },
  }, context);
  assert.equal(refreshed.ok, true);
  assert.deepEqual(
    getOrderGroupRows(refreshed.draft, 'vietnam').map(row => row.productSku),
    ['VN-03', 'VN-01', 'VN-02'],
    'updating an existing row inside the same group must preserve the dragged order',
  );
});

test('patch and remove preserve identity invariants while an unapproved purchasing code is rejected', () => {
  let draft = applyOrderDraftCommand(createOrderDraft({ now:NOW }), {
    type:'upsert-row', row:{ productSku:'TW-01', quantities:{ orderDraft:40 }, locked:false },
  }, context).draft;

  const patched = applyOrderDraftCommand(draft, {
    type:'patch-row',
    productSku:'TW-01',
    patch:{ quantities:{ orderDraft:55.5, cartons:5.55 }, pallet:{ value:0.14, mode:'fractional-exception' }, locked:true },
  }, context);
  assert.equal(patched.ok, true);
  assert.equal(patched.row.productSku, 'TW-01');
  assert.equal(patched.row.orderSku, 'TW-01');
  assert.deepEqual(patched.row.quantities, { orderDraft:55.5, cartons:5.55 });
  assert.deepEqual(patched.row.pallet, { value:0.14, mode:'fractional-exception' });
  assert.equal(patched.row.locked, true);

  const unapproved = applyOrderDraftCommand(patched.draft, {
    type:'switch-order-sku', productSku:'TW-01', orderSku:'7-NOT-APPROVED',
  }, context);
  assert.equal(unapproved.ok, false);
  assert.equal(unapproved.status, 'unapproved-order-sku');
  assert.strictEqual(unapproved.draft, patched.draft);

  const removed = applyOrderDraftCommand(patched.draft, {
    type:'remove-row', productSku:'TW-01',
  }, context);
  assert.equal(removed.ok, true);
  assert.deepEqual(getOrderGroupRows(removed.draft, 'taiwan'), []);
  assert.deepEqual(removed.draft.rowsByProductSku, {});
});

test('commands, save, load, legacy migration, and workbook export reject negative quantities or pallets', () => {
  const empty = createOrderDraft({ now:NOW });
  const negativeCommand = applyOrderDraftCommand(empty, {
    type:'upsert-row',
    row:{ productSku:'VN-01', quantities:{ cartons:-5 }, pallet:{ value:-1, mode:'manual' } },
  }, context);
  assert.deepEqual({ ok:negativeCommand.ok, status:negativeCommand.status }, { ok:false, status:'invalid-row' });
  assert.strictEqual(negativeCommand.draft, empty);
  assert.match(negativeCommand.error.message, /non-negative/);

  const valid = applyOrderDraftCommand(empty, {
    type:'upsert-row',
    row:{ productSku:'VN-01', quantities:{ orderDraft:112, cartons:14 }, pallet:{ value:1 / 3, mode:'manual' } },
  }, context).draft;
  const negative = structuredClone(valid);
  negative.rowsByProductSku['VN-01'].quantities.cartons = -5;
  negative.rowsByProductSku['VN-01'].pallet.value = -1;

  const rejectedSave = saveOrderDraft({ storage:createMemoryStorage(), draft:negative, context });
  assert.deepEqual({ ok:rejectedSave.ok, status:rejectedSave.status }, { ok:false, status:'invalid' });
  assert.match(rejectedSave.error.message, /non-negative/);

  const rejectedExport = projectOrderWorkbook(negative, context);
  assert.deepEqual({ ok:rejectedExport.ok, status:rejectedExport.status }, { ok:false, status:'invalid-draft' });
  assert.match(rejectedExport.issues[0].message, /non-negative/);

  const rejectedLoad = loadOrderDraft({
    storage:createMemoryStorage({ [ORDER_DRAFT_STORAGE_KEY]:JSON.stringify(negative) }),
    context,
  });
  assert.deepEqual({ ok:rejectedLoad.ok, status:rejectedLoad.status }, { ok:false, status:'corrupt' });
  assert.match(rejectedLoad.error.message, /non-negative/);

  const legacyNegative = loadOrderDraft({
    storage:createMemoryStorage({
      [LEGACY_ORDER_DRAFT_STORAGE_KEY]:JSON.stringify({
        VN:{ savedAt:NOW, rows:[{ product:'VN-01', quantity:'-5', pallets:'-1' }] },
      }),
    }),
    context,
  });
  assert.deepEqual({ ok:legacyNegative.ok, status:legacyNegative.status }, { ok:false, status:'corrupt' });
  assert.match(legacyNegative.error.message, /non-negative/);
});

test('versioned storage round-trip returns explicit saved and loaded outcomes', () => {
  const storage = createMemoryStorage();
  const draft = applyOrderDraftCommand(createOrderDraft({ now:NOW }), {
    type:'upsert-row',
    row:{ productSku:'VN-01', quantities:{ orderDraft:263.2 }, pallet:{ value:2.35, mode:'manual' } },
  }, context).draft;

  const saved = saveOrderDraft({ storage, draft, context });
  assert.deepEqual({ ok:saved.ok, status:saved.status }, { ok:true, status:'saved' });
  const loaded = loadOrderDraft({ storage, context });
  assert.deepEqual({ ok:loaded.ok, status:loaded.status, needsSave:loaded.needsSave }, { ok:true, status:'loaded', needsSave:false });
  assert.equal(loaded.draft.rowsByProductSku['VN-01'].quantities.orderDraft, 263.2);
  assert.equal(loaded.draft.rowsByProductSku['VN-01'].pallet.value, 2.35);
});

test('a saved v2 draft with the former Taiwan-first key order keeps all canonical group ids', () => {
  const draft = applyOrderDraftCommand(createOrderDraft({ now:NOW }), {
    type:'upsert-row',
    row:{ productSku:'VN-01', quantities:{ orderDraft:112 }, pallet:{ value:1 / 3, mode:'manual' } },
  }, context).draft;
  const legacyKeyOrder = {
    ...draft,
    groupOrder:{ taiwan:[], vietnam:['VN-01'], subcontract:[] },
  };
  const loaded = loadOrderDraft({
    storage:createMemoryStorage({ [ORDER_DRAFT_STORAGE_KEY]:JSON.stringify(legacyKeyOrder) }),
    context,
  });

  assert.deepEqual({ ok:loaded.ok, status:loaded.status }, { ok:true, status:'loaded' });
  assert.deepEqual(getOrderGroupRows(loaded.draft, 'vietnam').map(row => row.productSku), ['VN-01']);
  assert.deepEqual(getOrderGroupRows(loaded.draft, 'taiwan'), []);
  assert.deepEqual(getOrderGroupRows(loaded.draft, 'subcontract'), []);
});

test('legacy VN/TW/Others drafts migrate without rounding fractional pallets or dropping unknown catalog rows', () => {
  const legacy = {
    VN:{
      savedAt:'2026-08-27T02:00:00.000Z',
      rows:[
        { product:'VN-01', orderCode:'7AT-VN-01', quantity:'789.6', units:'263.2', cartons:'98.7', pallets:'2.35', orderDraftQuantity:'263.2', strategy:'fractional-exception', locked:true },
        { product:'UNKNOWN-VN', orderCode:'UNKNOWN-VN', quantity:'12.5', cartons:'1.25', pallets:'0.25' },
      ],
    },
    TW:{ savedAt:'2026-08-27T01:00:00.000Z', rows:[{ product:'TW-01', quantity:'40', cartons:'4', pallets:'0.1' }] },
    Others:{
      savedAt:'2026-08-27T03:00:00.000Z',
      rows:[
        { product:'UNKNOWN-7', orderCode:'7Q-UNKNOWN-7', quantity:'18.75', pallets:'0.75' },
        { product:'UNKNOWN-OTHER', orderCode:'UNKNOWN-OTHER', quantity:'9.5', pallets:'1.75' },
      ],
    },
  };
  const storage = createMemoryStorage({ [LEGACY_ORDER_DRAFT_STORAGE_KEY]:JSON.stringify(legacy) });
  const loaded = loadOrderDraft({ storage, context });

  assert.deepEqual({ ok:loaded.ok, status:loaded.status, needsSave:loaded.needsSave }, { ok:true, status:'migrated', needsSave:true });
  assert.equal(Object.keys(loaded.draft.rowsByProductSku).length, 5);
  const migrated = loaded.draft.rowsByProductSku['VN-01'];
  assert.equal(migrated.orderGroup, 'subcontract');
  assert.equal(migrated.quantities.packages, 789.6);
  assert.equal(migrated.quantities.secondary, 263.2);
  assert.equal(migrated.quantities.orderDraft, 263.2);
  assert.equal(migrated.pallet.value, 2.35);
  assert.equal(migrated.pallet.mode, 'fractional-exception');
  assert.equal(migrated.locked, true);
  assert.equal(loaded.draft.rowsByProductSku['UNKNOWN-VN'].orderGroup, null);
  assert.ok(loaded.draft.rowsByProductSku['UNKNOWN-VN'].issues.some(issue => issue.code === 'MISSING_PRODUCT_CATALOG'));
  assert.equal(loaded.draft.rowsByProductSku['UNKNOWN-7'].orderGroup, null);
  assert.deepEqual(loaded.draft.repairOrder, ['UNKNOWN-VN', 'UNKNOWN-7', 'UNKNOWN-OTHER']);
  assert.equal(loaded.draft.rowsByProductSku['UNKNOWN-OTHER'].pallet.value, 1.75);
});

test('unknown catalog repair rows remain reported after migrate, save, and a second load without duplication', () => {
  const storage = createMemoryStorage({
    [LEGACY_ORDER_DRAFT_STORAGE_KEY]:JSON.stringify({
      VN:{ savedAt:NOW, rows:[{
        product:'UNKNOWN-VN', orderCode:'UNKNOWN-VN', quantity:'12.5', cartons:'1.25', pallets:'0.3333333333333333',
      }] },
    }),
  });
  const migrated = loadOrderDraft({ storage, context });
  assert.equal(migrated.status, 'migrated');
  assert.deepEqual(migrated.draft.repairOrder, ['UNKNOWN-VN']);
  assert.deepEqual(migrated.issues.map(issue => issue.code), ['MISSING_PRODUCT_CATALOG']);

  const saved = saveOrderDraft({ storage, draft:migrated.draft, context });
  assert.deepEqual({ ok:saved.ok, status:saved.status }, { ok:true, status:'saved-with-repairs' });
  assert.deepEqual(saved.issues.map(issue => issue.code), ['MISSING_PRODUCT_CATALOG']);

  const secondLoad = loadOrderDraft({ storage, context });
  assert.deepEqual({ ok:secondLoad.ok, status:secondLoad.status }, { ok:true, status:'repair-required' });
  assert.deepEqual(secondLoad.draft.repairOrder, ['UNKNOWN-VN']);
  assert.deepEqual(secondLoad.issues.map(issue => issue.code), ['MISSING_PRODUCT_CATALOG']);
  assert.deepEqual(secondLoad.draft.rowsByProductSku['UNKNOWN-VN'].issues.map(issue => issue.code), ['MISSING_PRODUCT_CATALOG']);
});

test('storage failures, corrupt JSON, and future schemas never report a saved or loaded state', () => {
  const quotaError = Object.assign(new Error('full'), { name:'QuotaExceededError' });
  const quota = saveOrderDraft({
    storage:{ setItem() { throw quotaError; } },
    draft:createOrderDraft({ now:NOW }),
  });
  assert.deepEqual({ ok:quota.ok, status:quota.status }, { ok:false, status:'quota' });

  const deniedError = Object.assign(new Error('blocked'), { name:'SecurityError' });
  const denied = loadOrderDraft({ storage:{ getItem() { throw deniedError; } }, context });
  assert.deepEqual({ ok:denied.ok, status:denied.status, needsSave:denied.needsSave }, { ok:false, status:'denied', needsSave:false });

  const corrupt = loadOrderDraft({ storage:createMemoryStorage({ [ORDER_DRAFT_STORAGE_KEY]:'{not json' }), context });
  assert.deepEqual({ ok:corrupt.ok, status:corrupt.status }, { ok:false, status:'corrupt' });

  const future = loadOrderDraft({
    storage:createMemoryStorage({ [ORDER_DRAFT_STORAGE_KEY]:JSON.stringify({ schemaVersion:99 }) }),
    context,
  });
  assert.deepEqual({ ok:future.ok, status:future.status, needsSave:future.needsSave }, { ok:false, status:'unsupported', needsSave:false });

  const futureSave = saveOrderDraft({ storage:createMemoryStorage(), draft:{ schemaVersion:99 } });
  assert.deepEqual({ ok:futureSave.ok, status:futureSave.status }, { ok:false, status:'unsupported' });

  const invalid = saveOrderDraft({ storage:createMemoryStorage(), draft:{ schemaVersion:2 } });
  assert.deepEqual({ ok:invalid.ok, status:invalid.status }, { ok:false, status:'invalid' });

  const misrouted = applyOrderDraftCommand(createOrderDraft({ now:NOW }), {
    type:'upsert-row', row:{ productSku:'VN-01' },
  }, context).draft;
  misrouted.rowsByProductSku['VN-01'].orderSku = '7AT-VN-01';
  const misroutedSave = saveOrderDraft({ storage:createMemoryStorage(), draft:misrouted, context });
  assert.deepEqual({ ok:misroutedSave.ok, status:misroutedSave.status }, { ok:false, status:'invalid' });
});

test('persisted and projected alternate Order SKUs must still be approved for their Product SKU', () => {
  let approvedDraft = applyOrderDraftCommand(createOrderDraft({ now:NOW }), {
    type:'upsert-row', row:{ productSku:'VN-01', quantities:{ orderDraft:112 }, pallet:{ value:1 / 3, mode:'manual' } },
  }, context).draft;
  approvedDraft = applyOrderDraftCommand(approvedDraft, {
    type:'switch-order-sku', productSku:'VN-01', orderSku:'7AT-VN-01',
  }, context).draft;
  assert.equal(saveOrderDraft({ storage:createMemoryStorage(), draft:approvedDraft, context }).ok, true);
  assert.equal(projectOrderWorkbook(approvedDraft, context).ok, true);

  const unapprovedDraft = structuredClone(approvedDraft);
  unapprovedDraft.rowsByProductSku['VN-01'].orderSku = '7UNAPPROVED';
  unapprovedDraft.rowsByProductSku['VN-01'].packagingAssignment = null;
  const rejectedSave = saveOrderDraft({ storage:createMemoryStorage(), draft:unapprovedDraft, context });
  assert.deepEqual({ ok:rejectedSave.ok, status:rejectedSave.status }, { ok:false, status:'invalid' });
  assert.ok(rejectedSave.issues.some(issue => issue.code === 'UNAPPROVED_ORDER_SKU'));

  const loaded = loadOrderDraft({
    storage:createMemoryStorage({ [ORDER_DRAFT_STORAGE_KEY]:JSON.stringify(unapprovedDraft) }),
    context,
  });
  assert.deepEqual({ ok:loaded.ok, status:loaded.status, needsSave:loaded.needsSave }, { ok:true, status:'repair-required', needsSave:false });
  assert.equal(loaded.draft.rowsByProductSku['VN-01'].orderSku, '7UNAPPROVED');
  assert.equal(loaded.draft.rowsByProductSku['VN-01'].orderGroup, null);
  assert.deepEqual(loaded.draft.repairOrder, ['VN-01']);
  assert.ok(loaded.draft.rowsByProductSku['VN-01'].issues.some(issue => issue.code === 'UNAPPROVED_ORDER_SKU'));

  const projected = projectOrderWorkbook(unapprovedDraft, context);
  assert.deepEqual({ ok:projected.ok, status:projected.status }, { ok:false, status:'repair-required' });
  assert.deepEqual(projected.sheets, []);
  assert.ok(projected.issues.some(issue => issue.rowIssues?.some(rowIssue => rowIssue.code === 'UNAPPROVED_ORDER_SKU')));

  const missingApprovalAdapter = projectOrderWorkbook(approvedDraft, { getProduct:context.getProduct });
  assert.equal(missingApprovalAdapter.ok, true, 'pinned historical assignments do not require a current alias approval lookup');

  const missingSaveContext = saveOrderDraft({ storage:createMemoryStorage(), draft:approvedDraft });
  assert.deepEqual({ ok:missingSaveContext.ok, status:missingSaveContext.status }, { ok:true, status:'saved-with-warnings' });
});

test('v3 storage rejects drafts missing required row state or valid timestamps', () => {
  const incomplete = {
    schemaVersion:ORDER_DRAFT_SCHEMA_VERSION,
    createdAt:NOW,
    updatedAt:NOW,
    rowsByProductSku:{
      'VN-01':{
        productSku:'VN-01',
        orderSku:'VN-01',
        standardFactory:'vietnam',
        orderGroup:'vietnam',
        issues:[],
      },
    },
    groupOrder:{ taiwan:[], vietnam:['VN-01'], subcontract:[] },
    repairOrder:[],
    issues:[],
  };
  const rejectedSave = saveOrderDraft({ storage:createMemoryStorage(), draft:incomplete, context });
  assert.deepEqual({ ok:rejectedSave.ok, status:rejectedSave.status }, { ok:false, status:'invalid' });
  assert.match(rejectedSave.error.message, /quantities/);

  const rejectedLoad = loadOrderDraft({
    storage:createMemoryStorage({ [ORDER_DRAFT_STORAGE_KEY]:JSON.stringify(incomplete) }),
    context,
  });
  assert.deepEqual({ ok:rejectedLoad.ok, status:rejectedLoad.status }, { ok:false, status:'corrupt' });

  const invalidTimestamp = applyOrderDraftCommand(createOrderDraft({ now:NOW }), {
    type:'upsert-row', row:{ productSku:'VN-01' },
  }, context).draft;
  invalidTimestamp.rowsByProductSku['VN-01'].updatedAt = 'not-a-date';
  const rejectedTimestamp = saveOrderDraft({ storage:createMemoryStorage(), draft:invalidTimestamp, context });
  assert.deepEqual({ ok:rejectedTimestamp.ok, status:rejectedTimestamp.status }, { ok:false, status:'invalid' });
  assert.match(rejectedTimestamp.error.message, /updatedAt/);
});

test('untouched suggestions follow the current default until an edit pins one immutable Packaging Assignment', () => {
  let currentPackaging = {
    orderSku:'TW-01', canonicalProductSku:'TW-01', packagingVersion:'pack-v1',
    perCarton:10, perPack:null, perBox:null, perPallet:40, boxSize:'50*40*30',
  };
  const mutableContext = {
    ...context,
    catalogVersion:'catalog-v1',
    getOrderSkuPackaging:() => currentPackaging,
  };
  let draft = applyOrderDraftCommand(createOrderDraft({ now:NOW }), {
    type:'upsert-row',
    row:{ productSku:'TW-01', quantities:{ orderDraft:80 }, pallet:{ value:0.2, mode:'derived' } },
  }, mutableContext).draft;
  assert.equal(draft.rowsByProductSku['TW-01'].packagingAssignment, null);
  assert.equal(resolveOrderDraftRowPackaging(draft.rowsByProductSku['TW-01'], mutableContext).packagingVersion, 'pack-v1');

  currentPackaging = { ...currentPackaging, packagingVersion:'pack-v2', perCarton:20 };
  assert.equal(resolveOrderDraftRowPackaging(draft.rowsByProductSku['TW-01'], mutableContext).packagingVersion, 'pack-v2');
  const patched = applyOrderDraftCommand(draft, {
    type:'patch-row', productSku:'TW-01', patch:{ quantities:{ orderDraft:90 } },
  }, mutableContext);
  assert.equal(patched.ok, true);
  draft = patched.draft;
  assert.deepEqual({
    state:draft.rowsByProductSku['TW-01'].packagingAssignment.state,
    version:draft.rowsByProductSku['TW-01'].packagingAssignment.packagingVersion,
    perCarton:draft.rowsByProductSku['TW-01'].packagingAssignment.perCarton,
  }, { state:'pinned', version:'pack-v2', perCarton:20 });

  currentPackaging = { ...currentPackaging, packagingVersion:'pack-v3', perCarton:30 };
  const status = getPackagingAssignmentStatus(draft.rowsByProductSku['TW-01'], mutableContext);
  assert.deepEqual({
    state:status.state,
    assignedVersion:status.assignedVersion,
    currentVersion:status.currentVersion,
    newerAvailable:status.newerAvailable,
  }, { state:'pinned', assignedVersion:'pack-v2', currentVersion:'pack-v3', newerAvailable:true });
  assert.equal(resolveOrderDraftRowPackaging(draft.rowsByProductSku['TW-01'], mutableContext).perCarton, 20);

  const secondEdit = applyOrderDraftCommand(draft, {
    type:'patch-row', productSku:'TW-01', patch:{ pallet:{ value:0.25 } },
  }, mutableContext);
  assert.equal(secondEdit.row.packagingAssignment.packagingVersion, 'pack-v2');
});

test('export pins once and every workbook calculation uses the saved assignment without re-querying current packaging', () => {
  let packagingReads = 0;
  const changingContext = {
    ...context,
    getOrderSkuPackaging(orderSku) {
      packagingReads += 1;
      return {
        orderSku,
        canonicalProductSku:'TW-01',
        packagingVersion:`pack-v${packagingReads}`,
        perCarton:packagingReads === 1 ? 10 : 25,
        perPack:null,
        perBox:null,
        perPallet:packagingReads === 1 ? 40 : 20,
        boxSize:packagingReads === 1 ? '50*40*30' : '60*50*40',
      };
    },
  };
  const floating = applyOrderDraftCommand(createOrderDraft({ now:NOW }), {
    type:'upsert-row',
    row:{ productSku:'TW-01', quantities:{ orderDraft:80 }, pallet:{ value:99, mode:'manual' } },
  }, changingContext).draft;
  const first = projectOrderWorkbook(floating, changingContext);
  assert.equal(first.ok, true);
  assert.equal(packagingReads, 1);
  assert.deepEqual(first.pinnedProductSkus, ['TW-01']);
  assert.equal(first.draft.rowsByProductSku['TW-01'].packagingAssignment.packagingVersion, 'pack-v1');
  assert.deepEqual(first.sheets[0].rows[0], [1, 'TW-01', 'Taiwan item', 10, '單包', 8, '箱', 0.2, '棧板', '50*40*30']);

  const second = projectOrderWorkbook(first.draft, changingContext);
  assert.equal(second.ok, true);
  assert.equal(packagingReads, 1, 'pinned export must not ask for the current Packaging Default again');
  assert.deepEqual(second.sheets[0].rows, first.sheets[0].rows);
});

test('Packaging Reassignment previews alias-owned cartons, pallets, coverage, and routing before confirmation', () => {
  const packagingByOrderSku = new Map([
    ['VN-01', {
      orderSku:'VN-01', canonicalProductSku:'VN-01', packagingVersion:'product-v1',
      perCarton:8, perPack:3, perBox:null, perPallet:42, boxSize:'50*40*30',
    }],
    ['7AT-VN-01', {
      orderSku:'7AT-VN-01', canonicalProductSku:'VN-01', packagingVersion:'alias-v7',
      perCarton:25, perPack:2, perBox:null, perPallet:10, boxSize:'60*50*40',
    }],
  ]);
  const coverageCalls = [];
  const aliasContext = {
    ...context,
    getOrderSkuPackaging:orderSku => packagingByOrderSku.get(orderSku) || null,
    getCoverageDays(productSku, orderDraftQuantity) {
      coverageCalls.push({ productSku, orderDraftQuantity });
      return orderDraftQuantity / 2;
    },
  };
  let draft = applyOrderDraftCommand(createOrderDraft({ now:NOW }), {
    type:'upsert-row',
    row:{ productSku:'VN-01', quantities:{ orderDraft:100 }, pallet:{ value:0.5, mode:'manual' } },
  }, aliasContext).draft;
  const preview = previewPackagingReassignment(draft, {
    productSku:'VN-01', orderSku:'7AT-VN-01',
  }, aliasContext);
  assert.equal(preview.ok, true);
  assert.deepEqual({
    beforeVersion:preview.before.packagingVersion,
    afterVersion:preview.after.packagingVersion,
    beforeCartons:preview.before.cartons,
    afterCartons:preview.after.cartons,
    beforePallets:preview.before.pallets,
    afterPallets:preview.after.pallets,
    beforeGroup:preview.before.orderGroup,
    afterGroup:preview.after.orderGroup,
    coverage:preview.after.coverageDays,
  }, {
    beforeVersion:'product-v1', afterVersion:'alias-v7',
    beforeCartons:37.5, afterCartons:8,
    beforePallets:100 / 112, afterPallets:0.8,
    beforeGroup:'vietnam', afterGroup:'subcontract', coverage:50,
  });
  assert.ok(coverageCalls.every(call => call.productSku === 'VN-01'), 'coverage must remain on Product SKU demand');

  const switched = applyOrderDraftCommand(draft, {
    type:'switch-order-sku',
    productSku:'VN-01',
    orderSku:'7AT-VN-01',
    expectedPackagingVersion:preview.after.packagingVersion,
  }, aliasContext);
  assert.equal(switched.ok, true);
  draft = switched.draft;
  assert.equal(switched.row.productSku, 'VN-01');
  assert.equal(switched.row.packagingAssignment.orderSku, '7AT-VN-01');
  assert.equal(switched.row.packagingAssignment.packagingVersion, 'alias-v7');
  assert.equal(switched.row.packagingAssignment.perCarton, 25);
  const projected = projectOrderWorkbook(draft, aliasContext);
  assert.deepEqual(projected.sheets.find(sheet => sheet.id === 'subcontract').rows[0], [
    1, '7AT-VN-01', 'Vietnam item', 25, '袋裝', 8, '箱', 0.8, '棧板', '60*50*40',
  ]);

  packagingByOrderSku.set('7AT-VN-01', {
    ...packagingByOrderSku.get('7AT-VN-01'), packagingVersion:'alias-v8',
  });
  const stale = applyOrderDraftCommand(draft, {
    type:'reassign-packaging',
    productSku:'VN-01',
    orderSku:'7AT-VN-01',
    expectedPackagingVersion:'alias-v7',
  }, aliasContext);
  assert.deepEqual({ ok:stale.ok, status:stale.status }, { ok:false, status:'packaging-preview-stale' });
  assert.strictEqual(stale.draft, draft);
});

test('v2 migration keeps ambiguous populated rows for one explicit batch review while empty rows float', () => {
  const v2 = {
    schemaVersion:2,
    createdAt:NOW,
    updatedAt:NOW,
    rowsByProductSku:{
      'TW-01':{
        productSku:'TW-01', orderSku:'TW-01', standardFactory:'taiwan', orderGroup:'taiwan',
        quantities:{ orderDraft:55.5, cartons:5.55 },
        pallet:{ value:0.14, mode:'manual' }, locked:true, createdAt:NOW, updatedAt:NOW, issues:[],
      },
      'VN-02':{
        productSku:'VN-02', orderSku:'VN-02', standardFactory:'vietnam', orderGroup:'vietnam',
        quantities:{ orderDraft:'', cartons:'' },
        pallet:{ value:null, mode:'derived' }, locked:false, createdAt:NOW, updatedAt:NOW, issues:[],
      },
      'VN-03':{
        productSku:'VN-03', orderSku:'VN-03', standardFactory:'vietnam', orderGroup:'vietnam',
        quantities:{ packages:672, cartons:42, orderDraft:672 },
        pallet:{
          value:1,
          mode:'whole-pallet',
          authoritativeField:'pallets',
          strategy:'whole-pallet',
        },
        locked:false, createdAt:NOW, updatedAt:NOW, issues:[],
      },
    },
    groupOrder:{ vietnam:['VN-02', 'VN-03'], taiwan:['TW-01'], subcontract:[] },
    repairOrder:[],
    issues:[],
  };
  const migrationContext = {
    ...context,
    catalogVersion:'catalog-v3',
    getOrderSkuPackaging(orderSku) {
      const product = catalog.get(orderSku);
      return product ? {
        orderSku,
        canonicalProductSku:orderSku,
        packagingVersion:`${orderSku}-current`,
        perCarton:product.perCarton,
        perPack:product.perPack,
        perBox:product.perBox,
        perPallet:product.perPallet,
        boxSize:product.boxSize,
      } : null;
    },
  };
  const storage = createMemoryStorage({ [PREVIOUS_ORDER_DRAFT_STORAGE_KEY]:JSON.stringify(v2) });
  const migrated = loadOrderDraft({ storage, context:migrationContext });
  assert.deepEqual({ ok:migrated.ok, status:migrated.status, needsSave:migrated.needsSave }, {
    ok:true, status:'migrated', needsSave:true,
  });
  const touched = migrated.draft.rowsByProductSku['TW-01'];
  assert.equal(touched.quantities.orderDraft, 55.5);
  assert.equal(touched.pallet.value, 0.14);
  assert.equal(touched.packagingAssignment.state, 'review-required');
  assert.ok(touched.issues.some(issue => issue.code === 'PACKAGING_ASSIGNMENT_REVIEW_REQUIRED'));
  assert.equal(migrated.draft.rowsByProductSku['VN-02'].packagingAssignment, null);
  assert.equal(migrated.draft.rowsByProductSku['VN-03'].packagingAssignment.state, 'review-required');
  assert.deepEqual(projectOrderWorkbook(migrated.draft, migrationContext).status, 'review-required');

  const saved = saveOrderDraft({ storage, draft:migrated.draft, context:migrationContext });
  assert.equal(saved.ok, true);
  assert.equal(storage.values.has(ORDER_DRAFT_STORAGE_KEY), true);
  assert.equal(storage.values.has(PREVIOUS_ORDER_DRAFT_STORAGE_KEY), false);

  const confirmed = applyOrderDraftCommand(migrated.draft, {
    type:'confirm-legacy-packaging-reviews',
  }, migrationContext);
  assert.equal(confirmed.ok, true);
  assert.deepEqual(confirmed.confirmedProductSkus, ['TW-01', 'VN-03']);
  assert.equal(confirmed.draft.rowsByProductSku['TW-01'].quantities.orderDraft, 55.5);
  assert.equal(confirmed.draft.rowsByProductSku['VN-03'].quantities.orderDraft, 672);
  assert.equal(confirmed.draft.rowsByProductSku['VN-03'].packagingAssignment.packagingVersion, 'VN-03-current');
  const exported = projectOrderWorkbook(confirmed.draft, migrationContext);
  assert.equal(exported.ok, true);
  assert.equal(exported.draft.rowsByProductSku['TW-01'].packagingAssignment.state, 'pinned');
  assert.equal(exported.draft.rowsByProductSku['VN-02'].packagingAssignment.state, 'pinned');
  assert.equal(exported.draft.rowsByProductSku['VN-03'].packagingAssignment.state, 'pinned');
});

test('loading v3 auto-pins version-only legacy changes and keeps a real packaging difference for review', () => {
  const reviewIssue = (productSku, packagingVersion = `${productSku}-v1`) => ({
    code:'PACKAGING_ASSIGNMENT_REVIEW_REQUIRED',
    productSku,
    orderSku:productSku,
    packagingVersion,
    advisory:true,
  });
  const assignment = (productSku, packagingVersion = `${productSku}-v1`) => ({
    state:'review-required',
    reason:'legacy-migration',
    assignedAt:NOW,
    orderSku:productSku,
    canonicalProductSku:productSku,
    packagingVersion,
    catalogVersion:null,
    perCarton:catalog.get(productSku).perCarton,
    perPack:catalog.get(productSku).perPack,
    perBox:catalog.get(productSku).perBox,
    perPallet:catalog.get(productSku).perPallet,
    boxSize:catalog.get(productSku).boxSize,
    productName:catalog.get(productSku).productName,
  });
  const priorBugDraft = {
    schemaVersion:ORDER_DRAFT_SCHEMA_VERSION,
    createdAt:NOW,
    updatedAt:NOW,
    rowsByProductSku:{
      'VN-03':{
        productSku:'VN-03', orderSku:'VN-03', standardFactory:'vietnam', orderGroup:'vietnam',
        quantities:{ packages:672, cartons:42, orderDraft:672 },
        pallet:{
          value:1,
          mode:'whole-pallet',
          authoritativeField:'pallets',
          strategy:'whole-pallet',
        },
        locked:false,
        packagingAssignment:assignment('VN-03'),
        createdAt:NOW,
        updatedAt:NOW,
        issues:[reviewIssue('VN-03')],
      },
      'TW-01':{
        productSku:'TW-01', orderSku:'TW-01', standardFactory:'taiwan', orderGroup:'taiwan',
        quantities:{ packages:55.5, cartons:5.55, orderDraft:55.5 },
        pallet:{ value:0.14, mode:'manual', authoritativeField:'pallets', strategy:'' },
        locked:false,
        packagingAssignment:{
          ...assignment('TW-01', 'TW-01-v0'),
          perCarton:catalog.get('TW-01').perCarton + 1,
        },
        createdAt:NOW,
        updatedAt:NOW,
        issues:[reviewIssue('TW-01', 'TW-01-v0')],
      },
    },
    groupOrder:{ vietnam:['VN-03'], taiwan:['TW-01'], subcontract:[] },
    repairOrder:[],
    issues:[],
  };
  const storage = createMemoryStorage({
    [ORDER_DRAFT_STORAGE_KEY]:JSON.stringify(priorBugDraft),
  });

  const loaded = loadOrderDraft({ storage, context });

  assert.equal(loaded.ok, true);
  assert.equal(loaded.status, 'loaded-with-warnings');
  assert.equal(loaded.needsSave, true);
  assert.equal(loaded.draft.rowsByProductSku['VN-03'].packagingAssignment.state, 'pinned');
  assert.equal(loaded.draft.rowsByProductSku['VN-03'].packagingAssignment.reason, 'legacy-identical-packaging');
  assert.equal(loaded.draft.rowsByProductSku['TW-01'].packagingAssignment.state, 'review-required');
  const beforeAssignments = structuredClone({
    planner:priorBugDraft.rowsByProductSku['VN-03'].packagingAssignment,
    manual:priorBugDraft.rowsByProductSku['TW-01'].packagingAssignment,
  });

  const confirmed = applyOrderDraftCommand(loaded.draft, {
    type:'confirm-legacy-packaging-reviews',
  }, context);

  assert.equal(confirmed.ok, true);
  assert.deepEqual(confirmed.confirmedProductSkus, ['TW-01']);
  assert.deepEqual(
    {
      ...confirmed.draft.rowsByProductSku['VN-03'].packagingAssignment,
      state:'review-required', reason:'legacy-migration', assignedAt:NOW,
    },
    beforeAssignments.planner,
  );
  assert.deepEqual(
    {
      ...confirmed.draft.rowsByProductSku['TW-01'].packagingAssignment,
      state:'review-required', reason:'legacy-migration', assignedAt:NOW,
    },
    beforeAssignments.manual,
  );
  assert.equal(confirmed.draft.rowsByProductSku['VN-03'].packagingAssignment.state, 'pinned');
  assert.equal(confirmed.draft.rowsByProductSku['TW-01'].packagingAssignment.state, 'pinned');
  assert.equal(confirmed.draft.rowsByProductSku['VN-03'].issues.length, 0);
  assert.equal(confirmed.draft.rowsByProductSku['TW-01'].issues.length, 0);

  const saved = saveOrderDraft({ storage, draft:confirmed.draft, context });
  assert.equal(saved.ok, true);
  const reloaded = loadOrderDraft({ storage, context });
  assert.equal(reloaded.needsSave, false);
  assert.equal(reloaded.draft.rowsByProductSku['VN-03'].packagingAssignment.state, 'pinned');
  assert.equal(reloaded.draft.rowsByProductSku['TW-01'].packagingAssignment.state, 'pinned');
});

test('an identical saved legacy packaging review pins without asking for a no-op reassignment', () => {
  const product = catalog.get('VN-03');
  const assignment = {
    state:'review-required',
    reason:'legacy-migration',
    assignedAt:NOW,
    orderSku:'VN-03',
    canonicalProductSku:'VN-03',
    packagingVersion:product.packagingVersion,
    catalogVersion:null,
    perCarton:product.perCarton,
    perPack:product.perPack,
    perBox:product.perBox,
    perPallet:product.perPallet,
    boxSize:product.boxSize,
    productName:product.productName,
  };
  const reviewIssue = {
    code:'PACKAGING_ASSIGNMENT_REVIEW_REQUIRED',
    productSku:'VN-03',
    orderSku:'VN-03',
    packagingVersion:product.packagingVersion,
    advisory:true,
  };
  const draft = {
    schemaVersion:ORDER_DRAFT_SCHEMA_VERSION,
    createdAt:NOW,
    updatedAt:NOW,
    rowsByProductSku:{
      'VN-03':{
        productSku:'VN-03', orderSku:'VN-03', standardFactory:'vietnam', orderGroup:'vietnam',
        quantities:{ packages:6384, cartons:399, orderDraft:null },
        pallet:{ value:9.5, mode:'manual', authoritativeField:'pallets', strategy:'' },
        locked:false,
        packagingAssignment:assignment,
        createdAt:NOW,
        updatedAt:NOW,
        issues:[reviewIssue],
      },
    },
    groupOrder:{ vietnam:['VN-03'], taiwan:[], subcontract:[] },
    repairOrder:[],
    issues:[reviewIssue],
  };
  const storage = createMemoryStorage({
    [ORDER_DRAFT_STORAGE_KEY]:JSON.stringify(draft),
  });

  const preview = previewPackagingReassignment(draft, {
    productSku:'VN-03',
    orderSku:'VN-03',
  }, context);
  assert.equal(preview.ok, true);
  assert.deepEqual(preview.changes, {
    orderSku:false,
    packagingVersion:false,
    orderGroup:false,
  });
  assert.deepEqual(
    {
      orderSku:preview.before.orderSku,
      packagingVersion:preview.before.packagingVersion,
      cartons:preview.before.cartons,
      pallets:preview.before.pallets,
      coverageDays:preview.before.coverageDays,
    },
    {
      orderSku:preview.after.orderSku,
      packagingVersion:preview.after.packagingVersion,
      cartons:preview.after.cartons,
      pallets:preview.after.pallets,
      coverageDays:preview.after.coverageDays,
    },
  );

  const loaded = loadOrderDraft({ storage, context });

  assert.equal(loaded.ok, true);
  assert.equal(loaded.status, 'loaded');
  assert.equal(loaded.needsSave, true);
  assert.equal(loaded.draft.rowsByProductSku['VN-03'].packagingAssignment.state, 'pinned');
  assert.equal(loaded.draft.rowsByProductSku['VN-03'].packagingAssignment.reason, 'legacy-identical-packaging');
  assert.deepEqual(
    {
      ...loaded.draft.rowsByProductSku['VN-03'].packagingAssignment,
      state:'review-required',
      reason:'legacy-migration',
    },
    assignment,
  );
  assert.deepEqual(loaded.draft.rowsByProductSku['VN-03'].quantities, draft.rowsByProductSku['VN-03'].quantities);
  assert.deepEqual(loaded.draft.rowsByProductSku['VN-03'].pallet, draft.rowsByProductSku['VN-03'].pallet);
  assert.deepEqual(loaded.draft.rowsByProductSku['VN-03'].issues, []);
  assert.deepEqual(loaded.draft.issues, []);
  assert.equal(projectOrderWorkbook(loaded.draft, context).ok, true);

  const factoryChangedContext = {
    ...context,
    getProduct:productSku => productSku === 'VN-03'
      ? { ...catalog.get(productSku), country:'TW' }
      : context.getProduct(productSku),
  };
  const factoryChanged = loadOrderDraft({
    storage:createMemoryStorage({ [ORDER_DRAFT_STORAGE_KEY]:JSON.stringify(draft) }),
    context:factoryChangedContext,
  });
  assert.equal(factoryChanged.status, 'loaded-with-warnings');
  assert.equal(factoryChanged.needsSave, false);
  assert.equal(factoryChanged.draft.rowsByProductSku['VN-03'].packagingAssignment.state, 'review-required');
  assert.ok(factoryChanged.issues.some(issue => issue.code === 'STANDARD_FACTORY_CHANGED'));

  const hiddenPackagingDifferenceDraft = structuredClone(draft);
  hiddenPackagingDifferenceDraft.rowsByProductSku['VN-03'].packagingAssignment.perCarton += 1;
  const hiddenPackagingDifference = loadOrderDraft({
    storage:createMemoryStorage({
      [ORDER_DRAFT_STORAGE_KEY]:JSON.stringify(hiddenPackagingDifferenceDraft),
    }),
    context,
  });
  assert.equal(hiddenPackagingDifference.status, 'loaded-with-warnings');
  assert.equal(hiddenPackagingDifference.needsSave, false);
  assert.equal(
    hiddenPackagingDifference.draft.rowsByProductSku['VN-03'].packagingAssignment.state,
    'review-required',
  );
});

test('a version-only packaging change does not surface a no-op reassignment', () => {
  const currentProduct = {
    ...catalog.get('VN-03'),
    productCode:'GTAL01',
    productName:'GTAL01',
    packagingVersion:'2026-09-02',
  };
  const versionOnlyContext = {
    ...context,
    getProduct:productSku => productSku === 'GTAL01' ? currentProduct : context.getProduct(productSku),
  };
  const reviewIssue = {
    code:'PACKAGING_ASSIGNMENT_REVIEW_REQUIRED',
    productSku:'GTAL01',
    orderSku:'GTAL01',
    packagingVersion:'2026-08-28.4',
    advisory:true,
  };
  const assignment = {
    state:'review-required',
    reason:'legacy-migration',
    assignedAt:NOW,
    orderSku:'GTAL01',
    canonicalProductSku:'GTAL01',
    packagingVersion:'2026-08-28.4',
    catalogVersion:'2026-08-28.4',
    perCarton:currentProduct.perCarton,
    perPack:currentProduct.perPack,
    perBox:currentProduct.perBox,
    perPallet:currentProduct.perPallet,
    boxSize:currentProduct.boxSize,
    productName:currentProduct.productName,
  };
  const draft = {
    schemaVersion:ORDER_DRAFT_SCHEMA_VERSION,
    createdAt:NOW,
    updatedAt:NOW,
    rowsByProductSku:{
      GTAL01:{
        productSku:'GTAL01', orderSku:'GTAL01', standardFactory:'vietnam', orderGroup:'vietnam',
        quantities:{ packages:0, cartons:84, orderDraft:0 },
        pallet:{ value:2, mode:'manual', authoritativeField:'pallets', strategy:'' },
        locked:false,
        packagingAssignment:assignment,
        createdAt:NOW,
        updatedAt:NOW,
        issues:[reviewIssue],
      },
    },
    groupOrder:{ vietnam:['GTAL01'], taiwan:[], subcontract:[] },
    repairOrder:[],
    issues:[reviewIssue],
  };

  const preview = previewPackagingReassignment(draft, {
    productSku:'GTAL01',
    orderSku:'GTAL01',
  }, versionOnlyContext);
  assert.equal(preview.ok, true);
  assert.equal(preview.changes.packagingVersion, true);
  assert.equal(preview.before.cartons, preview.after.cartons);
  assert.equal(preview.before.pallets, preview.after.pallets);

  const loaded = loadOrderDraft({
    storage:createMemoryStorage({ [ORDER_DRAFT_STORAGE_KEY]:JSON.stringify(draft) }),
    context:versionOnlyContext,
  });
  const resolvedRow = loaded.draft.rowsByProductSku.GTAL01;
  assert.equal(loaded.status, 'loaded');
  assert.equal(loaded.needsSave, true);
  assert.equal(resolvedRow.packagingAssignment.state, 'pinned');
  assert.equal(resolvedRow.packagingAssignment.reason, 'legacy-identical-packaging');
  const resolvedStatus = getPackagingAssignmentStatus(resolvedRow, versionOnlyContext);
  assert.equal(resolvedStatus.newerAvailable, true);
  assert.equal(resolvedStatus.reassignmentRecommended, false);
});

test('a later Standard Factory change warns but never moves a pinned row to another Order Group', () => {
  let country = 'VN';
  const factoryContext = {
    ...context,
    getProduct:productSku => productSku === 'VN-02' ? { ...catalog.get(productSku), country } : context.getProduct(productSku),
    getOrderSkuPackaging:orderSku => ({
      orderSku, canonicalProductSku:'VN-02', packagingVersion:'stable-pack',
      perCarton:12, perPack:null, perBox:null, perPallet:42, boxSize:'50*40*30',
    }),
  };
  let draft = applyOrderDraftCommand(createOrderDraft({ now:NOW }), {
    type:'upsert-row', row:{ productSku:'VN-02', quantities:{ orderDraft:504 } },
  }, factoryContext).draft;
  draft = applyOrderDraftCommand(draft, {
    type:'patch-row', productSku:'VN-02', patch:{ pallet:{ value:1, mode:'manual' } },
  }, factoryContext).draft;
  country = 'TW';
  const storage = createMemoryStorage();
  assert.equal(saveOrderDraft({ storage, draft, context:factoryContext }).status, 'saved-with-warnings');
  const loaded = loadOrderDraft({ storage, context:factoryContext });
  assert.equal(loaded.status, 'loaded-with-warnings');
  assert.equal(loaded.draft.rowsByProductSku['VN-02'].standardFactory, 'vietnam');
  assert.equal(loaded.draft.rowsByProductSku['VN-02'].orderGroup, 'vietnam');
  assert.deepEqual(loaded.draft.groupOrder.vietnam, ['VN-02']);
  const projected = projectOrderWorkbook(loaded.draft, factoryContext);
  assert.equal(projected.ok, true);
  assert.equal(projected.sheets.find(sheet => sheet.id === 'vietnam').rows[0][1], 'VN-02');
  assert.deepEqual(projected.sheets.find(sheet => sheet.id === 'taiwan').rows, []);
});

test('workbook projection preserves the established 台灣, 越南, and 代工 sheet contract', () => {
  const empty = projectOrderWorkbook(createOrderDraft({ now:NOW }), { getProduct:context.getProduct });
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.sheetOrder, ['台灣', '越南', '代工']);
  assert.deepEqual(empty.sheets.map(sheet => ({ name:sheet.name, headers:sheet.headers, rows:sheet.rows })), [
    { name:'台灣', headers:ORDER_EXPORT_HEADERS, rows:[] },
    { name:'越南', headers:ORDER_EXPORT_HEADERS, rows:[] },
    { name:'代工', headers:ORDER_EXPORT_HEADERS, rows:[] },
  ]);

  let draft = createOrderDraft({ now:NOW });
  for (const row of [
    { productSku:'TW-01', quantities:{ orderDraft:40 }, pallet:{ value:0.1, mode:'manual' } },
    { productSku:'VN-01', quantities:{ orderDraft:263.2 }, pallet:{ value:2.35, mode:'fractional-exception' } },
    { productSku:'VN-02', quantities:{ orderDraft:504 }, pallet:{ value:1, mode:'whole-pallet' } },
  ]) draft = applyOrderDraftCommand(draft, { type:'upsert-row', row }, context).draft;
  draft = applyOrderDraftCommand(draft, {
    type:'switch-order-sku', productSku:'VN-01', orderSku:'7AT-VN-01',
  }, context).draft;

  const projected = projectOrderWorkbook(draft, context);
  assert.equal(projected.ok, true);
  assert.deepEqual(projected.sheets[0].rows, [[1, 'TW-01', 'Taiwan item', 10, '單包', 4, '箱', 0.1, '棧板', '50*40*30']]);
  assert.deepEqual(projected.sheets[1].rows, [[1, 'VN-02', 'Second Vietnam item', 12, '單包', 42, '箱', 1, '棧板', '50*40*30']]);
  assert.deepEqual(projected.sheets[2].rows, [[1, '7AT-VN-01', 'Vietnam item', 8, '袋裝', 98.7, '箱', 2.35, '棧板', '50*40*30']]);
});

test('workbook projection derives exact pallets and per-box cartons from Product SKU catalog truth', () => {
  let draft = createOrderDraft({ now:NOW });
  for (const row of [
    { productSku:'VN-FRAC-1', quantities:{ orderDraft:80 }, pallet:{ value:0.27, mode:'fractional-exception' } },
    { productSku:'VN-FRAC-2', quantities:{ orderDraft:80 }, pallet:{ value:0.27, mode:'fractional-exception' } },
    { productSku:'VN-BOX', quantities:{ orderDraft:16 }, pallet:{ value:0.05, mode:'manual' } },
  ]) draft = applyOrderDraftCommand(draft, { type:'upsert-row', row }, context).draft;

  const projected = projectOrderWorkbook(draft, context);
  assert.equal(projected.ok, true);
  const vietnamRows = projected.sheets.find(sheet => sheet.id === 'vietnam').rows;
  assert.equal(vietnamRows[0][7], 80 / 300);
  assert.equal(vietnamRows[1][7], 80 / 300);
  assert.notEqual(vietnamRows[0][7], 0.27);
  assert.deepEqual(vietnamRows[2], [3, 'VN-BOX', 'Boxed Vietnam item', 8, '盒裝', 2, '箱', 16 / 336, '棧板', '50*40*30']);
});

test('workbook projection retains legacy saved carton and pallet values when exact order quantity is absent', () => {
  const draft = applyOrderDraftCommand(createOrderDraft({ now:NOW }), {
    type:'upsert-row',
    row:{ productSku:'TW-01', quantities:{ orderDraft:null, cartons:4 }, pallet:{ value:0.1, mode:'manual' } },
  }, context).draft;
  const projected = projectOrderWorkbook(draft, context);
  assert.equal(projected.ok, true);
  const taiwan = projected.sheets.find(sheet => sheet.id === 'taiwan');
  assert.equal(taiwan.rows[0][5], 4);
  assert.equal(taiwan.rows[0][7], 0.1);
});

test('browser consumers receive one frozen Order Draft interface', async () => {
  const previousWindow = globalThis.window;
  globalThis.window = {};
  try {
    await import(`../shared/order-draft-state.js?browser-interface=${Date.now()}`);
    const browserInterface = globalThis.window.SupplyOrderDraftState;
    assert.equal(Object.isFrozen(browserInterface), true);
    assert.equal(browserInterface.ORDER_DRAFT_SCHEMA_VERSION, 3);
    assert.deepEqual(browserInterface.ORDER_GROUP_IDS, ['vietnam', 'taiwan', 'subcontract']);
    for (const name of ['createOrderDraft', 'applyOrderDraftCommand', 'getOrderGroupRows', 'getPackagingAssignmentStatus', 'loadOrderDraft', 'pinOrderDraftForExport', 'previewPackagingReassignment', 'projectOrderWorkbook', 'resolveOrderDraftRowPackaging', 'saveOrderDraft']) {
      assert.equal(typeof browserInterface[name], 'function', name);
    }
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
