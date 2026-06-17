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
import { getRuntimeEnv, getActiveAuthMode, getClaudeBrainModel } from '../../config.js';
import { getClaudeModel } from './claude-model.js';
import { CodexModelProvider } from './codex-model.js';
import { getStoredCodexOAuthTokens } from '../auth-store.js';
import { getStoredClaudeTokens } from '../claude-oauth.js';
import { harnessRunContextStorage } from './brackets.js';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
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
export function judgeChoice(): 'claude' | 'codex' {
  return (getRuntimeEnv('CLEMMY_DEBATE_JUDGE', 'claude') || 'claude').trim().toLowerCase() === 'codex'
    ? 'codex'
    : 'claude';
}

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

/** Max debated iterations per user MESSAGE. The model is resolved once per run
 *  (SDK #resolveModelForAgent), so the DebateModel instance persists across a
 *  message's loop iterations and this counter is a true per-message cap.
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

/** High-stakes heuristic for mode=high. A v1 proxy (replaceable by a proper
 *  classifier / the Seam-B write-boundary signal): a long/complex request, or a
 *  tool-enabled (agentic, consequential) turn. Deliberately conservative. */
function isHighStakes(request: ModelRequest): boolean {
  const text = renderRequestText(request);
  if (text.length >= 800) return true;
  const tools = (request as { tools?: unknown[] }).tools;
  if (Array.isArray(tools) && tools.length > 0 && text.length >= 200) return true;
  return /\b(send|publish|deploy|delete|migrate|launch|production|irreversible|invoice|contract|proposal)\b/i.test(text);
}

export function shouldDebate(request: ModelRequest): boolean {
  const mode = debateMode();
  if (mode === 'off') return false;
  if (mode === 'all') return true;
  return isHighStakes(request);
}

/** Flatten a request's input (string or items) + nothing else into plain text for
 *  the high-stakes heuristic. Defensive across the string/array input shapes. */
function renderRequestText(request: ModelRequest): string {
  const input = (request as { input?: unknown }).input;
  if (typeof input === 'string') return input;
  if (!Array.isArray(input)) return '';
  const parts: string[] = [];
  for (const item of input) {
    const it = item as { content?: unknown; text?: unknown };
    if (typeof it.content === 'string') parts.push(it.content);
    else if (Array.isArray(it.content)) {
      for (const c of it.content) {
        const cc = c as { text?: unknown };
        if (typeof cc.text === 'string') parts.push(cc.text);
      }
    } else if (typeof it.text === 'string') parts.push(it.text);
  }
  return parts.join(' ');
}

/** Some ModelProviders may return Model | Promise<Model>; every in-repo provider
 *  (Claude/Codex/Router) resolves synchronously, which debate relies on. */
