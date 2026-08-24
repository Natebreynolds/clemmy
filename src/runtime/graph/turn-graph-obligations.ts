/**
 * Evidence obligations, attached to the nodes that actually incur them.
 *
 * An earlier attempt compiled a universal five-phase workflow from verb regexes
 * in the objective text. That invents phases for tasks which do not have them,
 * and — worse — it applies one shape of proof to every effect: it would demand
 * a cell read-back of an irreversible send, which is not a thing you can do.
 * You cannot un-send a message to check what you sent.
 *
 * So obligations are derived from what a NODE is: its effect kind, its
 * reversibility, and its receipt class. A read node owes completeness. A
 * reversible write owes a read-back. An irreversible send owes a durable
 * receipt and reconciliation instead. Nothing here reads the objective's words.
 */
import type { TurnGraphIR, TurnGraphNode } from './turn-graph-ir.js';

export type EvidenceObligation =
  /** One exact point result was durably observed; pagination is inapplicable. */
  | 'source_observed'
  /** The source was read to exhaustion, not to the first page. */
  | 'source_completeness'
  /** The output derives from THIS run's source evidence. */
  | 'derivation_from_current_source'
  /** The external effect was committed and acknowledged. */
  | 'commit_effect'
  /** The written target was read back and matched. */
  | 'verify_committed_readback'
  /** A documented atomic-input create acknowledged this exact submitted content. */
  | 'verify_committed_content'
  /** A durable receipt exists for an effect that cannot be read back. */
  | 'verify_committed_receipt'
  /** Destination content predating this run was reconciled, not inherited. */
  | 'stale_destination_reconciled'
  /** Every execution opened for this task reached a terminal state. */
  | 'execution_terminal';

export interface NodeObligation {
  nodeId: string;
  obligation: EvidenceObligation;
  /** Why this node owes it — for traces and for what Clem can explain. */
  because: string;
}

export interface AttachEvidenceObligationsInput {
  graph?: TurnGraphIR;
  /** Single-node convenience for callers holding one effect. */
  effect?: string;
  reversibility?: string;
  receipt?: string;
  nodeId?: string;
  /** Refined operation semantics from the host-observed capability. */
  operationMode?: 'point_read' | 'collection_read' | 'finite_read' | 'compute' | 'create' | 'append'
    | 'update' | 'replace' | 'delete' | 'send' | 'unknown_write' | 'none';
  /** Whether this accepted task actually observed a source read upstream. */
  hasSourceRead?: boolean;
  /** True only for replacement-shaped mutations where old content may survive. */
  requiresStaleReconciliation?: boolean;
  /** True when the frozen contract declared resolved-operation coverage for
   * this read: the proof owed is durable observation, not source exhaustion. */
  observationSufficient?: boolean;
  /** Exact documented atomic input-to-created-content operation. */
  contentCommitMode?: 'documented_atomic_input';
}

function obligationsForNode(node: {
  id: string;
  effectKind: string;
  reversibility: string;
  receipt: string;
  operationMode?: AttachEvidenceObligationsInput['operationMode'];
  hasSourceRead?: boolean;
  requiresStaleReconciliation?: boolean;
  observationSufficient?: boolean;
  contentCommitMode?: AttachEvidenceObligationsInput['contentCommitMode'];
}): NodeObligation[] {
  const out: NodeObligation[] = [];
  const { id } = node;

  // A read owes completeness: a partial snapshot silently becomes a wrong
  // answer downstream, and nothing later can detect it. The exception is a
  // contract that only ever promised resolved-operation coverage — one
  // grounded retrieval, not an exhaustive set — where the proof owed is that
  // the exact result was durably observed. Demanding exhaustion there blocks
  // honest answers a provider cannot even express as complete (live
  // 2026-08-12: a bounded calendar view returned every event with no cursor,
  // completeness 'unknown', and the terminal held a correct answer).
  if (node.effectKind === 'read') {
    const observedOnly = node.operationMode === 'point_read'
      || node.operationMode === 'finite_read'
      || node.observationSufficient === true;
    out.push({
      nodeId: id,
      obligation: observedOnly ? 'source_observed' : 'source_completeness',
      because: observedOnly
        ? 'the exact retrieved result must be durably observed'
        : 'a read that stops early produces a confident, incomplete answer',
    });
  }

  if (node.effectKind === 'external_write' || node.effectKind === 'local_write') {
    if (node.hasSourceRead !== false) {
      out.push({
        nodeId: id,
        obligation: 'derivation_from_current_source',
        because: 'what is written must come from this run, not a previous artifact',
      });
    }
    out.push({
        nodeId: id,
        obligation: 'commit_effect',
        because: 'the effect is the point of the task',
      });

    // The proof depends on what the effect IS.
    if (node.contentCommitMode === 'documented_atomic_input') {
      out.push({
        nodeId: id,
        obligation: 'verify_committed_content',
        because: 'the documented atomic create must acknowledge the exact provider-ready submitted content',
      });
    } else if (node.reversibility === 'irreversible') {
      out.push({
        nodeId: id,
        obligation: 'verify_committed_receipt',
        because: 'an irreversible effect cannot be re-read; a durable receipt is the only proof available',
      });
    } else {
      out.push({
          nodeId: id,
          obligation: 'verify_committed_readback',
          because: 'a reversible target can be read back, so an acknowledgement alone is not verification',
        });
      if (node.requiresStaleReconciliation !== false) {
        out.push({
          nodeId: id,
          obligation: 'stale_destination_reconciled',
          because: 'a shorter rewrite inherits whatever the destination already held',
        });
      }
    }

    out.push({
      nodeId: id,
      obligation: 'execution_terminal',
      because: 'an execution left active can repeat the effect on a later tick',
    });
  }

  return out;
}

/**
 * Obligations for a graph, or for a single described effect.
 *
 * Returns an empty list for a task with no effects — a conversational turn owes
 * no evidence, and inventing an obligation for it would block honest answers.
 */
export function attachEvidenceObligations(
  input: AttachEvidenceObligationsInput,
): NodeObligation[] {
  if (input.graph) {
    return input.graph.nodes.flatMap((node: TurnGraphNode) => obligationsForNode({
      id: node.id,
      effectKind: node.effect.kind,
      reversibility: node.effect.reversibility,
      receipt: node.effect.receipt,
    }));
  }

  // Single-effect form. `irreversible_send` is accepted as a caller shorthand
  // for "an external write that cannot be re-read".
  const effect = input.effect ?? 'none';
  const isSend = effect === 'irreversible_send';
  return obligationsForNode({
    id: input.nodeId ?? 'node:effect',
    effectKind: isSend ? 'external_write' : effect,
    reversibility: input.reversibility ?? (isSend ? 'irreversible' : 'reversible'),
    receipt: input.receipt ?? 'durable_effect_receipt',
    ...(input.operationMode ? { operationMode: input.operationMode } : {}),
    ...(input.hasSourceRead !== undefined ? { hasSourceRead: input.hasSourceRead } : {}),
    ...(input.requiresStaleReconciliation !== undefined
      ? { requiresStaleReconciliation: input.requiresStaleReconciliation }
      : {}),
    ...(input.observationSufficient !== undefined
      ? { observationSufficient: input.observationSufficient }
      : {}),
    ...(input.contentCommitMode ? { contentCommitMode: input.contentCommitMode } : {}),
  });
}
