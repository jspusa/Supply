import {
  WORKSPACE_IDS,
  canonicalWorkspaceId,
  projectTodaySummary,
  resolveInitialWorkspace,
  workspaceHash,
} from './workspace-navigation.js';

const WORKSPACE_LABELS = Object.freeze({
  data:'資料',
  recommendations:'今日建議',
  orders:'訂單',
  'sku-tree':'SKU 決策樹',
  analysis:'資料分析',
});
const NAV_ITEMS = Object.freeze(WORKSPACE_IDS.map(id => Object.freeze({ id, label:WORKSPACE_LABELS[id] })));

function navigationMarkup() {
  return `<header class="app-header supplyWorkspaceHeader">
    <div class="header-inner">
      <div class="brand" aria-label="補貨工作台">
        <div class="brand-mark" aria-hidden="true">J</div>
        <div class="brand-copy"><strong>補貨工作台</strong><span>Jasper Pet Care Products, Inc.</span></div>
      </div>
      <nav class="workspaceTopNav top-tabs" aria-label="主要工作區">
        <div class="workspaceNavTabs" role="tablist" aria-label="Supply 工作區">
          ${NAV_ITEMS.map(({ id, label }, index) => `<button type="button" class="workspaceNavTab top-tab" role="tab" data-workspace="${id}" aria-selected="${index === 0 ? 'true' : 'false'}" tabindex="${index === 0 ? '0' : '-1'}">${label}</button>`).join('')}
        </div>
      </nav>
      <span class="header-meta">Supply</span>
    </div>
  </header>`;
}

function todayMarkup() {
  return `<section class="todayWorkspaceSummary" id="todayWorkspaceSummary" data-workspace-panel="recommendations" aria-live="polite">
    <div class="todaySummaryHeader">
      <div><p class="eyebrow">Today</p><h2>今天先做什麼</h2></div>
      <span class="pill" id="todaySummaryState">等待資料</span>
    </div>
    <div class="todaySummaryGrid">
      <div class="todayMetric"><div class="todayMetricLabel">來源就緒</div><div class="todayMetricValue" id="todaySourceReadiness">0 / 3</div><div class="todayMetricHint" id="todaySourceReadinessHint">等待 H10、JAM、JSP</div></div>
      <div class="todayMetric"><div class="todayMetricLabel">Priority</div><div class="todayMetricValue" id="todayPriorityCount">0</div><div class="todayMetricHint">今日優先品項</div></div>
      <div class="todayMetric"><div class="todayMetricLabel">Velocity Risk</div><div class="todayMetricValue" id="todayVelocityRiskCount">0</div><div class="todayMetricHint">需核對速度證據</div></div>
      <div class="todayMetric"><div class="todayMetricLabel">Orders</div><div class="todayMetricValue" id="todayOrderGroupTotal">0</div><div class="todayMetricHint" id="todayOrderGroupCounts">越南 0 · 台灣 0 · 委外 0</div></div>
    </div>
    <div class="todayRiskExplanation" id="todayHighestRisk" data-state="empty">目前沒有可說明的 Velocity Risk。</div>
    <div class="todayActionRow"><div class="todayActionReason" id="todayNextActionReason">尚未讀取資料。</div><button type="button" class="todayNextAction" id="todayNextAction">開始準備資料</button></div>
  </section>`;
}

function requiredElement(documentRef, id) {
  const element = documentRef.getElementById(id);
  if (!element) throw new Error(`Workspace UI requires #${id}`);
  return element;
}

