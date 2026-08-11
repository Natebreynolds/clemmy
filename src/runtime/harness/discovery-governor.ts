import type Database from 'better-sqlite3';
import { openEventLog } from './eventlog.js';

/**
 * Durable discovery admission for one accepted user task.
 *
 * The accepted task identity is `(sessionId, sourceUserSeq)`, deliberately not
 * a model turn, runner attempt, or provider call. That keeps the same budget
 * across continuations, brain fallover, MCP child processes, and daemon
 * restarts.
 *
 * This module owns only persistence and admission. Tool classification and
 * lifecycle telemetry emission belong at the tool boundaries that integrate
 * it. The returned telemetry envelope is intentionally provider-neutral.
 */

export const DISCOVERY_GOVERNOR_EVENT_NAME = 'discovery_governor_decision' as const;
export const DISCOVERY_GOVERNOR_OUTCOME_EVENT_NAME = 'discovery_governor_outcome' as const;
export const DISCOVERY_GOVERNOR_EVIDENCE_EVENT_NAME = 'discovery_governor_evidence' as const;

export type DiscoveryCategory = 'broad_discovery' | 'exact_schema_refresh';
export type DiscoveryAttemptOutcome = 'succeeded' | 'empty' | 'failed' | 'timed_out';

/**
 * What made the previous search stale. A budget is spent per EVIDENCE EPOCH,
 * never once per task: a task that learns something new has not yet searched
 * under what it now knows.
 *
 * Every kind here is an observed runtime fact, not a model assertion — the
 * model cannot talk its way into a fresh budget. That is what keeps discovery
 * bounded while still being recoverable.
 */
export type DiscoveryEvidenceKind =
  /** The candidate accepted the call but cannot do this (or silently dropped a
   *  required parameter). The capability class is still open; that ONE carrier
   *  is not it. */
  | 'candidate_unsupported'
  /** The candidate is gone or was never really there (unknown slug, removed
   *  tool, dead server). */
  | 'candidate_unavailable'
  /** The authorized catalog itself changed under the task (connect, disconnect,
   *  reconnect, toolkit revision). */
  | 'catalog_revision_changed'
  /** An expired connection came back. What was unreachable may now answer. */
  | 'auth_recovered'
  /**
   * A discovered capability did real work and the task moved past it.
   *
   * This is what makes "pull the rankings, then email them" possible: one task,
   * two systems, and the second requirement genuinely has not been searched
   * for. Progress is the evidence — and it is evidence the model cannot fake,
   * because it costs a successful external call to produce. Rephrasing a query
   * buys nothing; finishing a step buys the next search.
   */
  | 'capability_satisfied'
  /** The user supplied information the earlier search did not have. */
  | 'user_input_provided';

export interface DiscoveryTaskKey {
  sessionId: string;
  sourceUserSeq: number;
}

export interface DiscoveryTaskPolicy extends DiscoveryTaskKey {
  knownCapability: boolean;
  /** Evidence epoch this task is currently searching under. Starts at 0. */
  epoch: number;
  broadDiscoveryAllowance: 0 | 1;
  exactSchemaRefreshAllowance: 1;
  initializedAt: string;
  updatedAt: string;
}

export interface DiscoveryClaim extends DiscoveryTaskKey {
  category: DiscoveryCategory;
  epoch: number;
  /**
   * What the claim was about. Empty for a broad search (there is only one
   * "everything" per epoch). For an exact schema refresh this is the tool
   * identity, so fetching the callable schema of a DIFFERENT authorized tool is
   * never charged against the first one — repairing an invalid-argument call is
   * the whole point of that category.
   */
  subject: string;
  callId: string;
  outcome: DiscoveryAttemptOutcome | 'pending';
  outcomeDetail: string | null;
  admittedAt: string;
  settledAt: string | null;
}

export interface DiscoveryTaskState {
  policy: DiscoveryTaskPolicy;
  /** Claims in the task's CURRENT epoch, keyed by category for the common
   *  subject-less case. Exact-schema claims for specific subjects are in
   *  `epochClaims`. */
  claims: Partial<Record<DiscoveryCategory, DiscoveryClaim>>;
  /** Every claim in the current epoch, including per-subject schema refreshes. */
  epochClaims: DiscoveryClaim[];
  /** Every claim this task has ever made, across all epochs, oldest first. The
   *  audit view: what was tried, and what it cost. */
  allClaims: DiscoveryClaim[];
}

export type DiscoveryTaskInitializationStatus = 'initialized' | 'existing' | 'tightened';

export interface DiscoveryTaskInitialization {
  status: DiscoveryTaskInitializationStatus;
  policy: DiscoveryTaskPolicy;
}

