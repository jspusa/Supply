import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ONE_PALLET_DISCONTINUATION_DAYS,
  ONE_PALLET_DISCONTINUATION_REASON,
  buildDiscontinuationSuggestions,
} from '../shared/discontinuation-suggestions.js';

test('suggests only active Product SKUs whose one-pallet coverage strictly exceeds 365 days', () => {
  const suggestions = buildDiscontinuationSuggestions([
    { productSku:'over', planningVelocity:2, unitsPerPallet:731 },
    { productSku:'exact', planningVelocity:2, unitsPerPallet:730 },
    { productSku:'under', planningVelocity:2, unitsPerPallet:729 },
    { productSku:'already', planningVelocity:1, unitsPerPallet:500, isDiscontinued:true },
  ]);

  assert.equal(ONE_PALLET_DISCONTINUATION_DAYS, 365);
  assert.deepEqual(suggestions.map(row => row.productSku), ['OVER']);
  assert.equal(suggestions[0].onePalletSellableDays, 365.5);
  assert.equal(suggestions[0].reasonCode, ONE_PALLET_DISCONTINUATION_REASON);
  assert.match(suggestions[0].reason, /一板可售 365\.5 天/);
  assert.match(suggestions[0].reason, /超過 365 天/);
});

test('requires a valid positive Planning Velocity and units per pallet', () => {
  const suggestions = buildDiscontinuationSuggestions([
    { productSku:'ZERO', planningVelocity:0, unitsPerPallet:1000 },
    { productSku:'NEGATIVE', planningVelocity:-1, unitsPerPallet:1000 },
    { productSku:'NO-VELOCITY', planningVelocity:null, unitsPerPallet:1000 },
    { productSku:'NO-PALLET', planningVelocity:1, unitsPerPallet:null },
    { productSku:'BAD-PALLET', planningVelocity:1, unitsPerPallet:Number.NaN },
    { productSku:'', planningVelocity:1, unitsPerPallet:1000 },
    { productSku:'STRING-NUMBERS', planningVelocity:'2', unitsPerPallet:'800' },
  ]);

  assert.deepEqual(suggestions.map(row => row.productSku), ['STRING-NUMBERS']);
  assert.equal(suggestions[0].planningVelocity, 2);
  assert.equal(suggestions[0].unitsPerPallet, 800);
});

test('accepts the canonical discontinued lookup and sorts highest one-pallet days first', () => {
  const rows = [
    { sku:'z-low', planningVelocity:2, unitsPerPallet:800 },
    { sku:'a-high', planningVelocity:1, unitsPerPallet:800 },
    { sku:'fixed-stop', planningVelocity:1, unitsPerPallet:900 },
  ];
  const before = structuredClone(rows);
  const suggestions = buildDiscontinuationSuggestions(rows, {
    isDiscontinuedSku:productSku => productSku === 'FIXED-STOP',
  });

  assert.deepEqual(suggestions.map(row => row.productSku), ['A-HIGH', 'Z-LOW']);
  assert.deepEqual(rows, before);
  assert.equal(Object.isFrozen(suggestions), true);
  assert.equal(Object.isFrozen(suggestions[0]), true);
});

test('non-array input is an empty immutable suggestion list', () => {
  const suggestions = buildDiscontinuationSuggestions(null);
  assert.deepEqual(suggestions, []);
  assert.equal(Object.isFrozen(suggestions), true);
});
