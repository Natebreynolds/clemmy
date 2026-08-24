import {
  hostControlFrameFor,
  hostModelFrameClassFor,
  type HostModelFrameClass,
} from '../../tools/tool-registry.js';
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
  | 'host_control_requires_direct_first_class_call'
  | 'host_control_requires_sole_call_frame'
  | 'fresh_plan_already_activated'
  | 'fresh_plan_must_be_first'
  | 'fresh_plan_allows_exactly_one_sibling'
  | 'fresh_plan_sibling_requires_proposal_free_work_carrier'
  | 'fresh_plan_sibling_must_be_read_compute'
  | 'fresh_plan_sibling_requires_dependency_root'
  | 'host_planned_work_call_requires_plan_sibling';

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
  const decorated = input.calls.map((call) => ({
    call,
    directClass: declaredFrameClass(call.name),
    effectiveClass: declaredFrameClass(call.effectiveName),
  }));
  if (decorated.some((entry) => (
    entry.directClass === 'ordinary' && entry.effectiveClass !== 'ordinary'
  ))) {
    return { kind: 'refused', reason: 'host_control_requires_direct_first_class_call' };
  }

  const controls = decorated.filter((entry) => entry.directClass !== 'ordinary');
  const freshPlans = controls.filter((entry) => entry.directClass === 'fresh_plan_barrier');
  const exclusiveControls = controls.filter((entry) => entry.directClass === 'exclusive_control');
  if (exclusiveControls.length > 0) {
    return exclusiveControls.length === 1 && input.calls.length === 1
      ? { kind: 'standalone_control', call: exclusiveControls[0]!.call }
      : { kind: 'refused', reason: 'host_control_requires_sole_call_frame' };
  }
  if (freshPlans.length === 0) {
    if (!input.planActivated && input.calls.some((call) => call.proposalFreeWorkCarrier)) {
      return { kind: 'refused', reason: 'host_planned_work_call_requires_plan_sibling' };
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
