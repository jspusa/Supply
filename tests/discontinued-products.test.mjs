import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { filterDiscontinuedEntries } from '../shared/discontinued-list-ui.js';

const root = new URL('../', import.meta.url);
const policySource = readFileSync(new URL('shared/discontinued-products.js', root), 'utf8');
const catalogSource = readFileSync(new URL('product-data.js', root), 'utf8');

// Independent transcription of the 2026-10-27 request, with duplicate SKU rows merged.
const requestedReasons = new Map([
  ['ACA01', '銷量不佳'],
  ['ACA02', '銷量不佳'],
  ['ACA03', '銷量不佳'],
  ['1ABRD001A0', '停小留大'],
  ['ASA01', '停小留大'],
  ['ATJ01', '停小留大'],
  ['ATN01', '停小留大'],
  ['ACTL08', '銷量不佳'],
  ['TPZL01', '銷量不佳'],
  ['1ABRD003A0', '停小留大'],
  ['TTRL03', '銷量不佳'],
  ['ABM01', '停小留大'],
  ['TPZ03AM-2', '銷量不佳'],
  ['TRPL01', '銷量超不佳'],
  ['ACTL05', '銷量不佳'],
  ['TRPL03', '銷量超不佳'],
  ['TPZL03', '銷量不佳'],
  ['TRPL05', '銷量超不佳'],
  ['TTR03AM', '銷量不佳'],
  ['TPZL05', '銷量不佳（維持停產）'],
  ['ASF01', '停小留大'],
  ['ACTL06', '銷量不佳＋毛利不佳'],
  ['ACTL09', '銷量不佳＋毛利不佳'],
  ['ADT03AM', '銷量不佳'],
  ['AFA135AM', '做工難＋留長版'],
  ['ADT03', '銷量不佳'],
  ['ASCL03', '銷量不佳'],
  ['TRP05AM', '銷量不佳'],
  ['TTR05AM', '銷量不佳'],
  ['TTR05AM-1', '銷量不佳'],
  ['TTRL01', '銷量不佳'],
  ['TTRL05', '銷量不佳'],
  ['1GSDD011A0', '停小留大（維持停產）'],
  ['GCTL05', '銷量不佳'],
  ['GTC01', '維持停產'],
  ['GBS01', '停小留大'],
  ['1GCRD017A0', '改出2LB'],
  ['1GCRD037A0', '改出2LB'],
  ['1GQRD017A0', '留2LB（1GQRD016A0）'],
  ['1GFTD033A0', '停小留大'],
  ['GSCL03', '銷量不佳'],
  ['GTRL03', '銷量不佳'],
  ['1GCRD027A0', '改出2LB'],
  ['1GBRD029A0', '留3LB'],
  ['1GBRD019A0', '出3LB版本'],
  ['GBB01', '停小留大'],
  ['GCTL06', '銷量不佳＋毛利不佳'],
  ['GBS03', '停小留大'],
  ['GTS03', '銷量不佳'],
  ['GTT03', '銷量不佳（維持停產）'],
  ['1GQRD027A0', '改出2LB'],
  ['1GFTD043A0', '停小留大'],
  ['1GCRD005A0', '停小留大'],
  ['1GCRD041A0', '停小留大'],
  ['1GFTD061A0', '銷量不佳'],
  ['HDS03AM', '銷量不佳'],
  ['HDR01AM', '銷量不佳'],
  ['HDP01AM', '銷量不佳'],
  ['VBB01', '銷量不佳'],
  ['VBS03', '銷量不佳'],
  ['VBS01', '銷量不佳'],
  ['VBW01', '銷量不佳'],
  ['VTB05-1', '銷量不佳'],
  ['VTB06-4', '銷量不佳'],
  ['VTR01-4', '委外生產'],
]);
const reactivatedSkus = ['AWD010', 'AWD011', 'AWD070', 'AWD071', 'GCTL02', 'TPZ01AM-4', 'TRP01AM-4'];
const requestedChewy = [
  'ATB03', 'ATP05', 'ATR03', '7ATRD013AB', 'ATP03', 'ATZ03',
  'ATZ01', 'ATS01', 'ATB01', 'ATB05', 'ATP01', 'ATR01',
];
const requestedSpecial = ['AFML01', 'AFML03', 'AFML05', '1GXXD002A0', '1AXXD001A0', '1GXXD001A0'];

// Earlier discontinued items not overridden or explicitly reactivated by this request.
const retainedReasons = new Map([
  ['ATJL01', '原料因素'],
  ['EZD010AM-3', '取消小包'],
  ['EZD020AM-3', '取消小包'],
  ['EZD040AM-3', '取消小包'],
  ['EZD050AM-3', '取消小包'],
  ['EZD060AM-3', '取消小包'],
  ['GTCL01', '成本考量'],
  ['VTS01-1', '委外生產'],
]);

function loadPolicy() {
  const context = vm.createContext({});
  context.window = context;
  vm.runInContext(policySource, context, { filename:'shared/discontinued-products.js' });
  return context;
}

test('the shared policy contains all 65 requested ordinary SKUs with their exact reasons', () => {
  const policy = loadPolicy().SupplyDiscontinuedProducts;
  assert.equal(requestedReasons.size, 65);
  for (const [sku, reason] of requestedReasons) {
    assert.equal(policy.isDiscontinued(sku), true, sku);
    assert.equal(policy.isReplenishmentSuppressed(sku), true, sku);
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

test('special products still suppress automatic reminders while allowing manual orders', () => {
  const policy = loadPolicy().SupplyDiscontinuedProducts;
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

test('all seven reactivated products are absent from the list and eligible for reminders and orders', () => {
  const policy = loadPolicy().SupplyDiscontinuedProducts;
  for (const sku of reactivatedSkus) {
    assert.equal(policy.get(sku), null, sku);
    assert.equal(policy.isDiscontinued(sku), false, sku);
    assert.equal(policy.isReplenishmentSuppressed(sku), false, sku);
    assert.equal(policy.isSpecial(sku), false, sku);
  }
});

test('list filters distinguish special products and make manual-order rules searchable', () => {
  const entries = Array.from(loadPolicy().SupplyDiscontinuedProducts.entries);
  assert.equal(filterDiscontinuedEntries(entries, { channel:'discontinued' }).length, 73);
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
  const expected = [...requestedReasons.keys(), ...requestedChewy, ...retainedReasons.keys(), ...requestedSpecial].sort();
  assert.equal(expected.length, 91);
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
    for (const sku of reactivatedSkus) {
      for (const identity of context.getEquivalentSkuGroup(sku) || [sku]) {
        assert.equal(context.isDiscontinuedSku(identity), false, identity);
        assert.equal(context.isReplenishmentSuppressed(identity), false, identity);
        assert.equal(context.getDiscontinuedEntry(identity), null, identity);
      }
    }
    assert.equal(context.getDiscontinuedLabel('7ATSD011AB'), 'Chewy 專售');
  });
}
