/**
 * Workflow suggestions — the second watch on the heartbeat contract.
 *
 * It never reads a word the user typed. The signal is the host's own
 * receipt-verified record of what ran: a proven run strategy the brain
 * re-selected on several days (`proven_operation_selected` events in chat
 * sessions, joined to the run-strategy store). When the same work has been
 * done at least MIN_TURNS times on at least MIN_DISTINCT_DAYS days inside
 * the window, involves at least one real work tool (a connected-provider
 * operation or a local execution adapter, never a discovery or control
 * tool), and no saved workflow already uses those tools, the watch surfaces
 * ONE plan proposal: "save this as a workflow". The proposal rides the
 * existing plan-proposal card (approve / reject on desktop and mobile); an
 * approval runs the plan, whose single step is workflow_from_session on the
 * chat that last did the work — exact tools, exact args, creation test,
 * enabled on pass. A decline is remembered for DECLINE_COOLDOWN_DAYS.
 *
 * Deterministic, quiet by default: at most MAX_PENDING open suggestion, a
 * proposal expires after PENDING_EXPIRY_DAYS, and a quiet tick makes no
 * model call at all.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { BASE_DIR } from '../config.js';
import { listVerifiedRunStrategies, overlapScore, strategyKeywords, type RunStrategyRecord } from '../memory/run-strategy-store.js';
import { listWorkflows } from '../memory/workflow-store.js';
import { openEventLog } from '../runtime/harness/eventlog.js';
import { composioSlugLooksWellFormed } from '../integrations/composio/toolkit-slug.js';
import { TOOL_REGISTRY } from '../tools/tool-registry.js';
import { isQuietHoursActive, loadProactivityPolicy, saveProactivityPolicy } from './proactivity-policy.js';
import { getPlanProposal, surfacePlan } from './plan-proposals.js';
import { PlanSchema, type Plan } from './planner.js';

const logger = pino({ name: 'workflow-suggestions' });

export const WORKFLOW_SUGGESTIONS_WATCH_ID = 'workflow-suggestions';
export const SUGGESTION_WINDOW_DAYS = 30;
export const SUGGESTION_MIN_TURNS = 3;
export const SUGGESTION_MIN_DISTINCT_DAYS = 2;
export const SUGGESTION_RECENCY_DAYS = 14;
export const SUGGESTION_MAX_PENDING = 1;
export const SUGGESTION_PENDING_EXPIRY_DAYS = 14;
export const SUGGESTION_DECLINE_COOLDOWN_DAYS = 30;
const HEARTBEAT_MS = 60_000;
const FIRST_HEARTBEAT_DELAY_MS = 5 * 60_000;
const STATE_FILE = path.join(BASE_DIR, 'state', 'workflow-suggestions.json');
const DAY_MS = 86_400_000;

// ── evidence ─────────────────────────────────────────────────────────────────

/** One re-selection of a proven strategy by a chat turn. */
export interface RepeatObservation {
  strategyId: string;
  sessionId: string;
  sourceUserSeq: number;
  at: string;
}

export interface SuggestionCandidate {
  strategyId: string;
  objective: string;
  tools: string[];
  workTools: string[];
  turns: number;
  distinctDays: number;
  sessions: number;
  firstAt: string;
  lastAt: string;
  latestSessionId: string;
  latestSourceUserSeq: number;
}

export type WorkflowSuggestionStatus = 'pending' | 'approved' | 'declined' | 'expired';

export interface WorkflowSuggestionRecord {
  id: string;
  strategyId: string;
  objective: string;
  tools: string[];
  suggestedName: string;
  planProposalId: string;
  sessionId: string;
  status: WorkflowSuggestionStatus;
  createdAt: string;
  resolvedAt?: string;
  evidence: { turns: number; distinctDays: number; sessions: number; firstAt: string; lastAt: string };
}

export interface WorkflowSuggestionsFinding {
  tickId: string;
  at: string;
  source: string;
  durationMs: number;
  observations: number;
  candidates: number;
  covered: number;
  proposed: number;
  expired: number;
  quiet: boolean;
  summary: string;
}

