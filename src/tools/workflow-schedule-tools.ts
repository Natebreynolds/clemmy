import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { readWorkflow } from '../memory/workflow-store.js';
import type { WorkflowDefinition } from '../memory/workflow-store.js';
import { textResult } from './shared.js';
import { loadUserProfile } from '../runtime/user-profile.js';
import { describeCron } from '../execution/workflow-describe.js';
import { validateCronExpression } from '../shared/cron.js';
import { renderWorkflowGapQuestions } from '../execution/workflow-gap-test.js';
import {
  buildWorkflowTrigger,
  prepareWorkflowCreateForWrite,
  writeWorkflowAndSyncTriggers,
} from '../execution/workflow-authoring.js';
import {
  buildWorkflowExecutionPlanWithReadiness,
  renderWorkflowVisualContract,
} from '../execution/workflow-run-readiness.js';

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
    .describe('One-sentence description of what this scheduled workflow does. Surfaced in dashboards and schedule listings.'),
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
  allowSends: z
    .boolean()
    .nullable()
    .describe('Allow autonomous sends/publishes without approval gates. Defaults to true (autonomous). Set false for strict mode: any send/publish-looking step must carry requiresApproval=true or the save is refused.'),
  requiresApproval: z
    .boolean()
    .nullable()
    .describe('Set true to pause this scheduled step for user approval before it executes. Recommended for first-run social/legal/regulated publishes unless the user explicitly wants auto-publishing.'),
  approvalPreview: z
    .string()
    .max(240)
    .nullable()
    .describe('Short preview shown on the approval card when requiresApproval=true, e.g. "Review the Instagram caption and image before posting."'),
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
    async ({ name, description, cron, instructions, toolCall, allowSends, requiresApproval, approvalPreview, enabled, timezone }) => {
      if (!isValidSlug(name)) {
        return textResult(`Error: workflow name "${name}" is not a valid slug. Use lowercase kebab-case: "instagram-friday-post", "daily-briefing".`);
      }
      if (!validateCronExpression(cron)) {
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
      // P1-8: workflow_schedule authors a SINGLE-step workflow + sets the WHEN.
      // On an existing MULTI-step pipeline it used to rebuild steps:[{id:'main'}]
      // and silently DISCARD the rest. Refuse that — redirect to workflow_update,
      // which sets trigger_schedule without touching steps.
      const prevSteps = existing?.data.steps ?? [];
      if (existing && prevSteps.length > 1) {
        return textResult(
          `Workflow "${name}" already has ${prevSteps.length} steps — workflow_schedule would rebuild it as a single step and discard the rest. `
            + `To set ONLY its schedule, use workflow_update("${name}", trigger_schedule: "${cron}"). To redefine what it does, edit it with workflow_update.`,
        );
      }
      const priorStep = prevSteps[0];
      const stepRequiresApproval = requiresApproval ?? priorStep?.requiresApproval;
      const stepApprovalPreview = approvalPreview ?? priorStep?.approvalPreview;
      const resolvedAllowSends = allowSends ?? existing?.data.allowSends;
      const triggerResult = buildWorkflowTrigger({ schedule: cron, timezone: resolvedTz });
      if (!triggerResult.ok) return textResult(`Error: ${triggerResult.error}`);
      const def: WorkflowDefinition = {
        name,
        description,
        enabled: enabled !== false,
        trigger: triggerResult.trigger,
        allowedTools,
        ...(resolvedAllowSends !== undefined ? { allowSends: resolvedAllowSends } : {}),
        steps: [
          {
            // Preserve the single step's id + output contract on a reschedule;
            // only the prompt is (re)set from the caller's instructions/toolCall.
            id: priorStep?.id ?? 'main',
            prompt: stepPrompt,
            ...(priorStep?.output ? { output: priorStep.output } : {}),
            ...(stepRequiresApproval
              ? { requiresApproval: true, approvalPreview: stepApprovalPreview || 'Review this scheduled action before it runs.' }
              : {}),
          },
        ],
        // Preserve user-edited free-form body + declared inputs on an existing
        // single-step workflow (don't drop them on a reschedule).
        description_body: existing?.data.description_body,
        ...(existing?.data.inputs ? { inputs: existing.data.inputs } : {}),
      };

      // Same author-time guards as workflow_create — this is a first-class
      // authoring surface, so it must not be a back door that ships a workflow
      // set up to fail (ungated send, undeclared input, broken dataflow). An
      // ENABLED workflow that fails validation is refused; disable to draft.
      const writeCheck = prepareWorkflowCreateForWrite(def);
      if (writeCheck.status === 'invalid') {
        return textResult(
          `Workflow "${name}" was NOT scheduled — fix these first (or pass enabled=false to draft it):\n- ${writeCheck.errors.join('\n- ')}`,
        );
      }

      const written = writeWorkflowAndSyncTriggers(name, writeCheck.def);
      const next = nextFireDescription(cron);
      const verb = existing ? 'Updated' : 'Created';
      const gapQuestions = renderWorkflowGapQuestions(writeCheck.gaps);
      const visualContract = renderWorkflowVisualContract(
        buildWorkflowExecutionPlanWithReadiness(writeCheck.def, name),
      );
      const advisories = (writeCheck.repairs.length > 0 || writeCheck.warnings.length > 0)
        ? `\n\nHeads up (advisory — the workflow was saved):\n- ${[...writeCheck.repairs, ...writeCheck.warnings].join('\n- ')}`
        : '';
      return textResult(
        `${verb} workflow "${name}" with cron "${cron}". ${writeCheck.def.enabled ? `Will fire ${next}.` : 'Currently DISABLED — resolve readiness/validation issues, then enable it.'}\nFile: ${written.filePath}`
          + `${visualContract ? `\n\n${visualContract}` : ''}${advisories}${gapQuestions}`,
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
      writeWorkflowAndSyncTriggers(name, updated);
      return textResult(`Workflow "${name}" disabled. The definition remains on disk — re-enable any time via workflow_schedule with the same name.`);
    },
  );
}

/**
 * "Next fire" hint for the success message. Delegates to the canonical
 * cron humanizer (workflow-describe.ts:describeCron), which covers more
 * patterns (weekday/daily/weekly/day-of-month/interval) and falls back to
 * the raw expression when it can't phrase one.
 */
function nextFireDescription(cron: string): string {
  return describeCron(cron);
}
