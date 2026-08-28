import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  beginCatalogAlignmentRecovery,
  recordCatalogAlignmentEvidence,
  validateCatalogAlignmentRecord,
} from '../catalog/catalog-alignment.js';

const supplyRepo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultRecordsDirectory = path.join(supplyRepo, 'catalog', 'alignment-records');

function parseOptions(argv) {
  const options = { recover:false };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--recover') {
      options.recover = true;
      continue;
    }
    const value = argv[index + 1];
    if (!key?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`Invalid option near ${key || 'end of command'}`);
    }
    options[key.slice(2)] = value;
    index += 1;
  }
  return options;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function snapshot(filePath) {
  return {
    filePath,
    existed:fs.existsSync(filePath),
    content:fs.existsSync(filePath) ? fs.readFileSync(filePath) : null,
  };
}

function restore(item) {
  if (item.existed) {
    fs.mkdirSync(path.dirname(item.filePath), { recursive:true });
    fs.writeFileSync(item.filePath, item.content);
  } else if (fs.existsSync(item.filePath)) {
    fs.rmSync(item.filePath, { force:true });
  }
}

function writeRecordPair(record, { versionPath, latestPath }) {
  const content = `${JSON.stringify(record, null, 2)}\n`;
  const targets = [...new Set([path.resolve(versionPath), path.resolve(latestPath)])];
  const before = targets.map(snapshot);
  try {
    for (const filePath of targets) {
      fs.mkdirSync(path.dirname(filePath), { recursive:true });
      fs.writeFileSync(filePath, content);
    }
  } catch (error) {
    for (const item of before) restore(item);
    throw error;
  }
}

export function updateCatalogAlignmentEvidence({
  record,
  recover = false,
  site = null,
  stage = null,
  outcome = null,
  checkedAt = new Date().toISOString(),
  revision = null,
  catalogVersion = null,
  publicContentHash = null,
} = {}) {
  let next = validateCatalogAlignmentRecord(record);
  if (recover) next = beginCatalogAlignmentRecovery(next, site);
  if (stage || outcome) {
    if (!stage || !outcome) throw new Error('--stage and --outcome must be provided together');
    next = recordCatalogAlignmentEvidence(next, {
      site,
      stage,
      outcome,
      checkedAt,
      revision,
      catalogVersion,
      publicContentHash,
    });
  }
  return next;
}

function main() {
  const options = parseOptions(process.argv.slice(2));
  if (!options.recover && (!options.stage || !options.outcome)) {
    throw new Error('Provide --recover and/or --stage <stage> --outcome <passed|failed>');
  }
  if (!options.site) throw new Error('Required option: --site <supply|fba>');

  const latestPath = path.resolve(options.latest || path.join(defaultRecordsDirectory, 'latest.json'));
  const sourcePath = path.resolve(options.record || latestPath);
  if (!fs.existsSync(sourcePath)) throw new Error(`Catalog Alignment record not found: ${sourcePath}`);
  const original = validateCatalogAlignmentRecord(readJson(sourcePath));
  if (sourcePath !== latestPath && fs.existsSync(latestPath)) {
    const latest = validateCatalogAlignmentRecord(readJson(latestPath));
    if (latest.catalogVersion !== original.catalogVersion) {
      throw new Error(`Refusing to replace latest Catalog Alignment ${latest.catalogVersion} with older record ${original.catalogVersion}`);
    }
  }
  const next = updateCatalogAlignmentEvidence({
    record:original,
    recover:options.recover,
    site:options.site,
    stage:options.stage || null,
    outcome:options.outcome || null,
    checkedAt:options['checked-at'] || new Date().toISOString(),
    revision:options.revision || null,
    catalogVersion:options['catalog-version'] || null,
    publicContentHash:options['public-content-hash'] || null,
  });
  const versionPath = path.resolve(options['version-record'] || path.join(
    path.dirname(latestPath),
    `${next.catalogVersion}.json`,
  ));
  writeRecordPair(next, { versionPath, latestPath });
  process.stdout.write(`${next.catalogVersion} ${options.site} ${options.stage || 'recovery'}: ${next.state}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(error?.stack || error);
    process.exitCode = 1;
  }
}
