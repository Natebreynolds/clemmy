import { Agent } from '@openai/agents';
import type { Tool } from '@openai/agents';
import { z } from 'zod';
import { MODELS } from '../config.js';
import { getCoreTools } from '../tools/registry.js';
import type { RuntimeContextValue } from '../types.js';
import { normalizeZodForCodexStrict } from '../runtime/schema-normalizer.js';

/**
 * Planner sub-agent — the deliberate planning step the orchestrator
 * can invoke BEFORE executing complex work.
 *
 * Why this is a TOOL, not a handoff:
 *   Handoffs transfer control. The Planner doesn't need control —
 *   it just needs to think for a moment and return a plan. The
 *   orchestrator should stay in the driver's seat: get the plan back,
 *   decide what to do next (execute it, ask the user to approve,
 *   refine, abandon). That's the Claude Code "Plan agent" pattern and
 *   the SDK-native shape for it is `Agent.asTool()`.
 *
 * What the orchestrator gets back:
 *   A structured Plan — objective, steps, success criteria, risks.
 *   Inspectable. The plan is the deliverable; whether to act on it
 *   is a separate decision.
 *
 * Tool surface:
 *   Same as Researcher — read-only. The planner gathers what it
 *   needs to plan, then plans. It does not mutate. If the plan
 *   needs more info to be useful, planner says so in the plan itself.
 */

// Read-only tools the Planner can use to gather context before
// producing a plan. Same shape as Researcher's allowlist — if you can
// research it, you can plan against it.
//
// READ-ONLY IS LOAD-BEARING — do NOT "ungate" this into the full surface.
// The orchestrator NEVER executes the planner's tool calls; it consumes the
// planner's PlanSchema JSON, surfaces it for approval, then runs its OWN tool
// calls wrapped in execution_create (the approval + audit boundary). If the
// planner could mutate, external writes would bypass that boundary entirely.
// This is the ONE allowlist that is a real invariant, not over-indexed gating
// (workers were ungated to the full native surface 2026-06-01; the planner
// deliberately was not — planning never gets "dispatched to use a tool").
const PLANNER_TOOL_NAMES = new Set<string>([
  'memory_search',
  'memory_recall',
  'memory_read',
  'memory_list_facts',
  'memory_search_facts',
  'memory_review_instructions',
  'workspace_roots',
  'workspace_list',
  'workspace_info',
  'list_files',
  'read_file',
  'git_status',
  'session_history',
  'goal_list',
  'goal_get',
  'task_list',
  'list_plans',
  'agent_runs_recent',
  'agent_run_get',
  'background_tasks_recent',
  'background_task_status',
  'discover_work',
  // Pre-flight capability detection so the planner can verify a CLI
  // exists before writing steps that depend on it.
  'check_capability',
  'list_capabilities',
  // Lossless read-back for the planner's own clipped/digested reads.
  // `read_file` / `session_history` can return payloads big enough to be
  // clipped by the tool-output digest; the footer then names these two
  // readers. Same class as the worker gap — keep them reachable so the
  // planner never plans against half-read context. Read-only, budget-
  // capped (3 calls / 60KB per turn).
  'recall_tool_result',
  'tool_output_query',
]);

function filterToolsByNames<T extends { name?: string }>(tools: T[], allow: Set<string>): T[] {
  return tools.filter((t) => Boolean(t.name) && allow.has(t.name as string));
}

