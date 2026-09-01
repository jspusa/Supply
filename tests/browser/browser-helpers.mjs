import fs from 'node:fs';
import { expect } from '@playwright/test';
import XLSX from 'xlsx';

import { ORDER_EXPORT_HEADERS } from '../../shared/order-draft-state.js';

import {
  BOSS_FIXTURE_TOKEN,
  FIXTURE_LAST_MODIFIED,
  FIXTURE_UPDATED_AT,
  SANITIZED_PRODUCTS,
} from '../fixtures/sanitized-supply-browser.mjs';

export const TEST_ORIGIN = 'http://127.0.0.1:4173';
export const BOSS_API_ORIGIN = 'https://supply-boss.brave-prawn-0848.chatgpt.site';
export const FIXED_BROWSER_TIME = '2026-08-28T08:30:00.000Z';

export function asInputFiles(files) {
  return files.map(file => ({ name:file.name, mimeType:file.mimeType, buffer:file.buffer }));
}

export async function freezeBrowserTime(page) {
  await page.clock.setFixedTime(new Date(FIXED_BROWSER_TIME));
}

export function monitorBrowserErrors(page) {
  const errors = [];
  page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
  page.on('console', message => {
    if (message.type() === 'error') errors.push(`console: ${message.text()}`);
  });
  return errors;
}

export async function installOfflineAssetRoutes(context, unexpectedRequests = []) {
  await context.route('**/*', async route => {
    const url = route.request().url();
    if (url.startsWith(TEST_ORIGIN) || url.startsWith('data:') || url.startsWith('blob:')) {
      await route.fallback();
      return;
    }
    unexpectedRequests.push(`${route.request().method()} ${url}`);
    await route.abort('blockedbyclient');
  });
  await context.route(`${TEST_ORIGIN}/FBA/catalog-alignment.json`, async route => {
    const local = JSON.parse(fs.readFileSync(new URL('../../catalog-alignment.json', import.meta.url), 'utf8'));
    await route.fulfill({
      status:200,
      contentType:'application/json; charset=utf-8',
      body:JSON.stringify({
        ...local,
        site:'fba',
        publicContentHash:local.expectedPublicContentHashes.fba,
      }),
    });
  });
  await context.route('https://cdnjs.cloudflare.com/ajax/libs/font-awesome/**', route => route.fulfill({
    status:200,
    contentType:'text/css; charset=utf-8',
    body:'/* deterministic offline browser test */',
  }));
}

