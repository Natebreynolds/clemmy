import { createHash } from 'node:crypto';

function normalizedToolName(toolName: string): string {
  return (toolName.split('__').at(-1) ?? toolName).trim().toLowerCase();
}

function normalizedCorrelationInput(value: unknown): unknown {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}'))
      || (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      try { return normalizedCorrelationInput(JSON.parse(trimmed)); } catch { /* keep literal */ }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizedCorrelationInput);
  if (!value || typeof value !== 'object') return value;
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    const child = (value as Record<string, unknown>)[key];
    // Strict MCP wrappers materialize omitted optional fields as null. They are
    // transport schema noise, not part of the provider call's identity.
    if (child == null) continue;
    normalized[key] = normalizedCorrelationInput(child);
  }
  return normalized;
}

/** Stable, non-payload correlation identity for a provider call and its inner
 * MCP transport row. Callers pass the original full input before any event-log
 * preview clipping; only this one-way digest is persisted. */
export function toolCallCorrelationFingerprint(toolName: string, input: unknown): string {
  let serialized: string;
  try {
    serialized = JSON.stringify([
      normalizedToolName(toolName),
      normalizedCorrelationInput(input ?? {}),
    ]);
  } catch {
    serialized = JSON.stringify([normalizedToolName(toolName), String(input ?? '')]);
  }
  return `v1:${createHash('sha256').update(serialized).digest('hex')}`;
}