export interface WorkflowSuggestionsState {
  version: 1;
  records: WorkflowSuggestionRecord[];
  metrics: { ticks: number; quietTicks: number; observations: number; candidates: number; covered: number; proposed: number; approved: number; declined: number; expired: number };
  lastTickAt?: string;
  lastFinding?: WorkflowSuggestionsFinding;
  lastError?: { at: string; reason: string };
}

export function emptyWorkflowSuggestionsState(): WorkflowSuggestionsState {
  return {
    version: 1,
    records: [],
    metrics: { ticks: 0, quietTicks: 0, observations: 0, candidates: 0, covered: 0, proposed: 0, approved: 0, declined: 0, expired: 0 },
  };
}

/** Read the re-selections of proven strategies by CHAT turns in the window.
 *  Workflow, watch and worker sessions re-select strategies too; those are
 *  the host repeating itself, not the user. */
export function collectRepeatObservations(now = new Date()): RepeatObservation[] {
  const since = new Date(now.getTime() - SUGGESTION_WINDOW_DAYS * DAY_MS).toISOString();
  const db = openEventLog();
  const rows = db.prepare(
    `SELECT e.session_id AS sessionId, e.created_at AS at,
            json_extract(e.data_json, '$.strategyId') AS strategyId,
            json_extract(e.data_json, '$.sourceUserSeq') AS sourceUserSeq
       FROM events e JOIN sessions s ON s.id = e.session_id
      WHERE e.type = 'proven_operation_selected' AND e.created_at > ? AND s.kind = 'chat'`,
  ).all(since) as Array<{ sessionId: string; at: string; strategyId: unknown; sourceUserSeq: unknown }>;
  return rows.flatMap((row) => (
    typeof row.strategyId === 'string' && row.strategyId && typeof row.sourceUserSeq === 'number'
      ? [{ strategyId: row.strategyId, sessionId: row.sessionId, sourceUserSeq: row.sourceUserSeq, at: row.at }]
      : []
  ));
}

/** What a saved workflow already covers: the tools it runs (call.tool and
 *  allowedTools, upper-cased) and the words it is about. */
export interface ExistingWorkflowCoverage {
  name: string;
  tools: Set<string>;
  keywords: string[];
}

export function existingWorkflowCoverage(): ExistingWorkflowCoverage[] {
  return listWorkflows().map((entry) => {
    const tools = new Set<string>();
    for (const step of entry.data.steps ?? []) {
      if (step.call?.tool) tools.add(step.call.tool.trim().toUpperCase());
      for (const tool of step.allowedTools ?? []) tools.add(tool.trim().toUpperCase());
    }
    return {
      name: entry.data.name,
      tools,
      keywords: strategyKeywords(`${entry.data.name} ${entry.data.description ?? ''} ${entry.data.goal?.objective ?? ''}`),
    };
  });
}

/** Coverage floor: the same relevance floor the strategy store uses to
 *  recall a proven shape for an objective. */
export const SUGGESTION_COVERAGE_OVERLAP = 0.34;

/** A saved workflow covers a routine when it runs every work tool the
 *  routine uses AND is about the same thing. Sharing one tool is not
 *  coverage: a morning briefing that reads the calendar does not make
 *  "what's on my calendar tomorrow" automated. */
export function workflowCovers(workflow: ExistingWorkflowCoverage, workTools: readonly string[], objectiveKeywords: readonly string[]): boolean {
  if (!workTools.every((tool) => workflow.tools.has(tool.trim().toUpperCase()))) return false;
  return overlapScore(objectiveKeywords, workflow.keywords) >= SUGGESTION_COVERAGE_OVERLAP;
}

/** A tool that does work worth saving: a connected-provider operation or a
 *  local execution adapter. Discovery, planning, memory and control tools are
 *  how the brain gets there, not what the user keeps asking for. */
export function isWorkTool(tool: string): boolean {
  const name = tool.trim();
  if (!name) return false;
  const decl = TOOL_REGISTRY.find((entry) => entry.name === name);
  if (decl) {
    if (decl.actionTopologyRole === 'control') return false;
    return decl.localExecution !== undefined;
  }
  return composioSlugLooksWellFormed(name.toUpperCase());
}

