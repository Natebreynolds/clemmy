/**
 * Deterministic ProjectPlan → WorkflowDefinition compiler.
 *
 * This is the seam between "the planner decided a topology" and "the runtime
 * already knows how to run bounded, durable, resumable steps". It invents no
 * execution machinery: every node becomes an ordinary `WorkflowStepInput`, and
 * the existing workflow graph decides readiness, parallelism, and ordering from
 * the dependency edges. There is deliberately no second executor.
 *
 * FOUR PROPERTIES THIS FILE OWES ITS CALLERS
 *
 * 1. It compiles the CANONICAL plan, never the caller's ordering. Identity is
 *    derived once, so a dependency permutation cannot produce different bytes.
 *
 * 2. It never grants authority. Every model node is emitted with an explicit,
 *    non-empty, non-wildcard capability list, because downstream an omitted or
 *    empty list is legacy wildcard authority (see `workflowAutoApprovalTools`
 *    in the runner). External provider writes are refused outright — see
 *    UNSUPPORTED SHAPES below.
 *
 * 3. Its output is repair-free against the canonical write contract. If
 *    `prepareWorkflowForWrite` would change anything, compilation fails and the
 *    planner must repair the IR. A compiler whose output the canonical writer
 *    silently rewrites is a compiler that does not know what it emitted.
 *
 * 4. It is a pure function of the plan. Same meaning in, same bytes out —
 *    including the workflow name and every step id. It reads no stored
 *    workflow and touches no disk.
 *
 * UNSUPPORTED SHAPES (fail closed, by design)
 *
 * `external_write` cannot compile today. Such a step would need its prior
 * approval bound to the exact operation, account/resource, target, argument
 * digest and plan digest, plus an independent provider readback.
 * `WorkflowStepInput` has no field that carries any of that: `requiresApproval`
 * is a boolean, `approvalPreview` is display text, and a mutation receipt is
 * evidence recorded AFTER dispatch, not prior authority. Compiling one anyway
 * would put authority in prose, so the shape is refused until the definition
 * can carry the binding. Non-read structured calls are refused at the same
 * boundary, and so is mutating per-item fan-out.
 *
 * There is no domain vocabulary here. The compiler cannot tell one kind of
 * project from another, and nothing downstream needs it to.
 */
import { createHash } from 'node:crypto';

import type {
  WorkflowDefinition,
  WorkflowStepInput,
  WorkflowStepOutputContract,
} from '../memory/workflow-store.js';
import { prepareWorkflowForWrite } from './workflow-enforce.js';
import {
  canonicalPlanJson,
  canonicalProjectPlan,
  planIdError,
  projectPlanHash,
  topologicalNodeOrder,
  validateProjectPlan,
  PROJECT_DISCOVERY_KERNEL,
  PROJECT_NODE_DEFAULT_MAX_TURNS,
  PROJECT_NODE_TURN_CEILING,
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
  /** Content hash of the plan's meaning; stable across every set ordering. */
  planHash: string;
  /** Stable slug derived from the plan. Also the workflow name. */
  workflowName: string;
  /** Emitted step ids, in the order they appear in the definition. */
  stepIds: string[];
}

/** Deterministic slug component when the plan carries no explicit id. */
const PLAN_NAME_PREFIX = 'project';

/**
 * How an effect class lands in the runtime's own vocabulary.
 *
 * Only `read` and `local_write` reach here; `external_write` is rejected during
 * validation. Neither maps to `send`: a plan cannot know that an effect is
 * irreversible, and claiming so would weaken the runtime's own send
 * classification rather than strengthen it.
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
 * The exact capability list this node runs with.
 *
 * Never empty and never omitted: a compiled-project step's `allowedTools` IS
 * its authority, and the runner treats an absent list as the legacy catalog
 * wildcard. A node that named no tools gets the read-only discovery kernel,
 * which can look things up and page upstream artifacts but cannot dispatch a
 * new provider call.
 */
