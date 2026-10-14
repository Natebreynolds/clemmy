/** A restrictive policy on one immutable accepted source, never session state. */
import { createHash } from 'node:crypto';
import { openEventLog } from '../runtime/harness/eventlog.js';
import { currentSourceSessionContext } from '../runtime/harness/source-session-context-scope.js';

export interface TurnLearningPolicy {
  version: 1;
  mode: 'exclude';
  reason: 'controlled_test' | 'owner_opt_out';
}

export interface TurnLearningSource {
  sessionId: string;
  sourceUserSeq: number;
}

export type TurnLearningPolicyResult =
  | { status: 'allowed' }
  | { status: 'excluded'; policy: TurnLearningPolicy }
  | { status: 'unavailable'; reason: 'learning_source_unavailable' | 'learning_policy_invalid' | 'learning_lineage_unavailable' };

export type TurnLearningScope =
  | { kind: 'standalone' }
  | { kind: 'source'; source: Readonly<TurnLearningSource> }
  | { kind: 'unavailable' };

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

/** The only option excludes learning. There is deliberately no allow override. */
export function parseTurnLearningPolicy(value: unknown): TurnLearningPolicy | undefined {
  if (value === undefined) return undefined;
  if (!record(value)
    || Object.keys(value).sort().join('\0') !== ['mode', 'reason', 'version'].join('\0')
    || value.version !== 1 || value.mode !== 'exclude'
    || (value.reason !== 'controlled_test' && value.reason !== 'owner_opt_out')) {
    throw new Error('INVALID_TURN_LEARNING_POLICY');
  }
  return { version: 1, mode: 'exclude', reason: value.reason };
}

export function turnLearningPolicyFields(value: unknown): { learningPolicy?: TurnLearningPolicy } {
  const policy = parseTurnLearningPolicy(value);
  return policy ? { learningPolicy: policy } : {};
}

/** Host-owned ancestry only; public requests must never accept this pointer. */
export function parseTurnLearningSource(value: unknown): TurnLearningSource | undefined {
  if (value === undefined) return undefined;
  if (!record(value)
    || Object.keys(value).sort().join('\0') !== ['sessionId', 'sourceUserSeq'].join('\0')
    || typeof value.sessionId !== 'string' || value.sessionId !== value.sessionId.trim()
    || typeof value.sourceUserSeq !== 'number'
    || !validSource(value as unknown as TurnLearningSource)) throw new Error('INVALID_TURN_LEARNING_SOURCE');
  return { sessionId: value.sessionId, sourceUserSeq: value.sourceUserSeq };
}

/** Capture once before queueing/awaiting. Never reselect from ambient context. */
export function captureTurnLearningScope(input: { sessionId?: string; sourceUserSeq?: number }): TurnLearningScope {
  if (input.sessionId === undefined) return input.sourceUserSeq === undefined
    ? { kind: 'standalone' } : { kind: 'unavailable' };
  const sourceUserSeq = input.sourceUserSeq === undefined
    ? currentSourceSessionContext(input.sessionId)?.sourceUserSeq : input.sourceUserSeq;
  if (sourceUserSeq === undefined) return { kind: 'unavailable' };
  const source = Object.freeze({ sessionId: input.sessionId, sourceUserSeq });
  return readTurnLearningPolicyForSource(source).status === 'unavailable'
    ? { kind: 'unavailable' } : { kind: 'source', source };
}

export function readTurnLearningPolicyForScope(scope: TurnLearningScope): TurnLearningPolicyResult {
  return scope.kind === 'source' ? readTurnLearningPolicyForSource(scope.source)
    : scope.kind === 'standalone' ? { status: 'allowed' }
      : { status: 'unavailable', reason: 'learning_source_unavailable' };
}

function validSource(value: TurnLearningSource): boolean {
  return typeof value.sessionId === 'string' && value.sessionId.trim().length > 0
    && Number.isSafeInteger(value.sourceUserSeq) && value.sourceUserSeq > 0;
}

/**
 * Reopen the exact accepted source for every admission and materialization.
 * A child may inherit an exclusion only through the existing immutable,
 * digest-bound source-composition parent. No source is selected by chronology,
 * prose, a session id alone, or mutable session metadata. Missing identity
 * suppresses optional learning; execution and its accounting remain available.
 */
