/* Product Update Entry. Keep Supply and FBA copies byte-identical. */
import { collectAffectedWork as collectLocalAffectedWork } from './catalog-affected-work.mjs';
import { createCatalogUpdateHandoff } from './catalog-update-handoff.mjs';
import {
  MAX_RAW_WORKBOOK_BYTES,
  planRawProductCatalogUpdate,
} from './catalog-update-planner.mjs';

const PLAN_KEYS = Object.freeze([
  'baseline', 'blockers', 'candidate', 'duplicateResolution', 'entries', 'generatedAt', 'planSha256',
  'schemaVersion', 'sourceFile', 'stats',
]);
const SNAPSHOT_KEYS = Object.freeze(['catalogVersion', 'sha256']);
const CATALOG_ENTRY_KEYS = Object.freeze([
  'after', 'before', 'changeType', 'entryType', 'evidence', 'fields', 'id',
  'kind', 'risk', 'selectable', 'selected', 'sku',
]);
const CONFLICT_ENTRY_KEYS = Object.freeze([
  'changeType', 'entryType', 'fields', 'id', 'kind', 'message', 'risk',
  'selectable', 'selected', 'sku',
]);
const CATALOG_FIELD_KEYS = Object.freeze(['after', 'before', 'field']);
const CONFLICT_FIELD_KEYS = Object.freeze(['field', 'values']);
const CONFLICT_VALUE_KEYS = Object.freeze(['sourceRow', 'sourceSheet', 'value']);
const EVIDENCE_KEYS = Object.freeze(['impact', 'sources']);
const SOURCE_KEYS = Object.freeze(['packagingVersion', 'row', 'sheet']);
const STATS_KEYS = Object.freeze([
  'added', 'aliasesAfter', 'aliasesBefore', 'blocking', 'changedEntries', 'productsAfter',
  'productsBefore', 'removed', 'review', 'safe', 'selected', 'updated',
]);
const CATALOG_VERSION = /^\d{4}-\d{2}-\d{2}(?:\.\d+)?$/;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_PLAN_BYTES = 5 * 1024 * 1024;
const SENSITIVE_KEY = /(?:authorization|cookie|github.?token|password|private.?key|secret)/i;

const RISK_COPY = Object.freeze({
  safe:{ title:'安全變更', hint:'已預先選取；可逐筆取消。', badge:'安全' },
  review:{ title:'需要確認', hint:'高風險欄位不會預選；請逐筆明確選取。', badge:'待確認' },
  blocking:{ title:'阻擋衝突', hint:'來源衝突或刪除不可選取，也不能略過。', badge:'阻擋' },
});
const FIELD_COPY = Object.freeze({
  approvedOrderSkus:'核准下單品號',
  canonicalProductSku:'產品品號',
  cartonDimensionsIn:'外箱尺寸（英吋）',
  cartonsPerPallet:'每棧板箱數',
  grossWeightLb:'毛重（磅）',
  lifecycle:'使用狀態',
  origin:'產地',
  packagingVersion:'包裝版本',
  packagingHistoryVersions:'歷史包裝版本',
  productName:'品名',
  standardFactory:'標準代工廠',
  unitsPerCarton:'每箱數量',
});
const IMPACT_COPY = Object.freeze({
  'catalog-availability-and-history':'產品可用狀態與歷史資料',
  'explicit-data-clear':'明確清空既有資料',
  'fba-carton-projection':'FBA 箱數與尺寸計算',
  'future-order-packaging':'未來訂單包裝',
  'new-public-catalog-entry':'新增公開產品資料',
  'order-workbook-routing':'訂單工作表分組',
  'sku-identity-mapping':'產品／下單品號對應',
  'supply-order-default':'Supply 新訂單預設',
});
const CLEAR_FIELD_COPY = Object.freeze({
  cartonDimensionsCm:'外箱尺寸',
  cartonsPerPallet:'每棧板箱數',
  grossWeightKg:'毛重（公斤）',
  grossWeightLb:'毛重（磅）',
  origin:'產地',
  standardFactory:'標準代工廠',
  unitsPerCarton:'每箱數量',
});

export class ProductUpdateEntryError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ProductUpdateEntryError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ProductUpdateEntryError(code, message);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function exactKeys(value, expected) {
  return isRecord(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  Object.values(value).forEach(deepFreeze);
  return value;
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
}

function stableJson(value) {
  return JSON.stringify(canonicalize(value));
}

function assertNoSensitiveKeys(value, depth = 0) {
  if (depth > 12) fail('PLAN_TOO_DEEP', 'Catalog Change Plan nesting is too deep');
  if (Array.isArray(value)) return value.forEach(item => assertNoSensitiveKeys(item, depth + 1));
  if (!isRecord(value)) return;
  for (const [key, child] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key)) fail('SENSITIVE_FIELD', 'Catalog Change Plan contains an unsupported sensitive field');
    assertNoSensitiveKeys(child, depth + 1);
  }
}

function timestamp(value, label) {
  const normalized = typeof value === 'string' ? value : '';
  if (Number.isNaN(Date.parse(normalized)) || new Date(normalized).toISOString() !== normalized) {
    fail('INVALID_TIMESTAMP', `${label} must be an exact ISO timestamp`);
  }
  return normalized;
}

