import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import XLSX from 'xlsx';

import {
  CATALOG_ALIGNMENT_EVIDENCE_STAGES,
  assertNextCatalogReleaseAllowed,
  beginCatalogAlignmentRecovery,
  evaluateCatalogAlignmentManifests,
  recordCatalogAlignmentEvidence,
} from '../../catalog/catalog-alignment.js';
import {
  applyCatalogChangePlan,
  createCatalogChangePlan,
  createCatalogChangeRecord,
} from '../../catalog/catalog-change-plan.js';
import { createCatalogAlignmentArtifacts } from '../../scripts/generate-catalog-alignment.mjs';
import { compileProductCatalogWorkbook } from '../../scripts/compile-product-master-workbook.mjs';

XLSX.set_fs(fs);

const OLD_VERSION = '2026-08-28.4';
const NEW_VERSION = '2026-08-29.1';
const GENERATED_AT = '2026-08-29T01:02:03.000Z';
const FBA_REPO = path.resolve(process.env.FBA_REPO || path.join(import.meta.dirname, '..', '..', '..', 'FBA'));
const REVISION = '0123456789abcdef0123456789abcdef01234567';

function packaging(version, unitsPerCarton, sourceRow) {
  return {
    version,
    effectiveFrom:version.slice(0, 10),
    effectiveTo:null,
    unitsPerCarton,
    cartonsPerPallet:40,
    cartonDimensionsCm:[50.8, 40.64, 30.48],
    grossWeightKg:null,
    grossWeightLb:25,
    orderUnit:{ kind:'single', units:1 },
    source:{ sheet:'baseline', row:sourceRow },
  };
}

function baselineCatalog() {
  return {
    schemaVersion:3,
    catalogVersion:OLD_VERSION,
    products:[
      {
        productSku:'SEAM01',
        productName:'Catalog seam product',
        origin:'VN',
        standardFactory:'VN',
        lifecycle:'active',
        approvedOrderSkus:['SEAM01'],
        newOrderPackagingDefaultVersion:OLD_VERSION,
        packagingVersions:[packaging(OLD_VERSION, 24, 8)],
      },
      {
        productSku:'KEEP01',
        productName:'Unselected catalog product',
        origin:'TW',
        standardFactory:'TW',
        lifecycle:'active',
        approvedOrderSkus:['KEEP01'],
        newOrderPackagingDefaultVersion:OLD_VERSION,
        packagingVersions:[packaging(OLD_VERSION, 12, 9)],
      },
    ],
    orderSkuAliases:[],
  };
}

function rawWorkbookRows(units = [30]) {
  const top = Array(18).fill('');
  const headers = Array(18).fill('');
  top[2] = '產地';
  top[4] = '包數/箱';
  top[12] = '紙箱規格';
  top[13] = '箱/棧板';
  top[16] = '每箱產品的毛重';
  headers[1] = 'SKU';
  headers[17] = 'GW (lb)';
  return [top, headers, ...units.map(value => {
    const row = Array(18).fill('');
    row[1] = 'SEAM01';
    // A blank origin is intentionally sparse: the known baseline origin/factory must survive.
    row[4] = value;
    row[12] = '50.8*40.64*30.48';
    row[13] = 40;
    row[17] = 25;
    return row;
  })];
}

function writeRawWorkbook(filePath, units = [30]) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rawWorkbookRows(units)), '2026');
  XLSX.writeFile(workbook, filePath);
}

function compileRawFixture(t, units = [30]) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-release-seam-'));
  t.after(() => fs.rmSync(temporary, { recursive:true, force:true }));
  const inputPath = path.join(temporary, 'raw-product-information.xlsx');
  const basePath = path.join(temporary, 'baseline.json');
  const outputPath = path.join(temporary, 'candidate.json');
  fs.writeFileSync(basePath, `${JSON.stringify(baselineCatalog(), null, 2)}\n`);
  writeRawWorkbook(inputPath, units);
  const compiled = compileProductCatalogWorkbook({
    inputPath,
    outputPath,
    basePath,
    version:NEW_VERSION,
  });
  return { ...compiled, inputPath };
}

