/**
 * ONE push subscription for the whole console.
 *
 * Everything outside the live conversation used to be POLLED: the shell badge
 * every 12s, the command centre every 6s, the Tasks board every 4s. So the
 * console lagged reality by up to a poll interval and could show a finished run
 * as still running — while the daemon was already publishing exactly the right
 * signal on GET /api/console/actions/stream and nothing subscribed to it.
 *
 * This module is that subscriber, and there is deliberately only one of it.
 * Four components opening four EventSources would be four replays, four
 * heartbeats and four independent reconnect ladders against one local daemon;
 * instead the transport is a module singleton, ref-counted by its subscribers,
 * and every consumer gets the same reduced result.
 *
 * What a consumer receives is not the raw event — it is the set of react-query
 * keys the event just invalidated. The polls stay exactly as they are and
 * remain the source of the DATA; the stream only says "that answer is stale
 * now, ask again". If the stream never connects, or drops, the console behaves
 * exactly as it did before, one poll tick behind.
 *
 * Being "live" is re-verified, never remembered. `onopen` fired once says
 * nothing about now: a socket half-opened by a laptop sleep still reads OPEN
 * and never fires `onerror`, and a console that kept trusting it would render
 * a finished run as still running — the exact defect this module exists to
 * remove. So silence past a limit drops the claim and reopens the channel, and
 * return-to-visible re-asks unconditionally. When it cannot know, it asks.
 *
 * The event contract is the daemon's action bus (src/runtime/action-bus.ts) as
 * the SSE route serialises it (src/dashboard/console-routes.ts): one named SSE
 * event per ActionEvent.kind carrying the whole envelope, preceded on connect
 * by a single `replay` frame carrying an ARRAY of envelopes.
 */
import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { getAuthToken } from './bootstrap';

// ─── The wire contract ───────────────────────────────────────────────────────

/** Every ActionEvent.kind the daemon fans out. Named SSE events only reach a
 *  listener registered for that exact name (onmessage sees none of them), so
 *  this list is load-bearing: a kind missing here is a kind we never hear. */
export const CONSOLE_ACTION_EVENT_KINDS = [
  'run.event',
  'approval.created',
  'approval.resolved',
  'notification.created',
  'execution.transitioned',
  'harness.event',
  'harness.public_event',
  'runtime.failed',
  'runtime.completed',
  'focus.changed',
  'operational.event',
] as const;

export type ConsoleActionEventKind = (typeof CONSOLE_ACTION_EVENT_KINDS)[number];

/**
 * The kinds we actually register a listener for. Two of the contract's kinds
 * are deliberately left on the wire:
 *   - `operational.event` fires for every tool and model call and routes to no
 *     console query — lib/telemetry.ts owns that feed, and parsing each frame
 *     here only to discard it is pure cost on the busiest channel there is.
 *   - `harness.public_event` is a presentation projection of a `harness.event`
 *     we already receive; listening to both would fold every live turn twice.
 */
const SUBSCRIBED_ACTION_EVENT_KINDS: readonly ConsoleActionEventKind[] =
  CONSOLE_ACTION_EVENT_KINDS.filter((kind) => kind !== 'operational.event' && kind !== 'harness.public_event');

/**
 * Only the fields the console ROUTES on. Everything else the daemon sends stays
 * on the wire: a field carried here that nothing reads is a field that quietly
 * rots out of sync with the bus, and a green typecheck would never say so.
 */
export type ConsoleActionEvent =
  | { kind: 'run.event'; runId: string; runStatus: string; event: { id: string } }
  | { kind: 'approval.created'; approval: { id: string } }
  | { kind: 'approval.resolved'; approval: { id: string }; resolution: 'approved' | 'rejected' }
  | { kind: 'notification.created'; notification: { id: string } }
  | { kind: 'execution.transitioned'; executionId: string }
  | { kind: 'harness.event' | 'harness.public_event'; event: { id: string; type: string }; sessionId?: string }
  | { kind: 'runtime.failed' | 'runtime.completed' }
  | { kind: 'focus.changed' }
  | { kind: 'operational.event' };

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function nested(value: unknown, field: string): Record<string, unknown> {
  const parent = value as Record<string, unknown> | null;
  const child = parent && typeof parent === 'object' ? parent[field] : undefined;
  return child && typeof child === 'object' ? (child as Record<string, unknown>) : {};
}

