import {
  LEGACY_ORDER_DRAFT_STORAGE_KEY,
  ORDER_DRAFT_SCHEMA_VERSION,
  ORDER_DRAFT_STORAGE_KEY,
} from './order-draft-state.js';
import { PLANNING_VELOCITY_HISTORY_KEY } from './planning-velocity-history.js';

export const WORKSPACE_SNAPSHOT_SCHEMA_VERSION = 1;
export const WORKSPACE_PREFERENCES_SCHEMA_VERSION = 1;
export const WORKSPACE_SNAPSHOT_DATABASE = 'supply-workspace-v1';
export const WORKSPACE_SNAPSHOT_OBJECT_STORE = 'workspace-snapshots';
export const WORKSPACE_SNAPSHOT_RECORD_KEY = 'public-workspace';
export const WORKSPACE_PREFERENCES_KEY = 'supply-workspace-preferences-v1';

const MANUAL_INPUT_ROLES = Object.freeze(['jam', 'amz', 'jsp', 'sales']);
const SNAPSHOT_KEYS = Object.freeze([
  'createdAt',
  'inputs',
  'models',
  'schemaVersion',
  'sources',
  'updatedAt',
]);
const SOURCE_KEYS = Object.freeze([
  'blob',
  'lastModified',
  'name',
  'observedOn',
  'order',
  'role',
  'selectedAt',
  'type',
]);
const INPUT_KEYS = Object.freeze([
  'h10ObservedOn',
  'h10Paste',
  'h10SelectedAt',
  'manualText',
  'overrideMarker',
]);
const PREFERENCE_KEYS = Object.freeze([
  'activeWorkspace',
  'filters',
  'otherText',
  'planning',
  'schemaVersion',
  'updatedAt',
]);
const MAX_PREFERENCES_BYTES = 64 * 1024;
const SENSITIVE_PREFERENCE_KEY = /token|password|secret|credential|authorization|cookie/i;

export const WORKSPACE_EXTERNAL_MODEL_REFERENCES = deepFreeze({
  orderDraft: {
    schemaVersion: ORDER_DRAFT_SCHEMA_VERSION,
    storageKey: ORDER_DRAFT_STORAGE_KEY,
    legacyStorageKeys: [LEGACY_ORDER_DRAFT_STORAGE_KEY],
  },
  velocityHistory: {
    schemaVersion: 1,
    storageKey: PLANNING_VELOCITY_HISTORY_KEY,
    legacyStorageKeys: [],
  },
});

// Clear is deliberately an exact allowlist. In particular, it never contains
// the Boss session key (`supply-boss-session`) and callers never need clear().
export const WORKSPACE_CLEAR_LOCAL_STORAGE_KEYS = Object.freeze([
  WORKSPACE_PREFERENCES_KEY,
  ORDER_DRAFT_STORAGE_KEY,
  LEGACY_ORDER_DRAFT_STORAGE_KEY,
  PLANNING_VELOCITY_HISTORY_KEY,
  'supply-lead-time-days',
  'supply-fba-transfer-days',
  'supply-generator-columns-v1',
  'supply-sidebar-collapsed-v2',
  'supply-sidebar-collapsed',
]);

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
}

function clone(value) {
  return structuredClone(value);
}

function isPlainObject(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, keys) {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function makeNamedError(name, message) {
  const error = new Error(message);
  error.name = name;
  return error;
}

function errorDetails(error) {
  return {
    name: String(error?.name || 'Error'),
    message: String(error?.message || error || 'Unknown storage failure'),
  };
}

function classifyStorageError(error) {
  const name = String(error?.name || '');
  if (name === 'VersionError') return 'unsupported-version';
  if (name === 'NotReadableError') return 'unreadable';
  if (
    name === 'QuotaExceededError'
    || name === 'NS_ERROR_DOM_QUOTA_REACHED'
    || error?.code === 22
    || error?.code === 1014
  ) return 'quota';
  if (name === 'SecurityError' || name === 'NotAllowedError') return 'denied';
  return 'unavailable';
}

function failure(status, error, details = {}) {
  return { ok: false, status, ...details, error: errorDetails(error) };
}

function asTimestamp(value, label) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new TypeError(`${label} must be a valid timestamp`);
  return date.toISOString();
}

