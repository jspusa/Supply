// THROWAWAY PROTOTYPE: Three FBA-styled Supply product-update layouts on the existing index route, switchable via ?variant=.

const params = new URLSearchParams(location.search);
if (params.get('prototype') !== 'fba-visual') throw new Error('Prototype route is not active');

const variants = Object.freeze({
  A:'雙欄審核',
  B:'逐步引導',
  C:'風險收件匣',
});
const variantKeys = Object.keys(variants);
const requestedVariant = String(params.get('variant') || 'A').toUpperCase();

const changes = Object.freeze([
  { id:'carton-1', sku:'1ABRD003A0', field:'每箱包數', before:'24 包', after:'20 包', source:'FBA 入庫確認', status:'safe', impact:'新訂單改用 20 包／箱；既有已釘選訂單不變。' },
  { id:'pallet-1', sku:'1AWDD070A0', field:'每棧板箱數', before:'48 箱', after:'44 箱', source:'產品資訊 Excel', status:'safe', impact:'每棧板數量由 1,152 改為 1,056。' },
  { id:'weight-1', sku:'1GBRD019A0', field:'箱重', before:'11.8 kg', after:'11.3 kg', source:'FBA 入庫確認', status:'safe', impact:'不影響需求歸屬或訂單數量。' },
  { id:'factory-1', sku:'1GCRD027A0', field:'標準工廠', before:'台灣', after:'越南', source:'產品資訊 Excel', status:'review', impact:'新訂單會改分到越南；已釘選的台灣訂單需個別確認。' },
  { id:'alias-1', sku:'7ABRD003A0', productSku:'1ABRD003A0', field:'下單品號包裝', before:'24 包／箱', after:'20 包／箱', source:'FBA 入庫確認', status:'review', impact:'委外訂單改用別名包裝；Product SKU 的需求歸屬不變。' },
  { id:'conflict-1', sku:'1GQRD027A0', field:'每箱數', before:'12／16（來源衝突）', after:'等待選擇', source:'Excel 第 18、42 列', status:'conflict', impact:'兩筆完整資料互相衝突，解決前不能發布。' },
]);

const draftRows = Object.freeze([
  { sku:'1ABRD003A0', orderSku:'1ABRD003A0', group:'越南', pallets:'10', packages:'11,520', coverage:'246 天', version:'v2026.08.12', assignment:'pinned', newer:true },
  { sku:'1AWDD070A0', orderSku:'1AWDD070A0', group:'台灣', pallets:'6.5', packages:'7,488', coverage:'181 天', version:'新預設', assignment:'default', newer:false },
  { sku:'1GCRD027A0', orderSku:'1GCRD027A0', group:'台灣', pallets:'4', packages:'4,608', coverage:'205 天', version:'v2026.08.10', assignment:'review', newer:true },
  { sku:'1ABRD003A0', orderSku:'7ABRD003A0', group:'委外', pallets:'2', packages:'1,920', coverage:'198 天', version:'v2026.08.25', assignment:'pinned', newer:false },
]);

const state = {
  variant:variantKeys.includes(requestedVariant) ? requestedVariant : 'A',
  workspace:'data',
  selected:new Set(changes.filter(change => change.status === 'safe').map(change => change.id)),
  modal:null,
  notice:'',
};

const stylesheet = document.createElement('link');
stylesheet.rel = 'stylesheet';
stylesheet.href = './prototypes/fba-visual-prototype.css';
document.head.appendChild(stylesheet);
document.body.classList.add('supplyFbaPrototypeActive');
document.title = 'Supply × FBA 視覺原型';

const mount = document.createElement('div');
mount.id = 'supplyFbaPrototype';
document.body.prepend(mount);

const escapeHtml = value => String(value ?? '')
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;');

function statusLabel(status) {
  if (status === 'safe') return '可直接套用';
  if (status === 'review') return '需要確認';
  return '來源衝突';
}

