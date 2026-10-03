import { existsSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { canonicalCacheAccounting, type UsageEvent } from '../src/runtime/usage-log.js';
import { projectCanonicalTopLevelToolEvents } from '../src/runtime/harness/tool-effect.js';
import { presentationEventFromCompletionData } from '../src/runtime/harness/turn-outcome.js';
import { readApprovalExecutionSource } from '../src/runtime/harness/approval-execution-source.js';

/**
 * Read-only accounting for one dedicated harness session.
 *
 * This intentionally opens harness.db with SQLite's readonly option and reads
 * token usage directly from NDJSON. It does not import/open the migrating
 * eventlog singleton, so running a measurement can never create a store,
 * advance a schema, append telemetry, or otherwise perturb the sample.
 */

interface RawEventRow {
  seq: number;
  turn: number;
  role: string;
  type: string;
  data_json: string;
  created_at: string;
}

interface SessionEvent {
  seq: number;
  turn: number;
  role: string;
  type: string;
  data: Record<string, unknown>;
  createdAt: string;
}

export interface SessionMeasurement {
  sessionId: string;
  acceptedTurns: number;
  canonicalTopLevelToolCalls: number;
  explicitTopLevelToolCalls: number;
  nestedBatchToolCalls: number;
  toolCalledRows: number;
  toolReturnedRows: number;
  toolLifecycleEvents: number;
  transportMirrorCalls: number;
  transportMirrorEvents: number;
  discoveryOperations: number;
  schemaMetadataRefreshes: number;
  topLevelToolSearches: number;
  /** Wall time spent inside top-level tool_search calls (call → return). */
  toolSearchMs: number;
  composioSearchDispatches: number;
  perTool: Record<string, number>;
  usageRecords: number;
  usageRecordsByModel: Record<string, number>;
  promptTokens: number;
  cachedInputTokens: number;
  uncachedInputTokens: number;
  outputTokens: number;
  uncertifiedUsageCalls: number;
  invalidUsageCalls: number;
  sdkDurationMs: number;
  providerDurationMs: number;
  turnWallMs: number | null;
  wallStartType: 'user_input_received' | 'turn_started' | null;
  terminalType: string | null;
  malformedEventPayloads: number;
  malformedUsageLines: number;
}

export interface SessionComparison {
  home: string;
  baseline: SessionMeasurement;
  candidate: SessionMeasurement;
}

export interface SessionComparisonArgs {
  baseline: string;
  candidate: string;
  home: string;
}

export type TurnUsageAttribution = 'exact' | 'mixed' | 'legacy_window' | 'none';

export interface AcceptedTurnMeasurement extends SessionMeasurement {
  sourceUserSeq: number;
  acceptedSource: string;
  terminalSeq: number;
  terminalTransport: string | null;
  terminalStatus: string | null;
  terminalSteps: number | null;
  modelRouteEvents: number;
  exactModelRouteEvents: number;
  legacyWindowModelRouteEvents: number;
  exactUsageRecords: number;
  legacyWindowUsageRecords: number;
  unscopedWindowUsageRecords: number;
  invalidUsageAttributions: number;
  usageAttribution: TurnUsageAttribution;
  /** Exact trace rows, or a proved zero-model turn. Legacy windows stay visible
   *  but can never be presented as certified per-turn cost. */
  usageAttributionCertified: boolean;
  usageCertificationIssues: string[];
  governorKnownCapability: boolean | null;
  discoveryClaimsByCategory: Record<string, number>;
  discoveryClaimsByOutcome: Record<string, number>;
  /** First-run-correctness facts (scripts/proof/first-run.ts consumes these).
   *  run_attempts was already read for usage bounding; these expose the
   *  counts it used to discard. */
  attemptCount: number;
  unfinishedAttempts: number;
  awaitingUserInputEvents: number;
  supersededEvents: number;
  restartRecoveryEvents: number;
}

export interface AcceptedTurnComparison {
  home: string;
  baseline: AcceptedTurnMeasurement;
  candidate: AcceptedTurnMeasurement;
}

export interface AcceptedTurnComparisonArgs {
  baselineSession: string;
  baselineSource: number;
  candidateSession: string;
  candidateSource: number;
  home: string;
}

export interface ApprovalContinuationMeasurement {
  approvalId: string;
  controlSourceUserSeq: number;
  executionSourceUserSeq: number;
  resumeEventSeqs: number[];
  requestedAt: string | null;
  resolvedAt: string | null;
}

export interface AcceptedTaskMeasurement extends SessionMeasurement {
  scope: 'task';
  rootSourceUserSeq: number;
  acceptedSource: string;
  sourceUserSeqs: number[];
  approvalContinuations: ApprovalContinuationMeasurement[];
  lineageIssues: string[];
  exactUsageRecords: number;
  /** Exact-looking rows whose attempt/lineage cannot be proved. Kept visible,
   * never silently folded into either proven totals or zero-cost claims. */
  unprovenUsage: Pick<SessionMeasurement,
    'usageRecords' | 'promptTokens' | 'cachedInputTokens' | 'uncachedInputTokens' | 'outputTokens'>;
  legacyWindowUsageRecords: number;
  unscopedWindowUsageRecords: number;
  usageAttributionCertified: boolean;
  usageCertificationIssues: string[];
  modelRouteEvents: number;
  attemptCount: number;
  unfinishedAttempts: number;
  terminalSeq: number | null;
  terminalStatus: string | null;
  /** Root acceptance to the last linked delivery; includes approval waits.
   * Null when a linked segment has no proved terminal. */
  taskWallMs: number | null;
  /** Union of accepted-input → terminal/attempt-closeout spans, not CPU time. */
  segmentWallMs: number | null;
  /** Union of durable card requested_at → resolved_at spans, clipped to the
   * task wall. Includes delivery/decision time, not a claim of human CPU time. */
  recordedApprovalWaitMs: number | null;
  approvalWaitIssues: string[];
}

export interface AcceptedTaskComparison {
  home: string;
  baseline: AcceptedTaskMeasurement;
  candidate: AcceptedTaskMeasurement;
}

export type MeasurementComparisonArgs = AcceptedTurnComparisonArgs & { scope?: 'turn' | 'task' };

function finiteNonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function parseObject(value: unknown): Record<string, unknown> | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return null;
    try { return parseObject(JSON.parse(trimmed)); } catch { return null; }
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function unwrapCallToolArgs(data: Record<string, unknown>): Record<string, unknown> {
  const raw = parseObject(data.arguments) ?? parseObject(data.args) ?? parseObject(data.input) ?? {};
  const argsJson = parseObject(raw.args_json);
  if (argsJson) return argsJson;
  // Only unwrap ordinary args/arguments when this is visibly a call_tool
  // envelope. A Composio request itself legitimately has both tool_slug and
  // an `arguments` object; unwrapping that object would discard the slug.
  if (typeof raw.name === 'string') {
    return parseObject(raw.arguments) ?? parseObject(raw.args) ?? raw;
  }
  return raw;
}

function composioSlug(data: Record<string, unknown>): string | null {
  const args = unwrapCallToolArgs(data);
  const value = args.tool_slug ?? args.toolSlug ?? data.toolSlug ?? data.tool_slug;
  if (typeof value === 'string' && value.trim()) return value.trim();
  // Batch telemetry intentionally clips argument JSON. The slug is first and
  // remains recoverable even when the trailing payload is no longer parseable.
  for (const raw of [data.arguments, data.args, data.input]) {
    if (typeof raw !== 'string') continue;
    const match = raw.match(/["']tool_slug["']\s*:\s*["']([^"']+)["']/i);
    if (match?.[1]) return match[1].trim();
  }
  return null;
}

function semanticToolName(data: Record<string, unknown>): string {
  const effective = typeof data.effectiveTool === 'string' ? data.effectiveTool.trim() : '';
  const stored = typeof data.tool === 'string' ? data.tool.trim() : '';
  if (effective && effective !== 'composio_execute_tool') return effective;
  if (effective === 'composio_execute_tool' || stored === 'composio_execute_tool') {
    return composioSlug(data) || effective || stored;
  }
  return effective || stored || '(unknown)';
}

function stableValue(value: unknown): unknown {
  if (typeof value === 'string') return value.trim().toLowerCase();
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const child = (value as Record<string, unknown>)[key];
    if (child !== null && child !== undefined) out[key] = stableValue(child);
  }
  return out;
}

function composioSearchSignature(data: Record<string, unknown>): string {
  const args = unwrapCallToolArgs(data);
  const signature = {
    query: args.query ?? '',
    toolkit_slug: args.toolkit_slug ?? args.toolkitSlug ?? '',
  };
  return JSON.stringify(stableValue(signature));
}

function increment(map: Record<string, number>, key: string, amount = 1): void {
  map[key] = (map[key] ?? 0) + amount;
}

function actualComposioSearchDispatches(
  canonicalCalls: readonly SessionEvent[],
  mirrorCalls: readonly SessionEvent[],
): number {
  const canonicalBySignature: Record<string, number> = {};
  const mirrorBySignature: Record<string, number> = {};
  for (const event of canonicalCalls) {
    if (semanticToolName(event.data) === 'composio_search_tools') {
      increment(canonicalBySignature, composioSearchSignature(event.data));
    }
  }
  for (const event of mirrorCalls) {
    if (event.data.tool === 'composio_search_tools') {
      increment(mirrorBySignature, composioSearchSignature(event.data));
    }
  }

  // A provider-level call_tool and its inner MCP audit row describe one
  // dispatch. Count the larger occurrence count for each normalized request:
  // mirrors are physical dispatch evidence, while the canonical row is the
  // fallback if old/crashed telemetry omitted its mirror.
  const signatures = new Set([...Object.keys(canonicalBySignature), ...Object.keys(mirrorBySignature)]);
  let total = 0;
  for (const signature of signatures) {
    total += Math.max(canonicalBySignature[signature] ?? 0, mirrorBySignature[signature] ?? 0);
  }
  return total;
}

function readSessionEvents(dbPath: string, sessionId: string): {
  events: SessionEvent[];
  malformedEventPayloads: number;
} {
  if (!existsSync(dbPath)) throw new Error(`Harness event log not found: ${dbPath}`);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 5_000 });
  try {
    db.pragma('query_only = ON');
    const rows = db.prepare(
      `SELECT seq, turn, role, type, data_json, created_at
         FROM events
        WHERE session_id = ?
        ORDER BY seq ASC`,
    ).all(sessionId) as RawEventRow[];
    if (rows.length === 0) throw new Error(`No harness events found for session ${sessionId}`);

    let malformedEventPayloads = 0;
    const events = rows.map((row): SessionEvent => {
      let data: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(row.data_json) as unknown;
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          data = parsed as Record<string, unknown>;
        } else {
          malformedEventPayloads += 1;
        }
      } catch {
        malformedEventPayloads += 1;
      }
      return {
        seq: row.seq,
        turn: row.turn,
        role: row.role,
        type: row.type,
        data,
        createdAt: row.created_at,
      };
    });
    return { events, malformedEventPayloads };
  } finally {
    db.close();
  }
}

