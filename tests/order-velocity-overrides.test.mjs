import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ORDER_VELOCITY_OVERRIDES_KEY,
  readOrderVelocityOverrides,
  setOrderVelocityOverride,
} from '../shared/order-velocity-overrides.js';

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
  };
}

test('manual order velocity persists by canonical Product SKU and can be reset', () => {
  const storage = memoryStorage();

  const saved = setOrderVelocityOverride(storage, { productSku:' afa12am ', value:'15.5' });
  assert.deepEqual(saved, { ok:true, status:'saved', overrides:{ AFA12AM:15.5 } });
  assert.deepEqual(readOrderVelocityOverrides(storage), { ok:true, status:'loaded', overrides:{ AFA12AM:15.5 } });

  const cleared = setOrderVelocityOverride(storage, { productSku:'AFA12AM', value:'' });
  assert.deepEqual(cleared, { ok:true, status:'saved', overrides:{} });
  assert.equal(JSON.parse(storage.getItem(ORDER_VELOCITY_OVERRIDES_KEY)).schemaVersion, 1);
});

test('invalid manual speed fails closed without overwriting a valid value', () => {
  const storage = memoryStorage();
  setOrderVelocityOverride(storage, { productSku:'AFA12AM', value:15.5 });

  const rejected = setOrderVelocityOverride(storage, { productSku:'AFA12AM', value:0 });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.status, 'invalid-velocity');
  assert.deepEqual(readOrderVelocityOverrides(storage).overrides, { AFA12AM:15.5 });
});

test('corrupt saved data is reported and never treated as a valid override', () => {
  const storage = memoryStorage({ [ORDER_VELOCITY_OVERRIDES_KEY]:'not json' });
  assert.deepEqual(readOrderVelocityOverrides(storage), { ok:false, status:'corrupt', overrides:{} });
});
