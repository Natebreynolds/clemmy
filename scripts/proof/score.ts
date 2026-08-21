/**
 * Proof-harness scorer: a parameterized readout of one isolated home's
 * harness.db (sessions + events), plus the cross-cutting quality checks every
 * scenario applies (narration shapes, provider-error storms, latency).
 *
 * The eventlog queries here are lifted from the ad-hoc root audit-harness.ts
 * readout, parameterized on the DB path instead of the real home. The
 * narration check IMPORTS the runtime's own single-source shape detector so
 * the proof gate always tracks the live guard, never a parallel regex.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import path from 'node:path';

import { looksLikeToolCallShape } from '../../src/runtime/harness/tool-narration-shapes.js';
import {
  canonicalCacheAccounting,
  type UsageEvent,
} from '../../src/runtime/usage-log.js';
import type {
  BrainKind,
  Check,
  ProofModelExpectation,
  TurnLatency,
} from './types.js';

/** Tools whose effect leaves the machine or commits work on the user's behalf —
 *  the converse-first hard line: NONE of these may fire on an ambiguous ask
 *  before alignment. Local reads/recall/shell-in-sandbox are deliberately NOT
 *  here ("recall sharpens the clarifying question" is designed behavior);
 *  external writes are additionally counted via external_write events. */
export const OUTWARD_TOOL_NAMES = new Set([
  'composio_execute_tool',
  'notify_user',
  'workflow_run',
  'dispatch_background_task',
  'run_worker',
  'execution_create',
]);

export interface SessionMetrics {
  sessionId: string;
  status: string;
  kind: string;
  tokensUsed: number;
  turns: number;
  /** Per-tool evidence includes transport mirrors so a proof can assert that
   * call_tool reached the exact deferred inner tool. */
  toolCalls: Record<string, number>;
  /** Per-tool model-issued/canonical calls only. Use this for exact-dispatch
   * assertions; an SDK call plus its local-MCP mirror is one logical action. */
  logicalToolCalls: Record<string, number>;
  /** Model-issued/canonical calls only. A call_tool wrapper and its
   * transport_mirror inner event are one physical decision, not two. */
  toolCallTotal: number;
  /** Durable provider/transport crossings, independent of logical calls. */
  physicalDispatches: number;
  /** Physical crossings explicitly related to an earlier crossing as a retry. */
  retryDispatches: number;
  /** Canonical logical (tool,payload) signatures seen beyond their first use. */
  repeatedIdenticalCalls: number;
  guardrailsTripped: number;
  externalWrites: number;
  autoContinues: number;
  /** run_worker fan-out results (the SDK lane logs worker_result, not tool_called). */
  workerResults: number;
  workerFailures: number;
  completedEvents: number;
  limitExceededEvents: number;
  primerInjectedBytes: number | null;
  latency: TurnLatency[];
  /** Spawn→first real model activity for the session's first SDK query.
   * Falls back to the legacy sdk_first_byte/process-init metric only for proof
   * homes produced before sdk_first_model_activity existed. */
  firstByteMs: number | null;
}

export type ProofUsageRole = 'brain' | 'worker' | 'workflow_step' | 'auxiliary' | 'unattributed';

/** One additive usage row in a proof report. `phase`/`wave` stay null until a
 * usage producer persists those identities explicitly. */
export interface ProofUsageBreakdownRow {
  role: ProofUsageRole;
  model: string;
  phase: string | null;
  wave: string | null;
  attribution: 'explicit_trace_lane' | 'unattributed';
  callCount: number;
  grossPromptTokens: number;
  cacheReadInputTokens: number;
  cacheReadRecordedCalls: number;
  /** Null unless every contributing NDJSON row preserved this provider split. */
  cacheCreationInputTokens: number | null;
  cacheCreationRecordedCalls: number;
  uncachedInputTokens: number;
  outputTokens: number;
  accruedTokens: number;
  cacheHitRatio: number | null;
  /** Defined only for explicit worker rows. */
  zeroCacheCalls: number | null;
  uncertifiedCallCount: number;
  invalidCallCount: number;
}

export interface ProofUsageBreakdown {
  usageRecordCount: number;
  malformedUsageRecordCount: number;
  explicitRoleUsageRecords: number;
  unattributedUsageRecords: number;
  zeroCacheWorkerCalls: number | null;
  rows: ProofUsageBreakdownRow[];
  totals: {
    callCount: number;
    grossPromptTokens: number;
    cacheReadInputTokens: number;
    cacheReadRecordedCalls: number;
    cacheCreationInputTokens: number | null;
    cacheCreationRecordedCalls: number;
    uncachedInputTokens: number;
    outputTokens: number;
    accruedTokens: number;
    cacheHitRatio: number | null;
    sessionTokensUsed: number | null;
    accrualDeltaFromSession: number | null;
  };
  /** Honest boundaries on what the existing ledgers can prove. */
  limitations: string[];
}

