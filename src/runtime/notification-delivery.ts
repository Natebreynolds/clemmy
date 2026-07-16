import webPush from 'web-push';
import type { NotificationDestination, NotificationRecord } from './notifications.js';
import { removeWebPushDestinationByEndpoint } from './notifications.js';
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
} from '../channels/slack.js';
import { getVapidKeys } from './web-push-keys.js';

// Discord caps a single message at 2000 chars. We aim slightly lower
// to leave headroom for markdown / part labels.
const DISCORD_MAX_CHUNK = 1900;

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

/**
 * Sanitized payload for Web Push. We deliberately strip everything
 * beyond a short generic title + body so the push payload that lands
 * on Apple/Google's relay carries no sensitive content. The PWA fetches
 * the full notification via `/m/api/events/<id>` after the user taps.
 */
function buildWebPushPayload(notification: NotificationRecord): {
  title: string;
  body: string;
  url: string;
  notificationId: string;
  kind: string;
} {
  // Approvals show a slightly more specific title so the user knows
  // a yes/no is waiting; everything else is generic.
  const isApproval = notification.kind === 'approval';
  return {
    title: isApproval ? 'Approval pending' : 'Clementine',
    body: isApproval
      ? `Tap to review${notification.metadata?.tool ? ` (${String(notification.metadata.tool)})` : ''}`
      : (notification.title || 'You have an update.'),
    url: isApproval ? '/m/?tab=inbox' : '/m/',
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
  const threadTs = destination.threadTs;
  if (!threadTs) return undefined;
  const isImChannel = (destination.channelId ?? '').startsWith('D');
  if (isImChannel && isTerminalReportBack(notification)) return undefined;
  return threadTs;
}

function buildDiscordComponentsForNotification(notification: NotificationRecord) {
  if (notification.kind !== 'approval') return undefined;
  return buildActionsForNotification(notification.metadata);
}

function buildSlackBlocksForNotification(notification: NotificationRecord) {
  if (notification.kind !== 'approval') return undefined;
  return buildSlackActionsForNotification(notification.metadata);
}

// Slack mrkdwn uses *bold* (one asterisk), not Discord's **bold** — the title
// emphasis is applied inside the send helpers' toSlackMrkdwn pass, so here we
// emit the same `**title**\nbody` shape the Discord path uses for symmetry.
function buildSlackBotMessage(notification: NotificationRecord): string {
  return formatSlackNotificationMessage(notification.title, notification.body, notification.metadata);
}

export async function deliverNotificationToDestination(
  notification: NotificationRecord,
  destination: NotificationDestination,
): Promise<void> {
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
    await sendDiscordDirectMessage(destination.userId, buildDiscordBotMessage(notification), { components });
    return;
  }

  if (destination.type === 'discord_channel') {
    if (!destination.channelId) {
      throw new Error('Discord channel destination is missing channelId.');
    }
    if (!shouldDeliverDiscordNotification(notification)) return;
    const components = buildDiscordComponentsForNotification(notification);
    if (components && components.length > 0) {
      await sendDiscordChannelMessageWithComponents(destination.channelId, buildDiscordBotMessage(notification), components);
    } else {
      await sendDiscordChannelMessage(destination.channelId, buildDiscordBotMessage(notification));
    }
    return;
  }

  if (destination.type === 'slack_user') {
    if (!destination.userId) {
      throw new Error('Slack user destination is missing userId.');
    }
    if (!shouldDeliverSlackNotification(notification)) return;
    const blocks = buildSlackBlocksForNotification(notification);
    await sendSlackDirectMessage(destination.userId, buildSlackBotMessage(notification), { blocks });
    return;
  }

  if (destination.type === 'slack_channel') {
    if (!destination.channelId) {
      throw new Error('Slack channel destination is missing channelId.');
    }
    if (!shouldDeliverSlackNotification(notification)) return;
    const blocks = buildSlackBlocksForNotification(notification);
    const threadTs = slackThreadForDelivery(notification, destination);
    if (blocks && blocks.length > 0) {
      await sendSlackChannelMessageWithBlocks(destination.channelId, buildSlackBotMessage(notification), blocks, {
        threadTs,
      });
    } else {
      await sendSlackChannelMessage(destination.channelId, buildSlackBotMessage(notification), {
        threadTs,
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
  buildDiscordComponentsForNotification,
  buildSlackBlocksForNotification,
  shouldDeliverDiscordNotification,
  isTerminalReportBack,
  slackThreadForDelivery,
  buildDiscordBotMessage,
  buildSlackBotMessage,
};
