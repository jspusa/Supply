import {
  assertCatalogHistoryPreserved,
  migrateCatalog,
  validateCatalog,
} from './product-catalog.js';

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function integerOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : null;
}

function positiveOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function factoryForOrigin(origin) {
  if (origin === 'TW') return 'TW';
  if (origin === 'VN' || origin === 'KH') return 'VN';
  if (origin === 'OTHER') return 'OTHER';
  return null;
}

function defaultPackaging(owner) {
  return owner.packagingVersions.find(packaging => packaging.version === owner.newOrderPackagingDefaultVersion);
}

function packagingFacts(packaging) {
  return JSON.stringify([
    packaging.unitsPerCarton,
    packaging.cartonsPerPallet,
    packaging.cartonDimensionsCm,
    packaging.grossWeightKg,
    packaging.grossWeightLb,
    packaging.orderUnit,
  ]);
}

export const CLEARABLE_FIELDS = new Set([
  'cartonDimensionsCm',
  'cartonsPerPallet',
  'grossWeightKg',
  'grossWeightLb',
  'origin',
  'standardFactory',
  'unitsPerCarton',
]);

function rawClearFieldIsBlank(record, field) {
  if (field === 'standardFactory') return !record.standardFactory;
  if (field === 'grossWeightLb' || field === 'grossWeightKg') {
    return !record.grossWeightLb && !record.grossWeightKg;
  }
  const value = record[field];
  return value === null || value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
}

export function applyExplicitRawClears(rawPayload, selections = []) {
  if (!rawPayload || !Array.isArray(rawPayload.records)) throw new Error('Raw catalog clear requires normalized records');
  const bySku = new Map(rawPayload.records.map(record => [String(record.sku || '').trim().toUpperCase(), record]));
  const clears = new Map();
  for (const selection of selections || []) {
    const sku = String(selection?.sku || '').trim().toUpperCase();
    const record = bySku.get(sku);
    if (!record) throw new Error(`Raw catalog clear SKU is not present in this workbook: ${sku || '(blank)'}`);
    const requested = [...new Set((selection.fields || []).map(String))];
    for (const requestedField of requested) {
      const field = requestedField === 'grossWeightKg' ? 'grossWeightLb' : requestedField;
      if (!CLEARABLE_FIELDS.has(requestedField) || !rawClearFieldIsBlank(record, field)) {
        throw new Error(`${sku}.${requestedField} cannot be explicitly cleared because the raw workbook supplies a value`);
      }
      if (sku.startsWith('7') && ['origin', 'standardFactory'].includes(field)) {
        throw new Error(`${sku}.${field} cannot be explicitly cleared for an Order SKU Alias`);
      }
      if (!clears.has(sku)) clears.set(sku, new Set());
      if (field === 'grossWeightLb') {
        clears.get(sku).add('grossWeightLb');
        clears.get(sku).add('grossWeightKg');
      } else {
        clears.get(sku).add(field);
      }
    }
  }
  return {
    ...rawPayload,
    records:rawPayload.records.map(record => {
      const selected = clears.get(record.sku);
      return selected?.size ? { ...record, clearFields:[...selected] } : record;
    }),
  };
}

function explicitClears(record) {
  const fields = Array.isArray(record?.clearFields) ? record.clearFields : [];
  const clears = new Set();
  for (const field of fields) {
    if (!CLEARABLE_FIELDS.has(field)) throw new Error(`Raw catalog overlay cannot explicitly clear ${field}`);
    clears.add(field);
  }
  return clears;
}

function sparseFact(record, field, existing, parse, clears) {
  if (clears.has(field)) return null;
  if (!Object.hasOwn(record, field) || record[field] === null || record[field] === undefined || record[field] === '') {
    return existing ?? null;
  }
  return parse(record[field]) ?? existing ?? null;
}

