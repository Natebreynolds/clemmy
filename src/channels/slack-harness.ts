import pino from 'pino';
import type { WebClient } from '@slack/web-api';
import type { KnownBlock, Button } from '@slack/types';
import {
  runDiscordHarnessConversation,
  type DiscordHarnessTransport,
  type DisplayState,
} from './discord-harness.js';
import { SLACK_BOT_TOKEN } from '../config.js';

const logger = pino({ name: 'clementine-next.slack-harness' });

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

/** A tool id → a short human phrase for the assistant status line. Strips the
 *  `ns__tool` / snake_case shape down to something glanceable. */
function prettyTool(tool: string): string {
  const base = (tool || '').split('__').pop() ?? tool;
  return base.replace(/_/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40);
}

/**
 * Map the live harness DisplayState to a concise Slack AI-Assistant status line
 * (what shows under "Clem" in the native pane while she works). Returns '' to
 * CLEAR the status — done turns clear it so the pane settles on the answer.
 * Mirrors what renderBody shows in the rolling message, but in one short phrase.
 */
export function deriveAssistantStatus(state: DisplayState): string {
  if (state.done) return '';
  if ((state.pendingApprovalIds && state.pendingApprovalIds.length > 0) || state.pendingApprovalId) {
    return 'is waiting for your approval…';
  }
  const agent = (state.currentAgent ?? '').trim();
  const detail = (state.status ?? '').trim();
  const lastTool = state.toolsCalled && state.toolsCalled.length > 0
    ? state.toolsCalled[state.toolsCalled.length - 1]
    : '';
  if (agent && detail) return `${agent}: ${detail}`.slice(0, 100);
  if (detail) return detail.slice(0, 100);
  if (agent) return `${agent} is working…`.slice(0, 100);
  if (lastTool) return `is using ${prettyTool(lastTool)}…`;
  return 'is thinking…';
}

/**
 * The RICH in-message play-by-play for the AI-Assistant pane: a compact, premium
 * progress block streamed INTO the one reply message while Clem works, so the
 * user sees the actual activity — current agent, what she's doing, the tools she's
 * running — not just the generic one-line Slack status. Replaced in-place by the
 * final answer when the run completes (so it never reads as a "double"). This is
 * the rich-data streaming Discord can't do natively.
 *
 * Deliberately CALM: no elapsed-time counter. The body changes only when the
 * agent / status / tool set changes, so the dedup in renderReply collapses the
 * runner's per-second "still working" pulses into nothing — no flicker.
 */
export function renderAssistantProgress(state: DisplayState): string {
  const agent = (state.currentAgent ?? '').trim();
  const detail = (state.status ?? '').trim() || 'working…';
  const tools = (state.toolsCalled ?? []).map(prettyTool).filter(Boolean).slice(-8);
  const head = agent ? `🍊 *${agent}*` : '🍊 *Clem is working…*';
  const meta = [detail, state.toolCount >= 3 ? `${state.toolCount} tools` : '']
    .filter(Boolean)
    .join('  ·  ');
  const lines = [head, `_${meta}_`];
  if (tools.length > 0) lines.push(tools.map((t) => `\`${t}\``).join(' · '));
  return lines.join('\n');
}

/**
 * The native AI-Assistant transport. It streams the RICH play-by-play (the real
 * data — current agent, the exact tools she's running, elapsed time) INTO one
 * live-edited message while Clem works, then replaces that block in-place with
 * the final answer — so the user always sees what's going on, and there is never
 * more than one message (no "double"). In parallel it drives
 * assistant.threads.setStatus so the docked pane ALSO shows a native indicator
 * under "Clem" — the premium touch Discord can't do. Block Kit approvals ride
 * the same shared clementine:* action ids.
 */
