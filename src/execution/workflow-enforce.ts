import type { WorkflowDefinition, WorkflowInputDef } from '../memory/workflow-store.js';
import { stepLooksMultiItemWithoutForEach, validateWorkflowDefinition, type WorkflowFrontmatter } from './workflow-validator.js';
import { collectRequiredWorkflowInputs, COMMON_WORKFLOW_INPUT_KEYS } from './workflow-inputs.js';
import { listToolChoices } from '../memory/tool-choice-store.js';
import {
  hardenWeakLiveResearchOutputContract,
  proposeWorkflowContractUpgrades,
  workflowAuthoringAdvisories,
} from './workflow-contract-proposals.js';
import { textMentionsDeliverable } from './workflow-deliverable-hints.js';

/**
 * Author/enable-time enforcement (typed-workflow-contract).
 *
 * A workflow that can't get its data shouldn't be creatable or
 * enablable. The validator computes the errors (token sanity +
 * runnability + send-gate); this wires it into the three WRITE seams —
 * workflow_create + both enable seams — so a broken workflow is refused
 * at the boundary instead of failing at 2am.
 *
 * UNCONDITIONAL (2026-05-31): the WORKFLOW_TYPED_CONTRACT rollout flag was
 * removed — validation is now the single behavior. Every error it raises
 * describes a workflow that would ALREADY fail at run time, so rejecting
 * at create/enable is strictly safer. (feedback_no_rollout_flags: ship the
 * validated behavior as the default path; safety = tests, not flags.)
 */

/** Project a typed WorkflowDefinition onto the validator's loose
 *  frontmatter shape, carrying the step-level inputs/output declarations
 *  so the token-binding checks can see them. */
function toFrontmatter(def: WorkflowDefinition): WorkflowFrontmatter {
  return {
    name: def.name,
    description: def.description,
    enabled: def.enabled,
    trigger: def.trigger,
    inputs: def.inputs as WorkflowFrontmatter['inputs'],
    synthesis: def.synthesis,
    goal: def.goal,
    steps: def.steps.map((s) => ({
      id: s.id,
      prompt: s.prompt,
      dependsOn: s.dependsOn,
      forEach: s.forEach,
      forEachNewOnly: s.forEachNewOnly,
      deterministic: s.deterministic,
      call: s.call,
      usesSkill: s.usesSkill,
      allowedTools: s.allowedTools,
      requiresApproval: s.requiresApproval,
      sideEffect: s.sideEffect,
      inputs: s.inputs as Record<string, unknown> | undefined,
      output: s.output as Record<string, unknown> | undefined,
      loopUntil: s.loopUntil,
      loopSafe: s.loopSafe,
    })),
  };
}

export interface WorkflowWriteCheck {
  ok: boolean;
  errors: string[];
  /** Non-blocking authoring advisories (e.g. "declare an output contract",
   *  "use forEach for batch work"). Surfaced to the authoring agent in the
   *  tool result so it can self-correct before/after save — never blocks. */
  warnings: string[];
}

/**
 * Conservative irreversible-SEND detector for a step prompt.
 *
 * The danger this guards: a workflow that actually emails/messages the
 * outside world but carries NO enforced approval gate — exactly what a
 * model produces when it writes "draft and send the emails" as prose and
 * never sets `requiresApproval`. The validator's `checkApprovalCoherence`
 * only fires when a prompt mentions `request_approval`, so an ungated
 * send slips through clean.
 *
 * Deliberately narrow to avoid false-positives that would block benign
 * workflows (the owner's "don't make simple workflows hard" line): a
 * sending verb must sit near a real outbound-comms noun. "read email",
 * "update the sheet", "create drafts" do NOT match — only an actual send.
 */
// Note: the noun list deliberately excludes "outreach" — it's a common
// workflow-name token (e.g. "midday-outreach") and appears in hand-off
// prose ("sending is midday-outreach's job"), which would false-positive.
// A genuine send always names a concrete object ("send the emails").
const IRREVERSIBLE_SEND_RE =
  /\b(?:send|sends|sending|deliver|delivers|delivering|dispatch|dispatches|dispatching)\b[\s\S]{0,60}\b(?:e-?mails?|messages?|sms|texts?|invites?|dms?|newsletters?)\b/i;
const PUBLISH_RE =
  /\b(?:publish|publishes|publishing|post|posts|posting)\b[\s\S]{0,40}\b(?:tweet|tweets|linkedin|slack|twitter|\bx\b|facebook|instagram|blog\s*post)\b/i;
