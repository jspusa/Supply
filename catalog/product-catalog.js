const CATALOG_KEYS = ['catalogVersion', 'orderSkuAliases', 'products', 'schemaVersion'];
const PRODUCT_KEYS = [
  'approvedOrderSkus',
  'lifecycle',
  'newOrderPackagingDefaultVersion',
  'origin',
  'packagingVersions',
  'productName',
  'productSku',
  'standardFactory',
];
const PACKAGING_KEYS = [
  'cartonDimensionsCm',
  'cartonsPerPallet',
  'effectiveFrom',
  'effectiveTo',
  'grossWeightKg',
  'grossWeightLb',
  'orderUnit',
  'source',
  'unitsPerCarton',
  'version',
];
const ORDER_UNIT_KEYS = ['kind', 'units'];
const SOURCE_KEYS = ['row', 'sheet'];
const ORDER_SKU_ALIAS_KEYS = [
  'canonicalProductSku',
  'lifecycle',
  'newOrderPackagingDefaultVersion',
  'orderSku',
  'packagingVersions',
];
const ORIGINS = new Set(['KH', 'OTHER', 'TW', 'VN']);
const STANDARD_FACTORIES = new Set(['OTHER', 'TW', 'VN']);
const LIFECYCLES = new Set(['active', 'incomplete', 'retired']);
const ORDER_SKU_ALIAS_LIFECYCLES = new Set(['approved', 'unmapped-legacy']);
const ORDER_UNIT_KINDS = new Set(['box', 'pack', 'single']);
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CATALOG_VERSION = /^\d{4}-\d{2}-\d{2}(?:\.\d+)?$/;
const SKU = /^[A-Z0-9][A-Z0-9-]*$/;

export const CANONICAL_CATALOG_SCHEMA_VERSION = 3;

export class CatalogValidationError extends Error {
  constructor(issues) {
    const list = Array.isArray(issues) ? issues : [String(issues)];
    super(`Invalid product catalog:\n- ${list.join('\n- ')}`);
    this.name = 'CatalogValidationError';
    this.issues = Object.freeze([...list]);
  }
}

function unsupportedKeys(value, allowed, path, issues) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) issues.push(`${path} has unsupported field ${key}`);
  }
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() === value && value.length > 0;
}

function positiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function positiveNumberOrNull(value) {
  return value === null || (typeof value === 'number' && Number.isFinite(value) && value > 0);
}

function validDate(value) {
  if (!nonEmptyString(value) || !ISO_DATE.test(value)) return false;
  return new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}

function validatePackaging({ path, allowUnknownOrderUnit }, packaging, packagingIndex, issues) {
  const packagingPath = `${path}.packagingVersions[${packagingIndex}]`;
  unsupportedKeys(packaging, PACKAGING_KEYS, packagingPath, issues);
  if (!nonEmptyString(packaging?.version)) issues.push(`${packagingPath}.version must be a non-empty string`);
  if (!validDate(packaging?.effectiveFrom)) issues.push(`${packagingPath}.effectiveFrom must be an ISO date`);
  if (packaging?.effectiveTo !== null && !validDate(packaging?.effectiveTo)) {
    issues.push(`${packagingPath}.effectiveTo must be an ISO date or null`);
  }
  if (validDate(packaging?.effectiveFrom) && validDate(packaging?.effectiveTo) && packaging.effectiveTo < packaging.effectiveFrom) {
    issues.push(`${packagingPath}.effectiveTo must not precede effectiveFrom`);
  }
  if (packaging?.unitsPerCarton === null) {
    // Historical or explicitly incomplete versions may retain an unknown fact.
  } else if (!positiveInteger(packaging?.unitsPerCarton)) {
    issues.push(`${packagingPath}.unitsPerCarton must be a positive integer or null`);
  }
  if (packaging?.cartonsPerPallet === null) {
    // Completeness is checked on the declared new-order default, not history.
  } else if (!positiveInteger(packaging?.cartonsPerPallet)) {
    issues.push(`${packagingPath}.cartonsPerPallet must be a positive integer or null`);
  }
  if (packaging?.cartonDimensionsCm === null) {
    // Completeness is checked on the declared new-order default, not history.
  } else if (!Array.isArray(packaging?.cartonDimensionsCm)
      || packaging.cartonDimensionsCm.length !== 3
      || !packaging.cartonDimensionsCm.every(value => typeof value === 'number' && Number.isFinite(value) && value > 0)) {
    issues.push(`${packagingPath}.cartonDimensionsCm must contain three positive numbers or be null`);
  }
  if (!positiveNumberOrNull(packaging?.grossWeightKg ?? null)) issues.push(`${packagingPath}.grossWeightKg must be positive or null`);
  if (!positiveNumberOrNull(packaging?.grossWeightLb ?? null)) issues.push(`${packagingPath}.grossWeightLb must be positive or null`);
  if (packaging?.orderUnit === null) {
    if (!allowUnknownOrderUnit) issues.push(`${packagingPath}.orderUnit must be known in schemaVersion 2`);
  } else {
    unsupportedKeys(packaging?.orderUnit, ORDER_UNIT_KEYS, `${packagingPath}.orderUnit`, issues);
    if (!ORDER_UNIT_KINDS.has(packaging?.orderUnit?.kind)) issues.push(`${packagingPath}.orderUnit.kind is unsupported`);
    if (!positiveInteger(packaging?.orderUnit?.units)) issues.push(`${packagingPath}.orderUnit.units must be a positive integer`);
    if (packaging?.orderUnit?.kind === 'single' && packaging?.orderUnit?.units !== 1) {
      issues.push(`${packagingPath}.orderUnit.units must be 1 for single products`);
    }
  }
  if (packaging?.source !== undefined) {
    unsupportedKeys(packaging.source, SOURCE_KEYS, `${packagingPath}.source`, issues);
    if (!nonEmptyString(packaging.source?.sheet)) issues.push(`${packagingPath}.source.sheet must be a non-empty string`);
    if (!positiveInteger(packaging.source?.row)) issues.push(`${packagingPath}.source.row must be a positive integer`);
  }
}

