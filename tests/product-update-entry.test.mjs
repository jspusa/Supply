import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createCatalogChangePlan } from '../catalog/catalog-change-plan.js';
import {
  createCatalogUpdateHandoff,
  validateCatalogUpdateHandoff,
} from '../shared/catalog-update-handoff.mjs';
import {
  catalogChangeDetailRows,
  validateCatalogChangePlanForReview,
} from '../shared/product-update-entry.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fbaRepo = path.resolve(process.env.FBA_REPO || path.join(root, '..', 'FBA'));

function packaging(version, overrides = {}) {
  return {
    version, effectiveFrom:'2026-08-28', effectiveTo:null,
    unitsPerCarton:24, cartonsPerPallet:42, cartonDimensionsCm:[50.8, 40.64, 30.48],
    grossWeightKg:null, grossWeightLb:29, orderUnit:{ kind:'single', units:1 },
    ...overrides,
  };
}

function catalog(version, { origin = 'VN', aliasUnits = 24 } = {}) {
  return {
    schemaVersion:3,
    catalogVersion:version,
    products:[{
      productSku:'ABC01', productName:'Product', origin, standardFactory:origin,
      lifecycle:'active', approvedOrderSkus:['ABC01', '7ABCD013AB'],
      newOrderPackagingDefaultVersion:'2026-08-28.4',
      packagingVersions:[packaging('2026-08-28.4')],
    }],
    orderSkuAliases:[{
      orderSku:'7ABCD013AB', canonicalProductSku:'ABC01', lifecycle:'approved',
      newOrderPackagingDefaultVersion:aliasUnits === 24 ? '2026-08-28.4' : version,
      packagingVersions:aliasUnits === 24
        ? [packaging('2026-08-28.4')]
        : [packaging('2026-08-28.4'), packaging(version, { unitsPerCarton:aliasUnits })],
    }],
  };
}

async function reviewPlan() {
  return createCatalogChangePlan(
    catalog('2026-08-28.4'),
    catalog('2026-08-28.5', { origin:'TW', aliasUnits:30 }),
    { generatedAt:'2026-08-28T10:00:00.000Z', sourceFile:'/private/raw-product.xlsx' },
  );
}

test('Product Update Entry verifies the exact signed plan and preserves risk defaults', async () => {
  const plan = await reviewPlan();
  const validated = await validateCatalogChangePlanForReview(plan, { cryptoRef:crypto.webcrypto });
  assert.equal(validated.entries.find(entry => entry.risk === 'safe').selected, true);
  assert.equal(validated.entries.find(entry => entry.risk === 'review').selected, false);

  const tampered = structuredClone(plan);
  tampered.entries.find(entry => entry.risk === 'safe').fields[0].after = 'tampered';
  await assert.rejects(
    () => validateCatalogChangePlanForReview(tampered, { cryptoRef:crypto.webcrypto }),
    error => error.code === 'PLAN_SIGNATURE_MISMATCH',
  );
});

test('selection handoff is compact, public-only, exact-shape, and contains one confirmed selection', async () => {
  const plan = await reviewPlan();
  const safeId = plan.entries.find(entry => entry.risk === 'safe').id;
  const handoff = createCatalogUpdateHandoff(plan, [safeId], { confirmedAt:'2026-08-28T10:30:00.000Z' });
  assert.deepEqual(Object.keys(handoff).sort(), [
    'baseline', 'candidate', 'confirmedAt', 'kind', 'planSha256', 'schemaVersion', 'selectedEntryIds',
  ]);
  assert.deepEqual(handoff.selectedEntryIds, [safeId]);
  const serialized = JSON.stringify(handoff);
  assert.doesNotMatch(serialized, /sourceFile|sourceRow|sourceSheet|before|after|raw-product\.xlsx|Users|private/);
  assert.deepEqual(validateCatalogUpdateHandoff(handoff), handoff);
  assert.throws(() => validateCatalogUpdateHandoff({ ...handoff, token:'nope' }), /unsupported shape/);
});

