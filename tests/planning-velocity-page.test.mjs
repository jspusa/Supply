import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

import { planLegacyReplenishment } from '../shared/legacy-planning-adapter.js';
import { buildPlanningVelocities, parseH10Observations } from '../shared/planning-velocity.js';
import { readPlanningVelocityHistory, writePlanningVelocityHistory } from '../shared/planning-velocity-history.js';

const repoRoot = path.resolve(import.meta.dirname, '..');
const pages = [
  ['public', fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8')],
  ['Boss', fs.readFileSync(path.join(repoRoot, 'Boss', 'index.html'), 'utf8')],
];

function extractFunctionSource(html, name) {
  const marker = `function ${name}(`;
  const start = html.indexOf(marker);
  assert.notEqual(start, -1, `page should define ${name}`);
  const bodyMarker = /\)\s*\{/.exec(html.slice(start));
  assert.ok(bodyMarker, `page should define a body for ${name}`);
  const bodyStart = start + bodyMarker.index + bodyMarker[0].lastIndexOf('{');
  let depth = 0;
  for (let index = bodyStart; index < html.length; index += 1) {
    if (html[index] === '{') depth += 1;
    if (html[index] === '}') {
      depth -= 1;
      if (depth === 0) return html.slice(start, index + 1);
    }
  }
  throw new Error(`Could not extract ${name}`);
}

for (const [entrypoint, html] of pages) {
  test(`${entrypoint}: Planning Velocity is the only downstream velocity field`, () => {
    const buildTables = extractFunctionSource(html, 'buildTables');
    assert.match(buildTables, /buildVelocityAssessments\(amzComponents\)/);
    assert.match(buildTables, /planningVelocity:assessment\.planningVelocity/);
    assert.doesNotMatch(buildTables, /dedupeH10|aggregateH10RowsByEquivalent/);
    assert.doesNotMatch(html, /\.speed\b|orderSpeedMap/);
    assert.match(html, /Planning Velocity<br>H10 Source／採用／風險/);
    assert.match(html, /無有效速度證據，無法建議/);
    assert.match(html, /不代表已證實斷貨/);
    assert.match(extractFunctionSource(html, 'getSkuDecisionTreeAnalysis'), /if \(planningVelocity <= 0\)[\s\S]*無有效速度證據，無法判斷[\s\S]*return finish\(\)/);
    assert.match(extractFunctionSource(html, 'getAutoDecisionRows'), /filter\(row => row\.planningVelocity > 0\)/);
  });

  test(`${entrypoint}: H10 inventory import retains row-level DOS evidence`, () => {
    const context = {
      normalizeSkuKey: value => String(value || '').trim().toUpperCase(),
      normalizeNumber(value) {
        if (value === '' || value === null) return null;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
      },
      findHeaderIndex: () => 0,
      findColumnIndex(header, candidates) {
        const wanted = candidates.map(value => value.toLowerCase());
        return header.findIndex(cell => wanted.some(value => String(cell).toLowerCase().includes(value)));
      },
      parseSalesRowsFromTable: () => ({ salesText:'', salesCount:0, salesTotal:0 }),
    };
    vm.createContext(context);
    vm.runInContext(`${extractFunctionSource(html, 'parseAmzInventoryRows')}\nthis.parseAmzInventoryRows = parseAmzInventoryRows;`, context);
    const result = context.parseAmzInventoryRows([
      ['SKU', 'Days of Supply', 'Sellable Inventory', 'Inbound'],
      ['GTP03', 0, 0, 0],
      ['GTP03', 205, 3199, 402],
      ['BADINV', 14, 'N/A', 0],
    ]);
    assert.deepEqual(Array.from(result.velocityRows, row => Array.from(row)), [
      ['SKU', 'Days of Supply', 'Sellable Inventory', 'Inbound'],
      ['GTP03', 0, 0, 0],
      ['GTP03', 205, 3199, 402],
      ['BADINV', 14, 'N/A', 0],
    ]);
    assert.equal(result.skuCount, 2);
    assert.equal(result.sellableTotal, 3199);
    const assessments = buildPlanningVelocities({
      asOfDate:'2026-08-28',
      sourceObservedOn:'2026-08-28',
      rawH10Text:'',
      inventoryRows:result.velocityRows,
    }).assessments;
    const invalid = assessments.find(item => item.productSku === 'BADINV');
    assert.equal(invalid.velocityRisks.some(risk => risk.code === 'ZERO_SELLABLE'), false);
    assert.equal(invalid.ignoredEvidence.some(item => item.code === 'INVALID_INVENTORY_DOS'), true);
  });

  test(`${entrypoint}: H10 recognition delegates to the shared parser, including invalid evidence`, () => {
    const context = {
      equivalentSkuAliasToCanonical:new Map(),
      window:{ SupplyVelocity:{ parseH10Observations } },
    };
    vm.createContext(context);
    vm.runInContext(`${extractFunctionSource(html, 'parseH10ToRows')}\nthis.parseH10ToRows = parseH10ToRows;`, context);
    const rows = context.parseH10ToRows('United StatesB000000040BADH10\nN/A');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].sku, 'BADH10');
    assert.equal(rows[0].sourceVelocity, null);
    assert.equal(rows[0].rawValue, 'N/A');
    assert.doesNotMatch(html, /function aggregateH10RowsByEquivalent/);
    const autoClassify = extractFunctionSource(html, 'autoClassifyAndReadFiles');
    assert.match(autoClassify, /const h10TextParts = \[\]/);
    assert.match(autoClassify, /h10El\.value = h10TextParts\.join\('\\n\\n'\)/);
    assert.doesNotMatch(autoClassify, /h10El\.value \+ '\\n\\n'/);
  });

  test(`${entrypoint}: history adapter reports storage failure and only acknowledges a successful write`, () => {
    const storageOutcomes = [];
    const context = {
      reportVelocityHistoryFailure:(action, result) => storageOutcomes.push([action, result.status]),
      window:{
        localStorage:{},
        SupplyVelocityHistory:{
          readPlanningVelocityHistory:() => ({ ok:false, status:'corrupt', samples:[], error:{ message:'bad json' } }),
          writePlanningVelocityHistory:() => ({ ok:false, status:'quota', error:{ message:'full' } }),
        },
      },
      VELOCITY_HISTORY_KEY:'test-history',
    };
    vm.createContext(context);
    for (const name of ['getVelocityHistoryStorage', 'loadVelocityHistorySamples', 'saveVelocityHistorySamples']) {
      vm.runInContext(`${extractFunctionSource(html, name)}\nthis.${name} = ${name};`, context);
    }
    assert.deepEqual(Array.from(context.loadVelocityHistorySamples()), []);
    assert.equal(context.saveVelocityHistorySamples([]).ok, false);
    assert.deepEqual(storageOutcomes, [['read', 'corrupt'], ['write', 'quota']]);

    let capturedVelocityInput = null;
    const buildContext = {
      window:{ SupplyVelocity:{ buildPlanningVelocities:input => { capturedVelocityInput = input; return { h10Observations:[{ value:null }], nextHistorySamples:[], assessments:[] }; } } },
      getPlanningAsOfDate:() => '2026-08-28',
      h10SourceObservedOn:'2026-08-28',
      h10El:{ value:'United StatesB000000040BADH10\nN/A' },
      getVelocityInventoryRows:() => [],
      equivalentSkuAliasToCanonical:new Map(),
      hotSkuList:[],
      loadVelocityHistorySamples:() => [],
      saveVelocityHistorySamples:() => ({ ok:false, status:'quota' }),
    };
    vm.createContext(buildContext);
    vm.runInContext(`let shouldRecordVelocityHistory = true; let velocityHistoryFailureSignature = ''; ${extractFunctionSource(html, 'buildVelocityAssessments')}\nthis.runBuild = buildVelocityAssessments; this.recordPending = () => shouldRecordVelocityHistory;`, buildContext);
    buildContext.runBuild({});
    assert.equal(buildContext.recordPending(), true);
    buildContext.saveVelocityHistorySamples = () => ({ ok:true, status:'saved' });
    buildContext.runBuild({});
    assert.equal(buildContext.recordPending(), false);
    buildContext.h10SourceObservedOn = null;
    buildContext.runBuild({});
    assert.equal(capturedVelocityInput.sourceObservedOn, null);

    const deniedError = Object.assign(new Error('blocked getter'), { name:'SecurityError' });
    const deniedWindow = { SupplyVelocityHistory:{ readPlanningVelocityHistory, writePlanningVelocityHistory } };
    Object.defineProperty(deniedWindow, 'localStorage', { get() { throw deniedError; } });
    const deniedFailures = [];
    const deniedContext = {
      window:deniedWindow,
      VELOCITY_HISTORY_KEY:'test-history',
      reportVelocityHistoryFailure:(action, result) => deniedFailures.push([action, result.status]),
    };
    vm.createContext(deniedContext);
    for (const name of ['getVelocityHistoryStorage', 'loadVelocityHistorySamples', 'saveVelocityHistorySamples']) {
      vm.runInContext(`${extractFunctionSource(html, name)}\nthis.${name} = ${name};`, deniedContext);
    }
    assert.doesNotThrow(() => deniedContext.loadVelocityHistorySamples());
    assert.equal(deniedContext.saveVelocityHistorySamples([]).status, 'denied');
    assert.deepEqual(deniedFailures, [['read', 'denied'], ['write', 'denied']]);
  });

  test(`${entrypoint}: recommendation risk toggle is the shared selection for table, export, and generator`, () => {
    let riskOnly = false;
    const rows = [
      { sku:'SAFE01', velocityAssessment:{ velocityRisks:[] } },
      { sku:'RISK01', velocityAssessment:{ velocityRisks:[{ code:'LOW_DAYS_OF_SUPPLY' }] } },
    ];
    const context = {
      reorderRowsAll:rows,
      applyFilters:value => value,
      document:{ getElementById:id => id === 'reorderVelocityRiskOnly' ? { checked:riskOnly } : null },
    };
    vm.createContext(context);
    for (const name of ['hasVelocityRisk', 'getReorderRowsForAction']) {
      vm.runInContext(`${extractFunctionSource(html, name)}\nthis.${name} = ${name};`, context);
    }
    assert.deepEqual(Array.from(context.getReorderRowsForAction(), row => row.sku), ['SAFE01', 'RISK01']);
    riskOnly = true;
    assert.deepEqual(Array.from(context.getReorderRowsForAction(), row => row.sku), ['RISK01']);
    assert.match(extractFunctionSource(html, 'renderReorder'), /getReorderRowsForAction\(\)/);
    assert.match(extractFunctionSource(html, 'exportReorderRowsFiltered'), /getReorderRowsForAction\(\)/);
    assert.match(extractFunctionSource(html, 'addReorderRowsToGenerator'), /getReorderRowsForAction\(\)/);
  });

  test(`${entrypoint}: velocity exports expose source, winner, adjustment, and every risk`, () => {
    const context = {
      formatVelocityNumber: value => String(value),
      getVelocityWinnerLabel: kind => kind,
      getVelocityRiskLabel: code => code,
    };
    vm.createContext(context);
    for (const name of ['getVelocitySourceText', 'getVelocityWinnerText', 'getVelocityAdjustmentText', 'getVelocityRiskText', 'getVelocityExportFields']) {
      vm.runInContext(`${extractFunctionSource(html, name)}\nthis.${name} = ${name};`, context);
    }
    const row = {
      planningVelocity:18.39,
      velocityAssessment:{
        h10SourceVelocity:{ values:[0.36, 18.39] },
        winningEvidence:[{ kind:'h10-source', value:18.39 }],
        adjustmentReasons:[{ message:'調高原因一' }, { message:'調高原因二' }],
        velocityRisks:[{ code:'ZERO_SELLABLE' }, { code:'LOW_DAYS_OF_SUPPLY' }],
      },
    };
    assert.deepEqual(Array.from(context.getVelocityExportFields(row)), [
      '0.36 / 18.39', 18.39, 'h10-source 18.39', '調高原因一；調高原因二', 'ZERO_SELLABLE；LOW_DAYS_OF_SUPPLY',
    ]);
  });
}

