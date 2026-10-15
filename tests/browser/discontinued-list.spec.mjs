import { expect, test } from '@playwright/test';
import { BOSS_FIXTURE_TOKEN } from '../fixtures/sanitized-supply-browser.mjs';
import { createBossCloudMock, freezeBrowserTime, installOfflineAssetRoutes, monitorBrowserErrors, waitForSupplyApp } from './browser-helpers.mjs';

for (const pathname of ['/', '/Boss/']) {
  test(`${pathname} lists discontinued reasons and Chewy exclusions with keyboard dismissal`, async ({ page, context }) => {
    await freezeBrowserTime(page);
    await installOfflineAssetRoutes(context);
    const errors = monitorBrowserErrors(page);
    const boss = pathname === '/Boss/';
    if (boss) {
      const cloud = createBossCloudMock({ cloudFiles:[] });
      await cloud.install(context);
      await page.addInitScript(token => {
        sessionStorage.setItem('supply-boss-session', token);
      }, BOSS_FIXTURE_TOKEN);
    }
    await page.goto(`${pathname}#orders`);
    await waitForSupplyApp(page);
    if (boss) await expect(page.locator('#bossAuthGate')).toBeHidden();
    const trigger = page.getByRole('button', { name:'停產清單', exact:true });
    await expect(trigger).toBeVisible();
    await trigger.click();
    const dialog = page.getByRole('dialog', { name:'停產清單', exact:true });
    const search = dialog.getByRole('searchbox', { name:'搜尋 SKU／原因' });
    const filter = dialog.getByLabel('分類', { exact:true });
    await expect(dialog).toBeVisible();
    await expect(search).toBeFocused();
    await expect(dialog.locator('tbody tr')).toHaveCount(92);
    await expect(dialog.locator('[data-discontinued-sku="AFA135AM"]')).toContainText('做工難＋留長版');
    await expect(dialog.locator('[data-discontinued-sku="GCTL06"]')).toHaveCount(1);
    await search.fill('vtr01-4');
    await expect(dialog.locator('tbody tr')).toHaveCount(1);
    await expect(dialog.locator('tbody')).toContainText('委外不便＋自我競爭');
    await search.fill('留2LB');
    await expect(dialog.locator('tbody')).toContainText('1GQRD017A0');
    await search.fill('');
    await filter.selectOption('chewy');
    await expect(dialog.locator('tbody tr')).toHaveCount(12);
    await expect(dialog.locator('tbody')).toContainText('7ATRD013AB');
    await expect(dialog.locator('tbody')).toContainText('ATR01');
    await expect(dialog.locator('tbody tr').first()).toContainText('Chewy 專售');
    await filter.selectOption('special');
    await expect(dialog.locator('tbody tr')).toHaveCount(6);
    await expect(dialog.locator('tbody')).toContainText('AFML01');
    await expect(dialog.locator('tbody')).toContainText('1GXXD002A0');
    await expect(dialog.locator('tbody')).toContainText('可手動下單');
    await search.fill('UNKNOWN-SKU');
    await expect(dialog.locator('.discontinued-list-empty')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).not.toBeVisible();
    await expect(trigger).toBeFocused();
    for (const width of [1280, 1024, 390, 320]) {
      await page.setViewportSize({ width, height:844 });
      await trigger.click();
      await expect(trigger).toBeVisible();
      await expect(dialog).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      expect(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      await dialog.getByRole('button', { name:'關閉停產清單' }).click();
      await expect(trigger).toBeFocused();
    }
    expect(errors).toEqual([]);
  });
}
