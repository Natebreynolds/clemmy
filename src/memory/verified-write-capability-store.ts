/**
 * Durable, privacy-bounded store for verified WRITE capability identities.
 *
 * This is intentionally separate from Tool Memory. A successful mutation may
 * teach only that one capability identity worked for an intent. The schema has
 * no place for invocation arguments, destinations, templates, approval ids,
 * consent decisions, or auto-bind flags, so those facts cannot accidentally be
 * replayed by a future reader.
 */
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { BASE_DIR } from '../config.js';
import { getMachineId } from '../runtime/machine-id.js';
import {
  acceptedPhraseDigest,
  aliasScopeDigest,
  boundedAliasTerms,
  daemonAliasScope,
} from './capability-alias-index.js';
import {
  parseVerifiedWriteCapabilityOrigin,
  type VerifiedWriteCapabilityOrigin,
} from './verified-write-origin.js';

export const VERIFIED_WRITE_CAPABILITY_CLASS = 'capability_only' as const;
export const VERIFIED_WRITE_LOCAL_PROVIDER = 'authorized_local_registry' as const;

export type VerifiedWriteBindingKind = 'catalog_manifest' | 'local_envelope';
export type VerifiedWriteEffect = 'local_write' | 'external_write' | 'admin';

export interface VerifiedWriteCapabilityRecordV1 {
  version: 1;
  klass: typeof VERIFIED_WRITE_CAPABILITY_CLASS;
  aliasDigest: string;
  terms: string[];
  origin: VerifiedWriteCapabilityOrigin;
  bindingKind: VerifiedWriteBindingKind;
  providerKind: string;
  capabilityRef: string;
  operationId: string;
  effect: VerifiedWriteEffect;
  accountIdentity: string;
  /** Present only for a host-local registry definition. It is an identity
   * digest, not a stored argument/template or authorization. */
  localEnvelopeFingerprint: string | null;
}

export interface StoredVerifiedWriteCapability extends VerifiedWriteCapabilityRecordV1 {
  recordId: string;
  createdAt: string;
}

export type VerifiedWriteCapabilityStoreResult =
  | { stored: true; inserted: boolean; record: StoredVerifiedWriteCapability }
  | { stored: false; reason: string };

const RECORD_KEYS = new Set([
  'accountIdentity',
  'aliasDigest',
  'bindingKind',
  'capabilityRef',
  'effect',
  'klass',
  'localEnvelopeFingerprint',
  'operationId',
  'origin',
  'providerKind',
  'terms',
  'version',
]);
const MAX_TERMS = 12;
const MAX_TERM_LENGTH = 24;
const MAX_MATCH_ROWS = 512;
const SHA256 = /^[a-f0-9]{64}$/u;
let handle: Database.Database | null = null;
let handlePath = '';

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function exactIdentity(value: unknown, max = 512): value is string {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= max
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function exactTerms(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_TERMS) return null;
  const terms: string[] = [];
  for (const term of value) {
    if (
      typeof term !== 'string'
      || term !== term.trim().toLowerCase()
      || !/^[a-z0-9]+$/u.test(term)
      || term.length < 3
      || term.length > MAX_TERM_LENGTH
      || terms.includes(term)
    ) return null;
    terms.push(term);
  }
  return terms;
}

/** Strictly parse the complete capability-only record. */
export function parseVerifiedWriteCapabilityRecord(
  value: unknown,
): VerifiedWriteCapabilityRecordV1 | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row);
  if (keys.length !== RECORD_KEYS.size || keys.some((key) => !RECORD_KEYS.has(key))) return null;
  const terms = exactTerms(row.terms);
  const origin = parseVerifiedWriteCapabilityOrigin(row.origin);
  if (
    row.version !== 1
    || row.klass !== VERIFIED_WRITE_CAPABILITY_CLASS
    || typeof row.aliasDigest !== 'string'
    || !/^[a-f0-9]{24}$/u.test(row.aliasDigest)
    || !terms
    || !origin
    || (row.bindingKind !== 'catalog_manifest' && row.bindingKind !== 'local_envelope')
    || !exactIdentity(row.providerKind, 128)
    || !exactIdentity(row.capabilityRef)
    || !exactIdentity(row.operationId)
    || (row.effect !== 'local_write' && row.effect !== 'external_write' && row.effect !== 'admin')
    || !exactIdentity(row.accountIdentity)
    || (row.localEnvelopeFingerprint !== null
      && (typeof row.localEnvelopeFingerprint !== 'string' || !SHA256.test(row.localEnvelopeFingerprint)))
    || (row.bindingKind === 'catalog_manifest'
      && (!row.accountIdentity || row.localEnvelopeFingerprint !== null))
    || (row.bindingKind === 'local_envelope'
      && (
        row.providerKind !== VERIFIED_WRITE_LOCAL_PROVIDER
        || row.accountIdentity !== 'local_registry:host'
        || row.effect !== 'local_write'
        || typeof row.localEnvelopeFingerprint !== 'string'
      ))
  ) return null;
  return {
    version: 1,
    klass: VERIFIED_WRITE_CAPABILITY_CLASS,
    aliasDigest: row.aliasDigest,
    terms,
    origin,
    bindingKind: row.bindingKind,
    providerKind: row.providerKind,
    capabilityRef: row.capabilityRef,
    operationId: row.operationId,
    effect: row.effect,
    accountIdentity: row.accountIdentity,
    localEnvelopeFingerprint: row.localEnvelopeFingerprint,
  };
}

