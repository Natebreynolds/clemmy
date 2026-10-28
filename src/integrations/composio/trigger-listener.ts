/**
 * App events as triggers: when something happens in a connected app (a new
 * email, a Slack message, a calendar change, a commit), Composio pushes the
 * event to this daemon over its SDK subscription, with no public URL, and
 * Clem fires every workflow and watch that subscribes to it through the same
 * trigger engine a webhook or schedule uses, with the same dedupe.
 *
 * The event type a workflow declares is `composio.<trigger slug, lowercase>`,
 * for example `composio.gmail_new_gmail_message` or
 * `composio.outlook_message_trigger`. A daily cap per trigger keeps a noisy
 * app from running a workflow hundreds of times; past the cap the day's
 * events are counted and dropped, and the drop is logged once.
 */
import pino from 'pino';
import { fireWorkflowSystemEvent } from '../../execution/workflow-trigger-engine.js';
import { listWorkflows } from '../../memory/workflow-store.js';
import { getComposio, getPreferredUserId } from './client.js';

const logger = pino({ name: 'clementine.app-events' });

export const APP_EVENT_PREFIX = 'composio.';
const DEFAULT_DAILY_CAP = 200;
const RECONNECT_MIN_MS = 30_000;
const RECONNECT_MAX_MS = 10 * 60_000;

/** The workflow event type for a Composio trigger slug. */
export function appEventTypeFor(triggerSlug: string): string {
  return `${APP_EVENT_PREFIX}${triggerSlug.trim().toLowerCase()}`;
}

/** The Composio trigger slug a workflow event type names, or null. */
export function triggerSlugFor(eventType: string): string | null {
  const type = eventType.trim().toLowerCase();
  if (!type.startsWith(APP_EVENT_PREFIX)) return null;
  const slug = type.slice(APP_EVENT_PREFIX.length);
  return /^[a-z0-9_]+$/.test(slug) ? slug.toUpperCase() : null;
}

export interface IncomingAppEvent {
  triggerSlug: string;
  toolkitSlug?: string;
  userId?: string;
  payload?: Record<string, unknown>;
  metadata?: { id?: string; connectedAccountId?: string; triggerConfig?: Record<string, unknown> };
}

/** How many events each trigger may fire a day; the rest are dropped. */
export class DailyEventCap {
  private day = '';
  private counts = new Map<string, number>();
  private announced = new Set<string>();
  constructor(private readonly limit: number) {}
  /** True when this event may fire; false once the trigger's day is full. */
  admit(triggerSlug: string, nowMs: number = Date.now()): { admitted: boolean; announce: boolean; count: number } {
    const day = new Date(nowMs).toISOString().slice(0, 10);
    if (day !== this.day) { this.day = day; this.counts.clear(); this.announced.clear(); }
    const count = (this.counts.get(triggerSlug) ?? 0) + 1;
    this.counts.set(triggerSlug, count);
    if (count <= this.limit) return { admitted: true, announce: false, count };
    const announce = !this.announced.has(triggerSlug);
    this.announced.add(triggerSlug);
    return { admitted: false, announce, count };
  }
}

export function dailyCapFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number.parseInt(env.CLEMMY_APP_EVENTS_DAILY_CAP ?? '', 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DAILY_CAP;
}

/** The payload a workflow's filter and dedupe key read: the app's own fields,
 * plus the event's identity under names no app payload uses. */
export function appEventPayload(event: IncomingAppEvent): Record<string, unknown> {
  return {
    ...(event.payload ?? {}),
    _event: {
      id: event.metadata?.id ?? null,
      triggerSlug: event.triggerSlug,
      toolkit: event.toolkitSlug ?? null,
      connectedAccountId: event.metadata?.connectedAccountId ?? null,
    },
  };
}

export interface AppEventPort {
  fire: (eventType: string, payload: unknown) => unknown;
  cap: DailyEventCap;
  log?: (level: 'info' | 'warn', fields: Record<string, unknown>, message: string) => void;
}

/** One incoming event, routed. Pure over the port, so routing is pinned. */
export function routeAppEvent(event: IncomingAppEvent, port: AppEventPort, nowMs: number = Date.now()): 'fired' | 'dropped' | 'ignored' {
  const slug = event.triggerSlug?.trim();
  if (!slug) return 'ignored';
  const verdict = port.cap.admit(slug, nowMs);
  if (!verdict.admitted) {
    if (verdict.announce) port.log?.('warn', { triggerSlug: slug, count: verdict.count }, 'app events past the daily cap for this trigger are dropped until tomorrow');
    return 'dropped';
  }
  port.fire(appEventTypeFor(slug), appEventPayload(event));
  return 'fired';
}

