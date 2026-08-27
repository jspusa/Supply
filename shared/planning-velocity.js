const H10_ASIN = 'B[0-9A-Z]{9}';
const DAY_MS = 86_400_000;

function normalizeProductSku(value) {
  return String(value ?? '').trim().toUpperCase();
}

function buildAliasMap(aliases) {
  if (aliases instanceof Map) return new Map(Array.from(aliases, ([alias, productSku]) => [normalizeProductSku(alias), normalizeProductSku(productSku)]));
  if (Array.isArray(aliases)) {
    const map = new Map();
    for (const group of aliases) {
      if (!Array.isArray(group) || !group.length) continue;
      const productSku = normalizeProductSku(group[0]);
      for (const alias of group) map.set(normalizeProductSku(alias), productSku);
    }
    return map;
  }
  return new Map(Object.entries(aliases || {}).map(([alias, productSku]) => [normalizeProductSku(alias), normalizeProductSku(productSku)]));
}

function resolveProductSku(value, aliasMap) {
  const sourceSku = normalizeProductSku(value);
  return aliasMap.get(sourceSku) || sourceSku;
}

function parseFiniteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = String(value ?? '').trim();
  if (!text || !/^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(text)) return null;
  const number = Number(text.replaceAll(',', ''));
  return Number.isFinite(number) ? number : null;
}

function parseCalendarDay(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const [year, month, day] = text.split('-').map(Number);
  const dayNumber = Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
  return new Date(dayNumber * DAY_MS).toISOString().slice(0, 10) === text ? dayNumber : null;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function normalizeHistory(samples, aliasMap) {
  const byProductDate = new Map();
  for (const sample of Array.isArray(samples) ? samples : []) {
    const productSku = resolveProductSku(sample?.productSku, aliasMap);
    const date = String(sample?.date ?? '').trim();
    const value = parseFiniteNumber(sample?.h10SourceVelocity);
    if (!productSku || parseCalendarDay(date) === null || value === null || value <= 0) continue;
    byProductDate.set(`${productSku}\u0000${date}`, { productSku, date, h10SourceVelocity: value });
  }
  return Array.from(byProductDate.values());
}

function parseH10Source(rawText, aliasMap) {
  const text = String(rawText || '');
  const observations = [];
  const seenSpans = new Set();
  const patterns = [
    new RegExp(`(${H10_ASIN})\\s+([A-Z0-9][A-Z0-9-]{1,24})\\s+(-?[^\\s]+)`, 'g'),
    new RegExp(`(${H10_ASIN})([A-Z0-9][A-Z0-9-]{1,24})\\s+(-?[^\\s]+)`, 'g'),
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const asin = normalizeProductSku(match[1]);
      const sourceSku = normalizeProductSku(match[2]);
      const rawValue = match[3];
      const span = `${match.index}:${pattern.lastIndex}:${asin}:${sourceSku}:${rawValue}`;
      if (seenSpans.has(span)) continue;
      seenSpans.add(span);
      observations.push({
        productSku: resolveProductSku(sourceSku, aliasMap),
        sourceSku,
        asin,
        rawValue,
        value: parseFiniteNumber(rawValue),
        occurrenceIndex: match.index,
      });
    }
  }
  observations.sort((a, b) => a.occurrenceIndex - b.occurrenceIndex);
  return observations;
}

export function parseH10Observations(rawText, options = {}) {
  const aliasMap = buildAliasMap(options.productSkuAliases);
  return parseH10Source(rawText, aliasMap).map(({ productSku, sourceSku, asin, value, rawValue }) => ({
    productSku,
    sourceSku,
    asin,
    value,
    rawValue,
  }));
}

function normalizeHeader(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[\s_\-()（）]+/g, '');
}

function findColumn(header, candidates) {
  const normalizedCandidates = candidates.map(normalizeHeader);
  return header.findIndex(cell => {
    const normalized = normalizeHeader(cell);
    return normalizedCandidates.some(candidate => normalized === candidate || normalized.includes(candidate));
  });
}

function parseInventoryEvidence(rows, aliasMap) {
  if (!Array.isArray(rows)) return [];
  let headerIndex = -1;
  let columns = null;
  for (let index = 0; index < Math.min(rows.length, 30); index += 1) {
    const header = Array.isArray(rows[index]) ? rows[index] : [];
    const sku = findColumn(header, ['sku']);
    const sellable = findColumn(header, ['sellable inventory', 'sellable']);
    const daysOfSupply = findColumn(header, ['days of supply']);
    if (sku >= 0 && sellable >= 0 && daysOfSupply >= 0) {
      headerIndex = index;
      columns = { sku, sellable, daysOfSupply, inbound: findColumn(header, ['inbound']) };
      break;
    }
  }
  if (!columns) return [];

  const evidence = [];
  for (let rowIndex = headerIndex + 1; rowIndex < rows.length; rowIndex += 1) {
    const row = Array.isArray(rows[rowIndex]) ? rows[rowIndex] : [];
    const sourceSku = normalizeProductSku(row[columns.sku]);
    if (!sourceSku) continue;
    evidence.push({
      productSku: resolveProductSku(sourceSku, aliasMap),
      sourceSku,
      rowIndex,
      rawSellable: row[columns.sellable],
      rawDaysOfSupply: row[columns.daysOfSupply],
      rawInbound: columns.inbound >= 0 ? row[columns.inbound] : null,
      sellable: parseFiniteNumber(row[columns.sellable]),
      daysOfSupply: parseFiniteNumber(row[columns.daysOfSupply]),
      inbound: columns.inbound >= 0 ? parseFiniteNumber(row[columns.inbound]) : null,
    });
  }
  return evidence;
}