/**
 * Narrow one JSON frame to an envelope we can route on, or reject it.
 *
 * The daemon is trusted but a frame is still parsed JSON from a socket that
 * survives daemon upgrades: an envelope from a NEWER daemon carrying a kind
 * this build has never heard of must be dropped, not routed by accident.
 */
export function parseActionEvent(raw: unknown): ConsoleActionEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const frame = raw as Record<string, unknown>;
  const kind = str(frame.kind) as ConsoleActionEventKind;
  if (!(CONSOLE_ACTION_EVENT_KINDS as readonly string[]).includes(kind)) return null;
  switch (kind) {
    case 'run.event': {
      const event = nested(frame, 'event');
      if (!str(frame.runId) || !str(event.id)) return null;
      return { kind, runId: str(frame.runId), runStatus: str(frame.runStatus), event: { id: str(event.id) } };
    }
    case 'approval.created': {
      const approval = nested(frame, 'approval');
      if (!str(approval.id)) return null;
      return { kind, approval: { id: str(approval.id) } };
    }
    case 'approval.resolved': {
      const approval = nested(frame, 'approval');
      if (!str(approval.id)) return null;
      return {
        kind,
        approval: { id: str(approval.id) },
        resolution: frame.resolution === 'rejected' ? 'rejected' : 'approved',
      };
    }
    case 'notification.created': {
      const notification = nested(frame, 'notification');
      if (!str(notification.id)) return null;
      return { kind, notification: { id: str(notification.id) } };
    }
    case 'execution.transitioned': {
      if (!str(frame.executionId)) return null;
      return { kind, executionId: str(frame.executionId) };
    }
    case 'harness.event':
    case 'harness.public_event': {
      const event = nested(frame, 'event');
      if (!str(event.id)) return null;
      return { kind, event: { id: str(event.id), type: str(event.type) }, ...(str(frame.sessionId) ? { sessionId: str(frame.sessionId) } : {}) };
    }
    // Nothing below carries an identity or a payload the routing table reads:
    // the kind alone decides what goes stale.
    case 'runtime.failed':
    case 'runtime.completed':
    case 'focus.changed':
    case 'operational.event':
      return { kind };
  }
}

// ─── What each event makes stale ─────────────────────────────────────────────

/** Work in flight: the badge, Home's Running pane and the Tasks board all read
 *  one of these three. */
const LIVE_WORK_KEYS = ['board', 'working-now-badge', 'command-center'] as const;

/** A decision appeared or was answered. The same key set NeedsYouPane settles
 *  on after an inline approve, so a decision made on ANOTHER surface (phone,
 *  Discord, the Inbox) lands here identically — minus 'approvals-count', which
 *  those settle lists carry but no query in this app registers. */
const DECISION_KEYS = [
  'board', 'working-now-badge', 'command-center',
  'approvals', 'plan-proposals', 'inbox-questions', 'notifications',
] as const;

/** Work ended: the delivered shelf gained a row. */
const SETTLED_WORK_KEYS = ['delivered'] as const;

const FOCUS_KEYS = ['focus', 'command-center'] as const;

/** Every key the stream can invalidate — the full resync fired on each
 *  (re)connect. The 40-event replay window cannot be assumed to cover a long
 *  outage, so a reconnect re-asks rather than trusting what it replayed. */
export const CONSOLE_LIVE_QUERY_KEYS: readonly string[] = [
  ...new Set<string>([...LIVE_WORK_KEYS, ...DECISION_KEYS, ...SETTLED_WORK_KEYS, ...FOCUS_KEYS]),
];

/** Harness event types that change WHETHER work is running. */
const HARNESS_LIFECYCLE_TYPES: ReadonlySet<string> = new Set([
  'turn_started', 'handoff', 'guardrail_tripped', 'stuck_detected',
  'run_completed', 'run_failed', 'conversation_completed', 'conversation_superseded',
]);

