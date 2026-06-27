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
import { createHash } from 'node:crypto';
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

// ── Judge-corpus baking (Lane A) ──────────────────────────────────────────────
// κ-calibration needs LABELED judge cases to grow the 10-seed gold set before the
// strict gate can ever flip on. The advisory boundary judges already emit a
// verdict on (almost) every run — goal_alignment_judged + output_grounding_judged
// — so harvest those into candidate cases a human can later label into the gold
// set. Same posture as the failure corpus above: additive, observational, off the
// hot path, deterministic, and it NEVER gates anything (judges stay advisory). The
// owner decision (2026-06-27) was "defer κ, bake the corpus" — this is the baking.

const JUDGE_EVENT_TYPES = new Set(['goal_alignment_judged', 'output_grounding_judged']);

export interface JudgeCandidateCase {
  id: string;
  sessionId: string;
  capturedAt: string;
  /** Which boundary judge produced the verdict. */
  judge: 'goal_fidelity' | 'numeric_grounding';
  /** The judge's own decision, normalized to pass/fail. */
  verdict: 'pass' | 'fail';
  /** True when the judge ran advisory-only (did not bounce the write). */
  advisory: boolean;
  /** Compact, judge-specific input summary for the human labeler. */
  input: Record<string, unknown>;
  reason: string;
  /** Set true once a human promotes it into the gold set. */
  promoted: boolean;
}

function judgeCandidatesDir(): string {
  return path.join(BASE_DIR, 'state', 'eval-corpus', 'judge-candidates');
}

/** Stable per (session, judge, verdict, reason, input): re-harvesting the same
 *  session never duplicates a verdict, but two distinct verdicts in one session
 *  stay distinct. */
function candidateId(sessionId: string, judge: string, verdict: string, reason: string, input: unknown): string {
  const seed = `${sessionId}|${judge}|${verdict}|${reason}|${JSON.stringify(input ?? {})}`;
  const h = createHash('sha1').update(seed).digest('hex').slice(0, 12);
  return `judge-${safeName(sessionId)}-${h}`;
}

/** PURE: extract judge-verdict candidate cases from a session's events. Empty
 *  when the session emitted no judge verdicts. capturedAt is each event's own
 *  time (deterministic — replay-stable). Deduped by content id. */
export function buildJudgeCandidateCases(sessionId: string, events: EventRow[]): JudgeCandidateCase[] {
  const out: JudgeCandidateCase[] = [];
  const seen = new Set<string>();
  for (const e of events) {
    if (!JUDGE_EVENT_TYPES.has(e.type)) continue;
    const d = (e.data ?? {}) as Record<string, unknown>;
    const reason = typeof d.reason === 'string' ? d.reason : '';
    let judge: JudgeCandidateCase['judge'];
    let verdict: 'pass' | 'fail';
    let input: Record<string, unknown>;
    if (e.type === 'goal_alignment_judged') {
      judge = 'goal_fidelity';
      verdict = d.fulfills === true ? 'pass' : 'fail';
      input = { toolName: typeof d.toolName === 'string' ? d.toolName : null, targets: Array.isArray(d.targets) ? d.targets : [] };
    } else {
      judge = 'numeric_grounding';
      verdict = d.grounded === true ? 'pass' : 'fail';
      input = { source: typeof d.source === 'string' ? d.source : null, figures: Array.isArray(d.figures) ? d.figures : [] };
    }
    const id = candidateId(sessionId, judge, verdict, reason, input);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ id, sessionId, capturedAt: e.createdAt ?? '', judge, verdict, advisory: d.advisory === true, input, reason, promoted: false });
  }
  return out;
}

/** Harvest a session's judge verdicts and persist them for later human labeling.
 *  Best-effort on write — observability must never break anything. Returns the
 *  cases (empty when the session had no judge verdicts). */
export function snapshotJudgeCandidates(sessionId: string, opts?: { dir?: string }): JudgeCandidateCase[] {
  const cases = buildJudgeCandidateCases(sessionId, listEvents(sessionId));
  if (cases.length === 0) return [];
  try {
    const dir = opts?.dir ?? judgeCandidatesDir();
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    for (const c of cases) {
      writeFileSync(path.join(dir, `${c.id}.json`), JSON.stringify(c, null, 2), 'utf-8');
    }
  } catch { /* best-effort */ }
  return cases;
}

/** List the harvested judge candidate cases awaiting human labeling. */
export function listJudgeCandidates(opts?: { dir?: string }): JudgeCandidateCase[] {
  const dir = opts?.dir ?? judgeCandidatesDir();
  if (!existsSync(dir)) return [];
  const out: JudgeCandidateCase[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try { out.push(JSON.parse(readFileSync(path.join(dir, f), 'utf-8')) as JudgeCandidateCase); } catch { /* skip */ }
  }
  return out;
}
