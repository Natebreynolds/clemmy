/**
 * tool_search — the schema-on-demand discovery entry.
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
 * It remains additive while `CLEMMY_CODEX_TOOL_SEARCH` is off. When the switch is
 * enabled, catalog discovery can replace most first-class schemas.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { textResult } from './shared.js';
import { DEFAULT_TOOL_RESULT_MAX_CHARS } from '../runtime/harness/tool-output-format.js';
import { rankCatalog } from '../agents/tool-catalog.js';
import { relaxJsonSchemaForDeferred } from '../runtime/schema-normalizer.js';

const TOP_RESULTS = 8;
const TOP_SCHEMAS = 3;

const DESCRIPTION = [
  'Search the full built-in tool catalog by intent and get the tools that match — names + one-line summaries for the top results, plus the complete JSON input schema for the closest few so you can call them right the first time.',
  'Use this when the tool you need is not already on your surface: describe what you want to do (e.g. "schedule a recurring workflow", "read a clipped tool result", "spawn workers for N items") and follow the returned invocation hint.',
  'Read-only — searching never changes anything.',
].join(' ');

interface ToolSearchMetadata {
  schema: unknown;
  description: string;
}

function queryExplicitlyNamesTool(query: string, toolName: string): boolean {
  const escaped = toolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9_])${escaped}([^a-z0-9_]|$)`, 'i').test(query);
}

function stripSchemaAnnotations(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripSchemaAnnotations);
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if ([
      '$schema',
      'description',
      'title',
      'examples',
      'default',
      'deprecated',
      'readOnly',
      'writeOnly',
    ].includes(key)) continue;
    out[key] = stripSchemaAnnotations(nested);
  }
  return out;
}

/** Lazily-built, memoized name → schema/instructions map. Dynamic-imported so
 * this module (which the runtime tool registry imports) never forms an
 * eval-time import cycle. */
let metadataMapPromise: Promise<Map<string, ToolSearchMetadata>> | null = null;
async function toolMetadataMap(): Promise<Map<string, ToolSearchMetadata>> {
  if (!metadataMapPromise) {
    metadataMapPromise = (async () => {
      const map = new Map<string, ToolSearchMetadata>();
      try {
        const { getCoreTools } = await import('./registry.js');
        for (const t of getCoreTools() as Array<{ name?: string; description?: string; parameters?: unknown }>) {
          if (t?.name && t.parameters) {
            map.set(t.name, {
              schema: t.parameters,
              description: typeof t.description === 'string' ? t.description : '',
            });
          }
        }
      } catch {
        /* schemas are best-effort; names + one-liners still return */
      }
      return map;
    })();
  }
  return metadataMapPromise;
}

export function registerToolSearchTool(
  server: McpServer,
  opts: {
    allowedNames?: ReadonlySet<string>;
    /** Deferred results are intentionally absent from the advertised schema
     * surface and must be invoked through the generic same-turn dispatcher. */
    dispatchViaCallTool?: boolean;
  } = {},
): void {
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
      const ranked = await rankCatalog(query, { allowedNames: opts.allowedNames });
      // An exact tool name is an explicit selection, not another fuzzy search
      // term. Resolve it against the complete policy-filtered ranking before
      // applying the result limit, then keep it first even when lexical or
      // semantic neighbors happen to score higher.
      const exactNamedHit = ranked.find((result) => queryExplicitlyNamesTool(query, result.name));
      const ordered = exactNamedHit
        ? [exactNamedHit, ...ranked.filter((result) => result.name !== exactNamedHit.name)]
        : ranked;
      const topN = ordered.slice(0, Math.min(limit ?? TOP_RESULTS, 20));
      const metadataMap = await toolMetadataMap();

      // When the model supplied an exact tool name, it has already selected
      // the capability. Return only that schema instead of spending tokens on
      // two neighboring suggestions. Natural-language discovery still gets up
      // to three candidates.
      const schemaNames = exactNamedHit
        ? [exactNamedHit.name]
        : topN.slice(0, TOP_SCHEMAS).map((r) => r.name);
      const schemas: Record<string, unknown> = {};
      for (const name of schemaNames) {
        const metadata = metadataMap.get(name);
        if (metadata?.schema !== undefined) {
          schemas[name] = opts.dispatchViaCallTool
            ? relaxJsonSchemaForDeferred(metadata.schema)
            : metadata.schema;
        }
      }
      // Complex tools carry critical execution contracts beyond their argument
      // shape (for example Workspace views must call clem.data()). Include the
      // selected tool's own instructions only when the query named it exactly;
      // broad discovery remains one-liners + schemas and does not load three
      // unrelated prompt blocks.
      const guidance: Record<string, string> = {};
      if (exactNamedHit) {
        const description = metadataMap.get(exactNamedHit.name)?.description;
        if (description) guidance[exactNamedHit.name] = description;
      }

      // Bound our OWN payload: the generic tool-result cap would otherwise slice
      // the JSON mid-escape and hand the model (and tests) an unparseable blob.
      // Dropping the largest trailing schema keeps the ranked names intact — a
      // dropped schema is re-acquirable with a tighter query, per the hint.
      // Keep this machine-consumable JSON compact. Pretty-printing more than
      // doubled large but legitimate authoring schemas (space_save: ~5.7K →
      // ~13.6K), which crossed the 12K result ceiling and caused us to drop the
      // *only* schema the model explicitly searched for. The live consequence
      // was a second search followed by an intentional invalid `{}` call just
      // to obtain that schema. Compact JSON preserves the exact schema while
      // spending fewer prompt tokens and tool round-trips.
      const render = (): string => JSON.stringify({
        query,
        results: topN.map((r) => ({ name: r.name, summary: r.oneLiner })),
        schemas,
        ...(Object.keys(guidance).length > 0 ? { guidance } : {}),
        hint: opts.dispatchViaCallTool
          ? 'Invoke the selected result with call_tool(name, args_json), using the exact name and JSON schema above. Omit optional/nullable fields you do not need.'
          : opts.allowedNames
            ? 'Call one of the returned tools by name; every result is available on this turn\'s active surface.'
            : 'Call the tool you need by name. If its schema is not shown above, search again with a tighter query.',
      });
      let text = render();
      const shownSchemaNames = [...schemaNames];
      // Some exact authoring schemas are structurally modest but carry many
      // long field descriptions (workflow_update is the canonical example).
      // Never drop the ONE schema the model explicitly requested merely
      // because annotations exceed the result budget. The selected tool's
      // overall guidance remains present; strip JSON-Schema annotations while
      // retaining every property, type, enum, constraint, and required key.
      if (text.length > DEFAULT_TOOL_RESULT_MAX_CHARS && exactNamedHit) {
        const exactName = exactNamedHit.name;
        if (schemas[exactName]) {
          schemas[exactName] = stripSchemaAnnotations(schemas[exactName]);
          text = render();
        }
      }
      while (text.length > DEFAULT_TOOL_RESULT_MAX_CHARS && shownSchemaNames.length > 0) {
        const dropped = shownSchemaNames.pop()!;
        delete schemas[dropped];
        delete guidance[dropped];
        text = render();
      }

      // Do not promote speculative search hits. The selected tool is promoted
      // after call_tool successfully dispatches it; promoting all three schema
      // previews made ordinary sessions grow their first-class surface on every
      // search even when two suggestions were never used.
      return textResult(text);
    },
  );
}

/** Test-only: reset the memoized schema map. */
export function _resetToolSearchSchemaCacheForTest(): void {
  metadataMapPromise = null;
}
