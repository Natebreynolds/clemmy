/**
 * Restart-safe terminal semantic-learning drain.
 *
 * Canonical execution state is read from harness.db; the only mutable queue is
 * the memory projection created by learning-intake. A shard is claimed with a
 * durable lease and invokes the extractor at most once per claim. Foreground
 * work is never awaited and always wins admission.
 */
import { createHash, randomUUID } from 'node:crypto';
import { openMemoryDb } from './db.js';
import {
  discoverTerminalLearningBatches,
  listMemoryLearningMemberReceipts,
  selectedLearningSource,
  type MemoryLearningShardManifest,
  type TerminalLearningIntakeSummary,
} from './learning-intake.js';
import { reflectionExtractorPause, reflectOnToolReturn, type ReflectionResult } from './reflection.js';
import { memoryModelAvailability } from './memory-model-route.js';
import { readMemoryLearningWaiting, setMemoryLearningWaiting } from './memory-work-journal.js';
import type { MemoryModelProblem, MemoryWorkWaiting } from './memory-work-types.js';
import {
  factIdStrings,
  memoryJobFailed,
  memoryWorkSourceForSession,
  notedMemoryModelProblem,
  runMemoryModelJob,
  type MemoryJobNote,
} from './memory-job-context.js';
import type { MemoryJobOutcome } from './memory-work-journal.js';
import { openEventLog } from '../runtime/harness/eventlog.js';
import { closedCanonicalJson } from '../shared/closed-canonical-json.js';

const SHARD_LEASE_MS = 10 * 60_000;
const MAX_SHARD_ATTEMPTS = 4;

interface ClaimedShard {
  shardId: string;
  batchId: string;
  /** 0-based position of this shard in its batch, and the batch's shard count:
   *  a long conversation is read in parts. */
  ordinal: number;
  shardCount: number;
  reflectionCallId: string;
  manifestJson: string;
  manifestHash: string;
  attempts: number;
  leaseToken: string;
  sessionId: string;
}

export interface TerminalSemanticLearningSummary {
  intake: TerminalLearningIntakeSummary;
  foregroundBusy: boolean;
  /** Set when the pass claimed nothing more because the memory model is
   *  paused or cannot be served; learning waits instead of spending tries. */
  modelWaiting?: 'model_paused' | 'model_unavailable';
  shardsClaimed: number;
  shardsCompleted: number;
  shardsRetried: number;
  /** Parts handed back untried because the memory model became unavailable
   *  while reading them (the try is not counted). */
  shardsWaiting: number;
  shardsDeadLettered: number;
  extractorInvocations: number;
}

