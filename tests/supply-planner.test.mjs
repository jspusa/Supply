import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { classifyCoverageDays, PlannerInputError, planReplenishment } from '../shared/supply-planner.js';

const repoRoot = path.resolve(import.meta.dirname, '..');

function planningInput(overrides = {}) {
  return {
    asOfDate: '2026-08-27',
    productSku: 'SAMPLE01',
    planningVelocity: 10,
    readiness: {
      amazonInventory: true,
      jspInventory: true,
      openOrders: true,
      ...overrides.readiness,
    },
    inventory: {
      amazonSellable: 0,
      jspReserve: 0,
      amazonInboundWithoutEta: 0,
      reportedOpenOrder: 0,
      ...overrides.inventory,
    },
    openOrders: overrides.openOrders || [],
    policy: {
      leadTimeDays: 90,
      transferTimeDays: 21,
      targetDays: 180,
      executableOrderIncrement: 28,
      ...overrides.policy,
    },
    orderDraftQuantity: overrides.orderDraftQuantity ?? null,
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => !['readiness', 'inventory', 'openOrders', 'policy', 'orderDraftQuantity'].includes(key))),
  };
}

function order(overrides = {}) {
  return {
    id: 'ORDER-1',
    quantity: 1000,
    state: 'ordered',
    loadingDate: null,
    portArrivalDate: null,
    ...overrides,
  };
}

test('planner is a pure module with an explicit as-of date and structured outputs', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'shared', 'supply-planner.js'), 'utf8');
  assert.doesNotMatch(source, /\b(?:document|window|localStorage|sessionStorage)\b/);
  assert.doesNotMatch(source, /new Date\(\s*\)/);

  const input = planningInput();
  const before = structuredClone(input);
  const result = planReplenishment(input);

  assert.deepEqual(input, before, 'planner must not mutate caller input');
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.dates, {
    asOfDate: '2026-08-27',
    newOrderPortArrivalDate: '2026-11-25',
    newOrderSellableDate: '2026-12-16',
    targetEndDate: '2027-06-14',
    confirmedStockoutDate: '2026-08-27',
    orderByDate: '2026-05-08',
    uncertainSupplyDeadline: null,
  });
  assert.equal(result.recommendation.rawQuantity, 1800);
  assert.equal(result.recommendation.executableQuantity, 1820);
  assert.equal(result.coverage.arrivalDays, 0);
  assert.equal(result.coverage.bookDays, 0);
  assert.equal(result.coverage.postOrderTotalDays, 182);
  assert.equal(result.coverage.postOrderContinuousDays, 182);
});

test('planner reports missing data and no velocity without inventing a recommendation', () => {
  const missing = planReplenishment(planningInput({
    readiness: { amazonInventory: false, openOrders: false },
    inventory: { amazonSellable: null },
  }));
  assert.equal(missing.status, 'missing-data');
  assert.equal(missing.recommendation.canRecommend, false);
  assert.deepEqual(missing.missingData.map(item => item.code), ['AMAZON_INVENTORY', 'OPEN_ORDERS']);
  assert.equal(missing.coverage.postOrderContinuousDays, null);

  const noVelocity = planReplenishment(planningInput({ planningVelocity: 0 }));
  assert.equal(noVelocity.status, 'no-velocity');
  assert.deepEqual(noVelocity.noVelocity, { reason: 'non-positive' });
  assert.equal(noVelocity.recommendation.canRecommend, false);
  assert.equal(noVelocity.recommendation.executableQuantity, 0);
});