function allowedToolsFor(node: ProjectNode): string[] {
  if (node.executor.kind === 'model' && node.executor.allowedTools?.length) {
    return [...node.executor.allowedTools];
  }
  if (node.executor.kind === 'structured_call') {
    // The step's authority is exactly the one tool it calls.
    return [node.executor.tool];
  }
  return [...PROJECT_DISCOVERY_KERNEL];
}

function compileNode(node: ProjectNode): WorkflowStepInput {
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
    // Every node is bounded independently. An omitted budget is not
    // "unbounded" — it is the deliberately small default. This is a PER-NODE
    // model-turn budget, not a project horizon and not the harness
    // toolCallsPerTurn limit.
    maxTurns: node.maxTurns ?? PROJECT_NODE_DEFAULT_MAX_TURNS,
    allowedTools: allowedToolsFor(node),
  };

  if (node.dependsOn?.length) step.dependsOn = [...node.dependsOn];

  if (node.executor.kind === 'structured_call') {
    step.call = {
      tool: node.executor.tool,
      ...(node.executor.args ? { args: { ...node.executor.args } } : {}),
    };
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

/** Structural self-check on what we are about to hand the canonical writer. */
function emittedStepErrors(steps: readonly WorkflowStepInput[]): string[] {
  const errors: string[] = [];
  for (const step of steps) {
    const tools = step.allowedTools ?? [];
    if (tools.length === 0) {
      errors.push(`compiled step "${step.id}" has no capability list; an empty list is legacy wildcard authority.`);
    }
    if (tools.includes('*')) {
      errors.push(`compiled step "${step.id}" carries wildcard tool authority.`);
    }
    const turns = step.maxTurns ?? 0;
    if (!Number.isSafeInteger(turns) || turns <= 0 || turns > PROJECT_NODE_TURN_CEILING) {
      errors.push(`compiled step "${step.id}" has an unsafe per-node maxTurns (${String(step.maxTurns)}).`);
    }
  }
  return errors;
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

  // Everything below is derived from the CANONICAL plan, so two callers who
  // ordered the same sets differently get byte-identical output.
  const canonical = canonicalProjectPlan(plan);
  const planHash = projectPlanHash(canonical);

  let workflowName: string;
  if (canonical.planId !== undefined) {
    const idError = planIdError(canonical.planId);
    if (idError) throw new ProjectPlanCompileError([idError]);
    workflowName = canonical.planId.trim();
  } else {
    workflowName = `${PLAN_NAME_PREFIX}-${planHash.slice(0, 12)}`;
  }

  // Stable emission order. This is presentation only — `dependsOn` is what the
  // graph actually schedules from.
  const steps = topologicalNodeOrder(canonical.nodes).map(compileNode);

  const structural = emittedStepErrors(steps);
  if (structural.length > 0) throw new ProjectPlanCompileError(structural);

  const definition: WorkflowDefinition = {
    name: workflowName,
    description: canonical.objective.trim(),
    // A compiled plan is dispatched explicitly by whoever owns admission. It
    // never arms its own schedule.
    enabled: true,
    trigger: { manual: true },
    steps,
  };

  // The canonical write contract is the authority on what is runnable. If it
  // would repair anything, the IR — not the compiler output — is what should
  // change, so the planner sees a real error instead of a silent rewrite.
  const prep = prepareWorkflowForWrite(definition);
  if (!prep.ok) {
    throw new ProjectPlanCompileError(
      prep.errors.map((error) => `canonical workflow contract: ${error}`),
    );
  }
  if (prep.repairs.length > 0) {
    throw new ProjectPlanCompileError(
      prep.repairs.map((repair) => `compiler output was not canonical; the writer would repair it: ${repair}`),
    );
  }
  if (canonicalPlanJson(prep.def) !== canonicalPlanJson(definition)) {
    throw new ProjectPlanCompileError([
      'compiler output differs from what the canonical writer would persist; refusing to emit a definition the runtime would rewrite.',
    ]);
  }

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
