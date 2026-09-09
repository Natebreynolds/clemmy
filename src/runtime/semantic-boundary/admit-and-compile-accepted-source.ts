/**
 * One atomic host function: load durable source, audience, and one frozen
 * policy snapshot; interpret; validate; admit; compile. Callers do not pass
 * text or constructed authority.
 */
import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import { getRuntimeEnv } from '../../config.js';
import {
  peekTaskContinuityPacket,
  readConsumedTaskContinuityPacket,
} from '../../memory/task-continuity.js';
import { getProactivityPolicySnapshot } from '../../agents/proactivity-policy.js';
import {
  admitTurnSemantics,
  type HostSemanticAuthorityV1,
} from './admit-turn-semantics.js';
import {
  compileDurableAcceptedTurnGraph,
  compilePrimaryModelAcceptedTurnGraph,
  type AdmittedClampedSemanticsV1,
  type CompileDurableAcceptedTurnGraphInput,
} from '../graph/admitted-turn-semantics.js';
import { audienceHashOf, buildTurnSemanticHostViewV1 } from './build-semantic-host-view.js';
import { interpretAcceptedSource } from './interpret-accepted-source.js';
import { snapshotFromAcceptedSource } from './prepare-accepted-source.js';
import { peekTurnSemanticModelPort } from './turn-semantic-port-registry.js';
import {
  recordSemanticDispositionOutcome,
  recordSemanticParticipation,
  semanticPortParticipated,
} from './semantic-disposition.js';
import {
  bindExecutableDestination,
  destinationCandidateLadder,
  unionEvidenceFloor,
  type CanonicalDestinationBindingV1,
  type DestinationEvidenceFloorV1,
} from '../harness/destination-binding.js';
import {
  freezeCatalogSnapshotForPlanAdmission,
  freezeCatalogSnapshotForSource,
  peekCatalogSnapshotForSource,
  peekHostCapabilityCatalogFactory,
  canonicalResolvedCapabilityId,
  canonicalCatalogIdentityOf,
  isCurrentCallableCatalogEntry,
  persistedCatalogSnapshotManifestIdsForSource,
  type RegisteredHostCapability,
} from '../harness/host-capability-catalog-factory.js';
import { currentAcceptedSourceCatalogManifestScope } from '../harness/accepted-source-catalog-scope.js';
import {
  type HostCapabilityDescriptorV1,
  type TurnSemanticProposalV1,
} from './turn-semantic-proposal.js';
import { selectRelevantCapabilityDescriptors } from './capability-candidate-retrieval.js';
import { isLegacyGenericProviderWriteEvidencePolicy, registerProofProvisionedCapabilities } from '../harness/proof-provisioned-catalog.js';
import { createProductionMcpReadCarrier } from '../harness/production-mcp-read-carrier.js';
import { parseNamespacedTool } from '../mcp-namespace-shim.js';
import {
  hostDescriptorsFromCapabilityIndex,
  registerIndexedCapabilitiesForTurn,
} from '../harness/indexed-capability-catalog.js';
import { synthesizeConstructOperations } from './host-bind-operations.js';
import {
  recordTurnGraphShadow,
  recordTurnGraphShadowChecked,
  graphSemanticText,
  sessionHasPriorRetrieveOrAct,
  turnGraphFromShadowEvent,
} from '../graph/turn-graph-shadow.js';
import {
  rehydrateConsumedClarificationContext,
  verifyDurableClarificationContext,
} from '../harness/task-continuity-runtime.js';
import { classifyMessageIntent, refersToUserOrHostedWorld } from '../../assistant/message-intent.js';
import {
  markAdmissionCapabilityResolutionSuperseded,
  provenCapabilityEntriesForTurn,
  resolveTurnCapabilities,
} from '../harness/capability-resolution.js';
import { digestSchema } from '../../tools/tool-contract-store.js';
import {
  getCachedToolSchema,
  liveComposioOperationVersion,
  liveComposioOutputSchema,
} from '../../tools/composio-schema-cache.js';
import {
  listRegisteredToolkitNamespaces,
  registeredToolkitNamespaceOfOperation,
} from '../../integrations/composio/toolkit-slug.js';
import { fingerprintComposioProviderDefinition } from '../../integrations/composio/provider-definition-identity.js';
import { classifyComposioActionConsequence } from '../../integrations/composio/slug-effect.js';
import {
  validatedDocumentedComposioDefinitionContracts,
} from '../../integrations/composio/operation-semantics.js';
import {
  capabilityManifestDigest,
  currentCapabilityManifest,
  parseCapabilityManifestOperationSemantics,
  type CapabilityManifestOperationSemanticsV1,
} from '../harness/capability-manifest.js';
import {
  peekCapabilityManifestStore,
  resolveCurrentSuccessorManifest,
} from '../harness/capability-manifest-store.js';
import {
  parseOperationVerificationContract,
  readbackContractMatchesMutation,
  type OperationVerificationContractV1,
} from '../harness/mutation-verification-contract.js';
import {
  AUTHORIZED_LOCAL_REGISTRY_PROVENANCE,
  inspectAuthorizedLocalPlanningDisclosureCandidates,
  observeCurrentLocalPlanningDefinition,
  revalidateLocalPlanningDefinition,
  type AuthorizedLocalPlanningDefinitionV1,
} from '../harness/local-planning-capability.js';
import {
  AUTHORIZED_LIVE_READ_REGISTRY_PROVENANCE,
  currentLiveReadPlanningDefinitionFromEntry,
  inspectAuthorizedLiveReadPlanningAuthority,
  type AuthorizedLiveReadPlanningAuthorityV1,
} from '../harness/live-read-planning-authority.js';
import { TOOL_REGISTRY } from '../../tools/tool-registry.js';
import { explicitCapabilityNamespaceConflict } from './capability-namespace-alignment.js';
import { requestedCapabilityEffectScope } from '../../memory/capability-effect-scope.js';

import { snapshotTurnGraphPolicy, validateTurnGraph } from '../graph/turn-graph-compiler.js';
import type { CompileTurnGraphResult, TurnGraphSurface } from '../graph/turn-graph-ir.js';
import type { TurnIdentity } from '../harness/turn-outcome.js';
import type { TaskContinuationContext } from '../../types.js';
import {
  appendEvent,
  getSession,
  getTurnGraphEventForSource,
  listEvents,
  readPrimaryModelPlanningCardSnapshot,
  recordPrimaryModelPlanningCardSnapshotOnce,
  type EventRow,
  type PrimaryModelPlanningCardSnapshotRead,
} from '../harness/eventlog.js';
import { pullRecentTurnsForHarnessHistory } from '../harness/session-transcript.js';
import pino from 'pino';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}


const logger = pino({ name: 'clementine-next.accepted-source-destination' });

export const CONVERSATION_SHORT_CIRCUIT_REASON = 'conversation_short_circuit';

const DESTINATION_WRITE_EFFECTS = new Set(['local_write', 'external_write', 'admin']);

type HostDerivedPlanDestinationResult =
  | {
      ok: true;
      proposal: TurnSemanticProposalV1;
      derived: boolean;
    }
  | { ok: false; reason: string };

/**
 * Fill only a MISSING primary-model destination from the exact frozen catalog.
 *
 * Foreground provider discovery initially exposes a compact staged descriptor.
 * That descriptor can intentionally omit destination metadata even though plan
 * admission has since re-provisioned the selected definition and frozen its
 * full current manifest. Requiring the model to copy those later host facts
 * made an otherwise exact write categorically fail `write_not_aligned`.
 *
 * The model never supplies authority here. Every external/admin write ref must
 * resolve (directly or through the manifest store's current-successor edge) to
 * one exact CURRENT entry in the just-frozen catalog; its declared effect must
 * match the operation. Multiple distinct account/family/posture destinations
 * remain ambiguous and are refused instead of guessed. Clementine-local writes
 * retain their separate source-bound envelope exception because their target
 * lives in validated invocation arguments rather than a provider destination.
 */
export function deriveMissingPrimaryPlanDestination(input: {
  proposal: TurnSemanticProposalV1;
  catalogEntries: readonly RegisteredHostCapability[];
  /** Test seam only; production supplies the installed manifest store's exact
   * current-successor resolution. The resolved id still has to match one exact
   * current frozen entry below, so this callback cannot mint authority. */
  resolveCurrentRef?: (capabilityRef: string) => string | undefined;
}): HostDerivedPlanDestinationResult {
  const work = input.proposal.work;
  if (!work || work.destination) {
    return { ok: true, proposal: input.proposal, derived: false };
  }
  if ((work.destinations?.length ?? 0) > 0) {
    return { ok: false, reason: 'host_destination_projection_conflict' };
  }
  const destinationWrites = work.operations.filter((operation) => (
    operation.requestedEffect === 'external_write'
    || operation.requestedEffect === 'admin'
  ));
  if (destinationWrites.length === 0) {
    return { ok: true, proposal: input.proposal, derived: false };
  }

  const destinations: Array<{
    account: string;
    posture: 'create_new' | 'named_existing';
    family: string;
    handleRequired: boolean;
  }> = [];
  for (const operation of destinationWrites) {
    const selectedRef = operation.capabilityRef;
    const currentRef = input.resolveCurrentRef?.(selectedRef) ?? selectedRef;
    const candidates = input.catalogEntries.filter((entry) => {
      if (entry.capabilityId !== currentRef) return false;
      const identity = canonicalCatalogIdentityOf(entry);
      return Boolean(
        identity
        && isCurrentCallableCatalogEntry(entry)
        && identity.capabilityId === currentRef
        && identity.manifestId === currentRef
        && currentCapabilityManifest(entry.manifest),
      );
    });
    if (candidates.length !== 1) {
      return {
        ok: false,
        reason: `host_destination_identity_unavailable:${selectedRef}`,
      };
    }
    const entry = candidates[0]!;
    if (entry.effect !== operation.requestedEffect) {
      return {
        ok: false,
        reason: `host_destination_effect_mismatch:${selectedRef}`,
      };
    }
    const identity = canonicalCatalogIdentityOf(entry)!;
    const destination = identity.destination;
    if (
      !destination
      || (destination.posture !== 'create_new' && destination.posture !== 'named_existing')
      || !destination.family.trim()
    ) {
      return {
        ok: false,
        reason: `host_destination_metadata_unavailable:${selectedRef}`,
      };
    }
    const descriptor = hostDescriptorFromRegistered(entry);
    if (!descriptor || descriptor.effect !== operation.requestedEffect) {
      return {
        ok: false,
        reason: `host_destination_descriptor_unavailable:${selectedRef}`,
      };
    }
    destinations.push({
      account: identity.account,
      posture: destination.posture,
      family: destination.family,
      handleRequired: descriptor.handleRequired,
    });
  }

  const destinationKeys = new Set(destinations.map((destination) => JSON.stringify({
    account: destination.account,
    posture: destination.posture,
    family: destination.family,
  })));
  if (destinationKeys.size !== 1) {
    return { ok: false, reason: 'host_destination_ambiguous_multiple_exact_targets' };
  }
  const first = destinations[0]!;
  const derived = {
    posture: first.posture,
    family: first.family,
    handleRequired: destinations.some((destination) => destination.handleRequired),
  };
  return {
    ok: true,
    derived: true,
    proposal: {
      ...input.proposal,
      work: {
        ...work,
        destinations: [{ ...derived }],
        destination: { ...derived },
      },
    },
  };
}

/**
 * A Clementine-local planned mutation does not have a provider destination
 * manifest by design. Its exact destination identity is reopened from the
 * source-bound authorized-local definition by the downstream node binder.
 *
 * This predicate receives only refs that were revalidated in the current plan
 * freeze. A `cap:local:`-looking string is therefore never enough to suppress
 * a real provider-binding failure.
 */
export function unboundDestinationUsesOnlyRevalidatedLocalEnvelopes(input: {
  operations: AdmittedClampedSemanticsV1['operations'];
  revalidatedLocalCapabilityRefs: ReadonlySet<string>;
}): boolean {
  const writeRefs = (input.operations ?? [])
    .filter((operation) => DESTINATION_WRITE_EFFECTS.has(operation.requestedEffect))
    .map((operation) => operation.capabilityRef);
  return writeRefs.length > 0 && writeRefs.every((ref) => (
    typeof ref === 'string' && input.revalidatedLocalCapabilityRefs.has(ref)
  ));
}

/**
 * Cheap-first routing: a closed-world conversational turn structurally cannot
 * use the catalog freeze, the descriptor block, or the semantic proposal (its
 * only admissible relation is 'conversation' with a null goal and no work),
 * yet it paid the full brain-model proposal every time (~5.4k tokens / 3.2s
 * live 2026-08-18 for "hey hows it going").
 *
 * This is a ceremony deferral, not route authority: every doubt pays full
 * admission. Closed-world talk dispatches as conversation. Action never
 * falls through to an untyped tool loop. Nothing here may choose effect,
 * provider, topology, or completion.
 */
function conversationShortCircuit(
  identity: Pick<TurnIdentity, 'sessionId' | 'sourceUserSeq'>,
  durableText: string,
): boolean {
  try {
    // A pending continuity packet means this turn may answer an open question
    // or slot — it must pay full admission.
    const packet = peekTaskContinuityPacket({ sessionId: identity.sessionId });
    if (packet.status === 'available') return false;
    const continuesHostedWork = sessionHasPriorRetrieveOrAct(
      identity.sessionId,
      identity.sourceUserSeq,
    );
    const verdict = classifyMessageIntent(durableText, {
      continueHostedWorld: continuesHostedWork,
    });
    // Closed-world talk skips the semantic port. A hosted-world retrieve still
    // pays admission so connected capabilities can bind — skipping lookup is
    // how a connected directory or store never gets used. A greeting prefix
    // does not make "what's on my calendar" closed-world: that ask names the
    // user's world even when the classifier's short-message casual gate fires.
    if (
      !continuesHostedWork
      && !refersToUserOrHostedWorld(durableText)
      && (verdict.intent === 'casual' || verdict.intent === 'conversation')
      && verdict.confidence >= 0.8
    ) return true;
    const resolution = resolveTurnCapabilities(durableText, { sessionId: identity.sessionId });
    if (resolution.entries.some((entry) => entry.status === 'proven')) return false;
    return false;
  } catch {
    // The short-circuit is an optimization; any failure pays full admission.
    return false;
  }
}

/** Surface-only optimization for the fresh host loop. A positive answer may
 * remove every action/discovery schema, but grants no route, graph, terminal,
 * or tool authority. Any uncertainty returns false and keeps the full loop. */
export function freshHostConversationSurfaceOnly(input: {
  sessionId: string;
  sourceUserSeq: number;
}): boolean {
  try {
    const accepted = listEvents(input.sessionId, {
      sinceSeq: input.sourceUserSeq - 1,
      types: ['user_input_received'],
      limit: 1,
    }).find((event) => event.seq === input.sourceUserSeq);
    const display = typeof accepted?.data.displayText === 'string' ? accepted.data.displayText.trim() : '';
    const text = display || (typeof accepted?.data.text === 'string' ? accepted.data.text.trim() : '');
    return Boolean(text) && conversationShortCircuit(input, text);
  } catch {
    return false;
  }
}

/**
 * PROVISION FROM PROOF (live 2026-08-18 session-fixture-unprovisioned-catalog): when the typed
 * catalog is unprovisioned — production packs refuse on this home — semantic
 * admission received zero capabilities and recorded "No host capabilities
 * were supplied, so no operations could be bound". The host had ALREADY
 * proven this turn's capabilities in capability_resolution (status=proven,
 * live prepared commands). Those proofs become citable descriptors so the
 * proposal can bind operations instead of leaving an unbound 12-node execute
 * loop. This supplies the SAME descriptor type through the SAME selection
 * pipe — proof-sourced, never a parallel authority; a provisioned catalog
 * always wins outright.
 */
export function hostDescriptorsFromResolutionProof(
  sessionId: string,
  sourceUserSeq: number | undefined,
): HostCapabilityDescriptorV1[] {
  try {
    const entries = provenCapabilityEntriesForTurn({ sessionId, sourceUserSeq });
    return entries.flatMap((entry) => {
      const identifier = entry.identifier.trim();
      const effect: HostCapabilityDescriptorV1['effect'] = entry.effectClass === 'write'
        ? 'external_write'
        : entry.effectClass === 'read'
          ? 'read'
          : 'unknown';
      if (effect === 'unknown') return [];
      const kind = identifier.toLowerCase();
      // ONE universal kind so proof-sourced operations can chain. The DAG
      // validator requires predecessor.producedOutputKinds to intersect
      // successor.acceptedInputKinds; the first cut of this bridge declared
      // accepted=[] and produced=[slug], an algebra that can never chain —
      // live 2026-08-18 session-fixture-remap-a seqs 58261/58274: the model proposed a
      // full operation DAG citing these refs and validation refused BOTH
      // turns with dag_kind_mismatch, killing bound nodes, fan-out, and the
      // second declared effect in one stroke.
      const descriptor: HostCapabilityDescriptorV1 = {
        id: canonicalResolvedCapabilityId(
          kind,
          entry.accountIdentity ?? null,
          entry.kind === 'composio' ? 'composio' : null,
        ),
        effect,
        purpose: entry.intent.slice(0, 200) || kind,
        acceptedInputKinds: ['evidence'],
        producedOutputKinds: ['evidence'],
        applicableDeliverableKinds: ['evidence'],
        inputShape: 'evidence',
        outputShape: 'evidence',
        outputKind: 'evidence',
        deliverableKind: 'evidence',
        destinationPosture: null,
        evidenceKinds: ['tool_result'],
        handleRequired: false,
        readbackRequired: effect === 'external_write',
        accountScope: entry.accountIdentity ?? 'runtime',
        manifestDigest: createHash('sha256')
          .update(JSON.stringify({ v: 1, kind: 'resolution_proof', identifier, effect, intent: entry.intent }))
          .digest('hex'),
      };
      return [descriptor];
    });
  } catch {
    return [];
  }
}

export function hostDescriptorFromRegistered(
  entry: RegisteredHostCapability,
): HostCapabilityDescriptorV1 | null {
  if (!entry.manifestDigest || !entry.manifest) return null;
  const effect = entry.effect;
  const acceptedInputKinds = [...(entry.manifest.acceptedInputKinds ?? [])];
  const producedOutputKinds = [...(entry.manifest.producedOutputKinds ?? [entry.manifest.outputContract.kind])];
  const applicableDeliverableKinds = [
    ...(entry.manifest.applicableDeliverableKinds ?? [entry.manifest.outputContract.kind]),
  ];
  return {
    id: entry.capabilityId,
    effect,
    purpose: entry.manifest.purpose,
    acceptedInputKinds,
    producedOutputKinds,
    applicableDeliverableKinds,
    inputShape: acceptedInputKinds.join(',') || entry.manifest.operationId,
    outputShape: producedOutputKinds.join(',') || entry.manifest.outputContract.kind,
    outputKind: producedOutputKinds[0] ?? entry.manifest.outputContract.kind,
    deliverableKind: applicableDeliverableKinds[0]
      ?? entry.destination?.family
      ?? entry.manifest.outputContract.kind,
    destinationPosture: entry.destination?.posture === 'create_new' || entry.destination?.posture === 'named_existing'
      ? entry.destination.posture
      : null,
    evidenceKinds: [...entry.manifest.evidenceContract.kinds],
    handleRequired: Boolean(entry.manifest.readbackContract?.required || entry.manifest.evidenceContract.readbackRequired),
    readbackRequired: Boolean(entry.manifest.evidenceContract.readbackRequired || entry.manifest.readbackContract?.required),
    accountScope: entry.account ?? entry.manifest.accountId,
    manifestDigest: entry.manifestDigest,
    advisoryRoles: entry.advisoryRoles,
  };
}

export type AdmitAndCompileAcceptedSourceResult =
  | { ok: true; event: EventRow; compiled: CompileTurnGraphResult }
  | { ok: false; reason: string };

