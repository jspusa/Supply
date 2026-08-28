import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import {
  countFirstParentUpdates,
  formatAppVersion,
  replaceAppVersionToken,
} from './release-version.mjs';
import { compileSupplyProductData } from './compile-product-catalog.mjs';
import { verifyLocalVisualSystem } from './fba-visual-system-contract.mjs';
import { runtimeFiles, sha256File } from './site-contract.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultOutput = path.join(repoRoot, 'dist');

function readOption(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function isInside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function assertSafeOutput(output) {
  const resolved = path.resolve(output);
  const safeTemporaryOutput = isInside(path.resolve(os.tmpdir()), resolved);
  if (resolved !== defaultOutput && !safeTemporaryOutput) {
    throw new Error(`Refusing to replace unsafe output directory: ${resolved}`);
  }
}

function currentRevision() {
  const explicit = readOption('--revision') || process.env.GITHUB_SHA;
  if (explicit) return explicit;
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
}

function currentUpdateCount(revision) {
  const explicit = readOption('--update-count') || process.env.SUPPLY_UPDATE_COUNT;
  return explicit ? Number(explicit) : countFirstParentUpdates({ repoRoot, revision });
}

const output = path.resolve(readOption('--out') || defaultOutput);
const revision = currentRevision();
const updateCount = currentUpdateCount(revision);
const appVersion = formatAppVersion(updateCount);
verifyLocalVisualSystem();
assertSafeOutput(output);
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });

for (const relativePath of runtimeFiles) {
  const destination = path.join(output, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (relativePath === 'product-data.js') {
    fs.writeFileSync(destination, compileSupplyProductData());
    continue;
  }
  const source = path.join(repoRoot, relativePath);
  if (!fs.statSync(source).isFile()) throw new Error(`Missing deploy source: ${relativePath}`);
  fs.copyFileSync(source, destination);
}

for (const relativePath of ['index.html', 'Boss/index.html']) {
  const destination = path.join(output, relativePath);
  const source = fs.readFileSync(destination, 'utf8');
  fs.writeFileSync(destination, replaceAppVersionToken(source, appVersion, relativePath));
}

fs.writeFileSync(path.join(output, '.nojekyll'), '');
const manifest = {
  schemaVersion: 1,
  revision,
  files: Object.fromEntries(runtimeFiles.map(relativePath => [
    relativePath,
    sha256File(path.join(output, relativePath)),
  ])),
};
fs.writeFileSync(path.join(output, 'release.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Built ${runtimeFiles.length} site files for ${manifest.revision} as ${appVersion} (${updateCount} first-parent updates) in ${output}`);
