/** Pure expected-work address validation shared by runtime and terminal proof. */
import type { AcceptedTaskWorkContractV1, ExpectedWorkPlannerSourceV1 } from './expected-work-contract.js';
import { WORK_TOPOLOGY_VERSION as EXPECTED_WORK_CONTRACT_VERSION, canonicalWorkTopologyJson as canonicalExpectedWorkJson,
  workTopologySha256 as expectedWorkDigest, workTopologyDigest, validateWorkTopology } from '../graph/work-topology.js';
const validateExpectedWorkProposal = (value: unknown) => {
  const result = validateWorkTopology(value);
  return result.ok ? { ok: true as const, proposal: result.topology } : result;
};
function plainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}


function exactKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
  errors: string[],
): void {
  const allow = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allow.has(key)) errors.push(`${label} contains unknown field ${key}`);
  }
}

export function contractMaterial(contract: Omit<AcceptedTaskWorkContractV1, 'contractId'>): unknown {
  return {
    version: contract.version,
    identity: contract.identity,
    acceptedTaskId: contract.acceptedTaskId,
    graphEventId: contract.graphEventId,
    graphId: contract.graphId,
    graphHash: contract.graphHash,
    ...(contract.topologyHash ? { topologyHash: contract.topologyHash } : {}),
    plannerSource: contract.plannerSource,
    operations: contract.operations,
    universes: contract.universes,
  };
}

export function validateContractValue(value: unknown): AcceptedTaskWorkContractV1 | null {
  if (!plainRecord(value)) return null;
  const errors: string[] = [];
  exactKeys(value, [
    'version', 'contractId', 'identity', 'acceptedTaskId', 'graphEventId',
    'graphId', 'graphHash', 'topologyHash', 'plannerSource', 'operations', 'universes',
  ], 'contract', errors);
  if (!plainRecord(value.identity)) return null;
  exactKeys(value.identity, ['sessionId', 'sourceUserSeq', 'turn'], 'contract.identity', errors);
  if (typeof value.identity.sessionId !== 'string' || !value.identity.sessionId.trim()) return null;
  if (!Number.isSafeInteger(value.identity.sourceUserSeq) || Number(value.identity.sourceUserSeq) <= 0) return null;
  if (!Number.isSafeInteger(value.identity.turn) || Number(value.identity.turn) < 0) return null;
  for (const field of ['acceptedTaskId', 'graphEventId', 'graphId'] as const) {
    if (typeof value[field] !== 'string' || !value[field]) errors.push(`contract.${field} is invalid`);
  }
  if (typeof value.graphHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.graphHash)) {
    errors.push('contract.graphHash is invalid');
  }
  if (value.topologyHash !== undefined && (
    typeof value.topologyHash !== 'string' || !/^[a-f0-9]{64}$/.test(value.topologyHash)
  )) errors.push('contract.topologyHash is invalid');
  if (value.plannerSource !== 'deterministic' && value.plannerSource !== 'structured_model') {
    errors.push('contract.plannerSource is invalid');
  }
  const proposal = validateExpectedWorkProposal({
    version: value.version,
    operations: value.operations,
    universes: value.universes,
  });
  if (!proposal.ok) errors.push(...proposal.errors);
  if (
    proposal.ok
    && value.topologyHash !== undefined
    && value.topologyHash !== workTopologyDigest(proposal.proposal)
  ) errors.push('contract.topologyHash does not match the normalized topology');
  if (errors.length > 0 || !proposal.ok) return null;
  const body: Omit<AcceptedTaskWorkContractV1, 'contractId'> = {
    version: EXPECTED_WORK_CONTRACT_VERSION,
    identity: {
      sessionId: value.identity.sessionId,
      sourceUserSeq: Number(value.identity.sourceUserSeq),
      turn: Number(value.identity.turn),
    },
    acceptedTaskId: String(value.acceptedTaskId),
    graphEventId: String(value.graphEventId),
    graphId: String(value.graphId),
    graphHash: String(value.graphHash),
    ...(typeof value.topologyHash === 'string' ? { topologyHash: value.topologyHash } : {}),
    plannerSource: value.plannerSource as ExpectedWorkPlannerSourceV1,
    operations: proposal.proposal.operations,
    universes: proposal.proposal.universes,
  };
  const contractId = `expected-work:v1:${expectedWorkDigest(canonicalExpectedWorkJson(contractMaterial(body)))}`;
  if (value.contractId !== contractId) return null;
  return { ...body, contractId };
}

