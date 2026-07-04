/**
 * Workflow self-heal (flag: WORKFLOW_SELF_HEAL, default off).
 *
 * Clem's north star includes "reports back without fail" and being
 * ever-learning / self-healing. Today a workflow step that returns
 * `{blocked:true}` still marks the run "completed" and dumps raw JSON to
 * the user — three failures of that promise at once (wrong status, no
 * diagnosis, unreadable). This module closes the loop:
 *
 *   1. detectBlockedSteps()        — find steps that blocked (pure)
 *   2. diagnoseWorkflowBlock()     — an agent reads the failing step +
 *                                    the real tool error and produces a
 *                                    plain-English root cause + a concrete
 *                                    proposed fix (structured)
 *   3. recordProposedFix()         — persist the fix so the user can
 *                                    approve it later (offer, don't apply)
 *   4. applyProposedFix()          — on the user's explicit approval,
 *                                    edit the workflow step + re-validate
 *                                    (never auto-applied — autoresearch
 *                                    discipline: approval-gated only)
 *
 * Everything is additive and flag-gated: with the flag off, callers fall
 * back to today's behavior. The legible-rendering helpers are safe to use
 * unconditionally (they only improve the message).
 */
import { Agent, run } from '@openai/agents';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { MODELS, getRuntimeEnv } from '../config.js';
import { STATE_DIR } from '../memory/db.js';
import { normalizeZodForCodexStrict } from '../runtime/schema-normalizer.js';
import { readWorkflow, writeWorkflow, type WorkflowDefinition, type WorkflowStepInput, type WorkflowStepInputBinding, type WorkflowStepOutputContract } from '../memory/workflow-store.js';
import { checkWorkflowForWrite } from './workflow-enforce.js';

const logger = pino({ name: 'clementine-next.workflow-diagnosis' });

export function selfHealEnabled(): boolean {
  return (getRuntimeEnv('WORKFLOW_SELF_HEAL', 'on') ?? 'on').toLowerCase() === 'on';
}

// ─── 1. Detect blocked steps ─────────────────────────────────────────

export interface BlockedStep {
  stepId: string;
  reason: string;
  /**
   * 'blocked'  — the step explicitly blocked ({blocked:true} / prose block):
   *              a prompt / connection / missing-input cause the Doctor can
   *              propose a fix for.
   * 'self_reported_failure' — the step RAN to completion but its output
   *              declared a failure (ok:false / *status:"fail" / error). This
   *              is a real outcome (often missing data or a provider), NOT a
   *              bad prompt — so it must NOT be routed into the prompt-rewrite
   *              Doctor, only surfaced as needs-attention.
   */
  kind: 'blocked' | 'self_reported_failure';
}

function coerceObject(raw: unknown): Record<string, unknown> | null {
  let v = raw;
  if (typeof v === 'string') {
    const t = v.trim();
    if (!t.startsWith('{')) return null;
    try { v = JSON.parse(t); } catch { return null; }
  }
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

/**
 * A forEach step's aggregate is an ARRAY of per-item results (and reaches
 * here as a JSON-array STRING — `stringifyOutputs` JSON.stringifies every
 * non-string output). Parse it so per-item polite blocks/failures don't
 * vanish. Returns null when the value isn't an array (or array string).
 */
function coerceArray(raw: unknown): unknown[] | null {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string') {
    const t = raw.trim();
    if (!t.startsWith('[')) return null;
    try {
      const v = JSON.parse(t);
      return Array.isArray(v) ? v : null;
    } catch { return null; }
  }
  return null;
}

// A step agent is told to block via structured `{blocked:true}`, but it
// sometimes returns a prose block instead ("Blocked the workflow step
// because …"). Catch that too, or the ROOT block (e.g. an expired
// connection in step 1) is missed and the Doctor diagnoses a downstream
// symptom. Tight prefix match → minimal false positives (a normal step
// returns structured data or a terse summary, not text starting with
// "Blocked").
const PROSE_BLOCK_RE = /^\s*(?:blocked\b|the (?:workflow )?step (?:is|was) blocked|step blocked\b)/i;

// A step can produce a partial human report while explicitly saying a tool or
// runtime dependency failed ("goal_list/goal_get errored out"). That is not a
// clean success: the deliverable may be useful, but the run should surface as
// needs-attention. Keep this narrow to tooling/runtime nouns so normal business
// prose like "three campaigns failed" does not trip it.
const PROSE_TOOL_FAILURE_RES = [
  /\b(?:tool|tools|mcp|connector|connection|api|composio|goal_(?:list|get)|task_(?:list|get)|workflow runtime)\b.{0,120}\b(?:errored out|failed|failure|unavailable|not exposed|not available|unable to retrieve)\b/i,
  /\b(?:errored out|failed|failure|unavailable|unable to retrieve)\b.{0,120}\b(?:tool|tools|mcp|connector|connection|api|composio|goal_(?:list|get)|task_(?:list|get)|workflow runtime)\b/i,
];

export function detectProseSelfReportedFailure(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const match = PROSE_TOOL_FAILURE_RES.map((re) => trimmed.match(re)).find(Boolean);
  if (!match) return null;
  return `reported tool/runtime failure: ${match[0].replace(/\s+/g, ' ').slice(0, 240)}`;
}

// A step can fail "politely" — returning a normal JSON object that
// DESCRIBES its own failure without the literal `blocked:true`. The engine
// then reports the run as a clean "completed" success despite the step's
// self-declared failure, breaking "reports back without fail". This
// domain-AGNOSTIC check treats such an object as a soft needs-attention
// signal. It keys on the GENERIC shape, never on specific field names:
//   1. ok === false                     (universal success boolean)
//   2. a non-empty top-level `error` string
//   3. any top-level `*status` key whose lowercased/trimmed string value is
//      in a SMALL fixed failure vocabulary (so `validationStatus:"fail"` and
//      `deployStatus:"not_deployed"` are caught without naming them)
// CONFIRMED small set — values NOT listed (deployed, pass, ok, active,
// success, complete, done, …) must NOT match. 'unavailable' and
// 'incomplete' are deliberately EXCLUDED: a healthy step legitimately
// reports a sub-source as "unavailable" (e.g. adsStatus:"unavailable")
// while completing fine — flagging those would false-positive on
// degraded-but-complete runs. 'fail'/'not_deployed' already catch the
// real self-declared failures.
const FAILURE_STATUS_VOCAB = new Set([
  'fail',
  'failed',
  'error',
  'errored',
  'not_deployed',
  'blocked',
]);
const STATUS_KEY_RE = /^[a-z0-9]*status$/i;

