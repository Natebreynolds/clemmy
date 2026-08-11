/**
 * Durable home for the authoritative obligation manifest and its transitions.
 *
 * Two things live here because they must agree: the manifest that says what a
 * turn owes, and the record of what has been proved. Satisfaction is validated
 * against the manifest, ordered by the manifest's dependencies, and admitted
 * exactly once — by the database, not by a process-local Set, so two processes
 * racing the same obligation cannot both win.
 */
import {
  appendEvent,
  insertInternalEventInTransaction,
  listEvents,
  openEventLog,
  publishCommittedInternalEvent,
  type EventRow,
} from './eventlog.js';
import {
  manifestIdMatches,
  declaredObligation,
  type ObligationManifest,
} from './obligation-manifest.js';
import {
  redeemEvidenceReceipt,
  OBLIGATION_RECEIPT_KIND,
} from './evidence-receipts.js';

export const OBLIGATION_MANIFEST_EVENT = 'obligation_manifest' as const;

/**
 * Persist the manifest for an accepted turn.
 *
 * Refuses an `unresolved` manifest: work whose effects are still unknown has no
 * knowable obligations, and freezing an empty set for it would silently declare
 * that a half-planned action owes nothing.
 */
export function persistObligationManifest(manifest: ObligationManifest): boolean {
  if (!manifestIdMatches(manifest)) return false;
  if (manifest.readiness !== 'ready') return false;
  const existing = loadManifestState(manifest.identity.sessionId, manifest.identity.sourceUserSeq);
  // Re-persisting the identical manifest is idempotent, not a conflict; a
  // DIFFERENT one is a competing authority and must not be admitted.
  if (existing.status === 'ok') return existing.manifest.manifestId === manifest.manifestId;
  if (existing.status === 'ambiguous') return false;
  try {
    appendEvent({
      sessionId: manifest.identity.sessionId,
      turn: manifest.identity.turn,
      role: 'system',
      type: OBLIGATION_MANIFEST_EVENT,
      data: { sourceUserSeq: manifest.identity.sourceUserSeq, manifest },
    });
    return true;
  } catch {
    return false;
  }
}

export type ManifestState =
  | { status: 'ok'; manifest: ObligationManifest }
  /** No manifest at all — distinct from a legitimate zero-obligation one. */
  | { status: 'missing' }
  /** Two manifests claim this task, or one is unreadable. Fails closed. */
  | { status: 'ambiguous'; reason: string };

/** Typed rehydration. A manifest whose content address no longer matches is gone. */
export function loadManifestState(sessionId: string, sourceUserSeq: number): ManifestState {
  let rows: Array<Record<string, unknown>>;
  try {
    rows = listEvents(sessionId, { types: [OBLIGATION_MANIFEST_EVENT] })
      .map((event) => event.data as Record<string, unknown>)
      .filter((data) => data?.sourceUserSeq === sourceUserSeq);
  } catch (error) {
    return { status: 'ambiguous', reason: `manifest store unreadable: ${String(error)}` };
  }
  if (rows.length === 0) return { status: 'missing' };

  const manifests = rows
    .map((row) => row.manifest as ObligationManifest | undefined)
    .filter((manifest): manifest is ObligationManifest => Boolean(manifest));
  if (manifests.length !== rows.length) {
    return { status: 'ambiguous', reason: 'a persisted manifest row carries no manifest' };
  }
  const distinct = new Set(manifests.map((manifest) => manifest.manifestId));
  if (distinct.size > 1) {
    return { status: 'ambiguous', reason: `${distinct.size} competing manifests claim this task` };
  }
  const manifest = manifests[0];
  if (!manifestIdMatches(manifest)) {
    return { status: 'ambiguous', reason: 'manifest content does not match its address' };
  }
  if (manifest.readiness !== 'ready') {
    return { status: 'ambiguous', reason: 'manifest is unresolved' };
  }
  return { status: 'ok', manifest };
}