function nowTimestamp(now) {
  const value = typeof now === 'function' ? now() : now;
  return asTimestamp(value === undefined ? new Date() : value, 'now');
}

function asObservedOn(value) {
  if (value === null || value === undefined || value === '') return null;
  const text = String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new TypeError('observedOn must use YYYY-MM-DD');
  const [year, month, day] = text.split('-').map(Number);
  const normalized = new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10);
  if (normalized !== text) throw new TypeError('observedOn must be a real calendar date');
  return text;
}

function isBlobLike(value) {
  return Boolean(
    value
    && typeof value === 'object'
    && typeof value.arrayBuffer === 'function'
    && typeof value.slice === 'function'
    && Number.isFinite(Number(value.size))
    && typeof value.type === 'string',
  );
}

function normalizeSource(source, index, selectedAt, forcedRole = null) {
  const blob = source?.blob ?? source?.file ?? source;
  if (!isBlobLike(blob)) throw new TypeError(`sources[${index}] must contain a Blob or File`);
  const role = String(forcedRole ?? source?.role ?? '').trim();
  if (!role) throw new TypeError(`sources[${index}].role must be a non-empty string`);
  const name = String(source?.name ?? blob?.name ?? '').trim();
  if (!name) throw new TypeError(`sources[${index}].name must be a non-empty string`);
  const type = String(source?.type ?? blob.type ?? '');
  const lastModifiedValue = source?.lastModified ?? blob?.lastModified ?? 0;
  const lastModified = Number(lastModifiedValue);
  if (!Number.isFinite(lastModified) || lastModified < 0) {
    throw new TypeError(`sources[${index}].lastModified must be a non-negative number`);
  }
  const orderValue = source?.order ?? index;
  const order = Number(orderValue);
  if (!Number.isSafeInteger(order) || order < 0) {
    throw new TypeError(`sources[${index}].order must be a non-negative integer`);
  }
  return {
    blob,
    name,
    type,
    lastModified,
    role,
    observedOn: asObservedOn(source?.observedOn),
    selectedAt: asTimestamp(source?.selectedAt ?? selectedAt, `sources[${index}].selectedAt`),
    order,
  };
}

function normalizeManualMap(value, convert) {
  const source = isPlainObject(value) ? value : {};
  return Object.fromEntries(MANUAL_INPUT_ROLES.map(role => [role, convert(source[role])]));
}

function normalizeInputs(input = {}, selectedAt = null) {
  const source = isPlainObject(input) ? input : {};
  const h10Paste = String(source.h10Paste ?? '');
  return {
    h10Paste,
    h10ObservedOn: asObservedOn(source.h10ObservedOn),
    h10SelectedAt: source.h10SelectedAt
      ? asTimestamp(source.h10SelectedAt, 'inputs.h10SelectedAt')
      : (h10Paste && selectedAt ? asTimestamp(selectedAt, 'inputs.h10SelectedAt') : null),
    manualText: normalizeManualMap(source.manualText, value => String(value ?? '')),
    overrideMarker: normalizeManualMap(source.overrideMarker, Boolean),
  };
}

export function getWorkspaceInputFallbackRoles(inputs = {}) {
  const source = isPlainObject(inputs) ? inputs : {};
  const manualText = isPlainObject(source.manualText) ? source.manualText : {};
  const overrideMarker = isPlainObject(source.overrideMarker) ? source.overrideMarker : {};
  const hasManualOverride = role => (
    overrideMarker[role] === true && Boolean(String(manualText[role] ?? '').trim())
  );
  const roles = [];
  if (hasManualOverride('jam')) roles.push('openOrders');
  if (Boolean(String(source.h10Paste ?? '').trim()) || hasManualOverride('amz')) roles.push('amazonInventory');
  if (hasManualOverride('jsp')) roles.push('jspInventory');
  if (hasManualOverride('sales')) roles.push('salesReport');
  return roles;
}

function sanitizePreferenceValue(value, seen = new WeakSet()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (!Array.isArray(value) && !isPlainObject(value)) return undefined;
  if (seen.has(value)) throw new TypeError('preferences must not contain circular values');
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map(item => sanitizePreferenceValue(item, seen));
    seen.delete(value);
    return result;
  }
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_PREFERENCE_KEY.test(key)) continue;
    const sanitized = sanitizePreferenceValue(item, seen);
    if (sanitized !== undefined) result[key] = sanitized;
  }
  seen.delete(value);
  return result;
}