function canonicalRecordJson(record: VerifiedWriteCapabilityRecordV1): string {
  return JSON.stringify({
    version: 1 as const,
    klass: VERIFIED_WRITE_CAPABILITY_CLASS,
    aliasDigest: record.aliasDigest,
    terms: record.terms,
    origin: record.origin,
    bindingKind: record.bindingKind,
    providerKind: record.providerKind,
    capabilityRef: record.capabilityRef,
    operationId: record.operationId,
    effect: record.effect,
    accountIdentity: record.accountIdentity,
    localEnvelopeFingerprint: record.localEnvelopeFingerprint,
  });
}

function scopedRecordDigest(
  scopeDigest: string,
  recordJson: string,
): string {
  return sha256(JSON.stringify({ version: 1, scopeDigest, recordJson }));
}

function harden(dir: string, file: string): void {
  try { chmodSync(dir, 0o700); } catch { /* best effort */ }
  for (const member of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) {
    if (!existsSync(member)) continue;
    try { chmodSync(member, 0o600); } catch { /* best effort */ }
  }
}

function database(): Database.Database {
  const dir = path.join(BASE_DIR, 'memory', 'verified-write-capabilities', getMachineId());
  const file = path.join(dir, 'capabilities.db');
  if (handle && handlePath === file) return handle;
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  harden(dir, file);
  const opened = new Database(file);
  try {
    opened.pragma('journal_mode = WAL');
    opened.pragma('secure_delete = ON');
    opened.exec(`
      CREATE TABLE IF NOT EXISTS verified_write_capabilities (
        record_id          TEXT PRIMARY KEY,
        protocol_version   INTEGER NOT NULL CHECK (protocol_version = 1),
        scope_digest       TEXT NOT NULL CHECK (length(scope_digest) = 40),
        alias_digest       TEXT NOT NULL CHECK (length(alias_digest) = 24),
        origin_session_id  TEXT NOT NULL,
        origin_source_seq  INTEGER NOT NULL CHECK (origin_source_seq > 0),
        binding_kind       TEXT NOT NULL CHECK (binding_kind IN ('catalog_manifest','local_envelope')),
        provider_kind      TEXT NOT NULL,
        operation_id       TEXT NOT NULL,
        effect             TEXT NOT NULL CHECK (effect IN ('local_write','external_write','admin')),
        account_identity   TEXT NOT NULL,
        record_json        TEXT NOT NULL CHECK (json_valid(record_json) AND json_type(record_json) = 'object'),
        record_digest      TEXT NOT NULL CHECK (length(record_digest) = 64),
        created_at         TEXT NOT NULL,
        UNIQUE (scope_digest, origin_session_id, origin_source_seq, operation_id, account_identity)
      );
      CREATE INDEX IF NOT EXISTS verified_write_capabilities_by_scope
        ON verified_write_capabilities(scope_digest, created_at DESC);
      CREATE INDEX IF NOT EXISTS verified_write_capabilities_by_identity
        ON verified_write_capabilities(provider_kind, operation_id, effect, account_identity);
    `);
    harden(dir, file);
    handle = opened;
    handlePath = file;
    return opened;
  } catch (error) {
    try { opened.close(); } catch { /* best effort */ }
    harden(dir, file);
    throw error;
  }
}

