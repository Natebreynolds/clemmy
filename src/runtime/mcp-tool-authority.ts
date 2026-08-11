import { parseNamespacedTool } from './mcp-namespace-shim.js';
import { mcpToolScopeAuthority, type McpToolScope } from './mcp-tool-scope.js';

/** Canonical alias only: punctuation/case and generic transport suffixes do not
 * change identity, but arbitrary prefixes/suffixes never count as a match. */
export function canonicalMcpServerAlias(value: string): string {
  let canonical = value.toLowerCase().replace(/[^a-z0-9]+/g, '');
  // Configured servers commonly use "foo-mcp", "foo-server", or
  // "foo-mcp-server"; normalize only those generic terminal labels.
  for (;;) {
    const next = canonical.replace(/(?:mcpserver|servermcp|mcp|server)$/, '');
    if (next === canonical) return canonical;
    canonical = next;
  }
}

export function mcpServerAliasMatches(actualSlug: string, allowedAlias: string): boolean {
  const actual = canonicalMcpServerAlias(actualSlug);
  const allowed = canonicalMcpServerAlias(allowedAlias);
  return actual.length > 0 && allowed.length > 0 && actual === allowed;
}

/** Stable exact namespace identity used by packet capability leases.
 *
 * The `mcp__` prefix is only an SDK transport carrier and case is not material,
 * but the advertised server namespace itself stays exact. Generic server-name
 * aliases (`foo`, `foo-mcp`, `foo-server`) are useful while resolving a packet
 * against the configured catalog; they are NOT authority-equal after that
 * resolution. Otherwise two distinct live servers with alias-confusable names
 * could satisfy the same exact lease, with list order deciding which endpoint
 * actually ran.
 */
export function canonicalMcpToolIdentity(toolName: string): string | null {
  // Claude/MCP catalogs commonly spell the carrier as `mcp__server__tool`.
  // `mcp` is transport, not the server identity.
  const normalized = toolName.trim().replace(/^mcp__/i, '');
  if (!/^[A-Za-z0-9._-]+__[A-Za-z0-9._-]+$/.test(normalized)) return null;
  const parsed = parseNamespacedTool(normalized);
  if (!parsed) return null;
  const server = parsed.serverSlug.trim().toLowerCase();
  const tool = parsed.toolName.trim().toLowerCase();
  return server && tool ? `${server}__${tool}` : null;
}

export function stripMcpToolCarrier(toolName: string): string {
  return toolName.trim().replace(/^mcp__/i, '');
}

/**
 * May this exact tool run on this turn?
 *
 * The only inputs are the user's decision (`authority`) and, when that decision
 * named specific tools, exact identity. Relevance signals are deliberately
 * absent: `maxTools`, `serverMaxTools`, `priorityKeywords`, `toolPatterns` and
 * the ranked selection all describe what the model was SHOWN, and a tool the
 * user connected does not become forbidden by losing a ranking race.
 *
 * The catalog itself is enforced downstream, where it is actually known — the
 * namespace shim can only route to a configured, enabled server, so an
 * unauthorized name has nowhere to land.
 *
 * `undefined` preserves legacy callers with no per-run scope. `null` is an
 * explicit deny used by locked workflow/worker lanes.
 */
export function mcpToolAllowedByScope(
  toolName: string,
  scope: McpToolScope | null | undefined,
): boolean {
  if (scope === undefined) return true;
  if (scope === null) return false;

  const normalizedToolName = stripMcpToolCarrier(toolName);
  const parsed = parseNamespacedTool(normalizedToolName);
  if (!parsed) return false;

  // An explicit exclusion outranks every grant. "Use Sheets, not Outlook" is a
  // decision about Outlook, and no amount of catalog authority reopens it.
  const denied = scope.deniedServerSlugs ?? [];
  if (denied.some((raw) => mcpServerAliasMatches(parsed.serverSlug, raw))) return false;

  const authority = mcpToolScopeAuthority(scope);
  if (authority === 'none') return false;
  if (authority === 'catalog') return true;

  if (authority === 'server_set') {
    // Bound to a set of systems, free within them. The tool name is not
    // constrained — a worker given Firecrawl may use any Firecrawl tool — but
    // the server is, so the lane cannot reach a system it was never handed.
    const allowed = scope.allowedServerSlugs ?? [];
    return allowed.some((raw) => mcpServerAliasMatches(parsed.serverSlug, raw));
  }

  // 'exact': one precise capability was bound (typed worker lease, approval
  // resume). Alias-confusable siblings must not satisfy it.
  const exactNames = new Set((scope.allowedToolNames ?? [])
    .map(canonicalMcpToolIdentity)
    .filter((value): value is string => Boolean(value)));
  const identity = canonicalMcpToolIdentity(toolName);
  return Boolean(identity && exactNames.has(identity));
}

const agentScopes = new WeakMap<object, McpToolScope | null>();

/** Bind the exact construction-time scope to an Agent without mutating the SDK
 * object. The loop uses this to install the same authority in AsyncLocalStorage
 * for nested carriers such as run_tool_program and worker fan-out. */
export function bindAgentMcpToolScope(
  agent: object,
  scope: McpToolScope | null | undefined,
): void {
  if (scope === undefined) return;
  agentScopes.set(agent, scope);
}

export function boundAgentMcpToolScope(
  agent: object,
): { bound: boolean; scope: McpToolScope | null | undefined } {
  return agentScopes.has(agent)
    ? { bound: true, scope: agentScopes.get(agent) }
    : { bound: false, scope: undefined };
}
