/**
 * Durable review ledger for AutomationOpportunityV1 proposals.
 *
 * Every mutation is an immediate SQLite transaction guarded by BOTH the exact
 * revision and the semantic digest observed by the caller. The append-only
 * revision table retains the complete canonical proposal at each review step.
 * Approval records review consent; it does not compile, schedule, or execute.
 */
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

import { BASE_DIR } from '../config.js';
import {
  AutomationOpportunityValidationError,
  automationOpportunityDigest,
  canonicalAutomationOpportunityJson,
  isAutomationOpportunityDigest,
  parseAutomationOpportunity,
  type AutomationOpportunityV1,
} from './automation-opportunity.js';

export type AutomationOpportunityProposalStatus =
  | 'proposed'
  | 'reviewed'
  | 'approved'
  | 'rejected';

export interface AutomationOpportunityProposalRecordV1 {
  version: 1;
  proposalId: string;
  status: AutomationOpportunityProposalStatus;
  revision: number;
  digest: string;
  opportunity: AutomationOpportunityV1;
  createdAt: string;
  updatedAt: string;
  reviewedAt?: string;
  decidedAt?: string;
}

export interface AutomationOpportunityProposalRevisionV1 {
  proposalId: string;
  revision: number;
  status: AutomationOpportunityProposalStatus;
  digest: string;
  opportunity: AutomationOpportunityV1;
  actorRef: string;
  note?: string;
  createdAt: string;
}

export type AutomationOpportunityStoreFailureCode =
  | 'invalid'
  | 'already_exists'
  | 'not_found'
  | 'cas_mismatch'
  | 'invalid_transition'
  | 'unchanged';

export type AutomationOpportunityStoreWrite =
  | { ok: true; record: AutomationOpportunityProposalRecordV1 }
  | {
    ok: false;
    code: AutomationOpportunityStoreFailureCode;
    message: string;
    current?: AutomationOpportunityProposalRecordV1;
  };

export const AUTOMATION_OPPORTUNITY_STORE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS automation_opportunity_proposals (
  proposal_id      TEXT PRIMARY KEY,
  status           TEXT NOT NULL CHECK (status IN ('proposed','reviewed','approved','rejected')),
  revision         INTEGER NOT NULL CHECK (revision >= 1),
  digest           TEXT NOT NULL,
  opportunity_json TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  reviewed_at      TEXT,
  decided_at       TEXT
);

