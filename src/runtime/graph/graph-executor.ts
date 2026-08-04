/**
 * The graph executor: the drive loop both lanes were missing.
 *
 * Measured at v3.6.3, no graph executor existed anywhere. The chat turn graph
 * was compiled and observed from four call sites that discarded its result, and
 * the workflow graph was topology that branches inside an 11k-line runner
 * interpreted. Readiness — "what can run next?" — was already extracted and
 * already decided by the graph. What was missing was the small piece that
 * repeatedly asks readiness, dispatches, records, and advances until terminal.
 *
 * Three constraints shape this module, and each one is a thing it deliberately
 * does NOT do:
 *
 *   1. It does not know what a node IS. `kind` is an opaque string handed to a
 *      runner. Enumerating node kinds here would make the harness the ceiling
 *      on what Clementine can do, which is the failure this whole direction
 *      exists to remove. New capability arrives as new runners and new emitted
 *      topology, never as a new branch in this file.
 *   2. It does not perform effects, resolve capability, assemble context, or
 *      own policy. Those are nodes. An executor that grows those becomes the
 *      next mega-loop. Time, durability, and terminal judgment are INJECTED
 *      ports (clock, journal adapter, terminal reducer) for the same reason.
 *   3. It does not decide structural validity. Compilers and validators reject
 *      cycles and dangling edges at admission; a definition that cannot
 *      progress surfaces here as an explicit stall naming what is waiting,
 *      never as a throw from inside the loop or as an infinite spin.
 *
 * Failure is an edge, not an exception. A node whose OWN logic fails routes
 * along its `failure` edges. A runner that THROWS is not node logic — it is
 * infrastructure — and infrastructure never routes recovery topology, because
 * a crashed harness is not evidence about the work.
 *
 * Two operating modes share one loop:
 *
 *   - PURE WALKER: no admission. Optional limits, node-id journal, sync-ish
 *     use in tests and differential proofs. This mode may not be a production
 *     caller's shape.
 *   - ADMITTED RUN: a `GraphAdmission` binds content-addressed identity, every
 *     budget is finite, a durable journal adapter is mandatory, `node_started`
 *     is durable BEFORE dispatch, settlement is durable BEFORE dependents
 *     advance, and resume trusts only a causally validated journal whose node
 *     and input digests match. Node ID alone is never reuse identity here.
 */
import {
  computeInputDigest,
  computeNodeDigest,
  validateGraphPatch,
  type GraphAdmission,
  type GraphPatch,
} from './graph-admission.js';
import {
  validateJournalForResume,
  type GraphJournalAdapter,
  type GraphJournalEntry,
  type NodeSettledEntry,
  type SettlementClass,
} from './graph-journal.js';

/** A node the executor schedules. `kind` is meaningful only to the runner. */
export interface ExecutableNode {
  id: string;
  kind: string;
  /**
   * How incoming edges combine. Default 'all' — a join is a rendezvous, the
   * workflow engine's exact semantics. 'any' fires on the FIRST satisfied
   * incoming edge, which is what a branch-merge needs: two verdict routes
   * converging on one publish node, exactly one of which fires per run.
   * Declared per-node and explicit, never inferred — an implicit OR is how a
   * rendezvous silently becomes a race.
   */
  joinMode?: 'all' | 'any';
}

/**
 * Edge conditions the executor understands.
 *
 * `success` is the default and the only one that fires on completion.
 * `failure` fires when the source node's own logic failed, which is what makes
 * recovery expressible as topology. Any other label is opaque: the runner
 * decides, and an unrecognized label with no runner opinion never fires — a
 * condition nobody can evaluate must not silently behave like an
 * unconditional edge.
 */
export type ExecutableEdgeCondition = 'success' | 'failure' | (string & {});

export interface ExecutableEdge {
  id: string;
  source: string;
  target: string;
  when?: ExecutableEdgeCondition;
  disabled?: boolean;
}

export interface ExecutableGraph {
  graphId: string;
  nodes: readonly ExecutableNode[];
  edges: readonly ExecutableEdge[];
}

export type NodeStatus = 'completed' | 'failed' | 'blocked' | 'paused' | 'cancelled';