test('public and Boss produce the same GTP03 assessment, plan, rendering, and export contract', () => {
  const fixture = {
    asOfDate:'2026-08-28',
    sourceObservedOn:'2026-08-28',
    rawH10Text:['United StatesB0C3C3D1W6GTP03', '0.36', 'United StatesB0C3C3D1W6GTP03', '18.39'].join('\n'),
    inventoryRows:[
      ['SKU', 'Days of Supply', 'Sellable Inventory', 'Inbound'],
      ['GTP03', 0, 0, 0],
      ['GTP03', 205, 3199, 402],
    ],
    historySamples:[],
  };
  const outcomes = pages.map(([entrypoint, html]) => {
    assert.match(html, /shared\/legacy-planning-adapter\.js/);
    const velocity = buildPlanningVelocities(fixture);
    const assessment = velocity.assessments.find(item => item.productSku === 'GTP03');
    const row = {
      sku:'GTP03',
      planningVelocity:assessment.planningVelocity,
      velocityAssessment:assessment,
      usAmz:3199,
      usJsp:0,
      usAmzInbound:402,
      order:0,
    };
    const plan = planLegacyReplenishment({
      asOfDate:'2026-08-28',
      row,
      readiness:{ amazonInventory:true, jspInventory:true, openOrders:true },
      openOrders:[],
      policy:{ leadTimeDays:90, transferTimeDays:21, targetDays:180, executableOrderIncrement:28 },
    });
    const context = {
      escapeHtml:value => String(value),
      formatVelocityNumber:value => String(Number(Number(value).toFixed(2))),
      getVelocityWinnerLabel:kind => kind,
      getVelocityRiskLabel:code => code,
    };
    vm.createContext(context);
    for (const name of ['getVelocitySourceText', 'getVelocityWinnerText', 'getVelocityAdjustmentText', 'getVelocityRiskText', 'getVelocityExportFields', 'renderVelocityEvidence']) {
      vm.runInContext(`${extractFunctionSource(html, name)}\nthis.${name} = ${name};`, context);
    }
    return {
      entrypoint,
      assessment:JSON.parse(JSON.stringify(assessment)),
      recommendation:{ suggestedQty:plan.suggestedQty, increment:plan.orderIncrement },
      coverage:{ bookDays:plan.bookCoverageDays, arrivalDays:plan.arrivalCoverageDays, postArrivalDays:plan.postArrivalDays },
      rendering:context.renderVelocityEvidence(row),
      exportRow:Array.from(context.getVelocityExportFields(row)),
    };
  });
  assert.deepEqual({ ...outcomes[0], entrypoint:null }, { ...outcomes[1], entrypoint:null });
});

