export const WORKSPACE_IDS = Object.freeze([
  'today',
  'data',
  'recommendations',
  'orders',
  'analysis',
]);

export const LEGACY_WORKSPACE_HASHES = Object.freeze({
  '#decisionDashboard':'recommendations',
  '#uploadCard':'data',
  '#reorderCard':'recommendations',
  '#generatorCard':'orders',
  '#skuDecisionTreeCard':'analysis',
  '#autoDecisionTreeCard':'analysis',
  '#mainCard':'analysis',
  '#hotCard':'analysis',
  '#newCard':'analysis',
  '#salesPieDetails':'analysis',
  '#salesGanttDetails':'analysis',
  '#otherToolsDetails':'analysis',
});

const WORKSPACE_SET = new Set(WORKSPACE_IDS);
const HASH_TO_WORKSPACE = new Map([
  ...WORKSPACE_IDS.map(workspace => [`#${workspace}`, workspace]),
  ...Object.entries(LEGACY_WORKSPACE_HASHES),
].map(([hash, workspace]) => [hash.toLowerCase(), workspace]));

function isRecord(value) {
  return Boolean(value) && !Array.isArray(value) && typeof value === 'object';
}

function extractHash(value) {
  if (isRecord(value) && typeof value.hash === 'string') return value.hash;
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) return '';
  if (text.startsWith('#')) return text;
  try {
    return new URL(text, 'https://supply.invalid/').hash;
  } catch {
    return '';
  }
}

function workspaceFromHash(value) {
  let hash = extractHash(value);
  try {
    hash = decodeURIComponent(hash);
  } catch {
    return null;
  }
  return HASH_TO_WORKSPACE.get(hash.toLowerCase()) || null;
}

function canonicalWorkspace(value) {
  const workspace = String(value ?? '').trim().toLowerCase();
  return WORKSPACE_SET.has(workspace) ? workspace : null;
}

export function resolveInitialWorkspace({ url, hash, preference } = {}) {
  return workspaceFromHash(url ?? hash) || canonicalWorkspace(preference) || 'today';
}

export function workspaceHash(workspace) {
  return `#${canonicalWorkspace(workspace) || 'today'}`;
}

function normalizeRows(value, field, issues) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    issues.push({ code:`INVALID_${field.toUpperCase()}` });
    return [];
  }
  const rows = value.filter(isRecord);
  if (rows.length !== value.length) issues.push({ code:`INVALID_${field.toUpperCase()}_ROW` });
  return rows;
}

function readinessProjection(value, issues) {
  if (value === undefined || value === null) return { state:'empty', ready:0, total:0, missing:0 };
  let entries;
  if (Array.isArray(value)) {
    entries = value.map((item, index) => [String(item?.id ?? item?.source ?? index), item]);
  } else if (isRecord(value)) {
    entries = Object.entries(value);
  } else {
    issues.push({ code:'INVALID_SOURCE_READINESS' });
    return { state:'invalid', ready:0, total:0, missing:0 };
  }
  let ready = 0;
  let started = 0;
  for (const [, item] of entries) {
    const isReady = item === true || item?.ready === true || item?.status === 'ready';
    const isStarted = isReady || item?.started === true || item?.status === 'loading' || item?.status === 'incomplete';
    if (isReady) ready += 1;
    if (isStarted) started += 1;
  }
  const total = entries.length;
  return {
    state:total === 0 || started === 0 ? 'empty' : ready === total ? 'ready' : 'incomplete',
    ready,
    total,
    missing:total - ready,
  };
}

function productSku(row) {
  return String(row?.productSku ?? row?.sku ?? '').trim().toUpperCase();
}

function finitePositive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function riskSignals(row) {
  const candidates = [
    row?.velocityAssessment?.velocityRisks,
    row?.velocityRisks,
    row?.risks,
  ];
  return candidates.find(Array.isArray) || [];
}

function formatVelocity(value) {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(4)));
}

function velocitySourceValues(row) {
  const values = row?.velocityAssessment?.h10SourceVelocity?.values;
  if (Array.isArray(values)) return values.map(finitePositive).filter(value => value !== null);
  const single = finitePositive(row?.h10SourceVelocity);
  return single === null ? [] : [single];
}

function selectHighestPriorityRisk(priorityRows, riskRows) {
  const risksBySku = new Map(riskRows.map(row => [productSku(row), row]).filter(([sku]) => sku));
  for (const row of priorityRows) {
    const match = risksBySku.get(productSku(row));
    if (match) return match;
  }
  return riskRows.reduce((best, row) => {
    if (!best) return row;
    const score = finitePositive(row.priorityScore) ?? -Infinity;
    const bestScore = finitePositive(best.priorityScore) ?? -Infinity;
    return score > bestScore ? row : best;
  }, null);
}

