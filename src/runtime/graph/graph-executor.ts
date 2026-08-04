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
 *      next mega-loop.
 *   3. It does not decide structural validity. Compilers and validators reject
 *      cycles and dangling edges at admission; a definition that cannot
 *      progress surfaces here as an explicit stall naming what is waiting,
 *      never as a throw from inside the loop or as an infinite spin.
 *
 * Failure is an edge, not an exception. A node that fails routes along its
 * `failure` edges when it has them, and only halts the branch when it does not
 * — so a graph can express recovery as topology instead of as runner-side
 * catch blocks the graph cannot see.
 */

/** A node the executor schedules. `kind` is meaningful only to the runner. */
export interface ExecutableNode {
  id: string;
  kind: string;
}

/**
 * Edge conditions the executor understands.
 *
 * `success` is the default and the only one that fires on completion.
 * `failure` fires when the source node failed, which is what makes recovery
 * expressible as topology. Any other label is opaque: the runner decides,
 * and an unrecognized label with no runner opinion never fires — a condition
 * nobody can evaluate must not silently behave like an unconditional edge.
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

export type NodeStatus = 'completed' | 'failed' | 'blocked' | 'paused';

export type NodeOutcome =
  | { status: 'completed'; evidenceRef?: string }
  /** Ran and did not succeed. Routes along `failure` edges when they exist. */
  | { status: 'failed'; reason: string }
  /** Cannot run at all (missing authority/capability). Never routes. */
  | { status: 'blocked'; reason: string }
  /** Awaiting input, approval, or budget. Halts the run for later resume. */
  | { status: 'paused'; reason: string };

export interface NodeRunContext {
  graphId: string;
  /** Ids completed before this node, including those restored from a journal. */
  completed: readonly string[];
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
}

/**
 * How the DRIVE LOOP ended — not whether the work succeeded.
 *
 * `completed` means the loop reached quiescence, which it also does when nodes
 * failed. Inspect `failed`/`blocked` for node verdicts. Turning a set of node
 * outcomes into one public answer is the terminal reducer's job; an executor
 * that also decided verdicts would be deciding policy.
 */
export type GraphRunStatus =
  /** Nothing further can be scheduled. Says nothing about node success. */
  | 'completed'
  /** A node is awaiting input/approval; resume with the same journal. */
  | 'paused'
  /** Work remains but nothing is ready and nothing is running. */
  | 'stalled'
  /** A budget ceiling stopped the run. */
  | 'budget_exhausted';

export interface GraphRunResult {
  graphId: string;
  status: GraphRunStatus;
  trace: GraphTraceEntry[];
  completed: string[];
  failed: string[];
  blocked: string[];
  paused: string[];
  /** Never reachable given what completed. Not an error — an unfired branch. */
  unreached: string[];
  waves: number;
  /** Set when status is `stalled`, naming what each remaining node waits on. */
  stalledDetail?: string;
}