export type DiscoveryAdmissionReason =
  | 'novel_discovery_admitted'
  | 'schema_refresh_admitted'
  | 'same_call_replay'
  /** A prior epoch was closed by new evidence; this epoch has its own budget. */
  | 'new_evidence_admitted'
  | 'task_not_initialized'
  | 'known_capability'
  | 'category_budget_exhausted';

export interface DiscoveryGovernorMetric {
  name: 'discovery_governor_decisions_total';
  value: 1;
  attributes: {
    category: DiscoveryCategory;
    decision: 'admitted' | 'denied';
    reason: DiscoveryAdmissionReason;
    replay: boolean;
    knownCapability: boolean | 'unknown';
    epoch: number;
  };
}

export interface DiscoveryGovernorEventData {
  sessionId: string;
  sourceUserSeq: number;
  category: DiscoveryCategory;
  epoch: number;
  subject: string;
  callId: string;
  decision: 'admitted' | 'denied';
  reason: DiscoveryAdmissionReason;
  replay: boolean;
  consumedBudget: boolean;
  knownCapability: boolean | null;
  allowance: 0 | 1;
  used: 0 | 1;
  priorOutcome?: DiscoveryAttemptOutcome | 'pending';
}

export interface DiscoveryGovernorTelemetry {
  eventName: typeof DISCOVERY_GOVERNOR_EVENT_NAME;
  eventData: DiscoveryGovernorEventData;
  metric: DiscoveryGovernorMetric;
}

interface DiscoveryDecisionBase {
  key: DiscoveryTaskKey;
  category: DiscoveryCategory;
  subject: string;
  epoch: number;
  callId: string;
  reason: DiscoveryAdmissionReason;
  replay: boolean;
  consumedBudget: boolean;
  policy: DiscoveryTaskPolicy | null;
  claim: DiscoveryClaim | null;
  telemetry: DiscoveryGovernorTelemetry;
}

export interface DiscoveryAdmittedDecision extends DiscoveryDecisionBase {
  admitted: true;
  reason:
    | 'novel_discovery_admitted'
    | 'schema_refresh_admitted'
    | 'same_call_replay';
}

export interface DiscoveryDeniedDecision extends DiscoveryDecisionBase {
  admitted: false;
  reason:
    | 'task_not_initialized'
    | 'known_capability'
    | 'category_budget_exhausted';
}

export type DiscoveryDecision = DiscoveryAdmittedDecision | DiscoveryDeniedDecision;

export interface InitializeDiscoveryTaskInput extends DiscoveryTaskKey {
  /**
   * True when capability resolution already identified the exact carrier/tool.
   * This is monotonic: once any lane proves the task known, a later lane cannot
   * loosen it back to novel.
   */
  knownCapability: boolean;
}

export interface AdmitDiscoveryInput extends DiscoveryTaskKey {
  category: DiscoveryCategory;
  /** Stable physical provider/tool invocation identity. */
  callId: string;
  /** Exact tool identity for a schema refresh; omitted for a broad search. */
  subject?: string;
}

export interface SettleDiscoveryInput extends AdmitDiscoveryInput {
  outcome: DiscoveryAttemptOutcome;
  /** Bounded classification only (for example `provider_timeout`), not raw output. */
  detail?: string;
}

export interface RecordDiscoveryEvidenceInput extends DiscoveryTaskKey {
  kind: DiscoveryEvidenceKind;
  /** Bounded classification (for example the candidate identity), not raw output. */
  detail?: string;
}

export type DiscoveryEvidenceOutcome =
  /** The epoch advanced; discovery has a fresh budget. */
  | 'epoch_opened'
  /** Nothing has been searched or attempted in this epoch yet, so the budget it
   *  already holds is the one to use. Advancing here would mint budget for a
   *  task that never spent any. */
  | 'epoch_already_fresh'
  /** The task has searched this many different ways and still has no candidate.
   *  More searching is no longer the answer; saying so to the user is. */
  | 'epoch_ceiling_reached'
  | 'task_not_initialized';

/**
 * How many times one accepted task may reopen discovery.
 *
 * Recovery has to terminate somewhere. Each epoch costs a real provider search,
 * and a task that has genuinely tried four different angles is not one search
 * away from success — it is a task that should come back and say what it could
 * not find. This is the line between "bounded per epoch" and "hunting
 * indefinitely".
 */
export const MAX_DISCOVERY_EPOCHS = 4;

export interface DiscoveryEvidenceRecord {
  outcome: DiscoveryEvidenceOutcome;
  kind: DiscoveryEvidenceKind;
  previousEpoch: number;
  epoch: number;
  telemetry: {
    eventName: typeof DISCOVERY_GOVERNOR_EVIDENCE_EVENT_NAME;
    eventData: {
      sessionId: string;
      sourceUserSeq: number;
      kind: DiscoveryEvidenceKind;
      outcome: DiscoveryEvidenceOutcome;
      previousEpoch: number;
      epoch: number;
      detail: string | null;
    };
    metric: {
      name: 'discovery_governor_evidence_total';
      value: 1;
      attributes: { kind: DiscoveryEvidenceKind; outcome: DiscoveryEvidenceOutcome };
    };
  };
}

