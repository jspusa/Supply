export const CATALOG_AFFECTED_WORK_SCHEMA_VERSION = 1;
export const SUPPLY_ORDER_DRAFT_STORAGE_KEY = 'supply-order-draft-v3';
export const FBA_PACKAGING_LEDGER_STORAGE_KEY = 'fba-workspace:packaging-assignments:v1';

const MAX_STORAGE_CHARACTERS = 5_000_000;
const MAX_PLAN_ENTRIES = 10_000;
const MAX_STORED_WORK_ITEMS = 5_000;
const MAX_AFFECTED_RELATIONSHIPS = 10_000;
const SKU = /^[A-Z0-9][A-Z0-9-]{0,99}$/;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,299}$/;
const SAFE_VERSION = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,99}$/;
const SAFE_ROW_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]{0,199}$/;
const ORDER_GROUPS = new Set(['vietnam', 'taiwan', 'subcontract']);
const SUPPLY_PACKAGING_STATES = new Set(['pinned', 'review-required']);
const FBA_ASSIGNMENT_KINDS = new Set(['catalog-version', 'historical-imported']);
const OWNER_WIDE_FIELDS = new Set([
  'approvedOrderSkus',
  'canonicalProductSku',
  'lifecycle',
  'origin',
  'standardFactory',
]);

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeToken(value, pattern) {
  const text = typeof value === 'string' ? value.trim() : '';
  return pattern.test(text) ? text : null;
}

function safeSku(value) {
  return safeToken(typeof value === 'string' ? value.toUpperCase() : value, SKU);
}

function readStoredJson(storage, storageKey) {
  if (!storage || typeof storage.getItem !== 'function') return { status:'unavailable', value:null };
  let raw;
  try { raw = storage.getItem(storageKey); } catch (_) { return { status:'unavailable', value:null }; }
  if (raw === null || raw === '') return { status:'missing', value:null };
  if (typeof raw !== 'string') return { status:'invalid', value:null };
  if (raw.length > MAX_STORAGE_CHARACTERS) return { status:'too-large', value:null };
  try {
    const value = JSON.parse(raw);
    return isRecord(value) ? { status:'ok', value } : { status:'invalid', value:null };
  } catch (_) {
    return { status:'invalid', value:null };
  }
}

function fieldNames(entry) {
  return new Set((Array.isArray(entry?.fields) ? entry.fields : [])
    .map(field => isRecord(field) ? String(field.field || '') : '')
    .filter(Boolean));
}

function addSkus(target, value) {
  const values = Array.isArray(value) ? value : [value];
  for (const candidate of values) {
    const sku = safeSku(candidate);
    if (sku) target.add(sku);
  }
}

function ownerOrderSkus(entry) {
  const result = new Set();
  addSkus(result, entry?.before?.approvedOrderSkus);
  addSkus(result, entry?.after?.approvedOrderSkus);
  for (const field of Array.isArray(entry?.fields) ? entry.fields : []) {
    if (field?.field !== 'approvedOrderSkus') continue;
    addSkus(result, field.before);
    addSkus(result, field.after);
  }
  return result;
}

function normalizePlanEntries(plan) {
  if (!isRecord(plan) || !Array.isArray(plan.entries)) return { entries:[], truncated:false };
  const truncated = plan.entries.length > MAX_PLAN_ENTRIES;
  const entries = [];
  for (const input of plan.entries.slice(0, MAX_PLAN_ENTRIES)) {
    if (!isRecord(input)) continue;
    const id = safeToken(input.id, SAFE_ID);
    const sku = safeSku(input.sku);
    const entryType = ['product', 'order-sku-alias', 'source-conflict'].includes(input.entryType)
      ? input.entryType
      : null;
    if (!id || !sku || !entryType) continue;
    const targets = new Set([sku]);
    if (entryType === 'product') {
      const names = fieldNames(input);
      const ownerWide = input.changeType === 'added'
        || input.changeType === 'removed'
        || [...names].some(name => OWNER_WIDE_FIELDS.has(name));
      if (ownerWide) ownerOrderSkus(input).forEach(value => targets.add(value));
    }
    entries.push({ id, entryType, sku, targets });
  }
  return { entries, truncated };
}