export interface RunGraphOptions {
  runner: NodeRunner;
  /**
   * Node ids already completed in a previous attempt. Their runners are not
   * called again — the journal is the cache, so replay is free and effects are
   * not repeated.
   */
  journal?: Iterable<string>;
  budget?: GraphRunBudget;
  /** Called for each trace entry as it is produced, for durable event writing. */
  onStep?: (entry: GraphTraceEntry) => void;
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
 * Incoming edges are ANDed. This deliberately matches the existing workflow
 * engine, whose readiness is `every(edge => completed.has(edge.source))`, so
 * the executor can be proved equivalent to it. It means a join is a rendezvous,
 * never a race: "run C when A OR B succeeds" is not expressible, and adding it
 * would be a behavior change rather than an extraction.
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
    return incoming.every((edge) => fired.has(edge.id));
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
  if (when === 'failure') return outcome.status === 'failed';
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
 * Drive a graph to a terminal state.
 *
 * Deterministic by construction: waves are computed from the graph, nodes
 * within a wave are dispatched in id order, and the trace records the same
 * sequence for the same graph and the same runner verdicts. That is what lets a
 * new engine be proved equivalent to an old one by comparing traces rather than
 * by trusting that both "did the right thing".
 */
export async function runGraph(
  graph: ExecutableGraph,
  options: RunGraphOptions,
): Promise<GraphRunResult> {
  const { runner, onStep } = options;
  const maxNodes = options.budget?.maxNodes ?? Number.POSITIVE_INFINITY;
  const maxWaves = options.budget?.maxWaves ?? Number.POSITIVE_INFINITY;
  const maxConcurrency = Math.max(1, options.budget?.maxConcurrency ?? 1);

  const trace: GraphTraceEntry[] = [];
  const completed = new Set<string>();
  const failed = new Set<string>();
  const blocked = new Set<string>();
  const paused = new Set<string>();
  /** Terminal for scheduling purposes — never dispatched again. */
  const settled = new Set<string>();
  /** Edge ids whose condition has been satisfied. */
  const fired = new Set<string>();

  const journal = new Set(options.journal ?? []);
  let dispatched = 0;
  let wave = 0;
  let status: GraphRunStatus = 'completed';

  const record = (entry: GraphTraceEntry): void => {
    trace.push(entry);
    onStep?.(entry);
  };

  const settle = (node: ExecutableNode, outcome: NodeOutcome, reused?: true): void => {
    settled.add(node.id);
    if (outcome.status === 'completed') completed.add(node.id);
    else if (outcome.status === 'failed') failed.add(node.id);
    else if (outcome.status === 'blocked') blocked.add(node.id);
    else paused.add(node.id);

    for (const edge of enabledEdges(graph)) {
      if (edge.source !== node.id) continue;
      if (edgeFires(edge, outcome, runner)) fired.add(edge.id);
    }

    record({
      wave,
      nodeId: node.id,
      kind: node.kind,
      status: outcome.status,
      ...(reused ? { reused } : {}),
      ...(outcome.status === 'completed' ? {} : { reason: outcome.reason }),
    });
  };

  for (;;) {
    const ready = readyExecutableNodes(graph, fired, settled);
    if (ready.length === 0) break;
    if (wave >= maxWaves) { status = 'budget_exhausted'; break; }

    // A journaled node is settled without dispatch and without consuming
    // budget: replaying a completed step must be free, or restart becomes more
    // expensive than the original run.
    const fresh: ExecutableNode[] = [];
    for (const node of ready) {
      if (journal.has(node.id)) settle(node, { status: 'completed' }, true);
      else fresh.push(node);
    }
    if (fresh.length === 0) { wave += 1; continue; }

    if (dispatched + fresh.length > maxNodes) {
      status = 'budget_exhausted';
      break;
    }

    const outcomes: Array<{ node: ExecutableNode; outcome: NodeOutcome }> = [];
    for (let i = 0; i < fresh.length; i += maxConcurrency) {
      const slice = fresh.slice(i, i + maxConcurrency);
      const settledSnapshot = [...completed];
      const resolved = await Promise.all(slice.map(async (node) => ({
        node,
        outcome: await runner.run(node, {
          graphId: graph.graphId,
          completed: settledSnapshot,
          wave,
        }),
      })));
      outcomes.push(...resolved);
    }
    dispatched += fresh.length;

    // Settle in id order regardless of completion order, so concurrency never
    // reorders a trace.
    for (const { node, outcome } of outcomes) settle(node, outcome);

    if (outcomes.some(({ outcome }) => outcome.status === 'paused')) {
      status = 'paused';
      break;
    }
    wave += 1;
  }

  const unreached = graph.nodes
    .filter((node) => !settled.has(node.id))
    .map((node) => node.id);

  if (status === 'completed' && unreached.length > 0) {
    // Distinguish "a branch legitimately did not fire" from "nothing can move".
    // A node is only stalled if every route into it is still pending — if a
    // route's source settled and simply did not satisfy the condition, that
    // branch is unreached by design.
    const enabled = enabledEdges(graph);
    const stalled = unreached.some((nodeId) => {
      const incoming = enabled.filter((edge) => edge.target === nodeId);
      return incoming.length > 0 && incoming.some((edge) => !settled.has(edge.source));
    });
    if (stalled) {
      status = 'stalled';
    }
  }

  return {
    graphId: graph.graphId,
    status,
    trace,
    completed: [...completed],
    failed: [...failed],
    blocked: [...blocked],
    paused: [...paused],
    unreached,
    waves: wave,
    ...(status === 'stalled' ? { stalledDetail: describeStall(graph, settled, fired) } : {}),
  };
}

/** Compact, comparable rendering of a run. The unit of engine-parity proof. */
export function formatGraphTrace(trace: readonly GraphTraceEntry[]): string {
  return trace
    .map((entry) => `${entry.wave}:${entry.nodeId}:${entry.status}${entry.reused ? ':reused' : ''}`)
    .join('\n');
}
