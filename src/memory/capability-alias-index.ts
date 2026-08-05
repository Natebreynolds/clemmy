/**
 * The capability alias index (v3.8.0/F1) — RETRIEVAL ONLY.
 *
 * This store answers one question: "which proven capabilities are worth
 * showing the brain for this request?" It never answers "what should run",
 * "with which arguments", or "on whose account". Those stay with the brain and
 * the governed dispatch boundary, which is why every row here is bounded,
 * scoped, and class-locked:
 *
 *   1. IMMUTABLE CLASS. A row is `capability_only` or `executable` at birth and
 *      can never change class. A capability learned from one verified read is
 *      evidence that a tool EXISTS for this kind of request; it is not, and can
 *      never be promoted into, an authorization to execute a stored call.
 *   2. PRIVACY BOUND. The accepted phrase itself is never stored — only its
 *      digest (for exact repeats) and a small set of bounded, filtered terms.
 *      Every read is partitioned by a scope digest, so a tenant, workspace, or
 *      account can never retrieve another's aliases.
 *   3. TAMPER EVIDENCE. Each row carries a digest over its own load-bearing
 *      fields. A row edited underneath us fails verification, is dropped, and
 *      reports a miss rather than serving forged routing evidence.
 *   4. STALE SCHEMA. A row whose provider contract has moved is excluded from
 *      retrieval until a fresh verified settlement re-records it.
 *
 * The vector column is an OPTIONAL accelerant: when the local embedding
 * provider is warm, semantic retrieval widens the candidate set to natural
 * paraphrases. When it is not, exact and lexical retrieval still work. Nothing
 * here blocks a turn on a model load.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { BASE_DIR } from '../config.js';
import { getMachineId } from '../runtime/machine-id.js';
import { bufferToVector, cosine, vectorToBuffer } from './embeddings.js';

/** How much of an accepted phrase may become retrievable lexical features. */
const MAX_ALIAS_TERMS = 12;
const MAX_TERM_LENGTH = 24;

const ALIAS_STOPWORDS = new Set([
  'the', 'and', 'for', 'you', 'your', 'please', 'can', 'could', 'would', 'what',
  'whats', 'that', 'this', 'with', 'from', 'have', 'has', 'are', 'was', 'were',
  'about', 'any', 'give', 'show', 'tell', 'get', 'find', 'look', 'need', 'want',
  'like', 'just', 'now', 'there', 'here', 'them', 'how', 'who', 'when', 'where',
  'why', 'did', 'does', 'let', 'lets', 'over', 'into', 'out', 'all',
]);

