import {
  acceptedTurnCallAuthorityFor,
  withHostCallAttestation,
  type HostCallAttestation,
} from './accepted-turn-call-authority.js';
import { settleToolAttempt } from './attempt-settlement.js';
import {
  asyncReadGetterLogicalCallId,
  asyncReadProviderStartLogicalCallId,
  loadAsyncReadRefinementOwner,
  recordAsyncReadRefinementBudgetTerminalOutcome,
  recordAsyncReadRefinementCancellationTerminalOutcome,
  recordAsyncReadRefinementChildFailureTerminalOutcome,
  recordAsyncReadRefinementCompletion,
  recordAsyncReadRefinementStartReceipt,
  type AsyncReadRefinementTerminalGateV1,
} from './async-read-refinement-store.js';
import { capabilityManifestDigest, currentCapabilityManifest } from './capability-manifest.js';
import {
  activateDispatchLease,
  revokeDispatchLease,
  type DispatchLeaseRef,
} from './dispatch-lease.js';
import {
  canonicalCatalogIdentityOf,
  catalogIdentitiesEqual,
  freezeCatalogSnapshotForSource,
  loadSealedNodeBinding,
  type RegisteredHostCapability,
} from './host-capability-catalog-factory.js';
import { hostCallAttestationBindingDigest } from './host-call-capability-binding.js';
import { invokeHostToolCall } from './host-tool-invocation.js';
import { durableLogicalCallContract } from './logical-call-contract.js';
import { redeemDurableLogicalCallSettlementForHost } from './logical-call-settlement-store.js';
import { resolveProductionPortsForManifest } from './production-capability-ports.js';
import type { VerifiedRecentArticlesV1 } from './recent-article-date-evidence.js';

export type ExecuteAsyncReadRefinementResult =
  | { status: 'not_applicable' }
  | { status: 'completed'; evidence: VerifiedRecentArticlesV1; duplicate: boolean }
  | { status: 'terminal'; gate: AsyncReadRefinementTerminalGateV1; duplicate: boolean }
  | { status: 'pending' | 'held'; reason: string };

export class AsyncReadRefinementAuthorityError extends Error {
  override readonly name = 'AsyncReadRefinementAuthorityError';
  constructor(readonly reason: string) {
    super(`Async read refinement failed closed: ${reason}`);
  }
}

function boundedReason(value: unknown): string {
  return String(value instanceof Error ? value.message : value)
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, 300) || 'async read refinement is unavailable';
}

function exactEntry(
  entries: readonly RegisteredHostCapability[],
  predicate: (entry: RegisteredHostCapability) => boolean,
): RegisteredHostCapability | null {
  const matches = entries.filter(predicate);
  return matches.length === 1 ? matches[0]! : null;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    const abort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason instanceof Error ? signal.reason : new Error('async read refinement cancelled'));
    };
    if (signal?.aborted) return abort();
    signal?.addEventListener('abort', abort, { once: true });
  });
}

function providerArgsForOwner(owner: NonNullable<ReturnType<typeof loadAsyncReadRefinementOwner>>) {
  return {
    urls: owner.intent.candidates.map((candidate) => candidate.url),
    formats: ['rawHtml'],
  };
}

function exactCallable(input: {
  entries: readonly RegisteredHostCapability[];
  entry: RegisteredHostCapability | null;
  operationId: string;
  account: string;
  providerInputSchemaDigest: string;
  providerOutputSchemaDigest: string;
  schemaDigest?: string;
  manifestDigest?: string;
}): RegisteredHostCapability | null {
  const match = input.entry ?? exactEntry(input.entries, (entry) => {
    const identity = canonicalCatalogIdentityOf(entry);
    return Boolean(
      identity
      && identity.operationId === input.operationId
      && identity.account === input.account
      && identity.providerInputSchemaDigest === input.providerInputSchemaDigest
      && (!input.schemaDigest || identity.schemaDigest === input.schemaDigest)
      && (!input.manifestDigest || identity.manifestDigest === input.manifestDigest),
    );
  });
  const identity = match ? canonicalCatalogIdentityOf(match) : null;
  const manifest = currentCapabilityManifest(match?.manifest);
  const port = manifest ? resolveProductionPortsForManifest(manifest) : null;
  if (
    !match
    || !identity
    || !manifest
    || !port
    || match.effect !== 'read'
    || manifest.effect !== 'read'
    || identity.operationId !== input.operationId
    || identity.account !== input.account
    || identity.providerInputSchemaDigest !== input.providerInputSchemaDigest
    || manifest.externalDefinition?.providerOutputSchemaDigest !== input.providerOutputSchemaDigest
    || (input.schemaDigest && identity.schemaDigest !== input.schemaDigest)
    || (input.manifestDigest && identity.manifestDigest !== input.manifestDigest)
    || capabilityManifestDigest(manifest) !== identity.manifestDigest
    || manifest.invokePortId !== identity.invokePortId
  ) return null;
  return match;
}

