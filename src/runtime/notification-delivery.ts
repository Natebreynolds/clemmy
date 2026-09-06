import webPush from 'web-push';
import { createHash } from 'node:crypto';
import type { NotificationDestination, NotificationRecord } from './notifications.js';
import { isNeedsAttentionNotification, removeWebPushDestinationByEndpoint } from './notifications.js';
import {
  exactOriginDeliveryDestinationMatches,
  exactOriginDeliveryTarget,
  hasExactOriginDeliveryMode,
} from './exact-origin-delivery.js';
import {
  buildActionsForNotification,
  sendDiscordChannelMessage,
  sendDiscordChannelMessageWithComponents,
  sendDiscordDirectMessage,
} from '../channels/discord.js';
import { toDiscordMarkdown } from '../channels/discord-harness.js';
import {
  buildSlackActionsForNotification,
  formatSlackNotificationMessage,
  sendSlackChannelMessage,
  sendSlackChannelMessageWithBlocks,
  sendSlackDirectMessage,
  type SlackExactDeliveryIdentity,
} from '../channels/slack.js';
import { getVapidKeys } from './web-push-keys.js';

// Discord caps a single message at 2000 chars. We aim slightly lower
// to leave headroom for markdown / part labels.
const DISCORD_MAX_CHUNK = 1900;

const defaultDeliverySenders = {
  sendDiscordChannelMessage,
  sendDiscordChannelMessageWithComponents,
  sendDiscordDirectMessage,
  sendSlackChannelMessage,
  sendSlackChannelMessageWithBlocks,
  sendSlackDirectMessage,
};
let deliverySenders = { ...defaultDeliverySenders };

/** Test-only transport seam; omit input to restore production senders. */
export function _setNotificationDeliverySendersForTests(
  overrides?: Partial<typeof defaultDeliverySenders>,
): void {
  deliverySenders = overrides
    ? { ...defaultDeliverySenders, ...overrides }
    : { ...defaultDeliverySenders };
}

/**
 * Split a long body into Discord-sized chunks, preferring paragraph
 * breaks, then sentence breaks, then word breaks. Falls back to a
 * hard slice only if a single "word" is somehow > DISCORD_MAX_CHUNK.
 *
 * Returns at least one chunk (the input trimmed) for any non-empty
 * input. Previously this module just truncated at 1500 chars and
 * dropped the rest, which is why long morning briefings showed up
 * cut off in Discord.
 */
function splitForDiscord(text: string): string[] {
  const normalized = text.trim();
  if (!normalized) return [];
  if (normalized.length <= DISCORD_MAX_CHUNK) return [normalized];

  const chunks: string[] = [];
  let remaining = normalized;
  while (remaining.length > DISCORD_MAX_CHUNK) {
    const slice = remaining.slice(0, DISCORD_MAX_CHUNK);
    // Prefer paragraph break (\n\n) → newline → sentence end → space.
    let cut = slice.lastIndexOf('\n\n');
    if (cut < DISCORD_MAX_CHUNK / 2) cut = slice.lastIndexOf('\n');
    if (cut < DISCORD_MAX_CHUNK / 2) {
      const sentenceEnd = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('? '), slice.lastIndexOf('! '));
      if (sentenceEnd > DISCORD_MAX_CHUNK / 2) cut = sentenceEnd + 1;
    }
    if (cut < DISCORD_MAX_CHUNK / 2) cut = slice.lastIndexOf(' ');
    if (cut < DISCORD_MAX_CHUNK / 2) cut = DISCORD_MAX_CHUNK;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function isDiscordWebhook(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname.includes('discord.com') && parsed.pathname.includes('/api/webhooks/');
  } catch {
    return false;
  }
}

function buildGenericPayload(notification: NotificationRecord): Record<string, unknown> {
  return {
    id: notification.id,
    kind: notification.kind,
    title: notification.title,
    body: notification.body,
    created_at: notification.createdAt,
    metadata: notification.metadata ?? {},
  };
}

/** Discord can reject a repeated create with the same nonce. Bind that nonce
 * to the durable notification id so a worker crash after provider acceptance
 * but before its local receipt does not normally create a second terminal. */
