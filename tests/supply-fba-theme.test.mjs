import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '..');
const theme = fs.readFileSync(path.join(repoRoot, 'shared', 'supply-fba-theme.css'), 'utf8');
const publicHtml = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');
const bossHtml = fs.readFileSync(path.join(repoRoot, 'Boss', 'index.html'), 'utf8');

test('public and Boss consume the same Supply composition after the generated FBA projection', () => {
  assert.match(publicHtml, /fba-visual-system\.css">[\s\S]*?<link rel="stylesheet" href="\.\/shared\/supply-fba-theme\.css">/);
  assert.match(bossHtml, /fba-visual-system\.css">[\s\S]*?<link rel="stylesheet" href="\.\.\/shared\/supply-fba-theme\.css">/);
  assert.equal((publicHtml.match(/supply-fba-theme\.css/g) || []).length, 1);
  assert.equal((bossHtml.match(/supply-fba-theme\.css/g) || []).length, 1);
});

test('theme replaces the legacy hero and gives every workspace the FBA white-card system', () => {
  assert.match(theme, /\.fba-visual-system \.appHero\{[^}]*background:var\(--workspace-surface\);[^}]*box-shadow:var\(--supply-card-shadow\)/s);
  assert.match(theme, /\.fba-visual-system \.appHero::before,[\s\S]*?display:none/);
  assert.match(theme, /\.fba-visual-system \.card,[\s\S]*?background:var\(--workspace-surface\)/);
  assert.match(theme, /\.fba-visual-system \.uploadPrimaryPanel/);
  assert.match(theme, /\.fba-visual-system \.decisionKpi/);
  assert.match(theme, /\.fba-visual-system \.treeBox/);
  assert.match(theme, /\.fba-visual-system \.salesChartCard/);
  for (const id of ['uploadCard', 'decisionDashboard', 'generatorCard', 'skuDecisionTreeCard', 'mainCard']) {
    assert.match(publicHtml, new RegExp(`id="${id}"[^>]*data-workspace-panel=`));
    assert.match(bossHtml, new RegExp(`id="${id}"[^>]*data-workspace-panel=`));
  }
});

test('Dense Workflow Variant preserves horizontal tables and compact actions', () => {
  assert.match(theme, /Dense Workflow Variant/);
  assert.match(theme, /\.fba-visual-system th,[\s\S]*?padding:8px 9px/);
  assert.match(theme, /\.fba-visual-system \.order-generator table\{[^}]*min-width:1120px/s);
  assert.match(theme, /\.fba-visual-system \.tableWrap,[\s\S]*?overflow:auto/);
  assert.match(theme, /\.fba-visual-system \.order-generator \.drag-handle,[\s\S]*?inline-size:27px/);
  assert.doesNotMatch(theme, /display:none[^}]*data-generator-col|data-generator-col[^}]*display:none/);
});

test('rendered pallet fields become native half-pallet steppers', () => {
  for (const html of [publicHtml, bossHtml]) {
    assert.match(html, /function useNativePalletStepper\(row\)/);
    assert.match(html, /input\.step = '0\.5'/);
    assert.match(html, /input\.removeAttribute\('onkeydown'\)/);
    assert.match(html, /row\.querySelector\('\.palletStepButtons'\)\?\.remove\(\)/);
  }
  assert.match(theme, /\.fba-visual-system \.edit-pallets-input\{[^}]*appearance:auto;[^}]*-moz-appearance:auto/s);
  assert.match(theme, /\.fba-visual-system \.palletStepButtons\{display:none\}/);
});

test('Supply composition stays normal-light, responsive, and reduced-motion safe', () => {
  assert.match(theme, /@media\(max-width:760px\)/);
  assert.match(theme, /@media\(pointer:coarse\)/);
  assert.match(theme, /@media\(prefers-reduced-motion:reduce\)/);
  assert.doesNotMatch(theme, /fba-night|fba-door-transition|芝麻開門|芝麻關門/);
});
