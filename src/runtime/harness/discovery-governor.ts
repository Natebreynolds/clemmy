import type Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
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
  /** True only after the exact accepted request's requirement projection was
   * durably registered. Legacy/workflow callers without that projection retain
   * the task-wide compatibility budget. */
  roleScoped: boolean;
  roleCount: number;
  unresolvedRoleCount: number;
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
   * What the claim was about. For a role-scoped broad search this is the exact
   * unresolved requirement role; legacy tasks retain empty. For an exact schema
   * refresh this is the tool identity, so fetching the callable schema of a
   * DIFFERENT authorized tool is never charged against the first one — repairing
   * an invalid-argument call is the whole point of that category.
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
  roles: DiscoveryRequirementRole[];
  /** Compatibility category view for the task's CURRENT epoch. Per-role broad
   * claims and per-tool exact-schema claims are all preserved in `epochClaims`. */
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
  /** A different physical call cannot borrow a subject's already-spent claim.
   *  Only host-observed evidence may open a new epoch and authorize a retry. */
  | 'new_call_requires_retry_epoch'
  /** The subject's claim SETTLED SUCCESSFUL and a new physical call arrived:
   *  a follow-up/pagination/refinement of the already-admitted intent. It is a
   *  continuation read, not a new physical discovery — denying it starved the
   *  exact disclosure plan admission demands (2026-08-26 gauntlet: 147
   *  denials, 1 epoch reopen, 0 external effects). The turn-wide admission
   *  ceiling remains the runaway bound. */
  | 'settled_continuation_admitted'
  /** The caller named no role, an unknown one, or an already-resolved one. The
   *  search is admitted against a HOST-OWNED subject and the caller is told. */
  | 'role_coerced'
  /** A prior epoch was closed by new evidence; this epoch has its own budget. */
  | 'new_evidence_admitted'
  | 'task_not_initialized'
  | 'role_required'
  | 'role_not_unresolved'
  | 'role_resolved'
  /** Runaway backstop: this task has issued an implausible number of
   *  discoveries. Turn-scoped, high, always on, and stops the turn cleanly. */
  | 'turn_discovery_ceiling';

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
  /** Host-owned correction to hand back WITH an admitted result, never instead
   *  of one. A caller that named a role the task does not have still gets its
   *  search; it also gets told what the host actually knows. */
  advisory?: string;
}

export interface DiscoveryAdmittedDecision extends DiscoveryDecisionBase {
  admitted: true;
  reason:
    | 'novel_discovery_admitted'
    | 'schema_refresh_admitted'
    | 'new_evidence_admitted'
    | 'settled_continuation_admitted'
    | 'role_coerced';
}

