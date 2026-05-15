import { Agent } from '@openai/agents';
import type { Tool } from '@openai/agents';
import { z } from 'zod';
import { MODELS } from '../config.js';
import { getCoreTools } from '../tools/registry.js';
import type { RuntimeContextValue } from '../types.js';

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
const PLANNER_TOOL_NAMES = new Set<string>([
  'memory_search',
  'memory_recall',
  'memory_read',
  'memory_list_facts',
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
  'discover_work',
  // Pre-flight capability detection so the planner can verify a CLI
  // exists before writing steps that depend on it.
  'check_capability',
  'list_capabilities',
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
      verification: z.string().optional().describe('How we will know this step actually worked.'),
    }),
  ).min(1).max(20).describe('Ordered steps. Group small tasks; do not pad.'),
  successCriteria: z.array(z.string()).min(1).max(6).describe(
    'How we will know the whole objective is complete. Should be checkable, not aspirational.',
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
      'PRE-FLIGHT capability check: if your plan will use any external CLI (sf, gh, gcloud, aws, kubectl, stripe, vercel, fly, supabase, doctl, heroku, sfdx, docker, etc.), call `check_capability` for that CLI BEFORE writing steps that depend on it. If the capability is missing, do ONE of the following:\n  (a) Populate `needsUserInput` with a question like "I don\'t see the Salesforce CLI installed — want me to install it via npm install -g @salesforce/cli, or do you have it at a non-standard path?" and either skip those steps or make them conditional on the answer.\n  (b) If the install is low-friction and the user clearly wants it, include the install command as the first step (e.g. "brew install gh") and add the dependent steps after.\nDo NOT write steps that assume a missing CLI will magically work. The user should never approve a plan that\'s doomed at step 1.',
      'Steps must be concrete. Bad: "set up the integration." Good: "Read src/integrations/composio/client.ts to confirm the current auth path, then add a `refreshToken` handler that calls /oauth/refresh on 401."',
      'Group trivial steps. Don\'t list "open the file" as a step. The reader is another LLM — they know.',
      'Each step needs a rationale: why this step, in this order, right now. If you can\'t state the rationale, the step is filler — drop it.',
      'Success criteria must be checkable from outside the agent — tests pass, a file contains X, a command exits 0. Not "the user is happy."',
      'If the request is underspecified, populate `needsUserInput` with the SHORTEST questions that resolve the ambiguity. The orchestrator may ask them.',
      'Set `recommendsTrackedExecution: true` when the work is multi-system, spans multiple sessions, or has irreversible steps. The orchestrator decides whether to honor this.',
      'Be honest about risk. "Irreversible delete" is a real risk to call out. "Could break stuff" is not — get specific.',
      'Return one plan. The orchestrator decides what happens next.',
    ].join('\n\n'),
    model: MODELS.fast,
    outputType: PlanSchema,
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
      'Returns a JSON plan with objective, steps, successCriteria, risks, estimatedComplexity, recommendsTrackedExecution, and needsUserInput.',
      'After receiving the plan, decide: (a) execute it yourself or hand off to Executor, (b) ask the user the needsUserInput questions first, (c) refine by calling draft_plan again with more context, or (d) tell the user the plan and let them approve.',
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