function normalizePreferences(preferences, updatedAt) {
  const source = isPlainObject(preferences) ? preferences : {};
  const activeWorkspace = source.activeWorkspace === null || source.activeWorkspace === undefined
    ? null
    : String(source.activeWorkspace).slice(0, 128);
  const record = {
    schemaVersion: WORKSPACE_PREFERENCES_SCHEMA_VERSION,
    updatedAt,
    activeWorkspace,
    planning: sanitizePreferenceValue(source.planning) || {},
    filters: sanitizePreferenceValue(source.filters) || {},
    otherText: sanitizePreferenceValue(source.otherText) || {},
  };
  const serialized = JSON.stringify(record);
  if (new TextEncoder().encode(serialized).byteLength > MAX_PREFERENCES_BYTES) {
    throw makeNamedError('PreferenceSizeError', `preferences must not exceed ${MAX_PREFERENCES_BYTES} bytes`);
  }
  return { record, serialized };
}

function modelReferences() {
  return clone(WORKSPACE_EXTERNAL_MODEL_REFERENCES);
}

function createSnapshot(input, updatedAt) {
  const sources = Array.from(input?.sources || [], (source, index) => (
    normalizeSource(source, index, updatedAt)
  ));
  return {
    schemaVersion: WORKSPACE_SNAPSHOT_SCHEMA_VERSION,
    createdAt: updatedAt,
    updatedAt,
    sources,
    inputs: normalizeInputs(input?.inputs ?? input, updatedAt),
    models: modelReferences(),
  };
}

function mergeSnapshotSources(previousSnapshot, incomingSnapshot) {
  if (!previousSnapshot) return incomingSnapshot;
  const incomingRoles = new Set(incomingSnapshot.sources.map(source => source.role));
  return {
    ...incomingSnapshot,
    createdAt: previousSnapshot.createdAt,
    sources: [
      ...previousSnapshot.sources.filter(source => !incomingRoles.has(String(source?.role ?? '').trim())),
      ...incomingSnapshot.sources,
    ],
  };
}

function validateModelReferences(models) {
  if (!isPlainObject(models) || !exactKeys(models, ['orderDraft', 'velocityHistory'])) {
    return 'models must contain exactly Order Draft and velocity history references';
  }
  for (const [name, reference] of Object.entries(models)) {
    if (!isPlainObject(reference) || !exactKeys(reference, ['legacyStorageKeys', 'schemaVersion', 'storageKey'])) {
      return `${name} must be a versioned external model reference`;
    }
    if (!Number.isSafeInteger(reference.schemaVersion) || reference.schemaVersion < 1) {
      return `${name}.schemaVersion must be a positive integer`;
    }
    if (!String(reference.storageKey || '').trim() || reference.storageKey === 'supply-boss-session') {
      return `${name}.storageKey is invalid`;
    }
    if (!Array.isArray(reference.legacyStorageKeys) || reference.legacyStorageKeys.some(key => (
      typeof key !== 'string' || !key || key === 'supply-boss-session'
    ))) return `${name}.legacyStorageKeys is invalid`;
  }
  return null;
}

function validateInputs(inputs) {
  if (!isPlainObject(inputs) || !exactKeys(inputs, INPUT_KEYS)) return 'inputs has an invalid schema';
  if (typeof inputs.h10Paste !== 'string') return 'inputs.h10Paste must be a string';
  try {
    asObservedOn(inputs.h10ObservedOn);
    if (inputs.h10SelectedAt !== null) asTimestamp(inputs.h10SelectedAt, 'inputs.h10SelectedAt');
  } catch (error) {
    return error.message;
  }
  for (const [key, convert] of [['manualText', 'string'], ['overrideMarker', 'boolean']]) {
    if (!isPlainObject(inputs[key]) || !exactKeys(inputs[key], MANUAL_INPUT_ROLES)) {
      return `inputs.${key} must contain exactly JAM, AMZ, JSP, and Sales`;
    }
    if (Object.values(inputs[key]).some(value => typeof value !== convert)) {
      return `inputs.${key} contains an invalid value`;
    }
  }
  return null;
}