export interface DiscoveryDeniedDecision extends DiscoveryDecisionBase {
  admitted: false;
  reason:
    | 'task_not_initialized'
    | 'role_required'
    | 'role_not_unresolved'
    | 'role_resolved'
    | 'same_call_replay'
    | 'new_call_requires_retry_epoch'
    | 'turn_discovery_ceiling';
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

export interface DiscoveryRequirementRoleInput {
  /** Opaque runtime-owned requirement identity. Provider/query words are never
   * accepted as substitutes: admission performs an exact membership lookup. */
  roleKey: string;
  /** Exact fields emitted by `TurnCapabilityCandidates.requirements`. */
  clauseIndex: number;
  text: string;
  resolved: boolean;
}

/** The governor may suppress alternate broad doors only when the visible
 * broker proves it can return exact authorized external candidates itself. */
export type DiscoveryBrokerCoverage = 'builtins_only' | 'authorized_external_v1';

export interface DiscoveryRequirementRole extends DiscoveryTaskKey {
  roleKey: string;
  requirementIndex: number;
  requirementDigest: string;
  resolved: boolean;
  registeredAt: string;
  resolvedAt: string | null;
}

export type DiscoveryRoleInitializationStatus = 'initialized' | 'existing' | 'tightened';

export interface InitializeDiscoveryRolesInput extends DiscoveryTaskKey {
  /** The complete source-ordered projection for this accepted request. */
  requirements: readonly DiscoveryRequirementRoleInput[];
  /** Host-issued capability fact. Absence and `builtins_only` both retain
   * legacy task-wide discovery so unresolved external work stays reachable. */
  brokerCoverage?: DiscoveryBrokerCoverage;
}

export interface DiscoveryRoleInitialization {
  status: DiscoveryRoleInitializationStatus;
  policy: DiscoveryTaskPolicy;
  roles: DiscoveryRequirementRole[];
}

export interface AdmitDiscoveryInput extends DiscoveryTaskKey {
  category: DiscoveryCategory;
  /** Stable physical provider/tool invocation identity. */
  callId: string;
  /** Exact tool identity for schema refresh, or frozen unresolved role for a
   * broad search. Omitted only by legacy task-wide broad discovery. */
  subject?: string;
  /** Opaque host-owned admission class for the fresh foreground loop's one
   * metadata-only catalog disclosure before a graph exists. Model arguments
   * cannot set this; the exact configured tool object must carry the marker. */
  authorityClass?: 'fresh_plan_catalog_disclosure';
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

/** A complex accepted request may expose many clauses, but foreground broad
 * discovery remains a small control surface. Each admitted claim is still
 * keyed by one exact frozen role; this ceiling prevents an oversized role
 * projection from turning into an unbounded provider-search fan-out. */
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

interface RawRoleSetRow {
  session_id: string;
  source_user_seq: number;
  projection_digest: string;
  role_count: number;
  unresolved_count: number;
  initialized_at: string;
  updated_at: string;
}

interface RawRoleRow {
  session_id: string;
  source_user_seq: number;
  role_key: string;
  requirement_index: number;
  requirement_digest: string;
  resolved: number;
  registered_at: string;
  resolved_at: string | null;
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

function digestText(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizedRoleKey(value: string): string {
  const roleKey = value.trim();
  if (!roleKey) throw new Error('DiscoveryGovernor requires a non-empty requirement role key.');
  if (roleKey.length > 128) throw new Error('DiscoveryGovernor requirement role key exceeds 128 characters.');
  return roleKey;
}

interface NormalizedRequirementRole {
  roleKey: string;
  requirementIndex: number;
  requirementDigest: string;
  resolved: boolean;
}

function normalizedRequirementRoles(
  requirements: readonly DiscoveryRequirementRoleInput[],
): { roles: NormalizedRequirementRole[]; projectionDigest: string } {
  const roles = requirements.map((requirement) => {
    if (!Number.isSafeInteger(requirement.clauseIndex) || requirement.clauseIndex < 0) {
      throw new Error('DiscoveryGovernor requires a non-negative requirement index.');
    }
    const requirementText = requirement.text.replace(/\s+/g, ' ').trim();
    if (!requirementText) throw new Error('DiscoveryGovernor requires requirement text for role authority.');
    return {
      roleKey: normalizedRoleKey(requirement.roleKey),
      requirementIndex: requirement.clauseIndex,
      requirementDigest: digestText(requirementText),
      resolved: requirement.resolved === true,
    };
  }).sort((a, b) => a.requirementIndex - b.requirementIndex || a.roleKey.localeCompare(b.roleKey));
  if (new Set(roles.map((role) => role.roleKey)).size !== roles.length) {
    throw new Error('DiscoveryGovernor requirement role keys must be unique within one accepted request.');
  }
  if (new Set(roles.map((role) => role.requirementIndex)).size !== roles.length) {
    throw new Error('DiscoveryGovernor requirement indexes must be unique within one accepted request.');
  }
  // Resolution is deliberately excluded. A later brain may tighten one exact
  // role from unresolved to resolved, but can never alter membership/identity.
  const projectionDigest = digestText(JSON.stringify(roles.map((role) => ({
    roleKey: role.roleKey,
    requirementIndex: role.requirementIndex,
    requirementDigest: role.requirementDigest,
  }))));
  return { roles, projectionDigest };
}

function rawRoleSet(
  db: Database.Database,
  key: DiscoveryTaskKey,
): RawRoleSetRow | null {
  try {
    return (db.prepare(`
      SELECT * FROM discovery_governor_role_sets
       WHERE session_id = ? AND source_user_seq = ?
    `).get(key.sessionId, key.sourceUserSeq) as RawRoleSetRow | undefined) ?? null;
  } catch (error) {
    // Sparse pre-migration rehearsal databases retain the legacy task-wide
    // policy. Production openEventLog applies the numbered migration first.
    if (error instanceof Error && /no such table:\s*discovery_governor_role_sets/i.test(error.message)) {
      return null;
    }
    throw error;
  }
}

function rawRoles(
  db: Database.Database,
  key: DiscoveryTaskKey,
): RawRoleRow[] {
  try {
    return db.prepare(`
      SELECT * FROM discovery_governor_roles
       WHERE session_id = ? AND source_user_seq = ?
       ORDER BY requirement_index, role_key
    `).all(key.sessionId, key.sourceUserSeq) as RawRoleRow[];
  } catch (error) {
    if (error instanceof Error && /no such table:\s*discovery_governor_roles/i.test(error.message)) {
      return [];
    }
    throw error;
  }
}

function rowToRole(row: RawRoleRow): DiscoveryRequirementRole {
  return {
    sessionId: row.session_id,
    sourceUserSeq: row.source_user_seq,
    roleKey: row.role_key,
    requirementIndex: row.requirement_index,
    requirementDigest: row.requirement_digest,
    resolved: row.resolved === 1,
    registeredAt: row.registered_at,
    resolvedAt: row.resolved_at,
  };
}

function rowToPolicy(row: RawTaskRow, roleSet: RawRoleSetRow | null = null): DiscoveryTaskPolicy {
  const knownCapability = row.known_capability === 1;
  const epoch = row.current_epoch ?? 0;
  const roleScoped = roleSet !== null;
  const unresolvedRoleCount = roleSet?.unresolved_count ?? 0;
  return {
    sessionId: row.session_id,
    sourceUserSeq: row.source_user_seq,
    knownCapability,
    roleScoped,
    roleCount: roleSet?.role_count ?? 0,
    unresolvedRoleCount,
    epoch,
    // `knownCapability` is task-level and therefore cannot prove COMPLETE
    // coverage of a multi-capability request. It ranks remembered candidates in
    // the prompt, but it never removes the task's one bounded search slot. Live
    // 2026-08-12: a proven Google Sheets path otherwise withheld the first
    // Apify search needed by the same accepted task.
    broadDiscoveryAllowance: roleScoped
      ? (unresolvedRoleCount > 0 ? 1 : 0)
      : 1,
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
 * A broad search is charged per opaque REQUIREMENT ROLE when the accepted task
 * registered a role projection. Query text is still never identity: synonymous
 * queries and different providers for the same role carry one exact role key
 * and therefore collide on one claim. Legacy callers without a registered role
 * projection retain the empty task-wide subject.
 */
function normalizedSubject(category: DiscoveryCategory, subject: string | undefined): string {
  if (category === 'broad_discovery') {
    const value = (subject ?? '').trim();
    return value ? value.slice(0, 128) : '';
  }
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
  advisory?: string;
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
    ...(input.advisory ? { advisory: input.advisory } : {}),
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
  const policy = rowToPolicy(rawPolicy, rawRoleSet(db, key));
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
        policy: rowToPolicy(row, rawRoleSet(db, key)),
      };
    });
    return initialize.immediate();
  }

