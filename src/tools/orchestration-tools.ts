import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  CRON_FILE,
} from '../memory/vault.js';
import {
  deleteWorkflow,
  listWorkflows,
  readWorkflow,
  writeWorkflow,
  type WorkflowDefinition,
  type WorkflowEntry,
} from '../memory/workflow-store.js';
import { prepareWorkflowForWrite } from '../execution/workflow-enforce.js';
import { describeWorkflowPlainEnglish, describeWorkflowOneLine, describeCron } from '../execution/workflow-describe.js';
import { validateCronExpression } from '../shared/cron.js';
import { draftWorkflowFromSession, type WorkflowDraft } from '../execution/trace-to-workflow.js';
import { analyzeWorkflowGaps, renderWorkflowGapQuestions } from '../execution/workflow-gap-test.js';
import {
  CRON_PROGRESS_DIR,
  CRON_RUNS_DIR,
  CRON_TRIGGERS_DIR,
  WORKFLOW_RUNS_DIR,
  ensureDir,
  textResult,
} from './shared.js';
import {
  getWorkflowImportJob,
  listRecentWorkflowImportJobs,
  startWorkflowFrameworkImport,
} from '../runtime/workflow-installer.js';
import {
  missingWorkflowRunInputs,
  normalizeWorkflowRunInputs,
} from '../execution/workflow-inputs.js';
import { queueWorkflowRun } from './workflow-run-queue.js';
import { surfaceWorkflowPendingInputs } from '../agents/plan-proposals.js';
import { getToolOutputContext } from '../runtime/harness/tool-output-context.js';
import { listEvents } from '../runtime/harness/eventlog.js';
import {
  unrequestedWorkflowRunMessage,
  workflowExplicitlyRequested,
} from './workflow-run-guard.js';
import {
  resolveWorkflowName,
  textRefersToWorkflow,
  workflowNamesEqual,
  type ResolverEntry,
} from './workflow-resolve.js';
import { addNotification } from '../runtime/notifications.js';
import { matchToolChoicesForStep, type StepToolChoiceMatch, type ToolChoiceRecord } from '../memory/tool-choice-store.js';

/**
 * Parse the workflow_run `inputs` field, which the model passes as a JSON
 * string (mirrors composio_execute_tool's `arguments`). A JSON-string param
 * fills reliably under the codex strict-mode function-calling that an open
 * `z.record` map does NOT (the map was emitted `{}` 223/223 in history).
 * Empty/whitespace → {}. Throws a descriptive error on malformed JSON so the
 * model self-corrects instead of looping. Values are coerced toward strings
 * downstream by normalizeWorkflowRunInputs.
 */
/**
 * Render non-blocking authoring advisories (output-contract / forEach hints)
 * into the workflow_create/_update tool result so the AUTHORING agent sees them
 * and can self-correct before relying on the workflow. Advisory only — the
 * write already succeeded. Empty string when there is nothing to flag, so a
 * clean authoring run is byte-identical.
 */
export interface AuthoredWorkflowResult {
  ok: boolean;
  errors: string[];
  savedDef: WorkflowDefinition;
  repairs: string[];
  warnings: string[];
  boundNotes: string[];
  advisories: string[];
  gaps: ReturnType<typeof analyzeWorkflowGaps>;
}

/**
 * Canonical "author and persist a NEW workflow" core, shared by workflow_create
 * and workflow_from_session so promotion can never drift from the create path.
 * Binds proven tool-choices → auto-repairs + validates → persists (only when
 * valid) → gap-tests. Returns the structured result; each caller composes its
 * own response text. (This is the F4 consolidation, justified now that a second
 * real consumer — promotion — needs the exact same author behavior.)
 */
export function commitAuthoredWorkflow(def: WorkflowDefinition, dirName: string): AuthoredWorkflowResult {
  const bind = bindStepsToToolChoices(def.steps);
  const prep = prepareWorkflowForWrite(def);
  if (!prep.ok) {
    return {
      ok: false, errors: prep.errors, savedDef: prep.def, repairs: prep.repairs,
      warnings: prep.warnings, boundNotes: bind.boundNotes, advisories: bind.advisories, gaps: [],
    };
  }
  writeWorkflow(dirName, prep.def);
  return {
    ok: true, errors: [], savedDef: prep.def, repairs: prep.repairs,
    warnings: prep.warnings, boundNotes: bind.boundNotes, advisories: bind.advisories,
    gaps: analyzeWorkflowGaps(prep.def),
  };
}

/** Build a WorkflowDefinition from a session-trace draft. Saved DISABLED so a
 *  reconstructed workflow is reviewed (and smoke-tested) before it can fire.
 *  Pure + exported for tests. */
export function draftToDefinition(name: string, draft: WorkflowDraft): WorkflowDefinition {
  return {
    name,
    description: `Reusable workflow built from a chat session (${draft.toolCallCount} action${draft.toolCallCount === 1 ? '' : 's'}).`,
    enabled: false,
    trigger: { manual: true },
    steps: draft.steps.map((s) => ({
      id: s.id,
      prompt: s.prompt,
      dependsOn: s.dependsOn,
      allowedTools: s.allowedTools,
      ...(s.requiresApproval ? { requiresApproval: true, approvalPreview: s.approvalPreview } : {}),
    })),
  };
}

export function renderAuthoringAdvisories(warnings: string[] | undefined): string {
  if (!warnings || warnings.length === 0) return '';
  return `\n\nHeads up (advisory — the workflow was saved):\n- ${warnings.join('\n- ')}`;
}

export interface StepBindResult {
  /** Confirmation lines for steps that were AUTO-bound (deterministic). */
  boundNotes: string[];
  /** Advisory lines for steps that SHOULD bind but weren't auto-bound. */
  advisories: string[];
}

/** Marker delimiting the engine-appended bind directive from the author's
 *  prompt. A step carrying it is already engine-bound (skip + don't re-match the
 *  directive's own prose, which would otherwise let a 2nd workflow_update bind a
 *  different choice off boilerplate words). */
const BIND_DIRECTIVE_MARKER = '\n\n→ Proven tool (engine-bound):';

/** Convert `{{var}}` placeholders to `<var>` so a baked command is GUIDANCE, not
 *  a workflow template token — otherwise checkMalformedTokens would reject the
 *  workflow on its own injected `{{soql}}`, and renderTemplate can't fill it. */
function neutralizeTemplatePlaceholders(s: string): string {
  return s.replace(/\{\{\s*([^}]+?)\s*\}\}/g, '<$1>');
}

/** Lock a step's allowedTools to a bound family: keep any explicitly-allowed
 *  NON-composio tools the author listed, drop composio_* (the drift gateway),
 *  and ensure the family is present. A wildcard/empty list becomes the family. */
function lockAllowedToolsTo(existing: string[] | undefined, family: string[]): string[] {
  const kept = (existing ?? []).filter((t) => t && t !== '*' && !t.startsWith('composio'));
  return [...new Set<string>([...kept, ...family])];
}

/** Auto-bind may NARROW the tool surface but must never WIDEN the auto-approval
 *  scope: if the author explicitly scoped the step (non-wildcard) and the proven
 *  family isn't already reachable, locking it in would silently auto-approve a
 *  tool they deliberately excluded. In that case we ADVISE instead of mutating. */
function canLockWithoutEscalation(existing: string[] | undefined, family: string[]): boolean {
  if (!existing || existing.length === 0 || existing.some((t) => t === '*')) return true; // wildcard → narrowing
  return family.every((f) =>
    existing.some((e) => e === f || (e.endsWith('*') && f.startsWith(e.slice(0, -1)))));
}