export function deriveSuggestionCandidates(input: {
  strategies: readonly Pick<RunStrategyRecord, 'id' | 'objective' | 'toolsUsed'>[];
  observations: readonly RepeatObservation[];
  existingWorkflows: readonly ExistingWorkflowCoverage[];
  isWorkTool?: (tool: string) => boolean;
  now?: Date;
}): { candidates: SuggestionCandidate[]; covered: number } {
  const now = input.now ?? new Date();
  const workTool = input.isWorkTool ?? isWorkTool;
  const windowStart = now.getTime() - SUGGESTION_WINDOW_DAYS * DAY_MS;
  const recencyStart = now.getTime() - SUGGESTION_RECENCY_DAYS * DAY_MS;
  const byStrategy = new Map<string, RepeatObservation[]>();
  for (const row of input.observations) {
    const at = Date.parse(row.at);
    if (!Number.isFinite(at) || at < windowStart) continue;
    const list = byStrategy.get(row.strategyId) ?? [];
    list.push(row);
    byStrategy.set(row.strategyId, list);
  }
  const candidates: SuggestionCandidate[] = [];
  let covered = 0;
  for (const strategy of input.strategies) {
    const rows = byStrategy.get(strategy.id);
    if (!rows || rows.length < SUGGESTION_MIN_TURNS) continue;
    const days = new Set(rows.map((row) => row.at.slice(0, 10)));
    if (days.size < SUGGESTION_MIN_DISTINCT_DAYS) continue;
    const sorted = [...rows].sort((a, b) => a.at.localeCompare(b.at));
    const last = sorted[sorted.length - 1];
    if (Date.parse(last.at) < recencyStart) continue;
    const workTools = strategy.toolsUsed.filter(workTool);
    if (workTools.length === 0) continue;
    const objectiveKeywords = strategyKeywords(strategy.objective);
    if (input.existingWorkflows.some((workflow) => workflowCovers(workflow, workTools, objectiveKeywords))) { covered += 1; continue; }
    candidates.push({
      strategyId: strategy.id,
      objective: strategy.objective,
      tools: [...strategy.toolsUsed],
      workTools,
      turns: rows.length,
      distinctDays: days.size,
      sessions: new Set(rows.map((row) => row.sessionId)).size,
      firstAt: sorted[0].at,
      lastAt: last.at,
      latestSessionId: last.sessionId,
      latestSourceUserSeq: last.sourceUserSeq,
    });
  }
  candidates.sort((a, b) => b.turns - a.turns || b.lastAt.localeCompare(a.lastAt));
  return { candidates, covered };
}

/** A workflow name from the objective: the user's own words, trimmed to a
 *  title, never invented. */
export function suggestedWorkflowName(objective: string): string {
  const words = objective.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  let out = '';
  for (const word of words) {
    const next = out ? `${out} ${word}` : word;
    if (next.length > 48) break;
    out = next;
  }
  const base = out || words.slice(0, 6).join(' ') || 'Saved routine';
  return base.charAt(0).toUpperCase() + base.slice(1).replace(/[?.!]+$/, '');
}

export function buildSuggestionPlan(candidate: SuggestionCandidate, name: string): Plan {
  const tools = candidate.workTools.join(', ');
  return PlanSchema.parse({
    objective: `Save "${candidate.objective}" as a reusable workflow named "${name}", built from the exact tools that chat already used (${tools}).`,
    steps: [
      {
        n: 1,
        action: `Call workflow_from_session with name "${name}" and sessionId "${candidate.latestSessionId}" to reconstruct the steps from that chat's proven tool calls (${tools}). Keep it manual-only; do not add a schedule unless the user asks for one.`,
        rationale: `The same request ran ${candidate.turns} times on ${candidate.distinctDays} days. A saved workflow makes it one tap, or a schedule, instead of a fresh conversation each time.`,
        verification: 'The workflow exists, its creation test passed, it is enabled, and the reply names the workflow and how to run or schedule it.',
      },
    ],
    successCriteria: [
      `Workflow "${name}" is saved and enabled after a passing creation test`,
      'The user is told how to run it and how to put it on a schedule',
    ],
    stages: null,
    risks: [],
    estimatedComplexity: 'trivial',
    recommendsTrackedExecution: false,
    needsUserInput: [],
    voiceMessage: null,
    appliedInstructions: [],
    externalSends: null,
  });
}

// ── state ────────────────────────────────────────────────────────────────────

