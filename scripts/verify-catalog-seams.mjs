import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  assertCatalogPeerRevision,
  readCatalogPeerLock,
  readRepositoryHead,
} from './catalog-peer-lock.mjs';
import { verifySourceAlignment } from './fba-visual-system-contract.mjs';

export const supplyRepo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function option(argv, name) {
  const index = argv.indexOf(name);
  if (index < 0) return null;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function requireFile(filePath, label) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    throw new Error(`${label} is missing: ${filePath}`);
  }
  return filePath;
}

function assertSharedContracts(supplyRoot, fbaRoot) {
  const pairs = [
    ['shared/catalog-update-handoff.mjs', 'catalog-update-handoff.mjs'],
    ['shared/catalog-update-baseline.js', 'catalog-update-baseline.js'],
    ['shared/catalog-update-change-plan.mjs', 'catalog-update-change-plan.mjs'],
    ['shared/catalog-update-overlay.mjs', 'catalog-update-overlay.mjs'],
    ['shared/catalog-update-planner.mjs', 'catalog-update-planner.mjs'],
    ['shared/catalog-update-product-catalog.mjs', 'catalog-update-product-catalog.mjs'],
    ['shared/catalog-update-release.mjs', 'catalog-update-release.mjs'],
    ['shared/catalog-update-runtime-lock.json', 'catalog-update-runtime-lock.json'],
    ['shared/catalog-affected-work.mjs', 'catalog-affected-work.mjs'],
    ['shared/product-update-entry.mjs', 'product-update-entry.mjs'],
    ['shared/product-update-entry.css', 'product-update-entry.css'],
  ];
  for (const [supplyRelative, fbaRelative] of pairs) {
    const supplyPath = requireFile(path.join(supplyRoot, supplyRelative), 'Supply Product Update contract');
    const fbaPath = requireFile(path.join(fbaRoot, fbaRelative), 'FBA Product Update contract');
    if (fs.readFileSync(supplyPath, 'utf8') !== fs.readFileSync(fbaPath, 'utf8')) {
      throw new Error(`Product Update contract drift: ${supplyRelative} != ${fbaRelative}`);
    }
  }
}

function runStage({ name, command, args, cwd, env = {} }) {
  process.stdout.write(`\n[Catalog seam] ${name}\n`);
  const startedAt = Date.now();
  const result = spawnSync(command, args, {
    cwd,
    env:{ ...process.env, ...env },
    stdio:'inherit',
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${name} failed with exit code ${result.status}`);
  return {
    name,
    status:'passed',
    durationMs:Date.now() - startedAt,
  };
}

export function withCatalogSeamEnvironment(stage, fbaRepo) {
  return {
    ...stage,
    env:{ ...stage.env, FBA_REPO:path.resolve(fbaRepo) },
  };
}

export function verifyCatalogSeams({
  fbaRepo,
  includeBrowser = true,
  includeFullSuites = false,
  requirePinnedPeer = false,
} = {}) {
  const resolvedFbaRepo = path.resolve(fbaRepo || path.join(supplyRepo, '..', 'FBA'));
  requireFile(path.join(supplyRepo, 'package.json'), 'Supply repository');
  requireFile(path.join(resolvedFbaRepo, 'package.json'), 'FBA repository');
  assertSharedContracts(supplyRepo, resolvedFbaRepo);
  const visualSystem = verifySourceAlignment({ fbaRepo:resolvedFbaRepo });
  const peerLock = readCatalogPeerLock({ supplyRoot:supplyRepo });
  if (requirePinnedPeer) {
    assertCatalogPeerRevision(peerLock, readRepositoryHead(resolvedFbaRepo));
  }

  const node = process.execPath;
  const playwright = requireFile(path.join(supplyRepo, 'node_modules', '.bin', 'playwright'), 'Supply Playwright runtime');
  const stages = [
    {
      name:'Supply selected catalog update through Order Draft export',
      command:node,
      args:['--test',
        'tests/catalog-order-draft-seam.test.mjs',
        'tests/catalog-alignment.test.mjs',
        'tests/product-update-entry.test.mjs',
      ],
      cwd:supplyRepo,
    },
    {
      name:'FBA catalog update through persisted packaging assignments',
      command:node,
      args:['--test',
        'tests/catalog-packaging-assignment-seam.test.js',
        'tests/packaging-assignment.test.js',
        'tests/packaging-assignment-browser.test.js',
        'tests/catalog-alignment-status.test.js',
        'tests/product-update-entry.test.js',
      ],
      cwd:resolvedFbaRepo,
    },
    {
      name:'Raw Excel release through both projections and immutable existing work',
      command:node,
      args:['--test',
        'tests/cross-repo/catalog-release-seam.test.mjs',
        'tests/cross-repo/catalog-work-preservation-seam.test.mjs',
      ],
      cwd:supplyRepo,
      env:{ FBA_REPO:resolvedFbaRepo },
    },
  ];

  if (includeBrowser) {
    stages.push(
      {
        name:'Build exact Supply artifact for Catalog Alignment browser acceptance',
        command:'npm',
        args:['run', 'build'],
        cwd:supplyRepo,
      },
      {
        name:'Catalog Alignment partial deploy, persistence, recovery, and alignment',
        command:playwright,
        args:['test', '--config', 'tests/browser/playwright.config.mjs', 'tests/browser/catalog-alignment.spec.mjs'],
        cwd:supplyRepo,
      },
      {
        name:'FBA assignment export, raw Product Update, and five-page visual system',
        command:playwright,
        args:['test', '--config', 'tests/cross-repo/playwright.config.mjs'],
        cwd:supplyRepo,
        env:{ FBA_REPO:resolvedFbaRepo },
      },
    );
  }

  if (includeFullSuites) {
    stages.push(
      { name:'Full Supply local suite', command:'npm', args:['test'], cwd:supplyRepo },
      { name:'Full FBA local suite', command:'npm', args:['test'], cwd:resolvedFbaRepo },
    );
  }

  const results = stages.map(stage => runStage(withCatalogSeamEnvironment(stage, resolvedFbaRepo)));
  const report = {
    schemaVersion:1,
    status:'passed',
    supplyRepo,
    fbaRepo:resolvedFbaRepo,
    sharedProductUpdateContract:'byte-identical',
    sharedVisualSystemContract:`v${visualSystem.version}/${visualSystem.contentHash}`,
    pinnedFbaRevision:peerLock.revision,
    peerRevisionVerified:requirePinnedPeer,
    stages:results,
  };
  process.stdout.write(`\n${JSON.stringify(report, null, 2)}\n`);
  return report;
}

function main() {
  const argv = process.argv.slice(2);
  verifyCatalogSeams({
    fbaRepo:option(argv, '--fba-repo'),
    includeBrowser:!argv.includes('--skip-browser'),
    includeFullSuites:argv.includes('--full'),
    requirePinnedPeer:argv.includes('--require-pinned-peer'),
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
