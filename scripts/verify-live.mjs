import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const DEFAULT_LIVE_ATTEMPTS = 18;
export const DEFAULT_LIVE_RETRY_DELAY_MS = 5_000;
export const DEFAULT_LIVE_REQUEST_TIMEOUT_MS = 15_000;

const REQUIRED_ENTRYPOINTS = Object.freeze(['index.html', 'Boss/index.html']);
const LEGACY_NAVIGATION_MODULE = 'shared/workspace-navigation.js';
const WORKSPACE_UI_MODULE = 'shared/workspace-ui.js';
const XLSX_RUNTIME = 'vendor/xlsx.full.min.js';
const STALE_HTML_MARKERS = Object.freeze([
  Object.freeze({ label:'left sidebar', pattern:/\bappSidebar\b|\bsidebarCollapse\b|supply-sidebar-collapsed/i }),
  Object.freeze({ label:'half-pallet rule', pattern:/roundUpToHalfPallet|\u6700\u5c0f\s*0\.5\s*\u68e7\u677f|half[- ]pallet/i }),
  Object.freeze({
    label:'copied planner implementation',
    pattern:/function\s+(?:roundToExecutableOrderQty|consumeStockForDays|projectStockAcrossEvents|getRequiredQtyAcrossEvents|getFirstStockoutDateAcrossEvents|getContinuousCoverageDays)\s*\(/,
  }),
]);

function isRecord(value) {
  return Boolean(value) && !Array.isArray(value) && typeof value === 'object';
}

function requireInteger(value, label, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return number;
}

function normalizeBaseUrl(value) {
  const url = new URL(String(value || ''));
  if (!['http:', 'https:'].includes(url.protocol)) throw new TypeError('baseUrl must use HTTP or HTTPS');
  url.hash = '';
  url.search = '';
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

function normalizedManifest(manifest, label) {
  if (!isRecord(manifest)) throw new TypeError(`${label} must be an object`);
  if (JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(['files', 'revision', 'schemaVersion'])) {
    throw new TypeError(`${label} keys must exactly match the release schema`);
  }
  if (manifest.schemaVersion !== 1) throw new TypeError(`${label} has an unsupported schemaVersion`);
  if (typeof manifest.revision !== 'string' || !manifest.revision.trim()) {
    throw new TypeError(`${label} revision must be a non-empty string`);
  }
  if (!isRecord(manifest.files) || Object.keys(manifest.files).length === 0) {
    throw new TypeError(`${label} files must be a non-empty object`);
  }
  const files = {};
  for (const relativePath of Object.keys(manifest.files).sort()) {
    if (
      !relativePath
      || relativePath.startsWith('/')
      || /[\\?#]/.test(relativePath)
      || relativePath.split('/').includes('..')
      || new URL(relativePath, 'https://supply.invalid/').origin !== 'https://supply.invalid'
    ) throw new TypeError(`${label} contains an unsafe runtime path: ${relativePath}`);
    const hash = manifest.files[relativePath];
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) {
      throw new TypeError(`${label} contains an invalid SHA-256 for ${relativePath}`);
    }
    files[relativePath] = hash;
  }
  for (const entrypoint of REQUIRED_ENTRYPOINTS) {
    if (!Object.hasOwn(files, entrypoint)) throw new TypeError(`${label} is missing ${entrypoint}`);
  }
  if (!Object.hasOwn(files, LEGACY_NAVIGATION_MODULE)) {
    throw new TypeError(`${label} is missing ${LEGACY_NAVIGATION_MODULE}`);
  }
  if (!Object.hasOwn(files, WORKSPACE_UI_MODULE)) {
    throw new TypeError(`${label} is missing ${WORKSPACE_UI_MODULE}`);
  }
  if (!Object.hasOwn(files, XLSX_RUNTIME)) {
    throw new TypeError(`${label} is missing ${XLSX_RUNTIME}`);
  }
  return { schemaVersion:1, revision:manifest.revision, files };
}

function assertExactManifest(actual, expected) {
  const live = normalizedManifest(actual, 'live release manifest');
  if (live.revision !== expected.revision) {
    throw new Error(`Live revision mismatch: expected ${expected.revision}, received ${live.revision}`);
  }
  const expectedPaths = Object.keys(expected.files);
  const livePaths = Object.keys(live.files);
  if (JSON.stringify(livePaths) !== JSON.stringify(expectedPaths)) {
    throw new Error('Live release manifest file list does not match the verified artifact');
  }
  for (const relativePath of expectedPaths) {
    if (live.files[relativePath] !== expected.files[relativePath]) {
      throw new Error(`Live release manifest hash mismatch: ${relativePath}`);
    }
  }
  return live;
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function cacheBustedUrl(baseUrl, relativePath, revision, attempt) {
  const url = new URL(relativePath, baseUrl);
  url.searchParams.set('supply-release', `${revision}-${attempt}`);
  return url;
}

async function fetchBytes(fetchImpl, url, label, requestTimeoutMs) {
  const response = await fetchImpl(url, {
    cache:'no-store',
    headers:{ accept:'application/octet-stream', 'cache-control':'no-cache' },
    signal:AbortSignal.timeout(requestTimeoutMs),
  });
  if (!response?.ok) throw new Error(`${label} returned HTTP ${response?.status ?? 'unknown'}`);
  return Buffer.from(await response.arrayBuffer());
}

function assertHtmlContract(relativePath, source) {
  for (const marker of STALE_HTML_MARKERS) {
    if (marker.pattern.test(source)) throw new Error(`${relativePath} contains stale ${marker.label}`);
  }
  const navigationReference = relativePath === 'index.html'
    ? /(?:src|href)=["']\.\/shared\/workspace-navigation\.js["']/i
    : /(?:src|href)=["']\.\.\/shared\/workspace-navigation\.js["']/i;
  if (!navigationReference.test(source)) {
    throw new Error(`${relativePath} does not load the shared workspace navigation module`);
  }
  const workspaceUiReference = relativePath === 'index.html'
    ? /(?:src|href)=["']\.\/shared\/workspace-ui\.js["']/i
    : /(?:src|href)=["']\.\.\/shared\/workspace-ui\.js["']/i;
  if (!workspaceUiReference.test(source)) {
    throw new Error(`${relativePath} does not load the shared workspace UI module`);
  }
  if (!/id=["']workspaceNavMount["']/i.test(source) || !/id=["']todayWorkspaceMount["']/i.test(source)) {
    throw new Error(`${relativePath} does not expose the shared workspace UI mount points`);
  }
  const xlsxReference = relativePath === 'index.html'
    ? /(?:src|href)=["']\.\/vendor\/xlsx\.full\.min\.js["']/i
    : /(?:src|href)=["']\.\.\/vendor\/xlsx\.full\.min\.js["']/i;
  if (!xlsxReference.test(source)) {
    throw new Error(`${relativePath} does not load the hashed local SheetJS runtime`);
  }
  if (/<script[^>]+src=["']https?:\/\/[^"']*(?:xlsx|sheetjs)[^"']*["']/i.test(source)) {
    throw new Error(`${relativePath} loads an external SheetJS runtime`);
  }
}

function assertLegacyEntrypointContract(navigationSource) {
  if (!/["']#decisionDashboard["']\s*:\s*["']recommendations["']/.test(navigationSource)) {
    throw new Error('Legacy #decisionDashboard does not map to the Recommendations workspace');
  }
}

async function verifyAttempt({ baseUrl, expected, fetchImpl, attempt, requestTimeoutMs }) {
  const manifestBytes = await fetchBytes(
    fetchImpl,
    cacheBustedUrl(baseUrl, 'release.json', expected.revision, attempt),
    'live release.json',
    requestTimeoutMs,
  );
  let liveManifest;
  try {
    liveManifest = JSON.parse(manifestBytes.toString('utf8'));
  } catch {
    throw new Error('Live release manifest is not valid JSON');
  }
  assertExactManifest(liveManifest, expected);

  const content = new Map();
  await Promise.all(Object.entries(expected.files).map(async ([relativePath, expectedHash]) => {
    const bytes = await fetchBytes(
      fetchImpl,
      cacheBustedUrl(baseUrl, relativePath, expected.revision, attempt),
      relativePath,
      requestTimeoutMs,
    );
    const actualHash = sha256(bytes);
    if (actualHash !== expectedHash) {
      throw new Error(`Live file hash mismatch: ${relativePath}`);
    }
    content.set(relativePath, bytes);
  }));

  for (const entrypoint of REQUIRED_ENTRYPOINTS) {
    assertHtmlContract(entrypoint, content.get(entrypoint).toString('utf8'));
  }
  assertLegacyEntrypointContract(content.get(LEGACY_NAVIGATION_MODULE).toString('utf8'));
  const publicUrl = cacheBustedUrl(baseUrl, './', expected.revision, attempt);
  const bossUrl = cacheBustedUrl(baseUrl, 'Boss/', expected.revision, attempt);
  const legacyUrl = cacheBustedUrl(baseUrl, './', expected.revision, attempt);
  legacyUrl.hash = '#decisionDashboard';
  for (const [label, url, expectedPath] of [
    ['public entrypoint', publicUrl, 'index.html'],
    ['Boss entrypoint', bossUrl, 'Boss/index.html'],
    ['legacy #decisionDashboard entrypoint', legacyUrl, 'index.html'],
  ]) {
    const directBytes = await fetchBytes(fetchImpl, url, label, requestTimeoutMs);
    if (sha256(directBytes) !== expected.files[expectedPath]) {
      throw new Error(`${label} does not serve the verified ${expectedPath}`);
    }
  }
  return {
    ok:true,
    revision:expected.revision,
    fileCount:Object.keys(expected.files).length,
    attempts:attempt,
    publicUrl:new URL('./', baseUrl).href,
    bossUrl:new URL('Boss/', baseUrl).href,
    legacyUrl:new URL('#decisionDashboard', baseUrl).href,
  };
}

export async function verifyLiveDeployment({
  baseUrl,
  expectedManifest,
  expectedRevision,
  fetchImpl = globalThis.fetch,
  attempts = DEFAULT_LIVE_ATTEMPTS,
  retryDelayMs = DEFAULT_LIVE_RETRY_DELAY_MS,
  requestTimeoutMs = DEFAULT_LIVE_REQUEST_TIMEOUT_MS,
  wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
} = {}) {
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (typeof wait !== 'function') throw new TypeError('wait must be a function');
  const expected = normalizedManifest(expectedManifest, 'verified release manifest');
  if (typeof expectedRevision !== 'string' || !expectedRevision.trim()) {
    throw new TypeError('expectedRevision must be a non-empty string');
  }
  if (expected.revision !== expectedRevision) {
    throw new Error(`Verified manifest revision mismatch: expected ${expectedRevision}, received ${expected.revision}`);
  }
  const resolvedBaseUrl = normalizeBaseUrl(baseUrl);
  const boundedAttempts = requireInteger(attempts, 'attempts', 1, 100);
  const boundedDelay = requireInteger(retryDelayMs, 'retryDelayMs', 0, 60_000);
  const boundedRequestTimeout = requireInteger(requestTimeoutMs, 'requestTimeoutMs', 250, 120_000);
  let lastError = null;
  for (let attempt = 1; attempt <= boundedAttempts; attempt += 1) {
    try {
      return await verifyAttempt({ baseUrl:resolvedBaseUrl, expected, fetchImpl, attempt, requestTimeoutMs:boundedRequestTimeout });
    } catch (error) {
      lastError = error;
      if (attempt < boundedAttempts) await wait(boundedDelay);
    }
  }
  throw new Error(`Live release verification failed after ${boundedAttempts} attempts: ${lastError?.message || 'unknown error'}`, { cause:lastError });
}

function readOption(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

async function main() {
  const manifestPath = path.resolve(readOption('--manifest') || process.env.SUPPLY_RELEASE_MANIFEST || 'dist/release.json');
  const expectedManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const expectedRevision = readOption('--revision') || process.env.SUPPLY_EXPECTED_REVISION;
  const baseUrl = readOption('--base-url') || process.env.SUPPLY_LIVE_BASE_URL;
  const attempts = readOption('--attempts') || process.env.SUPPLY_LIVE_ATTEMPTS || DEFAULT_LIVE_ATTEMPTS;
  const retryDelayMs = readOption('--retry-delay-ms') || process.env.SUPPLY_LIVE_RETRY_DELAY_MS || DEFAULT_LIVE_RETRY_DELAY_MS;
  const requestTimeoutMs = readOption('--request-timeout-ms') || process.env.SUPPLY_LIVE_REQUEST_TIMEOUT_MS || DEFAULT_LIVE_REQUEST_TIMEOUT_MS;
  const result = await verifyLiveDeployment({ baseUrl, expectedManifest, expectedRevision, attempts, retryDelayMs, requestTimeoutMs });
  console.log(`Verified live Supply revision ${result.revision}: ${result.fileCount} files in ${result.attempts} attempt(s)`);
  console.log(`Entrypoints: ${result.publicUrl} ${result.bossUrl} ${result.legacyUrl}`);
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
