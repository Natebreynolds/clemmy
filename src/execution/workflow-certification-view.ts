/** Host-only, process-free inputs for a workflow catalog's certification memo. */
import { createHash } from 'node:crypto';
import type { WorkflowDefinition } from '../memory/workflow-store.js';
import { slugifyIntent } from '../memory/tool-choice-store.js';
import { readDurableBindings, resolveRoleModel } from '../runtime/harness/model-roles.js';
import {
  buildWorkflowExecutionPlan,
  type WorkflowExecutionPlanOptions,
  type WorkflowToolReadinessInventory,
} from '../dashboard/workflow-execution-plan.js';
import {
  buildWorkflowReadinessInventory,
  evaluateWorkflowPlanReadiness,
  listWorkflowScriptNames,
  type WorkflowRunReadinessCheck,
} from './workflow-run-readiness.js';
import { analyzeWorkflowRouting, renderWorkflowRoutingAdvisories, resolveStepDisplayModel } from './workflow-routing-check.js';

type PlanOptions = Omit<WorkflowExecutionPlanOptions, 'workflowAllowedTools' | 'readiness'>;

/** The opaque key is usable for memoization; its private facts are issued only
 * by the host capture below. Authored workflow/JSON fields cannot supply them. */
export interface WorkflowCertificationDisplayView {
  readonly key: string;
}

interface DisplayInputs {
  readonly definitionDigest: string;
  readonly workflowSlug: string;
  readonly planOptionsDigest: string;
  readonly readiness: WorkflowRunReadinessCheck;
  readonly routingAdvisories: readonly string[];
  readonly stepModels: readonly (string | null)[];
}

const issuedViews = new WeakMap<object, DisplayInputs>();

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function freezeTree<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}

/** A view for another definition/slug/options, or a copied JSON lookalike,
 * never supplies certification facts. Callers fall back to fresh reads. */
export function workflowCertificationDisplayInputs(
  view: unknown,
  def: WorkflowDefinition,
  workflowSlug = def.name,
  planOptions: PlanOptions = {},
): DisplayInputs | null {
  if (!view || typeof view !== 'object') return null;
  const inputs = issuedViews.get(view);
  if (!inputs || inputs.workflowSlug !== workflowSlug
    || inputs.definitionDigest !== digest(def)
    || inputs.planOptionsDigest !== digest(planOptions)) return null;
  return inputs;
}

/**
 * Read shared skills, CLI descriptors/scan, MCP state and projects once. Each
 * workflow then projects only its own readiness/routing result; unrelated
 * connection changes do not discard every workflow's memo. No provider, CLI or
 * model call runs, and no account authentication is inferred from this view.
 */
export function captureWorkflowCertificationView(
  entries: readonly { name: string; data: WorkflowDefinition }[],
  planOptions: PlanOptions = {},
): { forWorkflow(workflowSlug: string): WorkflowCertificationDisplayView | undefined } {
  if (entries.length === 0) return Object.freeze({ forWorkflow: () => undefined });
  const inventory = freezeTree(structuredClone(buildWorkflowReadinessInventory()));
  const bindings = freezeTree(structuredClone(readDurableBindings()));
  const defaultWorker = resolveRoleModel('worker');
  const workers = new Map<string, { modelId: string; provider: string }>([['', defaultWorker]]);
  for (const { data: def } of entries) for (const step of def.steps ?? []) {
    if (step.deterministic || step.call || !step.prompt?.trim() || step.model || def.models?.brain?.trim() || !step.intent) continue;
    const key = slugifyIntent(step.intent);
    if (!workers.has(key)) workers.set(key, resolveRoleModel('worker', step.intent));
  }
  const workerModel = (intent?: string): string => workers.get(intent ? slugifyIntent(intent) : '')!.modelId;
  const views = new Map<string, WorkflowCertificationDisplayView>();
  for (const { name, data: def } of entries) {
    const scopedInventory: WorkflowToolReadinessInventory = {
      ...inventory,
      workflowScripts: listWorkflowScriptNames(name),
    };
    const plan = buildWorkflowExecutionPlan(def.steps, {
      ...planOptions,
      workflowAllowedTools: def.allowedTools,
      workflowProject: def.project,
      workflowGoal: def.goal,
      readiness: scopedInventory,
    });
    const readiness = evaluateWorkflowPlanReadiness(def, plan);
    const routingAdvisories = renderWorkflowRoutingAdvisories(analyzeWorkflowRouting(def, bindings, defaultWorker.modelId));
    const stepModels: Array<string | null> = [];
    const workerFacts: Array<{ stepId: string; modelId: string; provider: string }> = [];
    for (const step of def.steps ?? []) {
      stepModels.push(resolveStepDisplayModel(step, def, workerModel));
      if (!step.deterministic && !step.call && step.prompt?.trim() && !step.model && !def.models?.brain?.trim()) {
        const resolved = workers.get(step.intent ? slugifyIntent(step.intent) : '')!;
        workerFacts.push({ stepId: step.id, modelId: resolved.modelId, provider: resolved.provider });
      }
    }
    const inputs = freezeTree(structuredClone({
      definitionDigest: digest(def), workflowSlug: name, planOptionsDigest: digest(planOptions),
      readiness, routingAdvisories, stepModels,
    }));
    const view = Object.freeze({ key: `display-v1:${digest({ ...inputs, workerFacts })}` });
    issuedViews.set(view, inputs);
    views.set(name, view);
  }
  return Object.freeze({ forWorkflow: (workflowSlug: string) => views.get(workflowSlug) });
}