function exactDiscordDeliveryNonce(notification: NotificationRecord): string | undefined {
  const target = exactOriginDeliveryTarget(notification);
  if (target?.type !== 'discord_channel') return undefined;
  return createHash('sha256')
    .update(`clementine-exact-discord-delivery:v1\0${notification.id}`)
    .digest('hex')
    .slice(0, 24);
}

/** Slack has no Discord-style nonce. Commit one non-sensitive metadata key to
 * the durable notification id, then search only the admitted destination and
 * the notification's bounded creation-time window before every exact post. */
function exactSlackDeliveryIdentity(
  notification: NotificationRecord,
): SlackExactDeliveryIdentity | undefined {
  const target = exactOriginDeliveryTarget(notification);
  if (target?.type !== 'slack_channel' && target?.type !== 'slack_user') return undefined;
  const createdAt = Date.parse(notification.createdAt);
  if (!Number.isFinite(createdAt)) {
    throw new Error('Exact Slack delivery requires a valid durable notification timestamp.');
  }
  const oldestSeconds = Math.max(0, Math.floor((createdAt - 5 * 60_000) / 1000));
  return {
    key: createHash('sha256')
      .update(`clementine-exact-slack-delivery:v1\0${notification.id}`)
      .digest('hex')
      .slice(0, 32),
    oldestTs: `${oldestSeconds}.000000`,
  };
}

/** One short, sentence-case fact from a metadata value, or '' if it isn't one. */
function pushFact(metadata: Record<string, unknown> | undefined, key: string, max = 60): string {
  const value = metadata?.[key];
  if (typeof value !== 'string') return '';
  const single = value.replace(/\s+/g, ' ').trim();
  if (!single) return '';
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}

/** A tool slug as words. Slugs are our own vocabulary, never user content. */
function pushToolLabel(metadata: Record<string, unknown> | undefined): string {
  const raw = pushFact(metadata, 'tool', 40) || pushFact(metadata, 'toolName', 40);
  return raw.replace(/[_-]+/g, ' ').toLowerCase();
}

function pushCount(metadata: Record<string, unknown> | undefined, key: string): number {
  const value = metadata?.[key];
  return Array.isArray(value) ? value.length : 0;
}

/**
 * The sentence a banner says.
 *
 * WHY THIS IS DERIVED AND NOT COPIED. Both push transports used to send one of
 * two fixed pairs ("Clem needs you" / "Clementine"), which is the defining
 * chat-app ping: a banner that never names the thing teaches the user that
 * banners carry no information. The daemon knows the run, the gate and the
 * decision at the moment it sends, so it says which.
 *
 * WHY IT IS DERIVED FROM METADATA AND NOT FROM title/body. Those two fields
 * carry the user's own material — recipients, quotes, results — and this
 * payload is the one part of the product that crosses Apple's / Google's push
 * relay in the clear. Typed metadata (a workflow's name, a tool slug, a failure
 * count, a status) says what happened without shipping what it was about; the
 * PWA still fetches the full notification from the authenticated Inbox after
 * the tap. So: name the work, never quote it.
 *
 * WHAT IT NEVER CLAIMS. A notification record carries no write disposition
 * (see packages/chat-engine/src/write-ledger.ts — a reservation is not a
 * receipt), so no copy here says a send/create landed. "Finished" describes the
 * RUN, which the record does settle; what it changed out there is a question
 * only the run's own ledger answers, one tap away.
 */