export function createBossCloudMock(fixture, { fileUrlFor = null } = {}) {
  let deleted = false;
  let updatedAt = FIXTURE_UPDATED_AT;
  let filesByName = new Map(fixture.cloudFiles.map(file => [file.name, {
    name:file.name,
    mimeType:file.mimeType,
    buffer:Buffer.from(file.buffer),
    lastModified:file.lastModified,
  }]));
  const calls = { login:0, session:0, get:0, post:0, delete:0, files:0, preflight:0 };
  const postSnapshots = [];
  const authorizationFailures = [];
  const unexpected = [];
  const manifest = () => ({
    schemaVersion:1,
    updatedAt,
    files:Array.from(filesByName.values(), file => ({
      name:file.name,
      type:file.mimeType,
      size:file.buffer.length,
      lastModified:file.lastModified,
      url:typeof fileUrlFor === 'function'
        ? fileUrlFor(file)
        : `${BOSS_API_ORIGIN}/api/files/${encodeURIComponent(file.name)}`,
    })),
  });
  const corsHeaders = {
    'Access-Control-Allow-Origin':TEST_ORIGIN,
    'Access-Control-Allow-Headers':'authorization, content-type, x-supply-action',
    'Access-Control-Allow-Methods':'GET, POST, DELETE, OPTIONS',
    'Access-Control-Max-Age':'600',
    'Cache-Control':'no-store',
    Vary:'Origin',
  };
  const json = (route, status, body) => route.fulfill({
    status,
    headers:{ ...corsHeaders, 'Content-Type':'application/json; charset=utf-8' },
    body:JSON.stringify(body),
  });

  return {
    calls,
    postSnapshots,
    authorizationFailures,
    unexpected,
    get deleted() { return deleted; },
    get files() { return new Map(Array.from(filesByName, ([name, file]) => [name, { ...file, buffer:Buffer.from(file.buffer) }])); },
    async install(context) {
      await context.route(`${BOSS_API_ORIGIN}/**`, async route => {
        const request = route.request();
        const url = new URL(request.url());
        const method = request.method();
        if (method === 'OPTIONS') {
          calls.preflight += 1;
          await route.fulfill({ status:204, headers:corsHeaders, body:'' });
          return;
        }
        if (url.pathname === '/api/login' && method === 'POST') {
          calls.login += 1;
          const credentials = request.postDataJSON();
          if (credentials?.username !== 'fixture-user' || credentials?.password !== 'fixture-password') {
            await json(route, 401, { error:'fixture credentials rejected' });
            return;
          }
          await json(route, 200, { token:BOSS_FIXTURE_TOKEN });
          return;
        }
        const authorization = request.headers().authorization || '';
        if (authorization !== `Bearer ${BOSS_FIXTURE_TOKEN}`) {
          authorizationFailures.push(`${method} ${url.pathname}: ${authorization || '(missing)'}`);
          await json(route, 401, { error:'fixture authorization required' });
          return;
        }
        if (url.pathname === '/api/session' && method === 'GET') {
          calls.session += 1;
          await json(route, 200, { ok:true, user:'fixture-user' });
          return;
        }
        if (url.pathname === '/api/snapshot' && method === 'GET') {
          calls.get += 1;
          await json(route, deleted ? 404 : 200, deleted ? { error:'fixture snapshot missing' } : manifest());
          return;
        }
        if (url.pathname === '/api/snapshot' && method === 'POST') {
          calls.post += 1;
          const contentType = request.headers()['content-type'] || '';
          const payload = request.postDataBuffer();
          if (!/^multipart\/form-data;\s*boundary=/i.test(contentType) || !payload) {
            await json(route, 400, { error:'fixture requires a multipart snapshot body' });
            return;
          }
          let formData;
          try {
            formData = await new Response(payload, { headers:{ 'Content-Type':contentType } }).formData();
          } catch (error) {
            await json(route, 400, { error:`fixture multipart parse failed: ${error?.message || error}` });
            return;
          }
          const uploaded = formData.getAll('files');
          if (uploaded.length !== 4 || uploaded.some(file => typeof file === 'string' || typeof file?.arrayBuffer !== 'function')) {
            await json(route, 400, { error:'fixture requires exactly four uploaded files' });
            return;
          }
          const nextFiles = new Map();
          for (const file of uploaded) {
            const name = String(file.name || '');
            const buffer = Buffer.from(await file.arrayBuffer());
            if (!name || !buffer.length || nextFiles.has(name)) {
              await json(route, 400, { error:'fixture requires unique non-empty filenames and bytes' });
              return;
            }
            nextFiles.set(name, {
              name,
              mimeType:String(file.type || 'application/octet-stream'),
              buffer,
              lastModified:FIXTURE_LAST_MODIFIED,
            });
          }
          if (!nextFiles.has('Helium10_原始文字.txt')) {
            await json(route, 400, { error:'fixture snapshot is missing the H10 raw text source' });
            return;
          }
          filesByName = nextFiles;
          postSnapshots.push(Array.from(nextFiles.values(), file => ({
            name:file.name,
            mimeType:file.mimeType,
            buffer:Buffer.from(file.buffer),
          })));
          deleted = false;
          updatedAt = new Date(Date.parse(FIXTURE_UPDATED_AT) + calls.post * 1_000).toISOString();
          await json(route, 200, manifest());
          return;
        }
        if (url.pathname === '/api/snapshot' && method === 'DELETE') {
          calls.delete += 1;
          deleted = true;
          filesByName = new Map();
          await json(route, 200, { ok:true });
          return;
        }
        if (url.pathname.startsWith('/api/files/') && method === 'GET') {
          calls.files += 1;
          const name = decodeURIComponent(url.pathname.slice('/api/files/'.length));
          const file = filesByName.get(name);
          if (!file) {
            await json(route, 404, { error:'fixture file missing' });
            return;
          }
          await route.fulfill({
            status:200,
            headers:{ ...corsHeaders, 'Content-Type':file.mimeType },
            body:file.buffer,
          });
          return;
        }
        unexpected.push(`${method} ${url.pathname}`);
        await json(route, 404, { error:'unexpected fixture route' });
      });
    },
  };
}

