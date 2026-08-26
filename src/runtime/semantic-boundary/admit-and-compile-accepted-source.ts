/**
 * One atomic host function: load durable source, audience, and one frozen
 * policy snapshot; interpret; validate; admit; compile. Callers do not pass
 * text or constructed authority.
 */
import { createHash } from 'node:crypto';
import { getRuntimeEnv } from '../../config.js';
import { peekTaskContinuityPacket } from '../../memory/task-continuity.js';
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
  type RegisteredHostCapability,
} from '../harness/host-capability-catalog-factory.js';
import {
  type HostCapabilityDescriptorV1,
  type TurnSemanticProposalV1,
} from './turn-semantic-proposal.js';
import { selectRelevantCapabilityDescriptors } from './capability-candidate-retrieval.js';
import { registerProofProvisionedCapabilities } from '../harness/proof-provisioned-catalog.js';
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
  sessionHasPriorRetrieveOrAct,
  turnGraphFromShadowEvent,
} from '../graph/turn-graph-shadow.js';
import { classifyMessageIntent } from '../../assistant/message-intent.js';
import {
  markAdmissionCapabilityResolutionSuperseded,
  provenCapabilityEntriesForTurn,
  resolveTurnCapabilities,
} from '../harness/capability-resolution.js';
import { recordConnectedGoalCatalog } from '../harness/connected-goal-catalog.js';
import { digestSchema } from '../../tools/tool-contract-store.js';
import {
  getCachedToolSchema,
  liveComposioOperationVersion,
  liveComposioOutputSchema,
} from '../../tools/composio-schema-cache.js';
import { fingerprintComposioProviderDefinition } from '../../integrations/composio/provider-definition-identity.js';
import {
  AUTHORIZED_LOCAL_REGISTRY_PROVENANCE,
  inspectAuthorizedLocalPlanningDisclosureCandidate,
  revalidateLocalPlanningDefinition,
  type AuthorizedLocalPlanningDefinitionV1,
} from '../harness/local-planning-capability.js';

import { snapshotTurnGraphPolicy, validateTurnGraph } from '../graph/turn-graph-compiler.js';
import type { CompileTurnGraphResult, TurnGraphSurface } from '../graph/turn-graph-ir.js';
import type { TurnIdentity } from '../harness/turn-outcome.js';
import type { TaskContinuationContext } from '../../types.js';
import { appendEvent, getSession, getTurnGraphEventForSource, listEvents, type EventRow } from '../harness/eventlog.js';
import { pullRecentTurnsForHarnessHistory } from '../harness/session-transcript.js';
import pino from 'pino';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}


const logger = pino({ name: 'clementine-next.accepted-source-destination' });

export const CONVERSATION_SHORT_CIRCUIT_REASON = 'conversation_short_circuit';

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
    // how a connected directory or store never gets used.
    if (
      !continuesHostedWork
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
        id: `cap:resolved:${kind}`,
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
  });
}

function stagedProviderDefinitionFromRegistered(
  entry: RegisteredHostCapability,
): StagedProviderDefinitionV1 | null {
  const manifest = entry.manifest;
  const external = manifest?.externalDefinition;
  if (
    !manifest
    || external?.providerOutputSchemaObserved !== true
    || entry.schemaDigest !== manifest.definitionFingerprint
  ) return null;
  return freezeStagedProviderDefinition({
    providerInputSchemaDigest: entry.providerInputSchemaDigest
      ?? external.providerInputSchemaDigest,
    definitionFingerprint: manifest.definitionFingerprint,
    providerOperationVersion: manifest.operationVersion,
    providerOutputSchemaDigest: external.providerOutputSchemaDigest ?? null,
    invokePortId: manifest.invokePortId,
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
  ) return null;
  return freezeStagedProviderDefinition({
    providerInputSchemaDigest: row.providerInputSchemaDigest,
    definitionFingerprint: row.definitionFingerprint,
    providerOperationVersion: row.providerOperationVersion,
    providerOutputSchemaDigest: row.providerOutputSchemaDigest,
    invokePortId: row.invokePortId,
  });
}

function stagedProviderDefinitionsEqual(
  left: StagedProviderDefinitionV1 | null | undefined,
  right: StagedProviderDefinitionV1 | null | undefined,
): boolean {
  return Boolean(left && right && JSON.stringify(left) === JSON.stringify(right));
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
  return current?.providerInputSchemaDigest === legacyInputDigest ? current : null;
}

const primaryModelPlanningCatalogs = new WeakMap<object, {
  sessionId: string;
  sourceUserSeq: number;
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
  });
}

