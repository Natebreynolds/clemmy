import { Agent, Runner, MaxTurnsExceededError } from '@openai/agents';
import type { Handoff, Tool } from '@openai/agents';
import { MODELS, getRuntimeEnv } from '../config.js';
import { resolveRoleModel } from '../runtime/harness/model-roles.js';
import { getCoreToolsAsync } from '../tools/registry.js';
import { WORKFLOW_STEP_BLOCKED_TOOL_NAMES } from './workflow-step-agent.js';
import { getOrCreateExternalMcpServers } from '../runtime/mcp-servers.js';
import type { McpToolScope } from '../runtime/mcp-tool-scope.js';
import type { RuntimeContextValue } from '../types.js';
import {
  wrapToolForHarness,
  withHarnessRunContext,
  ToolCallsCounter,
  defaultToolCallsPerTurn,
  workerThrashGuardEnabled,
  type WrappableTool,
} from '../runtime/harness/brackets.js';
import { getGoalPinForDelegation } from './plan-proposals.js';
import { sessionIdFromRunContext } from '../runtime/harness/tool-output-context.js';
import { buildWorkerJobPrompt, resolveWorkerMaxTurns, type WorkerToolInput } from './worker-job-packet.js';
import { normalizeWorkerOutput } from './worker-output.js';

/**
 * Sub-agents.
 *
 * Phase 3 (2026-05-23): the Orchestrator (now display-name "Clem") is
 * a SINGLE agent that completes the user's request without delegating.
 * The five specialized sub-agents that used to live here —
 * Researcher / Writer / Reviewer / Executor / Deployer — were removed
 * on 2026-05-24 after telemetry confirmed they had been dormant since
 * the single-agent prompt landed (last handoff event: 2026-05-21).
 *
 * What survives:
 *
 *   - Worker — a STATELESS LEAF agent the Orchestrator calls as a
 *     tool (via Agent.asTool or run_worker) to fan out independent
 *     items in parallel. Each invocation runs in its own SDK context,
 *     so 50 workers in flight ≈ 50 isolated ~10K-token contexts
 *     instead of one balloon. Used by src/execution/background-tasks.ts
 *     for parallel writes (50 Salesforce tasks, 10 DataForSEO scrapes,
 *     etc.).
 *
 *   - defaultOrchestratorHandoffs — kept as an empty array so any
 *     caller still wiring handoffs (legacy openai runtime, autonomy-v2)
 *     keeps working without conditionals.
 *
 *   - isOrchestratorSlug — autonomy-v2 still asks "is this agent slug
 *     the orchestrator?" for configuration decisions. Unchanged.
 */

type SubAgent = Agent<RuntimeContextValue>;
// Open generic on the second slot so the same handoff array works
// for both structured-output and text-output parent agents. Kept for
// type-compat with the runtime caller signatures.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type OrchestratorHandoff = SubAgent | Handoff<RuntimeContextValue, any>;

export interface OrchestratorHandoffOptions {
  requireWorkflowApprovalForExecution?: boolean;
}

/**
 * Wrap a sub-agent's tools so every execute fires through the harness
 * boundary (per-tool timeout + mid-turn kill check + pre-increment
 * limit check). No-op when HARNESS_TOOL_BRACKETS is off.
 */
function wrapTools(tools: Tool<RuntimeContextValue>[]): Tool<RuntimeContextValue>[] {
  return tools.map((t) =>
    wrapToolForHarness(t as unknown as WrappableTool) as unknown as Tool<RuntimeContextValue>,
  );
}

