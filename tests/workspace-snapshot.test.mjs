import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WORKSPACE_CLEAR_LOCAL_STORAGE_KEYS,
  WORKSPACE_EXTERNAL_MODEL_REFERENCES,
  WORKSPACE_H10_DRAFT_KEY,
  WORKSPACE_PREFERENCES_KEY,
  WORKSPACE_SNAPSHOT_DATABASE,
  WORKSPACE_SNAPSHOT_OBJECT_STORE,
  WORKSPACE_SNAPSHOT_RECORD_KEY,
  createIndexedDbWorkspaceAdapter,
  createWorkspaceSnapshotStore,
  getWorkspaceInputFallbackRoles,
} from '../shared/workspace-snapshot.js';

const NOW = '2026-08-28T03:04:05.000Z';

function createMemoryPersistence(initial = null) {
  let record = initial;
  let writes = 0;
  let removals = 0;
  return {
    async read() { return record; },
    async write(next) { record = next; writes += 1; },
    async remove() { record = null; removals += 1; },
    inspect() { return record; },
    replace(next) { record = next; },
    get writes() { return writes; },
    get removals() { return removals; },
  };
}

function createMemoryKeyValue(initial = {}) {
  const values = new Map(Object.entries(initial));
  const nextSetFailures = new Map();
  const nextRemoveFailures = new Map();
  let clearCalls = 0;
  let setCalls = 0;
  let removeCalls = 0;
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) {
      setCalls += 1;
      if (nextSetFailures.has(key)) {
        const error = nextSetFailures.get(key);
        nextSetFailures.delete(key);
        throw error;
      }
      values.set(key, String(value));
    },
    removeItem(key) {
      removeCalls += 1;
      if (nextRemoveFailures.has(key)) {
        const error = nextRemoveFailures.get(key);
        nextRemoveFailures.delete(key);
        throw error;
      }
      values.delete(key);
    },
    clear() { clearCalls += 1; throw new Error('clear() must never be called'); },
    failNextSet(key, error) { nextSetFailures.set(key, error); },
    failNextRemove(key, error) { nextRemoveFailures.set(key, error); },
    has(key) { return values.has(key); },
    value(key) { return values.get(key); },
    keys() { return [...values.keys()]; },
    get clearCalls() { return clearCalls; },
    get setCalls() { return setCalls; },
    get removeCalls() { return removeCalls; },
  };
}

function source(file, role, metadata = {}) {
  return {
    blob: file,
    role,
    observedOn: metadata.observedOn ?? '2026-08-27',
    selectedAt: metadata.selectedAt ?? '2026-08-28T02:00:00.000Z',
    order: metadata.order ?? 0,
  };
}

function completeInputs() {
  return {
    h10Paste: 'SKU\tVelocity\nAFA12AM\t18.39',
    h10ObservedOn: '2026-08-27',
    h10SelectedAt: '2026-08-28T01:30:00.000Z',
    manualText: {
      jam: 'AFA12AM\t1176',
      amz: 'AFA12AM\t369\t12',
      jsp: 'AFA12AM\t84',
      sales: 'AFA12AM\tUS$366151',
    },
    overrideMarker: { jam: true, amz: false, jsp: true, sales: false },
  };
}

function inputsWithoutFallbacks() {
  return {
    h10Paste: '',
    h10ObservedOn: null,
    h10SelectedAt: null,
    manualText: { jam:'', amz:'', jsp:'', sales:'' },
    overrideMarker: { jam:false, amz:false, jsp:false, sales:false },
  };
}

test('manual Workspace inputs satisfy only the exact source roles backed by persisted overrides', () => {
  assert.deepEqual(getWorkspaceInputFallbackRoles({
    h10Paste:'B000000001 AFA12AM 18.39',
    manualText:{ jam:'AFA12AM\t12', amz:'AFA12AM\t5', jsp:'AFA12AM\t7', sales:'AFA12AM\t99' },
    overrideMarker:{ jam:true, amz:false, jsp:true, sales:false },
  }), ['openOrders', 'amazonInventory', 'jspInventory']);
  assert.deepEqual(getWorkspaceInputFallbackRoles({
    h10Paste:'   ',
    manualText:{ jam:'text without marker', amz:'AFA12AM\t5', jsp:'', sales:'AFA12AM\t99' },
    overrideMarker:{ jam:false, amz:true, jsp:true, sales:true },
  }), ['amazonInventory', 'salesReport']);
});

