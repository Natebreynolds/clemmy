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
 *  - CAPABILITY ADMISSION: production supplies a sealed-universe callback. A
 *    built-in must append/reuse its binding revision before dispatch; missing or
 *    outside authority returns typed requires_readmission with ZERO dispatch.
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
import {
  harnessRunContextStorage,
  ToolCallsCounter,
  ToolCallsLimitExceeded,
} from '../runtime/harness/brackets.js';
import {
  authorizeResolvedLogicalCallContract,
  currentLogicalCall,
} from '../runtime/harness/attempt-identity.js';
import { resolveToolSurface } from '../runtime/harness/tool-surface.js';
import { dispatchBatchItemTool, isMcpNamespacedTool } from './code-mode-tool.js';
import { deriveOrchestratorDiscoveryNames } from './tool-registry.js';
import { recordToolHit } from '../agents/tool-hotset.js';
import { resolveCallToolAlias } from './call-tool-alias.js';
import { isHarnessRefusalText, textResult } from './shared.js';
import type { McpToolScope } from '../runtime/mcp-tool-scope.js';
import { mcpToolAllowedByScope } from '../runtime/mcp-tool-authority.js';
import { isIrreversibleSendSlug } from '../runtime/harness/execution-gate.js';
import {
  validateIrreversibleSendPayload,
} from '../runtime/harness/grounding-gate.js';
import {
  ExternalWritePreDispatchError,
  ExternalWritePreDispatchResult,
} from '../runtime/harness/external-write-admission.js';
import {
  settleResolvedCarrierRefusal,
  type ResolvedCarrierTarget,
} from '../runtime/harness/resolved-carrier-refusal.js';
import type { SettleToolAttemptInput } from '../runtime/harness/attempt-settlement.js';
import {
  normalizeComposioCarrierInput,
  serializeComposioCarrier,
} from './composio-carrier.js';
import {
  jsonSchemaAllowsNull,
  materializeStrictNullableFields,
} from '../runtime/schema-normalizer.js';

export { materializeStrictNullableFields } from '../runtime/schema-normalizer.js';

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
  if (value instanceof ExternalWritePreDispatchResult) return value.output;
  return typeof value === 'string' ? value : JSON.stringify(value ?? null);
}

interface CarrierValidationError {
  detail: string;
  reason?: 'arguments_missing' | 'target_missing';
}

type CallToolCarrierNormalization =
  | { ok: true; args: unknown }
  | {
      ok: false;
      detail: string;
      violations: string[];
      schemaHash: string;
      contract: string;
      repair: unknown;
    };

/**
 * Canonicalize the Composio carrier before this dispatcher's schema and safety
 * checks. The shared adapter deliberately accepts representation-only drift
 * such as an object-valued `arguments`; charging a model turn to stringify an
 * already-valid object is transport work, not discovery or reasoning.
 *
 * `connected_account_id` is an outer execution selector rather than part of
 * the reusable invocation body, so preserve it separately. The canonical
 * adapter still strips any accidentally nested connection id from `arguments`.
 */
function normalizeCallToolComposioCarrier(
  target: string,
  args: unknown,
): CallToolCarrierNormalization {
  if (target !== 'composio_execute_tool') return { ok: true, args };

  const normalized = normalizeComposioCarrierInput(args);
  if (!normalized.ok) {
    return {
      ok: false,
      detail: normalized.error,
      violations: normalized.violations,
      schemaHash: normalized.schemaHash,
      contract: normalized.contract,
      repair: normalized.repair,
    };
  }

  const carrier: Record<string, unknown> = {
    ...serializeComposioCarrier(normalized.canonical),
  };
  const original = args as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(original, 'connected_account_id')) {
    carrier.connected_account_id = original.connected_account_id;
  }
  return { ok: true, args: carrier };
}

