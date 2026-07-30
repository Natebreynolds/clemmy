import { Agent, Runner, setDefaultOpenAIKey, setTracingExportApiKey } from '@openai/agents';
import { z } from 'zod';
import pino from 'pino';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { getActiveAuthMode, getOpenAiApiKey, getRuntimeEnv, MODELS } from '../config.js';
import { autonomyV2OutputGuardrails } from './autonomy-guardrails.js';
import { extractJsonCandidate } from '../runtime/harness/json-repair.js';
import { getProactivityPolicySnapshot, type ProactivityPolicy, type ProactivityPolicySnapshot } from './proactivity-policy.js';
import { renderOpenCheckInsForAgent } from './check-ins.js';
import {
  deliverTeamCommsToInboxes,
  logCommsDelivery,
  peerCommsEnabled,
  resetCommsCycle,
} from './agent-comms.js';
import {
  claimDelegationTransitionFor,
  completeDelegationTransitionFor,
  isValidDelegationId,
  renderOpenDelegations,
} from './agent-delegations.js';
import { DELEGATIONS_DIR as DELEGATIONS_DIR_FOR_WAKE } from '../tools/shared.js';
import { activeExecutionCountForSession, renderActiveExecutionsForAgent } from '../tools/execution-tools.js';
import { addNotification } from '../runtime/notifications.js';
import { respondPreferHarness } from '../runtime/harness/respond-bridge.js';
import { listEvents } from '../runtime/harness/eventlog.js';
import { resolveRoleModel } from '../runtime/harness/model-roles.js';
import type { ClementineAssistant } from '../assistant/core.js';
import { renderProfileForInstructions } from '../runtime/user-profile.js';
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
 * Durable autonomy loop.
 *
 * When Clementine's selected-brain runtime is available, autonomy uses it.
 * A compatible raw OpenAI SDK credential is a no-assistant fallback only.
 * Both lanes are decision-only: the model returns a strict, closed JSON action
 * list and this module validates and executes those actions with the acting
 * agent slug bound in code. Neither lane grants direct local, MCP, or handoff
 * authority to the model.
 *
 * Opt in with `AUTONOMY_V2_AGENTS=clementine,researcher`. Empty or unset is a
 * no-op. Per-agent single-flight ownership, cancellation, and bounded retry
 * backoff keep daemon ticks from overlapping or hammering a degraded provider.
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

// -------- Decision metadata schema --------
// Actions are sanitized separately because both model lanes return the same
// closed action vocabulary and code, not the model runtime, owns execution.

