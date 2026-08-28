/* Catalog Alignment browser consumer contract. Generated copies must remain byte-identical. */
(function initCatalogAlignmentStatus(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.JSPCatalogAlignment = api;
})(typeof globalThis === 'object' ? globalThis : this, function createCatalogAlignmentStatusApi() {
  'use strict';

  const SCHEMA_VERSION = 1;
  const SITES = Object.freeze(['supply', 'fba']);
  const CATALOG_VERSION = /^\d{4}-\d{2}-\d{2}(?:\.\d+)?$/;
  const SHA256 = /^[a-f0-9]{64}$/;
  const MANIFEST_KEYS = [
    'catalogVersion',
    'expectedPublicContentHashes',
    'publicContentHash',
    'schemaVersion',
    'site',
  ];

  class CatalogAlignmentContractError extends Error {
    constructor(code, message) {
      super(message);
      this.name = 'CatalogAlignmentContractError';
      this.code = code;
    }
  }

  function fail(code, message) {
    throw new CatalogAlignmentContractError(code, message);
  }

  function isRecord(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function exactKeys(value, expected) {
    return isRecord(value)
      && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
  }

  function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
    return value;
  }

  function validateCatalogAlignmentManifest(input) {
    if (!exactKeys(input, MANIFEST_KEYS)) fail('INVALID_MANIFEST', 'Catalog Alignment manifest has an unsupported shape');
    if (input.schemaVersion !== SCHEMA_VERSION) fail('UNSUPPORTED_SCHEMA_VERSION', 'Catalog Alignment manifest schemaVersion is unsupported');
    if (!CATALOG_VERSION.test(String(input.catalogVersion || ''))) fail('INVALID_CATALOG_VERSION', 'Catalog Alignment catalogVersion is invalid');
    if (!SITES.includes(input.site)) fail('INVALID_SITE', 'Catalog Alignment site is invalid');
    if (!SHA256.test(String(input.publicContentHash || ''))) fail('INVALID_PUBLIC_CONTENT_HASH', 'Catalog Alignment publicContentHash is invalid');
    if (!exactKeys(input.expectedPublicContentHashes, SITES)) fail('INVALID_EXPECTED_HASHES', 'Catalog Alignment expected hashes are invalid');
    for (const site of SITES) {
      if (!SHA256.test(String(input.expectedPublicContentHashes[site] || ''))) {
        fail('INVALID_EXPECTED_HASHES', `Catalog Alignment expected hash is invalid for ${site}`);
      }
    }
    return deepFreeze({
      schemaVersion: SCHEMA_VERSION,
      catalogVersion: input.catalogVersion,
      site: input.site,
      publicContentHash: input.publicContentHash,
      expectedPublicContentHashes: { ...input.expectedPublicContentHashes },
    });
  }

  function issue(code, site = null) {
    return Object.freeze({ code, site });
  }

  function safeManifest(input, location, issues) {
    try {
      return validateCatalogAlignmentManifest(input);
    } catch (error) {
      if (!(error instanceof CatalogAlignmentContractError)) throw error;
      issues.push(issue(`invalid-${location}-manifest`));
      return null;
    }
  }

  function evaluateCatalogAlignmentManifests(localInput, peerInput) {
    const issues = [];
    const local = safeManifest(localInput, 'local', issues);
    if (!local) {
      return deepFreeze({ state: 'failed', catalogVersion: null, localSite: null, peerSite: null, issues });
    }
    if (peerInput === null || peerInput === undefined) {
      return deepFreeze({
        state: 'pending',
        catalogVersion: local.catalogVersion,
        localSite: local.site,
        peerSite: null,
        issues: [issue('peer-manifest-unavailable')],
      });
    }
    const peer = safeManifest(peerInput, 'peer', issues);
    if (!peer) {
      return deepFreeze({
        state: 'failed',
        catalogVersion: local.catalogVersion,
        localSite: local.site,
        peerSite: null,
        issues,
      });
    }
    if (local.site === peer.site) issues.push(issue('duplicate-site-manifest', local.site));
    if (local.catalogVersion !== peer.catalogVersion) issues.push(issue('catalog-version-mismatch'));
    if (JSON.stringify(local.expectedPublicContentHashes) !== JSON.stringify(peer.expectedPublicContentHashes)) {
      issues.push(issue('expected-public-content-hash-mismatch'));
    }
    for (const manifest of [local, peer]) {
      if (manifest.publicContentHash !== manifest.expectedPublicContentHashes[manifest.site]) {
        issues.push(issue('public-content-hash-mismatch', manifest.site));
      }
    }
    return deepFreeze({
      state: issues.length ? 'failed' : 'aligned',
      catalogVersion: local.catalogVersion,
      localSite: local.site,
      peerSite: peer.site,
      issues,
    });
  }

  return Object.freeze({
    SCHEMA_VERSION,
    SITES,
    CatalogAlignmentContractError,
    evaluateCatalogAlignmentManifests,
    validateCatalogAlignmentManifest,
  });
});
