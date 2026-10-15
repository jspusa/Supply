import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { filterDiscontinuedEntries } from '../shared/discontinued-list-ui.js';

const root = new URL('../', import.meta.url);
const policySource = readFileSync(new URL('shared/discontinued-products.js', root), 'utf8');
const catalogSource = readFileSync(new URL('product-data.js', root), 'utf8');

// Independent transcription of the 2026-10-15 request, with duplicate SKU rows merged.
const requestedReasons = new Map([
  ['ACA01', '銷量不佳'],
  ['ACA02', '銷量不佳'],
  ['ACA03', '銷量不佳'],
  ['1ABRD001A0', '停小留大'],
  ['ASA01', '停小留大'],
  ['ATJ01', '停小留大'],
  ['ATN01', '停小留大'],
  ['ACTL08', '銷量不佳（維持停產）'],
  ['TPZL01', '銷量不佳'],
  ['1ABRD003A0', '停小留大'],
  ['TTRL03', '銷量不佳'],
  ['ADT03AM', '銷量不佳'],
  ['AFA135AM', '做工難＋留長版'],
  ['ADT03', '銷量不佳'],
  ['ABM01', '停小留大'],
  ['TPZ03AM-2', '銷量不佳（維持停產）'],
  ['TPZL03', '銷量不佳'],
  ['TPZL05', '銷量不佳（維持停產）'],
  ['TTR03AM', '銷量不佳'],
  ['TRPL01', '銷量超不佳'],
  ['ASF01', '停小留大'],
  ['ACTL05', '銷量不佳（維持停產）'],
  ['1GFTD061A0', '銷量不佳'],
  ['GTRL03', '銷量不佳'],
  ['1GSDD011A0', '停小留大（維持停產）'],
  ['1GCRD041A0', '停小留大'],
  ['1GCRD027A0', '改出2LB'],
  ['GCTL05', '銷量不佳'],
  ['1GBRD029A0', '留3LB'],
  ['1GBRD019A0', '出3LB版本'],
  ['GBB01', '停小留大'],
  ['GCTL06', '銷量不佳'],
  ['GBS03', '停小留大'],
  ['1GCRD017A0', '改出2LB'],
  ['GBS01', '停小留大'],
  ['1GCRD037A0', '改出2LB'],
  ['GTS03', '銷量不佳'],
  ['GTT03', '銷量不佳（維持停產）'],
  ['1GQRD027A0', '改出2LB'],
  ['1GQRD017A0', '留2LB（1GQRD016A0）'],
  ['1GFTD043A0', '停小留大'],
  ['1GFTD033A0', '停小留大'],
  ['1GCRD005A0', '停小留大'],
  ['GTC01', '維持停產'],
  ['HDS03AM', '銷量不佳'],
  ['HDR01AM', '銷量不佳'],
  ['HDP01AM', '銷量不佳'],
  ['VBB01', '銷量不佳'],
  ['VBS03', '銷量不佳'],
  ['VTB05-1', '銷量不佳'],
  ['VTB06-4', '銷量不佳+自我競爭'],
  ['VTR01-4', '委外不便＋自我競爭'],
  ['VBS01', '銷量不佳'],
  ['VBW01', '銷量不佳'],
]);
const requestedChewy = [
  'ATB03', 'ATP05', 'ATR03', '7ATRD013AB', 'ATP03', 'ATZ03',
  'ATZ01', 'ATS01', 'ATB01', 'ATB05', 'ATP01', 'ATR01',
];
const additionalDiscontinued = ['TRPL03', 'TRPL05', 'GSCL03'];
const requestedSpecial = ['AFML01', 'AFML03', 'AFML05', '1GXXD002A0', '1AXXD001A0', '1GXXD001A0'];

