import { createCatalogReleaseReport } from './product-catalog-release.js';
import {
  assertCatalogHistoryPreserved,
  migrateCatalog,
  validateCatalog,
} from './product-catalog.js';

const HIGH_RISK_FIELDS = new Set([
  'approvedOrderSkus',
  'canonicalProductSku',
  'lifecycle',
  'origin',
  'standardFactory',
]);

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function basename(value) {
  return String(value || '').split(/[\\/]/).pop().slice(0, 200);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
}

export function stableJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function publicCatalogSnapshot(catalog) {
  const snapshot = clone(catalog);
  for (const owner of [...(snapshot?.products || []), ...(snapshot?.orderSkuAliases || [])]) {
    for (const packaging of owner.packagingVersions || []) delete packaging.source;
  }
  return snapshot;
}

export async function publicCatalogSha256(catalog) {
  return sha256(publicCatalogSnapshot(catalog));
}

export async function sha256(value) {
  if (!globalThis.crypto?.subtle) throw new Error('SHA-256 is unavailable in this environment');
  const bytes = new TextEncoder().encode(typeof value === 'string' ? value : stableJson(value));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

function explicitDataLoss(field) {
  return field.before !== null && field.before !== undefined
    && (field.after === null || field.after === undefined || field.after === '');
}

function riskForChange(change) {
  if (change.changeType === 'removed') return 'blocking';
  if ((change.fields || []).some(field => HIGH_RISK_FIELDS.has(field.field) || explicitDataLoss(field))) return 'review';
  return 'safe';
}

function normalizeConflict(conflict, index) {
  const sku = String(conflict?.sku || '').trim().toUpperCase() || `UNKNOWN-${index + 1}`;
  const fields = Array.isArray(conflict?.fields) ? conflict.fields.map(item => ({
    field:String(item?.field || 'unknown'),
    values:Array.isArray(item?.values) ? item.values.map(value => ({
      value:clone(value?.value ?? null),
      sourceSheet:String(value?.sourceSheet || '').slice(0, 100),
      sourceRow:Number.isInteger(Number(value?.sourceRow)) ? Number(value.sourceRow) : null,
    })) : [],
  })) : [];
  return { sku, fields };
}

function conflictMessage(conflict) {
  const fields = conflict.fields.map(field => {
    const values = field.values.map(value => `${JSON.stringify(value.value)} (${value.sourceSheet || '工作表'} 第 ${value.sourceRow || '?'} 列)`).join(' / ');
    return `${field.field}: ${values}`;
  }).join('；');
  return `${conflict.sku} 在原始資料有衝突${fields ? `：${fields}` : ''}`;
}

function ownerForChange(catalog, change) {
  if (change.entryType === 'product') {
    return catalog.products.find(product => product.productSku === change.sku) || null;
  }
  return catalog.orderSkuAliases.find(alias => alias.orderSku === change.sku) || null;
}

function evidenceForChange(change, candidateCatalog, rawSourcesBySku = new Map()) {
  const owner = ownerForChange(candidateCatalog, change);
  const packaging = owner?.packagingVersions?.find(item => item.version === owner.newOrderPackagingDefaultVersion)
    || owner?.packagingVersions?.find(item => item.effectiveTo === null)
    || null;
  const rawSources = rawSourcesBySku.get(change.sku) || [];
  const sources = rawSources.length
    ? rawSources.map(source => ({
      sheet:String(source.sourceSheet || '').slice(0, 100),
      row:Number.isInteger(Number(source.sourceRow)) ? Number(source.sourceRow) : null,
      packagingVersion:packaging?.version || null,
    }))
    : packaging?.source ? [{
      sheet:String(packaging.source.sheet || '').slice(0, 100),
      row:Number.isInteger(Number(packaging.source.row)) ? Number(packaging.source.row) : null,
      packagingVersion:packaging.version || null,
    }] : [];
  const fields = new Set((change.fields || []).map(field => field.field));
  const impact = [];
  if (change.changeType === 'added') impact.push('new-public-catalog-entry');
  if ([...fields].some(field => ['packagingVersion', 'unitsPerCarton', 'cartonsPerPallet', 'cartonDimensionsIn', 'grossWeightLb'].includes(field))) {
    impact.push('future-order-packaging', 'supply-order-default', 'fba-carton-projection');
  }
  if (fields.has('origin') || fields.has('standardFactory')) impact.push('order-workbook-routing');
  if (fields.has('approvedOrderSkus') || fields.has('canonicalProductSku')) impact.push('sku-identity-mapping');
  if (fields.has('lifecycle')) impact.push('catalog-availability-and-history');
  if ((change.fields || []).some(explicitDataLoss)) impact.push('explicit-data-clear');
  return { sources, impact:[...new Set(impact)] };
}

function changeEntry(change, candidateCatalog, rawSourcesBySku) {
  const risk = riskForChange(change);
  return {
    id:`${change.entryType}:${change.sku}`,
    kind:'catalog-change',
    entryType:change.entryType,
    sku:change.sku,
    changeType:change.changeType,
    risk,
    selectable:risk !== 'blocking',
    selected:risk === 'safe',
    fields:clone(change.fields || []),
    before:clone(change.before),
    after:clone(change.after),
    evidence:evidenceForChange(change, candidateCatalog, rawSourcesBySku),
  };
}

export async function createCatalogChangePlan(beforeCatalog, candidateCatalog, metadata = {}) {
  validateCatalog(beforeCatalog);
  validateCatalog(candidateCatalog);
  const normalizedBefore = migrateCatalog(beforeCatalog);
  const normalizedCandidate = migrateCatalog(candidateCatalog);
  const generatedAt = metadata.generatedAt || new Date().toISOString();
  const report = createCatalogReleaseReport(normalizedBefore, normalizedCandidate, {
    generatedAt,
    sourceFile:basename(metadata.sourceFile),
  });
  const rawSourcesBySku = new Map();
  for (const source of metadata.rawSources || []) {
    const sku = String(source?.sku || '').trim().toUpperCase();
    if (!sku) continue;
    if (!rawSourcesBySku.has(sku)) rawSourcesBySku.set(sku, []);
    rawSourcesBySku.get(sku).push(source);
  }
  const entries = report.changes.map(change => changeEntry(change, normalizedCandidate, rawSourcesBySku));
  const conflicts = (metadata.conflicts || []).map(normalizeConflict);
  for (let index = 0; index < conflicts.length; index += 1) {
    const conflict = conflicts[index];
    entries.push({
      id:`source-conflict:${conflict.sku}:${index + 1}`,
      kind:'source-conflict',
      entryType:'source-conflict',
      sku:conflict.sku,
      changeType:'conflict',
      risk:'blocking',
      selectable:false,
      selected:false,
      fields:clone(conflict.fields),
      message:conflictMessage(conflict),
    });
  }
  const blockers = entries
    .filter(entry => entry.risk === 'blocking')
    .map(entry => entry.message || `${entry.sku} 不可在發布時被移除`);
  if (Number(metadata.duplicateConflicts) > conflicts.length) {
    blockers.push(`原始資料還有 ${Number(metadata.duplicateConflicts) - conflicts.length} 筆未能定位的重複衝突`);
  }
  const plan = {
    schemaVersion:1,
    generatedAt,
    sourceFile:basename(metadata.sourceFile),
    baseline:{
      catalogVersion:beforeCatalog.catalogVersion,
      sha256:await publicCatalogSha256(beforeCatalog),
    },
    candidate:{
      catalogVersion:candidateCatalog.catalogVersion,
      sha256:await publicCatalogSha256(candidateCatalog),
    },
    stats:{
      ...clone(report.stats),
      safe:entries.filter(entry => entry.risk === 'safe').length,
      review:entries.filter(entry => entry.risk === 'review').length,
      blocking:entries.filter(entry => entry.risk === 'blocking').length,
      selected:entries.filter(entry => entry.selected).length,
    },
    blockers,
    entries,
  };
  plan.planSha256 = await sha256(plan);
  return plan;
}

function selectedIds(plan, requested) {
  const defaults = (plan.entries || []).filter(entry => entry.selected).map(entry => entry.id);
  return [...new Set(requested === undefined ? defaults : requested.map(String))];
}

function candidateOwner(candidateCatalog, entry) {
  if (entry.entryType === 'product') {
    return candidateCatalog.products.find(product => product.productSku === entry.sku) || null;
  }
  if (entry.entryType === 'order-sku-alias') {
    return candidateCatalog.orderSkuAliases.find(alias => alias.orderSku === entry.sku) || null;
  }
  return null;
}

function replaceOwner(catalog, entry, owner) {
  const key = entry.entryType === 'product' ? 'products' : 'orderSkuAliases';
  const id = entry.entryType === 'product' ? 'productSku' : 'orderSku';
  const index = catalog[key].findIndex(item => item[id] === entry.sku);
  if (index < 0) catalog[key].push(clone(owner));
  else catalog[key].splice(index, 1, clone(owner));
}

export async function applyCatalogChangePlan(beforeCatalog, candidateCatalog, plan, options = {}) {
  if (!plan || plan.schemaVersion !== 1 || !Array.isArray(plan.entries)) throw new Error('產品資料變更計畫格式不正確');
  const baselineHash = await publicCatalogSha256(beforeCatalog);
  if (plan.baseline?.catalogVersion !== beforeCatalog.catalogVersion || plan.baseline?.sha256 !== baselineHash) {
    throw new Error('產品資料已在計畫建立後更新，請重新產生變更計畫');
  }
  const candidateHash = await publicCatalogSha256(candidateCatalog);
  if (plan.candidate?.catalogVersion !== candidateCatalog.catalogVersion || plan.candidate?.sha256 !== candidateHash) {
    throw new Error('候選產品資料與變更計畫不一致，請重新產生變更計畫');
  }
  if (plan.blockers?.length) throw new Error(`產品資料發布被阻擋：\n- ${plan.blockers.join('\n- ')}`);

  const chosen = selectedIds(plan, options.selectedEntryIds);
  const byId = new Map(plan.entries.map(entry => [entry.id, entry]));
  for (const id of chosen) {
    const entry = byId.get(id);
    if (!entry) throw new Error(`變更計畫不包含 ${id}`);
    if (!entry.selectable || entry.risk === 'blocking') throw new Error(`${id} 不可套用`);
  }

  const catalog = migrateCatalog(beforeCatalog);
  const normalizedCandidate = migrateCatalog(candidateCatalog);
  catalog.catalogVersion = normalizedCandidate.catalogVersion;
  for (const id of chosen) {
    const entry = byId.get(id);
    const owner = candidateOwner(normalizedCandidate, entry);
    if (!owner) throw new Error(`${entry.sku} 在候選產品資料中不存在`);
    replaceOwner(catalog, entry, owner);
  }
  try {
    assertCatalogHistoryPreserved(beforeCatalog, catalog);
    validateCatalog(catalog);
  } catch (error) {
    throw new Error(`選取的變更無法獨立套用，請一併選取相依資料：${error.message}`);
  }
  return {
    catalog,
    selectedEntryIds:chosen,
    skippedEntryIds:plan.entries.filter(entry => entry.kind === 'catalog-change' && !chosen.includes(entry.id)).map(entry => entry.id),
  };
}

export async function createCatalogChangeRecord(plan, appliedCatalog, selectedEntryIds, metadata = {}) {
  const selected = [...new Set((selectedEntryIds || []).map(String))];
  const changes = selected.map(id => {
    const entry = plan.entries.find(item => item.id === id);
    if (!entry || entry.kind !== 'catalog-change') throw new Error(`變更計畫不包含可記錄的 ${id}`);
    return {
      id:entry.id,
      entryType:entry.entryType,
      sku:entry.sku,
      changeType:entry.changeType,
      risk:entry.risk,
      fields:clone(entry.fields || []),
    };
  });
  return {
    schemaVersion:1,
    previousCatalogVersion:plan.baseline.catalogVersion,
    catalogVersion:appliedCatalog.catalogVersion,
    baselineSha256:plan.baseline.sha256,
    catalogSha256:await sha256(appliedCatalog),
    planSha256:plan.planSha256,
    appliedAt:metadata.appliedAt || new Date().toISOString(),
    selectedEntryIds:selected,
    changes,
    catalogAlignment:metadata.catalogAlignment ? clone(metadata.catalogAlignment) : null,
    stats:{
      selected:selected.length,
      safe:selected.filter(id => plan.entries.find(entry => entry.id === id)?.risk === 'safe').length,
      reviewed:selected.filter(id => plan.entries.find(entry => entry.id === id)?.risk === 'review').length,
    },
  };
}

function shown(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return value.join('×');
  return String(value);
}

export function renderCatalogChangePlan(plan) {
  const lines = [
    `產品資料 ${plan.baseline.catalogVersion} → ${plan.candidate.catalogVersion}`,
    `安全 ${plan.stats.safe}、待確認 ${plan.stats.review}、阻擋 ${plan.stats.blocking}；預選 ${plan.stats.selected}`,
  ];
  for (const entry of plan.entries) {
    const marker = entry.risk === 'safe' ? '✓' : entry.risk === 'review' ? '?' : '×';
    const details = entry.kind === 'source-conflict'
      ? entry.message
      : (entry.fields || []).map(field => `${field.field}: ${shown(field.before)} → ${shown(field.after)}`).join('；');
    lines.push(`- [${marker}] ${entry.sku} [${entry.changeType}]${details ? ` ${details}` : ''}`);
  }
  return `${lines.join('\n')}\n`;
}
