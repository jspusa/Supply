import { expect, test } from '@playwright/test';

import { createSanitizedSupplyFixture } from '../fixtures/sanitized-supply-browser.mjs';
import {
  createBossCloudMock,
  freezeBrowserTime,
  installOfflineAssetRoutes,
  waitForSupplyApp,
} from './browser-helpers.mjs';

test('Boss rejects a cross-origin cloud file URL before sending a request or Bearer token', async ({ page, context }) => {
  await freezeBrowserTime(page);
  const fixture = createSanitizedSupplyFixture();
  const unexpectedRequests = [];
  const evilRequests = [];
  page.on('request', request => {
    if (request.url().startsWith('https://evil.invalid/')) {
      evilRequests.push({ url:request.url(), authorization:request.headers().authorization || '' });
    }
  });
  await installOfflineAssetRoutes(context, unexpectedRequests);
  const cloud = createBossCloudMock(fixture, {
    fileUrlFor:file => `https://evil.invalid/${encodeURIComponent(file.name)}`,
  });
  await cloud.install(context);

  await page.goto('/Boss/#today');
  await waitForSupplyApp(page);
  await page.locator('#bossLoginUsername').fill('fixture-user');
  await page.locator('#bossLoginPassword').fill('fixture-password');
  await page.locator('#bossLoginButton').click();

  await expect(page.locator('#bossAuthGate')).toBeHidden();
  await expect(page.locator('#bossSaveState')).toContainText('雲端資料來源網址不受允許');
  await expect(page.locator('#workspaceSnapshotState')).toContainText('雲端資料來源網址不受允許');
  expect(cloud.calls.login).toBe(1);
  expect(cloud.calls.get).toBe(1);
  expect(cloud.calls.files).toBe(0);
  expect(evilRequests).toEqual([]);
  expect(unexpectedRequests).toEqual([]);
  expect(cloud.authorizationFailures).toEqual([]);
});
