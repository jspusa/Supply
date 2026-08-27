import { createHash } from 'node:crypto';
import fs from 'node:fs';

export const runtimeFiles = Object.freeze([
  'Boss/index.html',
  'index.html',
  'product-data.js',
]);

export const supportFiles = Object.freeze([
  '.nojekyll',
  'release.json',
]);

export const allowedArtifactFiles = Object.freeze([...runtimeFiles, ...supportFiles].sort());

export function sha256File(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