// Worker = a stateless leaf agent the Orchestrator (or any parent) can
// invoke as a TOOL via Agent.asTool(). When the parent calls the worker
// tool N times in one turn, the SDK runs N workers in PARALLEL, each
// with its own conversation context. That's how "scrape 100 accounts"
// gets fan-out: the parent's model fires the worker tool in parallel
// batches, and each worker handles ONE item in isolation.
//
// TOOL SURFACE — BLOCKLIST, NOT ALLOWLIST (changed 2026-06-01).
// Previously a hard 20-name allowlist (`WORKER_TOOL_NAMES`). That was the
// root cause of "Clementine dispatches a worker to use tool X, the worker
// doesn't have X": any NATIVE tool not pre-listed was invisible, so the
// worker punted, looped, or reported a tool "isn't exposed" on data that
// was right there. Native tools are CHEAP (the schemas are small + bounded);
// gating them bought ~no tokens and caused the silliness. The expensive
// long tail (thousands of Composio actions) is reached by DISCOVERY
// (composio_search_tools → composio_execute_tool), never preloaded — so
// the worker context stays ~10K regardless.
//
// So: the worker now gets the FULL native surface MINUS the same
// recursion/meta vectors a workflow step is denied (WORKFLOW_STEP_BLOCKED_
// TOOL_NAMES: no run_worker/workflow-authoring/run/cron/create_tool/
// plan-authoring/ask_user_question), PLUS `notify_user` — a parallel fan-out
// of workers each pinging the user is collision/clutter, and a worker can't
// meaningfully converse mid-item. Everything else (memory, files, shell,
// git, ALL composio, recall_tool_result/tool_output_query, skills, CLIs,
// executions, capability, browser, vault) is reachable. If the orchestrator
// tells a worker to use a native tool, the worker now HAS it.
// Lazily computed: sub-agents ← orchestrator ← workflow-step-agent forms an
// import cycle, so reading WORKFLOW_STEP_BLOCKED_TOOL_NAMES at module-eval time
// hits a TDZ ReferenceError. Defer the read to first call, by which point all
// modules are initialized.
let _workerBlockedToolNames: Set<string> | null = null;
function workerBlockedToolNames(): Set<string> {
  if (!_workerBlockedToolNames) {
    _workerBlockedToolNames = new Set<string>([...WORKFLOW_STEP_BLOCKED_TOOL_NAMES, 'notify_user']);
  }
  return _workerBlockedToolNames;
}

/** Full native surface minus the recursion/meta/collision vectors. */
function filterToolsForWorker<T extends { name?: string }>(tools: T[]): T[] {
  const blocked = workerBlockedToolNames();
  return tools.filter(
    (tool) => !(typeof tool?.name === 'string' && blocked.has(tool.name)),
  );
}

