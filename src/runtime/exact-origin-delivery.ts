import { createHash } from 'node:crypto';

const EXACT_ORIGIN_DELIVERY_METADATA_KEY = 'exactOriginDelivery';
const EXACT_ORIGIN_DELIVERY_VERSION = 1;
const EXACT_ORIGIN_RECEIPT_PREFIX = 'exact-origin/v1';

export type ExactOriginDeliveryTarget =
  | { type: 'discord_channel'; channelId: string }
  | { type: 'slack_user'; userId: string }
  | { type: 'slack_channel'; channelId: string; threadTs?: string }
  | { type: 'origin_chat' };

export interface ExactOriginDeliveryEnvelope {
  version: 1;
  target: ExactOriginDeliveryTarget;
}

export interface ExactOriginDeliveryMetadata {
  exactOriginDelivery: ExactOriginDeliveryEnvelope;
}

const LOCAL_TRANSCRIPT_CHANNELS: ReadonlySet<string> = new Set([
  'chat',
  'cli',
  'console',
  'dashboard',
  'desktop',
  'electron',
  'home',
  'mobile',
  'web',
]);

type MetadataCarrier = {
  metadata?: Record<string, unknown>;
  deliveredDestinations?: unknown;
};

type DestinationLike = {
  id: string;
  name: string;
  type: string;
  channelId?: string;
  threadTs?: string;
  userId?: string;
  enabled: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized || undefined;
}

const SLACK_CONVERSATION_ID_PATTERN = /^[CDG][A-Z0-9]+$/;
const SLACK_THREAD_TS_PATTERN = /^\d{10,16}\.\d{6}$/;

function parseSlackConversationId(value: string): { channelId: string; threadTs?: string } | null {
  const normalized = value.trim();
  const separator = normalized.indexOf(':');
  const channelId = separator >= 0 ? normalized.slice(0, separator) : normalized;
  if (!SLACK_CONVERSATION_ID_PATTERN.test(channelId)) return null;
  const threadTs = separator >= 0 ? normalized.slice(separator + 1).trim() : undefined;
  if (separator >= 0 && (!threadTs || !SLACK_THREAD_TS_PATTERN.test(threadTs))) return null;
  return {
    channelId,
    ...(threadTs ? { threadTs } : {}),
  };
}

/** Pure admission-time resolver. Callers pass the session snapshot observed in
 * the same transaction as the accepted user source, then persist the result on
 * that source. Completion never re-runs this against mutable session state. */
export function exactOriginDeliveryTargetFromSessionSnapshot(input: {
  channel?: string | null;
  metadata?: Record<string, unknown>;
}): ExactOriginDeliveryTarget | null {
  const metadata = input.metadata ?? {};
  const channel = (input.channel ?? nonEmptyString(metadata.source) ?? '').trim().toLowerCase();
  if (channel === 'discord') {
    const channelId = nonEmptyString(metadata.discordChannelId) ?? nonEmptyString(metadata.channelId);
    return channelId ? { type: 'discord_channel', channelId } : null;
  }
  if (channel === 'slack') {
    // Older shared-harness Slack bindings were persisted under the Discord-
    // named compatibility field. It is accepted only inside an explicit Slack
    // session and must still parse as a Slack conversation id.
    const raw = nonEmptyString(metadata.slackChannelId)
      ?? nonEmptyString(metadata.channelId)
      ?? nonEmptyString(metadata.discordChannelId);
    const parsed = raw ? parseSlackConversationId(raw) : null;
    if (!parsed) return null;
    const explicitThreadTs = nonEmptyString(metadata.slackThreadTs);
    if (explicitThreadTs && !SLACK_THREAD_TS_PATTERN.test(explicitThreadTs)) return null;
    if (explicitThreadTs && parsed.threadTs && explicitThreadTs !== parsed.threadTs) return null;
    const threadTs = explicitThreadTs ?? parsed.threadTs;
    // Slack Assistant-pane conversations are threaded IMs (`D...`). A later
    // terminal posted back into that stale pane can be accepted by Slack yet
    // produce no unread badge and look missing to the user. Freeze the visible
    // top-level DM as the exact terminal destination at admission time. Public
    // and private channel conversations (`C...`/`G...`) retain their thread,
    // where the thread itself is the visible conversation. Approvals and live
    // foreground replies continue through their original transport thread.
    const terminalThreadTs = parsed.channelId.startsWith('D') ? undefined : threadTs;
    return {
      type: 'slack_channel',
      channelId: parsed.channelId,
      ...(terminalThreadTs ? { threadTs: terminalThreadTs } : {}),
    };
  }
  return LOCAL_TRANSCRIPT_CHANNELS.has(channel) ? { type: 'origin_chat' } : null;
}

