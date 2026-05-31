import type { WorkflowDefinition } from '../memory/workflow-store.js';
import { validateWorkflowDefinition, type WorkflowFrontmatter } from './workflow-validator.js';
import { collectRequiredWorkflowInputs, COMMON_WORKFLOW_INPUT_KEYS } from './workflow-inputs.js';

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
      requiresApproval: s.requiresApproval,
      inputs: s.inputs as Record<string, unknown> | undefined,
      output: s.output as Record<string, unknown> | undefined,
    })),
  };
}

export interface WorkflowWriteCheck {
  ok: boolean;
  errors: string[];
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

function stepLooksLikeIrreversibleSend(prompt: string): boolean {
  const p = prompt ?? '';
  return IRREVERSIBLE_SEND_RE.test(p) || PUBLISH_RE.test(p);
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
  if (!def.enabled) return [];
  if (hasEnforcedApprovalGate(def)) return [];
  const offending = def.steps.find((s) => stepLooksLikeIrreversibleSend(s.prompt ?? ''));
  if (!offending) return [];
  const snippet = (offending.prompt ?? '').replace(/\s+/g, ' ').trim().slice(0, 100);
  return [
    `Workflow "${def.name}" appears to send/publish to the outside world (step "${offending.id}": `
    + `"${snippet}…") but no step has an enforced approval gate. Set \`requiresApproval: true\` `
    + '(+ a short `approvalPreview`) on the sending step so the runner surfaces ONE batch approval and '
    + 'holds the run before anything goes out — the step agent never sends unattended. '
    + '(Set the workflow `enabled: false` to bypass this while drafting.)',
  ];
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

  return [
    `Workflow "${def.name}" runs on a schedule with no manual trigger, but required input`
    + `${offenders.length === 1 ? '' : 's'} ${offenders.map((k) => `"${k}"`).join(', ')} `
    + `${offenders.length === 1 ? 'has' : 'have'} no default and no way to be supplied on a scheduled run — `
    + 'it would fail every time it fires. Give each a default (inputs.<name>.default), or add a manual '
    + 'trigger so a caller can pass them.',
  ];
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
 * Gate a workflow write (create / enable). Returns {ok:true} when the
 * workflow validates; otherwise {ok:false, errors} so the caller can
 * refuse and surface the fixes. Validation is unconditional (no flag).
 */
export function checkWorkflowForWrite(def: WorkflowDefinition): WorkflowWriteCheck {
  const result = validateWorkflowDefinition(toFrontmatter(def));
  const errors = [...result.errors, ...checkSendGate(def), ...checkRunnabilityConstraints(def), ...checkDependencyBinding(def)];
  return { ok: errors.length === 0, errors };
}
