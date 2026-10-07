const MAX_ENTRIES = 500;
const SKU_HEADERS = new Set(['SKU', '品號', '產品編號', '品項編號', 'PRODUCTSKU', 'PRODUCTCODE']);
const QUANTITY_HEADERS = new Set(['數量', '包數', '實體包數', 'QUANTITY', 'QTY', 'PACKAGES']);
const headerKey = value => String(value || '').replace(/[\s_-]/g, '').toUpperCase();
const skuKey = value => String(value || '').trim().toUpperCase();
const validSku = value => /^[A-Z0-9][A-Z0-9_.-]*$/.test(value) && /[A-Z]/.test(value) && /\d/.test(value);

function splitDelimited(text, delimiter) {
  const cells = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (char === '"') {
      if (quoted && text[i + 1] === '"') { value += '"'; i += 1; }
      else quoted = !quoted;
    } else if (char === delimiter && !quoted) { cells.push(value.trim()); value = ''; }
    else value += char;
  }
  if (quoted) throw new Error('引號未成對，請重新複製完整儲存格');
  cells.push(value.trim());
  return cells;
}
function quantityValue(value) {
  if (!String(value ?? '').trim()) return null;
  const text = String(value).trim();
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(text)) throw new Error('數量請填正整數實體包數');
  const number = Number(text.replace(/,/g, ''));
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error('數量請填正整數實體包數');
  return number;
}

/** Parse clipboard rows without guessing column meaning or summing duplicates. */
export function parseOrderPaste(text) {
  const result = { entries:[], errors:[], duplicates:[] };
  const seen = new Set();
  let columns = null;
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r\n?|\n/);
  function add(skuValue, quantity, line) {
    const sku = skuKey(skuValue);
    if (!validSku(sku)) throw new Error('無法辨識 SKU：' + (sku || '空白'));
    if (seen.has(sku)) { if (!result.duplicates.includes(sku)) result.duplicates.push(sku); return; }
    if (result.entries.length >= MAX_ENTRIES) throw new Error('每次最多加入 500 個 SKU，請分批貼上');
    seen.add(sku);
    result.entries.push({ sku, quantity, line });
  }
  lines.forEach((raw, index) => {
    if (!raw.trim()) return;
    const line = index + 1;
    try {
      const delimiter = raw.includes('\t') ? '\t' : raw.includes(',') ? ',' : null;
      const cells = delimiter ? splitDelimited(raw, delimiter) : raw.trim().split(/[\s;，；、]+/);
      const keys = cells.map(headerKey);
      const skuColumn = keys.findIndex(key => SKU_HEADERS.has(key));
      if (skuColumn >= 0) {
        columns = { sku:skuColumn, quantity:keys.findIndex(key => QUANTITY_HEADERS.has(key)) };
        return;
      }
      if (columns) {
        add(cells[columns.sku], columns.quantity >= 0 ? quantityValue(cells[columns.quantity]) : null, line);
        return;
      }
      const nonempty = cells.filter(cell => cell.trim());
      if (nonempty.length && nonempty.every(cell => validSku(skuKey(cell)))) {
        nonempty.forEach(cell => add(cell, null, line));
        return;
      }
      if (cells.length === 2) {
        add(cells[0], quantityValue(cells[1]), line);
        return;
      }
      throw new Error('請貼上 SKU 清單，或使用「SKU、實體包數」兩欄（可含欄名）');
    } catch (error) {
      result.errors.push({ line, message:error.message });
    }
  });
  return result;
}

const DAY_MS = 86400000;
function calendarDay(date) {
  return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS;
}
export function formatDateInput(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) return '';
  return String(date.getFullYear()).padStart(4, '0') + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
}
export function leadTimeFromArrival(value, today = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '') || !Number.isFinite(today?.getTime?.())) return null;
  const [year, month, day] = value.split('-').map(Number);
  const arrival = new Date(year, month - 1, day);
  if (formatDateInput(arrival) !== value) return null;
  const days = calendarDay(arrival) - calendarDay(today);
  return Number.isInteger(days) && days >= 1 && days <= 365 ? days : null;
}
export function arrivalFromLeadTime(days, today = new Date()) {
  if (!Number.isInteger(days) || days < 1 || days > 365 || !Number.isFinite(today?.getTime?.())) return '';
  const date = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  date.setDate(date.getDate() + days);
  return formatDateInput(date);
}
if (typeof window !== 'undefined') window.SupplyWorkbenchInput = Object.freeze({ parseOrderPaste, formatDateInput, leadTimeFromArrival, arrivalFromLeadTime });
