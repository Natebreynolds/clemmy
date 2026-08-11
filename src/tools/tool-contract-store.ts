/**
 * DURABLE TOOL CONTRACTS — how to call a tool, remembered across restarts.
 *
 * A "proven capability" used to be a name, an account, and a timestamp. That
 * is why knowing the tool did not stop the searching: the name says WHICH tool,
 * and nothing said HOW to call it. Measured on a live single-email task
 * (2026-08-07): forty-eight tool calls, of which FIFTEEN were discovery —
 * eleven tool searches and four catalog searches — for a task that needed about
 * four calls. She was looking up tools the runtime had already named for her,
 * because a name in a paragraph is not a callable thing.
 *
 * The schema cache that would have answered it existed, and was an in-memory
 * Map. It died with the process, so every restart re-paid discovery for tools
 * used a hundred times before.
 *
 * This is the durable half: slug → real input schema, on disk, per machine.
 * It is deliberately NOT provider-specific. Composio slugs, CLI commands, and
 * native MCP tool names are all just identifiers here, because the point is to
 * generalise across every tool Clementine can reach rather than to special-case
 * whichever one broke most recently.
 *
 * Safety properties, inherited from the in-memory cache it backs:
 *   - VALIDATION-ONLY and fail-open. A contract can make a pre-dispatch check
 *     more precise; it can never be the reason something is blocked. A missing,
 *     stale, or malformed entry must read exactly like "no opinion".
 *   - Fingerprinted, so a provider reshaping a schema under a stable name is
 *     detectable rather than silently trusted forever.
 *   - Bounded on disk, and every write is atomic (temp + rename) so a crash
 *     mid-write cannot leave a torn file that poisons the next run.
 */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BASE_DIR } from '../config.js';
import { getMachineId } from '../runtime/machine-id.js';

const CONTRACTS_ROOT = path.join(BASE_DIR, 'memory', 'tool-contracts');
/** Generous: a provider contract under a stable name changes rarely, and the
 *  fingerprint catches it when it does. The cost of staleness is a less precise
 *  local check; the cost of expiry is a full discovery round trip. */
const CONTRACT_TTL_MS = 30 * 24 * 60 * 60_000;
const MAX_CONTRACTS = 2_000;

export interface ToolContract {
  identifier: string;
  /** The real input schema as the provider reported it. */
  schema: Record<string, unknown>;
  /** Stable digest of the schema, so drift under a stable name is detectable. */
  fingerprint: string;
  /**
   * When this exact schema fingerprint was last observed from provider
   * metadata. This is deliberately separate from savedAt: successful business
   * calls may refresh examples/validation retention, but they must never mint
   * or extend autonomous execution authority.
  */
  providerObservedAt?: string;
  /** Fingerprint observed at providerObservedAt; binds the lease to one schema. */
  providerObservedFingerprint?: string;
  /**
   * Two different schemas observed at the same provider timestamp are
   * unordered. Keep that timestamp as a monotonic watermark, but revoke
   * executable authority until a strictly later observation resolves it.
   */
  providerAuthorityConflictAt?: string;
  /** An argument payload that ACTUALLY SUCCEEDED. A schema says what is legal;
   *  this says what worked — which is what stops a repeat of the same
   *  invalid-argument failure on a tool already used before. Keys only when the
   *  value could carry content; see redactExample. */
  exampleArgs?: Record<string, unknown>;
  savedAt: string;
  lastUsedAt?: string;
}

function machineDir(): string {
  return path.join(CONTRACTS_ROOT, getMachineId());
}

function ensureDir(): string {
  const dir = machineDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

/** Filesystem-safe, collision-free name for an arbitrary tool identifier —
 *  slugs, CLI commands and MCP names all pass through the same door. */
export function contractFileName(identifier: string): string {
  const safe = identifier.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 80);
  const digest = createHash('sha256').update(identifier).digest('hex').slice(0, 12);
  return `${safe}.${digest}.json`;
}

export function fingerprintSchema(schema: unknown): string {
  return createHash('sha256').update(stableStringify(schema)).digest('hex').slice(0, 32);
}

/** Key order must not change the fingerprint — otherwise a re-serialised but
 *  identical schema reads as drift and we throw away a good contract. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

/**
 * An example is for SHAPE, never for content. Real payloads carry recipients,
 * bodies, record ids and free text; persisting them would turn a performance
 * cache into a silent copy of the user's data. Scalars become type markers,
 * structure is kept.
 */