/**
 * Returns an actionable reason string when a step's parsed-JSON object
 * (top-level only) self-reports a failure, or null when it looks healthy.
 * Soft signal only — never a hard abort.
 */
export function detectSelfReportedFailure(obj: Record<string, unknown>): string | null {
  if (obj.ok === false) return 'reported ok=false';
  if (typeof obj.error === 'string' && obj.error.trim()) {
    return `reported error="${obj.error.trim().slice(0, 200)}"`;
  }
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value !== 'string') continue;
    if (!STATUS_KEY_RE.test(key)) continue;
    if (FAILURE_STATUS_VOCAB.has(value.trim().toLowerCase())) {
      return `reported ${key}="${value.trim()}"`;
    }
  }
  return null;
}

/**
 * Depth-bounded recursive variant of detectSelfReportedFailure: returns a reason
 * when a self-reported failure (ok=false / non-empty error string / *status in
 * the failure vocab) appears ANYWHERE in a nested result, not just at the top
 * level. The motivating case (caught by the live creation-test smoke): a step
 * told to return a structured object wrapped its error envelope one level deep —
 * `{records:{ok:false,error:"Unable to retrieve tool …"}}` — which the top-level
 * check + the output contract both wave through.
 *
 * Used by creation tests AND the runtime completion path. At runtime this is
 * still only a soft needs-attention signal (`self_reported_failure`), never a
 * hard step failure or auto-heal trigger. That preserves the delivered output
 * while preventing a nested "blocked"/"ok:false"/tool error envelope from being
 * reported as a clean workflow success.
 */
export function deepSelfReportedFailure(value: unknown, depth = 0): string | null {
  if (value == null || depth > 4) return null;
  if (Array.isArray(value)) {
    for (const el of value) {
      const r = deepSelfReportedFailure(el, depth + 1);
      if (r) return r;
    }
    return null;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (obj.blocked === true) {
      return `nested blocked=true${typeof obj.reason === 'string' && obj.reason.trim() ? ` — ${obj.reason.trim().slice(0, 200)}` : ''}`;
    }
    const here = detectSelfReportedFailure(obj);
    if (here) return here;
    for (const v of Object.values(obj)) {
      if (v && typeof v === 'object') {
        const r = deepSelfReportedFailure(v, depth + 1);
        if (r) return r;
      }
    }
  }
  return null;
}

/**
 * Inspect a forEach aggregate (array of per-item results) for items that
 * politely BLOCKED ({blocked:true}) or self-reported a failure (ok:false /
 * *status in the failure vocab / error string). Without this, a fan-out
 * where every item quietly blocked still reads as a clean "completed" run
 * (the array never matched the single-object checks) — breaking
 * "reports back without fail". Returns one rolled-up BlockedStep for the
 * step, or null when every item looks healthy. Tagged
 * 'self_reported_failure' (surface as needs-attention, NOT routed into the
 * prompt-rewrite Doctor): per-item blocks are usually data/provider
 * outcomes, not a bad step prompt — same rationale as the single-object
 * self_reported_failure path.
 */
function inspectArrayForFailures(arr: unknown[], stepId: string): BlockedStep | null {
  let blockedCount = 0;
  let failedCount = 0;
  let firstReason: string | null = null;
  for (const el of arr) {
    // The runner stores a forEach aggregate as an array of
    // `{ itemKey, output }` wrappers — the per-item RESULT lives in `.output`
    // (the wrapper itself never carries blocked/ok). Unwrap it; a raw item
    // object (other shapes / future callers) is inspected directly.
    let candidate: unknown = el;
    if (
      el && typeof el === 'object' && !Array.isArray(el)
      && 'itemKey' in (el as Record<string, unknown>)
      && 'output' in (el as Record<string, unknown>)
    ) {
      candidate = (el as { output: unknown }).output;
    }
    const obj = coerceObject(candidate);
    if (!obj) continue;
    if (obj.blocked === true) {
      blockedCount += 1;
      if (!firstReason) firstReason = String(obj.reason ?? 'blocked').slice(0, 200);
    } else {
      const r = detectSelfReportedFailure(obj) ?? deepSelfReportedFailure(obj);
      if (r) {
        failedCount += 1;
        if (!firstReason) firstReason = r;
      }
    }
  }
  const bad = blockedCount + failedCount;
  if (bad === 0) return null;
  const label = blockedCount > 0 && failedCount > 0
    ? 'block/failure'
    : blockedCount > 0 ? 'block' : 'failure';
  const reason = `step "${stepId}" had ${bad} of ${arr.length} item${arr.length === 1 ? '' : 's'} report a ${label}`
    + (firstReason ? ` — e.g. ${firstReason}` : '');
  return { stepId, reason: reason.slice(0, 600), kind: 'self_reported_failure' };
}

/**
 * A step is "blocked" when its structured result carries `blocked:true`
 * (the explicit clean-block channel) OR its prose output starts with a
 * block declaration. Synthesis (`__synthesis__`) is excluded.
 *
 * When `stepOrder` (the DAG/execution order of step ids) is given, the
 * result is sorted so the EARLIEST blocked step is first — that's the
 * root cause; later blocks are usually cascades that inherited it.
 */
