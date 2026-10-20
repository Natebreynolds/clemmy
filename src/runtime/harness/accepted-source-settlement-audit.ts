/** Runtime adapter for the shared canonical read-only settlement audit. */
import { classifyRuntimeToolEffect } from './tool-effect.js';
import { classifyExternalWrite } from './confirm-first-gate.js';
import { parseCurrentManifestRecoverySemantics } from './current-manifest-operation-semantics.js';
import { listEvents, openEventLog } from './eventlog.js';
import { extractExternalWriteIdentityKeys } from './grounding-gate.js';
import { resolveWriteEvidence } from './work-report.js';
import { readPendingUnacknowledgedWritesForSource } from './pending-unacknowledged-writes.js';
import { auditAcceptedSourceSettlementTruthRead, type AcceptedSourceSettlementAuditReader } from './accepted-source-settlement-audit-read.js';
export { answeredRefusalSettlement } from './accepted-source-settlement-audit-read.js';
export type { AcceptedSourceSettlementAudit, AcceptedSourceSettlementAuditStatus, AcceptedSourceSettlementRecoveryIdentity } from './accepted-source-settlement-audit-read.js';

const runtimeReader: AcceptedSourceSettlementAuditReader = {
  database: openEventLog, listEvents, classifyRuntimeToolEffect, classifyExternalWrite,
  parseCurrentManifestRecoverySemantics, extractExternalWriteIdentityKeys, resolveWriteEvidence,
  readPendingUnacknowledgedWritesForSource,
};

export function auditAcceptedSourceSettlementTruth(input: Parameters<typeof auditAcceptedSourceSettlementTruthRead>[0]) {
  return auditAcceptedSourceSettlementTruthRead(input, runtimeReader);
}