const PRIMARY_MODEL_PLANNING_CATALOG_SCOPE = 'primary_model_planning_catalog_v1' as const;
interface StagedProviderDefinitionV1 {
  readonly version: 1;
  readonly providerInputSchemaDigest: string;
  readonly definitionFingerprint: string;
  readonly providerOperationVersion: string;
  readonly providerOutputSchemaDigest: string | null;
  readonly invokePortId: string;
  /** Exact adapter semantics observed with this same definition. Null means
   * non-verifier/non-verified-mutation; legacy rows never get restamped. */
  readonly verificationContract: OperationVerificationContractV1 | null;
  /** Provider-neutral operation semantics authored by the adapter against this
   * exact definition. Presence is sealed and revalidated like verification. */
  readonly operationSemantics: CapabilityManifestOperationSemanticsV1 | null;
}

interface StagedPrimaryModelPlanningCapabilityV1 {
  descriptor: HostCapabilityDescriptorV1;
  identifier: string;
  providerKind: string;
  accountIdentity: string;
  /** Provider definitions retain their independently meaningful identity
   * fields. A full definition fingerprint is never aliased to an input-schema
   * digest (or vice versa). */
  providerDefinition?: StagedProviderDefinitionV1;
  /** Local rows have no provider manifest. Their exact configured surface and
   * registry semantics are carried here and revalidated at plan freeze. */
  localDefinition?: AuthorizedLocalPlanningDefinitionV1;
}

interface PrimaryModelPlanningDisclosureV1 {
  descriptor: HostCapabilityDescriptorV1;
  identifier: string;
  providerKind: string;
  providerDefinition: StagedProviderDefinitionV1 | null;
}

const PLANNING_IDENTITY_DIGEST = /^[a-f0-9]{64}$/i;

function freezeStagedProviderDefinition(input: {
  providerInputSchemaDigest: string;
  definitionFingerprint: string;
  providerOperationVersion: string;
  providerOutputSchemaDigest: string | null;
  invokePortId: string;
  verificationContract: OperationVerificationContractV1 | null;
  operationSemantics: CapabilityManifestOperationSemanticsV1 | null;
}): StagedProviderDefinitionV1 | null {
  const providerInputSchemaDigest = input.providerInputSchemaDigest.trim().toLowerCase();
  const definitionFingerprint = input.definitionFingerprint.trim().toLowerCase();
  const providerOperationVersion = input.providerOperationVersion.trim();
  const invokePortId = input.invokePortId.trim();
  const providerOutputSchemaDigest = input.providerOutputSchemaDigest === null
    ? null
    : input.providerOutputSchemaDigest.trim().toLowerCase();
  if (
    !PLANNING_IDENTITY_DIGEST.test(providerInputSchemaDigest)
    || !PLANNING_IDENTITY_DIGEST.test(definitionFingerprint)
    || (providerOutputSchemaDigest !== null
      && !PLANNING_IDENTITY_DIGEST.test(providerOutputSchemaDigest))
    || !providerOperationVersion
    || !invokePortId
  ) return null;
  return Object.freeze({
    version: 1,
    providerInputSchemaDigest,
    definitionFingerprint,
    providerOperationVersion,
    providerOutputSchemaDigest,
    invokePortId,
    verificationContract: input.verificationContract,
    operationSemantics: input.operationSemantics,
  });
}

function stagedProviderDefinitionFromRegistered(
  entry: RegisteredHostCapability,
): StagedProviderDefinitionV1 | null {
  const manifest = entry.manifest;
  const external = manifest?.externalDefinition;
  if (!manifest || entry.schemaDigest !== manifest.definitionFingerprint) return null;
  const liveRead = currentLiveReadPlanningDefinitionFromEntry(entry);
  // Provider-native definitions retain their explicit input/output digests.
  // A generic live-read adapter without that optional envelope is accepted
  // only when the shared live-read authority module reopens its current
  // store/catalog/port/schema identity. Its full definition fingerprint still
  // covers output bytes and every invocation field.
  const providerInputSchemaDigest = liveRead?.providerInputSchemaDigest
    ?? (external?.providerOutputSchemaObserved === true
      ? entry.providerInputSchemaDigest ?? external.providerInputSchemaDigest
      : null);
  const providerOutputSchemaDigest = liveRead?.providerOutputSchemaDigest
    ?? (external?.providerOutputSchemaObserved === true
      ? external.providerOutputSchemaDigest ?? null
      : null);
  if (!providerInputSchemaDigest) return null;
  return freezeStagedProviderDefinition({
    providerInputSchemaDigest,
    definitionFingerprint: liveRead?.definitionFingerprint ?? manifest.definitionFingerprint,
    providerOperationVersion: liveRead?.providerOperationVersion ?? manifest.operationVersion,
    providerOutputSchemaDigest,
    invokePortId: liveRead?.invokePortId ?? manifest.invokePortId,
    verificationContract: external?.verification
      ? parseOperationVerificationContract(external.verification)
      : null,
    operationSemantics: manifest.operationSemantics
      ? parseCapabilityManifestOperationSemantics(manifest.operationSemantics)
      : null,
  });
}

function currentComposioProviderDefinition(input: {
  identifier: string;
  schema: Record<string, unknown>;
  accountIdentity: string;
}): StagedProviderDefinitionV1 | null {
  const liveSchema = getCachedToolSchema(input.identifier);
  const providerInputSchemaDigest = digestSchema(input.schema);
  if (!liveSchema || digestSchema(liveSchema) !== providerInputSchemaDigest) return null;
  const providerOperationVersion = liveComposioOperationVersion(input.identifier);
  const outputSchema = liveComposioOutputSchema(input.identifier);
  if (!providerOperationVersion || outputSchema === undefined) return null;
  const adapterContracts = validatedDocumentedComposioDefinitionContracts({
    operationId: input.identifier,
    inputSchema: input.schema,
    outputSchema,
  });
  if (!adapterContracts.ok) return null;
  const invokePortId = `port:cap:resolved:${input.identifier.toLowerCase()}:${input.identifier}`;
  const definitionFingerprint = fingerprintComposioProviderDefinition({
    operationId: input.identifier,
    operationVersion: providerOperationVersion,
    accountId: input.accountIdentity,
    invokePortId,
    inputSchema: input.schema,
    outputSchema,
  });
  if (!definitionFingerprint) return null;
  return freezeStagedProviderDefinition({
    providerInputSchemaDigest,
    definitionFingerprint,
    providerOperationVersion,
    providerOutputSchemaDigest: outputSchema ? digestSchema(outputSchema) : null,
    invokePortId,
    verificationContract: adapterContracts.verificationContract,
    operationSemantics: adapterContracts.operationSemantics,
  });
}

function replayedStagedProviderDefinition(value: unknown): StagedProviderDefinitionV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    row.version !== 1
    || typeof row.providerInputSchemaDigest !== 'string'
    || typeof row.definitionFingerprint !== 'string'
    || typeof row.providerOperationVersion !== 'string'
    || (row.providerOutputSchemaDigest !== null
      && typeof row.providerOutputSchemaDigest !== 'string')
    || typeof row.invokePortId !== 'string'
    || (row.verificationContract !== undefined
      && row.verificationContract !== null
      && !parseOperationVerificationContract(row.verificationContract))
    || (row.operationSemantics !== undefined
      && row.operationSemantics !== null
      && !parseCapabilityManifestOperationSemantics(row.operationSemantics))
  ) return null;
  return freezeStagedProviderDefinition({
    providerInputSchemaDigest: row.providerInputSchemaDigest,
    definitionFingerprint: row.definitionFingerprint,
    providerOperationVersion: row.providerOperationVersion,
    providerOutputSchemaDigest: row.providerOutputSchemaDigest,
    invokePortId: row.invokePortId,
    verificationContract: row.verificationContract === null || row.verificationContract === undefined
      ? null
      : parseOperationVerificationContract(row.verificationContract)!,
    operationSemantics: row.operationSemantics === null || row.operationSemantics === undefined
      ? null
      : parseCapabilityManifestOperationSemantics(row.operationSemantics)!,
  });
}

function stagedProviderDefinitionsEqual(
  left: StagedProviderDefinitionV1 | null | undefined,
  right: StagedProviderDefinitionV1 | null | undefined,
): boolean {
  return Boolean(left && right && JSON.stringify(left) === JSON.stringify(right));
}

function stagedMutationVerifierMatches(input: {
  mutation: StagedPrimaryModelPlanningCapabilityV1;
  candidate: StagedPrimaryModelPlanningCapabilityV1;
}): boolean {
  const mutationDefinition = input.mutation.providerDefinition;
  const candidateDefinition = input.candidate.providerDefinition;
  const mutationContract = mutationDefinition?.verificationContract;
  const candidateContract = candidateDefinition?.verificationContract;
  if (
    !mutationContract
    || !('mutation' in mutationContract)
    || !candidateContract
    || !('readback' in candidateContract)
    || input.mutation.providerKind !== input.candidate.providerKind
    || input.mutation.accountIdentity !== input.candidate.accountIdentity
  ) return false;
  const mutation = mutationContract.mutation;
  const readback = candidateContract.readback;
  return readbackContractMatchesMutation(mutation, readback);
}

function legacyProviderInputSchemaDigest(row: Record<string, unknown>): string | null {
  // A nested-but-invalid providerDefinition is not a legacy row and must not
  // be silently downgraded to the older, narrower identity shape.
  if (Object.prototype.hasOwnProperty.call(row, 'providerDefinition')) return null;
  if (typeof row.schemaFingerprint !== 'string') return null;
  const digest = row.schemaFingerprint.trim().toLowerCase();
  return PLANNING_IDENTITY_DIGEST.test(digest) ? digest : null;
}

/** Upgrade a pre-providerDefinition Composio disclosure from current evidence.
 * The legacy digest authorizes only the input-schema comparison. Every other
 * field is independently reconstructed from the still-live provider
 * observation, so the input digest is never promoted into a full definition
 * fingerprint by aliasing. */
function upgradeLegacyComposioProviderDefinition(input: {
  row: Record<string, unknown>;
  identifier: string;
  accountIdentity: string;
}): StagedProviderDefinitionV1 | null {
  const legacyInputDigest = legacyProviderInputSchemaDigest(input.row);
  if (!legacyInputDigest) return null;
  const schema = getCachedToolSchema(input.identifier);
  if (!schema || digestSchema(schema) !== legacyInputDigest) return null;
  const current = currentComposioProviderDefinition({
    identifier: input.identifier,
    schema,
    accountIdentity: input.accountIdentity,
  });
  // A historical row that never carried verifier semantics cannot be promoted
  // into authority using today's adapter declaration.
  if (current?.verificationContract || current?.operationSemantics) return null;
  return current?.providerInputSchemaDigest === legacyInputDigest ? current : null;
}

const primaryModelPlanningCatalogs = new WeakMap<object, {
  sessionId: string;
  sourceUserSeq: number;
  objective: string;
  effectCeiling: HostCapabilityDescriptorV1['effect'];
  withheld: PlanningCardWithheldV1[];
  /** The exact bounded refs the foreground model may currently cite. */
  capabilities: HostCapabilityDescriptorV1[];
  /** Every exact currently materialized manifest observed by this planning frame. */
  liveCapabilities: readonly HostCapabilityDescriptorV1[];
  disclosureByName: ReadonlyMap<string, PrimaryModelPlanningDisclosureV1>;
  /** Exact foreground-search disclosures that are not executable yet. The
   * selected subset is published and revalidated only inside plan_task. */
  stagedById: Map<string, StagedPrimaryModelPlanningCapabilityV1>;
  digest: string;
}>();

export interface PrimaryModelPlanningCatalogAuthorityV1 {
  readonly scope: typeof PRIMARY_MODEL_PLANNING_CATALOG_SCOPE;
}

export interface HostFreshPlanningContextV1 {
  readonly authority: PrimaryModelPlanningCatalogAuthorityV1;
  readonly identity: Readonly<{ sessionId: string; sourceUserSeq: number }>;
  readonly capabilities: readonly HostCapabilityDescriptorV1[];
  readonly digest: string;
  readonly effectCeiling: HostCapabilityDescriptorV1['effect'];
  readonly withheld: readonly PlanningCardWithheldV1[];
}

/** Rebuild the public, immutable view of one live planning authority.
 *
 * Foreground tool_search disclosures monotonically update the private catalog
 * behind the opaque authority. Callers must therefore re-read this view at a
 * model/tool boundary instead of retaining the initial (possibly empty)
 * snapshot forever. Each returned digest remains bound to exactly the returned
 * capability array; previously returned snapshots are never mutated. */
export function snapshotPrimaryModelPlanningContext(
  authority: PrimaryModelPlanningCatalogAuthorityV1,
): HostFreshPlanningContextV1 | null {
  if (
    !authority
    || authority.scope !== PRIMARY_MODEL_PLANNING_CATALOG_SCOPE
  ) return null;
  const catalog = primaryModelPlanningCatalogs.get(authority as object);
  if (!catalog) return null;
  return Object.freeze({
    authority,
    identity: Object.freeze({
      sessionId: catalog.sessionId,
      sourceUserSeq: catalog.sourceUserSeq,
    }),
    capabilities: Object.freeze(catalog.capabilities.map((descriptor) => Object.freeze({
      ...descriptor,
      acceptedInputKinds: Object.freeze([...descriptor.acceptedInputKinds]),
      producedOutputKinds: Object.freeze([...descriptor.producedOutputKinds]),
      applicableDeliverableKinds: Object.freeze([...descriptor.applicableDeliverableKinds]),
      evidenceKinds: Object.freeze([...descriptor.evidenceKinds]),
      ...(descriptor.advisoryRoles
        ? { advisoryRoles: Object.freeze([...descriptor.advisoryRoles]) }
        : {}),
    }))),
    digest: catalog.digest,
    effectCeiling: catalog.effectCeiling,
    withheld: Object.freeze(catalog.withheld.map((entry) => Object.freeze({ ...entry }))),
  });
}

/**
 * Reopen only exact refs selected by the model from this accepted source's
 * private foreground-search staging ledger.
 *
 * The bounded planning card is a display surface, not the full same-source
 * disclosure ledger. A later tool_search can therefore return an exact ref
 * that remains staged when the eight-slot card is full. Plan completeness may
 * inspect that descriptor so it does not falsely call a selected write
 * "missing" before admission gets its existing chance to promote and
 * revalidate the selected staged ref. This snapshot grants, publishes, and
 * executes nothing; invented or cross-source refs are simply absent.
 */
export function snapshotPrimaryModelSelectedStagedPlanningDescriptors(input: {
  authority: PrimaryModelPlanningCatalogAuthorityV1;
  identity: Readonly<{ sessionId: string; sourceUserSeq: number }>;
  selectedRefs: ReadonlySet<string>;
}): readonly HostCapabilityDescriptorV1[] {
  if (
    !input.authority
    || input.authority.scope !== PRIMARY_MODEL_PLANNING_CATALOG_SCOPE
    || !input.identity
    || typeof input.identity.sessionId !== 'string'
    || !input.identity.sessionId
    || !Number.isSafeInteger(input.identity.sourceUserSeq)
    || input.identity.sourceUserSeq <= 0
    || !(input.selectedRefs instanceof Set)
    || input.selectedRefs.size > 32
    || [...input.selectedRefs].some((ref) => (
      typeof ref !== 'string'
      || !ref.startsWith('cap:')
      || ref !== ref.trim()
    ))
  ) return Object.freeze([]);
  const catalog = primaryModelPlanningCatalogs.get(input.authority as object);
  if (
    !catalog
    || catalog.sessionId !== input.identity.sessionId
    || catalog.sourceUserSeq !== input.identity.sourceUserSeq
    || catalog.digest !== sha256(JSON.stringify(catalog.capabilities))
  ) return Object.freeze([]);
  const selected = [...input.selectedRefs]
    .map((ref) => catalog.stagedById.get(ref))
    .filter((entry): entry is StagedPrimaryModelPlanningCapabilityV1 => Boolean(entry))
    .filter((entry) => (
      input.selectedRefs.has(entry.descriptor.id)
      && entry.accountIdentity === entry.descriptor.accountScope
    ))
    .map((entry) => Object.freeze({
      ...entry.descriptor,
      acceptedInputKinds: Object.freeze([...entry.descriptor.acceptedInputKinds]),
      producedOutputKinds: Object.freeze([...entry.descriptor.producedOutputKinds]),
      applicableDeliverableKinds: Object.freeze([...entry.descriptor.applicableDeliverableKinds]),
      evidenceKinds: Object.freeze([...entry.descriptor.evidenceKinds]),
      ...(entry.descriptor.advisoryRoles
        ? { advisoryRoles: Object.freeze([...entry.descriptor.advisoryRoles]) }
        : {}),
    }));
  return Object.freeze(selected);
}

export interface PrimaryModelPlanningReadCapabilityV1 {
  readonly capabilityId: string;
  readonly manifestDigest: string;
}

/** Reopen one exact read manifest from the opaque, source-bound foreground
 * planning card. This is deliberately narrower than the public snapshot: a
 * caller cannot nominate a catalog id, account, provider, or digest. It may
 * ask only whether the operation it is about to carry is the unique current
 * read on this exact bounded card.
 *
 * The result is a nomination, not dispatch authority. The host runner still
 * reopens the same catalog entry and independently proves its manifest,
 * effect, account, schema, canonical identity and immutable invoke port at
 * the final boundary. */
export function inspectPrimaryModelPlanningReadCapability(input: {
  authority: PrimaryModelPlanningCatalogAuthorityV1;
  identity: Readonly<{ sessionId: string; sourceUserSeq: number }>;
  operationId: string;
}): PrimaryModelPlanningReadCapabilityV1 | null {
  if (
    !input.authority
    || input.authority.scope !== PRIMARY_MODEL_PLANNING_CATALOG_SCOPE
    || !input.identity
    || typeof input.identity.sessionId !== 'string'
    || !input.identity.sessionId
    || !Number.isSafeInteger(input.identity.sourceUserSeq)
    || input.identity.sourceUserSeq <= 0
    || typeof input.operationId !== 'string'
    || !input.operationId
    || input.operationId !== input.operationId.trim()
  ) return null;
  const catalog = primaryModelPlanningCatalogs.get(input.authority as object);
  if (
    !catalog
    || catalog.sessionId !== input.identity.sessionId
    || catalog.sourceUserSeq !== input.identity.sourceUserSeq
  ) return null;
  const factory = peekHostCapabilityCatalogFactory();
  if (!factory) return null;

  const matches = new Map<string, PrimaryModelPlanningReadCapabilityV1>();
  for (const bounded of catalog.capabilities) {
    if (bounded.effect !== 'read') continue;
    const entry = factory.get(bounded.id);
    const manifest = currentCapabilityManifest(entry?.manifest);
    const currentDescriptor = entry ? hostDescriptorFromRegistered(entry) : null;
    if (
      !entry
      || !manifest
      || !currentDescriptor
      || entry.capabilityId !== bounded.id
      || entry.toolName !== input.operationId
      || manifest.operationId !== input.operationId
      || entry.effect !== 'read'
      || manifest.effect !== 'read'
      || entry.manifestDigest !== bounded.manifestDigest
      || capabilityManifestDigest(manifest) !== bounded.manifestDigest
      || JSON.stringify(currentDescriptor) !== JSON.stringify(bounded)
    ) continue;
    matches.set(entry.capabilityId, Object.freeze({
      capabilityId: entry.capabilityId,
      manifestDigest: bounded.manifestDigest,
    }));
  }
  return matches.size === 1 ? [...matches.values()][0]! : null;
}

function planningWords(value: string): Set<string> {
  return new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 3));
}

const FRESH_PLANNING_CARD_LIMIT = 8;
const FRESH_PLANNING_CARD_BYTES = 8_192;
/** Ceiling writes must appear, but must not occupy the whole card. Live
 * sess-desktop-55be25… filled all 8 slots with Sheets/DataForSEO writes, then
 * plan_task refused the Salesforce live read as undisclosed. Reserve a few
 * ceiling slots; leave the rest for lexical reads the write depends on. */
const FRESH_PLANNING_CARD_CEILING_RESERVE = 2;

const PLANNING_EFFECT_RANK: Record<HostCapabilityDescriptorV1['effect'], number> = {
  none: -1,
  unknown: -1,
  host_only: 0,
  read: 1,
  compute: 2,
  local_write: 3,
  external_write: 4,
  admin: 5,
};

