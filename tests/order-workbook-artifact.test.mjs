import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import XLSX from 'xlsx';

import {
  ORDER_EXPORT_HEADERS,
  applyOrderDraftCommand,
  createOrderDraft,
  projectOrderWorkbook,
} from '../shared/order-draft-state.js';

XLSX.set_fs(fs);

const NOW = '2026-08-28T05:00:00.000Z';
const catalog = new Map([
  ['TW-STD', { productCode:'TW-STD', productName:'Taiwan standard', country:'TW', packagingVersion:'fixture-v1', perCarton:10, perPack:null, perBox:null, perPallet:40, boxSize:'40*30*20' }],
  ['VN-STD', { productCode:'VN-STD', productName:'Vietnam standard', country:'VN', packagingVersion:'fixture-v1', perCarton:8, perPack:null, perBox:6, perPallet:42, boxSize:'50*40*30' }],
  ['VN-AT', { productCode:'VN-AT', productName:'AT subcontract product', country:'VN', packagingVersion:'fixture-v1', perCarton:10, perPack:2, perBox:null, perPallet:30, boxSize:'31*21*11' }],
  ['TW-GT', { productCode:'TW-GT', productName:'GT subcontract product', country:'TW', packagingVersion:'fixture-v1', perCarton:12, perPack:null, perBox:null, perPallet:25, boxSize:'32*22*12' }],
  ['VN-VT', { productCode:'VN-VT', productName:'VT subcontract product', country:'VN', packagingVersion:'fixture-v1', perCarton:8, perPack:4, perBox:null, perPallet:20, boxSize:'33*23*13' }],
]);
const approved = new Map([
  ['VN-AT', ['7AT-ORDER']],
  ['TW-GT', ['7GT-ORDER']],
  ['VN-VT', ['7VT-ORDER']],
]);
const context = {
  now:NOW,
  getProduct:productSku => catalog.get(productSku) || null,
  getApprovedOrderSkus:productSku => approved.get(productSku) || [],
};

function addRow(draft, productSku, quantity) {
  const result = applyOrderDraftCommand(draft, {
    type:'upsert-row',
    row:{ productSku, quantities:{ orderDraft:quantity }, pallet:{ value:null, mode:'whole-pallet' } },
  }, context);
  assert.equal(result.ok, true, productSku);
  return result.draft;
}

function switchOrderSku(draft, productSku, orderSku) {
  const result = applyOrderDraftCommand(draft, { type:'switch-order-sku', productSku, orderSku }, context);
  assert.equal(result.ok, true, orderSku);
  return result.draft;
}

function sheetRows(workbook, name) {
  return XLSX.utils.sheet_to_json(workbook.Sheets[name], { header:1, raw:true, defval:'' });
}

