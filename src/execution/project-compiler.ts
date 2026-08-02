/**
 * Deterministic ProjectPlan → WorkflowDefinition compiler.
 *
 * This is the seam between "the planner decided a topology" and "the runtime
 * already knows how to run bounded, durable, resumable steps". It invents no
 * execution machinery: every node becomes an ordinary `WorkflowStepInput`, and
 * the existing workflow graph compiler decides readiness, parallelism, and
 * ordering from the dependency edges. There is deliberately no second executor.
 *
 * THREE PROPERTIES THIS FILE OWES ITS CALLERS
 *
 * 1. It never grants authority. A plan may declare `external_write`; the most
 *    that produces is an approval-bearing step whose actual permission is still
 *    decided at the runtime tool boundary. Compilation is conservative in one
 *    direction only — it can add an approval, never remove one.
 *
 * 2. It never serializes work that the plan left independent. JSON arrays are
 *    ordered; dependency graphs are not. Steps are emitted in a stable
 *    topological order purely so output is byte-stable, and `dependsOn` carries
 *    the real constraints, so three independent nodes remain concurrently ready.
 *
 * 3. It is a pure function of the plan. Same meaning in, same bytes out —
 *    including the workflow name and every step id — so a re-plan that changed
 *    nothing produces an identical definition and a caller can compare hashes
 *    instead of diffing prose. It reads no stored workflow and touches no disk.
 *
 * There is no domain vocabulary here. The compiler cannot tell a data pipeline
 * from a research portal, and nothing downstream needs it to.
 */
import { createHash } from 'node:crypto';

import type {
  WorkflowDefinition,
  WorkflowStepInput,
  WorkflowStepOutputContract,
} from '../memory/workflow-store.js';
import {
  canonicalPlanJson,
  defaultApprovalFor,
  projectPlanHash,
  topologicalNodeOrder,
  validateProjectPlan,
  PROJECT_NODE_DEFAULT_MAX_TURNS,
  type ProjectEffectClass,
  type ProjectEvidenceContract,
  type ProjectNode,
  type ProjectPlan,
} from './project-plan-ir.js';

export class ProjectPlanCompileError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(`Project plan is not compilable:\n- ${errors.join('\n- ')}`);
    this.name = 'ProjectPlanCompileError';
    this.errors = errors;
  }
}

export interface CompiledProjectPlan {
  definition: WorkflowDefinition;
  /** Content hash of the plan's meaning; stable across key order. */
  planHash: string;
  /** Stable slug derived from the plan. Also the workflow name. */
  workflowName: string;
  /** Emitted step ids, in the order they appear in the definition. */
  stepIds: string[];
}

/** Deterministic slug component when the plan carries no explicit id. */
const PLAN_NAME_PREFIX = 'project';

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

/**
 * How an effect class lands in the runtime's own vocabulary.
 *
 * `local_write` and `external_write` both become `write`; the difference that
 * matters at the boundary is the approval, not the label. Neither maps to
 * `send`: a plan cannot know that an effect is irreversible, and claiming so
 * would weaken the runtime's own send classification rather than strengthen it.
 * The prose heuristics in workflow-enforce still apply on top of this.
 */
function sideEffectFor(effect: ProjectEffectClass): WorkflowStepInput['sideEffect'] {
  return effect === 'read' ? 'read' : 'write';
}

/** Translate the plan's evidence contract into the runtime's output contract. */
function outputContractFor(
  evidence: ProjectEvidenceContract | undefined,
): WorkflowStepOutputContract | undefined {
  if (!evidence) return undefined;
  const contract: WorkflowStepOutputContract = {};
  if (evidence.type) contract.type = evidence.type;
  if (evidence.requiredKeys?.length) contract.required_keys = [...evidence.requiredKeys];
  if (evidence.nonEmpty?.length) contract.non_empty = [...evidence.nonEmpty];
  if (evidence.minItems && Object.keys(evidence.minItems).length > 0) {
    contract.min_items = { ...evidence.minItems };
  }
  const pathExists = evidence.verify?.pathExists ?? [];
  const urlPresent = evidence.verify?.urlPresent ?? [];
  if (pathExists.length > 0 || urlPresent.length > 0) {
    contract.verify = {
      ...(pathExists.length > 0 ? { path_exists: [...pathExists] } : {}),
      ...(urlPresent.length > 0 ? { url_present: [...urlPresent] } : {}),
    };
  }
  if (evidence.description) contract.description = evidence.description;
  return Object.keys(contract).length > 0 ? contract : undefined;
}

