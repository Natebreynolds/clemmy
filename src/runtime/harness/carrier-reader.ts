/**
 * Read anything the model outputs; resolve it against what the host proved.
 *
 * A model's tool call is a message about WHICH operation it wants and WITH
 * WHAT arguments. Every brain spells that message differently — one
 * double-serializes the arguments, one omits `tool_slug`, one names the
 * operation directly in the carrier's `name` slot, one prefixes it with the
 * gateway it saw in a tool list. The host used to accept a whitelist of those
 * spellings (three separate parsers, each with its own list) and refuse the
 * rest before dispatch — and a refused READ was diagnosed as "needs a plan",
 * which sent the model looking for a plan_task it did not need (live
 * 2026-09-02, grok-4.6: two refused frames, then a dead turn).
 *
 * The host already holds the only authority that matters here: the operations
 * proven this turn and their effects. So this reader accepts any shape by
 * construction, extracts `{operation, arguments}`, and resolves the operation
 * against that proof. Shape is never a gate; proof still is. The caller
 * rewrites a resolved carrier into the canonical gateway form, and the
 * dispatcher below it still re-proves operation, account, schema and effect
 * before any provider I/O — the reader grants no authority of its own.
 */
import type { ProvenCompletionEntry } from './carrier-completion-registry.js';
import {
  catalogOperationIdentityKey,
  isPlainOrClementineLocalTool,
  isTrustedComposioGateway,
  runtimeToolTail,
} from './runtime-tool-identity.js';

export interface ReadCarrier {
  /** The operation the model named, normalized for matching; null when none. */
  operation: string | null;
  /** The operation's arguments as an object when they could be read. */
  arguments: Record<string, unknown> | null;
  /** How the shape was read — journaled so the next unknown dialect is learned. */
  shape: string[];
}

export interface ProvenOperationMatch {
  identifier: string;
  effectClass: string | undefined;
  /** 'exact' — identity keys equal; 'unique_affix' — one proven operation
   * shares an unambiguous prefix/suffix with what the model wrote. */
  match: 'exact' | 'unique_affix';
}

const OPERATION_KEYS = ['tool_slug', 'slug', 'operation', 'action', 'tool', 'name', 'op'] as const;
const ARGUMENT_KEYS = ['arguments', 'args_json', 'args', 'input', 'params', 'parameters', 'payload'] as const;
const GATEWAY_TAIL = 'composio_execute_tool';
/** Namespace and gateway prefixes a model copies from a tool listing. Stripped
 * only for MATCHING; the canonical carrier is rebuilt from the proven id. */
const GATEWAY_PREFIX_RE = /^(?:mcp__)?(?:composio|clementine(?:-local)?|clem(?:entine)?_local|functions|tools?)(?:__|\.|:|_(?=[A-Z]))/i;
const MAX_DEPTH = 4;
/** An affix match below this many identity characters is a guess, not a read. */
const MIN_AFFIX_KEY_LENGTH = 8;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

/** A string that is JSON of an object decodes; anything else is returned as-is. */
function decodeMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): { key: string; value: string } | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return { key, value: value.trim() };
  }
  return null;
}

function firstPresent(record: Record<string, unknown>, keys: readonly string[]): { key: string; value: unknown } | null {
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(record, key) && record[key] !== undefined) {
      return { key, value: record[key] };
    }
  }
  return null;
}

/** Unwrap `{ args: {...} }` / `{ arguments: {...} }` when that is the ONLY key. */
function unwrapSingleEnvelope(record: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(record);
  if (keys.length !== 1) return record;
  const only = keys[0]!;
  if (!ARGUMENT_KEYS.includes(only as typeof ARGUMENT_KEYS[number])) return record;
  return asRecord(decodeMaybeJson(record[only])) ?? record;
}

function isGatewayName(name: string): boolean {
  return isTrustedComposioGateway(name)
    || runtimeToolTail(name).toLowerCase() === GATEWAY_TAIL
    || /(?:^|[._:-])execute_tool$/i.test(name);
}

