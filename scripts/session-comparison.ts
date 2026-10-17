import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { canonicalCacheAccounting, type UsageEvent } from '../src/runtime/usage-log.js';
import { projectCanonicalTopLevelToolEvents } from '../src/runtime/harness/tool-effect.js';
import { presentationEventFromCompletionData } from '../src/runtime/harness/turn-outcome.js';
import { readApprovalExecutionSource } from '../src/runtime/harness/approval-execution-source.js';
import { readAcceptedTaskNoticingParticipants } from './lib/accepted-task-noticing-participants.js';
import { readAcceptedTaskWorkflowCandidates } from './lib/accepted-task-workflow-candidates.js';
import { selectAcceptedTaskNoticingUsage, type NoticingAccountingParticipant } from './lib/accepted-task-noticing-usage.js';

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

/** Attribution and token normalization do not enumerate every physical model
 * leg. No sealed all-leg inventory or billing evidence is read by this tool. */
export interface AcceptedUsageCompleteness {
  status: 'unqualified';
  allLegUsageCertified: false;
  totals: 'recorded_lower_bound';
  recordedTokenRows: { certified: number; unknown: number; invalid: number; failed: number };
  /** Zero is known only for a completed, exactly response-bound physical call.
   * An absent row or failed zero placeholder is never a known zero call. */
  knownZeroCompletedMainCalls: number;
  mainProducerCoverage: {
    status: 'not_observed' | 'incomplete' | 'observed_completed_calls';
    observedCalls: number;
    responseBoundCalls: number;
    issues: string[];
  };
  auxiliaryPhysicalInventory: { status: 'unproved'; recordedRowsOutsideMainCalls: number };
  identityGaps: { providerReportedModelRows: number; billedAccountRows: number; backendRows: number };
  cost: { providerPricedCost: 'not_measured'; actualBilling: 'not_measured' };
  issues: string[];
}

/** Optional diagnostics. These observed sums are neither token accounting nor
 * provider wall time, and host steps may contain overlapping physical calls. */
export interface ModelTimingMeasurement {
  scope: 'host_main_steps_only';
  coverage: 'none' | 'partial' | 'observed_host_steps';
  physicalAttemptCoverage: 'none' | 'partial' | 'observed_calls';
  provenanceRequests: number | null;
  observedRequests: number;
  observedHostSteps: number;
  observedResilienceCalls: number;
  hostStepMs: number | null;
  resilienceCallMs: number | null;
  physicalAttemptCount: number | null;
  failedAttemptCount: number | null;
  failedAttemptMs: number | null;
  retryWaitMs: number | null;
  retiredResilienceCalls: number;
  requestAbortedResilienceCalls: number;
  /** Timing observations cannot prove whether a failed attempt was billed or
   * establish its token usage, including when no failed attempt was observed. */
  failedAttemptUsage: 'unknown';
}