export async function buildWorkerAgent(options: { mcpToolScope?: McpToolScope; model?: string } = {}): Promise<SubAgent> {
  const all = await getCoreToolsAsync({ includeDynamicComposioTools: false });
  const tools = filterToolsForWorker(all) as Tool<RuntimeContextValue>[];
  const baseInstructions = [
      'You are a Worker — a stateless, single-task sub-agent inside Clementine.',
      'Your scope is ONE item. The parent agent fans out across N items by calling you N times in parallel; each call is a fresh, isolated context.',
      'Rules:',
      '  - Do exactly the work described in the input prompt. Do not ask follow-up questions, do not deliberate, do not branch into other tasks.',
      '  - If the input contains a [WORKER JOB PACKET], treat its resolvedTools/context/instructions as authoritative. Use exact slugs/commands/schemas from resolvedTools; do NOT rediscover those same capabilities.',
      '  - Use the smallest set of tool calls needed. Discovery → execute when the action is external and not already resolved by the parent packet.',
      '  - If the parent named a specific skill or the item clearly needs installed skill rules, call `skill_read` for that skill. Otherwise do not spend worker context on skill discovery.',
      '  - Return a TIGHT, structured result on the last line: a single sentence, a JSON object, or a bullet list. The parent will aggregate hundreds of these — keep yours compact.',
      '  - If a tool call fails or returns a result missing the data you need, fix and retry that call ONCE: re-run discovery to get the exact slug/id, narrow the query, or adjust arguments from the error. A failing tool result is information, not a stop sign. Do NOT re-issue the SAME call with identical arguments — that is a loop and will be cut off; change something or move on.',
      '  - If a tool result shows a `[clipped: …]` or `[digest: …]` footer with a call_id, the full payload is stored and retrievable RIGHT NOW: call `tool_output_query("call_id", …)` for specific records or `recall_tool_result("call_id")` for the raw output. Never report that the data is unavailable, that a reader "isn\'t exposed", or that a completed call is still pending — pull it.',
      '  - Only after one genuine retry fails should you give up. Return a single line starting with "ERROR:" and the specific reason, including which tool failed and what data was missing. Never return a normal-looking result when the item did not actually complete.',
      '  - Fill per-item artifacts (email/Outlook draft, record, message) with the REAL identity values from your data. If your item is "draft an email to account X", the draft carries X\'s actual recipient address and a real first-name greeting from the data you were given or fetched — never a blank or "Hi there". If a required identity field (recipient email, contact first name) is genuinely missing for your item and one retry to fetch it fails, do NOT produce a hollow draft — return "ERROR: missing <field> for <item>" so the parent can decide.',
      '  - Do NOT call notify_user, ask_user_question, or write to shared tasks/executions — those mutate state your sibling workers also touch and create race conditions.',
      'You may write per-item artifacts (write_file with a unique path) if the parent\'s prompt asks for them. Otherwise, prefer returning the result inline.',
    ].join('\n\n');
  return new Agent<RuntimeContextValue>({
    name: 'Worker',
    handoffDescription: 'Stateless per-item worker. Use via run_worker tool for parallel fan-out.',
    // Instructions are a FUNCTION so a worker fanned out from a chat session
    // inherits that session's parked GOAL (goal-contract P3 — replaced the
    // Active Task pin). Keyed by the parent run context's sessionId — never
    // a global — so no unrelated session's goal can leak in. Zero-width
    // (base instructions) when the session has no active goal.
    instructions: (runContext) => {
      try {
        const pin = getGoalPinForDelegation(sessionIdFromRunContext(runContext) ?? '');
        if (pin) {
          return `${baseInstructions}\n\n## Pinned Goal (from the session that started this work — work toward EXACTLY this; do NOT re-discover or substitute a different target)\n${pin}`;
        }
      } catch {
        // best-effort enrichment; never break worker construction.
      }
      return baseInstructions;
    },
    // Worker = delegated grunt-work labor. The role→model registry resolves the
    // worker model (a UI/chat binding wins; else the provider-derived default,
    // which delegates to getWorkerModel() → MODELS.primary, byte-identical to
    // the old behavior). The registered provider still routes the resulting id.
    model: options.model ?? resolveRoleModel('worker').modelId,
    tools: wrapTools(tools),
    // External MCP servers (DataForSEO, Supabase, browsermcp, etc.)
    // the user has configured. Tools surface as `<server>__<tool>`.
    // Local clementine MCP is excluded — those tools are already in
    // `tools` via getCoreToolsAsync(), and duplicating would force the
    // model to disambiguate (memory_remember vs clementine-local__memory_remember).
    mcpServers: [getOrCreateExternalMcpServers(options.mcpToolScope)],
  });
}

export interface CrossProviderWorkerResult {
  text: string;
  model: string;
  toolUses: string[];
}

/** Per-worker loop-guard scope sequence — mirrors brackets.workerScopeIdFromDetails
 *  so parallel cross-provider workers each get their OWN loop-guard window
 *  instead of poisoning the one shared session tracker. */
let crossWorkerScopeSeq = 0;

/**
 * Run ONE parent-planned item on a NON-Claude worker model, using the SAME
 * `@openai/agents` Worker agent the orchestrator lane fans out — for the Claude
 * SDK brain lane, which has no `@openai/agents` run context of its own to invoke
 * `worker.asTool().invoke(runContext, …)` against. This is the cross-provider
 * parity path: it reuses `buildWorkerAgent` (harness-wrapped tools, goal-pin
 * inheritance) and runs it via a standalone `Runner` — the same primitive under
 * `asTool` — so the resolved model id routes through the global
 * RouterModelProvider to its real provider (Codex/GLM/BYO/…).
 *
 * Parity with the orchestrator's nested worker:
 *   - installs the parent `sessionId` via withHarnessRunContext so the
 *     harness-wrapped worker tools resolve the real session (kill/pause/plan-
 *     scope/recall/gates), not an empty one;
 *   - a UNIQUE guardrailScopeId so N parallel workers don't poison one loop-guard
 *     tracker (behind CLEMMY_WORKER_THRASH_GUARD, like the nested lane);
 *   - the intent-aware worker turn cap (resolveWorkerMaxTurns);
 *   - the cap → `ERROR:` envelope via normalizeWorkerOutput (identical to the
 *     nested lane's customOutputExtractor), so a capped worker is a FAILED item,
 *     never a hollow done, and hooks.ts fires worker_capped.
 *
 * Throws only on a genuine execution error (provider down, etc.) — a turn cap is
 * converted to the ERROR envelope and returned, never thrown, exactly like the
 * nested asTool path.
 */
