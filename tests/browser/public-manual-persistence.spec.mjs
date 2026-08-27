import { expect, test } from '@playwright/test';

import { SANITIZED_H10_TEXT } from '../fixtures/sanitized-supply-browser.mjs';
import {
  freezeBrowserTime,
  installOfflineAssetRoutes,
  monitorBrowserErrors,
  readWorkspaceSnapshot,
  waitForSupplyApp,
} from './browser-helpers.mjs';

async function waitForSnapshot(page, predicate) {
  await expect.poll(async () => {
    const snapshot = await readWorkspaceSnapshot(page);
    return snapshot && predicate(snapshot) ? snapshot : null;
  }, { timeout:8_000 }).not.toBeNull();
}

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
