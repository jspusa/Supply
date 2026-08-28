import { classifyCoverageDays } from './supply-planner.js';

const TARGET_DAYS = 180;
const MAXIMUM_DAYS = 365;

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function formatDays(value) {
  return `${(Math.round(value * 10) / 10).toFixed(1)} 天`;
}

function formatAttributeNumber(value) {
  return Number(value.toFixed(4)).toString();
}

function statusTextForBand(band, hasValue) {
  if (!hasValue) return '無資料';
  if (band === 'low') return `低於 ${TARGET_DAYS} 天`;
  if (band === 'healthy') return `健康範圍 ${TARGET_DAYS}–${MAXIMUM_DAYS} 天`;
  if (band === 'excess') return `超過 ${MAXIMUM_DAYS} 天`;
  return '資料未完整，不判色';
}

export function buildCoverageMeterModel({ coverageDays, assessment = 'ready' } = {}) {
  const hasValue = Number.isFinite(coverageDays);
  const normalizedAssessment = assessment === 'unavailable' ? 'unavailable' : 'ready';
  const band = hasValue && normalizedAssessment === 'ready'
    ? classifyCoverageDays({
        coverageDays,
        targetDays:TARGET_DAYS,
        maximumCoverageDays:MAXIMUM_DAYS,
      })
    : 'neutral';
  const fillPercent = hasValue
    ? clamp((coverageDays / MAXIMUM_DAYS) * 100, 0, 100)
    : 0;
  const meterValue = hasValue ? clamp(coverageDays, 0, MAXIMUM_DAYS) : null;
  const valueText = hasValue ? formatDays(coverageDays) : '—';
  const statusText = statusTextForBand(band, hasValue);

  return Object.freeze({
    assessment:normalizedAssessment,
    band,
    coverageDays:hasValue ? coverageDays : null,
    fillPercent,
    hasValue,
    maximumDays:MAXIMUM_DAYS,
    meterValue,
    statusText,
    targetDays:TARGET_DAYS,
    valueText,
  });
}

function renderTrack(model) {
  const fill = `<span class="coverageMeter__fill" style="--coverage-fill:${formatAttributeNumber(model.fillPercent)}%"></span><span class="coverageMeter__targetMarker" aria-hidden="true"></span>`;
  if (!model.hasValue) {
    return `<div class="coverageMeter__track" aria-hidden="true">${fill}</div>`;
  }
  const ariaValueText = `${model.valueText}，${model.statusText}`;
  return `<div class="coverageMeter__track" role="meter" aria-label="可售天數" aria-valuemin="0" aria-valuemax="${MAXIMUM_DAYS}" aria-valuenow="${formatAttributeNumber(model.meterValue)}" aria-valuetext="${ariaValueText}">${fill}</div>`;
}

export function renderCoverageMeter(options = {}) {
  const model = buildCoverageMeterModel(options);
  const noDataAria = model.hasValue ? '' : ' role="group" aria-label="可售天數：無資料"';
  return `<div class="coverageMeter coverageMeter--${model.band}" data-band="${model.band}" data-assessment="${model.assessment}"${noDataAria}><div class="coverageMeter__summary"><strong class="coverageMeter__value">${model.valueText}</strong><span class="coverageMeter__status">${model.statusText}</span></div>${renderTrack(model)}</div>`;
}

const browserInterface = Object.freeze({
  buildCoverageMeterModel,
  renderCoverageMeter,
});

if (typeof window !== 'undefined') window.SupplyCoverageIndicator = browserInterface;
