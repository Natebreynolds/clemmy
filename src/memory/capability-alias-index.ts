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
import {
  bufferToVector,
  cosine,
  getLocalEmbeddingProvider,
  localEmbeddingSpaceKey,
  vectorToBuffer,
} from './embeddings.js';

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
 * Spans that carry a PARTICULAR person, place, or secret rather than an intent.
 *
 * These must be removed BEFORE normalization: once punctuation is gone,
 * "dana.wexler@northwind-industries.com" is indistinguishable from five
 * ordinary words, and each of those words would become a retrievable feature.
 * Structure is the evidence, so it is read while it still exists.
 */
const SENSITIVE_SPANS: RegExp[] = [
  /\S+@\S+/g,                          // addresses
  /\b[a-z][a-z0-9+.-]*:\/\/\S+/gi,      // URLs
  /\b[\w-]+(?:\.[\w-]+)+\b/g,          // bare hosts and dotted identifiers
  /\b[A-Za-z0-9_-]{16,}\b/g,           // keys, tokens, opaque ids
  /\b\d{4,}\b/g,                       // account, order, and phone numbers
];

function stripSensitiveSpans(text: string): string {
  let out = text;
  for (const pattern of SENSITIVE_SPANS) out = out.replace(pattern, ' ');
  return out;
}

/**
 * A token that could still carry personal or secret content once the
 * structured spans above are gone: what remains distinguishing is length and
 * digit density. Intent words ("calendar", "tomorrow", "q3") pass.
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
  return [...new Set((normalizeAcceptedPhrase(stripSensitiveSpans(text)).match(/[a-z0-9]+/g) ?? [])
    .filter((token) => token.length > 2
      && token.length <= MAX_TERM_LENGTH
      && !ALIAS_STOPWORDS.has(token)
      && !tokenLooksSensitive(token)))]
    .slice(0, MAX_ALIAS_TERMS);
}

export type CapabilityAliasClass = 'capability_only' | 'executable';

/**
 * The PRIVACY PARTITION for retrieval: which installation/workspace may ever
 * see a row. The connected ACCOUNT is deliberately not part of the partition —
 * at retrieval time nobody has chosen an account yet, and retrieval choosing
 * one would be authority. Account identity rides ON each row as provenance the
 * brain can read.
 */
export type CapabilityAliasScope = {
  tenant?: string | null;
  workspace?: string | null;
};

/** The daemon's own durable identity partition: this machine, this home. */
export function daemonAliasScope(): CapabilityAliasScope {
  return { tenant: getMachineId(), workspace: BASE_DIR };
}

