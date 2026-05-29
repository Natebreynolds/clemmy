import type { MCPServer } from '@openai/agents';
import { parseNamespacedTool } from './mcp-namespace-shim.js';
import type { McpToolScope } from './mcp-tool-scope.js';

type MCPTool = Awaited<ReturnType<MCPServer['listTools']>>[number];
type RankedTool = { tool: MCPTool; index: number; score: number; serverSlug: string | null };

function compilePatterns(patterns: string[] | undefined): RegExp[] {
  return (patterns ?? []).flatMap((pattern) => {
    try {
      return [new RegExp(pattern, 'i')];
    } catch {
      return [];
    }
  });
}

function normalizedHaystack(tool: MCPTool): string {
  const parsed = parseNamespacedTool(tool.name);
  return [
    tool.name,
    parsed?.serverSlug ?? '',
    parsed?.toolName ?? '',
    typeof tool.description === 'string' ? tool.description : '',
  ].join(' ').toLowerCase();
}

function scoreTool(tool: MCPTool, priorityKeywords: string[] | undefined): number {
  if (!priorityKeywords || priorityKeywords.length === 0) return 0;
  const haystack = normalizedHaystack(tool);
  let score = 0;
  for (const keyword of priorityKeywords) {
    const normalized = keyword.toLowerCase();
    if (!normalized) continue;
    if (haystack.includes(normalized)) score += 5;
  }
  // Prefer concrete tools over the synthetic unavailable stubs when a cap
  // applies, but keep stubs visible when no real tools match.
  if (tool.name.endsWith('__unavailable')) score -= 50;
  return score;
}

function toolMatchesScope(tool: MCPTool, scope: McpToolScope, patterns: RegExp[]): boolean {
  if (scope.allowAll) return true;
  const parsed = parseNamespacedTool(tool.name);
  const allowedSlugs = new Set(scope.allowedServerSlugs ?? []);
  if (allowedSlugs.size > 0 && (!parsed || !allowedSlugs.has(parsed.serverSlug))) {
    return false;
  }
  if (allowedSlugs.size === 0 && (scope.allowedServerSlugs?.length ?? 0) === 0) {
    return false;
  }

  // If a server is selected and no tool pattern was provided, include the
  // whole server surface. Intent resolvers should use this sparingly.
  if (patterns.length === 0) return true;

  if (parsed?.toolName === 'unavailable') return true;

  const haystack = normalizedHaystack(tool);
  return patterns.some((pattern) => pattern.test(haystack));
}

export function filterMcpToolsForScope(tools: MCPTool[], scope: McpToolScope): MCPTool[] {
  if (scope.allowAll) return tools;
  if ((scope.maxTools ?? 0) <= 0 && (scope.allowedServerSlugs?.length ?? 0) === 0) return [];

  const patterns = compilePatterns(scope.toolPatterns);
  const matched = tools.filter((tool) => toolMatchesScope(tool, scope, patterns));
  const hasServerCaps = Object.keys(scope.serverMaxTools ?? {}).length > 0;
  if (!hasServerCaps && (!scope.maxTools || matched.length <= scope.maxTools)) return matched;

  const ranked = matched
    .map((tool, index): RankedTool => ({
      tool,
      index,
      score: scoreTool(tool, scope.priorityKeywords),
      serverSlug: parseNamespacedTool(tool.name)?.serverSlug ?? null,
    }))
    .sort((a, b) => (b.score - a.score) || (a.index - b.index));

  let capped = ranked;
  if (hasServerCaps) {
    const counts = new Map<string, number>();
    capped = [];
    for (const entry of ranked) {
      const cap = entry.serverSlug ? scope.serverMaxTools?.[entry.serverSlug] : undefined;
      if (cap !== undefined) {
        const normalizedCap = Math.max(0, Math.floor(cap));
        const count = counts.get(entry.serverSlug!) ?? 0;
        if (count >= normalizedCap) continue;
        counts.set(entry.serverSlug!, count + 1);
      }
      capped.push(entry);
    }
  }

  return capped
    .slice(0, scope.maxTools ?? capped.length)
    .map((entry) => entry.tool);
}
