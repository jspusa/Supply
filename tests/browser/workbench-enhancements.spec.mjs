import { expect, test } from '@playwright/test';
import {
  asInputFiles, freezeBrowserTime, installOfflineAssetRoutes, monitorBrowserErrors,
  readOrderDraft, waitForSupplyApp,
} from './browser-helpers.mjs';
import { createSanitizedSupplyFixture, SANITIZED_H10_TEXT } from '../fixtures/sanitized-supply-browser.mjs';

async function start(page, context) {
  await freezeBrowserTime(page);
  await installOfflineAssetRoutes(context);
  const errors = monitorBrowserErrors(page);
  await page.goto('/#orders');
  await waitForSupplyApp(page);
  return errors;
}

test('bulk rows route all groups, keep existing quantities, report unknown SKUs and restore after refresh', async ({ page, context }) => {
  const errors = await start(page, context);
  await page.locator('#generatorBulkInput').fill('SKU\t數量\nEZD011AM\t120\n1MHTD011A0\t240\n7ATSD010AB\t300\nUNKNOWN999\t10');
  await page.locator('#btnAddGeneratorBulk').click();
  await expect(page.locator('#generatorBulkStatus')).toContainText('已加入 3 個品項');
  await expect(page.locator('#generatorBulkStatus')).toContainText('UNKNOWN999');
  const draft = await readOrderDraft(page);
  expect(draft.rowsByProductSku.EZD011AM.orderGroup).toBe('taiwan');
  expect(draft.rowsByProductSku['1MHTD011A0'].orderGroup).toBe('vietnam');
  expect(draft.rowsByProductSku['TTS05AM-1'].orderGroup).toBe('subcontract');
  expect(draft.rowsByProductSku['TTS05AM-1'].orderSku).toBe('7ATSD010AB');
  expect(draft.rowsByProductSku.EZD011AM.quantities.packages).toBe(120);
  await page.locator('#generatorBulkInput').fill('EZD011AM\t999');
  await page.locator('#btnAddGeneratorBulk').click();
  await expect(page.locator('#generatorBulkStatus')).toContainText('保留原數量');
  expect((await readOrderDraft(page)).rowsByProductSku.EZD011AM.quantities.packages).toBe(120);
  await page.reload();
  await waitForSupplyApp(page);
  expect(Object.keys((await readOrderDraft(page)).rowsByProductSku)).toHaveLength(3);
  await page.setViewportSize({ width:390, height:844 });
  await page.locator('.workspaceNavTab[data-workspace="orders"]').click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  expect(errors).toEqual([]);
});

test('calendar and lead time stay in sync and the chosen date survives reload', async ({ page, context }) => {
  const errors = await start(page, context);
  const date = page.locator('#newOrderArrivalDate');
  await expect(date).toHaveAttribute('type', 'date');
  await date.fill('2026-10-27');
  await date.dispatchEvent('change');
  await expect(page.locator('#leadTimeDays')).toHaveValue('60');
  await expect(page.locator('#newOrderArrivalHint')).toContainText('2026-11-17');
  await expect.poll(() => page.evaluate(() => {
    const raw = localStorage.getItem('supply-workspace-preferences-v1');
    return raw ? JSON.parse(raw).planning.newOrderArrivalDate : null;
  })).toBe('2026-10-27');
  await page.reload();
  await waitForSupplyApp(page);
  await page.locator('.workspaceNavTab[data-workspace="orders"]').click();
  await expect(date).toHaveValue('2026-10-27');
  await page.locator('#leadTimeDays').fill('30');
  await page.locator('#leadTimeDays').dispatchEvent('change');
  await expect(date).toHaveValue('2026-09-27');
  await date.fill('2026-08-27');
  await date.dispatchEvent('change');
  await expect(page.locator('#leadTimeDays')).toHaveValue('30');
  await expect(page.locator('#newOrderArrivalHint')).toContainText('日期未套用');
  expect(errors).toEqual([]);
});

test('decision tree shows eligible supply coverage before expanding later stages', async ({ page, context }) => {
  const errors = await start(page, context);
  const fixture = createSanitizedSupplyFixture();
  await page.locator('.workspaceNavTab[data-workspace="data"]').click();
  await page.locator('#masterFileInput').setInputFiles(asInputFiles(fixture.masterFiles));
  await expect(page.locator('#masterMetaBox')).toContainText('sanitized-jsp-inventory.xlsx');
  await page.locator('#inputH10').fill(SANITIZED_H10_TEXT);
  await page.locator('#btnBuild').click();
  await page.locator('.workspaceNavTab[data-workspace="sku-tree"]').click();
  await page.locator('#skuTreeInput').fill('EZD011AM');
  await page.locator('#btnRenderSkuTree').click();
  const card = page.locator('#skuDecisionTreeBox [data-sku-tree-card="EZD011AM"]');
  await expect(card).toContainText('含訂單預計可售天數');
  await expect(card.locator('.decisionCoverageValue')).toHaveText('約 4.0 天');
  expect(errors).toEqual([]);
});

test('product update exposes SharePoint and drag/drop uses the shared Excel validation flow', async ({ page, context }) => {
  const errors = await start(page, context);
  await page.getByRole('button', { name:'更新產品資料' }).click();
  const dialog = page.locator('#productUpdateDialog');
  const drop = dialog.locator('[data-product-workbook-drop]');
  await expect(drop).toBeVisible();
  await expect(dialog.locator('[data-product-workbook-source]')).toHaveAttribute('href', /24466647-my\.sharepoint\.com/);
  await drop.evaluate(element => {
    const files = new DataTransfer();
    files.items.add(new File(['not a workbook'], 'invalid.txt', { type:'text/plain' }));
    element.dispatchEvent(new DragEvent('drop', { bubbles:true, cancelable:true, dataTransfer:files }));
  });
  await expect(dialog.locator('[data-product-update-message]')).toContainText('.xlsx');
  const version = await page.evaluate(() => window.JSPCatalogUpdateBaseline.catalogVersion);
  const future = new Date(version.slice(0, 10) + 'T08:30:00Z');
  future.setUTCDate(future.getUTCDate() + 1);
  await page.clock.setFixedTime(future);
  await drop.evaluate(element => {
    const top = Array(23).fill(''), headers = Array(23).fill(''), row = Array(23).fill('');
    top[2] = '產地'; top[4] = '包數/箱'; top[17] = '紙箱規格'; top[18] = '箱/棧板'; top[21] = '每箱產品的毛重';
    headers[1] = 'SKU'; headers[22] = 'GW (lb)';
    row[1] = 'GTP03'; row[2] = '越南'; row[4] = 101; row[17] = '58.5*34.5*35'; row[22] = 26;
    const workbook = window.XLSX.utils.book_new();
    window.XLSX.utils.book_append_sheet(workbook, window.XLSX.utils.aoa_to_sheet([top, headers, row]), 'AMZ 所有SKU');
    const bytes = window.XLSX.write(workbook, { type:'array', bookType:'xlsx' });
    const files = new DataTransfer();
    files.items.add(new File([bytes], 'dragged-products.xlsx', { type:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
    element.dispatchEvent(new DragEvent('drop', { bubbles:true, cancelable:true, dataTransfer:files }));
  });
  await expect(dialog.locator('[data-product-update-message]')).toContainText('已在記憶體解析 1 筆');
  await expect(drop).toBeEnabled();
  expect(await page.evaluate(() => window.JSPProductUpdateRuntime.getPlan().sourceFile)).toBe('dragged-products.xlsx');
  expect(errors).toEqual([]);
});