export type NodeOutcome =
  | {
      status: 'completed';
      outputRef?: string;
      evidenceRefs?: string[];
      /** Topology this completion emits — per-item siblings and their reducer,
       *  produced AFTER the canonical item manifest exists. Validated,
       *  authority-checked, budget-debited, and durable before any child
       *  starts. An invalid emission fails the EMITTER as node logic. */
      emitPatch?: { nodes: ExecutableNode[]; edges: ExecutableEdge[] };
    }
  /** Ran and did not succeed. `settlementClass` defaults to 'node'; an
   *  'infrastructure' failure never routes failure edges. */
  | { status: 'failed'; reason: string; settlementClass?: SettlementClass }
  /** Cannot run at all (missing authority/capability). Never routes. */
  | { status: 'blocked'; reason: string }
  /** Awaiting input, approval, or budget. Halts the run for later resume. */
  | { status: 'paused'; reason: string };

export interface PredecessorRef {
  nodeId: string;
  outputRef?: string;
  evidenceRefs?: readonly string[];
}

export interface NodeRunContext {
  graphId: string;
  /** Ids completed before this node, including those restored from a journal. */
  completed: readonly string[];
  /**
   * The fired predecessors of THIS node with their settled artifact refs —
   * typed data flow without raw payload injection. A journal-reused
   * predecessor contributes the refs its settlement recorded.
   */
  predecessors: readonly PredecessorRef[];
  /** 0-based scheduling wave, for telemetry and trace stability. */
  wave: number;
}

export interface NodeRunner {
  run(node: ExecutableNode, context: NodeRunContext): Promise<NodeOutcome> | NodeOutcome;
  /**
   * Decide a non-`success`/`failure` edge condition. Returning undefined leaves
   * the edge unfired, so an unknown condition fails closed.
   */
  edgeSatisfied?(edge: ExecutableEdge, outcome: NodeOutcome): boolean | undefined;
}

/** One recorded step. The ordered list of these is the run's replay identity. */
export interface GraphTraceEntry {
  wave: number;
  nodeId: string;
  kind: string;
  status: NodeStatus;
  /** Present when the node was restored from a journal rather than run. */
  reused?: true;
  reason?: string;
}

export interface GraphRunBudget {
  /** Hard ceiling on dispatched nodes. A runaway graph halts instead of spinning. */
  maxNodes?: number;
  /** Hard ceiling on scheduling waves. */
  maxWaves?: number;
  /** Nodes dispatched concurrently within one wave. Default 1 (deterministic). */
  maxConcurrency?: number;
  /** Elapsed ceiling, measured by the injected clock. */
  maxElapsedMs?: number;
}

/**
 * How the DRIVE LOOP ended — not whether the work succeeded.
 *
 * `completed` means the loop reached quiescence, which it also does when nodes
 * failed. Inspect `failed`/`blocked` — or supply a `terminalReducer`, whose
 * typed verdict is the ONLY thing a public committer may consume. An executor
 * that decided verdicts itself would be deciding policy.
 */
export type GraphRunStatus =
  /** Nothing further can be scheduled. Says nothing about node success. */
  | 'completed'
  /** A node is awaiting input/approval; resume with the same journal. */
  | 'paused'
  /** Work remains but nothing is ready and nothing is running. */
  | 'stalled'
  /** A budget ceiling parked the run at a safe, resumable boundary. */
  | 'budget_exhausted'
  /** The cancellation signal stopped the run between dispatches. */
  | 'cancelled'
  /** The durable boundary failed (journal append rejected). Nothing after the
   *  failed append was dispatched; the journal remains the source of truth. */
  | 'halted';

/**
 * The typed verdict a terminal reducer produces. The executor never invents
 * one — quiescence is not success, and mapping outcomes to a public answer is
 * policy that belongs to the injected reducer.
 */
export interface GraphTerminal {
  status: 'success' | 'failed' | 'blocked' | 'cancelled' | 'needs_input';
  reason?: string;
}

export interface GraphRunResult {
  graphId: string;
  status: GraphRunStatus;
  trace: GraphTraceEntry[];
  completed: string[];
  failed: string[];
  blocked: string[];
  paused: string[];
  cancelled: string[];
  /** Never reachable given what settled. Not an error — an unfired branch. */
  unreached: string[];
  waves: number;
  /** Set when status is `stalled`, naming what each remaining node waits on. */
  stalledDetail?: string;
  /** Set when status is `halted`: the infrastructure reason, never node logic. */
  haltReason?: string;
  /** Digests of runtime patches applied to the topology, in order. */
  patches: string[];
  /** Present when a terminalReducer was injected. */
  terminal?: GraphTerminal;
}