test('placed and unknown old orders without ETA are assumed before the new order', () => {
  const result = planReplenishment(planningInput({
    productSku: 'GCTL03',
    planningVelocity: 8.83,
    inventory: { amazonSellable: 369, reportedOpenOrder: 3024 },
    openOrders: [
      order({ id: 'JAM-101', quantity: 1176, loadingDate: '2026-08-27' }),
      order({ id: 'JAM-108', quantity: 1848, state: 'unknown' }),
    ],
  }));

  assert.equal(result.supply.assumedBeforeNew, 3024);
  assert.equal(result.supply.unknownStateAssumed, 1848);
  assert.ok(Math.abs(result.projection.assumedStockAtArrival - 2412.87) < 0.001);
  assert.equal(result.recommendation.executableQuantity, 0);
  assert.ok(Math.abs(result.coverage.postOrderTotalDays - 273.2582) < 0.001);
  assert.ok(result.coverage.shortageBeforeArrivalDays > 69 && result.coverage.shortageBeforeArrivalDays < 70);
  assert.deepEqual(result.warnings.map(item => item.code).sort(), ['ASSUMED_UNDATED_ORDER', 'ASSUMED_UNKNOWN_ORDER']);
});

test('order-arrival coverage treats an unmatched existing order as arriving before the new order', () => {
  const result = planReplenishment(planningInput({
    productSku: 'AFA12AM',
    planningVelocity: 10,
    inventory: { reportedOpenOrder: 3144 },
    openOrders: [],
    policy: { leadTimeDays: 100, transferTimeDays: 21, targetDays: 365 },
    orderDraftQuantity: 0,
  }));

  assert.equal(result.coverage.bookDays, 314.4);
  assert.equal(result.supply.unmatched, 3144);
  assert.equal(result.supply.assumedBeforeNew, 3144);
  assert.ok(Math.abs(result.coverage.newOrderPortArrivalDays - 214.4) < 1e-9);
  assert.ok(result.warnings.some(item => item.code === 'ASSUMED_UNMATCHED_OPEN_ORDER'));
});

test('planned and STOP orders stay out of the recommendation', () => {
  const result = planReplenishment(planningInput({
    productSku: 'GCTL03',
    planningVelocity: 8.83,
    inventory: { amazonSellable: 369, reportedOpenOrder: 3024 },
    openOrders: [
      order({ id: 'FY-2612', quantity: 1512, state: 'planned' }),
      order({ id: 'HS-2601', quantity: 1512, state: 'stopped' }),
    ],
  }));

  assert.equal(result.supply.assumedBeforeNew, 0);
  assert.equal(result.supply.plannedNotPlaced, 1512);
  assert.equal(result.supply.stopped, 1512);
  assert.equal(result.projection.assumedStockAtArrival, 0);
  assert.equal(result.recommendation.executableQuantity, 1596);
  assert.ok(Math.abs(result.coverage.postOrderTotalDays - 180.7475) < 0.001);
});

test('Amazon inbound without ETA stays uncertain and is never double-counted', () => {
  const result = planReplenishment(planningInput({
    inventory: { amazonInboundWithoutEta: 3000 },
  }));
  assert.equal(result.supply.amazonInboundWithoutEta, 3000);
  assert.equal(result.supply.assumedBeforeNew, 0);
  assert.equal(result.projection.assumedStockAtArrival, 0);
  assert.equal(result.recommendation.executableQuantity, 1820);
  assert.ok(result.warnings.some(item => item.code === 'UNSCHEDULED_AMAZON_INBOUND'));
});

test('overdue and same-day port arrivals use the explicit as-of date', () => {
  const overdue = planReplenishment(planningInput({
    inventory: { reportedOpenOrder: 1000 },
    openOrders: [order({ id: 'YESTERDAY', portArrivalDate: '2026-08-26' })],
  }));
  assert.equal(overdue.supply.overdueAssumed, 1000);
  assert.equal(overdue.supply.assumedBeforeNew, 1000);
  assert.ok(overdue.warnings.some(item => item.code === 'ASSUMED_OVERDUE_ORDER'));

  const sameDay = planReplenishment(planningInput({
    inventory: { reportedOpenOrder: 1000 },
    openOrders: [order({ id: 'TODAY', portArrivalDate: '2026-08-27' })],
  }));
  assert.equal(sameDay.supply.overdueAssumed, 0);
  assert.equal(sameDay.supply.confirmedBeforeNew, 1000);
  assert.equal(sameDay.projection.assumedStockAtArrival, 100);
});