export function loadWorkflowSuggestionsState(): WorkflowSuggestionsState {
  try {
    if (!existsSync(STATE_FILE)) return emptyWorkflowSuggestionsState();
    const raw = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as Partial<WorkflowSuggestionsState>;
    if (!raw || raw.version !== 1 || !Array.isArray(raw.records)) return emptyWorkflowSuggestionsState();
    return { ...emptyWorkflowSuggestionsState(), ...raw, metrics: { ...emptyWorkflowSuggestionsState().metrics, ...(raw.metrics ?? {}) } };
  } catch {
    return emptyWorkflowSuggestionsState();
  }
}

export function saveWorkflowSuggestionsState(state: WorkflowSuggestionsState): void {
  mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, STATE_FILE);
}

// ── policy ───────────────────────────────────────────────────────────────────

export interface WorkflowSuggestionsPolicyView { enabled: boolean; cadenceMinutes: number; quietHoursActive: boolean }

/** Its own switch: the watch only reads the host's own records and asks. */
export function workflowSuggestionsPolicy(): WorkflowSuggestionsPolicyView {
  const policy = loadProactivityPolicy();
  return {
    enabled: policy.workflowSuggestionsEnabled,
    cadenceMinutes: policy.workflowSuggestionsMinutes,
    quietHoursActive: isQuietHoursActive(policy),
  };
}

export function setWorkflowSuggestionsPolicy(patch: { enabled?: boolean; cadenceMinutes?: number }): WorkflowSuggestionsPolicyView {
  saveProactivityPolicy({
    ...(patch.enabled !== undefined ? { workflowSuggestionsEnabled: patch.enabled } : {}),
    ...(patch.cadenceMinutes !== undefined ? { workflowSuggestionsMinutes: patch.cadenceMinutes } : {}),
  });
  return workflowSuggestionsPolicy();
}

// ── tick ─────────────────────────────────────────────────────────────────────

export interface WorkflowSuggestionsDeps {
  now: () => Date;
  policy: () => WorkflowSuggestionsPolicyView;
  observations: (now: Date) => RepeatObservation[];
  strategies: () => Pick<RunStrategyRecord, 'id' | 'objective' | 'toolsUsed'>[];
  existingWorkflows: () => ExistingWorkflowCoverage[];
  isWorkTool: (tool: string) => boolean;
  /** Surface the proposal card; returns the plan proposal id. */
  surface: (candidate: SuggestionCandidate, name: string) => string;
  /** The card's current decision, from the plan-proposal store. */
  proposalStatus: (planProposalId: string) => 'pending' | 'approved' | 'rejected' | 'missing';
  loadState: () => WorkflowSuggestionsState;
  saveState: (state: WorkflowSuggestionsState) => void;
}

export function productionWorkflowSuggestionsDeps(): WorkflowSuggestionsDeps {
  return {
    now: () => new Date(),
    policy: workflowSuggestionsPolicy,
    observations: collectRepeatObservations,
    // Only what the user asked for in chat; a strategy learned inside a
    // workflow step is the host repeating itself.
    strategies: () => listVerifiedRunStrategies().filter((strategy) => (strategy.scope ?? 'chat') === 'chat'),
    existingWorkflows: existingWorkflowCoverage,
    isWorkTool,
    surface: (candidate, name) => surfacePlan({
      plan: buildSuggestionPlan(candidate, name),
      originatingRequest: `Workflow suggestion: you asked for "${candidate.objective}" ${candidate.turns} times over ${candidate.distinctDays} days. Save it as a workflow you can run or schedule?`,
      proposedByAgent: 'workflow-suggestions',
      sessionId: candidate.latestSessionId,
      context: `Evidence: proven strategy ${candidate.strategyId}, ${candidate.turns} turns across ${candidate.sessions} chats, ${candidate.firstAt.slice(0, 10)} → ${candidate.lastAt.slice(0, 10)}, tools ${candidate.workTools.join(', ')}.`,
    }).id,
    proposalStatus: (id) => {
      const proposal = getPlanProposal(id);
      if (!proposal) return 'missing';
      if (proposal.status === 'pending') return 'pending';
      if (proposal.status === 'rejected') return 'rejected';
      return 'approved';
    },
    loadState: loadWorkflowSuggestionsState,
    saveState: saveWorkflowSuggestionsState,
  };
}

