/**
 * call_tool — the generic gated dispatcher for the schema-on-demand Codex lane.
 *
 * When CLEMMY_CODEX_TOOL_SEARCH is on, most built-in tools leave the first-class
 * schema surface and live only in the catalog text. call_tool is how the model
 * reaches one of those catalog-only tools THIS turn: it names the tool + passes a
 * JSON args string, and call_tool dispatches it through the exact same gate battery
 * a first-class call would hit.
 *
 * Safety mechanics (from the plan):
 *  - AUTHORITY: the target is resolved against the registry + resolveEffectiveToolPolicy
 *    — the SAME authority first-class assembly uses — so generic dispatch can NEVER
 *    escalate past the orchestrator's curated discovery surface to a cli-only or
 *    off-lane tool.
 *  - ARG VALIDATION: args_json is Zod-validated against the target's schema BEFORE
 *    dispatch. On failure it returns {error:'arg_validation', schema, detail} with
 *    ZERO side effects — one round-trip self-correction.
 *  - GATE KEYING: dispatch goes through dispatchBatchItemTool, which wraps the REAL
 *    inner tool via wrapToolForHarness — so the write/send/approval gates key on the
 *    INNER tool name, exactly as a discrete call. call_tool itself is NEVER
 *    bracket-wrapped for gating (needsApproval stays false; a read target won't
 *    prompt, a write/send target gates identically to a first-class call).
 *  - PROMOTION: a reached tool is recorded to the session hot-set, so it becomes
 *    first-class next turn (stops paying the catalog/dispatch indirection).
 */
import { tool, type Tool } from '@openai/agents';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { RuntimeContextValue } from '../types.js';
import { getToolOutputContext, sessionIdFromRunContext } from '../runtime/harness/tool-output-context.js';
import { harnessRunContextStorage, ToolCallsCounter, ToolCallsLimitExceeded } from '../runtime/harness/brackets.js';
import { resolveToolSurface } from '../runtime/harness/tool-surface.js';
import { dispatchBatchItemTool, isMcpNamespacedTool } from './code-mode-tool.js';
import { deriveOrchestratorDiscoveryNames } from './tool-registry.js';
import { recordToolHit } from '../agents/tool-hotset.js';
import { resolveCallToolAlias } from './call-tool-alias.js';
import { textResult } from './shared.js';
import type { McpToolScope } from '../runtime/mcp-tool-scope.js';
import { mcpToolAllowedByScope } from '../runtime/mcp-tool-authority.js';

const DESCRIPTION = [
  'Invoke a built-in tool that is in the catalog but not currently one of your first-class tools. Pass the exact tool `name` (from the catalog / tool_search) and `args_json` — a JSON object string of that tool\'s arguments (use "{}" for none).',
  'Use this to reach a catalog-only tool without a round-trip: e.g. call_tool("workflow_schedule", "{\\"workflow_id\\":\\"...\\"}").',
  'APPROVAL: call_tool never prompts on its own — the target tool\'s own classification decides. A read runs immediately; a write/send/irreversible target gates for approval exactly as if you had called it directly.',
  'RESILIENT HTTP GET: common guessed names http_fetch, web_fetch, web_fetch_simple, and fetch_url are bounded read-only aliases for the real run_shell_command curl path when that tool is allowed on the active turn.',
  'If the arguments do not match the tool\'s schema, call_tool returns the schema and an error and makes NO change — fix the args and call again. If you are unsure of the exact name or args, call tool_search first.',
].join(' ');

/** Lazily-built, memoized name → Zod schema map for local runtime tools. Dynamic
 *  imported so this module (imported by the orchestrator) never forms an eval-time
 *  cycle with the runtime tool registry. */
let schemaCache: Map<string, z.ZodTypeAny> | null = null;
let optionalKeysCache: Map<string, ReadonlySet<string>> | null = null;
let descriptionCache: Map<string, string> | null = null;
let nullableRequiredKeysPromise: Promise<Map<string, ReadonlySet<string>>> | null = null;
let strictParametersPromise: Promise<Map<string, unknown>> | null = null;

