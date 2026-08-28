import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import {
  CATALOG_ALIGNMENT_EVIDENCE_STAGES,
  CatalogAlignmentBlockedError,
  assertNextCatalogReleaseAllowed,
  beginCatalogAlignmentRecovery,
  createCatalogAlignmentRelease,
  evaluateCatalogAlignmentManifests,
  hashPublicContent,
  recordCatalogAlignmentEvidence,
  validateCatalogAlignmentRecord,
} from '../catalog/catalog-alignment.js';

const repoRoot = path.resolve(import.meta.dirname, '..');
const timestamp = '2026-08-28T08:00:00.000Z';
const revision = '0123456789abcdef0123456789abcdef01234567';

function fixtureRelease(version = '2026-08-28.5') {
  return createCatalogAlignmentRelease({
    catalogVersion: version,
    publicContent: {
      supply: {
        schemaVersion: 2,
        catalogVersion: version,
        products: [{ productSku: 'GTBL05', unitsPerCarton: 30 }],
      },
      fba: {
        schemaVersion: 1,
        catalogVersion: version,
        projection: 'fba-inbound',
        products: [{ productSku: 'GTBL05', unitsPerCarton: 30 }],
      },
    },
  });
}

function browserAlignmentApi() {
  const context = vm.createContext({
    URL,
    Date,
    console,
    setTimeout,
    clearTimeout,
  });
  for (const relativePath of ['shared/catalog-alignment-status.js', 'shared/catalog-alignment-ui.js']) {
    vm.runInContext(fs.readFileSync(path.join(repoRoot, relativePath), 'utf8'), context, { filename:relativePath });
  }
  return context.JSPCatalogAlignmentUI;
}

function mapStorage() {
  const values = new Map();
  return {
    values,
    getItem:key => values.get(key) || null,
    setItem:(key, value) => values.set(key, value),
    removeItem:key => values.delete(key),
  };
}

function updateFor(release, site, stage, outcome = 'passed') {
  const common = { site, stage, outcome, checkedAt: timestamp };
  if (stage === 'local' || stage === 'liveHash') {
    return {
      ...common,
      revision: stage === 'liveHash' ? revision : null,
      catalogVersion: release.record.catalogVersion,
      publicContentHash: release.record.expectedPublicContentHashes[site],
    };
  }
  return { ...common, revision };
}

function passSite(release, record, site) {
  let next = record;
  for (const stage of CATALOG_ALIGNMENT_EVIDENCE_STAGES) {
    next = recordCatalogAlignmentEvidence(next, updateFor(release, site, stage));
  }
  return next;
}

test('public content hashes are deterministic while preserving meaningful array order', () => {
  const first = { products:[{ sku:'B', units:2 }, { sku:'A', units:1 }], catalogVersion:'2026-08-28.5' };
  const reorderedKeys = { catalogVersion:'2026-08-28.5', products:[{ units:2, sku:'B' }, { units:1, sku:'A' }] };
  const reorderedProducts = { catalogVersion:'2026-08-28.5', products:[...first.products].reverse() };

  assert.equal(hashPublicContent(first), hashPublicContent(reorderedKeys));
  assert.notEqual(hashPublicContent(first), hashPublicContent(reorderedProducts));
  assert.match(hashPublicContent(first), /^[a-f0-9]{64}$/);
  assert.throws(() => hashPublicContent({ invalid:Infinity }), /non-finite number/);
});

test('one release creates two compact manifests with one version and both expected public hashes', () => {
  const release = fixtureRelease();
  const { supply, fba } = release.manifests;

  assert.equal(supply.catalogVersion, '2026-08-28.5');
  assert.equal(fba.catalogVersion, supply.catalogVersion);
  assert.deepEqual(fba.expectedPublicContentHashes, supply.expectedPublicContentHashes);
  assert.equal(supply.publicContentHash, supply.expectedPublicContentHashes.supply);
  assert.equal(fba.publicContentHash, fba.expectedPublicContentHashes.fba);
  assert.equal(release.record.state, 'pending');
  assert.deepEqual(Object.keys(release.record.sites.supply.evidence), [...CATALOG_ALIGNMENT_EVIDENCE_STAGES]);
  assert.doesNotMatch(JSON.stringify(release.manifests), /products|sourceFile|private|notification/i);
});

