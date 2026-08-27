import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '..');
const workspaceUiSource = fs.readFileSync(path.join(repoRoot, 'shared', 'workspace-ui.js'), 'utf8');
const pages = Object.freeze([
  Object.freeze({
    entrypoint:'public',
    html:fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8'),
    navigationSource:'./shared/workspace-navigation.js',
    workspaceUiPath:'./shared/workspace-ui.js',
  }),
  Object.freeze({
    entrypoint:'Boss',
    html:fs.readFileSync(path.join(repoRoot, 'Boss', 'index.html'), 'utf8'),
    navigationSource:'../shared/workspace-navigation.js',
    workspaceUiPath:'../shared/workspace-ui.js',
  }),
]);

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractFunctionSource(source, name) {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, `page should define ${name}`);
  const signatureEnd = source.indexOf(') {', start);
  assert.notEqual(signatureEnd, -1, `${name} should have a function body`);
  const bodyStart = signatureEnd + 2;
  assert.notEqual(bodyStart, -1, `${name} should have a function body`);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`Could not extract ${name}`);
}

function openingTagForId(html, id) {
  const match = html.match(new RegExp(`<[^>]+id="${id}"[^>]*>`));
  assert.ok(match, `${id} should exist`);
  return match[0];
}

function panelForId(html, id) {
  const tag = openingTagForId(html, id);
  const match = tag.match(/data-workspace-panel="([^"]+)"/);
  assert.ok(match, `${id} should belong to one workspace`);
  return match[1];
}

test('shared workspace UI is the only source of top navigation and Today markup', () => {
  const tabs = Array.from(workspaceUiSource.matchAll(/Object\.freeze\(\{ id:'([^']+)', label:'([^']+)' \}\)/g), match => [match[1], match[2]]);
  assert.deepEqual(tabs, [
    ['today', 'Today'],
    ['data', 'Data'],
    ['recommendations', 'Recommendations'],
    ['orders', 'Orders'],
    ['analysis', 'Analysis'],
  ]);
  assert.match(workspaceUiSource, /function navigationMarkup\(\)/);
  assert.match(workspaceUiSource, /function todayMarkup\(\)/);
  assert.equal((workspaceUiSource.match(/class="todayNextAction"/g) || []).length, 1);
  for (const id of ['todaySourceReadiness', 'todayPriorityCount', 'todayVelocityRiskCount', 'todayOrderGroupTotal', 'todayOrderGroupCounts', 'todayHighestRisk', 'todayNextActionReason']) {
    assert.match(workspaceUiSource, new RegExp(`id="${id}"`));
  }

  for (const { entrypoint, html, navigationSource, workspaceUiPath } of pages) {
    assert.match(html, new RegExp(`<script type="module" src="${escapeRegex(navigationSource)}"`), entrypoint);
    assert.match(html, new RegExp(`<script type="module" src="${escapeRegex(workspaceUiPath)}"`), entrypoint);
    assert.equal((html.match(/id="workspaceNavMount"/g) || []).length, 1, entrypoint);
    assert.equal((html.match(/id="todayWorkspaceMount"/g) || []).length, 1, entrypoint);
    assert.doesNotMatch(html, /<nav class="workspaceTopNav"/, entrypoint);
    assert.doesNotMatch(html, /<section class="todayWorkspaceSummary"/, entrypoint);
    assert.doesNotMatch(html, /function (?:renderTodayWorkspace|activateWorkspace|syncWorkspaceFromLocation|wireWorkflowNavigation)\(/, entrypoint);
  }
});

for (const { entrypoint, html } of pages) {
  test(`${entrypoint}: no sidebar or residual width and every page surface starts hidden in one workspace`, () => {
    assert.doesNotMatch(html, /appSidebar|sideNav|sidebarCollapse|sidebarCollapsed|mobileNavButton|navScrim|navOpen/);
    assert.match(html, /body \{ overflow-x:hidden; \}/);
    assert.match(html, /\.page \{ width:100%; min-width:0; \}/);
    assert.doesNotMatch(html, /body\s*\{[^}]*padding-left/);
    assert.match(html, /\.workspaceTopNav \{[^}]*position:sticky;[^}]*justify-content:center/);
    assert.match(html, /\[data-workspace-panel\]\[hidden\] \{ display:none !important; \}/);

    assert.equal(panelForId(html, 'workflowTop'), 'data');
    assert.equal(panelForId(html, 'bossStatusBar'), 'data');
    assert.equal(panelForId(html, 'workflowHealth'), 'data');
    assert.equal(panelForId(html, 'uploadCard'), 'data');
    assert.equal(panelForId(html, 'controlDock'), 'recommendations');
    assert.equal(panelForId(html, 'decisionDashboard'), 'recommendations');
    assert.equal(panelForId(html, 'reorderCard'), 'recommendations');
    assert.equal(panelForId(html, 'generatorCard'), 'orders');
    for (const id of ['skuDecisionTreeCard', 'autoDecisionTreeCard', 'mainCard', 'hotCard', 'newCard', 'salesPieDetails', 'salesGanttDetails', 'otherToolsDetails']) {
      assert.equal(panelForId(html, id), 'analysis');
    }
    const pagePanels = Array.from(html.matchAll(/<[^>]+data-workspace-panel="[^"]+"[^>]*>/g), match => match[0]);
    assert.ok(pagePanels.length >= 15);
    for (const tag of pagePanels) assert.match(tag, /\shidden(?:\s|>)/);
  });

  test(`${entrypoint}: page keeps only summary and persistence adapters`, () => {
    const summaryInput = extractFunctionSource(html, 'getTodayWorkspaceInput');
    const workspaceChanged = extractFunctionSource(html, 'onWorkspaceChanged');
    const start = extractFunctionSource(html, 'startWorkspaceUi');
    const capture = extractFunctionSource(html, 'captureActiveWorkspace');
    const apply = extractFunctionSource(html, 'applyWorkspacePreferences');
    assert.match(summaryInput, /const sourceReadiness = getWorkspaceSourceReadiness\(\)/);
    assert.match(summaryInput, /priorityRows/);
    assert.match(summaryInput, /velocityRiskRows/);
    assert.match(summaryInput, /orderDraft:generatorDraft/);
    assert.match(workspaceChanged, /scheduleWorkspaceAutoSave\(\{ userInitiated \}\)/);
    assert.match(start, /SupplyWorkspaceUI/);
    assert.match(start, /createWorkspaceUi\(\{/);
    assert.match(start, /getSummaryInput:getTodayWorkspaceInput/);
    assert.match(start, /onWorkspaceChanged/);
    assert.match(capture, /workspaceUiController\?\.getActiveWorkspace\(\)/);
    assert.match(apply, /restoredWorkspacePreference = ids\.includes\(preferences\.activeWorkspace\)/);
    assert.match(html, /startWorkspaceUi\(restoredWorkspacePreference\)/);
  });

  test(`${entrypoint}: Orders is segmented, bounded, vertical, keyboard-visible, and narrow responsive`, () => {
    assert.equal((html.match(/role="radiogroup" aria-label="訂單群組"/g) || []).length, 1);
    const values = Array.from(html.matchAll(/name="orderGroupSelect" value="([^"]+)"/g), match => match[1]);
    assert.deepEqual(values, ['taiwan', 'vietnam', 'subcontract']);
    assert.match(html, /\.generatorQuantityGroup, \.generatorQuantityGroup\.single \{[^}]*display:flex;[^}]*flex-direction:column/);
    assert.match(html, /\.tableWrap, \.order-generator \.table-responsive \{[^}]*max-height:min\(68vh,720px\);[^}]*overflow:auto/);
    assert.match(html, /\.tableWrap thead th, \.order-generator \.table-responsive thead th \{[^}]*position:sticky;[^}]*top:0/);
    assert.match(html, /\.workspaceNavTab:focus-visible/);
    assert.match(html, /@media \(max-width:760px\)/);
    assert.match(html, /@media \(prefers-reduced-motion:reduce\)/);
  });
}

