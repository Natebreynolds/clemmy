/**
 * tool_search — the schema-on-demand discovery entry (Phase 0 of
 * SCHEMA-ON-DEMAND-PLAN-2026-07-07.md).
 *
 * Given a natural-language query it ranks the compact tool catalog (derived from
 * TOOL_REGISTRY) and returns the top matches as names + one-liners, plus the FULL
 * JSON schema for the top few so the model can call a discovered tool correctly on
 * the first try. Every hit is recorded to the session hot-set so a searched tool is
 * promoted to a first-class schema next turn.
 *
 * READ-ONLY, no approval: it only reads the static registry + the tool schemas.
 * Registered on BOTH the MCP server (Claude Agent SDK lane) and the local runtime
 * (Codex/GLM lane), like every other built-in.
 *
 * Phase 0 is additive + dormant: the tool exists and works, but the surface-assembly
 * switch that would let it REPLACE first-class schemas (CLEMMY_CODEX_TOOL_SEARCH) is
 * a later phase — today it is simply an extra read-only tool.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { textResult } from './shared.js';
import { getToolOutputContext } from '../runtime/harness/tool-output-context.js';
import { rankCatalog } from '../agents/tool-catalog.js';
import { recordToolHit } from '../agents/tool-hotset.js';

const TOP_RESULTS = 8;
const TOP_SCHEMAS = 3;

const DESCRIPTION = [
  'Search the full built-in tool catalog by intent and get the tools that match — names + one-line summaries for the top results, plus the complete JSON input schema for the closest few so you can call them right the first time.',
  'Use this when the tool you need is not already on your surface: describe what you want to do (e.g. "schedule a recurring workflow", "read a clipped tool result", "spawn workers for N items") and call the returned tool by name.',
  'Read-only — searching never changes anything.',
].join(' ');

/** Lazily-built, memoized name → JSON-schema map. Dynamic-imported so this module
 *  (which the runtime tool registry imports) never forms an eval-time import cycle. */
let schemaMapPromise: Promise<Map<string, unknown>> | null = null;
async function toolSchemaMap(): Promise<Map<string, unknown>> {
  if (!schemaMapPromise) {
    schemaMapPromise = (async () => {
      const map = new Map<string, unknown>();
      try {
        const { getCoreTools } = await import('./registry.js');
        for (const t of getCoreTools() as Array<{ name?: string; parameters?: unknown }>) {
          if (t?.name && t.parameters) map.set(t.name, t.parameters);
        }
      } catch {
        /* schemas are best-effort; names + one-liners still return */
      }
      return map;
    })();
  }
  return schemaMapPromise;
}

export function registerToolSearchTool(server: McpServer): void {
  server.tool(
    'tool_search',
    DESCRIPTION,
    {
      query: z
        .string()
        .min(1)
        .max(400)
        .describe('What you want to do, in plain language. Ranked against every built-in tool.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe(`How many ranked results to return (default ${TOP_RESULTS}).`),
    },
    async ({ query, limit }: { query: string; limit?: number }) => {
      const ranked = await rankCatalog(query);
      const topN = ranked.slice(0, Math.min(limit ?? TOP_RESULTS, 20));
      const schemaMap = await toolSchemaMap();

      const schemaNames = topN.slice(0, TOP_SCHEMAS).map((r) => r.name);
      const schemas: Record<string, unknown> = {};
      for (const name of schemaNames) {
        const schema = schemaMap.get(name);
        if (schema !== undefined) schemas[name] = schema;
      }

      // Promote the schema'd hits into the session hot-set (first-class next turn).
      const sessionId = getToolOutputContext()?.sessionId;
      for (const name of schemaNames) recordToolHit(sessionId, name);

      return textResult(
        JSON.stringify(
          {
            query,
            results: topN.map((r) => ({ name: r.name, summary: r.oneLiner })),
            schemas,
            hint: 'Call the tool you need by name. If its schema is not shown above, search again with a tighter query.',
          },
          null,
          2,
        ),
      );
    },
  );
}

/** Test-only: reset the memoized schema map. */
export function _resetToolSearchSchemaCacheForTest(): void {
  schemaMapPromise = null;
}