export interface RunGraphOptions {
  runner: NodeRunner;
  /**
   * PURE-WALKER resume: node ids already completed. Refused under admission,
   * where identity-verified journal entries are the only trustworthy history.
   */
  journal?: Iterable<string>;
  budget?: GraphRunBudget;
  /** Called for each trace entry as it is produced. Telemetry only — the
   *  DURABLE boundary is the journal adapter, whose appends are awaited. */
  onStep?: (entry: GraphTraceEntry) => void;
  /** Content-addressed identity. Presence switches on the durable contract. */
  admission?: GraphAdmission;
  /** Mandatory under admission. `append` resolves only when durable. */
  journalAdapter?: GraphJournalAdapter;
  /** Prior journal for resume under admission; validated causally. */
  resumeEntries?: readonly GraphJournalEntry[];
  /** Injected time. Mandatory under admission (a ceiling needs a clock);
   *  monotonic ms. The executor itself never reads a clock. */
  clock?: () => number;
  /** Cancellation port; checked between dispatches, never mid-runner. */
  signal?: { readonly aborted: boolean };
  /** Mints attempt ids. Injected so tests are deterministic and the executor
   *  never reaches for randomness. Default: sequential per run. */
  attemptIds?: () => string;
  /** Turns node outcomes into ONE typed verdict. Policy, injected. */
  terminalReducer?: (result: Omit<GraphRunResult, 'terminal'>) => GraphTerminal;
  /**
   * Authority judgment for a runtime-emitted patch — the dimension the
   * executor cannot own. Structural validity is checked here regardless;
   * this port may only NARROW further. Mandatory under an admission whose
   * budget allows expansions, so authority checking cannot be forgotten.
   */
  patchAdmitter?: (patch: GraphPatch) => { ok: true } | { ok: false; reason: string };
}

function enabledEdges(graph: ExecutableGraph): ExecutableEdge[] {
  return graph.edges.filter((edge) => !edge.disabled);
}

/**
 * Which nodes can run now?
 *
 * A node is ready when every enabled incoming edge has FIRED. An edge fires
 * only when its source reached a terminal state the condition accepts, so a
 * `failure` edge holds its target back until the source actually fails.
 *
 * A node whose structural incoming edges were all disabled is never ready —
 * disabling the last route into a node removes it from the run rather than
 * promoting it to a root.
 *
 * Incoming edges are ANDed by default, deliberately matching the existing
 * workflow engine (`every(edge => completed.has(edge.source))`) so the
 * executor is provably equivalent to it — a join is a rendezvous. A node may
 * OPT INTO `joinMode: 'any'`, firing on the first satisfied incoming edge:
 * the branch-merge shape, where alternative verdict routes converge and
 * exactly one fires. The default never changed, so workflow parity holds.
 */
export function readyExecutableNodes(
  graph: ExecutableGraph,
  fired: ReadonlySet<string>,
  settled: ReadonlySet<string>,
): ExecutableNode[] {
  const enabled = enabledEdges(graph);
  // Graph order is preserved rather than sorted. It is already deterministic,
  // and it is the order the existing engine returns — sorting here would be a
  // gratuitous divergence that makes exact parity unprovable.
  return graph.nodes.filter((node) => {
    if (settled.has(node.id)) return false;
    const structuralIncoming = graph.edges.filter((edge) => edge.target === node.id);
    const incoming = enabled.filter((edge) => edge.target === node.id);
    if (structuralIncoming.length > 0 && incoming.length === 0) return false;
    return node.joinMode === 'any'
      ? incoming.some((edge) => fired.has(edge.id))
      : incoming.every((edge) => fired.has(edge.id));
  });
}

/**
 * Edge ids that count as fired when all that is known is which nodes completed.
 *
 * The bridge for callers whose state is a completed-node set rather than an
 * edge set. Every enabled edge out of a completed node fires, which is exactly
 * the current engine's rule: it ignores edge type and asks only whether the
 * source completed.
 */
export function firedEdgesFromCompleted(
  graph: ExecutableGraph,
  completed: Iterable<string>,
): Set<string> {
  const done = new Set(completed);
  return new Set(
    enabledEdges(graph)
      .filter((edge) => done.has(edge.source))
      .map((edge) => edge.id),
  );
}

