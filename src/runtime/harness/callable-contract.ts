/**
 * One logical call, one contract — whatever carrier it arrived in.
 *
 * The same read reached the harness as an object at 17:35 and as a JSON string
 * at 17:39 of one accepted turn, so identity, validation and dispatch each saw
 * two different calls. Resolving that here, once, is what makes step identity
 * and schema validation mean anything.
 *
 * The hard rule this module learned the expensive way: **a payload is data.**
 * An earlier version searched any object for `name`, `tool`, `method`, `input`,
 * `payload` or `params` and treated whatever it found as the capability being
 * invoked — so a record titled "Q3 Report" renamed the call to `q3 report`, and
 * a payment whose `method` was "wire transfer" became the tool `wire transfer`.
 * Ordinary content must never be able to rename a trusted call, so carriers are
 * now DISCRIMINATED: a shape declares that it wraps a call, or it is data.
 */
import { createHash } from 'node:crypto';

export interface CallableContract {
  /** The capability being invoked, canonical and case-folded. */
  toolName: string;
  /** Arguments as a plain object. */
  args: Record<string, unknown>;
  /** Set when the carrier could not be parsed; the call must not dispatch. */
  error?: 'invalid_arguments';
  /** Bounded reason for the failure, safe to show a model. */
  errorDetail?: string;
}

/**
 * The only keys that may NAME a capability, and only inside a provider carrier
 * that also carries an arguments field. Deliberately narrow: these are wire
 * conventions, not words that might appear in someone's data.
 */
const CARRIER_NAME_KEYS = ['tool_slug', 'toolSlug', 'slug'] as const;
/** The only keys that may HOLD wrapped arguments inside such a carrier. */
const CARRIER_ARG_KEYS = [
  'arguments',
  'arguments_json',
  'argumentsJson',
  'args',
  'args_json',
  'argsJson',
] as const;

export type CallableCarrier =
  /** A trusted name with a data payload. The payload is never inspected for a name. */
  | { kind: 'direct'; toolName: string; args: unknown }
  /** A provider carrier object: `{tool_slug, arguments}`. */
  | { kind: 'provider_carrier'; carrier: Record<string, unknown>; toolName?: string }
  /** A carrier serialized as JSON text. */
  | { kind: 'carrier_json'; raw: string; toolName?: string };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function isDiscriminated(value: unknown): value is CallableCarrier {
  const record = asRecord(value);
  return record?.kind === 'direct'
    || record?.kind === 'provider_carrier'
    || record?.kind === 'carrier_json';
}

/**
 * A provider carrier declares itself structurally: it names a tool with a
 * carrier key AND holds arguments under a carrier key. Both are required —
 * one alone is just an object that happens to have a field.
 */
function readProviderCarrier(
  value: unknown,
): { toolName: string; rawArgs: unknown } | null {
  const record = asRecord(value);
  if (!record) return null;
  const nameKey = CARRIER_NAME_KEYS.find((key) => typeof record[key] === 'string' && (record[key] as string).trim());
  if (!nameKey) return null;
  const argKey = CARRIER_ARG_KEYS.find((key) => key in record);
  if (!argKey) return null;
  return { toolName: (record[nameKey] as string).trim(), rawArgs: record[argKey] };
}

function parseJsonObject(raw: string): { value: Record<string, unknown> } | { error: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { error: 'empty argument payload' };
  if (!trimmed.startsWith('{')) return { error: 'argument payload is not a JSON object' };
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    const record = asRecord(parsed);
    return record ? { value: record } : { error: 'argument payload is not a JSON object' };
  } catch (err) {
    return { error: `argument payload is not valid JSON: ${(err as Error).message.slice(0, 80)}` };
  }
}

/** Resolve an arguments slot that may be an object or a JSON string. */
function resolveArgs(rawArgs: unknown): { args: Record<string, unknown> } | { error: string } {
  if (rawArgs === undefined || rawArgs === null) return { args: {} };
  const record = asRecord(rawArgs);
  if (record) return { args: record };
  if (typeof rawArgs === 'string') {
    const parsed = parseJsonObject(rawArgs);
    return 'error' in parsed ? parsed : { args: parsed.value };
  }
  return { error: `arguments must be an object or JSON string, got ${typeof rawArgs}` };
}

