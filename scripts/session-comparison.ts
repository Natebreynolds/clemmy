import { existsSync, readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { canonicalCacheAccounting, type UsageEvent } from '../src/runtime/usage-log.js';
import { projectCanonicalTopLevelToolEvents } from '../src/runtime/harness/tool-effect.js';
import { presentationEventFromCompletionData } from '../src/runtime/harness/turn-outcome.js';

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
  const topLevelToolSearches = canonicalCalls.filter((event) => semanticToolName(event.data) === 'tool_search').length;
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

  const terminalCandidates: SessionEvent[] = [];
  for (const event of sessionRead.events) {
    if (event.seq <= source.seq || event.type !== 'conversation_completed') continue;
    const owner = terminalOwnerClaims(event.data);
    let presentation: ReturnType<typeof presentationEventFromCompletionData> = null;
    try {
      presentation = presentationEventFromCompletionData(event.data);
    } catch {
      if (owner.claims.has(sourceUserSeq)) {
        throw new Error(`Terminal ${event.seq} has a corrupt typed projection for ${sessionId}:${sourceUserSeq}`);
      }
      continue;
    }
    if (
      !presentation
      || presentation.identity.sessionId !== sessionId
      || presentation.identity.sourceUserSeq !== sourceUserSeq
      || presentation.identity.turn !== source.turn
    ) {
      if (owner.claims.has(sourceUserSeq)) {
        throw new Error(`Terminal ${event.seq} has contradictory ownership for ${sessionId}:${sourceUserSeq}`);
      }
      continue;
    }
    terminalCandidates.push(event);
  }
  if (terminalCandidates.length === 0) {
    throw new Error(`No owned conversation_completed terminal for ${sessionId}:${sourceUserSeq}`);
  }
  if (terminalCandidates.length > 1) {
    throw new Error(`Ambiguous terminals for ${sessionId}:${sourceUserSeq}: ${terminalCandidates.map((event) => event.seq).join(', ')}`);
  }
  const terminal = terminalCandidates[0];
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
  };
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