export type DiscoverySettlementReason =
  | 'outcome_recorded'
  | 'same_outcome_replay'
  | 'outcome_already_recorded'
  | 'claim_not_found'
  | 'claim_call_mismatch';

export interface DiscoveryGovernorOutcomeMetric {
  name: 'discovery_governor_outcomes_total';
  value: 1;
  attributes: {
    category: DiscoveryCategory;
    outcome: DiscoveryAttemptOutcome;
    reason: DiscoverySettlementReason;
    replay: boolean;
  };
}

export interface DiscoverySettlementTelemetry {
  eventName: typeof DISCOVERY_GOVERNOR_OUTCOME_EVENT_NAME;
  eventData: {
    sessionId: string;
    sourceUserSeq: number;
    category: DiscoveryCategory;
    callId: string;
    outcome: DiscoveryAttemptOutcome;
    reason: DiscoverySettlementReason;
    replay: boolean;
    recorded: boolean;
  };
  metric: DiscoveryGovernorOutcomeMetric;
}

export interface DiscoverySettlement {
  recorded: boolean;
  replay: boolean;
  reason: DiscoverySettlementReason;
  claim: DiscoveryClaim | null;
  telemetry: DiscoverySettlementTelemetry;
}

interface RawTaskRow {
  session_id: string;
  source_user_seq: number;
  known_capability: number;
  current_epoch: number;
  initialized_at: string;
  updated_at: string;
}

interface RawClaimRow {
  session_id: string;
  source_user_seq: number;
  category: DiscoveryCategory;
  epoch: number;
  subject: string;
  call_id: string;
  outcome: DiscoveryAttemptOutcome | 'pending';
  outcome_detail: string | null;
  admitted_at: string;
  settled_at: string | null;
}

type DatabaseProvider = () => Database.Database;

const initializedDatabases = new WeakSet<Database.Database>();

function tableColumns(db: Database.Database, table: string): Set<string> {
  try {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return new Set(rows.map((row) => row.name));
  } catch {
    return new Set();
  }
}

/**
 * Widen the claim key from (task, category) to (task, epoch, category, subject).
 *
 * The old key made one search per task the permanent ceiling: a failed search
 * still held the only slot, and the schema of the SECOND tool a task needed was
 * charged against the first. Existing rows are the task's epoch 0, so a live
 * task that is mid-flight keeps exactly the budget state it already had.
 */
function migrateClaimKey(db: Database.Database): void {
  const columns = tableColumns(db, 'discovery_governor_claims');
  if (columns.size === 0 || (columns.has('epoch') && columns.has('subject'))) return;
  db.exec(`
    ALTER TABLE discovery_governor_claims RENAME TO discovery_governor_claims_pre_epoch;

    CREATE TABLE discovery_governor_claims (
      session_id       TEXT NOT NULL,
      source_user_seq  INTEGER NOT NULL,
      epoch            INTEGER NOT NULL DEFAULT 0 CHECK (epoch >= 0),
      category         TEXT NOT NULL
                       CHECK (category IN ('broad_discovery', 'exact_schema_refresh')),
      subject          TEXT NOT NULL DEFAULT '',
      call_id          TEXT NOT NULL,
      outcome          TEXT NOT NULL DEFAULT 'pending'
                       CHECK (outcome IN ('pending', 'succeeded', 'empty', 'failed', 'timed_out')),
      outcome_detail   TEXT,
      admitted_at      TEXT NOT NULL,
      settled_at       TEXT,
      PRIMARY KEY (session_id, source_user_seq, epoch, category, subject),
      FOREIGN KEY (session_id, source_user_seq)
        REFERENCES discovery_governor_tasks(session_id, source_user_seq)
        ON DELETE CASCADE
    );

    INSERT INTO discovery_governor_claims
      (session_id, source_user_seq, epoch, category, subject,
       call_id, outcome, outcome_detail, admitted_at, settled_at)
    SELECT session_id, source_user_seq, 0, category, '',
           call_id, outcome, outcome_detail, admitted_at, settled_at
      FROM discovery_governor_claims_pre_epoch;

    DROP TABLE discovery_governor_claims_pre_epoch;
  `);
}

