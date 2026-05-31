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
import { checkWorkflowForWrite } from '../execution/workflow-enforce.js';
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

/**
 * Parse the workflow_run `inputs` field, which the model passes as a JSON
 * string (mirrors composio_execute_tool's `arguments`). A JSON-string param
 * fills reliably under the codex strict-mode function-calling that an open
 * `z.record` map does NOT (the map was emitted `{}` 223/223 in history).
 * Empty/whitespace → {}. Throws a descriptive error on malformed JSON so the
 * model self-corrects instead of looping. Values are coerced toward strings
 * downstream by normalizeWorkflowRunInputs.
 */
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

function validateCronExpression(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return parts.every((part) => /^(\*|\*\/\d+|\d+|\d+-\d+)(,(\*\/\d+|\d+|\d+-\d+))*$/.test(part));
}

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

function describeCronSchedule(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return expr;
  const [min, hour, dom, _mon, dow] = parts;
  if (min.startsWith('*/')) return `every ${min.slice(2)} minutes`;
  if (hour.startsWith('*/')) return `every ${hour.slice(2)} hours`;
  if (hour !== '*' && min !== '*') return `${hour.padStart(2, '0')}:${min.padStart(2, '0')}${dow !== '*' ? ` on ${dow}` : dom !== '*' ? ` on day ${dom}` : ' daily'}`;
  return expr;
}

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

function stableJson(value: unknown): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return JSON.stringify(value);
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(Object.fromEntries(entries));
}

