/**
 * Named account aliases — the durable "this is my scorpion email" memory.
 *
 * A user with multiple connected accounts of one toolkit (5 mailboxes, several
 * Slack workspaces, …) names them conversationally; the binding lives HERE as a
 * deterministic record the composio gateway consumes at resolution time — not
 * as a prompt rule that rots. Bindings are keyed by the STABLE identity (the
 * mailbox email, learned via profile probe) and re-attach across re-auths (a
 * re-auth mints a new connection id; the email survives). The connection id is
 * stored only as a hint for accounts whose email is unknowable.
 *
 * Consumed by:
 *  - the gateway's owner resolution: `account_alias:"scorpion"` (meta-arg on
 *    composio_execute_tool) → this store → email → live connection
 *  - the ambiguous-ASK renderer: candidates show their names
 * Written by:
 *  - the gateway, when the model passes `account_alias` together with a pinned
 *    `connected_account_id` (the "remember this one" gesture)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';

export interface AccountAlias {
  /** Toolkit slug (lowercase), e.g. 'outlook'. */
  toolkit: string;
  /** Normalized label, e.g. 'scorpion'. */
  label: string;
  /** Stable mailbox identity (normalized email) when known — the primary key
   *  for re-attachment across re-auths. */
  email?: string;
  /** Connection hint — the connection this alias was bound to at save time. */
  connectionId?: string;
  createdAt: string;
  updatedAt: string;
}

interface AliasFile {
  aliases?: AccountAlias[];
}

const FILE_REL = ['memory', 'account-aliases.json'] as const;

let cache: AccountAlias[] | null = null;

function filePath(): string {
  return path.join(BASE_DIR, ...FILE_REL);
}

function normalizeLabel(label: string): string {
  return label.trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeEmail(value: unknown): string | undefined {
  const t = String(value ?? '').trim().toLowerCase().replace(/^smtp:/, '');
  return t && t.includes('@') && !/^ca_/i.test(t) ? t : undefined;
}

function load(): AccountAlias[] {
  if (cache) return cache;
  try {
    if (existsSync(filePath())) {
      const parsed = JSON.parse(readFileSync(filePath(), 'utf-8')) as AliasFile;
      cache = Array.isArray(parsed.aliases) ? parsed.aliases : [];
      return cache;
    }
  } catch { /* corrupted file → start fresh (aliases are re-learnable) */ }
  cache = [];
  return cache;
}

function persist(): void {
  try {
    mkdirSync(path.dirname(filePath()), { recursive: true });
    writeFileSync(filePath(), `${JSON.stringify({ aliases: load() }, null, 1)}\n`, 'utf-8');
  } catch { /* best-effort */ }
}

/** Create/update a named binding. A new email for an existing (toolkit,label)
 *  overwrites it (the user re-pointed the name). Returns the saved record. */
export function rememberAccountAlias(input: {
  toolkit: string;
  label: string;
  email?: string;
  connectionId?: string;
}): AccountAlias | null {
  const toolkit = input.toolkit.trim().toLowerCase();
  const label = normalizeLabel(input.label);
  if (!toolkit || !label) return null;
  const email = normalizeEmail(input.email);
  const connectionId = input.connectionId?.trim() || undefined;
  if (!email && !connectionId) return null; // nothing stable to bind to
  const now = new Date().toISOString();
  const aliases = load();
  const existing = aliases.find((a) => a.toolkit === toolkit && a.label === label);
  if (existing) {
    if (connectionId && connectionId !== existing.connectionId) {
      // Re-pointed to a DIFFERENT connection: the stored email described the OLD
      // account, so it must not linger (resolution prefers email over
      // connectionId — a stale email would route the name back to the old
      // mailbox). Set the new email if known, else clear it and fall back to the
      // new connectionId until a probe learns the new mailbox.
      existing.email = email;
      existing.connectionId = connectionId;
    } else {
      if (email) existing.email = email;
      if (connectionId) existing.connectionId = connectionId;
    }
    existing.updatedAt = now;
    persist();
    return existing;
  }
  const record: AccountAlias = { toolkit, label, email, connectionId, createdAt: now, updatedAt: now };
  aliases.push(record);
  persist();
  return record;
}

/** Look up a name. Exact label first, then a WHOLE-WORD match so "my scorpion
 *  email" resolves the label "scorpion" — but "s" never matches "scorpion" and
 *  an unrelated request never binds a substring alias. A multi-word label must
 *  have all its words present. Ambiguous (2+ labels match) → undefined so the
 *  gateway ASKS rather than routing (a send) to an arbitrary account. */
export function resolveAccountAlias(labelish: string, toolkit?: string): AccountAlias | undefined {
  const wanted = normalizeLabel(labelish);
  if (!wanted) return undefined;
  const tk = toolkit?.trim().toLowerCase();
  const pool = load().filter((a) => !tk || a.toolkit === tk);
  const exact = pool.find((a) => a.label === wanted);
  if (exact) return exact;
  // Whole-word containment ONLY (no bidirectional substring): every token of a
  // saved label must appear as a whole word in the request. Guards against both
  // the "s"→"scorpion" (request-substring-of-label) and unrelated-substring bugs.
  const requestWords = new Set(wanted.split(/[^a-z0-9]+/i).filter(Boolean));
  const matches = pool.filter((a) => {
    const labelWords = a.label.split(/[^a-z0-9]+/i).filter((w) => w.length >= 2);
    return labelWords.length > 0 && labelWords.every((w) => requestWords.has(w));
  });
  return matches.length === 1 ? matches[0] : undefined;
}

/** UI entry point: set (or CLEAR, when label is empty) the single user label for
 *  one specific connected account. Unlike the conversational `rememberAccountAlias`
 *  gesture, this enforces one-label-per-account: any existing label bound to this
 *  same account (by email or connectionId) is dropped first, so renaming from the
 *  desktop UI never leaves an account carrying two names. Pass the account's email
 *  (from the connections snapshot) so the binding is stable across re-auths. */
export function setAccountLabel(input: {
  toolkit: string;
  label: string;
  email?: string;
  connectionId?: string;
}): AccountAlias | null {
  const toolkit = input.toolkit.trim().toLowerCase();
  const email = normalizeEmail(input.email);
  const connectionId = input.connectionId?.trim() || undefined;
  if (!toolkit || (!email && !connectionId)) return null;
  const aliases = load();
  // Drop any label(s) already bound to THIS account so it never carries two.
  const filtered = aliases.filter((a) => !(
    a.toolkit === toolkit && ((email && a.email === email) || (connectionId && a.connectionId === connectionId))
  ));
  if (filtered.length !== aliases.length) cache = filtered;
  const label = normalizeLabel(input.label);
  if (!label) { persist(); return null; } // empty label = clear
  return rememberAccountAlias({ toolkit, label, email, connectionId });
}

/** All aliases for a toolkit (for rendering names into the ambiguous ASK). */
export function listAccountAliases(toolkit?: string): AccountAlias[] {
  const tk = toolkit?.trim().toLowerCase();
  return load().filter((a) => !tk || a.toolkit === tk).map((a) => ({ ...a }));
}

/** The alias label for a given mailbox/connection, for display. */
export function aliasLabelFor(toolkit: string, email?: string, connectionId?: string): string | undefined {
  const tk = toolkit.trim().toLowerCase();
  const em = normalizeEmail(email);
  return load().find((a) =>
    a.toolkit === tk && ((em && a.email === em) || (connectionId && a.connectionId === connectionId)),
  )?.label;
}

/** Test seam. */
export function resetAccountAliasesForTest(): void {
  cache = null;
}