// Internal notifications to the user don't require approval gates (it's user-only comms)
const USER_ONLY_NOTIFICATION_RE = /\bnotif(?:y|ication)(?:\s+(?:the\s+)?user|to\s+(?:the\s+)?user|\s+the\s+user)?\b/i;

export function stepLooksLikeIrreversibleSend(prompt: string): boolean {
  const p = prompt ?? '';
  // Skip if it's just notifying the user (internal comms, not external)
  if (USER_ONLY_NOTIFICATION_RE.test(p)) return false;
  return IRREVERSIBLE_SEND_RE.test(p) || PUBLISH_RE.test(p);
}

function structuredCallSideEffectClass(call: { tool?: string } | undefined): 'read' | 'write' | 'send' {
  const t = (call?.tool ?? '').toLowerCase();
  if (!t) return 'read';
  if (/(?:_|^)(?:send|publish|post|email|dispatch|deliver|tweet|dm|message)(?:_|$)/.test(t)) return 'send';
  if (/(?:_|^)(?:create|update|delete|remove|write|upsert|insert|add|append|move|archive|patch|put)(?:_|$)/.test(t)) return 'write';
  return 'read';
}

// A step that WRITES to the outside world (creates/updates/deletes a record,
// sheet, file, event, message) — broader than a pure send. Used by the
// creation-time test to PREVIEW (not execute) anything mutating, so a test run
// never sends an email or creates a real artifact while authoring.
const EXTERNAL_WRITE_RE =
  /\b(?:create|creates|creating|add|adds|adding|insert|inserts|upsert|upserts|update|updates|updating|write|writes|writing|save|saves|post|posts|delete|deletes|remove|removes|append|appends|draft|drafts)\b[\s\S]{0,40}\b(?:record|records|row|rows|sheet|spreadsheet|table|crm|airtable|salesforce|hubspot|database|file|files|document|docs?|event|calendar|invite|message|ticket|issue|page|notion)\b/i;

/**
 * True when a step MUTATES external state (send / publish / create / update /
 * delete) and so must NOT be executed for real during a creation-time test —
 * it's previewed instead. Conservative: a declared approval gate, an
 * irreversible send, or a write-verb-near-external-noun all count; a pure
 * read/fetch/query step does not.
 */
export function stepLooksMutating(step: { prompt?: string; sideEffect?: string; requiresApproval?: boolean; requires_approval?: boolean; call?: { tool?: string } }): boolean {
  if (step.sideEffect === 'read') return false;
  if (step.sideEffect === 'write' || step.sideEffect === 'send') return true;
  if (step.requiresApproval === true || step.requires_approval === true) return true;
  if (structuredCallSideEffectClass(step.call) !== 'read') return true;
  const p = step.prompt ?? '';
  return stepLooksLikeIrreversibleSend(p) || EXTERNAL_WRITE_RE.test(p);
}

export type StepSideEffectClass = 'read' | 'write' | 'send' | 'unknown';

/**
 * Canonical step side-effect classifier. ONE source of truth shared by the
 * crash-resume/retry gate (runner `stepSideEffectClass`), the dashboard flow
 * graph, and the proof card so all three agree on what a step DOES.
 *
 * Order matters: an explicit `sideEffect` wins; then a structured `call` is
 * classified from its tool slug FIRST — a `*_send`/`*_post` call is a `send`
 * even with empty prose (the class the UI copies used to collapse to `write`);
 * then prose heuristics; then any external tool/skill/forEach surface is at
 * least a `read`. Only a step with no signal at all is `unknown`.
 */
export function classifyStepSideEffect(step: {
  prompt?: string;
  sideEffect?: string;
  requiresApproval?: boolean;
  requires_approval?: boolean;
  allowedTools?: string[];
  usesSkill?: string;
  forEach?: string;
  call?: { tool?: string };
}): StepSideEffectClass {
  if (step.sideEffect === 'read' || step.sideEffect === 'write' || step.sideEffect === 'send') return step.sideEffect;
  if (step.call?.tool) return structuredCallSideEffectClass(step.call);
  if (stepLooksLikeIrreversibleSend(step.prompt ?? '')) return 'send';
  if (stepLooksMutating(step)) return 'write';
  if ((step.allowedTools?.length ?? 0) > 0 || step.usesSkill || step.forEach) return 'read';
  return 'unknown';
}