export function redactExample(args: unknown, depth = 0): Record<string, unknown> | undefined {
  if (!args || typeof args !== 'object' || Array.isArray(args) || depth > 3) return undefined;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    if (value === null || value === undefined) continue;
    if (Array.isArray(value)) {
      out[key] = value.length > 0 ? [typeof value[0] === 'object' ? redactExample(value[0], depth + 1) ?? '<object>' : `<${typeof value[0]}>`] : [];
    } else if (typeof value === 'object') {
      out[key] = redactExample(value, depth + 1) ?? '<object>';
    } else if (typeof value === 'boolean') {
      // Booleans carry no destination, identifier, timestamp, or free text.
      out[key] = value;
    } else if (typeof value === 'number') {
      // Numeric ids, timestamps, amounts, and row numbers are content. Keep
      // only their type marker; the key already captures the useful shape.
      out[key] = '<number>';
    } else {
      out[key] = `<${typeof value}>`;
    }
  }
  return out;
}

export function saveToolContract(input: {
  identifier: string;
  schema: unknown;
  exampleArgs?: unknown;
  /** Set only by a real provider-metadata observation. */
  providerObservedAt?: string;
  /** Set only when two real observations at the same timestamp disagree. */
  providerAuthorityConflictAt?: string;
}): ToolContract | null {
  const { identifier, schema } = input;
  if (!identifier || !schema || typeof schema !== 'object' || Array.isArray(schema)) return null;
  try {
    const dir = ensureDir();
    const file = path.join(dir, contractFileName(identifier));
    const existing = validateToolContractRecord(readContractFile(file), identifier);
    const fingerprint = fingerprintSchema(schema);
    const explicitProviderObservedAt = normalizeProviderObservedAt(input.providerObservedAt);
    const explicitConflictAt = normalizeProviderObservedAt(input.providerAuthorityConflictAt);
    const existingObservation = providerObservation(existing);
    const existingConflictAt = normalizeProviderObservedAt(existing?.providerAuthorityConflictAt);
    const existingConflictMs = existingConflictAt ? Date.parse(existingConflictAt) : Number.NaN;
    const existingWatermarkMs = Math.max(
      existingObservation?.observedMs ?? Number.NEGATIVE_INFINITY,
      Number.isFinite(existingConflictMs) ? existingConflictMs : Number.NEGATIVE_INFINITY,
    );
    const explicitObservedMs = explicitProviderObservedAt
      ? Date.parse(explicitProviderObservedAt)
      : Number.NaN;

    // A process may detect an equal-time conflict even when its earlier
    // durable write was lost or removed. Persist that process evidence
    // directly; a newer durable observation still wins if one raced ahead.
    if (explicitConflictAt) {
      const explicitConflictMs = Date.parse(explicitConflictAt);
      if (existing && Number.isFinite(existingWatermarkMs)
        && existingWatermarkMs > explicitConflictMs) return existing;
      const record: ToolContract = {
        identifier,
        schema: existing?.schema ?? schema as Record<string, unknown>,
        fingerprint: existing?.fingerprint ?? fingerprint,
        providerAuthorityConflictAt: explicitConflictAt,
        ...(existing?.exampleArgs ? { exampleArgs: existing.exampleArgs } : {}),
        savedAt: new Date().toISOString(),
        ...(existing?.lastUsedAt ? { lastUsedAt: existing.lastUsedAt } : {}),
      };
      atomicWrite(file, record);
      pruneIfNeeded(dir);
      return record;
    }

    // Provider observations are monotonic per identifier. A stale/unproven
    // schema can remain useful to its caller, but it cannot roll durable state
    // back from a later trusted observation or replace that schema outright.
    if (existing && Number.isFinite(existingWatermarkMs)
      && explicitProviderObservedAt && explicitObservedMs < existingWatermarkMs) {
      return existing;
    }

    // Millisecond request-start timestamps form only a partial order. If two
    // different schemas share one timestamp, neither may win executable
    // authority. Persist a conflict watermark so restart or an equal-time
    // replay cannot re-authorize either side; only a later observation can.
    if (existing && explicitProviderObservedAt
      && explicitObservedMs === existingWatermarkMs
      && !(existingObservation?.observedMs === explicitObservedMs
        && existing.fingerprint === fingerprint)) {
      const record: ToolContract = {
        identifier,
        schema: existing.schema,
        fingerprint: existing.fingerprint,
        providerAuthorityConflictAt: explicitProviderObservedAt,
        ...(existing.exampleArgs ? { exampleArgs: existing.exampleArgs } : {}),
        savedAt: new Date().toISOString(),
        ...(existing.lastUsedAt ? { lastUsedAt: existing.lastUsedAt } : {}),
      };
      atomicWrite(file, record);
      pruneIfNeeded(dir);
      return record;
    }

    if (existing && Number.isFinite(existingWatermarkMs)
      && !explicitProviderObservedAt && existing.fingerprint !== fingerprint) {
      return existing;
    }

    const acceptExplicitObservation = Boolean(explicitProviderObservedAt
      && (!Number.isFinite(existingWatermarkMs)
        || explicitObservedMs > existingWatermarkMs
        || (existingObservation?.observedMs === explicitObservedMs
          && existing?.fingerprint === fingerprint)));
    const preservedProviderObservedAt = existing?.fingerprint === fingerprint
      ? existingObservation?.observedAt
      : undefined;
    const providerObservedAt = acceptExplicitObservation
      ? explicitProviderObservedAt
      : preservedProviderObservedAt;
    const providerAuthorityConflictAt = !acceptExplicitObservation
      && existing?.fingerprint === fingerprint
      ? existingConflictAt
      : undefined;
    const record: ToolContract = {
      identifier,
      schema: schema as Record<string, unknown>,
      fingerprint,
      ...(providerObservedAt
        ? { providerObservedAt, providerObservedFingerprint: fingerprint }
        : {}),
      ...(providerAuthorityConflictAt ? { providerAuthorityConflictAt } : {}),
      // A previously-learned working example survives a schema refresh unless a
      // newer one arrives — losing it would re-open the failure it prevents.
      ...(redactExample(input.exampleArgs) ?? existing?.exampleArgs
        ? { exampleArgs: redactExample(input.exampleArgs) ?? existing?.exampleArgs }
        : {}),
      savedAt: new Date().toISOString(),
      ...(existing?.lastUsedAt ? { lastUsedAt: existing.lastUsedAt } : {}),
    };
    atomicWrite(file, record);
    pruneIfNeeded(dir);
    return record;
  } catch {
    // A cache that cannot write must not break the call it was helping.
    return null;
  }
}

