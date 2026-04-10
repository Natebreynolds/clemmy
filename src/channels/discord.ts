import pino from 'pino';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  type ButtonInteraction,
  Partials,
  type Message,
} from 'discord.js';
import {
  DISCORD_ALLOWED_CHANNELS,
  ASSISTANT_NAME,
  DISCORD_BOT_TOKEN,
  DISCORD_ENABLED,
  DISCORD_REQUIRE_MENTION,
} from '../config.js';
import { ClementineAssistant } from '../assistant/core.js';
import { getOrCreateDiscordSessionId } from './discord-store.js';
import type { ApprovalResolutionResult, PendingApproval } from '../types.js';
import {
  getNotification,
  listNotifications,
  listQueuedNotificationDeliveries,
  markNotificationRead,
  requeueNotificationDelivery,
} from '../runtime/notifications.js';

const logger = pino({ name: 'clementine-next.discord' });

interface DiscordRuntimeStatus {
  enabled: boolean;
  connected: boolean;
  userTag?: string;
  startedAt?: string;
  guildCount: number;
}

const DISCORD_CUSTOM_ID_PREFIX = 'clementine';

let discordClient: Client | null = null;
let startPromise: Promise<void> | null = null;
let status: DiscordRuntimeStatus = {
  enabled: DISCORD_ENABLED,
  connected: false,
  guildCount: 0,
};

