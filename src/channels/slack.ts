import pino from 'pino';
import { App, Assistant } from '@slack/bolt';
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
import { buildSlackHarnessTransport, handleSlackHarnessMessage, slackHarnessConversationId, toSlackMrkdwn } from './slack-harness.js';
import { ClementineAssistant } from '../assistant/core.js';
import { claimInbound, completeInbound } from './inbox-store.js';
import type { ApprovalResolutionResult } from '../types.js';
import { getPlanProposal, planProposalNeedsUserInput, rejectPlanProposal, listActiveGoalContracts, listPlanProposals } from '../agents/plan-proposals.js';
import { createGoalFromDraft, dismissGoalDraft, getGoalDraft, listGoalDrafts } from '../agents/goal-drafts.js';
import { answerCheckIn, getCheckIn, listOpenCheckIns } from '../agents/check-ins.js';
import { approvePlanAndQueueBackgroundTask } from '../execution/approved-plan-tasks.js';
import { queueBackgroundTaskApprovalResolution, listBackgroundTasks, createBackgroundTask } from '../execution/background-tasks.js';
import { rememberFact, getMemoryHealthSummary } from '../memory/facts.js';
import { getNotification, markNotificationRead, requeueNotificationDelivery } from '../runtime/notifications.js';
import { loadCronJobs, loadWorkflows } from '../dashboard/state.js';
import { getNextRun } from '../shared/cron.js';

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
// Threads we've already named via assistant.threads.setTitle (once per thread;
// in-memory is fine — the title persists in Slack, this just avoids re-titling).
const titledThreads = new Set<string>();

/** Recall-sharpened starter prompts for the assistant pane: real active goals +
 *  in-flight tasks first, then evergreen starters. Best-effort; never throws.
 *  Slack renders up to 4. */
function buildSuggestedPrompts(): Array<{ title: string; message: string }> {
  const prompts: Array<{ title: string; message: string }> = [];
  const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  try {
    for (const g of listActiveGoalContracts().slice(0, 2)) {
      const t = (g.originatingRequest || 'your goal').trim();
      prompts.push({ title: clip(`Resume: ${t}`, 44), message: `Resume the goal "${t}" — where does it stand and what's the next step?` });
    }
  } catch { /* goals are optional */ }
  try {
    const live = listBackgroundTasks({ status: 'awaiting_approval' }).concat(listBackgroundTasks({ status: 'running' }));
    for (const task of live.slice(0, 1)) {
      const t = (task.title || 'your task').trim();
      prompts.push({ title: clip(`Check: ${t}`, 44), message: `What's the status of "${t}"?` });
    }
  } catch { /* tasks are optional */ }
  prompts.push({ title: "What's on my plate?", message: 'Give me a quick brief of my goals, tasks, and anything that needs my attention.' });
  prompts.push({ title: 'Draft my morning brief', message: 'Put together my morning brief.' });
  return prompts.slice(0, 4);
}

/** The App Home command-center view: a live at-a-glance summary, pending approvals
 *  (with inline Approve/Reject buttons that reuse the clementine:* action router),
 *  anything blocked on your input, active goals, in-flight work, and recently
 *  completed tasks. Republished on app_home_opened. Best-effort; every data source
 *  is wrapped so a failure degrades to an empty section, never throws. The premium,
 *  persistent, app-owned dashboard Discord has no equivalent for. */
