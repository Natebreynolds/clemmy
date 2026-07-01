/**
 * debate-model — the first slice of the Codex+Claude FUSION layer.
 *
 * Two flagship brains (Claude Opus + Codex gpt-5.x) draft the SAME turn
 * independently; a judge brain then reconciles both drafts into one final
 * answer that is streamed back to the user. Goal: higher accuracy on the turns
 * that matter, by making the answer the product of two models in tandem rather
 * than one.
 *
 * This is "Seam A — debate the ANSWER": a transparent `Model` wrapper slotted at
 * provider-registration time (codex-client.ts), so the rest of the harness loop
 * never knows it's special. (Seam B — two brains sanity-check an irreversible
 * SEND/PUBLISH at the write boundary — is the natural fast-follow and reuses the
 * existing gate signal in confirm-first-gate.ts.)
 *
 * Cost control: a debate is 2 drafts + 1 judge ≈ 2–3× tokens, so it must NOT
 * fire on every turn. `shouldDebate(request)` gates it; `CLEMMY_DEBATE_MODE`
 * selects the policy and DEFAULTS TO OFF (this is a measurement scaffold, not a
 * permanent flag — once an accuracy lift is shown it flips to high-stakes-only,
 * then the flag retires).
 *
 *   CLEMMY_DEBATE_MODE = off   (default)  never debate — pure passthrough
 *                      = high             debate only "high-stakes" turns (heuristic)
 *                      = all              debate every turn (for live end-to-end proving)
 *
 * Reliability:
 *  - Each draft brain is already individually resilient (retry/backoff/empty/401
 *    via resilient-model; Codex has its own transparent SSE retry), so a draft
 *    rejection here is POST-retry exhaustion. We fail OPEN: drop the failed brain
 *    and answer from the survivor; only if BOTH fail do we surface (passthrough).
 *  - Streaming safety: the silent drafting window is bridged with benign `model`
 *    keep-alive frames (the same shape codex-model emits) so the loop's
 *    pre-content stall watchdog sees activity. NO `output_text_delta` (the only
 *    "committed content" frame) is emitted until the judge streams — so nothing
 *    the user sees can ever be contradicted or duplicated by the reconciliation.
 */
import type { Model, ModelProvider, ModelRequest, ModelResponse } from '@openai/agents-core';
import type { StreamEvent } from '@openai/agents-core/types';
import { getRuntimeEnv, getActiveAuthMode, getClaudeBrainModel, getDebateCheckerModel, getByoBackendConfig, judgeChoice, MODELS } from '../../config.js';
import { ClaudeModelProvider } from './claude-model.js';
import { CodexModelProvider } from './codex-model.js';
import { getByoModel } from './byo-model.js';
import { resolveByoProviderForModel } from './byo-providers.js';
import { classifyTurnIntent } from './turn-intent.js';
import { resolveRoleModel, codexSafeFast, type ResolvedRoleModel } from './model-roles.js';
import type { ModelProviderClass } from './model-wire-registry.js';
import {
  claudeAvailable,
  codexAvailable,
  debateBrainsAvailable,
  judgeCrossFamilyEnabled,
  chooseBoundaryJudgeFamily,
  boundaryCodexJudgeModel,
} from './judge-family.js';
// Re-exported from the judge-family leaf (moved out of this file) so existing
// importers of debate-model keep working: console-routes (debateBrainsAvailable),
// boundary-judge.test (chooseBoundaryJudgeFamily), and any judgeCrossFamilyEnabled use.
export { debateBrainsAvailable, judgeCrossFamilyEnabled, chooseBoundaryJudgeFamily };
import { harnessRunContextStorage } from './brackets.js';
import { recordOperationalEvent } from '../operational-telemetry.js';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import pino from 'pino';

const logger = pino({ name: 'clementine.debate-model' });

export type DebateMode = 'off' | 'high' | 'all';

/** Read CLEMMY_DEBATE_MODE. Default OFF — fusion debate is opt-in until measured. */
export function debateMode(): DebateMode {
  const raw = (getRuntimeEnv('CLEMMY_DEBATE_MODE', 'off') || 'off').trim().toLowerCase();
  if (raw === 'all' || raw === 'on' || raw === 'always') return 'all';
  if (raw === 'high' || raw === 'high_stakes' || raw === 'auto') return 'high';
  return 'off';
}

export function isDebateModeEnabled(): boolean {
  return debateMode() !== 'off';
}

/** Which brain reconciles the two drafts. Default Claude — a strong synthesizer. */
// judgeChoice now lives in config.ts (so the role→model registry can read it
// without a circular import); re-exported here for existing consumers.
export { judgeChoice };

/** Keep-alive cadence for the silent drafting window (ms). Well under the 75s
 *  pre-content stall ceiling, so a pathologically slow draft can't be abandoned. */
function heartbeatMs(): number {
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_DEBATE_HEARTBEAT_MS', '10000') ?? '10000', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 10000;
}

/** Once the FIRST draft lands, how long to wait for the second before proceeding
 *  with what we have. Stops a slow/flaky brain (exhausting its own retry budget)
 *  from holding the whole turn hostage — observed live: Claude transport-timeout
 *  retried ~90s while Codex was ready in seconds. 0 disables (single draft). */
function draftGraceMs(): number {
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_DEBATE_DRAFT_GRACE_MS', '25000') ?? '25000', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 25000;
}

/** Deadline (ms) for the verify CHECKER's first event. The executor's draft is
 *  already in hand (the safety net), so a hung/slow checker — Anthropic at
 *  capacity HANGS rather than returning a clean 529 — must not block the turn
 *  waiting out the retry budget. Past this, ship the executor draft. */
function checkerDeadlineMs(): number {
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_DEBATE_CHECKER_DEADLINE_MS', '25000') ?? '25000', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 25000;
}

/** Max debated iterations per user MESSAGE. The AUTHORITY is the per-turn WeakMap
 *  keyed by the active ToolCallsCounter (see spendFusionSlot) — that survives
 *  regardless of model-instance lifetime (the SDK may resolve the model per step,
 *  not once per run, so a per-instance counter would under-count). The
 *  per-instance counter is only a fallback when no harness ALS is present (tests).
 *
 *  WHY: debating EVERY loop iteration is the core cost blowup — a 10-iteration
 *  agentic turn = 10×(2 drafts + judge) ≈ 30 calls. The research is one-sided
 *  that debating intermediate tool-routing steps is net-negative (3-5× cost,
 *  often WORSE accuracy from correct→wrong flips). Cap it so the multi-model
 *  budget is spent on the first few high-value decisions, then run single-brain;
 *  irreversible writes are still verified by the grounding/goal-fidelity gates.
 *  0 = unlimited (legacy behavior). */
function maxDebatesPerTurn(): number {
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_DEBATE_MAX_PER_TURN', '2') ?? '2', 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 2;
}

export type FusionStrategy = 'debate' | 'verify';
/** How a fused turn spends its two brains:
 *  - 'debate' (default): both flagships draft independently, a judge reconciles (3 calls).
 *  - 'verify' ("Codex drives, Claude checks"): the EXECUTOR (the passthrough/active
 *    brain) drafts once, then the CHECKER (the judge brain) verifies/refines into the
 *    final answer (2 calls). Cheaper, and the research-optimal verify-over-redraft
 *    pattern. Pair with active-brain=Codex + judge=Claude for the recommended play. */
export function fusionStrategy(): FusionStrategy {
  return (getRuntimeEnv('CLEMMY_FUSION_STRATEGY', 'debate') || 'debate').trim().toLowerCase() === 'verify'
    ? 'verify'
    : 'debate';
}

// Per-message debate counts keyed by the ACTIVE TURN's counter object (a fresh
// ToolCallsCounter per runTurn, installed in AsyncLocalStorage around the SDK's
// run() and shared across all of that message's internal loop iterations). This
// is the reliable per-message key — the DebateModel instance does NOT always
// persist across iterations, so a per-instance counter under-counts. WeakMap →
// entries auto-GC when the turn ends (no leak). Falls back to per-instance when
// there's no harness ALS (unit tests / non-harness callers).
const debateCountByTurn = new WeakMap<object, number>();
function activeTurnKey(): object | undefined {
  try {
    return harnessRunContextStorage.getStore()?.counter as unknown as object | undefined;
  } catch {
    return undefined;
  }
}

/** True inside a run_worker / fan-out sub-agent (the harness sets guardrailScopeId
 *  ONLY for those). Fusion must skip workers: they ARE the delegated execution
 *  (run on the executor brain), they don't produce the user-facing answer, and —
 *  since they share the orchestrator's ToolCallsCounter — fusing them would burn
 *  the per-message verify budget. So a worker turn always runs single-brain. */
function isWorkerScope(): boolean {
  try {
    return harnessRunContextStorage.getStore()?.guardrailScopeId != null;
  } catch {
    return false;
  }
}

/** Consequential / irreversible-action verbs — the signal that a turn is
 *  high-stakes enough to spend the Claude checker on. Word-boundary,
 *  case-insensitive. (Bare nouns like "proposal"/"invoice" are deliberately NOT
 *  triggers — they fire on pure drafting/research; only the action verbs do.) */
