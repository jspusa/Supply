import { execFileSync } from 'node:child_process';

export const APP_VERSION_TOKEN = '__SUPPLY_APP_VERSION__';

export function parseUpdateCount(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+$/.test(text)) throw new Error(`Update count must be a positive integer, received: ${text || '(empty)'}`);
  const count = Number(text);
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new Error(`Update count must be a positive safe integer, received: ${text}`);
  }
  return count;
}

export function formatAppVersion(updateCount) {
  const count = parseUpdateCount(updateCount);
  return `V${Math.floor(count / 10)}.${count % 10}`;
}

export function replaceAppVersionToken(source, appVersion, sourceName = 'HTML source') {
  const occurrences = source.split(APP_VERSION_TOKEN).length - 1;
  if (occurrences !== 2) {
    throw new Error(`${sourceName} must contain exactly two ${APP_VERSION_TOKEN} placeholders; found ${occurrences}`);
  }
  return source.replaceAll(APP_VERSION_TOKEN, appVersion);
}

export function countFirstParentUpdates({ repoRoot, revision = 'HEAD' }) {
  const isShallow = execFileSync('git', ['rev-parse', '--is-shallow-repository'], {
    cwd:repoRoot,
    encoding:'utf8',
  }).trim();
  if (isShallow === 'true') {
    throw new Error('Cannot derive the app version from a shallow Git checkout. Fetch full history or pass --update-count.');
  }
  const count = execFileSync('git', ['rev-list', '--count', '--first-parent', revision], {
    cwd:repoRoot,
    encoding:'utf8',
  }).trim();
  return parseUpdateCount(count);
}