function planMetadata(compiled, inputPath) {
  return {
    generatedAt:GENERATED_AT,
    sourceFile:inputPath,
    duplicateConflicts:compiled.importStats.duplicateConflicts,
    conflicts:compiled.importStats.sourceConflicts,
    rawSources:compiled.importStats.sourceRecords,
  };
}

function alignmentEvidence(release, site, stage, outcome = 'passed') {
  const update = {
    site,
    stage,
    outcome,
    checkedAt:GENERATED_AT,
    revision:stage === 'local' ? null : REVISION,
    catalogVersion:null,
    publicContentHash:null,
  };
  if (stage === 'local' || stage === 'liveHash') {
    update.catalogVersion = release.record.catalogVersion;
    update.publicContentHash = release.record.expectedPublicContentHashes[site];
  }
  return update;
}

function passAlignmentSite(release, record, site) {
  let next = record;
  for (const stage of CATALOG_ALIGNMENT_EVIDENCE_STAGES) {
    next = recordCatalogAlignmentEvidence(next, alignmentEvidence(release, site, stage));
  }
  return next;
}

test('one real raw workbook flows through review, selected apply, both public projections, Change Record, and aligned manifests', async t => {
  assert.equal(fs.existsSync(path.join(FBA_REPO, 'product-catalog.js')), true, 'FBA sibling repository is required for the release seam');
  const before = baselineCatalog();
  const compiled = compileRawFixture(t);
  const candidate = compiled.catalog;

  assert.equal(candidate.products.find(item => item.productSku === 'SEAM01').origin, 'VN', 'raw blank preserves the known origin');
  assert.equal(candidate.products.find(item => item.productSku === 'SEAM01').standardFactory, 'VN', 'raw blank preserves routing');
  assert.equal(candidate.products.find(item => item.productSku === 'KEEP01').newOrderPackagingDefaultVersion, OLD_VERSION);

  const plan = await createCatalogChangePlan(before, candidate, planMetadata(compiled, compiled.inputPath));
  assert.deepEqual(plan.blockers, []);
  assert.deepEqual(plan.entries.map(entry => entry.id), ['product:SEAM01']);
  assert.equal(plan.entries[0].evidence.sources[0].sheet, '2026');
  assert.equal(plan.entries[0].evidence.sources[0].row, 3);

  const applied = await applyCatalogChangePlan(before, candidate, plan, {
    selectedEntryIds:['product:SEAM01'],
  });
  const seamProduct = applied.catalog.products.find(item => item.productSku === 'SEAM01');
  assert.deepEqual(seamProduct.packagingVersions.map(item => item.version), [OLD_VERSION, NEW_VERSION]);
  assert.equal(seamProduct.newOrderPackagingDefaultVersion, NEW_VERSION);
  assert.equal(applied.catalog.products.find(item => item.productSku === 'KEEP01').packagingVersions.length, 1);

  const artifacts = createCatalogAlignmentArtifacts({ catalog:applied.catalog, fbaRepo:FBA_REPO });
  const supplyProduct = artifacts.supplyProjection.products.find(item => item.productCode === 'SEAM01');
  const fbaProduct = artifacts.fbaProjection.products.find(item => item.productSku === 'SEAM01');
  assert.equal(supplyProduct.packagingVersion, NEW_VERSION);
  assert.equal(supplyProduct.perCarton, 30);
  assert.equal(fbaProduct.newWorkPackagingDefaultVersion, NEW_VERSION);
  assert.deepEqual(fbaProduct.packagingVersions.map(item => item.packagingVersion), [OLD_VERSION, NEW_VERSION]);
  assert.equal(JSON.stringify(artifacts.fbaProjection).includes('sourceSheet'), false);
  assert.equal(JSON.stringify(artifacts.fbaProjection).includes('baseline'), false);

  const record = await createCatalogChangeRecord(plan, applied.catalog, applied.selectedEntryIds, {
    appliedAt:GENERATED_AT,
    catalogAlignment:artifacts.release.record,
  });
  assert.equal(record.catalogVersion, NEW_VERSION);
  assert.deepEqual(record.selectedEntryIds, ['product:SEAM01']);
  assert.equal(record.catalogAlignment.catalogVersion, NEW_VERSION);
  assert.equal(JSON.stringify(record).includes('raw-product-information.xlsx'), false);
  assert.equal(JSON.stringify(record).includes('sourceSheet'), false);

  assert.equal(
    evaluateCatalogAlignmentManifests(artifacts.release.manifests.supply, artifacts.release.manifests.fba).state,
    'aligned',
  );
});