export interface PlanningCardWithheldV1 {
  id: string;
  effect: HostCapabilityDescriptorV1['effect'];
  reason: string;
}

export interface RankedPlanningCardV1 {
  capabilities: HostCapabilityDescriptorV1[];
  withheld: PlanningCardWithheldV1[];
  effectCeiling: HostCapabilityDescriptorV1['effect'];
}

/**
 * Promote only refs the foreground model actually selected from this accepted
 * source's exact staged disclosures.
 *
 * The initial card is a bounded display surface, not the authority ledger for
 * later exact tool_search results. A full eight-slot card may therefore omit a
 * valid ref that tool_search just returned. `staged` is already source-bound
 * and contains the exact schema/registry/provider identity that plan freeze
 * will revalidate; an index nomination or an invented `cap:*` string is absent
 * from it and cannot enter through this seam.
 */
export function promoteSelectedSameSourceStagedPlanningDescriptors(input: {
  objective: string;
  current: readonly HostCapabilityDescriptorV1[];
  staged: readonly HostCapabilityDescriptorV1[];
  selectedRefs: ReadonlySet<string>;
  effectCeiling: HostCapabilityDescriptorV1['effect'];
}): RankedPlanningCardV1 | null {
  const currentById = new Map(input.current.map((descriptor) => [descriptor.id, descriptor]));
  const stagedById = new Map(input.staged.map((descriptor) => [descriptor.id, descriptor]));
  const missingSelected = [...input.selectedRefs].filter((ref) => !currentById.has(ref));
  if (missingSelected.some((ref) => !stagedById.has(ref))) return null;
  if (missingSelected.length === 0) {
    return {
      capabilities: [...input.current],
      withheld: [],
      effectCeiling: input.effectCeiling,
    };
  }

  const eligible = new Map(currentById);
  for (const ref of missingSelected) eligible.set(ref, stagedById.get(ref)!);
  const promoted = rankedLivePlanningDescriptors({
    objective: input.objective,
    live: [...eligible.values()],
    advisory: input.current,
    // Selection is the new, explicit signal. It outranks lexical overlap that
    // filled the initial card with similarly worded but unrelated operations.
    preferredLiveIds: input.selectedRefs,
    effectCeiling: input.effectCeiling,
  });
  return [...input.selectedRefs].every((ref) => (
    promoted.capabilities.some((descriptor) => descriptor.id === ref)
  )) ? promoted : null;
}

function planningEffectRank(effect: HostCapabilityDescriptorV1['effect']): number {
  return PLANNING_EFFECT_RANK[effect] ?? -1;
}

export function matchesPlanningEffectCeiling(
  effect: HostCapabilityDescriptorV1['effect'],
  ceiling: HostCapabilityDescriptorV1['effect'],
): boolean {
  return DESTINATION_WRITE_EFFECTS.has(effect)
    && DESTINATION_WRITE_EFFECTS.has(ceiling)
    && planningEffectRank(effect) <= planningEffectRank(ceiling);
}

/** Live-read rehydrate used to require effect==='read' and dropped writes
 * in silence (OPEN-THE-GATES 2026-08-29 :1251). A write-ceiling turn may
 * rehydrate any effect at or below that ceiling; a read ceiling stays read. */
export function liveRegistryDescriptorPassesRehydrate(
  effect: HostCapabilityDescriptorV1['effect'],
  ceiling: HostCapabilityDescriptorV1['effect'],
): boolean {
  if (effect === 'none' || effect === 'unknown') return false;
  if (ceiling === 'read' || ceiling === 'compute' || ceiling === 'host_only' || ceiling === 'none') {
    return effect === 'read';
  }
  return planningEffectRank(effect) <= planningEffectRank(ceiling);
}

function descriptorTouchesObjective(
  descriptor: HostCapabilityDescriptorV1,
  objectiveWords: ReadonlySet<string>,
): boolean {
  if (objectiveWords.size === 0) return false;
  const hay = planningWords([
    descriptor.id,
    descriptor.purpose,
    descriptor.deliverableKind,
    descriptor.outputKind,
    ...(descriptor.advisoryRoles ?? []),
  ].join(' '));
  for (const word of objectiveWords) {
    if ([...hay].some((candidate) => candidate.includes(word) || word.includes(candidate))) {
      return true;
    }
  }
  return false;
}

/** G15 used to refuse a write whose readback was not staged this turn.
 * Zero candidates is a host-internal gap (discovery has not happened), so
 * Slice 2 carries the obligation. Ambiguity is still a model-resolvable fact. */
export function verificationSuccessorDisposition(
  candidateCount: number,
): 'unique' | 'carry_obligation' | 'ambiguous' {
  if (candidateCount <= 0) return 'carry_obligation';
  if (candidateCount === 1) return 'unique';
  return 'ambiguous';
}

export interface FrozenCatalogAdvisoryV1 {
  id: string;
  reason: 'absent_from_current_host_catalog' | 'changed_shape_between_disclosure_and_admission';
}

/** G14 used to refuse a selected capability the live factory no longer held.
 * That gap is host-internal (readiness recompute, collateral eviction, id
 * successor). Unselected mismatches stay dropped; selected mismatches keep
 * the disclosed id and annotate. The write seam re-proves live. */
export function selectedFrozenCatalogDisposition(
  current: HostCapabilityDescriptorV1 | undefined,
  disclosed: HostCapabilityDescriptorV1,
): 'drop_unselected' | 'keep_disclosed' | 'keep_current' | 'keep_current_advisory' {
  return selectedFrozenCatalogDispositionFor(true, current, disclosed);
}

export function selectedFrozenCatalogDispositionFor(
  isSelected: boolean,
  current: HostCapabilityDescriptorV1 | undefined,
  disclosed: HostCapabilityDescriptorV1,
): 'drop_unselected' | 'keep_disclosed' | 'keep_current' | 'keep_current_advisory' {
  if (!current) return isSelected ? 'keep_disclosed' : 'drop_unselected';
  if (JSON.stringify(current) !== JSON.stringify(disclosed)) {
    return isSelected ? 'keep_current_advisory' : 'drop_unselected';
  }
  return 'keep_current';
}

export function inferPlanningEffectCeiling(
  objective: string,
  live: readonly HostCapabilityDescriptorV1[],
): HostCapabilityDescriptorV1['effect'] {
  const words = planningWords(objective);
  let ceiling: HostCapabilityDescriptorV1['effect'] = 'read';
  for (const descriptor of live) {
    if (!descriptorTouchesObjective(descriptor, words)) continue;
    if (planningEffectRank(descriptor.effect) > planningEffectRank(ceiling)) {
      ceiling = descriptor.effect;
    }
  }
  return ceiling;
}

/** The initial planning card exists before the primary model has produced a
 * semantic proposal, so `work.requestedEffect` is not available at this seam.
 * Reuse the accepted-request effect scope already shared by capability
 * retrieval instead of reconstructing effect from capability-name overlap.
 *
 * `external_write` is a planning-only upper bound for a write-shaped request:
 * it keeps both local and external reversible mutations citable. It grants no
 * dispatch authority; plan freeze and the physical write seam still reopen
 * the selected registry definition and prove its exact effect independently. */
export function planningEffectCeilingForAcceptedRequest(
  objective: string,
): HostCapabilityDescriptorV1['effect'] {
  const requested = requestedCapabilityEffectScope(objective);
  return requested === 'write' || requested === 'mixed'
    ? 'external_write'
    : 'read';
}
/** One absolute bound on the pre-model capability-resolution phase. Connected
 *  account resolution now owns a single 15s raw+SDK deadline; the phase starts
 *  this clock before launching either branch and gives the dependent proof
 *  projection a 5s tail. It therefore cannot stack a fresh 15s account clock
 *  behind index work (or a fresh proof clock behind accounts). A provider
 *  wedge becomes a bounded, recorded index-only degradation. Env override is
 *  an operational tunable, read per-call so tests and incidents can set it
 *  without a reboot. */
export function capabilityResolutionDeadlineMs(): number {
  const raw = Number(getRuntimeEnv('CAPABILITY_RESOLUTION_DEADLINE_MS', ''));
  return Number.isFinite(raw) && raw > 0 ? raw : 20_000;
}

function packPlanningCard(
  descriptors: readonly HostCapabilityDescriptorV1[],
): HostCapabilityDescriptorV1[] {
  const out: HostCapabilityDescriptorV1[] = [];
  let bytes = 2;
  for (const descriptor of descriptors) {
    if (out.length >= FRESH_PLANNING_CARD_LIMIT) break;
    const encodedBytes = Buffer.byteLength(JSON.stringify(descriptor), 'utf8');
    const next = bytes + encodedBytes + (out.length > 0 ? 1 : 0);
    if (next > FRESH_PLANNING_CARD_BYTES) break;
    out.push(descriptor);
    bytes = next;
  }
  return out;
}

/** Pre-coverage ranking: lexical + preferred + advisory only. Used to prove
 * the seq-95048 failure by re-breaking (OPEN-THE-GATES Slice 1). */
export function rankPlanningCardWithoutCeilingReservation(
  input: {
    objective: string;
    live: readonly HostCapabilityDescriptorV1[];
    advisory: readonly HostCapabilityDescriptorV1[];
    preferredLiveIds?: ReadonlySet<string>;
  },
): HostCapabilityDescriptorV1[] {
  return packPlanningCard(scoreLivePlanningDescriptors(input).map((entry) => entry.descriptor));
}

function scoreLivePlanningDescriptors(input: {
  objective: string;
  live: readonly HostCapabilityDescriptorV1[];
  advisory: readonly HostCapabilityDescriptorV1[];
  preferredLiveIds?: ReadonlySet<string>;
}): Array<{ descriptor: HostCapabilityDescriptorV1; score: number }> {
  const objectiveWords = planningWords(input.objective);
  const advisoryRank = new Map(input.advisory.map((descriptor, index) => [descriptor.id, index]));
  const scored = input.live.map((descriptor) => {
    const descriptorWords = planningWords([
      descriptor.id,
      descriptor.purpose,
      descriptor.deliverableKind,
      ...(descriptor.advisoryRoles ?? []),
    ].join(' '));
    let lexical = 0;
    for (const word of objectiveWords) {
      if ([...descriptorWords].some((candidate) => candidate.includes(word) || word.includes(candidate))) {
        lexical += 1;
      }
    }
    const ranked = advisoryRank.get(descriptor.id);
    const preferred = input.preferredLiveIds?.has(descriptor.id) === true;
    return {
      descriptor,
      score: (preferred ? 1_000_000 : 0)
        + lexical * 100
        + (ranked === undefined ? 0 : Math.max(1, 50 - ranked)),
    };
  });
  scored.sort((left, right) => right.score - left.score || left.descriptor.id.localeCompare(right.descriptor.id));
  return scored;
}

function replayedPlanningDescriptor(value: unknown): HostCapabilityDescriptorV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const effect = row.effect;
  const destinationPosture = row.destinationPosture;
  const stringArrays = [
    'acceptedInputKinds',
    'producedOutputKinds',
    'applicableDeliverableKinds',
    'evidenceKinds',
  ] as const;
  if (
    typeof row.id !== 'string'
    || !['none', 'read', 'compute', 'host_only', 'unknown', 'local_write', 'external_write', 'admin'].includes(String(effect))
    || typeof row.purpose !== 'string'
    || typeof row.inputShape !== 'string'
    || typeof row.outputShape !== 'string'
    || typeof row.outputKind !== 'string'
    || typeof row.deliverableKind !== 'string'
    || (destinationPosture !== null && destinationPosture !== 'create_new' && destinationPosture !== 'named_existing')
    || typeof row.handleRequired !== 'boolean'
    || typeof row.readbackRequired !== 'boolean'
    || typeof row.accountScope !== 'string'
    || typeof row.manifestDigest !== 'string'
    || !/^[a-f0-9]{64}$/i.test(row.manifestDigest)
    || stringArrays.some((key) => !Array.isArray(row[key]) || !(row[key] as unknown[]).every((entry) => typeof entry === 'string'))
    || (row.advisoryRoles !== undefined
      && (!Array.isArray(row.advisoryRoles) || !row.advisoryRoles.every((entry) => typeof entry === 'string')))
    // An upsert capability declares every posture it supports. The key is
    // OPTIONAL, so descriptors persisted before it existed still parse; when it
    // is present every member must be one of the two real postures.
    || (row.destinationPostures !== undefined
      && (!Array.isArray(row.destinationPostures)
        || row.destinationPostures.length === 0
        || !row.destinationPostures.every((entry) => entry === 'create_new' || entry === 'named_existing')))
  ) return null;
  return {
    id: row.id,
    effect: effect as HostCapabilityDescriptorV1['effect'],
    purpose: row.purpose,
    acceptedInputKinds: [...row.acceptedInputKinds as string[]],
    producedOutputKinds: [...row.producedOutputKinds as string[]],
    applicableDeliverableKinds: [...row.applicableDeliverableKinds as string[]],
    inputShape: row.inputShape,
    outputShape: row.outputShape,
    outputKind: row.outputKind,
    deliverableKind: row.deliverableKind,
    destinationPosture: destinationPosture as HostCapabilityDescriptorV1['destinationPosture'],
    evidenceKinds: [...row.evidenceKinds as string[]],
    handleRequired: row.handleRequired,
    readbackRequired: row.readbackRequired,
    accountScope: row.accountScope,
    manifestDigest: row.manifestDigest,
    ...(Array.isArray(row.advisoryRoles) ? { advisoryRoles: [...row.advisoryRoles as string[]] } : {}),
    // DROPPING this silently is what broke Space priming: space_save's upsert
    // fact vanished on replay, so the reopened card no longer matched the
    // published definition and the production loop blocked before its first
    // model call.
    ...(Array.isArray(row.destinationPostures)
      ? { destinationPostures: [...row.destinationPostures as ('create_new' | 'named_existing')[]] }
      : {}),
  };
}

/** Advisory proof/index rows may rank a live descriptor, but never enter the
 * authority set unless that exact id is also present in the frozen catalog.
 *
 * Ceiling-matching writes are reserved inside the existing 8-slot / 8,192-byte
 * bound so a write-shaped turn cannot mint a read-only card (OPEN-THE-GATES
 * Slice 1, live seq 95048). */
export function rankedLivePlanningDescriptors(input: {
  objective: string;
  live: readonly HostCapabilityDescriptorV1[];
  advisory: readonly HostCapabilityDescriptorV1[];
  /** Exact current catalog identities rehydrated from the intersection of
   * this request's index nomination and prior host proof. They are still live
   * descriptors—not memory rows—and must not be displaced from the bounded
   * card by unrelated globally-live capabilities. */
  preferredLiveIds?: ReadonlySet<string>;
  effectCeiling: HostCapabilityDescriptorV1['effect'];
}): RankedPlanningCardV1 {
  const effectCeiling = input.effectCeiling;
  const scored = scoreLivePlanningDescriptors(input);
  const ceilingWrites: HostCapabilityDescriptorV1[] = [];
  const remainder: HostCapabilityDescriptorV1[] = [];
  for (const entry of scored) {
    if (matchesPlanningEffectCeiling(entry.descriptor.effect, effectCeiling)) {
      ceilingWrites.push(entry.descriptor);
    } else {
      remainder.push(entry.descriptor);
    }
  }
  const reserved = ceilingWrites.slice(0, FRESH_PLANNING_CARD_CEILING_RESERVE);
  const packed = packPlanningCard([
    ...reserved,
    ...remainder,
    ...ceilingWrites.slice(reserved.length),
  ]);
  const selected = new Set(packed.map((descriptor) => descriptor.id));
  const withheld: PlanningCardWithheldV1[] = ceilingWrites
    .filter((descriptor) => !selected.has(descriptor.id))
    .map((descriptor) => ({
      id: descriptor.id,
      effect: descriptor.effect,
      reason: selected.size >= FRESH_PLANNING_CARD_LIMIT
        ? 'fresh_planning_card_limit'
        : 'fresh_planning_card_bytes',
    }));
  return { capabilities: packed, withheld, effectCeiling };
}

function replayedLocalPlanningDefinition(value: unknown): AuthorizedLocalPlanningDefinitionV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const descriptor = replayedPlanningDescriptor(row.descriptor);
  const safeMode = row.safeMode;
  if (
    row.version !== 1
    || row.provenance !== AUTHORIZED_LOCAL_REGISTRY_PROVENANCE
    || typeof row.name !== 'string'
    || (row.carrier !== 'call_tool' && row.carrier !== 'work_call')
    || typeof row.capabilityRef !== 'string'
    || typeof row.schemaFingerprint !== 'string'
    || typeof row.registrySemanticsFingerprint !== 'string'
    || typeof row.envelopeFingerprint !== 'string'
    || !/^[a-f0-9]{64}$/i.test(row.schemaFingerprint)
    || !/^[a-f0-9]{64}$/i.test(row.registrySemanticsFingerprint)
    || !/^[a-f0-9]{64}$/i.test(row.envelopeFingerprint)
    || typeof row.destructive !== 'boolean'
    || row.accountIdentity !== 'local_registry:host'
    || !descriptor
    || (safeMode !== null && (typeof safeMode !== 'object' || Array.isArray(safeMode)))
  ) return null;
  const localShape = descriptor.effect === 'read'
    ? row.consequence === 'read'
      && row.reversibility === 'read_only'
      && safeMode === null
      && descriptor.destinationPosture === null
    : descriptor.effect === 'local_write'
      && ['local_artifact', 'workspace_definition', 'workflow_definition', 'runtime_configuration']
        .includes(String(row.consequence))
      && ['reversible', 'create_only', 'irreversible'].includes(String(row.reversibility))
      && (row.reversibility !== 'irreversible' || (safeMode !== null && typeof safeMode === 'object'));
  if (!localShape) return null;
  return {
    version: 1,
    provenance: AUTHORIZED_LOCAL_REGISTRY_PROVENANCE,
    name: row.name,
    carrier: row.carrier,
    capabilityRef: row.capabilityRef,
    schemaFingerprint: row.schemaFingerprint,
    registrySemanticsFingerprint: row.registrySemanticsFingerprint,
    envelopeFingerprint: row.envelopeFingerprint,
    consequence: row.consequence as AuthorizedLocalPlanningDefinitionV1['consequence'],
    reversibility: row.reversibility as AuthorizedLocalPlanningDefinitionV1['reversibility'],
    destructive: row.destructive,
    accountIdentity: 'local_registry:host',
    safeMode: safeMode as AuthorizedLocalPlanningDefinitionV1['safeMode'],
    descriptor,
  };
}

