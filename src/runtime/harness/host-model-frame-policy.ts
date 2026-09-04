import {
  hostControlFrameFor,
  hostModelFrameClassFor,
  type HostModelFrameClass,
} from '../../tools/tool-registry.js';
import { isPlainOrClementineLocalTool } from './runtime-tool-identity.js';
import type { RuntimeToolEffect } from './tool-effect.js';

/** Immutable facts projected from one admitted model frame before any tool
 * admission. Tool-object provenance is supplied by the host runner; model
 * arguments can never set `proposalFreeWorkCarrier`. */
export interface HostModelFrameCall {
  callId: string;
  name: string;
  /** Strict-schema-materialized JSON used by the execution boundary. */
  argumentsJson: string;
  argumentsValue: Record<string, unknown> | null;
  effectiveName: string | null;
  effect: RuntimeToolEffect;
  proposalFreeWorkCarrier: boolean;
}

export type HostModelFrameRefusal =
  | 'host_control_requires_sole_call_frame'
  | 'fresh_plan_already_activated'
  | 'fresh_plan_must_be_first'
  | 'fresh_plan_allows_exactly_one_sibling'
  | 'fresh_plan_sibling_requires_proposal_free_work_carrier'
  | 'fresh_plan_sibling_must_be_read_compute'
  | 'fresh_plan_sibling_requires_dependency_root'
  | 'host_planned_work_call_requires_plan_sibling'
  /** The carrier's inner operation could not even be identified (a
   * composio_execute_tool with no tool_slug, an empty inner name): a
   * malformed call, never a plan-shaped mutation. */
  | 'host_work_call_inner_operation_unidentified';

export type HostModelFrameDisposition =
  | { kind: 'ordinary' }
  | { kind: 'standalone_control'; call: HostModelFrameCall }
  | {
      kind: 'fresh_plan_then_root_read';
      plan: HostModelFrameCall;
      sibling: HostModelFrameCall;
      prePlanEffect: 'read' | 'compute';
      requirementId: string;
    }
  | { kind: 'refused'; reason: HostModelFrameRefusal };

function declaredFrameClass(name: string | null): HostModelFrameClass {
  if (!name) return 'ordinary';
  const declared = hostModelFrameClassFor(name);
  if (declared !== 'ordinary') return declared;
  return hostControlFrameFor(name) === 'sole' ? 'exclusive_control' : 'ordinary';
}

function exactRootOperation(input: {
  plan: HostModelFrameCall;
  sibling: HostModelFrameCall;
}): { requirementId: string } | null {
  const planInput = input.plan.argumentsValue;
  const siblingInput = input.sibling.argumentsValue;
  if (!planInput || !siblingInput) return null;
  // The proposal-free schema is an authority property of the configured tool,
  // but reject model bytes that nevertheless try to smuggle the old proposal
  // grammar through the conditional surface.
  if (Object.prototype.hasOwnProperty.call(siblingInput, 'proposal')) return null;
  const requirementId = typeof siblingInput.requirement_id === 'string'
    ? siblingInput.requirement_id.trim()
    : '';
  if (!requirementId) return null;
  const draft = planInput.draft;
  if (!draft || typeof draft !== 'object' || Array.isArray(draft)) return null;
  const draftRecord = draft as Record<string, unknown>;
  const topology = draftRecord.topology;
  const operations = topology && typeof topology === 'object' && !Array.isArray(topology)
    ? (topology as Record<string, unknown>).operations
    : draftRecord.operations;
  if (!Array.isArray(operations)) return null;
  const matches = operations.filter((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return false;
    const operation = candidate as Record<string, unknown>;
    return operation.id === requirementId
      && operation.effect === input.sibling.effect
      && Array.isArray(operation.dependsOn)
      && operation.dependsOn.length === 0
      && (
        operation.dataFrom === undefined
        || (Array.isArray(operation.dataFrom) && operation.dataFrom.length === 0)
      );
  });
  return matches.length === 1 ? { requirementId } : null;
}

/**
 * Decide the whole model frame before any sibling logical row, physical row,
 * approval predicate, provider gateway, or body is allowed to run.
 *
 * A fresh plan remains an exclusive barrier. The two-call form is a scheduling
 * declaration only: the sibling receives no authority here and must be fully
 * re-attested against the activated durable plan at the last edge.
 */