test('site status is aligned only when version and both expected public content hashes agree', () => {
  const current = fixtureRelease();
  assert.deepEqual(evaluateCatalogAlignmentManifests(current.manifests.supply, current.manifests.fba), {
    state:'aligned',
    catalogVersion:'2026-08-28.5',
    localSite:'supply',
    peerSite:'fba',
    issues:[],
  });

  const previous = fixtureRelease('2026-08-28.4');
  const partial = evaluateCatalogAlignmentManifests(current.manifests.supply, previous.manifests.fba);
  assert.equal(partial.state, 'failed');
  assert.deepEqual(partial.issues.map(item => item.code), [
    'catalog-version-mismatch',
    'expected-public-content-hash-mismatch',
  ]);

  const unavailable = evaluateCatalogAlignmentManifests(current.manifests.supply, null);
  assert.equal(unavailable.state, 'pending');
  assert.equal(unavailable.issues[0].code, 'peer-manifest-unavailable');

  const wrongHash = structuredClone(current.manifests.fba);
  wrongHash.publicContentHash = '0'.repeat(64);
  const corrupted = evaluateCatalogAlignmentManifests(current.manifests.supply, wrongHash);
  assert.equal(corrupted.state, 'failed');
  assert.deepEqual(corrupted.issues.at(-1), { code:'public-content-hash-mismatch', site:'fba' });
});

test('release evidence remains stage-specific and a failed live hash cannot be claimed as passed', () => {
  const release = fixtureRelease();
  let record = release.record;
  record = recordCatalogAlignmentEvidence(record, updateFor(release, 'supply', 'local'));
  record = recordCatalogAlignmentEvidence(record, updateFor(release, 'supply', 'repositoryCi'));
  record = recordCatalogAlignmentEvidence(record, updateFor(release, 'supply', 'deployment'));
  record = recordCatalogAlignmentEvidence(record, {
    ...updateFor(release, 'supply', 'liveHash'),
    publicContentHash:'f'.repeat(64),
  });

  assert.equal(record.state, 'failed');
  assert.equal(record.sites.supply.evidence.liveHash.state, 'failed');
  assert.equal(record.sites.supply.evidence.deployment.state, 'passed');
  assert.equal(record.sites.supply.evidence.liveBrowser.state, 'pending');
  assert.throws(
    () => recordCatalogAlignmentEvidence(record, updateFor(release, 'supply', 'liveBrowser')),
    /requires liveHash to pass first/,
  );
});

test('partial failure persists, retries only the failed projection, never rolls back, and blocks the next release', () => {
  const release = fixtureRelease();
  let record = passSite(release, release.record, 'supply');
  record = recordCatalogAlignmentEvidence(record, updateFor(release, 'fba', 'local'));
  record = recordCatalogAlignmentEvidence(record, updateFor(release, 'fba', 'repositoryCi'));
  record = recordCatalogAlignmentEvidence(record, updateFor(release, 'fba', 'deployment', 'failed'));

  const persisted = JSON.parse(JSON.stringify(record));
  assert.equal(validateCatalogAlignmentRecord(persisted).state, 'failed');
  assert.throws(
    () => assertNextCatalogReleaseAllowed(persisted),
    error => error instanceof CatalogAlignmentBlockedError
      && error.state === 'failed'
      && error.catalogVersion === '2026-08-28.5'
      && assert.deepEqual(error.retryableSites, ['fba']) === undefined,
  );

  const successfulProjectionBeforeRecovery = structuredClone(record.sites.supply);
  const expectedHashesBeforeRecovery = structuredClone(record.expectedPublicContentHashes);
  record = beginCatalogAlignmentRecovery(record);

  assert.equal(record.state, 'pending');
  assert.equal(record.sites.fba.recoveryAttempts, 1);
  assert.equal(record.sites.fba.evidence.local.state, 'passed');
  assert.equal(record.sites.fba.evidence.repositoryCi.state, 'passed');
  assert.equal(record.sites.fba.evidence.deployment.state, 'pending');
  assert.deepEqual(record.sites.supply, successfulProjectionBeforeRecovery);
  assert.deepEqual(record.expectedPublicContentHashes, expectedHashesBeforeRecovery);
  assert.equal(record.catalogVersion, '2026-08-28.5');
  assert.throws(() => assertNextCatalogReleaseAllowed(record), /repair Catalog Alignment/);

  for (const stage of ['deployment', 'liveHash', 'liveBrowser']) {
    record = recordCatalogAlignmentEvidence(record, updateFor(release, 'fba', stage));
  }
  assert.equal(record.state, 'aligned');
  assert.equal(assertNextCatalogReleaseAllowed(record), true);
});

test('browser consumer uses the same compact manifest decision and performs no catalog/network work itself', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'shared/catalog-alignment-status.js'), 'utf8');
  const context = vm.createContext({});
  vm.runInContext(source, context, { filename:'shared/catalog-alignment-status.js' });
  const consumer = context.JSPCatalogAlignment;
  const release = fixtureRelease();

  assert.deepEqual(
    JSON.parse(JSON.stringify(consumer.evaluateCatalogAlignmentManifests(release.manifests.supply, release.manifests.fba))),
    evaluateCatalogAlignmentManifests(release.manifests.supply, release.manifests.fba),
  );
  assert.doesNotMatch(source, /\bfetch\s*\(/);
  assert.doesNotMatch(source, /products|orderSkuAliases/);
});

