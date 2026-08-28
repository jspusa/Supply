import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  assertNewCatalogVersion,
  nextCatalogVersion,
} from '../catalog/product-catalog-release.js';
import {
  applyCatalogChangePlan,
  createCatalogChangePlan,
  createCatalogChangeRecord,
  renderCatalogChangePlan,
  publicCatalogSha256,
  sha256,
  stableJson,
} from '../catalog/catalog-change-plan.js';
import {
  assertNextCatalogReleaseAllowed,
  recordCatalogAlignmentEvidence,
} from '../catalog/catalog-alignment.js';
import { validateCatalogUpdateHandoff } from '../shared/catalog-update-handoff.mjs';
import { writeSupplyProductData } from './compile-product-catalog.mjs';
import { compileProductCatalogWorkbook } from './compile-product-master-workbook.mjs';
import { writeCatalogAlignmentManifests } from './generate-catalog-alignment.mjs';
import { writeCatalogUpdateRuntime } from './generate-catalog-update-runtime.mjs';

const supplyRepo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const canonicalPath = path.join(supplyRepo, 'catalog', 'product-catalog.json');
const supplySnapshotPath = path.join(supplyRepo, 'product-data.js');
const PLAN_CLEAR_FIELDS = Object.freeze({
  cartonDimensionsIn:['cartonDimensionsCm'],
  cartonsPerPallet:['cartonsPerPallet'],
  grossWeightLb:['grossWeightLb', 'grossWeightKg'],
  origin:['origin'],
  standardFactory:['standardFactory'],
  unitsPerCarton:['unitsPerCarton'],
});

function parseOptions(argv) {
  const options = { apply:false, verify:false, select:[] };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--apply' || key === '--verify') {
      options[key.slice(2)] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value || value.startsWith('--')) throw new Error(`Invalid option near ${key || 'end of command'}`);
    const name = key.slice(2);
    if (name === 'select') options.select.push(...value.split(',').map(item => item.trim()).filter(Boolean));
    else options[name] = value;
    index += 1;
  }
  return options;
}

function taipeiDay(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone:'Asia/Taipei', year:'numeric', month:'2-digit', day:'2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function resolveCatalogReleaseVersion(currentVersion, {
  requestedVersion = null,
  reviewedPlan = null,
  releaseDate = taipeiDay(),
} = {}) {
  if (requestedVersion) return assertNewCatalogVersion(currentVersion, requestedVersion);
  if (reviewedPlan) return assertNewCatalogVersion(currentVersion, reviewedPlan.candidate?.catalogVersion);
  return nextCatalogVersion(currentVersion, releaseDate);
}

