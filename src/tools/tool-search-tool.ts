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
import { catalogEntries, rankCatalog, type RankedCatalogEntry } from '../agents/tool-catalog.js';
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

export type ToolSearchDispatchCarrier = 'call_tool' | 'work_call';

export type ToolSearchCandidateSourceKind = 'authorized_external_mcp' | 'authorized_composio';

/** Provider adapters stay behind the one visible broker. A candidate is
 * capability context only: its host-selected carrier still performs every
 * dispatch/approval check. `invocation` represents adapters whose public
 * operation identity is wrapped by a stable business carrier (for example an
 * action slug passed to a generic executor) without teaching that shape to the
 * broker itself. */
export interface ToolSearchBrokerCandidate {
  name: string;
  summary: string;
  schema?: unknown;
  carrier: ToolSearchDispatchCarrier;
  score?: number;
  guidance?: string;
  invocation?: {
    name: string;
    fixedArgs?: Record<string, unknown>;
    payloadField?: string;
  };
}

export interface ToolSearchCandidateSource {
  kind: ToolSearchCandidateSourceKind;
  search(input: { query: string; limit: number }): Promise<ToolSearchBrokerCandidate[]>;
}

export type ToolSearchBrokerCoverage = 'builtins_only' | 'authorized_external_v1';

/** Positive construction-time signal for the role governor. Partial provider
 * coverage deliberately reports builtins_only so unresolved external roles
 * retain the legacy compatibility route instead of being stranded. */
export function toolSearchBrokerCoverage(
  sources: readonly ToolSearchCandidateSource[] | undefined,
): ToolSearchBrokerCoverage {
  const kinds = new Set((sources ?? []).map((source) => source.kind));
  return kinds.has('authorized_external_mcp') && kinds.has('authorized_composio')
    ? 'authorized_external_v1'
    : 'builtins_only';
}

