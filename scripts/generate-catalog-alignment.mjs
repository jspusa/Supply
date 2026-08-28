import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createCatalogAlignmentRelease } from '../catalog/catalog-alignment.js';
import { compileCatalog } from '../catalog/product-catalog.js';
import { supplyCatalogAdapter } from '../catalog/supply-catalog-adapter.js';

const require = createRequire(import.meta.url);
export const supplyRepo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const canonicalCatalogPath = path.join(supplyRepo, 'catalog', 'product-catalog.json');
export const supplyManifestPath = path.join(supplyRepo, 'catalog-alignment.json');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function serialized(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function resolveFbaProjector(fbaRepo) {
  const modulePath = path.join(fbaRepo, 'product-catalog.js');
  if (!fs.existsSync(modulePath)) throw new Error(`FBA product catalog projector not found: ${modulePath}`);
  const api = require(modulePath);
  if (typeof api.projectCanonicalCatalog !== 'function') throw new Error('FBA product catalog projector is incompatible');
  return api.projectCanonicalCatalog;
}

export function createCatalogAlignmentArtifacts({ catalog, fbaRepo, projectFba = null }) {
  const supplyProjection = compileCatalog(catalog, supplyCatalogAdapter);
  const fbaProjection = (projectFba || resolveFbaProjector(fbaRepo))(catalog);
  const release = createCatalogAlignmentRelease({
    catalogVersion:catalog.catalogVersion,
    publicContent:{ supply:supplyProjection, fba:fbaProjection },
  });
  return { release, supplyProjection, fbaProjection };
}

export function writeCatalogAlignmentManifests({
  catalogPath = canonicalCatalogPath,
  fbaRepo,
  check = false,
} = {}) {
  if (!fbaRepo) throw new Error('FBA repository path is required');
  const resolvedFbaRepo = path.resolve(fbaRepo);
  const fbaManifestPath = path.join(resolvedFbaRepo, 'catalog-alignment.json');
  const catalog = readJson(path.resolve(catalogPath));
  const artifacts = createCatalogAlignmentArtifacts({ catalog, fbaRepo:resolvedFbaRepo });
  const outputs = [
    [supplyManifestPath, serialized(artifacts.release.manifests.supply)],
    [fbaManifestPath, serialized(artifacts.release.manifests.fba)],
  ];
  for (const [filePath, content] of outputs) {
    if (check) {
      if (!fs.existsSync(filePath) || fs.readFileSync(filePath, 'utf8') !== content) {
        throw new Error(`${filePath} is stale relative to the canonical public projections`);
      }
    } else {
      fs.writeFileSync(filePath, content);
    }
  }
  return { ...artifacts, paths:{ supply:supplyManifestPath, fba:fbaManifestPath } };
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
  const fbaRepo = path.resolve(option(argv, '--fba-repo') || path.join(supplyRepo, '..', 'FBA'));
  const result = writeCatalogAlignmentManifests({
    catalogPath:path.resolve(option(argv, '--catalog') || canonicalCatalogPath),
    fbaRepo,
    check:argv.includes('--check'),
  });
  const verb = argv.includes('--check') ? 'Verified' : 'Generated';
  console.log(`${verb} Catalog Alignment ${result.release.record.catalogVersion} (${result.release.record.expectedPublicContentHashes.supply} / ${result.release.record.expectedPublicContentHashes.fba})`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
