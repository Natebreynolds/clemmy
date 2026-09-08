import {
  claimHarnessChatRequestInTransaction, getHarnessChatRequestReceipt, getHarnessChatCancellation, openEventLog,
  type HarnessChatRequestReceipt,
} from './eventlog.js';
import {
  getLatestPlanRevision, getPlanRevision, PlanArtifactError,
} from './plan-artifacts.js';
import type { PlanRevisionRef } from './task-mode.js';

type Scope = { sessionId: string; principalId: string; ref: PlanRevisionRef; requestId: string; inputHash: string };
type Claim = { receipt: HarnessChatRequestReceipt; inserted: boolean };
interface Row { plan_id: string; revision: number; digest: string; principal_id: string; owner_request_id: string }

function store(): ReturnType<typeof openEventLog> {
  const db = openEventLog();
  db.exec(`CREATE TABLE IF NOT EXISTS reviewed_plan_ingress_v1 (
    plan_id TEXT NOT NULL, revision INTEGER NOT NULL, digest TEXT NOT NULL,
    principal_id TEXT NOT NULL, owner_request_id TEXT NOT NULL UNIQUE REFERENCES harness_chat_requests(request_id),
    PRIMARY KEY (plan_id, revision),
    FOREIGN KEY (plan_id, revision) REFERENCES reviewed_plan_revisions_v1(plan_id, revision)
  );
  CREATE TABLE IF NOT EXISTS reviewed_plan_ingress_aliases_v1 (
    request_id TEXT PRIMARY KEY,
    owner_request_id TEXT NOT NULL REFERENCES harness_chat_requests(request_id),
    input_hash TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_reviewed_plan_ingress_alias_owner
    ON reviewed_plan_ingress_aliases_v1(owner_request_id)`);
  return db;
}

function inspect(input: Scope): HarnessChatRequestReceipt | null {
  // Authenticate the selected conversation and all exact reviewed bytes before
  // looking up an execution, including retries with a new transport key.
  const artifact = getPlanRevision(input);
  const db = store();
  const prior = getHarnessChatRequestReceipt(input.requestId);
  const row = db.prepare('SELECT * FROM reviewed_plan_ingress_v1 WHERE plan_id = ? AND revision = ?')
    .get(input.ref.planId, input.ref.revision) as Row | undefined;
  const owner = row ? getHarnessChatRequestReceipt(row.owner_request_id) : null;
  if (row && (!owner || row.digest !== artifact.digest || row.principal_id !== input.principalId)) {
    throw new PlanArtifactError('corrupt', 'The reviewed plan ingress reservation is inconsistent.');
  }
  if (getHarnessChatCancellation(input.requestId) || (owner && getHarnessChatCancellation(owner.requestId))) {
    throw new PlanArtifactError('denied', 'This plan execution was stopped. Its recorded work remains available; Execute cannot restart it.');
  }
  if (prior && (!owner || prior.runId !== owner.runId || prior.sessionId !== owner.sessionId
    || prior.inputHash !== input.inputHash)) {
    throw new PlanArtifactError('conflict', 'This request ID is already bound to different Execute input.');
  }
  // A transport retry can still observe its original run after a revision.
  // A new tap must refer to the currently reviewed revision.
  if (!prior) {
    const latest = getLatestPlanRevision({ ...input, planId: artifact.planId });
    if (!latest || latest.digest !== artifact.digest || latest.revision !== artifact.revision) {
      throw new PlanArtifactError('stale', 'Review the latest plan revision before Execute.', latest ?? undefined);
    }
  }
  if (artifact.readiness !== 'ready' || artifact.missingPrerequisites.length) {
    throw new PlanArtifactError('not_ready', 'Resolve the published plan prerequisites before Execute.');
  }
  if (owner && owner.inputHash !== input.inputHash) {
    throw new PlanArtifactError('conflict', 'This plan already has an execution with different input. Revise the plan to change the requested work.');
  }
  return owner;
}

/** Read-only preflight. This is not the race boundary; claim below rechecks in
 * one transaction before any run attempt can supersede an existing owner. */
export function inspectPlanExecutionIngress(input: Scope): HarnessChatRequestReceipt | null {
  return inspect(input);
}

/** A reviewed revision owns one durable chat run, even when two Execute taps
 * have different request IDs. The ordinary session selector still creates the
 * first receipt; subsequent keys alias it without creating a source/attempt.
 * A crash before source acceptance can safely continue this same reservation.
 * Once accepted, callers must rejoin its stream and existing recovery state. */
export function claimPlanExecutionIngress(input: Scope, create: () => Claim): Claim & { joined: boolean } {
  // Initialize the artifact store before the FK-backed ingress table.
  getPlanRevision(input);
  const db = store();
  return db.transaction(() => {
    const owner = inspect(input);
    if (owner) {
      const inserted = !getHarnessChatRequestReceipt(input.requestId);
      if (inserted) db.prepare('INSERT INTO reviewed_plan_ingress_aliases_v1 VALUES (?, ?, ?, ?)')
        .run(input.requestId, owner.requestId, input.inputHash, new Date().toISOString());
      const alias = claimHarnessChatRequestInTransaction(db, {
        requestId: input.requestId, inputHash: input.inputHash,
        sessionId: owner.sessionId, runId: owner.runId, sinceSeq: owner.sinceSeq,
      });
      return { ...alias, inserted, joined: true };
    }
    const first = create();
    if (!first.inserted || first.receipt.requestId !== input.requestId || first.receipt.inputHash !== input.inputHash) {
      throw new PlanArtifactError('conflict', 'The first Execute receipt does not match its exact input.');
    }
    // The selected successor must retain access to the reviewed origin.
    getPlanRevision({ ...input, sessionId: first.receipt.sessionId });
    db.prepare('INSERT INTO reviewed_plan_ingress_v1 VALUES (?, ?, ?, ?, ?)').run(
      input.ref.planId, input.ref.revision, input.ref.digest, input.principalId, input.requestId,
    );
    return { ...first, joined: false };
  }).immediate();
}
