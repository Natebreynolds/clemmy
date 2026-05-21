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
  ModalBuilder,
  SlashCommandBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
  Partials,
  type Message,
} from 'discord.js';
import * as approvalRegistry from '../runtime/harness/approval-registry.js';
import {
  DISCORD_ALLOWED_CHANNELS,
  ASSISTANT_NAME,
  BASE_DIR,
  DISCORD_BOT_TOKEN,
  DISCORD_CLIENT_ID,
  DISCORD_DM_ALLOWED_USERS,
  DISCORD_DM_POLL_INTERVAL_MS,
  DISCORD_ENABLED,
  DISCORD_HARNESS_ENABLED,
  DISCORD_REQUIRE_MENTION,
} from '../config.js';
import {
  handleDiscordHarnessMessage,
  runDiscordHarnessConversation,
  type DiscordHarnessTransport,
  tryHandleHarnessApprovalReply,
} from './discord-harness.js';
import { ClementineAssistant } from '../assistant/core.js';
import { ClementineGateway, type GatewayResponse } from '../gateway/router.js';
import { getOrCreateDiscordSessionId } from './discord-store.js';
import { claimInbound, completeInbound } from './inbox-store.js';
import type { ApprovalResolutionResult, PendingApproval, ToolActivity } from '../types.js';
import { summarizeApprovalAction } from '../runtime/approval-summary.js';
import {
  getNotification,
  listNotifications,
  listQueuedNotificationDeliveries,
  markNotificationRead,
  requeueNotificationDelivery,
} from '../runtime/notifications.js';
import { buildDiscordInstallUrl } from './discord-install.js';
import { getPlanProposal, rejectPlanProposal } from '../agents/plan-proposals.js';
import { approvePlanAndQueueBackgroundTask } from '../execution/approved-plan-tasks.js';
import { queueBackgroundTaskApprovalResolution } from '../execution/background-tasks.js';
import { WEBHOOK_PORT, WEBHOOK_SECRET } from '../config.js';

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
let dmPollConsecutiveFailures = 0;
let dmPollBackoffUntil = 0;
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

function summarizeDiscordError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  if (raw.includes('<!DOCTYPE') || raw.includes('<html')) {
    const status = raw.match(/failed with\s+(\d+)/i)?.[1] ?? 'unknown';
    const route = raw.match(/Discord API\s+([A-Z]+)\s+([^ ]+)/)?.slice(1, 3).join(' ') ?? 'Discord API';
    return `${route} failed with ${status}; Discord returned an HTML upstream error page.`;
  }
  return truncate(raw.replace(/\s+/g, ' '), 500);
}

function recordDiscordPollSuccess(): void {
  dmPollConsecutiveFailures = 0;
  dmPollBackoffUntil = 0;
}

function recordDiscordPollFailure(error: unknown, userId?: string): void {
  dmPollConsecutiveFailures += 1;
  const delayMs = Math.min(60_000, 1000 * Math.pow(2, Math.min(dmPollConsecutiveFailures, 6)));
  dmPollBackoffUntil = Date.now() + delayMs;
  logger.warn({
    error: summarizeDiscordError(error),
    userId,
    consecutiveFailures: dmPollConsecutiveFailures,
    retryInMs: delayMs,
  }, 'Discord DM polling failed');
}

function markDiscordDmMessageSeen(channelId: string, messageId: string): void {
  const state = loadDiscordDmPollState();
  const previous = state.lastSeenByChannel[channelId];
  if (!previous || compareSnowflakes(messageId, previous) > 0) {
    state.lastSeenByChannel[channelId] = messageId;
    saveDiscordDmPollState(state);
  }
}

// Discord returns 429 with a JSON body { retry_after: <seconds>, ... }.
// Previously we surfaced it as a plain Error and the caller logged a
// warning — the user saw a truncated stream-edit and no recovery.
// We now honor retry_after (capped) and re-issue the request up to N
// times before giving up. Cap on the wait + attempt count protects
// against pathological "retry_after: 60" loops eating the daemon tick.
const DISCORD_RATE_LIMIT_MAX_RETRIES = 3;
const DISCORD_RATE_LIMIT_MAX_WAIT_MS = 5_000;

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function executeDiscordRequest(path: string, init?: { method?: string; body?: unknown }): Promise<Response> {
  const method = init?.method ?? 'GET';
  let attempt = 0;
  while (true) {
    const response = await fetch(`https://discord.com/api/v10${path}`, {
      method,
      headers: {
        Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: init?.body === undefined ? undefined : JSON.stringify(init.body),
    });
    if (response.status !== 429 || attempt >= DISCORD_RATE_LIMIT_MAX_RETRIES) {
      return response;
    }
    // Parse the retry_after hint without consuming the body destructively.
    const cloned = response.clone();
    let retryAfterMs = 1000;
    try {
      const payload = await cloned.json() as { retry_after?: number };
      if (typeof payload.retry_after === 'number' && payload.retry_after > 0) {
        retryAfterMs = Math.min(DISCORD_RATE_LIMIT_MAX_WAIT_MS, Math.ceil(payload.retry_after * 1000));
      }
    } catch { /* fall back to 1s */ }
    // Drain the original body so the connection can be reused.
    try { await response.text(); } catch { /* ignore */ }
    attempt += 1;
    logger.warn({ path, method, attempt, retryAfterMs }, 'Discord 429 — retrying after backoff');
    await sleepMs(retryAfterMs);
  }
}

async function discordApiJson<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const response = await executeDiscordRequest(path, init);
  if (!response.ok) {
    throw new Error(`Discord API ${init?.method ?? 'GET'} ${path} failed with ${response.status}: ${await response.text()}`);
  }
  return response.json() as Promise<T>;
}