test('confirmed dated supply keeps its chronological remaining stock', () => {
  const result = planReplenishment(planningInput({
    inventory: { reportedOpenOrder: 1000 },
    openOrders: [order({ id: 'DATED', portArrivalDate: '2026-10-16' })],
  }));
  assert.equal(result.supply.confirmedBeforeNew, 1000);
  assert.equal(result.projection.assumedStockAtArrival, 600);
  assert.equal(result.recommendation.rawQuantity, 1200);
  assert.equal(result.recommendation.executableQuantity, 1204);
});

test('TTS05 includes placed supply and excludes planned supply', () => {
  const result = planReplenishment(planningInput({
    productSku: 'TTS05AM-1',
    planningVelocity: 495.18,
    inventory: {
      amazonSellable: 19628,
      amazonInboundWithoutEta: 3900,
      reportedOpenOrder: 210000,
    },
    openOrders: [
      order({ id: 'FY-2608', quantity: 84000, loadingDate: '2026-08-10' }),
      order({ id: 'FY-2611', quantity: 84000 }),
      order({ id: 'FY-2614', quantity: 42000, state: 'planned' }),
    ],
  }));
  assert.equal(result.supply.assumedBeforeNew, 168000);
  assert.equal(result.supply.plannedNotPlaced, 42000);
  assert.equal(result.supply.amazonInboundWithoutEta, 3900);
  assert.ok(Math.abs(result.projection.assumedStockAtArrival - 132663.02) < 0.001);
  assert.equal(result.recommendation.executableQuantity, 0);
  assert.ok(Math.abs(result.coverage.postOrderTotalDays - 267.9088) < 0.001);
});

test('loading after the new-order arrival is conflicting rather than assumed', () => {
  const result = planReplenishment(planningInput({
    productSku: 'GCTL03',
    planningVelocity: 8.83,
    inventory: { amazonSellable: 369, reportedOpenOrder: 3024 },
    openOrders: [order({ id: 'FY-LATE', quantity: 3024, loadingDate: '2026-12-25' })],
  }));
  assert.equal(result.supply.conflictingSchedule, 3024);
  assert.equal(result.supply.assumedBeforeNew, 0);
  assert.equal(result.recommendation.executableQuantity, 1596);
});

test('confirmed target-window supply contributes chronologically', () => {
  const result = planReplenishment(planningInput({
    inventory: { amazonSellable: 3000, reportedOpenOrder: 1000 },
    openOrders: [order({ id: 'TARGET', portArrivalDate: '2026-12-25' })],
  }));
  assert.equal(result.supply.scheduledWithinTarget, 1000);
  assert.equal(result.recommendation.executableQuantity, 0);
  assert.equal(result.coverage.postOrderContinuousDays, 289);
});

test('book, total Post-Order, and continuous Post-Order coverage stay distinct', () => {
  const result = planReplenishment(planningInput({
    inventory: { amazonSellable: 500, reportedOpenOrder: 1000 },
    openOrders: [order({ id: 'LATE-GAP', portArrivalDate: '2027-09-21' })],
    policy: { targetDays: 365 },
    orderDraftQuantity: 1000,
  }));
  assert.equal(result.coverage.bookDays, 150);
  assert.equal(result.coverage.postOrderTotalDays, 200);
  assert.equal(result.coverage.postOrderContinuousDays, 100);
  assert.ok(result.coverage.postOrderContinuousDays < result.coverage.postOrderTotalDays);
});

test('invalid normalized inputs fail with Product SKU and source path', () => {
  assert.throws(
    () => planReplenishment(planningInput({ productSku: 'BAD01', openOrders: [order({ state: 'mystery' })] })),
    error => error instanceof PlannerInputError
      && error.productSku === 'BAD01'
      && error.path === 'openOrders[0].state',
  );
});

