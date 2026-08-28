import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import XLSX from 'xlsx';

const supplyRepo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fbaRepo = path.resolve(process.env.FBA_REPO || path.join(supplyRepo, '..', 'FBA'));
const OLD_VERSION = '2026-08-28.1';
const NEW_VERSION = '2026-08-29.1';
const checkedInFbaSnapshot = JSON.parse(fs.readFileSync(path.join(fbaRepo, 'catalog', 'fba-product-catalog.snapshot.json'), 'utf8'));
const checkedInGtbl05 = checkedInFbaSnapshot.products.find(product => product.productSku === 'GTBL05');
if (!checkedInGtbl05) throw new Error('FBA checked-in snapshot is missing GTBL05');
const CHECKED_IN_GTBL05 = JSON.stringify(checkedInGtbl05);
const packagingVersion = (version, unitsPerCarton, grossWeightLb) => ({
  packagingVersion:version,
  effectiveFrom:version.slice(0, 10),
  effectiveTo:null,
  unitsPerCarton,
  cartonDimensionsIn:[20, 16, 16],
  grossWeightLb,
});
const oldGtbl05 = {
  ...checkedInGtbl05,
  currentPackagingVersion:OLD_VERSION,
  newWorkPackagingDefaultVersion:OLD_VERSION,
  packagingVersions:[packagingVersion(OLD_VERSION, 30, 35)],
};
const newGtbl05 = {
  ...checkedInGtbl05,
  currentPackagingVersion:NEW_VERSION,
  newWorkPackagingDefaultVersion:NEW_VERSION,
  packagingVersions:[
    packagingVersion(OLD_VERSION, 30, 35),
    packagingVersion(NEW_VERSION, 24, 27),
  ],
};
const OLD_GTBL05 = JSON.stringify(oldGtbl05);
const NEW_GTBL05 = JSON.stringify(newGtbl05);

const MIME = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
]);

let server;
let origin;

function fileForRequest(url) {
  const decoded = decodeURIComponent(url.pathname);
  const route = decoded.startsWith('/FBA/')
    ? { root:fbaRepo, relative:decoded.slice('/FBA/'.length) }
    : (decoded.startsWith('/Supply/')
      ? { root:supplyRepo, relative:decoded.slice('/Supply/'.length) }
      : null);
  if (!route || !route.relative || route.relative.includes('\0')) return null;
  const candidate = path.resolve(route.root, route.relative);
  const relative = path.relative(route.root, candidate);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return candidate;
}

