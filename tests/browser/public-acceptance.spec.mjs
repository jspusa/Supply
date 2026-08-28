import { expect, test } from '@playwright/test';

import {
  SANITIZED_H10_TEXT,
  createSanitizedSupplyFixture,
} from '../fixtures/sanitized-supply-browser.mjs';
import {
  asInputFiles,
  buildThreeGroupOrderScenario,
  downloadAndAssertOrderWorkbook,
  exerciseWorkspaceNavigationAndLayout,
  expectFixturePlanning,
  expectOnlyWorkspace,
  freezeBrowserTime,
  installOfflineAssetRoutes,
  monitorBrowserErrors,
  readOrderDraft,
  readWorkspaceSnapshot,
  visibleProductOrder,
  waitForSupplyApp,
} from './browser-helpers.mjs';

async function waitForPublicSnapshot(page, predicate) {
  await expect.poll(async () => {
    const snapshot = await readWorkspaceSnapshot(page);
    return snapshot && predicate(snapshot) ? snapshot : null;
  }, { timeout:8_000 }).not.toBeNull();
}

test('public sanitized data flows through planning, shared navigation, three groups, persistence, XLSX, replacement, and Clear', async ({ page, context }) => {
  await freezeBrowserTime(page);
  const fixture = createSanitizedSupplyFixture();
  const unexpectedRequests = [];
  await installOfflineAssetRoutes(context, unexpectedRequests);
  const browserErrors = monitorBrowserErrors(page);

  await page.goto('/#data');
  await waitForSupplyApp(page);
  await expectOnlyWorkspace(page, 'data');
  await page.locator('#masterFileInput').setInputFiles(asInputFiles(fixture.masterFiles));
  await expect(page.locator('#masterMetaBox')).toContainText('sanitized-jam.xlsx');
  await expect(page.locator('#masterMetaBox')).toContainText('sanitized-h10-inventory.xlsx');
  await expect(page.locator('#masterMetaBox')).toContainText('sanitized-jsp-inventory.xlsx');
  await page.locator('#inputH10').fill(SANITIZED_H10_TEXT);
  await page.locator('#btnBuild').click();
  await expect(page.locator('#todaySourceReadiness')).toHaveText('3 / 3');
  await expect(page.locator('#countReorder')).toHaveText('5');
  await expectFixturePlanning(page);
  await waitForPublicSnapshot(page, snapshot => snapshot.inputs.h10Paste === SANITIZED_H10_TEXT && snapshot.sources.length === 3);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('supply-velocity-history-v1')), { timeout:8_000 }).not.toBeNull();

  await page.locator('.workspaceNavTab[data-workspace="analysis"]').click();
  await page.locator('#otherToolsDetails > summary').click();
  await page.locator('.toolTab[data-panel="suggestedDiscontinuedPanel"]').click();
  await expect(page.locator('#suggestedDiscontinuedCount')).toHaveText('10');
  await expect(page.locator('#suggestedDiscontinuedWrap tbody tr')).toHaveCount(10);
  const ttsSuggestion = page.locator('#suggestedDiscontinuedWrap tbody tr').filter({ hasText:'TTS05AM-1' });
  await expect(ttsSuggestion).toHaveCount(1);
  await expect(ttsSuggestion).toContainText('420 天');
  await expect(page.locator('#suggestedDiscontinuedWrap')).not.toContainText('EZD011AM');

  await exerciseWorkspaceNavigationAndLayout(page);
  const draftBeforeRefresh = await buildThreeGroupOrderScenario(page);
  await downloadAndAssertOrderWorkbook(page);
  const historyBeforeRefresh = await page.evaluate(() => localStorage.getItem('supply-velocity-history-v1'));
  await expect.poll(() => page.evaluate(() => {
    const value = localStorage.getItem('supply-workspace-preferences-v1');
    return value ? JSON.parse(value).activeWorkspace : null;
  }), { timeout:8_000 }).toBe('orders');

  await page.reload();
  await waitForSupplyApp(page);
  const restoredSnapshotState = page.locator('#workspaceSnapshotState');
  await expect(restoredSnapshotState).toHaveAttribute('data-state', 'ready');
  await expect(restoredSnapshotState).toHaveText(/^已從本機還原 Workspace Snapshot · 2026\/8\/28.*下午4:30:00；檔案選擇欄保持空白。$/);
  const restoredUpdatedAt = Date.parse((await readWorkspaceSnapshot(page)).updatedAt);
  expect(restoredUpdatedAt).toBeGreaterThanOrEqual(Date.parse('2026-08-28T08:30:00.000Z'));
  expect(restoredUpdatedAt).toBeLessThan(Date.parse('2026-08-28T08:30:01.000Z'));
  await expect(page.locator('#jamMetaBox')).toContainText('已從本機還原：sanitized-jam.xlsx；基於瀏覽器安全限制，檔案選擇欄保持空白。');
  await expect(page.locator('#amzMetaBox')).toContainText('已從本機還原：sanitized-h10-inventory.xlsx；基於瀏覽器安全限制，檔案選擇欄保持空白。');
  await expect(page.locator('#jspMetaBox')).toContainText('已從本機還原：sanitized-jsp-inventory.xlsx；基於瀏覽器安全限制，檔案選擇欄保持空白。');
  await expectOnlyWorkspace(page, 'orders');
  for (const input of await page.locator('input[type="file"]').all()) await expect(input).toHaveValue('');
  expect(await readOrderDraft(page)).toEqual(draftBeforeRefresh);
  expect(await page.evaluate(() => localStorage.getItem('supply-velocity-history-v1'))).toBe(historyBeforeRefresh);
  await page.locator('input[name="orderGroupSelect"][value="subcontract"]').check();
  await expect.poll(() => visibleProductOrder(page)).toEqual(['VTB01-4', 'TTS05AM-1', 'GTSL01']);
  expect(draftBeforeRefresh.rowsByProductSku.GTSL01.pallet).toMatchObject({ mode:'manual', authoritativeField:'pallets' });
  expect(draftBeforeRefresh.rowsByProductSku['TTS05AM-1'].pallet).toMatchObject({ mode:'derived', authoritativeField:'quantity' });

  await page.locator('.workspaceNavTab[data-workspace="data"]').click();
  await page.locator('#jspInventoryInput').setInputFiles(asInputFiles([fixture.replacementJsp]));
  await expect(page.locator('#jspMetaBox')).toContainText('sanitized-jsp-replacement.xlsx');
  await expectFixturePlanning(page, { replacementJsp:true });
  await waitForPublicSnapshot(page, snapshot => {
    const names = Object.fromEntries(snapshot.sources.map(source => [source.role, source.name]));
    return names.openOrders === 'sanitized-jam.xlsx'
      && names.amazonInventory === 'sanitized-h10-inventory.xlsx'
      && names.jspInventory === 'sanitized-jsp-replacement.xlsx';
  });

  await page.reload();
  await waitForSupplyApp(page);
  await expect(page.locator('#workspaceSnapshotState')).toContainText('已從本機還原');
  await expect(page.locator('#jamMetaBox')).toContainText('sanitized-jam.xlsx');
  await expect(page.locator('#amzMetaBox')).toContainText('sanitized-h10-inventory.xlsx');
  await expect(page.locator('#jspMetaBox')).toContainText('sanitized-jsp-replacement.xlsx');
  await expectFixturePlanning(page, { replacementJsp:true });
  expect(await page.evaluate(() => localStorage.getItem('supply-velocity-history-v1'))).toBe(historyBeforeRefresh);
  expect(await readOrderDraft(page)).toEqual(draftBeforeRefresh);
  for (const input of await page.locator('input[type="file"]').all()) await expect(input).toHaveValue('');

  await page.locator('.workspaceNavTab[data-workspace="data"]').click();
  page.once('dialog', dialog => dialog.dismiss());
  await page.locator('#btnClearAll').click();
  expect((await readOrderDraft(page)).groupOrder.subcontract).toHaveLength(3);
  expect(await page.locator('#inputH10').inputValue()).toBe(SANITIZED_H10_TEXT);

  page.once('dialog', dialog => dialog.accept());
  await page.locator('#btnClearAll').click();
  await expect(page.locator('#workspaceSnapshotState')).toContainText('已清除這個瀏覽器');
  await expect(page).toHaveURL(/#data$/);
  await expectOnlyWorkspace(page, 'data');
  expect(await readWorkspaceSnapshot(page)).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem('supply-velocity-history-v1'))).toBeNull();
  const clearedDraft = await readOrderDraft(page);
  expect(clearedDraft === null || Object.keys(clearedDraft.rowsByProductSku || {}).length === 0).toBe(true);
  expect(await page.locator('#inputH10').inputValue()).toBe('');

  await page.goto('/');
  await waitForSupplyApp(page);
  await expect(page).toHaveURL(/#data$/);
  await expectOnlyWorkspace(page, 'data');
  await expect(page.locator('#workspaceSnapshotState')).toContainText('尚無 Workspace Snapshot');
  await expect(page.locator('#todaySourceReadiness')).toHaveText('0 / 3');
  expect(await readWorkspaceSnapshot(page)).toBeNull();
  for (const input of await page.locator('input[type="file"]').all()) await expect(input).toHaveValue('');

  expect(unexpectedRequests).toEqual([]);
  expect(browserErrors).toEqual([]);
});