async function discordApiVoid(path: string, init?: { method?: string; body?: unknown }): Promise<void> {
  const response = await executeDiscordRequest(path, init);
  if (!response.ok) {
    throw new Error(`Discord API ${init?.method ?? 'GET'} ${path} failed with ${response.status}: ${await response.text()}`);
  }
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

async function sendDiscordRestComponentMessage(
  channelId: string,
  payload: { content: string; components: ActionRowBuilder<ButtonBuilder>[] },
): Promise<void> {
  const sent = await discordApiJson<DiscordRestSentMessage>(`/channels/${channelId}/messages`, {
    method: 'POST',
    body: {
      content: payload.content,
      components: payload.components.map((component) => component.toJSON()),
    },
  });
  logger.info({
    channelId,
    messageId: sent.id,
    contentLength: payload.content.length,
  }, 'Discord REST component message sent');
}

async function sendDiscordRestTyping(channelId: string): Promise<void> {
  await discordApiVoid(`/channels/${channelId}/typing`, { method: 'POST' });
}

/**
 * Build the harness transport used for REST DM channels — POST the
 * placeholder, PATCH for live progress edits. Shared between the
 * fresh-message path (runDiscordHarnessConversation) and the
 * approval-resume path (tryHandleHarnessApprovalReply).
 */
function buildDiscordRestTransport(channelId: string) {
  return {
    async sendInitial(content: string) {
      const sent = await discordApiJson<DiscordRestSentMessage>(
        `/channels/${channelId}/messages`,
        { method: 'POST', body: { content } },
      );
      return {
        edit: async (next: string, options?: { components?: unknown[] }) => {
          const body: Record<string, unknown> = { content: next.slice(0, 1900) };
          // When components are passed (e.g. approval Approve/Reject
          // buttons), include them; passing an empty array drops any
          // previously-attached components on a re-edit. Discord's
          // PATCH /channels/.../messages accepts the same `components`
          // wire shape as our other button-rendering code.
          if (options && Array.isArray(options.components)) {
            body.components = options.components;
          }
          await discordApiJson(`/channels/${channelId}/messages/${sent.id}`, {
            method: 'PATCH',
            body,
          });
        },
      };
    },
    async sendError(content: string) {
      await sendDiscordRestChunks(channelId, content);
    },
  };
}

function startDiscordTypingLoop(input: {
  channelId: string;
  sendTyping: () => Promise<unknown>;
}): () => void {
  let stopped = false;
  const tick = () => {
    if (stopped) return;
    input.sendTyping().catch((error) => {
      logger.warn({ err: error, channelId: input.channelId }, 'Discord typing indicator failed');
    });
  };
  tick();
  const timer = setInterval(tick, 8_000);
  timer.unref?.();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

/**
 * Streaming handler for Discord channels and DMs.
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
      // PATCH failed even after the rate-limit retry loop in
      // executeDiscordRequest. Silently swallowing this loses the
      // tail of the agent's reply (the message stays at whatever was
      // last successfully edited in). Fall back to posting the
      // current buffer as a NEW follow-up message so the trailing
      // text always lands. Reset currentMessageId so further deltas
      // edit the follow-up, not the failed message.
      logger.warn({ err, channelId, messageId: currentMessageId }, 'Discord stream edit failed — falling back to new message');
      const failedId = currentMessageId;
      currentMessageId = null;
      try {
        const sent = await discordApiJson<DiscordRestSentMessage>(
          `/channels/${channelId}/messages`,
          { method: 'POST', body: { content } },
        );
        currentMessageId = sent.id;
        messageIds.push(sent.id);
        lastEditAt = Date.now();
        lastEditLength = buffer.length;
        logger.info({ channelId, messageId: sent.id, failedMessageId: failedId, contentLength: buffer.length }, 'Discord stream edit fallback posted as new message');
      } catch (fallbackErr) {
        logger.warn({ err: fallbackErr, channelId, failedMessageId: failedId }, 'Discord stream edit fallback also failed');
      }
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

interface DiscordLiveActivityHandler {
  onToolActivity(activity: ToolActivity): Promise<void>;
  flush(): Promise<void>;
}

const TOOL_ACTIVITY_LABELS: Record<string, string> = {
  composio_execute_tool: 'using a connected app',
  composio_list_tools: 'checking available app actions',
  composio_status: 'checking connected apps',
  git_status: 'checking git status',
  list_files: 'listing files',
  ping: 'checking tool runtime',
  read_file: 'reading a file',
  request_destructive_action: 'requesting approval',
  run_shell_command: 'preparing a shell command',
  workspace_roots: 'checking workspace access',
  write_file: 'preparing a file edit',
};

function readableToolName(toolName: string): string {
  if (toolName.startsWith('cx_')) return 'using a connected app action';
  return TOOL_ACTIVITY_LABELS[toolName] ?? `using ${toolName.replace(/[_-]+/g, ' ')}`;
}

function activityTarget(input: Record<string, unknown>): string {
  const keys = [
    'path',
    'directory',
    'command',
    'query',
    'url',
    'tool_slug',
    'toolkit_slug',
    'cwd',
    'title',
    'action',
  ];

  for (const key of keys) {
    const value = input[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  }

  return '';
}

function renderToolActivityLine(activity: ToolActivity): string {
  const target = activityTarget(activity.input);
  if (!target) return readableToolName(activity.toolName);
  return `${readableToolName(activity.toolName)}: \`${truncate(target.replace(/`/g, "'"), 90)}\``;
}

function renderLiveActivity(lines: string[]): string {
  return [
    '**Live activity**',
    ...lines.slice(-8).map((line) => `- ${line}`),
  ].join('\n').slice(0, 1900);
}

function createDiscordLiveActivityHandler(channelId: string): DiscordLiveActivityHandler {
  const EDIT_INTERVAL_MS = 1000;
  const lines: string[] = [];
  const seen = new Set<string>();
  let messageId: string | null = null;
  let lastEditAt = 0;
  let pendingEdit = false;
  let inFlight: Promise<void> = Promise.resolve();

  async function commit(): Promise<void> {
    if (lines.length === 0) return;
    const content = renderLiveActivity(lines);
    try {
      if (!messageId) {
        const sent = await discordApiJson<DiscordRestSentMessage>(
          `/channels/${channelId}/messages`,
          { method: 'POST', body: { content } },
        );
        messageId = sent.id;
      } else {
        await discordApiJson<DiscordRestSentMessage>(
          `/channels/${channelId}/messages/${messageId}`,
          { method: 'PATCH', body: { content } },
        );
      }
      lastEditAt = Date.now();
      pendingEdit = false;
    } catch (error) {
      logger.warn({ err: error, channelId, messageId }, 'Discord live activity update failed');
    }
  }

  async function processActivity(activity: ToolActivity): Promise<void> {
    const line = renderToolActivityLine(activity);
    if (seen.has(line)) return;
    seen.add(line);
    lines.push(line);

    if (!messageId || Date.now() - lastEditAt >= EDIT_INTERVAL_MS) {
      await commit();
      return;
    }

    pendingEdit = true;
  }

  return {
    onToolActivity: (activity: ToolActivity) => {
      inFlight = inFlight.then(() => processActivity(activity).catch((error) => {
        logger.warn({ err: error, channelId, toolName: activity.toolName }, 'Discord live activity handler failed');
      }));
      return inFlight;
    },
    flush: async () => {
      await inFlight;
      if (pendingEdit) await commit();
    },
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
  // Show the human-readable action first; the UUID is debug telemetry,
  // not the headline. Without the preview the list was an unreadable
  // wall of hex.
  return approvals
    .slice(0, 15)
    .map((approval) => `- **${approval.toolName}** — ${summarizeApprovalAction(approval)} _(id \`${approval.id.slice(0, 8)}\`)_`)
    .join('\n');
}

function renderApprovalCardContent(approval: PendingApproval): string {
  return [
    `🔐 **Approval needed — ${approval.toolName}**`,
    summarizeApprovalAction(approval),
    `_session ${approval.sessionId} · id \`${approval.id.slice(0, 8)}\`_`,
  ].join('\n');
}

function buildApprovalActions(approvalId: string) {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${DISCORD_CUSTOM_ID_PREFIX}:approve:${approvalId}`)
        .setLabel('Approve')
        .setStyle(ButtonStyle.Success),
      // Edit added 2026-05-21 — was inconsistent with the chat-dock and
      // discord-harness paths which both surface Approve/Edit/Reject.
      // The notification-delivery path is the one workflows hit when
      // request_approval fires; users got Approve+Reject only, no way
      // to tweak args before approving.
      new ButtonBuilder()
        .setCustomId(`${DISCORD_CUSTOM_ID_PREFIX}:edit:${approvalId}`)
        .setLabel('Edit')
        .setStyle(ButtonStyle.Primary),
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

function buildPlanProposalActions(planProposalId: string) {
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${DISCORD_CUSTOM_ID_PREFIX}:plan-approve:${planProposalId}`)
        .setLabel('Approve & Proceed')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`${DISCORD_CUSTOM_ID_PREFIX}:plan-reject:${planProposalId}`)
        .setLabel('Reject')
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`${DISCORD_CUSTOM_ID_PREFIX}:plan-view:${planProposalId}`)
        .setLabel('View / Edit in Dashboard')
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

/**
 * Resolve which ActionRow to attach to an outbound notification, based
 * on the notification's metadata. The notification queue tags
 * approval-kind items with either `approvalId` (SDK interrupt) or
 * `planProposalId` (Plan Proposal). When neither is present we send
 * the plain notification — no buttons to click.
 */
export function buildActionsForNotification(metadata: Record<string, unknown> | undefined): ActionRowBuilder<ButtonBuilder>[] | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const planProposalId = typeof metadata.planProposalId === 'string' ? metadata.planProposalId : undefined;
  if (planProposalId) return buildPlanProposalActions(planProposalId);
  const approvalId = typeof metadata.approvalId === 'string' ? metadata.approvalId : undefined;
  if (approvalId) return buildApprovalActions(approvalId);
  return undefined;
}

function relevantApprovalsForMessage(message: Message<boolean>, approvals: PendingApproval[]): PendingApproval[] {
  const channel = buildChannelLabel(message);
  const owned = approvals.filter((approval) => approval.userId === message.author.id || approval.channel === channel);
  return owned.length > 0 ? owned : approvals;
}

function relevantApprovalsForContext(input: {
  userId: string;
  channelId: string;
  guildId?: string | null;
}, approvals: PendingApproval[]): PendingApproval[] {
  const channel = buildChannelLabelFromParts(input.channelId, input.guildId);
  const owned = approvals.filter((approval) => approval.userId === input.userId || approval.channel === channel);
  return owned.length > 0 ? owned : approvals;
}

type NaturalApprovalAction = 'approve_one' | 'approve_all' | 'reject_one' | 'reject_all';

function detectNaturalApprovalAction(text: string): NaturalApprovalAction | null {
  const normalized = text.toLowerCase().replace(/[.!?]+$/g, '').replace(/\s+/g, ' ').trim();
  if (!normalized) return null;

  if (/^(approve|approved|yes|yep|yeah|go ahead|proceed|run it|do it|authorized|authorize)\s+(all|everything|them all)$/i.test(normalized)) {
    return 'approve_all';
  }
  if (/^(reject|rejected|deny|denied|cancel|stop)\s+(all|everything|them all)$/i.test(normalized)) {
    return 'reject_all';
  }
  if (/^(approve all|approved all|yes to all|go ahead with all|run all|proceed with all)$/i.test(normalized)) {
    return 'approve_all';
  }
  if (/^(reject all|deny all|cancel all|stop all)$/i.test(normalized)) {
    return 'reject_all';
  }
  if (/^(approve|approved|yes|yep|yeah|go ahead|proceed|run it|do it|authorized|authorize)$/i.test(normalized)) {
    return 'approve_one';
  }
  if (/^(reject|rejected|deny|denied|no|cancel|stop)$/i.test(normalized)) {
    return 'reject_one';
  }
  return null;
}

async function resolveNaturalApproval(input: {
  assistant: ClementineAssistant;
  text: string;
  userId: string;
  channelId: string;
  guildId?: string | null;
  send: (text: string) => Promise<void>;
}): Promise<boolean> {
  const action = detectNaturalApprovalAction(input.text);
  if (!action) return false;

  const runtime = input.assistant.getRuntime();
  const approvals = relevantApprovalsForContext({
    userId: input.userId,
    channelId: input.channelId,
    guildId: input.guildId,
  }, runtime.listPendingApprovals()).sort((left, right) => right.createdAt.localeCompare(left.createdAt));

  if (approvals.length === 0) {
    await input.send('No pending approval is waiting on this Discord thread.');
    return true;
  }

  const approve = action.startsWith('approve');
  const selected = action.endsWith('_all') ? approvals : approvals.slice(0, 1);
  const results: string[] = [];

  for (const approval of selected) {
    try {
      results.push(await resolveApprovalOrQueueBackgroundContinuation(input.assistant, approval.id, approve));
    } catch (error) {
      results.push(`Failed to ${approve ? 'approve' : 'reject'} \`${approval.id}\`: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const remainingCount = Math.max(0, approvals.length - selected.length);
  const tail = remainingCount > 0
    ? `\n\n${remainingCount} other approval${remainingCount === 1 ? '' : 's'} still pending. Say \`approve all\`, \`reject all\`, or \`approvals\` to inspect.`
    : '';
  await input.send(`${results.join('\n\n')}${tail}`);
  return true;
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
    result.nextApprovalId ? `Next approval pending: \`${result.nextApprovalId}\`` : '',
    '',
    result.text,
  ].filter(Boolean).join('\n');
}

async function resolveApprovalOrQueueBackgroundContinuation(
  assistant: ClementineAssistant,
  approvalId: string,
  approved: boolean,
): Promise<string> {
  const queued = queueBackgroundTaskApprovalResolution(approvalId, approved);
  if (queued) {
    return [
      `Approval ${approved ? 'approved' : 'rejected'}: \`${approvalId}\``,
      '',
      `Queued background task continuation: \`${queued.id}\`.`,
      'The daemon will resume the paused SDK run and keep progress visible in the dashboard.',
    ].join('\n');
  }

  const result = await assistant.getRuntime().resolveApproval(approvalId, approved);
  return approvalResultText(result);
}

function renderGatewayTail(response: GatewayResponse): string {
  // Surface ONLY signal the user can act on. Run IDs are debug
  // telemetry — they belong in the dashboard activity panel, not
  // appended to every chat reply.
  const parts = [
    response.pendingApprovalId ? `Approval pending: \`${response.pendingApprovalId}\`` : '',
  ];
  if (response.stoppedReason === 'max-turns-with-grace') {
    const turns = response.turnsUsed ? ` (${response.turnsUsed} turns used)` : '';
    parts.push(`⏸ Paused at tool-call budget${turns}. Tap **Continue** below or reply \`continue\` to resume.`);
  }
  return parts.filter(Boolean).join('\n\n');
}

function buildContinueActions(sessionId: string): ActionRowBuilder<ButtonBuilder>[] {
  // Discord customId is capped at 100 chars; sessionId is typically
  // `discord:<uuid>` (~46 chars) so the prefix + verb + sessionId fits
  // comfortably. We hash longer ids defensively just in case.
  const safeId = sessionId.length > 80 ? sessionId.slice(0, 80) : sessionId;
  return [
    new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`${DISCORD_CUSTOM_ID_PREFIX}:continue:${safeId}`)
        .setLabel('▶ Continue')
        .setStyle(ButtonStyle.Primary),
    ),
  ];
}

function appendGatewayTail(text: string, tail: string): string {
  return tail ? `${text}\n\n${tail}` : text;
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
  /** Tool activity callback surfaced by the runtime when tools start. */
  onToolActivity?: (activity: ToolActivity) => Promise<void> | void;
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
    onToolActivity: input.onToolActivity,
  });
}

