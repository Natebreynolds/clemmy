const RESERVED_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export const CLOSED_CANONICAL_JSON_DEFAULTS = Object.freeze({
  maxDepth: 32,
  maxNodes: 20_000,
  maxStringBytes: 64_000,
  maxTotalBytes: 512_000,
});

/**
 * One bound for every door a sealed workflow call's ARGUMENTS pass through
 * (argument compilation, executor canonicalization, the runner's drift
 * comparison). Sized to what the transports on either side already accept —
 * a reviewed-CLI read may return 1 MiB of stdout and a workspace dataset
 * commit carries several such results in one argument — not to a chat-sized
 * payload. Four doors with four different caps refused the Friday dashboard's
 * 75 KB `space_set_data` commit one door at a time (2026-09-02). The bound
 * keeps the canonical form finite; it does not decide what a workflow may commit.
 */
export const SEALED_CALL_CANONICAL_LIMITS = Object.freeze({
  maxDepth: 32,
  maxNodes: 2_000_000,
  maxStringBytes: 8_000_000,
  maxTotalBytes: 8_000_000,
});

export function isClosedCanonicalJsonLimitError(error: unknown): error is ClosedCanonicalJsonError {
  return error instanceof ClosedCanonicalJsonError
    && (error.code === 'string_limit' || error.code === 'total_byte_limit' || error.code === 'node_limit');
}

export interface ClosedCanonicalJsonOptions {
  maxDepth?: number;
  maxNodes?: number;
  maxStringBytes?: number;
  maxTotalBytes?: number;
}

export class ClosedCanonicalJsonError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'unsupported_type'
      | 'non_finite_number'
      | 'non_plain_object'
      | 'accessor_property'
      | 'symbol_key'
      | 'reserved_key'
      | 'sparse_array'
      | 'extra_array_property'
      | 'cyclic'
      | 'depth_limit'
      | 'node_limit'
      | 'string_limit'
      | 'total_byte_limit',
    readonly path: string,
  ) {
    super(`${message} at ${path}`);
    this.name = 'ClosedCanonicalJsonError';
  }
}

function positiveLimit(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && Number(value) > 0 ? Number(value) : fallback;
}

/**
 * Encode the closed JSON value domain into deterministic bytes.
 *
 * Unlike JSON.stringify, this never calls toJSON/getters, never drops unknown
 * values, and never treats prototype-bearing objects as data. The encoder
 * inspects property descriptors before reading any value and bounds work while
 * traversing, so the returned bytes are the complete value that was reviewed.
 */