function splitMessage(text: string, maxLength = 1900): string[] {
  const normalized = text.trim();
  if (!normalized) return [];
  if (normalized.length <= maxLength) return [normalized];

  const chunks: string[] = [];
  let remaining = normalized;
  while (remaining.length > maxLength) {
    const slice = remaining.slice(0, maxLength);
    const breakIndex = Math.max(slice.lastIndexOf('\n'), slice.lastIndexOf(' '));
    const cut = breakIndex > 200 ? breakIndex : maxLength;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function truncate(text: string, maxLength = 120): string {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function channelAllowed(message: Message): boolean {
  if (message.channel.type === ChannelType.DM) return true;
  if (DISCORD_ALLOWED_CHANNELS.length === 0) return true;
  return DISCORD_ALLOWED_CHANNELS.includes(message.channelId);
}

function extractPrompt(message: Message<boolean>): string {
  const mentionPattern = new RegExp(`<@!?${message.client.user?.id}>`, 'g');
  const stripped = message.content.replace(mentionPattern, '').trim();
  if (message.channel.type === ChannelType.DM) {
    return stripped || message.content.trim();
  }
  return stripped;
}

function shouldRespond(message: Message<boolean>): boolean {
  if (message.author.bot) return false;
  if (!message.content.trim()) return false;
  if (!channelAllowed(message)) return false;
  if (message.channel.type === ChannelType.DM) return true;
  if (!DISCORD_REQUIRE_MENTION) return true;
  return message.mentions.has(message.client.user?.id ?? '');
}

function buildChannelLabel(message: Message<boolean>): string {
  if (message.guildId) {
    return `discord:${message.guildId}:${message.channelId}`;
  }
  return `discord:dm:${message.channelId}`;
}

function normalizeCommandText(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  const withoutSlash = trimmed.startsWith('/') ? trimmed.slice(1).trim() : trimmed;
  const assistantPrefix = new RegExp(`^${ASSISTANT_NAME}\\s+`, 'i');
  return withoutSlash.replace(assistantPrefix, '').trim();
}

function renderApprovalList(approvals: PendingApproval[]): string {
  if (approvals.length === 0) {
    return 'No pending approvals.';
  }
  return approvals
    .slice(0, 15)
    .map((approval) => `- \`${approval.id}\` | ${approval.toolName} | session ${approval.sessionId}`)
    .join('\n');
}

function buildApprovalActions(approvalId: string) {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${DISCORD_CUSTOM_ID_PREFIX}:approve:${approvalId}`)
        .setLabel('Approve')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`${DISCORD_CUSTOM_ID_PREFIX}:reject:${approvalId}`)
        .setLabel('Reject')
        .setStyle(ButtonStyle.Danger),
    ),
  ];
}

function buildNotificationActions(notificationId: string, read: boolean) {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${DISCORD_CUSTOM_ID_PREFIX}:read:${notificationId}`)
        .setLabel(read ? 'Mark Read Again' : 'Mark Read')
        .setStyle(ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId(`${DISCORD_CUSTOM_ID_PREFIX}:retry:${notificationId}`)
        .setLabel('Retry Delivery')
        .setStyle(ButtonStyle.Primary),
    ),
  ];
}

function relevantApprovalsForMessage(message: Message<boolean>, approvals: PendingApproval[]): PendingApproval[] {
  const channel = buildChannelLabel(message);
  const owned = approvals.filter((approval) => approval.userId === message.author.id || approval.channel === channel);
  return owned.length > 0 ? owned : approvals;
}

function relevantNotificationsForUser(userId: string) {
  return listNotifications(50).filter((notification) => {
    const metadata = notification.metadata ?? {};
    return metadata.discordUserId === userId || metadata.userId === userId;
  });
}

function renderNotificationList(userId: string): string {
  const notifications = relevantNotificationsForUser(userId).slice(0, 10);
  if (notifications.length === 0) {
    return 'No Discord-routed notifications for you.';
  }

  return notifications.map((notification) => {
    const queue = listQueuedNotificationDeliveries().find((item) => item.notificationId === notification.id);
    const retryCount = queue ? Object.keys(queue.nextAttemptAtByDestination ?? {}).length : 0;
    const failedCount = queue?.failedDestinationIds?.length ?? 0;
    const statusBits = [
      notification.read ? 'read' : 'unread',
      notification.deliveredAt ? 'delivered' : 'pending',
      failedCount > 0 ? `failed:${failedCount}` : '',
      retryCount > 0 ? `retry:${retryCount}` : '',
    ].filter(Boolean).join(' | ');
    return `- \`${notification.id}\` | ${notification.title} | ${statusBits}`;
  }).join('\n');
}

function renderDiscordStatus(message: Message<boolean>, assistant: ClementineAssistant): string {
  const discordStatus = getDiscordRuntimeStatus();
  const ownedApprovals = relevantApprovalsForMessage(message, assistant.getRuntime().listPendingApprovals())
    .filter((approval) => approval.userId === message.author.id || approval.channel === buildChannelLabel(message));
  const userNotifications = relevantNotificationsForUser(message.author.id);
  const queuedForUser = listQueuedNotificationDeliveries().filter((item) =>
    userNotifications.some((notification) => notification.id === item.notificationId),
  );

  return [
    `Discord status: ${discordStatus.connected ? 'connected' : 'disconnected'}`,
    `Bot: ${discordStatus.userTag ?? 'unknown'}`,
    `Guilds: ${discordStatus.guildCount}`,
    `Your pending approvals: ${ownedApprovals.length}`,
    `Your notifications: ${userNotifications.filter((item) => !item.read).length} unread / ${userNotifications.length} total`,
    `Your queued deliveries: ${queuedForUser.length}`,
  ].join('\n');
}

function approvalResultText(result: ApprovalResolutionResult): string {
  return [
    `Approval ${result.status}: \`${result.approvalId}\``,
    '',
    result.text,
  ].join('\n');
}

async function handleDiscordCommand(message: Message<boolean>, assistant: ClementineAssistant, prompt: string): Promise<boolean> {
  const normalized = normalizeCommandText(prompt);
  const runtime = assistant.getRuntime();

  if (/^(help|discord help|commands)$/i.test(normalized)) {
    await sendChunks(
      message.channel,
      [
        'Discord commands:',
        '`help`',
        '`status`',
        '`approvals`',
        '`approve <approval_id>`',
        '`reject <approval_id>`',
        '`notifications`',
        '`read <notification_id>`',
        '`retry <notification_id>`',
        '',
        'Any other message is sent to the assistant.',
      ].join('\n'),
      message,
    );
    return true;
  }

  if (/^status$/i.test(normalized)) {
    await sendChunks(message.channel, renderDiscordStatus(message, assistant), message);
    return true;
  }

  if (/^(approvals|pending approvals)$/i.test(normalized)) {
    const approvals = relevantApprovalsForMessage(message, runtime.listPendingApprovals());
    await sendChunks(message.channel, renderApprovalList(approvals), message);
    for (const approval of approvals.slice(0, 5)) {
      await sendComponentMessage(message.channel, {
        content: `Approval \`${approval.id}\` for \`${approval.toolName}\``,
        components: buildApprovalActions(approval.id),
      });
    }
    return true;
  }

  if (/^(notifications|inbox|my notifications)$/i.test(normalized)) {
    const notifications = relevantNotificationsForUser(message.author.id).slice(0, 5);
    await sendChunks(message.channel, renderNotificationList(message.author.id), message);
    for (const notification of notifications) {
      await sendComponentMessage(message.channel, {
        content: `Notification \`${notification.id}\`\n${truncate(notification.title, 100)}`,
        components: buildNotificationActions(notification.id, notification.read),
      });
    }
    return true;
  }

  const match = normalized.match(/^(approve|reject)\s+([a-zA-Z0-9-]+)$/i);
  if (match) {
    const approved = match[1].toLowerCase() === 'approve';
    const approvalId = match[2];
    try {
      const result = await runtime.resolveApproval(approvalId, approved);
      await sendChunks(message.channel, approvalResultText(result), message);
    } catch (error) {
      await sendChunks(
        message.channel,
        `Failed to ${approved ? 'approve' : 'reject'} \`${approvalId}\`: ${error instanceof Error ? error.message : String(error)}`,
        message,
      );
    }
    return true;
  }

  const readMatch = normalized.match(/^read\s+([a-zA-Z0-9-]+)$/i);
  if (readMatch) {
    const notificationId = readMatch[1];
    const notification = getNotification(notificationId);
    if (!notification) {
      await sendChunks(message.channel, `Notification \`${notificationId}\` was not found.`, message);
      return true;
    }
    markNotificationRead(notificationId);
    await sendChunks(message.channel, `Marked notification \`${notificationId}\` as read.`, message);
    return true;
  }

  const retryMatch = normalized.match(/^retry\s+([a-zA-Z0-9-]+)$/i);
  if (retryMatch) {
    const notificationId = retryMatch[1];
    const notification = getNotification(notificationId);
    if (!notification) {
      await sendChunks(message.channel, `Notification \`${notificationId}\` was not found.`, message);
      return true;
    }
    requeueNotificationDelivery(notificationId);
    await sendChunks(message.channel, `Requeued delivery for notification \`${notificationId}\`.`, message);
    return true;
  }

  return false;
}

async function sendChunks(channel: Message['channel'], text: string, replyTo?: Message<boolean>): Promise<void> {
  const chunks = splitMessage(text);
  if (chunks.length === 0) return;
  if (!channel.isTextBased() || !('send' in channel)) {
    throw new Error('Discord channel is not send-capable.');
  }

  for (const [index, chunk] of chunks.entries()) {
    if (index === 0 && replyTo) {
      await replyTo.reply(chunk);
      continue;
    }
    await channel.send(chunk);
  }
}

async function sendComponentMessage(
  channel: Message['channel'],
  payload: { content: string; components: ActionRowBuilder<ButtonBuilder>[] },
): Promise<void> {
  if (!channel.isTextBased() || !('send' in channel)) {
    throw new Error('Discord channel is not send-capable.');
  }
  await channel.send(payload);
}

async function handleButtonInteraction(interaction: ButtonInteraction, assistant: ClementineAssistant): Promise<void> {
  if (!interaction.customId.startsWith(`${DISCORD_CUSTOM_ID_PREFIX}:`)) {
    return;
  }

  const [, action, targetId] = interaction.customId.split(':');
  if (!action || !targetId) {
    await interaction.reply({ content: 'Malformed action.', ephemeral: true });
    return;
  }

  try {
    if (action === 'approve' || action === 'reject') {
      const approved = action === 'approve';
      const result = await assistant.getRuntime().resolveApproval(targetId, approved);
      await interaction.reply({
        content: approvalResultText(result),
        ephemeral: true,
      });
      return;
    }

    if (action === 'read') {
      const notification = getNotification(targetId);
      if (!notification) {
        await interaction.reply({ content: `Notification \`${targetId}\` was not found.`, ephemeral: true });
        return;
      }
      markNotificationRead(targetId);
      await interaction.reply({ content: `Marked notification \`${targetId}\` as read.`, ephemeral: true });
      return;
    }

    if (action === 'retry') {
      const notification = getNotification(targetId);
      if (!notification) {
        await interaction.reply({ content: `Notification \`${targetId}\` was not found.`, ephemeral: true });
        return;
      }
      requeueNotificationDelivery(targetId);
      await interaction.reply({ content: `Requeued delivery for notification \`${targetId}\`.`, ephemeral: true });
      return;
    }

    await interaction.reply({ content: 'Unknown action.', ephemeral: true });
  } catch (error) {
    await interaction.reply({
      content: error instanceof Error ? error.message : String(error),
      ephemeral: true,
    });
  }
}

async function handleMessage(message: Message<boolean>, assistant: ClementineAssistant): Promise<void> {
  if (!shouldRespond(message)) return;

  const prompt = extractPrompt(message);
  if (!prompt) return;

  if (await handleDiscordCommand(message, assistant, prompt)) {
    return;
  }

  const sessionId = getOrCreateDiscordSessionId({
    channelId: message.channelId,
    userId: message.author.id,
    guildId: message.guildId ?? undefined,
  });

  try {
    if ('sendTyping' in message.channel) {
      await message.channel.sendTyping();
    }

    const response = await assistant.respond({
      message: prompt,
      sessionId,
      userId: message.author.id,
      channel: buildChannelLabel(message),
    });

    const suffix = response.pendingApprovalId
      ? `\n\nApproval pending: \`${response.pendingApprovalId}\``
      : '';
    await sendChunks(message.channel, `${response.text}${suffix}`, message);
  } catch (error) {
    logger.error({ err: error, channelId: message.channelId, userId: message.author.id }, 'Discord message handling failed');
    await sendChunks(message.channel, 'I hit an internal error while handling that message.', message);
  }
}

export async function startDiscordBot(assistant: ClementineAssistant): Promise<void> {
  if (!DISCORD_ENABLED) {
    logger.info('Discord transport disabled');
    return;
  }
  if (!DISCORD_BOT_TOKEN) {
    throw new Error('DISCORD_ENABLED is true but DISCORD_BOT_TOKEN is missing.');
  }
  if (startPromise) {
    return startPromise;
  }

  startPromise = (async () => {
    const client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      partials: [Partials.Channel],
    });

    client.on(Events.ClientReady, (readyClient) => {
      status = {
        enabled: true,
        connected: true,
        userTag: readyClient.user.tag,
        startedAt: new Date().toISOString(),
        guildCount: readyClient.guilds.cache.size,
      };
      logger.info({ user: readyClient.user.tag, guilds: readyClient.guilds.cache.size }, 'Discord bot ready');
    });

    client.on(Events.GuildCreate, () => {
      status.guildCount = client.guilds.cache.size;
    });

    client.on(Events.GuildDelete, () => {
      status.guildCount = client.guilds.cache.size;
    });

    client.on(Events.MessageCreate, async (message) => {
      await handleMessage(message, assistant);
    });

    client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isButton()) return;
      await handleButtonInteraction(interaction, assistant);
    });

    client.on(Events.Error, (error) => {
      logger.error({ err: error }, 'Discord client error');
    });

    client.on(Events.ShardDisconnect, () => {
      status.connected = false;
    });

    discordClient = client;
    await client.login(DISCORD_BOT_TOKEN);
  })();

  try {
    await startPromise;
  } catch (error) {
    startPromise = null;
    discordClient = null;
    status.connected = false;
    throw error;
  }
}

export async function sendDiscordChannelMessage(channelId: string, text: string): Promise<void> {
  if (!discordClient?.isReady()) {
    throw new Error('Discord client is not connected in this process.');
  }

  const channel = await discordClient.channels.fetch(channelId);
  if (!channel?.isTextBased() || !('send' in channel)) {
    throw new Error(`Discord channel ${channelId} is not text-based.`);
  }

  for (const chunk of splitMessage(text)) {
    await channel.send(chunk);
  }
}

export async function sendDiscordDirectMessage(userId: string, text: string): Promise<void> {
  if (!discordClient?.isReady()) {
    throw new Error('Discord client is not connected in this process.');
  }

  const user = await discordClient.users.fetch(userId);
  const dm = await user.createDM();
  for (const chunk of splitMessage(text)) {
    await dm.send(chunk);
  }
}

export function getDiscordRuntimeStatus(): DiscordRuntimeStatus {
  return {
    ...status,
    connected: Boolean(discordClient?.isReady()),
    guildCount: discordClient?.guilds.cache.size ?? status.guildCount,
  };
}
