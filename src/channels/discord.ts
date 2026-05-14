import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pino from 'pino';
import {
  ActionRowBuilder,
  ActivityType,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  SlashCommandBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  Partials,
  type Message,
} from 'discord.js';
import {
  DISCORD_ALLOWED_CHANNELS,
  ASSISTANT_NAME,
  BASE_DIR,
  DISCORD_BOT_TOKEN,
  DISCORD_CLIENT_ID,
  DISCORD_DM_ALLOWED_USERS,
  DISCORD_DM_POLL_INTERVAL_MS,
  DISCORD_ENABLED,
  DISCORD_REQUIRE_MENTION,
} from '../config.js';
import { ClementineAssistant } from '../assistant/core.js';
import { ClementineGateway, type GatewayResponse } from '../gateway/router.js';
import { getOrCreateDiscordSessionId } from './discord-store.js';
import type { ApprovalResolutionResult, PendingApproval } from '../types.js';
import {
  getNotification,
  listNotifications,
  listQueuedNotificationDeliveries,
  markNotificationRead,
  requeueNotificationDelivery,
} from '../runtime/notifications.js';
import { buildDiscordInstallUrl } from './discord-install.js';

const logger = pino({ name: 'clementine-next.discord' });

interface DiscordRuntimeStatus {
  enabled: boolean;
  connected: boolean;
  userTag?: string;
  startedAt?: string;
  guildCount: number;
  clientId?: string;
  installUrl?: string;
}

