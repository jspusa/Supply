import { expect, test } from '@playwright/test';

import {
  BOSS_FIXTURE_TOKEN,
  SANITIZED_H10_TEXT,
  SANITIZED_PRODUCTS,
  createSanitizedSupplyFixture,
} from '../fixtures/sanitized-supply-browser.mjs';
import {
  asInputFiles,
  buildThreeGroupOrderScenario,
  createBossCloudMock,
  downloadAndAssertOrderWorkbook,
  exerciseWorkspaceNavigationAndLayout,
  expectFixturePlanning,
  expectOnlyWorkspace,
  freezeBrowserTime,
  installOfflineAssetRoutes,
  monitorBrowserErrors,
  readOrderDraft,
  visibleProductOrder,
  waitForSupplyApp,
} from './browser-helpers.mjs';

async function readBossSourceState(page) {
  return page.evaluate(productSkus => ({
    readiness:document.getElementById('todaySourceReadiness')?.textContent?.trim() || '',
    inputs:Object.fromEntries(['inputH10', 'inputOrders', 'inputUSAmz', 'inputUSJsp', 'salesInput', 'bossH10RawInput']
      .map(id => [id, document.getElementById(id)?.value ?? null])),
    metadata:Object.fromEntries(['masterMetaBox', 'jamMetaBox', 'amzMetaBox', 'jspMetaBox']
      .map(id => [id, document.getElementById(id)?.textContent?.trim() || ''])),
    sourceMaps:{
      jamBreakdown:window.latestJamBreakdownMap?.size ?? null,
      jamSummary:window.latestJamSummaryMap?.size ?? null,
      amazonRows:typeof latestAmzInventoryRows === 'undefined' ? null : latestAmzInventoryRows.length,
    },
    fixtureRows:Object.fromEntries(productSkus.map(productSku => {
      const row = (window.mainRowsAll || []).find(item => item.sku === productSku);
      return [productSku, {
        order:Number(row?.order) || 0, orderRaw:Number(row?.orderRaw) || 0,
        amazon:Number(row?.usAmz) || 0, amazonInbound:Number(row?.usAmzInbound) || 0,
        jsp:Number(row?.usJsp) || 0, jspRaw:Number(row?.usJspRaw) || 0,
        jamOrders:String(row?.jamOrders || ''), jamLoadingDates:String(row?.jamLoadingDates || ''),
        jamArrivalDates:String(row?.jamArrivalDates || ''),
      }];
    })),
  }), SANITIZED_PRODUCTS.map(product => product.productSku));
}

function expectNoFixtureSourceState(state) {
  expect(state.readiness).toBe('0 / 3');
  expect(state.inputs).toEqual({
    inputH10:'', inputOrders:'', inputUSAmz:'', inputUSJsp:'', salesInput:'', bossH10RawInput:'',
  });
  expect(state.metadata.masterMetaBox).toContain('尚未使用總檔案上傳');
  expect(state.metadata.jamMetaBox).toContain('尚未讀取 JAM');
  expect(state.metadata.amzMetaBox).toContain('尚未讀取 H10');
  expect(state.metadata.jspMetaBox).toContain('尚未讀取 JSP');
  expect(state.sourceMaps).toEqual({ jamBreakdown:0, jamSummary:0, amazonRows:0 });
  for (const [productSku, row] of Object.entries(state.fixtureRows)) {
    expect(row, `${productSku} must not retain fixture inventory or order sources`).toEqual({
      order:0, orderRaw:0, amazon:0, amazonInbound:0, jsp:0, jspRaw:0,
      jamOrders:'', jamLoadingDates:'', jamArrivalDates:'',
    });
  }
}

function expectUploadedFiles(actualFiles, expectedFiles) {
  expect(actualFiles.map(file => file.name).sort()).toEqual(expectedFiles.map(file => file.name).sort());
  const actualByName = new Map(actualFiles.map(file => [file.name, file]));
  for (const expectedFile of expectedFiles) {
    const actual = actualByName.get(expectedFile.name);
    expect(actual, `uploaded file ${expectedFile.name}`).toBeTruthy();
    expect(actual.mimeType).toBe(expectedFile.mimeType);
    expect(Buffer.compare(actual.buffer, expectedFile.buffer), `${expectedFile.name} bytes`).toBe(0);
  }
}

