export const ORDER_VELOCITY_OVERRIDES_KEY = 'supply-order-velocity-overrides-v1';

function normalizeProductSku(value) {
  return String(value ?? '').trim().toUpperCase();
}

function normalizeOverrides(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const overrides = {};
  for (const [rawSku, rawVelocity] of Object.entries(value)) {
    const productSku = normalizeProductSku(rawSku);
    const velocity = Number(rawVelocity);
    if (!productSku || !Number.isFinite(velocity) || velocity <= 0) return null;
    overrides[productSku] = velocity;
  }
  return overrides;
}

export function readOrderVelocityOverrides(storage, key = ORDER_VELOCITY_OVERRIDES_KEY) {
  try {
    const raw = storage?.getItem?.(key);
    if (raw === null || raw === undefined || raw === '') return { ok:true, status:'missing', overrides:{} };
    const parsed = JSON.parse(raw);
    const overrides = parsed?.schemaVersion === 1 ? normalizeOverrides(parsed.overrides) : null;
    return overrides ? { ok:true, status:'loaded', overrides } : { ok:false, status:'corrupt', overrides:{} };
  } catch (_) {
    return { ok:false, status:'corrupt', overrides:{} };
  }
}

export function setOrderVelocityOverride(storage, { productSku:rawProductSku, value }, key = ORDER_VELOCITY_OVERRIDES_KEY) {
  const productSku = normalizeProductSku(rawProductSku);
  if (!productSku) return { ok:false, status:'invalid-product-sku', overrides:{} };

  const current = readOrderVelocityOverrides(storage, key);
  if (!current.ok) return current;
  const overrides = { ...current.overrides };
  const text = String(value ?? '').trim();
  if (!text) delete overrides[productSku];
  else {
    const velocity = Number(text);
    if (!Number.isFinite(velocity) || velocity <= 0) return { ok:false, status:'invalid-velocity', overrides };
    overrides[productSku] = velocity;
  }

  try {
    storage?.setItem?.(key, JSON.stringify({ schemaVersion:1, overrides }));
    return { ok:true, status:'saved', overrides };
  } catch (_) {
    return { ok:false, status:'unavailable', overrides:current.overrides };
  }
}

const browserInterface = Object.freeze({
  ORDER_VELOCITY_OVERRIDES_KEY,
  readOrderVelocityOverrides,
  setOrderVelocityOverride,
});

if (typeof window !== 'undefined') window.SupplyOrderVelocity = browserInterface;
