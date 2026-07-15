import type { EntityMemoryDetail, MemoryReadinessCheck, MemoryReadinessReport } from './memory';

export type MemoryAssuranceTone = 'success' | 'warning' | 'danger' | 'neutral';

export interface MemoryAssuranceView {
  tone: MemoryAssuranceTone;
  title: string;
  statusLabel: string;
  detail: string;
  priorityChecks: MemoryReadinessCheck[];
}

export type MemoryClaimTemporalStatus = 'current' | 'scheduled' | 'historical';

/** Match the entity summary's temporal definition in the claim card itself.
 * `active` means the row has not been superseded or forgotten; it does not
 * make a future-valid claim current yet. */
export function memoryClaimTemporalStatus(
  claim: Pick<EntityMemoryDetail['claims'][number], 'active' | 'validFrom' | 'validTo'>,
  asOf: string,
): MemoryClaimTemporalStatus {
  if (!claim.active) return 'historical';
  const at = Date.parse(asOf);
  const from = claim.validFrom ? Date.parse(claim.validFrom) : Number.NaN;
  const to = claim.validTo ? Date.parse(claim.validTo) : Number.NaN;
  if (Number.isFinite(from) && Number.isFinite(at) && from > at) return 'scheduled';
  if (Number.isFinite(to) && Number.isFinite(at) && to <= at) return 'historical';
  return 'current';
}

/** Keep the desktop headline deterministic and honest. Warnings stay visible,
 * but only blocking failures can claim memory is not ready. */
export function memoryAssuranceView(report: MemoryReadinessReport): MemoryAssuranceView {
  const failures = report.checks.filter((item) => item.status === 'fail');
  const warnings = report.checks.filter((item) => item.status === 'warn');
  const skipped = report.checks.filter((item) => item.status === 'skip');
  if (failures.length > 0) {
    return {
      tone: 'danger',
      title: 'Memory needs attention',
      statusLabel: 'Withheld',
      detail: `${failures.length} blocking safeguard${failures.length === 1 ? '' : 's'} failed. Clementine will not label this memory state release-ready.`,
      priorityChecks: failures,
    };
  }
  if (report.ready) {
    return {
      tone: 'success',
      title: warnings.length > 0 ? 'Safeguards passing, with advisories' : 'Memory safeguards are passing',
      statusLabel: 'Ready',
      detail: warnings.length > 0
        ? `${report.summary.pass} checks pass. ${warnings.length} honest advisor${warnings.length === 1 ? 'y' : 'ies'} remain visible below.`
        : `All ${report.summary.pass} evaluated safeguards pass.`,
      priorityChecks: warnings,
    };
  }
  return {
    tone: 'warning',
    title: 'Memory readiness is not proven',
    statusLabel: 'Review',
    detail: `${skipped.length} safeguard${skipped.length === 1 ? '' : 's'} could not be evaluated.`,
    priorityChecks: skipped,
  };
}
