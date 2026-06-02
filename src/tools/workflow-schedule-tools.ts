import { existsSync, readFileSync } from 'node:fs';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import matter from 'gray-matter';
import { z } from 'zod';
import { listWorkflows, writeWorkflow, readWorkflow } from '../memory/workflow-store.js';
import type { WorkflowDefinition } from '../memory/workflow-store.js';
import { CRON_FILE } from '../memory/vault.js';
import { textResult } from './shared.js';
import { loadUserProfile } from '../runtime/user-profile.js';

/**
 * Schedule authoring tools — the agent's primary surface for "schedule
 * X for Y time."
 *
 * Conceptual model (per the user 2026-05-18):
 *   - Workflows = the "what" — reusable named units of work
 *   - Schedules = the "when" — cron expressions attached via trigger.schedule
 *
 * The agent always writes a workflow (one step, with either a prompt
 * or a direct tool-call) and lets `trigger.schedule` do the timing.
 * The daemon's processWorkflowSchedules() polls every minute, matches
 * the schedule, and enqueues a run. The existing cron.md path keeps
 * working for backward compat — these tools just give the agent a
 * cleaner authoring surface.
 *
 * Why no migration of existing CRON.md jobs:
 *   - Cron entries are user-authored and visible in the dashboard.
 *     Auto-converting them would change semantics the user trusts.
 *   - This batch focuses on giving the agent the cleaner primitive,
 *     not on collapsing two stores into one.
 */

const SLUG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

function isValidSlug(name: string): boolean {
  if (!name || name.length > 80) return false;
  return SLUG_RE.test(name);
}

function isValidCron(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  return parts.every((p) => /^(\*|\*\/\d+|\d+|\d+-\d+)(,(\*\/\d+|\d+|\d+-\d+))*$/.test(p));
}

function buildToolCallPrompt(slug: string, args: string): string {
  // Authoring style #1: direct tool invocation. The single workflow
  // step instructs the agent to call exactly one Composio tool with
  // the captured args — no reasoning, just execute.
  return [
    'Execute the following Composio tool with EXACTLY the arguments below. Do not modify the args, do not ask the user, do not call any other tools.',
    '',
    `Tool slug: \`${slug}\``,
    'Arguments (JSON):',
    '```json',
    args,
    '```',
    '',
    'Call `composio_execute_tool` with this slug and these arguments. Report the result in one sentence.',
  ].join('\n');
}

const scheduleParams = {
  name: z
    .string()
    .min(2)
    .max(80)
    .describe('Workflow slug (kebab-case, e.g. "instagram-friday-post", "daily-briefing"). Becomes the directory name on disk. Reuse an existing slug to UPDATE that workflow in place.'),
  description: z
    .string()
    .min(8)
    .max(240)
    .describe('One-sentence description of what this scheduled workflow does. Surfaced in dashboards and the agent\'s schedule_list output.'),
  cron: z
    .string()
    .min(9)
    .max(60)
    .describe('5-field cron expression in local time. Examples: "0 9 * * 1-5" = weekdays at 9am, "0 14 * * FRI" → use "0 14 * * 5" (numeric), "*/30 * * * *" = every 30 min. Use 0-59 0-23 1-31 1-12 0-6.'),
  instructions: z
    .string()
    .max(4000)
    .nullable()
    .describe('LLM prompt for the workflow\'s single step. Use this for tasks that need reasoning ("Write a brief on today\'s industry news and post it…"). Mutually exclusive with `toolCall` — set one or the other.'),
  toolCall: z
    .object({
      slug: z.string().min(2).describe('Composio tool slug discovered via composio_search_tools, e.g. INSTAGRAM_CREATE_POST.'),
      args: z.string().min(2).describe('JSON string of arguments to pass to the tool. Must parse as a JSON object.'),
    })
    .nullable()
    .describe('Direct tool invocation. Use this when the work is "call X with these exact args" (e.g. "post this Instagram caption with this image_url"). Mutually exclusive with `instructions`.'),
  enabled: z
    .boolean()
    .nullable()
    .describe('Whether the schedule should fire. Default true. Pass false to author the workflow but keep it dormant until the user explicitly enables it.'),
  timezone: z
    .string()
    .nullable()
    .describe('IANA timezone the cron is interpreted in (e.g. "America/Los_Angeles"). Omit to use the user\'s profile timezone; "8am" then means THEIR 8am, not the server host\'s. Only falls back to host-local time if neither is set.'),
};

