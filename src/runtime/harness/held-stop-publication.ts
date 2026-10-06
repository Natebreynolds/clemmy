/** Publication-only responsibility for an exact failed checkpoint owner.
 * No executor, model, tool, notification or task retry is callable here. */
import { createHash } from 'node:crypto';
import {
  HELD_STOP_PUBLICATION_METADATA_KEY as KEY, openEventLog,
  getRunAttemptSourceUserEvent, getRunAttemptBySourceUserSeq,
  readValidatedTerminalEvent, withEventPublicationTransaction, type EventRow,
} from './eventlog.js';
import { resolveExactTerminalForAcceptedSource } from './accepted-source-terminal.js';
import { completionEvidenceSource } from './recovery-activation.js';
import type { TurnIdentity } from './turn-outcome.js';

export const HELD_STOP_PUBLICATION_TEXT = 'I could not continue this request and its saved continuation point is unavailable, so it is still unfinished. Ask me to check what completed and what remains before continuing this exact request.';
export const HELD_STOP_PUBLICATION_PENDING_TEXT = 'This request is unfinished and I cannot yet verify its stop reply. Ask me to check this exact request’s delivery and any completed work before continuing.';
const LIMIT = 8;
const MAX_ENTRIES = 64;
const MAX_BYTES = 262_144;
const DELAYS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000];
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const positive = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) > 0;

