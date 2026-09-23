/** Durable routing for contextual offers. Opening an offer never runs a task. */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createSession, getSession, openEventLog } from './harness/eventlog.js';

const nonempty = z.string().trim().min(1);
export const ProactiveOfferInput = z.object({
  id: nonempty.max(200),
  userId: nonempty.max(200),
  kind: z.enum(['goal', 'space', 'skill', 'workflow', 'question']),
  title: nonempty.max(200),
  summary: nonempty.max(4000),
  whyNow: nonempty.max(2000),
  evidenceRefs: z.array(nonempty.max(500)).min(1).max(50),
  contextQuestion: nonempty.max(2000).optional(),
  originSessionId: nonempty.max(200).optional(),
  expiresAt: z.string().datetime({ offset: true }).optional(),
}).strict();
export type ProactiveOfferInput = z.infer<typeof ProactiveOfferInput>;
export interface ProactiveOffer extends ProactiveOfferInput {
  revision: number;
  status: 'offered' | 'discussing' | 'dismissed' | 'snoozed' | 'withdrawn';
  snoozedUntil: string | null;
  resolutionReason: string | null;
  conversationId: string | null;
  createdAt: string;
  updatedAt: string;
}

const initialized = new WeakSet<object>();
function db() {
  const database = openEventLog();
  // Same transaction domain as sessions: a crash cannot publish a route to
  // a nonexistent chat or create two chats for a simultaneous mobile tap.
  if (!initialized.has(database)) {
    database.transaction(() => {
      database.exec(`CREATE TABLE IF NOT EXISTS proactive_offers (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL, revision INTEGER NOT NULL,
        status TEXT NOT NULL, conversation_id TEXT, input_json TEXT NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
        snoozed_until TEXT, resolution_reason TEXT
      )`);
      // Serialize the inspection and migration across concurrent desktop/mobile
      // processes. Existing offer/thread bindings remain untouched.
      const columns = database.pragma('table_info(proactive_offers)') as Array<{ name: string }>;
      if (!columns.some(c => c.name === 'snoozed_until')) database.exec('ALTER TABLE proactive_offers ADD COLUMN snoozed_until TEXT');
      if (!columns.some(c => c.name === 'resolution_reason')) database.exec('ALTER TABLE proactive_offers ADD COLUMN resolution_reason TEXT');
      database.exec(`CREATE TABLE IF NOT EXISTS proactive_offer_revisions (
        offer_id TEXT NOT NULL, revision INTEGER NOT NULL, input_json TEXT NOT NULL,
        recorded_at TEXT NOT NULL, PRIMARY KEY (offer_id, revision)
      )`);
      database.exec(`INSERT OR IGNORE INTO proactive_offer_revisions
        SELECT id, revision, input_json, updated_at FROM proactive_offers`);
    }).immediate();
    initialized.add(database);
  }
  return database;
}

interface Row {
  id: string; user_id: string; revision: number; status: ProactiveOffer['status'];
  snoozed_until: string | null; resolution_reason: string | null;
  conversation_id: string | null; input_json: string; created_at: string; updated_at: string;
}
function decode(row: Row): ProactiveOffer {
  return { ...ProactiveOfferInput.parse(JSON.parse(row.input_json)), revision: row.revision,
    snoozedUntil: row.snoozed_until, resolutionReason: row.resolution_reason,
    status: row.status, conversationId: row.conversation_id, createdAt: row.created_at, updatedAt: row.updated_at };
}
export function getProactiveOffer(id: string, userId: string): ProactiveOffer | null {
  const row = db().prepare('SELECT * FROM proactive_offers WHERE id = ? AND user_id = ?').get(id, userId) as Row | undefined;
  return row ? decode(row) : null;
}

/** Trusted producer entry point, not an unvalidated client body. Republishing
 * the same evidence does not revive a dismissal or reset the discussion. */