// Irreversible-action keyword detection now lives in the shared turn-intent
// classifier (the single source of truth, reused by the context packet too).
/** The CONTINUATION_INPUT sentinel (loop.ts) — a mid-execution re-loop nudge, not
 *  a fresh ask; a continuation falls to the goal signal, not the nudge text. */
const CONTINUATION_PREFIX_RE = /^Continue with the next step of your plan/;

/** v2 selective high-stakes heuristic (default-on). Off ⇒ the legacy byte-length
 *  proxy (which over-fired on the injected context packet → mode=high≈mode=all). */
function stakesV2Enabled(): boolean {
  return (getRuntimeEnv('CLEMMY_DEBATE_STAKES_V2', 'on') ?? 'on').toLowerCase() !== 'off';
}

/** Extract one input item's text (content string / array-of-{text} / .text). */
function extractItemText(item: unknown): string {
  const it = item as { content?: unknown; text?: unknown };
  if (typeof it.content === 'string') return it.content;
  if (Array.isArray(it.content)) {
    const parts: string[] = [];
    for (const c of it.content) {
      const cc = c as { text?: unknown };
      if (typeof cc.text === 'string') parts.push(cc.text);
    }
    return parts.join(' ');
  }
  if (typeof it.text === 'string') return it.text;
  return '';
}

/** The LATEST role:'user' message — the actual ask for THIS turn. The user item
 *  sits in the MIDDLE of request.input: the harness appends role:'system' items
 *  (the [AGENT CONTEXT PACKET], memory primer, goal block) AFTER it (loop.ts), so
 *  we take the last user item BY INDEX (scanning from the tail), NOT a trailing
 *  run — else the appended system items would mask the user text and under-fire. */
function renderLatestUserText(request: ModelRequest): string {
  const input = (request as { input?: unknown }).input;
  if (typeof input === 'string') return input;
  if (!Array.isArray(input)) return '';
  for (let i = input.length - 1; i >= 0; i -= 1) {
    if ((input[i] as { role?: unknown })?.role === 'user') return extractItemText(input[i]);
  }
  return '';
}

/** ONLY the "Objective:" line of the injected [ACTIVE GOAL …] block — so a
 *  continuation turn can be judged on whether the run is ABOUT to do an
 *  irreversible action, WITHOUT re-scanning the context-packet boilerplate (its
 *  prose contains "sends"/"run") or the goal's past-tense "Progress so far" ledger. */
function renderActiveGoalObjective(request: ModelRequest): string {
  const input = (request as { input?: unknown }).input;
  if (!Array.isArray(input)) return '';
  for (const item of input) {
    if ((item as { role?: unknown })?.role !== 'system') continue;
    const text = extractItemText(item);
    if (!text.startsWith('[ACTIVE GOAL')) continue;
    return text.split('\n').find((l) => l.startsWith('Objective:')) ?? '';
  }
  return '';
}

/** High-stakes heuristic for mode=high — "minimal Claude, only the consequential
 *  turns." Reads ROLES, not bytes: the v1 proxy over-fired because it measured the
 *  injected system context packet (which alone exceeds 800 chars), not the
 *  request. Fires when the user's latest message names a consequential action, is
 *  genuinely long/complex, or — on a mid-execution continuation — the active
 *  goal's Objective involves an irreversible action. NOTE: the raw send TOOL-CALL
 *  turn (no assistant text) is NOT checked here — verify gates on a user-facing
 *  answer (hasUserFacingAnswer), and that write boundary is owned by the grounding
 *  / goal-fidelity gates. Fusion checks the planning/approval ANSWER turn. */
function isHighStakes(request: ModelRequest): boolean {
  if (!stakesV2Enabled()) return legacyIsHighStakes(request);
  const userText = renderLatestUserText(request);
  const isContinuation = CONTINUATION_PREFIX_RE.test(userText.trim());
  if (!isContinuation) {
    if (classifyTurnIntent(userText) === 'action') return true;
    if (userText.length >= 800) return true;
    const tools = (request as { tools?: unknown[] }).tools;
    if (Array.isArray(tools) && tools.length > 0 && userText.length >= 200) return true;
  }
  // continuation OR no user-text hit → judge by the pending goal's Objective.
  return classifyTurnIntent(renderActiveGoalObjective(request)) === 'action';
}

export function shouldDebate(request: ModelRequest): boolean {
  // Structured-output turns are machine contracts (planner/orchestrator
  // decisions, gates, classifiers). A fusion checker/judge can improve prose,
  // but if it rewrites a schema-bound JSON answer into natural language the SDK
  // rejects the turn as "Invalid output type". Keep these on the provider's
  // native structured-output path; fuse only user-facing prose/tool turns.
  if (isStructuredOutputRequest(request)) return false;
  const mode = debateMode();
  if (mode === 'off') return false;
  if (mode === 'all') return true;
  return isHighStakes(request);
}

function isStructuredOutputRequest(request: ModelRequest): boolean {
  const outputType = (request as { outputType?: unknown }).outputType;
  return outputType !== undefined && outputType !== null && outputType !== 'text';
}

/** LEGACY high-stakes proxy (CLEMMY_DEBATE_STAKES_V2=off only): flatten ALL input
 *  text and trip on length/keywords. Over-fires — the role:system context packet
 *  alone routinely exceeds 800 chars, so mode=high collapses to mode=all. Kept
 *  solely as the kill-switch fallback. */
function legacyIsHighStakes(request: ModelRequest): boolean {
  const text = renderRequestText(request);
  if (text.length >= 800) return true;
  const tools = (request as { tools?: unknown[] }).tools;
  if (Array.isArray(tools) && tools.length > 0 && text.length >= 200) return true;
  return /\b(send|publish|deploy|delete|migrate|launch|production|irreversible|invoice|contract|proposal)\b/i.test(text);
}

function renderRequestText(request: ModelRequest): string {
  const input = (request as { input?: unknown }).input;
  if (typeof input === 'string') return input;
  if (!Array.isArray(input)) return '';
  return input.map(extractItemText).join(' ');
}

function judgeTraceLabel(): string {
  const r = resolveRoleModel('judge');
  return `${r.provider}:${r.modelId}`;
}

/** Some ModelProviders may return Model | Promise<Model>; every in-repo provider
 *  (Claude/Codex/Router) resolves synchronously, which debate relies on. */
function resolveSync(m: Model | Promise<Model>): Model {
  if (m && typeof (m as { then?: unknown }).then === 'function') {
    throw new Error('debate: passthrough provider returned an async Model — unsupported by the fusion layer');
  }
  return m as Model;
}

const DEADLINE = Symbol('deadline');