export const PlanSchema = z.object({
  objective: z.string()
    .min(8)
    .describe('Crisp one-sentence statement of what success looks like for this work.'),
  steps: z.array(
    z.object({
      n: z.number().int().min(1),
      action: z.string().min(4).describe('Concrete action — what gets done in this step.'),
      rationale: z.string().min(4).describe('Why this step is necessary right now.'),
      verification: z.string().nullable().describe('How we will know this step actually worked. Use null if no verification check is meaningful for this step.'),
    }),
  ).min(1).max(20).describe('Ordered steps. Group small tasks; do not pad.'),
  successCriteria: z.array(z.string()).min(1).max(6).describe(
    'How we will know the whole objective is complete. Should be checkable, not aspirational.',
  ),
  stages: z.array(
    z.object({
      title: z.string().min(3).describe('Short milestone name, e.g. "Pull the accounts".'),
      criteria: z.array(z.string()).min(1).describe(
        'The subset of successCriteria above (VERBATIM text) this milestone satisfies.',
      ),
    }),
  ).max(6).nullable().describe(
    'OPTIONAL ordered milestones for a LONG, multi-session goal: partition the successCriteria above into 2–4 stages so the work validates and checks in one milestone at a time instead of all-or-nothing at the end. Every criterion should appear in exactly one stage, quoted verbatim. Use null for short goals that finish in a single pass.',
  ),
  risks: z.array(z.string()).max(6).describe(
    'Real risks worth flagging: unknown inputs, irreversible steps, external dependencies.',
  ),
  estimatedComplexity: z.enum(['trivial', 'moderate', 'significant', 'large']).describe(
    'How big is this? trivial=single tool call; moderate=a handful of steps; significant=multi-system; large=spans days or sessions.',
  ),
  recommendsTrackedExecution: z.boolean().describe(
    'Whether this plan is big enough that it should be promoted into a tracked execution rather than handled inline.',
  ),
  needsUserInput: z.array(z.string()).max(5).describe(
    'Questions the orchestrator should ask the user before executing. Empty if the plan is fully specified.',
  ),
  appliedInstructions: z.array(z.string()).max(8).describe(
    'Standing instructions / durable preferences from memory that THIS plan is consciously following, each as a short line (quote the instruction, add a "(source: …)" hint when known). Populate by recalling memory scoped to the objective BEFORE planning. Empty array only if a genuine memory check surfaced nothing relevant — never skip the check for mutating or batch work.',
  ),
  externalSends: z.array(
    z.object({
      slug: z.string().min(2).describe(
        'The EXACT send tool name or Composio slug that will execute this send, e.g. "OUTLOOK_SEND_EMAIL" or "GMAIL_SEND_EMAIL". This string is what gets auto-approved within the goal scope, so it must match what you will actually call.',
      ),
      summary: z.string().min(3).describe(
        'Plain-language description of what/who this send targets, for the user to see and bless — e.g. "personalized outreach to the 8 market-leader firms".',
      ),
      count: z.number().int().min(1).nullable().describe('How many sends of this shape (e.g. 8). Use null for a single send.'),
    }),
  ).max(10).nullable().describe(
    'The IRREVERSIBLE external sends (emails sent, posts/messages published) this plan will execute, enumerated by exact tool/slug + a human summary. Populate for ANY plan that sends or publishes externally. When the user approves the plan, sends matching these slugs auto-run within the goal scope while anything OFF this list still pauses for approval. Use null for read-only or local-only plans — never list a send you will not actually make.',
  ),
});

export type Plan = z.infer<typeof PlanSchema>;