export function publishProactiveOffer(raw: ProactiveOfferInput): ProactiveOffer {
  const input = ProactiveOfferInput.parse(raw);
  input.evidenceRefs = [...new Set(input.evidenceRefs)].sort();
  const database = db();
  return database.transaction(() => {
    const old = database.prepare('SELECT * FROM proactive_offers WHERE id = ?').get(input.id) as Row | undefined;
    if (old && old.user_id !== input.userId) throw new Error('offer ownership conflict');
    const encoded = JSON.stringify(input);
    if (old?.input_json === encoded) return decode(old);
    const now = new Date().toISOString();
    if (old) {
      // Changed content requires a deliberate producer decision, never a
      // heartbeat overwriting an offer the person is reading or dismissed.
      throw new Error('offer already exists with different content; reconcile before publishing');
    }
    database.prepare(`INSERT INTO proactive_offers
      (id, user_id, revision, status, conversation_id, input_json, created_at, updated_at)
      VALUES (?, ?, 1, 'offered', NULL, ?, ?, ?)`).run(input.id, input.userId, encoded, now, now);
    database.prepare('INSERT INTO proactive_offer_revisions VALUES (?, 1, ?, ?)').run(input.id, encoded, now);
    return getProactiveOffer(input.id, input.userId)!;
  }).immediate();
}

export function listProactiveOffers(userId: string, now = new Date()): ProactiveOffer[] {
  const at = now.toISOString();
  return (db().prepare(`SELECT * FROM proactive_offers WHERE user_id = ?
    AND (status IN ('offered', 'discussing') OR (status = 'snoozed' AND julianday(snoozed_until) <= julianday(?)))
    AND (json_extract(input_json, '$.expiresAt') IS NULL OR julianday(json_extract(input_json, '$.expiresAt')) > julianday(?))
    ORDER BY updated_at DESC, id LIMIT 50`).all(userId, at, at) as Row[]).map(decode);
}

function requireRevision(id: string, revision: number, userId: string): ProactiveOffer {
  const offer = getProactiveOffer(id, userId);
  if (!offer) throw new Error('offer not found');
  if (offer.revision !== revision) throw new Error('offer revision conflict');
  return offer;
}

function requireAvailable(offer: ProactiveOffer, now: Date): void {
  if (offer.status === 'dismissed' || offer.status === 'withdrawn') throw new Error(`offer ${offer.status}`);
  if (offer.expiresAt && Date.parse(offer.expiresAt) <= now.getTime()) throw new Error('offer expired');
  if (offer.status === 'snoozed' && (!offer.snoozedUntil || Date.parse(offer.snoozedUntil) > now.getTime())) throw new Error('offer snoozed');
}

/** Explicit producer reconciliation. A wording change is not permission to
 * reopen a dismissed/snoozed offer or move an existing discussion. */
export function reviseProactiveOffer(raw: ProactiveOfferInput, expectedRevision: number): ProactiveOffer {
  const input = ProactiveOfferInput.parse(raw);
  input.evidenceRefs = [...new Set(input.evidenceRefs)].sort();
  const database = db();
  return database.transaction(() => {
    const current = requireRevision(input.id, expectedRevision, input.userId);
    if (current.status === 'withdrawn') throw new Error('offer withdrawn');
    if (current.originSessionId !== input.originSessionId || current.kind !== input.kind) throw new Error('offer scope conflict');
    const encoded = JSON.stringify(input);
    const row = database.prepare('SELECT input_json FROM proactive_offers WHERE id = ?').get(input.id) as { input_json: string };
    if (row.input_json === encoded) return current;
    const revision = current.revision + 1;
    const now = new Date().toISOString();
    database.prepare('UPDATE proactive_offers SET input_json = ?, revision = ?, updated_at = ? WHERE id = ?')
      .run(encoded, revision, now, input.id);
    database.prepare('INSERT INTO proactive_offer_revisions VALUES (?, ?, ?, ?)').run(input.id, revision, encoded, now);
    return getProactiveOffer(input.id, input.userId)!;
  }).immediate();
}

