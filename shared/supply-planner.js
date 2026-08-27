const DAY_MS = 86_400_000;
const VALID_ORDER_STATES = new Set(['received', 'ordered', 'planned', 'stopped', 'unknown']);

export class PlannerInputError extends TypeError {
  constructor(productSku, path, code, message) {
    super(`[${productSku || 'unknown Product SKU'}] ${message}`);
    this.name = 'PlannerInputError';
    this.productSku = productSku || null;
    this.path = path;
    this.code = code;
  }
}

function fail(productSku, path, code, message) {
  throw new PlannerInputError(productSku, path, code, message);
}

function parseCalendarDate(value, productSku, path, { nullable = false } = {}) {
  if ((value === null || value === undefined || value === '') && nullable) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    fail(productSku, path, 'INVALID_DATE', `${path} must be a YYYY-MM-DD calendar date`);
  }
  const [year, month, day] = value.split('-').map(Number);
  const dayNumber = Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
  if (formatCalendarDate(dayNumber) !== value) {
    fail(productSku, path, 'INVALID_DATE', `${path} is not a real calendar date`);
  }
  return dayNumber;
}

function formatCalendarDate(dayNumber) {
  if (dayNumber === null || dayNumber === undefined) return null;
  return new Date(dayNumber * DAY_MS).toISOString().slice(0, 10);
}

function addCalendarDays(dayNumber, days) {
  return dayNumber + Math.floor(days);
}

function requireBoolean(value, productSku, path) {
  if (typeof value !== 'boolean') fail(productSku, path, 'INVALID_BOOLEAN', `${path} must be true or false`);
  return value;
}

function requireQuantity(value, productSku, path, { nullable = false } = {}) {
  if ((value === null || value === undefined) && nullable) return null;
  if (!Number.isFinite(value) || value < 0) {
    fail(productSku, path, 'INVALID_QUANTITY', `${path} must be a finite non-negative number`);
  }
  return value;
}

function requireInteger(value, productSku, path, min, max) {
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(productSku, path, 'INVALID_POLICY', `${path} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function normalizeInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail(null, 'input', 'INVALID_INPUT', 'planner input must be an object');
  }
  const productSku = String(input.productSku || '').trim();
  if (!productSku) fail(null, 'productSku', 'MISSING_PRODUCT_SKU', 'productSku is required');

  const asOfDay = parseCalendarDate(input.asOfDate, productSku, 'asOfDate');
  const readiness = input.readiness || {};
  const inventory = input.inventory || {};
  const policy = input.policy || {};
  const planningVelocity = input.planningVelocity;
  const normalized = {
    productSku,
    asOfDay,
    planningVelocity,
    readiness: {
      amazonInventory: requireBoolean(readiness.amazonInventory, productSku, 'readiness.amazonInventory'),
      jspInventory: requireBoolean(readiness.jspInventory, productSku, 'readiness.jspInventory'),
      openOrders: requireBoolean(readiness.openOrders, productSku, 'readiness.openOrders'),
    },
    inventory: {
      amazonSellable: requireQuantity(inventory.amazonSellable, productSku, 'inventory.amazonSellable', { nullable: true }),
      jspReserve: requireQuantity(inventory.jspReserve, productSku, 'inventory.jspReserve', { nullable: true }),
      amazonInboundWithoutEta: requireQuantity(inventory.amazonInboundWithoutEta ?? 0, productSku, 'inventory.amazonInboundWithoutEta'),
      reportedOpenOrder: requireQuantity(inventory.reportedOpenOrder ?? 0, productSku, 'inventory.reportedOpenOrder'),
    },
    policy: {
      leadTimeDays: requireInteger(policy.leadTimeDays, productSku, 'policy.leadTimeDays', 1, 365),
      transferTimeDays: requireInteger(policy.transferTimeDays, productSku, 'policy.transferTimeDays', 0, 90),
      targetDays: requireInteger(policy.targetDays, productSku, 'policy.targetDays', 0, 365),
      executableOrderIncrement: requireQuantity(policy.executableOrderIncrement, productSku, 'policy.executableOrderIncrement'),
    },
    orderDraftQuantity: input.orderDraftQuantity === null || input.orderDraftQuantity === undefined
      ? null
      : requireQuantity(input.orderDraftQuantity, productSku, 'orderDraftQuantity'),
  };
  if (normalized.policy.executableOrderIncrement <= 0) {
    fail(productSku, 'policy.executableOrderIncrement', 'INVALID_POLICY', 'policy.executableOrderIncrement must be greater than zero');
  }

  if (!Array.isArray(input.openOrders)) fail(productSku, 'openOrders', 'INVALID_ORDERS', 'openOrders must be an array');
  normalized.openOrders = input.openOrders.map((item, index) => {
    const path = `openOrders[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail(productSku, path, 'INVALID_ORDER', `${path} must be an object`);
    if (!VALID_ORDER_STATES.has(item.state)) {
      fail(productSku, `${path}.state`, 'INVALID_ORDER_STATE', `${path}.state is not a supported open-order state`);
    }
    return {
      id: String(item.id || `${productSku}-${index + 1}`),
      quantity: requireQuantity(item.quantity, productSku, `${path}.quantity`),
      state: item.state,
      loadingDay: parseCalendarDate(item.loadingDate, productSku, `${path}.loadingDate`, { nullable: true }),
      portArrivalDay: parseCalendarDate(item.portArrivalDate, productSku, `${path}.portArrivalDate`, { nullable: true }),
    };
  });
  return normalized;
}

