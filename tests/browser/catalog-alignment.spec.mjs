import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';

import {
  freezeBrowserTime,
  installOfflineAssetRoutes,
  monitorBrowserErrors,
  waitForSupplyApp,
} from './browser-helpers.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const currentSupply = JSON.parse(fs.readFileSync(path.join(repoRoot, 'catalog-alignment.json'), 'utf8'));
const currentFba = {
  ...currentSupply,
  site:'fba',
  publicContentHash:currentSupply.expectedPublicContentHashes.fba,
};
const staleFba = {
  schemaVersion:1,
  catalogVersion:'2026-08-28.3',
  site:'fba',
  publicContentHash:'3'.repeat(64),
  expectedPublicContentHashes:{ supply:'2'.repeat(64), fba:'3'.repeat(64) },
};

test('partial deployment stays red across refresh and clears only after the peer compact manifest aligns', async ({ page, context }) => {
  await freezeBrowserTime(page);
  const browserErrors = monitorBrowserErrors(page);
  const unexpectedRequests = [];
  let peerMode = 'stale';

  await installOfflineAssetRoutes(context, unexpectedRequests);
  await context.route('**/catalog-alignment.json', async route => {
    const pathname = new URL(route.request().url()).pathname;
    const isPeer = pathname.includes('/FBA/');
    if (!isPeer) {
      await route.fulfill({ status:200, contentType:'application/json', body:JSON.stringify(currentSupply) });
      return;
    }
    if (peerMode === 'unavailable') {
      await route.fulfill({ status:200, contentType:'application/json', body:'{}' });
      return;
    }
    await route.fulfill({
      status:200,
      contentType:'application/json',
      body:JSON.stringify(peerMode === 'aligned' ? currentFba : staleFba),
    });
  });
  await page.goto('/');
  await waitForSupplyApp(page);
  const status = page.locator('#catalogAlignmentStatus');
  await expect(status).toHaveAttribute('data-state', 'failed');
  await expect(status.locator('.catalog-alignment-toggle')).toContainText('產品資料未對齊');
  await expect(status).toHaveAttribute('data-retry-sites', 'fba');
  const storedFailure = await page.evaluate(() => JSON.parse(localStorage.getItem('jspusa:catalog-alignment-status:supply:v1')));
  expect(storedFailure.state).toBe('failed');
  expect(JSON.stringify(storedFailure)).not.toMatch(/products|publicContentHash|expectedPublicContentHashes/);

  await page.evaluate(() => {
    window.__catalogRecovery = null;
    window.addEventListener('jsp:catalog-alignment-recovery-request', event => {
      window.__catalogRecovery = event.detail;
    }, { once:true });
  });
  await status.locator('.catalog-alignment-toggle').click();
  await status.locator('.catalog-alignment-recovery').click();
  expect(await page.evaluate(() => window.__catalogRecovery)).toEqual({
    catalogVersion:currentSupply.catalogVersion,
    retrySites:['fba'],
    mode:'local-release-workflow',
  });

  peerMode = 'unavailable';
  await page.reload();
  await waitForSupplyApp(page);
  await expect(status).toHaveAttribute('data-state', 'failed');
  await expect.poll(() => page.evaluate(() => window.JSPCatalogAlignmentRuntime?.controller?.getLastStatus()?.stale)).toBe(true);

  peerMode = 'aligned';
  await page.reload();
  await waitForSupplyApp(page);
  await expect(status).toHaveAttribute('data-state', 'aligned');
  await expect(status.locator('.catalog-alignment-toggle')).toContainText('產品資料已對齊');
  expect((await page.evaluate(() => JSON.parse(localStorage.getItem('jspusa:catalog-alignment-status:supply:v1')))).state).toBe('aligned');

  expect(unexpectedRequests).toEqual([]);
  expect(browserErrors).toEqual([]);
});