// Existing index.html policy before this change: items absent from the new request.
const retainedReasons = new Map([
  ['ASCL03', '銷量不佳'],
  ['ATJL01', '原料因素'],
  ['EZD010AM-3', '取消小包'],
  ['EZD020AM-3', '取消小包'],
  ['EZD040AM-3', '取消小包'],
  ['EZD050AM-3', '取消小包'],
  ['EZD060AM-3', '取消小包'],
  ['GCTL02', '銷量不佳'],
  ['GTCL01', '成本考量'],
  ['TPZ01AM-4', '銷量不佳'],
  ['TRP01AM-4', '銷量不佳'],
  ['TRP05AM', '銷量不佳'],
  ['TTR05AM', '銷量不佳'],
  ['TTR05AM-1', '銷量不佳'],
  ['TTRL01', '銷量不佳'],
  ['TTRL05', '銷量不佳'],
  ['VTS01-1', '委外生產'],
]);

function loadPolicy() {
  const context = vm.createContext({});
  context.window = context;
  vm.runInContext(policySource, context, { filename:'shared/discontinued-products.js' });
  return context;
}

test('the shared policy contains all 54 requested ordinary SKUs with their exact reasons', () => {
  const policy = loadPolicy().SupplyDiscontinuedProducts;
  assert.equal(requestedReasons.size, 54);
  for (const [sku, reason] of requestedReasons) {
    assert.equal(policy.isDiscontinued(sku), true, sku);
    assert.equal(policy.get(sku)?.reason, reason, sku);
    assert.equal(policy.get(sku)?.channel, 'discontinued', sku);
  }
  assert.notStrictEqual(policy.get('ADT03'), policy.get('ADT03AM'));
});

test('all 12 Chewy SKUs are explicitly labelled and excluded, including the final ATR01', () => {
  const policy = loadPolicy().SupplyDiscontinuedProducts;
  assert.equal(new Set(requestedChewy).size, 12);
  assert.deepEqual(
    Array.from(policy.entries).filter(entry => entry.channel === 'chewy').map(entry => entry.sku).sort(),
    requestedChewy.toSorted(),
  );
  for (const sku of requestedChewy) {
    assert.equal(policy.isDiscontinued(sku), true, sku);
    assert.equal(policy.get(sku)?.channel, 'chewy', sku);
    assert.match(policy.get(sku)?.reason, /Chewy.*本程式不下單/, sku);
  }
});

test('the follow-up stops three poor sellers without treating special products as forbidden orders', () => {
  const policy = loadPolicy().SupplyDiscontinuedProducts;
  for (const sku of additionalDiscontinued) {
    assert.equal(policy.isDiscontinued(sku), true, sku);
    assert.equal(policy.isReplenishmentSuppressed(sku), true, sku);
    assert.equal(policy.isSpecial(sku), false, sku);
    assert.equal(policy.get(sku)?.reason, '銷量不佳', sku);
    assert.equal(policy.get(sku)?.channel, 'discontinued', sku);
  }
  assert.deepEqual(
    Array.from(policy.entries).filter(entry => entry.channel === 'special').map(entry => entry.sku).sort(),
    requestedSpecial.toSorted(),
  );
  for (const sku of requestedSpecial) {
    assert.equal(policy.isDiscontinued(sku), false, `${sku} allows a manual order`);
    assert.equal(policy.isReplenishmentSuppressed(sku), true, `${sku} suppresses automatic reminders`);
    assert.equal(policy.isSpecial(sku), true, sku);
    assert.equal(policy.get(sku)?.channel, 'special', sku);
    assert.match(policy.get(sku)?.reason, /不提醒補貨.*可手動下單/, sku);
  }
  assert.equal(policy.isSpecial(' afml01 '), true);
  assert.equal(policy.isReplenishmentSuppressed(' 1gxxd002a0 '), true);
  assert.equal(policy.isReplenishmentSuppressed('1GXXD003A0'), false, 'do not infer unlisted XX identities');
});

test('list filters distinguish special products and make manual-order rules searchable', () => {
  const entries = Array.from(loadPolicy().SupplyDiscontinuedProducts.entries);
  assert.equal(filterDiscontinuedEntries(entries, { channel:'discontinued' }).length, 74);
  assert.equal(filterDiscontinuedEntries(entries, { channel:'chewy' }).length, 12);
  assert.equal(filterDiscontinuedEntries(entries, { channel:'special' }).length, 6);
  for (const query of ['特規品', '可手動下單']) {
    assert.deepEqual(filterDiscontinuedEntries(entries, { query }).map(entry => entry.sku).sort(), requestedSpecial.toSorted());
  }
  assert.deepEqual(filterDiscontinuedEntries(entries, { query:'afml', channel:'special' }).map(entry => entry.sku), ['AFML01', 'AFML03', 'AFML05']);
  assert.deepEqual(filterDiscontinuedEntries(entries, { query:'AFML01', channel:'discontinued' }), []);
});