export function detectBlockedSteps(
  stepOutputs: Record<string, unknown>,
  stepOrder?: string[],
): BlockedStep[] {
  const blocked: BlockedStep[] = [];
  for (const [stepId, raw] of Object.entries(stepOutputs)) {
    if (stepId.startsWith('__')) continue;
    const obj = coerceObject(raw);
    if (obj && obj.blocked === true) {
      blocked.push({ stepId, reason: String(obj.reason ?? 'No reason was provided.').slice(0, 600), kind: 'blocked' });
    } else if (typeof raw === 'string' && PROSE_BLOCK_RE.test(raw.trim())) {
      blocked.push({ stepId, reason: raw.trim().slice(0, 600), kind: 'blocked' });
    } else if (obj) {
      // Additive, domain-agnostic: a step that returned normal JSON but
      // self-reported a failure (ok:false / error string / *status in the
      // failure vocab) is a soft needs-attention signal — same channel,
      // not a hard abort. Tagged 'self_reported_failure' so the runner
      // surfaces it as needs-attention but does NOT route it into the
      // prompt-rewrite Doctor (the failure is an outcome, not a bad prompt).
      const reason = detectSelfReportedFailure(obj) ?? deepSelfReportedFailure(obj);
      if (reason) blocked.push({ stepId, reason: `step "${stepId}" ${reason}`.slice(0, 600), kind: 'self_reported_failure' });
    } else {
      if (typeof raw === 'string') {
        const reason = detectProseSelfReportedFailure(raw);
        if (reason) {
          blocked.push({ stepId, reason: `step "${stepId}" ${reason}`.slice(0, 600), kind: 'self_reported_failure' });
          continue;
        }
      }
      // Not a blocked object, prose block, or healthy object — it may be a
      // forEach aggregate (array / JSON-array string). Surface per-item
      // polite blocks/failures that would otherwise read as a clean success.
      const arr = coerceArray(raw);
      if (arr) {
        const finding = inspectArrayForFailures(arr, stepId);
        if (finding) blocked.push(finding);
      }
    }
  }
  if (stepOrder && stepOrder.length > 0) {
    const rank = (id: string) => {
      const i = stepOrder.indexOf(id);
      return i < 0 ? Number.MAX_SAFE_INTEGER : i;
    };
    blocked.sort((a, b) => rank(a.stepId) - rank(b.stepId));
  }
  return blocked;
}

// ─── 2. Diagnose ─────────────────────────────────────────────────────

const FIX_KINDS = ['edit_step', 'edit_contract', 'edit_input', 'edit_binding', 'reconnect_service', 'adjust_input', 'manual'] as const;

export const WorkflowDiagnosisSchema = z.object({
  summary: z.string().describe('One or two plain-English sentences: what happened, no jargon, no JSON.'),
  rootCause: z.string().describe('Why the step blocked — the specific cause (wrong tool/query, expired connection, missing input, ambiguous instruction, an output contract that does not match the real data).'),
  fix: z.object({
    kind: z.enum(FIX_KINDS).describe('edit_step = rewrite the step prompt (incl. correcting the tool/query NAMED in the prompt); edit_contract = the step produced valid data but its output contract is WRONG; edit_input = the step\'s typed input BINDING is wrong (points at a missing source, or a required input needs a default); edit_binding = the step\'s allowed-tools SURFACE is too narrow/wrong (the tool it needs is not exposed); reconnect_service = a connection needs reauth (cannot auto-fix); adjust_input = a run input value is missing (human must supply it); manual = needs human judgment.'),
    stepId: z.string().describe('The step the fix targets.'),
    description: z.string().describe('Plain-English description of the proposed fix, suitable to show the user.'),
    newStepPrompt: z.string().nullable().describe('For kind=edit_step ONLY: the COMPLETE replacement prompt for the step, fixing the root cause (e.g. correct the Composio tool/query, name the explicit access method like the local `sf` CLI, clarify the missing input). null otherwise.'),
    newOutputContractJson: z.string().nullable().describe('For kind=edit_contract ONLY: a JSON object string of the CORRECTED output contract, e.g. {"type":"object","required_keys":["name","email"]} or {"type":"array","min_items":{"":1}}. Keys: type, required_keys, non_empty, min_items, verify. Only LOOSEN a contract that false-fails legitimate data (remove a key the data legitimately lacks; lower a min_items), or add a check that catches a garbage pass. null otherwise.'),
    newInputsJson: z.string().nullable().describe('For kind=edit_input ONLY: a JSON object string mapping input NAME → binding, e.g. {"url":{"from":"input.url"}} or {"region":{"from":"steps.gather.output.region"}} or {"limit":{"default":50}}. Binding keys: from (input.<k> | steps.<id>.output[.path] | item[.path]), default, type, required. Only reference inputs/steps that exist. null otherwise.'),
    newAllowedToolsJson: z.string().nullable().describe('For kind=edit_binding ONLY: a JSON array string of the CORRECTED allowed-tools surface for the step, e.g. ["composio_gmail_search","composio_gmail_send"]. Use when the step is locked to a surface that omits a tool it genuinely needs. null otherwise.'),
    service: z.string().nullable().describe('For kind=reconnect_service: the service that needs reauthorization (e.g. "Google Drive", "Outlook"). null otherwise.'),
    autoApplicable: z.boolean().describe('true ONLY when the fix is a safe structured edit: edit_step (drop-in prompt), edit_contract (genuine contract/data mismatch), edit_input (a binding that points at an existing source), or edit_binding (a real tool the step needs). false for reconnect/adjust_input/manual.'),
  }),
  confidence: z.enum(['high', 'medium', 'low']),
});
export type WorkflowDiagnosis = z.infer<typeof WorkflowDiagnosisSchema>;