export async function runCrossProviderWorker(
  input: WorkerToolInput,
  modelId: string,
  sessionId: string,
): Promise<CrossProviderWorkerResult> {
  const worker = await buildWorkerAgent({ model: modelId });
  const guard = workerThrashGuardEnabled();
  // Base per-item turn budget — mirrors the orchestrator nested lane
  // (CLEMMY_WORKER_MAX_TURNS default 8, intent-aware ceiling on top).
  const base = (() => {
    const n = Number.parseInt(getRuntimeEnv('CLEMMY_WORKER_MAX_TURNS', '8') ?? '8', 10);
    return Number.isFinite(n) && n >= 2 ? n : 8;
  })();
  const maxTurns = guard ? resolveWorkerMaxTurns(input.intent, base) : base;
  // A generous tool-call ceiling so maxTurns + the identical-args loop-guard stay
  // the real bounds (a multi-turn worker legitimately makes several calls); this
  // counter only exists to satisfy the harness context + catch true runaways.
  const counter = new ToolCallsCounter(Math.max(defaultToolCallsPerTurn(), maxTurns * 4));
  const scopeId = `${sessionId}::sdkx:${Date.now()}-${(crossWorkerScopeSeq = (crossWorkerScopeSeq + 1) % 1_000_000)}`;
  const runner = new Runner({ workflowName: 'clementine-sdk-brain-cross-worker', groupId: sessionId });
  try {
    const result = await withHarnessRunContext(
      { sessionId, counter, ...(guard ? { guardrailScopeId: scopeId } : {}) },
      () =>
        runner.run(worker, buildWorkerJobPrompt(input), {
          context: { sessionId, turn: 0 },
          maxTurns,
        }),
    );
    return { text: normalizeWorkerOutput(result), model: modelId, toolUses: [] };
  } catch (err) {
    // A turn cap on a standalone Runner.run THROWS (unlike asTool, which soft-
    // converts). Mirror the nested lane: turn the cap into the same ERROR
    // envelope (normalizeWorkerOutput('') → "hit its turn cap …") so the ledger
    // marks the item failed and worker_capped fires. Real infra errors propagate
    // to the run_worker handler's catch (which records + returns its ERROR text).
    if (err instanceof MaxTurnsExceededError) {
      return { text: normalizeWorkerOutput(''), model: modelId, toolUses: [] };
    }
    throw err;
  }
}

/**
 * Empty handoff array. Kept as an export for backward compat with
 * legacy callers (src/runtime/openai.ts, src/agents/autonomy-v2.ts)
 * that still pass `handoffs: await defaultOrchestratorHandoffs(...)`
 * into Agent constructors. With single-agent mode (Phase 3), the
 * Orchestrator never hands off — Worker is invoked as a TOOL via
 * `run_worker`, not as a handoff target.
 */
export async function defaultOrchestratorHandoffs(
  _options: OrchestratorHandoffOptions = {},
): Promise<OrchestratorHandoff[]> {
  return [];
}

/**
 * Slugs that, by default, get orchestrator-style configuration. Used
 * by autonomy-v2.getAgent to decide whether to wire the orchestrator
 * surface. The primary `clementine` agent is the orchestrator out of
 * the box; other agents can opt in via the env var.
 */
export function isOrchestratorSlug(slug: string): boolean {
  if (slug === 'clementine') return true;
  const extras = getRuntimeEnv('AUTONOMY_ORCHESTRATOR_SLUGS', '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return extras.includes(slug);
}
