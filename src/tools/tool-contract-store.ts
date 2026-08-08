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
    } else if (typeof value === 'boolean' || typeof value === 'number') {
      // Enum-ish and numeric values are shape, not content.
      out[key] = value;
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
}): void {
  const { identifier, schema } = input;
  if (!identifier || !schema || typeof schema !== 'object' || Array.isArray(schema)) return;
  try {
    const dir = ensureDir();
    const file = path.join(dir, contractFileName(identifier));
    const existing = readContractFile(file);
    const record: ToolContract = {
      identifier,
      schema: schema as Record<string, unknown>,
      fingerprint: fingerprintSchema(schema),
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
  } catch { /* a cache that cannot write must not break the call it was helping */ }
}

function readContractFile(file: string): ToolContract | null {
  try {
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as ToolContract;
    return parsed && typeof parsed === 'object' && parsed.identifier ? parsed : null;
  } catch { return null; }
}

export function loadToolContract(identifier: string): ToolContract | null {
  if (!identifier) return null;
  try {
    const file = path.join(machineDir(), contractFileName(identifier));
    const record = readContractFile(file);
    if (!record) return null;
    if (Date.now() - Date.parse(record.savedAt) > CONTRACT_TTL_MS) return null;
    return record;
  } catch { return null; }
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
