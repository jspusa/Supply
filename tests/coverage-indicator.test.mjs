import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCoverageMeterModel,
  renderCoverageMeter,
} from '../shared/coverage-indicator.js';

test('coverage meter owns the fixed 180 and 365 day health bands', () => {
  assert.equal(buildCoverageMeterModel({ coverageDays:179.9 }).band, 'low');
  assert.equal(buildCoverageMeterModel({ coverageDays:180 }).band, 'healthy');
  assert.equal(buildCoverageMeterModel({ coverageDays:365 }).band, 'healthy');
  assert.equal(buildCoverageMeterModel({ coverageDays:365.000000002 }).band, 'excess');
});

test('coverage meter preserves a numeric value and clamps only the visual fill', () => {
  const belowZero = buildCoverageMeterModel({ coverageDays:-12.5 });
  assert.equal(belowZero.band, 'low');
  assert.equal(belowZero.valueText, '-12.5 天');
  assert.equal(belowZero.fillPercent, 0);
  assert.equal(belowZero.meterValue, 0);

  const excess = buildCoverageMeterModel({ coverageDays:500 });
  assert.equal(excess.band, 'excess');
  assert.equal(excess.valueText, '500.0 天');
  assert.equal(excess.fillPercent, 100);
  assert.equal(excess.meterValue, 365);
});

test('coverage meter fill is proportional to days over the 365 day track', () => {
  const model = buildCoverageMeterModel({ coverageDays:180 });
  assert.ok(Math.abs(model.fillPercent - (180 / 365) * 100) < 1e-12);
  assert.equal(model.targetDays, 180);
  assert.equal(model.maximumDays, 365);
  assert.equal(Object.isFrozen(model), true);
});

test('unavailable assessment is neutral while retaining its finite value', () => {
  const model = buildCoverageMeterModel({ coverageDays:220, assessment:'unavailable' });
  assert.equal(model.band, 'neutral');
  assert.equal(model.valueText, '220.0 天');
  assert.equal(model.statusText, '資料未完整，不判色');
  assert.equal(model.fillPercent, (220 / 365) * 100);

  const html = renderCoverageMeter({ coverageDays:220, assessment:'unavailable' });
  assert.match(html, /coverageMeter--neutral/);
  assert.match(html, />220\.0 天</);
  assert.match(html, /資料未完整，不判色/);
  assert.match(html, /role="meter"/);
  assert.match(html, /aria-valuenow="220"/);
});

test('missing values render an explicit neutral no-data state without a fake meter value', () => {
  for (const coverageDays of [null, undefined, Number.NaN]) {
    const model = buildCoverageMeterModel({ coverageDays });
    assert.equal(model.band, 'neutral');
    assert.equal(model.hasValue, false);
    assert.equal(model.valueText, '—');
    assert.equal(model.statusText, '無資料');
  }

  const html = renderCoverageMeter({ coverageDays:null });
  assert.match(html, /coverageMeter--neutral/);
  assert.match(html, /aria-label="可售天數：無資料"/);
  assert.doesNotMatch(html, /role="meter"/);
  assert.doesNotMatch(html, /aria-valuenow=/);
});

test('rendered meter keeps numeric and status text alongside accessible meter semantics', () => {
  const healthy = renderCoverageMeter({ coverageDays:180 });
  assert.match(healthy, /class="coverageMeter coverageMeter--healthy"/);
  assert.match(healthy, /data-band="healthy"/);
  assert.match(healthy, />180\.0 天</);
  assert.match(healthy, />健康範圍 180–365 天</);
  assert.match(healthy, /role="meter"/);
  assert.match(healthy, /aria-valuemin="0"/);
  assert.match(healthy, /aria-valuemax="365"/);
  assert.match(healthy, /aria-valuenow="180"/);
  assert.match(healthy, /aria-valuetext="180\.0 天，健康範圍 180–365 天"/);
  assert.match(healthy, /--coverage-fill:49\.3151%/);

  const excess = renderCoverageMeter({ coverageDays:500 });
  assert.match(excess, /coverageMeter--excess/);
  assert.match(excess, />500\.0 天</);
  assert.match(excess, />超過 365 天</);
  assert.match(excess, /aria-valuenow="365"/);
  assert.match(excess, /aria-valuetext="500\.0 天，超過 365 天"/);
  assert.match(excess, /--coverage-fill:100%/);
});