function planningWords(value: string): Set<string> {
  return new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length >= 3));
}

const FRESH_PLANNING_CARD_LIMIT = 8;
const FRESH_PLANNING_CARD_BYTES = 8_192;
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

function boundedFreshPlanningCard(
  descriptors: readonly HostCapabilityDescriptorV1[],
): HostCapabilityDescriptorV1[] {
  const out: HostCapabilityDescriptorV1[] = [];
  let bytes = 2;
  for (const descriptor of descriptors.slice(0, FRESH_PLANNING_CARD_LIMIT)) {
    const encodedBytes = Buffer.byteLength(JSON.stringify(descriptor), 'utf8');
    const next = bytes + encodedBytes + (out.length > 0 ? 1 : 0);
    if (next > FRESH_PLANNING_CARD_BYTES) break;
    out.push(descriptor);
    bytes = next;
  }
  return out;
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
  };
}

/** Advisory proof/index rows may rank a live descriptor, but never enter the
 * authority set unless that exact id is also present in the frozen catalog. */
function rankedLivePlanningDescriptors(input: {
  objective: string;
  live: readonly HostCapabilityDescriptorV1[];
  advisory: readonly HostCapabilityDescriptorV1[];
}): HostCapabilityDescriptorV1[] {
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
    return { descriptor, score: lexical * 100 + (ranked === undefined ? 0 : Math.max(1, 50 - ranked)) };
  });
  scored.sort((left, right) => right.score - left.score || left.descriptor.id.localeCompare(right.descriptor.id));
  return boundedFreshPlanningCard(scored.map((entry) => entry.descriptor));
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
    || !['local_artifact', 'workspace_definition', 'workflow_definition', 'runtime_configuration'].includes(String(row.consequence))
    || !['reversible', 'create_only'].includes(String(row.reversibility))
    || row.destructive !== false
    || row.accountIdentity !== 'local_registry:host'
    || !descriptor
    || (safeMode !== null && (typeof safeMode !== 'object' || Array.isArray(safeMode)))
  ) return null;
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
    destructive: false,
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
          && legacyProviderInputSchemaDigest(row) === match.providerDefinition.providerInputSchemaDigest
          ? match.providerDefinition
          : null;
        if (
          row.capabilityRef !== match.descriptor.id
          || row.manifestDigest !== match.descriptor.manifestDigest
          || !identityMatches
          || !stagedProviderDefinitionsEqual(
            providerDefinition ?? upgradedLegacyDefinition,
            match.providerDefinition,
          )
        ) continue;
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
        || descriptor.id !== `cap:resolved:${identifier}`
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

/** Zero-model catalog preparation for the initial foreground model surface.
 * This is enumeration/ranking only: the accepted-source snapshot is frozen by
 * plan_task after any foreground tool_search disclosure, never before it. */
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
  const objective = display || eventText;
  if (!objective) return { ok: false, reason: 'durable accepted source is missing' };
  let indexedDescriptors: HostCapabilityDescriptorV1[] = [];
  try {
    indexedDescriptors = (await registerIndexedCapabilitiesForTurn({
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      objective,
    })).descriptors;
  } catch {
    indexedDescriptors = hostDescriptorsFromCapabilityIndex(objective);
  }
  const catalogEntries = peekHostCapabilityCatalogFactory()?.snapshot() ?? [];
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
  // Existing proof/index facts rank only exact live ids. They are never copied
  // into the citable set by this seam.
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
  const initial = rankedLivePlanningDescriptors({
    objective,
    live: catalogDescriptors,
    advisory: [...proofDescriptors, ...indexedDescriptors],
  });
  const replayed = await durablePlanningDisclosures({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    byName: disclosureByName,
  });
  const allowedById = new Map<string, HostCapabilityDescriptorV1>();
  for (const descriptor of [...initial, ...replayed.descriptors]) allowedById.set(descriptor.id, descriptor);
  const capabilities = [...allowedById.values()].map((descriptor) => Object.freeze({ ...descriptor }));
  const digest = sha256(JSON.stringify(capabilities));
  const authority = Object.freeze({ scope: PRIMARY_MODEL_PLANNING_CATALOG_SCOPE });
  primaryModelPlanningCatalogs.set(authority, {
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    capabilities,
    liveCapabilities: catalogDescriptors.map((descriptor) => Object.freeze({ ...descriptor })),
    disclosureByName,
    stagedById: replayed.stagedById,
    digest,
  });
  const planning = snapshotPrimaryModelPlanningContext(authority);
  if (!planning) return { ok: false, reason: 'host planning catalog snapshot was not installed' };
  return {
    ok: true,
    planning,
  };
}

