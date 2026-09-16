import { appendEvent, openEventLog } from './eventlog.js';
import {
  INTERACTIVE_CONSENT_POLICY_VERSION,
  type CapabilityRiskAttestationV1,
  type ExactWorkCoverageV1,
  type InteractiveConsentDecisionV1,
  type InteractiveConsentProceedBasis,
} from './interactive-consent-policy.js';

export type HostConsentCoverageScope = Pick<ExactWorkCoverageV1,
  'contractId' | 'requirementId' | 'requirementDigest' | 'reservationKey'>;

/** One value projection for every consent adapter. The caller must reopen its
 * existing authority before calling; this builder observes/mints no authority
 * and never changes risk, account, effect, cardinality or occurrence identity. */
export function buildHostConsentEvidence(input: {
  call: Omit<CapabilityRiskAttestationV1, 'version'>;
  coverage: (call: CapabilityRiskAttestationV1) => HostConsentCoverageScope;
}): { call: CapabilityRiskAttestationV1; coverage: ExactWorkCoverageV1 };
export function buildHostConsentEvidence(input: {
  call: Omit<CapabilityRiskAttestationV1, 'version'>;
  coverage: null;
}): { call: CapabilityRiskAttestationV1; coverage: null };
export function buildHostConsentEvidence(input: {
  call: Omit<CapabilityRiskAttestationV1, 'version'>;
  coverage: ((call: CapabilityRiskAttestationV1) => HostConsentCoverageScope) | null;
}): { call: CapabilityRiskAttestationV1; coverage: ExactWorkCoverageV1 | null } {
  const call: CapabilityRiskAttestationV1 = {
    version: INTERACTIVE_CONSENT_POLICY_VERSION,
    ...input.call,
  };
  const scope = input.coverage?.(call);
  const coverage: ExactWorkCoverageV1 | null = scope ? {
    version: INTERACTIVE_CONSENT_POLICY_VERSION,
    source: call.source,
    acceptedTaskId: call.acceptedTaskId,
    contractId: scope.contractId,
    requirementId: scope.requirementId,
    requirementDigest: scope.requirementDigest,
    semanticScope: {
      operationId: call.operationId,
      schemaFingerprint: call.schemaFingerprint,
      effect: call.effect,
      accountId: call.accountId,
      destination: call.destination,
      cardinality: call.cardinality,
      semanticBasis: call.semanticBasis,
    },
    callBinding: {
      logicalToolCallId: call.logicalToolCallId,
      argumentDigest: call.argumentDigest,
      bindingDigest: call.bindingDigest,
    },
    reservationKey: scope.reservationKey,
  } : null;
  return { call, coverage };
}

/** Evidence a consent adapter can attach from the current external
 * attestation: the carrier's own destructive declaration and the method
 * class the bound arguments selected. Null when the adapter has neither. */
export interface HostConsentCarrierEvidence {
  destructive: boolean | null;
  requestMethod: 'safe' | 'post' | 'update' | 'delete' | null;
}

/** Append the private receipt for a decision the harness answered on the
 * carrier's bound (basis exact_carrier_bounded_work, or its planning-turn
 * form plan_preparation_probe). Every other basis is a no-op here: reads,
 * reversible/ordinary work and user grants already have their own ledgers.
 * Best-effort: journaling never changes the decision. */
export function journalInteractiveConsentDecision(input: {
  sessionId: string;
  /** Chat lanes carry the source turn; a workflow node has none. */
  sourceUserSeq: number | null;
  call: CapabilityRiskAttestationV1;
  decision: InteractiveConsentDecisionV1;
  carrier: HostConsentCarrierEvidence | null;
}): void {
  const { decision } = input;
  if (decision.kind !== 'proceed') return;
  if (decision.basis !== 'exact_carrier_bounded_work' && decision.basis !== 'plan_preparation_probe') return;
  try {
    appendEvent({
      sessionId: input.sessionId,
      turn: 0,
      role: 'system',
      type: 'interactive_consent_decided',
      data: {
        protocolVersion: 1,
        sourceUserSeq: input.sourceUserSeq,
        acceptedTaskId: input.call.acceptedTaskId,
        logicalToolCallId: input.call.logicalToolCallId,
        operationId: input.call.operationId,
        accountId: input.call.accountId,
        effect: input.call.effect,
        basis: decision.basis,
        risk: { ...input.call.risk },
        bindingDigest: input.call.bindingDigest,
        argumentDigest: input.call.argumentDigest,
        carrierHints: { destructive: input.carrier?.destructive ?? null },
        requestMethod: input.carrier?.requestMethod ?? null,
      },
    });
  } catch {
    // The decision stands; a missing receipt is a diagnostics gap, not a gate.
  }
}

/** Reopen the journaled basis for one exact logical call. The receipt, not a
 * caller-supplied flag, is what lets dispatch and settlement account a
 * planning turn's preparation probe like a read crossing; a claim without a
 * receipt changes nothing. Null when no receipt exists or storage fails. */
export function loadJournaledConsentBasis(identity: {
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  logicalToolCallId: string;
}): InteractiveConsentProceedBasis | null {
  try {
    const row = openEventLog().prepare(`
      SELECT json_extract(data_json, '$.basis') AS basis
        FROM events
       WHERE session_id = ?
         AND type = 'interactive_consent_decided'
         AND json_extract(data_json, '$.sourceUserSeq') = ?
         AND json_extract(data_json, '$.acceptedTaskId') = ?
         AND json_extract(data_json, '$.logicalToolCallId') = ?
       ORDER BY seq DESC
       LIMIT 1
    `).get(
      identity.sessionId,
      identity.sourceUserSeq,
      identity.acceptedTaskId,
      identity.logicalToolCallId,
    ) as { basis: unknown } | undefined;
    return typeof row?.basis === 'string' ? row.basis as InteractiveConsentProceedBasis : null;
  } catch {
    return null;
  }
}
