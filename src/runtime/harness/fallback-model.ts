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
 * Retry-safety: for a streamed turn we may only switch before actionable model
 * output (assistant text, a tool call, or another durable continuation item)
 * has been yielded to the Runner. Metadata and private reasoning are buffered,
 * so a reasoning-only completion can be discarded and another brain can serve
 * the turn without duplicating a reply or a side effect.
 *
 * This is the seam the future Codex+Claude "fusion" routing will build on.
 */
import type { Model, ModelRequest, ModelResponse } from '@openai/agents-core';
import type { StreamEvent } from '@openai/agents-core/types';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { BoundaryError } from '../boundary-error.js';
import { classifyModelError } from './resilient-model.js';
import { isAuthRecoverableError } from '../../execution/transient-error.js';
import { BASE_DIR, getRuntimeEnv } from '../../config.js';
import { recordOperationalEvent } from '../operational-telemetry.js';
import { addNotification } from '../notifications.js';
import { harnessRunContextStorage } from './brackets.js';
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
  /** Truthful route identity for metrics/UI. `label` remains the human-facing
   * chain name, while these fields identify the provider/model that actually
   * served a rescued response. */
  provider?: string;
  model?: string;
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
   * If a brain sends NO first REAL stream content within this many ms, treat it
   * as a hang and fall over to the NEXT brain. Handshake/metadata frames such as
   * response_started and keepalives neither satisfy nor reset this budget.
   * Applies only to non-last brains — the last brain keeps the full per-request
   * budget (the loop's stall watchdog is its backstop). 0/undefined disables.
   */
  firstByteTimeoutMs?: number;
  /** Correlation for the model_fallover telemetry — without these the emit is
   *  session-blind and the dashboard can't attribute a fallover to the run that
   *  triggered it. Threaded from router-model.ts off the active harness run
   *  context; optional so non-harness callers are unaffected. */
  sessionId?: string;
  workflowRunId?: string;
  /**
   * Mutable set owned by one harness Runner.run. RouterModelProvider may create
   * a fresh FallbackModel for each SDK model iteration, so instance state alone
   * cannot remember that the primary already stayed silent. Sharing this
   * run-local set makes later iterations start on the proven rescue lane while
   * naturally resetting for the user's next turn.
   */
  runSilencedLabels?: Set<string>;
}

export interface FallbackRouteResolution {
  initialLabel: string;
  resolvedLabel: string;
  provider?: string;
  model?: string;
  fellOver: boolean;
  reason?: string;
}

// Response/event objects are owned by the model pipeline, so a WeakMap carries
// Clementine-private route truth without mutating providerData or leaking our
// bookkeeping back into a provider continuation payload.
const fallbackRouteResolutions = new WeakMap<object, FallbackRouteResolution>();

export function fallbackRouteResolution(value: unknown): FallbackRouteResolution | undefined {
  return value !== null && typeof value === 'object'
    ? fallbackRouteResolutions.get(value as object)
    : undefined;
}

/** A brain went silent past the first-byte fallover budget — switch brains. */
class FirstByteTimeoutError extends Error {
  constructor(public readonly ms: number) {
    super(`no first real stream content within ${ms}ms`);
    this.name = 'FirstByteTimeoutError';
  }
}

/** A stream ended (or claimed a clean completion) before any actionable text,
 * tool call, or durable continuation item. Private reasoning may have happened,
 * but none of it escaped, so another brain may safely serve the turn. */
class PreContentStreamEndedError extends Error {
  constructor(public readonly sawModelActivity = false) {
    super(sawModelActivity
      ? 'model completed with private reasoning but no actionable output'
      : 'stream ended before any actionable output');
    this.name = 'PreContentStreamEndedError';
  }
}

type StreamRecord = Record<string, unknown>;

function nonEmptyString(value: unknown): boolean {
  return typeof value === 'string' && value.length > 0;
}

const PRIVATE_REASONING_RE = /(?:^|[._-])(reasoning|thinking)(?:$|[._-])/;
const TOOL_CONTENT_RE = /(function_call|tool_call|tool-call|tool_use|input_json|computer_call|shell_call|apply_patch_call|mcp_call|search_call|code_interpreter_call|image_generation_call|function_call_output|tool_result)/;
const TEXT_CONTENT_RE = /(?:^|[._-])(output_text|text|refusal)(?:$|[._-])/;

function modelItemType(value: unknown): string {
  if (!value || typeof value !== 'object') return '';
  const type = (value as StreamRecord).type;
  return typeof type === 'string' ? type.toLowerCase() : '';
}

