import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export const DEFAULT_LIVE_BROWSER_ATTEMPTS = 6;
export const DEFAULT_LIVE_BROWSER_RETRY_DELAY_MS = 5_000;
export const DEFAULT_LIVE_BROWSER_NAVIGATION_TIMEOUT_MS = 20_000;
export const DEFAULT_LIVE_BROWSER_ASSERTION_TIMEOUT_MS = 12_000;

const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function requireInteger(value, label, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return number;
}

function requireRevision(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError('expectedRevision must be a non-empty string');
  }
  return value.trim();
}

function normalizeBaseUrl(value) {
  const url = new URL(String(value || ''));
  if (!['http:', 'https:'].includes(url.protocol)) throw new TypeError('baseUrl must use HTTP or HTTPS');
  url.hash = '';
  url.search = '';
  if (!url.pathname.endsWith('/')) url.pathname += '/';
  return url;
}

function cacheBustedUrl(baseUrl, relativePath, revision, attempt, hash = '') {
  const url = new URL(relativePath, baseUrl);
  url.searchParams.set('supply-release', `${revision}-${attempt}`);
  url.hash = hash;
  return url.href;
}

export function buildLiveBrowserUrls({ baseUrl, expectedRevision, attempt = 1 } = {}) {
  const resolvedBaseUrl = normalizeBaseUrl(baseUrl);
  const revision = requireRevision(expectedRevision);
  const boundedAttempt = requireInteger(attempt, 'attempt', 1, 100);
  return Object.freeze({
    releaseUrl:cacheBustedUrl(resolvedBaseUrl, 'release.json', revision, boundedAttempt),
    legacyPublicUrl:cacheBustedUrl(resolvedBaseUrl, './', revision, boundedAttempt, '#decisionDashboard'),
    legacyTodayUrl:cacheBustedUrl(resolvedBaseUrl, './', revision, boundedAttempt, '#today'),
    legacyCanonicalUrl:cacheBustedUrl(resolvedBaseUrl, './', revision, boundedAttempt, '#recommendations'),
    canonicalPublicUrl:cacheBustedUrl(resolvedBaseUrl, './', revision, boundedAttempt, '#recommendations'),
    bossUrl:cacheBustedUrl(resolvedBaseUrl, 'Boss/', revision, boundedAttempt, '#today'),
    bossCanonicalUrl:cacheBustedUrl(resolvedBaseUrl, 'Boss/', revision, boundedAttempt, '#recommendations'),
  });
}

async function requireCount(locator, expected, label) {
  const actual = await locator.count();
  if (actual !== expected) throw new Error(`${label} count mismatch: expected ${expected}, received ${actual}`);
}