export interface AcceptedTurnMeasurement extends SessionMeasurement {
  transportObservation?: AcceptedTransportObservation;
  modelTiming?: ModelTimingMeasurement;
  modelTimingIssues?: string[];
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
  /** Exact trace attribution, additionally checked against observed physical
   *  calls. Stores without those observations retain legacy attribution only;
   *  this flag never proves billing or whole-task model-leg completeness. */
  usageAttributionCertified: boolean;
  usageCertificationIssues: string[];
  usageCompleteness: AcceptedUsageCompleteness;
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
  transportObservation?: AcceptedTransportObservation;
  modelTiming?: ModelTimingMeasurement;
  modelTimingIssues?: string[];
  scope: 'task';
  rootSourceUserSeq: number;
  acceptedSource: string;
  sourceUserSeqs: number[];
  approvalContinuations: ApprovalContinuationMeasurement[];
  /** Exact helper sources proved independently of public delivery segments. */
  workerUsageParticipants: WorkerUsageParticipant[];
  workerLineageIssues: string[];
  workerAttemptCount: number;
  unfinishedWorkerAttempts: number;
  /** Saved operation/response-linked precursors, not execution attempts.
   * Their clocks never extend taskWallMs or segmentWallMs. */
  proactiveUsageParticipants: NoticingAccountingParticipant[];
  proactiveUsageIssues: string[];
  proactiveExactUsageRecords: number;
  proactiveUsageScope: { timing: 'precursor_operations_only'; servingIdentity: 'not_measured'; executionWindowUnaffected: true };
  /** Candidate dispatch metadata only. Full retention-compatible workflow
   * authority proof is still required before admitting its usage rows. */
  workflowUsageInventory: ReturnType<typeof readAcceptedTaskWorkflowCandidates>;
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
  usageCompleteness: AcceptedUsageCompleteness;
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

/** Actual fetch membership is distinct from SDK calls and task elapsed time.
 * This first declared-transport journal never certifies absence of other legs. */
export interface AcceptedTransportObservation {
  /** Local declarations/outcomes are separate from actual provider traffic. */
  localAdapterAttempts?: AcceptedLocalAdapterAttempts;
  scope: 'declared_transports_only';
  inventory: 'not_observed' | 'partial';
  allLegPhysicalInventory: 'unproved';
  declaredTransports: string[];
  observedDispatches: number | null;
  headersReceived: number | null;
  fetchFailures: number | null;
  localRetirements: number | null;
  completedModelResults: number | null;
  exactResponseUsageJoins: number | null;
  dispatchesWithoutCompletedUsageProof: number | null;
  window: { acceptedAt: string | null; deliveryAt: string | null; elapsedMs: number | null };
  dispatchToHeadersOrLocalFailureUnionMs: number | null;
  observedCompletedModelSpanUnionMs: number | null;
  afterDeliveryEvents: number;
  criticalPath: 'not_established';
  accountAuthority: 'unproved';
  schemaAndServingIdentity: 'not_bound_by_transport_journal';
  issues: string[];
}

export interface AcceptedLocalAdapterAttempts {
  scope: 'declared_local_adapter_attempts_only';
  status: 'not_observed' | 'incomplete' | 'observed_local_endpoints';
  createdAttempts: number | null;
  localTerminals: number | null;
  returnedAttempts: number | null;
  failedAttempts: number | null;
  cancelledAttempts: number | null;
  noObservedDispatchAttempts: number | null;
  originalSdkIdentities: number | null;
  ownedParsedResults: number | null;
  exactReportedUsageJoins: number | null;
  unknownUsageAttempts: number | null;
  afterDeliveryEvents: number;
  publicInvocationCoverage: 'unproved';
  allLegPhysicalInventory: 'unproved';
  accountAndBackendAuthority: 'unproved';
  coverageLimits: string[];
  issues: string[];
}

export interface WorkerUsageParticipant {
  sessionId: string;
  sourceUserSeq: number;
  parentSessionId: string;
  parentSourceUserSeq: number;
  parentLogicalCallId: string;
  packetKey: string;
  packetDigest: string;
  attemptIds: string[];
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
      `SELECT seq, turn, role, type,
              CASE WHEN type = 'guardrail_tripped' AND json_valid(data_json)
                THEN CASE WHEN json_extract(data_json, '$.kind') = 'model_memory_context'
                  THEN '{}' ELSE data_json END
                ELSE data_json END AS data_json, created_at
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
  bounds: Map<string, { start: number | null; end: number | null }>;
}

function readAttemptsForSource(
  dbPath: string,
  sessionId: string,
  sourceUserSeq: number,
): AttemptRead {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 5_000 });
  try {
    db.pragma('query_only = ON');
    const identityQuery = `SELECT attempt_id, finished_at
         FROM run_attempts
        WHERE session_id = ?
          AND source_user_seq = ?`;
    let rows: Array<{ attempt_id: string; finished_at: string | null }>;
    try {
      rows = db.prepare(`${identityQuery} ORDER BY started_at ASC`).all(sessionId, sourceUserSeq) as typeof rows;
    } catch {
      // Timing columns cannot erase the durable identity/usage join in a
      // minimal historical store. No timestamp is invented for those rows.
      rows = db.prepare(`${identityQuery} ORDER BY attempt_id ASC`).all(sessionId, sourceUserSeq) as typeof rows;
    }
    const bounds: AttemptRead['bounds'] = new Map(rows.map(row => [row.attempt_id, { start: null, end: null }]));
    try {
      const timing = db.prepare(`SELECT attempt_id, started_at, finished_at FROM run_attempts
        WHERE session_id = ? AND source_user_seq = ?`).all(sessionId, sourceUserSeq) as Array<{
          attempt_id: string; started_at: string; finished_at: string | null;
        }>;
      for (const row of timing) bounds.set(row.attempt_id, {
        start: timestampValue(row.started_at), end: timestampValue(row.finished_at ?? ''),
      });
    } catch { /* Missing timing bounds never change attempt identity or usage. */ }
    const finished = rows
      .map((row) => row.finished_at)
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .sort();
    return {
      ids: new Set(rows.map((row) => row.attempt_id)),
      closeoutAt: finished.at(-1) ?? null,
      unfinished: rows.filter((row) => !row.finished_at).length,
      bounds,
    };
  } catch {
    // Pre-attempt fixtures and old read-only homes still measure through the
    // owned terminal; measurement must never migrate them just to add a bound.
    return { ids: new Set(), closeoutAt: null, unfinished: 0, bounds: new Map() };
  } finally {
    db.close();
  }
}

interface TimingSource {
  source: SessionEvent;
  attempts: AttemptRead;
  terminal?: SessionEvent;
}

function timingNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

/** Read only content-free dispatch identity. This does not open encrypted
 * requests or claim that timing certifies provider/model/account or billing. */
function measureModelTiming(
  dbPath: string,
  sessionId: string,
  events: readonly SessionEvent[],
  sources: ReadonlyMap<number, TimingSource>,
  isAncestor: (ancestor: number, descendant: number) => boolean = (a, b) => a === b,
): { modelTiming: ModelTimingMeasurement; modelTimingIssues: string[] } {
  const issues = new Set<string>();
  const requests = new Map<string, number>();
  const requestKeys = new Set<string>();
  let provenanceAvailable = true;
  const db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 5_000 });
  try {
    db.pragma('query_only = ON');
    const rows = db.prepare(`SELECT p.source_user_seq, p.request_ordinal, p.protocol_version,
      p.created_at, source.seq AS bound_source_seq
      FROM model_request_provenance p LEFT JOIN events source
        ON source.id = p.source_event_id AND source.session_id = p.session_id
      WHERE p.session_id = ? ORDER BY p.source_user_seq, p.request_ordinal`).all(sessionId) as Array<{
        source_user_seq: number; request_ordinal: number; protocol_version: number;
        created_at: string; bound_source_seq: number | null;
      }>;
    for (const row of rows) {
      if (!sources.has(row.source_user_seq)) continue;
      const key = `${row.source_user_seq}:${row.request_ordinal}`;
      if (requestKeys.has(key)) {
        requests.delete(key);
        issues.add('duplicate_timing_dispatch_provenance');
        continue;
      }
      requestKeys.add(key);
      const at = timestampValue(row.created_at);
      if (row.protocol_version !== 1 || row.bound_source_seq !== row.source_user_seq
        || positiveEventSeq(row.request_ordinal) === null || at === null
        || at < (timestampMs(sources.get(row.source_user_seq)!.source) ?? Infinity)) {
        issues.add('invalid_timing_dispatch_provenance');
        continue;
      }
      requests.set(key, at);
    }
  } catch {
    provenanceAvailable = false;
    issues.add('timing_dispatch_provenance_unavailable');
  } finally { db.close(); }

  const attemptOwners = new Map<string, number>();
  for (const [seq, source] of sources) {
    for (const id of source.attempts.ids) attemptOwners.set(id, seq);
    if (source.attempts.unfinished > 0) issues.add(`unfinished_timing_source_attempt:${seq}`);
  }
  const rows = events.filter(event => event.type === 'model_resilience_observed'
    && sources.has(Number(event.data.sourceUserSeq)));
  const byStep = new Map<string, SessionEvent[]>();
  for (const event of rows) {
    const data = event.data;
    const source = positiveEventSeq(data.sourceUserSeq);
    const attemptOwner = typeof data.runAttemptId === 'string' ? attemptOwners.get(data.runAttemptId) : undefined;
    if (event.role !== 'system' || data.version !== 1 || source === null
      || typeof data.stepId !== 'string' || !data.stepId.trim()
      || typeof data.retired !== 'boolean' || attemptOwner === undefined || !isAncestor(source, attemptOwner)
      || event.seq <= sources.get(source)!.source.seq) {
      issues.add('unproved_model_timing_owner');
      continue;
    }
    const group = byStep.get(data.stepId) ?? [];
    group.push(event);
    byStep.set(data.stepId, group);
  }
  const observedRequests = new Set<string>();
  const observedAttemptSources = new Set<number>();
  const hostRequestSteps = new Map<string, Set<string>>();
  const callSteps = new Map<string, Set<string>>();
  for (const [stepId, stepRows] of byStep) for (const row of stepRows) {
    if (row.data.phase === 'host_step_finished') {
      const key = `${row.data.sourceUserSeq}:${row.data.requestOrdinal}`;
      const ids = hostRequestSteps.get(key) ?? new Set<string>();
      ids.add(stepId); hostRequestSteps.set(key, ids);
    }
    if (typeof row.data.callId === 'string') {
      const ids = callSteps.get(row.data.callId) ?? new Set<string>();
      ids.add(stepId); callSteps.set(row.data.callId, ids);
    }
  }
  let hostSteps = 0, hostMs = 0, calls = 0, callMs = 0, attempts = 0, failed = 0, failedMs = 0, waitMs = 0;
  let retiredCalls = 0, abortedCalls = 0, stepsWithCalls = 0;
  // Only terminal totals are summed. attempt_finished/retry_wait_finished rows
  // describe the same intervals and must never be added to call_finished.
  const closeFingerprint = (event: SessionEvent): string => JSON.stringify([
    'version', 'sourceUserSeq', 'stepId', 'runAttemptId', 'requestOrdinal', 'phase', 'callId',
    'at', 'durationMs', 'outcome', 'retired', 'requestAborted', 'attemptCount',
    'failedAttemptCount', 'attemptMs', 'failedAttemptMs', 'retryWaitMs',
  ].map(key => event.data[key]));
  const oneClose = (closing: SessionEvent[], kind: string): SessionEvent | null => {
    if (closing.length === 0) { issues.add(`missing_${kind}_close`); return null; }
    if (closing.length > 1) {
      issues.add(`duplicate_${kind}_close`);
      if (closing.some(event => closeFingerprint(event) !== closeFingerprint(closing[0]!))) {
        issues.add(`conflicting_${kind}_close`);
        return null;
      }
    }
    return closing[0]!;
  };
  for (const stepRows of byStep.values()) {
    const host = oneClose(stepRows.filter(event => event.data.phase === 'host_step_finished'), 'host_step');
    if (!host) continue;
    const data = host.data;
    const seq = Number(data.sourceUserSeq);
    const requestKey = `${seq}:${data.requestOrdinal}`;
    const dispatchAt = requests.get(requestKey);
    const owner = attemptOwners.get(String(data.runAttemptId))!;
    const ownerSource = sources.get(owner)!;
    const bound = ownerSource.attempts.bounds.get(String(data.runAttemptId))!;
    const endBound = bound.end ?? timestampMs(ownerSource.terminal);
    if (hostRequestSteps.get(requestKey)!.size > 1) {
      issues.add('duplicate_host_request_timing'); continue;
    }
    if (!timingNumber(data.at) || !timingNumber(data.durationMs)
      || !['returned', 'failed', 'cancelled'].includes(String(data.outcome))
      || dispatchAt === undefined || positiveEventSeq(data.requestOrdinal) === null
      || bound.start === null || endBound === null || data.at > endBound
      || data.at - data.durationMs < bound.start || dispatchAt > data.at
      || dispatchAt < data.at - data.durationMs
      || timestampMs(host) === null || timestampMs(host)! > endBound
      || stepRows.some(row => row.data.sourceUserSeq !== seq || row.data.runAttemptId !== data.runAttemptId)) {
      issues.add('unbounded_host_step_timing');
      continue;
    }
    hostSteps += 1;
    hostMs += data.durationMs;
    observedAttemptSources.add(owner);
    observedRequests.add(requestKey);
    if (data.retired) issues.add('retired_host_step_timing');
    const byCall = new Map<string, SessionEvent[]>();
    for (const row of stepRows) {
      if (row.data.phase === 'host_step_finished') continue;
      if (typeof row.data.callId !== 'string' || !row.data.callId.trim()) {
        issues.add('invalid_resilience_call_identity'); continue;
      }
      const group = byCall.get(row.data.callId) ?? [];
      group.push(row);
      byCall.set(row.data.callId, group);
    }
    let stepCalls = 0;
    for (const [callId, callRows] of byCall) {
      const call = oneClose(callRows.filter(event => event.data.phase === 'call_finished'), 'resilience_call');
      if (!call) continue;
      const total = call.data;
      const callRequestKey = `${seq}:${total.requestOrdinal}`;
      const callDispatchAt = requests.get(callRequestKey);
      if (call.seq > host.seq || !timingNumber(total.at) || total.at > data.at) {
        issues.add('late_resilience_call_timing'); continue;
      }
      if (callSteps.get(callId)!.size > 1) { issues.add('duplicate_resilience_call_identity'); continue; }
      if (callDispatchAt === undefined || positiveEventSeq(total.requestOrdinal) === null
        || total.requestOrdinal !== data.requestOrdinal
        || !timingNumber(total.durationMs) || total.at - total.durationMs < data.at - data.durationMs
        || total.at < callDispatchAt || !['returned', 'failed', 'cancelled', 'interrupted'].includes(String(total.outcome))
        || !Number.isSafeInteger(total.attemptCount) || Number(total.attemptCount) < 0
        || !Number.isSafeInteger(total.failedAttemptCount) || Number(total.failedAttemptCount) < 0
        || Number(total.failedAttemptCount) > Number(total.attemptCount)
        || !timingNumber(total.attemptMs) || !timingNumber(total.failedAttemptMs) || !timingNumber(total.retryWaitMs)
        || total.failedAttemptMs > total.attemptMs || total.attemptMs + total.retryWaitMs > total.durationMs
        || (total.requestAborted !== undefined && typeof total.requestAborted !== 'boolean')
        || callRows.some(row => row.data.requestOrdinal !== undefined && row.data.requestOrdinal !== total.requestOrdinal)) {
        issues.add('unbounded_resilience_call_timing'); continue;
      }
      calls += 1; stepCalls += 1;
      callMs += total.durationMs;
      attempts += Number(total.attemptCount); failed += Number(total.failedAttemptCount);
      failedMs += total.failedAttemptMs; waitMs += total.retryWaitMs;
      observedRequests.add(callRequestKey);
      if (total.retired) { retiredCalls += 1; issues.add('retired_resilience_call_timing'); }
      if (total.requestAborted === true) abortedCalls += 1;
    }
    if (stepCalls > 0) stepsWithCalls += 1;
    else issues.add('physical_attempt_timing_unavailable_for_host_step');
  }
  if (hostSteps === 0) issues.add('model_timing_unavailable');
  for (const source of sources.keys()) {
    if (!observedAttemptSources.has(source)) issues.add(`timing_source_unobserved:${source}`);
  }
  if (provenanceAvailable && observedRequests.size < requests.size) issues.add('partial_host_request_timing');
  if ([hostMs, callMs, attempts, failed, failedMs, waitMs].some(value => !timingNumber(value))) {
    issues.add('model_timing_sum_overflow');
    return { modelTiming: { scope: 'host_main_steps_only', coverage: 'partial', physicalAttemptCoverage: 'partial',
      provenanceRequests: provenanceAvailable ? requests.size : null, observedRequests: observedRequests.size,
      observedHostSteps: hostSteps, observedResilienceCalls: calls, hostStepMs: null, resilienceCallMs: null,
      physicalAttemptCount: null, failedAttemptCount: null, failedAttemptMs: null, retryWaitMs: null,
      retiredResilienceCalls: retiredCalls, requestAbortedResilienceCalls: abortedCalls, failedAttemptUsage: 'unknown' },
      modelTimingIssues: [...issues] };
  }
  return { modelTiming: {
    scope: 'host_main_steps_only',
    coverage: hostSteps === 0 ? 'none' : issues.size > 0 ? 'partial' : 'observed_host_steps',
    physicalAttemptCoverage: calls === 0 ? 'none' : issues.size > 0 || stepsWithCalls < hostSteps ? 'partial' : 'observed_calls',
    provenanceRequests: provenanceAvailable ? requests.size : null,
    observedRequests: observedRequests.size, observedHostSteps: hostSteps, observedResilienceCalls: calls,
    hostStepMs: hostSteps > 0 ? hostMs : null, resilienceCallMs: calls > 0 ? callMs : null,
    physicalAttemptCount: calls > 0 ? attempts : null, failedAttemptCount: calls > 0 ? failed : null,
    failedAttemptMs: calls > 0 ? failedMs : null, retryWaitMs: calls > 0 ? waitMs : null,
    retiredResilienceCalls: retiredCalls, requestAbortedResilienceCalls: abortedCalls, failedAttemptUsage: 'unknown',
  }, modelTimingIssues: [...issues] };
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
  usageCertificationIssues.push(...mainModelUsageCoverageIssues(sessionId, sessionRead.events,
    new Map([[sourceUserSeq, { source, attempts, terminal }]]), exactUsage));
  const discovery = readDiscoveryForSource(dbPath, sessionId, sourceUserSeq);
  const measured = measureRows({
    sessionId,
    events,
    usageEvents,
    malformedEventPayloads: sessionRead.malformedEventPayloads,
    malformedUsageLines: usageRead.malformedUsageLines,
  });
  const timing = measureModelTiming(dbPath, sessionId, sessionRead.events,
    new Map([[sourceUserSeq, { source, attempts, terminal }]]));
  return {
    ...measured,
    ...timing,
    transportObservation: measureTransportObservations({ sessionId, events: sessionRead.events,
      sources: new Map([[sourceUserSeq, { source, attempts, terminal }]]), usage: usageEvents,
      windowStart: source, windowEnd: terminal }),
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
    usageCompleteness: acceptedUsageCompleteness({ sessionId, events: sessionRead.events,
      sources: new Map([[sourceUserSeq, { source, attempts, terminal }]]), usage: usageEvents,
      attributionIssues: usageCertificationIssues }),
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

const adapterPhase = (phase: unknown): boolean => phase === 'adapter_attempt_created' || phase === 'adapter_attempt_finished';

/** Local adapter endpoints improve attribution visibility without certifying
 * public lazy invocations, hidden retries, actual serving accounts or billing. */
function measureLocalAdapterAttempts(input: {
  sessionId: string; events: readonly SessionEvent[]; sources: ReadonlyMap<number, TimingSource>;
  usage: readonly UsageEvent[]; isAncestor: (ancestor: number, descendant: number) => boolean;
  start: number | null; end: number | null; windowProved: boolean;
}): AcceptedLocalAdapterAttempts {
  const issues = new Set<string>();
  const sourceByAttempt = new Map<string, number>();
  for (const [source, scope] of input.sources) for (const id of scope.attempts.ids) sourceByAttempt.set(id, source);
  const groups = new Map<string, SessionEvent[]>();
  const callOwners = new Map<string, string>();
  const conflictingCalls = new Set<string>();
  const enumValue = (value: unknown, allowed: readonly string[]): boolean => typeof value === 'string' && allowed.includes(value);
  const localIdentity = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,239}$/.test(value);
  const dispatchCounts = new Map<string, number>();
  const receiptCounts = new Map<string, number>();
  for (const event of input.events) if (event.type === 'model_transport_observed'
    && (event.data.phase === 'model_result_completed' || event.data.phase === 'model_attempt_retired') && exactIdentity(event.data.hostResultReceiptId)) {
    receiptCounts.set(event.data.hostResultReceiptId, (receiptCounts.get(event.data.hostResultReceiptId) ?? 0) + 1);
  }
  for (const event of input.events) if (event.type === 'model_transport_observed'
    && event.data.phase === 'dispatch_started' && exactIdentity(event.data.dispatchId)) {
    dispatchCounts.set(event.data.dispatchId, (dispatchCounts.get(event.data.dispatchId) ?? 0) + 1);
  }
  const time = (event: SessionEvent): number | null => event.data.clock === 'host_epoch_ms'
    && typeof event.data.at === 'number' && Number.isSafeInteger(event.data.at) && event.data.at >= 0 ? event.data.at : null;
  const bounded = (event: SessionEvent): boolean => {
    const owner = exactIdentity(event.data.runAttemptId) ? sourceByAttempt.get(event.data.runAttemptId) : undefined;
    const bound = owner === undefined ? undefined : input.sources.get(owner)?.attempts.bounds.get(String(event.data.runAttemptId));
    const reported = time(event); const persisted = timestampMs(event);
    return input.windowProved && bound?.start !== null && bound?.start !== undefined && bound.end !== null
      && bound.end >= bound.start && [reported, persisted].every(value => value !== null
        && value >= input.start! && value <= input.end! && value >= bound.start! && value <= bound.end!);
  };
  const key = (event: SessionEvent): string => JSON.stringify([
    event.data.sourceUserSeq, event.data.runAttemptId, event.data.modelCallId, event.data.physicalAttempt,
  ]);
  const namespace = (event: SessionEvent): string => JSON.stringify([
    event.data.sourceUserSeq, event.data.runAttemptId, event.data.ownerKind, event.data.usageJobId ?? null, event.data.purpose,
  ]);
  let observed = false; let afterDelivery = 0;
  for (const event of input.events) {
    if (event.type !== 'model_transport_observed' || !adapterPhase(event.data.phase)) continue;
    const source = positiveEventSeq(event.data.sourceUserSeq);
    const owner = exactIdentity(event.data.runAttemptId) ? sourceByAttempt.get(event.data.runAttemptId) : undefined;
    if ((source === null || !input.sources.has(source)) && owner === undefined) continue;
    observed = true;
    if (event.role !== 'system' || event.data.version !== 1 || source === null || !input.sources.has(source)
      || owner === undefined || !localIdentity(event.data.runAttemptId) || !input.isAncestor(source, owner) || event.data.logicalTurnId !== `turn:${source}`
      || !localIdentity(event.data.modelCallId) || positiveEventSeq(event.data.physicalAttempt) === null
      || event.seq <= input.sources.get(source)!.source.seq
      || !enumValue(event.data.ownerKind, ['accepted_source_scope', 'accounting_parent'])
      || !enumValue(event.data.purpose, ['brain', 'worker', 'reviewer', 'router', 'writer', 'memory', 'unknown'])
      || (Object.hasOwn(event.data, 'usageJobId') && !localIdentity(event.data.usageJobId))) {
      issues.add(`invalid_local_adapter_ownership:${event.seq}`); continue;
    }
    const call = String(event.data.modelCallId); const prior = callOwners.get(call);
    if (prior !== undefined && prior !== namespace(event)) {
      issues.add(`conflicting_local_adapter_call_owner:${event.seq}`); conflictingCalls.add(call);
    }
    callOwners.set(call, namespace(event));
    const group = groups.get(key(event)) ?? []; group.push(event); groups.set(key(event), group);
    if (event.data.journalFailed !== false) issues.add(`local_adapter_journal_failure:${event.seq}`);
    const at = time(event);
    const persisted = timestampMs(event);
    if (input.end !== null && ((at !== null && at > input.end) || (persisted !== null && persisted > input.end))) afterDelivery++;
    if (!bounded(event)) issues.add(`unbounded_local_adapter_endpoint:${event.seq}`);
  }
  const finishes = [...groups.values()].flatMap(events => events.filter(event => event.data.phase === 'adapter_attempt_finished'));
  const digestCounts = new Map<string, number>(); const callFinishCounts = new Map<string, number>();
  for (const finish of finishes) {
    const digest = finish.data.providerResponseIdDigest;
    if (typeof digest === 'string') digestCounts.set(digest, (digestCounts.get(digest) ?? 0) + 1);
    const call = String(finish.data.modelCallId); callFinishCounts.set(call, (callFinishCounts.get(call) ?? 0) + 1);
  }
  let created = 0; let terminals = 0; let returned = 0; let failed = 0; let cancelled = 0;
  let noDispatch = 0; let originals = 0; let parsed = 0; let joined = 0;
  for (const [groupKey, events] of groups) {
    const starts = events.filter(event => event.data.phase === 'adapter_attempt_created');
    const ends = events.filter(event => event.data.phase === 'adapter_attempt_finished');
    if (starts.length === 1) created++;
    if (ends.length === 1) terminals++;
    const first = starts[0]; const last = ends[0];
    const traffic = input.events.filter(event => event.type === 'model_transport_observed' && !adapterPhase(event.data.phase)
      && event.data.modelCallId === (first ?? last)?.data.modelCallId && event.data.physicalAttempt === (first ?? last)?.data.physicalAttempt);
    const dispatches = traffic.filter(event => event.data.phase === 'dispatch_started');
    const dispatchIds = dispatches.map(event => event.data.dispatchId);
    const ids = last?.data.dispatchIds;
    const validIds = Array.isArray(ids) && ids.every(exactIdentity) && new Set(ids).size === ids.length
      && ids.length === dispatches.length && ids.every((id, i) => id === dispatchIds[i] && dispatchCounts.get(id) === 1
        && dispatches[i].data.wireSubattempt === i + 1)
      && traffic.every(event => key(event) === groupKey && namespace(event) === namespace(first ?? last)
        && event.data.logicalTurnId === (first ?? last).data.logicalTurnId && event.role === 'system' && event.data.version === 1
        && event.data.journalFailed === false && event.data.late !== true && first && last
        && event.seq > first.seq && (event.seq < last.seq || (event.data.phase === 'model_attempt_retired' || event.data.phase === 'model_result_completed'))
        && bounded(event) && time(event)! >= time(first)!
        && (time(event)! <= time(last)! || (event.seq > last.seq
          && enumValue(event.data.phase, ['model_attempt_retired', 'model_result_completed']) && time(event)! <= input.end!)))
      && dispatches.every(dispatch => {
        const endpoints = traffic.filter(event => event.data.dispatchId === dispatch.data.dispatchId
          && enumValue(event.data.phase, ['headers_received', 'dispatch_failed']));
        return enumValue(dispatch.data.transport, ['raw_claude_messages', 'typesafe_systemone']) && endpoints.length === 1
          && endpoints[0].seq > dispatch.seq && last && endpoints[0].seq < last.seq
          && endpoints[0].data.transport === dispatch.data.transport && endpoints[0].data.wireSubattempt === dispatch.data.wireSubattempt
          && time(endpoints[0])! >= time(dispatch)!;
      });
    const results = traffic.filter(event => event.data.phase === 'model_result_completed' || event.data.phase === 'model_attempt_retired');
    const corroborated = results.length === (dispatches.length ? 1 : 0) && results.every(result => {
      const resultIds = result.data.dispatchIds;
      return last && Array.isArray(resultIds) && JSON.stringify(resultIds) === JSON.stringify(ids)
        && localIdentity(result.data.hostResultReceiptId) && receiptCounts.get(result.data.hostResultReceiptId) === 1
        && result.data.resultScope === last.data.resultScope
        && (last.data.resultScope === 'original_sdk_response'
          ? result.data.phase === 'model_result_completed' && result.data.providerResponseIdDigest === last.data.providerResponseIdDigest
          : result.data.outcome === last.data.outcome && result.data.usage === last.data.usage
            && result.data.remoteSettlement === last.data.remoteSettlement
            && (last.data.resultScope === 'owned_systemone_parser'
              ? result.data.phase === 'model_result_completed' && result.data.providerReportedModel === last.data.providerReportedModel
              : result.data.phase === 'model_attempt_retired'));
    });
    const valid = starts.length === 1 && ends.length === 1 && first.seq < last.seq && namespace(first) === namespace(last)
      && first.data.resultScope === 'local_adapter_attempt' && Array.isArray(first.data.dispatchIds) && first.data.dispatchIds.length === 0
      && enumValue(last.data.outcome, ['returned', 'failed', 'cancelled'])
      && enumValue(last.data.resultScope, ['original_sdk_response', 'owned_systemone_parser', 'local_retirement'])
      && enumValue(last.data.usage, ['reported', 'unknown']) && enumValue(last.data.remoteSettlement, ['parsed_response', 'unknown'])
      && !conflictingCalls.has(String(last.data.modelCallId)) && events.every(event => event.data.journalFailed === false)
      && bounded(first) && bounded(last) && time(last)! >= time(first)! && timestampMs(last)! >= timestampMs(first)!
      && validIds && corroborated
      && (last.data.resultScope !== 'original_sdk_response' || (typeof last.data.providerResponseIdDigest === 'string'
        && /^[a-f0-9]{64}$/.test(last.data.providerResponseIdDigest)))
      && (last.data.resultScope !== 'owned_systemone_parser' || (last.data.outcome === 'returned'
        && last.data.remoteSettlement === 'parsed_response' && localIdentity(last.data.providerReportedModel)))
      && (last.data.resultScope !== 'local_retirement' || (last.data.usage === 'unknown' && last.data.remoteSettlement === 'unknown'
        && !Object.hasOwn(last.data, 'providerResponseIdDigest')));
    if (!valid) { issues.add(`incomplete_local_adapter_endpoints:${(first ?? last).seq}`); continue; }
    if (last.data.outcome === 'returned') returned++; else if (last.data.outcome === 'failed') failed++; else cancelled++;
    if (ids.length === 0) noDispatch++;
    const digest = last.data.providerResponseIdDigest;
    const original = last.data.resultScope === 'original_sdk_response' && typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest)
      && digestCounts.get(digest) === 1;
    const ownedParsed = last.data.resultScope === 'owned_systemone_parser' && last.data.outcome === 'returned'
      && last.data.remoteSettlement === 'parsed_response' && exactIdentity(last.data.providerReportedModel);
    if (original) originals++;
    if (ownedParsed) parsed++;
    const rows = input.usage.filter(row => row.trace?.acceptedSource === usageSourceKey(input.sessionId, Number(last.data.sourceUserSeq))
      && row.trace.logicalTurnId === last.data.logicalTurnId && row.trace.attemptId === last.data.runAttemptId
      && row.trace.modelCallId === last.data.modelCallId);
    const row = rows[0]; const accounting = row && canonicalCacheAccounting(row);
    // A failure placeholder or another ordinal's aggregate usage cannot close
    // this endpoint. Local account labels still have no billing authority.
    const usageBound = rows.length === 1 && row.ok !== false && row.role === last.data.purpose && accounting?.certified && !accounting.invalid
      && last.data.outcome === 'returned' && ((original && exactIdentity(row.responseId)
        && createHash('sha256').update(row.responseId, 'utf8').digest('hex') === digest)
        || (ownedParsed && last.data.usage === 'reported' && callFinishCounts.get(String(last.data.modelCallId)) === 1
          && row.providerReportedModel === last.data.providerReportedModel));
    if (usageBound) joined++;
  }
  return { scope: 'declared_local_adapter_attempts_only', status: !observed ? 'not_observed'
    : issues.size ? 'incomplete' : 'observed_local_endpoints',
    createdAttempts: observed ? created : null, localTerminals: observed ? terminals : null,
    returnedAttempts: observed ? returned : null, failedAttempts: observed ? failed : null, cancelledAttempts: observed ? cancelled : null,
    noObservedDispatchAttempts: observed ? noDispatch : null, originalSdkIdentities: observed ? originals : null,
    ownedParsedResults: observed ? parsed : null, exactReportedUsageJoins: observed ? joined : null,
    unknownUsageAttempts: observed ? groups.size - joined : null, afterDeliveryEvents: afterDelivery,
    publicInvocationCoverage: 'unproved', allLegPhysicalInventory: 'unproved', accountAndBackendAuthority: 'unproved',
    coverageLimits: ['public_lazy_invocations_and_pre_adapter_failures_unproved', 'hidden_sdk_retries_and_rowless_usage_unproved',
      'actual_account_backend_and_billing_unproved', 'local_endpoint_counts_do_not_establish_critical_path'], issues: [...issues] };
}

function measureTransportObservations(input: {
  sessionId: string; events: readonly SessionEvent[]; sources: ReadonlyMap<number, TimingSource>;
  usage: readonly UsageEvent[]; isAncestor?: (ancestor: number, descendant: number) => boolean;
  windowStart: SessionEvent | undefined; windowEnd: SessionEvent | undefined; windowProved?: boolean;
}): AcceptedTransportObservation {
  const issues = new Set<string>();
  const isAncestor = input.isAncestor ?? ((a, b) => a === b);
  const sourceByAttempt = new Map<string, number>();
  for (const [source, scope] of input.sources) for (const attempt of scope.attempts.ids) sourceByAttempt.set(attempt, source);
  const start = timestampMs(input.windowStart); const end = timestampMs(input.windowEnd);
  const windowProved = input.windowProved !== false && start !== null && end !== null && end >= start;
  if (!windowProved) issues.add('accepted_delivery_window_unproved');
  const owned: SessionEvent[] = [];
  for (const event of input.events) {
    if (event.type !== 'model_transport_observed') continue;
    // Local adapter records cannot turn absent wire observations into zero.
    if (adapterPhase(event.data.phase)) continue;
    const source = positiveEventSeq(event.data.sourceUserSeq);
    const attempt = event.data.runAttemptId;
    const owner = exactIdentity(attempt) ? sourceByAttempt.get(attempt) : undefined;
    if ((source === null || !input.sources.has(source)) && owner === undefined) continue;
    if (event.role !== 'system' || event.data.version !== 1 || source === null || !input.sources.has(source)
      || owner === undefined || !isAncestor(source, owner) || event.data.logicalTurnId !== `turn:${source}`
      || !exactIdentity(event.data.modelCallId) || positiveEventSeq(event.data.physicalAttempt) === null
      || event.seq <= input.sources.get(source)!.source.seq) {
      issues.add(`invalid_transport_observation_ownership:${event.seq}`); continue;
    }
    owned.push(event);
  }
  const groups = new Map<string, SessionEvent[]>();
  for (const event of owned) {
    const key = JSON.stringify([event.data.sourceUserSeq, event.data.runAttemptId, event.data.modelCallId, event.data.physicalAttempt]);
    const group = groups.get(key) ?? []; group.push(event); groups.set(key, group);
    if (event.data.journalFailed === true) issues.add(`transport_journal_failure:${event.seq}`);
  }
  const wireIds = new Map<string, string>();
  const wireIdCounts = new Map<string, number>(); const digestCounts = new Map<string, number>();
  const resultCallCounts = new Map<string, number>();
  const receiptCounts = new Map<string, number>();
  for (const event of owned) {
    if (exactIdentity(event.data.hostResultReceiptId)) {
      const id = event.data.hostResultReceiptId; receiptCounts.set(id, (receiptCounts.get(id) ?? 0) + 1);
    }
    if (event.data.phase === 'dispatch_started' && exactIdentity(event.data.dispatchId)) {
      wireIdCounts.set(event.data.dispatchId, (wireIdCounts.get(event.data.dispatchId) ?? 0) + 1);
    }
    if (event.data.phase === 'model_result_completed') {
      const id = String(event.data.modelCallId); resultCallCounts.set(id, (resultCallCounts.get(id) ?? 0) + 1);
      const digest = event.data.providerResponseIdDigest;
      if (typeof digest === 'string') digestCounts.set(digest, (digestCounts.get(digest) ?? 0) + 1);
    }
  }
  const declaredTransports = new Set<string>(); const wireIntervals: [number, number][] = [];
  const modelIntervals: [number, number][] = [];
  let starts = 0; let headers = 0; let failures = 0; let retired = 0; let results = 0; let joined = 0; let afterDelivery = 0;
  const eventTime = (event: SessionEvent): number | null => {
    const value = event.data.at;
    return event.data.clock === 'host_epoch_ms' && typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
  };
  const interval = (first: SessionEvent, last: SessionEvent, sink: [number, number][]): void => {
    const a = eventTime(first); const b = eventTime(last);
    if (!windowProved || a === null || b === null || b < a || a < start! || b > end!) {
      issues.add(`unbounded_transport_interval:${first.seq}:${last.seq}`); return;
    }
    sink.push([a, b]);
  };
  for (const event of owned) if (end !== null && eventTime(event) !== null && eventTime(event)! > end) afterDelivery++;
  for (const [key, events] of groups) {
    const dispatches = events.filter(e => e.data.phase === 'dispatch_started');
    const completed = events.filter(e => e.data.phase === 'model_result_completed');
    retired += events.filter(e => e.data.phase === 'model_attempt_retired').length;
    for (const dispatch of dispatches) {
      const id = dispatch.data.dispatchId; const transport = dispatch.data.transport;
      if (!exactIdentity(id) || !['raw_claude_messages', 'typesafe_systemone'].includes(String(transport))
        || positiveEventSeq(dispatch.data.wireSubattempt) === null) {
        issues.add(`invalid_transport_dispatch:${dispatch.seq}`); continue;
      }
      starts++; declaredTransports.add(String(transport));
      if (wireIds.has(id)) issues.add(`duplicate_transport_dispatch_identity:${dispatch.seq}`);
      else wireIds.set(id, key);
      const ends = events.filter(e => e.data.dispatchId === id
        && ['headers_received', 'dispatch_failed'].includes(String(e.data.phase)));
      if (ends.length !== 1 || ends[0].seq <= dispatch.seq || ends[0].data.transport !== transport
        || ends[0].data.wireSubattempt !== dispatch.data.wireSubattempt) {
        issues.add(`unsettled_transport_dispatch:${dispatch.seq}`); continue;
      }
      if (ends[0].data.phase === 'headers_received') headers++; else failures++;
      interval(dispatch, ends[0], wireIntervals);
    }
    for (const response of completed) {
      results++;
      const ids = response.data.dispatchIds;
      const validIds = Array.isArray(ids) && ids.length > 0 && ids.every(exactIdentity)
        && new Set(ids).size === ids.length && ids.length === dispatches.length
        && ids.every((id, index) => {
          const dispatch = dispatches[index];
          const ends = events.filter(e => e.data.dispatchId === id
            && ['headers_received', 'dispatch_failed'].includes(String(e.data.phase)));
          return wireIdCounts.get(id) === 1 && dispatch?.data.dispatchId === id
            && dispatch.data.wireSubattempt === index + 1 && dispatch.seq < response.seq && ends.length === 1
            && ends[0].data.transport === dispatch.data.transport && ends[0].data.wireSubattempt === dispatch.data.wireSubattempt
            && ends[0].seq > dispatch.seq && ends[0].seq < response.seq;
        });
      const receipt = response.data.hostResultReceiptId;
      const validReceipt = exactIdentity(receipt) && receiptCounts.get(receipt) === 1;
      if (completed.length !== 1 || !validIds || !validReceipt || response.data.journalFailed === true) {
        issues.add(`unproved_completed_transport_result:${response.seq}`); continue;
      }
      const rows = input.usage.filter(row => row.trace?.acceptedSource === usageSourceKey(input.sessionId, Number(response.data.sourceUserSeq))
        && row.trace.logicalTurnId === response.data.logicalTurnId && row.trace.attemptId === response.data.runAttemptId
        && row.trace.modelCallId === response.data.modelCallId);
      const row = rows[0];
      const arithmetic = row && canonicalCacheAccounting(row);
      const sdkBound = response.data.resultScope === 'original_sdk_response' && exactIdentity(row?.responseId)
        && typeof response.data.providerResponseIdDigest === 'string'
        && digestCounts.get(response.data.providerResponseIdDigest) === 1
        && createHash('sha256').update(row.responseId, 'utf8').digest('hex') === response.data.providerResponseIdDigest;
      const parsedBound = response.data.resultScope === 'owned_systemone_parser' && response.data.usage === 'reported'
        && response.data.remoteSettlement === 'parsed_response' && resultCallCounts.get(String(response.data.modelCallId)) === 1;
      if (rows.length === 1 && row.ok !== false && arithmetic?.certified && !arithmetic.invalid && (sdkBound || parsedBound)) joined++;
      else issues.add(`completed_transport_result_usage_unproved:${response.seq}`);
      const first = dispatches.reduce((a, b) => a.seq < b.seq ? a : b);
      interval(first, response, modelIntervals);
    }
  }
  // A completed SDK result can span multiple wire dispatches. Its successful
  // usage never certifies earlier HTTP refusals/retries or rowless failures.
  // Joins certify a recorded original SDK/parsed result, not each wire leg's
  // provider receipt. In particular TTL refusal costs and SDK retry aggregates
  // cannot borrow the final result's usage. No wire-local usage seal exists.
  const withoutUsage = starts;
  if (starts > 0) issues.add(`transport_dispatch_usage_unproved:${withoutUsage}`);
  issues.add('all_leg_physical_inventory_unproved');
  const observed = owned.length > 0;
  return { scope: 'declared_transports_only', inventory: observed ? 'partial' : 'not_observed',
    allLegPhysicalInventory: 'unproved', declaredTransports: [...declaredTransports],
    observedDispatches: observed ? starts : null, headersReceived: observed ? headers : null,
    fetchFailures: observed ? failures : null, localRetirements: observed ? retired : null,
    completedModelResults: observed ? results : null, exactResponseUsageJoins: observed ? joined : null,
    dispatchesWithoutCompletedUsageProof: observed ? withoutUsage : null,
    window: { acceptedAt: start === null ? null : input.windowStart!.createdAt,
      deliveryAt: end === null ? null : input.windowEnd!.createdAt, elapsedMs: windowProved ? end! - start! : null },
    dispatchToHeadersOrLocalFailureUnionMs: wireIntervals.length ? intervalUnionMs(wireIntervals) : null,
    observedCompletedModelSpanUnionMs: modelIntervals.length ? intervalUnionMs(modelIntervals) : null,
    afterDeliveryEvents: afterDelivery, criticalPath: 'not_established', accountAuthority: 'unproved',
    schemaAndServingIdentity: 'not_bound_by_transport_journal', issues: [...issues],
    localAdapterAttempts: measureLocalAdapterAttempts({ ...input, isAncestor, start, end, windowProved }) };
}

interface WorkerUsageScope {
  participant: WorkerUsageParticipant;
  source: SessionEvent;
  events: SessionEvent[];
  attempts: AttemptRead;
  parentKey: string;
}

interface WorkerUsageGraph {
  scopes: Map<string, WorkerUsageScope>;
  claimedSources: Set<string>;
  claimedAttempts: Set<string>;
  issues: Set<string>;
}

const usageSourceKey = (sessionId: string, sourceUserSeq: number): string => `${sessionId}:${sourceUserSeq}`;

function exactIdentity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.trim() === value && !/[\u0000-\u001f]/.test(value);
}

/** Exact attribution of some rows is not coverage of every physical call in
 * their attempt. Inspect all owned observations, including late Stop closure,
 * without widening the event/tool/timing windows or inventing token usage.
 * Historical stores without call observations retain their legacy attribution
 * meaning; they do not thereby prove whole-task billing completeness. */
function mainModelUsageCoverageIssues(
  sessionId: string,
  events: readonly SessionEvent[],
  sources: ReadonlyMap<number, TimingSource>,
  usage: readonly UsageEvent[],
  isAncestor: (ancestor: number, descendant: number) => boolean = (ancestor, descendant) => ancestor === descendant,
): string[] {
  const issues = new Set<string>();
  const sourceByAttempt = new Map<string, number>();
  for (const [source, scope] of sources) for (const attempt of scope.attempts.ids) sourceByAttempt.set(attempt, source);
  const calls = new Map<string, { source: number; attempt: string; callId: string; starts: SessionEvent[]; finishes: SessionEvent[]; responses: SessionEvent[] }>();
  const observedSteps = new Map<string, { source: number; calls: Set<string> }>();
  const providerAttempts = new Map<string, { source: number; attempt: string }>();
  const providerResponses: { source: number; attempt: string; responseId: string; seq: number }[] = [];
  const groupByHostId = new Map<string, string>();
  const certifiedUsage = usage.filter(row => {
    const accounting = canonicalCacheAccounting(row);
    return accounting.certified && !accounting.invalid;
  });
  const usageFor = (source: number, attempt: string): UsageEvent[] => certifiedUsage.filter(row => (
    row.trace?.acceptedSource === usageSourceKey(sessionId, source)
    && row.trace.logicalTurnId === `turn:${source}` && row.trace.attemptId === attempt
  ));
  for (const event of events) {
    if (event.type !== 'model_stream_diagnostic' && event.type !== 'model_resilience_observed') continue;
    const source = positiveEventSeq(event.data.sourceUserSeq);
    const attempt = event.type === 'model_stream_diagnostic' ? event.data.attemptId : event.data.runAttemptId;
    const owner = exactIdentity(attempt) ? sourceByAttempt.get(attempt) : undefined;
    if ((source === null || !sources.has(source)) && owner === undefined) continue;
    if (event.role !== 'system' || source === null || !sources.has(source) || owner === undefined
      || !exactIdentity(attempt) || !isAncestor(source, owner) || event.seq <= sources.get(source)!.source.seq) {
      issues.add(`invalid_main_model_observation_ownership:${event.seq}`);
      continue;
    }
    if (event.type === 'model_stream_diagnostic') {
      providerAttempts.set(JSON.stringify([source, attempt]), { source, attempt });
      const responseId = event.data.responseId;
      if (event.data.settlement !== 'completed' || event.data.sawResponseDone !== true) {
        issues.add(`main_unsettled_response_usage_unknown:${source}:${event.seq}`);
      }
      if (!exactIdentity(responseId)) issues.add(`main_response_identity_unknown:${source}:${event.seq}`);
      else {
        providerResponses.push({ source, attempt, responseId, seq: event.seq });
        if (!usageFor(source, attempt).some(row => row.responseId === responseId || row.trace?.modelCallId === responseId)) {
          issues.add(`main_response_without_exact_usage:${source}:${event.seq}`);
        }
      }
      continue;
    }
    if (event.data.version !== 1 || !exactIdentity(event.data.stepId)
      || positiveEventSeq(event.data.requestOrdinal) === null) {
      issues.add(`main_physical_call_identity_unknown:${source}:${event.seq}`);
      continue;
    }
    const stepKey = JSON.stringify([source, attempt, event.data.stepId, event.data.requestOrdinal]);
    let step = observedSteps.get(stepKey);
    if (!step) observedSteps.set(stepKey, step = { source, calls: new Set() });
    if ((typeof event.data.failedAttemptCount === 'number' && event.data.failedAttemptCount > 0)
      || (event.data.phase === 'attempt_finished' && event.data.outcome === 'failed')
      || event.data.requestAborted === true
      || (['call_finished', 'host_step_finished'].includes(String(event.data.phase))
        && ['failed', 'cancelled'].includes(String(event.data.outcome)))) {
      // Counts and zero error placeholders cannot identify every potentially
      // billed retry/aborted physical attempt, even when a successful row exists.
      issues.add(`main_failed_or_aborted_attempt_usage_unknown:${source}`);
    }
    if (!['call_started', 'call_finished', 'response_observed'].includes(String(event.data.phase))) continue;
    if (!exactIdentity(event.data.callId)) {
      issues.add(`main_physical_call_identity_unknown:${source}:${event.seq}`);
      continue;
    }
    const callKey = JSON.stringify([stepKey, event.data.callId]);
    const priorGroup = groupByHostId.get(event.data.callId);
    if (priorGroup !== undefined && priorGroup !== callKey) issues.add(`conflicting_main_host_call_identity:${source}:${event.seq}`);
    groupByHostId.set(event.data.callId, callKey);
    step.calls.add(callKey);
    let call = calls.get(callKey);
    if (!call) calls.set(callKey, call = { source, attempt, callId: event.data.callId, starts: [], finishes: [], responses: [] });
    (event.data.phase === 'call_started' ? call.starts : event.data.phase === 'call_finished' ? call.finishes : call.responses).push(event);
  }
  for (const call of calls.values()) {
    const seq = (call.starts[0] ?? call.finishes[0] ?? call.responses[0])!.seq;
    if (call.starts.length !== 1 || call.finishes.length !== 1
      || call.finishes[0].seq <= call.starts[0].seq || call.finishes[0].data.outcome !== 'returned') {
      issues.add(`main_unsettled_physical_call_usage_unknown:${call.source}:${seq}`);
    }
    if (call.finishes.some(finish => finish.data.attemptCount !== 1 || finish.data.failedAttemptCount !== 0)) {
      issues.add(`main_physical_attempt_membership_unknown:${call.source}:${seq}`);
    }
    // A host UUID and a provider response ID are distinct namespaces. Only an
    // explicit same-tuple usage trace carrying this host ID can bridge them;
    // another response in the attempt, time, model and counts cannot do so.
    if (!usageFor(call.source, call.attempt).some(row => row.trace?.modelCallId === call.callId)) {
      issues.add(`main_host_call_usage_unknown:${call.source}:${seq}`);
    }
    for (const response of call.responses) {
      const digest = response.data.providerResponseIdDigest;
      if (typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)
        || positiveEventSeq(response.data.attempt) === null
        || call.starts.length !== 1 || call.finishes.length !== 1
        || response.seq <= call.starts[0].seq || response.seq >= call.finishes[0].seq) {
        issues.add(`invalid_main_response_binding:${call.source}:${response.seq}`);
        continue;
      }
      if (!usageFor(call.source, call.attempt).some(row => row.trace?.modelCallId === call.callId
        && typeof row.responseId === 'string' && createHash('sha256').update(row.responseId, 'utf8').digest('hex') === digest)) {
        issues.add(`main_bound_response_usage_unknown:${call.source}:${response.seq}`);
      }
    }
    // A single-attempt invocation cannot own two completed provider identities.
    if (call.finishes[0]?.data.attemptCount === 1 && (call.responses.length > 1
      || call.responses.some(response => response.data.attempt !== 1))) {
      issues.add(`conflicting_main_response_binding:${call.source}:${seq}`);
    }
  }
  for (const step of observedSteps.values()) if (step.calls.size === 0) {
    issues.add(`main_host_call_membership_unknown:${step.source}`);
  }
  const hostByProviderId = new Map<string, string>();
  const providerByHostId = new Map<string, string>();
  for (const response of providerResponses) {
    const ownedCalls = [...calls.values()].filter(call => call.source === response.source && call.attempt === response.attempt);
    if (ownedCalls.length === 0) continue;
    const bridges = usageFor(response.source, response.attempt).filter(row => (
      (row.responseId === response.responseId || row.trace?.modelCallId === response.responseId)
      && ownedCalls.some(call => call.callId === row.trace?.modelCallId)
    ));
    if (bridges.length === 0) issues.add(`main_response_host_bridge_unknown:${response.source}:${response.seq}`);
    for (const row of bridges) {
      const hostKey = JSON.stringify([response.source, response.attempt, row.trace!.modelCallId]);
      const providerKey = JSON.stringify([response.source, response.attempt, response.responseId]);
      const priorHost = hostByProviderId.get(response.responseId);
      const priorProvider = providerByHostId.get(row.trace!.modelCallId!);
      if ((priorHost !== undefined && priorHost !== hostKey) || (priorProvider !== undefined && priorProvider !== providerKey)) {
        issues.add(`conflicting_main_response_bridge:${response.source}:${response.seq}`);
      }
      hostByProviderId.set(response.responseId, hostKey);
      providerByHostId.set(row.trace!.modelCallId!, providerKey);
    }
  }
  for (const { source, attempt } of providerAttempts.values()) if (![...calls.values()].some(call => call.source === source && call.attempt === attempt)) {
    issues.add(`main_host_call_membership_unknown:${source}`);
  }
  return [...issues];
}

function acceptedUsageCompleteness(input: {
  sessionId: string;
  events: readonly SessionEvent[];
  sources: ReadonlyMap<number, TimingSource>;
  usage: readonly UsageEvent[];
  attributionIssues: readonly string[];
  isAncestor?: (ancestor: number, descendant: number) => boolean;
}): AcceptedUsageCompleteness {
  const isAncestor = input.isAncestor ?? ((ancestor, descendant) => ancestor === descendant);
  const sourceByAttempt = new Map<string, number>();
  for (const [source, scope] of input.sources) for (const attempt of scope.attempts.ids) sourceByAttempt.set(attempt, source);
  const mainIssues = new Set(mainModelUsageCoverageIssues(input.sessionId, input.events, input.sources, input.usage, isAncestor));
  const calls = new Map<string, { source: number; attempt: string; callId: string; events: SessionEvent[] }>();
  for (const event of input.events) {
    const data = event.data;
    if (event.type !== 'model_resilience_observed' || event.role !== 'system' || data.version !== 1
      || !['call_started', 'response_observed', 'call_finished'].includes(String(data.phase))) continue;
    const source = positiveEventSeq(data.sourceUserSeq);
    const owner = exactIdentity(data.runAttemptId) ? sourceByAttempt.get(data.runAttemptId) : undefined;
    if (source === null || !input.sources.has(source) || owner === undefined || !isAncestor(source, owner)
      || !exactIdentity(data.runAttemptId) || !exactIdentity(data.stepId) || !exactIdentity(data.callId)
      || positiveEventSeq(data.requestOrdinal) === null || event.seq <= input.sources.get(source)!.source.seq) continue;
    const key = JSON.stringify([source, data.runAttemptId, data.stepId, data.requestOrdinal, data.callId]);
    let call = calls.get(key);
    if (!call) calls.set(key, call = { source, attempt: data.runAttemptId, callId: data.callId, events: [] });
    call.events.push(event);
  }
  const callIdCounts = new Map<string, number>();
  for (const call of calls.values()) callIdCounts.set(call.callId, (callIdCounts.get(call.callId) ?? 0) + 1);
  let responseBoundCalls = 0;
  let knownZeroCompletedMainCalls = 0;
  const mainUsage = new Set<UsageEvent>();
  for (const call of calls.values()) {
    const starts = call.events.filter(event => event.data.phase === 'call_started');
    const responses = call.events.filter(event => event.data.phase === 'response_observed');
    const finishes = call.events.filter(event => event.data.phase === 'call_finished');
    const ownedUsage = input.usage.filter(row => row.trace?.acceptedSource === usageSourceKey(input.sessionId, call.source)
      && row.trace.logicalTurnId === `turn:${call.source}` && row.trace.attemptId === call.attempt
      && row.trace.modelCallId === call.callId);
    for (const row of ownedUsage) mainUsage.add(row);
    const firstSeq = (starts[0] ?? responses[0] ?? finishes[0])!.seq;
    const bound = callIdCounts.get(call.callId) === 1 && starts.length === 1 && responses.length === 1 && finishes.length === 1
      && starts[0].seq < responses[0].seq && responses[0].seq < finishes[0].seq
      && starts[0].data.retired !== true && responses[0].data.retired !== true && finishes[0].data.retired !== true
      && starts[0].data.requestAborted !== true && responses[0].data.requestAborted !== true
      && finishes[0].data.requestAborted !== true && finishes[0].data.outcome === 'returned'
      && finishes[0].data.attemptCount === 1 && finishes[0].data.failedAttemptCount === 0
      && responses[0].data.attempt === 1
      && typeof responses[0].data.providerResponseIdDigest === 'string'
      && /^[a-f0-9]{64}$/.test(responses[0].data.providerResponseIdDigest)
      && ownedUsage.length === 1 && ownedUsage[0].ok !== false && exactIdentity(ownedUsage[0].responseId)
      && createHash('sha256').update(ownedUsage[0].responseId, 'utf8').digest('hex') === responses[0].data.providerResponseIdDigest
      && canonicalCacheAccounting(ownedUsage[0]).certified && !canonicalCacheAccounting(ownedUsage[0]).invalid;
    if (!bound) mainIssues.add(`main_fresh_producer_coverage_unproved:${call.source}:${firstSeq}`);
    else {
      responseBoundCalls += 1;
      const row = ownedUsage[0];
      if (row.inputTokens === 0 && row.outputTokens === 0 && (row.cachedInputTokens ?? 0) === 0
        && (row.cacheCreationInputTokens ?? 0) === 0
        && (row.reasoningTokens ?? 0) === 0 && (row.totalTokens ?? 0) === 0) knownZeroCompletedMainCalls += 1;
    }
  }
  // A usage row is evidence for that response, not proof that no other host or
  // auxiliary request ran. Unknown legacy roles cannot establish absence.
  if (calls.size === 0 && input.usage.some(row => row.role === 'brain' || row.role === 'writer')) {
    mainIssues.add('main_fresh_producer_inventory_unproved');
  }
  const recordedTokenRows = { certified: 0, unknown: 0, invalid: 0, failed: 0 };
  const identityGaps = { providerReportedModelRows: 0, billedAccountRows: 0, backendRows: 0 };
  for (const row of input.usage) {
    const accounting = canonicalCacheAccounting(row);
    if (accounting.certified && !accounting.invalid) recordedTokenRows.certified += 1;
    else recordedTokenRows.unknown += 1;
    if (accounting.invalid) recordedTokenRows.invalid += 1;
    if (row.ok === false) recordedTokenRows.failed += 1;
    if (!exactIdentity(row.providerReportedModel)) identityGaps.providerReportedModelRows += 1;
    if (!exactIdentity(row.account)) identityGaps.billedAccountRows += 1;
    if (!exactIdentity(row.backendId)) identityGaps.backendRows += 1;
  }
  const issues = new Set(input.attributionIssues);
  for (const issue of mainIssues) issues.add(issue);
  if (recordedTokenRows.unknown > 0) issues.add(`recorded_token_usage_unknown:${recordedTokenRows.unknown}`);
  if (recordedTokenRows.invalid > 0) issues.add(`recorded_token_usage_invalid:${recordedTokenRows.invalid}`);
  if (identityGaps.providerReportedModelRows > 0) issues.add(`provider_reported_model_unavailable:${identityGaps.providerReportedModelRows}`);
  if (identityGaps.billedAccountRows > 0) issues.add(`billed_account_unavailable:${identityGaps.billedAccountRows}`);
  if (identityGaps.backendRows > 0) issues.add(`backend_identity_unavailable:${identityGaps.backendRows}`);
  issues.add('all_leg_physical_inventory_unproved');
  issues.add('provider_priced_cost_not_measured');
  issues.add('actual_billing_not_measured');
  return {
    status: 'unqualified', allLegUsageCertified: false, totals: 'recorded_lower_bound', recordedTokenRows,
    knownZeroCompletedMainCalls,
    mainProducerCoverage: { status: calls.size > 0 && responseBoundCalls === calls.size && mainIssues.size === 0
      ? 'observed_completed_calls' : calls.size > 0 || mainIssues.size > 0 ? 'incomplete' : 'not_observed',
      observedCalls: calls.size, responseBoundCalls, issues: [...mainIssues] },
    auxiliaryPhysicalInventory: { status: 'unproved', recordedRowsOutsideMainCalls: input.usage.length - mainUsage.size },
    identityGaps, cost: { providerPricedCost: 'not_measured', actualBilling: 'not_measured' }, issues: [...issues],
  };
}

function objectPayload(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown> : null;
  } catch { return null; }
}

function workerAttemptOwnsParentCall(
  db: Database.Database,
  childSessionId: string,
  attemptId: string,
  parent: { sessionId: string; seq: number; callId: string; argumentDigest: string },
  deliverySessionId: string,
  deliverySources: ReadonlyMap<number, SessionEvent>,
): boolean {
  try {
    const rows = db.prepare(`SELECT parent_scope_id, parent_lease_id FROM run_dispatch_leases
      WHERE session_id = ? AND run_attempt_id = ?`).all(childSessionId, attemptId) as Array<{
        parent_scope_id: string | null; parent_lease_id: string | null;
      }>;
    for (const child of rows) {
      let scope = child.parent_scope_id;
      let lease = child.parent_lease_id;
      const seen = new Set<string>();
      while (scope && lease) {
        const key = JSON.stringify([scope, lease]);
        if (seen.has(key)) break;
        seen.add(key);
        const row = db.prepare(`SELECT source_user_seq, accepted_task_id, logical_tool_call_id, run_attempt_id,
          recovery_tool_name, recovery_argument_digest, parent_scope_id, parent_lease_id
          FROM run_dispatch_leases WHERE session_id = ? AND scope_id = ? AND lease_id = ?`)
          .get(parent.sessionId, scope, lease) as { source_user_seq: number | null; accepted_task_id: string | null;
            logical_tool_call_id: string | null; run_attempt_id: string | null;
            recovery_tool_name: string | null; recovery_argument_digest: string | null;
            parent_scope_id: string | null; parent_lease_id: string | null } | undefined;
        if (!row) break;
        if (row.source_user_seq === parent.seq && row.accepted_task_id === `task:${parent.sessionId}#${parent.seq}`
          && row.logical_tool_call_id === parent.callId && row.recovery_tool_name === 'run_worker'
          && row.recovery_argument_digest === parent.argumentDigest) {
          const owner = db.prepare('SELECT session_id, source_user_seq FROM run_attempts WHERE attempt_id = ?')
            .get(row.run_attempt_id) as { session_id: string; source_user_seq: number } | undefined;
          if (owner?.session_id !== parent.sessionId) break;
          let source: number | null = positiveEventSeq(owner.source_user_seq);
          const controls = new Set<number>();
          while (source !== null && source !== parent.seq && parent.sessionId === deliverySessionId
            && deliverySources.has(source) && !controls.has(source)) {
            controls.add(source);
            source = readApprovalExecutionSource(db, { sessionId: parent.sessionId, sourceUserSeq: source });
          }
          if (source === parent.seq) return true;
          break;
        }
        scope = row.parent_scope_id;
        lease = row.parent_lease_id;
      }
    }
  } catch { /* Missing/corrupt historical authority is not invented. */ }
  return false;
}

