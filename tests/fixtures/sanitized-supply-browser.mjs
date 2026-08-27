import XLSX from 'xlsx';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const FIXTURE_UPDATED_AT = '2026-08-28T08:00:00.000Z';
export const FIXTURE_LAST_MODIFIED = Date.parse(FIXTURE_UPDATED_AT);
export const BOSS_FIXTURE_TOKEN = 'fixture-token-never-production';

export const SANITIZED_PRODUCTS = Object.freeze([
  Object.freeze({ productSku:'EZD011AM', orderSku:'EZD011AM', group:'taiwan', planningVelocity:2, order:4, amazon:2, jsp:2, replacementJsp:20 }),
  Object.freeze({ productSku:'1MHTD011A0', orderSku:'1MHTD011A0', group:'vietnam', planningVelocity:3, order:6, amazon:3, jsp:3, replacementJsp:30 }),
  Object.freeze({ productSku:'TTS05AM-1', orderSku:'7ATSD010AB', group:'subcontract', planningVelocity:10, order:20, amazon:0, jsp:5, replacementJsp:50 }),
  Object.freeze({ productSku:'GTSL01', orderSku:'7GTSD017AB', group:'subcontract', planningVelocity:10, order:12, amazon:6, jsp:5, replacementJsp:50 }),
  Object.freeze({ productSku:'VTB01-4', orderSku:'7VTBD410AB', group:'subcontract', planningVelocity:4, order:10, amazon:4, jsp:10, replacementJsp:20 }),
]);

export const SANITIZED_H10_TEXT = [
  'B000000001 TTS05AM-1 4',
  'B000000002 TTS05AM-1 8',
  'B000000003 GTSL01 6',
  'B000000004 VTB01-4 4',
  'B000000005 EZD011AM 2',
  'B000000006 1MHTD011A0 3',
].join('\n');

function workbookBuffer(sheets) {
  const workbook = XLSX.utils.book_new();
  for (const [name, rows] of sheets) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), name);
  }
  return Buffer.from(XLSX.write(workbook, { type:'buffer', bookType:'xlsx', compression:true }));
}

function filePayload(name, buffer, mimeType = XLSX_MIME) {
  return { name, mimeType, buffer, lastModified:FIXTURE_LAST_MODIFIED };
}

function createJamWorkbook() {
  const rows = [
    ['品號 (productCode)', 'JAM 9001', '尚未到美國倉庫（包含預計補貨品）'],
    ['', '2026-09-01', ''],
    ['', '2026-10-01', ''],
    ['', '', ''],
    ['EZD011AM', 4, 4],
    ['1MHTD011A0', 6, 6],
    ['TTS05AM-1', 20, 20],
    ['GTSL01', 12, 12],
    ['VTB01-4', 40, 40],
  ];
  return workbookBuffer([['美國總表', rows]]);
}

function createH10InventoryWorkbook() {
  const rows = [
    ['SKU', 'Sellable Inventory', 'Inbound', 'Days of Supply'],
    ['EZD011AM', 2, 0, 1],
    ['1MHTD011A0', 3, 0, 1],
    ['TTS05AM-1', 0, 0, 0],
    ['GTSL01', 6, 0, 1],
    ['VTB01-4', 4, 0, 1],
  ];
  return workbookBuffer([['Inventory', rows]]);
}

function createJspWorkbook({ replacement = false } = {}) {
  const rows = [
    ['Sanitized fixture as of', '8/28/2026'],
    ['SKU', '總包數'],
    ['EZD011AM', replacement ? 20 : 2],
    ['1MHTD011A0', replacement ? 30 : 3],
    ['TTS05AM-1', replacement ? 50 : 5],
    ['GTSL01', replacement ? 50 : 5],
    ['VTB01-4', replacement ? 80 : 40],
  ];
  return workbookBuffer([['JSP Inventory', rows]]);
}

export function createSanitizedSupplyFixture() {
  const jam = filePayload('sanitized-jam.xlsx', createJamWorkbook());
  const h10Inventory = filePayload('sanitized-h10-inventory.xlsx', createH10InventoryWorkbook());
  const jsp = filePayload('sanitized-jsp-inventory.xlsx', createJspWorkbook());
  const replacementJsp = filePayload('sanitized-jsp-replacement.xlsx', createJspWorkbook({ replacement:true }));
  const h10Text = filePayload('Helium10_原始文字.txt', Buffer.from(SANITIZED_H10_TEXT, 'utf8'), 'text/plain');
  const cloudFiles = [jam, h10Inventory, jsp, h10Text];
  return {
    jam,
    h10Inventory,
    jsp,
    replacementJsp,
    h10Text,
    masterFiles:[jam, h10Inventory, jsp],
    replacementMasterFiles:[jam, h10Inventory, replacementJsp],
    cloudFiles,
    byName:new Map(cloudFiles.map(file => [file.name, file])),
  };
}