XLSX.set_fs(fs);

export async function waitForSupplyApp(page) {
  await page.waitForLoadState('domcontentloaded');
  await expect.poll(() => page.evaluate(() => Boolean(
    window.SupplyWorkspaceNavigation?.WORKSPACE_IDS
    && window.SupplyWorkspaceUI?.createWorkspaceUi
    && window.SupplyCoverageIndicator?.renderCoverageMeter
    && window.SupplyOrderDraftState?.ORDER_GROUP_IDS
    && window.SupplyWorkspaceSnapshot?.createWorkspaceSnapshotStore
    && window.XLSX?.utils
    && document.documentElement.dataset.workspaceUiReady === 'true'
  )), { timeout:8_000 }).toBe(true);
}

export async function expectFixturePlanning(page, { replacementJsp = false } = {}) {
  const actual = await page.evaluate(productSkus => Object.fromEntries(productSkus.map(productSku => {
    const row = (window.mainRowsAll || []).find(item => item.sku === productSku);
    return [productSku, row ? {
      planningVelocity:row.planningVelocity,
      order:row.order,
      amazon:row.usAmz,
      jsp:row.usJsp,
    } : null];
  })), SANITIZED_PRODUCTS.map(product => product.productSku));
  for (const product of SANITIZED_PRODUCTS) {
    expect(actual[product.productSku], `${product.productSku} parser/planning result`).toEqual({
      planningVelocity:product.planningVelocity,
      order:product.order,
      amazon:product.amazon,
      jsp:replacementJsp ? product.replacementJsp : product.jsp,
    });
  }
  return actual;
}

export async function readOrderDraft(page) {
  return page.evaluate(() => {
    const key = window.SupplyOrderDraftState?.ORDER_DRAFT_STORAGE_KEY || 'supply-order-draft-v3';
    return JSON.parse(localStorage.getItem(key) || 'null');
  });
}

export async function readWorkspaceSnapshot(page) {
  return page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('supply-workspace-v1', 1);
    request.onerror = () => reject(request.error);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('workspace-snapshots')) database.createObjectStore('workspace-snapshots');
    };
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction('workspace-snapshots', 'readonly');
      const getRequest = transaction.objectStore('workspace-snapshots').get('public-workspace');
      getRequest.onerror = () => reject(getRequest.error);
      getRequest.onsuccess = () => resolve(getRequest.result || null);
      transaction.oncomplete = () => database.close();
    };
  }));
}

export async function expectOnlyWorkspace(page, workspace) {
  await expect(page.locator(`.workspaceNavTab[data-workspace="${workspace}"]`)).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.workspaceNavTab[aria-selected="true"]')).toHaveCount(1);
  const visibleGroups = await page.locator('[data-workspace-panel]').evaluateAll((elements, activeWorkspace) => Array.from(new Set(elements
    .filter(element => !element.hidden && getComputedStyle(element).display !== 'none')
    .map(element => String(element.dataset.workspacePanelAlso || '').split(/\s+/).includes(activeWorkspace) ? activeWorkspace : element.dataset.workspacePanel))), workspace);
  expect(visibleGroups).toEqual([workspace]);
}

export async function switchToSubcontract(page, productSku, expectedOrderSku, { lock = false } = {}) {
  await page.locator('input[name="orderGroupSelect"][value="vietnam"]').check();
  const row = page.locator(`#productTable tbody tr[data-product="${productSku}"]`);
  await expect(row).toBeVisible();
  const quantityBefore = await row.locator('.edit-quantity-input').inputValue();
  if (lock) await row.locator('.lock-button').click();
  const toggle = row.locator('.equivalentOrderToggle');
  await expect(toggle).toContainText(expectedOrderSku);
  let previewMessage = '';
  page.once('dialog', async dialog => {
    previewMessage = dialog.message();
    await dialog.accept();
  });
  await toggle.click();
  expect(previewMessage).toContain('包裝調整預覽');
  expect(previewMessage).toContain('箱數');
  expect(previewMessage).toContain('棧板');
  expect(previewMessage).toContain('到港覆蓋');
  expect(previewMessage).toContain('訂單群組');
  await expect(page.locator('input[name="orderGroupSelect"][value="subcontract"]')).toBeChecked();
  const moved = page.locator(`#productTable tbody tr[data-product="${productSku}"]`);
  await expect(moved.locator('.order-code-label')).toHaveText(expectedOrderSku);
  await expect(moved.locator('.edit-quantity-input')).toHaveValue(quantityBefore);
  if (lock) {
    await expect(moved).toHaveClass(/locked/);
    await expect(moved.locator('.edit-quantity-input')).toBeDisabled();
  }
  return quantityBefore;
}