CREATE TABLE IF NOT EXISTS automation_opportunity_proposal_revisions (
  proposal_id      TEXT NOT NULL,
  revision         INTEGER NOT NULL CHECK (revision >= 1),
  status           TEXT NOT NULL CHECK (status IN ('proposed','reviewed','approved','rejected')),
  digest           TEXT NOT NULL,
  opportunity_json TEXT NOT NULL,
  actor_ref        TEXT NOT NULL,
  note             TEXT,
  created_at       TEXT NOT NULL,
  PRIMARY KEY (proposal_id, revision),
  FOREIGN KEY (proposal_id) REFERENCES automation_opportunity_proposals(proposal_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS automation_opportunity_proposals_status_updated
  ON automation_opportunity_proposals(status, updated_at DESC);
`;

interface ProposalRow {
  proposal_id: string;
  status: AutomationOpportunityProposalStatus;
  revision: number;
  digest: string;
  opportunity_json: string;
  created_at: string;
  updated_at: string;
  reviewed_at: string | null;
  decided_at: string | null;
}

interface RevisionRow {
  proposal_id: string;
  revision: number;
  status: AutomationOpportunityProposalStatus;
  digest: string;
  opportunity_json: string;
  actor_ref: string;
  note: string | null;
  created_at: string;
}

export class AutomationOpportunityStoreIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AutomationOpportunityStoreIntegrityError';
  }
}

const PROPOSAL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const MAX_ACTOR_REF = 256;
const MAX_NOTE = 8_192;

let handle: Database.Database | null = null;
let handlePath = '';

function configureDatabase(database: Database.Database): void {
  database.pragma('foreign_keys = ON');
  database.exec(AUTOMATION_OPPORTUNITY_STORE_SCHEMA_SQL);
}

export function openAutomationOpportunityStoreDb(): Database.Database {
  const dir = path.join(BASE_DIR, 'state', 'automation-opportunities');
  const file = path.join(dir, 'automation-opportunities.db');
  if (handle && handlePath === file) return handle;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  handle = new Database(file);
  handlePath = file;
  handle.pragma('journal_mode = WAL');
  handle.pragma('synchronous = NORMAL');
  handle.pragma('busy_timeout = 10000');
  configureDatabase(handle);
  return handle;
}

/** Test hook for isolated homes. */
export function closeAutomationOpportunityStoreForTests(): void {
  handle?.close();
  handle = null;
  handlePath = '';
}

function databaseOrDefault(database?: Database.Database): Database.Database {
  const selected = database ?? openAutomationOpportunityStoreDb();
  configureDatabase(selected);
  return selected;
}

function cleanActorRef(actorRef: unknown): string | null {
  if (typeof actorRef !== 'string') return null;
  const clean = actorRef.trim();
  return clean.length > 0 && clean.length <= MAX_ACTOR_REF ? clean : null;
}

function cleanNote(note: unknown): string | undefined | null {
  if (note === undefined) return undefined;
  if (typeof note !== 'string') return null;
  const clean = note.trim();
  if (!clean || clean.length > MAX_NOTE) return null;
  return clean;
}

function nowIso(now?: Date): string | null {
  const value = now ?? new Date();
  return Number.isFinite(value.getTime()) ? value.toISOString() : null;
}

function isProposalStatus(value: unknown): value is AutomationOpportunityProposalStatus {
  return value === 'proposed'
    || value === 'reviewed'
    || value === 'approved'
    || value === 'rejected';
}

function decodeOpportunity(json: string, digest: string, where: string): AutomationOpportunityV1 {
  if (!isAutomationOpportunityDigest(digest)) {
    throw new AutomationOpportunityStoreIntegrityError(`${where} has an invalid digest`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new AutomationOpportunityStoreIntegrityError(`${where} contains invalid JSON`);
  }
  let opportunity: AutomationOpportunityV1;
  try {
    opportunity = parseAutomationOpportunity(raw);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new AutomationOpportunityStoreIntegrityError(`${where} contains an invalid opportunity: ${detail}`);
  }
  const actual = automationOpportunityDigest(opportunity);
  if (actual !== digest) {
    throw new AutomationOpportunityStoreIntegrityError(`${where} digest does not match its canonical opportunity`);
  }
  return opportunity;
}

function rowToRecord(row: ProposalRow): AutomationOpportunityProposalRecordV1 {
  if (!PROPOSAL_ID_RE.test(row.proposal_id)) {
    throw new AutomationOpportunityStoreIntegrityError('proposal row has an invalid identity');
  }
  if (!isProposalStatus(row.status) || !Number.isSafeInteger(row.revision) || row.revision < 1) {
    throw new AutomationOpportunityStoreIntegrityError(`proposal "${row.proposal_id}" has invalid state`);
  }
  return {
    version: 1,
    proposalId: row.proposal_id,
    status: row.status,
    revision: row.revision,
    digest: row.digest,
    opportunity: decodeOpportunity(
      row.opportunity_json,
      row.digest,
      `proposal "${row.proposal_id}"`,
    ),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.reviewed_at ? { reviewedAt: row.reviewed_at } : {}),
    ...(row.decided_at ? { decidedAt: row.decided_at } : {}),
  };
}

function revisionRowToRecord(row: RevisionRow): AutomationOpportunityProposalRevisionV1 {
  if (!isProposalStatus(row.status) || !Number.isSafeInteger(row.revision) || row.revision < 1) {
    throw new AutomationOpportunityStoreIntegrityError(`proposal revision "${row.proposal_id}" has invalid state`);
  }
  return {
    proposalId: row.proposal_id,
    revision: row.revision,
    status: row.status,
    digest: row.digest,
    opportunity: decodeOpportunity(
      row.opportunity_json,
      row.digest,
      `proposal "${row.proposal_id}" revision ${row.revision}`,
    ),
    actorRef: row.actor_ref,
    ...(row.note ? { note: row.note } : {}),
    createdAt: row.created_at,
  };
}

function readProposalRow(
  database: Database.Database,
  proposalId: string,
): AutomationOpportunityProposalRecordV1 | undefined {
  const row = database.prepare(
    'SELECT * FROM automation_opportunity_proposals WHERE proposal_id = ?',
  ).get(proposalId) as ProposalRow | undefined;
  return row ? rowToRecord(row) : undefined;
}

export function loadAutomationOpportunityProposal(
  proposalId: string,
  database?: Database.Database,
): AutomationOpportunityProposalRecordV1 | undefined {
  if (!PROPOSAL_ID_RE.test(proposalId)) return undefined;
  return readProposalRow(databaseOrDefault(database), proposalId);
}

export function listAutomationOpportunityProposals(
  options: {
    status?: AutomationOpportunityProposalStatus;
    limit?: number;
    database?: Database.Database;
  } = {},
): AutomationOpportunityProposalRecordV1[] {
  const database = databaseOrDefault(options.database);
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
    throw new RangeError('proposal list limit must be an integer from 1 through 1000');
  }
  if (options.status !== undefined && !isProposalStatus(options.status)) {
    throw new TypeError('proposal list status is invalid');
  }
  const rows = options.status
    ? database.prepare(
      `SELECT * FROM automation_opportunity_proposals
       WHERE status = ? ORDER BY updated_at DESC, proposal_id ASC LIMIT ?`,
    ).all(options.status, limit) as ProposalRow[]
    : database.prepare(
      `SELECT * FROM automation_opportunity_proposals
       ORDER BY updated_at DESC, proposal_id ASC LIMIT ?`,
    ).all(limit) as ProposalRow[];
  return rows.map(rowToRecord);
}

export function listAutomationOpportunityProposalRevisions(
  proposalId: string,
  database?: Database.Database,
): AutomationOpportunityProposalRevisionV1[] {
  if (!PROPOSAL_ID_RE.test(proposalId)) return [];
  const rows = databaseOrDefault(database).prepare(
    `SELECT * FROM automation_opportunity_proposal_revisions
     WHERE proposal_id = ? ORDER BY revision ASC`,
  ).all(proposalId) as RevisionRow[];
  return rows.map(revisionRowToRecord);
}

function validationFailure(error: unknown): AutomationOpportunityStoreWrite {
  const detail = error instanceof AutomationOpportunityValidationError
    ? error.errors.join('; ')
    : error instanceof Error ? error.message : String(error);
  return { ok: false, code: 'invalid', message: detail };
}

function insertRevision(
  database: Database.Database,
  input: {
    proposalId: string;
    revision: number;
    status: AutomationOpportunityProposalStatus;
    digest: string;
    opportunityJson: string;
    actorRef: string;
    note?: string;
    now: string;
  },
): void {
  database.prepare(
    `INSERT INTO automation_opportunity_proposal_revisions
       (proposal_id, revision, status, digest, opportunity_json, actor_ref, note, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.proposalId,
    input.revision,
    input.status,
    input.digest,
    input.opportunityJson,
    input.actorRef,
    input.note ?? null,
    input.now,
  );
}

export function createAutomationOpportunityProposal(input: {
  proposalId: string;
  opportunity: unknown;
  actorRef: string;
  note?: string;
  now?: Date;
  database?: Database.Database;
}): AutomationOpportunityStoreWrite {
  if (!PROPOSAL_ID_RE.test(input.proposalId)) {
    return { ok: false, code: 'invalid', message: 'proposalId is not a safe identity' };
  }
  const actorRef = cleanActorRef(input.actorRef);
  const note = cleanNote(input.note);
  const now = nowIso(input.now);
  if (!actorRef || note === null || !now) {
    return { ok: false, code: 'invalid', message: 'actorRef, note, or timestamp is invalid' };
  }

  let opportunity: AutomationOpportunityV1;
  try {
    opportunity = parseAutomationOpportunity(input.opportunity);
  } catch (error) {
    return validationFailure(error);
  }
  const digest = automationOpportunityDigest(opportunity);
  const opportunityJson = canonicalAutomationOpportunityJson(opportunity);
  const database = databaseOrDefault(input.database);

  const transaction = database.transaction((): AutomationOpportunityStoreWrite => {
    const current = readProposalRow(database, input.proposalId);
    if (current) {
      return {
        ok: false,
        code: 'already_exists',
        message: `proposal "${input.proposalId}" already exists`,
        current,
      };
    }
    database.prepare(
      `INSERT INTO automation_opportunity_proposals
         (proposal_id, status, revision, digest, opportunity_json, created_at, updated_at,
          reviewed_at, decided_at)
       VALUES (?, 'proposed', 1, ?, ?, ?, ?, NULL, NULL)`,
    ).run(input.proposalId, digest, opportunityJson, now, now);
    insertRevision(database, {
      proposalId: input.proposalId,
      revision: 1,
      status: 'proposed',
      digest,
      opportunityJson,
      actorRef,
      ...(note ? { note } : {}),
      now,
    });
    return { ok: true, record: readProposalRow(database, input.proposalId)! };
  });
  return transaction.immediate();
}

function casInputError(input: {
  expectedRevision: number;
  expectedDigest: string;
  actorRef: string;
  note?: string;
  now?: Date;
}): { actorRef: string; note?: string; now: string } | string {
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) {
    return 'expectedRevision must be a positive integer';
  }
  if (!isAutomationOpportunityDigest(input.expectedDigest)) {
    return 'expectedDigest must be an exact sha256 digest';
  }
  const actorRef = cleanActorRef(input.actorRef);
  const note = cleanNote(input.note);
  const now = nowIso(input.now);
  if (!actorRef || note === null || !now) return 'actorRef, note, or timestamp is invalid';
  return { actorRef, ...(note ? { note } : {}), now };
}