function ensureSchema(db: Database.Database): void {
  if (initializedDatabases.has(db)) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS discovery_governor_tasks (
      session_id        TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      source_user_seq   INTEGER NOT NULL CHECK (source_user_seq > 0),
      known_capability  INTEGER NOT NULL CHECK (known_capability IN (0, 1)),
      current_epoch     INTEGER NOT NULL DEFAULT 0 CHECK (current_epoch >= 0),
      initialized_at    TEXT NOT NULL,
      updated_at        TEXT NOT NULL,
      PRIMARY KEY (session_id, source_user_seq)
    );

    CREATE TABLE IF NOT EXISTS discovery_governor_claims (
      session_id       TEXT NOT NULL,
      source_user_seq  INTEGER NOT NULL,
      epoch            INTEGER NOT NULL DEFAULT 0 CHECK (epoch >= 0),
      category         TEXT NOT NULL
                       CHECK (category IN ('broad_discovery', 'exact_schema_refresh')),
      subject          TEXT NOT NULL DEFAULT '',
      call_id          TEXT NOT NULL,
      outcome          TEXT NOT NULL DEFAULT 'pending'
                       CHECK (outcome IN ('pending', 'succeeded', 'empty', 'failed', 'timed_out')),
      outcome_detail   TEXT,
      admitted_at      TEXT NOT NULL,
      settled_at       TEXT,
      PRIMARY KEY (session_id, source_user_seq, epoch, category, subject),
      FOREIGN KEY (session_id, source_user_seq)
        REFERENCES discovery_governor_tasks(session_id, source_user_seq)
        ON DELETE CASCADE
    );
  `);
  if (!tableColumns(db, 'discovery_governor_tasks').has('current_epoch')) {
    db.exec(`
      ALTER TABLE discovery_governor_tasks
        ADD COLUMN current_epoch INTEGER NOT NULL DEFAULT 0
    `);
  }
  migrateClaimKey(db);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_discovery_governor_claims_call
      ON discovery_governor_claims(session_id, source_user_seq, call_id);
    CREATE INDEX IF NOT EXISTS idx_discovery_governor_claims_epoch
      ON discovery_governor_claims(session_id, source_user_seq, epoch);
  `);
  initializedDatabases.add(db);
}

function taskKey(input: DiscoveryTaskKey): DiscoveryTaskKey {
  const sessionId = input.sessionId.trim();
  if (!sessionId) throw new Error('DiscoveryGovernor requires a sessionId.');
  if (!Number.isSafeInteger(input.sourceUserSeq) || input.sourceUserSeq <= 0) {
    throw new Error('DiscoveryGovernor requires a positive accepted sourceUserSeq.');
  }
  return { sessionId, sourceUserSeq: input.sourceUserSeq };
}

function normalizedCallId(callId: string): string {
  const value = callId.trim();
  if (!value) throw new Error('DiscoveryGovernor requires a stable callId.');
  if (value.length > 512) throw new Error('DiscoveryGovernor callId exceeds 512 characters.');
  return value;
}

function normalizedDetail(detail: string | undefined): string | null {
  const value = detail?.replace(/\s+/g, ' ').trim();
  return value ? value.slice(0, 256) : null;
}

function rowToPolicy(row: RawTaskRow): DiscoveryTaskPolicy {
  const knownCapability = row.known_capability === 1;
  const epoch = row.current_epoch ?? 0;
  return {
    sessionId: row.session_id,
    sourceUserSeq: row.source_user_seq,
    knownCapability,
    epoch,
    // A remembered capability means "try this before searching", and it says so
    // only for the epoch the memory was formed against. Once observed evidence
    // opens a new epoch, a warm user searches on exactly the same terms as a
    // cold one — a receipt orders candidates, it never withholds recovery.
    broadDiscoveryAllowance: knownCapability && epoch === 0 ? 0 : 1,
    exactSchemaRefreshAllowance: 1,
    initializedAt: row.initialized_at,
    updatedAt: row.updated_at,
  };
}

function rowToClaim(row: RawClaimRow): DiscoveryClaim {
  return {
    sessionId: row.session_id,
    sourceUserSeq: row.source_user_seq,
    category: row.category,
    epoch: row.epoch ?? 0,
    subject: row.subject ?? '',
    callId: row.call_id,
    outcome: row.outcome,
    outcomeDetail: row.outcome_detail,
    admittedAt: row.admitted_at,
    settledAt: row.settled_at,
  };
}

/**
 * What a claim is about.
 *
 * An exact schema refresh is charged per TOOL, so fetching the callable shape
 * of the second tool a task needs is never charged against the first — that
 * was the mechanism behind the invalid-argument guessing spiral.
 *
 * A broad search is deliberately NOT charged per phrase. Query text is a poor
 * identity: "outlook unread mail" and "gmail unread mail" are one requirement
 * being shopped across providers, and any wording-based key would sell a fresh
 * budget for a synonym. A task earns another search by making PROGRESS, not by
 * asking differently — see `capability_satisfied`.
 */