async function durablePlanningDisclosures(input: {
  sessionId: string;
  sourceUserSeq: number;
  byName: ReadonlyMap<string, PrimaryModelPlanningDisclosureV1>;
}): Promise<{
  descriptors: HostCapabilityDescriptorV1[];
  stagedById: Map<string, StagedPrimaryModelPlanningCapabilityV1>;
}> {
  const out = new Map<string, HostCapabilityDescriptorV1>();
  const stagedById = new Map<string, StagedPrimaryModelPlanningCapabilityV1>();
  const proven = new Set<string>();
  for (const event of listEvents(input.sessionId, { types: ['capability_resolution'] })) {
    if (event.data.sourceUserSeq !== input.sourceUserSeq || event.data.authoritativeForTask === false) continue;
    const entries = Array.isArray(event.data.entries) ? event.data.entries : [];
    for (const raw of entries) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const entry = raw as Record<string, unknown>;
      if (
        entry.kind !== 'composio'
        || entry.status !== 'proven'
        || entry.connection === 'missing'
        || typeof entry.identifier !== 'string'
        || (entry.effectClass !== 'read' && entry.effectClass !== 'write')
      ) continue;
      proven.add(JSON.stringify({
        identifier: entry.identifier.trim().toLowerCase(),
        effectClass: entry.effectClass,
        accountIdentity: typeof entry.accountIdentity === 'string' ? entry.accountIdentity.trim() : 'runtime',
      }));
    }
  }
  for (const event of listEvents(input.sessionId, { types: ['capability_discovered'] })) {
    if (event.data.sourceUserSeq !== input.sourceUserSeq) continue;
    const rows = Array.isArray(event.data.capabilities) ? event.data.capabilities : [];
    for (const raw of rows) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const row = raw as Record<string, unknown>;
      const identifier = typeof row.identifier === 'string' ? row.identifier.trim().toLowerCase() : '';
      if (row.providerKind === AUTHORIZED_LOCAL_REGISTRY_PROVENANCE) {
        const prior = replayedLocalPlanningDefinition(row.localAuthority);
        if (
          !prior
          || identifier !== prior.name.toLowerCase()
          || row.capabilityRef !== prior.capabilityRef
          || row.manifestDigest !== prior.descriptor.manifestDigest
          || row.schemaFingerprint !== prior.schemaFingerprint
        ) continue;
        const revalidated = await revalidateLocalPlanningDefinition(prior);
        if (!revalidated.ok) continue;
        const staged: StagedPrimaryModelPlanningCapabilityV1 = {
          descriptor: revalidated.definition.descriptor,
          identifier: revalidated.definition.name,
          providerKind: AUTHORIZED_LOCAL_REGISTRY_PROVENANCE,
          accountIdentity: revalidated.definition.accountIdentity,
          localDefinition: revalidated.definition,
        };
        stagedById.set(staged.descriptor.id, staged);
        out.set(staged.descriptor.id, staged.descriptor);
        continue;
      }
      const match = input.byName.get(identifier);
      if (match) {
        const durableProviderKind = typeof row.providerKind === 'string'
          ? row.providerKind
          : typeof row.kind === 'string'
            ? row.kind
            : '';
        const durableAccountIdentity = typeof row.accountIdentity === 'string'
          ? row.accountIdentity.trim()
          : '';
        const providerDefinition = replayedStagedProviderDefinition(row.providerDefinition);
        const registeredAccountIdentity = match.descriptor.accountScope.trim();
        const identityMatches = durableProviderKind === match.providerKind
          && durableAccountIdentity === registeredAccountIdentity;
        const upgradedLegacyDefinition = identityMatches
          && match.providerKind.toLowerCase() === 'composio'
          && match.providerDefinition
          && match.providerDefinition.verificationContract === null
          && legacyProviderInputSchemaDigest(row) === match.providerDefinition.providerInputSchemaDigest
          ? match.providerDefinition
          : null;
        const exactProviderDefinition = providerDefinition ?? upgradedLegacyDefinition;
        if (
          row.capabilityRef !== match.descriptor.id
          || row.manifestDigest !== match.descriptor.manifestDigest
          || !identityMatches
          || !stagedProviderDefinitionsEqual(
            exactProviderDefinition,
            match.providerDefinition,
          )
        ) continue;
        stagedById.set(match.descriptor.id, {
          descriptor: match.descriptor,
          identifier: match.identifier,
          providerKind: match.providerKind,
          accountIdentity: registeredAccountIdentity,
          ...(exactProviderDefinition
            ? { providerDefinition: exactProviderDefinition }
            : {}),
        });
        out.set(match.descriptor.id, match.descriptor);
        continue;
      }
      const descriptor = replayedPlanningDescriptor(row.descriptor);
      const accountIdentity = typeof row.accountIdentity === 'string' && row.accountIdentity.trim()
        ? row.accountIdentity.trim()
        : 'runtime';
      const replayedProviderDefinition = replayedStagedProviderDefinition(row.providerDefinition);
      const providerDefinition = replayedProviderDefinition
        ?? (row.providerKind === 'composio'
          ? upgradeLegacyComposioProviderDefinition({
              row,
              identifier: typeof row.identifier === 'string' ? row.identifier.trim() : identifier,
              accountIdentity,
            })
          : null);
      const effectClass = descriptor?.effect === 'read'
        ? 'read'
        : descriptor?.effect === 'external_write'
          ? 'write'
          : null;
      if (
        row.providerKind !== 'composio'
        || !descriptor
        || !identifier
        || row.capabilityRef !== descriptor.id
        || row.manifestDigest !== descriptor.manifestDigest
        || descriptor.id !== canonicalResolvedCapabilityId(
          identifier,
          accountIdentity,
          row.providerKind === 'composio' ? 'composio' : null,
        )
        || descriptor.accountScope !== accountIdentity
        || !providerDefinition
        || !effectClass
        || !proven.has(JSON.stringify({ identifier, effectClass, accountIdentity }))
      ) continue;
      const staged = {
        descriptor,
        identifier: typeof row.identifier === 'string' ? row.identifier.trim() : identifier,
        providerKind: 'composio',
        accountIdentity,
        providerDefinition,
      };
      stagedById.set(descriptor.id, staged);
      out.set(descriptor.id, descriptor);
    }
  }
  return { descriptors: [...out.values()], stagedById };
}

interface DurableInitialPlanningCardV1 {
  readonly version: 1;
  readonly objectiveDigest: string;
  readonly effectCeiling: HostCapabilityDescriptorV1['effect'];
  readonly capabilities: readonly HostCapabilityDescriptorV1[];
  readonly withheld: readonly PlanningCardWithheldV1[];
  readonly cardDigest: string;
}

const PLANNING_DESCRIPTOR_REQUIRED_KEYS = [
  'acceptedInputKinds',
  'accountScope',
  'applicableDeliverableKinds',
  'deliverableKind',
  'destinationPosture',
  'effect',
  'evidenceKinds',
  'handleRequired',
  'id',
  'inputShape',
  'manifestDigest',
  'outputKind',
  'outputShape',
  'producedOutputKinds',
  'purpose',
  'readbackRequired',
] as const;

function exactPlanningDescriptorSnapshot(value: unknown): HostCapabilityDescriptorV1 | null {
  const parsed = replayedPlanningDescriptor(value);
  if (!parsed || !value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort();
  // Optional keys are admitted exactly when present. This is a CLOSED key-set
  // check, so an unlisted optional key rejects the whole descriptor — which is
  // how `destinationPostures` silently disqualified every Space card.
  const allowed = [
    ...PLANNING_DESCRIPTOR_REQUIRED_KEYS,
    ...(row.advisoryRoles === undefined ? [] : ['advisoryRoles']),
    ...(row.destinationPostures === undefined ? [] : ['destinationPostures']),
  ];
  if (keys.join('\0') !== allowed.sort().join('\0')) return null;
  // Preserve the exact serialized property order that contributed to the
  // original model-surface digest. The closed parser above proves every value;
  // freezing prevents later staging from mutating those persisted bytes.
  for (const key of [
    'acceptedInputKinds',
    'producedOutputKinds',
    'applicableDeliverableKinds',
    'evidenceKinds',
    'advisoryRoles',
    'destinationPostures',
  ]) {
    if (Array.isArray(row[key])) Object.freeze(row[key]);
  }
  return Object.freeze(row as unknown as HostCapabilityDescriptorV1);
}

function exactPlanningWithheldSnapshot(value: unknown): PlanningCardWithheldV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    Object.keys(row).sort().join('\0') !== 'effect\0id\0reason'
    || typeof row.id !== 'string'
    || !row.id
    || row.id !== row.id.trim()
    || !Object.prototype.hasOwnProperty.call(PLANNING_EFFECT_RANK, String(row.effect))
    || typeof row.reason !== 'string'
    || !row.reason
    || row.reason.length > 128
  ) return null;
  return Object.freeze({
    id: row.id,
    effect: row.effect as HostCapabilityDescriptorV1['effect'],
    reason: row.reason,
  });
}

function initialPlanningCardSnapshotJson(input: {
  objective: string;
  effectCeiling: HostCapabilityDescriptorV1['effect'];
  capabilities: readonly HostCapabilityDescriptorV1[];
  withheld: readonly PlanningCardWithheldV1[];
}): string {
  return JSON.stringify({
    version: 1,
    objectiveDigest: sha256(input.objective),
    effectCeiling: input.effectCeiling,
    capabilities: input.capabilities,
    withheld: input.withheld,
    cardDigest: sha256(JSON.stringify(input.capabilities)),
  } satisfies DurableInitialPlanningCardV1);
}

function parseDurableInitialPlanningCard(input: {
  snapshot: Extract<PrimaryModelPlanningCardSnapshotRead, { status: 'ready' }>;
  objective: string;
  currentById: ReadonlyMap<string, HostCapabilityDescriptorV1>;
}): { ok: true; card: DurableInitialPlanningCardV1 } | { ok: false; reason: string } {
  let decoded: unknown;
  try {
    decoded = JSON.parse(input.snapshot.snapshotJson) as unknown;
  } catch {
    return { ok: false, reason: 'durable initial planning card payload is malformed' };
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    return { ok: false, reason: 'durable initial planning card payload is malformed' };
  }
  const row = decoded as Record<string, unknown>;
  if (
    Object.keys(row).sort().join('\0')
      !== 'capabilities\0cardDigest\0effectCeiling\0objectiveDigest\0version\0withheld'
    || row.version !== 1
    || typeof row.objectiveDigest !== 'string'
    || row.objectiveDigest !== sha256(input.objective)
    || !Object.prototype.hasOwnProperty.call(PLANNING_EFFECT_RANK, String(row.effectCeiling))
    || typeof row.cardDigest !== 'string'
    || !PLANNING_IDENTITY_DIGEST.test(row.cardDigest)
    || row.cardDigest !== row.cardDigest.toLowerCase()
    || !Array.isArray(row.capabilities)
    || row.capabilities.length > FRESH_PLANNING_CARD_LIMIT
    || !Array.isArray(row.withheld)
    || row.withheld.length > 64
  ) return { ok: false, reason: 'durable initial planning card identity is invalid' };
  const capabilities = row.capabilities.map(exactPlanningDescriptorSnapshot);
  const withheld = row.withheld.map(exactPlanningWithheldSnapshot);
  if (capabilities.some((entry) => !entry) || withheld.some((entry) => !entry)) {
    return { ok: false, reason: 'durable initial planning card shape is invalid' };
  }
  const exactCapabilities = capabilities as HostCapabilityDescriptorV1[];
  const exactWithheld = withheld as PlanningCardWithheldV1[];
  const capabilityIds = new Set(exactCapabilities.map((descriptor) => descriptor.id));
  const withheldIds = new Set(exactWithheld.map((entry) => entry.id));
  if (
    capabilityIds.size !== exactCapabilities.length
    || withheldIds.size !== exactWithheld.length
    || exactWithheld.some((entry) => capabilityIds.has(entry.id))
    || Buffer.byteLength(JSON.stringify(exactCapabilities), 'utf8') > FRESH_PLANNING_CARD_BYTES
    || row.cardDigest !== sha256(JSON.stringify(exactCapabilities))
    || row.effectCeiling !== planningEffectCeilingForAcceptedRequest(input.objective)
  ) return { ok: false, reason: 'durable initial planning card digest or bounds are invalid' };

  for (const descriptor of exactCapabilities) {
    const current = input.currentById.get(descriptor.id);
    if (!current || JSON.stringify(current) !== JSON.stringify(descriptor)) {
      return {
        ok: false,
        reason: `durable initial planning card capability drifted: ${descriptor.id}`,
      };
    }
  }
  // Withheld rows grant nothing, but the exact originally-withheld identity
  // must still exist with the same effect. New live rows are intentionally
  // ignored: a same-source tool_search disclosure may extend staged authority,
  // never rewrite the model surface that was already admitted.
  for (const entry of exactWithheld) {
    const current = input.currentById.get(entry.id);
    if (!current || current.effect !== entry.effect) {
      return {
        ok: false,
        reason: `durable initial planning card withheld capability drifted: ${entry.id}`,
      };
    }
  }
  return {
    ok: true,
    card: Object.freeze({
      version: 1,
      objectiveDigest: row.objectiveDigest,
      effectCeiling: row.effectCeiling as HostCapabilityDescriptorV1['effect'],
      capabilities: Object.freeze(exactCapabilities),
      withheld: Object.freeze(exactWithheld),
      cardDigest: row.cardDigest,
    }),
  };
}

/** The one bounded repack rule for same-source disclosures, shared by the
 * in-process foreground tool_search lane and a re-prime that replays this
 * source's durable disclosures (a resumed source in another process must see
 * the same card the model was already shown). The admitted card is the base
 * and the advisory ordering; disclosed rows are preferred so unrelated live
 * rows cannot displace them; only disclosed writes may lift the ceiling (an
 * unrelated factory write must not turn a read ask into a write card); every
 * slot/byte bound still applies; the digest is bound to the returned rows. */
function repackPlanningCardWithSameSourceDisclosures(input: {
  objective: string;
  card: {
    capabilities: readonly HostCapabilityDescriptorV1[];
    effectCeiling: HostCapabilityDescriptorV1['effect'];
  };
  liveCapabilities: readonly HostCapabilityDescriptorV1[];
  disclosed: readonly HostCapabilityDescriptorV1[];
}): {
  capabilities: HostCapabilityDescriptorV1[];
  withheld: PlanningCardWithheldV1[];
  effectCeiling: HostCapabilityDescriptorV1['effect'];
  digest: string;
} {
  const live = new Map<string, HostCapabilityDescriptorV1>();
  for (const descriptor of input.liveCapabilities) live.set(descriptor.id, descriptor);
  for (const descriptor of input.card.capabilities) live.set(descriptor.id, descriptor);
  for (const descriptor of input.disclosed) live.set(descriptor.id, descriptor);
  let effectCeiling = input.card.effectCeiling;
  for (const descriptor of input.disclosed) {
    if (planningEffectRank(descriptor.effect) > planningEffectRank(effectCeiling)) {
      effectCeiling = descriptor.effect;
    }
  }
  const preferred = new Set([
    ...input.card.capabilities.map((descriptor) => descriptor.id),
    ...input.disclosed.map((descriptor) => descriptor.id),
  ]);
  const covered = rankedLivePlanningDescriptors({
    objective: input.objective,
    live: [...live.values()],
    advisory: input.card.capabilities,
    preferredLiveIds: preferred,
    effectCeiling,
  });
  return {
    capabilities: covered.capabilities,
    withheld: covered.withheld,
    effectCeiling: covered.effectCeiling,
    digest: sha256(JSON.stringify(covered.capabilities)),
  };
}

/** Zero-model catalog preparation for the initial foreground model surface.
 * This is enumeration/ranking only. The exact bounded display card is frozen
 * here before the first model request; later foreground tool_search results
 * extend it only through this source's own disclosures (the same repack rule
 * the in-process lane applies) and never rewrite the frozen initial rows. */
