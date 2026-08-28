/* Public-only Catalog Update selection handoff contract. Keep both repository copies byte-identical. */
const SCHEMA_VERSION = 1;
const KIND = 'jspusa-catalog-update-selection';
const CATALOG_VERSION = /^\d{4}-\d{2}-\d{2}(?:\.\d+)?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const HANDOFF_KEYS = Object.freeze([
  'baseline',
  'candidate',
  'confirmedAt',
  'kind',
  'planSha256',
  'schemaVersion',
  'selectedEntryIds',
]);
const SNAPSHOT_KEYS = Object.freeze(['catalogVersion', 'sha256']);

export class CatalogUpdateHandoffError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CatalogUpdateHandoffError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new CatalogUpdateHandoffError(code, message);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return isRecord(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function normalizedTimestamp(value) {
  const timestamp = typeof value === 'string' ? value : '';
  if (Number.isNaN(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp) {
    fail('INVALID_CONFIRMED_AT', 'Catalog Update handoff confirmedAt must be an exact ISO timestamp');
  }
  return timestamp;
}

function normalizedSnapshot(value, label) {
  if (!exactKeys(value, SNAPSHOT_KEYS)) fail('INVALID_SNAPSHOT', `${label} has an unsupported shape`);
  const catalogVersion = String(value.catalogVersion || '');
  const sha256 = String(value.sha256 || '');
  if (!CATALOG_VERSION.test(catalogVersion)) fail('INVALID_CATALOG_VERSION', `${label} catalogVersion is invalid`);
  if (!SHA256.test(sha256)) fail('INVALID_SHA256', `${label} sha256 is invalid`);
  return { catalogVersion, sha256 };
}

function normalizedSelectedIds(value) {
  if (!Array.isArray(value) || value.length === 0) {
    fail('EMPTY_SELECTION', 'Catalog Update handoff must select at least one change');
  }
  const ids = value.map(item => String(item || '').trim());
  if (ids.some(id => !id || id.length > 300)) fail('INVALID_SELECTION', 'Catalog Update handoff contains an invalid selection id');
  if (new Set(ids).size !== ids.length) fail('DUPLICATE_SELECTION', 'Catalog Update handoff selection ids must be unique');
  return ids;
}

export function validateCatalogUpdateHandoff(input) {
  if (!exactKeys(input, HANDOFF_KEYS)) fail('UNSUPPORTED_SHAPE', 'Catalog Update handoff has an unsupported shape');
  if (input.schemaVersion !== SCHEMA_VERSION || input.kind !== KIND) {
    fail('UNSUPPORTED_SCHEMA', 'Catalog Update handoff schema or kind is unsupported');
  }
  const baseline = normalizedSnapshot(input.baseline, 'baseline');
  const candidate = normalizedSnapshot(input.candidate, 'candidate');
  const planSha256 = String(input.planSha256 || '');
  if (!SHA256.test(planSha256)) fail('INVALID_PLAN_SHA256', 'Catalog Update handoff planSha256 is invalid');
  return deepFreeze({
    schemaVersion:SCHEMA_VERSION,
    kind:KIND,
    baseline,
    candidate,
    planSha256,
    selectedEntryIds:normalizedSelectedIds(input.selectedEntryIds),
    confirmedAt:normalizedTimestamp(input.confirmedAt),
  });
}

function validatedPlanSelection(plan, selectedEntryIds) {
  if (!isRecord(plan) || !Array.isArray(plan.entries) || !Array.isArray(plan.blockers)) {
    fail('INVALID_PLAN', 'Catalog Update handoff requires a valid Catalog Change Plan');
  }
  if (plan.blockers.length || plan.entries.some(entry => entry?.risk === 'blocking')) {
    fail('BLOCKED_PLAN', 'A blocked Catalog Change Plan cannot create a selection handoff');
  }
  const selected = normalizedSelectedIds(selectedEntryIds);
  const entries = new Map(plan.entries.map(entry => [String(entry?.id || ''), entry]));
  for (const id of selected) {
    const entry = entries.get(id);
    if (!entry || entry.selectable !== true || !['safe', 'review'].includes(entry.risk)) {
      fail('INVALID_SELECTION', `${id} is not a selectable Catalog Change Plan entry`);
    }
  }
  return selected;
}

export function createCatalogUpdateHandoff(plan, selectedEntryIds, { confirmedAt = new Date().toISOString() } = {}) {
  if (!isRecord(plan) || plan.schemaVersion !== 1) fail('INVALID_PLAN', 'Catalog Change Plan schema is unsupported');
  const handoff = {
    schemaVersion:SCHEMA_VERSION,
    kind:KIND,
    baseline:normalizedSnapshot(plan.baseline, 'baseline'),
    candidate:normalizedSnapshot(plan.candidate, 'candidate'),
    planSha256:String(plan.planSha256 || ''),
    selectedEntryIds:validatedPlanSelection(plan, selectedEntryIds),
    confirmedAt:normalizedTimestamp(confirmedAt),
  };
  return validateCatalogUpdateHandoff(handoff);
}

export const CATALOG_UPDATE_HANDOFF_CONTRACT = Object.freeze({
  schemaVersion:SCHEMA_VERSION,
  kind:KIND,
});
