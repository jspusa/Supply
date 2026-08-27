export const ORDER_DRAFT_SCHEMA_VERSION = 2;
export const ORDER_DRAFT_STORAGE_KEY = 'supply-order-draft-v2';
export const LEGACY_ORDER_DRAFT_STORAGE_KEY = 'supply-generator-drafts-v1';
export const ORDER_GROUP_IDS = Object.freeze(['taiwan', 'vietnam', 'subcontract']);
export const ORDER_EXPORT_HEADERS = Object.freeze([
  '序號', '品號', '名稱', '每箱', '包裝類型', '箱數', '單位', '棧板數', '單位', '紙箱尺寸(cm)',
]);
const ORDER_WORKBOOK_SHEETS = Object.freeze([
  Object.freeze({ id:'taiwan', name:'台灣' }),
  Object.freeze({ id:'vietnam', name:'越南' }),
  Object.freeze({ id:'subcontract', name:'代工' }),
]);

function normalizeSku(value) {
  return String(value ?? '').trim().toUpperCase();
}

function timestamp(value) {
  const resolved = typeof value === 'function' ? value() : value;
  const date = resolved === undefined ? new Date() : new Date(resolved);
  if (!Number.isFinite(date.getTime())) throw new TypeError('now must be a valid date');
  return date.toISOString();
}

function emptyGroupOrder() {
  return { taiwan:[], vietnam:[], subcontract:[] };
}

function clone(value) {
  return structuredClone(value);
}

function isRecord(value) {
  return Boolean(value) && !Array.isArray(value) && typeof value === 'object';
}

