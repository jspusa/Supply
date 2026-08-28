export const ONE_PALLET_DISCONTINUATION_DAYS = 365;
export const ONE_PALLET_DISCONTINUATION_REASON = 'ONE_PALLET_EXCEEDS_365_DAYS';

function normalizeProductSku(value) {
  return String(value ?? '').trim().toUpperCase();
}

function positiveFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function formatNumber(value) {
  return Number(value.toFixed(2)).toLocaleString('en-US', { maximumFractionDigits:2 });
}

function isAlreadyDiscontinued(row, productSku, isDiscontinuedSku) {
  if (row?.isDiscontinued === true || row?.discontinued === true) return true;
  return typeof isDiscontinuedSku === 'function' && isDiscontinuedSku(productSku, row) === true;
}

export function buildDiscontinuationSuggestions(rows = [], options = {}) {
  if (!Array.isArray(rows)) return Object.freeze([]);
  const suggestions = [];

  for (const row of rows) {
    const productSku = normalizeProductSku(row?.productSku ?? row?.sku);
    const planningVelocity = positiveFiniteNumber(row?.planningVelocity);
    const unitsPerPallet = positiveFiniteNumber(row?.unitsPerPallet);
    if (!productSku || planningVelocity === null || unitsPerPallet === null) continue;
    if (isAlreadyDiscontinued(row, productSku, options.isDiscontinuedSku)) continue;

    const onePalletSellableDays = unitsPerPallet / planningVelocity;
    if (!(onePalletSellableDays > ONE_PALLET_DISCONTINUATION_DAYS)) continue;

    suggestions.push(Object.freeze({
      productSku,
      planningVelocity,
      unitsPerPallet,
      onePalletSellableDays,
      reasonCode:ONE_PALLET_DISCONTINUATION_REASON,
      reason:`一板可售 ${formatNumber(onePalletSellableDays)} 天，超過 365 天；最低一板已超出健康上限，建議評估停產。`,
    }));
  }

  suggestions.sort((left, right) => (
    right.onePalletSellableDays - left.onePalletSellableDays
    || left.productSku.localeCompare(right.productSku)
  ));
  return Object.freeze(suggestions);
}

const browserInterface = Object.freeze({
  ONE_PALLET_DISCONTINUATION_DAYS,
  ONE_PALLET_DISCONTINUATION_REASON,
  buildDiscontinuationSuggestions,
});

if (typeof window !== 'undefined') window.SupplyDiscontinuationSuggestions = browserInterface;