function consumeStockForDays(stock, days, velocity) {
  const demand = Math.max(0, days) * velocity;
  if (stock >= demand) return { stock: stock - demand, shortageDays: 0 };
  return { stock: 0, shortageDays: Math.max(0, days - stock / velocity) };
}

function projectStockAcrossEvents(startStock, startDay, endDay, velocity, events) {
  let stock = Math.max(0, startStock);
  let shortageDays = 0;
  let cursorDay = startDay;
  for (const event of events) {
    const elapsedDays = Math.max(0, event.day - cursorDay);
    const consumed = consumeStockForDays(stock, elapsedDays, velocity);
    stock = consumed.stock + event.quantity;
    shortageDays += consumed.shortageDays;
    cursorDay = event.day;
  }
  const finalConsumed = consumeStockForDays(stock, Math.max(0, endDay - cursorDay), velocity);
  return { stock: finalConsumed.stock, shortageDays: shortageDays + finalConsumed.shortageDays };
}

function requiredQuantityAcrossEvents(startStock, startDay, endDay, velocity, events) {
  let stock = Math.max(0, startStock);
  let requiredQuantity = 0;
  let cursorDay = startDay;
  let scheduledQuantity = 0;
  for (const event of events) {
    scheduledQuantity += event.quantity;
    const demand = Math.max(0, event.day - cursorDay) * velocity;
    if (stock < demand) {
      requiredQuantity += demand - stock;
      stock = 0;
    } else {
      stock -= demand;
    }
    stock += event.quantity;
    cursorDay = event.day;
  }
  const finalDemand = Math.max(0, endDay - cursorDay) * velocity;
  if (stock < finalDemand) requiredQuantity += finalDemand - stock;
  else stock -= finalDemand;
  return { requiredQuantity, scheduledQuantity, endingStock: stock };
}

function firstStockoutDayAcrossEvents(startStock, startDay, endDay, velocity, events) {
  let stock = Math.max(0, startStock);
  let cursorDay = startDay;
  for (const event of events) {
    if (event.day > endDay) break;
    const elapsedDays = Math.max(0, event.day - cursorDay);
    const demand = elapsedDays * velocity;
    if (stock < demand) return cursorDay + stock / velocity;
    stock -= demand;
    stock += event.quantity;
    cursorDay = event.day;
  }
  const remainingDays = Math.max(0, endDay - cursorDay);
  if (stock < remainingDays * velocity) return cursorDay + stock / velocity;
  return null;
}

function continuousCoverageDays(startStock, startDay, velocity, events) {
  let stock = Math.max(0, startStock);
  let elapsedDays = 0;
  let cursorDay = startDay;
  for (const event of events) {
    const daysUntilEvent = Math.max(0, event.day - cursorDay);
    const demand = daysUntilEvent * velocity;
    if (stock < demand) return elapsedDays + stock / velocity;
    stock -= demand;
    stock += event.quantity;
    elapsedDays += daysUntilEvent;
    cursorDay = event.day;
  }
  return elapsedDays + stock / velocity;
}

