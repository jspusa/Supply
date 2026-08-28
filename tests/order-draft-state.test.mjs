import assert from 'node:assert/strict';
import test from 'node:test';

import {
  LEGACY_ORDER_DRAFT_STORAGE_KEY,
  ORDER_DRAFT_SCHEMA_VERSION,
  ORDER_DRAFT_STORAGE_KEY,
  ORDER_EXPORT_HEADERS,
  ORDER_GROUP_IDS,
  applyOrderDraftCommand,
  countOrderDraftRepairItems,
  createOrderDraft,
  getOrderGroupRows,
  loadOrderDraft,
  projectOrderWorkbook,
  saveOrderDraft,
} from '../shared/order-draft-state.js';

const NOW = '2026-08-28T03:00:00.000Z';
const catalog = new Map([
  ['TW-01', { productCode:'TW-01', productName:'Taiwan item', country:'TW', perCarton:10, perPack:null, perBox:null, perPallet:40, boxSize:'50*40*30' }],
  ['VN-01', { productCode:'VN-01', productName:'Vietnam item', country:'VN', perCarton:8, perPack:3, perBox:null, perPallet:42, boxSize:'50*40*30' }],
  ['VN-02', { productCode:'VN-02', productName:'Second Vietnam item', country:'VN', perCarton:12, perPack:null, perBox:null, perPallet:42, boxSize:'50*40*30' }],
  ['VN-03', { productCode:'VN-03', productName:'Third Vietnam item', country:'VN', perCarton:16, perPack:null, perBox:null, perPallet:42, boxSize:'50*40*30' }],
  ['VN-BOX', { productCode:'VN-BOX', productName:'Boxed Vietnam item', country:'VN', perCarton:8, perPack:null, perBox:6, perPallet:42, boxSize:'50*40*30' }],
  ['VN-FRAC-1', { productCode:'VN-FRAC-1', productName:'Fraction one', country:'VN', perCarton:10, perPack:null, perBox:null, perPallet:30, boxSize:'50*40*30' }],
  ['VN-FRAC-2', { productCode:'VN-FRAC-2', productName:'Fraction two', country:'VN', perCarton:10, perPack:null, perBox:null, perPallet:30, boxSize:'50*40*30' }],
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
  assert.deepEqual(projected.sheets.find(sheet => sheet.id === 'subcontract').rows, []);
  assert.ok(projected.issues.some(issue => issue.rowIssues?.some(rowIssue => rowIssue.code === 'UNAPPROVED_ORDER_SKU')));

  const missingApprovalAdapter = projectOrderWorkbook(approvedDraft, { getProduct:context.getProduct });
  assert.equal(missingApprovalAdapter.ok, false);
  assert.ok(missingApprovalAdapter.issues.some(issue => issue.rowIssues?.some(rowIssue => rowIssue.code === 'ORDER_SKU_APPROVAL_UNAVAILABLE')));

  const missingSaveContext = saveOrderDraft({ storage:createMemoryStorage(), draft:approvedDraft });
  assert.deepEqual({ ok:missingSaveContext.ok, status:missingSaveContext.status }, { ok:false, status:'validation-unavailable' });
});

test('v2 storage rejects drafts missing required row state or valid timestamps', () => {
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
    assert.equal(browserInterface.ORDER_DRAFT_SCHEMA_VERSION, 2);
    assert.deepEqual(browserInterface.ORDER_GROUP_IDS, ['vietnam', 'taiwan', 'subcontract']);
    for (const name of ['createOrderDraft', 'applyOrderDraftCommand', 'getOrderGroupRows', 'loadOrderDraft', 'saveOrderDraft', 'projectOrderWorkbook']) {
      assert.equal(typeof browserInterface[name], 'function', name);
    }
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
