import { AsyncLocalStorage } from 'node:async_hooks';
import { isKillRequested, appendEvent, getSession, listEvents } from './eventlog.js';
import { getHarnessBudgetSettings } from './budget-settings.js';
import { listPending as listPendingApprovals } from './approval-registry.js';
import { evaluateToolCall, applyMode } from './tool-guardrail.js';
import { normalizeWorkerOutput } from '../../agents/worker-output.js';
import { getRuntimeEnv } from '../../config.js';
import {
  isMutatingExternalWrite,
  isGateEnabled as isExecutionGateEnabled,
  MissingExecutionWrapError,
} from './execution-gate.js';
import {
  classifyExternalWrite,
  decideInstructionReview,
  isConfirmFirstEnabled,
  ConfirmFirstRequiredError,
} from './confirm-first-gate.js';

/**
 * Reliability brackets — the safety primitives the harness loop weaves
 * around every `Runner.run()` call.
 *
 * This module is intentionally just primitives (typed error classes,
 * counter, budget tracker, timeout wrapper). The loop in
 * src/runtime/harness/loop.ts decides where each one fires and turns
 * thrown bracket errors into `guardrail_tripped` events.
 *
 *   - Kill switch    : checked before each turn_started; throws
 *                      `KillRequested` if the session has a row.
 *   - Tool-call cap  : 8 calls per turn (configurable); counter
 *                      increments from the same hook surface that
 *                      writes the event log.
 *   - Per-tool timeout: Promise.race wrapper applied to the tool
 *                      invocation; throws `ToolTimeout` on expiry.
 *   - Token budget   : tracked across the run; condenser fires at
 *                      50%, soft-halt at 80%, hard halt above budget.
 *
 * SDK-native max_turns is set on the Runner itself — not in this
 * module — via `Runner({ maxTurns })`. DEFAULT_MAX_TURNS below is the
 * recommended per-role cap the loop passes through.
 */

export class KillRequested extends Error {
  constructor(public readonly sessionId: string) {
    super(`session ${sessionId} has a pending kill request`);
    this.name = 'KillRequested';
  }
}

export class ToolCallsLimitExceeded extends Error {
  constructor(public readonly limit: number) {
    super(`tool calls per turn exceeded the limit of ${limit}`);
    this.name = 'ToolCallsLimitExceeded';
  }
}

export class ToolTimeout extends Error {
  constructor(
    public readonly toolName: string,
    public readonly ms: number,
  ) {
    super(`tool ${toolName} timed out after ${ms}ms`);
    this.name = 'ToolTimeout';
  }
}

export class TokenBudgetExceeded extends Error {
  constructor(
    public readonly used: number,
    public readonly budget: number,
  ) {
    super(`token budget exceeded: ${used}/${budget}`);
    this.name = 'TokenBudgetExceeded';
  }
}

/** Throws `KillRequested` if the kill_switches table has a row for sessionId. */
export function assertNotKilled(sessionId: string): void {
  if (isKillRequested(sessionId)) {
    throw new KillRequested(sessionId);
  }
}

/**
 * Per-turn tool-call counter. The loop instantiates one per turn and
 * subscribes its `increment` to the SDK's `agent_tool_start` event.
 * Throwing from that listener surfaces as a run error.
 */
export class ToolCallsCounter {
  private count = 0;

  constructor(public readonly limit: number) {
    if (limit < 1) {
      throw new Error(`ToolCallsCounter limit must be >= 1, got ${limit}`);
    }
  }

  /** Increment; throws once the per-turn cap is exceeded. */
  increment(): void {
    this.count += 1;
    if (this.count > this.limit) {
      throw new ToolCallsLimitExceeded(this.limit);
    }
  }

  /**
   * Non-mutating predicate: would the next increment exceed the limit?
   * Used by wrapToolForHarness to throw BEFORE the tool's execute
   * starts running. The previous post-hoc check (increment after the
   * SDK's `agent_tool_start` hook) allowed the (limit+1)th tool to
   * begin work + consume time + cause side-effects before the throw
   * surfaced. This predicate lets the wrapper bail at the entry edge.
   */
  willExceed(): boolean {
    return this.count + 1 > this.limit;
  }

  reset(): void {
    this.count = 0;
  }

  get currentCount(): number {
    return this.count;
  }
}

export interface TokenBudgetCounts {
  inputTokens: number;
  outputTokens: number;
}

export interface TokenBudgetSnapshot {
  used: TokenBudgetCounts;
  budget: TokenBudgetCounts;
}

export interface TokenBudgetOptions {
  /** Default 0.5 (50%). Called once when crossing the threshold from below. */
  condenserFraction?: number;
  /** Default 0.8 (80%). Called once when crossing the threshold from below. */
  softHaltFraction?: number;
  /** Fired once when crossing condenserFraction. */
  onCondenserTrigger?: (snapshot: TokenBudgetSnapshot) => void;
  /** Fired once when crossing softHaltFraction. */
  onSoftHalt?: (snapshot: TokenBudgetSnapshot) => void;
}

