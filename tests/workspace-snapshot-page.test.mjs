import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import {
  WORKSPACE_CLEAR_LOCAL_STORAGE_KEYS,
  WORKSPACE_SNAPSHOT_SCHEMA_VERSION,
  createWorkspaceSnapshotStore,
} from '../shared/workspace-snapshot.js';

const repoRoot = path.resolve(import.meta.dirname, '..');
const publicHtml = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');
const bossHtml = fs.readFileSync(path.join(repoRoot, 'Boss', 'index.html'), 'utf8');

function extractFunctionSource(html, name) {
  const marker = 'function ' + name + '(';
  const start = html.indexOf(marker);
  assert.notEqual(start, -1, 'page should define ' + name);
  const bodyMarker = /\)\s*\{/.exec(html.slice(start));
  assert.ok(bodyMarker, 'page should define a body for ' + name);
  const bodyStart = start + bodyMarker.index + bodyMarker[0].lastIndexOf('{');
  let depth = 0;
  for (let index = bodyStart; index < html.length; index += 1) {
    if (html[index] === '{') depth += 1;
    if (html[index] === '}') {
      depth -= 1;
      if (depth === 0) return html.slice(start, index + 1);
    }
  }
  throw new Error('Could not extract ' + name);
}

test('public and Boss load the Workspace Snapshot runtime at the correct depth', () => {
  assert.match(publicHtml, /src="\.\/shared\/workspace-snapshot\.js"/);
  assert.match(bossHtml, /src="\.\.\/shared\/workspace-snapshot\.js"/);
  assert.match(publicHtml, /id="workspaceSnapshotState"[^>]*aria-live="polite"/);
  assert.match(bossHtml, /登入憑證不會寫入 Workspace Snapshot/);
});