function modelItemIsPrivateReasoning(value: unknown): boolean {
  return PRIVATE_REASONING_RE.test(modelItemType(value));
}

function contentPartHasActionableContent(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const part = value as StreamRecord;
  const type = modelItemType(part);
  if (PRIVATE_REASONING_RE.test(type)) return false;
  if (TOOL_CONTENT_RE.test(type)) return true;
  if (TEXT_CONTENT_RE.test(type)) {
    return nonEmptyString(part.text)
      || nonEmptyString(part.delta)
      || nonEmptyString(part.content)
      || nonEmptyString(part.refusal);
  }
  return nonEmptyString(part.text)
    || nonEmptyString(part.delta)
    || nonEmptyString(part.refusal);
}

/** True once replay could duplicate a visible answer, a tool turn, or valid
 * provider continuation state. Reasoning alone deliberately does not commit.
 * Native Codex compaction DOES commit: it is intentional protocol progress and
 * must stay on the same provider rather than being replayed cross-provider. */
function modelItemHasActionableContent(value: unknown, eventType: string): boolean {
  if (!value || typeof value !== 'object') return false;
  const item = value as StreamRecord;
  const itemType = modelItemType(item);
  if (!itemType || modelItemIsPrivateReasoning(item)) return false;
  if (itemType === 'compaction') return true;
  if (TOOL_CONTENT_RE.test(itemType)) return true;
  if (TEXT_CONTENT_RE.test(itemType)) {
    return nonEmptyString(item.text)
      || nonEmptyString(item.delta)
      || nonEmptyString(item.content)
      || nonEmptyString(item.refusal);
  }
  if (itemType === 'message') {
    if (nonEmptyString(item.content)) return true;
    const content = Array.isArray(item.content) ? item.content : [];
    return content.some((part) => {
      if (nonEmptyString(part)) return true;
      return contentPartHasActionableContent(part);
    });
  }
  if (nonEmptyString(item.arguments) || nonEmptyString(item.arguments_delta)) return true;
  // A completed, non-reasoning output item is durable provider output even if
  // a new adapter spelling is not known here. An "added" empty shell remains
  // metadata until its done event or response payload supplies substance.
  if (eventType.includes('output_item.done')) return true;
  return false;
}

function modelItemHasActivity(value: unknown, eventType: string): boolean {
  if (modelItemHasActionableContent(value, eventType)) return true;
  if (!value || typeof value !== 'object' || !modelItemIsPrivateReasoning(value)) return false;
  const item = value as StreamRecord;
  const content = Array.isArray(item.content) ? item.content : [];
  return nonEmptyString(item.text)
    || nonEmptyString(item.delta)
    || nonEmptyString(item.summary)
    || nonEmptyString(item.thinking)
    || content.length > 0
    || eventType.includes('item.added')
    || eventType.includes('item.done');
}

function genericModelEventIsLifecycleMetadata(type: string): boolean {
  return /(?:^|[._-])(stream-start|response-metadata|response\.created|response\.in_progress|in-progress|keepalive|ping|heartbeat|finish)(?:$|[._-])/.test(type);
}

/** Conservative retry boundary for generic provider frames. Known transport
 * lifecycle events remain buffered. Assistant text and tool payloads commit
 * even when a provider uses a new spelling. */
function genericModelEventHasActionableContent(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const event = value as StreamRecord;
  const type = typeof event.type === 'string' ? event.type.toLowerCase() : '';
  if (!type) return modelItemHasActionableContent(event.item, '');
  if (genericModelEventIsLifecycleMetadata(type) || PRIVATE_REASONING_RE.test(type)) return false;
  if (modelItemHasActionableContent(event.item, type)) return true;
  if (modelItemHasActionableContent(event.part, type)) return true;
  if (modelItemHasActionableContent(event.content_block, type)) return true;
  if (event.delta && typeof event.delta === 'object' && modelItemHasActionableContent(event.delta, type)) return true;
  if (TOOL_CONTENT_RE.test(type)) return true;
  if (
    /(output_text|text-delta|text_delta|content_block_delta|refusal)/.test(type)
    && (
      nonEmptyString(event.delta)
      || nonEmptyString(event.text)
      || nonEmptyString(event.content)
      || nonEmptyString(event.refusal)
    )
  ) {
    return true;
  }
  // Function/tool argument streams sometimes omit a tool keyword from the
  // outer event but still carry a non-empty arguments delta.
  if (nonEmptyString(event.arguments) || nonEmptyString(event.arguments_delta)) return true;
  return false;
}