async function handleDiscordCommand(message: Message<boolean>, assistant: ClementineAssistant, prompt: string): Promise<boolean> {
  const normalized = normalizeCommandText(prompt);
  const runtime = assistant.getRuntime();

  if (await resolveNaturalApproval({
    assistant,
    text: normalized,
    userId: message.author.id,
    channelId: message.channelId,
    guildId: message.guildId,
    send: (text) => sendChunks(message.channel, text, message),
  })) {
    return true;
  }

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
        content: renderApprovalCardContent(approval),
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
      const text = await resolveApprovalOrQueueBackgroundContinuation(assistant, approvalId, approved);
      await sendChunks(message.channel, text, message);
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

async function handleDiscordRestCommand(input: {
  assistant: ClementineAssistant;
  prompt: string;
  channelId: string;
  userId: string;
  guildId?: string | null;
}): Promise<boolean> {
  const normalized = normalizeCommandText(input.prompt);
  const runtime = input.assistant.getRuntime();
  const send = (text: string) => sendDiscordRestChunks(input.channelId, text);

  if (await resolveNaturalApproval({
    assistant: input.assistant,
    text: normalized,
    userId: input.userId,
    channelId: input.channelId,
    guildId: input.guildId,
    send,
  })) {
    return true;
  }

  if (/^(approvals|pending approvals)$/i.test(normalized)) {
    const approvals = relevantApprovalsForContext(input, runtime.listPendingApprovals());
    await send(renderApprovalList(approvals));
    for (const approval of approvals.slice(0, 5)) {
      await sendDiscordRestComponentMessage(input.channelId, {
        content: renderApprovalCardContent(approval),
        components: buildApprovalActions(approval.id),
      });
    }
    return true;
  }

  const match = normalized.match(/^(approve|reject)\s+([a-zA-Z0-9-]+)$/i);
  if (match) {
    const approved = match[1].toLowerCase() === 'approve';
    const approvalId = match[2];
    try {
      const text = await resolveApprovalOrQueueBackgroundContinuation(input.assistant, approvalId, approved);
      await send(text);
    } catch (error) {
      await send(`Failed to ${approved ? 'approve' : 'reject'} \`${approvalId}\`: ${error instanceof Error ? error.message : String(error)}`);
    }
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

function buildButtonHarnessTransport(interaction: ButtonInteraction): DiscordHarnessTransport {
  return {
    async sendInitial(content: string) {
      const first = content.slice(0, 1900);
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: first });
      } else {
        await interaction.reply({ content: first });
      }
      return {
        edit: async (next: string, options?: { components?: unknown[] }) => {
          const payload: { content: string; components?: unknown[] } = { content: next.slice(0, 1900) };
          if (options && Array.isArray(options.components)) payload.components = options.components;
          await interaction.editReply(payload as Parameters<ButtonInteraction['editReply']>[0]);
        },
      };
    },
    async sendError(content: string) {
      const payload = { content: content.slice(0, 1900), ephemeral: true };
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp(payload);
      } else {
        await interaction.reply(payload);
      }
    },
    async sendFollowup(content: string) {
      await interaction.followUp({ content: content.slice(0, 1900) });
    },
  };
}

