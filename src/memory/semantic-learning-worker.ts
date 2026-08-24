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
import { reflectOnToolReturn, type ReflectionResult } from './reflection.js';
import { openEventLog } from '../runtime/harness/eventlog.js';
import { closedCanonicalJson } from '../shared/closed-canonical-json.js';

const SHARD_LEASE_MS = 10 * 60_000;
const MAX_SHARD_ATTEMPTS = 4;

interface ClaimedShard {
  shardId: string;
  batchId: string;
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
  shardsClaimed: number;
  shardsCompleted: number;
  shardsRetried: number;
  shardsDeadLettered: number;
  extractorInvocations: number;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function interactiveForegroundBusy(): boolean {
  try {
    return Boolean(openEventLog().prepare(`
      SELECT 1
        FROM run_attempts
       WHERE finished_at IS NULL
       LIMIT 1
    `).get());
  } catch {
    // If foreground state cannot be proven idle, learning yields.
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
      SELECT s.shard_id, s.batch_id, s.reflection_call_id, s.manifest_json,
             s.manifest_hash, s.attempts, b.session_id
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

function rebuildShardInput(shard: ClaimedShard): string | null {
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
  if (Number(changed.changes) !== 1) return 'lost_lease';
  updateBatchStatus(shard.batchId, now);
  return terminal ? 'dead_lettered' : 'retried';
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
    shardsDeadLettered: 0,
    extractorInvocations: 0,
  };
  if ((options.requireIdle ?? true) && interactiveForegroundBusy()) {
    summary.foregroundBusy = true;
    return summary;
  }
  const limit = Math.max(1, Math.min(8, options.shardLimit ?? 2));
  for (let index = 0; index < limit; index += 1) {
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
    try {
      result = await reflectOnToolReturn({
        sessionId: shard.sessionId,
        callId: shard.reflectionCallId,
        tool: 'terminal_learning_batch',
        output,
        sourceUri: `memory-batch://${shard.batchId}/${shard.shardId}`,
        learningMode: 'terminal_batch',
      });
    } catch (error) {
      const state = retryShard(shard, error instanceof Error ? error.message : String(error));
      if (state === 'retried') summary.shardsRetried += 1;
      if (state === 'dead_lettered') summary.shardsDeadLettered += 1;
      continue;
    }
    if (completedWithoutAnotherExtraction(result, shard) && finishShard(shard)) {
      summary.shardsCompleted += 1;
      continue;
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
};