/** Harness event types that END work — these also settle the delivered shelf. */
const HARNESS_TERMINAL_TYPES: ReadonlySet<string> = new Set([
  'run_completed', 'run_failed', 'conversation_completed', 'conversation_superseded',
]);

const HARNESS_DECISION_TYPES: ReadonlySet<string> = new Set([
  'approval_requested', 'approval_resolved',
]);

/** Harness event types that change only the PROGRESS line on an already-running
 *  card. They still refresh the board — a card whose hint is four seconds stale
 *  is the complaint — but they never touch the decision or history queries. */
export const HARNESS_PROGRESS_TYPES: ReadonlySet<string> = new Set([
  'tool_called', 'tool_returned', 'heartbeat', 'step_started',
  'worker_started', 'worker_result', 'worker_capped',
  'batch_started', 'batch_progress', 'batch_completed',
  'external_write', 'external_write_succeeded', 'external_write_failed', 'external_write_orphaned',
]);

/** Run statuses that are still open. Mirrors the board route's own predicate so
 *  the client cannot decide a run is finished when the board would not. */
const OPEN_RUN_STATUSES: ReadonlySet<string> = new Set([
  'queued', 'received', 'running', 'awaiting_approval', 'awaiting_input',
]);

/** The Space a session belongs to, when it is a Space session (`space-<slug>`). */
export function spaceSlugForSession(sessionId: string | undefined): string | null {
  if (!sessionId) return null;
  const m = /^space-([a-z0-9][a-z0-9-]{1,62})$/.exec(sessionId);
  return m ? m[1]! : null;
}

function baseHarnessKeys(type: string): readonly string[] {
  if (HARNESS_DECISION_TYPES.has(type)) return DECISION_KEYS;
  if (HARNESS_TERMINAL_TYPES.has(type)) return [...LIVE_WORK_KEYS, ...SETTLED_WORK_KEYS];
  if (HARNESS_LIFECYCLE_TYPES.has(type)) return LIVE_WORK_KEYS;
  if (HARNESS_PROGRESS_TYPES.has(type)) return ['board', 'working-now-badge'];
  return [];
}

/**
 * The react-query keys one event invalidates. Pure: the routing table IS the
 * contract between the daemon's action bus and the console's caches, so it is
 * testable on its own rather than buried in an event handler.
 */
export function queryKeysForActionEvent(event: ConsoleActionEvent): readonly string[] {
  switch (event.kind) {
    case 'run.event':
      return OPEN_RUN_STATUSES.has(event.runStatus)
        ? LIVE_WORK_KEYS
        : [...LIVE_WORK_KEYS, ...SETTLED_WORK_KEYS];
    case 'approval.created':
    case 'approval.resolved':
      return DECISION_KEYS;
    case 'notification.created':
      return ['command-center', 'notifications'];
    case 'execution.transitioned':
      return LIVE_WORK_KEYS;
    case 'harness.event':
    case 'harness.public_event': {
      const type = event.event.type;
      // A Space is built inside its own session (`space-<slug>`). Every tool
      // call Clem makes there is a change the Space screens should show at once
      // — the view, the data, the revision — not on the next 5–8s poll.
      const spaceSlug = spaceSlugForSession(event.sessionId);
      if (spaceSlug && (HARNESS_PROGRESS_TYPES.has(type) || HARNESS_TERMINAL_TYPES.has(type) || HARNESS_LIFECYCLE_TYPES.has(type))) {
        return [...baseHarnessKeys(type), 'spaces', 'space'];
      }
      if (HARNESS_DECISION_TYPES.has(type)) return DECISION_KEYS;
      if (HARNESS_TERMINAL_TYPES.has(type)) return [...LIVE_WORK_KEYS, ...SETTLED_WORK_KEYS];
      if (HARNESS_LIFECYCLE_TYPES.has(type)) return LIVE_WORK_KEYS;
      if (HARNESS_PROGRESS_TYPES.has(type)) return ['board', 'working-now-badge'];
      // stream_token and every other transcript-shaped row: the conversation
      // owns its own stream. Refetching the board per token is the thrash this
      // whole module exists to avoid.
      return [];
    }
    case 'runtime.failed':
    case 'runtime.completed':
      return [...LIVE_WORK_KEYS, ...SETTLED_WORK_KEYS];
    case 'focus.changed':
      return FOCUS_KEYS;
    case 'operational.event':
      // The observability feed has its own stream (lib/telemetry.ts). Routing
      // it here as well would double every tool call.
      return [];
  }
}

