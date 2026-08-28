import { migrateCatalog, validateCatalog } from './product-catalog.js';

export const PRODUCT_MASTER_SHEET = '產品主檔';
export const PRODUCT_MASTER_TABLE = 'ProductMasterTable';
export const PRODUCT_MASTER_HEADERS = Object.freeze([
  'Product SKU', '品名', '實際產地', '標準下單廠別', '核准替代下單品號',
  '包裝版本', '生效日期', '失效日期', '新訂單預設', '包裝模式',
  '箱入數', '每包單位數', '每盒單位數', '箱／棧板',
  '箱長(cm)', '箱寬(cm)', '箱高(cm)', '箱毛重(kg)', '箱毛重(lb)',
  '產品狀態', '資料來源工作表', '來源列', '備註', '發布檢查',
]);
export const ORDER_SKU_PACKAGING_SHEET = '下單品號箱規';
export const ORDER_SKU_PACKAGING_TABLE = 'OrderSkuPackagingTable';
export const ORDER_SKU_PACKAGING_HEADERS = Object.freeze([
  'Order SKU', '對應 Product SKU', 'Alias 狀態',
  '包裝版本', '生效日期', '失效日期', '新訂單預設', '包裝模式',
  '箱入數', '每包單位數', '每盒單位數', '箱／棧板',
  '箱長(cm)', '箱寬(cm)', '箱高(cm)', '箱毛重(kg)', '箱毛重(lb)',
  '資料來源工作表', '來源列', '備註', '發布檢查',
]);

const ORIGINS = new Map([
  ['台灣', 'TW'], ['TW', 'TW'],
  ['越南', 'VN'], ['VN', 'VN'],
  ['柬埔寨', 'KH'], ['KH', 'KH'],
  ['其他', 'OTHER'], ['OTHER', 'OTHER'],
  ['待補', null],
]);
const FACTORIES = new Map([
  ['台灣', 'TW'], ['TW', 'TW'],
  ['越南', 'VN'], ['VN', 'VN'],
  ['其他', 'OTHER'], ['OTHER', 'OTHER'],
  ['待補', null],
]);
const LIFECYCLES = new Map([['正常', 'active'], ['資料待補', 'incomplete'], ['停產', 'retired']]);
const ORDER_UNITS = new Map([['單品', 'single'], ['包裝', 'pack'], ['盒裝', 'box']]);
const ORDER_SKU_ALIAS_LIFECYCLES = new Map([
  ['核准', 'approved'], ['APPROVED', 'approved'],
  ['未映射舊品號', 'unmapped-legacy'], ['UNMAPPED-LEGACY', 'unmapped-legacy'],
]);
const LEGACY_PRODUCT_MASTER_HEADERS = Object.freeze(PRODUCT_MASTER_HEADERS.map((header, index) => index === 8 ? '現行版本' : header));
const LEGACY_ORDER_SKU_PACKAGING_HEADERS = Object.freeze(ORDER_SKU_PACKAGING_HEADERS.map((header, index) => index === 6 ? '現行版本' : header));

function text(value) {
  return value === null || value === undefined ? '' : String(value).trim();
}