const DOCTOR_INSTRUCTIONS = [
  'You are the Workflow Doctor. A step of an automated workflow blocked instead of completing. Diagnose the ROOT cause and propose ONE concrete fix.',
  'You are given the blocked steps in execution order — the FIRST is the ROOT (the earliest failure). Diagnose THAT one. Later steps usually just inherited the failure, and their stated reasons are often GUESSES or even wrong (a downstream agent may invent a plausible-sounding blocker like "shell needs approval" when the truth is "the upstream step never produced my input"). Trust the root step + the tool errors over downstream rationalizations.',
  'You are read-only: you do NOT call tools or change anything. You only produce the structured diagnosis. The fix is applied later, only if the user approves.',
  'Be concrete and plain-spoken — the summary and fix.description are shown directly to a non-engineer. No JSON, no tool-call jargon in those fields.',
  'Common root causes and the right fix kind:',
  '- The step named a tool/query that failed or does not exist, OR was too vague about HOW to reach a service (e.g. "use the available Salesforce tooling"): kind=edit_step. Provide newStepPrompt = the full step rewritten to name the concrete path. For Salesforce, the local `sf` CLI is available via run_shell_command; for other services, discover via composio_status / composio_search_tools then call composio_execute_tool with the correct tool slug + args.',
  '- If the failure says a Clementine/local MCP tool itself was not exposed or did not exist (for example run_shell_command, notify_user, write_file, local_cli_list/probe), this is a runtime/tool-lane issue, NOT a provider credential problem. kind=manual, autoApplicable=false. Do not propose reconnecting Salesforce/Outlook/Composio unless the observed error is an auth/401/403/expired-connection error from that provider.',
  '- A connection/auth error (ComposioToolExecutionError about auth, expired/invalid connection, 401/403): kind=reconnect_service, service=<the service>. Do NOT pretend an edit fixes an auth problem. autoApplicable=false.',
  '- A required run input was missing/empty: kind=adjust_input. autoApplicable=false.',
  '- The step RAN but its output FAILED its declared output contract because the step did NOT actually produce the deliverable — it claimed "produced a brief" but returned no real URL/file, or returned a summary instead of the artifact: kind=edit_step. Rewrite the step prompt to EXPLICITLY produce the declared shape and return the REAL artifact (the actual created URL / saved file path), not a bare claim. The newStepPrompt MUST keep the same declared output contract. autoApplicable=true.',
  '- The step RAN and produced VALID, real data, but its declared output contract is itself WRONG — it requires a key the real data legitimately does not always carry (e.g. requires "phone" but this record has none), demands a min_items count higher than a legitimate result (7 items when 7 is a real, complete answer), or fixes a type/shape the data never actually matches: kind=edit_contract. Provide newOutputContractJson = the CORRECTED contract (loosen only what false-fails legitimate data). Do NOT loosen a contract to hide a genuinely empty or garbage output — that is a real failure, not a contract bug. When in doubt between edit_step and edit_contract, prefer edit_step (fix the work, not the check). autoApplicable=true.',
  '- The step failed because a declared INPUT BINDING is wrong — it points at a source that does not exist (a step id or input name that is not there), or a required input has no value and needs a sensible default: kind=edit_input. Provide newInputsJson = the corrected input map for the step. Only reference inputs/steps that ACTUALLY EXIST in this workflow (you are given the steps). If the input genuinely needs a value only the human can supply (an API key, a person to email), use kind=adjust_input (autoApplicable=false) instead. autoApplicable=true when the binding fix references an existing source.',
  '- The step failed because its allowed-tools SURFACE is too narrow — the error says a tool it needs is not available/exposed, AND that tool is a real one the step should be allowed to call: kind=edit_binding. Provide newAllowedToolsJson = the corrected surface (the existing tools PLUS the one it needs). NOTE: if the fix is to call a DIFFERENT tool or correct a tool NAME written in the prompt, that is kind=edit_step (rewrite the prompt), not edit_binding — edit_binding only widens/corrects the allow-list. autoApplicable=true.',
  '- Genuinely needs human judgment: kind=manual. autoApplicable=false.',
  'When kind=edit_step, newStepPrompt MUST be the COMPLETE replacement prompt for that step (not a diff), preserving the original intent and output contract, fixing only what caused the block. Set autoApplicable=true only then.',
  'Set confidence honestly. If the reason is vague, say so and prefer a conservative fix.',
].join('\n\n');

export interface DiagnoseInput {
  workflow: WorkflowDefinition;
  blockedSteps: BlockedStep[];
  toolErrors?: string[];
  /** RSH-4: upstream READ steps that produced NO data yet feed a downstream
   *  step (from detectEmptyDeliverableReads). When the first blocked step is
   *  one of those consumers, the ROOT cause is the empty producer, not the
   *  symptom — so we re-root the diagnosis onto the producer. */
  upstreamEmptyProducers?: Array<{ stepId: string; consumerId: string; shape: string }>;
}

/**
 * RSH-4 (multi-step chain diagnosis): the Doctor diagnoses blockedSteps[0], but
 * a step often blocks only because an UPSTREAM step produced empty/no data
 * (the silent-nothing chain). When the first blocked step is a known consumer
 * of an empty producer — and that producer isn't already in the blocked list —
 * prepend the producer as the real root so the fix targets the cause, not the
 * symptom. Pure + exported for tests.
 */
export function prependRootCauseBlock(
  blockedSteps: BlockedStep[],
  emptyProducers: Array<{ stepId: string; consumerId: string; shape: string }>,
): BlockedStep[] {
  const first = blockedSteps[0];
  if (!first) return blockedSteps;
  const already = new Set(blockedSteps.map((b) => b.stepId));
  // find the empty producer whose consumer IS the current root blocked step
  const producer = emptyProducers.find((e) => e.consumerId === first.stepId && !already.has(e.stepId));
  if (!producer) return blockedSteps;
  const rootBlock: BlockedStep = {
    stepId: producer.stepId,
    reason: `Step "${producer.stepId}" produced empty output (${producer.shape}), which starved downstream step "${first.stepId}" — that step then blocked because it had no data to work with. The ROOT cause is likely here (e.g. a query that returned nothing, an expired connection, a wrong filter), not in "${first.stepId}".`,
    kind: 'blocked',
  };
  return [rootBlock, ...blockedSteps];
}

function diagnoseRuntimeToolSurfaceBlock(input: DiagnoseInput): WorkflowDiagnosis | null {
  const primary = input.blockedSteps[0];
  if (!primary) return null;
  const evidence = [
    primary.reason,
    ...(input.toolErrors ?? []),
  ].join('\n');
  if (
    !/local MCP surface|tool-surface|No such tool available|required local MCP tool|did not expose required local MCP tool/i.test(evidence)
    || !/\brun_shell_command\b|\bwrite_file\b|\bnotify_user\b|\bcomposio_execute_tool\b|\blocal_cli_/i.test(evidence)
  ) {
    return null;
  }
  const missing = [...new Set(
    evidence.match(/\b(?:run_shell_command|write_file|notify_user|composio_execute_tool|composio_search_tools|composio_list_tools|local_cli_list|local_cli_probe)\b/g) ?? [],
  )];
  const toolList = missing.length ? missing.join(', ') : 'the required local MCP tools';
  return {
    summary: `The workflow runner did not expose ${toolList} to the model lane, so the step could not execute its required local action.`,
    rootCause: `This is a Clementine runtime/tool-surface problem: the workflow step requires ${toolList}, but the active SDK workflow-step environment did not advertise the tool before execution.`,
    fix: {
      kind: 'manual',
      stepId: primary.stepId,
      description: `Fix the workflow runtime so the full gated workflow-step lane advertises ${toolList}; do not reconnect or switch services unless the workflow intentionally changes its data source.`,
      newStepPrompt: null,
      newOutputContractJson: null,
      newInputsJson: null,
      newAllowedToolsJson: null,
      service: null,
      autoApplicable: false,
    },
    confidence: 'high',
  };
}