function normalizeTarget(value: unknown): ExactOriginDeliveryTarget | undefined {
  if (!isRecord(value)) return undefined;

  if (value.type === 'origin_chat') {
    return { type: 'origin_chat' };
  }

  if (value.type === 'discord_channel') {
    const channelId = nonEmptyString(value.channelId);
    return channelId ? { type: 'discord_channel', channelId } : undefined;
  }

  if (value.type === 'slack_user') {
    const userId = nonEmptyString(value.userId);
    return userId ? { type: 'slack_user', userId } : undefined;
  }

  if (value.type === 'slack_channel') {
    const channelId = nonEmptyString(value.channelId);
    // Slack's chat.postMessage also accepts channel names. Exact authority must
    // never turn a corrupt persisted "channelId" into a newly resolved channel,
    // so apply the same encoded-id grammar used at source admission.
    if (!channelId || !SLACK_CONVERSATION_ID_PATTERN.test(channelId)) return undefined;
    if (!hasOwn(value, 'threadTs')) return { type: 'slack_channel', channelId };
    const threadTs = nonEmptyString(value.threadTs);
    return threadTs && SLACK_THREAD_TS_PATTERN.test(threadTs)
      ? { type: 'slack_channel', channelId, threadTs }
      : undefined;
  }

  return undefined;
}

export function normalizeExactOriginDeliveryTarget(
  value: unknown,
): ExactOriginDeliveryTarget | undefined {
  return normalizeTarget(value);
}

function canonicalTarget(target: ExactOriginDeliveryTarget): string {
  switch (target.type) {
    case 'origin_chat':
      return 'origin_chat';
    case 'discord_channel':
      return `discord_channel\0${target.channelId}`;
    case 'slack_user':
      return `slack_user\0${target.userId}`;
    case 'slack_channel':
      return `slack_channel\0${target.channelId}\0${target.threadTs ?? ''}`;
  }
}

export function exactOriginDeliveryTargetDigest(target: ExactOriginDeliveryTarget): string {
  const normalized = normalizeTarget(target);
  if (!normalized) throw new Error('Invalid exact-origin delivery target.');
  return createHash('sha256')
    .update(`clementine-workflow-origin-target:v1\0${canonicalTarget(normalized)}`)
    .digest('hex');
}

export function sameExactOriginDeliveryTarget(
  left: ExactOriginDeliveryTarget,
  right: ExactOriginDeliveryTarget,
): boolean {
  const normalizedLeft = normalizeTarget(left);
  const normalizedRight = normalizeTarget(right);
  return Boolean(
    normalizedLeft
    && normalizedRight
    && canonicalTarget(normalizedLeft) === canonicalTarget(normalizedRight),
  );
}

