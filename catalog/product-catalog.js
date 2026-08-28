const CATALOG_KEYS = ['catalogVersion', 'orderSkuAliases', 'products', 'schemaVersion'];
const PRODUCT_KEYS = [
  'approvedOrderSkus',
  'lifecycle',
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

function validatePackaging({ lifecycle, path }, packaging, packagingIndex, issues) {
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
    if (lifecycle !== 'incomplete') {
      issues.push(`${packagingPath}.unitsPerCarton must be known unless the product is incomplete`);
    }
  } else if (!positiveInteger(packaging?.unitsPerCarton)) {
    issues.push(`${packagingPath}.unitsPerCarton must be a positive integer or null for an incomplete product`);
  }
  if (packaging?.cartonsPerPallet === null) {
    if (lifecycle !== 'incomplete' && !ORDER_SKU_ALIAS_LIFECYCLES.has(lifecycle)) {
      issues.push(`${packagingPath}.cartonsPerPallet must be known unless the product is incomplete or an Order SKU Alias`);
    }
  } else if (!positiveInteger(packaging?.cartonsPerPallet)) {
    issues.push(`${packagingPath}.cartonsPerPallet must be a positive integer or null`);
  }
  if (packaging?.cartonDimensionsCm === null) {
    if (lifecycle !== 'incomplete') {
      issues.push(`${packagingPath}.cartonDimensionsCm must be known unless the product is incomplete`);
    }
  } else if (!Array.isArray(packaging?.cartonDimensionsCm)
      || packaging.cartonDimensionsCm.length !== 3
      || !packaging.cartonDimensionsCm.every(value => typeof value === 'number' && Number.isFinite(value) && value > 0)) {
    issues.push(`${packagingPath}.cartonDimensionsCm must contain three positive numbers or be null for an incomplete product`);
  }
  if (!positiveNumberOrNull(packaging?.grossWeightKg ?? null)) issues.push(`${packagingPath}.grossWeightKg must be positive or null`);
  if (!positiveNumberOrNull(packaging?.grossWeightLb ?? null)) issues.push(`${packagingPath}.grossWeightLb must be positive or null`);
  unsupportedKeys(packaging?.orderUnit, ORDER_UNIT_KEYS, `${packagingPath}.orderUnit`, issues);
  if (!ORDER_UNIT_KINDS.has(packaging?.orderUnit?.kind)) issues.push(`${packagingPath}.orderUnit.kind is unsupported`);
  if (!positiveInteger(packaging?.orderUnit?.units)) issues.push(`${packagingPath}.orderUnit.units must be a positive integer`);
  if (packaging?.orderUnit?.kind === 'single' && packaging?.orderUnit?.units !== 1) {
    issues.push(`${packagingPath}.orderUnit.units must be 1 for single products`);
  }
  if (packaging?.source !== undefined) {
    unsupportedKeys(packaging.source, SOURCE_KEYS, `${packagingPath}.source`, issues);
    if (!nonEmptyString(packaging.source?.sheet)) issues.push(`${packagingPath}.source.sheet must be a non-empty string`);
    if (!positiveInteger(packaging.source?.row)) issues.push(`${packagingPath}.source.row must be a positive integer`);
  }
}

function packagingRangesOverlap(left, right) {
  const leftEnd = left.effectiveTo || '9999-12-31';
  const rightEnd = right.effectiveTo || '9999-12-31';
  return left.effectiveFrom <= rightEnd && right.effectiveFrom <= leftEnd;
}

