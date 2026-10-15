import { expect, test } from '@playwright/test';
import { BOSS_FIXTURE_TOKEN } from '../fixtures/sanitized-supply-browser.mjs';
import { createBossCloudMock, freezeBrowserTime, installOfflineAssetRoutes, monitorBrowserErrors, waitForSupplyApp } from './browser-helpers.mjs';

const requestedPairs = [
  ['GTS01', '7GTSD013AB'], ['GTSL01', '7GTSD017AB'],
  ['GTB01', '7GTBD013AB'], ['GTBL01', '7GTBD017AB'], ['GTBL03', '7GTBD037AB'],
  ['GTB05', '7GTBD053AB'], ['GTBL05', '7GTBD057AB'],
  ['GTR01', '7GTRD013AB'], ['GTRL01', '7GTRD017AB'], ['GTRL03', '7GTRD037AB'],
  ['GTP01', '7GTPD013AB'], ['GTPL01', '7GTPD017AB'], ['GTPL03', '7GTPD037AB'],
  ['GTP05', '7GTPD053AB'], ['GTPL05', '7GTPD057AB'],
  ['TTS05AM-1', '7ATSD010AB'], ['TTSL05', '7ATSD017AB'], ['TTS05AM', '7ATSD019AB'],
  ['ATS01', '7ATSD011AB'], ['ATR01', '7ATRD013AB'],
  ['VTS01-5', '7VTSD513AB'], ['VTS01-10', '7VTSD913AB'],
  ['VTB01-4', '7VTBD410AB'], ['VTB01-10', '7VTBD015AB'],
  ['VTR01-10', '7VTRD015AB'], ['VTR01-20', '7VTRD215AB'],
];

for (const pathname of ['/', '/Boss/']) {
  test(`${pathname} shows all requested SKU pairs, searchable from either side and accessible on mobile`, async ({ page, context }) => {
    await freezeBrowserTime(page);
    await installOfflineAssetRoutes(context);
    const errors = monitorBrowserErrors(page);
    if (pathname === '/Boss/') {
      const cloud = createBossCloudMock({ cloudFiles:[] });
      await cloud.install(context);
      await page.addInitScript(token => sessionStorage.setItem('supply-boss-session', token), BOSS_FIXTURE_TOKEN);
    }
    await page.goto(`${pathname}#orders`);
    await waitForSupplyApp(page);
    if (pathname === '/Boss/') {
      await expect(page.locator('#bossAuthGate')).toBeHidden();
      await expect(page.locator('#bossLoadingMask')).toBeHidden();
    }
    const trigger = page.locator('#skuAliasListButton');
    await expect(trigger).toBeVisible();
    await trigger.click();
    const dialog = page.locator('#skuAliasListDialog');
    const search = page.locator('#skuAliasListSearch');
    await expect(dialog).toBeVisible();
    await expect(search).toBeFocused();
    await expect(dialog).toContainText('訂單會合併計算');
    await expect(dialog.locator('tbody tr')).toHaveCount(26);
    for (const [productSku, orderSku] of requestedPairs) {
      await expect(dialog.locator(`tbody tr[data-product-sku="${productSku}"][data-order-sku="${orderSku}"]`)).toHaveCount(1);
    }
    await search.fill('gtp01');
    await expect(dialog.locator('tbody tr')).toHaveCount(1);
    await expect(dialog.locator('tbody')).toContainText('7GTPD013AB');
    await search.fill('7gtpd013ab');
    await expect(dialog.locator('tbody tr')).toHaveCount(1);
    await expect(dialog.locator('tbody')).toContainText('GTP01');
    await search.fill('UNKNOWN-SKU');
    await expect(dialog.locator('.discontinued-list-empty')).toBeVisible();
    await search.fill('');
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(trigger).toBeFocused();
    for (const width of [1280, 1024, 390, 320]) {
      await page.setViewportSize({ width, height:844 });
      await trigger.click();
      await expect(dialog).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      await dialog.getByRole('button', { name:'關閉 SKU 對照表' }).click();
      await expect(trigger).toBeFocused();
      const buttons = await page.locator('.workspace-header-actions button').evaluateAll(nodes => nodes.filter(node => node.getBoundingClientRect().width).map(node => {
        const { left, right, top, bottom } = node.getBoundingClientRect();
        return { left, right, top, bottom };
      }));
      for (let i = 0; i < buttons.length; i += 1) {
        for (let j = i + 1; j < buttons.length; j += 1) {
          const a = buttons[i], b = buttons[j];
          expect(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top).toBe(true);
        }
      }
    }
    expect(errors).toEqual([]);
  });
}
