import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '..');
const workflow = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'deploy-pages.yml'), 'utf8');

test('Pages workflow verifies pull requests and gates deployment to verified main revisions', () => {
  assert.match(workflow, /pull_request:\n\s+branches:\n\s+- main/);

  const globalPermissions = workflow.match(/permissions:\n(?<body>(?: {2}[^\n]+\n)+)\nconcurrency:/)?.groups.body;
  assert.equal(globalPermissions, '  contents: read\n');

  const verifyJob = workflow.match(/jobs:\n  verify:\n(?<body>[\s\S]+?)\n  deploy:/)?.groups.body;
  assert.ok(verifyJob, 'verify job must run before deploy');
  assert.match(verifyJob, /uses: actions\/checkout@v4\n\s+with:\n\s+fetch-depth: 0/);
  assert.match(verifyJob, /uses: actions\/setup-node@v4/);
  assert.match(verifyJob, /node-version-file: \.node-version/);
  assert.match(verifyJob, /cache: npm/);
  assert.match(verifyJob, /run: npm ci --ignore-scripts --no-audit --no-fund/);
  assert.match(verifyJob, /run: npx playwright install --with-deps chromium/);
  assert.equal((verifyJob.match(/run: npm ci --ignore-scripts --no-audit --no-fund/g) || []).length, 1);
  assert.equal((verifyJob.match(/run: npx playwright install --with-deps chromium/g) || []).length, 1);
  assert.match(verifyJob, /run: npm run verify/);
  assert.match(verifyJob, /run: node scripts\/verify-catalog-seams\.mjs --fba-repo \.catalog-peer\/FBA --require-pinned-peer --reuse-verified-dist/);
  assert.ok(verifyJob.indexOf('run: npm ci --ignore-scripts --no-audit --no-fund')
    < verifyJob.indexOf('run: npx playwright install --with-deps chromium'));
  assert.ok(verifyJob.indexOf('run: npx playwright install --with-deps chromium')
    < verifyJob.indexOf('run: npm run verify'));
  assert.ok(verifyJob.indexOf('run: npm run verify')
    < verifyJob.indexOf('run: node scripts/verify-catalog-seams.mjs'));
  assert.ok(verifyJob.indexOf('run: node scripts/verify-catalog-seams.mjs')
    < verifyJob.indexOf('uses: actions/upload-pages-artifact@v3'));
  assert.match(verifyJob, /uses: actions\/upload-pages-artifact@v3/);
  assert.match(verifyJob, /if: github\.ref == 'refs\/heads\/main'/);
  assert.match(verifyJob, /path: dist/);
  assert.match(verifyJob, /uses: actions\/upload-artifact@v4/);
  assert.match(verifyJob, /name: supply-release-manifest-\$\{\{ github\.sha \}\}/);
  assert.match(verifyJob, /path: dist\/release\.json/);
  assert.match(verifyJob, /if-no-files-found: error/);

  const deployJob = workflow.match(/\n  deploy:\n(?<body>[\s\S]+)$/)?.groups.body;
  assert.ok(deployJob, 'deploy job must exist');
  assert.match(deployJob, /needs: verify/);
  assert.match(deployJob, /if: github\.ref == 'refs\/heads\/main' && needs\.verify\.result == 'success'/);
  assert.match(deployJob, /permissions:\n\s+pages: write\n\s+id-token: write/);
  assert.match(deployJob, /contents: read/);
  assert.match(deployJob, /uses: actions\/deploy-pages@v4/);
  assert.ok(deployJob.indexOf('uses: actions/deploy-pages@v4') < deployJob.indexOf('uses: actions/download-artifact@v4'));
  assert.match(deployJob, /name: supply-release-manifest-\$\{\{ github\.sha \}\}/);
  assert.match(deployJob, /SUPPLY_LIVE_BASE_URL: \$\{\{ steps\.deployment\.outputs\.page_url \}\}/);
  assert.match(deployJob, /SUPPLY_EXPECTED_REVISION: \$\{\{ github\.sha \}\}/);
  assert.match(deployJob, /SUPPLY_RELEASE_MANIFEST: \.release-evidence\/release\.json/);
  assert.match(deployJob, /SUPPLY_LIVE_ATTEMPTS: 18/);
  assert.match(deployJob, /SUPPLY_LIVE_RETRY_DELAY_MS: 5000/);
  assert.match(deployJob, /SUPPLY_LIVE_REQUEST_TIMEOUT_MS: 15000/);
  assert.match(deployJob, /run: npm run verify:live/);
  assert.match(deployJob, /run: npm ci --ignore-scripts --no-audit --no-fund/);
  assert.match(deployJob, /run: npx playwright install --with-deps chromium/);
  assert.match(deployJob, /SUPPLY_LIVE_BROWSER_ATTEMPTS: 6/);
  assert.match(deployJob, /SUPPLY_LIVE_BROWSER_RETRY_DELAY_MS: 5000/);
  assert.match(deployJob, /SUPPLY_LIVE_BROWSER_NAVIGATION_TIMEOUT_MS: 20000/);
  assert.match(deployJob, /SUPPLY_LIVE_BROWSER_ASSERTION_TIMEOUT_MS: 12000/);
  assert.match(deployJob, /run: npm run verify:live:browser/);
  assert.ok(deployJob.indexOf('uses: actions/deploy-pages@v4') < deployJob.indexOf('run: npm run verify:live:browser'));
  assert.ok(deployJob.indexOf('run: npm ci --ignore-scripts --no-audit --no-fund') < deployJob.indexOf('run: npx playwright install --with-deps chromium'));
  assert.ok(deployJob.indexOf('run: npx playwright install --with-deps chromium') < deployJob.indexOf('run: npm run verify:live:browser'));
  assert.ok(deployJob.indexOf('run: npm run verify:live') < deployJob.indexOf('run: npm run verify:live:browser'));

  assert.doesNotMatch(workflow, /path: \.\s*$/m);
  assert.doesNotMatch(workflow, /run: npx playwright install --with-deps chromium\n\s+cache:/);
});
