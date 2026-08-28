import assert from 'node:assert/strict';
import test from 'node:test';

import {
  collectAffectedWork,
  SUPPLY_ORDER_DRAFT_STORAGE_KEY,
} from '../shared/catalog-affected-work.mjs';

function readOnlyStorage(value) {
  let reads = 0;
  return {
    getItem(key) {
      reads += 1;
      return key === SUPPLY_ORDER_DRAFT_STORAGE_KEY ? value : null;
    },
    setItem() { throw new Error('collector must not write'); },
    removeItem() { throw new Error('collector must not remove'); },
    reads() { return reads; },
  };
}

const plan = {
  schemaVersion:1,
  entries:[{
    id:'product:ABC01', entryType:'product', sku:'ABC01', changeType:'updated',
    fields:[{ field:'unitsPerCarton', before:24, after:30 }],
    before:{ approvedOrderSkus:['ABC01', '7ABCD013AB'] },
    after:{ approvedOrderSkus:['ABC01', '7ABCD013AB'] },
  }, {
    id:'order-sku-alias:7ABCD013AB', entryType:'order-sku-alias', sku:'7ABCD013AB', changeType:'updated',
    fields:[{ field:'packagingVersion', before:'v1', after:'v2' }],
  }, {
    id:'product:OTHER01', entryType:'product', sku:'OTHER01', changeType:'updated',
    fields:[{ field:'lifecycle', before:'active', after:'retired' }],
  }],
};

test('Supply projects only related draft identities and pinned packaging status', () => {
  const storage = readOnlyStorage(JSON.stringify({
    schemaVersion:3,
    rowsByProductSku:{
      ABC01:{
        productSku:'ABC01', orderSku:'7ABCD013AB', orderGroup:'subcontract',
        quantities:{ cartons:12096, privateCost:'TOP-SECRET' },
        packagingAssignment:{
          canonicalProductSku:'ABC01', orderSku:'7ABCD013AB', packagingVersion:'2026-08-28.4',
          state:'pinned', perCarton:24, privateNote:'DO-NOT-EXPORT',
        },
      },
      UNRELATED:{
        productSku:'UNRELATED', orderSku:'UNRELATED', orderGroup:'vietnam',
        quantities:{ cartons:777 },
        packagingAssignment:{
          canonicalProductSku:'UNRELATED', orderSku:'UNRELATED', packagingVersion:'unrelated-v1', state:'review-required',
        },
      },
    },
  }));

  const result = collectAffectedWork({ site:'supply', storage, plan });

  assert.equal(result.storageStatus, 'ok');
  assert.equal(result.truncated, false);
  assert.deepEqual(result.entries[0].affectedWork, [{
    productSku:'ABC01',
    orderSku:'7ABCD013AB',
    packagingVersion:'2026-08-28.4',
    packagingState:'pinned',
    orderGroup:'subcontract',
  }]);
  assert.deepEqual(result.entries[1].affectedWork, result.entries[0].affectedWork);
  assert.deepEqual(result.entries[2].affectedWork, []);
  assert.equal(storage.reads(), 1);

  const publicJson = JSON.stringify(result);
  for (const forbidden of ['12096', '777', 'TOP-SECRET', 'DO-NOT-EXPORT', 'quantities', 'privateCost', 'perCarton']) {
    assert.equal(publicJson.includes(forbidden), false, `${forbidden} must not escape compact local state`);
  }
});

test('Supply malformed or oversized local JSON fails safe without dropping plan entries', () => {
  for (const raw of ['{not json', `{"padding":"${'x'.repeat(5_000_001)}"}`]) {
    const result = collectAffectedWork({ site:'supply', storage:readOnlyStorage(raw), plan });
    assert.ok(['invalid', 'too-large'].includes(result.storageStatus));
    assert.deepEqual(result.entries.map(entry => entry.affectedWork), [[], [], []]);
  }
});