function roundToIncrement(quantity, increment) {
  const nonNegativeQuantity = Math.max(0, quantity);
  if (nonNegativeQuantity <= 1e-9) return 0;
  return Math.ceil((nonNegativeQuantity - 1e-9) / increment) * increment;
}

function addWarning(warnings, code, order, extra = {}) {
  warnings.push({ code, orderId: order?.id || null, quantity: order?.quantity ?? extra.quantity ?? null, ...extra });
}

function classifyOpenOrders(input, dates) {
  const supply = {
    currentAmazonStock: input.inventory.amazonSellable ?? 0,
    jspReserve: input.inventory.jspReserve ?? 0,
    confirmedBeforeNew: 0,
    assumedBeforeNew: 0,
    plannedNotPlaced: 0,
    stopped: 0,
    unknownStateAssumed: 0,
    overdueAssumed: 0,
    conflictingSchedule: 0,
    unmatched: 0,
    amazonInboundWithoutEta: input.inventory.amazonInboundWithoutEta,
    scheduledWithinTarget: 0,
    later: 0,
    uncertain: input.inventory.amazonInboundWithoutEta,
  };
  const warnings = [];
  const decisions = [];
  const events = [];
  let breakdownQuantity = 0;

  if (supply.amazonInboundWithoutEta > 0) {
    addWarning(warnings, 'UNSCHEDULED_AMAZON_INBOUND', null, { quantity: supply.amazonInboundWithoutEta });
  }

  for (const openOrder of input.openOrders) {
    if (openOrder.state === 'received') {
      decisions.push({ id: openOrder.id, state: openOrder.state, bucket: 'received', sellableDate: null });
      continue;
    }
    breakdownQuantity += openOrder.quantity;
    if (openOrder.state === 'planned') {
      supply.plannedNotPlaced += openOrder.quantity;
      supply.uncertain += openOrder.quantity;
      addWarning(warnings, 'PLANNED_ORDER_EXCLUDED', openOrder);
      decisions.push({ id: openOrder.id, state: openOrder.state, bucket: 'planned', sellableDate: null });
      continue;
    }
    if (openOrder.state === 'stopped') {
      supply.stopped += openOrder.quantity;
      supply.uncertain += openOrder.quantity;
      addWarning(warnings, 'STOPPED_ORDER_EXCLUDED', openOrder);
      decisions.push({ id: openOrder.id, state: openOrder.state, bucket: 'stopped', sellableDate: null });
      continue;
    }
    if (openOrder.portArrivalDay !== null && openOrder.portArrivalDay < input.asOfDay) {
      supply.assumedBeforeNew += openOrder.quantity;
      supply.overdueAssumed += openOrder.quantity;
      supply.uncertain += openOrder.quantity;
      addWarning(warnings, 'ASSUMED_OVERDUE_ORDER', openOrder, { date: formatCalendarDate(openOrder.portArrivalDay) });
      decisions.push({ id: openOrder.id, state: openOrder.state, bucket: 'overdue', sellableDate: null });
      continue;
    }
    if (openOrder.portArrivalDay === null) {
      if (openOrder.loadingDay !== null && openOrder.loadingDay > dates.newOrderPortArrivalDay) {
        supply.conflictingSchedule += openOrder.quantity;
        supply.uncertain += openOrder.quantity;
        addWarning(warnings, 'CONFLICTING_SCHEDULE_EXCLUDED', openOrder, { date: formatCalendarDate(openOrder.loadingDay) });
        decisions.push({ id: openOrder.id, state: openOrder.state, bucket: 'conflicting', sellableDate: null });
        continue;
      }
      supply.assumedBeforeNew += openOrder.quantity;
      supply.uncertain += openOrder.quantity;
      if (openOrder.state === 'unknown') {
        supply.unknownStateAssumed += openOrder.quantity;
        addWarning(warnings, 'ASSUMED_UNKNOWN_ORDER', openOrder);
      } else {
        addWarning(warnings, 'ASSUMED_UNDATED_ORDER', openOrder);
      }
      decisions.push({ id: openOrder.id, state: openOrder.state, bucket: 'assumed', sellableDate: null });
      continue;
    }

    const sellableDay = addCalendarDays(openOrder.portArrivalDay, input.policy.transferTimeDays);
    const event = { id: openOrder.id, day: sellableDay, quantity: openOrder.quantity };
    events.push(event);
    let bucket = 'later';
    if (sellableDay <= dates.newOrderSellableDay) {
      bucket = 'before';
      supply.confirmedBeforeNew += openOrder.quantity;
    } else if (sellableDay <= dates.targetEndDay) {
      bucket = 'target';
      supply.scheduledWithinTarget += openOrder.quantity;
    } else {
      supply.later += openOrder.quantity;
    }
    if (openOrder.state === 'unknown') addWarning(warnings, 'UNKNOWN_ORDER_STATE', openOrder);
    decisions.push({ id: openOrder.id, state: openOrder.state, bucket, sellableDate: formatCalendarDate(sellableDay) });
  }

  supply.unmatched = Math.max(0, input.inventory.reportedOpenOrder - breakdownQuantity);
  if (supply.unmatched > 0) {
    supply.uncertain += supply.unmatched;
    addWarning(warnings, 'UNMATCHED_OPEN_ORDER', null, { quantity: supply.unmatched });
  }
  if (supply.jspReserve > 0) {
    events.push({ id: 'JSP_RESERVE', day: addCalendarDays(input.asOfDay, input.policy.transferTimeDays), quantity: supply.jspReserve });
  }
  events.sort((a, b) => a.day - b.day || a.id.localeCompare(b.id));
  return { supply, warnings, decisions, events };
}

