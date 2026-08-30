/**
 * Process-opaque handoff from provider-neutral live-read discovery to the
 * primary planning catalog.
 *
 * A tool_search result is presentation data.  Even when it came from a real
 * carrier, its name/schema JSON must never become planning authority by shape.
 * The discovery source therefore receives this zero-data token only after the
 * shared acquisition registry installed one exact current capability.  The
 * disclosure boundary consumes the token only after reopening the same
 * manifest, callable catalog row, production port, and observed schema bytes.
 */
import { closedCanonicalJson } from '../../shared/closed-canonical-json.js';
import { digestSchema, loadToolContract } from '../../tools/tool-contract-store.js';
import {
  capabilityManifestDigest,
  currentCapabilityManifest,
  type CapabilityManifestV1,
} from './capability-manifest.js';
import { peekCapabilityManifestStore } from './capability-manifest-store.js';
import {
  isCurrentCallableCatalogEntry,
  peekHostCapabilityCatalogFactory,
  type RegisteredHostCapability,
} from './host-capability-catalog-factory.js';
import type { MaterializeLiveReadCapabilityResult } from './live-capability-materializer.js';
import { resolveProductionPortsForManifest } from './production-capability-ports.js';

export const AUTHORIZED_LIVE_READ_REGISTRY_PROVENANCE = 'authorized_live_read_registry' as const;
const AUTHORIZED_LIVE_READ_PLANNING_SCOPE = 'authorized_live_read_planning_v1' as const;
const SCHEMA_JSON_OPTIONS = Object.freeze({
  maxDepth: 24,
  maxNodes: 100_000,
  maxStringBytes: 1_048_576,
  maxTotalBytes: 8_388_608,
});

export interface AuthorizedLiveReadPlanningAuthorityV1 {
  readonly scope: typeof AUTHORIZED_LIVE_READ_PLANNING_SCOPE;
}

export interface CurrentLiveReadPlanningDefinitionV1 {
  readonly providerInputSchemaDigest: string;
  readonly definitionFingerprint: string;
  readonly providerOperationVersion: string;
  readonly providerOutputSchemaDigest: string | null;
  readonly invokePortId: string;
}

export interface ReopenedAuthorizedLiveReadPlanningCapabilityV1 {
  readonly entry: RegisteredHostCapability;
  readonly manifest: CapabilityManifestV1;
  readonly definition: CurrentLiveReadPlanningDefinitionV1;
}

interface AuthorizedLiveReadPlanningState {
  sessionId: string;
  sourceUserSeq: number;
  manifestId: string;
  manifestDigest: string;
  operationId: string;
  providerKind: string;
  accountId: string;
  effect: 'read';
  inputSchemaDigest: string;
  definitionFingerprint: string;
  providerOperationVersion: string;
  providerOutputSchemaDigest: string | null;
  invokePortId: string;
  argumentCompiler: { id: string; version: string };
}

const planningStates = new WeakMap<object, AuthorizedLiveReadPlanningState>();

function closedSchema(value: unknown): Readonly<Record<string, unknown>> | null {
  try {
    const parsed = JSON.parse(closedCanonicalJson(value, SCHEMA_JSON_OPTIONS)) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return Object.freeze(parsed as Record<string, unknown>);
  } catch {
    return null;
  }
}

/**
 * Reconstruct the provider-definition fields available at every later plan
 * freeze.  A generic live-read manifest without provider-native external
 * metadata still has an exact definition fingerprint; its input schema is
 * reopened from the contract written by the same materialization observation.
 * Output identity remains inside the full definition fingerprint unless the
 * carrier supplied an independently meaningful provider output digest.
 */
export function currentLiveReadPlanningDefinitionFromEntry(
  entry: RegisteredHostCapability,
): CurrentLiveReadPlanningDefinitionV1 | null {
  if (!isCurrentCallableCatalogEntry(entry)) return null;
  const manifest = currentCapabilityManifest(entry.manifest);
  if (!manifest || manifest.effect !== 'read') return null;
  const stored = peekCapabilityManifestStore()?.get(manifest.manifestId);
  if (
    !stored
    || stored.manifest.lifecycle.state !== 'current'
    || stored.digest !== capabilityManifestDigest(manifest)
    || capabilityManifestDigest(stored.manifest) !== stored.digest
  ) return null;
  const port = resolveProductionPortsForManifest(manifest);
  if (!port || typeof port.invoke !== 'function' || entry.invoke !== port.invoke) return null;
  const contract = loadToolContract(manifest.operationId);
  const manifestIssuedAtMs = Date.parse(manifest.provenance.issuedAt);
  const providerObservedAtMs = Date.parse(contract?.providerObservedAt ?? '');
  if (
    !contract
    || contract.identifier !== manifest.operationId
    || contract.providerAuthorityConflictAt !== undefined
    // The materializer issues the manifest from its first live attestation,
    // then saves the contract from its final post-observer re-read. That final
    // observation is normally a few milliseconds newer. An unchanged later
    // acquisition also reuses the same manifest while advancing the durable
    // schema observation. Require monotonic provenance, never byte-equal wall
    // timestamps; the exact schema/definition/port checks below still bind the
    // observation to this capability.
    || !Number.isFinite(manifestIssuedAtMs)
    || !Number.isFinite(providerObservedAtMs)
    || providerObservedAtMs < manifestIssuedAtMs
    || providerObservedAtMs > Date.now()
    || contract.providerObservedFingerprint !== contract.fingerprint
    || !entry.sourceSchemaFingerprint
    || contract.fingerprint !== entry.sourceSchemaFingerprint
    || (contract.providerOperationVersion !== undefined
      && contract.providerOperationVersion !== manifest.operationVersion)
  ) return null;
  const providerInputSchemaDigest = digestSchema(contract.schema);
  const external = manifest.externalDefinition;
  if (
    external
    && (
      external.providerInputSchemaDigest !== providerInputSchemaDigest
      || external.providerOutputSchemaObserved !== true
    )
  ) return null;
  return Object.freeze({
    providerInputSchemaDigest,
    definitionFingerprint: manifest.definitionFingerprint,
    providerOperationVersion: manifest.operationVersion,
    providerOutputSchemaDigest: external?.providerOutputSchemaDigest ?? null,
    invokePortId: manifest.invokePortId,
  });
}