async function invokeFrozenReadChild(input: {
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  ownerLogicalToolCallId: string;
  logicalToolCallId: string;
  entry: RegisteredHostCapability;
  args: Record<string, unknown>;
  parentLease: DispatchLeaseRef;
  turn?: number;
  deadlineMs: number;
  callerSignal?: AbortSignal;
  isKillRequested?: () => boolean;
}): Promise<unknown> {
  const manifest = currentCapabilityManifest(input.entry.manifest);
  const canonical = canonicalCatalogIdentityOf(input.entry);
  const port = manifest ? resolveProductionPortsForManifest(manifest) : null;
  const root = acceptedTurnCallAuthorityFor(input.sessionId, input.sourceUserSeq);
  const logical = manifest
    ? durableLogicalCallContract(input.acceptedTaskId, manifest.operationId, input.args)
    : null;
  if (
    !manifest
    || !canonical
    || !port
    || !logical
    || root.status !== 'ok'
    || root.authority.authorityKind !== 'host_v1'
    || root.authority.state !== 'open'
    || root.authority.identity.acceptedTaskId !== input.acceptedTaskId
    || !root.authority.catalogRevisionDigest
    || !root.authority.bindingRevisionDigest
  ) throw new AsyncReadRefinementAuthorityError('accepted host root cannot own the frozen read child');
  const binding = {
    bindingKind: 'catalog_manifest' as const,
    capabilityId: canonical.capabilityId,
    ...(canonical.providerInputSchemaDigest
      ? { providerInputSchemaDigest: canonical.providerInputSchemaDigest }
      : {}),
    schemaFingerprint: canonical.schemaDigest,
    accountId: canonical.account,
    invokePortId: canonical.invokePortId,
    operationId: canonical.operationId,
    manifestId: canonical.manifestId,
    manifestDigest: canonical.manifestDigest,
    effect: 'read' as const,
  };
  const attestation: HostCallAttestation = {
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    acceptedTaskId: input.acceptedTaskId,
    sourceEventId: root.authority.sourceEventId,
    sourceEventDigest: root.authority.sourceEventDigest,
    logicalToolCallId: input.logicalToolCallId,
    toolName: logical.toolName,
    argumentDigest: logical.argumentDigest,
    ...binding,
    bindingDigest: hostCallAttestationBindingDigest(binding),
    engineVersion: root.authority.engineVersion,
    surfaceVersion: root.authority.surfaceVersion,
    authorityDigest: root.authority.authorityDigest,
    authorityRevision: root.authority.revision,
    surfaceDigest: root.authority.surfaceDigest,
    catalogRevisionDigest: root.authority.catalogRevisionDigest,
    bindingRevisionDigest: root.authority.bindingRevisionDigest,
  };
  const invoked = await withHostCallAttestation(attestation, () => invokeHostToolCall({
    identity: {
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      modelCallId: input.logicalToolCallId,
      toolName: manifest.operationId,
      args: input.args,
      ...(input.turn === undefined ? {} : { turn: input.turn }),
    },
    parentLease: input.parentLease,
    nestedReadOwnerLogicalToolCallId: input.ownerLogicalToolCallId,
    effect: 'read',
    boundary: 'host_owned_external',
    businessCall: false,
    deadlineMs: input.deadlineMs,
    ...(input.callerSignal ? { callerSignal: input.callerSignal } : {}),
    ...(input.isKillRequested ? { isKillRequested: input.isKillRequested } : {}),
    invoke: () => input.entry.invoke({
      nodeId: input.logicalToolCallId,
      role: 'host_verification',
      payload: input.args,
      identity: {
        sessionId: input.sessionId,
        sourceUserSeq: input.sourceUserSeq,
        acceptedTaskId: input.acceptedTaskId,
      },
      binding: {
        capabilityId: input.entry.capabilityId,
        toolName: manifest.operationId,
        schemaVersion: manifest.operationVersion,
        schemaDigest: manifest.definitionFingerprint,
        args: input.args,
        account: manifest.accountId,
        effect: 'read',
        ...(manifest.destination ? { destination: manifest.destination } : {}),
        manifestDigest: capabilityManifestDigest(manifest),
        providerKind: manifest.providerKind,
        liveFingerprint: manifest.definitionFingerprint,
        manifest,
        invoke: port.invoke,
      },
    }),
  }));
  return invoked.value;
}

