import {
  INTERACTIVE_CONSENT_POLICY_VERSION,
  type CapabilityRiskAttestationV1,
  type ExactWorkCoverageV1,
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
