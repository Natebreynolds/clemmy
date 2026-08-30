import { createHash } from 'node:crypto';

/**
 * Deterministic JSON identity used for schemas and other already-closed JSON
 * values. Object key order is not identity; undefined object members are
 * omitted exactly as they were in the original tool-contract implementation.
 *
 * This module is deliberately storage-free so sealed implementation artifacts
 * can verify current definition bytes without importing a cache, event log, or
 * native database binding.
 */
export function stableJsonStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableJsonStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, nested]) => nested !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, nested]) => (
    `${JSON.stringify(key)}:${stableJsonStringify(nested)}`
  )).join(',')}}`;
}

export function stableJsonDigest(value: unknown): string {
  return createHash('sha256').update(stableJsonStringify(value)).digest('hex');
}

export function stableJsonFingerprint(value: unknown): string {
  return stableJsonDigest(value).slice(0, 32);
}
