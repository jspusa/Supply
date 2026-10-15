(function initSkuCorrespondence(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SupplySkuCorrespondence = api;
})(typeof globalThis === 'object' ? globalThis : this, function skuCorrespondenceFactory() {
  'use strict';

  // Explicit Supply planning identities confirmed by the owner on 2026-10-15.
  // This list does not create or replace packaging specifications. Order SKU
  // selection must still use the released catalog's own packaging and owner.
  const confirmedPairs = Object.freeze([
    ['GTS01', '7GTSD013AB'],
    ['GTSL01', '7GTSD017AB'],
    ['GTB01', '7GTBD013AB'],
    ['GTBL01', '7GTBD017AB'],
    ['GTBL03', '7GTBD037AB'],
    ['GTB05', '7GTBD053AB'],
    ['GTBL05', '7GTBD057AB'],
    ['GTR01', '7GTRD013AB'],
    ['GTRL01', '7GTRD017AB'],
    ['GTRL03', '7GTRD037AB'],
    ['GTP01', '7GTPD013AB'],
    ['GTPL01', '7GTPD017AB'],
    ['GTPL03', '7GTPD037AB'],
    ['GTP05', '7GTPD053AB'],
    ['GTPL05', '7GTPD057AB'],
    ['TTS05AM-1', '7ATSD010AB'],
    ['TTSL05', '7ATSD017AB'],
    ['TTS05AM', '7ATSD019AB'],
    ['ATS01', '7ATSD011AB'],
    ['ATR01', '7ATRD013AB'],
    ['VTS01-5', '7VTSD513AB'],
    ['VTS01-10', '7VTSD913AB'],
    ['VTB01-4', '7VTBD410AB'],
    ['VTB01-10', '7VTBD015AB'],
    ['VTR01-10', '7VTRD015AB'],
    ['VTR01-20', '7VTRD215AB'],
  ].map(pair => Object.freeze(pair)));

  function normalizeSku(sku) {
    return String(sku ?? '').trim().toUpperCase();
  }

  function createRegistry(catalogPairs = []) {
    const aliasToCanonical = new Map();
    const canonicalToGroup = new Map();
    const pairs = [];
    const seen = new Set();

    const sources = [catalogPairs, confirmedPairs];
    for (const [sourceIndex, sourcePairs] of sources.entries()) {
      for (const pair of sourcePairs) {
        if (!Array.isArray(pair) || pair.length !== 2) throw new Error('SKU correspondence requires one Product SKU and one Order SKU.');
        const [productSku, orderSku] = pair.map(normalizeSku);
        if (!productSku || !orderSku || productSku === orderSku || productSku.startsWith('7') || !orderSku.startsWith('7')) {
          throw new Error(`Invalid SKU correspondence: ${productSku} / ${orderSku}`);
        }
        const previousOwner = aliasToCanonical.get(orderSku);
        // A released catalog remains authoritative when a later release resolves
        // or corrects an identity from this dated planning-only supplement.
        if (sourceIndex === 1 && previousOwner) continue;
        if (previousOwner && previousOwner !== productSku) {
          throw new Error(`Conflicting Product SKU owners for ${orderSku}: ${previousOwner} / ${productSku}`);
        }
        if (seen.has(orderSku)) continue;
        seen.add(orderSku);
        const group = canonicalToGroup.get(productSku) || [productSku];
        group.push(orderSku);
        canonicalToGroup.set(productSku, group);
        aliasToCanonical.set(productSku, productSku);
        aliasToCanonical.set(orderSku, productSku);
        pairs.push(Object.freeze([productSku, orderSku]));
      }
    }
    canonicalToGroup.forEach(group => Object.freeze(group));

    function canonicalize(sku) {
      const key = normalizeSku(sku);
      return aliasToCanonical.get(key) || key;
    }
    function getGroup(sku) {
      return canonicalToGroup.get(canonicalize(sku)) || null;
    }

    return Object.freeze({
      pairs:Object.freeze(pairs),
      aliasToCanonical,
      canonicalToGroup,
      canonicalize,
      getGroup,
    });
  }

  return Object.freeze({ confirmedOn:'2026-10-15', confirmedPairs, createRegistry });
});
