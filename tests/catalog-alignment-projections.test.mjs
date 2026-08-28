import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { hashPublicContent } from '../catalog/catalog-alignment.js';
import { compileCatalog } from '../catalog/product-catalog.js';
import { supplyCatalogAdapter } from '../catalog/supply-catalog-adapter.js';
import {
  canonicalCatalogPath,
  createCatalogAlignmentArtifacts,
  supplyRepo,
} from '../scripts/generate-catalog-alignment.mjs';

const fbaRepo = path.resolve(process.env.FBA_REPO || path.join(supplyRepo, '..', 'FBA'));

test('both compact alignment manifests hash the supplied public projections', () => {
  const catalog = JSON.parse(fs.readFileSync(canonicalCatalogPath, 'utf8'));
  const projectFba = input => ({
    schemaVersion:2,
    catalogVersion:input.catalogVersion,
    projection:'fba-test',
    products:[{ productSku:'ABC01', packagingVersion:'v1' }],
  });
  const { release, supplyProjection, fbaProjection } = createCatalogAlignmentArtifacts({ catalog, projectFba });

  assert.equal(release.manifests.supply.catalogVersion, catalog.catalogVersion);
  assert.equal(release.manifests.fba.catalogVersion, catalog.catalogVersion);
  assert.deepEqual(release.manifests.supply.expectedPublicContentHashes, release.manifests.fba.expectedPublicContentHashes);
  assert.equal(supplyProjection.meta.catalogVersion, catalog.catalogVersion);
  assert.equal(fbaProjection.catalogVersion, catalog.catalogVersion);
  assert.equal(JSON.stringify(release.manifests).includes('products'), false);
  assert.equal(JSON.stringify(release.manifests).includes('orderSkuAliases'), false);
});

test('checked-in Supply manifest hashes the exact standalone Supply projection', () => {
  const catalog = JSON.parse(fs.readFileSync(canonicalCatalogPath, 'utf8'));
  const manifest = JSON.parse(fs.readFileSync(path.join(supplyRepo, 'catalog-alignment.json'), 'utf8'));
  const projection = compileCatalog(catalog, supplyCatalogAdapter);

  assert.equal(manifest.site, 'supply');
  assert.equal(manifest.catalogVersion, catalog.catalogVersion);
  assert.equal(manifest.publicContentHash, hashPublicContent(projection));
  assert.equal(manifest.publicContentHash, manifest.expectedPublicContentHashes.supply);
});

test('local two-repository checkout produces the checked-in pair', {
  skip:!process.env.FBA_REPO && !fs.existsSync(path.join(fbaRepo, 'product-catalog.js')),
}, () => {
  assert.equal(fs.existsSync(path.join(fbaRepo, 'product-catalog.js')), true, `Pinned FBA checkout is missing: ${fbaRepo}`);
  const catalog = JSON.parse(fs.readFileSync(canonicalCatalogPath, 'utf8'));
  const { release } = createCatalogAlignmentArtifacts({ catalog, fbaRepo });
  const supplyManifest = JSON.parse(fs.readFileSync(path.join(supplyRepo, 'catalog-alignment.json'), 'utf8'));
  const fbaManifest = JSON.parse(fs.readFileSync(path.join(fbaRepo, 'catalog-alignment.json'), 'utf8'));

  assert.deepEqual(release.manifests.supply, supplyManifest);
  assert.deepEqual(release.manifests.fba, fbaManifest);
});