/** Monotonically disclose only exact operations returned by this source's
 * visible foreground tool_search. Existing live entries remain executable;
 * novel provider entries are staged and cannot cross a business boundary
 * until plan_task publishes and revalidates the selected subset. */
export async function disclosePrimaryModelPlanningCapabilities(input: {
  authority: PrimaryModelPlanningCatalogAuthorityV1;
  candidates: readonly {
    name: string;
    carrier: 'call_tool' | 'work_call';
    schema?: unknown;
    sourceKind: 'authorized_external_mcp' | 'authorized_composio' | typeof AUTHORIZED_LOCAL_REGISTRY_PROVENANCE;
  }[];
}): Promise<Readonly<Record<string, string>>> {
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
  const proofById = new Map(
    hostDescriptorsFromResolutionProof(catalog.sessionId, catalog.sourceUserSeq)
      .map((descriptor) => [descriptor.id, descriptor]),
  );
  const proofEntries = provenCapabilityEntriesForTurn({
    sessionId: catalog.sessionId,
    sourceUserSeq: catalog.sourceUserSeq,
  });
  for (const candidate of input.candidates.slice(0, 20)) {
    const name = candidate.name.trim();
    if (!name) continue;
    if (candidate.sourceKind === AUTHORIZED_LOCAL_REGISTRY_PROVENANCE) {
      const issued = inspectAuthorizedLocalPlanningDisclosureCandidate(candidate as object);
      if (
        !issued
        || issued.name !== name
        || issued.carrier !== candidate.carrier
        || !candidate.schema
        || typeof candidate.schema !== 'object'
        || Array.isArray(candidate.schema)
        || digestSchema(candidate.schema) !== issued.schemaFingerprint
      ) continue;
      const revalidated = await revalidateLocalPlanningDefinition(issued);
      if (!revalidated.ok) continue;
      const current = revalidated.definition;
      const prior = catalog.stagedById.get(current.capabilityRef);
      if (prior && (
        prior.providerKind !== AUTHORIZED_LOCAL_REGISTRY_PROVENANCE
        || prior.identifier !== current.name
        || prior.accountIdentity !== current.accountIdentity
        || prior.localDefinition?.envelopeFingerprint !== current.envelopeFingerprint
        || prior.providerDefinition !== undefined
        || JSON.stringify(prior.descriptor) !== JSON.stringify(current.descriptor)
      )) continue;
      const staged: StagedPrimaryModelPlanningCapabilityV1 = prior ?? {
        descriptor: current.descriptor,
        identifier: current.name,
        providerKind: AUTHORIZED_LOCAL_REGISTRY_PROVENANCE,
        accountIdentity: current.accountIdentity,
        localDefinition: current,
      };
      catalog.stagedById.set(current.capabilityRef, staged);
      refs[name] = current.capabilityRef;
      if (allowed.has(current.capabilityRef)) continue;
      allowed.set(current.capabilityRef, current.descriptor);
      newlyDisclosed.push({
        kind: AUTHORIZED_LOCAL_REGISTRY_PROVENANCE,
        identifier: current.name,
        effectClass: 'write',
        schemaFingerprint: current.schemaFingerprint,
        capabilityRef: current.capabilityRef,
        manifestDigest: current.descriptor.manifestDigest,
        accountIdentity: current.accountIdentity,
        providerKind: AUTHORIZED_LOCAL_REGISTRY_PROVENANCE,
        descriptor: current.descriptor,
        localAuthority: current,
      });
      continue;
    }
    const exact = catalog.disclosureByName.get(name.toLowerCase());
    if (exact) {
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
    const capabilityRef = `cap:resolved:${name.toLowerCase()}`;
    const descriptor = proofById.get(capabilityRef);
    const proof = proofEntries.find((entry) => (
      entry.kind === 'composio'
      && entry.status === 'proven'
      && entry.connection !== 'missing'
      && entry.identifier.trim().toLowerCase() === name.toLowerCase()
      && (entry.effectClass === 'read' || entry.effectClass === 'write')
    ));
    if (!descriptor || !proof) continue;
    const providerInputSchemaDigest = digestSchema(candidate.schema);
    const accountIdentity = proof.accountIdentity?.trim() || 'runtime';
    if (descriptor.accountScope !== accountIdentity) continue;
    const providerDefinition = currentComposioProviderDefinition({
      identifier: name,
      schema: candidate.schema as Record<string, unknown>,
      accountIdentity,
    });
    if (
      !providerDefinition
      || providerDefinition.providerInputSchemaDigest !== providerInputSchemaDigest
    ) continue;
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
    const source = listEvents(catalog.sessionId, {
      sinceSeq: catalog.sourceUserSeq - 1,
      types: ['user_input_received'],
      limit: 1,
    }).find((event) => event.seq === catalog.sourceUserSeq);
    if (!source) return Object.freeze({});
    appendEvent({
      sessionId: catalog.sessionId,
      turn: source.turn,
      role: 'system',
      type: 'capability_discovered',
      data: { sourceUserSeq: catalog.sourceUserSeq, capabilities: newlyDisclosed },
    });
    catalog.capabilities = [...allowed.values()];
    catalog.digest = sha256(JSON.stringify(catalog.capabilities));
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

  // Conversation is the same kernel with catalog/planner skipped — not a
  // second action loop. Only a high-confidence closed-world greeting skips
  // admission. Every other live source participates. A checker that cannot
  // admit a typed plan withholds typed authority; dispatch keeps tools.
  if (conversationShortCircuit(input.identity, durableText)) {
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

  // Legacy admission retains its connected-goal selector/proof provisioning.
  // Foreground plan_task never runs that hidden selector: tool_search discloses
  // and materializes exact candidates first, then this seam freezes/revalidates
  // only the refs the primary model actually saw.
  let indexDescriptors: HostCapabilityDescriptorV1[] = [];
  let primaryPlanningCatalog: (typeof primaryModelPlanningCatalogs extends WeakMap<object, infer V> ? V : never) | undefined;
  let selectedPrimaryCapabilityRefs = new Set<string>();
  let capabilityResolutionOutcome: 'completed' | 'capability_resolution_deadline_exceeded' = 'completed';
  if (!primaryModelProposal) {
    // Start one absolute clock before either branch. Index retrieval is
    // independent of the connected-account view and must not sit behind it;
    // proof provisioning is not independent and remains strictly downstream
    // of the connected-goal catalog that produces its proof entries.
    const resolutionDeadlineAt = Date.now() + capabilityResolutionDeadlineMs();
    let completedIndexDescriptors: HostCapabilityDescriptorV1[] | null = null;
    const indexedCatalogLeg = (async (): Promise<HostCapabilityDescriptorV1[]> => {
      let descriptors: HostCapabilityDescriptorV1[];
      try {
        const indexed = await registerIndexedCapabilitiesForTurn({
          sessionId: input.identity.sessionId,
          sourceUserSeq: input.identity.sourceUserSeq,
          objective: durableText,
        });
        descriptors = indexed.descriptors;
      } catch {
        descriptors = hostDescriptorsFromCapabilityIndex(durableText);
      }
      completedIndexDescriptors = descriptors;
      return descriptors;
    })();
    const connectedGoalThenProofLeg = (async (): Promise<void> => {
      try {
        await recordConnectedGoalCatalog({
          sessionId: input.identity.sessionId,
          sourceUserSeq: input.identity.sourceUserSeq,
          objective: durableText,
        });
      } catch { /* catalog priming is additive */ }
      try {
        await registerProofProvisionedCapabilities(input.identity);
      } catch { /* proof provision is additive; bind still fail-closes */ }
    })();
    const resolutionPhase = Promise.all([
      connectedGoalThenProofLeg,
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
        ?? hostDescriptorsFromCapabilityIndex(durableText);
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
    const disclosed = new Set(primaryPlanningCatalog.capabilities.map((descriptor) => descriptor.id));
    if ([...selectedPrimaryCapabilityRefs].some((ref) => !disclosed.has(ref))) {
      return { ok: false, reason: 'primary model proposal cites a capability that was not disclosed to this source' };
    }
    const selectedStaged = [...selectedPrimaryCapabilityRefs]
      .map((ref) => primaryPlanningCatalog!.stagedById.get(ref))
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
    if (selectedComposioRefs.some((entry) => !entry.providerDefinition)) {
      return { ok: false, reason: 'selected Composio capability lacks its exact staged provider definition' };
    }
    const selectedComposioDefinitions = selectedComposioRefs.map((entry) => {
      const definition = entry.providerDefinition!;
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
      };
    });
    if (selectedComposioDefinitions.length > 0) {
      const provisioned = await registerProofProvisionedCapabilities(input.identity, {
        // EVERY selected composio ref, not just the staged ones. A capability
        // the model selected from the LIVE catalog (disclosureByName, above)
        // gets its definition revalidated a few lines up and was then omitted
        // from the publication allowlist — revalidated and never published, so
        // plan admission froze a catalog without it and refused the proposal
        // it had just proven (live 2026-08-26: an active, proven Sheets
        // connection, seven plan_task refusals, zero business calls). The two
        // lists must name the same set: whatever was revalidated is published.
        allowedIdentifiers: selectedComposioRefs.map((entry) => entry.identifier),
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
          return { ok: false, reason: 'selected local capability lost its sealed planning definition' };
        }
        const revalidated = await revalidateLocalPlanningDefinition(staged.localDefinition);
        if (
          !revalidated.ok
          || revalidated.definition.capabilityRef !== descriptor.id
          || revalidated.definition.schemaFingerprint
            !== staged.localDefinition.schemaFingerprint
          || revalidated.definition.accountIdentity !== staged.accountIdentity
          || JSON.stringify(revalidated.definition.descriptor) !== JSON.stringify(descriptor)
        ) return { ok: false, reason: 'disclosed local capability changed before plan freeze' };
        canonicalCapabilities.push(revalidated.definition.descriptor);
        continue;
      }
      const current = currentById.get(descriptor.id);
      if (!current) {
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
        // Drop it from the canonical re-derivation exactly like an unselected
        // STAGED descriptor already is above; only a SELECTED capability going
        // missing is this proposal's problem.
        if (!isSelected) continue;
        return { ok: false, reason: 'primary model planning catalog no longer matches the frozen host catalog' };
      }
      if (!staged) {
        if (JSON.stringify(current) !== JSON.stringify(descriptor)) {
          if (!isSelected) continue;
          return { ok: false, reason: 'primary model planning catalog no longer matches the frozen host catalog' };
        }
        canonicalCapabilities.push(current);
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
      ) return { ok: false, reason: 'disclosed provider capability changed before plan freeze' };
      canonicalCapabilities.push(current);
    }
    if ([...selectedPrimaryCapabilityRefs].some((ref) => !canonicalCapabilities.some((entry) => entry.id === ref))) {
      return { ok: false, reason: 'selected capability was not current at plan freeze' };
    }
    catalog.capabilities = canonicalCapabilities;
    catalog.liveCapabilities = catalogDescriptors;
    catalog.digest = sha256(JSON.stringify(canonicalCapabilities));
    capabilities = [...canonicalCapabilities];
  }

  // Durable record of the catalog the model was ACTUALLY shown — the
  // post-truncation set, with each descriptor's contributor. Three legs feed
  // this union and only one of them (the goal catalog) left any durable trace,
  // so reconstructing "what menu produced this citation" required hand
  // archaeology. Additive record only: replay treats it as data, and a failure
  // to append never blocks admission.
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
        question: continuity.packet.pause.question,
        options: continuity.packet.pause.options,
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

  const snapshot = snapshotFromAcceptedSource({
    sessionId: input.identity.sessionId,
    sourceUserSeq: input.identity.sourceUserSeq,
    acceptedText: durableText,
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
  };

  let admitted: Extract<ReturnType<typeof admitTurnSemantics>, { ok: true }>;
  if (primaryModelProposal) {
    // This proposal came from the already-running business model. Revalidate
    // it against the exact durable host view; never call the hidden semantic
    // proposer/effect judge/grounding judge from this in-loop control.
    const direct = admitTurnSemantics(primaryModelProposal, host, authority);
    if (!direct.ok) {
      return {
        ok: false,
        reason: direct.issues.map((issue) => `${issue.code}:${issue.path}`).join('; ') || 'primary model proposal was not admitted',
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
    if (!bound.ok) {
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
    acceptedText: durableText,
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
