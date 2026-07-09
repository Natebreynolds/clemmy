import { Agent, Runner, setDefaultOpenAIKey } from '@openai/agents';
import { z } from 'zod';
import pino from 'pino';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getOpenAiApiKey, getRuntimeEnv, MODELS } from '../config.js';
import { getCoreTools } from '../tools/registry.js';
import { getOrCreateConfiguredMcpServers } from '../runtime/mcp-servers.js';
import { autonomyV2OutputGuardrails } from './autonomy-guardrails.js';
import { extractJsonCandidate } from '../runtime/harness/json-repair.js';
import { getProactivityPolicySnapshot, type ProactivityPolicy, type ProactivityPolicySnapshot } from './proactivity-policy.js';
import { renderOpenCheckInsForAgent } from './check-ins.js';
import { getProposalFeedback, renderProposalFeedback } from './proposal-feedback.js';
import { buildPlannerTool } from './planner.js';
import { loadSkill } from '../memory/skill-store.js';
import {
  buildAgentCommsTools,
  commsInstructionBlock,
  deliverTeamCommsToInboxes,
  logCommsDelivery,
  peerCommsEnabled,
  resetCommsCycle,
} from './agent-comms.js';
import { activeExecutionCountForSession, renderActiveExecutionsForAgent } from '../tools/execution-tools.js';
import { renderProfileForInstructions } from '../runtime/user-profile.js';
import { defaultOrchestratorHandoffs, isOrchestratorSlug } from './sub-agents.js';
import type { RuntimeContextValue } from '../types.js';
import {
  AGENT_INBOX_DIR,
  AGENT_STATE_DIR,
  TASKS_FILE,
  ensureDir,
  ensureTasksFile,
  loadTeamAgents,
  parseTasks,
  type TeamAgentRecord,
} from '../tools/shared.js';
import { listGoalRecords, type GoalRecord } from '../memory/goals-list.js';
import { addRunEvent, finishRun } from '../runtime/run-events.js';
import {
  finishAutonomyRun,
  recordAutonomyDecision,
  recordAutonomyResponse,
  startAutonomyRun,
} from './run-tracking.js';

/**
 * SDK-native autonomy loop (Phase 1).
 *
 * This module is intentionally parallel to src/agents/autonomy.ts. The
 * v1 loop in that file is hand-rolled: builds a string prompt, JSON-
 * parses the response with three fallback strategies, and dispatches
 * through a hardcoded switch over 10 action types. It works, but it has
 * known failure modes (silent inbox loss on parse error, sequential
 * agent execution, no validation, no observability).
 *
 * Phase 1 replaces the LLM-facing core with proper SDK primitives:
 *
 *   - `Agent` from `@openai/agents` with `outputType` set to a Zod
 *     schema. The OpenAI structured outputs API enforces the shape on
 *     the server — JSON parse failures drop to ~zero.
 *   - Lifecycle hooks (`agent_start` / `agent_end` / `agent_tool_*`)
 *     wired straight into the run-events store. Every cycle is fully
 *     inspectable in the dashboard and via the new
 *     agent_runs_recent / agent_run_get MCP tools.
 *   - MCP tools (`getCoreTools()` + discovered servers) are the action
 *     surface. The agent can call any tool that's registered today;
 *     new actions = new tools, no code change in this file.
 *   - Per-agent execution wrapped in `Promise.allSettled` with a hard
 *     timeout so a single slow agent cannot stall the daemon tick.
 *
 * Phase 1 still produces a structured AgentDecision that we execute
 * via the existing executeAgentActions switch (imported from v1) — the
 * disk-file team-comms / delegation flow remains intact, this is a
 * pure upgrade of the LLM-facing core. Phase 2 will replace the
 * delegation action with native handoffs and migrate more actions to
 * tool calls.
 *
 *
 * REQUIREMENTS
 * ------------
 * - `OPENAI_API_KEY` must be set. Structured outputs are not available
 *   over the codex CLI bridge; codex_oauth users stay on v1 for now.
 * - Opt-in via env var `AUTONOMY_V2_AGENTS=clementine,researcher`
 *   (comma-separated slugs). Empty / unset → v2 is a no-op.
 *
 *
 * DAEMON INTEGRATION (recommended follow-up patch to runner.ts)
 * --------------------------------------------------------------
 *
 *   import { processAgentAutonomyV2 } from '../agents/autonomy-v2.js';
 *
 *   // ...inside startDaemon while-loop, alongside processAgentAutonomy:
 *   await processAgentAutonomyV2();
 *
 * The v1 loop also runs. Each agent appears in only one engine because
 * v2 owns the slugs listed in AUTONOMY_V2_AGENTS, and after a v2 cycle
 * marks `lastRunAt`, v1 will see the cadence as not-yet-due and skip.
 * For inbox-triggered wakes overlap is possible during the first tick
 * of opt-in — accept the duplicate processing on transition.
 */

const logger = pino({ name: 'clementine-next.agents.v2' });

// -------- Configuration --------

const ENGINE_OPT_IN_ENV = 'AUTONOMY_V2_AGENTS';
const PER_AGENT_TIMEOUT_MS = 60_000;
const MAX_INBOX_PER_CYCLE = 6;

function readOptInSlugs(): Set<string> {
  const raw = getRuntimeEnv(ENGINE_OPT_IN_ENV, '');
  return new Set(
    raw.split(',').map((slug) => slug.trim()).filter(Boolean),
  );
}