// Read/gather intent in a step's prose — the verbs whose job is to PULL external
// data (the thing that silently returns empty when the tool isn't bound).
const READ_INTENT_RE =
  /\b(?:scrape|scrapes|scraping|fetch|fetches|fetching|search|searches|searching|query|queries|querying|pull|pulls|pulling|list|lists|listing|retrieve|retrieves|retrieving|crawl|crawls|crawling|extract|extracts|extracting|collect|collects|collecting|gather|gathers|gathering|download|downloads|downloading|look ?up|looks ?up|lookup|monitor|monitors|monitoring|read|reads|reading|get|gets|getting)\b/i;

// A step's tool surface reaches OUTSIDE the model (so it can actually return real
// data — or silently nothing). Used to decide whether a creation test is worth
// running. A pure-LLM step (no external tools) has nothing real to validate.
function stepReachesExternalTools(step: { allowedTools?: string[]; usesSkill?: string; forEach?: string; call?: { tool?: string } }): boolean {
  if (step.call?.tool) return true;
  if (step.usesSkill) return true;
  if (step.forEach) return true;
  const tools = step.allowedTools ?? [];
  return tools.some((t) =>
    t === '*'
    || /^(?:composio|run_shell_command|mcp|firecrawl|apify|fetch|web_|browser|recall_tool_result)/i.test(t));
}

/**
 * True when a step is worth REALLY running in the creation test: it's read-only
 * (not mutating — those get previewed) AND it actually gathers external data
 * (read-intent prose and/or an external tool surface). This is the eligibility
 * signal for queueing a creation test at all — a workflow with no such step
 * (pure-LLM, or all-mutating) has nothing to validate against real data, so it's
 * enabled directly instead of test-gated.
 */
export function stepIsTestableRead(
  step: { prompt?: string; requiresApproval?: boolean; requires_approval?: boolean; allowedTools?: string[]; usesSkill?: string; forEach?: string; call?: { tool?: string } },
): boolean {
  if (stepLooksMutating(step)) return false;
  if (!stepReachesExternalTools(step)) return false;
  if (step.call?.tool && structuredCallSideEffectClass(step.call) === 'read') return true;
  return READ_INTENT_RE.test(step.prompt ?? '') || (step.allowedTools ?? []).length > 0 || !!step.usesSkill || !!step.forEach;
}

/** Does this workflow have at least one read-only step worth a real creation
 *  test? If not, the create path enables it directly (nothing to validate). */
export function workflowNeedsCreationTest(def: WorkflowDefinition): boolean {
  return (def.steps ?? []).some((s) => stepIsTestableRead(s));
}

function hasEnforcedApprovalGate(def: WorkflowDefinition): boolean {
  return def.steps.some(
    (s) => s.requiresApproval === true || (s as { requires_approval?: boolean }).requires_approval === true,
  );
}

/**
 * Author/enable-time send-gate check. AUTONOMOUS-BY-DEFAULT (CHANGE 3,
 * 2026-06): approval gates are OPT-IN via `requiresApproval: true` on a step;
 * an enabled workflow with send steps and no gate saves cleanly. Strict mode
 * is `allowSends: false` at the workflow root — then any send-looking step
 * without a gate REFUSES the save. (Runtime safety is independent of this
 * authoring check: the verified-sender constraint gate and the grounding gate
 * still run on every actual send, and a declarative gate on a send-class step
 * is never auto-approved on unattended scheduled runs.)
 *
 * Returns the error strings (empty when clean). Validation is unconditional
 * (the old WORKFLOW_TYPED_CONTRACT rollout flag was removed 2026-05-31).
 */
export function checkSendGate(def: WorkflowDefinition): string[] {
  const allowSends = def.allowSends !== false; // default: true (allow autonomous sends)

  if (!def.enabled) return [];
  if (hasEnforcedApprovalGate(def)) return [];
  if (allowSends) return []; // Approval gates are now optional

  // Only block if user explicitly set allowSends: false
  const offending = def.steps.find((s) => stepLooksLikeIrreversibleSend(s.prompt ?? ''));
  if (!offending) return [];

  const snippet = (offending.prompt ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);
  return [
    `Workflow "${def.name}" appears to send/publish to the outside world (step "${offending.id}": `
    + `"${snippet}…") but you have set allowSends: false. Either add \`requiresApproval: true\` `
    + 'on the sending step, or set allowSends: true to allow autonomous sends.',
  ];
}

