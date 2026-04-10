import type { NotificationDestination, NotificationRecord } from './notifications.js';
import { sendDiscordChannelMessage, sendDiscordDirectMessage } from '../channels/discord.js';

function truncate(text: string, max = 1800): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
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

function buildDiscordPayload(notification: NotificationRecord): Record<string, unknown> {
  const header = `**${notification.title}**`;
  const body = truncate(notification.body, 1500);
  const meta = notification.metadata ? `\n\n\`\`\`json\n${truncate(JSON.stringify(notification.metadata, null, 2), 800)}\n\`\`\`` : '';
  return {
    content: `${header}\n${body}${meta}`,
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
    await sendDiscordDirectMessage(destination.userId, buildDiscordBotMessage(notification));
    return;
  }

  if (destination.type === 'discord_channel') {
    if (!destination.channelId) {
      throw new Error('Discord channel destination is missing channelId.');
    }
    await sendDiscordChannelMessage(destination.channelId, buildDiscordBotMessage(notification));
    return;
  }

  if (!destination.url) {
    throw new Error(`Destination ${destination.name} is missing a URL.`);
  }

  const type = destination.type === 'discord_webhook' || isDiscordWebhook(destination.url)
    ? 'discord_webhook'
    : 'generic_webhook';

  const payload = type === 'discord_webhook'
    ? buildDiscordPayload(notification)
    : buildGenericPayload(notification);

  const response = await fetch(destination.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
}

function buildDiscordBotMessage(notification: NotificationRecord): string {
  const header = `**${notification.title}**`;
  const body = truncate(notification.body, 1500);
  const meta = notification.metadata
    ? `\n\n\`\`\`json\n${truncate(JSON.stringify(notification.metadata, null, 2), 800)}\n\`\`\``
    : '';
  return `${header}\n${body}${meta}`;
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