export interface WorkflowSuggestionsTickResult extends WorkflowSuggestionsFinding {
  skipped?: 'disabled' | 'quiet_hours' | 'in_flight';
  proposedRecord?: WorkflowSuggestionRecord;
}

export function processWorkflowSuggestionsTick(
  deps: WorkflowSuggestionsDeps,
  opts: { source: 'heartbeat' | 'manual' | 'boot'; force?: boolean },
): WorkflowSuggestionsTickResult {
  const started = deps.now();
  const at = started.toISOString();
  const tickId = `ws-${started.getTime().toString(36)}`;
  const state = deps.loadState();
  const finding = (partial: Partial<WorkflowSuggestionsFinding> & { summary: string }): WorkflowSuggestionsTickResult => ({
    tickId, at, source: opts.source, durationMs: deps.now().getTime() - started.getTime(),
    observations: 0, candidates: 0, covered: 0, proposed: 0, expired: 0, quiet: true, ...partial,
  });

  // Reconcile what the owner decided on the cards since the last tick, and
  // retire proposals nobody answered.
  let expired = 0;
  for (const record of state.records) {
    if (record.status !== 'pending') continue;
    const status = deps.proposalStatus(record.planProposalId);
    if (status === 'approved') { record.status = 'approved'; record.resolvedAt = at; state.metrics.approved += 1; continue; }
    if (status === 'rejected') { record.status = 'declined'; record.resolvedAt = at; state.metrics.declined += 1; continue; }
    const age = started.getTime() - Date.parse(record.createdAt);
    if (status === 'missing' || age > SUGGESTION_PENDING_EXPIRY_DAYS * DAY_MS) {
      record.status = 'expired'; record.resolvedAt = at; state.metrics.expired += 1; expired += 1;
    }
  }

  const policy = deps.policy();
  if (!policy.enabled && !opts.force) {
    deps.saveState(state);
    return { ...finding({ expired, summary: 'Workflow suggestions are off.' }), skipped: 'disabled' };
  }
  if (policy.quietHoursActive && !opts.force) {
    deps.saveState(state);
    return { ...finding({ expired, summary: 'Quiet hours; no suggestion raised.' }), skipped: 'quiet_hours' };
  }

  const observations = deps.observations(started);
  const { candidates, covered } = deriveSuggestionCandidates({
    strategies: deps.strategies(),
    observations,
    existingWorkflows: deps.existingWorkflows(),
    isWorkTool: deps.isWorkTool,
    now: started,
  });
  const cooldownStart = started.getTime() - SUGGESTION_DECLINE_COOLDOWN_DAYS * DAY_MS;
  const blocked = new Set(state.records
    .filter((record) => record.status === 'pending' || record.status === 'approved'
      || ((record.status === 'declined' || record.status === 'expired') && Date.parse(record.resolvedAt ?? record.createdAt) > cooldownStart))
    .map((record) => record.strategyId));
  const eligible = candidates.filter((candidate) => !blocked.has(candidate.strategyId));
  const pending = state.records.filter((record) => record.status === 'pending').length;

  state.metrics.ticks += 1;
  state.metrics.observations += observations.length;
  state.metrics.candidates += eligible.length;
  state.metrics.covered += covered;
  state.lastTickAt = at;

  let proposedRecord: WorkflowSuggestionRecord | undefined;
  if (eligible.length > 0 && pending < SUGGESTION_MAX_PENDING) {
    const candidate = eligible[0];
    const name = suggestedWorkflowName(candidate.objective);
    const planProposalId = deps.surface(candidate, name);
    proposedRecord = {
      id: `wsug-${started.getTime().toString(36)}-${candidate.strategyId.slice(-6)}`,
      strategyId: candidate.strategyId,
      objective: candidate.objective,
      tools: candidate.workTools,
      suggestedName: name,
      planProposalId,
      sessionId: candidate.latestSessionId,
      status: 'pending',
      createdAt: at,
      evidence: { turns: candidate.turns, distinctDays: candidate.distinctDays, sessions: candidate.sessions, firstAt: candidate.firstAt, lastAt: candidate.lastAt },
    };
    state.records.push(proposedRecord);
    state.metrics.proposed += 1;
  } else {
    state.metrics.quietTicks += 1;
  }
  if (state.records.length > 60) state.records = state.records.slice(-60);

  const summary = proposedRecord
    ? `Suggested saving "${proposedRecord.objective}" as a workflow (${proposedRecord.evidence.turns} times on ${proposedRecord.evidence.distinctDays} days).`
    : eligible.length > 0
      ? `${eligible.length} repeat${eligible.length === 1 ? '' : 's'} noticed; a suggestion is already waiting for your answer.`
      : `Nothing repeated enough to suggest (${observations.length} proven turns in ${SUGGESTION_WINDOW_DAYS} days${covered > 0 ? `, ${covered} already covered by a saved workflow` : ''}).`;
  const result: WorkflowSuggestionsTickResult = {
    ...finding({ observations: observations.length, candidates: eligible.length, covered, proposed: proposedRecord ? 1 : 0, expired, quiet: !proposedRecord, summary }),
    ...(proposedRecord ? { proposedRecord } : {}),
  };
  const { skipped: _skipped, proposedRecord: _record, ...persisted } = result;
  state.lastFinding = persisted;
  deps.saveState(state);
  return result;
}