interface Origin {
  version: 1;
  kind: 'unowned_held_stop';
  sessionId: string;
  sourceUserSeq: number;
  sourceEventId: string;
  turn: number;
  sourceDigest: string;
  audienceDigest: string;
  attemptId: string;
  runId: string | null;
  startedAt: string;
  executionSourceUserSeq: number;
  checkpointDigest: string;
}
interface Debt {
  origin: Origin;
  originDigest: string;
  revision: number;
  attemptsUsed: number;
  nextAttemptAt: number;
  state: 'pending' | 'parked';
}
export interface HeldStopPublicationTicket { readonly __opaqueHeldStopTicket: unique symbol }
export class HeldStopPublicationSupersededError extends Error {
  constructor() { super('The observed publication attempt has a verified newer source owner.'); }
}
const tickets = new WeakMap<object, Origin>();
const unsealed = new Map<string, Set<Origin>>();
function retainUnsealed(key: string, origin: Origin): void {
  const owners = unsealed.get(key) ?? new Set<Origin>();
  owners.add(origin); unsealed.set(key, owners);
}
function releaseUnsealed(key: string, origin: Origin): void {
  const owners = unsealed.get(key); if (!owners) return;
  owners.delete(origin); if (!owners.size) unsealed.delete(key);
}
interface MetadataRow { user_id: string | null; kind: string; channel: string | null; metadata_json: string | null }
function metadata(sessionId: string): { row: MetadataRow; value: Record<string, unknown>; debts: Record<string, unknown> } {
  const row = openEventLog().prepare('SELECT user_id, kind, channel, metadata_json FROM sessions WHERE id = ?').get(sessionId) as MetadataRow | undefined;
  if (!row) throw new Error('Publication session is missing.');
  const value: unknown = JSON.parse(row.metadata_json ?? '{}');
  if (!object(value)) throw new Error('Publication metadata is not an object.');
  const raw = value[KEY];
  if (raw !== undefined && !object(raw)) throw new Error('Publication namespace is malformed.');
  const debts = raw === undefined ? {} : raw;
  if (Object.keys(debts).length > MAX_ENTRIES || Buffer.byteLength(JSON.stringify(debts)) > MAX_BYTES) throw new Error('Publication namespace exceeds its finite bound.');
  return { row, value, debts };
}
function source(sessionId: string, seq: number): EventRow {
  const row = openEventLog().prepare("SELECT * FROM events WHERE session_id = ? AND seq = ? AND type = 'user_input_received' AND role = 'user'").get(sessionId, seq) as { id: string; turn: number; data_json: string; created_at: string } | undefined;
  if (!row || !positive(seq) || !Number.isSafeInteger(row.turn) || row.turn < 0) throw new Error('Publication source is invalid.');
  return { sessionId, seq, id: row.id, turn: row.turn, role: 'user', type: 'user_input_received', data: JSON.parse(row.data_json), createdAt: row.created_at, parentEventId: null };
}
function audience(row: MetadataRow, value: Record<string, unknown>): string {
  return hash({ userId: row.user_id, kind: row.kind, channel: row.channel,
    source: value.source ?? null, ingressProvider: value.ingressProvider ?? null,
    channelId: value.channelId ?? null, audience: value.userId ?? null, guildId: value.guildId ?? null });
}
function parseDebt(raw: unknown): Debt {
  if (!object(raw) || !object(raw.origin)) throw new Error('Publication debt is malformed.');
  const debt = raw as unknown as Debt; const o = debt.origin;
  if (o.version !== 1 || o.kind !== 'unowned_held_stop' || !o.sessionId || !positive(o.sourceUserSeq)
    || !positive(o.executionSourceUserSeq) || !o.sourceEventId || !o.attemptId || typeof o.startedAt !== 'string'
    || (o.runId !== null && typeof o.runId !== 'string') || !Number.isSafeInteger(o.turn) || o.turn < 0
    || ![o.sourceDigest, o.audienceDigest, o.checkpointDigest, debt.originDigest].every(v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v))
    || hash(o) !== debt.originDigest || !positive(debt.revision)
    || !Number.isSafeInteger(debt.attemptsUsed) || debt.attemptsUsed < 0 || debt.attemptsUsed > LIMIT
    || !Number.isSafeInteger(debt.nextAttemptAt) || debt.nextAttemptAt < 0
    || !['pending', 'parked'].includes(debt.state) || Buffer.byteLength(JSON.stringify(raw)) > 4_096) throw new Error('Publication debt is invalid.');
  return debt;
}
function boundSource(origin: Origin): EventRow {
  const snap = metadata(origin.sessionId); const accepted = source(origin.sessionId, origin.sourceUserSeq);
  const attempt = openEventLog().prepare('SELECT run_id, started_at, source_user_seq FROM run_attempts WHERE session_id = ? AND attempt_id = ?')
    .get(origin.sessionId, origin.attemptId) as { run_id: string | null; started_at: string; source_user_seq: number | null } | undefined;
  const attemptSource = getRunAttemptSourceUserEvent({ sessionId: origin.sessionId, attemptId: origin.attemptId });
  if (accepted.id !== origin.sourceEventId || accepted.turn !== origin.turn || hash(accepted.data) !== origin.sourceDigest
    || audience(snap.row, snap.value) !== origin.audienceDigest || !attempt || attempt.run_id !== origin.runId
    || attempt.started_at !== origin.startedAt || attempt.source_user_seq !== origin.sourceUserSeq || attemptSource?.id !== accepted.id
    || completionEvidenceSource({ sessionId: origin.sessionId, sourceUserSeq: origin.sourceUserSeq }).sourceUserSeq !== origin.executionSourceUserSeq) throw new Error('Publication origin binding changed.');
  return accepted;
}
function put(sessionId: string, seq: number, expected: Debt | undefined, next: Debt | undefined): void {
  const snap = metadata(sessionId); const current = snap.debts[String(seq)];
  if (JSON.stringify(current) !== JSON.stringify(expected)) throw new Error('Publication debt revision changed.');
  const entries = { ...snap.debts }; if (next) entries[String(seq)] = next; else delete entries[String(seq)];
  if (Object.keys(entries).length > MAX_ENTRIES || Buffer.byteLength(JSON.stringify(entries)) > MAX_BYTES) throw new Error('Publication namespace is full.');
  const value = { ...snap.value };
  if (Object.keys(entries).length) value[KEY] = entries; else delete value[KEY];
  const changed = openEventLog().prepare('UPDATE sessions SET metadata_json = ?, updated_at = ? WHERE id = ? AND metadata_json IS ?')
    .run(JSON.stringify(value), new Date().toISOString(), sessionId, snap.row.metadata_json).changes;
  // The exact whole-row CAS preserves unrelated metadata and cannot replay a
  // stale allowance. Only this private writer can mutate the protected key.
  if (changed !== 1) throw new Error('Publication metadata CAS lost.');
}