/**
 * The `forEach` expression for a dynamic node.
 *
 * Reuses the runtime's existing upstream-output templating rather than adding a
 * second iteration mechanism, so a per-item node is an ordinary forEach step
 * with all of its existing watermark and resume behaviour.
 */
function forEachExpression(node: ProjectNode): string | undefined {
  const fanOut = node.fanOut;
  if (!fanOut) return undefined;
  const suffix = fanOut.path ? `.${fanOut.path}` : '';
  return `{{steps.${fanOut.fromNode}.output${suffix}}}`;
}

/**
 * Default approval preview for a node that requires one but supplied no text.
 *
 * Deliberately describes the SHAPE of the pending effect — it has no vocabulary
 * for what the effect is about, and an operator reading it should be pointed at
 * the node's own assignment rather than at a guess made here.
 */
function fallbackApprovalPreview(node: ProjectNode): string {
  return `Approve the external effect requested by step "${node.id}" before it runs.`;
}

function compileNode(node: ProjectNode): WorkflowStepInput {
  const approval = node.approval ?? defaultApprovalFor(node.effect);
  const requiresApproval = approval === 'required';

  const step: WorkflowStepInput = {
    id: node.id,
    // A structured call still carries a prompt: the runtime uses it for
    // operator-facing description, and it is the only place a node's assignment
    // is written down when no model turn runs.
    prompt: node.executor.kind === 'model'
      ? node.executor.instruction
      : node.executor.instruction?.trim()
        || `Invoke ${node.executor.tool} with the arguments fixed by the plan.`,
    sideEffect: sideEffectFor(node.effect),
    // Every node is bounded. An omitted budget is not "unbounded" — it is the
    // deliberately small default, because a node needing more turns is a node
    // that should have been split.
    maxTurns: node.maxTurns ?? PROJECT_NODE_DEFAULT_MAX_TURNS,
  };

  if (node.dependsOn?.length) step.dependsOn = [...node.dependsOn];

  if (node.executor.kind === 'structured_call') {
    // Exact tool + frozen args: no model turn, nothing to rediscover.
    step.call = {
      tool: node.executor.tool,
      ...(node.executor.args ? { args: { ...node.executor.args } } : {}),
    };
  } else if (node.executor.allowedTools?.length) {
    step.allowedTools = [...node.executor.allowedTools];
  }

  if (requiresApproval) {
    step.requiresApproval = true;
    step.approvalPreview = node.approvalPreview?.trim() || fallbackApprovalPreview(node);
  }

  const output = outputContractFor(node.evidence);
  if (output) step.output = output;

  const forEach = forEachExpression(node);
  if (forEach) {
    step.forEach = forEach;
    if (node.fanOut?.newOnly) step.forEachNewOnly = true;
  }

  if (node.retries !== undefined) step.retryBudget = node.retries;

  return step;
}

/**
 * Compile a validated plan into a runnable workflow definition.
 *
 * Throws `ProjectPlanCompileError` with every problem when the plan is not
 * compilable. Nothing partial is emitted: a plan is either safe to run or it is
 * not, and half a project is worse than none.
 */
export function compileProjectPlan(plan: ProjectPlan): CompiledProjectPlan {
  const validation = validateProjectPlan(plan);
  if (!validation.ok) throw new ProjectPlanCompileError(validation.errors);

  const planHash = projectPlanHash(plan);
  const workflowName = plan.planId?.trim()
    ? slugify(plan.planId)
    : `${PLAN_NAME_PREFIX}-${planHash.slice(0, 12)}`;

  // Stable emission order. This is presentation only — `dependsOn` below is
  // what the graph actually schedules from.
  const ordered = topologicalNodeOrder(plan.nodes);
  const steps = ordered.map(compileNode);

  const definition: WorkflowDefinition = {
    name: workflowName,
    description: plan.objective.trim(),
    // A compiled plan is dispatched explicitly by the caller that owns
    // admission. It never arms its own schedule.
    enabled: true,
    trigger: { manual: true },
    steps,
  };

  return {
    definition,
    planHash,
    workflowName,
    stepIds: steps.map((step) => step.id),
  };
}

/**
 * Content hash of a COMPILED definition, for callers that want to prove two
 * compilations produced the same runnable artifact without comparing objects.
 */
export function compiledProjectDefinitionHash(definition: WorkflowDefinition): string {
  return createHash('sha256').update(canonicalPlanJson(definition), 'utf8').digest('hex');
}
