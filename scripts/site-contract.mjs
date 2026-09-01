import { createHash } from 'node:crypto';
import fs from 'node:fs';

export const runtimeFiles = Object.freeze([
  'Boss/index.html',
  'catalog-alignment.json',
  'index.html',
  'product-data.js',
  'shared/catalog-affected-work.mjs',
  'shared/catalog-alignment-status.css',
  'shared/catalog-alignment-status.js',
  'shared/catalog-alignment-ui.js',
  'shared/catalog-update-baseline.js',
  'shared/catalog-update-change-plan.mjs',
  'shared/catalog-update-handoff.mjs',
  'shared/catalog-update-overlay.mjs',
  'shared/catalog-update-planner.mjs',
  'shared/catalog-update-product-catalog.mjs',
  'shared/catalog-update-release.mjs',
  'shared/catalog-update-runtime-lock.json',
  'shared/coverage-indicator.css',
  'shared/coverage-indicator.js',
  'shared/discontinuation-suggestions.js',
  'shared/fba-visual-system.css',
  'shared/legacy-planning-adapter.js',
  'shared/order-draft-quantity.js',
  'shared/order-draft-state.js',
  'shared/order-velocity-overrides.js',
  'shared/planning-velocity-history.js',
  'shared/planning-velocity.js',
  'shared/product-update-entry.css',
  'shared/product-update-entry.mjs',
  'shared/shared-product-catalog.js',
  'shared/supply-fba-theme.css',
  'shared/supply-planner.js',
  'shared/workspace-navigation.js',
  'shared/workspace-snapshot.js',
  'shared/workspace-ui.js',
  'vendor/LICENSE.sheetjs.txt',
  'vendor/xlsx.full.min.js',
]);

export const supportFiles = Object.freeze([
  '.nojekyll',
  'release.json',
]);

export const allowedArtifactFiles = Object.freeze([...runtimeFiles, ...supportFiles].sort());

export function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
