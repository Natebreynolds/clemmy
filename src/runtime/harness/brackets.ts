import { AsyncLocalStorage } from 'node:async_hooks';
import { isKillRequested, appendEvent, getSession, listEvents, getToolOutput } from './eventlog.js';
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
import {
  isGroundingGateEnabled,
  extractDuplicateIdentityKeys,
  evaluateGrounding,
  detectDuplicateTarget,
  markDuplicateWarned,
  GroundingCheckFailedError,
  DuplicateExternalWriteError,
} from './grounding-gate.js';
import {
  isGoalFidelityGateEnabled,
  evaluateGoalFidelity,
  GoalFidelityCheckFailedError,
} from './goal-fidelity-gate.js';
import {
  isDestinationGateEnabled,
  evaluateShellDestination,
  evaluateDestinationProvenance,
  extractExplicitPublishTargets,
  destinationIdentityForms,
  wasDestinationNudged,
  markDestinationNudged,
  ImplicitDestinationError,
  UnverifiedDestinationError,
  classifyShellNetworkMutation,
  classifyShellCommand,
} from './destination-gate.js';
import { establishedTargetsFor, recordPublishedDestination } from './published-destinations.js';
import { creditMatchingRecall } from '../../memory/procedural-recall-link.js';

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
 *  worker turns + structured per-item give-up. Default ON (validated live
 *  2026-06-02: 8-worker fan-out, 0 cap-hits at maxTurns=8, 0 thrash, honest
 *  per-item ERROR reporting). `=off` is the emergency kill-switch. */
export function workerThrashGuardEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_WORKER_THRASH_GUARD', 'on') ?? 'on').toLowerCase() !== 'off';
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

// Tool reliability brackets — per-tool wall-clock timeout + identical-args
// loop-guard (soft block@5 through 11, terminal escalate@12) + counter cap. DEFAULT-ON (2026-06-07): the
// 24/7 audit proved these are the live wedge — a hung external tool had no
// timeout and a runaway reached 77-81x identical calls because this block was
// off by default. Timeouts are generous (mcp/shell 10min, externalApi 5min;
// timeoutForTool) so a legitimate long tool isn't killed, and reads/polls are
// demoted to warn so only identical-args MUTATING loops hard-stop. Kill-switch:
// HARNESS_TOOL_BRACKETS=off. Read via getRuntimeEnv so the .env value applies
// under launchd too (where process.env isn't merged).
export function harnessToolBracketsEnabled(): boolean {
  return (getRuntimeEnv('HARNESS_TOOL_BRACKETS', 'on') ?? 'on').toLowerCase() !== 'off';
}

function stripAnsi(input: string): string {
  return input.replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '');
}

function eventFieldText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value == null) return '';
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function joinedEventText(...values: unknown[]): string {
  return values.map(eventFieldText).filter(Boolean).join('\n');
}

function publishCreateSucceeded(resultText: string): boolean {
  const text = resultText.toLowerCase();
  if (/exit_code:\s*[1-9]\d*/.test(text)) return false;
  if (/\b(error|jsonhttperror|unknown option|not found|no such team)\b/.test(text)) return false;
  return /exit_code:\s*0/.test(text)
    || /\b(project|site)\s+created\b/i.test(resultText)
    || /"(?:id|site_id)"\s*:\s*"/i.test(resultText)
    || /\.netlify\.app\b/i.test(resultText);
}

/**
 * Wrap a tool so its execute fires the three reliability checks at the
 * entry edge. Gated by HARNESS_TOOL_BRACKETS (default ON; =off kill-switch).
 *
 * When disabled, returns the tool unchanged. When on, returns a new object
 * with a wrapped `execute`/`invoke`. The original tool is not mutated.
 *
 * Reading the run context via AsyncLocalStorage means tools called OUTSIDE the
 * harness (direct MCP invocations, test fixtures) see ctx === undefined; in
 * that case the wrapper degrades to "apply timeout only, no kill/counter
 * check" — safer than crashing on a missing counter.
 */

/**
 * Build the publish-PROVENANCE predicate for the destination gate (2026-06-15
 * clobber). A target is "provenanced" if it was CREATED in this session (a
 * `sites:create`/`projects:create` — the intended --name slug, plus the new
 * site's id/name/url from that call's SUCCESS result, correlated by callId) OR
 * the user NAMED it in a message this session. Deliberately does NOT mine
 * arbitrary tool results (e.g. `netlify status`) for ids — that output is the
 * stale-link LEAK that caused the clobber, so it must not confer provenance.
 * Fail-open: any error yields an empty predicate, which only makes the gate
 * stricter (never crashes a tool call).
 */