function serve(request, response) {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (url.pathname === '/') {
    response.writeHead(302, { Location:'/FBA/inbound-plan.html' });
    response.end();
    return;
  }
  const filePath = fileForRequest(url);
  if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    response.writeHead(404, { 'Content-Type':'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }
  let body = fs.readFileSync(filePath);
  if (filePath === path.join(fbaRepo, 'inbound-plan.html')) {
    const html = body.toString('utf8');
    const matches = html.split(CHECKED_IN_GTBL05).length - 1;
    if (matches !== 1) throw new Error('FBA GTBL05 schema v3 catalog fixture drifted');
    const replacement = url.searchParams.get('catalog') === 'next' ? NEW_GTBL05 : OLD_GTBL05;
    body = Buffer.from(html.replace(CHECKED_IN_GTBL05, replacement));
  }
  response.writeHead(200, {
    'Cache-Control':'no-store',
    'Content-Type':MIME.get(path.extname(filePath)) || 'application/octet-stream',
  });
  response.end(body);
}

const excelJsBoundaryStub = `
(() => {
  const address = value => {
    const match = String(value).match(/^([A-Z]+)(\\d+)$/);
    if (!match) throw new Error('Unsupported cell address ' + value);
    let column = 0;
    for (const character of match[1]) column = column * 26 + character.charCodeAt(0) - 64;
    return [Number(match[2]), column];
  };
  class Worksheet {
    constructor() { this.rowCount = 4; this.cells = new Map(); }
    getCell(row, column) {
      if (typeof row === 'string') [row, column] = address(row);
      const key = row + ':' + column;
      if (!this.cells.has(key)) this.cells.set(key, { value:null, style:{} });
      return this.cells.get(key);
    }
    exportedRows() {
      const rows = [];
      for (let row = 4; row <= 100; row += 1) {
        if (this.getCell(row, 1).value == null) continue;
        rows.push(Array.from({ length:9 }, (_, index) => {
          const value = this.getCell(row, index + 1).value;
          return value instanceof Date ? value.toISOString() : value;
        }));
      }
      return rows;
    }
  }
  class Workbook {
    constructor() {
      this.sheet = new Worksheet();
      this.worksheets = [this.sheet];
      this.xlsx = {
        load:async () => {},
        writeBuffer:async () => {
          window.__FBA_EXCEL_EXPORT__ = this.sheet.exportedRows();
          return new Uint8Array([80, 75, 3, 4]).buffer;
        },
      };
    }
    getWorksheet() { return this.sheet; }
  }
  window.ExcelJS = { Workbook };
})();
`;

async function preparePage(page, context, { legacyText = null } = {}) {
  await context.route('https://cdn.jsdelivr.net/**', route => route.fulfill({
    status:200,
    contentType:'text/javascript',
    body:excelJsBoundaryStub,
  }));
  await context.route('https://cdn.sheetjs.com/**', route => route.fulfill({
    status:200,
    contentType:'text/javascript',
    body:'window.XLSX = Object.freeze({});',
  }));
  await page.addInitScript(() => {
    window.__FBA_EXCEL_EXPORT__ = null;
    window.__FBA_DOWNLOAD_NAME__ = null;
    URL.createObjectURL = () => 'blob:fba-catalog-seam';
    URL.revokeObjectURL = () => {};
    HTMLAnchorElement.prototype.click = function click() {
      window.__FBA_DOWNLOAD_NAME__ = this.download || null;
    };
  });
  if (legacyText !== null) {
    await page.addInitScript(text => {
      const batchId = 'legacy-cross-feature-batch';
      localStorage.setItem('fba-workspace:batch-meta', JSON.stringify({ id:batchId, createdAt:1, updatedAt:1 }));
      localStorage.setItem('fba-workspace:inbound-draft:v1', JSON.stringify({ batchId, value:text, updatedAt:2 }));
    }, legacyText);
  }
}

async function confirmEveryExpiry(page) {
  const unconfirmed = page.locator('.review-toggle[aria-pressed="false"]');
  while (await unconfirmed.count()) await unconfirmed.first().click();
}

async function exportCapture(page) {
  await page.evaluate(() => { window.__FBA_EXCEL_EXPORT__ = null; });
  await page.locator('#exportBtn').click();
  await expect.poll(() => page.evaluate(() => window.__FBA_EXCEL_EXPORT__)).not.toBeNull();
  return page.evaluate(() => ({
    rows:window.__FBA_EXCEL_EXPORT__,
    downloadName:window.__FBA_DOWNLOAD_NAME__,
  }));
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

test.beforeAll(async () => {
  for (const filePath of [
    path.join(fbaRepo, 'inbound-plan.html'),
    path.join(fbaRepo, 'packaging-assignment.js'),
    path.join(fbaRepo, 'catalog-alignment.json'),
    path.join(supplyRepo, 'catalog-alignment.json'),
  ]) {
    if (!fs.existsSync(filePath)) throw new Error(`Cross-repository seam requires ${filePath}`);
  }
  server = http.createServer(serve);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
});

test.afterAll(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
});

test('FBA export keeps an existing assignment after a later default and gives only a new row the new packaging', async ({ page, context }) => {
  await preparePage(page, context);
  await page.goto(`${origin}/FBA/inbound-plan.html`);
  await page.locator('#pasteInput').fill('GTBL05\t2\t12/31/2027');
  await expect(page.locator('.packaging-badge')).toHaveText(`包裝 ${OLD_VERSION}`);
  await confirmEveryExpiry(page);
  await expect(page.locator('#exportBtn')).toBeEnabled();
  assertExport(await exportCapture(page), [
    ['GTBL05', 60, '2027-12-31T00:00:00.000Z', 30, 2, 20, 16, 16, 35],
  ]);

  await page.goto(`${origin}/FBA/inbound-plan.html?catalog=next`);
  await expect(page.locator('.packaging-badge')).toHaveText(`包裝 ${OLD_VERSION}`);
  await expect(page.locator('.packaging-newer')).toContainText(`有新版 ${NEW_VERSION}`);
  await page.locator('#pasteInput').fill('GTBL05\t2\t12/31/2027\nGTBL05\t2\t11/30/2027');
  await expect(page.locator('.packaging-badge')).toHaveText([
    `包裝 ${OLD_VERSION}`,
    `包裝 ${NEW_VERSION}`,
  ]);
  await confirmEveryExpiry(page);
  assertExport(await exportCapture(page), [
    ['GTBL05', 60, '2027-12-31T00:00:00.000Z', 30, 2, 20, 16, 16, 35],
    ['GTBL05', 48, '2027-11-30T00:00:00.000Z', 24, 2, 20, 16, 16, 27],
  ]);

  const ledger = await page.evaluate(() => JSON.parse(localStorage.getItem('fba-workspace:packaging-assignments:v1')));
  const assignments = Object.values(ledger.assignments).sort((left, right) => left.rowKey.localeCompare(right.rowKey));
  expect(assignments.map(item => [item.packagingVersion, item.facts.unitsPerCarton])).toEqual([
    [OLD_VERSION, 30],
    [NEW_VERSION, 24],
  ]);
});

test('FBA restored legacy work resolves one known version, preserves Historical Imported Packaging, and exports only after review', async ({ page, context }) => {
  const legacyText = 'GTBL05\t2\t60\t12/31/2027\nGTBL05\t2\t11/30/2027';
  await preparePage(page, context, { legacyText });
  await page.goto(`${origin}/FBA/inbound-plan.html`);

  await expect(page.locator('.packaging-badge')).toHaveText([
    `包裝 ${OLD_VERSION}`,
    '歷史匯入包裝',
  ]);
  const beforeReview = await page.evaluate(() => JSON.parse(localStorage.getItem('fba-workspace:packaging-assignments:v1')));
  expect(Object.values(beforeReview.assignments).map(item => [item.kind, item.migrationMethod, item.reviewRequired])).toEqual([
    ['catalog-version', 'known-facts-exact-match', false],
    ['historical-imported', 'unknown-or-unmatched-facts', true],
  ]);

  await confirmEveryExpiry(page);
  await expect(page.locator('#exportBtn')).toBeDisabled();
  await page.locator('.packaging-review').click();
  await expect(page.locator('#exportBtn')).toBeEnabled();
  assertExport(await exportCapture(page), [
    ['GTBL05', 60, '2027-12-31T00:00:00.000Z', 30, 2, 20, 16, 16, 35],
    ['GTBL05', 60, '2027-11-30T00:00:00.000Z', 30, 2, 20, 16, 16, 35],
  ]);

  await page.reload();
  await expect(page.locator('.packaging-reviewed')).toHaveText('✓ 已人工複查');
  const afterReload = await page.evaluate(() => JSON.parse(localStorage.getItem('fba-workspace:packaging-assignments:v1')));
  expect(Object.values(afterReload.assignments).map(item => [item.kind, item.reviewRequired, Boolean(item.reviewedAt)])).toEqual([
    ['catalog-version', false, false],
    ['historical-imported', false, true],
  ]);
});

test('FBA Product Update reads raw Excel in memory and reload drops the signed plan', async ({ page, context }) => {
  await preparePage(page, context);
  await page.goto(`${origin}/FBA/inbound-plan.html`);
  await expect.poll(() => page.evaluate(() => Boolean(window.JSPProductUpdateRuntime))).toBe(true);

  await page.getByRole('button', { name:'更新產品資料' }).click();
  const dialog = page.getByRole('dialog', { name:'產品資料更新' });
  await dialog.locator('[data-product-update-raw-file]').setInputFiles({
    name:'raw-product.xlsx',
    mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer:rawProductWorkbookBuffer(),
  });

  await expect(dialog.locator('[data-product-update-message]')).toContainText('已在記憶體解析 1 筆');
  await expect(dialog.locator('[data-product-update-plan]')).toBeVisible();
  await expect(dialog.locator('.product-update-lane[data-risk="safe"] input')).toHaveCount(1);
  const planState = await page.evaluate(() => {
    const plan = window.JSPProductUpdateRuntime.getPlan();
    const entry = plan.entries.find(item => item.id === 'product:GTP03');
    return {
      planSha256:plan.planSha256,
      sourceFile:plan.sourceFile,
      entryRisk:entry?.risk,
      selected:entry?.selected,
    };
  });
  expect(planState).toEqual({
    planSha256:expect.stringMatching(/^[a-f0-9]{64}$/),
    sourceFile:'raw-product.xlsx',
    entryRisk:'safe',
    selected:true,
  });
  expect(await page.evaluate(({ sourceFile, planSha256 }) => Object.values(localStorage)
    .some(value => value.includes(sourceFile) || value.includes(planSha256)), planState)).toBe(false);

  await page.reload();
  await expect.poll(() => page.evaluate(() => Boolean(window.JSPProductUpdateRuntime))).toBe(true);
  await page.getByRole('button', { name:'更新產品資料' }).click();
  await expect(page.locator('[data-product-update-plan]')).toBeHidden();
  expect(await page.evaluate(({ sourceFile, planSha256 }) => Object.values(localStorage)
    .some(value => value.includes(sourceFile) || value.includes(planSha256)), planState)).toBe(false);
});

test('FBA Product Update is mobile, keyboard trapped, reduced-motion, and no-reload until refresh', async ({ page, context }) => {
  await page.setViewportSize({ width:390, height:844 });
  await page.emulateMedia({ reducedMotion:'reduce' });
  await preparePage(page, context);
  await page.goto(`${origin}/FBA/inbound-plan.html`);
  await expect.poll(() => page.evaluate(() => Boolean(window.JSPProductUpdateRuntime))).toBe(true);
  const before = await page.evaluate(() => {
    window.__productUpdateDocumentToken = crypto.randomUUID();
    return { href:location.href, token:window.__productUpdateDocumentToken };
  });

  const trigger = page.getByRole('button', { name:'更新產品資料' });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name:'產品資料更新' });
  const close = dialog.getByRole('button', { name:'關閉產品資料更新' });
  await expect(close).toBeFocused();
  const mobile = await dialog.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const buttonStyle = getComputedStyle(element.querySelector('[data-product-update-close]'));
    const duration = value => Math.max(...value.split(',').map(item => Number.parseFloat(item) || 0));
    return {
      x:Math.round(rect.x), y:Math.round(rect.y), width:Math.round(rect.width), height:Math.round(rect.height),
      transition:duration(style.transitionDuration),
      buttonTransition:duration(buttonStyle.transitionDuration),
      reduced:matchMedia('(prefers-reduced-motion: reduce)').matches,
      pageWidth:document.documentElement.scrollWidth,
      overflow:Array.from(document.querySelectorAll('body *'))
        .map(element => ({ element, rect:element.getBoundingClientRect() }))
        .filter(item => item.rect.right > document.documentElement.clientWidth + 1 || item.rect.left < -1)
        .slice(0, 8)
        .map(item => `${item.element.tagName.toLowerCase()}${item.element.classList.length ? `.${[...item.element.classList].join('.')}` : ''}:${Math.round(item.rect.left)}..${Math.round(item.rect.right)}`),
    };
  });
  expect(mobile).toMatchObject({ x:0, y:0, width:390, height:844, reduced:true });
  expect(mobile.pageWidth, `Product Update must not overflow: ${mobile.overflow.join(', ')}`).toBe(390);
  expect(mobile.transition).toBeLessThanOrEqual(0.001);
  expect(mobile.buttonTransition).toBeLessThanOrEqual(0.001);
  await page.keyboard.press('Shift+Tab');
  expect(await page.evaluate(() => document.querySelector('#productUpdateDialog').contains(document.activeElement))).toBe(true);

  await dialog.locator('[data-product-update-raw-file]').setInputFiles({
    name:'raw-product.xlsx',
    mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    buffer:rawProductWorkbookBuffer(),
  });
  await expect(dialog.locator('[data-product-update-plan]')).toBeVisible();
  await dialog.locator('[data-product-update-prepare]').click();
  const confirm = dialog.locator('[data-product-update-confirm]');
  const cancel = confirm.locator('[data-product-update-confirm-cancel]');
  const accept = confirm.locator('[data-product-update-confirm-accept]');
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(accept).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(confirm).toBeHidden();
  await expect(dialog.locator('[data-product-update-prepare]')).toBeFocused();

  await close.click();
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(await page.evaluate(() => ({ href:location.href, token:window.__productUpdateDocumentToken }))).toEqual(before);
  await trigger.click();
  await expect(dialog.locator('[data-product-update-plan]')).toBeVisible();
  expect(await page.evaluate(() => window.JSPProductUpdateRuntime.getPlan()?.sourceFile)).toBe('raw-product.xlsx');
});

function assertExport(capture, expectedRows) {
  expect(capture.downloadName).toMatch(/^Amazon入庫模板_\d{4}-\d{2}-\d{2}\.xlsx$/);
  expect(capture.rows).toEqual(expectedRows);
}
