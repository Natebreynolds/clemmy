import pino from 'pino';
import { App } from '@slack/bolt';
import type { WebClient } from '@slack/web-api';
import type { KnownBlock, Button, ActionsBlock } from '@slack/types';
import * as approvalRegistry from '../runtime/harness/approval-registry.js';
import {
  SLACK_ALLOWED_CHANNELS,
  SLACK_ALLOWED_USERS,
  SLACK_APP_TOKEN,
  SLACK_BOT_TOKEN,
  SLACK_ENABLED,
  WEBHOOK_PORT,
  WEBHOOK_SECRET,
} from '../config.js';
import {
  bindDiscordHarnessSession,
  tryHandleHarnessApprovalReply,
  type DiscordHarnessTransport,
} from './discord-harness.js';
import { buildSlackHarnessTransport, handleSlackHarnessMessage, toSlackMrkdwn } from './slack-harness.js';
import { ClementineAssistant } from '../assistant/core.js';
import { claimInbound, completeInbound } from './inbox-store.js';
import type { ApprovalResolutionResult } from '../types.js';
import { getPlanProposal, planProposalNeedsUserInput, rejectPlanProposal } from '../agents/plan-proposals.js';
import { createGoalFromDraft, dismissGoalDraft, getGoalDraft } from '../agents/goal-drafts.js';
import { answerCheckIn, getCheckIn } from '../agents/check-ins.js';
import { approvePlanAndQueueBackgroundTask } from '../execution/approved-plan-tasks.js';
import { queueBackgroundTaskApprovalResolution } from '../execution/background-tasks.js';
import { getNotification, markNotificationRead, requeueNotificationDelivery } from '../runtime/notifications.js';

const logger = pino({ name: 'clementine-next.slack' });

const SLACK_ACTION_PREFIX = 'clementine';

export interface SlackRuntimeStatus {
  enabled: boolean;
  connected: boolean;
  listening: boolean;
  botUserId?: string;
  teamName?: string;
  startedAt?: string;
}

let slackApp: App | null = null;
let botUserId = '';
let teamName = '';
let startedAt: string | undefined;
let connected = false;
let startPromise: Promise<void> | null = null;

export function getSlackRuntimeStatus(): SlackRuntimeStatus {
  return {
    enabled: SLACK_ENABLED,
    connected,
    listening: connected,
    botUserId: botUserId || undefined,
    teamName: teamName || undefined,
    startedAt,
  };
}

// ── Allowlist (mirrors Discord's shouldRespond semantics) ──────────────────
function userAllowedSlack(userId: string | undefined): boolean {
  if (!userId) return false;
  return SLACK_ALLOWED_USERS.includes(userId);
}

function channelAllowedSlack(channelId: string | undefined): boolean {
  if (!channelId) return false;
  if (SLACK_ALLOWED_CHANNELS.length === 0) return true; // empty = all invited channels
  return SLACK_ALLOWED_CHANNELS.includes(channelId);
}

// Strip a leading "<@BOTID>" mention from an app_mention's text.
function stripMention(text: string): string {
  return text.replace(/<@[A-Z0-9]+>/i, '').trim();
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
    ].join('\n');
  }
  const result = await assistant.getRuntime().resolveApproval(approvalId, approved);
  return approvalResultText(result);
}

// ── Outbound send helpers (used by notification-delivery) ──────────────────
function requireClient(): WebClient {
  if (!slackApp || !connected) {
    throw new Error('Slack client is not connected in this process.');
  }
  return slackApp.client;
}

export async function sendSlackChannelMessage(channelId: string, text: string): Promise<void> {
  await requireClient().chat.postMessage({ channel: channelId, text: toSlackMrkdwn(text) || '…', mrkdwn: true });
}

export async function sendSlackDirectMessage(
  userId: string,
  text: string,
  options: { blocks?: KnownBlock[] } = {},
): Promise<void> {
  const client = requireClient();
  // Open (or fetch) the IM channel for this user, then post into it.
  const opened = await client.conversations.open({ users: userId });
  const channel = (opened.channel as { id?: string } | undefined)?.id;
  if (!channel) throw new Error(`Could not open Slack DM channel for user ${userId}.`);
  await postWithOptionalBlocks(client, channel, text, options.blocks);
}

