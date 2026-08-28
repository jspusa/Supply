import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import XLSX from 'xlsx';

import {
  ORDER_SKU_PACKAGING_HEADERS,
  ORDER_SKU_PACKAGING_SHEET,
  PRODUCT_MASTER_HEADERS,
  PRODUCT_MASTER_SHEET,
} from '../catalog/product-master-workbook.js';
import { compileProductCatalogWorkbook } from '../scripts/compile-product-master-workbook.mjs';

XLSX.set_fs(fs);

function packaging(version, unitsPerCarton) {
  return {
    version,
    effectiveFrom:'2026-08-28',
    effectiveTo:null,
    unitsPerCarton,
    cartonsPerPallet:42,
    cartonDimensionsCm:[50, 40, 30],
    grossWeightKg:null,
    grossWeightLb:25,
    orderUnit:{ kind:'single', units:1 },
    source:{ sheet:'fixture', row:1 },
  };
}

function baseCatalog() {
  return {
    schemaVersion:3,
    catalogVersion:'2026-08-28.4',
    products:[{
      productSku:'GTP01',
      productName:'Gootoe Pork',
      origin:'VN',
      standardFactory:'VN',
      lifecycle:'active',
      approvedOrderSkus:['GTP01'],
      newOrderPackagingDefaultVersion:'2026-08-28.4',
      packagingVersions:[packaging('2026-08-28.4', 24)],
    }],
    orderSkuAliases:[],
  };
}

function productRow({ version, unitsPerCarton, isDefault }) {
  return [
    'GTP01', 'Gootoe Pork', 'VN', 'VN', '',
    version, '2026-08-28', null, isDefault ? '是' : '否', '單品',
    unitsPerCarton, null, null, 42,
    50, 40, 30, null, 25,
    '正常', 'fixture', 1, '', '',
  ];
}

function writeWorkbook(filePath, catalogVersion, productRows) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['JAM 美國產品共用主檔'],
    [],
    ['Schema Version', 3, 'Catalog Version', catalogVersion],
    [],
    PRODUCT_MASTER_HEADERS,
    ...productRows,
  ]), PRODUCT_MASTER_SHEET);
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([
    ['JAM Order SKU 專屬箱規'],
    [],
    ['Schema Version', 3, 'Catalog Version', catalogVersion],
    [],
    ORDER_SKU_PACKAGING_HEADERS,
  ]), ORDER_SKU_PACKAGING_SHEET);
  XLSX.writeFile(workbook, filePath);
}

test('full ProductMasterTable imports preserve released history and accept appended corrections', t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'supply-catalog-history-'));
  t.after(() => fs.rmSync(temporary, { recursive:true, force:true }));
  const basePath = path.join(temporary, 'base.json');
  const outputPath = path.join(temporary, 'output.json');
  const workbookPath = path.join(temporary, 'catalog.xlsx');
  fs.writeFileSync(basePath, `${JSON.stringify(baseCatalog(), null, 2)}\n`);

  writeWorkbook(workbookPath, '2026-08-28.5', [
    productRow({ version:'2026-08-28.4', unitsPerCarton:25, isDefault:true }),
  ]);
  assert.throws(
    () => compileProductCatalogWorkbook({ inputPath:workbookPath, outputPath, basePath }),
    /released packaging version 2026-08-28\.4 is immutable/,
  );

  writeWorkbook(workbookPath, '2026-08-28.5', [
    productRow({ version:'2026-08-28.4', unitsPerCarton:24, isDefault:false }),
    productRow({ version:'2026-08-28.5', unitsPerCarton:25, isDefault:true }),
  ]);
  compileProductCatalogWorkbook({ inputPath:workbookPath, outputPath, basePath });
  const compiled = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
  assert.deepEqual(compiled.products[0].packagingVersions.map(item => item.unitsPerCarton), [24, 25]);
  assert.equal(compiled.products[0].newOrderPackagingDefaultVersion, '2026-08-28.5');
});