/** T3.2 — cross-family veto on an AUTO-applied heal ("judge ≠ brain family;
 *  never self-grade"). The Doctor's `autoApplicable` verdict is produced by
 *  the same fast model that wrote the rewrite; before the runner auto-applies
 *  it, a judge from a DIFFERENT provider family re-grades the fix. Verdicts:
 *   - 'approve'      → auto-apply proceeds
 *   - 'veto'         → escalate to the human `apply fix` offer instead
 *   - 'unavailable'  → no different-family judge reachable (or judge timeout /
 *                      error) → fail-open to today's behavior; auto-heal is
 *                      already bounded, backed up, and (new) auto-reverted on
 *                      a re-run that doesn't stick.
 *  Human-approved `apply fix` is NOT judged — the human is the judge. */
const HealVetoSchema = z.object({
  approve: z.boolean(),
  reason: z.string(),
});

export async function judgeHealCrossFamily(
  diagnosis: WorkflowDiagnosis,
  stepPrompt: string | undefined,
): Promise<{ verdict: 'approve' | 'veto' | 'unavailable'; reason?: string }> {
  try {
    const { resolveRoleModel } = await import('../runtime/harness/model-roles.js');
    const { resolveProvider } = await import('../runtime/harness/model-wire-registry.js');
    const { judgeCrossFamilyEnabled, withJudgeTimeout } = await import('../runtime/harness/judge-family.js');
    if (!judgeCrossFamilyEnabled()) return { verdict: 'unavailable', reason: 'cross-family judging disabled' };
    const judge = resolveRoleModel('judge');
    const doctorProvider = resolveProvider(MODELS.fast);
    if (!judge?.modelId || String(judge.provider) === String(doctorProvider)) {
      return { verdict: 'unavailable', reason: 'no different-family judge bound' };
    }
    const agent = new Agent({
      name: 'HealVetoJudge',
      instructions: [
        'You are a strict reviewer of an AUTOMATED fix about to be applied to a production workflow without a human in the loop.',
        'For a step-prompt rewrite: approve ONLY when it plausibly addresses the diagnosed root cause AND does not weaken the step (dropping its deliverable, loosening its scope, or introducing a new external action).',
        'For an output-contract change: approve ONLY when the new contract still verifies the step\'s real deliverable and the change reflects LEGITIMATE data variation (a key the data genuinely does not always carry, a count that was set too high) — NOT a loosening that would hide a genuinely empty or garbage output. A contract change that removes the only check catching bad data must be REJECTED.',
        'For an input-binding change: approve ONLY when the new binding points at a source that plausibly supplies the right value for this step, or a default that is a reasonable, safe value — NOT a guess that would feed the step wrong data.',
        'For an allowed-tools change: approve ONLY when the added tool is one the step genuinely needs for its stated job and does not newly enable an unintended external action (a send/publish the step should not perform).',
        'When uncertain, REJECT — a rejected fix is offered to the human instead of lost.',
      ].join('\n'),
      model: judge.modelId,
      modelSettings: { reasoning: { effort: 'low' } },
      outputType: normalizeZodForCodexStrict(HealVetoSchema) as typeof HealVetoSchema,
      tools: [],
    });
    const prompt = [
      `Diagnosed root cause: ${diagnosis.rootCause}`,
      `Proposed fix (${diagnosis.fix.kind}): ${diagnosis.fix.description}`,
      stepPrompt ? `Current step prompt:\n"""\n${stepPrompt.slice(0, 3000)}\n"""` : '',
      diagnosis.fix.newStepPrompt ? `Rewritten step prompt:\n"""\n${diagnosis.fix.newStepPrompt.slice(0, 3000)}\n"""` : '',
      diagnosis.fix.newOutputContractJson ? `Proposed new output contract: ${diagnosis.fix.newOutputContractJson.slice(0, 1500)}` : '',
    ].filter(Boolean).join('\n\n');
    const result = await withJudgeTimeout(run(agent, prompt));
    const out = result?.finalOutput as z.infer<typeof HealVetoSchema> | undefined;
    if (!out) return { verdict: 'unavailable', reason: 'judge timeout' };
    return out.approve ? { verdict: 'approve', reason: out.reason } : { verdict: 'veto', reason: out.reason };
  } catch (err) {
    return { verdict: 'unavailable', reason: err instanceof Error ? err.message : String(err) };
  }
}