/** What learning waits behind when the foreground is busy. */
export interface ForegroundBlocker {
  kind: 'chat' | 'workflow' | 'background' | 'other';
  /** When the oldest unfinished run began; absent when unknown. */
  startedAt?: string;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function interactiveForegroundBusy(): boolean {
  return interactiveForegroundBlocker() !== null;
}

/**
 * The oldest unfinished run learning yields to — its kind (a conversation, a
 * workflow, background work) and when it started — or null when the
 * foreground is idle. Any open run attempt counts, not only the owner's.
 */
export function interactiveForegroundBlocker(): ForegroundBlocker | null {
  try {
    const db = openEventLog();
    // The cheap existence probe first; the ordered read only when busy.
    if (!db.prepare('SELECT 1 FROM run_attempts WHERE finished_at IS NULL LIMIT 1').get()) return null;
    const oldest = db.prepare(`
      SELECT ra.session_id, ra.started_at, s.kind
        FROM run_attempts ra
        LEFT JOIN sessions s ON s.id = ra.session_id
       WHERE ra.finished_at IS NULL
       ORDER BY ra.started_at ASC
       LIMIT 1
    `).get() as { session_id: string; started_at: string | null; kind: string | null } | undefined;
    if (!oldest) return null; // finished between the two reads
    const startedMs = Date.parse(oldest.started_at ?? '');
    return {
      kind: foregroundKind(oldest.session_id, oldest.kind),
      ...(Number.isFinite(startedMs) ? { startedAt: new Date(startedMs).toISOString() } : {}),
    };
  } catch {
    // If foreground state cannot be proven idle, learning yields.
    return { kind: 'other' };
  }
}

function foregroundKind(sessionId: string, kind: string | null): ForegroundBlocker['kind'] {
  if (kind === 'workflow' || sessionId.startsWith('workflow:')) return 'workflow';
  if (kind === 'chat') return 'chat';
  if (kind === 'execution' || kind === 'agent') return 'background';
  return 'other';
}

/** State, on every pass, why learning waits. `since` is kept while the
 *  reason stays the same, so the Memory tab can say how long it has waited. */
function noteLearningWaiting(waiting: Omit<MemoryWorkWaiting, 'since'>): void {
  const prior = readMemoryLearningWaiting();
  const same = prior && prior.reason === waiting.reason && (prior.problem ?? null) === (waiting.problem ?? null);
  setMemoryLearningWaiting({ ...waiting, since: same && prior.since ? prior.since : new Date().toISOString() });
}

/** Why the memory model cannot take a part right now, as a waiting note, or
 *  null when it can. */
function modelWaiting(): Omit<MemoryWorkWaiting, 'since'> | null {
  const availability = memoryModelAvailability('learn');
  if (availability.ok) return null;
  return {
    reason: availability.reason,
    ...(availability.problem ? { problem: availability.problem } : {}),
    ...(availability.until ? { until: availability.until } : {}),
  };
}

/** Problems that mean the memory model cannot be reached at all right now;
 *  a part that hit one waits for the model instead of spending a try. A
 *  timeout or an error might be the part's own, so those still count. */
const MODEL_OUT_OF_REACH: ReadonlySet<MemoryModelProblem> = new Set(['quota', 'credit', 'not_connected']);

/**
 * Parts the memory model refused as out of reach, in this process: how often
 * each was handed back, how many parts the model had answered at its latest
 * refusal, and whether its refusals are known to be its own. A handed-back
 * part is claimed first once the pause lifts, so from its second hand-back it
 * goes behind the pause and the parts queued after it: one part cannot hold
 * up the rest. When the model answers another part while this one keeps being
 * refused, the refusal is this part's own, and from then on it spends its try
 * like any failure, so it still reaches dead letter. While nothing else gets
 * an answer, nothing is spent: that is the model being out of reach.
 */
interface RefusedPart { handedBack: number; answeredAtRefusal: number; own: boolean }
const refusedParts = new Map<string, RefusedPart>();
const REFUSED_PARTS_KEPT = 1_000;
/** Parts the memory model answered in this process (usable or not). */
let partsAnswered = 0;

function rememberRefusedPart(shardId: string, part: RefusedPart): void {
  refusedParts.delete(shardId);
  if (refusedParts.size >= REFUSED_PARTS_KEPT) {
    const oldest = refusedParts.keys().next().value;
    if (oldest !== undefined) refusedParts.delete(oldest);
  }
  refusedParts.set(shardId, part);
}

/** When a handed-back part is due again: at once the first time (the pause
 *  holds the next pass anyway); after that, behind the pause plus a growing
 *  gap, so the parts queued after it come up first. */
function handedBackDueAt(handedBack: number, until: string | undefined, nowMs = Date.now()): string {
  if (handedBack <= 1) return new Date(nowMs).toISOString();
  const untilMs = until ? Date.parse(until) : Number.NaN;
  const from = Number.isFinite(untilMs) && untilMs > nowMs ? untilMs : nowMs;
  return new Date(from + Math.min(30 * 60_000, 30_000 * 2 ** (handedBack - 2))).toISOString();
}

/** Whether a part is due to be read now (the claim's own condition). When
 *  the queue cannot be read, say yes: the note then names the real blocker. */
function learningPartDue(nowMs = Date.now()): boolean {
  try {
    const now = new Date(nowMs).toISOString();
    return Boolean(openMemoryDb().prepare(`
      SELECT 1 FROM memory_learning_shards
       WHERE attempts < ?
         AND (
           (status = 'pending' AND next_attempt_at <= ?)
           OR (status = 'processing' AND lease_expires_at <= ?)
         )
       LIMIT 1
    `).get(MAX_SHARD_ATTEMPTS, now, now));
  } catch {
    return true;
  }
}

function claimNextShard(nowMs = Date.now()): ClaimedShard | null {
  const db = openMemoryDb();
  const now = new Date(nowMs).toISOString();
  const leaseToken = randomUUID();
  const leaseExpiresAt = new Date(nowMs + SHARD_LEASE_MS).toISOString();
  return db.transaction(() => {
    const row = db.prepare(`
      SELECT s.shard_id, s.batch_id, s.ordinal, b.shard_count, s.reflection_call_id,
             s.manifest_json, s.manifest_hash, s.attempts, b.session_id
        FROM memory_learning_shards s
        JOIN memory_learning_batches b ON b.batch_id = s.batch_id
       WHERE s.attempts < ?
         AND (
           (s.status = 'pending' AND s.next_attempt_at <= ?)
           OR (s.status = 'processing' AND s.lease_expires_at <= ?)
         )
       ORDER BY s.created_at, s.ordinal
       LIMIT 1
    `).get(MAX_SHARD_ATTEMPTS, now, now) as {
      shard_id: string;
      batch_id: string;
      ordinal: number;
      shard_count: number;
      reflection_call_id: string;
      manifest_json: string;
      manifest_hash: string;
      attempts: number;
      session_id: string;
    } | undefined;
    if (!row) return null;
    const changed = db.prepare(`
      UPDATE memory_learning_shards
         SET status = 'processing', attempts = attempts + 1,
             lease_token = ?, lease_expires_at = ?, updated_at = ?
       WHERE shard_id = ? AND attempts = ?
         AND (
           (status = 'pending' AND next_attempt_at <= ?)
           OR (status = 'processing' AND lease_expires_at <= ?)
         )
    `).run(leaseToken, leaseExpiresAt, now, row.shard_id, row.attempts, now, now);
    if (Number(changed.changes) !== 1) return null;
    return {
      shardId: row.shard_id,
      batchId: row.batch_id,
      ordinal: Number(row.ordinal),
      shardCount: Number(row.shard_count),
      reflectionCallId: row.reflection_call_id,
      manifestJson: row.manifest_json,
      manifestHash: row.manifest_hash,
      attempts: row.attempts + 1,
      leaseToken,
      sessionId: row.session_id,
    };
  }).immediate();
}

function parseManifest(shard: ClaimedShard): MemoryLearningShardManifest | null {
  if (sha256(shard.manifestJson) !== shard.manifestHash) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(shard.manifestJson); } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const manifest = parsed as Partial<MemoryLearningShardManifest>;
  if (manifest.version !== 1 || !Array.isArray(manifest.sources) || manifest.sources.length === 0) return null;
  for (const source of manifest.sources) {
    if (
      !source
      || !Number.isSafeInteger(source.memberOrdinal)
      || !Number.isSafeInteger(source.start)
      || !Number.isSafeInteger(source.end)
      || source.start < 0
      || source.end <= source.start
      || typeof source.sliceDigest !== 'string'
      || source.sliceDigest.length !== 64
    ) return null;
  }
  try {
    if (closedCanonicalJson(manifest) !== shard.manifestJson) return null;
  } catch { return null; }
  return manifest as MemoryLearningShardManifest;
}