function validatePackagingCollection(owner, {
  lifecycle,
  path,
  legacyDateWindows,
  alias = false,
}, issues) {
  if (!Array.isArray(owner?.packagingVersions) || owner.packagingVersions.length === 0) {
    issues.push(`${path}.packagingVersions must be a non-empty array`);
    return;
  }
  const versions = new Set();
  owner.packagingVersions.forEach((packaging, index) => {
    validatePackaging({ path, allowUnknownOrderUnit:!legacyDateWindows }, packaging, index, issues);
    if (versions.has(packaging?.version)) issues.push(`${path}.packagingVersions duplicates version ${packaging.version}`);
    versions.add(packaging?.version);
  });

  if (legacyDateWindows) {
    const current = owner.packagingVersions.filter(packaging => packaging?.effectiveTo === null);
    if (current.length !== 1) issues.push(`${path} must have exactly one current packaging version in schemaVersion 2`);
    for (let left = 0; left < owner.packagingVersions.length; left += 1) {
      for (let right = left + 1; right < owner.packagingVersions.length; right += 1) {
        const a = owner.packagingVersions[left];
        const b = owner.packagingVersions[right];
        if (validDate(a?.effectiveFrom) && validDate(b?.effectiveFrom) && packagingRangesOverlap(a, b)) {
          issues.push(`${path} packaging date ranges overlap: ${a.version} and ${b.version}`);
        }
      }
    }
  }

  const defaultVersion = owner?.newOrderPackagingDefaultVersion;
  if (!nonEmptyString(defaultVersion)) {
    issues.push(`${path}.newOrderPackagingDefaultVersion must name one Packaging Specification Version`);
    return;
  }
  const selected = owner.packagingVersions.find(packaging => packaging?.version === defaultVersion);
  if (!selected) {
    issues.push(`${path}.newOrderPackagingDefaultVersion does not exist: ${defaultVersion}`);
    return;
  }
  if (lifecycle === 'active') {
    if (!positiveInteger(selected.unitsPerCarton)) issues.push(`${path} active default packaging must know unitsPerCarton`);
    if (!positiveInteger(selected.cartonsPerPallet)) issues.push(`${path} active default packaging must know cartonsPerPallet`);
    if (!Array.isArray(selected.cartonDimensionsCm)) issues.push(`${path} active default packaging must know cartonDimensionsCm`);
    if (selected.orderUnit === null) issues.push(`${path} active default packaging must know orderUnit`);
  } else if (alias) {
    // Alias identity and immutable history remain valid when an explicitly cleared
    // default is incomplete. Runtime projections separately exclude it from new work.
  }
}

function packagingRangesOverlap(left, right) {
  const leftEnd = left.effectiveTo || '9999-12-31';
  const rightEnd = right.effectiveTo || '9999-12-31';
  return left.effectiveFrom <= rightEnd && right.effectiveFrom <= leftEnd;
}

