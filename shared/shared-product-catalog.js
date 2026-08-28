(function initSharedProductCatalog(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (!root) return;
  root.JSPSharedProductCatalog = api;
  if (Array.isArray(root.allProductsData)) {
    root.SUPPLY_BUILTIN_PRODUCT_DATA = root.allProductsData.map(product => ({ ...product }));
    const payload = api.loadFromStorage(root.localStorage);
    if (payload) {
      const result = api.applyToSupplyProducts(root.allProductsData, payload);
      root.SUPPLY_SHARED_PRODUCT_CATALOG_META = Object.freeze({
        sourceFile:payload.sourceFile,
        updatedAt:payload.updatedAt,
        records:payload.records.length,
        added:result.added,
        updated:result.updated,
      });
    }
  }
})(typeof globalThis === 'object' ? globalThis : this, function sharedProductCatalogFactory() {
  'use strict';

  const STORAGE_KEY = 'jspusa:shared-product-catalog:v1';
  const SCHEMA_VERSION = 1;
  const WANTED_SHEETS = new Set(['AMZ所有SKU', '2026', '罐頭']);
  const ORIGINS = new Map([
    ['台灣', 'TW'], ['TW', 'TW'],
    ['越南', 'VN'], ['VN', 'VN'],
    ['柬埔寨', 'KH'], ['KH', 'KH'],
    ['其他', 'OTHER'], ['OTHER', 'OTHER'],
  ]);

  function text(value) {
    return value === null || value === undefined ? '' : String(value).trim();
  }

  function normalizeSku(value) {
    return text(value).toUpperCase();
  }

  function normalizeHeader(value) {
    return text(value).replace(/[\s\u3000\r\n]+/g, '').toLowerCase();
  }

  function normalizeSheet(value) {
    return text(value).replace(/[\s\u3000]+/g, '');
  }

  function positiveNumber(value) {
    if (typeof value === 'number' && Number.isFinite(value)) return value > 0 ? value : null;
    const match = text(value).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
    if (!match) return null;
    const number = Number(match[0]);
    return Number.isFinite(number) && number > 0 ? number : null;
  }

  function parseDimensionsCm(value) {
    const values = text(value).replace(/,/g, '.').match(/\d+(?:\.\d+)?/g)?.slice(0, 3).map(Number) || [];
    return values.length === 3 && values.every(number => Number.isFinite(number) && number > 0) ? values : null;
  }

  function originCode(value) {
    return ORIGINS.get(text(value).toUpperCase()) || null;
  }

  function findColumn(headers, tests) {
    for (let index = 0; index < headers.length; index += 1) {
      const header = normalizeHeader(headers[index]);
      if (tests.some(test => typeof test === 'string' ? header.includes(normalizeHeader(test)) : test.test(header))) return index;
    }
    return -1;
  }

  function headerLayout(name, rows) {
    let headerRow = -1;
    let sku = -1;
    for (let row = 0; row < Math.min(rows.length, 8); row += 1) {
      const index = (rows[row] || []).findIndex(value => normalizeHeader(value) === 'sku');
      if (index >= 0) { headerRow = row; sku = index; break; }
    }
    if (headerRow < 0) return null;
    const upper = rows[Math.max(0, headerRow - 1)] || [];
    const lower = rows[headerRow] || [];
    const combined = Array.from({ length:Math.max(upper.length, lower.length) }, (_, index) => `${upper[index] ?? ''}|${lower[index] ?? ''}`);
    const normalizedName = normalizeSheet(name);
    const fallback = normalizedName === 'AMZ所有SKU'
      ? { origin:2, quantity:4, dimensions:17, pallet:18, weightKg:21, weightLb:22 }
      : normalizedName === '2026'
        ? { origin:2, quantity:4, dimensions:12, pallet:13, weightKg:16, weightLb:17 }
        : { origin:-1, quantity:3, dimensions:12, pallet:-1, weightKg:15, weightLb:16 };
    const found = {
      origin:findColumn(combined, ['產地']),
      quantity:findColumn(combined, ['包數/箱', '罐數/箱', 'goi/thung', 'lon/thung']),
      dimensions:findColumn(combined, ['紙箱規格', 'quycachthung']),
      pallet:findColumn(combined, ['箱/棧板', '棧板/箱']),
      weightLb:findColumn(combined, [/(每箱產品的毛重|紙箱毛重|gw\/箱|gw\/thung).*\|.*lb/i, /gw.*\(lb\)/i]),
      weightKg:findColumn(combined, [/(每箱產品的毛重|紙箱毛重|gw\/箱|gw\/thung).*\|.*kg/i, /gw.*kg/i]),
    };
    for (const key of Object.keys(found)) if (found[key] < 0) found[key] = fallback[key];
    return { headerRow, sku, ...found };
  }

  function recordScore(record) {
    return Number(Boolean(record.origin))
      + Number(Boolean(record.unitsPerCarton))
      + Number(Boolean(record.cartonsPerPallet))
      + (record.cartonDimensionsCm ? 3 : 0)
      + Number(Boolean(record.grossWeightLb));
  }

  function coreComplete(record) {
    return Boolean(record.unitsPerCarton && record.cartonDimensionsCm && record.grossWeightLb);
  }

  function comparableRecord(record) {
    return JSON.stringify([
      record.origin,
      record.unitsPerCarton,
      record.cartonsPerPallet,
      record.cartonDimensionsCm,
      record.grossWeightLb,
    ]);
  }

  function isRawWorkbook(workbook) {
    return Boolean(workbook?.SheetNames?.some(name => WANTED_SHEETS.has(normalizeSheet(name))));
  }

  function createPayload(workbook, xlsx, options = {}) {
    if (!xlsx?.utils?.sheet_to_json) throw new Error('Excel 讀取元件尚未準備完成');
    const matchedSheets = (workbook?.SheetNames || []).filter(name => WANTED_SHEETS.has(normalizeSheet(name)));
    if (!matchedSheets.length) throw new Error('找不到「AMZ 所有SKU」、「2026」或「罐頭」工作表');
    const bySku = new Map();
    let skipped = 0;
    let duplicateConflicts = 0;

    for (const name of matchedSheets) {
      const rows = xlsx.utils.sheet_to_json(workbook.Sheets[name], { header:1, defval:'', raw:true });
      const layout = headerLayout(name, rows);
      if (!layout) { skipped += Math.max(0, rows.length - 2); continue; }
      for (let rowIndex = layout.headerRow + 1; rowIndex < rows.length; rowIndex += 1) {
        const row = rows[rowIndex] || [];
        const sku = normalizeSku(row[layout.sku]);
        if (!/^[0-9A-Z][0-9A-Z-]{2,19}$/.test(sku)) continue;
        const weightLb = positiveNumber(row[layout.weightLb]);
        const weightKg = positiveNumber(row[layout.weightKg]);
        const record = {
          sku,
          origin:layout.origin >= 0 ? originCode(row[layout.origin]) : null,
          unitsPerCarton:positiveNumber(row[layout.quantity]),
          cartonsPerPallet:layout.pallet >= 0 ? positiveNumber(row[layout.pallet]) : null,
          cartonDimensionsCm:parseDimensionsCm(row[layout.dimensions]),
          grossWeightLb:weightLb || (weightKg ? weightKg * 2.2046226218 : null),
          sourceSheet:text(name),
          sourceRow:rowIndex + 1,
        };
        if (!coreComplete(record)) skipped += 1;
        const existing = bySku.get(sku);
        if (!existing) { bySku.set(sku, record); continue; }
        if (comparableRecord(existing) !== comparableRecord(record)) duplicateConflicts += 1;
        if ((!coreComplete(existing) && coreComplete(record)) || (!coreComplete(existing) && recordScore(record) > recordScore(existing))) {
          bySku.set(sku, record);
        }
      }
    }

    return validatePayload({
      schemaVersion:SCHEMA_VERSION,
      sourceFile:text(options.sourceFile || '產品資訊 Excel').slice(0, 200),
      updatedAt:options.updatedAt || new Date().toISOString(),
      matchedSheets:matchedSheets.map(text),
      stats:{ skipped, duplicateConflicts },
      records:[...bySku.values()],
    });
  }

  function nullablePositive(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    if (!Number.isFinite(number) || number <= 0) throw new Error('共用產品資料含有無效數值');
    return number;
  }

  function validatePayload(payload) {
    if (!payload || Number(payload.schemaVersion) !== SCHEMA_VERSION || !Array.isArray(payload.records) || payload.records.length > 5000) {
      throw new Error('共用產品資料格式不相容');
    }
    const seen = new Set();
    const records = payload.records.map(item => {
      const sku = normalizeSku(item?.sku);
      if (!/^[0-9A-Z][0-9A-Z-]{2,19}$/.test(sku) || seen.has(sku)) throw new Error(`共用產品資料含有重複或無效 SKU：${sku || '(空白)'}`);
      seen.add(sku);
      const dimensions = item.cartonDimensionsCm == null ? null : item.cartonDimensionsCm.map(nullablePositive);
      if (dimensions && (dimensions.length !== 3 || dimensions.some(value => value === null))) throw new Error(`${sku} 的紙箱尺寸不完整`);
      const origin = item.origin == null ? null : text(item.origin).toUpperCase();
      if (origin && !['TW', 'VN', 'KH', 'OTHER'].includes(origin)) throw new Error(`${sku} 的產地無法辨識`);
      return {
        sku,
        origin,
        unitsPerCarton:nullablePositive(item.unitsPerCarton),
        cartonsPerPallet:nullablePositive(item.cartonsPerPallet),
        cartonDimensionsCm:dimensions,
        grossWeightLb:nullablePositive(item.grossWeightLb),
        sourceSheet:text(item.sourceSheet).slice(0, 100),
        sourceRow:Number.isInteger(Number(item.sourceRow)) && Number(item.sourceRow) > 0 ? Number(item.sourceRow) : null,
      };
    });
    return {
      schemaVersion:SCHEMA_VERSION,
      sourceFile:text(payload.sourceFile || '產品資訊 Excel').slice(0, 200),
      updatedAt:Number.isNaN(Date.parse(payload.updatedAt)) ? new Date().toISOString() : new Date(payload.updatedAt).toISOString(),
      matchedSheets:Array.isArray(payload.matchedSheets) ? payload.matchedSheets.map(name => text(name).slice(0, 100)) : [],
      stats:{
        skipped:Math.max(0, Number(payload.stats?.skipped) || 0),
        duplicateConflicts:Math.max(0, Number(payload.stats?.duplicateConflicts) || 0),
      },
      records,
    };
  }

  function saveToStorage(payload, storage) {
    const validated = validatePayload(payload);
    if (!storage?.setItem) throw new Error('這個瀏覽器無法保存共用產品資料');
    storage.setItem(STORAGE_KEY, JSON.stringify(validated));
    return validated;
  }

  function loadFromStorage(storage) {
    if (!storage?.getItem) return null;
    try {
      const raw = storage.getItem(STORAGE_KEY);
      return raw ? validatePayload(JSON.parse(raw)) : null;
    } catch (_) {
      return null;
    }
  }

  function removeFromStorage(storage) {
    storage?.removeItem?.(STORAGE_KEY);
  }

  function applyToFbaCatalog(baseCatalog, payload) {
    const validated = validatePayload(payload);
    const catalog = { ...(baseCatalog || {}) };
    let added = 0;
    let updated = 0;
    for (const record of validated.records) {
      const existing = catalog[record.sku] || {};
      const next = { ...existing };
      if (record.unitsPerCarton) next.units = Math.round(record.unitsPerCarton);
      if (record.cartonDimensionsCm) {
        [next.length, next.width, next.height] = record.cartonDimensionsCm.map(value => Math.round(value / 2.54));
      }
      if (record.grossWeightLb) next.weight = Math.round(record.grossWeightLb);
      next.source = `${validated.sourceFile} · ${record.sourceSheet}`;
      catalog[record.sku] = next;
      if (Object.hasOwn(baseCatalog || {}, record.sku)) updated += 1;
      else added += 1;
    }
    return { catalog, added, updated, total:Object.keys(catalog).length };
  }

  function formatDimension(value) {
    return String(Math.round(value * 100) / 100);
  }

  function supplyCountry(origin) {
    if (origin === 'TW') return 'TW';
    if (origin === 'VN' || origin === 'KH') return 'VN';
    if (origin === 'OTHER') return 'Others';
    return '';
  }

  function applyToSupplyProducts(products, payload) {
    const validated = validatePayload(payload);
    const next = (Array.isArray(products) ? products : []).map(product => ({ ...product }));
    const bySku = new Map(next.map((product, index) => [normalizeSku(product?.productCode), index]));
    let added = 0;
    let updated = 0;
    let skipped = 0;
    for (const record of validated.records) {
      if (record.sku.startsWith('7')) continue;
      const index = bySku.get(record.sku);
      if (index !== undefined) {
        const product = next[index];
        if (record.unitsPerCarton) product.perCarton = Math.round(record.unitsPerCarton);
        if (record.cartonsPerPallet) product.perPallet = record.cartonsPerPallet;
        if (record.cartonDimensionsCm) product.boxSize = record.cartonDimensionsCm.map(formatDimension).join('*');
        const country = supplyCountry(record.origin);
        if (country) product.country = country;
        updated += 1;
        continue;
      }
      const country = supplyCountry(record.origin);
      if (!record.unitsPerCarton || !record.cartonsPerPallet || !record.cartonDimensionsCm || !country) {
        skipped += 1;
        continue;
      }
      const product = {
        productCode:record.sku,
        productName:record.sku,
        boxSize:record.cartonDimensionsCm.map(formatDimension).join('*'),
        perCarton:Math.round(record.unitsPerCarton),
        perPack:null,
        perBox:null,
        perPallet:record.cartonsPerPallet,
        country,
      };
      bySku.set(record.sku, next.length);
      next.push(product);
      added += 1;
    }
    if (Array.isArray(products)) products.splice(0, products.length, ...next);
    return { products:next, added, updated, skipped };
  }

  return {
    STORAGE_KEY,
    SCHEMA_VERSION,
    isRawWorkbook,
    createPayload,
    validatePayload,
    saveToStorage,
    loadFromStorage,
    removeFromStorage,
    applyToFbaCatalog,
    applyToSupplyProducts,
  };
});