test('conflicting duplicate source rows retain exact row/value evidence and block the whole seam before apply', async t => {
  const before = baselineCatalog();
  const compiled = compileRawFixture(t, [30, 31]);
  const plan = await createCatalogChangePlan(before, compiled.catalog, planMetadata(compiled, compiled.inputPath));

  assert.equal(plan.stats.blocking, 1);
  assert.match(plan.blockers[0], /SEAM01.*30.*2026 第 3 列.*31.*2026 第 4 列/);
  assert.deepEqual(plan.entries.find(entry => entry.kind === 'source-conflict').fields[0].values, [
    { value:30, sourceSheet:'2026', sourceRow:3 },
    { value:31, sourceSheet:'2026', sourceRow:4 },
  ]);
  await assert.rejects(
    () => applyCatalogChangePlan(before, compiled.catalog, plan, { selectedEntryIds:['product:SEAM01'] }),
    /產品資料發布被阻擋/,
  );
});

test('the real raw release seam blocks a stale plan, persists one-site failure, and recovers only that projection', async t => {
  const before = baselineCatalog();
  const compiled = compileRawFixture(t);
  const candidate = compiled.catalog;
  const plan = await createCatalogChangePlan(before, candidate, planMetadata(compiled, compiled.inputPath));

  const interveningBaseline = structuredClone(before);
  interveningBaseline.products[0].productName = 'Changed after the reviewed plan';
  await assert.rejects(
    () => applyCatalogChangePlan(interveningBaseline, candidate, plan, { selectedEntryIds:['product:SEAM01'] }),
    /已在計畫建立後更新/,
  );

  const applied = await applyCatalogChangePlan(before, candidate, plan, { selectedEntryIds:['product:SEAM01'] });
  const current = createCatalogAlignmentArtifacts({ catalog:applied.catalog, fbaRepo:FBA_REPO });
  const previous = createCatalogAlignmentArtifacts({ catalog:before, fbaRepo:FBA_REPO });
  assert.equal(
    evaluateCatalogAlignmentManifests(current.release.manifests.supply, previous.release.manifests.fba).state,
    'failed',
  );

  let record = passAlignmentSite(current.release, current.release.record, 'supply');
  record = recordCatalogAlignmentEvidence(record, alignmentEvidence(current.release, 'fba', 'local'));
  record = recordCatalogAlignmentEvidence(record, alignmentEvidence(current.release, 'fba', 'repositoryCi'));
  record = recordCatalogAlignmentEvidence(record, alignmentEvidence(current.release, 'fba', 'deployment', 'failed'));
  const persistedFailure = JSON.parse(JSON.stringify(record));
  assert.equal(persistedFailure.state, 'failed');
  assert.throws(() => assertNextCatalogReleaseAllowed(persistedFailure), /repair Catalog Alignment/);

  const successfulSupply = structuredClone(record.sites.supply);
  record = beginCatalogAlignmentRecovery(persistedFailure, 'fba');
  assert.equal(record.sites.fba.recoveryAttempts, 1);
  assert.equal(record.sites.fba.evidence.deployment.state, 'pending');
  assert.deepEqual(record.sites.supply, successfulSupply, 'recovery must not roll back or rewrite the successful site');
  assert.throws(() => assertNextCatalogReleaseAllowed(record), /repair Catalog Alignment/);

  for (const stage of ['deployment', 'liveHash', 'liveBrowser']) {
    record = recordCatalogAlignmentEvidence(record, alignmentEvidence(current.release, 'fba', stage));
  }
  assert.equal(record.state, 'aligned');
  assert.equal(assertNextCatalogReleaseAllowed(record), true);
  assert.equal(
    evaluateCatalogAlignmentManifests(current.release.manifests.supply, current.release.manifests.fba).state,
    'aligned',
  );
});