// -------- Decision schema --------
//
// Phase 2: actions are NO LONGER a structured array. The agent calls
// real tools during its run (notify_user, task_add, goal_update,
// memory_remember, etc.) and the SDK orchestrates those tool calls
// natively. The decision output is metadata only — what did you do,
// what are you on the hook for next time, when should you wake again.
//
// This collapses the v1 "return action JSON → switch executes it"
// pattern to the SDK's native "agent calls tools, runner orchestrates"
// pattern. The tool surface IS the action vocabulary; adding a new
// autonomy action = registering a new MCP tool.

export const AgentDecisionSchema = z.object({
  summary: z.string().describe('Brief explanation of what you did and why this cycle. Mention which tools you called.'),
  commitments: z.array(z.string()).max(8).describe('What you commit to follow up on next cycle. Concrete and dated when possible.'),
  followUpMinutes: z.number().int().min(5).max(1440).optional().describe('When to wake again, in minutes. Omit to use the agent default cadence.'),
});

export type AgentDecisionV2 = z.infer<typeof AgentDecisionSchema>;

function parseDecisionJson(value: unknown): unknown | null {
  if (value && typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  const candidate = extractJsonCandidate(value);
  if (!candidate) return null;
  try {
    return JSON.parse(candidate) as unknown;
  } catch {
    return null;
  }
}

function cleanDecisionString(value: unknown, max = 1200): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function cleanStringArray(value: unknown, max: number): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split(/\n|;/)
      : [];
  const out: string[] = [];
  for (const item of raw) {
    const s = cleanDecisionString(item, 500);
    if (s && !out.includes(s)) out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

export function sanitizeAgentDecisionOutput(value: unknown): AgentDecisionV2 | null {
  const parsed = parseDecisionJson(value);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    if (typeof value === 'string') {
      const summary = cleanDecisionString(value, 1200);
      if (summary) return { summary, commitments: [] };
    }
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  const rawFollowUp = obj.followUpMinutes ?? obj.follow_up_minutes ?? obj.nextWakeMinutes ?? obj.next_wake_minutes;
  const followUp = typeof rawFollowUp === 'number'
    ? Math.trunc(rawFollowUp)
    : typeof rawFollowUp === 'string'
      ? Number.parseInt(rawFollowUp, 10)
      : undefined;
  const candidate: AgentDecisionV2 = {
    summary: cleanDecisionString(obj.summary ?? obj.message ?? obj.result ?? obj.report, 1200),
    commitments: cleanStringArray(obj.commitments ?? obj.followUps ?? obj.follow_ups, 8),
    ...(Number.isFinite(followUp) ? { followUpMinutes: followUp } : {}),
  };
  const checked = AgentDecisionSchema.safeParse(candidate);
  return checked.success ? checked.data : null;
}

export function _testOnly_sanitizeAgentDecisionOutput(value: unknown): AgentDecisionV2 | null {
  return sanitizeAgentDecisionOutput(value);
}

// -------- Inbox + state --------
// We re-read v1's on-disk inbox / state directly so v2 stays compatible
// with the existing pipeline. Sync logic (syncAutonomyInputs) stays in
// v1; here we only read.

interface AgentInboxItem {
  id: string;
  type: string;
  createdAt: string;
  status: 'pending' | 'processed';
  fromAgent?: string;
  sourceKey?: string;
  content: string;
  metadata?: Record<string, unknown>;
  processedAt?: string;
}

interface AgentStateRecord {
  slug: string;
  lastRunAt?: string;
  lastWakeAt?: string;
  lastWakeReasons?: string[];
  lastSummary?: string;
  commitments?: string[];
  nextWakeAt?: string;
  lastError?: string;
  engine?: 'v1' | 'v2';
}

function inboxFilePath(slug: string): string {
  return path.join(AGENT_INBOX_DIR, `${slug}.json`);
}

function stateFilePath(slug: string): string {
  return path.join(AGENT_STATE_DIR, `${slug}.json`);
}

function loadInbox(slug: string): AgentInboxItem[] {
  const filePath = inboxFilePath(slug);
  if (!existsSync(filePath)) return [];
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveInbox(slug: string, items: AgentInboxItem[]): void {
  ensureDir(AGENT_INBOX_DIR);
  writeFileSync(inboxFilePath(slug), JSON.stringify(items, null, 2), 'utf-8');
}

function markInboxProcessed(slug: string, ids: string[]): void {
  if (ids.length === 0) return;
  const now = new Date().toISOString();
  const items = loadInbox(slug).map((item) =>
    ids.includes(item.id) ? { ...item, status: 'processed' as const, processedAt: now } : item,
  );
  saveInbox(slug, items);
}

function loadAgentState(slug: string): AgentStateRecord {
  const filePath = stateFilePath(slug);
  if (!existsSync(filePath)) return { slug };
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as AgentStateRecord;
  } catch {
    return { slug };
  }
}

function saveAgentState(state: AgentStateRecord): void {
  ensureDir(AGENT_STATE_DIR);
  writeFileSync(stateFilePath(state.slug), JSON.stringify(state, null, 2), 'utf-8');
}

function loadActiveGoals(): GoalRecord[] {
  return listGoalRecords()
    .filter((g) => g.status === 'active' || g.status === 'blocked')
    .sort((a, b) => {
      const pri = { high: 0, medium: 1, low: 2 };
      return (pri[a.priority] ?? 1) - (pri[b.priority] ?? 1);
    });
}

function isCadenceDue(agent: TeamAgentRecord, state: AgentStateRecord): boolean {
  if (!agent.proactive) return false;
  if (state.nextWakeAt && new Date(state.nextWakeAt).getTime() > Date.now()) return false;
  const cadence = Math.max(5, agent.cadenceMinutes ?? 30);
  if (!state.lastRunAt) return true;
  return Date.now() - new Date(state.lastRunAt).getTime() >= cadence * 60_000;
}

// -------- Prompt construction --------
// Just the context. The decision schema and action rules are NOT in the
// prompt anymore — outputType handles structure, the tool descriptions
// handle "what can I do". Big reduction in prompt tokens too.

function buildAgentInput(agent: TeamAgentRecord, inboxItems: AgentInboxItem[], state: AgentStateRecord, policyOverride?: ProactivityPolicy): string {
  ensureTasksFile();
  const tasks = parseTasks(readFileSync(TASKS_FILE, 'utf-8'))
    .filter((task) => task.status === 'pending')
    .filter((task) => !agent.project || !task.project || task.project.toLowerCase() === agent.project.toLowerCase())
    .slice(0, 12);

  const inboxText = inboxItems.length === 0
    ? 'none'
    : inboxItems.map((item, index) => `${index + 1}. [${item.type}] ${item.fromAgent ? `from=${item.fromAgent} ` : ''}${item.content}`).join('\n\n');

  const taskText = tasks.length === 0
    ? 'none'
    : tasks.map((task) => `- {${task.id}} ${task.description}${task.priority ? ` !!${task.priority}` : ''}${task.dueDate ? ` due ${task.dueDate}` : ''}`).join('\n');

  const goals = agent.slug === 'clementine' ? loadActiveGoals().slice(0, 6) : [];
  const goalsText = goals.length === 0
    ? ''
    : goals.map((g) => {
      const next = g.nextActions[0] ? ` | next: ${g.nextActions[0]}` : '';
      const blocker = g.blockers?.[0] ? ` | BLOCKED: ${g.blockers[0]}` : '';
      const due = g.targetDate ? ` | due ${g.targetDate}` : '';
      return `- [${g.id}] ${g.title} (${g.priority}${due}${next}${blocker})`;
    }).join('\n');

  const today = new Date().toISOString().slice(0, 10);
  const commitments = state.commitments && state.commitments.length > 0
    ? `Existing commitments:\n- ${state.commitments.join('\n- ')}`
    : 'Existing commitments: none';

  const policy = policyOverride ?? getProactivityPolicySnapshot().policy;
  const policyText = buildPolicyText(policy);
  const profileText = renderProfileForInstructions();
  const checkInsText = renderOpenCheckInsForAgent(agent.slug);
  const executionsText = renderActiveExecutionsForAgent(`agent:${agent.slug}`);

  return [
    `Context date: ${today}`,
    profileText ? `User preferences:\n${profileText}` : '',
    policyText,
    commitments,
    goalsText ? `Active goals (push these forward):\n${goalsText}` : '',
    executionsText,
    checkInsText,
    `Pending inbox items:\n${inboxText}`,
    `Relevant open tasks:\n${taskText}`,
  ].filter(Boolean).join('\n\n');
}

/**
 * Render the current proactivity policy as a short directive block the
 * agent can read. Three knobs matter most to a cycle:
 *
 *   mode — sets the bar for taking action. Watch = observe and surface
 *          only, balanced = act on clear signals, hands_on = drive
 *          things forward proactively.
 *
 *   allowed action categories — gates entire tool families. Don't try
 *          a Composio call if allowComposioActions=false; the call will
 *          fail and waste a turn.
 *
 *   checkInMinutes — informs a reasonable followUpMinutes default when
 *          the agent doesn't have a specific reason to wake sooner.
 */
export function buildPolicyText(policy: ProactivityPolicy): string {
  const modeGuidance: Record<ProactivityPolicy['mode'], string> = {
    watch:    'Watch mode: prefer noop and notify_user. Only take side-effecting actions when there is a clear, urgent reason.',
    balanced: 'Balanced mode: act on clear signals. Don\'t force action when nothing useful is queued.',
    hands_on: 'Hands-on mode: drive things forward. If a goal or task has stalled, take initiative this cycle.',
  };

  const allowedCategories: string[] = [];
  if (policy.allowComputerActions) allowedCategories.push('local computer tools (files, shell, git)');
  if (policy.allowComposioActions) allowedCategories.push('Composio external actions (Gmail, Slack, etc.)');
  if (policy.allowDiscordCheckIns) allowedCategories.push('Discord notifications');

  const blockedCategories: string[] = [];
  if (!policy.allowComputerActions) blockedCategories.push('computer actions');
  if (!policy.allowComposioActions) blockedCategories.push('Composio actions');
  if (!policy.allowDiscordCheckIns) blockedCategories.push('Discord notifications');

  const lines = [
    'Operating policy:',
    `- ${modeGuidance[policy.mode]}`,
    `- Default check-in cadence: ${policy.checkInMinutes} minute(s). Use this for followUpMinutes when you have no better reason.`,
  ];
  if (allowedCategories.length > 0) {
    lines.push(`- Allowed action categories: ${allowedCategories.join(', ')}.`);
  }
  if (blockedCategories.length > 0) {
    lines.push(`- Blocked: ${blockedCategories.join(', ')}. Do not attempt tools in these categories — they will fail.`);
  }
  lines.push(policy.requireWorkflowApprovalForExecution
    ? '- Execution gate: Executor/Deployer handoffs require an active tracked execution. If the work is not tracked yet, ask the user to promote/approve it as a long-running task.'
    : '- Execution gate: disabled. Executor/Deployer handoffs may run without a tracked execution.');
  return lines.join('\n');
}

/**
 * Build the run-event payload that records the active proactivity
 * policy at cycle start. Compact `data` field — the dashboard renders
 * the message inline and surfaces `data` on click. Replaying this
 * months later answers "what mode + permissions did the agent have?"
 */
export function buildPolicyEvent(snapshot: ProactivityPolicySnapshot): {
  type: 'status';
  message: string;
  data: Record<string, unknown>;
} {
  const policy = snapshot.policy;
  return {
    type: 'status',
    message: `Policy: ${policy.mode}, check-in ${policy.checkInMinutes}m${snapshot.quietHoursActive ? ', quiet hours active' : ''}.`,
    data: {
      mode: policy.mode,
      checkInMinutes: policy.checkInMinutes,
      allowComputerActions: policy.allowComputerActions,
      allowComposioActions: policy.allowComposioActions,
      allowDiscordCheckIns: policy.allowDiscordCheckIns,
      requireWorkflowApprovalForExecution: policy.requireWorkflowApprovalForExecution,
      quietHoursEnabled: policy.quietHoursEnabled,
      quietHoursActive: snapshot.quietHoursActive,
      proactiveWorkAllowed: snapshot.proactiveWorkAllowed,
    },
  };
}

/**
 * Decide the cycle's effective followUpMinutes. The agent's explicit
 * pick always wins. When the agent omitted one AND there are active
 * executions in flight, pick a tighter window than the user-configured
 * cadence so the work compounds toward completion. With nothing
 * active, return undefined → fall back to the agent's `cadenceMinutes`.
 */
export function chooseFollowUpMinutes(
  agentChoice: number | undefined,
  activeExecutionCount: number,
  policy: ProactivityPolicy,
): number | undefined {
  if (typeof agentChoice === 'number' && agentChoice >= 5) {
    return Math.max(5, agentChoice);
  }
  if (activeExecutionCount <= 0) return undefined;

  // With work in flight, lean on the user's checkInMinutes setting but
  // floor at 5 (the schema floor) and ceiling at 60 (don't hammer when
  // mode=watch even if there's open work).
  const base = Math.max(5, Math.min(60, policy.checkInMinutes ?? 5));
  if (policy.mode === 'hands_on') return base;
  if (policy.mode === 'balanced') return Math.max(base, base * 2);
  // watch: even with active work, don't churn
  return Math.max(base * 3, 15);
}

/**
 * Slice 4 — inject the SKILL.md body of every skill bound to this agent,
 * the same way a workflow step does for `usesSkill`. A specialist boots
 * knowing its craft instead of rediscovering it via skill_read each cycle.
 * Missing skills are noted (not silently dropped) so a stale binding is
 * visible. Returns '' when no skills are bound (no prompt growth).
 */
function renderBoundSkills(agent: TeamAgentRecord): string {
  const names = agent.skills ?? [];
  if (names.length === 0) return '';
  const blocks: string[] = [];
  for (const name of names) {
    const skill = loadSkill(name);
    if (skill) blocks.push(`### Skill: ${name}\n${skill.body.trim()}`);
    else blocks.push(`### Skill: ${name}\n(not installed — ask the user to install it or remove it from your skills.)`);
  }
  return ['Your skills (follow these as binding procedures when the task matches):', ...blocks].join('\n\n');
}

/** Slice 4 — list the workflows this agent owns so it reaches for them via
 *  `workflow_run` instead of redoing the work ad-hoc. Returns '' when none. */
function renderOwnedWorkflows(agent: TeamAgentRecord): string {
  const names = agent.workflows ?? [];
  if (names.length === 0) return '';
  return [
    'Workflows you own — prefer `workflow_run` with the exact name when the task matches one:',
    ...names.map((n) => `- ${n}`),
  ].join('\n');
}

function buildAgentInstructions(agent: TeamAgentRecord, policy: ProactivityPolicy): string {
  const orchestrator = isOrchestratorSlug(agent.slug);
  const proposalFeedbackBlock = renderProposalFeedback(getProposalFeedback({ windowDays: 30 }));
  return [
    `You are ${agent.name} (${agent.slug}), an autonomous agent inside Clementine.`,
    agent.role ? `Role: ${agent.role}` : '',
    agent.description ? `Mission: ${agent.description}` : '',
    agent.project ? `Bound project: ${agent.project}` : '',
    `Personality and operating guidance:\n${agent.personality}`,
    // Slice 4: bound skills + owned workflows. Data-driven — empty by
    // default, so agents without bindings are unchanged.
    renderBoundSkills(agent),
    renderOwnedWorkflows(agent),
    'You are proactive. If goals or tasks have stagnated, take initiative.',
    orchestrator ? [
      'You are the orchestrator. Specialized sub-agents are available via handoff:',
      '- Researcher: read-only information gatherer. Hand off when you need facts from memory, files, the workspace, or session history before deciding. It cannot mutate state.',
      '- Writer: drafts docs, reports, summaries, emails/messages, and handoff notes. It drafts but does not send or deploy.',
      '- Reviewer: read-only auditor. Hand off (a) before risky execution, deployment, or user-facing delivery, AND (b) after a multi-step mutation completes (multiple writes, command sequence, workflow that changed state) before declaring done. Reviewer reads what changed and confirms or flags. Skip the post-write Reviewer pass only for trivial single-file edits or read-only work.',
      '- Executor: does concrete work (tasks, executions, file writes, shell commands, notifications).',
      '- Deployer: handles release, deployment, CI, environment, and CLI-driven shipping work.',
      policy.requireWorkflowApprovalForExecution
        ? 'Workflow approval gate: Executor and Deployer handoffs are only available when an active tracked execution exists for this session. If no active execution is listed but the work needs execution, ask the user to promote/approve it as a long-running tracked task instead of silently handing off.'
        : 'Workflow approval gate is disabled by policy: Executor and Deployer handoffs may be used whenever the work is concrete and appropriate.',
      'When to hand off vs. act directly: simple single-step actions you can take yourself. Multi-step work, especially when it involves both information gathering AND mutation, benefits from a handoff so the sub-agent stays focused.',
      'When handing off, give the sub-agent a clear, scoped objective. They return when their part is done — you can then hand off again, finish, or take a final action yourself.',
    ].join('\n') : '',
    [
      'How to act:',
      '- Use tools directly to take action this cycle. Do NOT describe actions in your output — execute them.',
      '- If you have active executions, your primary job each cycle is to ADVANCE them. Call `execution_update_step` after making progress; `execution_complete` when success criteria are met. Compound progress across cycles instead of starting over.',
      '- `notify_user` for meaningful updates the user should see, but does NOT need to respond to.',
      '- `ask_user_question` ONLY when you genuinely cannot proceed without information the user has and you do not. Never re-ask something already open — open check-ins are listed in your input.',
      '- `execution_mark_blocked` when something external blocks you. If a user answer would unblock it, ALSO call `ask_user_question` with the contextExecutionId so the cycle resumes when they answer.',
      '- `task_add` / `task_update` to manage the tasks file. `goal_update` to log progress or change goal status.',
      '- `note_take` to append context to today\'s daily note.',
      '- `memory_remember` for durable preferences, project context, or standing feedback that should carry across sessions.',
      '- `memory_recall` to look something up before deciding.',
      '- `propose_check_in_template` when you notice a recurring rhythm in the user\'s work (weekly deploys, daily standups, monthly reviews) or a condition that should trigger a future nudge. DO NOT auto-install — the user approves from Settings → Proactive Check-Ins. Always include a clear `rationale` referencing the specific pattern you observed.',
      '- `draft_plan` BEFORE you act on complex multi-step work — it returns a structured plan (objective, steps, risks, needsUserInput, recommendsTrackedExecution) without mutating anything. Skip it for trivial actions.',
      '- `share_plan` after `draft_plan` when the plan is executable, moderate, and safe/local/read-only but the user should still see the working approach. It does not ask for approval; continue after sharing it.',
      '- `surface_plan` after `draft_plan` only when the plan is executable and significant/large or recommendsTrackedExecution. If needsUserInput is non-empty, ask that clarification first; incomplete plans are not approvable. Skip surface_plan when the plan is trivial/moderate and unambiguous — share the plan if useful, then execute it.',
      '- If there\'s nothing useful to do this cycle, take no action and say so in your summary.',
      '- If you receive an inbox item of type `check_in_answered`, the user just answered a question you previously asked. Pick up where you left off and use the answer to make progress.',
    ].join('\n'),
    peerCommsEnabled()
      ? commsInstructionBlock(agent.slug)
      : 'Multi-agent comms (messaging, delegation, replies) is not available in v2 yet — for now, leave those to v1 by surfacing the intent in your summary so the user can act.',
    proposalFeedbackBlock,
    'Output: return only `summary`, `commitments`, and optional `followUpMinutes`. Be specific and brief.',
  ].filter(Boolean).join('\n\n');
}

// -------- Agent cache --------
// Building an Agent is cheap, but caching avoids per-tick churn and
// gives us a stable EventEmitter to attach hooks to per slug.

type AutonomyAgent = Agent<RuntimeContextValue>;

interface AgentCacheEntry {
  record: TeamAgentRecord;
  policyFingerprint: string;
  agent: AutonomyAgent;
}

const agentCache = new Map<string, AgentCacheEntry>();
let runner: Runner | null = null;

/**
 * Drop every cached autonomy agent. Called when the MCP server config
 * changes (dashboard add/edit/delete) so the next cycle constructs a
 * fresh agent against the new namespace shim instead of holding the
 * old one.
 */
export function clearAutonomyAgentCache(): void {
  agentCache.clear();
}

/**
 * WeakMap from Agent instance → active runId for the current cycle.
 * Hooks attached to a cached Agent read this to know which run to log
 * into. Per-slug cycles run in parallel safely because each slug has
 * its own cached Agent instance.
 */
const currentRunIdByAgent: WeakMap<AutonomyAgent, string> = new WeakMap();

function getRunner(): Runner {
  if (runner) return runner;
  const key = getOpenAiApiKey();
  if (key) setDefaultOpenAIKey(key);
  runner = new Runner({ workflowName: 'clementine-autonomy-v2', groupId: 'clementine' });
  return runner;
}

function recordHash(record: TeamAgentRecord): string {
  return JSON.stringify({
    s: record.slug,
    n: record.name,
    p: record.personality,
    r: record.role,
    d: record.description,
    m: record.model,
    pr: record.project,
    // Slice 4: skill/workflow bindings change the instructions → bust cache.
    sk: record.skills ?? [],
    wf: record.workflows ?? [],
  });
}

/**
 * Hash the policy fields that affect the agent's tool list or
 * instructions. Any field included here invalidates the agent cache
 * when it changes — the next cycle builds a fresh Agent with the new
 * tool set or guidance.
 */
function policyFingerprint(policy: ProactivityPolicy): string {
  return JSON.stringify({
    mode: policy.mode,
    cs: policy.allowComputerActions,
    cm: policy.allowComposioActions,
    dc: policy.allowDiscordCheckIns,
    wg: policy.requireWorkflowApprovalForExecution,
    // Fold the peer-comms flag in so flipping it busts the agent cache and
    // the comms tools appear/disappear on the next cycle (no restart).
    pc: peerCommsEnabled(),
  });
}

/**
 * Categorize a tool by name for policy-based filtering. Mirrors the
 * categories in src/dashboard/state.ts but lives here so the runtime
 * filter doesn't depend on the dashboard module.
 */
export function categorizeToolForPolicy(name: string): 'composio' | 'computer' | 'other' {
  if (name.startsWith('composio_') || name.startsWith('cx_')) return 'composio';
  if ([
    'run_shell_command',
    'write_file',
    'read_file',
    'list_files',
    'git_status',
    'workspace_config',
    'workspace_list',
    'workspace_info',
    'workspace_roots',
  ].includes(name)) return 'computer';
  return 'other';
}

interface PolicyFilterableTool {
  name?: string;
  // The SDK Tool shape is broader, but for filtering we only need .name.
}

/**
 * Filter a list of tools according to the current proactivity policy.
 * Returns a new array; never mutates the input. When the policy allows
 * everything (the default), this is a near-no-op pass-through.
 */
export function filterToolsByPolicy<T extends PolicyFilterableTool>(
  tools: T[],
  policy: ProactivityPolicy,
): T[] {
  return tools.filter((tool) => {
    const category = categorizeToolForPolicy(tool.name ?? '');
    if (category === 'composio' && !policy.allowComposioActions) return false;
    if (category === 'computer' && !policy.allowComputerActions) return false;
    return true;
  });
}

async function getAgent(record: TeamAgentRecord, policy: ProactivityPolicy): Promise<AutonomyAgent> {
  const cached = agentCache.get(record.slug);
  const recFp = recordHash(record);
  const polFp = policyFingerprint(policy);
  if (cached && recordHash(cached.record) === recFp && cached.policyFingerprint === polFp) {
    return cached.agent;
  }

  // Include the Planner-as-tool so autonomy cycles can think before
  // they act, exactly like the chat path. The Planner is read-only so
  // it always passes policy filters.
  // Peer-comms tools are bound to THIS agent's slug (correct attribution
  // in the shared daemon). Gated default-off → tool set is unchanged.
  const commsTools = peerCommsEnabled() ? buildAgentCommsTools(record.slug) : [];
  const allTools = [...getCoreTools(), buildPlannerTool(), ...commsTools];
  const tools = filterToolsByPolicy(allTools, policy);

  // Orchestrator agents get handoffs configured so they can delegate
  // focused work to specialized sub-agents (researcher, executor) via
  // the SDK's native handoff flow — no disk polling, all in one run.
  // The primary `clementine` agent is the orchestrator by default;
  // other slugs can opt in via AUTONOMY_ORCHESTRATOR_SLUGS env var.
  const handoffs = isOrchestratorSlug(record.slug)
    ? await defaultOrchestratorHandoffs({
      requireWorkflowApprovalForExecution: policy.requireWorkflowApprovalForExecution,
    })
    : undefined;

  const agent: AutonomyAgent = new Agent<RuntimeContextValue>({
    name: record.name,
    instructions: buildAgentInstructions(record, policy),
    model: record.model ?? MODELS.fast,
    tools,
    handoffs,
    // Single namespace-shimmed MCP server — flattens every configured
    // server's tools under `<server>__<tool>` names so duplicate-name
    // collisions across installs cannot throw at agent construction.
    mcpServers: [getOrCreateConfiguredMcpServers()],
  });

  // Per-tool lifecycle hooks. Resolve the active runId via WeakMap so
  // parallel cycles for different agents stay isolated — each slug has
  // its own cached Agent instance and its own WeakMap entry.
  attachToolHooks(agent);

  agentCache.set(record.slug, { record, policyFingerprint: polFp, agent });
  return agent;
}

/** Safe JSON parse for tool argument strings. Returns the parsed value
 *  when possible, otherwise the original string (useful when the tool
 *  was invoked with non-JSON input). */
export function parseToolArguments(argString: unknown): unknown {
  if (typeof argString !== 'string') return argString;
  const trimmed = argString.trim();
  if (!trimmed) return {};
  if (trimmed[0] !== '{' && trimmed[0] !== '[' && trimmed[0] !== '"') return trimmed;
  try {
    return JSON.parse(trimmed);
  } catch {
    return trimmed;
  }
}

/** Heuristic: does a tool result look like an error? Used to flag the
 *  event type so the dashboard can render it red without us needing
 *  the SDK to surface a per-tool success bit. False positives are
 *  fine — the data field still has the raw result for inspection. */
export function looksLikeToolError(result: string): boolean {
  if (!result) return false;
  const head = result.slice(0, 200).toLowerCase();
  if (head.startsWith('error') || head.startsWith('failed') || head.startsWith('failure')) return true;
  if (/\b(unauthorized|forbidden|not[ _]?found|bad request|timeout|denied|exception|traceback)\b/.test(head)) return true;
  if (/\b(401|403|404|429|500|502|503|504)\b/.test(head)) return true;
  return false;
}

const TOOL_RESULT_PREVIEW_CHARS = 1000;
const TOOL_ARGS_PREVIEW_CHARS = 600;

function truncate(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max)}…(+${value.length - max} chars)`;
}

function attachToolHooks(agent: AutonomyAgent): void {
  // AgentHooks signature: agent_tool_start = (context, tool, details).
  // We previously had this typed as (ctx, agent, tool) which silently
  // looked at the wrong field. Now we read tool.name and parse
  // details.toolCall.arguments for the input.
  agent.on('agent_tool_start', (_ctx, tool, details) => {
    const runId = currentRunIdByAgent.get(agent);
    if (!runId) return;
    const toolRef = tool as { name?: string } | undefined;
    const callRef = (details as { toolCall?: { name?: string; arguments?: string } } | undefined)?.toolCall;
    const name = toolRef?.name ?? callRef?.name ?? 'tool';
    const args = parseToolArguments(callRef?.arguments);
    let argsPreview: unknown = args;
    if (typeof args === 'object' && args !== null) {
      const json = JSON.stringify(args);
      if (json.length > TOOL_ARGS_PREVIEW_CHARS) {
        argsPreview = `${json.slice(0, TOOL_ARGS_PREVIEW_CHARS)}…(+${json.length - TOOL_ARGS_PREVIEW_CHARS} chars)`;
      }
    }

    addRunEvent(runId, {
      type: 'tool_started',
      message: `Tool: ${name}`,
      data: { toolName: name, input: argsPreview },
    });
  });

  // AgentHooks signature: agent_tool_end = (context, tool, result, details).
  agent.on('agent_tool_end', (_ctx, tool, result, details) => {
    const runId = currentRunIdByAgent.get(agent);
    if (!runId) return;
    const toolRef = tool as { name?: string } | undefined;
    const callRef = (details as { toolCall?: { name?: string } } | undefined)?.toolCall;
    const name = toolRef?.name ?? callRef?.name ?? 'tool';
    const resultStr = typeof result === 'string' ? result : (() => {
      try { return JSON.stringify(result); } catch { return String(result); }
    })();
    const hasError = looksLikeToolError(resultStr);

    addRunEvent(runId, {
      type: 'status',
      message: hasError
        ? `Tool ERRORED: ${name} — ${resultStr.slice(0, 160)}`
        : `Tool finished: ${name}`,
      data: {
        toolName: name,
        result: truncate(resultStr, TOOL_RESULT_PREVIEW_CHARS),
        resultChars: resultStr.length,
        looksLikeError: hasError,
      },
    });
  });

  agent.on('agent_end', (_ctx, output) => {
    const runId = currentRunIdByAgent.get(agent);
    if (!runId) return;
    addRunEvent(runId, {
      type: 'status',
      message: `Agent finished (${typeof output === 'string' ? `${output.length} chars` : 'structured output'}).`,
    });
  });
}

async function assertAutonomyDecisionGuardrails(decision: AgentDecisionV2): Promise<void> {
  for (const guardrail of autonomyV2OutputGuardrails) {
    const result = await guardrail.execute({ agentOutput: decision } as never);
    if (result.tripwireTriggered) {
      throw new Error(`Autonomy decision rejected by ${guardrail.name}: ${String(result.outputInfo ?? 'guardrail triggered')}`);
    }
  }
}

// -------- Main cycle --------
//
// Phase 2 removed executeDecisionActions — the SDK Runner now executes
// tool calls during agent.run(), and those tool calls ARE the actions.
// The cycle records the metadata (summary, commitments, follow-up)
// into agent state. The runs.json store captures the tool-call timeline
// (when wired via per-tool hooks in Phase 1.5).

async function runAgentCycleV2(record: TeamAgentRecord): Promise<{ runId: string; success: boolean; outcomes: string[]; error?: string }> {
  const state = loadAgentState(record.slug);
  const inboxItems = loadInbox(record.slug).filter((item) => item.status === 'pending').slice(0, MAX_INBOX_PER_CYCLE);
  const wakeReasons = [
    ...(inboxItems.length > 0 ? ['inbox'] : []),
    ...(isCadenceDue(record, state) ? ['cadence'] : []),
  ];
  if (wakeReasons.length === 0) {
    return { runId: '', success: true, outcomes: [] };
  }

  const runId = startAutonomyRun(record, wakeReasons, inboxItems.length);

  // Fresh per-cycle peer-message budget (gated; no-op when disabled).
  if (peerCommsEnabled()) resetCommsCycle(record.slug);

  // Read policy once per cycle so the agent build, the input text, and
  // the recorded snapshot all use the same view. Avoids the agent's
  // tools and the policy text disagreeing if the user toggles a setting
  // mid-cycle.
  const policySnapshot = getProactivityPolicySnapshot();
  const policy = policySnapshot.policy;

  // Capture the policy snapshot as a run event so the dashboard / audit
  // can answer "what was the agent operating under during this cycle?"
  // months later.
  const policyEvent = buildPolicyEvent(policySnapshot);
  addRunEvent(runId, policyEvent);

  const agent = await getAgent(record, policy);
  const input = buildAgentInput(record, inboxItems, state, policy);
  currentRunIdByAgent.set(agent, runId);

  try {
    const result = await getRunner().run(agent, input, {
      context: { sessionId: `agent:${record.slug}`, userId: record.slug, channel: 'agent' },
      maxTurns: 8,
    });

    const decision = sanitizeAgentDecisionOutput(result.finalOutput);
    if (!decision) {
      throw new Error('Agent run completed but produced no usable decision output.');
    }
    await assertAutonomyDecisionGuardrails(decision);

    recordAutonomyResponse(runId, JSON.stringify(decision));
    recordAutonomyDecision(runId, {
      summary: decision.summary,
      commitments: decision.commitments,
      followUpMinutes: decision.followUpMinutes,
    });

    markInboxProcessed(record.slug, inboxItems.map((item) => item.id));

    // When the agent is actively driving an execution, default to a
    // tighter follow-up window than the user-configured cadence. This
    // is the "never stops until done" knob — work in flight keeps
    // waking up. Only applied when the agent didn't pick a specific
    // followUpMinutes itself.
    const activeExecs = activeExecutionCountForSession(`agent:${record.slug}`);
    const effectiveFollowUp = chooseFollowUpMinutes(decision.followUpMinutes, activeExecs, policy);

    saveAgentState({
      slug: record.slug,
      engine: 'v2',
      lastRunAt: new Date().toISOString(),
      lastWakeAt: new Date().toISOString(),
      lastWakeReasons: wakeReasons,
      lastSummary: decision.summary,
      commitments: decision.commitments.slice(0, 8),
      nextWakeAt: effectiveFollowUp
        ? new Date(Date.now() + effectiveFollowUp * 60_000).toISOString()
        : undefined,
    });

    finishAutonomyRun(runId, [decision.summary]);

    return { runId, success: true, outcomes: [decision.summary] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ err: error, agent: record.slug }, 'autonomy-v2 cycle failed');
    saveAgentState({
      ...state,
      slug: record.slug,
      engine: 'v2',
      lastRunAt: new Date().toISOString(),
      lastError: message,
    });
    finishAutonomyRun(runId, [], message);
    return { runId, success: false, outcomes: [], error: message };
  } finally {
    // Always release the WeakMap binding so a stale runId can't leak
    // into a future cycle if hooks fire after the run resolves.
    currentRunIdByAgent.delete(agent);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then((value) => { clearTimeout(timer); resolve(value); }, (err) => { clearTimeout(timer); reject(err); });
  });
}

export interface AutonomyV2RunSummary {
  attempted: number;
  succeeded: number;
  failed: number;
  skipped: number;
  durationMs: number;
}

/**
 * Run a single v2 autonomy pass over all opted-in agents in parallel.
 * Safe to call repeatedly; idempotent within a cycle thanks to the
 * inbox `processed` flag and `lastRunAt` cadence check.
 */
export async function processAgentAutonomyV2(): Promise<AutonomyV2RunSummary> {
  const start = Date.now();
  const summary: AutonomyV2RunSummary = { attempted: 0, succeeded: 0, failed: 0, skipped: 0, durationMs: 0 };

  if (!getOpenAiApiKey()) {
    summary.durationMs = Date.now() - start;
    return summary;
  }

  const optIn = readOptInSlugs();
  if (optIn.size === 0) {
    summary.durationMs = Date.now() - start;
    return summary;
  }

  // Deliver peer messages sent in prior cycles into recipient inboxes so
  // this pass picks them up (the syncAutonomyInputs step v1 used to own).
  // Gated default-off → the v2 loop is byte-identical.
  if (peerCommsEnabled()) {
    try { logCommsDelivery(deliverTeamCommsToInboxes()); }
    catch (err) { logger.warn({ err }, 'peer-comms delivery failed'); }
  }

  const records = loadTeamAgents().filter((rec) => optIn.has(rec.slug) && rec.autonomyEnabled !== false);
  if (records.length === 0) {
    summary.durationMs = Date.now() - start;
    return summary;
  }

  const results = await Promise.allSettled(
    records.map((rec) => withTimeout(runAgentCycleV2(rec), PER_AGENT_TIMEOUT_MS, `agent ${rec.slug}`)),
  );

  for (const result of results) {
    summary.attempted++;
    if (result.status === 'fulfilled') {
      if (!result.value.runId) {
        summary.skipped++;
      } else if (result.value.success) {
        summary.succeeded++;
      } else {
        summary.failed++;
      }
    } else {
      summary.failed++;
      logger.warn({ err: result.reason }, 'autonomy-v2 cycle rejected');
    }
  }

  summary.durationMs = Date.now() - start;
  return summary;
}
