import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import XLSX from 'xlsx';

import { BOSS_FIXTURE_TOKEN } from '../fixtures/sanitized-supply-browser.mjs';
import {
  createBossCloudMock,
  freezeBrowserTime,
  installOfflineAssetRoutes,
  monitorBrowserErrors,
  readOrderDraft,
  waitForSupplyApp,
} from './browser-helpers.mjs';

XLSX.set_fs(fs);

const NOW = '2026-08-28T08:30:00.000Z';
const PRODUCT_SKU = 'RETIRED01';
const PACKAGING_VERSION = 'retired-pack-v1';
const SEEDED_DRAFT = {
  schemaVersion:3,
  createdAt:NOW,
  updatedAt:NOW,
  rowsByProductSku:{
    [PRODUCT_SKU]:{
      productSku:PRODUCT_SKU,
      orderSku:PRODUCT_SKU,
      standardFactory:'vietnam',
      orderGroup:'vietnam',
      quantities:{ packages:120, secondary:'', target:'', cartons:5, orderDraft:120 },
      pallet:{
        value:0.125,
        mode:'manual',
        authoritativeField:'quantity',
        warningCode:'',
        strategy:'',
        guidance:'',
      },
      locked:false,
      packagingAssignment:{
        state:'pinned',
        reason:'manual',
        assignedAt:NOW,
        orderSku:PRODUCT_SKU,
        canonicalProductSku:PRODUCT_SKU,
        packagingVersion:PACKAGING_VERSION,
        catalogVersion:'2026-08-28.4',
        perCarton:24,
        perPack:null,
        perBox:null,
        perPallet:40,
        boxSize:'50*40*30',
        productName:'Retired historical product',
      },
      createdAt:NOW,
      updatedAt:NOW,
      issues:[],
    },
  },
  groupOrder:{ vietnam:[PRODUCT_SKU], taiwan:[], subcontract:[] },
  repairOrder:[],
  issues:[],
};

function sheetRows(workbook, name) {
  return XLSX.utils.sheet_to_json(workbook.Sheets[name], { header:1, raw:true, defval:'' });
}

for (const entry of [
  { name:'public', url:'/#orders', boss:false },
  { name:'Boss', url:'/Boss/#orders', boss:true },
]) {
  test(`${entry.name} keeps a retired pinned Order Draft readable and exportable without making it editable`, async ({ page, context }) => {
    await freezeBrowserTime(page);
    const unexpectedRequests = [];
    await installOfflineAssetRoutes(context, unexpectedRequests);
    const browserErrors = monitorBrowserErrors(page);
    const cloud = entry.boss ? createBossCloudMock({ cloudFiles:[] }) : null;
    if (cloud) await cloud.install(context);
    await page.addInitScript(({ draft, boss, token }) => {
      localStorage.setItem('supply-order-draft-v3', JSON.stringify(draft));
      if (boss) sessionStorage.setItem('supply-boss-session', token);
    }, { draft:SEEDED_DRAFT, boss:entry.boss, token:BOSS_FIXTURE_TOKEN });

    await page.goto(entry.url);
    await waitForSupplyApp(page);
    if (entry.boss) await expect(page.locator('#bossAuthGate')).toBeHidden();
    await page.locator('.workspaceNavTab[data-workspace="orders"]').click();
    await page.locator('input[name="orderGroupSelect"][value="vietnam"]').check();

    const row = page.locator(`#productTable tbody tr[data-product="${PRODUCT_SKU}"]`);
    await expect(row).toBeVisible();
    await expect(row).toHaveAttribute('data-historical-only', 'true');
    await expect(row).toHaveAttribute('title', /已不供新訂單使用.*保留既有草稿.*匯出/);
    await expect(row.locator('.packagingAssignmentSlot')).toContainText('歷史草稿');
    await expect(row.locator('.packagingAssignmentSlot')).toContainText(`包裝 ${PACKAGING_VERSION}`);
    await expect(row.locator('.box-size-cell')).toHaveText('50*40*30 cm');
    await expect(row.locator('.edit-quantity-input')).toHaveValue('120');
    await expect(row.locator('.edit-cartons-input')).toHaveValue('5');
    await expect(row.locator('.edit-pallets-input')).toHaveValue('0.13');

    for (const input of await row.locator('input').all()) await expect(input).toBeDisabled();
    await expect(row.locator('.lock-button')).toBeDisabled();
    await expect(row.locator('.packagingReassignButton:enabled, .equivalentOrderToggle:enabled')).toHaveCount(0);

    const beforeExport = (await readOrderDraft(page)).rowsByProductSku[PRODUCT_SKU];
    const downloadPromise = page.waitForEvent('download', { timeout:8_000 });
    await page.getByRole('button', { name:'匯出訂單 Excel' }).click();
    const download = await downloadPromise;
    const downloadedPath = await download.path();
    expect(downloadedPath).toBeTruthy();
    const workbook = XLSX.readFile(downloadedPath, { raw:true });
    expect(workbook.SheetNames).toEqual(['台灣', '越南', '代工']);
    const exported = sheetRows(workbook, '越南')[1];
    expect(exported[1]).toBe(PRODUCT_SKU);
    expect(exported[2]).toBe('Retired historical product');
    expect(exported[3]).toBe(24);
    expect(exported[4]).toBe('單包');
    expect(exported[5]).toBe(5);
    expect(exported[7]).toBeCloseTo(0.125, 12);
    expect(exported[9]).toBe('50*40*30');

    const afterExport = (await readOrderDraft(page)).rowsByProductSku[PRODUCT_SKU];
    expect(afterExport.quantities).toEqual(beforeExport.quantities);
    expect(afterExport.packagingAssignment).toEqual(beforeExport.packagingAssignment);
    expect(afterExport.orderGroup).toBe('vietnam');
    expect(unexpectedRequests).toEqual([]);
    expect(browserErrors).toEqual([]);
    if (cloud) {
      expect(cloud.authorizationFailures).toEqual([]);
      expect(cloud.unexpected).toEqual([]);
    }
  });
}
