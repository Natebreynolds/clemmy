/**
 * The chat turn spine, driven by the graph executor (Clem 4, G5b slice 1).
 *
 * Chat turns previously ORIGINATED in loop.ts: accept, run the core loop,
 * reduce a terminal, publish — an implicit order the compiled turn graph
 * merely observed and discarded. This module makes the compiled graph the
 * thing that runs the spine: the executor walks the turn's nodes in graph
 * order, the phases are injected runners, the trace is real, and the public
 * verdict flows through the executor's terminal-reducer port.
 *
 * Deliberately interim, per the charter's Phase 2: the provider core remains
 * ONE large node (`compose_reply` hosts it) while context, capability,
 * retrieval, and verification nodes settle as pass-throughs the core still
 * owns internally. Each later stage moves one of those phases out of the core
 * and into its node — the spine does not change again when they do. Interior
 * typed conditions are granted by the interim runner for exactly that reason
 * and that reason is temporary; the publish edge is NOT interim: publication
 * happens only when the executor reaches the publish node.
 *
 * Fail-open on COMPILATION only, and loudly: chat must not die because a
 * classifier refused an exotic input, so an uncompilable turn runs the exact
 * legacy order via the same injected phases. Sequencing falls back;
 * authority never does (authority lives in the phases themselves).
 */
import type { ProactivityPolicySnapshot } from '../../agents/proactivity-policy.js';
import { compileTurnGraph } from './turn-graph-compiler.js';
import { snapshotTurnGraphPolicy } from './turn-graph-compiler.js';
import type { TurnGraphSurface } from './turn-graph-ir.js';
import { runGraph, type GraphRunResult, type GraphTraceEntry } from './graph-executor.js';

export interface ChatTurnSpinePhases<CoreResult> {
  /** The provider core — today's runConversationCore. Runs exactly once. */
  runCore: () => Promise<CoreResult>;
  /** Should the publish phase run for this core result? A dispatched turn's
   *  public edge is its dispatch ACK, so it publishes nothing further. */
  shouldPublish: (core: CoreResult) => boolean;
  /** The terminal reduction + public commit — runs at the publish node. */
  publish: (core: CoreResult) => void;
  /**
   * Was the answer DELIVERED (evidence sufficient), per the core's own
   * delivery verdict? Drives which verdict route fires: `true` grants
   * `evidence_sufficient` (compose_reply), `false` grants
   * `evidence_insufficient` (compose_blocked). Defaults to true when absent
   * so direct-reply-shaped callers need no opinion. Phase 1(b) of the verify
   * extraction: the graph's routes now follow the REAL verdict.
   */
  delivered?: (core: CoreResult) => boolean;
}

export interface ChatTurnSpineInput<CoreResult> {
  identity: { sessionId: string; turn: number; sourceUserSeq: number };
  input: string;
  surface: TurnGraphSurface;
  policy: ProactivityPolicySnapshot;
  phases: ChatTurnSpinePhases<CoreResult>;
}

export interface ChatTurnSpineResult<CoreResult> {
  core: CoreResult;
  /** 'graph' when the executor drove the spine; 'legacy_order' when
   *  compilation failed and the phases ran in the exact legacy sequence. */
  engine: 'graph' | 'legacy_order';
  /** Present for graph runs: the executed trace and run result. */
  run?: GraphRunResult;
  trace?: GraphTraceEntry[];
  compileError?: string;
}

/**
 * Drive one accepted chat turn through its compiled graph.
 *
 * The core is hosted at the turn's WORK node — `retrieve`, `execute`, or
 * `fanout` when the compiled shape has one, else `compose_reply` (the
 * direct-reply shape) — so the delivery verdict EXISTS before the verify
 * node's outgoing edges are judged. The verdict then decides which verdict
 * route fires: evidence_sufficient into compose_reply, or
 * evidence_insufficient into compose_blocked, converging on the single
 * any-join publish node. Remaining pass-throughs (context, capability,
 * verify itself) are the later interior slices; their conditions are the
 * only ones still interim-granted.
 */