function buildAppHomeBlocks(): KnownBlock[] {
  const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  const safe = <T,>(fn: () => T, fallback: T): T => { try { return fn(); } catch { return fallback; } };

  // ── Gather everything up front (best-effort) so every count is accurate ──
  // "Needs you" = the consolidated set of everything genuinely blocked on the
  // user. Approvals (from the registry) ALREADY cover awaiting_approval tasks, so
  // those tasks are intentionally NOT counted again — that double-count is the
  // accuracy bug this fixes.
  const approvals = safe(() => approvalRegistry.listPending().map((a) => ({ approvalId: a.approvalId, subject: a.subject })), []);
  const checkIns = safe(() => listOpenCheckIns(), []);
  const goalDrafts = safe(() => listGoalDrafts({ status: 'pending' }), []);
  const plansNeedInput = safe(() => listPlanProposals({ status: 'all' }).filter(planProposalNeedsUserInput), []);
  const blockedTasks = [
    ...safe(() => listBackgroundTasks({ status: 'blocked' }), []),
    ...safe(() => listBackgroundTasks({ status: 'awaiting_input' }), []),
    ...safe(() => listBackgroundTasks({ status: 'awaiting_continue' }), []),
  ];
  const running = safe(() => listBackgroundTasks({ status: 'running' }), []);
  const recent = (a: { completedAt?: string; updatedAt?: string }, b: { completedAt?: string; updatedAt?: string }) =>
    (b.completedAt ?? b.updatedAt ?? '').localeCompare(a.completedAt ?? a.updatedAt ?? '');
  // Failures the user should SEE (previously invisible) — scoped to the last 14
  // days so "Needs attention" stays actionable instead of accreting ancient,
  // water-under-the-bridge failures forever.
  const FAILED_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
  const failed = [
    ...safe(() => listBackgroundTasks({ status: 'failed' }), []),
    ...safe(() => listBackgroundTasks({ status: 'aborted' }), []),
    ...safe(() => listBackgroundTasks({ status: 'interrupted' }), []),
  ]
    .filter((t) => {
      const ts = Date.parse(t.completedAt ?? t.updatedAt ?? '');
      return !Number.isFinite(ts) || ts >= Date.now() - FAILED_WINDOW_MS;
    })
    .sort(recent);
  const doneAll = safe(() => listBackgroundTasks({ status: 'done' }).sort(recent), []);
  const goals = safe(() => listActiveGoalContracts(), [] as Array<{ originatingRequest?: string }>);
  const mem = safe(() => getMemoryHealthSummary(), { activeFacts: 0, pinned: 0, byKind: {} as Record<string, number>, newest: null, recallHitRate: null });

  // Upcoming scheduled runs: cron jobs + workflows carrying a schedule, soonest first.
  const formatNextRun = (iso: string): string => {
    const ms = Date.parse(iso) - Date.now();
    if (!Number.isFinite(ms) || ms < 0) return 'soon';
    const min = Math.round(ms / 60000);
    if (min < 60) return `in ${Math.max(1, min)}m`;
    const hr = Math.round(min / 60);
    if (hr < 24) return `in ${hr}h`;
    return `in ${Math.round(hr / 24)}d`;
  };
  const upcoming = safe(() => {
    const items: Array<{ name: string; when: string; at: number }> = [];
    const add = (name: string, schedule: string | undefined, enabled: boolean): void => {
      if (!enabled || !schedule) return;
      const iso = getNextRun(schedule);
      if (!iso) return;
      items.push({ name, when: formatNextRun(iso), at: Date.parse(iso) });
    };
    for (const j of safe(() => loadCronJobs(), [])) add(j.name, j.schedule, j.enabled !== false);
    for (const w of safe(() => loadWorkflows(), [])) add(w.name, w.trigger?.schedule, w.enabled !== false);
    return items.sort((a, b) => a.at - b.at);
  }, [] as Array<{ name: string; when: string; at: number }>);

  const needsYou = approvals.length + checkIns.length + goalDrafts.length + plansNeedInput.length + blockedTasks.length;
  const today = new Date().toISOString().slice(0, 10);
  const doneToday = doneAll.filter((t) => (t.completedAt ?? t.updatedAt ?? '').slice(0, 10) === today).length;

  // A TRUSTWORTHY memory summary, not a bare count: total + per-kind breakdown +
  // pinned (always-on standing facts) + recall hit-rate + the newest thing learned.
  const kindLabel: Record<string, string> = { user: 'about you', project: 'projects', feedback: 'prefs', reference: 'refs', constraint: 'rules' };
  const kindBits = Object.entries(mem.byKind)
    .filter(([, c]) => c > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
    .map(([k, c]) => `${c} ${kindLabel[k] ?? k}`);
  const memBits = [`🧠 *${mem.activeFacts}* facts${kindBits.length ? ` (${kindBits.join(' · ')})` : ''}`];
  if (mem.pinned > 0) memBits.push(`*${mem.pinned}* pinned`);
  if (mem.recallHitRate !== null) memBits.push(`recall *${Math.round(mem.recallHitRate * 100)}%*`);
  if (mem.newest) memBits.push(`newest: "${clip(mem.newest.content.trim(), 60)}"`);

  const blocks: KnownBlock[] = [
    { type: 'header', text: { type: 'plain_text', text: '🍊 Clementine — command center', emoji: true } },
    { type: 'context', elements: [{ type: 'mrkdwn', text:
      `🎯 *${goals.length}* goals   ·   ⚙️ *${running.length}* running   ·   ⏸️ *${needsYou}* waiting on you` }] },
    { type: 'context', elements: [{ type: 'mrkdwn', text:
      `📊 *${doneToday}* done today   ·   *${running.length}* running${failed.length ? `   ·   ❌ *${failed.length}* failed` : ''}${upcoming.length ? `   ·   ⏰ next ${upcoming[0].when}` : ''}` }] },
    { type: 'context', elements: [{ type: 'mrkdwn', text: memBits.join('   ·   ') }] },
    { type: 'context', elements: [{ type: 'mrkdwn', text: '💬 Open the *Messages* tab to talk to me, or type `/clem` anywhere.' }] },
    { type: 'divider' },
  ];

  // ── Needs you: the accurate, consolidated set of everything blocked on you ──
  if (needsYou > 0) {
    blocks.push({ type: 'header', text: { type: 'plain_text', text: `Needs you (${needsYou})`, emoji: true } });
    // Approvals — actionable inline buttons (these already cover awaiting_approval tasks).
    for (const a of approvals.slice(0, 5)) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*${clip(a.subject || 'Approval', 140)}*` } });
      blocks.push({
        type: 'actions',
        block_id: `clementine:approval:${a.approvalId}`,
        elements: [
          { type: 'button', style: 'primary', text: { type: 'plain_text', text: 'Approve' }, action_id: `clementine:approve:${a.approvalId}`, value: a.approvalId },
          { type: 'button', style: 'danger', text: { type: 'plain_text', text: 'Reject' }, action_id: `clementine:reject:${a.approvalId}`, value: a.approvalId },
        ],
      });
    }
    // Questions she asked you (open check-ins) — answer in the Messages tab.
    for (const c of checkIns.slice(0, 4)) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `🙋 *Question:* ${clip((c.question || '').trim(), 150)}` } });
    }
    // Goal drafts awaiting your confirmation.
    for (const d of goalDrafts.slice(0, 3)) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `📝 *Draft to confirm:* ${clip((d.desiredOutcome || d.notes || 'Goal draft').trim(), 150)}` } });
    }
    // Plans paused for your input.
    for (const p of plansNeedInput.slice(0, 3)) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `📋 *Plan needs input:* ${clip((p.originatingRequest || 'Plan').trim(), 150)}` } });
    }
    // Tasks stuck waiting on you (blocked / paused for a question or budget).
    for (const t of blockedTasks.slice(0, 5)) {
      const icon = t.status === 'blocked' ? '🚧' : '🙋';
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `${icon} ${clip(t.title || 'Task', 150)}  \`${t.status}\`` } });
    }
    // Honest overflow: the count above is the TRUE total; sections are capped, so
    // tell the user when there's more than what's rendered.
    const shownNeedsYou = Math.min(approvals.length, 5) + Math.min(checkIns.length, 4)
      + Math.min(goalDrafts.length, 3) + Math.min(plansNeedInput.length, 3) + Math.min(blockedTasks.length, 5);
    if (needsYou > shownNeedsYou) {
      blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `_…and ${needsYou - shownNeedsYou} more — open the Messages tab to see everything._` }] });
    }
    blocks.push({ type: 'divider' });
  }

  // ── Needs attention: failures the user should see (previously invisible) ──
  if (failed.length > 0) {
    blocks.push({ type: 'header', text: { type: 'plain_text', text: `Needs attention (${failed.length})`, emoji: true } });
    for (const t of failed.slice(0, 5)) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `❌ ${clip(t.title || 'Task', 150)}  \`${t.status}\`` } });
    }
    blocks.push({ type: 'divider' });
  }

  // ── Goals ──
  blocks.push({ type: 'header', text: { type: 'plain_text', text: `Goals (${goals.length})`, emoji: true } });
  if (goals.length === 0) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '_No active goals. Tell me one in the Messages tab and I\'ll hold it._' } });
  } else {
    for (const g of goals.slice(0, 8)) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `🎯 ${clip((g.originatingRequest || 'Goal').trim(), 160)}` } });
    }
  }

  // ── In flight: genuinely-running work ONLY (awaiting_approval now lives under Needs you) ──
  blocks.push({ type: 'divider' });
  blocks.push({ type: 'header', text: { type: 'plain_text', text: `In flight (${running.length})`, emoji: true } });
  if (running.length === 0) {
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: '_Nothing running right now._' } });
  } else {
    for (const t of running.slice(0, 8)) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `⚙️ ${clip(t.title || 'Task', 160)}  \`running\`` } });
    }
  }

  // ── Upcoming: next scheduled runs ──
  if (upcoming.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push({ type: 'header', text: { type: 'plain_text', text: `Upcoming (${upcoming.length})`, emoji: true } });
    for (const u of upcoming.slice(0, 5)) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `⏰ ${clip(u.name || 'Scheduled', 120)}  —  *${u.when}*` } });
    }
  }

  // ── Recently completed (read-only history, so the home tells a full story) ──
  if (doneAll.length > 0) {
    blocks.push({ type: 'divider' });
    blocks.push({ type: 'header', text: { type: 'plain_text', text: 'Recently completed', emoji: true } });
    for (const t of doneAll.slice(0, 4)) {
      blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `✅ ${clip(t.title || 'Task', 160)}` } });
    }
  }

  return blocks;
}

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

