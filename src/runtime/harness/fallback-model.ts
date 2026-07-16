/**
 * fallback-model — try an ordered chain of brains, advancing when a brain is
 * UNAVAILABLE (overloaded 529, a 5xx, OR a transport TIMEOUT — the request hung
 * with no response), after that brain has already burned its own transparent
 * retry budget. The chain for the Claude brain is:
 *
 *     Opus 4.8  ->  Sonnet 4.6  ->  Codex (gpt-5.x, only if a Codex login exists)
 *
 * Why these classes: a 529 is per-MODEL capacity (Opus is the most contended on
 * Max/Pro; Sonnet/Codex are far less so) so switching genuinely helps; and when
 * Anthropic is at capacity it frequently HANGS rather than returning a clean 529
 * (model.transport_timeout) — gating on overload-only meant the chain never
 * advanced on that, the dominant real-world failure, so a hung Claude took the
 * turn down instead of falling over. A 429 is your ACCOUNT-wide quota — switching
 * Claude models won't help — so we do NOT fall back on it (the resilient wrapper
 * backs off + surfaces). Codex is a different provider, so it survives an
 * Anthropic-wide incident.
 *
 * Retry-safety: for a streamed turn we may only switch BEFORE any event has been
 * yielded to the Runner. The resilient wrapper buffers metadata and yields
 * nothing until it commits on real content, so "no event yielded yet" === "no
 * real content escaped" — switching then can never duplicate a reply.
 *
 * This is the seam the future Codex+Claude "fusion" routing will build on.
 */
import type { Model, ModelRequest, ModelResponse } from '@openai/agents-core';
import type { StreamEvent } from '@openai/agents-core/types';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BoundaryError } from '../boundary-error.js';
import { classifyModelError } from './resilient-model.js';
import { BASE_DIR, getRuntimeEnv } from '../../config.js';
import { recordOperationalEvent } from '../operational-telemetry.js';
import { addNotification } from '../notifications.js';
import pino from 'pino';

const logger = pino({ name: 'clementine.fallback-model' });

/**
 * TEST KNOB: pretend the first N brains in the chain are OVERLOADED so the
 * fallback fires deterministically (a real 529 can't be forced). DOUBLE-GATED —
 * only honored under NODE_ENV=test OR CLEMMY_DEV_OVERRIDES=1, so production can
 * never trip it. `CLEMMY_FORCE_CLAUDE_OVERLOAD=1` skips Opus -> Sonnet answers;
 * `=2` skips Opus+Sonnet -> Codex answers.
 */
export function forcedOverloadDepth(): number {
  const raw = (getRuntimeEnv('CLEMMY_FORCE_CLAUDE_OVERLOAD', '') || '').trim().toLowerCase();
  if (!raw || raw === 'off' || raw === '0') return 0;
  if (process.env.NODE_ENV !== 'test' && (getRuntimeEnv('CLEMMY_DEV_OVERRIDES', '') || '') !== '1') return 0;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 1; // '1'/'on'/'true' => depth 1
}

export interface FallbackTarget {
  label: string;
  /** Lazily build the Model — a fallback is only constructed if it's reached. */
  getModel: () => Model;
  /** Optional request-capability guard. A target that cannot honor the request
   *  (for example a text-only transport on a tool-bearing turn) is skipped. */
  supportsRequest?: (request: ModelRequest) => boolean;
}