function validateSnapshotRoot(snapshot) {
  if (!isPlainObject(snapshot)) return { status: 'corrupt', message: 'Workspace Snapshot must be an object' };
  if (typeof snapshot.schemaVersion !== 'number' || !Number.isSafeInteger(snapshot.schemaVersion)) {
    return { status: 'corrupt', message: 'Workspace Snapshot schemaVersion must be an integer' };
  }
  const version = snapshot.schemaVersion;
  if (version !== WORKSPACE_SNAPSHOT_SCHEMA_VERSION) {
    return {
      status: 'unsupported-version',
      version: snapshot.schemaVersion,
      message: `Unsupported Workspace Snapshot schema ${String(snapshot.schemaVersion)}`,
    };
  }
  if (!exactKeys(snapshot, SNAPSHOT_KEYS)) return { status: 'corrupt', message: 'Workspace Snapshot keys do not match schema v1' };
  try {
    asTimestamp(snapshot.createdAt, 'createdAt');
    asTimestamp(snapshot.updatedAt, 'updatedAt');
  } catch (error) {
    return { status: 'corrupt', message: error.message };
  }
  if (!Array.isArray(snapshot.sources)) return { status: 'corrupt', message: 'sources must be an array' };
  const inputIssue = validateInputs(snapshot.inputs);
  if (inputIssue) return { status: 'corrupt', message: inputIssue };
  const modelIssue = validateModelReferences(snapshot.models);
  if (modelIssue) return { status: 'corrupt', message: modelIssue };
  return null;
}

function validateSourceMetadata(source, index) {
  if (!isPlainObject(source) || !exactKeys(source, SOURCE_KEYS)) return `sources[${index}] keys do not match schema v1`;
  if (!String(source.role || '').trim()) return `sources[${index}].role is invalid`;
  if (!String(source.name || '').trim()) return `sources[${index}].name is invalid`;
  if (typeof source.type !== 'string') return `sources[${index}].type is invalid`;
  if (!Number.isFinite(source.lastModified) || source.lastModified < 0) return `sources[${index}].lastModified is invalid`;
  if (!Number.isSafeInteger(source.order) || source.order < 0) return `sources[${index}].order is invalid`;
  try {
    asObservedOn(source.observedOn);
    asTimestamp(source.selectedAt, `sources[${index}].selectedAt`);
  } catch (error) {
    return error.message;
  }
  return null;
}

function validatePreferenceRecord(record) {
  if (!isPlainObject(record)) return { status: 'corrupt', message: 'Workspace preferences must be an object' };
  if (typeof record.schemaVersion !== 'number' || !Number.isSafeInteger(record.schemaVersion)) {
    return { status: 'corrupt', message: 'Workspace preference schemaVersion must be an integer' };
  }
  if (record.schemaVersion !== WORKSPACE_PREFERENCES_SCHEMA_VERSION) {
    return {
      status: 'unsupported-version',
      version: record.schemaVersion,
      message: `Unsupported Workspace preferences schema ${String(record.schemaVersion)}`,
    };
  }
  if (!exactKeys(record, PREFERENCE_KEYS)) return { status: 'corrupt', message: 'Workspace preference keys do not match schema v1' };
  if (record.activeWorkspace !== null && typeof record.activeWorkspace !== 'string') {
    return { status: 'corrupt', message: 'activeWorkspace must be a string or null' };
  }
  if (!isPlainObject(record.planning) || !isPlainObject(record.filters) || !isPlainObject(record.otherText)) {
    return { status: 'corrupt', message: 'Workspace preference groups must be objects' };
  }
  try {
    asTimestamp(record.updatedAt, 'preferences.updatedAt');
  } catch (error) {
    return { status: 'corrupt', message: error.message };
  }
  return null;
}

function defaultFileFactory(blob, metadata) {
  if (typeof File !== 'function') {
    throw makeNamedError('FileUnavailableError', 'File reconstruction is unavailable in this runtime');
  }
  return new File([blob], metadata.name, {
    type: metadata.type,
    lastModified: metadata.lastModified,
  });
}

function getDefaultKeyValueStorage() {
  try {
    return globalThis.localStorage || null;
  } catch (_) {
    return null;
  }
}