function readUsageEvents(usageDir: string): { events: UsageEvent[]; malformedUsageLines: number } {
  if (!existsSync(usageDir)) return { events: [], malformedUsageLines: 0 };
  const files = readdirSync(usageDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ndjson'))
    .map((entry) => path.join(usageDir, entry.name))
    .sort();
  const events: UsageEvent[] = [];
  let malformedUsageLines = 0;
  for (const file of files) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line) as unknown;
        if (
          parsed !== null
          && typeof parsed === 'object'
          && !Array.isArray(parsed)
          && typeof (parsed as { source?: unknown }).source === 'string'
        ) {
          events.push(parsed as UsageEvent);
        } else {
          malformedUsageLines += 1;
        }
      } catch {
        malformedUsageLines += 1;
      }
    }
  }
  return { events, malformedUsageLines };
}

interface AttemptRead {
  ids: Set<string>;
  closeoutAt: string | null;
  unfinished: number;
}

function readAttemptsForSource(
  dbPath: string,
  sessionId: string,
  sourceUserSeq: number,
): AttemptRead {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 5_000 });
  try {
    db.pragma('query_only = ON');
    const rows = db.prepare(
      `SELECT attempt_id, finished_at
         FROM run_attempts
        WHERE session_id = ?
          AND source_user_seq = ?
        ORDER BY started_at ASC`,
    ).all(sessionId, sourceUserSeq) as Array<{ attempt_id: string; finished_at: string | null }>;
    const finished = rows
      .map((row) => row.finished_at)
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .sort();
    return {
      ids: new Set(rows.map((row) => row.attempt_id)),
      closeoutAt: finished.at(-1) ?? null,
      unfinished: rows.filter((row) => !row.finished_at).length,
    };
  } catch {
    // Pre-attempt fixtures and old read-only homes still measure through the
    // owned terminal; measurement must never migrate them just to add a bound.
    return { ids: new Set(), closeoutAt: null, unfinished: 0 };
  } finally {
    db.close();
  }
}

function readDiscoveryForSource(
  dbPath: string,
  sessionId: string,
  sourceUserSeq: number,
): {
  knownCapability: boolean | null;
  byCategory: Record<string, number>;
  byOutcome: Record<string, number>;
} {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 5_000 });
  try {
    db.pragma('query_only = ON');
    const task = db.prepare(
      `SELECT known_capability
         FROM discovery_governor_tasks
        WHERE session_id = ? AND source_user_seq = ?`,
    ).get(sessionId, sourceUserSeq) as { known_capability?: unknown } | undefined;
    const claims = db.prepare(
      `SELECT category, outcome
         FROM discovery_governor_claims
        WHERE session_id = ? AND source_user_seq = ?`,
    ).all(sessionId, sourceUserSeq) as Array<{ category: string; outcome: string }>;
    const byCategory: Record<string, number> = {};
    const byOutcome: Record<string, number> = {};
    for (const claim of claims) {
      increment(byCategory, claim.category);
      increment(byOutcome, claim.outcome);
    }
    return {
      knownCapability: task?.known_capability === 1 ? true : task?.known_capability === 0 ? false : null,
      byCategory,
      byOutcome,
    };
  } catch {
    return { knownCapability: null, byCategory: {}, byOutcome: {} };
  } finally {
    db.close();
  }
}

const TERMINAL_TYPES = new Set([
  'conversation_completed',
  'conversation_limit_exceeded',
  'run_completed',
  'run_failed',
  'turn_ended',
]);

function timestampMs(event: SessionEvent | undefined): number | null {
  if (!event) return null;
  const value = Date.parse(event.createdAt);
  return Number.isFinite(value) ? value : null;
}

function wallClock(events: readonly SessionEvent[]): {
  turnWallMs: number | null;
  wallStartType: 'user_input_received' | 'turn_started' | null;
  terminalType: string | null;
} {
  const terminal = [...events].reverse().find((event) => TERMINAL_TYPES.has(event.type));
  if (!terminal) return { turnWallMs: null, wallStartType: null, terminalType: null };

  const terminalSourceSeq = typeof terminal.data.sourceUserSeq === 'number'
    ? terminal.data.sourceUserSeq
    : null;
  const beforeTerminal = events.filter((event) => event.seq <= terminal.seq);
  const exactAccepted = terminalSourceSeq === null
    ? undefined
    : beforeTerminal.find((event) => event.type === 'user_input_received' && event.seq === terminalSourceSeq);
  const latestAccepted = [...beforeTerminal].reverse().find((event) => event.type === 'user_input_received');
  const accepted = exactAccepted ?? latestAccepted;
  const turnStarted = [...beforeTerminal].reverse().find((event) => (
    event.type === 'turn_started' && (event.turn === terminal.turn || !accepted)
  ));
  const start = accepted ?? turnStarted;
  const startMs = timestampMs(start);
  const endMs = timestampMs(terminal);
  return {
    turnWallMs: startMs !== null && endMs !== null && endMs >= startMs ? endMs - startMs : null,
    wallStartType: start?.type === 'user_input_received' || start?.type === 'turn_started' ? start.type : null,
    terminalType: terminal.type,
  };
}

