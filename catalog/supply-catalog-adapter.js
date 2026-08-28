function publicProduct(product) {
  const packaging = product.newOrderPackaging;
  const orderUnit = packaging.orderUnit;
  return {
    productCode:product.productSku,
    packagingVersion:product.newOrderPackagingDefaultVersion,
    productName:product.productName,
    boxSize:packaging.cartonDimensionsCm.join('*'),
    perCarton:packaging.unitsPerCarton,
    perPack:orderUnit.kind === 'pack' ? orderUnit.units : null,
    perBox:orderUnit.kind === 'box' ? orderUnit.units : null,
    perPallet:packaging.cartonsPerPallet,
    country:product.standardFactory === 'TW' || product.standardFactory === 'VN'
      ? product.standardFactory
      : 'Others',
  };
}

function eligibleProduct(product) {
  const packaging = product.newOrderPackaging;
  return product.lifecycle === 'active'
    && product.standardFactory !== null
    && Number.isInteger(packaging?.unitsPerCarton)
    && packaging.unitsPerCarton > 0
    && Number.isInteger(packaging.cartonsPerPallet)
    && packaging.cartonsPerPallet > 0
    && Array.isArray(packaging.cartonDimensionsCm)
    && packaging.cartonDimensionsCm.length === 3
    && packaging.cartonDimensionsCm.every(value => Number.isFinite(value) && value > 0)
    && Boolean(packaging.orderUnit);
}

function eligibleAlias(alias) {
  const packaging = alias.newOrderPackaging;
  return Number.isInteger(packaging?.unitsPerCarton)
    && packaging.unitsPerCarton > 0
    && Number.isInteger(packaging.cartonsPerPallet)
    && packaging.cartonsPerPallet > 0
    && Array.isArray(packaging.cartonDimensionsCm)
    && packaging.cartonDimensionsCm.length === 3
    && packaging.cartonDimensionsCm.every(value => Number.isFinite(value) && value > 0)
    && Boolean(packaging.orderUnit);
}

function publicOrderSkuPackaging({ orderSku, canonicalProductSku, owner }) {
  const packaging = owner.newOrderPackaging;
  const orderUnit = packaging.orderUnit;
  return {
    orderSku,
    canonicalProductSku,
    packagingVersion:owner.newOrderPackagingDefaultVersion,
    perCarton:packaging.unitsPerCarton,
    perPack:orderUnit.kind === 'pack' ? orderUnit.units : null,
    perBox:orderUnit.kind === 'box' ? orderUnit.units : null,
    perPallet:packaging.cartonsPerPallet,
    boxSize:Array.isArray(packaging.cartonDimensionsCm) ? packaging.cartonDimensionsCm.join('*') : null,
  };
}

export const supplyCatalogAdapter = Object.freeze({
  name:'supply',
  project(snapshot) {
    const productsBySku = new Map(snapshot.products.map(product => [product.productSku, product]));
    const approvedAliases = snapshot.orderSkuAliases.filter(alias => alias.lifecycle === 'approved'
      && productsBySku.get(alias.canonicalProductSku)?.lifecycle !== 'retired'
      && eligibleAlias(alias));
    const approvedAliasSkus = new Set(approvedAliases.map(alias => alias.orderSku));
    const equivalentSkuPairs = snapshot.products
      .filter(product => product.lifecycle !== 'retired')
      .flatMap(product => product.approvedOrderSkus
        .filter(orderSku => orderSku !== product.productSku && approvedAliasSkus.has(orderSku))
        .map(orderSku => [product.productSku, orderSku]));
    const projectedProducts = snapshot.products.filter(eligibleProduct);
    return {
      meta:{ schemaVersion:snapshot.schemaVersion, catalogVersion:snapshot.catalogVersion },
      equivalentSkuPairs,
      orderSkuPackaging:[
        ...projectedProducts.map(product => publicOrderSkuPackaging({
          orderSku:product.productSku,
          canonicalProductSku:product.productSku,
          owner:product,
        })),
        ...approvedAliases
          .filter(alias => eligibleProduct(productsBySku.get(alias.canonicalProductSku)))
          .map(alias => publicOrderSkuPackaging({
            orderSku:alias.orderSku,
            canonicalProductSku:alias.canonicalProductSku,
            owner:alias,
          })),
      ],
      products:projectedProducts.map(publicProduct),
    };
  },
});

function json(value) {
  return JSON.stringify(value, null, 2);
}

export function renderSupplyProductData(projection) {
  return `// Generated from catalog/product-catalog.json. Do not edit by hand.\n`+
`window.SUPPLY_PRODUCT_CATALOG_META = Object.freeze(${json(projection.meta)});\n`+
`window.SUPPLY_EQUIVALENT_SKU_PAIRS = Object.freeze(${json(projection.equivalentSkuPairs)}.map(pair => Object.freeze(pair)));\n`+
`window.SUPPLY_ORDER_SKU_PACKAGING = Object.freeze(${json(projection.orderSkuPackaging)}.map(item => Object.freeze(item)));\n`+
`window.allProductsData = ${json(projection.products)};\n`+
`\n`+
`// Turkey / Non-Turkey classification remains synchronous for legacy callers.\n`+
`(function () {\n`+
`  function normalizeProductCode(value) {\n`+
`    return String(value || "").trim().toUpperCase();\n`+
`  }\n`+
`\n`+
`  function getProductByCode(productCode) {\n`+
`    const key = normalizeProductCode(productCode);\n`+
`    if (!key) return null;\n`+
`    const list = Array.isArray(window.allProductsData) ? window.allProductsData : [];\n`+
`    return list.find(function (item) {\n`+
`      return normalizeProductCode(item && item.productCode) === key;\n`+
`    }) || null;\n`+
`  }\n`+
`\n`+
`  function isTurkeyName(productName) {\n`+
`    return /turkey/i.test(String(productName || ""));\n`+
`  }\n`+
`\n`+
`  function getTurkeyGroupByCode(productCode) {\n`+
`    const product = getProductByCode(productCode);\n`+
`    if (!product) return { group: "unknown", groupName: "未對應", product: null };\n`+
`    const isTurkey = isTurkeyName(product.productName);\n`+
`    return {\n`+
`      group: isTurkey ? "turkey" : "non_turkey",\n`+
`      groupName: isTurkey ? "火雞" : "非火雞",\n`+
`      product: product\n`+
`    };\n`+
`  }\n`+
`\n`+
`  window.normalizeProductCode = window.normalizeProductCode || normalizeProductCode;\n`+
`  window.getProductByCode = window.getProductByCode || getProductByCode;\n`+
`  window.getTurkeyGroupByCode = getTurkeyGroupByCode;\n`+
`  window.isTurkeyProduct = function (productCode) { return getTurkeyGroupByCode(productCode).group === "turkey"; };\n`+
`  window.isNonTurkeyProduct = function (productCode) { return getTurkeyGroupByCode(productCode).group === "non_turkey"; };\n`+
`})();\n`;
}