export function loadObligationManifest(
  sessionId: string,
  sourceUserSeq: number,
): ObligationManifest | undefined {
  const state = loadManifestState(sessionId, sourceUserSeq);
  return state.status === 'ok' ? state.manifest : undefined;
}

export interface SatisfactionRequest {
  sessionId: string;
  sourceUserSeq: number;
  manifestId: string;
  nodeId: string;
  obligation: string;
  receiptId: string;
  physicalAttemptId: string;
}

export type SatisfactionOutcome =
  | { ok: true }
  | { ok: false; reason: string };

function obligationKey(request: SatisfactionRequest): string {
  return [
    request.sessionId,
    request.sourceUserSeq,
    request.manifestId,
    request.nodeId,
    request.obligation,
  ].join('|');
}

/**
 * Claim AND record in one transaction.
 *
 * Splitting these is the crash window that matters: a claim taken without its
 * evidence row is permanent, so the obligation could never be satisfied again
 * by anyone. One transaction means a crash either leaves both or neither.
 */
function commitObligationTransition(
  key: string,
  row: Record<string, unknown>,
): boolean {
  let mirror: EventRow | null = null;
  try {
    const db = openEventLog();
    const tx = db.transaction((): boolean => {
      const existing = db.prepare(
        `SELECT manifest_id, node_id, obligation, receipt_id, physical_attempt_id
           FROM obligation_transitions WHERE obligation_key = ?`,
      ).get(key) as {
        manifest_id: string;
        node_id: string;
        obligation: string;
        receipt_id: string;
        physical_attempt_id: string;
      } | undefined;
      if (existing) return false;
      const at = new Date().toISOString();
      mirror = insertInternalEventInTransaction(db, {
        sessionId: String(row.sessionId),
        turn: 0,
        role: 'system',
        type: 'obligation_satisfied',
        data: {
          sourceUserSeq: Number(row.sourceUserSeq),
          manifestId: String(row.manifestId),
          nodeId: String(row.nodeId),
          obligation: String(row.obligation),
          receiptId: String(row.receiptId),
          physicalAttemptId: String(row.physicalAttemptId),
        },
      });
      const claimed = db.prepare(
        `INSERT INTO obligation_transitions
           (obligation_key, session_id, source_user_seq, manifest_id, node_id,
            obligation, receipt_id, physical_attempt_id, claimed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        key,
        String(row.sessionId), Number(row.sourceUserSeq), String(row.manifestId),
        String(row.nodeId), String(row.obligation), String(row.receiptId),
        String(row.physicalAttemptId), at,
      );
      return claimed.changes === 1;
    });
    const committed = tx.immediate();
    if (committed && mirror) publishCommittedInternalEvent(mirror);
    return committed;
  } catch {
    return false;
  }
}

/**
 * Obligations already proved for this task.
 *
 * The transition table is the single source of truth. Legacy `requirement_state`
 * events are deliberately NOT read here: two sources of terminal authority is
 * how an unproved obligation gets counted as proved by whichever reader is
 * consulted first.
 */
export function satisfiedObligations(
  sessionId: string,
  sourceUserSeq: number,
): Array<{ nodeId: string; obligation: string; receiptId: string; physicalAttemptId: string }> {
  const state = satisfiedObligationsState(sessionId, sourceUserSeq);
  return state.status === 'ok' ? state.transitions : [];
}

export type SatisfiedObligationsState =
  | {
      status: 'ok';
      transitions: Array<{
        manifestId: string;
        nodeId: string;
        obligation: string;
        receiptId: string;
        physicalAttemptId: string;
      }>;
    }
  | { status: 'unreadable'; reason: string };

/** Typed read: terminal authority must distinguish "none proved" from "the
 * proof store could not be read". */
export function satisfiedObligationsState(
  sessionId: string,
  sourceUserSeq: number,
): SatisfiedObligationsState {
  try {
    const db = openEventLog();
    const exists = db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'obligation_transitions'`,
    ).get();
    if (!exists) return { status: 'unreadable', reason: 'obligation transition table is missing' };
    return (db.prepare(
      `SELECT manifest_id, node_id, obligation, receipt_id, physical_attempt_id
         FROM obligation_transitions
        WHERE session_id = ? AND source_user_seq = ?`,
    ).all(sessionId, sourceUserSeq) as Array<Record<string, string>>)
      .reduce<SatisfiedObligationsState>((state, entry) => {
        if (state.status !== 'ok') return state;
        state.transitions.push({
          manifestId: entry.manifest_id,
          nodeId: entry.node_id,
          obligation: entry.obligation,
          receiptId: entry.receipt_id,
          physicalAttemptId: entry.physical_attempt_id,
        });
        return state;
      }, { status: 'ok', transitions: [] });
  } catch (error) {
    return { status: 'unreadable', reason: String(error) };
  }
}

/**
 * Satisfy one declared obligation with a redeemable typed receipt.
 *
 * Every dimension is checked against durable data rather than against what the
 * caller says it did: the manifest must declare this (node, obligation); the
 * receipt must be the kind that obligation requires; it must belong to this
 * task, this attempt and this effect; its backing bytes must be unchanged; and
 * the obligations it depends on must already be proved.
 */
export function satisfyDeclaredObligation(request: SatisfactionRequest): SatisfactionOutcome {
  const state = loadManifestState(request.sessionId, request.sourceUserSeq);
  if (state.status !== 'ok') {
    return {
      ok: false,
      reason: state.status === 'missing'
        ? 'no authoritative manifest for this accepted task'
        : `manifest authority is ambiguous: ${state.reason}`,
    };
  }
  const manifest = state.manifest;
  if (manifest.manifestId !== request.manifestId) {
    return { ok: false, reason: 'satisfaction names a different manifest than the one in force' };
  }

  const declared = declaredObligation(manifest, request.nodeId, request.obligation);
  if (!declared) {
    return {
      ok: false,
      reason: `manifest does not declare obligation '${request.obligation}' on node '${request.nodeId}'`,
    };
  }

  const requiredKind = OBLIGATION_RECEIPT_KIND[request.obligation];
  if (!requiredKind) {
    return { ok: false, reason: `obligation '${request.obligation}' is not receipt-provable` };
  }

  const redeemed = redeemEvidenceReceipt(request.sessionId, request.receiptId, {
    expectKind: requiredKind,
    sourceUserSeq: request.sourceUserSeq,
    physicalAttemptId: request.physicalAttemptId,
  });
  if (!redeemed.ok) return { ok: false, reason: redeemed.reason };

  // Qualified prerequisites: a read child's completeness can block a write
  // child's derivation, which a bare obligation name could never express.
  const proved = new Set(satisfiedObligations(request.sessionId, request.sourceUserSeq)
    .map((entry) => `${entry.nodeId}|${entry.obligation}`));
  const blocking = declared.dependsOn
    .filter((dependency) => !proved.has(`${dependency.nodeId}|${dependency.obligation}`));
  if (blocking.length > 0) {
    return {
      ok: false,
      reason: `blocked by unproved ${blocking.map((d) => `${d.nodeId}:${d.obligation}`).join(', ')}`,
    };
  }

  if (!commitObligationTransition(obligationKey(request), { ...request })) {
    return { ok: false, reason: 'this obligation was already satisfied' };
  }
  return { ok: true };
}

/** Declared obligations with no durable proof yet. */
export function outstandingDeclaredObligations(
  sessionId: string,
  sourceUserSeq: number,
): Array<{ nodeId: string; obligation: string }> {
  const manifest = loadObligationManifest(sessionId, sourceUserSeq);
  if (!manifest) return [];
  void appendEvent;
  const proved = new Set(satisfiedObligations(sessionId, sourceUserSeq)
    .map((entry) => `${entry.nodeId}|${entry.obligation}`));
  return manifest.nodes.flatMap((node) => node.obligations
    .filter((obligation) => !proved.has(`${node.nodeId}|${obligation}`))
    .map((obligation) => ({ nodeId: node.nodeId, obligation })));
}