/**
 * A successful business call teaches only a redacted example. It never accepts
 * a caller-supplied schema, so a fallback or mutated process object cannot
 * overwrite a provider-observed contract. If discovery was unavailable, an
 * inert validation-only object contract keeps the example without authority.
 */
export function saveToolContractExample(input: {
  identifier: string;
  exampleArgs: unknown;
}): void {
  if (!input.identifier) return;
  const existing = loadToolContract(input.identifier);
  saveToolContract({
    identifier: input.identifier,
    schema: existing?.schema ?? { type: 'object' },
    exampleArgs: input.exampleArgs,
  });
}

function normalizeProviderObservedAt(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const observedAt = Date.parse(value);
  if (!Number.isFinite(observedAt) || observedAt < 0 || observedAt > Date.now()) return undefined;
  return new Date(observedAt).toISOString();
}

function providerObservation(record: ToolContract | null): {
  observedAt: string;
  observedMs: number;
} | null {
  if (!record || record.providerObservedFingerprint !== record.fingerprint) return null;
  const observedAt = normalizeProviderObservedAt(record.providerObservedAt);
  if (!observedAt) return null;
  return { observedAt, observedMs: Date.parse(observedAt) };
}

function readContractFile(file: string): ToolContract | null {
  try {
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as ToolContract;
    return parsed && typeof parsed === 'object' && parsed.identifier ? parsed : null;
  } catch { return null; }
}

function validateToolContractRecord(
  record: ToolContract | null,
  expectedIdentifier: string,
): ToolContract | null {
  if (!record || record.identifier !== expectedIdentifier) return null;
  const age = Date.now() - Date.parse(record.savedAt);
  if (!Number.isFinite(age) || age < 0 || age > CONTRACT_TTL_MS) return null;
  if (!record.schema || typeof record.schema !== 'object' || Array.isArray(record.schema)) return null;
  if (fingerprintSchema(record.schema) !== record.fingerprint) return null;
  return record;
}