function edgeFires(
  edge: ExecutableEdge,
  outcome: NodeOutcome,
  runner: NodeRunner,
): boolean {
  const when = edge.when ?? 'success';
  if (when === 'success') return outcome.status === 'completed';
  if (when === 'failure') {
    // Only the node's OWN failure routes recovery topology. Infrastructure,
    // policy, and cancellation are not evidence about the work.
    return outcome.status === 'failed' && (outcome.settlementClass ?? 'node') === 'node';
  }
  // Opaque condition: only the runner can judge it, and silence means no.
  return runner.edgeSatisfied?.(edge, outcome) === true;
}

function describeStall(
  graph: ExecutableGraph,
  settled: ReadonlySet<string>,
  fired: ReadonlySet<string>,
): string {
  const enabled = enabledEdges(graph);
  return graph.nodes
    .filter((node) => !settled.has(node.id))
    .map((node) => {
      const waiting = enabled
        .filter((edge) => edge.target === node.id && !fired.has(edge.id))
        .map((edge) => edge.source);
      return `${node.id} waits for ${[...new Set(waiting)].join(', ') || '(no enabled route)'}`;
    })
    .join('; ');
}

/**
 * Build the reuse map AFTER journaled patches have been replayed into the
 * working graph, so patch-added completions are reusable too. Reuse requires
 * the settlement's node digest to match the CURRENT definition — a changed
 * node is different work wearing the same id, and stale reuse is refused, not
 * repaired. Input-digest agreement is enforced at schedule time, when this
 * run's predecessor refs are known.
 */
function reusableSettlements(
  working: ExecutableGraph,
  completed: ReadonlyMap<string, NodeSettledEntry>,
): Map<string, NodeSettledEntry> {
  const reusable = new Map<string, NodeSettledEntry>();
  const byId = new Map(working.nodes.map((node) => [node.id, node]));
  for (const [nodeId, entry] of completed) {
    const node = byId.get(nodeId);
    if (!node) continue;
    if (entry.nodeDigest !== computeNodeDigest(node)) continue; // different work — re-run
    reusable.set(nodeId, entry);
  }
  return reusable;
}

/**
 * Drive a graph to a terminal state.
 *
 * Deterministic by construction: waves are computed from the graph, nodes
 * within a wave are dispatched in declaration order, and the trace records the
 * same sequence for the same graph and the same runner verdicts. That is what
 * lets a new engine be proved equivalent to an old one by comparing traces
 * rather than by trusting that both "did the right thing".
 */