export async function sendSlackChannelMessageWithBlocks(
  channelId: string,
  text: string,
  blocks: KnownBlock[],
): Promise<void> {
  await postWithOptionalBlocks(requireClient(), channelId, text, blocks);
}

async function postWithOptionalBlocks(
  client: WebClient,
  channel: string,
  text: string,
  blocks?: KnownBlock[],
): Promise<void> {
  const body = toSlackMrkdwn(text);
  if (blocks && blocks.length > 0) {
    await client.chat.postMessage({
      channel,
      text: (body || '…').slice(0, 2900),
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: (body || '…').slice(0, 2900) } }, ...blocks],
    });
  } else {
    await client.chat.postMessage({ channel, text: body || '…', mrkdwn: true });
  }
}

// ── Block Kit approval buttons for notifications (mirror buildActionsForNotification) ──
function actionsBlock(blockId: string, elements: Button[]): ActionsBlock {
  return { type: 'actions', block_id: blockId, elements };
}

function btn(text: string, actionId: string, value: string, style?: 'primary' | 'danger'): Button {
  const b: Button = { type: 'button', text: { type: 'plain_text', text }, action_id: actionId, value };
  if (style) b.style = style;
  return b;
}

/**
 * Block Kit sibling of buildActionsForNotification (discord.ts): emit the
 * right buttons for a notification's metadata. Same precedence + the same
 * `clementine:<verb>:<id>` action_id convention the action handler parses.
 */
export function buildSlackActionsForNotification(metadata: Record<string, unknown> | undefined): KnownBlock[] | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const planProposalId = typeof metadata.planProposalId === 'string' ? metadata.planProposalId : undefined;
  if (planProposalId) {
    const proposal = getPlanProposal(planProposalId);
    if (!proposal) return undefined;
    if (planProposalNeedsUserInput(proposal)) {
      return [actionsBlock(`${SLACK_ACTION_PREFIX}:plan:${planProposalId}`, [
        btn('View in Dashboard', `${SLACK_ACTION_PREFIX}:plan-view:${planProposalId}`, planProposalId),
        btn('Dismiss', `${SLACK_ACTION_PREFIX}:plan-reject:${planProposalId}`, planProposalId, 'danger'),
      ])];
    }
    return [actionsBlock(`${SLACK_ACTION_PREFIX}:plan:${planProposalId}`, [
      btn('Approve & Proceed', `${SLACK_ACTION_PREFIX}:plan-approve:${planProposalId}`, planProposalId, 'primary'),
      btn('Reject', `${SLACK_ACTION_PREFIX}:plan-reject:${planProposalId}`, planProposalId, 'danger'),
      btn('View / Edit', `${SLACK_ACTION_PREFIX}:plan-view:${planProposalId}`, planProposalId),
    ])];
  }
  const goalDraftId = typeof metadata.goalDraftId === 'string' ? metadata.goalDraftId : undefined;
  if (goalDraftId) {
    const draft = getGoalDraft(goalDraftId);
    if (!draft || draft.status !== 'pending') return undefined;
    return [actionsBlock(`${SLACK_ACTION_PREFIX}:goal:${goalDraftId}`, [
      btn('Review in Goals', `${SLACK_ACTION_PREFIX}:goal-draft-review:${goalDraftId}`, goalDraftId, 'primary'),
      btn('Create Goal', `${SLACK_ACTION_PREFIX}:goal-draft-create:${goalDraftId}`, goalDraftId),
      btn('Dismiss', `${SLACK_ACTION_PREFIX}:goal-draft-dismiss:${goalDraftId}`, goalDraftId),
    ])];
  }
  const approvalId = typeof metadata.approvalId === 'string' ? metadata.approvalId : undefined;
  if (approvalId) {
    return [actionsBlock(`${SLACK_ACTION_PREFIX}:approval:${approvalId}`, [
      btn('Approve', `${SLACK_ACTION_PREFIX}:approve:${approvalId}`, approvalId, 'primary'),
      btn('Edit', `${SLACK_ACTION_PREFIX}:edit:${approvalId}`, approvalId),
      btn('Reject', `${SLACK_ACTION_PREFIX}:reject:${approvalId}`, approvalId, 'danger'),
    ])];
  }
  const checkInId = typeof metadata.checkInId === 'string' ? metadata.checkInId : undefined;
  if (checkInId) {
    return [actionsBlock(`${SLACK_ACTION_PREFIX}:checkin:${checkInId}`, [
      btn('Approve', `${SLACK_ACTION_PREFIX}:checkin-approve:${checkInId}`, checkInId, 'primary'),
      btn('Answer / Edit', `${SLACK_ACTION_PREFIX}:checkin-answer:${checkInId}`, checkInId),
      btn('Reject', `${SLACK_ACTION_PREFIX}:checkin-reject:${checkInId}`, checkInId, 'danger'),
    ])];
  }
  return undefined;
}