test('Boss records velocity history only after a canonical saved-snapshot date exists', () => {
  const bossHtml = pages.find(([entrypoint]) => entrypoint === 'Boss')[1];
  const context = {
    window:{ SupplyVelocityHistory:{ derivePlanningVelocityObservedOn:() => '2026-08-29' } },
    h10El:{ value:'United StatesB0C3C3D1W6GTP03\n18.39' },
    parseH10ToRows:() => [{ sourceVelocity:18.39 }],
    showTip:() => {},
  };
  vm.createContext(context);
  vm.runInContext(`let h10SourceObservedOn = null; let shouldRecordVelocityHistory = false; function buildTables(){ this.recordedDate = h10SourceObservedOn; shouldRecordVelocityHistory = false; } ${extractFunctionSource(bossHtml, 'getBossSnapshotObservedOn')} ${extractFunctionSource(bossHtml, 'recordBossSnapshotVelocityHistory')} this.recordSnapshot = recordBossSnapshotVelocityHistory;`, context);
  const result = context.recordSnapshot({ updatedAt:'2026-08-28T16:30:00Z' });
  assert.deepEqual({ ...result }, { ok:true, status:'recorded', observedOn:'2026-08-29' });
  assert.equal(context.recordedDate, '2026-08-29');

  const pendingSource = extractFunctionSource(bossHtml, 'rebuildBossPendingInputs');
  assert.match(pendingSource, /recordVelocityHistory:false/);
  const loadSource = extractFunctionSource(bossHtml, 'loadBossSnapshot');
  assert.match(loadSource, /sourceObservedOn:observedOn, recordVelocityHistory:false/);
  assert.doesNotMatch(loadSource, /sourceObservedOn:observedOn \|\| getPlanningAsOfDate/);
  assert.match(extractFunctionSource(bossHtml, 'buildVelocityAssessments'), /sourceObservedOn:h10SourceObservedOn === undefined \? asOfDate : h10SourceObservedOn/);
  const saveSource = extractFunctionSource(bossHtml, 'saveBossSnapshot');
  assert.ok(saveSource.indexOf("if (!response.ok) throw") < saveSource.indexOf('recordBossSnapshotVelocityHistory(manifest)'));
  assert.match(saveSource, /needsResave[\s\S]*deferred-for-newer-revision[\s\S]*recordBossSnapshotVelocityHistory\(manifest\)/);
});
