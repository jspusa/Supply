import assert from 'node:assert/strict';
import test from 'node:test';

import {
  assertCatalogPeerRevision,
  createCatalogPeerLock,
  readCatalogPeerLock,
  validateCatalogPeerLock,
} from '../scripts/catalog-peer-lock.mjs';

const revision = '0123456789abcdef0123456789abcdef01234567';
const publicContentHash = 'a'.repeat(64);
const alignment = {
  catalogVersion:'2026-08-29.1',
  expectedPublicContentHashes:{ fba:publicContentHash },
};
const validLock = {
  schemaVersion:1,
  repository:'jspusa/FBA',
  revision,
  catalogVersion:alignment.catalogVersion,
  publicContentHash,
};

test('checked-in peer lock pins one exact FBA commit and matches Catalog Alignment', () => {
  const lock = readCatalogPeerLock();
  assert.match(lock.revision, /^[a-f0-9]{40}$/);
  assert.equal(lock.repository, 'jspusa/FBA');
});

test('peer lock is derived only from matching Supply and FBA alignment manifests', () => {
  const fbaAlignment = {
    site:'fba',
    catalogVersion:alignment.catalogVersion,
    publicContentHash,
    expectedPublicContentHashes:{ ...alignment.expectedPublicContentHashes },
  };
  assert.deepEqual(createCatalogPeerLock({ alignment, fbaAlignment, revision }), validLock);
  assert.throws(() => createCatalogPeerLock({
    alignment,
    fbaAlignment:{ ...fbaAlignment, publicContentHash:'b'.repeat(64) },
    revision,
  }), /does not match/);
});

test('peer lock rejects an untrusted repository, branch name, stale version, hash, or extra field', () => {
  assert.throws(() => validateCatalogPeerLock({ ...validLock, repository:'attacker/FBA' }, alignment), /jspusa\/FBA/);
  assert.throws(() => validateCatalogPeerLock({ ...validLock, revision:'feature/catalog' }, alignment), /exact lowercase/);
  assert.throws(() => validateCatalogPeerLock({ ...validLock, catalogVersion:'2026-08-28.1' }, alignment), /does not match/);
  assert.throws(() => validateCatalogPeerLock({ ...validLock, publicContentHash:'b'.repeat(64) }, alignment), /does not match/);
  assert.throws(() => validateCatalogPeerLock({ ...validLock, ref:'main' }, alignment), /must contain only/);
});

test('checked-out FBA revision must equal the pinned immutable commit', () => {
  assert.equal(assertCatalogPeerRevision(validLock, revision), revision);
  assert.throws(() => assertCatalogPeerRevision(validLock, 'f'.repeat(40)), /does not match pinned/);
});
