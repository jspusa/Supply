import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const projectionPath = path.join(repoRoot, 'shared', 'fba-visual-system.css');
export const lockPath = path.join(repoRoot, 'shared', 'fba-visual-system.lock.json');
const DEFAULT_FBA_REPO = path.resolve(repoRoot, '..', 'FBA');
const HEADER = /^\/\*!\n \* FBA Visual System\n \* version: (?<version>\d+\.\d+\.\d+)\n \* mode: (?<mode>[a-z-]+)\n \* content-sha256: (?<hash>[a-f0-9]{64})\n \* source: jspusa\/FBA workspace-shell\.css\n \*\/\n/;

function inspectArtifact(source) {
  const match = source.match(HEADER);
  if (!match?.groups) throw new Error('Projected FBA Visual System metadata header is missing or invalid');
  if (match.groups.mode !== 'normal-light') throw new Error(`Unsupported FBA Visual System mode: ${match.groups.mode}`);
  const body = source.slice(match[0].length);
  const contentHash = createHash('sha256').update(body).digest('hex');
  if (match.groups.hash !== contentHash) {
    throw new Error(`FBA Visual System content hash drift: declared ${match.groups.hash}, actual ${contentHash}`);
  }
  return Object.freeze({ version:match.groups.version, mode:match.groups.mode, contentHash });
}

function readLock(file = lockPath) {
  let lock;
  try { lock = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (error) { throw new Error(`Unable to read FBA Visual System lock: ${error.message}`); }
  const expectedKeys = ['contentHash', 'mode', 'schemaVersion', 'source', 'version'];
  if (JSON.stringify(Object.keys(lock).sort()) !== JSON.stringify(expectedKeys)) {
    throw new Error('FBA Visual System lock keys do not match schema');
  }
  if (lock.schemaVersion !== 1) throw new Error(`Unsupported FBA Visual System lock schema: ${lock.schemaVersion}`);
  if (lock.source?.repository !== 'jspusa/FBA' || lock.source?.path !== 'workspace-shell.css') {
    throw new Error('FBA Visual System lock source must be jspusa/FBA workspace-shell.css');
  }
  return lock;
}

export function verifyLocalVisualSystem({ root = repoRoot } = {}) {
  const cssPath = path.join(root, 'shared', 'fba-visual-system.css');
  const localLockPath = path.join(root, 'shared', 'fba-visual-system.lock.json');
  const source = fs.readFileSync(cssPath, 'utf8');
  const contract = inspectArtifact(source);
  const lock = readLock(localLockPath);
  if (lock.version !== contract.version || lock.mode !== contract.mode || lock.contentHash !== contract.contentHash) {
    throw new Error(`Supply FBA Visual System lock drift: lock v${lock.version}/${lock.contentHash}, projection v${contract.version}/${contract.contentHash}`);
  }
  return Object.freeze({ ...contract, source, lock });
}

export function verifySourceAlignment({ fbaRepo = DEFAULT_FBA_REPO } = {}) {
  const local = verifyLocalVisualSystem();
  const sourcePath = path.join(path.resolve(fbaRepo), 'workspace-shell.css');
  if (!fs.existsSync(sourcePath)) throw new Error(`FBA Visual System source is missing: ${sourcePath}`);
  const source = fs.readFileSync(sourcePath, 'utf8');
  const contract = inspectArtifact(source);
  if (source !== local.source) {
    throw new Error(`FBA Visual System source drift: FBA v${contract.version}/${contract.contentHash}, Supply v${local.version}/${local.contentHash}`);
  }
  return contract;
}

export function projectFromFba({ fbaRepo = DEFAULT_FBA_REPO } = {}) {
  const sourcePath = path.join(path.resolve(fbaRepo), 'workspace-shell.css');
  if (!fs.existsSync(sourcePath)) throw new Error(`FBA Visual System source is missing: ${sourcePath}`);
  const source = fs.readFileSync(sourcePath, 'utf8');
  const contract = inspectArtifact(source);
  const lock = {
    schemaVersion:1,
    source:{ repository:'jspusa/FBA', path:'workspace-shell.css' },
    version:contract.version,
    mode:contract.mode,
    contentHash:contract.contentHash,
  };
  fs.writeFileSync(projectionPath, source);
  fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  verifyLocalVisualSystem();
  return contract;
}

function readOption(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? null : process.argv[index + 1];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const fbaRepo = readOption('--fba-repo') || DEFAULT_FBA_REPO;
  const contract = process.argv.includes('--apply')
    ? projectFromFba({ fbaRepo })
    : process.argv.includes('--check-source')
      ? verifySourceAlignment({ fbaRepo })
      : verifyLocalVisualSystem();
  console.log(`Verified Supply projection of FBA Visual System v${contract.version} (${contract.contentHash})`);
}