export const AgentDecisionSchema = z.object({
  summary: z.string().describe('Brief explanation of what was decided or completed in this cycle.'),
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
  // CLAMP the wake preference instead of letting an out-of-range value void
  // the whole decision. Live failure class (2026-07-29): the model returned a
  // perfect decision with followUpMinutes: 3; the schema floor is 5, safeParse
  // failed, and the cycle discarded the decision — actions included — as
  // "no usable output". A bad wake preference is a detail to bound, never a
  // reason to drop completed reasoning.
  const clampedFollowUp = Number.isFinite(followUp)
    ? Math.min(1440, Math.max(5, followUp as number))
    : undefined;
  const candidate: AgentDecisionV2 = {
    summary: cleanDecisionString(obj.summary ?? obj.message ?? obj.result ?? obj.report, 1200),
    commitments: cleanStringArray(obj.commitments ?? obj.followUps ?? obj.follow_ups, 8),
    ...(clampedFollowUp !== undefined ? { followUpMinutes: clampedFollowUp } : {}),
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

/** Open delegated work is itself a wake reason — the 'delegation' entry every
 *  agent record has always listed in wakeTriggers, consumed at last. Paced by
 *  state.nextWakeAt so a failing cycle retries on a bounded backoff instead of
 *  hammering every tick or burning the full cadence. */
function isDelegationWakeDue(agent: TeamAgentRecord, state: AgentStateRecord): boolean {
  if (agent.wakeTriggers && !agent.wakeTriggers.includes('delegation')) return false;
  if (state.nextWakeAt && new Date(state.nextWakeAt).getTime() > Date.now()) return false;
  try {
    return readdirSync(path.join(DELEGATIONS_DIR_FOR_WAKE, agent.slug))
      .filter((file) => file.endsWith('.json'))
      .some((file) => {
        try {
          const record = JSON.parse(readFileSync(path.join(DELEGATIONS_DIR_FOR_WAKE, agent.slug, file), 'utf-8')) as { status?: string };
          return record.status !== 'completed';
        } catch { return false; }
      });
  } catch { return false; }
}

/** Backoff after a failed cycle: long enough not to hammer a degraded
 *  provider, short enough that transient weather never costs a full cadence. */
const CYCLE_FAILURE_RETRY_MS = 90_000;

function buildCycleFailureState(
  state: AgentStateRecord,
  slug: string,
  message: string,
  nowMs = Date.now(),
): AgentStateRecord {
  return {
    ...state,
    slug,
    engine: 'v2',
    lastRunAt: new Date(nowMs).toISOString(),
    lastError: message,
    nextWakeAt: new Date(nowMs + CYCLE_FAILURE_RETRY_MS).toISOString(),
  };
}

export const _testOnly_buildCycleFailureState = buildCycleFailureState;

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
    renderOpenDelegations(agent.slug),
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
 *   allowed action categories — context for what downstream governed work may
 *          be proposed. This decision lane itself never receives those tools.
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
    '- This cycle is decision-only. These policy flags do not grant direct local, connected-app, or handoff tools.',
    `- ${modeGuidance[policy.mode]}`,
    `- Default check-in cadence: ${policy.checkInMinutes} minute(s). Use this for followUpMinutes when you have no better reason.`,
  ];
  if (allowedCategories.length > 0) {
    lines.push(`- Policy permits these categories in a separately governed execution path: ${allowedCategories.join(', ')}.`);
  }
  if (blockedCategories.length > 0) {
    lines.push(`- Blocked: ${blockedCategories.join(', ')}. Do not propose work in these categories — it will fail downstream policy.`);
  }
  lines.push(policy.requireWorkflowApprovalForExecution
    ? '- Downstream execution gate: executor/deployer work requires an active tracked execution.'
    : '- Downstream execution gate: tracked-execution approval is disabled by policy.');
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
 * Drop every cached fallback agent. Configuration changes call this so the
 * next raw-SDK fallback cycle reconstructs its decision-only model wrapper.
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

function buildRunnerConfig(hasOpenAiKey: boolean): ConstructorParameters<typeof Runner>[0] {
  return {
    workflowName: 'clementine-autonomy-v2',
    groupId: 'clementine',
    tracingDisabled: !hasOpenAiKey,
  };
}

function getRunner(): Runner {
  if (runner) return runner;
  const key = getOpenAiApiKey();
  const hasKey = key.trim().length > 0;
  if (hasKey) {
    setDefaultOpenAIKey(key);
    setTracingExportApiKey(key);
  }
  runner = new Runner(buildRunnerConfig(hasKey));
  return runner;
}

export const _testOnly_buildRunnerConfig = buildRunnerConfig;
/** Exposed so the delegation wiring (assigned work reaches the cycle input) is
 *  pinned by a test rather than only by typecheck. */
export const _testOnly_buildAgentInput = buildAgentInput;

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

  const agent: AutonomyAgent = new Agent<RuntimeContextValue>({
    name: record.name,
    instructions: [
      'You are a durable team-agent decision engine.',
      'You have no direct tools or handoffs in this lane.',
      'Return only the strict JSON decision requested in the input.',
      'Never invent a delegation id or claim an external effect you did not perform in this reply.',
    ].join(' '),
    model: record.model ?? MODELS.fast,
    ...rawSdkDecisionOnlySurface(),
  });

  // Per-tool lifecycle hooks. Resolve the active runId via WeakMap so
  // parallel cycles for different agents stay isolated — each slug has
  // its own cached Agent instance and its own WeakMap entry.
  attachToolHooks(agent);

  agentCache.set(record.slug, { record, policyFingerprint: polFp, agent });
  return agent;
}

function rawSdkDecisionOnlySurface(): { tools: []; mcpServers: [] } {
  return { tools: [], mcpServers: [] };
}

/** Release contract: the no-assistant SDK fallback has the same closed,
 * code-executed action surface as the selected-brain runtime lane. */
export const _testOnly_rawSdkDecisionOnlySurface = rawSdkDecisionOnlySurface;

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
// Both model lanes return the same JSON contract. Actions are sanitized and
// executed below; only after every requested transition succeeds do we consume
// inbox inputs and record the cycle as successful.

async function runAgentCycleV2(
  record: TeamAgentRecord,
  signal?: AbortSignal,
): Promise<{ runId: string; success: boolean; outcomes: string[]; error?: string }> {
  const state = loadAgentState(record.slug);
  const inboxItems = loadInbox(record.slug).filter((item) => item.status === 'pending').slice(0, MAX_INBOX_PER_CYCLE);
  const wakeReasons = [
    ...(inboxItems.length > 0 ? ['inbox'] : []),
    ...(isCadenceDue(record, state) ? ['cadence'] : []),
    ...(isDelegationWakeDue(record, state) ? ['delegation'] : []),
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
  const input = buildRuntimeCyclePrompt(record, buildAgentInput(record, inboxItems, state, policy));
  currentRunIdByAgent.set(agent, runId);

  try {
    const result = await getRunner().run(agent, input, {
      context: { sessionId: `agent:${record.slug}`, userId: record.slug, channel: 'agent' },
      maxTurns: 8,
      signal,
    });
    if (signal?.aborted) throw new Error('cycle_aborted: caller wait budget expired');

    const parsed = parseDecisionJson(result.finalOutput) as Record<string, unknown> | null;
    const decision = sanitizeAgentDecisionOutput(result.finalOutput);
    if (!decision) {
      throw new Error('Agent run completed but produced no usable decision output.');
    }
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('cycle_prose_only: reply was not the JSON decision contract');
    }
    await assertAutonomyDecisionGuardrails(decision);

    const actions = sanitizeRuntimeCycleActions(parsed.actions);
    const actionOutcomes = executeRuntimeCycleActions(record.slug, actions);
    assertRuntimeActionsSucceeded(actionOutcomes);
    assertWakeMadeProgress(wakeReasons, actionOutcomes);

    recordAutonomyResponse(runId, JSON.stringify({ ...decision, actions }));
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

    const outcomes = actionOutcomes.map((outcome) => outcome.message);
    finishAutonomyRun(runId, [decision.summary, ...outcomes]);

    return { runId, success: true, outcomes: [decision.summary, ...outcomes] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ err: error, agent: record.slug }, 'autonomy-v2 cycle failed');
    saveAgentState(buildCycleFailureState(state, record.slug, message));
    finishAutonomyRun(runId, [], message);
    return { runId, success: false, outcomes: [], error: message };
  } finally {
    // Always release the WeakMap binding so a stale runId can't leak
    // into a future cycle if hooks fire after the run resolves.
    currentRunIdByAgent.delete(agent);
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  onTimeout?: () => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { onTimeout?.(); } catch { /* timeout still rejects */ }
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
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


// -------- OAuth/runtime cycle engine --------
//
// The SDK engine above is built on `@openai/agents` and therefore needs a raw
// OpenAI API key — a credential this product otherwise uses only for voice and
// embeddings. OAuth-primary installs (Claude OAuth, Codex OAuth — the shipped
// default) never have one, so opted-in agents were permanently inert there.
//
// This engine runs the SAME cycle through the assistant's brain runtime — the
// canonical primitive the execution controller, cron, and proactive briefs
// already drive autonomous turns through — so it works on every auth mode the
// product supports. The decision comes back as strict JSON; a small, closed
// action vocabulary is executed deterministically in code with the agent's
// slug bound at the call site (never a process-global), reusing the exact
// transition functions the SDK tools call. One owner, two entry points.

const RUNTIME_CYCLE_TIMEOUT_MS = 180_000;
const MAX_RUNTIME_ACTIONS = 5;

/**
 * Physical cycle ownership, independent of the caller's wait budget.
 *
 * A Promise.race timeout only stops the caller from waiting; it does not stop
 * the model/tool loop underneath. Keep the slug claimed until that underlying
 * work actually settles so a later daemon tick cannot start an overlapping
 * cycle against the same inbox/delegations.
 */
interface ClaimedCycle<T> {
  started: true;
  promise: Promise<T>;
  abort: () => void;
}

const cyclesInFlight = new Map<string, { promise: Promise<unknown>; abort: () => void }>();

function claimCycle<T>(
  slug: string,
  start: (signal: AbortSignal) => Promise<T>,
): ClaimedCycle<T> | { started: false; promise: Promise<unknown> } {
  const existing = cyclesInFlight.get(slug);
  if (existing) return { started: false, promise: existing.promise };

  const controller = new AbortController();
  const promise = start(controller.signal);
  const claimed = { promise, abort: () => controller.abort() };
  cyclesInFlight.set(slug, claimed);
  void promise.then(
    () => {
      if (cyclesInFlight.get(slug) === claimed) cyclesInFlight.delete(slug);
    },
    () => {
      if (cyclesInFlight.get(slug) === claimed) cyclesInFlight.delete(slug);
    },
  );
  return { started: true, promise, abort: claimed.abort };
}

export interface RuntimeCycleAction {
  type: 'claim_delegation' | 'complete_delegation' | 'notify_user';
  delegationId?: string;
  result?: string;
  title?: string;
  body?: string;
}

/** Strict, clamped parse of the runtime engine's action list. Unknown types
 *  and malformed entries are dropped, never guessed at. */
export function sanitizeRuntimeCycleActions(value: unknown): RuntimeCycleAction[] {
  if (!Array.isArray(value)) return [];
  const out: RuntimeCycleAction[] = [];
  for (const raw of value) {
    if (out.length >= MAX_RUNTIME_ACTIONS) break;
    if (!raw || typeof raw !== 'object') continue;
    const obj = raw as Record<string, unknown>;
    const type = obj.type;
    if (type === 'claim_delegation') {
      const delegationId = cleanDecisionString(obj.delegationId ?? obj.delegation_id, 64);
      if (delegationId && isValidDelegationId(delegationId)) out.push({ type, delegationId });
    } else if (type === 'complete_delegation') {
      const delegationId = cleanDecisionString(obj.delegationId ?? obj.delegation_id, 64);
      const result = cleanDecisionString(obj.result, 4000);
      if (delegationId && isValidDelegationId(delegationId) && result) {
        out.push({ type, delegationId, result });
      }
    } else if (type === 'notify_user') {
      const title = cleanDecisionString(obj.title, 140);
      const body = cleanDecisionString(obj.body, 1000);
      if (title) out.push({ type, title, body });
    }
  }
  return out;
}

function buildRuntimeCyclePrompt(record: TeamAgentRecord, input: string): string {
  return [
    `You are ${record.name} (${record.slug}), a durable team agent, on a scheduled working cycle. ${record.description ?? ''}`,
    '',
    input,
    '',
    'Decide what to do this cycle and reply with STRICT JSON only — no prose before or after:',
    '{"summary": string, "commitments": string[], "followUpMinutes"?: number, "actions": Action[]}',
    'Action is one of:',
    '  {"type":"claim_delegation","delegationId":string}   — claim a task delegated to you before working on it',
    '  {"type":"complete_delegation","delegationId":string,"result":string} — result must be the ACTUAL work product, not a promise',
    '  {"type":"notify_user","title":string,"body":string} — only for something the user should see',
    'Rules: act only on delegations listed in your input. If a delegated task is small enough to finish now, do the work and complete it with the real result in this reply. If nothing needs doing, return an empty actions array and say so in summary.',
  ].join('\n');
}

interface RuntimeActionOutcome {
  actionType: RuntimeCycleAction['type'];
  ok: boolean;
  message: string;
}

/** Execute the closed action vocabulary deterministically, slug bound in code.
 * Failures remain structured so the cycle cannot mistake a denial string for
 * successful work and consume its triggering inputs. */
function executeRuntimeCycleActions(slug: string, actions: RuntimeCycleAction[]): RuntimeActionOutcome[] {
  const outcomes: RuntimeActionOutcome[] = [];
  for (const action of actions) {
    try {
      if (action.type === 'claim_delegation' && action.delegationId) {
        const result = claimDelegationTransitionFor(slug, action.delegationId);
        outcomes.push({ actionType: action.type, ...result });
      } else if (action.type === 'complete_delegation' && action.delegationId && action.result) {
        const result = completeDelegationTransitionFor(slug, action.delegationId, action.result, 'model_prose');
        outcomes.push({ actionType: action.type, ...result });
      } else if (action.type === 'notify_user' && action.title) {
        addNotification({
          id: `${Date.now()}-agent-${slug}-${randomSuffix()}`,
          kind: 'system',
          title: action.title,
          body: action.body ?? '',
          createdAt: new Date().toISOString(),
          read: false,
          metadata: { agentSlug: slug },
        });
        outcomes.push({ actionType: action.type, ok: true, message: `Notified user: ${action.title}` });
      }
    } catch (err) {
      outcomes.push({
        actionType: action.type,
        ok: false,
        message: `Action ${action.type} failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }
  return outcomes;
}

function assertRuntimeActionsSucceeded(outcomes: RuntimeActionOutcome[]): void {
  const failures = outcomes.filter((outcome) => !outcome.ok);
  if (failures.length === 0) return;
  throw new Error(`cycle_action_failed: ${failures.map((failure) => failure.message).join(' | ')}`);
}

function assertWakeMadeProgress(wakeReasons: string[], outcomes: RuntimeActionOutcome[]): void {
  if (!wakeReasons.includes('delegation')) return;
  if (outcomes.some((outcome) => outcome.ok)) return;
  throw new Error(
    'cycle_no_progress: delegation wake requires a successful delegation transition or an explicit user notification',
  );
}

function randomSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

/** Seam for the cycle-stagger pin: the runtime cycle hard-requires live brain
 *  auth (tool-scoped requests never widen through the legacy fallback), so the
 *  end-to-end tick test injects a stub cycle here instead. Production never
 *  touches this. */
let runtimeCycleImpl: typeof runAgentCycleViaRuntime | undefined;
export const _testOnly_setRuntimeCycleImpl = (fn?: typeof runAgentCycleViaRuntime): void => {
  runtimeCycleImpl = fn;
};

async function runAgentCycleViaRuntime(
  assistant: ClementineAssistant,
  record: TeamAgentRecord,
  signal?: AbortSignal,
): Promise<{ runId: string; success: boolean; outcomes: string[]; error?: string }> {
  const state = loadAgentState(record.slug);
  const inboxItems = loadInbox(record.slug).filter((item) => item.status === 'pending').slice(0, MAX_INBOX_PER_CYCLE);
  const wakeReasons = [
    ...(inboxItems.length > 0 ? ['inbox'] : []),
    ...(isCadenceDue(record, state) ? ['cadence'] : []),
    ...(isDelegationWakeDue(record, state) ? ['delegation'] : []),
  ];
  if (wakeReasons.length === 0) return { runId: '', success: true, outcomes: [] };

  const runId = startAutonomyRun(record, wakeReasons, inboxItems.length);
  const policySnapshot = getProactivityPolicySnapshot();
  addRunEvent(runId, buildPolicyEvent(policySnapshot));

  try {
    const input = buildAgentInput(record, inboxItems, state, policySnapshot.policy);
    // Run the cycle exactly the way cron runs jobs: respondPreferHarness on the
    // 'cron' surface routes through the gated harness loop with whatever brain
    // is configured — Claude OAuth, Codex OAuth, or BYO. The low-level
    // runtime.run() looked equivalent but is the CODEX-NATIVE tool loop and
    // hard-requires a ChatGPT sign-in (proven by local repro, live date):
    // on a Claude-only install it cannot serve at all.
    const baseRequest = {
      sessionId: `agent:${record.slug}`,
      channel: 'cron' as const,
      message: buildRuntimeCyclePrompt(record, input),
      maxWallClockMs: RUNTIME_CYCLE_TIMEOUT_MS,
      shouldCancel: () => Boolean(signal?.aborted),
      // This lane is decision-only. The model returns a closed JSON action
      // vocabulary; code executes those actions with the agent slug bound.
      // An explicit empty allowlist prevents the generic cron harness from
      // granting unrelated local or external tool authority mid-turn.
      allowedToolNames: [],
      // The model's strict JSON decision is the intended zero-tool deliverable.
      // The autonomy layer below still validates its schema, exact queue-owned
      // ids, and result text before code executes any transition.
      acceptStructuredNoToolResult: true,
      // The harness surface exposes the registry team tools, which attribute
      // the actor from the PROCESS-GLOBAL agent slug — in the shared daemon a
      // cycle using them records the work as 'clementine' (proven live: the
      // first harness-lane cycle completed its delegation by calling
      // complete_delegation directly, attributed to the wrong actor). Close
      // that door for cycle turns: the model must return the JSON actions,
      // which execute with the slug bound in code.
      excludeToolNames: ['complete_delegation', 'delegation_inbox', 'check_delegation', 'delegate_task', 'team_reply', 'team_request', 'team_message'],
    };
    let run = await respondPreferHarness('cron', baseRequest, (req) => assistant.respond(req));
    // A turn that parked, errored, or hit a budget is NOT a completed cycle —
    // treating it as one would consume inbox items and advance the wake state
    // on the strength of an apology (the exact ungrounded-success class this
    // release removes). Surface the truthful state and leave the inputs intact
    // so the next cycle retries them. (validator feedback, live date)
    const terminalOk = (reason: string | undefined): boolean => reason === undefined || reason === 'success';
    if (!terminalOk(run.stoppedReason)) {
      throw new Error(`cycle_not_terminal:${run.stoppedReason}`);
    }
    let parsed = parseDecisionJson(run.text) as Record<string, unknown> | null;
    let decision = sanitizeAgentDecisionOutput(run.text);
    if (!decision) {
      run = await respondPreferHarness('cron', {
        ...baseRequest,
        message: `${baseRequest.message}\n\nYour previous reply was not parseable JSON. Reply with ONLY the JSON object described above.`,
      }, (req) => assistant.respond(req));
      if (!terminalOk(run.stoppedReason)) {
        throw new Error(`cycle_not_terminal:${run.stoppedReason}`);
      }
      parsed = parseDecisionJson(run.text) as Record<string, unknown> | null;
      decision = sanitizeAgentDecisionOutput(run.text);
    }
    if (!decision) {
      // The Claude SDK brain lane records the model's final structured output
      // in the durable conversation_completed event but can ship EMPTY
      // user-visible text for a JSON-only reply (proven live: two attempts,
      // both with the full decision JSON in the event summary and empty
      // response text). The eventlog is the canonical record — read the
      // decision from there before declaring the cycle unusable.
      try {
        const [completed] = listEvents(`agent:${record.slug}`, { types: ['conversation_completed'], desc: true, limit: 1 });
        const data = completed?.data as { reply?: unknown; summary?: unknown } | undefined;
        // `reply` is the FULL final text; `summary` is a 400-char preview that
        // truncated the actions array mid-word on the first live attempt.
        const eventText = typeof data?.reply === 'string' && data.reply.trim()
          ? data.reply
          : typeof data?.summary === 'string' ? data.summary : '';
        if (eventText.trim()) {
          parsed = parseDecisionJson(eventText) as Record<string, unknown> | null;
          decision = sanitizeAgentDecisionOutput(eventText);
        }
      } catch { /* fall through to the explicit failure below */ }
    }
    if (!decision) throw new Error('Agent cycle completed but produced no usable decision output.');
    // The sanitizer's prose fallback exists for the SDK engine, where the
    // structure is enforced server-side. For runtime cycles it is a hole: a
    // mid-turn recovery narration ("Recovered successfully...") was accepted
    // as a summary-only decision and scored a successful cycle while the
    // delegated work sat untouched (live, codex, validator class). A cycle
    // decision must come from parsed JSON or the cycle fails and its inputs
    // stay intact for retry.
    if (!parsed || typeof parsed !== 'object') {
      throw new Error('cycle_prose_only: reply was not the JSON decision contract');
    }
    await assertAutonomyDecisionGuardrails(decision);
    if (signal?.aborted) throw new Error('cycle_aborted: caller wait budget expired');

    const actions = sanitizeRuntimeCycleActions(parsed?.actions);
    const actionOutcomes = executeRuntimeCycleActions(record.slug, actions);
    assertRuntimeActionsSucceeded(actionOutcomes);
    assertWakeMadeProgress(wakeReasons, actionOutcomes);
    const outcomes = actionOutcomes.map((outcome) => outcome.message);

    recordAutonomyResponse(runId, JSON.stringify({ ...decision, actions }));
    recordAutonomyDecision(runId, {
      summary: decision.summary,
      commitments: decision.commitments,
      followUpMinutes: decision.followUpMinutes,
    });
    markInboxProcessed(record.slug, inboxItems.map((item) => item.id));

    const activeExecs = activeExecutionCountForSession(`agent:${record.slug}`);
    const effectiveFollowUp = chooseFollowUpMinutes(decision.followUpMinutes, activeExecs, policySnapshot.policy);
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
    finishAutonomyRun(runId, [decision.summary, ...outcomes]);
    return { runId, success: true, outcomes: [decision.summary, ...outcomes] };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error({ err: error, agent: record.slug }, 'autonomy runtime cycle failed');
    saveAgentState(buildCycleFailureState(state, record.slug, message));
    finishAutonomyRun(runId, [], message);
    return { runId, success: false, outcomes: [], error: message };
  }
}

/**
 * One-shot warning for the configured-but-inert case. Bounded to a single
 * emission per process so a 15s daemon tick cannot turn it into a log storm.
 */
let autonomyUnavailableWarned = false;
export function _testOnly_resetAutonomyUnavailableWarning(): void {
  autonomyUnavailableWarned = false;
}
/** Latch the one-shot. Exported so the once-only rule is testable without
 *  depending on the log transport. Returns true only on the first call. */
export function claimAutonomyUnavailableWarning(): boolean {
  if (autonomyUnavailableWarned) return false;
  autonomyUnavailableWarned = true;
  return true;
}
function warnAutonomyEngineUnavailableOnce(optIn: Set<string>): void {
  if (!claimAutonomyUnavailableWarning()) return;
  logger.warn(
    {
      optedInAgents: [...optIn].sort(),
      reason: 'selected_brain_runtime_unavailable',
      remedy: 'Pass the configured Clementine assistant runtime so autonomy follows the selected Claude, Codex, or BYO brain.',
    },
    'agent autonomy is configured but the selected brain runtime is unavailable — opted-in agents will not wake',
  );
}

/**
 * A raw OpenAI key may be configured only for voice/embeddings while the user
 * has selected Claude OAuth, Codex OAuth, or a BYO brain. Its mere presence is
 * not authority to reroute autonomous work (and billing) through OpenAI.
 */
export function shouldUseOpenAiSdkAutonomy(assistantPresent = false): boolean {
  if (assistantPresent) return false;
  if (!getOpenAiApiKey()) return false;
  if (getActiveAuthMode() !== 'api_key') return false;
  try {
    return resolveRoleModel('brain').provider === 'codex';
  } catch {
    return false;
  }
}

export async function processAgentAutonomyV2(assistant?: ClementineAssistant): Promise<AutonomyV2RunSummary> {
  const start = Date.now();
  const summary: AutonomyV2RunSummary = { attempted: 0, succeeded: 0, failed: 0, skipped: 0, durationMs: 0 };

  const optIn = readOptInSlugs();
  if (optIn.size === 0) {
    summary.durationMs = Date.now() - start;
    return summary;
  }

  // Engine selection. The SDK engine needs a raw OpenAI API key (a credential
  // this product otherwise uses only for voice/embeddings). Without one, run
  // cycles through the assistant's brain runtime instead — the same primitive
  // the execution controller and cron already use — so autonomy works on
  // Claude OAuth and Codex OAuth, the shipped defaults.
  if (!shouldUseOpenAiSdkAutonomy(Boolean(assistant))) {
    if (!assistant) {
      // No key AND no runtime handle: nothing can run. Say so once rather
      // than returning quietly every tick.
      warnAutonomyEngineUnavailableOnce(optIn);
      summary.durationMs = Date.now() - start;
      return summary;
    }
    const records = loadTeamAgents().filter((rec) => optIn.has(rec.slug) && rec.autonomyEnabled !== false);
    // Sequential on purpose: runtime turns are heavier than SDK cycles, and
    // serializing them keeps one slow agent from stacking brain-lane load.
    // AND at most ONE fired cycle per tick (v3.0.1 stampede family): after
    // downtime every agent's cadence is due at once, and N sequential brain
    // turns inside one awaited phase starve the daemon loop — workflow
    // scheduling, briefs, and the watchdog wait for the SUM of them. Holding
    // is free here: a held agent stamps nothing, stays due, and runs next
    // tick (~15s later) — a non-event against a 30-minute cadence.
    for (const rec of records) {
      const claimed = claimCycle(rec.slug, (signal) => (runtimeCycleImpl ?? runAgentCycleViaRuntime)(assistant, rec, signal));
      if (!claimed.started) {
        summary.attempted++;
        summary.skipped++;
        continue;
      }
      let firedBrainTurn = false;
      try {
        const result = await withTimeout(
          claimed.promise,
          RUNTIME_CYCLE_TIMEOUT_MS + 15_000,
          `agent ${rec.slug}`,
          claimed.abort,
        );
        summary.attempted++;
        if (!result.runId) summary.skipped++;
        else if (result.success) { summary.succeeded++; firedBrainTurn = true; }
        else { summary.failed++; firedBrainTurn = true; }
      } catch (err) {
        summary.attempted++;
        summary.failed++;
        firedBrainTurn = true; // a rejected cycle still consumed the tick's brain budget
        logger.warn({ err, agent: rec.slug }, 'autonomy runtime cycle rejected');
      }
      if (firedBrainTurn) break; // one real cycle per tick; the rest stay due
    }
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

  const claimedCycles = records.map((rec) => {
    const claimed = claimCycle(rec.slug, (signal) => runAgentCycleV2(rec, signal));
    if (!claimed.started) {
      return Promise.resolve({ kind: 'skipped_in_flight' as const });
    }
    return withTimeout(claimed.promise, PER_AGENT_TIMEOUT_MS, `agent ${rec.slug}`, claimed.abort)
      .then((result) => ({ kind: 'result' as const, result }));
  });
  const results = await Promise.allSettled(claimedCycles);

  for (const result of results) {
    summary.attempted++;
    if (result.status === 'fulfilled') {
      if (result.value.kind === 'skipped_in_flight') {
        summary.skipped++;
      } else if (!result.value.result.runId) {
        summary.skipped++;
      } else if (result.value.result.success) {
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