// ─── The reducer ─────────────────────────────────────────────────────────────

/**
 * A durable identity for an event, or null when the event has none.
 *
 * Only the kinds the route REPLAYS need dedupe — a reconnect re-delivers the
 * last run/harness events, every pending approval and the recent notifications,
 * and re-invalidating on all of those turns each daemon restart into a refetch
 * storm across the whole console. Kinds that are never replayed return null and
 * always apply, because swallowing a genuine repeat (the same execution
 * transitioning A→B twice) would cost a refresh the user can see is missing.
 */
export function actionEventKey(event: ConsoleActionEvent): string | null {
  switch (event.kind) {
    case 'run.event': return `run.event:${event.runId}:${event.event.id}`;
    case 'harness.event':
    case 'harness.public_event': return `${event.kind}:${event.event.id}`;
    case 'approval.created': return `approval.created:${event.approval.id}`;
    case 'approval.resolved': return `approval.resolved:${event.approval.id}:${event.resolution}`;
    case 'notification.created': return `notification.created:${event.notification.id}`;
    default: return null;
  }
}

/**
 * The whole reducer state: the durable keys already applied, oldest first.
 *
 * Deliberately nothing else. A sequence number or a timestamp watermark would
 * imply this reducer cares what ORDER events arrive in, and it must not: the
 * signal it produces is "that answer is stale, ask again", which is the same
 * whatever order two events land in. Ordering belongs to the queries it
 * invalidates, which re-read the server's own current answer.
 */
export interface ActionStreamState {
  /** Bounded: a console left open for a day must not retain a key for every
   *  heartbeat it ever saw. */
  readonly seen: readonly string[];
}

const SEEN_LIMIT = 600;

export function createActionStreamState(): ActionStreamState {
  return { seen: [] };
}

/** Union of two key lists, first-seen order preserved. */
export function mergeInvalidations(
  pending: readonly string[],
  next: readonly string[],
): string[] {
  if (next.length === 0) return [...pending];
  const out = [...pending];
  for (const key of next) if (!out.includes(key)) out.push(key);
  return out;
}

export type ActionStreamFrame =
  | { kind: 'replay'; events: readonly unknown[] }
  | { kind: 'event'; event: unknown };

/**
 * Fold one SSE frame into the stream state and say what it invalidated.
 *
 * Pure and total: no clock, no I/O, no mutation of the input state — the
 * replay-then-live, out-of-order and reconnect cases are all just sequences of
 * calls, which is the only way they are testable at all.
 */
export function applyActionFrame(
  state: ActionStreamState,
  frame: ActionStreamFrame,
): { state: ActionStreamState; invalidate: string[] } {
  const raws = frame.kind === 'replay' ? frame.events : [frame.event];
  const seen = [...state.seen];
  let invalidate: string[] = [];
  for (const raw of raws) {
    const event = parseActionEvent(raw);
    if (!event) continue;
    const keys = queryKeysForActionEvent(event);
    // An event that invalidates nothing must never cost a dedupe slot. EVERY
    // eventlog row reaches this module as a `harness.event`, `stream_token`
    // included, and each one carries a durable id — so recording them first
    // would let one 700-token reply evict the whole ring, and the next
    // reconnect's replay (run events, every pending approval, ten
    // notifications) would arrive undeduped: exactly the refetch storm the
    // ring exists to prevent. The route never replays those kinds anyway
    // (CONSOLE_HARNESS_REPLAY_TYPES), so they never needed a slot.
    if (keys.length === 0) continue;
    const key = actionEventKey(event);
    if (key !== null) {
      if (seen.includes(key)) continue;
      seen.push(key);
    }
    invalidate = mergeInvalidations(invalidate, keys);
  }
  if (seen.length === state.seen.length) return { state, invalidate };
  return {
    state: { seen: seen.length > SEEN_LIMIT ? seen.slice(seen.length - SEEN_LIMIT) : seen },
    invalidate,
  };
}

