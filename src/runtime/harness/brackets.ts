import { isKillRequested } from './eventlog.js';

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
 */
export function withTimeout<T>(work: Promise<T>, ms: number, toolName: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ToolTimeout(toolName, ms)), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err: unknown) => {
        clearTimeout(timer);
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
  orchestrator: 12,
  session: 60,
});

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

/** Default token budget. 200k input / 80k output mirrors the plan. */
export const DEFAULT_TOKEN_BUDGET: Readonly<TokenBudgetCounts> = Object.freeze({
  inputTokens: 200_000,
  outputTokens: 80_000,
});