export type CapabilityAliasRow = {
  aliasDigest: string;
  scopeDigest: string;
  intent: string;
  kind: string;
  identifier: string;
  /** The stable account this capability was PROVEN against ('' = unbound). */
  accountIdentity: string;
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
  // One row per (phrase, scope, identifier, account): a multi-read turn keeps
  // EVERY capability it proved, and the same phrase proven against two
  // accounts keeps both provenances. The earlier one-row-per-phrase shape is
  // rebuilt in place — its rows are re-learnable evidence, not user data.
  const legacy = handle.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'aliases'",
  ).get() as { n: number };
  if (legacy.n > 0) {
    const columns = (handle.prepare('PRAGMA table_info(aliases)').all() as Array<{ name: string }>)
      .map((c) => c.name);
    if (!columns.includes('account_identity')) handle.exec('DROP TABLE aliases');
  }
  const legacyClaims = handle.prepare(
    "SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'alias_claims'",
  ).get() as { n: number };
  if (legacyClaims.n > 0) {
    const claimColumns = (handle.prepare('PRAGMA table_info(alias_claims)').all() as Array<{ name: string }>)
      .map((c) => c.name);
    if (!claimColumns.includes('account_identity')) handle.exec('DROP TABLE alias_claims');
  }
  handle.exec(`
    CREATE TABLE IF NOT EXISTS aliases (
      alias_digest       TEXT NOT NULL,
      scope_digest       TEXT NOT NULL,
      intent             TEXT NOT NULL,
      kind               TEXT NOT NULL,
      identifier         TEXT NOT NULL,
      account_identity   TEXT NOT NULL DEFAULT '',
      klass              TEXT NOT NULL CHECK (klass IN ('capability_only', 'executable')),
      terms              TEXT NOT NULL,
      schema_fingerprint TEXT,
      embedding          BLOB,
      embedding_space    TEXT,
      created_at         TEXT NOT NULL,
      updated_at         TEXT NOT NULL,
      row_digest         TEXT NOT NULL,
      PRIMARY KEY (alias_digest, scope_digest, identifier, account_identity)
    );
    CREATE INDEX IF NOT EXISTS aliases_by_scope ON aliases (scope_digest);
    CREATE TABLE IF NOT EXISTS alias_claims (
      session_id       TEXT NOT NULL,
      source_user_seq  INTEGER NOT NULL,
      identifier       TEXT NOT NULL,
      account_identity TEXT NOT NULL DEFAULT '',
      claimed_at       TEXT NOT NULL,
      PRIMARY KEY (session_id, source_user_seq, identifier, account_identity)
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
  })).slice(0, 40);
}

/** Tamper evidence over exactly the fields retrieval trusts. */
function rowDigest(row: {
  aliasDigest: string; scopeDigest: string; intent: string; kind: string;
  identifier: string; accountIdentity: string; klass: string; terms: string[];
  schemaFingerprint: string | null;
}): string {
  return sha256(JSON.stringify([
    row.aliasDigest, row.scopeDigest, row.intent, row.kind, row.identifier,
    row.accountIdentity, row.klass, row.terms, row.schemaFingerprint ?? '',
  ])).slice(0, 40);
}

type RawRow = {
  alias_digest: string; scope_digest: string; intent: string; kind: string;
  identifier: string; account_identity: string; klass: string; terms: string;
  schema_fingerprint: string | null;
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
    accountIdentity: raw.account_identity,
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
function dropRow(raw: Pick<RawRow, 'alias_digest' | 'scope_digest' | 'identifier' | 'account_identity'>): void {
  try {
    db().prepare(
      'DELETE FROM aliases WHERE alias_digest = ? AND scope_digest = ? AND identifier = ? AND account_identity = ?',
    ).run(raw.alias_digest, raw.scope_digest, raw.identifier, raw.account_identity);
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
  /** The stable account the settlement was proven against (never a rotating
   *  connection id). Part of the row identity: two accounts, two rows. */
  accountIdentity?: string | null;
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
  const accountIdentity = input.accountIdentity?.trim() ?? '';
  const terms = input.terms.filter((t) => typeof t === 'string' && t.length > 0);
  const now = input.now ?? new Date().toISOString();
  const schemaFingerprint = input.schemaFingerprint?.trim() || null;

  const candidate: CapabilityAliasRow = {
    aliasDigest, scopeDigest, intent, kind: input.kind, identifier, accountIdentity,
    klass: input.klass, terms, schemaFingerprint,
    embeddingSpace: null, createdAt: now, updatedAt: now,
  };

  try {
    const database = db();
    const write = database.transaction((): CapabilityAliasWrite => {
      const existing = database.prepare(
        'SELECT * FROM aliases WHERE alias_digest = ? AND scope_digest = ? AND identifier = ? AND account_identity = ?',
      ).get(aliasDigest, scopeDigest, identifier, accountIdentity) as RawRow | undefined;
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
          alias_digest, scope_digest, intent, kind, identifier, account_identity, klass, terms,
          schema_fingerprint, embedding, embedding_space, created_at, updated_at, row_digest
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (alias_digest, scope_digest, identifier, account_identity) DO UPDATE SET
          intent = excluded.intent, kind = excluded.kind,
          terms = excluded.terms, schema_fingerprint = excluded.schema_fingerprint,
          embedding = excluded.embedding, embedding_space = excluded.embedding_space,
          updated_at = excluded.updated_at, row_digest = excluded.row_digest
      `).run(
        aliasDigest, scopeDigest, intent, input.kind, identifier, accountIdentity, input.klass,
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

/**
 * Exact repeat of a phrase that already settled successfully. Returns EVERY
 * capability the phrase proved (a brief can prove several; the same phrase
 * can be proven against several accounts) — choosing among them is the
 * brain's job, never retrieval's.
 */
export function lookupExactCapabilityAliases(
  aliasDigest: string,
  options: {
    scope?: CapabilityAliasScope;
    /** identifier -> live fingerprint. A row whose stored contract differs
     *  from the live one for ITS identifier is excluded. */
    liveSchemaFingerprintFor?: (identifier: string) => string | null | undefined;
  } = {},
): CapabilityAliasRow[] {
  if (!aliasDigest) return [];
  const scopeDigest = aliasScopeDigest(options.scope);
  let raws: RawRow[];
  try {
    raws = db().prepare('SELECT * FROM aliases WHERE alias_digest = ? AND scope_digest = ?')
      .all(aliasDigest, scopeDigest) as RawRow[];
  } catch {
    return [];
  }
  const rows: CapabilityAliasRow[] = [];
  for (const raw of raws) {
    const row = hydrate(raw);
    if (!row) { dropRow(raw); continue; }
    if (!schemaIsCurrent(row, options.liveSchemaFingerprintFor?.(row.identifier))) continue;
    rows.push(row);
  }
  return rows;
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
    liveSchemaFingerprintFor?: (identifier: string) => string | null | undefined;
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
    if (!row) { dropRow(raw); continue; }
    if (!schemaIsCurrent(row, options.liveSchemaFingerprintFor?.(row.identifier))) continue;
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
    if (!row) { dropRow(raw); continue; }
    rows.push(row);
  }
  return rows;
}