async function localSchemas(): Promise<{
  schemas: Map<string, z.ZodTypeAny>;
  optionalKeys: Map<string, ReadonlySet<string>>;
  descriptions: Map<string, string>;
}> {
  if (!schemaCache) {
    try {
      const {
        getLocalToolCatalog,
        getLocalToolSchemas,
        getLocalToolOptionalKeys,
      } = await import('./local-runtime-tools.js');
      schemaCache = getLocalToolSchemas();
      optionalKeysCache = getLocalToolOptionalKeys();
      descriptionCache = new Map(getLocalToolCatalog().map((entry) => [entry.name, entry.description]));
    } catch {
      schemaCache = new Map();
      optionalKeysCache = new Map();
      descriptionCache = new Map();
    }
  }
  return {
    schemas: schemaCache,
    optionalKeys: optionalKeysCache ?? new Map(),
    descriptions: descriptionCache ?? new Map(),
  };
}

function jsonSchemaAllowsNull(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const schema = value as {
    type?: unknown;
    nullable?: unknown;
    anyOf?: unknown;
    oneOf?: unknown;
  };
  if (schema.nullable === true || schema.type === 'null') return true;
  if (Array.isArray(schema.type) && schema.type.includes('null')) return true;
  for (const branch of [schema.anyOf, schema.oneOf]) {
    if (Array.isArray(branch) && branch.some(jsonSchemaAllowsNull)) return true;
  }
  return false;
}

function jsonSchemaTypeMatches(value: unknown, schemaValue: unknown): boolean {
  if (!schemaValue || typeof schemaValue !== 'object' || Array.isArray(schemaValue)) return false;
  // zod's nullish() emits a NESTED wrapper — anyOf[anyOf[T,null],null] — with
  // no `type` on the wrapper itself. A wrapper matches when any branch does;
  // without this recursion the branch resolver loses the array/object branch
  // (live: space_save data_sources items were never null-materialized).
  const wrapper = schemaValue as { type?: unknown; anyOf?: unknown; oneOf?: unknown };
  if (wrapper.type === undefined) {
    for (const alternatives of [wrapper.anyOf, wrapper.oneOf]) {
      if (Array.isArray(alternatives)) {
        return alternatives.some((candidate) => jsonSchemaTypeMatches(value, candidate));
      }
    }
  }
  const type = (schemaValue as { type?: unknown }).type;
  const types = Array.isArray(type) ? type : [type];
  if (value === null) return types.includes('null');
  if (Array.isArray(value)) return types.includes('array');
  if (typeof value === 'object') {
    return types.includes('object') || Boolean((schemaValue as { properties?: unknown }).properties);
  }
  if (typeof value === 'string') return types.includes('string');
  if (typeof value === 'boolean') return types.includes('boolean');
  if (typeof value === 'number') {
    return types.includes('number') || (Number.isInteger(value) && types.includes('integer'));
  }
  return false;
}

function schemaBranchForValue(schemaValue: unknown, value: unknown): unknown {
  if (!schemaValue || typeof schemaValue !== 'object' || Array.isArray(schemaValue)) return schemaValue;
  const schema = schemaValue as { anyOf?: unknown; oneOf?: unknown };
  for (const alternatives of [schema.anyOf, schema.oneOf]) {
    if (!Array.isArray(alternatives)) continue;
    const exact = alternatives.find((candidate) => jsonSchemaTypeMatches(value, candidate));
    if (exact) return schemaBranchForValue(exact, value);
    const nonNull = alternatives.find((candidate) => !jsonSchemaAllowsNull(candidate));
    if (nonNull) return schemaBranchForValue(nonNull, value);
  }
  return schemaValue;
}

/**
 * Convert an ordinary, compact args_json object into the strict provider shape
 * expected by the inner first-class tool. Missing fields are filled ONLY when
 * that exact nested property is both required and nullable. Truly required
 * values remain missing and are rejected by the normal validator.
 */
export function materializeStrictNullableFields(value: unknown, schemaValue: unknown): unknown {
  const schema = schemaBranchForValue(schemaValue, value);
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) return value;
  const record = schema as {
    type?: unknown;
    properties?: unknown;
    required?: unknown;
    items?: unknown;
  };

  if (Array.isArray(value)) {
    return value.map((item) => materializeStrictNullableFields(item, record.items));
  }
  if (!value || typeof value !== 'object') return value;

  const input = value as Record<string, unknown>;
  const out: Record<string, unknown> = { ...input };
  const properties = record.properties && typeof record.properties === 'object'
    ? record.properties as Record<string, unknown>
    : {};
  const required = new Set(
    Array.isArray(record.required)
      ? record.required.filter((key): key is string => typeof key === 'string')
      : [],
  );

  for (const [key, propertySchema] of Object.entries(properties)) {
    if (!(key in out) || out[key] === undefined) {
      if (required.has(key) && jsonSchemaAllowsNull(propertySchema)) out[key] = null;
      continue;
    }
    out[key] = materializeStrictNullableFields(out[key], propertySchema);
  }
  return out;
}