export async function runGraph(
  graph: ExecutableGraph,
  options: RunGraphOptions,
): Promise<GraphRunResult> {
  const { runner, onStep, admission } = options;

  // The topology a run actually schedules. Patches grow THIS, never the
  // caller's graph object.
  const working: { graphId: string; nodes: ExecutableNode[]; edges: ExecutableEdge[] } = {
    graphId: graph.graphId,
    nodes: [...graph.nodes],
    edges: [...graph.edges],
  };
  const appliedPatchDigests: string[] = [];
  let expansions = 0;
  const maxExpansions = admission ? admission.budget.maxExpansions : Number.POSITIVE_INFINITY;

  const applyPatch = (patch: GraphPatch): { ok: true; patchDigest: string } | { ok: false; reason: string } => {
    const validated = validateGraphPatch(working, patch);
    if (!validated.ok) return { ok: false, reason: validated.errors.join('; ') };
    // The temporal half of the join rule: an edge may join an EXISTING node
    // only while that node's scheduling future is still open. Growing the
    // AND-set of a node that settled, or whose readiness already fired, would
    // rewrite history the trace has already recorded.
    for (const edge of patch.edges) {
      const joinsExisting = working.nodes.some((node) => node.id === edge.target)
        && !patch.nodes.some((node) => node.id === edge.target);
      if (!joinsExisting) continue;
      if (settled.has(edge.target)) {
        return { ok: false, reason: `edge "${edge.id}" joins "${edge.target}", which has already settled` };
      }
      const firedIncoming = working.edges.some(
        (incoming) => !incoming.disabled && incoming.target === edge.target && fired.has(incoming.id),
      );
      if (firedIncoming) {
        return { ok: false, reason: `edge "${edge.id}" joins "${edge.target}", whose readiness has already fired` };
      }
    }
    // Idempotent by digest: a crash between patch admission and emitter
    // settlement re-emits the same patch on resume, and replay must not turn
    // that into a duplicate-node refusal.
    if (appliedPatchDigests.includes(validated.patchDigest)) {
      return { ok: true, patchDigest: validated.patchDigest };
    }
    if (expansions >= maxExpansions) {
      return { ok: false, reason: `expansion budget exhausted (${maxExpansions})` };
    }
    if (options.patchAdmitter) {
      const admitterVerdict = options.patchAdmitter(patch);
      if (!admitterVerdict.ok) return { ok: false, reason: `patch admitter refused: ${admitterVerdict.reason}` };
    }
    working.nodes.push(...patch.nodes);
    working.edges.push(...patch.edges);
    appliedPatchDigests.push(validated.patchDigest);
    expansions += 1;
    return { ok: true, patchDigest: validated.patchDigest };
  };

  // ── mode resolution ────────────────────────────────────────────────────────
  let haltReason: string | undefined;
  let reusable = new Map<string, NodeSettledEntry>();
  if (admission) {
    if (!options.journalAdapter) haltReason = 'admitted run requires a journal adapter';
    else if (!options.clock) haltReason = 'admitted run requires a clock (a ceiling needs one)';
    else if (options.journal) haltReason = 'admitted run refuses a node-id journal; supply resumeEntries';
    else if (admission.budget.maxExpansions > 0 && !options.patchAdmitter) {
      // Fail closed: an admitted run allowed to grow must have an authority
      // judge for what it grows. Forgetting the admitter must be loud.
      haltReason = 'admitted run allows expansions but has no patch admitter';
    } else if (options.resumeEntries?.length) {
      const validated = validateJournalForResume(graph, admission, options.resumeEntries);
      if (!validated.ok) haltReason = `resume refused: ${validated.errors.join('; ')}`;
      else {
        // Replay journaled patches into the working graph before anything
        // schedules. Content is digest-checked, so a tampered journal refuses.
        for (const patchEntry of validated.patches) {
          const replayed = applyPatch({
            emittedBy: patchEntry.emittedBy,
            nodes: patchEntry.nodes,
            edges: patchEntry.edges,
          });
          if (!replayed.ok) {
            haltReason = `resume refused: journaled patch could not replay: ${replayed.reason}`;
            break;
          }
          if (replayed.patchDigest !== patchEntry.patchDigest) {
            haltReason = 'resume refused: journaled patch content does not match its digest';
            break;
          }
        }
        if (!haltReason) reusable = reusableSettlements(working, validated.completed);
      }
    }
  }

  const budget = admission ? admission.budget : options.budget;
  const maxNodes = budget?.maxNodes ?? Number.POSITIVE_INFINITY;
  const maxWaves = budget?.maxWaves ?? Number.POSITIVE_INFINITY;
  const maxConcurrency = Math.max(1, budget?.maxConcurrency ?? 1);
  const maxElapsedMs = (admission ? admission.budget.maxElapsedMs : options.budget?.maxElapsedMs)
    ?? Number.POSITIVE_INFINITY;
  const clock = options.clock;
  const startedAt = clock?.() ?? 0;

  let attemptCounter = 0;
  const nextAttemptId = options.attemptIds ?? (() => `attempt-${(attemptCounter += 1)}`);

  const trace: GraphTraceEntry[] = [];
  const completed = new Set<string>();
  const failed = new Set<string>();
  const blocked = new Set<string>();
  const paused = new Set<string>();
  const cancelled = new Set<string>();
  /** Terminal for scheduling purposes — never dispatched again. */
  const settled = new Set<string>();
  /** Edge ids whose condition has been satisfied. */
  const fired = new Set<string>();
  /** Settled artifact refs, for successors' typed data flow. */
  const artifactRefs = new Map<string, { outputRef?: string; evidenceRefs?: readonly string[] }>();

  const pureJournal = new Set(admission ? [] : options.journal ?? []);
  let dispatched = 0;
  let wave = 0;
  let status: GraphRunStatus = haltReason ? 'halted' : 'completed';

  const record = (entry: GraphTraceEntry): void => {
    trace.push(entry);
    onStep?.(entry);
  };

  const fireEdgesFor = (nodeId: string, outcome: NodeOutcome): void => {
    for (const edge of enabledEdges(working)) {
      if (edge.source !== nodeId) continue;
      if (edgeFires(edge, outcome, runner)) fired.add(edge.id);
    }
  };

  const settle = (node: ExecutableNode, outcome: NodeOutcome, reused?: true): void => {
    settled.add(node.id);
    if (outcome.status === 'completed') {
      completed.add(node.id);
      artifactRefs.set(node.id, { outputRef: outcome.outputRef, evidenceRefs: outcome.evidenceRefs });
    } else if (outcome.status === 'failed') failed.add(node.id);
    else if (outcome.status === 'blocked') blocked.add(node.id);
    else paused.add(node.id);
    fireEdgesFor(node.id, outcome);
    record({
      wave,
      nodeId: node.id,
      kind: node.kind,
      status: outcome.status,
      ...(reused ? { reused } : {}),
      ...(outcome.status === 'completed' ? {} : { reason: outcome.reason }),
    });
  };

  const predecessorRefsFor = (node: ExecutableNode): PredecessorRef[] => {
    return enabledEdges(working)
      .filter((edge) => edge.target === node.id && fired.has(edge.id) && completed.has(edge.source))
      .map((edge) => ({ nodeId: edge.source, ...(artifactRefs.get(edge.source) ?? {}) }));
  };

  main: while (!haltReason) {
    if (options.signal?.aborted) { status = 'cancelled'; break; }
    if (clock && clock() - startedAt > maxElapsedMs) { status = 'budget_exhausted'; break; }

    const ready = readyExecutableNodes(working, fired, settled);
    if (ready.length === 0) { if (status !== 'halted') status = 'completed'; break; }
    if (wave >= maxWaves) { status = 'budget_exhausted'; break; }

    // Journal/resume reuse settles without dispatch and without consuming
    // budget: replaying a completed step must be free, or restart becomes more
    // expensive than the original run.
    const fresh: ExecutableNode[] = [];
    for (const node of ready) {
      const journaled = reusable.get(node.id);
      if (journaled) {
        settle(node, {
          status: 'completed',
          outputRef: journaled.outputRef,
          evidenceRefs: journaled.evidenceRefs,
        }, true);
      } else if (pureJournal.has(node.id)) {
        settle(node, { status: 'completed' }, true);
      } else {
        fresh.push(node);
      }
    }
    if (fresh.length === 0) { wave += 1; continue; }

    // A wave that would exceed the node budget parks BEFORE dispatching any of
    // it — deterministic, and a partial wave never half-happens.
    if (dispatched + fresh.length > maxNodes) { status = 'budget_exhausted'; break; }

    const outcomes: Array<{ node: ExecutableNode; outcome: NodeOutcome }> = [];
    for (let i = 0; i < fresh.length; i += maxConcurrency) {
      if (options.signal?.aborted) { status = 'cancelled'; break main; }
      const slice = fresh.slice(i, i + maxConcurrency);
      const completedSnapshot = [...completed];

      // Durable claim precedes dispatch: a crash between the two leaves an
      // interrupted attempt in the journal, never an untracked side effect.
      const prepared = slice.map((node) => {
        const predecessors = predecessorRefsFor(node);
        return {
          node,
          predecessors,
          nodeDigest: computeNodeDigest(node),
          inputDigest: computeInputDigest(predecessors),
          attemptId: nextAttemptId(),
        };
      });
      if (admission && options.journalAdapter) {
        for (const p of prepared) {
          try {
            await options.journalAdapter.append({
              type: 'node_started',
              admissionDigest: admission.admissionDigest,
              nodeId: p.node.id,
              nodeDigest: p.nodeDigest,
              inputDigest: p.inputDigest,
              attemptId: p.attemptId,
              wave,
            });
          } catch (error) {
            haltReason = `journal append failed before dispatch of "${p.node.id}": ${error instanceof Error ? error.message : String(error)}`;
            status = 'halted';
            break main;
          }
        }
      }

      const resolved = await Promise.all(prepared.map(async (p) => {
        let outcome: NodeOutcome;
        try {
          outcome = await runner.run(p.node, {
            graphId: graph.graphId,
            completed: completedSnapshot,
            predecessors: p.predecessors,
            wave,
          });
        } catch (error) {
          // A throwing runner is infrastructure, not node logic: typed, never
          // routed along failure edges, and never a torn-down executor.
          outcome = {
            status: 'failed',
            reason: error instanceof Error ? error.message : String(error),
            settlementClass: 'infrastructure',
          };
        }
        return { ...p, outcome };
      }));

      // Settlement is durable BEFORE dependents can observe it. An emitted
      // patch is validated, authority-checked, budget-debited, and durable
      // FIRST — children must never exist without a journaled reason — and an
      // emission that cannot be admitted fails the EMITTER as node logic, so
      // recovery is expressible as topology.
      for (const p of resolved) {
        if (p.outcome.status === 'completed' && p.outcome.emitPatch) {
          const patch: GraphPatch = { emittedBy: p.node.id, ...p.outcome.emitPatch };
          // Admission first — structural, budget, authority — then the journal
          // records only what was actually admitted. Journaling before the
          // admitter judged would durably assert an authority decision that
          // never happened.
          const patchCountBefore = appliedPatchDigests.length;
          const applied = applyPatch(patch);
          if (!applied.ok) {
            p.outcome = {
              status: 'failed',
              reason: `emitted patch refused: ${applied.reason}`,
              settlementClass: 'node',
            };
          } else if (
            admission && options.journalAdapter
            && appliedPatchDigests.length > patchCountBefore
          ) {
            try {
              await options.journalAdapter.append({
                type: 'patch_admitted',
                admissionDigest: admission.admissionDigest,
                emittedBy: p.node.id,
                patchDigest: applied.patchDigest,
                nodes: [...patch.nodes],
                edges: [...patch.edges],
              });
            } catch (error) {
              // The working copy grew but the durable record did not: halt
              // before scheduling any child. On resume the patch entry is
              // absent, the emitter is unsettled, and it re-runs cleanly.
              haltReason = `journal append failed for patch from "${p.node.id}": ${error instanceof Error ? error.message : String(error)}`;
              status = 'halted';
              break main;
            }
          }
        }
        if (admission && options.journalAdapter) {
          try {
            await options.journalAdapter.append({
              type: 'node_settled',
              admissionDigest: admission.admissionDigest,
              nodeId: p.node.id,
              nodeDigest: p.nodeDigest,
              inputDigest: p.inputDigest,
              attemptId: p.attemptId,
              wave,
              status: p.outcome.status,
              ...(p.outcome.status === 'completed'
                ? { outputRef: p.outcome.outputRef, evidenceRefs: p.outcome.evidenceRefs }
                : { reason: p.outcome.reason }),
              ...(p.outcome.status === 'failed'
                ? { settlementClass: p.outcome.settlementClass ?? 'node' }
                : {}),
            });
          } catch (error) {
            haltReason = `journal append failed while settling "${p.node.id}": ${error instanceof Error ? error.message : String(error)}`;
            status = 'halted';
            break main;
          }
        }
        outcomes.push({ node: p.node, outcome: p.outcome });
      }
    }
    dispatched += outcomes.length;

    // Settle in declaration order regardless of completion order, so
    // concurrency never reorders a trace.
    for (const { node, outcome } of outcomes) settle(node, outcome);

    if (outcomes.some(({ outcome }) => outcome.status === 'paused')) {
      status = 'paused';
      break;
    }
    wave += 1;
  }

  const unreached = working.nodes
    .filter((node) => !settled.has(node.id))
    .map((node) => node.id);

  if (status === 'completed' && unreached.length > 0) {
    // Distinguish "a branch legitimately did not fire" from "nothing can move".
    // A node is only stalled if some route into it is still pending — if every
    // route's source settled and simply did not satisfy the condition, that
    // branch is unreached by design.
    const enabled = enabledEdges(working);
    const stalled = unreached.some((nodeId) => {
      const incoming = enabled.filter((edge) => edge.target === nodeId);
      return incoming.length > 0 && incoming.some((edge) => !settled.has(edge.source));
    });
    if (stalled) status = 'stalled';
  }

  const base: Omit<GraphRunResult, 'terminal'> = {
    graphId: graph.graphId,
    status,
    trace,
    completed: [...completed],
    failed: [...failed],
    blocked: [...blocked],
    paused: [...paused],
    cancelled: [...cancelled],
    unreached,
    waves: wave,
    ...(status === 'stalled' ? { stalledDetail: describeStall(working, settled, fired) } : {}),
    ...(haltReason ? { haltReason } : {}),
    patches: appliedPatchDigests,
  };
  return options.terminalReducer
    ? { ...base, terminal: options.terminalReducer(base) }
    : base;
}

/** Compact, comparable rendering of a run. The unit of engine-parity proof. */
export function formatGraphTrace(trace: readonly GraphTraceEntry[]): string {
  return trace
    .map((entry) => `${entry.wave}:${entry.nodeId}:${entry.status}${entry.reused ? ':reused' : ''}`)
    .join('\n');
}
