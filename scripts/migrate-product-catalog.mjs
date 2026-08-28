import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { migrateCatalog, validateCatalog } from '../catalog/product-catalog.js';

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a file path`);
  return value;
}

const inputPath = path.resolve(option('--input') || 'catalog/product-catalog.json');
const outputPath = path.resolve(option('--output') || inputPath);
const source = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const migrated = migrateCatalog(source);
validateCatalog(migrated);
const generated = `${JSON.stringify(migrated, null, 2)}\n`;

if (process.argv.includes('--check')) {
  if (source.schemaVersion !== migrated.schemaVersion || fs.readFileSync(outputPath, 'utf8') !== generated) {
    throw new Error(`${path.relative(process.cwd(), outputPath)} is not canonical schemaVersion ${migrated.schemaVersion}`);
  }
  console.log(`Verified ${path.relative(process.cwd(), outputPath)} as schemaVersion ${migrated.schemaVersion}`);
} else {
  fs.mkdirSync(path.dirname(outputPath), { recursive:true });
  fs.writeFileSync(outputPath, generated);
  console.log(`Migrated ${path.relative(process.cwd(), inputPath)} to schemaVersion ${migrated.schemaVersion}`);
}