function dispatchHint(carrier: ToolSearchDispatchCarrier): string {
  return carrier === 'work_call'
    ? 'Invoke the selected result as the inner name/args_json of work_call. On the first work_call, include the complete provider-neutral semantic proposal and dispatch this first requirement in that same call; later calls use proposal:null.'
    : 'Invoke the selected result with call_tool(name, args_json), using the exact name and JSON schema above. Omit optional/nullable fields you do not need.';
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
    /** Action turns use the semantic carrier instead of advertising a second,
     * unbound business dispatcher. Omitted preserves the legacy call_tool hint. */
    dispatchCarrier?: ToolSearchDispatchCarrier;
    /** A mixed action catalog keeps controls and business capabilities behind
     * different carriers. The registry-derived resolver lets one search return
     * the correct carrier per result without duplicating search schemas or
     * teaching provider/task-specific operation lists. */
    dispatchCarrierForName?: (name: string) => ToolSearchDispatchCarrier;
    /** Scope-bound provider adapters searched behind this same visible door. */
    candidateSources?: readonly ToolSearchCandidateSource[];
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
      role_key: z
        .string()
        .min(1)
        .max(128)
        .optional()
        .describe('Opaque host-issued requirement role. Echoed for traceability; it does not affect ranking or grant authority.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe(`How many ranked results to return (default ${TOP_RESULTS}).`),
    },
    async ({ query, role_key, limit }: { query: string; role_key?: string; limit?: number }) => {
      // An exact tool name is an explicit selection, not another fuzzy search
      // term. Resolve it against the policy-filtered catalog BEFORE semantic
      // ranking so a selected name never pays a cold embedding/model detour.
      // Once selected, neighboring guesses add no value: return only the exact
      // capability and its schema. Natural-language discovery still ranks the
      // whole allowed catalog below.
      const requestedLimit = Math.min(limit ?? TOP_RESULTS, 20);
      const exactEntry = catalogEntries({ allowedNames: opts.allowedNames })
        .find((entry) => queryExplicitlyNamesTool(query, entry.name));
      const exactKnownButDenied = !exactEntry && catalogEntries()
        .some((entry) => queryExplicitlyNamesTool(query, entry.name));
      const exactNamedHit: RankedCatalogEntry | undefined = exactEntry
        ? { ...exactEntry, score: 1 }
        : undefined;
      // An exact registered built-in is already resolved and never pays for
      // provider I/O. Provider adapters are consulted only for an unresolved
      // name/role, preserving the fast path and avoiding broad discovery after
      // an exact capability selection.
      const sourceCandidates = exactNamedHit || exactKnownButDenied
        ? []
        : (await Promise.all((opts.candidateSources ?? []).map(async (source) => {
            try {
              const candidates = await source.search({ query, limit: requestedLimit });
              return candidates
                .filter((candidate) => candidate.name.trim() && candidate.summary.trim())
                .slice(0, requestedLimit);
            } catch {
              return [];
            }
          }))).flat();
      const exactSourceHit = sourceCandidates.find((candidate) =>
        queryExplicitlyNamesTool(query, candidate.name));
      const selectedExactly = exactSourceHit ?? exactNamedHit;
      const rankedBuiltins = exactNamedHit
        ? [exactNamedHit]
        : await rankCatalog(query, { allowedNames: opts.allowedNames });
      const combined = selectedExactly
        ? [selectedExactly]
        : [
            ...sourceCandidates.map((candidate, index) => ({
              ...candidate,
              score: candidate.score ?? Math.max(0, 1 - (index / Math.max(1, sourceCandidates.length))),
            })),
            ...rankedBuiltins.map((entry) => ({
              name: entry.name,
              summary: entry.oneLiner,
              score: entry.score,
            })),
          ].sort((left, right) => (right.score ?? 0) - (left.score ?? 0));
      const seen = new Set<string>();
      const topN = combined.filter((candidate) => {
        const key = candidate.name.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).slice(0, requestedLimit);
      const metadataMap = await toolMetadataMap();

      // When the model supplied an exact tool name, it has already selected
      // the capability. Return only that schema instead of spending tokens on
      // two neighboring suggestions. Natural-language discovery still gets up
      // to three candidates.
      const schemaNames = selectedExactly
        ? [selectedExactly.name]
        : topN.slice(0, TOP_SCHEMAS).map((r) => r.name);
      const schemas: Record<string, unknown> = {};
      for (const name of schemaNames) {
        const sourced = sourceCandidates.find((candidate) => candidate.name === name);
        if (sourced?.schema !== undefined) {
          schemas[name] = relaxJsonSchemaForDeferred(sourced.schema);
          continue;
        }
        const metadata = metadataMap.get(name);
        if (metadata?.schema !== undefined) {
          schemas[name] = (opts.dispatchViaCallTool || opts.dispatchCarrier || opts.dispatchCarrierForName)
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
      if (selectedExactly) {
        const sourceGuidance = sourceCandidates.find((candidate) => candidate.name === selectedExactly.name)
          ?.guidance;
        const description = sourceGuidance ?? metadataMap.get(selectedExactly.name)?.description;
        if (description) guidance[selectedExactly.name] = description;
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
      const exactSourceCarrier = exactSourceHit?.carrier;
      const exactCarrier = exactSourceCarrier ?? (
        exactNamedHit && opts.dispatchCarrierForName
          ? opts.dispatchCarrierForName(exactNamedHit.name)
          : null
      );
      const hint = (() => {
        if (exactCarrier) return dispatchHint(exactCarrier);
        if (opts.dispatchCarrierForName) {
          return 'Each result includes its required carrier. Invoke control/recovery results with call_tool(name, args_json); invoke business results as the inner name/args_json of work_call. Never send a business result through call_tool.';
        }
        const fixedCarrier = opts.dispatchCarrier
          ?? (opts.dispatchViaCallTool ? 'call_tool' : null);
        if (fixedCarrier) return dispatchHint(fixedCarrier);
        return opts.allowedNames
          ? 'Call one of the returned tools by name; every result is available on this turn\'s active surface.'
          : 'Call the tool you need by name. If its schema is not shown above, search again with a tighter query.';
      })();
      const render = (): string => JSON.stringify({
        query,
        ...(role_key ? { role_key } : {}),
        results: topN.map((r) => ({
          name: r.name,
          summary: 'summary' in r ? r.summary : r.oneLiner,
          ...('carrier' in r && r.carrier
            ? { carrier: r.carrier }
            : opts.dispatchCarrierForName
              ? { carrier: opts.dispatchCarrierForName(r.name) }
              : {}),
          ...('invocation' in r && r.invocation ? { invocation: r.invocation } : {}),
        })),
        schemas,
        ...(Object.keys(guidance).length > 0 ? { guidance } : {}),
        brokerCoverage: toolSearchBrokerCoverage(opts.candidateSources),
        hint,
      });
      let text = render();
      const shownSchemaNames = [...schemaNames];
      // Some exact authoring schemas are structurally modest but carry many
      // long field descriptions (workflow_update is the canonical example).
      // Never drop the ONE schema the model explicitly requested merely
      // because annotations exceed the result budget. The selected tool's
      // overall guidance remains present; strip JSON-Schema annotations while
      // retaining every property, type, enum, constraint, and required key.
      if (text.length > DEFAULT_TOOL_RESULT_MAX_CHARS && selectedExactly) {
        const exactName = selectedExactly.name;
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