/**
 * Tracks input/output token usage across a run. Fires single-shot
 * callbacks at the condenser and soft-halt thresholds. The loop is
 * responsible for converting these into harness events
 * (`condenser_applied`, `guardrail_tripped`) and deciding whether to
 * actually compact or halt.
 */
export class TokenBudgetTracker {
  private inputUsed = 0;
  private outputUsed = 0;
  private firedCondenser = false;
  private firedSoftHalt = false;

  constructor(
    public readonly inputBudget: number,
    public readonly outputBudget: number,
    private readonly options: TokenBudgetOptions = {},
  ) {
    if (inputBudget < 1 || outputBudget < 1) {
      throw new Error(
        `TokenBudgetTracker budgets must be >= 1, got input=${inputBudget} output=${outputBudget}`,
      );
    }
  }

  /** Add usage and report which thresholds, if any, just fired. */
  add(input: number, output: number): { triggeredCondenser: boolean; triggeredSoftHalt: boolean } {
    this.inputUsed += Math.max(0, input);
    this.outputUsed += Math.max(0, output);

    const condenserFrac = this.options.condenserFraction ?? 0.5;
    const softHaltFrac = this.options.softHaltFraction ?? 0.8;

    const fraction = Math.max(
      this.inputUsed / this.inputBudget,
      this.outputUsed / this.outputBudget,
    );

    const triggeredCondenser = !this.firedCondenser && fraction >= condenserFrac;
    const triggeredSoftHalt = !this.firedSoftHalt && fraction >= softHaltFrac;

    if (triggeredCondenser) {
      this.firedCondenser = true;
      this.options.onCondenserTrigger?.(this.snapshot());
    }
    if (triggeredSoftHalt) {
      this.firedSoftHalt = true;
      this.options.onSoftHalt?.(this.snapshot());
    }

    return { triggeredCondenser, triggeredSoftHalt };
  }

  /** Throws if usage is over budget. */
  assertWithinBudget(): void {
    if (this.inputUsed > this.inputBudget || this.outputUsed > this.outputBudget) {
      throw new TokenBudgetExceeded(
        this.inputUsed + this.outputUsed,
        this.inputBudget + this.outputBudget,
      );
    }
  }

  snapshot(): TokenBudgetSnapshot {
    return {
      used: { inputTokens: this.inputUsed, outputTokens: this.outputUsed },
      budget: { inputTokens: this.inputBudget, outputTokens: this.outputBudget },
    };
  }

  reset(): void {
    this.inputUsed = 0;
    this.outputUsed = 0;
    this.firedCondenser = false;
    this.firedSoftHalt = false;
  }
}

/**
 * Promise.race-based timeout for tool invocations. Throws `ToolTimeout`
 * on expiry. The underlying work continues in the background — we just
 * stop waiting; callers are responsible for any abort signal they wire
 * into the tool itself.
 *
 * Approval-pause awareness (added v0.5.5): the SDK pauses the tool
 * BEFORE its execute body runs when the approval registry has a
 * pending row for this session — i.e. the timer was started but the
 * tool isn't actually doing work. Without this guard, a tool parked
 * on approval for > timeoutMs (60s default, 10min for shell) throws
 * ToolTimeout, dropping the run. With it: when the timer fires, we
 * consult `options.isPaused()`. If true, we re-arm for another window
 * (default 30s) and trust the approval registry; the user's "think
 * time" stops blocking the timeout entirely. If false, we throw as
 * before. Existing callers (MCP connect/list at mcp-namespace-shim
 * lines 338/387) don't pass options and get unchanged behavior.
 */
export function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  toolName: string,
  options?: { isPaused?: () => boolean; pauseRecheckMs?: number },
): Promise<T> {
  const pauseRecheckMs = options?.pauseRecheckMs ?? 30_000;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const fireOrDefer = (): void => {
      if (settled) return;
      // Approval pause check — if the registry shows a pending
      // approval for this session, the tool is parked, not stuck.
      // Re-arm without throwing. The reaper handles stale approvals
      // on its own schedule (see [[project_long_running_audit]]) —
      // if the registry is broken and reports pending forever, that's
      // a separate bug we don't compensate for here.
      let paused = false;
      try { paused = options?.isPaused?.() ?? false; } catch { paused = false; }
      if (paused) {
        setTimeout(fireOrDefer, pauseRecheckMs).unref?.();
        return;
      }
      reject(new ToolTimeout(toolName, ms));
    };
    setTimeout(fireOrDefer, ms).unref?.();
    work.then(
      (value) => {
        settled = true;
        resolve(value);
      },
      (err: unknown) => {
        settled = true;
        reject(err);
      },
    );
  });
}

