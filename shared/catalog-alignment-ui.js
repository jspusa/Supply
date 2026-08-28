/* Catalog Alignment runtime UI. Generated copies must remain byte-identical. */
(function initCatalogAlignmentUi(root, factory) {
  const contract = typeof module === 'object' && module.exports
    ? require('./catalog-alignment-status.js')
    : root?.JSPCatalogAlignment;
  const api = factory(contract, root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.JSPCatalogAlignmentUI = api;
})(typeof globalThis === 'object' ? globalThis : this, function createCatalogAlignmentUiApi(contract, root) {
  'use strict';

  if (!contract?.evaluateCatalogAlignmentManifests || !contract?.validateCatalogAlignmentManifest) {
    throw new Error('Catalog Alignment UI requires the compact manifest consumer contract');
  }

  const STATUS_SCHEMA_VERSION = 1;
  const STATUS_STATES = new Set(['pending', 'aligned', 'failed']);
  const SITES = Object.freeze(['supply', 'fba']);
  const STATUS_KEYS = [
    'catalogVersion',
    'issues',
    'localSite',
    'observedAt',
    'peerSite',
    'retrySites',
    'schemaVersion',
    'stale',
    'state',
  ];
  const ISSUE_KEYS = ['code', 'site'];
  const RECOVERY_MODE = 'local-release-workflow';

  class CatalogAlignmentUiError extends Error {
    constructor(code, message) {
      super(message);
      this.name = 'CatalogAlignmentUiError';
      this.code = code;
    }
  }

  const fail = (code, message) => { throw new CatalogAlignmentUiError(code, message); };
  const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  const exactKeys = (value, expected) => isRecord(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
  const otherSite = site => site === 'supply' ? 'fba' : 'supply';

  function deepFreeze(value) {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
    return value;
  }

  function normalizedSite(value) {
    const site = String(value || '').trim().toLowerCase();
    if (!SITES.includes(site)) fail('INVALID_SITE', 'Catalog Alignment UI site must be supply or fba');
    return site;
  }

  function normalizedTimestamp(value) {
    const timestamp = typeof value === 'string' ? value : '';
    if (Number.isNaN(Date.parse(timestamp)) || new Date(timestamp).toISOString() !== timestamp) {
      fail('INVALID_TIMESTAMP', 'Catalog Alignment status observedAt must be an exact ISO timestamp');
    }
    return timestamp;
  }

  function normalizedManifestUrl(value, label) {
    const url = String(value || '').trim();
    if (!url) fail('INVALID_MANIFEST_URL', `${label} is required`);
    let pathname;
    try { pathname = new URL(url, 'https://catalog-alignment.invalid/').pathname; }
    catch { fail('INVALID_MANIFEST_URL', `${label} is invalid`); }
    if (!pathname.endsWith('/catalog-alignment.json')) {
      fail('INVALID_MANIFEST_URL', `${label} must point only to catalog-alignment.json`);
    }
    return url;
  }

  function compareCatalogVersions(left, right) {
    const parse = value => {
      const match = String(value || '').match(/^(\d{4}-\d{2}-\d{2})(?:\.(\d+))?$/);
      return match ? { day:match[1], sequence:Number(match[2] || 0) } : null;
    };
    const a = parse(left);
    const b = parse(right);
    if (!a || !b) return 0;
    if (a.day !== b.day) return a.day < b.day ? -1 : 1;
    return Math.sign(a.sequence - b.sequence);
  }

  function normalizeIssues(value) {
    if (!Array.isArray(value)) fail('INVALID_STATUS', 'Catalog Alignment status issues must be an array');
    return value.map(item => {
      if (!exactKeys(item, ISSUE_KEYS) || typeof item.code !== 'string' || !item.code.trim()) {
        fail('INVALID_STATUS', 'Catalog Alignment status contains an invalid issue');
      }
      const site = item.site === null ? null : normalizedSite(item.site);
      return { code:item.code.trim(), site };
    });
  }

  function validatePersistedStatus(input, expectedSite = null) {
    if (!exactKeys(input, STATUS_KEYS)) fail('INVALID_STATUS', 'Catalog Alignment persisted status has an unsupported shape');
    if (input.schemaVersion !== STATUS_SCHEMA_VERSION || !STATUS_STATES.has(input.state)) {
      fail('INVALID_STATUS', 'Catalog Alignment persisted status schema or state is unsupported');
    }
    const localSite = normalizedSite(input.localSite);
    if (expectedSite && localSite !== normalizedSite(expectedSite)) {
      fail('INVALID_STATUS', 'Catalog Alignment persisted status belongs to another site');
    }
    const peerSite = input.peerSite === null ? null : normalizedSite(input.peerSite);
    if (peerSite !== null && peerSite === localSite) fail('INVALID_STATUS', 'Catalog Alignment peer site must differ from local site');
    const retrySites = Array.isArray(input.retrySites)
      ? [...new Set(input.retrySites.map(normalizedSite))]
      : fail('INVALID_STATUS', 'Catalog Alignment retrySites must be an array');
    const catalogVersion = input.catalogVersion === null ? null : String(input.catalogVersion);
    if (catalogVersion !== null && !/^\d{4}-\d{2}-\d{2}(?:\.\d+)?$/.test(catalogVersion)) {
      fail('INVALID_STATUS', 'Catalog Alignment persisted catalogVersion is invalid');
    }
    return deepFreeze({
      schemaVersion: STATUS_SCHEMA_VERSION,
      state: input.state,
      catalogVersion,
      localSite,
      peerSite,
      issues: normalizeIssues(input.issues),
      retrySites,
      observedAt: normalizedTimestamp(input.observedAt),
      stale: Boolean(input.stale),
    });
  }

  function retrySitesFor(evaluation, localManifest, peerManifest, configuredSite) {
    if (evaluation.state !== 'failed') return [];
    const direct = evaluation.issues
      .filter(item => item.code === 'public-content-hash-mismatch' && item.site)
      .map(item => item.site);
    if (direct.length) return [...new Set(direct)];
    if (localManifest && peerManifest && localManifest.catalogVersion !== peerManifest.catalogVersion) {
      const comparison = compareCatalogVersions(localManifest.catalogVersion, peerManifest.catalogVersion);
      if (comparison > 0) return [peerManifest.site];
      if (comparison < 0) return [localManifest.site];
    }
    if (evaluation.issues.some(item => ['invalid-local-manifest', 'local-manifest-unavailable'].includes(item.code))) return [configuredSite];
    if (evaluation.issues.some(item => item.code === 'invalid-peer-manifest')) return [otherSite(configuredSite)];
    return [...SITES];
  }

  function statusFromEvaluation({ evaluation, localManifest, peerManifest, site, observedAt }) {
    const normalizedLocalSite = normalizedSite(site);
    return validatePersistedStatus({
      schemaVersion: STATUS_SCHEMA_VERSION,
      state: evaluation.state,
      catalogVersion: evaluation.catalogVersion,
      localSite: normalizedLocalSite,
      peerSite: peerManifest?.site || (evaluation.peerSite ?? null),
      issues: evaluation.issues.map(item => ({ code:item.code, site:item.site ?? null })),
      retrySites: retrySitesFor(evaluation, localManifest, peerManifest, normalizedLocalSite),
      observedAt,
      stale: false,
    }, normalizedLocalSite);
  }

  function storageKey(site) {
    return `jspusa:catalog-alignment-status:${normalizedSite(site)}:v1`;
  }

  function readPersistedStatus(storage, site) {
    if (!storage?.getItem) return null;
    try {
      const raw = storage.getItem(storageKey(site));
      return raw ? validatePersistedStatus(JSON.parse(raw), site) : null;
    } catch (_) {
      return null;
    }
  }

  function persistStatus(storage, status) {
    const validated = validatePersistedStatus(status, status.localSite);
    if (!storage?.setItem || !['aligned', 'failed'].includes(validated.state)) return validated;
    storage.setItem(storageKey(validated.localSite), JSON.stringify({ ...validated, stale:false }));
    return validated;
  }

  function retainPersistentFailure(current, persisted) {
    if (current.state !== 'pending' || persisted?.state !== 'failed') return current;
    return validatePersistedStatus({
      ...persisted,
      issues:[...persisted.issues, ...current.issues]
        .filter((item, index, list) => list.findIndex(candidate => candidate.code === item.code && candidate.site === item.site) === index),
      observedAt:current.observedAt,
      stale:true,
    }, current.localSite);
  }

  async function fetchCompactManifest(fetchImpl, url) {
    const response = await fetchImpl(url, { cache:'no-store', headers:{ accept:'application/json' } });
    if (!response?.ok) throw new Error(`Catalog Alignment manifest request failed (${response?.status || 'network'})`);
    return contract.validateCatalogAlignmentManifest(await response.json());
  }

  function createCatalogAlignmentController({
    site,
    localManifestUrl,
    peerManifestUrl,
    fetchImpl = root?.fetch?.bind(root),
    storage = root?.localStorage,
    eventTarget = root,
    now = () => new Date().toISOString(),
    onStatus = () => {},
  } = {}) {
    const localSite = normalizedSite(site);
    const localUrl = normalizedManifestUrl(localManifestUrl, 'localManifestUrl');
    const peerUrl = normalizedManifestUrl(peerManifestUrl, 'peerManifestUrl');
    if (typeof fetchImpl !== 'function') fail('FETCH_UNAVAILABLE', 'Catalog Alignment UI requires fetch');
    if (typeof now !== 'function' || typeof onStatus !== 'function') fail('INVALID_CONTROLLER', 'Catalog Alignment UI dependencies are invalid');
    let lastStatus = readPersistedStatus(storage, localSite);

    async function refresh() {
      const observedAt = normalizedTimestamp(now());
      let localManifest = null;
      let peerManifest = null;
      let evaluation;
      try {
        localManifest = await fetchCompactManifest(fetchImpl, localUrl);
        if (localManifest.site !== localSite) throw new Error('Local Catalog Alignment manifest belongs to another site');
      } catch (_) {
        evaluation = {
          state:'failed', catalogVersion:lastStatus?.catalogVersion || null,
          localSite, peerSite:null, issues:[{ code:'local-manifest-unavailable', site:localSite }],
        };
      }
      if (!evaluation) {
        try {
          peerManifest = await fetchCompactManifest(fetchImpl, peerUrl);
          if (peerManifest.site !== otherSite(localSite)) throw new Error('Peer Catalog Alignment manifest belongs to the local site');
        } catch (_) {
          peerManifest = null;
        }
        evaluation = contract.evaluateCatalogAlignmentManifests(localManifest, peerManifest);
      }
      const current = statusFromEvaluation({ evaluation, localManifest, peerManifest, site:localSite, observedAt });
      const resolved = retainPersistentFailure(current, lastStatus);
      if (['aligned', 'failed'].includes(current.state)) {
        lastStatus = persistStatus(storage, current);
      }
      lastStatus = resolved;
      onStatus(resolved);
      return resolved;
    }

    function requestRecovery(status = lastStatus) {
      const validated = validatePersistedStatus(status, localSite);
      if (validated.state !== 'failed' || !validated.retrySites.length) {
        fail('RECOVERY_NOT_AVAILABLE', 'Catalog Alignment recovery requires a failed site');
      }
      const detail = deepFreeze({
        catalogVersion: validated.catalogVersion,
        retrySites: [...validated.retrySites],
        mode: RECOVERY_MODE,
      });
      if (eventTarget?.dispatchEvent) {
        const EventConstructor = root?.CustomEvent;
        const event = typeof EventConstructor === 'function'
          ? new EventConstructor('jsp:catalog-alignment-recovery-request', { detail })
          : { type:'jsp:catalog-alignment-recovery-request', detail };
        eventTarget.dispatchEvent(event);
      }
      return detail;
    }

    return Object.freeze({
      refresh,
      requestRecovery,
      readPersisted:() => readPersistedStatus(storage, localSite),
      getLastStatus:() => lastStatus,
    });
  }

  const SITE_LABELS = Object.freeze({ supply:'Supply', fba:'FBA' });
  const STATE_COPY = Object.freeze({
    aligned:{ label:'產品資料已對齊', title:'Supply 與 FBA 已使用同一版產品資料' },
    failed:{ label:'產品資料未對齊', title:'產品資料發布尚未完成' },
    pending:{ label:'檢查產品資料', title:'正在確認 Supply 與 FBA 產品資料' },
  });

  function statusDetail(status) {
    const version = status.catalogVersion ? `版本 ${status.catalogVersion}` : '版本尚未確認';
    if (status.state === 'aligned') return `${version}，兩站的預期公開內容雜湊一致。`;
    if (status.state === 'failed') {
      const sites = status.retrySites.map(site => SITE_LABELS[site]).join('、') || '失敗站點';
      return `${version} 尚未完整發布。請用既有本機發布流程重試 ${sites}；成功站點不會自動回滾。`;
    }
    return status.stale
      ? `${version} 暫時無法重新確認；保留上次未對齊警示。`
      : `${version}，等待取得對站的 compact manifest。`;
  }

  function renderCatalogAlignmentStatus(mount, statusInput, { controller, documentRef = root?.document } = {}) {
    if (!mount || !documentRef?.createElement) fail('INVALID_MOUNT', 'Catalog Alignment UI requires a mount element');
    const status = validatePersistedStatus(statusInput, statusInput.localSite);
    const copy = STATE_COPY[status.state];
    mount.className = 'catalog-alignment-status';
    mount.dataset.state = status.state;
    mount.dataset.catalogVersion = status.catalogVersion || '';
    mount.dataset.retrySites = status.retrySites.join(',');
    mount.dataset.recoveryMode = RECOVERY_MODE;
    mount.innerHTML = '';

    const toggle = documentRef.createElement('button');
    toggle.type = 'button';
    toggle.className = 'catalog-alignment-toggle';
    toggle.setAttribute('aria-expanded', 'false');
    toggle.innerHTML = `<span class="catalog-alignment-dot" aria-hidden="true"></span><span>${copy.label}</span>`;

    const panel = documentRef.createElement('section');
    panel.className = 'catalog-alignment-panel';
    panel.hidden = true;
    panel.setAttribute('aria-live', 'polite');
    const title = documentRef.createElement('strong');
    title.textContent = copy.title;
    const detail = documentRef.createElement('p');
    detail.textContent = statusDetail(status);
    panel.append(title, detail);

    if (status.state === 'failed' && status.retrySites.length) {
      const action = documentRef.createElement('button');
      action.type = 'button';
      action.className = 'catalog-alignment-recovery';
      action.textContent = `準備重試 ${status.retrySites.map(site => SITE_LABELS[site]).join('、')}`;
      action.addEventListener('click', () => {
        controller?.requestRecovery(status);
        detail.textContent = `已交接給本機發布流程：只重試 ${status.retrySites.map(site => SITE_LABELS[site]).join('、')}，不回滾成功站點。`;
      });
      panel.append(action);
    }

    const refresh = documentRef.createElement('button');
    refresh.type = 'button';
    refresh.className = 'catalog-alignment-refresh';
    refresh.textContent = '重新檢查';
    refresh.addEventListener('click', () => controller?.refresh());
    panel.append(refresh);

    toggle.addEventListener('click', () => {
      panel.hidden = !panel.hidden;
      toggle.setAttribute('aria-expanded', panel.hidden ? 'false' : 'true');
    });
    mount.append(toggle, panel);
    return mount;
  }

  function waitForMount(documentRef, site, timeoutMs = 5000) {
    const find = () => site === 'supply'
      ? documentRef.querySelector('.supplyWorkspaceHeader .header-meta')
      : documentRef.querySelector('.app-header .workspace-header-actions');
    const immediate = find();
    if (immediate) return Promise.resolve(immediate);
    return new Promise((resolve, reject) => {
      const observer = new MutationObserver(() => {
        const target = find();
        if (!target) return;
        observer.disconnect();
        clearTimeout(timeout);
        resolve(target);
      });
      observer.observe(documentRef.documentElement, { childList:true, subtree:true });
      const timeout = setTimeout(() => {
        observer.disconnect();
        reject(new Error('Catalog Alignment header mount was not found'));
      }, timeoutMs);
    });
  }

  function createHeaderMount(documentRef, site, target) {
    let mount = documentRef.getElementById('catalogAlignmentStatus');
    if (mount) return mount;
    mount = documentRef.createElement('div');
    mount.id = 'catalogAlignmentStatus';
    if (site === 'supply') target.replaceWith(mount);
    else target.insertBefore(mount, target.firstChild);
    return mount;
  }

  async function bootCatalogAlignmentUi({
    site,
    localManifestUrl,
    peerManifestUrl,
    documentRef = root?.document,
    ...dependencies
  } = {}) {
    const localSite = normalizedSite(site);
    let mount = null;
    const controller = createCatalogAlignmentController({
      site:localSite,
      localManifestUrl,
      peerManifestUrl,
      ...dependencies,
      onStatus(status) {
        if (mount) renderCatalogAlignmentStatus(mount, status, { controller, documentRef });
        dependencies.onStatus?.(status);
      },
    });
    const target = await waitForMount(documentRef, localSite);
    mount = createHeaderMount(documentRef, localSite, target);
    const initial = controller.getLastStatus() || validatePersistedStatus({
      schemaVersion:STATUS_SCHEMA_VERSION,
      state:'pending',
      catalogVersion:null,
      localSite,
      peerSite:null,
      issues:[{ code:'alignment-check-pending', site:null }],
      retrySites:[],
      observedAt:new Date().toISOString(),
      stale:false,
    }, localSite);
    renderCatalogAlignmentStatus(mount, initial, { controller, documentRef });
    await controller.refresh();
    return Object.freeze({ controller, mount });
  }

  const api = Object.freeze({
    RECOVERY_MODE,
    CatalogAlignmentUiError,
    bootCatalogAlignmentUi,
    compareCatalogVersions,
    createCatalogAlignmentController,
    readPersistedStatus,
    renderCatalogAlignmentStatus,
    validatePersistedStatus,
  });

  const currentScript = root?.document?.currentScript;
  if (currentScript?.dataset?.catalogAlignmentSite) {
    const start = () => bootCatalogAlignmentUi({
      site:currentScript.dataset.catalogAlignmentSite,
      localManifestUrl:currentScript.dataset.localManifest,
      peerManifestUrl:currentScript.dataset.peerManifest,
    }).then(runtime => { root.JSPCatalogAlignmentRuntime = runtime; }).catch(error => {
      root.console?.error?.('Catalog Alignment UI failed to start', error);
    });
    if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', start, { once:true });
    else void start();
  }

  return api;
});
