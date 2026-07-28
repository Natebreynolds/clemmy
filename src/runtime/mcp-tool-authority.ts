import { parseNamespacedTool } from './mcp-namespace-shim.js';
import type { McpToolScope } from './mcp-tool-scope.js';

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

/**
 * MCP scope is an authority boundary, not merely an advertisement hint.
 *
 * `undefined` intentionally preserves legacy callers that have no per-run
 * scope. `null` is an explicit deny (used by locked workflow/worker lanes).
 * Concrete scopes admit only their selected server/tool family; an explicit
 * zero cap remains a deny even when a server slug is present.
 */
export function mcpToolAllowedByScope(
  toolName: string,
  scope: McpToolScope | null | undefined,
): boolean {
  if (scope === undefined) return true;
  if (scope === null) return false;

  const parsed = parseNamespacedTool(toolName);
  if (!parsed) return false;
  if (scope.maxTools === 0) return false;
  if (scope.allowAll) return true;
  if (scope.failOpenCandidate) return true;

  const allowedSlugs = scope.allowedServerSlugs ?? [];
  if (allowedSlugs.length === 0) return false;
  const serverAllowed = allowedSlugs.some((raw) =>
    mcpServerAliasMatches(parsed.serverSlug, raw));
  if (!serverAllowed) return false;

  const patterns = (scope.toolPatterns ?? []).flatMap((source) => {
    try {
      return [new RegExp(source, 'i')];
    } catch {
      return [];
    }
  });
  if (patterns.length === 0) return true;
  const haystack = `${toolName} ${parsed.serverSlug} ${parsed.toolName}`;
  return patterns.some((pattern) => pattern.test(haystack));
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
