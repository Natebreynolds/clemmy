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
  return (getRuntimeEnv('WORKFLOW_SELF_HEAL', 'off') ?? 'off').toLowerCase() === 'on';
}

// ─── 1. Detect blocked steps ─────────────────────────────────────────

export interface BlockedStep {
  stepId: string;
  reason: string;
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

// A step agent is told to block via structured `{blocked:true}`, but it
// sometimes returns a prose block instead ("Blocked the workflow step
// because …"). Catch that too, or the ROOT block (e.g. an expired
// connection in step 1) is missed and the Doctor diagnoses a downstream
// symptom. Tight prefix match → minimal false positives (a normal step
// returns structured data or a terse summary, not text starting with
// "Blocked").
const PROSE_BLOCK_RE = /^\s*(?:blocked\b|the (?:workflow )?step (?:is|was) blocked|step blocked\b)/i;

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
      blocked.push({ stepId, reason: String(obj.reason ?? 'No reason was provided.').slice(0, 600) });
    } else if (typeof raw === 'string' && PROSE_BLOCK_RE.test(raw.trim())) {
      blocked.push({ stepId, reason: raw.trim().slice(0, 600) });
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

// ─── 4. Apply (approval-gated only) ──────────────────────────────────

export interface ApplyResult {
  ok: boolean;
  message: string;
  errors?: string[];
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
  writeWorkflow(fix.workflow, updated);
  dismissProposedFix(id);
  logger.info({ workflow: fix.workflow, step: fix.stepId, fixId: id }, 'self-heal: applied workflow fix');
  return { ok: true, message: `Applied the fix to "${fix.workflow}" · step "${fix.stepId}". Re-run the workflow when ready.` };
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