/**
 * Re-smoke-on-edit (2026-06-11): does an edit change what the workflow
 * actually EXECUTES? Projects the execution-relevant surface (steps' prompts,
 * tools, skills, contracts, fan-out, loop config; workflow-level tools,
 * inputs, synthesis, send policy) and compares. Description / schedule /
 * enabled changes are NOT execution changes — a reschedule must never
 * trigger a re-test. Pure + exported for tests.
 */
function executionSurfaceProjection(def: WorkflowDefinition): string {
  return JSON.stringify({
    steps: (def.steps ?? []).map((s) => ({
      id: s.id,
      prompt: s.prompt,
      project: s.project ?? null,
      dependsOn: s.dependsOn ?? [],
      forEach: s.forEach ?? null,
      forEachNewOnly: s.forEachNewOnly ?? false,
      deterministic: s.deterministic ?? null,
      call: s.call ?? null,
      allowedTools: s.allowedTools ?? [],
      usesSkill: s.usesSkill ?? null,
      inputs: s.inputs ?? null,
      output: s.output ?? null,
      requiresApproval: s.requiresApproval ?? false,
      model: s.model ?? null,
      intent: s.intent ?? null,
      tier: s.tier ?? null,
      useHarness: s.useHarness ?? null,
      maxTurns: s.maxTurns ?? null,
      loopUntil: s.loopUntil ?? null,
      loopSafe: s.loopSafe ?? false,
      sideEffect: s.sideEffect ?? null,
    })),
    project: def.project ?? null,
    allowedTools: def.allowedTools ?? null,
    inputs: def.inputs ?? null,
    synthesis: def.synthesis ?? null,
    allowSends: (def as { allowSends?: boolean }).allowSends !== false,
    // The pinned run goal changes what a run must PROVE (validation +
    // re-pursuit), so editing it is an execution-surface change → re-smoke.
    goal: def.goal ?? null,
  });
}

export function workflowExecutionSurfaceChanged(before: WorkflowDefinition, after: WorkflowDefinition): boolean {
  return executionSurfaceProjection(before) !== executionSurfaceProjection(after);
}

/**
 * Author/enable-time loopUntil law (goal-contract Phase 2). Mirrors the
 * runtime guard (stepLoopUntilEnabled in workflow-runner.ts) so a
 * misconfigured loop is REFUSED at save time with guidance, instead of
 * silently degrading to run-once at runtime:
 *  - loop_until requires an output contract — the contract IS the exit cond
 *  - v1: plain LLM steps only (not forEach / deterministic)
 *  - send steps NEVER loop (re-running a send is re-sending)
 *  - write steps need the author's explicit loop_safe idempotency assertion
 * Disabled drafts are never blocked (same house pattern as the send gate).
 */
export function checkLoopUntilAuthoring(def: WorkflowDefinition): string[] {
  if (!def.enabled) return [];
  const errors: string[] = [];
  for (const step of def.steps ?? []) {
    if (!step.loopUntil) continue;
    // T2.3: a half-declared probe (probe without until, or until without
    // probe) would silently never gate the loop — refuse at authoring. Checked
    // FIRST so a probe-only declaration gets this specific message, not the
    // generic no-exit-condition one.
    if (Boolean(step.loopUntil.probe) !== Boolean(step.loopUntil.until)) {
      errors.push(
        `Step "${step.id}" declares an incomplete loop_until probe — probe and until go together: the probe runs after each attempt and its output must satisfy the until contract for the loop to exit.`,
      );
      continue;
    }
    const hasProbeExit = Boolean(step.loopUntil.probe?.runner?.trim() && step.loopUntil.until);
    const hasContractExit = Boolean(step.output && Object.keys(step.output).length > 0);
    if (!hasContractExit && !hasProbeExit) {
      errors.push(
        `Step "${step.id}" declares loop_until but no output contract / exit condition — declare an "output" block (the contract is the exit), or probe + until (loop_until: { probe: { runner: "<scripts helper>" }, until: {...} }) to loop until external state satisfies the until contract. Or remove loop_until.`,
      );
      continue;
    }
    if (step.forEach || step.deterministic) {
      errors.push(
        `Step "${step.id}" declares loop_until on a ${step.forEach ? 'forEach' : 'deterministic'} step — loop_until applies to plain LLM steps only. Remove loop_until or restructure the step.`,
      );
      continue;
    }
    const cls = step.sideEffect === 'read' || step.sideEffect === 'write' || step.sideEffect === 'send'
      ? step.sideEffect
      : stepLooksLikeIrreversibleSend(step.prompt ?? '') ? 'send'
        : stepLooksMutating(step) ? 'write' : 'read';
    if (cls === 'send') {
      errors.push(
        `Step "${step.id}" declares loop_until on a SEND step — re-running a send is re-sending, so send steps never loop. Remove loop_until; on contract failure the run parks for your attention instead.`,
      );
    } else if (cls === 'write' && step.loopSafe !== true) {
      errors.push(
        `Step "${step.id}" declares loop_until on a WRITE step without loop_safe: true. Re-running a write is only safe when it is idempotent (e.g. an upsert keyed on a stable id) — assert that with loop_safe: true, or set sideEffect: read if the step doesn't actually mutate.`,
      );
    }
  }
  return errors;
}