/** Attach a vector. Never changes a load-bearing field, so the row digest —
 *  and therefore what retrieval trusts — is unaffected. */
export function attachCapabilityAliasEmbedding(
  row: Pick<CapabilityAliasRow, 'aliasDigest' | 'scopeDigest' | 'identifier' | 'accountIdentity'>,
  vector: Float32Array,
  embeddingSpace: string,
): boolean {
  try {
    const result = db().prepare(
      'UPDATE aliases SET embedding = ?, embedding_space = ? WHERE alias_digest = ? AND scope_digest = ? AND identifier = ? AND account_identity = ?',
    ).run(vectorToBuffer(vector), embeddingSpace, row.aliasDigest, row.scopeDigest, row.identifier, row.accountIdentity);
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
    if (!row) { dropRow(raw); continue; }
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
  /** A settlement against a DIFFERENT account is a different settlement — a
   *  brief that read two mailboxes teaches both, exactly once each. */
  accountIdentity?: string;
  now?: string;
}): boolean {
  if (!input.sessionId || !Number.isInteger(input.sourceUserSeq) || !input.identifier) return false;
  try {
    const result = db().prepare(
      'INSERT OR IGNORE INTO alias_claims (session_id, source_user_seq, identifier, account_identity, claimed_at) VALUES (?, ?, ?, ?, ?)',
    ).run(
      input.sessionId, input.sourceUserSeq, input.identifier,
      input.accountIdentity?.trim() ?? '', input.now ?? new Date().toISOString(),
    );
    return result.changes > 0;
  } catch {
    return false;
  }
}

// ── the durable embedding backfill ───────────────────────────────────────────
//
// A row without a vector IS the queue: it persists in SQLite until a backfill
// attaches one, so a crash between learning and embedding loses nothing — the
// next backfill (scheduled post-settlement, or the boot warm) finds the same
// rows again. Idempotent by construction: attaching is an UPDATE keyed by the
// row identity, and an already-embedded row never reappears in the scan.

/** Embed every alias row still missing a vector in the CURRENT local space. */
export async function backfillCapabilityAliasEmbeddings(
  options: { scope?: CapabilityAliasScope } = {},
): Promise<boolean> {
  const provider = await getLocalEmbeddingProvider();
  if (!provider) return false;
  const space = localEmbeddingSpaceKey();
  for (;;) {
    const pending = aliasRowsMissingEmbedding(space, { ...options, limit: 32 });
    if (pending.length === 0) return true;
    let vectors: Float32Array[] | null = null;
    try {
      vectors = await provider.embed(pending.map((row) => row.terms.join(' ')));
    } catch {
      return false;
    }
    if (!vectors || vectors.length !== pending.length) return false;
    let wrote = 0;
    pending.forEach((row, index) => {
      const vector = vectors![index];
      if (!vector) return;
      if (attachCapabilityAliasEmbedding(row, vector, space)) wrote += 1;
    });
    // A row that will not take a vector must not spin this loop forever.
    if (wrote === 0) return false;
  }
}

let backfillTimer: NodeJS.Timeout | null = null;
let backfillRunning = false;
let backfillRerun = false;

/**
 * Post-settlement hook: a paraphrase learned NOW must work on the NEXT turn,
 * not after a daemon restart. Debounced so a multi-read settlement schedules
 * one pass; re-armed if learning lands while a pass is running.
 */
export function scheduleCapabilityAliasEmbedBackfill(delayMs = 50): void {
  if (backfillTimer) return;
  backfillTimer = setTimeout(() => {
    backfillTimer = null;
    if (backfillRunning) { backfillRerun = true; return; }
    backfillRunning = true;
    void backfillCapabilityAliasEmbeddings()
      .catch(() => false)
      .finally(() => {
        backfillRunning = false;
        if (backfillRerun) { backfillRerun = false; scheduleCapabilityAliasEmbedBackfill(delayMs); }
      });
  }, delayMs);
  backfillTimer.unref?.();
}