/** Called before the existing activation awaits, while its checkpoint is read. */
export function observeHeldStopPublicationOwner(input: { sessionId: string; sourceUserSeq: number; runAttemptId?: string }): HeldStopPublicationTicket | null {
  if (!input.runAttemptId) return null; // legacy source-only coverage is not invented
  const snap = metadata(input.sessionId); const accepted = source(input.sessionId, input.sourceUserSeq);
  const attempt = openEventLog().prepare('SELECT run_id, started_at, source_user_seq FROM run_attempts WHERE session_id = ? AND attempt_id = ?')
    .get(input.sessionId, input.runAttemptId) as { run_id: string | null; started_at: string; source_user_seq: number | null } | undefined;
  if (!attempt || attempt.source_user_seq !== accepted.seq) return null;
  const blob = snap.value.__host_recovery_state;
  if (typeof blob !== 'string') return null;
  const checkpoint = JSON.parse(blob) as { __clemHostRecovery?: number; sessionId?: string; sourceUserSeq?: number };
  const execution = completionEvidenceSource({ sessionId: input.sessionId, sourceUserSeq: accepted.seq });
  if (checkpoint.__clemHostRecovery !== 1 || checkpoint.sessionId !== input.sessionId || checkpoint.sourceUserSeq !== execution.sourceUserSeq) return null;
  const origin: Origin = { version: 1, kind: 'unowned_held_stop', sessionId: input.sessionId, sourceUserSeq: accepted.seq,
    sourceEventId: accepted.id, turn: accepted.turn, sourceDigest: hash(accepted.data), audienceDigest: audience(snap.row, snap.value),
    attemptId: input.runAttemptId, runId: attempt.run_id, startedAt: attempt.started_at, executionSourceUserSeq: execution.sourceUserSeq,
    checkpointDigest: hash(blob) };
  boundSource(origin);
  const ticket = Object.freeze({}) as HeldStopPublicationTicket; tickets.set(ticket, origin); return ticket;
}

function hasCheckpoint(origin: Origin): boolean {
  const blob = metadata(origin.sessionId).value.__host_recovery_state;
  if (blob === undefined) return false;
  if (typeof blob !== 'string') throw new Error('Recovery checkpoint is unreadable.');
  const state = JSON.parse(blob) as { sourceUserSeq?: number; sessionId?: string };
  return state.sessionId === origin.sessionId && state.sourceUserSeq === origin.executionSourceUserSeq;
}
/** A forged object/ordinary metadata/event cannot seal delivery responsibility. */
export function sealHeldStopPublication(ticket: HeldStopPublicationTicket, now = Date.now()): void {
  const origin = tickets.get(ticket);
  if (!origin) throw new Error('Held-stop publication ticket is missing or forged.');
  const key = `${origin.sessionId}:${origin.sourceUserSeq}`;
  retainUnsealed(key, origin);
  try { openEventLog().transaction(() => {
    boundSource(origin);
    const winner = resolveExactTerminalForAcceptedSource(source(origin.sessionId, origin.sourceUserSeq));
    if (winner.kind === 'terminal') { readValidatedTerminalEvent(winner.event.id, origin.sessionId, origin.sourceUserSeq); return; }
    const latest = getRunAttemptBySourceUserSeq(origin.sessionId, origin.sourceUserSeq);
    if (latest && latest.attemptId !== origin.attemptId) throw new HeldStopPublicationSupersededError();
    if (!latest || latest.status === 'completed' || latest.status === 'cancelled') {
      throw new Error('Publication attempt ownership changed.');
    }
    if (winner.kind !== 'absent' || hasCheckpoint(origin)) throw new Error('Publication source still has a terminal or checkpoint owner.');
    const raw = metadata(origin.sessionId).debts[String(origin.sourceUserSeq)];
    if (raw !== undefined) {
      if (parseDebt(raw).originDigest !== hash(origin)) throw new Error('Publication source already has another origin.');
      return; // same debt keeps its spent allowance
    }
    put(origin.sessionId, origin.sourceUserSeq, undefined, { origin, originDigest: hash(origin), revision: 1, attemptsUsed: 0, nextAttemptAt: now, state: 'pending' });
  }).immediate(); } catch (error) {
    // A proven successor owns this source. Release only this old ticket's
    // volatile fence; unavailable/unreadable storage retains its responsibility.
    if (error instanceof HeldStopPublicationSupersededError) releaseUnsealed(key, origin);
    throw error;
  }
  releaseUnsealed(key, origin);
}

