import { createHash, randomUUID } from 'node:crypto';
import {
  getSession, insertInternalEventInTransaction, openEventLog, publishCommittedInternalEvent,
  type EventRow,
} from './eventlog.js';
import { sameConversationAncestorSessionIds } from './accepted-source-session-branch.js';
import { parseTaskMode, type PlanRevisionRef } from './task-mode.js';

export type PlanJson = null | boolean | number | string | PlanJson[] | { [key: string]: PlanJson };
export type PlanStructuredOutline = { [key: string]: PlanJson };
/** A publication is rejected above this bound; no artifact bytes are shortened. */
export const MAX_PLAN_ARTIFACT_BYTES = 2 * 1024 * 1024;

export interface PlanArtifactV1 extends PlanRevisionRef {
  version: 1;
  sessionId: string;
  principalId: string;
  sourceUserSeq: number;
  sourceEventId: string;
  sourceDigest: string;
  createdAt: string;
  authorModelId?: string;
  fullText: string;
  /** Existing work topology/evidence JSON, retained for review, never a grant. */
  structuredPlan?: PlanStructuredOutline;
  readiness: 'ready' | 'needs_input';
  missingPrerequisites: string[];
  base?: PlanRevisionRef;
}

export interface PlanExecutionClaimV1 {
  version: 1;
  claimId: string;
  executionRunId: string;
  executionRunBinding: { kind: 'reserved' } | { kind: 'accepted_run_attempt'; attemptId: string };
  acceptedTaskId: string;
  sessionId: string;
  principalId: string;
  sourceUserSeq: number;
  sourceEventId: string;
  sourceDigest: string;
  ref: PlanRevisionRef;
  createdAt: string;
  digest: string;
}

export class PlanArtifactError extends Error {
  constructor(public readonly code: 'invalid' | 'denied' | 'missing' | 'stale' | 'conflict' | 'not_ready' | 'corrupt',
    message: string, public readonly latestRef?: PlanRevisionRef) {
    super(message);
    this.name = 'PlanArtifactError';
  }
}

type Db = ReturnType<typeof openEventLog>;
type Scope = { sessionId: string; principalId: string };
type SourceScope = Scope & { sourceUserSeq: number };
interface ArtifactRow { plan_id: string; revision: number; digest: string; session_id: string; source_user_seq: number; principal_id: string; artifact_json: string; event_id: string }
interface ClaimRow { claim_id: string; plan_id: string; revision: number; session_id: string; source_user_seq: number; claim_json: string; event_id: string }

function fail(code: PlanArtifactError['code'], message: string): never { throw new PlanArtifactError(code, message); }

/** Closed JSON values only: no undefined, non-finite numbers, accessors, or
 * non-JSON objects can disappear silently from the immutable review bytes. */
function canonical(value: unknown, depth = 0): string {
  if (depth > 100) return fail('invalid', 'Plan JSON nesting exceeds 100 levels.');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).length !== value.length + 1
      || Array.from({ length: value.length }, (_, index) => descriptors[String(index)])
        .some(entry => !entry?.enumerable || !('value' in entry))) return fail('invalid', 'Plan JSON arrays must be dense data values and have no extra properties.');
    return `[${Array.from({ length: value.length }, (_, index) => canonical(descriptors[String(index)]!.value, depth + 1)).join(',')}]`;
  }
  if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Reflect.ownKeys(value).some(key => typeof key !== 'string')
      || Object.values(descriptors).some(entry => !entry.enumerable || !('value' in entry))) {
      return fail('invalid', 'Plan JSON must contain only enumerable data properties.');
    }
    return `{${Object.keys(descriptors).sort().map(key => `${JSON.stringify(key)}:${canonical(descriptors[key]!.value, depth + 1)}`).join(',')}}`;
  }
  return fail('invalid', 'Plan JSON contains a value that cannot be retained exactly.');
}