function buildPublishProvenance(sessionId: string, projectKey?: string): (target: string) => boolean {
  const created = new Set<string>();
  let userBlob = '';
  // Part 2 (2026-06-21): destinations THIS project has successfully published to
  // before — durable, cross-session, project-keyed. A target the project has
  // deliberately deployed to is not an "unrelated live site". Keyed by project
  // so it can never confer provenance across unrelated projects (no clobber).
  const established = establishedTargetsFor(projectKey);
  try {
    const events = listEvents(sessionId, { types: ['user_input_received', 'tool_called', 'tool_returned'] });
    const createCallNames = new Map<string, string[]>();
    const userParts: string[] = [];
    for (const e of events) {
      const d = e.data as Record<string, unknown> | undefined;
      if (e.type === 'user_input_received') {
        userParts.push(String(d?.text ?? '').toLowerCase());
      } else if (e.type === 'tool_called') {
        const args = joinedEventText(d?.arguments, d?.args, d?.rawArgs);
        // Recognize ANY site-creation path, not just one command:
        // `netlify sites:create`, the API `netlify api createSite`,
        // `create-site`. (2026-06-15 Fernwood false-positive: she self-recovered
        // into `api createSite` and the gate then blocked the deploy to her OWN
        // freshly-created site because it only matched `sites:create`.) Name is
        // captured from `--name X` OR a `--data '{"name":"X"}'` JSON body.
        if (/sites?:create|projects?:create|create-?sites?\b/i.test(args)) {
          const callId = String(d?.callId ?? '');
          const names: string[] = [];
          const nm = args.match(/--name(?:=|\s+)["']?([\w.-]+)/i) ?? args.match(/"name"\s*:\s*"([\w.-]+)"/i);
          if (nm) names.push(nm[1].toLowerCase());
          if (callId) createCallNames.set(callId, names);
        }
      } else if (e.type === 'tool_returned') {
        const callId = String(d?.callId ?? '');
        const names = createCallNames.get(callId);
        if (names) {
          const res = stripAnsi(joinedEventText(d?.result, d?.preview, d?.output));
          if (!publishCreateSucceeded(res)) continue;
          for (const name of names) created.add(name);
          for (const m of res.matchAll(/"(?:id|site_id|name|site_name)"\s*:\s*"([\w.-]+)"/gi)) created.add(m[1].toLowerCase());
          for (const m of res.matchAll(/\b(?:project|site)\s+id\s*:\s*([A-Za-z0-9][\w.-]*)/gi)) created.add(m[1].toLowerCase());
          for (const m of res.matchAll(/([\w-]+)\.netlify\.app/gi)) created.add(m[1].toLowerCase());
        }
      }
    }
    userBlob = userParts.join(' \n ');
  } catch { /* fail-open: empty provenance = stricter gate, never a crash */ }
  return (target: string) => {
    // Identity-aware (Defect A): a site created as `foo` IS `foo.netlify.app` —
    // match on the structural forms (host + first DNS label) via EXACT set
    // membership against the created/established provenance.
    const forms = destinationIdentityForms(target);
    if (forms.length === 0) return false;
    if (forms.some((f) => created.has(f) || established.has(f))) return true;
    // The user explicitly named this site in a message this session. Match the
    // FULL host/target form only (forms[0]) — NOT the bare DNS label: a label
    // like "blog"/"docs"/"shop" is too common to confer provenance on a
    // coincidental substring mention ("write a blog post"), which would widen
    // the clobber gate. The full host is specific enough to be a real mention.
    const fullForm = forms[0];
    if (fullForm.length >= 4 && userBlob.includes(fullForm)) return true;
    return false;
  };
}

/** Duplicate-ledger compensation: the external_write event is recorded
 *  PRE-dispatch (conservative — a crash mid-send must still count), but a
 *  dispatch that demonstrably FAILED never wrote anything. Without this, a
 *  schema-rejected send counts as a prior write and the model's corrected
 *  retry trips DUPLICATE_EXTERNAL_WRITE (live false positive, audit
 *  2026-06-12: `to` vs `to_email`). Only the explicit hard-failure shape
 *  compensates; anything ambiguous stays counted (the safe direction). */
function compensateFailedExternalWrite(
  sessionId: string | undefined,
  toolName: string,
  parsedInput: unknown,
  result: unknown,
): void {
  if (!sessionId) return;
  try {
    const resultStr = typeof result === 'string' ? result : '';
    // Composio hard-failure (the 2026-06-12 to/to_email case).
    if (resultStr.startsWith('⚠️ composio_execute_tool FAILED')) {
      const shape = classifyExternalWrite(toolName, parsedInput);
      if (!shape.mutating) return;
      appendEvent({
        sessionId,
        turn: 0,
        role: 'system',
        type: 'external_write_failed',
        data: {
          shapeKey: shape.shapeKey,
          toolName,
          targets: extractDuplicateIdentityKeys(parsedInput).slice(0, 8),
        },
      });
      return;
    }
    // Shell network-mutation failure (review 2026-06-14): the 2c4 gate records a
    // shell send's external_write PRE-dispatch (shapeKey shell:<bin>); if the
    // command then FAILS (non-zero exit / ERROR stub), compensate so the model's
    // retry isn't a false DUPLICATE_EXTERNAL_WRITE. Mirrors the composio path,
    // using the same shell classifier + shapeKey the 2c4 gate emitted.
    if (toolName === 'run_shell_command') {
      const command = typeof (parsedInput as { command?: unknown })?.command === 'string'
        ? (parsedInput as { command: string }).command
        : '';
      if (!command) return;
      const mutation = classifyShellNetworkMutation(command);
      // computer-tools renders `exit_code: <code>`; non-zero = failure. Also
      // catch the run_worker-style ERROR: stub. exit_code: 0 → success, no comp.
      const failed = /(?:^|\s)exit_code:\s*[1-9]/.test(resultStr) || /^ERROR:/.test(resultStr);
      if (mutation.isNetworkMutation && mutation.shapeKey && failed) {
        appendEvent({
          sessionId,
          turn: 0,
          role: 'system',
          type: 'external_write_failed',
          data: {
            shapeKey: mutation.shapeKey,
            toolName,
            targets: extractDuplicateIdentityKeys(command).slice(0, 8),
          },
        });
      }
    }
  } catch { /* compensation must never break the tool result */ }
}

/**
 * After a `run_shell_command` returns, if it was a PUBLISH to an explicit target
 * that demonstrably SUCCEEDED, record (project → destination) durably (Part 2,
 * 2026-06-21). projectKey = the command's cwd, so a future redeploy of THIS
 * project to the SAME site is provenanced cross-session — turning a one-time
 * success into learned, reusable knowledge (the ever-learning fix for the
 * "deploy blocked because it's a new session" recurrence). Only fires on a clear
 * success; best-effort (never perturbs the tool result).
 */
function recordPublishIfSucceeded(toolName: string, parsedInput: unknown, result: unknown): void {
  try {
    if (toolName !== 'run_shell_command') return;
    const command = typeof (parsedInput as { command?: unknown })?.command === 'string'
      ? (parsedInput as { command: string }).command : '';
    if (!command || !classifyShellCommand(command).isPublish) return;
    const targets = extractExplicitPublishTargets(command);
    if (targets.length === 0) return;
    if (!publishCreateSucceeded(stripAnsi(typeof result === 'string' ? result : ''))) return;
    const projectKey = typeof (parsedInput as { cwd?: unknown })?.cwd === 'string'
      ? (parsedInput as { cwd: string }).cwd : undefined;
    recordPublishedDestination(projectKey, targets);
  } catch { /* learning is best-effort — never break the tool result */ }
}

/**
 * Per-recalled-intent outcome correlation (2026-06-21 keystone): if the agent
 * recalled a CLI/MCP proven path and THIS tool result is the matching use of it,
 * credit that specific intent's outcome — closing the measured 0% CLI/MCP
 * outcome-coverage gap, precisely (per-operation, not per-binary). Haystack is
 * the shell command (so `netlify deploy …` matches a `netlify` recall) or the
 * tool name (so an MCP tool result matches its own recalled identifier).
 * Composio is skipped upstream (noteRecalledIntent ignores it). Best-effort.
 */
function creditRecallFromToolResult(sessionId: string | undefined, toolName: string, parsedInput: unknown, result: unknown): void {
  try {
    if (!sessionId) return;
    const command = typeof (parsedInput as { command?: unknown })?.command === 'string'
      ? (parsedInput as { command: string }).command : '';
    const haystack = toolName === 'run_shell_command' ? command : toolName;
    if (!haystack) return;
    const resultStr = typeof result === 'string' ? result : '';
    // Failure shapes the harness already recognizes (computer-tools exit_code,
    // run_worker ERROR stub, composio FAILED banner); otherwise treat as success.
    const failed = /(?:^|\s)exit_code:\s*[1-9]/.test(resultStr)
      || /^ERROR:/.test(resultStr)
      || resultStr.startsWith('⚠️ composio_execute_tool FAILED');
    creditMatchingRecall(sessionId, haystack, !failed);
  } catch { /* learning is best-effort — never break the tool result */ }
}

export function wrapToolForHarness<T extends WrappableTool>(
  tool: T,
  options: WrapToolOptions = {},
): T {
  if (!harnessToolBracketsEnabled()) return tool;
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

  // Returns an advisory fan-out nudge string when the guardrail detects
  // serial per-item batch work (same composio slug, N distinct args). The
  // caller APPENDS it to the tool's result so the model reads it mid-stride —
  // a warn-mode telemetry event alone is invisible to the model (live
  // 2026-06-11: 74 serial composio calls, 8 warn events, zero course-change).
  const runBrackets = async (
    sessionId: string,
    parsedInput: unknown,
    callId?: string,
  ): Promise<string | undefined> => {
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
    let fanoutNudge: string | undefined;
    let cacheNudge: string | undefined;
    try {
      const rawDecision = evaluateToolCall(ctx.guardrailScopeId ?? ctx.sessionId, tool.name, parsedInput, callId);
      const decision = applyMode(rawDecision);
      // Fan-out nudge: only steer the ORCHESTRATOR's own context toward
      // run_worker — inside a worker scope (guardrailScopeId set) the nudge
      // is wrong advice (workers can't spawn workers), so suppress it.
      if (decision.fanoutNudge && !ctx.guardrailScopeId) {
        fanoutNudge = decision.fanoutNudge;
        try {
          appendEvent({
            sessionId: ctx.sessionId,
            turn: 0,
            role: 'system',
            type: 'guardrail_tripped',
            data: {
              kind: 'fanout_nudge',
              toolName: decision.toolName,
              count: decision.count,
              reason: decision.fanoutNudge,
            },
          });
        } catch { /* telemetry write must never block */ }
      }
      // Within-task fetch-memory nudge (FIX 2). Only in the ORCHESTRATOR scope
      // (guardrailScopeId unset) — there the guardrail tracker and tool_outputs
      // share the real sessionId keying, so the prior call_id is reachable; in a
      // worker scope they diverge, so suppress. Also suppress when the prior
      // output was error-shaped: a retry after a transient failure must NOT be
      // discouraged. Nudge points at recall_tool_result; never serves a payload.
      if (decision.cachedCallId && !ctx.guardrailScopeId) {
        let priorOutput: string | null = null;
        try {
          priorOutput = getToolOutput(ctx.sessionId, decision.cachedCallId)?.output ?? null;
        } catch { priorOutput = null; }
        const errorShaped = priorOutput != null && /^\s*ERROR:/i.test(priorOutput);
        if (priorOutput != null && !errorShaped) {
          const ageS = Math.round((decision.cachedAgeMs ?? 0) / 1000);
          cacheNudge =
            `[within-task memory] You already ran ${decision.toolName} with these EXACT arguments ${ageS}s ago — `
            + `that result is still in your tool memory. Call recall_tool_result with call_id "${decision.cachedCallId}" `
            + `to re-read it instead of re-fetching, then take the next step. Do NOT repeat this read.`;
          try {
            appendEvent({
              sessionId: ctx.sessionId,
              turn: 0,
              role: 'system',
              type: 'guardrail_tripped',
              data: {
                kind: 'within_task_recall_nudge',
                toolName: decision.toolName,
                count: decision.count,
                cachedCallId: decision.cachedCallId,
                cachedAgeMs: decision.cachedAgeMs ?? 0,
              },
            });
          } catch { /* telemetry write must never block */ }
        }
      }
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
    // 2c2. Grounding + duplicate-target gates (integrity at the
    // irreversible-write boundary — the 2026-06-11 Eley incident class).
    // Runs for IRREVERSIBLE shapes only (SEND/PUBLISH). Both fail open on
    // any evaluation error; both surface as SOFT tool errors the model
    // recovers from. Ordered BEFORE confirm-first so a corrupted or
    // duplicate payload is fixed before approval machinery engages, and
    // so the external_write event for THIS call (emitted by confirm-first
    // on allow) can never count against itself.
    try {
      if (isGroundingGateEnabled()) {
        const shape = classifyExternalWrite(tool.name, parsedInput);
        if (shape.mutating && shape.irreversible) {
          const dupTargets = extractDuplicateIdentityKeys(parsedInput);
          // Duplicate-target speed bump: one same-shape write per target
          // per session unless consciously confirmed (second attempt
          // passes). Approval of a batch is not idempotency.
          let priorWrites: Array<{ shapeKey?: string; targets?: string[] }> = [];
          try {
            priorWrites = listEvents(ctx.sessionId, { types: ['external_write'] })
              .map((ev) => ev.data as { shapeKey?: string; targets?: string[] });
            // Net out demonstrably-failed dispatches (external_write_failed
            // compensation events, emitted post-invoke): each failure cancels
            // ONE matching prior, so a corrected retry after a schema
            // rejection is not a "duplicate" of a send that never happened.
            const failures = listEvents(ctx.sessionId, { types: ['external_write_failed'] })
              .map((ev) => ev.data as { shapeKey?: string; targets?: string[] });
            for (const failure of failures) {
              const failTargets = new Set((failure.targets ?? []).map((t) => String(t).toLowerCase()));
              const idx = priorWrites.findIndex((w) =>
                w.shapeKey === failure.shapeKey &&
                (w.targets ?? []).some((t) => failTargets.has(String(t).toLowerCase())));
              if (idx >= 0) priorWrites.splice(idx, 1);
            }
          } catch { /* fail toward not-a-duplicate */ }
          const dup = detectDuplicateTarget({ sessionId: ctx.sessionId, shapeKey: shape.shapeKey, targets: dupTargets, priorWrites });
          if (dup.duplicate && dup.warnedKey) {
            markDuplicateWarned(dup.warnedKey);
            try {
              appendEvent({
                sessionId: ctx.sessionId,
                turn: 0,
                role: 'system',
                type: 'guardrail_tripped',
                data: { kind: 'duplicate_external_write', toolName: tool.name, shapeKey: shape.shapeKey ?? null, target: dup.target ?? null },
              });
            } catch { /* telemetry write must never block */ }
            throw new DuplicateExternalWriteError({ toolName: tool.name, shapeKey: shape.shapeKey, target: dup.target ?? 'unknown' });
          }
          // Grounding: verify the payload against this target's own
          // session artifacts via an independent fast judge.
          const verdictResult = await evaluateGrounding(ctx.sessionId, tool.name, parsedInput);
          if (verdictResult.action === 'block') {
            try {
              appendEvent({
                sessionId: ctx.sessionId,
                turn: 0,
                role: 'system',
                type: 'guardrail_tripped',
                data: {
                  kind: 'grounding_blocked',
                  toolName: tool.name,
                  targets: verdictResult.targets.slice(0, 5),
                  sources: verdictResult.sourceCallIds.slice(0, 5),
                  reason: verdictResult.reason,
                  failureCount: verdictResult.failureCount ?? 1,
                },
              });
            } catch { /* telemetry write must never block */ }
            throw new GroundingCheckFailedError({
              toolName: tool.name,
              reason: verdictResult.reason,
              targets: verdictResult.targets,
              sourceCallIds: verdictResult.sourceCallIds,
              failureCount: verdictResult.failureCount ?? 1,
            });
          }
        }
      }
    } catch (err) {
      if (err instanceof GroundingCheckFailedError || err instanceof DuplicateExternalWriteError) throw err;
      // eslint-disable-next-line no-console
      console.warn('[harness] grounding gate threw (fail-open)', err instanceof Error ? err.message : err);
    }
    // 2c2.5. Goal-fidelity gate — does this irreversible write advance the
    // run's stated GOAL and honor the loaded SKILL's defining requirement?
    // Sibling to grounding (payload-vs-source); this is payload-vs-GOAL+SKILL.
    // Deterministic pre-filter first (skill renderer ran? batch uniform?),
    // then one fast fail-open judge ONLY when there's a goal AND a loaded
    // skill. Soft-blocks + reroutes BEFORE the write. Same irreversible-only
    // scope as grounding. Fail-open on any evaluation error.
    try {
      if (isGoalFidelityGateEnabled()) {
        const shape = classifyExternalWrite(tool.name, parsedInput);
        if (shape.mutating && shape.irreversible) {
          const verdict = await evaluateGoalFidelity(ctx.sessionId, tool.name, parsedInput);
          if (verdict.action === 'block') {
            try {
              appendEvent({
                sessionId: ctx.sessionId,
                turn: 0,
                role: 'system',
                type: 'guardrail_tripped',
                data: {
                  kind: 'goal_fidelity_blocked',
                  toolName: tool.name,
                  mode: verdict.mode,
                  skill: verdict.skill ?? null,
                  targets: verdict.targets.slice(0, 5),
                  reason: verdict.reason,
                  failureCount: verdict.failureCount ?? 1,
                  blockKind: verdict.blockKind ?? 'other',
                },
              });
            } catch { /* telemetry write must never block */ }
            throw new GoalFidelityCheckFailedError({
              toolName: tool.name,
              reason: verdict.reason,
              gap: verdict.gap,
              targets: verdict.targets,
              failureCount: verdict.failureCount ?? 1,
              blockKind: verdict.blockKind,
            });
          }
        }
      }
    } catch (err) {
      if (err instanceof GoalFidelityCheckFailedError) throw err;
      // eslint-disable-next-line no-console
      console.warn('[harness] goal-fidelity gate threw (fail-open)', err instanceof Error ? err.message : err);
    }
    // 2c3. Destination gate — AMBIENT-TARGET writes (the 2026-06-13
    // wrong-site incident class). `run_shell_command` bypasses every gate
    // above (isMutatingExternalWrite only classifies composio writes), so
    // an irreversible publish (deploy/publish/release) whose destination
    // lives in cwd state — not its args — can clobber an unrelated live
    // target. This is the FIRST gate to classify shell writes. One-shot +
    // recoverable: the first ambient-target publish of a given shape
    // soft-blocks (model makes the target explicit OR confirms the link);
    // a conscious retry passes. Fail-open on any error.
    try {
      if (isDestinationGateEnabled() && tool.name === 'run_shell_command') {
        const command = typeof (parsedInput as { command?: unknown })?.command === 'string'
          ? (parsedInput as { command: string }).command
          : '';
        if (command) {
          // PROVENANCE (2026-06-15 clobber): a publish to an EXPLICIT target that
          // was NOT created or named THIS session may be an unrelated live site
          // (a coffee-shop build deployed onto a law-firm site via a site id
          // reused from `netlify status` after `sites:create` failed). Hard-block.
          // Chat only, so recurring workflows reusing a stable site id are exempt.
          const sessionRow = getSession(ctx.sessionId);
          if (sessionRow?.kind === 'chat') {
            // Project key = the command's working dir, so provenance is scoped to
            // THIS project (a destination established for one project can't
            // provenance another — preserves the cross-project clobber guard).
            const projectKey = typeof (parsedInput as { cwd?: unknown })?.cwd === 'string'
              ? (parsedInput as { cwd: string }).cwd : undefined;
            const prov = evaluateDestinationProvenance(command, buildPublishProvenance(ctx.sessionId, projectKey));
            if (prov.action === 'flag' && prov.shapeKey) {
              try {
                appendEvent({
                  sessionId: ctx.sessionId,
                  turn: 0,
                  role: 'system',
                  type: 'guardrail_tripped',
                  data: { kind: 'unverified_destination', toolName: tool.name, verb: prov.verb ?? null, shapeKey: prov.shapeKey, hardBlock: true },
                });
              } catch { /* telemetry write must never block */ }
              throw new UnverifiedDestinationError({ command, verb: prov.verb ?? 'publish', shapeKey: prov.shapeKey, targets: extractExplicitPublishTargets(command) });
            }
          }
          const verdict = evaluateShellDestination(command);
          // PRODUCTION ambient publish → HARD block on EVERY attempt (retrying
          // the same ambient command must never clobber the linked site — the
          // 2026-06-14 Test-5 finding). Non-prod ambient publish → one-shot nudge.
          if (verdict.action === 'flag' && verdict.shapeKey
            && (verdict.hardBlock || !wasDestinationNudged(ctx.sessionId, verdict.shapeKey))) {
            if (!verdict.hardBlock) markDestinationNudged(ctx.sessionId, verdict.shapeKey);
            try {
              appendEvent({
                sessionId: ctx.sessionId,
                turn: 0,
                role: 'system',
                type: 'guardrail_tripped',
                data: { kind: 'implicit_destination', toolName: tool.name, verb: verdict.verb ?? null, shapeKey: verdict.shapeKey, hardBlock: !!verdict.hardBlock },
              });
            } catch { /* telemetry write must never block */ }
            throw new ImplicitDestinationError({ command, verb: verdict.verb ?? 'publish', shapeKey: verdict.shapeKey, hardBlock: verdict.hardBlock });
          }
        }
      }
    } catch (err) {
      if (err instanceof ImplicitDestinationError) throw err;
      if (err instanceof UnverifiedDestinationError) throw err;
      // eslint-disable-next-line no-console
      console.warn('[harness] destination gate threw (fail-open)', err instanceof Error ? err.message : err);
    }
    // 2c4. Shell SEND grounding (audit #2). run_shell_command is the universal
    // external-write vector (curl -X POST / gh api --method POST / sf data
    // update / sendmail), but isMutatingExternalWrite is composio-only, so
    // these sends never got the grounding (payload-integrity) + duplicate gates
    // that composio/MCP sends get — the Eley/mailbox incident class, reachable
    // through shell. Classify only the CLEAR network-mutation shapes
    // (conservative; misses = status quo) and route them through the SAME
    // fail-open gates, reading the target from the command string. The
    // external_write ledger is SHARED so a shell re-send to the same target
    // bumps. Fail-open on any evaluation error.
    try {
      if (isGroundingGateEnabled() && tool.name === 'run_shell_command') {
        const command = typeof (parsedInput as { command?: unknown })?.command === 'string'
          ? (parsedInput as { command: string }).command
          : '';
        const mutation = command ? classifyShellNetworkMutation(command) : { isNetworkMutation: false as const };
        if (mutation.isNetworkMutation && mutation.shapeKey) {
          const dupTargets = extractDuplicateIdentityKeys(command);
          if (dupTargets.length > 0) {
            let priorWrites: Array<{ shapeKey?: string; targets?: string[] }> = [];
            try {
              priorWrites = listEvents(ctx.sessionId, { types: ['external_write'] })
                .map((ev) => ev.data as { shapeKey?: string; targets?: string[] });
              const failures = listEvents(ctx.sessionId, { types: ['external_write_failed'] })
                .map((ev) => ev.data as { shapeKey?: string; targets?: string[] });
              for (const failure of failures) {
                const ft = new Set((failure.targets ?? []).map((t) => String(t).toLowerCase()));
                const idx = priorWrites.findIndex((w) => w.shapeKey === failure.shapeKey
                  && (w.targets ?? []).some((t) => ft.has(String(t).toLowerCase())));
                if (idx >= 0) priorWrites.splice(idx, 1);
              }
            } catch { /* fail toward not-a-duplicate */ }
            const dup = detectDuplicateTarget({ sessionId: ctx.sessionId, shapeKey: mutation.shapeKey, targets: dupTargets, priorWrites });
            if (dup.duplicate && dup.warnedKey) {
              markDuplicateWarned(dup.warnedKey);
              throw new DuplicateExternalWriteError({ toolName: tool.name, shapeKey: mutation.shapeKey, target: dup.target ?? 'unknown' });
            }
          }
          const verdict = await evaluateGrounding(ctx.sessionId, tool.name, command);
          if (verdict.action === 'block') {
            try {
              appendEvent({
                sessionId: ctx.sessionId, turn: 0, role: 'system', type: 'guardrail_tripped',
                data: { kind: 'grounding_blocked', toolName: tool.name, source: 'shell_send', targets: verdict.targets.slice(0, 5), reason: verdict.reason },
              });
            } catch { /* telemetry must never block */ }
            throw new GroundingCheckFailedError({
              toolName: tool.name, reason: verdict.reason, targets: verdict.targets,
              sourceCallIds: verdict.sourceCallIds, failureCount: verdict.failureCount ?? 1,
            });
          }
          // Record the shell send in the SHARED external_write ledger.
          try {
            appendEvent({
              sessionId: ctx.sessionId, turn: 0, role: 'system', type: 'external_write',
              data: { shapeKey: mutation.shapeKey, toolName: tool.name, irreversible: true, shell: true, targets: dupTargets.slice(0, 8) },
            });
          } catch { /* telemetry must never block */ }
        }
      }
    } catch (err) {
      if (err instanceof GroundingCheckFailedError || err instanceof DuplicateExternalWriteError) throw err;
      // eslint-disable-next-line no-console
      console.warn('[harness] shell-send grounding threw (fail-open)', err instanceof Error ? err.message : err);
    }
    // 2c4.5. Shell SEND goal-fidelity — mirror of 2c2.5 for the shell
    // external-write vector (curl POST / gh api / sf data / sendmail), so a
    // shell publish/send gets the same goal+skill verification composio sends
    // get. Same fail-open contract; reads the target from the command string.
    try {
      if (isGoalFidelityGateEnabled() && tool.name === 'run_shell_command') {
        const command = typeof (parsedInput as { command?: unknown })?.command === 'string'
          ? (parsedInput as { command: string }).command
          : '';
        const mutation = command ? classifyShellNetworkMutation(command) : { isNetworkMutation: false as const };
        if (mutation.isNetworkMutation && mutation.shapeKey) {
          const verdict = await evaluateGoalFidelity(ctx.sessionId, tool.name, command);
          if (verdict.action === 'block') {
            try {
              appendEvent({
                sessionId: ctx.sessionId, turn: 0, role: 'system', type: 'guardrail_tripped',
                data: { kind: 'goal_fidelity_blocked', toolName: tool.name, source: 'shell_send', mode: verdict.mode, skill: verdict.skill ?? null, targets: verdict.targets.slice(0, 5), reason: verdict.reason, failureCount: verdict.failureCount ?? 1 },
              });
            } catch { /* telemetry must never block */ }
            throw new GoalFidelityCheckFailedError({
              toolName: tool.name, reason: verdict.reason, gap: verdict.gap, targets: verdict.targets, failureCount: verdict.failureCount ?? 1,
            });
          }
        }
      }
    } catch (err) {
      if (err instanceof GoalFidelityCheckFailedError) throw err;
      // eslint-disable-next-line no-console
      console.warn('[harness] shell-send goal-fidelity threw (fail-open)', err instanceof Error ? err.message : err);
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
                  // Target identity (recipient email/domain/ids) — read by
                  // the duplicate-target gate so a later same-shape write
                  // to the same target gets a conscious-confirmation bump.
                  targets: extractDuplicateIdentityKeys(parsedInput).slice(0, 8),
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
    // Both nudges ride the same advisory rail (appended to the tool result by
    // the caller). Combine so a turn that trips both still delivers both.
    const nudges = [fanoutNudge, cacheNudge].filter(Boolean);
    return nudges.length > 0 ? nudges.join('\n\n') : undefined;
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
      // SDK call_id for THIS invocation — lets the within-task fetch-memory nudge
      // correlate a future identical call back to this one's tool_outputs row.
      const invokeCall = (details as { toolCall?: { callId?: string; id?: string } } | undefined)?.toolCall;
      const invokeCallId = invokeCall?.callId ?? invokeCall?.id;
      let fanoutNudge: string | undefined;
      try {
        fanoutNudge = await runBrackets(ctx?.sessionId ?? '', parsedInput, invokeCallId);
      } catch (err) {
        // A recoverable gate throw lands as a SOFT tool error — the model sees
        // it as the tool's output and self-corrects. Throwing here would abort
        // the run because our wrap is OUTSIDE the SDK's _invoke catch. The exact
        // same disposition is applied on the legacy execute path below, via the
        // shared softToolError() — so a gate's recoverability is the GATE's, not
        // a function of which wrapper the tool happened to use (the crash class).
        const soft = softToolError(err);
        if (soft !== null) return soft;
        // ToolGuardrailEscalated / KillRequested / ToolTimeout / unknown errors
        // propagate — these SHOULD abort the run.
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
      let invokePromise =
        tool.name === 'run_worker' && ctx && workerThrashGuardEnabled()
          ? (harnessRunContextStorage.run(
              { ...ctx, guardrailScopeId: workerScopeIdFromDetails(ctx.sessionId, details) },
              invokeOnce,
            ) as Promise<unknown>)
          : invokeOnce();
      invokePromise = invokePromise.then((result) => {
        compensateFailedExternalWrite(ctx?.sessionId, tool.name, parsedInput, result);
        recordPublishIfSucceeded(tool.name, parsedInput, result);
        creditRecallFromToolResult(ctx?.sessionId, tool.name, parsedInput, result);
        return result;
      });
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
      // Deliver the fan-out nudge INTO the model's view: append it to a
      // string result. (Non-string results skip the nudge rather than risk
      // corrupting a structured payload — the next serial call will re-fire.)
      if (fanoutNudge) {
        const result = await invokePromise;
        return typeof result === 'string' ? `${result}\n\n${fanoutNudge}` : result;
      }
      return invokePromise;
    };
    return { ...tool, invoke: wrappedInvoke } as T;
  }

  // LEGACY PATH — plain-object tool with execute only (tests, fixtures).
  const originalExecute = tool.execute!;
  const wrappedExecute = async (input: unknown, runContext?: unknown): Promise<unknown> => {
    const ctx = harnessRunContextStorage.getStore();
    let fanoutNudge: string | undefined;
    try {
      fanoutNudge = await runBrackets(ctx?.sessionId ?? '', input);
    } catch (err) {
      // SAME disposition as wrappedInvoke above: a recoverable gate throw becomes
      // a soft tool error here too (this path had NO try/catch, so a typed gate
      // throw aborted the run purely because the tool used `execute` not `invoke`).
      const soft = softToolError(err);
      if (soft !== null) return soft;
      throw err;
    }
    const result = await withTimeout(
      (async () => originalExecute(input, runContext))(),
      timeoutMs,
      tool.name,
      { isPaused: isPausedFactory(ctx?.sessionId) },
    );
    compensateFailedExternalWrite(ctx?.sessionId, tool.name, input, result);
    recordPublishIfSucceeded(tool.name, input, result);
    creditRecallFromToolResult(ctx?.sessionId, tool.name, input, result);
    if (fanoutNudge && typeof result === 'string') return `${result}\n\n${fanoutNudge}`;
    return result;
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

/** A recoverable gate throw → the recovery string surfaced to the model as the
 *  tool's own output (a SOFT tool error), or null when the error MUST propagate
 *  and abort the run (escalation, kill, timeout, or an unknown bug). Shared by
 *  BOTH wrapper paths (invoke + legacy execute) so a gate's recoverability is a
 *  property of the gate, never of which wrapper a tool happens to use. */
export function softToolError(err: unknown): string | null {
  if (
    err instanceof MissingExecutionWrapError ||
    err instanceof ConfirmFirstRequiredError ||
    err instanceof ToolGuardrailBlocked ||
    err instanceof ToolCallsLimitExceeded ||
    err instanceof GroundingCheckFailedError ||
    err instanceof GoalFidelityCheckFailedError ||
    err instanceof DuplicateExternalWriteError ||
    err instanceof ImplicitDestinationError ||
    err instanceof UnverifiedDestinationError
  ) {
    return `Tool call refused by harness: ${err instanceof Error ? err.message : String(err)}`;
  }
  return null;
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