function isIsoTimestamp(value) {
  if (typeof value !== 'string' || !value) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isDraftNumber(value) {
  return value === null || value === '' || (
    typeof value === 'number'
    && Number.isFinite(value)
    && value >= 0
  );
}

function validateIssueList(issues, label) {
  if (!Array.isArray(issues)) return `${label} must be an array`;
  for (const issue of issues) {
    if (!isRecord(issue) || typeof issue.code !== 'string' || !issue.code.trim()) {
      return `${label} must contain issue objects with a code`;
    }
  }
  return null;
}

export function countOrderDraftRepairItems({ issues = [], repairOrder = [] } = {}) {
  const productSkus = new Set(
    (Array.isArray(repairOrder) ? repairOrder : []).map(normalizeSku).filter(Boolean),
  );
  let globalIssueCount = 0;
  for (const issue of Array.isArray(issues) ? issues : []) {
    if (!isRecord(issue)) continue;
    const issueProductSkus = [
      issue.productSku,
      ...(Array.isArray(issue.productSkus) ? issue.productSkus : []),
    ].map(normalizeSku).filter(Boolean);
    if (issueProductSkus.length) issueProductSkus.forEach(productSku => productSkus.add(productSku));
    else globalIssueCount += 1;
  }
  return productSkus.size + globalIssueCount;
}

function normalizeFactory(value) {
  const factory = String(value ?? '').trim().toUpperCase();
  if (factory === 'TW' || factory === 'TAIWAN' || factory === '台灣') return 'taiwan';
  if (factory === 'VN' || factory === 'VIETNAM' || factory === '越南') return 'vietnam';
  return null;
}

function approvedOrderSkus(productSku, context) {
  return new Set((context?.getApprovedOrderSkus?.(productSku) || []).map(normalizeSku).filter(Boolean));
}

function resolveIdentity(productSku, requestedOrderSku, context, suppliedFactory = null) {
  const product = context?.getProduct?.(productSku) || null;
  const standardFactory = normalizeFactory(product?.country) || normalizeFactory(suppliedFactory);
  const orderSku = normalizeSku(requestedOrderSku) || productSku;
  const approved = orderSku === productSku || approvedOrderSkus(productSku, context).has(orderSku);
  if (!approved) return { ok:false, status:'unapproved-order-sku', product, standardFactory, orderSku };
  const orderGroup = orderSku.startsWith('7') ? 'subcontract' : standardFactory;
  return { ok:true, product, standardFactory, orderSku, orderGroup };
}

function removeFromOrders(draft, productSku) {
  for (const group of ORDER_GROUP_IDS) {
    draft.groupOrder[group] = draft.groupOrder[group].filter(value => value !== productSku);
  }
  draft.repairOrder = draft.repairOrder.filter(value => value !== productSku);
}

function addToOrder(draft, productSku, orderGroup) {
  if (ORDER_GROUP_IDS.includes(orderGroup)) draft.groupOrder[orderGroup].push(productSku);
  else draft.repairOrder.push(productSku);
}

export function createOrderDraft({ now } = {}) {
  const createdAt = timestamp(now);
  return {
    schemaVersion:ORDER_DRAFT_SCHEMA_VERSION,
    createdAt,
    updatedAt:createdAt,
    rowsByProductSku:{},
    groupOrder:emptyGroupOrder(),
    repairOrder:[],
    issues:[],
  };
}

function upsertRow(draft, input, context) {
  const productSku = normalizeSku(input?.productSku ?? input?.product);
  if (!productSku) return { ok:false, status:'invalid-product-sku', draft };
  const existing = draft.rowsByProductSku[productSku] || null;
  const identity = resolveIdentity(
    productSku,
    input?.orderSku ?? input?.orderCode ?? existing?.orderSku ?? productSku,
    context,
    input?.standardFactory ?? existing?.standardFactory,
  );
  if (!identity.ok) return { ...identity, draft };
  const updatedAt = timestamp(context?.now);
  const sourcePallet = input?.pallet ?? existing?.pallet;
  const row = {
    productSku,
    orderSku:identity.orderSku,
    standardFactory:identity.standardFactory,
    orderGroup:identity.orderGroup,
    quantities:clone(input?.quantities ?? existing?.quantities ?? {}),
    pallet:sourcePallet === undefined ? { value:null, mode:'manual' } : clone(sourcePallet),
    locked:input?.locked === undefined ? Boolean(existing?.locked) : Boolean(input.locked),
    createdAt:existing?.createdAt || updatedAt,
    updatedAt,
    issues:[],
  };
  if (!identity.product) row.issues.push({ code:'MISSING_PRODUCT_CATALOG', productSku });
  if (!identity.standardFactory) row.issues.push({ code:'MISSING_STANDARD_FACTORY', productSku });
  const next = clone(draft);
  next.rowsByProductSku[productSku] = row;
  if (!existing || existing.orderGroup !== row.orderGroup) {
    removeFromOrders(next, productSku);
    addToOrder(next, productSku, row.orderGroup);
  }
  next.updatedAt = updatedAt;
  const validationError = validateDraftShape(next);
  if (validationError) return failure('invalid-row', new TypeError(validationError), { draft });
  return { ok:true, status:'applied', draft:next, row };
}

function switchOrderSku(draft, command, context) {
  const productSku = normalizeSku(command?.productSku);
  const existing = draft.rowsByProductSku[productSku];
  if (!existing) return { ok:false, status:'missing-row', draft };
  return upsertRow(draft, { ...existing, orderSku:command.orderSku }, context);
}

function reorderGroup(draft, command, context) {
  const group = command?.group;
  if (!ORDER_GROUP_IDS.includes(group)) return { ok:false, status:'invalid-order-group', draft };
  const requested = Array.isArray(command.productSkus) ? command.productSkus.map(normalizeSku) : [];
  const current = draft.groupOrder[group];
  const requestedSet = new Set(requested);
  if (
    requested.length !== current.length
    || requestedSet.size !== requested.length
    || current.some(productSku => !requestedSet.has(productSku))
  ) {
    return { ok:false, status:'invalid-group-order', draft };
  }
  const next = clone(draft);
  next.groupOrder[group] = requested;
  next.updatedAt = timestamp(context?.now);
  return { ok:true, status:'applied', draft:next };
}

function patchRow(draft, command, context) {
  const productSku = normalizeSku(command?.productSku);
  const existing = draft.rowsByProductSku[productSku];
  if (!existing) return { ok:false, status:'missing-row', draft };
  const patch = command?.patch || {};
  const updatedAt = timestamp(context?.now);
  const row = {
    ...existing,
    quantities:patch.quantities ? { ...existing.quantities, ...clone(patch.quantities) } : clone(existing.quantities),
    pallet:patch.pallet ? { ...existing.pallet, ...clone(patch.pallet) } : clone(existing.pallet),
    locked:patch.locked === undefined ? existing.locked : Boolean(patch.locked),
    updatedAt,
  };
  const next = clone(draft);
  next.rowsByProductSku[productSku] = row;
  next.updatedAt = updatedAt;
  const validationError = validateDraftShape(next);
  if (validationError) return failure('invalid-row', new TypeError(validationError), { draft });
  return { ok:true, status:'applied', draft:next, row };
}

function removeRow(draft, command, context) {
  const productSku = normalizeSku(command?.productSku);
  if (!draft.rowsByProductSku[productSku]) return { ok:false, status:'missing-row', draft };
  const next = clone(draft);
  delete next.rowsByProductSku[productSku];
  removeFromOrders(next, productSku);
  next.updatedAt = timestamp(context?.now);
  return { ok:true, status:'applied', draft:next };
}

export function applyOrderDraftCommand(draft, command, context = {}) {
  if (!draft || draft.schemaVersion !== ORDER_DRAFT_SCHEMA_VERSION) {
    return { ok:false, status:'invalid-draft', draft };
  }
  if (command?.type === 'upsert-row') return upsertRow(draft, command.row, context);
  if (command?.type === 'switch-order-sku') return switchOrderSku(draft, command, context);
  if (command?.type === 'reorder-group') return reorderGroup(draft, command, context);
  if (command?.type === 'patch-row') return patchRow(draft, command, context);
  if (command?.type === 'remove-row') return removeRow(draft, command, context);
  return { ok:false, status:'unsupported-command', draft };
}

export function getOrderGroupRows(draft, group) {
  if (!ORDER_GROUP_IDS.includes(group)) return [];
  return (draft?.groupOrder?.[group] || [])
    .map(productSku => draft?.rowsByProductSku?.[productSku])
    .filter(Boolean);
}

function errorDetails(error) {
  return {
    name:String(error?.name || 'Error'),
    message:String(error?.message || error || 'Unknown storage failure'),
  };
}

function storageFailureStatus(error) {
  const name = String(error?.name || '');
  if (name === 'SecurityError' || name === 'NotAllowedError') return 'denied';
  if (
    name === 'QuotaExceededError'
    || name === 'NS_ERROR_DOM_QUOTA_REACHED'
    || error?.code === 22
    || error?.code === 1014
  ) return 'quota';
  return 'failure';
}

function failure(status, error, details = {}) {
  return { ok:false, status, ...details, error:errorDetails(error) };
}

function validateDraftShape(draft) {
  if (!isRecord(draft)) return 'Order Draft must be an object';
  if (draft.schemaVersion !== ORDER_DRAFT_SCHEMA_VERSION) return 'Unsupported Order Draft schema';
  if (!isIsoTimestamp(draft.createdAt)) return 'Order Draft createdAt must be an ISO timestamp';
  if (!isIsoTimestamp(draft.updatedAt)) return 'Order Draft updatedAt must be an ISO timestamp';
  if (Date.parse(draft.updatedAt) < Date.parse(draft.createdAt)) return 'Order Draft updatedAt must not precede createdAt';
  if (!isRecord(draft.rowsByProductSku)) return 'rowsByProductSku must be an object';
  if (!isRecord(draft.groupOrder)) return 'groupOrder must be an object';
  const groupKeys = Object.keys(draft.groupOrder).sort();
  if (groupKeys.length !== ORDER_GROUP_IDS.length || ORDER_GROUP_IDS.some(group => !groupKeys.includes(group))) {
    return 'Order Draft must contain exactly three Order Groups';
  }
  if (!Array.isArray(draft.repairOrder)) return 'repairOrder must be an array';
  const rootIssueError = validateIssueList(draft.issues, 'Order Draft issues');
  if (rootIssueError) return rootIssueError;
  for (const [key, row] of Object.entries(draft.rowsByProductSku)) {
    if (!isRecord(row)) return `Product SKU ${key} must contain a row object`;
    if (normalizeSku(key) !== key || normalizeSku(row.productSku) !== key) return `Product SKU ${key} has an invalid identity`;
    const orderSku = normalizeSku(row.orderSku);
    if (!orderSku || orderSku !== row.orderSku) return `Product SKU ${key} has an invalid Order SKU`;
    if (!isRecord(row.quantities)) return `Product SKU ${key} quantities must be an object`;
    for (const [quantityName, quantity] of Object.entries(row.quantities)) {
      if (!isDraftNumber(quantity)) return `Product SKU ${key} quantity ${quantityName} must be a non-negative finite number, null, or blank`;
    }
    if (!isRecord(row.pallet)) return `Product SKU ${key} pallet must be an object`;
    if (!Object.hasOwn(row.pallet, 'value') || !isDraftNumber(row.pallet.value)) {
      return `Product SKU ${key} pallet value must be a non-negative finite number, null, or blank`;
    }
    if (typeof row.pallet.mode !== 'string' || !row.pallet.mode.trim()) return `Product SKU ${key} pallet mode must be a non-empty string`;
    for (const name of ['authoritativeField', 'warningCode', 'strategy', 'guidance']) {
      if (row.pallet[name] !== undefined && typeof row.pallet[name] !== 'string') return `Product SKU ${key} pallet ${name} must be a string`;
    }
    if (typeof row.locked !== 'boolean') return `Product SKU ${key} locked must be a boolean`;
    if (!isIsoTimestamp(row.createdAt)) return `Product SKU ${key} createdAt must be an ISO timestamp`;
    if (!isIsoTimestamp(row.updatedAt)) return `Product SKU ${key} updatedAt must be an ISO timestamp`;
    if (Date.parse(row.updatedAt) < Date.parse(row.createdAt)) return `Product SKU ${key} updatedAt must not precede createdAt`;
    const rowIssueError = validateIssueList(row.issues, `Product SKU ${key} issues`);
    if (rowIssueError) return rowIssueError;
    if (row.orderGroup === null) {
      if (row.issues.length === 0) return `Repair Product SKU ${key} must explain why it is unresolved`;
      continue;
    }
    if (!ORDER_GROUP_IDS.includes(row.orderGroup)) return `Product SKU ${key} has an invalid Order Group`;
    const hasStandardFactory = ['taiwan', 'vietnam'].includes(row.standardFactory);
    const missingFactoryIssue = Array.isArray(row.issues) && row.issues.some(issue => issue?.code === 'MISSING_STANDARD_FACTORY');
    if (!hasStandardFactory && !(orderSku.startsWith('7') && row.orderGroup === 'subcontract' && missingFactoryIssue)) {
      return `Product SKU ${key} has an invalid standard factory`;
    }
    const expectedGroup = orderSku.startsWith('7') ? 'subcontract' : row.standardFactory;
    if (row.orderGroup !== expectedGroup) return `Product SKU ${key} is routed to the wrong Order Group`;
  }
  const seen = new Set();
  for (const group of ORDER_GROUP_IDS) {
    if (!Array.isArray(draft.groupOrder[group])) return `Order Group ${group} must be an array`;
    for (const productSku of draft.groupOrder[group]) {
      if (typeof productSku !== 'string' || normalizeSku(productSku) !== productSku) return `Order Group ${group} contains an invalid Product SKU`;
      if (!draft.rowsByProductSku[productSku]) return `Order Group ${group} references a missing Product SKU`;
      if (seen.has(productSku)) return `Product SKU ${productSku} appears more than once`;
      seen.add(productSku);
      if (draft.rowsByProductSku[productSku].orderGroup !== group) return `Product SKU ${productSku} is in the wrong Order Group`;
    }
  }
  for (const productSku of draft.repairOrder) {
    if (typeof productSku !== 'string' || normalizeSku(productSku) !== productSku) return 'Repair order contains an invalid Product SKU';
    if (!draft.rowsByProductSku[productSku]) return 'Repair order references a missing Product SKU';
    if (seen.has(productSku)) return `Product SKU ${productSku} appears more than once`;
    seen.add(productSku);
    if (draft.rowsByProductSku[productSku].orderGroup !== null) return `Repair Product SKU ${productSku} must not claim an Order Group`;
  }
  if (seen.size !== Object.keys(draft.rowsByProductSku).length) return 'Every Product SKU must appear in one Order Group or repair order';
  return null;
}

function contextualRowIssues(row, context = {}) {
  if (row.orderGroup === null) return clone(row.issues || []);
  const issues = [];
  let product = null;
  if (typeof context?.getProduct !== 'function') {
    issues.push({ code:'CATALOG_VALIDATION_UNAVAILABLE', productSku:row.productSku });
  } else {
    try {
      product = context.getProduct(row.productSku) || null;
    } catch (error) {
      issues.push({ code:'CATALOG_VALIDATION_FAILED', productSku:row.productSku, error:errorDetails(error) });
    }
    if (!product) {
      issues.push(
        (row.issues || []).find(issue => issue?.code === 'MISSING_PRODUCT_CATALOG')
        || { code:'MISSING_PRODUCT_CATALOG', productSku:row.productSku },
      );
    } else {
      const catalogProductSku = normalizeSku(product.productCode ?? row.productSku);
      if (catalogProductSku !== row.productSku) {
        issues.push({ code:'CATALOG_PRODUCT_SKU_MISMATCH', productSku:row.productSku, catalogProductSku });
      }
      const catalogFactory = normalizeFactory(product.country);
      if (!catalogFactory) issues.push({ code:'MISSING_STANDARD_FACTORY', productSku:row.productSku });
      else if (row.standardFactory !== catalogFactory) {
        issues.push({
          code:'STANDARD_FACTORY_MISMATCH',
          productSku:row.productSku,
          savedFactory:row.standardFactory,
          catalogFactory,
        });
      }
      const expectedGroup = row.orderSku.startsWith('7') ? 'subcontract' : catalogFactory;
      if (catalogFactory && row.orderGroup !== expectedGroup) {
        issues.push({ code:'ORDER_GROUP_MISMATCH', productSku:row.productSku, savedGroup:row.orderGroup, expectedGroup });
      }
    }
  }

  if (row.orderSku !== row.productSku) {
    if (typeof context?.getApprovedOrderSkus !== 'function') {
      issues.push({ code:'ORDER_SKU_APPROVAL_UNAVAILABLE', productSku:row.productSku, orderSku:row.orderSku });
    } else {
      let approved = null;
      try {
        approved = approvedOrderSkus(row.productSku, context);
      } catch (error) {
        issues.push({ code:'ORDER_SKU_APPROVAL_FAILED', productSku:row.productSku, orderSku:row.orderSku, error:errorDetails(error) });
      }
      if (approved && !approved.has(row.orderSku)) {
        issues.push({ code:'UNAPPROVED_ORDER_SKU', productSku:row.productSku, orderSku:row.orderSku });
      }
    }
  }
  return issues;
}

function validateDraftContext(draft, context = {}) {
  return Object.values(draft.rowsByProductSku).flatMap(row => contextualRowIssues(row, context));
}

function repairContextualRows(draft, context = {}) {
  const next = clone(draft);
  const issues = [];
  for (const productSku of Object.keys(next.rowsByProductSku)) {
    const row = next.rowsByProductSku[productSku];
    const rowIssues = contextualRowIssues(row, context);
    if (!rowIssues.length) continue;
    issues.push(...rowIssues);
    row.issues = [
      ...row.issues,
      ...rowIssues.filter(issue => !row.issues.some(existing => existing?.code === issue.code)),
    ];
    row.orderGroup = null;
    removeFromOrders(next, productSku);
    addToOrder(next, productSku, null);
  }
  if (issues.length) {
    next.issues = [
      ...next.issues,
      ...issues.filter(issue => !next.issues.some(existing => (
        existing?.code === issue.code
        && existing?.productSku === issue.productSku
        && existing?.orderSku === issue.orderSku
      ))),
    ];
  }
  return { draft:next, issues };
}

function legacyNumber(value) {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : String(value);
}

function legacyPalletMode(item) {
  if (item?.warningCode === 'INVALID_PALLET_CATALOG') return 'unavailable';
  if (item?.strategy === 'fractional-exception') return 'fractional-exception';
  if (item?.strategy === 'whole-pallet') return 'whole-pallet';
  return 'manual';
}

function safeTimestamp(value, fallback) {
  try {
    return timestamp(value ?? fallback);
  } catch (_) {
    return timestamp(fallback);
  }
}

function migrateLegacyOrderDraft(legacy, context) {
  if (!legacy || Array.isArray(legacy) || typeof legacy !== 'object') {
    return failure('corrupt', new TypeError('Legacy Order Draft must be an object'), {
      draft:createOrderDraft({ now:context?.now }), needsSave:false, issues:[],
    });
  }
  const draft = createOrderDraft({ now:context?.now });
  const rootIssues = [];
  const legacyGroups = [
    { key:'VN', factory:'vietnam' },
    { key:'TW', factory:'taiwan' },
    { key:'Others', factory:null },
  ];
  for (const { key, factory } of legacyGroups) {
    const legacyGroup = legacy[key];
    if (legacyGroup === undefined || legacyGroup === null) continue;
    if (!legacyGroup || Array.isArray(legacyGroup) || typeof legacyGroup !== 'object' || !Array.isArray(legacyGroup.rows)) {
      return failure('corrupt', new TypeError(`Legacy Order Draft group ${key} is invalid`), {
        draft:createOrderDraft({ now:context?.now }), needsSave:false, issues:[],
      });
    }
    const rowTimestamp = safeTimestamp(legacyGroup.savedAt, context?.now);
    for (const [index, item] of legacyGroup.rows.entries()) {
      const productSku = normalizeSku(item?.productSku ?? item?.product);
      if (!productSku) {
        rootIssues.push({ code:'LEGACY_ROW_MISSING_PRODUCT_SKU', legacyGroup:key, index, legacyRow:clone(item) });
        continue;
      }
      const existing = draft.rowsByProductSku[productSku];
      if (existing) {
        const issue = { code:'LEGACY_DUPLICATE_PRODUCT_SKU', productSku, legacyGroup:key, legacyRow:clone(item) };
        rootIssues.push(issue);
        if (Date.parse(rowTimestamp) <= Date.parse(existing.updatedAt)) continue;
        removeFromOrders(draft, productSku);
      }
      const product = context?.getProduct?.(productSku) || null;
      const standardFactory = normalizeFactory(product?.country) || factory;
      const orderSku = normalizeSku(item?.orderSku ?? item?.orderCode) || productSku;
      const identity = resolveIdentity(productSku, orderSku, context, standardFactory);
      const issues = [];
      if (!product) issues.push({ code:'MISSING_PRODUCT_CATALOG', productSku });
      if (!standardFactory) issues.push({ code:'MISSING_STANDARD_FACTORY', productSku });
      if (!identity.ok) issues.push({ code:'UNAPPROVED_ORDER_SKU', productSku, orderSku });
      const orderGroup = product && standardFactory && identity.ok ? identity.orderGroup : null;
      const row = {
        productSku,
        orderSku,
        standardFactory,
        orderGroup,
        quantities:{
          packages:legacyNumber(item?.quantity),
          secondary:legacyNumber(item?.units),
          target:legacyNumber(item?.target),
          cartons:legacyNumber(item?.cartons),
          orderDraft:legacyNumber(item?.orderDraftQuantity),
        },
        pallet:{
          value:legacyNumber(item?.pallets),
          mode:legacyPalletMode(item),
          strategy:String(item?.strategy || ''),
          warningCode:String(item?.warningCode || ''),
          guidance:String(item?.guidance || ''),
        },
        locked:Boolean(item?.locked),
        createdAt:rowTimestamp,
        updatedAt:rowTimestamp,
        issues,
      };
      draft.rowsByProductSku[productSku] = row;
      addToOrder(draft, productSku, row.orderGroup);
    }
  }
  draft.issues = rootIssues;
  const allTimestamps = Object.values(draft.rowsByProductSku).map(row => Date.parse(row.updatedAt)).filter(Number.isFinite);
  if (allTimestamps.length) {
    draft.createdAt = new Date(Math.min(...allTimestamps)).toISOString();
    draft.updatedAt = new Date(Math.max(...allTimestamps)).toISOString();
  }
  const validationError = validateDraftShape(draft);
  if (validationError) {
    return failure('corrupt', new TypeError(validationError), {
      draft:createOrderDraft({ now:context?.now }), needsSave:false, issues:rootIssues,
    });
  }
  const issues = [
    ...rootIssues,
    ...Object.values(draft.rowsByProductSku).flatMap(row => row.issues),
  ];
  return { ok:true, status:'migrated', draft, needsSave:true, issues };
}

export function saveOrderDraft({
  storage,
  draft,
  key = ORDER_DRAFT_STORAGE_KEY,
  context = {},
} = {}) {
  if (!storage || typeof storage.setItem !== 'function') {
    return failure('unavailable', new TypeError('storage must provide setItem(key, value)'));
  }
  if (Number(draft?.schemaVersion) > ORDER_DRAFT_SCHEMA_VERSION) {
    return failure('unsupported', new TypeError(`Unsupported Order Draft schema ${draft.schemaVersion}`), { draft });
  }
  const validationError = validateDraftShape(draft);
  if (validationError) return failure('invalid', new TypeError(validationError));
  const contextualIssues = validateDraftContext(draft, context);
  const activeContextualIssues = contextualIssues.filter(issue => (
    draft.rowsByProductSku?.[normalizeSku(issue?.productSku)]?.orderGroup !== null
  ));
  if (activeContextualIssues.length) {
    const adapterUnavailable = activeContextualIssues.some(issue => [
      'CATALOG_VALIDATION_UNAVAILABLE',
      'CATALOG_VALIDATION_FAILED',
      'ORDER_SKU_APPROVAL_UNAVAILABLE',
      'ORDER_SKU_APPROVAL_FAILED',
    ].includes(issue.code));
    return failure(
      adapterUnavailable ? 'validation-unavailable' : 'invalid',
      new TypeError('Order Draft failed Product SKU and Order SKU validation'),
      { draft, issues:activeContextualIssues },
    );
  }
  let serialized;
  try {
    serialized = JSON.stringify(draft);
  } catch (error) {
    return failure('invalid', error);
  }
  try {
    storage.setItem(key, serialized);
    return {
      ok:true,
      status:contextualIssues.length ? 'saved-with-repairs' : 'saved',
      draft,
      ...(contextualIssues.length ? { issues:contextualIssues } : {}),
    };
  } catch (error) {
    return failure(storageFailureStatus(error), error, { draft });
  }
}

export function loadOrderDraft({
  storage,
  key = ORDER_DRAFT_STORAGE_KEY,
  legacyKey = LEGACY_ORDER_DRAFT_STORAGE_KEY,
  context = {},
} = {}) {
  if (!storage || typeof storage.getItem !== 'function') {
    return failure('unavailable', new TypeError('storage must provide getItem(key)'), {
      draft:createOrderDraft({ now:context.now }), needsSave:false, issues:[],
    });
  }
  let serialized;
  try {
    serialized = storage.getItem(key);
  } catch (error) {
    return failure(storageFailureStatus(error), error, {
      draft:createOrderDraft({ now:context.now }), needsSave:false, issues:[],
    });
  }
  if (serialized === null) {
    let legacySerialized;
    try {
      legacySerialized = storage.getItem(legacyKey);
    } catch (error) {
      return failure(storageFailureStatus(error), error, {
        draft:createOrderDraft({ now:context.now }), needsSave:false, issues:[],
      });
    }
    if (legacySerialized === null) {
      return { ok:true, status:'missing', draft:createOrderDraft({ now:context.now }), needsSave:false, issues:[] };
    }
    let legacy;
    try {
      legacy = JSON.parse(legacySerialized);
    } catch (error) {
      return failure('corrupt', error, {
        draft:createOrderDraft({ now:context.now }), needsSave:false, issues:[],
      });
    }
    return migrateLegacyOrderDraft(legacy, context);
  }
  let draft;
  try {
    draft = JSON.parse(serialized);
  } catch (error) {
    return failure('corrupt', error, {
      draft:createOrderDraft({ now:context.now }), needsSave:false, issues:[],
    });
  }
  if (Number(draft?.schemaVersion) > ORDER_DRAFT_SCHEMA_VERSION) {
    return failure('unsupported', new TypeError(`Unsupported Order Draft schema ${draft.schemaVersion}`), {
      draft:createOrderDraft({ now:context.now }), needsSave:false, issues:[],
    });
  }
  const validationError = validateDraftShape(draft);
  if (validationError) {
    return failure('corrupt', new TypeError(validationError), {
      draft:createOrderDraft({ now:context.now }), needsSave:false, issues:[],
    });
  }
  const repaired = repairContextualRows(draft, context);
  if (repaired.issues.length) {
    const repairedValidationError = validateDraftShape(repaired.draft);
    if (repairedValidationError) {
      return failure('corrupt', new TypeError(repairedValidationError), {
        draft:createOrderDraft({ now:context.now }), needsSave:false, issues:repaired.issues,
      });
    }
    return {
      ok:true,
      status:'repair-required',
      draft:repaired.draft,
      needsSave:false,
      issues:repaired.issues,
    };
  }
  return { ok:true, status:'loaded', draft, needsSave:false, issues:clone(draft.issues) };
}

function normalizeDecimal(value) {
  if (!Number.isFinite(value)) return null;
  return Math.round((value + Number.EPSILON) * 1e12) / 1e12;
}

function optionalFiniteNumber(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function packageType(product) {
  if (Number(product?.perPack) > 0) return '袋裝';
  if (Number(product?.perBox) > 0) return '盒裝';
  return '單包';
}

function projectedCartons(row, product) {
  const orderDraftQuantity = optionalFiniteNumber(row?.quantities?.orderDraft);
  const perCarton = Number(product?.perCarton);
  if (orderDraftQuantity !== null && orderDraftQuantity >= 0 && Number.isFinite(perCarton) && perCarton > 0) {
    const physicalQuantity = Number(product?.perPack) > 0
      ? orderDraftQuantity * Number(product.perPack)
      : orderDraftQuantity;
    return normalizeDecimal(physicalQuantity / perCarton);
  }
  return optionalFiniteNumber(row?.quantities?.cartons) ?? 0;
}

function projectedPallets(row, product) {
  const orderDraftQuantity = optionalFiniteNumber(row?.quantities?.orderDraft);
  const perCarton = Number(product?.perCarton);
  const cartonsPerPallet = Number(product?.perPallet);
  const perPack = Number(product?.perPack);
  const physicalUnitsPerOrderUnit = Number.isFinite(perPack) && perPack > 1 ? perPack : 1;
  const orderUnitsPerPallet = (perCarton * cartonsPerPallet) / physicalUnitsPerOrderUnit;
  if (
    orderDraftQuantity !== null
    && orderDraftQuantity >= 0
    && Number.isFinite(orderUnitsPerPallet)
    && orderUnitsPerPallet > 0
  ) return orderDraftQuantity / orderUnitsPerPallet;
  return optionalFiniteNumber(row?.pallet?.value) ?? 0;
}

export function projectOrderWorkbook(draft, context = {}) {
  const { getProduct } = context;
  const validationError = validateDraftShape(draft);
  if (validationError) {
    return { ok:false, status:'invalid-draft', sheetOrder:ORDER_WORKBOOK_SHEETS.map(sheet => sheet.name), headers:ORDER_EXPORT_HEADERS, sheets:[], issues:[{ code:'INVALID_DRAFT', message:validationError }] };
  }
  if (typeof getProduct !== 'function') {
    return { ok:false, status:'invalid-catalog-adapter', sheetOrder:ORDER_WORKBOOK_SHEETS.map(sheet => sheet.name), headers:ORDER_EXPORT_HEADERS, sheets:[], issues:[{ code:'MISSING_CATALOG_ADAPTER' }] };
  }
  const issues = [];
  if (draft.repairOrder.length) issues.push({ code:'REPAIR_ROWS_BLOCK_EXPORT', productSkus:[...draft.repairOrder] });
  const sheets = ORDER_WORKBOOK_SHEETS.map(sheet => {
    const rows = getOrderGroupRows(draft, sheet.id).flatMap((row, index) => {
      let product = null;
      try {
        product = getProduct(row.productSku) || null;
      } catch (error) {
        issues.push({ code:'ROW_REQUIRES_REPAIR', productSku:row.productSku, rowIssues:[{ code:'CATALOG_VALIDATION_FAILED', productSku:row.productSku, error:errorDetails(error) }] });
        return [];
      }
      const blockingIssues = [
        ...(row.issues || []).filter(issue => [
          'MISSING_PRODUCT_CATALOG',
          'MISSING_STANDARD_FACTORY',
          'UNAPPROVED_ORDER_SKU',
        ].includes(issue.code)),
        ...contextualRowIssues(row, context),
      ];
      if (!product || blockingIssues.length) {
        issues.push({ code:'ROW_REQUIRES_REPAIR', productSku:row.productSku, rowIssues:blockingIssues });
        return [];
      }
      const expectedFactory = normalizeFactory(product.country);
      const expectedGroup = row.orderSku.startsWith('7') ? 'subcontract' : expectedFactory;
      if (!expectedFactory || row.standardFactory !== expectedFactory || row.orderGroup !== expectedGroup) {
        issues.push({ code:'ROW_ROUTING_MISMATCH', productSku:row.productSku });
        return [];
      }
      const perCarton = Number(product.perCarton);
      return [[
        index + 1,
        row.orderSku,
        String(product.productName || ''),
        Number.isFinite(perCarton) ? perCarton : '',
        packageType(product),
        projectedCartons(row, product),
        '箱',
        projectedPallets(row, product),
        '棧板',
        String(product.boxSize || ''),
      ]];
    });
    return { id:sheet.id, name:sheet.name, headers:ORDER_EXPORT_HEADERS, rows };
  });
  return {
    ok:issues.length === 0,
    status:issues.length === 0 ? 'ready' : 'repair-required',
    sheetOrder:ORDER_WORKBOOK_SHEETS.map(sheet => sheet.name),
    headers:ORDER_EXPORT_HEADERS,
    sheets,
    issues,
  };
}

const browserInterface = Object.freeze({
  ORDER_DRAFT_SCHEMA_VERSION,
  ORDER_DRAFT_STORAGE_KEY,
  LEGACY_ORDER_DRAFT_STORAGE_KEY,
  ORDER_GROUP_IDS,
  ORDER_EXPORT_HEADERS,
  applyOrderDraftCommand,
  countOrderDraftRepairItems,
  createOrderDraft,
  getOrderGroupRows,
  loadOrderDraft,
  projectOrderWorkbook,
  saveOrderDraft,
});

if (typeof window !== 'undefined') window.SupplyOrderDraftState = browserInterface;