export interface FallbackOptions {
  /**
   * Also fall over on a 429 (rate-limited). OFF by default because for a SAME-
   * provider tier chain (Opus -> Sonnet) a 429 is account-wide and switching
   * tiers won't help. Turn ON for a CROSS-PROVIDER chain (GLM -> Codex -> Claude)
   * where a 429 on one provider has nothing to do with the next provider's quota
   * — there, a 429 SHOULD switch brains. This is the proactive-fallover lever.
   */
  falloverOn429?: boolean;
  /**
   * If a brain sends NO first stream event within this many ms, treat it as a
   * hang and fall over to the NEXT brain (the dominant real-world failure: a
   * provider accepts the request then goes silent). Applies only to non-last
   * brains — the last brain keeps the full per-request budget (the loop's stall
   * watchdog is its backstop). 0/undefined disables. Set BELOW the loop's
   * first-byte stall window so the hang becomes a fallover, not a dead-end.
   */
  firstByteTimeoutMs?: number;
  /** Correlation for the model_fallover telemetry — without these the emit is
   *  session-blind and the dashboard can't attribute a fallover to the run that
   *  triggered it. Threaded from router-model.ts off the active harness run
   *  context; optional so non-harness callers are unaffected. */
  sessionId?: string;
  workflowRunId?: string;
}

/** A brain went silent past the first-byte fallover budget — switch brains. */
class FirstByteTimeoutError extends Error {
  constructor(public readonly ms: number) {
    super(`no first stream event within ${ms}ms`);
    this.name = 'FirstByteTimeoutError';
  }
}

/** True when an error means the model is OVERLOADED (529 / overloaded_error) —
 *  the only condition that warrants switching models. Detects both the raw AI
 *  SDK error and a BoundaryError the resilient wrapper may have thrown. */
export function isOverloadError(err: unknown): boolean {
  if (err instanceof BoundaryError) return err.kind === 'model.overloaded';
  return classifyModelError(err).kind === 'model.overloaded';
}

/** True when an error means the brain is UNAVAILABLE and a DIFFERENT brain is
 *  worth trying: overloaded (529), a 5xx, OR a transport TIMEOUT (the request
 *  hung with no response). The timeout is the load-bearing case — when Anthropic
 *  is at capacity it often does NOT return a clean 529, it HANGS
 *  (model.transport_timeout, after the resilient wrapper burns its retries).
 *  Gating fallback on overload-only meant the chain never advanced on the failure
 *  that actually happens in the wild, so a hung Claude took the whole turn down
 *  ("Overloaded") instead of falling over. 429 (rate_limited) is deliberately
 *  EXCLUDED — that's account-wide quota; switching Claude tiers won't help (the
 *  resilient wrapper backs off + surfaces it). */
/** An AUTH failure on a brain — expired/invalid subscription token, 401/403,
 *  reauth-required. RECOVERABLE by switching to a brain whose auth is valid, so
 *  it must not be treated as terminal. This is the class that let one ~10-day
 *  Claude OAuth lapse hard-fail whole scheduled batches (07-06 audit). Shared by
 *  the chat + workflow brain lanes (both route through FallbackModel). */
export function isAuthRecoverableError(err: unknown): boolean {
  if (err instanceof Error && err.name === 'ClaudeAuthError') return true;
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return /\b(401|403)\b/.test(msg)
    || /invalid_grant|refresh token not found or invalid|token (?:is invalid)|expired (?:token|credential|subscription)|(?:token|credential|subscription|session)s? (?:has |have )?expired|re-?authenticat|unauthorized|forbidden|not authenticated/i.test(msg);
}

// ── Sticky dead-brain registry (2026-07-08) ────────────────────────────────
// An auth-expired brain does NOT heal by itself — yet the chain re-tried the
// dead brain on EVERY request, burning a full auth round-trip (or a 75s
// first-byte wait) per turn before falling over. Live logs showed 25 such
// fallovers over two days while both OAuth grants were dead: the user felt it
// as "every turn is slow". Marking is per-LABEL with a cooldown, not forever:
// re-auth can happen any time, so after the cooldown the brain gets one probe
// again; the explicit re-auth/switch flows call reviveDeadBrains() so recovery
// is instant. Only AUTH failures stick — overload/timeout/5xx stay per-request
// (they genuinely heal in seconds). The user-facing surface is ONE operational
// event + ONE error log per dead-marking, not a warning per turn.
interface DeadBrainEntry { reason: string; since: number; until: number }
const deadBrains = new Map<string, DeadBrainEntry>();
const DEAD_BRAINS_FILE = path.join(BASE_DIR, 'state', 'brain-auth-dead.json');
let deadBrainsFile = DEAD_BRAINS_FILE;
let deadBrainsLoaded = false;