/** Read-only reciprocal worker provenance, never a session-name/time guess.
 * Claimed sources are traversed separately so a broken ancestor cannot make
 * its descendant costs disappear. Public delivery still belongs to the root
 * and its approval controls; helpers finish attempts, not chat terminals. */
function readWorkerUsageGraph(
  dbPath: string,
  rootSessionId: string,
  roots: ReadonlyMap<number, SessionEvent>,
  claimedRoots: ReadonlyMap<number, SessionEvent> = roots,
): WorkerUsageGraph {
  const graph: WorkerUsageGraph = { scopes: new Map(), claimedSources: new Set(), claimedAttempts: new Set(), issues: new Set() };
  const db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 5_000 });
  const rootKeys = new Set([...roots.keys()].map(seq => usageSourceKey(rootSessionId, seq)));
  const queue = [...claimedRoots].map(([seq, source]) => ({ sessionId: rootSessionId, seq, source }));
  const seen = new Set<string>();
  const conflicting = new Set<string>();
  const ownerByChild = new Map<string, string>();
  try {
    db.pragma('query_only = ON');
    for (let index = 0; index < queue.length; index += 1) {
      const parent = queue[index]!;
      const parentKey = usageSourceKey(parent.sessionId, parent.seq);
      if (seen.has(parentKey)) continue;
      seen.add(parentKey);
      const sessionRead = readSessionEvents(dbPath, parent.sessionId);
      const markers = sessionRead.events.filter(event => event.type === 'worker_started'
        && (event.data.parentSourceUserSeq === parent.seq || event.data.sourceUserSeq === parent.seq));
      let parentId: string | undefined;
      let orphans: Array<{ seq: number; session_id: string; data_json: string }> = [];
      try {
        parentId = (db.prepare('SELECT id FROM events WHERE session_id = ? AND seq = ? AND role = ? AND type = ?')
          .get(parent.sessionId, parent.seq, 'user', 'user_input_received') as { id: string } | undefined)?.id;
        if (parentId) orphans = db.prepare(`SELECT seq, session_id, data_json FROM events
          WHERE parent_event_id = ? AND type = 'user_input_received' AND role = 'user' ORDER BY seq`)
          .all(parentId) as typeof orphans;
      } catch {
        if (markers.length > 0) graph.issues.add(`worker_lineage_store_unavailable:${parentKey}`);
      }
      // Also find a corrupted/missing parent marker via the reciprocal child
      // pointer. It supplies only a possible cost owner, never proof.
      const childKeys = new Set(orphans.filter(row => objectPayload(row.data_json)?.delegatedWorker)
        .map(row => usageSourceKey(row.session_id, row.seq)));
      const candidates = sessionRead.events.filter(event => event.type === 'worker_started'
        && (markers.includes(event) || (exactIdentity(event.data.childSessionId)
          && positiveEventSeq(event.data.childSourceUserSeq) !== null
          && childKeys.has(usageSourceKey(event.data.childSessionId, event.data.childSourceUserSeq as number)))));
      for (const row of orphans) {
        if (!objectPayload(row.data_json)?.delegatedWorker) continue;
        const childKey = usageSourceKey(row.session_id, row.seq);
        if (!candidates.some(event => event.data.childSessionId === row.session_id && event.data.childSourceUserSeq === row.seq)) {
          graph.claimedSources.add(childKey);
          for (const id of readAttemptsForSource(dbPath, row.session_id, row.seq).ids) graph.claimedAttempts.add(id);
          graph.issues.add(`missing_worker_link:${childKey}`);
          const childRead = readSessionEvents(dbPath, row.session_id);
          const source = childRead.events.find(event => event.seq === row.seq)!;
          queue.push({ sessionId: row.session_id, seq: row.seq, source });
        }
      }
      for (const marker of candidates) {
        const data = marker.data;
        if (exactIdentity(data.childAttemptId)) graph.claimedAttempts.add(data.childAttemptId);
        const childSeq = positiveEventSeq(data.childSourceUserSeq);
        if (!exactIdentity(data.childSessionId) || childSeq === null) {
          graph.issues.add(`unproved_worker_link:${marker.seq}`);
          continue;
        }
        const childSessionId = data.childSessionId;
        const childKey = usageSourceKey(childSessionId, childSeq);
        graph.claimedSources.add(childKey);
        const attempts = readAttemptsForSource(dbPath, childSessionId, childSeq);
        for (const id of attempts.ids) graph.claimedAttempts.add(id);
        let childRead: ReturnType<typeof readSessionEvents>;
        try { childRead = readSessionEvents(dbPath, childSessionId); }
        catch { graph.issues.add(`unproved_worker_link:${marker.seq}`); continue; }
        if (childRead.malformedEventPayloads > 0) graph.issues.add(`malformed_worker_session_events:${childKey}`);
        const source = childRead.events.find(event => event.seq === childSeq);
        if (source) queue.push({ sessionId: childSessionId, seq: childSeq, source });
        const owner = JSON.stringify([data.parentSessionId, data.parentSourceUserSeq, data.parentAcceptedTaskId,
          data.parentLogicalCallId, data.packetKey, data.packetDigest, data.item]);
        const previousOwner = ownerByChild.get(childKey);
        if ((previousOwner !== undefined && previousOwner !== owner) || rootKeys.has(childKey) || childSeq <= parent.seq) {
          conflicting.add(childKey);
          graph.issues.add(`conflicting_worker_parent:${childKey}`);
        }
        ownerByChild.set(childKey, owner);
        let valid = false;
        try {
          const childRow = db.prepare(`SELECT id, parent_event_id FROM events WHERE session_id = ? AND seq = ?
            AND role = 'user' AND type = 'user_input_received'`).get(childSessionId, childSeq) as { id: string; parent_event_id: string } | undefined;
          const metadata = objectPayload((db.prepare('SELECT metadata_json FROM sessions WHERE id = ? AND kind = ?')
            .get(childSessionId, 'agent') as { metadata_json: string } | undefined)?.metadata_json);
          const binding = source?.data.delegatedWorker as Record<string, unknown> | undefined;
          const packet = binding?.packet;
          const keys = ['parentSessionId', 'parentSourceUserSeq', 'parentAcceptedTaskId', 'parentLogicalCallId', 'packetKey', 'packetDigest', 'item'];
          const call = db.prepare(`SELECT tool_name, argument_digest, state FROM logical_tool_calls WHERE session_id = ?
            AND source_user_seq = ? AND accepted_task_id = ? AND logical_tool_call_id = ?`)
            .get(parent.sessionId, parent.seq, `task:${parent.sessionId}#${parent.seq}`, data.parentLogicalCallId) as {
              tool_name: string; argument_digest: string; state: string;
            } | undefined;
          const ownedAttempts = new Set<string>();
          if (call?.tool_name === 'run_worker' && /^[a-f0-9]{64}$/.test(call.argument_digest) && ['open', 'settled'].includes(call.state)
            && exactIdentity(data.parentLogicalCallId)) {
            for (const id of attempts.ids) {
              if (workerAttemptOwnsParentCall(db, childSessionId, id, { sessionId: parent.sessionId, seq: parent.seq,
                callId: data.parentLogicalCallId, argumentDigest: call.argument_digest }, rootSessionId, roots)) ownedAttempts.add(id);
              else graph.issues.add(`unproved_worker_attempt:${childKey}:${id}`);
            }
          }
          for (const id of attempts.ids) if (!ownedAttempts.has(id)) {
            attempts.ids.delete(id);
            attempts.bounds.delete(id);
          }
          attempts.unfinished = [...attempts.ids].filter(id => !(db.prepare(`SELECT finished_at FROM run_attempts
            WHERE attempt_id = ? AND session_id = ? AND source_user_seq = ?`).get(id, childSessionId, childSeq) as {
              finished_at: string | null;
            } | undefined)?.finished_at).length;
          valid = marker.role === 'system' && data.parentSessionId === parent.sessionId
            && data.parentSourceUserSeq === parent.seq
            && (data.sourceUserSeq === undefined || data.sourceUserSeq === parent.seq)
            && data.parentAcceptedTaskId === `task:${parent.sessionId}#${parent.seq}`
            && exactIdentity(data.parentLogicalCallId) && call?.tool_name === 'run_worker' && ['open', 'settled'].includes(call.state)
            && exactIdentity(data.packetKey) && exactIdentity(data.item)
            && typeof data.packetDigest === 'string' && /^[a-f0-9]{64}$/.test(data.packetDigest)
            && exactIdentity(data.childAttemptId) && attempts.ids.has(data.childAttemptId)
            && childSeq > parent.seq && marker.seq > childSeq
            && source?.role === 'user' && source.type === 'user_input_received'
            && !!parentId && childRow?.parent_event_id === parentId
            && metadata?.source === 'delegated_worker' && metadata.workerScope === true
            && !!binding && binding.composeOnly === true
            && packet !== null && typeof packet === 'object' && !Array.isArray(packet)
            && (packet as Record<string, unknown>).item === data.item
            && createHash('sha256').update(JSON.stringify(packet)).digest('hex') === data.packetDigest
            && keys.every(key => binding[key] === data[key] && metadata[key] === data[key]);
        } catch { /* Historical/malformed stores remain unproved, never migrated. */ }
        if (!valid || !source) {
          graph.issues.add(`unproved_worker_link:${marker.seq}`);
          conflicting.add(childKey);
          continue;
        }
        const existing = graph.scopes.get(childKey);
        graph.scopes.set(childKey, existing ?? {
          participant: { sessionId: childSessionId, sourceUserSeq: childSeq,
            parentSessionId: parent.sessionId, parentSourceUserSeq: parent.seq,
            parentLogicalCallId: data.parentLogicalCallId as string, packetKey: data.packetKey as string,
            packetDigest: data.packetDigest as string, attemptIds: [...attempts.ids] },
          source, events: childRead.events, attempts, parentKey,
        });
      }
    }
    // An invalid or conflicting ancestor invalidates all descendants, even
    // when it was discovered after a valid-looking child marker.
    let removed = true;
    while (removed) {
      removed = false;
      for (const [key, scope] of graph.scopes) {
        if (conflicting.has(key) || (!rootKeys.has(scope.parentKey) && !graph.scopes.has(scope.parentKey))) {
          graph.scopes.delete(key);
          graph.issues.add(`unproved_worker_ancestry:${key}`);
          removed = true;
        }
      }
    }
  } finally { db.close(); }
  return graph;
}