export function buildPlannerAgent(): Agent<RuntimeContextValue, typeof PlanSchema> {
  const tools = filterToolsByNames(getCoreTools(), PLANNER_TOOL_NAMES) as Tool<RuntimeContextValue>[];
  return new Agent<RuntimeContextValue, typeof PlanSchema>({
    name: 'Planner',
    instructions: [
      'You are the Planner. Your job is to turn a user request into a clear, inspectable plan — nothing more.',
      'You DO NOT execute. You DO NOT mutate state. You produce a plan and return.',
      'Use read-only tools to gather context first when the request references existing work, files, goals, memory, or workspace state. Don\'t plan blind.',
      'MANDATORY memory check before mutating or batch work (sending messages, creating/updating records, filling sheets, posting): call `memory_recall` / `memory_list_facts` scoped to the objective FIRST, and list every standing instruction or durable preference the plan will follow in `appliedInstructions` (quote it, add a "(source: …)" hint when you can tell where it came from). This is how the user sees "here is what I am about to do, and the instructions I am following" before approving. If a recalled instruction looks IRRELEVANT or CONFLICTING with this objective (e.g. a home-services rule surfacing during legal work), do NOT silently apply it — add a `needsUserInput` line flagging it and asking whether to drop it. Only return an empty `appliedInstructions` when a real memory check surfaced nothing relevant.',
      'PRE-FLIGHT CLI check: if your plan will rely on a local CLI, call `local_cli_list` (or `local_cli_probe` for a specific binary) to confirm it is actually on $PATH BEFORE writing steps that depend on it. There is no curated allowlist — whatever the user has installed is fair game; whatever they do not have is not. If a needed CLI is missing, either populate `needsUserInput` with a short question (offer the canonical install command for that tool) or include the install as the first step when low-friction and clearly desired. Never write steps that assume a missing CLI will work.',
      'Steps must be concrete. Bad: "set up the integration." Good: "Read src/integrations/composio/client.ts to confirm the current auth path, then add a `refreshToken` handler that calls /oauth/refresh on 401."',
      'Group trivial steps. Don\'t list "open the file" as a step. The reader is another LLM — they know.',
      'Each step needs a rationale: why this step, in this order, right now. If you can\'t state the rationale, the step is filler — drop it.',
      'Success criteria must be checkable from outside the agent — tests pass, a file contains X, a command exits 0. Not "the user is happy."',
      'For a LONG goal that spans multiple sessions or has natural milestones, populate `stages`: group the success criteria into 2–4 ordered milestones (each criterion quoted verbatim in exactly one stage). This lets the work validate and check in one milestone at a time. Leave `stages` null for anything that finishes in a single pass — do not over-stage small work.',
      'If the request is underspecified, populate `needsUserInput` with the SHORTEST questions that resolve the ambiguity. The orchestrator may ask them.',
      'Set `recommendsTrackedExecution: true` when the work is multi-system, spans multiple sessions, or has irreversible steps. The orchestrator decides whether to honor this.',
      'ENUMERATE EXTERNAL SENDS: if the plan sends or publishes anything irreversible (emails, posts, DMs, messages), populate `externalSends` — one entry per distinct send SHAPE, with the exact tool/slug you will call (e.g. "OUTLOOK_SEND_EMAIL"), a plain-language summary of who/what it targets, and the count. This is the list the user blesses on approval: matching sends then run hands-off within the goal scope while anything off the list still pauses. List ONLY sends you will actually make; leave null for read-only or local-only plans.',
      'Be honest about risk. "Irreversible delete" is a real risk to call out. "Could break stuff" is not — get specific.',
      'Return one plan. The orchestrator decides what happens next.',
    ].join('\n\n'),
    model: MODELS.fast,
    // v0.5.22 — Codex-strict-compatible via centralized normalizer.
    outputType: normalizeZodForCodexStrict(PlanSchema) as typeof PlanSchema,
    tools,
  });
}

/**
 * Render the Planner as an SDK tool the orchestrator can call. Returns
 * the plan as JSON text so the orchestrator can reason over the fields
 * and decide its next move (execute, ask, refine, abandon).
 */
export function buildPlannerTool(): Tool<RuntimeContextValue> {
  const planner = buildPlannerAgent();
  return planner.asTool({
    toolName: 'draft_plan',
    toolDescription: [
      'Draft a structured plan for multi-step work before executing it.',
      'Use when the user\'s request is multi-step OR the path is not obvious from the message alone.',
      'Do NOT use for trivial single-tool actions or read-only lookups.',
      'The planner is read-only — calling it does not mutate anything.',
      'Returns a JSON plan with objective, steps, successCriteria, risks, estimatedComplexity, recommendsTrackedExecution, needsUserInput, appliedInstructions (the standing instructions from memory this plan follows — surfaced to the user for review), and externalSends (the irreversible sends the plan will make, enumerated for the user to bless on approval).',
      'After receiving the plan, decide: (a) execute it yourself, using share_plan first when the user should see a safe working plan, (b) ask the user the needsUserInput questions first, (c) refine by calling draft_plan again with more context, or (d) surface_plan when it needs review/approval.',
    ].join(' '),
    customOutputExtractor: async (output) => {
      // The planner agent's finalOutput is the parsed PlanSchema value.
      // Serialize so the orchestrator sees structured fields it can
      // reason over rather than free-form text.
      const final = output.finalOutput;
      if (final && typeof final === 'object') {
        return JSON.stringify(final, null, 2);
      }
      return typeof final === 'string' ? final : JSON.stringify(final ?? {});
    },
  }) as Tool<RuntimeContextValue>;
}
