/**
 * The shared accepted-turn read resolver (E4) — the ONE production entry the
 * bridge calls BEFORE brain divergence, so desktop, Discord, Slack,
 * mobile/gateway, Claude, and Codex all share it with the same accepted
 * source.
 *
 * Ordinary chat pays NOTHING here: the warm candidate is resolved from the
 * scoped procedure index with deterministic string matching — no intent
 * model, no tool schema, no discovery. Only a message that deterministically
 * names a PROVEN, fully-bound read procedure enters the lane; everything
 * else declines in microseconds and the normal brain runs unchanged.
 *
 * A verified warm hit dispatches once through the typed bound-dispatch
 * contract, verifies the durable receipt, credits the exact artifact, and
 * hands the bridge a typed evidence-grounded presentation. The BRIDGE owns
 * the accepted source and the exactly-once TurnOutcome commit — this module
 * has no terminal authority (F29).
 *
 * No provider, operation, or content-domain name appears in this control
 * flow; matching is over the artifact index's own identifiers and recorded
 * intents, which are data.
 */
import {
  parseProcedureArtifactDocument,
  resolveActiveProcedure,
  type DurableReceiptRecord,
  type ReceiptResolver,
} from '../../memory/procedure-receipts.js';
import { listActiveArtifactRows } from '../../memory/procedure-store.js';
import { loadPendingCapabilityTurn } from '../../memory/pending-capability-turns.js';
import type { ProcedureArtifact, ProcedureScope } from '../../memory/procedure-artifact.js';
import { sealBudgetContract, createBudgetMeter, type RuntimeBudgetContract } from '../budget-contract.js';
import { createSpanRecorder } from '../trace-envelope.js';
import { sealReadLaneEnvelope, type ReadLaneEnvelope } from './read-envelope.js';
import { runColdToWarmRead, type ReadLaneCounters, type ReadLanePorts } from './read-lane.js';
import { canonicalProcedureScope } from './procedure-scope.js';

export interface AcceptedTurnReadArtifactAuthority {
  artifactId: string;
  kind: ProcedureArtifact['kind'];
  identifier: string;
  provider: string;
  operation: string;
  schemaFingerprint: string;
  scope: ProcedureScope;
}

export interface AcceptedTurnReadPorts {
  /** The scoped stable identity this daemon runs as. REAL identities: the
   *  install/user identity, the workspace, and the connected account's
   *  stable logical identity — never a rotating connection id. */
  scope(): ProcedureScope | undefined;
  /** Production factories bind the exact artifact they admitted. Generic
   * injected resolver ports may omit this for provider-neutral tests. */
  authorizedArtifact?(): AcceptedTurnReadArtifactAuthority;
  /** Live schema fingerprint for a bound identifier, from the loaded
   *  catalog (never a discovery call). */
  liveSchemaFingerprint(identifier: string): string | undefined;
  /** Whether the scope's stable account is currently connected. */
  accountConnected(): boolean;
  /** Dispatch one bound read through the existing wrapped tool boundary and
   *  return the durable receipt id it produced. */
  dispatch: ReadLanePorts['dispatch'];
  receipts: ReceiptResolver;
  /** Evidence-grounded presentation draft from the verified receipt. */
  present: ReadLanePorts['present'];
  /** Injected clock for elapsed-time debits. */
  clock?: () => number;
}

export type AcceptedTurnReadResult =
  | {
      kind: 'served';
      draft: string;
      artifactId: string;
      counters: ReadLaneCounters;
      laneDigest: string;
    }
  | { kind: 'declined'; reason: string }
  /** The governed boundary crossed and a paid read happened, but no verified
   * presentation could be formed. The bridge must stop here, never run a
   * second brain/provider path. */
  | { kind: 'spent'; reason: string; counters: ReadLaneCounters; laneDigest: string };

/** The v1 production budget for one warm read turn. */
function warmReadContract(): RuntimeBudgetContract {
  const sealed = sealBudgetContract({
    uncachedInputTokens: 50_000, outputTokens: 8_000, modelCalls: 1, toolCalls: 2,
    discoveryCalls: 1, validationRepairs: 0, retries: 1, artifactBytes: 4_000_000,
    artifactCount: 8, expansions: 0, effects: 0, elapsedMs: 120_000, concurrency: 1,
  });
  if (!sealed.ok) throw new Error('warm read budget failed to seal');
  return sealed.contract;
}

const WORD = /[a-z0-9]+/g;

function tokens(text: string): Set<string> {
  return new Set((text.toLowerCase().match(WORD) ?? []).filter((token) => token.length > 2));
}

