const CATALOG_VERSION = /^(\d{4}-\d{2}-\d{2})(?:\.(\d+))?$/;

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function parseVersion(value) {
  const match = String(value || '').match(CATALOG_VERSION);
  if (!match) throw new Error(`Invalid catalog version: ${value}`);
  return { date:match[1], sequence:match[2] ? Number(match[2]) : 1 };
}

export function nextCatalogVersion(currentVersion, releaseDate) {
  const current = parseVersion(currentVersion);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(releaseDate || ''))) {
    throw new Error(`Invalid release date: ${releaseDate}`);
  }
  if (releaseDate < current.date) {
    throw new Error(`Release date ${releaseDate} precedes current catalog ${currentVersion}`);
  }
  if (releaseDate > current.date) return releaseDate;
  return `${releaseDate}.${current.sequence + 1}`;
}

export function assertNewCatalogVersion(currentVersion, requestedVersion) {
  const current = parseVersion(currentVersion);
  const requested = parseVersion(requestedVersion);
  const newer = requested.date > current.date
    || (requested.date === current.date && requested.sequence > current.sequence);
  if (!newer) throw new Error(`Catalog version ${requestedVersion} must be newer than ${currentVersion}`);
  return requestedVersion;
}

function currentPackaging(owner) {
  return owner?.packagingVersions?.find(packaging => packaging?.effectiveTo === null) || null;
}

function cartonDimensionsIn(packaging) {
  if (!Array.isArray(packaging?.cartonDimensionsCm) || packaging.cartonDimensionsCm.length !== 3) return null;
  return packaging.cartonDimensionsCm.map(value => Math.round(Number(value) / 2.54));
}

function grossWeightLb(packaging) {
  const lb = Number(packaging?.grossWeightLb);
  if (Number.isFinite(lb) && lb > 0) return Math.round(lb);
  const kg = Number(packaging?.grossWeightKg);
  return Number.isFinite(kg) && kg > 0 ? Math.round(kg * 2.2046226218) : null;
}

function packagingFacts(owner) {
  const packaging = currentPackaging(owner);
  return {
    unitsPerCarton:packaging?.unitsPerCarton ?? null,
    cartonsPerPallet:packaging?.cartonsPerPallet ?? null,
    cartonDimensionsIn:cartonDimensionsIn(packaging),
    grossWeightLb:grossWeightLb(packaging),
  };
}

function entryFacts(entryType, owner) {
  if (entryType === 'product') {
    return {
      productName:owner.productName,
      origin:owner.origin,
      standardFactory:owner.standardFactory,
      lifecycle:owner.lifecycle,
      canonicalProductSku:owner.productSku,
      ...packagingFacts(owner),
    };
  }
  return {
    productName:null,
    origin:null,
    standardFactory:null,
    lifecycle:owner.lifecycle,
    canonicalProductSku:owner.canonicalProductSku,
    ...packagingFacts(owner),
  };
}

function catalogEntries(catalog) {
  const entries = new Map();
  for (const product of catalog.products || []) {
    entries.set(`product:${product.productSku}`, {
      entryType:'product',
      sku:product.productSku,
      facts:entryFacts('product', product),
    });
  }
  for (const alias of catalog.orderSkuAliases || []) {
    entries.set(`order-sku-alias:${alias.orderSku}`, {
      entryType:'order-sku-alias',
      sku:alias.orderSku,
      facts:entryFacts('order-sku-alias', alias),
    });
  }
  return entries;
}

function changedFields(before, after) {
  const fields = [];
  for (const field of Object.keys(after || before || {})) {
    if (JSON.stringify(before?.[field] ?? null) === JSON.stringify(after?.[field] ?? null)) continue;
    fields.push({ field, before:clone(before?.[field] ?? null), after:clone(after?.[field] ?? null) });
  }
  return fields;
}

export function createCatalogReleaseReport(beforeCatalog, afterCatalog, metadata = {}) {
  const beforeEntries = catalogEntries(beforeCatalog);
  const afterEntries = catalogEntries(afterCatalog);
  const keys = [...new Set([...beforeEntries.keys(), ...afterEntries.keys()])].sort();
  const changes = [];
  for (const key of keys) {
    const before = beforeEntries.get(key) || null;
    const after = afterEntries.get(key) || null;
    const fields = changedFields(before?.facts, after?.facts);
    if (before && after && fields.length === 0) continue;
    changes.push({
      entryType:(after || before).entryType,
      sku:(after || before).sku,
      changeType:before ? (after ? 'updated' : 'removed') : 'added',
      fields,
      before:clone(before?.facts ?? null),
      after:clone(after?.facts ?? null),
    });
  }
  const count = changeType => changes.filter(change => change.changeType === changeType).length;
  return {
    schemaVersion:1,
    fromCatalogVersion:beforeCatalog.catalogVersion,
    toCatalogVersion:afterCatalog.catalogVersion,
    generatedAt:metadata.generatedAt || new Date().toISOString(),
    sourceFile:metadata.sourceFile || null,
    stats:{
      productsBefore:(beforeCatalog.products || []).length,
      productsAfter:(afterCatalog.products || []).length,
      aliasesBefore:(beforeCatalog.orderSkuAliases || []).length,
      aliasesAfter:(afterCatalog.orderSkuAliases || []).length,
      added:count('added'),
      updated:count('updated'),
      removed:count('removed'),
      changedEntries:changes.length,
    },
    changes,
  };
}

export function catalogReleaseBlockers(report) {
  const blockers = [];
  const packagingFields = new Set(['unitsPerCarton', 'cartonsPerPallet', 'cartonDimensionsIn', 'grossWeightLb']);
  for (const change of report.changes || []) {
    if (change.changeType === 'removed') blockers.push(`${change.sku} would be removed`);
    for (const field of change.fields || []) {
      if (change.entryType === 'order-sku-alias' && field.field === 'canonicalProductSku' && field.before !== field.after) {
        blockers.push(`${change.sku} approved alias owner would change from ${field.before ?? 'null'} to ${field.after ?? 'null'}`);
      }
      if (field.field === 'lifecycle' && field.before === 'active' && field.after === 'incomplete') {
        blockers.push(`${change.sku} would regress from active to incomplete`);
      }
      if (packagingFields.has(field.field) && field.before !== null && field.after === null) {
        blockers.push(`${change.sku}.${field.field} would lose a known value`);
      }
    }
  }
  return blockers;
}

function shown(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return value.join('×');
  return String(value);
}

export function renderCatalogReleaseReport(report) {
  const lines = [
    `產品資料 ${report.fromCatalogVersion} → ${report.toCatalogVersion}`,
    `變更 ${report.stats.changedEntries} 筆（新增 ${report.stats.added}、更新 ${report.stats.updated}、移除 ${report.stats.removed}）`,
  ];
  for (const change of report.changes) {
    const details = change.fields.map(field => `${field.field}: ${shown(field.before)} → ${shown(field.after)}`).join('；');
    lines.push(`- ${change.sku} [${change.changeType}]${details ? ` ${details}` : ''}`);
  }
  return `${lines.join('\n')}\n`;
}
