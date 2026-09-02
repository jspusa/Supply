import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import XLSX from 'xlsx';

import {
  freezeBrowserTime,
  installOfflineAssetRoutes,
  monitorBrowserErrors,
  waitForSupplyApp,
} from './browser-helpers.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..', '..');
const supplyManifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'catalog-alignment.json'), 'utf8'));
const fbaManifest = {
  ...supplyManifest,
  site:'fba',
  publicContentHash:supplyManifest.expectedPublicContentHashes.fba,
};

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
}

function signedPlan({ blocked = false } = {}) {
  const entries = [
    {
      id:'order-sku-alias:7ABCD013AB', kind:'catalog-change', entryType:'order-sku-alias',
      sku:'7ABCD013AB', changeType:'updated', risk:'safe', selectable:true, selected:true,
      fields:[{ field:'unitsPerCarton', before:24, after:30 }],
      before:{ unitsPerCarton:24 }, after:{ unitsPerCarton:30 },
      evidence:{ sources:[{ sheet:'Products', row:2, packagingVersion:'2026-08-28.5' }], impact:['fba-carton-projection'] },
    },
    {
      id:'product:ABC01', kind:'catalog-change', entryType:'product',
      sku:'ABC01', changeType:'updated', risk:'review', selectable:true, selected:false,
      fields:[{ field:'origin', before:'VN', after:'TW' }],
      before:{ origin:'VN' }, after:{ origin:'TW' },
      evidence:{ sources:[], impact:['order-workbook-routing'] },
    },
  ];
  if (blocked) {
    entries.push({
      id:'source-conflict:XYZ01:1', kind:'source-conflict', entryType:'source-conflict',
      sku:'XYZ01', changeType:'conflict', risk:'blocking', selectable:false, selected:false,
      fields:[{ field:'unitsPerCarton', values:[
        { value:24, sourceSheet:'Products', sourceRow:8 },
        { value:30, sourceSheet:'Products', sourceRow:9 },
      ] }],
      message:'XYZ01 每箱數量來源衝突',
    });
  }
  const plan = {
    schemaVersion:1,
    generatedAt:'2026-08-28T10:00:00.000Z',
    sourceFile:'raw-product.xlsx',
    baseline:{ catalogVersion:'2026-08-28.4', sha256:'a'.repeat(64) },
    candidate:{ catalogVersion:'2026-08-28.5', sha256:'b'.repeat(64) },
    duplicateResolution:null,
    stats:{
      productsBefore:1, productsAfter:1, aliasesBefore:1, aliasesAfter:1,
      added:0, updated:2, removed:0, changedEntries:2,
      safe:1, review:1, blocking:blocked ? 1 : 0, selected:1,
    },
    blockers:blocked ? ['XYZ01 每箱數量來源衝突'] : [],
    entries,
  };
  plan.planSha256 = crypto.createHash('sha256').update(JSON.stringify(canonical(plan))).digest('hex');
  return plan;
}

function rawProductWorkbookBuffer() {
  const top = Array(23).fill('');
  const headers = Array(23).fill('');
  const row = Array(23).fill('');
  top[2] = '產地';
  top[4] = '包數/箱';
  top[17] = '紙箱規格';
  top[18] = '箱/棧板';
  top[21] = '每箱產品的毛重';
  headers[1] = 'SKU';
  headers[22] = 'GW (lb)';
  row[1] = 'GTP03';
  row[2] = '越南';
  row[4] = 101;
  row[17] = '58.5*34.5*35';
  row[18] = '';
  row[22] = 26;
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([top, headers, row]), 'AMZ 所有SKU');
  return XLSX.write(workbook, { type:'buffer', bookType:'xlsx' });
}

async function installAlignmentRoutes(context) {
  await context.route('**/catalog-alignment.json', route => {
    const isFba = new URL(route.request().url()).pathname.includes('/FBA/');
    return route.fulfill({
      status:200,
      contentType:'application/json',
      body:JSON.stringify(isFba ? fbaManifest : supplyManifest),
    });
  });
}