test('actual XLSX round-trip preserves three sheets, routing, product packaging truth, and saved row order', t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'supply-order-workbook-'));
  t.after(() => fs.rmSync(temporary, { recursive:true, force:true }));
  const filename = path.join(temporary, 'Supply-order.xlsx');

  let draft = createOrderDraft({ now:NOW });
  for (const [productSku, quantity] of [
    ['TW-STD', 400],
    ['VN-STD', 336],
    ['VN-AT', 150],
    ['TW-GT', 300],
    ['VN-VT', 40],
  ]) draft = addRow(draft, productSku, quantity);
  draft = switchOrderSku(draft, 'VN-AT', '7AT-ORDER');
  draft = switchOrderSku(draft, 'TW-GT', '7GT-ORDER');
  draft = switchOrderSku(draft, 'VN-VT', '7VT-ORDER');
  draft = applyOrderDraftCommand(draft, {
    type:'reorder-group',
    group:'subcontract',
    productSkus:['VN-VT', 'VN-AT', 'TW-GT'],
  }, context).draft;

  const projection = projectOrderWorkbook(draft, context);
  assert.equal(projection.ok, true, JSON.stringify(projection.issues));
  const workbook = XLSX.utils.book_new();
  for (const sheet of projection.sheets) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([sheet.headers, ...sheet.rows]), sheet.name);
  }
  XLSX.writeFile(workbook, filename, { bookType:'xlsx', compression:true });
  assert.ok(fs.statSync(filename).size > 0);

  const reopened = XLSX.readFile(filename, { cellDates:false, raw:true });
  assert.deepEqual(reopened.SheetNames, ['台灣', '越南', '代工']);
  for (const name of reopened.SheetNames) assert.deepEqual(sheetRows(reopened, name)[0], ORDER_EXPORT_HEADERS);

  assert.deepEqual(sheetRows(reopened, '台灣').slice(1), [
    [1, 'TW-STD', 'Taiwan standard', 10, '單包', 40, '箱', 1, '棧板', '40*30*20'],
  ]);
  assert.deepEqual(sheetRows(reopened, '越南').slice(1), [
    [1, 'VN-STD', 'Vietnam standard', 8, '盒裝', 42, '箱', 1, '棧板', '50*40*30'],
  ]);
  assert.deepEqual(sheetRows(reopened, '代工').slice(1), [
    [1, '7VT-ORDER', 'VT subcontract product', 8, '袋裝', 20, '箱', 1, '棧板', '33*23*13'],
    [2, '7AT-ORDER', 'AT subcontract product', 10, '袋裝', 30, '箱', 1, '棧板', '31*21*11'],
    [3, '7GT-ORDER', 'GT subcontract product', 12, '單包', 25, '箱', 1, '棧板', '32*22*12'],
  ]);
});

test('actual XLSX keeps a pinned alias Packaging Assignment after the alias default changes', t => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'supply-order-alias-packaging-'));
  t.after(() => fs.rmSync(temporary, { recursive:true, force:true }));
  const filename = path.join(temporary, 'Supply-alias-order.xlsx');
  let aliasPackaging = {
    orderSku:'7AT-ORDER',
    canonicalProductSku:'VN-AT',
    packagingVersion:'alias-v1',
    perCarton:25,
    perPack:2,
    perBox:null,
    perPallet:10,
    boxSize:'60*50*40',
  };
  const aliasContext = {
    ...context,
    getOrderSkuPackaging(orderSku) {
      if (orderSku === '7AT-ORDER') return aliasPackaging;
      const product = catalog.get(orderSku);
      return product ? {
        orderSku,
        canonicalProductSku:orderSku,
        packagingVersion:'product-v1',
        perCarton:product.perCarton,
        perPack:product.perPack,
        perBox:product.perBox,
        perPallet:product.perPallet,
        boxSize:product.boxSize,
      } : null;
    },
  };
  let draft = applyOrderDraftCommand(createOrderDraft({ now:NOW }), {
    type:'upsert-row',
    row:{ productSku:'VN-AT', quantities:{ orderDraft:100 }, pallet:{ value:0.5, mode:'manual' } },
  }, aliasContext).draft;
  draft = applyOrderDraftCommand(draft, {
    type:'switch-order-sku', productSku:'VN-AT', orderSku:'7AT-ORDER',
  }, aliasContext).draft;
  assert.equal(draft.rowsByProductSku['VN-AT'].packagingAssignment.packagingVersion, 'alias-v1');

  aliasPackaging = {
    ...aliasPackaging,
    packagingVersion:'alias-v2',
    perCarton:50,
    perPallet:20,
    boxSize:'70*60*50',
  };
  const projection = projectOrderWorkbook(structuredClone(draft), aliasContext);
  assert.equal(projection.ok, true, JSON.stringify(projection.issues));
  const workbook = XLSX.utils.book_new();
  for (const sheet of projection.sheets) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([sheet.headers, ...sheet.rows]), sheet.name);
  }
  XLSX.writeFile(workbook, filename, { bookType:'xlsx', compression:true });
  const reopened = XLSX.readFile(filename, { cellDates:false, raw:true });
  assert.deepEqual(sheetRows(reopened, '代工')[1], [
    1, '7AT-ORDER', 'AT subcontract product', 25, '袋裝', 8, '箱', 0.8, '棧板', '60*50*40',
  ]);
  assert.equal(projection.draft.rowsByProductSku['VN-AT'].packagingAssignment.packagingVersion, 'alias-v1');
});
