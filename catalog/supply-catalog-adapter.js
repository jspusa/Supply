function publicProduct(product) {
  const packaging = product.currentPackaging;
  const orderUnit = packaging.orderUnit;
  return {
    productCode:product.productSku,
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

export const supplyCatalogAdapter = Object.freeze({
  name:'supply',
  project(snapshot) {
    const equivalentSkuPairs = snapshot.products.flatMap(product => product.approvedOrderSkus
      .filter(orderSku => orderSku !== product.productSku)
      .map(orderSku => [product.productSku, orderSku]));
    return {
      meta:{ schemaVersion:snapshot.schemaVersion, catalogVersion:snapshot.catalogVersion },
      equivalentSkuPairs,
      products:snapshot.products
        .filter(product => product.lifecycle !== 'retired'
          && product.standardFactory !== null
          && Number.isInteger(product.currentPackaging.cartonsPerPallet)
          && product.currentPackaging.cartonsPerPallet > 0)
        .map(publicProduct),
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