/**
 * Hybrid author-time binding (the centerpiece of tight authoring). For each
 * step, find the user's PROVEN tool-choice for what the step does:
 *   - HIGH-confidence cli/mcp match → AUTO-BIND: bake the exact command into the
 *     step prompt AND lock allowedTools to that family (dropping the composio
 *     drift gateway) so the run uses the path that works and can't re-decide.
 *   - MEDIUM match, or any composio match (identifier/connection rot-prone) →
 *     ADVISE only: name the exact command so the author can bind it; never mutate.
 *   - Already-bound or usesSkill steps are left untouched.
 * Mutates `steps` in place; returns notes for the tool result. Best-effort — a
 * matcher error never blocks the write (a clean store yields empty results).
 */
export function bindStepsToToolChoices(
  steps: Array<{ id?: string; prompt: string; allowedTools?: string[]; usesSkill?: string }>,
  opts: { choices?: ToolChoiceRecord[] } = {},
): StepBindResult {
  const boundNotes: string[] = [];
  const advisories: string[] = [];
  for (const step of steps) {
    if (step.usesSkill) continue; // a skill owns its own tool surface
    if (step.prompt.includes(BIND_DIRECTIVE_MARKER)) continue; // already engine-bound
    let matches: StepToolChoiceMatch[];
    try { matches = matchToolChoicesForStep(step.prompt, { choices: opts.choices }); } catch { continue; }
    const top = matches.find((m) => !m.alreadyBound);
    if (!top) continue;
    // AUTO-BIND only when it's a proven cli/mcp choice AND locking it in won't
    // silently widen the auto-approval scope the author chose; otherwise advise.
    const safeToLock = canLockWithoutEscalation(step.allowedTools, top.family);
    if (top.autoBindable && top.tier === 'high' && safeToLock) {
      const how = top.kind === 'cli' ? ' via run_shell_command' : '';
      const noun = top.kind === 'cli' ? 'command' : 'tool';
      const cmd = neutralizeTemplatePlaceholders(top.command);
      step.prompt =
        `${step.prompt}${BIND_DIRECTIVE_MARKER} use this exact, proven ${noun} (do not substitute another tool): \`${cmd}\`${how}.`;
      step.allowedTools = lockAllowedToolsTo(step.allowedTools, top.family);
      boundNotes.push(
        `Bound step \`${step.id ?? '?'}\` to your proven ${top.kind} \`${cmd}\` and locked its tools so the run can't drift onto a stale path.`,
      );
    } else {
      const cmd = neutralizeTemplatePlaceholders(top.command);
      const what = top.kind === 'composio'
        ? `could use your remembered \`${top.identifier}\``
        : `should use your proven \`${cmd}\``;
      advisories.push(
        `Step \`${step.id ?? '?'}\` ${what} — embed that exact ${top.kind === 'cli' ? 'command (via run_shell_command)' : 'tool'} in the step prompt and set its allowedTools to that family, so the run uses the proven path instead of re-deciding.`,
      );
    }
  }
  return { boundNotes, advisories };
}

const ACTIVE_RUN_STATUSES = new Set(['queued', 'running', 'parked']);

function formatRunAge(iso?: string): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const mins = Math.max(0, Math.round((Date.now() - t) / 60_000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

/**
 * Render a compact overview of workflow runs for chat recall ("what's running?"):
 * every in-flight (queued/running/parked) or needs-attention run, plus the few
 * most-recent finished ones. Reads the run-record files directly — token-cheap.
 */
export function renderWorkflowRunsOverview(limit = 15): string {
  if (!existsSync(WORKFLOW_RUNS_DIR)) return 'No workflow runs yet — nothing is running.';
  interface RunRow { id: string; workflow: string; status: string; createdAt?: string; needsAttention?: boolean; }
  const rows: RunRow[] = [];
  for (const file of readdirSync(WORKFLOW_RUNS_DIR)) {
    if (!file.endsWith('.json')) continue;
    try {
      const r = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, file), 'utf-8')) as Record<string, unknown>;
      if (typeof r.id !== 'string') continue;
      rows.push({
        id: r.id,
        workflow: typeof r.workflow === 'string' ? r.workflow : '(unknown)',
        status: typeof r.status === 'string' ? r.status : 'unknown',
        createdAt: typeof r.createdAt === 'string' ? r.createdAt : undefined,
        needsAttention: r.needsAttention === true,
      });
    } catch { /* skip malformed run file */ }
  }
  if (rows.length === 0) return 'No workflow runs yet — nothing is running.';
  const byCreated = (a: RunRow, b: RunRow) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '');
  const active = rows.filter((r) => ACTIVE_RUN_STATUSES.has(r.status) || r.needsAttention).sort(byCreated);
  const recent = rows.filter((r) => !ACTIVE_RUN_STATUSES.has(r.status) && !r.needsAttention).sort(byCreated).slice(0, 5);
  const fmt = (r: RunRow) =>
    `- ${r.workflow} · ${r.status}${r.needsAttention ? ' · NEEDS ATTENTION' : ''} · run ${r.id}${r.createdAt ? ` · ${formatRunAge(r.createdAt)}` : ''}`;
  const parts: string[] = [];
  if (active.length > 0) {
    parts.push(`${active.length} active run${active.length === 1 ? '' : 's'} (in-flight / needs attention):`);
    parts.push(...active.slice(0, limit).map(fmt));
  } else {
    parts.push('No workflows are running right now.');
  }
  if (recent.length > 0) {
    parts.push('', 'Recently finished:', ...recent.map(fmt));
  }
  return parts.join('\n');
}

export function parseWorkflowRunInputsJson(raw: string | null | undefined): Record<string, string> {
  if (raw === null || raw === undefined) return {};
  const trimmed = raw.trim();
  if (trimmed === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`Invalid workflow inputs JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Workflow inputs must be a JSON object, e.g. {"url":"https://example.com"}.');
  }
  return parsed as Record<string, string>;
}

/**
 * Parse the workflow_create/_update `inputs` SCHEMA field — a JSON string
 * mapping input names to per-input metadata {type?, default?, description?}.
 * Same JSON-string rationale as parseWorkflowRunInputsJson; distinct because
 * the values are objects, not flat strings.
 */
export function parseWorkflowInputsSchemaJson(
  raw: string | null | undefined,
): Record<string, { type?: 'string' | 'number'; default?: string; description?: string }> {
  if (raw === null || raw === undefined) return {};
  const trimmed = raw.trim();
  if (trimmed === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`Invalid workflow inputs schema JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Workflow inputs schema must be a JSON object mapping input names to {type, default, description}.');
  }
  return parsed as Record<string, { type?: 'string' | 'number'; default?: string; description?: string }>;
}

/**
 * Step OUTPUT contract (WorkflowStepOutputContract). Shared by workflow_create
 * + workflow_update so authors can DECLARE what a step produces. Optional, by
 * design: a step with no `output` is unverified — byte-identical to before
 * (the gradual-typing / Dagster-asset-check posture). When declared, the engine
 * verifies the step's output against it before recording completion
 * (verifyStepOutput, runtime-enforced). Named properties (not an open map), so
 * it fills reliably under strict-mode function-calling.
 */