function selectedChanges() {
  return changes.filter(change => state.selected.has(change.id));
}

function updateVariant(nextVariant) {
  state.variant = variantKeys.includes(nextVariant) ? nextVariant : 'A';
  const next = new URL(location.href);
  next.searchParams.set('prototype', 'fba-visual');
  next.searchParams.set('variant', state.variant);
  history.replaceState({ prototype:'fba-visual', variant:state.variant }, '', next);
  render();
  window.scrollTo(0, 0);
}

function cycleVariant(direction) {
  const index = variantKeys.indexOf(state.variant);
  updateVariant(variantKeys[(index + direction + variantKeys.length) % variantKeys.length]);
}

function workspaceTabs() {
  const items = [
    ['data', '資料'],
    ['recommendations', '今日建議'],
    ['orders', '訂單'],
    ['sku-tree', 'SKU 決策樹'],
    ['analysis', '資料分析'],
  ];
  return items.map(([id, label]) => `<button type="button" class="prototypeTopTab${state.workspace === id ? ' active' : ''}" data-workspace="${id}"${state.workspace === id ? ' aria-current="page"' : ''}>${label}</button>`).join('');
}

function changeCheckbox(change, className = '') {
  const blocked = change.status === 'conflict';
  return `<label class="prototypeCheck ${className}">
    <input type="checkbox" data-change-id="${change.id}" ${state.selected.has(change.id) ? 'checked' : ''} ${blocked ? 'disabled' : ''}>
    <span aria-hidden="true"></span><span class="srOnly">選取 ${escapeHtml(change.sku)}</span>
  </label>`;
}

function compactDiff(change) {
  return `<div class="prototypeDiff"><span>${escapeHtml(change.before)}</span><b aria-hidden="true">→</b><strong>${escapeHtml(change.after)}</strong></div>`;
}

function changeTableRows() {
  return changes.map(change => `<tr data-status="${change.status}">
    <td>${changeCheckbox(change)}</td>
    <td><strong class="prototypeSku">${escapeHtml(change.sku)}</strong>${change.productSku ? `<small>產品 ${escapeHtml(change.productSku)}</small>` : ''}</td>
    <td><span class="prototypeStatus prototypeStatus--${change.status}">${statusLabel(change.status)}</span></td>
    <td><strong>${escapeHtml(change.field)}</strong><small>${escapeHtml(change.source)}</small></td>
    <td>${compactDiff(change)}</td>
    <td><button type="button" class="prototypeTextButton" data-action="details" data-change="${change.id}">詳細</button></td>
  </tr>`).join('');
}

function releaseSummary({ compact = false } = {}) {
  const selected = selectedChanges();
  return `<aside class="prototypeCard prototypeReleaseSummary${compact ? ' compact' : ''}">
    <div class="prototypeCardHeading"><div><p class="prototypeEyebrow">RELEASE PLAN</p><h2>準備發布</h2></div><span class="prototypeVersion">v2026.08.29</span></div>
    <dl class="prototypeSummaryStats">
      <div><dt>已選變更</dt><dd>${selected.length}</dd></div>
      <div><dt>需確認</dt><dd>${changes.filter(item => item.status === 'review').length}</dd></div>
      <div><dt>阻擋衝突</dt><dd class="danger">${changes.filter(item => item.status === 'conflict').length}</dd></div>
    </dl>
    <div class="prototypeAlignment"><span></span><div><strong>Supply 與 FBA 目前一致</strong><small>Catalog v2026.08.25 · 發布後會再次核對</small></div></div>
    <button type="button" class="prototypeButton primary full" data-action="publish-preview" ${selected.length === 0 ? 'disabled' : ''}>預覽發布 ${selected.length} 項</button>
    <p class="prototypeFinePrint">原型不會寫入 GitHub，也不會修改正式產品資料。</p>
  </aside>`;
}