function snapshot(value, label) {
  if (!exactKeys(value, SNAPSHOT_KEYS)) fail('INVALID_SNAPSHOT', `${label} has an unsupported shape`);
  const catalogVersion = String(value.catalogVersion || '');
  const sha256 = String(value.sha256 || '');
  if (!CATALOG_VERSION.test(catalogVersion) || !SHA256.test(sha256)) fail('INVALID_SNAPSHOT', `${label} is invalid`);
  return { catalogVersion, sha256 };
}

function finiteCount(value, label) {
  if (!Number.isInteger(value) || value < 0) fail('INVALID_STATS', `${label} must be a non-negative integer`);
  return value;
}

function jsonValue(value, label) {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined || encoded.length > 500000) fail('INVALID_VALUE', `${label} is too large`);
    return clone(value);
  } catch (_) {
    fail('INVALID_VALUE', `${label} is not JSON-safe`);
  }
}

function normalizeCatalogFields(value) {
  if (!Array.isArray(value)) fail('INVALID_FIELDS', 'Catalog change fields must be an array');
  return value.map((field, index) => {
    if (!exactKeys(field, CATALOG_FIELD_KEYS) || typeof field.field !== 'string' || !field.field.trim()) {
      fail('INVALID_FIELDS', `Catalog change field ${index + 1} is invalid`);
    }
    return { field:field.field.trim(), before:jsonValue(field.before, 'before'), after:jsonValue(field.after, 'after') };
  });
}

function normalizeConflictFields(value) {
  if (!Array.isArray(value) || !value.length) fail('INVALID_CONFLICT', 'Source conflict fields must be a non-empty array');
  return value.map((field, index) => {
    if (!exactKeys(field, CONFLICT_FIELD_KEYS) || typeof field.field !== 'string' || !Array.isArray(field.values) || field.values.length < 2) {
      fail('INVALID_CONFLICT', `Source conflict field ${index + 1} is invalid`);
    }
    return {
      field:field.field.trim(),
      values:field.values.map(item => {
        if (!exactKeys(item, CONFLICT_VALUE_KEYS)) fail('INVALID_CONFLICT', 'Source conflict evidence has an unsupported shape');
        const sourceRow = item.sourceRow === null ? null : Number(item.sourceRow);
        if (sourceRow !== null && (!Number.isInteger(sourceRow) || sourceRow < 1)) fail('INVALID_CONFLICT', 'Source conflict row is invalid');
        return {
          value:jsonValue(item.value, 'conflict value'),
          sourceSheet:String(item.sourceSheet || '').slice(0, 100),
          sourceRow,
        };
      }),
    };
  });
}

function normalizeEvidence(value) {
  if (!exactKeys(value, EVIDENCE_KEYS) || !Array.isArray(value.sources) || !Array.isArray(value.impact)) {
    fail('INVALID_EVIDENCE', 'Catalog change evidence has an unsupported shape');
  }
  return {
    sources:value.sources.map(source => {
      if (!exactKeys(source, SOURCE_KEYS)) fail('INVALID_EVIDENCE', 'Catalog change source has an unsupported shape');
      const row = source.row === null ? null : Number(source.row);
      if (row !== null && (!Number.isInteger(row) || row < 1)) fail('INVALID_EVIDENCE', 'Catalog change source row is invalid');
      return {
        sheet:String(source.sheet || '').slice(0, 100),
        row,
        packagingVersion:source.packagingVersion === null ? null : String(source.packagingVersion || '').slice(0, 80),
      };
    }),
    impact:value.impact.map(item => String(item || '').slice(0, 120)).filter(Boolean),
  };
}

function normalizeEntry(value, index) {
  if (!isRecord(value)) fail('INVALID_ENTRY', `Catalog Change Plan entry ${index + 1} is invalid`);
  const common = {
    id:String(value.id || '').trim(),
    kind:String(value.kind || ''),
    entryType:String(value.entryType || ''),
    sku:String(value.sku || '').trim().toUpperCase(),
    changeType:String(value.changeType || ''),
    risk:String(value.risk || ''),
    selectable:value.selectable === true,
    selected:value.selected === true,
  };
  if (!common.id || common.id.length > 300 || !common.sku || common.sku.length > 100) fail('INVALID_ENTRY', `Catalog Change Plan entry ${index + 1} identity is invalid`);
  if (!['safe', 'review', 'blocking'].includes(common.risk)) fail('INVALID_ENTRY', `${common.id} risk is invalid`);
  const expectedSelectable = common.risk !== 'blocking';
  const expectedSelected = common.risk === 'safe';
  if (common.selectable !== expectedSelectable || common.selected !== expectedSelected) {
    fail('INVALID_ENTRY_DEFAULT', `${common.id} selection default does not match its risk`);
  }
  if (common.kind === 'source-conflict') {
    if (!exactKeys(value, CONFLICT_ENTRY_KEYS) || common.risk !== 'blocking' || common.entryType !== 'source-conflict') {
      fail('INVALID_CONFLICT', `${common.id} source conflict is invalid`);
    }
    return { ...common, fields:normalizeConflictFields(value.fields), message:String(value.message || '').slice(0, 2000) };
  }
  if (common.kind !== 'catalog-change' || !exactKeys(value, CATALOG_ENTRY_KEYS) || !['product', 'order-sku-alias'].includes(common.entryType)) {
    fail('INVALID_ENTRY', `${common.id} catalog change has an unsupported shape`);
  }
  return {
    ...common,
    fields:normalizeCatalogFields(value.fields),
    before:jsonValue(value.before, 'entry before'),
    after:jsonValue(value.after, 'entry after'),
    evidence:normalizeEvidence(value.evidence),
  };
}

