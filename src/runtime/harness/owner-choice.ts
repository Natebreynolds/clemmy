import { randomBytes } from 'node:crypto';
import { listEvents } from './eventlog.js';

/**
 * A choice the owner tapped on something Clem asked them on Home ("Accept",
 * "Decline"). The tap is the owner's approval of exactly that action (owner
 * 2026-10-09: "Tap is the approval"), so the consent gate may proceed on the
 * one call that carries it out instead of asking a second time.
 *
 * Only the host mints it: the From Clem reply path checks the tapped text
 * against the choices the host itself showed for the version the owner saw,
 * then hands the bridge a one-time token. The bridge writes the redeemed
 * choice into the accepted source's own user_input_received event, so the
 * consent gate reads it from the ledger, never from a request field a
 * caller could set or from anything the model says.
 */
export interface OwnerChoiceV1 {
  version: 1;
  /** The From Clem row the owner answered. */
  rowKey: string;
  /** The version of the row the owner saw. */
  voiceDigest: string;
  /** What Clem asked, in her words. */
  said: string;
  /** The facts behind the item. */
  facts: string;
  /** The choice the owner tapped, exactly as shown. */
  choice: string;
  /** Identifiers the item is about (an event id, an account), when it has them. */
  ref?: Record<string, string>;
  tappedAt: string;
}

const TOKEN_TTL_MS = 10 * 60_000;
const minted = new Map<string, { choice: OwnerChoiceV1; at: number }>();

/** The host's one-time hand-off of a verified tap to the bridge. */
export function mintOwnerChoiceToken(choice: Omit<OwnerChoiceV1, 'version' | 'tappedAt'>, nowMs = Date.now()): string {
  for (const [token, entry] of minted) if (nowMs - entry.at > TOKEN_TTL_MS) minted.delete(token);
  const token = randomBytes(24).toString('hex');
  minted.set(token, {
    choice: Object.freeze({ version: 1 as const, ...choice, tappedAt: new Date(nowMs).toISOString() }),
    at: nowMs,
  });
  return token;
}

/** Redeem a token once; an unknown, spent or stale token is nothing. */
export function redeemOwnerChoiceToken(token: unknown, nowMs = Date.now()): OwnerChoiceV1 | null {
  if (typeof token !== 'string') return null;
  const entry = minted.get(token);
  minted.delete(token);
  if (!entry || nowMs - entry.at > TOKEN_TTL_MS) return null;
  return entry.choice;
}

function parseOwnerChoice(value: unknown): OwnerChoiceV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const text = (key: string) => (typeof record[key] === 'string' ? record[key] as string : null);
  if (record.version !== 1) return null;
  const rowKey = text('rowKey'); const voiceDigest = text('voiceDigest'); const said = text('said');
  const facts = text('facts'); const choice = text('choice'); const tappedAt = text('tappedAt');
  if (!rowKey || !voiceDigest || !said || facts === null || !choice || !tappedAt) return null;
  const ref = record.ref && typeof record.ref === 'object' && !Array.isArray(record.ref)
    ? Object.fromEntries(Object.entries(record.ref as Record<string, unknown>)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
    : undefined;
  return { version: 1, rowKey, voiceDigest, said, facts, choice, ...(ref && Object.keys(ref).length ? { ref } : {}), tappedAt };
}

/** The tapped choice an accepted source carries, from its own ledger event. */
export function ownerChoiceForSource(sessionId: string, sourceUserSeq: number): OwnerChoiceV1 | null {
  try {
    const source = listEvents(sessionId, { types: ['user_input_received'], sinceSeq: sourceUserSeq - 1, limit: 1 })
      .find((event) => event.seq === sourceUserSeq);
    if (!source || source.role !== 'user') return null;
    return parseOwnerChoice(source.data.ownerChoice);
  } catch {
    return null;
  }
}