export async function primePrimaryModelPlanningCatalog(input: {
  sessionId: string;
  sourceUserSeq: number;
}): Promise<{ ok: true; planning: HostFreshPlanningContextV1 } | { ok: false; reason: string }> {
  const accepted = listEvents(input.sessionId, {
    sinceSeq: input.sourceUserSeq - 1,
    types: ['user_input_received'],
    limit: 1,
  }).find((event) => event.seq === input.sourceUserSeq);
  const display = typeof accepted?.data.displayText === 'string' ? accepted.data.displayText.trim() : '';
  const eventText = typeof accepted?.data.text === 'string' ? accepted.data.text.trim() : '';
  const sourceText = display || eventText;
  if (!sourceText || !accepted) return { ok: false, reason: 'durable accepted source is missing' };
  let durableContinuation: TaskContinuationContext | null;
  try {
    const consumed = readConsumedTaskContinuityPacket({
      sessionId: input.sessionId,
      consumingSourceUserSeq: input.sourceUserSeq,
    });
    durableContinuation = rehydrateConsumedClarificationContext({
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      answer: sourceText,
    });
    if (
      (consumed.status === 'consumed' && !durableContinuation)
      || (consumed.status !== 'consumed' && consumed.status !== 'none')
    ) {
      return { ok: false, reason: 'durable accepted-source continuation is malformed or ambiguous' };
    }
    if (!durableContinuation) {
      const pending = peekTaskContinuityPacket({ sessionId: input.sessionId });
      if (pending.status !== 'none') {
        return { ok: false, reason: 'durable accepted-source continuation is unresolved' };
      }
    }
  } catch {
    return { ok: false, reason: 'durable accepted-source continuation is unreadable' };
  }
  const objective = graphSemanticText(
    sourceText,
    {
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      turn: accepted.turn,
    },
    durableContinuation ?? undefined,
    accepted,
  );
  const durableInitialCard = readPrimaryModelPlanningCardSnapshot({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
  });
  if (durableInitialCard.status === 'conflict' || durableInitialCard.status === 'storage_error') {
    return {
      ok: false,
      reason: `durable initial planning card is unavailable: ${durableInitialCard.reason}`,
    };
  }
  const frozenSource = persistedCatalogSnapshotManifestIdsForSource(input);
  const withholdLegacyEvidencePolicy = durableInitialCard.status === 'missing'
    && !frozenSource.ok && frozenSource.reason === 'missing_snapshot';
  let indexedDescriptors: HostCapabilityDescriptorV1[] = [];
  let indexedRegisteredIds = new Set<string>();
  let indexedLocalDefinitions: AuthorizedLocalPlanningDefinitionV1[] = [];
  const catalogManifestScope = currentAcceptedSourceCatalogManifestScope();
  try {
    const indexed = await registerIndexedCapabilitiesForTurn({
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      objective,
    });
    indexedDescriptors = indexed.descriptors;
    indexedRegisteredIds = new Set(indexed.registered);
    indexedLocalDefinitions = indexed.localDefinitions;
  } catch {
    indexedDescriptors = hostDescriptorsFromCapabilityIndex(objective);
    indexedLocalDefinitions = [];
  }
  // The index supplies HISTORICAL local definitions. Priming may only offer an
  // operation whose CURRENT configured shape still matches, so reobserve every
  // one here and carry the reobservation — not the indexed bytes — forward to
  // both the card and the durable publication below. A definition whose
  // ref/schema/effect/account has moved is dropped rather than offered; that is
  // the changed-schema/effect/principal negative case, and it keeps stale index
  // bytes from ever becoming execution permission.
  indexedLocalDefinitions = (await Promise.all(
    indexedLocalDefinitions.map(async (definition) => {
      const revalidated = await revalidateLocalPlanningDefinition(definition);
      return revalidated.ok && revalidated.definition.capabilityRef === definition.capabilityRef
        ? revalidated.definition
        : null;
    }),
  )).flatMap((definition) => (definition ? [definition] : []));

  // THIS SESSION's own successful native writes are the most relevant memory
  // there is, and they were not consulted at all. Nomination came only from the
  // global index, whose learned writes are dominated by whatever the home has
  // done most often. Live C16: a turn created a Space via `space_save`, and the
  // very next turn's card offered workflow_create/update/edit_step — the wrong
  // family entirely — so the edit planned, searched, and died with
  // `no observed operation is bound to this expected requirement`.
  //
  // Seed from the operations this session already used successfully, so the
  // artifact the user is plainly still working on is represented. Each is
  // reobserved against the current registry below like every other seed; this
  // only decides what gets OFFERED, never what is authorized.
  try {
    const priorNames = new Set<string>();
    for (const event of listEvents(input.sessionId, { types: ['capability_discovered'] })) {
      if (typeof event.data.sourceUserSeq !== 'number') continue;
      if (event.data.sourceUserSeq >= input.sourceUserSeq) continue;
      for (const row of Array.isArray(event.data.capabilities) ? event.data.capabilities : []) {
        if (!row || typeof row !== 'object') continue;
        const entry = row as { providerKind?: unknown; identifier?: unknown };
        if (entry.providerKind !== AUTHORIZED_LOCAL_REGISTRY_PROVENANCE) continue;
        if (typeof entry.identifier === 'string') priorNames.add(entry.identifier);
      }
    }
    const known = new Set(indexedLocalDefinitions.map((definition) => definition.name));
    for (const name of priorNames) {
      if (known.has(name)) continue;
      const observed = await observeCurrentLocalPlanningDefinition({ name, carrier: 'work_call' });
      if (!observed.ok) continue;
      if (indexedLocalDefinitions.some((d) => d.capabilityRef === observed.definition.capabilityRef)) continue;
      indexedLocalDefinitions.push(observed.definition);
    }
  } catch {
    // Additive only: session history that cannot be read leaves nomination as-is.
  }

  // A remembered operation is a CANDIDATE HINT for this turn, not the answer.
  // Priming used to publish only what was remembered, so a warm turn asking to
  // edit an existing artifact saw a card offering `workflow_create` alone. The
  // model planned with it, the typed destination contract correctly refused the
  // contradiction, and only then did a search find `workflow_update` — a wasted
  // plan and search on an ordinary edit (live C14 source 136255).
  //
  // Surface the remembered operation's siblings in the same AUTHORING family so
  // the first selection can be right. The family is `deliverableKind` + the
  // host's own `purpose` slug, which is the accurate axis: `author_workflow`
  // covers create/update/edit_step, while `dispatch_named_workflow` (run) and
  // `delete_workflow` are different jobs and stay out on their own terms.
  //
  // An earlier revision keyed on "postures this seed does not already cover".
  // That proxy failed the reviewer's seed matrix in both directions: a
  // create+edit_step seed omitted `workflow_update` because both postures looked
  // covered, and an update-only seed nominated `workflow_run` because create_new
  // looked uncovered — surfacing an operation that DISPATCHES work for a request
  // that only wanted an edit. Purpose is the honest relation; posture is not.
  // Reversible and non-destructive still gate everything, which is the
  // independent reason `workflow_delete` can never appear.
  if (indexedLocalDefinitions.length > 0) {
    const primedRefs = new Set(indexedLocalDefinitions.map((definition) => definition.capabilityRef));
    const families = new Set(indexedLocalDefinitions.flatMap((definition) => {
      const kind = definition.descriptor.deliverableKind;
      const purpose = definition.descriptor.purpose;
      return kind && purpose ? [`${kind}::${purpose}`] : [];
    }));
    const siblingNames = new Set<string>();
    for (const entry of TOOL_REGISTRY) {
      const planning = entry.localPlanning;
      if (!planning) continue;
      if (planning.reversibility !== 'reversible' || planning.destructive) continue;
      if (!families.has(`${planning.deliverableKind}::${planning.purpose}`)) continue;
      siblingNames.add(entry.name);
    }
    for (const name of siblingNames) {
      try {
        const observed = await observeCurrentLocalPlanningDefinition({ name, carrier: 'work_call' });
        if (!observed.ok || primedRefs.has(observed.definition.capabilityRef)) continue;
        primedRefs.add(observed.definition.capabilityRef);
        indexedLocalDefinitions.push(observed.definition);
      } catch {
        // Additive only: a sibling that cannot be observed is simply not offered.
      }
    }
  }

  const catalogEntries = (peekHostCapabilityCatalogFactory()?.snapshot() ?? []).filter((entry) => (
    !catalogManifestScope
    || (entry.providerKind ?? entry.manifest?.providerKind) !== 'composio'
    || catalogManifestScope.manifestIds.has(entry.manifest?.manifestId ?? entry.capabilityId)
    || catalogManifestScope.operationIds.has(
      (entry.manifest?.operationId ?? entry.toolName).toUpperCase(),
    )
  )).filter((entry) => {
    if (!withholdLegacyEvidencePolicy || !isLegacyGenericProviderWriteEvidencePolicy(entry.manifest)) return true;
    // A fresh card must not advertise the retired receipt/readback default.
    // Exact discovery performs the normal account/definition checks and can
    // publish its successor; this filter cannot mutate shared/frozen entries.
    return false;
  });
  const catalogDescriptors = catalogEntries.flatMap((entry) => {
    const descriptor = hostDescriptorFromRegistered(entry);
    if (!descriptor) return [];
    const providerKind = entry.providerKind ?? entry.manifest?.providerKind ?? 'host';
    // An incomplete Composio row can never survive selected-definition
    // revalidation. Keeping it off the planning card prevents plan_task from
    // being surfaced for authority that is guaranteed to fail at freeze.
    if (
      providerKind.toLowerCase() === 'composio'
      && !stagedProviderDefinitionFromRegistered(entry)
    ) return [];
    return [descriptor];
  });
  const livePlanningById = new Map(
    catalogDescriptors.map((descriptor) => [descriptor.id, descriptor]),
  );
  for (const definition of indexedLocalDefinitions) {
    livePlanningById.set(definition.capabilityRef, definition.descriptor);
  }
  const livePlanningDescriptors = [...livePlanningById.values()];
  const learnedCurrentIds = new Set([
    ...indexedRegisteredIds,
    ...indexedLocalDefinitions.map((definition) => definition.capabilityRef),
  ]);
  // Proof/index facts themselves remain advisory. A canonical prior read or
  // write may have caused registerIndexedCapabilitiesForTurn to reconstruct a
  // current manifest-backed catalog row or reobserve a current safe local
  // definition above; only that current row—not historical proof/index bytes—
  // can enter the citable set here.
  const proofDescriptors = hostDescriptorsFromResolutionProof(input.sessionId, input.sourceUserSeq);
  const disclosureByName = new Map<string, PrimaryModelPlanningDisclosureV1>();
  for (const entry of catalogEntries) {
    const descriptor = hostDescriptorFromRegistered(entry);
    if (!descriptor) continue;
    const identifier = entry.manifest?.operationId?.trim() || entry.toolName.trim();
    const providerKind = entry.providerKind ?? entry.manifest?.providerKind ?? 'host';
    const providerDefinition = stagedProviderDefinitionFromRegistered(entry);
    if (providerKind.toLowerCase() === 'composio' && !providerDefinition) continue;
    const disclosure = {
      descriptor,
      identifier,
      providerKind,
      providerDefinition,
    };
    for (const name of [identifier, entry.toolName, descriptor.id]) {
      if (name.trim()) disclosureByName.set(name.trim().toLowerCase(), disclosure);
    }
  }
  const ranked = rankedLivePlanningDescriptors({
    objective,
    live: livePlanningDescriptors,
    // A successor manifest may have a versioned id while its index row keeps
    // the stable base id. Include the exact live rows rehydrated above in the
    // advisory ordering so supply cannot be pushed off the bounded card merely
    // because the provider definition advanced.
    advisory: [
      ...livePlanningDescriptors.filter((descriptor) => learnedCurrentIds.has(descriptor.id)),
      ...proofDescriptors,
      ...indexedDescriptors,
    ],
    preferredLiveIds: learnedCurrentIds,
    effectCeiling: planningEffectCeilingForAcceptedRequest(objective),
  });
  const replayed = await durablePlanningDisclosures({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    byName: disclosureByName,
  });
  // Staging alone is not enough to make a primed operation CALLABLE. The direct
  // work_call path resolves execution authority from this source's durable
  // `capability_discovered` row (readDurableAuthorizedLocalPlanningDefinition in
  // local-planning-capability.ts), never from this in-memory map — while the
  // Plan path revalidates `staged.localDefinition` and so worked either way.
  // Priming therefore advertised a native operation on the warm card that the
  // model could not actually call, and the turn fell back to plan_task; that
  // plan then cannot open a graph resolution over the chat turn's already-armed
  // non-graph host authority, so an ordinary reversible edit dead-ended. Live
  // C12 source 135730 blocked exactly this way ("graph resolution cannot replace
  // non-graph call authority") while the same edit succeeded cold at 135997.
  //
  // Publish the reobserved definition so an ordinary Normal-mode edit needs no
  // same-source discovery step and no plan. A ref that already has a durable row
  // for this source is not republished, preserving duplicate prevention.
  const primedLocalAuthority: Array<{
    kind: string;
    identifier: string;
    effectClass: 'read' | 'write';
    schemaFingerprint: string;
    capabilityRef: string;
    manifestDigest: string;
    accountIdentity?: string;
    providerKind: string;
    descriptor: HostCapabilityDescriptorV1;
    localAuthority: AuthorizedLocalPlanningDefinitionV1;
  }> = [];
  for (const definition of indexedLocalDefinitions) {
    const alreadyDurable = replayed.stagedById.has(definition.capabilityRef);
    replayed.stagedById.set(definition.capabilityRef, {
      descriptor: definition.descriptor,
      identifier: definition.name,
      providerKind: AUTHORIZED_LOCAL_REGISTRY_PROVENANCE,
      accountIdentity: definition.accountIdentity,
      localDefinition: definition,
    });
    if (alreadyDurable) continue;
    primedLocalAuthority.push({
      kind: AUTHORIZED_LOCAL_REGISTRY_PROVENANCE,
      identifier: definition.name,
      effectClass: definition.descriptor.effect === 'read' ? 'read' : 'write',
      schemaFingerprint: definition.schemaFingerprint,
      capabilityRef: definition.capabilityRef,
      manifestDigest: definition.descriptor.manifestDigest,
      accountIdentity: definition.accountIdentity,
      providerKind: AUTHORIZED_LOCAL_REGISTRY_PROVENANCE,
      descriptor: definition.descriptor,
      localAuthority: definition,
    });
  }
  if (primedLocalAuthority.length > 0) {
    appendEvent({
      sessionId: input.sessionId,
      turn: accepted.turn,
      role: 'system',
      type: 'capability_discovered',
      data: { sourceUserSeq: input.sourceUserSeq, capabilities: primedLocalAuthority },
    });
  }
  const allowedById = new Map<string, HostCapabilityDescriptorV1>();
  for (const descriptor of [...ranked.capabilities, ...replayed.descriptors]) {
    allowedById.set(descriptor.id, descriptor);
  }
  const covered = rankedLivePlanningDescriptors({
    objective,
    live: [...allowedById.values()],
    advisory: ranked.capabilities,
    // Durable disclosures already survived the exact current provider,
    // account, manifest, schema, and effect checks above. Prefer those
    // source-bound rows during the final bounded repack so an unrelated full
    // initial card cannot erase compatible procedural memory. The original
    // card remains advisory and every slot/byte/ceiling bound still applies.
    preferredLiveIds: new Set(replayed.descriptors.map((descriptor) => descriptor.id)),
    effectCeiling: ranked.effectCeiling,
  });
  const proposedCapabilities = covered.capabilities.map((descriptor) => Object.freeze({ ...descriptor }));
  const installedInitialCard = durableInitialCard.status === 'ready'
    ? durableInitialCard
    : recordPrimaryModelPlanningCardSnapshotOnce({
        sessionId: input.sessionId,
        sourceUserSeq: input.sourceUserSeq,
        snapshotJson: initialPlanningCardSnapshotJson({
          objective,
          effectCeiling: covered.effectCeiling,
          capabilities: proposedCapabilities,
          withheld: covered.withheld,
        }),
      });
  if (installedInitialCard.status !== 'ready') {
    return {
      ok: false,
      reason: installedInitialCard.status === 'missing'
        ? 'durable initial planning card disappeared during installation'
        : `durable initial planning card is unavailable: ${installedInitialCard.reason}`,
    };
  }
  // The card just installed (or reopened) may cite this source's own durable
  // disclosures: a staged row is never a live factory row until plan_task
  // publishes it, yet it is current — durable replay rebuilt it from the exact
  // current provider, account, manifest, schema, effect, and proof evidence
  // above. Comparing the card against live rows alone would refuse the very
  // identity the replay just rebuilt (a restart whose only card rows are
  // legacy disclosures). Live rows keep precedence so a real live drift on a
  // shared id still fails typed.
  const currentPlanningById = new Map(livePlanningById);
  for (const descriptor of replayed.descriptors) {
    if (!currentPlanningById.has(descriptor.id)) currentPlanningById.set(descriptor.id, descriptor);
  }
  const reopenedInitialCard = parseDurableInitialPlanningCard({
    snapshot: installedInitialCard,
    objective,
    currentById: currentPlanningById,
  });
  if (!reopenedInitialCard.ok) return reopenedInitialCard;
  // New LIVE factory rows never repack the frozen initial card. This source's
  // own durable tool_search disclosures are the one lawful extension: the
  // in-process lane already grew the card the model saw, so a re-prime (a
  // resumed source in another process) must reach that same card instead of
  // reopening the pre-disclosure surface and hiding every disclosed ref.
  const frozenIds = new Set(reopenedInitialCard.card.capabilities.map((descriptor) => descriptor.id));
  const card = replayed.descriptors.some((descriptor) => !frozenIds.has(descriptor.id))
    ? repackPlanningCardWithSameSourceDisclosures({
        objective,
        card: reopenedInitialCard.card,
        liveCapabilities: catalogDescriptors,
        disclosed: replayed.descriptors,
      })
    : {
        capabilities: [...reopenedInitialCard.card.capabilities],
        withheld: [...reopenedInitialCard.card.withheld],
        effectCeiling: reopenedInitialCard.card.effectCeiling,
        digest: reopenedInitialCard.card.cardDigest,
      };
  const authority = Object.freeze({ scope: PRIMARY_MODEL_PLANNING_CATALOG_SCOPE });
  primaryModelPlanningCatalogs.set(authority, {
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    objective,
    effectCeiling: card.effectCeiling,
    withheld: card.withheld,
    capabilities: card.capabilities,
    liveCapabilities: catalogDescriptors.map((descriptor) => Object.freeze({ ...descriptor })),
    disclosureByName,
    stagedById: replayed.stagedById,
    digest: card.digest,
  });
  const planning = snapshotPrimaryModelPlanningContext(authority);
  if (!planning) return { ok: false, reason: 'host planning catalog snapshot was not installed' };
  return {
    ok: true,
    planning,
  };
}

/** Monotonically disclose exact operations from foreground tool_search or
 * host preparation of a configured native call. Existing live entries remain executable;
 * novel provider entries are staged and cannot cross a business boundary
 * until plan_task publishes and revalidates the selected subset. */