async function registerSlashCommands(client: Client): Promise<void> {
  if (!client.isReady()) return;

  for (const guild of client.guilds.cache.values()) {
    await guild.commands.set(DISCORD_SLASH_COMMANDS);
    logger.info({ guildId: guild.id, guildName: guild.name, commandCount: DISCORD_SLASH_COMMANDS.length }, 'Registered Discord slash commands');
  }
}

/**
 * Modal submit handler — fires when the user clicks Edit on an
 * approval, modifies the args in the modal, and presses submit.
 * Resolves the approval as approve_with_edits, passing the edited
 * JSON args to the harness resume flow which substitutes them on the
 * SDK's interruption item before calling approve().
 *
 * The user-facing payload Discord requires is: respond within 3
 * seconds of the interaction OR defer + follow up. We defer + follow
 * up so the dashboard resume has time to start without blocking the
 * Discord UI.
 */
async function handleModalSubmit(interaction: ModalSubmitInteraction): Promise<void> {
  if (!interaction.customId.startsWith(`${DISCORD_CUSTOM_ID_PREFIX}:edit-modal:`)) {
    return;
  }
  // customId format: `clementine:edit-modal:<approvalId>` (legacy) OR
  // `clementine:edit-modal:<approvalId>:<plain|json>` (2026-05-21+).
  // The mode suffix tells us whether the user edited a single field
  // (plain) or the whole args JSON (json).
  const parts = interaction.customId.split(':');
  const approvalId = parts[2];
  const modalMode: 'plain' | 'json' = parts[3] === 'plain' ? 'plain' : 'json';
  if (!approvalId || !approvalId.startsWith('apr-')) {
    await interaction.reply({ content: 'Malformed edit submission.', ephemeral: true });
    return;
  }
  const editedValue = interaction.fields.getTextInputValue('args').trim();
  if (!editedValue) {
    await interaction.reply({ content: 'Edited value was empty — submit cancelled.', ephemeral: true });
    return;
  }
  const row = approvalRegistry.get(approvalId);
  if (!row || row.status !== 'pending') {
    await interaction.reply({
      content: row ? `Approval \`${approvalId}\` is already ${row.status}.` : `Approval \`${approvalId}\` was not found.`,
      ephemeral: true,
    });
    return;
  }
  // Reconstruct the full args envelope. In `plain` mode, the user only
  // edited the human-meaningful field (e.g. `reason` for
  // request_approval); we merge that single field back into the
  // original args so the tool receives the full structure it expects.
  // In `json` mode, the user edited the whole JSON envelope — pass
  // through after validation.
  let editedArgs = '';
  if (modalMode === 'plain') {
    const args = row.args ?? {};
    if (row.tool === 'request_approval') {
      const merged = { ...args, reason: editedValue };
      editedArgs = JSON.stringify(merged);
    } else if (row.tool === 'composio_execute_tool') {
      const inner = (args as { arguments?: unknown }).arguments;
      let innerObj: Record<string, unknown> = {};
      if (typeof inner === 'string') {
        try { innerObj = JSON.parse(inner) as Record<string, unknown>; } catch { innerObj = {}; }
      }
      const slug = (args as { tool_slug?: unknown }).tool_slug;
      if (typeof slug === 'string' && /OUTLOOK_SEND_EMAIL|GMAIL_SEND_EMAIL/i.test(slug)) {
        innerObj.body = editedValue;
      } else {
        // Unknown plain-mode tool — fall back to using the edited text
        // as the whole inner payload (unlikely to be hit because pickEditable
        // returns 'json' for unrecognized composio slugs).
        innerObj = { ...innerObj, instruction: editedValue };
      }
      const merged = { ...(args as Record<string, unknown>), arguments: JSON.stringify(innerObj) };
      editedArgs = JSON.stringify(merged);
    } else {
      // Shouldn't happen — pickEditable only emits 'plain' for the
      // tools above. Refuse rather than guess.
      await interaction.reply({
        content: `Plain-text edit isn't supported for tool ${row.tool ?? 'unknown'} — click Edit again to use the JSON editor.`,
        ephemeral: true,
      });
      return;
    }
  } else {
    // json mode — validate the JSON before submitting.
    try {
      JSON.parse(editedValue);
    } catch (err) {
      await interaction.reply({
        content: `Edited args are not valid JSON: ${err instanceof Error ? err.message : String(err)}. Click Edit again to fix.`,
        ephemeral: true,
      });
      return;
    }
    editedArgs = editedValue;
  }
  await interaction.deferReply({ ephemeral: true });
  // For composio_execute_tool the inner args are a JSON string nested
  // inside an outer { tool_slug, arguments, connected_account_id }
  // envelope. The loop.ts approve_with_edits handler wraps the inner
  // edit back into the original envelope before calling SDK approve(),
  // so the modal just sends the user's INNER edit verbatim — no
  // wrapping needed here.
  // Resolve via the dashboard harness-approval endpoint (same path the
  // desktop dashboard uses), so the resume logic stays in one place.
  // We hit it on localhost; auth via WEBHOOK_SECRET query param.
  const url = `http://127.0.0.1:${WEBHOOK_PORT}/api/console/harness-approvals/${encodeURIComponent(approvalId)}/approve_with_edits?token=${encodeURIComponent(WEBHOOK_SECRET)}`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ modifiedArgs: editedArgs }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const text = await response.text();
      await interaction.editReply({ content: `Edit-and-approve failed: ${response.status} ${text.slice(0, 200)}` });
      return;
    }
    await interaction.editReply({ content: `🍊 Approved with edits. The agent is continuing with your updated args.` });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await interaction.editReply({ content: `Edit-and-approve failed: ${message}` });
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
      if (DISCORD_HARNESS_ENABLED && targetId.startsWith('apr-')) {
        const handled = await tryHandleHarnessApprovalReply({
          channelId: interaction.channelId ?? '',
          prompt: `${approved ? 'approve' : 'reject'} ${targetId}`,
          transport: buildButtonHarnessTransport(interaction),
        });
        if (handled) return;
      }
      const text = await resolveApprovalOrQueueBackgroundContinuation(assistant, targetId, approved);
      await interaction.reply({
        content: text,
        ephemeral: true,
      });
      return;
    }

    if (action === 'edit') {
      // EDIT button — open a modal with the tool's args JSON for the
      // user to modify. On submit (handled in handleModalSubmit), the
      // approval resolves as approve_with_edits with the edited args.
      if (!targetId.startsWith('apr-')) {
        await interaction.reply({ content: 'Edit is only available for runtime approvals.', ephemeral: true });
        return;
      }
      const row = approvalRegistry.get(targetId);
      if (!row || row.status !== 'pending') {
        await interaction.reply({
          content: row ? `Approval \`${targetId}\` is already ${row.status}.` : `Approval \`${targetId}\` was not found.`,
          ephemeral: true,
        });
        return;
      }
      // Pick the most human-editable field for the modal. The previous
      // pass dumped raw JSON for every tool — for request_approval
      // (the most-common edit case) that surfaced fields like
      // `subject`, `reason`, `destructive` which look like developer
      // plumbing, not instructions. Users want to edit WHAT THE AGENT
      // DOES, not the envelope around it.
      //
      // Per-tool "primary instruction field" extraction:
      //   - request_approval → `reason` (the prose describing the action)
      //   - composio_execute_tool with OUTLOOK_SEND_EMAIL slug → `body`
      //     (the email body); recipient/subject are usually right
      //   - composio_execute_tool generally → inner `arguments` JSON
      //     (advanced users editing a tool payload directly)
      //   - everything else → full args JSON (fallback for power users)
      // Narrow row to non-null for the closure below; TS doesn't carry
      // the !row guard from above through the inner function boundary.
      const approvalRow = row;
      const args = approvalRow.args ?? {};
      type EditableField = { label: string; initialValue: string; modalStyle: 'plain' | 'json' };
      function pickEditable(): EditableField {
        if (approvalRow.tool === 'request_approval' && typeof (args as { reason?: unknown }).reason === 'string') {
          return {
            label: 'What should Clementine do?',
            initialValue: (args as { reason: string }).reason,
            modalStyle: 'plain',
          };
        }
        if (approvalRow.tool === 'composio_execute_tool') {
          const inner = (args as { arguments?: unknown }).arguments;
          if (typeof inner === 'string') {
            try {
              const parsed = JSON.parse(inner) as Record<string, unknown>;
              const slug = (args as { tool_slug?: unknown }).tool_slug;
              if (typeof slug === 'string' && /OUTLOOK_SEND_EMAIL|GMAIL_SEND_EMAIL/i.test(slug) && typeof parsed.body === 'string') {
                return { label: 'Email body', initialValue: parsed.body, modalStyle: 'plain' };
              }
              return { label: 'Tool args (JSON)', initialValue: JSON.stringify(parsed, null, 2), modalStyle: 'json' };
            } catch {
              return { label: 'Tool args (JSON)', initialValue: inner, modalStyle: 'json' };
            }
          }
        }
        return { label: 'Tool args (JSON)', initialValue: JSON.stringify(args, null, 2), modalStyle: 'json' };
      }
      const editable = pickEditable();
      let initialValue = editable.initialValue;
      // Discord text-input value cap is 4000 chars. Truncate gracefully.
      if (initialValue.length > 3900) {
        initialValue = `${initialValue.slice(0, 3900)}\n…[truncated for modal]`;
      }
      // Discord modal title hard-caps at 45 chars; pre-truncate so
      // showModal doesn't reject with "Invalid string length".
      const titleCandidate = editable.modalStyle === 'plain'
        ? 'Edit instructions'
        : `Edit args: ${row.subject || row.tool || 'action'}`;
      const modal = new ModalBuilder()
        .setCustomId(`${DISCORD_CUSTOM_ID_PREFIX}:edit-modal:${targetId}:${editable.modalStyle}`)
        .setTitle(titleCandidate.length > 45 ? `${titleCandidate.slice(0, 44)}…` : titleCandidate)
        .addComponents(
          new ActionRowBuilder<TextInputBuilder>().addComponents(
            new TextInputBuilder()
              .setCustomId('args')
              .setLabel(editable.label)
              .setStyle(TextInputStyle.Paragraph)
              .setRequired(true)
              .setValue(initialValue),
          ),
        );
      await interaction.showModal(modal);
      return;
    }

    if (action === 'plan-approve') {
      const result = approvePlanAndQueueBackgroundTask(targetId);
      if (!result) {
        await interaction.reply({ content: `Plan \`${targetId}\` was not found or already resolved.`, ephemeral: true });
        return;
      }
      await interaction.reply({
        content: [
          `✓ Plan approved: **${result.proposal.plan.objective}**`,
          `Queued durable background task: \`${result.task.id}\`.`,
          'A 15-minute auto-approval window is open for the approved plan scope.',
        ].join('\n'),
        ephemeral: true,
      });
      return;
    }

    if (action === 'plan-reject') {
      const result = rejectPlanProposal(targetId, 'rejected via Discord button');
      if (!result) {
        await interaction.reply({ content: `Plan \`${targetId}\` was not found.`, ephemeral: true });
        return;
      }
      await interaction.reply({
        content: `✗ Plan rejected: **${result.plan.objective}**\nThe agent will not proceed with this plan.`,
        ephemeral: true,
      });
      return;
    }

    if (action === 'plan-view') {
      const proposal = getPlanProposal(targetId);
      if (!proposal) {
        await interaction.reply({ content: `Plan \`${targetId}\` was not found.`, ephemeral: true });
        return;
      }
      // Deep link to the dashboard plan list. Token in querystring is the
      // dashboard's existing auth pattern.
      const tokenPart = WEBHOOK_SECRET ? `?token=${encodeURIComponent(WEBHOOK_SECRET)}` : '';
      const url = `http://localhost:${WEBHOOK_PORT}/console${tokenPart}`;
      await interaction.reply({
        content: [
          `**${proposal.plan.objective}**`,
          `Complexity: ${proposal.plan.estimatedComplexity}; ${proposal.plan.steps.length} step(s).`,
          `Open the dashboard to view full steps, success criteria, risks, and edit before approving:`,
          url,
        ].join('\n'),
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

    if (action === 'continue') {
      // The button targets the original sessionId; we re-issue a
      // "continue" prompt against it so the model resumes with full
      // history. Defer first so Discord doesn't time out on the 3s
      // window while the model thinks.
      const sessionId = targetId;
      await interaction.deferReply();
      try {
        const response = await assistant.respond({
          message: 'continue',
          sessionId,
          userId: interaction.user.id,
          channel: 'discord',
        });
        const chunks = splitMessage(response.text || 'No further output — task may already be complete.');
        await interaction.editReply({ content: chunks.shift() ?? 'Resumed.' });
        for (const chunk of chunks) {
          if (interaction.channel && 'send' in interaction.channel) {
            await interaction.channel.send(chunk);
          }
        }
        if (response.stoppedReason === 'max-turns-with-grace'
            && interaction.channel && 'send' in interaction.channel) {
          await sendComponentMessage(interaction.channel, {
            content: '_resume when ready_',
            components: buildContinueActions(sessionId),
          });
        }
      } catch (err) {
        await interaction.editReply({ content: err instanceof Error ? err.message : String(err) });
      }
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

  // Harness-approval shortcut MUST run before handleDiscordCommand
  // (which calls v0.2's resolveNaturalApproval). When the harness
  // session is paused waiting on approval, "approve" / "reject"
  // need to route into the harness resume — NOT into the v0.2
  // approval store, which knows nothing about the pause and would
  // reply "No pending approval".
  if (DISCORD_HARNESS_ENABLED) {
    const gatewayTransport = {
      async sendInitial(content: string) {
        const reply = (await message.reply(content)) as unknown as {
          edit(opts: { content: string; components?: unknown[] }): Promise<unknown>;
        };
        return {
          edit: async (next: string, options?: { components?: unknown[] }) => {
            const editPayload: { content: string; components?: unknown[] } = {
              content: next,
            };
            // Pass components through so approval Approve/Reject buttons
            // render on the gateway path (DMs over gateway, guild
            // channels). Without this, the harness sets `pendingApprovalId`
            // and the components array is built — then silently dropped here.
            if (options && Array.isArray(options.components)) {
              editPayload.components = options.components;
            }
            await reply.edit(editPayload);
          },
        };
      },
      async sendError(content: string) {
        await message.reply(content);
      },
    };
    if (await tryHandleHarnessApprovalReply({
      channelId: message.channelId,
      prompt,
      transport: gatewayTransport,
    })) {
      return;
    }
  }

  if (await handleDiscordCommand(message, assistant, prompt)) {
    return;
  }

  // Claim the inbound message in the persistent inbox before we spend
  // any model tokens. Two reliability properties this enforces:
  //   1. Idempotency. If Discord re-delivers the same message id
  //      (gateway reconnect, retried HTTP edit, etc.) we skip the
  //      second model call entirely — that bug was a real source of
  //      double-replies and double-billed turns.
  //   2. Restart durability. A 'claimed' row that never reaches
  //      'replied' is the signal that the daemon crashed mid-reply;
  //      future restart-replay code can pick those up.
  // Zero LLM tokens — pure local SQLite.
  const inboxKey = { channel: `discord:${message.channelId}`, sourceMessageId: message.id };
  const claim = claimInbound({ ...inboxKey, userId: message.author.id });
  if (!claim.shouldProcess) {
    logger.info({ ...inboxKey, status: claim.record.status }, 'Skipping already-handled Discord message');
    return;
  }

  // 0.3 harness routing — when DISCORD_HARNESS_ENABLED=true, every
  // qualifying message goes through Orchestrator + sub-agents +
  // auto-continuation. The reply is edited in place as progress
  // events arrive on actionBus.
  if (DISCORD_HARNESS_ENABLED) {
    try {
      await handleDiscordHarnessMessage(message, prompt);
      completeInbound({ ...inboxKey, status: 'replied' });
    } catch (err) {
      logger.error({ err, channelId: message.channelId }, 'Discord harness handler failed');
      completeInbound({ ...inboxKey, status: 'failed', error: err instanceof Error ? err.message : String(err) });
      try { await message.reply('Harness run failed: ' + ((err as Error).message ?? 'unknown')); } catch {}
    }
    return;
  }

  const streamHandler = createDiscordStreamHandler(message.channelId);
  const activityHandler = createDiscordLiveActivityHandler(message.channelId);
  let chunkSeen = false;
  const stopTyping = startDiscordTypingLoop({
    channelId: message.channelId,
    sendTyping: async () => {
      if ('sendTyping' in message.channel) {
        await message.channel.sendTyping();
      }
    },
  });

  try {
    const response = await runGatewayPrompt({
      assistant,
      prompt,
      channelId: message.channelId,
      userId: message.author.id,
      guildId: message.guildId,
      onChunk: async (delta) => {
        chunkSeen = true;
        await streamHandler.onChunk(delta);
      },
      onToolActivity: async (activity) => {
        await activityHandler.onToolActivity(activity);
      },
    });

    await streamHandler.flush();
    await activityHandler.flush();

    const tail = renderGatewayTail(response);
    if (chunkSeen) {
      if (tail) await sendChunks(message.channel, tail, message);
    } else {
      await sendChunks(message.channel, appendGatewayTail(response.text, tail), message);
    }
    // After the text lands, attach the [Continue] button on max-turns-with-grace
    // so the user has a one-tap resume affordance instead of having to type
    // "continue" by hand. Falls back gracefully when the channel doesn't
    // accept components.
    if (response.stoppedReason === 'max-turns-with-grace'
        && 'send' in message.channel) {
      try {
        await sendComponentMessage(message.channel, {
          content: '_resume when ready_',
          components: buildContinueActions(response.sessionId),
        });
      } catch (err) {
        logger.warn({ err }, 'Failed to attach Continue button to Discord reply');
      }
    }
    completeInbound({ ...inboxKey, runId: response.runId, status: 'replied' });
  } catch (error) {
    logger.error({ err: error, channelId: message.channelId, userId: message.author.id }, 'Discord message handling failed');
    completeInbound({
      ...inboxKey,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    });
    await sendChunks(
      message.channel,
      error instanceof Error ? `I hit an error while handling that message: ${error.message}` : 'I hit an internal error while handling that message.',
      message,
    );
  } finally {
    stopTyping();
  }
}

async function pollDiscordDirectMessages(client: Client, assistant: ClementineAssistant): Promise<void> {
  if (!client.isReady()) return;
  if (DISCORD_DM_ALLOWED_USERS.length === 0) return;

  for (const userId of DISCORD_DM_ALLOWED_USERS) {
    try {
      const dm = await ensureDiscordDmChannel(userId);
      const messages = await listDiscordChannelMessages(dm.id, 15);
      recordDiscordPollSuccess();
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

        // Harness-approval shortcut MUST run before
        // handleDiscordRestCommand. v0.2's resolveNaturalApproval
        // (called from handleDiscordRestCommand) checks its own
        // approval store; if the user types "approve" while a HARNESS
        // session is paused, v0.2 finds no match and replies "No
        // pending approval" — hijacking the message and preventing
        // the harness from resuming.
        if (DISCORD_HARNESS_ENABLED) {
          const dmTransport = buildDiscordRestTransport(dm.id);
          // Wrap the approval-resume path in try/finally so an exception
          // can't leave the DM unmarked-seen — that would loop the
          // poller on the same message forever, retrying a broken
          // resume on every 5s tick.
          let handled = false;
          try {
            handled = await tryHandleHarnessApprovalReply({
              channelId: dm.id,
              prompt,
              transport: dmTransport,
            });
          } catch (err) {
            // Mark seen so we don't re-poll a permanently-broken
            // message. The error surfaces in logs; the user can resend
            // if they meant to approve something.
            console.error('[discord-dm] tryHandleHarnessApprovalReply threw — marking message seen to prevent re-poll loop:', err);
            markDiscordDmMessageSeen(dm.id, message.id);
            continue;
          }
          if (handled) {
            markDiscordDmMessageSeen(dm.id, message.id);
            continue;
          }
        }

        if (await handleDiscordRestCommand({
          assistant,
          prompt,
          channelId: dm.id,
          userId: message.author.id,
          guildId: null,
        })) {
          markDiscordDmMessageSeen(dm.id, message.id);
          continue;
        }

        // 0.3 harness routing for DM-polling path. The gateway-side
        // branch (handleDiscordHarnessMessage) doesn't fire for DMs
        // when intents force REST polling, so we wire the same
        // conversation runner here with a REST transport: POST a
        // placeholder, PATCH it as actionBus events arrive.
        if (DISCORD_HARNESS_ENABLED) {
          // Inbox claim — the gateway-side path at line ~1576 already
          // does this, but the polling path used to skip it. When both
          // paths fire for the same DM message (gateway AND polling
          // pick it up because Discord delivers DM events through both
          // channels in some setups), the user saw two "starting…"
          // messages and the harness ran twice for one ask. Claiming
          // here makes the second attempt a no-op.
          const inboxKey = { channel: `discord:${dm.id}`, sourceMessageId: message.id };
          const claim = claimInbound({ ...inboxKey, userId: message.author.id });
          if (!claim.shouldProcess) {
            markDiscordDmMessageSeen(dm.id, message.id);
            continue;
          }
          try {
            await runDiscordHarnessConversation({
              prompt,
              channelId: dm.id,
              userId: message.author.id,
              guildId: null,
              transport: buildDiscordRestTransport(dm.id),
            });
            completeInbound({ ...inboxKey, status: 'replied' });
          } catch (err) {
            completeInbound({ ...inboxKey, status: 'failed', error: err instanceof Error ? err.message : String(err) });
            logger.error(
              { err, channelId: dm.id, userId: message.author.id },
              'Discord harness DM handler failed',
            );
            try {
              await sendDiscordRestChunks(
                dm.id,
                `Harness run failed: ${err instanceof Error ? err.message : String(err)}`,
              );
            } catch {
              /* swallow — already in error path */
            }
          }
          markDiscordDmMessageSeen(dm.id, message.id);
          continue;
        }

        const streamHandler = createDiscordStreamHandler(dm.id);
        const activityHandler = createDiscordLiveActivityHandler(dm.id);
        let chunkSeen = false;
        const stopTyping = startDiscordTypingLoop({
          channelId: dm.id,
          sendTyping: () => sendDiscordRestTyping(dm.id),
        });

        try {
          const response = await runGatewayPrompt({
            assistant,
            prompt,
            channelId: dm.id,
            userId: message.author.id,
            guildId: null,
            onChunk: async (delta) => {
              chunkSeen = true;
              await streamHandler.onChunk(delta);
            },
            onToolActivity: async (activity) => {
              await activityHandler.onToolActivity(activity);
            },
          });

          // Flush any pending edit so the final delta lands before we
          // append suffixes / fall back to a full send.
          await streamHandler.flush();
          await activityHandler.flush();

          const tail = renderGatewayTail(response);

          if (chunkSeen) {
            // Streaming already published the body. Send only the
            // suffix(es), if any, as a follow-up message — keeps the
            // streamed text intact and doesn't double-post the body.
            if (tail) await sendDiscordRestChunks(dm.id, tail);
          } else {
            // Non-streaming runtime (codex CLI bridge) — fall back to
            // the original one-shot send.
            await sendDiscordRestChunks(dm.id, appendGatewayTail(response.text, tail));
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
          stopTyping();
        }
      }
    } catch (error) {
      recordDiscordPollFailure(error, userId);
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

    const backoffRemaining = Math.max(0, dmPollBackoffUntil - Date.now());
    await new Promise((resolve) => setTimeout(resolve, Math.max(DISCORD_DM_POLL_INTERVAL_MS, 1000, backoffRemaining)));
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
      if (interaction.isModalSubmit()) {
        await handleModalSubmit(interaction);
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

export async function sendDiscordDirectMessage(
  userId: string,
  text: string,
  options: { components?: ActionRowBuilder<ButtonBuilder>[] } = {},
): Promise<void> {
  if (!discordClient?.isReady()) {
    throw new Error('Discord client is not connected in this process.');
  }

  const user = await discordClient.users.fetch(userId);
  const dm = await user.createDM();
  const chunks = splitMessage(text);
  // Attach the action row to the LAST chunk only — Discord renders the
  // buttons under the message they're attached to, and we want them
  // visible below the full notification body.
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    if (isLast && options.components && options.components.length > 0) {
      await dm.send({ content: chunks[i], components: options.components });
    } else {
      await dm.send(chunks[i]);
    }
  }
}

export async function sendDiscordChannelMessageWithComponents(
  channelId: string,
  text: string,
  components: ActionRowBuilder<ButtonBuilder>[],
): Promise<void> {
  if (!discordClient?.isReady()) {
    throw new Error('Discord client is not connected in this process.');
  }
  const channel = await discordClient.channels.fetch(channelId);
  if (!channel?.isTextBased() || !('send' in channel)) {
    throw new Error(`Discord channel ${channelId} is not text-based.`);
  }
  const chunks = splitMessage(text);
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    if (isLast && components.length > 0) {
      await channel.send({ content: chunks[i], components });
    } else {
      await channel.send(chunks[i]);
    }
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
