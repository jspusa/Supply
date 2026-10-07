import test from 'node:test';
import assert from 'node:assert/strict';
import { describeDecisionCoverage } from '../shared/decision-coverage.js';
import { planLegacyReplenishment } from '../shared/legacy-planning-adapter.js';

function plan({ velocity = 10, amz = 100, jsp = 50, order = 0, openOrders = [], readiness } = {}) {
  return planLegacyReplenishment({
    asOfDate:'2026-10-07',
    row:{ sku:'TEST01', planningVelocity:velocity, usAmz:amz, usJsp:jsp, usAmzInbound:999, order },
    readiness:readiness || { amazonInventory:true, jspInventory:true, openOrders:true },
    openOrders,
    policy:{ leadTimeDays:90, transferTimeDays:21, targetDays:365, maximumCoverageDays:365, executableOrderIncrement:1 },
    packaging:{ unitsPerPallet:100 },
  });
}
test('eligible coverage excludes planned, STOP and conflicting orders without counting assumptions twice', () => {
  const result = describeDecisionCoverage(plan({
    order:2700,
    openOrders:[
      { id:'dated', quantity:200, arrivalDate:'2026-10-20' },
      { id:'planned', quantity:500, loadingDate:'還沒下單' },
      { id:'stopped', quantity:600, loadingDate:'STOP' },
      { id:'unknown', quantity:300 },
      { id:'conflict', quantity:400, loadingDate:'2027-03-01' },
      { id:'late', quantity:700, arrivalDate:'2028-01-01' },
    ],
  }), 10);
  assert.equal(result.eligibleOrderUnits, 1200);
  assert.equal(result.excludedOrderUnits, 1500);
  assert.equal(result.assumedOrderUnits, 300);
  assert.equal(result.days, 135);
  assert.match(result.detail, /不保證.*斷貨/);
});
test('KTB01AM-4 uses normalized Amazon units and retains overdue/unknown assumptions', () => {
  const result = describeDecisionCoverage(plan({
    velocity:39.46, amz:1873, jsp:0, order:10327.5,
    openOrders:[
      { id:'JAM100', quantity:1350, arrivalDate:'2026-10-01' },
      { id:'JAM119', quantity:2362.5 },
      { id:'JAM127', quantity:2835 },
      { id:'JAM130', quantity:3780 },
    ],
  }),39.46);
  assert.equal(result.days.toFixed(1), '309.2');
  assert.equal(result.eligibleOrderUnits, 10327.5);
  assert.match(result.detail, /AMZ Inbound 未重複加計/);
});
test('missing inventory and no velocity never become zero-day estimates', () => {
  assert.equal(describeDecisionCoverage(plan({ velocity:0 }), 0).days, null);
  assert.equal(describeDecisionCoverage(plan({ readiness:{ amazonInventory:false, jspInventory:true, openOrders:true } }), 10).days, null);
});
