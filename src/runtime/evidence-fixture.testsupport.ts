/**
 * The authoritative evidence fixture.
 *
 * Test support only — nothing in the production tree imports this, and the
 * filename deliberately does not match the `*.test.ts` collection glob.
 *
 * A fixture is only worth as much as the authority that accepts it. Two ways to
 * get that wrong, both of which this file exists to avoid:
 *
 *  1. Fabricated identity. `graphId: 'g'`, `nodeId: 'n2:external_write'` — no
 *     such node exists. In a real compiled chat graph `n2` is
 *     `intent_authority`, and `external_write` is an EFFECT, not a node kind.
 *     So the chain here records the real shadow graph, refines the one
 *     unresolved `execute` node into the operations that actually ran, and
 *     compiles a validated manifest whose node and obligation ids are real.
 *  2. Self-asserted meaning. A parented occurrence proves where bytes came
 *     from, never what they mean; `{"matches": true}` is a label, not a
 *     comparison. So every obligation here is proved by a host-issued receipt
 *     that computes its own verdict from the bytes.
 *
 * `assertRedeemable` and `buildEvidenceChain` both refuse to return anything the
 * real authority would not honour, so a fixture bug fails loudly instead of
 * quietly manufacturing a green positive case.
 */
import { randomUUID } from 'node:crypto';
import {
  appendEvent,
  createSession,
  writeToolOutput,
  resolveToolOutputForAuthority,
  type EventRow,
} from './harness/eventlog.js';
import { recordTurnGraphShadow } from './graph/turn-graph-shadow.js';
import {
  recordResolvedOperation,
  finalizeResolution,
} from './harness/resolution-ledger.js';
import {
  compileObligationManifest,
  type ObligationManifest,
} from './harness/obligation-manifest.js';
import {
  persistObligationManifest,
  satisfyDeclaredObligation,
} from './harness/obligation-store.js';
import {
  issueCollectionReceipt,
  issueDerivationReceipt,
  issueCommitReceipt,
  issueReadbackReceipt,
  issueReconciliationReceipt,
  issueSendReceipt,
  type EvidenceReceiptIdentity,
} from './harness/evidence-receipts.js';

export interface AcceptedTask {
  sessionId: string;
  sourceUserSeq: number;
  turn: number;
}

export interface AuthoritativeEvidence {
  callId: string;
  tool: string;
  effect: string;
  physicalAttemptId: string;
  call: EventRow;
  returned: EventRow;
}

/** The single unresolved node every chat turn compiles to. */
export const EXECUTE_NODE = 'n5:execute';
export const READ_OP = 'read';
export const WRITE_OP = 'write';
export const READ_CHILD = `${EXECUTE_NODE}/${READ_OP}`;
export const WRITE_CHILD = `${EXECUTE_NODE}/${WRITE_OP}`;

let counter = 0;

export function acceptTask(label: string, text?: string): AcceptedTask {
  const session = createSession({ id: `ev-${label}-${++counter}`, kind: 'chat' });
  const source = appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: text ?? 'read the alpha source and write every record into the beta sink' },
  });
  return { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 };
}

export interface OccurrenceOptions {
  callId?: string;
  tool?: string;
  effect?: 'read' | 'write' | 'send' | 'compute';
  output?: unknown;
  physicalAttemptId?: string;
  /** Deliberate corruptions, for the negative cases. */
  omitInvocationNonce?: boolean;
  unparentReturn?: boolean;
  mismatchReturnTool?: boolean;
  duplicateInvocationRow?: boolean;
  sourceUserSeqOverride?: number;
}

