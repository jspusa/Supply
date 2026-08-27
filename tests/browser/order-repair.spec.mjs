import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import XLSX from 'xlsx';

import {
  freezeBrowserTime,
  installOfflineAssetRoutes,
  readOrderDraft,
  waitForSupplyApp,
} from './browser-helpers.mjs';

XLSX.set_fs(fs);

const NOW = '2026-08-28T08:30:00.000Z';
const SEEDED_DRAFT = {
  schemaVersion:2,
  createdAt:NOW,
  updatedAt:NOW,
  rowsByProductSku:{
    GTSL01:{
      productSku:'GTSL01', orderSku:'GTSL01', standardFactory:'vietnam', orderGroup:'vietnam',
      quantities:{ packages:8, cartons:1, orderDraft:'' },
      pallet:{ value:1 / 3, mode:'manual', authoritativeField:'pallets' },
      locked:false, createdAt:NOW, updatedAt:NOW, issues:[],
    },
    'UNKNOWN-REPAIR':{
      productSku:'UNKNOWN-REPAIR', orderSku:'7ZZ-UNKNOWN', standardFactory:null, orderGroup:null,
      quantities:{ packages:12.5, cartons:1.25, orderDraft:'' },
      pallet:{ value:0.75, mode:'manual', authoritativeField:'pallets' },
      locked:true, createdAt:NOW, updatedAt:NOW,
      issues:[{ code:'MISSING_PRODUCT_CATALOG', productSku:'UNKNOWN-REPAIR' }],
    },
  },
  groupOrder:{ taiwan:[], vietnam:['GTSL01'], subcontract:[] },
  repairOrder:['UNKNOWN-REPAIR'],
  issues:[],
};

test('unknown draft rows stay visible and removable while fractional pallet display does not round stored/exported truth', async ({ page, context }) => {
  await freezeBrowserTime(page);
  const unexpectedRequests = [];
  await installOfflineAssetRoutes(context, unexpectedRequests);
  await page.addInitScript(draft => {
    localStorage.setItem('supply-order-draft-v2', JSON.stringify(draft));
  }, SEEDED_DRAFT);

  await page.goto('/#orders');
  await waitForSupplyApp(page);
  await expect(page.locator('#generatorDraftStatus')).toHaveText('已還原 2 個品項；另有 1 筆資料需要修復。');
  const repair = page.locator('#generatorRepairRows [data-repair-product="UNKNOWN-REPAIR"]');
  await expect(repair).toBeVisible();
  await expect(repair).toContainText('Product SKU：UNKNOWN-REPAIR');
  await expect(repair).toContainText('Order SKU：7ZZ-UNKNOWN');
  await expect(repair).toContainText('packages: 12.5');
  await expect(repair).toContainText('棧板：0.75');
  await expect(repair).toContainText('MISSING_PRODUCT_CATALOG');

  await page.locator('input[name="orderGroupSelect"][value="vietnam"]').check();
  const pallet = page.locator('#productTable tbody tr[data-product="GTSL01"] .edit-pallets-input');
  await expect(pallet).toHaveValue('0.33');
  expect((await pallet.inputValue()).split('.')[1]?.length || 0).toBeLessThanOrEqual(2);

  await repair.locator('.generatorRepairDelete').click();
  await expect(page.locator('#generatorRepairRows')).toBeHidden();
  await expect.poll(async () => (await readOrderDraft(page)).repairOrder).toEqual([]);
  expect((await readOrderDraft(page)).rowsByProductSku.GTSL01.pallet.value).toBe(1 / 3);

  const downloadPromise = page.waitForEvent('download', { timeout:8_000 });
  await page.getByRole('button', { name:'匯出訂單 Excel' }).click();
  const download = await downloadPromise;
  const workbook = XLSX.readFile(await download.path(), { raw:true });
  const rows = XLSX.utils.sheet_to_json(workbook.Sheets['越南'], { header:1, raw:true, defval:'' });
  expect(rows[1][1]).toBe('GTSL01');
  expect(rows[1][7]).toBeCloseTo(1 / 3, 12);
  expect((await readOrderDraft(page)).rowsByProductSku.GTSL01.pallet.value).toBe(1 / 3);
  expect(unexpectedRequests).toEqual([]);
});