function raceDeadline<T>(work: Promise<T>, deadlineMs: number): Promise<T | typeof DEADLINE> {
  // If the deadline wins, keep the loser observed so a late rejection cannot
  // surface as an unhandled promise after we've already shipped the safe draft.
  work.catch(() => {});
  return new Promise<T | typeof DEADLINE>((resolve, reject) => {
    const timer = setTimeout(() => resolve(DEADLINE), deadlineMs);
    work.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

function linkedAbortRequest(request: ModelRequest): { request: ModelRequest; abort: () => void; cleanup: () => void } {
  const parent = (request as { signal?: AbortSignal }).signal;
  const controller = new AbortController();
  const abort = () => controller.abort();
  const onParentAbort = () => controller.abort();
  if (parent) {
    if (parent.aborted) controller.abort();
    else parent.addEventListener('abort', onParentAbort, { once: true });
  }
  return {
    request: { ...request, signal: controller.signal } as ModelRequest,
    abort,
    cleanup: () => { if (parent) parent.removeEventListener('abort', onParentAbort); },
  };
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

export interface DebateBrains {
  /** The normal brain — answers any turn that is NOT debated (byte-identical path). */
  passthrough: Model;
  /** First flagship draft (e.g. Claude Opus). */
  draftA: Model;
  /** Second flagship draft (e.g. Codex gpt-5.x). */
  draftB: Model;
  /** Reconciles the two drafts into the final answer. */
  judge: Model;
}

export interface DebateOptions {
  heartbeatMs?: number;
  /** Grace window (ms) for the second draft after the first lands. */
  draftGraceMs?: number;
  /** Deadline (ms) for the verify checker's first event before shipping the draft. */
  checkerDeadlineMs?: number;
  /** Max debated iterations per message (0 = unlimited). */
  maxPerTurn?: number;
  /** Fuse the NON-streamed getResponse path too. Default false: in the harness,
   *  the user-facing orchestrator always STREAMS (getStreamedResponse), while
   *  getResponse is internal sub-calls (memory consolidation, gates, judges) that
   *  must NOT consume the fusion budget. Tests set this to exercise the logic
   *  through getResponse. */
  fuseNonStreamed?: boolean;
  /** Injected for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

export class DebateModel implements Model {
  constructor(private readonly brains: DebateBrains, private readonly opts: DebateOptions = {}) {}

  /** Debates already spent this message (instance is resolved once per run). */
  private debatesThisTurn = 0;

  /** Try to claim a per-message fusion slot (debate or verify). Returns false when
   *  the per-message cap is already spent; increments + returns true otherwise.
   *  Keyed off the active turn (survives across loop iterations regardless of
   *  model-instance lifetime); per-instance fallback in tests. The mode/stakes
   *  gate (shouldDebate) is checked separately, and verify only calls this AFTER
   *  it confirms the draft is a user-facing answer — so slots are never wasted on
   *  tool-routing (focus_get) or internal sub-calls. */
  private spendFusionSlot(): boolean {
    const cap = this.opts.maxPerTurn ?? maxDebatesPerTurn();
    if (cap <= 0) { this.debatesThisTurn += 1; return true; } // unlimited (legacy)

    const key = activeTurnKey();
    if (key) {
      const n = debateCountByTurn.get(key) ?? 0;
      if (n >= cap) return false;
      debateCountByTurn.set(key, n + 1);
      this.debatesThisTurn = n + 1; // surfaced in the trace as `n`
      return true;
    }
    if (this.debatesThisTurn >= cap) return false;
    this.debatesThisTurn += 1;
    return true;
  }

  private get hb(): number {
    return this.opts.heartbeatMs ?? heartbeatMs();
  }
  private get checkerDeadline(): number {
    return this.opts.checkerDeadlineMs ?? checkerDeadlineMs();
  }
  private get sleep(): (ms: number) => Promise<void> {
    // unref the keep-alive tick so the one timer that may dangle after a turn
    // settles can never hold the process open (it resolves an ignored promise).
    return this.opts.sleep ?? ((ms) => new Promise<void>((r) => {
      const t = setTimeout(r, ms);
      (t as { unref?: () => void }).unref?.();
    }));
  }

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    // The user-facing orchestrator always streams; getResponse is internal
    // sub-calls (memory consolidation, gates, judges) — never fuse them, or they
    // burn the per-message budget before the real answer (observed live: the
    // verify budget was spent on consolidation while the answer ran single-brain).
    if (!this.opts.fuseNonStreamed) return this.brains.passthrough.getResponse(request);
    if (!shouldDebate(request)) return this.brains.passthrough.getResponse(request);
    if (fusionStrategy() === 'verify') return this.verifyResponse(request);
    if (!this.spendFusionSlot()) return this.brains.passthrough.getResponse(request);
    const { a, b } = await this.draftBoth(request);
    if (!a || !b) {
      const survivor = a ?? b;
      if (survivor) {
        recordDebateTrace({ path: 'getResponse', outcome: 'fail-open-survivor', survivor: a ? 'claude' : 'codex' });
        return survivor;
      }
      logger.warn('both debate drafts failed — falling back to a single passthrough answer');
      recordDebateTrace({ path: 'getResponse', outcome: 'both-failed-passthrough' });
      return this.brains.passthrough.getResponse(request);
    }
    const da = summarizeOutput(a.output);
    const db = summarizeOutput(b.output);
    const div = divergence(da, db);
    const judgeReq = linkedAbortRequest(buildJudgeRequest(request, a, b));
    try {
      const final = await raceDeadline(this.brains.judge.getResponse(judgeReq.request), this.checkerDeadline);
      if (final === DEADLINE) {
        judgeReq.abort();
        logger.warn({ deadlineMs: this.checkerDeadline }, 'debate judge exceeded deadline — falling back to the longer surviving draft');
        recordDebateTrace({ path: 'getResponse', outcome: 'judge-timeout-draft-fallback', divergence: div });
        return pickLongerDraft(a, b);
      }
      const judge = judgeTraceLabel();
      logger.info({ path: 'getResponse', divergence: div, draftAlen: da.length, draftBlen: db.length, judge }, 'debate turn reconciled');
      recordDebateTrace({ path: 'getResponse', n: this.debatesThisTurn, divergence: div, judge, draftA: capText(da), draftB: capText(db), final: capText(extractAssistantText(final.output)) });
      return final;
    } catch (err) {
      // The judge failed AFTER two valid drafts — don't lose the turn; answer
      // from the stronger surviving draft instead of failing closed.
      logger.warn({ err: errText(err) }, 'debate judge failed — falling back to the longer surviving draft');
      recordDebateTrace({ path: 'getResponse', outcome: 'judge-failed-draft-fallback', divergence: div });
      return pickLongerDraft(a, b);
    } finally {
      judgeReq.cleanup();
    }
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    if (!shouldDebate(request) || isWorkerScope()) {
      // Not a fused turn (mode/stakes gate, or a fan-out worker = delegated
      // execution): forward the normal brain verbatim.
      yield* this.brains.passthrough.getStreamedResponse(request);
      return;
    }

    if (fusionStrategy() === 'verify') {
      // verify claims its slot AFTER drafting (only for a user-facing answer).
      yield* this.verifyStreamed(request);
      return;
    }

    if (!this.spendFusionSlot()) {
      // Per-message debate cap reached → run single-brain for the rest.
      yield* this.brains.passthrough.getStreamedResponse(request);
      return;
    }

    // Exactly ONE response_started for the whole turn comes from us; the judge's
    // own response_started is filtered out below so the SDK sees a clean sequence.
    yield { type: 'response_started', providerData: { debate: true } } as unknown as StreamEvent;

    const draftsPromise = this.draftBoth(request);
    // Bridge the silent drafting window with non-committing keep-alives.
    yield* heartbeatsUntil(draftsPromise, this.hb, this.sleep);
    const { a, b } = await draftsPromise;

    if (!a || !b) {
      const survivor = a ?? b;
      if (survivor) {
        recordDebateTrace({ path: 'stream', outcome: 'fail-open-survivor', survivor: a ? 'claude' : 'codex' });
        yield* streamResponseAsEvents(survivor);
        return;
      }
      logger.warn('both debate drafts failed — streaming a single passthrough answer');
      recordDebateTrace({ path: 'stream', outcome: 'both-failed-passthrough' });
      yield* forwardWithDoneBackstop(this.brains.passthrough.getStreamedResponse(request));
      return;
    }

    // Two drafts in hand: the judge reconciles, streamed live as the final answer.
    // Tee the judge's text (drop its response_started — we emitted ours) so we can
    // record what reconciliation actually produced, without altering the stream.
    const da = summarizeOutput(a.output);
    const db = summarizeOutput(b.output);
    const div = divergence(da, db);
    let finalText = '';
    let judgeFinalOutput: unknown;
    let judgeYieldedContent = false;
    let sawDone = false;
    const judgeReq = linkedAbortRequest(buildJudgeRequest(request, a, b));
    const judgeIt = this.brains.judge.getStreamedResponse(judgeReq.request)[Symbol.asyncIterator]();
    try {
      while (true) {
        const next = judgeYieldedContent || sawDone
          ? await judgeIt.next()
          : await raceDeadline(judgeIt.next(), this.checkerDeadline);
        if (next === DEADLINE) {
          judgeReq.abort();
          void judgeIt.return?.().catch(() => {});
          logger.warn({ deadlineMs: this.checkerDeadline }, 'debate judge exceeded deadline before committed content — replaying the longer surviving draft');
          recordDebateTrace({ path: 'stream', outcome: 'judge-timeout-draft-fallback', divergence: div });
          yield* streamResponseAsEvents(pickLongerDraft(a, b));
          return;
        }
        if (next.done) break;
        const res = next;
        const ev = res.value;
        const e = ev as { type?: string; delta?: string; response?: { output?: unknown } };
        if (e.type !== 'response_started') {
          if (e.type === 'output_text_delta' && typeof e.delta === 'string') { finalText += e.delta; judgeYieldedContent = true; }
          const outEv = e.type === 'response_done' ? normalizeResponseDoneEvent(ev, 'debate-judge') : ev;
          const out = outEv as { type?: string; response?: { output?: unknown } };
          if (out.type === 'response_done') { sawDone = true; if (out.response) judgeFinalOutput = out.response.output; }
          yield outEv;
        }
      }
    } catch (err) {
      // Recover ONLY if nothing was committed — neither a text delta NOR a
      // terminal response_done (a structured judge commits via response_done with
      // no text, so gating on text alone would replay a duplicate response_done).
      if (judgeYieldedContent || sawDone) throw err;
      logger.warn({ err: errText(err) }, 'debate judge stream failed pre-content — replaying the longer surviving draft');
      recordDebateTrace({ path: 'stream', outcome: 'judge-failed-draft-fallback', divergence: div });
      yield* streamResponseAsEvents(pickLongerDraft(a, b));
      return;
    } finally {
      judgeReq.cleanup();
    }
    // Guarantee a terminal response_done — a judge that streamed text but no done
    // would otherwise crash the turn ("did not produce a final response").
    if (!sawDone) yield* synthesizeTerminalDone(judgeFinalOutput, finalText);
    // FIX6: structured-output turns carry the answer in response_done.output, not
    // text deltas — fall back to that so the trace isn't under-reported.
    const finalForTrace = finalText || extractAssistantText(judgeFinalOutput);
    const judge = judgeTraceLabel();
    logger.info({ path: 'stream', divergence: div, draftAlen: da.length, draftBlen: db.length, finalLen: finalForTrace.length, judge }, 'debate turn reconciled');
    recordDebateTrace({ path: 'stream', n: this.debatesThisTurn, divergence: div, judge, draftA: capText(da), draftB: capText(db), final: capText(finalForTrace) });
  }

  /** Draft on both brains in parallel, but DON'T let a slow/flaky brain hold the
   *  turn hostage: once the first draft lands, the second gets a bounded grace
   *  window, then we proceed with what we have. A rejection (already post the
   *  brain's own retry budget) drops that draft to null — fail open to the other.
   *  A draft that overruns the grace is treated the same (still runs in bg). */
  private async draftBoth(request: ModelRequest): Promise<{ a: ModelResponse | null; b: ModelResponse | null }> {
    let a: ModelResponse | null = null;
    let b: ModelResponse | null = null;
    let aDone = false;
    let bDone = false;

    // Each draft gets its own AbortController so the grace-LOSING draft is
    // cancelled (not left running fully-billed with its result discarded), and we
    // chain the turn's own signal so a turn abort cancels BOTH drafts. (The judge
    // inherits request.signal via buildJudgeRequest's spread.)
    const turnSignal = (request as { signal?: AbortSignal }).signal;
    const acA = new AbortController();
    const acB = new AbortController();
    const onTurnAbort = () => { acA.abort(); acB.abort(); };
    if (turnSignal) {
      if (turnSignal.aborted) onTurnAbort();
      else turnSignal.addEventListener('abort', onTurnAbort, { once: true });
    }
    const reqA = { ...request, signal: acA.signal } as ModelRequest;
    const reqB = { ...request, signal: acB.signal } as ModelRequest;

    const pa = this.brains.draftA
      .getResponse(reqA)
      .then((v) => { a = v; })
      .catch((e) => { logger.warn({ err: errText(e) }, 'debate draft A failed (fail-open)'); })
      .finally(() => { aDone = true; });
    const pb = this.brains.draftB
      .getResponse(reqB)
      .then((v) => { b = v; })
      .catch((e) => { logger.warn({ err: errText(e) }, 'debate draft B failed (fail-open)'); })
      .finally(() => { bDone = true; });

    const grace = this.opts.draftGraceMs ?? draftGraceMs();
    await new Promise<void>((resolve) => {
      let resolved = false;
      let graceTimer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (resolved) return;
        resolved = true;
        if (graceTimer) clearTimeout(graceTimer);
        // Proceeding without whichever draft is still running — abort it so it
        // stops billing tokens for a result we'll discard.
        if (!aDone) acA.abort();
        if (!bDone) acB.abort();
        resolve();
      };
      const onSettle = () => {
        if (aDone && bDone) { finish(); return; }       // both in → go now
        if (graceTimer === undefined && grace >= 0) {     // first one in → start the clock
          graceTimer = setTimeout(finish, grace);
        }
      };
      void pa.then(onSettle);
      void pb.then(onSettle);
    });
    if (turnSignal) turnSignal.removeEventListener('abort', onTurnAbort);

    if (!aDone) logger.warn({ graceMs: grace }, 'debate draft A overran the grace window — aborted, proceeding without it');
    if (!bDone) logger.warn({ graceMs: grace }, 'debate draft B overran the grace window — aborted, proceeding without it');
    return { a, b };
  }

  // --- 'verify' strategy: executor (passthrough) drafts, checker (judge) verifies ---

  private async verifyResponse(request: ModelRequest): Promise<ModelResponse> {
    const draft = await this.brains.passthrough.getResponse(request).catch(() => null);
    if (!draft) {
      // Executor failed → the checker answers the original request directly.
      logger.warn('fusion verify: executor draft failed — checker answers directly');
      recordDebateTrace({ path: 'verify', outcome: 'executor-failed' });
      return this.brains.judge.getResponse(request);
    }
    // Only spend a checker call on a real USER-FACING answer (not a tool-routing
    // step like focus_get), and only while under the per-message cap — so the
    // fusion budget lands on the answer, never on plumbing iterations.
    if (!hasUserFacingAnswer(draft.output) || !this.spendFusionSlot()) {
      return draft;
    }
    const checkerReq = linkedAbortRequest(buildVerifyRequest(request, draft));
    try {
      const final = await raceDeadline(this.brains.judge.getResponse(checkerReq.request), this.checkerDeadline);
      if (final === DEADLINE) {
        checkerReq.abort();
        logger.warn({ deadlineMs: this.checkerDeadline }, 'fusion verify: checker exceeded deadline — shipping the executor draft');
        recordDebateTrace({ path: 'verify', n: this.debatesThisTurn, outcome: 'checker-timeout-ship-draft' });
        return draft;
      }
      recordDebateTrace({ path: 'verify', n: this.debatesThisTurn, judge: judgeTraceLabel(), executor: capText(summarizeOutput(draft.output)), final: capText(extractAssistantText(final.output)) });
      return final;
    } catch (err) {
      // Checker failed → ship the executor's draft rather than lose the turn.
      logger.warn({ err: errText(err) }, 'fusion verify: checker failed — shipping the executor draft');
      recordDebateTrace({ path: 'verify', n: this.debatesThisTurn, outcome: 'checker-failed-ship-draft' });
      return draft;
    } finally {
      checkerReq.cleanup();
    }
  }

  private async *verifyStreamed(request: ModelRequest): AsyncIterable<StreamEvent> {
    // ONE response_started for the whole turn (the checker's is dropped below).
    yield { type: 'response_started', providerData: { fusion: 'verify' } } as unknown as StreamEvent;

    // Executor (the active/passthrough brain — Codex in the recommended setup)
    // drafts, buffered; the silent window is bridged with keep-alives.
    const draftP = this.brains.passthrough.getResponse(request).then((r) => r, () => null);
    yield* heartbeatsUntil(draftP, this.hb, this.sleep);
    const draft = await draftP;

    if (!draft) {
      logger.warn('fusion verify: executor draft failed — checker streams the answer directly');
      recordDebateTrace({ path: 'verify', outcome: 'executor-failed' });
      yield* forwardWithDoneBackstop(this.brains.judge.getStreamedResponse(request));
      return;
    }

    // Only spend a checker call on a real USER-FACING answer + under the cap —
    // otherwise ship the executor's draft as-is, so the fusion budget is never
    // wasted on tool-routing (focus_get) or other non-answer iterations.
    if (!hasUserFacingAnswer(draft.output) || !this.spendFusionSlot()) {
      yield* streamResponseAsEvents(draft);
      return;
    }

    const da = summarizeOutput(draft.output);
    let finalText = '';
    let checkerOutput: unknown;
    let checkerYieldedContent = false;
    let sawDone = false;
    const checkerReq = linkedAbortRequest(buildVerifyRequest(request, draft));
    const it = this.brains.judge.getStreamedResponse(checkerReq.request)[Symbol.asyncIterator]();
    try {
      // DEADLINE on the checker's FIRST event: the executor's Codex draft is
      // already the answer, so a hung/slow checker (Anthropic at capacity HANGS
      // rather than 529s — the run-killer) must not block the turn waiting out the
      // retry budget. If the checker doesn't deliver within the deadline, ship the
      // draft. (Falling the checker over to Codex would be pointless here — the
      // executor IS Codex; shipping the draft we already have is the right move.)
      const deadline = this.checkerDeadline;
      while (true) {
        const next = checkerYieldedContent || sawDone
          ? await it.next()
          : await raceDeadline(it.next(), deadline);
        if (next === DEADLINE) {
          // Nothing committed and the checker hung past the deadline: abort it
          // and ship the draft. A pre-first-event throw is handled below.
          checkerReq.abort();
          void it.return?.().catch(() => {});
          logger.warn({ deadlineMs: deadline }, 'fusion verify: checker exceeded deadline before committed content — shipping the executor draft');
          recordDebateTrace({ path: 'verify', n: this.debatesThisTurn, outcome: 'checker-timeout-ship-draft' });
          yield* streamResponseAsEvents(draft);
          return;
        }
        if (next.done) break;
        const res = next;
        const ev = res.value;
        const e = ev as { type?: string; delta?: string; response?: { output?: unknown } };
        if (e.type !== 'response_started') {
          if (e.type === 'output_text_delta' && typeof e.delta === 'string') { finalText += e.delta; checkerYieldedContent = true; }
          if (e.type === 'response_done') {
            const outEv = normalizeResponseDoneEvent(ev, 'debate-checker');
            const doneOutput = (outEv as { response?: { output?: unknown } }).response?.output;
            // An empty completion with NOTHING streamed → don't ship an empty
            // turn; ship the executor (Codex) draft instead. We must intercept
            // BEFORE yielding the empty done (yielding it then the draft would
            // emit two terminal events). The resilient layer normally throws on
            // an empty completion before we get here; this is the in-loop
            // backstop for when it doesn't (e.g. CLEMMY_MODEL_PARITY=off).
            if (!checkerYieldedContent && !extractAssistantText(doneOutput)) {
              void it.return?.().catch(() => {});
              logger.warn({ checkerModel: resolveRoleModel('judge').modelId }, 'fusion verify: checker returned an EMPTY response_done — shipping the executor draft');
              recordDebateTrace({ path: 'verify', n: this.debatesThisTurn, outcome: 'checker-empty-ship-draft' });
              yield* streamResponseAsEvents(draft);
              return;
            }
            sawDone = true;
            checkerOutput = doneOutput;
            yield outEv;
          } else {
            yield ev;
          }
        }
      }
    } catch (err) {
      // Recover (ship the executor draft) ONLY if nothing committed — no text AND
      // no terminal response_done — else we'd emit a duplicate response_done.
      if (checkerYieldedContent || sawDone) throw err;
      logger.warn({ err: errText(err) }, 'fusion verify: checker failed pre-content — shipping the executor draft');
      recordDebateTrace({ path: 'verify', n: this.debatesThisTurn, outcome: 'checker-failed-ship-draft' });
      yield* streamResponseAsEvents(draft);
      return;
    } finally {
      checkerReq.cleanup();
    }
    // Backstop a checker that streamed text but no terminal done.
    if (!sawDone) yield* synthesizeTerminalDone(checkerOutput, finalText);
    const finalForTrace = finalText || extractAssistantText(checkerOutput);
    // Observability: distinguish a real refinement from an empty checker so a
    // 0-length trace can't be misread as a failure. 'checker-refined' = the
    // checker produced usable content; 'checker-empty' = it returned without
    // throwing but with nothing usable (an overloaded/empty completion).
    const outcome = finalForTrace ? 'checker-refined' : 'checker-empty';
    // Observability: which model actually checked (the registry-resolved judge —
    // Sonnet by default, or whatever a UI/chat binding set), and on an empty
    // return, the shape the checker emitted so a regression is diagnosable.
    const checkerModelId = resolveRoleModel('judge').modelId;
    if (!finalForTrace) {
      logger.warn({
        checkerModel: checkerModelId,
        outputItemTypes: Array.isArray(checkerOutput) ? (checkerOutput as Array<{ type?: string }>).map((o) => o?.type) : typeof checkerOutput,
      }, 'fusion verify: checker returned EMPTY — shipping the executor draft');
    }
    const judge = judgeTraceLabel();
    logger.info({ path: 'verify', n: this.debatesThisTurn, outcome, executorLen: da.length, finalLen: finalForTrace.length, judge, checkerModel: checkerModelId }, 'fusion verify reconciled');
    recordDebateTrace({ path: 'verify', n: this.debatesThisTurn, outcome, judge, executor: capText(da), final: capText(finalForTrace) });
  }
}

// ---------------------------------------------------------------------------
// Provider + brain assembly
// ---------------------------------------------------------------------------

export class DebateModelProvider implements ModelProvider {
  constructor(private readonly passthrough: ModelProvider, private readonly opts: DebateOptions = {}) {}

  getModel(modelName?: string): Model | Promise<Model> {
    const brains = resolveDebateBrains(this.passthrough, modelName);
    logDebateAvailabilityTransition(brains !== null);
    // No two distinct flagships available → behave exactly like the normal provider.
    if (!brains) return this.passthrough.getModel(modelName);
    return new DebateModel(brains, this.opts);
  }
}

// claudeAvailable / codexAvailable / debateBrainsAvailable moved to the
// judge-family leaf (imported + re-exported above) so model-roles can share them
// without importing this heavy module.

/**
 * Whether the 'verify' fusion strategy can actually run right now: the judge role
 * resolves to an AVAILABLE provider that is DIFFERENT from the active brain (e.g.
 * GLM brain + Codex judge). Used so the settings UI can show fusion as active even
 * without two flagships. Returns false in 'debate' strategy (that needs both
 * flagships — debateBrainsAvailable covers it).
 */
export function verifyJudgeAvailable(): boolean {
  if (fusionStrategy() !== 'verify') return false;
  const brain = resolveRoleModel('brain');
  const checker = resolveRoleModel('judge');
  if (checker.provider === brain.provider && checker.modelId === brain.modelId) {
    // Same as brain → fall back to the legacy Fusion judge control (must be a
    // DIFFERENT, available provider — mirrors resolveDebateBrains).
    const choice = judgeChoice();
    if (choice === 'codex') return codexAvailable() && brain.provider !== 'codex';
    return claudeAvailable() && brain.provider !== 'claude';
  }
  if (checker.provider === 'codex') return codexAvailable();
  if (checker.provider === 'claude') return claudeAvailable();
  const byo = resolveByoProviderForModel(checker.modelId) ?? getByoBackendConfig();
  return byo.configured;
}

let lastDebateActive: boolean | null = null;
/** Log ONCE when debate flips active<->inactive. A flagship login lapsing (e.g.
 *  Claude's OAuth token expiring) makes debate fall back to single-brain — which
 *  was previously SILENT (no trace, no log), so it looked like debate "stopped
 *  working" for no reason. Now the transition is always announced. */
function logDebateAvailabilityTransition(active: boolean): void {
  if (active === lastDebateActive) return;
  lastDebateActive = active;
  if (active) {
    logger.info('fusion debate ACTIVE — both flagships available, debating turns');
  } else {
    const { claude, codex } = debateBrainsAvailable();
    logger.warn({ claude, codex }, 'fusion debate INACTIVE — a flagship login is missing; running SINGLE-BRAIN passthrough until it returns');
  }
}

/**
 * Assemble the two distinct flagship brains + a judge, or null if we can't field
 * two different flagships (then debate is impossible and the caller passes
 * through). The "passthrough" brain is the harness's normal default for the
 * active auth mode — non-debate turns run on it, byte-identical to today.
 */
/**
 * Build the judge Model for the resolved 'judge' role, or null when that
 * provider isn't available. Shared by the debate and verify paths. Routes a BYO
 * judge to the provider that OWNS its model id (its own key+endpoint) — so a
 * MiniMax judge hits MiniMax, not whatever single backend is configured.
 */
function buildJudgeForRole(checker: ResolvedRoleModel, haveClaude: boolean, haveCodex: boolean): Model | null {
  if (checker.provider === 'codex') {
    return haveCodex ? new CodexModelProvider().getModel(checker.modelId) : null;
  }
  if (checker.provider === 'byo') {
    const byo = resolveByoProviderForModel(checker.modelId) ?? getByoBackendConfig();
    return byo.configured ? getByoModel(checker.modelId, byo) : null;
  }
  // claude
  if (!haveClaude) return null;
  return checker.modelId && checker.modelId !== getClaudeBrainModel()
    ? new ClaudeModelProvider().getModel(checker.modelId)
    : new ClaudeModelProvider().getModel();
}

// ─────────────────────────────────────────────────────────────────
// Cross-family BOUNDARY judge (Lane A Phase 1 — eval-as-harness).
//
// The per-turn completion / grounding / goal-fidelity checkers run on MOST
// action turns, so they stay on a CHEAP tier (Haiku / gpt-fast), NOT the
// flagship fusion-reconciler judge role. But a checker that shares the active
// brain's model family is the textbook correlated-error "self-judging" case (a
// Codex brain graded by a Codex judge; GLM graded by GLM under all_in) — the
// 2026 research's "coherence trap". This resolves a cheap judge from a family
// DIFFERENT than the brain, and fails OPEN to the brain's own family
// (selfJudge:true, tagged) when no other family is logged in — it never wedges.
// Kill-switch CLEMMY_JUDGE_CROSS_FAMILY (default on; off ⇒ byte-identical to the
// prior MODELS.fast judges). DELETE-WHEN-VALIDATED: once judge-calibration shows
// κ≥0.6 for the cross-family pairing and bench pass^k does not regress for two
// releases (Lane A Phase 3), the route becomes unconditional and the flag drops.
// ─────────────────────────────────────────────────────────────────

// judgeCrossFamilyEnabled / boundaryClaudeJudgeModel / boundaryCodexJudgeModel
// moved to the judge-family leaf (imported above).

export interface BoundaryJudgeRouting {
  /** A Model forced onto a family DISTINCT from the brain when one is available;
   *  null ⇒ the caller keeps its existing MODELS.fast string (fail-open). */
  model: Model | null;
  /** The judge model id actually used (telemetry). */
  modelId: string;
  judgeFamily: ModelProviderClass;
  brainFamily: ModelProviderClass;
  /** true ⇒ no different family was available, so the judge shares the brain's
   *  family (the correlated-error case — now OBSERVABLE, never silent). */
  selfJudge: boolean;
}

// chooseBoundaryJudgeFamily moved to the judge-family leaf (imported + re-exported above).

/** Resolve the one configured judge lane for boundary/completion checks.
 *
 * The judge role default is already cheap + cross-family when another family is
 * logged in. Honor that same resolved lane here so the Settings panel, fusion
 * verify, completion judge, grounding judge, and goal-fidelity judge all agree.
 * If that lane is unavailable, fail open to the historical MODELS.fast path.
 */
export function resolveBoundaryJudge(): BoundaryJudgeRouting {
  const brain = resolveRoleModel('brain');
  const brainFamily = brain.provider;
  if (!judgeCrossFamilyEnabled()) {
    return { model: null, modelId: codexSafeFast(), judgeFamily: brainFamily, brainFamily, selfJudge: true };
  }
  const haveClaude = claudeAvailable();
  const haveCodex = codexAvailable();
  const checker = resolveRoleModel('judge');
  const model = buildJudgeForRole(checker, haveClaude, haveCodex);
  if (model) {
    return {
      model,
      modelId: checker.modelId,
      judgeFamily: checker.provider,
      brainFamily,
      selfJudge: checker.provider === brain.provider,
    };
  }
  // Fail-open: no usable resolved judge → the brain-family-safe cheap id (never a
  // repurposed BYO fast slot that would storm an unintended provider), tagged.
  return { model: null, modelId: codexSafeFast(), judgeFamily: brainFamily, brainFamily, selfJudge: true };
}

export function resolveDebateBrains(passthrough: ModelProvider, modelName?: string): DebateBrains | null {
  const haveClaude = claudeAvailable();
  const haveCodex = codexAvailable();

  // VERIFY strategy needs only ONE executor (the active brain = passthrough) plus
  // a checker (the judge role) — draftA/draftB are unused in verify. So it can run
  // for a BYO brain (e.g. GLM 5.2) + a Codex/Claude/other-BYO judge with NO
  // two-flagship requirement, as long as the judge is available AND a DIFFERENT
  // model than the brain (a same-model self-check adds nothing). This is what makes
  // "GLM 5.2 brain with Codex as the judge" work.
  if (fusionStrategy() === 'verify') {
    const brain = resolveRoleModel('brain');
    let checker = resolveRoleModel('judge');
    // If the judge role collapses to the SAME model as the brain (e.g. all_in BYO
    // defaults judge→the BYO primary), fall back to the legacy Fusion judge control
    // (CLEMMY_DEBATE_JUDGE = claude|codex) so "GLM brain + Codex judge" engages from
    // the Fusion control alone, without needing an explicit judge-role pin.
    if (checker.provider === brain.provider && checker.modelId === brain.modelId) {
      const choice = judgeChoice();
      if (choice === 'codex' && codexAvailable() && brain.provider !== 'codex') {
        // Use a REAL Codex id, not MODELS.primary — the OPENAI_MODEL_PRIMARY slot can
        // be repurposed to a BYO/GLM id (glm-5.2), which the router then sends to the
        // BYO endpoint and storms with 429s (labelled provider:'codex' but wired to
        // BYO). boundaryCodexJudgeModel() (gpt-5.4-mini) is a guaranteed-Codex checker.
        checker = { modelId: boundaryCodexJudgeModel(), provider: 'codex', source: 'default' };
      } else if (choice === 'claude' && claudeAvailable() && brain.provider !== 'claude') {
        checker = { modelId: getDebateCheckerModel(), provider: 'claude', source: 'default' };
      } else {
        return null; // no DIFFERENT-provider judge available — a self-check adds nothing
      }
    }
    const judge = buildJudgeForRole(checker, haveClaude, haveCodex);
    if (!judge) return null;
    const pass = resolveSync(passthrough.getModel(modelName));
    return { passthrough: pass, draftA: pass, draftB: pass, judge };
  }

  // DEBATE strategy: two distinct flagships draft, the judge reconciles. Needs
  // BOTH Claude and Codex (the two drafters). Build the Claude brain through the
  // PROVIDER so it carries the overload fallback chain Opus -> Sonnet -> Codex.
  if (!haveClaude || !haveCodex) return null;
  const claude: Model = new ClaudeModelProvider().getModel();
  const codex: Model = new CodexModelProvider().getModel();
  // The judge comes from the role→model registry (a UI/chat binding wins; else the
  // provider-derived default), dispatched by its provider so the role snapshot and
  // the actual judge cannot diverge. A byo judge with no configured backend → null.
  const checker = resolveRoleModel('judge');
  const judge = buildJudgeForRole(checker, haveClaude, haveCodex);
  if (!judge) return null;

  return {
    passthrough: resolveSync(passthrough.getModel(modelName)),
    draftA: claude,
    draftB: codex,
    judge,
  };
}

// ---------------------------------------------------------------------------
// Judge request + draft rendering
// ---------------------------------------------------------------------------

const JUDGE_PREAMBLE = [
  'You are the deciding brain in a two-model debate. Two independent flagship',
  'models each drafted a response to the user request above. Critically evaluate',
  'BOTH drafts: keep the stronger reasoning, correct any factual or logical',
  'errors, reconcile disagreements, and produce the single best final response.',
  'If the drafts agree, confirm and tighten. If they conflict, decide on the',
  'merits and say nothing about the disagreement. Do NOT mention this debate, the',
  'other model, or that drafts existed — speak directly to the user as one voice.',
  'IMPORTANT: if EITHER draft proposes a local-state or side-effecting tool call',
  '(focus_get / focus_set / focus_update / focus_clear, memory_remember, or any',
  'execution_* call), PRESERVE that call in your response unless you have a',
  "concrete reason to drop it — only the deciding brain's tool calls actually",
  'execute, so dropping one silently loses focus hygiene or a learned fact.',
].join(' ');

/** Disable extended thinking on a checker/judge request. The fusion checker
 *  inherits the TURN's reasoning effort, which on a thinking-capable Claude (Opus,
 *  thinkingMode:'effort') turns ON extended thinking. LIVE FAILURE 2026-06-17:
 *  Claude's extended thinking + STRUCTURED output corrupt each other through the
 *  aisdk adapter — the thinking bleeds into the decision's `reply` field, producing
 *  garbled, reasoning-leaking text (the executor's Codex draft was clean; the
 *  Claude refinement mangled it: "et I The AI search-angdata … #ocus … rfirst").
 *  A verify/reconcile pass does not need extended thinking, so force effort='none'
 *  (ANTHROPIC_EFFORT_MAP maps 'none' -> null -> no anthropic effort) AND strip any
 *  already-translated providerOptions.anthropic.effort. */
function withThinkingDisabled(request: ModelRequest): ModelRequest {
  const ms = ((request as { modelSettings?: Record<string, unknown> }).modelSettings ?? {}) as Record<string, unknown>;
  const pd = (ms.providerData ?? {}) as Record<string, unknown>;
  const po = (pd.providerOptions ?? {}) as Record<string, unknown>;
  const anthropic = { ...((po.anthropic ?? {}) as Record<string, unknown>) };
  delete anthropic.effort;
  return {
    ...request,
    modelSettings: {
      ...ms,
      reasoning: { ...((ms.reasoning ?? {}) as Record<string, unknown>), effort: 'none' },
      providerData: { ...pd, providerOptions: { ...po, anthropic } },
    },
  } as ModelRequest;
}

/** Build the judge's request: the original request UNCHANGED (tools, modelSettings,
 *  outputType/handoffs all preserved so structured output + tool use still work),
 *  with the two drafts appended to the system instructions as text. Augmenting the
 *  instruction string (not the input items) keeps it shape-safe across providers.
 *
 *  INVARIANT: request.input MUST be preserved verbatim — it carries the harness's
 *  per-turn `role:system` items injected by callModelInputFilter (the
 *  [AGENT CONTEXT PACKET] with the focus line, the memory primer, and the goal
 *  block). The `...request` spread preserves them; do NOT rebuild the judge's
 *  input or the judge loses its focus / memory / goal context. */
// Position-bias mitigation. An LLM judge favors whichever draft is presented
// first (~⅓ of comparative verdicts flip on re-order). draftA is ALWAYS Claude
// and draftB ALWAYS Codex (resolveDebateBrains), so a FIXED presentation order is
// a SYSTEMATIC provider bias — exactly the self-/position-preference a
// cross-provider panel exists to cancel. Randomize which draft is labelled
// "DRAFT A" per judge call so neither flagship is structurally favored.
let judgeOrderCoin: () => boolean = () => Math.random() < 0.5;
/** Test seam: force the draft-order coin (true ⇒ swap A/B presentation). */
export function setJudgeOrderCoinForTest(fn: (() => boolean) | null): void {
  judgeOrderCoin = fn ?? (() => Math.random() < 0.5);
}

export function buildJudgeRequest(request: ModelRequest, a: ModelResponse, b: ModelResponse): ModelRequest {
  const base = ((request as { systemInstructions?: string }).systemInstructions ?? '').toString();
  // Present in a randomized order so the verdict isn't biased toward the model
  // that is always drafted first (Claude). Content is identical either way.
  const swap = judgeOrderCoin();
  const first = swap ? b : a;
  const second = swap ? a : b;
  const block = [
    base,
    '',
    '=== TWO-MODEL DEBATE — RECONCILE THE DRAFTS BELOW ===',
    JUDGE_PREAMBLE,
    '',
    '--- DRAFT A ---',
    summarizeOutput(first.output) || '(empty)',
    '',
    '--- DRAFT B ---',
    summarizeOutput(second.output) || '(empty)',
    '=== END DEBATE DRAFTS ===',
  ].join('\n');
  return withThinkingDisabled({ ...request, systemInstructions: block } as ModelRequest);
}

const VERIFY_PREAMBLE = [
  'A first model (the EXECUTOR) produced the DRAFT below in response to the user',
  'request above. You are the CHECKER: verify the draft against the request and the',
  'context — correct any factual or logical errors, fill gaps, and tighten it — then',
  'produce the single best FINAL response. If the draft is already correct, confirm',
  'and refine it. Speak directly to the user as one voice; do NOT mention the draft,',
  'the executor, or this verification. PRESERVE any local-state or side-effecting',
  'tool call the draft proposed (focus_* / memory_remember / execution_*) unless you',
  'have a concrete reason to drop it.',
].join(' ');

/** Build the checker's request for the 'verify' strategy: the original request
 *  UNCHANGED (tools/outputType/input preserved — same invariant as the judge), with
 *  the executor's single draft appended to the system instructions to verify+refine. */
export function buildVerifyRequest(request: ModelRequest, draft: ModelResponse): ModelRequest {
  const base = ((request as { systemInstructions?: string }).systemInstructions ?? '').toString();
  const block = [
    base,
    '',
    '=== EXECUTOR DRAFT — VERIFY & REFINE ===',
    VERIFY_PREAMBLE,
    '',
    '--- DRAFT ---',
    summarizeOutput(draft.output) || '(empty)',
    '=== END DRAFT ===',
  ].join('\n');
  // Strip tools/handoffs: the checker is REFINING an already-user-facing text
  // answer (verify only runs when hasUserFacingAnswer is true), so it must emit
  // the refined reply, not wander into a tool call. Leaving the executor's full
  // toolset on the request let the checker (esp. Sonnet) answer with a
  // function_call instead of text → no assistant text → 'checker-empty' (ship
  // the unchecked draft). A verify checker never needs tools.
  return withThinkingDisabled({ ...request, systemInstructions: block, tools: [], handoffs: [] } as ModelRequest);
}

/** Render a draft's output items into compact text for the judge to weigh. */
export function summarizeOutput(output: unknown): string {
  if (!Array.isArray(output)) return '';
  const parts: string[] = [];
  for (const item of output) {
    const it = item as { type?: string; content?: unknown; name?: string; arguments?: unknown };
    if (it.type === 'message') {
      const t = extractMessageText(it.content);
      if (t) parts.push(t);
    } else if (it.type === 'function_call') {
      parts.push(`[proposes tool call: ${it.name ?? 'tool'}(${safeArgs(it.arguments)})]`);
    }
    // reasoning / other item types are intentionally omitted from the digest.
  }
  return parts.join('\n').trim();
}

/** Is this draft a USER-FACING answer worth a checker pass? It needs assistant
 *  text, and — when that text is the orchestrator's structured decision — a
 *  non-empty `reply`. This skips tool-routing (no text), workflow-step results
 *  (reply ""), and other non-user-facing structured emissions, so the verify
 *  budget lands only on a turn the user actually reads. Plain-prose answers
 *  (non-JSON) are always user-facing. */
function hasUserFacingAnswer(output: unknown): boolean {
  const text = extractAssistantText(output).trim();
  if (!text) return false;
  try {
    const obj = JSON.parse(text);
    if (obj && typeof obj === 'object' && !Array.isArray(obj) && 'reply' in obj) {
      const r = (obj as { reply?: unknown }).reply;
      return typeof r === 'string' && r.trim().length > 0;
    }
  } catch {
    /* not JSON → plain-prose answer; treat as user-facing */
  }
  return true;
}

/** Assistant text only (for replaying a single surviving draft to the user). */
function extractAssistantText(output: unknown): string {
  if (!Array.isArray(output)) return '';
  const parts: string[] = [];
  for (const item of output) {
    const it = item as { type?: string; content?: unknown };
    if (it.type === 'message') {
      const t = extractMessageText(it.content);
      if (t) parts.push(t);
    }
  }
  return parts.join('\n').trim();
}

function extractMessageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const out: string[] = [];
  for (const part of content) {
    const p = part as { type?: string; text?: string };
    if (typeof p.text === 'string' && (p.type === 'output_text' || p.type === 'text' || p.type === undefined)) {
      out.push(p.text);
    }
  }
  return out.join('');
}

function safeArgs(args: unknown): string {
  try {
    const s = typeof args === 'string' ? args : JSON.stringify(args);
    return (s ?? '').slice(0, 400);
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// Stream helpers
// ---------------------------------------------------------------------------

/** Yield benign keep-alive frames (codex's `model` pass-through shape) until the
 *  drafts settle, so the loop's stall watchdog sees activity. These reset the
 *  watchdog but are NOT counted as committed content (only output_text_delta is),
 *  so retry-safety downstream is preserved. */
export async function* heartbeatsUntil(
  done: Promise<unknown>,
  intervalMs: number,
  sleep: (ms: number) => Promise<void>,
): AsyncGenerator<StreamEvent> {
  if (intervalMs <= 0) return;
  let settled = false;
  done.then(() => { settled = true; }, () => { settled = true; });
  while (!settled) {
    const who = await Promise.race([
      sleep(intervalMs).then(() => 'tick' as const),
      done.then(() => 'done' as const, () => 'done' as const),
    ]);
    if (who === 'done' || settled) break;
    yield { type: 'model', event: { type: 'debate.keepalive' } } as unknown as StreamEvent;
  }
}

/** The SDK's StreamEventResponseCompleted schema REQUIRES response.id (non-empty
 *  string) and a usage object with numeric inputTokens/outputTokens/totalTokens —
 *  a response_done missing them throws a ZodError in run.js with no try/catch,
 *  crashing the whole turn. The original survivor-replay emitted `{output, usage:{}}`
 *  with no id, so the grace/fail-open path (the very reason this feature exists)
 *  could crash. These helpers make any replayed response_done conformant. */
function responseIdOf(resp: ModelResponse): string {
  const r = resp as { responseId?: unknown; response?: { id?: unknown } };
  if (typeof r.responseId === 'string' && r.responseId) return r.responseId;
  if (r.response && typeof r.response.id === 'string' && r.response.id) return r.response.id;
  return '';
}
function conformantUsage(u: unknown): { inputTokens: number; outputTokens: number; totalTokens: number } {
  const o = (u ?? {}) as Record<string, unknown>;
  const n = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const inputTokens = n(o.inputTokens ?? o.input_tokens ?? o.promptTokens);
  const outputTokens = n(o.outputTokens ?? o.output_tokens ?? o.completionTokens);
  const totalTokens = n(o.totalTokens ?? o.total_tokens) || inputTokens + outputTokens;
  return { inputTokens, outputTokens, totalTokens };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validStatus(v: unknown): 'in_progress' | 'completed' | 'incomplete' {
  return v === 'in_progress' || v === 'incomplete' || v === 'completed' ? v : 'completed';
}

function normalizeAssistantContent(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === 'string') return [{ type: 'output_text', text: content }];
  if (!Array.isArray(content)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    const text = typeof part.text === 'string' ? part.text : undefined;
    if ((part.type === 'output_text' || part.type === 'input_text' || part.type === 'text' || part.type === undefined) && text !== undefined) {
      out.push({ ...part, type: 'output_text', text });
    } else if (part.type === 'refusal' && typeof part.refusal === 'string') {
      out.push(part);
    } else if (part.type === 'image' && typeof part.image === 'string') {
      out.push(part);
    } else if (part.type === 'audio' && part.audio !== undefined) {
      out.push(part);
    } else if (text !== undefined) {
      out.push({ type: 'output_text', text });
    }
  }
  return out;
}

function normalizeInputContent(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === 'string') return [{ type: 'input_text', text: content }];
  if (!Array.isArray(content)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    const text = typeof part.text === 'string' ? part.text : undefined;
    if ((part.type === 'input_text' || part.type === 'output_text' || part.type === 'text' || part.type === undefined) && text !== undefined) {
      out.push({ ...part, type: 'input_text', text });
    } else if (part.type === 'input_image' || part.type === 'input_file' || part.type === 'audio') {
      out.push(part);
    } else if (text !== undefined) {
      out.push({ type: 'input_text', text });
    }
  }
  return out;
}

function normalizeReasoningRawContent(content: unknown): Array<Record<string, unknown>> | undefined {
  if (!Array.isArray(content)) return undefined;
  const out: Array<Record<string, unknown>> = [];
  for (const part of content) {
    if (!isRecord(part)) continue;
    const text = typeof part.text === 'string' ? part.text : undefined;
    if ((part.type === 'reasoning_text' || part.type === 'output_text' || part.type === 'input_text' || part.type === 'text' || part.type === undefined) && text !== undefined) {
      out.push({ ...part, type: 'reasoning_text', text });
    }
  }
  return out.length ? out : undefined;
}

function normalizeToolOutput(output: unknown): unknown {
  if (Array.isArray(output)) return normalizeInputContent(output);
  if (isRecord(output) && output.type === 'output_text' && typeof output.text === 'string') {
    return { ...output, type: 'text' };
  }
  return output;
}

function stableStringify(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return '{}';
  }
}

function normalizeOutputItem(item: unknown): Record<string, unknown> {
  if (!isRecord(item)) return { type: 'unknown', providerData: { raw: item } };
  const typ = item.type;
  if (typ === 'message' || typ === undefined || item.role === 'assistant' || item.role === 'user' || item.role === 'system') {
    return {
      ...item,
      type: 'message',
      role: 'assistant',
      status: validStatus(item.status),
      content: normalizeAssistantContent(item.content),
    };
  }
  if (typ === 'reasoning') {
    const rawContent = normalizeReasoningRawContent(item.rawContent);
    return {
      ...item,
      content: normalizeInputContent(item.content),
      ...(rawContent ? { rawContent } : {}),
    };
  }
  if (typ === 'function_call') {
    return {
      ...item,
      callId: typeof item.callId === 'string' && item.callId ? item.callId : typeof item.call_id === 'string' && item.call_id ? item.call_id : typeof item.id === 'string' && item.id ? item.id : 'debate-tool-call',
      name: typeof item.name === 'string' && item.name ? item.name : 'tool',
      arguments: stableStringify(item.arguments),
      ...(item.status === undefined ? {} : { status: validStatus(item.status) }),
    };
  }
  if (typ === 'function_call_result') {
    return {
      ...item,
      callId: typeof item.callId === 'string' && item.callId ? item.callId : typeof item.call_id === 'string' && item.call_id ? item.call_id : 'debate-tool-call',
      name: typeof item.name === 'string' && item.name ? item.name : 'tool',
      status: validStatus(item.status),
      output: normalizeToolOutput(item.output),
    };
  }
  return item;
}

function normalizeResponseOutput(output: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(output)) return [];
  return output.map(normalizeOutputItem);
}

