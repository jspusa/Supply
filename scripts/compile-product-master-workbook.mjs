import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import * as XLSX from 'xlsx';

import {
  catalogFromProductMasterRows,
  ORDER_SKU_PACKAGING_SHEET,
  PRODUCT_MASTER_SHEET,
} from '../catalog/product-master-workbook.js';

function options(argv) {
  const values = { check:false };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--check') {
      values.check = true;
      continue;
    }
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value || value.startsWith('--')) throw new Error(`Invalid option near ${key || 'end of command'}`);
    values[key.slice(2)] = value;
    index += 1;
  }
  return values;
}

const args = options(process.argv.slice(2));
if (!args.input || !args.output) throw new Error('Required options: --input <xlsx> --output <catalog.json>');

const workbook = XLSX.read(fs.readFileSync(path.resolve(args.input)), { type:'buffer', cellDates:true });
const sheet = workbook.Sheets[PRODUCT_MASTER_SHEET];
if (!sheet) throw new Error(`Workbook is missing ${PRODUCT_MASTER_SHEET}`);
const orderSkuSheet = workbook.Sheets[ORDER_SKU_PACKAGING_SHEET];
if (!orderSkuSheet) throw new Error(`Workbook is missing ${ORDER_SKU_PACKAGING_SHEET}`);
const rows = XLSX.utils.sheet_to_json(sheet, { header:1, defval:null, raw:true });
const orderSkuRows = XLSX.utils.sheet_to_json(orderSkuSheet, { header:1, defval:null, raw:true });
const catalog = catalogFromProductMasterRows(rows, orderSkuRows);
const generated = `${JSON.stringify(catalog, null, 2)}\n`;
const outputPath = path.resolve(args.output);

if (args.check) {
  if (fs.readFileSync(outputPath, 'utf8') !== generated) {
    throw new Error(`${args.output} is stale relative to ${args.input}`);
  }
  console.log(`Verified ${args.output} against ${args.input}`);
} else {
  fs.mkdirSync(path.dirname(outputPath), { recursive:true });
  fs.writeFileSync(outputPath, generated);
  console.log(`Compiled ${catalog.products.length} products and ${catalog.orderSkuAliases.length} Order SKU aliases from ${args.input} into ${args.output}`);
}