test('synchronous H10 draft restores after an immediate refresh and clears only after the snapshot captures it', async () => {
  const persistence = createMemoryPersistence();
  const keyValueStorage = createMemoryKeyValue();
  const store = createWorkspaceSnapshotStore({ persistence, keyValueStorage, now:NOW });
  const draftInput = {
    h10Paste:'B000000001 AFA12AM 18.39',
    h10ObservedOn:'2026-08-27',
    h10SelectedAt:'2026-08-28T01:30:00.000Z',
  };

  const staged = store.stageH10Draft(draftInput);
  assert.equal(staged.status, 'staged');
  assert.equal(keyValueStorage.has(WORKSPACE_H10_DRAFT_KEY), true);

  const restored = await store.restore({
    requiredRoles:['openOrders', 'amazonInventory', 'jspInventory'],
  });
  assert.equal(restored.ok, true);
  assert.equal(restored.status, 'partial');
  assert.equal(restored.recoveredH10Draft, true);
  assert.equal(restored.plan.inputs.h10Paste, draftInput.h10Paste);
  assert.deepEqual(restored.issues.map(issue => issue.role), ['openOrders', 'jspInventory']);

  const saved = await store.save({
    sources:[],
    inputs:{
      ...draftInput,
      manualText:{ jam:'', amz:'', jsp:'', sales:'' },
      overrideMarker:{ jam:false, amz:false, jsp:false, sales:false },
    },
    preferences:{ activeWorkspace:'data' },
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.h10DraftStatus, 'cleared');
  assert.equal(keyValueStorage.has(WORKSPACE_H10_DRAFT_KEY), false);
  assert.equal(persistence.inspect().inputs.h10Paste, draftInput.h10Paste);
});

test('an empty H10 draft acts as a deletion tombstone until the cleared value is safely saved', async () => {
  const persistence = createMemoryPersistence();
  const keyValueStorage = createMemoryKeyValue();
  const store = createWorkspaceSnapshotStore({ persistence, keyValueStorage, now:NOW });
  const previousInputs = completeInputs();
  await store.save({ sources:[], inputs:previousInputs, preferences:{} });

  assert.equal(store.stageH10Draft({ h10Paste:'', h10ObservedOn:null, h10SelectedAt:null }).ok, true);
  assert.ok(Date.parse(store.readH10Draft().draft.h10SelectedAt));
  const restored = await store.restore();
  assert.equal(restored.recoveredH10Draft, true);
  assert.equal(restored.plan.inputs.h10Paste, '');
  assert.equal(keyValueStorage.has(WORKSPACE_H10_DRAFT_KEY), true);

  const saved = await store.save({
    sources:[],
    inputs:{ ...previousInputs, h10Paste:'', h10ObservedOn:null, h10SelectedAt:null },
    preferences:{},
  });
  assert.equal(saved.h10DraftStatus, 'cleared');
  assert.equal(keyValueStorage.has(WORKSPACE_H10_DRAFT_KEY), false);
  assert.equal(persistence.inspect().inputs.h10Paste, '');
});

test('a newer empty tombstone rejects a stale non-empty save from another tab', async () => {
  const persistence = createMemoryPersistence();
  const keyValueStorage = createMemoryKeyValue();
  const firstTab = createWorkspaceSnapshotStore({ persistence, keyValueStorage, now:NOW });
  const oldInputs = completeInputs();
  await firstTab.save({ sources:[], inputs:oldInputs, preferences:{} });

  const secondTab = createWorkspaceSnapshotStore({
    persistence,
    keyValueStorage,
    now:'2026-08-28T03:04:06.000Z',
  });
  const staged = secondTab.stageH10Draft({
    h10Paste:'',
    h10ObservedOn:null,
    h10SelectedAt:'2026-08-28T03:04:06.000Z',
  });
  assert.equal(staged.ok, true);

  const staleSave = await firstTab.save({ sources:[], inputs:oldInputs, preferences:{} });
  assert.equal(staleSave.ok, false);
  assert.equal(staleSave.status, 'superseded');
  assert.equal(persistence.inspect().inputs.h10Paste, oldInputs.h10Paste);

  const restored = await createWorkspaceSnapshotStore({ persistence, keyValueStorage, now:NOW }).restore();
  assert.equal(restored.recoveredH10Draft, true);
  assert.equal(restored.plan.inputs.h10Paste, '');
});

test('a newer H10 draft is not deleted when an older asynchronous snapshot save finishes later', async () => {
  let stored = null;
  let releaseWrite;
  let signalWriteStarted;
  const writeStarted = new Promise(resolve => { signalWriteStarted = resolve; });
  const persistence = {
    async read() { return stored; },
    async write(next) {
      signalWriteStarted();
      await new Promise(resolve => { releaseWrite = resolve; });
      stored = next;
    },
    async remove() { stored = null; },
  };
  const keyValueStorage = createMemoryKeyValue();
  const store = createWorkspaceSnapshotStore({ persistence, keyValueStorage, now:NOW });
  const older = {
    h10Paste:'OLDER H10 TEXT',
    h10ObservedOn:'2026-08-27',
    h10SelectedAt:'2026-08-28T01:30:00.000Z',
  };
  const newer = {
    h10Paste:'NEWER H10 TEXT',
    h10ObservedOn:'2026-08-28',
    h10SelectedAt:'2026-08-28T02:30:00.000Z',
  };

  store.stageH10Draft(older);
  const savePromise = store.save({
    sources:[],
    inputs:{
      ...older,
      manualText:{ jam:'', amz:'', jsp:'', sales:'' },
      overrideMarker:{ jam:false, amz:false, jsp:false, sales:false },
    },
    preferences:{},
  });
  await writeStarted;
  store.stageH10Draft(newer);
  releaseWrite();

  const saved = await savePromise;
  assert.equal(saved.h10DraftStatus, 'newer-draft-preserved');
  assert.equal(store.readH10Draft().draft.h10Paste, newer.h10Paste);
  assert.equal(stored.inputs.h10Paste, older.h10Paste);
});

test('a draft staged while an older save is still reading remains newer than that snapshot', async () => {
  let stored = null;
  let releaseRead;
  let signalReadStarted;
  let shouldDelayRead = true;
  const readStarted = new Promise(resolve => { signalReadStarted = resolve; });
  const persistence = {
    async read() {
      if (shouldDelayRead) {
        shouldDelayRead = false;
        signalReadStarted();
        await new Promise(resolve => { releaseRead = resolve; });
      }
      return stored;
    },
    async write(next) { stored = next; },
    async remove() { stored = null; },
  };
  const keyValueStorage = createMemoryKeyValue();
  const store = createWorkspaceSnapshotStore({ persistence, keyValueStorage, now:NOW });
  const older = {
    h10Paste:'OLDER H10 TEXT',
    h10ObservedOn:'2026-08-27',
    h10SelectedAt:'2026-08-28T01:30:00.000Z',
  };
  const newer = {
    h10Paste:'NEWER H10 TEXT',
    h10ObservedOn:'2026-08-28',
    h10SelectedAt:'2026-08-28T02:30:00.000Z',
  };

  store.stageH10Draft(older);
  const savePromise = store.save({
    sources:[],
    inputs:{
      ...older,
      manualText:{ jam:'', amz:'', jsp:'', sales:'' },
      overrideMarker:{ jam:false, amz:false, jsp:false, sales:false },
    },
    preferences:{},
  });
  await readStarted;
  store.stageH10Draft(newer);
  releaseRead();

  const saved = await savePromise;
  assert.equal(saved.h10DraftStatus, 'newer-draft-preserved');
  assert.equal(stored.inputs.h10Paste, older.h10Paste);
  assert.equal(store.readH10Draft().draft.h10Paste, newer.h10Paste);
  assert.ok(Date.parse(store.readH10Draft().draft.updatedAt) > Date.parse(stored.updatedAt));

  const restored = await createWorkspaceSnapshotStore({ persistence, keyValueStorage, now:NOW }).restore();
  assert.equal(restored.recoveredH10Draft, true);
  assert.equal(restored.plan.inputs.h10Paste, newer.h10Paste);
});

test('a queued older payload cannot capture and clear a newer draft staged before the save call', async () => {
  const persistence = createMemoryPersistence();
  const keyValueStorage = createMemoryKeyValue();
  const store = createWorkspaceSnapshotStore({ persistence, keyValueStorage, now:NOW });
  const older = {
    h10Paste:'QUEUED OLD TEXT',
    h10ObservedOn:'2026-08-27',
    h10SelectedAt:'2026-08-28T01:30:00.000Z',
  };
  const newer = {
    h10Paste:'LIVE NEW TEXT',
    h10ObservedOn:'2026-08-28',
    h10SelectedAt:'2026-08-28T02:30:00.000Z',
  };
  store.stageH10Draft(older);
  store.stageH10Draft(newer);

  const saved = await store.save({
    sources:[],
    inputs:{
      ...older,
      manualText:{ jam:'', amz:'', jsp:'', sales:'' },
      overrideMarker:{ jam:false, amz:false, jsp:false, sales:false },
    },
    preferences:{},
  });
  assert.equal(saved.ok, false);
  assert.equal(saved.status, 'superseded');
  assert.equal(store.readH10Draft().draft.h10Paste, newer.h10Paste);
  assert.equal(persistence.inspect(), null);

  const restored = await createWorkspaceSnapshotStore({ persistence, keyValueStorage, now:NOW }).restore();
  assert.equal(restored.recoveredH10Draft, true);
  assert.equal(restored.plan.inputs.h10Paste, newer.h10Paste);
});

test('an existing snapshot timestamp cannot make a queued old payload clear the next draft', async () => {
  const persistence = createMemoryPersistence();
  const keyValueStorage = createMemoryKeyValue();
  const store = createWorkspaceSnapshotStore({ persistence, keyValueStorage, now:NOW });
  const older = {
    h10Paste:'SAVED OLD TEXT',
    h10ObservedOn:'2026-08-27',
    h10SelectedAt:'2026-08-28T01:30:00.000Z',
  };
  const newer = {
    h10Paste:'NEXT LIVE TEXT',
    h10ObservedOn:'2026-08-28',
    h10SelectedAt:'2026-08-28T02:30:00.000Z',
  };
  await store.save({
    sources:[],
    inputs:{
      ...older,
      manualText:{ jam:'', amz:'', jsp:'', sales:'' },
      overrideMarker:{ jam:false, amz:false, jsp:false, sales:false },
    },
    preferences:{},
  });
  const previousUpdatedAt = persistence.inspect().updatedAt;
  store.stageH10Draft(newer);

  const saved = await store.save({
    sources:[],
    inputs:{
      ...older,
      manualText:{ jam:'', amz:'', jsp:'', sales:'' },
      overrideMarker:{ jam:false, amz:false, jsp:false, sales:false },
    },
    preferences:{},
  });
  assert.equal(saved.ok, false);
  assert.equal(saved.status, 'superseded');
  assert.equal(store.readH10Draft().draft.h10Paste, newer.h10Paste);
  assert.equal(persistence.inspect().updatedAt, previousUpdatedAt);

  const restored = await createWorkspaceSnapshotStore({ persistence, keyValueStorage, now:NOW }).restore();
  assert.equal(restored.recoveredH10Draft, true);
  assert.equal(restored.plan.inputs.h10Paste, newer.h10Paste);
});

test('a draft first staged during an existing snapshot read stays strictly newer than that save', async () => {
  let stored = null;
  let delayNextRead = false;
  let releaseRead;
  let signalReadStarted;
  const readStarted = new Promise(resolve => { signalReadStarted = resolve; });
  const persistence = {
    async read() {
      if (delayNextRead) {
        delayNextRead = false;
        signalReadStarted();
        await new Promise(resolve => { releaseRead = resolve; });
      }
      return stored;
    },
    async write(next) { stored = next; },
    async remove() { stored = null; },
  };
  const keyValueStorage = createMemoryKeyValue();
  const store = createWorkspaceSnapshotStore({ persistence, keyValueStorage, now:NOW });
  const older = {
    h10Paste:'EXISTING SNAPSHOT TEXT',
    h10ObservedOn:'2026-08-27',
    h10SelectedAt:'2026-08-28T01:30:00.000Z',
  };
  const newer = {
    h10Paste:'FIRST NEW DRAFT',
    h10ObservedOn:'2026-08-28',
    h10SelectedAt:'2026-08-28T02:30:00.000Z',
  };
  await store.save({
    inputs:{
      ...older,
      manualText:{ jam:'', amz:'', jsp:'', sales:'' },
      overrideMarker:{ jam:false, amz:false, jsp:false, sales:false },
    },
    preferences:{},
  });
  delayNextRead = true;
  const savePromise = store.save({
    inputs:{
      ...older,
      manualText:{ jam:'', amz:'', jsp:'', sales:'' },
      overrideMarker:{ jam:false, amz:false, jsp:false, sales:false },
    },
    preferences:{},
  });
  await readStarted;
  store.stageH10Draft(newer);
  releaseRead();

  const saved = await savePromise;
  assert.equal(saved.ok, true);
  assert.equal(saved.h10DraftStatus, 'newer-draft-preserved');
  const draft = store.readH10Draft().draft;
  assert.ok(Date.parse(draft.updatedAt) > Date.parse(stored.updatedAt));

  const restored = await createWorkspaceSnapshotStore({ persistence, keyValueStorage, now:NOW }).restore();
  assert.equal(restored.recoveredH10Draft, true);
  assert.equal(restored.plan.inputs.h10Paste, newer.h10Paste);
});

test('a failed newer draft write cannot make an older draft override the newer snapshot', async () => {
  const timestamps = [
    '2026-08-28T03:04:05.000Z',
    '2026-08-28T03:04:06.000Z',
    '2026-08-28T03:04:07.000Z',
  ];
  const persistence = createMemoryPersistence();
  const keyValueStorage = createMemoryKeyValue();
  const store = createWorkspaceSnapshotStore({
    persistence,
    keyValueStorage,
    now:() => timestamps.shift(),
  });
  const older = {
    h10Paste:'OLDER H10 TEXT',
    h10ObservedOn:'2026-08-27',
    h10SelectedAt:'2026-08-28T01:30:00.000Z',
  };
  const newer = {
    h10Paste:'NEWER H10 TEXT',
    h10ObservedOn:'2026-08-28',
    h10SelectedAt:'2026-08-28T02:30:00.000Z',
  };

  assert.equal(store.stageH10Draft(older).status, 'staged');
  keyValueStorage.failNextSet(WORKSPACE_H10_DRAFT_KEY, new DOMException('full', 'QuotaExceededError'));
  const failedStage = store.stageH10Draft(newer);
  assert.equal(failedStage.ok, false);
  assert.equal(failedStage.status, 'quota');
  assert.equal(store.readH10Draft().draft.h10Paste, older.h10Paste);

  const saved = await store.save({
    sources:[],
    inputs:{
      ...newer,
      manualText:{ jam:'', amz:'', jsp:'', sales:'' },
      overrideMarker:{ jam:false, amz:false, jsp:false, sales:false },
    },
    preferences:{},
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.h10DraftStatus, 'newer-draft-preserved');
  assert.equal(keyValueStorage.has(WORKSPACE_H10_DRAFT_KEY), true);

  const restored = await createWorkspaceSnapshotStore({ persistence, keyValueStorage, now:NOW }).restore();
  assert.equal(restored.recoveredH10Draft, false);
  assert.equal(restored.plan.inputs.h10Paste, newer.h10Paste);
});

test('a failed empty tombstone stage still saves the deletion in the full snapshot', async () => {
  const timestamps = [
    '2026-08-28T03:04:05.000Z',
    '2026-08-28T03:04:06.000Z',
    '2026-08-28T03:04:07.000Z',
  ];
  const persistence = createMemoryPersistence();
  const keyValueStorage = createMemoryKeyValue();
  const store = createWorkspaceSnapshotStore({
    persistence,
    keyValueStorage,
    now:() => timestamps.shift(),
  });
  const older = {
    h10Paste:'OLD TEXT TO DELETE',
    h10ObservedOn:'2026-08-27',
    h10SelectedAt:'2026-08-28T01:30:00.000Z',
  };
  store.stageH10Draft(older);
  keyValueStorage.failNextSet(WORKSPACE_H10_DRAFT_KEY, new DOMException('full', 'QuotaExceededError'));
  const failedStage = store.stageH10Draft({ h10Paste:'', h10ObservedOn:null, h10SelectedAt:null });
  assert.equal(failedStage.ok, false);
  assert.equal(failedStage.status, 'quota');

  const saved = await store.save({
    inputs:{
      h10Paste:'',
      h10ObservedOn:null,
      h10SelectedAt:null,
      manualText:{ jam:'', amz:'', jsp:'', sales:'' },
      overrideMarker:{ jam:false, amz:false, jsp:false, sales:false },
    },
    preferences:{},
  });
  assert.equal(saved.ok, true);
  assert.equal(saved.h10DraftStatus, 'newer-draft-preserved');
  assert.equal(persistence.inspect().inputs.h10Paste, '');
  assert.equal(store.readH10Draft().draft.h10Paste, older.h10Paste);

  const restored = await createWorkspaceSnapshotStore({ persistence, keyValueStorage, now:NOW }).restore();
  assert.equal(restored.recoveredH10Draft, false);
  assert.equal(restored.plan.inputs.h10Paste, '');
});

test('a stale draft left behind by cleanup failure is ignored when the snapshot is equally new or newer', async () => {
  const persistence = createMemoryPersistence();
  const keyValueStorage = createMemoryKeyValue();
  const store = createWorkspaceSnapshotStore({ persistence, keyValueStorage, now:NOW });
  const newer = {
    h10Paste:'NEW FILE TEXT',
    h10ObservedOn:'2026-08-28',
    h10SelectedAt:'2026-08-28T02:30:00.000Z',
  };
  store.stageH10Draft(newer);
  keyValueStorage.failNextRemove(WORKSPACE_H10_DRAFT_KEY, new DOMException('blocked', 'SecurityError'));

  const saved = await store.save({
    sources:[],
    inputs:{
      ...newer,
      manualText:{ jam:'', amz:'', jsp:'', sales:'' },
      overrideMarker:{ jam:false, amz:false, jsp:false, sales:false },
    },
    preferences:{},
  });
  assert.equal(saved.h10DraftStatus, 'cleanup-failed');
  assert.equal(keyValueStorage.has(WORKSPACE_H10_DRAFT_KEY), true);

  const restored = await createWorkspaceSnapshotStore({ persistence, keyValueStorage, now:NOW }).restore();
  assert.equal(restored.recoveredH10Draft, false);
  assert.equal(restored.plan.inputs.h10Paste, newer.h10Paste);
});

test('staging never overwrites an unsupported future H10 draft schema and restore reports it', async () => {
  const futureDraft = JSON.stringify({
    schemaVersion:2,
    updatedAt:'2026-08-28T03:04:05.000Z',
    payload:{ h10Paste:'FUTURE DATA' },
  });
  const keyValueStorage = createMemoryKeyValue({ [WORKSPACE_H10_DRAFT_KEY]:futureDraft });
  const store = createWorkspaceSnapshotStore({ persistence:createMemoryPersistence(), keyValueStorage, now:NOW });

  const result = store.stageH10Draft({ h10Paste:'CURRENT DATA' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'unsupported-version');
  assert.equal(result.preserved, true);
  assert.equal(keyValueStorage.value(WORKSPACE_H10_DRAFT_KEY), futureDraft);

  const restored = await store.restore();
  assert.equal(restored.ok, true);
  assert.equal(restored.status, 'partial');
  assert.equal(restored.recoveredH10Draft, false);
  assert.deepEqual(restored.issues.map(issue => [issue.kind, issue.status, issue.version]), [
    ['h10-draft', 'unsupported-version', 2],
  ]);
  assert.equal(keyValueStorage.value(WORKSPACE_H10_DRAFT_KEY), futureDraft);

  const saved = await store.save({ inputs:{ h10Paste:'CURRENT DATA' }, preferences:{} });
  assert.equal(saved.ok, true);
  assert.equal(saved.status, 'partial');
  assert.equal(saved.h10DraftStatus, 'cleanup-failed');
  assert.deepEqual(saved.issues.map(issue => [issue.kind, issue.status, issue.version]), [
    ['h10-draft', 'unsupported-version', 2],
  ]);
  assert.equal(keyValueStorage.value(WORKSPACE_H10_DRAFT_KEY), futureDraft);
});

test('a corrupt H10 draft is preserved and reported without hiding a readable snapshot', async () => {
  const persistence = createMemoryPersistence();
  const keyValueStorage = createMemoryKeyValue();
  const writer = createWorkspaceSnapshotStore({ persistence, keyValueStorage, now:NOW });
  await writer.save({
    inputs:{
      ...completeInputs(),
      h10Paste:'READABLE SNAPSHOT TEXT',
    },
    preferences:{ activeWorkspace:'data' },
  });
  keyValueStorage.setItem(WORKSPACE_H10_DRAFT_KEY, '{broken-json');

  const restored = await createWorkspaceSnapshotStore({ persistence, keyValueStorage, now:NOW }).restore();
  assert.equal(restored.ok, true);
  assert.equal(restored.status, 'partial');
  assert.equal(restored.recoveredH10Draft, false);
  assert.equal(restored.plan.inputs.h10Paste, 'READABLE SNAPSHOT TEXT');
  assert.deepEqual(restored.issues.map(issue => [issue.kind, issue.status]), [
    ['h10-draft', 'corrupt'],
  ]);
  assert.equal(keyValueStorage.value(WORKSPACE_H10_DRAFT_KEY), '{broken-json');
});

test('a valid H10 draft still restores when unrelated workspace preferences are corrupt', async () => {
  const persistence = createMemoryPersistence();
  const keyValueStorage = createMemoryKeyValue({ [WORKSPACE_PREFERENCES_KEY]:'{broken-json' });
  const store = createWorkspaceSnapshotStore({ persistence, keyValueStorage, now:NOW });
  store.stageH10Draft({
    h10Paste:'RECOVER ME',
    h10ObservedOn:'2026-08-28',
    h10SelectedAt:'2026-08-28T02:30:00.000Z',
  });

  const restored = await store.restore({ requiredRoles:['amazonInventory'] });
  assert.equal(restored.ok, true);
  assert.equal(restored.status, 'partial');
  assert.equal(restored.recoveredH10Draft, true);
  assert.equal(restored.plan.inputs.h10Paste, 'RECOVER ME');
  assert.equal(restored.issues.some(issue => issue.kind === 'preferences' && issue.status === 'corrupt'), true);
});

test('manual-only required sources restore ready and a later manual edit remains autosaveable', async () => {
  const persistence = createMemoryPersistence();
  const keyValueStorage = createMemoryKeyValue();
  const writer = createWorkspaceSnapshotStore({ persistence, keyValueStorage, now: NOW });
  const inputs = {
    h10Paste:'B000000001 AFA12AM 18.39',
    h10ObservedOn:'2026-08-27',
    h10SelectedAt:'2026-08-28T01:30:00.000Z',
    manualText:{ jam:'AFA12AM\t12', amz:'', jsp:'AFA12AM\t7', sales:'' },
    overrideMarker:{ jam:true, amz:false, jsp:true, sales:false },
  };
  assert.equal((await writer.save({ sources:[], inputs, preferences:{ activeWorkspace:'data' } })).status, 'saved');

  const restoredStore = createWorkspaceSnapshotStore({
    persistence,
    keyValueStorage,
    now:'2026-08-28T04:05:06.000Z',
  });
  const restored = await restoredStore.restore({
    requiredRoles:['openOrders', 'amazonInventory', 'jspInventory'],
  });
  assert.equal(restored.ok, true);
  assert.equal(restored.status, 'restored');
  assert.deepEqual(restored.issues, []);
  assert.deepEqual(restored.plan.sources, []);

  const editedInputs = {
    ...restored.plan.inputs,
    manualText:{ ...restored.plan.inputs.manualText, jam:'AFA12AM\t18' },
  };
  const autosaved = await restoredStore.save({
    sources:restored.plan.sources,
    inputs:editedInputs,
    preferences:restored.plan.preferences,
  });
  assert.equal(autosaved.ok, true);
  assert.equal(autosaved.status, 'saved');
  assert.deepEqual(autosaved.issues, []);
  assert.equal(persistence.inspect().inputs.manualText.jam, 'AFA12AM\t18');
});

test('mixed file and manual inputs report only a genuinely missing required role', async () => {
  const persistence = createMemoryPersistence();
  const keyValueStorage = createMemoryKeyValue();
  const store = createWorkspaceSnapshotStore({ persistence, keyValueStorage, now: NOW });
  await store.save({
    sources:[source(new File(['jam'], 'JAM.xlsx'), 'openOrders')],
    inputs:{
      ...inputsWithoutFallbacks(),
      manualText:{ jam:'', amz:'AFA12AM\t5', jsp:'AFA12AM\t7', sales:'' },
      overrideMarker:{ jam:false, amz:true, jsp:false, sales:false },
    },
    preferences:{ activeWorkspace:'data' },
  });
  const restored = await store.restore({
    requiredRoles:['openOrders', 'amazonInventory', 'jspInventory'],
  });
  assert.equal(restored.status, 'partial');
  assert.deepEqual(restored.plan.sources.map(item => item.role), ['openOrders']);
  assert.deepEqual(restored.issues.map(issue => [issue.status, issue.role]), [
    ['missing', 'jspInventory'],
  ]);
});

test('Blob metadata and all source text round-trip into reconstructed Files', async () => {
  const persistence = createMemoryPersistence();
  const keyValueStorage = createMemoryKeyValue();
  const store = createWorkspaceSnapshotStore({ persistence, keyValueStorage, now: NOW });
  const file = new File(['jam-workbook-bytes'], 'JAM 2026-08-27.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    lastModified: 1_777_777_777_000,
  });

  const saved = await store.save({
    sources: [source(file, 'openOrders', { order: 7 })],
    inputs: completeInputs(),
    preferences: {
      activeWorkspace: 'data',
      planning: { leadTimeDays: 90, fbaTransferDays: 21, targetDays: 180 },
      filters: { factory: 'vietnam', velocityRiskOnly: true },
      otherText: { mainSearch: 'AFA12AM' },
      bossToken: 'must-not-be-persisted',
    },
    orderDraft: { secretCopy: true },
    velocityHistory: [{ productSku: 'AFA12AM', value: 18.39 }],
  });

  assert.equal(saved.ok, true);
  assert.equal(saved.status, 'saved');
  const raw = persistence.inspect();
  assert.equal(Object.hasOwn(raw, 'preferences'), false);
  assert.equal(Object.hasOwn(raw, 'orderDraft'), false);
  assert.equal(Object.hasOwn(raw, 'velocityHistory'), false);
  assert.deepEqual(raw.models, WORKSPACE_EXTERNAL_MODEL_REFERENCES);
  assert.doesNotMatch(keyValueStorage.value(WORKSPACE_PREFERENCES_KEY), /boss|token|must-not-be-persisted/i);

  const restored = await store.restore({ requiredRoles: ['openOrders'] });
  assert.equal(restored.ok, true);
  assert.equal(restored.status, 'restored');
  assert.deepEqual(restored.issues, []);
  assert.equal(restored.plan.sources.length, 1);
  const restoredSource = restored.plan.sources[0];
  assert.ok(restoredSource.file instanceof File);
  assert.equal(restoredSource.file.name, file.name);
  assert.equal(restoredSource.file.type, file.type);
  assert.equal(restoredSource.file.lastModified, file.lastModified);
  assert.equal(await restoredSource.file.text(), 'jam-workbook-bytes');
  assert.equal(restoredSource.role, 'openOrders');
  assert.equal(restoredSource.observedOn, '2026-08-27');
  assert.equal(restoredSource.selectedAt, '2026-08-28T02:00:00.000Z');
  assert.equal(restoredSource.order, 7);
  assert.deepEqual(restored.plan.inputs, completeInputs());
  assert.deepEqual(restored.plan.preferences, {
    activeWorkspace: 'data',
    planning: { leadTimeDays: 90, fbaTransferDays: 21, targetDays: 180 },
    filters: { factory: 'vietnam', velocityRiskOnly: true },
    otherText: { mainSearch: 'AFA12AM' },
  });
  assert.deepEqual(restored.plan.models, WORKSPACE_EXTERNAL_MODEL_REFERENCES);
  assert.deepEqual(restored.plan.filesByRole.openOrders, [restoredSource.file]);
});

test('replacing one source role leaves unrelated raw sources, text, and preferences intact', async () => {
  const persistence = createMemoryPersistence();
  const keyValueStorage = createMemoryKeyValue();
  const store = createWorkspaceSnapshotStore({ persistence, keyValueStorage, now: NOW });
  const openOrders = new File(['jam-old'], 'JAM.xlsx', { type: 'application/xlsx', lastModified: 10 });
  const amazonOld = new File(['amz-old'], 'AMZ-old.csv', { type: 'text/csv', lastModified: 20 });
  const jsp = new File(['jsp-old'], 'JSP.xlsx', { type: 'application/xlsx', lastModified: 30 });
  await store.save({
    sources: [
      source(openOrders, 'openOrders'),
      source(amazonOld, 'amazonInventory'),
      source(jsp, 'jspInventory'),
    ],
    inputs: completeInputs(),
    preferences: { activeWorkspace: 'recommendations', filters: { hideDiscontinued: true } },
  });

  const amazonNew = new File(['amz-new'], 'AMZ-new.csv', { type: 'text/csv', lastModified: 40 });
  const replaced = await store.replaceSource('amazonInventory', [
    source(amazonNew, 'ignored-by-forced-role', { observedOn: '2026-08-28', order: 3 }),
  ]);
  assert.equal(replaced.ok, true);
  assert.equal(replaced.status, 'saved');
  assert.deepEqual(replaced.snapshot.sources.map(item => [item.role, item.name]), [
    ['openOrders', 'JAM.xlsx'],
    ['jspInventory', 'JSP.xlsx'],
    ['amazonInventory', 'AMZ-new.csv'],
  ]);
  assert.deepEqual(replaced.snapshot.inputs, completeInputs());
  assert.equal(await replaced.snapshot.sources[0].blob.text(), 'jam-old');
  assert.equal(await replaced.snapshot.sources[1].blob.text(), 'jsp-old');
  assert.equal(await replaced.snapshot.sources[2].blob.text(), 'amz-new');

  const restored = await store.restore({ requiredRoles: ['openOrders', 'amazonInventory', 'jspInventory'] });
  assert.equal(restored.status, 'restored');
  assert.equal(restored.plan.preferences.activeWorkspace, 'recommendations');
  assert.deepEqual(restored.plan.preferences.filters, { hideDiscontinued: true });

  const removed = await store.replaceSource('amazonInventory', []);
  assert.equal(removed.ok, true);
  assert.deepEqual(removed.snapshot.sources.map(item => item.role), [
    'openOrders',
    'jspInventory',
  ]);
  assert.equal(await removed.snapshot.sources[0].blob.text(), 'jam-old');
  assert.equal(await removed.snapshot.sources[1].blob.text(), 'jsp-old');
});

test('save preserves createdAt and merges raw sources by incoming role', async () => {
  const timestamps = [
    '2026-08-28T03:04:05.000Z',
    '2026-08-28T04:05:06.000Z',
    '2026-08-28T05:06:07.000Z',
  ];
  const persistence = createMemoryPersistence();
  const keyValueStorage = createMemoryKeyValue();
  const store = createWorkspaceSnapshotStore({
    persistence,
    keyValueStorage,
    now: () => timestamps.shift(),
  });
  const first = await store.save({
    sources: [
      source(new File(['jam-old'], 'JAM-old.xlsx'), 'openOrders'),
      source(new File(['amz-old-a'], 'AMZ-old-a.csv'), 'amazonInventory', { order: 0 }),
      source(new File(['amz-old-b'], 'AMZ-old-b.csv'), 'amazonInventory', { order: 1 }),
      source(new File(['jsp-unreadable'], 'JSP-unreadable.xlsx'), 'jspInventory'),
    ],
    inputs: completeInputs(),
    preferences: { activeWorkspace: 'data' },
  });
  assert.equal(first.ok, true);

  const second = await store.save({
    sources: [
      source(new File(['amz-new'], 'AMZ-new.csv'), 'amazonInventory'),
    ],
    inputs: { ...completeInputs(), h10Paste: 'new H10 text' },
    preferences: { activeWorkspace: 'recommendations' },
  });
  assert.equal(second.ok, true);
  assert.equal(second.snapshot.createdAt, first.snapshot.createdAt);
  assert.equal(second.snapshot.updatedAt, '2026-08-28T04:05:06.000Z');
  assert.deepEqual(second.snapshot.sources.map(item => [item.role, item.name]), [
    ['openOrders', 'JAM-old.xlsx'],
    ['jspInventory', 'JSP-unreadable.xlsx'],
    ['amazonInventory', 'AMZ-new.csv'],
  ]);
  assert.equal(await second.snapshot.sources[0].blob.text(), 'jam-old');
  assert.equal(await second.snapshot.sources[1].blob.text(), 'jsp-unreadable');
  assert.equal(await second.snapshot.sources[2].blob.text(), 'amz-new');

  const preferencesOnly = await store.save({
    inputs: second.snapshot.inputs,
    preferences: { activeWorkspace: 'orders' },
  });
  assert.equal(preferencesOnly.ok, true);
  assert.equal(preferencesOnly.snapshot.createdAt, first.snapshot.createdAt);
  assert.equal(preferencesOnly.snapshot.updatedAt, '2026-08-28T05:06:07.000Z');
  assert.deepEqual(
    preferencesOnly.snapshot.sources.map(item => [item.role, item.name]),
    second.snapshot.sources.map(item => [item.role, item.name]),
  );
});

test('save preserves unrelated unreadable sources while repairing one role', async () => {
  const persistence = createMemoryPersistence();
  const keyValueStorage = createMemoryKeyValue();
  const writer = createWorkspaceSnapshotStore({ persistence, keyValueStorage, now: NOW });
  await writer.save({
    sources: [
      source(new File(['good'], 'JAM.xlsx'), 'openOrders'),
      source(new File(['bad-amz'], 'AMZ-unreadable.xlsx'), 'amazonInventory'),
      source(new File(['bad-jsp'], 'JSP-unreadable.xlsx'), 'jspInventory'),
    ],
    inputs: completeInputs(),
    preferences: { activeWorkspace: 'data' },
  });
  const store = createWorkspaceSnapshotStore({
    persistence,
    keyValueStorage,
    now: '2026-08-28T04:05:06.000Z',
    fileFactory(blob, metadata) {
      if (metadata.name.includes('unreadable')) throw new DOMException('cannot reconstruct', 'NotReadableError');
      return new File([blob], metadata.name, metadata);
    },
  });
  const partial = await store.restore();
  assert.equal(partial.ok, true);
  assert.equal(partial.status, 'partial');
  assert.deepEqual(partial.plan.sources.map(item => item.name), ['JAM.xlsx']);
  assert.deepEqual(partial.issues.map(issue => issue.name), [
    'AMZ-unreadable.xlsx',
    'JSP-unreadable.xlsx',
  ]);

  const repaired = await store.save({
    sources: [
      ...partial.plan.sources,
      source(new File(['fixed-amz'], 'AMZ-fixed.xlsx'), 'amazonInventory'),
    ],
    inputs: partial.plan.inputs,
    preferences: partial.plan.preferences,
  });
  assert.equal(repaired.ok, true);
  assert.equal(repaired.status, 'partial');
  assert.deepEqual(repaired.issues.map(issue => [issue.status, issue.role, issue.name]), [
    ['unreadable', 'jspInventory', 'JSP-unreadable.xlsx'],
  ]);
  assert.deepEqual(repaired.snapshot.sources.map(item => [item.role, item.name]), [
    ['jspInventory', 'JSP-unreadable.xlsx'],
    ['openOrders', 'JAM.xlsx'],
    ['amazonInventory', 'AMZ-fixed.xlsx'],
  ]);
  assert.equal(await repaired.snapshot.sources[0].blob.text(), 'bad-jsp');

  const reloaded = createWorkspaceSnapshotStore({
    persistence,
    keyValueStorage,
    now: '2026-08-28T05:06:07.000Z',
    fileFactory(blob, metadata) {
      if (metadata.name.includes('unreadable')) throw new DOMException('cannot reconstruct', 'NotReadableError');
      return new File([blob], metadata.name, metadata);
    },
  });
  const afterReload = await reloaded.restore({
    requiredRoles: ['openOrders', 'amazonInventory', 'jspInventory'],
  });
  assert.equal(afterReload.ok, true);
  assert.equal(afterReload.status, 'partial');
  assert.deepEqual(afterReload.plan.sources.map(item => [item.role, item.name]), [
    ['openOrders', 'JAM.xlsx'],
    ['amazonInventory', 'AMZ-fixed.xlsx'],
  ]);
  assert.deepEqual(afterReload.issues.map(issue => [issue.status, issue.role, issue.name]), [
    ['unreadable', 'jspInventory', 'JSP-unreadable.xlsx'],
  ]);
});

test('storage and schema failures use explicit safe statuses and never overwrite future data', async t => {
  await t.test('quota', async () => {
    const persistence = createMemoryPersistence();
    persistence.write = async () => { throw new DOMException('full', 'QuotaExceededError'); };
    const keyValueStorage = createMemoryKeyValue();
    const result = await createWorkspaceSnapshotStore({ persistence, keyValueStorage, now: NOW }).save({ preferences: {} });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'quota');
    assert.equal(result.preferencesRolledBack, true);
    assert.equal(keyValueStorage.has(WORKSPACE_PREFERENCES_KEY), false);
  });

  await t.test('denied', async () => {
    const persistence = createMemoryPersistence();
    const keyValueStorage = createMemoryKeyValue();
    keyValueStorage.setItem = () => { throw new DOMException('blocked', 'SecurityError'); };
    const result = await createWorkspaceSnapshotStore({ persistence, keyValueStorage, now: NOW }).save({ preferences: {} });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'denied');
    assert.equal(persistence.writes, 0);
  });

  await t.test('unavailable', async () => {
    const result = await createWorkspaceSnapshotStore({ persistence: {}, keyValueStorage: createMemoryKeyValue(), now: NOW }).restore();
    assert.equal(result.ok, false);
    assert.equal(result.status, 'unavailable');
    assert.equal(result.currentSessionPreserved, true);
  });

  await t.test('corrupt', async () => {
    const persistence = createMemoryPersistence({ schemaVersion: 1, sources: 'not-an-array' });
    const result = await createWorkspaceSnapshotStore({ persistence, keyValueStorage: createMemoryKeyValue(), now: NOW }).restore();
    assert.equal(result.ok, false);
    assert.equal(result.status, 'corrupt');
    assert.equal(result.currentSessionPreserved, true);
  });

  await t.test('corrupt existing Workspace Snapshot is preserved on save without preference writes', async () => {
    const corrupt = { schemaVersion: 1, sources: 'not-an-array', recoverable: 'keep-me' };
    const persistence = createMemoryPersistence(corrupt);
    const keyValueStorage = createMemoryKeyValue({
      [WORKSPACE_PREFERENCES_KEY]: JSON.stringify({ existing: 'preference-must-survive' }),
    });
    const result = await createWorkspaceSnapshotStore({ persistence, keyValueStorage, now: NOW }).save({
      sources: [source(new File(['new'], 'new.xlsx'), 'openOrders')],
      preferences: { activeWorkspace: 'data' },
    });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'corrupt');
    assert.equal(result.preserved, true);
    assert.equal(persistence.writes, 0);
    assert.strictEqual(persistence.inspect(), corrupt);
    assert.equal(keyValueStorage.setCalls, 0);
    assert.equal(keyValueStorage.removeCalls, 0);
    assert.equal(
      keyValueStorage.value(WORKSPACE_PREFERENCES_KEY),
      JSON.stringify({ existing: 'preference-must-survive' }),
    );
  });

  await t.test('unknown future Workspace Snapshot is preserved', async () => {
    const future = { schemaVersion: 99, futureData: 'keep-me' };
    const persistence = createMemoryPersistence(future);
    const keyValueStorage = createMemoryKeyValue();
    const store = createWorkspaceSnapshotStore({ persistence, keyValueStorage, now: NOW });
    const result = await store.save({ preferences: {} });
    assert.equal(result.ok, false);
    assert.equal(result.status, 'unsupported-version');
    assert.equal(result.preserved, true);
    assert.equal(persistence.writes, 0);
    assert.equal(keyValueStorage.setCalls, 0);
    assert.equal(keyValueStorage.removeCalls, 0);
    assert.strictEqual(persistence.inspect(), future);
    const replacement = await store.replaceSource('openOrders', []);
    assert.equal(replacement.status, 'unsupported-version');
    assert.strictEqual(persistence.inspect(), future);
  });

  await t.test('unknown future preferences are preserved', async () => {
    const futurePreferences = JSON.stringify({ schemaVersion: 9, future: true });
    const keyValueStorage = createMemoryKeyValue({ [WORKSPACE_PREFERENCES_KEY]: futurePreferences });
    const persistence = createMemoryPersistence();
    const result = await createWorkspaceSnapshotStore({ persistence, keyValueStorage, now: NOW }).save({ preferences: {} });
    assert.equal(result.status, 'unsupported-version');
    assert.equal(persistence.writes, 0);
    assert.equal(keyValueStorage.value(WORKSPACE_PREFERENCES_KEY), futurePreferences);
  });
});