test('whole-pallet recommendation chooses the smallest whole pallet inside 180–365 days', () => {
  const result = planReplenishment(planningInput({
    packaging: { unitsPerPallet: 1000 },
    policy: { executableOrderIncrement: 100 },
  }));

  assert.equal(result.recommendation.strategy, 'whole-pallet');
  assert.equal(result.recommendation.rawQuantity, 1800);
  assert.equal(result.recommendation.unitGuidanceQuantity, 1800);
  assert.equal(result.recommendation.executableQuantity, 2000);
  assert.equal(result.recommendation.pallets, 2);
  assert.equal(result.recommendation.applyBy, 'pallets');
  assert.equal(result.recommendation.resultingCoverageDays, 200);
  assert.equal(result.recommendation.warning, null);
});

test('fractional exception uses the smallest executable quantity when adjacent whole pallets straddle 180–365', () => {
  const result = planReplenishment(planningInput({
    planningVelocity: 1,
    packaging: { unitsPerPallet: 400 },
    policy: { executableOrderIncrement: 10 },
  }));

  assert.equal(result.recommendation.strategy, 'fractional-exception');
  assert.equal(result.recommendation.executableQuantity, 180);
  assert.equal(result.recommendation.pallets, 0.45);
  assert.equal(result.recommendation.applyBy, 'quantity');
  assert.equal(result.recommendation.resultingCoverageDays, 180);
  assert.equal(result.recommendation.warning, null);
});

test('existing target coverage and excess coverage both produce zero without a negative order', () => {
  const exactTarget = planReplenishment(planningInput({
    inventory: { amazonSellable: 2910 },
    packaging: { unitsPerPallet: 1000 },
    policy: { executableOrderIncrement: 100 },
  }));
  assert.equal(exactTarget.coverage.postOrderContinuousDays, 180);
  assert.equal(exactTarget.recommendation.strategy, 'none');
  assert.equal(exactTarget.recommendation.executableQuantity, 0);
  assert.equal(exactTarget.recommendation.pallets, 0);

  const excess = planReplenishment(planningInput({
    inventory: { amazonSellable: 5000 },
    packaging: { unitsPerPallet: 1000 },
    policy: { executableOrderIncrement: 100 },
  }));
  assert.ok(excess.coverage.postOrderContinuousDays > 365);
  assert.equal(excess.recommendation.strategy, 'none');
  assert.equal(excess.recommendation.executableQuantity, 0);
  assert.equal(excess.recommendation.isExcess, true);
});

test('exactly 365 days is healthy and only coverage above the tolerance is excess', () => {
  const exact = planReplenishment(planningInput({
    inventory: { amazonSellable: 4760 },
    packaging: { unitsPerPallet: 1000 },
    policy: { executableOrderIncrement: 100 },
  }));
  assert.equal(exact.coverage.postOrderContinuousDays, 365);
  assert.equal(exact.recommendation.isExcess, false);

  const above = planReplenishment(planningInput({
    inventory: { amazonSellable: 4760.6 },
    packaging: { unitsPerPallet: 1000 },
    policy: { executableOrderIncrement: 100 },
  }));
  assert.ok(above.coverage.postOrderContinuousDays > 365.05);
  assert.equal(above.recommendation.isExcess, true);
});

test('missing or incompatible pallet data preserves executable unit guidance with a repair warning', () => {
  for (const packaging of [undefined, { unitsPerPallet: 0 }, { unitsPerPallet: Number.NaN }, { unitsPerPallet: 950 }]) {
    const result = planReplenishment(planningInput({
      packaging,
      policy: { executableOrderIncrement: 100 },
    }));
    assert.equal(result.recommendation.strategy, 'unit-guidance');
    assert.equal(result.recommendation.unitGuidanceQuantity, 1800);
    assert.equal(result.recommendation.executableQuantity, 1800);
    assert.equal(result.recommendation.pallets, null);
    assert.equal(result.recommendation.applyBy, 'quantity');
    assert.equal(result.recommendation.warning.code, 'INVALID_PALLET_CATALOG');
  }
});

