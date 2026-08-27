import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '..');
const buildScript = path.join(repoRoot, 'scripts', 'build-site.mjs');
const verifyScript = path.join(repoRoot, 'scripts', 'verify-dist.mjs');

function listFiles(root, relative = '') {
  const directory = path.join(root, relative);
  return fs.readdirSync(directory, { withFileTypes: true })
    .flatMap(entry => {
      const entryRelative = path.join(relative, entry.name);
      return entry.isDirectory() ? listFiles(root, entryRelative) : [entryRelative];
    })
    .map(file => file.split(path.sep).join('/'))
    .sort();
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function runNode(script, args) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

function updateManifestHash(dist, relativePath) {
  const manifestPath = path.join(dist, 'release.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.files[relativePath] = sha256(path.join(dist, relativePath));
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

test('site build emits the exact deterministic deployment artifact', t => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'supply-site-build-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const firstDist = path.join(tempRoot, 'first');
  const secondDist = path.join(tempRoot, 'second');

  const first = runNode(buildScript, ['--out', firstDist, '--revision', 'test-revision']);
  assert.equal(first.status, 0, first.stderr || first.stdout);
  const second = runNode(buildScript, ['--out', secondDist, '--revision', 'test-revision']);
  assert.equal(second.status, 0, second.stderr || second.stdout);

  const expectedFiles = [
    '.nojekyll',
    'Boss/index.html',
    'index.html',
    'product-data.js',
    'release.json',
    'shared/legacy-planning-adapter.js',
    'shared/order-draft-quantity.js',
    'shared/planning-velocity-history.js',
    'shared/planning-velocity.js',
    'shared/supply-planner.js',
  ];
  assert.deepEqual(listFiles(firstDist), expectedFiles);
  assert.deepEqual(listFiles(secondDist), expectedFiles);

  const manifest = JSON.parse(fs.readFileSync(path.join(firstDist, 'release.json'), 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.revision, 'test-revision');
  assert.deepEqual(Object.keys(manifest.files).sort(), [
    'Boss/index.html',
    'index.html',
    'product-data.js',
    'shared/legacy-planning-adapter.js',
    'shared/order-draft-quantity.js',
    'shared/planning-velocity-history.js',
    'shared/planning-velocity.js',
    'shared/supply-planner.js',
  ]);
  for (const relativePath of Object.keys(manifest.files)) {
    assert.match(manifest.files[relativePath], /^[a-f0-9]{64}$/);
    assert.equal(manifest.files[relativePath], sha256(path.join(firstDist, relativePath)));
  }

  for (const relativePath of expectedFiles) {
    assert.deepEqual(
      fs.readFileSync(path.join(secondDist, relativePath)),
      fs.readFileSync(path.join(firstDist, relativePath)),
      `${relativePath} should be reproducible`,
    );
  }
});

test('artifact verifier accepts a complete unmodified site build', t => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'supply-site-verify-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const dist = path.join(tempRoot, 'dist');
  const build = runNode(buildScript, ['--out', dist, '--revision', 'verified-revision']);
  assert.equal(build.status, 0, build.stderr || build.stdout);

  const verified = runNode(verifyScript, ['--dir', dist, '--revision', 'verified-revision']);
  assert.equal(verified.status, 0, verified.stderr || verified.stdout);
  assert.match(verified.stdout, /Verified 8 hashed site files for verified-revision/);
});

test('artifact verifier rejects repository-only or unexpected files', t => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'supply-site-unexpected-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const dist = path.join(tempRoot, 'dist');
  const build = runNode(buildScript, ['--out', dist, '--revision', 'test-revision']);
  assert.equal(build.status, 0, build.stderr || build.stdout);
  fs.mkdirSync(path.join(dist, 'tests'));
  fs.writeFileSync(path.join(dist, 'tests', 'private-fixture.txt'), 'must not deploy');

  const verified = runNode(verifyScript, ['--dir', dist, '--revision', 'test-revision']);
  assert.notEqual(verified.status, 0);
  assert.match(verified.stderr, /Unexpected deploy file: tests\/private-fixture\.txt/);
});

test('artifact verifier requires the Pages deployment marker to stay empty', t => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'supply-site-marker-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const dist = path.join(tempRoot, 'dist');
  const build = runNode(buildScript, ['--out', dist, '--revision', 'test-revision']);
  assert.equal(build.status, 0, build.stderr || build.stdout);
  fs.writeFileSync(path.join(dist, '.nojekyll'), 'unexpected content');

  const verified = runNode(verifyScript, ['--dir', dist, '--revision', 'test-revision']);
  assert.notEqual(verified.status, 0);
  assert.match(verified.stderr, /Pages deployment marker must be empty/);
});

