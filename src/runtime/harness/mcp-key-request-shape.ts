/** The server and missing key names attached to Clem's question. Names
 *  only; a value never travels with the question. */
export interface McpKeyRequest {
  server: string;
  keys: string[];
}

/** A well-formed request as the screens receive it. */
export function parseMcpKeyRequest(value: unknown): McpKeyRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { server, keys } = value as { server?: unknown; keys?: unknown };
  if (typeof server !== 'string' || !server.trim() || !Array.isArray(keys)) return null;
  const names = keys.filter((key): key is string => typeof key === 'string' && /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key));
  return names.length > 0 && names.length === keys.length ? { server, keys: names.slice(0, 8) } : null;
}