function hero(copy) {
  return `<section class="prototypeHero">
    <div><p class="prototypeEyebrow">PRODUCT CATALOG</p><h1>更新產品資料</h1><p>${copy}</p></div>
    <div class="prototypeHeroActions"><button type="button" class="prototypeButton secondary" data-action="choose-file">選擇原始 Excel</button><button type="button" class="prototypeButton primary" data-action="use-example">使用範例資料</button></div>
  </section>`;
}

function variantA() {
  return `${hero('先看每一個 SKU 的舊值與新值，再用一次確認建立兩邊共用的新版產品資料。')}
    <div class="prototypeSourceStrip"><div><span class="prototypeSourceIcon">XLSX</span><div><strong>20260825 美國產品資訊.xlsx</strong><small>6 個 SKU 有變更 · 缺少欄位會保留原值</small></div></div><span class="prototypeStatus prototypeStatus--safe">預覽完成</span></div>
    <div class="prototypeLayoutA">
      <section class="prototypeCard prototypeChangeTableCard">
        <div class="prototypeCardHeading"><div><p class="prototypeEyebrow">VARIANT A</p><h2>逐列比較</h2></div><button type="button" class="prototypeTextButton" data-action="select-safe">只選安全變更</button></div>
        <div class="prototypeTableWrap"><table class="prototypeTable"><thead><tr><th></th><th>品號</th><th>狀態</th><th>變更欄位</th><th>舊值 → 新值</th><th></th></tr></thead><tbody>${changeTableRows()}</tbody></table></div>
      </section>
      ${releaseSummary()}
    </div>`;
}

function variantB() {
  const reviewChanges = changes.filter(change => change.status !== 'conflict');
  return `${hero('像完成入庫流程一樣逐步前進：讀取、審核、確認受影響工作，最後才準備發布。')}
    <ol class="prototypeStepper" aria-label="更新進度">
      <li class="done"><span>1</span><div><strong>讀取資料</strong><small>已完成</small></div></li>
      <li class="active"><span>2</span><div><strong>審核變更</strong><small>${selectedChanges().length}／${reviewChanges.length} 已選</small></div></li>
      <li><span>3</span><div><strong>影響確認</strong><small>3 筆既有工作</small></div></li>
      <li><span>4</span><div><strong>準備發布</strong><small>等待前一步</small></div></li>
    </ol>
    <section class="prototypeCard prototypeGuidedPanel">
      <div class="prototypeGuidedIntro"><div><p class="prototypeEyebrow">VARIANT B · STEP 2</p><h2>審核這批變更</h2><p>安全變更已預選；工廠和下單品號需要你自己勾選。</p></div><span class="prototypeCountRing">${selectedChanges().length}<small>已選</small></span></div>
      <div class="prototypeGuidedList">${reviewChanges.map(change => `<article class="prototypeGuidedChange" data-status="${change.status}">${changeCheckbox(change)}<div class="prototypeGuidedCopy"><div><strong>${escapeHtml(change.sku)}</strong><span class="prototypeStatus prototypeStatus--${change.status}">${statusLabel(change.status)}</span></div><h3>${escapeHtml(change.field)}</h3>${compactDiff(change)}<p>${escapeHtml(change.impact)}</p></div><button type="button" class="prototypeTextButton" data-action="details" data-change="${change.id}">查看影響</button></article>`).join('')}</div>
      <div class="prototypeBlockedNotice"><span>!</span><div><strong>還有 1 個來源衝突</strong><p>1GQRD027A0 的每箱數有兩個完整值；解決前不會進入發布。</p></div><button type="button" class="prototypeButton secondary" data-action="details" data-change="conflict-1">處理衝突</button></div>
      <div class="prototypeGuidedFooter"><button type="button" class="prototypeButton secondary" data-action="choose-file">返回檔案</button><button type="button" class="prototypeButton primary" data-action="publish-preview">下一步：查看影響</button></div>
    </section>`;
}