/**
 * Author/enable-time pinned-goal law (run-scope goal contract). Mirrors the
 * runtime normalizer (workflowRunGoal in workflow-runner.ts) so a goal that
 * would silently no-op at runtime is refused at save time:
 *  - a declared goal needs a real objective (≥4 chars after trim)
 *  - maxAttempts outside 1..3 is refused (runtime clamps, but authoring
 *    should say so instead of silently changing the number)
 * A goal with no success criteria is allowed — validation falls back to
 * judging the objective itself (same semantics as a criteria-less /goal).
 */
export function checkGoalAuthoring(def: WorkflowDefinition): string[] {
  const g = def.goal;
  if (!g) return [];
  const errors: string[] = [];
  if (!g.objective || g.objective.trim().length < 4) {
    errors.push(
      'Workflow declares a goal with no usable objective. Give it a concrete objective (what a completed run must achieve), or remove the goal block.',
    );
  }
  if (g.maxAttempts !== undefined && (!Number.isFinite(g.maxAttempts) || g.maxAttempts < 1 || g.maxAttempts > 3)) {
    errors.push(
      `Goal max_attempts must be 1..3 total run attempts (got ${g.maxAttempts}). Re-pursuit re-runs the WHOLE workflow, so the ceiling is deliberately small.`,
    );
  }
  return errors;
}

/**
 * Author/enable-time RUNNABILITY check — "Clem can never author/enable a
 * workflow she can't actually run."
 *
 * The failure this guards: a workflow declares a required input (no
 * default) but nothing can SUPPLY it at run time. For a manual-trigger
 * workflow the agent/user passes inputs to workflow_run, so any required
 * input is satisfiable. For a SCHEDULE-only trigger there is no caller to
 * pass inputs — the scheduler fires it with none — so a required input
 * with no default and no recognized auto-supply path will ALWAYS fail.
 *
 * Conservative by design (owner's "don't make simple workflows hard"):
 * COMMON_WORKFLOW_INPUT_KEYS (url/website/domain/client/...) are treated
 * as injectable and never blocked; only a non-common required input with
 * no default on a schedule-only trigger is an error. A manual path (even
 * alongside a schedule) means a caller can supply inputs → never blocked.
 */
export function checkRunnabilityConstraints(def: WorkflowDefinition): string[] {
  // CHANGE 5: Validation relaxation
  // These checks are helpful but not blocking — the workflow can still run
  // and the error will surface at execution time if the input is actually missing.
  // This allows users to draft and iterate on workflows without hitting
  // validation blocks. Return as warnings (non-blocking).

  const trigger = def.trigger ?? {};
  const scheduleOnly = Boolean(trigger.schedule) && trigger.manual !== true;
  if (!scheduleOnly) return [];

  const declared = def.inputs ?? {};
  const offenders = collectRequiredWorkflowInputs(def).filter((key) => {
    if (COMMON_WORKFLOW_INPUT_KEYS.has(key)) return false; // injectable
    const meta = declared[key];
    const hasDefault = Boolean(meta && typeof meta.default === 'string' && meta.default.trim().length > 0);
    return !hasDefault;
  });
  if (offenders.length === 0) return [];

  // Return warnings: the workflow can still run, but the inputs will be required at runtime
  return offenders.map((key) => `Scheduled workflow requires input "${key}" but it has no default and no way to be supplied at schedule runtime. Declare it with a default value, or make the workflow manual-trigger to allow callers to supply it.`);
}