export function explicitClearsFromReviewedPlan(plan) {
  const bySku = new Map();
  for (const entry of plan?.entries || []) {
    if (entry?.kind !== 'catalog-change') continue;
    for (const field of entry.fields || []) {
      if (field?.after !== null || field.before === null || field.before === undefined) continue;
      const rawFields = PLAN_CLEAR_FIELDS[field.field];
      if (!rawFields) continue;
      if (!bySku.has(entry.sku)) bySku.set(entry.sku, new Set());
      rawFields.forEach(item => bySku.get(entry.sku).add(item));
    }
  }
  return [...bySku].map(([sku, fields]) => ({ sku, fields:[...fields] }));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding:'utf8', stdio:'pipe' });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed in ${cwd}`);
}

function assertRepo(repoPath, packageName) {
  const packagePath = path.join(repoPath, 'package.json');
  if (!fs.existsSync(packagePath)) throw new Error(`Repository not found: ${repoPath}`);
  const pkg = readJson(packagePath);
  if (pkg.name !== packageName) throw new Error(`Expected ${packageName} at ${repoPath}, found ${pkg.name || 'unknown package'}`);
}

function assertClean(repoPath) {
  const result = spawnSync('git', ['status', '--porcelain'], { cwd:repoPath, encoding:'utf8' });
  if (result.status !== 0) throw new Error(`Cannot inspect Git status in ${repoPath}`);
  if (result.stdout.trim()) throw new Error(`Release apply requires a clean worktree: ${repoPath}`);
}

function writeJson(value, outputPath) {
  if (!outputPath) return;
  const resolved = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolved), { recursive:true });
  fs.writeFileSync(resolved, `${JSON.stringify(value, null, 2)}\n`);
}

function captureFiles(filePaths) {
  return filePaths.map(filePath => ({
    filePath,
    existed:fs.existsSync(filePath),
    content:fs.existsSync(filePath) ? fs.readFileSync(filePath) : null,
  }));
}

function restoreFiles(snapshot) {
  for (const item of snapshot) {
    if (item.existed) {
      fs.mkdirSync(path.dirname(item.filePath), { recursive:true });
      fs.writeFileSync(item.filePath, item.content);
    } else if (fs.existsSync(item.filePath)) {
      fs.rmSync(item.filePath, { force:true });
    }
  }
}

function previousAlignmentRecord() {
  const latestPath = path.join(supplyRepo, 'catalog', 'alignment-records', 'latest.json');
  return fs.existsSync(latestPath) ? readJson(latestPath) : null;
}

function recordLocalAlignmentEvidence(release, checkedAt = new Date().toISOString()) {
  let record = release.record;
  for (const site of ['supply', 'fba']) {
    record = recordCatalogAlignmentEvidence(record, {
      site,
      stage:'local',
      outcome:'passed',
      checkedAt,
      catalogVersion:record.catalogVersion,
      publicContentHash:record.expectedPublicContentHashes[site],
    });
  }
  return record;
}

function verifyRelease({ fbaRepo }) {
  run('npm', ['test'], supplyRepo);
  run('npm', ['run', 'catalog:check'], supplyRepo);
  run('npm', ['run', 'build'], supplyRepo);
  run('npm', ['run', 'verify:dist'], supplyRepo);
  run('npm', ['test'], fbaRepo);
  const supplyShared = fs.readFileSync(path.join(supplyRepo, 'shared', 'shared-product-catalog.js'));
  const fbaShared = fs.readFileSync(path.join(fbaRepo, 'shared-product-catalog.js'));
  if (!supplyShared.equals(fbaShared)) throw new Error('Supply and FBA shared-product-catalog.js differ');
}

function reviewedPlanEvidence(plan) {
  return {
    baseline:plan.baseline,
    candidate:plan.candidate,
    blockers:plan.blockers,
    entries:plan.entries,
  };
}

export async function assertReviewedPlan(reviewed, generated) {
  const unsigned = { ...reviewed };
  delete unsigned.planSha256;
  if (!reviewed.planSha256 || reviewed.planSha256 !== await sha256(unsigned)) {
    throw new Error('已審核的產品資料變更計畫簽章不一致，請重新產生計畫');
  }
  if (stableJson(reviewedPlanEvidence(reviewed)) !== stableJson(reviewedPlanEvidence(generated))) {
    throw new Error('原始 Excel、canonical baseline 或衝突資料已變更，請重新產生並審核計畫');
  }
}

export function selectionsFromHandoff(handoffInput, reviewedPlan) {
  const handoff = validateCatalogUpdateHandoff(handoffInput);
  if (
    handoff.planSha256 !== reviewedPlan.planSha256
    || stableJson(handoff.baseline) !== stableJson(reviewedPlan.baseline)
    || stableJson(handoff.candidate) !== stableJson(reviewedPlan.candidate)
  ) {
    throw new Error('產品更新入口的選取交接不屬於這份已審核計畫，請重新確認');
  }
  const entries = new Map((reviewedPlan.entries || []).map(entry => [entry.id, entry]));
  for (const id of handoff.selectedEntryIds) {
    const entry = entries.get(id);
    if (!entry || entry.selectable !== true || !['safe', 'review'].includes(entry.risk)) {
      throw new Error(`產品更新入口選取了不可套用的變更：${id}`);
    }
  }
  return [...handoff.selectedEntryIds];
}

async function revalidateInput({ inputPath, beforeCatalog, version, explicitClears, expectedHash, temporaryDirectory }) {
  const baselinePath = path.join(temporaryDirectory, 'baseline.json');
  const revalidatedPath = path.join(temporaryDirectory, 'revalidated-product-catalog.json');
  fs.writeFileSync(baselinePath, `${JSON.stringify(beforeCatalog, null, 2)}\n`);
  const { catalog } = compileProductCatalogWorkbook({
    inputPath,
    outputPath:revalidatedPath,
    basePath:baselinePath,
    version,
    explicitClears,
  });
  if (await publicCatalogSha256(catalog) !== expectedHash) {
    throw new Error('原始 Excel 重新驗證的結果不一致，未套用任何變更');
  }
}

async function main() {
  const args = parseOptions(process.argv.slice(2));
  if (!args.input) throw new Error('Required option: --input <raw-product-workbook.xlsx>');
  if (args.verify && !args.apply) throw new Error('--verify requires --apply');
  if (args.apply && !args['reviewed-plan']) throw new Error('--apply requires --reviewed-plan <reviewed-plan.json>');
  if (args.apply && !args.verify) throw new Error('--apply requires --verify');
  const inputPath = path.resolve(args.input);
  if (!fs.existsSync(inputPath)) throw new Error(`Input workbook not found: ${inputPath}`);
  const fbaRepo = path.resolve(args['fba-repo'] || path.join(supplyRepo, '..', 'FBA'));
  assertRepo(supplyRepo, 'jspusa-supply');
  assertRepo(fbaRepo, 'fba-workspace');

  const beforeCatalog = readJson(canonicalPath);
  const reviewedPlanInput = args.apply ? readJson(path.resolve(args['reviewed-plan'])) : null;
  const version = resolveCatalogReleaseVersion(beforeCatalog.catalogVersion, {
    requestedVersion:args.version,
    reviewedPlan:reviewedPlanInput,
  });
  const explicitClears = reviewedPlanInput ? explicitClearsFromReviewedPlan(reviewedPlanInput) : [];
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'product-catalog-release-'));
  try {
    const candidatePath = path.join(temporaryDirectory, 'product-catalog.json');
    const { catalog, importStats } = compileProductCatalogWorkbook({
      inputPath,
      outputPath:candidatePath,
      basePath:canonicalPath,
      version,
      explicitClears,
    });
    const generatedPlan = await createCatalogChangePlan(beforeCatalog, catalog, {
      sourceFile:path.basename(inputPath),
      conflicts:importStats?.sourceConflicts || [],
      duplicateConflicts:importStats?.duplicateConflicts || 0,
      rawSources:importStats?.sourceRecords || [],
    });
    writeJson(generatedPlan, args.report);
    process.stdout.write(renderCatalogChangePlan(generatedPlan));

    if (!args.apply) return;
    if (generatedPlan.blockers.length) {
      throw new Error(`Catalog release is blocked:\n- ${generatedPlan.blockers.join('\n- ')}`);
    }
    if (generatedPlan.stats.changedEntries === 0) throw new Error('No public product data changes; release was not applied');
    const reviewedPlan = reviewedPlanInput;
    await assertReviewedPlan(reviewedPlan, generatedPlan);
    if (args['selection-handoff'] && args.select.length) {
      throw new Error('--selection-handoff cannot be combined with --select');
    }
    const selectedEntryIds = args['selection-handoff']
      ? selectionsFromHandoff(readJson(path.resolve(args['selection-handoff'])), reviewedPlan)
      : [...new Set([
        ...reviewedPlan.entries.filter(entry => entry.selected).map(entry => entry.id),
        ...args.select,
      ])];
    const applied = await applyCatalogChangePlan(beforeCatalog, catalog, reviewedPlan, { selectedEntryIds });
    await revalidateInput({
      inputPath,
      beforeCatalog,
      version,
      explicitClears,
      expectedHash:generatedPlan.candidate.sha256,
      temporaryDirectory,
    });
    const previousAlignment = previousAlignmentRecord();
    if (previousAlignment) assertNextCatalogReleaseAllowed(previousAlignment);
    assertClean(supplyRepo);
    assertClean(fbaRepo);
    const recordPath = args.record
      ? path.resolve(args.record)
      : path.join(supplyRepo, 'catalog', 'change-records', `${applied.catalog.catalogVersion}.json`);
    const alignmentRecordPath = path.join(supplyRepo, 'catalog', 'alignment-records', `${applied.catalog.catalogVersion}.json`);
    const latestAlignmentRecordPath = path.join(supplyRepo, 'catalog', 'alignment-records', 'latest.json');
    const mutableFiles = [
      canonicalPath,
      supplySnapshotPath,
      path.join(fbaRepo, 'catalog', 'fba-product-catalog.snapshot.json'),
      path.join(fbaRepo, 'inbound-plan.html'),
      path.join(supplyRepo, 'catalog-alignment.json'),
      path.join(fbaRepo, 'catalog-alignment.json'),
      ...[
        'catalog-update-baseline.js',
        'catalog-update-change-plan.mjs',
        'catalog-update-overlay.mjs',
        'catalog-update-planner.mjs',
        'catalog-update-product-catalog.mjs',
        'catalog-update-release.mjs',
        'catalog-update-runtime-lock.json',
      ].flatMap(name => [path.join(supplyRepo, 'shared', name), path.join(fbaRepo, name)]),
      recordPath,
      alignmentRecordPath,
      latestAlignmentRecordPath,
    ];
    const rollback = captureFiles([...new Set(mutableFiles)]);
    try {
      fs.writeFileSync(canonicalPath, `${JSON.stringify(applied.catalog, null, 2)}\n`);
      writeCatalogUpdateRuntime({ catalogPath:canonicalPath, fbaRepo });
      writeSupplyProductData({ catalogPath:canonicalPath, outputPath:supplySnapshotPath });
      run(process.execPath, ['scripts/generate-product-catalog.mjs', '--source', canonicalPath], fbaRepo);
      const alignment = writeCatalogAlignmentManifests({ catalogPath:canonicalPath, fbaRepo });
      verifyRelease({ fbaRepo });
      const alignmentRecord = recordLocalAlignmentEvidence(alignment.release);
      const record = await createCatalogChangeRecord(reviewedPlan, applied.catalog, applied.selectedEntryIds, {
        catalogAlignment:{
          state:alignmentRecord.state,
          expectedPublicContentHashes:alignmentRecord.expectedPublicContentHashes,
          evidenceStages:['local', 'repositoryCi', 'deployment', 'liveHash', 'liveBrowser'],
        },
      });
      writeJson(record, recordPath);
      writeJson(alignmentRecord, alignmentRecordPath);
      writeJson(alignmentRecord, latestAlignmentRecordPath);
    } catch (error) {
      restoreFiles(rollback);
      throw error;
    }
  } finally {
    fs.rmSync(temporaryDirectory, { recursive:true, force:true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