test('coarse executable quantity above 365 remains auditable instead of silently prefilling a safe-looking pallet', () => {
  const result = planReplenishment(planningInput({
    planningVelocity: 1,
    packaging: { unitsPerPallet: 400 },
    policy: { executableOrderIncrement: 400 },
  }));

  assert.equal(result.recommendation.strategy, 'unit-guidance');
  assert.equal(result.recommendation.executableQuantity, 400);
  assert.equal(result.recommendation.pallets, null);
  assert.equal(result.recommendation.resultingCoverageDays, 400);
  assert.equal(result.recommendation.warning.code, 'NO_EXECUTABLE_QUANTITY_WITHIN_CEILING');
});

test('fractional display rounding never changes the authoritative executable quantity', () => {
  const exact = planReplenishment(planningInput({
    planningVelocity: 1,
    inventory: { amazonSellable: 211 },
    packaging: { unitsPerPallet: 300 },
    policy: { executableOrderIncrement: 1 },
  }));
  assert.equal(exact.projection.assumedStockAtArrival, 100);
  assert.equal(exact.recommendation.strategy, 'fractional-exception');
  assert.equal(exact.recommendation.executableQuantity, 80);
  assert.equal(exact.recommendation.pallets, 0.27);
  assert.equal(exact.recommendation.resultingCoverageDays, 180);

  const rounded = planReplenishment(planningInput({
    planningVelocity: 1,
    inventory: { amazonSellable: 211 },
    packaging: { unitsPerPallet: 301 },
    policy: { executableOrderIncrement: 7 },
  }));
  assert.equal(rounded.recommendation.strategy, 'fractional-exception');
  assert.equal(rounded.recommendation.executableQuantity, 84);
  assert.equal(rounded.recommendation.pallets, 0.28);
  assert.equal(rounded.recommendation.resultingCoverageDays, 184);
});

test('a whole pallet that lands exactly on 365 remains the preferred recommendation', () => {
  const result = planReplenishment(planningInput({
    planningVelocity: 1,
    inventory: { amazonSellable: 211 },
    packaging: { unitsPerPallet: 265 },
    policy: { executableOrderIncrement: 1 },
  }));
  assert.equal(result.projection.assumedStockAtArrival, 100);
  assert.equal(result.recommendation.strategy, 'whole-pallet');
  assert.equal(result.recommendation.pallets, 1);
  assert.equal(result.recommendation.executableQuantity, 265);
  assert.equal(result.recommendation.resultingCoverageDays, 365);
  assert.equal(result.recommendation.isExcess, false);
});

test('shared coverage classification owns the displayed 180 and 365 boundaries', () => {
  assert.equal(classifyCoverageDays({ coverageDays:null, targetDays:180 }), 'neutral');
  assert.equal(classifyCoverageDays({ coverageDays:179.999999998, targetDays:180 }), 'low');
  assert.equal(classifyCoverageDays({ coverageDays:179.9999999995, targetDays:180 }), 'healthy');
  assert.equal(classifyCoverageDays({ coverageDays:365, targetDays:180 }), 'healthy');
  assert.equal(classifyCoverageDays({ coverageDays:365.0000000005, targetDays:180 }), 'healthy');
  assert.equal(classifyCoverageDays({ coverageDays:365.000000002, targetDays:180 }), 'excess');
});

test('whole-pallet ceiling includes confirmed old orders after the target but before day 365', () => {
  const result = planReplenishment(planningInput({
    planningVelocity: 1,
    inventory: { reportedOpenOrder: 200 },
    openOrders: [order({ quantity:200, portArrivalDate:'2027-06-13' })],
    packaging: { unitsPerPallet: 200 },
    policy: { executableOrderIncrement: 1 },
  }));

  assert.equal(result.supply.later, 200);
  assert.equal(result.recommendation.strategy, 'fractional-exception');
  assert.equal(result.recommendation.executableQuantity, 180);
  assert.equal(result.recommendation.pallets, 0.9);
  assert.equal(result.recommendation.resultingCoverageDays, 180);
});