async function sha256(value, cryptoRef) {
  if (!cryptoRef?.subtle) fail('SHA256_UNAVAILABLE', 'SHA-256 verification is unavailable in this browser');
  const bytes = new TextEncoder().encode(typeof value === 'string' ? value : stableJson(value));
  const digest = await cryptoRef.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function validateCatalogChangePlanForReview(input, { cryptoRef = globalThis.crypto } = {}) {
  if (!exactKeys(input, PLAN_KEYS) || input.schemaVersion !== 1) fail('UNSUPPORTED_PLAN', 'Catalog Change Plan schema is unsupported');
  assertNoSensitiveKeys(input);
  if (typeof input.sourceFile !== 'string' || /[\\/]/.test(input.sourceFile) || input.sourceFile.length > 200) {
    fail('PRIVATE_SOURCE_PATH', 'Catalog Change Plan sourceFile must be a basename without a local path');
  }
  const entries = input.entries.map(normalizeEntry);
  if (entries.length > 10000) fail('PLAN_TOO_LARGE', 'Catalog Change Plan contains too many entries');
  if (new Set(entries.map(entry => entry.id)).size !== entries.length) fail('DUPLICATE_ENTRY', 'Catalog Change Plan entry ids must be unique');
  if (!exactKeys(input.stats, STATS_KEYS)) fail('INVALID_STATS', 'Catalog Change Plan stats have an unsupported shape');
  const stats = Object.fromEntries(STATS_KEYS.map(key => [key, finiteCount(input.stats[key], key)]));
  const counts = risk => entries.filter(entry => entry.risk === risk).length;
  const catalogChanges = entries.filter(entry => entry.kind === 'catalog-change').length;
  if (stats.safe !== counts('safe') || stats.review !== counts('review') || stats.blocking !== counts('blocking')
    || stats.selected !== counts('safe') || stats.changedEntries !== catalogChanges) {
    fail('STATS_MISMATCH', 'Catalog Change Plan stats do not match its entries');
  }
  if (!Array.isArray(input.blockers) || input.blockers.some(item => typeof item !== 'string' || !item.trim())) {
    fail('INVALID_BLOCKERS', 'Catalog Change Plan blockers are invalid');
  }
  if (entries.some(entry => entry.risk === 'blocking') && input.blockers.length === 0) {
    fail('MISSING_BLOCKER', 'Blocking Catalog Change Plan entries must have a blocker');
  }
  const normalized = {
    schemaVersion:1,
    generatedAt:timestamp(input.generatedAt, 'generatedAt'),
    sourceFile:input.sourceFile,
    baseline:snapshot(input.baseline, 'baseline'),
    candidate:snapshot(input.candidate, 'candidate'),
    duplicateResolution:jsonValue(input.duplicateResolution, 'duplicateResolution'),
    stats,
    blockers:input.blockers.map(item => item.trim()),
    entries,
    planSha256:String(input.planSha256 || ''),
  };
  if (!SHA256.test(normalized.planSha256)) fail('INVALID_PLAN_SIGNATURE', 'Catalog Change Plan signature is invalid');
  const unsigned = clone(input);
  delete unsigned.planSha256;
  if (await sha256(unsigned, cryptoRef) !== normalized.planSha256) {
    fail('PLAN_SIGNATURE_MISMATCH', 'Catalog Change Plan signature does not match its contents');
  }
  return deepFreeze(normalized);
}

function shown(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) {
    const separator = value.every(item => typeof item === 'number') ? ' × ' : '、';
    return value.map(shown).join(separator);
  }
  if (isRecord(value)) return JSON.stringify(value);
  return String(value);
}

function sourceText(source) {
  const parts = [];
  if (source.sheet) parts.push(source.sheet);
  if (source.row) parts.push(`第 ${source.row} 列`);
  if (source.packagingVersion) parts.push(`包裝 ${source.packagingVersion}`);
  return parts.join(' · ') || '變更計畫';
}

function workState(value) {
  return ({
    pinned:'已鎖定',
    'review-required':'待複查',
    'catalog-version':'目錄版本',
    'historical-imported':'歷史匯入',
    vietnam:'越南',
    taiwan:'台灣',
    subcontract:'委外',
  })[value] || value || '—';
}

function affectedWorkText(affectedWork, entryId, fallback) {
  const work = affectedWork?.entries?.find(item => item.entryId === entryId)?.affectedWork || [];
  if (!work.length) return fallback;
  const details = work.map(item => item.rowId
    ? `入庫列 ${item.rowId} · ${item.sku} · 包裝 ${item.packagingVersion || '待確認'} · ${workState(item.kind)}${item.reviewRequired ? ' · 待複查' : ''}`
    : `訂單草稿 ${item.productSku} → ${item.orderSku} · 包裝 ${item.packagingVersion || '待確認'} · ${workState(item.packagingState)} · ${workState(item.orderGroup)}`);
  return `${fallback}；既有工作：${details.join('；')}`;
}