test('blocking conflicts cannot create a handoff and remain visible in detail evidence', async () => {
  const plan = await createCatalogChangePlan(
    catalog('2026-08-28.4'),
    catalog('2026-08-28.5', { aliasUnits:30 }),
    {
      generatedAt:'2026-08-28T10:00:00.000Z',
      conflicts:[{ sku:'ABC01', fields:[{ field:'unitsPerCarton', values:[
        { value:24, sourceSheet:'Products', sourceRow:2 },
        { value:30, sourceSheet:'Products', sourceRow:3 },
      ] }] }],
    },
  );
  const safeId = plan.entries.find(entry => entry.risk === 'safe').id;
  assert.throws(() => createCatalogUpdateHandoff(plan, [safeId]), error => error.code === 'BLOCKED_PLAN');
  const conflict = catalogChangeDetailRows(plan).find(row => row.risk === 'blocking');
  assert.match(conflict.source, /Products.*2.*Products.*3/);
  assert.equal(conflict.before, '24');
  assert.equal(conflict.after, '30');
});

test('both repositories ship byte-identical Product Update contracts and no browser persistence or publish path', () => {
  const pairs = [
    ['shared/catalog-update-handoff.mjs', 'catalog-update-handoff.mjs'],
    ['shared/catalog-affected-work.mjs', 'catalog-affected-work.mjs'],
    ['shared/catalog-update-baseline.js', 'catalog-update-baseline.js'],
    ['shared/catalog-update-change-plan.mjs', 'catalog-update-change-plan.mjs'],
    ['shared/catalog-update-overlay.mjs', 'catalog-update-overlay.mjs'],
    ['shared/catalog-update-planner.mjs', 'catalog-update-planner.mjs'],
    ['shared/catalog-update-product-catalog.mjs', 'catalog-update-product-catalog.mjs'],
    ['shared/catalog-update-release.mjs', 'catalog-update-release.mjs'],
    ['shared/catalog-update-runtime-lock.json', 'catalog-update-runtime-lock.json'],
    ['shared/product-update-entry.mjs', 'product-update-entry.mjs'],
    ['shared/product-update-entry.css', 'product-update-entry.css'],
  ];
  for (const [supply, fba] of pairs) {
    assert.equal(
      fs.readFileSync(path.resolve(root, supply), 'utf8'),
      fs.readFileSync(path.resolve(fbaRepo, fba), 'utf8'),
      supply,
    );
  }
  const source = fs.readFileSync(path.join(root, 'shared/product-update-entry.mjs'), 'utf8');
  assert.doesNotMatch(source, /(?:localStorage|sessionStorage)\.setItem|indexedDB|location\.(?:reload|href)|fetch\s*\(|github\.com\/repos/);
  assert.match(source, /cryptoRef\.subtle\.digest\('SHA-256'/);
});

test('detail impact adds only compact affected work identity and omits quantities', async () => {
  const plan = await reviewPlan();
  const entry = plan.entries.find(item => item.id === 'product:ABC01');
  const rows = catalogChangeDetailRows(plan, { affectedWork:{ entries:[{
    entryId:entry.id,
    affectedWork:[{
      productSku:'ABC01', orderSku:'7ABCD013AB', packagingVersion:'2026-08-28.4',
      packagingState:'pinned', orderGroup:'subcontract', quantity:12096, privateCost:'SECRET',
    }],
  }] } });
  const impact = rows.find(row => row.id === entry.id).impact;
  assert.match(impact, /訂單草稿 ABC01 → 7ABCD013AB/);
  assert.match(impact, /包裝 2026-08-28\.4.*已鎖定.*委外/);
  assert.doesNotMatch(impact, /12096|SECRET|quantity|privateCost/);
});

test('Supply public and Boss load the same no-reload Product Update Entry', () => {
  const pages = [
    { file:'index.html', prefix:'./shared/' },
    { file:'Boss/index.html', prefix:'../shared/' },
  ];
  for (const { file, prefix } of pages) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.match(source, new RegExp(`${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}product-update-entry\\.css`), file);
    assert.match(source, new RegExp(`${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}shared-product-catalog\\.js`), file);
    assert.match(source, new RegExp(`${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}catalog-update-baseline\\.js`), file);
    assert.match(source, /product-update-entry\.mjs" data-product-update-site="supply"/, file);
  }
});
