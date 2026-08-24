/**
 * Three identities, not two.
 *
 *   acceptedTaskId     one accepted user task
 *   logicalToolCallId  one model/host tool invocation — INCLUDING a refusal
 *                      that never reached a provider
 *   physicalDispatchId one actual provider crossing, with its parent logical
 *                      call, an ordinal, and `retryOf` when it repeats one
 *
 * The middle level is the one that was missing, and its absence was hiding
 * money. `runComposioExecute` wraps an entire validation/retry/poll loop, so a
 * single identity spanning that loop covers one to three *paid* provider
 * crossings while only the final result is visible. Anything measuring "tool
 * calls" then reports one, and a comparison against a previous release cannot
 * see that the new path paid three times to answer once.
 *
 * So: nested transport wrappers reuse the LOGICAL identity and settle nothing;
 * every retry, poll, account probe and nested child dispatch takes a fresh
 * PHYSICAL id. A pre-dispatch refusal has a logical call and no physical
 * dispatch at all, which is exactly what `dispatchState: 'not_started'` means.
 *
 * Inheritance is scoped: an ambient identity belonging to a different accepted
 * task is ignored rather than adopted, because attributing task A's dispatch to
 * task B is worse than having no attribution.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import {
  admitLogicalCall,
  beginPhysicalDispatch,
  refineLogicalCallContract,
  settlePhysicalDispatch,
  type DispatchRelation,
  type LogicalCallAdmissionResult,
  type RefinedLogicalCall,
} from './dispatch-ledger.js';
import { assertExpectedWorkLogicalAdmission } from './expected-work-admission.js';
import { durableLogicalCallContract } from './logical-call-contract.js';
import type { TrustedRuntimeEffectCarrier } from './tool-effect.js';
import {
  admitSourceStrategyPhysicalDispatch,
  type PhysicalSourceCapabilityIdentityV1,
} from './source-strategy-admission.js';
import { mintCurrentRequestSourceArgumentAuthority } from './source-strategy-argument-authority.js';
import {
  assertDispatchLeaseCurrent,
  currentDispatchLease,
} from './dispatch-lease.js';

export interface LogicalCallIdentity {
  acceptedTaskId: string;
  logicalToolCallId: string;
}

export interface PhysicalDispatchIdentity extends LogicalCallIdentity {
  physicalDispatchId: string;
  /** 1-based position of this crossing within its logical call. */
  ordinal: number;
  relation?: DispatchRelation;
  /** The dispatch this one repeats, when it is a retry or a poll. */
  retryOf?: string;
}

export interface PhysicalDispatchInput {
  sessionId: string;
  sourceUserSeq: number;
  tool: string;
  args?: unknown;
  turn?: number;
  relation?: DispatchRelation;
  retryOf?: string;
  /** Host-only provenance for a wrapper peeled before this paid crossing. */
  trustedEffectCarrier?: TrustedRuntimeEffectCarrier;
  /** Exact provider/tool/account/schema identity resolved by the trusted
   * gateway. Required only when this crossing is the confirmed aggregate
   * source requirement; irrelevant reads and writes keep existing behavior. */
  sourceCapability?: PhysicalSourceCapabilityIdentityV1;
  /** Opaque proof that the source-strategy reducer already admitted these exact
   * bytes in this exact logical-call/lease frame. This is used only when an
   * adapter must perform a durable local reservation after source admission but
   * before the physical provider-start row is inserted. */
  sourceAdmissionProof?: PhysicalDispatchSourceAdmissionProof;
}

/** Public only as an opaque hand-off type. Object shape is not authority; the
 * module-private WeakMap below binds the exact minted object and consumes it
 * once at `withPhysicalDispatch`. */
export interface PhysicalDispatchSourceAdmissionProof {
  readonly version: 1;
}

export class PhysicalDispatchPreDispatchError extends Error {
  override readonly name: string = 'PhysicalDispatchPreDispatchError';
  constructor(readonly reason: string) {
    super(`Provider dispatch refused before I/O: ${reason}`);
  }
}

