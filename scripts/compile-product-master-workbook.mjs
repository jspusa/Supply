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
import { assertCatalogHistoryPreserved } from '../catalog/product-catalog.js';
import {
  applyExplicitRawClears,
  overlayRawProductCatalog,
} from '../catalog/raw-product-catalog-overlay.js';
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

function rawConflictResolutionPolicy(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('衝突選擇規則必須是 JSON 物件');
  const allowed = new Set(['schemaVersion', 'match', 'overrides', 'replacePackagingHistory']);
  const unsupported = Object.keys(value).filter(key => !allowed.has(key));
  if (unsupported.length) throw new Error(`衝突選擇規則含有不支援欄位：${unsupported.join(', ')}`);
  if (value.replacePackagingHistory !== true && value.replacePackagingHistory !== false) {
    throw new Error('衝突選擇規則必須明確指定 replacePackagingHistory');
  }
  return {
    parser:{ schemaVersion:value.schemaVersion, match:value.match, overrides:value.overrides },
    replacePackagingHistory:value.replacePackagingHistory,
  };
}

function ownerForSku(catalog, sku) {
  if (sku.startsWith('7')) return catalog.orderSkuAliases.find(alias => alias.orderSku === sku) || null;
  return catalog.products.find(product => product.productSku === sku) || null;
}

export function compileProductCatalogWorkbook({
  inputPath,
  outputPath,
  basePath = outputPath,
  version,
  explicitClears = [],
  conflictResolution = null,
  check = false,
}) {
  const resolvedInput = path.resolve(inputPath);
  const resolvedOutput = path.resolve(outputPath);
  const resolvedBase = path.resolve(basePath);
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
    if (fs.existsSync(resolvedBase)) {
      const baseCatalog = JSON.parse(fs.readFileSync(resolvedBase, 'utf8'));
      assertCatalogHistoryPreserved(baseCatalog, catalog);
    }
    summary = `${catalog.products.length} products and ${catalog.orderSkuAliases.length} Order SKU aliases`;
  } else {
    const rawApi = globalThis.JSPSharedProductCatalog;
    if (!rawApi?.isRawWorkbook(workbook)) {
      throw new Error(`Workbook must contain either ${PRODUCT_MASTER_SHEET}/${ORDER_SKU_PACKAGING_SHEET} or AMZ 所有SKU/2026/罐頭`);
    }
    if (!fs.existsSync(resolvedBase)) throw new Error('Raw workbook import requires an existing canonical catalog via --base or --output');
    if (!version) throw new Error('Raw workbook import requires --version YYYY-MM-DD.N');
    const baseCatalog = JSON.parse(fs.readFileSync(resolvedBase, 'utf8'));
    const resolutionPolicy = rawConflictResolutionPolicy(conflictResolution);
    const normalizedPolicy = resolutionPolicy
      ? rawApi.normalizeConflictResolution(resolutionPolicy.parser)
      : null;
    const parsedPayload = rawApi.createPayload(workbook, XLSX, {
      sourceFile:path.basename(resolvedInput),
      baseCatalogVersion:baseCatalog.catalogVersion,
      conflictResolution:resolutionPolicy?.parser || null,
    });
    const payload = applyExplicitRawClears(parsedPayload, explicitClears);
    const replacementDecisions = resolutionPolicy?.replacePackagingHistory
      ? payload.resolutions.map(resolution => {
        const owner = ownerForSku(baseCatalog, resolution.sku);
        if (!owner) throw new Error(`${resolution.sku} 的舊箱規清除找不到既有產品`);
        return {
          sku:resolution.sku,
          sourceSheet:resolution.sourceSheet,
          sourceRow:resolution.sourceRow,
          removedVersionIds:owner.packagingVersions.map(item => item.version),
        };
      })
      : [];
    const result = overlayRawProductCatalog(baseCatalog, payload, {
      catalogVersion:version,
      packagingHistoryReplacements:replacementDecisions,
    });
    catalog = result.catalog;
    importStats = {
      ...result.stats,
      rawRecords:payload.records.length,
      skippedRawRecords:payload.stats.skipped,
      duplicateConflicts:payload.stats.duplicateConflicts,
      resolvedDuplicateConflicts:payload.stats.resolvedDuplicateConflicts,
      sourceConflicts:payload.conflicts,
      sourceConflictResolutions:payload.resolutions,
      duplicateResolution:normalizedPolicy ? {
        schemaVersion:1,
        policy:{
          schemaVersion:1,
          match:normalizedPolicy.match,
          overrides:normalizedPolicy.overrides,
          replacePackagingHistory:resolutionPolicy.replacePackagingHistory,
        },
        resolutions:payload.resolutions.map(resolution => ({
          ...resolution,
          removedVersionIds:replacementDecisions.find(item => item.sku === resolution.sku)?.removedVersionIds || [],
        })),
      } : null,
      replacedPackagingHistorySkus:replacementDecisions.map(item => item.sku),
      sourceRecords:payload.records.map(record => ({
        sku:record.sku,
        sourceSheet:record.sourceSheet,
        sourceRow:record.sourceRow,
      })),
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
    conflictResolution:args['conflict-resolution'] ? JSON.parse(fs.readFileSync(path.resolve(args['conflict-resolution']), 'utf8')) : null,
    check:args.check,
  });
  if (args.check) console.log(`Verified ${args.output} against ${args.input}`);
  else console.log(`Compiled ${result.summary} from ${args.input} into ${args.output}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
