import fs from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
const catalog=JSON.parse(fs.readFileSync(new URL('../catalog/product-catalog.json',import.meta.url),'utf8'));
const products=new Map(catalog.products.map(p=>[p.productSku,p]));
const expected={GTAL01:30,GTP03:90,GTB05:90,GTP05:90,GTSL01:24,GTRL01:22,GTPL01:24,GTBL01:26,GTCL01:28,GTRL03:28,GTPL03:24,GTBL03:28,GTPL05:24,GTBL05:24,ACTL08:28,ACTL09:36};
for(const [sku,count] of Object.entries(expected))test('approved name and unchanged carton count: '+sku,()=>{const p=products.get(sku);const v=p.packagingVersions.find(v=>v.version===p.newOrderPackagingDefaultVersion);const m=p.productName.match(/\d+(?:\.\d+)?\s*g\s*[x*\u00d7]\s*(\d+)(?=\s*(?:\)|$))/i);assert.ok(m);assert.equal(Number(m[1]),count);assert.equal(v.unitsPerCarton,count);});
test('approved spelling corrections',()=>{assert.match(products.get('GTB07').productName,/lollipop/);for(const sku of ['EPD021J','EPD041J','EPD061J','EPD020J','EPD040J','EPD060J']){assert.match(products.get(sku).productName,/Recipe/);assert.doesNotMatch(products.get(sku).productName,/Ricipe/);}});
