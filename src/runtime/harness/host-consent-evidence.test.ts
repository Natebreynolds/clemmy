import assert from 'node:assert/strict';
import test from 'node:test';
import { closedCanonicalJson } from '../../shared/closed-canonical-json.js';
import { buildHostConsentEvidence } from './host-consent-evidence.js';
import type { CapabilityRiskAttestationV1, InteractiveConsentCardinality } from './interactive-consent-policy.js';

test('the shared builder preserves the former call and coverage bytes for every source/cardinality', () => {
  for (const kind of ['accepted_turn', 'workflow_activation', 'workspace_action'] as const) {
    for (const cardinality of [{ kind: 'once' }, { kind: 'each', universeDigest: 'members' },
      { kind: 'set', universeDigest: 'sealed' }] satisfies InteractiveConsentCardinality[]) {
      const call: CapabilityRiskAttestationV1 = {
        version: 1, source: { kind, id: 'accepted-source', digest: 'source-digest' },
        acceptedTaskId: 'accepted-task', bindingDigest: 'bound-call', logicalToolCallId: 'logical-call',
        operationId: 'operation', argumentDigest: 'argument-digest', schemaFingerprint: 'schema',
        effect: 'external_write', accountId: 'bound-account',
        destination: { digest: 'exact-destination', posture: 'named_existing' }, cardinality,
        risk: { reversibility: 'irreversible', consequence: 'send', destructive: false },
        semanticBasis: { kind: 'current_external_definition', digest: 'risk-digest' }, safety: 'admissible',
      };
      const scope = { contractId: 'existing-contract', requirementId: 'existing-requirement',
        requirementDigest: 'existing-requirement-digest', reservationKey: 'existing-reservation' };
      const legacy = { call, coverage: {
        version: 1, source: { ...call.source }, acceptedTaskId: call.acceptedTaskId,
        contractId: scope.contractId, requirementId: scope.requirementId, requirementDigest: scope.requirementDigest,
        semanticScope: { operationId: call.operationId, schemaFingerprint: call.schemaFingerprint,
          effect: call.effect, accountId: call.accountId, destination: { ...call.destination },
          cardinality: { ...call.cardinality }, semanticBasis: { ...call.semanticBasis } },
        callBinding: { logicalToolCallId: call.logicalToolCallId, argumentDigest: call.argumentDigest,
          bindingDigest: call.bindingDigest }, reservationKey: scope.reservationKey,
      } };
      const { version: _version, ...facts } = call;
      const shared = buildHostConsentEvidence({ call: facts, coverage: () => scope });
      assert.equal(JSON.stringify(shared), JSON.stringify(legacy));
      assert.equal(closedCanonicalJson(shared), closedCanonicalJson(legacy));
      assert.deepEqual(buildHostConsentEvidence({ call: facts, coverage: null }), { call, coverage: null });
    }
  }
});
