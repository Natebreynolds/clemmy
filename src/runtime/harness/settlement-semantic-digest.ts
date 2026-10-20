/** Canonical settlement bytes shared by writer and independent receipt proof. */
import { createHash } from 'node:crypto';
import type { CommitLogicalCallSettlementInput, LogicalCallExecutionKind } from './logical-call-settlement-store.js';
const sha256 = (value: string): string => createHash('sha256').update(value).digest('hex');
const normalizedProviderStatus = (value: number | string | undefined): string | undefined => value === undefined ? undefined : String(value).replace(/\s+/g,' ').trim().slice(0,64) || undefined;
const normalizedDetail = (value: string | undefined): string | undefined => value?.replace(/\s+/g,' ').trim().slice(0,160) || undefined;

export function settlementSemanticDigest(input: {
  toolName: string;
  argumentDigest: string;
  executionKind: LogicalCallExecutionKind;
  outcome: CommitLogicalCallSettlementInput['outcome'];
  recovery: CommitLogicalCallSettlementInput['recovery'];
  progressDigest?: string;
  resultHandleId?: string;
}): string {
  return sha256(JSON.stringify({
    protocolVersion: 1,
    toolName: input.toolName,
    argumentDigest: input.argumentDigest,
    executionKind: input.executionKind,
    resultHandleId: input.resultHandleId ?? null,
    outcome: {
      kind: input.outcome.kind,
      evidence: input.outcome.evidence,
      providerStatus: normalizedProviderStatus(input.outcome.providerStatus) ?? null,
      detail: normalizedDetail(input.outcome.detail) ?? null,
      directive: {
        action: input.outcome.directive.action,
        retrySameCandidate: input.outcome.directive.retrySameCandidate,
        eliminatesCandidate: input.outcome.directive.eliminatesCandidate,
        opensDiscoveryEpoch: input.outcome.directive.opensDiscoveryEpoch,
        requiresReconciliation: input.outcome.directive.requiresReconciliation,
      },
    },
    recovery: {
      businessCall: input.recovery.businessCall,
      mutating: input.recovery.mutating,
      requirementId: input.recovery.requirementId ?? null,
      continuesRequirement: input.recovery.continuesRequirement === true,
      progressKeyDigest: input.progressDigest ?? null,
      governorEvidence: input.recovery.governorEvidence
        ? {
            kind: input.recovery.governorEvidence.kind,
            detail: input.recovery.governorEvidence.detail?.replace(/\s+/g, ' ').trim().slice(0, 256) || null,
            onlyIfProgressClaimed: input.recovery.governorEvidence.onlyIfProgressClaimed === true,
          }
        : null,
    },
  }));
}
