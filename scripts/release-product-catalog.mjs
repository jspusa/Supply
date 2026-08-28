import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import {
  assertNewCatalogVersion,
  catalogReleaseBlockers,
  createCatalogReleaseReport,
  nextCatalogVersion,
  renderCatalogReleaseReport,
} from '../catalog/product-catalog-release.js';
import { writeSupplyProductData } from './compile-product-catalog.mjs';
import { compileProductCatalogWorkbook } from './compile-product-master-workbook.mjs';

const supplyRepo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const canonicalPath = path.join(supplyRepo, 'catalog', 'product-catalog.json');
const supplySnapshotPath = path.join(supplyRepo, 'product-data.js');

function parseOptions(argv) {
  const options = { apply:false, verify:false };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--apply' || key === '--verify') {
      options[key.slice(2)] = true;
      continue;
    }
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value || value.startsWith('--')) throw new Error(`Invalid option near ${key || 'end of command'}`);
    options[key.slice(2)] = value;
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

function writeReport(report, reportPath) {
  if (!reportPath) return;
  const resolved = path.resolve(reportPath);
  fs.mkdirSync(path.dirname(resolved), { recursive:true });
  fs.writeFileSync(resolved, `${JSON.stringify(report, null, 2)}\n`);
}

function verifyRelease({ inputPath, version, fbaRepo }) {
  run(process.execPath, ['scripts/compile-product-master-workbook.mjs', '--check', '--input', inputPath, '--output', canonicalPath, '--version', version], supplyRepo);
  run('npm', ['test'], supplyRepo);
  run('npm', ['run', 'catalog:check'], supplyRepo);
  run('npm', ['run', 'build'], supplyRepo);
  run('npm', ['run', 'verify:dist'], supplyRepo);
  run('npm', ['test'], fbaRepo);
  const supplyShared = fs.readFileSync(path.join(supplyRepo, 'shared', 'shared-product-catalog.js'));
  const fbaShared = fs.readFileSync(path.join(fbaRepo, 'shared-product-catalog.js'));
  if (!supplyShared.equals(fbaShared)) throw new Error('Supply and FBA shared-product-catalog.js differ');
}

function main() {
  const args = parseOptions(process.argv.slice(2));
  if (!args.input) throw new Error('Required option: --input <raw-product-workbook.xlsx>');
  if (args.verify && !args.apply) throw new Error('--verify requires --apply');
  const inputPath = path.resolve(args.input);
  if (!fs.existsSync(inputPath)) throw new Error(`Input workbook not found: ${inputPath}`);
  const fbaRepo = path.resolve(args['fba-repo'] || path.join(supplyRepo, '..', 'FBA'));
  assertRepo(supplyRepo, 'jspusa-supply');
  assertRepo(fbaRepo, 'fba-workspace');

  const beforeCatalog = readJson(canonicalPath);
  const version = args.version
    ? assertNewCatalogVersion(beforeCatalog.catalogVersion, args.version)
    : nextCatalogVersion(beforeCatalog.catalogVersion, taipeiDay());
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'product-catalog-release-'));
  try {
    const candidatePath = path.join(temporaryDirectory, 'product-catalog.json');
    const { catalog, importStats } = compileProductCatalogWorkbook({
      inputPath,
      outputPath:candidatePath,
      basePath:canonicalPath,
      version,
    });
    const report = createCatalogReleaseReport(beforeCatalog, catalog, {
      sourceFile:path.basename(inputPath),
    });
    report.importStats = importStats;
    report.blockers = catalogReleaseBlockers(report);
    report.mode = args.apply ? 'applied' : 'plan';
    report.supplyRepo = supplyRepo;
    report.fbaRepo = fbaRepo;
    writeReport(report, args.report);
    process.stdout.write(renderCatalogReleaseReport(report));

    if (!args.apply) return;
    if (report.stats.changedEntries === 0) throw new Error('No public product data changes; release was not applied');
    if (report.blockers.length) throw new Error(`Catalog release is blocked:\n- ${report.blockers.join('\n- ')}`);
    assertClean(supplyRepo);
    assertClean(fbaRepo);
    fs.writeFileSync(canonicalPath, `${JSON.stringify(catalog, null, 2)}\n`);
    writeSupplyProductData({ catalogPath:canonicalPath, outputPath:supplySnapshotPath });
    run(process.execPath, ['scripts/generate-product-catalog.mjs', '--source', canonicalPath], fbaRepo);
    if (args.verify) verifyRelease({ inputPath, version, fbaRepo });
  } finally {
    fs.rmSync(temporaryDirectory, { recursive:true, force:true });
  }
}

main();
