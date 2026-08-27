import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { allowedArtifactFiles, runtimeFiles, sha256File } from './site-contract.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseManifestKeys = ['files', 'revision', 'schemaVersion'];
const credentialPatterns = [
  ['private key', /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/],
  ['AWS access key', /(?:^|[^A-Z0-9])(?:AKIA|ASIA)[A-Z0-9]{16}(?![A-Z0-9])/],
  ['GitHub token', /(?:gh[opusr]_[A-Za-z0-9]{36,255}|github_pat_[A-Za-z0-9_]{40,255})/],
  ['Slack token', /xox(?:a|b|p|r|s)-[A-Za-z0-9-]{10,}/],
  ['basic-auth URL', /https?:\/\/[^\s/:@]+:[^\s/@]+@/i]
];

function readOption(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function listFiles(root, relative = '') {
  const current = path.join(root, relative);
  return fs.readdirSync(current, { withFileTypes: true })
    .flatMap(entry => {
      const entryRelative = path.join(relative, entry.name);
      return entry.isDirectory() ? listFiles(root, entryRelative) : [entryRelative];
    })
    .map(file => file.split(path.sep).join('/'))
    .sort();
}

function isExternalReference(reference) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(reference);
}

function getRuntimeReferences(relativePath) {
  const source = fs.readFileSync(path.join(directory, relativePath), 'utf8');
  const references = [];
  if (relativePath.endsWith('.html')) {
    references.push(...Array.from(source.matchAll(/(?:src|poster)\s*=\s*["']([^"']+)["']/gi), match => match[1]));
    for (const linkTag of source.matchAll(/<link\b[^>]*>/gi)) {
      const href = linkTag[0].match(/href\s*=\s*["']([^"']+)["']/i)?.[1];
      if (href) references.push(href);
    }
    for (const match of source.matchAll(/srcset\s*=\s*["']([^"']+)["']/gi)) {
      references.push(...match[1].split(',').map(candidate => candidate.trim().split(/\s+/)[0]).filter(Boolean));
    }
  }
  if (relativePath.endsWith('.html') || relativePath.endsWith('.css')) {
    references.push(...Array.from(source.matchAll(/url\(\s*["']?([^"')\s]+)["']?\s*\)/gi), match => match[1]));
    references.push(...Array.from(source.matchAll(/@import\s+["']([^"']+)["']/gi), match => match[1]));
  }
  if (relativePath.endsWith('.js') || relativePath.endsWith('.mjs')) {
    references.push(...Array.from(source.matchAll(/\b(?:import|export)\s+(?:[^"']*?\sfrom\s*)?["']([^"']+)["']/g), match => match[1]));
    references.push(...Array.from(source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g), match => match[1]));
  }
  return references;
}

function verifyLocalReferences(relativePath) {
  const references = getRuntimeReferences(relativePath);
  for (const rawReference of references) {
    if (!rawReference || isExternalReference(rawReference) || rawReference.includes('${')) continue;
    let cleanReference = rawReference.split('#')[0].split('?')[0].replace(/\\/g, '/');
    if (!cleanReference) continue;
    try {
      cleanReference = decodeURIComponent(cleanReference);
    } catch {
      throw new Error(`Invalid encoded local reference in ${relativePath}: ${cleanReference}`);
    }
    const displayReference = cleanReference.replace(/^\.\//, '');
    const target = cleanReference.startsWith('/')
      ? path.resolve(directory, `.${cleanReference}`)
      : path.resolve(directory, path.dirname(relativePath), cleanReference);
    const relativeTarget = path.relative(directory, target);
    if (relativeTarget.startsWith(`..${path.sep}`) || relativeTarget === '..' || path.isAbsolute(relativeTarget)) {
      throw new Error(`Local reference escapes artifact in ${relativePath}: ${displayReference}`);
    }
    const exists = fs.existsSync(target) || fs.existsSync(path.join(target, 'index.html'));
    if (!exists) throw new Error(`Missing local reference in ${relativePath}: ${displayReference}`);
  }
}

function verifyNoCredentialMaterial(relativePath) {
  const source = fs.readFileSync(path.join(directory, relativePath), 'utf8');
  for (const [label, pattern] of credentialPatterns) {
    if (pattern.test(source)) throw new Error(`Potential credential material in ${relativePath}: ${label}`);
  }
}

const directory = path.resolve(readOption('--dir') || path.join(repoRoot, 'dist'));
const expectedRevision = readOption('--revision') || process.env.GITHUB_SHA || null;
const manifestPath = path.join(directory, 'release.json');
const actualFiles = listFiles(directory);
for (const relativePath of actualFiles) {
  const fileType = fs.lstatSync(path.join(directory, relativePath));
  if (fileType.isSymbolicLink()) throw new Error(`Symlink is not allowed: ${relativePath}`);
  if (!fileType.isFile()) throw new Error(`Non-file deploy entry is not allowed: ${relativePath}`);
  if (!allowedArtifactFiles.includes(relativePath)) throw new Error(`Unexpected deploy file: ${relativePath}`);
}
for (const relativePath of allowedArtifactFiles) {
  if (!actualFiles.includes(relativePath)) throw new Error(`Missing deploy file: ${relativePath}`);
}
if (fs.statSync(path.join(directory, '.nojekyll')).size !== 0) {
  throw new Error('Pages deployment marker must be empty');
}

verifyNoCredentialMaterial('release.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(releaseManifestKeys)) {
  throw new Error('Release manifest keys must exactly match the schema');
}
if (manifest.schemaVersion !== 1) throw new Error(`Unsupported release schema: ${manifest.schemaVersion}`);
if (typeof manifest.revision !== 'string' || !manifest.revision.trim()) throw new Error('Release revision must be a non-empty string');
if (expectedRevision && manifest.revision !== expectedRevision) {
  throw new Error(`Release revision mismatch: expected ${expectedRevision}, received ${manifest.revision}`);
}
if (!manifest.files || Array.isArray(manifest.files) || typeof manifest.files !== 'object') {
  throw new Error('Release manifest files must be an object');
}
if (JSON.stringify(Object.keys(manifest.files).sort()) !== JSON.stringify(runtimeFiles)) {
  throw new Error('Release manifest files must exactly match the runtime allowlist');
}

for (const [relativePath, expectedHash] of Object.entries(manifest.files)) {
  const file = path.join(directory, relativePath);
  if (!fs.statSync(file).isFile()) throw new Error(`Missing release file: ${relativePath}`);
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error(`Invalid release hash: ${relativePath}`);
  const actualHash = sha256File(file);
  if (actualHash !== expectedHash) throw new Error(`Release hash mismatch: ${relativePath}`);
  verifyNoCredentialMaterial(relativePath);
  verifyLocalReferences(relativePath);
}

console.log(`Verified ${Object.keys(manifest.files).length} hashed site files for ${manifest.revision}`);
