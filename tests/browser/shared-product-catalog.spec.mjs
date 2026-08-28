import { expect, test } from '@playwright/test';
import XLSX from 'xlsx';

import {
  freezeBrowserTime,
  installOfflineAssetRoutes,
  monitorBrowserErrors,
  waitForSupplyApp,
} from './browser-helpers.mjs';

function rawProductWorkbook() {
  const top = Array(23).fill('');
  const headers = Array(23).fill('');
  top[2] = '產地'; top[4] = '包數/箱'; top[17] = '紙箱規格'; top[18] = '箱/棧板'; top[21] = '每箱產品的毛重';
  headers[1] = 'SKU'; headers[22] = 'GW (lb)';
  const known = Array(23).fill('');
  const added = Array(23).fill('');
  known[1] = 'GTP03'; known[2] = '越南'; known[4] = 101; known[17] = '58.5*34.5*35'; known[18] = 36; known[22] = 26.5;
  added[1] = 'NEW01'; added[2] = '台灣'; added[4] = 24; added[17] = '48*38*28'; added[18] = 30; added[22] = 29;
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([top, headers, known, added]), 'AMZ 所有SKU');
  return XLSX.write(workbook, { type:'buffer', bookType:'xlsx' });
}

test('raw product workbook persists and overlays Supply without added master worksheets', async ({ page, context }) => {
  await freezeBrowserTime(page);
  const unexpectedRequests = [];
  await installOfflineAssetRoutes(context, unexpectedRequests);
  const browserErrors = monitorBrowserErrors(page);

  await page.goto('/#data');
  await waitForSupplyApp(page);
  await page.locator('#masterFileInput').setInputFiles({
    name:'raw-products.xlsx',
    mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer:rawProductWorkbook(),
  });

  await expect(page.locator('#masterMetaBox')).toContainText('Supply／FBA 共用產品資料');
  await expect(page.locator('#uploadStatusCatalog')).toHaveText('產品資料 已共用原始檔');
  await expect(page.locator('#productCatalogMetaBox')).toContainText('raw-products.xlsx');
  await expect.poll(() => page.evaluate(() => window.getProductByCode('GTP03')?.perCarton)).toBe(101);
  await expect.poll(() => page.evaluate(() => window.getProductByCode('NEW01')?.country)).toBe('TW');
  await expect.poll(() => page.evaluate(() => {
    const payload = JSON.parse(localStorage.getItem('jspusa:shared-product-catalog:v1') || 'null');
    return payload?.records?.length;
  })).toBe(2);

  await page.reload();
  await waitForSupplyApp(page);
  await expect(page.locator('#productCatalogMetaBox')).toContainText('raw-products.xlsx');
  await expect.poll(() => page.evaluate(() => window.getProductByCode('GTP03')?.perCarton)).toBe(101);
  await expect.poll(() => page.evaluate(() => window.getProductByCode('NEW01')?.perPallet)).toBe(30);

  await page.locator('.uploadAdvancedDetails > summary').click();
  await page.locator('#btnResetProductCatalog').click();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('jspusa:shared-product-catalog:v1'))).toBeNull();
  await expect.poll(() => page.evaluate(() => window.getProductByCode('NEW01'))).toBeNull();
  await expect(page.locator('#productCatalogMetaBox')).toContainText('目前使用內建產品資料');

  expect(unexpectedRequests).toEqual([]);
  expect(browserErrors).toEqual([]);
});