test('shared controller owns activation, URL history, keyboard focus, reduced motion, and Today projection', () => {
  assert.match(workspaceUiSource, /projectTodaySummary\(getSummaryInput\(\) \|\| \{\}\)/);
  assert.match(workspaceUiSource, /querySelectorAll\('\[data-workspace-panel\]'\)/);
  assert.match(workspaceUiSource, /panel\.hidden = panel\.dataset\.workspacePanel !== workspace/);
  assert.match(workspaceUiSource, /resolveInitialWorkspace\(\{/);
  assert.match(workspaceUiSource, /pushState/);
  assert.match(workspaceUiSource, /replaceState/);
  assert.match(workspaceUiSource, /addEventListener\('popstate', syncFromLocation\)/);
  assert.match(workspaceUiSource, /addEventListener\('hashchange', syncFromLocation\)/);
  assert.match(workspaceUiSource, /\['ArrowLeft', 'ArrowRight', 'Home', 'End'\]/);
  assert.match(workspaceUiSource, /focus:true/);
  assert.match(workspaceUiSource, /prefers-reduced-motion: reduce/);
  assert.match(workspaceUiSource, /dataset\.workspaceUiReady = 'true'/);
  assert.doesNotMatch(workspaceUiSource, /localStorage|indexedDB|resetBossAnalysisData|clearGeneratorDraftStorage/);
});

test('public and Boss preserve their own adapters while sharing one rendered interface', () => {
  const publicHtml = pages[0].html;
  const bossHtml = pages[1].html;
  assert.match(publicHtml, /indexedDB:window\.indexedDB/);
  assert.match(bossHtml, /id="bossAuthGate"/);
  assert.match(bossHtml, /supply-boss-session/);
  assert.match(bossHtml, /\/api\/snapshot/);
  assert.doesNotMatch(publicHtml, /supply-boss-session/);
  for (const name of ['getWorkspaceSourceReadiness', 'getTodayWorkspaceInput', 'onWorkspaceChanged', 'startWorkspaceUi']) {
    assert.match(publicHtml, new RegExp(`function ${name}\\(`));
    assert.match(bossHtml, new RegExp(`function ${name}\\(`));
  }
});

test('legacy adapter still exposes the shared navigation runtime to both pages', () => {
  const adapter = fs.readFileSync(path.join(repoRoot, 'shared', 'legacy-planning-adapter.js'), 'utf8');
  assert.match(adapter, /import '\.\/workspace-navigation\.js';/);
});