/**
 * The case-collision twin of a provider-slug-shaped identifier. The store
 * keys files on the RAW identifier digest, so `composio_search_tools` and
 * `COMPOSIO_SEARCH_TOOLS` were two files with identical schemas on disk
 * (live 2026-08). Only the single-underscore word shape folds — external MCP
 * names (`server__tool`) and CLI commands (spaces/dashes) are case-sensitive
 * identities and never alias.
 */
function caseTwinIdentifier(identifier: string): string | null {
  if (!/^[A-Za-z0-9_]+$/.test(identifier)) return null;
  if (!identifier.includes('_') || identifier.includes('__')) return null;
  const upper = identifier.toUpperCase();
  return upper === identifier ? null : upper;
}

export function loadToolContract(identifier: string): ToolContract | null {
  if (!identifier) return null;
  try {
    const file = path.join(machineDir(), contractFileName(identifier));
    const exact = validateToolContractRecord(readContractFile(file), identifier);
    if (exact) return exact;
    const twin = caseTwinIdentifier(identifier);
    if (!twin) return null;
    const twinFile = path.join(machineDir(), contractFileName(twin));
    return validateToolContractRecord(readContractFile(twinFile), twin);
  } catch { return null; }
}

/**
 * Record that a learned contract was READ FOR DISPATCH. Deliberately not
 * called from any save path — a write is not a use — so `lastUsedAt` stays a
 * pure recency-of-consumption signal for recall ranking and pruning.
 */
export function touchToolContract(identifier: string): void {
  if (!identifier) return;
  try {
    const record = loadToolContract(identifier);
    if (!record) return;
    const file = path.join(ensureDir(), contractFileName(record.identifier));
    atomicWrite(file, { ...record, lastUsedAt: new Date().toISOString() });
  } catch { /* recency is hygiene, never correctness */ }
}

function atomicWrite(file: string, record: ToolContract): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(record, null, 2), 'utf-8');
  renameSync(temporary, file);
}

function pruneIfNeeded(dir: string): void {
  try {
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    if (files.length <= MAX_CONTRACTS) return;
    const byAge = files
      .map((f) => ({ f, at: statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => a.at - b.at);
    for (const { f } of byAge.slice(0, files.length - MAX_CONTRACTS)) {
      try { unlinkSync(path.join(dir, f)); } catch { /* best effort */ }
    }
  } catch { /* pruning is hygiene, never correctness */ }
}

/** Test seam — the store is per-machine on disk, so tests need a clean slate. */
export function _clearToolContractsForTests(): void {
  try {
    const dir = machineDir();
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.json') || f.endsWith('.tmp')) unlinkSync(path.join(dir, f));
    }
  } catch { /* best effort */ }
}

/**
 * Enumerate this machine's learned-contract files without opening them. The
 * fileName's leading `safe` segment is a token-matchable hint of the
 * identifier (OUTLOOK_CREATE_DRAFT.ab12….json), which lets recall rank the
 * whole store by name overlap and then open only the winners — the read side
 * of "a successful call teaches how to call it" (exampleArgs had zero readers
 * before this).
 */
export function listToolContractFiles(): Array<{ fileName: string; identifierHint: string; modifiedMs: number }> {
  try {
    const dir = machineDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((fileName) => {
        // `<safe>.<12-hex>.json` — strip the digest + extension, keep the hint.
        const identifierHint = fileName.replace(/\.[0-9a-f]{12}\.json$/, '');
        let modifiedMs = 0;
        try { modifiedMs = statSync(path.join(dir, fileName)).mtimeMs; } catch { /* hint only */ }
        return { fileName, identifierHint, modifiedMs };
      });
  } catch {
    return [];
  }
}

/** Open one enumerated contract file. Validation identical to loadToolContract;
 *  the identifier check is skipped because the caller only knows the fileName
 *  (the safe segment is lossy) — the record's own identifier field is trusted
 *  after structural validation. */
export function readToolContractFile(fileName: string): ToolContract | null {
  if (!/^[A-Za-z0-9_.-]+\.json$/.test(fileName)) return null;
  try {
    const file = path.join(machineDir(), fileName);
    const record = readContractFile(file);
    if (!record || typeof record !== 'object') return null;
    const contract = record as ToolContract;
    if (typeof contract.identifier !== 'string' || !contract.identifier) return null;
    if (!contract.schema || typeof contract.schema !== 'object') return null;
    return contract;
  } catch {
    return null;
  }
}