function genericModelEventHasActivity(value: unknown): boolean {
  if (genericModelEventHasActionableContent(value)) return true;
  if (!value || typeof value !== 'object') return false;
  const event = value as StreamRecord;
  const type = typeof event.type === 'string' ? event.type.toLowerCase() : '';
  if (genericModelEventIsLifecycleMetadata(type)) return false;
  if (modelItemHasActivity(event.item, type)) return true;
  if (modelItemHasActivity(event.part, type)) return true;
  if (modelItemHasActivity(event.content_block, type)) return true;
  if (event.delta && typeof event.delta === 'object' && modelItemHasActivity(event.delta, type)) return true;
  if (!PRIVATE_REASONING_RE.test(type)) return false;
  return nonEmptyString(event.delta)
    || nonEmptyString(event.text)
    || nonEmptyString(event.summary)
    || nonEmptyString(event.thinking)
    || type.includes('item.added')
    || type.includes('item.done');
}

function modelResponseHasActionableContent(response: { output?: unknown[] } | undefined): boolean {
  const output = response?.output;
  return Array.isArray(output) && output.some((item) => modelItemHasActionableContent(item, 'response.output_item.done'));
}

function modelResponseHasActivity(response: { output?: unknown[] } | undefined): boolean {
  const output = response?.output;
  return Array.isArray(output) && output.some((item) => modelItemHasActivity(item, 'response.output_item.done'));
}

function streamEventHasActionableContent(event: StreamEvent): boolean {
  if (event.type === 'output_text_delta') return nonEmptyString(event.delta);
  if (event.type === 'model') return genericModelEventHasActionableContent(event.event);
  if (event.type === 'response_done') {
    return modelResponseHasActionableContent(event.response);
  }
  return false;
}

function streamEventHasModelActivity(event: StreamEvent): boolean {
  if (streamEventHasActionableContent(event)) return true;
  if (event.type === 'model') return genericModelEventHasActivity(event.event);
  if (event.type === 'response_done') return modelResponseHasActivity(event.response);
  return false;
}

function notePrivateModelActivity(): void {
  const context = harnessRunContextStorage.getStore();
  if (context) context.privateModelActivityAt = Date.now();
}