const DISCORD_CUSTOM_ID_PREFIX = 'clementine';
const DISCORD_DM_POLL_STATE_FILE = path.join(BASE_DIR, 'state', 'discord-dm-poll-state.json');
const DISCORD_SLASH_COMMANDS = [
  new SlashCommandBuilder()
    .setName('ask')
    .setDescription('Send a prompt to Clementine.')
    .addStringOption((option) =>
      option
        .setName('prompt')
        .setDescription('What you want Clementine to help with')
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check whether the Discord transport is responding.'),
  new SlashCommandBuilder()
    .setName('status')
    .setDescription('Show Discord runtime status, a background task, or a run timeline.')
    .addStringOption((option) =>
      option
        .setName('target')
        .setDescription('Optional background task id like bg-... or run id like run-...')
        .setRequired(false),
    ),
  new SlashCommandBuilder()
    .setName('tasks')
    .setDescription('List recent background tasks.'),
  new SlashCommandBuilder()
    .setName('runs')
    .setDescription('List recent assistant runs.'),
  new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show the available Discord commands.'),
].map((command) => command.toJSON());

let discordClient: Client | null = null;
let startPromise: Promise<void> | null = null;
let dmPollLoopPromise: Promise<void> | null = null;
let dmPollLoopActive = false;
let status: DiscordRuntimeStatus = {
  enabled: DISCORD_ENABLED,
  connected: false,
  guildCount: 0,
  clientId: DISCORD_CLIENT_ID || undefined,
  installUrl: DISCORD_CLIENT_ID ? buildDiscordInstallUrl(DISCORD_CLIENT_ID) : undefined,
};

interface DiscordDmPollState {
  lastSeenByChannel: Record<string, string>;
}

interface DiscordRestDmChannel {
  id: string;
}

interface DiscordRestMessage {
  id: string;
  content: string;
  channel_id: string;
  author: {
    id: string;
    bot?: boolean;
    username?: string;
  };
  timestamp?: string;
}

interface DiscordRestSentMessage {
  id: string;
  channel_id: string;
}

function loadDiscordDmPollState(): DiscordDmPollState {
  if (!existsSync(DISCORD_DM_POLL_STATE_FILE)) {
    return { lastSeenByChannel: {} };
  }

  try {
    const parsed = JSON.parse(readFileSync(DISCORD_DM_POLL_STATE_FILE, 'utf-8')) as Partial<DiscordDmPollState>;
    return {
      lastSeenByChannel: typeof parsed.lastSeenByChannel === 'object' && parsed.lastSeenByChannel
        ? Object.fromEntries(
          Object.entries(parsed.lastSeenByChannel)
            .filter((entry): entry is [string, string] => typeof entry[0] === 'string' && typeof entry[1] === 'string'),
        )
        : {},
    };
  } catch {
    return { lastSeenByChannel: {} };
  }
}

function saveDiscordDmPollState(state: DiscordDmPollState): void {
  mkdirSync(path.dirname(DISCORD_DM_POLL_STATE_FILE), { recursive: true });
  writeFileSync(DISCORD_DM_POLL_STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

function compareSnowflakes(left: string, right: string): number {
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  if (leftValue === rightValue) return 0;
  return leftValue < rightValue ? -1 : 1;
}

function latestSnowflake(values: string[]): string | null {
  if (values.length === 0) return null;
  return values.reduce((latest, current) => (compareSnowflakes(current, latest) > 0 ? current : latest));
}

function markDiscordDmMessageSeen(channelId: string, messageId: string): void {
  const state = loadDiscordDmPollState();
  const previous = state.lastSeenByChannel[channelId];
  if (!previous || compareSnowflakes(messageId, previous) > 0) {
    state.lastSeenByChannel[channelId] = messageId;
    saveDiscordDmPollState(state);
  }
}

async function discordApiJson<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const response = await fetch(`https://discord.com/api/v10${path}`, {
    method: init?.method ?? 'GET',
    headers: {
      Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: init?.body === undefined ? undefined : JSON.stringify(init.body),
  });

  if (!response.ok) {
    throw new Error(`Discord API ${init?.method ?? 'GET'} ${path} failed with ${response.status}: ${await response.text()}`);
  }

  return response.json() as Promise<T>;
}

async function ensureDiscordDmChannel(userId: string): Promise<DiscordRestDmChannel> {
  return discordApiJson<DiscordRestDmChannel>('/users/@me/channels', {
    method: 'POST',
    body: { recipient_id: userId },
  });
}

async function listDiscordChannelMessages(channelId: string, limit = 15): Promise<DiscordRestMessage[]> {
  return discordApiJson<DiscordRestMessage[]>(`/channels/${channelId}/messages?limit=${limit}`);
}

async function sendDiscordRestChunks(channelId: string, text: string): Promise<void> {
  const chunks = splitMessage(text);
  for (const [index, chunk] of chunks.entries()) {
    const sent = await discordApiJson<DiscordRestSentMessage>(`/channels/${channelId}/messages`, {
      method: 'POST',
      body: { content: chunk },
    });
    logger.info({
      channelId,
      messageId: sent.id,
      chunk: index + 1,
      chunks: chunks.length,
      contentLength: chunk.length,
    }, 'Discord REST message sent');
  }
}

/**
 * Streaming handler for Discord DMs.
 *
 * Discord's API allows message-editing, which is how we surface streaming
 * text without spamming new messages. The handler:
 *
 *   1. On the first chunk, creates a placeholder message with what's
 *      buffered so far.
 *   2. On subsequent chunks, edits that message — throttled to every
 *      EDIT_INTERVAL_MS or every EDIT_CHAR_THRESHOLD chars (whichever
 *      fires first) to stay under Discord's edit rate limits.
 *   3. If the buffer overflows the message length cap (1900 chars,
 *      same as splitMessage uses), commits the current message and
 *      starts a new one — handles long answers gracefully.
 *   4. `flush()` forces a final edit so the message reflects the
 *      complete buffer before the caller appends approval suffixes.
 *
 * Returns:
 *   onChunk(delta) — pass as the streaming callback
 *   flush()        — call after the run completes to ensure the last
 *                    delta landed
 *   getMessageIds()— returns IDs of every message created during stream,
 *                    so the caller can append/edit final-state suffixes
 */
interface DiscordStreamHandler {
  onChunk(delta: string): Promise<void>;
  flush(): Promise<void>;
  getMessageIds(): string[];
}

function createDiscordStreamHandler(channelId: string): DiscordStreamHandler {
  const MAX_CHARS_PER_MESSAGE = 1900;
  const EDIT_INTERVAL_MS = 1500;
  const EDIT_CHAR_THRESHOLD = 240;

  const messageIds: string[] = [];
  let buffer = '';                  // current message buffer
  let currentMessageId: string | null = null;
  let lastEditAt = 0;
  let lastEditLength = 0;
  let inFlight: Promise<void> = Promise.resolve();
  let pendingEdit = false;

  async function commitEdit(): Promise<void> {
    if (!currentMessageId) return;
    const content = buffer || '…';
    try {
      await discordApiJson<DiscordRestSentMessage>(
        `/channels/${channelId}/messages/${currentMessageId}`,
        { method: 'PATCH', body: { content } },
      );
      lastEditAt = Date.now();
      lastEditLength = buffer.length;
    } catch (err) {
      logger.warn({ err, channelId, messageId: currentMessageId }, 'Discord stream edit failed');
    }
  }

  async function createInitial(): Promise<void> {
    try {
      const sent = await discordApiJson<DiscordRestSentMessage>(
        `/channels/${channelId}/messages`,
        { method: 'POST', body: { content: buffer || '…' } },
      );
      currentMessageId = sent.id;
      messageIds.push(sent.id);
      lastEditAt = Date.now();
      lastEditLength = buffer.length;
      logger.info({ channelId, messageId: sent.id, contentLength: buffer.length }, 'Discord streaming message started');
    } catch (err) {
      logger.warn({ err, channelId }, 'Discord streaming initial post failed');
    }
  }

  async function rollMessage(): Promise<void> {
    // Current message is full — finalize it and start a fresh one.
    await commitEdit();
    currentMessageId = null;
    buffer = '';
    lastEditLength = 0;
    lastEditAt = 0;
  }

  async function processDelta(delta: string): Promise<void> {
    if (!delta) return;
    buffer += delta;

    // Overflow: roll to a new message before exceeding the cap.
    if (buffer.length > MAX_CHARS_PER_MESSAGE) {
      const carry = buffer.slice(MAX_CHARS_PER_MESSAGE);
      buffer = buffer.slice(0, MAX_CHARS_PER_MESSAGE);
      if (!currentMessageId) await createInitial();
      else await commitEdit();
      await rollMessage();
      buffer = carry;
      pendingEdit = true;
      return;
    }

    if (!currentMessageId) {
      // First chunk — wait for enough buffered text to look intentional
      // before posting. Keeps "…" placeholders rare.
      if (buffer.length < 40) {
        pendingEdit = true;
        return;
      }
      await createInitial();
      return;
    }

    const now = Date.now();
    const enoughTime = now - lastEditAt >= EDIT_INTERVAL_MS;
    const enoughChars = buffer.length - lastEditLength >= EDIT_CHAR_THRESHOLD;
    if (enoughTime || enoughChars) {
      await commitEdit();
      pendingEdit = false;
    } else {
      pendingEdit = true;
    }
  }

  return {
    onChunk: (delta: string) => {
      // Serialize calls so we don't issue overlapping Discord edits.
      inFlight = inFlight.then(() => processDelta(delta).catch((err) => {
        logger.warn({ err, channelId }, 'Discord stream onChunk failed');
      }));
      return inFlight;
    },
    flush: async () => {
      await inFlight;
      if (!currentMessageId && buffer.length > 0) await createInitial();
      else if (pendingEdit) await commitEdit();
    },
    getMessageIds: () => messageIds.slice(),
  };
}

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

function channelAllowedById(channelId: string, type: ChannelType | null): boolean {
  if (type === ChannelType.DM) return true;
  if (DISCORD_ALLOWED_CHANNELS.length === 0) return true;
  return DISCORD_ALLOWED_CHANNELS.includes(channelId);
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
  return buildChannelLabelFromParts(message.channelId, message.guildId);
}

function buildChannelLabelFromParts(channelId: string, guildId?: string | null): string {
  if (guildId) {
    return `discord:${guildId}:${channelId}`;
  }
  return `discord:dm:${channelId}`;
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

function renderDiscordStatusForContext(input: {
  userId: string;
  channelId: string;
  guildId?: string | null;
  assistant: ClementineAssistant;
}): string {
  const discordStatus = getDiscordRuntimeStatus();
  const channel = buildChannelLabelFromParts(input.channelId, input.guildId);
  const ownedApprovals = input.assistant.getRuntime().listPendingApprovals()
    .filter((approval) => approval.userId === input.userId || approval.channel === channel);
  const userNotifications = relevantNotificationsForUser(input.userId);
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

async function runGatewayPrompt(input: {
  assistant: ClementineAssistant;
  prompt: string;
  channelId: string;
  userId: string;
  guildId?: string | null;
  /** Streaming-text callback. Only fires when the underlying runtime
   *  supports streaming (OpenAI Agents SDK path). Codex CLI bridge
   *  ignores it — non-streaming users get the same one-shot reveal. */
  onChunk?: (delta: string) => Promise<void> | void;
}): Promise<GatewayResponse> {
  const sessionId = getOrCreateDiscordSessionId({
    channelId: input.channelId,
    userId: input.userId,
    guildId: input.guildId ?? undefined,
  });

  return new ClementineGateway(input.assistant).handleMessage({
    message: input.prompt,
    sessionId,
    userId: input.userId,
    channel: buildChannelLabelFromParts(input.channelId, input.guildId),
    source: 'discord',
    onChunk: input.onChunk,
  });
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
        '`tasks`',
        '`runs`',
        '`status <task_id>`',
        '`status <run_id>`',
        '`stop <task_id>`',
        '`resume <task_id>`',
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
    await sendChunks(message.channel, renderDiscordStatusForContext({
      userId: message.author.id,
      channelId: message.channelId,
      guildId: message.guildId,
      assistant,
    }), message);
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

  for (const chunk of chunks) {
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

async function sendInteractionChunks(
  interaction: ChatInputCommandInteraction,
  text: string,
  options?: { ephemeral?: boolean },
): Promise<void> {
  const chunks = splitMessage(text);
  const firstChunk = chunks.shift() ?? 'Done.';
  const ephemeral = options?.ephemeral ?? false;

  if (interaction.deferred || interaction.replied) {
    await interaction.editReply({ content: firstChunk });
  } else {
    await interaction.reply({ content: firstChunk, ephemeral });
  }

  for (const chunk of chunks) {
    await interaction.followUp({ content: chunk, ephemeral });
  }
}

async function registerSlashCommands(client: Client): Promise<void> {
  if (!client.isReady()) return;

  for (const guild of client.guilds.cache.values()) {
    await guild.commands.set(DISCORD_SLASH_COMMANDS);
    logger.info({ guildId: guild.id, guildName: guild.name, commandCount: DISCORD_SLASH_COMMANDS.length }, 'Registered Discord slash commands');
  }
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

async function handleSlashCommand(interaction: ChatInputCommandInteraction, assistant: ClementineAssistant): Promise<void> {
  logger.info({
    command: interaction.commandName,
    channelId: interaction.channelId,
    guildId: interaction.guildId,
    userId: interaction.user.id,
  }, 'Discord slash command received');

  if (!channelAllowedById(interaction.channelId, interaction.channel?.type ?? null)) {
    await interaction.reply({
      content: 'This channel is not allowed by `DISCORD_ALLOWED_CHANNELS`.',
      ephemeral: true,
    });
    return;
  }

  try {
    if (interaction.commandName === 'ping') {
      await interaction.reply({ content: 'Pong. Discord transport is live.', ephemeral: true });
      return;
    }

    if (interaction.commandName === 'help') {
      await interaction.reply({
        content: [
          'Discord slash commands:',
          '`/ask prompt:<text>`',
          '`/ping`',
          '`/status`',
          '`/tasks`',
          '`/runs`',
          '`/help`',
        ].join('\n'),
        ephemeral: true,
      });
      return;
    }

    if (interaction.commandName === 'status') {
      const target = interaction.options.getString('target', false)?.trim();
      if (target) {
        const response = await runGatewayPrompt({
          assistant,
          prompt: `status ${target}`,
          channelId: interaction.channelId,
          userId: interaction.user.id,
          guildId: interaction.guildId,
        });
        await sendInteractionChunks(interaction, response.text, { ephemeral: true });
        return;
      }

      await interaction.reply({
        content: renderDiscordStatusForContext({
          userId: interaction.user.id,
          channelId: interaction.channelId,
          guildId: interaction.guildId,
          assistant,
        }),
        ephemeral: true,
      });
      return;
    }

    if (interaction.commandName === 'tasks') {
      const response = await runGatewayPrompt({
        assistant,
        prompt: 'tasks',
        channelId: interaction.channelId,
        userId: interaction.user.id,
        guildId: interaction.guildId,
      });
      await sendInteractionChunks(interaction, response.text, { ephemeral: true });
      return;
    }

    if (interaction.commandName === 'runs') {
      const response = await runGatewayPrompt({
        assistant,
        prompt: 'runs',
        channelId: interaction.channelId,
        userId: interaction.user.id,
        guildId: interaction.guildId,
      });
      await sendInteractionChunks(interaction, response.text, { ephemeral: true });
      return;
    }

    if (interaction.commandName === 'ask') {
      const prompt = interaction.options.getString('prompt', true).trim();
      if (!prompt) {
        await interaction.reply({ content: 'The prompt cannot be empty.', ephemeral: true });
        return;
      }

      await interaction.deferReply();

      const response = await runGatewayPrompt({
        assistant,
        prompt,
        channelId: interaction.channelId,
        userId: interaction.user.id,
        guildId: interaction.guildId,
      });
      const suffix = response.pendingApprovalId
        ? `\n\nApproval pending: \`${response.pendingApprovalId}\``
        : '';
      await sendInteractionChunks(interaction, `${response.text}${suffix}`);
      return;
    }

    await interaction.reply({ content: 'Unknown command.', ephemeral: true });
  } catch (error) {
    logger.error({ err: error, command: interaction.commandName, userId: interaction.user.id }, 'Discord slash command failed');
    const text = error instanceof Error
      ? `I hit an error while handling that command: ${error.message}`
      : 'I hit an internal error while handling that command.';
    await sendInteractionChunks(interaction, text, { ephemeral: true });
  }
}

async function handleMessage(message: Message<boolean>, assistant: ClementineAssistant): Promise<void> {
  const shouldHandle = shouldRespond(message);
  logger.info({
    channelId: message.channelId,
    guildId: message.guildId,
    userId: message.author.id,
    isDm: message.channel.type === ChannelType.DM,
    mentioned: message.mentions.has(message.client.user?.id ?? ''),
    contentLength: message.content.length,
    shouldRespond: shouldHandle,
  }, 'Discord message received');

  if (message.channel.type === ChannelType.DM && !message.author.bot) {
    markDiscordDmMessageSeen(message.channelId, message.id);
  }

  if (!shouldHandle) return;

  const prompt = extractPrompt(message);
  if (!prompt) return;

  if (await handleDiscordCommand(message, assistant, prompt)) {
    return;
  }

  let progressCompleted = false;
  let progressTimer: ReturnType<typeof setTimeout> | undefined;

  try {
    if ('sendTyping' in message.channel) {
      await message.channel.sendTyping();
    }

    progressTimer = setTimeout(() => {
      if (progressCompleted) return;
      void sendChunks(message.channel, 'Working on it. I’ll post the result here when the run finishes.', message)
        .catch((error) => logger.warn({ err: error, channelId: message.channelId }, 'Discord progress message failed'));
    }, 2500);

    const response = await runGatewayPrompt({
      assistant,
      prompt,
      channelId: message.channelId,
      userId: message.author.id,
      guildId: message.guildId,
    });
    progressCompleted = true;
    if (progressTimer) clearTimeout(progressTimer);

    const suffix = response.pendingApprovalId
      ? `\n\nApproval pending: \`${response.pendingApprovalId}\``
      : '';
    const runSuffix = response.runId ? `\n\nRun: \`${response.runId}\`` : '';
    await sendChunks(message.channel, `${response.text}${suffix}${runSuffix}`, message);
  } catch (error) {
    logger.error({ err: error, channelId: message.channelId, userId: message.author.id }, 'Discord message handling failed');
    await sendChunks(
      message.channel,
      error instanceof Error ? `I hit an error while handling that message: ${error.message}` : 'I hit an internal error while handling that message.',
      message,
    );
  } finally {
    progressCompleted = true;
    if (progressTimer) clearTimeout(progressTimer);
  }
}

async function pollDiscordDirectMessages(client: Client, assistant: ClementineAssistant): Promise<void> {
  if (!client.isReady()) return;
  if (DISCORD_DM_ALLOWED_USERS.length === 0) return;

  for (const userId of DISCORD_DM_ALLOWED_USERS) {
    try {
      const dm = await ensureDiscordDmChannel(userId);
      const messages = await listDiscordChannelMessages(dm.id, 15);
      if (messages.length === 0) {
        continue;
      }

      const state = loadDiscordDmPollState();
      const lastSeen = state.lastSeenByChannel[dm.id] ?? '';
      if (!lastSeen) {
        const seed = latestSnowflake(messages.map((message) => message.id));
        if (seed) {
          state.lastSeenByChannel[dm.id] = seed;
          saveDiscordDmPollState(state);
          logger.info({ userId, channelId: dm.id, lastSeenMessageId: seed }, 'Seeded Discord DM poll state');
        }
        continue;
      }

      const pending = messages
        .filter((message) => !message.author.bot && compareSnowflakes(message.id, lastSeen) > 0)
        .sort((left, right) => compareSnowflakes(left.id, right.id));

      for (const message of pending) {
        logger.info({
          channelId: message.channel_id,
          guildId: null,
          userId: message.author.id,
          isDm: true,
          contentLength: message.content.length,
        }, 'Discord DM polled message received');

        const prompt = message.content.trim();
        if (!prompt) {
          markDiscordDmMessageSeen(dm.id, message.id);
          continue;
        }

        let progressCompleted = false;
        let progressTimer: ReturnType<typeof setTimeout> | undefined;
        const streamHandler = createDiscordStreamHandler(dm.id);
        let chunkSeen = false;

        try {
          progressTimer = setTimeout(() => {
            if (progressCompleted || chunkSeen) return;
            void sendDiscordRestChunks(dm.id, 'Working on it. I’ll post the result here when the run finishes.')
              .catch((sendError) => logger.warn({ err: sendError, channelId: dm.id }, 'Discord DM progress message failed'));
          }, 2500);

          const response = await runGatewayPrompt({
            assistant,
            prompt,
            channelId: dm.id,
            userId: message.author.id,
            guildId: null,
            onChunk: async (delta) => {
              chunkSeen = true;
              if (progressTimer) { clearTimeout(progressTimer); progressTimer = undefined; }
              await streamHandler.onChunk(delta);
            },
          });
          progressCompleted = true;
          if (progressTimer) clearTimeout(progressTimer);

          // Flush any pending edit so the final delta lands before we
          // append suffixes / fall back to a full send.
          await streamHandler.flush();

          const suffix = response.pendingApprovalId
            ? `\n\nApproval pending: \`${response.pendingApprovalId}\``
            : '';
          const runSuffix = response.runId ? `\n\nRun: \`${response.runId}\`` : '';

          if (chunkSeen) {
            // Streaming already published the body. Send only the
            // suffix(es), if any, as a follow-up message — keeps the
            // streamed text intact and doesn't double-post the body.
            const tail = `${suffix}${runSuffix}`.trim();
            if (tail) await sendDiscordRestChunks(dm.id, tail);
          } else {
            // Non-streaming runtime (codex CLI bridge) — fall back to
            // the original one-shot send.
            await sendDiscordRestChunks(dm.id, `${response.text}${suffix}${runSuffix}`);
          }

          markDiscordDmMessageSeen(dm.id, message.id);
        } catch (error) {
          logger.error({ err: error, channelId: dm.id, userId: message.author.id }, 'Discord DM polled message handling failed');
          await sendDiscordRestChunks(
            dm.id,
            error instanceof Error ? `I hit an error while handling that message: ${error.message}` : 'I hit an internal error while handling that message.',
          );
          markDiscordDmMessageSeen(dm.id, message.id);
        } finally {
          progressCompleted = true;
          if (progressTimer) clearTimeout(progressTimer);
        }
      }
    } catch (error) {
      logger.error({ err: error, userId }, 'Discord DM polling failed');
    }
  }
}

async function runDiscordDmPollingLoop(client: Client, assistant: ClementineAssistant): Promise<void> {
  while (dmPollLoopActive && discordClient === client && client.isReady()) {
    try {
      await pollDiscordDirectMessages(client, assistant);
    } catch (error) {
      logger.error({ err: error }, 'Discord DM polling loop iteration failed');
    }

    await new Promise((resolve) => setTimeout(resolve, Math.max(DISCORD_DM_POLL_INTERVAL_MS, 1000)));
  }
}

function startDiscordDmPolling(client: Client, assistant: ClementineAssistant): void {
  if (dmPollLoopPromise || DISCORD_DM_ALLOWED_USERS.length === 0) {
    return;
  }

  logger.info({
    users: DISCORD_DM_ALLOWED_USERS,
    intervalMs: DISCORD_DM_POLL_INTERVAL_MS,
  }, 'Discord DM polling enabled');

  dmPollLoopActive = true;
  dmPollLoopPromise = runDiscordDmPollingLoop(client, assistant)
    .catch((error) => {
      logger.error({ err: error }, 'Discord DM polling loop crashed');
    })
    .finally(() => {
      dmPollLoopPromise = null;
    });
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
      presence: {
        status: 'online',
        activities: [
          {
            name: 'for messages',
            type: ActivityType.Listening,
          },
        ],
      },
    });

    client.on(Events.ClientReady, (readyClient) => {
      readyClient.user.setPresence({
        status: 'online',
        activities: [
          {
            name: 'for messages',
            type: ActivityType.Listening,
          },
        ],
      });
      status = {
        enabled: true,
        connected: true,
        userTag: readyClient.user.tag,
        startedAt: new Date().toISOString(),
        guildCount: readyClient.guilds.cache.size,
        clientId: readyClient.application.id,
        installUrl: buildDiscordInstallUrl(readyClient.application.id),
      };
      logger.info({ user: readyClient.user.tag, guilds: readyClient.guilds.cache.size }, 'Discord bot ready');
      void registerSlashCommands(readyClient).catch((error) => {
        logger.error({ err: error }, 'Failed to register Discord slash commands');
      });
      startDiscordDmPolling(readyClient, assistant);
    });

    client.on(Events.GuildCreate, (guild) => {
      status.guildCount = client.guilds.cache.size;
      void guild.commands.set(DISCORD_SLASH_COMMANDS).then(() => {
        logger.info({ guildId: guild.id, guildName: guild.name, commandCount: DISCORD_SLASH_COMMANDS.length }, 'Registered Discord slash commands for new guild');
      }).catch((error) => {
        logger.error({ err: error, guildId: guild.id }, 'Failed to register Discord slash commands for new guild');
      });
    });

    client.on(Events.GuildDelete, () => {
      status.guildCount = client.guilds.cache.size;
    });

    client.on(Events.MessageCreate, async (message) => {
      await handleMessage(message, assistant);
    });

    client.on(Events.InteractionCreate, async (interaction) => {
      if (interaction.isButton()) {
        await handleButtonInteraction(interaction, assistant);
        return;
      }
      if (interaction.isChatInputCommand()) {
        await handleSlashCommand(interaction, assistant);
      }
    });

    client.on(Events.Error, (error) => {
      logger.error({ err: error }, 'Discord client error');
    });

    client.on(Events.ShardDisconnect, () => {
      status.connected = false;
      dmPollLoopActive = false;
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
    clientId: discordClient?.application?.id ?? status.clientId,
    installUrl: discordClient?.application?.id ? buildDiscordInstallUrl(discordClient.application.id) : status.installUrl,
  };
}
