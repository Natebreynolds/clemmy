/**
 * Turn-time retrieval over the connect-time capability index.
 *
 * The index is provisioning-derived retrieval. A hit is not authority,
 * availability, a trusted manifest, a current observation, or a bindable
 * catalog entry. Dispatch still requires an adapter-attested contract,
 * a fresh observation, and live revalidation.
 */
import { createHash } from 'node:crypto';
import {
  searchCapabilityOperations,
  type CapabilityOperationHit,
} from '../../memory/capability-index.js';
import type { HostCapabilityDescriptorV1 } from '../semantic-boundary/turn-semantic-proposal.js';
import {
  peekCatalogSnapshotForSource,
  peekHostCapabilityCatalogFactory,
  type RegisteredHostCapability,
} from './host-capability-catalog-factory.js';
import { provenCapabilityEntriesForTurn } from './capability-resolution.js';

const INDEX_SHORTLIST = 24;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function capabilityIdOf(identifier: string): string {
  return `cap:resolved:${identifier.trim().toLowerCase()}`;
}

function destinationFamilyOf(carrier: string): string {
  return carrier.trim().toLowerCase();
}

function descriptorFromHit(hit: CapabilityOperationHit): HostCapabilityDescriptorV1 {
  const write = hit.effectClass === 'write';
  const identifier = hit.identifier.trim();
  const family = destinationFamilyOf(hit.carrier);
  return {
    id: capabilityIdOf(identifier),
    effect: write ? 'external_write' : 'read',
    purpose: write ? 'persist_collection' : 'collect_records',
    acceptedInputKinds: write ? ['evidence', 'records'] : ['evidence'],
    producedOutputKinds: write ? ['evidence', 'created_resource'] : ['evidence', 'records'],
    applicableDeliverableKinds: write ? ['evidence', family || 'artifact'] : ['evidence'],
    inputShape: write ? 'records' : 'evidence',
    outputShape: write ? 'created_resource' : 'records',
    outputKind: write ? 'created_resource' : 'records',
    deliverableKind: write ? (family || 'artifact') : 'records',
    destinationPosture: write ? 'create_new' : null,
    evidenceKinds: write ? ['receipt', 'readback'] : ['payload'],
    handleRequired: write,
    readbackRequired: write,
    accountScope: hit.accountIdentity ?? 'runtime',
    manifestDigest: sha256(JSON.stringify({
      v: 1,
      kind: 'capability_index',
      identifier,
      carrier: hit.carrier,
      effect: hit.effectClass,
      provenance: hit.effectProvenance,
    })),
    advisoryRoles: write ? ['create', 'destination'] : ['source', 'collection', 'collect'],
  };
}

export function hostDescriptorsFromCapabilityIndex(objective: string): HostCapabilityDescriptorV1[] {
  try {
    return searchCapabilityOperations(objective, { limit: INDEX_SHORTLIST })
      .filter((hit) => hit.effectClass === 'read' || hit.effectClass === 'write')
      .map(descriptorFromHit);
  } catch {
    return [];
  }
}

function catalogEntryIsAttested(entry: RegisteredHostCapability): boolean {
  return Boolean(
    entry.capabilityId.trim()
    && entry.toolName.trim()
    && entry.schemaDigest.trim()
    && entry.manifestDigest?.trim()
    && entry.manifest
    && typeof entry.invoke === 'function',
  );
}

export function catalogEntriesForAcceptedSource(input: {
  sessionId: string;
  sourceUserSeq: number;
  objective?: string;
}): RegisteredHostCapability[] {
  void input.objective;
  const selectedIds = new Set(
    provenCapabilityEntriesForTurn(input)
      .filter((entry) => entry.kind === 'composio' || entry.kind === 'cli' || entry.kind === 'mcp')
      .map((entry) => capabilityIdOf(entry.identifier)),
  );
  // PEEK, never persist: this runs from pre-model preparation (deterministic
  // compile, bind enumeration) BEFORE foreground tool_search can disclose
  // anything. Persisting here durably froze an empty snapshot that every
  // later plan admission was refused against (2026-08-26 gauntlet). The
  // snapshot is frozen by plan admission / the execution owner, never by prep.
  const frozen = peekCatalogSnapshotForSource({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
  });
  const snapshot = frozen.ok
    ? [...frozen.entries]
    : (peekHostCapabilityCatalogFactory()?.snapshot() ?? []);
  return snapshot.filter((entry) => {
    if (entry.effect === 'host_only') return catalogEntryIsAttested(entry);
    return catalogEntryIsAttested(entry) && selectedIds.has(entry.capabilityId);
  });
}

/** Index retrieval only. Never installs manifests or observations. */
export async function registerIndexedCapabilitiesForTurn(input: {
  sessionId: string;
  sourceUserSeq: number;
  objective: string;
}): Promise<{ registered: string[]; descriptors: HostCapabilityDescriptorV1[] }> {
  void input.sessionId;
  void input.sourceUserSeq;
  return { registered: [], descriptors: hostDescriptorsFromCapabilityIndex(input.objective) };
}