function packagingFromRecord(record, existing = null, clears = explicitClears(record)) {
  const dimensions = sparseFact(record, 'cartonDimensionsCm', existing?.cartonDimensionsCm, value => {
    if (!Array.isArray(value)) return null;
    const parsed = value.map(positiveOrNull);
    return parsed.length === 3 && parsed.every(Boolean) ? parsed : null;
  }, clears);
  const sourceSheet = String(record.sourceSheet || '').trim();
  const sourceRow = Number(record.sourceRow);
  const source = sourceSheet && Number.isInteger(sourceRow) && sourceRow > 0
    ? { sheet:sourceSheet, row:sourceRow }
    : existing?.source ? clone(existing.source) : undefined;
  const suppliedWeightLb = Object.hasOwn(record, 'grossWeightLb')
    && record.grossWeightLb !== null
    && record.grossWeightLb !== undefined
    && record.grossWeightLb !== ''
    && positiveOrNull(record.grossWeightLb) !== null;
  const facts = {
    unitsPerCarton:sparseFact(record, 'unitsPerCarton', existing?.unitsPerCarton, integerOrNull, clears),
    cartonsPerPallet:sparseFact(record, 'cartonsPerPallet', existing?.cartonsPerPallet, integerOrNull, clears),
    cartonDimensionsCm:dimensions,
    grossWeightKg:suppliedWeightLb && !clears.has('grossWeightKg')
      ? null
      : sparseFact(record, 'grossWeightKg', existing?.grossWeightKg, positiveOrNull, clears),
    grossWeightLb:sparseFact(record, 'grossWeightLb', existing?.grossWeightLb, integerOrNull, clears),
    orderUnit:existing?.orderUnit ? clone(existing.orderUnit) : null,
  };
  if (source) facts.source = source;
  return facts;
}

function appendDefaultPackaging(owner, record, { catalogVersion, effectiveFrom }) {
  const existing = defaultPackaging(owner);
  const facts = packagingFromRecord(record, existing);
  if (existing && packagingFacts(existing) === packagingFacts(facts)) return false;

  const releasedCollision = owner.packagingVersions.find(packaging => packaging.version === catalogVersion);
  if (releasedCollision) {
    if (packagingFacts(releasedCollision) !== packagingFacts(facts)) {
      throw new Error(`${catalogVersion} is already a released immutable packaging version for ${owner.productSku || owner.orderSku}`);
    }
    owner.newOrderPackagingDefaultVersion = releasedCollision.version;
    return true;
  }

  const next = {
    version:catalogVersion,
    effectiveFrom,
    effectiveTo:null,
    ...facts,
  };
  owner.packagingVersions.push(next);
  owner.newOrderPackagingDefaultVersion = next.version;
  return true;
}

function replacePackagingHistory(owner, record, { catalogVersion, effectiveFrom }) {
  const facts = packagingFromRecord(record, defaultPackaging(owner));
  owner.packagingVersions = [{
    version:catalogVersion,
    effectiveFrom,
    effectiveTo:null,
    ...facts,
  }];
  owner.newOrderPackagingDefaultVersion = catalogVersion;
  return true;
}

function productCanBeActive(product) {
  const packaging = defaultPackaging(product);
  return Boolean(
    product.productName
    && product.standardFactory
    && packaging?.unitsPerCarton
    && packaging?.cartonsPerPallet
    && packaging?.cartonDimensionsCm
    && packaging?.orderUnit,
  );
}

function recordCanCreateAlias(record) {
  return Boolean(record.unitsPerCarton && record.cartonDimensionsCm);
}

