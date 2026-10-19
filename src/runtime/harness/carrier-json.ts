/**
 * One reading of a carrier's argument slot (`args_json`, `arguments`, …),
 * shared by the carrier reader, carrier completion, effective tool identity
 * and the pre-dispatch shape check, so they can never disagree about what a
 * call names.
 *
 * The contract is a JSON object encoded once. A model sometimes serializes its
 * own serialization, so a slot quoted as a JSON string is unwrapped, up to a
 * small bound. Only the slot itself is decoded: the fields inside the decoded
 * arguments keep their exact text, so a message body that holds JSON or quoted
 * words is never rewritten. Windows tester trace 2026-10-19: a send retried
 * with one more encoding layer was read as no operation by one parser and as
 * a valid one by another, and recovery named the gateway itself as the
 * missing business operation.
 */

/** Encodings beyond the contract's one that are still read. */
export const MAX_CARRIER_JSON_LAYERS = 3;

export type CarrierJsonProblem = 'empty' | 'invalid_json' | 'not_a_container' | 'too_many_layers';

export type CarrierJsonRead =
  | { ok: true; value: Record<string, unknown> | unknown[]; layers: number }
  | { ok: false; problem: CarrierJsonProblem; layers: number; detail?: string };

/** Decode a slot that is a JSON object or array, possibly quoted as a JSON
 * string up to MAX_CARRIER_JSON_LAYERS times. A non-string is read as is. */
export function readCarrierJsonSlot(value: unknown): CarrierJsonRead {
  if (value !== null && typeof value === 'object') {
    return { ok: true, value: value as Record<string, unknown> | unknown[], layers: 0 };
  }
  if (typeof value !== 'string') return { ok: false, problem: 'not_a_container', layers: 0 };
  let text = value;
  for (let layers = 0; ; layers += 1) {
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, problem: 'empty', layers };
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        return parsed !== null && typeof parsed === 'object'
          ? { ok: true, value: parsed as Record<string, unknown> | unknown[], layers: layers + 1 }
          : { ok: false, problem: 'not_a_container', layers: layers + 1 };
      } catch (error) {
        return { ok: false, problem: 'invalid_json', layers, detail: error instanceof Error ? error.message : String(error) };
      }
    }
    if (!trimmed.startsWith('"')) {
      try { JSON.parse(trimmed); } catch (error) {
        return { ok: false, problem: 'invalid_json', layers, detail: error instanceof Error ? error.message : String(error) };
      }
      return { ok: false, problem: 'not_a_container', layers: layers + 1 };
    }
    if (layers >= MAX_CARRIER_JSON_LAYERS) return { ok: false, problem: 'too_many_layers', layers };
    let inner: unknown;
    try { inner = JSON.parse(trimmed); } catch (error) {
      return { ok: false, problem: 'invalid_json', layers, detail: error instanceof Error ? error.message : String(error) };
    }
    if (typeof inner !== 'string') return { ok: false, problem: 'not_a_container', layers: layers + 1 };
    text = inner;
  }
}

/** The slot's arguments object, or null when it does not decode to one. */
export function carrierJsonObject(value: unknown): Record<string, unknown> | null {
  const read = readCarrierJsonSlot(value);
  return read.ok && !Array.isArray(read.value) ? read.value : null;
}

/** The decoded container, or the original value when the slot is not one. */
export function carrierJsonOrOriginal(value: unknown): unknown {
  const read = readCarrierJsonSlot(value);
  return read.ok ? read.value : value;
}

/** The reason an `args_json` slot cannot carry an operation's arguments, in
 * the words a pre-dispatch refusal uses; null when it reads as an object. */
export function carrierArgumentsProblem(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const read = readCarrierJsonSlot(value);
  if (read.ok) return Array.isArray(read.value) ? 'args_json decodes to a list, not an object of the operation\'s arguments' : null;
  switch (read.problem) {
    case 'empty': return 'args_json is an empty string';
    case 'invalid_json': return `args_json is not valid JSON (${value.length} chars; ${read.detail ?? 'unparseable'})`;
    case 'too_many_layers': return `args_json is JSON-encoded more than ${MAX_CARRIER_JSON_LAYERS + 1} times`;
    case 'not_a_container': return 'args_json decodes to a single value, not an object of the operation\'s arguments';
  }
}