function findDuplicateQueuedWorkflowRun(workflowName: string, inputs: Record<string, string>): { id: string; status: string } | null {
  if (!existsSync(WORKFLOW_RUNS_DIR)) return null;
  const wanted = stableJson(inputs);
  for (const file of readdirSync(WORKFLOW_RUNS_DIR).filter((entry) => entry.endsWith('.json')).sort().reverse()) {
    try {
      const parsed = JSON.parse(readFileSync(path.join(WORKFLOW_RUNS_DIR, file), 'utf-8')) as {
        id?: unknown;
        workflow?: unknown;
        inputs?: unknown;
        status?: unknown;
      };
      const status = typeof parsed.status === 'string' ? parsed.status : 'queued';
      if (status !== 'queued' && status !== 'running') continue;
      if (parsed.workflow !== workflowName) continue;
      const existingInputs = normalizeWorkflowRunInputs(
        parsed.inputs && typeof parsed.inputs === 'object' && !Array.isArray(parsed.inputs)
          ? parsed.inputs as Record<string, string>
          : {},
      );
      if (stableJson(existingInputs) !== wanted) continue;
      const id = typeof parsed.id === 'string' ? parsed.id : path.basename(file, '.json');
      return { id, status };
    } catch {
      continue;
    }
  }
  return null;
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
          .map(({ name, filePath, layout, data }) => {
            const trigger = data.trigger.schedule ? `schedule: ${data.trigger.schedule}` : 'manual';
            const fileLabel = layout === 'directory' ? `${name}/SKILL.md` : path.basename(filePath);
            return `**${data.name}** [${data.enabled ? 'enabled' : 'disabled'}]\n  File: ${fileLabel}\n  ${data.description || '(no description)'}\n  Trigger: ${trigger}\n  Steps (${data.steps.length}): ${data.steps.map((step) => step.id).join(' -> ')}`;
          })
          .join('\n\n'),
      );
    },
  );

  server.tool(
    'workflow_create',
    "Create a recurring or multi-step automated workflow. Use this for ANY scheduled or repeated work (\"daily at 6pm\", \"every Monday morning\", \"when X happens, do Y\") INSTEAD of task_add (which is one-shot). A workflow is the WHAT (the steps); after this call, call workflow_schedule to set the cron — that's the WHEN. "
      + "AUTHORING MODEL (important): workflows are AUTONOMOUS BY DEFAULT — an enabled workflow runs every step end-to-end on the user's one-time consent (enabling it), WITHOUT pausing for per-step approval. Do NOT put `request_approval` in step prompts. "
      + "Each step does ONE job and its result flows to the next step: a downstream step references an upstream result with `{{steps.<stepId>.output}}` (the runner passes the real structured data, not a summary). "
      + "If — and only if — a step does something IRREVERSIBLE the user should sign off on first (e.g. sending emails, publishing), set `requiresApproval: true` on THAT ONE step and a short `approvalPreview`; the runner surfaces a single batch approval and holds the run there, then continues. Prefer ZERO gates for read/research/draft/deploy-for-review workflows. "
      + "Steps with the same satisfied dependsOn run in parallel; use forEach for per-item fan-out. Call workflow_list first if you want to see existing workflow shapes.",
    {
      name: z.string().min(1),
      description: z.string().min(1),
      steps: z.array(z.object({
        id: z.string().min(1),
        prompt: z.string().min(1),
        dependsOn: z.array(z.string()).optional(),
        model: z.string().optional(),
        tier: z.number().optional(),
        maxTurns: z.number().optional(),
        useHarness: z.boolean().optional(),
        forEach: z.string().optional(),
        allowedTools: z.array(z.string()).optional(),
        usesSkill: z.string().optional(),
        requiresApproval: z.boolean().optional(),
        approvalPreview: z.string().optional(),
      })).min(1),
      trigger_schedule: z.string().optional(),
      inputs: z.record(z.string(), z.object({
        type: z.enum(['string', 'number']).optional(),
        default: z.string().optional(),
        description: z.string().optional(),
      })).optional(),
      synthesis_prompt: z.string().optional(),
    },
    async ({ name, description, steps, trigger_schedule, inputs, synthesis_prompt }) => {
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
          model: s.model,
          tier: s.tier,
          maxTurns: s.maxTurns,
          useHarness: s.useHarness,
          forEach: s.forEach,
          allowedTools: s.allowedTools,
          usesSkill: s.usesSkill,
          requiresApproval: s.requiresApproval,
          approvalPreview: s.approvalPreview,
        })),
        inputs: inputs && Object.keys(inputs).length > 0 ? inputs : undefined,
        synthesis: synthesis_prompt ? { prompt: synthesis_prompt } : undefined,
      };
      // P2: refuse to create a workflow whose data can't flow (unbound
      // inputs, malformed {{tokens}}, dangling deps). Flag-gated → no-op
      // when WORKFLOW_TYPED_CONTRACT is off.
      const createCheck = checkWorkflowForWrite(def);
      if (!createCheck.ok) {
        return textResult(
          `Workflow "${name}" was NOT created — fix these first:\n- ${createCheck.errors.join('\n- ')}`,
        );
      }
      writeWorkflow(dirName, def);
      return textResult(`Created workflow "${name}" at workflows/${dirName}/SKILL.md.`);
    },
  );

  server.tool(
    'workflow_run',
    'Queue a workflow run by writing a run request to local workflow state. Call workflow_get first and pass every required input, for example inputs.url for URL-based audit workflows. Missing required inputs are rejected without queuing.',
    {
      name: z.string().min(1),
      inputs: z.string().optional().describe('JSON object of the workflow\'s inputs, e.g. {"url":"https://example.com"}. Call workflow_get first to see the required input names.'),
    },
    async ({ name, inputs }) => {
      const workflow = listWorkflowFiles().find((entry) => entry.data.name === name);
      if (!workflow) return textResult(`Workflow "${name}" not found.`);
      if (!workflow.data.enabled) return textResult(`Workflow "${name}" is disabled.`);

      let parsedInputs: Record<string, string>;
      try {
        parsedInputs = parseWorkflowRunInputsJson(inputs);
      } catch (error) {
        return textResult(error instanceof Error ? error.message : String(error));
      }
      const normalizedInputs = normalizeWorkflowRunInputs(parsedInputs);
      const missing = missingWorkflowRunInputs(workflow.data, normalizedInputs);
      if (missing.length > 0) {
        return textResult(
          [
            `Workflow "${name}" was not queued because required input${missing.length === 1 ? '' : 's'} ${missing.map((key) => `"${key}"`).join(', ')} ${missing.length === 1 ? 'is' : 'are'} missing.`,
            `Call workflow_run again with inputs including ${missing.map((key) => `"${key}": "<value>"`).join(', ')}.`,
          ].join('\n'),
        );
      }

      ensureDir(WORKFLOW_RUNS_DIR);
      const duplicate = findDuplicateQueuedWorkflowRun(name, normalizedInputs);
      if (duplicate) {
        return textResult(
          `Workflow "${name}" is already ${duplicate.status} as run ${duplicate.id} with the same inputs. No duplicate was queued. Use workflow_run_status with run_id="${duplicate.id}" to check progress.`,
        );
      }

      const id = `${Date.now()}-${randomBytes(3).toString('hex')}`;
      const filePath = path.join(WORKFLOW_RUNS_DIR, `${id}.json`);
      writeFileSync(
        filePath,
        JSON.stringify({
          id,
          workflow: name,
          inputs: normalizedInputs,
          status: 'queued',
          createdAt: new Date().toISOString(),
        }, null, 2),
        'utf-8',
      );

      return textResult(`Queued workflow "${name}" (run ${id}).`);
    },
  );

  server.tool(
    'workflow_get',
    'Fetch the full definition of a single workflow by name. Includes description, trigger, every step with its prompt + dependencies, declared inputs, and synthesis prompt.',
    {
      name: z.string().min(1),
    },
    async ({ name }) => {
      const entry = listWorkflowFiles().find((w) => w.data.name === name);
      if (!entry) return textResult(`Workflow "${name}" not found.`);
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
      return textResult([
        `**${w.name}** [${w.enabled ? 'enabled' : 'disabled'}]`,
        `File: ${path.relative(path.dirname(entry.dir), entry.filePath)}`,
        `${w.description || '(no description)'}`,
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
      // P2: a workflow whose data can't flow can't be ENABLED (disabling
      // is always allowed). Flag-gated → no-op when the flag is off.
      if (enabled) {
        const check = checkWorkflowForWrite({ ...entry.data, enabled: true });
        if (!check.ok) {
          return textResult(
            `Workflow "${name}" was NOT enabled — fix these first:\n- ${check.errors.join('\n- ')}`,
          );
        }
      }
      writeWorkflow(entry.name, { ...entry.data, enabled });
      return textResult(`Workflow "${name}" is now ${enabled ? 'approved (enabled)' : 'disabled'}.`);
    },
  );

  server.tool(
    'workflow_update',
    'Modify an existing workflow: update description, trigger schedule, steps, inputs, or synthesis. Pass only the fields you want to change — others are preserved. Step IDs and dependencies are re-validated.',
    {
      name: z.string().min(1),
      description: z.string().optional(),
      steps: z.array(z.object({
        id: z.string().min(1),
        prompt: z.string().min(1),
        dependsOn: z.array(z.string()).optional(),
        model: z.string().optional(),
        tier: z.number().optional(),
        maxTurns: z.number().optional(),
        useHarness: z.boolean().optional(),
        forEach: z.string().optional(),
        allowedTools: z.array(z.string()).optional(),
        usesSkill: z.string().optional(),
      })).optional(),
      trigger_schedule: z.string().optional(),
      clear_trigger_schedule: z.boolean().optional().describe('Pass true to remove an existing schedule (e.g. switch back to manual-only).'),
      inputs: z.record(z.string(), z.object({
        type: z.enum(['string', 'number']).optional(),
        default: z.string().optional(),
        description: z.string().optional(),
      })).optional(),
      synthesis_prompt: z.string().optional(),
    },
    async ({ name, description, steps, trigger_schedule, clear_trigger_schedule, inputs, synthesis_prompt }) => {
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
          model: s.model,
          tier: s.tier,
          maxTurns: s.maxTurns,
          useHarness: s.useHarness,
          forEach: s.forEach,
          allowedTools: s.allowedTools,
          usesSkill: s.usesSkill,
        }));
      }
      if (inputs) next.inputs = inputs;
      if (synthesis_prompt !== undefined) next.synthesis = { prompt: synthesis_prompt };

      const currentTrigger = next.trigger ?? { manual: true };
      if (clear_trigger_schedule) {
        const { schedule: _drop, ...rest } = currentTrigger;
        next.trigger = { ...rest, manual: true };
      } else if (trigger_schedule !== undefined) {
        next.trigger = { ...currentTrigger, schedule: trigger_schedule, manual: currentTrigger.manual ?? true };
      }

      writeWorkflow(entry.name, next);
      return textResult(`Workflow "${name}" updated.`);
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
    'Check the status of a queued or completed workflow run by id. Returns the run record (status, inputs, createdAt, completion info).',
    {
      run_id: z.string().min(1),
    },
    async ({ run_id }) => {
      const filePath = path.join(WORKFLOW_RUNS_DIR, `${run_id}.json`);
      if (!existsSync(filePath)) return textResult(`Workflow run "${run_id}" not found.`);
      try {
        const record = JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
        const lines = [
          `Run ${run_id}`,
          `Workflow: ${record.workflow ?? '(unknown)'}`,
          `Status: ${record.status ?? '(unknown)'}`,
          record.createdAt ? `Created: ${record.createdAt}` : '',
          record.completedAt ? `Completed: ${record.completedAt}` : '',
          record.inputs && Object.keys(record.inputs).length > 0 ? `Inputs: ${JSON.stringify(record.inputs)}` : '',
          record.error ? `Error: ${record.error}` : '',
        ].filter(Boolean);
        return textResult(lines.join('\n'));
      } catch (err) {
        return textResult(`Failed to read run ${run_id}: ${err instanceof Error ? err.message : String(err)}`);
      }
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