export function catalogChangeDetailRows(plan, { affectedWork = null } = {}) {
  return plan.entries.flatMap(entry => {
    const identity = entry.entryType === 'product' ? 'Product SKU' : entry.entryType === 'order-sku-alias' ? 'Order SKU' : '來源衝突';
    if (entry.kind === 'source-conflict') {
      return entry.fields.map(field => ({
        id:entry.id,
        identity,
        sku:entry.sku,
        risk:entry.risk,
        field:FIELD_COPY[field.field] || field.field,
        source:field.values.map(value => sourceText({ sheet:value.sourceSheet, row:value.sourceRow })).join(' / '),
        before:shown(field.values[0]?.value),
        after:field.values.slice(1).map(value => shown(value.value)).join(' / '),
        impact:'來源值互相衝突，整次發布停止',
      }));
    }
    const source = entry.evidence.sources.map(sourceText).join(' / ') || '變更計畫';
    const impact = entry.evidence.impact.map(item => IMPACT_COPY[item] || item).join('、') || '無額外工作影響';
    return entry.fields.map(field => ({
      id:entry.id,
      identity,
      sku:entry.sku,
      risk:entry.risk,
      field:FIELD_COPY[field.field] || field.field,
      source,
      before:shown(field.before),
      after:shown(field.after),
      impact:affectedWorkText(affectedWork, entry.id, impact),
    }));
  });
}

