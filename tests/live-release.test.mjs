import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import { verifyLiveDeployment } from '../scripts/verify-live.mjs';

const REVISION = '0123456789abcdef0123456789abcdef01234567';
const NAVIGATION = `export const LEGACY_WORKSPACE_HASHES = { '#decisionDashboard':'recommendations' };`;
const WORKSPACE_UI = 'export const createWorkspaceUi = () => Object.freeze({});';
const XLSX_RUNTIME = '/*! SheetJS fixture */';
const PUBLIC = `<div id="workspaceNavMount"></div><div id="todayWorkspaceMount"></div><script src="./vendor/xlsx.full.min.js"></script><script type="module" src="./shared/workspace-navigation.js"></script><script type="module" src="./shared/workspace-ui.js"></script><main>Today</main>`;
const BOSS = `<div id="workspaceNavMount"></div><div id="todayWorkspaceMount"></div><script src="../vendor/xlsx.full.min.js"></script><script type="module" src="../shared/workspace-navigation.js"></script><script type="module" src="../shared/workspace-ui.js"></script><main>Boss Today</main>`;

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function releaseFixture(overrides = {}) {
  const content = new Map([
    ['index.html', PUBLIC],
    ['Boss/index.html', BOSS],
    ['shared/workspace-navigation.js', NAVIGATION],
    ['shared/workspace-ui.js', WORKSPACE_UI],
    ['shared/supply-planner.js', 'export const planner = true;'],
    ['vendor/xlsx.full.min.js', XLSX_RUNTIME],
  ]);
  for (const [file, value] of Object.entries(overrides.content || {})) content.set(file, value);
  const manifest = {
    schemaVersion:1,
    revision:overrides.revision || REVISION,
    files:Object.fromEntries(Array.from(content, ([file, value]) => [file, sha256(value)])),
  };
  return { content, manifest:{ ...manifest, ...(overrides.manifest || {}) } };
}

function fakeFetchSequence(sequence) {
  let manifestRequests = 0;
  let activeIndex = 0;
  const fetchImpl = async urlValue => {
    const url = new URL(urlValue);
    let relativePath = url.pathname.split('/Supply/')[1];
    if (relativePath === '') relativePath = 'index.html';
    if (relativePath === 'Boss/') relativePath = 'Boss/index.html';
    if (relativePath === 'release.json') {
      activeIndex = Math.min(manifestRequests, sequence.length - 1);
      const fixture = sequence[activeIndex];
      manifestRequests += 1;
      return new Response(JSON.stringify(fixture.liveManifest || fixture.manifest));
    }
    const fixture = sequence[activeIndex];
    const value = fixture.content.get(relativePath);
    return value === undefined ? new Response('missing', { status:404 }) : new Response(value);
  };
  return { fetchImpl, get manifestRequests() { return manifestRequests; } };
}

test('live verifier accepts only the exact verified manifest, runtime hashes, and three entrypoint contracts', async () => {
  const fixture = releaseFixture();
  const fake = fakeFetchSequence([fixture]);
  const result = await verifyLiveDeployment({
    baseUrl:'https://jspusa.github.io/Supply/',
    expectedManifest:fixture.manifest,
    expectedRevision:REVISION,
    fetchImpl:fake.fetchImpl,
    attempts:1,
    retryDelayMs:0,
  });
  assert.deepEqual(result, {
    ok:true,
    revision:REVISION,
    fileCount:6,
    attempts:1,
    publicUrl:'https://jspusa.github.io/Supply/',
    bossUrl:'https://jspusa.github.io/Supply/Boss/',
    legacyUrl:'https://jspusa.github.io/Supply/#decisionDashboard',
  });
});

