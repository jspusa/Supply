import { createHash } from 'node:crypto';

export const CATALOG_ALIGNMENT_SCHEMA_VERSION = 1;
export const CATALOG_ALIGNMENT_SITES = Object.freeze(['supply', 'fba']);
export const CATALOG_ALIGNMENT_EVIDENCE_STAGES = Object.freeze([
  'local',
  'repositoryCi',
  'deployment',
  'liveHash',
  'liveBrowser',
]);

const CATALOG_VERSION = /^\d{4}-\d{2}-\d{2}(?:\.\d+)?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const EVIDENCE_STATES = new Set(['pending', 'passed', 'failed']);
const RECORD_STATES = new Set(['pending', 'aligned', 'failed']);
const MANIFEST_KEYS = [
  'catalogVersion',
  'expectedPublicContentHashes',
  'publicContentHash',
  'schemaVersion',
  'site',
];
const RECORD_KEYS = [
  'catalogVersion',
  'expectedPublicContentHashes',
  'schemaVersion',
  'sites',
  'state',
];
const SITE_RECORD_KEYS = ['evidence', 'recoveryAttempts'];
const EVIDENCE_KEYS = ['catalogVersion', 'checkedAt', 'publicContentHash', 'revision', 'state'];

export class CatalogAlignmentValidationError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'CatalogAlignmentValidationError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export class CatalogAlignmentBlockedError extends Error {
  constructor(record) {
    const retryableSites = retryableSitesFor(record);
    super(`Catalog release ${record.catalogVersion} is ${record.state}; repair Catalog Alignment before starting another release`);
    this.name = 'CatalogAlignmentBlockedError';
    this.code = 'CATALOG_ALIGNMENT_BLOCKED';
    this.catalogVersion = record.catalogVersion;
    this.state = record.state;
    this.retryableSites = Object.freeze(retryableSites);
  }
}

function fail(code, message, details) {
  throw new CatalogAlignmentValidationError(code, message, details);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertExactKeys(value, expected, label) {
  if (!isRecord(value)) fail('INVALID_DOCUMENT', `${label} must be an object`, { label });
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    fail('INVALID_DOCUMENT', `${label} has an unsupported shape`, { label, actual, expected: wanted });
  }
}

function assertCatalogVersion(value, label = 'catalogVersion') {
  if (typeof value !== 'string' || !CATALOG_VERSION.test(value)) {
    fail('INVALID_CATALOG_VERSION', `${label} must be a dated catalog version`, { label, value });
  }
  return value;
}

function assertHash(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    fail('INVALID_PUBLIC_CONTENT_HASH', `${label} must be a lowercase SHA-256 hash`, { label, value });
  }
  return value;
}

function assertSite(value, label = 'site') {
  if (!CATALOG_ALIGNMENT_SITES.includes(value)) {
    fail('INVALID_SITE', `${label} must be supply or fba`, { label, value });
  }
  return value;
}

function assertIsoTimestamp(value, label) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail('INVALID_TIMESTAMP', `${label} must be an exact ISO timestamp`, { label, value });
  }
  return value;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function normalizedExpectedHashes(input, label = 'expectedPublicContentHashes') {
  assertExactKeys(input, CATALOG_ALIGNMENT_SITES, label);
  return Object.fromEntries(CATALOG_ALIGNMENT_SITES.map(site => [site, assertHash(input[site], `${label}.${site}`)]));
}

function canonicalPublicValue(value, seen, path) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('INVALID_PUBLIC_CONTENT', `${path} contains a non-finite number`, { path });
    return value;
  }
  if (typeof value !== 'object') {
    fail('INVALID_PUBLIC_CONTENT', `${path} contains an unsupported value`, { path, type: typeof value });
  }
  if (seen.has(value)) fail('INVALID_PUBLIC_CONTENT', `${path} contains a circular reference`, { path });
  seen.add(value);
  let result;
  if (Array.isArray(value)) {
    result = value.map((item, index) => canonicalPublicValue(item, seen, `${path}[${index}]`));
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail('INVALID_PUBLIC_CONTENT', `${path} must contain only plain objects`, { path });
    }
    result = {};
    for (const key of Object.keys(value).sort()) {
      result[key] = canonicalPublicValue(value[key], seen, `${path}.${key}`);
    }
  }
  seen.delete(value);
  return result;
}

