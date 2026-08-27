function normalizePallets(value) {
  const pallets = Number(value);
  return Number.isFinite(pallets) && pallets > 0 ? pallets : 0;
}

function normalizeForDisplay(value) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function stepPalletDraft({ currentPallets, currentOrderDraftQuantity = null, delta, unitsPerPallet }) {
  if (delta !== -1 && delta !== 1) {
    throw new TypeError('delta must be exactly -1 or 1 pallet');
  }
  const validUnitsPerPallet = Number.isFinite(unitsPerPallet) && unitsPerPallet > 0;
  const validCurrentQuantity = Number.isFinite(currentOrderDraftQuantity) && currentOrderDraftQuantity >= 0;
  if (validUnitsPerPallet && validCurrentQuantity) {
    const orderDraftQuantity = Math.max(0, currentOrderDraftQuantity + delta * unitsPerPallet);
    return {
      pallets: normalizeForDisplay(orderDraftQuantity / unitsPerPallet),
      orderDraftQuantity,
    };
  }
  const pallets = normalizeForDisplay(Math.max(0, normalizePallets(currentPallets) + delta));
  return {
    pallets,
    orderDraftQuantity: validUnitsPerPallet ? pallets * unitsPerPallet : null,
  };
}

const browserInterface = Object.freeze({ stepPalletDraft });
if (typeof window !== 'undefined') window.SupplyOrderDraft = browserInterface;
