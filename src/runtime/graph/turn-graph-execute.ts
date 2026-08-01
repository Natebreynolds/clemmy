/**
 * Turn-graph execution — the lane that makes a compiled graph actually run.
 *
 * The compiler already emits the right plan for multi-item action work:
 *
 *   fanout → execute(per_item, maxConcurrency) → reduce → verify → compose → publish
 *
 * and nothing ran it. Measured on the owner's machine (2026-08-01) that gap has
 * a precise cost: of 21 heavy chat runs (25+ tool calls), NINETEEN executed as a
 * single context with zero workers, and every heavy workflow run spawned zero
 * specialists. Dispatching the same work to the background lane fans out 631
 * workers, so the machinery was never the problem — the chat lane simply never
 * reached for it. Every symptom downstream follows: sources read one at a time,
 * the context turning to swamp, a reviewer grading its own work, and a fan-out
 * guardrail nagging at call six about a topology decision that should have been
 * made before the first call.
 *
 * This executor owns TOPOLOGY and nothing else:
 *
 *   - it orders nodes, honors per-item multiplicity, bounds concurrency, and
 *     reduces branch results deterministically;
 *   - it does NOT grant authority. Nodes carry `decisionOwner:
 *     'runtime_tool_boundary'`, so effects stay gated exactly where they are
 *     gated today. A graph that could authorize its own writes would be a new
 *     bypass, not a new runtime;
 *   - it does NOT publish. The reduced result is returned to the caller, and
 *     the public reply committer stays the only thing that speaks to the user.
 *
 * Node runners are INJECTED rather than imported. A model loop is a runner
 * inside this graph, not the owner of it — which is what makes the lane
 * testable without a model, and what keeps worker dispatch in the one place
 * that already knows how to do it.
 */
import { runBoundedPool } from '../../execution/bounded-pool.js';
import type { TurnGraphIR, TurnGraphNode } from './turn-graph-ir.js';

/** One unit of per-item work, addressed by a stable identity. */
export interface TurnGraphItem {
  /** Stable across retries and waves — never a position or a rewritten label. */
  id: string;
  /** What the runner is asked to do with this item. */
  prompt: string;
}

export interface TurnGraphBranchResult {
  itemId: string;
  ok: boolean;
  /** The runner's own typed output. Reducers merge these, never chat history. */
  output?: unknown;
  error?: string;
}

export interface TurnGraphNodeRunners {
  /**
   * Run one item of a fan-out `execute` node, or the whole node when it has no
   * multiplicity. Must resolve; a rejection is captured as a failed branch so
   * one bad item can never take the batch down with it.
   */
  execute(input: { node: TurnGraphNode; item: TurnGraphItem; signal?: AbortSignal }): Promise<unknown>;
  /** Merge typed branch results into the node's output. */
  reduce?(input: { node: TurnGraphNode; branches: readonly TurnGraphBranchResult[] }): Promise<unknown>;
  /** Lifecycle telemetry. Called per branch so worker counts stop reading zero. */
  onBranchStart?(input: { node: TurnGraphNode; item: TurnGraphItem; index: number }): void;
  onBranchSettle?(result: TurnGraphBranchResult): void;
}

export interface TurnGraphExecution {
  /** Every branch outcome, in stable item order. */
  branches: TurnGraphBranchResult[];
  /** The reduce node's output when the graph had one. */
  reduced?: unknown;
  /** Item ids that failed — the honest denominator for a partial report. */
  failedItemIds: string[];
  /** How many branches ran concurrently at most. */
  concurrency: number;
  /** True when every item that was dispatched succeeded. */
  complete: boolean;
}

/** Nodes this executor knows how to run. Anything else is deliberately left to
 *  the existing runtime — an executor that silently no-ops an unknown node
 *  would report success for work it never attempted. */
const EXECUTABLE_KINDS: ReadonlySet<TurnGraphNode['kind']> = new Set(['fanout', 'execute', 'reduce']);