function velocityRiskProjection(row) {
  if (!row) return null;
  const sku = productSku(row) || null;
  const signals = riskSignals(row);
  const signalCount = Number.isInteger(row.velocityRiskCount) && row.velocityRiskCount > 0
    ? row.velocityRiskCount
    : Math.max(1, signals.length);
  const sourceValues = velocitySourceValues(row);
  const planningVelocity = finitePositive(row.planningVelocity);
  const evidence = [
    sourceValues.length ? `H10 Source Velocity ${sourceValues.map(formatVelocity).join(' / ')}` : null,
    planningVelocity === null ? null : `Planning Velocity ${formatVelocity(planningVelocity)}`,
  ].filter(Boolean).join('；');
  const subject = sku || '最高優先品項';
  return {
    productSku:sku,
    signalCount,
    text:`${subject}：${evidence ? `${evidence}。` : ''}共 ${signalCount} 項 Velocity Risk，表示速度證據可能衝突或被低估；不代表已證實斷貨或損失銷售。`,
  };
}

function orderGroupProjection(orderDraft, issues) {
  const counts = { taiwan:0, vietnam:0, subcontract:0, total:0 };
  if (orderDraft === undefined || orderDraft === null) return counts;
  if (!isRecord(orderDraft) || !isRecord(orderDraft.groupOrder)) {
    issues.push({ code:'INVALID_ORDER_DRAFT' });
    return counts;
  }
  for (const group of ['taiwan', 'vietnam', 'subcontract']) {
    const rows = orderDraft.groupOrder[group];
    if (!Array.isArray(rows)) {
      issues.push({ code:'INVALID_ORDER_GROUP', group });
      continue;
    }
    counts[group] = rows.length;
    counts.total += rows.length;
  }
  return counts;
}

function nextAction({ readiness, priorityCount, highestPriorityVelocityRisk, groupCounts, issues }) {
  if (readiness.state === 'invalid' || issues.length) {
    return { id:'review-data', workspace:'data', hash:'#data', label:'檢查資料', reason:'資料狀態或輸入格式需要確認。' };
  }
  if (readiness.state === 'empty') {
    return { id:'prepare-data', workspace:'data', hash:'#data', label:'開始準備資料', reason:'尚未讀取資料。' };
  }
  if (readiness.state !== 'ready') {
    return { id:'complete-data', workspace:'data', hash:'#data', label:'補齊資料', reason:`還有 ${readiness.missing} 個資料來源未就緒。` };
  }
  if (highestPriorityVelocityRisk) {
    const suffix = highestPriorityVelocityRisk.productSku ? ` ${highestPriorityVelocityRisk.productSku}` : '';
    return { id:'review-velocity-risk', workspace:'recommendations', hash:'#recommendations', label:`查看${suffix} 的 Velocity Risk`, reason:'先理解可能低估的速度證據。' };
  }
  if (priorityCount > 0) {
    return { id:'review-priorities', workspace:'recommendations', hash:'#recommendations', label:`查看 ${priorityCount} 個優先品項`, reason:'先處理目前優先順序最高的建議。' };
  }
  if (groupCounts.total > 0) {
    return { id:'continue-order', workspace:'orders', hash:'#orders', label:`繼續整理 ${groupCounts.total} 個訂單品項`, reason:'訂單草稿已有品項。' };
  }
  return { id:'review-analysis', workspace:'analysis', hash:'#analysis', label:'查看分析', reason:'資料已就緒，目前沒有待處理的優先品項或訂單草稿。' };
}

export function projectTodaySummary(input = {}) {
  const issues = [];
  const state = isRecord(input) ? input : {};
  if (!isRecord(input)) issues.push({ code:'INVALID_SUMMARY_INPUT' });
  const readiness = readinessProjection(state.sourceReadiness, issues);
  const priorityRows = normalizeRows(state.priorityRows, 'priority_rows', issues);
  const velocityRiskRows = normalizeRows(state.velocityRiskRows, 'velocity_risk_rows', issues);
  const groupCounts = orderGroupProjection(state.orderDraft, issues);
  const highestPriorityVelocityRisk = velocityRiskProjection(selectHighestPriorityRisk(priorityRows, velocityRiskRows));
  const priorityCount = priorityRows.length;
  const velocityRiskCount = velocityRiskRows.length;
  const summary = {
    status:issues.length ? 'invalid' : readiness.state === 'empty' && priorityCount === 0 && velocityRiskCount === 0 && groupCounts.total === 0 ? 'empty' : readiness.state === 'incomplete' ? 'incomplete' : 'ready',
    readiness,
    priorityCount,
    velocityRiskCount,
    groupCounts,
    highestPriorityVelocityRisk,
    issues,
  };
  return { ...summary, nextAction:nextAction(summary) };
}

const browserInterface = Object.freeze({
  WORKSPACE_IDS,
  LEGACY_WORKSPACE_HASHES,
  resolveInitialWorkspace,
  workspaceHash,
  projectTodaySummary,
});

if (typeof window !== 'undefined') window.SupplyWorkspaceNavigation = browserInterface;
