import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

// Approved name corrections only; preserve all packaging and existing-order facts.
const repo = path.resolve(process.argv[2] || '.');
const file = path.join(repo, 'catalog/product-catalog.json');
const before = JSON.parse(fs.readFileSync(file, 'utf8'));
assert.equal(before.catalogVersion, '2026-09-02', 'Re-audit a changed baseline before applying');
const candidate = structuredClone(before);
candidate.catalogVersion = '2026-09-21';
const products = new Map(candidate.products.map(p => [p.productSku, p]));
const counts = {
  GTAL01:[38,30], GTP03:[100,90], GTB05:[100,90], GTP05:[100,90],
  GTSL01:[30,24], GTRL01:[30,22], GTPL01:[30,24], GTBL01:[30,26],
  GTCL01:[30,28], GTRL03:[30,28], GTPL03:[30,24], GTBL03:[30,28],
  GTPL05:[30,24], GTBL05:[30,24], ACTL08:[24,28], ACTL09:[28,36]
};
for (const [sku, [oldCount, newCount]] of Object.entries(counts)) {
  const product = products.get(sku);
  assert.ok(product, sku);
  const packaging = product.packagingVersions.find(p => p.version === product.newOrderPackagingDefaultVersion);
  assert.equal(packaging?.unitsPerCarton, newCount, `${sku}: packaging differs from audit`);
  const pattern = /(\d+(?:\.\d+)?\s*g\s*[x*\u00d7]\s*)(\d+)(?=\s*(?:\)|$))/gi;
  const matches = [...product.productName.matchAll(pattern)];
  assert.equal(matches.length, 1, sku);
  assert.equal(Number(matches[0][2]), oldCount, sku);
  product.productName = product.productName.replace(pattern, (_, prefix) => prefix + newCount);
}
const lollipop = products.get('GTB07');
assert.match(lollipop.productName, /\blolipop\b/);
lollipop.productName = lollipop.productName.replace(/\blolipop\b/g, 'lollipop');
for (const sku of ['EPD021J','EPD041J','EPD061J','EPD020J','EPD040J','EPD060J']) {
  const product = products.get(sku);
  assert.match(product.productName, /\bRicipe\b/);
  product.productName = product.productName.replace(/\bRicipe\b/g, 'Recipe');
}
const changed = candidate.products.filter((p, i) => p.productName !== before.products[i].productName);
assert.equal(changed.length, 23);
const restored = structuredClone(candidate);
restored.catalogVersion = before.catalogVersion;
restored.products.forEach((p, i) => { p.productName = before.products[i].productName; });
assert.deepEqual(restored, before, 'Only names may change');
const api = await import(pathToFileURL(path.join(repo, 'catalog/catalog-change-plan.js')).href);
const plan = await api.createCatalogChangePlan(before, candidate, { sourceFile:'approved-product-name-audit-20260921' });
assert.equal(plan.blockers.length, 0);
assert.equal(plan.entries.length, 23);
assert.ok(plan.entries.every(entry => entry.fields.every(field => field.field === 'productName')));
const applied = await api.applyCatalogChangePlan(before, candidate, plan, { selectedEntryIds:plan.entries.map(entry => entry.id) });
fs.writeFileSync(file, JSON.stringify(applied.catalog, null, 2) + '\n');
const record = await api.createCatalogChangeRecord(plan, applied.catalog, applied.selectedEntryIds);
fs.writeFileSync(path.join(repo, 'catalog/change-records/2026-09-21.json'), JSON.stringify(record, null, 2) + '\n');
console.log(JSON.stringify({ changed:changed.map(p => p.productSku), packagingUnchanged:true, catalogVersion:applied.catalog.catalogVersion }));
