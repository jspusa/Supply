/** Summarize eligible supply without changing replenishment recommendations. */
export function describeDecisionCoverage(plan, planningVelocity) {
  const units = value => Math.max(0, Number.isFinite(Number(value)) ? Number(value) : 0);
  const supply = plan?.planningResult?.supply;
  const eligibleOrderUnits = supply
    ? units(supply.confirmedBeforeNew) + units(supply.assumedBeforeNew) + units(supply.scheduledWithinTarget) + units(supply.later)
    : units(plan?.inboundBefore) + units(plan?.assumedBeforeNew) + units(plan?.scheduledWithinTarget) + units(plan?.laterInbound);
  const excludedOrderUnits = units(plan?.plannedNotPlaced) + units(plan?.stoppedInbound) + units(plan?.conflictingScheduleInbound);
  const assumedOrderUnits = units(plan?.assumedBeforeNew);
  const currentUnits = units(plan?.currentAmzStock) + units(plan?.jspReserve);
  const ready = Boolean(plan?.canRecommend && Number.isFinite(planningVelocity) && planningVelocity > 0);
  const fmt = value => value.toLocaleString('en-US', { maximumFractionDigits:2 });
  const detail = ready ? [
    '(AMZ ' + fmt(units(plan.currentAmzStock)) + ' + JSP ' + fmt(units(plan.jspReserve)) + ' + 納入既有訂單 ' + fmt(eligibleOrderUnits) + ') ÷ 每日速度 ' + fmt(planningVelocity) + '；全部已換算為 AMZ 單位。',
    assumedOrderUnits ? '其中 ' + fmt(assumedOrderUnits) + ' 單位依舊單假設納入，ETA 逾期、空白或明細不足仍需追貨。' : '',
    excludedOrderUnits ? '另有 ' + fmt(excludedOrderUnits) + ' 單位因還沒下單、STOP 或排程衝突而未納入。' : '',
    plan.amzInboundNoEta > 0 ? 'AMZ Inbound 未重複加計。' : '',
    '這是庫存與訂單合計的可售天數；未扣等待期間銷售，也不保證到貨前不會斷貨。',
  ].filter(Boolean).join(' ') : plan?.status === 'no-velocity' ? '無有效銷售速度，無法計算可售天數。' : '資料不足，請補齊 ' + ((plan?.missingSources || []).join('、') || 'H10、JSP 庫存及 JAM／FY 訂單') + '。';
  return {
    title:'含訂單預計可售天數', status:ready ? 'ready' : 'unavailable',
    days:ready ? (currentUnits + eligibleOrderUnits) / planningVelocity : null,
    currentDays:ready ? currentUnits / planningVelocity : null,
    orderDays:ready ? eligibleOrderUnits / planningVelocity : null,
    eligibleOrderUnits, excludedOrderUnits, assumedOrderUnits, detail,
  };
}
if (typeof window !== 'undefined') window.SupplyDecisionCoverage = Object.freeze({ describeDecisionCoverage });