function statusResult(input, dates, classification, status, missingData, noVelocity) {
  const currentStock = (input.inventory.amazonSellable ?? 0) + (input.inventory.jspReserve ?? 0);
  return {
    status,
    productSku: input.productSku,
    missingData,
    noVelocity,
    warnings: classification.warnings,
    dates: {
      asOfDate: formatCalendarDate(input.asOfDay),
      newOrderPortArrivalDate: formatCalendarDate(dates.newOrderPortArrivalDay),
      newOrderSellableDate: formatCalendarDate(dates.newOrderSellableDay),
      targetEndDate: formatCalendarDate(dates.targetEndDay),
      confirmedStockoutDate: null,
      orderByDate: null,
      uncertainSupplyDeadline: null,
    },
    supply: classification.supply,
    openOrderDecisions: classification.decisions,
    projection: {
      currentStock,
      leadDemand: null,
      confirmedStockAtArrival: null,
      assumedStockAtArrival: null,
    },
    recommendation: {
      canRecommend: false,
      rawQuantity: 0,
      executableQuantity: 0,
      appliedQuantity: input.orderDraftQuantity ?? 0,
      increment: input.policy.executableOrderIncrement,
    },
    coverage: {
      arrivalDays: null,
      bookDays: null,
      postOrderTotalDays: null,
      postOrderContinuousDays: null,
      shortageBeforeArrivalDays: null,
    },
  };
}

