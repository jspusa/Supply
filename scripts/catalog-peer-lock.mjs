import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT_SHA = /^[a-f0-9]{40}$/;
const CATALOG_VERSION = /^\d{4}-\d{2}-\d{2}(?:\.\d+)?$/;
const LOCK_KEYS = Object.freeze([
  'catalogVersion',
  'publicContentHash',
  'repository',
  'revision',
  'schemaVersion',
]);

function exactKeys(value, expected, label) {
  const actual = Object.keys(value || {}).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
    throw new Error(`${label} must contain only ${expected.join(', ')}`);
  }
}

export function validateCatalogPeerLock(lock, alignment) {
  if (!lock || typeof lock !== 'object' || Array.isArray(lock)) {
    throw new Error('Catalog peer lock must be an object');
  }
  exactKeys(lock, LOCK_KEYS, 'Catalog peer lock');
  if (lock.schemaVersion !== 1) throw new Error('Catalog peer lock schemaVersion must equal 1');
  if (lock.repository !== 'jspusa/FBA') throw new Error('Catalog peer lock repository must equal jspusa/FBA');
  if (!COMMIT_SHA.test(String(lock.revision || ''))) {
    throw new Error('Catalog peer lock revision must be an exact lowercase 40-character commit SHA');
  }
  if (!CATALOG_VERSION.test(String(lock.catalogVersion || ''))) {
    throw new Error('Catalog peer lock catalogVersion is invalid');
  }
  if (!SHA256.test(String(lock.publicContentHash || ''))) {
    throw new Error('Catalog peer lock publicContentHash must be a lowercase SHA-256 value');
  }
  if (!alignment || typeof alignment !== 'object' || Array.isArray(alignment)) {
    throw new Error('Supply Catalog Alignment manifest is required');
  }
  if (lock.catalogVersion !== alignment.catalogVersion) {
    throw new Error(`Catalog peer lock version ${lock.catalogVersion} does not match Supply ${alignment.catalogVersion}`);
  }
  if (lock.publicContentHash !== alignment.expectedPublicContentHashes?.fba) {
    throw new Error('Catalog peer lock FBA public-content hash does not match Supply Catalog Alignment');
  }
  return Object.freeze({ ...lock });
}

export function readCatalogPeerLock({ supplyRoot = SCRIPT_ROOT } = {}) {
  const lockPath = path.join(supplyRoot, '.github', 'catalog-peer-lock.json');
  const alignmentPath = path.join(supplyRoot, 'catalog-alignment.json');
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const alignment = JSON.parse(fs.readFileSync(alignmentPath, 'utf8'));
  return validateCatalogPeerLock(lock, alignment);
}

export function createCatalogPeerLock({ alignment, fbaAlignment, revision }) {
  if (fbaAlignment?.site !== 'fba') throw new Error('FBA Catalog Alignment manifest must declare site fba');
  if (fbaAlignment.catalogVersion !== alignment?.catalogVersion) {
    throw new Error('Supply and FBA Catalog Alignment versions do not match');
  }
  if (JSON.stringify(fbaAlignment.expectedPublicContentHashes) !== JSON.stringify(alignment.expectedPublicContentHashes)) {
    throw new Error('Supply and FBA expected public-content hashes do not match');
  }
  if (fbaAlignment.publicContentHash !== alignment.expectedPublicContentHashes?.fba) {
    throw new Error('FBA public-content hash does not match the shared expectation');
  }
  return validateCatalogPeerLock({
    schemaVersion:1,
    repository:'jspusa/FBA',
    revision:String(revision || '').trim(),
    catalogVersion:alignment.catalogVersion,
    publicContentHash:fbaAlignment.publicContentHash,
  }, alignment);
}

export function writeCatalogPeerLock({ supplyRoot = SCRIPT_ROOT, fbaRepo }) {
  const resolvedFbaRepo = path.resolve(fbaRepo);
  const alignment = JSON.parse(fs.readFileSync(path.join(supplyRoot, 'catalog-alignment.json'), 'utf8'));
  const fbaAlignment = JSON.parse(fs.readFileSync(path.join(resolvedFbaRepo, 'catalog-alignment.json'), 'utf8'));
  const lock = createCatalogPeerLock({
    alignment,
    fbaAlignment,
    revision:readRepositoryHead(resolvedFbaRepo),
  });
  const lockPath = path.join(supplyRoot, '.github', 'catalog-peer-lock.json');
  fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
  return lock;
}

export function assertCatalogPeerRevision(lock, actualRevision) {
  const actual = String(actualRevision || '').trim();
  if (!COMMIT_SHA.test(actual)) throw new Error('Checked-out FBA revision is not an exact commit SHA');
  if (actual !== lock.revision) {
    throw new Error(`Checked-out FBA revision ${actual} does not match pinned ${lock.revision}`);
  }
  return actual;
}

export function readRepositoryHead(repositoryPath) {
  return execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd:path.resolve(repositoryPath),
    encoding:'utf8',
    stdio:['ignore', 'pipe', 'pipe'],
  }).trim();
}

function option(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function main() {
  const argv = process.argv.slice(2);
  const writePeerPath = option(argv, '--write-peer');
  const lock = writePeerPath
    ? writeCatalogPeerLock({ fbaRepo:writePeerPath })
    : readCatalogPeerLock();
  const peerPath = option(argv, '--check-peer');
  if (peerPath) assertCatalogPeerRevision(lock, readRepositoryHead(peerPath));
  if (argv.includes('--github-output')) {
    const outputPath = String(process.env.GITHUB_OUTPUT || '').trim();
    if (!outputPath) throw new Error('GITHUB_OUTPUT is required for --github-output');
    fs.appendFileSync(outputPath, `revision=${lock.revision}\n`, 'utf8');
    return;
  }
  process.stdout.write(`${lock.revision}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
