import { types } from 'node:util';
import {
  insertInternalEventInTransaction, isKillRequested, listActiveRunAttemptOwnership,
  openEventLog, publishCommittedInternalEvent, type EventRow,
} from './eventlog.js';
import { assertRecoveryActivationOwned } from './recovery-activation.js';
import { readApprovalExecutionSource } from './approval-execution-source.js';
import { readConnectionExecutionDelivery } from './connection-execution-activation-proof.js';

/** Source-wide format-repair metering only; never model or tool authority. */
export interface ReplyFormatRepairSlotInput {
  sessionId: string;
  sourceUserSeq: number;
  attemptId: string;
  objectiveDigest: string;
  ownerInstructionsDigest: string;
  candidateDigest: string;
  original: { modelCallId: string; physicalAttempt: number; providerResponseIdDigest: string };
  author: { modelId: string; provider: string };
}

export type ReplyFormatRepairSlotResult = { status: 'claimed'; eventId: string }
  | { status: 'spent' }
  | { status: 'unavailable'; reason: 'invalid_input' | 'owner_unavailable' | 'storage_unavailable' };

const KIND = 'source_reply_format_repair_spent';
const unavailable = (reason: 'invalid_input' | 'owner_unavailable' | 'storage_unavailable'): ReplyFormatRepairSlotResult => ({ status: 'unavailable', reason });
const id = (value: unknown): value is string => typeof value === 'string'
  && /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,239}$/.test(value);
const digest = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || types.isProxy(value) || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error('invalid input');
  const copy: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(value)) {
    const own = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== 'string' || !keys.includes(key) || !own?.enumerable || !Object.hasOwn(own, 'value')) throw new Error('invalid input');
    copy[key] = own.value;
  }
  return copy;
}
function snapshot(value: ReplyFormatRepairSlotInput): ReplyFormatRepairSlotInput {
  const input = record(value, ['sessionId', 'sourceUserSeq', 'attemptId', 'objectiveDigest',
    'ownerInstructionsDigest', 'candidateDigest', 'original', 'author']);
  const original = record(input.original, ['modelCallId', 'physicalAttempt', 'providerResponseIdDigest']);
  const author = record(input.author, ['modelId', 'provider']);
  if (!id(input.sessionId) || !id(input.attemptId) || !Number.isSafeInteger(input.sourceUserSeq) || Number(input.sourceUserSeq) <= 0
    || !digest(input.objectiveDigest) || !digest(input.ownerInstructionsDigest) || !digest(input.candidateDigest)
    || !id(original.modelCallId) || !Number.isSafeInteger(original.physicalAttempt) || Number(original.physicalAttempt) <= 0
    || !digest(original.providerResponseIdDigest) || !id(author.modelId) || !id(author.provider)) throw new Error('invalid input');
  return { sessionId: input.sessionId, sourceUserSeq: Number(input.sourceUserSeq), attemptId: input.attemptId,
    objectiveDigest: input.objectiveDigest, ownerInstructionsDigest: input.ownerInstructionsDigest, candidateDigest: input.candidateDigest,
    original: { modelCallId: original.modelCallId, physicalAttempt: Number(original.physicalAttempt), providerResponseIdDigest: original.providerResponseIdDigest },
    author: { modelId: author.modelId, provider: author.provider } };
}

/** Atomically debit before dispatch. A successful claim is not reusable
 * permission: the caller still proves policy, private author and current owner.
 * Publication/late ownership failure cannot refund a committed debit. */