export async function dragProductBefore(page, productSku, beforeProductSku) {
  const source = page.locator(`#productTable tbody tr[data-product="${productSku}"] .drag-handle`);
  const target = page.locator(`#productTable tbody tr[data-product="${beforeProductSku}"]`);
  await source.scrollIntoViewIfNeeded();
  await target.scrollIntoViewIfNeeded();
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox) throw new Error('Drag source or target is not visible');
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  try {
    await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + 2, { steps:1 });
    await expect.poll(() => page.locator('#productTable tbody tr').evaluateAll((rows, products) => {
      const order = rows.map(row => row.dataset.product);
      return order.indexOf(products.source) + 1 === order.indexOf(products.target);
    }, { source:productSku, target:beforeProductSku }), { timeout:2_000 }).toBe(true);
  } finally {
    await page.mouse.up();
  }
}

export async function visibleProductOrder(page) {
  return page.locator('#productTable tbody tr').evaluateAll(rows => rows.map(row => row.dataset.product));
}

export async function orderDraftGroupCounts(page) {
  const draft = await readOrderDraft(page);
  return Object.fromEntries(Object.entries(draft?.groupOrder || {}).map(([group, rows]) => [group, rows.length]));
}

export async function exerciseWorkspaceNavigationAndLayout(page, { expectEmptyToday = false } = {}) {
  await page.setViewportSize({ width:1280, height:900 });
  await expect(page.locator('.workspaceNavTab')).toHaveCount(5);
  await expect(page.locator('.workspaceNavTab')).toHaveText(['資料', '今日建議', '訂單', 'SKU 決策樹', '資料分析']);
  await page.locator('.workspaceNavTab[data-workspace="recommendations"]').click();
  await expectOnlyWorkspace(page, 'recommendations');
  await expect(page.locator('[data-workspace-panel="today"]')).toHaveCount(0);
  await expect(page.locator('#todayWorkspaceSummary')).toBeVisible();
  await expect(page.locator('#decisionDashboard')).toHaveAttribute('data-workspace-panel', 'recommendations');
  await expect(page.locator('#decisionDashboard')).toBeVisible();
  if (expectEmptyToday) {
    await expect(page.locator('#todaySourceReadiness')).toHaveText('0 / 3');
    await expect(page.locator('#todayNextAction')).toHaveText('開始準備資料');
    await expect(page.locator('#todayNextActionReason')).toHaveText('尚未讀取資料。');
  }
  await expect(page.locator('.appSidebar')).toHaveCount(0);

  for (const workspace of ['data', 'recommendations', 'orders', 'sku-tree', 'analysis']) {
    await page.locator(`.workspaceNavTab[data-workspace="${workspace}"]`).click();
    await expect(page).toHaveURL(new RegExp(`#${workspace}$`));
    await expectOnlyWorkspace(page, workspace);
  }

  const historyBeforeRepeatedClick = await page.evaluate(() => history.length);
  await page.locator('.workspaceNavTab[data-workspace="analysis"]').click();
  await expect.poll(() => page.evaluate(() => history.length)).toBe(historyBeforeRepeatedClick);

  await page.goBack();
  await expect(page).toHaveURL(/#sku-tree$/);
  await expectOnlyWorkspace(page, 'sku-tree');
  await expect(page.locator('#skuDecisionTreeCard')).toBeVisible();
  await expect(page.locator('#autoDecisionTreeCard')).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(/#analysis$/);
  await expectOnlyWorkspace(page, 'analysis');

  await page.evaluate(() => { window.location.hash = '#skuDecisionTreeCard'; });
  await expect(page).toHaveURL(/#sku-tree$/);
  await expectOnlyWorkspace(page, 'sku-tree');
  await expect(page.locator('#skuDecisionTreeCard')).toBeVisible();
  await expect(page.locator('#mainCard')).toBeHidden();

  await page.evaluate(() => { window.location.hash = '#decisionDashboard'; });
  await expect(page).toHaveURL(/#recommendations$/);
  await expectOnlyWorkspace(page, 'recommendations');

  await page.evaluate(() => { window.location.hash = '#today'; });
  await expect(page).toHaveURL(/#recommendations$/);
  await expectOnlyWorkspace(page, 'recommendations');
  await expect(page.locator('#todayWorkspaceSummary')).toBeVisible();
  await expect(page.locator('#decisionDashboard')).toBeVisible();

  const desktopLayout = await page.evaluate(() => ({
    viewport:document.documentElement.clientWidth,
    pageWidth:document.documentElement.scrollWidth,
    tables:Array.from(document.querySelectorAll('.tableWrap, .order-generator .table-responsive')).map(element => {
      const style = getComputedStyle(element);
      return { overflowX:style.overflowX, maxHeight:style.maxHeight };
    }),
  }));
  expect(desktopLayout.pageWidth).toBeLessThanOrEqual(desktopLayout.viewport);
  expect(desktopLayout.tables.length).toBeGreaterThan(3);
  for (const table of desktopLayout.tables) {
    expect(['auto', 'scroll']).toContain(table.overflowX);
    expect(table.maxHeight).not.toBe('none');
  }

  const targetDays = page.locator('#daysThreshold');
  const originalTargetDays = await targetDays.inputValue();
  await expect(targetDays).toHaveAttribute('step', '1');
  await expect(targetDays).toHaveAttribute('max', '365');
  await targetDays.fill('999');
  await targetDays.press('Tab');
  await expect(targetDays).toHaveValue('365');
  await targetDays.fill('0');
  await targetDays.press('Tab');
  await expect(targetDays).toHaveValue('1');
  await targetDays.fill(originalTargetDays);
  await targetDays.press('Tab');

  await page.setViewportSize({ width:390, height:844 });
  const mobileLayout = await page.evaluate(() => ({
    viewport:document.documentElement.clientWidth,
    pageWidth:document.documentElement.scrollWidth,
    navClient:document.querySelector('.workspaceNavTabs')?.clientWidth || 0,
    navScroll:document.querySelector('.workspaceNavTabs')?.scrollWidth || 0,
  }));
  expect(mobileLayout.pageWidth).toBeLessThanOrEqual(mobileLayout.viewport);
  expect(mobileLayout.navScroll).toBeGreaterThanOrEqual(mobileLayout.navClient);
  await page.setViewportSize({ width:1280, height:900 });
}

async function expectCoverageMeter(cell, {
  band,
  valueText,
  statusText,
  ariaNow,
  fillColor,
}) {
  const indicator = cell.locator('.coverageMeter');
  await expect(indicator).toHaveCount(1);
  await expect(indicator).toHaveClass(new RegExp(`coverageMeter--${band}`));
  await expect(indicator).toHaveAttribute('data-band', band);
  await expect(indicator).toHaveAttribute('data-assessment', 'ready');
  const value = indicator.locator('.coverageMeter__value');
  const status = indicator.locator('.coverageMeter__status');
  await expect(value).toHaveText(valueText);
  await expect(status).toHaveText(statusText);
  const actualValueText = (await value.textContent())?.trim();
  const track = indicator.getByRole('meter', { name:'可售天數' });
  await expect(track).toHaveAttribute('aria-valuemin', '0');
  await expect(track).toHaveAttribute('aria-valuemax', '365');
  await expect(track).toHaveAttribute('aria-valuenow', String(ariaNow));
  await expect(track).toHaveAttribute('aria-valuetext', `${actualValueText}，${statusText}`);

  const fillStyle = await indicator.locator('.coverageMeter__fill').evaluate(element => {
    const style = getComputedStyle(element);
    return { backgroundColor:style.backgroundColor, backgroundImage:style.backgroundImage };
  });
  const expectedAccent = {
    yellow:'rgba(255, 204, 0, 0.68)',
    green:'rgba(0, 190, 75, 0.68)',
    red:'rgba(255, 45, 45, 0.68)',
  }[fillColor];
  expect(expectedAccent).toBeTruthy();
  expect(fillStyle.backgroundColor).toBe('rgba(0, 0, 0, 0)');
  expect(fillStyle.backgroundImage).toContain(expectedAccent);
  expect(fillStyle.backgroundImage).toContain('0.54');
  expect(fillStyle.backgroundImage).toContain('0.64');
  expect(fillStyle.backgroundImage).not.toContain('repeating');
}

export async function buildThreeGroupOrderScenario(page) {
  await page.setViewportSize({ width:1280, height:900 });
  await page.locator('.workspaceNavTab[data-workspace="recommendations"]').click();
  await expectOnlyWorkspace(page, 'recommendations');
  await expect(page.locator('#reorderTableWrap tbody tr')).toHaveCount(5);
  const ttsRecommendation = page.locator('#reorderTableWrap tbody tr', { hasText:'TTS05AM-1' });
  await expect(ttsRecommendation).toContainText('Planning 10');
  await expect(ttsRecommendation).toContainText('不代表已證實斷貨');
  await page.locator('#btnAddReorderToGenerator').click();
  await expect.poll(() => orderDraftGroupCounts(page)).toEqual({ taiwan:1, vietnam:4, subcontract:0 });

  await page.locator('.workspaceNavTab[data-workspace="orders"]').click();
  await expectOnlyWorkspace(page, 'orders');
  await switchToSubcontract(page, 'TTS05AM-1', '7ATSD010AB', { lock:true });
  await switchToSubcontract(page, 'GTSL01', '7GTSD017AB');
  await switchToSubcontract(page, 'VTB01-4', '7VTBD410AB');
  await expect.poll(() => orderDraftGroupCounts(page)).toEqual({ taiwan:1, vietnam:1, subcontract:3 });
  await expect(page.locator('#todayOrderGroupCounts')).toHaveText('越南 1 · 台灣 1 · 委外 3');

  await dragProductBefore(page, 'VTB01-4', 'TTS05AM-1');
  await expect.poll(() => visibleProductOrder(page)).toEqual(['VTB01-4', 'TTS05AM-1', 'GTSL01']);
  await expect.poll(async () => (await readOrderDraft(page)).groupOrder.subcontract).toEqual(['VTB01-4', 'TTS05AM-1', 'GTSL01']);

  const packedQuantityLayout = await page.locator('#productTable tbody tr[data-product="VTB01-4"] .generatorQuantityGroup').evaluate(element => ({
    direction:getComputedStyle(element).flexDirection,
    labels:Array.from(element.querySelectorAll('label > span'), label => label.textContent.trim()),
  }));
  expect(packedQuantityLayout).toEqual({ direction:'column', labels:['包', '袋'] });

  const palletRow = page.locator('#productTable tbody tr[data-product="GTSL01"]');
  const compactControls = await palletRow.evaluate(row => {
    const rect = element => {
      const box = element.getBoundingClientRect();
      return { left:box.left, top:box.top, right:box.right, bottom:box.bottom, width:box.width, height:box.height };
    };
    const palletControl = row.querySelector('.palletStepControl');
    const palletInput = row.querySelector('.edit-pallets-input');
    const actionGroup = row.querySelector('.generatorActionGroup');
    const actions = Array.from(actionGroup.querySelectorAll(':scope > button'));
    const controlBox = rect(palletControl);
    return {
      palletControl:controlBox,
      nativeStep:palletInput.step,
      nativeAppearance:getComputedStyle(palletInput).appearance,
      customStepButtons:row.querySelectorAll('.palletStepButton').length,
      inlineKeyHandler:palletInput.getAttribute('onkeydown'),
      actionGroup:rect(actionGroup),
      actionLabels:actions.map(button => button.getAttribute('aria-label')),
      actions:actions.map(rect),
    };
  });
  expect(compactControls.palletControl.width).toBeLessThanOrEqual(84);
  expect(compactControls.palletControl.height).toBeLessThanOrEqual(34);
  expect(compactControls.nativeStep).toBe('0.5');
  expect(compactControls.nativeAppearance).not.toBe('textfield');
  expect(compactControls.customStepButtons).toBe(0);
  expect(compactControls.inlineKeyHandler).toBeNull();
  expect(compactControls.actionLabels).toEqual(['按住拖曳排序', '鎖定這列', '刪除這列']);
  expect(compactControls.actions).toHaveLength(3);
  for (const action of compactControls.actions) {
    expect(action.width).toBeLessThanOrEqual(30);
    expect(action.height).toBeLessThanOrEqual(30);
  }
  expect(compactControls.actionGroup.width).toBeLessThanOrEqual(94);

  const planningDetails = palletRow.locator('.generatorPlanningDetails');
  await expect(planningDetails.locator('summary')).toHaveText('速度／來源');
  await planningDetails.locator('summary').click();
  await expect(planningDetails.locator('.generatorOrderSourceText')).not.toHaveText('目前沒有對應的 JAM／FY 訂單');
  const systemPalletDays = Number((await palletRow.locator('.pallet-days-value').innerText()).match(/[\d.]+/)?.[0]);
  const manualVelocity = planningDetails.locator('.manual-velocity-input');
  await manualVelocity.fill('50');
  await manualVelocity.press('Tab');
  await expect(planningDetails.locator('summary')).toHaveText('手動速度／來源');
  await expect.poll(() => page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('supply-order-velocity-overrides-v1') || '{}');
    return saved.overrides?.GTSL01;
  })).toBe(50);
  const manualPalletDays = Number((await palletRow.locator('.pallet-days-value').innerText()).match(/[\d.]+/)?.[0]);
  expect(manualPalletDays).toBeLessThan(systemPalletDays);
  await planningDetails.locator('.generatorVelocityReset').click();
  await expect(planningDetails.locator('summary')).toHaveText('速度／來源');
  await expect.poll(() => page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('supply-order-velocity-overrides-v1') || '{}');
    return saved.overrides?.GTSL01 ?? null;
  })).toBeNull();

  const palletInput = palletRow.locator('.edit-pallets-input');
  await palletInput.fill('0.5');
  const palletBeforeStep = Number(await palletInput.inputValue());
  await palletInput.press('ArrowUp');
  const palletAfterStep = Number(await palletInput.inputValue());
  expect(palletAfterStep - palletBeforeStep).toBeCloseTo(0.5, 10);
  await expect.poll(async () => {
    const row = (await readOrderDraft(page)).rowsByProductSku.GTSL01;
    return { mode:row.pallet.mode, authoritativeField:row.pallet.authoritativeField };
  }).toEqual({ mode:'manual', authoritativeField:'pallets' });

  const ttsRow = page.locator('#productTable tbody tr[data-product="TTS05AM-1"]');
  for (const selector of ['.estimated-days', '.arrival-days']) {
    const cell = ttsRow.locator(selector);
    await expect(cell.locator('.coverageMeter')).toHaveCount(1);
    await expect(cell.locator('.coverageMeter__value')).toHaveText(/^\d+\.\d 天$/);
    await expect(cell.locator('.coverageMeter__status')).toHaveText(/^(?:低於 180 天|健康範圍 180–365 天|超過 365 天)$/);
    const valueText = (await cell.locator('.coverageMeter__value').textContent())?.trim();
    const statusText = (await cell.locator('.coverageMeter__status').textContent())?.trim();
    await expect(cell.getByRole('meter', { name:'可售天數' })).toHaveAttribute('aria-valuetext', `${valueText}，${statusText}`);
  }

  await ttsRow.locator('.lock-button').click();
  const ttsQuantity = ttsRow.locator('.edit-quantity-input');
  await ttsQuantity.fill('10000');
  const arrivalCell = ttsRow.locator('.arrival-days');
  const highCoverage = Number((await arrivalCell.locator('.coverageMeter__value').innerText()).match(/[\d.]+/)?.[0]);
  expect(highCoverage).toBeGreaterThan(365);
  const assumedStockAtArrival = highCoverage * 10 - 10000;
  const quantityFor180Days = Math.round(1800 - assumedStockAtArrival);
  const quantityFor365Days = Math.round(3650 - assumedStockAtArrival);

  await ttsQuantity.fill(String(quantityFor180Days - 10));
  await expectCoverageMeter(arrivalCell, {
    band:'low',
    valueText:'179.0 天',
    statusText:'低於 180 天',
    ariaNow:179,
    fillColor:'yellow',
  });

  await ttsQuantity.fill(String(quantityFor180Days));
  await expectCoverageMeter(arrivalCell, {
    band:'healthy',
    valueText:'180.0 天',
    statusText:'健康範圍 180–365 天',
    ariaNow:180,
    fillColor:'green',
  });

  await ttsQuantity.fill(String(quantityFor365Days));
  await expectCoverageMeter(arrivalCell, {
    band:'healthy',
    valueText:'365.0 天',
    statusText:'健康範圍 180–365 天',
    ariaNow:365,
    fillColor:'green',
  });

  await ttsQuantity.fill(String(quantityFor365Days + 10));
  await expectCoverageMeter(arrivalCell, {
    band:'excess',
    valueText:'366.0 天',
    statusText:'超過 365 天',
    ariaNow:365,
    fillColor:'red',
  });
  await expect.poll(async () => {
    const row = (await readOrderDraft(page)).rowsByProductSku['TTS05AM-1'];
    return { mode:row.pallet.mode, authoritativeField:row.pallet.authoritativeField };
  }).toEqual({ mode:'derived', authoritativeField:'quantity' });

  return readOrderDraft(page);
}