/** A confirmed aggregate-source binding refused this exact resolved provider
 * identity. This is a physical pre-dispatch denial: no provider-start row and
 * no network I/O exist. */
export class SourceStrategyPhysicalDispatchError extends PhysicalDispatchPreDispatchError {
  override readonly name = 'SourceStrategyPhysicalDispatchError';
  constructor(
    readonly kind: 'source_strategy_unconfirmed' | 'source_strategy_mismatch' | 'source_strategy_authority_invalid',
    reason: string,
  ) {
    super(`${kind}: ${reason}`);
  }
}

export class PhysicalDispatchSettlementError extends Error {
  override readonly name = 'PhysicalDispatchSettlementError';
  constructor(readonly reason: string) {
    super(`Provider dispatch completed but durable settlement failed: ${reason}`);
  }
}

export type LogicalCallAuthorityFailureStatus = Exclude<
  LogicalCallAdmissionResult['status'],
  'inserted' | 'replayed'
>;

/**
 * The host could not durably bind a logical invocation to its accepted task.
 * This is a pre-dispatch authority failure: no gate, adapter or provider body
 * is allowed to execute after it.
 */
export class LogicalCallPreDispatchAuthorityError extends Error {
  override readonly name = 'LogicalCallPreDispatchAuthorityError';
  constructor(
    readonly status: LogicalCallAuthorityFailureStatus,
    readonly reason: string,
  ) {
    super(`Logical tool call refused before execution (${status}): ${reason}`);
  }
}

/**
 * Derived, not random: the same accepted turn must produce the same id in every
 * process and after a restart, or durable evidence stops matching its owner.
 */
export function acceptedTaskIdFor(sessionId: string, sourceUserSeq: number): string {
  return `task:${sessionId}#${sourceUserSeq}`;
}

interface LogicalFrame extends LogicalCallIdentity {
  /** Crossings so far, so each physical dispatch gets a truthful ordinal. */
  crossings: number;
  /** The exact contract this frame was opened for. A nested call whose own
   *  contract differs is DIFFERENT WORK and may not adopt this identity. */
  toolName: string;
  argumentDigest: string;
}

const logicalStorage = new AsyncLocalStorage<LogicalFrame>();
const physicalStorage = new AsyncLocalStorage<PhysicalDispatchIdentity>();

interface PhysicalDispatchSourceAdmissionRecord {
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  logicalFrame?: LogicalFrame;
  logicalToolCallId?: string;
  dispatchLease?: ReturnType<typeof currentDispatchLease>;
  toolName: string;
  argumentDigest: string;
  capabilityKey: string;
}

const physicalSourceAdmissionProofs = new WeakMap<object, PhysicalDispatchSourceAdmissionRecord>();

function sourceCapabilityKey(capability: PhysicalSourceCapabilityIdentityV1 | undefined): string {
  return JSON.stringify([
    capability?.capabilityId ?? null,
    capability?.accountIdentity ?? null,
    capability?.schemaFingerprint ?? null,
  ]);
}

function sameDispatchLease(
  left: ReturnType<typeof currentDispatchLease>,
  right: ReturnType<typeof currentDispatchLease>,
): boolean {
  if (left === undefined || right === undefined) return left === right;
  return left.sessionId === right.sessionId
    && left.scopeId === right.scopeId
    && left.leaseId === right.leaseId
    && left.sourceUserSeq === right.sourceUserSeq
    && left.acceptedTaskId === right.acceptedTaskId
    && left.logicalToolCallId === right.logicalToolCallId;
}