function normalizeResponseDoneEvent(ev: StreamEvent, fallbackId: string): StreamEvent {
  const e = ev as { type?: string; response?: Record<string, unknown>; providerData?: unknown };
  if (e.type !== 'response_done') return ev;
  const response = isRecord(e.response) ? e.response : {};
  const id = typeof response.id === 'string' && response.id ? response.id : fallbackId;
  return {
    ...e,
    response: {
      ...response,
      id,
      output: normalizeResponseOutput(response.output),
      usage: conformantUsage(response.usage),
    },
  } as unknown as StreamEvent;
}

/** Replay a buffered ModelResponse as a stream (text delta + a SDK-CONFORMANT
 *  response_done carrying the full output, a non-empty id, and numeric usage).
 *  Used for the single-survivor / judge-failed fallback. No response_started —
 *  the caller already emitted one. */
export function* streamResponseAsEvents(resp: ModelResponse): Generator<StreamEvent> {
  const text = extractAssistantText(resp.output);
  if (text) {
    yield { type: 'output_text_delta', delta: text } as unknown as StreamEvent;
  }
  yield {
    type: 'response_done',
    response: {
      id: responseIdOf(resp) || 'debate-fallback',
      output: normalizeResponseOutput(resp.output),
      usage: conformantUsage((resp as { usage?: unknown }).usage),
    },
  } as unknown as StreamEvent;
}