test('public creates the local IndexedDB store while Boss keeps its authenticated cloud adapter', () => {
  const store = extractFunctionSource(publicHtml, 'getPublicWorkspaceSnapshotStore');
  assert.match(store, /if \(IS_BOSS_PORTAL\) return null/);
  assert.match(store, /indexedDB:window\.indexedDB/);
  assert.match(store, /keyValueStorage:window\.localStorage/);
  assert.doesNotMatch(store, /fetch\(/);

  const bossLoad = extractFunctionSource(bossHtml, 'loadBossSnapshot');
  assert.match(bossLoad, /bossApiFetch\('\/api\/snapshot'/);
  assert.match(bossHtml, /sessionStorage\.getItem\(BOSS_TOKEN_KEY\)/);
  assert.match(bossHtml, /headers\.set\('Authorization',/);
});

test('Boss resolves cloud file URLs against the API origin before attaching its Bearer token', async () => {
  const source = extractFunctionSource(bossHtml, 'bossApiFetch');
  assert.ok(source.indexOf('target.origin !== apiBase.origin') < source.indexOf("headers.set('Authorization'"));
  const requests = [];
  const context = vm.createContext({
    URL,
    Headers,
    TypeError,
    BOSS_API_BASE:'https://supply-boss.brave-prawn-0848.chatgpt.site',
    bossAuthToken:'private-token',
    fetch(url, options) {
      requests.push({ url, authorization:options.headers.get('Authorization') });
      return Promise.resolve({ ok:true });
    },
  });
  vm.runInContext(`${source}; globalThis.callBossApi = bossApiFetch;`, context);

  await context.callBossApi('/api/files/safe.xlsx');
  assert.deepEqual(requests, [{
    url:'https://supply-boss.brave-prawn-0848.chatgpt.site/api/files/safe.xlsx',
    authorization:'Bearer private-token',
  }]);
  await assert.rejects(
    async () => context.callBossApi('https://evil.invalid/steal.xlsx'),
    /來源網址不受允許/,
  );
  assert.equal(requests.length, 1, 'cross-origin URL must fail before fetch and before Authorization can leave the API origin');
});

test('successful parsers classify exact raw source roles before public persistence', () => {
  for (const html of [publicHtml, bossHtml]) {
    const classify = extractFunctionSource(html, 'autoClassifyAndReadFiles');
    for (const role of ['openOrders', 'amazonInventory', 'jspInventory', 'salesReport', 'h10TextFile']) {
      assert.match(classify, new RegExp("rememberSource\\('" + role + "'\\)"));
    }
    assert.match(classify, /classifiedSources/);
    assert.ok(classify.indexOf("h10El.value = h10TextParts.join('\\n\\n')") < classify.indexOf('stageWorkspaceH10Draft()'));
    assert.ok(classify.indexOf('workspaceH10SelectedAt = sourceSelectedAt') < classify.indexOf('stageWorkspaceH10Draft()'));
    const individual = extractFunctionSource(html, 'parseAndRememberWorkspaceFile');
    assert.match(individual, /return enqueueWorkspaceParse\(async \(\) =>/);
    assert.ok(individual.indexOf('await parser(file)') < individual.indexOf('rememberSuccessfulWorkspaceSources(records)'));
    const master = extractFunctionSource(html, 'handleMasterFileSelection');
    assert.match(master, /enqueueWorkspaceParse|rebuildBossPendingInputs/);
    assert.ok(master.indexOf('autoClassifyAndReadFiles(files)') < master.indexOf('rememberSuccessfulWorkspaceSources(analysis.classifiedSources)'));
  }
});

test('the page parse seam is one bounded FIFO that keeps working after a failed parse', async () => {
  for (const html of [publicHtml, bossHtml]) {
    const context = vm.createContext({ Promise });
    vm.runInContext(`let workspaceParseQueue = Promise.resolve(); let workspaceClearInProgress = false; ${extractFunctionSource(html, 'enqueueWorkspaceParse')}; globalThis.enqueue = enqueueWorkspaceParse;`, context);
    const events = [];
    let releaseFirst;
    const firstGate = new Promise(resolve => { releaseFirst = resolve; });
    const first = context.enqueue(async () => {
      events.push('first-start');
      await firstGate;
      events.push('first-end');
      return 'first';
    });
    const second = context.enqueue(async () => {
      events.push('second');
      return 'second';
    });
    await Promise.resolve();
    assert.deepEqual(events, ['first-start']);
    releaseFirst();
    assert.deepEqual(await Promise.all([first, second]), ['first', 'second']);
    assert.deepEqual(events, ['first-start', 'first-end', 'second']);
    await assert.rejects(context.enqueue(async () => { throw new Error('bad parse'); }), /bad parse/);
    assert.equal(await context.enqueue(async () => 'latest-success'), 'latest-success');
  }
  assert.doesNotMatch(bossHtml, /bossRebuildQueue/);
  assert.match(extractFunctionSource(bossHtml, 'rebuildBossPendingInputs'), /return enqueueWorkspaceParse\(run\)/);
});

test('Boss rejects incomplete or unreadable replacements without blanking the current session', () => {
  const rebuild = extractFunctionSource(bossHtml, 'rebuildBossPendingInputs');
  assert.ok(rebuild.indexOf('const previousSession = captureWorkspaceSessionState()') < rebuild.indexOf('resetBossAnalysisData()'));
  assert.match(rebuild, /analysis\.failedCount \|\| analysis\.unrecognizedCount \|\| missing\.length/);
  assert.ok(rebuild.indexOf('restoreWorkspaceSessionState(previousSession)') < rebuild.indexOf('rememberBossFiles(files, analysis)'));
  const save = extractFunctionSource(bossHtml, 'saveBossSnapshot');
  assert.match(save, /analysisToSave\.failedCount \|\| analysisToSave\.unrecognizedCount/);
});

test('restore reconstructs through the same classifier exactly once without history writes or fake file inputs', () => {
  for (const html of [publicHtml, bossHtml]) {
    const restore = extractFunctionSource(html, 'restoreWorkspaceInputs');
    assert.match(restore, /autoClassifyAndReadFiles\(restoredFiles/);
    assert.match(restore, /recordVelocityHistory:false/);
    assert.match(restore, /shouldRecordVelocityHistory = false/);
    assert.equal((restore.match(/buildTables\(\)/g) || []).length, 1);
    assert.doesNotMatch(restore, /\.files\s*=/);
    assert.match(restore, /inputs\.overrideMarker/);
    assert.match(restore, /inputs\.h10ObservedOn/);
  }
  const bossLoad = extractFunctionSource(bossHtml, 'loadBossSnapshot');
  assert.match(bossLoad, /restoreWorkspaceInputs\(\{/);
  assert.doesNotMatch(bossLoad, /recordBossSnapshotVelocityHistory\(manifest\)/);
});

test('Workspace preferences cover planning, order group, filters, columns, search, Gantt, and tree state', () => {
  for (const html of [publicHtml, bossHtml]) {
    const capture = extractFunctionSource(html, 'captureWorkspacePreferences');
    for (const token of [
      'targetDays', 'leadTimeDays', 'fbaTransferDays', 'factoryMode', 'itemFilterMode',
      'hideDiscontinuedMode', 'onlyNoOrderMode', 'reorderVelocityRiskOnly', 'sortConfig',
      'orderGroup', 'generatorColumns', 'mainSearch', 'skuTreeInput', 'skuTreeDaysThreshold',
      'skuTreeAlertsOnly', 'openSections', 'decisionPanel', 'toolPanel', 'gantt'
    ]) assert.match(capture, new RegExp('\\b' + token + '\\b'));
    const inputs = extractFunctionSource(html, 'captureWorkspaceInputs');
    assert.match(inputs, /h10Paste/);
    assert.match(inputs, /manualText/);
    assert.match(inputs, /overrideMarker/);
    assert.doesNotMatch(inputs, /token|password|authorization/i);
  }
});

test('public restore reports partial and future-version states without overwriting them', () => {
  const restore = extractFunctionSource(publicHtml, 'restorePublicWorkspace');
  assert.match(restore, /store\.restore\(\{ requiredRoles:\['openOrders', 'amazonInventory', 'jspInventory'\] \}\)/);
  assert.match(restore, /result\.status === 'partial' \|\| parserPartial/);
  assert.match(restore, /workspacePersistenceBlocked = issues\.length > 0/);
  assert.ok(restore.indexOf('applyWorkspacePreferences(result.plan.preferences)') < restore.indexOf('restoreWorkspaceInputs({ sources:result.plan.sources'));
  assert.doesNotMatch(restore, /if \(!result\.plan\.sources\.length\).*return/s);
  assert.match(restore, /formatWorkspaceReplacementIssues\(issues, analysis\)/);
  assert.match(restore, /仍需處理/);
  const messages = extractFunctionSource(publicHtml, 'getWorkspaceStorageMessage');
  for (const status of ['quota', 'denied', 'unavailable', 'corrupt', 'unsupported-version', 'unreadable']) {
    assert.match(messages, new RegExp("['\"]?" + status.replace('-', '\\-') + "['\"]?:"));
  }
});

test('public saves stay warning/partial until every preserved unreadable role is replaced', () => {
  const persist = extractFunctionSource(publicHtml, 'persistWorkspaceSnapshot');
  assert.ok(persist.indexOf('const run = async () =>') < persist.indexOf('const payload = {'));
  assert.ok(persist.indexOf('const payload = {') < persist.indexOf('await store.save(payload)'));
  assert.match(persist, /result\.status === 'partial'/);
  assert.match(persist, /remainingIssues\.length > 0/);
  assert.match(persist, /formatWorkspaceReplacementIssues\(remainingIssues\)/);
  assert.match(persist, /仍需處理/);
  assert.ok(persist.indexOf("setWorkspaceSnapshotState('已保存可讀資料") < persist.indexOf("setWorkspaceSnapshotState('已安全保存"));
  const bossPersist = extractFunctionSource(bossHtml, 'persistWorkspaceSnapshot');
  assert.ok(bossPersist.indexOf('const run = async () =>') < bossPersist.indexOf('const payload = {'));
});

test('partial restore names the exact source role and filename that must be replaced', () => {
  const context = vm.createContext({
    WORKSPACE_SOURCE_LABEL_BY_ROLE: {
      openOrders:'JAM 訂單',
      amazonInventory:'H10 / AMZ 庫存',
      jspInventory:'JSP 庫存',
      salesReport:'銷售額',
      h10TextFile:'H10 原始文字',
    },
  });
  vm.runInContext(`${extractFunctionSource(publicHtml, 'formatWorkspaceReplacementIssues')}; globalThis.formatIssues = formatWorkspaceReplacementIssues;`, context);
  const message = context.formatIssues(
    [{ kind:'source', status:'unreadable', role:'openOrders', name:'JAM-old.xlsx' }],
    { failedCount:1, unrecognizedCount:1, results:['H10-bad.csv → 讀取失敗：broken', 'mystery.bin → 無法判斷'] },
  );
  assert.match(message, /JAM 訂單（JAM-old\.xlsx）/);
  assert.match(message, /H10-bad\.csv（讀取失敗）/);
  assert.match(message, /mystery\.bin（無法辨識）/);
});

test('Clear is confirmed, cancels pending writes, uses the exact store clear, and preserves Boss auth', () => {
  const clear = extractFunctionSource(publicHtml, 'requestClearWorkspace');
  assert.match(clear, /window\.confirm\(/);
  assert.match(clear, /cancelWorkspaceAutoSave\(\)/);
  assert.match(clear, /workspaceSaveEpoch \+= 1/);
  assert.ok(clear.indexOf('workspaceClearInProgress = true') < clear.indexOf('await workspaceParseQueue'));
  assert.match(clear, /finally \{\s*workspaceClearInProgress = false/);
  assert.ok(clear.indexOf('await workspaceParseQueue') < clear.indexOf('await workspaceSaveQueue'));
  assert.match(clear, /await workspaceSaveQueue/);
  assert.match(clear, /store\.clear\(\{ confirmed:true \}\)/);
  assert.ok(clear.indexOf('if (!result.ok)') < clear.indexOf('resetWorkspaceUiAfterClear()'));
  assert.ok(clear.indexOf('workspaceAutoSaveSuppressedUntilUserChange = true') < clear.indexOf('resetWorkspaceUiAfterClear()'));
  assert.ok(clear.lastIndexOf('cancelWorkspaceAutoSave()') > clear.indexOf('resetWorkspaceUiAfterClear()'));
  assert.doesNotMatch(clear, /localStorage\.clear|supply-boss-session|BOSS_TOKEN_KEY/);
  assert.doesNotMatch(publicHtml, /localStorage\.clear\(/);
  const schedule = extractFunctionSource(publicHtml, 'scheduleWorkspaceAutoSave');
  assert.match(schedule, /if \(workspaceClearInProgress\) return/);
  assert.match(schedule, /workspaceAutoSaveSuppressedUntilUserChange && !userInitiated/);
  assert.match(schedule, /workspacePersistenceBlocked && !userInitiated/);
  assert.match(schedule, /persistWorkspaceSnapshot\(\{ force:userInitiated \}\)/);
  const h10Draft = extractFunctionSource(publicHtml, 'stageWorkspaceH10Draft');
  assert.match(h10Draft, /store\.stageH10Draft\(/);
  assert.match(h10Draft, /h10Paste:h10El\?\.value \|\| ''/);
  assert.match(h10Draft, /h10ObservedOn:h10SourceObservedOn \|\| null/);
  assert.match(h10Draft, /h10SelectedAt:workspaceH10SelectedAt/);
  const issueFormatter = extractFunctionSource(publicHtml, 'formatWorkspaceReplacementIssues');
  assert.match(issueFormatter, /issue\.status === 'unsupported-version'[\s\S]*請用較新版本開啟/);
  assert.match(issueFormatter, /issue\.status === 'corrupt'[\s\S]*按上方「清空」後重建/);
  const persistenceWiring = extractFunctionSource(publicHtml, 'wireWorkspacePersistence');
  assert.match(persistenceWiring, /event\?\.isTrusted/);
  assert.match(persistenceWiring, /details\[id\][\s\S]*isUserInitiatedDetailsToggle\(element\)/);
  assert.match(persistenceWiring, /workspaceH10SelectedAt = new Date\(\)\.toISOString\(\)/);
  assert.match(persistenceWiring, /stageWorkspaceH10Draft\(\)/);
  assert.match(extractFunctionSource(publicHtml, 'restorePublicWorkspace'), /result\.recoveredH10Draft[\s\S]*persistWorkspaceSnapshot\(\{ force:true \}\)/);
  const reset = extractFunctionSource(publicHtml, 'resetWorkspaceUiAfterClear');
  for (const token of ['input[type="file"]', 'defaultOpenSections', 'priorityPanel', 'amzOver180Panel', 'createOrderDraft', 'velocityHistoryFailureSignature']) {
    assert.match(reset, new RegExp(token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  const bossClear = extractFunctionSource(bossHtml, 'requestClearWorkspace');
  assert.match(bossClear, /if \(IS_BOSS_PORTAL\) return deleteBossSnapshot\(\)/);
  const bossLocalClear = extractFunctionSource(bossHtml, 'clearWorkspaceLocalStorageKeys');
  assert.match(bossLocalClear, /SupplyWorkspaceSnapshot\?\.WORKSPACE_CLEAR_LOCAL_STORAGE_KEYS/);
  assert.match(bossLocalClear, /window\.localStorage\.removeItem\(key\)/);
  assert.match(bossLocalClear, /partial-local-clear/);
  assert.doesNotMatch(bossLocalClear, /localStorage\.clear|sessionStorage/);
  const bossDelete = extractFunctionSource(bossHtml, 'deleteBossSnapshot');
  assert.ok(bossDelete.indexOf("method:'DELETE'") < bossDelete.indexOf('clearWorkspaceLocalStorageKeys()'));
  assert.match(bossDelete, /resetWorkspaceUiAfterClear\(\)/);
  assert.match(bossDelete, /if \(!localClear\.ok\)/);
  assert.match(bossDelete, /remoteCleared:true/);
  assert.ok(bossDelete.indexOf('workspaceClearInProgress = true') < bossDelete.indexOf('await workspaceParseQueue'));
  assert.match(bossDelete, /finally \{\s*workspaceClearInProgress = false/);
  assert.doesNotMatch(bossDelete, /BOSS_TOKEN_KEY|sessionStorage\.removeItem/);
  assert.ok(WORKSPACE_CLEAR_LOCAL_STORAGE_KEYS.length > 0);
  assert.ok(!WORKSPACE_CLEAR_LOCAL_STORAGE_KEYS.includes('supply-boss-session'));
});

test('programmatic details resets cannot revive an empty Snapshot after Clear', () => {
  for (const html of [publicHtml, bossHtml]) {
    const context = vm.createContext({ document:{ activeElement:null } });
    vm.runInContext(
      `${extractFunctionSource(html, 'isUserInitiatedDetailsToggle')}; globalThis.isUserToggle = isUserInitiatedDetailsToggle;`,
      context,
    );
    const summary = {};
    const details = { querySelector:selector => selector === ':scope > summary' ? summary : null };
    assert.equal(context.isUserToggle(details), false);
    context.document.activeElement = summary;
    assert.equal(context.isUserToggle(details), true);
  }
});

test('Boss cloud restore never presents parser failures or unrecognized files as ready', () => {
  const load = extractFunctionSource(bossHtml, 'loadBossSnapshot');
  assert.match(load, /analysis\.failedCount \|\| analysis\.unrecognizedCount/);
  assert.match(load, /restoreIncomplete \? 'error' : 'ready'/);
  assert.match(load, /restoreIncomplete \? 'warning' : 'ready'/);
  assert.match(load, /只套用可讀資料/);
});

test('Boss local Clear attempts the shared exact allowlist and reports any failed removal', () => {
  const attempted = [];
  const failingKey = WORKSPACE_CLEAR_LOCAL_STORAGE_KEYS[1];
  const context = vm.createContext({
    window: {
      SupplyWorkspaceSnapshot:{ WORKSPACE_CLEAR_LOCAL_STORAGE_KEYS },
      localStorage:{
        removeItem(key) {
          attempted.push(key);
          if (key === failingKey) throw new Error('blocked');
        },
      },
    },
  });
  vm.runInContext(`${extractFunctionSource(bossHtml, 'clearWorkspaceLocalStorageKeys')}; globalThis.clearKeys = clearWorkspaceLocalStorageKeys;`, context);
  const result = context.clearKeys();
  assert.equal(result.ok, false);
  assert.equal(result.status, 'partial-local-clear');
  assert.deepEqual(attempted, [...WORKSPACE_CLEAR_LOCAL_STORAGE_KEYS]);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0].key, failingKey);
});

test('both pages depend on the shared snapshot module through its observable adapter seam', () => {
  assert.equal(WORKSPACE_SNAPSHOT_SCHEMA_VERSION, 1);
  assert.equal(typeof createWorkspaceSnapshotStore, 'function');
  for (const html of [publicHtml, bossHtml]) {
    const store = extractFunctionSource(html, 'getPublicWorkspaceSnapshotStore');
    assert.match(store, /api\.createWorkspaceSnapshotStore\(\{/);
    assert.match(store, /indexedDB:window\.indexedDB/);
    assert.match(store, /keyValueStorage:window\.localStorage/);
    const restore = extractFunctionSource(html, 'restoreWorkspaceInputs');
    assert.match(restore, /recordVelocityHistory:false/);
    assert.doesNotMatch(restore, /\.files\s*=/);
  }
});