export function createWorkspaceUi({
  getSummaryInput,
  onWorkspaceChanged = () => {},
  documentRef = globalThis.document,
  windowRef = globalThis.window,
} = {}) {
  if (typeof getSummaryInput !== 'function') throw new TypeError('getSummaryInput must be a function');
  if (typeof onWorkspaceChanged !== 'function') throw new TypeError('onWorkspaceChanged must be a function');
  if (!documentRef || !windowRef) throw new TypeError('Workspace UI requires a browser document and window');

  let activeWorkspace = 'data';
  let restoredPreference = null;
  let mounted = false;
  let wired = false;

  function mount() {
    if (mounted) return;
    requiredElement(documentRef, 'workspaceNavMount').innerHTML = navigationMarkup();
    requiredElement(documentRef, 'todayWorkspaceMount').innerHTML = todayMarkup();
    mounted = true;
  }

  function setText(id, value) {
    const element = documentRef.getElementById(id);
    if (element) element.textContent = String(value);
  }

  function renderToday() {
    if (!mounted) return null;
    const summary = projectTodaySummary(getSummaryInput() || {});
    const { readiness } = summary;
    setText('todaySourceReadiness', `${readiness.ready} / ${readiness.total}`);
    setText(
      'todaySourceReadinessHint',
      readiness.state === 'ready'
        ? 'H10、JAM、JSP 已就緒'
        : readiness.state === 'empty'
          ? '等待 H10、JAM、JSP'
          : `尚缺 ${readiness.missing} 個來源`,
    );
    setText('todayPriorityCount', summary.priorityCount);
    setText('todayVelocityRiskCount', summary.velocityRiskCount);
    setText('todayOrderGroupTotal', summary.groupCounts.total);
    setText('todayOrderGroupCounts', `越南 ${summary.groupCounts.vietnam} · 台灣 ${summary.groupCounts.taiwan} · 委外 ${summary.groupCounts.subcontract}`);
    setText(
      'todaySummaryState',
      summary.status === 'ready'
        ? '可開始'
        : summary.status === 'incomplete'
          ? '資料未齊'
          : summary.status === 'invalid'
            ? '資料需確認'
            : '等待資料',
    );
    const risk = documentRef.getElementById('todayHighestRisk');
    if (risk) {
      risk.textContent = summary.highestPriorityVelocityRisk?.text || '目前沒有可說明的 Velocity Risk。';
      risk.dataset.state = summary.highestPriorityVelocityRisk ? 'risk' : 'empty';
    }
    setText('todayNextActionReason', summary.nextAction.reason);
    const action = documentRef.getElementById('todayNextAction');
    if (action) {
      action.textContent = summary.nextAction.label;
      action.dataset.workspace = summary.nextAction.workspace;
      action.dataset.targetId = summary.nextAction.targetId || '';
    }
    return summary;
  }

  function activate(workspace, {
    historyMode = 'push',
    focus = false,
    scroll = false,
    userInitiated = false,
  } = {}) {
    if (!mounted) throw new Error('Workspace UI must be started before activation');
    workspace = canonicalWorkspaceId(workspace) || 'data';
    activeWorkspace = workspace;
    restoredPreference = workspace;
    let selectedTab = null;
    documentRef.querySelectorAll('.workspaceNavTab[data-workspace]').forEach(button => {
      const selected = button.dataset.workspace === workspace;
      button.setAttribute('aria-selected', selected ? 'true' : 'false');
      button.tabIndex = selected ? 0 : -1;
      if (selected) selectedTab = button;
    });
    documentRef.querySelectorAll('[data-workspace-panel]').forEach(panel => {
      const additionalWorkspaces = String(panel.dataset.workspacePanelAlso || '').split(/\s+/).filter(Boolean);
      panel.hidden = panel.dataset.workspacePanel !== workspace && !additionalWorkspaces.includes(workspace);
    });
    const canonicalHash = workspaceHash(workspace);
    if (historyMode !== 'none') {
      const method = historyMode === 'replace' ? 'replaceState' : 'pushState';
      const nextUrl = windowRef.location.pathname + windowRef.location.search + canonicalHash;
      if (historyMode === 'replace' || windowRef.location.hash !== canonicalHash) {
        windowRef.history[method]({ workspace }, '', nextUrl);
      }
    }
    if (focus) selectedTab?.focus({ preventScroll:true });
    if (scroll) {
      const reduced = windowRef.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
      documentRef.querySelector('.workspaceTopNav')?.scrollIntoView({ behavior:reduced ? 'auto' : 'smooth', block:'start' });
    }
    documentRef.documentElement.dataset.activeWorkspace = workspace;
    renderToday();
    if (wired) onWorkspaceChanged({ workspace, userInitiated });
    return workspace;
  }

  function syncFromLocation() {
    const workspace = resolveInitialWorkspace({
      url:windowRef.location.href,
      preference:restoredPreference,
    });
    return activate(workspace, {
      historyMode:windowRef.location.hash === workspaceHash(workspace) ? 'none' : 'replace',
    });
  }

  function wire() {
    if (wired) return;
    const tabs = Array.from(documentRef.querySelectorAll('.workspaceNavTab[data-workspace]'));
    tabs.forEach(button => button.addEventListener('click', () => activate(button.dataset.workspace, {
      historyMode:'push',
      scroll:true,
      userInitiated:true,
    })));
    documentRef.querySelector('.workspaceNavTabs')?.addEventListener('keydown', event => {
      const current = tabs.indexOf(documentRef.activeElement);
      if (current < 0 || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? tabs.length - 1
          : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      activate(tabs[next].dataset.workspace, {
        historyMode:'push',
        focus:true,
        scroll:true,
        userInitiated:true,
      });
    });
    documentRef.getElementById('todayNextAction')?.addEventListener('click', event => {
      const targetId = event.currentTarget.dataset.targetId || '';
      activate(
        event.currentTarget.dataset.workspace || 'data',
        { historyMode:'push', focus:true, scroll:!targetId, userInitiated:true },
      );
      if (targetId) {
        const reduced = windowRef.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
        documentRef.getElementById(targetId)?.scrollIntoView({ behavior:reduced ? 'auto' : 'smooth', block:'start' });
      }
    });
    windowRef.addEventListener('popstate', syncFromLocation);
    windowRef.addEventListener('hashchange', syncFromLocation);
    wired = true;
  }

  function start({ preference = null } = {}) {
    mount();
    restoredPreference = canonicalWorkspaceId(preference);
    const initial = resolveInitialWorkspace({
      url:windowRef.location.href,
      preference:restoredPreference,
    });
    activate(initial, { historyMode:'replace' });
    wire();
    documentRef.documentElement.dataset.workspaceUiReady = 'true';
    return activeWorkspace;
  }

  return Object.freeze({
    start,
    activate,
    renderToday,
    getActiveWorkspace:() => activeWorkspace,
  });
}

const browserInterface = Object.freeze({ createWorkspaceUi });

if (typeof window !== 'undefined') window.SupplyWorkspaceUI = browserInterface;