// ── Inbound message dispatch ───────────────────────────────────────────────
async function dispatchInbound(opts: {
  client: WebClient;
  channelId: string;
  userId: string;
  teamId?: string | null;
  ts: string;
  threadTs?: string;
  prompt: string;
  files?: Array<{ name?: string; url_private?: string }>;
}): Promise<void> {
  const inboxKey = { channel: `slack:${opts.channelId}`, sourceMessageId: opts.ts };
  const claim = claimInbound({ ...inboxKey, userId: opts.userId });
  if (!claim.shouldProcess) {
    logger.info({ ...inboxKey, status: claim.record.status }, 'Skipping already-handled Slack message');
    return;
  }
  // Approval-resume shortcut: "approve apr-xxxx" while a session is paused.
  const transport = buildSlackHarnessTransport({ client: opts.client, channel: opts.channelId, threadTs: opts.threadTs });
  try {
    const handled = await tryHandleHarnessApprovalReply({
      channelId: opts.channelId,
      prompt: opts.prompt,
      transport,
      allowGlobalApprovalFallback: !opts.threadTs, // DMs (no thread) allow the global fallback, like Discord DMs
      channel: 'slack',
    });
    if (handled) {
      completeInbound({ ...inboxKey, status: 'replied' });
      return;
    }
    await handleSlackHarnessMessage({
      client: opts.client,
      channelId: opts.channelId,
      userId: opts.userId,
      teamId: opts.teamId,
      threadTs: opts.threadTs,
      prompt: opts.prompt,
      files: opts.files,
    });
    completeInbound({ ...inboxKey, status: 'replied' });
  } catch (err) {
    logger.error({ err, ...inboxKey }, 'Slack message handling failed');
    completeInbound({ ...inboxKey, status: 'failed', error: err instanceof Error ? err.message : String(err) });
    try { await transport.sendError('Something went wrong handling that — try again.'); } catch { /* best effort */ }
  }
}