function admitPhysicalSourceAtCurrentEdge(
  input: Pick<PhysicalDispatchInput, 'sessionId' | 'sourceUserSeq' | 'tool' | 'args' | 'sourceCapability'>,
  acceptedTaskId: string,
  owned: LogicalFrame | undefined,
  dispatchLease: ReturnType<typeof currentDispatchLease>,
): void {
  // A source binding proves provider/account/schema identity, not arbitrary
  // model-selected query bytes. At the resolved body edge, bind the exact
  // provider-ready contract to this open logical row and current call lease.
  const sourceArgumentAuthority = input.sourceCapability && owned && dispatchLease
    ? mintCurrentRequestSourceArgumentAuthority({
        sessionId: input.sessionId,
        sourceUserSeq: input.sourceUserSeq,
        acceptedTaskId,
        logicalToolCallId: owned.logicalToolCallId,
        tool: input.tool,
        args: input.args,
        lease: dispatchLease,
      })
    : null;

  const sourceAdmission = admitSourceStrategyPhysicalDispatch({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    ...(input.sourceCapability ? { capability: input.sourceCapability } : {}),
    tool: input.tool,
    args: input.args,
    ...(sourceArgumentAuthority ? { argumentAuthority: sourceArgumentAuthority } : {}),
  });
  if (sourceAdmission.status === 'refused') {
    throw new SourceStrategyPhysicalDispatchError(sourceAdmission.kind, sourceAdmission.message);
  }
}

/**
 * Admit source strategy before an adapter's irreversible local reservation.
 *
 * The returned proof is exact-call, exact-lease, exact-provider-ready-args and
 * one-shot. A copied/lookalike object, a changed argument/capability, a different
 * logical frame, or a revoked/replaced lease cannot authorize the later body.
 */
export function preflightPhysicalDispatchSourceAdmission(
  input: Omit<PhysicalDispatchInput, 'sourceAdmissionProof'>,
): PhysicalDispatchSourceAdmissionProof {
  const acceptedTaskId = acceptedTaskIdFor(input.sessionId, input.sourceUserSeq);
  const dispatchLease = currentDispatchLease();
  assertDispatchLeaseCurrent(dispatchLease);
  const frame = logicalStorage.getStore();
  const owned = frame && frame.acceptedTaskId === acceptedTaskId ? frame : undefined;
  const contract = durableLogicalCallContract(acceptedTaskId, input.tool, input.args);
  if (!contract) {
    throw new PhysicalDispatchPreDispatchError('source admission input is not a durable logical contract');
  }
  admitPhysicalSourceAtCurrentEdge(input, acceptedTaskId, owned, dispatchLease);
  const proof = Object.freeze({ version: 1 as const });
  physicalSourceAdmissionProofs.set(proof, {
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    acceptedTaskId,
    ...(owned ? { logicalFrame: owned, logicalToolCallId: owned.logicalToolCallId } : {}),
    ...(dispatchLease ? { dispatchLease } : {}),
    toolName: contract.toolName,
    argumentDigest: contract.argumentDigest,
    capabilityKey: sourceCapabilityKey(input.sourceCapability),
  });
  return proof;
}

function consumePhysicalDispatchSourceAdmissionProof(
  proof: PhysicalDispatchSourceAdmissionProof,
  input: PhysicalDispatchInput,
  acceptedTaskId: string,
  owned: LogicalFrame | undefined,
  dispatchLease: ReturnType<typeof currentDispatchLease>,
): void {
  const record = physicalSourceAdmissionProofs.get(proof as object);
  physicalSourceAdmissionProofs.delete(proof as object);
  const contract = durableLogicalCallContract(acceptedTaskId, input.tool, input.args);
  if (
    !record
    || record.sessionId !== input.sessionId
    || record.sourceUserSeq !== input.sourceUserSeq
    || record.acceptedTaskId !== acceptedTaskId
    || record.logicalFrame !== owned
    || record.logicalToolCallId !== owned?.logicalToolCallId
    || !sameDispatchLease(record.dispatchLease, dispatchLease)
    || !contract
    || record.toolName !== contract.toolName
    || record.argumentDigest !== contract.argumentDigest
    || record.capabilityKey !== sourceCapabilityKey(input.sourceCapability)
  ) {
    throw new SourceStrategyPhysicalDispatchError(
      'source_strategy_authority_invalid',
      'physical source admission proof is absent, consumed, or does not own this exact call and lease. No provider call was started.',
    );
  }
}

export function currentLogicalCall(): LogicalCallIdentity | undefined {
  const frame = logicalStorage.getStore();
  if (!frame) return undefined;
  return { acceptedTaskId: frame.acceptedTaskId, logicalToolCallId: frame.logicalToolCallId };
}