function validateProduct(product, productIndex, issues, productSkus, orderSkuOwners, legacyDateWindows) {
  const path = `products[${productIndex}]`;
  unsupportedKeys(product, PRODUCT_KEYS, path, issues);
  if (!nonEmptyString(product?.productSku) || !SKU.test(product.productSku)) issues.push(`${path}.productSku must be normalized uppercase SKU text`);
  if (product?.productSku?.startsWith('7')) issues.push(`${path}.productSku must not be 7-prefixed; model it as an Order SKU Alias`);
  if (productSkus.has(product?.productSku)) issues.push(`${path}.productSku duplicates ${product.productSku}`);
  else productSkus.add(product?.productSku);
  if (typeof product?.productName !== 'string') issues.push(`${path}.productName must be text`);
  if (product?.lifecycle === 'active' && !nonEmptyString(product.productName)) {
    issues.push(`${path}.productName must be a non-empty string for an active product`);
  }
  if (product?.origin !== null && !ORIGINS.has(product?.origin)) issues.push(`${path}.origin is unsupported`);
  if (product?.standardFactory !== null && !STANDARD_FACTORIES.has(product?.standardFactory)) {
    issues.push(`${path}.standardFactory is unsupported`);
  }
  if (!LIFECYCLES.has(product?.lifecycle)) issues.push(`${path}.lifecycle is unsupported`);
  if (product?.lifecycle === 'active' && product?.standardFactory === null) {
    issues.push(`${path}.standardFactory must be known for an active product`);
  }

  if (!Array.isArray(product?.approvedOrderSkus) || product.approvedOrderSkus.length === 0) {
    issues.push(`${path}.approvedOrderSkus must be a non-empty array`);
  } else {
    const local = new Set();
    for (const orderSku of product.approvedOrderSkus) {
      if (!nonEmptyString(orderSku) || !SKU.test(orderSku)) issues.push(`${path}.approvedOrderSkus contains an invalid SKU`);
      if (nonEmptyString(orderSku) && orderSku !== product.productSku && !orderSku.startsWith('7')) {
        issues.push(`${path}.approvedOrderSkus alternative ${orderSku} must be 7-prefixed`);
      }
      if (local.has(orderSku)) issues.push(`${path}.approvedOrderSkus duplicates ${orderSku}`);
      local.add(orderSku);
      const owner = orderSkuOwners.get(orderSku);
      if (owner && owner !== product.productSku) issues.push(`${path}.approvedOrderSkus reuses ${orderSku} from ${owner}`);
      else orderSkuOwners.set(orderSku, product.productSku);
    }
    if (!local.has(product.productSku)) issues.push(`${path}.approvedOrderSkus must include its Product SKU`);
  }

  validatePackagingCollection(product, {
    lifecycle:product.lifecycle,
    path,
    legacyDateWindows,
  }, issues);
}

function validateOrderSkuAlias(alias, aliasIndex, issues, productsBySku, orderSkuOwners, aliasOrderSkus, legacyDateWindows) {
  const path = `orderSkuAliases[${aliasIndex}]`;
  unsupportedKeys(alias, ORDER_SKU_ALIAS_KEYS, path, issues);
  if (!nonEmptyString(alias?.orderSku) || !SKU.test(alias.orderSku) || !alias.orderSku.startsWith('7')) {
    issues.push(`${path}.orderSku must be a normalized 7-prefixed SKU`);
  }
  if (aliasOrderSkus.has(alias?.orderSku)) issues.push(`${path}.orderSku duplicates ${alias.orderSku}`);
  else aliasOrderSkus.add(alias?.orderSku);
  if (!ORDER_SKU_ALIAS_LIFECYCLES.has(alias?.lifecycle)) issues.push(`${path}.lifecycle is unsupported`);
  if (alias?.canonicalProductSku !== null
      && (!nonEmptyString(alias?.canonicalProductSku) || !SKU.test(alias.canonicalProductSku))) {
    issues.push(`${path}.canonicalProductSku must be a normalized Product SKU or null`);
  }

  if (alias?.lifecycle === 'approved') {
    if (!nonEmptyString(alias?.canonicalProductSku)) {
      issues.push(`${path}.canonicalProductSku must identify an existing Product SKU for an approved alias`);
    } else {
      const owner = productsBySku.get(alias.canonicalProductSku);
      if (!owner) issues.push(`${path}.canonicalProductSku does not exist: ${alias.canonicalProductSku}`);
      else if (!owner.approvedOrderSkus.includes(alias.orderSku)) {
        issues.push(`${path}.orderSku must be listed in ${alias.canonicalProductSku}.approvedOrderSkus`);
      }
    }
  }
  if (alias?.lifecycle === 'unmapped-legacy' && alias?.canonicalProductSku !== null) {
    issues.push(`${path}.canonicalProductSku must be null for an unmapped-legacy alias`);
  }
  if (alias?.lifecycle === 'unmapped-legacy' && orderSkuOwners.has(alias?.orderSku)) {
    issues.push(`${path}.orderSku is already approved by ${orderSkuOwners.get(alias.orderSku)} and cannot be unmapped-legacy`);
  }

  validatePackagingCollection(alias, {
    lifecycle:alias.lifecycle,
    path,
    legacyDateWindows,
    alias:true,
  }, issues);
}