function riskColumn(status, title, description) {
  const rows = changes.filter(change => change.status === status);
  return `<section class="prototypeRiskColumn" data-status="${status}"><header><div><h2>${title}</h2><p>${description}</p></div><span>${rows.length}</span></header><div class="prototypeRiskStack">${rows.map(change => `<article class="prototypeRiskCard">${changeCheckbox(change)}<div class="prototypeRiskCopy"><strong>${escapeHtml(change.sku)}</strong><small>${escapeHtml(change.field)}</small>${compactDiff(change)}<p>${escapeHtml(change.impact)}</p><button type="button" class="prototypeTextButton" data-action="details" data-change="${change.id}">展開完整資料</button></div></article>`).join('')}</div></section>`;
}

function variantC() {
  return `${hero('把變更先按風險分流；你只需要把注意力放在需要確認與來源衝突的品號。')}
    <div class="prototypeInboxSummary"><div><p class="prototypeEyebrow">VARIANT C</p><h2>變更收件匣</h2></div><div><button type="button" class="prototypeButton secondary" data-action="select-safe">重設安全預選</button><span>基準 v2026.08.25</span></div></div>
    <div class="prototypeRiskBoard">
      ${riskColumn('safe', '可以套用', '一般包裝資料，已預選')}
      ${riskColumn('review', '需要你確認', '會改變工廠或下單包裝')}
      ${riskColumn('conflict', '必須先處理', '完整來源互相衝突')}
    </div>
    <div class="prototypeActionShelf"><div><strong>${selectedChanges().length} 項準備進入預覽</strong><span>衝突不會被選取，也不能略過。</span></div><button type="button" class="prototypeButton primary" data-action="publish-preview">檢查選取項目</button></div>`;
}

function coverageMeter(days, band) {
  const width = Math.min(100, Math.max(5, (Number(days) / 365) * 100));
  return `<div class="prototypeCoverage" data-band="${band}"><div><strong>${days} 天</strong><span>${band === 'healthy' ? '健康' : band === 'low' ? '不足' : '過高'}</span></div><div class="prototypeCoverageTrack"><span style="width:${width}%"></span><i></i></div></div>`;
}

function ordersWorkspace() {
  return `<section class="prototypeWorkspaceHero"><div><p class="prototypeEyebrow">ORDERS</p><h1>訂單產生器</h1><p>越南、台灣、委外 · 包裝版本跟著每一筆訂單走。</p></div><button type="button" class="prototypeButton primary">匯出訂單 Excel</button></section>
    <section class="prototypeCard prototypeOrdersCard"><div class="prototypeCardHeading"><div><h2>越南訂單</h2><p>4 個品項 · 22.5 棧板</p></div><div class="prototypeSegment"><button class="active">越南</button><button>台灣</button><button>委外</button></div></div>
    <div class="prototypeTableWrap"><table class="prototypeTable prototypeOrderTable"><thead><tr><th>順序</th><th>品號</th><th>包／袋盒數</th><th>棧板數</th><th>含舊訂單可售天數</th><th>新訂單到港後總可售天數</th><th>包裝版本</th><th></th></tr></thead><tbody>${draftRows.map((row, index) => `<tr><td><span class="prototypeDrag">⋮⋮</span> ${index + 1}</td><td><strong>${row.sku}</strong>${row.orderSku !== row.sku ? `<small>下單 ${row.orderSku}</small>` : ''}</td><td><strong>${row.packages}</strong><small>包</small></td><td><label class="prototypeNumber"><input type="number" value="${row.pallets}" step="0.5"><span>板</span></label></td><td>${coverageMeter(index === 0 ? 512 : index === 1 ? 142 : 202, index === 0 ? 'excess' : index === 1 ? 'low' : 'healthy')}</td><td>${coverageMeter(Number.parseInt(row.coverage), 'healthy')}</td><td><span class="prototypeVersionBadge" data-state="${row.assignment}">${row.version}</span>${row.newer ? '<small class="prototypeNewer">有新版可用</small>' : ''}</td><td><button type="button" class="prototypeIconButton" aria-label="檢視包裝版本" data-action="review-version" data-row="${index}">•••</button></td></tr>`).join('')}</tbody></table></div></section>`;
}

