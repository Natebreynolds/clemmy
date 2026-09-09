import type { CapabilityManifestV1 } from './capability-manifest.js';
import type { TurnGraphIR } from '../graph/turn-graph-ir.js';

/** Completion policy selected before dispatch. This proves acknowledgement,
 * never an artifact identity, exact content, readback, or effect permission. */
export interface ProviderAcknowledgementModeV1 {
  version: 1;
  kind: 'provider_acknowledgement_v1';
  workContractId: string;
}

export function parseProviderAcknowledgementMode(value: unknown): ProviderAcknowledgementModeV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  return Object.keys(row).length === 3 && row.version === 1
    && row.kind === 'provider_acknowledgement_v1'
    && typeof row.workContractId === 'string'
    && /^expected-work:v1:[a-f0-9]{64}$/.test(row.workContractId)
    ? { version: 1, kind: 'provider_acknowledgement_v1', workContractId: row.workContractId }
    : null;
}

export function graphAllowsProviderAcknowledgement(graph: TurnGraphIR, operationId: string): boolean {
  const requirements = graph.classification.goalConstraints?.evidenceRequirements;
  const operation = graph.workTopology?.topology.operations.find((entry) => entry.id === operationId);
  const destinations = graph.classification.goalConstraints?.destinations;
  return Boolean(requirements?.length === 1 && requirements[0] === 'tool_result'
    && operation?.effect === 'external_write' && operation.cardinality.kind === 'once'
    && operation.dataFrom.length === 0
    && destinations?.length && destinations.every((entry) => entry.posture === 'create_new' && !entry.handleRequired));
}

export function selectProviderAcknowledgementMode(input: {
  graph: TurnGraphIR;
  operationId: string;
  workContractId: string;
  manifest: CapabilityManifestV1;
}): ProviderAcknowledgementModeV1 | null {
  const manifest = input.manifest;
  if (!graphAllowsProviderAcknowledgement(input.graph, input.operationId)
    || manifest.effect !== 'external_write'
    || manifest.destination?.posture !== 'create_new'
    || manifest.operationSemantics?.atomicInputContent
    || manifest.externalDefinition?.verification
    || manifest.readbackContract?.required
    || manifest.evidenceContract.readbackRequired
    || manifest.evidenceContract.kinds.length !== 1
    || manifest.evidenceContract.kinds[0] !== 'tool_result') return null;
  return parseProviderAcknowledgementMode({ version: 1, kind: 'provider_acknowledgement_v1', workContractId: input.workContractId });
}