function normalizedSubject(category: DiscoveryCategory, subject: string | undefined): string {
  if (category === 'broad_discovery') return '';
  const value = (subject ?? '').trim().toLowerCase();
  return value ? value.slice(0, 256) : '';
}

function allowance(policy: DiscoveryTaskPolicy | null, category: DiscoveryCategory): 0 | 1 {
  if (!policy) return 0;
  return category === 'broad_discovery'
    ? policy.broadDiscoveryAllowance
    : policy.exactSchemaRefreshAllowance;
}

function decisionTelemetry(input: {
  key: DiscoveryTaskKey;
  category: DiscoveryCategory;
  subject: string;
  callId: string;
  admitted: boolean;
  reason: DiscoveryAdmissionReason;
  replay: boolean;
  consumedBudget: boolean;
  policy: DiscoveryTaskPolicy | null;
  claim: DiscoveryClaim | null;
}): DiscoveryGovernorTelemetry {
  const available = allowance(input.policy, input.category);
  const used = input.claim ? 1 : 0;
  const decision = input.admitted ? 'admitted' : 'denied';
  const epoch = input.policy?.epoch ?? 0;
  return {
    eventName: DISCOVERY_GOVERNOR_EVENT_NAME,
    eventData: {
      ...input.key,
      category: input.category,
      epoch,
      subject: input.subject,
      callId: input.callId,
      decision,
      reason: input.reason,
      replay: input.replay,
      consumedBudget: input.consumedBudget,
      knownCapability: input.policy?.knownCapability ?? null,
      allowance: available,
      used,
      ...(input.claim ? { priorOutcome: input.claim.outcome } : {}),
    },
    metric: {
      name: 'discovery_governor_decisions_total',
      value: 1,
      attributes: {
        category: input.category,
        decision,
        reason: input.reason,
        replay: input.replay,
        knownCapability: input.policy?.knownCapability ?? 'unknown',
        epoch,
      },
    },
  };
}

function buildDecision(input: {
  key: DiscoveryTaskKey;
  category: DiscoveryCategory;
  subject: string;
  callId: string;
  admitted: boolean;
  reason: DiscoveryAdmissionReason;
  replay: boolean;
  consumedBudget: boolean;
  policy: DiscoveryTaskPolicy | null;
  claim: DiscoveryClaim | null;
}): DiscoveryDecision {
  const common = {
    key: input.key,
    category: input.category,
    subject: input.subject,
    epoch: input.policy?.epoch ?? 0,
    callId: input.callId,
    replay: input.replay,
    consumedBudget: input.consumedBudget,
    policy: input.policy,
    claim: input.claim,
    telemetry: decisionTelemetry(input),
  };
  if (input.admitted) {
    return {
      ...common,
      admitted: true,
      reason: input.reason as DiscoveryAdmittedDecision['reason'],
    };
  }
  return {
    ...common,
    admitted: false,
    reason: input.reason as DiscoveryDeniedDecision['reason'],
  };
}

function evidenceRecord(input: {
  key: DiscoveryTaskKey;
  kind: DiscoveryEvidenceKind;
  detail: string | null;
  outcome: DiscoveryEvidenceOutcome;
  previousEpoch: number;
  epoch: number;
}): DiscoveryEvidenceRecord {
  return {
    outcome: input.outcome,
    kind: input.kind,
    previousEpoch: input.previousEpoch,
    epoch: input.epoch,
    telemetry: {
      eventName: DISCOVERY_GOVERNOR_EVIDENCE_EVENT_NAME,
      eventData: {
        ...input.key,
        kind: input.kind,
        outcome: input.outcome,
        previousEpoch: input.previousEpoch,
        epoch: input.epoch,
        detail: input.detail,
      },
      metric: {
        name: 'discovery_governor_evidence_total',
        value: 1,
        attributes: { kind: input.kind, outcome: input.outcome },
      },
    },
  };
}

function settlementTelemetry(input: {
  key: DiscoveryTaskKey;
  category: DiscoveryCategory;
  callId: string;
  outcome: DiscoveryAttemptOutcome;
  reason: DiscoverySettlementReason;
  replay: boolean;
  recorded: boolean;
}): DiscoverySettlementTelemetry {
  return {
    eventName: DISCOVERY_GOVERNOR_OUTCOME_EVENT_NAME,
    eventData: {
      ...input.key,
      category: input.category,
      callId: input.callId,
      outcome: input.outcome,
      reason: input.reason,
      replay: input.replay,
      recorded: input.recorded,
    },
    metric: {
      name: 'discovery_governor_outcomes_total',
      value: 1,
      attributes: {
        category: input.category,
        outcome: input.outcome,
        reason: input.reason,
        replay: input.replay,
      },
    },
  };
}