function settleVerifiedOwner(input: {
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  ownerLogicalToolCallId: string;
  args: Record<string, unknown>;
  evidence: VerifiedRecentArticlesV1;
  parentLease: DispatchLeaseRef;
  turn?: number;
}): { duplicate: boolean } {
  const settlement = settleToolAttempt({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    acceptedTaskId: input.acceptedTaskId,
    callId: input.ownerLogicalToolCallId,
    ...(input.turn === undefined ? {} : { turn: input.turn }),
    lane: 'byo',
    toolName: 'FIRECRAWL_BATCH_SCRAPE',
    args: input.args,
    mutating: false,
    businessCall: true,
    dispatchLease: input.parentLease,
    result: input.evidence,
  });
  if (settlement.outcome.kind !== 'succeeded' && settlement.outcome.kind !== 'empty_result') {
    throw new AsyncReadRefinementAuthorityError(
      `verified owner settled ${settlement.outcome.kind} instead of success`,
    );
  }
  return { duplicate: settlement.duplicate };
}

function settleTerminalOwner(input: {
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  ownerLogicalToolCallId: string;
  args: Record<string, unknown>;
  gate: AsyncReadRefinementTerminalGateV1;
  parentLease: DispatchLeaseRef;
  turn?: number;
}): { duplicate: boolean } {
  const settlement = settleToolAttempt({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    acceptedTaskId: input.acceptedTaskId,
    callId: input.ownerLogicalToolCallId,
    ...(input.turn === undefined ? {} : { turn: input.turn }),
    lane: 'byo',
    toolName: 'FIRECRAWL_BATCH_SCRAPE',
    args: input.args,
    mutating: false,
    businessCall: true,
    dispatchLease: input.parentLease,
    result: input.gate,
    // The host completed the bounded refinement protocol, but the accepted
    // research requirement remains deliberately open. This prevents the
    // downstream Workspace write and terminal publication from treating the
    // scope gate as verified article evidence.
    continuesRequirement: true,
  });
  if (settlement.outcome.kind !== 'succeeded') {
    throw new AsyncReadRefinementAuthorityError(
      `terminal refinement owner settled ${settlement.outcome.kind} instead of success`,
    );
  }
  return { duplicate: settlement.duplicate };
}

function settleDefinitiveProviderChildFailure(input: {
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  ownerLogicalToolCallId: string;
  childLogicalToolCallId: string;
  args: Record<string, unknown>;
  parentLease: DispatchLeaseRef;
  turn?: number;
}): ExecuteAsyncReadRefinementResult {
  const terminal = recordAsyncReadRefinementChildFailureTerminalOutcome({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    acceptedTaskId: input.acceptedTaskId,
    startLogicalToolCallId: input.ownerLogicalToolCallId,
    childLogicalToolCallId: input.childLogicalToolCallId,
  });
  if (terminal.status === 'held') return terminal;
  try {
    const settled = settleTerminalOwner({
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      acceptedTaskId: input.acceptedTaskId,
      ownerLogicalToolCallId: input.ownerLogicalToolCallId,
      args: input.args,
      gate: terminal.gate,
      parentLease: input.parentLease,
      ...(input.turn === undefined ? {} : { turn: input.turn }),
    });
    return { status: 'terminal', gate: terminal.gate, duplicate: settled.duplicate };
  } catch (error) {
    return { status: 'held', reason: boundedReason(error) };
  }
}

/** Daemon-boot Stop finalizer. It owns no provider edge: after the exact kill
 * request is frozen in the terminal receipt, a fresh call-bound local lease
 * settles only the already-open R owner with continuesRequirement=true. The
 * restart scheduler may clear HRS/marker only after this returns cancelled. */