interface RawRecordRow {
  record_id: string;
  protocol_version: number;
  scope_digest: string;
  alias_digest: string;
  origin_session_id: string;
  origin_source_seq: number;
  binding_kind: string;
  provider_kind: string;
  operation_id: string;
  effect: string;
  account_identity: string;
  record_json: string;
  record_digest: string;
  created_at: string;
}

function decodedRow(row: RawRecordRow): StoredVerifiedWriteCapability | null {
  let parsed: unknown;
  try { parsed = JSON.parse(row.record_json); } catch { return null; }
  const record = parseVerifiedWriteCapabilityRecord(parsed);
  if (!record) return null;
  const canonical = canonicalRecordJson(record);
  if (!/^[a-f0-9]{40}$/u.test(row.scope_digest)) return null;
  const digest = scopedRecordDigest(row.scope_digest, canonical);
  const recordId = `verified-write-capability:v1:${digest}`;
  if (
    row.protocol_version !== 1
    || row.record_id !== recordId
    || row.record_digest !== digest
    || row.record_json !== canonical
    || row.alias_digest !== record.aliasDigest
    || row.origin_session_id !== record.origin.sessionId
    || row.origin_source_seq !== record.origin.sourceUserSeq
    || row.binding_kind !== record.bindingKind
    || row.provider_kind !== record.providerKind
    || row.operation_id !== record.operationId
    || row.effect !== record.effect
    || row.account_identity !== record.accountIdentity
    || !exactIdentity(row.created_at, 64)
  ) return null;
  return { ...record, recordId, createdAt: row.created_at };
}