/**
 * Record observed recovery evidence on a caller-owned transaction.
 *
 * Logical-call settlement uses this form so its normalized verdict and the
 * discovery epoch it earns cannot be split by a crash. Standalone catalog and
 * user-input evidence continues through DiscoveryGovernor.recordEvidence().
 */
export function recordDiscoveryEvidenceInTransaction(
  db: Database.Database,
  input: RecordDiscoveryEvidenceInput,
  at = new Date().toISOString(),
): DiscoveryEvidenceRecord {
  const key = taskKey(input);
  const detail = normalizedDetail(input.detail);
  ensureSchema(db);
  const rawPolicy = db.prepare(`
    SELECT * FROM discovery_governor_tasks
     WHERE session_id = ? AND source_user_seq = ?
  `).get(key.sessionId, key.sourceUserSeq) as RawTaskRow | undefined;
  if (!rawPolicy) {
    return evidenceRecord({
      key, kind: input.kind, detail,
      outcome: 'task_not_initialized', previousEpoch: 0, epoch: 0,
    });
  }
  const policy = rowToPolicy(rawPolicy);
  const previousEpoch = policy.epoch;
  const spent = db.prepare(`
    SELECT COUNT(*) AS count FROM discovery_governor_claims
     WHERE session_id = ? AND source_user_seq = ? AND epoch = ?
  `).get(key.sessionId, key.sourceUserSeq, previousEpoch) as { count: number };
  const hasUnusedBudget = spent.count === 0 && policy.broadDiscoveryAllowance > 0;
  if (hasUnusedBudget) {
    return evidenceRecord({
      key, kind: input.kind, detail,
      outcome: 'epoch_already_fresh', previousEpoch, epoch: previousEpoch,
    });
  }
  if (previousEpoch + 1 >= MAX_DISCOVERY_EPOCHS) {
    return evidenceRecord({
      key, kind: input.kind, detail,
      outcome: 'epoch_ceiling_reached', previousEpoch, epoch: previousEpoch,
    });
  }
  const epoch = previousEpoch + 1;
  db.prepare(`
    UPDATE discovery_governor_tasks
       SET current_epoch = ?, updated_at = ?
     WHERE session_id = ? AND source_user_seq = ?
  `).run(epoch, at, key.sessionId, key.sourceUserSeq);
  return evidenceRecord({
    key, kind: input.kind, detail,
    outcome: 'epoch_opened', previousEpoch, epoch,
  });
}

/**
 * SQLite-backed governor. The default provider reuses the harness event-log
 * connection; tests and future MCP children may inject another connection to
 * the same database file.
 */
export class DiscoveryGovernor {
  constructor(private readonly databaseProvider: DatabaseProvider = openEventLog) {}