function recommendationsWorkspace() {
  const metrics = [['來源就緒','3 / 3','H10、JAM、JSP'],['今日優先','30','先看可能缺貨'],['建議下單','117','已排除停產品'],['Velocity Risk','6','需核對速度證據']];
  return `<section class="prototypeWorkspaceHero"><div><p class="prototypeEyebrow">TODAY</p><h1>今天先做什麼</h1><p>資料已就緒，先處理缺貨風險最高的品項。</p></div><button type="button" class="prototypeButton primary">查看第一個品項</button></section><div class="prototypeMetricGrid">${metrics.map(item => `<article class="prototypeCard prototypeMetric"><span>${item[0]}</span><strong>${item[1]}</strong><small>${item[2]}</small></article>`).join('')}</div><section class="prototypeCard prototypePriority"><div><span class="prototypeStatus prototypeStatus--review">Velocity Risk</span><h2>1ABRD003A0 需要先核對</h2><p>H10 Source Velocity 6.4，Planning Velocity 10。低庫存可能讓近期銷量被低估。</p></div><button type="button" class="prototypeButton secondary">查看計算</button></section>`;
}

function skuTreeWorkspace() {
  return `<section class="prototypeWorkspaceHero"><div><p class="prototypeEyebrow">SKU DECISION TREE</p><h1>SKU 決策樹</h1><p>把銷售、庫存與一板可售天數拆成可追蹤的決策。</p></div><button type="button" class="prototypeButton primary">加入品號</button></section><section class="prototypeCard prototypeTree"><div class="prototypeTreeNode"><span>1</span><div><strong>1GCRD027A0</strong><p>一板約可銷售 402 天</p></div></div><i></i><div class="prototypeTreeNode warning"><span>2</span><div><strong>是否建議停產？</strong><p>超過 365 天，進入停產候選清單。</p></div></div><i></i><div class="prototypeTreeNode final"><span>3</span><div><strong>先停止自動建議</strong><p>保留歷史資料，確認生命週期後才正式退役。</p></div></div></section>`;
}

function analysisWorkspace() {
  return `<section class="prototypeWorkspaceHero"><div><p class="prototypeEyebrow">ANALYSIS</p><h1>資料分析</h1><p>集中查看熱銷、新品、缺貨月份與建議停產品項。</p></div><button type="button" class="prototypeButton secondary">匯出分析</button></section><div class="prototypeAnalysisGrid"><article class="prototypeCard"><span>熱銷品</span><strong>43</strong><p>使用至少 10／天的規劃速度保護。</p></article><article class="prototypeCard"><span>建議停產</span><strong>17</strong><p>一板可售超過 365 天。</p></article><article class="prototypeCard prototypeChart"><span>未來六個月缺貨分布</span><div><i style="height:42%"></i><i style="height:68%"></i><i style="height:88%"></i><i style="height:54%"></i><i style="height:35%"></i><i style="height:24%"></i></div></article></div>`;
}

function dataWorkspace() {
  if (state.variant === 'B') return variantB();
  if (state.variant === 'C') return variantC();
  return variantA();
}

function workspaceContent() {
  if (state.workspace === 'orders') return ordersWorkspace();
  if (state.workspace === 'recommendations') return recommendationsWorkspace();
  if (state.workspace === 'sku-tree') return skuTreeWorkspace();
  if (state.workspace === 'analysis') return analysisWorkspace();
  return dataWorkspace();
}

