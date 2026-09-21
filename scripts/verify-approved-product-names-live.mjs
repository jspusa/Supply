import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const supply = path.resolve(process.argv[2]);
const fba = path.resolve(process.argv[3]);
const output = path.resolve(process.argv[4] || '/tmp/name-live-evidence');
fs.mkdirSync(output, { recursive:true });
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const expectedCatalog = json(path.join(supply, 'catalog/product-catalog.json'));
const changes = json(path.join(supply, 'catalog/change-records/2026-09-21.json')).changes;
assert.equal(expectedCatalog.catalogVersion, '2026-09-21');
assert.equal(changes.length, 23);
assert.ok(changes.every(entry => entry.fields.every(field => field.field === 'productName')));
const expectedNames = Object.fromEntries(changes.map(entry => [entry.sku, expectedCatalog.products.find(p => p.productSku === entry.sku).productName]));
const roots = { supply:'https://jspusa.github.io/Supply/', fba:'https://jspusa.github.io/FBA/' };
async function text(url) {
  const target = new URL(url); target.searchParams.set('name-release-check', String(Date.now()));
  const response = await fetch(target, { headers:{'cache-control':'no-cache'}, signal:AbortSignal.timeout(30000) });
  assert.equal(response.status, 200, target.pathname);
  return response.text();
}
const checks = {};
for (const [site, root] of Object.entries(roots)) {
  const local = json(path.join(site === 'supply' ? supply : fba, 'catalog-alignment.json'));
  const live = JSON.parse(await text(root + 'catalog-alignment.json'));
  assert.deepEqual(live, local, `${site}: published catalog manifest differs`);
  checks[site] = { catalogVersion:live.catalogVersion, publicContentHash:live.publicContentHash };
}
assert.equal(checks.supply.catalogVersion, checks.fba.catalogVersion);
assert.equal(await text(roots.supply + 'product-data.js'), fs.readFileSync(path.join(supply, 'product-data.js'), 'utf8'));
const fbaHtml = await text(roots.fba + 'inbound-plan.html');
const match = fbaHtml.match(/const BUILTIN_CATALOG_SNAPSHOT=(\{.*?\});\s*const BUILTIN_CATALOG_ADAPTER=/s);
assert.ok(match, 'Published FBA snapshot was not found');
assert.deepEqual(JSON.parse(match[1]), json(path.join(fba, 'catalog/fba-product-catalog.snapshot.json')));
assert.equal(await text(roots.fba + 'catalog-update-baseline.js'), fs.readFileSync(path.join(fba, 'catalog-update-baseline.js'), 'utf8'));
const require = createRequire(path.join(supply, 'package.json'));
const { chromium, expect } = require('@playwright/test');
const browser = await chromium.launch({ headless:true });
const results = [];
try {
  for (const viewport of [{width:1280,height:900}, {width:390,height:844}]) {
    const context = await browser.newContext({ viewport, locale:'zh-TW', timezoneId:'Asia/Taipei' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if(message.type() === 'error') errors.push(message.text()); });
    await page.goto(roots.supply + '?verified-names=20260921#orders', {waitUntil:'domcontentloaded',timeout:45000});
    await page.waitForFunction(() => document.documentElement.dataset.workspaceUiReady === 'true', null, {timeout:20000});
    const names = await page.evaluate(skus => Object.fromEntries(skus.map(sku => [sku, window.allProductsData.find(p => p.productCode === sku)?.productName])), Object.keys(expectedNames));
    assert.deepEqual(names, expectedNames, 'Published product names differ');
    await page.locator('#searchInput').fill('GTA');
    const item = page.locator('#searchResults .search-result-item').filter({hasText:'GTAL01'});
    await expect(item).toHaveText('GTAL01 - Gootoe - Turkey Tendon Braid_S (454g x 30)');
    await item.scrollIntoViewIfNeeded();
    await page.screenshot({path:path.join(output, `supply-live-${viewport.width}.png`)});
    await item.click();
    await expect(page.locator('#productTable tbody tr[data-product="GTAL01"]')).toBeVisible();
    assert.equal(await page.evaluate(() => window.allProductsData.find(p => p.productCode === 'GTAL01').perCarton), 30);
    assert.deepEqual(errors, []);
    results.push({site:'supply', viewport, title:await page.title(), url:page.url(), correctedNames:23, gtal01Selection:true, consoleErrors:errors});
    await context.close();
  }
  const context = await browser.newContext({viewport:{width:1280,height:900}, locale:'zh-TW'});
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(roots.fba + 'inbound-plan.html?verified-names=20260921', {waitUntil:'domcontentloaded',timeout:45000});
  await expect(page.locator('#pasteInput')).toBeVisible();
  await page.waitForFunction(() => Boolean(window.FBAProductCatalog), null, {timeout:20000});
  const facts = await page.evaluate(() => {
    const p = BUILTIN_CATALOG_SNAPSHOT.products.find(p => p.productSku === 'GTAL01');
    return {version:BUILTIN_CATALOG_SNAPSHOT.catalogVersion, packaging:p.packagingVersions.find(v => v.packagingVersion === p.newWorkPackagingDefaultVersion)};
  });
  assert.equal(facts.version, '2026-09-21');
  assert.equal(facts.packaging.unitsPerCarton, 30);
  assert.equal(facts.packaging.grossWeightLb, 35);
  assert.deepEqual(facts.packaging.cartonDimensionsIn, [20,16,12]);
  assert.deepEqual(errors, []);
  await page.screenshot({path:path.join(output, 'fba-live.png')});
  results.push({site:'fba', title:await page.title(), url:page.url(), facts, pageErrors:errors});
  await context.close();
} finally { await browser.close(); }
const report = {checkedAt:new Date().toISOString(), catalogVersion:'2026-09-21', status:'passed', publishedSourceMatches:true, manifests:checks, browserResults:results};
fs.writeFileSync(path.join(output, 'live-verification.json'), JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
