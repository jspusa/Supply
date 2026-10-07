import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as draftApi from '../shared/order-draft-state.js';

function pageFunction(html, name) {
  const start = html.indexOf('    function ' + name + '(');
  assert.ok(start >= 0, name + ' must exist');
  const end = html.indexOf('\n    function ', start + 1);
  return html.slice(start, end).replace(/\n    window\.[\s\S]*/, '').trim();
}

for (const path of ['../index.html', '../Boss/index.html']) {
  test(path + ': bulk paste uses alias packaging, preserves existing quantities and rolls back failed saves', () => {
    const html = fs.readFileSync(new URL(path, import.meta.url), 'utf8');
    const names = ["checkPackageType","createGeneratorDraftRow","recalcValues","getOrderDraftQuantityFromValues","getPalletRecommendationWarning","addGeneratorBatchEntries"];
    const body = "\nconst api=window.SupplyOrderDraftState;\nconst products={\n PACK4:{productCode:'PACK4',country:'VN',perCarton:20,perPallet:24,perPack:4,boxSize:'50*40*30',packagingVersion:'2026-09-21'},\n TW01:{productCode:'TW01',country:'TW',perCarton:12,perPallet:30,boxSize:'50*40*30',packagingVersion:'2026-09-21'},\n VN01:{productCode:'VN01',country:'VN',perCarton:10,perPallet:24,boxSize:'50*40*30',packagingVersion:'2026-09-21'}\n};\nconst alias={orderSku:'7PACK4',canonicalProductSku:'PACK4',perCarton:40,perPallet:20,perPack:4,boxSize:'50*40*30',packagingVersion:'2026-09-21'};\nconst getCanonicalSku=s=>s==='7PACK4'?'PACK4':s;\nconst normalizeSkuKey=s=>String(s||'').trim().toUpperCase();\nconst getProductSpecByCode=s=>products[s]||null;\nconst getOrderDraftStateApi=()=>api;\nconst getGeneratorDraftContext=()=>({getProduct:getProductSpecByCode,getApprovedOrderSkus:s=>s==='PACK4'?['7PACK4']:[],getOrderSkuPackaging:s=>s==='7PACK4'?alias:null,catalogVersion:'2026-09-21',now:()=>new Date('2026-10-07')});\nlet generatorDraft=api.createOrderDraft({now:()=>new Date('2026-10-07')});\nlet currentOrderGroup='vietnam';\nconst saveGeneratorDraft=()=>true;\nlet persistOK=true;\nconst persistGeneratorDraft=()=>persistOK;\nconst renderActiveOrderGroup=()=>{};\nconst setActiveOrderGroup=s=>currentOrderGroup=s;\nconst getOrderGroupLabel=s=>s;\nconst first=addGeneratorBatchEntries([{sku:'7PACK4',quantity:400},{sku:'TW01',quantity:120},{sku:'VN01',quantity:null},{sku:'UNKNOWN',quantity:10}]);\nif(!first.ok||first.rejected!==1)throw Error('rejection report');\nif(generatorDraft.rowsByProductSku.PACK4.quantities.orderDraft!==100)throw Error('pack conversion');\nif(generatorDraft.rowsByProductSku.PACK4.quantities.cartons!==10)throw Error('alias carton');\nif(generatorDraft.rowsByProductSku.PACK4.orderGroup!=='subcontract')throw Error('alias group');\nif(generatorDraft.rowsByProductSku.TW01.orderGroup!=='taiwan')throw Error('TW group');\nconst quantityBefore=generatorDraft.rowsByProductSku.PACK4.quantities.packages;\naddGeneratorBatchEntries([{sku:'PACK4',quantity:20}]);\nif(generatorDraft.rowsByProductSku.PACK4.quantities.packages!==quantityBefore)throw Error('existing overwritten');\ngeneratorDraft=api.createOrderDraft({now:()=>new Date('2026-10-07')});persistOK=false;\nconst failed=addGeneratorBatchEntries([{sku:'VN01',quantity:100}]);\nif(failed.ok||Object.keys(generatorDraft.rowsByProductSku).length)throw Error('rollback failure');\nreturn {passed:6,first,packageUnits:100,aliasCartons:10};\n";
    const result = new Function('window', names.map(name => pageFunction(html, name)).join('\n') + '\n' + body)({ SupplyOrderDraftState:draftApi });
    assert.equal(result.passed, 6);
    assert.equal(result.packageUnits, 100);
    assert.equal(result.aliasCartons, 10);
  });
}
