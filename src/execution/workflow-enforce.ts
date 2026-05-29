import { getRuntimeEnv } from '../config.js';
import type { WorkflowDefinition } from '../memory/workflow-store.js';
import { validateWorkflowDefinition, type WorkflowFrontmatter } from './workflow-validator.js';

/**
 * Author/enable-time enforcement (typed-workflow-contract P2).
 *
 * A workflow that can't get its data shouldn't be creatable or
 * enablable. The validator already computes the errors (P1 added the
 * token-binding checks in report-only mode); P2 wires it into the three
 * WRITE seams — workflow_create + both enable seams — so a broken
 * workflow is refused at the boundary instead of failing at 2am.
 *
 * Flag-gated on WORKFLOW_TYPED_CONTRACT (default off): when off this is a
 * no-op and create/enable behave exactly as today. The token-binding
 * errors only fire on tokens that ALREADY render empty today, so turning
 * the flag on cannot break a workflow that was actually working.
 */

export function typedContractEnforced(): boolean {
  return (getRuntimeEnv('WORKFLOW_TYPED_CONTRACT', 'on') ?? 'on').toLowerCase() === 'on';
}

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
 * Gate a workflow write (create / enable). Returns {ok:true} when the
 * flag is off (no enforcement) or the workflow validates; otherwise
 * {ok:false, errors} so the caller can refuse and surface the fixes.
 */
export function checkWorkflowForWrite(def: WorkflowDefinition): WorkflowWriteCheck {
  if (!typedContractEnforced()) return { ok: true, errors: [] };
  const result = validateWorkflowDefinition(toFrontmatter(def));
  const errors = [...result.errors, ...checkSendGate(def)];
  return { ok: errors.length === 0, errors };
}
