import type { NotificationDestination, NotificationRecord } from './notifications.js';
import {
  buildActionsForNotification,
  sendDiscordChannelMessage,
  sendDiscordChannelMessageWithComponents,
  sendDiscordDirectMessage,
} from '../channels/discord.js';

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

export async function deliverNotificationToDestination(
  notification: NotificationRecord,
  destination: NotificationDestination,
): Promise<void> {
  if (destination.type === 'discord_user') {
    if (!destination.userId) {
      throw new Error('Discord user destination is missing userId.');
    }
    // Attach approval buttons when the notification carries an
    // actionable target (approvalId for SDK interrupts, planProposalId
    // for plan proposals). Plain text otherwise. sendDiscordDirectMessage
    // splits long content automatically (src/channels/discord.ts:splitMessage)
    // and keeps the components on the last chunk only.
    const components = buildActionsForNotification(notification.metadata);
    await sendDiscordDirectMessage(destination.userId, buildDiscordBotMessage(notification), { components });
    return;
  }

  if (destination.type === 'discord_channel') {
    if (!destination.channelId) {
      throw new Error('Discord channel destination is missing channelId.');
    }
    const components = buildActionsForNotification(notification.metadata);
    if (components && components.length > 0) {
      await sendDiscordChannelMessageWithComponents(destination.channelId, buildDiscordBotMessage(notification), components);
    } else {
      await sendDiscordChannelMessage(destination.channelId, buildDiscordBotMessage(notification));
    }
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
    const chunks = splitForDiscord(`${header}\n${notification.body}`);
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
  return `${header}\n${notification.body}`;
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
