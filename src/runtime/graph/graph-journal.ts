/**
 * The typed journal: what a durable graph run persists, and what a resume may
 * trust.
 *
 * The first executor slice journaled node IDs. A node-ID-only journal cannot
 * be production reuse identity — it says a name completed, not that THIS
 * admitted graph, THIS node definition, and THESE inputs completed, and it
 * cannot prove its own causal integrity after a crash. This module holds the
 * entry shape and the awaited adapter contract (the durable boundary).
 *
 * R1A extends the settlement contract with durable ROUTING evidence: the exact
 * ordered outgoing edge IDs that fired for that attempt. Replay follows those
 * durable verdicts; it never re-evaluates a present-day edge closure for
 * reused work, because a changed closure on restart must not rewrite history.
 * A patch entry is bound to the exact emitter attempt for the same reason:
 * children may exist only because a journaled attempt durably put them there.
 *
 * Entries lacking this evidence (pre-R1A journals) REFUSE at reconstruction —
 * there are no production admitted callers to protect with a permissive
 * compatibility path, and silently treating old settlements as all-success
 * would invent routing history.
 *
 * Ordered reconstruction and validation live in graph-resume.ts. Pure: types
 * and the adapter contract only. Storage lives behind the adapter, injected by
 * the caller.
 */
import type { ExecutableEdge, ExecutableGraph, ExecutableNode, NodeStatus } from './graph-executor.js';

/** The journal contract revision — minted into every admission digest; see
 *  graph-admission.ts for the version history. Re-exported here because the
 *  journal is the contract the version names. */
export { GRAPH_JOURNAL_SCHEMA_VERSION } from './graph-admission.js';

/** Why a non-completed settlement happened, for retry policy OUTSIDE the walker. */
export type SettlementClass =
  /** The node ran and its own logic failed — routes failure edges. */
  | 'node'
  /** The runner threw / infrastructure broke — never routes failure edges. */
  | 'infrastructure'
  /** Authority or policy refused the node before it could act. */
  | 'policy'
  /** The run's cancellation signal stopped it. */
  | 'cancelled';

/**
 * The activation opener (journal schema v4). One per activation, appended
 * BEFORE any claim: replay refuses a journal whose segments lack a supported
 * header, and a running executor refuses to append under an unsupported
 * version — the version lives in the DURABLE stream, not only in the
 * admission object a caller could forge.
 */
export interface RunHeaderEntry {
  type: 'run_header';
  admissionDigest: string;
  journalSchemaVersion: number;
  /** The finite activation this segment belongs to. Waves reset per segment. */
  activationId: string;
}

export interface NodeStartedEntry {
  type: 'node_started';
  admissionDigest: string;
  nodeId: string;
  nodeDigest: string;
  inputDigest: string;
  /** Unique per dispatch — a retry is a NEW attempt, never a reused row. */
  attemptId: string;
  wave: number;
}

export interface NodeSettledEntry {
  type: 'node_settled';
  admissionDigest: string;
  nodeId: string;
  nodeDigest: string;
  inputDigest: string;
  attemptId: string;
  wave: number;
  status: NodeStatus;
  outputRef?: string;
  evidenceRefs?: string[];
  reason?: string;
  settlementClass?: SettlementClass;
  /**
   * The exact ordered outgoing edge IDs that fired for THIS attempt, computed
   * once from the live outcome and persisted with the awaited settlement.
   * Live scheduling and replay both consume these IDs — durable history, not
   * today's closure, decides what fired. Empty is a verdict too: a blocked,
   * paused, or non-node-class settlement fires nothing. Completeness is part
   * of the contract: a completion must record every enabled built-in success
   * route and a node-class failure every enabled failure route — an omitted
   * route is silently deleted work, refused on replay.
   */
  firedEdgeIds: string[];
  /**
   * Present iff THIS completed settlement admitted or exactly reconciled a
   * patch: that patch's digest. The only promotion proof replay accepts — an
   * orphan patch (durable admission, emitter crashed before settling) becomes
   * real solely through a settlement carrying its exact digest, never through
   * an ordinary later completion of the same node.
   */
  emittedPatchDigest?: string;
}

export interface PatchAdmittedEntry {
  type: 'patch_admitted';
  admissionDigest: string;
  emittedBy: string;
  /**
   * The exact emitter attempt whose completion admitted this patch. Children
   * are eligible only through this binding: an orphan patch (emitter attempt
   * never durably settled) puts nothing into the resumed topology, and the
   * re-run emitter must reproduce this patch's digest or refuse.
   */
  emitterAttemptId: string;
  patchDigest: string;
  /** The FULL patch content — resume must be able to reconstruct the grown
   *  topology from the journal alone, and ids without definitions cannot. The
   *  digest lets replay refuse tampered content. */
  nodes: ExecutableNode[];
  edges: ExecutableEdge[];
}

export type GraphJournalEntry = RunHeaderEntry | NodeStartedEntry | NodeSettledEntry | PatchAdmittedEntry;

/** Bounded, printable, non-empty identifier — the shape every attempt and
 *  activation id must satisfy BEFORE it becomes durable. */
export function validDurableId(value: unknown): value is string {
  return typeof value === 'string'
    && value.trim().length > 0
    && value.length <= 128
    // eslint-disable-next-line no-control-regex
    && !/[\u0000-\u001f\u007f]/.test(value);
}

/** Wave identity: a non-negative safe integer, nothing else. */
export function validWave(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The durable boundary. `append` RESOLVES only when the entry is durable —
 * the executor awaits it before dispatching a runner (`node_started`) and
 * before letting dependents advance (`node_settled`). An adapter that lies
 * about durability re-opens the crash window this contract exists to close.
 * A rejected append is an infrastructure halt, not a node failure.
 */
export interface GraphJournalAdapter {
  append(entry: GraphJournalEntry): Promise<void>;
}