function casCurrent(
  current: AutomationOpportunityProposalRecordV1 | undefined,
  expectedRevision: number,
  expectedDigest: string,
): AutomationOpportunityStoreWrite | null {
  if (!current) return { ok: false, code: 'not_found', message: 'proposal was not found' };
  if (current.revision !== expectedRevision || current.digest !== expectedDigest) {
    return {
      ok: false,
      code: 'cas_mismatch',
      message: `expected revision ${expectedRevision} and digest ${expectedDigest}; found revision ${current.revision} and digest ${current.digest}`,
      current,
    };
  }
  return null;
}

const TRANSITIONS: Readonly<Record<AutomationOpportunityProposalStatus, readonly AutomationOpportunityProposalStatus[]>> = {
  proposed: ['reviewed', 'rejected'],
  reviewed: ['approved', 'rejected'],
  approved: [],
  rejected: [],
};

export function transitionAutomationOpportunityProposal(input: {
  proposalId: string;
  to: Exclude<AutomationOpportunityProposalStatus, 'proposed'>;
  expectedRevision: number;
  expectedDigest: string;
  actorRef: string;
  note?: string;
  now?: Date;
  database?: Database.Database;
}): AutomationOpportunityStoreWrite {
  if (!PROPOSAL_ID_RE.test(input.proposalId)) {
    return { ok: false, code: 'invalid', message: 'proposalId is not a safe identity' };
  }
  if (input.to !== 'reviewed' && input.to !== 'approved' && input.to !== 'rejected') {
    return { ok: false, code: 'invalid', message: 'target proposal status is invalid' };
  }
  const metadata = casInputError(input);
  if (typeof metadata === 'string') return { ok: false, code: 'invalid', message: metadata };
  const database = databaseOrDefault(input.database);

  const transaction = database.transaction((): AutomationOpportunityStoreWrite => {
    const current = readProposalRow(database, input.proposalId);
    const mismatch = casCurrent(current, input.expectedRevision, input.expectedDigest);
    if (mismatch) return mismatch;
    if (!TRANSITIONS[current!.status].includes(input.to)) {
      return {
        ok: false,
        code: 'invalid_transition',
        message: `proposal cannot transition from ${current!.status} to ${input.to}`,
        current: current!,
      };
    }
    if (input.to === 'approved') {
      const required = current!.opportunity.missingInputs.filter((missing) => missing.required);
      if (required.length > 0) {
        return {
          ok: false,
          code: 'invalid_transition',
          message: `proposal cannot be approved with required inputs unresolved: ${required.map((item) => item.id).join(', ')}`,
          current: current!,
        };
      }
    }

    const nextRevision = current!.revision + 1;
    const changed = database.prepare(
      `UPDATE automation_opportunity_proposals
       SET status = ?, revision = ?, updated_at = ?,
           reviewed_at = CASE WHEN ? = 'reviewed' THEN ? ELSE reviewed_at END,
           decided_at = CASE WHEN ? IN ('approved','rejected') THEN ? ELSE decided_at END
       WHERE proposal_id = ? AND revision = ? AND digest = ?`,
    ).run(
      input.to,
      nextRevision,
      metadata.now,
      input.to,
      metadata.now,
      input.to,
      metadata.now,
      input.proposalId,
      current!.revision,
      current!.digest,
    ).changes;
    if (changed !== 1) {
      return {
        ok: false,
        code: 'cas_mismatch',
        message: 'proposal revision or digest was spent by another writer',
        current: readProposalRow(database, input.proposalId),
      };
    }
    insertRevision(database, {
      proposalId: input.proposalId,
      revision: nextRevision,
      status: input.to,
      digest: current!.digest,
      opportunityJson: canonicalAutomationOpportunityJson(current!.opportunity),
      actorRef: metadata.actorRef,
      ...(metadata.note ? { note: metadata.note } : {}),
      now: metadata.now,
    });
    return { ok: true, record: readProposalRow(database, input.proposalId)! };
  });
  return transaction.immediate();
}