function buildPushCopy(notification: NotificationRecord): { title: string; body: string } {
  const meta = notification.metadata;
  const workflow = pushFact(meta, 'workflow');
  const status = pushFact(meta, 'status', 40);
  const needsUser = !notification.read
    && meta?.inboxOnly !== true
    && (
      notification.kind === 'approval'
      || isNeedsAttentionNotification(notification)
      || typeof meta?.checkInId === 'string'
      || typeof meta?.questionId === 'string'
    );

  if (needsUser) {
    if (typeof meta?.checkInId === 'string' || typeof meta?.questionId === 'string') {
      return {
        title: workflow ? `${workflow} has a question` : 'Clem has a question',
        body: 'She paused there until you answer.',
      };
    }
    if (typeof meta?.planProposalId === 'string') {
      return { title: 'A plan is waiting on you', body: "Clem drafted the steps and won't start until you say go." };
    }
    if (meta?.kind === 'check_in_proposal') {
      return { title: 'Clem suggested a check-in', body: 'Tap to approve or decline it.' };
    }
    if (meta?.kind === 'agent_proposal') {
      return { title: 'Clem drafted an agent', body: 'Tap to review what it would do.' };
    }
    if (typeof meta?.trustProposalId === 'string') {
      return { title: 'Standing permission request', body: 'Clem is asking to stop checking with you for one exact scope.' };
    }
    if (status === 'blocked_capability') {
      return {
        title: workflow ? `${workflow} is blocked` : 'A workflow is blocked',
        body: 'A step needs an account before it can go on. Nothing was sent.',
      };
    }
    if (notification.kind === 'approval' || typeof meta?.approvalId === 'string') {
      const tool = pushToolLabel(meta);
      return {
        title: 'Approval needed',
        body: tool ? `Clem is waiting on a yes before she runs ${tool}.` : 'Clem is holding a step until you decide.',
      };
    }
    return {
      title: workflow ? `${workflow} needs a look` : 'Something needs a look',
      body: 'Tap to see what it is.',
    };
  }

  if (workflow) {
    if (status === 'error') return { title: `${workflow} failed`, body: 'Tap to see where it stopped.' };
    if (status === 'cancelled') return { title: `${workflow} was cancelled`, body: 'Tap to see how far it got.' };
    if (meta?.noOp === true) return { title: `Nothing new from ${workflow}`, body: 'She checked and there was nothing to do.' };
    const failures = pushCount(meta, 'forEachFailures');
    if (failures > 0) {
      return {
        title: `${workflow} finished with ${failures} problem${failures === 1 ? '' : 's'}`,
        body: 'Tap to see which items failed.',
      };
    }
    return { title: `${workflow} finished`, body: 'Tap to see what it did.' };
  }

  // Background tasks are titled by the daemon itself with these exact prefixes
  // (src/execution/background-tasks.ts). Matching OUR prefix is not the same as
  // forwarding the task's own name, which follows the colon and stays here.
  if (notification.kind === 'execution') {
    const title = notification.title.trim().toLowerCase();
    if (title.startsWith('background task completed:')) {
      return { title: 'A background task finished', body: 'Tap to see what it did.' };
    }
    if (title.startsWith('background task failed:')) {
      return { title: 'A background task failed', body: 'Tap to see where it stopped.' };
    }
    if (title.startsWith('background task aborted:') || title.startsWith('background task interrupted:')) {
      return { title: 'A background task stopped early', body: 'Tap to see how far it got.' };
    }
  }

  return { title: 'Clementine', body: 'Tap to read the update.' };
}

/**
 * The one route the native iOS shell will accept.
 *
 * apps/ios PendingPushNavigationRoute.parse REFUSES to park anything but
 * `/m/?tab=inbox&notification=<id>` with exactly those two query items — a
 * deliberately tiny contract so a push payload can never steer the pinned web
 * view. A richer route sent to APNs is not a worse landing; it is no landing at
 * all (park() fails and the tap does nothing).
 */
function inboxNotificationUrl(notification: NotificationRecord): string {
  return `/m/?tab=inbox&notification=${encodeURIComponent(notification.id)}`;
}

/**
 * Where the tap lands, for the transports that can navigate freely (Web Push;
 * the service worker calls clients.navigate with this).
 *
 * A decision belongs in the Inbox, which focuses the exact card. Everything
 * else that names a harness session belongs on that RUN — the screen that
 * leads with what changed — because a finished run's Inbox row is a paragraph
 * about work whose own page already exists. A record with neither stays on its
 * Inbox row.
 */
