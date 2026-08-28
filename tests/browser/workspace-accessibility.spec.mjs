import { expect, test } from '@playwright/test';

import {
  expectOnlyWorkspace,
  freezeBrowserTime,
  installOfflineAssetRoutes,
  readOrderDraft,
  waitForSupplyApp,
} from './browser-helpers.mjs';

const NOW = '2026-08-28T08:30:00.000Z';
const KEYBOARD_DRAFT = {
  schemaVersion:2,
  createdAt:NOW,
  updatedAt:NOW,
  rowsByProductSku:{
    GTSL01:{
      productSku:'GTSL01', orderSku:'GTSL01', standardFactory:'vietnam', orderGroup:'vietnam',
      quantities:{ packages:336, cartons:14, orderDraft:336 },
      pallet:{ value:1 / 3, mode:'manual', authoritativeField:'pallets' },
      locked:false, createdAt:NOW, updatedAt:NOW, issues:[],
    },
  },
  groupOrder:{ taiwan:[], vietnam:['GTSL01'], subcontract:[] },
  repairOrder:[],
  issues:[],
};

async function expectKeyboardFocusRing(locator) {
  const focus = await locator.evaluate(element => {
    const style = getComputedStyle(element);
    return {
      focused:document.activeElement === element,
      focusVisible:element.matches(':focus-visible'),
      outlineStyle:style.outlineStyle,
      outlineWidth:style.outlineWidth,
    };
  });
  expect(focus.focused).toBe(true);
  expect(focus.focusVisible).toBe(true);
  expect(focus.outlineStyle).toBe('solid');
  expect(Number.parseFloat(focus.outlineWidth)).toBeGreaterThanOrEqual(3);
}

test('keyboard alone reaches and operates five-workspace navigation and the Today action', async ({ page, context }) => {
  await freezeBrowserTime(page);
  const unexpectedRequests = [];
  await installOfflineAssetRoutes(context, unexpectedRequests);
  await page.goto('/#today');
  await waitForSupplyApp(page);

  await page.keyboard.press('Tab');
  const recommendationsTab = page.locator('.workspaceNavTab[data-workspace="recommendations"]');
  await expect(recommendationsTab).toBeFocused();
  await expectKeyboardFocusRing(recommendationsTab);

  await page.keyboard.press('ArrowLeft');
  const dataTab = page.locator('.workspaceNavTab[data-workspace="data"]');
  await expect(dataTab).toBeFocused();
  await expectOnlyWorkspace(page, 'data');
  await expectKeyboardFocusRing(dataTab);

  await page.keyboard.press('ArrowRight');
  await expect(recommendationsTab).toBeFocused();
  await expectOnlyWorkspace(page, 'recommendations');

  await page.keyboard.press('End');
  await expect(page.locator('.workspaceNavTab[data-workspace="analysis"]')).toBeFocused();
  await expectOnlyWorkspace(page, 'analysis');
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.workspaceNavTab[data-workspace="sku-tree"]')).toBeFocused();
  await expectOnlyWorkspace(page, 'sku-tree');
  await page.keyboard.press('Home');
  await expect(dataTab).toBeFocused();
  await expectOnlyWorkspace(page, 'data');

  await page.keyboard.press('ArrowRight');
  await expect(recommendationsTab).toBeFocused();
  await page.keyboard.press('Tab');
  const productUpdate = page.locator('.product-update-trigger');
  await expect(productUpdate).toBeFocused();
  await expectKeyboardFocusRing(productUpdate);
  await page.keyboard.press('Tab');
  const alignmentStatus = page.locator('.catalog-alignment-toggle');
  await expect(alignmentStatus).toBeFocused();
  await expectKeyboardFocusRing(alignmentStatus);
  await page.keyboard.press('Tab');
  const todayAction = page.locator('#todayNextAction');
  await expect(todayAction).toBeFocused();
  await expectKeyboardFocusRing(todayAction);
  await page.keyboard.press('Enter');
  await expect(dataTab).toBeFocused();
  await expectOnlyWorkspace(page, 'data');

  await page.keyboard.press('ArrowRight');
  await expect(recommendationsTab).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(productUpdate).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(alignmentStatus).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(todayAction).toBeFocused();
  await page.keyboard.press('Space');
  await expect(dataTab).toBeFocused();
  await expectOnlyWorkspace(page, 'data');

  expect(unexpectedRequests).toEqual([]);
});