export function claimReplyFormatRepairSlot(value: ReplyFormatRepairSlotInput): ReplyFormatRepairSlotResult {
  let input: ReplyFormatRepairSlotInput;
  try { input = snapshot(value); } catch { return unavailable('invalid_input'); }
  let event: EventRow | undefined;
  try {
    assertRecoveryActivationOwned();
    const db = openEventLog();
    // A nested savepoint could publish before its enclosing transaction rolls
    // back. Never return a claimed slot from that unsupported boundary.
    if (db.inTransaction) return unavailable('storage_unavailable');
    const priorBusyTimeout = Number(db.pragma('busy_timeout', { simple: true }));
    if (!Number.isSafeInteger(priorBusyTimeout) || priorBusyTimeout < 0) return unavailable('storage_unavailable');
    let result: ReplyFormatRepairSlotResult;
    try {
      // This optional optimization must not stall behind another writer. The
      // setting is connection-local and restored synchronously on every path.
      db.pragma('busy_timeout = 0');
      result = db.transaction((): ReplyFormatRepairSlotResult => {
        assertRecoveryActivationOwned();
        const prior = db.prepare(`SELECT CASE WHEN json_valid(data_json) THEN json_type(data_json, '$.sourceUserSeq') END AS source_type,
            CASE WHEN json_valid(data_json) THEN json_extract(data_json, '$.sourceUserSeq') END AS source
          FROM events WHERE session_id = ? AND type = 'guardrail_tripped' AND role = 'system'
          AND CASE WHEN json_valid(data_json) THEN json_extract(data_json, '$.kind') = ?
            AND (json_type(data_json, '$.sourceUserSeq') IS NOT 'integer' OR json_extract(data_json, '$.sourceUserSeq') = ?)
            ELSE 1 END LIMIT 2`).all(input.sessionId, KIND, input.sourceUserSeq) as Array<{ source_type: string | null; source: unknown }>;
        if (prior.some(row => row.source_type !== 'integer')) return unavailable('storage_unavailable');
        if (prior.length) return { status: 'spent' };
        const source = db.prepare(`SELECT id, turn FROM events WHERE session_id = ? AND seq = ?
          AND type = 'user_input_received' AND role = 'user'
          AND CASE WHEN json_valid(data_json) THEN json_type(data_json) = 'object'
            AND (json_type(data_json, '$.synthetic') IS NULL OR json_type(data_json, '$.synthetic') = 'false') ELSE 0 END`)
          .get(input.sessionId, input.sourceUserSeq) as { id: string; turn: number } | undefined;
        const attempt = db.prepare(`SELECT source_user_seq, lease_expires_at FROM run_attempts WHERE session_id = ?
          AND attempt_id = ? AND status = 'active' AND finished_at IS NULL`)
          .get(input.sessionId, input.attemptId) as { source_user_seq: number | null; lease_expires_at: string | null } | undefined;
        const expiry = attempt?.lease_expires_at;
        if (!source || !attempt || typeof expiry !== 'string' || !Number.isFinite(Date.parse(expiry))
          || new Date(expiry).toISOString() !== expiry || expiry <= new Date().toISOString()
          || !Number.isSafeInteger(attempt.source_user_seq) || Number(attempt.source_user_seq) <= 0
          || isKillRequested(input.sessionId, { attemptId: input.attemptId })
          || listActiveRunAttemptOwnership(input.sessionId).some(row => row.attemptId !== input.attemptId && !row.workflowHandoff)) {
          return unavailable('owner_unavailable');
        }
        const deliverySource = Number(attempt.source_user_seq);
        const executionSource = deliverySource === input.sourceUserSeq ? deliverySource
          : readApprovalExecutionSource(db, { sessionId: input.sessionId, sourceUserSeq: deliverySource })
            ?? readConnectionExecutionDelivery(db, { sessionId: input.sessionId, deliverySourceUserSeq: deliverySource }, true)?.activation.executionSourceUserSeq;
        if (executionSource !== input.sourceUserSeq) return unavailable('owner_unavailable');
        const terminal = db.prepare(`SELECT 1 FROM events WHERE session_id = ? AND type = 'conversation_completed'
          AND CASE WHEN json_valid(data_json) THEN json_extract(data_json, '$.sourceUserSeq') = ?
            OR json_extract(data_json, '$.attemptId') = ? ELSE 1 END LIMIT 1`)
          .get(input.sessionId, deliverySource, input.attemptId);
        if (terminal) return unavailable('owner_unavailable');
        event = insertInternalEventInTransaction(db, { sessionId: input.sessionId, turn: source.turn, role: 'system',
          type: 'guardrail_tripped', parentEventId: source.id, data: { kind: KIND, version: 1, ...input } });
        assertRecoveryActivationOwned();
        return { status: 'claimed', eventId: event.id };
      }).immediate();
    } finally { db.pragma(`busy_timeout = ${priorBusyTimeout}`); }
    assertRecoveryActivationOwned();
    if (event) publishCommittedInternalEvent(event);
    assertRecoveryActivationOwned();
    return result;
  } catch {
    return unavailable('storage_unavailable');
  }
}
