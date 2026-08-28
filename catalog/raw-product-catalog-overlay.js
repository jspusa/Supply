import { validateCatalog } from './product-catalog.js';

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

function previousDay(isoDate) {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

function currentPackaging(owner) {
  return owner.packagingVersions.find(packaging => packaging.effectiveTo === null);
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

function packagingFromRecord(record, existing = null) {
  const dimensions = Array.isArray(record.cartonDimensionsCm)
    ? record.cartonDimensionsCm.map(positiveOrNull)
    : null;
  const rawWeightLb = positiveOrNull(record.grossWeightLb);
  return {
    unitsPerCarton:integerOrNull(record.unitsPerCarton) ?? existing?.unitsPerCarton ?? null,
    cartonsPerPallet:integerOrNull(record.cartonsPerPallet) ?? existing?.cartonsPerPallet ?? null,
    cartonDimensionsCm:dimensions?.every(Boolean) ? dimensions : existing?.cartonDimensionsCm ?? null,
    grossWeightKg:rawWeightLb ? null : existing?.grossWeightKg ?? null,
    grossWeightLb:rawWeightLb ? Math.round(rawWeightLb) : existing?.grossWeightLb ?? null,
    orderUnit:existing?.orderUnit ? clone(existing.orderUnit) : { kind:'single', units:1 },
    source:{ sheet:String(record.sourceSheet), row:Number(record.sourceRow) },
  };
}

function replaceCurrentPackaging(owner, record, { catalogVersion, effectiveFrom }) {
  const existing = currentPackaging(owner);
  const facts = packagingFromRecord(record, existing);
  if (existing && packagingFacts(existing) === packagingFacts(facts)) return false;

  const next = {
    version:catalogVersion,
    effectiveFrom,
    effectiveTo:null,
    ...facts,
  };
  if (!existing) {
    owner.packagingVersions.push(next);
    return true;
  }
  if (existing.effectiveFrom === effectiveFrom) {
    owner.packagingVersions.splice(owner.packagingVersions.indexOf(existing), 1, next);
    return true;
  }
  existing.effectiveTo = previousDay(effectiveFrom);
  owner.packagingVersions.push(next);
  return true;
}

function productCanBeActive(product) {
  const packaging = currentPackaging(product);
  return Boolean(
    product.productName
    && product.standardFactory
    && packaging?.unitsPerCarton
    && packaging?.cartonsPerPallet
    && packaging?.cartonDimensionsCm,
  );
}

function packagingCanBelongToActiveProduct(packaging) {
  return Boolean(packaging?.unitsPerCarton && packaging?.cartonsPerPallet && packaging?.cartonDimensionsCm);
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

  const catalog = clone(canonicalCatalog);
  catalog.catalogVersion = catalogVersion;
  const products = new Map(catalog.products.map(product => [product.productSku, product]));
  const aliases = new Map(catalog.orderSkuAliases.map(alias => [alias.orderSku, alias]));
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
        alias = { orderSku:sku, canonicalProductSku:null, lifecycle:'unmapped-legacy', packagingVersions:[] };
        catalog.orderSkuAliases.push(alias);
        aliases.set(sku, alias);
        replaceCurrentPackaging(alias, record, { catalogVersion, effectiveFrom });
        stats.addedAliases += 1;
      } else if (replaceCurrentPackaging(alias, record, { catalogVersion, effectiveFrom })) {
        stats.updatedAliases += 1;
      }
      continue;
    }

    let product = products.get(sku);
    if (!product) {
      const origin = record.origin || null;
      product = {
        productSku:sku,
        productName:sku,
        origin,
        standardFactory:factoryForOrigin(origin),
        lifecycle:'incomplete',
        approvedOrderSkus:[sku],
        packagingVersions:[],
      };
      replaceCurrentPackaging(product, record, { catalogVersion, effectiveFrom });
      if (productCanBeActive(product)) product.lifecycle = 'active';
      catalog.products.push(product);
      products.set(sku, product);
      stats.addedProducts += 1;
      continue;
    }

    let changed = false;
    if (record.origin && product.origin !== record.origin) {
      product.origin = record.origin;
      changed = true;
    }
    if (!product.standardFactory) {
      const standardFactory = factoryForOrigin(record.origin);
      if (standardFactory) {
        product.standardFactory = standardFactory;
        changed = true;
      }
    }
    if (replaceCurrentPackaging(product, record, { catalogVersion, effectiveFrom })) changed = true;
    if (product.lifecycle === 'incomplete' && !product.productName) {
      product.productName = sku;
      changed = true;
    }
    if (product.lifecycle === 'incomplete' && productCanBeActive(product)) {
      product.lifecycle = 'active';
      product.packagingVersions = product.packagingVersions.filter(packagingCanBelongToActiveProduct);
      stats.activatedProducts += 1;
      changed = true;
    }
    if (changed) stats.updatedProducts += 1;
  }

  validateCatalog(catalog);
  return { catalog, stats };
}