test('keyboard alone operates Order groups and exact pallet stepping', async ({ page, context }) => {
  await freezeBrowserTime(page);
  const unexpectedRequests = [];
  await installOfflineAssetRoutes(context, unexpectedRequests);

  await page.addInitScript(draft => {
    localStorage.setItem('supply-order-draft-v2', JSON.stringify(draft));
  }, KEYBOARD_DRAFT);
  await page.goto('/#orders');
  await waitForSupplyApp(page);
  const pallet = page.locator('#productTable tbody tr[data-product="GTSL01"] .edit-pallets-input');
  await expect(pallet).toHaveValue('0.33');
  await expect.poll(async () => (await readOrderDraft(page)).rowsByProductSku.GTSL01.quantities.orderDraft).toBe(336);

  const vietnam = page.locator('input[name="orderGroupSelect"][value="vietnam"]');
  await vietnam.focus();
  await expect(vietnam).toBeFocused();
  const groupFocus = await vietnam.evaluate(element => {
    const style = getComputedStyle(element.nextElementSibling);
    return {
      focusVisible:element.matches(':focus-visible'),
      outlineStyle:style.outlineStyle,
      outlineWidth:style.outlineWidth,
    };
  });
  expect(groupFocus).toEqual({ focusVisible:true, outlineStyle:'solid', outlineWidth:'3px' });
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('input[name="orderGroupSelect"][value="taiwan"]')).toBeChecked();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('input[name="orderGroupSelect"][value="subcontract"]')).toBeChecked();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('input[name="orderGroupSelect"][value="taiwan"]')).toBeChecked();
  await page.keyboard.press('ArrowLeft');
  await expect(vietnam).toBeChecked();

  await pallet.fill('0.5');
  await pallet.focus();
  await expect(pallet).toBeFocused();
  await expect(pallet).toHaveValue('0.5');
  await page.keyboard.press('ArrowUp');
  await expect(pallet).toHaveValue('1');
  await expect.poll(async () => (await readOrderDraft(page)).rowsByProductSku.GTSL01.quantities.orderDraft).toBe(900);
  await page.keyboard.press('ArrowDown');
  await expect(pallet).toHaveValue('0.5');
  await expect.poll(async () => {
    const row = (await readOrderDraft(page)).rowsByProductSku.GTSL01;
    return { quantity:row.quantities.orderDraft, mode:row.pallet.mode, authoritativeField:row.pallet.authoritativeField };
  }).toEqual({ quantity:450, mode:'manual', authoritativeField:'pallets' });

  expect(unexpectedRequests).toEqual([]);
});

test('reduced-motion preference disables smooth scrolling and collapses animation timing', async ({ page, context }) => {
  await freezeBrowserTime(page);
  const unexpectedRequests = [];
  await installOfflineAssetRoutes(context, unexpectedRequests);
  await page.emulateMedia({ reducedMotion:'reduce' });
  await page.addInitScript(() => {
    window.__workspaceScrollBehaviors = [];
    Element.prototype.scrollIntoView = function scrollIntoView(options) {
      window.__workspaceScrollBehaviors.push(options?.behavior || 'auto');
    };
  });
  await page.goto('/#today');
  await waitForSupplyApp(page);

  const reducedStyles = await page.evaluate(() => {
    const tabStyle = getComputedStyle(document.querySelector('.workspaceNavTab'));
    return {
      mediaMatches:matchMedia('(prefers-reduced-motion: reduce)').matches,
      scrollBehavior:getComputedStyle(document.documentElement).scrollBehavior,
      transitionDurations:tabStyle.transitionDuration.split(',').map(value => Number.parseFloat(value) || 0),
      animationDurations:tabStyle.animationDuration.split(',').map(value => Number.parseFloat(value) || 0),
    };
  });
  expect(reducedStyles.mediaMatches).toBe(true);
  expect(reducedStyles.scrollBehavior).toBe('auto');
  expect(Math.max(...reducedStyles.transitionDurations)).toBeLessThanOrEqual(0.001);
  expect(Math.max(...reducedStyles.animationDurations)).toBeLessThanOrEqual(0.001);

  await page.locator('.workspaceNavTab[data-workspace="data"]').click();
  await expectOnlyWorkspace(page, 'data');
  expect(await page.evaluate(() => window.__workspaceScrollBehaviors)).toEqual(['auto']);
  expect(unexpectedRequests).toEqual([]);
});