// ─── Transport ───────────────────────────────────────────────────────────────

export type ActionStreamStatus = 'connecting' | 'live' | 'degraded';

/** Backoff between reconnect attempts, same ladder the chat stream uses. */
export function nextReconnectDelayMs(attempt: number): number {
  const base = 1_000;
  const max = 8_000;
  return Math.min(max, base * Math.pow(2, Math.min(Math.max(attempt, 1) - 1, 3)));
}

/**
 * When the next batch of invalidations may fire.
 *
 * A trailing gap coalesces the burst of tool events one busy run produces into
 * a single refetch, and the minimum gap caps the sustained rate: under a
 * fan-out storm the board refreshes about once a second instead of once per
 * tool call — still an order of magnitude fresher than the 4s poll it replaces.
 */
export function flushDelayMs(opts: {
  now: number;
  lastFlushAt: number;
  trailingMs?: number;
  minGapMs?: number;
}): number {
  const trailing = opts.trailingMs ?? 150;
  const minGap = opts.minGapMs ?? 900;
  const sinceFlush = opts.now - opts.lastFlushAt;
  return Math.max(trailing, minGap - sinceFlush);
}

/**
 * How long the channel may say NOTHING before the console stops calling it
 * live.
 *
 * Silence is the only observable there is: the route's keep-alive is a `: ping`
 * COMMENT, which `EventSource` never surfaces, and a socket the OS half-opened
 * during a laptop sleep still reads `readyState === OPEN` and never fires
 * `onerror`. So a channel that has been quiet this long is not "live", it is
 * UNVERIFIED — and an unverified channel must not be the thing holding the
 * board's poll at its safety-net interval.
 */
export const STREAM_SILENCE_LIMIT_MS = 45_000;

/** How often the watchdog asks the question. */
export const STREAM_WATCHDOG_TICK_MS = 5_000;

/**
 * Can the console still say this channel is carrying the updates?
 *
 * Pure, because it is the whole honesty rule: 'live' is a claim about NOW, and
 * `onopen` fired once is not evidence of now. `hidden` is part of it — a tab
 * nobody is looking at is owed nothing, and return-to-visible re-verifies and
 * re-asks unconditionally, so churning a background tab buys nothing.
 */
export function actionStreamStillLive(opts: {
  status: ActionStreamStatus;
  socketOpen: boolean;
  now: number;
  lastHeardAt: number;
  hidden?: boolean;
  silenceLimitMs?: number;
}): boolean {
  if (opts.status !== 'live') return false;
  if (opts.hidden) return true;
  if (!opts.socketOpen) return false;
  return opts.now - opts.lastHeardAt < (opts.silenceLimitMs ?? STREAM_SILENCE_LIMIT_MS);
}

/**
 * Poll interval a fallback query should use.
 *
 * While the push channel is live the poll stays armed as a safety net — it is
 * never switched off, because a stream that is "live" and silently wrong would
 * then have no corrector. The net is deliberately short of a minute: it is also
 * the query's `staleTime` (lib/poll.ts), so a long net suppresses
 * refetch-on-focus too, and "the last thing we heard" would be all a returning
 * user sees for that whole window.
 */
export function pollIntervalForStream(
  status: ActionStreamStatus,
  fallbackMs: number,
  safetyNetMs = 20_000,
): number {
  return status === 'live' ? Math.max(fallbackMs, safetyNetMs) : fallbackMs;
}

export interface ActionStreamHandlers {
  /** react-query keys that just went stale, already coalesced. */
  onInvalidate?: (keys: readonly string[]) => void;
  onStatus?: (status: ActionStreamStatus) => void;
}