/**
 * Deprecated author-time data-binding check.
 *
 * `dependsOn` now carries upstream step outputs into the downstream
 * structured STEP CONTEXT automatically. Explicit `{{steps.x.output}}`
 * tokens and per-step `inputs.from` bindings are still useful when a step
 * needs a precise subpath or a named typed value, but they are no longer
 * required just to receive dependency data. Keep this exported as a no-op
 * during the migration so older callers/tests can be updated without
 * reintroducing the hard failure.
 */
export function checkDependencyBinding(def: WorkflowDefinition): string[] {
  void def;
  return [];
}

/**
 * Author-time AUTO-REPAIR of the mechanically-fixable data-binding gaps —
 * "a user can create a workflow no matter the tools, turns or output."
 *
 * The validator REFUSES a workflow whose data can't flow, which is correct
 * (it would fail at run time) but bounces the author into a re-author loop
 * that burns tokens and can re-fail. Most of those refusals are
 * DETERMINISTICALLY fixable without changing intent:
 *
 *   1. `{{steps.X.output}}` where X is a real step but not a (transitive)
 *      dependency → add X to this step's dependsOn so the token resolves.
 *   2. `forEach: X` where X is a real step but not a dependency → same.
 *   3. `{{input.X}}` referenced but never declared (and not a common key)
 *      → declare it under the workflow inputs so the engine binds it.
 *
 * Each repair is intent-preserving, never introduces a cycle (a dep that
 * would cycle is left for the validator to surface honestly), and is
 * re-validated by the caller afterwards — so a repair can only turn a
 * would-be refusal into a runnable save, never the reverse. Pure: the input
 * def is never mutated; a repaired clone is returned with a human-readable
 * list of what changed.
 */
export interface WorkflowAutoRepair {
  def: WorkflowDefinition;
  repairs: string[];
}

function forEachSourceStepId(expr: string | undefined): string | null {
  const raw = (expr ?? '').trim();
  if (!raw) return null;
  const templated = /^\{\{\s*steps\.([a-zA-Z0-9_-]+)\.output(?:\.[a-zA-Z0-9_.-]+)?\s*\}\}$/.exec(raw);
  if (templated) return templated[1];
  const directPath = /^steps\.([a-zA-Z0-9_-]+)\.output(?:\.[a-zA-Z0-9_.-]+)?$/.exec(raw);
  if (directPath) return directPath[1];
  return /^[a-zA-Z0-9_-]+$/.test(raw) ? raw : null;
}