/**
 * Recommended per-tool timeouts. Caller can override per-tool.
 *
 * Calibrated 2026-05-24 from real workloads observed in production:
 *
 *   - `default` (60s): internal tools — memory_*, workspace_*, file
 *     reads, plan/note writes. All complete in <5s in practice; 60s
 *     gives 12x headroom for slow disk or large vault re-indexes.
 *
 *   - `shell` (10min): `run_shell_command` and shell_* — covers long
 *     Salesforce `sf` CLI queries, large `gh` API pages, slow npm
 *     installs in workspaces. 10 min matches the prior production
 *     value and has never false-killed a legitimate command.
 *
 *   - `externalApi` (5min, NEW): `composio_execute_tool` and any
 *     other tool that fans out to a 3rd-party HTTP API. Without this
 *     bucket, Composio calls fell to `default` (60s) and would
 *     false-kill on a slow Salesforce SOQL or a large Google Sheets
 *     `values.get`. 5 minutes covers the p99 of real Composio
 *     calls observed in eventlog.
 *
 *   - `mcp` (10min, WAS 30s): MCP-namespaced tools like DataForSEO
 *     scrapes, Supabase queries, browser tool. DataForSEO scrapes
 *     ROUTINELY take 5-10 minutes — 30s would false-kill nearly
 *     every legitimate scrape. The original comment in this file
 *     called out "10-min DataForSEO scrape" as the justification for
 *     the kill check, yet the mcp timeout was 30s — a latent bug
 *     waiting for brackets to actually activate (which they did
 *     2026-05-24 via F1 env injection).
 */
export const DEFAULT_TIMEOUTS_MS = {
  default: 60_000,
  shell: 600_000,
  externalApi: 300_000,
  mcp: 600_000,
} as const;

/** Pick a default timeout from the tool name. */
export function timeoutForTool(toolName: string): number {
  if (toolName === 'run_shell_command') return DEFAULT_TIMEOUTS_MS.shell;
  if (/^(exec|spawn|launch|run_shell|shell_)/.test(toolName)) {
    return DEFAULT_TIMEOUTS_MS.shell;
  }
  // External-API tools that fan out to 3rd-party services. The
  // canonical case is composio_execute_tool (single tool, hundreds
  // of upstream toolkits). Pattern-matches future siblings.
  if (toolName === 'composio_execute_tool' || /^(composio|external_api)_/.test(toolName)) {
    return DEFAULT_TIMEOUTS_MS.externalApi;
  }
  // v0.5.20 Bug I — run_worker spawns a sub-agent that itself does
  // tool calls (scrapes, SERP queries, file reads). Default 60s
  // was way too short — observed sess-mpktnbps timeout at 60s on
  // a worker doing firecrawl_search for LinkedIn URL lookup. The
  // worker IS the external-API surface from the parent agent's
  // perspective. 5min externalApi bucket is the right shape.
  //
  // v0.5.21.1 — extended to ALL sub-agent-as-tool wrappings. Verified
  // 2026-05-25 on sess-mplmvrqu: draft_plan (planner.asTool) timed
  // out at 60s during a chronic Codex-flake window — same root cause
  // as run_worker. Bucket policy: any tool that internally spins
  // up another agent (which itself makes a Codex call) belongs in
  // externalApi. Pattern-matched on the known names so we don't have
  // to hand-curate every future asTool() wrap.
  if (
    toolName === 'run_worker' || /^run_worker/.test(toolName) ||
    toolName === 'draft_plan'
  ) {
    return DEFAULT_TIMEOUTS_MS.externalApi;
  }
  // MCP namespace shim separator is "__" (src/runtime/mcp-namespace-shim.ts).
  if (toolName.includes('__')) {
    return DEFAULT_TIMEOUTS_MS.mcp;
  }
  return DEFAULT_TIMEOUTS_MS.default;
}

/** Per-role max-turn caps. The loop passes these into `Runner({maxTurns})`. */
export const DEFAULT_MAX_TURNS: Readonly<Record<string, number>> = Object.freeze({
  planner: 2,
  verifier: 2,
  researcher: 6,
  writer: 6,
  reviewer: 6,
  executor: 6,
  deployer: 6,
  // Long-running desktop workflows can legitimately need many
  // model/tool cycles inside one SDK run before the outer 40-step
  // harness loop gets a chance to continue. Keep the real runaway
  // brakes at the conversation wall-clock, step budget, and tool cap.
  orchestrator: 40,
  session: 60,
});

export function maxTurnsForRole(role: keyof typeof DEFAULT_MAX_TURNS): number {
  if (role === 'orchestrator') return getHarnessBudgetSettings().maxTurns;
  return DEFAULT_MAX_TURNS[role];
}

/**
 * Default per-turn tool-call cap.
 *
 * 16 leaves real headroom for legitimate research turns — a
 * Researcher exploring a project routinely needs workspace_roots +
 * workspace_list + memory_recall + memory_search + a few list_files
 * + a few read_file, easily 10-12 calls before producing an answer.
 * The previous value of 8 killed a real session mid-exploration. If
 * the model is genuinely running away, maxTurns and the
 * conversation-level wall-clock catch it; we don't need an
 * aggressive per-turn count limit to do that.
 */
export const DEFAULT_TOOL_CALLS_PER_TURN = 16;

export function defaultToolCallsPerTurn(): number {
  return getHarnessBudgetSettings().toolCallsPerTurn;
}