export async function disclosePrimaryModelPlanningCapabilities(input: {
  authority: PrimaryModelPlanningCatalogAuthorityV1;
  signal?: AbortSignal;
  deadlineAt?: number;
  candidates: readonly {
    name: string;
    carrier: 'call_tool' | 'work_call';
    schema?: unknown;
    sourceKind:
      | 'authorized_external_mcp'
      | 'authorized_composio'
      | typeof AUTHORIZED_LIVE_READ_REGISTRY_PROVENANCE
      | typeof AUTHORIZED_LOCAL_REGISTRY_PROVENANCE;
    planningAuthority?: AuthorizedLiveReadPlanningAuthorityV1;
  }[];
}): Promise<Readonly<Record<string, string>>> {
  const active = (): boolean => !input.signal?.aborted
    && (input.deadlineAt === undefined || Date.now() < input.deadlineAt);
  if (!active()) return Object.freeze({});
  const catalog = primaryModelPlanningCatalogs.get(input.authority as object);
  if (!catalog || input.authority.scope !== PRIMARY_MODEL_PLANNING_CATALOG_SCOPE) return Object.freeze({});
  if (getTurnGraphEventForSource(catalog.sessionId, catalog.sourceUserSeq)) return Object.freeze({});
  const refs: Record<string, string> = {};
  const newlyDisclosed: Array<{
    kind: string;
    identifier: string;
    effectClass: 'read' | 'write' | 'unknown';
    capabilityRef: string;
    manifestDigest: string;
    accountIdentity?: string;
    providerKind?: string;
    descriptor?: HostCapabilityDescriptorV1;
    localAuthority?: AuthorizedLocalPlanningDefinitionV1;
    schemaFingerprint?: string;
    providerDefinition?: StagedProviderDefinitionV1;
  }> = [];
  const allowed = new Map(catalog.capabilities.map((descriptor) => [descriptor.id, descriptor]));
  // Planning-card membership and execution-authority publication are DIFFERENT
  // concerns; `allowed` above is seeded from capabilities an EARLIER turn already
  // disclosed. This set keeps the authority record emitted exactly once per ref
  // per turn without letting card dedup suppress it entirely.
  const publishedLocalAuthorityRefs = new Set<string>();
  const proofById = new Map(
    hostDescriptorsFromResolutionProof(catalog.sessionId, catalog.sourceUserSeq)
      .map((descriptor) => [descriptor.id, descriptor]),
  );
  const proofEntries = provenCapabilityEntriesForTurn({
    sessionId: catalog.sessionId,
    sourceUserSeq: catalog.sourceUserSeq,
  });
  for (const candidate of input.candidates.slice(0, 20)) {
    if (!active()) return Object.freeze({});
    const name = candidate.name.trim();
    if (!name) continue;
    if (candidate.sourceKind === AUTHORIZED_LOCAL_REGISTRY_PROVENANCE) {
      const issued = inspectAuthorizedLocalPlanningDisclosureCandidates(candidate as object);
      if (
        !issued?.length
        || issued.some((definition) => definition.name !== name)
        || issued.some((definition) => definition.carrier !== candidate.carrier)
        || !candidate.schema
        || typeof candidate.schema !== 'object'
        || Array.isArray(candidate.schema)
        || issued.some((definition) => digestSchema(candidate.schema) !== definition.schemaFingerprint)
      ) continue;
      const revalidated = await Promise.all(issued.map(revalidateLocalPlanningDefinition));
      if (!active()) return Object.freeze({});
      if (revalidated.some((result) => !result.ok)) continue;
      const current = revalidated.map((result) => {
        if (!result.ok) throw new Error('unreachable local variant revalidation state');
        return result.definition;
      });
      if (new Set(current.map((definition) => definition.capabilityRef)).size !== current.length) continue;
      const incompatiblePrior = current.some((definition) => {
        const prior = catalog.stagedById.get(definition.capabilityRef);
        return Boolean(prior && (
          prior.providerKind !== AUTHORIZED_LOCAL_REGISTRY_PROVENANCE
          || prior.identifier !== definition.name
          || prior.accountIdentity !== definition.accountIdentity
          || prior.localDefinition?.envelopeFingerprint !== definition.envelopeFingerprint
          || prior.providerDefinition !== undefined
          || JSON.stringify(prior.descriptor) !== JSON.stringify(definition.descriptor)
        ));
      });
      if (incompatiblePrior) continue;
      refs[name] = current[0]!.capabilityRef;
      for (const definition of current) {
        const prior = catalog.stagedById.get(definition.capabilityRef);
        const staged: StagedPrimaryModelPlanningCapabilityV1 = prior ?? {
          descriptor: definition.descriptor,
          identifier: definition.name,
          providerKind: AUTHORIZED_LOCAL_REGISTRY_PROVENANCE,
          accountIdentity: definition.accountIdentity,
          localDefinition: definition,
        };
        catalog.stagedById.set(definition.capabilityRef, staged);
        // A capability the card already lists still needs THIS source's durable
        // localAuthority published: consent preparation and sealing read that
        // record, and without it an ordinary native write cannot be offered, so
        // the host falls back to a planning detour. Skipping publication because
        // the descriptor was already on the card is what broke native writes
        // once a tool had been learned — C11 workflow edit 135472 and Space
        // create 135561 both took this branch and landed nothing, while the cold
        // create 135386 published and succeeded.
        //
        // `definition` is this pass's current reobservation, so this persists the
        // CURRENT schema/effect/source/account rather than reusing an earlier
        // turn's execution permission. Ownership and duplicate checks downstream
        // are unchanged; only the publication suppression is removed.
        if (!allowed.has(definition.capabilityRef)) {
          allowed.set(definition.capabilityRef, definition.descriptor);
        }
        if (publishedLocalAuthorityRefs.has(definition.capabilityRef)) continue;
        publishedLocalAuthorityRefs.add(definition.capabilityRef);
        newlyDisclosed.push({
          kind: AUTHORIZED_LOCAL_REGISTRY_PROVENANCE,
          identifier: definition.name,
          effectClass: definition.descriptor.effect === 'read' ? 'read' : 'write',
          schemaFingerprint: definition.schemaFingerprint,
          capabilityRef: definition.capabilityRef,
          manifestDigest: definition.descriptor.manifestDigest,
          accountIdentity: definition.accountIdentity,
          providerKind: AUTHORIZED_LOCAL_REGISTRY_PROVENANCE,
          descriptor: definition.descriptor,
          localAuthority: definition,
        });
      }
      continue;
    }
    if (candidate.sourceKind === AUTHORIZED_LIVE_READ_REGISTRY_PROVENANCE) {
      const reopened = inspectAuthorizedLiveReadPlanningAuthority({
        authority: candidate.planningAuthority,
        identity: {
          sessionId: catalog.sessionId,
          sourceUserSeq: catalog.sourceUserSeq,
        },
        name,
        carrier: candidate.carrier,
        schema: candidate.schema,
      });
      if (!reopened) continue;
      const descriptor = hostDescriptorFromRegistered(reopened.entry);
      const providerDefinition = stagedProviderDefinitionFromRegistered(reopened.entry);
      if (
        !descriptor
        || !liveRegistryDescriptorPassesRehydrate(descriptor.effect, catalog.effectCeiling)
        || !providerDefinition
        || providerDefinition.providerInputSchemaDigest
          !== reopened.definition.providerInputSchemaDigest
        || providerDefinition.definitionFingerprint
          !== reopened.definition.definitionFingerprint
        || providerDefinition.providerOperationVersion
          !== reopened.definition.providerOperationVersion
        || providerDefinition.providerOutputSchemaDigest
          !== reopened.definition.providerOutputSchemaDigest
        || providerDefinition.invokePortId !== reopened.definition.invokePortId
      ) continue;
      const staged: StagedPrimaryModelPlanningCapabilityV1 = {
        descriptor: Object.freeze({ ...descriptor }),
        identifier: reopened.manifest.operationId,
        providerKind: reopened.manifest.providerKind,
        accountIdentity: reopened.manifest.accountId,
        providerDefinition,
      };
      const prior = catalog.stagedById.get(descriptor.id);
      if (prior && (
        prior.identifier !== staged.identifier
        || prior.providerKind !== staged.providerKind
        || prior.accountIdentity !== staged.accountIdentity
        || !stagedProviderDefinitionsEqual(prior.providerDefinition, staged.providerDefinition)
        || JSON.stringify(prior.descriptor) !== JSON.stringify(staged.descriptor)
      )) continue;
      catalog.stagedById.set(descriptor.id, prior ?? staged);
      refs[name] = descriptor.id;
      if (allowed.has(descriptor.id)) continue;
      allowed.set(descriptor.id, descriptor);
      newlyDisclosed.push({
        kind: AUTHORIZED_LIVE_READ_REGISTRY_PROVENANCE,
        identifier: staged.identifier,
        effectClass: 'read',
        capabilityRef: descriptor.id,
        manifestDigest: descriptor.manifestDigest,
        accountIdentity: staged.accountIdentity,
        providerKind: staged.providerKind,
        descriptor,
        providerDefinition,
      });
      continue;
    }
    const exact = catalog.disclosureByName.get(name.toLowerCase());
    if (exact) {
      const sourceOwnsExact = (
        candidate.sourceKind === 'authorized_composio'
        && exact.providerKind.toLowerCase() === 'composio'
      ) || (
        candidate.sourceKind === 'authorized_external_mcp'
        && exact.providerKind.toLowerCase() === 'native_mcp'
      );
      if (!sourceOwnsExact) continue;
      refs[name] = exact.descriptor.id;
      if (allowed.has(exact.descriptor.id)) continue;
      allowed.set(exact.descriptor.id, exact.descriptor);
      newlyDisclosed.push({
        kind: exact.providerKind,
        identifier: exact.identifier,
        effectClass: exact.descriptor.effect === 'read'
          ? 'read'
          : exact.descriptor.effect === 'external_write' || exact.descriptor.effect === 'local_write'
            ? 'write'
            : 'unknown',
        capabilityRef: exact.descriptor.id,
        manifestDigest: exact.descriptor.manifestDigest,
        accountIdentity: exact.descriptor.accountScope,
        providerKind: exact.providerKind,
        ...(exact.providerDefinition
          ? { providerDefinition: exact.providerDefinition }
          : {}),
      });
      continue;
    }
    if (
      candidate.sourceKind === 'authorized_external_mcp'
      && candidate.carrier === 'work_call'
      && candidate.schema
      && typeof candidate.schema === 'object'
      && !Array.isArray(candidate.schema)
    ) {
      const parsed = parseNamespacedTool(name);
      if (!parsed) continue;
      const materialized = await createProductionMcpReadCarrier({
        serverName: parsed.serverSlug,
      }).materializeExact({
        operationId: name,
        inputSchema: candidate.schema,
      });
      if (!active()) return Object.freeze({});
      if (materialized.status !== 'installed') continue;
      const entry = peekHostCapabilityCatalogFactory()?.get(materialized.manifest.manifestId);
      const descriptor = entry ? hostDescriptorFromRegistered(entry) : null;
      const providerDefinition = entry ? stagedProviderDefinitionFromRegistered(entry) : null;
      if (!entry || !descriptor || !providerDefinition) continue;
      const prior = catalog.stagedById.get(descriptor.id);
      const staged: StagedPrimaryModelPlanningCapabilityV1 = {
        descriptor: Object.freeze({ ...descriptor }),
        identifier: materialized.manifest.operationId,
        providerKind: 'native_mcp',
        accountIdentity: materialized.manifest.accountId,
        providerDefinition,
      };
      if (prior && (
        prior.identifier !== staged.identifier
        || prior.providerKind !== staged.providerKind
        || prior.accountIdentity !== staged.accountIdentity
        || !stagedProviderDefinitionsEqual(prior.providerDefinition, staged.providerDefinition)
        || JSON.stringify(prior.descriptor) !== JSON.stringify(staged.descriptor)
      )) continue;
      catalog.stagedById.set(descriptor.id, prior ?? staged);
      refs[name] = descriptor.id;
      if (allowed.has(descriptor.id)) continue;
      allowed.set(descriptor.id, descriptor);
      newlyDisclosed.push({
        kind: 'native_mcp',
        identifier: materialized.manifest.operationId,
        effectClass: descriptor.effect === 'read' ? 'read' : 'write',
        capabilityRef: descriptor.id,
        manifestDigest: descriptor.manifestDigest,
        accountIdentity: materialized.manifest.accountId,
        providerKind: 'native_mcp',
        descriptor,
        providerDefinition,
      });
      continue;
    }
    // Candidate prose, MCP metadata, memory, and provider-wide fuzzy hits do
    // not mint execution refs. The Composio adapter deposited an exact current
    // connection + schema proof for these returned bytes immediately before
    // this opaque callback; every other candidate source remains typed
    // unsupported until it implements the same materialize→disclose contract.
    if (
      candidate.sourceKind !== 'authorized_composio'
      || candidate.carrier !== 'work_call'
      || !candidate.schema
      || typeof candidate.schema !== 'object'
      || Array.isArray(candidate.schema)
    ) continue;
    // The proof is resolved BEFORE the ref so the account is known: the
    // canonical id is account-scoped, and naming it from the slug alone is
    // what handed the model an id the catalog had already superseded.
    const proof = proofEntries.find((entry) => (
      entry.kind === 'composio'
      && entry.status === 'proven'
      && entry.connection !== 'missing'
      && entry.identifier.trim().toLowerCase() === name.toLowerCase()
      && (entry.effectClass === 'read' || entry.effectClass === 'write')
    ));
    const capabilityRef = canonicalResolvedCapabilityId(
      name.toLowerCase(),
      proof?.accountIdentity?.trim() || null,
      'composio',
    );
    const proofDescriptor = proofById.get(capabilityRef);
    if (!proofDescriptor || !proof) continue;
    const providerInputSchemaDigest = digestSchema(candidate.schema);
    const accountIdentity = proof.accountIdentity?.trim() || 'runtime';
    if (proofDescriptor.accountScope !== accountIdentity) continue;
    const providerDefinition = currentComposioProviderDefinition({
      identifier: name,
      schema: candidate.schema as Record<string, unknown>,
      accountIdentity,
    });
    if (
      !providerDefinition
      || providerDefinition.providerInputSchemaDigest !== providerInputSchemaDigest
    ) continue;
    // Discovery may just have published a current manifest after this card
    // was primed. Its exact checked contract outranks the advisory proof's
    // generic shape; otherwise an acknowledgement-only write regains an
    // invented readback requirement at the disclosure boundary.
    const publishedEntry = peekHostCapabilityCatalogFactory()?.get(capabilityRef);
    const publishedDescriptor = publishedEntry ? hostDescriptorFromRegistered(publishedEntry) : null;
    const publishedDefinition = publishedEntry ? stagedProviderDefinitionFromRegistered(publishedEntry) : null;
    const descriptor = publishedDescriptor
      && publishedEntry?.manifest?.providerKind === 'composio'
      && publishedEntry.manifest.operationId.toLowerCase() === name.toLowerCase()
      && publishedEntry.manifest.accountId === accountIdentity
      && publishedDescriptor.accountScope === accountIdentity
      && publishedDescriptor.effect === proofDescriptor.effect
      && stagedProviderDefinitionsEqual(publishedDefinition, providerDefinition)
      ? publishedDescriptor
      : proofDescriptor;
    const prior = catalog.stagedById.get(capabilityRef);
    if (prior && (
      prior.identifier.toLowerCase() !== name.toLowerCase()
      || prior.accountIdentity !== accountIdentity
      || !stagedProviderDefinitionsEqual(prior.providerDefinition, providerDefinition)
      || JSON.stringify(prior.descriptor) !== JSON.stringify(descriptor)
    )) continue;
    const staged: StagedPrimaryModelPlanningCapabilityV1 = prior ?? {
      descriptor: Object.freeze({ ...descriptor }),
      identifier: name,
      providerKind: 'composio',
      accountIdentity,
      providerDefinition,
    };
    catalog.stagedById.set(capabilityRef, staged);
    refs[name] = capabilityRef;
    if (allowed.has(capabilityRef)) continue;
    allowed.set(capabilityRef, staged.descriptor);
    newlyDisclosed.push({
      kind: 'composio',
      identifier: name,
      effectClass: descriptor.effect === 'read' ? 'read' : 'write',
      capabilityRef,
      manifestDigest: descriptor.manifestDigest,
      accountIdentity,
      providerKind: 'composio',
      descriptor: staged.descriptor,
      providerDefinition,
    });
  }
  if (newlyDisclosed.length > 0) {
    if (!active()) return Object.freeze({});
    const source = listEvents(catalog.sessionId, {
      sinceSeq: catalog.sourceUserSeq - 1,
      types: ['user_input_received'],
      limit: 1,
    }).find((event) => event.seq === catalog.sourceUserSeq);
    if (!source) return Object.freeze({});
    if (!active()) return Object.freeze({});
    appendEvent({
      sessionId: catalog.sessionId,
      turn: source.turn,
      role: 'system',
      type: 'capability_discovered',
      data: { sourceUserSeq: catalog.sourceUserSeq, capabilities: newlyDisclosed },
    });
    const repacked = repackPlanningCardWithSameSourceDisclosures({
      objective: catalog.objective,
      card: { capabilities: catalog.capabilities, effectCeiling: catalog.effectCeiling },
      liveCapabilities: catalog.liveCapabilities,
      disclosed: newlyDisclosed.flatMap((row) => (row.descriptor ? [row.descriptor] : [])),
    });
    catalog.effectCeiling = repacked.effectCeiling;
    catalog.withheld = repacked.withheld;
    catalog.capabilities = repacked.capabilities;
    catalog.digest = repacked.digest;
  }
  return Object.freeze({ ...refs });
}

export type PrepareDurableAcceptedTurnCompileResult =
  | {
      ok: true;
      source: Extract<ReturnType<typeof admitTurnSemantics>, { ok: true }>['source'];
      policyRevision: string;
      clamped: Extract<ReturnType<typeof admitTurnSemantics>, { ok: true }>['clamped'];
      payloadHash: string;
      contextHash: string;
      semanticProvenanceDigest: string;
      destinationBinding?: import('../harness/destination-binding.js').CanonicalDestinationBindingV1;
      authority: HostSemanticAuthorityV1;
      acceptedText: string;
      sessionKind: NonNullable<ReturnType<typeof getSession>>['kind'];
      policy: ReturnType<typeof snapshotTurnGraphPolicy>;
    }
  | { ok: false; reason: string };

function carryExactDestinationBinding(input: {
  clamped: AdmittedClampedSemanticsV1;
  binding: CanonicalDestinationBindingV1;
  /** One additional exactly-bound destination per FURTHER planned write.
   *
   * A plan that creates a thing and then writes into it names two operations.
   * Each gets its OWN binding, so nothing here authorizes an operation the plan
   * did not already admit. Live 2026-08-26: a two-write plan could only ever
   * execute its first write, because one binding named one operationId and both
   * consent and the catalog factory then refused every other planned write —
   * including the write into the very destination this turn had just created. */
  additional?: readonly {
    binding: CanonicalDestinationBindingV1;
    family: string;
  }[];
}): { ok: true; clamped: AdmittedClampedSemanticsV1 } | { ok: false; reason: string } {
  const destination = input.clamped.destination;
  const destinations = input.clamped.destinations;
  if (!destination) {
    return { ok: false, reason: 'destination binding has no admitted destination' };
  }
  if (destination.posture !== input.binding.posture) {
    return { ok: false, reason: 'destination binding posture does not match admitted destination' };
  }
  if (destinations && destinations.length !== 1) {
    return { ok: false, reason: 'one destination binding cannot authorize multiple admitted destinations' };
  }
  const canonical = destinations?.[0] ?? destination;
  if (
    canonical.posture !== destination.posture
    || canonical.family !== destination.family
    || canonical.handleRequired !== destination.handleRequired
  ) {
    return { ok: false, reason: 'admitted destination projections disagree before binding' };
  }
  const existing = canonical.binding ?? destination.binding;
  if (existing && JSON.stringify(existing) !== JSON.stringify(input.binding)) {
    return { ok: false, reason: 'admitted destination already carries a conflicting binding' };
  }
  const boundDestination = { ...canonical, binding: { ...input.binding } };
  // Each further planned write carries its OWN exact binding and its own
  // posture (a create is create_new; the write into what it created is
  // named_existing). The primary destination is untouched, so a single-write
  // turn freezes exactly what it froze before this existed.
  const seenOperations = new Set([input.binding.operationId]);
  const furtherWrites = (input.additional ?? [])
    .filter((entry) => {
      if (seenOperations.has(entry.binding.operationId)) return false;
      seenOperations.add(entry.binding.operationId);
      return true;
    })
    .map((entry) => ({
      posture: entry.binding.posture,
      family: entry.family,
      handleRequired: boundDestination.handleRequired,
      binding: { ...entry.binding },
    }));
  return {
    ok: true,
    clamped: {
      ...input.clamped,
      destinations: [{ ...boundDestination }, ...furtherWrites],
      destination: { ...boundDestination },
    },
  };
}

/** Internal half of the durable compiler seam. It deliberately returns no
 * executable envelope; only admitted data that the private sealer can mint. */
