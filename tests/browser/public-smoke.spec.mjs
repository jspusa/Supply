import { expect, test } from '@playwright/test';

import {
  exerciseWorkspaceNavigationAndLayout,
  expectOnlyWorkspace,
  freezeBrowserTime,
  installOfflineAssetRoutes,
  monitorBrowserErrors,
  waitForSupplyApp,
} from './browser-helpers.mjs';

test('public root defaults to Data with exactly five ordered workspace tabs', async ({ page, context }) => {
  await freezeBrowserTime(page);
  const unexpectedRequests = [];
  await installOfflineAssetRoutes(context, unexpectedRequests);
  const browserErrors = monitorBrowserErrors(page);

  await page.goto('/');
  await waitForSupplyApp(page);
  await expect(page).toHaveURL(/#data$/);
  await expectOnlyWorkspace(page, 'data');
  await expect(page.locator('.workspaceNavTab')).toHaveCount(5);
  await expect(page.locator('.workspaceNavTab')).toHaveText(['資料', '今日建議', '訂單', 'SKU 決策樹', '資料分析']);
  await expect(page.locator('.workspaceNavTab[data-workspace="today"]')).toHaveCount(0);

  expect(unexpectedRequests).toEqual([]);
  expect(browserErrors).toEqual([]);
});

test('public workspace navigation, legacy URL, history, and bounded layout are real-browser safe', async ({ page, context }) => {
  await freezeBrowserTime(page);
  const unexpectedRequests = [];
  await installOfflineAssetRoutes(context, unexpectedRequests);
  const browserErrors = monitorBrowserErrors(page);

  await page.goto('/#today');
  await waitForSupplyApp(page);
  await expect(page).toHaveURL(/#recommendations$/);
  await expect(page.locator('input[type="file"]')).toHaveCount(5);
  for (const input of await page.locator('input[type="file"]').all()) await expect(input).toHaveValue('');
  await expect(page.locator('#todayWorkspaceSummary button')).toHaveCount(1);
  await expect(page.locator('#todayWorkspaceSummary')).toBeVisible();
  await expect(page.locator('#decisionDashboard')).toBeVisible();
  await expect(page.locator('#workflowTop')).toBeHidden();
  await expect(page.locator('#workflowHealth')).toBeHidden();
  await expect(page.locator('.controlDock')).toBeVisible();

  await page.locator('#todayNextAction').focus();
  await page.locator('#todayNextAction').press('Enter');
  await expect(page).toHaveURL(/#data$/);
  await expectOnlyWorkspace(page, 'data');
  await expect(page.locator('.workspaceNavTab[data-workspace="data"]')).toBeFocused();

  await exerciseWorkspaceNavigationAndLayout(page, { expectEmptyToday:true });
  await expect(page.locator('#decisionDashboard')).toBeVisible();

  expect(unexpectedRequests).toEqual([]);
  expect(browserErrors).toEqual([]);
});
