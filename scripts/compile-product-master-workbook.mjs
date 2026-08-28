import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import * as XLSX from 'xlsx';

import {
  catalogFromProductMasterRows,
  ORDER_SKU_PACKAGING_SHEET,
  PRODUCT_MASTER_SHEET,
} from '../catalog/product-master-workbook.js';
import { overlayRawProductCatalog } from '../catalog/raw-product-catalog-overlay.js';
import '../shared/shared-product-catalog.js';

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
const orderSkuSheet = workbook.Sheets[ORDER_SKU_PACKAGING_SHEET];
let catalog;
let summary;
if (sheet && orderSkuSheet) {
  const rows = XLSX.utils.sheet_to_json(sheet, { header:1, defval:null, raw:true });
  const orderSkuRows = XLSX.utils.sheet_to_json(orderSkuSheet, { header:1, defval:null, raw:true });
  catalog = catalogFromProductMasterRows(rows, orderSkuRows);
  summary = `${catalog.products.length} products and ${catalog.orderSkuAliases.length} Order SKU aliases`;
} else {
  const rawApi = globalThis.JSPSharedProductCatalog;
  if (!rawApi?.isRawWorkbook(workbook)) {
    throw new Error(`Workbook must contain either ${PRODUCT_MASTER_SHEET}/${ORDER_SKU_PACKAGING_SHEET} or AMZ 所有SKU/2026/罐頭`);
  }
  const outputPath = path.resolve(args.output);
  const basePath = path.resolve(args.base || outputPath);
  if (!fs.existsSync(basePath)) throw new Error('Raw workbook import requires an existing canonical catalog via --base or --output');
  if (!args.version) throw new Error('Raw workbook import requires --version YYYY-MM-DD.N');
  const baseCatalog = JSON.parse(fs.readFileSync(basePath, 'utf8'));
  const payload = rawApi.createPayload(workbook, XLSX, { sourceFile:path.basename(args.input), baseCatalogVersion:baseCatalog.catalogVersion });
  const result = overlayRawProductCatalog(baseCatalog, payload, { catalogVersion:args.version });
  catalog = result.catalog;
  summary = `${catalog.products.length} products and ${catalog.orderSkuAliases.length} Order SKU aliases from raw sheets; ${JSON.stringify(result.stats)}`;
}
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
  console.log(`Compiled ${summary} from ${args.input} into ${args.output}`);
}
