import { createHash } from 'node:crypto';
import fs from 'node:fs';

export const runtimeFiles = Object.freeze([
  'Boss/index.html',
  'index.html',
  'product-data.js',
  'shared/coverage-indicator.css',
  'shared/coverage-indicator.js',
  'shared/discontinuation-suggestions.js',
  'shared/legacy-planning-adapter.js',
  'shared/order-draft-quantity.js',
  'shared/order-draft-state.js',
  'shared/planning-velocity-history.js',
  'shared/planning-velocity.js',
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
