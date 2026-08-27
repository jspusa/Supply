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
  assert.match(verifyJob, /uses: actions\/setup-node@v4/);
  assert.match(verifyJob, /node-version-file: \.node-version/);
  assert.match(verifyJob, /cache: npm/);
  assert.match(verifyJob, /run: npm run check/);
  assert.match(verifyJob, /uses: actions\/upload-pages-artifact@v3/);
  assert.match(verifyJob, /if: github\.ref == 'refs\/heads\/main'/);
  assert.match(verifyJob, /path: dist/);

  const deployJob = workflow.match(/\n  deploy:\n(?<body>[\s\S]+)$/)?.groups.body;
  assert.ok(deployJob, 'deploy job must exist');
  assert.match(deployJob, /needs: verify/);
  assert.match(deployJob, /if: github\.ref == 'refs\/heads\/main' && needs\.verify\.result == 'success'/);
  assert.match(deployJob, /permissions:\n\s+pages: write\n\s+id-token: write/);
  assert.match(deployJob, /uses: actions\/deploy-pages@v4/);

  assert.doesNotMatch(workflow, /path: \.\s*$/m);
});