export function reviseAutomationOpportunityProposal(input: {
  proposalId: string;
  opportunity: unknown;
  expectedRevision: number;
  expectedDigest: string;
  actorRef: string;
  note?: string;
  now?: Date;
  database?: Database.Database;
}): AutomationOpportunityStoreWrite {
  if (!PROPOSAL_ID_RE.test(input.proposalId)) {
    return { ok: false, code: 'invalid', message: 'proposalId is not a safe identity' };
  }
  const metadata = casInputError(input);
  if (typeof metadata === 'string') return { ok: false, code: 'invalid', message: metadata };

  let opportunity: AutomationOpportunityV1;
  try {
    opportunity = parseAutomationOpportunity(input.opportunity);
  } catch (error) {
    return validationFailure(error);
  }
  const digest = automationOpportunityDigest(opportunity);
  const opportunityJson = canonicalAutomationOpportunityJson(opportunity);
  const database = databaseOrDefault(input.database);

  const transaction = database.transaction((): AutomationOpportunityStoreWrite => {
    const current = readProposalRow(database, input.proposalId);
    const mismatch = casCurrent(current, input.expectedRevision, input.expectedDigest);
    if (mismatch) return mismatch;
    if (current!.status === 'approved' || current!.status === 'rejected') {
      return {
        ok: false,
        code: 'invalid_transition',
        message: `terminal ${current!.status} proposal cannot be revised`,
        current: current!,
      };
    }
    if (current!.digest === digest) {
      return {
        ok: false,
        code: 'unchanged',
        message: 'revision has the same semantic digest as the current proposal',
        current: current!,
      };
    }

    const nextRevision = current!.revision + 1;
    const changed = database.prepare(
      `UPDATE automation_opportunity_proposals
       SET status = 'proposed', revision = ?, digest = ?, opportunity_json = ?,
           updated_at = ?, reviewed_at = NULL, decided_at = NULL
       WHERE proposal_id = ? AND revision = ? AND digest = ?`,
    ).run(
      nextRevision,
      digest,
      opportunityJson,
      metadata.now,
      input.proposalId,
      current!.revision,
      current!.digest,
    ).changes;
    if (changed !== 1) {
      return {
        ok: false,
        code: 'cas_mismatch',
        message: 'proposal revision or digest was spent by another writer',
        current: readProposalRow(database, input.proposalId),
      };
    }
    insertRevision(database, {
      proposalId: input.proposalId,
      revision: nextRevision,
      status: 'proposed',
      digest,
      opportunityJson,
      actorRef: metadata.actorRef,
      ...(metadata.note ? { note: metadata.note } : {}),
      now: metadata.now,
    });
    return { ok: true, record: readProposalRow(database, input.proposalId)! };
  });
  return transaction.immediate();
}