test('partial restore returns every valid source and identifies only missing or unreadable inputs', async () => {
  const persistence = createMemoryPersistence();
  const keyValueStorage = createMemoryKeyValue();
  const writer = createWorkspaceSnapshotStore({ persistence, keyValueStorage, now: NOW });
  await writer.save({
    sources: [
      source(new File(['good'], 'JAM.xlsx'), 'openOrders'),
      source(new File(['bad'], 'AMZ.xlsx'), 'amazonInventory'),
    ],
    inputs: inputsWithoutFallbacks(),
    preferences: { activeWorkspace: 'data' },
  });
  let factoryCalls = 0;
  const reader = createWorkspaceSnapshotStore({
    persistence,
    keyValueStorage,
    now: NOW,
    fileFactory(blob, metadata) {
      factoryCalls += 1;
      if (metadata.name === 'AMZ.xlsx') throw new DOMException('cannot read', 'NotReadableError');
      return new File([blob], metadata.name, metadata);
    },
  });

  const first = await reader.restore({ requiredRoles: ['openOrders', 'amazonInventory', 'jspInventory'] });
  assert.equal(first.ok, true);
  assert.equal(first.status, 'partial');
  assert.deepEqual(first.plan.sources.map(item => item.name), ['JAM.xlsx']);
  assert.deepEqual(first.issues.map(issue => [issue.status, issue.role]), [
    ['unreadable', 'amazonInventory'],
    ['missing', 'jspInventory'],
  ]);
  assert.equal(first.issues.some(issue => issue.status === 'missing' && issue.role === 'amazonInventory'), false);
  assert.equal(persistence.writes, 1);

  const second = await reader.restore({ requiredRoles: ['openOrders', 'amazonInventory', 'jspInventory'] });
  assert.equal(second.status, 'partial');
  assert.deepEqual(second.plan.sources.map(item => item.name), ['JAM.xlsx']);
  assert.deepEqual(second.issues.map(issue => [issue.status, issue.role]), first.issues.map(issue => [issue.status, issue.role]));
  assert.equal(persistence.writes, 1, 'restore must not append rows, history, or storage records');
  assert.equal(factoryCalls, 4);
});

