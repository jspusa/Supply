function dialogMarkup() {
  return `<div class="discontinued-list-header">
      <div><p class="discontinued-list-kicker">SKU reference</p><h2 id="skuAliasListTitle">SKU 對照表</h2></div>
      <button type="button" class="discontinued-list-close" aria-label="關閉 SKU 對照表">×</button>
    </div>
    <div class="discontinued-list-controls">
      <p id="skuAliasListDescription">同列兩個 SKU 為同一品項，訂單會合併計算；以 7 開頭的 SKU 用於委外下單。例如 GTP01 與 7GTPD013AB 的訂單會一起計算。</p>
      <div class="discontinued-list-fields">
        <label for="skuAliasListSearch">搜尋任一 SKU<input id="skuAliasListSearch" type="search" placeholder="例如 GTP01 或 7GTPD013AB" autocomplete="off" spellcheck="false"></label>
      </div>
      <p id="skuAliasListCount" class="discontinued-list-count" role="status" aria-live="polite" aria-atomic="true"></p>
    </div>
    <div class="discontinued-list-scroll" tabindex="0" role="region" aria-label="同品項 SKU 對照">
      <table class="discontinued-list-table">
        <caption class="discontinued-list-sr-only">同一品項的產品 SKU 與委外下單 SKU</caption>
        <thead><tr><th scope="col">產品 SKU</th><th scope="col">委外下單 SKU</th></tr></thead>
        <tbody></tbody>
      </table>
      <p class="discontinued-list-empty" hidden>找不到符合的 SKU。</p>
    </div>`;
}

export function filterSkuAliasPairs(pairs, { query = '' } = {}) {
  const needle = String(query).trim().toLocaleLowerCase();
  return Array.from(pairs || []).filter(pair => Array.isArray(pair) && pair.length === 2
    && pair.every(sku => typeof sku === 'string' && sku.trim())
    && (!needle || pair.some(sku => sku.toLocaleLowerCase().includes(needle))));
}

export function mountSkuAliasListUi({ trigger, pairs, documentRef = globalThis.document, windowRef = globalThis.window } = {}) {
  if (!trigger || !documentRef || !windowRef) throw new TypeError('SKU alias list requires a trigger, document and window');
  let dialog;
  let returnFocus;

  function render() {
    const sourcePairs = pairs ?? windowRef.SupplySkuCorrespondence?.confirmedPairs ?? windowRef.SUPPLY_EQUIVALENT_SKU_PAIRS;
    const currentOwners = new Map((windowRef.SUPPLY_PLANNING_SKU_PAIRS || []).map(([productSku, orderSku]) => [orderSku, productSku]));
    const entries = filterSkuAliasPairs(sourcePairs).map(([productSku, orderSku]) => [currentOwners.get(orderSku) || productSku, orderSku]);
    const visible = filterSkuAliasPairs(entries, { query:dialog.querySelector('#skuAliasListSearch').value });
    const rows = documentRef.createDocumentFragment();
    for (const [canonical, alias] of visible) {
      const row = documentRef.createElement('tr');
      row.dataset.productSku = canonical;
      row.dataset.orderSku = alias;
      const productSku = documentRef.createElement('th');
      productSku.scope = 'row';
      productSku.textContent = canonical;
      const orderSku = documentRef.createElement('td');
      orderSku.textContent = alias;
      row.append(productSku, orderSku);
      rows.append(row);
    }
    dialog.querySelector('tbody').replaceChildren(rows);
    dialog.querySelector('#skuAliasListCount').textContent = `顯示 ${visible.length} / ${entries.length} 組對照`;
    dialog.querySelector('.discontinued-list-empty').hidden = visible.length !== 0;
  }

  function close() {
    if (dialog?.open) dialog.close();
  }

  function open() {
    if (!dialog) {
      dialog = documentRef.createElement('dialog');
      dialog.id = 'skuAliasListDialog';
      dialog.className = 'discontinued-list-dialog sku-alias-list-dialog';
      dialog.setAttribute('aria-labelledby', 'skuAliasListTitle');
      dialog.setAttribute('aria-describedby', 'skuAliasListDescription');
      dialog.innerHTML = dialogMarkup();
      documentRef.body.append(dialog);
      dialog.querySelector('.discontinued-list-close').addEventListener('click', close);
      dialog.querySelector('#skuAliasListSearch').addEventListener('input', render);
      dialog.addEventListener('keydown', event => {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        close();
      });
      dialog.addEventListener('close', () => returnFocus?.focus?.({ preventScroll:true }));
    }
    if (dialog.open) return;
    returnFocus = documentRef.activeElement;
    render();
    dialog.showModal();
    dialog.querySelector('#skuAliasListSearch').focus({ preventScroll:true });
  }

  trigger.addEventListener('click', open);
  return Object.freeze({ open, close });
}