// ── Action (button) handling ───────────────────────────────────────────────
async function handleSlackAction(opts: {
  assistant: ClementineAssistant;
  client: WebClient;
  actionId: string;
  userId: string;
  channelId: string;
  triggerId?: string;
  messageTs?: string;
  threadTs?: string;
  respondEphemeral: (text: string) => Promise<void>;
}): Promise<void> {
  const [, action, targetId] = opts.actionId.split(':');
  if (!action || !targetId) {
    await opts.respondEphemeral('Malformed action.');
    return;
  }
  if (!userAllowedSlack(opts.userId)) {
    await opts.respondEphemeral('You are not authorized to control Clementine.');
    return;
  }

  if (action === 'session-resume') {
    const bound = bindDiscordHarnessSession({ channelId: opts.channelId, sessionId: targetId, userId: opts.userId });
    await opts.respondEphemeral(bound
      ? `Bound this conversation to \`${targetId}\`. Your next message continues that session.`
      : `Session \`${targetId}\` was not found.`);
    return;
  }

  if (action === 'approve' || action === 'reject') {
    const approved = action === 'approve';
    if (targetId.startsWith('apr-')) {
      const row = approvalRegistry.get(targetId);
      if (row && row.status !== 'pending') {
        await opts.respondEphemeral(`Approval \`${targetId}\` was already ${row.status}.`);
        return;
      }
      const transport = buildSlackHarnessTransport({ client: opts.client, channel: opts.channelId, threadTs: opts.threadTs ?? opts.messageTs });
      const handled = await tryHandleHarnessApprovalReply({
        channelId: opts.channelId,
        prompt: `${approved ? 'approve' : 'reject'} ${targetId}`,
        transport,
        allowGlobalApprovalFallback: false,
        channel: 'slack',
      });
      if (handled) return;
    }
    const text = await resolveApprovalOrQueueBackgroundContinuation(opts.assistant, targetId, approved);
    await opts.respondEphemeral(text);
    return;
  }

  if (action === 'edit') {
    if (!targetId.startsWith('apr-') || !opts.triggerId) {
      await opts.respondEphemeral('Edit is only available for runtime approvals.');
      return;
    }
    const row = approvalRegistry.get(targetId);
    if (!row || row.status !== 'pending') {
      await opts.respondEphemeral(row ? `Approval \`${targetId}\` is already ${row.status}.` : `Approval \`${targetId}\` was not found.`);
      return;
    }
    const editable = pickEditableField(row);
    let initialValue = editable.initialValue;
    if (initialValue.length > 2900) initialValue = `${initialValue.slice(0, 2900)}\n…[truncated]`;
    await opts.client.views.open({
      trigger_id: opts.triggerId,
      view: {
        type: 'modal',
        callback_id: `${SLACK_ACTION_PREFIX}:edit-modal:${targetId}:${editable.modalStyle}`,
        title: { type: 'plain_text', text: editable.modalStyle === 'plain' ? 'Edit instructions' : 'Edit args' },
        submit: { type: 'plain_text', text: 'Approve' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [{
          type: 'input',
          block_id: 'args_block',
          label: { type: 'plain_text', text: editable.label.slice(0, 2000) },
          element: { type: 'plain_text_input', action_id: 'args', multiline: true, initial_value: initialValue },
        }],
      },
    });
    return;
  }

  if (action === 'checkin-approve' || action === 'checkin-reject') {
    const record = getCheckIn(targetId);
    if (!record) { await opts.respondEphemeral(`Check-in \`${targetId}\` was not found.`); return; }
    if (record.status !== 'open') { await opts.respondEphemeral(`Check-in is already ${record.status}.`); return; }
    const resolved = answerCheckIn(targetId, action === 'checkin-approve' ? 'approve' : 'reject');
    await opts.respondEphemeral(resolved ? `Recorded answer for \`${targetId}\`.` : `Check-in \`${targetId}\` was not found.`);
    return;
  }

  if (action === 'checkin-answer') {
    const record = getCheckIn(targetId);
    if (!record || record.status !== 'open') {
      await opts.respondEphemeral(record ? `Check-in \`${targetId}\` is already ${record.status}.` : `Check-in \`${targetId}\` was not found.`);
      return;
    }
    if (!opts.triggerId) { await opts.respondEphemeral('Cannot open the answer dialog here.'); return; }
    await opts.client.views.open({
      trigger_id: opts.triggerId,
      view: {
        type: 'modal',
        callback_id: `${SLACK_ACTION_PREFIX}:checkin-modal:${targetId}`,
        title: { type: 'plain_text', text: 'Answer Clementine' },
        submit: { type: 'plain_text', text: 'Send' },
        close: { type: 'plain_text', text: 'Cancel' },
        blocks: [{
          type: 'input',
          block_id: 'answer_block',
          label: { type: 'plain_text', text: 'Your answer' },
          element: { type: 'plain_text_input', action_id: 'answer', multiline: true, placeholder: { type: 'plain_text', text: record.question.slice(0, 140) } },
        }],
      },
    });
    return;
  }

  if (action === 'plan-approve') {
    const proposal = getPlanProposal(targetId);
    if (proposal && planProposalNeedsUserInput(proposal)) {
      await opts.respondEphemeral('This plan still needs a clarification before it can run — reply with the missing detail.');
      return;
    }
    const result = approvePlanAndQueueBackgroundTask(targetId);
    await opts.respondEphemeral(result ? `Approved — queued background task \`${result.task.id}\`.` : `Plan \`${targetId}\` was not found or already resolved.`);
    return;
  }

  if (action === 'plan-reject') {
    const result = rejectPlanProposal(targetId, 'rejected via Slack button');
    await opts.respondEphemeral(result ? 'Plan rejected.' : `Plan \`${targetId}\` was not found.`);
    return;
  }

  if (action === 'plan-view') {
    const proposal = getPlanProposal(targetId);
    await opts.respondEphemeral(proposal
      ? `*${proposal.plan.objective}* — ${proposal.plan.steps.length} step(s). Open Clementine Desktop → Proposals for details.`
      : `Plan \`${targetId}\` was not found.`);
    return;
  }

  if (action === 'goal-draft-review') {
    const draft = getGoalDraft(targetId);
    await opts.respondEphemeral(draft && draft.status === 'pending'
      ? `*${draft.draft.objective}* — open Clementine Desktop → Goals to review.`
      : `Goal draft \`${targetId}\` was not found or already resolved.`);
    return;
  }

  if (action === 'goal-draft-create') {
    const result = createGoalFromDraft(targetId);
    await opts.respondEphemeral(result ? `Created goal \`${result.goal.id}\`.` : `Goal draft \`${targetId}\` was not found or already resolved.`);
    return;
  }

  if (action === 'goal-draft-dismiss') {
    const result = dismissGoalDraft(targetId, 'dismissed via Slack button');
    await opts.respondEphemeral(result ? 'Goal draft dismissed.' : `Goal draft \`${targetId}\` was not found or already resolved.`);
    return;
  }

  if (action === 'read') {
    const notification = getNotification(targetId);
    if (!notification) { await opts.respondEphemeral(`Notification \`${targetId}\` was not found.`); return; }
    markNotificationRead(targetId);
    await opts.respondEphemeral(`Marked notification \`${targetId}\` as read.`);
    return;
  }

  if (action === 'retry') {
    const notification = getNotification(targetId);
    if (!notification) { await opts.respondEphemeral(`Notification \`${targetId}\` was not found.`); return; }
    requeueNotificationDelivery(targetId);
    await opts.respondEphemeral(`Requeued delivery for notification \`${targetId}\`.`);
    return;
  }

  if (action === 'continue') {
    await opts.respondEphemeral('Reply `continue` here to resume — your chats run on the durable harness, so it picks up with full history.');
    return;
  }

  await opts.respondEphemeral('Unknown action.');
}

// Pick the most human-editable field for the edit modal (mirror discord.ts).
function pickEditableField(row: approvalRegistry.PendingApprovalRow): { label: string; initialValue: string; modalStyle: 'plain' | 'json' } {
  const args = (row.args ?? {}) as Record<string, unknown>;
  if (row.tool === 'request_approval' && typeof args.reason === 'string') {
    return { label: 'What should Clementine do?', initialValue: args.reason, modalStyle: 'plain' };
  }
  if (row.tool === 'composio_execute_tool') {
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

// ── Modal (view) submit handling ──────────────────────────────────────────
async function handleEditModalSubmit(callbackId: string, answer: string): Promise<{ ok: boolean; message: string }> {
  const parts = callbackId.split(':');
  const approvalId = parts[2];
  const modalMode: 'plain' | 'json' = parts[3] === 'plain' ? 'plain' : 'json';
  if (!approvalId || !approvalId.startsWith('apr-')) return { ok: false, message: 'Malformed edit submission.' };
  const editedValue = answer.trim();
  if (!editedValue) return { ok: false, message: 'Edited value was empty.' };
  const row = approvalRegistry.get(approvalId);
  if (!row || row.status !== 'pending') {
    return { ok: false, message: row ? `Approval \`${approvalId}\` is already ${row.status}.` : `Approval \`${approvalId}\` was not found.` };
  }
  let editedArgs = '';
  if (modalMode === 'plain') {
    const args = (row.args ?? {}) as Record<string, unknown>;
    if (row.tool === 'request_approval') {
      editedArgs = JSON.stringify({ ...args, reason: editedValue });
    } else if (row.tool === 'composio_execute_tool') {
      const inner = (args as { arguments?: unknown }).arguments;
      let innerObj: Record<string, unknown> = {};
      if (typeof inner === 'string') { try { innerObj = JSON.parse(inner) as Record<string, unknown>; } catch { innerObj = {}; } }
      const slug = (args as { tool_slug?: unknown }).tool_slug;
      if (typeof slug === 'string' && /OUTLOOK_SEND_EMAIL|GMAIL_SEND_EMAIL/i.test(slug)) innerObj.body = editedValue;
      else innerObj = { ...innerObj, instruction: editedValue };
      editedArgs = JSON.stringify({ ...args, arguments: JSON.stringify(innerObj) });
    } else {
      return { ok: false, message: `Plain-text edit isn't supported for tool ${row.tool ?? 'unknown'}.` };
    }
  } else {
    try { JSON.parse(editedValue); } catch (err) { return { ok: false, message: `Edited args are not valid JSON: ${err instanceof Error ? err.message : String(err)}.` }; }
    editedArgs = editedValue;
  }
  // Resolve via the same local harness-approvals endpoint the desktop +
  // Discord edit flows use, so the resume logic stays in one place.
  const url = `http://127.0.0.1:${WEBHOOK_PORT}/api/console/harness-approvals/${encodeURIComponent(approvalId)}/approve_with_edits`;
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${WEBHOOK_SECRET}` },
      body: JSON.stringify({ modifiedArgs: editedArgs }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      const text = await response.text();
      return { ok: false, message: `Edit-and-approve failed: ${response.status} ${text.slice(0, 200)}` };
    }
    return { ok: true, message: '🍊 Approved with edits. The agent is continuing with your updated args.' };
  } catch (err) {
    return { ok: false, message: `Edit-and-approve failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ── Startup ────────────────────────────────────────────────────────────────
export async function startSlackBot(assistant: ClementineAssistant): Promise<void> {
  if (!SLACK_ENABLED) return;
  if (startPromise) return startPromise;
  if (!SLACK_BOT_TOKEN || !SLACK_APP_TOKEN) {
    throw new Error('SLACK_ENABLED but SLACK_BOT_TOKEN or SLACK_APP_TOKEN is missing.');
  }

  startPromise = (async () => {
    const app = new App({
      token: SLACK_BOT_TOKEN,
      appToken: SLACK_APP_TOKEN,
      socketMode: true,
    });

    // DMs: only message.im events (per the app manifest). Ignore bots, our own
    // messages, and edits/joins (subtype set).
    app.event('message', async ({ event, client }) => {
      const e = event as {
        channel_type?: string; channel?: string; user?: string; text?: string;
        ts?: string; thread_ts?: string; bot_id?: string; subtype?: string;
        files?: Array<{ name?: string; url_private?: string }>;
      };
      if (e.channel_type !== 'im') return;
      if (e.bot_id || e.subtype || !e.user || e.user === botUserId) return;
      if (!userAllowedSlack(e.user)) return;
      const prompt = (e.text ?? '').trim();
      if (!prompt && !(e.files && e.files.length > 0)) return;
      await dispatchInbound({
        client,
        channelId: e.channel ?? '',
        userId: e.user,
        ts: e.ts ?? '',
        threadTs: e.thread_ts,
        prompt,
        files: e.files,
      });
    });

    // Channel @mentions.
    app.event('app_mention', async ({ event, client }) => {
      const e = event as {
        channel?: string; user?: string; text?: string; ts?: string; thread_ts?: string; team?: string;
        files?: Array<{ name?: string; url_private?: string }>;
      };
      if (!e.user || e.user === botUserId) return;
      if (!userAllowedSlack(e.user) || !channelAllowedSlack(e.channel)) return;
      const prompt = stripMention(e.text ?? '');
      if (!prompt && !(e.files && e.files.length > 0)) return;
      await dispatchInbound({
        client,
        channelId: e.channel ?? '',
        userId: e.user,
        teamId: e.team,
        ts: e.ts ?? '',
        // Thread the reply under the mention so the live-edited message + the
        // ongoing conversation stay grouped in a channel.
        threadTs: e.thread_ts ?? e.ts,
        prompt,
        files: e.files,
      });
    });

    // Interactive buttons. ack() FIRST (Slack's 3s window), then do the work.
    app.action(/^clementine:.+/, async ({ ack, body, client, action }) => {
      await ack();
      const b = body as {
        user?: { id?: string };
        channel?: { id?: string };
        trigger_id?: string;
        message?: { ts?: string; thread_ts?: string };
      };
      const actionId = (action as { action_id?: string }).action_id ?? '';
      const channelId = b.channel?.id ?? '';
      const respondEphemeral = async (text: string): Promise<void> => {
        try {
          if (channelId && b.user?.id) {
            await client.chat.postEphemeral({ channel: channelId, user: b.user.id, text: toSlackMrkdwn(text) || '…' });
          }
        } catch { /* ephemeral is best-effort */ }
      };
      try {
        await handleSlackAction({
          assistant,
          client,
          actionId,
          userId: b.user?.id ?? '',
          channelId,
          triggerId: b.trigger_id,
          messageTs: b.message?.ts,
          threadTs: b.message?.thread_ts,
          respondEphemeral,
        });
      } catch (err) {
        logger.error({ err, actionId }, 'Slack action handling failed');
        await respondEphemeral(err instanceof Error ? err.message : String(err));
      }
    });

    // Edit-approval + check-in answer modals.
    app.view(/^clementine:(edit-modal|checkin-modal):/, async ({ ack, body, view }) => {
      const callbackId = view.callback_id;
      if (callbackId.startsWith(`${SLACK_ACTION_PREFIX}:checkin-modal:`)) {
        const checkInId = callbackId.split(':')[2];
        const answer = view.state.values.answer_block?.answer?.value?.trim() ?? '';
        if (!answer) { await ack({ response_action: 'errors', errors: { answer_block: 'Answer cannot be empty.' } }); return; }
        await ack();
        const userId = (body as { user?: { id?: string } }).user?.id;
        if (userId && userAllowedSlack(userId)) answerCheckIn(checkInId, answer);
        return;
      }
      // edit-modal
      const answer = view.state.values.args_block?.args?.value ?? '';
      const userId = (body as { user?: { id?: string } }).user?.id;
      if (!userId || !userAllowedSlack(userId)) { await ack(); return; }
      const result = await handleEditModalSubmit(callbackId, answer);
      if (result.ok) await ack();
      else await ack({ response_action: 'errors', errors: { args_block: result.message.slice(0, 150) } });
    });

    app.error(async (error) => {
      logger.error({ err: error }, 'Slack app error');
    });

    await app.start();
    slackApp = app;
    connected = true;
    startedAt = new Date().toISOString();
    try {
      const auth = await app.client.auth.test();
      botUserId = (auth.user_id as string) ?? '';
      teamName = (auth.team as string) ?? '';
      logger.info({ botUserId, teamName }, 'Slack bot connected (Socket Mode)');
    } catch (err) {
      logger.warn({ err }, 'Slack auth.test failed; bot connected but identity unknown');
    }
  })();

  return startPromise;
}

// Exposed for unit tests.
export const __test__ = {
  buildSlackActionsForNotification,
  pickEditableField,
  userAllowedSlack,
  channelAllowedSlack,
  stripMention,
};