export function classifyHostModelFrame(input: {
  calls: readonly HostModelFrameCall[];
  planActivated: boolean;
  allowFreshPlanReadFusion: boolean;
}): HostModelFrameDisposition {
  // A CARRIED CONTROL IS THAT CONTROL. This used to refuse a frame whose direct
  // name was ordinary but whose effective name was a control — while computing
  // that effective identity one line above. The host already knew the model
  // meant plan_task, with its arguments attached, and threw the frame away over
  // the envelope. Three consecutive live runs on 2026-09-03 died there, each
  // carrying a correct multi-step plan.
  //
  // Nothing downstream needs the refusal: `standalone_control` has no consumer
  // that keys on the direct name, and call_tool already resolves its inner
  // target through inner-dispatch. So classify by what the call MEANS and let
  // it run. The standing gate is validate-before-write, not envelope shape.
  const decorated = input.calls.map((call) => {
    const directClass = declaredFrameClass(call.name);
    const effectiveClass = declaredFrameClass(call.effectiveName);
    return {
      call,
      directClass: directClass === 'ordinary' ? effectiveClass : directClass,
      effectiveClass,
    };
  });

  const controls = decorated.filter((entry) => entry.directClass !== 'ordinary');
  const freshPlans = controls.filter((entry) => entry.directClass === 'fresh_plan_barrier');
  const exclusiveControls = controls.filter((entry) => entry.directClass === 'exclusive_control');
  if (exclusiveControls.length > 0) {
    return exclusiveControls.length === 1 && input.calls.length === 1
      ? { kind: 'standalone_control', call: exclusiveControls[0]!.call }
      : { kind: 'refused', reason: 'host_control_requires_sole_call_frame' };
  }
  if (freshPlans.length === 0) {
    const directWorkCallLookalike = input.calls.some((call) => (
      isPlainOrClementineLocalTool(call.name, 'work_call')
      && !call.proposalFreeWorkCarrier
    ));
    if (directWorkCallLookalike) {
      return { kind: 'refused', reason: 'host_planned_work_call_requires_plan_sibling' };
    }
    // A proposal-free carrier is also the only foreground door for an exact
    // live provider read. Reads/compute do not acquire graph authority merely
    // by crossing that carrier: the inner dispatcher still re-proves the
    // current operation, account, schema and effect under the host root. A
    // mutation follows that same ordinary frame path: allow/deny/ask belongs
    // at the exact tool edge, not in a chat-side graph compiler.
    if (!input.planActivated) {
      const unidentified = input.calls.find((call) => (
        call.proposalFreeWorkCarrier
        && call.effect === 'unknown'
        && call.effectiveName === null
      ));
      if (unidentified) {
        // Live 2026-09-01 ("last three Slack messages", GLM 5.3): the inner
        // composio_execute_tool carried no tool_slug, so no operation and no
        // effect could be identified. Calling that "requires a plan sibling"
        // sent the model looking for a plan_task it did not have; it retried
        // the identical call and the governor stopped the turn. A call whose
        // operation is unidentified is refused as exactly that.
        return {
          kind: 'refused',
          reason: 'host_work_call_inner_operation_unidentified',
        };
      }
    }
    return { kind: 'ordinary' };
  }
  if (freshPlans.length !== 1) {
    return { kind: 'refused', reason: 'host_control_requires_sole_call_frame' };
  }
  if (input.planActivated) {
    return { kind: 'refused', reason: 'fresh_plan_already_activated' };
  }
  const planIndex = decorated.indexOf(freshPlans[0]!);
  if (planIndex !== 0) return { kind: 'refused', reason: 'fresh_plan_must_be_first' };
  if (input.calls.length === 1) {
    return { kind: 'standalone_control', call: freshPlans[0]!.call };
  }
  if (!input.allowFreshPlanReadFusion) {
    return { kind: 'refused', reason: 'host_control_requires_sole_call_frame' };
  }
  if (input.calls.length !== 2) {
    return { kind: 'refused', reason: 'fresh_plan_allows_exactly_one_sibling' };
  }
  const sibling = input.calls[1]!;
  if (!sibling.proposalFreeWorkCarrier) {
    return {
      kind: 'refused',
      reason: 'fresh_plan_sibling_requires_proposal_free_work_carrier',
    };
  }
  if (sibling.effect !== 'read' && sibling.effect !== 'compute') {
    return { kind: 'refused', reason: 'fresh_plan_sibling_must_be_read_compute' };
  }
  const root = exactRootOperation({ plan: freshPlans[0]!.call, sibling });
  if (!root) {
    return { kind: 'refused', reason: 'fresh_plan_sibling_requires_dependency_root' };
  }
  return {
    kind: 'fresh_plan_then_root_read',
    plan: freshPlans[0]!.call,
    sibling,
    prePlanEffect: sibling.effect,
    requirementId: root.requirementId,
  };
}