function emptyCompletionBoundary(label: string, cause: unknown, sawModelActivity: boolean): BoundaryError {
  return new BoundaryError({
    kind: 'model.empty_completion',
    retryable: true,
    userMessage: "Clementine's model finished without an actionable answer. Try again or switch brains.",
    operatorMessage: `${label}: ${sawModelActivity
      ? 'reasoning-only completion produced no assistant text or tool call'
      : 'stream completed before any actionable output'}.`,
    context: { label, reasoningOnly: sawModelActivity },
    cause,
  });
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
// The auth-recoverable classifier is the ONE shared definition in the pure leaf
// transient-error.ts, so the router lane (here), the chat bridge, and the
// workflow step-boundary fallover all agree. Re-exported for existing callers.
export { isAuthRecoverableError } from '../../execution/transient-error.js';

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

/** Rate-limit cooldown (2026-07-21): a brain that just 429'd (quota/limit)
 *  will 429 again for every call until the provider window resets — yet each
 *  new call re-ran the full retry ladder before falling over (~15s tax per
 *  worker call; observed 26× in one run on a rate-limited kimi-k3 worker
 *  role). Unlike auth-dead (sticky, needs the user) this is a short
 *  self-healing pause that honors the provider's retry hint when present,
 *  so calls route straight to the fallover brain during the window. */
const rateLimitedBrains = new Map<string, { until: number }>();
const RATE_LIMIT_DEFAULT_COOLDOWN_MS = 60_000;
const RATE_LIMIT_MAX_COOLDOWN_MS = 10 * 60_000;

export function markBrainRateLimited(label: string, err: unknown): void {
  const cls = err instanceof BoundaryError
    ? {
        kind: err.kind,
        retryAfterMs: undefined as number | undefined,
        sameProviderRetryable: undefined as boolean | undefined,
      }
    : classifyModelError(err);
  // OVERLOADED joins the memo (v2.3.0 L2): a 529-storm behaves exactly like a
  // rate limit — the provider will refuse for a window — yet only rate_limited
  // was memo'd, so every call re-paid the full retry ladder on the overloaded
  // brain before falling over (live 2026-07-22: 486 fallovers/40min on an
  // Anthropic overload, ~15s tax per call).
  if (cls.kind !== 'model.rate_limited' && cls.kind !== 'model.overloaded') return;
  // A burst 429 gets a short probe window. A provider-declared plan/model cap
  // cannot heal on the next minute, so bench it for the bounded maximum and
  // route subsequent turns straight to a healthy brain instead of repaying the
  // same rejected request every 60 seconds.
  const defaultPauseMs = cls.sameProviderRetryable === false
    ? RATE_LIMIT_MAX_COOLDOWN_MS
    : RATE_LIMIT_DEFAULT_COOLDOWN_MS;
  const pauseMs = Math.min(cls.retryAfterMs ?? defaultPauseMs, RATE_LIMIT_MAX_COOLDOWN_MS);
  const until = Date.now() + pauseMs;
  const existing = rateLimitedBrains.get(label);
  if (!existing || until > existing.until) {
    rateLimitedBrains.set(label, { until });
    logger.warn({ brain: label, pauseMs }, 'brain rate-limited — routing around it until the window resets');
  }
}

export function isBrainRateLimited(label: string): boolean {
  const entry = rateLimitedBrains.get(label);
  if (!entry) return false;
  if (Date.now() >= entry.until) { rateLimitedBrains.delete(label); return false; }
  return true;
}

export function clearRateLimitedBrainsForTest(): void {
  rateLimitedBrains.clear();
}

function silentFailureReason(err: unknown): string | null {
  if (err instanceof FirstByteTimeoutError) return 'first-byte-timeout';
  if (err instanceof PreContentStreamEndedError) return 'model.empty_completion';
  const kind = normalizedModelFailureReason(err);
  return kind === 'model.transport_timeout' || kind === 'model.empty_completion' ? kind : null;
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
  if (
    kind === 'model.overloaded'
    || kind === 'model.http_5xx'
    || kind === 'model.transport_timeout'
    || kind === 'model.empty_completion'
  ) return true;
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
  private liveChain(request: ModelRequest): {
    chain: FallbackTarget[];
    preselected?: { from: FallbackTarget; to: FallbackTarget; reason: string };
  } {
    const compatible = this.chain.filter((target) => target.supportsRequest?.(request) !== false);
    if (compatible.length === 0) {
      throw new Error('fallback chain has no provider compatible with this request');
    }
    const exclusionReason = (target: FallbackTarget): string | null => {
      if (isBrainAuthDead(target.label)) return 'preselected-auth-dead';
      if (isBrainRateLimited(target.label)) return 'preselected-rate-limited';
      if (isBrainSilenced(target.label)) return 'preselected-silent-cooldown';
      return null;
    };
    const globallyAlive = compatible.filter((target) => exclusionReason(target) === null);
    const runAlive = globallyAlive.filter((t) => !this.opts.runSilencedLabels?.has(t.label));
    let chain: FallbackTarget[];
    if (runAlive.length > 0) chain = runAlive;
    // If every compatible lane failed in this run, probe again rather than
    // manufacturing a zero-brain chain. The last failure remains authoritative.
    else chain = globallyAlive.length > 0 ? globallyAlive : compatible;

    const from = compatible[0];
    const to = chain[0];
    if (from && to && from !== to) {
      const reason = exclusionReason(from)
        ?? (this.opts.runSilencedLabels?.has(from.label) ? 'preselected-run-silenced' : null);
      if (reason) return { chain, preselected: { from, to, reason } };
    }
    return { chain };
  }

  private rememberRunSilent(label: string, err: unknown): void {
    if (silentFailureReason(err)) this.opts.runSilencedLabels?.add(label);
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
    const live = this.liveChain(request);
    const chain = live.chain;
    if (live.preselected) this.logPreselectedFallover(live.preselected);
    let falloverReason: string | undefined = live.preselected?.reason
      ?? (chain[0]?.label !== this.chain[0]?.label
        ? 'preselected-rescue'
        : undefined);
    for (let i = 0; i < chain.length; i++) {
      const isLast = i >= chain.length - 1;
      if (i < forced && !isLast) {
        logger.warn({ forced: true, from: chain[i].label, to: chain[i + 1].label }, 'FORCED overload (test knob) — falling back to the next brain');
        falloverReason = 'forced-overload';
        continue;
      }
      const { request: req, cleanup } = this.linkAbort(request);
      try {
        // `getResponse()` resolves only after the complete response, so racing it
        // against a FIRST-BYTE budget mistakes healthy long reasoning for silence
        // and duplicates the call on the rescue provider. First-byte fallover is
        // therefore stream-only, where the first real event is observable below.
        // Any caller/provider overall deadline remains intact through `req.signal`.
        const result = await chain[i].getModel().getResponse(req);
        if (!modelResponseHasActionableContent(result)) {
          throw new PreContentStreamEndedError(modelResponseHasActivity(result));
        }
        cleanup(false);
        clearBrainSilentFailure(chain[i].label);
        this.tagRouteResolution(result, chain[i], falloverReason);
        return result;
      } catch (err) {
        cleanup(true); // release a hung request
        const callerAborted = (request as { signal?: AbortSignal }).signal?.aborted === true;
        this.markIfAuthDead(chain, i, err);
        this.rememberRunSilent(chain[i].label, err);
        recordBrainSilentFailure(chain[i].label, err, { sessionId: this.opts.sessionId, workflowRunId: this.opts.workflowRunId });
        markBrainRateLimited(chain[i].label, err);
        if (!callerAborted && this.isFalloverReason(err) && !isLast) {
          falloverReason = this.falloverReason(err);
          this.logFallover(chain, i, err);
          continue;
        }
        if (err instanceof PreContentStreamEndedError && !callerAborted) {
          throw emptyCompletionBoundary(chain[i].label, err, err.sawModelActivity);
        }
        throw err;
      }
    }
    throw new Error('fallback chain exhausted'); // unreachable (chain non-empty)
  }

  async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
    const forced = forcedOverloadDepth();
    const live = this.liveChain(request);
    const chain = live.chain;
    if (live.preselected) this.logPreselectedFallover(live.preselected);
    let falloverReason: string | undefined = live.preselected?.reason
      ?? (chain[0]?.label !== this.chain[0]?.label
        ? 'preselected-rescue'
        : undefined);
    for (let i = 0; i < chain.length; i++) {
      const isLast = i >= chain.length - 1;
      if (i < forced && !isLast) {
        logger.warn({ forced: true, from: chain[i].label, to: chain[i + 1].label }, 'FORCED overload (test knob) — falling back to the next brain');
        falloverReason = 'forced-overload';
        continue;
      }
      const { request: req, cleanup } = this.linkAbort(request);
      let sawModelActivity = false;
      let committedActionable = false;
      const pending: StreamEvent[] = [];
      const firstContentDeadlineAt = !isLast && this.opts.firstByteTimeoutMs && this.opts.firstByteTimeoutMs > 0
        ? Date.now() + this.opts.firstByteTimeoutMs
        : undefined;
      try {
        const it = chain[i].getModel().getStreamedResponse(req)[Symbol.asyncIterator]();
        while (true) {
          const next = it.next();
          next.catch(() => {}); // a lost timeout race must not throw unhandled
          const cur = sawModelActivity
            ? await next
            : await this.withFirstByteTimeout(next, isLast, () => cleanup(true), firstContentDeadlineAt);
          if (cur.done) {
            if (!committedActionable) throw new PreContentStreamEndedError(sawModelActivity);
            break;
          }
          const event = cur.value;
          if (!committedActionable && !streamEventHasActionableContent(event)) {
            // Handshake/keepalive/metadata and private reasoning remain private
            // to this attempt. If it ends without text/tool output, the rescue
            // brain starts with a clean stream and no provider reasoning state.
            pending.push(event);
            if (streamEventHasModelActivity(event)) {
              sawModelActivity = true;
              notePrivateModelActivity();
            }
            continue;
          }
          if (!committedActionable) {
            committedActionable = true;
            sawModelActivity = true;
            for (const buffered of pending) {
              this.tagRouteResolution(buffered, chain[i], falloverReason);
              yield buffered;
            }
            pending.length = 0;
          }
          this.tagRouteResolution(event, chain[i], falloverReason);
          yield event;
        }
        cleanup(false);
        clearBrainSilentFailure(chain[i].label);
        return; // streamed to completion
      } catch (err) {
        cleanup(true); // release a hung brain
        const callerAborted = (request as { signal?: AbortSignal }).signal?.aborted === true;
        this.markIfAuthDead(chain, i, err);
        this.rememberRunSilent(chain[i].label, err);
        recordBrainSilentFailure(chain[i].label, err, { sessionId: this.opts.sessionId, workflowRunId: this.opts.workflowRunId });
        markBrainRateLimited(chain[i].label, err);
        // Switch only if NO ACTIONABLE content reached the Runner (metadata and
        // private reasoning were buffered), the caller did not cancel, and a
        // next brain exists.
        if (!committedActionable && !callerAborted && this.isFalloverReason(err) && !isLast) {
          falloverReason = this.falloverReason(err);
          this.logFallover(chain, i, err);
          continue;
        }
        if (err instanceof PreContentStreamEndedError && !callerAborted) {
          throw emptyCompletionBoundary(chain[i].label, err, err.sawModelActivity);
        }
        throw err;
      }
    }
  }

  private isFalloverReason(err: unknown): boolean {
    return err instanceof FirstByteTimeoutError
      || err instanceof PreContentStreamEndedError
      || this.shouldFallover(err);
  }

  private falloverReason(err: unknown): string {
    if (err instanceof FirstByteTimeoutError) return 'first-content-timeout';
    if (err instanceof PreContentStreamEndedError) return 'model.empty_completion';
    return normalizedModelFailureReason(err);
  }

  private tagRouteResolution(value: unknown, target: FallbackTarget, reason?: string): void {
    if (value === null || typeof value !== 'object') return;
    const initialLabel = this.chain[0]?.label ?? target.label;
    fallbackRouteResolutions.set(value as object, {
      initialLabel,
      resolvedLabel: target.label,
      ...(target.provider ? { provider: target.provider } : {}),
      ...(target.model ? { model: target.model } : {}),
      fellOver: target.label !== initialLabel,
      ...(reason ? { reason } : {}),
    });
  }

  private logFallover(chain: FallbackTarget[], i: number, err: unknown): void {
    const reason = this.falloverReason(err);
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
        ...(chain[i].provider ? { fromProvider: chain[i].provider } : {}),
        ...(chain[i].model ? { fromModel: chain[i].model } : {}),
        ...(chain[i + 1].provider ? {
          toProvider: chain[i + 1].provider,
          resolvedProvider: chain[i + 1].provider,
        } : {}),
        ...(chain[i + 1].model ? {
          toModel: chain[i + 1].model,
          resolvedModel: chain[i + 1].model,
        } : {}),
        reason,
        stage: 'router',
      },
    });
  }

  private logPreselectedFallover(resolution: {
    from: FallbackTarget;
    to: FallbackTarget;
    reason: string;
  }): void {
    const { from, to, reason } = resolution;
    logger.warn(
      {
        from: from.label,
        to: to.label,
        fromProvider: from.provider,
        fromModel: from.model,
        toProvider: to.provider,
        toModel: to.model,
        reason,
        preselected: true,
      },
      'known-unavailable brain skipped — preselecting the rescue brain',
    );
    recordOperationalEvent({
      source: 'model',
      type: 'model_fallover',
      severity: 'warn',
      actor: 'fallback-model',
      sessionId: this.opts.sessionId,
      workflowRunId: this.opts.workflowRunId,
      payload: {
        from: from.label,
        to: to.label,
        ...(from.provider ? { fromProvider: from.provider } : {}),
        ...(from.model ? { fromModel: from.model } : {}),
        ...(to.provider ? { toProvider: to.provider, resolvedProvider: to.provider } : {}),
        ...(to.model ? { toModel: to.model, resolvedModel: to.model } : {}),
        reason,
        stage: 'router',
        preselected: true,
      },
    });
  }

  /** Race a model call's first result against the first-byte timeout (only for a
   *  non-last brain with a configured budget). On timeout, abort and throw
   *  FirstByteTimeoutError so the caller advances to the next brain. */
  private async withFirstByteTimeout<T>(
    call: Promise<T>,
    isLast: boolean,
    abort: () => void,
    deadlineAt?: number,
  ): Promise<T> {
    const ms = this.opts.firstByteTimeoutMs;
    if (isLast || !ms || ms <= 0) return call;
    const remainingMs = Math.max(0, (deadlineAt ?? Date.now() + ms) - Date.now());
    if (remainingMs <= 0) {
      abort();
      throw new FirstByteTimeoutError(ms);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        call,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new FirstByteTimeoutError(ms));
            abort();
          }, remainingMs);
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

/** Wrap an ordered chain of brains with fallover and the always-actionable
 * completion invariant. A single brain is still wrapped: otherwise disabling
 * fallover would also disable the reasoning-only escape hatch and let the
 * Agents SDK spin the same model indefinitely. */
export function withModelFallback(chain: FallbackTarget[], opts: FallbackOptions = {}): Model {
  if (chain.length === 0) throw new Error('withModelFallback: empty chain');
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