/** The surviving draft to fall back to when the judge fails — the longer one
 *  (more reconciled-answer text) per the audit's "replay the longer surviving
 *  draft" guidance. */
function pickLongerDraft(a: ModelResponse, b: ModelResponse): ModelResponse {
  return extractAssistantText(a.output).length >= extractAssistantText(b.output).length ? a : b;
}

/** Emit ONE SDK-conformant terminal response_done — backstops a judge/checker
 *  stream that ended WITHOUT one (else the SDK throws "Model did not produce a
 *  final response" AFTER the user already saw streamed text). */
export function* synthesizeTerminalDone(output: unknown, text: string): Generator<StreamEvent> {
  const hasOutput = Array.isArray(output) && output.length > 0;
  yield {
    type: 'response_done',
    response: {
      id: 'debate-synth',
      output: hasOutput
        ? normalizeResponseOutput(output)
        : text
        ? [{ type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text }] }]
        : [],
      usage: conformantUsage(undefined),
    },
  } as unknown as StreamEvent;
}

/** Forward a stream, dropping its response_started (we emit our own single one)
 *  and GUARANTEEING a terminal response_done — synthesizes a conformant one if
 *  the upstream ends without it. For the direct-forward paths (no draft to
 *  recover): both-drafts-failed passthrough, and verify executor-failed. */