export async function diagnoseWorkflowBlock(input: DiagnoseInput): Promise<WorkflowDiagnosis | null> {
  // RSH-4: re-root onto an upstream empty producer when the first blocked step
  // only inherited its failure.
  const blockedSteps = prependRootCauseBlock(input.blockedSteps, input.upstreamEmptyProducers ?? []);
  const primary = blockedSteps[0];
  if (!primary) return null;
  const runtimeDiagnosis = diagnoseRuntimeToolSurfaceBlock({ ...input, blockedSteps });
  if (runtimeDiagnosis) return runtimeDiagnosis;
  const step = input.workflow.steps.find((s) => s.id === primary.stepId);
  const agent = new Agent({
    name: 'WorkflowDoctor',
    // A structured blocked-step classifier — the fast tier handles it well and
    // keeps post-failure diagnosis cheap (it runs on every blocked run).
    instructions: DOCTOR_INSTRUCTIONS,
    model: MODELS.fast,
    modelSettings: { reasoning: { effort: 'low' } },
    outputType: normalizeZodForCodexStrict(WorkflowDiagnosisSchema) as typeof WorkflowDiagnosisSchema,
    tools: [],
  });
  const prompt = [
    `Workflow: ${input.workflow.name}`,
    `Workflow description: ${input.workflow.description ?? '(none)'}`,
    `Blocked step id: ${primary.stepId}`,
    `Blocked reason (from the step): ${primary.reason}`,
    input.toolErrors && input.toolErrors.length
      ? `Actual tool errors observed during the step:\n${input.toolErrors.slice(0, 5).join('\n')}`
      : '',
    step?.prompt ? `The step's current prompt:\n"""\n${step.prompt.slice(0, 4000)}\n"""` : '(step prompt unavailable)',
    blockedSteps.length > 1
      ? `Other steps that also blocked (likely downstream of this one): ${blockedSteps.slice(1).map((b) => b.stepId).join(', ')}`
      : '',
  ].filter(Boolean).join('\n\n');

  try {
    const result = await run(agent, prompt);
    const out = result.finalOutput as WorkflowDiagnosis | undefined;
    return out ?? null;
  } catch (err) {
    logger.warn({ err, workflow: input.workflow.name, step: primary.stepId }, 'workflow diagnosis failed');
    return null;
  }
}

// ─── 3. Persist proposed fixes (offer, don't apply) ──────────────────

const FIXES_DIR = path.join(STATE_DIR, 'workflow-fixes');

export interface ProposedFix {
  id: string;
  workflow: string;
  runId: string;
  stepId: string;
  diagnosis: WorkflowDiagnosis;
  createdAt: string;
}

export function recordProposedFix(workflow: string, runId: string, diagnosis: WorkflowDiagnosis): ProposedFix {
  fs.mkdirSync(FIXES_DIR, { recursive: true });
  const id = `fix-${randomUUID().slice(0, 8)}`;
  const fix: ProposedFix = {
    id,
    workflow,
    runId,
    stepId: diagnosis.fix.stepId,
    diagnosis,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(path.join(FIXES_DIR, `${id}.json`), JSON.stringify(fix, null, 2));
  return fix;
}

export function loadProposedFix(id: string): ProposedFix | null {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, '');
  const file = path.join(FIXES_DIR, `${safe}.json`);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as ProposedFix; } catch { return null; }
}

export function dismissProposedFix(id: string): boolean {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, '');
  const file = path.join(FIXES_DIR, `${safe}.json`);
  if (!fs.existsSync(file)) return false;
  try { fs.unlinkSync(file); return true; } catch { return false; }
}

