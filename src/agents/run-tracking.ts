import {
  addRunEvent,
  createRunId,
  finishRun,
  getRun,
  listRuns,
  startRun,
  type RunRecord,
} from '../runtime/run-events.js';
import type { TeamAgentRecord } from '../tools/shared.js';

/**
 * Autonomy-side adapter over the runtime run-events tracking layer.
 *
 * The run-events module (src/runtime/run-events.ts) is the project's
 * unified observability store: any execution, regardless of origin (CLI
 * chat, webhook, discord, daemon autonomy), can record itself there and
 * be inspected via the dashboard or MCP tools.
 *
 * Today the user-facing surfaces (CLI, discord, webhook) write to it. The
 * autonomy loop in src/agents/autonomy.ts does NOT yet. This adapter
 * gives the loop a 5-line opt-in. It only touches a new file; no edits
 * to autonomy.ts are required to ship this module.
 *
 *
 * INTEGRATION POINT (recommended edit to runAgentCycle):
 * ------------------------------------------------------
 *
 *   import {
 *     startAutonomyRun,
 *     recordAutonomyResponse,
 *     recordAutonomyDecision,
 *     finishAutonomyRun,
 *   } from './run-tracking.js';
 *
 *   async function runAgentCycle(assistant, agent) {
 *     // ...existing setup
 *     if (wakeReasons.length === 0) return;
 *
 *     const runId = startAutonomyRun(agent, wakeReasons, inboxItems.length);
 *     try {
 *       const response = await assistant.respond({
 *         sessionId: `agent:${agent.slug}`,
 *         runId,                       // ← lets assistant.respond log model+tool events into the same run
 *         channel: 'agent',
 *         userId: agent.slug,
 *         model: agent.model ?? MODELS.fast,
 *         message: prompt,
 *       });
 *       recordAutonomyResponse(runId, response.text);
 *
 *       const decision = parseJsonObject(response.text);
 *       if (!decision) throw new Error(`Agent response was not valid JSON: ${response.text.slice(0, 240)}`);
 *       recordAutonomyDecision(runId, decision);
 *
 *       const outcomes = executeAgentActions(agent, decision);
 *       finishAutonomyRun(runId, outcomes);
 *
 *       // ...existing markInboxProcessed + saveAgentState + addNotification
 *     } catch (error) {
 *       finishAutonomyRun(runId, [], error instanceof Error ? error.message : String(error));
 *       // ...existing error handling
 *     }
 *   }
 *
 * With that in place, every autonomy cycle becomes a fully-inspectable
 * run: prompt, response preview, parsed decision (actions + commitments),
 * outcomes, duration, error if any. Both the existing dashboard runs
 * panel and the new agent_runs_recent / agent_run_get MCP tools surface
 * it immediately.
 */

const AUTONOMY_SESSION_PREFIX = 'agent:';
const AUTONOMY_CHANNEL = 'agent';
const MAX_TITLE_CHARS = 110;
const MAX_RESPONSE_PREVIEW_CHARS = 1200;

/** Build the canonical autonomy sessionId for a given agent slug. */
export function autonomySessionId(slug: string): string {
  return `${AUTONOMY_SESSION_PREFIX}${slug}`;
}

/** True when a run record was produced by the daemon autonomy loop. */
export function isAutonomyRun(run: RunRecord): boolean {
  return run.source === 'daemon' || (run.sessionId?.startsWith(AUTONOMY_SESSION_PREFIX) ?? false);
}

/** Extract the agent slug from an autonomy run, if present. */
export function autonomyRunSlug(run: RunRecord): string | undefined {
  if (!run.sessionId?.startsWith(AUTONOMY_SESSION_PREFIX)) return undefined;
  return run.sessionId.slice(AUTONOMY_SESSION_PREFIX.length);
}

export interface AutonomyRunStartInput {
  /** Pre-existing runId, if the caller already has one. Otherwise a fresh one is allocated. */
  id?: string;
  wakeReasons: string[];
  inboxCount: number;
}