function pushTargetUrl(notification: NotificationRecord): string {
  const meta = notification.metadata;
  const decides = notification.kind === 'approval'
    || isNeedsAttentionNotification(notification)
    || typeof meta?.approvalId === 'string'
    || typeof meta?.planProposalId === 'string'
    || typeof meta?.trustProposalId === 'string'
    || typeof meta?.questionId === 'string'
    || typeof meta?.checkInId === 'string';
  if (decides) return inboxNotificationUrl(notification);
  // Only a harness session id opens the run view (/m/api/runs/:sessionId is
  // keyed on it); a workflow's own runId is a different namespace and would
  // 404, so it is deliberately not used here.
  const session = pushFact(meta, 'runSessionId', 200) || pushFact(meta, 'sessionId', 200);
  return session
    ? `/m/?tab=activity&run=${encodeURIComponent(session)}`
    : inboxNotificationUrl(notification);
}

/**
 * Sanitized payload for Web Push. The copy is derived from typed metadata (see
 * buildPushCopy) so the banner names the work without any of the notification's
 * own prose crossing the relay. The notification id is an address, not content.
 */
function buildWebPushPayload(notification: NotificationRecord): {
  title: string;
  body: string;
  url: string;
  notificationId: string;
  kind: string;
} {
  const copy = buildPushCopy(notification);
  return {
    title: copy.title,
    body: copy.body,
    url: pushTargetUrl(notification),
    notificationId: notification.id,
    kind: notification.kind,
  };
}

// Shared bot-path delivery gate. `inlineKey` names the metadata flag set when
// a live chat transport already showed an INLINE approval card for this same
// approval (so the duplicate notification-delivery card is suppressed and the
// surface matches the desktop's single-card behavior). The title-prefix
// suppressions are channel-agnostic.
function shouldDeliverBotNotification(notification: NotificationRecord, inlineKey: 'discordInlineHandled' | 'slackInlineHandled'): boolean {
  if (notification.silent) return false;
  // Exact-origin is an explicit delivery instruction. Lifecycle/title and
  // inline-card suppression heuristics must not silently eat its one allowed
  // follow-up. A corrupt envelope is rejected by the send-time match guard.
  if (hasExactOriginDeliveryMode(notification)) {
    return Boolean(exactOriginDeliveryTarget(notification));
  }
  if (notification.metadata?.[inlineKey] === true) return false;

  const title = notification.title.trim().toLowerCase();
  if (notification.kind === 'system' && title.startsWith('plan approved:')) return false;
  if (notification.kind === 'execution' && title.startsWith('approved plan queued:')) return false;
  if (notification.kind === 'execution' && title.startsWith('background task queued:')) return false;
  if (notification.kind === 'execution' && title.startsWith('background task started:')) return false;
  // 'progress:'/'heartbeat:' are the high-frequency, tool-triggered and
  // cancellation lifecycle pings — dashboard-only (they're also emitted
  // silent, so the top-of-function silent gate already drops them; these
  // prefixes keep them suppressed even if a future caller forgets `silent`).
  // The loud, rate-limited time-based progress channel uses the distinct
  // 'background task update:' prefix and is intentionally NOT listed here so
  // it reaches the report-back channel like a terminal report-back does.
  if (notification.kind === 'execution' && title.startsWith('background task progress:')) return false;
  if (notification.kind === 'execution' && title.startsWith('background task heartbeat:')) return false;

  return true;
}

function shouldDeliverDiscordNotification(notification: NotificationRecord): boolean {
  return shouldDeliverBotNotification(notification, 'discordInlineHandled');
}

function shouldDeliverSlackNotification(notification: NotificationRecord): boolean {
  return shouldDeliverBotNotification(notification, 'slackInlineHandled');
}

// Terminal report-backs — a finished run's output — are the notifications that
// must LAND somewhere the user actually sees. Workflow + cron notifications
// exist only to report a completed run; background-task completion/failure
// carry the actual result. (The mid-run background lifecycle pings are already
// suppressed by shouldDeliverBotNotification.) Title-prefix matching mirrors
// the idiom that gate already uses.
const TERMINAL_EXECUTION_TITLE_PREFIXES = [
  'background task completed:',
  'background task failed:',
  'background task aborted:',
  'background task interrupted:',
];

function isTerminalReportBack(notification: NotificationRecord): boolean {
  if (notification.kind === 'workflow' || notification.kind === 'cron') return true;
  if (notification.kind === 'execution') {
    const title = notification.title.trim().toLowerCase();
    return TERMINAL_EXECUTION_TITLE_PREFIXES.some((prefix) => title.startsWith(prefix));
  }
  return false;
}