export function finalizeCancelledAsyncReadRefinement(input: {
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  ownerLogicalToolCallId: string;
  runAttemptId: string;
  turn?: number;
}): { status: 'cancelled' | 'replayed'; duplicate: boolean }
  | { status: 'held'; reason: string } {
  const owner = loadAsyncReadRefinementOwner({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    startLogicalToolCallId: input.ownerLogicalToolCallId,
  });
  if (
    !owner
    || owner.intent.acceptedTaskId !== input.acceptedTaskId
    || owner.completedEvidence
  ) return { status: 'held', reason: 'cancelled async refinement owner is missing or completed' };
  const receipt = recordAsyncReadRefinementCancellationTerminalOutcome({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    acceptedTaskId: input.acceptedTaskId,
    startLogicalToolCallId: input.ownerLogicalToolCallId,
    runAttemptId: input.runAttemptId,
  });
  if (receipt.status === 'held') return receipt;
  const args = providerArgsForOwner(owner);
  const logical = durableLogicalCallContract(
    input.acceptedTaskId,
    'FIRECRAWL_BATCH_SCRAPE',
    args,
  );
  if (!logical) return { status: 'held', reason: 'cancelled async owner arguments are not contractible' };
  const lease = activateDispatchLease({
    sessionId: input.sessionId,
    scopeId: `async-read-cancel:${input.sourceUserSeq}:${input.ownerLogicalToolCallId}`,
    // The predecessor attempt is already terminal at daemon boot. It remains
    // an immutable kill witness in the cancellation receipt, but cannot own a
    // new current lease. This host-local generation crosses no provider edge
    // and exists only to settle the exact receipt-backed outer R call.
    sourceUserSeq: input.sourceUserSeq,
    acceptedTaskId: input.acceptedTaskId,
    logicalToolCallId: input.ownerLogicalToolCallId,
    recovery: {
      effect: 'read',
      businessCall: true,
      material: { ...logical, args },
      ...(input.turn === undefined ? {} : { turn: input.turn }),
    },
  });
  try {
    const settled = settleTerminalOwner({
      ...input,
      args,
      gate: receipt.gate,
      parentLease: lease,
    });
    return {
      status: receipt.status === 'replayed' ? 'replayed' : 'cancelled',
      duplicate: settled.duplicate,
    };
  } catch (error) {
    return { status: 'held', reason: boundedReason(error) };
  } finally {
    revokeDispatchLease(lease);
  }
}

/** Execute or replay the exact durable S→R continuation. Provider START and
 * getter calls are deterministic read-only children. Only the compact,
 * host-verified evidence object settles R; job receipts and raw HTML remain in
 * child result handles and never become model history. */
