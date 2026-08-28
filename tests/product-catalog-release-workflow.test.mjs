import assert from 'node:assert/strict';
import test from 'node:test';

import { createCatalogChangePlan } from '../catalog/catalog-change-plan.js';
import {
  assertReviewedPlan,
  resolveCatalogReleaseVersion,
  selectionsFromHandoff,
} from '../scripts/release-product-catalog.mjs';
import { createCatalogUpdateHandoff } from '../shared/catalog-update-handoff.mjs';

function packaging(version, unitsPerCarton) {
  return {
    version, effectiveFrom:'2026-08-28', effectiveTo:null,
    unitsPerCarton, cartonsPerPallet:42, cartonDimensionsCm:[50.8, 40.64, 30.48],
    grossWeightKg:null, grossWeightLb:29, orderUnit:{ kind:'single', units:1 },
  };
}

function catalog(version, unitsPerCarton = 24) {
  const packagingVersions = [packaging('2026-08-28.4', 24)];
  if (version !== '2026-08-28.4') packagingVersions.push(packaging(version, unitsPerCarton));
  return {
    schemaVersion:3,
    catalogVersion:version,
    products:[{
      productSku:'ABC01', productName:'Product', origin:'VN', standardFactory:'VN', lifecycle:'active',
      approvedOrderSkus:['ABC01'],
      newOrderPackagingDefaultVersion:version,
      packagingVersions,
    }],
    orderSkuAliases:[],
  };
}

test('the local release accepts only the exact signed plan evidence it regenerated', async () => {
  const before = catalog('2026-08-28.4');
  const candidate = catalog('2026-08-28.5', 30);
  const reviewed = await createCatalogChangePlan(before, candidate, {
    generatedAt:'2026-08-28T01:02:03.000Z',
  });
  const regenerated = await createCatalogChangePlan(before, candidate, {
    generatedAt:'2026-08-28T02:03:04.000Z',
  });

  await assert.doesNotReject(() => assertReviewedPlan(reviewed, regenerated));

  const tampered = structuredClone(reviewed);
  tampered.entries[0].fields[0].after = 'made-up-version';
  await assert.rejects(() => assertReviewedPlan(tampered, regenerated), /簽章不一致/);

  const differentCandidate = catalog('2026-08-28.5', 31);
  const differentPlan = await createCatalogChangePlan(before, differentCandidate, {
    generatedAt:'2026-08-28T01:02:03.000Z',
  });
  await assert.rejects(() => assertReviewedPlan(reviewed, differentPlan), /已變更/);
});

test('apply without --version uses the exact reviewed candidate version instead of the later clock day', () => {
  assert.equal(resolveCatalogReleaseVersion('2026-08-28.4', {
    reviewedPlan:{ candidate:{ catalogVersion:'2026-08-28.5' } },
    releaseDate:'2026-08-30',
  }), '2026-08-28.5');
  assert.equal(resolveCatalogReleaseVersion('2026-08-28.4', {
    releaseDate:'2026-08-29',
  }), '2026-08-29');
  assert.throws(() => resolveCatalogReleaseVersion('2026-08-28.4', {
    reviewedPlan:{ candidate:{ catalogVersion:'2026-08-28.3' } },
  }), /must be newer/);
});

test('a public Product Update Entry handoff can choose an exact subset but cannot change the reviewed plan', async () => {
  const before = catalog('2026-08-28.4');
  const candidate = catalog('2026-08-28.5', 30);
  const reviewed = await createCatalogChangePlan(before, candidate, {
    generatedAt:'2026-08-28T01:02:03.000Z',
  });
  const selectable = reviewed.entries.filter(entry => entry.selectable).map(entry => entry.id);
  const handoff = createCatalogUpdateHandoff(reviewed, selectable, {
    confirmedAt:'2026-08-28T03:04:05.000Z',
  });

  assert.deepEqual(selectionsFromHandoff(handoff, reviewed), selectable);

  const anotherPlan = await createCatalogChangePlan(before, catalog('2026-08-28.5', 31), {
    generatedAt:'2026-08-28T01:02:03.000Z',
  });
  assert.throws(() => selectionsFromHandoff(handoff, anotherPlan), /不屬於這份已審核計畫/);

  const tampered = structuredClone(handoff);
  tampered.selectedEntryIds = ['source-conflict:ABC01:1'];
  assert.throws(() => selectionsFromHandoff(tampered, reviewed), /not a selectable|不可套用|INVALID_SELECTION|不包含/i);
});