test('Boss matches the public scenario while mocked auth/cloud persists exact multipart state and Clear preserves auth', async ({ page, context }) => {
  await freezeBrowserTime(page);
  const fixture = createSanitizedSupplyFixture();
  const unexpectedRequests = [];
  await installOfflineAssetRoutes(context, unexpectedRequests);
  const cloud = createBossCloudMock(fixture);
  await cloud.install(context);
  const browserErrors = monitorBrowserErrors(page);

  await page.goto('/Boss/#today');
  await waitForSupplyApp(page);
  await expect(page).toHaveURL(/#recommendations$/);
  await expect(page.locator('#bossAuthGate')).toBeVisible();
  await page.locator('#bossLoginUsername').fill('fixture-user');
  await page.locator('#bossLoginPassword').fill('fixture-password');
  await page.locator('#bossLoginButton').click();
  await expect(page.locator('#bossAuthGate')).toBeHidden();
  await expect(page.locator('#todaySourceReadiness')).toHaveText('3 / 3');
  await expect(page.locator('#bossSaveState')).toContainText('已從雲端載入');
  await expectFixturePlanning(page);
  await expectOnlyWorkspace(page, 'recommendations');
  expect(cloud.calls.login).toBe(1);
  expect(cloud.calls.get).toBe(1);
  expect(cloud.calls.files).toBe(4);
  expect(await page.evaluate(() => sessionStorage.getItem('supply-boss-session'))).toBe(BOSS_FIXTURE_TOKEN);
  for (const input of await page.locator('input[type="file"]').all()) await expect(input).toHaveValue('');

  await exerciseWorkspaceNavigationAndLayout(page);
  const scenarioDraft = await buildThreeGroupOrderScenario(page);
  await downloadAndAssertOrderWorkbook(page);
  expect(scenarioDraft.rowsByProductSku.GTSL01.pallet).toMatchObject({ mode:'manual', authoritativeField:'pallets' });
  expect(scenarioDraft.rowsByProductSku['TTS05AM-1'].pallet).toMatchObject({ mode:'derived', authoritativeField:'quantity' });

  await page.locator('.workspaceNavTab[data-workspace="data"]').click();
  await expect(page.locator('#bossH10RawInput')).toHaveValue(SANITIZED_H10_TEXT);
  await page.locator('#masterFileInput').setInputFiles(asInputFiles(fixture.masterFiles));
  await expect.poll(() => cloud.calls.post, { timeout:10_000 }).toBe(1);
  await expect(page.locator('#bossSaveState')).toContainText('已同步至雲端');
  await expect(page.locator('#masterFileInput')).toHaveValue('');
  await expectFixturePlanning(page);
  expectUploadedFiles(cloud.postSnapshots[0], fixture.cloudFiles);

  await page.locator('#masterFileInput').setInputFiles(asInputFiles(fixture.replacementMasterFiles));
  await expect.poll(() => cloud.calls.post, { timeout:10_000 }).toBe(2);
  await expect(page.locator('#bossSaveState')).toContainText('已同步至雲端');
  await expect(page.locator('#masterFileInput')).toHaveValue('');
  await expectFixturePlanning(page, { replacementJsp:true });
  const replacementCloudFiles = [fixture.jam, fixture.h10Inventory, fixture.replacementJsp, fixture.h10Text];
  expectUploadedFiles(cloud.postSnapshots[1], replacementCloudFiles);
  expectUploadedFiles(Array.from(cloud.files.values()), replacementCloudFiles);
  expect(cloud.files.has(fixture.jsp.name)).toBe(false);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('supply-velocity-history-v1')), { timeout:8_000 }).not.toBeNull();
  const historyBeforeRefresh = await page.evaluate(() => localStorage.getItem('supply-velocity-history-v1'));
  const draftBeforeRefresh = await readOrderDraft(page);
  expect(draftBeforeRefresh).toEqual(scenarioDraft);

  await page.reload();
  await waitForSupplyApp(page);
  await expect(page.locator('#bossAuthGate')).toBeHidden();
  await expect(page.locator('#bossSaveState')).toContainText('已從雲端載入');
  await expect(page.locator('#jspMetaBox')).toContainText('sanitized-jsp-replacement.xlsx');
  await expectFixturePlanning(page, { replacementJsp:true });
  await expectOnlyWorkspace(page, 'data');
  expect(await page.evaluate(() => localStorage.getItem('supply-velocity-history-v1'))).toBe(historyBeforeRefresh);
  expect(await readOrderDraft(page)).toEqual(draftBeforeRefresh);
  expect(await page.evaluate(() => sessionStorage.getItem('supply-boss-session'))).toBe(BOSS_FIXTURE_TOKEN);
  expect(cloud.calls.get).toBe(2);
  for (const input of await page.locator('input[type="file"]').all()) await expect(input).toHaveValue('');
  await page.locator('.workspaceNavTab[data-workspace="orders"]').click();
  await page.locator('input[name="orderGroupSelect"][value="subcontract"]').check();
  await expect.poll(() => visibleProductOrder(page)).toEqual(['VTB01-4', 'TTS05AM-1', 'GTSL01']);

  await page.locator('.workspaceNavTab[data-workspace="data"]').click();
  const uploadCard = page.locator('#uploadCard');
  if (!(await uploadCard.getAttribute('open'))) await uploadCard.locator(':scope > summary').click();
  const clearButton = page.locator('#bossDeleteSnapshot');
  await expect(clearButton).toBeVisible();
  await expect(clearButton).toBeEnabled();
  page.once('dialog', dialog => dialog.dismiss());
  await clearButton.click();
  expect(cloud.calls.delete).toBe(0);
  expect(await page.locator('#inputH10').inputValue()).toBe(SANITIZED_H10_TEXT);
  expect(await readOrderDraft(page)).toEqual(draftBeforeRefresh);
  expect(await page.evaluate(() => localStorage.getItem('supply-velocity-history-v1'))).toBe(historyBeforeRefresh);
  expect(await page.evaluate(() => sessionStorage.getItem('supply-boss-session'))).toBe(BOSS_FIXTURE_TOKEN);

  page.once('dialog', dialog => dialog.accept());
  await clearButton.click();
  await expect.poll(() => cloud.calls.delete).toBe(1);
  await expect(page.locator('#bossSaveState')).toHaveText('已清除雲端與這個瀏覽器的工作區資料。');
  await expect(page).toHaveURL(/#data$/);
  await expectOnlyWorkspace(page, 'data');
  expectNoFixtureSourceState(await readBossSourceState(page));
  for (const key of ['supply-order-draft-v2', 'supply-generator-drafts-v1', 'supply-velocity-history-v1', 'supply-workspace-preferences-v1']) {
    expect(await page.evaluate(storageKey => localStorage.getItem(storageKey), key)).toBeNull();
  }
  for (const input of await page.locator('input[type="file"]').all()) await expect(input).toHaveValue('');
  expect(await page.evaluate(() => sessionStorage.getItem('supply-boss-session'))).toBe(BOSS_FIXTURE_TOKEN);

  expect(browserErrors).toEqual([]);
  const errorsBeforeExpectedMissingSnapshot = browserErrors.length;
  await page.reload();
  await waitForSupplyApp(page);
  await expect(page).toHaveURL(/#data$/);
  await expect(page.locator('#bossAuthGate')).toBeHidden();
  await expectOnlyWorkspace(page, 'data');
  await expect(page.locator('#bossSaveState')).toContainText('雲端目前沒有資料');
  expectNoFixtureSourceState(await readBossSourceState(page));
  for (const key of ['supply-order-draft-v2', 'supply-generator-drafts-v1', 'supply-velocity-history-v1', 'supply-workspace-preferences-v1']) {
    expect(await page.evaluate(storageKey => localStorage.getItem(storageKey), key)).toBeNull();
  }
  for (const input of await page.locator('input[type="file"]').all()) await expect(input).toHaveValue('');
  expect(await page.evaluate(() => sessionStorage.getItem('supply-boss-session'))).toBe(BOSS_FIXTURE_TOKEN);
  expect(cloud.calls.get).toBe(3);
  expect(cloud.deleted).toBe(true);

  expect(cloud.authorizationFailures).toEqual([]);
  expect(cloud.unexpected).toEqual([]);
  expect(unexpectedRequests).toEqual([]);
  expect(browserErrors.slice(errorsBeforeExpectedMissingSnapshot)).toEqual([
    'console: Failed to load resource: the server responded with a status of 404 (Not Found)',
  ]);
});
