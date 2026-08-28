import assert from 'node:assert/strict';
import test from 'node:test';

import {
  APP_VERSION_TOKEN,
  formatAppVersion,
  parseUpdateCount,
  replaceAppVersionToken,
} from '../scripts/release-version.mjs';

test('ten first-parent updates form one major version step', () => {
  assert.equal(formatAppVersion(1), 'V0.1');
  assert.equal(formatAppVersion(9), 'V0.9');
  assert.equal(formatAppVersion(10), 'V1.0');
  assert.equal(formatAppVersion(15), 'V1.5');
  assert.equal(formatAppVersion(82), 'V8.2');
});

test('update count accepts only positive safe integers', () => {
  assert.equal(parseUpdateCount('15'), 15);
  for (const invalid of [undefined, '', '0', '-1', '1.5', 'version 15', Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parseUpdateCount(invalid), /positive/);
  }
});

test('each entrypoint must expose the same version in its title and visible heading', () => {
  const source = `<title>訂單分析器 ${APP_VERSION_TOKEN}</title><h1>訂單分析器 ${APP_VERSION_TOKEN}</h1>`;
  const rendered = replaceAppVersionToken(source, 'V1.5', 'index.html');
  assert.equal(rendered, '<title>訂單分析器 V1.5</title><h1>訂單分析器 V1.5</h1>');
  assert.doesNotMatch(rendered, new RegExp(APP_VERSION_TOKEN));
});

test('missing or extra HTML version placeholders fail the build contract', () => {
  assert.throws(() => replaceAppVersionToken('<h1>no token</h1>', 'V1.5', 'index.html'), /found 0/);
  assert.throws(() => replaceAppVersionToken(APP_VERSION_TOKEN, 'V1.5', 'index.html'), /found 1/);
  assert.throws(() => replaceAppVersionToken(APP_VERSION_TOKEN.repeat(3), 'V1.5', 'index.html'), /found 3/);
});
