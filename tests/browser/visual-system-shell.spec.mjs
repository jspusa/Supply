import { expect, test } from '@playwright/test';

import {
  expectOnlyWorkspace,
  freezeBrowserTime,
  installOfflineAssetRoutes,
  waitForSupplyApp,
} from './browser-helpers.mjs';

test('desktop Supply uses the FBA Jasper shell without reloading workspace state', async ({ page, context }) => {
  await page.setViewportSize({ width:1440, height:900 });
  await freezeBrowserTime(page);
  const unexpectedRequests = [];
  await installOfflineAssetRoutes(context, unexpectedRequests);
  await page.goto('/#data');
  await waitForSupplyApp(page);

  const header = page.locator('.app-header');
  await expect(header).toBeVisible();
  await expect(header.locator('.brand-copy strong')).toHaveText('補貨工作台');
  await expect(header.locator('.brand-copy span')).toHaveText('Jasper Pet Care Products, Inc.');
  await expect(header.locator('.workspaceNavTab')).toHaveCount(5);
  const shell = await page.evaluate(() => {
    const body = getComputedStyle(document.body);
    const header = getComputedStyle(document.querySelector('.app-header'));
    return {
      background:body.backgroundColor,
      font:body.fontFamily,
      position:header.position,
      version:getComputedStyle(document.documentElement).getPropertyValue('--fba-vs-version').trim(),
      viewportWidth:document.documentElement.clientWidth,
      pageWidth:document.documentElement.scrollWidth,
      hasNight:document.body.classList.contains('fba-night'),
      hasDoor:Boolean(document.querySelector('.fba-door-transition')),
    };
  });
  expect(shell).toMatchObject({
    background:'rgb(245, 245, 247)',
    position:'sticky',
    version:'"1.0.0"',
    viewportWidth:1440,
    pageWidth:1440,
    hasNight:false,
    hasDoor:false,
  });
  expect(shell.font).toContain('-apple-system');

  const h10 = page.locator('#inputH10');
  await h10.fill('GTSL01 30 120');
  const documentToken = await page.evaluate(() => {
    window.__visualContractDocumentToken = crypto.randomUUID();
    return window.__visualContractDocumentToken;
  });
  for (const workspace of ['recommendations', 'orders', 'sku-tree', 'analysis', 'data']) {
    await page.locator(`.workspaceNavTab[data-workspace="${workspace}"]`).click();
    await expectOnlyWorkspace(page, workspace);
  }
  await expect(h10).toHaveValue('GTSL01 30 120');
  expect(await page.evaluate(() => window.__visualContractDocumentToken)).toBe(documentToken);
  expect(unexpectedRequests).toEqual([]);
});

test('390-pixel shell keeps all five workspaces reachable with visible focus and reduced motion', async ({ page, context }) => {
  await page.setViewportSize({ width:390, height:844 });
  await page.emulateMedia({ reducedMotion:'reduce' });
  await freezeBrowserTime(page);
  const unexpectedRequests = [];
  await installOfflineAssetRoutes(context, unexpectedRequests);
  await page.goto('/#recommendations');
  await waitForSupplyApp(page);

  const tabs = page.locator('.workspaceNavTab');
  await expect(tabs).toHaveCount(5);
  await expect(page.locator('.brand-copy span')).toBeHidden();
  await page.locator('.workspaceNavTab[data-workspace="recommendations"]').focus();
  const focus = await page.locator('.workspaceNavTab[data-workspace="recommendations"]').evaluate(element => {
    const style = getComputedStyle(element);
    return {
      focusVisible:element.matches(':focus-visible'),
      outlineStyle:style.outlineStyle,
      outlineWidth:Number.parseFloat(style.outlineWidth),
      transitionDuration:Math.max(...style.transitionDuration.split(',').map(value => Number.parseFloat(value) || 0)),
      mediaMatches:matchMedia('(prefers-reduced-motion: reduce)').matches,
      viewportWidth:document.documentElement.clientWidth,
      pageWidth:document.documentElement.scrollWidth,
    };
  });
  expect(focus).toMatchObject({
    focusVisible:true,
    outlineStyle:'solid',
    outlineWidth:3,
    mediaMatches:true,
    viewportWidth:390,
    pageWidth:390,
  });
  expect(focus.transitionDuration).toBeLessThanOrEqual(0.001);

  await page.keyboard.press('End');
  await expect(page.locator('.workspaceNavTab[data-workspace="analysis"]')).toBeFocused();
  await expectOnlyWorkspace(page, 'analysis');
  expect(unexpectedRequests).toEqual([]);
});
