import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOrderPaste, leadTimeFromArrival, arrivalFromLeadTime, formatDateInput } from '../shared/workbench-input.js';

test('horizontal and vertical SKU lists retain order and report duplicates', () => {
  const parsed = parseOrderPaste('KTB01AM-4\tGSCL01\nGSCL01\nACBL01');
  assert.deepEqual(parsed.entries.map(x => x.sku), ['KTB01AM-4','GSCL01','ACBL01']);
  assert.ok(parsed.entries.every(x => x.quantity === null));
  assert.deepEqual(parsed.duplicates, ['GSCL01']);
});
test('Excel headers and quoted CSV quantities preserve physical packages', () => {
  assert.equal(parseOrderPaste('SKU\t數量\nKTB01AM-4\t5400').entries[0].quantity, 5400);
  assert.equal(parseOrderPaste('SKU,包數\nKTB01AM-4,"5,400"').entries[0].quantity, 5400);
  assert.equal(parseOrderPaste('品名\t品號\t數量\n測試\tGSCL01\t1512').entries[0].quantity, 1512);
});
test('invalid quantities and unknown column shapes are explicitly rejected', () => {
  for (const text of ['GSCL01\t-1','GSCL01\t0','GSCL01\t1.5','GSCL01\tabc','GSCL01\t2\t3']) {
    const result = parseOrderPaste(text);
    assert.equal(result.entries.length, 0, text);
    assert.equal(result.errors.length, 1, text);
  }
});
test('calendar helpers cover year changes, leap days and invalid dates', () => {
  const today = new Date(2026,9,7,23,55);
  assert.equal(arrivalFromLeadTime(90, today), '2027-01-05');
  assert.equal(leadTimeFromArrival('2027-01-05', today), 90);
  assert.equal(leadTimeFromArrival('2026-10-07', today), null);
  assert.equal(leadTimeFromArrival('2026-02-30', today), null);
  assert.equal(leadTimeFromArrival('2028-02-29', new Date(2028,1,28)), 1);
  assert.equal(formatDateInput(new Date(2026,0,1,0,1)), '2026-01-01');
});