export function currentPhysicalDispatch(): PhysicalDispatchIdentity | undefined {
  return physicalStorage.getStore();
}

/**
 * Trusted host-resolver seam for a semantic raw -> provider-ready rewrite.
 *
 * Callers cannot nominate a logical id: the exact accepted-task frame is read
 * from AsyncLocalStorage, then the durable ledger proves it still owns an open,
 * zero-crossing call. This API is intentionally not exposed as a model tool.
 */
export function authorizeResolvedLogicalCallContract(input: {
  sessionId: string;
  sourceUserSeq: number;
  tool: string;
  effectiveArgs?: unknown;
  turn?: number;
}): RefinedLogicalCall | null {
  const acceptedTaskId = acceptedTaskIdFor(input.sessionId, input.sourceUserSeq);
  const frame = logicalStorage.getStore();
  if (!frame || frame.acceptedTaskId !== acceptedTaskId) {
    throw new LogicalCallPreDispatchAuthorityError(
      'missing',
      'trusted resolver has no logical call owned by this accepted task',
    );
  }
  // A resolver may only refine the frame ITS OWN call opened. When a local
  // tool executes a provider action, the ambient frame belongs to the caller,
  // and refining it to the inner tool is not a rewrite the ledger can accept —
  // it POISONS the caller's logical row and takes the whole step down. That is
  // the live platform-49 failure: a nested Composio dispatch inside a local
  // orchestrator tool refined its caller's frame and killed the run six times
  // a day. Nothing to refine is not a failure; the nested call opens its own
  // logical identity moments later.
  const resolvedContract = durableLogicalCallContract(
    acceptedTaskId,
    input.tool,
    input.effectiveArgs,
  );
  if (!resolvedContract || resolvedContract.toolName !== frame.toolName) return null;
  const refinement = refineLogicalCallContract({
    identity: {
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      acceptedTaskId,
      logicalToolCallId: frame.logicalToolCallId,
    },
    tool: input.tool,
    effectiveArgs: input.effectiveArgs,
    turn: input.turn,
  });
  if (refinement.status !== 'refined' && refinement.status !== 'replayed') {
    throw new LogicalCallPreDispatchAuthorityError(refinement.status, refinement.reason);
  }
  // Refinement changes the identity this exact open call owns. Keep the
  // already-proven ambient frame on the same canonical contract as its durable
  // row so a provider adapter re-entering with those resolved bytes inherits
  // the original logical id (and its frozen-work binding) instead of minting
  // an unbound child. Foreign resolvers returned above without touching it.
  frame.toolName = refinement.identity.toolName;
  frame.argumentDigest = refinement.identity.argumentDigest;
  return refinement.identity;
}

/**
 * Open one logical tool call.
 *
 * A nested transport wrapper inherits rather than opening a second call — one
 * model invocation is one logical call however many layers wrap it. An ambient
 * frame owned by a DIFFERENT accepted task is not inherited.
 */