export function autoRepairWorkflowDefinition(def: WorkflowDefinition): WorkflowAutoRepair {
  const repairs: string[] = [];
  const steps = def.steps.map((s) => ({
    ...s,
    dependsOn: Array.isArray(s.dependsOn) ? [...s.dependsOn] : s.dependsOn,
  }));
  const ids = new Set(steps.map((s) => s.id).filter(Boolean));

  // Wave 3 P0-3: persist a derived side-effect class when the author omitted it,
  // so it's visible + overridable in the SKILL.md and the crash-resume guard has
  // a durable signal (it still falls back to this same heuristic when absent).
  // 'read' is the default and is not serialized, so read-only workflows are
  // byte-identical on disk.
  let sideEffectChanged = false;
  for (const step of steps) {
    if (!step.sideEffect && step.prompt) {
      const cls = stepLooksLikeIrreversibleSend(step.prompt)
        ? 'send'
        : stepLooksMutating(step) ? 'write' : 'read';
      step.sideEffect = cls;
      // Only a write/send default is a MEANINGFUL change — it serializes (read
      // is dropped on write) and arms the crash-resume guard's durable signal.
      // A 'read' default must NOT force a clone, or the byte-identical /
      // same-object contract for clean read-only workflows would break.
      if (cls !== 'read') sideEffectChanged = true;
    }
  }

  const directDeps = (): Map<string, string[]> => {
    const m = new Map<string, string[]>();
    for (const s of steps) if (s.id) m.set(s.id, (s.dependsOn ?? []).filter((d) => ids.has(d)));
    return m;
  };
  const transitiveDeps = (stepId: string, dd: Map<string, string[]>): Set<string> => {
    const out = new Set<string>();
    const stack = [...(dd.get(stepId) ?? [])];
    while (stack.length > 0) {
      const d = stack.pop() as string;
      if (out.has(d)) continue;
      out.add(d);
      for (const x of dd.get(d) ?? []) stack.push(x);
    }
    return out;
  };

  const addDep = (step: (typeof steps)[number], dep: string, why: string): void => {
    if (!step.id || !ids.has(dep) || dep === step.id) return;
    if ((step.dependsOn ?? []).includes(dep)) return;
    const dd = directDeps();
    if (transitiveDeps(step.id, dd).has(dep)) return; // already reachable
    // Refuse to introduce a cycle: if `dep` (transitively) depends on this
    // step, wiring step→dep would close a loop. Leave it for the validator.
    if (transitiveDeps(dep, dd).has(step.id)) return;
    step.dependsOn = [...(step.dependsOn ?? []), dep];
    repairs.push(`Wired step "${step.id}" to depend on "${dep}" (${why}).`);
  };

  for (const step of steps) {
    if (!step.id || !step.prompt) continue;
    // 1. {{steps.X.output}} (optionally with a subpath) referencing a real step.
    const stepRefRe = /\{\{\s*steps\.([a-zA-Z0-9_-]+)\.output(?:\.[a-zA-Z0-9_.-]+)?\s*\}\}/g;
    const seenRefs = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = stepRefRe.exec(step.prompt)) !== null) {
      const ref = m[1];
      if (seenRefs.has(ref)) continue;
      seenRefs.add(ref);
      if (ids.has(ref)) addDep(step, ref, `so {{steps.${ref}.output}} resolves`);
    }
    // 2. forEach over a real step.
    if (typeof step.forEach === 'string' && step.forEach.trim().length > 0) {
      const src = forEachSourceStepId(step.forEach);
      if (src && ids.has(src)) addDep(step, src, `forEach source`);
    }
  }

  // 3. {{input.X}} referenced in a step/synthesis prompt but undeclared →
  //    declare it so the engine binds it and callers know to supply it. This
  //    now includes common keys like url/domain: they are still recognized by
  //    the runner, but should not stay invisible in workflow metadata.
  const declared: Record<string, WorkflowInputDef> = { ...(def.inputs ?? {}) };
  let declaredChanged = false;
  const declareReferencedInputs = (prompt: string | undefined, source: string): void => {
    if (!prompt) return;
    const inputRe = /\{\{\s*input\.([a-zA-Z0-9_-]+)\s*\}\}/g;
    let m: RegExpExecArray | null;
    while ((m = inputRe.exec(prompt)) !== null) {
      const key = m[1];
      if (key in declared) continue;
      declared[key] = { type: 'string' };
      declaredChanged = true;
      repairs.push(`Declared workflow input "${key}" (${source} referenced {{input.${key}}} but never declared it).`);
    }
  };
  for (const step of steps) {
    declareReferencedInputs(step.prompt, `step "${step.id}"`);
  }
  declareReferencedInputs(def.synthesis?.prompt, 'synthesis prompt');

  // Contract hardening: authoring already proposes pinned goals/output contracts
  // for legacy workflows. Apply the same conservative proposals during repair so
  // newly-created workflows start self-verifying instead of relying on prose.
  let contractChanged = false;
  let goalChanged = false;
  let repairedGoal = def.goal;
  // T2.4: multi-item prose without forEach is the single most common
  // loop-authoring defect — the step saves, runs serially in one context, and
  // silently drops the tail of the list. When exactly ONE upstream dependency
  // declares an array-ish output (type 'array' or a min_items contract), the
  // fan-out is mechanically derivable: wire forEach to that upstream.
  // Ambiguous cases (zero or multiple array upstreams) keep today's warning.
  for (const step of steps) {
    if (step.forEach || step.deterministic) continue;
    if (!step.prompt || !stepLooksMultiItemWithoutForEach({ id: step.id, prompt: step.prompt, forEach: step.forEach, output: step.output as Record<string, unknown> | undefined })) continue;
    const arrayUpstreams = (step.dependsOn ?? []).filter((depId) => {
      const dep = steps.find((s) => s.id === depId);
      const out = dep?.output;
      return Boolean(out && (out.type === 'array' || (out.min_items && Object.keys(out.min_items).length > 0)));
    });
    if (arrayUpstreams.length !== 1) continue;
    step.forEach = arrayUpstreams[0];
    repairs.push(
      `Added forEach: "${arrayUpstreams[0]}" to step "${step.id}" — its prompt is multi-item work, and "${arrayUpstreams[0]}" produces the array; the runner now fans out per item (bounded concurrency, per-item resume) instead of running the whole list serially in one context.`,
    );
  }

  const proposalBase: WorkflowDefinition = {
    ...def,
    steps,
    ...(declaredChanged ? { inputs: declared } : {}),
  };
  const contractProposal = proposeWorkflowContractUpgrades(proposalBase);
  const outputByStep = new Map(contractProposal.proposedStepOutputs.map((proposal) => [proposal.stepId, proposal]));
  for (const step of steps) {
    if (step.output && Object.keys(step.output).length > 0) continue;
    const proposal = outputByStep.get(step.id);
    if (!proposal) continue;
    step.output = proposal.output;
    contractChanged = true;
    repairs.push(`Added output contract to step "${step.id}" (${proposal.reasons.join('; ')}).`);
  }
  for (const step of steps) {
    const hardened = hardenWeakLiveResearchOutputContract(proposalBase, step);
    if (!hardened) continue;
    step.output = hardened;
    contractChanged = true;
    repairs.push(`Hardened live research output contract for step "${step.id}" with source-backed evidence keys.`);
  }
  const synthesisLooksDeliverable = textMentionsDeliverable(def.synthesis?.prompt ?? '');
  if (
    !repairedGoal?.objective
    && contractProposal.proposedGoal
    && (contractProposal.proposedStepOutputs.length > 0 || synthesisLooksDeliverable)
  ) {
    repairedGoal = contractProposal.proposedGoal;
    goalChanged = true;
    repairs.push('Pinned a workflow goal so completed runs are judged against concrete success criteria.');
  }

  if (repairs.length === 0 && !sideEffectChanged && !contractChanged && !goalChanged) return { def, repairs };
  const repaired: WorkflowDefinition = {
    ...def,
    steps,
    ...(declaredChanged ? { inputs: declared } : {}),
    ...(goalChanged ? { goal: repairedGoal } : {}),
  };
  return { def: repaired, repairs };
}