/** One real parented tool occurrence, written the way dispatch writes it. */
export function recordOccurrence(
  task: AcceptedTask,
  options: OccurrenceOptions = {},
): AuthoritativeEvidence {
  const callId = options.callId ?? `call-${randomUUID()}`;
  const tool = options.tool ?? 'alpha__list_records';
  const effect = options.effect ?? 'read';
  const physicalAttemptId = options.physicalAttemptId ?? `attempt-${randomUUID()}`;
  const sourceUserSeq = options.sourceUserSeqOverride ?? task.sourceUserSeq;
  const output = JSON.stringify(options.output ?? { records: [{ id: 'r1' }], complete: true });

  const call = appendEvent({
    sessionId: task.sessionId,
    turn: task.turn,
    role: 'assistant',
    type: 'tool_called',
    data: { callId, tool, effect, effectiveTool: tool, sourceUserSeq, physicalAttemptId },
  });

  writeToolOutput({
    sessionId: task.sessionId,
    callId,
    tool,
    output,
    ...(options.omitInvocationNonce ? {} : { invocationNonce: randomUUID() }),
  });
  if (options.duplicateInvocationRow) {
    writeToolOutput({
      sessionId: task.sessionId, callId, tool, output, invocationNonce: randomUUID(),
    });
  }

  const returned = appendEvent({
    sessionId: task.sessionId,
    turn: task.turn,
    role: 'tool',
    type: 'tool_returned',
    ...(options.unparentReturn ? {} : { parentEventId: call.id }),
    data: {
      callId,
      tool: options.mismatchReturnTool ? `${tool}__other` : tool,
      effect,
      effectiveTool: options.mismatchReturnTool ? `${tool}__other` : tool,
      sourceUserSeq,
      physicalAttemptId,
      ok: true,
    },
  });

  return { callId, tool, effect, physicalAttemptId, call, returned };
}

export function assertRedeemable(task: AcceptedTask, evidence: AuthoritativeEvidence): void {
  const resolution = resolveToolOutputForAuthority(task.sessionId, evidence.callId);
  if (resolution.status !== 'ok') {
    throw new Error(
      `fixture is not authoritative: resolveToolOutputForAuthority returned '${resolution.status}' `
      + `for ${evidence.callId} (${JSON.stringify(resolution)})`,
    );
  }
  const bound = (resolution as { sourceUserSeq?: number | null }).sourceUserSeq;
  if (bound !== task.sourceUserSeq) {
    throw new Error(`fixture evidence is bound to source ${bound}, not ${task.sourceUserSeq}`);
  }
}

export function redeemableOccurrence(
  task: AcceptedTask,
  options: OccurrenceOptions = {},
): AuthoritativeEvidence {
  const evidence = recordOccurrence(task, options);
  assertRedeemable(task, evidence);
  return evidence;
}

// ── The real authority chain ─────────────────────────────────────────────────

export interface EvidenceChain {
  task: AcceptedTask;
  manifest: ObligationManifest;
  /** Receipt id per obligation, keyed `${nodeId}|${obligation}`. */
  receipts: Map<string, string>;
  /** Physical attempt per obligation, keyed the same way. */
  attempts: Map<string, string>;
  /** Every declared obligation, in dependency-safe order. */
  order: Array<{ nodeId: string; obligation: string }>;
}

/**
 * Supply a proof that was omitted, on the SAME accepted task.
 *
 * Repair has to happen against the manifest already in force — building a
 * second chain would prove that a fresh task can succeed, which was never in
 * doubt, rather than that this one can be completed.
 */
export function proveObligation(
  chain: EvidenceChain,
  obligation: string,
): { ok: boolean; reason?: string } {
  const task = chain.task;
  const identityFor = (evidence: AuthoritativeEvidence): EvidenceReceiptIdentity => ({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    physicalAttemptId: evidence.physicalAttemptId,
    callId: evidence.callId,
    tool: evidence.tool,
    effect: evidence.effect,
  });
  const derived = { rows: [{ id: 'r1' }, { id: 'r2' }] };

  let evidence: AuthoritativeEvidence;
  let issued: { receiptId?: string; error?: string };
  switch (obligation) {
    case 'verify_committed_readback':
      evidence = redeemableOccurrence(task, { tool: 'beta__read_rows', effect: 'read', output: derived });
      issued = issueReadbackReceipt({
        identity: identityFor(evidence), expected: derived, observed: derived, target: 'beta:sink-1',
      });
      break;
    case 'stale_destination_reconciled':
      evidence = redeemableOccurrence(task, { tool: 'beta__read_rows', effect: 'read', output: derived });
      issued = issueReconciliationReceipt({
        identity: identityFor(evidence),
        before: { rows: [] }, after: derived, staleRemaining: 0, target: 'beta:sink-1',
      });
      break;
    default:
      return { ok: false, reason: `no repair path for '${obligation}'` };
  }
  if (!issued.receiptId) return { ok: false, reason: issued.error };

  const outcome = satisfyDeclaredObligation({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    manifestId: chain.manifest.manifestId,
    nodeId: WRITE_CHILD,
    obligation,
    receiptId: issued.receiptId,
    physicalAttemptId: evidence.physicalAttemptId,
  });
  if (outcome.ok) {
    chain.receipts.set(`${WRITE_CHILD}|${obligation}`, issued.receiptId);
    chain.attempts.set(`${WRITE_CHILD}|${obligation}`, evidence.physicalAttemptId);
    chain.order.push({ nodeId: WRITE_CHILD, obligation });
  }
  return outcome.ok ? { ok: true } : { ok: false, reason: outcome.reason };
}

