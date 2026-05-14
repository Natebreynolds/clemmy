import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  CRON_FILE,
  WORKFLOWS_DIR,
} from '../memory/vault.js';
import {
  CRON_PROGRESS_DIR,
  CRON_RUNS_DIR,
  CRON_TRIGGERS_DIR,
  WORKFLOW_RUNS_DIR,
  ensureDir,
  textResult,
} from './shared.js';

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

interface WorkflowStepInput {
  id: string;
  prompt: string;
  dependsOn?: string[];
  model?: string;
  tier?: number;
  maxTurns?: number;
}

interface WorkflowFile {
  name: string;
  description: string;
  enabled: boolean;
  trigger: { schedule?: string; manual?: boolean };
  steps: WorkflowStepInput[];
  inputs?: Record<string, { type?: 'string' | 'number'; default?: string; description?: string }>;
  synthesis?: { prompt?: string };
}

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

function listWorkflowFiles(): Array<{ file: string; data: WorkflowFile }> {
  if (!existsSync(WORKFLOWS_DIR)) return [];
  const workflows: Array<{ file: string; data: WorkflowFile }> = [];
  for (const file of readdirSync(WORKFLOWS_DIR).filter((entry) => entry.endsWith('.md'))) {
    try {
      const parsed = matter(readFileSync(path.join(WORKFLOWS_DIR, file), 'utf-8'));
      workflows.push({
        file,
        data: {
          name: String(parsed.data.name ?? path.basename(file, '.md')),
          description: String(parsed.data.description ?? ''),
          enabled: parsed.data.enabled !== false,
          trigger: typeof parsed.data.trigger === 'object' && parsed.data.trigger ? parsed.data.trigger as WorkflowFile['trigger'] : { manual: true },
          steps: Array.isArray(parsed.data.steps) ? parsed.data.steps as WorkflowStepInput[] : [],
          inputs: typeof parsed.data.inputs === 'object' && parsed.data.inputs ? parsed.data.inputs as WorkflowFile['inputs'] : undefined,
          synthesis: typeof parsed.data.synthesis === 'object' && parsed.data.synthesis ? parsed.data.synthesis as WorkflowFile['synthesis'] : undefined,
        },
      });
    } catch {
      continue;
    }
  }
  return workflows;
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
          .map(({ file, data }) => {
            const trigger = data.trigger.schedule ? `schedule: ${data.trigger.schedule}` : 'manual';
            return `**${data.name}** [${data.enabled ? 'enabled' : 'disabled'}]\n  File: ${file}\n  ${data.description || '(no description)'}\n  Trigger: ${trigger}\n  Steps (${data.steps.length}): ${data.steps.map((step) => step.id).join(' -> ')}`;
          })
          .join('\n\n'),
      );
    },
  );

  server.tool(
    'workflow_create',
    'Create a multi-step workflow definition in vault/00-System/workflows.',
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

      ensureDir(WORKFLOWS_DIR);
      const fileName = `${name.replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase()}.md`;
      const filePath = path.join(WORKFLOWS_DIR, fileName);
      if (existsSync(filePath)) return textResult(`Workflow file already exists: ${fileName}`);

      const frontmatter: Record<string, unknown> = {
        type: 'workflow',
        name,
        description,
        enabled: true,
        trigger: trigger_schedule ? { schedule: trigger_schedule, manual: true } : { manual: true },
        steps,
      };
      if (inputs && Object.keys(inputs).length > 0) frontmatter.inputs = inputs;
      if (synthesis_prompt) frontmatter.synthesis = { prompt: synthesis_prompt };

      writeFileSync(filePath, matter.stringify(`# ${name}\n\n${description}\n`, frontmatter), 'utf-8');
      return textResult(`Created workflow "${name}" at ${fileName}.`);
    },
  );

  server.tool(
    'workflow_run',
    'Queue a workflow run by writing a run request to local workflow state.',
    {
      name: z.string().min(1),
      inputs: z.record(z.string(), z.string()).optional(),
    },
    async ({ name, inputs }) => {
      const workflow = listWorkflowFiles().find((entry) => entry.data.name === name);
      if (!workflow) return textResult(`Workflow "${name}" not found.`);
      if (!workflow.data.enabled) return textResult(`Workflow "${name}" is disabled.`);

      ensureDir(WORKFLOW_RUNS_DIR);
      const id = `${Date.now()}-${randomBytes(3).toString('hex')}`;
      const filePath = path.join(WORKFLOW_RUNS_DIR, `${id}.json`);
      writeFileSync(
        filePath,
        JSON.stringify({
          id,
          workflow: name,
          inputs: inputs ?? {},
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
        return `  ${step.id}${deps}${model}\n    ${step.prompt.slice(0, 600).replace(/\n+/g, ' ')}`;
      }).join('\n');
      const inputsBlock = w.inputs && Object.keys(w.inputs).length > 0
        ? Object.entries(w.inputs).map(([k, meta]) => `  - ${k}: ${meta.type ?? 'string'}${meta.default !== undefined ? ` (default: ${meta.default})` : ''}${meta.description ? ` — ${meta.description}` : ''}`).join('\n')
        : '  (none)';
      const trigger = w.trigger.schedule ? `schedule: ${w.trigger.schedule}` : (w.trigger.manual ? 'manual only' : 'manual');
      return textResult([
        `**${w.name}** [${w.enabled ? 'enabled' : 'disabled'}]`,
        `File: ${entry.file}`,
        `${w.description || '(no description)'}`,
        `Trigger: ${trigger}`,
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
      const filePath = path.join(WORKFLOWS_DIR, entry.file);
      const raw = readFileSync(filePath, 'utf-8');
      const parsed = matter(raw);
      const nextFrontmatter = { ...parsed.data, enabled };
      writeFileSync(filePath, matter.stringify(parsed.content, nextFrontmatter), 'utf-8');
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

      const filePath = path.join(WORKFLOWS_DIR, entry.file);
      const raw = readFileSync(filePath, 'utf-8');
      const parsed = matter(raw);
      const next: Record<string, unknown> = { ...parsed.data };
      if (description !== undefined) next.description = description;
      if (steps) next.steps = steps;
      if (inputs) next.inputs = inputs;
      if (synthesis_prompt !== undefined) next.synthesis = { prompt: synthesis_prompt };

      const currentTrigger = (typeof next.trigger === 'object' && next.trigger ? next.trigger : { manual: true }) as Record<string, unknown>;
      if (clear_trigger_schedule) {
        delete currentTrigger.schedule;
        next.trigger = { ...currentTrigger, manual: true };
      } else if (trigger_schedule !== undefined) {
        next.trigger = { ...currentTrigger, schedule: trigger_schedule, manual: currentTrigger.manual ?? true };
      }

      writeFileSync(filePath, matter.stringify(parsed.content, next), 'utf-8');
      return textResult(`Workflow "${name}" updated.`);
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
      unlinkSync(path.join(WORKFLOWS_DIR, entry.file));
      return textResult(`Workflow "${name}" deleted (${entry.file}).`);
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