/** The Composio trigger slugs any enabled workflow or watch subscribes to. */
export function subscribedTriggerSlugs(workflows: ReturnType<typeof listWorkflows> = listWorkflows()): string[] {
  const slugs = new Set<string>();
  for (const entry of workflows) {
    if (entry.data.enabled === false) continue;
    for (const event of entry.data.trigger?.events ?? []) {
      const slug = typeof event.type === 'string' ? triggerSlugFor(event.type) : null;
      if (slug) slugs.add(slug);
    }
  }
  return [...slugs].sort();
}

let active: { stop: () => Promise<void> } | null = null;

/**
 * Start listening for the owner's app events and routing them to workflows.
 * Idle when Composio is not connected or nothing subscribes; reconnects with
 * backoff when the subscription drops. Returns a stop handle.
 */
export async function startAppEventListener(options: { subscribeOnlyWhenNeeded?: boolean } = {}): Promise<{ stop: () => Promise<void> } | null> {
  if (active) return active;
  const composio = getComposio();
  if (!composio) { logger.info('app events idle: Composio is not connected'); return null; }
  const userId = getPreferredUserId();
  if (!userId) { logger.info('app events idle: no Composio user id'); return null; }
  if (options.subscribeOnlyWhenNeeded !== false && subscribedTriggerSlugs().length === 0) {
    logger.info('app events idle: no workflow subscribes to an app event yet');
    return null;
  }
  const port: AppEventPort = {
    fire: fireWorkflowSystemEvent,
    cap: new DailyEventCap(dailyCapFromEnv()),
    log: (level, fields, message) => logger[level](fields, message),
  };
  let stopped = false;
  let backoff = RECONNECT_MIN_MS;
  let reconnectTimer: NodeJS.Timeout | null = null;
  const connect = async (): Promise<void> => {
    if (stopped) return;
    try {
      await composio.triggers.subscribe((incoming) => {
        try {
          const data = incoming as unknown as Record<string, unknown>;
          const event: IncomingAppEvent = {
            triggerSlug: String((data as { triggerSlug?: unknown }).triggerSlug ?? ''),
            toolkitSlug: typeof (data as { toolkitSlug?: unknown }).toolkitSlug === 'string' ? (data as { toolkitSlug: string }).toolkitSlug : undefined,
            userId: typeof (data as { userId?: unknown }).userId === 'string' ? (data as { userId: string }).userId : undefined,
            payload: ((data as { payload?: unknown }).payload && typeof (data as { payload?: unknown }).payload === 'object') ? (data as { payload: Record<string, unknown> }).payload : undefined,
            metadata: {
              id: typeof (data as { id?: unknown }).id === 'string' ? (data as { id: string }).id : undefined,
              connectedAccountId: typeof (data.metadata as { connectedAccount?: { id?: unknown } } | undefined)?.connectedAccount?.id === 'string'
                ? (data.metadata as { connectedAccount: { id: string } }).connectedAccount.id : undefined,
            },
          };
          const outcome = routeAppEvent(event, port);
          logger.info({ triggerSlug: event.triggerSlug, toolkit: event.toolkitSlug, outcome }, 'app event');
        } catch (error) {
          logger.warn({ err: error instanceof Error ? error.message : String(error) }, 'app event could not be routed');
        }
      }, { userId }, (problem) => {
        logger.warn({ problem }, 'app event subscription reported a problem; reconnecting');
        scheduleReconnect();
      });
      backoff = RECONNECT_MIN_MS;
      logger.info({ userId: userId.slice(0, 6), triggers: subscribedTriggerSlugs() }, 'app events: listening');
    } catch (error) {
      logger.warn({ err: error instanceof Error ? error.message : String(error) }, 'app event subscription failed; retrying');
      scheduleReconnect();
    }
  };
  const scheduleReconnect = (): void => {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void composio.triggers.unsubscribe().catch(() => undefined).then(connect);
    }, backoff);
    reconnectTimer.unref?.();
    backoff = Math.min(RECONNECT_MAX_MS, backoff * 2);
  };
  await connect();
  active = {
    stop: async () => {
      stopped = true;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      try { await composio.triggers.unsubscribe(); } catch { /* already closed */ }
      active = null;
    },
  };
  return active;
}