function numberOrNull(value) {
  if (value === null || value === undefined || text(value) === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : value;
}

function isoDate(value, path) {
  if (value === null || value === undefined || text(value) === '') return null;
  if (value instanceof Date && !Number.isNaN(value.valueOf())) {
    const year = String(value.getFullYear()).padStart(4, '0');
    const month = String(value.getMonth() + 1).padStart(2, '0');
    const day = String(value.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(Math.round((value - 25569) * 86400) * 1000).toISOString().slice(0, 10);
  }
  const normalized = text(value).replaceAll('/', '-');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) throw new Error(`${path} must be a date`);
  return normalized;
}

function mapped(value, mapping, path) {
  const key = text(value).toUpperCase();
  if (!mapping.has(key)) throw new Error(`${path} has unsupported value ${text(value) || '(blank)'}`);
  return mapping.get(key);
}

function aliases(value) {
  if (!text(value)) return [];
  return text(value).split(/[;；]/).map(part => part.trim().toUpperCase()).filter(Boolean);
}

function stableProductFields(row, rowNumber) {
  const productSku = text(row[0]).toUpperCase();
  const productName = text(row[1]);
  const origin = mapped(row[2], ORIGINS, `row ${rowNumber} origin`);
  const standardFactory = mapped(row[3], FACTORIES, `row ${rowNumber} standard factory`);
  const alternateOrderSkus = aliases(row[4]);
  const lifecycle = mapped(row[19], LIFECYCLES, `row ${rowNumber} lifecycle`);
  return { productSku, productName, origin, standardFactory, alternateOrderSkus, lifecycle };
}

function packagingFromRow(row, rowNumber, schemaVersion) {
  const isDefault = text(row[8]);
  if (isDefault !== '是' && isDefault !== '否') throw new Error(`row ${rowNumber} new-order default must be 是 or 否`);
  const effectiveTo = isoDate(row[7], `row ${rowNumber} effective date end`);
  if (schemaVersion === 2 && (isDefault === '是') !== (effectiveTo === null)) {
    throw new Error(`row ${rowNumber} current version and effective date end disagree`);
  }
  const kind = mapped(row[9], ORDER_UNITS, `row ${rowNumber} order unit`);
  const packUnits = numberOrNull(row[11]);
  const boxUnits = numberOrNull(row[12]);
  if (kind === 'pack' && boxUnits !== null) throw new Error(`row ${rowNumber} pack product must not set box units`);
  if (kind === 'box' && packUnits !== null) throw new Error(`row ${rowNumber} box product must not set pack units`);
  if (kind === 'single' && (packUnits !== null || boxUnits !== null)) {
    throw new Error(`row ${rowNumber} single product must not set pack or box units`);
  }

  const cartonDimensionsCm = [numberOrNull(row[14]), numberOrNull(row[15]), numberOrNull(row[16])];
  const packaging = {
    version:text(row[5]),
    effectiveFrom:isoDate(row[6], `row ${rowNumber} effective date start`),
    effectiveTo,
    unitsPerCarton:numberOrNull(row[10]),
    cartonsPerPallet:numberOrNull(row[13]),
    cartonDimensionsCm:cartonDimensionsCm.every(value => value === null) ? null : cartonDimensionsCm,
    grossWeightKg:numberOrNull(row[17]),
    grossWeightLb:numberOrNull(row[18]),
    orderUnit:{
      kind,
      units:kind === 'pack' ? packUnits : kind === 'box' ? boxUnits : 1,
    },
  };
  const sourceSheet = text(row[20]);
  const sourceRow = numberOrNull(row[21]);
  const initialSource = sourceSheet === '初始共用主檔' && sourceRow === null;
  if (!initialSource && (sourceSheet || sourceRow !== null)) {
    if (!sourceSheet || !Number.isInteger(sourceRow) || sourceRow <= 0) {
      throw new Error(`row ${rowNumber} source sheet and source row must be provided together`);
    }
    packaging.source = { sheet:sourceSheet, row:sourceRow };
  }
  return { packaging, isDefault:isDefault === '是' };
}

function stableSignature(fields) {
  return JSON.stringify([
    fields.productName,
    fields.origin,
    fields.standardFactory,
    fields.alternateOrderSkus,
    fields.lifecycle,
  ]);
}

function orderSkuPackagingFromRow(row, rowNumber, schemaVersion) {
  const isDefault = text(row[6]);
  if (isDefault !== '是' && isDefault !== '否') throw new Error(`row ${rowNumber} new-order default must be 是 or 否`);
  const effectiveTo = isoDate(row[5], `row ${rowNumber} effective date end`);
  if (schemaVersion === 2 && (isDefault === '是') !== (effectiveTo === null)) {
    throw new Error(`row ${rowNumber} current version and effective date end disagree`);
  }
  const kind = mapped(row[7], ORDER_UNITS, `row ${rowNumber} order unit`);
  const packUnits = numberOrNull(row[9]);
  const boxUnits = numberOrNull(row[10]);
  if (kind === 'pack' && boxUnits !== null) throw new Error(`row ${rowNumber} pack product must not set box units`);
  if (kind === 'box' && packUnits !== null) throw new Error(`row ${rowNumber} box product must not set pack units`);
  if (kind === 'single' && (packUnits !== null || boxUnits !== null)) {
    throw new Error(`row ${rowNumber} single product must not set pack or box units`);
  }
  const cartonDimensionsCm = [numberOrNull(row[12]), numberOrNull(row[13]), numberOrNull(row[14])];
  const packaging = {
    version:text(row[3]),
    effectiveFrom:isoDate(row[4], `row ${rowNumber} effective date start`),
    effectiveTo,
    unitsPerCarton:numberOrNull(row[8]),
    cartonsPerPallet:numberOrNull(row[11]),
    cartonDimensionsCm:cartonDimensionsCm.every(value => value === null) ? null : cartonDimensionsCm,
    grossWeightKg:numberOrNull(row[15]),
    grossWeightLb:numberOrNull(row[16]),
    orderUnit:{
      kind,
      units:kind === 'pack' ? packUnits : kind === 'box' ? boxUnits : 1,
    },
  };
  const sourceSheet = text(row[17]);
  const sourceRow = numberOrNull(row[18]);
  const initialSource = sourceSheet === '初始共用主檔' && sourceRow === null;
  if (!initialSource && (sourceSheet || sourceRow !== null)) {
    if (!sourceSheet || !Number.isInteger(sourceRow) || sourceRow <= 0) {
      throw new Error(`row ${rowNumber} source sheet and source row must be provided together`);
    }
    packaging.source = { sheet:sourceSheet, row:sourceRow };
  }
  return { packaging, isDefault:isDefault === '是' };
}

function workbookMetadata(rows, sheetName) {
  if (!Array.isArray(rows) || rows.length < 5) throw new Error(`${sheetName} does not contain its required rows`);
  return {
    schemaVersion:Number(rows[2]?.[1]),
    catalogVersion:text(rows[2]?.[3]),
  };
}

function orderSkuAliasesFromRows(rows, expectedMetadata) {
  const metadata = workbookMetadata(rows, ORDER_SKU_PACKAGING_SHEET);
  if (metadata.schemaVersion !== expectedMetadata.schemaVersion || metadata.catalogVersion !== expectedMetadata.catalogVersion) {
    throw new Error(`${ORDER_SKU_PACKAGING_SHEET} metadata must match ${PRODUCT_MASTER_SHEET}`);
  }
  const headers = (rows[4] || []).map(text);
  while (headers.at(-1) === '') headers.pop();
  const expectedHeaders = metadata.schemaVersion === 2
    ? LEGACY_ORDER_SKU_PACKAGING_HEADERS
    : ORDER_SKU_PACKAGING_HEADERS;
  if (JSON.stringify(headers) !== JSON.stringify(expectedHeaders)) {
    throw new Error(`${ORDER_SKU_PACKAGING_SHEET} row 5 headers do not match the release contract`);
  }
  const aliases = [];
  const byOrderSku = new Map();
  for (let index = 5; index < rows.length; index += 1) {
    const row = rows[index] || [];
    const rowNumber = index + 1;
    if (row.slice(0, 19).every(value => text(value) === '')) continue;
    const orderSku = text(row[0]).toUpperCase();
    const canonicalProductSku = text(row[1]).toUpperCase() || null;
    const lifecycle = mapped(row[2], ORDER_SKU_ALIAS_LIFECYCLES, `row ${rowNumber} alias lifecycle`);
    if (!orderSku) throw new Error(`row ${rowNumber} is missing Order SKU`);
    const stable = JSON.stringify([canonicalProductSku, lifecycle]);
    let alias = byOrderSku.get(orderSku);
    if (!alias) {
      alias = { orderSku, canonicalProductSku, lifecycle, packagingVersions:[] };
      if (metadata.schemaVersion === 3) alias.newOrderPackagingDefaultVersion = null;
      Object.defineProperty(alias, '__stable', { value:stable });
      byOrderSku.set(orderSku, alias);
      aliases.push(alias);
    } else if (alias.__stable !== stable) {
      throw new Error(`row ${rowNumber} changes stable fields for Order SKU ${orderSku}`);
    }
    const parsed = orderSkuPackagingFromRow(row, rowNumber, metadata.schemaVersion);
    alias.packagingVersions.push(parsed.packaging);
    if (metadata.schemaVersion === 3 && parsed.isDefault) {
      if (alias.newOrderPackagingDefaultVersion) throw new Error(`row ${rowNumber} gives ${orderSku} more than one new-order default`);
      alias.newOrderPackagingDefaultVersion = parsed.packaging.version;
    }
  }
  return aliases;
}

export function catalogFromProductMasterRows(rows, orderSkuRows) {
  const metadata = workbookMetadata(rows, PRODUCT_MASTER_SHEET);
  if (![2, 3].includes(metadata.schemaVersion)) throw new Error(`${PRODUCT_MASTER_SHEET} schemaVersion must be 2 or 3`);
  const headers = (rows[4] || []).map(text);
  while (headers.at(-1) === '') headers.pop();
  const expectedHeaders = metadata.schemaVersion === 2 ? LEGACY_PRODUCT_MASTER_HEADERS : PRODUCT_MASTER_HEADERS;
  if (JSON.stringify(headers) !== JSON.stringify(expectedHeaders)) {
    throw new Error('產品主檔 row 5 headers do not match the release contract');
  }
  const { schemaVersion, catalogVersion } = metadata;
  const products = [];
  const bySku = new Map();

  for (let index = 5; index < rows.length; index += 1) {
    const row = rows[index] || [];
    const rowNumber = index + 1;
    if (row.slice(0, 22).every(value => text(value) === '')) continue;
    const fields = stableProductFields(row, rowNumber);
    if (!fields.productSku) throw new Error(`row ${rowNumber} is missing Product SKU`);
    let product = bySku.get(fields.productSku);
    if (!product) {
      product = {
        productSku:fields.productSku,
        productName:fields.productName,
        origin:fields.origin,
        standardFactory:fields.standardFactory,
        lifecycle:fields.lifecycle,
        approvedOrderSkus:[fields.productSku, ...fields.alternateOrderSkus],
        packagingVersions:[],
      };
      if (schemaVersion === 3) product.newOrderPackagingDefaultVersion = null;
      Object.defineProperty(product, '__stable', { value:stableSignature(fields) });
      bySku.set(fields.productSku, product);
      products.push(product);
    } else if (product.__stable !== stableSignature(fields)) {
      throw new Error(`row ${rowNumber} changes stable fields for Product SKU ${fields.productSku}`);
    }
    const parsed = packagingFromRow(row, rowNumber, schemaVersion);
    product.packagingVersions.push(parsed.packaging);
    if (schemaVersion === 3 && parsed.isDefault) {
      if (product.newOrderPackagingDefaultVersion) throw new Error(`row ${rowNumber} gives ${fields.productSku} more than one new-order default`);
      product.newOrderPackagingDefaultVersion = parsed.packaging.version;
    }
  }

  const orderSkuAliases = orderSkuAliasesFromRows(orderSkuRows, metadata);
  const catalog = { schemaVersion, catalogVersion, products, orderSkuAliases };
  const migrated = migrateCatalog(catalog);
  validateCatalog(catalog);
  return migrated;
}
