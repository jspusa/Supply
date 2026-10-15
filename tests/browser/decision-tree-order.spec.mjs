import { expect, test } from '@playwright/test';
import { BOSS_FIXTURE_TOKEN } from '../fixtures/sanitized-supply-browser.mjs';
import {
  createBossCloudMock,
  expectOnlyWorkspace,
  freezeBrowserTime,
  installOfflineAssetRoutes,
  monitorBrowserErrors,
  readOrderDraft,
  waitForSupplyApp,
} from './browser-helpers.mjs';

async function waitForReady(page, pathname) {
  await waitForSupplyApp(page);
  if (pathname === '/Boss/') {
    await expect(page.locator('#bossAuthGate')).toBeHidden();
    await expect(page.locator('#bossLoadingMask')).toBeHidden();
  }
}

async function start(page, context, pathname) {
  await freezeBrowserTime(page);
  await installOfflineAssetRoutes(context);
  const errors = monitorBrowserErrors(page);
  if (pathname === '/Boss/') {
    await createBossCloudMock({ cloudFiles:[] }).install(context);
    await page.addInitScript(token => sessionStorage.setItem('supply-boss-session', token), BOSS_FIXTURE_TOKEN);
  }
  await page.goto(`${pathname}#sku-tree`);
  await waitForReady(page, pathname);
  await expectOnlyWorkspace(page, 'sku-tree');
  return errors;
}

async function renderManualCards(page, skus) {
  await page.locator('.workspaceNavTab[data-workspace="sku-tree"]').click();
  await page.locator('#skuTreeAlertsOnly').uncheck();
  await page.locator('#skuTreeInput').fill(skus.join('\n'));
  await page.locator('#btnRenderSkuTree').click();
}

function manualCard(page, sku) {
  return page.locator(`#skuDecisionTreeBox [data-sku-tree-card="${sku}"]`);
}

function draftRow(page, sku) {
  return page.locator(`#productTable tbody tr[data-product="${sku}"]`);
}

