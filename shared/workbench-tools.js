import { parseOrderPaste, formatDateInput, leadTimeFromArrival, arrivalFromLeadTime } from './workbench-input.js';

/** UI controllers use the existing draft/planning adapters; source data stays in this browser. */
export function mountWorkbenchTools(adapter, documentRef = document) {
  const bulkInput = documentRef.getElementById('generatorBulkInput');
  const bulkButton = documentRef.getElementById('btnAddGeneratorBulk');
  const bulkStatus = documentRef.getElementById('generatorBulkStatus');
  const search = documentRef.getElementById('searchInput');
  const arrivalInput = documentRef.getElementById('newOrderArrivalDate');
  const arrivalHint = documentRef.getElementById('newOrderArrivalHint');
  const leadInput = documentRef.getElementById('leadTimeDays');
  const transferInput = documentRef.getElementById('fbaTransferDays');
  const today = () => {
    const [year, month, day] = adapter.asOfDate().split('-').map(Number);
    return new Date(year, month - 1, day);
  };
  const showBulkStatus = (message, error = false) => {
    bulkStatus.textContent = message;
    bulkStatus.dataset.state = error ? 'warning' : 'ready';
  };

  function updateDate() {
    const current = today();
    arrivalInput.min = arrivalFromLeadTime(1, current);
    arrivalInput.max = arrivalFromLeadTime(365, current);
    const selected = adapter.getArrivalDate();
    arrivalInput.value = selected || arrivalFromLeadTime(adapter.getLeadDays(), current);
    const days = leadTimeFromArrival(arrivalInput.value, current);
    if (!Number.isInteger(days)) {
      arrivalInput.setCustomValidity('請選擇明天起 365 天內的日期。');
      arrivalHint.textContent = '先前選擇的到港日期已不在範圍內，請重新選擇日期。';
      return;
    }
    arrivalInput.setCustomValidity('');
    const [year, month, day] = arrivalInput.value.split('-').map(Number);
    const sellable = new Date(year, month - 1, day);
    sellable.setDate(sellable.getDate() + adapter.getTransferDays());
    arrivalHint.textContent = '新單約 ' + days + ' 天後到港；預計 ' + formatDateInput(sellable) + ' 轉入 FBA 可售。';
  }

  arrivalInput.addEventListener('change', () => {
    if (!arrivalInput.value) {
      adapter.setArrivalDate('');
      updateDate();
      return;
    }
    const days = leadTimeFromArrival(arrivalInput.value, today());
    if (!Number.isInteger(days)) {
      arrivalInput.setCustomValidity('請選擇明天起 365 天內的日期。');
      arrivalInput.reportValidity();
      arrivalHint.textContent = '日期未套用；請選擇明天起 365 天內的預計到港日。';
      return;
    }
    arrivalInput.setCustomValidity('');
    adapter.setArrivalDate(arrivalInput.value, days);
    updateDate();
  });
  leadInput.addEventListener('change', () => {
    adapter.setArrivalDate('');
    updateDate();
  });
  transferInput.addEventListener('change', updateDate);

  // Multiline clipboard content cannot survive a one-line search field intact.
  // Route it to a visible editable textarea before adding anything to the draft.
  search.addEventListener('paste', event => {
    const text = event.clipboardData?.getData('text/plain') || '';
    const parsed = parseOrderPaste(text);
    if (parsed.entries.length < 2 && !/[\t\r\n]/.test(text)) return;
    event.preventDefault();
    bulkInput.closest('details').open = true;
    bulkInput.value = text;
    bulkInput.focus();
    showBulkStatus('已帶入貼上內容。確認後按「批次加入訂單」。');
  });

  bulkButton.addEventListener('click', () => {
    const parsed = parseOrderPaste(bulkInput.value);
    if (!parsed.entries.length) {
      showBulkStatus(parsed.errors.map(item => '第 ' + item.line + ' 行：' + item.message).join('\n') || '請先貼上 SKU。', true);
      return;
    }
    bulkButton.disabled = true;
    try {
      const result = adapter.addEntries(parsed.entries);
      const details = [
        result.message,
        parsed.duplicates.length ? '重複輸入已略過：' + parsed.duplicates.join('、') : '',
        ...parsed.errors.map(item => '第 ' + item.line + ' 行未加入：' + item.message),
      ].filter(Boolean);
      showBulkStatus(details.join('\n'), !result.ok || parsed.errors.length > 0 || result.rejected > 0);
    } catch (error) {
      showBulkStatus('批次加入失敗：' + (error?.message || error), true);
    } finally {
      bulkButton.disabled = false;
    }
  });
  bulkInput.addEventListener('keydown', event => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      bulkButton.click();
    }
  });
  updateDate();
  return Object.freeze({ updateDate });
}