export async function prepareDurableAcceptedTurnCompile(
  input: CompileDurableAcceptedTurnGraphInput,
  primaryModelProposal?: TurnSemanticProposalV1,
  primaryModelCatalogAuthority?: PrimaryModelPlanningCatalogAuthorityV1,
): Promise<PrepareDurableAcceptedTurnCompileResult> {
  const accepted = listEvents(input.identity.sessionId, {
    sinceSeq: input.identity.sourceUserSeq - 1,
    types: ['user_input_received'],
    limit: 1,
  }).find((event) => event.seq === input.identity.sourceUserSeq);
  const durableDisplayText = typeof accepted?.data.displayText === 'string'
    ? accepted.data.displayText.trim()
    : '';
  const durableEventText = typeof accepted?.data.text === 'string'
    ? accepted.data.text.trim()
    : '';
  const durableText = durableDisplayText || durableEventText;
  if (!durableText) return { ok: false, reason: 'durable accepted source is missing' };
  if (accepted && accepted.turn !== input.identity.turn) {
    // OPEN-THE-GATES 5.6 / G17: compile against the source row's turn, never
    // the executing turn. Follow-ups arrive stamped with the open turn and
    // execute as N. Persist already rebinds; compile must match or the graph
    // hash refuses its own source.
    input = {
      ...input,
      identity: { ...input.identity, turn: accepted.turn },
    };
  }
  const verifiedContinuation = input.verifiedTaskContinuation && accepted
    ? verifyDurableClarificationContext({
        sessionId: input.identity.sessionId,
        sourceUserSeq: input.identity.sourceUserSeq,
        answer: durableText,
        context: input.verifiedTaskContinuation,
      })
    : undefined;
  if (input.verifiedTaskContinuation && !verifiedContinuation) {
    return { ok: false, reason: 'continuation_unverified' };
  }
  const acceptedSemanticText = graphSemanticText(
    durableText,
    input.identity,
    verifiedContinuation ?? undefined,
    accepted,
  );

  // Conversation is the same kernel with catalog/planner skipped — not a
  // second action loop. Only a high-confidence closed-world greeting skips
  // admission. Every other live source participates. A checker that cannot
  // admit a typed plan withholds typed authority; dispatch keeps tools.
  if (conversationShortCircuit(input.identity, acceptedSemanticText)) {
    recordSemanticParticipation(
      input.identity.sessionId,
      input.identity.sourceUserSeq,
      'unparticipated',
    );
    return { ok: false, reason: CONVERSATION_SHORT_CIRCUIT_REASON };
  }

  const session = getSession(input.identity.sessionId);
  if (!session) return { ok: false, reason: 'session is missing' };

  // OWNER DECISION 2026-08-25 ("option B"), finished: execution surfaces do
  // not enter the pre-model semantic ceremony — and must not PAY for it
  // either. The identical refusal below at the port check discarded this
  // stage's entire product for every non-chat session AFTER the capability
  // resolution had spent up to its full deadline (live: 27% of workflow
  // turns blew the 90s deadline in that race; the disclosed catalog was 97%
  // local-index regardless). Decline before the cost, not after. In-loop
  // typed planning arrives WITH a primary proposal and keeps full admission.
  if (!primaryModelProposal && session.kind !== 'chat') {
    recordSemanticDispositionOutcome(input.identity.sessionId, input.identity.sourceUserSeq, 'unavailable');
    return { ok: false, reason: 'semantic port is unavailable' };
  }

  // PARTICIPATION IS STAMPED WHERE A PORT ACTUALLY TAKES THE TURN, not here.
  // `recordSemanticParticipation` is a monotonic ratchet — it upgrades
  // unparticipated→participated and never downgrades — so stamping before the
  // port is known to exist made `semanticPortParticipated()` true even when NO
  // port ever ran. That rendered the legacy-shadow degradation in
  // admitAndCompileAcceptedSource unreachable for a missing port, and every
  // non-greeting turn FAILED instead of falling back (407 suite failures on
  // 'semantic port is unavailable'). An install whose semantic port fails to
  // configure must still answer, so the stamp moved below the port check.
  const policy = snapshotTurnGraphPolicy(getProactivityPolicySnapshot());
  const policyRevision = sha256(JSON.stringify(policy));
  const userId = (session.userId ?? '').trim() || `user:${session.id}`;
  const audienceKey = userId;
  const conversationKey = session.id;

  // Historical admission used to run a Composio-only connected-goal selector
  // here and stamp its schema/lexical guesses as `status=proven` before the
  // model had cited a capability. That made a per-shape registry a co-owner of
  // the goal and let it preselect collect/create/readback operations. Current
  // admission may revalidate proof already owned by this accepted source, but
  // unfamiliar work is supplied only by the ordinary live discovery ->
  // plan_task path. No hidden selector is allowed to manufacture proof here.
  let indexDescriptors: HostCapabilityDescriptorV1[] = [];
  let primaryPlanningCatalog: (typeof primaryModelPlanningCatalogs extends WeakMap<object, infer V> ? V : never) | undefined;
  let selectedPrimaryCapabilityRefs = new Set<string>();
  let capabilityResolutionOutcome: 'completed' | 'capability_resolution_deadline_exceeded' = 'completed';
  if (!primaryModelProposal) {
    // Start one absolute clock before either branch. Index retrieval is
    // independent of current-source proof revalidation, so the two bounded
    // reads run together. Neither leg creates a capability choice.
    const resolutionDeadlineAt = Date.now() + capabilityResolutionDeadlineMs();
    let completedIndexDescriptors: HostCapabilityDescriptorV1[] | null = null;
    const indexedCatalogLeg = (async (): Promise<HostCapabilityDescriptorV1[]> => {
      let descriptors: HostCapabilityDescriptorV1[];
      try {
        const indexed = await registerIndexedCapabilitiesForTurn({
          sessionId: input.identity.sessionId,
          sourceUserSeq: input.identity.sourceUserSeq,
          objective: acceptedSemanticText,
        });
        descriptors = indexed.descriptors;
      } catch {
        descriptors = hostDescriptorsFromCapabilityIndex(acceptedSemanticText);
      }
      completedIndexDescriptors = descriptors;
      return descriptors;
    })();
    const currentSourceProofLeg = (async (): Promise<void> => {
      try {
        await registerProofProvisionedCapabilities(input.identity);
      } catch { /* proof provision is additive; bind still fail-closes */ }
    })();
    const resolutionPhase = Promise.all([
      currentSourceProofLeg,
      indexedCatalogLeg,
    ]).then(([, descriptors]) => descriptors);
    const expired = Symbol('capability-resolution-deadline');
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
    const raced = await Promise.race([
      resolutionPhase,
      new Promise<typeof expired>((resolve) => {
        deadlineTimer = setTimeout(
          () => resolve(expired),
          Math.max(0, resolutionDeadlineAt - Date.now()),
        );
      }),
    ]);
    if (deadlineTimer) clearTimeout(deadlineTimer);
    if (raced === expired) {
      capabilityResolutionOutcome = 'capability_resolution_deadline_exceeded';
      // Preserve the immutable result of an index leg that completed inside
      // the deadline. Only an index leg that itself missed the absolute bound
      // falls back to a same-tick local read.
      indexDescriptors = completedIndexDescriptors
        ?? hostDescriptorsFromCapabilityIndex(acceptedSemanticText);
      // The turn proceeds on the index-only catalog; the abandoned leg must
      // not land its authoritative resolution for this source later (observed
      // live +64s after disclosure — a stale-authority write for a decision
      // already made without it).
      markAdmissionCapabilityResolutionSuperseded(
        input.identity.sessionId,
        input.identity.sourceUserSeq,
        resolutionPhase,
      );
    } else {
      indexDescriptors = raced;
    }
  } else {
    primaryPlanningCatalog = primaryModelCatalogAuthority
      ? primaryModelPlanningCatalogs.get(primaryModelCatalogAuthority as object)
      : undefined;
    if (
      !primaryPlanningCatalog
      || primaryModelCatalogAuthority?.scope !== PRIMARY_MODEL_PLANNING_CATALOG_SCOPE
      || primaryPlanningCatalog.sessionId !== input.identity.sessionId
      || primaryPlanningCatalog.sourceUserSeq !== input.identity.sourceUserSeq
      || primaryPlanningCatalog.digest !== sha256(JSON.stringify(primaryPlanningCatalog.capabilities))
    ) return { ok: false, reason: 'primary model planning catalog authority is missing or changed' };
    selectedPrimaryCapabilityRefs = new Set(
      (primaryModelProposal.work?.operations ?? []).map((operation) => operation.capabilityRef),
    );
    const boundedIds = new Set(primaryPlanningCatalog.capabilities.map((descriptor) => descriptor.id));
    if ([...selectedPrimaryCapabilityRefs].some((ref) => !boundedIds.has(ref))) {
      const promoted = promoteSelectedSameSourceStagedPlanningDescriptors({
        objective: primaryPlanningCatalog.objective,
        current: primaryPlanningCatalog.capabilities,
        staged: [...primaryPlanningCatalog.stagedById.values()].map((entry) => entry.descriptor),
        selectedRefs: selectedPrimaryCapabilityRefs,
        effectCeiling: primaryPlanningCatalog.effectCeiling,
      });
      if (!promoted) {
        // Name the refs that actually failed. The host has computed exactly
        // which cited refs fall outside the bounded set; dropping them left the
        // model to guess which of N bindings was wrong, and a multi-leg plan
        // (read + enrich + draft + write) gives it no way to tell.
        const undisclosed = [...selectedPrimaryCapabilityRefs]
          .filter((ref) => !boundedIds.has(ref))
          .slice(0, 8)
          .map((ref) => (typeof ref === 'string' ? ref.slice(0, 128) : String(ref)));
        return {
          ok: false,
          reason: 'primary model proposal cites a capability that was not disclosed to this source'
            + (undisclosed.length > 0 ? `: ${undisclosed.join(', ')}` : ''),
        };
      }
      primaryPlanningCatalog.capabilities = promoted.capabilities.map((descriptor) => Object.freeze({ ...descriptor }));
      primaryPlanningCatalog.withheld = promoted.withheld;
      primaryPlanningCatalog.digest = sha256(JSON.stringify(primaryPlanningCatalog.capabilities));
    }
    const selectedStaged = [...selectedPrimaryCapabilityRefs]
      .map((ref) => {
        const staged = primaryPlanningCatalog!.stagedById.get(ref);
        if (staged) return staged;
        const initial = primaryPlanningCatalog!.disclosureByName.get(ref.trim().toLowerCase());
        return initial
          ? {
              descriptor: initial.descriptor,
              identifier: initial.identifier,
              providerKind: initial.providerKind,
              accountIdentity: initial.descriptor.accountScope,
              ...(initial.providerDefinition
                ? { providerDefinition: initial.providerDefinition }
                : {}),
            } satisfies StagedPrimaryModelPlanningCapabilityV1
          : undefined;
      })
      .filter((entry): entry is StagedPrimaryModelPlanningCapabilityV1 => Boolean(entry));
    const selectedComposioRefs: Array<{
      identifier: string;
      accountIdentity: string;
      providerDefinition: StagedProviderDefinitionV1 | null | undefined;
    }> = [];
    for (const ref of selectedPrimaryCapabilityRefs) {
      const staged = primaryPlanningCatalog!.stagedById.get(ref);
      if (staged?.providerKind.toLowerCase() === 'composio') {
        selectedComposioRefs.push({
          identifier: staged.identifier,
          accountIdentity: staged.accountIdentity,
          providerDefinition: staged.providerDefinition,
        });
        continue;
      }
      const initial = primaryPlanningCatalog!.disclosureByName.get(ref.trim().toLowerCase());
      if (initial?.providerKind.toLowerCase() !== 'composio') continue;
      selectedComposioRefs.push({
        identifier: initial.identifier,
        accountIdentity: initial.descriptor.accountScope,
        providerDefinition: initial.providerDefinition,
      });
    }
    const namespaceConflict = explicitCapabilityNamespaceConflict({
      acceptedText: acceptedSemanticText,
      namespaceInventory: listRegisteredToolkitNamespaces(),
      selectedNamespaceIds: selectedComposioRefs
        .map((entry) => (
          registeredToolkitNamespaceOfOperation(entry.identifier)
          ?? 'unresolved_provider_namespace'
        )),
    });
    if (namespaceConflict) {
      return {
        ok: false,
        reason: [
          'selected_capability_namespace_conflict',
          `requested_namespaces=${namespaceConflict.requestedNamespaces.join(',')}`,
          `selected_namespace=${namespaceConflict.selectedNamespace}`,
        ].join(':'),
      };
    }
    // Verification is host-derived runtime work, not a semantic requirement.
    // Publish only the unique exact readback definition compatible with each
    // selected mutation. The candidate must already be a staged disclosure or
    // an exact current live catalog definition; names, roles, and schema shape
    // never nominate it. Ambiguity still refuses (the model can cite one).
    // Zero candidates is a host-internal gap: carry the obligation and admit.
    const stagedCandidateByIdentity = new Map<string, StagedPrimaryModelPlanningCapabilityV1>();
    for (const staged of primaryPlanningCatalog.stagedById.values()) {
      stagedCandidateByIdentity.set(`${staged.providerKind}|${staged.accountIdentity}|${staged.identifier}`, staged);
    }
    for (const disclosure of new Set(primaryPlanningCatalog.disclosureByName.values())) {
      if (!disclosure.providerDefinition) continue;
      const staged: StagedPrimaryModelPlanningCapabilityV1 = {
        descriptor: disclosure.descriptor,
        identifier: disclosure.identifier,
        providerKind: disclosure.providerKind,
        accountIdentity: disclosure.descriptor.accountScope,
        providerDefinition: disclosure.providerDefinition,
      };
      stagedCandidateByIdentity.set(`${staged.providerKind}|${staged.accountIdentity}|${staged.identifier}`, staged);
    }
    const supplementaryVerifiers = new Map<string, StagedPrimaryModelPlanningCapabilityV1>();
    for (const mutation of selectedStaged.filter((entry) => (
      entry.providerDefinition?.verificationContract
      && 'mutation' in entry.providerDefinition.verificationContract
    ))) {
      const candidates = [...stagedCandidateByIdentity.values()].filter((candidate) => (
        stagedMutationVerifierMatches({ mutation, candidate })
      ));
      const successor = verificationSuccessorDisposition(candidates.length);
      if (successor === 'ambiguous') {
        // Ambiguous is a fact the model can resolve (cite exactly one). A
        // missing staged verifier is a host-internal gap: staging requires
        // prior discovery, so refusing here blocked ordinary writes to
        // guarantee a proof no code has ever consumed (OPEN-THE-GATES Slice 2,
        // live seq 95048). Carry the obligation; the write seam reports
        // "wrote, could not verify" instead of inventing an outage.
        const contract = mutation.providerDefinition?.verificationContract;
        const shape = contract && 'mutation' in contract
          ? `:family=${contract.mutation.resourceFamily}:handle=${contract.mutation.producedHandleKind}`
          : '';
        return {
          ok: false,
          reason: `verification_successor_required:ambiguous_compatible_verifier:${mutation.identifier}${shape}`,
        };
      }
      if (successor === 'carry_obligation') continue;
      const verifier = candidates[0]!;
      supplementaryVerifiers.set(
        `${verifier.providerKind}|${verifier.accountIdentity}|${verifier.identifier}`,
        verifier,
      );
    }
    for (const verifier of supplementaryVerifiers.values()) {
      if (verifier.providerKind.toLowerCase() !== 'composio') continue;
      if (selectedComposioRefs.some((entry) => (
        entry.identifier === verifier.identifier
        && entry.accountIdentity === verifier.accountIdentity
      ))) continue;
      selectedComposioRefs.push({
        identifier: verifier.identifier,
        accountIdentity: verifier.accountIdentity,
        providerDefinition: verifier.providerDefinition,
      });
    }
    // Host-internal: staging requires prior discovery. Missing a staged
    // definition used to refuse the whole plan (OPEN-THE-GATES Slice 6+).
    // Keep the selected id; revalidate only the definitions the host actually
    // holds. The write seam re-proves live.
    const selectedComposioDefinitions = selectedComposioRefs.flatMap((entry) => {
      const definition = entry.providerDefinition;
      if (!definition) return [];
      return {
        identifier: entry.identifier,
        // Selected-definition revalidation still names its input digest
        // `schemaDigest`; feed it only the explicitly separated input field.
        schemaDigest: definition.providerInputSchemaDigest,
        accountIdentity: entry.accountIdentity,
        definitionFingerprint: definition.definitionFingerprint,
        outputSchemaDigest: definition.providerOutputSchemaDigest,
        providerOperationVersion: definition.providerOperationVersion,
        invokePortId: definition.invokePortId,
        verificationContract: definition.verificationContract,
        operationSemantics: definition.operationSemantics,
      };
    });
    if (selectedComposioDefinitions.length > 0) {
      // `allowedIdentifiers` is publication authority, not the revalidation
      // selection. Only definitions staged by this accepted source may be
      // newly published from its capability-resolution proof. Initial live
      // catalog refs are already published; they still appear in
      // `selectedDefinitions` below so connection/schema/semantic drift is
      // re-proved before sealing, but restamping them from this source would
      // incorrectly require a capability-resolution row it never emitted.
      const stagedPublicationIdentifiers = new Set(
        [...primaryPlanningCatalog.stagedById.values()]
          .filter((entry) => entry.providerKind.toLowerCase() === 'composio')
          .map((entry) => entry.identifier),
      );
      const selectedPublicationIdentifiers = selectedComposioRefs
        .map((entry) => entry.identifier)
        .filter((identifier) => stagedPublicationIdentifiers.has(identifier));
      const provisioned = await registerProofProvisionedCapabilities(input.identity, {
        allowedIdentifiers: selectedPublicationIdentifiers,
        hostDerivedVerificationIdentifiers: [...supplementaryVerifiers.values()]
          .filter((entry) => entry.providerKind.toLowerCase() === 'composio')
          .filter((entry) => stagedPublicationIdentifiers.has(entry.identifier))
          .map((entry) => entry.identifier),
        selectedDefinitions: selectedComposioDefinitions,
      });
      if (provisioned.refusal) {
        return {
          ok: false,
          reason: `selected_definition_revalidation_refused:${provisioned.refusal.code}:${provisioned.refusal.identifier}`,
        };
      }
    }
  }

  // The frozen snapshot pins what admission validated, so it is taken AT plan
  // admission — after this turn's tool_search disclosures were re-proven and
  // registered just above — never at pre-model preparation, which necessarily
  // runs before any disclosure exists (2026-08-26 gauntlet: the prep-time
  // freeze persisted '[]' and refused every same-turn-disclosed proposal with
  // "no longer matches the frozen host catalog"). A repaired proposal later in
  // the SAME turn may cite a capability disclosed after an earlier attempt's
  // freeze, so plan admission extends the snapshot monotonically; once graph
  // authority exists the write-once replay applies. The proposal-free legacy
  // leg only enumerates for the planning card and peeks.
  const frozen = primaryModelProposal
    ? getTurnGraphEventForSource(input.identity.sessionId, input.identity.sourceUserSeq)
      ? freezeCatalogSnapshotForSource({
          sessionId: input.identity.sessionId,
          sourceUserSeq: input.identity.sourceUserSeq,
        })
      : freezeCatalogSnapshotForPlanAdmission({
          sessionId: input.identity.sessionId,
          sourceUserSeq: input.identity.sourceUserSeq,
        })
    : peekCatalogSnapshotForSource({
        sessionId: input.identity.sessionId,
        sourceUserSeq: input.identity.sourceUserSeq,
      });
  const catalogEntries = frozen.ok ? [...frozen.entries] : [];
  // Populated only after the selected local definition survives exact current
  // schema + registry-envelope revalidation below. This is diagnostic input,
  // never new authority.
  const revalidatedLocalPlanningRefs = new Set<string>();
  const catalogDescriptors = catalogEntries
    .map((entry) => hostDescriptorFromRegistered(entry))
    .filter((entry): entry is HostCapabilityDescriptorV1 => entry !== null);
  const proofDescriptors = primaryModelProposal
    ? []
    : hostDescriptorsFromResolutionProof(
        input.identity.sessionId,
        input.identity.sourceUserSeq,
      );
  const byId = new Map<string, HostCapabilityDescriptorV1>();
  const disclosureSourceById = new Map<string, 'frozen_snapshot' | 'proof' | 'index'>();
  for (const [contributor, source] of [
    [catalogDescriptors, 'frozen_snapshot'],
    [proofDescriptors, 'proof'],
    [indexDescriptors, 'index'],
  ] as const) {
    for (const descriptor of contributor) {
      if (byId.has(descriptor.id)) continue;
      byId.set(descriptor.id, descriptor);
      disclosureSourceById.set(descriptor.id, source);
    }
  }
  let capabilities = selectRelevantCapabilityDescriptors([...byId.values()]);
  const frozenCatalogAdvisories: FrozenCatalogAdvisoryV1[] = [];
  if (primaryModelProposal) {
    const catalog = primaryPlanningCatalog!;
    const currentById = new Map(catalogDescriptors.map((descriptor) => [descriptor.id, descriptor]));
    const currentEntriesById = new Map(catalogEntries.map((entry) => [entry.capabilityId, entry]));
    const canonicalCapabilities: HostCapabilityDescriptorV1[] = [];
    for (const descriptor of catalog.capabilities) {
      const staged = catalog.stagedById.get(descriptor.id);
      const isSelected = selectedPrimaryCapabilityRefs.has(descriptor.id);
      if (staged && !isSelected) continue;
      if (staged?.providerKind === AUTHORIZED_LOCAL_REGISTRY_PROVENANCE) {
        if (!staged.localDefinition) {
          frozenCatalogAdvisories.push({
            id: descriptor.id,
            reason: 'absent_from_current_host_catalog',
          });
          canonicalCapabilities.push(descriptor);
          continue;
        }
        const revalidated = await revalidateLocalPlanningDefinition(staged.localDefinition);
        if (
          !revalidated.ok
          || revalidated.definition.capabilityRef !== descriptor.id
          || revalidated.definition.schemaFingerprint
            !== staged.localDefinition.schemaFingerprint
          || revalidated.definition.accountIdentity !== staged.accountIdentity
          || JSON.stringify(revalidated.definition.descriptor) !== JSON.stringify(descriptor)
        ) {
          frozenCatalogAdvisories.push({
            id: descriptor.id,
            reason: 'changed_shape_between_disclosure_and_admission',
          });
          canonicalCapabilities.push(currentById.get(descriptor.id) ?? descriptor);
          continue;
        }
        revalidatedLocalPlanningRefs.add(revalidated.definition.capabilityRef);
        canonicalCapabilities.push(revalidated.definition.descriptor);
        continue;
      }
      const current = currentById.get(descriptor.id);
      if (!staged) {
        // An un-staged descriptor is an "initial" entry the prime-time planning
        // card ranked in from whatever was live in the shared, process-wide
        // catalog factory — not something this turn's own tool_search disclosed
        // or this proposal cited. A same-turn capability registration can
        // collaterally age other live entries out of the factory (live
        // 2026-08-26 gauntlet: registering the selected write triggered a
        // readiness recompute that forgot three unrelated, unselected Google
        // Sheets entries whose independent observation had gone stale, and
        // every plan_task attempt then refused "no longer matches the frozen
        // host catalog" even though the disclosed, selected write was fine).
        // Unselected mismatches stay dropped. Selected mismatches are
        // host-internal: keep the disclosed id, annotate, and let the write
        // seam re-prove (OPEN-THE-GATES Slice 3, live seq 95141).
        const match = selectedFrozenCatalogDispositionFor(isSelected, current, descriptor);
        if (match === 'drop_unselected') continue;
        if (match === 'keep_disclosed') {
          frozenCatalogAdvisories.push({
            id: descriptor.id,
            reason: 'absent_from_current_host_catalog',
          });
          canonicalCapabilities.push(descriptor);
          continue;
        }
        if (match === 'keep_current_advisory') {
          frozenCatalogAdvisories.push({
            id: descriptor.id,
            reason: 'changed_shape_between_disclosure_and_admission',
          });
        }
        canonicalCapabilities.push(current!);
        continue;
      }
      if (!current) {
        const match = selectedFrozenCatalogDispositionFor(isSelected, current, descriptor);
        if (match === 'drop_unselected') continue;
        frozenCatalogAdvisories.push({
          id: descriptor.id,
          reason: 'absent_from_current_host_catalog',
        });
        canonicalCapabilities.push(descriptor);
        continue;
      }
      const entry = currentEntriesById.get(descriptor.id);
      const operationId = entry?.manifest?.operationId?.trim() || entry?.toolName.trim() || '';
      const currentProviderDefinition = entry
        ? stagedProviderDefinitionFromRegistered(entry)
        : null;
      if (
        !entry
        || !staged.providerDefinition
        || !currentProviderDefinition
        || operationId.toLowerCase() !== staged.identifier.toLowerCase()
        || !stagedProviderDefinitionsEqual(
          currentProviderDefinition,
          staged.providerDefinition,
        )
        || (entry.providerKind ?? entry.manifest?.providerKind ?? '') !== staged.providerKind
        || (entry.account ?? entry.manifest?.accountId ?? 'runtime') !== staged.accountIdentity
        || current.effect !== staged.descriptor.effect
      ) {
        // Host-internal churn (readiness recompute, successor id, definition
        // restamp). Same class as G14: keep the current row when it exists,
        // else the disclosed id, annotate, and let the write seam re-prove.
        // Live OPEN-THE-GATES Slice 6: this refusal sat after admission's
        // own catalog act and blocked ordinary reads.
        frozenCatalogAdvisories.push({
          id: descriptor.id,
          reason: current
            ? 'changed_shape_between_disclosure_and_admission'
            : 'absent_from_current_host_catalog',
        });
        canonicalCapabilities.push(current ?? descriptor);
        continue;
      }
      canonicalCapabilities.push(current);
    }
    for (const ref of selectedPrimaryCapabilityRefs) {
      if (canonicalCapabilities.some((entry) => entry.id === ref)) continue;
      const disclosed = catalog.capabilities.find((entry) => entry.id === ref);
      if (!disclosed) continue;
      frozenCatalogAdvisories.push({
        id: ref,
        reason: 'absent_from_current_host_catalog',
      });
      canonicalCapabilities.push(disclosed);
    }
    catalog.capabilities = canonicalCapabilities;
    catalog.liveCapabilities = catalogDescriptors;
    catalog.digest = sha256(JSON.stringify(canonicalCapabilities));
    capabilities = [...canonicalCapabilities];
  }

  let primaryProposalForAdmission = primaryModelProposal;
  if (primaryModelProposal) {
    const manifestStore = peekCapabilityManifestStore();
    const destination = deriveMissingPrimaryPlanDestination({
      proposal: primaryModelProposal,
      catalogEntries,
      resolveCurrentRef: (capabilityRef) => (
        manifestStore
          ? resolveCurrentSuccessorManifest(manifestStore, capabilityRef)?.manifest.manifestId
          : undefined
      ),
    });
    if (!destination.ok) return destination;
    primaryProposalForAdmission = destination.proposal;
    if (destination.derived) {
      logger.info({
        sessionId: input.identity.sessionId,
        sourceUserSeq: input.identity.sourceUserSeq,
        selectedRefs: [...selectedPrimaryCapabilityRefs],
      }, 'derived missing primary-plan destination from exact frozen manifests');
    }
  }

  // Durable record of the catalog the model was ACTUALLY shown — the
  // post-truncation set, with each descriptor's contributor. Additive record
  // only: replay treats it as data, and a failure to append never blocks
  // admission.
  try {
    const disclosureSource = listEvents(input.identity.sessionId, {
      sinceSeq: input.identity.sourceUserSeq - 1,
      types: ['user_input_received'],
      limit: 1,
    }).find((event) => event.seq === input.identity.sourceUserSeq);
    if (disclosureSource) {
      appendEvent({
        sessionId: input.identity.sessionId,
        turn: disclosureSource.turn,
        role: 'system',
        type: 'planning_catalog_disclosed',
        data: {
          sourceUserSeq: input.identity.sourceUserSeq,
          resolution: capabilityResolutionOutcome,
          count: capabilities.length,
          ceiling: primaryPlanningCatalog?.effectCeiling
            ?? planningEffectCeilingForAcceptedRequest(acceptedSemanticText),
          withheld: primaryPlanningCatalog?.withheld ?? [],
          frozenCatalogAdvisories,
          capabilities: capabilities.map((descriptor) => ({
            id: descriptor.id,
            effect: descriptor.effect,
            source: primaryModelProposal
              ? 'primary_planning'
              : disclosureSourceById.get(descriptor.id) ?? 'index',
          })),
        },
      });
    }
  } catch { /* observability only */ }

  const continuity = peekTaskContinuityPacket({ sessionId: input.identity.sessionId });
  const packet = continuity.status === 'available'
    ? {
        kind: continuity.packet.pause.kind,
        question: continuity.packet.pause.question,
        options: continuity.packet.pause.options,
        optionIntents: continuity.packet.pause.optionIntents,
        originatingSourceUserSeq: continuity.packet.originatingSourceUserSeq,
        goalId: continuity.packet.pause.slot?.goalId,
        revision: continuity.packet.pause.slot?.revision,
        questionId: continuity.packet.pause.slot?.questionId,
        slotKey: continuity.packet.pause.slot?.slotKey,
        predecessorRefs: continuity.packet.pause.slot?.predecessorRefs,
      }
    : null;
  const recentTurns = pullRecentTurnsForHarnessHistory(
    input.identity.sessionId,
    8,
    input.identity.sourceUserSeq,
  ).map((turn) => ({ who: turn.who, text: turn.text }));
  const acceptedSourceEvent = listEvents(input.identity.sessionId, {
    sinceSeq: input.identity.sourceUserSeq - 1,
    types: ['user_input_received'],
    limit: 1,
  }).find((event) => event.seq === input.identity.sourceUserSeq);

  const snapshot = snapshotFromAcceptedSource({
    sessionId: input.identity.sessionId,
    sourceUserSeq: input.identity.sourceUserSeq,
    acceptedText: acceptedSemanticText,
    ...(acceptedSourceEvent ? { acceptedAt: acceptedSourceEvent.createdAt } : {}),
    audienceKey,
    userId,
    conversationKey,
    policyRevision,
    capabilities,
    capabilityIds: capabilities.map((entry) => entry.id),
    ...(frozen.ok ? { catalogSnapshotDigest: frozen.digest } : {}),
    recentTurns,
    packet,
  });
  const host = buildTurnSemanticHostViewV1(snapshot);
  if (host.source.audienceHash !== audienceHashOf({ audienceKey, userId, conversationKey })) {
    // An audience mismatch is an INTEGRITY refusal, not a missing capability:
    // it must stay durable and must never downgrade to the untyped lane. Stamp
    // participation so the legacy fallback stays closed for exactly this case.
    recordSemanticParticipation(
      input.identity.sessionId,
      input.identity.sourceUserSeq,
      'participated',
    );
    return { ok: false, reason: 'audience hash mismatch' };
  }
  const authority: HostSemanticAuthorityV1 = {
    policyRevision,
    audienceHash: host.source.audienceHash,
    policyMaxCeiling: 'external_write',
    allowedEffects: ['none', 'read', 'compute', 'host_only', 'unknown', 'local_write', 'external_write'],
    // These refs are added only after the selected local definition survives
    // exact current registry/schema/carrier/envelope revalidation above. They
    // let a local definition edit remain destinationless at the provider
    // boundary without trusting a model-authored `cap:local:` string.
    revalidatedLocalCapabilityRefs: revalidatedLocalPlanningRefs,
  };

  let admitted: Extract<ReturnType<typeof admitTurnSemantics>, { ok: true }>;
  if (primaryProposalForAdmission) {
    // This proposal came from the already-running business model. Revalidate
    // it against the exact durable host view; never call the hidden semantic
    // proposer/effect judge/grounding judge from this in-loop control.
    const direct = admitTurnSemantics(primaryProposalForAdmission, host, authority);
    if (!direct.ok) {
      return {
        ok: false,
        // Keep the validator's own message: it names the repair ("Too big:
        // expected string to have <=N characters"). Live 2026-09-01 a
        // converging authoring turn received `schema_too_big:goal.objective`
        // three times with no limit named, resent an objective that was still
        // too long, and the loop floor stopped it — an error that does not
        // name its own fix cannot be repaired (self-healing law).
        reason: direct.issues.map((issue) => {
          const message = typeof issue.message === 'string'
            ? issue.message.replace(/\s+/g, ' ').trim().slice(0, 160)
            : '';
          return `${issue.code}:${issue.path}${message ? ` (${message})` : ''}`;
        }).join('; ') || 'primary model proposal was not admitted',
      };
    }
    admitted = direct;
  } else {
    // OWNER DECISION 2026-08-25 ("option B"): execution surfaces do not enter
    // the pre-model semantic ceremony. A full day of live runs showed every
    // workflow failure was a ceremony wall — junk citation, self-reference,
    // fabricated topology, zero-op shapes, grounding conflict, and finally
    // "no unique work node" — while every SUCCESS executed in the gated tool
    // loop, where the settlement wall, effect gates, and approvals do the
    // actual protecting. The port therefore declines to participate for any
    // non-chat session; the wrapper below degrades to the validated shadow
    // graph, dispatch reads the source as unparticipated and runs the model
    // loop with tools. Typed planning remains available IN the loop when the
    // model reaches for plan_task — model-driven, never pre-model.
    const sessionKind = getSession(input.identity.sessionId)?.kind ?? 'chat';
    if (sessionKind !== 'chat') {
      recordSemanticDispositionOutcome(input.identity.sessionId, input.identity.sourceUserSeq, 'unavailable');
      return { ok: false, reason: 'semantic port is unavailable' };
    }
    const port = peekTurnSemanticModelPort();
    if (!port) {
      recordSemanticDispositionOutcome(input.identity.sessionId, input.identity.sourceUserSeq, 'unavailable');
      return { ok: false, reason: 'semantic port is unavailable' };
    }

    // A port exists and is about to take this turn: from here on the semantic
    // lane owns the outcome, so a refusal below is durable and must not
    // downgrade to the untyped lane.
    recordSemanticParticipation(
      input.identity.sessionId,
      input.identity.sourceUserSeq,
      'participated',
    );

    const interpreted = await interpretAcceptedSource({
      snapshot,
      authority,
      port,
      turn: input.identity.turn,
    });
    if (interpreted.status !== 'admitted') {
      recordSemanticDispositionOutcome(
        input.identity.sessionId,
        input.identity.sourceUserSeq,
        'blocked',
      );
      return { ok: false, reason: interpreted.reason };
    }
    recordSemanticDispositionOutcome(input.identity.sessionId, input.identity.sourceUserSeq, 'admitted');
    admitted = {
      ok: true,
      source: interpreted.source,
      policyRevision: interpreted.record.policyRevision,
      clamped: interpreted.clamped,
      payloadHash: interpreted.payloadHash,
      contextHash: interpreted.contextHash,
    };
  }

  let destinationBinding: CanonicalDestinationBindingV1 | undefined;
  let clamped = admitted.clamped;
  const writeCeiling = clamped.effectCeiling === 'external_write'
    || clamped.effectCeiling === 'local_write'
    || clamped.effectCeiling === 'admin';
  if (writeCeiling && clamped.destination && frozen.ok) {
    // Candidates are named by CAPABILITY IDENTITY, never by the word the model
    // chose for the step; destinationCandidateLadder owns that rule and carries
    // the live evidence for it.
    const candidateLadder = destinationCandidateLadder(clamped.operations);
    // Bind each referenced capability ON ITS OWN, never as a set. Postures are
    // carrier metadata and are frequently coarse — measured 2026-08-26, one
    // carrier labels create_spreadsheet, values_update and batch_update all
    // 'create_new' — so offering several refs at once is ambiguous by
    // construction and the whole turn loses its destination. One ref at a time
    // is always decidable, and a plan's several writes are exactly what a
    // multi-write plan admitted.
    let bound: ReturnType<typeof bindExecutableDestination> = {
      ok: false,
      reason: 'destination bind requires an exact capability reference',
    };
    const plannedWrites: {
      binding: CanonicalDestinationBindingV1;
      family: string;
      floor: DestinationEvidenceFloorV1;
    }[] = [];
    for (const rung of candidateLadder) {
      for (const ref of rung) {
        const entry = catalogEntries.find((candidate) => candidate.capabilityId === ref);
        const posture = entry?.destination?.posture;
        if (!entry || (posture !== 'create_new' && posture !== 'named_existing')) continue;
        const boundOne = bindExecutableDestination({
          requestedEffect: String(entry.effect),
          destinationPosture: posture,
          candidateIds: [ref],
          catalog: catalogEntries,
        });
        if (!boundOne.ok) {
          if (!bound.ok) bound = boundOne;
          continue;
        }
        if (plannedWrites.some((entry2) => entry2.binding.operationId === boundOne.binding.operationId)) continue;
        plannedWrites.push({
          binding: boundOne.binding,
          family: entry.destination?.family ?? clamped.destination.family,
          floor: boundOne.floor,
        });
      }
      if (plannedWrites.length > 0) break;
    }
    // The singular destination keeps its admitted posture where one of the
    // planned writes offers it, so a single-write turn is unchanged.
    const primaryIndex = plannedWrites.findIndex((entry) => (
      entry.binding.posture === clamped.destination!.posture
    ));
    const primary = plannedWrites[primaryIndex >= 0 ? primaryIndex : 0];
    if (primary) {
      bound = { ok: true, binding: primary.binding, floor: primary.floor };
    }
    const localEnvelopeOwnsDestination = !bound.ok
      && unboundDestinationUsesOnlyRevalidatedLocalEnvelopes({
        operations: clamped.operations,
        revalidatedLocalCapabilityRefs: revalidatedLocalPlanningRefs,
      });
    if (!bound.ok && localEnvelopeOwnsDestination) {
      logger.debug({
        sessionId: input.identity.sessionId,
        sourceUserSeq: input.identity.sourceUserSeq,
        effectCeiling: clamped.effectCeiling,
        posture: clamped.destination.posture,
        candidateLadder,
      }, 'provider destination binding is not applicable; revalidated local envelope owns downstream binding');
    } else if (!bound.ok) {
      // Never silent. An unbound destination still freezes into the accepted
      // graph, and every later write against it is refused for a reason that
      // cannot be traced back to here.
      logger.warn({
        sessionId: input.identity.sessionId,
        sourceUserSeq: input.identity.sourceUserSeq,
        reason: bound.reason,
        effectCeiling: clamped.effectCeiling,
        posture: clamped.destination.posture,
        candidateLadder,
      }, 'accepted write destination could not be bound; downstream consent will refuse this write');
    }
    if (bound.ok) {
      destinationBinding = bound.binding;
      // Every OTHER planned write travels as its own exactly-bound destination.
      // Without this the plan is admitted whole and only its first write can
      // ever execute — including the write into what this turn just created.
      const furtherWrites = plannedWrites
        .filter((entry) => entry.binding.operationId !== destinationBinding!.operationId)
        .map((entry) => ({ binding: entry.binding, family: entry.family }));
      const carried = carryExactDestinationBinding({
        clamped,
        binding: destinationBinding,
        additional: furtherWrites,
      });
      if (!carried.ok) return carried;
      clamped = carried.clamped;
      const floor = unionEvidenceFloor(bound.floor, {
        handleRequired: carried.clamped.destination!.handleRequired,
        evidenceRequirements: clamped.evidenceRequirements ?? [],
      });
      if (floor.handleRequired || floor.evidenceRequirements.length > 0) {
        clamped = {
          ...clamped,
          evidenceRequirements: [...new Set([
            ...(clamped.evidenceRequirements ?? []),
            ...floor.evidenceRequirements,
          ])],
        };
      }
    }
  }

  const semanticProvenanceDigest = sha256(JSON.stringify({
    payloadHash: admitted.payloadHash,
    contextHash: admitted.contextHash,
    source: admitted.source,
  }));

  return {
    ok: true,
    source: admitted.source,
    policyRevision: admitted.policyRevision,
    clamped,
    payloadHash: admitted.payloadHash,
    contextHash: admitted.contextHash,
    semanticProvenanceDigest,
    ...(destinationBinding ? { destinationBinding } : {}),
    authority,
    acceptedText: acceptedSemanticText,
    sessionKind: session.kind,
    policy,
  };
}

