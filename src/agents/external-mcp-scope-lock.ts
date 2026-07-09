import { discoverMcpServers } from '../runtime/mcp-config.js';
import type { McpToolScope } from '../runtime/mcp-tool-scope.js';

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
  fallback?: McpToolScope;
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