export function turnGraphExecutableNodes(ir: TurnGraphIR): TurnGraphNode[] {
  return ir.nodes.filter((node) => EXECUTABLE_KINDS.has(node.kind));
}

/** True when this compiled graph carries real per-item fan-out work. */
export function isFanoutGraph(ir: TurnGraphIR): boolean {
  return ir.nodes.some((node) =>
    node.kind === 'execute'
    && node.multiplicity?.kind === 'per_item'
    && node.multiplicity.estimatedItems > 1);
}

/**
 * Effective concurrency for a fan-out node: the compiled ceiling, never more
 * than the work actually present, and never below one. A plan that estimated
 * ten items but received three must not open ten lanes.
 */
export function effectiveConcurrency(node: TurnGraphNode, itemCount: number): number {
  const ceiling = node.multiplicity?.maxConcurrency ?? 1;
  return Math.max(1, Math.min(Math.floor(ceiling) || 1, Math.max(1, itemCount)));
}

/**
 * Execute the fan-out lane of a compiled turn graph.
 *
 * Items are supplied by the caller rather than re-derived here: the accepted
 * turn already resolved them, and re-deriving would let the plan and the work
 * disagree about what "each item" means — which is exactly how the same firm
 * got scraped three times across dispatch waves.
 */
export async function executeTurnGraphFanout(input: {
  ir: TurnGraphIR;
  items: readonly TurnGraphItem[];
  runners: TurnGraphNodeRunners;
  signal?: AbortSignal;
}): Promise<TurnGraphExecution> {
  const executeNode = input.ir.nodes.find((node) => node.kind === 'execute');
  if (!executeNode) {
    return { branches: [], failedItemIds: [], concurrency: 0, complete: true };
  }

  // De-duplicate by stable identity BEFORE dispatch. Identity is the caller's
  // contract; two entries claiming the same id are the same work, and running
  // both is the wasteful-rework class this lane exists to end.
  const byId = new Map<string, TurnGraphItem>();
  for (const item of input.items) {
    if (item.id && !byId.has(item.id)) byId.set(item.id, item);
  }
  const items = [...byId.values()];
  if (items.length === 0) {
    return { branches: [], failedItemIds: [], concurrency: 0, complete: true };
  }

  const concurrency = effectiveConcurrency(executeNode, items.length);
  // Indexed so results stay in stable item order regardless of completion
  // order — a reducer that merged in finish order would produce a different
  // answer for the same inputs on every run.
  const settled: Array<TurnGraphBranchResult | undefined> = new Array(items.length);

  await runBoundedPool(items, concurrency, async (item, index) => {
    if (input.signal?.aborted) {
      settled[index] = { itemId: item.id, ok: false, error: 'cancelled before dispatch' };
      return;
    }
    input.runners.onBranchStart?.({ node: executeNode, item, index });
    let result: TurnGraphBranchResult;
    try {
      const output = await input.runners.execute({ node: executeNode, item, signal: input.signal });
      result = { itemId: item.id, ok: true, output };
    } catch (err) {
      // One item failing is an item-level fact, never a batch-level one.
      result = { itemId: item.id, ok: false, error: err instanceof Error ? err.message : String(err) };
    }
    settled[index] = result;
    input.runners.onBranchSettle?.(result);
  });

  const branches = settled.map((entry, index) =>
    entry ?? { itemId: items[index]!.id, ok: false, error: 'branch produced no result' });
  const failedItemIds = branches.filter((branch) => !branch.ok).map((branch) => branch.itemId);

  let reduced: unknown;
  const reduceNode = input.ir.nodes.find((node) => node.kind === 'reduce');
  if (reduceNode && input.runners.reduce) {
    // The reducer sees EVERY branch, including the failures. A reducer handed
    // only the successes writes a confident summary of a partial run and the
    // gap never reaches the user.
    reduced = await input.runners.reduce({ node: reduceNode, branches });
  }

  return {
    branches,
    ...(reduced === undefined ? {} : { reduced }),
    failedItemIds,
    concurrency,
    complete: failedItemIds.length === 0,
  };
}