function failed(toolName: string, detail: string): CallableContract {
  // A call whose arguments cannot be read must not dispatch with `{}` — that
  // silently drops what the user asked for and then reports success.
  return { toolName: canonicalToolName(toolName), args: {}, error: 'invalid_arguments', errorDetail: detail };
}

function canonicalToolName(value: string): string {
  return value.trim().replace(/^mcp__/i, '').toLowerCase();
}

/**
 * Resolve any carrier to one contract.
 *
 * `trustedToolName` is the name the RUNTIME knows for this call. It always
 * wins: nothing inside a payload can displace it.
 */
export function normalizeCallableArguments(
  carrier: unknown,
  trustedToolName = '',
): CallableContract {
  if (isDiscriminated(carrier)) {
    switch (carrier.kind) {
      case 'direct': {
        const resolved = resolveArgs(carrier.args);
        if ('error' in resolved) return failed(carrier.toolName || trustedToolName, resolved.error);
        return { toolName: canonicalToolName(carrier.toolName || trustedToolName), args: resolved.args };
      }
      case 'provider_carrier': {
        const provider = readProviderCarrier(carrier.carrier);
        if (!provider) return failed(carrier.toolName || trustedToolName, 'carrier declares no tool/arguments pair');
        const resolved = resolveArgs(provider.rawArgs);
        if ('error' in resolved) return failed(provider.toolName, resolved.error);
        return { toolName: canonicalToolName(provider.toolName), args: resolved.args };
      }
      case 'carrier_json': {
        const parsed = parseJsonObject(carrier.raw);
        if ('error' in parsed) return failed(carrier.toolName || trustedToolName, parsed.error);
        return normalizeCallableArguments(
          { kind: 'provider_carrier', carrier: parsed.value, toolName: carrier.toolName },
          trustedToolName,
        );
      }
    }
  }

  // Undiscriminated input. A provider carrier is recognised structurally; a
  // JSON string is parsed and re-checked. ANYTHING ELSE IS DATA — it keeps the
  // trusted name and is passed through untouched.
  if (typeof carrier === 'string') {
    const parsed = parseJsonObject(carrier);
    if ('error' in parsed) return failed(trustedToolName, parsed.error);
    const provider = readProviderCarrier(parsed.value);
    if (provider) {
      const resolved = resolveArgs(provider.rawArgs);
      if ('error' in resolved) return failed(provider.toolName, resolved.error);
      return { toolName: canonicalToolName(provider.toolName), args: resolved.args };
    }
    return { toolName: canonicalToolName(trustedToolName), args: parsed.value };
  }

  const provider = readProviderCarrier(carrier);
  if (provider) {
    const resolved = resolveArgs(provider.rawArgs);
    if ('error' in resolved) return failed(provider.toolName, resolved.error);
    return { toolName: canonicalToolName(provider.toolName), args: resolved.args };
  }

  const record = asRecord(carrier);
  return { toolName: canonicalToolName(trustedToolName), args: record ?? {} };
}

/**
 * A stable identity for "this capability with these arguments".
 *
 * Hashes the COMPLETE canonical value. An earlier version truncated the
 * argument material at 512 characters, so two payloads differing only past that
 * point collided and one real step was mistaken for a repeat of another.
 */
export function callableContractIdentity(contract: CallableContract): string {
  const canonical = (value: unknown, depth = 0): unknown => {
    if (depth > 32) return '[depth]';
    if (Array.isArray(value)) return value.map((entry) => canonical(entry, depth + 1));
    const record = asRecord(value);
    if (!record) return value ?? null;
    return Object.fromEntries(
      Object.entries(record)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, canonical(entry, depth + 1)]),
    );
  };
  let serialized = '';
  try {
    serialized = JSON.stringify(canonical(contract.args)) ?? 'null';
  } catch {
    // Cyclic or unserializable arguments still need a stable identity; fall
    // back to a shape digest rather than collapsing every such call together.
    serialized = `unserializable:${Object.keys(contract.args).sort().join(',')}`;
  }
  const digest = createHash('sha256').update(serialized).digest('hex');
  return `${contract.toolName} ${digest}`;
}