test('a snapshot whose saved Blobs cannot be reconstructed returns a usable partial plan without erasing it', async () => {
  const persistence = createMemoryPersistence();
  const keyValueStorage = createMemoryKeyValue();
  const store = createWorkspaceSnapshotStore({
    persistence,
    keyValueStorage,
    now: NOW,
    fileFactory() { throw new DOMException('damaged backing data', 'NotReadableError'); },
  });
  await store.save({
    sources: [source(new File(['bytes'], 'JAM.xlsx'), 'openOrders')],
    inputs: completeInputs(),
    preferences: { activeWorkspace: 'data' },
  });
  const savedRecord = persistence.inspect();
  const restored = await store.restore();
  assert.equal(restored.ok, true);
  assert.equal(restored.status, 'partial');
  assert.deepEqual(restored.plan.sources, []);
  assert.deepEqual(restored.plan.inputs, completeInputs());
  assert.equal(restored.plan.preferences.activeWorkspace, 'data');
  assert.equal(restored.issues[0].status, 'unreadable');
  assert.equal(restored.issues[0].role, 'openOrders');
  assert.equal(restored.issues[0].name, 'JAM.xlsx');
  assert.strictEqual(persistence.inspect(), savedRecord);
});

test('confirmed Clear removes only the exact Workspace allowlist and preserves the Boss session', async () => {
  const persistence = createMemoryPersistence({ schemaVersion: 1, private: 'raw-inputs' });
  const initial = Object.fromEntries(WORKSPACE_CLEAR_LOCAL_STORAGE_KEYS.map(key => [key, `value:${key}`]));
  initial['supply-boss-session'] = 'boss-token-must-survive';
  initial['another-app-key'] = 'unrelated';
  const keyValueStorage = createMemoryKeyValue(initial);
  const store = createWorkspaceSnapshotStore({ persistence, keyValueStorage, now: NOW });

  const blocked = await store.clear();
  assert.equal(blocked.ok, false);
  assert.equal(blocked.status, 'confirmation-required');
  assert.equal(persistence.removals, 0);
  assert.equal(keyValueStorage.has(WORKSPACE_PREFERENCES_KEY), true);

  const cleared = await store.clear({ confirmed: true });
  assert.equal(cleared.ok, true);
  assert.equal(cleared.status, 'cleared');
  assert.equal(persistence.inspect(), null);
  assert.equal(persistence.removals, 1);
  assert.deepEqual(cleared.removedKeys, WORKSPACE_CLEAR_LOCAL_STORAGE_KEYS);
  for (const key of WORKSPACE_CLEAR_LOCAL_STORAGE_KEYS) assert.equal(keyValueStorage.has(key), false, key);
  assert.equal(keyValueStorage.value('supply-boss-session'), 'boss-token-must-survive');
  assert.equal(keyValueStorage.value('another-app-key'), 'unrelated');
  assert.equal(keyValueStorage.clearCalls, 0);
  assert.deepEqual(keyValueStorage.keys().sort(), ['another-app-key', 'supply-boss-session']);
});