export function storeVerifiedWriteCapability(input: {
  record: VerifiedWriteCapabilityRecordV1;
  scopeDigest?: string;
}): VerifiedWriteCapabilityStoreResult {
  const parsed = parseVerifiedWriteCapabilityRecord(input.record);
  if (!parsed) return { stored: false, reason: 'verified-write record is not the strict capability-only shape' };
  const scopeDigest = input.scopeDigest ?? aliasScopeDigest(daemonAliasScope());
  if (!/^[a-f0-9]{40}$/u.test(scopeDigest)) return { stored: false, reason: 'privacy scope is invalid' };
  const recordJson = canonicalRecordJson(parsed);
  const digest = scopedRecordDigest(scopeDigest, recordJson);
  const recordId = `verified-write-capability:v1:${digest}`;
  const createdAt = new Date().toISOString();
  try {
    const db = database();
    const existing = db.prepare(`
      SELECT * FROM verified_write_capabilities
       WHERE scope_digest = ? AND origin_session_id = ? AND origin_source_seq = ?
         AND operation_id = ? AND account_identity = ?
    `).get(
      scopeDigest,
      parsed.origin.sessionId,
      parsed.origin.sourceUserSeq,
      parsed.operationId,
      parsed.accountIdentity,
    ) as RawRecordRow | undefined;
    if (existing) {
      const decoded = decodedRow(existing);
      return decoded && decoded.recordId === recordId
        ? { stored: true, inserted: false, record: decoded }
        : { stored: false, reason: 'a different or corrupt learned write already owns this origin identity' };
    }
    db.prepare(`
      INSERT INTO verified_write_capabilities (
        record_id, protocol_version, scope_digest, alias_digest,
        origin_session_id, origin_source_seq, binding_kind, provider_kind,
        operation_id, effect, account_identity, record_json, record_digest, created_at
      ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      recordId,
      scopeDigest,
      parsed.aliasDigest,
      parsed.origin.sessionId,
      parsed.origin.sourceUserSeq,
      parsed.bindingKind,
      parsed.providerKind,
      parsed.operationId,
      parsed.effect,
      parsed.accountIdentity,
      recordJson,
      digest,
      createdAt,
    );
    return { stored: true, inserted: true, record: { ...parsed, recordId, createdAt } };
  } catch (error) {
    return {
      stored: false,
      reason: String(error instanceof Error ? error.message : error).replace(/\s+/g, ' ').slice(0, 240),
    };
  }
}

/** Match only bounded intent features. Returned records still carry zero
 * execution authority and must pass the canonical verifier + current reobserve. */
export function matchVerifiedWriteCapabilities(
  objective: string,
  options: { scopeDigest?: string; limit?: number } = {},
): StoredVerifiedWriteCapability[] {
  const exactDigest = acceptedPhraseDigest(objective);
  const queryTerms = new Set(boundedAliasTerms(objective));
  if (!exactDigest || queryTerms.size === 0) return [];
  const scopeDigest = options.scopeDigest ?? aliasScopeDigest(daemonAliasScope());
  if (!/^[a-f0-9]{40}$/u.test(scopeDigest)) return [];
  let rows: RawRecordRow[];
  try {
    rows = database().prepare(`
      SELECT * FROM verified_write_capabilities
       WHERE scope_digest = ?
       ORDER BY created_at DESC, record_id ASC
       LIMIT ?
    `).all(scopeDigest, MAX_MATCH_ROWS) as RawRecordRow[];
  } catch {
    return [];
  }
  const scored = rows.flatMap((row) => {
    const record = decodedRow(row);
    if (!record) return [];
    const overlap = record.terms.filter((term) => queryTerms.has(term)).length;
    const exact = record.aliasDigest === exactDigest;
    if (!exact && overlap < 2) return [];
    return [{ record, exact, overlap }];
  });
  const limit = Math.max(1, Math.min(options.limit ?? 8, 16));
  const identityKey = (record: StoredVerifiedWriteCapability): string => JSON.stringify({
    bindingKind: record.bindingKind,
    providerKind: record.providerKind,
    capabilityRef: record.capabilityRef,
    operationId: record.operationId,
    effect: record.effect,
    accountIdentity: record.accountIdentity,
    localEnvelopeFingerprint: record.localEnvelopeFingerprint,
  });
  const newestIdentityRows = <T extends {
    record: StoredVerifiedWriteCapability;
    exact: boolean;
    overlap: number;
  }>(candidates: T[]): T[] => {
    const byIdentity = new Map<string, T>();
    for (const candidate of candidates) {
      const key = identityKey(candidate.record);
      const prior = byIdentity.get(key);
      if (
        !prior
        || candidate.record.createdAt > prior.record.createdAt
        || (candidate.record.createdAt === prior.record.createdAt
          && candidate.record.recordId < prior.record.recordId)
      ) byIdentity.set(key, candidate);
    }
    return [...byIdentity.values()];
  };

  // An exact normalized repeat is itself a strong intent identity and may
  // legitimately have proved several capabilities in one prior task. It must
  // not, however, merge recipes from unrelated historical tasks that happened
  // to use the same words. Select one uniquely newest origin first, then return
  // only the capability identities proved together by that task. A timestamp
  // tie across origins abstains rather than choosing by row/store order.
  const exact = scored.filter((entry) => entry.exact);
  if (exact.length > 0) {
    const newestAt = exact.reduce(
      (latest, entry) => entry.record.createdAt > latest ? entry.record.createdAt : latest,
      '',
    );
    const newestOriginKeys = new Set(exact
      .filter((entry) => entry.record.createdAt === newestAt)
      .map((entry) => `${entry.record.origin.sessionId}\u0000${entry.record.origin.sourceUserSeq}`));
    if (newestOriginKeys.size !== 1) return [];
    const [newestOriginKey] = newestOriginKeys;
    const sameOrigin = newestIdentityRows(exact.filter((entry) => (
      `${entry.record.origin.sessionId}\u0000${entry.record.origin.sourceUserSeq}` === newestOriginKey
    )));
    sameOrigin.sort((left, right) => left.record.recordId.localeCompare(right.record.recordId));
    return sameOrigin.slice(0, limit).map((entry) => entry.record);
  }

  // A paraphrase must name at least two bounded anchors and have one uniquely
  // best capability identity. Recency never breaks a semantic tie: ambiguity
  // falls back to foreground discovery rather than choosing by store order.
  const paraphrases = newestIdentityRows(scored);
  const bestOverlap = Math.max(0, ...paraphrases.map((entry) => entry.overlap));
  const best = paraphrases.filter((entry) => entry.overlap === bestOverlap);
  return best.length === 1 ? [best[0]!.record] : [];
}

/** Test/upgrade seam: close the process handle without deleting durable rows. */
export function closeVerifiedWriteCapabilityStoreForTests(): void {
  handle?.close();
  handle = null;
  handlePath = '';
}

/** Build the only lexical material the store accepts. The accepted phrase
 * itself remains in the event log and is never copied into this database. */
export function verifiedWriteAliasForPhrase(phrase: string): {
  aliasDigest: string;
  terms: string[];
} | null {
  const terms = boundedAliasTerms(phrase);
  return terms.length > 0 ? { aliasDigest: acceptedPhraseDigest(phrase), terms } : null;
}

export const __test__ = {
  database,
};
