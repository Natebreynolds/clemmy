import { discoverMcpServers } from '../runtime/mcp-config.js';
import type { McpToolScope } from '../runtime/mcp-tool-scope.js';
import { mcpServerAliasMatches } from '../runtime/mcp-tool-authority.js';

function scopeLockEnabled(allowed?: string[] | null): boolean {
  if (!allowed || allowed.length === 0) return false;
  return !allowed.some((a) => typeof a === 'string' && (a === '*' || a === '**' || a.trim() === ''));
}

function slugifyMcpServerName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_{2,}/g, '_');
  return slug || 'server';
}

function normalizeMcpAlias(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function serverAliasVariants(name: string): string[] {
  const slug = slugifyMcpServerName(name);
  const base = slug
    .replace(/(?:[_-]?mcp)?[_-]?server$/i, '')
    .replace(/[_-]?mcp$/i, '');
  const values = new Set([name.toLowerCase(), slug, base, normalizeMcpAlias(name), normalizeMcpAlias(slug), normalizeMcpAlias(base)]);
  const variants = new Set<string>();
  for (const raw of values) {
    const value = raw.trim().replace(/^[_\-.]+|[_\-.]+$/g, '');
    if (!value) continue;
    variants.add(value);
    variants.add(value.replace(/-/g, '_'));
    variants.add(value.replace(/_/g, '-'));
  }
  return [...variants].filter((value) => value.length >= 2);
}

function stripMcpAllowedPrefix(entry: string, aliases: string[]): string | null {
  const first = entry.trim().toLowerCase();
  const candidates = [first];
  if (first.startsWith('mcp__')) candidates.push(first.slice('mcp__'.length));
  for (const candidate of candidates) {
    for (const alias of aliases) {
      if (candidate === alias) return '';
      for (const sep of ['__', '-']) {
        const prefix = `${alias}${sep}`;
        if (candidate.startsWith(prefix)) return candidate.slice(prefix.length);
      }
    }
  }
  return null;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toolPatternFromTail(tail: string): string | null {
  const cleaned = tail
    .replace(/\*+$/g, '')
    .replace(/^[_\-.]+|[_\-.]+$/g, '')
    .trim();
  if (!cleaned || cleaned === '*') return null;
  const tokens = cleaned.split(/[^a-z0-9]+/i).filter(Boolean);
  if (tokens.length === 0) return null;
  return tokens.map((token) => escapeRegex(token.toLowerCase())).join('[^a-z0-9]+');
}

export function externalMcpScopeForAllowedToolLock(args: {
  allowed?: string[] | null;
  fallback?: McpToolScope | null;
  serverNames?: string[];
  reason: string;
}): McpToolScope | null | undefined {
  const { allowed, fallback, serverNames, reason } = args;
  if (!scopeLockEnabled(allowed)) return fallback;

  const names = serverNames ?? discoverMcpServers().filter((server) => server.enabled).map((server) => server.name);
  if (names.length === 0) return null;

  const matches = new Map<string, { patterns: Set<string> }>();
  for (const name of names) {
    const aliases = serverAliasVariants(name);
    const slug = slugifyMcpServerName(name);
    for (const raw of allowed ?? []) {
      if (typeof raw !== 'string') continue;
      const tail = stripMcpAllowedPrefix(raw, aliases);
      if (tail === null) continue;
      const entry = matches.get(slug) ?? { patterns: new Set<string>() };
      const pattern = toolPatternFromTail(tail);
      if (pattern) entry.patterns.add(pattern);
      matches.set(slug, entry);
    }
  }

  if (matches.size === 0) return null;

  const allowedServerSlugs = [...matches.keys()].sort();
  const toolPatterns = [...new Set([...matches.values()].flatMap((match) => [...match.patterns]))].sort();
  return {
    reason: `${reason}: ${allowedServerSlugs.join(', ')}`,
    allowedServerSlugs,
    ...(toolPatterns.length > 0 ? { toolPatterns } : {}),
  };
}

export function candidatesFromResolvedTools(resolvedTools: string | null | undefined): string[] {
  const text = (resolvedTools ?? '').trim();
  if (!text) return [];
  const out = new Set<string>();
  for (const match of text.matchAll(/`([^`]+)`/g)) {
    const value = match[1]?.trim();
    if (value) out.add(value);
  }
  for (const value of text.match(/[A-Za-z0-9][A-Za-z0-9._-]*(?:__[A-Za-z0-9._-]+)?/g) ?? []) {
    out.add(value);
  }
  return [...out];
}

export function externalMcpScopeFromResolvedTools(
  resolvedTools: string | null | undefined,
  serverNames?: string[],
): McpToolScope | null {
  const allowed = candidatesFromResolvedTools(resolvedTools);
  return externalMcpScopeForAllowedToolLock({
    allowed,
    serverNames,
    reason: 'worker resolvedTools external MCP lock',
  }) ?? null;
}

function optionalCapMin(...values: Array<number | undefined>): number | undefined {
  const finite = values.filter((value): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0);
  return finite.length > 0 ? Math.min(...finite.map((value) => Math.floor(value))) : undefined;
}

function matchingServerCap(scope: McpToolScope, serverSlug: string): number | undefined {
  const matches = Object.entries(scope.serverMaxTools ?? {})
    .filter(([candidate]) => mcpServerAliasMatches(candidate, serverSlug))
    .map(([, cap]) => cap);
  return optionalCapMin(...matches);
}

function andPattern(left: string, right: string): string {
  // McpToolScope patterns are OR'd by the filter. Encode one parent×child pair
  // as two positive lookaheads so the resulting OR-of-pairs is a true
  // intersection rather than an accidental union.
  return `(?=[\\s\\S]*(?:${left}))(?=[\\s\\S]*(?:${right}))[\\s\\S]*`;
}

function intersectPatterns(parent: string[] | undefined, child: string[] | undefined): string[] | undefined {
  const p = [...new Set((parent ?? []).filter(Boolean))];
  const c = [...new Set((child ?? []).filter(Boolean))];
  if (p.length === 0) return c.length > 0 ? c : undefined;
  if (c.length === 0) return p;
  return [...new Set(p.flatMap((left) => c.map((right) => andPattern(left, right))))];
}

/**
 * Compose a worker packet's exact external-MCP request with the parent's
 * authority. This is a real intersection:
 *
 * - null on either side stays local-only;
 * - broad allowAll/fail-open authority yields to the packet but retains caps;
 * - concrete server families must overlap by alias;
 * - concrete tool patterns are ANDed, not ORed;
 * - every global/per-server cap takes the smaller value.
 *
 * A child can therefore narrow a parent but can never drift to another tool in
 * the same server or widen to a sibling server.
 */
export function intersectExternalMcpToolScopes(
  parent: McpToolScope | null | undefined,
  child: McpToolScope | null | undefined,
  reason = 'worker parent/packet external MCP intersection',
): McpToolScope | null | undefined {
  if (parent === null || child === null) return null;
  if (parent === undefined) return child;
  if (child === undefined) return parent;

  const parentBroad = parent.allowAll === true || parent.failOpenCandidate === true;
  const childBroad = child.allowAll === true || child.failOpenCandidate === true;
  let allowedServerSlugs: string[] | undefined;
  if (parentBroad && childBroad) {
    allowedServerSlugs = child.allowedServerSlugs ?? parent.allowedServerSlugs;
  } else if (parentBroad) {
    allowedServerSlugs = child.allowedServerSlugs;
  } else if (childBroad) {
    allowedServerSlugs = parent.allowedServerSlugs;
  } else {
    const parentServers = parent.allowedServerSlugs ?? [];
    const childServers = child.allowedServerSlugs ?? [];
    allowedServerSlugs = childServers.filter((childSlug) =>
      parentServers.some((parentSlug) => mcpServerAliasMatches(parentSlug, childSlug)));
    if (allowedServerSlugs.length === 0) return null;
  }

  // A broad×broad composition stays broad. Worker packet scopes are normally
  // concrete, but preserving this case makes the helper safe for other callers.
  const remainsBroad = parentBroad && childBroad && (!allowedServerSlugs || allowedServerSlugs.length === 0);
  const toolPatterns = parentBroad
    ? child.toolPatterns
    : childBroad
      ? parent.toolPatterns
      : intersectPatterns(parent.toolPatterns, child.toolPatterns);
  const maxTools = optionalCapMin(parent.maxTools, child.maxTools);
  const priorityKeywords = [...new Set([
    ...(parent.priorityKeywords ?? []),
    ...(child.priorityKeywords ?? []),
  ])];
  const serverMaxTools: Record<string, number> = {};
  for (const serverSlug of allowedServerSlugs ?? []) {
    const cap = optionalCapMin(
      matchingServerCap(parent, serverSlug),
      matchingServerCap(child, serverSlug),
    );
    if (cap !== undefined) serverMaxTools[serverSlug] = cap;
  }

  return {
    reason,
    ...(remainsBroad
      ? (parent.allowAll && child.allowAll ? { allowAll: true } : { failOpenCandidate: true })
      : { allowedServerSlugs: [...new Set(allowedServerSlugs ?? [])].sort() }),
    ...(toolPatterns && toolPatterns.length > 0 ? { toolPatterns } : {}),
    ...(priorityKeywords.length > 0 ? { priorityKeywords } : {}),
    ...(maxTools !== undefined ? { maxTools } : {}),
    ...(Object.keys(serverMaxTools).length > 0 ? { serverMaxTools } : {}),
    ...(child.queryText || parent.queryText ? { queryText: child.queryText ?? parent.queryText } : {}),
  };
}
