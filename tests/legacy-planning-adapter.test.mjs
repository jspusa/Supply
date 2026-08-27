import assert from 'node:assert/strict';
import test from 'node:test';

import {
  getLegacyOpenOrderState,
  getLegacySupplyDecision,
  planLegacyReplenishment,
} from '../shared/legacy-planning-adapter.js';

const policy = {
  leadTimeDays: 90,
  transferTimeDays: 21,
  targetDays: 180,
  executableOrderIncrement: 28,
};

test('legacy adapter normalizes current JAM state text before crossing the planner seam', () => {
  assert.equal(getLegacyOpenOrderState({ isReceived: true }), 'received');
  assert.equal(getLegacyOpenOrderState({ loadingDate: 'STOP' }), 'stopped');
  assert.equal(getLegacyOpenOrderState({ loadingDate: '還沒下單' }), 'planned');
  assert.equal(getLegacyOpenOrderState({ loadingDate: '下單了' }), 'ordered');
  assert.equal(getLegacyOpenOrderState({ portArrivalDate: '2026-10-16' }), 'ordered');
  assert.equal(getLegacyOpenOrderState({}), 'unknown');
});

test('legacy adapter preserves the existing flat lead-time result while exposing named coverage', () => {
  const plan = planLegacyReplenishment({
    asOfDate: '2026-08-27',
    row: {
      sku: 'GCTL03',
      planningVelocity: 8.83,
      usAmz: 369,
      usJsp: 0,
      usAmzInbound: 0,
      order: 3024,
    },
    readiness: { amazonInventory: true, jspInventory: true, openOrders: true },
    openOrders: [
      { id: 'JAM-101', quantity: 1176, loadingDate: '2026-08-27', portArrivalDate: 'N/A' },
      { id: 'JAM-108', quantity: 1848, loadingDate: 'N/A', portArrivalDate: 'N/A' },
    ],
    policy,
  });

  assert.equal(plan.canRecommend, true);
  assert.equal(plan.assumedBeforeNew, 3024);
  assert.equal(plan.unknownStatusInbound, 1848);
  assert.ok(Math.abs(plan.projectedStock - 2412.87) < 0.001);
  assert.equal(plan.suggestedQty, 0);
  assert.ok(Math.abs(plan.postArrivalDays - 273.2582) < 0.001);
  assert.equal(plan.postArrivalDays, plan.totalPostOrderCoverageDays);
  assert.equal(plan.continuousPostOrderCoverageDays, plan.planningResult.coverage.postOrderContinuousDays);
});

test('legacy adapter ignores obsolete source speed and plans only with Planning Velocity', () => {
  const plan = planLegacyReplenishment({
    asOfDate:'2026-08-27',
    row:{ sku:'GTP03', speed:0.36, planningVelocity:18.39, usAmz:1839, usJsp:0, usAmzInbound:0, order:0 },
    readiness:{ amazonInventory:true, jspInventory:true, openOrders:true },
    openOrders:[],
    policy,
  });
  assert.ok(Math.abs(plan.bookCoverageDays - 100) < 1e-9);
});

test('legacy supply decision uses the same explicit planner timeline', () => {
  const overdue = getLegacySupplyDecision({
    asOfDate: '2026-08-27',
    openOrder: { id: 'OLD', quantity: 1000, loadingDate: '2026-08-01', portArrivalDate: '2026-08-26' },
    policy,
  });
  assert.equal(overdue.bucket, 'overdue');
  assert.equal(overdue.orderState, 'ordered');

  const today = getLegacySupplyDecision({
    asOfDate: '2026-08-27',
    openOrder: { id: 'TODAY', quantity: 1000, portArrivalDate: '2026-08-27' },
    policy,
  });
  assert.equal(today.bucket, 'before');
  assert.equal(today.date.getFullYear(), 2026);
  assert.equal(today.date.getMonth(), 8);
  assert.equal(today.date.getDate(), 17);
});