interface SilentBrainEntry { reason: string; firstAt: number; lastAt: number; count: number; until: number }
const silentBrains = new Map<string, SilentBrainEntry>();
const SILENT_BRAINS_FILE = path.join(BASE_DIR, 'state', 'brain-silent-cooldown.json');
let silentBrainsFile = SILENT_BRAINS_FILE;
let silentBrainsLoaded = false;

function authDeadCooldownMs(): number {
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_AUTH_DEAD_BRAIN_COOLDOWN_MS', '900000') ?? '900000', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 900_000; // default 15 min
}

function silentBrainThreshold(): number {
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_SILENT_BRAIN_THRESHOLD', '2') ?? '2', 10);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 2;
}

function silentBrainWindowMs(): number {
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_SILENT_BRAIN_WINDOW_MS', '600000') ?? '600000', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 600_000; // 10 min
}

function silentBrainCooldownMs(): number {
  const raw = Number.parseInt(getRuntimeEnv('CLEMMY_SILENT_BRAIN_COOLDOWN_MS', '300000') ?? '300000', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 300_000; // 5 min
}

function loadDeadBrains(): void {
  if (deadBrainsLoaded) return;
  deadBrainsLoaded = true;
  if (!existsSync(deadBrainsFile)) return;
  try {
    const parsed = JSON.parse(readFileSync(deadBrainsFile, 'utf-8')) as Record<string, Partial<DeadBrainEntry>>;
    const now = Date.now();
    for (const [label, entry] of Object.entries(parsed)) {
      if (
        typeof label === 'string' &&
        typeof entry.reason === 'string' &&
        typeof entry.since === 'number' &&
        typeof entry.until === 'number' &&
        entry.until > now
      ) {
        deadBrains.set(label, { reason: entry.reason, since: entry.since, until: entry.until });
      }
    }
    if (deadBrains.size === 0) {
      try { rmSync(deadBrainsFile, { force: true }); } catch { /* ignore */ }
    }
  } catch {
    try { rmSync(deadBrainsFile, { force: true }); } catch { /* ignore */ }
  }
}

function persistDeadBrains(): void {
  const now = Date.now();
  for (const [label, entry] of deadBrains) {
    if (entry.until <= now) deadBrains.delete(label);
  }
  if (deadBrains.size === 0) {
    try { rmSync(deadBrainsFile, { force: true }); } catch { /* ignore */ }
    return;
  }
  const obj = Object.fromEntries(deadBrains);
  try {
    mkdirSync(path.dirname(deadBrainsFile), { recursive: true });
    writeFileSync(deadBrainsFile, JSON.stringify(obj, null, 2), { encoding: 'utf-8', mode: 0o600 });
    try { chmodSync(deadBrainsFile, 0o600); } catch { /* best-effort */ }
  } catch { /* best-effort; in-memory registry still protects this process */ }
}

function loadSilentBrains(): void {
  if (silentBrainsLoaded) return;
  silentBrainsLoaded = true;
  if (!existsSync(silentBrainsFile)) return;
  try {
    const parsed = JSON.parse(readFileSync(silentBrainsFile, 'utf-8')) as Record<string, Partial<SilentBrainEntry>>;
    const now = Date.now();
    for (const [label, entry] of Object.entries(parsed)) {
      if (
        typeof label === 'string' &&
        typeof entry.reason === 'string' &&
        typeof entry.firstAt === 'number' &&
        typeof entry.lastAt === 'number' &&
        typeof entry.count === 'number' &&
        typeof entry.until === 'number' &&
        (entry.until > now || now - entry.lastAt <= silentBrainWindowMs())
      ) {
        silentBrains.set(label, {
          reason: entry.reason,
          firstAt: entry.firstAt,
          lastAt: entry.lastAt,
          count: Math.max(1, Math.floor(entry.count)),
          until: entry.until,
        });
      }
    }
    if (silentBrains.size === 0) {
      try { rmSync(silentBrainsFile, { force: true }); } catch { /* ignore */ }
    }
  } catch {
    try { rmSync(silentBrainsFile, { force: true }); } catch { /* ignore */ }
  }
}

function persistSilentBrains(): void {
  const now = Date.now();
  for (const [label, entry] of silentBrains) {
    if (entry.until <= now && now - entry.lastAt > silentBrainWindowMs()) silentBrains.delete(label);
  }
  if (silentBrains.size === 0) {
    try { rmSync(silentBrainsFile, { force: true }); } catch { /* ignore */ }
    return;
  }
  const obj = Object.fromEntries(silentBrains);
  try {
    mkdirSync(path.dirname(silentBrainsFile), { recursive: true });
    writeFileSync(silentBrainsFile, JSON.stringify(obj, null, 2), { encoding: 'utf-8', mode: 0o600 });
    try { chmodSync(silentBrainsFile, 0o600); } catch { /* best-effort */ }
  } catch { /* best-effort; in-memory registry still protects this process */ }
}

export function markBrainAuthDead(label: string, reason: string, correlation?: { sessionId?: string; workflowRunId?: string }): void {
  loadDeadBrains();
  const now = Date.now();
  const existing = deadBrains.get(label);
  deadBrains.set(label, { reason, since: existing?.since ?? now, until: now + authDeadCooldownMs() });
  persistDeadBrains();
  if (existing) return; // already surfaced — just extend the cooldown
  logger.error(
    { brain: label, reason, cooldownMs: authDeadCooldownMs() },
    'brain auth is dead — skipping this brain until re-auth (reconnect it from Settings → Models)',
  );
  recordOperationalEvent({
    source: 'model',
    type: 'brain_auth_dead',
    severity: 'error',
    actor: 'fallback-model',
    sessionId: correlation?.sessionId,
    workflowRunId: correlation?.workflowRunId,
    payload: { brain: label, reason },
  });
  // ONE user-facing reconnect card per dead brain (stable id = at-most-once;
  // addNotification dedupes on id). Chat keeps working on the fallover brain —
  // this card is how the user learns WHY things route differently and what to
  // press, instead of 25 silent per-turn log warnings.
  try {
    addNotification({
      id: `brain-auth-dead-${label}`,
      kind: 'system',
      title: `Reconnect ${label} — its login expired`,
      body: `The ${label} brain failed with "${reason}" and is paused until you reconnect it (Settings → Models). Conversations continue on the fallback brain meanwhile.`,
      createdAt: new Date().toISOString(),
      read: false,
      metadata: { brain: label, reason, source: 'fallback-model' },
    });
  } catch { /* notification is best-effort */ }
}

export function isBrainAuthDead(label: string): boolean {
  loadDeadBrains();
  const entry = deadBrains.get(label);
  if (!entry) return false;
  if (Date.now() >= entry.until) { deadBrains.delete(label); persistDeadBrains(); return false; }
  return true;
}

function silentFailureReason(err: unknown): string | null {
  if (err instanceof FirstByteTimeoutError) return 'first-byte-timeout';
  const kind = normalizedModelFailureReason(err);
  return kind === 'model.transport_timeout' ? kind : null;
}

export function isBrainSilenced(label: string): boolean {
  loadSilentBrains();
  const entry = silentBrains.get(label);
  if (!entry) return false;
  if (Date.now() >= entry.until) {
    if (Date.now() - entry.lastAt > silentBrainWindowMs()) silentBrains.delete(label);
    else entry.until = 0;
    persistSilentBrains();
    return false;
  }
  return entry.until > 0;
}

function clearBrainSilentFailure(label: string): void {
  loadSilentBrains();
  if (!silentBrains.delete(label)) return;
  persistSilentBrains();
}

function recordBrainSilentFailure(label: string, err: unknown, correlation?: { sessionId?: string; workflowRunId?: string }): void {
  const reason = silentFailureReason(err);
  if (!reason) return;
  loadSilentBrains();
  const now = Date.now();
  const existing = silentBrains.get(label);
  const inWindow = existing ? now - existing.firstAt <= silentBrainWindowMs() : false;
  const count = inWindow && existing ? existing.count + 1 : 1;
  const firstAt = inWindow && existing ? existing.firstAt : now;
  const alreadySilenced = Boolean(existing && existing.until > now);
  const shouldSilence = count >= silentBrainThreshold();
  silentBrains.set(label, {
    reason,
    firstAt,
    lastAt: now,
    count,
    until: shouldSilence ? now + silentBrainCooldownMs() : 0,
  });
  persistSilentBrains();
  if (!shouldSilence || alreadySilenced) return;
  logger.warn(
    { brain: label, reason, failures: count, windowMs: silentBrainWindowMs(), cooldownMs: silentBrainCooldownMs() },
    'brain repeatedly silent before content — skipping this brain briefly',
  );
  recordOperationalEvent({
    source: 'model',
    type: 'brain_silent_cooldown',
    severity: 'warn',
    actor: 'fallback-model',
    sessionId: correlation?.sessionId,
    workflowRunId: correlation?.workflowRunId,
    payload: { brain: label, reason, failures: count, cooldownMs: silentBrainCooldownMs() },
  });
}

/** Called by the re-auth / brain-switch flows: a fresh grant (or an explicit
 *  user choice) must get an immediate probe, not wait out the cooldown. */
export function reviveDeadBrains(label?: string): void {
  loadDeadBrains();
  loadSilentBrains();
  if (label === undefined) deadBrains.clear();
  else deadBrains.delete(label);
  if (label === undefined) silentBrains.clear();
  else silentBrains.delete(label);
  persistDeadBrains();
  persistSilentBrains();
}

/** True when this error is the auth class that should stick. */
function isAuthDeadReason(err: unknown): boolean {
  const kind = err instanceof BoundaryError ? err.kind : classifyModelError(err).kind;
  return kind === 'model.auth_expired' || isAuthRecoverableError(err);
}

function normalizedModelFailureReason(err: unknown): string {
  const kind = err instanceof BoundaryError ? err.kind : classifyModelError(err).kind;
  return kind === 'runtime.unknown' && isAuthRecoverableError(err) ? 'model.auth_expired' : kind;
}

export function isFalloverError(err: unknown): boolean {
  const kind = err instanceof BoundaryError ? err.kind : classifyModelError(err).kind;
  if (kind === 'model.overloaded' || kind === 'model.http_5xx' || kind === 'model.transport_timeout') return true;
  // Auth failure on THIS brain → switch to a brain whose auth is valid rather
  // than hard-failing the turn/run.
  if (isAuthRecoverableError(err)) return true;
  return false;
}

export class FallbackModel implements Model {
  constructor(private readonly chain: FallbackTarget[], private readonly opts: FallbackOptions = {}) {}

  /** Does this error warrant switching brains? Overload/5xx/timeout always; a
   *  429 only when this chain opted in (cross-provider). */
  private shouldFallover(err: unknown): boolean {
    if (isFalloverError(err)) return true;
    if (this.opts.falloverOn429) {
      const kind = err instanceof BoundaryError ? err.kind : classifyModelError(err).kind;
      return kind === 'model.rate_limited';
    }
    return false;
  }

  /** First filter by request capability, then remove brains whose auth is dead
   *  or which repeatedly went silent. If every compatible brain is cooling
   *  down, probe the compatible set again; never fall through to an
   *  incompatible transport merely because it is available. */
  private liveChain(request: ModelRequest): FallbackTarget[] {
    const compatible = this.chain.filter((target) => target.supportsRequest?.(request) !== false);
    if (compatible.length === 0) {
      throw new Error('fallback chain has no provider compatible with this request');
    }
    const alive = compatible.filter((t) => !isBrainAuthDead(t.label) && !isBrainSilenced(t.label));
    return alive.length > 0 ? alive : compatible;
  }

  /** Sticky-mark a brain whose failure was an auth failure (dead until re-auth
   *  or cooldown). Called on EVERY auth-class error — including the last brain's
   *  — so the very next request routes around it. */
  private markIfAuthDead(chain: FallbackTarget[], i: number, err: unknown): void {
    if (!isAuthDeadReason(err)) return;
    const reason = normalizedModelFailureReason(err);
    markBrainAuthDead(chain[i].label, reason, { sessionId: this.opts.sessionId, workflowRunId: this.opts.workflowRunId });
  }

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const forced = forcedOverloadDepth();
    const chain = this.liveChain(request);
    for (let i = 0; i < chain.length; i++) {
      const isLast = i >= chain.length - 1;
      if (i < forced && !isLast) {
        logger.warn({ forced: true, from: chain[i].label, to: chain[i + 1].label }, 'FORCED overload (test knob) — falling back to the next brain');
        continue;
      }
      const { request: req, cleanup } = this.linkAbort(request);
      try {
        const call = chain[i].getModel().getResponse(req);
        const result = await this.withFirstByteTimeout(call, isLast, () => cleanup(true));
        cleanup(false);
        clearBrainSilentFailure(chain[i].label);
        return result;
      } catch (err) {
        cleanup(true); // release a hung request
        this.markIfAuthDead(chain, i, err);
        recordBrainSilentFailure(chain[i].label, err, { sessionId: this.opts.sessionId, workflowRunId: this.opts.workflowRunId });
        if (this.isFalloverReason(err) && !isLast) {
          this.logFallover(chain, i, err);
          continue;
        }
        throw err;
      }
    }
    throw new Error('fallback chain exhausted'); // unreachable (chain non-empty)
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    const forced = forcedOverloadDepth();
    const chain = this.liveChain(request);
    for (let i = 0; i < chain.length; i++) {
      const isLast = i >= chain.length - 1;
      if (i < forced && !isLast) {
        logger.warn({ forced: true, from: chain[i].label, to: chain[i + 1].label }, 'FORCED overload (test knob) — falling back to the next brain');
        continue;
      }
      const { request: req, cleanup } = this.linkAbort(request);
      let yieldedAny = false;
      try {
        const it = chain[i].getModel().getStreamedResponse(req)[Symbol.asyncIterator]();
        // First event raced against the first-byte fallover budget (non-last brains).
        const firstNext = it.next();
        firstNext.catch(() => {}); // a lost race must not throw unhandled
        let cur = await this.withFirstByteTimeout(firstNext, isLast, () => cleanup(true));
        while (!cur.done) {
          yieldedAny = true; // first yield === committed on real content; no more fallover
          yield cur.value;
          cur = await it.next();
        }
        cleanup(false);
        clearBrainSilentFailure(chain[i].label);
        return; // streamed to completion
      } catch (err) {
        cleanup(true); // release a hung brain
        this.markIfAuthDead(chain, i, err);
        recordBrainSilentFailure(chain[i].label, err, { sessionId: this.opts.sessionId, workflowRunId: this.opts.workflowRunId });
        // Switch only if NOTHING reached the Runner yet (else we'd duplicate a
        // partially-streamed reply) and a next brain exists.
        if (!yieldedAny && this.isFalloverReason(err) && !isLast) {
          this.logFallover(chain, i, err);
          continue;
        }
        throw err;
      }
    }
  }

  private isFalloverReason(err: unknown): boolean {
    return err instanceof FirstByteTimeoutError || this.shouldFallover(err);
  }

  private logFallover(chain: FallbackTarget[], i: number, err: unknown): void {
    const reason = err instanceof FirstByteTimeoutError ? 'first-byte-timeout' : normalizedModelFailureReason(err);
    logger.warn(
      {
        from: chain[i].label,
        to: chain[i + 1].label,
        reason,
      },
      'brain unavailable — falling over to the next brain',
    );
    recordOperationalEvent({
      source: 'model',
      type: 'model_fallover',
      severity: 'warn',
      actor: 'fallback-model',
      sessionId: this.opts.sessionId,
      workflowRunId: this.opts.workflowRunId,
      payload: {
        from: chain[i].label,
        to: chain[i + 1].label,
        reason,
        stage: 'router',
      },
    });
  }

  /** Race a model call's first result against the first-byte timeout (only for a
   *  non-last brain with a configured budget). On timeout, abort and throw
   *  FirstByteTimeoutError so the caller advances to the next brain. */
  private async withFirstByteTimeout<T>(call: Promise<T>, isLast: boolean, abort: () => void): Promise<T> {
    const ms = this.opts.firstByteTimeoutMs;
    if (isLast || !ms || ms <= 0) return call;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        call,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => { abort(); reject(new FirstByteTimeoutError(ms)); }, ms);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Per-attempt AbortController linked to the caller's signal, so a first-byte
   *  timeout (or the caller cancelling) actually releases the hung request. */
  private linkAbort(request: ModelRequest): { request: ModelRequest; cleanup: (aborted: boolean) => void } {
    const controller = new AbortController();
    const parent = (request as { signal?: AbortSignal }).signal;
    const onParentAbort = () => controller.abort();
    if (parent) {
      if (parent.aborted) controller.abort();
      else parent.addEventListener('abort', onParentAbort, { once: true });
    }
    return {
      request: { ...request, signal: controller.signal } as ModelRequest,
      cleanup: (aborted: boolean) => {
        if (parent) parent.removeEventListener('abort', onParentAbort);
        if (aborted) { try { controller.abort(); } catch { /* best-effort */ } }
      },
    };
  }
}

