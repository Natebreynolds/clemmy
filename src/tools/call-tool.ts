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
import { z } from 'zod';
import type { RuntimeContextValue } from '../types.js';
import { getToolOutputContext, sessionIdFromRunContext } from '../runtime/harness/tool-output-context.js';
import { harnessRunContextStorage, ToolCallsCounter, ToolCallsLimitExceeded } from '../runtime/harness/brackets.js';
import { resolveToolSurface } from '../runtime/harness/tool-surface.js';
import { dispatchBatchItemTool, isMcpNamespacedTool } from './code-mode-tool.js';
import { deriveOrchestratorDiscoveryNames } from './tool-registry.js';
import { recordToolHit } from '../agents/tool-hotset.js';

const DESCRIPTION = [
  'Invoke a built-in tool that is in the catalog but not currently one of your first-class tools. Pass the exact tool `name` (from the catalog / tool_search) and `args_json` — a JSON object string of that tool\'s arguments (use "{}" for none).',
  'Use this to reach a catalog-only tool without a round-trip: e.g. call_tool("workflow_schedule", "{\\"workflow_id\\":\\"...\\"}").',
  'APPROVAL: call_tool never prompts on its own — the target tool\'s own classification decides. A read runs immediately; a write/send/irreversible target gates for approval exactly as if you had called it directly.',
  'If the arguments do not match the tool\'s schema, call_tool returns the schema and an error and makes NO change — fix the args and call again. If you are unsure of the exact name or args, call tool_search first.',
].join(' ');

/** Lazily-built, memoized name → Zod schema map for local runtime tools. Dynamic
 *  imported so this module (imported by the orchestrator) never forms an eval-time
 *  cycle with the runtime tool registry. */
let schemaCache: Map<string, z.ZodTypeAny> | null = null;
async function localSchemas(): Promise<Map<string, z.ZodTypeAny>> {
  if (!schemaCache) {
    try {
      const { getLocalToolSchemas } = await import('./local-runtime-tools.js');
      schemaCache = getLocalToolSchemas();
    } catch {
      schemaCache = new Map();
    }
  }
  return schemaCache;
}

function jsonResult(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? null);
}

export interface BuildCallToolOptions {
  /** Exact built-in names advertised as deferred on this turn. Omit for the
   * legacy full orchestrator surface (tests and non-scoped callers). */
  reachableBuiltinNames?: ReadonlySet<string>;
  /** Explicit per-turn denials also apply to external MCP names. */
  deniedNames?: ReadonlySet<string>;
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
      const target = (name ?? '').trim();
      if (!target) return refuse({ error: 'bad_request', detail: 'name is required' });

      if (deniedNames.has(target)) {
        return refuse({
          error: 'not_reachable',
          detail: `"${target}" is excluded from this turn's effective tool policy.`,
        });
      }

      // 1. Authority — never escalate past the curated orchestrator surface.
      // External MCP names (<server>__<tool>) are admitted here and enforced
      // DOWNSTREAM: dispatchBatchItemTool resolves them against the session's
      // connected MCP scope (unknown/unconnected servers error honestly) and
      // routes approval through decideToolApproval on the inner name — the
      // same contract as run_batch/run_tool_program. Refusing them here was a
      // live Phase-1 gap (2026-07-08): the model fell back to hand-rolling the
      // provider's REST API through shell calls, slower and less gated.
      if (!isMcpNamespacedTool(target)) {
        if (!reachableBuiltinNames.has(target)) {
          return refuse({
            error: 'not_reachable',
            detail: `"${target}" is not a deferred callable tool on this turn's surface. Call a first-class tool directly, use tool_search for an available deferred tool, or use a connected external MCP tool as <server>__<tool>.`,
          });
        }
      }

      // 2. Parse args_json.
      let args: unknown = {};
      const raw = (args_json ?? '').trim();
      if (raw) {
        try {
          args = JSON.parse(raw);
        } catch {
          return refuse({ error: 'arg_validation', detail: 'args_json is not valid JSON' });
        }
      }

      // 3. Zod-validate BEFORE dispatch — zero side effects on failure.
      const schema = (await localSchemas()).get(target);
      if (schema) {
        const parsed = schema.safeParse(args);
        if (!parsed.success) {
          return refuse({
            error: 'arg_validation',
            schema: z.toJSONSchema(schema),
            detail: parsed.error.issues
              .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
              .join('; '),
          });
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
      const counter = harnessRunContextStorage.getStore()?.counter ?? new ToolCallsCounter(1000);
      const out = await dispatchBatchItemTool(target, args, sessionId, counter);

      // 5. Promote the reached tool into the session hot-set.
      recordToolHit(sessionId, target);
      return jsonResult(out);
    },
  });
}

/** Test-only: reset the memoized local-schema map. */
export function _resetCallToolSchemaCacheForTest(): void {
  schemaCache = null;
}
