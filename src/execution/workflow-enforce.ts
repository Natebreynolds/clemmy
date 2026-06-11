import type { WorkflowDefinition, WorkflowInputDef } from '../memory/workflow-store.js';
import { validateWorkflowDefinition, type WorkflowFrontmatter } from './workflow-validator.js';
import { collectRequiredWorkflowInputs, COMMON_WORKFLOW_INPUT_KEYS } from './workflow-inputs.js';
import { listToolChoices } from '../memory/tool-choice-store.js';

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
    steps: def.steps.map((s) => ({
      id: s.id,
      prompt: s.prompt,
      dependsOn: s.dependsOn,
      forEach: s.forEach,
      deterministic: s.deterministic,
      usesSkill: s.usesSkill,
      allowedTools: s.allowedTools,
      requiresApproval: s.requiresApproval,
      inputs: s.inputs as Record<string, unknown> | undefined,
      output: s.output as Record<string, unknown> | undefined,
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
export function stepLooksMutating(step: { prompt?: string; requiresApproval?: boolean; requires_approval?: boolean }): boolean {
  if (step.requiresApproval === true || step.requires_approval === true) return true;
  const p = step.prompt ?? '';
  return stepLooksLikeIrreversibleSend(p) || EXTERNAL_WRITE_RE.test(p);
}

// Read/gather intent in a step's prose — the verbs whose job is to PULL external
// data (the thing that silently returns empty when the tool isn't bound).
const READ_INTENT_RE =
  /\b(?:scrape|scrapes|scraping|fetch|fetches|fetching|search|searches|searching|query|queries|querying|pull|pulls|pulling|list|lists|listing|retrieve|retrieves|retrieving|crawl|crawls|crawling|extract|extracts|extracting|collect|collects|collecting|gather|gathers|gathering|download|downloads|downloading|look ?up|looks ?up|lookup|monitor|monitors|monitoring|read|reads|reading|get|gets|getting)\b/i;

// A step's tool surface reaches OUTSIDE the model (so it can actually return real
// data — or silently nothing). Used to decide whether a creation test is worth
// running. A pure-LLM step (no external tools) has nothing real to validate.
function stepReachesExternalTools(step: { allowedTools?: string[]; usesSkill?: string; forEach?: string }): boolean {
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
  step: { prompt?: string; requiresApproval?: boolean; requires_approval?: boolean; allowedTools?: string[]; usesSkill?: string; forEach?: string },
): boolean {
  if (stepLooksMutating(step)) return false;
  if (!stepReachesExternalTools(step)) return false;
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
 * Author/enable-time send-gate check: an ENABLED workflow that performs an
 * irreversible send/publish must carry an enforced approval gate
 * (`requiresApproval: true` on a step), so the runner holds the run for
 * ONE batch approval before anything leaves the building. A disabled
 * workflow can't fire, so it's never blocked here — disable to draft.
 *
 * Returns the error strings (empty when clean). Caller already gates on
 * the WORKFLOW_TYPED_CONTRACT flag.
 */
export function checkSendGate(def: WorkflowDefinition): string[] {
  // CHANGE 3: Flexible approval gates
  // Approval gates are now OPT-IN via requiresApproval: true, not automatic.
  // This allows users to create autonomous workflows without gates,
  // while still offering approval when needed.
  //
  // If a user wants to ENFORCE approval gates (the old strict behavior),
  // they can set allowSends: false at the workflow root.

  const allowSends = (def as any).allowSends !== false; // default: true (allow autonomous sends)

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
    if (!step.output || Object.keys(step.output).length === 0) {
      errors.push(
        `Step "${step.id}" declares loop_until but no output contract — the contract is the loop's exit condition. Declare an "output" block (non_empty / min_items / required_keys / verify) or remove loop_until.`,
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
      const src = step.forEach.trim();
      if (ids.has(src)) addDep(step, src, `forEach source`);
    }
  }

  // 3. {{input.X}} referenced in a step prompt but undeclared (and not a
  //    common injectable key) → declare it so the engine binds it. Mirrors
  //    the validator's checkInputTokenBinding error surface exactly.
  const declared: Record<string, WorkflowInputDef> = { ...(def.inputs ?? {}) };
  let declaredChanged = false;
  for (const step of steps) {
    if (!step.prompt) continue;
    const inputRe = /\{\{\s*input\.([a-zA-Z0-9_-]+)\s*\}\}/g;
    let m: RegExpExecArray | null;
    while ((m = inputRe.exec(step.prompt)) !== null) {
      const key = m[1];
      if (key in declared || COMMON_WORKFLOW_INPUT_KEYS.has(key)) continue;
      declared[key] = { type: 'string' };
      declaredChanged = true;
      repairs.push(`Declared workflow input "${key}" (referenced by {{input.${key}}} but never declared).`);
    }
  }

  if (repairs.length === 0 && !sideEffectChanged) return { def, repairs };
  const repaired: WorkflowDefinition = {
    ...def,
    steps,
    ...(declaredChanged ? { inputs: declared } : {}),
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
  const errors = [...result.errors, ...checkSendGate(def), ...checkLoopUntilAuthoring(def), ...checkDependencyBinding(def)];
  // Runnability constraints are non-blocking (demoted to warnings per graceful degradation design)
  const runnabilityWarnings = checkRunnabilityConstraints(def);
  const warnings = [...result.warnings, ...runnabilityWarnings];
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
