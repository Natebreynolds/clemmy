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
    if (email) existing.email = email;
    if (connectionId) existing.connectionId = connectionId;
    existing.updatedAt = now;
    persist();
    return existing;
  }
  const record: AccountAlias = { toolkit, label, email, connectionId, createdAt: now, updatedAt: now };
  aliases.push(record);
  persist();
  return record;
}

/** Look up a name. Exact label first, then a contains-match so "my scorpion
 *  email" still resolves the label "scorpion". Toolkit narrows when given. */
export function resolveAccountAlias(labelish: string, toolkit?: string): AccountAlias | undefined {
  const wanted = normalizeLabel(labelish);
  if (!wanted) return undefined;
  const tk = toolkit?.trim().toLowerCase();
  const pool = load().filter((a) => !tk || a.toolkit === tk);
  return (
    pool.find((a) => a.label === wanted)
    ?? pool.find((a) => wanted.includes(a.label) || a.label.includes(wanted))
  );
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