test('risk inbox keeps plans in memory and downloads one public-only handoff after final confirmation', async ({ page, context }) => {
  await freezeBrowserTime(page);
  const browserErrors = monitorBrowserErrors(page);
  const unexpectedRequests = [];
  await installAlignmentRoutes(context);
  await installOfflineAssetRoutes(context, unexpectedRequests);

  await page.goto('/');
  await waitForSupplyApp(page);
  await expect.poll(() => page.evaluate(() => Boolean(window.JSPProductUpdateRuntime))).toBe(true);
  await page.evaluate(() => localStorage.setItem('product-update-unrelated-sentinel', 'keep'));

  await page.getByRole('button', { name:'更新產品資料' }).click();
  const dialog = page.getByRole('dialog', { name:'產品資料更新' });
  await expect(dialog).toBeVisible();
  await page.evaluate(plan => window.JSPProductUpdateRuntime.loadPlan(plan), signedPlan());
  await expect(dialog.locator('.product-update-lane[data-risk="safe"] input')).toBeChecked();
  await expect(dialog.locator('.product-update-lane[data-risk="review"] input')).not.toBeChecked();
  await expect(dialog.locator('.product-update-lane[data-risk="blocking"] input')).toHaveCount(0);
  await expect(dialog.locator('[data-product-update-versions]')).toHaveText('2026-08-28.4 → 2026-08-28.5');
  await dialog.locator('.product-update-details summary').click();
  await expect(dialog.locator('[data-product-update-detail-rows] tr')).toHaveCount(2);

  await dialog.locator('.product-update-lane[data-risk="review"] input').check();
  await dialog.locator('[data-product-update-prepare]').click();
  const confirm = dialog.locator('[data-product-update-confirm]');
  await expect(confirm).toBeVisible();
  await expect(confirm.locator('[data-product-update-confirm-cancel]')).toBeFocused();
  const downloadPromise = page.waitForEvent('download');
  await confirm.locator('[data-product-update-confirm-accept]').click();
  const download = await downloadPromise;
  const handoff = JSON.parse(await fs.promises.readFile(await download.path(), 'utf8'));
  expect(Object.keys(handoff).sort()).toEqual([
    'baseline', 'candidate', 'confirmedAt', 'kind', 'planSha256', 'schemaVersion', 'selectedEntryIds',
  ]);
  expect(handoff.selectedEntryIds).toEqual(['order-sku-alias:7ABCD013AB', 'product:ABC01']);
  expect(JSON.stringify(handoff)).not.toMatch(/sourceFile|sourceRow|sourceSheet|before|after|raw-product/);
  expect(await page.evaluate(() => localStorage.getItem('product-update-unrelated-sentinel'))).toBe('keep');
  expect(await page.evaluate(() => Object.entries(localStorage).some(([, value]) => value.includes('raw-product.xlsx')))).toBe(false);

  await page.reload();
  await waitForSupplyApp(page);
  await expect.poll(() => page.evaluate(() => Boolean(window.JSPProductUpdateRuntime))).toBe(true);
  await page.getByRole('button', { name:'更新產品資料' }).click();
  await expect(page.locator('[data-product-update-plan]')).toBeHidden();
  expect(await page.evaluate(() => localStorage.getItem('product-update-unrelated-sentinel'))).toBe('keep');
  expect(unexpectedRequests).toEqual([]);
  expect(browserErrors).toEqual([]);
});

test('blocking conflict is disabled, cannot be bypassed, and mobile dialog stays within viewport', async ({ page, context }) => {
  await page.setViewportSize({ width:390, height:844 });
  await installAlignmentRoutes(context);
  await page.goto('/');
  await waitForSupplyApp(page);
  await expect.poll(() => page.evaluate(() => Boolean(window.JSPProductUpdateRuntime))).toBe(true);
  await page.getByRole('button', { name:'更新產品資料' }).click();
  await page.evaluate(plan => window.JSPProductUpdateRuntime.loadPlan(plan), signedPlan({ blocked:true }));
  const dialog = page.locator('#productUpdateDialog');
  await expect(dialog.locator('.product-update-lane[data-risk="blocking"] input')).toBeDisabled();
  await expect(dialog.locator('[data-product-update-prepare]')).toBeDisabled();
  const box = await dialog.boundingBox();
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.width).toBeLessThanOrEqual(390);
});