// ── runtime ──────────────────────────────────────────────────────────────────

let inFlight: Promise<WorkflowSuggestionsTickResult> | null = null;

export async function runWorkflowSuggestionsTick(
  opts: { source: 'heartbeat' | 'manual' | 'boot'; force?: boolean },
  deps: WorkflowSuggestionsDeps = productionWorkflowSuggestionsDeps(),
): Promise<WorkflowSuggestionsTickResult> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      return processWorkflowSuggestionsTick(deps, opts);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      try {
        const state = deps.loadState();
        state.lastError = { at: deps.now().toISOString(), reason };
        deps.saveState(state);
      } catch { /* the error is already the finding */ }
      logger.warn({ err: reason }, 'workflow suggestions tick failed');
      const at = deps.now().toISOString();
      return { tickId: `ws-failed-${Date.now().toString(36)}`, at, source: opts.source, durationMs: 0, observations: 0, candidates: 0, covered: 0, proposed: 0, expired: 0, quiet: true, summary: `Tick failed: ${reason}` };
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

export function isWorkflowSuggestionsDue(now = new Date()): { due: boolean; reason: 'disabled' | 'quiet_hours' | 'never_ran' | 'interval_elapsed' | 'not_yet'; nextAt?: string } {
  const policy = workflowSuggestionsPolicy();
  if (!policy.enabled) return { due: false, reason: 'disabled' };
  if (policy.quietHoursActive) return { due: false, reason: 'quiet_hours' };
  const state = loadWorkflowSuggestionsState();
  if (!state.lastTickAt) return { due: true, reason: 'never_ran' };
  const nextAt = Date.parse(state.lastTickAt) + policy.cadenceMinutes * 60_000;
  return now.getTime() >= nextAt
    ? { due: true, reason: 'interval_elapsed', nextAt: new Date(nextAt).toISOString() }
    : { due: false, reason: 'not_yet', nextAt: new Date(nextAt).toISOString() };
}

let heartbeat: { first: NodeJS.Timeout; interval: NodeJS.Timeout } | null = null;

export function startWorkflowSuggestionsHeartbeat(): () => void {
  if (heartbeat) return stopWorkflowSuggestionsHeartbeat;
  const beat = () => {
    if (!isWorkflowSuggestionsDue().due) return;
    void runWorkflowSuggestionsTick({ source: 'heartbeat' });
  };
  const first = setTimeout(beat, FIRST_HEARTBEAT_DELAY_MS);
  const interval = setInterval(beat, HEARTBEAT_MS);
  first.unref();
  interval.unref();
  heartbeat = { first, interval };
  return stopWorkflowSuggestionsHeartbeat;
}

export function stopWorkflowSuggestionsHeartbeat(): void {
  if (!heartbeat) return;
  clearTimeout(heartbeat.first);
  clearInterval(heartbeat.interval);
  heartbeat = null;
}

// ── status (the Watches card) ────────────────────────────────────────────────

