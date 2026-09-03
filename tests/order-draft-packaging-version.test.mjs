import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyOrderDraftCommand,
  createOrderDraft,
  getPackagingAssignmentStatus,
  resolveOrderDraftRowPackaging,
} from '../shared/order-draft-state.js';

const NOW = '2026-08-29T00:00:00.000Z';

test('a catalog product without a Packaging Specification Version cannot create a fake current assignment', () => {
  const product = {
    productCode:'NO-VERSION',
    productName:'Incomplete packaging identity',
    country:'VN',
    perCarton:24,
    perPack:null,
    perBox:null,
    perPallet:40,
    boxSize:'50*40*30',
  };
  const context = {
    now:NOW,
    catalogVersion:'2026-08-29.1',
    getProduct:sku => sku === 'NO-VERSION' ? product : null,
    getApprovedOrderSkus:() => [],
  };
  const row = {
    productSku:'NO-VERSION',
    orderSku:'NO-VERSION',
    packagingAssignment:null,
  };

  assert.equal(resolveOrderDraftRowPackaging(row, context), null);
  assert.deepEqual(getPackagingAssignmentStatus(row, context), {
    state:'floating',
    assignedVersion:null,
    currentVersion:null,
    newerAvailable:false,
    reassignmentRecommended:false,
    reviewRequired:false,
    assigned:null,
    current:null,
  });

  const draft = createOrderDraft({ now:NOW });
  const pinned = applyOrderDraftCommand(draft, {
    type:'upsert-row',
    row:{
      productSku:'NO-VERSION',
      quantities:{ orderDraft:120 },
      pallet:{ value:0.125, mode:'manual' },
      locked:false,
      pinPackaging:true,
    },
  }, context);

  assert.equal(pinned.ok, false);
  assert.equal(pinned.status, 'packaging-unavailable');
  assert.deepEqual(pinned.draft, draft);
  assert.equal(JSON.stringify(pinned).includes('"packagingVersion":"current"'), false);
  assert.equal(JSON.stringify(pinned).includes('"packagingVersion":"2026-08-29.1"'), false);
});