export function withLogicalToolCall<T>(
  input: {
    sessionId: string;
    sourceUserSeq: number;
    /** Trusted host-visible tool identity at this invocation boundary. */
    tool: string;
    /** Complete host-visible arguments; values are digested, never persisted. */
    args?: unknown;
    /** Host-only provenance for a trusted wrapper peeled to this exact call. */
    trustedEffectCarrier?: TrustedRuntimeEffectCarrier;
    /**
     * The host invocation id when one already exists (SDK call id, nested-dispatch
     * child id, batch item id).  A nested carrier that supplies the SAME id
     * inherits the ambient call; a genuinely different host invocation opens
     * a new logical call even when it runs beneath a parent tool.
     */
    logicalToolCallId?: string;
  },
  work: (identity: LogicalCallIdentity) => T,
): T {
  const acceptedTaskId = acceptedTaskIdFor(input.sessionId, input.sourceUserSeq);
  const inherited = logicalStorage.getStore();
  const requested = typeof input.logicalToolCallId === 'string'
    && input.logicalToolCallId.trim().length > 0
    && input.logicalToolCallId.length <= 512
    ? input.logicalToolCallId.trim()
    : undefined;
  // A nested wrapper re-entering the SAME call inherits; genuinely different
  // work does not. Adopting a parent's identity re-admits and later SETTLES the
  // parent's logical row under the child's contract, which poisons the parent
  // and takes the whole turn down with it — a live scheduled workflow failed
  // this way six times a day (platform-49, 2026-08-11: a local orchestrator
  // tool whose inner provider action wore its caller's identity).
  const ownContract = durableLogicalCallContract(acceptedTaskId, input.tool, input.args);
  const sameWorkAsInherited = inherited !== undefined
    && ownContract !== null
    && inherited.toolName === ownContract.toolName
    && inherited.argumentDigest === ownContract.argumentDigest;
  if (
    inherited
    && inherited.acceptedTaskId === acceptedTaskId
    && (requested === inherited.logicalToolCallId
      || (requested === undefined && sameWorkAsInherited))
  ) {
    const identity = {
      acceptedTaskId: inherited.acceptedTaskId,
      logicalToolCallId: inherited.logicalToolCallId,
    };
    assertExpectedWorkLogicalAdmission({
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      logicalToolCallId: identity.logicalToolCallId,
      tool: input.tool,
      args: input.args,
      trustedEffectCarrier: input.trustedEffectCarrier,
    });
    const admission = admitLogicalCall({
      identity: { ...identity, sessionId: input.sessionId, sourceUserSeq: input.sourceUserSeq },
      tool: input.tool,
      args: input.args,
    });
    if (admission.status !== 'inserted' && admission.status !== 'replayed') {
      throw new LogicalCallPreDispatchAuthorityError(admission.status, admission.reason);
    }
    return work(identity);
  }
  const frame: LogicalFrame = {
    acceptedTaskId,
    logicalToolCallId: requested ?? `call:${randomUUID()}`,
    crossings: 0,
    toolName: ownContract?.toolName ?? input.tool,
    argumentDigest: ownContract?.argumentDigest ?? '',
  };
  // A child of an admitted parent is work that parent is already authorized to
  // do, so the WALL still asks about the authorizing identity. Only the LEDGER
  // changes: the child records its own contract instead of overwriting its
  // parent's. Splitting the identity without splitting the question keeps every
  // existing admission verdict exactly as it was.
  assertExpectedWorkLogicalAdmission({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    logicalToolCallId: frame.logicalToolCallId,
    ...(inherited && inherited.acceptedTaskId === acceptedTaskId
      ? { fallbackLogicalToolCallId: inherited.logicalToolCallId }
      : {}),
    tool: input.tool,
    args: input.args,
    trustedEffectCarrier: input.trustedEffectCarrier,
  });
  const admission = admitLogicalCall({
    identity: {
      sessionId: input.sessionId,
      sourceUserSeq: input.sourceUserSeq,
      acceptedTaskId: frame.acceptedTaskId,
      logicalToolCallId: frame.logicalToolCallId,
    },
    tool: input.tool,
    args: input.args,
  });
  if (admission.status !== 'inserted' && admission.status !== 'replayed') {
    throw new LogicalCallPreDispatchAuthorityError(admission.status, admission.reason);
  }
  return logicalStorage.run(frame, () => work({
    acceptedTaskId: frame.acceptedTaskId,
    logicalToolCallId: frame.logicalToolCallId,
  }));
}

/**
 * Open one physical provider crossing inside the current logical call.
 *
 * Always mints: a retry, a poll and an account probe are each a separate thing
 * the account was charged for, and collapsing them is how paid work disappears
 * from a comparison.
 */
