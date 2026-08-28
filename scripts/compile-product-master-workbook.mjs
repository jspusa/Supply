import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

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

export function compileProductCatalogWorkbook({ inputPath, outputPath, basePath = outputPath, version, check = false }) {
  const resolvedInput = path.resolve(inputPath);
  const resolvedOutput = path.resolve(outputPath);
  const workbook = XLSX.read(fs.readFileSync(resolvedInput), { type:'buffer', cellDates:true });
  const sheet = workbook.Sheets[PRODUCT_MASTER_SHEET];
  const orderSkuSheet = workbook.Sheets[ORDER_SKU_PACKAGING_SHEET];
  let catalog;
  let summary;
  let importStats = null;
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
    const resolvedBase = path.resolve(basePath);
    if (!fs.existsSync(resolvedBase)) throw new Error('Raw workbook import requires an existing canonical catalog via --base or --output');
    if (!version) throw new Error('Raw workbook import requires --version YYYY-MM-DD.N');
    const baseCatalog = JSON.parse(fs.readFileSync(resolvedBase, 'utf8'));
    const payload = rawApi.createPayload(workbook, XLSX, { sourceFile:path.basename(resolvedInput), baseCatalogVersion:baseCatalog.catalogVersion });
    const result = overlayRawProductCatalog(baseCatalog, payload, { catalogVersion:version });
    catalog = result.catalog;
    importStats = {
      ...result.stats,
      rawRecords:payload.records.length,
      skippedRawRecords:payload.stats.skipped,
      duplicateConflicts:payload.stats.duplicateConflicts,
      matchedSheets:payload.matchedSheets.map(name => name.trim()),
    };
    summary = `${catalog.products.length} products and ${catalog.orderSkuAliases.length} Order SKU aliases from raw sheets; ${JSON.stringify(result.stats)}`;
  }
  const generated = `${JSON.stringify(catalog, null, 2)}\n`;
  if (check) {
    if (fs.readFileSync(resolvedOutput, 'utf8') !== generated) {
      throw new Error(`${outputPath} is stale relative to ${inputPath}`);
    }
  } else {
    fs.mkdirSync(path.dirname(resolvedOutput), { recursive:true });
    fs.writeFileSync(resolvedOutput, generated);
  }
  return { catalog, summary, importStats };
}

function main() {
  const args = options(process.argv.slice(2));
  if (!args.input || !args.output) throw new Error('Required options: --input <xlsx> --output <catalog.json>');
  const result = compileProductCatalogWorkbook({
    inputPath:args.input,
    outputPath:args.output,
    basePath:args.base || args.output,
    version:args.version,
    check:args.check,
  });
  if (args.check) console.log(`Verified ${args.output} against ${args.input}`);
  else console.log(`Compiled ${result.summary} from ${args.input} into ${args.output}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