function withToken(path: string): string {
  const token = getAuthToken();
  if (!token) return path;
  return path + (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
}

const listeners = new Set<ActionStreamHandlers>();
let source: EventSource | null = null;
let state = createActionStreamState();
let status: ActionStreamStatus = 'connecting';
let attempts = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let closeTimer: ReturnType<typeof setTimeout> | null = null;
let watchdogTimer: ReturnType<typeof setInterval> | null = null;
let pending: string[] = [];
let lastFlushAt = 0;
/** When the channel last PROVED it was carrying traffic. */
let lastHeardAt = 0;
let visibilityBound = false;

function documentHidden(): boolean {
  return typeof document !== 'undefined' && document.hidden === true;
}

function socketIsOpen(): boolean {
  if (!source) return false;
  const open = typeof EventSource === 'undefined' ? 1 : EventSource.OPEN;
  return source.readyState === open;
}

export function actionStreamStatus(): ActionStreamStatus {
  return status;
}

function setStatus(next: ActionStreamStatus): void {
  if (status === next) return;
  status = next;
  for (const listener of listeners) listener.onStatus?.(next);
}

function flush(): void {
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  if (pending.length === 0) return;
  // A timer armed just before the tab hid must not fire behind the user's
  // back either — the batch is held, and the visibility handler releases it.
  if (documentHidden()) return;
  const keys = pending;
  pending = [];
  lastFlushAt = Date.now();
  for (const listener of listeners) listener.onInvalidate?.(keys);
}

function queueInvalidations(keys: readonly string[]): void {
  if (keys.length === 0) return;
  pending = mergeInvalidations(pending, keys);
  // A hidden tab holds its batch instead of refetching behind the user's back;
  // the visibility handler flushes the whole accumulation on return.
  if (documentHidden()) return;
  if (flushTimer) return;
  flushTimer = setTimeout(flush, flushDelayMs({ now: Date.now(), lastFlushAt }));
}

function ingest(frame: ActionStreamFrame): void {
  // Traffic — of any shape, including a frame that invalidates nothing — is the
  // only proof this socket is still attached to a daemon.
  lastHeardAt = Date.now();
  const result = applyActionFrame(state, frame);
  state = result.state;
  queueInvalidations(result.invalidate);
}

function disconnect(): void {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (source) { try { source.close(); } catch { /* already gone */ } source = null; }
}

function scheduleReconnect(): void {
  if (reconnectTimer || listeners.size === 0) return;
  attempts += 1;
  // No give-up window, unlike the chat stream: a chat turn can fail, but the
  // console outlives any single daemon restart and its polls are already
  // carrying the UI in the meantime.
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, nextReconnectDelayMs(attempts));
}

function connect(): void {
  if (listeners.size === 0) return;
  if (typeof EventSource === 'undefined') { setStatus('degraded'); return; }
  disconnect();
  let es: EventSource;
  try {
    es = new EventSource(withToken('/api/console/actions/stream'));
  } catch {
    setStatus('degraded');
    scheduleReconnect();
    return;
  }
  source = es;
  es.addEventListener('replay', (e) => {
    try {
      const events = JSON.parse((e as MessageEvent).data) as unknown;
      ingest({ kind: 'replay', events: Array.isArray(events) ? events : [] });
    } catch { /* a malformed frame is not a reason to drop the channel */ }
  });
  for (const kind of SUBSCRIBED_ACTION_EVENT_KINDS) {
    es.addEventListener(kind, (e) => {
      try { ingest({ kind: 'event', event: JSON.parse((e as MessageEvent).data) }); }
      catch { /* ignore malformed frame */ }
    });
  }
  es.onopen = () => {
    attempts = 0;
    lastHeardAt = Date.now();
    setStatus('live');
    // Everything the stream can speak for is re-asked on connect: the replay
    // window is bounded, so what happened during a long outage may simply not
    // be in it.
    queueInvalidations(CONSOLE_LIVE_QUERY_KEYS);
  };
  es.onerror = () => {
    if (source !== es) return;
    setStatus('degraded');
    disconnect();
    scheduleReconnect();
  };
}

/**
 * Stop claiming live, and go find out.
 *
 * Dropping to 'degraded' is the honest half: every poll that had relaxed to the
 * safety net returns to its real interval immediately, so the console is back
 * to correcting itself the way it did before this channel existed. Reopening is
 * the other half — a fresh socket is the only way to earn 'live' back, and its
 * `onopen` re-asks every key rather than trusting a replay window.
 */
function reverify(): void {
  setStatus('degraded');
  disconnect();
  attempts = 0;
  connect();
}