export function overlayRawProductCatalog(canonicalCatalog, rawPayload, options = {}) {
  const catalogVersion = String(options.catalogVersion || '').trim();
  const effectiveFrom = String(options.effectiveFrom || catalogVersion.split('.')[0]).trim();
  if (!/^\d{4}-\d{2}-\d{2}(?:\.\d+)?$/.test(catalogVersion)) throw new Error('Raw catalog overlay requires a dated catalogVersion');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveFrom)) throw new Error('Raw catalog overlay requires an ISO effectiveFrom date');
  if (!rawPayload || !Array.isArray(rawPayload.records)) throw new Error('Raw catalog overlay requires normalized records');

  const baseline = migrateCatalog(canonicalCatalog);
  validateCatalog(canonicalCatalog);
  const catalog = clone(baseline);
  catalog.catalogVersion = catalogVersion;
  const products = new Map(catalog.products.map(product => [product.productSku, product]));
  const aliases = new Map(catalog.orderSkuAliases.map(alias => [alias.orderSku, alias]));
  if (options.replacePackagingHistoryForSkus) {
    throw new Error('舊箱規清除必須包含已選來源列與精確版本 ID');
  }
  const replacementDecisions = new Map();
  for (const item of options.packagingHistoryReplacements || []) {
    const sku = String(item?.sku || '').trim().toUpperCase();
    if (!sku || replacementDecisions.has(sku)) throw new Error(`舊箱規清除含有重複或無效 SKU：${sku || '(空白)'}`);
    const owner = sku.startsWith('7') ? aliases.get(sku) : products.get(sku);
    if (!owner) throw new Error(`${sku} 的舊箱規清除找不到既有產品`);
    const removedVersionIds = [...new Set((item?.removedVersionIds || []).map(String))];
    if (JSON.stringify([...removedVersionIds].sort()) !== JSON.stringify(owner.packagingVersions.map(version => version.version).sort())) {
      throw new Error(`${sku} 的舊箱規清除版本與目前資料不一致`);
    }
    replacementDecisions.set(sku, {
      sku,
      sourceSheet:String(item?.sourceSheet || ''),
      sourceRow:Number(item?.sourceRow),
      removedVersionIds,
    });
  }
  const replacedPackagingHistory = new Set();
  const stats = {
    addedProducts:0,
    updatedProducts:0,
    activatedProducts:0,
    addedAliases:0,
    updatedAliases:0,
    skippedRecords:0,
  };

  for (const record of rawPayload.records) {
    const sku = String(record.sku || '').trim().toUpperCase();
    if (!sku) continue;
    if (sku.startsWith('7')) {
      let alias = aliases.get(sku);
      if (!alias) {
        if (!recordCanCreateAlias(record)) {
          stats.skippedRecords += 1;
          continue;
        }
        alias = {
          orderSku:sku,
          canonicalProductSku:null,
          lifecycle:'unmapped-legacy',
          newOrderPackagingDefaultVersion:null,
          packagingVersions:[],
        };
        catalog.orderSkuAliases.push(alias);
        aliases.set(sku, alias);
        appendDefaultPackaging(alias, record, { catalogVersion, effectiveFrom });
        stats.addedAliases += 1;
      } else if (replacementDecisions.has(sku)) {
        const decision = replacementDecisions.get(sku);
        if (record.sourceSheet !== decision.sourceSheet || record.sourceRow !== decision.sourceRow) {
          throw new Error(`${sku} 的舊箱規清除來源列與衝突選擇不一致`);
        }
        replacePackagingHistory(alias, record, { catalogVersion, effectiveFrom });
        replacedPackagingHistory.add(sku);
        stats.updatedAliases += 1;
      } else if (appendDefaultPackaging(alias, record, { catalogVersion, effectiveFrom })) {
        stats.updatedAliases += 1;
      }
      continue;
    }

    let product = products.get(sku);
    if (!product) {
      const origin = record.origin || null;
      product = {
        productSku:sku,
        productName:'',
        origin,
        standardFactory:factoryForOrigin(origin),
        lifecycle:'incomplete',
        approvedOrderSkus:[sku],
        newOrderPackagingDefaultVersion:null,
        packagingVersions:[],
      };
      appendDefaultPackaging(product, record, { catalogVersion, effectiveFrom });
      if (productCanBeActive(product)) product.lifecycle = 'active';
      catalog.products.push(product);
      products.set(sku, product);
      stats.addedProducts += 1;
      continue;
    }

    let changed = false;
    const clears = explicitClears(record);
    const nextOrigin = clears.has('origin')
      ? null
      : (record.origin || product.origin);
    if (product.origin !== nextOrigin) {
      product.origin = nextOrigin;
      changed = true;
    }
    if (clears.has('standardFactory') && product.standardFactory !== null) {
      product.standardFactory = null;
      changed = true;
    } else if (record.standardFactory && product.standardFactory !== record.standardFactory) {
      product.standardFactory = record.standardFactory;
      changed = true;
    } else if (!product.standardFactory) {
      const standardFactory = factoryForOrigin(record.origin);
      if (standardFactory) {
        product.standardFactory = standardFactory;
        changed = true;
      }
    }
    if (replacementDecisions.has(sku)) {
      const decision = replacementDecisions.get(sku);
      if (record.sourceSheet !== decision.sourceSheet || record.sourceRow !== decision.sourceRow) {
        throw new Error(`${sku} 的舊箱規清除來源列與衝突選擇不一致`);
      }
      replacePackagingHistory(product, record, { catalogVersion, effectiveFrom });
      replacedPackagingHistory.add(sku);
      changed = true;
    } else if (appendDefaultPackaging(product, record, { catalogVersion, effectiveFrom })) changed = true;
    if (product.lifecycle === 'active' && !productCanBeActive(product)) {
      product.lifecycle = 'incomplete';
      changed = true;
    }
    if (product.lifecycle === 'incomplete' && productCanBeActive(product)) {
      product.lifecycle = 'active';
      stats.activatedProducts += 1;
      changed = true;
    }
    if (changed) stats.updatedProducts += 1;
  }

  const missingReplacements = [...replacementDecisions.keys()].filter(sku => !replacedPackagingHistory.has(sku));
  if (missingReplacements.length) throw new Error(`找不到要清除舊箱規的衝突 SKU：${missingReplacements.join(', ')}`);
  assertCatalogHistoryPreserved(baseline, catalog, {
    packagingHistoryReplacements:[...replacedPackagingHistory].map(sku => replacementDecisions.get(sku)),
  });
  validateCatalog(catalog);
  return { catalog, stats };
}
