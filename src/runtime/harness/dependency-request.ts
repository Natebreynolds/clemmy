/**
 * Generic DependencyRequest — the canonical parked-task dependency.
 *
 * A connection event does not satisfy. Authoritative, freshly observed,
 * account-bound capability (or the matching user act) does. Index miss,
 * compiler failure, and author timeout are not connection_missing.
 */
import { createHash, randomUUID } from 'node:crypto';
import { appendEvent, openEventLog } from './eventlog.js';
import { renderTypedControlState } from './typed-control-state.js';

export const DEPENDENCY_REQUEST_VERSION = 1 as const;

export type DependencyKind =
  | 'connection_missing'
  | 'capability_contract_missing'
  | 'capability_certification_required'
  | 'account_or_resource_choice'
  | 'user_input'
  | 'approval'
  | 'spend_authority'
  | 'argument_provenance_missing'
  | 'external_wait'
  | 'transient_catalog_or_provider_state'
  | 'policy_resolution';

export type DependencyStatus = 'open' | 'resolving' | 'satisfied' | 'cancelled';

export interface DependencyRequestV1 {
  version: typeof DEPENDENCY_REQUEST_VERSION;
  requestId: string;
  kind: DependencyKind;
  sessionId: string;
  sourceUserSeq: number;
  turn: number;
  owner: 'user' | 'host';
  wake: { kind: string };
  status: DependencyStatus;
  text: string;
  createdAt: string;
  satisfiedAt?: string;
}

function ensureTable(): void {
  openEventLog().exec(`
    CREATE TABLE IF NOT EXISTS dependency_requests (
      request_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      session_id TEXT NOT NULL,
      source_user_seq INTEGER NOT NULL,
      turn INTEGER NOT NULL,
      owner TEXT NOT NULL,
      wake_kind TEXT NOT NULL,
      status TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      satisfied_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_dependency_requests_open
      ON dependency_requests (status, session_id);
  `);
}

export function dependencyCopy(kind: DependencyKind): string {
  if (kind === 'connection_missing') {
    return renderTypedControlState({
      status: 'needs_input',
      hold: { owner: 'user', wake: { kind: 'user_connection' }, gate: 'credential_connection_required' },
    });
  }
  if (kind === 'capability_certification_required') {
    return 'This connected app is visible but not certified for the required effect contract. Review the contract — I will continue this exact request. Nothing was started.';
  }
  if (kind === 'capability_contract_missing') {
    return 'I understood the task, but no attested capability contract covers it yet. Nothing was started. I will continue this exact request.';
  }
  return renderTypedControlState({
    status: 'needs_input',
    hold: { owner: 'user', wake: { kind: 'user_answer' } },
  });
}

export function parkDependencyRequest(input: {
  sessionId: string;
  sourceUserSeq: number;
  turn: number;
  kind: DependencyKind;
  text?: string;
}): DependencyRequestV1 {
  ensureTable();
  const existing = openEventLog().prepare(
    `SELECT * FROM dependency_requests
      WHERE session_id = ? AND source_user_seq = ? AND status = 'open'`,
  ).get(input.sessionId, input.sourceUserSeq) as {
    request_id: string;
    kind: DependencyKind;
    session_id: string;
    source_user_seq: number;
    turn: number;
    owner: 'user' | 'host';
    wake_kind: string;
    status: DependencyStatus;
    text: string;
    created_at: string;
    satisfied_at: string | null;
  } | undefined;
  if (existing) {
    return {
      version: 1,
      requestId: existing.request_id,
      kind: existing.kind,
      sessionId: existing.session_id,
      sourceUserSeq: existing.source_user_seq,
      turn: existing.turn,
      owner: existing.owner,
      wake: { kind: existing.wake_kind },
      status: existing.status,
      text: existing.text,
      createdAt: existing.created_at,
      ...(existing.satisfied_at ? { satisfiedAt: existing.satisfied_at } : {}),
    };
  }
  const now = new Date().toISOString();
  const requestId = `dep:${createHash('sha256')
    .update(`${input.sessionId}:${input.sourceUserSeq}:${randomUUID()}`)
    .digest('hex')
    .slice(0, 24)}`;
  const owner: 'user' | 'host' = (
    input.kind === 'external_wait' || input.kind === 'transient_catalog_or_provider_state'
  ) ? 'host' : 'user';
  const wake = owner === 'host' ? 'host_retry' : (
    input.kind === 'connection_missing' ? 'user_connection'
      : input.kind === 'approval' ? 'user_approval'
        : 'user_answer'
  );
  const text = input.text?.trim() || dependencyCopy(input.kind);
  openEventLog().prepare(
    `INSERT INTO dependency_requests (
      request_id, kind, session_id, source_user_seq, turn, owner, wake_kind, status, text, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`,
  ).run(
    requestId,
    input.kind,
    input.sessionId,
    input.sourceUserSeq,
    input.turn,
    owner,
    wake,
    text,
    now,
  );
  try {
    appendEvent({
      sessionId: input.sessionId,
      turn: input.turn,
      role: 'system',
      type: 'dependency_request',
      data: { requestId, kind: input.kind, sourceUserSeq: input.sourceUserSeq, status: 'open' },
    });
  } catch { /* table row is authority */ }
  return {
    version: 1,
    requestId,
    kind: input.kind,
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    turn: input.turn,
    owner,
    wake: { kind: wake },
    status: 'open',
    text,
    createdAt: now,
  };
}

export function satisfyOpenDependency(input: {
  sessionId: string;
  sourceUserSeq: number;
}): boolean {
  ensureTable();
  const now = new Date().toISOString();
  const result = openEventLog().prepare(
    `UPDATE dependency_requests SET status = 'satisfied', satisfied_at = ?
      WHERE session_id = ? AND source_user_seq = ? AND status = 'open'`,
  ).run(now, input.sessionId, input.sourceUserSeq);
  return result.changes > 0;
}