const WorkflowStepOutputContractSchema = z.object({
  type: z.enum(['string', 'number', 'boolean', 'object', 'array']).optional()
    .describe('The shape the step must produce.'),
  required_keys: z.array(z.string()).optional()
    .describe('For an object output: top-level keys that must be present and non-null.'),
  verify: z.object({
    path_exists: z.array(z.string()).optional()
      .describe('Dot-paths in the output whose value must be an existing file path.'),
    url_present: z.array(z.string()).optional()
      .describe('Dot-paths in the output whose value must be a non-empty http(s) URL.'),
  }).optional()
    .describe('Concrete-handle checks — confirm the named output values are REAL (a file that exists, a non-empty URL), so "produced a brief" cannot pass when the file/URL does not actually exist.'),
  description: z.string().optional().describe('One-line note on what this step produces.'),
});

const STEP_OUTPUT_CONTRACT_DESC =
  'OPTIONAL output contract — what this step PRODUCES. When declared, the engine verifies the step output against it BEFORE recording completion; a violation fails the step loudly (reports back) instead of feeding bad data to the next step. Declare it on any step whose output a later step depends on, and ALWAYS on the step that produces the final deliverable (e.g. a created sheet/file/URL), so the result is verified, not just claimed. Omit it for free-form/conversational steps.';

interface CronJobRecord {
  name: string;
  schedule: string;
  prompt: string;
  tier?: number;
  enabled?: boolean;
  work_dir?: string;
  mode?: 'standard' | 'unleashed';
  max_hours?: number;
}

// Workflow schema lives in the shared workflow-store module so the MCP
// tools, the daemon's workflow runner, and the dashboard REST routes
// all parse identical shapes. Importing the types instead of redefining
// them keeps the three surfaces in lock-step on field defaults.


function fieldMatch(field: string, value: number): boolean {
  if (field === '*') return true;
  if (field.startsWith('*/')) {
    const step = parseInt(field.slice(2), 10);
    return !Number.isNaN(step) && step > 0 && value % step === 0;
  }
  for (const part of field.split(',')) {
    if (part.includes('-')) {
      const [a, b] = part.split('-').map(Number);
      if (!Number.isNaN(a) && !Number.isNaN(b) && value >= a && value <= b) return true;
    } else if (parseInt(part, 10) === value) {
      return true;
    }
  }
  return false;
}

// Cron → human recurrence. Canonical implementation lives in
// workflow-describe.ts (describeCron); this local alias keeps the cron_list
// call site readable while removing the duplicate humanizer.
const describeCronSchedule = describeCron;

function getNextRun(expr: string): string | null {
  if (!validateCronExpression(expr)) return null;
  const [minF, hourF, domF, monF, dowF] = expr.trim().split(/\s+/);
  const now = new Date();
  for (let offset = 1; offset <= 2880; offset += 1) {
    const t = new Date(now.getTime() + offset * 60_000);
    const matches =
      fieldMatch(minF, t.getMinutes()) &&
      fieldMatch(hourF, t.getHours()) &&
      fieldMatch(domF, t.getDate()) &&
      fieldMatch(monF, t.getMonth() + 1) &&
      fieldMatch(dowF, t.getDay());
    if (matches) {
      return t.toISOString();
    }
  }
  return null;
}

function loadCronJobs(): CronJobRecord[] {
  if (!existsSync(CRON_FILE)) return [];
  try {
    const parsed = matter(readFileSync(CRON_FILE, 'utf-8'));
    return Array.isArray(parsed.data.jobs) ? (parsed.data.jobs as CronJobRecord[]) : [];
  } catch {
    return [];
  }
}

function saveCronJobs(jobs: CronJobRecord[]): void {
  ensureDir(path.dirname(CRON_FILE));
  const current = existsSync(CRON_FILE) ? matter(readFileSync(CRON_FILE, 'utf-8')) : matter('');
  current.data = { ...(current.data ?? {}), jobs };
  writeFileSync(CRON_FILE, matter.stringify(current.content || '# Cron Jobs\n', current.data), 'utf-8');
}

