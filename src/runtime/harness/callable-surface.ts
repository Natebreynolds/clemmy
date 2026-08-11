/**
 * Callable-surface oracle (W1 Stage 1) — ONE synchronous, network-free,
 * budget-free answer to the question five subsystems were answering with five
 * different wrong proxies: "can this turn call tool X, and does it know how?"
 *
 * The live failure class this ends (Aug 2026 ledger): a guardrail mandated
 * run_tool_program while the discovery governor refused the tool_search that
 * would supply its schema, so the model brute-forced parameter names; denied
 * schema lookups drove empty-arg probes at MUTATING tools (one created a blank
 * spreadsheet in the user's Drive); the fan-out nudge recommended run_worker
 * in an environment where it does not exist.
 *
 * Contract:
 *   - Pure reads over data already on disk/in-process — durable tool
 *     contracts, the session schema cache, task-scoped candidate elimination.
 *     Never a provider call, never a governor charge.
 *   - Local built-in schemas arrive via REGISTRATION, not import: importing
 *     local-runtime-tools from here would drag the whole tool surface into
 *     every guardrail consumer (the exact cycle that forced the inlined
 *     `codeModeRecoveryAvailable()` env-flag proxy this replaces).
 *   - Fail-closed toward SILENCE: a missing registration or unknown name
 *     yields `schemaSource: 'none'` and `isMandatable() === false`. Degrading
 *     means a guardrail mandates nothing — never that it mandates a phantom.
 */

import { loadToolContract } from '../../tools/tool-contract-store.js';
import { getCachedToolSchema } from '../../tools/composio-schema-cache.js';
import { candidateEliminatedForTask } from './attempt-settlement.js';

export interface CallableSurfaceEntry {
  /** Canonical identity as asked: bare local name, provider slug, or server__tool. */
  name: string;
  /** Dispatchable THIS turn — directly or through a known carrier. */
  reachable: boolean;
  carrier: 'direct' | 'call_tool' | 'provider_carrier' | null;
  schema: Record<string, unknown> | null;
  schemaSource: 'local_registry' | 'cached_contract' | 'none';
  /** A payload that actually succeeded, when the store banked one. */
  exampleArgs?: Record<string, unknown>;
  requiredFields: string[];
  /** True when this task's own settlements already disproved the candidate. */
  eliminatedForTask: boolean;
}

export interface CallableSurfaceContext {
  sessionId?: string;
  sourceUserSeq?: number;
}

type LocalSchemaProvider = () => ReadonlyMap<string, Record<string, unknown>>;

let localSchemaProvider: LocalSchemaProvider | null = null;

/**
 * Each lane's bootstrap registers the JSON-projected local tool schemas once.
 * Registration is the seam a wiring pin asserts per lane — an unregistered
 * lane degrades to silence, and the pin (not runtime behavior) catches it.
 */
export function registerLocalSchemaProvider(provider: LocalSchemaProvider): void {
  localSchemaProvider = provider;
}

/** Test seam. */
export function _clearLocalSchemaProviderForTests(): void {
  localSchemaProvider = null;
}

/**
 * Transition probe: consumers that must not WEAKEN a proven behavior before
 * every lane registers its projection can distinguish "oracle says no" from
 * "oracle not wired on this lane yet" and keep their legacy heuristic for the
 * latter only. A wiring pin per lane retires this.
 */
export function localSchemaProviderRegistered(): boolean {
  return localSchemaProvider !== null;
}

/** Provider-catalog slug SHAPE (OUTLOOK_CREATE_DRAFT) — a naming convention,
 *  never a tool list. Verb/shape-based per the no-catalog rule. */
const PROVIDER_SLUG_RE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
/** External MCP identity shape (server__tool). */
const MCP_NAME_RE = /^[a-z0-9][a-z0-9_-]*__[a-z0-9][a-z0-9_.-]*$/i;

function requiredFieldsOf(schema: Record<string, unknown> | null): string[] {
  if (!schema) return [];
  const required = (schema as { required?: unknown }).required;
  if (!Array.isArray(required)) return [];
  return required.filter((field): field is string => typeof field === 'string');
}

function eliminationFor(name: string, ctx?: CallableSurfaceContext): boolean {
  if (!ctx?.sessionId || typeof ctx.sourceUserSeq !== 'number') return false;
  try {
    return candidateEliminatedForTask(ctx.sessionId, ctx.sourceUserSeq, name);
  } catch {
    return false;
  }
}

export function resolveCallable(name: string, ctx?: CallableSurfaceContext): CallableSurfaceEntry {
  const trimmed = (name ?? '').trim();
  const eliminatedForTask = trimmed ? eliminationFor(trimmed, ctx) : false;
  if (!trimmed) {
    return {
      name: '',
      reachable: false,
      carrier: null,
      schema: null,
      schemaSource: 'none',
      requiredFields: [],
      eliminatedForTask: false,
    };
  }

  // 1. Local built-ins, when a lane registered its projection.
  const local = localSchemaProvider?.().get(trimmed) ?? null;
  if (local) {
    return {
      name: trimmed,
      reachable: true,
      carrier: 'direct',
      schema: local,
      schemaSource: 'local_registry',
      requiredFields: requiredFieldsOf(local),
      eliminatedForTask,
    };
  }

  // 2. Learned/cached contract — session cache first, durable store beneath it
  //    (getCachedToolSchema already promotes durable hits back into the map).
  const cached = getCachedToolSchema(trimmed);
  if (cached) {
    const durable = loadToolContract(trimmed);
    const entry: CallableSurfaceEntry = {
      name: trimmed,
      reachable: true,
      carrier: MCP_NAME_RE.test(trimmed) ? 'call_tool' : 'provider_carrier',
      schema: cached,
      schemaSource: 'cached_contract',
      requiredFields: requiredFieldsOf(cached),
      eliminatedForTask,
    };
    if (durable?.exampleArgs && Object.keys(durable.exampleArgs).length > 0) {
      entry.exampleArgs = durable.exampleArgs;
    }
    return entry;
  }

  // 3. Shape-recognized identities stay dispatchable through their carrier —
  //    validation is schema-first at dispatch — but with no schema in hand
  //    they are NEVER mandatable.
  if (PROVIDER_SLUG_RE.test(trimmed) || MCP_NAME_RE.test(trimmed)) {
    return {
      name: trimmed,
      reachable: true,
      carrier: PROVIDER_SLUG_RE.test(trimmed) ? 'provider_carrier' : 'call_tool',
      schema: null,
      schemaSource: 'none',
      requiredFields: [],
      eliminatedForTask,
    };
  }

  // 4. Unknown bare name: not provably dispatchable this turn.
  return {
    name: trimmed,
    reachable: false,
    carrier: null,
    schema: null,
    schemaSource: 'none',
    requiredFields: [],
    eliminatedForTask,
  };
}

/**
 * The mandate precondition: a guardrail may name a tool ONLY when the tool is
 * reachable, un-eliminated, and its real schema is in hand to render inline.
 * Everything else keeps the behavioral constraint and drops the tool name.
 */
export function isMandatable(entry: CallableSurfaceEntry): boolean {
  return entry.reachable && !entry.eliminatedForTask && entry.schema !== null;
}