function addRisk(risks, code, message, evidence = {}) {
  if (!risks.some(risk => risk.code === code)) risks.push({ code, message, evidence });
}

function buildAssessment(productSku, h10Observations, inventoryEvidence, isHotSku, historyMedian) {
  const validH10Values = h10Observations.map(item => item.value).filter(value => Number.isFinite(value) && value > 0);
  const ignoredEvidence = h10Observations
    .filter(item => !Number.isFinite(item.value) || item.value <= 0)
    .map(item => ({
      code: 'INVALID_H10_SOURCE',
      kind: 'h10-source',
      sourceSku: item.sourceSku,
      asin: item.asin,
      rawValue: item.rawValue,
      reason: Number.isFinite(item.value) ? 'non-positive' : 'nonnumeric-or-nonfinite',
    }));
  const candidates = [];
  if (validH10Values.length) candidates.push({ kind: 'h10-source', value: Math.max(...validH10Values) });

  for (const evidence of inventoryEvidence) {
    if (Number.isFinite(evidence.sellable) && evidence.sellable > 0 && Number.isFinite(evidence.daysOfSupply) && evidence.daysOfSupply > 0) {
      const value = evidence.sellable / evidence.daysOfSupply;
      if (Number.isFinite(value) && value > 0) candidates.push({ kind: 'sellable-over-days-of-supply', value, rowIndex: evidence.rowIndex });
    } else {
      ignoredEvidence.push({
        code: 'INVALID_INVENTORY_DOS',
        kind: 'sellable-over-days-of-supply',
        sourceSku: evidence.sourceSku,
        rowIndex: evidence.rowIndex,
        rawSellable: evidence.rawSellable,
        rawDaysOfSupply: evidence.rawDaysOfSupply,
        sellable: evidence.sellable,
        daysOfSupply: evidence.daysOfSupply,
        reason: 'requires-positive-finite-sellable-and-days-of-supply',
      });
    }
  }
  if (isHotSku) candidates.push({ kind: 'hot-sku-floor', value: 10 });
  if (historyMedian !== null) candidates.push({ kind: 'local-28-day-median', value: historyMedian });

  const velocityRisks = [];
  const positiveSignals = [
    ...validH10Values,
    ...candidates.filter(candidate => candidate.kind === 'sellable-over-days-of-supply').map(candidate => candidate.value),
    ...(historyMedian === null ? [] : [historyMedian]),
  ];
  if (positiveSignals.length > 1) {
    const min = Math.min(...positiveSignals);
    const max = Math.max(...positiveSignals);
    if ((max - min) / min > 0.2) {
      addRisk(velocityRisks, 'POSITIVE_SIGNAL_DISAGREEMENT', '正向速度證據差異超過 20%，H10 Source Velocity 可能衝突或低估。', { min, max });
    }
  }
  if (inventoryEvidence.some(item => item.sellable === 0)) {
    addRisk(velocityRisks, 'ZERO_SELLABLE', 'H10 庫存證據包含 Sellable 0；這是 Velocity Risk，並非已證明缺貨。');
  }
  if (inventoryEvidence.some(item => Number.isFinite(item.daysOfSupply) && item.daysOfSupply >= 0 && item.daysOfSupply <= 7)) {
    addRisk(velocityRisks, 'LOW_DAYS_OF_SUPPLY', 'H10 庫存證據包含 7 天以下的 Days of Supply；可能低估需求。');
  }
  const highestH10 = validH10Values.length ? Math.max(...validH10Values) : null;
  if (isHotSku && highestH10 !== null && highestH10 < 10) {
    addRisk(velocityRisks, 'HOT_SOURCE_BELOW_FLOOR', 'Hot SKU 的 H10 Source Velocity 低於 10，Planning Velocity 使用保護下限。', { h10SourceVelocity: highestH10, floor: 10 });
  }
  if (highestH10 !== null && historyMedian !== null && (historyMedian - highestH10) / historyMedian > 0.4) {
    addRisk(velocityRisks, 'HISTORICAL_DECLINE', '目前 H10 Source Velocity 較最近 28 天本機歷史中位數下降超過 40%。', { h10SourceVelocity: highestH10, historyMedian });
  }

  const planningVelocity = candidates.length ? Math.max(...candidates.map(candidate => candidate.value)) : null;
  const winningEvidence = planningVelocity === null
    ? []
    : candidates
      .filter(candidate => Math.abs(candidate.value - planningVelocity) < 1e-12)
      .map(candidate => ({ kind: candidate.kind, value: candidate.value }));
  const adjustmentReasons = [];
  if (highestH10 !== null && planningVelocity > highestH10) {
    if (winningEvidence.some(evidence => evidence.kind === 'hot-sku-floor')) {
      adjustmentReasons.push({ code: 'HOT_SKU_FLOOR_APPLIED', message: `Hot SKU 保護下限將 Planning Velocity 從 ${highestH10} 提高到 ${planningVelocity}。` });
    }
    if (winningEvidence.some(evidence => evidence.kind === 'local-28-day-median')) {
      adjustmentReasons.push({ code: 'LOCAL_HISTORY_MEDIAN_APPLIED', message: `最近 28 天本機歷史中位數將 Planning Velocity 從 ${highestH10} 提高到 ${planningVelocity}。` });
    }
    if (winningEvidence.some(evidence => evidence.kind === 'sellable-over-days-of-supply')) {
      adjustmentReasons.push({ code: 'INVENTORY_DOS_APPLIED', message: `Sellable / Days of Supply 證據將 Planning Velocity 從 ${highestH10} 提高到 ${planningVelocity}。` });
    }
  }

  return {
    productSku,
    status: planningVelocity === null ? 'no-valid-candidate' : 'ready',
    h10SourceVelocity: {
      values: validH10Values,
      min: validH10Values.length ? Math.min(...validH10Values) : null,
      max: validH10Values.length ? Math.max(...validH10Values) : null,
    },
    candidates,
    planningVelocity,
    winningEvidence,
    adjustmentReasons,
    velocityRisks,
    ignoredEvidence,
    historyMedian,
  };
}