export async function driveChatTurnSpine<CoreResult>(
  spine: ChatTurnSpineInput<CoreResult>,
): Promise<ChatTurnSpineResult<CoreResult>> {
  let compiled: ReturnType<typeof compileTurnGraph> | null = null;
  let compileError: string | undefined;
  try {
    compiled = compileTurnGraph({
      identity: spine.identity,
      input: spine.input,
      sessionKind: 'chat',
      surface: spine.surface,
      policy: snapshotTurnGraphPolicy(spine.policy),
    });
    if (!compiled.validation.ok) {
      compileError = compiled.validation.errors.join('; ');
      compiled = null;
    }
  } catch (error) {
    compileError = error instanceof Error ? error.message : String(error);
    compiled = null;
  }

  if (!compiled) {
    // Legacy ORDER, same phases: behavior-identical spine, minus the trace.
    const core = await spine.phases.runCore();
    if (spine.phases.shouldPublish(core)) spine.phases.publish(core);
    return { core, engine: 'legacy_order', compileError };
  }

  const graph = compiled.graph;
  // Host the core at the first WORK node of the compiled shape; the
  // direct-reply shape has none, so compose_reply hosts as before.
  const workKinds = new Set(['retrieve', 'execute', 'fanout']);
  const hostNodeId = (graph.nodes.find((node) => workKinds.has(node.kind))
    ?? graph.nodes.find((node) => node.kind === 'compose_reply'))?.id;
  let core: CoreResult | undefined;
  let coreAttempted = false;
  let coreRan = false;
  let coreDelivered = true;
  let coreError: unknown;
  let published = false;

  const run = await runGraph(
    {
      graphId: graph.graphId,
      nodes: graph.nodes.map((node) => ({ id: node.id, kind: node.kind, ...(node.joinMode ? { joinMode: node.joinMode } : {}) })),
      edges: graph.edges.map((edge) => ({
        id: edge.id,
        source: edge.source,
        target: edge.target,
        when: edge.when,
      })),
    },
    {
      runner: {
        run: async (node) => {
          if (node.id === hostNodeId) {
            // The provider error contract must not change shape under the
            // executor: a throwing core is captured here and RETHROWN after
            // the run, so the caller's retry/fallover machinery sees exactly
            // what it always saw — and the executor's infrastructure-catch
            // can never route this turn into a second provider call.
            coreAttempted = true;
            try {
              core = await spine.phases.runCore();
              coreRan = true;
              coreDelivered = spine.phases.delivered?.(core) ?? true;
              return { status: 'completed' };
            } catch (error) {
              coreError = error;
              return {
                status: 'failed',
                reason: error instanceof Error ? error.message : String(error),
                settlementClass: 'infrastructure',
              };
            }
          }
          if (node.kind === 'publish') {
            if (!coreRan) {
              // Structurally impossible in a compiled turn graph (publish is
              // downstream of compose_reply); refusing beats publishing air.
              return { status: 'blocked', reason: 'publish reached before the core ran' };
            }
            if (spine.phases.shouldPublish(core as CoreResult)) {
              spine.phases.publish(core as CoreResult);
              published = true;
            }
            return { status: 'completed' };
          }
          // Interim pass-through: the core still owns this phase internally.
          return { status: 'completed' };
        },
        // The verdict routes follow the REAL delivery verdict (phase 1b).
        // input_available / authority_available remain interim-granted until
        // their phases extract; unknown conditions stay closed by default in
        // the executor, so listing them here is deliberate.
        edgeSatisfied: (edge) => {
          if (edge.when === 'evidence_sufficient') return coreRan && coreDelivered;
          if (edge.when === 'evidence_insufficient') return coreRan && !coreDelivered;
          return true;
        },
      },
      budget: { maxConcurrency: 1 },
      terminalReducer: (result) => {
        if (result.failed.length > 0) {
          return { status: 'failed', reason: `spine node(s) failed: ${result.failed.join(', ')}` };
        }
        if (result.blocked.length > 0) {
          return { status: 'blocked', reason: `spine node(s) blocked: ${result.blocked.join(', ')}` };
        }
        return { status: 'success' };
      },
    },
  );

  if (coreError !== undefined) throw coreError;
  if (!coreAttempted) {
    // The graph never reached compose_reply — a spine defect, not a user
    // outcome, and the core was NEVER attempted, so running the legacy order
    // is a first execution rather than a duplicate. Surface the anomaly.
    const fallbackCore = await spine.phases.runCore();
    if (spine.phases.shouldPublish(fallbackCore)) spine.phases.publish(fallbackCore);
    return {
      core: fallbackCore,
      engine: 'legacy_order',
      compileError: `graph run ended ${run.status} without reaching compose_reply`,
    };
  }
  if (!published && spine.phases.shouldPublish(core as CoreResult)) {
    // The core ran but publish was not reached (stall/failure downstream).
    // Publication is a user promise, not an optimization: run it, and let the
    // run result carry the anomaly.
    spine.phases.publish(core as CoreResult);
  }
  return { core: core as CoreResult, engine: 'graph', run, trace: run.trace };
}