function safeName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function readRunHistory(jobName: string, limit = 10): Array<{ status?: string; startedAt?: string; finishedAt?: string; durationMs?: number; error?: string }> {
  const filePath = path.join(CRON_RUNS_DIR, `${safeName(jobName)}.jsonl`);
  if (!existsSync(filePath)) return [];
  return readFileSync(filePath, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .slice(-limit)
    .map((line) => {
      try {
        return JSON.parse(line) as { status?: string; startedAt?: string; finishedAt?: string; durationMs?: number; error?: string };
      } catch {
        return {};
      }
    })
    .reverse();
}

// Thin alias so existing callsites that wanted `entry.file` keep working.
// The shared store returns WorkflowEntry with `filePath` + `layout`; we
// expose the basename here for log readability.
function listWorkflowFiles(): WorkflowEntry[] {
  return listWorkflows();
}

export function registerOrchestrationTools(server: McpServer): void {
  server.tool(
    'cron_run_history',
    'Query recent execution history for a cron job.',
    {
      job_name: z.string().min(1),
      limit: z.number().int().min(1).max(50).optional(),
    },
    async ({ job_name, limit }) => {
      const runs = readRunHistory(job_name, limit ?? 10);
      if (runs.length === 0) return textResult(`No execution history found for job '${job_name}'.`);
      return textResult(
        [
          `## Run History: ${job_name}`,
          ...runs.map((run) => {
            const duration = run.durationMs ? `${(run.durationMs / 1000).toFixed(1)}s` : '?';
            return `- [${run.status ?? 'unknown'}] ${run.startedAt ?? 'unknown start'} (${duration})${run.error ? ` | ${run.error}` : ''}`;
          }),
        ].join('\n'),
      );
    },
  );

  server.tool(
    'cron_list',
    'List all scheduled cron jobs with schedules, next run times, and recent status.',
    {},
    async () => {
      const jobs = loadCronJobs();
      if (jobs.length === 0) return textResult('No cron jobs configured.');
      return textResult(
        jobs
          .map((job) => {
            const nextRun = job.enabled === false ? null : getNextRun(job.schedule);
            const lastRun = readRunHistory(job.name, 1)[0];
            return [
              `**${job.name}** [${job.enabled === false ? 'disabled' : 'enabled'}]${job.mode === 'unleashed' ? ' [unleashed]' : ''}`,
              `  Schedule: ${describeCronSchedule(job.schedule)} (\`${job.schedule}\`)`,
              nextRun ? `  Next run: ${nextRun}` : '',
              lastRun ? `  Last run: ${lastRun.status ?? 'unknown'}${lastRun.finishedAt ? ` at ${lastRun.finishedAt}` : ''}` : '',
              job.work_dir ? `  Work dir: ${job.work_dir}` : '',
              `  Prompt: ${job.prompt.slice(0, 120)}${job.prompt.length > 120 ? '...' : ''}`,
            ].filter(Boolean).join('\n');
          })
          .join('\n\n'),
      );
    },
  );

  server.tool(
    'add_cron_job',
    'Add a scheduled cron job to CRON.md.',
    {
      name: z.string().min(1),
      schedule: z.string().min(1),
      prompt: z.string().min(1),
      tier: z.number().optional(),
      enabled: z.boolean().optional(),
      work_dir: z.string().optional(),
      mode: z.enum(['standard', 'unleashed']).optional(),
      max_hours: z.number().optional(),
    },
    async ({ name, schedule, prompt, tier, enabled, work_dir, mode, max_hours }) => {
      if (!validateCronExpression(schedule)) {
        return textResult(`Invalid cron expression: "${schedule}"`);
      }

      const jobs = loadCronJobs();
      if (jobs.some((job) => job.name.toLowerCase() === name.toLowerCase())) {
        return textResult(`A job named "${name}" already exists.`);
      }

      jobs.push({
        name,
        schedule,
        prompt,
        tier: tier ?? 1,
        enabled: enabled ?? true,
        work_dir,
        mode: mode ?? 'standard',
        max_hours,
      });
      saveCronJobs(jobs);

      return textResult(`Added cron job "${name}".`);
    },
  );

  server.tool(
    'trigger_cron_job',
    'Trigger an existing cron job to run immediately by writing a trigger file.',
    {
      job_name: z.string().min(1),
    },
    async ({ job_name }) => {
      const job = loadCronJobs().find((entry) => entry.name === job_name);
      if (!job) return textResult(`Job "${job_name}" not found.`);
      ensureDir(CRON_TRIGGERS_DIR);
      const filePath = path.join(CRON_TRIGGERS_DIR, `${Date.now()}-${safeName(job_name)}.trigger.json`);
      writeFileSync(filePath, JSON.stringify({ jobName: job_name, triggeredAt: new Date().toISOString() }, null, 2), 'utf-8');
      return textResult(`Triggered "${job_name}".`);
    },
  );

  server.tool(
    'workflow_list',
    'List all workflows with description, steps, and trigger metadata.',
    {},
    async () => {
      const workflows = listWorkflowFiles();
      if (workflows.length === 0) return textResult('No workflows found.');
      return textResult(
        workflows
          .map(({ data }) => {
            // Plain-English one-liner (name — when · N steps · pauses for approval),
            // then the description so the user can pick the right one at a glance.
            const summary = describeWorkflowOneLine(data);
            const enabled = data.enabled ? '' : ' [disabled]';
            const desc = data.description ? `\n  ${data.description}` : '';
            return `**${summary}**${enabled}${desc}`;
          })
          .join('\n\n'),
      );
    },
  );

  server.tool(
    'workflow_create',
    "Create a recurring or multi-step automated workflow. SUPER-PLAN POSTURE: authoring a workflow is a deliberate act — never save one that's set up to fail. Think the data flow through end-to-end, and after saving you'll get a GAP TEST: clarifying questions about anything likely to break (missing destination for a deliverable, unclear send recipient, undeclared input, recurring prose with no schedule, batch work without forEach). Put those questions to the user and refine with workflow_update BEFORE telling them it's ready. "
      + "Use this for ANY scheduled or repeated work (\"daily at 6pm\", \"every Monday morning\", \"when X happens, do Y\") INSTEAD of task_add (which is one-shot). A workflow is the WHAT (the steps); after this call, call workflow_schedule to set the cron — that's the WHEN. "
      + "AUTHORING MODEL (important): workflows are AUTONOMOUS BY DEFAULT — an enabled workflow runs every step end-to-end on the user's one-time consent (enabling it), WITHOUT pausing for per-step approval. Do NOT put `request_approval` in step prompts. "
      + "Each step does ONE job and its result flows to dependent steps automatically: every `dependsOn` output is injected into the downstream STEP CONTEXT as real structured data. Use `{{steps.<stepId>.output}}` or step inputs only when you need a precise subpath or a named typed value. "
      + "If — and only if — a step does something IRREVERSIBLE the user should sign off on first (e.g. sending emails, publishing), set `requiresApproval: true` on THAT ONE step and a short `approvalPreview`; the runner surfaces a single batch approval and holds the run there, then continues. Prefer ZERO gates for read/research/draft/deploy-for-review workflows. "
      + "Steps with the same satisfied dependsOn run in parallel; use forEach for per-item fan-out. "
      + "Design THIN agentic steps: a few capable steps (each doing a whole meaningful chunk), not many micro-steps. `dependsOn` both orders steps and carries upstream outputs into the downstream STEP CONTEXT. "
      + "DECLARE OUTPUT CONTRACTS: on any step whose output a later step depends on, and ALWAYS on the step that produces the final deliverable, set `output` to what it must produce — `type` (object/array/string/...), `required_keys` for an object, and `verify.url_present` / `verify.path_exists` for concrete handles (a created sheet/file URL, a saved file path). The engine verifies the step's output against the contract before continuing, so a hollow result (\"done\" with no real URL/file) fails loudly and reports back instead of feeding garbage downstream. Omit `output` for free-form/conversational steps — an undeclared step is simply unverified. "
      + "Call workflow_list first if you want to see existing workflow shapes.",
    {
      name: z.string().min(1),
      description: z.string().min(1),
      steps: z.array(z.object({
        id: z.string().min(1),
        prompt: z.string().min(1).describe('The step task. Outputs from dependsOn steps arrive automatically in STEP CONTEXT.upstream; reference {{steps.<id>.output}} only when a precise inline value is useful. Reference a workflow input with {{input.<key>}}; iterate with {{item}} under forEach.'),
        dependsOn: z.array(z.string()).optional().describe('Step IDs this step waits for. Their outputs are automatically available to this step in STEP CONTEXT.upstream.'),
        orderingOnlyDeps: z.array(z.string()).optional().describe('Deprecated compatibility field. dependsOn now carries data automatically; omit this for new workflows.'),
        model: z.string().optional(),
        tier: z.number().optional(),
        maxTurns: z.number().optional(),
        useHarness: z.boolean().optional(),
        forEach: z.string().optional(),
        allowedTools: z.array(z.string()).optional(),
        usesSkill: z.string().optional().describe('Installed skill directory name (under skills/). For repeatable transforms, prefer one usesSkill step over many hand-wired prompt steps.'),
        requiresApproval: z.boolean().optional(),
        approvalPreview: z.string().optional(),
        output: WorkflowStepOutputContractSchema.optional().describe(STEP_OUTPUT_CONTRACT_DESC),
      })).min(1),
      trigger_schedule: z.string().optional(),
      inputs: z.string().optional().describe('JSON object mapping input NAMES to {type?, default?, description?}, e.g. {"url":{"type":"string","description":"Site to audit"}}. A JSON string fills reliably under strict-mode function-calling where an open map does not.'),
      synthesis_prompt: z.string().optional(),
    },
    async ({ name, description, steps, trigger_schedule, inputs, synthesis_prompt }) => {
      let inputsSchema: Record<string, { type?: 'string' | 'number'; default?: string; description?: string }>;
      try {
        inputsSchema = parseWorkflowInputsSchemaJson(inputs);
      } catch (error) {
        return textResult(error instanceof Error ? error.message : String(error));
      }
      const ids = new Set(steps.map((step) => step.id));
      if (ids.size !== steps.length) return textResult('Duplicate workflow step IDs found.');
      for (const step of steps) {
        for (const dep of step.dependsOn ?? []) {
          if (!ids.has(dep)) return textResult(`Step "${step.id}" depends on unknown step "${dep}".`);
        }
      }
      if (trigger_schedule && !validateCronExpression(trigger_schedule)) {
        return textResult(`Invalid cron expression: "${trigger_schedule}"`);
      }

      const dirName = name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
      if (readWorkflow(dirName)) return textResult(`Workflow "${name}" already exists.`);

      const def: WorkflowDefinition = {
        name,
        description,
        enabled: true,
        trigger: trigger_schedule ? { schedule: trigger_schedule, manual: true } : { manual: true },
        steps: steps.map((s) => ({
          id: s.id,
          prompt: s.prompt,
          dependsOn: s.dependsOn,
          orderingOnlyDeps: s.orderingOnlyDeps,
          model: s.model,
          tier: s.tier,
          maxTurns: s.maxTurns,
          useHarness: s.useHarness,
          forEach: s.forEach,
          allowedTools: s.allowedTools,
          usesSkill: s.usesSkill,
          requiresApproval: s.requiresApproval,
          approvalPreview: s.approvalPreview,
          output: s.output,
        })),
        inputs: Object.keys(inputsSchema).length > 0 ? inputsSchema : undefined,
        synthesis: synthesis_prompt ? { prompt: synthesis_prompt } : undefined,
      };
      // Tight authoring: bind steps to the user's proven tool-choices BEFORE
      // Author through the canonical core (bind → auto-repair + validate →
      // persist → gap-test). Auto-repair saves a runnable workflow in one shot
      // instead of bouncing the author into a token-burning re-author loop;
      // refuse only if the repaired workflow still can't flow. Shared with
      // workflow_from_session so promotion can't drift from this path.
      const created = commitAuthoredWorkflow(def, dirName);
      if (!created.ok) {
        return textResult(
          `Workflow "${name}" was NOT created — fix these first:\n- ${created.errors.join('\n- ')}`,
        );
      }
      const createBindReport = created.boundNotes.length > 0 ? `\n\n${created.boundNotes.join('\n')}` : '';
      return textResult(
        `Created workflow "${name}". Here's what it will do:\n\n${describeWorkflowPlainEnglish(created.savedDef)}\n\n`
          + `Saved to workflows/${dirName}/SKILL.md.${createBindReport}`
          + `${renderAuthoringAdvisories([...created.repairs, ...created.warnings, ...created.advisories])}`
          + `${renderWorkflowGapQuestions(created.gaps)}`,
      );
    },
  );

  server.tool(
    'workflow_from_session',
    'Turn what you JUST did in this chat into a reusable, repeatable workflow. Call this only when the user asks to save/repeat/automate what they just did (confirm with them first). It reads this session\'s tool-call trace, reconstructs the steps — locking each to the exact tool you actually used (so future runs are deterministic) and preserving any approval pause — and saves a DISABLED draft. Returns a plain-English summary to review. After saving, refine any step with workflow_update and enable it with workflow_set_enabled when it\'s ready.',
    {
      name: z.string().min(1).describe('A short name for the new workflow, e.g. "Weekly Prospect Outreach".'),
      sessionId: z.string().optional().describe('Defaults to the CURRENT chat session. Only pass this to promote a different session.'),
    },
    async ({ name, sessionId }) => {
      const sid = sessionId || getToolOutputContext()?.sessionId;
      if (!sid) {
        return textResult('I can\'t tell which chat to turn into a workflow (no session context). Run this from the chat where you did the work.');
      }
      const dirName = name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase();
      if (readWorkflow(dirName)) {
        return textResult(`A workflow named "${name}" already exists — pick a different name, or update it with workflow_update.`);
      }
      const draft = draftWorkflowFromSession(sid);
      if (draft.steps.length === 0) {
        return textResult(`There's nothing to turn into a workflow yet: ${draft.notes[0] ?? 'no actions found in this chat.'}`);
      }
      const def = draftToDefinition(name, draft);
      const built = commitAuthoredWorkflow(def, dirName);
      if (!built.ok) {
        return textResult(`I couldn't build "${name}" from this chat — these need fixing first:\n- ${built.errors.join('\n- ')}`);
      }
      const n = draft.toolCallCount;
      return textResult(
        `Built a draft workflow "${name}" from this chat — saved DISABLED so you can review before it runs.\n\n`
          + describeWorkflowPlainEnglish(built.savedDef)
          + `\n\nReconstructed from ${n} action${n === 1 ? '' : 's'} you took. Before enabling:\n- ${draft.notes.join('\n- ')}`
          + renderWorkflowGapQuestions(built.gaps)
          + `\n\nRefine any step with workflow_update, then enable it with workflow_set_enabled when it's ready.`,
      );
    },
  );

  server.tool(
    'workflow_run',
    'Dispatch a workflow to run in the BACKGROUND (fire-and-forget) — it runs in the daemon and reports its outcome back to this chat automatically on completion; you do not wait or poll. Call workflow_get first and pass every required input, for example inputs.url for URL-based audit workflows. Missing required inputs are rejected without queuing. '
      + 'You may pass the user\'s loose name (e.g. "prospecting flow"): if it is not an exact match the tool returns the CLOSEST workflow (or asks which of several) so you can confirm with the user — "Just to confirm, did you want me to kick off your <X> workflow? I\'ll report back once it\'s done." — then call again with that exact name. Only an exact name runs straight through.',
    {
      name: z.string().min(1),
      inputs: z.string().optional().describe('JSON object of the workflow\'s inputs, e.g. {"url":"https://example.com"}. Call workflow_get first to see the required input names.'),
    },
    async ({ name, inputs }) => {
      const all = listWorkflowFiles();
      const resolverEntries: ResolverEntry[] = all.map((e) => ({
        name: e.data.name,
        slug: path.basename(e.dir),
      }));
      // Match by NAME, not just the exact direct name: a user who says "kick off
      // my prospecting flow" should land on "Morning Prospect Prep" — but Clem
      // CONFIRMS the close match before running, and asks which one when several
      // fit. Only an exact name runs straight through.
      const resolution = resolveWorkflowName(name, resolverEntries);
      if (resolution.kind === 'none') {
        const names = resolverEntries.map((e) => `"${e.name}"`).join(', ');
        return textResult(
          resolverEntries.length === 0
            ? `No workflow matches "${name}", and there are no saved workflows. Just do the task directly.`
            : `No workflow closely matches "${name}". Saved workflows: ${names}. If the user meant one of these, confirm which and call workflow_run with its exact name; otherwise just do the task ad-hoc.`,
        );
      }
      if (resolution.kind === 'ambiguous') {
        const opts = resolution.candidates.map((c) => `"${c}"`).join(', ');
        return textResult(
          `"${name}" could mean more than one workflow: ${opts}. Ask the user which one they want — e.g. "Did you mean ${resolution.candidates.map((c) => `your ${c}`).join(' or ')}?" — then call workflow_run with that exact name.`,
        );
      }
      if (resolution.kind === 'fuzzy') {
        return textResult(
          `No workflow is named exactly "${name}". The closest match is "${resolution.name}". `
            + `Confirm with the user before running it — e.g. "Just to confirm, did you want me to kick off your ${resolution.name} workflow? I'll report back once it's done." — `
            + `then call workflow_run with name "${resolution.name}".`,
        );
      }
      // Exact match → run it.
      const workflow = all.find((e) => workflowNamesEqual(e.data.name, resolution.name));
      if (!workflow) return textResult(`Workflow "${name}" not found.`);
      const canonicalName = workflow.data.name;
      if (!workflow.data.enabled) return textResult(`Workflow "${canonicalName}" is disabled.`);

      // Soft boundary guard (2026-05-31 incident): do NOT silently auto-run a
      // workflow the user did not explicitly name in their recent request.
      // Scheduled/cron runs do not pass through this tool (they are driven by
      // the daemon runner), so this is naturally chat/agent-scoped. When there
      // is no session context (internal/test/non-chat caller) we SKIP the guard
      // and allow the run — that no-context skip is also what keeps the
      // existing orchestration-tools tests green.
      const guardCtx = getToolOutputContext();
      if (guardCtx?.sessionId) {
        let recentUserText = '';
        try {
          const inputEvents = listEvents(guardCtx.sessionId, {
            types: ['user_input_received'],
            desc: true,
            limit: 5,
          });
          recentUserText = inputEvents
            .map((event) => {
              const data = event.data as { text?: unknown };
              // The canonical user-message text lives in data.text (see
              // session.ts / plan-first.ts append sites; discord-harness.ts
              // reads data.text). Fall back to stringifying the whole data
              // object so a future field rename can't silently no-op the guard.
              return typeof data?.text === 'string' ? data.text : JSON.stringify(event.data ?? {});
            })
            .join('\n');
        } catch {
          // Event-log read failure must not block a legitimate run.
          recentUserText = '';
        }

        // Use the workflow store name + directory basename as slug variants.
        // Take only the basename of dir (never the full absolute path) so an
        // unrelated path segment can't produce a spurious "explicitly
        // requested" match.
        const slugCandidates = [workflow.name, path.basename(workflow.dir)].filter(
          (value): value is string => typeof value === 'string' && value.length > 0,
        );
        // The user "explicitly requested" this workflow if their recent text
        // names it directly OR resolves to it by matching name (so a confirmed
        // fuzzy run — "kick off my prospecting flow" → Morning Prospect Prep —
        // isn't re-blocked as unrequested). A request that clearly points at a
        // DIFFERENT workflow (or none) still fails the guard.
        const thisEntry: ResolverEntry = { name: canonicalName, slug: path.basename(workflow.dir) };
        if (
          recentUserText.trim() !== '' &&
          !workflowExplicitlyRequested(canonicalName, slugCandidates, recentUserText) &&
          !textRefersToWorkflow(recentUserText, thisEntry, resolverEntries)
        ) {
          return textResult(unrequestedWorkflowRunMessage(canonicalName));
        }
      }

      let parsedInputs: Record<string, string>;
      try {
        parsedInputs = parseWorkflowRunInputsJson(inputs);
      } catch (error) {
        return textResult(error instanceof Error ? error.message : String(error));
      }
      const normalizedInputs = normalizeWorkflowRunInputs(parsedInputs);
      const missing = missingWorkflowRunInputs(workflow.data, normalizedInputs);
      if (missing.length > 0) {
        // Ask-then-resume: in a chat context, surface a pending-inputs proposal
        // keyed to the session so the user's NEXT reply supplies the values and
        // we resume the run (see plan-continuity). This replaces the old
        // model-directed retry message that the strict-mode schema could not
        // satisfy — the call that drove the 84× / 3-min hang. No session context
        // (tests / internal callers) → keep the deterministic rejection.
        if (guardCtx?.sessionId) {
          surfaceWorkflowPendingInputs({
            workflowName: canonicalName,
            requiredInputs: missing,
            providedInputs: normalizedInputs,
            sessionId: guardCtx.sessionId,
            originatingRequest: `Run the "${canonicalName}" workflow`,
          });
          const inputList = missing.map((key) => `\`${key}\``).join(', ');
          return textResult(
            `I need ${inputList} to run the "${canonicalName}" workflow. Reply with ${missing.length === 1 ? 'it' : 'them'} and I'll run it.`,
          );
        }
        return textResult(
          [
            `Workflow "${canonicalName}" was not queued because required input${missing.length === 1 ? '' : 's'} ${missing.map((key) => `"${key}"`).join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing.`,
            `Call workflow_run again with inputs including ${missing.map((key) => `"${key}": "<value>"`).join(', ')}.`,
          ].join('\n'),
        );
      }

      // Gap E: carry the triggering chat session so the run re-enters it on a
      // terminal state (in-context report-back, in ADDITION to the global
      // notification). guardCtx is the agent's tool-output context resolved
      // above; absent for non-chat callers → notification-only.
      return textResult(
        queueWorkflowRun(canonicalName, normalizedInputs, { originSessionId: guardCtx?.sessionId }).message,
      );
    },
  );

  server.tool(
    'workflow_get',
    'Fetch the full definition of a single workflow by name. Includes description, trigger, every step with its prompt + dependencies, declared inputs, and synthesis prompt.',
    {
      name: z.string().min(1),
    },
    async ({ name }) => {
      const allGet = listWorkflowFiles();
      let entry = allGet.find((w) => w.data.name === name);
      if (!entry) {
        // Match by name, not just the exact direct name — same resolver the
        // run path uses, so workflow_get("prospecting flow") still finds it.
        const resolution = resolveWorkflowName(
          name,
          allGet.map((e) => ({ name: e.data.name, slug: path.basename(e.dir) })),
        );
        if (resolution.kind === 'exact' || resolution.kind === 'fuzzy') {
          entry = allGet.find((w) => workflowNamesEqual(w.data.name, resolution.name));
        } else if (resolution.kind === 'ambiguous') {
          return textResult(
            `"${name}" could mean: ${resolution.candidates.map((c) => `"${c}"`).join(', ')}. Ask the user which one, then call workflow_get with that exact name.`,
          );
        }
      }
      if (!entry) {
        const names = allGet.map((w) => `"${w.data.name}"`).join(', ');
        return textResult(`Workflow "${name}" not found.${names ? ` Saved workflows: ${names}.` : ''}`);
      }
      const w = entry.data;
      const stepsBlock = w.steps.map((step) => {
        const deps = step.dependsOn && step.dependsOn.length > 0 ? ` (depends on: ${step.dependsOn.join(', ')})` : '';
        const model = step.model ? ` model=${step.model}` : '';
        const forEach = step.forEach ? ` forEach=${step.forEach}` : '';
        const det = step.deterministic ? ` deterministic=${step.deterministic.runner}` : '';
        return `  ${step.id}${deps}${model}${forEach}${det}\n    ${step.prompt.slice(0, 600).replace(/\n+/g, ' ')}`;
      }).join('\n');
      const inputsBlock = w.inputs && Object.keys(w.inputs).length > 0
        ? Object.entries(w.inputs).map(([k, meta]) => `  - ${k}: ${meta.type ?? 'string'}${meta.default !== undefined ? ` (default: ${meta.default})` : ''}${meta.description ? ` — ${meta.description}` : ''}`).join('\n')
        : '  (none)';
      const trigger = w.trigger.schedule ? `schedule: ${w.trigger.schedule}` : (w.trigger.manual ? 'manual only' : 'manual');
      const allowed = w.allowedTools && w.allowedTools.length > 0
        ? w.allowedTools.map((t) => (typeof t === 'string' ? t : `${t.name}${t.approval === 'required' ? ' (approval)' : ''}`)).join(', ')
        : '(any)';
      // Lead with the plain-English summary — what a human actually wants to
      // read ("what does this do, when, what it needs/produces, where it
      // pauses") — then keep the technical block below for precise editing.
      return textResult([
        describeWorkflowPlainEnglish(w),
        '',
        '— technical detail —',
        `File: ${path.relative(path.dirname(entry.dir), entry.filePath)}`,
        w.whenToUse ? `When to use: ${w.whenToUse}` : '',
        `Trigger: ${trigger}`,
        `Allowed tools: ${allowed}`,
        `Steps (${w.steps.length}):`,
        stepsBlock,
        `Inputs:`,
        inputsBlock,
        w.synthesis?.prompt ? `Synthesis: ${w.synthesis.prompt.slice(0, 600)}` : '',
      ].filter(Boolean).join('\n'));
    },
  );

  server.tool(
    'workflow_set_enabled',
    'Approve or disable a workflow. Sub-agents (Executor / Deployer) only fire approved workflows. Use enabled=true to approve a workflow for autonomous execution; enabled=false to pause it without deleting.',
    {
      name: z.string().min(1),
      enabled: z.boolean(),
    },
    async ({ name, enabled }) => {
      const entry = listWorkflowFiles().find((w) => w.data.name === name);
      if (!entry) return textResult(`Workflow "${name}" not found.`);
      // A workflow whose data can't flow can't be ENABLED (disabling is
      // always allowed). Auto-repair the fixable binding gaps first, so
      // enabling an older workflow with a dangling reference fixes it in
      // place instead of refusing.
      if (enabled) {
        const prep = prepareWorkflowForWrite({ ...entry.data, enabled: true });
        if (!prep.ok) {
          return textResult(
            `Workflow "${name}" was NOT enabled — fix these first:\n- ${prep.errors.join('\n- ')}`,
          );
        }
        writeWorkflow(entry.name, { ...prep.def, enabled: true });
        return textResult(
          `Workflow "${name}" is now approved (enabled).`
            + (prep.repairs.length ? `\n\nAuto-wired on enable:\n- ${prep.repairs.join('\n- ')}` : ''),
        );
      }
      writeWorkflow(entry.name, { ...entry.data, enabled });
      return textResult(`Workflow "${name}" is now disabled.`);
    },
  );

  server.tool(
    'workflow_update',
    'Modify an existing workflow: update description, trigger schedule, steps, inputs, or synthesis. Pass only the fields you want to change — others are preserved. Step IDs and dependencies are re-validated. '
      + 'Design THIN agentic steps: a few capable steps (each doing a whole meaningful chunk), not many micro-steps. `dependsOn` both orders steps and carries upstream outputs into the downstream STEP CONTEXT.',
    {
      name: z.string().min(1),
      description: z.string().optional(),
      steps: z.array(z.object({
        id: z.string().min(1),
        prompt: z.string().min(1).describe('The step task. Outputs from dependsOn steps arrive automatically in STEP CONTEXT.upstream; reference {{steps.<id>.output}} only when a precise inline value is useful. Reference a workflow input with {{input.<key>}}; iterate with {{item}} under forEach.'),
        dependsOn: z.array(z.string()).optional().describe('Step IDs this step waits for. Their outputs are automatically available to this step in STEP CONTEXT.upstream.'),
        orderingOnlyDeps: z.array(z.string()).optional().describe('Deprecated compatibility field. dependsOn now carries data automatically; omit this for new workflows.'),
        model: z.string().optional(),
        tier: z.number().optional(),
        maxTurns: z.number().optional(),
        useHarness: z.boolean().optional(),
        forEach: z.string().optional(),
        allowedTools: z.array(z.string()).optional(),
        usesSkill: z.string().optional().describe('Installed skill directory name (under skills/). For repeatable transforms, prefer one usesSkill step over many hand-wired prompt steps.'),
        output: WorkflowStepOutputContractSchema.optional().describe(STEP_OUTPUT_CONTRACT_DESC),
      })).optional(),
      trigger_schedule: z.string().optional(),
      clear_trigger_schedule: z.boolean().optional().describe('Pass true to remove an existing schedule (e.g. switch back to manual-only).'),
      inputs: z.string().optional().describe('JSON object mapping input NAMES to {type?, default?, description?}, e.g. {"url":{"type":"string","description":"Site to audit"}}. Pass only to change the input schema; omit to preserve it.'),
      synthesis_prompt: z.string().optional(),
    },
    async ({ name, description, steps, trigger_schedule, clear_trigger_schedule, inputs, synthesis_prompt }) => {
      let inputsSchema: Record<string, { type?: 'string' | 'number'; default?: string; description?: string }>;
      try {
        inputsSchema = parseWorkflowInputsSchemaJson(inputs);
      } catch (error) {
        return textResult(error instanceof Error ? error.message : String(error));
      }
      const inputsProvided = Object.keys(inputsSchema).length > 0;
      const entry = listWorkflowFiles().find((w) => w.data.name === name);
      if (!entry) return textResult(`Workflow "${name}" not found.`);

      if (steps) {
        const ids = new Set(steps.map((s) => s.id));
        if (ids.size !== steps.length) return textResult('Duplicate workflow step IDs in update.');
        for (const step of steps) {
          for (const dep of step.dependsOn ?? []) {
            if (!ids.has(dep)) return textResult(`Step "${step.id}" depends on unknown step "${dep}".`);
          }
        }
      }
      if (trigger_schedule && !validateCronExpression(trigger_schedule)) {
        return textResult(`Invalid cron expression: "${trigger_schedule}"`);
      }

      const next: WorkflowDefinition = { ...entry.data };
      if (description !== undefined) next.description = description;
      if (steps) {
        next.steps = steps.map((s) => ({
          id: s.id,
          prompt: s.prompt,
          dependsOn: s.dependsOn,
          orderingOnlyDeps: s.orderingOnlyDeps,
          model: s.model,
          tier: s.tier,
          maxTurns: s.maxTurns,
          useHarness: s.useHarness,
          forEach: s.forEach,
          allowedTools: s.allowedTools,
          usesSkill: s.usesSkill,
          output: s.output,
        }));
      }
      // Tight authoring: bind any newly-provided steps to proven tool-choices.
      const updateBind = steps ? bindStepsToToolChoices(next.steps) : { boundNotes: [], advisories: [] };
      if (inputsProvided) next.inputs = inputsSchema;
      if (synthesis_prompt !== undefined) next.synthesis = { prompt: synthesis_prompt };

      const currentTrigger = next.trigger ?? { manual: true };
      if (clear_trigger_schedule) {
        const { schedule: _drop, ...rest } = currentTrigger;
        next.trigger = { ...rest, manual: true };
      } else if (trigger_schedule !== undefined) {
        next.trigger = { ...currentTrigger, schedule: trigger_schedule, manual: currentTrigger.manual ?? true };
      }

      // Auto-repair the fixable binding gaps before persisting so an edit
      // that left a dangling {{steps.X.output}} / forEach / {{input.X}}
      // saves runnable. Update has never gated on validation; keep it that
      // way — the repair only ever improves the saved definition.
      const updatePrep = prepareWorkflowForWrite(next);
      const savedNext = updatePrep.def;
      writeWorkflow(entry.name, savedNext);
      const changed = [
        description !== undefined ? 'description' : '',
        steps ? 'steps' : '',
        inputsProvided ? 'inputs' : '',
        synthesis_prompt !== undefined ? 'synthesis' : '',
        trigger_schedule !== undefined || clear_trigger_schedule ? 'schedule' : '',
      ].filter(Boolean);
      addNotification({
        id: `workflow-update-${entry.name}-${Date.now()}`,
        kind: 'workflow',
        title: `Workflow updated: ${entry.name}`,
        body: changed.length > 0
          ? `Saved workflow changes (${changed.join(', ')}).`
          : 'Saved workflow changes.',
        createdAt: new Date().toISOString(),
        read: false,
        silent: true,
        metadata: {
          source: 'workflow_update',
          workflowName: entry.name,
          changed,
        },
      });
      // Non-blocking authoring advisories (output-contract / forEach hints).
      // Update has never gated on validation; keep it that way — surface the
      // hints so the author can sharpen the workflow without blocking the save.
      const updateBindReport = updateBind.boundNotes.length > 0 ? `\n\n${updateBind.boundNotes.join('\n')}` : '';
      const updateAdvisories = renderAuthoringAdvisories([
        ...updatePrep.repairs,
        ...updatePrep.warnings,
        ...updateBind.advisories,
      ]);
      // Re-run the gap test on the edited workflow so remaining gaps stay
      // visible until the author actually closes them.
      const updateGaps = renderWorkflowGapQuestions(analyzeWorkflowGaps(savedNext));
      return textResult(
        `Workflow "${name}" updated. Here's what it does now:\n\n${describeWorkflowPlainEnglish(savedNext)}\n\n`
          + `${updateBindReport}${updateAdvisories}${updateGaps}`.trim(),
      );
    },
  );

  server.tool(
    'workflow_import_framework',
    'Import workflow framework packages from a local folder or GitHub repo. Discovers workflows/<name>/SKILL.md and .clementine/workflows/<name>/SKILL.md, preserves scripts/references/tests, and writes source metadata. Use dryRun=true first when reviewing third-party packages.',
    {
      source: z.string().min(1).describe('Local folder path, GitHub URL, git@github.com URL, owner/repo shorthand, or npx skills add owner/repo style reference.'),
      dryRun: z.boolean().optional().describe('Preview discovered workflows without copying files. Default false.'),
      overwrite: z.boolean().optional().describe('Replace existing framework files for same-named workflows, preserving runs/. Default false.'),
    },
    async ({ source, dryRun, overwrite }) => {
      try {
        const job = startWorkflowFrameworkImport(source, { dryRun, overwrite });
        return textResult([
          `Started workflow framework import ${job.id}.`,
          `Status: ${job.status}`,
          `Source: ${job.normalizedSource}`,
          `Dry run: ${job.dryRun ? 'yes' : 'no'}`,
          `Overwrite: ${job.overwrite ? 'yes' : 'no'}`,
          'Call workflow_import_status with this job id for results.',
        ].join('\n'));
      } catch (err) {
        return textResult(`Workflow import failed to start: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  );

  server.tool(
    'workflow_import_status',
    'Check a workflow framework import job. Omit job_id to list recent import jobs.',
    {
      job_id: z.string().optional(),
    },
    async ({ job_id }) => {
      if (!job_id) {
        const recent = listRecentWorkflowImportJobs().slice(0, 10);
        if (recent.length === 0) return textResult('No workflow import jobs yet.');
        return textResult(recent.map((job) =>
          `- ${job.id} [${job.status}] source=${job.normalizedSource} discovered=${job.discovered.length} installed=${job.installed.length} skipped=${job.skipped.length}`,
        ).join('\n'));
      }
      const job = getWorkflowImportJob(job_id);
      if (!job) return textResult(`No workflow import job found with id ${job_id}.`);
      return textResult([
        `Workflow import ${job.id}`,
        `Status: ${job.status}`,
        `Source: ${job.normalizedSource}`,
        `Discovered: ${job.discovered.length}`,
        ...job.discovered.map((item) => `  - ${item.name}: ${item.pathInSource}`),
        `Installed: ${job.installed.length}`,
        ...job.installed.map((item) => `  - ${item.name}: ${item.filePath}`),
        `Skipped: ${job.skipped.length}`,
        ...job.skipped.map((item) => `  - ${item.name}: ${item.reason}`),
        job.error ? `Error: ${job.error}` : '',
        job.output ? `\nLog:\n${job.output}` : '',
      ].filter(Boolean).join('\n'));
    },
  );

  server.tool(
    'workflow_delete',
    'Permanently delete a workflow definition file. Pending queued runs are NOT cancelled — call workflow_run_status on any in-flight runs first.',
    {
      name: z.string().min(1),
      confirm: z.boolean().describe('Must be true to proceed. Guard against accidental deletion.'),
    },
    async ({ name, confirm }) => {
      if (!confirm) return textResult('Refusing to delete: pass confirm=true.');
      const entry = listWorkflowFiles().find((w) => w.data.name === name);
      if (!entry) return textResult(`Workflow "${name}" not found.`);
      const ok = deleteWorkflow(entry.name);
      if (!ok) return textResult(`Workflow "${name}" delete failed (file system error).`);
      return textResult(`Workflow "${name}" deleted.`);
    },
  );

  server.tool(
    'workflow_run_status',
    'Check workflow runs. Pass run_id for one run\'s detail, OR omit it to LIST what is running right now — use the no-id form to answer "what workflows are running / how is my flow going". Lists in-flight (queued/running/parked) + needs-attention runs and the few most-recent finished ones.',
    {
      run_id: z.string().optional().describe('A specific run id for its full record. Omit to list active + recent runs.'),
    },
    async ({ run_id }) => {
      if (run_id && run_id.trim()) {
        const filePath = path.join(WORKFLOW_RUNS_DIR, `${run_id}.json`);
        if (!existsSync(filePath)) return textResult(`Workflow run "${run_id}" not found.`);
        try {
          const record = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
          const lines = [
            `Run ${run_id}`,
            `Workflow: ${record.workflow ?? '(unknown)'}`,
            `Status: ${record.status ?? '(unknown)'}${record.needsAttention ? ' · NEEDS ATTENTION' : ''}`,
            record.createdAt ? `Created: ${record.createdAt}` : '',
            record.finishedAt ? `Finished: ${record.finishedAt}` : '',
            record.inputs && Object.keys(record.inputs).length > 0 ? `Inputs: ${JSON.stringify(record.inputs)}` : '',
            record.error ? `Error: ${record.error}` : '',
          ].filter(Boolean);
          return textResult(lines.join('\n'));
        } catch (err) {
          return textResult(`Failed to read run ${run_id}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      // No id → list active + recent runs so Clem can answer "what's running?".
      return textResult(renderWorkflowRunsOverview());
    },
  );

  server.tool(
    'cron_progress_read',
    'Read saved progress state for a cron job.',
    {
      job_name: z.string().min(1),
    },
    async ({ job_name }) => {
      ensureDir(CRON_PROGRESS_DIR);
      const filePath = path.join(CRON_PROGRESS_DIR, `${safeName(job_name)}.json`);
      if (!existsSync(filePath)) return textResult(`No previous progress found for job "${job_name}".`);
      return textResult(readFileSync(filePath, 'utf-8'));
    },
  );

  server.tool(
    'cron_progress_write',
    'Persist progress state for a cron job.',
    {
      job_name: z.string().min(1),
      completedItems: z.array(z.string()).optional(),
      pendingItems: z.array(z.string()).optional(),
      notes: z.string().optional(),
      state: z.record(z.string(), z.unknown()).optional(),
    },
    async ({ job_name, completedItems, pendingItems, notes, state }) => {
      ensureDir(CRON_PROGRESS_DIR);
      const filePath = path.join(CRON_PROGRESS_DIR, `${safeName(job_name)}.json`);
      const current = existsSync(filePath)
        ? JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>
        : {};
      const next = {
        ...current,
        jobName: job_name,
        lastRunAt: new Date().toISOString(),
        completedItems: completedItems ?? current.completedItems ?? [],
        pendingItems: pendingItems ?? current.pendingItems ?? [],
        notes: notes ?? current.notes ?? '',
        state: state ?? current.state ?? {},
      };
      writeFileSync(filePath, JSON.stringify(next, null, 2), 'utf-8');
      return textResult(`Progress saved for "${job_name}".`);
    },
  );
}