const PRESENTATION_INDEPENDENT_SHELL_TOKENS = new Set([
  'a', 'an', 'at', 'can', 'could', 'do', 'fetch', 'for', 'from', 'get', 'in',
  'me', 'my', 'now', 'of', 'on', 'our', 'please', 'pull', 'retrieve', 'run',
  'show', 'the', 'to', 'us', 'view', 'will', 'with', 'would', 'you',
]);

/**
 * A warm read may bypass Clem's conversational brain only when the user's
 * whole turn is the retrieval itself. Provider/operation words embedded in
 * commentary, advice, comparison, explanation, a compound request, or an
 * extra constraint are not sufficient authority for a fixed presentation.
 *
 * This deliberately small deterministic grammar is fail-open to the normal
 * brain: unfamiliar wording costs the optimization, never the conversation.
 */
export function isPresentationIndependentRetrieval(
  message: string,
  artifact: Pick<ProcedureArtifact, 'provider' | 'operation'>,
): boolean {
  const operationTokens = new Set(
    (`${artifact.operation.replace(/_/g, ' ')} ${artifact.provider}`.toLowerCase().match(WORD) ?? []),
  );
  if (operationTokens.size === 0) return false;
  const messageTokens = message.toLowerCase().match(WORD) ?? [];
  if (messageTokens.length === 0) return false;
  return messageTokens.every((token) => (
    operationTokens.has(token) || PRESENTATION_INDEPENDENT_SHELL_TOKENS.has(token)
  ));
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return Boolean(
    value
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.values(value as Record<string, unknown>).every((item) => typeof item === 'string'),
  );
}

/**
 * Deterministic warm-candidate resolution over the scoped procedure index.
 * High-confidence only: every distinctive token of the artifact's operation
 * (and provider) must appear in the message, and at least two must match —
 * anything weaker declines, because a wrong warm hit is worse than a normal
 * turn.
 */
export function matchWarmCandidate(
  message: string,
  artifacts: ProcedureArtifact[],
): ProcedureArtifact | undefined {
  const messageTokens = tokens(message);
  let best: { artifact: ProcedureArtifact; score: number } | undefined;
  for (const artifact of artifacts) {
    const operationTokens = tokens(`${artifact.operation.replace(/_/g, ' ')} ${artifact.provider}`);
    if (operationTokens.size === 0) continue;
    const matched = [...operationTokens].filter((token) => messageTokens.has(token));
    if (matched.length < Math.min(2, operationTokens.size)) continue;
    if (matched.length < operationTokens.size) continue; // every distinctive token
    const score = matched.length;
    if (!best || score > best.score) best = { artifact, score };
  }
  return best?.artifact;
}

/** Stable single-install identity — real, derived, never blank. */
export function productionScope(accountIdentity: string): ProcedureScope {
  return canonicalProcedureScope(accountIdentity);
}

function laneFor(scope: ProcedureScope, artifact: ProcedureArtifact, request: { sessionId: string; seq: string }): ReadLaneEnvelope | undefined {
  const sealed = sealReadLaneEnvelope({
    identity: {
      tenant: scope.tenant,
      workspace: scope.workspace || 'default',
      acceptedTurnId: `${request.sessionId}:${request.seq}`,
      activationId: `act-${request.seq}`,
      accountIdentity: scope.accountIdentity,
      policyHash: 'read-lane-v1',
      budgetVersion: 'v1',
    },
    capabilities: [{
      name: artifact.identifier,
      schemaFingerprint: artifact.schemaFingerprint,
      effectClass: 'read',
      accountIdentity: scope.accountIdentity,
    }],
    activeCapabilityNames: [artifact.identifier],
    budget: { maxUncachedTokens: 50_000, maxModelCalls: 1, maxToolCalls: 2, maxElapsedMs: 120_000 },
  });
  return sealed.ok ? sealed.lane : undefined;
}

/**
 * The shared resolver. Deterministic decline for ordinary chat; a verified
 * warm read for a proven, fully-bound procedure. Cold discovery stays with
 * the ordinary brain in this release — the lane never adds a model call.
 */