async function strictToolParameters(): Promise<Map<string, unknown>> {
  if (!strictParametersPromise) {
    strictParametersPromise = (async () => {
      const map = new Map<string, unknown>();
      try {
        const { getCoreTools } = await import('./registry.js');
        for (const runtimeTool of getCoreTools() as Array<{ name?: string; parameters?: unknown }>) {
          if (runtimeTool?.name && runtimeTool.parameters) {
            map.set(runtimeTool.name, runtimeTool.parameters);
          }
        }
      } catch {
        // Best effort: local validation + the inner parser remain authoritative.
      }
      return map;
    })();
  }
  return strictParametersPromise;
}

/**
 * Strict Responses schemas encode optional/defaultable fields as required +
 * nullable. The local Zod catalog does not include computer/Composio tools, so
 * a direct catalog call such as run_shell_command({command}) used to reach the
 * strict inner parser without cwd/timeout_ms and waste a correction round.
 *
 * Derive these null-fill keys from the exact assembled core-tool schemas. This
 * is transport normalization only: non-null required fields remain untouched
 * and are still rejected by the inner tool parser.
 */
async function nullableRequiredKeys(): Promise<Map<string, ReadonlySet<string>>> {
  if (!nullableRequiredKeysPromise) {
    nullableRequiredKeysPromise = (async () => {
      const map = new Map<string, ReadonlySet<string>>();
      try {
        for (const [name, parameters] of await strictToolParameters()) {
          if (!parameters || typeof parameters !== 'object') continue;
          const root = parameters as {
            required?: unknown;
            properties?: unknown;
          };
          if (!Array.isArray(root.required) || !root.properties || typeof root.properties !== 'object') continue;
          const properties = root.properties as Record<string, unknown>;
          const keys = root.required
            .filter((key): key is string => typeof key === 'string')
            .filter((key) => jsonSchemaAllowsNull(properties[key]));
          if (keys.length > 0) map.set(name, new Set(keys));
        }
      } catch {
        // Best effort: the strict inner parser remains the final authority.
      }
      return map;
    })();
  }
  return nullableRequiredKeysPromise;
}

function jsonResult(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? null);
}

export interface BuildCallToolOptions {
  /** Exact built-in names advertised as deferred on this turn. Omit for the
   * legacy full orchestrator surface (tests and non-scoped callers). */
  reachableBuiltinNames?: ReadonlySet<string>;
  /** First-class built-ins on this turn's surface — directly callable, so NOT
   * in the deferred set above. Admitted so a model that wraps a first-class tool
   * in call_tool (a common confusion) gets a transparent dispatch instead of a
   * `not_reachable` bounce it loops on. The inner-name gate is identical to a
   * direct call, so this never widens authority. Live 2026-07-19: a Discord
   * calendar-invite run looped 4× / ~3.5 min calling `memory_recall_all` via
   * call_tool before self-correcting. */
  firstClassNames?: ReadonlySet<string>;
  /** Explicit per-turn denials also apply to external MCP names. */
  deniedNames?: ReadonlySet<string>;
  /** Exact external MCP authority for this dispatcher. `undefined` falls back
   * to the active HarnessRunContext (and then legacy behavior); `null` is an
   * explicit no-external-tools boundary. */
  mcpToolScope?: McpToolScope | null;
}