function digest(kind: string, value: unknown): string {
  return createHash('sha256').update(`clementine:${kind}:v1\0`).update(canonical(value)).digest('hex');
}

function refOf(artifact: PlanRevisionRef): PlanRevisionRef {
  return { planId: artifact.planId, revision: artifact.revision, digest: artifact.digest };
}

function checkedRef(ref: PlanRevisionRef): PlanRevisionRef {
  const mode = parseTaskMode({ version: 1, kind: 'execute', executeRef: ref });
  if (mode?.kind !== 'execute') return fail('invalid', 'An exact plan revision reference is required.');
  return mode.executeRef;
}

function ensureStore(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reviewed_plan_revisions_v1 (
      plan_id TEXT NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0), digest TEXT NOT NULL,
      session_id TEXT NOT NULL REFERENCES sessions(id), source_user_seq INTEGER NOT NULL REFERENCES events(seq),
      principal_id TEXT NOT NULL, artifact_json TEXT NOT NULL, event_id TEXT NOT NULL REFERENCES events(id),
      PRIMARY KEY(plan_id, revision), UNIQUE(session_id, source_user_seq)
    );
    CREATE TABLE IF NOT EXISTS reviewed_plan_execution_claims_v1 (
      claim_id TEXT PRIMARY KEY, plan_id TEXT NOT NULL, revision INTEGER NOT NULL,
      session_id TEXT NOT NULL REFERENCES sessions(id), source_user_seq INTEGER NOT NULL REFERENCES events(seq),
      claim_json TEXT NOT NULL, event_id TEXT NOT NULL REFERENCES events(id),
      UNIQUE(plan_id, revision), UNIQUE(session_id, source_user_seq),
      FOREIGN KEY(plan_id, revision) REFERENCES reviewed_plan_revisions_v1(plan_id, revision)
    );
    CREATE TABLE IF NOT EXISTS reviewed_plan_execution_observers_v1 (
      session_id TEXT NOT NULL REFERENCES sessions(id), source_user_seq INTEGER NOT NULL REFERENCES events(seq),
      claim_id TEXT NOT NULL REFERENCES reviewed_plan_execution_claims_v1(claim_id),
      source_digest TEXT NOT NULL,
      PRIMARY KEY(session_id, source_user_seq)
    );
    CREATE TRIGGER IF NOT EXISTS reviewed_plan_revisions_v1_no_update BEFORE UPDATE ON reviewed_plan_revisions_v1
      BEGIN SELECT RAISE(ABORT, 'reviewed plan revisions are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS reviewed_plan_revisions_v1_no_delete BEFORE DELETE ON reviewed_plan_revisions_v1
      BEGIN SELECT RAISE(ABORT, 'reviewed plan revisions are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS reviewed_plan_execution_claims_v1_no_update BEFORE UPDATE ON reviewed_plan_execution_claims_v1
      BEGIN SELECT RAISE(ABORT, 'reviewed plan execution claims are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS reviewed_plan_execution_claims_v1_no_delete BEFORE DELETE ON reviewed_plan_execution_claims_v1
      BEGIN SELECT RAISE(ABORT, 'reviewed plan execution claims are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS reviewed_plan_execution_observers_v1_no_update BEFORE UPDATE ON reviewed_plan_execution_observers_v1
      BEGIN SELECT RAISE(ABORT, 'reviewed plan execution observers are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS reviewed_plan_execution_observers_v1_no_delete BEFORE DELETE ON reviewed_plan_execution_observers_v1
      BEGIN SELECT RAISE(ABORT, 'reviewed plan execution observers are immutable'); END;
  `);
}

function ownedSession(scope: Scope): void {
  const session = getSession(scope.sessionId);
  if (!scope.principalId || !session || (session.userId ?? session.id) !== scope.principalId) {
    fail('denied', 'The authenticated principal does not own this conversation.');
  }
}

function accessible(scope: Scope, artifact: PlanArtifactV1): void {
  ownedSession(scope);
  ownedSession({ sessionId: artifact.sessionId, principalId: scope.principalId });
  if (artifact.principalId !== scope.principalId || (artifact.sessionId !== scope.sessionId
    && !sameConversationAncestorSessionIds(scope).includes(artifact.sessionId))) {
    fail('denied', 'Plan access requires its origin conversation or validated same-conversation ancestry.');
  }
}

function source(db: Db, input: SourceScope): EventRow {
  ownedSession(input);
  if (!Number.isSafeInteger(input.sourceUserSeq) || input.sourceUserSeq <= 0) fail('invalid', 'An exact accepted source is required.');
  const row = db.prepare('SELECT * FROM events WHERE session_id = ? AND seq = ?').get(input.sessionId, input.sourceUserSeq) as
    { id: string; seq: number; session_id: string; turn: number; role: string; type: string; parent_event_id: string | null; data_json: string; created_at: string } | undefined;
  if (!row || row.type !== 'user_input_received' || row.role !== 'user') fail('denied', 'Plan identity does not name an accepted user source in this conversation.');
  const data = JSON.parse(row.data_json) as Record<string, unknown>;
  if (data.synthetic === true || (data.userId != null && data.userId !== input.principalId)) fail('denied', 'Plan source ownership is inconsistent.');
  return { id: row.id, seq: row.seq, sessionId: row.session_id, turn: row.turn, role: row.role,
    type: 'user_input_received', parentEventId: row.parent_event_id, data, createdAt: row.created_at };
}

function sourceHash(event: EventRow): string { return digest('reviewed-plan-source', event); }

function artifactRow(db: Db, ref: PlanRevisionRef): ArtifactRow | undefined {
  return db.prepare('SELECT * FROM reviewed_plan_revisions_v1 WHERE plan_id = ? AND revision = ?').get(ref.planId, ref.revision) as ArtifactRow | undefined;
}

function publicationData(artifact: PlanArtifactV1): Record<string, unknown> {
  return { artifact, planArtifactRef: refOf(artifact), sourceUserSeq: artifact.sourceUserSeq, readiness: artifact.readiness };
}

function assertPublishedBefore(db: Db, artifact: PlanArtifactV1, origin: EventRow): void {
  const row = db.prepare(`SELECT events.seq FROM reviewed_plan_revisions_v1 revision
    JOIN events ON events.id = revision.event_id WHERE revision.plan_id = ? AND revision.revision = ?`)
    .get(artifact.planId, artifact.revision) as { seq: number } | undefined;
  if (!row || origin.seq <= row.seq) fail('denied', 'The accepted request must follow publication of its reviewed plan revision.');
}

function checkedArtifact(db: Db, row: ArtifactRow): PlanArtifactV1 {
  const artifact = JSON.parse(row.artifact_json) as PlanArtifactV1;
  const { digest: storedDigest, ...body } = artifact;
  if (artifact.version !== 1 || artifact.planId !== row.plan_id || artifact.revision !== row.revision
    || artifact.sessionId !== row.session_id || artifact.sourceUserSeq !== row.source_user_seq
    || artifact.principalId !== row.principal_id || storedDigest !== row.digest
    || digest('reviewed-plan-artifact', body) !== storedDigest) fail('corrupt', 'The immutable plan artifact does not match its digest or identity.');
  const origin = source(db, artifact);
  if (sourceHash(origin) !== artifact.sourceDigest || origin.id !== artifact.sourceEventId
    || parseTaskMode(origin.data.taskMode)?.kind !== 'plan') fail('corrupt', 'The plan no longer matches its accepted planning source.');
  const mirror = db.prepare('SELECT session_id, parent_event_id, type, data_json FROM events WHERE id = ?').get(row.event_id) as
    { session_id: string; parent_event_id: string | null; type: string; data_json: string } | undefined;
  if (!mirror || mirror.type !== 'plan_revision_published' || mirror.session_id !== artifact.sessionId
    || mirror.parent_event_id !== artifact.sourceEventId || canonical(JSON.parse(mirror.data_json)) !== canonical(publicationData(artifact))) {
    fail('corrupt', 'The plan publication event does not match the immutable artifact.');
  }
  return artifact;
}

function loadExact(db: Db, input: Scope & { ref: PlanRevisionRef }): PlanArtifactV1 {
  ownedSession(input);
  const ref = checkedRef(input.ref);
  const row = artifactRow(db, ref);
  if (!row) fail('missing', 'The selected plan revision does not exist.');
  // Authenticate before returning any content or information about revisions.
  if (row.principal_id !== input.principalId) fail('denied', 'The plan belongs to another principal.');
  const artifact = checkedArtifact(db, row);
  accessible(input, artifact);
  if (artifact.digest !== ref.digest) fail('conflict', 'The selected plan digest does not match the reviewed revision.');
  return artifact;
}

function latest(db: Db, planId: string): PlanArtifactV1 {
  const row = db.prepare('SELECT * FROM reviewed_plan_revisions_v1 WHERE plan_id = ? ORDER BY revision DESC LIMIT 1').get(planId) as ArtifactRow | undefined;
  if (!row) return fail('missing', 'The plan does not exist.');
  return checkedArtifact(db, row);
}

function assertLatest(db: Db, artifact: PlanArtifactV1): void {
  const current = latest(db, artifact.planId);
  if (current.revision !== artifact.revision || current.digest !== artifact.digest) {
    throw new PlanArtifactError('stale', 'This plan revision is stale. Review the latest revision before continuing.', refOf(current));
  }
}

export interface PublishPlanRevisionInput extends SourceScope {
  fullText: string;
  structuredPlan?: PlanStructuredOutline;
  authorModelId?: string;
  readiness: PlanArtifactV1['readiness'];
  missingPrerequisites?: string[];
  base?: PlanRevisionRef;
}

export function publishPlanRevision(input: PublishPlanRevisionInput): PlanArtifactV1 {
  const db = openEventLog();
  ensureStore(db);
  if (typeof input.fullText !== 'string' || !input.fullText.trim()) fail('invalid', 'Publish the complete nonempty plan text.');
  if (input.readiness !== 'ready' && input.readiness !== 'needs_input') fail('invalid', 'Plan readiness must be explicit.');
  const missingPrerequisites = input.missingPrerequisites ?? [];
  if (!Array.isArray(missingPrerequisites) || missingPrerequisites.some(item => typeof item !== 'string' || !item.trim())) fail('invalid', 'Missing prerequisites must be nonempty strings.');
  if (input.readiness === 'ready' && missingPrerequisites.length > 0) fail('not_ready', 'A plan with missing prerequisites cannot be ready.');
  if (input.structuredPlan !== undefined && (!input.structuredPlan || typeof input.structuredPlan !== 'object' || Array.isArray(input.structuredPlan))) fail('invalid', 'structuredPlan must be a JSON object.');
  if (input.authorModelId !== undefined && (typeof input.authorModelId !== 'string' || !input.authorModelId.trim())) fail('invalid', 'Author model identity must be a nonempty string.');
  const content = { fullText: input.fullText, readiness: input.readiness, missingPrerequisites,
    ...(input.structuredPlan !== undefined ? { structuredPlan: input.structuredPlan } : {}),
    ...(input.authorModelId !== undefined ? { authorModelId: input.authorModelId } : {}),
    ...(input.base ? { base: checkedRef(input.base) } : {}) };
  const contentJson = canonical(content);
  if (Buffer.byteLength(contentJson) > MAX_PLAN_ARTIFACT_BYTES) fail('invalid', `Complete plan exceeds the ${MAX_PLAN_ARTIFACT_BYTES}-byte artifact limit. Split the scope and republish; no partial revision was stored.`);
  let event: EventRow | undefined;
  const artifact = db.transaction(() => {
    const origin = source(db, input);
    if (parseTaskMode(origin.data.taskMode)?.kind !== 'plan') fail('denied', 'Only an accepted Plan-mode source may publish a reviewed plan.');
    const prior = db.prepare('SELECT * FROM reviewed_plan_revisions_v1 WHERE session_id = ? AND source_user_seq = ?').get(input.sessionId, input.sourceUserSeq) as ArtifactRow | undefined;
    if (prior) {
      const existing = checkedArtifact(db, prior);
      const { version: _v, planId: _p, revision: _r, digest: _d, sessionId: _s, principalId: _o,
        sourceUserSeq: _q, sourceEventId: _e, sourceDigest: _h, createdAt: _t, ...retainedContent } = existing;
      if (canonical(retainedContent) !== contentJson) fail('conflict', 'This accepted source already published different immutable plan bytes. Revise in a new Plan turn.');
      return existing;
    }
    const base = input.base ? loadExact(db, { ...input, ref: input.base }) : undefined;
    if (base) assertLatest(db, base);
    if (base) assertPublishedBefore(db, base, origin);
    const body = { version: 1 as const, planId: base?.planId ?? `plan-${randomUUID()}`,
      revision: (base?.revision ?? 0) + 1, sessionId: input.sessionId, principalId: input.principalId,
      sourceUserSeq: origin.seq, sourceEventId: origin.id, sourceDigest: sourceHash(origin),
      createdAt: new Date().toISOString(), ...JSON.parse(contentJson) };
    const next = { ...body, digest: digest('reviewed-plan-artifact', body) } as PlanArtifactV1;
    if (Buffer.byteLength(canonical(next)) > MAX_PLAN_ARTIFACT_BYTES) fail('invalid', `Complete plan exceeds the ${MAX_PLAN_ARTIFACT_BYTES}-byte artifact limit including its identity. No partial revision was stored.`);
    event = insertInternalEventInTransaction(db, { sessionId: input.sessionId, turn: origin.turn, role: 'host',
      type: 'plan_revision_published', parentEventId: origin.id, data: publicationData(next) });
    db.prepare('INSERT INTO reviewed_plan_revisions_v1 VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
      next.planId, next.revision, next.digest, next.sessionId, next.sourceUserSeq, next.principalId, canonical(next), event.id);
    return next;
  }).immediate();
  if (event) publishCommittedInternalEvent(event);
  return artifact;
}

export function getPlanRevision(input: Scope & { ref: PlanRevisionRef }): PlanArtifactV1 {
  const db = openEventLog(); ensureStore(db);
  return db.transaction(() => loadExact(db, input))();
}

/** Exact source lookup for terminal projection. Never infer a plan from the
 * newest revision in the conversation or from model-authored reply metadata. */
export function getPlanRevisionForSource(input: SourceScope): PlanArtifactV1 | null {
  const db = openEventLog();
  ownedSession(input);
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'reviewed_plan_revisions_v1'").get()) return null;
  return db.transaction(() => {
    const row = db.prepare('SELECT * FROM reviewed_plan_revisions_v1 WHERE session_id = ? AND source_user_seq = ?')
      .get(input.sessionId, input.sourceUserSeq) as ArtifactRow | undefined;
    if (!row) return null;
    const artifact = checkedArtifact(db, row);
    accessible(input, artifact);
    return artifact;
  })();
}

export function getLatestPlanRevision(input: Scope & { planId?: string }): PlanArtifactV1 | null {
  const db = openEventLog(); ensureStore(db);
  return db.transaction(() => {
    ownedSession(input);
    if (input.planId) {
      const current = latest(db, input.planId);
      accessible(input, current);
      return current;
    }
    const sessions = [input.sessionId, ...sameConversationAncestorSessionIds(input)];
    const row = db.prepare(`SELECT * FROM reviewed_plan_revisions_v1 WHERE principal_id = ?
      AND session_id IN (${sessions.map(() => '?').join(',')}) ORDER BY source_user_seq DESC LIMIT 1`).get(input.principalId, ...sessions) as ArtifactRow | undefined;
    if (!row) return null;
    const current = latest(db, row.plan_id);
    accessible(input, current);
    return current;
  })();
}

function checkedClaim(db: Db, row: ClaimRow, artifact: PlanArtifactV1): PlanExecutionClaimV1 {
  const claim = JSON.parse(row.claim_json) as PlanExecutionClaimV1;
  const { digest: storedDigest, ...body } = claim;
  if (claim.version !== 1 || digest('reviewed-plan-execution', body) !== storedDigest || claim.claimId !== row.claim_id
    || claim.sessionId !== row.session_id || claim.sourceUserSeq !== row.source_user_seq
    || row.plan_id !== artifact.planId || row.revision !== artifact.revision
    || canonical(claim.ref) !== canonical(refOf(artifact)) || claim.principalId !== artifact.principalId
    || claim.acceptedTaskId !== `task:${claim.sessionId}#${claim.sourceUserSeq}`) fail('corrupt', 'The execution claim identity or digest is inconsistent.');
  if (claim.executionRunBinding?.kind === 'accepted_run_attempt') {
    const attempt = db.prepare('SELECT session_id, source_user_seq, run_id FROM run_attempts WHERE attempt_id = ?')
      .get(claim.executionRunBinding.attemptId) as { session_id: string; source_user_seq: number; run_id: string | null } | undefined;
    if (!attempt || attempt.session_id !== claim.sessionId || attempt.source_user_seq !== claim.sourceUserSeq
      || !attempt.run_id || attempt.run_id !== claim.executionRunId) fail('corrupt', 'The execution claim lost its exact accepted-source run binding.');
  } else if (claim.executionRunBinding?.kind !== 'reserved'
    || claim.executionRunId !== `run-plan-${digest('reviewed-plan-run', claim.ref).slice(0, 32)}`) fail('corrupt', 'The execution run reservation is inconsistent.');
  const origin = source(db, claim);
  const mode = parseTaskMode(origin.data.taskMode);
  if (origin.id !== claim.sourceEventId || sourceHash(origin) !== claim.sourceDigest || mode?.kind !== 'execute'
    || canonical(mode.executeRef) !== canonical(claim.ref)) fail('corrupt', 'The execution claim no longer matches its accepted Execute source.');
  accessible(claim, artifact);
  const mirror = db.prepare('SELECT type, session_id, parent_event_id, data_json FROM events WHERE id = ?').get(row.event_id) as
    { type: string; session_id: string; parent_event_id: string | null; data_json: string } | undefined;
  if (!mirror || mirror.type !== 'plan_execution_claimed' || mirror.session_id !== claim.sessionId
    || mirror.parent_event_id !== claim.sourceEventId || canonical(JSON.parse(mirror.data_json)) !== canonical({ claim })) fail('corrupt', 'The execution claim event is inconsistent.');
  return claim;
}

export function getPlanExecutionClaim(input: Scope & { ref: PlanRevisionRef }): PlanExecutionClaimV1 | null {
  const db = openEventLog(); ensureStore(db);
  return db.transaction(() => {
    const artifact = loadExact(db, input);
    const row = db.prepare('SELECT * FROM reviewed_plan_execution_claims_v1 WHERE plan_id = ? AND revision = ?').get(artifact.planId, artifact.revision) as ClaimRow | undefined;
    return row ? checkedClaim(db, row, artifact) : null;
  })();
}

/** Reservation only. The caller must execute/rejoin claim.executionRunId under
 * claim's original accepted source. No approval scope, workflow, or provider
 * invocation is created by this transaction. */
export function claimPlanExecution(input: SourceScope & { executeRef: PlanRevisionRef }): {
  artifact: PlanArtifactV1; claim: PlanExecutionClaimV1; replayed: boolean; joinedExistingSource: boolean;
} {
  const db = openEventLog(); ensureStore(db);
  let event: EventRow | undefined;
  const result = db.transaction(() => {
    const origin = source(db, input);
    const mode = parseTaskMode(origin.data.taskMode);
    const ref = checkedRef(input.executeRef);
    if (mode?.kind !== 'execute' || canonical(mode.executeRef) !== canonical(ref)) fail('denied', 'Execute must match the exact mode and revision persisted on this accepted source.');
    const artifact = loadExact(db, { ...input, ref });
    assertPublishedBefore(db, artifact, origin);
    const observer = db.prepare('SELECT claim_id, source_digest FROM reviewed_plan_execution_observers_v1 WHERE session_id = ? AND source_user_seq = ?').get(input.sessionId, input.sourceUserSeq) as { claim_id: string; source_digest: string } | undefined;
    const row = db.prepare('SELECT * FROM reviewed_plan_execution_claims_v1 WHERE plan_id = ? AND revision = ?').get(ref.planId, ref.revision) as ClaimRow | undefined;
    if (observer) {
      if (!row || row.claim_id !== observer.claim_id || observer.source_digest !== sourceHash(origin)) fail('conflict', 'This Execute source is already bound to another claim or different accepted bytes.');
      const claim = checkedClaim(db, row, artifact);
      return { artifact, claim, replayed: true, joinedExistingSource: claim.sourceUserSeq !== origin.seq };
    }
    assertLatest(db, artifact);
    if (artifact.readiness !== 'ready' || artifact.missingPrerequisites.length) fail('not_ready', 'Resolve the published plan prerequisites before Execute.');
    let claim: PlanExecutionClaimV1;
    if (row) claim = checkedClaim(db, row, artifact);
    else {
      const attempts = db.prepare(`SELECT attempt_id, run_id FROM run_attempts
        WHERE session_id = ? AND source_user_seq = ? AND run_id IS NOT NULL
        ORDER BY CASE WHEN status = 'active' THEN 0 ELSE 1 END, started_at, attempt_id`)
        .all(input.sessionId, origin.seq) as Array<{ attempt_id: string; run_id: string }>;
      if (new Set(attempts.map(attempt => attempt.run_id)).size > 1) fail('conflict', 'The Execute source has conflicting execution run identities.');
      const attempt = attempts[0];
      const body = { version: 1 as const, claimId: `plan-execution-${randomUUID()}`,
        executionRunId: attempt?.run_id ?? `run-plan-${digest('reviewed-plan-run', ref).slice(0, 32)}`,
        executionRunBinding: attempt ? { kind: 'accepted_run_attempt' as const, attemptId: attempt.attempt_id } : { kind: 'reserved' as const },
        acceptedTaskId: `task:${input.sessionId}#${origin.seq}`, sessionId: input.sessionId,
        principalId: input.principalId, sourceUserSeq: origin.seq, sourceEventId: origin.id,
        sourceDigest: sourceHash(origin), ref, createdAt: new Date().toISOString() };
      claim = { ...body, digest: digest('reviewed-plan-execution', body) };
      event = insertInternalEventInTransaction(db, { sessionId: input.sessionId, turn: origin.turn, role: 'host',
        type: 'plan_execution_claimed', parentEventId: origin.id, data: { claim } });
      db.prepare('INSERT INTO reviewed_plan_execution_claims_v1 VALUES (?, ?, ?, ?, ?, ?, ?)').run(
        claim.claimId, ref.planId, ref.revision, input.sessionId, origin.seq, canonical(claim), event.id);
    }
    db.prepare('INSERT INTO reviewed_plan_execution_observers_v1 VALUES (?, ?, ?, ?)').run(input.sessionId, origin.seq, claim.claimId, sourceHash(origin));
    return { artifact, claim, replayed: Boolean(row), joinedExistingSource: claim.sourceUserSeq !== origin.seq };
  }).immediate();
  if (event) publishCommittedInternalEvent(event);
  return result;
}
