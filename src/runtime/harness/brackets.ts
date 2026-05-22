import { AsyncLocalStorage } from 'node:async_hooks';
import { isKillRequested } from './eventlog.js';
import { getHarnessBudgetSettings } from './budget-settings.js';
import { listPending as listPendingApprovals } from './approval-registry.js';

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

/** Recommended per-tool timeouts. Caller can override per-tool. */
export const DEFAULT_TIMEOUTS_MS = {
  default: 60_000,
  shell: 600_000,
  mcp: 30_000,
} as const;

/** Pick a default timeout from the tool name. */
export function timeoutForTool(toolName: string): number {
  if (toolName === 'run_shell_command') return DEFAULT_TIMEOUTS_MS.shell;
  if (/^(exec|spawn|launch|run_shell|shell_)/.test(toolName)) {
    return DEFAULT_TIMEOUTS_MS.shell;
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

export interface HarnessRunContext {
  sessionId: string;
  counter: ToolCallsCounter;
  /** Cap each tool's wall-clock execution to this. Overrides
   *  timeoutForTool(name) when set; otherwise the default per-name
   *  policy applies. */
  defaultTimeoutMs?: number;
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
  if (process.env.HARNESS_TOOL_BRACKETS !== 'on') return tool;
  const originalExecute = tool.execute;
  if (!originalExecute) return tool; // pure declaration; no execute to wrap
  const wrappedExecute = async (input: unknown, runContext?: unknown): Promise<unknown> => {
    const ctx = harnessRunContextStorage.getStore();
    if (ctx) {
      // 1. Kill check — sync throw. The SDK records this tool call as
      //    errored and the run halts cleanly. Without this, a long
      //    tool (10-min DataForSEO scrape) ignores `clementine kill`
      //    until it returns.
      assertNotKilled(ctx.sessionId);
      // 2. Counter cap — pre-increment check. If we're at the limit,
      //    throw BEFORE the inner execute runs so no side effects
      //    happen. The increment moves AFTER willExceed so a thrown
      //    check doesn't bump the count.
      if (ctx.counter.willExceed()) {
        throw new ToolCallsLimitExceeded(ctx.counter.limit);
      }
      ctx.counter.increment();
    }
    // 3. Per-tool timeout. The withTimeout helper races a setTimeout
    //    against the tool promise; on expiry it throws ToolTimeout
    //    (the inner work continues unaborted — tools wire their own
    //    AbortSignal if they want to cancel cleanly).
    //
    // Approval-aware (v0.5.5): when the SDK pauses this tool waiting
    // on user approval, the timer was ALREADY started — left to its
    // own devices it would throw ToolTimeout 60 seconds in even though
    // the tool is parked. The isPaused callback consults the approval
    // registry at fire time. If a pending approval exists for this
    // session, the timeout defers (re-arms) instead of throwing.
    const timeoutMs = options.timeoutMs
      ?? ctx?.defaultTimeoutMs
      ?? timeoutForTool(tool.name);
    const sessionId = ctx?.sessionId;
    const isPaused = sessionId
      ? () => {
          try {
            const pending = listPendingApprovals({ sessionId, status: 'pending' });
            return pending.length > 0;
          } catch {
            // If the registry is unavailable, fall back to old behavior
            // (don't defer) so timeouts still fire for genuinely stuck
            // tools — better to err on the side of dropping the run than
            // hanging forever.
            return false;
          }
        }
      : undefined;
    return withTimeout(
      (async () => originalExecute(input, runContext))(),
      timeoutMs,
      tool.name,
      { isPaused },
    );
  };
  return { ...tool, execute: wrappedExecute };
}
