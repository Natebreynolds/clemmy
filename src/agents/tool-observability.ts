/**
 * Tool observability — append-only NDJSON log of every tool call's
 * lifecycle, classified by the taxonomy and tagged with the approval
 * reason.
 *
 * This is the substrate the "always learning" loop reads later:
 *   - Per-tool confidence (calls × success rate, p50 latency, error
 *     fingerprints).
 *   - Per-(tool, scope) auto-approval coverage — "Clementine called
 *     `cx_googlesheets_batch_get` 18× this week, all auto, all
 *     succeeded, never reverted → upgrade to strict-policy auto".
 *   - Detection of slug drift — DataForSEO renamed `serp_advanced_*`
 *     and our calls started 404'ing? The log shows it.
 *
 * Storage format (one event per line, append-only):
 *
 *   {"at":"2026-05-14T17:30:00Z","sessionId":"console:home","toolName":
 *    "cx_googlesheets_create_google_sheet1","kind":"send",
 *    "phase":"end","durationMs":2104,"approvalReason":"yolo-policy",
 *    "outcome":"success","argsSummary":"{title:\"Smoke\"}"}
 *
 * One file per day so it stays bounded and grep-friendly:
 *   ~/.clementine-next/state/tool-events/2026-05-14.ndjson
 *
 * Write is fire-and-forget — never blocks the tool call's hot path
 * and never throws. If the log is unwritable, we drop the event.
 */
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import { redactSensitiveValue } from '../runtime/security.js';
import { summarizeToolArgs } from './plan-scope.js';
import type { ToolKind } from './tool-taxonomy.js';

const EVENT_DIR = path.join(BASE_DIR, 'state', 'tool-events');

function ensureDir(): void {
  if (!existsSync(EVENT_DIR)) {
    try {
      mkdirSync(EVENT_DIR, { recursive: true });
    } catch {
      // Best-effort. If we can't make the dir, write() will swallow.
    }
  }
}

function currentLogFile(): string {
  const dateKey = new Date().toISOString().slice(0, 10);
  return path.join(EVENT_DIR, `${dateKey}.ndjson`);
}

export interface ToolLifecycleEvent {
  /** ISO timestamp of this event (start or end). */
  at: string;
  /** Session that issued the call. */
  sessionId?: string;
  /** Tool name as the model saw it (e.g. `cx_googlesheets_batch_get`
   *  or `dataforseo__serp_locations`). */
  toolName: string;
  /** Taxonomy kind. */
  kind: ToolKind;
  /** Lifecycle phase. `start` fires before the underlying call. */
  phase: 'start' | 'end' | 'error' | 'pending-approval';
  /** Wall-clock milliseconds from `start` to `end`/`error`. */
  durationMs?: number;
  /** Reason from `decideToolApproval()` — `yolo-policy`, `read-always-auto`,
   *  `strict-policy`, `admin`, `plan-scope`, etc. */
  approvalReason?: string;
  /** Short fingerprint of the call's args, secrets/long blobs scrubbed. */
  argsSummary?: string;
  /** End-state outcome. */
  outcome?: 'success' | 'error' | 'cancelled';
  /** Error message if `outcome === 'error'` (truncated). */
  errorMessage?: string;
  /** True if the call was MCP-routed (namespace shim) rather than a
   *  local SDK tool. Lets us slice the data by surface. */
  mcp?: boolean;
}

/** Best-effort append. Never throws.
 *
 * Defaults an empty sessionId to a stable "unscoped:<date>" bucket so
 * downstream tooling (the dashboard's diagnostics panel) can still
 * group events that the runtime didn't tag. The runtime SHOULD pass
 * sessionId for every event, but chat paths through the SDK Agent
 * Runner have historically dropped it — this fallback keeps those
 * events visible instead of having them coalesce into a single
 * un-clickable bucket. Doesn't change tool execution; just adds a
 * lookup key. */
export function recordToolEvent(event: ToolLifecycleEvent): void {
  ensureDir();
  const tagged = event.sessionId && event.sessionId.length > 0
    ? event
    : { ...event, sessionId: `unscoped:${(event.at || new Date().toISOString()).slice(0, 10)}` };
  const line = JSON.stringify(redactSensitiveValue(tagged)) + '\n';
  try {
    appendFileSync(currentLogFile(), line, { encoding: 'utf-8' });
  } catch {
    // We never let observability bring down a real tool call.
  }
}

/**
 * Helper: capture a `start` event, return a function that, when
 * called with `(outcome, errorMessage?)`, records the matching `end`
 * (with duration). Use this from runtimes:
 *
 *     const finish = beginToolEvent({ sessionId, toolName, kind, ... });
 *     try {
 *       const out = await runTool();
 *       finish('success');
 *       return out;
 *     } catch (err) {
 *       finish('error', err.message);
 *       throw err;
 *     }
 */
export function beginToolEvent(input: {
  sessionId?: string;
  toolName: string;
  kind: ToolKind;
  approvalReason?: string;
  args?: unknown;
  mcp?: boolean;
}): (outcome: 'success' | 'error' | 'cancelled', errorMessage?: string) => void {
  const startedAt = Date.now();
  recordToolEvent({
    at: new Date(startedAt).toISOString(),
    sessionId: input.sessionId,
    toolName: input.toolName,
    kind: input.kind,
    phase: 'start',
    approvalReason: input.approvalReason,
    argsSummary: summarizeToolArgs(input.toolName, input.args).slice(0, 200),
    mcp: input.mcp,
  });

  return (outcome, errorMessage) => {
    recordToolEvent({
      at: new Date().toISOString(),
      sessionId: input.sessionId,
      toolName: input.toolName,
      kind: input.kind,
      phase: outcome === 'error' ? 'error' : 'end',
      durationMs: Date.now() - startedAt,
      approvalReason: input.approvalReason,
      outcome,
      errorMessage: errorMessage ? errorMessage.slice(0, 500) : undefined,
      mcp: input.mcp,
    });
  };
}

/**
 * Helper: record a pending-approval event. The runtime fires this
 * when `decideToolApproval()` returns `needsApproval: true` and the
 * call is queued instead of executed. Lets the audit log show
 * approval rates per (tool, scope, day).
 */
export function recordPendingApproval(input: {
  sessionId?: string;
  toolName: string;
  kind: ToolKind;
  args?: unknown;
  approvalId: string;
  mcp?: boolean;
}): void {
  recordToolEvent({
    at: new Date().toISOString(),
    sessionId: input.sessionId,
    toolName: input.toolName,
    kind: input.kind,
    phase: 'pending-approval',
    approvalReason: input.approvalId,
    argsSummary: summarizeToolArgs(input.toolName, input.args).slice(0, 200),
    mcp: input.mcp,
  });
}