function resolveSync(m: Model | Promise<Model>): Model {
  if (m && typeof (m as { then?: unknown }).then === 'function') {
    throw new Error('debate: passthrough provider returned an async Model — unsupported by the fusion layer');
  }
  return m as Model;
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
  private get sleep(): (ms: number) => Promise<void> {
    return this.opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
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
    try {
      const final = await this.brains.judge.getResponse(buildJudgeRequest(request, a, b));
      logger.info({ path: 'getResponse', divergence: div, draftAlen: da.length, draftBlen: db.length, judge: judgeChoice() }, 'debate turn reconciled');
      recordDebateTrace({ path: 'getResponse', n: this.debatesThisTurn, divergence: div, judge: judgeChoice(), draftA: capText(da), draftB: capText(db), final: capText(extractAssistantText(final.output)) });
      return final;
    } catch (err) {
      // The judge failed AFTER two valid drafts — don't lose the turn; answer
      // from the stronger surviving draft instead of failing closed.
      logger.warn({ err: errText(err) }, 'debate judge failed — falling back to the longer surviving draft');
      recordDebateTrace({ path: 'getResponse', outcome: 'judge-failed-draft-fallback', divergence: div });
      return pickLongerDraft(a, b);
    }
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    if (!shouldDebate(request)) {
      // Not a debate turn (mode/stakes gate): forward the normal brain verbatim.
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
      yield* dropResponseStarted(this.brains.passthrough.getStreamedResponse(request));
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
    try {
      for await (const ev of this.brains.judge.getStreamedResponse(buildJudgeRequest(request, a, b))) {
        const e = ev as { type?: string; delta?: string; response?: { output?: unknown } };
        if (e.type === 'response_started') continue;
        if (e.type === 'output_text_delta' && typeof e.delta === 'string') { finalText += e.delta; judgeYieldedContent = true; }
        if (e.type === 'response_done' && e.response) judgeFinalOutput = e.response.output;
        yield ev;
      }
    } catch (err) {
      // Judge failed. If nothing user-visible was committed yet, recover by
      // replaying the stronger surviving draft (the response_started we already
      // emitted is reused). If content already streamed, we can't cleanly recover.
      if (judgeYieldedContent) throw err;
      logger.warn({ err: errText(err) }, 'debate judge stream failed pre-content — replaying the longer surviving draft');
      recordDebateTrace({ path: 'stream', outcome: 'judge-failed-draft-fallback', divergence: div });
      yield* streamResponseAsEvents(pickLongerDraft(a, b));
      return;
    }
    // FIX6: structured-output turns carry the answer in response_done.output, not
    // text deltas — fall back to that so the trace isn't under-reported.
    const finalForTrace = finalText || extractAssistantText(judgeFinalOutput);
    logger.info({ path: 'stream', divergence: div, draftAlen: da.length, draftBlen: db.length, finalLen: finalForTrace.length, judge: judgeChoice() }, 'debate turn reconciled');
    recordDebateTrace({ path: 'stream', n: this.debatesThisTurn, divergence: div, judge: judgeChoice(), draftA: capText(da), draftB: capText(db), final: capText(finalForTrace) });
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
    if (!extractAssistantText(draft.output).trim() || !this.spendFusionSlot()) {
      return draft;
    }
    try {
      const final = await this.brains.judge.getResponse(buildVerifyRequest(request, draft));
      recordDebateTrace({ path: 'verify', n: this.debatesThisTurn, judge: judgeChoice(), executor: capText(summarizeOutput(draft.output)), final: capText(extractAssistantText(final.output)) });
      return final;
    } catch (err) {
      // Checker failed → ship the executor's draft rather than lose the turn.
      logger.warn({ err: errText(err) }, 'fusion verify: checker failed — shipping the executor draft');
      recordDebateTrace({ path: 'verify', n: this.debatesThisTurn, outcome: 'checker-failed-ship-draft' });
      return draft;
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
      yield* dropResponseStarted(this.brains.judge.getStreamedResponse(request));
      return;
    }

    // Only spend a checker call on a real USER-FACING answer + under the cap —
    // otherwise ship the executor's draft as-is, so the fusion budget is never
    // wasted on tool-routing (focus_get) or other non-answer iterations.
    if (!extractAssistantText(draft.output).trim() || !this.spendFusionSlot()) {
      yield* streamResponseAsEvents(draft);
      return;
    }

    const da = summarizeOutput(draft.output);
    let finalText = '';
    let checkerOutput: unknown;
    let checkerYieldedContent = false;
    try {
      for await (const ev of this.brains.judge.getStreamedResponse(buildVerifyRequest(request, draft))) {
        const e = ev as { type?: string; delta?: string; response?: { output?: unknown } };
        if (e.type === 'response_started') continue;
        if (e.type === 'output_text_delta' && typeof e.delta === 'string') { finalText += e.delta; checkerYieldedContent = true; }
        if (e.type === 'response_done' && e.response) checkerOutput = e.response.output;
        yield ev;
      }
    } catch (err) {
      // Checker failed pre-content → ship the executor's draft (SDK-conformant).
      if (checkerYieldedContent) throw err;
      logger.warn({ err: errText(err) }, 'fusion verify: checker failed pre-content — shipping the executor draft');
      recordDebateTrace({ path: 'verify', n: this.debatesThisTurn, outcome: 'checker-failed-ship-draft' });
      yield* streamResponseAsEvents(draft);
      return;
    }
    const finalForTrace = finalText || extractAssistantText(checkerOutput);
    logger.info({ path: 'verify', n: this.debatesThisTurn, executorLen: da.length, finalLen: finalForTrace.length, judge: judgeChoice() }, 'fusion verify reconciled');
    recordDebateTrace({ path: 'verify', n: this.debatesThisTurn, judge: judgeChoice(), executor: capText(da), final: capText(finalForTrace) });
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

const CLAUDE_OAT_PREFIX = 'sk-ant-oat01';
/** Claude is "available" for debate if a SUBSCRIPTION (oat01) token is stored
 *  that is currently valid OR refreshable. The access token has an ~8h TTL and
 *  the real Claude request path AUTO-REFRESHES a vault token, so we must NOT
 *  disable debate just because the access token momentarily needs a refresh —
 *  doing so was a false-negative that silently dropped debate to single-brain
 *  (and self-perpetuated: no Claude call → no refresh → stays off). If a refresh
 *  ultimately fails, draftBoth fails open to the other brain. The oat01-only
 *  check preserves the billing guard (an api03 API key is never "available"). */
function claudeAvailable(): boolean {
  try {
    const t = getStoredClaudeTokens();
    if (!t?.accessToken?.startsWith(CLAUDE_OAT_PREFIX)) return false;
    if (t.refreshToken) return true; // refreshable → the request path will renew it
    return !t.expiresAt || t.expiresAt > Date.now() + 60_000; // non-refreshable → must be unexpired
  } catch {
    return false;
  }
}

function codexAvailable(): boolean {
  try {
    return Boolean(getStoredCodexOAuthTokens()?.accessToken);
  } catch {
    return false;
  }
}

/** Diagnostic: which flagships are logged in. Debate needs BOTH. */
export function debateBrainsAvailable(): { claude: boolean; codex: boolean } {
  return { claude: claudeAvailable(), codex: codexAvailable() };
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
export function resolveDebateBrains(passthrough: ModelProvider, modelName?: string): DebateBrains | null {
  const haveClaude = claudeAvailable();
  const haveCodex = codexAvailable();
  if (!haveClaude || !haveCodex) return null;

  const claude: Model = getClaudeModel(getClaudeBrainModel());
  const codex: Model = new CodexModelProvider().getModel();
  const judge: Model = judgeChoice() === 'codex' ? codex : claude;

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
export function buildJudgeRequest(request: ModelRequest, a: ModelResponse, b: ModelResponse): ModelRequest {
  const base = ((request as { systemInstructions?: string }).systemInstructions ?? '').toString();
  const draftA = summarizeOutput(a.output);
  const draftB = summarizeOutput(b.output);
  const block = [
    base,
    '',
    '=== TWO-MODEL DEBATE — RECONCILE THE DRAFTS BELOW ===',
    JUDGE_PREAMBLE,
    '',
    '--- DRAFT A ---',
    draftA || '(empty)',
    '',
    '--- DRAFT B ---',
    draftB || '(empty)',
    '=== END DEBATE DRAFTS ===',
  ].join('\n');
  return { ...request, systemInstructions: block } as ModelRequest;
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
  return { ...request, systemInstructions: block } as ModelRequest;
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
      output: resp.output,
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

/** Forward a stream but drop its response_started (we emit our own single one). */
async function* dropResponseStarted(stream: AsyncIterable<StreamEvent>): AsyncGenerator<StreamEvent> {
  for await (const ev of stream) {
    if ((ev as { type?: string }).type === 'response_started') continue;
    yield ev;
  }
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
function recordDebateTrace(rec: Record<string, unknown>): void {
  if (process.env.NODE_ENV === 'test') return;
  try {
    const p = debateTracePath();
    mkdirSync(path.dirname(p), { recursive: true });
    appendFileSync(p, `${JSON.stringify({ ts: new Date().toISOString(), ...rec })}\n`);
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
  logger.info({ mode: debateMode(), judge: judgeChoice() }, 'fusion debate ENABLED — Claude+Codex draft, judge reconciles');
  return new DebateModelProvider(passthrough, opts);
}