  initializeTask(input: InitializeDiscoveryTaskInput): DiscoveryTaskInitialization {
    const key = taskKey(input);
    const db = this.databaseProvider();
    ensureSchema(db);
    const initialize = db.transaction((): DiscoveryTaskInitialization => {
      const source = db.prepare(`
        SELECT 1 AS present
          FROM events
         WHERE session_id = ?
           AND seq = ?
           AND type = 'user_input_received'
         LIMIT 1
      `).get(key.sessionId, key.sourceUserSeq) as { present: number } | undefined;
      if (!source) {
        throw new Error(
          `DiscoveryGovernor source ${key.sourceUserSeq} is not an accepted user task for ${key.sessionId}.`,
        );
      }

      const prior = db.prepare(`
        SELECT * FROM discovery_governor_tasks
         WHERE session_id = ? AND source_user_seq = ?
      `).get(key.sessionId, key.sourceUserSeq) as RawTaskRow | undefined;
      const now = new Date().toISOString();
      if (!prior) {
        db.prepare(`
          INSERT INTO discovery_governor_tasks
            (session_id, source_user_seq, known_capability, initialized_at, updated_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(key.sessionId, key.sourceUserSeq, input.knownCapability ? 1 : 0, now, now);
      } else if (input.knownCapability && prior.known_capability === 0) {
        // Knowledge only tightens policy. A fallover can never reopen broad
        // discovery after another brain proved the exact capability.
        db.prepare(`
          UPDATE discovery_governor_tasks
             SET known_capability = 1, updated_at = ?
           WHERE session_id = ? AND source_user_seq = ?
        `).run(now, key.sessionId, key.sourceUserSeq);
      }

      const row = db.prepare(`
        SELECT * FROM discovery_governor_tasks
         WHERE session_id = ? AND source_user_seq = ?
      `).get(key.sessionId, key.sourceUserSeq) as RawTaskRow;
      return {
        status: !prior
          ? 'initialized'
          : input.knownCapability && prior.known_capability === 0
            ? 'tightened'
            : 'existing',
        policy: rowToPolicy(row),
      };
    });
    return initialize.immediate();
  }

  admit(input: AdmitDiscoveryInput): DiscoveryDecision {
    const key = taskKey(input);
    const callId = normalizedCallId(input.callId);
    const subject = normalizedSubject(input.category, input.subject);
    const db = this.databaseProvider();
    ensureSchema(db);
    const decide = db.transaction((): DiscoveryDecision => {
      const rawPolicy = db.prepare(`
        SELECT * FROM discovery_governor_tasks
         WHERE session_id = ? AND source_user_seq = ?
      `).get(key.sessionId, key.sourceUserSeq) as RawTaskRow | undefined;
      const policy = rawPolicy ? rowToPolicy(rawPolicy) : null;
      if (!policy) {
        return buildDecision({
          key,
          category: input.category,
          subject,
          callId,
          admitted: false,
          reason: 'task_not_initialized',
          replay: false,
          consumedBudget: false,
          policy: null,
          claim: null,
        });
      }

      const rawExisting = db.prepare(`
        SELECT * FROM discovery_governor_claims
         WHERE session_id = ? AND source_user_seq = ?
           AND epoch = ? AND category = ? AND subject = ?
      `).get(
        key.sessionId, key.sourceUserSeq, policy.epoch, input.category, subject,
      ) as RawClaimRow | undefined;
      const existing = rawExisting ? rowToClaim(rawExisting) : null;
      if (existing) {
        const replay = existing.callId === callId;
        return buildDecision({
          key,
          category: input.category,
          subject,
          callId,
          admitted: replay,
          reason: replay ? 'same_call_replay' : 'category_budget_exhausted',
          replay,
          consumedBudget: false,
          policy,
          claim: existing,
        });
      }

      // A remembered candidate is a starting point, not a verdict. It suppresses
      // the FIRST broad search only — the one that would run before the known
      // path was even tried. Any epoch opened by observed evidence searches
      // freely, so a stale receipt costs one attempt, never the task.
      if (input.category === 'broad_discovery' && policy.broadDiscoveryAllowance === 0) {
        return buildDecision({
          key,
          category: input.category,
          subject,
          callId,
          admitted: false,
          reason: 'known_capability',
          replay: false,
          consumedBudget: false,
          policy,
          claim: null,
        });
      }

      const admittedAt = new Date().toISOString();
      const inserted = db.prepare(`
        INSERT OR IGNORE INTO discovery_governor_claims
          (session_id, source_user_seq, epoch, category, subject, call_id, outcome, admitted_at)
        VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)
      `).run(
        key.sessionId, key.sourceUserSeq, policy.epoch,
        input.category, subject, callId, admittedAt,
      );
      const rawClaim = db.prepare(`
        SELECT * FROM discovery_governor_claims
         WHERE session_id = ? AND source_user_seq = ?
           AND epoch = ? AND category = ? AND subject = ?
      `).get(
        key.sessionId, key.sourceUserSeq, policy.epoch, input.category, subject,
      ) as RawClaimRow;
      const claim = rowToClaim(rawClaim);
      if (inserted.changes !== 1) {
        const replay = claim.callId === callId;
        return buildDecision({
          key,
          category: input.category,
          subject,
          callId,
          admitted: replay,
          reason: replay ? 'same_call_replay' : 'category_budget_exhausted',
          replay,
          consumedBudget: false,
          policy,
          claim,
        });
      }
      return buildDecision({
        key,
        category: input.category,
        subject,
        callId,
        admitted: true,
        reason: policy.epoch > 0
          ? 'new_evidence_admitted'
          : input.category === 'broad_discovery'
            ? 'novel_discovery_admitted'
            : 'schema_refresh_admitted',
        replay: false,
        consumedBudget: true,
        policy,
        claim,
      });
    });
    return decide.immediate();
  }

  /**
   * Close the current epoch when the runtime OBSERVES that what the task knew
   * has changed. This is the only way discovery gets another budget, and the
   * model cannot reach it — only settled attempt outcomes, catalog changes and
   * real user input do.
   *
   * An epoch with nothing spent in it is already the fresh one, so repeated
   * evidence cannot stack budgets.
   */
  recordEvidence(input: RecordDiscoveryEvidenceInput): DiscoveryEvidenceRecord {
    const db = this.databaseProvider();
    ensureSchema(db);
    const record = db.transaction((): DiscoveryEvidenceRecord =>
      recordDiscoveryEvidenceInTransaction(db, input));
    return record.immediate();
  }

  settle(input: SettleDiscoveryInput): DiscoverySettlement {
    const key = taskKey(input);
    const callId = normalizedCallId(input.callId);
    const subject = normalizedSubject(input.category, input.subject);
    const detail = normalizedDetail(input.detail);
    const db = this.databaseProvider();
    ensureSchema(db);
    const settle = db.transaction((): DiscoverySettlement => {
      // Settle the claim this callId actually holds, wherever it sits. An epoch
      // may have advanced between dispatch and return; the in-flight attempt
      // still owns its own slot and must record its outcome there.
      const find = (): RawClaimRow | undefined => (db.prepare(`
        SELECT * FROM discovery_governor_claims
         WHERE session_id = ? AND source_user_seq = ?
           AND category = ? AND subject = ? AND call_id = ?
         ORDER BY epoch DESC LIMIT 1
      `).get(key.sessionId, key.sourceUserSeq, input.category, subject, callId) as RawClaimRow | undefined)
        ?? (db.prepare(`
        SELECT * FROM discovery_governor_claims
         WHERE session_id = ? AND source_user_seq = ?
           AND category = ? AND subject = ?
         ORDER BY epoch DESC LIMIT 1
      `).get(key.sessionId, key.sourceUserSeq, input.category, subject) as RawClaimRow | undefined);
      const prior = find();
      if (!prior) {
        const reason = 'claim_not_found' as const;
        return {
          recorded: false,
          replay: false,
          reason,
          claim: null,
          telemetry: settlementTelemetry({
            key, category: input.category, callId, outcome: input.outcome,
            reason, replay: false, recorded: false,
          }),
        };
      }
      if (prior.call_id !== callId) {
        const reason = 'claim_call_mismatch' as const;
        return {
          recorded: false,
          replay: false,
          reason,
          claim: rowToClaim(prior),
          telemetry: settlementTelemetry({
            key, category: input.category, callId, outcome: input.outcome,
            reason, replay: false, recorded: false,
          }),
        };
      }
      if (prior.outcome !== 'pending') {
        const replay = prior.outcome === input.outcome;
        const reason = replay ? 'same_outcome_replay' : 'outcome_already_recorded';
        return {
          recorded: false,
          replay,
          reason,
          claim: rowToClaim(prior),
          telemetry: settlementTelemetry({
            key, category: input.category, callId, outcome: input.outcome,
            reason, replay, recorded: false,
          }),
        };
      }

      const settledAt = new Date().toISOString();
      const update = db.prepare(`
        UPDATE discovery_governor_claims
           SET outcome = ?, outcome_detail = ?, settled_at = ?
         WHERE session_id = ?
           AND source_user_seq = ?
           AND epoch = ?
           AND category = ?
           AND subject = ?
           AND call_id = ?
           AND outcome = 'pending'
      `).run(
        input.outcome,
        detail,
        settledAt,
        key.sessionId,
        key.sourceUserSeq,
        prior.epoch ?? 0,
        input.category,
        subject,
        callId,
      );
      const claim = rowToClaim(find() as RawClaimRow);
      const recorded = update.changes === 1;
      const replay = !recorded && claim.outcome === input.outcome;
      const reason: DiscoverySettlementReason = recorded
        ? 'outcome_recorded'
        : replay
          ? 'same_outcome_replay'
          : 'outcome_already_recorded';
      return {
        recorded,
        replay,
        reason,
        claim,
        telemetry: settlementTelemetry({
          key, category: input.category, callId, outcome: input.outcome,
          reason, replay, recorded,
        }),
      };
    });
    return settle.immediate();
  }

  getTaskState(input: DiscoveryTaskKey): DiscoveryTaskState | null {
    const key = taskKey(input);
    const db = this.databaseProvider();
    ensureSchema(db);
    const rawPolicy = db.prepare(`
      SELECT * FROM discovery_governor_tasks
       WHERE session_id = ? AND source_user_seq = ?
    `).get(key.sessionId, key.sourceUserSeq) as RawTaskRow | undefined;
    if (!rawPolicy) return null;
    const policy = rowToPolicy(rawPolicy);
    const allClaims = (db.prepare(`
      SELECT * FROM discovery_governor_claims
       WHERE session_id = ? AND source_user_seq = ?
       ORDER BY epoch, category, subject
    `).all(key.sessionId, key.sourceUserSeq) as RawClaimRow[]).map(rowToClaim);
    const epochClaims = allClaims.filter((claim) => claim.epoch === policy.epoch);
    const claims: Partial<Record<DiscoveryCategory, DiscoveryClaim>> = {};
    // The category view keeps the subject-less claim — the one a caller asking
    // "was a broad search already spent this epoch?" means.
    for (const claim of epochClaims) {
      if (claim.subject === '' || !claims[claim.category]) claims[claim.category] = claim;
    }
    return { policy, claims, epochClaims, allClaims };
  }
}

export const discoveryGovernor = new DiscoveryGovernor();
