import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyCatalogChangePlan,
  createCatalogChangePlan,
} from '../catalog/catalog-change-plan.js';
import { compileCatalog } from '../catalog/product-catalog.js';
import { supplyCatalogAdapter } from '../catalog/supply-catalog-adapter.js';
import {
  createCatalogUpdateHandoff,
  validateCatalogUpdateHandoff,
} from '../shared/catalog-update-handoff.mjs';
import {
  applyOrderDraftCommand,
  getPackagingAssignmentStatus,
  loadOrderDraft,
  PREVIOUS_ORDER_DRAFT_STORAGE_KEY,
  previewPackagingReassignment,
  projectOrderWorkbook,
  resolveOrderDraftRowPackaging,
} from '../shared/order-draft-state.js';

const OLD_VERSION = '2026-08-28.1';
const NEW_VERSION = '2026-08-29.1';
const NOW = '2026-08-29T01:02:03.000Z';
const ALIAS_SKU = '7ALS0001AB';

function packaging(version, unitsPerCarton, cartonsPerPallet = 40) {
  return {
    version,
    effectiveFrom:version.slice(0, 10),
    effectiveTo:null,
    unitsPerCarton,
    cartonsPerPallet,
    cartonDimensionsCm:[50, 40, 30],
    grossWeightKg:null,
    grossWeightLb:25,
    orderUnit:{ kind:'single', units:1 },
    source:{ sheet:'AMZ 所有SKU', row:8 },
  };
}

function product(productSku, { alias = false } = {}) {
  return {
    productSku,
    productName:`Product ${productSku}`,
    origin:'VN',
    standardFactory:'VN',
    lifecycle:'active',
    approvedOrderSkus:alias ? [productSku, ALIAS_SKU] : [productSku],
    newOrderPackagingDefaultVersion:OLD_VERSION,
    packagingVersions:[packaging(OLD_VERSION, 24)],
  };
}

function baseCatalog() {
  return {
    schemaVersion:3,
    catalogVersion:OLD_VERSION,
    products:[
      product('FLOAT01'),
      product('PIN01'),
      product('REVIEW01'),
      product('ALIAS01', { alias:true }),
      product('SKIP01'),
    ],
    orderSkuAliases:[{
      orderSku:ALIAS_SKU,
      canonicalProductSku:'ALIAS01',
      lifecycle:'approved',
      newOrderPackagingDefaultVersion:OLD_VERSION,
      packagingVersions:[packaging(OLD_VERSION, 20, 50)],
    }],
  };
}

function candidateCatalog() {
  const catalog = structuredClone(baseCatalog());
  catalog.catalogVersion = NEW_VERSION;
  for (const owner of catalog.products.filter(item => ['FLOAT01', 'PIN01', 'REVIEW01', 'SKIP01'].includes(item.productSku))) {
    owner.packagingVersions.push(packaging(NEW_VERSION, 30));
    owner.newOrderPackagingDefaultVersion = NEW_VERSION;
  }
  const alias = catalog.orderSkuAliases[0];
  alias.packagingVersions.push(packaging(NEW_VERSION, 25, 50));
  alias.newOrderPackagingDefaultVersion = NEW_VERSION;
  return catalog;
}

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem:key => values.has(key) ? values.get(key) : null,
    setItem:(key, value) => values.set(key, String(value)),
    removeItem:key => values.delete(key),
  };
}

function contextFor(projection) {
  const products = new Map(projection.products.map(item => [item.productCode, item]));
  const packaging = new Map(projection.orderSkuPackaging.map(item => [item.orderSku, item]));
  const approved = new Map(projection.products.map(item => [item.productCode, [item.productCode]]));
  for (const [productSku, orderSku] of projection.equivalentSkuPairs) {
    approved.set(productSku, [...(approved.get(productSku) || [productSku]), orderSku]);
  }
  return {
    now:NOW,
    catalogVersion:projection.meta.catalogVersion,
    getCatalogVersion:() => projection.meta.catalogVersion,
    getProduct:productSku => products.get(productSku) || null,
    getApprovedOrderSkus:productSku => approved.get(productSku) || [],
    getOrderSkuPackaging:orderSku => packaging.get(orderSku) || null,
    getCoverageDays:(_productSku, quantity) => Number(quantity) / 10,
  };
}