export function buildSlackAssistantTransport(opts: {
  client: WebClient;
  channel: string;
  threadTs?: string;
  setStatus: (status: string) => Promise<unknown>;
}): DiscordHarnessTransport {
  const { client, channel, threadTs } = opts;
  let messageTs: string | null = null;
  let lastRenderedBody: string | null = null;
  let lastStatus: string | null = null;
  // A LIVE reference to the runner's DisplayState — the runner mutates this same
  // object in place (applyEventToState), so reading latestState.done in edit()
  // below tells us, even at finalFlush (which never calls onState), whether this
  // edit is a mid-run progress tick or the final answer.
  let latestState: DisplayState | null = null;
  // Serialize posts/edits so concurrent flushes can't double-post before the
  // first postMessage resolves (which is what assigns messageTs).
  let chain: Promise<void> = Promise.resolve();
  const enqueue = (fn: () => Promise<void>): Promise<void> => {
    // Swallow so one failed Slack edit can't break the run, but LOG it — a silent
    // postMessage/update failure would otherwise leave the message frozen with no
    // trace (the bug class this whole transport was rewritten to fix).
    const p = chain.then(fn).catch((err) => {
      logger.warn({ err: err instanceof Error ? err.message : String(err), channel }, 'slack assistant edit failed');
    });
    chain = p;
    return p;
  };

  const pushStatus = (s: string): void => {
    if (s === lastStatus) return;
    lastStatus = s;
    void Promise.resolve(opts.setStatus(s)).catch(() => { /* status is best-effort */ });
  };

  const renderReply = (reply: string, blocks: KnownBlock[] | null): Promise<void> => {
    const body = (toSlackMrkdwn(reply) || '…').slice(0, SECTION_MAX);
    const withBlocks = blocks && blocks.length > 0;
    // Dedup identical text edits (Slack throttles ~1 update/sec/message). Never
    // dedup when buttons are attached — those must always re-render.
    if (!withBlocks && messageTs && body === lastRenderedBody) return Promise.resolve();
    return enqueue(async () => {
      if (!messageTs) {
        const posted = await client.chat.postMessage({
          channel, thread_ts: threadTs, text: body, mrkdwn: true,
          ...(withBlocks ? { blocks: [sectionBlock(body), ...blocks!] } : {}),
        });
        messageTs = posted.ts as string;
      } else {
        await client.chat.update({
          channel, ts: messageTs, text: body,
          ...(withBlocks ? { blocks: [sectionBlock(body), ...blocks!] } : { blocks: [] }),
        });
      }
      lastRenderedBody = body;
    });
  };

  return {
    async sendInitial() {
      // Post the one message immediately so there's no dead air, then live-edit it
      // via edit()/onState. The native pane indicator runs in parallel.
      pushStatus('is thinking…');
      await renderReply('🍊 *Clem is working…*', null);
      return {
        // edit() is the SINGLE in-message renderer — it's what the runner's
        // finalFlush uses to deliver the answer, so it must NOT be a no-op. While
        // the run is live (latestState && !done) we substitute the RICH
        // play-by-play (agent · what she's doing · tools · elapsed); once the run
        // is done we render the runner's content verbatim (the final answer, or
        // an approval prompt with its buttons). One message throughout.
        edit: async (next, options) => {
          const blocks = (options?.components as KnownBlock[] | undefined) ?? null;
          const inProgress = !!latestState && !latestState.done;
          const body = inProgress ? renderAssistantProgress(latestState!) : next;
          await renderReply(body, blocks);
        },
      };
    },
    async sendError(content) {
      pushStatus('');
      await client.chat.postMessage({ channel, thread_ts: threadTs, text: toSlackMrkdwn(content) || '…', mrkdwn: true });
    },
    async sendFollowup(content) {
      await client.chat.postMessage({ channel, thread_ts: threadTs, text: toSlackMrkdwn(content) || '…', mrkdwn: true });
    },
    buildApprovalComponents(state) {
      return approvalBlocksForState(state);
    },
    onState(state) {
      try {
        // Capture the live state reference (edit() reads .done off it). In-message
        // rendering is owned by edit(). The native pane indicator is kept STABLE —
        // a single steady "is working…" (or approval prompt) rather than churning
        // per step — so it doesn't flicker/"pop" in the plain DM view. The rich
        // per-step play-by-play lives in the one message, not the status line.
        latestState = state;
        if (state.done) { pushStatus(''); return; }
        const hasApproval = (state.pendingApprovalIds?.length ?? 0) > 0 || !!state.pendingApprovalId;
        pushStatus(hasApproval ? 'is waiting for your approval…' : 'is working…');
      } catch { /* a progress sink must never break the run */ }
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
  /** When present, this turn ran from the native AI-Assistant pane: use the
   *  assistant transport so run activity drives assistant.threads.setStatus. */
  setStatus?: (status: string) => Promise<unknown>;
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

  const transport = opts.setStatus
    ? buildSlackAssistantTransport({
        client: opts.client,
        channel: opts.channelId,
        threadTs: opts.threadTs,
        setStatus: opts.setStatus,
      })
    : buildSlackHarnessTransport({
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