/** True when a `message` event belongs to the native AI-Assistant container (a
 *  threaded im with no real subtype). Mirrors Bolt's internal isAssistantMessage
 *  (not exported), so the generic message.im handler can SKIP these — the
 *  Assistant userMessage handler already owns them. Without this skip the same
 *  message is answered twice (one reply from each handler). */
export function isAssistantContainerMessage(msg: { channel_type?: string; thread_ts?: string; subtype?: string }): boolean {
  return Boolean(msg.thread_ts)
    && msg.channel_type === 'im'
    && (!msg.subtype || msg.subtype === 'file_share');
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

export async function sendSlackChannelMessage(
  channelId: string,
  text: string,
  options: { threadTs?: string } = {},
): Promise<void> {
  await requireClient().chat.postMessage({
    channel: channelId,
    thread_ts: options.threadTs,
    text: toSlackMrkdwn(text) || '…',
    mrkdwn: true,
  });
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
  options: { threadTs?: string } = {},
): Promise<void> {
  await postWithOptionalBlocks(requireClient(), channelId, text, blocks, options);
}

async function postWithOptionalBlocks(
  client: WebClient,
  channel: string,
  text: string,
  blocks?: KnownBlock[],
  options: { threadTs?: string } = {},
): Promise<void> {
  const body = toSlackMrkdwn(text);
  if (blocks && blocks.length > 0) {
    await client.chat.postMessage({
      channel,
      thread_ts: options.threadTs,
      text: (body || '…').slice(0, 2900),
      blocks: [{ type: 'section', text: { type: 'mrkdwn', text: (body || '…').slice(0, 2900) } }, ...blocks],
    });
  } else {
    await client.chat.postMessage({ channel, thread_ts: options.threadTs, text: body || '…', mrkdwn: true });
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
  /** When present, this turn runs through the native AI-Assistant transport
   *  (setStatus drives the pane indicator). Passed by the assistant userMessage
   *  handler. The plain DM/mention paths omit it. Either way BOTH paths share the
   *  ONE claimInbound dedup below, keyed on the unique message ts — so a message
   *  delivered to two listeners is answered exactly once, never doubled. */
  setStatus?: (status: string) => Promise<unknown>;
}): Promise<void> {
  const inboxKey = { channel: `slack:${opts.channelId}`, sourceMessageId: opts.ts };
  const claim = claimInbound({ ...inboxKey, userId: opts.userId });
  if (!claim.shouldProcess) {
    logger.info({ ...inboxKey, status: claim.record.status }, 'Skipping already-handled Slack message');
    return;
  }
  // Approval-resume shortcut: "approve apr-xxxx" while a session is paused.
  const transport = buildSlackHarnessTransport({ client: opts.client, channel: opts.channelId, threadTs: opts.threadTs });
  const conversationId = slackHarnessConversationId(opts.channelId, opts.threadTs);
  try {
    const handled = await tryHandleHarnessApprovalReply({
      channelId: conversationId,
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
      setStatus: opts.setStatus,
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
    const conversationId = slackHarnessConversationId(opts.channelId, opts.threadTs ?? opts.messageTs);
    const bound = bindDiscordHarnessSession({ channelId: conversationId, sessionId: targetId, userId: opts.userId });
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
      const conversationId = slackHarnessConversationId(opts.channelId, opts.threadTs ?? opts.messageTs);
      const handled = await tryHandleHarnessApprovalReply({
        channelId: conversationId,
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

    // ── Native AI Assistant pane (Agents & AI Apps) ─────────────────────────
    // The premium, app-owned assistant container Discord has no equivalent for:
    // a docked pane that follows the user, shows live "Clem is …" status during
    // autonomous runs, and offers recall-sharpened starter prompts. It runs on
    // the SAME shared harness runner as DMs/mentions (gates, approvals, brain) —
    // it only adds setStatus narration, suggested prompts, and thread titles.
    // Registered first so it intercepts assistant-container messages (Bolt stops
    // them propagating to the message.im handler below).
    const aiAssistant = new Assistant({
      threadStarted: async ({ event, say, setSuggestedPrompts, saveThreadContext }) => {
        const user = (event as { assistant_thread?: { user_id?: string } }).assistant_thread?.user_id;
        if (user && !userAllowedSlack(user)) {
          await say("I'm not set up to chat with you yet — ask the workspace owner to add your Slack member ID in Clementine's Connect → Slack settings.");
          return;
        }
        try {
          await say("Hey, I'm Clem — your AI chief of staff. Ask me anything, or pick a starter below. I'll show what I'm doing as I work, and pause for your approval before anything irreversible.");
          await setSuggestedPrompts({ title: 'Try one of these', prompts: buildSuggestedPrompts() });
          await saveThreadContext();
        } catch (err) {
          logger.warn({ err }, 'assistant threadStarted failed');
        }
      },
      threadContextChanged: async ({ saveThreadContext }) => {
        try { await saveThreadContext(); } catch { /* best effort */ }
      },
      userMessage: async ({ message, client, setStatus, setTitle, getThreadContext }) => {
        const m = message as {
          user?: string; text?: string; channel?: string; thread_ts?: string; ts?: string;
          bot_id?: string; subtype?: string; files?: Array<{ name?: string; url_private?: string }>;
        };
        if (m.bot_id || m.subtype || !m.user || m.user === botUserId) return;
        if (!userAllowedSlack(m.user)) {
          await client.chat.postMessage({ channel: m.channel ?? '', thread_ts: m.thread_ts ?? m.ts, text: "I'm not authorized to chat with you yet." });
          return;
        }
        const prompt = (m.text ?? '').trim();
        if (!prompt && !(m.files && m.files.length > 0)) return;
        const threadTs = m.thread_ts ?? m.ts;
        // Name the thread from the first message (once per thread).
        if (threadTs && !titledThreads.has(threadTs)) {
          titledThreads.add(threadTs);
          try { await setTitle(prompt.slice(0, 60) || 'New conversation'); } catch { /* title is best-effort */ }
        }
        let teamId: string | null = null;
        try { teamId = (await getThreadContext())?.team_id ?? null; } catch { /* context optional */ }
        // Route through the SHARED dispatchInbound so this turn passes the SAME
        // claimInbound dedup as the DM/mention paths (keyed on the unique message
        // ts). If Slack ever delivers the same message to both this handler and
        // the message.im listener, only the first claim runs — the message is
        // answered exactly once. Presence of setStatus selects the assistant
        // transport so run activity drives the native pane's status line.
        await dispatchInbound({
          client,
          channelId: m.channel ?? '',
          userId: m.user,
          teamId,
          ts: m.ts ?? threadTs ?? '',
          threadTs,
          prompt,
          files: m.files,
          setStatus: (status: string) => setStatus(status),
        });
      },
    });
    app.assistant(aiAssistant);

    // DMs: only message.im events (per the app manifest). Ignore bots, our own
    // messages, and edits/joins (subtype set).
    app.event('message', async ({ event, client }) => {
      const e = event as {
        channel_type?: string; channel?: string; user?: string; text?: string;
        ts?: string; thread_ts?: string; bot_id?: string; subtype?: string;
        files?: Array<{ name?: string; url_private?: string }>;
      };
      if (e.channel_type !== 'im') return;
      // Assistant-pane messages are threaded ims — the app.assistant userMessage
      // handler owns them. Skip here so a single message isn't answered twice.
      if (isAssistantContainerMessage(e)) return;
      if (e.bot_id || e.subtype || !e.user || e.user === botUserId) return;
      if (!userAllowedSlack(e.user)) return;
      const prompt = (e.text ?? '').trim();
      if (!prompt && !(e.files && e.files.length > 0)) return;
      await dispatchInbound({
        client,
        channelId: e.channel ?? '',
        userId: e.user,
        // Mirror the assistant handler's fallback so the two never compute a
        // different dedup key for the same message (defensive — the skip above
        // should already keep them mutually exclusive).
        ts: e.ts ?? e.thread_ts ?? '',
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

    // ── App Home: persistent command center (goals · in-flight · approvals) ──
    app.event('app_home_opened', async ({ event, client }) => {
      const e = event as { user?: string; tab?: string };
      if (e.tab && e.tab !== 'home') return;
      if (!e.user || !userAllowedSlack(e.user)) return;
      try {
        await client.views.publish({ user_id: e.user, view: { type: 'home', blocks: buildAppHomeBlocks() } });
      } catch (err) {
        logger.warn({ err }, 'app_home publish failed');
      }
    });

    // ── /clem <anything> — global free-text launcher ────────────────────────
    app.command('/clem', async ({ command, ack, respond, client }) => {
      await ack();
      const c = command as { user_id?: string; channel_id?: string; text?: string; trigger_id?: string };
      if (!c.user_id || !userAllowedSlack(c.user_id)) {
        await respond({ response_type: 'ephemeral', text: "You're not authorized to use Clementine yet." });
        return;
      }
      const text = (c.text ?? '').trim();
      if (!text) {
        await respond({ response_type: 'ephemeral', text: 'Usage: `/clem [what you want done]` — e.g. `/clem summarize my unread emails`.' });
        return;
      }
      await respond({ response_type: 'ephemeral', text: `On it — working on: “${text}”. I'll reply here.` });
      // sourceMessageId must be UNIQUE per invocation — a slash command has no
      // message ts, so key on the per-invocation trigger_id. An empty key would
      // collide every /clem in this channel through the shared claimInbound dedup,
      // silently dropping the 2nd onward. trigger_id is also stable across a Slack
      // redelivery, so it dedups a genuine retry too.
      await dispatchInbound({ client, channelId: c.channel_id ?? '', userId: c.user_id, ts: `slash:${c.trigger_id || Date.now()}`, prompt: text });
    });

    // ── Message shortcut: Summarize this thread ─────────────────────────────
    app.shortcut({ callback_id: 'clementine:summarize_thread', type: 'message_action' }, async ({ shortcut, ack, client }) => {
      await ack();
      const s = shortcut as { user?: { id?: string }; channel?: { id?: string }; trigger_id?: string; message?: { ts?: string; thread_ts?: string; text?: string } };
      if (!s.user?.id || !userAllowedSlack(s.user.id)) return;
      const channel = s.channel?.id ?? '';
      const rootTs = s.message?.thread_ts ?? s.message?.ts;
      if (!channel || !rootTs) return;
      let convo = s.message?.text ?? '';
      try {
        const r = await client.conversations.replies({ channel, ts: rootTs, limit: 50 });
        const msgs = (r.messages ?? []).map((m) => (m as { text?: string }).text ?? '').filter(Boolean);
        if (msgs.length) convo = msgs.join('\n');
      } catch { /* fall back to the single message */ }
      await dispatchInbound({
        // Unique per invocation (trigger_id) so back-to-back shortcuts don't
        // collide on an empty key in the shared dedup; falls back to the message ts.
        client, channelId: channel, userId: s.user.id, ts: `shortcut:summarize:${s.trigger_id || rootTs}`, threadTs: rootTs,
        prompt: `Summarize this Slack thread concisely — key points, decisions, and any open action items:\n\n${convo}`,
      });
    });

    // ── Message shortcut: Turn into a task ──────────────────────────────────
    app.shortcut({ callback_id: 'clementine:make_task', type: 'message_action' }, async ({ shortcut, ack, client }) => {
      await ack();
      const s = shortcut as { user?: { id?: string }; channel?: { id?: string }; message?: { ts?: string; text?: string } };
      if (!s.user?.id || !userAllowedSlack(s.user.id)) return;
      const channel = s.channel?.id ?? '';
      const text = (s.message?.text ?? '').trim();
      if (!text) return;
      const title = text.length > 60 ? `${text.slice(0, 57)}...` : text;
      try {
        createBackgroundTask({ title, prompt: text, userId: s.user.id, channel: `slack:${channel}`, source: 'slack' });
        if (channel) await client.chat.postEphemeral({ channel, user: s.user.id, text: `Got it — started a background task: *${title}*. I'll report back when it's done.` });
      } catch (err) {
        logger.warn({ err }, 'make_task shortcut failed');
      }
    });

    // ── Reactions as commands: 📌 (pushpin) save to memory · 📝 (memo) summarize ──
    app.event('reaction_added', async ({ event, client }) => {
      const e = event as { user?: string; reaction?: string; item?: { type?: string; channel?: string; ts?: string } };
      if (!e.user || e.user === botUserId || !userAllowedSlack(e.user)) return;
      if (e.item?.type !== 'message' || !e.item.channel || !e.item.ts) return;
      const { channel, ts } = { channel: e.item.channel, ts: e.item.ts };
      const reaction = e.reaction ?? '';
      if (reaction !== 'pushpin' && reaction !== 'memo') return;
      const fetchText = async (): Promise<string> => {
        try {
          const r = await client.conversations.history({ channel, latest: ts, inclusive: true, limit: 1 });
          return ((r.messages ?? [])[0] as { text?: string } | undefined)?.text ?? '';
        } catch { return ''; }
      };
      if (reaction === 'pushpin') {
        const text = (await fetchText()).trim();
        if (!text) return;
        try {
          rememberFact({ kind: 'user', content: text });
          await client.chat.postEphemeral({ channel, user: e.user, text: '📌 Saved that to your memory.' });
        } catch (err) { logger.warn({ err }, 'reaction save-to-memory failed'); }
      } else {
        let convo = await fetchText();
        try {
          const r = await client.conversations.replies({ channel, ts, limit: 50 });
          const msgs = (r.messages ?? []).map((m) => (m as { text?: string }).text ?? '').filter(Boolean);
          if (msgs.length) convo = msgs.join('\n');
        } catch { /* fall back */ }
        if (!convo.trim()) return;
        // Stable, unique key per reaction event (message ts + user + emoji): dedups
        // a Slack redelivery of the same reaction, but never collides with other
        // reactions/commands in the channel (an empty key would).
        await dispatchInbound({ client, channelId: channel, userId: e.user, ts: `reaction:${ts}:${e.user}:${reaction}`, threadTs: ts, prompt: `Summarize this concisely:\n\n${convo}` });
      }
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
  buildSuggestedPrompts,
  buildAppHomeBlocks,
};
