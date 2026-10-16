import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { BASE_DIR } from '../config.js';
import type { WorkflowEvent } from '../execution/workflow-events.js';
import { openEventLog } from '../runtime/harness/eventlog.js';

/**
 * What Clem did in one workflow run, step by step, from the records the run
 * already leaves: the run record and its event log for each step's lifecycle
 * and output, and each step's own chat session for the prompt it was given,
 * every tool call with its arguments, result and settled outcome, the model,
 * token use, and how the attempt ended.
 *
 * Read-only and derived on request. Every text field is bounded; a field cut
 * short says how long it was.
 */

export const WORKFLOW_RUN_TRACE_VERSION = 1 as const;

const PROMPT_MAX = 6_000;
const ARGUMENTS_MAX = 4_000;
const RESULT_MAX = 3_000;
const OUTPUT_MAX = 8_000;
const OUTCOME_TEXT_MAX = 2_000;
const CALLS_PER_ATTEMPT_MAX = 300;

export interface BoundedText {
  text: string;
  chars: number;
  truncated: boolean;
}

export interface WorkflowRunTraceCallOutcome {
  /** Settled outcome class: succeeded, empty_result, invalid_arguments, unknown, ... */
  kind: string;
  detail: string | null;
  /** What the harness told the model to do next (settle, repair_arguments, ...). */
  recovery: string | null;
  executionKind: string | null;
  mutating: boolean | null;
}

export interface WorkflowRunTraceCall {
  callId: string;
  /** The operation that ran (the inner tool when a carrier such as call_tool carried it). */
  tool: string;
  /** The carrier the model called, when different from `tool`. */
  carrier: string | null;
  at: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  arguments: BoundedText | null;
  /** True when the call returned, false when it errored or was refused, null when unknown. */
  ok: boolean | null;
  result: BoundedText | null;
  error: string | null;
  /** Refused before anything ran (no tool body was entered). */
  refusedBeforeRunning: boolean;
  outcome: WorkflowRunTraceCallOutcome | null;
}

export interface WorkflowRunTraceUsage {
  calls: number;
  promptTokens: number;
  cachedTokens: number;
  outputTokens: number;
}

export interface WorkflowRunTraceAttempt {
  sessionId: string;
  sourceUserSeq: number;
  startedAt: string | null;
  finishedAt: string | null;
  /** The exact instruction this step was given for this attempt. */
  prompt: BoundedText | null;
  models: string[];
  usage: WorkflowRunTraceUsage | null;
  calls: WorkflowRunTraceCall[];
  callsOmitted: number;
  /** How the attempt ended, when it has. */
  ending: {
    status: string | null;
    kind: string | null;
    blockedReason: string | null;
    blockedDetail: string | null;
    text: BoundedText | null;
  } | null;
}

export interface WorkflowRunTraceStepEvent {
  t: string;
  kind: string;
  error: string | null;
  reason: string | null;
}

export interface WorkflowRunTraceStep {
  stepId: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  error: string | null;
  output: (BoundedText & { artifact: string | null }) | null;
  /** The step's lifecycle as the runner recorded it, oldest first. */
  events: WorkflowRunTraceStepEvent[];
  attempts: WorkflowRunTraceAttempt[];
}

export interface WorkflowRunTraceV1 {
  version: typeof WORKFLOW_RUN_TRACE_VERSION;
  runId: string;
  workflow: string;
  status: string | null;
  source: string | null;
  createdAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** The exact definition this run executed; matches a saved workflow version. */
  definitionHash: string | null;
  inputs: unknown;
  error: BoundedText | null;
  steps: WorkflowRunTraceStep[];
}