export async function withPhysicalDispatch<T>(
  input: PhysicalDispatchInput,
  work: (identity: PhysicalDispatchIdentity) => Promise<T>,
): Promise<T> {
  const acceptedTaskId = acceptedTaskIdFor(input.sessionId, input.sourceUserSeq);
  const dispatchLease = currentDispatchLease();
  const frame = logicalStorage.getStore();
  const owned = frame && frame.acceptedTaskId === acceptedTaskId ? frame : undefined;

  // The provider adapter has finished resolving the actual slug/account/schema
  // at this point, but no paid-crossing authority has been inserted yet. Apply
  // the one durable source-selection gate here so Claude/Codex, Composio/native
  // MCP, resume, and fallover cannot acquire different opinions downstream.
  if (input.sourceAdmissionProof) {
    consumePhysicalDispatchSourceAdmissionProof(
      input.sourceAdmissionProof,
      input,
      acceptedTaskId,
      owned,
      dispatchLease,
    );
  } else {
    admitPhysicalSourceAtCurrentEdge(input, acceptedTaskId, owned, dispatchLease);
  }
  if (owned) owned.crossings += 1;

  const proposed: PhysicalDispatchIdentity = {
    acceptedTaskId,
    logicalToolCallId: owned?.logicalToolCallId ?? `call:${randomUUID()}`,
    physicalDispatchId: `dispatch:${randomUUID()}`,
    ordinal: owned?.crossings ?? 1,
    ...(input.retryOf ? { retryOf: input.retryOf } : {}),
  };
  const proposedCrossing = {
    ...proposed,
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
  };

  // This INSERT is authority, not best-effort telemetry. Only a newly inserted
  // row permits control to leave for the provider; replaying a start must not
  // repeat a paid call.
  const admission = beginPhysicalDispatch({
    identity: proposedCrossing,
    tool: input.tool,
    args: input.args,
    turn: input.turn,
    relation: input.relation,
    trustedEffectCarrier: input.trustedEffectCarrier,
  });
  if (admission.status !== 'inserted') {
    throw new PhysicalDispatchPreDispatchError(
      'reason' in admission ? admission.reason : `dispatch start was ${admission.status}`,
    );
  }
  const identity: PhysicalDispatchIdentity = admission.identity;
  const crossing = { ...identity, sessionId: input.sessionId, sourceUserSeq: input.sourceUserSeq };

  return physicalStorage.run(identity, async () => {
    let result: T;
    try {
      result = await work(identity);
    } catch (error) {
      // A host stop revokes this generation before recovery. The detached body
      // must then leave terminalization to the exact-generation CAS instead of
      // upgrading a timed_out/cancelled/unknown row to `threw` later.
      assertDispatchLeaseCurrent(dispatchLease);
      const settled = settlePhysicalDispatch({
        identity: crossing,
        tool: input.tool,
        outcome: 'threw',
        turn: input.turn,
        dispatchLease,
      });
      if (settled.status !== 'inserted' && settled.status !== 'replayed') {
        throw new PhysicalDispatchSettlementError(
          settled.reason,
        );
      }
      throw error;
    }
    assertDispatchLeaseCurrent(dispatchLease);
    const settled = settlePhysicalDispatch({
      identity: crossing,
      tool: input.tool,
      outcome: 'returned',
      turn: input.turn,
      dispatchLease,
    });
    if (settled.status !== 'inserted' && settled.status !== 'replayed') {
      throw new PhysicalDispatchSettlementError(settled.reason);
    }
    return result;
  });
}

/**
 * The identity a settlement should be attributed to, for a given task.
 *
 * Returns undefined when the ambient frame belongs to another accepted task —
 * letting task A's dispatch settle against task B would corrupt both ledgers.
 */
export function settlementIdentityFor(
  sessionId: string,
  sourceUserSeq: number,
): { acceptedTaskId: string; logicalToolCallId: string; physicalDispatchId?: string } | undefined {
  const acceptedTaskId = acceptedTaskIdFor(sessionId, sourceUserSeq);
  const physical = physicalStorage.getStore();
  if (physical && physical.acceptedTaskId === acceptedTaskId) return physical;
  const logical = logicalStorage.getStore();
  if (logical && logical.acceptedTaskId === acceptedTaskId) {
    return { acceptedTaskId, logicalToolCallId: logical.logicalToolCallId };
  }
  return undefined;
}