function prototypeStatePanel() {
  return `<details class="prototypeStatePanel"><summary>查看原型目前狀態</summary><div><span>方案：${state.variant} — ${variants[state.variant]}</span><span>工作區：${state.workspace}</span><span>基準版本：v2026.08.25</span><span>新版本：v2026.08.29</span><span>已選：${selectedChanges().map(change => change.sku).join('、') || '無'}</span><span>已釘選訂單：2</span><span>需審核既有工作：3</span><span>阻擋衝突：1</span></div></details>`;
}

function modalMarkup() {
  if (!state.modal) return '';
  if (state.modal.type === 'details') {
    const change = changes.find(item => item.id === state.modal.id);
    return `<div class="prototypeModalBackdrop" role="presentation" data-action="close-modal"><section class="prototypeModal" role="dialog" aria-modal="true" aria-labelledby="prototypeModalTitle"><button class="prototypeModalClose" data-action="close-modal" aria-label="關閉">×</button><p class="prototypeEyebrow">CHANGE DETAIL</p><h2 id="prototypeModalTitle">${escapeHtml(change.sku)} · ${escapeHtml(change.field)}</h2>${compactDiff(change)}<div class="prototypeImpact"><strong>會發生什麼？</strong><p>${escapeHtml(change.impact)}</p></div><div class="prototypeModalActions"><button class="prototypeButton secondary" data-action="close-modal">關閉</button>${change.status !== 'conflict' ? `<button class="prototypeButton primary" data-action="toggle-change" data-change="${change.id}">${state.selected.has(change.id) ? '取消選取' : '選取這項'}</button>` : '<button class="prototypeButton primary" disabled>需要先選擇正確來源</button>'}</div></section></div>`;
  }
  if (state.modal.type === 'version') {
    const row = draftRows[state.modal.index];
    return `<div class="prototypeModalBackdrop" role="presentation" data-action="close-modal"><section class="prototypeModal" role="dialog" aria-modal="true" aria-labelledby="prototypeModalTitle"><button class="prototypeModalClose" data-action="close-modal" aria-label="關閉">×</button><p class="prototypeEyebrow">PACKAGING VERSION</p><h2 id="prototypeModalTitle">${escapeHtml(row.sku)} 的包裝版本</h2><div class="prototypeVersionCompare"><article><span>目前訂單</span><strong>${row.version}</strong><p>10 板 · 11,520 包 · 到港後 246 天</p></article><b>→</b><article><span>最新預設</span><strong>v2026.08.25</strong><p>10.5 板 · 10,080 包 · 到港後 228 天</p></article></div><div class="prototypeImpact"><strong>不會自動變更</strong><p>這筆訂單已釘選。只有你確認後才會改用新包裝與重新計算棧板數。</p></div><div class="prototypeModalActions"><button class="prototypeButton secondary" data-action="close-modal">保留目前版本</button><button class="prototypeButton primary" data-action="simulate-version">預覽套用新版</button></div></section></div>`;
  }
  const selected = selectedChanges();
  return `<div class="prototypeModalBackdrop" role="presentation" data-action="close-modal"><section class="prototypeModal" role="dialog" aria-modal="true" aria-labelledby="prototypeModalTitle"><button class="prototypeModalClose" data-action="close-modal" aria-label="關閉">×</button><p class="prototypeEyebrow">PUBLISH PREVIEW</p><h2 id="prototypeModalTitle">準備建立 v2026.08.29</h2><ul class="prototypePublishList">${selected.map(change => `<li><strong>${escapeHtml(change.sku)}</strong><span>${escapeHtml(change.field)}：${escapeHtml(change.before)} → ${escapeHtml(change.after)}</span></li>`).join('')}</ul><div class="prototypeImpact"><strong>正式流程會做什麼？</strong><p>建立 Supply 主檔、產生 FBA 投影、驗證兩邊版本與內容，再由本機發布流程一次更新兩個網站。</p></div><div class="prototypeModalActions"><button class="prototypeButton secondary" data-action="close-modal">返回調整</button><button class="prototypeButton primary" data-action="simulate-publish">確認原型流程</button></div></section></div>`;
}