export function readTurnLearningPolicyForSource(source: TurnLearningSource): TurnLearningPolicyResult {
  if (!validSource(source)) return { status: 'unavailable', reason: 'learning_source_unavailable' };
  try {
    const db = openEventLog();
    const hasContexts = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='source_session_contexts_v1'").get());
    // One synchronous check may reach the same immutable parent through both
    // ancestry carriers. Memoize only within this call and retain the expected
    // digest in the key; later task checks always reopen durable policy.
    const memo = new Map<string, TurnLearningPolicyResult>();
    let exactLookups = 0;
    function read(current: TurnLearningSource, expectedDigest?: string, ancestors = new Set<string>()): TurnLearningPolicyResult {
      const key = JSON.stringify([current.sessionId, current.sourceUserSeq]);
      if (!validSource(current) || ancestors.has(key) || ancestors.size >= 32) {
        return { status: 'unavailable', reason: 'learning_lineage_unavailable' };
      }
      // Cycle checks precede cache hits: a retained result cannot authorize an
      // edge back into the path currently being traversed.
      const memoKey = JSON.stringify([current.sessionId, current.sourceUserSeq, expectedDigest ?? null]);
      const cached = memo.get(memoKey);
      if (cached) return cached;
      if (exactLookups >= 64) return { status: 'unavailable', reason: 'learning_lineage_unavailable' };
      exactLookups += 1;
      const result = readUncached(current, expectedDigest, new Set(ancestors).add(key));
      memo.set(memoKey, result);
      return result;
    }
    function readUncached(current: TurnLearningSource, expectedDigest: string | undefined, path: Set<string>): TurnLearningPolicyResult {
      const row = db.prepare("SELECT data_json FROM events WHERE session_id=? AND seq=? AND type='user_input_received' AND role='user'")
        .get(current.sessionId, current.sourceUserSeq) as { data_json: string } | undefined;
      if (!row) return { status: 'unavailable', reason: 'learning_source_unavailable' };
      let data: unknown;
      try { data = JSON.parse(row.data_json); } catch { return { status: 'unavailable', reason: 'learning_policy_invalid' }; }
      if (!record(data)) return { status: 'unavailable', reason: 'learning_policy_invalid' };
      let policy: TurnLearningPolicy | undefined;
      try { policy = parseTurnLearningPolicy(data.learningPolicy); }
      catch { return { status: 'unavailable', reason: 'learning_policy_invalid' }; }
      const context = hasContexts ? db.prepare('SELECT identity_json, identity_digest FROM source_session_contexts_v1 WHERE session_id=? AND source_user_seq=?')
        .get(current.sessionId, current.sourceUserSeq) as { identity_json: string; identity_digest: string } | undefined : undefined;
      if (!context && expectedDigest) return { status: 'unavailable', reason: 'learning_lineage_unavailable' };
      // This source's own explicit exclusion cannot be overridden by ancestry.
      if (policy && !expectedDigest) return { status: 'excluded', policy };
      let identity: unknown;
      if (context) {
        try { identity = JSON.parse(context.identity_json); } catch { return { status: 'unavailable', reason: 'learning_lineage_unavailable' }; }
        if (!record(identity) || identity.version !== 1 || identity.sessionId !== current.sessionId
          || identity.sourceUserSeq !== current.sourceUserSeq
          || createHash('sha256').update(JSON.stringify(identity)).digest('hex') !== context.identity_digest
          || (expectedDigest !== undefined && expectedDigest !== context.identity_digest)) {
          return { status: 'unavailable', reason: 'learning_lineage_unavailable' };
        }
      }
      if (policy) return { status: 'excluded', policy };
      let policySource: TurnLearningSource | undefined;
      try { policySource = parseTurnLearningSource(data.learningPolicySource); }
      catch { return { status: 'unavailable', reason: 'learning_lineage_unavailable' }; }
      if (policySource) {
        const inherited = read(policySource, undefined, path);
        if (inherited.status !== 'allowed') return inherited;
      }
      if (!identity) return { status: 'allowed' };
      // The context was checked above, including its immutable identity digest.
      if (!record(identity)) return { status: 'unavailable', reason: 'learning_lineage_unavailable' };
      if (identity.parent === undefined) return { status: 'allowed' };
      const parent = identity.parent;
      if (!record(parent) || Object.keys(parent).sort().join('\0') !== ['digest', 'sessionId', 'sourceUserSeq'].join('\0')
        || typeof parent.sessionId !== 'string' || typeof parent.sourceUserSeq !== 'number'
        || typeof parent.digest !== 'string' || !/^[a-f0-9]{64}$/.test(parent.digest)) {
        return { status: 'unavailable', reason: 'learning_lineage_unavailable' };
      }
      return read({ sessionId: parent.sessionId, sourceUserSeq: parent.sourceUserSeq }, parent.digest, path);
    }
    return read(source);
  } catch {
    return { status: 'unavailable', reason: 'learning_source_unavailable' };
  }
}
