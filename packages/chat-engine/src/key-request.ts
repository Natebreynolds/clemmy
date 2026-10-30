/**
 * The key a question's card takes in a hidden field.
 *
 * When Clem asks something in a request that worked with an MCP server still
 * missing a declared key, the host attaches the server and the missing key
 * names. Names only: the owner's value goes straight to the server's
 * credential route and never into the chat. A malformed request draws no
 * fields, so the question stays an ordinary question.
 */

export interface KeyRequest {
  server: string;
  keys: string[];
}

const KEY_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

export function readKeyRequest(value: unknown): KeyRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { server, keys } = value as { server?: unknown; keys?: unknown };
  if (typeof server !== 'string' || !server.trim() || !Array.isArray(keys) || keys.length === 0) return null;
  if (!keys.every((key) => typeof key === 'string' && KEY_NAME.test(key))) return null;
  return { server, keys: (keys as string[]).slice(0, 8) };
}

/** The owner's reply once every key is saved: names the server, never a value. */
export function keyRequestSavedReply(request: KeyRequest): string {
  return request.keys.length === 1
    ? `I saved the ${request.server} key (${request.keys[0]}).`
    : `I saved the ${request.server} keys (${request.keys.join(', ')}).`;
}