export function hashPublicContent(value) {
  const bytes = typeof value === 'string' || value instanceof Uint8Array
    ? value
    : JSON.stringify(canonicalPublicValue(value, new Set(), 'publicContent'));
  return createHash('sha256').update(bytes).digest('hex');
}

function manifestFor(site, catalogVersion, expectedPublicContentHashes) {
  return deepFreeze({
    schemaVersion: CATALOG_ALIGNMENT_SCHEMA_VERSION,
    catalogVersion,
    site,
    publicContentHash: expectedPublicContentHashes[site],
    expectedPublicContentHashes: { ...expectedPublicContentHashes },
  });
}

function pendingEvidence() {
  return {
    state: 'pending',
    checkedAt: null,
    revision: null,
    catalogVersion: null,
    publicContentHash: null,
  };
}

function pendingSiteRecord() {
  return {
    recoveryAttempts: 0,
    evidence: Object.fromEntries(CATALOG_ALIGNMENT_EVIDENCE_STAGES.map(stage => [stage, pendingEvidence()])),
  };
}

function deriveRecordState(sites) {
  const evidence = CATALOG_ALIGNMENT_SITES.flatMap(site => CATALOG_ALIGNMENT_EVIDENCE_STAGES.map(stage => sites[site].evidence[stage]));
  if (evidence.some(item => item.state === 'failed')) return 'failed';
  if (evidence.every(item => item.state === 'passed')) return 'aligned';
  return 'pending';
}

function newRecord(catalogVersion, expectedPublicContentHashes) {
  const sites = Object.fromEntries(CATALOG_ALIGNMENT_SITES.map(site => [site, pendingSiteRecord()]));
  return deepFreeze({
    schemaVersion: CATALOG_ALIGNMENT_SCHEMA_VERSION,
    catalogVersion,
    expectedPublicContentHashes: { ...expectedPublicContentHashes },
    state: deriveRecordState(sites),
    sites,
  });
}

export function createCatalogAlignmentRelease({ catalogVersion, publicContent } = {}) {
  const version = assertCatalogVersion(catalogVersion);
  assertExactKeys(publicContent, CATALOG_ALIGNMENT_SITES, 'publicContent');
  const expectedPublicContentHashes = Object.fromEntries(
    CATALOG_ALIGNMENT_SITES.map(site => [site, hashPublicContent(publicContent[site])]),
  );
  return deepFreeze({
    manifests: Object.fromEntries(
      CATALOG_ALIGNMENT_SITES.map(site => [site, manifestFor(site, version, expectedPublicContentHashes)]),
    ),
    record: newRecord(version, expectedPublicContentHashes),
  });
}

export function validateCatalogAlignmentManifest(input) {
  assertExactKeys(input, MANIFEST_KEYS, 'Catalog Alignment manifest');
  if (input.schemaVersion !== CATALOG_ALIGNMENT_SCHEMA_VERSION) {
    fail('UNSUPPORTED_SCHEMA_VERSION', 'Catalog Alignment manifest schemaVersion is unsupported', { schemaVersion: input.schemaVersion });
  }
  const catalogVersion = assertCatalogVersion(input.catalogVersion);
  const site = assertSite(input.site);
  const publicContentHash = assertHash(input.publicContentHash, 'publicContentHash');
  const expectedPublicContentHashes = normalizedExpectedHashes(input.expectedPublicContentHashes);
  return deepFreeze({
    schemaVersion: CATALOG_ALIGNMENT_SCHEMA_VERSION,
    catalogVersion,
    site,
    publicContentHash,
    expectedPublicContentHashes,
  });
}

function issue(code, site = null) {
  return Object.freeze({ code, site });
}

function safeManifest(input, location, issues) {
  try {
    return validateCatalogAlignmentManifest(input);
  } catch (error) {
    if (!(error instanceof CatalogAlignmentValidationError)) throw error;
    issues.push(issue(`invalid-${location}-manifest`));
    return null;
  }
}