export async function executeAsyncReadRefinement(input: {
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  ownerLogicalToolCallId: string;
  parentLease: DispatchLeaseRef;
  turn?: number;
  deadlineMs?: number;
  callerSignal?: AbortSignal;
  isKillRequested?: () => boolean;
}): Promise<ExecuteAsyncReadRefinementResult> {
  const owner = loadAsyncReadRefinementOwner({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    startLogicalToolCallId: input.ownerLogicalToolCallId,
  });
  if (!owner) return { status: 'not_applicable' };
  if (
    owner.intent.acceptedTaskId !== input.acceptedTaskId
    || input.parentLease.logicalToolCallId !== input.ownerLogicalToolCallId
    || input.parentLease.acceptedTaskId !== input.acceptedTaskId
    || input.parentLease.sourceUserSeq !== input.sourceUserSeq
  ) return { status: 'held', reason: 'async refinement execution lease does not own the exact R call' };

  const args = providerArgsForOwner(owner);
  if (owner.completedEvidence) {
    const settled = settleVerifiedOwner({ ...input, args, evidence: owner.completedEvidence });
    return { status: 'completed', evidence: owner.completedEvidence, duplicate: settled.duplicate };
  }
  if (owner.terminalGate) {
    const settled = settleTerminalOwner({ ...input, args, gate: owner.terminalGate });
    return { status: 'terminal', gate: owner.terminalGate, duplicate: settled.duplicate };
  }
  const frozen = freezeCatalogSnapshotForSource({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
  });
  const sealed = loadSealedNodeBinding(
    input.sessionId,
    input.sourceUserSeq,
    owner.intent.requirementId,
  );
  if (!frozen.ok || !sealed?.asyncRead) {
    return { status: 'held', reason: 'frozen async read catalog or owner binding is unavailable' };
  }
  const recipe = owner.intent.recipe;
  const startEntry = exactCallable({
    entries: frozen.entries,
    entry: exactEntry(frozen.entries, (entry) => entry.capabilityId === sealed.capabilityId),
    operationId: recipe.owner.operationId,
    account: recipe.owner.account,
    providerInputSchemaDigest: recipe.owner.providerInputSchemaDigest,
    providerOutputSchemaDigest: recipe.owner.providerOutputSchemaDigest,
  });
  const getterEntry = exactCallable({
    entries: frozen.entries,
    entry: exactEntry(frozen.entries, (entry) => {
      const identity = canonicalCatalogIdentityOf(entry);
      return Boolean(identity && catalogIdentitiesEqual(identity, recipe.getter));
    }),
    operationId: recipe.getter.operationId,
    account: recipe.getter.account,
    providerInputSchemaDigest: recipe.getter.providerInputSchemaDigest ?? '',
    providerOutputSchemaDigest: recipe.getterProviderOutputSchemaDigest,
    schemaDigest: recipe.getter.schemaDigest,
    manifestDigest: recipe.getter.manifestDigest,
  });
  if (!startEntry || !getterEntry) {
    return { status: 'held', reason: 'frozen batch start or getter callable changed after plan admission' };
  }

  const invocationStartedAt = Date.now();
  const invocationBudget = Math.min(input.deadlineMs ?? recipe.maximumElapsedMs, recipe.maximumElapsedMs);
  let durableStartEpoch = owner.startRecordedAt === null
    ? null
    : Date.parse(owner.startRecordedAt);
  const remaining = (): number => {
    const invocationRemaining = invocationBudget - (Date.now() - invocationStartedAt);
    const durableRemaining = durableStartEpoch === null
      ? recipe.maximumElapsedMs
      : recipe.maximumElapsedMs - (Date.now() - durableStartEpoch);
    return Math.max(1, Math.min(invocationRemaining, durableRemaining));
  };
  const startLogicalToolCallId = asyncReadProviderStartLogicalCallId(input.ownerLogicalToolCallId);
  let jobId = owner.jobId;
  if (!jobId) {
    try {
      await invokeFrozenReadChild({
        ...input,
        logicalToolCallId: startLogicalToolCallId,
        entry: startEntry,
        args,
        deadlineMs: remaining(),
      });
    } catch (error) {
      return settleDefinitiveProviderChildFailure({
        ...input,
        args,
        childLogicalToolCallId: startLogicalToolCallId,
      });
    }
    const receipt = recordAsyncReadRefinementStartReceipt({
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      acceptedTaskId: input.acceptedTaskId,
      startLogicalToolCallId: input.ownerLogicalToolCallId,
      providerStartLogicalToolCallId: startLogicalToolCallId,
    });
    if (receipt.status === 'held') return receipt;
    jobId = receipt.jobId;
    const refreshed = loadAsyncReadRefinementOwner({
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      startLogicalToolCallId: input.ownerLogicalToolCallId,
    });
    durableStartEpoch = refreshed?.startRecordedAt
      ? Date.parse(refreshed.startRecordedAt)
      : null;
  }
  if (durableStartEpoch === null || !Number.isFinite(durableStartEpoch)) {
    return { status: 'held', reason: 'durable batch start time is unavailable' };
  }
  const getterArgs = { [recipe.getterIdArgument]: jobId };
  const backoff = [0, 1_000, 2_500, 5_000, 10_000, 20_000] as const;
  for (let ordinal = 0; ordinal < recipe.maximumGetterAttempts; ordinal += 1) {
    const getterLogicalToolCallId = asyncReadGetterLogicalCallId(
      input.ownerLogicalToolCallId,
      ordinal,
    );
    const prior = redeemDurableLogicalCallSettlementForHost({
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      acceptedTaskId: input.acceptedTaskId,
      logicalToolCallId: getterLogicalToolCallId,
    });
    if (prior.status === 'ok') {
      if (
        prior.settlement.outcome.kind !== 'succeeded'
        && prior.settlement.outcome.kind !== 'empty_result'
        && prior.settlement.outcome.directive.action !== 'retry_with_backoff'
      ) return settleDefinitiveProviderChildFailure({
        ...input,
        args,
        childLogicalToolCallId: getterLogicalToolCallId,
      });
      if (
        prior.settlement.outcome.kind !== 'succeeded'
        && prior.settlement.outcome.kind !== 'empty_result'
      ) continue;
    } else if (prior.status !== 'missing') {
      return { status: 'held', reason: `getter attempt settlement is ${prior.status}: ${prior.reason}` };
    }
    if (prior.status === 'missing') {
      // A durable getter that landed before the deadline is always redeemed in
      // the branch above before elapsed-time policy is consulted. The deadline
      // can forbid only a NEW provider crossing; it can never discard already
      // committed sufficient evidence after a crash.
      if (Date.now() - durableStartEpoch >= recipe.maximumElapsedMs) {
        const terminal = recordAsyncReadRefinementBudgetTerminalOutcome({
          sessionId: input.sessionId,
          sourceUserSeq: input.sourceUserSeq,
          acceptedTaskId: input.acceptedTaskId,
          startLogicalToolCallId: input.ownerLogicalToolCallId,
          kind: 'deadline_exhausted',
        });
        if (terminal.status === 'held') return terminal;
        const settled = settleTerminalOwner({ ...input, args, gate: terminal.gate });
        return { status: 'terminal', gate: terminal.gate, duplicate: settled.duplicate };
      }
      if (
        Date.now() - invocationStartedAt + backoff[ordinal]! >= invocationBudget
      ) {
        return { status: 'pending', reason: 'bounded getter deadline elapsed before the next read-only attempt' };
      }
      try {
        await delay(backoff[ordinal]!, input.callerSignal);
        // Timers can wake late under event-loop pressure. Recheck both clocks at
        // the final provider edge; the pre-delay check is advisory only.
        if (Date.now() - durableStartEpoch >= recipe.maximumElapsedMs) {
          const terminal = recordAsyncReadRefinementBudgetTerminalOutcome({
            sessionId: input.sessionId,
            sourceUserSeq: input.sourceUserSeq,
            acceptedTaskId: input.acceptedTaskId,
            startLogicalToolCallId: input.ownerLogicalToolCallId,
            kind: 'deadline_exhausted',
          });
          if (terminal.status === 'held') return terminal;
          const settled = settleTerminalOwner({ ...input, args, gate: terminal.gate });
          return { status: 'terminal', gate: terminal.gate, duplicate: settled.duplicate };
        }
        if (Date.now() - invocationStartedAt >= invocationBudget) {
          return { status: 'pending', reason: 'invocation budget elapsed before the next read-only attempt' };
        }
        await invokeFrozenReadChild({
          ...input,
          logicalToolCallId: getterLogicalToolCallId,
          entry: getterEntry,
          args: getterArgs,
          deadlineMs: remaining(),
        });
      } catch (error) {
        const after = redeemDurableLogicalCallSettlementForHost({
          sessionId: input.sessionId,
          sourceUserSeq: input.sourceUserSeq,
          acceptedTaskId: input.acceptedTaskId,
          logicalToolCallId: getterLogicalToolCallId,
        });
        if (
          after.status === 'ok'
          && after.settlement.outcome.directive.action === 'retry_with_backoff'
        ) continue;
        return settleDefinitiveProviderChildFailure({
          ...input,
          args,
          childLogicalToolCallId: getterLogicalToolCallId,
        });
      }
    }
    const completion = recordAsyncReadRefinementCompletion({
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      acceptedTaskId: input.acceptedTaskId,
      startLogicalToolCallId: input.ownerLogicalToolCallId,
      getterLogicalToolCallId,
    });
    if (completion.status === 'held') return completion;
    if (completion.status === 'pending') continue;
    if (completion.status === 'terminal') {
      const settled = settleTerminalOwner({ ...input, args, gate: completion.gate });
      return { status: 'terminal', gate: completion.gate, duplicate: settled.duplicate };
    }
    if (completion.status !== 'recorded' && completion.status !== 'replayed') {
      return { status: 'held', reason: 'completion receipt has an unsupported state' };
    }
    const settled = settleVerifiedOwner({
      ...input,
      args,
      evidence: completion.evidence,
    });
    return {
      status: 'completed',
      evidence: completion.evidence,
      duplicate: settled.duplicate,
    };
  }
  const terminal = recordAsyncReadRefinementBudgetTerminalOutcome({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    acceptedTaskId: input.acceptedTaskId,
    startLogicalToolCallId: input.ownerLogicalToolCallId,
    kind: 'attempts_exhausted',
  });
  if (terminal.status === 'held') return terminal;
  const settled = settleTerminalOwner({ ...input, args, gate: terminal.gate });
  return { status: 'terminal', gate: terminal.gate, duplicate: settled.duplicate };
}