test('live verification retries stale releases and succeeds within the explicit bound', async () => {
  const expected = releaseFixture();
  const stale = releaseFixture({ revision:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
  const waits = [];
  const fake = fakeFetchSequence([stale, stale, expected]);
  const result = await verifyLiveDeployment({
    baseUrl:'https://jspusa.github.io/Supply/',
    expectedManifest:expected.manifest,
    expectedRevision:REVISION,
    fetchImpl:fake.fetchImpl,
    attempts:3,
    retryDelayMs:25,
    wait:milliseconds => { waits.push(milliseconds); },
  });
  assert.equal(result.attempts, 3);
  assert.equal(fake.manifestRequests, 3);
  assert.deepEqual(waits, [25, 25]);
});

test('live verification retries when metadata is current but a runtime file is still stale', async () => {
  const expected = releaseFixture();
  const partiallyPropagated = releaseFixture({ content:{ 'shared/supply-planner.js':'stale planner bytes' } });
  partiallyPropagated.liveManifest = expected.manifest;
  const waits = [];
  const fake = fakeFetchSequence([partiallyPropagated, expected]);
  const result = await verifyLiveDeployment({
    baseUrl:'https://jspusa.github.io/Supply/',
    expectedManifest:expected.manifest,
    expectedRevision:REVISION,
    fetchImpl:fake.fetchImpl,
    attempts:2,
    retryDelayMs:15,
    wait:milliseconds => { waits.push(milliseconds); },
  });
  assert.equal(result.attempts, 2);
  assert.deepEqual(waits, [15]);
});

test('live verification stops after the bounded attempt count and reports the last mismatch', async () => {
  const expected = releaseFixture();
  const stale = releaseFixture({ revision:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
  const waits = [];
  const fake = fakeFetchSequence([stale]);
  await assert.rejects(verifyLiveDeployment({
    baseUrl:'https://jspusa.github.io/Supply/',
    expectedManifest:expected.manifest,
    expectedRevision:REVISION,
    fetchImpl:fake.fetchImpl,
    attempts:3,
    retryDelayMs:10,
    wait:milliseconds => { waits.push(milliseconds); },
  }), /failed after 3 attempts: Live revision mismatch/);
  assert.equal(fake.manifestRequests, 3);
  assert.deepEqual(waits, [10, 10]);
});

test('live verifier rejects a manifest hash that differs from the verified artifact', async () => {
  const expected = releaseFixture();
  const liveManifest = structuredClone(expected.manifest);
  liveManifest.files['shared/supply-planner.js'] = 'f'.repeat(64);
  const fake = fakeFetchSequence([{ ...expected, liveManifest }]);
  await assert.rejects(verifyLiveDeployment({
    baseUrl:'https://jspusa.github.io/Supply/',
    expectedManifest:expected.manifest,
    expectedRevision:REVISION,
    fetchImpl:fake.fetchImpl,
    attempts:1,
    retryDelayMs:0,
  }), /manifest hash mismatch: shared\/supply-planner\.js/);
});

test('live verifier requires the exact release manifest schema', async () => {
  const expected = releaseFixture();
  const liveManifest = { ...expected.manifest, unexpected:'not allowed' };
  const fake = fakeFetchSequence([{ ...expected, liveManifest }]);
  await assert.rejects(verifyLiveDeployment({
    baseUrl:'https://jspusa.github.io/Supply/',
    expectedManifest:expected.manifest,
    expectedRevision:REVISION,
    fetchImpl:fake.fetchImpl,
    attempts:1,
    retryDelayMs:0,
  }), /keys must exactly match the release schema/);
});

test('live verifier rejects stale sidebar, half-pallet, and copied planner implementations', async t => {
  const cases = [
    ['left sidebar', '<aside class="appSidebar"></aside>'],
    ['half-pallet rule', '<p>\u5efa\u8b70\u6578\u91cf\u6703\u5411\u4e0a\u53d6\u5230\u6700\u5c0f 0.5 \u68e7\u677f</p>'],
    ['copied planner implementation', '<script>function consumeStockForDays(){}</script>'],
  ];
  for (const [label, stale] of cases) {
    await t.test(label, async () => {
      const fixture = releaseFixture({ content:{ 'index.html':PUBLIC + stale } });
      const fake = fakeFetchSequence([fixture]);
      await assert.rejects(verifyLiveDeployment({
        baseUrl:'https://jspusa.github.io/Supply/',
        expectedManifest:fixture.manifest,
        expectedRevision:REVISION,
        fetchImpl:fake.fetchImpl,
        attempts:1,
        retryDelayMs:0,
      }), new RegExp(`contains stale ${label}`));
    });
  }
});

test('legacy entrypoint proof requires shared workspace modules loaded by public and Boss', async t => {
  await t.test('legacy mapping', async () => {
    const fixture = releaseFixture({ content:{ 'shared/workspace-navigation.js':`export const map = { '#decisionDashboard':'today' };` } });
    const fake = fakeFetchSequence([fixture]);
    await assert.rejects(verifyLiveDeployment({
      baseUrl:'https://jspusa.github.io/Supply/',
      expectedManifest:fixture.manifest,
      expectedRevision:REVISION,
      fetchImpl:fake.fetchImpl,
      attempts:1,
      retryDelayMs:0,
    }), /does not map to the Recommendations workspace/);
  });

  await t.test('public wiring', async () => {
    const fixture = releaseFixture({ content:{ 'index.html':'<main>Today</main>' } });
    const fake = fakeFetchSequence([fixture]);
    await assert.rejects(verifyLiveDeployment({
      baseUrl:'https://jspusa.github.io/Supply/',
      expectedManifest:fixture.manifest,
      expectedRevision:REVISION,
      fetchImpl:fake.fetchImpl,
      attempts:1,
      retryDelayMs:0,
    }), /index\.html does not load the shared workspace navigation module/);
  });

  await t.test('shared UI wiring', async () => {
    const fixture = releaseFixture({
      content:{
        'index.html':'<div id="workspaceNavMount"></div><div id="todayWorkspaceMount"></div><script type="module" src="./shared/workspace-navigation.js"></script>',
      },
    });
    const fake = fakeFetchSequence([fixture]);
    await assert.rejects(verifyLiveDeployment({
      baseUrl:'https://jspusa.github.io/Supply/',
      expectedManifest:fixture.manifest,
      expectedRevision:REVISION,
      fetchImpl:fake.fetchImpl,
      attempts:1,
      retryDelayMs:0,
    }), /index\.html does not load the shared workspace UI module/);
  });

  await t.test('local SheetJS wiring', async () => {
    const fixture = releaseFixture({
      content:{
        'index.html':'<div id="workspaceNavMount"></div><div id="todayWorkspaceMount"></div><script type="module" src="./shared/workspace-navigation.js"></script><script type="module" src="./shared/workspace-ui.js"></script>',
      },
    });
    const fake = fakeFetchSequence([fixture]);
    await assert.rejects(verifyLiveDeployment({
      baseUrl:'https://jspusa.github.io/Supply/',
      expectedManifest:fixture.manifest,
      expectedRevision:REVISION,
      fetchImpl:fake.fetchImpl,
      attempts:1,
      retryDelayMs:0,
    }), /index\.html does not load the hashed local SheetJS runtime/);
  });
});