/**
 * Explicit whole-task scope. Host-validated approval execution edges extend
 * public delivery; reciprocally verified worker edges extend usage ownership.
 * Adjacent turns, matching text and timestamps never establish parentage.
 * Each NDJSON row is selected once; overlapping turn totals are never summed.
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
  const workers = readWorkerUsageGraph(dbPath, sessionId, members, claimedMembers);
  for (const issue of workers.issues) issues.add(issue);
  const sourceByAccepted = new Map([...members.keys()].map((seq) => [usageSourceKey(sessionId, seq), seq]));
  const usageSourceByAttempt = new Map([...sourceByAttempt].map(([id, seq]) => [id, usageSourceKey(sessionId, seq)]));
  const usageParentBySource = new Map([...parentBySource].map(([child, parent]) => [usageSourceKey(sessionId, child), usageSourceKey(sessionId, parent)]));
  let workerAttemptCount = 0;
  let unfinishedWorkerAttempts = 0;
  for (const [key, worker] of workers.scopes) {
    sourceByAccepted.set(key, worker.source.seq);
    usageParentBySource.set(key, worker.parentKey);
    workerAttemptCount += worker.attempts.ids.size;
    unfinishedWorkerAttempts += worker.attempts.unfinished;
    if (worker.attempts.unfinished > 0) issues.add(`unfinished_worker_attempt:${key}`);
    for (const id of worker.attempts.ids) {
      const prior = usageSourceByAttempt.get(id);
      if (prior !== undefined && prior !== key) {
        usageSourceByAttempt.delete(id);
        issues.add(`conflicting_worker_attempt:${id}`);
      } else usageSourceByAttempt.set(id, key);
    }
  }
  const claimedAccepted = new Set([...claimedMembers.keys()].map((seq) => `${sessionId}:${seq}`));
  for (const key of workers.claimedSources) claimedAccepted.add(key);
  const claimedAttemptIds = new Set(sourceByAttempt.keys());
  for (const id of workers.claimedAttempts) claimedAttemptIds.add(id);
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
  const isUsageAncestor = (ancestor: string, descendant: string): boolean => {
    let current: string | undefined = descendant;
    const visited = new Set<string>();
    while (current !== undefined && !visited.has(current)) {
      if (current === ancestor) return true;
      visited.add(current);
      current = usageParentBySource.get(current);
    }
    return false;
  };
  const usageRead = readUsageEvents(path.join(home, 'state', 'token-usage'));
  const accountingSources = [...members.keys()].map(sourceUserSeq => ({ sessionId, sourceUserSeq }));
  const proactive = readAcceptedTaskNoticingParticipants(home, accountingSources);
  const workflowInventory = readAcceptedTaskWorkflowCandidates(home, accountingSources);
  const proactiveSelection = selectAcceptedTaskNoticingUsage({ ...proactive,
    acceptedSources: new Set(accountingSources.map(source => usageSourceKey(source.sessionId, source.sourceUserSeq))),
    usage: usageRead.events });
  const proactiveIssues = [...new Set([...proactive.issues, ...proactiveSelection.issues])];
  for (const issue of proactiveIssues) issues.add(issue);
  for (const issue of workflowInventory.issues) issues.add(issue);
  if (workflowInventory.candidates.length) issues.add('workflow_participant_inventory_unproved');
  const proactiveExact = new Set(proactiveSelection.exactIndices);
  const proactiveUnproven = new Set(proactiveSelection.unprovenIndices);
  const exactUsage: UsageEvent[] = [];
  const unprovenUsage: UsageEvent[] = [];
  const usageAttemptIds = new Set<string>();
  let legacyWindowUsageRecords = 0;
  let unscopedWindowUsageRecords = 0;
  for (const [index, event] of usageRead.events.entries()) {
    // One read and one row selection. An exact precursor is included in task
    // recorded usage, but cannot supply an accepted source/attempt or time.
    if (proactiveExact.has(index)) { exactUsage.push(event); continue; }
    if (proactiveUnproven.has(index)) { unprovenUsage.push(event); continue; }
    const traceSource = sourceByAccepted.get(event.trace?.acceptedSource ?? '');
    const attemptId = event.trace?.attemptId;
    const attemptSource = typeof attemptId === 'string' ? usageSourceByAttempt.get(attemptId) : undefined;
    if (traceSource !== undefined || attemptSource !== undefined
      || claimedAccepted.has(event.trace?.acceptedSource ?? '')
      || (typeof attemptId === 'string' && claimedAttemptIds.has(attemptId))) {
      if (traceSource !== undefined && attemptSource !== undefined
        && event.trace?.logicalTurnId === `turn:${traceSource}`
        && (workers.scopes.has(attemptSource)
          ? event.trace.acceptedSource === attemptSource
          : isUsageAncestor(event.trace.acceptedSource!, attemptSource))) {
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
  for (const issue of mainModelUsageCoverageIssues(sessionId, sessionRead.events, new Map(
    [...members].map(([seq, source]) => [seq, { source, attempts: attemptsBySource.get(seq)!, terminal: terminals.get(seq) }]),
  ), exactUsage, isAncestor)) issues.add(issue);
  for (const [key, worker] of workers.scopes) {
    const usage = exactUsage.filter(row => typeof row.trace?.attemptId === 'string' && worker.attempts.ids.has(row.trace.attemptId));
    const responses = worker.events.filter(event => event.type === 'worker_model_response_completed'
      && event.role === 'system'
      && event.data.sourceUserSeq === worker.source.seq
      && typeof event.data.runAttemptId === 'string' && worker.attempts.ids.has(event.data.runAttemptId));
    for (const response of worker.events.filter(event => event.type === 'worker_model_response_completed'
      && (event.data.sourceUserSeq === worker.source.seq
        || (typeof event.data.runAttemptId === 'string' && worker.attempts.ids.has(event.data.runAttemptId))))) {
      if (!responses.includes(response)) issues.add(`invalid_worker_response_ownership:${key}:${response.seq}`);
    }
    if (usage.length > 0 && responses.length === 0) issues.add(`worker_host_response_coverage_unknown:${key}`);
    const requests = worker.events.filter(event => ['turn_model_routed', 'model_resilience_observed'].includes(event.type)
      && event.data.sourceUserSeq === worker.source.seq
      && (event.type === 'turn_model_routed' || event.data.phase === 'call_started'));
    if ((responses.length > 0 || requests.length > 0) && usage.length === 0) issues.add(`worker_model_without_exact_usage:${key}`);
    // A provider stream proves that response's usage, but does not prove
    // coverage of a different host decision UUID. Check every completed host
    // request independently. Historical rows without a recorded exact ID
    // bridge remain a lower bound even when some provider usage is present.
    const hostByResponseDigest = new Map<string, string>();
    const digestByHost = new Map<string, string>();
    for (const response of responses) {
      const hostId = response.data.modelCallId;
      const digest = response.data.providerResponseIdDigest;
      const hasDigest = typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest);
      if (hasDigest && exactIdentity(hostId)) {
        const hostAttempt = JSON.stringify([response.data.runAttemptId, hostId]);
        const attemptDigest = JSON.stringify([response.data.runAttemptId, digest]);
        const priorHost = hostByResponseDigest.get(digest);
        const priorDigest = digestByHost.get(hostId);
        if ((priorHost !== undefined && priorHost !== hostAttempt) || (priorDigest !== undefined && priorDigest !== attemptDigest)) {
          issues.add(`conflicting_worker_response_bridge:${key}:${response.seq}`);
        }
        hostByResponseDigest.set(digest, hostAttempt);
        digestByHost.set(hostId, attemptDigest);
      }
      if (!exactIdentity(hostId) || !usage.some(row => row.trace?.attemptId === response.data.runAttemptId
        && (hasDigest
          ? [row.trace?.modelCallId, row.responseId].some(id => exactIdentity(id)
            && createHash('sha256').update(id).digest('hex') === digest)
          : digest === undefined && row.trace?.modelCallId === hostId))) {
        issues.add(`worker_host_response_usage_unknown:${key}:${response.seq}`);
      }
    }
    // Host UUIDs and provider IDs are different namespaces. A usage row may
    // explicitly retain both identities; timestamps/counts/models never join
    // them. Provider diagnostics still independently detect missing usage.
    for (const response of worker.events.filter(event => event.type === 'model_stream_diagnostic'
      && event.role === 'system'
      && event.data.sourceUserSeq === worker.source.seq && event.data.settlement === 'completed'
      && event.data.sawResponseDone === true && exactIdentity(event.data.responseId)
      && typeof event.data.attemptId === 'string' && worker.attempts.ids.has(event.data.attemptId))) {
      if (!usage.some(row => row.trace?.attemptId === response.data.attemptId
        && (row.trace?.modelCallId === response.data.responseId || row.responseId === response.data.responseId))) {
        issues.add(`worker_response_without_exact_usage:${key}:${response.seq}`);
      }
    }
    if (worker.events.some(event => event.type === 'model_resilience_observed'
      && event.data.sourceUserSeq === worker.source.seq
      && typeof event.data.runAttemptId === 'string' && worker.attempts.ids.has(event.data.runAttemptId)
      && typeof event.data.failedAttemptCount === 'number' && event.data.failedAttemptCount > 0)) {
      // An aggregate failure count cannot identify every billed physical
      // attempt. Retain all exact failed rows, without certifying that one
      // such row covers all failures or that an absent row means zero cost.
      issues.add(`worker_failed_attempt_usage_unknown:${key}`);
    }
  }
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
  const timing = measureModelTiming(dbPath, sessionId, sessionRead.events, new Map(
    [...members].map(([seq, source]) => [seq, {
      source, attempts: attemptsBySource.get(seq)!, terminal: terminals.get(seq),
    }]),
  ), isAncestor);
  if (lineageIssues.size > 0) {
    timing.modelTimingIssues.push('unproved_task_timing_lineage');
    if (timing.modelTiming.coverage !== 'none') timing.modelTiming.coverage = 'partial';
    if (timing.modelTiming.physicalAttemptCoverage !== 'none') timing.modelTiming.physicalAttemptCoverage = 'partial';
  }
  return {
    ...measured,
    ...timing,
    // SessionMeasurement's wall helper means one turn; never relabel its last
    // segment as the whole task. Explicit task/segment timings follow below.
    turnWallMs: null,
    scope: 'task', rootSourceUserSeq, acceptedSource,
    transportObservation: measureTransportObservations({ sessionId, events: sessionRead.events,
      sources: new Map([...members].map(([seq, source]) => [seq, {
        source, attempts: attemptsBySource.get(seq)!, terminal: terminals.get(seq),
      }])), usage: exactUsage, isAncestor, windowStart: root, windowEnd: terminal,
      windowProved: lineageIssues.size === 0 && terminals.size === members.size }),
    sourceUserSeqs: [...members.keys()], approvalContinuations, lineageIssues: [...lineageIssues],
    workerUsageParticipants: [...workers.scopes.values()].map(scope => scope.participant),
    workerLineageIssues: [...workers.issues], workerAttemptCount, unfinishedWorkerAttempts,
    proactiveUsageParticipants: proactive.jobs, proactiveUsageIssues: proactiveIssues,
    proactiveExactUsageRecords: proactiveExact.size,
    proactiveUsageScope: { timing: 'precursor_operations_only', servingIdentity: 'not_measured', executionWindowUnaffected: true },
    workflowUsageInventory: workflowInventory,
    exactUsageRecords: exactUsage.length,
    unprovenUsage: { usageRecords: unproven.usageRecords, promptTokens: unproven.promptTokens,
      cachedInputTokens: unproven.cachedInputTokens, uncachedInputTokens: unproven.uncachedInputTokens, outputTokens: unproven.outputTokens },
    legacyWindowUsageRecords, unscopedWindowUsageRecords,
    usageAttributionCertified: issues.size === 0,
    usageCertificationIssues: [...issues],
    usageCompleteness: acceptedUsageCompleteness({ sessionId, events: sessionRead.events,
      sources: new Map([...members].map(([seq, source]) => [seq, {
        source, attempts: attemptsBySource.get(seq)!, terminal: terminals.get(seq),
      }])), usage: exactUsage, attributionIssues: [...issues], isAncestor }),
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

function modelTimingRows(b?: ModelTimingMeasurement, c?: ModelTimingMeasurement): string[] {
  if (!b && !c) return [];
  return ['', 'Observed host-main timing diagnostics',
    `Host-step coverage: ${b?.coverage ?? 'none'} → ${c?.coverage ?? 'none'}; physical-call coverage: ${b?.physicalAttemptCoverage ?? 'none'} → ${c?.physicalAttemptCoverage ?? 'none'}`,
    row('Dispatch provenance requests', b?.provenanceRequests ?? null, c?.provenanceRequests ?? null),
    row('Observed host-main steps', b?.observedHostSteps ?? null, c?.observedHostSteps ?? null),
    row('Summed observed host-main step time', b?.hostStepMs ?? null, c?.hostStepMs ?? null, duration),
    row('Observed resilience calls', b?.observedResilienceCalls ?? null, c?.observedResilienceCalls ?? null),
    row('Summed observed resilience call time', b?.resilienceCallMs ?? null, c?.resilienceCallMs ?? null, duration),
    row('Observed physical attempts', b?.physicalAttemptCount ?? null, c?.physicalAttemptCount ?? null),
    row('Observed failed physical attempts', b?.failedAttemptCount ?? null, c?.failedAttemptCount ?? null),
    row('Summed observed failed-attempt time', b?.failedAttemptMs ?? null, c?.failedAttemptMs ?? null, duration),
    row('Summed observed retry-wait time', b?.retryWaitMs ?? null, c?.retryWaitMs ?? null, duration),
    row('Observed retired resilience calls', b?.retiredResilienceCalls ?? null, c?.retiredResilienceCalls ?? null),
    row('Observed request-aborted resilience calls', b?.requestAbortedResilienceCalls ?? null, c?.requestAbortedResilienceCalls ?? null),
    'These sums may overlap. They exclude unobserved roles and are not task wall time or billable time.',
    'Failed-attempt token usage and billing remain unknown; timing adds no token totals.'];
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
    `attribution: ${b.usageAttribution}${b.usageAttributionCertified ? ' (certified)' : ' (uncertified)'} → ${c.usageAttribution}${c.usageAttributionCertified ? ' (certified)' : ' (uncertified)'}`,
    'All-leg usage: UNQUALIFIED lower bound; auxiliary physical-call inventory is unproved. Provider-priced cost and actual billing are not measured.',
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
    ...modelTimingRows(b.modelTiming, c.modelTiming),
  ];
  const warnings: string[] = [];
  for (const measurement of [b, c]) {
    warnings.push(`${measurement.acceptedSource}: all-leg usage remains unqualified despite any exact attribution; recorded totals are a lower bound. ${measurement.usageCompleteness.issues.join(', ')}.`);
    if (measurement.modelTimingIssues?.length) {
      warnings.push(`${measurement.acceptedSource}: model timing is observational/incomplete: ${measurement.modelTimingIssues.join(', ')}.`);
    }
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
    'Clementine approval/helper-linked task comparison (read-only; explicit task scope)',
    `home:      ${comparison.home}`,
    `baseline:  ${b.acceptedSource}; sources ${b.sourceUserSeqs.join(', ')}`,
    `candidate: ${c.acceptedSource}; sources ${c.sourceUserSeqs.join(', ')}`,
    `attribution: ${b.usageAttributionCertified ? 'certified' : 'UNCERTIFIED lower bound'} → ${c.usageAttributionCertified ? 'certified' : 'UNCERTIFIED lower bound'}`,
    'All-leg usage: UNQUALIFIED lower bound; auxiliary physical-call inventory is unproved. Provider-priced cost and actual billing are not measured.',
    '',
    'Metric                                                               Baseline      Candidate                  Delta',
    row('Proved approval continuations', b.approvalContinuations.length, c.approvalContinuations.length),
    row('Proved exact helper sources', b.workerUsageParticipants?.length ?? 0, c.workerUsageParticipants?.length ?? 0),
    row('Helper attempts', b.workerAttemptCount ?? 0, c.workerAttemptCount ?? 0),
    row('Unfinished helper attempts', b.unfinishedWorkerAttempts ?? 0, c.unfinishedWorkerAttempts ?? 0),
    row('Receipt-linked proactive jobs', b.proactiveUsageParticipants?.length ?? null, c.proactiveUsageParticipants?.length ?? null),
    row('Original-response-linked proactive usage rows', b.proactiveExactUsageRecords ?? null, c.proactiveExactUsageRecords ?? null),
    row('Workflow dispatch candidates (unproved, not admitted)', b.workflowUsageInventory?.candidates.length ?? null, c.workflowUsageInventory?.candidates.length ?? null),
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
    ...modelTimingRows(b.modelTiming, c.modelTiming),
  ];
  const warnings: string[] = [];
  for (const measurement of [b, c]) {
    warnings.push(`${measurement.acceptedSource}: all-leg usage remains unqualified despite any exact attribution; recorded totals are a lower bound. ${measurement.usageCompleteness.issues.join(', ')}.`);
    if (measurement.modelTimingIssues?.length) {
      warnings.push(`${measurement.acceptedSource}: model timing is observational/incomplete: ${measurement.modelTimingIssues.join(', ')}.`);
    }
    if (!measurement.usageAttributionCertified) {
      warnings.push(`${measurement.acceptedSource}: incomplete attribution; proven totals are a lower bound, not comparable whole-task cost. ${measurement.usageCertificationIssues.join(', ')}.`);
    }
    if (measurement.proactiveUsageParticipants?.length) {
      warnings.push(`${measurement.acceptedSource}: proactive operations are receipt-linked; only original-response-proved rows extend usage. Precursor timing is separate from task execution and its serving identity is not measured by the latest build pin.`);
    }
    if (measurement.workflowUsageInventory?.candidates.length) {
      warnings.push(`${measurement.acceptedSource}: workflow dispatch candidates are unproved and excluded; missing full retention-compatible authority/call evidence does not establish zero usage.`);
    }
    if (measurement.usageCertificationIssues.some(issue => /^(worker_(host_response|response_without|model_without|failed_attempt)|conflicting_worker_response_bridge|invalid_worker_response_ownership)/.test(issue))) {
      warnings.push(`${measurement.acceptedSource}: helper request usage coverage is unknown/incomplete; absent or conflicting response evidence does not establish zero cost.`);
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
  lines.push('', 'Public delivery follows proved approval continuations; reciprocally proved helpers extend usage only. Unrelated follow-up turns are excluded.',
    'Receipt-linked proactive operations extend recorded usage only; their clocks and serving identity require separate proof.',
    'Wall spans and approval waits may overlap; do not add them. Unrecorded waits remain unknown.');
  return `${lines.join('\n')}\n`;
}