export function registerWorkflowScheduleTools(server: McpServer): void {
  server.tool(
    'workflow_schedule',
    [
      'Schedule a workflow to fire on a cron expression. Use this whenever the user asks to "schedule X for Y time" / "post this Friday at 2pm" / "every weekday morning, do Z".',
      'Authors (or updates) a workflow at ~/.clementine-next/vault/00-System/workflows/<name>/SKILL.md with trigger.schedule set. The daemon polls every minute and fires matching workflows automatically.',
      'Two authoring styles — set exactly one of `instructions` or `toolCall`:',
      '  - `instructions`: LLM prompt for the step. Best for "compose and send" / "analyze and report" tasks.',
      '  - `toolCall`: direct {slug, args} invocation. Best for "post this exact content" / known Composio action.',
      'Returns the saved workflow path and the next scheduled run time. Idempotent — passing an existing `name` UPDATES that workflow.',
    ].join('\n'),
    scheduleParams,
    async ({ name, description, cron, instructions, toolCall, enabled, timezone }) => {
      if (!isValidSlug(name)) {
        return textResult(`Error: workflow name "${name}" is not a valid slug. Use lowercase kebab-case: "instagram-friday-post", "daily-briefing".`);
      }
      if (!isValidCron(cron)) {
        return textResult(`Error: "${cron}" is not a valid 5-field cron expression. Use minute hour day-of-month month day-of-week (numeric, 0-based for day-of-week).`);
      }
      if ((!instructions || !instructions.trim()) && !toolCall) {
        return textResult('Error: pass either `instructions` (LLM prompt) or `toolCall` ({slug, args}). One must be set.');
      }
      if (instructions && instructions.trim() && toolCall) {
        return textResult('Error: pass either `instructions` OR `toolCall`, not both. Pick the style that fits the task.');
      }
      let stepPrompt: string;
      let allowedTools: string[] = [];
      if (toolCall) {
        try {
          JSON.parse(toolCall.args);
        } catch {
          return textResult(`Error: toolCall.args must be valid JSON. Got: ${toolCall.args.slice(0, 120)}`);
        }
        stepPrompt = buildToolCallPrompt(toolCall.slug, toolCall.args);
        allowedTools = ['composio_execute_tool'];
      } else {
        stepPrompt = (instructions ?? '').trim();
      }

      // Resolve the timezone "8am" should mean: explicit arg → user profile →
      // (omit, so the scheduler falls back to host-local, byte-identical legacy).
      let resolvedTz: string | undefined = (timezone ?? '').trim() || undefined;
      if (!resolvedTz) {
        try { resolvedTz = loadUserProfile().timezone?.trim() || undefined; } catch { /* profile optional */ }
      }
      const existing = readWorkflow(name);
      const def: WorkflowDefinition = {
        name,
        description,
        enabled: enabled !== false,
        trigger: { schedule: cron, ...(resolvedTz ? { timezone: resolvedTz } : {}) },
        allowedTools,
        steps: [
          {
            id: 'main',
            prompt: stepPrompt,
          },
        ],
        // Preserve user-edited free-form body when updating an existing workflow.
        description_body: existing?.data.description_body,
      };

      const written = writeWorkflow(name, def);
      const next = nextFireDescription(cron);
      const verb = existing ? 'Updated' : 'Created';
      return textResult(
        `${verb} workflow "${name}" with cron "${cron}". ${def.enabled ? `Will fire ${next}.` : 'Currently DISABLED — pass enabled=true to activate.'}\nFile: ${written.filePath}`,
      );
    },
  );

  server.tool(
    'workflow_unschedule',
    [
      'Disable a scheduled workflow so it stops firing, without deleting it.',
      'The workflow definition stays on disk so you can re-enable it later by calling workflow_schedule with the same name. Use this for "pause the daily briefing" / "stop the Friday post for now."',
      'To permanently remove a workflow, use the workflow management tools (delete_workflow) instead.',
    ].join('\n'),
    {
      name: z.string().min(2).max(80).describe('The workflow slug to disable.'),
    },
    async ({ name }) => {
      if (!isValidSlug(name)) {
        return textResult(`Error: invalid workflow name "${name}".`);
      }
      const entry = readWorkflow(name);
      if (!entry) {
        return textResult(`No workflow named "${name}" found.`);
      }
      if (!entry.data.enabled) {
        return textResult(`Workflow "${name}" is already disabled.`);
      }
      const updated: WorkflowDefinition = { ...entry.data, enabled: false };
      writeWorkflow(name, updated);
      return textResult(`Workflow "${name}" disabled. The definition remains on disk — re-enable any time via workflow_schedule with the same name.`);
    },
  );

  server.tool(
    'schedule_list',
    [
      'List every active schedule in one place — scheduled workflows AND legacy cron jobs.',
      'Use this when the user asks "what\'s scheduled?" or before authoring a new schedule (to avoid duplicates / conflicts).',
      'Returns one line per schedule: source · name · cron · description. Workflows are the canonical authoring path; cron entries are legacy but still fire.',
    ].join('\n'),
    {},
    async () => {
      const lines: string[] = [];

      // Scheduled workflows
      let scheduledWorkflows = 0;
      try {
        for (const entry of listWorkflows()) {
          const cron = entry.data.trigger?.schedule;
          if (!cron) continue;
          scheduledWorkflows += 1;
          const state = entry.data.enabled ? 'active' : 'DISABLED';
          lines.push(`- workflow · ${entry.data.name} · "${cron}" · ${state} · ${entry.data.description}`);
        }
      } catch {
        // ignore — list still shows cron section
      }

      // Legacy cron jobs from CRON.md
      let cronJobs = 0;
      if (existsSync(CRON_FILE)) {
        try {
          const parsed = matter(readFileSync(CRON_FILE, 'utf-8'));
          const jobs = Array.isArray(parsed.data.jobs) ? parsed.data.jobs as Array<Record<string, unknown>> : [];
          for (const job of jobs) {
            const name = typeof job.name === 'string' ? job.name : '(unnamed)';
            const cron = typeof job.schedule === 'string' ? job.schedule : '(no schedule)';
            const enabled = job.enabled !== false;
            const promptPreview = typeof job.prompt === 'string' ? job.prompt.slice(0, 80) : '';
            cronJobs += 1;
            lines.push(`- cron · ${name} · "${cron}" · ${enabled ? 'active' : 'DISABLED'} · ${promptPreview}`);
          }
        } catch {
          // ignore
        }
      }

      if (lines.length === 0) {
        return textResult('No schedules active. Use workflow_schedule to create one.');
      }

      const header = `${scheduledWorkflows} scheduled workflow${scheduledWorkflows === 1 ? '' : 's'} + ${cronJobs} legacy cron job${cronJobs === 1 ? '' : 's'}:`;
      return textResult(`${header}\n${lines.join('\n')}`);
    },
  );
}

/**
 * Crude "next fire" hint for the success message. We don't run a real
 * cron parser here — just describe the schedule in plain English when
 * obvious, otherwise fall back to "per the cron expression."
 */
function nextFireDescription(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return 'per the cron expression';
  const [min, hour, dom, mon, dow] = parts;
  const everything = (s: string): boolean => s === '*';
  if (everything(dom) && everything(mon) && dow === '1-5' && /^\d+$/.test(min) && /^\d+$/.test(hour)) {
    return `weekdays at ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
  }
  if (everything(dom) && everything(mon) && everything(dow) && /^\d+$/.test(min) && /^\d+$/.test(hour)) {
    return `every day at ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
  }
  return 'per the cron expression';
}

