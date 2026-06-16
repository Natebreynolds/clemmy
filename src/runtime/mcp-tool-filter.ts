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

/**
 * The text used both to keyword-match a tool and to embed it for semantic
 * ranking — name + server slug + tool name + description. Exported so the
 * semantic ranker (mcp-tool-rank) embeds the SAME text the filter keyword-scores.
 */
export function toolHaystack(tool: MCPTool): string {
  const parsed = parseNamespacedTool(tool.name);
  return [
    tool.name,
    parsed?.serverSlug ?? '',
    parsed?.toolName ?? '',
    typeof tool.description === 'string' ? tool.description : '',
  ].join(' ').toLowerCase();
}

// Weight for the semantic component. A cosine of 1.0 contributes +100 — well
// above the keyword bumps (+5 each), so on the keyword-less fail-open surface
// semantic relevance is the dominant signal, while __unavailable stubs (−50)
// still lose to any real tool with non-trivial relevance.
const SEMANTIC_WEIGHT = 100;

function scoreTool(
  tool: MCPTool,
  priorityKeywords: string[] | undefined,
  semanticScores?: Map<string, number>,
): number {
  // Synthetic "unavailable" stubs must rank below EVERY real tool — return the
  // penalty immediately so neither semantic relevance nor keyword matches can
  // rescue a stub above a usable tool (real tools always score >= 0).
  if (tool.name.endsWith('__unavailable')) return -50;
  let score = 0;
  // T1 semantic component (precomputed cosine in [0,1]). On the fail-open
  // surface this is the ONLY relevance signal; for keyword scopes it rides
  // alongside the keyword bumps.
  if (semanticScores) {
    const s = semanticScores.get(tool.name);
    if (typeof s === 'number') score += s * SEMANTIC_WEIGHT;
  }
  if (!priorityKeywords || priorityKeywords.length === 0) return score;
  const haystack = toolHaystack(tool);
  for (const keyword of priorityKeywords) {
    const normalized = keyword.toLowerCase();
    if (!normalized) continue;
    if (haystack.includes(normalized)) score += 5;
  }
  return score;
}

function toolMatchesScope(tool: MCPTool, scope: McpToolScope, patterns: RegExp[]): boolean {
  if (scope.allowAll) return true;
  // Fail-open: match every connected server's tools (no slug/pattern gate); the
  // maxTools cap below still bounds the surface, and __unavailable stubs are
  // de-prioritized by scoreTool so real tools win the cap.
  if (scope.failOpenCandidate) return true;
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

  const haystack = toolHaystack(tool);
  return patterns.some((pattern) => pattern.test(haystack));
}

/**
 * Filter the full MCP tool universe to the per-run surface.
 * @param semanticScores Optional precomputed cosine relevance (toolName → [0,1])
 *   from the T1 semantic ranker. When present it dominates ranking on the
 *   keyword-less fail-open surface; absent, behavior is identical to before.
 */
export function filterMcpToolsForScope(
  tools: MCPTool[],
  scope: McpToolScope,
  semanticScores?: Map<string, number>,
): MCPTool[] {
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
      score: scoreTool(tool, scope.priorityKeywords, semanticScores),
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