/** Default token budget. 200k input / 80k output mirrors the plan. */
export const DEFAULT_TOKEN_BUDGET: Readonly<TokenBudgetCounts> = Object.freeze({
  inputTokens: 200_000,
  outputTokens: 80_000,
});

// ───────────────────────────────────────────────────────────────
//  T2.1 — tool-call boundary wrapper
//
// Why this exists: the audit on 2026-05-18 found three failure modes
// at the tool boundary that the existing brackets DID NOT close:
//
//   #6 — Kill switch checked only at turn start. A long-running tool
//        ignores a kill request issued mid-turn until the turn ends.
//   #7 — Tool-call cap allows the (limit+1)th call to START work
//        before the post-hoc `agent_tool_start` hook throws. Side
//        effects + token cost are already committed by the time the
//        rejection fires.
//   #8 — DEFAULT_TIMEOUTS_MS + withTimeout were authored but not
//        wired anywhere. A hanging Composio call (e.g. external API
//        no-response) blocks the whole turn indefinitely.
//
// wrapToolForHarness wraps every tool's `execute` so the three checks
// fire at the tool's entry edge:
//   1. assertNotKilled(sessionId)          — sync; mid-turn kill
//   2. counter.willExceed()                — pre-increment limit
//   3. withTimeout(execute(...), timeout)  — per-tool wall clock
//
// All three read the per-run context from `harnessRunContextStorage`
// (AsyncLocalStorage). The loop installs the context around the SDK's
// runner.run() call; tools called outside that scope get a no-op
// wrapper so non-harness call paths (direct API, tests) aren't broken.
// ───────────────────────────────────────────────────────────────

/**
 * Per-turn budget for recall_tool_result. After Layer 1 of auto-compact
 * clips old tool outputs with stubs that name a call_id, the agent can
 * call `recall_tool_result(call_id)` to retrieve the verbatim original.
 * Without a budget the agent could pull 200KB × 3 calls back into the
 * input prompt that we just compacted. Resets per-turn (the loop builds
 * a new HarnessRunContext per `Runner.run`).
 */
export class RecallBudget {
  private calls = 0;
  private bytes = 0;

  constructor(
    public readonly maxCalls: number,
    public readonly maxBytes: number,
  ) {}

  /**
   * Returns null if budget remains; otherwise an error message the
   * recall tool can return to the agent.
   */
  consume(returnBytes: number): string | null {
    if (this.calls + 1 > this.maxCalls) {
      return `recall budget exhausted this turn (max ${this.maxCalls} calls). Proceed with the summary or split work into a new turn.`;
    }
    if (this.bytes + returnBytes > this.maxBytes) {
      return `recall byte budget exhausted this turn (max ${this.maxBytes} bytes; would push to ${this.bytes + returnBytes}). Recall a smaller slice or proceed with the summary.`;
    }
    this.calls += 1;
    this.bytes += returnBytes;
    return null;
  }

  snapshot(): { calls: number; bytes: number; maxCalls: number; maxBytes: number } {
    return {
      calls: this.calls,
      bytes: this.bytes,
      maxCalls: this.maxCalls,
      maxBytes: this.maxBytes,
    };
  }
}

export interface HarnessRunContext {
  sessionId: string;
  counter: ToolCallsCounter;
  /** Per-turn budget for recall_tool_result calls. Optional — when
   *  absent (e.g. tests, non-harness call paths), recall is unmetered. */
  recallBudget?: RecallBudget;
  /** Cap each tool's wall-clock execution to this. Overrides
   *  timeoutForTool(name) when set; otherwise the default per-name
   *  policy applies. */
  defaultTimeoutMs?: number;
  /** Loop-guard tracker key. When set (only for run_worker sub-agent
   *  runs, behind CLEMMY_WORKER_THRASH_GUARD), each worker's loop
   *  detection counts against its OWN window instead of the shared
   *  parent sessionId — so 44 parallel workers don't poison one tracker
   *  and trip the guard on the aggregate. sessionId is left UNCHANGED
   *  so kill/pause/approval/recall reads still resolve to the real
   *  session. Falls back to sessionId when absent (byte-identical). */
  guardrailScopeId?: string;
}

/** CLEMMY_WORKER_THRASH_GUARD: per-worker loop-guard isolation + bounded
 *  worker turns + structured per-item give-up. Default OFF — flip on after
 *  the synthetic-batch soak (the maxTurns floor needs empirical calibration
 *  before it's the default). Fail-open: a parse miss reads as off. */
export function workerThrashGuardEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_WORKER_THRASH_GUARD', 'off') ?? 'off').toLowerCase() === 'on';
}

let workerScopeSeq = 0;
function workerScopeIdFromDetails(sessionId: string, details: unknown): string {
  const call = (details as { toolCall?: { callId?: string; id?: string } } | undefined)?.toolCall;
  const callId = call?.callId ?? call?.id;
  return `${sessionId}::w:${callId ?? `n${(workerScopeSeq = (workerScopeSeq + 1) % 1_000_000)}`}`;
}

/** Per-turn context store. The loop wraps runner.run() in `run` so
 *  every tool invocation underneath can read the active counter +
 *  sessionId without explicit threading through SDK options. */