test('website controller compares local and peer compact manifests so a partial deployment stays red', async () => {
  const api = browserAlignmentApi();
  const current = fixtureRelease('2026-08-28.10');
  const stale = fixtureRelease('2026-08-28.9');
  const storage = mapStorage();
  const requests = [];
  const events = [];
  const controller = api.createCatalogAlignmentController({
    site:'supply',
    localManifestUrl:'./catalog-alignment.json',
    peerManifestUrl:'../FBA/catalog-alignment.json',
    storage,
    eventTarget:{ dispatchEvent:event => events.push({ type:event.type, detail:event.detail }) },
    now:() => timestamp,
    fetchImpl:async url => {
      requests.push(url);
      const payload = url.startsWith('./') ? current.manifests.supply : stale.manifests.fba;
      return { ok:true, status:200, json:async () => structuredClone(payload) };
    },
  });

  const status = await controller.refresh();
  assert.equal(status.state, 'failed');
  assert.deepEqual(JSON.parse(JSON.stringify(status.retrySites)), ['fba']);
  assert.deepEqual(requests, ['./catalog-alignment.json', '../FBA/catalog-alignment.json']);
  assert.ok(requests.every(url => url.endsWith('catalog-alignment.json')));
  assert.doesNotMatch([...storage.values.values()][0], /products|publicContentHash|expectedPublicContentHashes/);

  const recovery = controller.requestRecovery(status);
  assert.deepEqual(JSON.parse(JSON.stringify(recovery)), {
    catalogVersion:'2026-08-28.10',
    retrySites:['fba'],
    mode:'local-release-workflow',
  });
  assert.deepEqual(JSON.parse(JSON.stringify(events)), [{
    type:'jsp:catalog-alignment-recovery-request',
    detail:{
      catalogVersion:'2026-08-28.10',
      retrySites:['fba'],
      mode:'local-release-workflow',
    },
  }]);
});

test('persisted partial failure remains red through a transient peer-manifest outage until real alignment is observed', async () => {
  const api = browserAlignmentApi();
  const current = fixtureRelease();
  const stale = fixtureRelease('2026-08-28.4');
  const storage = mapStorage();
  let peerAvailable = true;
  const options = {
    site:'supply',
    localManifestUrl:'./catalog-alignment.json',
    peerManifestUrl:'../FBA/catalog-alignment.json',
    storage,
    now:() => timestamp,
    fetchImpl:async url => {
      if (url.startsWith('./')) return { ok:true, status:200, json:async () => structuredClone(current.manifests.supply) };
      if (!peerAvailable) throw new Error('offline');
      return { ok:true, status:200, json:async () => structuredClone(stale.manifests.fba) };
    },
  };
  const first = api.createCatalogAlignmentController(options);
  assert.equal((await first.refresh()).state, 'failed');

  peerAvailable = false;
  const afterRefresh = api.createCatalogAlignmentController(options);
  const retained = await afterRefresh.refresh();
  assert.equal(retained.state, 'failed');
  assert.equal(retained.stale, true);
  assert.ok(retained.issues.some(item => item.code === 'peer-manifest-unavailable'));

  peerAvailable = true;
  options.fetchImpl = async url => ({
    ok:true,
    status:200,
    json:async () => structuredClone(url.startsWith('./') ? current.manifests.supply : current.manifests.fba),
  });
  const repaired = api.createCatalogAlignmentController(options);
  assert.equal((await repaired.refresh()).state, 'aligned');
  assert.equal(repaired.readPersisted().state, 'aligned');
});

test('Supply entrypoints load the compact alignment contract and never point at a peer catalog', () => {
  const publicSource = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');
  const bossSource = fs.readFileSync(path.join(repoRoot, 'Boss/index.html'), 'utf8');
  for (const [label, source] of [['public', publicSource], ['Boss', bossSource]]) {
    assert.match(source, /catalog-alignment-status\.css/ , label);
    assert.match(source, /catalog-alignment-status\.js/ , label);
    assert.match(source, /catalog-alignment-ui\.js/ , label);
    assert.match(source, /data-local-manifest="[^\"]*catalog-alignment\.json"/ , label);
    assert.match(source, /data-peer-manifest="[^\"]*FBA\/catalog-alignment\.json"/ , label);
    assert.doesNotMatch(source, /data-peer-manifest="[^\"]*(?:product-data|product-catalog)/ , label);
  }
  const css = fs.readFileSync(path.join(repoRoot, 'shared/catalog-alignment-status.css'), 'utf8');
  assert.match(css, /data-state="failed"[\s\S]*#d70015/);
});