function bounded(value: unknown, max: number): BoundedText | null {
  if (value === undefined || value === null) return null;
  const text = typeof value === 'string' ? value : (() => {
    try { return JSON.stringify(value, null, 2); } catch { return String(value); }
  })();
  return { text: text.length > max ? text.slice(0, max) : text, chars: text.length, truncated: text.length > max };
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function elapsed(from: string | null, to: string | null): number | null {
  if (!from || !to) return null;
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

const STEP_TERMINAL_STATUS: Record<string, string> = {
  step_started: 'running',
  step_completed: 'done',
  step_failed: 'failed',
  step_blocked: 'blocked',
  step_paused: 'paused',
  step_skipped: 'skipped',
  step_invalidated: 'redoing',
  step_retry: 'retrying',
  step_loop_retry: 'retrying',
  approval_requested: 'awaiting_approval',
  approval_granted: 'running',
  approval_rejected: 'blocked',
};

interface EventRow { seq: number; type: string; created_at: string; data_json: string }

function stepSessions(db: Database.Database, runId: string): Array<{ id: string; stepId: string | null }> {
  const rows = db.prepare(`
    SELECT id, metadata_json FROM sessions
     WHERE kind = 'workflow' AND json_extract(metadata_json, '$.workflowRunId') = ?
     ORDER BY created_at
  `).all(runId) as Array<{ id: string; metadata_json: string | null }>;
  return rows.map((row) => {
    let stepId: string | null = null;
    try { stepId = str(record(JSON.parse(row.metadata_json ?? '{}'))?.stepId); } catch { stepId = null; }
    return { id: row.id, stepId };
  });
}

function usageFor(db: Database.Database, sessionId: string, sourceUserSeq: number): WorkflowRunTraceUsage | null {
  try {
    const row = db.prepare(`
      SELECT SUM(calls) AS calls, SUM(prompt_tokens) AS prompt, SUM(cached_tokens) AS cached, SUM(output_tokens) AS output
        FROM accepted_source_usage_v1 WHERE session_id = ? AND source_user_seq = ?
    `).get(sessionId, sourceUserSeq) as { calls: number | null; prompt: number | null; cached: number | null; output: number | null } | undefined;
    if (!row || row.calls === null) return null;
    return { calls: row.calls ?? 0, promptTokens: row.prompt ?? 0, cachedTokens: row.cached ?? 0, outputTokens: row.output ?? 0 };
  } catch {
    return null;
  }
}

/** A host refusal comes back as a returned result written by the host itself;
 * every form opens with this phrase. Display only: nothing here decides. */
const HOST_REFUSAL_RESULT = /^Tool '[^']{1,128}' was refused before dispatch\b/;

/**
 * The models each attempt called, from the per-call usage log: workflow step
 * sessions record no routing event, and the usage log names the exact
 * accepted request (`<session>:<request>`) every model call belonged to.
 */
function modelsByAttempt(sessionId: string, attempts: readonly WorkflowRunTraceAttempt[], usageDir: string): Map<number, string[]> {
  const out = new Map<number, string[]>();
  const days = new Set<string>();
  for (const attempt of attempts) {
    for (const at of [attempt.startedAt, attempt.finishedAt]) if (at) days.add(at.slice(0, 10));
  }
  for (const day of days) {
    const file = path.join(usageDir, `${day}.ndjson`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !existsSync(file)) continue;
    let text = '';
    try { text = readFileSync(file, 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (!line.includes(sessionId)) continue;
      try {
        const row = record(JSON.parse(line));
        const accepted = str(record(row?.trace)?.acceptedSource);
        const model = str(row?.model);
        if (!accepted || !model || !accepted.startsWith(`${sessionId}:`)) continue;
        const source = Number(accepted.slice(sessionId.length + 1));
        if (!Number.isSafeInteger(source)) continue;
        const models = out.get(source) ?? [];
        if (!models.includes(model)) models.push(model);
        out.set(source, models);
      } catch { /* a partial line is skipped */ }
    }
  }
  return out;
}

const SESSION_TRACE_TYPES = [
  'user_input_received', 'turn_model_routed', 'tool_called', 'tool_returned',
  'tool_attempt_settled', 'conversation_completed', 'guardrail_tripped',
];

function attemptsForSession(db: Database.Database, sessionId: string, usageDir: string): WorkflowRunTraceAttempt[] {
  const placeholders = SESSION_TRACE_TYPES.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT seq, type, created_at, data_json FROM events
     WHERE session_id = ? AND type IN (${placeholders})
     ORDER BY seq
  `).all(sessionId, ...SESSION_TRACE_TYPES) as EventRow[];
  const attempts = new Map<number, WorkflowRunTraceAttempt>();
  const calls = new Map<number, Map<string, WorkflowRunTraceCall>>();
  const attemptFor = (sourceUserSeq: number, at: string): WorkflowRunTraceAttempt => {
    let attempt = attempts.get(sourceUserSeq);
    if (!attempt) {
      attempt = {
        sessionId, sourceUserSeq, startedAt: at, finishedAt: null, prompt: null, models: [],
        usage: null, calls: [], callsOmitted: 0, ending: null,
      };
      attempts.set(sourceUserSeq, attempt);
      calls.set(sourceUserSeq, new Map());
    }
    return attempt;
  };
  for (const row of rows) {
    let data: Record<string, unknown>;
    try { data = record(JSON.parse(row.data_json)) ?? {}; } catch { continue; }
    if (row.type === 'user_input_received') {
      const attempt = attemptFor(row.seq, row.created_at);
      attempt.prompt = bounded(data.text, PROMPT_MAX);
      continue;
    }
    const source = Number(data.sourceUserSeq);
    if (!Number.isSafeInteger(source) || source <= 0) continue;
    const attempt = attemptFor(source, row.created_at);
    const byCall = calls.get(source)!;
    if (row.type === 'turn_model_routed') {
      const model = str(data.model);
      if (model && !attempt.models.includes(model)) attempt.models.push(model);
      continue;
    }
    if (row.type === 'conversation_completed') {
      const presentation = record(data.presentation);
      attempt.finishedAt = row.created_at;
      attempt.ending = {
        status: str(presentation?.status),
        kind: str(presentation?.kind),
        blockedReason: str(data.blockedReason),
        blockedDetail: str(data.blockedDetail),
        text: bounded(presentation?.text, OUTCOME_TEXT_MAX),
      };
      continue;
    }
    // A step whose every call was refused before it ran leaves its calls and
    // the refusal here, and often nothing else: a write a reviewer refused
    // never becomes a tool call (dispatch-streak.ts).
    if (row.type === 'guardrail_tripped') {
      if (data.kind !== 'no_dispatch_step' || !Array.isArray(data.calls)) continue;
      for (const raw of data.calls) {
        const entry = record(raw);
        const refusedCallId = str(entry?.callId);
        if (!refusedCallId || byCall.has(refusedCallId)) continue;
        let tool = str(entry?.name) ?? '';
        let carrier: string | null = null;
        const operation = str(entry?.operation);
        if (operation && operation !== tool) { carrier = tool; tool = operation; }
        else try {
          const parsed = record(JSON.parse(str(entry?.argumentsJson) ?? '{}'));
          const inner = str(parsed?.name) ?? str(parsed?.tool_slug)
            ?? str(record(parsed?.args_json)?.tool_slug);
          if (inner && inner !== tool) { carrier = tool; tool = inner; }
        } catch {
          // The record keeps a bounded prefix of the arguments; name the
          // carried operation from it for display when it is legible there.
          const named = /"(?:tool_slug|name)"\s*:\s*"([A-Za-z0-9_.:-]{1,128})"/.exec(str(entry?.argumentsJson) ?? '')?.[1];
          if (named && named !== tool) { carrier = tool; tool = named; }
        }
        byCall.set(refusedCallId, {
          callId: refusedCallId, tool, carrier, at: row.created_at, finishedAt: row.created_at, durationMs: null,
          arguments: bounded(entry?.argumentsJson, ARGUMENTS_MAX), ok: false, result: null,
          error: str(data.refusalDetail)?.slice(0, RESULT_MAX) ?? null, refusedBeforeRunning: true, outcome: null,
        });
      }
      continue;
    }
    const callId = str(data.callId) ?? str(data.logicalToolCallId);
    if (!callId) continue;
    // The model-facing call is the top-level record; the inner transport
    // mirror repeats it and is not a second call.
    if ((row.type === 'tool_called' || row.type === 'tool_returned') && data.accounting !== 'top_level') continue;
    let call = byCall.get(callId);
    if (!call) {
      call = {
        callId, tool: '', carrier: null, at: null, finishedAt: null, durationMs: null, arguments: null,
        ok: null, result: null, error: null, refusedBeforeRunning: false, outcome: null,
      };
      byCall.set(callId, call);
    }
    if (row.type === 'tool_called') {
      const carrier = str(data.tool) ?? '';
      const effective = str(data.effectiveTool) ?? carrier;
      call.tool = effective;
      call.carrier = carrier && carrier !== effective ? carrier : null;
      call.at = row.created_at;
      call.arguments = bounded(data.arguments ?? data.args, ARGUMENTS_MAX);
    } else if (row.type === 'tool_returned') {
      call.finishedAt = row.created_at;
      call.ok = data.ok === false ? false : true;
      call.result = bounded(data.result, RESULT_MAX);
      call.error = str(data.error)?.slice(0, RESULT_MAX) ?? null;
      if (typeof data.result === 'string' && HOST_REFUSAL_RESULT.test(data.result)) {
        call.refusedBeforeRunning = true;
        call.ok = false;
        call.error ??= data.result.slice(0, RESULT_MAX);
      }
      if (!call.tool) call.tool = str(data.effectiveTool) ?? str(data.tool) ?? '';
    } else if (row.type === 'tool_attempt_settled') {
      // A wrapped call can settle once for its carrier and once for the
      // operation it carried; the operation's own outcome is what the owner
      // reads, so a settlement naming the operation that ran wins.
      if (call.outcome && call.tool && str(data.tool) !== call.tool) continue;
      const refused = data.executionKind === 'refused_pre_dispatch';
      call.outcome = {
        kind: str(data.kind) ?? 'unknown',
        detail: str(data.detail),
        recovery: str(data.action),
        executionKind: str(data.executionKind),
        mutating: typeof data.mutating === 'boolean' ? data.mutating : null,
      };
      if (refused) {
        call.refusedBeforeRunning = true;
        if (call.ok === null) call.ok = false;
      }
      if (!call.tool) call.tool = str(data.tool) ?? '';
      if (!call.at) call.at = row.created_at;
    }
  }
  for (const [source, attempt] of attempts) {
    const all = [...calls.get(source)!.values()];
    for (const call of all) call.durationMs = elapsed(call.at, call.finishedAt);
    attempt.calls = all.slice(0, CALLS_PER_ATTEMPT_MAX);
    attempt.callsOmitted = Math.max(0, all.length - CALLS_PER_ATTEMPT_MAX);
    attempt.usage = usageFor(db, sessionId, source);
  }
  const models = modelsByAttempt(sessionId, [...attempts.values()], usageDir);
  for (const [source, attempt] of attempts) {
    for (const model of models.get(source) ?? []) if (!attempt.models.includes(model)) attempt.models.push(model);
  }
  return [...attempts.values()].sort((a, b) => a.sourceUserSeq - b.sourceUserSeq);
}

export function buildWorkflowRunTrace(input: {
  runId: string;
  workflow: string;
  record: Record<string, unknown>;
  events: readonly WorkflowEvent[];
  stepIds: readonly string[];
}, database?: Database.Database, usageDir: string = path.join(BASE_DIR, 'state', 'token-usage')): WorkflowRunTraceV1 {
  const db = database ?? openEventLog();
  const run = input.record;
  const snapshot = record(run.workflowDefinitionSnapshot);
  const startedEvent = input.events.find((event) => event.kind === 'run_started');
  const stepOutputs = record(run.stepOutputs) ?? {};
  const orderedStepIds = [...input.stepIds];
  for (const event of input.events) {
    // Run-level records use parenthesised ids ("(workflow)", "(run goal)");
    // they are not steps.
    if (event.stepId && !/^\(.*\)$/.test(event.stepId) && !orderedStepIds.includes(event.stepId)) orderedStepIds.push(event.stepId);
  }
  const sessions = stepSessions(db, input.runId);
  const steps: WorkflowRunTraceStep[] = orderedStepIds.map((stepId) => {
    const own = input.events.filter((event) => event.stepId === stepId);
    let status = 'pending';
    let startedAt: string | null = null;
    let finishedAt: string | null = null;
    let error: string | null = null;
    let output: WorkflowRunTraceStep['output'] = null;
    for (const event of own) {
      const next = STEP_TERMINAL_STATUS[event.kind];
      if (next) status = next;
      if (event.kind === 'step_started' && !startedAt) startedAt = event.t;
      if (['step_completed', 'step_failed', 'step_blocked', 'step_skipped'].includes(event.kind)) finishedAt = event.t;
      if (event.error) error = event.error;
      if (event.kind === 'step_completed' && event.output !== undefined) {
        const artifact = str(record(event.meta)?.stepOutputArtifact);
        output = { ...bounded(event.output, OUTPUT_MAX)!, artifact };
      }
    }
    if (!output && stepOutputs[stepId] !== undefined) output = { ...bounded(stepOutputs[stepId], OUTPUT_MAX)!, artifact: null };
    return {
      stepId,
      status,
      startedAt,
      finishedAt,
      durationMs: elapsed(startedAt, finishedAt),
      error,
      output,
      events: own
        .filter((event) => !event.kind.startsWith('workflow_node_') && event.kind !== 'transcript_chunk')
        .map((event) => ({
          t: event.t,
          kind: event.kind,
          error: event.error ?? null,
          reason: str(record(event.meta)?.reason),
        })),
      attempts: sessions
        .filter((session) => session.stepId === stepId)
        .flatMap((session) => attemptsForSession(db, session.id, usageDir)),
    };
  });
  return {
    version: WORKFLOW_RUN_TRACE_VERSION,
    runId: input.runId,
    workflow: input.workflow,
    status: str(run.status),
    source: str(run.source),
    createdAt: str(run.createdAt),
    startedAt: str(run.startedAt) ?? startedEvent?.t ?? null,
    finishedAt: str(run.finishedAt),
    definitionHash: str(snapshot?.definitionHash) ?? str(record(startedEvent?.meta)?.definitionHash),
    inputs: run.inputs ?? null,
    error: bounded(run.error, OUTCOME_TEXT_MAX),
    steps,
  };
}