/** Wrap an ordered chain of brains with fallover. A single-element chain is
 *  returned as-is (no wrapper overhead) UNLESS a first-byte timeout is requested
 *  (a lone brain still benefits from converting a hang into a clean error). */
export function withModelFallback(chain: FallbackTarget[], opts: FallbackOptions = {}): Model {
  if (chain.length === 0) throw new Error('withModelFallback: empty chain');
  if (chain.length === 1 && !opts.firstByteTimeoutMs && !chain[0].supportsRequest) return chain[0].getModel();
  return new FallbackModel(chain, opts);
}

export const __test__ = {
  setDeadBrainsFileForTests(file: string | null): void {
    deadBrainsFile = file ?? DEAD_BRAINS_FILE;
    deadBrains.clear();
    deadBrainsLoaded = false;
  },
  resetDeadBrainsMemoryForTests(): void {
    deadBrains.clear();
    deadBrainsLoaded = false;
  },
  getDeadBrainEntryForTests(label: string): DeadBrainEntry | null {
    loadDeadBrains();
    return deadBrains.get(label) ?? null;
  },
  setSilentBrainsFileForTests(file: string | null): void {
    silentBrainsFile = file ?? SILENT_BRAINS_FILE;
    silentBrains.clear();
    silentBrainsLoaded = false;
  },
  resetSilentBrainsMemoryForTests(): void {
    silentBrains.clear();
    silentBrainsLoaded = false;
  },
  getSilentBrainEntryForTests(label: string): SilentBrainEntry | null {
    loadSilentBrains();
    return silentBrains.get(label) ?? null;
  },
};