function cloneCatalog(catalog) {
  return JSON.parse(JSON.stringify(catalog));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function legacyDefaultVersion(owner, path, issues) {
  const current = Array.isArray(owner?.packagingVersions)
    ? owner.packagingVersions.filter(packaging => packaging?.effectiveTo === null)
    : [];
  if (current.length !== 1 || !nonEmptyString(current[0]?.version)) {
    issues.push(`${path} cannot migrate because schemaVersion 2 does not have exactly one named current packaging version`);
    return null;
  }
  return current[0].version;
}

export function migrateCatalog(catalog) {
  if (!catalog || typeof catalog !== 'object' || Array.isArray(catalog)) {
    throw new CatalogValidationError('catalog must be an object');
  }
  if (![2, CANONICAL_CATALOG_SCHEMA_VERSION].includes(catalog.schemaVersion)) {
    throw new CatalogValidationError(`catalog.schemaVersion must equal 2 or ${CANONICAL_CATALOG_SCHEMA_VERSION}`);
  }
  const migrated = cloneCatalog(catalog);
  if (migrated.schemaVersion === CANONICAL_CATALOG_SCHEMA_VERSION) return migrated;

  const issues = [];
  (Array.isArray(migrated.products) ? migrated.products : []).forEach((product, index) => {
    product.newOrderPackagingDefaultVersion = legacyDefaultVersion(product, `products[${index}]`, issues);
  });
  (Array.isArray(migrated.orderSkuAliases) ? migrated.orderSkuAliases : []).forEach((alias, index) => {
    alias.newOrderPackagingDefaultVersion = legacyDefaultVersion(alias, `orderSkuAliases[${index}]`, issues);
  });
  if (issues.length) throw new CatalogValidationError(issues);
  migrated.schemaVersion = CANONICAL_CATALOG_SCHEMA_VERSION;
  return migrated;
}

export function validateCatalog(catalog) {
  const issues = [];
  const sourceSchemaVersion = catalog?.schemaVersion;
  unsupportedKeys(catalog, CATALOG_KEYS, 'catalog', issues);
  if (![2, CANONICAL_CATALOG_SCHEMA_VERSION].includes(sourceSchemaVersion)) {
    issues.push(`catalog.schemaVersion must equal 2 or ${CANONICAL_CATALOG_SCHEMA_VERSION}`);
  }
  if (issues.length) throw new CatalogValidationError(issues);

  let normalized;
  try {
    normalized = migrateCatalog(catalog);
  } catch (error) {
    if (error instanceof CatalogValidationError) throw error;
    throw new CatalogValidationError(error.message);
  }
  if (!nonEmptyString(normalized?.catalogVersion) || !CATALOG_VERSION.test(normalized.catalogVersion)) {
    issues.push('catalog.catalogVersion must be a dated version such as 2026-08-25 or 2026-08-25.2');
  }
  const productSkus = new Set();
  const orderSkuOwners = new Map();
  if (!Array.isArray(normalized?.products) || normalized.products.length === 0) {
    issues.push('catalog.products must be a non-empty array');
  } else {
    normalized.products.forEach((product, index) => validateProduct(
      product,
      index,
      issues,
      productSkus,
      orderSkuOwners,
      sourceSchemaVersion === 2,
    ));
  }
  const productsBySku = new Map((Array.isArray(normalized?.products) ? normalized.products : [])
    .map(product => [product?.productSku, product]));
  const aliasOrderSkus = new Set();
  if (!Array.isArray(normalized?.orderSkuAliases)) {
    issues.push('catalog.orderSkuAliases must be an array');
  } else {
    normalized.orderSkuAliases.forEach((alias, index) => {
      validateOrderSkuAlias(
        alias,
        index,
        issues,
        productsBySku,
        orderSkuOwners,
        aliasOrderSkus,
        sourceSchemaVersion === 2,
      );
    });
    for (const [orderSku, owner] of orderSkuOwners) {
      if (orderSku.startsWith('7') && !aliasOrderSkus.has(orderSku)) {
        issues.push(`approved 7-prefixed Order SKU ${orderSku} from ${owner} is missing from orderSkuAliases`);
      }
    }
  }
  if (issues.length) throw new CatalogValidationError(issues);

  const validated = cloneCatalog(normalized);
  validated.products.forEach(product => {
    product.newOrderPackaging = product.packagingVersions.find(packaging => packaging.version === product.newOrderPackagingDefaultVersion);
    product.currentPackaging = product.newOrderPackaging;
  });
  validated.orderSkuAliases.forEach(alias => {
    alias.newOrderPackaging = alias.packagingVersions.find(packaging => packaging.version === alias.newOrderPackagingDefaultVersion);
    alias.currentPackaging = alias.newOrderPackaging;
  });
  return deepFreeze(validated);
}

function canonicalOwnerMap(catalog) {
  const owners = new Map();
  for (const product of catalog.products || []) owners.set(product.productSku, product);
  for (const alias of catalog.orderSkuAliases || []) owners.set(alias.orderSku, alias);
  return owners;
}

export function assertCatalogHistoryPreserved(previousCatalog, nextCatalog, options = {}) {
  const previous = migrateCatalog(previousCatalog);
  const next = migrateCatalog(nextCatalog);
  validateCatalog(previous);
  validateCatalog(next);
  if (options.replacePackagingHistoryForSkus) {
    throw new CatalogValidationError(['packaging history replacement requires exact removed version IDs']);
  }
  const replacements = new Map((options.packagingHistoryReplacements || []).map(item => {
    const sku = String(item?.sku || '').trim().toUpperCase();
    const removedVersionIds = [...new Set((item?.removedVersionIds || []).map(String))];
    return [sku, removedVersionIds];
  }));
  const previousOwners = canonicalOwnerMap(previous);
  const nextOwners = canonicalOwnerMap(next);
  const issues = [];
  for (const [sku, previousOwner] of previousOwners) {
    const nextOwner = nextOwners.get(sku);
    if (!nextOwner) {
      issues.push(`${sku} released identity must be retired instead of removed`);
      continue;
    }
    const removedVersionIds = replacements.get(sku) || [];
    const actualRemovedVersionIds = [];
    const nextVersions = new Map(nextOwner.packagingVersions.map(packaging => [packaging.version, packaging]));
    for (const previousPackaging of previousOwner.packagingVersions) {
      const nextPackaging = nextVersions.get(previousPackaging.version);
      if (!nextPackaging) {
        actualRemovedVersionIds.push(previousPackaging.version);
        if (!removedVersionIds.includes(previousPackaging.version)) {
          issues.push(`${sku} released packaging version ${previousPackaging.version} must not be removed`);
        }
      } else if (JSON.stringify(nextPackaging) !== JSON.stringify(previousPackaging)) {
        issues.push(`${sku} released packaging version ${previousPackaging.version} is immutable; create another version`);
      }
    }
    if (JSON.stringify([...actualRemovedVersionIds].sort()) !== JSON.stringify([...removedVersionIds].sort())) {
      issues.push(`${sku} removed packaging versions must exactly match the reviewed IDs`);
    }
  }
  for (const sku of replacements.keys()) {
    if (!previousOwners.has(sku) || !nextOwners.has(sku)) {
      issues.push(`${sku} packaging history replacement must name one existing identity`);
    }
  }
  if (issues.length) throw new CatalogValidationError(issues);
  return true;
}

export function resolvePackagingVersion(catalog, sku, packagingVersion = null) {
  const snapshot = validateCatalog(catalog);
  const normalizedSku = String(sku || '').trim().toUpperCase();
  const owner = normalizedSku.startsWith('7')
    ? snapshot.orderSkuAliases.find(alias => alias.orderSku === normalizedSku)
    : snapshot.products.find(product => product.productSku === normalizedSku);
  if (!owner) return null;
  const version = packagingVersion || owner.newOrderPackagingDefaultVersion;
  return owner.packagingVersions.find(packaging => packaging.version === version) || null;
}

export function orderGroupForOrderSku(orderSku, standardFactory) {
  if (String(orderSku || '').trim().toUpperCase().startsWith('7')) return 'subcontract';
  if (standardFactory === 'TW') return 'taiwan';
  if (standardFactory === 'VN') return 'vietnam';
  return 'other';
}

export function compileCatalog(catalog, adapter) {
  if (!adapter || typeof adapter.project !== 'function' || !nonEmptyString(adapter.name)) {
    throw new TypeError('Catalog adapter must provide a non-empty name and project(snapshot)');
  }
  const snapshot = validateCatalog(catalog);
  return adapter.project(snapshot);
}