export function snoozeProactiveOffer(id: string, expectedRevision: number, userId: string, until: string, now = new Date()): ProactiveOffer {
  const target = z.string().datetime({ offset: true }).parse(until);
  if (Date.parse(target) <= now.getTime()) throw new Error('snooze must be in the future');
  const database = db();
  return database.transaction(() => {
    const offer = requireRevision(id, expectedRevision, userId);
    if (offer.status === 'dismissed' || offer.status === 'withdrawn') throw new Error(`offer ${offer.status}`);
    if (offer.expiresAt && Date.parse(offer.expiresAt) <= Date.parse(target)) throw new Error('offer expires before snooze ends');
    database.prepare(`UPDATE proactive_offers SET status = 'snoozed', snoozed_until = ?, updated_at = ? WHERE id = ?`)
      .run(new Date(target).toISOString(), now.toISOString(), id);
    return getProactiveOffer(id, userId)!;
  }).immediate();
}

/** Called by the producer when supporting evidence is no longer applicable. */
export function withdrawProactiveOffer(id: string, expectedRevision: number, userId: string, reason: string): ProactiveOffer {
  const note = nonempty.max(2000).parse(reason);
  const database = db();
  return database.transaction(() => {
    const offer = requireRevision(id, expectedRevision, userId);
    if (offer.status !== 'withdrawn') database.prepare(`UPDATE proactive_offers SET status = 'withdrawn', resolution_reason = ?, updated_at = ? WHERE id = ?`)
      .run(note, new Date().toISOString(), id);
    return getProactiveOffer(id, userId)!;
  }).immediate();
}

/** Authenticated route adapters must supply their established audience, not a
 * userId from the request body. Context is data for the normal chat ingress;
 * this function creates no synthetic user message or execution authority. */
export function discussProactiveOffer(id: string, expectedRevision: number, userId: string, now = new Date()): {
  sessionId: string; offer: ProactiveOffer;
} {
  const database = db();
  return database.transaction(() => {
    const offer = getProactiveOffer(id, userId);
    if (!offer) throw new Error('offer not found');
    if (offer.revision !== expectedRevision) throw new Error('offer revision conflict');
    requireAvailable(offer, now);
    if (offer.conversationId) {
      const bound = getSession(offer.conversationId);
      if (!bound || bound.userId !== userId || bound.kind !== 'chat') throw new Error('offer conversation unavailable');
      if (offer.status !== 'discussing') database.prepare("UPDATE proactive_offers SET status = 'discussing', snoozed_until = NULL, updated_at = ? WHERE id = ?")
        .run(now.toISOString(), id);
      return { sessionId: bound.id, offer: getProactiveOffer(id, userId)! };
    }
    const origin = offer.originSessionId ? getSession(offer.originSessionId) : null;
    if (origin && (origin.userId !== userId || origin.kind !== 'chat')) throw new Error('offer origin is not an owned chat');
    if (offer.originSessionId && !origin) throw new Error('offer origin unavailable');
    const sessionId = origin?.id ?? `sess-offer-${createHash('sha256').update(JSON.stringify([userId, id])).digest('hex')}`;
    if (!origin) {
      if (getSession(sessionId)) throw new Error('unbound offer conversation collision');
      createSession({ id: sessionId, kind: 'chat', userId, title: offer.title,
        metadata: { source: 'proactive-offer', proactiveOfferId: id } });
    }
    database.prepare(`UPDATE proactive_offers SET conversation_id = ?, status = 'discussing', snoozed_until = NULL, updated_at = ? WHERE id = ?`)
      .run(sessionId, new Date().toISOString(), id);
    return { sessionId, offer: getProactiveOffer(id, userId)! };
  }).immediate();
}

export function dismissProactiveOffer(id: string, expectedRevision: number, userId: string): ProactiveOffer {
  const database = db();
  return database.transaction(() => {
    const offer = getProactiveOffer(id, userId);
    if (!offer) throw new Error('offer not found');
    if (offer.revision !== expectedRevision) throw new Error('offer revision conflict');
    if (offer.status === 'withdrawn') throw new Error('offer withdrawn');
    if (offer.status !== 'dismissed') database.prepare(`UPDATE proactive_offers SET status = 'dismissed', updated_at = ? WHERE id = ?`)
      .run(new Date().toISOString(), id);
    return getProactiveOffer(id, userId)!;
  }).immediate();
}