test('artifact verifier rejects a missing local runtime reference', t => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'supply-site-reference-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const dist = path.join(tempRoot, 'dist');
  const build = runNode(buildScript, ['--out', dist, '--revision', 'test-revision']);
  assert.equal(build.status, 0, build.stderr || build.stdout);

  const indexPath = path.join(dist, 'index.html');
  fs.appendFileSync(indexPath, '\n<script src="./missing-runtime.js"></script>\n');
  const manifestPath = path.join(dist, 'release.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.files['index.html'] = sha256(indexPath);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const verified = runNode(verifyScript, ['--dir', dist, '--revision', 'test-revision']);
  assert.notEqual(verified.status, 0);
  assert.match(verified.stderr, /Missing local reference in index\.html: missing-runtime\.js/);
});

test('artifact verifier checks srcset, CSS URLs, and JavaScript imports', t => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'supply-site-reference-kinds-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const cases = [
    { file: 'index.html', content: '\n<img srcset="./missing-srcset.png 1x">\n', missing: 'missing-srcset.png' },
    { file: 'index.html', content: '\n<style>.probe{background:url("./missing-style.png")}</style>\n', missing: 'missing-style.png' },
    { file: 'product-data.js', content: '\nimport "./missing-module.js";\n', missing: 'missing-module.js' },
  ];

  for (const [index, fixture] of cases.entries()) {
    const dist = path.join(tempRoot, `dist-${index}`);
    const build = runNode(buildScript, ['--out', dist, '--revision', 'test-revision']);
    assert.equal(build.status, 0, build.stderr || build.stdout);
    fs.appendFileSync(path.join(dist, fixture.file), fixture.content);
    updateManifestHash(dist, fixture.file);

    const verified = runNode(verifyScript, ['--dir', dist, '--revision', 'test-revision']);
    assert.notEqual(verified.status, 0, `${fixture.missing} should be rejected`);
    assert.match(verified.stderr, new RegExp(`Missing local reference in .*: ${fixture.missing.replace('.', '\\.')}`));
  }
});

test('artifact verifier requires every runtime file to be covered by the manifest', t => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'supply-site-manifest-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const dist = path.join(tempRoot, 'dist');
  const build = runNode(buildScript, ['--out', dist, '--revision', 'test-revision']);
  assert.equal(build.status, 0, build.stderr || build.stdout);

  const manifestPath = path.join(dist, 'release.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  delete manifest.files['product-data.js'];
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const verified = runNode(verifyScript, ['--dir', dist, '--revision', 'test-revision']);
  assert.notEqual(verified.status, 0);
  assert.match(verified.stderr, /Release manifest files must exactly match the runtime allowlist/);
});

test('artifact verifier requires an exact release manifest schema', t => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'supply-site-manifest-schema-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const dist = path.join(tempRoot, 'dist');
  const build = runNode(buildScript, ['--out', dist, '--revision', 'test-revision']);
  assert.equal(build.status, 0, build.stderr || build.stdout);

  const manifestPath = path.join(dist, 'release.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.privateUserInput = 'must not be accepted';
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const verified = runNode(verifyScript, ['--dir', dist, '--revision', 'test-revision']);
  assert.notEqual(verified.status, 0);
  assert.match(verified.stderr, /Release manifest keys must exactly match the schema/);
});

test('artifact verifier credential-scans release metadata', t => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'supply-site-manifest-secret-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const dist = path.join(tempRoot, 'dist');
  const build = runNode(buildScript, ['--out', dist, '--revision', 'test-revision']);
  assert.equal(build.status, 0, build.stderr || build.stdout);

  const manifestPath = path.join(dist, 'release.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.revision = '-----BEGIN PRIVATE KEY-----';
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const verified = runNode(verifyScript, ['--dir', dist]);
  assert.notEqual(verified.status, 0);
  assert.match(verified.stderr, /Potential credential material in release\.json: private key/);
});

test('artifact verifier rejects symlinks even when the allowed filename and hash match', t => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'supply-site-symlink-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const dist = path.join(tempRoot, 'dist');
  const build = runNode(buildScript, ['--out', dist, '--revision', 'test-revision']);
  assert.equal(build.status, 0, build.stderr || build.stdout);

  const productDataPath = path.join(dist, 'product-data.js');
  fs.rmSync(productDataPath);
  fs.symlinkSync(path.join(repoRoot, 'product-data.js'), productDataPath);

  const verified = runNode(verifyScript, ['--dir', dist, '--revision', 'test-revision']);
  assert.notEqual(verified.status, 0);
  assert.match(verified.stderr, /Symlink is not allowed: product-data\.js/);
});

test('artifact verifier rejects high-confidence credential material', t => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'supply-site-secret-'));
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  const dist = path.join(tempRoot, 'dist');
  const build = runNode(buildScript, ['--out', dist, '--revision', 'test-revision']);
  assert.equal(build.status, 0, build.stderr || build.stdout);

  const productDataPath = path.join(dist, 'product-data.js');
  fs.appendFileSync(productDataPath, '\n/* -----BEGIN PRIVATE KEY----- */\n');
  const manifestPath = path.join(dist, 'release.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.files['product-data.js'] = sha256(productDataPath);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const verified = runNode(verifyScript, ['--dir', dist, '--revision', 'test-revision']);
  assert.notEqual(verified.status, 0);
  assert.match(verified.stderr, /Potential credential material in product-data\.js: private key/);
});
