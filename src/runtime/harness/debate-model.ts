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
import { loadClaudeAccessToken } from '../claude-oauth.js';
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
  /** Injected for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

export class DebateModel implements Model {
  constructor(private readonly brains: DebateBrains, private readonly opts: DebateOptions = {}) {}

  private get hb(): number {
    return this.opts.heartbeatMs ?? heartbeatMs();
  }
  private get sleep(): (ms: number) => Promise<void> {
    return this.opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    if (!shouldDebate(request)) return this.brains.passthrough.getResponse(request);
    const { a, b } = await this.draftBoth(request);
    if (!a || !b) {
      const survivor = a ?? b;
      if (survivor) return survivor;
      logger.warn('both debate drafts failed — falling back to a single passthrough answer');
      return this.brains.passthrough.getResponse(request);
    }
    return this.brains.judge.getResponse(buildJudgeRequest(request, a, b));
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    if (!shouldDebate(request)) {
      // Not a debate turn: forward the normal brain verbatim (response_started,
      // deltas, response_done all pass through unchanged).
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
        yield* streamResponseAsEvents(survivor);
        return;
      }
      logger.warn('both debate drafts failed — streaming a single passthrough answer');
      yield* dropResponseStarted(this.brains.passthrough.getStreamedResponse(request));
      return;
    }

    // Two drafts in hand: the judge reconciles, streamed live as the final answer.
    yield* dropResponseStarted(this.brains.judge.getStreamedResponse(buildJudgeRequest(request, a, b)));
  }

  /** Draft on both brains in parallel. A non-overload rejection (already post the
   *  brain's own retry budget) drops that draft to null — fail open to the other. */
  private async draftBoth(request: ModelRequest): Promise<{ a: ModelResponse | null; b: ModelResponse | null }> {
    const [ra, rb] = await Promise.allSettled([
      this.brains.draftA.getResponse(request),
      this.brains.draftB.getResponse(request),
    ]);
    const a = ra.status === 'fulfilled' ? ra.value : null;
    const b = rb.status === 'fulfilled' ? rb.value : null;
    if (!a) logger.warn({ err: errText((ra as PromiseRejectedResult).reason) }, 'debate draft A failed (fail-open)');
    if (!b) logger.warn({ err: errText((rb as PromiseRejectedResult).reason) }, 'debate draft B failed (fail-open)');
    return { a, b };
  }
}

// ---------------------------------------------------------------------------
// Provider + brain assembly
// ---------------------------------------------------------------------------

export class DebateModelProvider implements ModelProvider {
  constructor(private readonly passthrough: ModelProvider, private readonly opts: DebateOptions = {}) {}

  getModel(modelName?: string): Model | Promise<Model> {
    const brains = resolveDebateBrains(this.passthrough, modelName);
    // No two distinct flagships available → behave exactly like the normal provider.
    if (!brains) return this.passthrough.getModel(modelName);
    return new DebateModel(brains, this.opts);
  }
}

function claudeAvailable(): boolean {
  try {
    loadClaudeAccessToken();
    return true;
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
].join(' ');

/** Build the judge's request: the original request UNCHANGED (tools, modelSettings,
 *  outputType/handoffs all preserved so structured output + tool use still work),
 *  with the two drafts appended to the system instructions as text. Augmenting the
 *  instruction string (not the input items) keeps it shape-safe across providers. */
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

/** Replay a buffered ModelResponse as a stream (text delta + a final
 *  response_done carrying the full output). Used for the single-survivor
 *  fail-open path. No response_started — the caller already emitted one. */
export function* streamResponseAsEvents(resp: ModelResponse): Generator<StreamEvent> {
  const text = extractAssistantText(resp.output);
  if (text) {
    yield { type: 'output_text_delta', delta: text } as unknown as StreamEvent;
  }
  yield {
    type: 'response_done',
    response: { output: resp.output, usage: (resp as { usage?: unknown }).usage ?? {} },
  } as unknown as StreamEvent;
}

/** Forward a stream but drop its response_started (we emit our own single one). */
async function* dropResponseStarted(stream: AsyncIterable<StreamEvent>): AsyncGenerator<StreamEvent> {
  for await (const ev of stream) {
    if ((ev as { type?: string }).type === 'response_started') continue;
    yield ev;
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