export const harnessRunContextStorage = new AsyncLocalStorage<HarnessRunContext>();

/** Sugar around AsyncLocalStorage.run for the loop call site. */
export function withHarnessRunContext<T>(
  ctx: HarnessRunContext,
  work: () => T | Promise<T>,
): T | Promise<T> {
  return harnessRunContextStorage.run(ctx, work);
}

/** Internal: minimum shape of an SDK `Tool` the wrapper needs to
 *  rewrite execute on. We keep this loose so we don't import the
 *  full SDK type union (Tool<RuntimeContextValue> | FunctionTool | …)
 *  and end up coupling brackets.ts to every variant. */
export interface WrappableTool {
  name: string;
  execute?: (input: unknown, runContext?: unknown) => Promise<unknown>;
}

export interface WrapToolOptions {
  /** Override the per-tool timeout. When omitted, timeoutForTool(name)
   *  picks one from DEFAULT_TIMEOUTS_MS. */
  timeoutMs?: number;
  /** Test injection — when set, use this clock instead of Date.now()
   *  for timeout testing. */
  now?: () => number;
}

/**
 * Wrap a tool so its execute fires the three reliability checks at the
 * entry edge. The wrap is gated behind `HARNESS_TOOL_BRACKETS=on` env
 * flag so we can ship + dogfood without flipping behavior until we're
 * sure nothing legitimate gets killed by a too-tight timeout.
 *
 * When the flag is off, returns the tool unchanged. When on, returns
 * a new object with a wrapped `execute`. The original tool is not
 * mutated — both can coexist if needed.
 *
 * Reading the run context via AsyncLocalStorage means tools called
 * OUTSIDE the harness (e.g. direct MCP invocations, test fixtures)
 * see ctx === undefined; in that case the wrapper degrades to "apply
 * timeout only, no kill check, no counter check" — safer than
 * crashing on a missing counter.
 */