export function closedCanonicalJson(
  value: unknown,
  options: ClosedCanonicalJsonOptions = {},
): string {
  const maxDepth = positiveLimit(options.maxDepth, CLOSED_CANONICAL_JSON_DEFAULTS.maxDepth);
  const maxNodes = positiveLimit(options.maxNodes, CLOSED_CANONICAL_JSON_DEFAULTS.maxNodes);
  const maxStringBytes = positiveLimit(
    options.maxStringBytes,
    CLOSED_CANONICAL_JSON_DEFAULTS.maxStringBytes,
  );
  const maxTotalBytes = positiveLimit(
    options.maxTotalBytes,
    CLOSED_CANONICAL_JSON_DEFAULTS.maxTotalBytes,
  );
  const seen = new Set<object>();
  let nodes = 0;
  let bytes = 0;

  const token = (text: string, path: string): string => {
    bytes += Buffer.byteLength(text, 'utf8');
    if (bytes > maxTotalBytes) {
      throw new ClosedCanonicalJsonError(
        'canonical JSON exceeds the total byte limit',
        'total_byte_limit',
        path,
      );
    }
    return text;
  };
  const encodeString = (text: string, path: string): string => {
    if (Buffer.byteLength(text, 'utf8') > maxStringBytes) {
      throw new ClosedCanonicalJsonError(
        'string exceeds the canonical JSON string limit',
        'string_limit',
        path,
      );
    }
    return token(JSON.stringify(text), path);
  };
  const visit = (input: unknown, path: string, depth: number): string => {
    nodes += 1;
    if (nodes > maxNodes) {
      throw new ClosedCanonicalJsonError('canonical JSON exceeds the node limit', 'node_limit', path);
    }
    if (depth > maxDepth) {
      throw new ClosedCanonicalJsonError('canonical JSON exceeds the depth limit', 'depth_limit', path);
    }
    if (input === null) return token('null', path);
    if (typeof input === 'string') return encodeString(input, path);
    if (typeof input === 'boolean') return token(input ? 'true' : 'false', path);
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) {
        throw new ClosedCanonicalJsonError('number is not finite', 'non_finite_number', path);
      }
      return token(JSON.stringify(input), path);
    }
    if (typeof input !== 'object') {
      throw new ClosedCanonicalJsonError('value is outside the closed JSON domain', 'unsupported_type', path);
    }
    if (seen.has(input)) {
      throw new ClosedCanonicalJsonError('value is cyclic', 'cyclic', path);
    }
    if (Object.getOwnPropertySymbols(input).length > 0) {
      throw new ClosedCanonicalJsonError('symbol keys are not JSON data', 'symbol_key', path);
    }

    const prototype = Object.getPrototypeOf(input);
    if (Array.isArray(input)) {
      if (prototype !== Array.prototype) {
        throw new ClosedCanonicalJsonError('array has a foreign prototype', 'non_plain_object', path);
      }
      const descriptors = Object.getOwnPropertyDescriptors(input);
      const names = Object.getOwnPropertyNames(input);
      for (const name of names) {
        if (name === 'length') continue;
        if (!/^(0|[1-9]\d*)$/.test(name) || Number(name) >= input.length) {
          throw new ClosedCanonicalJsonError(
            'array has an extra non-index property',
            'extra_array_property',
            `${path}.${name}`,
          );
        }
      }
      seen.add(input);
      try {
        token('[', path);
        const children: string[] = [];
        for (let index = 0; index < input.length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (!descriptor) {
            throw new ClosedCanonicalJsonError('array is sparse', 'sparse_array', `${path}[${index}]`);
          }
          if ('get' in descriptor || 'set' in descriptor) {
            throw new ClosedCanonicalJsonError(
              'accessor properties are not canonical JSON',
              'accessor_property',
              `${path}[${index}]`,
            );
          }
          if (index > 0) token(',', path);
          children.push(visit(descriptor.value, `${path}[${index}]`, depth + 1));
        }
        token(']', path);
        return `[${children.join(',')}]`;
      } finally {
        seen.delete(input);
      }
    }
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ClosedCanonicalJsonError('object is not plain JSON', 'non_plain_object', path);
    }
    const descriptors = Object.getOwnPropertyDescriptors(input);
    const keys = Object.getOwnPropertyNames(input).sort();
    seen.add(input);
    try {
      token('{', path);
      const fields: string[] = [];
      for (let index = 0; index < keys.length; index += 1) {
        const key = keys[index];
        const keyPath = `${path}.${key}`;
        if (RESERVED_KEYS.has(key)) {
          throw new ClosedCanonicalJsonError('reserved prototype key is forbidden', 'reserved_key', keyPath);
        }
        const descriptor = descriptors[key];
        if (!descriptor || !descriptor.enumerable || 'get' in descriptor || 'set' in descriptor) {
          throw new ClosedCanonicalJsonError(
            'hidden or accessor properties are not canonical JSON',
            'accessor_property',
            keyPath,
          );
        }
        if (index > 0) token(',', path);
        const encodedKey = encodeString(key, keyPath);
        token(':', keyPath);
        fields.push(`${encodedKey}:${visit(descriptor.value, keyPath, depth + 1)}`);
      }
      token('}', path);
      return `{${fields.join(',')}}`;
    } finally {
      seen.delete(input);
    }
  };

  const encoded = visit(value, '$', 0);
  // The incremental accounting prevents oversized inputs from being fully
  // materialized; this final check pins the exact returned byte sequence too.
  if (Buffer.byteLength(encoded, 'utf8') > maxTotalBytes) {
    throw new ClosedCanonicalJsonError(
      'canonical JSON exceeds the total byte limit',
      'total_byte_limit',
      '$',
    );
  }
  return encoded;
}
