import type { WebClient } from '@slack/web-api';
import type { KnownBlock, Button } from '@slack/types';
import {
  runDiscordHarnessConversation,
  type DiscordHarnessTransport,
  type DisplayState,
} from './discord-harness.js';
import { SLACK_BOT_TOKEN } from '../config.js';

/**
 * Slack entry into the SHARED harness conversation runner.
 *
 * The runner (runDiscordHarnessConversation) is transport- and channel-
 * agnostic: it owns the live-edit state machine, session continuity,
 * approvals, and the agentic brain dispatch. Slack only supplies (1) a
 * transport that posts-then-updates a Slack message, (2) Block Kit approval
 * buttons, and (3) a tiny markdown→mrkdwn translator. Everything else is
 * reused, so this file is glue, not a second engine.
 */

/**
 * Translate the harness's generic markdown into Slack mrkdwn. Lossy-safe:
 * anything not recognized is left intact. Order matters — links before bold so
 * `[a](b)` survives, headings collapse to bold, `*` bullets become `•`.
 */
export function toSlackMrkdwn(text: string): string {
  if (!text) return text;
  return text
    // [label](url) → <url|label>
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<$2|$1>')
    // **bold** / __bold__ → *bold* (Slack uses single asterisks for bold)
    .replace(/\*\*([^*\n]+)\*\*/g, '*$1*')
    .replace(/__([^_\n]+)__/g, '*$1*')
    // # Heading → *Heading* (Slack has no headings in mrkdwn)
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    // "* bullet" → "• bullet" (a leading single asterisk would read as bold)
    .replace(/^(\s*)\*\s+/gm, '$1• ');
}

// Slack section text hard-caps at 3000 chars; keep interim edits under it.
const SECTION_MAX = 2900;

function sectionBlock(body: string): KnownBlock {
  const text = body.length > SECTION_MAX ? `${body.slice(0, SECTION_MAX - 1)}…` : body;
  return { type: 'section', text: { type: 'mrkdwn', text: text || '…' } };
}

/**
 * Block Kit sibling of approvalComponentsForState (discord-harness.ts): emit
 * Approve / Edit / Reject buttons for a pending approval, reusing the SAME
 * `clementine:<action>:<id>` action_id convention so the Slack action handler
 * routes them through the identical approval path as Discord's buttons.
 */
export function approvalBlocksForState(state: DisplayState): KnownBlock[] | null {
  const ids = state.pendingApprovalIds && state.pendingApprovalIds.length > 0
    ? state.pendingApprovalIds
    : state.pendingApprovalId
      ? [state.pendingApprovalId]
      : [];
  if (ids.length === 0) return null;
  const id = ids[0];
  const count = ids.length;
  const approveLabel = count > 1 ? `Approve all ${count}` : 'Approve';
  const rejectLabel = count > 1 ? `Reject all ${count}` : 'Reject';
  const elements: Button[] = [
    { type: 'button', style: 'primary', text: { type: 'plain_text', text: approveLabel }, action_id: `clementine:approve:${id}`, value: id },
  ];
  if (count === 1) {
    elements.push({ type: 'button', text: { type: 'plain_text', text: 'Edit' }, action_id: `clementine:edit:${id}`, value: id });
  }
  elements.push({ type: 'button', style: 'danger', text: { type: 'plain_text', text: rejectLabel }, action_id: `clementine:reject:${id}`, value: id });
  return [{ type: 'actions', block_id: `clementine:approval:${id}`, elements }];
}

/**
 * Build the Slack transport: post a placeholder, then live-edit it via
 * chat.update as harness events arrive. When the runner attaches approval
 * components, prepend a section with the body so the user sees both the reply
 * text AND the buttons (Slack renders `text` only as fallback once `blocks`
 * are present). The 2s edit debounce in the runner keeps us under Slack's
 * ~1 update/sec/message limit; Bolt's WebClient auto-retries 429s.
 */
export function buildSlackHarnessTransport(opts: {
  client: WebClient;
  channel: string;
  threadTs?: string;
}): DiscordHarnessTransport {
  const { client, channel, threadTs } = opts;
  return {
    async sendInitial(content) {
      const posted = await client.chat.postMessage({
        channel,
        thread_ts: threadTs,
        text: toSlackMrkdwn(content) || '…',
        mrkdwn: true,
      });
      const ts = posted.ts as string;
      return {
        edit: async (next, options) => {
          const body = toSlackMrkdwn(next);
          const blocks = options?.components as KnownBlock[] | undefined;
          if (blocks && blocks.length > 0) {
            await client.chat.update({
              channel,
              ts,
              text: (body || '…').slice(0, SECTION_MAX),
              blocks: [sectionBlock(body), ...blocks],
            });
          } else {
            // No (or cleared) buttons → plain text. blocks:[] reverts a
            // previously block-rendered message back to text-only.
            await client.chat.update({ channel, ts, text: body || '…', blocks: [] });
          }
        },
      };
    },
    async sendError(content) {
      await client.chat.postMessage({ channel, thread_ts: threadTs, text: toSlackMrkdwn(content) || '…', mrkdwn: true });
    },
    async sendFollowup(content) {
      await client.chat.postMessage({ channel, thread_ts: threadTs, text: toSlackMrkdwn(content) || '…', mrkdwn: true });
    },
    buildApprovalComponents(state) {
      return approvalBlocksForState(state);
    },
  };
}

interface SlackFileRef {
  name?: string;
  url_private?: string;
}

/**
 * Fetch Slack-hosted files (url_private requires the bot token in the auth
 * header — unlike Discord's public CDN) and fold them + any YouTube links into
 * the prompt via the shared attachment pipeline, then run the conversation.
 */
export async function handleSlackHarnessMessage(opts: {
  client: WebClient;
  channelId: string;
  userId: string;
  teamId?: string | null;
  threadTs?: string;
  prompt: string;
  files?: SlackFileRef[];
}): Promise<void> {
  let effectivePrompt = opts.prompt;
  try {
    const { ingestAttachment, foldAttachmentsIntoMessage, extractYouTubeUrls } = await import('../runtime/attachments.js');
    const ingested = [];
    for (const file of opts.files ?? []) {
      if (!file.url_private) continue;
      try {
        const res = await fetch(file.url_private, {
          headers: { Authorization: `Bearer ${SLACK_BOT_TOKEN}` },
        });
        if (res.ok) {
          const bytes = Buffer.from(await res.arrayBuffer());
          ingested.push(await ingestAttachment({ name: file.name ?? 'attachment', bytes }));
        }
      } catch {
        // best-effort per file
      }
    }
    for (const url of extractYouTubeUrls(opts.prompt).slice(0, 3)) {
      ingested.push(await ingestAttachment({ name: url, url }));
    }
    if (ingested.length > 0) {
      effectivePrompt = foldAttachmentsIntoMessage(opts.prompt, ingested);
    }
  } catch {
    // Attachment ingestion is best-effort; fall back to the plain prompt.
  }

  const transport = buildSlackHarnessTransport({
    client: opts.client,
    channel: opts.channelId,
    threadTs: opts.threadTs,
  });

  await runDiscordHarnessConversation({
    prompt: effectivePrompt,
    rawPrompt: opts.prompt,
    channelId: opts.channelId,
    userId: opts.userId,
    guildId: opts.teamId ?? null,
    transport,
    channel: 'slack',
    channelLabel: `slack:${opts.channelId}`,
  });
}
