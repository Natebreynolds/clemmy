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
import Database from 'better-sqlite3';
import path from 'node:path';

import { looksLikeToolCallShape } from '../../src/runtime/harness/tool-narration-shapes.js';
import type { Check, TurnLatency } from './types.js';

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
  toolCalls: Record<string, number>;
  toolCallTotal: number;
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
  /** Spawn→first-stream-byte of the session's FIRST SDK query (sdk_first_byte
   *  event) — the TTFT stand-in on the SDK lane, whose sessions carry no
   *  turn_started/tool timing for the turn-based ttft above. */
  firstByteMs: number | null;
}

export function openHarnessDb(home: string): Database.Database {
  const dbPath = path.join(home, 'state', 'harness.db');
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

interface EventRow { type: string; data_json: string; created_at: string; turn: number }

export function sessionMetrics(db: Database.Database, sessionId: string): SessionMetrics | null {
  const session = db
    .prepare(`SELECT id, kind, status, tokens_used FROM sessions WHERE id = ?`)
    .get(sessionId) as { id: string; kind: string; status: string; tokens_used: number } | undefined;
  if (!session) return null;

  const events = db
    .prepare(`SELECT type, data_json, created_at, turn FROM events WHERE session_id = ? ORDER BY seq ASC`)
    .all(sessionId) as EventRow[];

  const toolCalls: Record<string, number> = {};
  let guardrailsTripped = 0;
  let externalWrites = 0;
  const sdkFirstBytes: number[] = [];
  let autoContinues = 0;
  let workerResults = 0;
  let workerFailures = 0;
  let completedEvents = 0;
  let limitExceededEvents = 0;
  let primerInjectedBytes: number | null = null;
  const latency: TurnLatency[] = [];
  let openTurnStartedAt: number | null = null;
  let openTurnFirstAction: number | null = null;

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
        try { name = String((JSON.parse(ev.data_json) as { tool?: string }).tool ?? 'unknown'); } catch { /* keep unknown */ }
        toolCalls[name] = (toolCalls[name] ?? 0) + 1;
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
  return {
    sessionId,
    status: session.status,
    kind: session.kind,
    tokensUsed: session.tokens_used,
    turns,
    toolCalls,
    toolCallTotal: Object.values(toolCalls).reduce((a, b) => a + b, 0),
    guardrailsTripped,
    externalWrites,
    autoContinues,
    workerResults,
    workerFailures,
    completedEvents,
    limitExceededEvents,
    primerInjectedBytes,
    latency,
    firstByteMs: sdkFirstBytes.length > 0 ? sdkFirstBytes[0] : null,
  };
}

/** List every session in the DB with headline counts (for --score-only). */
export function summarizeAllSessions(db: Database.Database): SessionMetrics[] {
  const rows = db.prepare(`SELECT id FROM sessions ORDER BY updated_at DESC`).all() as { id: string }[];
  return rows.map((r) => sessionMetrics(db, r.id)).filter((m): m is SessionMetrics => m !== null);
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
  const used = metrics?.tokensUsed ?? 0;
  return { name: `tokens ≤ ${ceiling}`, pass: used <= ceiling, detail: `${used} used` };
}
