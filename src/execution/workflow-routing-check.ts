/**
 * Model-routing validator — the "workflow trust" check for SILENT routing
 * regressions (a step that succeeds on the wrong/weaker model and so never
 * trips the failure-triggered self-heal loop).
 *
 * Two deterministic, no-LLM advisories, computed from the workflow definition +
 * the user's active model-role bindings (CLEMMY_MODEL_ROLES):
 *
 *  1. silent_intent_no_match — a step is tagged `intent:"X"` but no active
 *     `worker` binding has `whenIntent:"X"`, so `resolveWorkflowStepModel` falls
 *     back to the default model. The tag looks intentional but routes nothing.
 *     (e.g. a design step tagged intent:"writing" with only a "design" rule.)
 *
 *  2. missed_routing_opportunity — an UNTAGGED step whose id/prompt matches an
 *     active `worker whenIntent` category (using the SAME matcher as the
 *     authoring auto-tagger) — it would use the bound model if tagged, but runs
 *     on the default. (e.g. an untagged "produce" step that generates a design.)
 *
 * Advisory only — never blocks or disables a workflow. Mirrors the runtime
 * routing in `resolveWorkflowStepModel` (a pinned `step.model` wins; otherwise
 * `intent` routes via `resolveRoleModel('worker', intent)`).
 */
import type { WorkflowDefinition, WorkflowStepInput } from '../memory/workflow-store.js';
import { readDurableBindings, resolveRoleModel, type RoleBinding } from '../runtime/harness/model-roles.js';
import { slugifyIntent } from '../memory/tool-choice-store.js';

export type WorkflowRoutingAdvisoryKind = 'silent_intent_no_match' | 'missed_routing_opportunity';

export interface WorkflowRoutingAdvisory {
  kind: WorkflowRoutingAdvisoryKind;
  stepId: string;
  /** The model this step runs on TODAY (the default, in both advisory cases). */
  runsOn: string;
  /** silent_intent_no_match: the tag that matched no active rule. */
  unmatchedIntent?: string;
  /** missed_routing_opportunity: the category + model the step could route to. */
  suggestedIntent?: string;
  suggestedModel?: string;
  /** Human-readable, self-contained advisory line. */
  message: string;
}

// --- matcher, kept byte-identical to autoTagStepsWithModelRoleIntents so the
//     validator's "missed opportunity" never disagrees with the auto-tagger. ---
function slugContainsPhrase(haystackSlug: string, phraseSlug: string): boolean {
  if (!haystackSlug || !phraseSlug) return false;
  return `-${haystackSlug}-`.includes(`-${phraseSlug}-`);
}

function stepMatchesIntent(step: Pick<WorkflowStepInput, 'id' | 'prompt'>, intentSlug: string): boolean {
  if (!intentSlug) return false;
  const haystackSlug = slugifyIntent(`${step.id} ${step.prompt ?? ''}`);
  if (slugContainsPhrase(haystackSlug, intentSlug)) return true;
  const tokens = intentSlug.split('-').filter(Boolean);
  // Multi-word categories ("product design") match a step that says both words;
  // single-word categories stay exact (guards against "s" matching everything).
  return tokens.length > 1 && tokens.every((token) => slugContainsPhrase(haystackSlug, token));
}

/** Only prompt/LLM steps run on a routed model. Deterministic scripts and
 *  structured tool calls execute with zero LLM, so intent routing is a no-op for
 *  them and must never produce an advisory. */
function stepUsesModel(step: WorkflowStepInput): boolean {
  return !step.deterministic && !step.call && Boolean(step.prompt?.trim());
}

/**
 * Analyze a workflow's steps for silent model-routing regressions. Pure +
 * deterministic; `bindings` defaults to the live CLEMMY_MODEL_ROLES. Returns []
 * when the user has no worker intent rules (nothing to route to) — routing
 * advisories only make sense once intent routing is in use.
 */
export function analyzeWorkflowRouting(
  def: Pick<WorkflowDefinition, 'steps'>,
  bindings: RoleBinding[] = readDurableBindings(),
): WorkflowRoutingAdvisory[] {
  const workerIntents = bindings
    .filter((b) => b.role === 'worker' && typeof b.whenIntent === 'string' && (b.whenIntent as string).trim().length > 0)
    .map((b) => ({ modelId: b.modelId, intentSlug: slugifyIntent(b.whenIntent as string) }))
    .filter((b) => b.intentSlug.length > 0)
    // Longest-slug first so "product design" wins over "design" on a step that matches both.
    .sort((a, b) => b.intentSlug.length - a.intentSlug.length);

  if (workerIntents.length === 0) return [];

  // The default worker model this workflow's untagged/mismatched steps fall back
  // to. Env-derived (same source the runtime uses) — display only; the advisory
  // DECISIONS below depend solely on the passed bindings so they stay testable.
  const defaultWorkerModel = resolveRoleModel('worker').modelId;

  const advisories: WorkflowRoutingAdvisory[] = [];
  for (const step of def.steps ?? []) {
    if (!stepUsesModel(step)) continue;
    // An explicit per-step model pin is the author's deliberate choice and always
    // wins over intent (matches resolveWorkflowStepModel) — never second-guess it.
    if (step.model) continue;

    if (step.intent) {
      const intentSlug = slugifyIntent(step.intent);
      const routes = workerIntents.some((b) => b.intentSlug === intentSlug);
      if (!routes) {
        advisories.push({
          kind: 'silent_intent_no_match',
          stepId: step.id,
          runsOn: defaultWorkerModel,
          unmatchedIntent: step.intent,
          message:
            `Step "${step.id}" is tagged intent:"${step.intent}", but no active model rule matches that word — ` +
            `it runs on the default model (${defaultWorkerModel}), not a special one. ` +
            `Retag it to a category you've bound, or add a model rule for "${step.intent}".`,
        });
      }
      continue;
    }

    // Untagged step: does it read like a category the user bound a model to?
    const match = workerIntents.find((b) => stepMatchesIntent(step, b.intentSlug));
    if (match) {
      advisories.push({
        kind: 'missed_routing_opportunity',
        stepId: step.id,
        runsOn: defaultWorkerModel,
        suggestedIntent: match.intentSlug,
        suggestedModel: match.modelId,
        message:
          `Step "${step.id}" reads like "${match.intentSlug}" work and would use ${match.modelId} if tagged — ` +
          `but it's untagged, so it runs on the default model (${defaultWorkerModel}). Add intent:"${match.intentSlug}" to route it.`,
      });
    }
  }
  return advisories;
}

/** One advisory line per finding, for warning channels (preflight / authoring). */
export function renderWorkflowRoutingAdvisories(advisories: WorkflowRoutingAdvisory[]): string[] {
  return advisories.map((a) => a.message);
}

/**
 * The model a step will actually run on, for DISPLAY (the "How it works" view).
 * Mirrors resolveWorkflowStepModel's worker-role precedence — a pinned `model`
 * wins, else an `intent` routes via the worker registry, else the worker default
 * — without importing the heavy runner. Non-LLM steps (deterministic / structured
 * call) run no model and return null. Kept consistent with the routing advisories
 * so "runs on X" in the view matches "runs on the default model (X)" in the nudge.
 */
export function resolveStepDisplayModel(
  step: Pick<WorkflowStepInput, 'model' | 'intent' | 'prompt' | 'deterministic' | 'call'>,
): string | null {
  if (step.deterministic || step.call || !step.prompt?.trim()) return null;
  if (step.model) return step.model;
  if (step.intent) return resolveRoleModel('worker', step.intent).modelId;
  return resolveRoleModel('worker').modelId;
}