function sheetRows(workbook, name) {
  return XLSX.utils.sheet_to_json(workbook.Sheets[name], { header:1, raw:true, defval:'' });
}

export async function downloadAndAssertOrderWorkbook(page) {
  const exportExpectations = await page.evaluate(() => {
    const key = window.SupplyOrderDraftState?.ORDER_DRAFT_STORAGE_KEY || 'supply-order-draft-v3';
    const draft = JSON.parse(localStorage.getItem(key));
    return Object.fromEntries(Object.values(draft.rowsByProductSku).map(row => {
      const packaging = row.packagingAssignment || (window.SUPPLY_ORDER_SKU_PACKAGING || []).find(item => item.orderSku === row.orderSku);
      const perPack = Number(packaging.perPack) > 1 ? Number(packaging.perPack) : 1;
      const orderUnitsPerPallet = (Number(packaging.perCarton) * Number(packaging.perPallet)) / perPack;
      const cartons = (Number(row.quantities.orderDraft) * perPack) / Number(packaging.perCarton);
      return [row.orderSku, { cartons, pallets:Number(row.quantities.orderDraft) / orderUnitsPerPallet }];
    }));
  });
  await page.locator('.workspaceNavTab[data-workspace="orders"]').click();
  const downloadPromise = page.waitForEvent('download', { timeout:8_000 });
  await page.getByRole('button', { name:'匯出訂單 Excel' }).click();
  const download = await downloadPromise;
  const downloadedPath = await download.path();
  expect(downloadedPath).toBeTruthy();
  const workbook = XLSX.readFile(downloadedPath, { cellDates:false, raw:true });
  expect(workbook.SheetNames).toEqual(['台灣', '越南', '代工']);
  for (const name of workbook.SheetNames) expect(sheetRows(workbook, name)[0]).toEqual(ORDER_EXPORT_HEADERS);
  expect(sheetRows(workbook, '台灣').slice(1).map(row => row[1])).toEqual(['EZD011AM']);
  expect(sheetRows(workbook, '越南').slice(1).map(row => row[1])).toEqual(['1MHTD011A0']);
  expect(sheetRows(workbook, '代工').slice(1).map(row => row[1])).toEqual(['7VTBD410AB', '7ATSD010AB', '7GTSD017AB']);
  const exportedRows = workbook.SheetNames.flatMap(name => sheetRows(workbook, name).slice(1));
  for (const row of exportedRows) {
    expect(row[5]).toBeCloseTo(exportExpectations[row[1]].cartons, 10);
    expect(row[7]).toBeCloseTo(exportExpectations[row[1]].pallets, 10);
  }
  const vietnamRow = sheetRows(workbook, '越南')[1];
  expect([vietnamRow[3], vietnamRow[4], vietnamRow[9]]).toEqual([8, '盒裝', '50*40*30']);
  const packedSubcontractRow = sheetRows(workbook, '代工')[1];
  expect([packedSubcontractRow[3], packedSubcontractRow[4], packedSubcontractRow[9]]).toEqual([90, '袋裝', '50*40*30']);
  const exportedDraft = await readOrderDraft(page);
  for (const row of Object.values(exportedDraft.rowsByProductSku)) {
    expect(row.packagingAssignment?.state).toBe('pinned');
    expect(row.packagingAssignment?.packagingVersion).toBeTruthy();
  }
  return workbook;
}