export interface BuildChainOptions {
  label: string;
  /** 'reversible' owes a read-back; 'irreversible' owes a provider receipt. */
  writeMode?: 'reversible' | 'irreversible';
  /** Skip issuing/satisfying exactly one obligation, for omission cases. */
  omit?: string;
  /** Stop after persisting the manifest; satisfy nothing. */
  manifestOnly?: boolean;
}

/**
 * Record the real graph, refine it, persist the manifest, then prove each
 * obligation with a host-issued receipt.
 *
 * The chat graph compiles to ONE `execute` node with `effect: unknown`, so a
 * source-to-sink turn has no separate node to carry completeness. Resolution
 * emits one child per operation actually performed — which is also what makes
 * the read and the write provable independently.
 */
export function buildEvidenceChain(options: BuildChainOptions): EvidenceChain {
  const irreversible = options.writeMode === 'irreversible';
  const task = acceptTask(
    options.label,
    irreversible
      ? 'read the alpha source and send every record to the beta recipients'
      : 'read the alpha source and write every record into the beta sink',
  );

  const shadow = recordTurnGraphShadow({
    identity: { sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq, turn: task.turn },
  });
  if (!shadow) throw new Error('fixture: the shadow graph was not recorded');
  const graph = (shadow.data as Record<string, unknown>).graph as never;

  // The COMPLETE set of operations this node resolved into. Effects are derived
  // from each capability by the shared taxonomy, never asserted here.
  const resolutions = [{
    nodeId: EXECUTE_NODE,
    operations: [
      { operationId: READ_OP, resolvedTool: 'alpha_records_search' },
      {
        operationId: WRITE_OP,
        resolvedTool: irreversible ? 'alpha_records_send' : 'alpha_records_replace',
      },
    ],
  }];

  // Emit the resolution as DURABLE FACTS the way the dispatch seam does, then
  // close it explicitly. A caller array is not authority.
  for (const resolution of resolutions) {
    for (const operation of resolution.operations) {
      recordResolvedOperation({
        sessionId: task.sessionId,
        sourceUserSeq: task.sourceUserSeq,
        turn: task.turn,
        nodeId: resolution.nodeId,
        operationId: operation.operationId,
        resolvedTool: operation.resolvedTool,
        logicalToolCallId: `call:${operation.operationId}`,
      });
    }
  }
  finalizeResolution({
    sessionId: task.sessionId, sourceUserSeq: task.sourceUserSeq, turn: task.turn,
  });

  const compiled = compileObligationManifest({ graph });
  if (!compiled.validation.ok) {
    throw new Error(`fixture: manifest invalid — ${compiled.validation.errors.join('; ')}`);
  }
  if (!persistObligationManifest(compiled.manifest)) {
    throw new Error('fixture: the manifest was not persisted');
  }

  const chain: EvidenceChain = {
    task,
    manifest: compiled.manifest,
    receipts: new Map(),
    attempts: new Map(),
    order: [],
  };
  if (options.manifestOnly) return chain;

  const records = [{ id: 'r1' }, { id: 'r2' }];
  const identities = records.map((record) => record.id);
  const derived = { rows: records };

  const identityFor = (
    evidence: AuthoritativeEvidence,
  ): EvidenceReceiptIdentity => ({
    sessionId: task.sessionId,
    sourceUserSeq: task.sourceUserSeq,
    physicalAttemptId: evidence.physicalAttemptId,
    callId: evidence.callId,
    tool: evidence.tool,
    effect: evidence.effect,
  });

  const prove = (
    nodeId: string,
    obligation: string,
    evidence: AuthoritativeEvidence,
    issued: { receiptId?: string; error?: string },
  ): void => {
    if (options.omit === obligation) return;
    if (!issued.receiptId) {
      throw new Error(`fixture: ${obligation} receipt was refused — ${issued.error}`);
    }
    const outcome = satisfyDeclaredObligation({
      sessionId: task.sessionId,
      sourceUserSeq: task.sourceUserSeq,
      manifestId: compiled.manifest.manifestId,
      nodeId,
      obligation,
      receiptId: issued.receiptId,
      physicalAttemptId: evidence.physicalAttemptId,
    });
    if (!outcome.ok) {
      throw new Error(`fixture: ${obligation} was not satisfied — ${outcome.reason}`);
    }
    chain.receipts.set(`${nodeId}|${obligation}`, issued.receiptId);
    chain.attempts.set(`${nodeId}|${obligation}`, evidence.physicalAttemptId);
    chain.order.push({ nodeId, obligation });
  };

  // Read: a complete collection.
  const readEvidence = redeemableOccurrence(task, {
    tool: 'alpha__list_records', effect: 'read',
    output: { records, complete: true },
  });
  const collection = issueCollectionReceipt({
    identity: identityFor(readEvidence),
    recordIdentities: identities,
    continuationOutstanding: false,
  });
  prove(READ_CHILD, 'source_completeness', readEvidence, collection);

  // Write: derivation, commit, then the verification its effect allows.
  const deriveEvidence = redeemableOccurrence(task, {
    tool: 'alpha__list_records', effect: 'read',
    output: { records, complete: true },
  });
  if (collection.receiptId) {
    prove(WRITE_CHILD, 'derivation_from_current_source', deriveEvidence, issueDerivationReceipt({
      identity: identityFor(deriveEvidence),
      sourceReceiptId: collection.receiptId,
      output: derived,
    }));
  }

  const commitCallId = `call-commit-${randomUUID()}`;
  appendEvent({
    sessionId: task.sessionId, turn: task.turn, role: 'system',
    type: 'external_write_succeeded',
    data: { canonicalCallId: commitCallId, target: 'beta:sink-1' },
  });
  const commitEvidence = redeemableOccurrence(task, {
    callId: commitCallId,
    tool: irreversible ? 'alpha_records_send' : 'alpha_records_replace',
    effect: 'write',
    output: { successful: true, receipt: 'provider-rcpt-1' },
  });
  prove(WRITE_CHILD, 'commit_effect', commitEvidence, issueCommitReceipt({
    identity: identityFor(commitEvidence),
    ledgerRef: commitCallId,
    target: 'beta:sink-1',
  }));

  if (irreversible) {
    prove(WRITE_CHILD, 'verify_committed_receipt', commitEvidence, issueSendReceipt({
      identity: identityFor(commitEvidence),
      providerReceiptId: 'provider-rcpt-1',
      target: 'beta:sink-1',
    }));
  } else {
    const readbackEvidence = redeemableOccurrence(task, {
      tool: 'beta__read_rows', effect: 'read', output: derived,
    });
    prove(WRITE_CHILD, 'verify_committed_readback', readbackEvidence, issueReadbackReceipt({
      identity: identityFor(readbackEvidence),
      expected: derived, observed: derived, target: 'beta:sink-1',
    }));

    const reconcileEvidence = redeemableOccurrence(task, {
      tool: 'beta__read_rows', effect: 'read', output: derived,
    });
    prove(WRITE_CHILD, 'stale_destination_reconciled', reconcileEvidence, issueReconciliationReceipt({
      identity: identityFor(reconcileEvidence),
      before: { rows: [] }, after: derived, staleRemaining: 0, target: 'beta:sink-1',
    }));
  }

  return chain;
}