export function wrapToolForHarness<T extends WrappableTool>(
  tool: T,
  options: WrapToolOptions = {},
): T {
  // Opt-in via HARNESS_TOOL_BRACKETS=on. As of v0.5.18 the flag
  // ACTUALLY WORKS in production (F1 supervisor injection + F8
  // wrap-via-invoke fix). Default stays OFF for this release because
  // a default-on flip surfaced test fallout (loop.test.ts:839) that
  // needs its own focused investigation. Tracked for v0.5.19.
  // Users who want the reliability brackets active set the env via
  // Settings → Runtime or directly in ~/.clementine-next/.env.
  if (process.env.HARNESS_TOOL_BRACKETS !== 'on') return tool;
  // CRITICAL: The OpenAI Agents SDK's `tool()` factory captures the
  // original `execute` in a CLOSURE inside the returned `invoke`
  // function (node_modules/@openai/agents-core/dist/tool.js:175).
  // The Runner calls `tool.invoke(runContext, input, details)` — NOT
  // `tool.execute`. So wrapping ONLY `execute` does nothing for SDK
  // tools: the Runner goes through invoke, which calls the closured
  // original execute. Discovered 2026-05-24 after weeks of brackets
  // appearing inactive even with HARNESS_TOOL_BRACKETS=on.
  //
  // We support TWO tool shapes:
  //   - SDK-built tools (have `.invoke`): wrap invoke. This is the
  //     production path — orchestrator + sub-agent tools all flow here.
  //   - Plain-object tools (have `.execute` only, no `.invoke`): wrap
  //     execute. This is the test/legacy path; brackets.test.ts builds
  //     tools as raw {name, execute} objects so we keep wrapping that
  //     shape too.
  const tt = tool as unknown as ToolWithInvoke;
  const hasInvoke = typeof tt.invoke === 'function';
  const hasExecute = typeof tool.execute === 'function';
  if (!hasInvoke && !hasExecute) return tool; // pure declaration; nothing to wrap

  const runBrackets = async (
    sessionId: string,
    parsedInput: unknown,
  ): Promise<void> => {
    const ctx = harnessRunContextStorage.getStore();
    if (!ctx) return; // no context = test fixture or out-of-band call; brackets degrade
    // 1. Kill check
    assertNotKilled(ctx.sessionId);
    // 2. Counter cap (pre-increment)
    if (ctx.counter.willExceed()) {
      throw new ToolCallsLimitExceeded(ctx.counter.limit);
    }
    ctx.counter.increment();
    // 2b. Tool-call guardrail (loop detection). Keyed by guardrailScopeId
    // when set (a worker run isolates its own window) else sessionId.
    try {
      const rawDecision = evaluateToolCall(ctx.guardrailScopeId ?? ctx.sessionId, tool.name, parsedInput);
      const decision = applyMode(rawDecision);
      if (decision.action !== 'allow') {
        try {
          appendEvent({
            sessionId: ctx.sessionId,
            turn: 0,
            role: 'system',
            type: 'guardrail_tripped',
            data: {
              kind: 'tool_call_guardrail',
              action: decision.action,
              rule: decision.rule,
              toolName: decision.toolName,
              count: decision.count,
              reason: decision.reason,
            },
          });
        } catch { /* telemetry write must never block */ }
      }
      // Terminal: an unrecoverable identical-args mutating loop. Thrown
      // before the block check so it wins at high counts. NOT a soft error —
      // it ends the turn (handleRunError → limit_exceeded) instead of
      // letting the model retry a call it cannot vary (the 84×/3-min hang).
      if (decision.action === 'escalate') {
        throw new ToolGuardrailEscalated(decision);
      }
      if (decision.action === 'block' || decision.action === 'halt') {
        throw new ToolGuardrailBlocked(decision);
      }
    } catch (err) {
      if (err instanceof ToolGuardrailBlocked) throw err;
      if (err instanceof ToolGuardrailEscalated) throw err;
      // eslint-disable-next-line no-console
      console.warn('[harness] tool guardrail evaluation threw (fail-open)', err instanceof Error ? err.message : err);
    }
    // 2c. Execution-wrap gate
    try {
      if (isExecutionGateEnabled() && isMutatingExternalWrite(tool.name, parsedInput)) {
        const sessionRow = getSession(ctx.sessionId);
        if (sessionRow?.kind === 'chat') {
          const { ExecutionStore } = await import('../../execution/store.js');
          const active = new ExecutionStore().getActiveForSession(ctx.sessionId);
          if (!active) {
            const slug = typeof parsedInput === 'object' && parsedInput
              ? (parsedInput as { tool_slug?: string }).tool_slug
              : undefined;
            try {
              appendEvent({
                sessionId: ctx.sessionId,
                turn: 0,
                role: 'system',
                type: 'guardrail_tripped',
                data: {
                  kind: 'execution_wrap_required',
                  toolName: tool.name,
                  toolSlug: slug ?? null,
                  reason: 'mutating external write without active execution',
                },
              });
            } catch { /* telemetry write must never block */ }
            throw new MissingExecutionWrapError({
              toolName: tool.name,
              toolSlug: slug,
              sessionId: ctx.sessionId,
            });
          }
        }
      }
    } catch (err) {
      if (err instanceof MissingExecutionWrapError) throw err;
      // eslint-disable-next-line no-console
      console.warn('[harness] execution-wrap gate threw (fail-open)', err instanceof Error ? err.message : err);
    }
    // 2d. Confirm-first gate — a BATCH of same-shape external writes
    // needs an instruction-reviewed plan scope before it proceeds. Runs
    // for chat sessions only and aggregates across workers (they share
    // ctx.sessionId via AsyncLocalStorage). Counts durable external_write
    // events the gate itself emits, so worker writes are counted even if
    // they don't log tool_called under the parent session.
    try {
      if (isConfirmFirstEnabled()) {
        const sessionRow = getSession(ctx.sessionId);
        if (sessionRow?.kind === 'chat') {
          const shape = classifyExternalWrite(tool.name, parsedInput);
          if (shape.mutating && shape.shapeKey) {
            // Count prior same-shape writes already allowed this session.
            let prior = 0;
            try {
              for (const ev of listEvents(ctx.sessionId, { types: ['external_write'] })) {
                const d = ev.data as { shapeKey?: string } | undefined;
                if (d?.shapeKey === shape.shapeKey) prior += 1;
              }
            } catch { /* count is best-effort; fail toward not-a-batch */ }

            const { loadProactivityPolicy } = await import('../../agents/proactivity-policy.js');
            const policy = loadProactivityPolicy();
            const threshold = policy.batchConfirmThreshold;
            const review = decideInstructionReview({ priorSameShapeCount: prior, threshold });

            // YOLO = the user has granted STANDING approval ("auto-approve
            // everything except the hard danger denylist"). The confirm-first
            // batch gate is an APPROVAL gate; in YOLO it is pure friction and
            // breaks the approve-once-then-run contract (live 2026-06-02: in
            // YOLO, after 4 sends the 5th tripped this gate and demanded a
            // plan the user had already approved). Skip the block in YOLO but
            // still RECORD the write below for batch-count continuity. The
            // escalate loop-guard + the hard danger denylist remain the floor.
            // The same yolo short-circuit lives in evaluateAutoApprove
            // (plan-scope.ts) — this gate had simply forgotten to ask.
            const yoloStandingApproval = policy.autoApproveScope === 'yolo';

            // An instruction-reviewed plan scope satisfies the gate.
            const { getPlanScope } = await import('../../agents/plan-scope.js');
            const scope = getPlanScope(ctx.sessionId);
            const hasReviewedScope = !!scope && !scope.closedAt;

            // SEVERITY GATE (2026-05-30): only genuinely IRREVERSIBLE
            // batches (SEND/PUBLISH — emails sent, posts published) must
            // wait for a reviewed plan scope. A reversible write
            // (GOOGLESHEETS_UPDATE/BATCH, a spreadsheet edit you can undo)
            // is NOT worth deadlocking a capable agent over — it kept the
            // confirm-first gate firing in chat sessions where nothing
            // opens a scope, wedging the agent with no reachable exit
            // (live: the 48-row Closed-Won sheet, email-analysis dropped).
            // The runaway-loop guard (2b) + the per-tool SDK approval are
            // the safety floor for reversible writes; this gate now only
            // adds friction where the blast radius is truly irreversible.
            // Philosophy: prevent irreversible mistakes, don't over-gate
            // reversible execution. Env escape hatch keeps the old
            // gate-everything behavior available if ever needed.
            const gateAllMutating =
              (getRuntimeEnv('CLEMMY_CONFIRM_FIRST_ALL_WRITES', 'off') ?? 'off').toLowerCase() === 'on';
            const severityRequiresGate = gateAllMutating || shape.irreversible;

            if (!yoloStandingApproval && review.required && severityRequiresGate && !hasReviewedScope) {
              try {
                appendEvent({
                  sessionId: ctx.sessionId,
                  turn: 0,
                  role: 'system',
                  type: 'guardrail_tripped',
                  data: {
                    kind: 'confirm_first_required',
                    toolName: tool.name,
                    shapeKey: shape.shapeKey,
                    count: review.count,
                    threshold,
                    irreversible: shape.irreversible,
                  },
                });
              } catch { /* telemetry write must never block */ }
              throw new ConfirmFirstRequiredError({
                toolName: tool.name,
                shapeKey: shape.shapeKey,
                count: review.count,
                threshold,
                sessionId: ctx.sessionId,
              });
            }

            // Allowed through — record the write so subsequent same-shape
            // calls (including worker fan-out) count toward the batch.
            try {
              appendEvent({
                sessionId: ctx.sessionId,
                turn: 0,
                role: 'system',
                type: 'external_write',
                data: {
                  shapeKey: shape.shapeKey,
                  toolName: tool.name,
                  irreversible: shape.irreversible,
                  count: review.count,
                  underScope: hasReviewedScope,
                },
              });
            } catch { /* telemetry write must never block */ }
          }
        }
      }
    } catch (err) {
      if (err instanceof ConfirmFirstRequiredError) throw err;
      // eslint-disable-next-line no-console
      console.warn('[harness] confirm-first gate threw (fail-open)', err instanceof Error ? err.message : err);
    }
    // (sessionId arg is unused — included for future per-session
    // behavior without forcing callers to refactor.)
    void sessionId;
  };

  // Resolve the per-tool timeout once at wrap time.
  const timeoutMs = options.timeoutMs ?? timeoutForTool(tool.name);
  const isPausedFactory = (sessionId?: string) =>
    sessionId
      ? () => {
          try {
            const pending = listPendingApprovals({ sessionId, status: 'pending' });
            return pending.length > 0;
          } catch {
            return false;
          }
        }
      : undefined;

  if (hasInvoke) {
    // PRODUCTION PATH — wrap SDK invoke.
    const originalInvoke = tt.invoke!;
    const wrappedInvoke = async (
      runContext: unknown,
      input: unknown,
      details?: unknown,
    ): Promise<unknown> => {
      // SDK passes raw JSON string to invoke. Parse for our internal
      // classification (gate + guardrail). Fail-open on parse error.
      let parsedInput: unknown = input;
      if (typeof input === 'string') {
        try {
          parsedInput = JSON.parse(input);
        } catch {
          parsedInput = input;
        }
      }
      const ctx = harnessRunContextStorage.getStore();
      try {
        await runBrackets(ctx?.sessionId ?? '', parsedInput);
      } catch (err) {
        // MissingExecutionWrapError should land as a SOFT tool error
        // — return the message string so the model sees it as the
        // tool's output and can self-correct (call execution_create,
        // then retry). Throwing here would terminate the run because
        // our wrap is OUTSIDE the SDK's _invoke catch (which would
        // have converted the throw via defaultToolErrorFunction).
        // Same treatment for ToolGuardrailBlocked + the counter
        // ToolCallsLimitExceeded so the model can recover instead of
        // the harness exploding on a guardrail decision.
        if (
          err instanceof MissingExecutionWrapError ||
          err instanceof ConfirmFirstRequiredError ||
          err instanceof ToolGuardrailBlocked ||
          err instanceof ToolCallsLimitExceeded
        ) {
          return `Tool call refused by harness: ${err instanceof Error ? err.message : String(err)}`;
        }
        // ToolGuardrailEscalated is NOT a soft error — it propagates so the
        // turn ends (the model is stuck and can't recover by retrying).
        // KillRequested + ToolTimeout + unknown errors propagate —
        // these SHOULD abort the run (kill is user-requested abort;
        // timeout means the underlying tool is genuinely stuck).
        throw err;
      }
      const invokeOnce = () => withTimeout(
        (async () => originalInvoke.call(tt, runContext, input, details))(),
        timeoutMs,
        tool.name,
        { isPaused: isPausedFactory(ctx?.sessionId) },
      );
      // run_worker: isolate the worker's loop-guard window so 44 parallel
      // workers don't poison the one shared tracker (the cross-worker
      // exact_args_repeat/same_mut_tool_repeat aggregate that cancelled the
      // 44-attorney batch). sessionId is unchanged (kill/pause/recall intact);
      // the counter stays shared (batch budget). Behind CLEMMY_WORKER_THRASH_GUARD.
      const invokePromise =
        tool.name === 'run_worker' && ctx && workerThrashGuardEnabled()
          ? (harnessRunContextStorage.run(
              { ...ctx, guardrailScopeId: workerScopeIdFromDetails(ctx.sessionId, details) },
              invokeOnce,
            ) as Promise<unknown>)
          : invokeOnce();
      // run_worker (Agent.asTool fan-out leaf) MUST return something into the
      // orchestrator's context even on timeout. withTimeout sits OUTSIDE the
      // try/catch above, so a ToolTimeout here propagates straight out of
      // wrappedInvoke → the SDK's agent_tool_end never fires → no tool_returned
      // event is logged → the orchestrator is blind to a worker that ran for
      // minutes then timed out (can't tell "timed out mid-item" from "never
      // ran"). Convert the worker timeout to a string result so agent_tool_end
      // fires normally and the parent can mark the item failed and continue.
      // Other tools keep PROPAGATING ToolTimeout — the loop surfaces an
      // ask-user Retry card for those (loop.ts), which we don't want to change.
      if (tool.name === 'run_worker') {
        try {
          const result = await invokePromise;
          // FIX 1.3 — normalize the worker's output into a deterministic
          // ERROR:/PARTIAL:/verbatim envelope so the orchestrator can tell
          // done from failed in CODE. Covers BOTH the success text AND the
          // SDK's generic "An error occurred…" string (the soft-converted
          // MaxTurnsExceeded / internal-error path the customOutputExtractor
          // never sees, because a throw skips it). Behind the flag.
          return workerThrashGuardEnabled() ? normalizeWorkerOutput(result) : result;
        } catch (err) {
          if (err instanceof ToolTimeout) {
            return (
              `ERROR: run_worker timed out after ${Math.round(timeoutMs / 1000)}s — this item did NOT complete. `
              + `Treat it as failed: do not assume it succeeded. Continue with the other items and report this one as needs-attention.`
            );
          }
          throw err;
        }
      }
      return invokePromise;
    };
    return { ...tool, invoke: wrappedInvoke } as T;
  }

  // LEGACY PATH — plain-object tool with execute only (tests, fixtures).
  const originalExecute = tool.execute!;
  const wrappedExecute = async (input: unknown, runContext?: unknown): Promise<unknown> => {
    const ctx = harnessRunContextStorage.getStore();
    await runBrackets(ctx?.sessionId ?? '', input);
    return withTimeout(
      (async () => originalExecute(input, runContext))(),
      timeoutMs,
      tool.name,
      { isPaused: isPausedFactory(ctx?.sessionId) },
    );
    // NOTE: A tool-return truncator used to live here as part of
    // Primitive 6 (v0.5.18 plan). Removed 2026-05-24 because hooks.ts
    // `clipToolResult` + `writeToolOutput` + `clipOldToolResults`
    // already cover (a) per-write inline trim with recall_tool_result
    // marker, (b) lossless 200K side store, (c) compaction-driven
    // history trim. Adding a fourth layer was redundant. The
    // loop-detection half of Primitive 6 (evaluateToolCall above)
    // stays — it's novel, not duplicative.
  };
  return { ...tool, execute: wrappedExecute };
}