function reopenState(
  state: AuthorizedLiveReadPlanningState,
): ReopenedAuthorizedLiveReadPlanningCapabilityV1 | null {
  const entry = peekHostCapabilityCatalogFactory()?.get(state.manifestId);
  if (!entry) return null;
  const definition = currentLiveReadPlanningDefinitionFromEntry(entry);
  const manifest = currentCapabilityManifest(entry.manifest);
  if (!definition || !manifest) return null;
  if (
    entry.capabilityId !== state.manifestId
    || entry.manifestDigest !== state.manifestDigest
    || manifest.manifestId !== state.manifestId
    || capabilityManifestDigest(manifest) !== state.manifestDigest
    || manifest.operationId !== state.operationId
    || manifest.providerKind !== state.providerKind
    || manifest.accountId !== state.accountId
    || manifest.effect !== state.effect
    || definition.providerInputSchemaDigest !== state.inputSchemaDigest
    || definition.definitionFingerprint !== state.definitionFingerprint
    || definition.providerOperationVersion !== state.providerOperationVersion
    || definition.providerOutputSchemaDigest !== state.providerOutputSchemaDigest
    || definition.invokePortId !== state.invokePortId
    || manifest.argumentCompiler.id !== state.argumentCompiler.id
    || manifest.argumentCompiler.version !== state.argumentCompiler.version
  ) return null;
  return Object.freeze({ entry, manifest, definition });
}

export function issueAuthorizedLiveReadPlanningAuthority(input: {
  identity: Readonly<{ sessionId: string; sourceUserSeq: number }>;
  materialized: Extract<MaterializeLiveReadCapabilityResult, { status: 'installed' }>;
  publicationGuard?: () => boolean;
}): {
  authority: AuthorizedLiveReadPlanningAuthorityV1;
  name: string;
  schema: Readonly<Record<string, unknown>>;
} | null {
  if (input.publicationGuard && !input.publicationGuard()) return null;
  const schema = closedSchema(input.materialized.attestation.inputSchema);
  const manifest = currentCapabilityManifest(input.materialized.manifest);
  if (!schema || !manifest || manifest.effect !== 'read') return null;
  const state: AuthorizedLiveReadPlanningState = {
    sessionId: input.identity.sessionId,
    sourceUserSeq: input.identity.sourceUserSeq,
    manifestId: manifest.manifestId,
    manifestDigest: capabilityManifestDigest(manifest),
    operationId: manifest.operationId,
    providerKind: manifest.providerKind,
    accountId: manifest.accountId,
    effect: 'read',
    inputSchemaDigest: digestSchema(schema),
    definitionFingerprint: manifest.definitionFingerprint,
    providerOperationVersion: manifest.operationVersion,
    providerOutputSchemaDigest: manifest.externalDefinition?.providerOutputSchemaDigest ?? null,
    invokePortId: manifest.invokePortId,
    argumentCompiler: { ...manifest.argumentCompiler },
  };
  const attestation = input.materialized.attestation;
  if (
    attestation.reference.identifier !== state.operationId
    || attestation.providerKind !== state.providerKind
    || attestation.accountId !== state.accountId
    || attestation.effect !== state.effect
    || digestSchema(attestation.inputSchema) !== state.inputSchemaDigest
    || attestation.definitionFingerprint !== state.definitionFingerprint
    || attestation.operationVersion !== state.providerOperationVersion
    || attestation.invoke.portId !== state.invokePortId
    || attestation.invoke.argumentCompiler.id !== state.argumentCompiler.id
    || attestation.invoke.argumentCompiler.version !== state.argumentCompiler.version
  ) return null;
  const reopened = reopenState(state);
  if (!reopened) return null;
  const authority = Object.freeze({ scope: AUTHORIZED_LIVE_READ_PLANNING_SCOPE });
  planningStates.set(authority, state);
  if (input.publicationGuard && !input.publicationGuard()) return null;
  return Object.freeze({ authority, name: state.operationId, schema });
}

export function inspectAuthorizedLiveReadPlanningAuthority(input: {
  authority: AuthorizedLiveReadPlanningAuthorityV1 | null | undefined;
  identity: Readonly<{ sessionId: string; sourceUserSeq: number }>;
  name: string;
  carrier: 'work_call' | 'call_tool';
  schema: unknown;
}): ReopenedAuthorizedLiveReadPlanningCapabilityV1 | null {
  if (
    !input.authority
    || input.authority.scope !== AUTHORIZED_LIVE_READ_PLANNING_SCOPE
    || input.carrier !== 'work_call'
  ) return null;
  const state = planningStates.get(input.authority as object);
  const schema = closedSchema(input.schema);
  if (
    !state
    || !schema
    || state.sessionId !== input.identity.sessionId
    || state.sourceUserSeq !== input.identity.sourceUserSeq
    || input.name.trim() !== state.operationId
    || digestSchema(schema) !== state.inputSchemaDigest
  ) return null;
  return reopenState(state);
}