export function buildCallTool(options: BuildCallToolOptions = {}): Tool<RuntimeContextValue> {
  const defaultSurface = resolveToolSurface({
    surface: 'orchestrator_call_tool',
    lane: 'chat',
    availableNames: deriveOrchestratorDiscoveryNames(),
    deferralEnabled: false,
    reason: 'call_tool default built-in reachability',
  });
  const reachableBuiltinNames = options.reachableBuiltinNames ?? new Set(defaultSurface.firstClass);
  const firstClassNames = options.firstClassNames ?? new Set<string>();
  const deniedNames = options.deniedNames ?? new Set<string>();
  return tool({
    name: 'call_tool',
    description: DESCRIPTION,
    parameters: z.object({
      name: z.string().min(1).describe('Exact tool name to invoke: a built-in from the catalog, OR a connected external MCP tool as <server>__<tool> (e.g. dataforseo__serp_organic_live_advanced).'),
      args_json: z.string().describe('JSON object string of the target tool\'s arguments. Use "{}" for no args.'),
    }),
    // needsApproval intentionally omitted → false. Gate decisions come from the
    // INNER tool via dispatchBatchItemTool (see file header). Do NOT set this true.
    execute: async (
      { name, args_json }: { name: string; args_json: string },
      runContext: unknown,
      details: { toolCall?: { callId?: string; id?: string } } | undefined,
    ): Promise<string> => {
      // Exactly-once budget contract: the harness wrapper exempts call_tool
      // from the per-turn counter (the INNER tool's wrapper charges it on the
      // dispatch path). Every early return below therefore charges the
      // ambient counter itself — otherwise a model looping on failing
      // call_tool invocations would burn ZERO tool budget and lose the
      // deterministic runaway ceiling.
      const refuse = (payload: Record<string, unknown>): string => {
        const counter = harnessRunContextStorage.getStore()?.counter;
        if (counter) {
          if (counter.willExceed()) throw new ToolCallsLimitExceeded(counter.limit);
          counter.increment();
        }
        return JSON.stringify(payload);
      };
      const requestedTarget = (name ?? '').trim();
      if (!requestedTarget) return refuse({ error: 'bad_request', detail: 'name is required' });

      // 1. Parse args_json before alias repair. Parsing has no side effect, and
      // a recognized alias needs its structured arguments to resolve to the
      // real tool without wasting a failed model round-trip.
      let args: unknown = {};
      const raw = (args_json ?? '').trim();
      if (raw) {
        try {
          args = JSON.parse(raw);
        } catch {
          return refuse({ error: 'arg_validation', detail: 'args_json is not valid JSON' });
        }
      }

      let target = requestedTarget;
      let resolvedArgs = args;
      const alreadyReachable = reachableBuiltinNames.has(target) || firstClassNames.has(target);
      if (!alreadyReachable && !isMcpNamespacedTool(target)) {
        const alias = resolveCallToolAlias(target, args);
        if (alias) {
          if (!alias.ok) return refuse({ error: 'arg_validation', detail: alias.detail });
          target = alias.targetName;
          resolvedArgs = alias.targetArgs;
        }
      }

      if (deniedNames.has(requestedTarget) || deniedNames.has(target)) {
        return refuse({
          error: 'not_reachable',
          detail: `"${requestedTarget}" is excluded from this turn's effective tool policy.`,
        });
      }

      // 2. Authority — never escalate past the curated orchestrator surface.
      // External MCP names (<server>__<tool>) are admitted here and enforced
      // DOWNSTREAM: dispatchBatchItemTool resolves them against the session's
      // connected MCP scope (unknown/unconnected servers error honestly) and
      // routes approval through decideToolApproval on the inner name — the
      // same contract as run_batch/run_tool_program. Refusing them here was a
      // live Phase-1 gap (2026-07-08): the model fell back to hand-rolling the
      // provider's REST API through shell calls, slower and less gated.
      const activeMcpScope = options.mcpToolScope !== undefined
        ? options.mcpToolScope
        : harnessRunContextStorage.getStore()?.mcpToolScope;
      if (isMcpNamespacedTool(target)) {
        if (!mcpToolAllowedByScope(target, activeMcpScope)) {
          return refuse({
            error: 'not_reachable',
            reason: 'mcp_scope_denied',
            detail: `"${requestedTarget}" is outside this turn's external MCP scope.`,
          });
        }
      } else {
        if (!reachableBuiltinNames.has(target) && !firstClassNames.has(target)) {
          return refuse({
            error: 'not_reachable',
            detail: `"${requestedTarget}" is not a deferred callable tool on this turn's surface. Call a first-class tool directly, use tool_search for an available deferred tool, or use a connected external MCP tool as <server>__<tool>.`,
          });
        }
      }

      // 3. Zod-validate BEFORE dispatch — zero side effects on failure.
      const local = await localSchemas();
      const schema = local.schemas.get(target);
      let dispatchArgs = resolvedArgs;
      if (schema) {
        const parsed = schema.safeParse(resolvedArgs);
        if (!parsed.success) {
          return refuse({
            error: 'arg_validation',
            schema: z.toJSONSchema(schema),
            guidance: local.descriptions.get(target),
            detail: parsed.error.issues
              .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
              .join('; '),
          });
        }
        dispatchArgs = parsed.data;
        if (dispatchArgs && typeof dispatchArgs === 'object' && !Array.isArray(dispatchArgs)) {
          const strictArgs = { ...(dispatchArgs as Record<string, unknown>) };
          for (const key of local.optionalKeys.get(target) ?? []) {
            if (!(key in strictArgs) || strictArgs[key] === undefined) strictArgs[key] = null;
          }
          dispatchArgs = strictArgs;
        }
      }
      // Core-tool schemas also cover computer/Composio tools that are absent
      // from getLocalToolSchemas(). Materialize their defaultable strict-null
      // fields so direct catalog dispatch works without a discovery/retry tax.
      if (dispatchArgs && typeof dispatchArgs === 'object' && !Array.isArray(dispatchArgs)) {
        const strictArgs = { ...(dispatchArgs as Record<string, unknown>) };
        for (const key of (await nullableRequiredKeys()).get(target) ?? []) {
          if (!(key in strictArgs) || strictArgs[key] === undefined) strictArgs[key] = null;
        }
        dispatchArgs = strictArgs;
      }
      const strictParameters = (await strictToolParameters()).get(target);
      if (strictParameters) {
        dispatchArgs = materializeStrictNullableFields(dispatchArgs, strictParameters);
      }

      // 4. Dispatch through the gated inner path (gates key on the INNER name).
      const sessionId = sessionIdFromRunContext(runContext)
        ?? getToolOutputContext()?.sessionId
        ?? harnessRunContextStorage.getStore()?.sessionId
        ?? '';
      if (!sessionId) {
        return refuse({
          error: 'missing_session_context',
          detail: 'call_tool requires an active harness session before it can dispatch an inner tool.',
        });
      }
      // Nested dispatch is part of the SAME run. Reusing the ambient counter
      // prevents call_tool from resetting the safety budget on every wrapper
      // invocation; the fallback only serves direct/unit invocations without a
      // harness run context.
      const counter = harnessRunContextStorage.getStore()?.counter ?? new ToolCallsCounter(1000);
      const outerCallId = details?.toolCall?.callId ?? details?.toolCall?.id;
      const out = await dispatchBatchItemTool(
        target,
        dispatchArgs,
        sessionId,
        counter,
        undefined,
        { accounting: 'transport_mirror', canonicalCallId: outerCallId },
        activeMcpScope,
      );

      // 5. Promote the reached tool into the session hot-set.
      recordToolHit(sessionId, target);
      return jsonResult(out);
    },
  });
}

