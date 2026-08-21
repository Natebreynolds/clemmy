/**
 * One atomic host function: load durable source, audience, and one frozen
 * policy snapshot; interpret; validate; admit; compile. Callers do not pass
 * text or constructed authority.
 */
import { createHash } from 'node:crypto';
import { peekTaskContinuityPacket } from '../../memory/task-continuity.js';
import { getProactivityPolicySnapshot } from '../../agents/proactivity-policy.js';
import {
  admitTurnSemantics,
  type HostSemanticAuthorityV1,
} from './admit-turn-semantics.js';
import {
  compileDurableAcceptedTurnGraph,
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
  unionEvidenceFloor,
  type CanonicalDestinationBindingV1,
} from '../harness/destination-binding.js';
import {
  freezeCatalogSnapshotForSource,
  type RegisteredHostCapability,
} from '../harness/host-capability-catalog-factory.js';
import type { HostCapabilityDescriptorV1 } from './turn-semantic-proposal.js';
import { selectRelevantCapabilityDescriptors } from './capability-candidate-retrieval.js';
import { registerProofProvisionedCapabilities } from '../harness/proof-provisioned-catalog.js';
import {
  hostDescriptorsFromCapabilityIndex,
  registerIndexedCapabilitiesForTurn,
} from '../harness/indexed-capability-catalog.js';
import { synthesizeConstructOperations } from './host-bind-operations.js';
import {
  recordTurnGraphShadow,
  sessionHasPriorRetrieveOrAct,
  turnGraphFromShadowEvent,
} from '../graph/turn-graph-shadow.js';
import { classifyMessageIntent } from '../../assistant/message-intent.js';
import {
  provenCapabilityEntriesForTurn,
  resolveTurnCapabilities,
} from '../harness/capability-resolution.js';
import { recordConnectedGoalCatalog } from '../harness/connected-goal-catalog.js';

import { snapshotTurnGraphPolicy, validateTurnGraph } from '../graph/turn-graph-compiler.js';
import type { CompileTurnGraphResult, TurnGraphSurface } from '../graph/turn-graph-ir.js';
import type { TurnIdentity } from '../harness/turn-outcome.js';
import type { TaskContinuationContext } from '../../types.js';
import { getSession, getTurnGraphEventForSource, listEvents, type EventRow } from '../harness/eventlog.js';
import { pullRecentTurnsForHarnessHistory } from '../harness/session-transcript.js';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

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

/**
 * PROVISION FROM PROOF (live 2026-08-18 sess-msywj8qp): when the typed
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
      // live 2026-08-18 sess-msz8m5vg seqs 58261/58274: the model proposed a
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

/** Internal half of the durable compiler seam. It deliberately returns no
 * executable envelope; only admitted data that the private sealer can mint. */
export async function prepareDurableAcceptedTurnCompile(
  input: CompileDurableAcceptedTurnGraphInput,
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

  // Adapter-owned live facts first: connected registry × frozen contracts.
  // Proof provision then registers attested catalog entries for THIS source.
  // The advisory index is citation-only and must run after that, never as
  // bind authority. Freeze last so first-use connected tools are in the snapshot.
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
  let indexDescriptors: HostCapabilityDescriptorV1[] = [];
  try {
    const indexed = await registerIndexedCapabilitiesForTurn({
      sessionId: input.identity.sessionId,
      sourceUserSeq: input.identity.sourceUserSeq,
      objective: durableText,
    });
    indexDescriptors = indexed.descriptors;
  } catch {
    indexDescriptors = hostDescriptorsFromCapabilityIndex(durableText);
  }

  const frozen = freezeCatalogSnapshotForSource({
    sessionId: input.identity.sessionId,
    sourceUserSeq: input.identity.sourceUserSeq,
  });
  const catalogEntries = frozen.ok ? [...frozen.entries] : [];
  const catalogDescriptors = catalogEntries
    .map((entry) => hostDescriptorFromRegistered(entry))
    .filter((entry): entry is HostCapabilityDescriptorV1 => entry !== null);
  const proofDescriptors = hostDescriptorsFromResolutionProof(
    input.identity.sessionId,
    input.identity.sourceUserSeq,
  );
  const byId = new Map<string, HostCapabilityDescriptorV1>();
  for (const descriptor of [...catalogDescriptors, ...proofDescriptors, ...indexDescriptors]) {
    if (!byId.has(descriptor.id)) byId.set(descriptor.id, descriptor);
  }
  const capabilities = selectRelevantCapabilityDescriptors([...byId.values()]);

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

  let destinationBinding: CanonicalDestinationBindingV1 | undefined;
  let clamped = interpreted.clamped;
  const writeCeiling = clamped.effectCeiling === 'external_write'
    || clamped.effectCeiling === 'local_write'
    || clamped.effectCeiling === 'admin';
  if (writeCeiling && clamped.destination && frozen.ok) {
    const candidateIds = (clamped.operations ?? [])
      .filter((operation) => operation.role === 'destination' || operation.role === 'create')
      .map((operation) => operation.capabilityRef)
      .filter((ref): ref is string => Boolean(ref));
    const bound = bindExecutableDestination({
      requestedEffect: clamped.effectCeiling,
      destinationPosture: clamped.destination.posture,
      candidateIds,
      catalog: catalogEntries,
    });
    if (bound.ok) {
      destinationBinding = bound.binding;
      const floor = unionEvidenceFloor(bound.floor, {
        handleRequired: clamped.destination.handleRequired,
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
    payloadHash: interpreted.payloadHash,
    contextHash: interpreted.contextHash,
    source: interpreted.source,
  }));

  return {
    ok: true,
    source: interpreted.source,
    policyRevision: interpreted.record.policyRevision,
    clamped,
    payloadHash: interpreted.payloadHash,
    contextHash: interpreted.contextHash,
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
  const event = recordTurnGraphShadow({
    identity: input.identity,
    surface: input.surface,
    allowedToolNames: input.allowedToolNames,
    excludedToolNames: input.excludedToolNames,
    verifiedTaskContinuation: input.verifiedTaskContinuation,
    graph: compiled.compiled.graph,
    persistenceTicket: compiled.persistenceTicket,
  });
  if (!event) return { ok: false, reason: 'admitted graph persist failed' };
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