export async function resolveAcceptedTurnRead(
  request: { sessionId: string; message: string; seq: string },
  ports: AcceptedTurnReadPorts,
): Promise<AcceptedTurnReadResult> {
  const scope = ports.scope();
  if (!scope) return { kind: 'declined', reason: 'no connected stable account scope' };

  const artifacts = listActiveArtifactRows()
    .map((document) => parseProcedureArtifactDocument(document))
    .filter((parsed): parsed is Extract<typeof parsed, { ok: true }> => parsed.ok)
    .map((parsed) => parsed.artifact)
    .filter((artifact) => artifact.effectClass === 'read'
      && artifact.scope.tenant === scope.tenant
      && artifact.scope.workspace === scope.workspace
      && artifact.scope.accountIdentity === scope.accountIdentity);
  const authorized = ports.authorizedArtifact?.();
  const authorizedArtifacts = authorized
    ? artifacts.filter((artifact) => artifact.artifactId === authorized.artifactId
      && artifact.kind === authorized.kind
      && artifact.identifier === authorized.identifier
      && artifact.provider === authorized.provider
      && artifact.operation === authorized.operation
      && artifact.schemaFingerprint === authorized.schemaFingerprint
      && artifact.scope.tenant === authorized.scope.tenant
      && artifact.scope.workspace === authorized.scope.workspace
      && artifact.scope.accountIdentity === authorized.scope.accountIdentity)
    : artifacts;
  if (authorizedArtifacts.length === 0) return { kind: 'declined', reason: 'no proven procedures in scope' };

  const candidate = matchWarmCandidate(request.message, authorizedArtifacts);
  if (!candidate) return { kind: 'declined', reason: 'no deterministic warm candidate' };
  if (!isPresentationIndependentRetrieval(request.message, candidate)) {
    return { kind: 'declined', reason: 'retrieval requires conversational presentation' };
  }

  // Slots: template constants plus values extracted under THIS exact accepted
  // source, nothing else. A pending acquisition is keyed durably by logical
  // operation, so it may outlive the turn that created it. Reusing its values
  // for a later request would silently run the active procedure with stale
  // task context. Preserve same-source physical retries, but an unrelated
  // accepted source must resolve its own slots through the ordinary brain.
  const acceptedSource = `${request.sessionId}:${request.seq}`;
  const pending = loadPendingCapabilityTurn({
    scope, provider: candidate.provider, operation: candidate.operation,
  });
  const pendingBelongsToAcceptedSource = Boolean(
    pending
    && pending.scope
    && pending.acceptedSource === acceptedSource
    && pending.scope.tenant === scope.tenant
    && pending.scope.workspace === scope.workspace
    && pending.scope.accountIdentity === scope.accountIdentity
    && pending.provider === candidate.provider
    && pending.operation === candidate.operation
    && pending.identifier === candidate.identifier
    && pending.schemaFingerprint === candidate.schemaFingerprint,
  );
  const slotValues: Record<string, string> = pendingBelongsToAcceptedSource
    && pending
    && isStringRecord(pending.knownSlotValues)
    ? { ...pending.knownSlotValues }
    : {};
  const resolved = resolveActiveProcedure({
    scope,
    provider: candidate.provider,
    operation: candidate.operation,
    effectClass: 'read',
    accountConnected: ports.accountConnected(),
    slotValues,
  });
  if (resolved.outcome !== 'bound') {
    return { kind: 'declined', reason: `procedure resolution: ${resolved.outcome}` };
  }
  if (authorized && (resolved.artifact.artifactId !== authorized.artifactId
    || resolved.artifact.kind !== authorized.kind
    || resolved.artifact.identifier !== authorized.identifier
    || resolved.artifact.provider !== authorized.provider
    || resolved.artifact.operation !== authorized.operation
    || resolved.artifact.schemaFingerprint !== authorized.schemaFingerprint)) {
    return { kind: 'declined', reason: 'authorized artifact changed during resolution' };
  }

  const lane = laneFor(scope, resolved.artifact, request);
  if (!lane) return { kind: 'declined', reason: 'lane authority failed to seal' };

  const lanePorts: ReadLanePorts = {
    async resolveIntent() {
      return {
        kind: 'read',
        provider: candidate.provider,
        operation: candidate.operation,
        slotValues,
      };
    },
    liveSchemaFingerprint: ports.liveSchemaFingerprint,
    accountConnected: ports.accountConnected,
    async discover() { return undefined; }, // warm-only in the chat consumer
    dispatch: ports.dispatch,
    receipts: ports.receipts,
    present: ports.present,
  };
  const outcome = await runColdToWarmRead({
    lane,
    input: request.message,
    scope,
    budget: createBudgetMeter(warmReadContract()),
    spans: createSpanRecorder(ports.clock ?? (() => 0)),
    ports: lanePorts,
    clock: ports.clock,
  });
  if (outcome.outcome === 'failed' && outcome.providerDispatched) {
    return {
      kind: 'spent',
      reason: outcome.reason,
      counters: outcome.counters,
      laneDigest: lane.laneDigest,
    };
  }
  if (outcome.outcome !== 'terminal' || !outcome.warm) {
    return { kind: 'declined', reason: `lane outcome: ${outcome.outcome}` };
  }
  return {
    kind: 'served',
    draft: outcome.text,
    artifactId: resolved.artifact.artifactId,
    counters: outcome.counters,
    laneDigest: lane.laneDigest,
  };
}

export type { DurableReceiptRecord };