function touchedV2Draft() {
  return {
    schemaVersion:2,
    createdAt:NOW,
    updatedAt:NOW,
    rowsByProductSku:{
      REVIEW01:{
        productSku:'REVIEW01',
        orderSku:'REVIEW01',
        standardFactory:'vietnam',
        orderGroup:'vietnam',
        quantities:{ orderDraft:240, cartons:10 },
        pallet:{ value:0.25, mode:'manual' },
        locked:false,
        createdAt:NOW,
        updatedAt:NOW,
        issues:[],
      },
    },
    groupOrder:{ vietnam:['REVIEW01'], taiwan:[], subcontract:[] },
    repairOrder:[],
    issues:[],
  };
}

function upsert(draft, row, context) {
  const result = applyOrderDraftCommand(draft, { type:'upsert-row', row }, context);
  assert.equal(result.ok, true);
  return result.draft;
}

test('selected catalog update flows through Supply while floating, pinned, review, and alias rows retain their assignment rules at export', async () => {
  const before = baseCatalog();
  const candidate = candidateCatalog();
  const beforeProjection = compileCatalog(before, supplyCatalogAdapter);
  const beforeContext = contextFor(beforeProjection);

  const migrated = loadOrderDraft({
    storage:memoryStorage({ [PREVIOUS_ORDER_DRAFT_STORAGE_KEY]:JSON.stringify(touchedV2Draft()) }),
    context:beforeContext,
  });
  assert.equal(migrated.status, 'migrated');
  let draft = migrated.draft;
  draft = upsert(draft, {
    productSku:'FLOAT01',
    quantities:{ orderDraft:300 },
    pallet:{ value:0.25, mode:'whole-pallet' },
    pinPackaging:false,
  }, beforeContext);
  draft = upsert(draft, {
    productSku:'PIN01',
    quantities:{ orderDraft:240 },
    pallet:{ value:0.25, mode:'manual' },
    pinPackaging:false,
  }, beforeContext);
  draft = applyOrderDraftCommand(draft, {
    type:'patch-row',
    productSku:'PIN01',
    patch:{ quantities:{ orderDraft:240 } },
  }, beforeContext).draft;
  draft = upsert(draft, {
    productSku:'ALIAS01',
    quantities:{ orderDraft:200 },
    pallet:{ value:0.2, mode:'manual' },
    pinPackaging:false,
  }, beforeContext);
  draft = applyOrderDraftCommand(draft, {
    type:'switch-order-sku',
    productSku:'ALIAS01',
    orderSku:ALIAS_SKU,
  }, beforeContext).draft;

  const plan = await createCatalogChangePlan(before, candidate, {
    generatedAt:NOW,
    sourceFile:'/private/raw-product-information.xlsx',
  });
  const selectedEntryIds = [
    'product:FLOAT01',
    'product:PIN01',
    'product:REVIEW01',
    `order-sku-alias:${ALIAS_SKU}`,
  ];
  const handoff = validateCatalogUpdateHandoff(createCatalogUpdateHandoff(plan, selectedEntryIds, {
    confirmedAt:NOW,
  }));
  const applied = await applyCatalogChangePlan(before, candidate, plan, {
    selectedEntryIds:handoff.selectedEntryIds,
  });
  const appliedProjection = compileCatalog(applied.catalog, supplyCatalogAdapter);
  const currentContext = contextFor(appliedProjection);

  assert.deepEqual(applied.selectedEntryIds, selectedEntryIds);
  assert.equal(
    applied.catalog.products.find(item => item.productSku === 'SKIP01').newOrderPackagingDefaultVersion,
    OLD_VERSION,
    'an unselected safe change must not cross the handoff seam',
  );
  assert.equal(resolveOrderDraftRowPackaging(draft.rowsByProductSku.FLOAT01, currentContext).packagingVersion, NEW_VERSION);
  assert.deepEqual(
    getPackagingAssignmentStatus(draft.rowsByProductSku.PIN01, currentContext),
    {
      state:'pinned',
      assignedVersion:OLD_VERSION,
      currentVersion:NEW_VERSION,
      newerAvailable:true,
      reassignmentRecommended:true,
      reviewRequired:false,
      assigned:draft.rowsByProductSku.PIN01.packagingAssignment,
      current:{
        orderSku:'PIN01', canonicalProductSku:'PIN01', packagingVersion:NEW_VERSION,
        catalogVersion:NEW_VERSION, perCarton:30, perPack:null, perBox:null,
        perPallet:40, boxSize:'50*40*30', productName:'Product PIN01',
      },
    },
  );
  assert.equal(getPackagingAssignmentStatus(draft.rowsByProductSku.REVIEW01, currentContext).reviewRequired, true);
  assert.equal(getPackagingAssignmentStatus(draft.rowsByProductSku.REVIEW01, currentContext).newerAvailable, true);
  assert.equal(getPackagingAssignmentStatus(draft.rowsByProductSku.ALIAS01, currentContext).assignedVersion, OLD_VERSION);
  assert.equal(getPackagingAssignmentStatus(draft.rowsByProductSku.ALIAS01, currentContext).currentVersion, NEW_VERSION);
  assert.equal(projectOrderWorkbook(draft, currentContext).status, 'review-required');

  const preview = previewPackagingReassignment(draft, {
    productSku:'REVIEW01',
    orderSku:'REVIEW01',
  }, currentContext);
  assert.deepEqual({
    status:preview.status,
    beforeVersion:preview.before.packagingVersion,
    afterVersion:preview.after.packagingVersion,
    cartons:preview.after.cartons,
    pallets:preview.after.pallets,
    coverageDays:preview.after.coverageDays,
    orderGroup:preview.after.orderGroup,
  }, {
    status:'preview-ready',
    beforeVersion:OLD_VERSION,
    afterVersion:NEW_VERSION,
    cartons:8,
    pallets:0.2,
    coverageDays:24,
    orderGroup:'vietnam',
  });
  draft = applyOrderDraftCommand(draft, {
    type:'reassign-packaging',
    productSku:'REVIEW01',
    orderSku:'REVIEW01',
    expectedPackagingVersion:NEW_VERSION,
  }, currentContext).draft;

  const workbook = projectOrderWorkbook(draft, currentContext);
  assert.equal(workbook.ok, true);
  const exported = Object.fromEntries(workbook.sheets.flatMap(sheet => sheet.rows.map(row => [row[1], {
    sheet:sheet.name,
    perCarton:row[3],
    cartons:row[5],
    pallets:row[7],
  }])));
  assert.deepEqual(exported, {
    FLOAT01:{ sheet:'越南', perCarton:30, cartons:10, pallets:0.25 },
    PIN01:{ sheet:'越南', perCarton:24, cartons:10, pallets:0.25 },
    REVIEW01:{ sheet:'越南', perCarton:30, cartons:8, pallets:0.2 },
    [ALIAS_SKU]:{ sheet:'代工', perCarton:20, cartons:10, pallets:0.2 },
  });
  assert.equal(workbook.draft.rowsByProductSku.FLOAT01.packagingAssignment.packagingVersion, NEW_VERSION);
  assert.equal(workbook.draft.rowsByProductSku.PIN01.packagingAssignment.packagingVersion, OLD_VERSION);
  assert.equal(workbook.draft.rowsByProductSku.REVIEW01.packagingAssignment.packagingVersion, NEW_VERSION);
  assert.equal(workbook.draft.rowsByProductSku.ALIAS01.packagingAssignment.packagingVersion, OLD_VERSION);
});
