import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  projectionPath,
  verifyLocalVisualSystem,
  verifySourceAlignment,
} from '../scripts/fba-visual-system-contract.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const siblingFba = path.resolve(repoRoot, '..', 'FBA');
const fbaSourceRepo = path.resolve(process.env.FBA_REPO || siblingFba);

test('Supply projection is stamped, locked, normal-light, and locally served', () => {
  const contract = verifyLocalVisualSystem();
  assert.equal(contract.version, '1.0.0');
  assert.equal(contract.mode, 'normal-light');
  assert.match(contract.contentHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(contract.lock.source, { repository:'jspusa/FBA', path:'workspace-shell.css' });
  assert.match(contract.source, /--workspace-page:#f5f5f7/);
  assert.match(contract.source, /--workspace-font:-apple-system/);
  assert.match(contract.source, /backdrop-filter:saturate\(180%\) blur\(22px\)/);
  assert.doesNotMatch(contract.source, /fba-night|fba-door-transition|芝麻開門/);
});

test('local projection check rejects content and lock drift', t => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'supply-visual-contract-'));
  t.after(() => fs.rmSync(tempRoot, { recursive:true, force:true }));
  fs.mkdirSync(path.join(tempRoot, 'shared'));
  fs.copyFileSync(projectionPath, path.join(tempRoot, 'shared', 'fba-visual-system.css'));
  fs.copyFileSync(path.join(repoRoot, 'shared', 'fba-visual-system.lock.json'), path.join(tempRoot, 'shared', 'fba-visual-system.lock.json'));

  fs.appendFileSync(path.join(tempRoot, 'shared', 'fba-visual-system.css'), '\nbody{color:hotpink}\n');
  assert.throws(() => verifyLocalVisualSystem({ root:tempRoot }), /content hash drift/);

  fs.copyFileSync(projectionPath, path.join(tempRoot, 'shared', 'fba-visual-system.css'));
  const lockPath = path.join(tempRoot, 'shared', 'fba-visual-system.lock.json');
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  lock.version = '9.9.9';
  fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  assert.throws(() => verifyLocalVisualSystem({ root:tempRoot }), /lock drift/);
});

test('local release checkout rejects an FBA-to-Supply source mismatch', t => {
  if (!fs.existsSync(path.join(fbaSourceRepo, 'workspace-shell.css'))) {
    if (process.env.FBA_REPO) throw new Error(`Pinned FBA checkout is missing: ${fbaSourceRepo}`);
    t.skip('sibling FBA checkout is not present in this independent repository job');
    return;
  }
  const contract = verifySourceAlignment({ fbaRepo:fbaSourceRepo });
  assert.equal(contract.contentHash, verifyLocalVisualSystem().contentHash);
});

test('public and Boss load the generated local projection and shared Jasper shell', () => {
  const publicHtml = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');
  const bossHtml = fs.readFileSync(path.join(repoRoot, 'Boss', 'index.html'), 'utf8');
  const workspaceUi = fs.readFileSync(path.join(repoRoot, 'shared', 'workspace-ui.js'), 'utf8');
  assert.match(publicHtml, /<link rel="stylesheet" href="\.\/shared\/fba-visual-system\.css">/);
  assert.match(bossHtml, /<link rel="stylesheet" href="\.\.\/shared\/fba-visual-system\.css">/);
  assert.match(publicHtml, /<body class="fba-visual-system">/);
  assert.match(bossHtml, /<body class="fba-visual-system">/);
  assert.match(workspaceUi, /class="app-header supplyWorkspaceHeader"/);
  assert.match(workspaceUi, /class="brand-mark" aria-hidden="true">J<\/div>/);
  assert.match(workspaceUi, /Jasper Pet Care Products, Inc\./);
  assert.match(workspaceUi, /class="workspaceNavTab top-tab"/);
  assert.doesNotMatch(publicHtml, /https?:\/\/[^"']+fba-visual-system\.css/);
  assert.doesNotMatch(bossHtml, /https?:\/\/[^"']+fba-visual-system\.css/);
});
