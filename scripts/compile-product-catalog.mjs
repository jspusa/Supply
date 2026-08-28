import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { compileCatalog } from '../catalog/product-catalog.js';
import {
  renderSupplyProductData,
  supplyCatalogAdapter,
} from '../catalog/supply-catalog-adapter.js';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const canonicalCatalogPath = path.join(repoRoot, 'catalog', 'product-catalog.json');
export const checkedSupplySnapshotPath = path.join(repoRoot, 'product-data.js');

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    error.message = `Cannot read product catalog ${filePath}: ${error.message}`;
    throw error;
  }
}

export function compileSupplyProductData({ catalogPath = canonicalCatalogPath } = {}) {
  const canonicalCatalog = readJson(catalogPath);
  const projection = compileCatalog(canonicalCatalog, supplyCatalogAdapter);
  return renderSupplyProductData(projection);
}

export function writeSupplyProductData({
  catalogPath = canonicalCatalogPath,
  outputPath = checkedSupplySnapshotPath,
} = {}) {
  const generated = compileSupplyProductData({ catalogPath });
  fs.mkdirSync(path.dirname(outputPath), { recursive:true });
  fs.writeFileSync(outputPath, generated);
  return outputPath;
}

export function checkSupplyProductData({
  catalogPath = canonicalCatalogPath,
  outputPath = checkedSupplySnapshotPath,
} = {}) {
  const expected = compileSupplyProductData({ catalogPath });
  const actual = fs.readFileSync(outputPath, 'utf8');
  if (actual !== expected) {
    throw new Error(`${path.relative(repoRoot, outputPath)} is stale; run npm run catalog:build`);
  }
  return outputPath;
}

function readOption(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function main() {
  const outputPath = path.resolve(readOption('--out') || checkedSupplySnapshotPath);
  const catalogPath = path.resolve(readOption('--catalog') || canonicalCatalogPath);
  if (process.argv.includes('--check')) {
    checkSupplyProductData({ catalogPath, outputPath });
    console.log(`Verified ${path.relative(repoRoot, outputPath)} against ${path.relative(repoRoot, catalogPath)}`);
    return;
  }
  writeSupplyProductData({ catalogPath, outputPath });
  console.log(`Generated ${path.relative(repoRoot, outputPath)} from ${path.relative(repoRoot, catalogPath)}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
