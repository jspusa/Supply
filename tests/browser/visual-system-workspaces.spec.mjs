import { expect, test } from '@playwright/test';

import {
  expectOnlyWorkspace,
  freezeBrowserTime,
  installOfflineAssetRoutes,
  waitForSupplyApp,
} from './browser-helpers.mjs';

const WORKSPACES = [
  ['data', '#uploadCard'],
  ['recommendations', '#decisionDashboard'],
  ['orders', '#generatorCard'],
  ['sku-tree', '#skuDecisionTreeCard'],
  ['analysis', '#mainCard'],
];

async function openSupply(page, path) {
  await page.goto(path);
  await waitForSupplyApp(page);
}

async function addVisualOrderRow(page) {
  await page.locator('.workspaceNavTab[data-workspace="orders"]').click();
  await expectOnlyWorkspace(page, 'orders');
  await page.locator('#searchInput').fill('GTSL01');
  const result = page.locator('#searchResults .search-result-item').filter({ hasText:'GTSL01' }).first();
  await expect(result).toBeVisible();
  await result.click();
  await expect(page.locator('#productTable tbody tr[data-product="GTSL01"]')).toBeVisible();
}

test('1440 desktop applies white-card production components to every workspace', async ({ page, context }) => {
  await page.setViewportSize({ width:1440, height:900 });
  await freezeBrowserTime(page);
  const unexpectedRequests = [];
  await installOfflineAssetRoutes(context, unexpectedRequests);
  await openSupply(page, '/#data');

  const hero = await page.locator('.appHero').evaluate(element => {
    const style = getComputedStyle(element);
    return { background:style.backgroundColor, image:style.backgroundImage, radius:Number.parseFloat(style.borderRadius) };
  });
  expect(hero).toEqual({ background:'rgb(255, 255, 255)', image:'none', radius:28 });

  for (const [workspace, selector] of WORKSPACES) {
    await page.locator(`.workspaceNavTab[data-workspace="${workspace}"]`).click();
    await expectOnlyWorkspace(page, workspace);
    const surface = page.locator(selector);
    await expect(surface).toBeVisible();
    const style = await surface.evaluate(element => {
      const computed = getComputedStyle(element);
      return { background:computed.backgroundColor, radius:Number.parseFloat(computed.borderRadius) };
    });
    expect(style.background).toBe('rgb(255, 255, 255)');
    expect(style.radius).toBeGreaterThanOrEqual(20);
  }

  await addVisualOrderRow(page);
  const pallet = page.locator('#productTable tbody tr[data-product="GTSL01"] .edit-pallets-input');
  await expect(pallet).toHaveAttribute('step', '0.5');
  await expect(pallet).not.toHaveAttribute('onkeydown', /.+/);
  await expect(page.locator('#productTable .palletStepButton')).toHaveCount(0);
  await pallet.fill('0.5');
  await pallet.focus();
  await pallet.press('ArrowUp');
  await expect(pallet).toHaveValue('1');

  const coverage = await page.evaluate(() => {
    const host = document.createElement('div');
    host.id = 'coverageVisualProbe';
    host.innerHTML = [179, 180, 366].map(days => window.SupplyCoverageIndicator.renderCoverageMeter({ coverageDays:days })).join('');
    document.body.append(host);
    return Array.from(host.querySelectorAll('.coverageMeter')).map(meter => ({
      band:meter.dataset.band,
      accent:getComputedStyle(meter).getPropertyValue('--coverage-accent-rgb').trim(),
      fill:getComputedStyle(meter.querySelector('.coverageMeter__fill')).backgroundImage,
    }));
  });
  expect(coverage.map(item => [item.band, item.accent])).toEqual([
    ['low', '255, 204, 0'],
    ['healthy', '0, 190, 75'],
    ['excess', '255, 45, 45'],
  ]);
  for (const item of coverage) expect(item.fill).toContain('0.68');

  await expect(page.locator('#productTable th')).toHaveCount(11);
  expect(await page.locator('.order-generator .table-responsive').evaluate(element => getComputedStyle(element).overflowX)).toBe('auto');
  const frozenHeader = await page.locator('.order-generator .table-responsive').evaluate(async element => {
    const table = element.querySelector('table');
    const tbody = table.querySelector('tbody');
    const header = table.querySelector('thead th');
    element.style.maxHeight = '150px';
    for (let index = 0; index < 18; index += 1) {
      const row = document.createElement('tr');
      row.innerHTML = '<td>&nbsp;</td>'.repeat(11);
      tbody.append(row);
    }
    const before = header.getBoundingClientRect().top;
    element.scrollTop = 120;
    await new Promise(resolve => requestAnimationFrame(resolve));
    const style = getComputedStyle(header);
    return {
      before,
      after:header.getBoundingClientRect().top,
      position:style.position,
      top:style.top,
      scrollTop:element.scrollTop,
      tableOverflow:getComputedStyle(table).overflow,
    };
  });
  expect(frozenHeader.position).toBe('sticky');
  expect(frozenHeader.top).toBe('0px');
  expect(frozenHeader.scrollTop).toBeGreaterThan(0);
  expect(frozenHeader.after).toBeCloseTo(frozenHeader.before, 0);
  expect(frozenHeader.tableOverflow).toBe('visible');
  expect(unexpectedRequests).toEqual([]);
});