/** A protected unreadable namespace is a hold, not evidence that work can run. */
export function heldStopPublicationOwnsSource(sessionId: string, sourceUserSeq: number): boolean {
  if (unsealed.has(`${sessionId}:${sourceUserSeq}`)) return true;
  if (!positive(sourceUserSeq)) return false;
  try {
    const row = openEventLog().prepare(`SELECT CASE
      WHEN metadata_json IS NULL THEN 0
      WHEN json_valid(metadata_json)=0 THEN 1
      WHEN json_type(metadata_json)!='object' THEN 1
      WHEN json_type(metadata_json, '$.__held_stop_publication_debt') IS NULL THEN 0
      WHEN json_type(metadata_json, '$.__held_stop_publication_debt')!='object' THEN 1
      ELSE json_type(metadata_json, ?) IS NOT NULL END AS owns FROM sessions WHERE id=?`)
      .get(`$.${KEY}."${sourceUserSeq}"`, sessionId) as { owns: number } | undefined;
    return row?.owns === 1;
  } catch { return true; }
}
/** A verified approval/connection delivery may name an older execution source.
 * This is only a recovery exclusion, never permission to adopt that source. */
export function heldStopPublicationHoldsExecutionSource(sessionId: string, sourceUserSeq: number): boolean {
  if (heldStopPublicationOwnsSource(sessionId, sourceUserSeq)) return true;
  for (const owners of unsealed.values()) for (const origin of owners) {
    if (origin.sessionId === sessionId && origin.executionSourceUserSeq === sourceUserSeq) return true;
  }
  try {
    for (const raw of Object.values(metadata(sessionId).debts)) {
      const debt = parseDebt(raw);
      if (debt.origin.sessionId !== sessionId) return true;
      if (debt.origin.executionSourceUserSeq === sourceUserSeq) return true;
    }
    return false;
  } catch { return true; }
}
export interface HeldStopPublicationAdapter {
  isExecuting(sessionId: string, sourceUserSeq: number): boolean;
  commit(identity: TurnIdentity, text: string): void;
}
function ownerChanged(debt: Debt): boolean {
  const o = debt.origin; const latest = getRunAttemptBySourceUserSeq(o.sessionId, o.sourceUserSeq);
  return !latest || latest.attemptId !== o.attemptId || latest.status === 'completed' || latest.status === 'cancelled';
}
function knownIneligible(debt: Debt, now: number): boolean {
  const o = debt.origin; const db = openEventLog();
  const busy = db.prepare(`SELECT
    (SELECT COUNT(*) FROM logical_tool_calls WHERE session_id=? AND source_user_seq=? AND state!='settled') AS logical,
    (SELECT COUNT(*) FROM physical_dispatches WHERE session_id=? AND source_user_seq=? AND state='started') AS physical`)
    .get(o.sessionId, o.executionSourceUserSeq, o.sessionId, o.executionSourceUserSeq) as { logical: number; physical: number };
  const lease = db.prepare('SELECT lease_owner, lease_expires_at FROM run_attempts WHERE session_id=? AND attempt_id=?')
    .get(o.sessionId, o.attemptId) as { lease_owner: string | null; lease_expires_at: string | null };
  return busy.logical > 0 || busy.physical > 0 || Boolean(lease.lease_owner && lease.lease_expires_at && Date.parse(lease.lease_expires_at) > now);
}
function ackWinner(debt: Debt): boolean {
  const o = debt.origin; const winner = resolveExactTerminalForAcceptedSource(boundSource(o));
  if (winner.kind === 'absent') return false;
  if (winner.kind !== 'terminal') throw new Error('Publication winner is legacy or corrupt.');
  readValidatedTerminalEvent(winner.event.id, o.sessionId, o.sourceUserSeq);
  put(o.sessionId, o.sourceUserSeq, debt, undefined); return true;
}
/** One synchronous publication pass. Known open-work waiting spends no credit. */
export function drainHeldStopPublication(sessionId: string, sourceUserSeq: number, adapter: HeldStopPublicationAdapter, now = Date.now()): 'absent' | 'held' | 'published' | 'acknowledged' {
  let debt: Debt;
  try {
    const raw = metadata(sessionId).debts[String(sourceUserSeq)]; if (raw === undefined) return 'absent'; debt = parseDebt(raw);
    if (debt.origin.sessionId !== sessionId || debt.origin.sourceUserSeq !== sourceUserSeq) return 'held';
    const ack = withEventPublicationTransaction(() => ackWinner(debt)); if (ack) return 'acknowledged';
    if (ownerChanged(debt) || hasCheckpoint(debt.origin) || adapter.isExecuting(sessionId, sourceUserSeq)
      || adapter.isExecuting(sessionId, debt.origin.executionSourceUserSeq) || knownIneligible(debt, now)
      || debt.attemptsUsed >= LIMIT || debt.nextAttemptAt > now) return 'held';
    // Charge in its own durable transaction BEFORE calling publication code.
    const charged: Debt = { ...debt, revision: debt.revision + 1, attemptsUsed: debt.attemptsUsed + 1,
      nextAttemptAt: now + DELAYS[debt.attemptsUsed]!, state: debt.attemptsUsed + 1 >= LIMIT ? 'parked' : 'pending' };
    openEventLog().transaction(() => {
      boundSource(debt.origin);
      // Repeat eligibility inside the write boundary: another process may have
      // acquired work after the advisory read but before this transaction.
      if (ownerChanged(debt) || hasCheckpoint(debt.origin) || adapter.isExecuting(sessionId, sourceUserSeq)
        || adapter.isExecuting(sessionId, debt.origin.executionSourceUserSeq) || knownIneligible(debt, now)) {
        throw new Error('Publication owner became ineligible before charge.');
      }
      put(sessionId, sourceUserSeq, debt, charged);
    }).immediate();
    withEventPublicationTransaction(() => {
      const current = parseDebt(metadata(sessionId).debts[String(sourceUserSeq)]);
      if (JSON.stringify(current) !== JSON.stringify(charged)) throw new Error('Publication allowance changed.');
      if (ackWinner(current)) return;
      if (ownerChanged(current) || hasCheckpoint(current.origin) || adapter.isExecuting(sessionId, sourceUserSeq)
        || adapter.isExecuting(sessionId, current.origin.executionSourceUserSeq) || knownIneligible(current, now)) throw new Error('Publication owner became ineligible.');
      const o = current.origin;
      adapter.commit({ sessionId, sourceUserSeq, turn: o.turn, attemptId: o.attemptId, ...(o.runId ? { runId: o.runId } : {}) }, HELD_STOP_PUBLICATION_TEXT);
      // Validate the actual canonical winner, not the proposed callback result.
      if (!ackWinner(current)) throw new Error('Publication callback did not save a canonical terminal.');
    });
    return 'published';
  } catch { return 'held'; } // retain exact responsibility; no executor fallback
}

