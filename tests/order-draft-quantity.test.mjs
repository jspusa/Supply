import assert from 'node:assert/strict';
import test from 'node:test';

import { stepPalletDraft } from '../shared/order-draft-quantity.js';

test('pallet draft arrows preserve a manual fraction and move exactly one pallet', () => {
  assert.deepEqual(stepPalletDraft({ currentPallets: 2.35, delta: 1, unitsPerPallet: 400 }), {
    pallets: 3.35,
    orderDraftQuantity: 1340,
  });
  assert.deepEqual(stepPalletDraft({ currentPallets: 2.35, delta: -1, unitsPerPallet: 400 }), {
    pallets: 1.35,
    orderDraftQuantity: 540,
  });
});

test('pallet draft decrement clamps at zero and blank values start from zero', () => {
  assert.deepEqual(stepPalletDraft({ currentPallets: 0.4, delta: -1, unitsPerPallet: 400 }), {
    pallets: 0,
    orderDraftQuantity: 0,
  });
  assert.deepEqual(stepPalletDraft({ currentPallets: '', delta: 1, unitsPerPallet: 400 }), {
    pallets: 1,
    orderDraftQuantity: 400,
  });
});

test('pallet draft rejects unsupported deltas and reports unavailable unit conversion', () => {
  assert.throws(() => stepPalletDraft({ currentPallets: 1, delta: 0.5, unitsPerPallet: 400 }), /delta/);
  assert.deepEqual(stepPalletDraft({ currentPallets: 1.25, delta: 1, unitsPerPallet: 0 }), {
    pallets: 2.25,
    orderDraftQuantity: null,
  });
});

test('automatic fractional quantity remains authoritative when an arrow adds a pallet', () => {
  assert.deepEqual(stepPalletDraft({
    currentPallets: 0.27,
    currentOrderDraftQuantity: 80,
    delta: 1,
    unitsPerPallet: 300,
  }), {
    pallets: 1.27,
    orderDraftQuantity: 380,
  });
});