test('the former policy remains intact outside the request and the combined list has no duplicates', () => {
  const policy = loadPolicy().SupplyDiscontinuedProducts;
  for (const [sku, reason] of retainedReasons) {
    assert.equal(policy.get(sku)?.reason, reason, sku);
    assert.equal(policy.get(sku)?.channel, 'discontinued', sku);
  }
  const expected = [...requestedReasons.keys(), ...requestedChewy, ...retainedReasons.keys(), ...additionalDiscontinued, ...requestedSpecial].sort();
  assert.equal(expected.length, 92);
  assert.deepEqual(Array.from(policy.entries, entry => entry.sku).sort(), expected);
  assert.equal(new Set(policy.entries.map(entry => entry.sku)).size, policy.entries.length);
});

test('exact normalized lookup does not stop the retained 2LB replacement or infer SKU suffixes', () => {
  const policy = loadPolicy().SupplyDiscontinuedProducts;
  assert.equal(policy.get('  aca01  ')?.sku, 'ACA01');
  assert.equal(policy.get(' atr01 ')?.channel, 'chewy');
  for (const sku of ['1GQRD016A0', 'ADT03AM-2', 'VTB05', 'UNKNOWN', '', null, undefined]) {
    assert.equal(policy.isDiscontinued(sku), false, String(sku));
    assert.equal(policy.isReplenishmentSuppressed(sku), false, String(sku));
    assert.equal(policy.isSpecial(sku), false, String(sku));
    assert.equal(policy.get(sku), null, String(sku));
  }
});

for (const page of ['index.html', 'Boss/index.html']) {
  test(`${page} loads the shared policy before use and respects only explicit catalog aliases`, () => {
    const html = readFileSync(new URL(page, root), 'utf8');
    const prefix = page.startsWith('Boss/') ? '../' : './';
    const script = `<script src="${prefix}shared/discontinued-products.js"></script>`;
    assert.equal(html.split(script).length - 1, 1, 'load the shared policy exactly once');
    assert.ok(html.indexOf(script) < html.indexOf('window.SupplyDiscontinuedProducts.entries'));

    // Exercise the real page resolver with the real generated catalog mapping.
    const context = loadPolicy();
    vm.runInContext(catalogSource, context, { filename:'product-data.js' });
    vm.runInContext(readFileSync(new URL('shared/sku-correspondence.js', root), 'utf8'), context);
    const normalize = html.match(/function normalizeSkuKey\(sku\)\s*\{[^\n]+\}/)?.[0];
    assert.ok(normalize, 'page exposes its normalizer');
    const start = html.indexOf('const equivalentSkuPairs');
    const end = html.indexOf('const hotSkuList', start);
    assert.ok(start >= 0 && end > start, 'page exposes the canonical policy resolver');
    vm.runInContext(`${normalize}\n${html.slice(start, end)}`, context, { filename:page });

    for (const [alias, canonical, channel] of [
      ['7GTRD037AB', 'GTRL03', 'discontinued'],
      ['7ATSD011AB', 'ATS01', 'chewy'],
      ['7ATRD013AB', 'ATR01', 'chewy'],
      ['7VTSD013AB', 'VTS01-1', 'discontinued'],
    ]) {
      assert.equal(context.getCanonicalSku(alias), canonical, alias);
      assert.equal(context.isDiscontinuedSku(alias), true, alias);
      assert.equal(context.getDiscontinuedEntry(alias)?.channel, channel, alias);
      assert.equal(context.getDiscontinuedReason(alias), context.getDiscontinuedReason(canonical), alias);
    }
    for (const sku of ['1GQRD016A0', '7GTSD013AB', '7ATSD019AB', 'ADT03AM-2']) {
      assert.equal(context.isDiscontinuedSku(sku), false, sku);
    }
    assert.equal(context.getDiscontinuedLabel('7ATSD011AB'), 'Chewy 專售');
  });
}
