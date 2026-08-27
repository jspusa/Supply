import { classifyCoverageDays, getPalletCatalogIssue, planReplenishment } from './supply-planner.js';
import './order-draft-quantity.js';
import './order-draft-state.js';
import './planning-velocity.js';
import './planning-velocity-history.js';
import './workspace-navigation.js';

const MISSING_SOURCE_LABELS = {
  AMAZON_INVENTORY: 'AMZ庫存',
  JSP_INVENTORY: 'JSP庫存',
  OPEN_ORDERS: 'JAM訂單',
};

function normalizeLegacyDate(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const [year, month, day] = text.split('-').map(Number);
  const normalized = new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
  return normalized === text ? text : null;
}

function toLocalDate(value) {
  if (!value) return null;
  const [year, month, day] = value.split('-').map(Number);
  return new Date(year, month - 1, day);
}

export function getLegacyOpenOrderState(item) {
  if (item?.isReceived) return 'received';
  const loadingText = String(item?.loadingDate ?? '').trim();
  const arrivalText = String(item?.portArrivalDate ?? item?.arrivalDate ?? '').trim();
  const stateText = `${loadingText} ${arrivalText} ${String(item?.receivedMark ?? '')}`;
  if (/(^|\s)STOP($|\s)|取消/i.test(stateText)) return 'stopped';
  if (/還沒下單|尚未下單|未下單/i.test(stateText)) return 'planned';
  if (normalizeLegacyDate(loadingText) || normalizeLegacyDate(arrivalText) || /下單了|已下單/i.test(stateText)) return 'ordered';
  return 'unknown';
}

function normalizeLegacyOpenOrder(item, index) {
  return {
    id: String(item?.id ?? item?.orderName ?? `ORDER-${index + 1}`),
    quantity: Number(item?.quantity ?? item?.qty ?? 0),
    state: getLegacyOpenOrderState(item),
    loadingDate: normalizeLegacyDate(item?.loadingDate),
    portArrivalDate: normalizeLegacyDate(item?.portArrivalDate ?? item?.arrivalDate),
  };
}

function toLegacyPlan(result, policy) {
  const supply = result.supply;
  const projection = result.projection;
  const recommendation = result.recommendation;
  const coverage = result.coverage;
  return {
    status: result.status,
    leadDays: policy.leadTimeDays,
    transferDays: policy.transferTimeDays,
    targetDays: policy.targetDays,
    targetEndDate: toLocalDate(result.dates.targetEndDate),
    newArrivalDate: toLocalDate(result.dates.newOrderPortArrivalDate),
    newSellableDate: toLocalDate(result.dates.newOrderSellableDate),
    currentStock: projection.currentStock,
    currentAmzStock: supply.currentAmazonStock,
    jspReserve: supply.jspReserve,
    inboundBefore: supply.confirmedBeforeNew,
    assumedBeforeNew: supply.assumedBeforeNew,
    assumedPriorInbound: supply.assumedBeforeNew,
    plannedNotPlaced: supply.plannedNotPlaced,
    stoppedInbound: supply.stopped,
    unknownStatusInbound: supply.unknownStateAssumed,
    overdueInbound: supply.overdueAssumed,
    conflictingScheduleInbound: supply.conflictingSchedule,
    unmatchedInbound: supply.unmatched,
    amzInboundNoEta: supply.amazonInboundWithoutEta,
    scheduledWithinTarget: supply.scheduledWithinTarget,
    uncertainInbound: supply.uncertain,
    laterInbound: supply.later,
    uncertainDeadline: toLocalDate(result.dates.uncertainSupplyDeadline),
    confirmedStockoutDate: toLocalDate(result.dates.confirmedStockoutDate),
    orderByDate: toLocalDate(result.dates.orderByDate),
    leadDemand: projection.leadDemand ?? 0,
    conservativeProjectedStock: projection.confirmedStockAtArrival ?? 0,
    projectedStock: projection.assumedStockAtArrival ?? 0,
    shortageDays: coverage.shortageBeforeArrivalDays ?? 0,
    rawSuggestedQty: recommendation.rawQuantity,
    suggestedQty: recommendation.executableQuantity,
    unitGuidanceQty: recommendation.unitGuidanceQuantity,
    orderIncrement: recommendation.increment,
    recommendationStrategy: recommendation.strategy,
    recommendedPallets: recommendation.pallets,
    recommendationApplyBy: recommendation.applyBy,
    recommendationCoverageDays: recommendation.resultingCoverageDays,
    recommendationIsExcess: recommendation.isExcess,
    recommendationWarning: recommendation.warning,
    postArrivalDays: coverage.postOrderTotalDays,
    totalPostOrderCoverageDays: coverage.postOrderTotalDays,
    continuousPostOrderCoverageDays: coverage.postOrderContinuousDays,
    bookCoverageDays: coverage.bookDays,
    arrivalCoverageDays: coverage.arrivalDays,
    canRecommend: recommendation.canRecommend,
    missingSources: result.missingData.map(item => MISSING_SOURCE_LABELS[item.code] || item.source),
    warnings: result.warnings,
    supplyDecisions: result.openOrderDecisions,
    planningResult: result,
  };
}

export function planLegacyReplenishment({
  asOfDate,
  row,
  readiness,
  openOrders,
  policy,
  packaging = {},
  orderDraftQuantity = null,
}) {
  const planningResult = planReplenishment({
    asOfDate,
    productSku: String(row?.sku || '').trim(),
    planningVelocity: row?.planningVelocity ?? null,
    readiness,
    inventory: {
      amazonSellable: row?.usAmz ?? null,
      jspReserve: row?.usJsp ?? null,
      amazonInboundWithoutEta: Math.max(0, Number(row?.usAmzInbound || 0)),
      reportedOpenOrder: Math.max(0, Number(row?.order || 0)),
    },
    openOrders: (openOrders || []).map(normalizeLegacyOpenOrder),
    policy,
    packaging,
    orderDraftQuantity,
  });
  return toLegacyPlan(planningResult, policy);
}

export function getLegacySupplyDecision({ asOfDate, openOrder, policy }) {
  const quantity = Math.max(0, Number(openOrder?.quantity ?? openOrder?.qty ?? 0));
  const result = planReplenishment({
    asOfDate,
    productSku: '__SUPPLY_DECISION__',
    planningVelocity: null,
    readiness: { amazonInventory: true, jspInventory: true, openOrders: true },
    inventory: {
      amazonSellable: 0,
      jspReserve: 0,
      amazonInboundWithoutEta: 0,
      reportedOpenOrder: openOrder?.isReceived ? 0 : quantity,
    },
    openOrders: [normalizeLegacyOpenOrder({ ...openOrder, quantity }, 0)],
    policy,
    packaging: { unitsPerPallet: null },
    orderDraftQuantity: null,
  });
  const decision = result.openOrderDecisions[0];
  return {
    bucket: decision.bucket,
    orderState: decision.state,
    date: toLocalDate(decision.sellableDate),
  };
}

const browserInterface = Object.freeze({
  classifyCoverageDays,
  getPalletCatalogIssue,
  getLegacyOpenOrderState,
  getLegacySupplyDecision,
  planLegacyReplenishment,
});

if (typeof window !== 'undefined') window.SupplyPlanningLegacy = browserInterface;