function normalizeSupplyWork(state) {
  if (state?.schemaVersion !== 3 || !isRecord(state.rowsByProductSku)) {
    return { status:'invalid', work:[], truncated:false };
  }
  const rawRows = Object.entries(state.rowsByProductSku);
  const truncated = rawRows.length > MAX_STORED_WORK_ITEMS;
  const work = [];
  for (const [mapSku, input] of rawRows.slice(0, MAX_STORED_WORK_ITEMS)) {
    if (!isRecord(input)) continue;
    const productSku = safeSku(input.productSku) || safeSku(mapSku);
    const orderSku = safeSku(input.orderSku);
    if (!productSku || !orderSku) continue;
    const assignment = isRecord(input.packagingAssignment) ? input.packagingAssignment : null;
    const packagingVersion = safeToken(assignment?.packagingVersion, SAFE_VERSION);
    const packagingState = SUPPLY_PACKAGING_STATES.has(assignment?.state) ? assignment.state : null;
    const orderGroup = ORDER_GROUPS.has(input.orderGroup) ? input.orderGroup : null;
    const identities = new Set([productSku, orderSku]);
    addSkus(identities, assignment?.canonicalProductSku);
    addSkus(identities, assignment?.orderSku);
    work.push({
      identities,
      publicValue:{ productSku, orderSku, packagingVersion, packagingState, orderGroup },
    });
  }
  work.sort((left, right) => left.publicValue.productSku.localeCompare(right.publicValue.productSku)
    || left.publicValue.orderSku.localeCompare(right.publicValue.orderSku));
  return { status:'ok', work, truncated };
}

function normalizeFbaWork(state) {
  if (state?.schemaVersion !== 1 || !isRecord(state.assignments)) {
    return { status:'invalid', work:[], truncated:false };
  }
  const rawAssignments = Object.entries(state.assignments);
  const truncated = rawAssignments.length > MAX_STORED_WORK_ITEMS;
  const work = [];
  for (const [mapRowId, input] of rawAssignments.slice(0, MAX_STORED_WORK_ITEMS)) {
    if (!isRecord(input)) continue;
    const sku = safeSku(input.sku);
    const kind = FBA_ASSIGNMENT_KINDS.has(input.kind) ? input.kind : null;
    if (!sku || !kind) continue;
    const rowId = safeToken(input.rowId, SAFE_ROW_ID)
      || safeToken(mapRowId, SAFE_ROW_ID)
      || safeToken(input.rowKey, SAFE_ROW_ID);
    const packagingVersion = safeToken(input.packagingVersion, SAFE_VERSION);
    const identities = new Set([sku]);
    addSkus(identities, input.canonicalProductSku);
    addSkus(identities, input.orderSku);
    work.push({
      identities,
      publicValue:{
        rowId,
        sku,
        packagingVersion,
        kind,
        reviewRequired:input.reviewRequired === true,
      },
    });
  }
  work.sort((left, right) => String(left.publicValue.rowId || '').localeCompare(String(right.publicValue.rowId || ''))
    || left.publicValue.sku.localeCompare(right.publicValue.sku));
  return { status:'ok', work, truncated };
}

function indexWork(work) {
  const index = new Map();
  for (const item of work) {
    for (const identity of item.identities) {
      if (!index.has(identity)) index.set(identity, []);
      index.get(identity).push(item);
    }
  }
  return index;
}

function affectedForEntry(entry, index, remaining) {
  if (remaining <= 0) return { affectedWork:[], truncated:true };
  const matches = [];
  const seen = new Set();
  for (const target of entry.targets) {
    for (const item of index.get(target) || []) {
      if (seen.has(item)) continue;
      seen.add(item);
      matches.push(item.publicValue);
    }
  }
  return {
    affectedWork:matches.slice(0, remaining),
    truncated:matches.length > remaining,
  };
}

/**
 * Read the compact local state and project only non-quantity work identities.
 * This function never writes to, removes from, or enumerates the supplied storage.
 */
export function collectAffectedWork({ site, storage, plan } = {}) {
  const normalizedSite = site === 'supply' || site === 'fba' ? site : null;
  if (!normalizedSite) throw new TypeError('site must be supply or fba');

  const normalizedPlan = normalizePlanEntries(plan);
  const storageKey = normalizedSite === 'supply'
    ? SUPPLY_ORDER_DRAFT_STORAGE_KEY
    : FBA_PACKAGING_LEDGER_STORAGE_KEY;
  const stored = readStoredJson(storage, storageKey);
  const normalizedWork = stored.status === 'ok'
    ? (normalizedSite === 'supply' ? normalizeSupplyWork(stored.value) : normalizeFbaWork(stored.value))
    : { status:stored.status, work:[], truncated:false };
  const storageStatus = normalizedWork.status;
  const workIndex = indexWork(normalizedWork.work);
  const entries = [];
  let remaining = MAX_AFFECTED_RELATIONSHIPS;
  let relationshipsTruncated = false;

  for (const entry of normalizedPlan.entries) {
    const affected = affectedForEntry(entry, workIndex, remaining);
    remaining -= affected.affectedWork.length;
    relationshipsTruncated ||= affected.truncated;
    entries.push({
      entryId:entry.id,
      entryType:entry.entryType,
      sku:entry.sku,
      affectedWork:affected.affectedWork,
    });
  }

  return {
    schemaVersion:CATALOG_AFFECTED_WORK_SCHEMA_VERSION,
    site:normalizedSite,
    storageStatus,
    truncated:normalizedPlan.truncated || normalizedWork.truncated || relationshipsTruncated,
    entries,
  };
}