export function resolveClementineHome(raw = process.env.CLEMENTINE_HOME): string {
  const configured = raw?.trim() || path.join(os.homedir(), '.clementine-next');
  if (configured === '~') return os.homedir();
  if (configured.startsWith(`~${path.sep}`)) return path.join(os.homedir(), configured.slice(2));
  return path.resolve(configured);
}

function measureRows(args: {
  sessionId: string;
  events: readonly SessionEvent[];
  usageEvents: readonly UsageEvent[];
  malformedEventPayloads: number;
  malformedUsageLines: number;
}): SessionMeasurement {
  const { sessionId, events, usageEvents, malformedEventPayloads, malformedUsageLines } = args;
  const toolCalls = events.filter((event) => event.type === 'tool_called');
  const toolReturns = events.filter((event) => event.type === 'tool_returned');
  const canonicalCalls = projectCanonicalTopLevelToolEvents(toolCalls, 'tool_called');
  const mirrorCalls = toolCalls.filter((event) => event.data.accounting === 'transport_mirror');
  const mirrorReturns = toolReturns.filter((event) => event.data.accounting === 'transport_mirror');
  const explicitTopLevel = canonicalCalls.filter((event) => event.data.accounting === 'top_level');
  const nestedBatch = canonicalCalls.filter((event) => (
    event.data.batchMode === true && event.data.accounting !== 'top_level'
  ));
  const perTool: Record<string, number> = {};
  for (const event of canonicalCalls) increment(perTool, semanticToolName(event.data));
  const toolSearchCalls = canonicalCalls.filter((event) => semanticToolName(event.data) === 'tool_search');
  const topLevelToolSearches = toolSearchCalls.length;
  // A search's cost is the time the turn waited on it: from its call row to
  // its return row, paired by call id. Unpaired calls count zero rather than
  // guessing.
  const returnByCallId = new Map<string, SessionEvent>();
  for (const event of toolReturns) {
    const callId = typeof event.data.callId === 'string' ? event.data.callId : '';
    if (callId && !returnByCallId.has(callId)) returnByCallId.set(callId, event);
  }
  let toolSearchMs = 0;
  for (const call of toolSearchCalls) {
    const callId = typeof call.data.callId === 'string' ? call.data.callId : '';
    const returned = callId ? returnByCallId.get(callId) : undefined;
    if (!returned) continue;
    const started = Date.parse(call.createdAt);
    const finished = Date.parse(returned.createdAt);
    if (Number.isFinite(started) && Number.isFinite(finished) && finished >= started) toolSearchMs += finished - started;
  }
  const composioSearchDispatches = actualComposioSearchDispatches(canonicalCalls, mirrorCalls);
  const schemaMetadataRefreshes = events.filter((event) => event.type === 'warm_schema_metadata_refresh').length;

  const usageRecordsByModel: Record<string, number> = {};
  let promptTokens = 0;
  let cachedInputTokens = 0;
  let uncachedInputTokens = 0;
  let outputTokens = 0;
  let uncertifiedUsageCalls = 0;
  let invalidUsageCalls = 0;
  let sdkDurationMs = 0;
  let providerDurationMs = 0;
  for (const event of usageEvents) {
    const accounting = canonicalCacheAccounting(event);
    if (!accounting.certified) uncertifiedUsageCalls += 1;
    if (accounting.invalid) invalidUsageCalls += 1;
    promptTokens += accounting.promptTokens;
    cachedInputTokens += accounting.cachedReadTokens;
    uncachedInputTokens += accounting.uncachedInputTokens;
    outputTokens += finiteNonNegative(event.outputTokens);
    sdkDurationMs += finiteNonNegative(event.durationMs);
    providerDurationMs += finiteNonNegative(event.providerApiDurationMs);
    increment(usageRecordsByModel, typeof event.model === 'string' && event.model.trim() ? event.model : '(unknown)');
  }

  const wall = wallClock(events);
  return {
    sessionId,
    acceptedTurns: events.filter((event) => event.type === 'user_input_received').length,
    canonicalTopLevelToolCalls: canonicalCalls.length,
    explicitTopLevelToolCalls: explicitTopLevel.length,
    nestedBatchToolCalls: nestedBatch.length,
    toolCalledRows: toolCalls.length,
    toolReturnedRows: toolReturns.length,
    toolLifecycleEvents: toolCalls.length + toolReturns.length,
    transportMirrorCalls: mirrorCalls.length,
    transportMirrorEvents: mirrorCalls.length + mirrorReturns.length,
    discoveryOperations: topLevelToolSearches + composioSearchDispatches,
    schemaMetadataRefreshes,
    topLevelToolSearches,
    toolSearchMs,
    composioSearchDispatches,
    perTool,
    usageRecords: usageEvents.length,
    usageRecordsByModel,
    promptTokens,
    cachedInputTokens,
    uncachedInputTokens,
    outputTokens,
    uncertifiedUsageCalls,
    invalidUsageCalls,
    sdkDurationMs,
    providerDurationMs,
    ...wall,
    malformedEventPayloads,
    malformedUsageLines,
  };
}

function usageBelongsToSession(event: UsageEvent, sessionId: string): boolean {
  if (event.source === sessionId) return true;
  const acceptedSource = event.trace && typeof event.trace === 'object'
    ? event.trace.acceptedSource
    : undefined;
  return acceptedSource === sessionId || acceptedSource?.startsWith(`${sessionId}:`) === true;
}

export function measureSession(home: string, sessionId: string): SessionMeasurement {
  const dbPath = path.join(home, 'state', 'harness.db');
  const usageDir = path.join(home, 'state', 'token-usage');
  const { events, malformedEventPayloads } = readSessionEvents(dbPath, sessionId);
  const usageRead = readUsageEvents(usageDir);
  return measureRows({
    sessionId,
    events,
    usageEvents: usageRead.events.filter((event) => usageBelongsToSession(event, sessionId)),
    malformedEventPayloads,
    malformedUsageLines: usageRead.malformedUsageLines,
  });
}