// Decide which thread (if any) a Slack channel delivery should post into.
// Slack IM (direct-message) channel ids start with 'D'. A terminal report-back
// that originated in a Slack assistant-pane DM carries that pane's thread_ts;
// threading a completion back into the now-stale pane buries it in "hidden
// history" — no unread badge, only findable by scrolling the pane. For IM
// channels we DROP the stale thread so the result lands as a fresh top-level
// DM in the Messages surface. Real channels ('C'/'G') keep the thread — there
// the thread IS the ongoing conversation, and mid-run approvals (which resume
// off a threaded reply) still thread correctly everywhere.
function slackThreadForDelivery(
  notification: NotificationRecord,
  destination: NotificationDestination,
): string | undefined {
  if (hasExactOriginDeliveryMode(notification)) {
    const target = exactOriginDeliveryTarget(notification);
    if (target?.type !== 'slack_channel') return undefined;
    // Exact delivery freezes the destination, but terminal placement still
    // needs to stay visible. Slack assistant-pane DMs carry a thread_ts that
    // becomes hidden history once the pane closes, so terminal results post
    // at the admitted D channel's top level just like non-exact report-backs.
    if (target.channelId.startsWith('D') && isTerminalReportBack(notification)) {
      return undefined;
    }
    return target.threadTs;
  }
  const threadTs = destination.threadTs;
  if (!threadTs) return undefined;
  const isImChannel = (destination.channelId ?? '').startsWith('D');
  if (isImChannel && isTerminalReportBack(notification)) return undefined;
  return threadTs;
}

function buildDiscordComponentsForNotification(notification: NotificationRecord) {
  if (hasExactOriginDeliveryMode(notification)) return undefined;
  if (notification.kind !== 'approval') return undefined;
  return buildActionsForNotification(notification.metadata);
}

function buildSlackBlocksForNotification(notification: NotificationRecord) {
  if (hasExactOriginDeliveryMode(notification)) return undefined;
  if (notification.kind !== 'approval') return undefined;
  return buildSlackActionsForNotification(notification.metadata);
}

// Slack mrkdwn uses *bold* (one asterisk), not Discord's **bold** — the title
// emphasis is applied inside the send helpers' toSlackMrkdwn pass, so here we
// emit the same `**title**\nbody` shape the Discord path uses for symmetry.
function buildSlackBotMessage(notification: NotificationRecord): string {
  if (hasExactOriginDeliveryMode(notification)) {
    if (!exactOriginDeliveryTarget(notification)) {
      throw new Error('Exact-origin delivery target is missing or corrupt.');
    }
    return notification.body;
  }
  return formatSlackNotificationMessage(notification.title, notification.body, notification.metadata);
}