function validateProduct(product, productIndex, issues, productSkus, orderSkuOwners) {
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

  if (!Array.isArray(product?.packagingVersions) || product.packagingVersions.length === 0) {
    issues.push(`${path}.packagingVersions must be a non-empty array`);
    return;
  }
  const versions = new Set();
  product.packagingVersions.forEach((packaging, index) => {
    validatePackaging({ lifecycle:product.lifecycle, path }, packaging, index, issues);
    if (versions.has(packaging?.version)) issues.push(`${path}.packagingVersions duplicates version ${packaging.version}`);
    versions.add(packaging?.version);
  });
  const current = product.packagingVersions.filter(packaging => packaging?.effectiveTo === null);
  if (current.length !== 1) issues.push(`${path} must have exactly one current packaging version`);
  for (let left = 0; left < product.packagingVersions.length; left += 1) {
    for (let right = left + 1; right < product.packagingVersions.length; right += 1) {
      const a = product.packagingVersions[left];
      const b = product.packagingVersions[right];
      if (validDate(a?.effectiveFrom) && validDate(b?.effectiveFrom) && packagingRangesOverlap(a, b)) {
        issues.push(`${path} packaging date ranges overlap: ${a.version} and ${b.version}`);
      }
    }
  }
}

function validateOrderSkuAlias(alias, aliasIndex, issues, productsBySku, orderSkuOwners, aliasOrderSkus) {
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

  if (!Array.isArray(alias?.packagingVersions) || alias.packagingVersions.length === 0) {
    issues.push(`${path}.packagingVersions must be a non-empty array`);
    return;
  }
  const versions = new Set();
  alias.packagingVersions.forEach((packaging, index) => {
    validatePackaging({ lifecycle:alias.lifecycle, path }, packaging, index, issues);
    if (versions.has(packaging?.version)) issues.push(`${path}.packagingVersions duplicates version ${packaging.version}`);
    versions.add(packaging?.version);
  });
  const current = alias.packagingVersions.filter(packaging => packaging?.effectiveTo === null);
  if (current.length !== 1) issues.push(`${path} must have exactly one current packaging version`);
  for (let left = 0; left < alias.packagingVersions.length; left += 1) {
    for (let right = left + 1; right < alias.packagingVersions.length; right += 1) {
      const a = alias.packagingVersions[left];
      const b = alias.packagingVersions[right];
      if (validDate(a?.effectiveFrom) && validDate(b?.effectiveFrom) && packagingRangesOverlap(a, b)) {
        issues.push(`${path} packaging date ranges overlap: ${a.version} and ${b.version}`);
      }
    }
  }
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

export function validateCatalog(catalog) {
  const issues = [];
  unsupportedKeys(catalog, CATALOG_KEYS, 'catalog', issues);
  if (catalog?.schemaVersion !== 2) issues.push('catalog.schemaVersion must equal 2');
  if (!nonEmptyString(catalog?.catalogVersion) || !CATALOG_VERSION.test(catalog.catalogVersion)) {
    issues.push('catalog.catalogVersion must be a dated version such as 2026-08-25 or 2026-08-25.2');
  }
  const productSkus = new Set();
  const orderSkuOwners = new Map();
  if (!Array.isArray(catalog?.products) || catalog.products.length === 0) {
    issues.push('catalog.products must be a non-empty array');
  } else {
    catalog.products.forEach((product, index) => validateProduct(product, index, issues, productSkus, orderSkuOwners));
  }
  const productsBySku = new Map((Array.isArray(catalog?.products) ? catalog.products : [])
    .map(product => [product?.productSku, product]));
  const aliasOrderSkus = new Set();
  if (!Array.isArray(catalog?.orderSkuAliases)) {
    issues.push('catalog.orderSkuAliases must be an array');
  } else {
    catalog.orderSkuAliases.forEach((alias, index) => {
      validateOrderSkuAlias(alias, index, issues, productsBySku, orderSkuOwners, aliasOrderSkus);
    });
    for (const [orderSku, owner] of orderSkuOwners) {
      if (orderSku.startsWith('7') && !aliasOrderSkus.has(orderSku)) {
        issues.push(`approved 7-prefixed Order SKU ${orderSku} from ${owner} is missing from orderSkuAliases`);
      }
    }
  }
  if (issues.length) throw new CatalogValidationError(issues);

  const validated = cloneCatalog(catalog);
  validated.products.forEach(product => {
    product.currentPackaging = product.packagingVersions.find(packaging => packaging.effectiveTo === null);
  });
  validated.orderSkuAliases.forEach(alias => {
    alias.currentPackaging = alias.packagingVersions.find(packaging => packaging.effectiveTo === null);
  });
  return deepFreeze(validated);
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