/**
 * MCP wrapper for the same schema-on-demand dispatcher used by the Codex lane.
 *
 * The Claude Agent SDK must not register every deferred tool merely to keep it
 * reachable: Anthropic still accounts those schemas in the provider prompt even
 * when native ToolSearch marks them deferred. This two-field MCP tool keeps the
 * model-facing surface tiny while dispatching the selected INNER tool through
 * buildCallTool's existing authority, schema validation, budget, and harness
 * gates. The surrounding MCP server installs the active session/run context
 * before this handler executes.
 */
export function registerCallToolMcp(
  server: McpServer,
  options: BuildCallToolOptions,
): void {
  const dispatcher = buildCallTool(options) as unknown as {
    invoke: (
      runContext: unknown,
      input: string,
      details?: { toolCall?: { callId?: string; id?: string } },
    ) => Promise<unknown>;
  };
  server.tool(
    'call_tool',
    DESCRIPTION,
    {
      name: z.string().min(1).describe('Exact built-in tool name returned by tool_search.'),
      args_json: z.string().describe('JSON object string matching that tool\'s returned schema. Use "{}" for no args.'),
    },
    async ({ name, args_json }: { name: string; args_json: string }) => {
      const sessionId = getToolOutputContext()?.sessionId ?? '';
      const output = await dispatcher.invoke(
        { context: { sessionId } },
        JSON.stringify({ name, args_json }),
      );
      return textResult(jsonResult(output));
    },
  );
}

/** Test-only: reset the memoized local-schema map. */
export function _resetCallToolSchemaCacheForTest(): void {
  schemaCache = null;
  optionalKeysCache = null;
  descriptionCache = null;
  nullableRequiredKeysPromise = null;
  strictParametersPromise = null;
}