test('390 mobile keeps all five workspaces and dense tables horizontally accessible', async ({ page, context }) => {
  await page.setViewportSize({ width:390, height:844 });
  await page.emulateMedia({ reducedMotion:'reduce' });
  await freezeBrowserTime(page);
  const unexpectedRequests = [];
  await installOfflineAssetRoutes(context, unexpectedRequests);
  await openSupply(page, '/#data');

  for (const [workspace, selector] of WORKSPACES) {
    await page.locator(`.workspaceNavTab[data-workspace="${workspace}"]`).click();
    await expectOnlyWorkspace(page, workspace);
    await expect(page.locator(selector)).toBeVisible();
    const widths = await page.evaluate(() => ({ viewport:document.documentElement.clientWidth, page:document.documentElement.scrollWidth }));
    expect(widths).toEqual({ viewport:390, page:390 });
  }

  await page.locator('.workspaceNavTab[data-workspace="orders"]').click();
  await expectOnlyWorkspace(page, 'orders');
  const tableAccess = await page.locator('.order-generator .table-responsive').evaluate(element => {
    const before = element.scrollLeft;
    element.scrollLeft = 320;
    return {
      clientWidth:element.clientWidth,
      scrollWidth:element.scrollWidth,
      before,
      after:element.scrollLeft,
    };
  });
  expect(tableAccess.scrollWidth).toBeGreaterThan(tableAccess.clientWidth);
  expect(tableAccess.after).toBeGreaterThan(tableAccess.before);
  const tab = page.locator('.workspaceNavTab[data-workspace="recommendations"]');
  await page.keyboard.press('ArrowLeft');
  await expect(tab).toBeFocused();
  const focus = await tab.evaluate(element => {
    const style = getComputedStyle(element);
    return {
      outline:style.outlineStyle,
      width:Number.parseFloat(style.outlineWidth),
      transition:Math.max(...style.transitionDuration.split(',').map(value => Number.parseFloat(value) || 0)),
    };
  });
  expect(focus.outline).toBe('solid');
  expect(focus.width).toBeGreaterThanOrEqual(3);
  expect(focus.transition).toBeLessThanOrEqual(.001);
  expect(unexpectedRequests).toEqual([]);
});

test('Boss authentication boundary uses the same normal-light production system at desktop and mobile', async ({ page, context }) => {
  const unexpectedRequests = [];
  await installOfflineAssetRoutes(context, unexpectedRequests);
  for (const viewport of [{ width:1440, height:900 }, { width:390, height:844 }]) {
    await page.setViewportSize(viewport);
    await page.goto('/Boss/#data');
    await waitForSupplyApp(page);
    const gate = page.locator('#bossAuthGate');
    await expect(gate).toBeVisible();
    const visual = await page.locator('.bossAuthCard').evaluate(element => {
      const style = getComputedStyle(element);
      return {
        background:style.backgroundColor,
        radius:Number.parseFloat(style.borderRadius),
        bodyBackground:getComputedStyle(document.body).backgroundColor,
        viewport:document.documentElement.clientWidth,
        page:document.documentElement.scrollWidth,
        night:document.body.classList.contains('fba-night'),
        door:Boolean(document.querySelector('.fba-door-transition')),
      };
    });
    expect(visual.background).toMatch(/^rgba?\(255, 255, 255/);
    expect(visual.radius).toBeGreaterThanOrEqual(24);
    expect(visual.bodyBackground).toBe('rgb(245, 245, 247)');
    expect(visual.page).toBe(visual.viewport);
    expect(visual.night).toBe(false);
    expect(visual.door).toBe(false);
  }
  expect(unexpectedRequests).toEqual([]);
});