export function buildPlanningVelocities(rawInput = {}) {
  const aliasMap = buildAliasMap(rawInput.productSkuAliases);
  const hotProductSkus = new Set((rawInput.hotProductSkus || []).map(value => resolveProductSku(value, aliasMap)));
  const h10Observations = parseH10Source(rawInput.rawH10Text, aliasMap);
  const inventoryEvidence = parseInventoryEvidence(rawInput.inventoryRows, aliasMap);
  const asOfDay = parseCalendarDay(rawInput.asOfDate);
  const sourceObservedOn = String(rawInput.sourceObservedOn ?? '').trim();
  const sourceObservedDay = parseCalendarDay(sourceObservedOn);
  const historyAnchorDay = sourceObservedDay !== null && asOfDay !== null && sourceObservedDay <= asOfDay ? sourceObservedDay : null;
  const normalizedHistory = normalizeHistory(rawInput.historySamples, aliasMap);
  const historyWindow = normalizedHistory.filter(sample => {
    const day = parseCalendarDay(sample.date);
    return historyAnchorDay !== null && day >= historyAnchorDay - 28 && day <= historyAnchorDay - 1;
  });
  const productSkus = new Set([
    ...h10Observations.map(item => item.productSku),
    ...inventoryEvidence.map(item => item.productSku),
    ...historyWindow.map(item => item.productSku),
    ...hotProductSkus,
  ]);
  const assessments = Array.from(productSkus)
    .sort()
    .map(productSku => {
      const historyMedian = median(historyWindow
        .filter(sample => sample.productSku === productSku)
        .map(sample => sample.h10SourceVelocity));
      return buildAssessment(
        productSku,
        h10Observations.filter(item => item.productSku === productSku),
        inventoryEvidence.filter(item => item.productSku === productSku),
        hotProductSkus.has(productSku),
        historyMedian,
      );
    });

  const retainedHistory = normalizedHistory.filter(sample => {
    const day = parseCalendarDay(sample.date);
    return asOfDay !== null && day >= asOfDay - 27 && day <= asOfDay;
  });
  const nextHistoryByProductDate = new Map(retainedHistory.map(sample => [`${sample.productSku}\u0000${sample.date}`, sample]));
  if (sourceObservedDay !== null && asOfDay !== null && sourceObservedDay >= asOfDay - 27 && sourceObservedDay <= asOfDay) {
    const observedProductSkus = new Set(h10Observations.map(item => item.productSku));
    observedProductSkus.forEach(productSku => nextHistoryByProductDate.delete(`${productSku}\u0000${sourceObservedOn}`));
    for (const assessment of assessments) {
      if (assessment.h10SourceVelocity.max === null) continue;
      const sample = { productSku: assessment.productSku, date: sourceObservedOn, h10SourceVelocity: assessment.h10SourceVelocity.max };
      nextHistoryByProductDate.set(`${sample.productSku}\u0000${sample.date}`, sample);
    }
  }
  const nextHistorySamples = Array.from(nextHistoryByProductDate.values())
    .sort((a, b) => a.productSku.localeCompare(b.productSku) || a.date.localeCompare(b.date));

  return {
    assessments,
    h10Observations: h10Observations.map(({ productSku, sourceSku, asin, value, rawValue }) => ({
      productSku,
      sourceSku,
      asin,
      value,
      rawValue,
    })),
    inventorySummary: { evidence: inventoryEvidence },
    nextHistorySamples,
  };
}

const browserInterface = Object.freeze({ buildPlanningVelocities, parseH10Observations });

if (typeof window !== 'undefined') window.SupplyVelocity = browserInterface;