test('raw Excel creates the signed plan in memory and explicit clear is review-only', async ({ page, context }) => {
  await freezeBrowserTime(page);
  const browserErrors = monitorBrowserErrors(page);
  const unexpectedRequests = [];
  await installAlignmentRoutes(context);
  await installOfflineAssetRoutes(context, unexpectedRequests);
  await page.goto('/');
  await waitForSupplyApp(page);
  await expect.poll(() => page.evaluate(() => Boolean(window.JSPProductUpdateRuntime))).toBe(true);

  await page.getByRole('button', { name:'更新產品資料' }).click();
  const dialog = page.getByRole('dialog', { name:'產品資料更新' });
  await dialog.locator('[data-product-update-raw-file]').setInputFiles({
    name:'raw-product.xlsx',
    mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer:rawProductWorkbookBuffer(),
  });
  await expect(dialog.locator('[data-product-update-message]')).toContainText('已在記憶體解析 1 筆');
  await expect(dialog.locator('[data-product-update-versions]')).toHaveText('2026-08-28.4 → 2026-08-28.5');
  await expect(dialog.locator('[data-product-update-clears]')).toBeVisible();
  await dialog.locator('[data-product-update-clears] summary').click();
  const clearCartons = dialog.locator('[data-clear-sku="GTP03"][data-clear-field="cartonsPerPallet"]');
  await expect(clearCartons).not.toBeChecked();
  await clearCartons.check();
  await expect(dialog.locator('[data-product-update-message]')).toContainText('高風險且不預選');
  await expect(dialog.locator('.product-update-lane[data-risk="review"] input[data-entry-id="product:GTP03"]')).not.toBeChecked();
  const planState = await page.evaluate(() => {
    const entry = window.JSPProductUpdateRuntime.getPlan().entries.find(item => item.id === 'product:GTP03');
    return {
      sourceFile:window.JSPProductUpdateRuntime.getPlan().sourceFile,
      risk:entry.risk,
      selected:entry.selected,
      clear:entry.fields.find(field => field.field === 'cartonsPerPallet'),
    };
  });
  expect(planState).toEqual({
    sourceFile:'raw-product.xlsx',
    risk:'review',
    selected:false,
    clear:{ field:'cartonsPerPallet', before:36, after:null },
  });

  const planDownloadPromise = page.waitForEvent('download');
  await dialog.locator('[data-product-update-save-plan]').click();
  const planDownload = await planDownloadPromise;
  const downloadedPlan = JSON.parse(await fs.promises.readFile(await planDownload.path(), 'utf8'));
  expect(downloadedPlan.planSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(JSON.stringify(downloadedPlan)).not.toMatch(/\/Users\//);
  expect(downloadedPlan.entries[0].evidence.sources[0]).toMatchObject({ sheet:'AMZ 所有SKU', row:3 });

  await dialog.locator('.product-update-lane[data-risk="review"] input[data-entry-id="product:GTP03"]').check();
  await expect(dialog.locator('[data-product-update-prepare]')).toBeEnabled();
  expect(await page.evaluate(() => Object.values(localStorage).some(value => /raw-product|GTP03/.test(value)))).toBe(false);
  await page.reload();
  await waitForSupplyApp(page);
  await expect.poll(() => page.evaluate(() => Boolean(window.JSPProductUpdateRuntime))).toBe(true);
  await page.getByRole('button', { name:'更新產品資料' }).click();
  await expect(page.locator('[data-product-update-plan]')).toBeHidden();
  expect(await page.evaluate(() => Object.values(localStorage).some(value => /raw-product|GTP03/.test(value)))).toBe(false);
  expect(unexpectedRequests).toEqual([]);
  expect(browserErrors).toEqual([]);
});