async function* forwardWithDoneBackstop(stream: AsyncIterable<StreamEvent>): AsyncGenerator<StreamEvent> {
  let sawDone = false;
  let finalText = '';
  let finalOutput: unknown;
  for await (const ev of stream) {
    const e = ev as { type?: string; delta?: string; response?: { output?: unknown } };
    if (e.type === 'response_started') continue;
    if (e.type === 'output_text_delta' && typeof e.delta === 'string') finalText += e.delta;
    const outEv = e.type === 'response_done' ? normalizeResponseDoneEvent(ev, 'debate-forward') : ev;
    const out = outEv as { type?: string; response?: { output?: unknown } };
    if (out.type === 'response_done') { sawDone = true; if (out.response) finalOutput = out.response.output; }
    yield outEv;
  }
  if (!sawDone) yield* synthesizeTerminalDone(finalOutput, finalText);
}

// ---------------------------------------------------------------------------
// Observability — capture both drafts + divergence + the judge's final per turn
// so we can MEASURE whether debate actually helped (vs. just costing 2-3x).
// ---------------------------------------------------------------------------

const TRACE_CAP = 1600;
function capText(s: string): string {
  return s.length > TRACE_CAP ? `${s.slice(0, TRACE_CAP)}…(+${s.length - TRACE_CAP} chars)` : s;
}