function createFakeIndexedDb() {
  const records = new Map();
  const objectStores = new Set();
  const openCalls = [];
  function createRequest(transaction, operation) {
    const request = {};
    queueMicrotask(() => {
      try {
        request.result = operation();
        request.onsuccess?.();
        queueMicrotask(() => transaction.oncomplete?.());
      } catch (error) {
        request.error = error;
        request.onerror?.();
      }
    });
    return request;
  }
  const indexedDB = {
    open(name, version) {
      openCalls.push([name, version]);
      const request = {};
      queueMicrotask(() => {
        const database = {
          objectStoreNames: { contains: key => objectStores.has(key) },
          createObjectStore: key => objectStores.add(key),
          transaction(storeName) {
            assert.equal(objectStores.has(storeName), true);
            const transaction = {};
            transaction.objectStore = () => ({
              get: key => createRequest(transaction, () => records.get(key)),
              put: (value, key) => createRequest(transaction, () => { records.set(key, value); return key; }),
              delete: key => createRequest(transaction, () => records.delete(key)),
            });
            return transaction;
          },
          close() {},
        };
        request.result = database;
        if (!objectStores.has(WORKSPACE_SNAPSHOT_OBJECT_STORE)) request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
  return { indexedDB, records, openCalls };
}

test('IndexedDB operations use the injected adapter and one exact database/store/record key', async () => {
  const fake = createFakeIndexedDb();
  const adapter = createIndexedDbWorkspaceAdapter({ indexedDB: fake.indexedDB });
  const record = { schemaVersion: 1, marker: 'local-only' };
  await adapter.write(record);
  assert.strictEqual(await adapter.read(), record);
  assert.deepEqual(fake.openCalls, [
    [WORKSPACE_SNAPSHOT_DATABASE, 1],
    [WORKSPACE_SNAPSHOT_DATABASE, 1],
  ]);
  assert.deepEqual([...fake.records.keys()], [WORKSPACE_SNAPSHOT_RECORD_KEY]);
  await adapter.remove();
  assert.equal(await adapter.read(), undefined);
  assert.deepEqual([...fake.records.keys()], []);
});