function composioCarrierValidationError(target: string, args: unknown): CarrierValidationError | null {
  if (target !== 'composio_execute_tool') return null;
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    return { detail: 'composio_execute_tool requires a JSON object with tool_slug and arguments.' };
  }
  const record = args as Record<string, unknown>;
  if (typeof record.tool_slug !== 'string' || !record.tool_slug.trim()) {
    return { detail: 'composio_execute_tool requires a non-empty tool_slug.' };
  }
  const toolSlug = record.tool_slug.trim();
  const rawArguments = record.arguments;
  let parsedArguments: Record<string, unknown> | null = null;
  if (rawArguments !== undefined && rawArguments !== null) {
    if (typeof rawArguments !== 'string') {
      return { detail: 'composio_execute_tool arguments must be a JSON-object string or null.' };
    }
    if (rawArguments.trim()) {
      try {
        const parsed = JSON.parse(rawArguments) as unknown;
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return { detail: 'composio_execute_tool arguments must decode to a JSON object.' };
        }
        parsedArguments = parsed as Record<string, unknown>;
      } catch {
        return { detail: 'composio_execute_tool arguments is not valid JSON.' };
      }
    }
  }
  // Approval is authority for one executable action, not permission to invent
  // its destination later. A target-less send used to mint a card that the
  // pending queue either rejected (missing/null/blank arguments) or accepted as
  // an impossible `{}` payload. Validate the effect before approval conversion
  // using the same generic target predicate as the provider gateway.
  if (isIrreversibleSendSlug(toolSlug)) {
    const validation = validateIrreversibleSendPayload(toolSlug, parsedArguments);
    if (!validation.ok) {
      return {
        reason: validation.reason,
        detail: validation.detail ?? `${toolSlug} has an invalid irreversible-send payload.`,
      };
    }
  }
  const connectionId = record.connected_account_id;
  if (
    connectionId !== undefined
    && connectionId !== null
    && (typeof connectionId !== 'string' || !connectionId.trim())
  ) {
    return { detail: 'composio_execute_tool connected_account_id must be a non-empty string or null.' };
  }
  return null;
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
  /** Fail-closed admission gate for a validated built-in acquisition. When
   * supplied, the inner tool cannot dispatch unless this callback proves the
   * name belongs to a sealed capability universe and appends/reuses its active
   * binding revision. Omit only for legacy/custom unsealed constructions.
   * External MCP tools do not pass through this gate; their bound MCP scope is
   * the separate authority. */
  admitBuiltinAcquisition?: (
    targetName: string,
  ) => BuiltinCapabilityAdmissionResult | Promise<BuiltinCapabilityAdmissionResult>;
  /** Optional diagnostic observer for each admitted built-in immediately before
   * inner dispatch. Never called for MCP-namespaced targets. This is not the
   * authority boundary; `admitBuiltinAcquisition` owns that contract. A throwing
   * observer must never break an already-admitted dispatch. */
  onBuiltinAcquisition?: (targetName: string) => void;
  /** Optional carrier-owned authority wrapper around the already-resolved,
   * schema-validated inner dispatch. `work_call` uses this seam to atomically
   * bind semantic expected work before the inner brackets/provider run. */
  aroundResolvedDispatch?: (
    input: {
      sessionId: string;
      sourceUserSeq?: number;
      turn?: number;
      logicalToolCallId?: string;
      targetName: string;
      targetArgs: unknown;
      /** Exact provider-ready callable schema used to normalize targetArgs.
       * Null means this carrier could not prove a schema for the target. */
      targetInputSchema: unknown | null;
      /** Semantic inner payload/schema used only for evidence refinement when
       * targetArgs is a generic transport envelope. */
      evidenceArgs?: unknown;
      evidenceInputSchema?: unknown;
    },
    dispatch: () => Promise<unknown>,
  ) => Promise<unknown>;
  /** Adapter attribution for a trusted refusal after inner resolution. */
  resolvedRefusalLane?: SettleToolAttemptInput['lane'];
}

