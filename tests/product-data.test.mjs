import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const repoRoot = path.resolve(import.meta.dirname, '..');

function loadProductData() {
  const context = { window:{} };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync(path.join(repoRoot, 'product-data.js'), 'utf8'), context);
  return context.window;
}

test('approved Product SKU to Order SKU mappings have one public source of truth', () => {
  const data = loadProductData();
  const pairs = Array.from(data.SUPPLY_EQUIVALENT_SKU_PAIRS, pair => Array.from(pair));
  assert.equal(Object.isFrozen(data.SUPPLY_EQUIVALENT_SKU_PAIRS), true);
  assert.equal(pairs.length, 22);
  assert.equal(new Set(pairs.map(pair => pair[0])).size, pairs.length);
  assert.equal(new Set(pairs.map(pair => pair[1])).size, pairs.length);
  assert.ok(pairs.every(pair => pair.length === 2 && pair[1].startsWith('7')));
  assert.deepEqual(new Set(pairs.map(pair => pair[1].slice(0, 3))), new Set(['7AT', '7GT', '7VT']));
  const products = new Map(data.allProductsData.map(product => [product.productCode, product]));
  assert.ok(pairs.every(pair => products.has(pair[0])), 'every approved switch must keep a catalog Product SKU');
});
