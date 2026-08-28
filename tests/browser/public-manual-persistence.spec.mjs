import { expect, test } from '@playwright/test';

import { SANITIZED_H10_TEXT } from '../fixtures/sanitized-supply-browser.mjs';
import {
  expectOnlyWorkspace,
  freezeBrowserTime,
  installOfflineAssetRoutes,
  monitorBrowserErrors,
  readWorkspaceSnapshot,
  waitForSupplyApp,
} from './browser-helpers.mjs';

const LEGACY_TODAY_PREFERENCES = Object.freeze({
  schemaVersion:1,
  updatedAt:'2026-08-27T08:30:00.000Z',
  activeWorkspace:'today',
  planning:{},
  filters:{},
  otherText:{},
});

async function waitForSnapshot(page, predicate) {
  await expect.poll(async () => {
    const snapshot = await readWorkspaceSnapshot(page);
    return snapshot && predicate(snapshot) ? snapshot : null;
  }, { timeout:8_000 }).not.toBeNull();
}

test('legacy saved Today preference restores and resaves as canonical Recommendations', async ({ page, context }) => {
  await freezeBrowserTime(page);
  const unexpectedRequests = [];
  await installOfflineAssetRoutes(context, unexpectedRequests);
  const browserErrors = monitorBrowserErrors(page);
  await page.addInitScript(preferences => {
    localStorage.setItem('supply-workspace-preferences-v1', JSON.stringify(preferences));
  }, LEGACY_TODAY_PREFERENCES);

  await page.goto('/');
  await waitForSupplyApp(page);
  await expect(page).toHaveURL(/#recommendations$/);
  await expectOnlyWorkspace(page, 'recommendations');
  await expect(page.locator('#todayWorkspaceSummary')).toBeVisible();
  await expect(page.locator('#decisionDashboard')).toBeVisible();
  await expect(page.locator('.workspaceNavTab[data-workspace="today"]')).toHaveCount(0);

  await page.locator('.workspaceNavTab[data-workspace="recommendations"]').click();
  await expect.poll(() => page.evaluate(() => {
    const value = localStorage.getItem('supply-workspace-preferences-v1');
    return value ? JSON.parse(value).activeWorkspace : null;
  }), { timeout:8_000 }).toBe('recommendations');

  expect(unexpectedRequests).toEqual([]);
  expect(browserErrors).toEqual([]);
});

test('manual-only JAM, H10, and JSP restore ready and continue autosaving after reload', async ({ page, context }) => {
  await freezeBrowserTime(page);
  const unexpectedRequests = [];
  await installOfflineAssetRoutes(context, unexpectedRequests);
  const browserErrors = monitorBrowserErrors(page);

  await page.goto('/#data');
  await waitForSupplyApp(page);
  await page.locator('.uploadAdvancedDetails > summary').click();
  await page.locator('#inputOrders').locator('xpath=ancestor::details[1]').locator('summary').click();
  await page.locator('#inputUSJsp').locator('xpath=ancestor::details[1]').locator('summary').click();

  await page.locator('#inputH10').fill(SANITIZED_H10_TEXT);
  await waitForSnapshot(page, snapshot => snapshot.inputs.h10Paste === SANITIZED_H10_TEXT);
  await expect(page.locator('#workspaceSnapshotState')).toHaveAttribute('data-state', 'warning');
  await expect(page.locator('#workspaceSnapshotState')).toContainText('JAM 訂單');
  await expect(page.locator('#workspaceSnapshotState')).toContainText('JSP 庫存');

  await page.locator('#inputOrders').fill('EZD011AM\t4');
  await waitForSnapshot(page, snapshot => (
    snapshot.inputs.overrideMarker.jam === true
    && snapshot.inputs.manualText.jam === 'EZD011AM\t4'
  ));
  await expect(page.locator('#workspaceSnapshotState')).toHaveAttribute('data-state', 'warning');
  await expect(page.locator('#workspaceSnapshotState')).not.toContainText('JAM 訂單');
  await expect(page.locator('#workspaceSnapshotState')).toContainText('JSP 庫存');

  await page.locator('#inputUSJsp').fill('EZD011AM\t2');
  await waitForSnapshot(page, snapshot => (
    snapshot.sources.length === 0
    && snapshot.inputs.overrideMarker.jsp === true
    && snapshot.inputs.manualText.jsp === 'EZD011AM\t2'
  ));
  await expect(page.locator('#workspaceSnapshotState')).toHaveAttribute('data-state', 'ready');
  await expect(page.locator('#todaySourceReadiness')).toHaveText('3 / 3');

  await page.reload();
  await waitForSupplyApp(page);
  await expect(page.locator('#workspaceSnapshotState')).toHaveAttribute('data-state', 'ready');
  await expect(page.locator('#workspaceSnapshotState')).toContainText('已從本機還原 Workspace Snapshot');
  await expect(page.locator('#todaySourceReadiness')).toHaveText('3 / 3');
  await expect(page.locator('#inputH10')).toHaveValue(SANITIZED_H10_TEXT);
  await expect(page.locator('#inputOrders')).toHaveValue('EZD011AM\t4');
  await expect(page.locator('#inputUSJsp')).toHaveValue('EZD011AM\t2');
  expect((await readWorkspaceSnapshot(page)).sources).toHaveLength(0);

  await page.locator('.uploadAdvancedDetails > summary').click();
  await page.locator('#inputOrders').locator('xpath=ancestor::details[1]').locator('summary').click();
  await page.locator('#inputOrders').fill('EZD011AM\t6');
  await waitForSnapshot(page, snapshot => snapshot.inputs.manualText.jam === 'EZD011AM\t6');
  await expect(page.locator('#workspaceSnapshotState')).toHaveAttribute('data-state', 'ready');

  expect(unexpectedRequests).toEqual([]);
  expect(browserErrors).toEqual([]);
});

test('pasted H10 text survives an immediate refresh before the debounced snapshot save', async ({ page, context }) => {
  await freezeBrowserTime(page);
  const unexpectedRequests = [];
  await installOfflineAssetRoutes(context, unexpectedRequests);
  const browserErrors = monitorBrowserErrors(page);

  await page.goto('/#data');
  await waitForSupplyApp(page);
  await page.locator('#inputH10').fill(SANITIZED_H10_TEXT);
  await page.reload();
  await waitForSupplyApp(page);

  await expect(page.locator('#inputH10')).toHaveValue(SANITIZED_H10_TEXT);

  await page.locator('#inputH10').fill('');
  await waitForSnapshot(page, snapshot => snapshot.inputs.h10Paste === '');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('supply-workspace-h10-draft-v1'))).toBeNull();
  await page.reload();
  await waitForSupplyApp(page);
  await expect(page.locator('#inputH10')).toHaveValue('');

  expect(unexpectedRequests).toEqual([]);
  expect(browserErrors).toEqual([]);
});

test('a newly imported H10 text file replaces an older pasted draft even across an immediate refresh', async ({ page, context }) => {
  await freezeBrowserTime(page);
  const unexpectedRequests = [];
  await installOfflineAssetRoutes(context, unexpectedRequests);
  const browserErrors = monitorBrowserErrors(page);
  const importedH10Text = 'B000000099 AFA12AM 19.25';

  await page.goto('/#data');
  await waitForSupplyApp(page);
  await page.locator('#inputH10').fill(SANITIZED_H10_TEXT);
  await page.locator('#masterFileInput').setInputFiles({
    name:'new-helium10.txt',
    mimeType:'text/plain',
    buffer:Buffer.from(importedH10Text, 'utf8'),
  });
  await expect(page.locator('#inputH10')).toHaveValue(importedH10Text);
  await page.reload();
  await waitForSupplyApp(page);

  await expect(page.locator('#inputH10')).toHaveValue(importedH10Text);
  expect(unexpectedRequests).toEqual([]);
  expect(browserErrors).toEqual([]);
});