function receiptSegment(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Construct the versioned metadata marker that opts one notification into
 * exact-origin routing. Runtime validation is intentional: callers can cross
 * a JSON boundary before this helper, and malformed authority must not become
 * a request to use the normal configured/default/fallback destination set.
 */
export function exactOriginDeliveryMetadata(
  target: ExactOriginDeliveryTarget,
): ExactOriginDeliveryMetadata {
  const normalized = normalizeTarget(target);
  if (!normalized) throw new Error('Invalid exact-origin delivery target.');
  return {
    [EXACT_ORIGIN_DELIVERY_METADATA_KEY]: {
      version: EXACT_ORIGIN_DELIVERY_VERSION,
      target: normalized,
    },
  };
}

/** True even when the envelope is corrupt, so corrupt opt-ins fail closed. */
export function hasExactOriginDeliveryMode(carrier: MetadataCarrier): boolean {
  const metadata = carrier.metadata;
  return Boolean(metadata && hasOwn(metadata, EXACT_ORIGIN_DELIVERY_METADATA_KEY));
}

/** Parse and normalize a valid v1 target; return undefined for absent/corrupt data. */
export function exactOriginDeliveryTarget(
  carrier: MetadataCarrier,
): ExactOriginDeliveryTarget | undefined {
  const metadata = carrier.metadata;
  if (!metadata || !hasOwn(metadata, EXACT_ORIGIN_DELIVERY_METADATA_KEY)) return undefined;
  const envelope = metadata[EXACT_ORIGIN_DELIVERY_METADATA_KEY];
  if (!isRecord(envelope) || envelope.version !== EXACT_ORIGIN_DELIVERY_VERSION) return undefined;
  return normalizeTarget(envelope.target);
}

/**
 * Stable acknowledgement identity for one precise target. Slack top-level and
 * threaded posts intentionally have different receipts.
 */
export function exactOriginDeliveryReceiptForTarget(
  target: ExactOriginDeliveryTarget,
): string | undefined {
  const normalized = normalizeTarget(target);
  if (!normalized) return undefined;
  switch (normalized.type) {
    case 'discord_channel':
      return `${EXACT_ORIGIN_RECEIPT_PREFIX}/discord-channel/${receiptSegment(normalized.channelId)}`;
    case 'slack_user':
      return `${EXACT_ORIGIN_RECEIPT_PREFIX}/slack-user/${receiptSegment(normalized.userId)}`;
    case 'slack_channel':
      return normalized.threadTs
        ? `${EXACT_ORIGIN_RECEIPT_PREFIX}/slack-channel/${receiptSegment(normalized.channelId)}/thread/${receiptSegment(normalized.threadTs)}`
        : `${EXACT_ORIGIN_RECEIPT_PREFIX}/slack-channel/${receiptSegment(normalized.channelId)}/top-level`;
    case 'origin_chat':
      return `${EXACT_ORIGIN_RECEIPT_PREFIX}/origin-chat`;
  }
}

/** Stable destination id written into both the queue ledger and receipt list. */
export function exactOriginDeliveryDestinationId(
  target: ExactOriginDeliveryTarget,
): string | undefined {
  return exactOriginDeliveryReceiptForTarget(target);
}

export function expectedExactOriginDeliveryReceipt(
  carrier: MetadataCarrier,
): string | undefined {
  const target = exactOriginDeliveryTarget(carrier);
  return target ? exactOriginDeliveryReceiptForTarget(target) : undefined;
}

/**
 * A report-back is acknowledged only by the exact receipt. `deliveredAt`, a
 * human-readable destination name, or a receipt for another thread do not
 * satisfy this predicate.
 */
export function hasExpectedExactOriginDeliveryReceipt(carrier: MetadataCarrier): boolean {
  const expected = expectedExactOriginDeliveryReceipt(carrier);
  return Boolean(
    expected
    && Array.isArray(carrier.deliveredDestinations)
    && carrier.deliveredDestinations.every((value) => typeof value === 'string')
    && carrier.deliveredDestinations.includes(expected),
  );
}

/** Pure target-explicit form for watchdogs that already retain admitted authority. */
export function hasExactOriginDeliveryReceipt(
  carrier: MetadataCarrier,
  target: ExactOriginDeliveryTarget,
): boolean {
  const embedded = exactOriginDeliveryTarget(carrier);
  if (!embedded || !sameExactOriginDeliveryTarget(embedded, target)) return false;
  const expected = exactOriginDeliveryDestinationId(target);
  return Boolean(
    expected
    && Array.isArray(carrier.deliveredDestinations)
    && carrier.deliveredDestinations.every((value) => typeof value === 'string')
    && carrier.deliveredDestinations.includes(expected),
  );
}

/** Defense in depth for callers that bypass the normal destination resolver. */
export function exactOriginDeliveryDestinationMatches(
  carrier: MetadataCarrier,
  destination: DestinationLike,
): boolean {
  const target = exactOriginDeliveryTarget(carrier);
  const receipt = target ? exactOriginDeliveryReceiptForTarget(target) : undefined;
  if (!target || !receipt || target.type === 'origin_chat') return false;
  if (!destination.enabled || destination.id !== receipt || destination.name !== receipt) return false;

  switch (target.type) {
    case 'discord_channel':
      return destination.type === 'discord_channel' && destination.channelId === target.channelId;
    case 'slack_user':
      return destination.type === 'slack_user' && destination.userId === target.userId;
    case 'slack_channel':
      return destination.type === 'slack_channel'
        && destination.channelId === target.channelId
        && destination.threadTs === target.threadTs;
  }
}