/** Test seam: a shard's source text without a harness settlement behind it. */
let rebuildOverrideForTest: ((shardId: string) => string | null) | null = null;

function rebuildShardInput(shard: ClaimedShard): string | null {
  if (rebuildOverrideForTest) return rebuildOverrideForTest(shard.shardId);
  const manifest = parseManifest(shard);
  if (!manifest) return null;
  const members = new Map(listMemoryLearningMemberReceipts(shard.batchId).map((member) => (
    [member.ordinal, member]
  )));
  const pieces: string[] = [];
  for (const source of manifest.sources) {
    const member = members.get(source.memberOrdinal);
    if (!member) return null;
    const selected = selectedLearningSource(member);
    if (!selected || source.end > selected.length) return null;
    const slice = selected.slice(source.start, source.end);
    if (sha256(slice) !== source.sliceDigest) return null;
    pieces.push([
      `[SOURCE member=${member.memberId} result_handle=${member.resultHandleId ?? 'none'} digest=${member.resultDigest ?? 'none'} range=${source.start}:${source.end}]`,
      slice,
    ].join('\n'));
  }
  return pieces.join('\n\n');
}

function updateBatchStatus(batchId: string, now: string): void {
  const db = openMemoryDb();
  const counts = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'dead_letter' THEN 1 ELSE 0 END) AS dead,
      SUM(CASE WHEN status IN ('pending','processing') THEN 1 ELSE 0 END) AS open
      FROM memory_learning_shards WHERE batch_id = ?
  `).get(batchId) as { dead: number | null; open: number | null };
  const status = Number(counts.dead) > 0
    ? 'dead_letter'
    : Number(counts.open) === 0 ? 'completed' : 'pending';
  db.prepare(`
    UPDATE memory_learning_batches
       SET status = ?, updated_at = ?,
           completed_at = CASE WHEN ? = 'completed' THEN ? ELSE completed_at END,
           last_error = CASE WHEN ? = 'dead_letter' THEN 'one or more learning shards exhausted retries' ELSE last_error END
     WHERE batch_id = ?
  `).run(status, now, status, now, status, batchId);
}

function finishShard(shard: ClaimedShard): boolean {
  const db = openMemoryDb();
  const now = new Date().toISOString();
  const changed = db.prepare(`
    UPDATE memory_learning_shards
       SET status = 'completed', lease_token = NULL, lease_expires_at = NULL,
           updated_at = ?, completed_at = ?, last_error = NULL
     WHERE shard_id = ? AND status = 'processing' AND lease_token = ?
  `).run(now, now, shard.shardId, shard.leaseToken);
  if (Number(changed.changes) === 1) updateBatchStatus(shard.batchId, now);
  refusedParts.delete(shard.shardId);
  return Number(changed.changes) === 1;
}

function retryShard(shard: ClaimedShard, error: string): 'retried' | 'dead_lettered' | 'lost_lease' {
  const db = openMemoryDb();
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  const terminal = shard.attempts >= MAX_SHARD_ATTEMPTS;
  const retryAt = new Date(nowMs + Math.min(30 * 60_000, 30_000 * (2 ** Math.max(0, shard.attempts - 1)))).toISOString();
  const changed = db.prepare(`
    UPDATE memory_learning_shards
       SET status = ?, lease_token = NULL, lease_expires_at = NULL,
           next_attempt_at = ?, updated_at = ?, last_error = ?
     WHERE shard_id = ? AND status = 'processing' AND lease_token = ?
  `).run(terminal ? 'dead_letter' : 'pending', retryAt, now, error.slice(0, 1_000), shard.shardId, shard.leaseToken);
  if (terminal || Number(changed.changes) !== 1) refusedParts.delete(shard.shardId);
  if (Number(changed.changes) !== 1) return 'lost_lease';
  updateBatchStatus(shard.batchId, now);
  return terminal ? 'dead_lettered' : 'retried';
}

/** Hand a claimed part back untried: the memory model became unavailable
 *  while it was being read, so the try it spent is returned. It is due again
 *  at `dueAt` (now unless it keeps being handed back). */
function releaseShardForModel(shard: ClaimedShard, why: string, dueAt?: string): boolean {
  const db = openMemoryDb();
  const now = new Date().toISOString();
  const changed = db.prepare(`
    UPDATE memory_learning_shards
       SET status = 'pending', attempts = MAX(0, attempts - 1), lease_token = NULL,
           lease_expires_at = NULL, next_attempt_at = ?, updated_at = ?, last_error = ?
     WHERE shard_id = ? AND status = 'processing' AND lease_token = ?
  `).run(dueAt ?? now, now, why.slice(0, 1_000), shard.shardId, shard.leaseToken);
  return Number(changed.changes) === 1;
}

function reflectionReceiptStatus(shard: ClaimedShard): { status: string; lastAttemptAt: string } | null {
  const row = openMemoryDb().prepare(`
    SELECT status, last_attempt_at FROM memory_reflection_receipts
     WHERE session_id = ? AND call_id = ?
  `).get(shard.sessionId, shard.reflectionCallId) as {
    status: string;
    last_attempt_at: string;
  } | undefined;
  return row ? { status: row.status, lastAttemptAt: row.last_attempt_at } : null;
}

function completedWithoutAnotherExtraction(result: ReflectionResult, shard: ClaimedShard): boolean {
  if (result.skipped === 'already_reflected') {
    const receipt = reflectionReceiptStatus(shard);
    return receipt?.status === 'completed' || receipt?.status === 'buffered';
  }
  return result.skipped === undefined
    || result.skipped === 'disabled'
    || result.skipped === 'too_short'
    || result.skipped === 'self_tool'
    || result.skipped === 'write_receipt';
}

/** The learn job's record of one part: what the extractor noticed, what was
 *  kept (by fact id), left out or set aside. A failed extraction names the
 *  model's problem when it is known (the error it hit, or the backoff it set). */
function learnOutcome(result: ReflectionResult, note: MemoryJobNote): MemoryJobOutcome {
  if (result.skipped === 'extractor_failed') {
    return memoryJobFailed(note, {}, notedMemoryModelProblem(note) ?? reflectionExtractorPause()?.problem ?? null);
  }
  const learning = result.learning;
  if (!learning) return { outcome: 'nothing_new' };
  const facts = {
    learned: factIdStrings(learning.learnedFactIds),
    updated: factIdStrings(learning.updatedFactIds),
    reinforced: factIdStrings(learning.reinforcedFactIds),
  };
  const produced = {
    claims: learning.claims,
    learned: facts.learned.length,
    updated: facts.updated.length,
    reinforced: facts.reinforced.length,
    leftOut: learning.leftOut,
    setAside: learning.setAside,
  };
  const kept = produced.learned + produced.updated + produced.reinforced + produced.setAside;
  return { outcome: kept > 0 ? 'ok' : 'nothing_new', produced, facts };
}

export async function drainTerminalSemanticLearning(options: {
  discoverLimit?: number;
  shardLimit?: number;
  requireIdle?: boolean;
} = {}): Promise<TerminalSemanticLearningSummary> {
  const intake = discoverTerminalLearningBatches(options.discoverLimit);
  const summary: TerminalSemanticLearningSummary = {
    intake,
    foregroundBusy: false,
    shardsClaimed: 0,
    shardsCompleted: 0,
    shardsRetried: 0,
    shardsWaiting: 0,
    shardsDeadLettered: 0,
    extractorInvocations: 0,
  };
  // Learning waits for the memory model BEFORE it claims anything. A paused
  // or unreachable model used to fail every claimed part at once, and four
  // such claims dead-lettered it: learning was silently thrown away.
  const unavailable = modelWaiting();
  if (unavailable) {
    summary.modelWaiting = unavailable.reason as TerminalSemanticLearningSummary['modelWaiting'];
    noteLearningWaiting(unavailable);
    return summary;
  }
  if (options.requireIdle ?? true) {
    const blocker = interactiveForegroundBlocker();
    if (blocker) {
      summary.foregroundBusy = true;
      // Learning waits behind the run only when a part is due now; with
      // nothing to read, nothing is waiting.
      if (learningPartDue()) noteLearningWaiting({ reason: 'busy', blocker });
      else setMemoryLearningWaiting(null);
      return summary;
    }
  }
  setMemoryLearningWaiting(null);
  const limit = Math.max(1, Math.min(8, options.shardLimit ?? 2));
  for (let index = 0; index < limit; index += 1) {
    // A backoff the previous part set stops the pass before the next claim.
    const paused = index > 0 ? modelWaiting() : null;
    if (paused) {
      summary.modelWaiting = paused.reason as TerminalSemanticLearningSummary['modelWaiting'];
      noteLearningWaiting(paused);
      break;
    }
    const shard = claimNextShard();
    if (!shard) break;
    summary.shardsClaimed += 1;
    const existingReceipt = reflectionReceiptStatus(shard);
    if (existingReceipt?.status === 'completed' || existingReceipt?.status === 'buffered') {
      if (finishShard(shard)) summary.shardsCompleted += 1;
      continue;
    }
    if (
      existingReceipt?.status === 'processing'
      && Date.now() - Date.parse(existingReceipt.lastAttemptAt) < SHARD_LEASE_MS
    ) {
      const state = retryShard(shard, 'reflection receipt is still processing');
      if (state === 'retried') summary.shardsRetried += 1;
      if (state === 'dead_lettered') summary.shardsDeadLettered += 1;
      continue;
    }
    const output = rebuildShardInput(shard);
    if (!output) {
      const state = retryShard(shard, 'canonical shard source could not be rebuilt');
      if (state === 'retried') summary.shardsRetried += 1;
      if (state === 'dead_lettered') summary.shardsDeadLettered += 1;
      continue;
    }
    summary.extractorInvocations += 1;
    let result: ReflectionResult;
    // What this part's own read saw: whether its model was asked at all, and
    // the model error it hit, with that error's problem class.
    const seen: { asked: boolean; errored: boolean; problem: MemoryModelProblem | null } = {
      asked: false,
      errored: false,
      problem: null,
    };
    try {
      // Reading one part of a finished conversation is the `learn` memory job.
      result = await runMemoryModelJob('learn', {
        source: memoryWorkSourceForSession(shard.sessionId, { kind: 'conversation', sessionId: shard.sessionId }),
        part: shard.ordinal + 1,
        parts: Math.max(shard.shardCount, shard.ordinal + 1),
      }, () => reflectOnToolReturn({
        sessionId: shard.sessionId,
        callId: shard.reflectionCallId,
        tool: 'terminal_learning_batch',
        output,
        sourceUri: `memory-batch://${shard.batchId}/${shard.shardId}`,
        learningMode: 'terminal_batch',
      }), (value, note) => {
        seen.asked = typeof note.requestedModelId === 'string';
        seen.errored = note.error !== undefined;
        seen.problem = notedMemoryModelProblem(note);
        return learnOutcome(value, note);
      });
    } catch (error) {
      const state = retryShard(shard, error instanceof Error ? error.message : String(error));
      if (state === 'retried') summary.shardsRetried += 1;
      if (state === 'dead_lettered') summary.shardsDeadLettered += 1;
      continue;
    }
    if (seen.asked && !seen.errored) partsAnswered += 1;
    if (completedWithoutAnotherExtraction(result, shard) && finishShard(shard)) {
      summary.shardsCompleted += 1;
      continue;
    }
    if (result.skipped === 'extractor_failed') {
      // The model was out of reach: hand the part back with its try returned
      // and stop; the gate above holds the next pass. A part that asked its
      // model answers for what the model said: only a refusal for quota,
      // credit or sign-in is out of reach. A timeout, any other error or
      // unusable output spends the try, even when the error paused the
      // extractor, so a part that keeps failing still reaches dead letter.
      // A part whose model was never asked (the pause was already on, or
      // there was no route) waits while the model is unavailable.
      const waiting = modelWaiting();
      const problem = seen.problem;
      const asked = seen.asked || seen.errored;
      const outOfReach = asked
        ? problem !== null && MODEL_OUT_OF_REACH.has(problem)
        : waiting !== null;
      // The model refused this part. If it has answered another part since
      // this one was last refused, the refusal is the part's own: the try is
      // spent below instead of handed back.
      const refused = asked && outOfReach;
      const prior = refused ? refusedParts.get(shard.shardId) : undefined;
      const own = prior !== undefined && (prior.own || partsAnswered > prior.answeredAtRefusal);
      if (prior && own) rememberRefusedPart(shard.shardId, { ...prior, answeredAtRefusal: partsAnswered, own: true });
      if (outOfReach && !own) {
        const why = waiting ?? { reason: 'model_unavailable' as const, ...(problem ? { problem } : {}) };
        const handedBack = (prior?.handedBack ?? 0) + 1;
        if (refused) rememberRefusedPart(shard.shardId, { handedBack, answeredAtRefusal: partsAnswered, own: false });
        const dueAt = handedBackDueAt(handedBack, why.until);
        if (releaseShardForModel(shard, `waiting for the memory model: ${why.problem ?? why.reason}`, dueAt)) summary.shardsWaiting += 1;
        summary.modelWaiting = why.reason as TerminalSemanticLearningSummary['modelWaiting'];
        noteLearningWaiting(why);
        break;
      }
    }
    const state = retryShard(shard, `reflection did not complete: ${result.skipped ?? 'unknown'}`);
    if (state === 'retried') summary.shardsRetried += 1;
    if (state === 'dead_lettered') summary.shardsDeadLettered += 1;
  }
  return summary;
}

export const _testOnlySemanticLearningWorker = {
  claimNextShard,
  parseManifest,
  rebuildShardInput,
  /** Forget which parts the model refused (in-process state). */
  resetRefusedParts(): void {
    refusedParts.clear();
    partsAnswered = 0;
  },
  setShardInputRebuilder(fn: ((shardId: string) => string | null) | null): void {
    rebuildOverrideForTest = fn;
  },
};