/** Minimal shape for the SDK-built Tool with an invoke method.
 *  Used internally to type-narrow tool objects from @openai/agents. */
interface ToolWithInvoke {
  name: string;
  invoke?: (runContext: unknown, input: unknown, details?: unknown) => Promise<unknown>;
}

/** Thrown when the tool-call guardrail blocks a tool call. The SDK
 *  surfaces this as a tool error; the agent sees the failure and
 *  can recover. The decision object lets the harness route a clean
 *  telemetry event without re-deriving the reason. */
export class ToolGuardrailBlocked extends Error {
  public readonly decision: import('./tool-guardrail.js').GuardrailDecision;
  constructor(decision: import('./tool-guardrail.js').GuardrailDecision) {
    super(`tool-call guardrail ${decision.action}: ${decision.reason}`);
    this.name = 'ToolGuardrailBlocked';
    this.decision = decision;
  }
}

/**
 * Terminal guardrail stop. Unlike ToolGuardrailBlocked (a SOFT, retryable
 * tool error), this is thrown when a MUTATING tool is called with
 * byte-identical args past the escalate threshold — the model is provably
 * stuck and cannot recover by retrying (e.g. a schema it can't satisfy, an
 * input it can't supply). It is NOT converted to a soft error string; it
 * propagates so the harness loop ends the turn (handleRunError →
 * limit_exceeded). This is the fix for the 84×/3-min workflow_run hang that
 * a soft block could not stop.
 */
export class ToolGuardrailEscalated extends Error {
  public readonly decision: import('./tool-guardrail.js').GuardrailDecision;
  constructor(decision: import('./tool-guardrail.js').GuardrailDecision) {
    super(`tool-call guardrail escalated: ${decision.reason}`);
    this.name = 'ToolGuardrailEscalated';
    this.decision = decision;
  }
}