export function evaluateCatalogAlignmentManifests(localInput, peerInput) {
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

function validateEvidence(input, { site, stage, catalogVersion, expectedHash }) {
  const label = `sites.${site}.evidence.${stage}`;
  assertExactKeys(input, EVIDENCE_KEYS, label);
  if (!EVIDENCE_STATES.has(input.state)) fail('INVALID_EVIDENCE', `${label}.state is unsupported`, { site, stage, state: input.state });
  if (input.state === 'pending') {
    if (EVIDENCE_KEYS.some(key => key !== 'state' && input[key] !== null)) {
      fail('INVALID_EVIDENCE', `${label} pending evidence must not contain observations`, { site, stage });
    }
    return pendingEvidence();
  }
  const checkedAt = assertIsoTimestamp(input.checkedAt, `${label}.checkedAt`);
  const revision = input.revision === null ? null : String(input.revision);
  if (revision !== null && !REVISION.test(revision)) {
    fail('INVALID_REVISION', `${label}.revision is invalid`, { site, stage, revision });
  }
  const observedVersion = input.catalogVersion === null
    ? null
    : assertCatalogVersion(input.catalogVersion, `${label}.catalogVersion`);
  const publicContentHash = input.publicContentHash === null
    ? null
    : assertHash(input.publicContentHash, `${label}.publicContentHash`);
  if (!['local', 'liveHash'].includes(stage) && (observedVersion !== null || publicContentHash !== null)) {
    fail('INCONSISTENT_EVIDENCE', `${label} must not mix catalog hash evidence into a different stage`, { site, stage });
  }
  if (['local', 'liveHash'].includes(stage) && input.state === 'passed') {
    if (observedVersion !== catalogVersion || publicContentHash !== expectedHash) {
      fail('INCONSISTENT_EVIDENCE', `${label} cannot pass with a different version or public content hash`, { site, stage });
    }
  }
  if (['repositoryCi', 'deployment', 'liveHash', 'liveBrowser'].includes(stage) && input.state === 'passed' && revision === null) {
    fail('INCONSISTENT_EVIDENCE', `${label} requires the verified revision when passed`, { site, stage });
  }
  return { state: input.state, checkedAt, revision, catalogVersion: observedVersion, publicContentHash };
}

export function validateCatalogAlignmentRecord(input) {
  assertExactKeys(input, RECORD_KEYS, 'Catalog Alignment record');
  if (input.schemaVersion !== CATALOG_ALIGNMENT_SCHEMA_VERSION) {
    fail('UNSUPPORTED_SCHEMA_VERSION', 'Catalog Alignment record schemaVersion is unsupported', { schemaVersion: input.schemaVersion });
  }
  const catalogVersion = assertCatalogVersion(input.catalogVersion);
  const expectedPublicContentHashes = normalizedExpectedHashes(input.expectedPublicContentHashes);
  assertExactKeys(input.sites, CATALOG_ALIGNMENT_SITES, 'Catalog Alignment record sites');
  const sites = {};
  for (const site of CATALOG_ALIGNMENT_SITES) {
    const siteInput = input.sites[site];
    assertExactKeys(siteInput, SITE_RECORD_KEYS, `sites.${site}`);
    if (!Number.isInteger(siteInput.recoveryAttempts) || siteInput.recoveryAttempts < 0) {
      fail('INVALID_RECOVERY_ATTEMPTS', `sites.${site}.recoveryAttempts must be a non-negative integer`, { site });
    }
    assertExactKeys(siteInput.evidence, CATALOG_ALIGNMENT_EVIDENCE_STAGES, `sites.${site}.evidence`);
    const evidence = {};
    let previousPassed = true;
    let sawPending = false;
    for (const stage of CATALOG_ALIGNMENT_EVIDENCE_STAGES) {
      const normalized = validateEvidence(siteInput.evidence[stage], {
        site,
        stage,
        catalogVersion,
        expectedHash: expectedPublicContentHashes[site],
      });
      if (normalized.state !== 'pending' && (!previousPassed || sawPending)) {
        fail('INVALID_EVIDENCE_ORDER', `sites.${site}.evidence.${stage} was recorded before its prerequisites`, { site, stage });
      }
      if (normalized.state === 'pending') sawPending = true;
      previousPassed = normalized.state === 'passed';
      evidence[stage] = normalized;
    }
    sites[site] = { recoveryAttempts: siteInput.recoveryAttempts, evidence };
  }
  const state = deriveRecordState(sites);
  if (!RECORD_STATES.has(input.state) || input.state !== state) {
    fail('INCONSISTENT_RECORD_STATE', `Catalog Alignment record state must be ${state}`, { expected: state, actual: input.state });
  }
  return deepFreeze({
    schemaVersion: CATALOG_ALIGNMENT_SCHEMA_VERSION,
    catalogVersion,
    expectedPublicContentHashes,
    state,
    sites,
  });
}

function normalizeEvidenceUpdate(record, { site, stage, outcome, checkedAt, revision = null, catalogVersion = null, publicContentHash = null }) {
  assertSite(site);
  if (!CATALOG_ALIGNMENT_EVIDENCE_STAGES.includes(stage)) {
    fail('INVALID_EVIDENCE_STAGE', 'Evidence stage is unsupported', { site, stage });
  }
  if (!['passed', 'failed'].includes(outcome)) {
    fail('INVALID_EVIDENCE', 'Evidence outcome must be passed or failed', { site, stage, outcome });
  }
  assertIsoTimestamp(checkedAt, 'checkedAt');
  const stageIndex = CATALOG_ALIGNMENT_EVIDENCE_STAGES.indexOf(stage);
  for (const prerequisite of CATALOG_ALIGNMENT_EVIDENCE_STAGES.slice(0, stageIndex)) {
    if (record.sites[site].evidence[prerequisite].state !== 'passed') {
      fail('EVIDENCE_PREREQUISITE_MISSING', `${site}.${stage} requires ${prerequisite} to pass first`, { site, stage, prerequisite });
    }
  }
  if (record.sites[site].evidence[stage].state !== 'pending') {
    fail('EVIDENCE_ALREADY_RECORDED', `${site}.${stage} evidence is immutable; begin recovery before retrying it`, { site, stage });
  }
  let state = outcome;
  if (['local', 'liveHash'].includes(stage) && outcome === 'passed') {
    if (catalogVersion !== record.catalogVersion || publicContentHash !== record.expectedPublicContentHashes[site]) {
      state = 'failed';
    }
  }
  return {
    state,
    checkedAt,
    revision,
    catalogVersion,
    publicContentHash,
  };
}

export function recordCatalogAlignmentEvidence(recordInput, update) {
  const record = validateCatalogAlignmentRecord(recordInput);
  const normalized = normalizeEvidenceUpdate(record, update || {});
  const next = clone(record);
  next.sites[update.site].evidence[update.stage] = normalized;
  next.state = deriveRecordState(next.sites);
  return validateCatalogAlignmentRecord(next);
}

function retryableSitesFor(record) {
  return CATALOG_ALIGNMENT_SITES.filter(site => CATALOG_ALIGNMENT_EVIDENCE_STAGES.some(
    stage => record.sites[site].evidence[stage].state === 'failed',
  ));
}

export function beginCatalogAlignmentRecovery(recordInput, requestedSite = null) {
  const record = validateCatalogAlignmentRecord(recordInput);
  const retryableSites = retryableSitesFor(record);
  if (!retryableSites.length) {
    fail('RECOVERY_NOT_AVAILABLE', 'Catalog Alignment recovery requires a failed site', { state: record.state });
  }
  const site = requestedSite === null
    ? (retryableSites.length === 1 ? retryableSites[0] : null)
    : assertSite(requestedSite, 'requestedSite');
  if (!site) {
    fail('RECOVERY_SITE_REQUIRED', 'Choose one failed site to retry', { retryableSites });
  }
  if (!retryableSites.includes(site)) {
    fail('RECOVERY_NOT_AVAILABLE', `${site} has no failed evidence to retry`, { site, retryableSites });
  }
  const firstFailedIndex = CATALOG_ALIGNMENT_EVIDENCE_STAGES.findIndex(
    stage => record.sites[site].evidence[stage].state === 'failed',
  );
  const next = clone(record);
  for (const stage of CATALOG_ALIGNMENT_EVIDENCE_STAGES.slice(firstFailedIndex)) {
    next.sites[site].evidence[stage] = pendingEvidence();
  }
  next.sites[site].recoveryAttempts += 1;
  next.state = deriveRecordState(next.sites);
  return validateCatalogAlignmentRecord(next);
}

export function assertNextCatalogReleaseAllowed(recordInput) {
  if (recordInput === null || recordInput === undefined) return true;
  const record = validateCatalogAlignmentRecord(recordInput);
  if (record.state !== 'aligned') throw new CatalogAlignmentBlockedError(record);
  return true;
}