/**
 * The half-open socket is the whole reason this exists: after a laptop sleep the
 * stream stops delivering without ever firing `onerror`, and a status set once
 * on `onopen` would keep the board rendering a finished run as still running.
 * The cost of being wrong the other way is one reconnect per quiet interval,
 * which is still an order of magnitude below the poll this channel replaced.
 */
function watchdogTick(): void {
  if (listeners.size === 0) return;
  if (status !== 'live') return;
  if (actionStreamStillLive({
    status,
    socketOpen: socketIsOpen(),
    now: Date.now(),
    lastHeardAt,
    hidden: documentHidden(),
  })) return;
  reverify();
}

function onVisibilityChange(): void {
  if (typeof document === 'undefined' || document.hidden) return;
  // Return-to-visible ALWAYS re-asks, whatever the channel's status says. The
  // tab may have been asleep for an hour behind a socket that never reported
  // it: the last thing this module heard is not evidence that it is still
  // true, and rendering it as though it were is the exact defect this module
  // was written to remove. react-query only refetches the queries actually
  // mounted, so re-asking is cheap and always correct.
  queueInvalidations(CONSOLE_LIVE_QUERY_KEYS);
  flush();
  // A socket the OS dropped while the tab slept should not wait out a backoff
  // the user is now sitting in front of.
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
    attempts = 0;
    connect();
    return;
  }
  if (!source) { connect(); return; }
  // A connect already in flight is left alone: restarting it would only put the
  // backoff ladder back to the beginning of a socket that is already coming.
  if (status === 'connecting') return;
  if (!actionStreamStillLive({
    status,
    socketOpen: socketIsOpen(),
    now: Date.now(),
    lastHeardAt,
    hidden: false,
  })) reverify();
}

/**
 * Subscribe to the console's push channel. The transport is shared: the first
 * subscriber opens it, the last one to leave closes it.
 */
export function subscribeActionStream(handlers: ActionStreamHandlers): () => void {
  listeners.add(handlers);
  if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
  if (!visibilityBound && typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibilityChange);
    visibilityBound = true;
  }
  if (!watchdogTimer) watchdogTimer = setInterval(watchdogTick, STREAM_WATCHDOG_TICK_MS);
  if (!source && !reconnectTimer) connect();
  else handlers.onStatus?.(status);
  return () => {
    listeners.delete(handlers);
    if (listeners.size > 0) return;
    // StrictMode remounts every effect immediately: tearing the socket down
    // synchronously would drop and re-establish the stream (and replay it) on
    // every mount in development. Wait a beat for the remount.
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      closeTimer = null;
      if (listeners.size > 0) return;
      disconnect();
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      if (watchdogTimer) { clearInterval(watchdogTimer); watchdogTimer = null; }
      if (visibilityBound && typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibilityChange);
        visibilityBound = false;
      }
      pending = [];
      // A remount after a long outage starts a fresh ladder rather than
      // resuming someone else's 8s backoff.
      attempts = 0;
      lastHeardAt = 0;
      setStatus('connecting');
    }, 250);
  };
}

/**
 * Mount ONCE, in the app shell: bridges the push channel into the query cache
 * so every polled surface — the shell badge, Home's panes, the Tasks board —
 * refreshes off one subscription. Returns the channel's status so callers can
 * keep their polls as the degraded path.
 */
export function useConsoleActionStream(): ActionStreamStatus {
  const queryClient = useQueryClient();
  const [current, setCurrent] = useState<ActionStreamStatus>(actionStreamStatus);
  useEffect(() => subscribeActionStream({
    onStatus: setCurrent,
    onInvalidate: (keys) => {
      for (const key of keys) void queryClient.invalidateQueries({ queryKey: [key] });
    },
  }), [queryClient]);
  return current;
}

/** Read the shared channel's status without adding a second bridge to the
 *  cache — for a screen that only needs to know whether its poll is the
 *  primary source or the safety net. */
export function useActionStreamStatus(): ActionStreamStatus {
  const [current, setCurrent] = useState<ActionStreamStatus>(actionStreamStatus);
  useEffect(() => subscribeActionStream({ onStatus: setCurrent }), []);
  return current;
}
