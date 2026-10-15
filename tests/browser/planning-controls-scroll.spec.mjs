import { expect, test } from '@playwright/test';
import { BOSS_FIXTURE_TOKEN } from '../fixtures/sanitized-supply-browser.mjs';
import {
  createBossCloudMock,
  expectOnlyWorkspace,
  freezeBrowserTime,
  installOfflineAssetRoutes,
  waitForSupplyApp,
} from './browser-helpers.mjs';

for (const pathname of ['/', '/Boss/']) {
  for (const viewport of [{ width:1280, height:900 }, { width:390, height:844 }]) {
    test(`${pathname} ${viewport.width}px planning controls scroll away while workspace navigation remains available`, async ({ page, context }) => {
      await page.setViewportSize(viewport);
      await page.emulateMedia({ reducedMotion:'reduce' });
      await freezeBrowserTime(page);
      const unexpectedRequests = [];
      await installOfflineAssetRoutes(context, unexpectedRequests);
      if (pathname === '/Boss/') {
        await createBossCloudMock({ cloudFiles:[] }).install(context);
        await page.addInitScript(token => sessionStorage.setItem('supply-boss-session', token), BOSS_FIXTURE_TOKEN);
      }
      await page.goto(`${pathname}#orders`);
      await waitForSupplyApp(page);
      if (pathname === '/Boss/') {
        await expect(page.locator('#bossAuthGate')).toBeHidden();
        await expect(page.locator('#bossLoadingMask')).toBeHidden();
      }

      // Keep enough content below the empty workspace to exercise document scrolling.
      await page.locator('.page').evaluate(element => { element.style.minHeight = '4000px'; });
      const controls = page.locator('#controlDock');
      const header = page.locator('.app-header');
      for (const workspace of ['orders', 'recommendations']) {
        await page.locator(`.workspaceNavTab[data-workspace="${workspace}"]`).click();
        await expectOnlyWorkspace(page, workspace);
        await page.evaluate(() => window.scrollTo(0, 0));
        await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
        await expect(controls).toBeVisible();
        const before = await controls.boundingBox();
        const headerBefore = await header.boundingBox();
        const scrollTarget = Math.ceil(before.y + before.height + 100);
        await page.evaluate(top => window.scrollTo(0, top), scrollTarget);
        await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(scrollTarget);
        const after = await controls.boundingBox();
        const headerAfter = await header.boundingBox();

        expect(after.y).toBeCloseTo(before.y - scrollTarget, 0);
        expect(after.y + after.height).toBeLessThan(0);
        expect(headerAfter.y).toBeCloseTo(headerBefore.y, 0);
        await expect(page.locator(`.workspaceNavTab[data-workspace="${workspace}"]`)).toBeInViewport();

        await page.evaluate(() => window.scrollTo(0, 0));
        await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
        expect((await controls.boundingBox()).y).toBeCloseTo(before.y, 0);
      }
      expect(unexpectedRequests).toEqual([]);
    });
  }
}
