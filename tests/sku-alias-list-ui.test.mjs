import assert from 'node:assert/strict';
import test from 'node:test';
import { filterSkuAliasPairs, mountSkuAliasListUi } from '../shared/sku-alias-list-ui.js';

const pairs = Object.freeze([
  Object.freeze(['GTP01', '7GTPD013AB']),
  Object.freeze(['GTP05', '7GTPD053AB']),
  Object.freeze(['VTB01-4', '7VTBD410AB']),
]);

test('SKU reference searches either side, ignoring case and surrounding whitespace', () => {
  assert.deepEqual(filterSkuAliasPairs(pairs, { query:' gtp01 ' }), [pairs[0]]);
  assert.deepEqual(filterSkuAliasPairs(pairs, { query:' 7gtpd013ab ' }), [pairs[0]]);
  assert.deepEqual(filterSkuAliasPairs(pairs, { query:'GTP' }), [pairs[0], pairs[1]]);
  assert.deepEqual(filterSkuAliasPairs(pairs, { query:'410' }), [pairs[2]]);
  assert.deepEqual(filterSkuAliasPairs(pairs, { query:'UNKNOWN' }), []);
});

test('empty search preserves the approved mappings and their order without mutation', () => {
  assert.deepEqual(filterSkuAliasPairs(pairs), pairs);
  assert.deepEqual(filterSkuAliasPairs(pairs, { query:'   ' }), pairs);
  assert.notStrictEqual(filterSkuAliasPairs(pairs), pairs);
  assert.equal(filterSkuAliasPairs(pairs)[0], pairs[0]);
});

test('an absent or malformed catalog does not create unusable reference rows', () => {
  assert.deepEqual(filterSkuAliasPairs(), []);
  assert.deepEqual(filterSkuAliasPairs([null, [], ['SKU'], ['', '7SKU'], ['SKU', null], ['SKU', '7SKU', 'extra'], pairs[0]]), [pairs[0]]);
});

test('mounting requires a browser and a trigger', () => {
  assert.throws(() => mountSkuAliasListUi(), TypeError);
  assert.throws(() => mountSkuAliasListUi({ trigger:{}, documentRef:null, windowRef:{} }), TypeError);
});
