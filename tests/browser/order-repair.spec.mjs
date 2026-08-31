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

const CHANGED_LEGACY_REVIEW_DRAFT = {
  schemaVersion:3,
  createdAt:NOW,
  updatedAt:NOW,
  rowsByProductSku:{
    GTSL01:{
      productSku:'GTSL01', orderSku:'GTSL01', standardFactory:'vietnam', orderGroup:'vietnam',
      quantities:{ packages:900, cartons:30, orderDraft:900 },
      pallet:{
        value:1,
        mode:'whole-pallet',
        authoritativeField:'pallets',
        strategy:'whole-pallet',
      },
      locked:false,
      packagingAssignment:{
        state:'review-required',
        reason:'legacy-migration',
        assignedAt:NOW,
        orderSku:'GTSL01',
        canonicalProductSku:'GTSL01',
        packagingVersion:'2026-08-25',
        catalogVersion:null,
        perCarton:30,
        perPack:null,
        perBox:null,
        perPallet:30,
        boxSize:'50*40*40',
        productName:'Gootoe - Turkey Tendon Strip (454g x 30)',
      },
      createdAt:NOW,
      updatedAt:NOW,
      issues:[{
        code:'PACKAGING_ASSIGNMENT_REVIEW_REQUIRED',
        productSku:'GTSL01',
        orderSku:'GTSL01',
        packagingVersion:'2026-08-25',
        advisory:true,
      }],
    },
  },
  groupOrder:{ taiwan:[], vietnam:['GTSL01'], subcontract:[] },
  repairOrder:[],
  issues:[],
};

const IDENTICAL_ASCL05_REVIEW_DRAFT = {
  schemaVersion:3,
  createdAt:NOW,
  updatedAt:NOW,
  rowsByProductSku:{
    ASCL05:{
      productSku:'ASCL05', orderSku:'ASCL05', standardFactory:'vietnam', orderGroup:'vietnam',
      quantities:{ packages:14364, cartons:399, orderDraft:null },
      pallet:{ value:9.5, mode:'manual', authoritativeField:'pallets', strategy:'' },
      locked:false,
      packagingAssignment:{
        state:'review-required',
        reason:'legacy-migration',
        assignedAt:NOW,
        orderSku:'ASCL05',
        canonicalProductSku:'ASCL05',
        packagingVersion:'2026-08-25',
        catalogVersion:null,
        perCarton:36,
        perPack:null,
        perBox:null,
        perPallet:42,
        boxSize:'50*40*30',
        productName:'AFreschi - Natural Soft Chicken Jerky Cuts 454g*36',
      },
      createdAt:NOW,
      updatedAt:NOW,
      issues:[{
        code:'PACKAGING_ASSIGNMENT_REVIEW_REQUIRED',
        productSku:'ASCL05',
        orderSku:'ASCL05',
        packagingVersion:'2026-08-25',
        advisory:true,
      }],
    },
  },
  groupOrder:{ taiwan:[], vietnam:['ASCL05'], subcontract:[] },
  repairOrder:[],
  issues:[],
};

test('ASCL05 does not ask for confirmation when every packaging preview value is identical', async ({ page, context }) => {
  await freezeBrowserTime(page);
  const unexpectedRequests = [];
  await installOfflineAssetRoutes(context, unexpectedRequests);
  await page.addInitScript(draft => {
    localStorage.setItem('supply-order-draft-v3', JSON.stringify(draft));
  }, IDENTICAL_ASCL05_REVIEW_DRAFT);

  await page.goto('/#orders');
  await waitForSupplyApp(page);
  await page.locator('input[name="orderGroupSelect"][value="vietnam"]').check();
  const row = page.locator('#productTable tbody tr[data-product="ASCL05"]');
  await expect(row).toBeVisible();
  await expect(row.locator('.packagingReassignButton')).toHaveCount(0);
  await expect(row.locator('.packagingAssignmentSlot')).toBeEmpty();
  await expect(page.locator('#generatorPackagingReviewBar')).toBeHidden();
  const resolved = (await readOrderDraft(page)).rowsByProductSku.ASCL05;
  expect(resolved.packagingAssignment.state).toBe('pinned');
  expect(resolved.packagingAssignment.reason).toBe('legacy-identical-packaging');
  expect(resolved.packagingAssignment.packagingVersion).toBe('2026-08-25');
  expect(resolved.quantities).toEqual(IDENTICAL_ASCL05_REVIEW_DRAFT.rowsByProductSku.ASCL05.quantities);
  expect(resolved.pallet).toEqual(IDENTICAL_ASCL05_REVIEW_DRAFT.rowsByProductSku.ASCL05.pallet);
  expect(unexpectedRequests).toEqual([]);
});