function render() {
  mount.innerHTML = `<div class="prototypeOnlyBanner">THROWAWAY UI PROTOTYPE · 不會修改正式資料</div>
    <header class="prototypeAppHeader"><div class="prototypeHeaderInner"><div class="prototypeBrand"><div class="prototypeBrandMark">J</div><div><strong>補貨工作台</strong><span>Jasper Pet Care Products, Inc.</span></div></div><nav class="prototypeTopTabs" aria-label="Supply 功能選單">${workspaceTabs()}</nav><button type="button" class="prototypeNewBatch" data-action="new-batch">開始新批次</button></div></header>
    <main class="prototypeMain">${state.notice ? `<div class="prototypeNotice" role="status">${escapeHtml(state.notice)}<button data-action="dismiss-notice" aria-label="關閉">×</button></div>` : ''}${workspaceContent()}${prototypeStatePanel()}</main>
    <div class="prototypeSwitcher" role="group" aria-label="原型方案切換"><button type="button" data-action="previous-variant" aria-label="上一個方案">←</button><strong>${state.variant} — ${variants[state.variant]}</strong><button type="button" data-action="next-variant" aria-label="下一個方案">→</button></div>
    ${modalMarkup()}`;
}

mount.addEventListener('change', event => {
  const input = event.target.closest('input[data-change-id]');
  if (!input) return;
  if (input.checked) state.selected.add(input.dataset.changeId);
  else state.selected.delete(input.dataset.changeId);
  render();
});

mount.addEventListener('click', event => {
  const workspace = event.target.closest('[data-workspace]');
  if (workspace) {
    state.workspace = workspace.dataset.workspace;
    render();
    window.scrollTo(0, 0);
    return;
  }
  const action = event.target.closest('[data-action]');
  if (!action) return;
  if (action.dataset.action === 'previous-variant') return cycleVariant(-1);
  if (action.dataset.action === 'next-variant') return cycleVariant(1);
  if (action.dataset.action === 'select-safe') {
    state.selected = new Set(changes.filter(change => change.status === 'safe').map(change => change.id));
    state.notice = '已恢復安全變更預選；需要確認與衝突項目仍未選取。';
  }
  if (action.dataset.action === 'details') state.modal = { type:'details', id:action.dataset.change };
  if (action.dataset.action === 'review-version') state.modal = { type:'version', index:Number(action.dataset.row) };
  if (action.dataset.action === 'publish-preview') state.modal = { type:'publish' };
  if (action.dataset.action === 'toggle-change') {
    if (state.selected.has(action.dataset.change)) state.selected.delete(action.dataset.change);
    else state.selected.add(action.dataset.change);
    state.modal = null;
  }
  if (action.dataset.action === 'simulate-publish') {
    state.modal = null;
    state.notice = '原型確認完成：正式版本才會交給本機發布流程，這裡沒有修改任何資料。';
  }
  if (action.dataset.action === 'simulate-version') {
    state.modal = null;
    state.notice = '已顯示新版影響；原型不會改動這筆已釘選訂單。';
  }
  if (action.dataset.action === 'close-modal' && (action === event.target || action.classList.contains('prototypeModalClose') || action.matches('button'))) state.modal = null;
  if (action.dataset.action === 'choose-file') state.notice = '原型使用固定範例，不會開啟或保存你的真實檔案。';
  if (action.dataset.action === 'use-example') state.notice = '已載入原型範例：3 項安全、2 項需確認、1 項來源衝突。';
  if (action.dataset.action === 'new-batch') state.notice = '正式版本會先確認再清除；原型不會清除瀏覽器裡的 Supply 資料。';
  if (action.dataset.action === 'dismiss-notice') state.notice = '';
  render();
});

window.addEventListener('keydown', event => {
  if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
  if (event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
  event.preventDefault();
  cycleVariant(event.key === 'ArrowRight' ? 1 : -1);
});

render();
