import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const playwrightConfig = fs.readFileSync(
  path.join(repoRoot, 'tests', 'browser', 'playwright.config.mjs'),
  'utf8',
);

test('verify gates the exact built artifact with deterministic Chromium acceptance tests', () => {
  assert.equal(packageJson.devDependencies['@playwright/test'], '1.62.1');
  assert.equal(packageJson.scripts['test:browser'], 'playwright test --config tests/browser/playwright.config.mjs');
  assert.equal(packageJson.scripts['verify:live:browser'], 'node scripts/verify-live-browser.mjs');
  assert.equal(
    packageJson.scripts.verify,
    'npm test && npm run build && npm run verify:dist && npm run test:browser',
  );
  assert.match(playwrightConfig, /workers:1/);
  assert.match(playwrightConfig, /retries:0/);
  assert.match(playwrightConfig, /browserName:'chromium'/);
  assert.match(playwrightConfig, /command:'node scripts\/serve-dist\.mjs'/);
  assert.match(playwrightConfig, /timeout:10_000/);
});
