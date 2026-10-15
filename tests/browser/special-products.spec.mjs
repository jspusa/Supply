import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import XLSX from 'xlsx';
import { BOSS_FIXTURE_TOKEN } from '../fixtures/sanitized-supply-browser.mjs';
import { createBossCloudMock, freezeBrowserTime, installOfflineAssetRoutes, monitorBrowserErrors, readOrderDraft, waitForSupplyApp } from './browser-helpers.mjs';

XLSX.set_fs(fs);

const SPECIAL_SKUS = ['AFML01', 'AFML03', 'AFML05', '1GXXD002A0', '1AXXD001A0', '1GXXD001A0'];
const DISCONTINUED_SKUS = ['TRPL03', 'TRPL05', 'GSCL03'];

async function start(page, context, pathname) {
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
  return errors;
}

for (const pathname of ['/', '/Boss/']) {
  test(`${pathname} special products can be manually ordered, restored and exported while discontinued products are rejected`, async ({ page, context }) => {
    const errors = await start(page, context, pathname);
    await page.locator('#generatorBulkDetails > summary').click();
    await page.locator('#generatorBulkInput').fill(['SKU\t數量', ...SPECIAL_SKUS.map(sku => `${sku}\t120`), ...DISCONTINUED_SKUS.map(sku => `${sku}\t120`)].join('\n'));
    await page.locator('#btnAddGeneratorBulk').click();
    await expect(page.locator('#generatorBulkStatus')).toContainText('已加入 6 個品項');
    for (const sku of DISCONTINUED_SKUS) await expect(page.locator('#generatorBulkStatus')).toContainText(sku);
    const added = await readOrderDraft(page);
    expect(Object.keys(added.rowsByProductSku).sort()).toEqual([...SPECIAL_SKUS].sort());
    for (const sku of SPECIAL_SKUS) expect(added.rowsByProductSku[sku].quantities.packages).toBe(120);
    await page.reload();
    await waitForSupplyApp(page);
    if (pathname === '/Boss/') {
      await expect(page.locator('#bossAuthGate')).toBeHidden();
      await expect(page.locator('#bossLoadingMask')).toBeHidden();
    }
    const restored = await readOrderDraft(page);
    expect(Object.keys(restored.rowsByProductSku).sort()).toEqual([...SPECIAL_SKUS].sort());
    for (const sku of SPECIAL_SKUS) expect(restored.rowsByProductSku[sku].quantities.packages).toBe(120);
    await page.locator('.workspaceNavTab[data-workspace="orders"]').click();
    const downloadPromise = page.waitForEvent('download', { timeout:8_000 });
    await page.getByRole('button', { name:'匯出訂單 Excel', exact:true }).click();
    const download = await downloadPromise;
    const workbook = XLSX.readFile(await download.path(), { raw:true });
    const exportedSkus = workbook.SheetNames.flatMap(name => XLSX.utils.sheet_to_json(workbook.Sheets[name], { header:1, raw:true, defval:'' }).slice(1).map(row => row[1]));
    expect(exportedSkus.sort()).toEqual([...SPECIAL_SKUS].sort());
    expect(errors).toEqual([]);
  });

  test(`${pathname} stockouts never automatically recommend special products even when the discontinued filter is off`, async ({ page, context }) => {
    const errors = await start(page, context, pathname);
    // Seed source text through the same parser on both pages; Boss deliberately
    // hides the backup textareas. Order entry and export above use the real UI.
    await page.evaluate(skus => {
      document.getElementById('inputH10').value = skus.map((sku, index) => `B90000000${index} ${sku} 10`).join('\n');
      document.getElementById('inputOrders').value = skus.map(sku => `${sku}\t0`).join('\n');
      document.getElementById('inputUSAmz').value = skus.map(sku => `${sku}\t0\t0`).join('\n');
      document.getElementById('inputUSJsp').value = skus.map(sku => `${sku}\t0`).join('\n');
      buildTables();
    }, SPECIAL_SKUS);
    await page.locator('.workspaceNavTab[data-workspace="recommendations"]').click();
    await page.locator('#hideDiscontinuedFilter').uncheck();
    const analysis = await page.evaluate(skus => ({
      hidden:hideDiscontinuedMode,
      rows:window.mainRowsAll.map(({ sku, planningVelocity, usAmz, usJsp, order }) => ({ sku, planningVelocity, usAmz, usJsp, order })),
      reorder:reorderRowsAll.map(row => row.sku),
      priority:window.latestDecisionExport.priority.map(row => row.sku),
      missingOrders:getAutoDecisionRows().map(row => row.sku),
      trees:skus.map(sku => ({ sku, hasAlert:getSkuDecisionTreeAnalysis(sku, 14, 4).hasAlert })),
    }), SPECIAL_SKUS);
    expect(analysis.hidden).toBe(false);
    expect(analysis.rows).toHaveLength(6);
    for (const row of analysis.rows) {
      expect(SPECIAL_SKUS).toContain(row.sku);
      expect(row.planningVelocity).toBeGreaterThan(0);
      expect([row.usAmz, row.usJsp, row.order]).toEqual([0, 0, 0]);
    }
    expect(analysis.reorder).toEqual([]);
    expect(analysis.priority).toEqual([]);
    expect(analysis.missingOrders).toEqual([]);
    expect(analysis.trees.every(tree => tree.hasAlert === false)).toBe(true);
    await page.locator('.workspaceNavTab[data-workspace="recommendations"]').click();
    await page.locator('#btnAddReorderToGenerator').click();
    await page.locator('#btnAddPriorityToGenerator').click();
    expect(Object.keys((await readOrderDraft(page))?.rowsByProductSku || {})).toHaveLength(0);
    await page.locator('.workspaceNavTab[data-workspace="sku-tree"]').click();
    await page.locator('#skuTreeInput').fill(SPECIAL_SKUS.join('\n'));
    await page.locator('#btnRenderSkuTree').click();
    for (const sku of SPECIAL_SKUS) {
      const card = page.locator(`#skuDecisionTreeBox [data-sku-tree-card="${sku}"]`);
      await expect(card).toContainText('不提醒補貨，可手動下單');
      await expect(card.locator('.badNode')).toHaveCount(0);
    }
    await page.locator('#skuTreeAlertsOnly').check();
    await expect(page.locator('#skuDecisionTreeBox [data-sku-tree-card]')).toHaveCount(0);
    await expect(page.locator('#autoDecisionTreeBox [data-sku-tree-card]')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
