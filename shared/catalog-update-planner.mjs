/* Browser-only raw workbook planning seam. Keep Supply and FBA copies byte-identical. */
import { createCatalogChangePlan } from './catalog-update-change-plan.mjs';
import {
  applyExplicitRawClears,
  CLEARABLE_FIELDS,
  overlayRawProductCatalog,
} from './catalog-update-overlay.mjs';
import { assertNewCatalogVersion, nextCatalogVersion } from './catalog-update-release.mjs';
import { migrateCatalog, validateCatalog } from './catalog-update-product-catalog.mjs';

export const MAX_RAW_WORKBOOK_BYTES = 32 * 1024 * 1024;
const RAW_EXCEL = /\.(?:xlsx|xlsm|xls)$/i;

export class CatalogUpdatePlannerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CatalogUpdatePlannerError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new CatalogUpdatePlannerError(code, message);
}

function basename(value) {
  return String(value || '').split(/[\\/]/).pop().slice(0, 200);
}

function exactIsoTimestamp(value) {
  const timestamp = typeof value === 'string' ? value : '';
  if (Number.isNaN(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp) {
    fail('INVALID_TIMESTAMP', '產品資料更新時間必須是完整 ISO 時間');
  }
  return timestamp;
}

function taipeiDay(timestamp) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone:'Asia/Taipei', year:'numeric', month:'2-digit', day:'2-digit',
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function workbookBytes(value) {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  }
  fail('INVALID_WORKBOOK_BYTES', '無法讀取產品資訊 Excel');
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function ownerForSku(catalog, sku) {
  if (sku.startsWith('7')) return catalog.orderSkuAliases.find(item => item.orderSku === sku) || null;
  return catalog.products.find(item => item.productSku === sku) || null;
}

function currentPackaging(owner) {
  return owner?.packagingVersions?.find(item => item.version === owner.newOrderPackagingDefaultVersion)
    || owner?.packagingVersions?.find(item => item.effectiveTo === null)
    || null;
}

function known(value) {
  return value !== null && value !== undefined && value !== '';
}

function rawBlank(record, field) {
  if (field === 'standardFactory') return !record.origin;
  if (field === 'grossWeightKg') return !record.grossWeightLb;
  const value = record[field];
  return !known(value) || (Array.isArray(value) && value.length === 0);
}

function baselineValue(owner, field) {
  if (field === 'origin' || field === 'standardFactory') return owner?.[field] ?? null;
  if (field === 'grossWeightLb') {
    const packaging = currentPackaging(owner);
    return packaging?.grossWeightLb ?? (packaging?.grossWeightKg ? Math.round(packaging.grossWeightKg * 2.2046226218) : null);
  }
  return currentPackaging(owner)?.[field] ?? null;
}

function clearCandidatesForPayload(baseline, payload) {
  return payload.records.flatMap(record => {
    const owner = ownerForSku(baseline, record.sku);
    if (!owner) return [];
    const fields = [...CLEARABLE_FIELDS]
      .filter(field => field !== 'grossWeightKg')
      .filter(field => !(record.sku.startsWith('7') && [
        'origin', 'standardFactory',
      ].includes(field)))
      .filter(field => rawBlank(record, field) && known(baselineValue(owner, field)))
      .map(field => ({ field, before:clone(baselineValue(owner, field)) }));
    return fields.length ? [{ sku:record.sku, fields }] : [];
  });
}

function normalizedExplicitClears(value, candidates) {
  const candidateFields = new Set(candidates.flatMap(item => item.fields.map(field => `${item.sku}\u0000${field.field}`)));
  const rows = value instanceof Map
    ? [...value].map(([sku, fields]) => ({ sku, fields:[...fields] }))
    : Array.isArray(value) ? value : Object.entries(value || {}).map(([sku, fields]) => ({ sku, fields }));
  const result = new Map();
  for (const row of rows) {
    const sku = String(row?.sku || '').trim().toUpperCase();
    const fields = Array.isArray(row?.fields) ? row.fields : [];
    if (!sku || !fields.length) continue;
    const unique = [...new Set(fields.map(String))];
    for (const field of unique) {
      if (!CLEARABLE_FIELDS.has(field) || !candidateFields.has(`${sku}\u0000${field}`)) {
        fail('INVALID_EXPLICIT_CLEAR', `${sku}.${field} 不是可明確清空的空白來源欄位`);
      }
    }
    result.set(sku, unique);
  }
  return result;
}

export function nextCatalogUpdateVersion(currentVersion, generatedAt, requestedVersion = null) {
  const timestamp = exactIsoTimestamp(generatedAt);
  try {
    return requestedVersion
      ? assertNewCatalogVersion(currentVersion, requestedVersion)
      : nextCatalogVersion(currentVersion, taipeiDay(timestamp));
  } catch (error) {
    fail('INVALID_CANDIDATE_VERSION', error?.message || '候選產品資料版本不正確');
  }
}

export async function planRawProductCatalogUpdate({
  workbookData,
  sourceFile,
  baselineCatalog,
  xlsxRef = globalThis.XLSX,
  rawCatalogApi = globalThis.JSPSharedProductCatalog,
  generatedAt = new Date().toISOString(),
  candidateVersion = null,
  explicitClears = null,
} = {}) {
  const cleanSourceFile = basename(sourceFile);
  if (!cleanSourceFile || !RAW_EXCEL.test(cleanSourceFile)) {
    fail('UNSUPPORTED_WORKBOOK', '請選擇 .xlsx、.xlsm 或 .xls 的原始產品資訊 Excel');
  }
  if (!xlsxRef?.read || !xlsxRef?.utils?.sheet_to_json) {
    fail('XLSX_UNAVAILABLE', '本機 Excel 讀取元件尚未準備完成');
  }
  if (!rawCatalogApi?.isRawWorkbook || !rawCatalogApi?.createPayload) {
    fail('RAW_PARSER_UNAVAILABLE', '原始產品資訊解析器尚未準備完成');
  }

  const bytes = workbookBytes(workbookData);
  if (!bytes.byteLength) fail('EMPTY_WORKBOOK', '產品資訊 Excel 是空白檔案');
  if (bytes.byteLength > MAX_RAW_WORKBOOK_BYTES) fail('WORKBOOK_TOO_LARGE', '產品資訊 Excel 超過 32 MB');

  let baseline;
  try {
    baseline = migrateCatalog(baselineCatalog);
    validateCatalog(baselineCatalog);
  } catch (error) {
    fail('INVALID_BASELINE', `內建產品資料基準無法使用：${error?.message || '格式不正確'}`);
  }

  const timestamp = exactIsoTimestamp(generatedAt);
  const version = nextCatalogUpdateVersion(baseline.catalogVersion, timestamp, candidateVersion);
  let workbook;
  try {
    workbook = xlsxRef.read(bytes, { type:'array', cellDates:true });
  } catch (_) {
    fail('WORKBOOK_READ_FAILED', '產品資訊 Excel 無法讀取，請確認檔案沒有損毀或密碼保護');
  }
  if (!rawCatalogApi.isRawWorkbook(workbook)) {
    fail('RAW_SHEETS_MISSING', '找不到「AMZ 所有SKU」、「2026」或「罐頭」工作表');
  }

  let payload;
  let overlay;
  try {
    payload = rawCatalogApi.createPayload(workbook, xlsxRef, {
      sourceFile:cleanSourceFile,
      updatedAt:timestamp,
      baseCatalogVersion:baseline.catalogVersion,
    });
    const clearCandidates = clearCandidatesForPayload(baseline, payload);
    const clears = normalizedExplicitClears(explicitClears, clearCandidates);
    payload = applyExplicitRawClears(payload, [...clears].map(([sku, fields]) => ({ sku, fields })));
    overlay = overlayRawProductCatalog(baseline, payload, { catalogVersion:version });
    payload.clearCandidates = clearCandidates;
  } catch (error) {
    if (error instanceof CatalogUpdatePlannerError) throw error;
    fail('RAW_IMPORT_FAILED', error?.message || '原始產品資訊無法轉成候選產品資料');
  }

  const importStats = Object.freeze({
    ...overlay.stats,
    rawRecords:payload.records.length,
    skippedRawRecords:payload.stats.skipped,
    duplicateConflicts:payload.stats.duplicateConflicts,
    sourceConflicts:payload.conflicts,
    matchedSheets:payload.matchedSheets.map(name => name.trim()),
  });
  const plan = await createCatalogChangePlan(baseline, overlay.catalog, {
    generatedAt:timestamp,
    sourceFile:cleanSourceFile,
    conflicts:importStats.sourceConflicts,
    duplicateConflicts:importStats.duplicateConflicts,
    rawSources:payload.records.map(record => ({
      sku:record.sku,
      sourceSheet:record.sourceSheet,
      sourceRow:record.sourceRow,
    })),
  });
  return Object.freeze({
    plan,
    candidateCatalog:overlay.catalog,
    importStats,
    clearCandidates:Object.freeze(payload.clearCandidates.map(clone)),
  });
}