/**
 * Normalize an operation name for matching: strip transport/gateway prefixes a
 * model copied from a listing, turn dots/spaces/hyphens/slashes into
 * underscores, collapse a doubled leading toolkit (`TOOLKIT_TOOLKIT_ACTION`).
 * Casing is irrelevant — matching uses the catalog identity key.
 */
export function normalizeOperationName(raw: string): string {
  let name = raw.trim();
  for (let i = 0; i < 3 && GATEWAY_PREFIX_RE.test(name); i += 1) {
    name = name.replace(GATEWAY_PREFIX_RE, '');
  }
  name = name.replace(/[.\s/:-]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  name = name.replace(/^([A-Za-z0-9]+)_\1_/i, '$1_');
  return name;
}

function readArguments(raw: unknown, shape: string[]): Record<string, unknown> | null {
  if (raw === null || raw === undefined) return null;
  const decoded = decodeMaybeJson(raw);
  if (typeof raw === 'string' && decoded !== raw) shape.push('arguments_decoded_from_string');
  const record = asRecord(decoded);
  if (!record) return null;
  const unwrapped = unwrapSingleEnvelope(record);
  if (unwrapped !== record) shape.push('argument_envelope_unwrapped');
  return unwrapped;
}

function readGatewayPayload(payload: Record<string, unknown>, shape: string[]): ReadCarrier {
  const operation = firstString(payload, OPERATION_KEYS);
  const argumentSlot = firstPresent(payload, ARGUMENT_KEYS);
  let args: Record<string, unknown> | null;
  if (argumentSlot) {
    if (argumentSlot.key !== 'arguments') shape.push(`arguments_under_${argumentSlot.key}`);
    args = readArguments(argumentSlot.value, shape);
  } else {
    // Provider fields placed beside the slug instead of under `arguments`.
    const { tool_slug: _slug, slug: _s, operation: _o, action: _a, tool: _t, name: _n, op: _op,
      connected_account_id: _account, ...rest } = payload;
    args = Object.keys(rest).length > 0 ? rest : null;
    if (args) shape.push('top_level_provider_fields');
  }
  if (operation && operation.key !== 'tool_slug') shape.push(`operation_under_${operation.key}`);
  return {
    operation: operation ? normalizeOperationName(operation.value) : null,
    arguments: args,
    shape,
  };
}

function readCarrierAt(name: string, argumentsValue: unknown, shape: string[], depth: number): ReadCarrier {
  if (depth > MAX_DEPTH) return { operation: null, arguments: null, shape };
  const record = asRecord(decodeMaybeJson(argumentsValue));

  if (isPlainOrClementineLocalTool(name, 'work_call') || isPlainOrClementineLocalTool(name, 'call_tool')) {
    if (!record) return { operation: null, arguments: null, shape };
    const inner = firstString(record, ['name', 'tool', 'operation', 'action', 'tool_slug', 'slug', 'op']);
    const innerArgsSlot = firstPresent(record, ['args_json', 'args', 'arguments', 'input', 'params', 'parameters', 'payload']);
    if (innerArgsSlot && innerArgsSlot.key !== 'args_json') shape.push(`inner_arguments_under_${innerArgsSlot.key}`);
    const innerArgs = innerArgsSlot ? decodeMaybeJson(innerArgsSlot.value) : undefined;
    if (!inner) {
      // No inner name: the payload itself may be a gateway payload.
      const payload = asRecord(innerArgs);
      if (payload && firstString(payload, OPERATION_KEYS)) {
        shape.push('inner_name_missing_payload_names_operation');
        return readGatewayPayload(payload, shape);
      }
      return { operation: null, arguments: null, shape };
    }
    if (inner.key !== 'name') shape.push(`inner_name_under_${inner.key}`);
    if (isGatewayName(inner.value)) {
      const payload = asRecord(innerArgs);
      if (!payload) return { operation: null, arguments: null, shape };
      return readGatewayPayload(payload, shape);
    }
    // The inner name IS the operation. Its arguments may still be wrapped in a
    // gateway payload (`{tool_slug, arguments}`) the model built by habit.
    const payload = asRecord(innerArgs);
    if (payload && firstString(payload, ['tool_slug']) && firstPresent(payload, ['arguments'])) {
      shape.push('operation_named_twice');
      const fromPayload = readGatewayPayload(payload, shape);
      return fromPayload.operation ? fromPayload : { ...fromPayload, operation: normalizeOperationName(inner.value) };
    }
    shape.push('operation_named_in_inner_name');
    return {
      operation: normalizeOperationName(inner.value),
      arguments: readArguments(innerArgs, shape),
      shape,
    };
  }

  if (isGatewayName(name)) {
    if (!record) return { operation: null, arguments: null, shape };
    return readGatewayPayload(record, shape);
  }

  // A direct call whose function name is the operation itself.
  shape.push('direct_operation_call');
  return {
    operation: normalizeOperationName(name),
    arguments: readArguments(argumentsValue, shape),
    shape,
  };
}

/** Read one model tool call, whatever its shape, into `{operation, arguments}`. */
export function readModelCarrier(name: string, argumentsValue: unknown): ReadCarrier {
  return readCarrierAt(name, argumentsValue, [], 0);
}

/**
 * Resolve an operation the model named against the operations proven this
 * turn. Exact identity first; then a UNIQUE affix match (the model kept a
 * namespace the catalog does not, or dropped a toolkit prefix the catalog
 * has). Two candidates is ambiguity, never a guess.
 */
export function resolveProvenOperation(
  operation: string | null | undefined,
  entries: readonly ProvenCompletionEntry[],
): ProvenOperationMatch | null {
  if (!operation) return null;
  const key = catalogOperationIdentityKey(normalizeOperationName(operation));
  if (!key) return null;
  // Dedupe by identity; a read entry wins over an unknown one for the same op.
  const byKey = new Map<string, ProvenCompletionEntry>();
  for (const entry of entries) {
    if (typeof entry.identifier !== 'string' || !entry.identifier.trim()) continue;
    const entryKey = catalogOperationIdentityKey(entry.identifier);
    if (!entryKey) continue;
    const existing = byKey.get(entryKey);
    if (!existing || (existing.effectClass !== 'read' && entry.effectClass === 'read')) byKey.set(entryKey, entry);
  }
  const exact = byKey.get(key);
  if (exact) return { identifier: exact.identifier.trim(), effectClass: exact.effectClass, match: 'exact' };
  if (key.length < MIN_AFFIX_KEY_LENGTH) return null;
  const affix = [...byKey.entries()].filter(([entryKey]) => (
    entryKey.length >= MIN_AFFIX_KEY_LENGTH
    && (entryKey.endsWith(key) || key.endsWith(entryKey))
  ));
  if (affix.length !== 1) return null;
  const [, entry] = affix[0]!;
  return { identifier: entry.identifier.trim(), effectClass: entry.effectClass, match: 'unique_affix' };
}

/**
 * The canonical gateway carrier the dispatcher understands, rebuilt from the
 * PROVEN identifier and the arguments the reader extracted. Outer host fields
 * (requirement_id, lineage keys) are preserved; every stale operation/argument
 * slot the model invented is dropped so the carrier names one operation once.
 */
export function canonicalGatewayCarrier(
  outer: Record<string, unknown> | null,
  identifier: string,
  args: Record<string, unknown> | null,
): { argumentsJson: string; innerJson: string } {
  const innerJson = JSON.stringify({
    tool_slug: identifier,
    arguments: args ? JSON.stringify(args) : null,
  });
  const preserved: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(outer ?? {})) {
    if (OPERATION_KEYS.includes(key as typeof OPERATION_KEYS[number])) continue;
    if (ARGUMENT_KEYS.includes(key as typeof ARGUMENT_KEYS[number])) continue;
    preserved[key] = value;
  }
  return {
    argumentsJson: JSON.stringify({ ...preserved, name: GATEWAY_TAIL, args_json: innerJson }),
    innerJson,
  };
}
