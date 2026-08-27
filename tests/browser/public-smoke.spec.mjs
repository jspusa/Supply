import { expect, test } from '@playwright/test';

import {
  exerciseWorkspaceNavigationAndLayout,
  expectOnlyWorkspace,
  freezeBrowserTime,
  installOfflineAssetRoutes,
  monitorBrowserErrors,
  waitForSupplyApp,
} from './browser-helpers.mjs';

test('public workspace navigation, legacy URL, history, and bounded layout are real-browser safe', async ({ page, context }) => {
  await freezeBrowserTime(page);
  const unexpectedRequests = [];
  await installOfflineAssetRoutes(context, unexpectedRequests);
  const browserErrors = monitorBrowserErrors(page);

  await page.goto('/#today');
  await waitForSupplyApp(page);
  await expect(page).toHaveURL(/#today$/);
  await expect(page.locator('input[type="file"]')).toHaveCount(5);
  for (const input of await page.locator('input[type="file"]').all()) await expect(input).toHaveValue('');
  await expect(page.locator('#todayWorkspaceSummary button')).toHaveCount(1);
  await expect(page.locator('#workflowTop')).toBeHidden();
  await expect(page.locator('#workflowHealth')).toBeHidden();
  await expect(page.locator('.controlDock')).toBeHidden();
  const todayLayout = await page.evaluate(() => ({
    viewportHeight:window.innerHeight,
    pageHeight:document.documentElement.scrollHeight,
  }));
  expect(todayLayout.pageHeight).toBeLessThanOrEqual(todayLayout.viewportHeight + 80);

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
