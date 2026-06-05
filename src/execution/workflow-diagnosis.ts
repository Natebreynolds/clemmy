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
import { readWorkflow, writeWorkflow, type WorkflowDefinition } from '../memory/workflow-store.js';
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
      const r = detectSelfReportedFailure(obj);
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
      const reason = detectSelfReportedFailure(obj);
      if (reason) blocked.push({ stepId, reason: `step "${stepId}" ${reason}`.slice(0, 600), kind: 'self_reported_failure' });
    } else {
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

const FIX_KINDS = ['edit_step', 'reconnect_service', 'adjust_input', 'manual'] as const;

export const WorkflowDiagnosisSchema = z.object({
  summary: z.string().describe('One or two plain-English sentences: what happened, no jargon, no JSON.'),
  rootCause: z.string().describe('Why the step blocked — the specific cause (wrong tool/query, expired connection, missing input, ambiguous instruction).'),
  fix: z.object({
    kind: z.enum(FIX_KINDS).describe('edit_step = rewrite the step prompt; reconnect_service = a connection needs reauth (cannot auto-fix); adjust_input = a run input is missing/wrong; manual = needs human judgment.'),
    stepId: z.string().describe('The step the fix targets.'),
    description: z.string().describe('Plain-English description of the proposed fix, suitable to show the user.'),
    newStepPrompt: z.string().nullable().describe('For kind=edit_step ONLY: the COMPLETE replacement prompt for the step, fixing the root cause (e.g. correct the Composio tool/query, name the explicit access method like the local `sf` CLI, clarify the missing input). null otherwise.'),
    service: z.string().nullable().describe('For kind=reconnect_service: the service that needs reauthorization (e.g. "Google Drive", "Outlook"). null otherwise.'),
    autoApplicable: z.boolean().describe('true ONLY when kind=edit_step AND newStepPrompt is a safe, complete drop-in replacement that preserves the step\'s intent. false for anything needing human action (reconnect/manual/adjust_input).'),
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
  '- A connection/auth error (ComposioToolExecutionError about auth, expired/invalid connection, 401/403): kind=reconnect_service, service=<the service>. Do NOT pretend an edit fixes an auth problem. autoApplicable=false.',
  '- A required run input was missing/empty: kind=adjust_input. autoApplicable=false.',
  '- The step RAN but its output FAILED its declared output contract — wrong type, a missing required key, or a verify.url_present/path_exists handle that was empty or fake (e.g. it claimed "produced a brief" but returned no real URL/file): kind=edit_step. Rewrite the step prompt to EXPLICITLY produce the declared shape — name the required keys it must return, and instruct it to return the REAL artifact (the actual created URL / saved file path), not a summary or a bare claim. The newStepPrompt MUST keep the same declared output contract. autoApplicable=true.',
  '- Genuinely needs human judgment: kind=manual. autoApplicable=false.',
  'When kind=edit_step, newStepPrompt MUST be the COMPLETE replacement prompt for that step (not a diff), preserving the original intent and output contract, fixing only what caused the block. Set autoApplicable=true only then.',
  'Set confidence honestly. If the reason is vague, say so and prefer a conservative fix.',
].join('\n\n');

export interface DiagnoseInput {
  workflow: WorkflowDefinition;
  blockedSteps: BlockedStep[];
  toolErrors?: string[];
}

export async function diagnoseWorkflowBlock(input: DiagnoseInput): Promise<WorkflowDiagnosis | null> {
  const primary = input.blockedSteps[0];
  if (!primary) return null;
  const step = input.workflow.steps.find((s) => s.id === primary.stepId);
  const agent = new Agent({
    name: 'WorkflowDoctor',
    instructions: DOCTOR_INSTRUCTIONS,
    model: MODELS.primary,
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
    input.blockedSteps.length > 1
      ? `Other steps that also blocked (likely downstream of this one): ${input.blockedSteps.slice(1).map((b) => b.stepId).join(', ')}`
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

/**
 * Apply a proposed fix to its workflow. ONLY for kind=edit_step with a
 * complete newStepPrompt; everything else returns ok:false with guidance
 * (auth/reconnect/manual fixes need human action). The edited workflow is
 * re-validated through checkWorkflowForWrite before it is written, so a
 * fix can never write a workflow that would fail the gate.
 */
export function applyProposedFix(id: string): ApplyResult {
  const fix = loadProposedFix(id);
  if (!fix) return { ok: false, message: `No proposed fix found with id "${id}".` };
  const d = fix.diagnosis;
  if (d.fix.kind !== 'edit_step' || !d.fix.autoApplicable || !d.fix.newStepPrompt) {
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

  const updated: WorkflowDefinition = {
    ...def,
    steps: def.steps.map((s, i) => (i === idx ? { ...s, prompt: d.fix.newStepPrompt as string } : s)),
  };
  const check = checkWorkflowForWrite(updated);
  if (!check.ok) {
    return { ok: false, message: `The proposed fix would fail workflow validation; not applied.`, errors: check.errors };
  }
  // Snapshot the PRIOR definition first so a bad heal is reversible (#7).
  const backup = recordFixBackup(fix.workflow, fix.stepId, def, d.fix.description);
  writeWorkflow(fix.workflow, updated);
  dismissProposedFix(id);
  logger.info({ workflow: fix.workflow, step: fix.stepId, fixId: id, backupId: backup?.id }, 'self-heal: applied workflow fix');
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