export async function deliverNotificationToDestination(
  notification: NotificationRecord,
  destination: NotificationDestination,
): Promise<void> {
  if (
    hasExactOriginDeliveryMode(notification)
    && !exactOriginDeliveryDestinationMatches(notification, destination)
  ) {
    throw new Error('Exact-origin delivery destination does not match its admitted target.');
  }
  if (destination.type === 'desktop') {
    // The durable notification store lives ON this machine — reaching it IS
    // desktop delivery; the app shell toasts loud unread records from its own
    // poll. This leg exists so loud notifications always resolve at least one
    // destination (never "deferred: no destinations", live 2026-07-22) and so
    // the delivery ledger records the surface.
    return;
  }
  if (destination.type === 'web_push') {
    if (!destination.pushEndpoint || !destination.pushP256dh || !destination.pushAuth) {
      throw new Error('web_push destination is missing endpoint / keys.');
    }
    const vapid = getVapidKeys();
    const payload = JSON.stringify(buildWebPushPayload(notification));
    try {
      await webPush.sendNotification(
        {
          endpoint: destination.pushEndpoint,
          keys: { p256dh: destination.pushP256dh, auth: destination.pushAuth },
        },
        payload,
        {
          vapidDetails: {
            subject: vapid.subject,
            publicKey: vapid.publicKey,
            privateKey: vapid.privateKey,
          },
          TTL: 60 * 5, // approval pings stay relevant for ~5 minutes
        },
      );
    } catch (err) {
      // 404/410 from the push service means the subscription is gone
      // (user uninstalled, revoked permission, switched devices).
      // Reap the destination so the queue stops retrying forever.
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        removeWebPushDestinationByEndpoint(destination.pushEndpoint);
        throw new Error(`Web Push subscription gone (HTTP ${status}); destination removed.`);
      }
      throw err;
    }
    return;
  }

  if (destination.type === 'apns') {
    if (!destination.apnsDeviceToken) {
      throw new Error('APNs destination is missing a device token.');
    }
    const { sendApnsAlert, isApnsTokenGone, isApnsConfigured } = await import('./apns.js');
    if (!isApnsConfigured()) {
      // Registration is accepted before the signing key exists so pushes
      // start the moment it lands; until then this leg reports honestly
      // instead of retrying into a wall.
      throw new Error('APNs is not configured yet (no signing key). See state/apns.json.');
    }
    const copy = buildPushCopy(notification);
    const result = await sendApnsAlert({
      deviceToken: destination.apnsDeviceToken,
      title: copy.title,
      body: copy.body,
      // The native shell parks ONLY the Inbox route (see inboxNotificationUrl).
      // Web Push's richer target would be refused by its parser, which is a
      // tap that does nothing at all — so this leg keeps the route it accepts.
      url: inboxNotificationUrl(notification),
    });
    if (result.ok) return;
    if (isApnsTokenGone(result)) {
      const { removeApnsDestinationByToken } = await import('./notifications.js');
      removeApnsDestinationByToken(destination.apnsDeviceToken);
      throw new Error(`APNs token gone (${result.reason ?? result.status}); destination removed.`);
    }
    throw new Error(`APNs delivery failed: HTTP ${result.status}${result.reason ? ` ${result.reason}` : ''}`);
  }

  if (destination.type === 'discord_user') {
    if (!destination.userId) {
      throw new Error('Discord user destination is missing userId.');
    }
    if (!shouldDeliverDiscordNotification(notification)) return;
    // Attach approval buttons when the notification carries an
    // actionable target (approvalId for SDK interrupts, planProposalId
    // for plan proposals). Plain text otherwise. sendDiscordDirectMessage
    // splits long content automatically (src/channels/discord.ts:splitMessage)
    // and keeps the components on the last chunk only.
    const components = buildDiscordComponentsForNotification(notification);
    await deliverySenders.sendDiscordDirectMessage(destination.userId, buildDiscordBotMessage(notification), { components });
    return;
  }

  if (destination.type === 'discord_channel') {
    if (!destination.channelId) {
      throw new Error('Discord channel destination is missing channelId.');
    }
    if (!shouldDeliverDiscordNotification(notification)) return;
    const components = buildDiscordComponentsForNotification(notification);
    if (components && components.length > 0) {
      await deliverySenders.sendDiscordChannelMessageWithComponents(destination.channelId, buildDiscordBotMessage(notification), components);
    } else {
      const nonce = exactDiscordDeliveryNonce(notification);
      await deliverySenders.sendDiscordChannelMessage(
        destination.channelId,
        buildDiscordBotMessage(notification),
        nonce ? { nonce, enforceNonce: true } : {},
      );
    }
    return;
  }

  if (destination.type === 'slack_user') {
    if (!destination.userId) {
      throw new Error('Slack user destination is missing userId.');
    }
    if (!shouldDeliverSlackNotification(notification)) return;
    const blocks = buildSlackBlocksForNotification(notification);
    const exactDelivery = exactSlackDeliveryIdentity(notification);
    await deliverySenders.sendSlackDirectMessage(destination.userId, buildSlackBotMessage(notification), {
      blocks,
      ...(exactDelivery ? { exactDelivery } : {}),
    });
    return;
  }

  if (destination.type === 'slack_channel') {
    if (!destination.channelId) {
      throw new Error('Slack channel destination is missing channelId.');
    }
    if (!shouldDeliverSlackNotification(notification)) return;
    const blocks = buildSlackBlocksForNotification(notification);
    const threadTs = slackThreadForDelivery(notification, destination);
    const exactDelivery = exactSlackDeliveryIdentity(notification);
    if (blocks && blocks.length > 0) {
      await deliverySenders.sendSlackChannelMessageWithBlocks(destination.channelId, buildSlackBotMessage(notification), blocks, {
        threadTs,
        ...(exactDelivery ? { exactDelivery } : {}),
      });
    } else {
      await deliverySenders.sendSlackChannelMessage(destination.channelId, buildSlackBotMessage(notification), {
        threadTs,
        ...(exactDelivery ? { exactDelivery } : {}),
      });
    }
    return;
  }

  if (destination.type === 'slack_webhook') {
    // Slack Incoming Webhook — the near-zero-setup outbound path. A single
    // POST with { text } renders mrkdwn. (Approval buttons require the bot
    // token path above; a raw webhook can't carry interactive actions.)
    if (!destination.url) throw new Error(`Destination ${destination.name} is missing a URL.`);
    const response = await fetch(destination.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `*${notification.title}*\n${notification.body}` }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return;
  }

  if (!destination.url) {
    throw new Error(`Destination ${destination.name} is missing a URL.`);
  }

  const type = destination.type === 'discord_webhook' || isDiscordWebhook(destination.url)
    ? 'discord_webhook'
    : 'generic_webhook';

  if (type === 'discord_webhook') {
    // Webhooks have no SDK splitter, so do it here. Post N times with
    // (i/N) labels on multi-part messages so the user knows there's
    // more coming.
    const header = `**${notification.title}**`;
    // Same GFM→Discord adaptation as the bot path (buildDiscordBotMessage) so a
    // table/deep-header body doesn't arrive as raw pipes over a webhook either.
    const chunks = splitForDiscord(toDiscordMarkdown(`${header}\n${notification.body}`));
    const total = chunks.length;
    for (let i = 0; i < total; i++) {
      const label = total > 1 ? ` *(${i + 1}/${total})*` : '';
      const response = await fetch(destination.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: chunks[i] + label }),
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
    }
    return;
  }

  const response = await fetch(destination.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(buildGenericPayload(notification)),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
}

