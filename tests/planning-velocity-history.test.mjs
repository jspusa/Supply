import assert from 'node:assert/strict';
import test from 'node:test';

import {
  PLANNING_VELOCITY_HISTORY_KEY,
  derivePlanningVelocityObservedOn,
  readPlanningVelocityHistory,
  writePlanningVelocityHistory,
} from '../shared/planning-velocity-history.js';

function memoryStorage(initialEntries = {}) {
  const entries = new Map(Object.entries(initialEntries));
  return {
    getItem(key) { return entries.has(key) ? entries.get(key) : null; },
    setItem(key, value) { entries.set(key, String(value)); },
  };
}

test('missing Planning Velocity history is an explicit successful empty read', () => {
  const result = readPlanningVelocityHistory(memoryStorage());

  assert.deepEqual(result, {
    ok: true,
    status: 'missing',
    samples: [],
  });
});

test('Planning Velocity history is read through the shared storage seam', () => {
  const samples = [{ productSku: 'GTP03', date: '2026-08-27', h10SourceVelocity: 18.39 }];
  const result = readPlanningVelocityHistory(memoryStorage({
    [PLANNING_VELOCITY_HISTORY_KEY]: JSON.stringify(samples),
  }));

  assert.deepEqual(result, {
    ok: true,
    status: 'loaded',
    samples,
  });
});

test('malformed or non-array Planning Velocity history is reported as corrupt', () => {
  for (const serialized of ['{not-json', JSON.stringify({ samples: [] })]) {
    const result = readPlanningVelocityHistory(memoryStorage({
      [PLANNING_VELOCITY_HISTORY_KEY]: serialized,
    }));

    assert.equal(result.ok, false);
    assert.equal(result.status, 'corrupt');
    assert.deepEqual(result.samples, []);
    assert.equal(typeof result.error.message, 'string');
  }
});

test('denied Planning Velocity history reads are classified without throwing', () => {
  const denied = Object.assign(new Error('Storage access denied'), { name: 'SecurityError' });
  const result = readPlanningVelocityHistory({ getItem() { throw denied; } });

  assert.equal(result.ok, false);
  assert.equal(result.status, 'denied');
  assert.deepEqual(result.samples, []);
  assert.deepEqual(result.error, { name: 'SecurityError', message: 'Storage access denied' });
});

test('an unavailable Planning Velocity history adapter is explicit', () => {
  const result = readPlanningVelocityHistory(null);

  assert.equal(result.ok, false);
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(result.samples, []);
});

test('Planning Velocity history writes report success and are readable through the Interface', () => {
  const storage = memoryStorage();
  const samples = [{ productSku: 'GTP03', date: '2026-08-28', h10SourceVelocity: 18.39 }];

  assert.deepEqual(writePlanningVelocityHistory(storage, samples), {
    ok: true,
    status: 'saved',
    count: 1,
  });
  assert.deepEqual(readPlanningVelocityHistory(storage), {
    ok: true,
    status: 'loaded',
    samples,
  });
});

test('denied and quota Planning Velocity history writes remain distinguishable', () => {
  for (const [name, status] of [
    ['SecurityError', 'denied'],
    ['NotAllowedError', 'denied'],
    ['QuotaExceededError', 'quota'],
    ['NS_ERROR_DOM_QUOTA_REACHED', 'quota'],
  ]) {
    const storageError = Object.assign(new Error(`${status} write`), { name });
    const result = writePlanningVelocityHistory({ setItem() { throw storageError; } }, []);

    assert.equal(result.ok, false);
    assert.equal(result.status, status);
    assert.deepEqual(result.error, { name, message: `${status} write` });
  }
});

test('unavailable or invalid Planning Velocity history writes fail explicitly', () => {
  const unavailable = writePlanningVelocityHistory(null, []);
  assert.equal(unavailable.ok, false);
  assert.equal(unavailable.status, 'unavailable');

  const invalid = writePlanningVelocityHistory(memoryStorage(), { not: 'samples' });
  assert.equal(invalid.ok, false);
  assert.equal(invalid.status, 'invalid');
});

test('saved snapshot observation date is explicit or canonically derived in Asia/Taipei', () => {
  assert.equal(derivePlanningVelocityObservedOn({
    observedOn:'2026-08-30',
    updatedAt:'2026-08-28T16:30:00Z',
  }), '2026-08-30');
  assert.equal(derivePlanningVelocityObservedOn({
    updatedAt:'2026-08-28T16:30:00Z',
  }), '2026-08-29');
  assert.equal(derivePlanningVelocityObservedOn({ updatedAt:'not-a-date' }), null);
});
