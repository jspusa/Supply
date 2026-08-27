import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { runtimeFiles } from '../scripts/site-contract.mjs';

const repoRoot = path.resolve(import.meta.dirname, '..');
const vendorPath = path.join(repoRoot, 'vendor', 'xlsx.full.min.js');
const installedPath = path.join(repoRoot, 'node_modules', 'xlsx', 'dist', 'xlsx.full.min.js');
const vendorLicensePath = path.join(repoRoot, 'vendor', 'LICENSE.sheetjs.txt');
const installedLicensePath = path.join(repoRoot, 'node_modules', 'xlsx', 'LICENSE');
const expectedHash = 'cc015130aa8521e7f088f88898eba949ccdcbfb38df0bd129b44b7273c3a6f41';
const expectedLicenseHash = '4d2a38ac35cda06a555c84074a819d413339cd3691b822cae50f8f322fe01f64';
const sha256 = value => createHash('sha256').update(value).digest('hex');

test('the official locked SheetJS 0.20.3 browser bundle is local and release-hashed', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const installedPackage = JSON.parse(fs.readFileSync(path.join(repoRoot, 'node_modules', 'xlsx', 'package.json'), 'utf8'));
  const vendorBytes = fs.readFileSync(vendorPath);
  const installedBytes = fs.readFileSync(installedPath);

  assert.equal(packageJson.devDependencies.xlsx, 'https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz');
  assert.equal(installedPackage.version, '0.20.3');
  assert.equal(sha256(vendorBytes), expectedHash);
  assert.deepEqual(vendorBytes, installedBytes);
  assert.ok(runtimeFiles.includes('vendor/xlsx.full.min.js'));

  const publicHtml = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');
  const bossHtml = fs.readFileSync(path.join(repoRoot, 'Boss', 'index.html'), 'utf8');
  assert.match(publicHtml, /<script src="\.\/vendor\/xlsx\.full\.min\.js"><\/script>/);
  assert.match(bossHtml, /<script src="\.\.\/vendor\/xlsx\.full\.min\.js"><\/script>/);
  assert.doesNotMatch(publicHtml + bossHtml, /<script[^>]+src=["']https?:\/\/[^"']*(?:xlsx|sheetjs)/i);
});

test('the vendored SheetJS runtime ships its exact official Apache-2.0 license', () => {
  const vendorBytes = fs.readFileSync(vendorLicensePath);
  const installedBytes = fs.readFileSync(installedLicensePath);

  assert.equal(sha256(vendorBytes), expectedLicenseHash);
  assert.deepEqual(vendorBytes, installedBytes);
  assert.ok(runtimeFiles.includes('vendor/LICENSE.sheetjs.txt'));
});
