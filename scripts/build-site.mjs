import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultOutput = path.join(repoRoot, 'dist');
const deployFiles = ['index.html', 'Boss/index.html', 'product-data.js'];

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

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function currentRevision() {
  const explicit = readOption('--revision') || process.env.GITHUB_SHA;
  if (explicit) return explicit;
  return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
}

const output = path.resolve(readOption('--out') || defaultOutput);
assertSafeOutput(output);
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });

for (const relativePath of deployFiles) {
  const source = path.join(repoRoot, relativePath);
  if (!fs.statSync(source).isFile()) throw new Error(`Missing deploy source: ${relativePath}`);
  const destination = path.join(output, relativePath);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(source, destination);
}

fs.writeFileSync(path.join(output, '.nojekyll'), '');
const manifest = {
  schemaVersion: 1,
  revision: currentRevision(),
  files: Object.fromEntries(deployFiles.map(relativePath => [
    relativePath,
    sha256(path.join(output, relativePath)),
  ])),
};
fs.writeFileSync(path.join(output, 'release.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Built ${deployFiles.length} site files for ${manifest.revision} in ${output}`);
