import pino from 'pino';
import { addNotification, loadNotifications } from '../runtime/notifications.js';
import { durableFanoutAttentionSource } from './durable-fanout.js';
import { workflowTriggerAttentionSource } from './workflow-trigger-engine.js';

/**
 * Attention watchdog (north star: REPORTS BACK WITHOUT FAIL).
 *
 * The class this closes (swallowed-state, sweep-confirmed 2026-08-11): a
 * durable store records a typed bad terminal state — a fan-out plan flips to
 * 'failed' after its retry cap, a trigger delivery dead-ends needing operator
 * review — and the only surfacing is a log line or a dashboard-side patch.
 * These states occur on exactly the scheduled/background surfaces where
 * nobody is watching a log.
 *
 * The workflow and background-task watchdogs already prove the right shape:
 * scan the durable store on an independent daemon timer, post ONE deduped
 * notification per bad state. This module generalizes that shape into a
 * registry so covering a NEW store is one small reader, not a bespoke
 * watchdog. Observe-only: it never mutates source state, so it cannot
 * regress execution.
 */

const logger = pino({ name: 'clementine-next.attention-watchdog' });

/** One attention-worthy record inside a source's store. */
export interface AttentionState {
  /** Stable per underlying record — drives one-shot notification dedupe. */
  id: string;
  title: string;
  body: string;
  /** ISO time the state was recorded in the store. */
  recordedAt: string;
  metadata?: Record<string, unknown>;
}

/** A durable store that can record states a user must hear about. */
export interface AttentionSource {
  /** Stable kebab-case name; part of every notification id it produces. */
  name: string;
  listAttentionStates(): AttentionState[];
}

/**
 * First-ship backlog guard: states recorded longer ago than this are not
 * alerted — the historical rows predate the watchdog and were dealt with (or
 * abandoned) long ago. Dedup makes each alert one-shot regardless, so this
 * only bounds the very first scan over old stores.
 */
const DEFAULT_MAX_STATE_AGE_MS = 12 * 60 * 60_000;

const registeredSources: AttentionSource[] = [];

/** Register an additional store reader (tests; future stores). */
export function registerAttentionSource(source: AttentionSource): void {
  registeredSources.push(source);
}

export function clearRegisteredAttentionSourcesForTest(): void {
  registeredSources.length = 0;
}

export function attentionNotificationId(sourceName: string, stateId: string): string {
  return `attention-${sourceName}-${stateId}`;
}

/**
 * Pure: which states need a notification right now. Exported for tests —
 * no I/O, no clock (caller passes `now`).
 */
export function selectAttentionAlerts(
  states: Array<{ source: string; state: AttentionState }>,
  existingNotificationIds: Set<string>,
  now: number,
  opts: { maxStateAgeMs?: number } = {},
): Array<{ id: string; source: string; state: AttentionState }> {
  const maxAgeMs = opts.maxStateAgeMs ?? DEFAULT_MAX_STATE_AGE_MS;
  const out: Array<{ id: string; source: string; state: AttentionState }> = [];
  for (const { source, state } of states) {
    const recorded = Date.parse(state.recordedAt);
    if (!Number.isFinite(recorded)) continue;
    if (now - recorded > maxAgeMs) continue;
    const id = attentionNotificationId(source, state.id);
    if (existingNotificationIds.has(id)) continue;
    out.push({ id, source, state });
  }
  return out;
}

/**
 * Scan every registered store and notify (once, deduped) for each attention
 * state that has no notification yet. Safe on a timer — stable ids make each
 * alert one-shot. A broken source never blocks the others; the sweep never
 * throws into the daemon.
 */
export function runAttentionWatchdog(now: number = Date.now()): { surfaced: number } {
  const sources = [durableFanoutAttentionSource, workflowTriggerAttentionSource, ...registeredSources];

  const states: Array<{ source: string; state: AttentionState }> = [];
  for (const source of sources) {
    try {
      for (const state of source.listAttentionStates()) states.push({ source: source.name, state });
    } catch (err) {
      logger.warn(
        { source: source.name, err: err instanceof Error ? err.message : String(err) },
        'Attention source scan failed',
      );
    }
  }
  if (states.length === 0) return { surfaced: 0 };

  let existingIds = new Set<string>();
  try {
    existingIds = new Set(
      loadNotifications()
        .map((n) => n.id)
        .filter((id): id is string => typeof id === 'string' && id.startsWith('attention-')),
    );
  } catch { /* empty store is safe — addNotification dedupes by id too */ }

  const alerts = selectAttentionAlerts(states, existingIds, now);
  for (const alert of alerts) {
    try {
      addNotification({
        id: alert.id,
        kind: 'workflow',
        title: alert.state.title,
        body: alert.state.body,
        createdAt: new Date(now).toISOString(),
        read: false,
        metadata: {
          attention: true,
          attentionSource: alert.source,
          recordedAt: alert.state.recordedAt,
          ...alert.state.metadata,
        },
      });
    } catch (err) {
      logger.warn(
        { id: alert.id, err: err instanceof Error ? err.message : String(err) },
        'Attention notification write failed',
      );
    }
  }
  if (alerts.length > 0) {
    logger.warn(
      { surfaced: alerts.length, ids: alerts.map((a) => a.id) },
      'Surfaced silent attention states',
    );
  }
  return { surfaced: alerts.length };
}