export interface WorkflowSuggestionsWatchStatus {
  id: typeof WORKFLOW_SUGGESTIONS_WATCH_ID;
  title: string;
  purpose: string;
  enabled: boolean;
  cadenceMinutes: number;
  quietHoursActive: boolean;
  connectedOperations: string[];
  running: boolean;
  lastTickAt?: string;
  nextTickAt?: string;
  lastFinding?: {
    tickId: string; at: string; source: string; durationMs: number;
    accounts: number; events: number; changes: number; produced: number; vetoed: number; retired: number;
    quiet: boolean; readFailures: number; summary: string;
  };
  lastError?: { at: string; reason: string };
  metrics: {
    ticks: number; quietTicks: number; changedTicks: number; reads: number; readFailures: number;
    modelCalls: number; modelVetoes: number; modelFailures: number;
    itemsProduced: number; itemsAcknowledged: number; itemsRetired: number; duplicatesSuppressed: number;
  };
  openItems: Array<{ key: string; kind: 'suggestion'; signal: 'low'; subject: string; eventStartMs: number; eventEndMs: number; notificationId?: string; createdAt: string; acknowledgedAt?: string; retiredAt?: string; retiredReason?: string }>;
  recentlyRetired: Array<{ key: string; kind: 'suggestion'; signal: 'low'; subject: string; eventStartMs: number; eventEndMs: number; createdAt: string; retiredAt?: string; retiredReason?: string }>;
}

export function workflowSuggestionsStatus(now = new Date()): WorkflowSuggestionsWatchStatus {
  const policy = workflowSuggestionsPolicy();
  const state = loadWorkflowSuggestionsState();
  const due = isWorkflowSuggestionsDue(now);
  const item = (record: WorkflowSuggestionRecord) => ({
    key: record.id,
    kind: 'suggestion' as const,
    signal: 'low' as const,
    subject: `Save "${record.objective}" as the workflow "${record.suggestedName}" (${record.evidence.turns}× on ${record.evidence.distinctDays} days)`,
    eventStartMs: Date.parse(record.createdAt),
    eventEndMs: Date.parse(record.createdAt) + SUGGESTION_PENDING_EXPIRY_DAYS * DAY_MS,
    createdAt: record.createdAt,
    ...(record.resolvedAt ? { retiredAt: record.resolvedAt, retiredReason: record.status } : {}),
  });
  return {
    id: WORKFLOW_SUGGESTIONS_WATCH_ID,
    title: 'Workflow suggestions',
    purpose: 'Notices a request you keep making and offers to save it as a workflow you can run or schedule. Reads only the host\'s own record of what ran; never your words.',
    enabled: policy.enabled,
    cadenceMinutes: policy.cadenceMinutes,
    quietHoursActive: policy.quietHoursActive,
    connectedOperations: ['proven_operation_selected'],
    running: inFlight !== null,
    ...(state.lastTickAt ? { lastTickAt: state.lastTickAt } : {}),
    ...(due.nextAt ? { nextTickAt: due.nextAt } : {}),
    ...(state.lastFinding ? {
      lastFinding: {
        tickId: state.lastFinding.tickId, at: state.lastFinding.at, source: state.lastFinding.source, durationMs: state.lastFinding.durationMs,
        accounts: 0, events: state.lastFinding.observations, changes: state.lastFinding.candidates, produced: state.lastFinding.proposed,
        vetoed: 0, retired: state.lastFinding.expired, quiet: state.lastFinding.quiet, readFailures: 0, summary: state.lastFinding.summary,
      },
    } : {}),
    ...(state.lastError ? { lastError: state.lastError } : {}),
    metrics: {
      ticks: state.metrics.ticks, quietTicks: state.metrics.quietTicks, changedTicks: state.metrics.proposed,
      reads: state.metrics.observations, readFailures: 0, modelCalls: 0, modelVetoes: 0, modelFailures: 0,
      itemsProduced: state.metrics.proposed, itemsAcknowledged: state.metrics.approved + state.metrics.declined,
      itemsRetired: state.metrics.expired, duplicatesSuppressed: state.metrics.covered,
    },
    openItems: state.records.filter((record) => record.status === 'pending').map(item),
    recentlyRetired: state.records.filter((record) => record.status !== 'pending').slice(-5).map(item),
  };
}