/** Lexical divergence between the two drafts: 0 = identical wording, 1 = disjoint.
 *  A cheap proxy for "did the brains actually disagree?" — high divergence is
 *  where reconciliation earns its cost. (Word-set Jaccard, words >2 chars.) */
export function divergence(a: string, b: string): number {
  const norm = (s: string) =>
    new Set(s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2));
  const A = norm(a);
  const B = norm(b);
  if (A.size === 0 && B.size === 0) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter += 1;
  const union = A.size + B.size - inter;
  const jaccard = union === 0 ? 1 : inter / union;
  return Math.round((1 - jaccard) * 100) / 100;
}

function debateTracePath(): string {
  const home = getRuntimeEnv('CLEMENTINE_HOME', '') || path.join(homedir(), '.clementine-next');
  return path.join(home, 'state', 'debate-traces.jsonl');
}

/** Append one debate record as JSONL. Best-effort — tracing must NEVER affect a
 *  turn. Disabled under tests so the suite doesn't write to the real home. */
const TRACE_MAX_BYTES = 2_000_000;
const TRACE_KEEP_LINES = 400;
function recordDebateTrace(rec: Record<string, unknown>): void {
  if (process.env.NODE_ENV === 'test') return;
  // Mirror the fusion judge/checker outcome into the operational store so the
  // dashboard sees the otherwise-invisible reconciliation turn (a judge_verdict
  // for every debate/verify pass). Best-effort — never affects the turn.
  try {
    recordOperationalEvent({
      source: 'safety',
      type: 'judge_verdict',
      sessionId: harnessRunContextStorage.getStore()?.sessionId,
      actor: 'fusion',
      payload: {
        judge: rec.path === 'verify' ? 'verify_checker' : 'debate',
        ...(typeof rec.judge === 'string' ? { judgeModel: rec.judge } : {}),
        outcome: typeof rec.outcome === 'string' ? rec.outcome : 'reconciled',
        ...(typeof rec.divergence === 'number' ? { divergence: rec.divergence } : {}),
        ...(typeof rec.n === 'number' ? { n: rec.n } : {}),
      },
    });
  } catch {
    /* operational mirror is best-effort */
  }
  try {
    const p = debateTracePath();
    mkdirSync(path.dirname(p), { recursive: true });
    appendFileSync(p, `${JSON.stringify({ ts: new Date().toISOString(), ...rec })}\n`);
    // Bound the file: when it crosses the cap, keep the last N rows. Stops
    // unbounded growth and keeps readRecentDebateTraces' whole-file read cheap.
    try {
      if (statSync(p).size > TRACE_MAX_BYTES) {
        const kept = readFileSync(p, 'utf-8').split('\n').filter(Boolean).slice(-TRACE_KEEP_LINES);
        writeFileSync(p, `${kept.join('\n')}\n`);
      }
    } catch {
      /* best-effort trim */
    }
  } catch {
    /* best-effort */
  }
}