export type BuiltinCapabilityAdmissionResult =
  | { ok: true }
  | {
      ok: false;
      kind: 'requires_readmission';
      outside: readonly string[];
      reason?: string;
    };

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
    // Preserve the SDK's model-visible corrective for ordinary invocation
    // errors, but never soften the deterministic turn ceiling. A nominal cap
    // result would cost zero calls and could be retried forever.
    errorFunction: (_context, error) => {
      if (error instanceof ToolCallsLimitExceeded) throw error;
      const details = error instanceof Error ? error.toString() : String(error);
      return `An error occurred while running the tool. Please try again. Error: ${details}`;
    },
    // needsApproval intentionally omitted → false. Gate decisions come from the
    // INNER tool via dispatchBatchItemTool (see file header). Do NOT set this true.
    execute: async (
      { name, args_json }: { name: string; args_json: string },
      runContext: unknown,
      details: { toolCall?: { callId?: string; id?: string } } | undefined,
    ): Promise<string> => {
      let resolvedRefusalTarget: ResolvedCarrierTarget | undefined;
      // Exactly-once budget contract: the harness wrapper exempts call_tool
      // from the per-turn counter (the INNER tool's wrapper charges it on the
      // dispatch path). Every early return below therefore charges the
      // ambient counter itself — otherwise a model looping on failing
      // call_tool invocations would burn ZERO tool budget and lose the
      // deterministic runaway ceiling.
      const refuse = (
        payload: Record<string, unknown>,
        classification: 'invalid_arguments' | 'policy_denial' = 'invalid_arguments',
      ): string => {
        const counter = harnessRunContextStorage.getStore()?.counter;
        if (counter) {
          // The ceiling is terminal for this turn. Returning another nominal
          // refusal here would cost zero calls and let the model retry forever.
          if (counter.willExceed()) throw new ToolCallsLimitExceeded(counter.limit);
          counter.increment();
        }
        // Preserve the exact JSON corrective for the model while retaining a
        // nominal, local-only proof for the surrounding effect ledger. A
        // provider-returned object or marker can never manufacture this class.
        const refusal = new ExternalWritePreDispatchResult(
          JSON.stringify(payload),
          typeof payload.error === 'string' ? payload.error : 'call_tool_refused',
        );
        if (resolvedRefusalTarget) {
          settleResolvedCarrierRefusal({
            resolved: resolvedRefusalTarget,
            lane: options.resolvedRefusalLane ?? 'agents_runner',
            refusal,
            classification,
          });
        }
        return refusal as unknown as string;
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

      // 3. Canonicalize representation drift, then Zod-validate BEFORE
      // dispatch — zero side effects on failure. This is deliberately before
      // the irreversible-send check so every surface reasons over the same
      // canonical invocation.
      const carrierNormalization = normalizeCallToolComposioCarrier(target, resolvedArgs);
      if (!carrierNormalization.ok) {
        return refuse({
          error: 'arg_validation',
          detail: carrierNormalization.detail,
          violations: carrierNormalization.violations,
          schemaHash: carrierNormalization.schemaHash,
          contract: carrierNormalization.contract,
          repair: carrierNormalization.repair,
        });
      }
      resolvedArgs = carrierNormalization.args;
      const carrierValidationError = composioCarrierValidationError(target, resolvedArgs);
      if (carrierValidationError) {
        return refuse({
          error: 'arg_validation',
          ...(carrierValidationError.reason ? { reason: carrierValidationError.reason } : {}),
          detail: carrierValidationError.detail,
        });
      }
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

      let exactTargetInputSchema: unknown | null = strictParameters
        ?? (schema ? z.toJSONSchema(schema) : null);
      // A named external tool may be outside the advertised cap while still
      // inside the accepted turn's authority. Resolve its real schema from the
      // exact authorized server catalog before expected-work admission.
      if (options.aroundResolvedDispatch && !exactTargetInputSchema && isMcpNamespacedTool(target)) {
        const { resolveAuthorizedExternalMcpToolDefinition } = await import('../runtime/mcp-servers.js');
        const definition = await resolveAuthorizedExternalMcpToolDefinition(target, activeMcpScope);
        exactTargetInputSchema = definition?.inputSchema ?? null;
      }

      let evidenceArgs: unknown = dispatchArgs;
      let evidenceInputSchema: unknown | undefined;
      if (options.aroundResolvedDispatch && target === 'composio_execute_tool') {
        const canonical = normalizeComposioCarrierInput(dispatchArgs);
        if (canonical.ok) {
          evidenceArgs = canonical.canonical.args;
          const { ensureToolSchema } = await import('./composio-schema-cache.js');
          evidenceInputSchema = await ensureToolSchema(canonical.canonical.toolSlug) ?? undefined;
        }
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
      const activeRunContext = harnessRunContextStorage.getStore();
      if (
        currentLogicalCall()
        && activeRunContext?.sessionId === sessionId
        && Number.isSafeInteger(activeRunContext.sourceUserSeq)
        && (activeRunContext.sourceUserSeq ?? 0) > 0
      ) {
        authorizeResolvedLogicalCallContract({
          sessionId,
          sourceUserSeq: activeRunContext.sourceUserSeq as number,
          turn: activeRunContext.turn,
          tool: target,
          effectiveArgs: dispatchArgs,
        });
        resolvedRefusalTarget = {
          sessionId,
          sourceUserSeq: activeRunContext.sourceUserSeq,
          turn: activeRunContext.turn,
          logicalToolCallId: currentLogicalCall()?.logicalToolCallId,
          targetName: target,
          targetArgs: dispatchArgs,
          targetInputSchema: exactTargetInputSchema,
        };
      }
      const counter = activeRunContext?.counter ?? new ToolCallsCounter(1000);
      const outerCallId = details?.toolCall?.callId ?? details?.toolCall?.id;
      if (!isMcpNamespacedTool(target)) {
        // Capability admission is a PRE-DISPATCH authority boundary. The
        // callback is optional solely for legacy/custom call_tool instances;
        // when production supplies it, throwing or refusing fails closed and
        // spends exactly the wrapper attempt through refuse().
        if (options.admitBuiltinAcquisition) {
          let admission: BuiltinCapabilityAdmissionResult;
          try {
            admission = await options.admitBuiltinAcquisition(target);
          } catch (error) {
            admission = {
              ok: false,
              kind: 'requires_readmission',
              outside: [target],
              reason: error instanceof Error ? error.message : String(error),
            };
          }
          if (!admission.ok) {
            return refuse({
              error: 'requires_readmission',
              kind: admission.kind,
              outside: [...admission.outside],
              detail: admission.reason
                ?? `"${target}" is not admitted by the active sealed capability revision.`,
            }, 'policy_denial');
          }
        }
        if (options.onBuiltinAcquisition) {
          try {
            options.onBuiltinAcquisition(target);
          } catch {
            // Acquisition observation is instrumentation; dispatch never dies for it.
          }
        }
      }
      const dispatch = () => dispatchBatchItemTool(
          target,
          dispatchArgs,
          sessionId,
          counter,
          // call_tool authority is turn-scoped and may not carry a batch/pending
          // grant into another target. Approved durable calls store the validated
          // INNER tool directly; a legacy/synthetic carrier must pass the inner
          // send floor instead of widening outer authority.
          undefined,
          { accounting: 'transport_mirror', canonicalCallId: outerCallId },
          activeMcpScope,
        );
      let out: unknown;
      try {
        out = options.aroundResolvedDispatch
          ? await options.aroundResolvedDispatch({
              sessionId,
              sourceUserSeq: activeRunContext?.sourceUserSeq,
              turn: activeRunContext?.turn,
              logicalToolCallId: currentLogicalCall()?.logicalToolCallId,
              targetName: target,
              targetArgs: dispatchArgs,
              targetInputSchema: exactTargetInputSchema,
              ...(evidenceArgs !== dispatchArgs ? { evidenceArgs } : {}),
              ...(evidenceInputSchema ? { evidenceInputSchema } : {}),
            }, dispatch)
          : await dispatch();
      } catch (error) {
        if (resolvedRefusalTarget && error instanceof ExternalWritePreDispatchError) {
          settleResolvedCarrierRefusal({
            resolved: resolvedRefusalTarget,
            lane: options.resolvedRefusalLane ?? 'agents_runner',
            refusal: error,
            classification: 'policy_denial',
          });
        }
        throw error;
      }

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
      // TRUTH AT THE TRANSPORT. Every deferred built-in reaches the Claude lane
      // through here, so this is where a harness refusal stops looking like an
      // answer. The consumer already reads `isError`; nothing ever set it, so a
      // pre-dispatch rejection and a real result were indistinguishable and an
      // identical payload could be sent straight back (live 2026-08-09).
      const rendered = jsonResult(output);
      return textResult(rendered, { isError: isHarnessRefusalText(rendered) });
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