async function requireExactTextList(locator, expected, label) {
  const actual = (await locator.allTextContents()).map(value => value.trim());
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label} mismatch: expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`);
  }
}

async function requireVisible(page, selector, label, timeout) {
  const locator = page.locator(selector);
  await requireCount(locator, 1, label);
  await locator.waitFor({ state:'visible', timeout });
  if (!await locator.isVisible()) throw new Error(`${label} is not visible`);
}

async function requireWorkspaceReady(page, timeout) {
  const ready = page.locator('html[data-workspace-ui-ready="true"]');
  await requireCount(ready, 1, 'workspace UI ready marker');
  await ready.waitFor({ state:'attached', timeout });
}

function requireExactUrl(page, expectedUrl, label) {
  const actualUrl = new URL(page.url()).href;
  if (actualUrl !== expectedUrl) {
    throw new Error(`${label} URL mismatch: expected ${expectedUrl}, received ${actualUrl}`);
  }
}

async function assertRecommendationsWorkspace(page, expectedUrl, assertionTimeoutMs) {
  await requireWorkspaceReady(page, assertionTimeoutMs);
  requireExactUrl(page, expectedUrl, 'Recommendations workspace');
  const workspaceTabs = page.locator('.workspaceNavTab');
  await requireCount(workspaceTabs, 5, 'workspace navigation tabs');
  await requireExactTextList(
    workspaceTabs,
    ['資料', '今日建議', '訂單', 'SKU 決策樹', '資料分析'],
    'workspace navigation labels',
  );
  await requireVisible(
    page,
    '.workspaceNavTab[data-workspace="sku-tree"]',
    'SKU Decision Tree navigation tab',
    assertionTimeoutMs,
  );
  await requireVisible(
    page,
    '.workspaceNavTab[data-workspace="recommendations"][aria-selected="true"]',
    'Recommendations navigation tab',
    assertionTimeoutMs,
  );
  await requireVisible(
    page,
    '#decisionDashboard[data-workspace-panel="recommendations"]',
    'Recommendations panel',
    assertionTimeoutMs,
  );
  await requireVisible(
    page,
    '#todayWorkspaceSummary[data-workspace-panel="recommendations"]',
    'Merged Today summary',
    assertionTimeoutMs,
  );
  await requireCount(page.locator('.appSidebar'), 0, 'legacy app sidebar');
}

async function verifyBrowserAttempt({ browserType, urls, expectedRevision, navigationTimeoutMs, assertionTimeoutMs }) {
  const browser = await browserType.launch({ headless:true });
  try {
    const context = await browser.newContext({
      locale:'zh-TW',
      timezoneId:'Asia/Taipei',
      viewport:{ width:1280, height:900 },
    });
    const mutationRequests = [];
    context.on('request', request => {
      const method = request.method().toUpperCase();
      if (MUTATION_METHODS.has(method)) mutationRequests.push(`${method} ${request.url()}`);
    });
    try {
      const releaseResponse = await context.request.get(urls.releaseUrl, {
        headers:{ accept:'application/json', 'cache-control':'no-cache' },
        timeout:navigationTimeoutMs,
      });
      if (!releaseResponse.ok()) {
        throw new Error(`live release.json returned HTTP ${releaseResponse.status()}`);
      }
      const release = await releaseResponse.json();
      if (release?.revision !== expectedRevision) {
        throw new Error(`Live revision mismatch: expected ${expectedRevision}, received ${release?.revision || 'missing'}`);
      }

      const legacyPage = await context.newPage();
      await legacyPage.goto(urls.legacyPublicUrl, {
        waitUntil:'domcontentloaded',
        timeout:navigationTimeoutMs,
      });
      await assertRecommendationsWorkspace(legacyPage, urls.legacyCanonicalUrl, assertionTimeoutMs);

      const legacyTodayPage = await context.newPage();
      await legacyTodayPage.goto(urls.legacyTodayUrl, {
        waitUntil:'domcontentloaded',
        timeout:navigationTimeoutMs,
      });
      await assertRecommendationsWorkspace(legacyTodayPage, urls.legacyCanonicalUrl, assertionTimeoutMs);

      const canonicalPage = await context.newPage();
      await canonicalPage.goto(urls.canonicalPublicUrl, {
        waitUntil:'domcontentloaded',
        timeout:navigationTimeoutMs,
      });
      await assertRecommendationsWorkspace(canonicalPage, urls.canonicalPublicUrl, assertionTimeoutMs);

      const bossPage = await context.newPage();
      await bossPage.goto(urls.bossUrl, {
        waitUntil:'domcontentloaded',
        timeout:navigationTimeoutMs,
      });
      requireExactUrl(bossPage, urls.bossCanonicalUrl, 'Boss entrypoint');
      await requireVisible(bossPage, '#bossAuthGate:not([hidden])', 'Boss authentication gate', assertionTimeoutMs);
      await requireVisible(bossPage, '#bossLoginForm', 'Boss login form', assertionTimeoutMs);

      if (mutationRequests.length) {
        throw new Error(`Live browser smoke observed forbidden mutation request(s): ${mutationRequests.join(', ')}`);
      }
    } finally {
      await context.close();
    }
  } finally {
    await browser.close();
  }
}

export async function verifyLiveBrowserDeployment({
  baseUrl,
  expectedRevision,
  browserType,
  attempts = DEFAULT_LIVE_BROWSER_ATTEMPTS,
  retryDelayMs = DEFAULT_LIVE_BROWSER_RETRY_DELAY_MS,
  navigationTimeoutMs = DEFAULT_LIVE_BROWSER_NAVIGATION_TIMEOUT_MS,
  assertionTimeoutMs = DEFAULT_LIVE_BROWSER_ASSERTION_TIMEOUT_MS,
  wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
} = {}) {
  if (!browserType || typeof browserType.launch !== 'function') {
    throw new TypeError('browserType.launch must be a function');
  }
  if (typeof wait !== 'function') throw new TypeError('wait must be a function');
  const revision = requireRevision(expectedRevision);
  normalizeBaseUrl(baseUrl);
  const boundedAttempts = requireInteger(attempts, 'attempts', 1, 20);
  const boundedDelay = requireInteger(retryDelayMs, 'retryDelayMs', 0, 60_000);
  const boundedNavigationTimeout = requireInteger(navigationTimeoutMs, 'navigationTimeoutMs', 250, 120_000);
  const boundedAssertionTimeout = requireInteger(assertionTimeoutMs, 'assertionTimeoutMs', 250, 120_000);
  let lastError = null;

  for (let attempt = 1; attempt <= boundedAttempts; attempt += 1) {
    const urls = buildLiveBrowserUrls({ baseUrl, expectedRevision:revision, attempt });
    try {
      await verifyBrowserAttempt({
        browserType,
        urls,
        expectedRevision:revision,
        navigationTimeoutMs:boundedNavigationTimeout,
        assertionTimeoutMs:boundedAssertionTimeout,
      });
      return Object.freeze({
        ok:true,
        revision,
        attempts:attempt,
        publicUrl:new URL('./', normalizeBaseUrl(baseUrl)).href,
        bossUrl:new URL('Boss/', normalizeBaseUrl(baseUrl)).href,
      });
    } catch (error) {
      lastError = error;
      if (attempt < boundedAttempts) await wait(boundedDelay);
    }
  }

  throw new Error(
    `Live browser smoke failed after ${boundedAttempts} attempts: ${lastError?.message || 'unknown error'}`,
    { cause:lastError },
  );
}

function readOption(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

async function main() {
  const baseUrl = readOption('--base-url') || process.env.SUPPLY_LIVE_BASE_URL;
  const expectedRevision = readOption('--revision') || process.env.SUPPLY_EXPECTED_REVISION;
  const attempts = readOption('--attempts') || process.env.SUPPLY_LIVE_BROWSER_ATTEMPTS || DEFAULT_LIVE_BROWSER_ATTEMPTS;
  const retryDelayMs = readOption('--retry-delay-ms') || process.env.SUPPLY_LIVE_BROWSER_RETRY_DELAY_MS || DEFAULT_LIVE_BROWSER_RETRY_DELAY_MS;
  const navigationTimeoutMs = readOption('--navigation-timeout-ms') || process.env.SUPPLY_LIVE_BROWSER_NAVIGATION_TIMEOUT_MS || DEFAULT_LIVE_BROWSER_NAVIGATION_TIMEOUT_MS;
  const assertionTimeoutMs = readOption('--assertion-timeout-ms') || process.env.SUPPLY_LIVE_BROWSER_ASSERTION_TIMEOUT_MS || DEFAULT_LIVE_BROWSER_ASSERTION_TIMEOUT_MS;
  const { chromium } = await import('playwright');
  const result = await verifyLiveBrowserDeployment({
    baseUrl,
    expectedRevision,
    browserType:chromium,
    attempts,
    retryDelayMs,
    navigationTimeoutMs,
    assertionTimeoutMs,
  });
  console.log(`Verified live Supply browser revision ${result.revision} in ${result.attempts} attempt(s)`);
  console.log(`Entrypoints: ${result.publicUrl} ${result.bossUrl}`);
}

const isMain = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (isMain) main().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