export function planReplenishment(rawInput) {
  const input = normalizeInput(rawInput);
  const dates = {
    newOrderPortArrivalDay: addCalendarDays(input.asOfDay, input.policy.leadTimeDays),
  };
  dates.newOrderSellableDay = addCalendarDays(dates.newOrderPortArrivalDay, input.policy.transferTimeDays);
  dates.targetEndDay = addCalendarDays(dates.newOrderSellableDay, input.policy.targetDays);

  const classification = classifyOpenOrders(input, dates);
  const missingData = [];
  if (!input.readiness.amazonInventory || input.inventory.amazonSellable === null) {
    missingData.push({ source: 'Amazon inventory', code: 'AMAZON_INVENTORY' });
  }
  if (!input.readiness.jspInventory || input.inventory.jspReserve === null) {
    missingData.push({ source: 'JSP inventory', code: 'JSP_INVENTORY' });
  }
  if (!input.readiness.openOrders) missingData.push({ source: 'JAM orders', code: 'OPEN_ORDERS' });

  const velocity = input.planningVelocity;
  const noVelocity = velocity === null || velocity === undefined
    ? { reason: 'missing' }
    : (!Number.isFinite(velocity) ? { reason: 'invalid' } : (velocity <= 0 ? { reason: 'non-positive' } : null));
  if (noVelocity) return statusResult(input, dates, classification, 'no-velocity', missingData, noVelocity);
  if (missingData.length) return statusResult(input, dates, classification, 'missing-data', missingData, null);

  const eventsBeforeNew = classification.events.filter(event => event.day <= dates.newOrderSellableDay);
  const eventsWithinTarget = classification.events.filter(event => event.day > dates.newOrderSellableDay && event.day <= dates.targetEndDay);
  const planningHorizonEndDay = addCalendarDays(input.asOfDay, 1095);
  const confirmedStockoutExactDay = firstStockoutDayAcrossEvents(
    input.inventory.amazonSellable,
    input.asOfDay,
    planningHorizonEndDay,
    velocity,
    classification.events,
  );
  const confirmedStockoutDay = confirmedStockoutExactDay === null ? null : Math.floor(confirmedStockoutExactDay);
  const orderByDay = confirmedStockoutExactDay === null
    ? null
    : Math.floor(confirmedStockoutExactDay - input.policy.leadTimeDays - input.policy.transferTimeDays);
  const confirmedProjection = projectStockAcrossEvents(
    input.inventory.amazonSellable,
    input.asOfDay,
    dates.newOrderSellableDay,
    velocity,
    eventsBeforeNew,
  );
  const assumedProjection = projectStockAcrossEvents(
    input.inventory.amazonSellable + classification.supply.assumedBeforeNew,
    input.asOfDay,
    dates.newOrderSellableDay,
    velocity,
    eventsBeforeNew,
  );
  const targetPlan = requiredQuantityAcrossEvents(
    assumedProjection.stock,
    dates.newOrderSellableDay,
    dates.targetEndDay,
    velocity,
    eventsWithinTarget,
  );
  const rawQuantity = Math.ceil(Math.max(0, targetPlan.requiredQuantity));
  const executableQuantity = roundToIncrement(rawQuantity, input.policy.executableOrderIncrement);
  const appliedQuantity = input.orderDraftQuantity ?? executableQuantity;
  const postOrderStock = assumedProjection.stock + appliedQuantity;
  const postOrderTotalDays = (postOrderStock + targetPlan.scheduledQuantity) / velocity;
  const postOrderContinuousDays = continuousCoverageDays(
    postOrderStock,
    dates.newOrderSellableDay,
    velocity,
    eventsWithinTarget,
  );
  const uncertainSupplyDeadlineDay = classification.supply.uncertain > 0
    ? (confirmedStockoutDay ?? planningHorizonEndDay)
    : null;

  return {
    status: 'ready',
    productSku: input.productSku,
    missingData: [],
    noVelocity: null,
    warnings: classification.warnings,
    dates: {
      asOfDate: formatCalendarDate(input.asOfDay),
      newOrderPortArrivalDate: formatCalendarDate(dates.newOrderPortArrivalDay),
      newOrderSellableDate: formatCalendarDate(dates.newOrderSellableDay),
      targetEndDate: formatCalendarDate(dates.targetEndDay),
      confirmedStockoutDate: formatCalendarDate(confirmedStockoutDay),
      orderByDate: formatCalendarDate(orderByDay),
      uncertainSupplyDeadline: formatCalendarDate(uncertainSupplyDeadlineDay),
    },
    supply: classification.supply,
    openOrderDecisions: classification.decisions,
    projection: {
      currentStock: input.inventory.amazonSellable + input.inventory.jspReserve,
      leadDemand: (input.policy.leadTimeDays + input.policy.transferTimeDays) * velocity,
      confirmedStockAtArrival: confirmedProjection.stock,
      assumedStockAtArrival: assumedProjection.stock,
    },
    recommendation: {
      canRecommend: true,
      rawQuantity,
      executableQuantity,
      appliedQuantity,
      increment: input.policy.executableOrderIncrement,
    },
    coverage: {
      arrivalDays: assumedProjection.stock / velocity,
      bookDays: (input.inventory.amazonSellable + input.inventory.jspReserve + input.inventory.reportedOpenOrder) / velocity,
      postOrderTotalDays,
      postOrderContinuousDays,
      shortageBeforeArrivalDays: confirmedProjection.shortageDays,
    },
  };
}
