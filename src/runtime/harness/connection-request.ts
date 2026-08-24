/**
 * Typed ConnectionRequest — a user-owned credential dependency.
 *
 * When an admitted plan needs a capability family the user has not provisioned,
 * the host parks the exact source instead of asking them to retype it. A later
 * connection refresh re-evaluates the parked objective against the live
 * registry; if the gap is gone, the request is satisfied and the same task
 * can re-enter. The request is not call authority.
 */
import { createHash, randomUUID } from 'node:crypto';
import { appendEvent, listEvents, openEventLog } from './eventlog.js';
import { selectGoalCatalog, type GoalCatalogSelection } from './connected-goal-catalog.js';

export type ConnectionRequestFamily = GoalCatalogSelection['gaps'][number];

export interface ConnectionRequestV1 {
  requestId: string;
  sessionId: string;
  sourceUserSeq: number;
  turn: number;
  objective: string;
  families: ConnectionRequestFamily[];
  status: 'open' | 'satisfied' | 'cancelled';
  createdAt: string;
  satisfiedAt?: string;
}

function ensureTable(): void {
  openEventLog().exec(`
    CREATE TABLE IF NOT EXISTS connection_requests (
      request_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      source_user_seq INTEGER NOT NULL,
      turn INTEGER NOT NULL,
      objective TEXT NOT NULL,
      families_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      satisfied_at TEXT,
      wake_source_user_seq INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_connection_requests_open
      ON connection_requests (status, session_id);
  `);
}

function rowToRequest(row: {
  request_id: string;
  session_id: string;
  source_user_seq: number;
  turn: number;
  objective: string;
  families_json: string;
  status: string;
  created_at: string;
  satisfied_at: string | null;
}): ConnectionRequestV1 {
  let families: ConnectionRequestFamily[] = [];
  try {
    const parsed = JSON.parse(row.families_json) as unknown;
    if (Array.isArray(parsed)) {
      families = parsed.filter((entry): entry is ConnectionRequestFamily => (
        entry === 'search' || entry === 'row_create' || entry === 'readback'
      ));
    }
  } catch { /* empty families fail closed at satisfy time */ }
  return {
    requestId: row.request_id,
    sessionId: row.session_id,
    sourceUserSeq: row.source_user_seq,
    turn: row.turn,
    objective: row.objective,
    families,
    status: row.status === 'satisfied' || row.status === 'cancelled' ? row.status : 'open',
    createdAt: row.created_at,
    ...(row.satisfied_at ? { satisfiedAt: row.satisfied_at } : {}),
  };
}

export function connectionRequestCopy(families: readonly ConnectionRequestFamily[]): string {
  const labels: string[] = [];
  if (families.includes('search')) labels.push('a web search that can return the collection');
  if (families.includes('row_create')) {
    labels.push('an app that can create the destination from the collected rows');
  }
  if (families.includes('readback')) labels.push('a read-back on the created destination');
  const needed = labels.length > 0
    ? labels.join(' or ')
    : 'the connected app this plan needs';
  return `I understood the task, but none of your connected apps provide ${needed}. `
    + 'Connect one that does — I will continue this exact request. Nothing was started.';
}

export function parkConnectionRequest(input: {
  sessionId: string;
  sourceUserSeq: number;
  turn: number;
  objective: string;
  families: readonly ConnectionRequestFamily[];
}): ConnectionRequestV1 {
  ensureTable();
  const existing = openEventLog().prepare(
    `SELECT * FROM connection_requests
      WHERE session_id = ? AND source_user_seq = ? AND status = 'open'`,
  ).get(input.sessionId, input.sourceUserSeq) as Parameters<typeof rowToRequest>[0] | undefined;
  if (existing) return rowToRequest(existing);
  const now = new Date().toISOString();
  const requestId = `cr:${createHash('sha256')
    .update(`${input.sessionId}:${input.sourceUserSeq}:${randomUUID()}`)
    .digest('hex')
    .slice(0, 24)}`;
  const families = [...new Set(input.families)];
  openEventLog().prepare(
    `INSERT INTO connection_requests (
      request_id, session_id, source_user_seq, turn, objective, families_json, status, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
  ).run(
    requestId,
    input.sessionId,
    input.sourceUserSeq,
    input.turn,
    input.objective,
    JSON.stringify(families),
    now,
  );
  try {
    appendEvent({
      sessionId: input.sessionId,
      turn: input.turn,
      role: 'system',
      type: 'connection_request',
      data: {
        requestId,
        sourceUserSeq: input.sourceUserSeq,
        families,
        objective: input.objective,
        status: 'open',
      },
    });
  } catch { /* the table row is the authority; the event is a projection */ }
  return {
    requestId,
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    turn: input.turn,
    objective: input.objective,
    families,
    status: 'open',
    createdAt: now,
  };
}

export function listOpenConnectionRequests(): ConnectionRequestV1[] {
  try {
    ensureTable();
    const rows = openEventLog().prepare(
      `SELECT * FROM connection_requests WHERE status = 'open' ORDER BY created_at ASC`,
    ).all() as Array<Parameters<typeof rowToRequest>[0]>;
    return rows.map(rowToRequest);
  } catch {
    return [];
  }
}

/**
 * Re-evaluate parked objectives against the live connected registry.
 * Provider names stay out of this module: a request is satisfied only when
 * `selectGoalCatalog` reports no remaining family gap.
 */
export function satisfyConnectionRequestsNow(): ConnectionRequestV1[] {
  const open = listOpenConnectionRequests();
  const satisfied: ConnectionRequestV1[] = [];
  const now = new Date().toISOString();
  for (const request of open) {
    let gaps: GoalCatalogSelection['gaps'] = request.families;
    try {
      gaps = selectGoalCatalog(request.objective).gaps;
    } catch { /* keep the parked families; do not satisfy on a catalog crash */ }
    if (gaps.length > 0) continue;
    openEventLog().prepare(
      `UPDATE connection_requests SET status = 'satisfied', satisfied_at = ? WHERE request_id = ? AND status = 'open'`,
    ).run(now, request.requestId);
    try {
      appendEvent({
        sessionId: request.sessionId,
        turn: request.turn,
        role: 'system',
        type: 'connection_request_satisfied',
        data: {
          requestId: request.requestId,
          sourceUserSeq: request.sourceUserSeq,
          families: request.families,
        },
      });
    } catch { /* table status is the authority */ }
    satisfied.push({ ...request, status: 'satisfied', satisfiedAt: now });
  }
  return satisfied;
}

/** Fire-and-forget from connection-publication hot paths. Never awaited. */
export function scheduleConnectionRequestWake(): void {
  void (async () => {
    try {
      satisfyConnectionRequestsNow();
    } catch { /* wake is best-effort and must never break a connection refresh */ }
  })();
}
