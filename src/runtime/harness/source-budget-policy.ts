/** The accepted request's outer policy, not an execution grant or a fresh
 * allowance. Reconnect controls must never substitute their current settings. */
import { createHash } from 'node:crypto';
import { appendEvent, openEventLog } from './eventlog.js';
import { getHarnessBudgetSettings } from './budget-settings.js';
import { resolveRunTokenCeiling, runTokenBudgetEnforcementEnabled } from './run-token-budget.js';

export interface SourceBudgetPolicy {
  version: 1;
  sessionId: string;
  sourceUserSeq: number;
  /** Zero preserves the user's unlimited setting. */
  maxActiveMs: number;
  maxUncachedTokens: number;
  tokenEnforcementEnabled: boolean;
}
export interface SourceBudgetPolicyRef { eventId: string; digest: string }
export interface RetainedSourceBudgetPolicy extends SourceBudgetPolicyRef { policy: SourceBudgetPolicy }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const natural = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

export function assertSourceBudgetPolicyRef(value: SourceBudgetPolicyRef): void {
  if (!value || typeof value.eventId !== 'string' || !value.eventId
    || typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.digest)) {
    throw new Error('The retained task budget reference is invalid.');
  }
}

export function readSourceBudgetPolicy(source: { sessionId: string; sourceUserSeq: number },
  expected?: SourceBudgetPolicyRef): RetainedSourceBudgetPolicy | null {
  if (!source.sessionId || !natural(source.sourceUserSeq) || source.sourceUserSeq < 1) {
    throw new Error('Task budget policy has no exact accepted source.');
  }
  if (expected) assertSourceBudgetPolicyRef(expected);
  const rows = openEventLog().prepare(`SELECT p.id, p.role, p.data_json, p.parent_event_id, u.id AS source_id
    FROM events p JOIN events u ON u.session_id = p.session_id AND u.seq = ?
      AND u.type = 'user_input_received' AND u.role = 'user'
    WHERE p.session_id = ? AND p.type = 'accepted_source_budget'
      AND json_extract(p.data_json, '$.sourceUserSeq') = ? ORDER BY p.seq LIMIT 2`)
    .all(source.sourceUserSeq, source.sessionId, source.sourceUserSeq) as Array<{
      id: string; role: string; data_json: string; parent_event_id: string | null; source_id: string;
    }>;
  if (!rows.length && !expected) return null;
  if (rows.length !== 1) throw new Error('The original task budget policy is missing or ambiguous.');
  const row = rows[0]!;
  const data = JSON.parse(row.data_json) as { policy?: SourceBudgetPolicy; digest?: string };
  const policy = data.policy;
  if (!policy || policy.version !== 1 || policy.sessionId !== source.sessionId
    || policy.sourceUserSeq !== source.sourceUserSeq || row.parent_event_id !== row.source_id || row.role !== 'system'
    || !natural(policy.maxActiveMs) || !natural(policy.maxUncachedTokens)
    || typeof policy.tokenEnforcementEnabled !== 'boolean' || data.digest !== hash(policy)
    || (expected && (expected.eventId !== row.id || expected.digest !== data.digest))) {
    throw new Error('The original task budget policy is inconsistent.');
  }
  return { eventId: row.id, digest: data.digest!, policy };
}

/** Called by a fresh host entry before its preparation/model work. A source
 * that already started on an older runtime without a policy is left unknown;
 * today's settings must not be invented as that historical task's policy. */
export function captureSourceBudgetPolicy(source: { sessionId: string; sourceUserSeq: number },
  overrides: { maxWallClockMs?: number; maxRunTokens?: number } = {}): RetainedSourceBudgetPolicy | null {
  const db = openEventLog();
  return db.transaction(() => {
    const prior = readSourceBudgetPolicy(source);
    if (prior) return prior;
    const accepted = db.prepare(`SELECT id, turn FROM events WHERE session_id = ? AND seq = ?
      AND type = 'user_input_received' AND role = 'user'`).get(source.sessionId, source.sourceUserSeq) as {
        id: string; turn: number;
      } | undefined;
    if (!accepted) throw new Error('Task budget policy has no exact accepted source.');
    const started = db.prepare(`SELECT 1 FROM events WHERE session_id = ? AND seq > ?
      AND type = 'turn_started' LIMIT 1`)
      .get(source.sessionId, source.sourceUserSeq);
    // Historical turn_started rows did not name their source. Conservatively
    // retain uncertainty instead of attaching later settings to old work.
    if (started) return null;
    const budget = getHarnessBudgetSettings();
    const maxActiveMs = overrides.maxWallClockMs ?? budget.maxConversationWallMs;
    const maxUncachedTokens = resolveRunTokenCeiling({ override: overrides.maxRunTokens, budget });
    if (!natural(maxActiveMs) || !natural(maxUncachedTokens)) throw new Error('The task budget settings are invalid.');
    const policy: SourceBudgetPolicy = { version: 1, sessionId: source.sessionId, sourceUserSeq: source.sourceUserSeq,
      maxActiveMs, maxUncachedTokens,
      tokenEnforcementEnabled: runTokenBudgetEnforcementEnabled() };
    const digest = hash(policy);
    const event = appendEvent({ sessionId: source.sessionId, turn: accepted.turn, role: 'system',
      type: 'accepted_source_budget', parentEventId: accepted.id,
      data: { sourceUserSeq: source.sourceUserSeq, policy, digest } });
    return { eventId: event.id, digest, policy };
  }).immediate();
}