async function addFromCard(page, card) {
  const actions = card.locator('.skuTreeOrderActions');
  const add = actions.locator('[data-add-tree-sku]');
  await expect(add).toHaveText('加入訂單');
  await add.click();
  await expect(page).toHaveURL(/#sku-tree$/);
  await expectOnlyWorkspace(page, 'sku-tree');
  await expect(actions.locator('.skuTreeOrderStatus')).toHaveAttribute('role', 'status');
  await expect(actions.locator('.skuTreeOrderStatus')).not.toBeEmpty();
  await expect(actions.locator('[data-view-tree-order]')).toBeVisible();
}

async function viewFromCard(page, card, productSku, group, { locked = false } = {}) {
  const view = card.locator('[data-view-tree-order]');
  await expect(view).toHaveText('查看訂單');
  await view.click();
  await expect(page).toHaveURL(/#orders$/);
  await expectOnlyWorkspace(page, 'orders');
  await expect(page.locator(`input[name="orderGroupSelect"][value="${group}"]`)).toBeChecked();
  const row = draftRow(page, productSku);
  await expect(row).toBeVisible();
  if (locked) {
    await expect(row.locator('.edit-quantity-input')).toBeDisabled();
    await expect(row.locator('button:not(:disabled)').first()).toBeFocused();
  } else {
    await expect(row.locator('.edit-quantity-input')).toBeFocused();
  }
  return row;
}

function editableState(row) {
  return {
    orderSku:row.orderSku,
    orderGroup:row.orderGroup,
    quantities:row.quantities,
    pallet:row.pallet,
    locked:row.locked,
    packagingAssignment:row.packagingAssignment,
  };
}

for (const pathname of ['/', '/Boss/']) {
  test(`${pathname} decision cards add blank order rows, retain aliases and locked edits, and open the correct order group`, async ({ page, context }) => {
    const errors = await start(page, context, pathname);
    await renderManualCards(page, ['EZD011AM', '7GTPD013AB', 'GTP01']);
    const taiwanCard = manualCard(page, 'EZD011AM');
    const aliasCard = manualCard(page, '7GTPD013AB');
    const canonicalCard = manualCard(page, 'GTP01');
    await expect(taiwanCard.locator('[data-view-tree-order]')).toBeHidden();
    await expect(aliasCard.locator('[data-view-tree-order]')).toBeHidden();

    await addFromCard(page, taiwanCard);
    await addFromCard(page, aliasCard);
    const initial = await readOrderDraft(page);
    expect(Object.keys(initial.rowsByProductSku).sort()).toEqual(['EZD011AM', 'GTP01']);
    expect(initial.rowsByProductSku.EZD011AM.orderGroup).toBe('taiwan');
    expect(initial.rowsByProductSku.GTP01.orderGroup).toBe('subcontract');
    expect(initial.rowsByProductSku.GTP01.orderSku).toBe('7GTPD013AB');
    for (const row of Object.values(initial.rowsByProductSku)) {
      expect(row.quantities.packages).toBe('');
      expect(row.quantities.secondary).toBe('');
      expect(row.quantities.cartons).toBe('');
    }

    const taiwanRow = await viewFromCard(page, taiwanCard, 'EZD011AM', 'taiwan');
    await taiwanRow.locator('.edit-quantity-input').fill('120');
    await page.locator('.workspaceNavTab[data-workspace="sku-tree"]').click();
    const aliasRow = await viewFromCard(page, aliasCard, 'GTP01', 'subcontract');
    await aliasRow.locator('.edit-quantity-input').fill('240');
    await aliasRow.locator('.lock-button').click();
    const locked = editableState((await readOrderDraft(page)).rowsByProductSku.GTP01);
    expect(locked.locked).toBe(true);
    expect(locked.packagingAssignment.state).toBe('pinned');
    expect(locked.quantities.packages).toBe(240);

    await page.locator('.workspaceNavTab[data-workspace="sku-tree"]').click();
    // Both names identify the same existing row; neither may replace its Order SKU or edits.
    await addFromCard(page, canonicalCard);
    await addFromCard(page, aliasCard);
    await expect(aliasCard.locator('.skuTreeOrderStatus')).toContainText('保留原數量');
    const duplicate = await readOrderDraft(page);
    expect(Object.keys(duplicate.rowsByProductSku).sort()).toEqual(['EZD011AM', 'GTP01']);
    expect(editableState(duplicate.rowsByProductSku.GTP01)).toEqual(locked);
    await viewFromCard(page, canonicalCard, 'GTP01', 'subcontract', { locked:true });

    await page.reload();
    await waitForReady(page, pathname);
    const restored = await readOrderDraft(page);
    expect(Object.keys(restored.rowsByProductSku).sort()).toEqual(['EZD011AM', 'GTP01']);
    expect(restored.rowsByProductSku.EZD011AM.quantities.packages).toBe(120);
    expect(editableState(restored.rowsByProductSku.GTP01)).toEqual(locked);
    await renderManualCards(page, ['GTP01']);
    await viewFromCard(page, canonicalCard, 'GTP01', 'subcontract', { locked:true });
    expect(errors).toEqual([]);
  });

  test(`${pathname} decision cards permit special manual orders and disable discontinued or unknown products`, async ({ page, context }) => {
    const errors = await start(page, context, pathname);
    await renderManualCards(page, ['AFML01', 'TRPL03', 'UNKNOWN-TREE-999']);
    const special = manualCard(page, 'AFML01');
    for (const sku of ['TRPL03', 'UNKNOWN-TREE-999']) {
      const card = manualCard(page, sku);
      await expect(card.locator('[data-add-tree-sku]')).toBeDisabled();
      await expect(card.locator('[data-view-tree-order]')).toBeHidden();
      await expect(card.locator('.skuTreeOrderStatus')).not.toBeEmpty();
    }
    await addFromCard(page, special);
    const draft = await readOrderDraft(page);
    expect(Object.keys(draft.rowsByProductSku)).toEqual(['AFML01']);
    expect(draft.rowsByProductSku.AFML01.quantities.packages).toBe('');
    expect(errors).toEqual([]);
  });

  test(`${pathname} automatic missing-order cards use the same add and view actions without duplicate rows`, async ({ page, context }) => {
    const errors = await start(page, context, pathname);
    // Seed real parser inputs: Boss intentionally hides these backup textareas.
    // Draft changes below are made exclusively through the card's visible buttons.
    await page.evaluate(() => {
      document.getElementById('inputH10').value = 'B000000005 EZD011AM 2';
      document.getElementById('inputOrders').value = 'EZD011AM\t0';
      document.getElementById('inputUSAmz').value = 'EZD011AM\t0\t0';
      document.getElementById('inputUSJsp').value = 'EZD011AM\t0';
      buildTables();
    });
    const autoDetails = page.locator('#autoDecisionTreeCard');
    if (!(await autoDetails.evaluate(element => element.open))) {
      await autoDetails.locator(':scope > summary').click();
    }
    const autoCard = page.locator('#autoDecisionTreeBox [data-sku-tree-card="EZD011AM"]');
    await expect(autoCard).toBeVisible();
    await expect(autoCard.locator('[data-view-tree-order]')).toBeHidden();
    await addFromCard(page, autoCard);
    await addFromCard(page, autoCard);
    const draft = await readOrderDraft(page);
    expect(Object.keys(draft.rowsByProductSku)).toEqual(['EZD011AM']);
    expect(draft.rowsByProductSku.EZD011AM.quantities.packages).toBe('');
    await viewFromCard(page, autoCard, 'EZD011AM', 'taiwan');
    expect(errors).toEqual([]);
  });
}