function positiveEventSeq(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function terminalOwnerClaims(data: Record<string, unknown>): { claims: Set<number>; corrupt: boolean } {
  const claims = new Set<number>();
  let corrupt = false;
  if (Object.prototype.hasOwnProperty.call(data, 'sourceUserSeq')) {
    const seq = positiveEventSeq(data.sourceUserSeq);
    if (seq === null) corrupt = true;
    else claims.add(seq);
  }
  if (Object.prototype.hasOwnProperty.call(data, 'terminalKey')) {
    const terminalKey = typeof data.terminalKey === 'string' ? data.terminalKey : '';
    const match = /^turn:([1-9]\d*)$/.exec(terminalKey);
    if (terminalKey.startsWith('turn:') && !match) corrupt = true;
    if (match) {
      const seq = Number(match[1]);
      if (!Number.isSafeInteger(seq)) corrupt = true;
      else claims.add(seq);
    }
  }
  if (Object.prototype.hasOwnProperty.call(data, 'presentation')) {
    const presentation = parseObject(data.presentation);
    const identity = parseObject(presentation?.identity);
    const seq = positiveEventSeq(identity?.sourceUserSeq);
    if (seq === null) corrupt = true;
    else claims.add(seq);
  }
  if (claims.size > 1) corrupt = true;
  return { claims, corrupt };
}

function terminalStatus(data: Record<string, unknown>): string | null {
  const presentation = parseObject(data.presentation);
  const turnOutcome = parseObject(data.turnOutcome);
  for (const value of [presentation?.status, turnOutcome?.status, data.status]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function terminalSteps(data: Record<string, unknown>): number | null {
  for (const value of [data.steps, parseObject(data.metadata)?.steps]) {
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  }
  return null;
}

function timestampValue(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function ownedTerminal(
  sessionId: string,
  source: SessionEvent,
  events: readonly SessionEvent[],
  required: boolean,
): SessionEvent | null {
  const terminalCandidates: SessionEvent[] = [];
  for (const event of events) {
    if (event.seq <= source.seq || event.type !== 'conversation_completed') continue;
    const owner = terminalOwnerClaims(event.data);
    let presentation: ReturnType<typeof presentationEventFromCompletionData> = null;
    try {
      presentation = presentationEventFromCompletionData(event.data);
    } catch {
      if (owner.claims.has(source.seq)) {
        throw new Error(`Terminal ${event.seq} has a corrupt typed projection for ${sessionId}:${source.seq}`);
      }
      continue;
    }
    if (
      !presentation
      || presentation.identity.sessionId !== sessionId
      || presentation.identity.sourceUserSeq !== source.seq
      || presentation.identity.turn !== source.turn
    ) {
      if (owner.claims.has(source.seq)) {
        throw new Error(`Terminal ${event.seq} has contradictory ownership for ${sessionId}:${source.seq}`);
      }
      continue;
    }
    terminalCandidates.push(event);
  }
  if (required && terminalCandidates.length === 0) {
    throw new Error(`No owned conversation_completed terminal for ${sessionId}:${source.seq}`);
  }
  if (terminalCandidates.length > 1) {
    throw new Error(`Ambiguous terminals for ${sessionId}:${source.seq}: ${terminalCandidates.map((event) => event.seq).join(', ')}`);
  }
  return terminalCandidates[0] ?? null;
}

/**
 * Measure one exact accepted human turn in a reusable session. Event/tool work
 * is bounded by the accepted row and its owned terminal. Usage follows the
 * canonical cross-session trace join; old rows are included only through a
 * visibly uncertified same-session/time-window compatibility path.
 */
export function measureAcceptedTurn(
  home: string,
  sessionId: string,
  sourceUserSeq: number,
): AcceptedTurnMeasurement {
  if (!Number.isSafeInteger(sourceUserSeq) || sourceUserSeq <= 0) {
    throw new Error('sourceUserSeq must be a positive event sequence');
  }
  const dbPath = path.join(home, 'state', 'harness.db');
  const usageDir = path.join(home, 'state', 'token-usage');
  const sessionRead = readSessionEvents(dbPath, sessionId);
  const source = sessionRead.events.find((event) => event.seq === sourceUserSeq);
  if (!source) throw new Error(`No event ${sourceUserSeq} found in session ${sessionId}`);
  if (source.type !== 'user_input_received' || source.role !== 'user' || source.data.synthetic === true) {
    throw new Error(`${sessionId}:${sourceUserSeq} is not an accepted human user input`);
  }

  const terminal = ownedTerminal(sessionId, source, sessionRead.events, true)!;
  const attempts = readAttemptsForSource(dbPath, sessionId, sourceUserSeq);
  const attemptCloseoutMs = timestampValue(attempts.closeoutAt ?? '');
  const terminalMs = timestampValue(terminal.createdAt);
  const closeoutMs = Math.max(terminalMs ?? 0, attemptCloseoutMs ?? 0);
  const nextInput = sessionRead.events.find((event) => (
    event.seq > source.seq && event.type === 'user_input_received'
  ));
  const events = sessionRead.events.filter((event) => {
    if (event.seq < source.seq || (nextInput && event.seq >= nextInput.seq)) return false;
    const at = timestampValue(event.createdAt);
    return at !== null && at <= closeoutMs;
  });
  const acceptedSource = `${sessionId}:${sourceUserSeq}`;
  const usageRead = readUsageEvents(usageDir);
  const exactCandidates = usageRead.events.filter((event) => (
    event.trace?.acceptedSource === acceptedSource
    && event.trace.logicalTurnId === `turn:${sourceUserSeq}`
  ));
  const invalidExactUsage = exactCandidates.filter((event) => (
    typeof event.trace?.attemptId === 'string' && !attempts.ids.has(event.trace.attemptId)
  ));
  const invalidExactSet = new Set(invalidExactUsage);
  const exactUsage = exactCandidates.filter((event) => !invalidExactSet.has(event));
  const exactUsageSet = new Set(exactUsage);
  const startMs = timestampValue(source.createdAt);
  const endMs = closeoutMs || timestampValue(terminal.createdAt);
  const legacyWindowUsage = startMs === null || endMs === null
    ? []
    : usageRead.events.filter((event) => {
        if (exactUsageSet.has(event) || invalidExactSet.has(event)) return false;
        const at = timestampValue(event.at);
        if (at === null || at < startMs || at > endMs) return false;
        return event.source === sessionId || event.trace?.acceptedSource === sessionId;
      });
  const legacyWindowUsageSet = new Set(legacyWindowUsage);
  const unscopedWindowUsage = startMs === null || endMs === null
    ? []
    : usageRead.events.filter((event) => {
        if (exactUsageSet.has(event) || invalidExactSet.has(event) || legacyWindowUsageSet.has(event)) return false;
        const at = timestampValue(event.at);
        if (at === null || at < startMs || at > endMs) return false;
        return event.source === 'unknown' || event.kind === 'other';
      });
  const usageEvents = [...exactUsage, ...legacyWindowUsage];
  // Exact route ownership is stronger than wall-clock ordering. The Claude
  // SDK bridge can append its post-response route marker immediately after
  // the inner attempt closes, so an exact marker may land a millisecond beyond
  // `finished_at`. Join those rows by both accepted source and durable attempt,
  // just as exact usage is joined above. Legacy markers have no such authority
  // and therefore remain restricted to the accepted-turn time window.
  const allRouteEvents = sessionRead.events.filter((event) => event.type === 'turn_model_routed');
  const exactModelRouteEvents = allRouteEvents.filter((event) => (
    event.data.sourceUserSeq === sourceUserSeq
    && typeof event.data.attemptId === 'string'
    && attempts.ids.has(event.data.attemptId)
  )).length;
  const legacyWindowModelRouteEvents = events.filter((event) => (
    event.type === 'turn_model_routed'
    && positiveEventSeq(event.data.sourceUserSeq) === null
  )).length;
  const modelRouteEvents = exactModelRouteEvents + legacyWindowModelRouteEvents;
  const usageAttribution: TurnUsageAttribution = exactUsage.length > 0
    ? (legacyWindowUsage.length > 0 ? 'mixed' : 'exact')
    : (legacyWindowUsage.length > 0 ? 'legacy_window' : 'none');
  const usageCertificationIssues: string[] = [];
  if (legacyWindowUsage.length > 0) usageCertificationIssues.push('legacy_window_usage');
  if (unscopedWindowUsage.length > 0) usageCertificationIssues.push('unscoped_window_usage');
  if (invalidExactUsage.length > 0) usageCertificationIssues.push('invalid_attempt_attribution');
  if (attempts.unfinished > 0) usageCertificationIssues.push('unfinished_source_attempt');
  if (modelRouteEvents > 0 && exactUsage.length === 0) usageCertificationIssues.push('model_route_without_exact_usage');
  const discovery = readDiscoveryForSource(dbPath, sessionId, sourceUserSeq);
  const measured = measureRows({
    sessionId,
    events,
    usageEvents,
    malformedEventPayloads: sessionRead.malformedEventPayloads,
    malformedUsageLines: usageRead.malformedUsageLines,
  });
  return {
    ...measured,
    sourceUserSeq,
    acceptedSource,
    terminalSeq: terminal.seq,
    terminalTransport: typeof terminal.data.transport === 'string' && terminal.data.transport.trim()
      ? terminal.data.transport.trim()
      : null,
    terminalStatus: terminalStatus(terminal.data),
    terminalSteps: terminalSteps(terminal.data),
    modelRouteEvents,
    exactModelRouteEvents,
    legacyWindowModelRouteEvents,
    exactUsageRecords: exactUsage.length,
    legacyWindowUsageRecords: legacyWindowUsage.length,
    unscopedWindowUsageRecords: unscopedWindowUsage.length,
    invalidUsageAttributions: invalidExactUsage.length,
    usageAttribution,
    usageAttributionCertified: usageCertificationIssues.length === 0,
    usageCertificationIssues,
    governorKnownCapability: discovery.knownCapability,
    discoveryClaimsByCategory: discovery.byCategory,
    discoveryClaimsByOutcome: discovery.byOutcome,
    attemptCount: attempts.ids.size,
    unfinishedAttempts: attempts.unfinished,
    awaitingUserInputEvents: events.filter((event) => event.type === 'awaiting_user_input').length,
    supersededEvents: events.filter((event) => event.type === 'conversation_superseded').length,
    restartRecoveryEvents: events.filter((event) => event.type === 'restart_recovery_decision').length,
  };
}

function intervalUnionMs(intervals: readonly [number, number][]): number {
  let total = 0;
  let end = Number.NEGATIVE_INFINITY;
  for (const [start, finish] of [...intervals].sort((a, b) => a[0] - b[0])) {
    total += Math.max(0, finish - Math.max(start, end));
    end = Math.max(end, finish);
  }
  return total;
}

/**
 * Explicit whole-task scope. Only host-validated, durable approval execution
 * edges extend the root; adjacent turns, matching text, and timestamps never
 * establish parentage. Each NDJSON row is selected once across the entire
 * lineage. This deliberately does not sum overlapping accepted-turn totals.
 * Unproved candidate cost is reported separately, not discarded as free work.
 */
export function measureAcceptedTask(
  home: string,
  sessionId: string,
  rootSourceUserSeq: number,
): AcceptedTaskMeasurement {
  if (!Number.isSafeInteger(rootSourceUserSeq) || rootSourceUserSeq <= 0) {
    throw new Error('rootSourceUserSeq must be a positive event sequence');
  }
  const dbPath = path.join(home, 'state', 'harness.db');
  const sessionRead = readSessionEvents(dbPath, sessionId);
  const inputs = sessionRead.events.filter((event) => event.type === 'user_input_received');
  const root = inputs.find((event) => event.seq === rootSourceUserSeq);
  if (!root || root.role !== 'user' || root.data.synthetic === true) {
    throw new Error(`${sessionId}:${rootSourceUserSeq} is not an accepted human user input`);
  }
  const members = new Map<number, SessionEvent>([[root.seq, root]]);
  // A readable claim is enough to keep possible cost visible, never enough to
  // admit a source to the authoritative lineage used for proven totals.
  const claimedMembers = new Map<number, SessionEvent>([[root.seq, root]]);
  const parentBySource = new Map<number, number>();
  const approvalContinuations: ApprovalContinuationMeasurement[] = [];
  const lineageIssues = new Set<string>();
  const resumes = sessionRead.events.filter((event) => event.type === 'run_resumed' && event.role === 'system');
  const db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 5_000 });
  try {
    db.pragma('query_only = ON');
    // Parents always precede their controls, so the ordered input scan also
    // handles a continuation whose execution source is an earlier control.
    for (const source of inputs) {
      if (source.seq <= root.seq || source.role !== 'user') continue;
      const claims = resumes.filter((event) => event.data.deliverySourceUserSeq === source.seq);
      const related = claims.some((event) => {
        const parent = positiveEventSeq(event.data.executionSourceUserSeq);
        return parent !== null && parent < source.seq && claimedMembers.has(parent);
      });
      if (!related) continue;
      claimedMembers.set(source.seq, source);
      let parent: number | null = null;
      try {
        parent = readApprovalExecutionSource(db, { sessionId, sourceUserSeq: source.seq });
      } catch {
        // Old schemas and corrupt payloads cannot manufacture lineage.
      }
      const approvalId = typeof source.data.approvalId === 'string' ? source.data.approvalId : '';
      const duplicateControls = inputs.filter((event) => event.data.approvalId === approvalId).length;
      const conflictingClaim = claims.some((event) => (
        event.data.reviewContinuationVersion !== 1
        || event.data.executionSourceUserSeq !== parent
        || event.data.approvalId !== approvalId
        || event.data.decision !== source.data.decision
        || event.seq <= source.seq
      ));
      if (parent === null || !members.has(parent) || duplicateControls !== 1 || conflictingClaim) {
        lineageIssues.add(`unproved_approval_continuation:${source.seq}`);
        continue;
      }
      let card: { requested_at?: unknown; resolved_at?: unknown } | undefined;
      try {
        card = db.prepare('SELECT requested_at, resolved_at FROM pending_approvals WHERE session_id = ? AND approval_id = ?')
          .get(sessionId, approvalId) as typeof card;
      } catch { /* Old timing columns are unknown; identity proof is separate. */ }
      members.set(source.seq, source);
      parentBySource.set(source.seq, parent);
      approvalContinuations.push({
        approvalId,
        controlSourceUserSeq: source.seq,
        executionSourceUserSeq: parent,
        resumeEventSeqs: claims.map((event) => event.seq),
        requestedAt: typeof card?.requested_at === 'string' ? card.requested_at : null,
        resolvedAt: typeof card?.resolved_at === 'string' ? card.resolved_at : null,
      });
    }
  } finally {
    db.close();
  }
  for (const resume of resumes) {
    if (members.has(Number(resume.data.executionSourceUserSeq)) && !members.has(Number(resume.data.deliverySourceUserSeq))) {
      lineageIssues.add(`unproved_approval_resume:${resume.seq}`);
    }
  }

  const issues = new Set<string>(lineageIssues);
  const attemptsBySource = new Map<number, AttemptRead>();
  const sourceByAttempt = new Map<string, number>();
  const terminals = new Map<number, SessionEvent>();
  const eventSeqs = new Set<number>();
  const windows: [number, number][] = [];
  let unfinishedAttempts = 0;
  for (const source of members.values()) {
    const terminal = ownedTerminal(sessionId, source, sessionRead.events, false);
    if (terminal) terminals.set(source.seq, terminal);
    else issues.add(`missing_terminal:${source.seq}`);
    const attempts = readAttemptsForSource(dbPath, sessionId, source.seq);
    attemptsBySource.set(source.seq, attempts);
    for (const id of attempts.ids) sourceByAttempt.set(id, source.seq);
    unfinishedAttempts += attempts.unfinished;
    if (attempts.unfinished > 0) issues.add(`unfinished_source_attempt:${source.seq}`);
    const start = timestampMs(source);
    const end = Math.max(timestampMs(terminal ?? undefined) ?? 0, timestampValue(attempts.closeoutAt ?? '') ?? 0);
    const nextInput = inputs.find((event) => event.seq > source.seq);
    if (start !== null && end >= start) windows.push([start, end]);
    else issues.add(`unbounded_source_window:${source.seq}`);
    for (const event of sessionRead.events) {
      if (event.seq < source.seq || (nextInput && event.seq >= nextInput.seq)) continue;
      const at = timestampMs(event);
      if (at !== null && (!end || at <= end)) eventSeqs.add(event.seq);
    }
  }
  const events = sessionRead.events.filter((event) => eventSeqs.has(event.seq));
  const acceptedSource = `${sessionId}:${root.seq}`;
  const sourceByAccepted = new Map([...members.keys()].map((seq) => [`${sessionId}:${seq}`, seq]));
  const claimedAccepted = new Set([...claimedMembers.keys()].map((seq) => `${sessionId}:${seq}`));
  const claimedAttemptIds = new Set(sourceByAttempt.keys());
  for (const source of claimedMembers.keys()) {
    if (!members.has(source)) {
      for (const id of readAttemptsForSource(dbPath, sessionId, source).ids) claimedAttemptIds.add(id);
    }
  }
  const isAncestor = (ancestor: number, descendant: number): boolean => {
    let current: number | undefined = descendant;
    while (current !== undefined) {
      if (current === ancestor) return true;
      current = parentBySource.get(current);
    }
    return false;
  };
  const usageRead = readUsageEvents(path.join(home, 'state', 'token-usage'));
  const exactUsage: UsageEvent[] = [];
  const unprovenUsage: UsageEvent[] = [];
  const usageAttemptIds = new Set<string>();
  let legacyWindowUsageRecords = 0;
  let unscopedWindowUsageRecords = 0;
  for (const event of usageRead.events) {
    const traceSource = sourceByAccepted.get(event.trace?.acceptedSource ?? '');
    const attemptId = event.trace?.attemptId;
    const attemptSource = typeof attemptId === 'string' ? sourceByAttempt.get(attemptId) : undefined;
    if (traceSource !== undefined || attemptSource !== undefined
      || claimedAccepted.has(event.trace?.acceptedSource ?? '')
      || (typeof attemptId === 'string' && claimedAttemptIds.has(attemptId))) {
      if (traceSource !== undefined && attemptSource !== undefined
        && event.trace?.logicalTurnId === `turn:${traceSource}` && isAncestor(traceSource, attemptSource)) {
        exactUsage.push(event);
        usageAttemptIds.add(attemptId!);
      } else {
        unprovenUsage.push(event);
        issues.add('unproved_usage_attribution');
      }
      continue;
    }
    // A different exact source is not a legacy same-session row just because
    // its asynchronous work happened during a member's wall-time window.
    const foreignIdentity = typeof event.trace?.acceptedSource === 'string'
      ? /^(.+):([1-9]\d*)$/.exec(event.trace.acceptedSource) : null;
    if (foreignIdentity && positiveEventSeq(Number(foreignIdentity[2])) !== null
      && event.trace?.logicalTurnId === `turn:${foreignIdentity[2]}`) continue;
    const at = timestampValue(event.at);
    if (at === null || !windows.some(([start, end]) => at >= start && at <= end)) continue;
    if (event.source === sessionId || event.trace?.acceptedSource === sessionId) legacyWindowUsageRecords += 1;
    else if (event.source === 'unknown' || event.kind === 'other') unscopedWindowUsageRecords += 1;
  }
  if (legacyWindowUsageRecords > 0) issues.add('excluded_legacy_window_usage');
  if (unscopedWindowUsageRecords > 0) issues.add('unscoped_window_usage');
  if (sessionRead.malformedEventPayloads > 0) issues.add('malformed_session_events');
  const routes = sessionRead.events.filter((event) => {
    if (event.type !== 'turn_model_routed') return false;
    const attemptId = typeof event.data.attemptId === 'string' ? event.data.attemptId : '';
    const owner = sourceByAttempt.get(attemptId);
    const traceSource = positiveEventSeq(event.data.sourceUserSeq);
    if (owner !== undefined && traceSource !== null && isAncestor(traceSource, owner)) {
      if (!usageAttemptIds.has(attemptId)) issues.add(`model_route_without_exact_usage:${owner}`);
      return true;
    }
    if (eventSeqs.has(event.seq) && traceSource === null) {
      const segment = [...members.keys()].reverse().find((seq) => seq < event.seq);
      if (segment !== undefined && ![...(attemptsBySource.get(segment)?.ids ?? [])].some((id) => usageAttemptIds.has(id))) {
        issues.add(`model_route_without_exact_usage:${segment}`);
      }
      return true;
    }
    return false;
  });
  const measured = measureRows({ sessionId, events, usageEvents: exactUsage,
    malformedEventPayloads: sessionRead.malformedEventPayloads, malformedUsageLines: usageRead.malformedUsageLines });
  const unproven = measureRows({ sessionId, events: [], usageEvents: unprovenUsage,
    malformedEventPayloads: 0, malformedUsageLines: 0 });
  const lastSource = [...members.keys()].at(-1)!;
  const terminal = terminals.get(lastSource);
  const startMs = timestampMs(root);
  const endMs = timestampMs(terminal);
  const taskWallMs = lineageIssues.size === 0 && terminals.size === members.size && startMs !== null && endMs !== null && endMs >= startMs
    ? endMs - startMs : null;
  const approvalWaitIssues: string[] = lineageIssues.size > 0 ? ['unproved_approval_lineage'] : [];
  const waits: [number, number][] = [];
  for (const link of approvalContinuations) {
    const requested = timestampValue(link.requestedAt ?? '');
    const resolved = timestampValue(link.resolvedAt ?? '');
    if (taskWallMs === null || startMs === null || endMs === null || requested === null || resolved === null
      || resolved < requested || requested < startMs || resolved > endMs) {
      approvalWaitIssues.push(`unbounded_approval_wait:${link.approvalId}`);
    } else {
      waits.push([requested, resolved]);
    }
  }
  return {
    ...measured,
    // SessionMeasurement's wall helper means one turn; never relabel its last
    // segment as the whole task. Explicit task/segment timings follow below.
    turnWallMs: null,
    scope: 'task', rootSourceUserSeq, acceptedSource,
    sourceUserSeqs: [...members.keys()], approvalContinuations, lineageIssues: [...lineageIssues],
    exactUsageRecords: exactUsage.length,
    unprovenUsage: { usageRecords: unproven.usageRecords, promptTokens: unproven.promptTokens,
      cachedInputTokens: unproven.cachedInputTokens, uncachedInputTokens: unproven.uncachedInputTokens, outputTokens: unproven.outputTokens },
    legacyWindowUsageRecords, unscopedWindowUsageRecords,
    usageAttributionCertified: issues.size === 0,
    usageCertificationIssues: [...issues],
    modelRouteEvents: routes.length,
    attemptCount: sourceByAttempt.size, unfinishedAttempts,
    terminalSeq: terminal?.seq ?? null,
    terminalStatus: terminal ? terminalStatus(terminal.data) : null,
    taskWallMs,
    segmentWallMs: windows.length === members.size ? intervalUnionMs(windows) : null,
    recordedApprovalWaitMs: approvalWaitIssues.length === 0 ? intervalUnionMs(waits) : null,
    approvalWaitIssues,
  };
}

export function compareAcceptedTasks(args: AcceptedTurnComparisonArgs): AcceptedTaskComparison {
  const home = resolveClementineHome(args.home);
  return { home, baseline: measureAcceptedTask(home, args.baselineSession, args.baselineSource),
    candidate: measureAcceptedTask(home, args.candidateSession, args.candidateSource) };
}

export function compareSessions(args: SessionComparisonArgs): SessionComparison {
  const home = resolveClementineHome(args.home);
  return {
    home,
    baseline: measureSession(home, args.baseline),
    candidate: measureSession(home, args.candidate),
  };
}

export function compareAcceptedTurns(args: AcceptedTurnComparisonArgs): AcceptedTurnComparison {
  const home = resolveClementineHome(args.home);
  return {
    home,
    baseline: measureAcceptedTurn(home, args.baselineSession, args.baselineSource),
    candidate: measureAcceptedTurn(home, args.candidateSession, args.candidateSource),
  };
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1]?.trim();
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

export function parseSessionComparisonArgs(argv: readonly string[]): SessionComparisonArgs | { help: true } {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  let baseline = '';
  let candidate = '';
  let home = resolveClementineHome();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--baseline') {
      baseline = requireValue(argv, i, arg);
      i += 1;
    } else if (arg === '--candidate') {
      candidate = requireValue(argv, i, arg);
      i += 1;
    } else if (arg === '--home') {
      home = resolveClementineHome(requireValue(argv, i, arg));
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!baseline || !candidate) throw new Error('--baseline and --candidate are required');
  return { baseline, candidate, home };
}

function positiveSource(value: string, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive event sequence`);
  }
  return parsed;
}

export function parseAcceptedTurnComparisonArgs(
  argv: readonly string[],
): AcceptedTurnComparisonArgs | { help: true } {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  let baselineSession = '';
  let baselineSource = 0;
  let candidateSession = '';
  let candidateSource = 0;
  let home = resolveClementineHome();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--baseline-session') {
      baselineSession = requireValue(argv, i, arg);
      i += 1;
    } else if (arg === '--baseline-source') {
      baselineSource = positiveSource(requireValue(argv, i, arg), arg);
      i += 1;
    } else if (arg === '--candidate-session') {
      candidateSession = requireValue(argv, i, arg);
      i += 1;
    } else if (arg === '--candidate-source') {
      candidateSource = positiveSource(requireValue(argv, i, arg), arg);
      i += 1;
    } else if (arg === '--home') {
      home = resolveClementineHome(requireValue(argv, i, arg));
      i += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!baselineSession || !baselineSource || !candidateSession || !candidateSource) {
    throw new Error('--baseline-session, --baseline-source, --candidate-session, and --candidate-source are required');
  }
  return { baselineSession, baselineSource, candidateSession, candidateSource, home };
}

/** Opt-in CLI scope; the historical accepted-turn parser/API stay unchanged. */
export function parseMeasurementComparisonArgs(argv: readonly string[]): MeasurementComparisonArgs | { help: true } {
  if (argv.includes('--help') || argv.includes('-h')) return { help: true };
  const rest: string[] = [];
  let scope: 'turn' | 'task' | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] !== '--scope') { rest.push(argv[i]); continue; }
    if (scope !== undefined) throw new Error('--scope may only be supplied once');
    const value = requireValue(argv, i, '--scope');
    if (value !== 'turn' && value !== 'task') throw new Error('--scope must be turn or task');
    scope = value;
    i += 1;
  }
  const parsed = parseAcceptedTurnComparisonArgs(rest);
  return 'help' in parsed || scope === undefined ? parsed : { ...parsed, scope };
}

function integer(value: number | null): string {
  return value === null ? 'n/a' : Math.round(value).toLocaleString('en-US');
}

function duration(value: number | null): string {
  if (value === null) return 'n/a';
  return `${(value / 1_000).toFixed(3)}s`;
}

function deltaNumber(baseline: number | null, candidate: number | null, formatter = integer): string {
  if (baseline === null || candidate === null) return 'n/a';
  const delta = candidate - baseline;
  const sign = delta > 0 ? '+' : '';
  const percent = baseline === 0 ? '' : ` (${sign}${((delta / baseline) * 100).toFixed(1)}%)`;
  return `${sign}${formatter(delta)}${percent}`;
}

function row(
  label: string,
  baseline: number | null,
  candidate: number | null,
  formatter = integer,
): string {
  return [
    label.padEnd(62),
    formatter(baseline).padStart(14),
    formatter(candidate).padStart(14),
    deltaNumber(baseline, candidate, formatter).padStart(22),
  ].join(' ');
}

function keyedRows(
  baseline: Record<string, number>,
  candidate: Record<string, number>,
): string[] {
  const keys = new Set([...Object.keys(baseline), ...Object.keys(candidate)]);
  return [...keys]
    .sort((a, b) => ((candidate[b] ?? 0) + (baseline[b] ?? 0)) - ((candidate[a] ?? 0) + (baseline[a] ?? 0)) || a.localeCompare(b))
    .map((key) => row(`  ${key}`, baseline[key] ?? 0, candidate[key] ?? 0));
}

export function formatSessionComparison(comparison: SessionComparison): string {
  const { baseline: b, candidate: c } = comparison;
  const lines = [
    'Clementine session comparison (read-only)',
    `home:      ${comparison.home}`,
    `baseline:  ${b.sessionId}`,
    `candidate: ${c.sessionId}`,
    '',
    'Metric                                                               Baseline      Candidate                  Delta',
    row('Canonical tool calls (no mirrors)', b.canonicalTopLevelToolCalls, c.canonicalTopLevelToolCalls),
    row('  explicit accounting=top_level', b.explicitTopLevelToolCalls, c.explicitTopLevelToolCalls),
    row('  nested batch child calls', b.nestedBatchToolCalls, c.nestedBatchToolCalls),
    row('Tool-called rows (all)', b.toolCalledRows, c.toolCalledRows),
    row('Tool lifecycle events (call+return)', b.toolLifecycleEvents, c.toolLifecycleEvents),
    row('Transport mirror calls', b.transportMirrorCalls, c.transportMirrorCalls),
    row('Transport mirror lifecycle events', b.transportMirrorEvents, c.transportMirrorEvents),
    row('Discovery operations', b.discoveryOperations, c.discoveryOperations),
    row('  top-level tool_search', b.topLevelToolSearches, c.topLevelToolSearches),
    row('  time inside tool_search', b.toolSearchMs, c.toolSearchMs, duration),
    row('  composio_search dispatches', b.composioSearchDispatches, c.composioSearchDispatches),
    row('Provider schema metadata refreshes (non-business)', b.schemaMetadataRefreshes, c.schemaMetadataRefreshes),
    row('Usage records (agent runs + auxiliaries)', b.usageRecords, c.usageRecords),
    row('Canonical prompt tokens', b.promptTokens, c.promptTokens),
    row('Cached input tokens', b.cachedInputTokens, c.cachedInputTokens),
    row('Uncached input tokens', b.uncachedInputTokens, c.uncachedInputTokens),
    row('Output tokens', b.outputTokens, c.outputTokens),
    row('Summed SDK latency', b.sdkDurationMs, c.sdkDurationMs, duration),
    row('Summed provider latency', b.providerDurationMs, c.providerDurationMs, duration),
    row('Accepted-turn wall time', b.turnWallMs, c.turnWallMs, duration),
    '',
    'Canonical calls by effective tool',
    ...keyedRows(b.perTool, c.perTool),
    '',
    'Usage records by model',
    ...keyedRows(b.usageRecordsByModel, c.usageRecordsByModel),
  ];
  const warnings: string[] = [];
  for (const measurement of [b, c]) {
    if (measurement.acceptedTurns !== 1) {
      warnings.push(`${measurement.sessionId}: ${measurement.acceptedTurns} accepted inputs; use a dedicated one-call session for an apples-to-apples comparison.`);
    }
    if (measurement.uncertifiedUsageCalls > 0 || measurement.invalidUsageCalls > 0) {
      warnings.push(`${measurement.sessionId}: ${measurement.uncertifiedUsageCalls} uncertified and ${measurement.invalidUsageCalls} invalid usage sample(s).`);
    }
    if (measurement.malformedEventPayloads > 0 || measurement.malformedUsageLines > 0) {
      warnings.push(`${measurement.sessionId}: ignored ${measurement.malformedEventPayloads} malformed event payload(s); saw ${measurement.malformedUsageLines} malformed usage line(s) across the shared log.`);
    }
    if (measurement.turnWallMs === null) {
      warnings.push(`${measurement.sessionId}: no complete accepted-input/turn-start to terminal wall-time span.`);
    }
  }
  if (warnings.length > 0) lines.push('', 'Warnings', ...warnings.map((warning) => `  - ${warning}`));
  return `${lines.join('\n')}\n`;
}

export function formatAcceptedTurnComparison(comparison: AcceptedTurnComparison): string {
  const { baseline: b, candidate: c } = comparison;
  const lines = [
    'Clementine accepted-turn comparison (read-only)',
    `home:      ${comparison.home}`,
    `baseline:  ${b.acceptedSource} → terminal ${b.terminalSeq}`,
    `candidate: ${c.acceptedSource} → terminal ${c.terminalSeq}`,
    `usage:     ${b.usageAttribution}${b.usageAttributionCertified ? ' (certified)' : ' (uncertified)'} → ${c.usageAttribution}${c.usageAttributionCertified ? ' (certified)' : ' (uncertified)'}`,
    `transport: ${b.terminalTransport ?? 'n/a'} → ${c.terminalTransport ?? 'n/a'}`,
    `status:    ${b.terminalStatus ?? 'n/a'} → ${c.terminalStatus ?? 'n/a'}`,
    '',
    'Metric                                                               Baseline      Candidate                  Delta',
    row('Model routes', b.modelRouteEvents, c.modelRouteEvents),
    row('  exact accepted-source routes', b.exactModelRouteEvents, c.exactModelRouteEvents),
    row('  legacy window routes', b.legacyWindowModelRouteEvents, c.legacyWindowModelRouteEvents),
    row('Terminal steps', b.terminalSteps, c.terminalSteps),
    row('Canonical tool calls (no mirrors)', b.canonicalTopLevelToolCalls, c.canonicalTopLevelToolCalls),
    row('Tool lifecycle events (call+return)', b.toolLifecycleEvents, c.toolLifecycleEvents),
    row('Discovery operations', b.discoveryOperations, c.discoveryOperations),
    row('  top-level tool_search', b.topLevelToolSearches, c.topLevelToolSearches),
    row('  time inside tool_search', b.toolSearchMs, c.toolSearchMs, duration),
    row('  composio_search dispatches', b.composioSearchDispatches, c.composioSearchDispatches),
    row('Provider schema metadata refreshes (non-business)', b.schemaMetadataRefreshes, c.schemaMetadataRefreshes),
    row('Usage records (all attributed)', b.usageRecords, c.usageRecords),
    row('  exact accepted-source records', b.exactUsageRecords, c.exactUsageRecords),
    row('  legacy time-window records', b.legacyWindowUsageRecords, c.legacyWindowUsageRecords),
    row('  unscoped window records (excluded)', b.unscopedWindowUsageRecords, c.unscopedWindowUsageRecords),
    row('  invalid exact attributions (excluded)', b.invalidUsageAttributions, c.invalidUsageAttributions),
    row('Canonical prompt tokens', b.promptTokens, c.promptTokens),
    row('Cached input tokens', b.cachedInputTokens, c.cachedInputTokens),
    row('Uncached input tokens', b.uncachedInputTokens, c.uncachedInputTokens),
    row('Output tokens', b.outputTokens, c.outputTokens),
    row('Summed SDK latency', b.sdkDurationMs, c.sdkDurationMs, duration),
    row('Summed provider latency', b.providerDurationMs, c.providerDurationMs, duration),
    row('Accepted-turn wall time', b.turnWallMs, c.turnWallMs, duration),
    '',
    'Canonical calls by effective tool',
    ...keyedRows(b.perTool, c.perTool),
    '',
    'Usage records by model',
    ...keyedRows(b.usageRecordsByModel, c.usageRecordsByModel),
    '',
    'Discovery governor claims by category',
    ...keyedRows(b.discoveryClaimsByCategory, c.discoveryClaimsByCategory),
    '',
    'Discovery governor claims by outcome',
    ...keyedRows(b.discoveryClaimsByOutcome, c.discoveryClaimsByOutcome),
  ];
  const warnings: string[] = [];
  for (const measurement of [b, c]) {
    if (!measurement.usageAttributionCertified) {
      warnings.push(`${measurement.acceptedSource}: usage is ${measurement.usageAttribution}; certification issues: ${measurement.usageCertificationIssues.join(', ') || 'unknown'}.`);
    }
    if (measurement.uncertifiedUsageCalls > 0 || measurement.invalidUsageCalls > 0) {
      warnings.push(`${measurement.acceptedSource}: ${measurement.uncertifiedUsageCalls} uncertified and ${measurement.invalidUsageCalls} invalid cache-accounting sample(s).`);
    }
    if (measurement.malformedEventPayloads > 0 || measurement.malformedUsageLines > 0) {
      warnings.push(`${measurement.acceptedSource}: saw ${measurement.malformedEventPayloads} malformed event payload(s) in the session and ${measurement.malformedUsageLines} malformed usage line(s) in the shared log.`);
    }
    if (
      (
        measurement.terminalTransport === 'completed_answer_replay'
        // Historical sessions used this name before replay was restricted to
        // explicit answer-repeat requests. Keep their accounting readable.
        || measurement.terminalTransport === 'completed_continuation_replay'
      )
      && (
        measurement.modelRouteEvents !== 0
        || measurement.canonicalTopLevelToolCalls !== 0
        || measurement.discoveryOperations !== 0
        || measurement.usageRecords !== 0
      )
    ) {
      warnings.push(`${measurement.acceptedSource}: replay transport carried model/tool/discovery/usage work; zero-work replay invariant failed.`);
    }
  }
  if (warnings.length > 0) lines.push('', 'Warnings', ...warnings.map((warning) => `  - ${warning}`));
  return `${lines.join('\n')}\n`;
}

export function formatAcceptedTaskComparison(comparison: AcceptedTaskComparison): string {
  const { baseline: b, candidate: c } = comparison;
  const lines = [
    'Clementine approval-linked task comparison (read-only; explicit task scope)',
    `home:      ${comparison.home}`,
    `baseline:  ${b.acceptedSource}; sources ${b.sourceUserSeqs.join(', ')}`,
    `candidate: ${c.acceptedSource}; sources ${c.sourceUserSeqs.join(', ')}`,
    `usage:     ${b.usageAttributionCertified ? 'certified' : 'UNCERTIFIED lower bound'} → ${c.usageAttributionCertified ? 'certified' : 'UNCERTIFIED lower bound'}`,
    '',
    'Metric                                                               Baseline      Candidate                  Delta',
    row('Proved approval continuations', b.approvalContinuations.length, c.approvalContinuations.length),
    row('Durable attempts', b.attemptCount, c.attemptCount),
    row('Unfinished attempts', b.unfinishedAttempts, c.unfinishedAttempts),
    row('Model routes', b.modelRouteEvents, c.modelRouteEvents),
    row('Canonical tool calls (no mirrors)', b.canonicalTopLevelToolCalls, c.canonicalTopLevelToolCalls),
    row('Discovery operations', b.discoveryOperations, c.discoveryOperations),
    row('Proven task usage records (union, not summed turns)', b.exactUsageRecords, c.exactUsageRecords),
    row('Proven task prompt tokens', b.promptTokens, c.promptTokens),
    row('Cached input tokens', b.cachedInputTokens, c.cachedInputTokens),
    row('Uncached input tokens', b.uncachedInputTokens, c.uncachedInputTokens),
    row('Output tokens', b.outputTokens, c.outputTokens),
    row('Unproven candidate usage records (excluded)', b.unprovenUsage.usageRecords, c.unprovenUsage.usageRecords),
    row('Unproven candidate prompt tokens (excluded)', b.unprovenUsage.promptTokens, c.unprovenUsage.promptTokens),
    row('Unproven candidate output tokens (excluded)', b.unprovenUsage.outputTokens, c.unprovenUsage.outputTokens),
    row('Legacy window usage records (excluded)', b.legacyWindowUsageRecords, c.legacyWindowUsageRecords),
    row('Unscoped window usage records (excluded)', b.unscopedWindowUsageRecords, c.unscopedWindowUsageRecords),
    row('Root acceptance → last linked delivery (includes waits)', b.taskWallMs, c.taskWallMs, duration),
    row('Accepted segment/attempt wall spans (union)', b.segmentWallMs, c.segmentWallMs, duration),
    row('Recorded approval request → decision wait (union)', b.recordedApprovalWaitMs, c.recordedApprovalWaitMs, duration),
    row('Summed SDK latency', b.sdkDurationMs, c.sdkDurationMs, duration),
    row('Summed provider latency', b.providerDurationMs, c.providerDurationMs, duration),
    '', 'Usage records by model', ...keyedRows(b.usageRecordsByModel, c.usageRecordsByModel),
  ];
  const warnings: string[] = [];
  for (const measurement of [b, c]) {
    if (!measurement.usageAttributionCertified) {
      warnings.push(`${measurement.acceptedSource}: incomplete attribution; proven totals are a lower bound, not comparable whole-task cost. ${measurement.usageCertificationIssues.join(', ')}.`);
    }
    if (measurement.uncertifiedUsageCalls > 0 || measurement.invalidUsageCalls > 0) {
      warnings.push(`${measurement.acceptedSource}: ${measurement.uncertifiedUsageCalls} uncertified and ${measurement.invalidUsageCalls} invalid cache-accounting sample(s).`);
    }
    if (measurement.approvalWaitIssues.length > 0) warnings.push(`${measurement.acceptedSource}: ${measurement.approvalWaitIssues.join(', ')}.`);
    if (measurement.malformedEventPayloads > 0 || measurement.malformedUsageLines > 0) {
      warnings.push(`${measurement.acceptedSource}: ${measurement.malformedEventPayloads} malformed session event(s); ${measurement.malformedUsageLines} malformed usage line(s) in the shared log.`);
    }
  }
  if (warnings.length > 0) lines.push('', 'Warnings', ...warnings.map((warning) => `  - ${warning}`));
  lines.push('', 'Task scope follows proved approval continuations only; unrelated follow-up turns are excluded.',
    'Wall spans and approval waits may overlap; do not add them. Unrecorded waits remain unknown.');
  return `${lines.join('\n')}\n`;
}