/**
 * Build the FULL bot-path message. No truncation here — the underlying
 * sendDiscordDirectMessage / sendDiscordChannelMessage call splitMessage()
 * to break into multiple Discord posts when the body exceeds the 2000-char
 * per-message cap. Previously this function hard-truncated at 1500 chars
 * and the splitter never had anything to split, so long morning briefings
 * arrived cut off with no continuation. That bug is fixed by returning
 * the full body and letting the splitter do its job.
 */
function buildDiscordBotMessage(notification: NotificationRecord): string {
  if (hasExactOriginDeliveryMode(notification)) {
    if (!exactOriginDeliveryTarget(notification)) {
      throw new Error('Exact-origin delivery target is missing or corrupt.');
    }
    return toDiscordMarkdown(notification.body);
  }
  const header = `**${notification.title}**`;
  // Adapt GFM tables / deep headers / horizontal rules into the subset
  // Discord actually renders, so a report body doesn't arrive looking like
  // raw test output (bold title is left intact by the pass).
  return toDiscordMarkdown(`${header}\n${notification.body}`);
}

export async function testNotificationDestination(destination: NotificationDestination): Promise<void> {
  await deliverNotificationToDestination(
    {
      id: `test-${Date.now()}`,
      kind: 'system',
      title: 'Clementine Delivery Test',
      body: 'This is a test notification from clementine-next.',
      createdAt: new Date().toISOString(),
      read: false,
      metadata: {
        destination: destination.name,
        type: destination.type,
      },
    },
    destination,
  );
}

export const notificationDeliveryInternalsForTest = {
  buildWebPushPayload,
  buildPushCopy,
  pushTargetUrl,
  inboxNotificationUrl,
  buildDiscordComponentsForNotification,
  buildSlackBlocksForNotification,
  shouldDeliverDiscordNotification,
  isTerminalReportBack,
  slackThreadForDelivery,
  buildDiscordBotMessage,
  buildSlackBotMessage,
  exactDiscordDeliveryNonce,
  exactSlackDeliveryIdentity,
};
