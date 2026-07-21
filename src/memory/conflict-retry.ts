/**
 * Pending memory-conflict retry (2026-07-20, attorney-bar memory audit M1).
 *
 * resolveConflict deliberately fails OPEN to ADD when the reflector/boundary
 * judge is unavailable ("better a duplicate than a lost fact") — but that left
 * the conflict LIVE forever: the old wrong fact stayed active + recallable
 * right next to its correction whenever auth was broken or no cross-family
 * judge existed (the same condition class as the brain-fallover incident).
 *
 * This module is the durable other half: every fail-open ADD records a
 * pending conflict; the nightly maintenance pass re-runs the SAME resolver
 * over each one once a model is available and applies the decision by marking
 * the loser superseded BY the existing winner (no third row — supersedeFact
 * would mint one). Entries self-expire (14 days / 5 attempts) and drop
 * automatically when either side was already resolved by other means
 * (self-heal, merge, a later supersede).
 *
 * Fail direction: everything here is REVERSIBLE bookkeeping — the applied
 * decision is the same soft supersede (active=0 + superseded_by chain) the
 * normal resolver path uses; pinned facts are never touched.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import { BASE_DIR } from '../config.js';
import { getFact, markFactSupersededBy } from './facts.js';
import { resolveConflict } from './reflection.js';

const logger = pino({ name: 'clementine.conflict-retry' });

const QUEUE_FILE = path.join(BASE_DIR, 'state', 'pending-memory-conflicts.json');
const MAX_ENTRIES = 200;
const MAX_AGE_MS = 14 * 24 * 60 * 60_000;
const MAX_ATTEMPTS = 5;

export interface PendingMemoryConflict {
  candidateFactId: number;
  similarFactIds: number[];
  recordedAt: string;
  attempts: number;
}

function readQueue(): PendingMemoryConflict[] {
  if (!existsSync(QUEUE_FILE)) return [];
  try {
    const parsed = JSON.parse(readFileSync(QUEUE_FILE, 'utf-8'));
    return Array.isArray(parsed) ? (parsed as PendingMemoryConflict[]) : [];
  } catch {
    // Quarantine, don't silently empty — same posture as the timers store.
    try { renameSync(QUEUE_FILE, `${QUEUE_FILE}.corrupt-${Date.now()}`); } catch { /* keep */ }
    return [];
  }
}

function writeQueue(entries: PendingMemoryConflict[]): void {
  mkdirSync(path.dirname(QUEUE_FILE), { recursive: true });
  writeFileSync(QUEUE_FILE, JSON.stringify(entries, null, 2), 'utf-8');
}

/** Record one fail-open ADD's live conflict. Dedupes by candidate; bounded. */
export function recordUnresolvedConflict(input: { candidateFactId: number; similarFactIds: number[] }): void {
  try {
    const queue = readQueue().filter((e) => e.candidateFactId !== input.candidateFactId);
    queue.push({
      candidateFactId: input.candidateFactId,
      similarFactIds: input.similarFactIds.slice(0, 10),
      recordedAt: new Date().toISOString(),
      attempts: 0,
    });
    writeQueue(queue.slice(-MAX_ENTRIES));
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'failed to record pending conflict');
  }
}

export interface ConflictRetryResult {
  scanned: number;
  resolved: number;
  stillPending: number;
  dropped: number;
}

/** Nightly pass: re-resolve every pending conflict a resolver can now judge.
 *  `resolver` is injectable for tests; defaults to the real resolveConflict. */
export async function retryPendingMemoryConflicts(
  opts: { resolver?: typeof resolveConflict; nowMs?: number } = {},
): Promise<ConflictRetryResult> {
  const now = opts.nowMs ?? Date.now();
  const resolver = opts.resolver ?? resolveConflict;
  const queue = readQueue();
  const result: ConflictRetryResult = { scanned: queue.length, resolved: 0, stillPending: 0, dropped: 0 };
  if (queue.length === 0) return result;
  const keep: PendingMemoryConflict[] = [];

  for (const entry of queue) {
    const ageMs = now - Date.parse(entry.recordedAt);
    if (!Number.isFinite(ageMs) || ageMs > MAX_AGE_MS || entry.attempts >= MAX_ATTEMPTS) {
      result.dropped += 1;
      continue;
    }
    const candidate = getFact(entry.candidateFactId);
    if (!candidate || !candidate.active) { result.dropped += 1; continue; } // resolved elsewhere
    const similar = entry.similarFactIds
      .map((id) => getFact(id))
      .filter((f): f is NonNullable<ReturnType<typeof getFact>> => Boolean(f && f.active));
    if (similar.length === 0) { result.dropped += 1; continue; } // losers already retired

    let decision: Awaited<ReturnType<typeof resolveConflict>>;
    try {
      decision = await resolver(
        { kind: candidate.kind, text: candidate.content, trustLevel: candidate.trustLevel ?? undefined },
        similar,
      );
    } catch {
      decision = { decision: 'ADD', unresolved: true };
    }
    if (decision.unresolved) {
      keep.push({ ...entry, attempts: entry.attempts + 1 });
      result.stillPending += 1;
      continue;
    }
    if ((decision.decision === 'DELETE' || decision.decision === 'UPDATE') && typeof decision.target_id === 'number') {
      // The candidate (already-added correction) wins; the old fact retires.
      const ok = markFactSupersededBy(decision.target_id, candidate.id);
      logger.info({ loser: decision.target_id, winner: candidate.id, ok, decision: decision.decision },
        'retried memory conflict resolved — stale fact superseded by the existing correction');
      result.resolved += 1;
      continue;
    }
    if (decision.decision === 'NOOP' && typeof decision.target_id === 'number') {
      // The EXISTING fact is canonical; the fail-open ADD was the duplicate.
      const ok = markFactSupersededBy(candidate.id, decision.target_id);
      logger.info({ loser: candidate.id, winner: decision.target_id, ok },
        'retried memory conflict resolved — duplicate fail-open ADD folded into the canonical fact');
      result.resolved += 1;
      continue;
    }
    // Considered ADD (facts genuinely coexist) — the conflict was benign.
    result.resolved += 1;
  }

  try { writeQueue(keep); } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err) }, 'failed to persist conflict queue');
  }
  return result;
}

/** Test hook. */
export function _resetPendingConflictsForTest(): void {
  try { writeQueue([]); } catch { /* best-effort */ }
}
