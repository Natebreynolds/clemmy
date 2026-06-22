/**
 * eval-corpus-promote — turn PRODUCTION failures into eval cases (Lane A Phase
 * 4b, eval-as-harness). Closes the loop: when a run trips a guardrail, stalls,
 * or fails, snapshot its trajectory into a pending-corpus file for one-click
 * human promotion into the pass^k suite — so the living regression suite grows
 * from real misses, not just hand-authored traps.
 *
 * Additive + observational: writes a file under state/eval-corpus/pending/, never
 * touches a hot path. The pure core (buildFailureCase) is the verifiable part.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../../config.js';
import { listEvents, type EventRow } from '../harness/eventlog.js';
import { toGenAiSpans, type GenAiSpan } from './otel-spans.js';

export interface PendingEvalCase {
  id: string;
  sessionId: string;
  capturedAt: string;
  /** The failure signals that made this worth keeping. */
  failureKinds: string[];
  /** Compact causal trace (the same gen_ai spans eval:spans renders). */
  spans: GenAiSpan[];
  toolCount: number;
  /** Whether a human has promoted it into the suite yet (set on promotion). */
  promoted: boolean;
}

const FAILURE_EVENT_TYPES = new Set(['guardrail_tripped', 'stuck_detected', 'run_failed', 'conversation_limit_exceeded']);

function defaultDir(): string {
  return path.join(BASE_DIR, 'state', 'eval-corpus', 'pending');
}

function safeName(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 120);
}

/** PURE: build a pending eval case from a session's events, or null when the
 *  session had no failure worth keeping. capturedAt is the last event's time
 *  (deterministic — no wall-clock), so it is testable + replay-stable. */
export function buildFailureCase(sessionId: string, events: EventRow[]): PendingEvalCase | null {
  const failures = events.filter((e) => FAILURE_EVENT_TYPES.has(e.type));
  if (failures.length === 0) return null;
  // guardrail_tripped is noisy (fanout_nudge is advisory, not a failure) — drop it.
  const kinds = new Set<string>();
  for (const f of failures) {
    if (f.type === 'guardrail_tripped') {
      const k = typeof f.data.kind === 'string' ? f.data.kind : 'guardrail';
      if (k === 'fanout_nudge') continue; // advisory, not a failure
      kinds.add(`guardrail:${k}`);
    } else {
      kinds.add(f.type);
    }
  }
  if (kinds.size === 0) return null; // only advisory nudges → not a real failure
  const last = events[events.length - 1];
  return {
    id: `pending-${safeName(sessionId)}`,
    sessionId,
    capturedAt: last?.createdAt ?? '',
    failureKinds: [...kinds],
    spans: toGenAiSpans(events),
    toolCount: events.filter((e) => e.type === 'tool_called').length,
    promoted: false,
  };
}

/** Read a session, build a failure case, and persist it for human promotion.
 *  Returns the case (or null when the session had no real failure). Best-effort
 *  on write — observability must never break anything. */
export function snapshotFailureTrajectory(sessionId: string, opts?: { dir?: string }): PendingEvalCase | null {
  const c = buildFailureCase(sessionId, listEvents(sessionId));
  if (!c) return null;
  try {
    const dir = opts?.dir ?? defaultDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `${c.id}.json`), JSON.stringify(c, null, 2), 'utf-8');
  } catch { /* best-effort */ }
  return c;
}

/** List the pending (un-promoted) eval cases awaiting human review. */
export function listPendingCorpus(opts?: { dir?: string }): PendingEvalCase[] {
  const dir = opts?.dir ?? defaultDir();
  if (!existsSync(dir)) return [];
  const out: PendingEvalCase[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try { out.push(JSON.parse(readFileSync(path.join(dir, f), 'utf-8')) as PendingEvalCase); } catch { /* skip */ }
  }
  return out;
}
