export const PLANNING_VELOCITY_HISTORY_KEY = 'supply-velocity-history-v1';

function normalizeCalendarDate(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const [year, month, day] = text.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day)).toISOString().slice(0, 10) === text ? text : null;
}

export function derivePlanningVelocityObservedOn(snapshot, timeZone = 'Asia/Taipei') {
  const explicit = normalizeCalendarDate(snapshot?.observedOn);
  if (explicit) return explicit;
  const updatedAt = new Date(snapshot?.updatedAt);
  if (!Number.isFinite(updatedAt.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year:'numeric',
      month:'2-digit',
      day:'2-digit',
    }).formatToParts(updatedAt);
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    return normalizeCalendarDate(`${values.year}-${values.month}-${values.day}`);
  } catch (_) {
    return null;
  }
}

function errorDetails(error) {
  return {
    name: String(error?.name || 'Error'),
    message: String(error?.message || error || 'Unknown storage failure'),
  };
}

function failure(status, error, details = {}) {
  return { ok: false, status, ...details, error: errorDetails(error) };
}

function classifyStorageFailure(error) {
  const name = String(error?.name || '');
  if (name === 'SecurityError' || name === 'NotAllowedError') return 'denied';
  if (
    name === 'QuotaExceededError'
    || name === 'NS_ERROR_DOM_QUOTA_REACHED'
    || error?.code === 22
    || error?.code === 1014
  ) return 'quota';
  return 'failure';
}

export function readPlanningVelocityHistory(
  storage,
  key = PLANNING_VELOCITY_HISTORY_KEY,
) {
  if (!storage || typeof storage.getItem !== 'function') {
    return failure('unavailable', {
      name: 'StorageUnavailableError',
      message: 'storage must provide getItem(key)',
    }, { samples: [] });
  }
  let serialized;
  try {
    serialized = storage.getItem(key);
  } catch (error) {
    return failure(classifyStorageFailure(error), error, { samples: [] });
  }
  if (serialized === null) {
    return { ok: true, status: 'missing', samples: [] };
  }
  try {
    const samples = JSON.parse(serialized);
    if (!Array.isArray(samples)) {
      return failure('corrupt', {
        name: 'HistoryFormatError',
        message: 'Planning Velocity history must be a JSON array',
      }, { samples: [] });
    }
    return { ok: true, status: 'loaded', samples };
  } catch (error) {
    return failure('corrupt', error, { samples: [] });
  }
}

export function writePlanningVelocityHistory(
  storage,
  samples,
  key = PLANNING_VELOCITY_HISTORY_KEY,
) {
  if (!storage || typeof storage.setItem !== 'function') {
    return failure('unavailable', {
      name: 'StorageUnavailableError',
      message: 'storage must provide setItem(key, value)',
    });
  }
  if (!Array.isArray(samples)) {
    return failure('invalid', {
      name: 'HistoryFormatError',
      message: 'Planning Velocity history must be an array',
    });
  }

  let serialized;
  try {
    serialized = JSON.stringify(samples);
  } catch (error) {
    return failure('invalid', error);
  }
  try {
    storage.setItem(key, serialized);
    return { ok: true, status: 'saved', count: samples.length };
  } catch (error) {
    return failure(classifyStorageFailure(error), error);
  }
}

const browserInterface = Object.freeze({
  PLANNING_VELOCITY_HISTORY_KEY,
  derivePlanningVelocityObservedOn,
  readPlanningVelocityHistory,
  writePlanningVelocityHistory,
});

if (typeof window !== 'undefined') window.SupplyVelocityHistory = browserInterface;