function element(documentRef, tag, className, text) {
  const node = documentRef.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function alignmentStatus(rootRef, site) {
  const runtime = rootRef?.JSPCatalogAlignmentRuntime?.controller?.getLastStatus?.();
  if (runtime) return runtime;
  try {
    return rootRef?.JSPCatalogAlignmentUI?.readPersistedStatus?.(rootRef.localStorage, site) || null;
  } catch (_) {
    return null;
  }
}

function alignmentCopy(status) {
  if (status?.state === 'failed') return '產品資料尚未對齊；請先用頁首既有的 Catalog Alignment 恢復流程。';
  if (status?.state === 'aligned') return `Catalog Alignment 已對齊${status.catalogVersion ? `（${status.catalogVersion}）` : ''}。`;
  return 'Catalog Alignment 會由既有狀態與本機發布流程再次驗證。';
}

function defaultSaveJson(value, filename, { documentRef, rootRef }) {
  const blob = new Blob([`${JSON.stringify(value, null, 2)}\n`], { type:'application/json' });
  const url = rootRef.URL.createObjectURL(blob);
  const anchor = documentRef.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.hidden = true;
  documentRef.body.append(anchor);
  anchor.click();
  anchor.remove();
  rootRef.setTimeout(() => rootRef.URL.revokeObjectURL(url), 0);
}

function defaultSaveHandoff(handoff, refs) {
  defaultSaveJson(handoff, `catalog-update-selection-${handoff.candidate.catalogVersion}.json`, refs);
}

function defaultSavePlan(plan, refs) {
  defaultSaveJson(plan, `catalog-change-plan-${plan.candidate.catalogVersion}.json`, refs);
}

function dialogMarkup() {
  return `<div class="product-update-dialog-shell">
    <header class="product-update-dialog-header">
      <div><p>Product Update Entry</p><h2 id="productUpdateTitle">產品資料更新</h2></div>
      <button type="button" class="product-update-icon-button" data-product-update-close aria-label="關閉產品資料更新">×</button>
    </header>
    <div class="product-update-dialog-body">
      <section class="product-update-intro">
        <strong>直接選擇平常維護的產品資訊 Excel</strong>
        <p>Excel 只會在這個分頁的記憶體中解析，用 Supply 內建基準建立簽章變更計畫；不會保存原始 Excel、GitHub 憑證，也不會直接發布。重新整理後即清除。</p>
        <label class="product-update-file-action">選擇原始產品資訊 Excel<input type="file" accept=".xlsx,.xlsm,.xls" data-product-update-raw-file></label>
        <details class="product-update-advanced">
          <summary>進階／恢復：匯入已簽章的變更計畫</summary>
          <p>只有已在本機產生過 Catalog Change Plan JSON 時才需要使用。</p>
          <label class="product-update-file-action product-update-file-action-secondary">選擇 Catalog Change Plan JSON<input type="file" accept=".json,application/json" data-product-update-file></label>
        </details>
      </section>
      <div class="product-update-message" data-product-update-message role="status" aria-live="polite">尚未載入變更計畫。</div>
      <section class="product-update-plan" data-product-update-plan hidden>
        <div class="product-update-plan-heading">
          <div><span>基準版本</span><strong data-product-update-versions></strong></div>
          <div class="product-update-selection-summary" data-product-update-summary></div>
        </div>
        <div class="product-update-alignment" data-product-update-alignment></div>
        <details class="product-update-clears" data-product-update-clears hidden>
          <summary>明確清空空白欄位 <b data-product-update-clear-count>0</b></summary>
          <p>普通 Excel 空白會保留既有資料。只有勾選下面欄位，才會把它列為高風險清空並重新簽章。</p>
          <div data-product-update-clear-list></div>
        </details>
        <div class="product-update-lanes" data-product-update-lanes></div>
        <details class="product-update-details">
          <summary>展開完整欄位明細</summary>
          <div class="product-update-table-wrap">
            <table>
              <caption class="product-update-sr-only">Catalog Change Detail Table</caption>
              <thead><tr><th>Product / Order SKU</th><th>風險</th><th>欄位</th><th>來源</th><th>原值</th><th>新值</th><th>影響工作</th></tr></thead>
              <tbody data-product-update-detail-rows></tbody>
            </table>
          </div>
        </details>
      </section>
    </div>
    <footer class="product-update-dialog-footer">
      <span>請下載簽章計畫與 compact 交接檔；本機套用時會重新核對 canonical baseline 與同一份原始 Excel。</span>
      <button type="button" data-product-update-save-plan disabled>下載簽章計畫</button>
      <button type="button" class="product-update-primary" data-product-update-prepare disabled>準備交接檔</button>
    </footer>
    <section class="product-update-confirm" data-product-update-confirm role="alertdialog" aria-modal="true" aria-labelledby="productUpdateConfirmTitle" hidden>
      <div class="product-update-confirm-card">
        <p class="product-update-kicker">最後一次確認</p>
        <h3 id="productUpdateConfirmTitle">下載已選變更的交接檔？</h3>
        <p data-product-update-confirm-copy></p>
        <div class="product-update-confirm-actions">
          <button type="button" data-product-update-confirm-cancel>返回檢查</button>
          <button type="button" class="product-update-primary" data-product-update-confirm-accept>確認並下載交接檔</button>
        </div>
      </div>
    </section>
  </div>`;
}

function laneNode(documentRef, risk, entries, selected, onChange) {
  const section = element(documentRef, 'section', 'product-update-lane');
  section.dataset.risk = risk;
  const heading = element(documentRef, 'div', 'product-update-lane-heading');
  const title = element(documentRef, 'div');
  title.append(element(documentRef, 'strong', '', RISK_COPY[risk].title), element(documentRef, 'span', '', RISK_COPY[risk].hint));
  heading.append(title, element(documentRef, 'b', '', String(entries.length)));
  section.append(heading);
  const list = element(documentRef, 'div', 'product-update-lane-list');
  if (!entries.length) list.append(element(documentRef, 'p', 'product-update-empty', '這一類目前沒有變更。'));
  for (const entry of entries) {
    const label = element(documentRef, 'label', 'product-update-entry-row');
    const input = element(documentRef, 'input');
    input.type = 'checkbox';
    input.checked = selected.has(entry.id);
    input.disabled = !entry.selectable;
    input.dataset.entryId = entry.id;
    input.addEventListener('change', () => onChange(entry, input.checked));
    const copy = element(documentRef, 'span', 'product-update-entry-copy');
    const top = element(documentRef, 'span', 'product-update-entry-top');
    const identity = entry.entryType === 'product' ? 'Product SKU' : entry.entryType === 'order-sku-alias' ? 'Order SKU' : '衝突';
    top.append(element(documentRef, 'strong', '', entry.sku), element(documentRef, 'em', '', identity));
    const fields = entry.fields.map(field => FIELD_COPY[field.field] || field.field);
    const summary = entry.kind === 'source-conflict'
      ? entry.message
      : `${fields.slice(0, 2).join('、')}${fields.length > 2 ? ` 等 ${fields.length} 個欄位` : ''}`;
    copy.append(top, element(documentRef, 'span', 'product-update-entry-detail', summary));
    label.append(input, copy, element(documentRef, 'span', 'product-update-risk-badge', RISK_COPY[risk].badge));
    list.append(label);
  }
  section.append(list);
  return section;
}

function renderDetailTable(documentRef, tbody, rows) {
  tbody.innerHTML = '';
  for (const row of rows) {
    const tr = element(documentRef, 'tr');
    tr.dataset.risk = row.risk;
    const values = [`${row.identity}\n${row.sku}`, RISK_COPY[row.risk].badge, row.field, row.source, row.before, row.after, row.impact];
    values.forEach((value, index) => {
      const cell = element(documentRef, 'td', index === 0 ? 'product-update-identity-cell' : '', value);
      tr.append(cell);
    });
    tbody.append(tr);
  }
}

function focusable(container) {
  return [...container.querySelectorAll('button:not([disabled]),input:not([disabled]),summary,[href],[tabindex]:not([tabindex="-1"])')]
    .filter(node => !node.closest('[hidden],[aria-hidden="true"]'));
}

export function createProductUpdateEntry({
  site,
  documentRef = globalThis.document,
  rootRef = globalThis.window,
  now = () => new Date().toISOString(),
  saveHandoff = null,
  savePlan = null,
  collectAffectedWork = collectLocalAffectedWork,
} = {}) {
  if (!['supply', 'fba'].includes(site)) fail('INVALID_SITE', 'Product Update Entry site must be supply or fba');
  if (!documentRef?.createElement || !rootRef) fail('BROWSER_REQUIRED', 'Product Update Entry requires a browser document');
  if (typeof now !== 'function') fail('INVALID_CLOCK', 'Product Update Entry now must be a function');
  let trigger = null;
  let dialog = null;
  let plan = null;
  let selected = new Set();
  let rawWorkbookState = null;
  let clearCandidates = [];
  let explicitClears = new Map();
  let planningSequence = 0;
  let lastFocus = null;

  const query = selector => dialog.querySelector(selector);
  const message = (text, state = 'neutral') => {
    const target = query('[data-product-update-message]');
    target.textContent = text;
    target.dataset.state = state;
  };

  function resetPlanState() {
    plan = null;
    selected = new Set();
    rawWorkbookState = null;
    clearCandidates = [];
    explicitClears = new Map();
    planningSequence += 1;
    query('[data-product-update-plan]').hidden = true;
    query('[data-product-update-save-plan]').disabled = true;
    query('[data-product-update-prepare]').disabled = true;
  }

  function currentAlignment() {
    return alignmentStatus(rootRef, site);
  }

  function renderAlignment() {
    const status = currentAlignment();
    const target = query('[data-product-update-alignment]');
    target.dataset.state = status?.state || 'pending';
    target.textContent = alignmentCopy(status);
    return status;
  }

  function releaseBlocked() {
    return Boolean(plan?.blockers?.length || plan?.entries?.some(entry => entry.risk === 'blocking'));
  }

  function renderSelection() {
    if (!plan) return;
    const safe = plan.entries.filter(entry => entry.risk === 'safe' && selected.has(entry.id)).length;
    const review = plan.entries.filter(entry => entry.risk === 'review' && selected.has(entry.id)).length;
    query('[data-product-update-summary]').textContent = `已選 ${selected.size} 筆（安全 ${safe}、明確確認 ${review}）`;
    const alignment = renderAlignment();
    const prepare = query('[data-product-update-prepare]');
    prepare.disabled = selected.size === 0 || releaseBlocked() || alignment?.state === 'failed';
  }

  function toggle(entry, checked) {
    if (!entry.selectable || entry.risk === 'blocking') return;
    if (checked) selected.add(entry.id);
    else selected.delete(entry.id);
    renderSelection();
  }

  function renderPlan() {
    const planSection = query('[data-product-update-plan]');
    planSection.hidden = false;
    query('[data-product-update-versions]').textContent = `${plan.baseline.catalogVersion} → ${plan.candidate.catalogVersion}`;
    const lanes = query('[data-product-update-lanes]');
    lanes.innerHTML = '';
    for (const risk of ['safe', 'review', 'blocking']) {
      lanes.append(laneNode(documentRef, risk, plan.entries.filter(entry => entry.risk === risk), selected, toggle));
    }
    let affectedWork = null;
    try {
      affectedWork = typeof collectAffectedWork === 'function'
        ? collectAffectedWork({ site, storage:rootRef.localStorage, plan })
        : null;
    } catch (_) {
      affectedWork = null;
    }
    renderDetailTable(documentRef, query('[data-product-update-detail-rows]'), catalogChangeDetailRows(plan, { affectedWork }));
    if (releaseBlocked()) {
      message(`計畫有 ${plan.stats.blocking} 筆阻擋衝突，無法產生交接檔。請回到原始 Excel 解決完再重新產生計畫。`, 'error');
    } else {
      message('已驗證計畫簽章。安全變更已預選，高風險變更等待你明確選取。', 'success');
    }
    renderSelection();
  }

  function renderClearControls() {
    const section = query('[data-product-update-clears]');
    const list = query('[data-product-update-clear-list]');
    list.innerHTML = '';
    section.hidden = !rawWorkbookState || clearCandidates.length === 0;
    if (section.hidden) return;
    let checkedCount = 0;
    for (const candidate of clearCandidates) {
      const group = element(documentRef, 'section', 'product-update-clear-group');
      group.append(element(documentRef, 'strong', '', candidate.sku));
      const fields = element(documentRef, 'div', 'product-update-clear-fields');
      for (const item of candidate.fields) {
        const label = element(documentRef, 'label', 'product-update-clear-option');
        const input = element(documentRef, 'input');
        input.type = 'checkbox';
        input.dataset.clearSku = candidate.sku;
        input.dataset.clearField = item.field;
        input.checked = explicitClears.get(candidate.sku)?.has(item.field) || false;
        if (input.checked) checkedCount += 1;
        input.addEventListener('change', async () => {
          input.disabled = true;
          try { await setExplicitClear(candidate.sku, item.field, input.checked); }
          catch (error) { message(error?.message || '無法重建明確清空計畫。', 'error'); renderClearControls(); }
        });
        const copy = element(documentRef, 'span');
        copy.append(
          element(documentRef, 'b', '', CLEAR_FIELD_COPY[item.field] || item.field),
          element(documentRef, 'small', '', `目前 ${shown(item.before)} → 明確清空`),
        );
        label.append(input, copy);
        fields.append(label);
      }
      group.append(fields);
      list.append(group);
    }
    query('[data-product-update-clear-count]').textContent = String(checkedCount);
  }

  async function loadPlan(input, { preserveRaw = false } = {}) {
    plan = await validateCatalogChangePlanForReview(input, { cryptoRef:rootRef.crypto || globalThis.crypto });
    if (!preserveRaw) {
      rawWorkbookState = null;
      clearCandidates = [];
      explicitClears = new Map();
    }
    selected = new Set(plan.entries.filter(entry => entry.selected && entry.selectable).map(entry => entry.id));
    query('[data-product-update-save-plan]').disabled = false;
    renderPlan();
    renderClearControls();
    return plan;
  }

  function clearSelectionPayload() {
    return [...explicitClears].map(([sku, fields]) => ({ sku, fields:[...fields] }));
  }

  async function rebuildRawPlan() {
    if (!rawWorkbookState) fail('RAW_WORKBOOK_MISSING', '請重新選擇原始產品資訊 Excel');
    const sequence = ++planningSequence;
    const result = await planRawProductCatalogUpdate({
      ...rawWorkbookState,
      explicitClears:clearSelectionPayload(),
    });
    if (sequence !== planningSequence) return null;
    clearCandidates = result.clearCandidates;
    await loadPlan(result.plan, { preserveRaw:true });
    renderClearControls();
    return result;
  }

  async function loadRawWorkbook(file, options = {}) {
    if (!file) return null;
    if (Number(file.size) > MAX_RAW_WORKBOOK_BYTES) fail('WORKBOOK_TOO_LARGE', '產品資訊 Excel 超過 32 MB');
    rawWorkbookState = {
      workbookData:await file.arrayBuffer(),
      sourceFile:file.name,
      baselineCatalog:options.baselineCatalog || rootRef.JSPCatalogUpdateBaseline,
      xlsxRef:options.xlsxRef || rootRef.XLSX,
      rawCatalogApi:options.rawCatalogApi || rootRef.JSPSharedProductCatalog,
      generatedAt:options.generatedAt || now(),
      candidateVersion:options.candidateVersion || null,
    };
    explicitClears = new Map();
    const result = await rebuildRawPlan();
    if (!releaseBlocked()) {
      message(`已在記憶體解析 ${result.importStats.rawRecords} 筆原始資料並建立簽章計畫；安全變更已預選，高風險變更等待你確認。`, 'success');
    }
    return result;
  }

  async function setExplicitClear(skuInput, field, checked) {
    if (!rawWorkbookState) fail('RAW_WORKBOOK_MISSING', '明確清空只適用於本次選擇的原始 Excel');
    const sku = String(skuInput || '').trim().toUpperCase();
    const allowed = clearCandidates.some(candidate => candidate.sku === sku && candidate.fields.some(item => item.field === field));
    if (!allowed) fail('INVALID_EXPLICIT_CLEAR', `${sku}.${field} 不是可明確清空的空白來源欄位`);
    const before = new Map([...explicitClears].map(([key, fields]) => [key, new Set(fields)]));
    const fields = new Set(explicitClears.get(sku) || []);
    if (checked) fields.add(field);
    else fields.delete(field);
    if (fields.size) explicitClears.set(sku, fields);
    else explicitClears.delete(sku);
    message('正在依照明確清空選擇重新建立並簽章計畫…', 'neutral');
    try {
      const result = await rebuildRawPlan();
      if (result && !releaseBlocked()) message('明確清空已列為高風險且不預選；請重新檢查變更。', 'success');
      return result;
    } catch (error) {
      explicitClears = before;
      throw error;
    }
  }

  async function loadFile(file) {
    if (!file) return null;
    if (Number(file.size) > MAX_PLAN_BYTES) fail('PLAN_TOO_LARGE', 'Catalog Change Plan JSON 超過 5 MB');
    let parsed;
    try { parsed = JSON.parse(await file.text()); }
    catch (_) { fail('INVALID_JSON', 'Catalog Change Plan JSON 無法讀取'); }
    return loadPlan(parsed);
  }

  function downloadPlan() {
    if (!plan) return null;
    (savePlan || (value => defaultSavePlan(value, { documentRef, rootRef })))(plan);
    message(`已下載 ${plan.candidate.catalogVersion} 的簽章 Catalog Change Plan。`, 'success');
    return plan;
  }

  function closeConfirm() {
    const confirm = query('[data-product-update-confirm]');
    confirm.hidden = true;
    query('[data-product-update-prepare]').focus();
  }

  function openConfirm() {
    const status = renderAlignment();
    if (!plan || releaseBlocked() || status?.state === 'failed' || selected.size === 0) {
      renderSelection();
      message(status?.state === 'failed' ? alignmentCopy(status) : '目前沒有可交接的已選變更。', 'error');
      return;
    }
    query('[data-product-update-confirm-copy]').textContent = `將交接 ${selected.size} 筆變更，基準 ${plan.baseline.catalogVersion}、候選 ${plan.candidate.catalogVersion}。交接檔不包含 sourceFile、來源列、before/after raw payload 或任何凭證。`;
    const confirm = query('[data-product-update-confirm]');
    confirm.hidden = false;
    query('[data-product-update-confirm-cancel]').focus();
  }

  function confirmHandoff() {
    const status = renderAlignment();
    if (status?.state === 'failed') {
      closeConfirm();
      renderSelection();
      message(alignmentCopy(status), 'error');
      return null;
    }
    const orderedSelection = plan.entries.filter(entry => selected.has(entry.id)).map(entry => entry.id);
    const handoff = createCatalogUpdateHandoff(plan, orderedSelection, { confirmedAt:now() });
    (saveHandoff || (value => defaultSaveHandoff(value, { documentRef, rootRef })))(handoff);
    rootRef.dispatchEvent?.(new rootRef.CustomEvent('jsp:catalog-update-selection-handoff', { detail:handoff }));
    closeConfirm();
    message(`已下載 ${handoff.selectedEntryIds.length} 筆變更的 public-only 交接檔。請交給本機發布流程，它會重新驗證原始 Excel 與 exact plan。`, 'success');
    return handoff;
  }

  function open() {
    lastFocus = documentRef.activeElement;
    renderAlignment();
    if (typeof dialog.showModal === 'function') dialog.showModal();
    else { dialog.hidden = false; dialog.setAttribute('open', ''); }
    query('[data-product-update-close]').focus();
  }

  function close() {
    if (!query('[data-product-update-confirm]').hidden) {
      closeConfirm();
      return;
    }
    if (typeof dialog.close === 'function' && dialog.open) dialog.close();
    else { dialog.hidden = true; dialog.removeAttribute('open'); lastFocus?.focus?.(); }
  }

  function mount(actions) {
    if (dialog) return { trigger, dialog };
    trigger = element(documentRef, 'button', 'product-update-trigger', '更新產品資料');
    trigger.type = 'button';
    trigger.setAttribute('aria-haspopup', 'dialog');
    trigger.addEventListener('click', open);
    actions.prepend(trigger);

    dialog = element(documentRef, 'dialog', 'product-update-dialog');
    dialog.id = 'productUpdateDialog';
    dialog.setAttribute('aria-labelledby', 'productUpdateTitle');
    dialog.innerHTML = dialogMarkup();
    documentRef.body.append(dialog);
    dialog.hidden = !('HTMLDialogElement' in rootRef);

    query('[data-product-update-close]').addEventListener('click', close);
    query('[data-product-update-raw-file]').addEventListener('change', async event => {
      try {
        message('正在本機解析 Excel 並建立簽章變更計畫…', 'neutral');
        await loadRawWorkbook(event.target.files?.[0]);
      } catch (error) {
        resetPlanState();
        message(error?.message || '無法讀取原始產品資訊 Excel。', 'error');
      } finally {
        event.target.value = '';
      }
    });
    query('[data-product-update-file]').addEventListener('change', async event => {
      try {
        message('正在驗證計畫簽章…', 'neutral');
        await loadFile(event.target.files?.[0]);
      } catch (error) {
        resetPlanState();
        message(error?.message || '無法載入 Catalog Change Plan。', 'error');
      } finally {
        event.target.value = '';
      }
    });
    query('[data-product-update-save-plan]').addEventListener('click', downloadPlan);
    query('[data-product-update-prepare]').addEventListener('click', openConfirm);
    query('[data-product-update-confirm-cancel]').addEventListener('click', closeConfirm);
    query('[data-product-update-confirm-accept]').addEventListener('click', confirmHandoff);
    dialog.addEventListener('close', () => lastFocus?.focus?.());
    dialog.addEventListener('cancel', event => {
      if (!query('[data-product-update-confirm]').hidden) {
        event.preventDefault();
        closeConfirm();
      }
    });
    dialog.addEventListener('keydown', event => {
      const confirm = query('[data-product-update-confirm]');
      if (event.key === 'Escape' && !confirm.hidden) {
        event.preventDefault();
        closeConfirm();
        return;
      }
      if (event.key !== 'Tab') return;
      const scope = confirm.hidden ? dialog : confirm;
      const nodes = focusable(scope);
      if (!nodes.length) return;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (!scope.contains(documentRef.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      }
      else if (event.shiftKey && documentRef.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && documentRef.activeElement === last) { event.preventDefault(); first.focus(); }
    });
    return { trigger, dialog };
  }

  return Object.freeze({
    mount,
    open,
    close,
    loadPlan,
    loadRawWorkbook,
    setExplicitClear,
    getExplicitClears:() => Object.fromEntries([...explicitClears].map(([sku, fields]) => [sku, [...fields]])),
    downloadPlan,
    getPlan:() => plan,
    getSelectedEntryIds:() => plan ? plan.entries.filter(entry => selected.has(entry.id)).map(entry => entry.id) : [],
    confirmHandoff,
  });
}

function waitForHeader(documentRef, timeoutMs = 10000) {
  const find = () => documentRef.querySelector('.app-header .header-inner');
  const immediate = find();
  if (immediate) return Promise.resolve(immediate);
  return new Promise((resolve, reject) => {
    const observer = new MutationObserver(() => {
      const header = find();
      if (!header) return;
      observer.disconnect();
      clearTimeout(timeout);
      resolve(header);
    });
    observer.observe(documentRef.documentElement, { childList:true, subtree:true });
    const timeout = setTimeout(() => {
      observer.disconnect();
      reject(new Error('Product Update Entry header mount was not found'));
    }, timeoutMs);
  });
}

function ensureHeaderActions(documentRef, header) {
  let actions = header.querySelector(':scope > .workspace-header-actions');
  if (!actions) {
    actions = element(documentRef, 'div', 'workspace-header-actions');
    actions.setAttribute('aria-label', '工作區操作');
    header.append(actions);
  }
  for (const candidate of [...header.children]) {
    if (candidate === actions) continue;
    if (candidate.matches('.clear-workspace,.header-meta,#catalogAlignmentStatus')) actions.append(candidate);
  }
  return actions;
}

export async function bootProductUpdateEntry({ site, documentRef = globalThis.document, rootRef = globalThis.window, ...options } = {}) {
  const header = await waitForHeader(documentRef);
  const actions = ensureHeaderActions(documentRef, header);
  const controller = createProductUpdateEntry({ site, documentRef, rootRef, ...options });
  controller.mount(actions);
  return controller;
}

const browserApi = Object.freeze({
  bootProductUpdateEntry,
  catalogChangeDetailRows,
  createProductUpdateEntry,
  validateCatalogChangePlanForReview,
});

if (typeof window !== 'undefined' && typeof document !== 'undefined') {
  window.JSPProductUpdateEntry = browserApi;
  const script = [...document.querySelectorAll('script[type="module"][src]')]
    .find(node => /(?:^|\/)product-update-entry\.mjs(?:\?|$)/.test(node.getAttribute('src') || ''));
  const site = script?.dataset?.productUpdateSite;
  if (site) {
    const start = () => bootProductUpdateEntry({ site }).then(controller => {
      window.JSPProductUpdateRuntime = controller;
    }).catch(error => window.console?.error?.('Product Update Entry failed to start', error));
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once:true });
    else void start();
  }
}