/** Read the most recent debate trace rows (newest first) for the console UI.
 *  Best-effort: tolerates a missing file and partial/corrupt lines, never throws. */
export function readRecentDebateTraces(limit = 40): Array<Record<string, unknown>> {
  try {
    const p = debateTracePath();
    if (!existsSync(p)) return [];
    const lines = readFileSync(p, 'utf-8').split('\n').filter(Boolean);
    const n = Math.min(Math.max(1, Math.floor(limit)), 500);
    const out: Array<Record<string, unknown>> = [];
    for (const l of lines.slice(-n)) {
      try { out.push(JSON.parse(l)); } catch { /* skip a partial/corrupt line */ }
    }
    return out.reverse();
  } catch {
    return [];
  }
}

function errText(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/** Wrap a provider with debate IF the mode is on and two flagships are available;
 *  otherwise return it untouched. Call this at each provider-registration site. */
export function maybeWrapDebate(passthrough: ModelProvider, opts: DebateOptions = {}): ModelProvider {
  if (!isDebateModeEnabled()) return passthrough;
  // Resolve once to confirm both brains exist; if not, skip the wrapper entirely.
  if (!resolveDebateBrains(passthrough)) {
    logger.info('CLEMMY_DEBATE_MODE is set but two distinct flagships are not both available — debate disabled');
    return passthrough;
  }
  void getActiveAuthMode(); // (auth mode currently informational; passthrough already encodes it)
  logger.info({ mode: debateMode(), judge: judgeTraceLabel() }, 'fusion debate ENABLED — Claude+Codex draft, judge reconciles');
  return new DebateModelProvider(passthrough, opts);
}