export async function admitAndCompileAcceptedSource(input: {
  identity: Pick<TurnIdentity, 'sessionId' | 'turn' | 'sourceUserSeq'>;
  surface: TurnGraphSurface;
  allowedToolNames?: readonly string[];
  excludedToolNames?: readonly string[];
  verifiedTaskContinuation?: TaskContinuationContext;
}): Promise<AdmitAndCompileAcceptedSourceResult> {
  const compiled = await compileDurableAcceptedTurnGraph(input);
  if (!compiled.ok) {
    // Legacy shadow compilation is allowed only when no semantic port
    // participated. A durable participated refusal must not downgrade.
    if (semanticPortParticipated(input.identity.sessionId, input.identity.sourceUserSeq)) {
      return compiled;
    }
    if (
      compiled.reason !== 'semantic port is unavailable'
      && compiled.reason !== CONVERSATION_SHORT_CIRCUIT_REASON
    ) return compiled;
    const typedClaim = listEvents(input.identity.sessionId, {
      types: ['turn_semantics_interpreted'],
    }).some((event) => event.data.sourceUserSeq === input.identity.sourceUserSeq);
    if (typedClaim) return { ok: false, reason: 'typed interpretation exists but the semantic port is unavailable' };
    const shadow = recordTurnGraphShadow({
      identity: input.identity,
      surface: input.surface,
      allowedToolNames: input.allowedToolNames,
      excludedToolNames: input.excludedToolNames,
      verifiedTaskContinuation: input.verifiedTaskContinuation,
    });
    const graph = turnGraphFromShadowEvent(shadow);
    if (!shadow || !graph) return { ok: false, reason: 'untyped graph persist failed' };
    return {
      ok: true,
      event: shadow,
      compiled: {
        graph,
        validation: {
          ok: true,
          errors: [],
          warnings: [],
          nodeCount: graph.nodes.length,
          edgeCount: graph.edges.length,
        },
      },
    };
  }
  const persisted = recordTurnGraphShadowChecked({
    identity: input.identity,
    surface: input.surface,
    allowedToolNames: input.allowedToolNames,
    excludedToolNames: input.excludedToolNames,
    verifiedTaskContinuation: input.verifiedTaskContinuation,
    graph: compiled.compiled.graph,
    persistenceTicket: compiled.persistenceTicket,
  });
  // The refusal names itself. "admitted graph persist failed" with no reason is
  // what made the 2026-08-25 step deaths (an ADMITTED plan refused against a
  // digestless legacy prior) cost hours to attribute.
  if (!persisted.ok) return { ok: false, reason: `admitted graph persist refused: ${persisted.reason}` };
  const event = persisted.event;
  const durableGraph = turnGraphFromShadowEvent(event);
  if (!durableGraph) return { ok: false, reason: 'admitted graph replay failed durable validation' };
  const validation = validateTurnGraph(durableGraph);
  if (!validation.ok) return { ok: false, reason: 'admitted graph replay failed graph validation' };
  return {
    ok: true,
    event,
    compiled: {
      graph: durableGraph,
      validation,
    },
  };
}

/** Persist one graph authored by the foreground model through plan_task.
 * Unlike the legacy compiler, a refused proposal never falls back to an
 * identity-only graph: the primary model receives the typed refusal and may
 * repair its proposal inside the same bounded loop. */
export async function admitAndCompilePrimaryModelProposal(input: {
  identity: Pick<TurnIdentity, 'sessionId' | 'turn' | 'sourceUserSeq'>;
  surface: TurnGraphSurface;
  proposal: TurnSemanticProposalV1;
  planningCatalogAuthority: PrimaryModelPlanningCatalogAuthorityV1;
  allowedToolNames?: readonly string[];
  excludedToolNames?: readonly string[];
  verifiedTaskContinuation?: TaskContinuationContext;
  /** The first graph and the host recovery owner must commit together. */
  onFirstPersistInTransaction?: (db: Database.Database, event: EventRow) => void;
}): Promise<AdmitAndCompileAcceptedSourceResult> {
  const compiled = await compilePrimaryModelAcceptedTurnGraph(
    input,
    input.proposal,
    input.planningCatalogAuthority,
  );
  if (!compiled.ok) return compiled;
  if (compiled.compiled.graph.classification.route !== 'act') {
    return { ok: false, reason: 'plan_task may persist only an admitted action graph' };
  }
  const persisted = recordTurnGraphShadowChecked({
    identity: input.identity,
    surface: input.surface,
    allowedToolNames: input.allowedToolNames,
    excludedToolNames: input.excludedToolNames,
    verifiedTaskContinuation: input.verifiedTaskContinuation,
    graph: compiled.compiled.graph,
    persistenceTicket: compiled.persistenceTicket,
    ...(input.onFirstPersistInTransaction
      ? { onFirstPersistInTransaction: input.onFirstPersistInTransaction }
      : {}),
  });
  // The refusal names itself. "admitted graph persist failed" with no reason is
  // what made the 2026-08-25 step deaths (an ADMITTED plan refused against a
  // digestless legacy prior) cost hours to attribute.
  if (!persisted.ok) return { ok: false, reason: `admitted graph persist refused: ${persisted.reason}` };
  const event = persisted.event;
  const durableGraph = turnGraphFromShadowEvent(event);
  if (!durableGraph) return { ok: false, reason: 'admitted graph replay failed durable validation' };
  const validation = validateTurnGraph(durableGraph);
  if (!validation.ok) return { ok: false, reason: 'admitted graph replay failed graph validation' };
  return {
    ok: true,
    event,
    compiled: { graph: durableGraph, validation },
  };
}