/** Normalize an accepted phrase for exact-repeat identity (never stored raw). */
export function normalizeAcceptedPhrase(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function acceptedPhraseDigest(text: string): string {
  return createHash('sha256').update(normalizeAcceptedPhrase(text), 'utf-8').digest('hex').slice(0, 24);
}

/**
 * A token that could carry personal or secret content rather than intent.
 * Normalization has already stripped punctuation, so an address or key arrives
 * here as its parts: what remains distinguishing is length, digit density, and
 * mixed alphanumerics. Intent words ("calendar", "tomorrow", "q3") pass; an
 * identifier, order number, token fragment, or long opaque string does not.
 */
function tokenLooksSensitive(token: string): boolean {
  const digits = (token.match(/[0-9]/g) ?? []).length;
  if (digits >= 5) return true;                               // ids, phone/order numbers
  if (digits > 0 && token.length >= 12) return true;          // long mixed alphanumerics
  if (token.length >= 20) return true;                        // opaque blobs
  return false;
}

/**
 * Bounded distinctive terms of an accepted phrase — the only lexical content
 * that becomes retrievable. Stopwords, sensitive-looking tokens, and anything
 * past the cap are dropped, so an alias can never become a copy of the message.
 */
export function boundedAliasTerms(text: string): string[] {
  return [...new Set((normalizeAcceptedPhrase(text).match(/[a-z0-9]+/g) ?? [])
    .filter((token) => token.length > 2
      && token.length <= MAX_TERM_LENGTH
      && !ALIAS_STOPWORDS.has(token)
      && !tokenLooksSensitive(token)))]
    .slice(0, MAX_ALIAS_TERMS);
}

export type CapabilityAliasClass = 'capability_only' | 'executable';

export type CapabilityAliasScope = {
  tenant?: string | null;
  workspace?: string | null;
  accountIdentity?: string | null;
};

export type CapabilityAliasRow = {
  aliasDigest: string;
  scopeDigest: string;
  intent: string;
  kind: string;
  identifier: string;
  klass: CapabilityAliasClass;
  terms: string[];
  schemaFingerprint: string | null;
  embeddingSpace: string | null;
  createdAt: string;
  updatedAt: string;
};

export type CapabilityAliasWrite =
  | { stored: true; row: CapabilityAliasRow }
  | { stored: false; reason: string };

let handle: Database.Database | null = null;
let handlePath = '';

function db(): Database.Database {
  const dir = path.join(BASE_DIR, 'memory', 'capability-aliases', getMachineId());
  const file = path.join(dir, 'aliases.db');
  if (handle && handlePath === file) return handle;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  handle = new Database(file);
  handlePath = file;
  handle.pragma('journal_mode = WAL');
  handle.exec(`
    CREATE TABLE IF NOT EXISTS aliases (
      alias_digest       TEXT NOT NULL,
      scope_digest       TEXT NOT NULL,
      intent             TEXT NOT NULL,
      kind               TEXT NOT NULL,
      identifier         TEXT NOT NULL,
      klass              TEXT NOT NULL CHECK (klass IN ('capability_only', 'executable')),
      terms              TEXT NOT NULL,
      schema_fingerprint TEXT,
      embedding          BLOB,
      embedding_space    TEXT,
      created_at         TEXT NOT NULL,
      updated_at         TEXT NOT NULL,
      row_digest         TEXT NOT NULL,
      PRIMARY KEY (alias_digest, scope_digest)
    );
    CREATE INDEX IF NOT EXISTS aliases_by_scope ON aliases (scope_digest);
    CREATE TABLE IF NOT EXISTS alias_claims (
      session_id      TEXT NOT NULL,
      source_user_seq INTEGER NOT NULL,
      identifier      TEXT NOT NULL,
      claimed_at      TEXT NOT NULL,
      PRIMARY KEY (session_id, source_user_seq, identifier)
    );
  `);
  return handle;
}

/** Test hook: drop the handle so a fresh CLEMENTINE_HOME opens its own file. */
export function closeCapabilityAliasIndexForTests(): void {
  handle?.close();
  handle = null;
  handlePath = '';
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

/** The privacy partition. Every read and write is bound to exactly one. */
export function aliasScopeDigest(scope: CapabilityAliasScope | undefined): string {
  return sha256(JSON.stringify({
    tenant: scope?.tenant ?? '',
    workspace: scope?.workspace ?? '',
    account: scope?.accountIdentity ?? '',
  })).slice(0, 40);
}

/** Tamper evidence over exactly the fields retrieval trusts. */
function rowDigest(row: {
  aliasDigest: string; scopeDigest: string; intent: string; kind: string;
  identifier: string; klass: string; terms: string[]; schemaFingerprint: string | null;
}): string {
  return sha256(JSON.stringify([
    row.aliasDigest, row.scopeDigest, row.intent, row.kind,
    row.identifier, row.klass, row.terms, row.schemaFingerprint ?? '',
  ])).slice(0, 40);
}

type RawRow = {
  alias_digest: string; scope_digest: string; intent: string; kind: string;
  identifier: string; klass: string; terms: string; schema_fingerprint: string | null;
  embedding: Buffer | null; embedding_space: string | null;
  created_at: string; updated_at: string; row_digest: string;
};

function hydrate(raw: RawRow): CapabilityAliasRow | null {
  let terms: string[];
  try {
    const parsed: unknown = JSON.parse(raw.terms);
    if (!Array.isArray(parsed) || parsed.some((t) => typeof t !== 'string')) return null;
    terms = parsed as string[];
  } catch {
    return null;
  }
  if (raw.klass !== 'capability_only' && raw.klass !== 'executable') return null;
  const row: CapabilityAliasRow = {
    aliasDigest: raw.alias_digest,
    scopeDigest: raw.scope_digest,
    intent: raw.intent,
    kind: raw.kind,
    identifier: raw.identifier,
    klass: raw.klass,
    terms,
    schemaFingerprint: raw.schema_fingerprint,
    embeddingSpace: raw.embedding_space,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
  };
  if (rowDigest(row) !== raw.row_digest) return null; // tampered or torn
  return row;
}

/** A row that fails verification is removed, so the next read is a clean miss
 *  rather than a permanent poisoned hit. */
function dropRow(aliasDigest: string, scopeDigest: string): void {
  try {
    db().prepare('DELETE FROM aliases WHERE alias_digest = ? AND scope_digest = ?')
      .run(aliasDigest, scopeDigest);
  } catch { /* a failed cleanup must never fail a turn */ }
}

/**
 * Record (or refresh) one alias. The class is fixed at birth: an existing row
 * of a different class REFUSES rather than being silently upgraded, which is
 * what keeps "we know a tool for this" from ever becoming "run this call".
 */
export function recordCapabilityAlias(input: {
  aliasDigest: string;
  scope?: CapabilityAliasScope;
  intent: string;
  kind: string;
  identifier: string;
  klass: CapabilityAliasClass;
  terms: string[];
  schemaFingerprint?: string | null;
  now?: string;
}): CapabilityAliasWrite {
  const aliasDigest = input.aliasDigest.trim();
  const intent = input.intent.trim();
  const identifier = input.identifier.trim();
  if (!aliasDigest) return { stored: false, reason: 'no alias digest' };
  if (!intent) return { stored: false, reason: 'no intent' };
  if (!identifier) return { stored: false, reason: 'no identifier' };
  const scopeDigest = aliasScopeDigest(input.scope);
  const terms = input.terms.filter((t) => typeof t === 'string' && t.length > 0);
  const now = input.now ?? new Date().toISOString();
  const schemaFingerprint = input.schemaFingerprint?.trim() || null;

  const candidate: CapabilityAliasRow = {
    aliasDigest, scopeDigest, intent, kind: input.kind, identifier,
    klass: input.klass, terms, schemaFingerprint,
    embeddingSpace: null, createdAt: now, updatedAt: now,
  };

  try {
    const database = db();
    const write = database.transaction((): CapabilityAliasWrite => {
      const existing = database.prepare(
        'SELECT * FROM aliases WHERE alias_digest = ? AND scope_digest = ?',
      ).get(aliasDigest, scopeDigest) as RawRow | undefined;
      if (existing && existing.klass !== input.klass) {
        return { stored: false, reason: `alias class is immutable (stored ${existing.klass})` };
      }
      const createdAt = existing?.created_at ?? now;
      const row = { ...candidate, createdAt };
      // A re-recording under a changed contract invalidates the old vector: the
      // embedding is keyed to the terms, not to the row identity.
      const keepEmbedding = existing && existing.terms === JSON.stringify(terms);
      database.prepare(`
        INSERT INTO aliases (
          alias_digest, scope_digest, intent, kind, identifier, klass, terms,
          schema_fingerprint, embedding, embedding_space, created_at, updated_at, row_digest
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (alias_digest, scope_digest) DO UPDATE SET
          intent = excluded.intent, kind = excluded.kind, identifier = excluded.identifier,
          terms = excluded.terms, schema_fingerprint = excluded.schema_fingerprint,
          embedding = excluded.embedding, embedding_space = excluded.embedding_space,
          updated_at = excluded.updated_at, row_digest = excluded.row_digest
      `).run(
        aliasDigest, scopeDigest, intent, input.kind, identifier, input.klass,
        JSON.stringify(terms), schemaFingerprint,
        keepEmbedding ? existing.embedding : null,
        keepEmbedding ? existing.embedding_space : null,
        createdAt, now, rowDigest(row),
      );
      return { stored: true, row };
    });
    return write();
  } catch (err) {
    return { stored: false, reason: err instanceof Error ? err.message : String(err) };
  }
}

function schemaIsCurrent(row: CapabilityAliasRow, live: string | null | undefined): boolean {
  if (!live || !row.schemaFingerprint) return true;
  return row.schemaFingerprint === live;
}

/** Exact repeat of a phrase that already settled successfully. */
export function lookupExactCapabilityAlias(
  aliasDigest: string,
  options: { scope?: CapabilityAliasScope; liveSchemaFingerprint?: string | null } = {},
): CapabilityAliasRow | null {
  if (!aliasDigest) return null;
  const scopeDigest = aliasScopeDigest(options.scope);
  let raw: RawRow | undefined;
  try {
    raw = db().prepare('SELECT * FROM aliases WHERE alias_digest = ? AND scope_digest = ?')
      .get(aliasDigest, scopeDigest) as RawRow | undefined;
  } catch {
    return null;
  }
  if (!raw) return null;
  const row = hydrate(raw);
  if (!row) { dropRow(aliasDigest, scopeDigest); return null; }
  if (!schemaIsCurrent(row, options.liveSchemaFingerprint)) return null;
  return row;
}

export type SemanticAliasHit = { row: CapabilityAliasRow; score: number };

/**
 * Bounded semantic retrieval over one scope. The caller owns the query vector,
 * so this stays synchronous and this module never loads a model on a hot path.
 * The floor and the top-K cap are the whole safety story: an unrelated question
 * clears neither, so ordinary chat retrieves nothing and pays nothing.
 */
export function semanticCapabilityAliases(
  queryVector: Float32Array,
  options: {
    scope?: CapabilityAliasScope;
    embeddingSpace: string;
    limit?: number;
    floor?: number;
    liveSchemaFingerprint?: string | null;
  },
): SemanticAliasHit[] {
  const scopeDigest = aliasScopeDigest(options.scope);
  const limit = Math.max(1, Math.min(options.limit ?? 5, 25));
  const floor = options.floor ?? DEFAULT_SEMANTIC_FLOOR;
  let raws: RawRow[];
  try {
    raws = db().prepare(
      'SELECT * FROM aliases WHERE scope_digest = ? AND embedding IS NOT NULL AND embedding_space = ?',
    ).all(scopeDigest, options.embeddingSpace) as RawRow[];
  } catch {
    return [];
  }
  const hits: SemanticAliasHit[] = [];
  for (const raw of raws) {
    const row = hydrate(raw);
    if (!row) { dropRow(raw.alias_digest, raw.scope_digest); continue; }
    if (!schemaIsCurrent(row, options.liveSchemaFingerprint)) continue;
    if (!raw.embedding) continue;
    let score: number;
    try {
      score = cosine(queryVector, bufferToVector(raw.embedding));
    } catch {
      continue;
    }
    if (!Number.isFinite(score) || score < floor) continue;
    hits.push({ row, score });
  }
  hits.sort((a, b) => b.score - a.score);
  return hits.slice(0, limit);
}

/**
 * The retrieval floor for the bundled local model. bge-small puts genuinely
 * unrelated English around 0.55-0.60, and a real paraphrase of the same request
 * well above 0.75, so the floor sits above the unrelated band with margin
 * rather than at a hopeful midpoint. Retrieval is advisory: a miss costs one
 * ordinary cold turn, so the floor is deliberately on the strict side.
 */
export const DEFAULT_SEMANTIC_FLOOR = 0.70;

/** Rows still waiting for a vector in the CURRENT embedding space. */
export function aliasRowsMissingEmbedding(
  embeddingSpace: string,
  options: { scope?: CapabilityAliasScope; limit?: number } = {},
): CapabilityAliasRow[] {
  const limit = Math.max(1, Math.min(options.limit ?? 32, 256));
  let raws: RawRow[];
  try {
    const database = db();
    raws = options.scope
      ? database.prepare(
        'SELECT * FROM aliases WHERE scope_digest = ? AND (embedding IS NULL OR embedding_space IS NOT ?) LIMIT ?',
      ).all(aliasScopeDigest(options.scope), embeddingSpace, limit) as RawRow[]
      : database.prepare(
        'SELECT * FROM aliases WHERE embedding IS NULL OR embedding_space IS NOT ? LIMIT ?',
      ).all(embeddingSpace, limit) as RawRow[];
  } catch {
    return [];
  }
  const rows: CapabilityAliasRow[] = [];
  for (const raw of raws) {
    const row = hydrate(raw);
    if (!row) { dropRow(raw.alias_digest, raw.scope_digest); continue; }
    rows.push(row);
  }
  return rows;
}

/** Attach a vector. Never changes a load-bearing field, so the row digest —
 *  and therefore what retrieval trusts — is unaffected. */
export function attachCapabilityAliasEmbedding(
  aliasDigest: string,
  scope: CapabilityAliasScope | undefined,
  vector: Float32Array,
  embeddingSpace: string,
): boolean {
  try {
    const result = db().prepare(
      'UPDATE aliases SET embedding = ?, embedding_space = ? WHERE alias_digest = ? AND scope_digest = ?',
    ).run(vectorToBuffer(vector), embeddingSpace, aliasDigest, aliasScopeDigest(scope));
    return result.changes > 0;
  } catch {
    return false;
  }
}

/** Every alias in one scope — the lexical tier and diagnostics read this. */
export function listCapabilityAliases(
  options: { scope?: CapabilityAliasScope; limit?: number } = {},
): CapabilityAliasRow[] {
  const limit = Math.max(1, Math.min(options.limit ?? 200, 2000));
  let raws: RawRow[];
  try {
    raws = db().prepare(
      'SELECT * FROM aliases WHERE scope_digest = ? ORDER BY updated_at DESC LIMIT ?',
    ).all(aliasScopeDigest(options.scope), limit) as RawRow[];
  } catch {
    return [];
  }
  const rows: CapabilityAliasRow[] = [];
  for (const raw of raws) {
    const row = hydrate(raw);
    if (!row) { dropRow(raw.alias_digest, raw.scope_digest); continue; }
    rows.push(row);
  }
  return rows;
}

/**
 * Exactly-once ownership of an accepted source. Two settlements racing for the
 * same {sessionId, sourceUserSeq, identifier} — a retry, a replayed transport
 * frame, a duplicated observer — must produce ONE learning event, and the
 * loser must know it lost. The durable primary key decides, not a timestamp.
 */
export function claimAcceptedSourceForLearning(input: {
  sessionId: string;
  sourceUserSeq: number;
  identifier: string;
  now?: string;
}): boolean {
  if (!input.sessionId || !Number.isInteger(input.sourceUserSeq) || !input.identifier) return false;
  try {
    const result = db().prepare(
      'INSERT OR IGNORE INTO alias_claims (session_id, source_user_seq, identifier, claimed_at) VALUES (?, ?, ?, ?)',
    ).run(input.sessionId, input.sourceUserSeq, input.identifier, input.now ?? new Date().toISOString());
    return result.changes > 0;
  } catch {
    return false;
  }
}