  /**
   * Freeze the exact accepted request's requirement membership before model
   * discovery. This API is invoked only from the runtime's resolver seam; tool
   * inputs can reference a role but can never register one.
   */
  initializeRoles(input: InitializeDiscoveryRolesInput): DiscoveryRoleInitialization {
    const key = taskKey(input);
    // Absence is not an all-resolved projection. If candidate resolution was
    // unavailable or a mixed-version caller omitted requirements, retain the
    // legacy path instead of freezing an empty set that strands novel work.
    if (input.brokerCoverage !== 'authorized_external_v1' || input.requirements.length === 0) {
      const db = this.databaseProvider();
      ensureSchema(db);
      const task = db.prepare(`
        SELECT * FROM discovery_governor_tasks
         WHERE session_id = ? AND source_user_seq = ?
      `).get(key.sessionId, key.sourceUserSeq) as RawTaskRow | undefined;
      if (!task) {
        throw new Error('DiscoveryGovernor must initialize the accepted task before its requirement roles.');
      }
      return {
        status: 'existing',
        policy: rowToPolicy(task, rawRoleSet(db, key)),
        roles: rawRoles(db, key).map(rowToRole),
      };
    }
    const projection = normalizedRequirementRoles(input.requirements);
    const db = this.databaseProvider();
    ensureSchema(db);
    const initialize = db.transaction((): DiscoveryRoleInitialization => {
      const task = db.prepare(`
        SELECT * FROM discovery_governor_tasks
         WHERE session_id = ? AND source_user_seq = ?
      `).get(key.sessionId, key.sourceUserSeq) as RawTaskRow | undefined;
      if (!task) {
        throw new Error('DiscoveryGovernor must initialize the accepted task before its requirement roles.');
      }
      const prior = rawRoleSet(db, key);
      const now = new Date().toISOString();
      if (!prior) {
        db.prepare(`
          INSERT INTO discovery_governor_role_sets
            (session_id, source_user_seq, projection_digest, role_count,
             unresolved_count, initialized_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          key.sessionId,
          key.sourceUserSeq,
          projection.projectionDigest,
          projection.roles.length,
          projection.roles.filter((role) => !role.resolved).length,
          now,
          now,
        );
        const insert = db.prepare(`
          INSERT INTO discovery_governor_roles
            (session_id, source_user_seq, role_key, requirement_index,
             requirement_digest, resolved, registered_at, resolved_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const role of projection.roles) {
          insert.run(
            key.sessionId,
            key.sourceUserSeq,
            role.roleKey,
            role.requirementIndex,
            role.requirementDigest,
            role.resolved ? 1 : 0,
            now,
            role.resolved ? now : null,
          );
        }
      } else {
        const membership = rawRoles(db, key);
        if (prior.role_count !== projection.roles.length || membership.length !== projection.roles.length) {
          throw new Error('DiscoveryGovernor requirement projection conflicts with the frozen accepted task.');
        }
        const storedByIndex = new Map(membership.map((role) => [role.requirement_index, role]));
        for (const role of projection.roles) {
          const stored = storedByIndex.get(role.requirementIndex);
          if (
            !stored
            || stored.requirement_digest !== role.requirementDigest
            // Receipt-backed effect refinement may change `clause-N:unknown`
            // to `clause-N:read|write` only as it RESOLVES that clause. Keep
            // the frozen key and close it; an unresolved rename is a conflict.
            || (stored.role_key !== role.roleKey && !role.resolved)
          ) {
            throw new Error('DiscoveryGovernor requirement projection conflicts with the frozen accepted task.');
          }
        }
        const update = db.prepare(`
          UPDATE discovery_governor_roles
             SET resolved = 1, resolved_at = COALESCE(resolved_at, ?)
           WHERE session_id = ? AND source_user_seq = ?
             AND role_key = ? AND requirement_index = ?
             AND requirement_digest = ? AND resolved = 0
        `);
        for (const role of projection.roles) {
          if (!role.resolved) continue;
          const stored = storedByIndex.get(role.requirementIndex)!;
          update.run(
            now,
            key.sessionId,
            key.sourceUserSeq,
            stored.role_key,
            stored.requirement_index,
            stored.requirement_digest,
          );
        }
        const updatedMembership = rawRoles(db, key);
        const unresolved = updatedMembership.filter((role) => role.resolved === 0).length;
        db.prepare(`
          UPDATE discovery_governor_role_sets
             SET unresolved_count = ?, updated_at = ?
           WHERE session_id = ? AND source_user_seq = ?
        `).run(unresolved, now, key.sessionId, key.sourceUserSeq);
      }

      const roleSet = rawRoleSet(db, key);
      if (!roleSet) throw new Error('DiscoveryGovernor failed to persist requirement role membership.');
      const roles = rawRoles(db, key).map(rowToRole);
      const tightened = Boolean(
        prior && roleSet.unresolved_count < prior.unresolved_count,
      );
      return {
        status: !prior ? 'initialized' : tightened ? 'tightened' : 'existing',
        policy: rowToPolicy(task, roleSet),
        roles,
      };
    });
    return initialize.immediate();
  }

  admit(input: AdmitDiscoveryInput): DiscoveryDecision {
    const key = taskKey(input);
    const callId = normalizedCallId(input.callId);
    const freshPlanCatalogDisclosure = input.category === 'broad_discovery'
      && input.authorityClass === 'fresh_plan_catalog_disclosure';
    const requestedSubject = normalizedSubject(input.category, input.subject);
    let subject = requestedSubject;
    let roleAdvisory: string | undefined;
    const db = this.databaseProvider();
    ensureSchema(db);
    const decide = db.transaction((): DiscoveryDecision => {
      const rawPolicy = db.prepare(`
        SELECT * FROM discovery_governor_tasks
         WHERE session_id = ? AND source_user_seq = ?
      `).get(key.sessionId, key.sourceUserSeq) as RawTaskRow | undefined;
      const policy = rawPolicy ? rowToPolicy(rawPolicy, rawRoleSet(db, key)) : null;
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

      // The opaque fresh-plan marker proves WHICH configured broker object
      // issued the call; it never replaces WHAT unresolved requirement the
      // model selected. A role-scoped task therefore always validates and keys
      // the exact host-frozen role. Only a compatibility task with no durable
      // role projection may fall back to the single host marker.
      if (input.category === 'broad_discovery' && !policy.roleScoped) {
        subject = freshPlanCatalogDisclosure ? 'host:fresh_plan_catalog' : '';
      }

      // COERCE, DO NOT REFUSE. A role the task does not have is a correction to
      // hand back with the results, not a reason to withhold them: measured
      // 2026-08-24, 30 turns hit this gate, 26 completed anyway, and the 86
      // refused calls had already been paid for. The subject still collapses to
      // a HOST-OWNED key so the claim ledger can never be keyed on model text.
      if (input.category === 'broad_discovery' && policy.roleScoped) {
        const role = subject
          ? db.prepare(`
              SELECT * FROM discovery_governor_roles
               WHERE session_id = ? AND source_user_seq = ? AND role_key = ?
            `).get(key.sessionId, key.sourceUserSeq, subject) as RawRoleRow | undefined
          : undefined;
        const openRoles = (): string => {
          const keys = rawRoles(db, key)
            .filter((row) => row.resolved !== 1)
            .map((row) => row.role_key)
            .filter((roleKey): roleKey is string => Boolean(roleKey));
          return keys.length
            ? ` Unresolved requirement roles for this task: ${keys.slice(0, 12).join(', ')}.`
            : ' This task has no unresolved requirement role.';
        };
        if (!subject) {
          roleAdvisory = `This search was not scoped to a requirement role.${openRoles()}`;
          subject = HOST_UNSCOPED_DISCOVERY_SUBJECT;
        } else if (!role) {
          roleAdvisory = `"${subject}" is not a requirement role of this task, so the search ran unscoped.${openRoles()}`;
          subject = HOST_UNSCOPED_DISCOVERY_SUBJECT;
        } else if (role.resolved === 1) {
          roleAdvisory = `"${subject}" is already resolved — you can execute that path directly instead of searching for it.${openRoles()}`;
          subject = HOST_UNSCOPED_DISCOVERY_SUBJECT;
        }
      }

      // The backstop is counted over the whole task, across every epoch and
      // subject, because a runaway is a runaway regardless of how it labels
      // itself. It is checked BEFORE the claim lookup so a replay cannot ride
      // past it.
      // Counted from the durable decision telemetry the governor already emits,
      // so the backstop survives a restart without a new authority table.
      let admittedSoFar: { count: number } | undefined;
      try {
        admittedSoFar = db.prepare(`
          SELECT COUNT(*) AS count FROM events
           WHERE session_id = ?
             AND type = 'discovery_governor_decision'
             AND json_extract(data_json, '$.sourceUserSeq') = ?
             AND json_extract(data_json, '$.decision') = 'admitted'
        `).get(key.sessionId, key.sourceUserSeq) as { count: number };
      } catch {
        // A backstop must never be the reason discovery fails. If the count
        // cannot be read, admit and rely on the user's stop.
        admittedSoFar = undefined;
      }
      if ((admittedSoFar?.count ?? 0) >= MAX_TURN_DISCOVERY_ADMISSIONS) {
        return buildDecision({
          key,
          category: input.category,
          subject,
          callId,
          admitted: false,
          reason: 'turn_discovery_ceiling',
          replay: false,
          consumedBudget: false,
          policy,
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
        // The durable claim authorizes one exact physical invocation identity.
        // A distinct call id is not a replay of that invocation: admitting it
        // while settlement still belongs to `existing.callId` would execute a
        // second concurrent provider body. If an upstream physical/result
        // layer can replay the exact same id's bytes, it returns before
        // reaching this boundary; reaching the governor again proves there is
        // no such cached path, so even the same id is denied here rather than
        // re-entering provider code.
        //
        // ONE exception, per the constraint-ordering law (never demand
        // evidence while denying the read that produces it): once the claim
        // has SETTLED SUCCESSFUL, there is no in-flight settlement to protect,
        // and a new physical call on the same subject is a follow-up /
        // pagination / refinement of the already-admitted intent — a bounded
        // continuation read. The claim transfers to the continuation call
        // (prior outcomes stay durable in the decision/outcome event ledger),
        // it consumes a real admission, and MAX_TURN_DISCOVERY_ADMISSIONS
        // remains the runaway bound. Settled-UNSUCCESSFUL claims keep
        // recovering only through the host-observed evidence epoch.
        const settledContinuation = existing.callId !== callId
          && existing.outcome === 'succeeded';
        if (!settledContinuation) {
          return buildDecision({
            key,
            category: input.category,
            subject,
            callId,
            admitted: false,
            reason: existing.callId === callId
              ? 'same_call_replay'
              : 'new_call_requires_retry_epoch',
            replay: true,
            consumedBudget: false,
            policy,
            claim: existing,
            ...(roleAdvisory ? { advisory: roleAdvisory } : {}),
          });
        }
        const continuationAdmittedAt = new Date().toISOString();
        const transferred = db.prepare(`
          UPDATE discovery_governor_claims
             SET call_id = ?, outcome = 'pending', outcome_detail = NULL,
                 admitted_at = ?, settled_at = NULL
           WHERE session_id = ? AND source_user_seq = ?
             AND epoch = ? AND category = ? AND subject = ?
             AND call_id = ? AND outcome = 'succeeded'
        `).run(
          callId, continuationAdmittedAt,
          key.sessionId, key.sourceUserSeq,
          policy.epoch, input.category, subject,
          existing.callId,
        );
        const continuationClaim = rowToClaim(db.prepare(`
          SELECT * FROM discovery_governor_claims
           WHERE session_id = ? AND source_user_seq = ?
             AND epoch = ? AND category = ? AND subject = ?
        `).get(
          key.sessionId, key.sourceUserSeq, policy.epoch, input.category, subject,
        ) as RawClaimRow);
        if (transferred.changes !== 1 || continuationClaim.callId !== callId) {
          // Lost a transfer race: exactly one physical owner survives.
          return buildDecision({
            key,
            category: input.category,
            subject,
            callId,
            admitted: false,
            reason: 'new_call_requires_retry_epoch',
            replay: true,
            consumedBudget: false,
            policy,
            claim: continuationClaim,
            ...(roleAdvisory ? { advisory: roleAdvisory } : {}),
          });
        }
        return buildDecision({
          key,
          category: input.category,
          subject,
          callId,
          admitted: true,
          reason: 'settled_continuation_admitted',
          replay: false,
          consumedBudget: true,
          policy,
          claim: continuationClaim,
          ...(roleAdvisory ? { advisory: roleAdvisory } : {}),
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
        // Lost the insert race: another call claimed this subject concurrently.
        // Only the winner owns provider authority. Returning an admitted
        // "replay" to a different id here would turn the atomic ledger race
        // into concurrent provider fan-out.
        return buildDecision({
          key,
          category: input.category,
          subject,
          callId,
          admitted: false,
          reason: claim.callId === callId
            ? 'same_call_replay'
            : 'new_call_requires_retry_epoch',
          replay: true,
          consumedBudget: false,
          policy,
          claim,
          ...(roleAdvisory ? { advisory: roleAdvisory } : {}),
        });
      }
      return buildDecision({
        key,
        category: input.category,
        subject,
        callId,
        admitted: true,
        reason: roleAdvisory
          ? 'role_coerced'
          : policy.epoch > 0
            ? 'new_evidence_admitted'
            : input.category === 'broad_discovery'
              ? 'novel_discovery_admitted'
              : 'schema_refresh_admitted',
        replay: false,
        consumedBudget: true,
        policy,
        claim,
        ...(roleAdvisory ? { advisory: roleAdvisory } : {}),
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
    let subject = normalizedSubject(input.category, input.subject);
    const detail = normalizedDetail(input.detail);
    const db = this.databaseProvider();
    ensureSchema(db);
    if (
      input.category === 'broad_discovery'
      && !rawRoleSet(db, key)
      && subject !== 'host:fresh_plan_catalog'
    ) subject = '';
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
    const policy = rowToPolicy(rawPolicy, rawRoleSet(db, key));
    const allClaims = (db.prepare(`
      SELECT * FROM discovery_governor_claims
       WHERE session_id = ? AND source_user_seq = ?
       ORDER BY epoch, category, subject
    `).all(key.sessionId, key.sourceUserSeq) as RawClaimRow[]).map(rowToClaim);
    const epochClaims = allClaims.filter((claim) => claim.epoch === policy.epoch);
    const claims: Partial<Record<DiscoveryCategory, DiscoveryClaim>> = {};
    // The category view remains a compatibility projection; epochClaims keeps
    // every role-scoped broad claim and every per-tool exact refresh.
    for (const claim of epochClaims) {
      if (claim.subject === '' || !claims[claim.category]) claims[claim.category] = claim;
    }
    return {
      policy,
      roles: rawRoles(db, key).map(rowToRole),
      claims,
      epochClaims,
      allClaims,
    };
  }
}

/**
 * The exact unresolved role keys a broad discovery may cite, for THIS accepted
 * task. A refusal that says "use the exact unresolved role_key shown in the
 * current capability card" is only followable if the caller can still see that
 * card; when it cannot, the model has to guess a host-owned identifier and gets
 * refused three different ways (role_required, role_not_unresolved,
 * role_resolved). Naming the admissible keys turns the guess into a fact.
 *
 * Read-only and failure-tolerant: a diagnostic can never be the reason a
 * refusal fails to reach its caller.
 */
/**
 * The subject an unusable role collapses onto.
 *
 * The claim primary key is (session, sourceUserSeq, epoch, category, subject),
 * and role_key arrives from the MODEL on the wire. The old role gate was the
 * only thing keeping that key inside a host-frozen set: refuse anything not in
 * discovery_governor_roles. Simply deleting the refusal would have made the
 * ledger key model-controlled free text, where `clause-1:read`, `Clause-1:read`
 * and `[role:sheets]` are three distinct claims and three live provider
 * searches — and a model GUESSING an identifier produces distinct strings by
 * construction. Coercion keeps the first subject key host-owned; the ordinary
 * one-physical-owner rule then denies further ids for that subject.
 */
export const HOST_UNSCOPED_DISCOVERY_SUBJECT = 'host:unscoped_role';

/**
 * Runaway backstop, not a policy gate.
 *
 * Per-subject physical ownership is the primary bound. This higher task-wide
 * cap remains defense in depth for accepted requests with many frozen roles,
 * exact-schema subjects, or evidence epochs: even legitimate distinct keys
 * cannot turn one model turn into unbounded provider round trips.
 *
 * High enough that no observed real turn reaches it: the busiest measured turn
 * on the production home issued 43 discovery attempts.
 */
export const MAX_TURN_DISCOVERY_ADMISSIONS = 120;

export function unresolvedDiscoveryRoleKeys(key: DiscoveryTaskKey): string[] {
  try {
    return rawRoles(openEventLog(), key)
      .filter((row) => row.resolved !== 1)
      .map((row) => row.role_key)
      .filter((roleKey): roleKey is string => typeof roleKey === 'string' && roleKey.length > 0);
  } catch {
    return [];
  }
}

export const discoveryGovernor = new DiscoveryGovernor();