function emptyPreferences() {
  return { activeWorkspace: null, planning: {}, filters: {}, otherText: {} };
}

function exposedPreferences(record) {
  if (!record) return emptyPreferences();
  return {
    activeWorkspace: record.activeWorkspace,
    planning: clone(record.planning),
    filters: clone(record.filters),
    otherText: clone(record.otherText),
  };
}

function createEmptyPlan(preferences = emptyPreferences()) {
  return {
    createdAt: null,
    updatedAt: null,
    sources: [],
    filesByRole: {},
    inputs: normalizeInputs(),
    preferences,
    models: modelReferences(),
  };
}

function requestError(request, fallback) {
  return request?.error || makeNamedError('IndexedDBError', fallback);
}

export function createIndexedDbWorkspaceAdapter({
  indexedDB = globalThis.indexedDB,
  databaseName = WORKSPACE_SNAPSHOT_DATABASE,
  objectStoreName = WORKSPACE_SNAPSHOT_OBJECT_STORE,
  recordKey = WORKSPACE_SNAPSHOT_RECORD_KEY,
} = {}) {
  async function openDatabase() {
    if (!indexedDB || typeof indexedDB.open !== 'function') {
      throw makeNamedError('StorageUnavailableError', 'IndexedDB is unavailable');
    }
    return new Promise((resolve, reject) => {
      let request;
      try {
        request = indexedDB.open(databaseName, WORKSPACE_SNAPSHOT_SCHEMA_VERSION);
      } catch (error) {
        reject(error);
        return;
      }
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(objectStoreName)) database.createObjectStore(objectStoreName);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(requestError(request, 'Unable to open IndexedDB'));
      request.onblocked = () => reject(makeNamedError('InvalidStateError', 'IndexedDB upgrade is blocked'));
    });
  }

  async function transact(mode, operation) {
    const database = await openDatabase();
    try {
      return await new Promise((resolve, reject) => {
        let request;
        let requestResult;
        let transaction;
        try {
          transaction = database.transaction(objectStoreName, mode);
          request = operation(transaction.objectStore(objectStoreName));
        } catch (error) {
          reject(error);
          return;
        }
        request.onsuccess = () => { requestResult = request.result; };
        request.onerror = () => reject(requestError(request, 'IndexedDB request failed'));
        transaction.oncomplete = () => resolve(requestResult);
        transaction.onerror = () => reject(transaction.error || requestError(request, 'IndexedDB transaction failed'));
        transaction.onabort = () => reject(transaction.error || requestError(request, 'IndexedDB transaction aborted'));
      });
    } finally {
      database.close?.();
    }
  }

  return Object.freeze({
    read: () => transact('readonly', store => store.get(recordKey)),
    write: record => transact('readwrite', store => store.put(record, recordKey)).then(() => undefined),
    remove: () => transact('readwrite', store => store.delete(recordKey)).then(() => undefined),
  });
}