export function listProposedFixes(): ProposedFix[] {
  if (!fs.existsSync(FIXES_DIR)) return [];
  return fs.readdirSync(FIXES_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(FIXES_DIR, f), 'utf8')) as ProposedFix; } catch { return null; } })
    .filter((x): x is ProposedFix => x !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// ─── 3b. Rollback backups (self-improvement hole #7) ─────────────────
//
// An auto-applied fix overwrites the step prompt with no way back — a bad
// heal degrades the workflow permanently. Before any fix is written, snapshot
// the PRIOR full definition so the change is reversible (`revert heal <id>`).

const FIX_BACKUPS_DIR = path.join(STATE_DIR, 'workflow-fix-backups');

export interface FixBackup {
  id: string;
  workflow: string;
  stepId: string;
  priorDefinition: WorkflowDefinition;
  description: string;
  createdAt: string;
}

/** T3.1: the same backup+revert discipline for OTHER auto-edits (success-path
 *  contract tightening). Exported thin wrapper so callers outside the Doctor
 *  get `revert heal <id>` reversibility without duplicating path logic. */
export function recordWorkflowEditBackup(
  workflow: string,
  stepId: string,
  priorDefinition: WorkflowDefinition,
  description: string,
): FixBackup | null {
  return recordFixBackup(workflow, stepId, priorDefinition, description);
}

/** Snapshot the prior definition before a fix is written. Best-effort
 *  (disk-full / FS errors never block the heal) — returns null on failure. */
function recordFixBackup(
  workflow: string,
  stepId: string,
  priorDefinition: WorkflowDefinition,
  description: string,
): FixBackup | null {
  try {
    fs.mkdirSync(FIX_BACKUPS_DIR, { recursive: true });
    const id = `heal-${randomUUID().slice(0, 8)}`;
    const backup: FixBackup = { id, workflow, stepId, priorDefinition, description, createdAt: new Date().toISOString() };
    fs.writeFileSync(path.join(FIX_BACKUPS_DIR, `${id}.json`), JSON.stringify(backup, null, 2));
    return backup;
  } catch (err) {
    logger.warn({ err, workflow, stepId }, 'self-heal: could not record fix backup (heal not reversible)');
    return null;
  }
}

export function listFixBackups(): FixBackup[] {
  if (!fs.existsSync(FIX_BACKUPS_DIR)) return [];
  return fs.readdirSync(FIX_BACKUPS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => { try { return JSON.parse(fs.readFileSync(path.join(FIX_BACKUPS_DIR, f), 'utf8')) as FixBackup; } catch { return null; } })
    .filter((x): x is FixBackup => x !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Restore the workflow to its pre-fix definition. Reverses an auto- or
 *  manually-applied heal that made things worse. */
export function revertWorkflowFix(id: string): ApplyResult {
  const safe = id.replace(/[^a-zA-Z0-9_-]/g, '');
  const file = path.join(FIX_BACKUPS_DIR, `${safe}.json`);
  if (!fs.existsSync(file)) return { ok: false, message: `No revertable heal found with id "${id}".` };
  let backup: FixBackup;
  try { backup = JSON.parse(fs.readFileSync(file, 'utf8')) as FixBackup; }
  catch { return { ok: false, message: `Heal backup "${id}" is unreadable.` }; }
  if (!readWorkflow(backup.workflow)) return { ok: false, message: `Workflow "${backup.workflow}" no longer exists.` };
  writeWorkflow(backup.workflow, backup.priorDefinition);
  try { fs.unlinkSync(file); } catch { /* best-effort */ }
  logger.info({ workflow: backup.workflow, step: backup.stepId, healId: id }, 'self-heal: reverted workflow fix');
  return { ok: true, message: `Reverted "${backup.workflow}" to the version before the auto-fix on step "${backup.stepId}".` };
}

// ─── 4. Apply (approval-gated only) ──────────────────────────────────

export interface ApplyResult {
  ok: boolean;
  message: string;
  errors?: string[];
  /** Set when the apply snapshotted a reversible backup (`revert heal <id>`). */
  backupId?: string;
}

/** Auto-applicable fix kinds and the field each requires. The safe structured
 *  edits — a prompt rewrite (edit_step), an output-contract correction
 *  (edit_contract, RSH-1), a typed input-binding fix (edit_input, RSH-3), or a
 *  tool-surface widening (edit_binding, RSH-3). Everything else (reconnect /
 *  adjust_input / manual) still needs human action. Each structured edit is
 *  gated on its payload sanitizing to something usable, so a malformed model
 *  output is never auto-applicable. */
export function fixIsAutoApplicable(fix: WorkflowDiagnosis['fix']): boolean {
  if (!fix.autoApplicable) return false;
  if (fix.kind === 'edit_step') return Boolean(fix.newStepPrompt);
  if (fix.kind === 'edit_contract') return Boolean(sanitizeOutputContract(fix.newOutputContractJson));
  if (fix.kind === 'edit_input') return Boolean(sanitizeStepInputs(fix.newInputsJson));
  if (fix.kind === 'edit_binding') return Boolean(sanitizeAllowedTools(fix.newAllowedToolsJson));
  return false;
}

/** Parse + sanitize a model-authored step-inputs map (edit_input). Keeps only
 *  valid binding keys (from/default/type/required/description) with correct
 *  types; drops the rest. Returns null when nothing usable remains. Pure. */
export function sanitizeStepInputs(json: string | null | undefined): Record<string, WorkflowStepInputBinding> | null {
  if (!json || typeof json !== 'string') return null;
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return null; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out: Record<string, WorkflowStepInputBinding> = {};
  for (const [name, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!name || typeof val !== 'object' || val === null || Array.isArray(val)) continue;
    const v = val as Record<string, unknown>;
    const binding: WorkflowStepInputBinding = {};
    if (typeof v.from === 'string' && v.from.trim()) binding.from = v.from.trim();
    if ('default' in v) binding.default = v.default;
    if (typeof v.type === 'string' && CONTRACT_TYPES.has(v.type)) binding.type = v.type as WorkflowStepInputBinding['type'];
    if (typeof v.required === 'boolean') binding.required = v.required;
    if (typeof v.description === 'string') binding.description = v.description;
    // a binding with neither a source nor a default resolves to nothing → skip
    if (binding.from === undefined && !('default' in binding)) continue;
    out[name] = binding;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** Parse + sanitize a model-authored allowed-tools array (edit_binding). Keeps
 *  only non-empty strings. Returns null when nothing usable remains. Pure. */
export function sanitizeAllowedTools(json: string | null | undefined): string[] | null {
  if (!json || typeof json !== 'string') return null;
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return null; }
  if (!Array.isArray(raw)) return null;
  const tools = [...new Set(raw.filter((t): t is string => typeof t === 'string' && t.trim().length > 0).map((t) => t.trim()))];
  return tools.length > 0 ? tools : null;
}

const CONTRACT_TYPES = new Set(['string', 'number', 'boolean', 'object', 'array']);

/** Parse + sanitize a model-authored output contract JSON string. Accepts ONLY
 *  the known WorkflowStepOutputContract keys with correct value types; drops
 *  anything else. Returns null when the string is not a usable contract — so a
 *  malformed model output can never be written to a workflow. Pure + exported
 *  for tests. */
export function sanitizeOutputContract(json: string | null | undefined): WorkflowStepOutputContract | null {
  if (!json || typeof json !== 'string') return null;
  let raw: unknown;
  try { raw = JSON.parse(json); } catch { return null; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const out: WorkflowStepOutputContract = {};
  if (typeof r.type === 'string' && CONTRACT_TYPES.has(r.type)) out.type = r.type as WorkflowStepOutputContract['type'];
  if (Array.isArray(r.required_keys)) {
    const keys = r.required_keys.filter((k): k is string => typeof k === 'string' && k.length > 0);
    if (keys.length) out.required_keys = keys;
  }
  if (Array.isArray(r.non_empty)) {
    const paths = r.non_empty.filter((k): k is string => typeof k === 'string');
    if (paths.length) out.non_empty = paths;
  }
  if (r.min_items && typeof r.min_items === 'object' && !Array.isArray(r.min_items)) {
    const mi: Record<string, number> = {};
    for (const [k, v] of Object.entries(r.min_items as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) mi[k] = Math.floor(v);
    }
    if (Object.keys(mi).length) out.min_items = mi;
  }
  if (r.verify && typeof r.verify === 'object' && !Array.isArray(r.verify)) {
    const v = r.verify as Record<string, unknown>;
    const verify: NonNullable<WorkflowStepOutputContract['verify']> = {};
    if (Array.isArray(v.path_exists)) verify.path_exists = v.path_exists.filter((x): x is string => typeof x === 'string');
    if (Array.isArray(v.url_present)) verify.url_present = v.url_present.filter((x): x is string => typeof x === 'string');
    if (verify.path_exists?.length || verify.url_present?.length) out.verify = verify;
  }
  // A contract with no actual constraints is not a meaningful fix.
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * Apply a proposed fix to its workflow. Handles the auto-applicable structured
 * kinds — edit_step (rewrite the prompt), edit_contract (correct the output
 * contract), edit_input (correct the typed input bindings), edit_binding
 * (correct the allowed-tools surface); everything else returns ok:false with
 * guidance (auth / reconnect / manual fixes need human action). The edited
 * workflow is re-validated through checkWorkflowForWrite before it is written,
 * so a fix can never write a workflow that would fail the gate, and the prior
 * definition is snapshotted first so a bad heal is reversible.
 */
export function applyProposedFix(id: string): ApplyResult {
  const fix = loadProposedFix(id);
  if (!fix) return { ok: false, message: `No proposed fix found with id "${id}".` };
  const d = fix.diagnosis;
  if (!fixIsAutoApplicable(d.fix)) {
    return {
      ok: false,
      message: `This fix can't be applied automatically (${d.fix.kind}). ${d.fix.description}`,
    };
  }
  const entry = readWorkflow(fix.workflow);
  if (!entry) return { ok: false, message: `Workflow "${fix.workflow}" not found.` };
  const def = entry.data;
  const idx = def.steps.findIndex((s) => s.id === fix.stepId);
  if (idx < 0) return { ok: false, message: `Step "${fix.stepId}" not found in "${fix.workflow}".` };

  const editStep = (s: WorkflowStepInput): WorkflowStepInput => {
    switch (d.fix.kind) {
      case 'edit_step':
        return { ...s, prompt: d.fix.newStepPrompt as string };
      case 'edit_contract':
        return { ...s, output: sanitizeOutputContract(d.fix.newOutputContractJson) as WorkflowStepOutputContract };
      case 'edit_input':
        // merge the corrected bindings over any existing declared inputs
        return { ...s, inputs: { ...(s.inputs ?? {}), ...sanitizeStepInputs(d.fix.newInputsJson) } };
      case 'edit_binding':
        return { ...s, allowedTools: sanitizeAllowedTools(d.fix.newAllowedToolsJson) as string[] };
      default:
        return s;
    }
  };
  const updated: WorkflowDefinition = {
    ...def,
    steps: def.steps.map((s, i) => (i === idx ? editStep(s) : s)),
  };
  const check = checkWorkflowForWrite(updated);
  if (!check.ok) {
    return { ok: false, message: `The proposed fix would fail workflow validation; not applied.`, errors: check.errors };
  }
  // Snapshot the PRIOR definition first so a bad heal is reversible (#7).
  const backup = recordFixBackup(fix.workflow, fix.stepId, def, d.fix.description);
  writeWorkflow(fix.workflow, updated);
  dismissProposedFix(id);
  logger.info({ workflow: fix.workflow, step: fix.stepId, fixId: id, kind: d.fix.kind, backupId: backup?.id }, 'self-heal: applied workflow fix');
  const revertHint = backup ? ` If it doesn't help, revert with \`revert heal ${backup.id}\`.` : '';
  return {
    ok: true,
    message: `Applied the fix to "${fix.workflow}" · step "${fix.stepId}". Re-run the workflow when ready.${revertHint}`,
    backupId: backup?.id,
  };
}

// ─── Legible rendering (safe to use unconditionally) ─────────────────

/**
 * Surface the human-meaningful content of a step's structured result
 * instead of dumping raw JSON. Prefers a known human field
 * (body/summary/message/text); falls back to a compact one-liner.
 */
export function humanizeStepOutput(raw: unknown): string {
  const obj = coerceObject(raw);
  if (!obj) return typeof raw === 'string' ? raw : JSON.stringify(raw);
  if (obj.blocked === true) return `⚠️ blocked: ${String(obj.reason ?? 'no reason given')}`;
  for (const key of ['body', 'summary', 'message', 'text', 'notification']) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // No human-readable field — this is a bookkeeping result (the step's
  // real content already went out via notify_user). Render a terse status
  // line with any obvious count metrics, NOT raw JSON.
  const status = obj.ok === true ? '✓ done' : obj.ok === false ? '✗ failed' : '✓ completed';
  const metrics: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'number' && /count|found|sent|scanned|total|records|rows|drafted|prepared|updated|created/i.test(k)) {
      metrics.push(`${k}: ${v}`);
    }
  }
  return metrics.length ? `${status} — ${metrics.slice(0, 6).join(', ')}` : status;
}

/**
 * Build the success-case completion body. Prefers the synthesis text
 * (already human prose) when the workflow has a synthesis pass; otherwise
 * humanizes each step's structured result instead of dumping raw JSON.
 */
export function renderSuccessBody(opts: {
  steps: Array<{ id: string }>;
  stepOutputs: Record<string, unknown>;
  finalOutput: string;
  hasSynthesis: boolean;
}): string {
  if (opts.hasSynthesis && opts.finalOutput.trim()) return opts.finalOutput.trim();
  const shown = opts.steps.filter((s) => opts.stepOutputs[s.id] !== undefined);
  if (shown.length === 0) return opts.finalOutput.trim() || '✓ completed';
  if (shown.length === 1) return humanizeStepOutput(opts.stepOutputs[shown[0].id]);
  return shown.map((s) => `**${s.id}**: ${humanizeStepOutput(opts.stepOutputs[s.id])}`).join('\n');
}

export interface LegibleOutcome {
  title: string;
  body: string;
  needsAttention: boolean;
}

/**
 * Build the user-facing completion message. When steps blocked, the title
 * says "needs attention" (not "completed") and the body explains in plain
 * language — optionally enriched with a diagnosis + a fix offer.
 */
export function renderLegibleOutcome(opts: {
  workflowName: string;
  blockedSteps: BlockedStep[];
  diagnosis?: WorkflowDiagnosis | null;
  fixId?: string | null;
  fallbackBody: string;
}): LegibleOutcome {
  const { workflowName, blockedSteps, diagnosis, fixId, fallbackBody } = opts;
  if (blockedSteps.length === 0) {
    return { title: `Workflow completed: ${workflowName}`, body: fallbackBody, needsAttention: false };
  }
  const stepList = blockedSteps.map((b) => `• ${b.stepId}: ${b.reason}`).join('\n');
  const lines: string[] = [
    `⚠️ "${workflowName}" couldn't finish — ${blockedSteps.length} step${blockedSteps.length === 1 ? '' : 's'} blocked:`,
    stepList,
  ];
  if (diagnosis) {
    lines.push('', `What happened: ${diagnosis.summary}`, `Why: ${diagnosis.rootCause}`);
    if (diagnosis.fix.autoApplicable && fixId) {
      lines.push('', `I can fix this: ${diagnosis.fix.description}`, `→ Reply \`apply fix ${fixId}\` to apply it, or \`dismiss fix ${fixId}\` to skip.`);
    } else {
      lines.push('', `Suggested fix: ${diagnosis.fix.description}`);
    }
  }
  return { title: `⚠️ Workflow needs attention: ${workflowName}`, body: lines.join('\n'), needsAttention: true };
}
