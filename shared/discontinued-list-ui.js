const CHANNEL_LABELS = Object.freeze({ discontinued:'停產', chewy:'Chewy 專售' });

function dialogMarkup() {
  return `<div class="discontinued-list-header">
      <div><p class="discontinued-list-kicker">Product status</p><h2 id="discontinuedListTitle">停產清單</h2></div>
      <button type="button" class="discontinued-list-close" aria-label="關閉停產清單">×</button>
    </div>
    <div class="discontinued-list-controls">
      <p id="discontinuedListDescription">此清單內的 SKU 均不會由本程式下單。Chewy 專售品項仍供其他平台銷售。</p>
      <div class="discontinued-list-fields">
        <label for="discontinuedListSearch">搜尋 SKU／原因<input id="discontinuedListSearch" type="search" placeholder="輸入 SKU 或停產原因" autocomplete="off" spellcheck="false"></label>
        <label for="discontinuedListFilter">分類<select id="discontinuedListFilter"><option value="all">全部</option><option value="discontinued">停產</option><option value="chewy">Chewy 專售</option></select></label>
      </div>
      <p id="discontinuedListCount" class="discontinued-list-count" role="status" aria-live="polite" aria-atomic="true"></p>
    </div>
    <div class="discontinued-list-scroll" tabindex="0" role="region" aria-label="停產 SKU 與原因">
      <table class="discontinued-list-table">
        <caption class="discontinued-list-sr-only">不由本程式下單的 SKU、分類與原因</caption>
        <thead><tr><th scope="col">SKU</th><th scope="col">分類</th><th scope="col">原因</th></tr></thead>
        <tbody></tbody>
      </table>
      <p class="discontinued-list-empty" hidden>找不到符合的 SKU 或原因。</p>
    </div>`;
}

export function filterDiscontinuedEntries(entries, { query = '', channel = 'all' } = {}) {
  const needle = String(query).trim().toLocaleLowerCase();
  return entries.filter(entry => (channel === 'all' || entry.channel === channel)
    && (!needle || [entry.sku, entry.reason, CHANNEL_LABELS[entry.channel]]
      .some(value => String(value || '').toLocaleLowerCase().includes(needle))));
}

export function mountDiscontinuedListUi({ trigger, documentRef = globalThis.document, windowRef = globalThis.window } = {}) {
  if (!trigger || !documentRef || !windowRef) throw new TypeError('Discontinued list requires a trigger, document and window');
  let dialog;
  let returnFocus;

  function render() {
    const entries = windowRef.SupplyDiscontinuedProducts?.entries || [];
    const visible = filterDiscontinuedEntries(entries, {
      query:dialog.querySelector('#discontinuedListSearch').value,
      channel:dialog.querySelector('#discontinuedListFilter').value,
    });
    const rows = documentRef.createDocumentFragment();
    for (const entry of visible) {
      const row = documentRef.createElement('tr');
      row.dataset.discontinuedSku = entry.sku;
      const sku = documentRef.createElement('th');
      sku.scope = 'row';
      sku.textContent = entry.sku;
      const channel = documentRef.createElement('td');
      const badge = documentRef.createElement('span');
      badge.className = 'discontinued-list-badge';
      badge.dataset.channel = entry.channel;
      badge.textContent = CHANNEL_LABELS[entry.channel] || '停產';
      channel.append(badge);
      const reason = documentRef.createElement('td');
      reason.textContent = entry.reason || '未提供原因';
      row.append(sku, channel, reason);
      rows.append(row);
    }
    dialog.querySelector('tbody').replaceChildren(rows);
    const chewyCount = entries.filter(entry => entry.channel === 'chewy').length;
    dialog.querySelector('#discontinuedListCount').textContent = `顯示 ${visible.length} / ${entries.length} 個 SKU · 停產 ${entries.length - chewyCount} · Chewy 專售 ${chewyCount}`;
    dialog.querySelector('.discontinued-list-empty').hidden = visible.length !== 0;
  }

  function close() {
    if (dialog?.open) dialog.close();
  }

  function open() {
    if (!dialog) {
      dialog = documentRef.createElement('dialog');
      dialog.id = 'discontinuedListDialog';
      dialog.className = 'discontinued-list-dialog';
      dialog.setAttribute('aria-labelledby', 'discontinuedListTitle');
      dialog.setAttribute('aria-describedby', 'discontinuedListDescription');
      dialog.innerHTML = dialogMarkup();
      documentRef.body.append(dialog);
      dialog.querySelector('.discontinued-list-close').addEventListener('click', close);
      dialog.querySelector('#discontinuedListSearch').addEventListener('input', render);
      dialog.querySelector('#discontinuedListFilter').addEventListener('change', render);
      dialog.addEventListener('close', () => returnFocus?.focus?.({ preventScroll:true }));
    }
    if (dialog.open) return;
    returnFocus = documentRef.activeElement;
    render();
    dialog.showModal();
    dialog.querySelector('#discontinuedListSearch').focus({ preventScroll:true });
  }

  trigger.addEventListener('click', open);
  return Object.freeze({ open, close });
}