export function createWorkspaceSnapshotStore({
  persistence,
  indexedDB,
  keyValueStorage = getDefaultKeyValueStorage(),
  fileFactory = defaultFileFactory,
  now,
} = {}) {
  const adapter = persistence || createIndexedDbWorkspaceAdapter({ indexedDB });
  let requiredSourceRoles = new Set();
  let unresolvedRestoreIssues = [];

  function normalizedRoleSet(roles = []) {
    return new Set(Array.from(roles || [], value => String(value ?? '').trim()).filter(Boolean));
  }

  function sourceIssueKey(issue) {
    return [
      String(issue?.kind || ''),
      String(issue?.status || ''),
      String(issue?.role || ''),
      String(issue?.name || ''),
      String(issue?.index ?? ''),
    ].join('|');
  }

  function remainingIssuesAfterWrite(snapshot, replacedRoles = new Set()) {
    const satisfiedRoles = new Set([
      ...Array.from(snapshot?.sources || [], source => String(source?.role ?? '').trim()).filter(Boolean),
      ...getWorkspaceInputFallbackRoles(snapshot?.inputs),
    ]);
    const remaining = unresolvedRestoreIssues.filter(issue => {
      if (issue?.kind !== 'source') return false;
      const role = String(issue?.role ?? '').trim();
      if (role && replacedRoles.has(role)) return false;
      if (issue?.status === 'missing' && role && satisfiedRoles.has(role)) return false;
      return true;
    });
    for (const role of requiredSourceRoles) {
      if (satisfiedRoles.has(role)) continue;
      remaining.push({ status: 'missing', kind: 'source', role });
    }
    const seen = new Set();
    unresolvedRestoreIssues = remaining.filter(issue => {
      const key = sourceIssueKey(issue);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return clone(unresolvedRestoreIssues);
  }

  function savedResult(snapshot, preferences, replacedRoles) {
    const issues = remainingIssuesAfterWrite(snapshot, replacedRoles);
    return {
      ok: true,
      status: issues.length ? 'partial' : 'saved',
      snapshot,
      ...(preferences ? { preferences } : {}),
      issues,
    };
  }

  async function readSnapshot() {
    if (!adapter || typeof adapter.read !== 'function') {
      return failure('unavailable', makeNamedError('StorageUnavailableError', 'Workspace persistence must provide read()'));
    }
    try {
      return { ok: true, status: 'read', snapshot: await adapter.read() ?? null };
    } catch (error) {
      return failure(classifyStorageError(error), error);
    }
  }

  async function writeSnapshot(snapshot) {
    if (!adapter || typeof adapter.write !== 'function') {
      return failure('unavailable', makeNamedError('StorageUnavailableError', 'Workspace persistence must provide write(record)'));
    }
    try {
      await adapter.write(snapshot);
      return { ok: true, status: 'written' };
    } catch (error) {
      return failure(classifyStorageError(error), error);
    }
  }

  function readPreferences() {
    if (!keyValueStorage || typeof keyValueStorage.getItem !== 'function') {
      return failure('unavailable', makeNamedError('StorageUnavailableError', 'Preference storage must provide getItem(key)'));
    }
    let serialized;
    try {
      serialized = keyValueStorage.getItem(WORKSPACE_PREFERENCES_KEY);
    } catch (error) {
      return failure(classifyStorageError(error), error);
    }
    if (serialized === null) return { ok: true, status: 'missing', record: null, serialized: null };
    let record;
    try {
      record = JSON.parse(serialized);
    } catch (error) {
      return failure('corrupt', error, { serialized });
    }
    const issue = validatePreferenceRecord(record);
    if (issue) {
      return failure(issue.status, new TypeError(issue.message), {
        version: issue.version,
        serialized,
      });
    }
    return { ok: true, status: 'loaded', record, serialized };
  }

  function writePreferences(serialized) {
    if (!keyValueStorage || typeof keyValueStorage.setItem !== 'function') {
      return failure('unavailable', makeNamedError('StorageUnavailableError', 'Preference storage must provide setItem(key, value)'));
    }
    try {
      keyValueStorage.setItem(WORKSPACE_PREFERENCES_KEY, serialized);
      return { ok: true, status: 'written' };
    } catch (error) {
      return failure(classifyStorageError(error), error);
    }
  }

  function restorePreviousPreferences(previous) {
    try {
      if (previous === null) keyValueStorage.removeItem(WORKSPACE_PREFERENCES_KEY);
      else keyValueStorage.setItem(WORKSPACE_PREFERENCES_KEY, previous);
      return null;
    } catch (error) {
      return errorDetails(error);
    }
  }

  async function save(input = {}) {
    const previousSnapshotResult = await readSnapshot();
    if (!previousSnapshotResult.ok) return previousSnapshotResult;
    const previousSnapshot = previousSnapshotResult.snapshot;
    if (previousSnapshot !== null) {
      const rootIssue = validateSnapshotRoot(previousSnapshot);
      if (rootIssue) return failure(rootIssue.status, new TypeError(rootIssue.message), {
        version: rootIssue.version,
        preserved: true,
      });
    }

    const previousPreferences = readPreferences();
    if (!previousPreferences.ok && previousPreferences.status !== 'corrupt') return previousPreferences;

    let updatedAt;
    let incomingSnapshot;
    let snapshot;
    let preferences;
    try {
      updatedAt = nowTimestamp(now);
      incomingSnapshot = createSnapshot(input, updatedAt);
      snapshot = mergeSnapshotSources(previousSnapshot, incomingSnapshot);
      preferences = normalizePreferences(input.preferences, updatedAt);
    } catch (error) {
      return failure('invalid', error);
    }

    const preferenceWrite = writePreferences(preferences.serialized);
    if (!preferenceWrite.ok) return preferenceWrite;
    const snapshotWrite = await writeSnapshot(snapshot);
    if (!snapshotWrite.ok) {
      const rollbackError = restorePreviousPreferences(previousPreferences.serialized ?? null);
      return { ...snapshotWrite, preferencesRolledBack: !rollbackError, rollbackError };
    }
    const replacedRoles = normalizedRoleSet(incomingSnapshot.sources.map(source => source.role));
    return savedResult(snapshot, exposedPreferences(preferences.record), replacedRoles);
  }

  async function replaceSource(role, sources) {
    const normalizedRole = String(role ?? '').trim();
    if (!normalizedRole) return failure('invalid', new TypeError('role must be a non-empty string'));
    const current = await readSnapshot();
    if (!current.ok) return current;
    if (current.snapshot === null) {
      const updatedAt = nowTimestamp(now);
      let snapshot;
      try {
        snapshot = createSnapshot({ sources: [], inputs: normalizeInputs() }, updatedAt);
        snapshot.sources = Array.from(sources || [], (source, index) => (
          normalizeSource(source, index, updatedAt, normalizedRole)
        ));
      } catch (error) {
        return failure('invalid', error);
      }
      const written = await writeSnapshot(snapshot);
      return written.ok
        ? savedResult(snapshot, null, new Set([normalizedRole]))
        : written;
    }
    const rootIssue = validateSnapshotRoot(current.snapshot);
    if (rootIssue) {
      return failure(rootIssue.status, new TypeError(rootIssue.message), {
        version: rootIssue.version,
        preserved: true,
      });
    }
    const updatedAt = nowTimestamp(now);
    let replacements;
    try {
      replacements = Array.from(sources || [], (source, index) => (
        normalizeSource(source, index, updatedAt, normalizedRole)
      ));
    } catch (error) {
      return failure('invalid', error);
    }
    const snapshot = {
      ...current.snapshot,
      updatedAt,
      sources: [
        ...current.snapshot.sources.filter(source => source?.role !== normalizedRole),
        ...replacements,
      ],
    };
    const written = await writeSnapshot(snapshot);
    return written.ok
      ? savedResult(snapshot, null, new Set([normalizedRole]))
      : written;
  }

  async function restore({ requiredRoles = [] } = {}) {
    requiredSourceRoles = normalizedRoleSet(requiredRoles);
    const stored = await readSnapshot();
    if (!stored.ok) return { ...stored, plan: createEmptyPlan(), currentSessionPreserved: true };
    const preferencesResult = readPreferences();
    const preferences = preferencesResult.ok
      ? exposedPreferences(preferencesResult.record)
      : emptyPreferences();
    if (stored.snapshot === null) {
      unresolvedRestoreIssues = [];
      if (!preferencesResult.ok) {
        return {
          ...preferencesResult,
          plan: createEmptyPlan(),
          currentSessionPreserved: true,
        };
      }
      return { ok: true, status: 'missing', plan: createEmptyPlan(preferences), issues: [] };
    }

    const rootIssue = validateSnapshotRoot(stored.snapshot);
    if (rootIssue) {
      return failure(rootIssue.status, new TypeError(rootIssue.message), {
        version: rootIssue.version,
        preserved: true,
        currentSessionPreserved: true,
        plan: createEmptyPlan(preferences),
      });
    }

    const restoredSources = [];
    const issues = [];
    const presentRoles = new Set();
    for (const [index, source] of stored.snapshot.sources.entries()) {
      if (typeof source?.role === 'string' && source.role.trim()) presentRoles.add(source.role.trim());
      const metadataIssue = validateSourceMetadata(source, index);
      if (metadataIssue) {
        issues.push({ status: 'corrupt', kind: 'source', index, role: source?.role ?? null, message: metadataIssue });
        continue;
      }
      if (!isBlobLike(source.blob)) {
        issues.push({ status: 'unreadable', kind: 'source', index, role: source.role, name: source.name, error: errorDetails(makeNamedError('UnreadableBlobError', 'Saved source does not contain a readable Blob')) });
        continue;
      }
      try {
        await source.blob.arrayBuffer();
        const metadata = {
          name: source.name,
          type: source.type,
          lastModified: source.lastModified,
          role: source.role,
          observedOn: source.observedOn,
          selectedAt: source.selectedAt,
          order: source.order,
        };
        const file = await fileFactory(source.blob, metadata);
        if (!file || typeof file.arrayBuffer !== 'function') throw makeNamedError('UnreadableFileError', 'File reconstruction returned an unreadable value');
        restoredSources.push({ ...metadata, file });
      } catch (error) {
        issues.push({
          status: 'unreadable',
          kind: 'source',
          index,
          role: source.role,
          name: source.name,
          error: errorDetails(error),
        });
      }
    }

    const inputFallbackRoles = new Set(getWorkspaceInputFallbackRoles(stored.snapshot.inputs));
    for (const role of requiredSourceRoles) {
      if (!presentRoles.has(role) && !inputFallbackRoles.has(role)) {
        issues.push({ status: 'missing', kind: 'source', role });
      }
    }
    if (!preferencesResult.ok) {
      issues.push({
        status: preferencesResult.status,
        kind: 'preferences',
        error: preferencesResult.error,
        version: preferencesResult.version,
      });
    }
    const filesByRole = {};
    for (const source of restoredSources) {
      if (!filesByRole[source.role]) filesByRole[source.role] = [];
      filesByRole[source.role].push(source.file);
    }
    const plan = {
      createdAt: stored.snapshot.createdAt,
      updatedAt: stored.snapshot.updatedAt,
      sources: restoredSources,
      filesByRole,
      inputs: clone(stored.snapshot.inputs),
      preferences,
      models: clone(stored.snapshot.models),
    };
    unresolvedRestoreIssues = clone(issues);
    return {
      ok: true,
      status: issues.length ? 'partial' : 'restored',
      plan,
      issues,
    };
  }

  async function clear({ confirmed = false } = {}) {
    if (confirmed !== true) {
      return failure('confirmation-required', makeNamedError('ConfirmationRequiredError', 'Clear requires explicit confirmation'), {
        removedKeys: [],
      });
    }
    const errors = [];
    let snapshotRemoved = false;
    if (!adapter || typeof adapter.remove !== 'function') {
      errors.push({ status: 'unavailable', target: 'workspace-snapshot', error: errorDetails(makeNamedError('StorageUnavailableError', 'Workspace persistence must provide remove()')) });
    } else {
      try {
        await adapter.remove();
        snapshotRemoved = true;
      } catch (error) {
        errors.push({ status: classifyStorageError(error), target: 'workspace-snapshot', error: errorDetails(error) });
      }
    }

    const removedKeys = [];
    if (!keyValueStorage || typeof keyValueStorage.removeItem !== 'function') {
      errors.push({ status: 'unavailable', target: 'local-storage', error: errorDetails(makeNamedError('StorageUnavailableError', 'Preference storage must provide removeItem(key)')) });
    } else {
      for (const key of WORKSPACE_CLEAR_LOCAL_STORAGE_KEYS) {
        try {
          keyValueStorage.removeItem(key);
          removedKeys.push(key);
        } catch (error) {
          errors.push({ status: classifyStorageError(error), target: key, error: errorDetails(error) });
        }
      }
    }
    if (errors.length) {
      return {
        ok: false,
        status: errors[0].status,
        snapshotRemoved,
        removedKeys,
        errors,
        error: errors[0].error,
      };
    }
    unresolvedRestoreIssues = [];
    requiredSourceRoles = new Set();
    return { ok: true, status: 'cleared', snapshotRemoved, removedKeys };
  }

  return Object.freeze({ save, replaceSource, restore, clear });
}

const browserInterface = Object.freeze({
  WORKSPACE_SNAPSHOT_SCHEMA_VERSION,
  WORKSPACE_PREFERENCES_SCHEMA_VERSION,
  WORKSPACE_PREFERENCES_KEY,
  WORKSPACE_CLEAR_LOCAL_STORAGE_KEYS,
  WORKSPACE_EXTERNAL_MODEL_REFERENCES,
  getWorkspaceInputFallbackRoles,
  createIndexedDbWorkspaceAdapter,
  createWorkspaceSnapshotStore,
});

if (typeof window !== 'undefined') window.SupplyWorkspaceSnapshot = browserInterface;
