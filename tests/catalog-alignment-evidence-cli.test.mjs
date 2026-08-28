import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  createCatalogAlignmentRelease,
  recordCatalogAlignmentEvidence,
} from '../catalog/catalog-alignment.js';
import { updateCatalogAlignmentEvidence } from '../scripts/update-catalog-alignment-evidence.mjs';

const checkedAt = '2026-08-28T08:00:00.000Z';
const revision = '0123456789abcdef0123456789abcdef01234567';

function release() {
  return createCatalogAlignmentRelease({
    catalogVersion:'2026-08-28.5',
    publicContent:{ supply:{ rows:[1] }, fba:{ rows:[2] } },
  });
}

function releaseVersion(catalogVersion) {
  return createCatalogAlignmentRelease({
    catalogVersion,
    publicContent:{ supply:{ catalogVersion }, fba:{ catalogVersion } },
  });
}

function localUpdate(item, site, outcome = 'passed') {
  return recordCatalogAlignmentEvidence(item, {
    site,
    stage:'local',
    outcome,
    checkedAt,
    catalogVersion:item.catalogVersion,
    publicContentHash:item.expectedPublicContentHashes[site],
  });
}

test('evidence updater enforces stage order and exact live hash observations', () => {
  const item = release();
  assert.throws(() => updateCatalogAlignmentEvidence({
    record:item.record,
    site:'supply',
    stage:'deployment',
    outcome:'passed',
    checkedAt,
    revision,
  }), /requires local to pass first/);

  let record = localUpdate(item.record, 'supply');
  record = updateCatalogAlignmentEvidence({
    record,
    site:'supply',
    stage:'repositoryCi',
    outcome:'passed',
    checkedAt,
    revision,
  });
  record = updateCatalogAlignmentEvidence({
    record,
    site:'supply',
    stage:'deployment',
    outcome:'passed',
    checkedAt,
    revision,
  });
  record = updateCatalogAlignmentEvidence({
    record,
    site:'supply',
    stage:'liveHash',
    outcome:'passed',
    checkedAt,
    revision,
    catalogVersion:record.catalogVersion,
    publicContentHash:'f'.repeat(64),
  });
  assert.equal(record.state, 'failed');
  assert.equal(record.sites.supply.evidence.liveHash.state, 'failed');
});

test('recovery resets only the failed site from its first failed stage', () => {
  const item = release();
  let record = localUpdate(item.record, 'supply', 'failed');
  const fbaBefore = structuredClone(record.sites.fba);
  record = updateCatalogAlignmentEvidence({ record, recover:true, site:'supply' });

  assert.equal(record.state, 'pending');
  assert.equal(record.sites.supply.recoveryAttempts, 1);
  assert.equal(record.sites.supply.evidence.local.state, 'pending');
  assert.deepEqual(record.sites.fba, fbaBefore);
});

test('the CLI module does not create files when imported', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alignment-evidence-import-'));
  try {
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally {
    fs.rmSync(directory, { recursive:true, force:true });
  }
});

test('the CLI refuses to move latest evidence back to an older catalog version', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'alignment-evidence-version-'));
  const olderPath = path.join(directory, '2026-08-28.5.json');
  const latestPath = path.join(directory, 'latest.json');
  const older = releaseVersion('2026-08-28.5').record;
  const latest = releaseVersion('2026-08-28.6').record;
  fs.writeFileSync(olderPath, `${JSON.stringify(older)}\n`);
  fs.writeFileSync(latestPath, `${JSON.stringify(latest)}\n`);
  try {
    const result = spawnSync(process.execPath, [
      path.resolve(import.meta.dirname, '../scripts/update-catalog-alignment-evidence.mjs'),
      '--record', olderPath,
      '--latest', latestPath,
      '--recover',
      '--site', 'supply',
    ], { encoding:'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing to replace latest Catalog Alignment/);
    assert.equal(JSON.parse(fs.readFileSync(latestPath, 'utf8')).catalogVersion, '2026-08-28.6');
  } finally {
    fs.rmSync(directory, { recursive:true, force:true });
  }
});