export function openHarnessDb(home: string): Database.Database {
  const dbPath = path.join(home, 'state', 'harness.db');
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

interface EventRow { type: string; data_json: string; created_at: string; turn: number }

function tableExists(db: Database.Database, table: string): boolean {
  return Boolean(db.prepare(
    `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`,
  ).get(table));
}

function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 16) return '"[depth-limit]"';
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item, depth + 1)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => (
      `${JSON.stringify(key)}:${canonicalJson(record[key], depth + 1)}`
    )).join(',')}}`;
  }
  return JSON.stringify(String(value));
}

function decodedCarrier(value: unknown): unknown {
  let current = value;
  for (let i = 0; i < 2 && typeof current === 'string'; i += 1) {
    try { current = JSON.parse(current); } catch { break; }
  }
  return current;
}

function logicalCallSignature(data: Record<string, unknown>): string {
  const tool = typeof data.effectiveTool === 'string' && data.effectiveTool.trim()
    ? data.effectiveTool.trim()
    : String(data.tool ?? 'unknown');
  const carrier = data.arguments !== undefined
    ? decodedCarrier(data.arguments)
    : data.args !== undefined
      ? decodedCarrier(data.args)
      : null;
  return `${tool}\u0000${canonicalJson(carrier)}`;
}

function dispatchCounts(
  db: Database.Database,
  sessionId: string,
  events: readonly EventRow[],
): { physicalDispatches: number; retryDispatches: number } {
  if (tableExists(db, 'physical_dispatches')) {
    const row = db.prepare(`
      SELECT COUNT(*) AS total,
             COALESCE(SUM(CASE WHEN relation = 'retry' THEN 1 ELSE 0 END), 0) AS retries
        FROM physical_dispatches
       WHERE session_id = ?
    `).get(sessionId) as { total: number; retries: number };
    return { physicalDispatches: row.total, retryDispatches: row.retries };
  }

  // Archived proof homes predate the normalized table. A start mirror is one
  // crossing; settled mirrors are deliberately ignored to avoid double count.
  let physicalDispatches = 0;
  let retryDispatches = 0;
  for (const event of events) {
    if (event.type !== 'provider_dispatch_started') continue;
    physicalDispatches += 1;
    try {
      const data = JSON.parse(event.data_json) as { relation?: unknown; retryOf?: unknown };
      if (data.relation === 'retry' || typeof data.retryOf === 'string') retryDispatches += 1;
    } catch { /* the crossing still exists; only its retry relation is unknown */ }
  }
  return { physicalDispatches, retryDispatches };
}

export function sessionMetrics(db: Database.Database, sessionId: string): SessionMetrics | null {
  const session = db
    .prepare(`SELECT id, kind, status, tokens_used FROM sessions WHERE id = ?`)
    .get(sessionId) as { id: string; kind: string; status: string; tokens_used: number } | undefined;
  if (!session) return null;

  const events = db
    .prepare(`SELECT type, data_json, created_at, turn FROM events WHERE session_id = ? ORDER BY seq ASC`)
    .all(sessionId) as EventRow[];

  const toolCalls: Record<string, number> = {};
  const logicalToolCalls: Record<string, number> = {};
  let guardrailsTripped = 0;
  let externalWrites = 0;
  const sdkFirstBytes: number[] = [];
  const sdkFirstModelActivities: number[] = [];
  let autoContinues = 0;
  let workerResults = 0;
  let workerFailures = 0;
  let completedEvents = 0;
  let limitExceededEvents = 0;
  let primerInjectedBytes: number | null = null;
  const latency: TurnLatency[] = [];
  let openTurnStartedAt: number | null = null;
  let openTurnFirstAction: number | null = null;
  let canonicalToolCallTotal = 0;
  let repeatedIdenticalCalls = 0;
  const logicalSignatures = new Set<string>();

  for (const ev of events) {
    const ts = Date.parse(ev.created_at);
    switch (ev.type) {
      case 'turn_started':
        if (openTurnStartedAt !== null) {
          latency.push({ wallMs: ts - openTurnStartedAt, ttftMs: openTurnFirstAction !== null ? openTurnFirstAction - openTurnStartedAt : null });
        }
        openTurnStartedAt = ts;
        openTurnFirstAction = null;
        break;
      case 'tool_called': {
        if (openTurnStartedAt !== null && openTurnFirstAction === null) openTurnFirstAction = ts;
        let name = 'unknown';
        let accounting = '';
        try {
          const data = JSON.parse(ev.data_json) as Record<string, unknown>;
          name = String(data.tool ?? 'unknown');
          accounting = String(data.accounting ?? '');
          if (accounting !== 'transport_mirror') {
            const signature = logicalCallSignature(data);
            if (logicalSignatures.has(signature)) repeatedIdenticalCalls += 1;
            else logicalSignatures.add(signature);
          }
        } catch { /* keep unknown */ }
        toolCalls[name] = (toolCalls[name] ?? 0) + 1;
        if (accounting !== 'transport_mirror') {
          logicalToolCalls[name] = (logicalToolCalls[name] ?? 0) + 1;
          canonicalToolCallTotal += 1;
        }
        break;
      }
      case 'turn_ended':
        if (openTurnStartedAt !== null) {
          latency.push({ wallMs: ts - openTurnStartedAt, ttftMs: openTurnFirstAction !== null ? openTurnFirstAction - openTurnStartedAt : null });
          openTurnStartedAt = null;
          openTurnFirstAction = null;
        }
        break;
      case 'worker_result': {
        workerResults += 1;
        try { if ((JSON.parse(ev.data_json) as { ok?: boolean }).ok === false) workerFailures += 1; } catch { /* count as ok */ }
        break;
      }
      case 'sdk_first_byte': {
        try {
          const data = JSON.parse(ev.data_json) as { firstByteMs?: number };
          if (typeof data.firstByteMs === 'number') sdkFirstBytes.push(data.firstByteMs);
        } catch { /* ignore malformed */ }
        break;
      }
      case 'sdk_first_model_activity': {
        try {
          const data = JSON.parse(ev.data_json) as { firstModelActivityMs?: number };
          if (typeof data.firstModelActivityMs === 'number') {
            sdkFirstModelActivities.push(data.firstModelActivityMs);
          }
        } catch { /* ignore malformed */ }
        break;
      }
      case 'guardrail_tripped': guardrailsTripped += 1; break;
      case 'external_write': externalWrites += 1; break;
      case 'sdk_auto_continue': autoContinues += 1; break;
      case 'conversation_completed': completedEvents += 1; break;
      case 'conversation_limit_exceeded': limitExceededEvents += 1; break;
      case 'turn_memory_primer': {
        try {
          const data = JSON.parse(ev.data_json) as { injectedBytes?: number };
          if (typeof data.injectedBytes === 'number') {
            primerInjectedBytes = Math.max(primerInjectedBytes ?? 0, data.injectedBytes);
          }
        } catch { /* ignore malformed */ }
        break;
      }
      default:
        // TTFT counts only the model's first ACTION (tool_called above, or the
        // turn ending with a pure-text reply) — infra events like the memory
        // primer or context packets are harness prep, not model output.
        break;
    }
  }

  const turns = events.filter((e) => e.type === 'turn_started').length;
  const dispatches = dispatchCounts(db, sessionId, events);
  return {
    sessionId,
    status: session.status,
    kind: session.kind,
    tokensUsed: session.tokens_used,
    turns,
    toolCalls,
    logicalToolCalls,
    toolCallTotal: canonicalToolCallTotal,
    ...dispatches,
    repeatedIdenticalCalls,
    guardrailsTripped,
    externalWrites,
    autoContinues,
    workerResults,
    workerFailures,
    completedEvents,
    limitExceededEvents,
    primerInjectedBytes,
    latency,
    firstByteMs: sdkFirstModelActivities[0] ?? sdkFirstBytes[0] ?? null,
  };
}

/** List every session in the DB with headline counts (for --score-only). */
export function summarizeAllSessions(db: Database.Database): SessionMetrics[] {
  const rows = db.prepare(`SELECT id FROM sessions ORDER BY updated_at DESC`).all() as { id: string }[];
  return rows.map((r) => sessionMetrics(db, r.id)).filter((m): m is SessionMetrics => m !== null);
}

type ProofUsageEvent = UsageEvent & { cacheCreationInputTokens?: number };

function finiteNonNegative(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function explicitProofUsageRole(event: ProofUsageEvent): ProofUsageRole {
  switch (event.trace?.lane) {
    case 'brain': return 'brain';
    case 'worker': return 'worker';
    case 'workflow_step': return 'workflow_step';
    case 'auxiliary': return 'auxiliary';
    default: return 'unattributed';
  }
}

function roundedRatio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return Math.round((numerator / denominator) * 10_000) / 10_000;
}

function readProofUsageEvents(
  home: string,
  sessionId: string,
): { events: ProofUsageEvent[]; malformed: number; directoryReadable: boolean } {
  const usageDir = path.join(home, 'state', 'token-usage');
  const events: ProofUsageEvent[] = [];
  let malformed = 0;
  try {
    for (const file of readdirSync(usageDir).filter((name) => name.endsWith('.ndjson')).sort()) {
      for (const line of readFileSync(path.join(usageDir, file), 'utf-8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as ProofUsageEvent;
          if (event.source === sessionId) events.push(event);
        } catch {
          malformed += 1;
        }
      }
    }
    return { events, malformed, directoryReadable: true };
  } catch {
    return { events, malformed, directoryReadable: false };
  }
}

function proofSessionTokensUsed(home: string, sessionId: string): number | null {
  let db: Database.Database | null = null;
  try {
    db = openHarnessDb(home);
    const row = db.prepare('SELECT tokens_used FROM sessions WHERE id = ?').get(sessionId) as {
      tokens_used?: unknown;
    } | undefined;
    return typeof row?.tokens_used === 'number' && Number.isFinite(row.tokens_used)
      ? row.tokens_used
      : null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/**
 * Proof-only usage attribution for one durable session.
 *
 * Role comes ONLY from the persisted trace lane. Model comes ONLY from the
 * usage row. We deliberately do not infer worker/brain identity from model id,
 * prompt size, timestamps, or event adjacency: concurrent fan-out makes those
 * attractive but non-authoritative. The current usage envelope carries no
 * manifest phase/wave identity, so both remain null until a producer records
 * them explicitly.
 */
export function sessionUsageBreakdown(home: string, sessionId: string): ProofUsageBreakdown {
  const read = readProofUsageEvents(home, sessionId);
  type Accumulator = Omit<ProofUsageBreakdownRow,
    'cacheCreationInputTokens' | 'cacheHitRatio' | 'zeroCacheCalls'> & {
      cacheCreationInputTokensKnown: number;
      workerUsageRecordCount: number;
      zeroCacheDerivableCalls: number;
      zeroCacheCallsKnown: number;
    };
  const groups = new Map<string, Accumulator>();

  let explicitRoleUsageRecords = 0;
  let unattributedUsageRecords = 0;
  let zeroCacheWorkerCallsKnown = 0;
  let workerUsageRecordCount = 0;
  let zeroCacheDerivableWorkerCalls = 0;
  let totalGrossPromptTokens = 0;
  let totalCacheReadInputTokens = 0;
  let totalCacheReadRecordedCalls = 0;
  let totalCacheCreationInputTokensKnown = 0;
  let totalCacheCreationRecordedCalls = 0;
  let totalUncachedInputTokens = 0;
  let totalOutputTokens = 0;
  let totalAccruedTokens = 0;

  for (const event of read.events) {
    const role = explicitProofUsageRole(event);
    const attribution = role === 'unattributed' ? 'unattributed' : 'explicit_trace_lane';
    if (role === 'unattributed') unattributedUsageRecords += 1;
    else explicitRoleUsageRecords += 1;
    const model = typeof event.model === 'string' && event.model.trim()
      ? event.model.trim()
      : '(unknown)';
    // Phase/wave are intentionally null: neither is present in UsageEvent's
    // trace envelope today, and no proof result may reconstruct them by timing.
    const phase = null;
    const wave = null;
    const key = JSON.stringify([role, model, phase, wave, attribution]);
    let group = groups.get(key);
    if (!group) {
      group = {
        role,
        model,
        phase,
        wave,
        attribution,
        callCount: 0,
        grossPromptTokens: 0,
        cacheReadInputTokens: 0,
        cacheReadRecordedCalls: 0,
        cacheCreationInputTokensKnown: 0,
        cacheCreationRecordedCalls: 0,
        uncachedInputTokens: 0,
        outputTokens: 0,
        accruedTokens: 0,
        workerUsageRecordCount: 0,
        zeroCacheDerivableCalls: 0,
        zeroCacheCallsKnown: 0,
        uncertifiedCallCount: 0,
        invalidCallCount: 0,
      };
      groups.set(key, group);
    }

    const accounting = canonicalCacheAccounting(event);
    const cacheReadRecorded = event.cacheDialect === 'none'
      || (
        typeof event.cachedInputTokens === 'number'
        && Number.isFinite(event.cachedInputTokens)
        && event.cachedInputTokens >= 0
      );
    const creationRecorded = typeof event.cacheCreationInputTokens === 'number'
      && Number.isFinite(event.cacheCreationInputTokens)
      && event.cacheCreationInputTokens >= 0;
    group.callCount += 1;
    group.grossPromptTokens += accounting.promptTokens;
    group.cacheReadInputTokens += accounting.cachedReadTokens;
    if (cacheReadRecorded) {
      group.cacheReadRecordedCalls += 1;
      totalCacheReadRecordedCalls += 1;
    }
    group.uncachedInputTokens += accounting.uncachedInputTokens;
    group.outputTokens += finiteNonNegative(event.outputTokens);
    group.accruedTokens += accounting.uncachedWorkTokens;
    if (!accounting.certified) group.uncertifiedCallCount += 1;
    if (accounting.invalid) group.invalidCallCount += 1;
    if (creationRecorded) {
      group.cacheCreationInputTokensKnown += event.cacheCreationInputTokens as number;
      group.cacheCreationRecordedCalls += 1;
      totalCacheCreationInputTokensKnown += event.cacheCreationInputTokens as number;
      totalCacheCreationRecordedCalls += 1;
    }
    if (role === 'worker') {
      group.workerUsageRecordCount += 1;
      workerUsageRecordCount += 1;
      if (accounting.certified && !accounting.invalid && accounting.promptTokens > 0 && cacheReadRecorded) {
        group.zeroCacheDerivableCalls += 1;
        zeroCacheDerivableWorkerCalls += 1;
        if (accounting.cachedReadTokens === 0) {
          group.zeroCacheCallsKnown += 1;
          zeroCacheWorkerCallsKnown += 1;
        }
      }
    }

    totalGrossPromptTokens += accounting.promptTokens;
    totalCacheReadInputTokens += accounting.cachedReadTokens;
    totalUncachedInputTokens += accounting.uncachedInputTokens;
    totalOutputTokens += finiteNonNegative(event.outputTokens);
    totalAccruedTokens += accounting.uncachedWorkTokens;
  }

  const roleOrder: Record<ProofUsageRole, number> = {
    brain: 0,
    worker: 1,
    workflow_step: 2,
    auxiliary: 3,
    unattributed: 4,
  };
  const rows: ProofUsageBreakdownRow[] = [...groups.values()]
    .map((group) => ({
      role: group.role,
      model: group.model,
      phase: group.phase,
      wave: group.wave,
      attribution: group.attribution,
      callCount: group.callCount,
      grossPromptTokens: group.grossPromptTokens,
      cacheReadInputTokens: group.cacheReadInputTokens,
      cacheReadRecordedCalls: group.cacheReadRecordedCalls,
      cacheCreationInputTokens: group.cacheCreationRecordedCalls === group.callCount
        ? group.cacheCreationInputTokensKnown
        : null,
      cacheCreationRecordedCalls: group.cacheCreationRecordedCalls,
      uncachedInputTokens: group.uncachedInputTokens,
      outputTokens: group.outputTokens,
      accruedTokens: group.accruedTokens,
      cacheHitRatio: group.cacheReadRecordedCalls === group.callCount
        ? roundedRatio(group.cacheReadInputTokens, group.grossPromptTokens)
        : null,
      zeroCacheCalls: group.role === 'worker'
        && group.workerUsageRecordCount > 0
        && group.zeroCacheDerivableCalls === group.workerUsageRecordCount
        ? group.zeroCacheCallsKnown
        : null,
      uncertifiedCallCount: group.uncertifiedCallCount,
      invalidCallCount: group.invalidCallCount,
    }))
    .sort((a, b) => (
      roleOrder[a.role] - roleOrder[b.role]
      || a.model.localeCompare(b.model)
    ));

  const sessionTokensUsed = proofSessionTokensUsed(home, sessionId);
  const limitations = [
    'phase and wave are unavailable: usage traces do not currently record manifest identity',
    'callCount counts durable usage records; an SDK record may aggregate provider-internal activity',
  ];
  if (!read.directoryReadable) limitations.push('token-usage directory was unavailable');
  if (unattributedUsageRecords > 0) {
    limitations.push('rows without an explicit supported trace lane remain unattributed; model/timestamp inference is forbidden');
  }
  if (totalCacheCreationRecordedCalls < read.events.length) {
    limitations.push('cache-creation tokens are null where the provider split was not persisted');
  }
  if (totalCacheReadRecordedCalls < read.events.length) {
    limitations.push('cache-hit ratio and zero-cache worker counts are null where cache-read presence was not explicit');
  }
  if (rows.some((row) => row.uncertifiedCallCount > 0)) {
    limitations.push('one or more usage rows have uncertified cache accounting');
  }
  if (read.malformed > 0) limitations.push('malformed usage rows were excluded');

  return {
    usageRecordCount: read.events.length,
    malformedUsageRecordCount: read.malformed,
    explicitRoleUsageRecords,
    unattributedUsageRecords,
    zeroCacheWorkerCalls: workerUsageRecordCount > 0
      && zeroCacheDerivableWorkerCalls === workerUsageRecordCount
      ? zeroCacheWorkerCallsKnown
      : null,
    rows,
    totals: {
      callCount: read.events.length,
      grossPromptTokens: totalGrossPromptTokens,
      cacheReadInputTokens: totalCacheReadInputTokens,
      cacheReadRecordedCalls: totalCacheReadRecordedCalls,
      cacheCreationInputTokens: totalCacheCreationRecordedCalls === read.events.length
        ? totalCacheCreationInputTokensKnown
        : null,
      cacheCreationRecordedCalls: totalCacheCreationRecordedCalls,
      uncachedInputTokens: totalUncachedInputTokens,
      outputTokens: totalOutputTokens,
      accruedTokens: totalAccruedTokens,
      cacheHitRatio: read.events.length > 0
        && totalCacheReadRecordedCalls === read.events.length
        ? roundedRatio(totalCacheReadInputTokens, totalGrossPromptTokens)
        : null,
      sessionTokensUsed,
      accrualDeltaFromSession: sessionTokensUsed === null
        ? null
        : totalAccruedTokens - sessionTokensUsed,
    },
    limitations,
  };
}

type ServedModelFamily = 'claude' | 'codex' | 'byo';

interface RouteMarker {
  provider?: unknown;
  model?: unknown;
  modelId?: unknown;
  effectiveModel?: unknown;
  transport?: unknown;
  modelRoute?: unknown;
}

function routeModelId(data: RouteMarker): string | null {
  for (const value of [data.effectiveModel, data.model, data.modelId]) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function routeFamily(data: RouteMarker): ServedModelFamily | null {
  if (data.provider === 'claude' || data.provider === 'codex' || data.provider === 'byo') {
    return data.provider;
  }
  const transport = typeof data.transport === 'string' ? data.transport.toLowerCase() : '';
  if (transport.includes('claude_agent_sdk')) return 'claude';
  const model = (routeModelId(data) ?? '').toLowerCase();
  if (!model) return null;
  if (model.includes('claude')) return 'claude';
  if (/^(gpt|o\d)|codex/.test(model)) return 'codex';
  return 'byo';
}

export interface SessionRouteEvidence {
  markerCount: number;
  explicitProviderCount: number;
  explicitModelCount: number;
  families: ServedModelFamily[];
  modelIds: string[];
  falloverCount: number;
}

/** Exact model ids from the append-only usage stream, scoped to the scenario
 * session(s). Warmups and unrelated proof scenarios can never satisfy this
 * evidence because UsageEvent.source is the harness session id. */
export function sessionUsageModelIds(home: string, sessionIds: Iterable<string>): string[] {
  const wanted = new Set([...sessionIds].filter(Boolean));
  if (wanted.size === 0) return [];
  const models: string[] = [];
  const usageDir = path.join(home, 'state', 'token-usage');
  try {
    for (const file of readdirSync(usageDir)) {
      if (!file.endsWith('.ndjson')) continue;
      const lines = readFileSync(path.join(usageDir, file), 'utf-8').split('\n');
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line) as { source?: unknown; model?: unknown };
          if (
            typeof event.source === 'string'
            && wanted.has(event.source)
            && typeof event.model === 'string'
            && event.model.trim()
          ) {
            models.push(event.model.trim());
          }
        } catch {
          /* malformed rows are absent evidence */
        }
      }
    }
  } catch {
    /* missing usage directory remains empty evidence */
  }
  return models;
}

function sessionFalloverCount(home: string, sessionId: string): number {
  const operationalPath = path.join(home, 'state', 'operational-telemetry.db');
  if (!existsSync(operationalPath)) return 0;
  try {
    const operational = new Database(operationalPath, { readonly: true, fileMustExist: true });
    const row = operational.prepare(
      "SELECT COUNT(*) AS count FROM operational_events WHERE session_id = ? AND type = 'model_fallover'",
    ).get(sessionId) as { count?: number } | undefined;
    operational.close();
    return Number(row?.count ?? 0);
  } catch {
    return 0;
  }
}

/** Route evidence for exactly one proof session. Provider metadata wins over
 * model-name inference so a BYO backend serving `gpt-*` is never called Codex. */
export function sessionRouteEvidence(home: string, sessionId: string): SessionRouteEvidence {
  const db = openHarnessDb(home);
  const rows = db.prepare(
    "SELECT data_json FROM events WHERE session_id = ? AND type = 'turn_model_routed' ORDER BY seq ASC",
  ).all(sessionId) as Array<{ data_json: string }>;
  db.close();

  let explicitProviderCount = 0;
  let explicitModelCount = 0;
  const families: ServedModelFamily[] = [];
  const modelIds: string[] = [];
  for (const row of rows) {
    try {
      const data = JSON.parse(row.data_json) as RouteMarker;
      if (data.provider === 'claude' || data.provider === 'codex' || data.provider === 'byo') {
        explicitProviderCount += 1;
      }
      const family = routeFamily(data);
      if (family) families.push(family);
      const modelId = routeModelId(data);
      if (modelId) {
        explicitModelCount += 1;
        modelIds.push(modelId);
      }
    } catch { /* malformed telemetry is missing evidence */ }
  }

  return {
    markerCount: rows.length,
    explicitProviderCount,
    explicitModelCount,
    families,
    modelIds,
    falloverCount: sessionFalloverCount(home, sessionId),
  };
}

/** Exact-route proof for a multi-turn scenario. Every expected turn must carry
 * explicit provider identity, all markers must name only the requested brain,
 * and no same-session model fallover may have occurred. */
export function exactBrainRouteChecks(
  home: string,
  sessionId: string,
  brain: BrainKind,
  expectedTurns: number,
  expectedModel: ProofModelExpectation,
): Check[] {
  const expected: ServedModelFamily = brain === 'glm' ? 'byo' : brain;
  const evidence = sessionRouteEvidence(home, sessionId);
  const unique = [...new Set(evidence.families)];
  const models = [...new Set(evidence.modelIds)];
  const markerDetail = `markers ${evidence.markerCount}, explicit providers ${evidence.explicitProviderCount}, explicit models ${evidence.explicitModelCount}, families [${unique.join(', ') || 'none'}], models [${models.join(', ') || 'none'}]`;
  return [
    {
      name: `all ${expectedTurns} turns carry explicit provider identity`,
      pass: evidence.markerCount >= expectedTurns && evidence.explicitProviderCount === evidence.markerCount,
      detail: markerDetail,
    },
    {
      name: `session served only by the requested ${expected} brain`,
      pass: unique.length === 1 && unique[0] === expected,
      detail: markerDetail,
    },
    {
      name: `session route used exact configured brain model ${expectedModel.modelId || '(missing)'}`,
      pass: Boolean(expectedModel.modelId)
        && evidence.markerCount >= expectedTurns
        && evidence.explicitModelCount === evidence.markerCount
        && models.length === 1
        && models[0] === expectedModel.modelId,
      detail: `${markerDetail}; expected ${expectedModel.provider}:${expectedModel.modelId || '(missing)'} from ${expectedModel.source}`,
    },
    {
      name: 'no same-session model fallover',
      pass: evidence.falloverCount === 0,
      detail: `${evidence.falloverCount} model_fallover event(s)`,
    },
  ];
}

export interface WorkflowStepRouteEvidence extends SessionRouteEvidence {
  transports: string[];
}

/** Workflow steps use two route markers: normal Codex/BYO harness steps emit
 * `turn_model_routed`, while the Claude Agent SDK step lane emits
 * `worker_model_routed` with its normalized route nested under `modelRoute`.
 * Read both so the release matrix proves the provider and transport that served
 * this exact step session, rather than accepting an unrelated daemon call. */
export function workflowStepRouteEvidence(home: string, sessionId: string): WorkflowStepRouteEvidence {
  const db = openHarnessDb(home);
  const rows = db.prepare(
    "SELECT data_json FROM events WHERE session_id = ? AND type IN ('turn_model_routed', 'worker_model_routed') ORDER BY seq ASC",
  ).all(sessionId) as Array<{ data_json: string }>;
  db.close();

  let explicitProviderCount = 0;
  let explicitModelCount = 0;
  const families: ServedModelFamily[] = [];
  const modelIds: string[] = [];
  const transports: string[] = [];
  for (const row of rows) {
    try {
      const outer = JSON.parse(row.data_json) as RouteMarker;
      const nested = outer.modelRoute && typeof outer.modelRoute === 'object'
        ? outer.modelRoute as RouteMarker
        : null;
      const marker = nested ?? outer;
      if (marker.provider === 'claude' || marker.provider === 'codex' || marker.provider === 'byo') {
        explicitProviderCount += 1;
      }
      const family = routeFamily(marker);
      if (family) families.push(family);
      const modelId = routeModelId(marker);
      if (modelId) {
        explicitModelCount += 1;
        modelIds.push(modelId);
      }
      if (typeof marker.transport === 'string' && marker.transport.trim()) {
        transports.push(marker.transport.trim());
      }
    } catch { /* malformed telemetry is missing evidence */ }
  }

  return {
    markerCount: rows.length,
    explicitProviderCount,
    explicitModelCount,
    families,
    modelIds,
    transports,
    falloverCount: sessionFalloverCount(home, sessionId),
  };
}

/** Exact provider + transport proof for one workflow-step session. */
export function exactWorkflowStepRouteChecks(
  home: string,
  sessionId: string,
  brain: BrainKind,
  expectedModel: ProofModelExpectation,
): Check[] {
  const expectedFamily: ServedModelFamily = brain === 'glm' ? 'byo' : brain;
  const expectedTransport = brain === 'claude'
    ? 'claude_agent_sdk_workflow_step'
    : brain === 'codex'
      ? 'openai_agents_harness'
      : 'host_harness';
  const evidence = workflowStepRouteEvidence(home, sessionId);
  const families = [...new Set(evidence.families)];
  const models = [...new Set(evidence.modelIds)];
  const transports = [...new Set(evidence.transports)];
  const detail = `markers ${evidence.markerCount}, providers ${evidence.explicitProviderCount}, models [${models.join(', ') || 'none'}], families [${families.join(', ') || 'none'}], transports [${transports.join(', ') || 'none'}]`;
  return [
    {
      name: 'workflow step carries explicit provider identity',
      pass: evidence.markerCount >= 1 && evidence.explicitProviderCount >= 1,
      detail,
    },
    {
      name: `workflow step served only by the requested ${expectedFamily} brain`,
      pass: families.length === 1 && families[0] === expectedFamily,
      detail,
    },
    {
      name: `workflow step used exact configured brain model ${expectedModel.modelId || '(missing)'}`,
      pass: Boolean(expectedModel.modelId)
        && evidence.explicitModelCount === evidence.markerCount
        && models.length === 1
        && models[0] === expectedModel.modelId,
      detail: `${detail}; expected ${expectedModel.provider}:${expectedModel.modelId || '(missing)'} from ${expectedModel.source}`,
    },
    {
      name: `workflow step used ${expectedTransport}`,
      pass: transports.length === 1 && transports[0] === expectedTransport,
      detail,
    },
    {
      name: 'no workflow-step model fallover',
      pass: evidence.falloverCount === 0,
      detail: `${evidence.falloverCount} model_fallover event(s)`,
    },
  ];
}

/** Exact worker-role proof for scenarios that deliberately fan out. Provider
 * metadata remains authoritative, so a gpt-shaped BYO model stays BYO. */
export function exactWorkerRouteChecks(
  home: string,
  sessionId: string,
  expectedModel: ProofModelExpectation,
): Check[] {
  const db = openHarnessDb(home);
  const rows = db.prepare(
    "SELECT data_json FROM events WHERE session_id = ? AND type = 'worker_model_routed' ORDER BY seq ASC",
  ).all(sessionId) as Array<{ data_json: string }>;
  db.close();
  const models: string[] = [];
  const providers: string[] = [];
  for (const row of rows) {
    try {
      const outer = JSON.parse(row.data_json) as RouteMarker;
      const marker = outer.modelRoute && typeof outer.modelRoute === 'object'
        ? outer.modelRoute as RouteMarker
        : outer;
      const model = routeModelId(marker);
      if (model) models.push(model);
      if (marker.provider === 'claude' || marker.provider === 'codex' || marker.provider === 'byo') {
        providers.push(marker.provider);
      }
    } catch { /* malformed marker is missing evidence */ }
  }
  const usage = sessionUsageModelIds(home, [sessionId]);
  const detail = `markers ${rows.length}; providers [${[...new Set(providers)].join(', ') || 'none'}]; models [${[...new Set(models)].join(', ') || 'none'}]; usage [${[...new Set(usage)].join(', ') || 'none'}]`;
  return [
    {
      name: `worker routes used exact configured model ${expectedModel.modelId || '(missing)'}`,
      pass: Boolean(expectedModel.modelId)
        && rows.length > 0
        && models.length === rows.length
        && models.every((model) => model === expectedModel.modelId),
      detail,
    },
    {
      name: `worker routes carried explicit ${expectedModel.provider} identity`,
      pass: rows.length > 0
        && providers.length === rows.length
        && providers.every((provider) => provider === expectedModel.provider),
      detail,
    },
    {
      name: `worker usage proves exact model ${expectedModel.modelId || '(missing)'}`,
      pass: Boolean(expectedModel.modelId) && usage.includes(expectedModel.modelId),
      detail,
    },
  ];
}

/** Whole-leg backstop: a pre-dispatch route marker is not enough. At least one
 * completed call in the scenario sessions must name the exact configured id.
 * The runner additionally invokes this check per exact-brain route session. */
export function exactBrainServedChecks(
  home: string,
  sessionIds: Iterable<string>,
  expectedModel: ProofModelExpectation,
): Check[] {
  const ids = [...new Set([...sessionIds].filter(Boolean))];
  const usageModels = sessionUsageModelIds(home, ids);
  const uniqueUsage = [...new Set(usageModels)];
  return [
    {
      name: 'configured brain expectation is present',
      pass: Boolean(expectedModel.modelId),
      detail: `expected ${expectedModel.provider}:${expectedModel.modelId || '(missing)'} from ${expectedModel.source}`,
    },
    {
      name: `session-scoped usage proves model ${expectedModel.modelId || '(missing)'} completed a call`,
      pass: Boolean(expectedModel.modelId) && usageModels.includes(expectedModel.modelId),
      detail: `sessions ${ids.length}; usage models [${uniqueUsage.join(', ') || 'none'}]`,
    },
  ];
}

/** A release proof runs with Second Opinion/Fusion explicitly disabled. Check
 * the session-scoped operational ledger as well as the environment pin: a
 * fusion reconciliation that somehow bypasses the setting must make the leg
 * fail instead of hiding behind a green task result. */
export function fusionDisabledChecks(home: string, sessionId: string): Check[] {
  const operationalPath = path.join(home, 'state', 'operational-telemetry.db');
  if (!existsSync(operationalPath)) {
    return [{
      name: 'Fusion-off evidence is readable',
      pass: false,
      detail: 'operational telemetry database is missing',
    }];
  }
  try {
    const db = new Database(operationalPath, { readonly: true, fileMustExist: true });
    const row = db.prepare(
      "SELECT COUNT(*) AS count FROM operational_events WHERE actor = 'fusion'",
    ).get() as { count?: number } | undefined;
    db.close();
    const count = Number(row?.count ?? 0);
    return [{
      name: 'Fusion stayed off',
      pass: count === 0,
      detail: `${count} fusion reconciliation event(s) in isolated proof home (scoring session ${sessionId})`,
    }];
  } catch (error) {
    return [{
      name: 'Fusion-off evidence is readable',
      pass: false,
      detail: error instanceof Error ? error.message : String(error),
    }];
  }
}

/** Dedicated Fusion canary: prove that the exact configured checker—not merely
 * some distinct family/default—returned the bounded verdict contract for this
 * session, and that the committed response respected the correction ceiling. */
export function fusionBoundedChecks(
  home: string,
  sessionId: string,
  brain: BrainKind,
  expectedChecker: ProofModelExpectation,
): Check[] {
  const operationalPath = path.join(home, 'state', 'operational-telemetry.db');
  if (!existsSync(operationalPath)) {
    return [{ name: 'bounded Fusion evidence is readable', pass: false, detail: 'operational telemetry database is missing' }];
  }
  let rows: Array<{ payload_json?: string }> = [];
  try {
    const db = new Database(operationalPath, { readonly: true, fileMustExist: true });
    rows = db.prepare(
      "SELECT payload_json FROM operational_events WHERE actor = 'fusion' AND session_id = ? ORDER BY ts ASC",
    ).all(sessionId) as Array<{ payload_json?: string }>;
    db.close();
  } catch (error) {
    return [{ name: 'bounded Fusion evidence is readable', pass: false, detail: error instanceof Error ? error.message : String(error) }];
  }

  const payloads = rows.map((row) => {
    try { return JSON.parse(row.payload_json ?? '{}') as { outcome?: string; judgeModel?: string }; } catch { return {}; }
  });
  const outcomes = payloads.map((payload) => payload.outcome ?? '(missing)');
  const boundedOutcomes = new Set(['checker-accepted-draft', 'checker-corrected-draft']);
  const brainFamily = brain === 'glm' ? 'byo' : brain;
  const judgeModels = payloads
    .map((payload) => payload.judgeModel)
    .filter((model): model is string => typeof model === 'string' && model.length > 0);
  const judgeFamilies = payloads
    .map((payload) => payload.judgeModel?.split(':', 1)[0])
    .filter((family): family is string => Boolean(family));
  const usageModels = sessionUsageModelIds(home, [sessionId]);
  const uniqueUsageModels = [...new Set(usageModels)];
  const expectedJudgeLabel = expectedChecker.modelId
    ? `${expectedChecker.provider}:${expectedChecker.modelId}`
    : '';

  let traceDetail = 'session trace missing';
  let boundedLength = false;
  try {
    const tracePath = path.join(home, 'state', 'debate-traces.jsonl');
    const traces = readFileSync(tracePath, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line) as { sessionId?: string; outcome?: string; executorLen?: number; finalLen?: number }; } catch { return {}; }
      })
      .filter((trace) => trace.sessionId === sessionId && typeof trace.outcome === 'string');
    const trace = traces.at(-1);
    if (trace && typeof trace.executorLen === 'number' && typeof trace.finalLen === 'number') {
      const limit = trace.executorLen >= 24_000
        ? trace.executorLen
        : Math.min(24_000, Math.max(trace.executorLen + 800, Math.ceil(trace.executorLen * 1.5)));
      boundedLength = trace.finalLen <= limit;
      traceDetail = `executor ${trace.executorLen} chars → final ${trace.finalLen} chars (limit ${limit}); ${trace.outcome}`;
    }
  } catch {
    /* missing/partial trace fails the length check below */
  }

  return [
    {
      name: 'exactly one bounded Fusion verdict ran',
      pass: rows.length === 1 && outcomes.every((outcome) => boundedOutcomes.has(outcome)),
      detail: `${rows.length} event(s): ${outcomes.join(', ')}`,
    },
    {
      name: 'configured Fusion checker expectation is present',
      pass: Boolean(expectedChecker.modelId),
      detail: `expected ${expectedJudgeLabel || '(missing)'} from ${expectedChecker.source}`,
    },
    {
      name: `Fusion verdict names exact configured checker ${expectedChecker.modelId || '(missing)'}`,
      pass: Boolean(expectedJudgeLabel)
        && judgeModels.length === 1
        && judgeModels[0] === expectedJudgeLabel,
      detail: `expected ${expectedJudgeLabel || '(missing)'}; verdict telemetry [${judgeModels.join(', ') || 'missing'}]`,
    },
    {
      name: `Fusion checker usage proves exact model ${expectedChecker.modelId || '(missing)'}`,
      pass: Boolean(expectedChecker.modelId) && usageModels.includes(expectedChecker.modelId),
      detail: `session usage models [${uniqueUsageModels.join(', ') || 'none'}]`,
    },
    {
      name: 'Fusion checker used a distinct model family',
      pass: judgeFamilies.length === 1
        && judgeFamilies[0] === expectedChecker.provider
        && judgeFamilies[0] !== brainFamily,
      detail: `brain ${brainFamily}; expected checker family ${expectedChecker.provider}; actual [${judgeFamilies.join(', ') || 'missing'}]`,
    },
    {
      name: 'Fusion final stayed inside the deterministic correction bound',
      pass: boundedLength,
      detail: traceDetail,
    },
  ];
}

// ─── Cross-cutting checks ───────────────────────────────────────────────────

export function narrationCheck(replyText: string): Check {
  const leak = looksLikeToolCallShape(replyText);
  return { name: 'no narration leak', pass: !leak, detail: leak ? replyText.slice(0, 160) : undefined };
}

const STORM_RE = /\b(429|529)\b|too many requests|overloaded/gi;

export function stormCheck(daemonLog: string, threshold = 3): Check {
  const count = (daemonLog.match(STORM_RE) ?? []).length;
  return {
    name: `no provider-error storm (<${threshold + 1} hits)`,
    pass: count <= threshold,
    detail: count > 0 ? `${count} transient-error markers in daemon log` : undefined,
  };
}

export function reportBackCheck(replyText: string): Check {
  return { name: 'report-back non-empty', pass: replyText.trim().length > 0 };
}

export function tokenCeilingCheck(metrics: SessionMetrics | null, ceiling: number): Check {
  if (!metrics) {
    return {
      name: `tokens ≤ ${ceiling}`,
      pass: false,
      detail: 'session metrics unavailable; token use cannot be proven',
    };
  }
  return {
    name: `tokens ≤ ${ceiling}`,
    pass: metrics.tokensUsed <= ceiling,
    detail: `${metrics.tokensUsed} used`,
  };
}
