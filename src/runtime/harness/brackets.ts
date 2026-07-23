import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { isKillRequested, appendEvent, getSession, listEvents, getToolOutput, type KillRequestTarget } from './eventlog.js';
import {
  backgroundOfferEnabled as spineBackgroundOfferEnabled,
  effectiveTurnObjective,
} from './turn-control.js';
import { runWithToolAbortSignal } from '../tool-abort-context.js';
import {
  takeShellExecutionOutcome,
  type ShellExecutionOutcome,
} from '../shell-execution-outcome.js';
import { getHarnessBudgetSettings } from './budget-settings.js';
import { listPending as listPendingApprovals } from './approval-registry.js';
import { evaluateToolCall, applyMode } from './tool-guardrail.js';
import { normalizeWorkerOutput } from '../../agents/worker-output.js';
import { getRuntimeEnv } from '../../config.js';
import { sessionHasBackgroundOffer } from './convergence-steer.js';
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
import { queuePendingAction, findOpenPendingActionByPayload } from './pending-actions.js';
import {
  isGroundingGateEnabled,
  extractDuplicateIdentityKeys,
  evaluateGrounding,
  detectDuplicateTarget,
  duplicateResendConsented,
  GroundingCheckFailedError,
  DuplicateExternalWriteError,
} from './grounding-gate.js';
import {
  evaluateRecipientSetIntegrity,
  isRecipientIntegrityGateEnabled,
  RecipientSetIntegrityError,
} from './recipient-integrity-gate.js';
import {
  hasToolOutputReference,
  resolveToolOutputReferences,
  toolOutputReferenceResolutionEnabled,
} from './tool-output-reference.js';
import {
  isGoalFidelityGateEnabled,
  evaluateGoalFidelity,
  extractMessageBody,
  GoalFidelityCheckFailedError,
} from './goal-fidelity-gate.js';
import {
  isOutputGroundingGateEnabled,
  evaluateOutputGrounding,
  OutputGroundingCheckFailedError,
} from './output-grounding-gate.js';
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
import { creditMatchingRecall, isTransientFailure } from '../../memory/procedural-recall-link.js';
import {
  asyncJobTimeoutCorrective,
  writeJobTimeoutCorrective,
} from './tool-error-corrective.js';
import {
  artifactIntentForTool,
  artifactObjectiveForRunScope,
  artifactOutputProvesNoDispatch,
  artifactReuseMessage,
  artifactVerificationIntentForTool,
  bindClaimedArtifact,
  claimArtifactSlot,
  extractArtifactResource,
  markClaimedArtifactUncertain,
  releaseClaimedArtifact,
  resolveArtifactRunScopeId,
  scopeArtifactIntentForObjective,
  verifyArtifactBindingFromToolResult,
  type ArtifactIntent,
} from './artifact-ledger.js';

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
export function assertNotKilled(sessionId: string, target?: KillRequestTarget): void {
  if (isKillRequested(sessionId, target)) {
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

  /** Tool calls made so far this runTurn (read-only). */
  get calls(): number {
    return this.count;
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
  options?: { isPaused?: () => boolean; pauseRecheckMs?: number; onTimeout?: () => void },
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
      // onTimeout fires ONLY on the actual rejection — never on the pause-defer
      // re-arm above (the tool is parked, not stuck) and never after `work`
      // already settled (the `settled` guard). S3 uses it to abort the live
      // request; the late AbortError that abort produces is consumed by the
      // `work.then` rejection handler below, so it can't escape as unhandled.
      try { options?.onTimeout?.(); } catch { /* abort hook is best-effort */ }
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
  // was way too short — the stream-timeout regression hit 60s on
  // a worker doing firecrawl_search for LinkedIn URL lookup. The
  // worker IS the external-API surface from the parent agent's
  // perspective. 5min externalApi bucket is the right shape.
  //
  // v0.5.21.1 — extended to ALL sub-agent-as-tool wrappings. Verified
  // In the plan-timeout regression, draft_plan (planner.asTool) timed
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
  // run_batch executes N gated external calls in a deterministic loop — a
  // legitimate batch runs for MINUTES by design (writes serial, reads in
  // waves, rate-limit backoff pauses). Default 60s false-killed a live 8-item
  // batch 2026-07-08: the tool call "timed out" at 60s and paused the run on
  // ask-user while the batch itself COMPLETED 8/8 twenty seconds later. Same
  // shell-tier budget as the other long-running executors; the batch runner's
  // own halting rules (consecutive failures, backoff caps) bound the true
  // worst case well below it.
  if (toolName === 'run_batch') {
    return DEFAULT_TIMEOUTS_MS.shell;
  }
  // run_tool_program has its OWN activity-aware sandbox ceiling
  // (CLEMMY_CODEMODE_MAX_MS, default 180s) and partial-result salvage. The
  // outer harness must be wider than that inner deadline; otherwise the generic
  // 60s wrapper kills code mode first and the model gets an ask/retry timeout
  // instead of the sandbox's "partial results salvaged" corrective.
  if (toolName === 'run_tool_program') {
    return DEFAULT_TIMEOUTS_MS.externalApi;
  }
  // MCP namespace shim separator is "__" (src/runtime/mcp-namespace-shim.ts).
  if (toolName.includes('__')) {
    return DEFAULT_TIMEOUTS_MS.mcp;
  }
  return DEFAULT_TIMEOUTS_MS.default;
}

/** Tools whose ToolTimeout should SELF-CORRECT (return the async/verify corrective
 *  as the tool result) instead of propagating to the loop's ask-user "retry/switch/
 *  stop" pause. The class is the long-running EXTERNAL-job surface: Composio (static
 *  composio_execute_tool + dynamic cx_*), external_api_*, and MCP "__" tools —
 *  exactly the tools timeoutForTool puts in the generous externalApi/mcp buckets, and
 *  whose timeout means "long upstream job, switch to async/verify", not "internal bug".
 *  Internal default-60s tools (memory_/workspace_/file/plan) and shell are DELIBERATELY
 *  excluded: a timeout there is a genuine hang with no async recovery move, so the
 *  ask-user card is still correct. run_worker is handled by its own dedicated block
 *  (worker-specific message) — returned false here so it never reaches the general path.
 *  draft_plan stays excluded (a planner/Codex flake → ask-user is the right call). */
export function isTimeoutSelfCorrectTool(toolName: string): boolean {
  if (toolName === 'run_worker' || /^run_worker/.test(toolName)) return false; // own block
  if (toolName === 'composio_execute_tool') return true;
  if (toolName.startsWith('cx_')) return true;            // dynamic first-class Composio tools
  if (/^(composio|external_api)_/.test(toolName)) return true;
  if (toolName.includes('__')) return true;               // MCP namespace shim separator
  return false;
}

/** Pick the self-correcting corrective for a timed-out long-job tool. Reads vs
 *  writes get OPPOSITE advice: a read switches to async START+POLL; a write must
 *  verify-before-retry (it may have landed server-side — re-issuing risks a
 *  duplicate). Reuses classifyExternalWrite so the two gates agree on "is this a
 *  write". We only know the tool name + budget here (withTimeout synthesizes the
 *  ToolTimeout), so the summary is the elapsed budget and `where` is the tool tag. */
function timeoutCorrectiveFor(toolName: string, parsedInput: unknown, timeoutMs: number): string {
  const summary = `exceeded its ${Math.round(timeoutMs / 1000)}s time budget`;
  const where = ` (${toolName})`;
  const { mutating } = classifyExternalWrite(toolName, parsedInput);
  return mutating
    ? writeJobTimeoutCorrective(toolName, summary, where)
    : asyncJobTimeoutCorrective(toolName, summary, where);
}

// ─── S3 orphan ledger + orphaned-write retry corrective ─────────────────────
//
// A MUTATING external write that TIMES OUT may have landed server-side (the
// harness stops waiting; abort is best-effort). `recordExternalWriteOrphan`
// writes a durable audit event on that timeout; the orphaned-write retry gate
// (runBrackets, block 2c1.5) consults it so a blind same-shape retry — which the
// DUPLICATE_EXTERNAL_WRITE hard wall covers only for SEND/PUBLISH — first gets a
// verify-before-retry corrective. Informs, never hard-blocks (house doctrine).

/** Short, stable digest of a tool call's args for the orphan audit record. */
function shortArgsDigest(parsedInput: unknown): string {
  try {
    const text = typeof parsedInput === 'string' ? parsedInput : JSON.stringify(parsedInput);
    return createHash('sha256').update(text ?? '').digest('hex').slice(0, 12);
  } catch {
    return 'unknown';
  }
}

/** Record that a mutating external write TIMED OUT (durable audit of a
 *  maybe-landed write). No-ops for reads/non-writes and when there is no
 *  session. Telemetry only — never throws into the corrective path. */
function recordExternalWriteOrphan(
  sessionId: string | undefined,
  toolName: string,
  parsedInput: unknown,
  timeoutMs: number,
): void {
  if (!sessionId) return;
  try {
    const shape = classifyExternalWrite(toolName, parsedInput);
    if (!shape.mutating) return;
    appendEvent({
      sessionId,
      turn: 0,
      role: 'system',
      type: 'external_write_orphaned',
      data: {
        tool: toolName,
        slug: shape.shapeKey ?? null,
        targets: extractDuplicateIdentityKeys(parsedInput).slice(0, 8),
        argsDigest: shortArgsDigest(parsedInput),
        timeoutMs,
        aborted: true,
      },
    });
  } catch { /* telemetry write must never block the corrective */ }
}

/** (session, shape, target) combos whose orphaned-retry corrective already
 *  surfaced once — a speed bump, not a wall: the CONSCIOUS retry after the model
 *  verified via read-back passes. In-memory by design (a daemon restart fails
 *  toward letting the write through, which is the non-blocking default). */
const orphanRetryWarned = new Set<string>();

/** Does this mutating write hit a (shape, target) whose prior attempt is on the
 *  orphan ledger for this session? Returns the matching target or null. */
function findOrphanedWriteMatch(
  sessionId: string,
  shapeKey: string | undefined,
  targets: string[],
): { target: string } | null {
  if (!shapeKey || targets.length === 0) return null;
  let orphans: Array<{ seq: number; slug?: string | null; targets?: string[] }>;
  try {
    orphans = listEvents(sessionId, { types: ['external_write_orphaned'] })
      .map((ev) => ({ seq: ev.seq, ...(ev.data as { slug?: string | null; targets?: string[] }) }));
  } catch {
    return null;
  }
  if (orphans.length === 0) return null;
  for (const target of targets) {
    const t = target.toLowerCase();
    const hit = orphans.filter((o) =>
      (o.slug ?? undefined) === shapeKey &&
      (o.targets ?? []).some((x) => String(x).toLowerCase() === t));
    if (hit.length === 0) continue;
    // Verified-retry pass-through: the timeout corrective ALREADY told the
    // model to read the target back before retrying. Any tool activity AFTER
    // the orphan means it did exactly that (or otherwise acted deliberately) —
    // bouncing again would stack a redundant verify→retry cycle on top of the
    // one it just completed (review finding). Only a BLIND immediate retry
    // (zero intervening tool returns) gets the speed bump.
    const latestOrphanSeq = Math.max(...hit.map((o) => o.seq));
    try {
      const verified = listEvents(sessionId, { types: ['tool_returned'] })
        .some((ev) => ev.seq > latestOrphanSeq);
      if (verified) return null;
    } catch { /* can't tell — keep the speed bump */ }
    return { target: t };
  }
  return null;
}

/** Thrown when a mutating write is retried against a shape/target whose prior
 *  attempt TIMED OUT and may have landed. Surfaced to the model as a SOFT tool
 *  error (same disposition as DuplicateExternalWriteError) so it verifies via a
 *  read-back and then re-issues — it never hard-aborts the run. */
export class OrphanedWriteRetryError extends Error {
  public readonly toolName: string;
  public readonly shapeKey: string | undefined;
  public readonly target: string;
  constructor(opts: { toolName: string; shapeKey: string | undefined; target: string }) {
    super(
      `ORPHANED_WRITE_RETRY: an earlier ${opts.shapeKey ?? opts.toolName} to ${opts.target} in this session TIMED OUT — ` +
        'the harness stopped waiting but the write MAY HAVE LANDED server-side, so retrying blindly could create a DUPLICATE. ' +
        'FIRST verify whether it landed: READ THE TARGET BACK with a *_GET / *_LIST / *_SEARCH action for this same record/object. ' +
        'Only write again if it is confirmed ABSENT (prefer an UPSERT or idempotency key if the toolkit supports one). ' +
        'This is a one-time check — the conscious retry after you verify will go through.',
    );
    this.name = 'OrphanedWriteRetryError';
    this.toolName = opts.toolName;
    this.shapeKey = opts.shapeKey;
    this.target = opts.target;
  }
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
  /** Exact accepted user event for this attempt. Deterministic preflight gates
   * must not consult whichever session input happens to be newest. */
  sourceUserSeq?: number;
  /** One active model/tool run; loop/discovery counters key here so a long-lived
   * chat session does not accumulate unrelated calls across user turns. */
  behaviorScopeId?: string;
  /** Inc A2 — set once per runTurn after the mid-step background-offer nudge has
   *  been evaluated, so a long grind nudges AT MOST once per step (the context is
   *  rebuilt per Runner.run, so this naturally resets each runTurn). */
  backgroundOfferNudged?: boolean;
  /** This run is resolving the user's answer to a clarification. Do not inject
   *  a second conversational gate by offering background execution mid-turn. */
  suppressBackgroundOffer?: boolean;
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
  /** Set ONLY by the batch runner's approved/certified execute path (never on
   *  ad-hoc dispatches). When present, the batch plan already passed ONE
   *  plan-level certification judge over these EXACT payloads, and the items are
   *  byte-pinned by `payloadHash` at approval — so the per-item LLM boundary
   *  judges (goal-fidelity, output-grounding) are redundant latency, not safety,
   *  and are skipped. Every DETERMINISTIC gate still runs (see the write boundary). */
  certifiedBatch?: { batchId: string; payloadHash: string };
  /** This tool call is ONE ITEM of a batch-runner plan (certified or not).
   *  Batch items never claim artifact slots: the batch lane is the sanctioned
   *  multi-item primitive with its own per-item ledger — N same-kind creates
   *  in one plan would deadlock the single-deliverable slot model, and claim
   *  admission's scope side effects tripped the execution gate on uncertified
   *  plans (2026-07-22). */
  batchItem?: boolean;
  /** This tool call originates INSIDE a code-mode program (clem.<tool> dispatch).
   *  The deterministic read-fanout block must never fire here — a program's
   *  batched reads ARE the sanctioned execution the block steers the model toward;
   *  refusing them would break the very recovery the block demands. */
  codeMode?: boolean;
  /** Recall runs recorded by tool handlers during this turn (memory_recall_all,
   *  memory_search_facts). The post-turn auto-credit hook reads these so every
   *  lane that records a run gets credit matching — the code-level replacement
   *  for the never-called memory_mark_used tool. */
  turnRecallRunIds?: string[];
}

/** The tracker scope a call registers under. EXEMPT lanes (code-mode programs,
 *  certified-batch items, workers) get their OWN window so their reads never
 *  inflate the ORCHESTRATOR's direct-read fanout counts — otherwise a batch/
 *  program of 6+ reads poisoned the shared session tracker and the orchestrator's
 *  very NEXT direct read of that tool was refused with a nonsensical "batch this
 *  single read" message (2026-07-12 strand-hunt finding). Workers already isolate
 *  via guardrailScopeId; this extends the same isolation to code-mode/batch.
 *  Direct orchestrator calls fall through to behaviorScopeId ?? sessionId — the
 *  ENFORCED scope — exactly as before (byte-identical for the non-exempt path). */
export function guardrailScopeKey(
  ctx: Pick<HarnessRunContext, 'sessionId' | 'guardrailScopeId' | 'behaviorScopeId' | 'codeMode' | 'certifiedBatch'>,
): string {
  if (ctx.guardrailScopeId) return ctx.guardrailScopeId; // worker: already isolated
  const base = ctx.behaviorScopeId ?? ctx.sessionId;
  if (ctx.certifiedBatch) return `${base}::batch:${ctx.certifiedBatch.batchId}`;
  if (ctx.codeMode) return `${base}::codeMode`;
  return base;
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

// Optional Inc A2 — mid-runTurn background-offer nudge. The loop's between-steps nudge
// can't catch a model that grinds a long task in a SINGLE runTurn (many tool
// calls, then done/ask — no continuation). This rail fires WITHIN the runTurn,
// appended to a tool result like the fan-out nudge, so the model reads it
// mid-stride and can offer to move the work to the background. Same kill-switch
// as the loop nudge (CLEMMY_BG_OFFER_NUDGE). Defined locally to avoid a
// brackets→loop import cycle.
function backgroundOfferNudgeEnabled(): boolean {
  // 2026-07-16 policy: default ON via the shared turn-control spine.
  return spineBackgroundOfferEnabled();
}
const BACKGROUND_OFFER_NUDGE_MIN_TOOLS = 6;

// Pre-write LATENCY: the irreversible-write/send path runs three independent,
// fail-open model-judges (grounding, goal-fidelity, output-grounding) that today
// await back-to-back. They share no data (none reads another's verdict), so we
// start the two siblings CONCURRENTLY with grounding and await each in its own
// existing block — same order, same short-circuit, same telemetry, only the model
// calls overlap (≈ max of the three instead of the sum). Off ⇒ byte-identical
// sequential path. Kill-switch CLEMMY_PARALLEL_PREWRITE_GATES (default on).
export function parallelPreWriteGatesEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_PARALLEL_PREWRITE_GATES', 'on') ?? 'on').toLowerCase() !== 'off';
}

// A CERTIFIED batch item (ctx.certifiedBatch set by the batch runner's approved
// execute path) skips the per-item LLM boundary judges (goal-fidelity +
// output-grounding). Safety: the batch plan already passed ONE certification
// judge over these EXACT payloads, and approval byte-pins the items by
// payloadHash — nothing the model does between certification and execution can
// alter them, so a second per-item opinion adds ~10-15s×N latency, not safety
// (live 2026-07-08: a 10-email send ran ~18s/item on repeated goal_fidelity
// judging). Every DETERMINISTIC gate (taxonomy approval, destination, duplicate-
// target, confirm-first, external_write ledger, guardrail counters) still runs.
// Kill-switch CLEMMY_BATCH_SKIP_ITEM_JUDGE=off restores per-item judging.
export function batchSkipItemJudgeEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_BATCH_SKIP_ITEM_JUDGE', 'on') ?? 'on').toLowerCase() !== 'off';
}

// A JUDGE FAILURE on an irreversible action must MINT a pending-approval card,
// never silently refuse (P0c). Live 2026-07-08: goal-fidelity judge timeouts
// refused 8 of 10 approved emails with a "GOAL_FIDELITY_CHECK_FAILED" string
// buried in the tool results — the user lost the sends without ever being asked.
// Default on. Kill-switch CLEMMY_JUDGE_FAIL_APPROVAL=off restores plain refusal.
export function judgeFailApprovalEnabled(): boolean {
  return (getRuntimeEnv('CLEMMY_JUDGE_FAIL_APPROVAL', 'on') ?? 'on').toLowerCase() !== 'off';
}

/**
 * Queue (or reuse) a one-tap pending-approval card for a call an LLM judge
 * COULDN'T verify (timeout/outage), so the user is asked instead of losing the
 * send to a buried refusal. The card's payload is the EXACT tool + args, so the
 * approved-execution path fires byte-identical (the model can't swap it). Dedup:
 * an open card for the same payload is reused, never re-minted (batch loops).
 * Returns the pending-action id, or null when disabled / on any error (caller
 * then falls back to today's plain refusal).
 */
export function mintJudgeFailApproval(input: {
  sessionId: string;
  toolName: string;
  payload: unknown;
  judge: string;
  judgeFailureReason: string;
  targetSummary?: string;
}): string | null {
  if (!judgeFailApprovalEnabled()) return null;
  try {
    const existing = findOpenPendingActionByPayload(input.toolName, input.payload);
    if (existing) return existing.id; // dedup — one card per payload
    const shape = classifyExternalWrite(input.toolName, input.payload);
    const isSend = /SEND|EMAIL|PUBLISH|POST|MESSAGE|SLACK|TWEET|DM\b/i.test(shape.shapeKey ?? input.toolName);
    const targetSummary = input.targetSummary
      || extractDuplicateIdentityKeys(input.payload).slice(0, 5).join(', ')
      || 'this action';
    const record = queuePendingAction({
      title: `Judge couldn't verify: ${targetSummary}`.slice(0, 160),
      summary: `The ${input.judge} judge couldn't run (${input.judgeFailureReason}), so this irreversible ${input.toolName} was NOT sent unverified — approve to fire the exact queued call, or deny to drop it.`,
      kind: isSend ? 'external_send' : 'external_write',
      toolName: input.toolName,
      payload: input.payload,
      targetSummary,
      preview: JSON.stringify(input.payload).slice(0, 800),
      risk: 'Irreversible external action that the automated fidelity judge could not verify before sending.',
      rollback: isSend ? 'Sends are irreversible once delivered.' : 'Depends on the target tool.',
      sessionId: input.sessionId,
      createdBy: 'judge_fail_approval',
    });
    return record.id;
  } catch {
    return null; // never let the mint failure change the refusal path
  }
}

/** Start a gate's judge promise NOW (concurrently) while suppressing an
 *  unhandled-rejection if an earlier gate blocks and this one is never awaited.
 *  The original promise is returned so the gate's own block still awaits it and
 *  sees the real value/rejection (handled fail-open there) — the attached no-op
 *  catch is a separate, discarded promise purely to silence the runtime warning. */
export function startGate<T>(p: Promise<T>): Promise<T> {
  void p.catch(() => { /* awaited (and fail-open-handled) in the gate's own block */ });
  return p;
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
export function buildPublishProvenance(sessionId: string, projectKey?: string): (target: string) => boolean {
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
          // LISTING-SHAPED output must NEVER confer blanket provenance (live
          // 2026-07-08 clobber: `sites:create --name X … || sites:list --json`
          // — the create FAILED, the fallback LIST exited 0 under the same
          // callId, and this sweep harvested EVERY existing site's id/name as
          // "created", handing the deploy stolen provenance onto an unrelated
          // live site another task had just published). If the result is a
          // multi-site listing (JSON array / >1 site_id), harvest ONLY the
          // object whose "name" equals a REQUESTED create name — nothing else.
          const body = res.replace(/^[\s\S]*?stdout:\s*/i, '');
          const isListing = /^\s*\[/.test(body) || (res.match(/"site_id"\s*:/gi) ?? []).length > 1;
          if (isListing) {
            for (const name of names) {
              const block = res.match(new RegExp(`\\{[^{}]*"name"\\s*:\\s*"${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^{}]*\\}`, 'i'))?.[0];
              if (!block) continue;
              created.add(name);
              for (const m of block.matchAll(/"(?:id|site_id|name|site_name)"\s*:\s*"([\w.-]+)"/gi)) created.add(m[1].toLowerCase());
            }
            continue;
          }
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
  shellOutcome?: ShellExecutionOutcome,
): void {
  if (!sessionId) return;
  try {
    const resultStr = typeof result === 'string' ? result : '';
    // Composio hard-failure (the 2026-06-12 to/to_email case) — and the
    // cold-start resolve NOT FOUND (ask-first batch regression item 1: the slug 404s at the
    // RESOLVE step, before any send, so the pre-recorded external_write must
    // compensate or the batch runner's side-effect-safe retry trips the
    // duplicate-target gate and the recipient is silently skipped).
    if (resultStr.startsWith('⚠️ composio_execute_tool FAILED')
      || /^⚠️ composio_execute_tool NOT FOUND \(slug=/.test(resultStr)) {
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
      // A generic non-zero provider CLI exit is NOT proof the write did not
      // land. Compensate only typed execution evidence that proves no effect
      // (local resolve/materialization failure or an authoritative provider
      // precondition adapter). Unknown/possible remains counted and must be
      // reconciled before retry.
      const demonstrablyNoEffect = shellOutcome?.effect === 'none';
      if (mutation.isNetworkMutation && mutation.shapeKey && demonstrablyNoEffect) {
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
function recordPublishIfSucceeded(
  toolName: string,
  parsedInput: unknown,
  result: unknown,
  shellOutcome?: ShellExecutionOutcome,
): void {
  try {
    if (toolName !== 'run_shell_command') return;
    if (shellOutcome && shellOutcome.dispatch !== 'acknowledged') return;
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
function creditRecallFromToolResult(
  sessionId: string | undefined,
  toolName: string,
  parsedInput: unknown,
  result: unknown,
  shellOutcome?: ShellExecutionOutcome,
): void {
  try {
    if (!sessionId) return;
    // Only a shell command (CLI memo) or a native MCP tool (`server__tool`, which
    // IS the stored MCP identifier) can ever match a CLI/MCP proven path. Skip the
    // (file-backed) store read for the many internal/composio tool results that
    // never could — keeps the per-tool-result hot path cheap. composio is credited
    // by its own slug path, not here.
    const isShell = toolName === 'run_shell_command';
    if (!isShell && !toolName.includes('__')) return;
    // A remembered CLI/provider procedure was not exercised when resolution or
    // package materialization failed locally. Do not penalize that provider
    // procedure; the recovery-learning lane records the local repair instead.
    if (isShell
      && shellOutcome?.dispatch === 'not_started'
      && (shellOutcome.phase === 'resolve' || shellOutcome.phase === 'materialize')) return;
    const command = isShell && typeof (parsedInput as { command?: unknown })?.command === 'string'
      ? (parsedInput as { command: string }).command : '';
    const haystack = isShell ? command : toolName;
    if (!haystack) return;
    const resultStr = typeof result === 'string' ? result : '';
    // Failure shapes the harness already recognizes (computer-tools exit_code,
    // run_worker ERROR stub, composio FAILED banner); otherwise treat as success.
    const failed = shellOutcome?.errorKind !== undefined
      || /(?:^|\s)exit_code:\s*[1-9]/.test(resultStr)
      || /^ERROR:/.test(resultStr)
      || resultStr.startsWith('⚠️ composio_execute_tool FAILED');
    // CLI/MCP failure signal starts flowing here (it never did before the store
    // fallback). A TRANSIENT blip — rate-limit, overload, network timeout — is not
    // the proven path's fault, so don't teach a good memo a failure from it
    // (auto-invalidate after 3 strikes could otherwise blacklist a working tool on
    // a flaky window). Skip crediting entirely; success crediting is unaffected.
    if (failed && isTransientFailure(resultStr)) return;
    creditMatchingRecall(sessionId, haystack, !failed);
  } catch { /* learning is best-effort — never break the tool result */ }
}

// Per-session serialization for the irreversible-send confirm-first gate
// (2026-07-09 Hole 4). The gate READS the prior same-shape count, AWAITs
// dynamic imports (yielding the loop), then APPENDs its own external_write.
// run_worker fans out up to 6 concurrent sends; without serialization all 6
// read prior<threshold in the await gap and none trip the batch floor — the
// exact 10-email incident on the worker lane. This chains the gate's critical
// section per session so each send sees the prior's append.
const sessionSendGateLocks = new Map<string, Promise<unknown>>();
function withSendGateLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = sessionSendGateLocks.get(sessionId) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  // Store a non-rejecting tail so a thrown gate (ConfirmFirstRequiredError)
  // doesn't poison the chain for the next send.
  sessionSendGateLocks.set(sessionId, run.then(() => undefined, () => undefined));
  return run;
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

  type ArtifactDispatch = {
    sessionId: string;
    runScopeId: string;
    artifactId: string;
    intent: ArtifactIntent;
    callId?: string;
  };
  type ArtifactAdmission = { dispatch?: ArtifactDispatch; deny?: string };

  /** Internal control flow for a durable duplicate-artifact refusal. It stays
   *  separate from the generic soft-error rail so callers receive the existing
   *  reuse instruction byte-for-byte, while the claim check can run before any
   *  accounting or external-write telemetry. */
  class ArtifactReuseDenied extends Error {
    constructor(public readonly reuseMessage: string) {
      super(reuseMessage);
      this.name = 'ArtifactReuseDenied';
    }
  }

  // Returns an advisory fan-out nudge string when the guardrail detects
  // serial per-item batch work (same composio slug, N distinct args). The
  // caller APPENDS it to the tool's result so the model reads it mid-stride —
  // a warn-mode telemetry event alone is invisible to the model (live
  // 2026-06-11: 74 serial composio calls, 8 warn events, zero course-change).
  const runBrackets = async (
    sessionId: string,
    parsedInput: unknown,
    callId?: string,
    claimBeforeAccounting?: () => ArtifactAdmission,
  ): Promise<string | undefined> => {
    const ctx = harnessRunContextStorage.getStore();
    if (!ctx) return; // no context = test fixture or out-of-band call; brackets degrade
    // 1. Kill check
    assertNotKilled(
      ctx.sessionId,
      ctx.sourceUserSeq ? { sourceUserSeq: ctx.sourceUserSeq } : undefined,
    );
    // (fold 2026-07-17: the fail-closed turn-preflight gate that ran here was
    // demoted — alignment is a conversational directive; consent enforcement
    // stays with plan-scope/approvals. See turn-control.ts.)
    // Artifact idempotency is an admission decision, not a tool attempt. Claim
    // immediately after kill/preflight authority but BEFORE counters, loop
    // tracking, batch accounting, and the external_write ledger. A durable
    // existing slot therefore refuses a duplicate without pretending another
    // provider mutation was attempted. If a later bracket refuses this newly
    // acquired claim, the wrapper releases it before surfacing the refusal.
    const artifactAdmission = claimBeforeAccounting?.();
    if (artifactAdmission?.deny) throw new ArtifactReuseDenied(artifactAdmission.deny);
    // 2. Counter cap (pre-increment). The call_tool dispatcher is exempt:
    // it delegates to dispatchBatchItemTool, whose INNER tool rides this
    // same ambient counter (call-tool.ts) — charging the wrapper too would
    // bill every deferred action twice, halving the effective budget on the
    // schema-on-demand lane. The inner charge is the real one; loop
    // detection below still evaluates the outer call.
    if (tool.name !== 'call_tool') {
      if (ctx.counter.willExceed()) {
        throw new ToolCallsLimitExceeded(ctx.counter.limit);
      }
      ctx.counter.increment();
    }
    // 2b. Tool-call guardrail (loop detection). Keyed by guardrailScopeId
    // when set (a worker run isolates its own window) else sessionId.
    let fanoutNudge: string | undefined;
    let cacheNudge: string | undefined;
    try {
      const rawDecision = evaluateToolCall(
        guardrailScopeKey(ctx),
        tool.name,
        parsedInput,
        callId,
        {
          authoritySessionId: ctx.sessionId,
          approvedBatch: Boolean(ctx.certifiedBatch),
        },
      );
      const decision = applyMode(rawDecision);
      // Fan-out nudge: only steer the ORCHESTRATOR's own context toward
      // run_worker — inside a worker scope (guardrailScopeId set) the nudge
      // is wrong advice (workers can't spawn workers), so suppress it. Also
      // suppress for CERTIFIED batch items: run_batch IS the sanctioned
      // serial primitive — nudging its own approved execution toward
      // run_worker is contradictory noise (it fired mid-batch in the ask-first regression).
      if (decision.fanoutNudge && !ctx.guardrailScopeId && !ctx.certifiedBatch) {
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
      // DETERMINISTIC read-fanout BLOCK (kill-switch CLEMMY_GUARDRAIL_FANOUT_BLOCK,
      // default off). The advisory nudge above is provably ignored; when enabled,
      // a model that keeps serializing the SAME read past the block threshold is
      // REFUSED so it must batch the remainder in one run_tool_program. Enforced
      // ONLY for the model's DIRECT calls — a call from a code-mode program
      // (ctx.codeMode), a worker (guardrailScopeId), or a certified batch is the
      // batched execution we're steering toward and must NEVER be blocked (that
      // would refuse the very program the block demands). Reads are idempotent, so
      // refusing one loses nothing.
      if (decision.fanoutBlock && !ctx.codeMode && !ctx.guardrailScopeId && !ctx.certifiedBatch) {
        try {
          appendEvent({
            sessionId: ctx.sessionId,
            turn: 0,
            role: 'system',
            type: 'guardrail_tripped',
            data: { kind: 'fanout_block', toolName: decision.toolName, count: decision.count, reason: decision.fanoutBlock },
          });
        } catch { /* telemetry write must never block */ }
        throw new ToolGuardrailBlocked({ ...decision, action: 'block', reason: decision.fanoutBlock });
      }
      // Within-task fetch-memory nudge (FIX 2). Only in the ORCHESTRATOR scope
      // (guardrailScopeId unset) — there the guardrail tracker and tool_outputs
      // share the real sessionId keying, so the prior call_id is reachable; in a
      // worker scope they diverge, so suppress. Also suppress when the prior
      // output was error-shaped: a retry after a transient failure must NOT be
      // discouraged. Nudge points at recall_tool_result; never serves a payload.
      if (decision.cachedCallId && !ctx.guardrailScopeId && !ctx.certifiedBatch) {
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
      // GRANT INVARIANT I2 (Phase 1, THE-GRANT plan): after a human approved a
      // byte-pinned plan, no session-bookkeeping key may refuse the dispatch.
      // A certified batch item (ctx.certifiedBatch = approved pending action,
      // payload hash pinned) carries its authority with it — Exhibit C
      // (2026-07-09): a certified + human-approved 25-email batch was refused
      // 0/25 by this gate because the session's execution row wasn't active.
      const grantCarried = Boolean(ctx.certifiedBatch);
      if (!grantCarried && isExecutionGateEnabled() && isMutatingExternalWrite(tool.name, parsedInput)) {
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
    // 2c1.5. Orphaned-write retry speed bump (S3 · informs, doesn't block).
    // A prior same-session same-shape MUTATING write TIMED OUT and may have landed
    // server-side (the orphan ledger). The DUPLICATE_EXTERNAL_WRITE hard wall
    // covers only irreversible SEND/PUBLISH, so a blindly-retried reversible
    // *_CREATE_* can silently duplicate. Surface a verify-before-retry corrective
    // ONCE (soft tool error → the model reads the target back, then re-issues the
    // conscious retry, which passes). Fail-open; warn-once so it can never loop.
    try {
      const shape = classifyExternalWrite(tool.name, parsedInput);
      if (shape.mutating) {
        const targets = extractDuplicateIdentityKeys(parsedInput);
        const match = findOrphanedWriteMatch(ctx.sessionId, shape.shapeKey, targets);
        if (match) {
          const warnKey = `${ctx.sessionId}::${shape.shapeKey}::${match.target}`;
          if (!orphanRetryWarned.has(warnKey)) {
            orphanRetryWarned.add(warnKey);
            try {
              appendEvent({
                sessionId: ctx.sessionId,
                turn: 0,
                role: 'system',
                type: 'guardrail_tripped',
                data: { kind: 'orphaned_write_retry', toolName: tool.name, shapeKey: shape.shapeKey ?? null, target: match.target },
              });
            } catch { /* telemetry write must never block */ }
            throw new OrphanedWriteRetryError({ toolName: tool.name, shapeKey: shape.shapeKey, target: match.target });
          }
        }
      }
    } catch (err) {
      if (err instanceof OrphanedWriteRetryError) throw err;
      // eslint-disable-next-line no-console
      console.warn('[harness] orphaned-write retry check threw (fail-open)', err instanceof Error ? err.message : err);
    }
    // 2c2. Grounding + duplicate-target gates (integrity at the
    // irreversible-write boundary — the 2026-06-11 client-data incident class).
    // Runs for IRREVERSIBLE shapes only (SEND/PUBLISH). Both fail open on
    // any evaluation error; both surface as SOFT tool errors the model
    // recovers from. Ordered BEFORE confirm-first so a corrupted or
    // duplicate payload is fixed before approval machinery engages, and
    // so the external_write event for THIS call (emitted by confirm-first
    // on allow) can never count against itself.
    //
    // PRE-WRITE LATENCY (CLEMMY_PARALLEL_PREWRITE_GATES): kick off the two sibling
    // judges (goal-fidelity + output-grounding) NOW so all three model calls
    // overlap. Each is still awaited + fully handled in its OWN block below (same
    // order, short-circuit, and telemetry); startGate suppresses an unhandled
    // rejection if grounding blocks first and these are never awaited. Grounding
    // stays inline (its duplicate-target check must precede its own judge), so
    // overlapping the other two collapses the trio to ≈ max-of-three latency.
    const preGateShape = classifyExternalWrite(tool.name, parsedInput);
    const preGateIrreversible = preGateShape.mutating && preGateShape.irreversible;
    // Exact multi-recipient integrity runs before any model judge or approval
    // machinery. It fails closed and never treats a queued/approved payload as
    // its own evidence, preventing a fabricated attendee list from laundering
    // itself through the confirmation UI.
    if (preGateIrreversible && isRecipientIntegrityGateEnabled()) {
      const recipientResult = evaluateRecipientSetIntegrity(ctx.sessionId, parsedInput);
      if (recipientResult.action === 'block') {
        try {
          appendEvent({
            sessionId: ctx.sessionId,
            turn: 0,
            role: 'system',
            type: 'guardrail_tripped',
            data: {
              kind: 'recipient_set_integrity_blocked',
              toolName: tool.name,
              recipients: recipientResult.recipients.slice(0, 25),
              unsupportedRecipients: (recipientResult.unsupportedRecipients ?? []).slice(0, 25),
              reason: recipientResult.reason,
            },
          });
        } catch { /* telemetry must never block the deterministic refusal */ }
        throw new RecipientSetIntegrityError({ toolName: tool.name, result: recipientResult });
      }
      // ADVISORY (never blocks): the send is grounded but OMITS people from a
      // roster the user asked to include in full — the "dropped 5" half of the
      // incident. Record it so it is no longer silent and so the approval surface
      // can show "N of M — missing …" to the human (Phase 2).
      if ((recipientResult.omittedRecipients?.length ?? 0) > 0) {
        try {
          appendEvent({
            sessionId: ctx.sessionId,
            turn: 0,
            role: 'system',
            type: 'guardrail_tripped',
            data: {
              kind: 'recipient_set_omission_advisory',
              action: 'warn',
              toolName: tool.name,
              recipients: recipientResult.recipients.slice(0, 25),
              omittedRecipients: (recipientResult.omittedRecipients ?? []).slice(0, 25),
              reason: recipientResult.reason,
            },
          });
        } catch { /* advisory only — never affect the send */ }
      }
    }
    const parallelGates = parallelPreWriteGatesEnabled();
    // CERTIFIED-BATCH item: skip the per-item LLM judges (goal-fidelity +
    // output-grounding). Deterministic gates below are untouched. Emit the skip
    // so the trace shows WHY no judge ran. Ad-hoc dispatches (no certifiedBatch)
    // are unaffected — they judge as before.
    const certifiedBatch = ctx?.certifiedBatch;
    const skipItemJudge = Boolean(certifiedBatch) && batchSkipItemJudgeEnabled();
    if (skipItemJudge && preGateIrreversible) {
      try {
        appendEvent({
          sessionId: ctx!.sessionId,
          turn: 0,
          role: 'system',
          type: 'guardrail_tripped',
          data: {
            kind: 'batch_certified_judge_skip',
            action: 'info',
            toolName: tool.name,
            judgeSkipped: 'batch_certified',
            batchId: certifiedBatch!.batchId,
            payloadHash: certifiedBatch!.payloadHash,
          },
        });
      } catch { /* telemetry write must never block */ }
    }
    const goalFidelityPromise = (!skipItemJudge && parallelGates && preGateIrreversible && isGoalFidelityGateEnabled())
      // deferCommit: an eagerly-started judge must NOT persist its failure bump —
      // if an earlier gate short-circuits and this verdict is discarded, the bump
      // would leak and trip a premature "STOP" on retry (integrity audit #2.4).
      // The block branch below commits via verdict.commitFailure?.() only when reached.
      ? startGate(evaluateGoalFidelity(ctx.sessionId, tool.name, parsedInput, { deferCommit: true }))
      : null;
    const preGateBody = (!skipItemJudge && parallelGates && preGateIrreversible && isOutputGroundingGateEnabled())
      ? extractMessageBody(parsedInput) : '';
    const outputGroundingPromise = (preGateBody && preGateBody.trim().length > 0)
      ? startGate(evaluateOutputGrounding(ctx.sessionId, preGateBody, { kind: 'write', toolName: tool.name, deferCommit: true }))
      : null;
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
              .map((ev) => ({ ...(ev.data as { shapeKey?: string; targets?: string[] }), at: ev.createdAt }));
            // Net out demonstrably-failed dispatches (external_write_failed
            // compensation events, emitted post-invoke): each failure cancels
            // ONE matching prior, so a corrected retry after a schema
            // rejection is not a "duplicate" of a send that never happened.
            const failures = listEvents(ctx.sessionId, { types: ['external_write_failed'] })
              .map((ev) => ({ ...(ev.data as { shapeKey?: string; targets?: string[] }), at: ev.createdAt }));
            for (const failure of failures) {
              const failTargets = new Set((failure.targets ?? []).map((t) => String(t).toLowerCase()));
              const idx = priorWrites.findIndex((w) =>
                w.shapeKey === failure.shapeKey &&
                (w.targets ?? []).some((t) => failTargets.has(String(t).toLowerCase())));
              if (idx >= 0) priorWrites.splice(idx, 1);
            }
          } catch { /* fail toward not-a-duplicate */ }
          const dup = detectDuplicateTarget({ sessionId: ctx.sessionId, shapeKey: shape.shapeKey, targets: dupTargets, priorWrites });
          if (dup.duplicate) {
            try {
              appendEvent({
                sessionId: ctx.sessionId,
                turn: 0,
                role: 'system',
                type: 'guardrail_tripped',
                data: { kind: 'duplicate_external_write', toolName: tool.name, shapeKey: shape.shapeKey ?? null, target: dup.target ?? null },
              });
            } catch { /* telemetry write must never block */ }
            // S2: a FRESH human approval naming this target (resolved after the
            // prior send) authorizes exactly this resend — the wall honors it.
            if (!duplicateResendConsented(ctx.sessionId, dup.target, dup.priorAt)) {
              throw new DuplicateExternalWriteError({ toolName: tool.name, shapeKey: shape.shapeKey, target: dup.target ?? 'unknown' });
            }
          }
          // Grounding: verify the payload against this target's own
          // session artifacts via an independent fast judge. A CERTIFIED batch
          // item skips it — certification already judged these exact byte-pinned
          // payloads once, and this per-item model call was the dominant slice
          // of the ~30-45s/email pace on the approved regression batch (the
          // judge-skip optimization covered the fidelity judges but forgot
          // this one).
          if (!skipItemJudge) {
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
      // `skipItemJudge` short-circuits: a certified-batch item's payload was
      // already judged at plan certification and byte-pinned at approval.
      if (!skipItemJudge && isGoalFidelityGateEnabled()) {
        const shape = classifyExternalWrite(tool.name, parsedInput);
        if (shape.mutating && shape.irreversible) {
          // Consume the concurrently-started judge (or run inline when the
          // parallel flag is off) — same verdict either way.
          const verdict = await (goalFidelityPromise ?? evaluateGoalFidelity(ctx.sessionId, tool.name, parsedInput));
          if (verdict.action === 'block') {
            verdict.commitFailure?.(); // commit the deferred failure bump only now that we actually surface it (#2.4)
            // JUDGE-FAIL APPROVAL (P0c): a JUDGE OUTAGE (not a genuine verdict)
            // that blocks an irreversible action mints a one-tap pending-approval
            // card for the EXACT call — never a silent refusal buried in the tool
            // result. A genuine GAP verdict keeps refusing exactly as before.
            const mintedPendingId = verdict.judgeUnavailable
              ? mintJudgeFailApproval({
                  sessionId: ctx.sessionId,
                  toolName: tool.name,
                  payload: parsedInput,
                  judge: 'goal-fidelity',
                  judgeFailureReason: verdict.reason,
                  targetSummary: verdict.targets.slice(0, 5).join(', '),
                })
              : null;
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
                  ...(verdict.judgeUnavailable ? { judgeUnavailable: true } : {}),
                  ...(mintedPendingId ? { pendingActionId: mintedPendingId, judgeFailApproval: true } : {}),
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
              ...(mintedPendingId ? { pendingActionId: mintedPendingId } : {}),
            });
          } else if (verdict.mode === 'advisory') {
            // Skill-less goal-alignment MISS → INFORM, do not block (north-star:
            // guardrails inform, rarely block; a hard block here false-positived a
            // legit self-send live 2026-06-22). The send PROCEEDS; record the
            // verdict (fulfills:false, advisory) + a warn-level guardrail so it
            // surfaces for review without breaking the send.
            try {
              appendEvent({
                sessionId: ctx.sessionId, turn: 0, role: 'system', type: 'goal_alignment_judged',
                data: { toolName: tool.name, fulfills: false, advisory: true, targets: verdict.targets.slice(0, 5), reason: verdict.reason },
              });
            } catch { /* telemetry write must never block */ }
            try {
              appendEvent({
                sessionId: ctx.sessionId, turn: 0, role: 'system', type: 'guardrail_tripped',
                data: { kind: 'goal_alignment_advisory', action: 'warn', toolName: tool.name, targets: verdict.targets.slice(0, 5), reason: verdict.reason },
              });
            } catch { /* telemetry write must never block */ }
          } else if (verdict.mode === 'judge') {
            // Aligned-proceed via the judge — otherwise silent. Emit a trace so a
            // YOLO silent-proceed is provably judge-vetted (the goal-alignment
            // fix: an irreversible write with a goal but no skill is now judged).
            // `reason` distinguishes a real pass from a fail-open. Telemetry only.
            try {
              appendEvent({
                sessionId: ctx.sessionId,
                turn: 0,
                role: 'system',
                type: 'goal_alignment_judged',
                data: {
                  toolName: tool.name,
                  fulfills: true,
                  targets: verdict.targets.slice(0, 5),
                  reason: verdict.reason,
                },
              });
            } catch { /* telemetry write must never block */ }
          }
        }
      }
    } catch (err) {
      if (err instanceof GoalFidelityCheckFailedError) throw err;
      // eslint-disable-next-line no-console
      console.warn('[harness] goal-fidelity gate threw (fail-open)', err instanceof Error ? err.message : err);
    }
    // 2c2.7. Output-grounding gate — NUMERIC integrity of the deliverable.
    // Grounding (2c2) checks the TARGET's identity; this checks the FIGURES in
    // the outgoing message body trace to the session's own captured tool
    // results. Same irreversible-only scope; a contradiction bounces (soft,
    // recoverable), a no-source figure proceeds with an advisory recorded.
    // Deterministic pre-pass first → frequently no judge call at all. Fail-open.
    try {
      // Skipped for a certified-batch item (same rationale as goal-fidelity).
      if (!skipItemJudge && isOutputGroundingGateEnabled()) {
        const shape = classifyExternalWrite(tool.name, parsedInput);
        if (shape.mutating && shape.irreversible) {
          const body = extractMessageBody(parsedInput);
          if (body && body.trim().length > 0) {
            const verdict = await (outputGroundingPromise ?? evaluateOutputGrounding(ctx.sessionId, body, { kind: 'write', toolName: tool.name }));
            if (verdict.action === 'bounce') {
              verdict.commitFailure?.(); // commit the deferred bounce bump only now that we surface it (#2.4)
              try {
                appendEvent({
                  sessionId: ctx.sessionId, turn: 0, role: 'system', type: 'guardrail_tripped',
                  data: { kind: 'output_grounding_blocked', toolName: tool.name, figures: verdict.figures.slice(0, 5), sources: verdict.sourceCallIds.slice(0, 5), reason: verdict.reason, failureCount: verdict.failureCount ?? 1 },
                });
              } catch { /* telemetry write must never block */ }
              throw new OutputGroundingCheckFailedError({
                toolName: tool.name, reason: verdict.reason, figures: verdict.figures, sourceCallIds: verdict.sourceCallIds, failureCount: verdict.failureCount ?? 1,
              });
            } else if (verdict.action === 'advisory') {
              try {
                appendEvent({
                  sessionId: ctx.sessionId, turn: 0, role: 'system', type: 'output_grounding_judged',
                  data: { toolName: tool.name, grounded: false, advisory: true, figures: verdict.figures.slice(0, 5), reason: verdict.reason },
                });
              } catch { /* telemetry write must never block */ }
            } else if (verdict.figures.length === 0 && verdict.reason.startsWith('every figure')) {
              try {
                appendEvent({
                  sessionId: ctx.sessionId, turn: 0, role: 'system', type: 'output_grounding_judged',
                  data: { toolName: tool.name, grounded: true, reason: verdict.reason },
                });
              } catch { /* telemetry write must never block */ }
            }
          }
        }
      }
    } catch (err) {
      if (err instanceof OutputGroundingCheckFailedError) throw err;
      // eslint-disable-next-line no-console
      console.warn('[harness] output-grounding gate threw (fail-open)', err instanceof Error ? err.message : err);
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
          const publishShape = classifyShellCommand(command);
          // PROVENANCE (2026-06-15 clobber): a publish to an EXPLICIT target that
          // was NOT created or named THIS session may be an unrelated live site
          // (a coffee-shop build deployed onto a law-firm site via a site id
          // reused from `netlify status` after `sites:create` failed). Hard-block.
          // Chat only, so recurring workflows reusing a stable site id are exempt.
          // Build provenance only for commands that can use it; that scan walks the
          // session transcript and must stay off ordinary shell-command hot paths.
          const sessionRow = publishShape.isPublish && publishShape.hasExplicitDestination
            ? getSession(ctx.sessionId)
            : null;
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
    // that composio/MCP sends get — the client-data/mailbox incident class, reachable
    // through shell. Classify only the CLEAR network-mutation shapes
    // (conservative; misses = status quo) and route them through the SAME
    // fail-open gates, reading the target from the command string. The
    // external_write ledger is SHARED so a shell re-send to the same target
    // bumps. Fail-open on any evaluation error.
    // PRE-WRITE LATENCY (shell vector): same concurrent-start as the composio
    // path above — fire the shell goal-fidelity + output-grounding judges now so
    // they overlap with shell grounding. Each is still awaited + fully handled in
    // its own block; startGate suppresses an unhandled rejection on a grounding
    // short-circuit. command + mutation are deterministic, recomputed identically
    // per block (cheap), so this changes only WHEN the model calls fire.
    const shellPreCommand = tool.name === 'run_shell_command' && typeof (parsedInput as { command?: unknown })?.command === 'string'
      ? (parsedInput as { command: string }).command : '';
    const shellPreMutation = shellPreCommand ? classifyShellNetworkMutation(shellPreCommand) : { isNetworkMutation: false as const };
    const shellPreShapeKey = shellPreMutation.isNetworkMutation ? shellPreMutation.shapeKey : undefined;
    const shellGoalFidelityPromise = (parallelGates && isGoalFidelityGateEnabled() && tool.name === 'run_shell_command' && shellPreMutation.isNetworkMutation && shellPreShapeKey)
      ? startGate(evaluateGoalFidelity(ctx.sessionId, tool.name, shellPreCommand, { deferCommit: true })) : null;
    const shellOutputGroundingPromise = (parallelGates && isOutputGroundingGateEnabled() && tool.name === 'run_shell_command' && shellPreMutation.isNetworkMutation && shellPreCommand)
      ? startGate(evaluateOutputGrounding(ctx.sessionId, shellPreCommand, { kind: 'write', toolName: tool.name, deferCommit: true })) : null;
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
                .map((ev) => ({ ...(ev.data as { shapeKey?: string; targets?: string[] }), at: ev.createdAt }));
              const failures = listEvents(ctx.sessionId, { types: ['external_write_failed'] })
                .map((ev) => ({ ...(ev.data as { shapeKey?: string; targets?: string[] }), at: ev.createdAt }));
              for (const failure of failures) {
                const ft = new Set((failure.targets ?? []).map((t) => String(t).toLowerCase()));
                const idx = priorWrites.findIndex((w) => w.shapeKey === failure.shapeKey
                  && (w.targets ?? []).some((t) => ft.has(String(t).toLowerCase())));
                if (idx >= 0) priorWrites.splice(idx, 1);
              }
            } catch { /* fail toward not-a-duplicate */ }
            const dup = detectDuplicateTarget({ sessionId: ctx.sessionId, shapeKey: mutation.shapeKey, targets: dupTargets, priorWrites });
            if (dup.duplicate) {
              // S2: a FRESH human approval naming this target (resolved after the
              // prior send) authorizes exactly this resend — the wall honors it.
              if (!duplicateResendConsented(ctx.sessionId, dup.target, dup.priorAt)) {
                throw new DuplicateExternalWriteError({ toolName: tool.name, shapeKey: mutation.shapeKey, target: dup.target ?? 'unknown' });
              }
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
          const verdict = await (shellGoalFidelityPromise ?? evaluateGoalFidelity(ctx.sessionId, tool.name, command));
          if (verdict.action === 'block') {
            verdict.commitFailure?.(); // commit the deferred failure bump only now that we surface it (#2.4)
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
    // 2c4.7. Shell SEND output-grounding — mirror of 2c2.7 for the shell
    // external-write vector (a curl POST / gh api carrying a report payload).
    // The command string is the deliverable text; the conservative extractor +
    // fail-open + contradiction-only-bounce keep flags/ports/ids from
    // false-tripping. Same contract as the composio path.
    try {
      if (isOutputGroundingGateEnabled() && tool.name === 'run_shell_command') {
        const command = typeof (parsedInput as { command?: unknown })?.command === 'string'
          ? (parsedInput as { command: string }).command
          : '';
        const mutation = command ? classifyShellNetworkMutation(command) : { isNetworkMutation: false as const };
        if (mutation.isNetworkMutation && command) {
          const verdict = await (shellOutputGroundingPromise ?? evaluateOutputGrounding(ctx.sessionId, command, { kind: 'write', toolName: tool.name }));
          if (verdict.action === 'bounce') {
            verdict.commitFailure?.(); // commit the deferred bounce bump only now that we surface it (#2.4)
            try {
              appendEvent({
                sessionId: ctx.sessionId, turn: 0, role: 'system', type: 'guardrail_tripped',
                data: { kind: 'output_grounding_blocked', toolName: tool.name, source: 'shell_send', figures: verdict.figures.slice(0, 5), sources: verdict.sourceCallIds.slice(0, 5), reason: verdict.reason, failureCount: verdict.failureCount ?? 1 },
              });
            } catch { /* telemetry must never block */ }
            throw new OutputGroundingCheckFailedError({
              toolName: tool.name, reason: verdict.reason, figures: verdict.figures, sourceCallIds: verdict.sourceCallIds, failureCount: verdict.failureCount ?? 1,
            });
          } else if (verdict.action === 'advisory') {
            try {
              appendEvent({
                sessionId: ctx.sessionId, turn: 0, role: 'system', type: 'output_grounding_judged',
                data: { toolName: tool.name, source: 'shell_send', grounded: false, advisory: true, figures: verdict.figures.slice(0, 5), reason: verdict.reason },
              });
            } catch { /* telemetry must never block */ }
          }
        }
      }
    } catch (err) {
      if (err instanceof OutputGroundingCheckFailedError) throw err;
      // eslint-disable-next-line no-console
      console.warn('[harness] shell-send output-grounding threw (fail-open)', err instanceof Error ? err.message : err);
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
        const shape = classifyExternalWrite(tool.name, parsedInput);
        // GLOBAL SEND FLOOR (2026-07-09 bypass hunt): an IRREVERSIBLE send/
        // publish batch gates on EVERY session kind — chat, workflow,
        // execution (background/cron), agent (worker fan-out). The batch-
        // consent floor is a property of the ACTION, not the chat surface; the
        // chat-only guard let workflow default-scope sends and run_worker
        // fan-out reconstitute the unapproved-batch incident on other lanes.
        // Reversible writes stay chat-scoped (the 2026-05-30 anti-deadlock
        // rationale below) so capable non-chat runs aren't wedged on undoable
        // edits.
        const gateThisSession = sessionRow?.kind === 'chat' || shape.irreversible;
        if (gateThisSession && shape.mutating && shape.shapeKey) {
          // Irreversible sends run the count→decide→append critical section
          // under a per-session lock so a concurrent fan-out can't all read a
          // stale count (Hole 4); reversible writes don't need it.
          const runCriticalSection = async (): Promise<void> => {
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
            // everything except the hard danger denylist"). For REVERSIBLE
            // writes the 2026-06-02 rationale stands: this approval gate is
            // pure friction under YOLO — skip it, still RECORD the write.
            // But YOLO never extends to an IRREVERSIBLE batch (2026-07-09,
            // Ask-first regression: yolo waved 10 outbound emails through while
            // batchConfirmThreshold sat unread). Irreversible batches at/over
            // the threshold require ONE reviewed approval regardless of scope.
            const yoloStandingApproval = policy.autoApproveScope === 'yolo' && !shape.irreversible;

            // A certified batch item executes a HUMAN-approved, byte-pinned
            // plan (run_batch: approval pins the payload hash; the yolo
            // auto-approve hole at the request_approval surface is closed in
            // orchestrator.ts) — that approval IS the reviewed plan, so the
            // gate is satisfied without a separate plan scope.
            const approvedCertifiedBatch = Boolean(ctx.certifiedBatch);

            // An instruction-reviewed plan scope satisfies the gate — but for
            // an IRREVERSIBLE send, only a scope that ENUMERATED the send
            // (goalScoped + allowedSends) counts. A bare wildcard `['*']` scope
            // (opened by the workflow/background lanes) must NOT satisfy the
            // send floor (2026-07-09 Hole 2); it still satisfies reversible
            // writes as before.
            const { getPlanScope } = await import('../../agents/plan-scope.js');
            const scope = getPlanScope(ctx.sessionId);
            const scopeOpen = !!scope && !scope.closedAt;
            // For an irreversible send, a scope only counts as reviewed if it
            // EXPLICITLY covers the send — enumerated in allowedSends, or the
            // tool/slug named (NOT via wildcard '*') in allowedTools. A bare
            // `['*']` scope (workflow/background launch) does not (Hole 2).
            // Reversible writes keep the any-open-scope behavior.
            const { isUngrantableMultiplexer } = await import('../../agents/plan-scope.js');
            const hasReviewedScope = shape.irreversible
              ? Boolean(scopeOpen && scope && (
                  // The slug (shapeKey) enumerated in the scope's send/slug lists.
                  (scope.allowedSends ?? []).some((s) => s === shape.shapeKey)
                  || (scope.allowedComposioSlugs ?? []).some((s) => s === shape.shapeKey)
                  // OR a NON-multiplexer send tool named directly (native MCP).
                  // The composio gateway name never counts (Hole A).
                  || (!isUngrantableMultiplexer(tool.name) && scope.allowedTools.includes(tool.name))
                ))
              : scopeOpen;

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

            if (!yoloStandingApproval && !approvedCertifiedBatch && review.required && severityRequiresGate && !hasReviewedScope) {
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
          };
          // Serialize irreversible sends per session (Hole 4); reversible
          // writes run directly (no batch-consent race to protect).
          if (shape.irreversible) await withSendGateLock(ctx.sessionId, runCriticalSection);
          else await runCriticalSection();
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
    // Inc A2 — mid-runTurn background-offer nudge. Once this runTurn has made
    // enough tool calls in a FOREGROUND chat without offering/dispatching, append
    // a one-time "offer to move this to the background" nudge so the model reads
    // it mid-grind. Evaluated AT MOST once per runTurn (ctx flag); skipped in
    // worker scopes, non-chat sessions, and once an offer was already posted.
    let bgOfferNudge: string | undefined;
    if (
      !ctx.backgroundOfferNudged
      && !ctx.suppressBackgroundOffer
      && backgroundOfferNudgeEnabled()
      && !ctx.guardrailScopeId
      && ctx.counter.calls >= BACKGROUND_OFFER_NUDGE_MIN_TOOLS
    ) {
      ctx.backgroundOfferNudged = true; // evaluate the (slightly heavier) checks once per runTurn
      try {
        if (
          !ctx.sessionId.startsWith('background:')
          && getSession(ctx.sessionId)?.kind === 'chat'
          && !sessionHasBackgroundOffer(ctx.sessionId)
        ) {
          bgOfferNudge =
            '[background offer] You have already made several tool calls on this in the foreground while the user waits. '
            + 'If finishing will take more than a step or two, ASK the user in one plain sentence whether to move it to the background (dispatch_background_task on their yes) or hold it for later — then STOP. '
            + 'If you are nearly done (a step or two left), just finish; do not offer.';
        }
      } catch { /* advisory only — never block the tool */ }
    }
    // WORKER FINISH WINDOW (2026-07-22): a worker one call from its ceiling
    // gets a wrap-up notice ON this result instead of a guillotine on the
    // next — productive partial work lands as an honest partial answer
    // rather than evaporating into a bare cap error ("I would hate to waste
    // anything if a worker was actually being productive"). Worker scopes
    // only (`::wkr:` / `::sdkx:`); the interactive lane has its own economy.
    let workerFinishNudge: string | undefined;
    if (
      ctx.guardrailScopeId
      && /::(wkr|sdkx):/.test(ctx.guardrailScopeId)
      && ctx.counter.calls >= ctx.counter.limit - 1
    ) {
      workerFinishNudge =
        '[finish window] That was your LAST free tool call for this item — further calls will be refused. '
        + 'Return your best result NOW as your final answer. A partial result with honest gaps beats nothing: '
        + 'include everything you gathered, and mark anything missing with an "ERROR: <what is missing>" line.';
    }
    // All nudges ride the same advisory rail (appended to the tool result by the
    // caller). Combine so a turn that trips several still delivers each.
    const nudges = [fanoutNudge, cacheNudge, bgOfferNudge, workerFinishNudge].filter(Boolean);
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

  const claimArtifact = (
    ctx: HarnessRunContext | undefined,
    parsedInput: unknown,
    callId?: string,
  ): { dispatch?: ArtifactDispatch; deny?: string } => {
    const sessionId = ctx?.sessionId;
    if (!sessionId) return {};
    // Batch items (certified or not) never claim artifact slots: the batch
    // lane is the sanctioned multi-item primitive with its own per-item
    // ledger — N same-kind creates in one plan would fight over the single
    // deliverable slot and deadlock item 2+ (2026-07-22, surfaced live by
    // the generic classifier).
    if (ctx.certifiedBatch || ctx.batchItem) return {};
    const rawIntent = artifactIntentForTool(tool.name, parsedInput);
    if (!rawIntent) return {};
    const attemptScopeId = guardrailScopeKey(ctx);
    const runScopeId = resolveArtifactRunScopeId(sessionId, attemptScopeId, ctx.sourceUserSeq);
    const recordedObjective = artifactObjectiveForRunScope(sessionId, runScopeId);
    const intent = scopeArtifactIntentForObjective(
      rawIntent,
      effectiveTurnObjective(sessionId, recordedObjective, ctx.sourceUserSeq),
      parsedInput,
    );
    const claim = claimArtifactSlot(sessionId, intent, callId, runScopeId);
    if (!claim.acquired) return { deny: artifactReuseMessage(claim.artifact) };
    return { dispatch: { sessionId, runScopeId, artifactId: claim.artifact.id, intent, callId } };
  };
  const settleArtifact = (
    dispatch: ArtifactDispatch | undefined,
    result: unknown,
    shellOutcome?: ShellExecutionOutcome,
  ): void => {
    if (!dispatch) return;
    try {
      if (artifactOutputProvesNoDispatch(result, shellOutcome)) {
        releaseClaimedArtifact(dispatch.artifactId, dispatch.callId);
        return;
      }
      const resource = extractArtifactResource(dispatch.intent, result);
      if (resource) {
        bindClaimedArtifact(dispatch.artifactId, dispatch.callId, resource);
      } else {
        markClaimedArtifactUncertain(dispatch.artifactId, dispatch.callId);
      }
    } catch {
      // The provider may already have created the resource. A ledger failure can
      // never make a blind retry safe, so leave/mark the slot uncertain.
      try { markClaimedArtifactUncertain(dispatch.artifactId, dispatch.callId); } catch { /* fail closed via durable pending claim */ }
    }
  };
  const failArtifact = (
    dispatch: ArtifactDispatch | undefined,
    shellOutcome?: ShellExecutionOutcome,
  ): void => {
    if (!dispatch) return;
    if (shellOutcome?.effect === 'none' || shellOutcome?.dispatch === 'not_started') {
      try { releaseClaimedArtifact(dispatch.artifactId, dispatch.callId); } catch { /* keep pending fail-closed */ }
      return;
    }
    try { markClaimedArtifactUncertain(dispatch.artifactId, dispatch.callId); } catch { /* pending claim still blocks retries */ }
  };
  const releaseUndispatchedArtifact = (dispatch: ArtifactDispatch | undefined): void => {
    if (!dispatch) return;
    try { releaseClaimedArtifact(dispatch.artifactId, dispatch.callId); } catch { /* keep the pending claim fail-closed */ }
  };
  const settleArtifactReadback = (
    ctx: HarnessRunContext | undefined,
    parsedInput: unknown,
    result: unknown,
    callId?: string,
  ): void => {
    if (!ctx?.sessionId) return;
    // Most tool results are unrelated to durable artifacts. Classify before
    // resolving lineage: resolveArtifactRunScopeId persists a root mapping, so
    // calling it unconditionally made every ordinary read/build/tool result
    // appear to participate in artifact history. Real exact-provider readbacks
    // still resolve the root and run the strict ID-matching verifier below.
    if (!artifactVerificationIntentForTool(tool.name, parsedInput)) return;
    try {
      verifyArtifactBindingFromToolResult(
        ctx.sessionId,
        resolveArtifactRunScopeId(ctx.sessionId, guardrailScopeKey(ctx), ctx.sourceUserSeq),
        tool.name,
        parsedInput,
        result,
        callId,
      );
    } catch {
      // Verification bookkeeping is fail-closed for completion (the row stays
      // unverified) but must never turn a successful provider read into a tool
      // failure for the model/user.
    }
  };

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
      // Layer 1 — structural prevention. Bind $fromToolOutput references to REAL
      // values from the lossless store BEFORE gates + execution, so a high-stakes
      // field comes from a trusted source, never model-authored text (the class of
      // the 2026-07-19 fabricated-recipients incident). No-op for every call
      // without the syntax (all traffic today). Fail-closed: an unresolvable
      // reference returns a soft, recoverable error and the tool does NOT run.
      if (toolOutputReferenceResolutionEnabled() && hasToolOutputReference(parsedInput)) {
        const refResolution = resolveToolOutputReferences(ctx?.sessionId ?? '', parsedInput);
        if (refResolution.errors.length > 0) {
          return JSON.stringify({
            error: 'reference_resolution_failed',
            detail: refResolution.errors.join('; '),
            hint: 'Point $fromToolOutput at a real prior tool result (its call_id + a path to the values), or pass the values directly.',
          });
        }
        parsedInput = refResolution.resolved;
        input = typeof input === 'string' ? JSON.stringify(refResolution.resolved) : refResolution.resolved;
      }
      let fanoutNudge: string | undefined;
      let artifact: ArtifactAdmission = {};
      try {
        fanoutNudge = await runBrackets(ctx?.sessionId ?? '', parsedInput, invokeCallId, () => {
          artifact = claimArtifact(ctx, parsedInput, invokeCallId);
          return artifact;
        });
      } catch (err) {
        // No provider code has run yet. A bracket refusal after acquisition is
        // proven non-dispatch, so the slot is safe to release; a duplicate
        // refusal acquired nothing and leaves the authoritative row untouched.
        releaseUndispatchedArtifact(artifact.dispatch);
        if (err instanceof ArtifactReuseDenied) return err.reuseMessage;
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
      const invokeOnce = () => {
        // S3 abort-on-timeout: a per-invocation controller whose signal rides the
        // ALS into the tool's fetch layer (Composio merges it via AbortSignal.any).
        // onTimeout → ac.abort() so a timed-out call is CANCELLED at the network
        // layer instead of running on and burning provider credits.
        const ac = new AbortController();
        const start = () => originalInvoke.call(tt, runContext, input, details);
        const work = runWithToolAbortSignal(ac.signal, start);
        return withTimeout(
          work,
          timeoutMs,
          tool.name,
          {
            isPaused: isPausedFactory(ctx?.sessionId),
            onTimeout: () => ac.abort(new ToolTimeout(tool.name, timeoutMs)),
          },
        );
      };
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
        const shellOutcome = tool.name === 'run_shell_command'
          ? takeShellExecutionOutcome(invokeCallId)
          : undefined;
        settleArtifact(artifact.dispatch, result, shellOutcome);
        settleArtifactReadback(ctx, parsedInput, result, invokeCallId);
        compensateFailedExternalWrite(ctx?.sessionId, tool.name, parsedInput, result, shellOutcome);
        recordPublishIfSucceeded(tool.name, parsedInput, result, shellOutcome);
        creditRecallFromToolResult(ctx?.sessionId, tool.name, parsedInput, result, shellOutcome);
        return result;
      }, (err) => {
        const shellOutcome = tool.name === 'run_shell_command'
          ? takeShellExecutionOutcome(invokeCallId)
          : undefined;
        failArtifact(artifact.dispatch, shellOutcome);
        compensateFailedExternalWrite(ctx?.sessionId, tool.name, parsedInput, err, shellOutcome);
        throw err;
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
      // GENERAL long-job timeout self-correction. A withTimeout kill of an
      // external-API / long-running-job tool (Composio static + cx_*, external_api_*,
      // MCP __) means "the upstream job exceeded even its generous budget" — the live
      // 2026-06-24 Apify case. Return the async start+poll corrective (reads) or the
      // verify-before-retry corrective (writes) as the tool RESULT instead of letting
      // ToolTimeout propagate to handleRunError's ask-user "retry/switch/stop" pause —
      // so the model self-corrects within the SAME run, generalizing the run_worker
      // precedent above to the broader class. Internal default-60s tools, shell, and
      // draft_plan are NOT in the class: their timeout is a real hang/flake the loop's
      // ask-user card should still surface, so they keep propagating. NOTE on the
      // orphaned call: withTimeout rejects with ToolTimeout and the outer promise
      // STAYS rejected, so when the underlying call finishes later its resolve() is a
      // no-op (promises settle once). The bookkeeping .then() on invokePromise
      // therefore does NOT run on a timeout and the late result is discarded.
      // Consequence for a WRITE: a timed-out write that lands late is recorded NOWHERE
      // (no recordPublish), so the verify-before-retry corrective's read-back is the
      // ONLY dup protection — there is no ledger backstop. (A true fix is
      // AbortController cancellation.)
      if (isTimeoutSelfCorrectTool(tool.name)) {
        try {
          const result = await invokePromise;
          // Preserve the fan-out nudge append on the success path so this block is
          // fully equivalent to the generic path below for non-timeout outcomes.
          if (fanoutNudge) {
            return typeof result === 'string' ? `${result}\n\n${fanoutNudge}` : result;
          }
          return result;
        } catch (err) {
          if (err instanceof ToolTimeout) {
            // S3 orphan ledger: a mutating write in this long-job class timed out
            // and may have landed — record it before self-correcting. No-ops for reads.
            recordExternalWriteOrphan(ctx?.sessionId, tool.name, parsedInput, timeoutMs);
            return timeoutCorrectiveFor(tool.name, parsedInput, timeoutMs);
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
    // Layer 1 — bind $fromToolOutput references to real store values before gates
    // + execution (mirror of the invoke path). No-op without the syntax.
    if (toolOutputReferenceResolutionEnabled() && hasToolOutputReference(input)) {
      const refResolution = resolveToolOutputReferences(ctx?.sessionId ?? '', input);
      if (refResolution.errors.length > 0) {
        return JSON.stringify({
          error: 'reference_resolution_failed',
          detail: refResolution.errors.join('; '),
          hint: 'Point $fromToolOutput at a real prior tool result (its call_id + a path to the values), or pass the values directly.',
        });
      }
      input = refResolution.resolved;
    }
    let fanoutNudge: string | undefined;
    let artifact: ArtifactAdmission = {};
    try {
      fanoutNudge = await runBrackets(ctx?.sessionId ?? '', input, undefined, () => {
        artifact = claimArtifact(ctx, input);
        return artifact;
      });
    } catch (err) {
      releaseUndispatchedArtifact(artifact.dispatch);
      if (err instanceof ArtifactReuseDenied) return err.reuseMessage;
      // SAME disposition as wrappedInvoke above: a recoverable gate throw becomes
      // a soft tool error here too (this path had NO try/catch, so a typed gate
      // throw aborted the run purely because the tool used `execute` not `invoke`).
      const soft = softToolError(err);
      if (soft !== null) return soft;
      throw err;
    }
    let result: unknown;
    try {
      // S3 abort-on-timeout (legacy execute twin — mirrors the invoke path above).
      const ac = new AbortController();
      const start = () => originalExecute(input, runContext);
      const work = runWithToolAbortSignal(ac.signal, start);
      result = await withTimeout(
        work,
        timeoutMs,
        tool.name,
        {
          isPaused: isPausedFactory(ctx?.sessionId),
          onTimeout: () => ac.abort(new ToolTimeout(tool.name, timeoutMs)),
        },
      );
    } catch (err) {
      failArtifact(artifact.dispatch);
      // Same general self-correction as the invoke path: a long-job timeout on an
      // external-API / MCP tool returns the async/verify corrective as the result
      // (run continues) instead of propagating ToolTimeout to the ask-user pause.
      // Non-class tools (internal-60s, shell, draft_plan) keep propagating.
      if (err instanceof ToolTimeout && isTimeoutSelfCorrectTool(tool.name)) {
        // S3 orphan ledger — mirrors the invoke path (records a maybe-landed
        // write before self-correcting). No-ops for reads.
        recordExternalWriteOrphan(ctx?.sessionId, tool.name, input, timeoutMs);
        return timeoutCorrectiveFor(tool.name, input, timeoutMs);
      }
      throw err;
    }
    settleArtifact(artifact.dispatch, result);
    settleArtifactReadback(ctx, input, result);
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
    err instanceof RecipientSetIntegrityError ||
    err instanceof GoalFidelityCheckFailedError ||
    err instanceof OutputGroundingCheckFailedError ||
    err instanceof DuplicateExternalWriteError ||
    err instanceof OrphanedWriteRetryError ||
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