test('a real legacy packaging version difference stays pending until one explicit batch confirmation preserves it', async ({ page, context }) => {
  await freezeBrowserTime(page);
  const unexpectedRequests = [];
  await installOfflineAssetRoutes(context, unexpectedRequests);
  await page.addInitScript(draft => {
    if (!localStorage.getItem('supply-order-draft-v3')) {
      localStorage.setItem('supply-order-draft-v3', JSON.stringify(draft));
    }
  }, CHANGED_LEGACY_REVIEW_DRAFT);

  await page.goto('/#orders');
  await waitForSupplyApp(page);
  await page.locator('input[name="orderGroupSelect"][value="vietnam"]').check();
  const row = page.locator('#productTable tbody tr[data-product="GTSL01"]');
  await expect(row).toBeVisible();
  await expect(row.locator('.packagingReassignButton')).toContainText('待確認');
  await expect(page.locator('#generatorPackagingReviewBar')).toContainText('舊版草稿有 1 筆包裝待確認');
  const before = (await readOrderDraft(page)).rowsByProductSku.GTSL01;
  expect(before.packagingAssignment.state).toBe('review-required');

  let batchMessage = '';
  page.once('dialog', async dialog => {
    batchMessage = dialog.message();
    await dialog.accept();
  });
  await page.locator('#confirmAllLegacyPackagingReviewsButton').click();
  expect(batchMessage).toContain('一次確認 1 筆舊版草稿包裝');
  expect(batchMessage).toContain('不會套用新版');
  await expect(page.locator('#generatorPackagingReviewBar')).toBeHidden();
  const confirmed = (await readOrderDraft(page)).rowsByProductSku.GTSL01;
  expect(confirmed.packagingAssignment.state).toBe('pinned');
  expect(confirmed.packagingAssignment.packagingVersion).toBe(before.packagingAssignment.packagingVersion);
  for (const field of ['packages', 'cartons', 'orderDraft']) {
    expect(confirmed.quantities[field]).toBe(before.quantities[field]);
  }
  expect(confirmed.orderSku).toBe(before.orderSku);
  expect(confirmed.issues).toEqual([]);

  await page.reload();
  await waitForSupplyApp(page);
  await page.locator('input[name="orderGroupSelect"][value="vietnam"]').check();
  await expect(page.locator('#generatorPackagingReviewBar')).toBeHidden();
  await expect(page.locator('#productTable tbody tr[data-product="GTSL01"] .packagingReassignButton')).toContainText('有新版');
  expect((await readOrderDraft(page)).rowsByProductSku.GTSL01.packagingAssignment.state).toBe('pinned');
  expect(unexpectedRequests).toEqual([]);
});

test('unknown draft rows stay visible and removable while fractional pallet display does not round stored/exported truth', async ({ page, context }) => {
  await freezeBrowserTime(page);
  const unexpectedRequests = [];
  await installOfflineAssetRoutes(context, unexpectedRequests);
  await page.addInitScript(draft => {
    localStorage.setItem('supply-order-draft-v2', JSON.stringify(draft));
  }, SEEDED_DRAFT);

  await page.goto('/#orders');
  await waitForSupplyApp(page);
  await expect(page.locator('#generatorDraftStatus')).toHaveText('已還原 2 個品項；另有 2 筆資料需要修復。');
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

  const packagingReview = page.locator('#productTable tbody tr[data-product="GTSL01"] .packagingReassignButton');
  await expect(packagingReview).toContainText('待確認');
  for (const viewport of [{ width:1440, height:900 }, { width:390, height:844 }]) {
    await page.setViewportSize(viewport);
    const packagingLayout = await packagingReview.evaluate(button => {
      const row = button.closest('tr');
      const textRange = document.createRange();
      textRange.selectNodeContents(button);
      const rowRect = row.getBoundingClientRect();
      const textRect = textRange.getBoundingClientRect();
      return {
        buttonClientHeight:button.clientHeight,
        buttonScrollHeight:button.scrollHeight,
        overflowPx:Math.max(0, textRect.bottom - rowRect.bottom),
      };
    });
    expect(packagingLayout.buttonScrollHeight).toBeLessThanOrEqual(packagingLayout.buttonClientHeight);
    expect(packagingLayout.overflowPx).toBeLessThanOrEqual(0.5);
  }
  let previewMessage = '';
  page.once('dialog', async dialog => {
    previewMessage = dialog.message();
    await dialog.accept();
  });
  await packagingReview.click();
  expect(previewMessage).toContain('包裝調整預覽');
  await expect.poll(async () => (await readOrderDraft(page)).rowsByProductSku.GTSL01.packagingAssignment.state).toBe('pinned');

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

test.describe('coarse pointer packaging review layout', () => {
  test.use({ hasTouch:true, viewport:{ width:390, height:844 } });

  test('touch sizing keeps the full review label inside its row', async ({ page, context }) => {
    await freezeBrowserTime(page);
    const unexpectedRequests = [];
    await installOfflineAssetRoutes(context, unexpectedRequests);
    await page.addInitScript(draft => {
      localStorage.setItem('supply-order-draft-v3', JSON.stringify(draft));
    }, CHANGED_LEGACY_REVIEW_DRAFT);

    await page.goto('/#orders');
    await waitForSupplyApp(page);
    await page.locator('input[name="orderGroupSelect"][value="vietnam"]').check();
    expect(await page.evaluate(() => matchMedia('(pointer: coarse)').matches)).toBe(true);
    const packagingReview = page.locator('#productTable tbody tr[data-product="GTSL01"] .packagingReassignButton');
    const layout = await packagingReview.evaluate(button => {
      const row = button.closest('tr');
      const textRange = document.createRange();
      textRange.selectNodeContents(button);
      const rowRect = row.getBoundingClientRect();
      const textRect = textRange.getBoundingClientRect();
      return {
        buttonClientHeight:button.clientHeight,
        buttonScrollHeight:button.scrollHeight,
        buttonClientWidth:button.clientWidth,
        buttonScrollWidth:button.scrollWidth,
        overflowBottom:Math.max(0, textRect.bottom - rowRect.bottom),
      };
    });
    expect(layout.buttonScrollHeight).toBeLessThanOrEqual(layout.buttonClientHeight);
    expect(layout.buttonScrollWidth).toBeLessThanOrEqual(layout.buttonClientWidth);
    expect(layout.overflowBottom).toBeLessThanOrEqual(0.5);
    expect(unexpectedRequests).toEqual([]);
  });
});