let cursorSession = '';
let cursorSource = 0;
/** Bounded rotating source observation; no hint can mint publication credit. */
export function drainHeldStopPublications(adapter: HeldStopPublicationAdapter, now = Date.now(), limit = 8): number {
  const db = openEventLog(); const bound = Number.isFinite(limit) ? Math.max(1, Math.min(32, Math.trunc(limit))) : 8;
  const rows = db.prepare(`SELECT id FROM sessions WHERE id >= ? AND metadata_json IS NOT NULL AND
    CASE WHEN json_valid(metadata_json) THEN json_type(metadata_json, '$.__held_stop_publication_debt') IS NOT NULL ELSE 1 END
    ORDER BY id LIMIT ?`).all(cursorSession, bound + 1) as { id: string }[];
  let count = 0; let inspected = 0;
  for (const row of rows) {
    const after = row.id === cursorSession ? cursorSource : 0;
    cursorSession = row.id;
    try {
      const keys = Object.keys(metadata(row.id).debts).map(Number).filter(positive).sort((a,b) => a-b);
      for (const key of keys) if (key > after) {
        cursorSource = key;
        const result = drainHeldStopPublication(row.id, key, adapter, now);
        if (result === 'published' || result === 'acknowledged') count += 1;
        if (++inspected >= bound) return count;
      }
    } catch { /* unreadable protected ownership remains a hold */ }
    cursorSource = Number.MAX_SAFE_INTEGER;
  }
  // A full session page can contain no parseable source keys. Advance past
  // that page instead of repeatedly starving the later valid responsibilities.
  if (rows.length > bound) return count;
  cursorSession = ''; cursorSource = 0;
  return count;
}