/**
 * Open a new autonomy run. Returns the runId — pass it into
 * `assistant.respond({ runId })` so the model/tool events also land in
 * this run, and back into `record*` / `finishAutonomyRun` below.
 */
export function startAutonomyRun(agent: TeamAgentRecord, wakeReasons: string[], inboxCount: number, options: { id?: string } = {}): string {
  const id = options.id ?? createRunId();
  const titleParts = [`${agent.name} autonomy cycle`];
  if (wakeReasons.length > 0) titleParts.push(`(${wakeReasons.join(', ')})`);
  const title = titleParts.join(' ').slice(0, MAX_TITLE_CHARS);

  startRun({
    id,
    sessionId: autonomySessionId(agent.slug),
    userId: agent.slug,
    channel: AUTONOMY_CHANNEL,
    source: 'daemon',
    title,
    message: `wake_reasons=${wakeReasons.join(',') || 'none'}; inbox=${inboxCount}`,
  });

  // First event captures wake reasons + inbox depth so the dashboard
  // run timeline shows them at a glance.
  addRunEvent(id, {
    type: 'status',
    message: `Cycle starting. Wake: ${wakeReasons.join(', ') || 'none'}. Inbox depth: ${inboxCount}.`,
    data: {
      agentSlug: agent.slug,
      wakeReasons,
      inboxCount,
    },
  });

  return id;
}

/** Record the model's raw text response (truncated) into the run. */
export function recordAutonomyResponse(runId: string, responseText: string): void {
  addRunEvent(runId, {
    type: 'status',
    message: `Response received (${responseText.length} chars).`,
    data: {
      preview: responseText.slice(0, MAX_RESPONSE_PREVIEW_CHARS),
      charsTotal: responseText.length,
    },
  });
}

export interface AutonomyDecisionSummary {
  summary?: string;
  actions?: Array<{ type?: string; to?: string; reason?: string }>;
  commitments?: string[];
  followUpMinutes?: number;
}

/**
 * Record the parsed JSON decision (summary, actions, commitments) into
 * the run. Keeps the actions list shallow so the dashboard can render
 * the agent's plan without dumping the entire payload.
 */
export function recordAutonomyDecision(runId: string, decision: AutonomyDecisionSummary): void {
  const actionTypes = (decision.actions ?? []).map((action) => action.type ?? 'unknown');
  addRunEvent(runId, {
    type: 'status',
    message: `Decision parsed. Actions: ${actionTypes.join(', ') || 'none'}.`,
    data: {
      summary: decision.summary,
      actionTypes,
      commitments: decision.commitments ?? [],
      followUpMinutes: decision.followUpMinutes,
    },
  });
}

/**
 * Close out an autonomy cycle. Pass the executed outcomes (or an empty
 * list on parse failure) and an error message if anything threw.
 */
export function finishAutonomyRun(runId: string, outcomes: string[], error?: string): void {
  if (error) {
    finishRun(runId, {
      status: 'failed',
      message: error,
      error,
      outputPreview: outcomes.join(' | '),
    });
    return;
  }

  finishRun(runId, {
    status: 'completed',
    message: outcomes.length > 0 ? `Outcomes: ${outcomes.join(', ')}` : 'No actions taken.',
    outputPreview: outcomes.join(' | '),
  });
}

export interface AutonomyRunsFilter {
  slug?: string;
  limit?: number;
}

/**
 * List recent autonomy runs, optionally filtered to a single agent.
 * Pulls from the same store as `listRuns` so chat/webhook runs do not
 * pollute the result — we filter to daemon-source / agent-session runs.
 */
export function listAutonomyRuns(filter: AutonomyRunsFilter = {}): RunRecord[] {
  const limit = Math.max(1, filter.limit ?? 30);
  const wanted = filter.slug ? autonomySessionId(filter.slug) : undefined;

  return listRuns(200)
    .filter((run) => isAutonomyRun(run))
    .filter((run) => (wanted ? run.sessionId === wanted : true))
    .slice(0, limit);
}

/** Re-export so callers don't need two imports. */
export function getAutonomyRun(id: string): RunRecord | undefined {
  return getRun(id);
}