if (typeof window !== 'undefined') window.SupplyWorkbenchTools = Object.freeze({ mountWorkbenchTools });

const PRODUCT_WORKBOOK_URL = 'https://24466647-my.sharepoint.com/:x:/r/personal/hongren_petlifeco_com/_layouts/15/Doc.aspx?sourcedoc=%7BE5CC3B4A-0A68-44FC-B4BA-8A535837639D%7D&file=20260324%25u7f8e%25u570b%25u7522%25u54c1%25u8cc7%25u8a0a%20JAM%20chuy%25u1ec3n%20%25u0111%25u00e0i%20loan.xlsx&fromShare=true&action=default&mobileredirect=true';

/** Add Supply's source-file shortcut while preserving the shared catalog review flow. */
export function watchProductWorkbookEntry(documentRef = document) {
  function mount() {
    const dialog = documentRef.getElementById('productUpdateDialog');
    const input = dialog?.querySelector('[data-product-update-raw-file]');
    const intro = dialog?.querySelector('.product-update-intro');
    if (!input || !intro) return false;
    if (dialog.querySelector('[data-product-workbook-drop]')) return true;
    const source = documentRef.createElement('a');
    source.href = PRODUCT_WORKBOOK_URL;
    source.target = '_blank';
    source.rel = 'noopener noreferrer';
    source.className = 'workbenchWorkbookSource';
    source.dataset.productWorkbookSource = '';
    source.textContent = '開啟／下載原始產品資訊 Excel（SharePoint）';

    const hint = documentRef.createElement('p');
    hint.textContent = '先到 SharePoint 下載最新 Excel，再拖入下方或點選檔案。讀取後會顯示變更預覽。';
    const drop = documentRef.createElement('button');
    drop.type = 'button';
    drop.className = 'workbenchWorkbookDrop';
    drop.dataset.productWorkbookDrop = '';
    drop.textContent = '將產品資訊 Excel 拖到這裡，或點此選擇';
    drop.setAttribute('aria-label', '拖放或選擇產品資訊 Excel');
    intro.insertBefore(source, input.closest('label'));
    intro.insertBefore(hint, input.closest('label'));
    intro.insertBefore(drop, input.closest('label'));
    const status = dialog.querySelector('[data-product-update-message]');
    let busy = false;
    const setBusy = value => {
      busy = value;
      drop.disabled = value;
      input.disabled = value;
      drop.setAttribute('aria-busy', String(value));
      drop.textContent = value ? '正在讀取 Excel…' : '將產品資訊 Excel 拖到這裡，或點此選擇';
    };
    const error = text => { status.textContent = text; status.dataset.state = 'error'; };
    drop.addEventListener('click', () => { if (!busy) input.click(); });
    input.addEventListener('change', event => {
      if (busy) { event.stopImmediatePropagation(); return; }
      if (input.files?.length) setBusy(true);
    }, true);
    new MutationObserver(() => {
      if (busy && !/^正在/.test(status.textContent)) setBusy(false);
    }).observe(status, { childList:true, characterData:true, subtree:true, attributes:true, attributeFilter:['data-state'] });
    let dragDepth = 0;
    for (const type of ['dragenter', 'dragover', 'dragleave', 'drop']) {
      drop.addEventListener(type, event => {
        event.preventDefault();
        event.stopPropagation();
        if (type === 'dragenter') dragDepth += 1;
        if (type === 'dragleave') dragDepth = Math.max(0, dragDepth - 1);
        if (type === 'dragover' && event.dataTransfer) event.dataTransfer.dropEffect = busy ? 'none' : 'copy';
        drop.classList.toggle('is-dragging', !busy && dragDepth > 0);
        if (type !== 'drop') return;
        dragDepth = 0;
        drop.classList.remove('is-dragging');
        if (busy) return;
        const files = Array.from(event.dataTransfer?.files || []);
        if (files.length !== 1) { error('請一次拖入一個產品資訊 Excel。'); return; }
        if (!/\.(xlsx|xlsm|xls)$/i.test(files[0].name)) { error('請選擇 .xlsx、.xlsm 或 .xls 格式的產品資訊 Excel。'); return; }
        try {
          // Reuse the shared entry's validated change handler, including error cleanup.
          const transfer = new DataTransfer();
          transfer.items.add(files[0]);
          input.files = transfer.files;
          input.dispatchEvent(new Event('change', { bubbles:true }));
        } catch (_) {
          setBusy(false);
          error('此瀏覽器無法拖放檔案，請點「選擇原始產品資訊 Excel」。');
        }
      });
    }
    return true;
  }
  if (mount()) return;
  const observer = new MutationObserver(() => { if (mount()) observer.disconnect(); });
  observer.observe(documentRef.documentElement, { childList:true, subtree:true });
}
if (typeof document !== 'undefined') watchProductWorkbookEntry(document);