/**
 * Gate a workflow write (create / enable). Returns {ok:true} when the
 * workflow validates; otherwise {ok:false, errors} so the caller can
 * refuse and surface the fixes. Validation is unconditional (no flag).
 */
export function checkWorkflowForWrite(def: WorkflowDefinition): WorkflowWriteCheck {
  // Surface the user's proven tool-choices so the validator can warn on a step
  // that should bind one but doesn't. Best-effort — a store read error never
  // blocks a write (the binding check simply no-ops without choices).
  let rememberedToolChoices: ReturnType<typeof listToolChoices> | undefined;
  try {
    rememberedToolChoices = listToolChoices();
  } catch {
    rememberedToolChoices = undefined;
  }
  const result = validateWorkflowDefinition(toFrontmatter(def), { rememberedToolChoices });
  const errors = [...result.errors, ...checkSendGate(def), ...checkLoopUntilAuthoring(def), ...checkGoalAuthoring(def), ...checkDependencyBinding(def)];
  // Runnability constraints are non-blocking (demoted to warnings per graceful degradation design)
  const runnabilityWarnings = checkRunnabilityConstraints(def);
  const warnings = [...result.warnings, ...runnabilityWarnings, ...workflowAuthoringAdvisories(def)];
  return { ok: errors.length === 0, errors, warnings };
}

export interface WorkflowWritePrep extends WorkflowWriteCheck {
  /** The definition to actually persist — the auto-repaired clone (which
   *  may equal the input when nothing needed fixing). */
  def: WorkflowDefinition;
  /** Human-readable list of the binding repairs applied (empty when none). */
  repairs: string[];
}

/**
 * The single entry every write seam should use: auto-repair the
 * mechanically-fixable binding gaps, THEN validate the repaired definition.
 * Callers persist `prep.def` (not their original), refuse on `!prep.ok`, and
 * surface `prep.repairs` + `prep.warnings` as advisories. This makes "save a
 * runnable workflow in one shot" the default across create / update / enable
 * / dashboard / schedule instead of bouncing the author into a re-author
 * loop over a fix the engine could make itself.
 */
export function prepareWorkflowForWrite(def: WorkflowDefinition): WorkflowWritePrep {
  const { def: repaired, repairs } = autoRepairWorkflowDefinition(def);
  const check = checkWorkflowForWrite(repaired);
  return { def: repaired, ok: check.ok, errors: check.errors, warnings: check.warnings, repairs };
}
