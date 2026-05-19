/**
 * Discord ↔ 0.3 harness bridge.
 *
 * When DISCORD_HARNESS_ENABLED=true, incoming Discord messages are
 * routed through this handler instead of the v0.2 gateway. Live
 * progress is rendered by editing the bot's reply message as
 * actionBus emits harness.event entries for the session.
 *
 * Why in-process actionBus instead of the SSE endpoint:
 *   The Discord bot is already inside the daemon process. Round-
 *   tripping through HTTP/SSE adds latency and a moving part for no
 *   gain. We subscribe to actionBus directly and filter by session.
 *
 * Discord edit-rate caveat:
 *   Discord's rate limit on message.edit is ~5/5s per channel. We
 *   debounce edits to ~1 every 2 seconds so a chatty turn (many
 *   tool_called events) never trips the limit. The last edit always
 *   wins regardless of how many events fired during the debounce.
 */
import type { Message } from 'discord.js';
import { actionBus } from '../runtime/action-bus.js';
import { configureHarnessRuntime } from '../runtime/harness/codex-client.js';
import {
  appendEvent as appendHarnessEvent,
  createSession as createHarnessSession,
  getSession as getHarnessSession,
  type EventRow,
} from '../runtime/harness/eventlog.js';
import { runConversation, runConversationFromResume } from '../runtime/harness/loop.js';
import { HarnessSession } from '../runtime/harness/session.js';
import { openEventLog } from '../runtime/harness/eventlog.js';
import * as approvalRegistry from '../runtime/harness/approval-registry.js';
import { buildOrchestratorAgent } from '../agents/orchestrator.js';

const EDIT_DEBOUNCE_MS = 2_000;
const SAFETY_TIMEOUT_MS = 35 * 60_000;
const MAX_DISCORD_MESSAGE = 1_900;

/**
 * Per-channel harness session continuity. Without this, every DM
 * spawns a brand-new session and the orchestrator has zero memory
 * of the previous turn — the agent looks broken (asks a clarifying
 * question, the user answers, and the next "session" has no idea
 * what file/topic was just discussed).
 *
 * Channel → most-recent session id + last-used timestamp. Sessions
 * older than CONTINUITY_WINDOW_MS are treated as stale and a fresh
 * session is created on the next DM, so a user coming back the next
 * day doesn't end up resuming a long-cold thread.
 */
interface ChannelSessionEntry {
  sessionId: string;
  lastUsedAt: number;
}
const channelSessions = new Map<string, ChannelSessionEntry>();
const CONTINUITY_WINDOW_MS = 30 * 60_000;

/**
 * Look up the most recent harness session for a Discord channel in
 * SQLite. Used to rehydrate the in-memory channelSessions map after
 * a daemon restart so a session that was paused-for-approval before
 * the restart can still be resumed by typing "approve" — the
 * approval state lives in the durable event log, but the channel-id
 * → session-id mapping was process-local.
 */
function findMostRecentChannelSession(channelId: string): { sessionId: string; updatedAt: number } | null {
  try {
    const db = openEventLog();
    const row = db
      .prepare(
        `SELECT id, updated_at FROM sessions
           WHERE channel = 'discord'
             AND json_extract(metadata_json, '$.channelId') = ?
           ORDER BY updated_at DESC
           LIMIT 1`,
      )
      .get(channelId) as { id?: string; updated_at?: string } | undefined;
    // The `channel` column is filled from createSession opts.channel
    // which we don't currently pass — fall back to a pure metadata
    // match if the indexed lookup misses.
    const matched = row ?? (db
      .prepare(
        `SELECT id, updated_at FROM sessions
           WHERE json_extract(metadata_json, '$.source') = 'discord'
             AND json_extract(metadata_json, '$.channelId') = ?
           ORDER BY updated_at DESC
           LIMIT 1`,
      )
      .get(channelId) as { id?: string; updated_at?: string } | undefined);
    if (!matched?.id || !matched.updated_at) return null;
    return { sessionId: matched.id, updatedAt: new Date(matched.updated_at).getTime() };
  } catch {
    return null;
  }
}

/**
 * Look up the channel's session, hydrating from SQLite if it's not
 * already in the in-memory map. Returns null if no recent session
 * exists OR the most recent one is past the continuity window.
 */
function getOrHydrateChannelSession(channelId: string): ChannelSessionEntry | null {
  const now = Date.now();
  const existing = channelSessions.get(channelId);
  if (existing && now - existing.lastUsedAt < CONTINUITY_WINDOW_MS) {
    const row = getHarnessSession(existing.sessionId);
    if (row) return existing;
    channelSessions.delete(channelId);
  }
  const recent = findMostRecentChannelSession(channelId);
  if (!recent) return null;
  if (now - recent.updatedAt > CONTINUITY_WINDOW_MS) return null;
  const entry: ChannelSessionEntry = { sessionId: recent.sessionId, lastUsedAt: recent.updatedAt };
  channelSessions.set(channelId, entry);
  return entry;
}

/**
 * Per-channel staleness window. If the user's last interaction with
 * the channel-cached session was longer ago than this AND a fresh
 * non-approval message arrives, open a NEW session instead of
 * grafting. Prevents the failure mode where a 6-hour-old paused
 * session captures unrelated chat as a "continuation."
 *
 * 5 min is short enough to keep continuation feeling fluid in an
 * active conversation, long enough that a brief context switch
 * doesn't lose state.
 */
const STALE_SESSION_MS = 5 * 60 * 1000;

function resolveOrCreateSession(opts: {
  channelId: string;
  userId: string;
  guildId: string | null;
  prompt: string;
}): { id: string; isContinuation: boolean } {
  const now = Date.now();
  const existing = getOrHydrateChannelSession(opts.channelId);
  if (existing) {
    // Continuation is intentional ONLY when the channel was actively
    // engaged recently. After STALE_SESSION_MS without traffic, fresh
    // messages open a new session — the prior one keeps its history
    // and (if paused) stays reachable via apr-xxxx. Without this, a
    // paused session that sat 6 hours would silently absorb the next
    // unrelated message as if it were continuing the same workflow.
    const elapsed = now - existing.lastUsedAt;
    if (elapsed <= STALE_SESSION_MS) {
      existing.lastUsedAt = now;
      return { id: existing.sessionId, isContinuation: true };
    }
    // Stale: drop the cached reference. The old session row + any
    // pending approvals stay in the DB; they're just no longer the
    // channel's "default."
    channelSessions.delete(opts.channelId);
  }
  const session = createHarnessSession({
    kind: 'chat',
    title: opts.prompt.length > 60 ? `${opts.prompt.slice(0, 57)}...` : opts.prompt,
    metadata: {
      source: 'discord',
      channelId: opts.channelId,
      userId: opts.userId,
      guildId: opts.guildId,
    },
  });
  channelSessions.set(opts.channelId, { sessionId: session.id, lastUsedAt: now });
  return { id: session.id, isContinuation: false };
}

/** Exposed for tests / a future /new command — drop the channel's session. */
export function clearDiscordHarnessSession(channelId: string): void {
  channelSessions.delete(channelId);
}

/**
 * /cancel handler — abandon paused approvals on this channel, clear
 * the session's interrupt state, mark the session 'cancelled', and
 * confirm to the user. The paused approval rows are resolved with
 * 'cancelled_by_user' so the audit log distinguishes user-driven
 * abandonment from reaper-driven expiry.
 *
 * The session row stays in the DB (we don't delete history) — just
 * its status flips and its interrupt state is cleared so the next
 * message from the user starts fresh.
 */
async function handleHarnessCancel(opts: {
  channelId: string;
  transport: DiscordHarnessTransport;
}): Promise<void> {
  const entry = getOrHydrateChannelSession(opts.channelId);
  if (!entry) {
    await opts.transport.sendError('Nothing to cancel — no paused session on this channel.');
    return;
  }
  const session = HarnessSession.load(entry.sessionId);
  if (!session) {
    channelSessions.delete(opts.channelId);
    await opts.transport.sendError('Nothing to cancel — the session is no longer available.');
    return;
  }

  // Resolve any pending registry rows for this session as cancelled_by_user.
  let cancelledCount = 0;
  for (const row of approvalRegistry.listPending({ sessionId: session.id, status: 'pending' })) {
    const result = approvalRegistry.resolve(row.approvalId, 'cancelled_by_user', 'discord-user');
    if (result.ok) cancelledCount++;
  }
  // Clear interrupt state + mark session cancelled. The next message
  // resolveOrCreateSession will create a fresh session because the
  // staleness check sees this one as terminal.
  try {
    session.clearInterruptState();
    session.markStatus('cancelled');
  } catch {
    /* best effort — the user-facing confirmation still goes out */
  }
  channelSessions.delete(opts.channelId);

  // Emit a harness event so the audit log + dashboard see the cancel.
  try {
    appendHarnessEvent({
      sessionId: session.id,
      turn: 0,
      role: 'user',
      type: 'approval_resolved',
      data: {
        decision: 'cancelled_by_user',
        approvalsCancelled: cancelledCount,
      },
    });
  } catch {
    /* best effort */
  }

  const replyBody = cancelledCount > 0
    ? `🍊 Cancelled. Abandoned ${cancelledCount} pending approval${cancelledCount === 1 ? '' : 's'} on this channel. Send a new message to start fresh.`
    : '🍊 Cancelled. Session cleared. Send a new message to start fresh.';
  try {
    const handle = await opts.transport.sendInitial(replyBody);
    // sendInitial returns a handle but we don't need to edit it — the
    // body is the final message.
    void handle;
  } catch {
    /* transport already failed once; user can re-engage if needed */
  }
}

/**
 * /new handler — drop the channel's cached session so the next
 * message creates a fresh one. The paused session (if any) stays
 * in __interrupt_state and addressable via its apr-xxxx code, but
 * the channel no longer routes incoming messages to it.
 *
 * Distinct from /cancel: /new keeps the old session reachable (for
 * later `approve apr-xxxx`); /cancel actively abandons it.
 */
async function handleHarnessNew(opts: {
  channelId: string;
  transport: DiscordHarnessTransport;
}): Promise<void> {
  const entry = getOrHydrateChannelSession(opts.channelId);
  channelSessions.delete(opts.channelId);

  if (entry) {
    const pending = approvalRegistry.listPending({ sessionId: entry.sessionId, status: 'pending' });
    const addressableHint = pending.length > 0
      ? ` The paused session is still reachable via \`approve ${pending[0].approvalId}\` (or \`reject\`).`
      : '';
    await opts.transport.sendInitial(`🍊 Fresh session ready. Send your first message.${addressableHint}`);
  } else {
    await opts.transport.sendInitial('🍊 Fresh session ready. Send your first message.');
  }
}

/**
 * Detect approve / reject intent in a Discord prompt. Conservative —
 * only matches at the start of the message and only when a session
 * is actually awaiting approval. "Yes" mid-conversation when nothing
 * is pending should be treated as a regular new turn, not an approval.
 *
 * Returns `{ decision, approvalId? }` so callers can route an explicit
 * `approve apr-xy7q` (or `reject apr-xy7q`) at exactly the addressable
 * approval, instead of the legacy "most recent paused session" fallback
 * that today silently routes to the wrong session when multiple are
 * pending. The approval ID is the apr-<4 base36 chars> format minted
 * by approval-registry.ts.
 *
 * Matcher tightening (T1.2): the old permissive set (`yes|y|ok|okay`)
 * hijacked plenty of conversational messages — "yes please continue
 * the workflow" got routed as an approval. The new rule:
 *   - STRONG verbs (`approve`, `reject`, `proceed`, `go ahead`, `lgtm`,
 *     `do it`, `confirm`, `deny`, `abort`, `nevermind`, 👍/👎) match
 *     regardless of whether an apr-xxxx is present.
 *   - LOOSE verbs (`yes`, `y`, `ok`, `okay`, `no`, `n`, `sure`, etc.)
 *     ONLY match when paired with an explicit apr-xxxx code. A bare
 *     "yes" no longer reads as approval; "yes apr-26ba" does.
 *   - "cancel" is reserved for the /cancel command (parseHarnessCommand);
 *     it no longer counts as a reject so users can abandon the pause
 *     entirely instead of resolving it as rejected.
 */
export interface ParsedApprovalIntent {
  decision: 'approve' | 'reject';
  /** When the user typed `approve apr-xy7q` or `reject apr-xy7q`. */
  approvalId?: string;
}

// Strong verbs — unambiguous endorsement / rejection of an approval.
// Match at the start of the message ONLY so "I approve of that idea"
// doesn't fire when nothing is asking for approval.
//
// The emoji patterns are separate from the word patterns because
// JavaScript's `\b` (ASCII word boundary) doesn't fire around an
// emoji codepoint, so `^👍\b` never matches. Two patterns, OR'd at
// the caller, keeps each clean and well-tested.
const STRONG_APPROVE = /^(approve(d)?|proceed|go ahead|lgtm|do it|confirm(ed)?)\b/;
const STRONG_APPROVE_EMOJI = /^👍/;
const STRONG_REJECT = /^(reject(ed)?|deny|denied|abort|nevermind|never mind|don'?t do (it|that))\b/;
const STRONG_REJECT_EMOJI = /^👎/;
// Loose verbs — require an apr-xxxx in the message to disambiguate
// from regular conversation. "yes apr-26ba" reads as approval; bare
// "yes" does not (it's just a conversational ack).
const LOOSE_APPROVE_WITH_ID = /^(yes|y|ok|okay|sure|sounds good|do this)\b/;
const LOOSE_REJECT_WITH_ID = /^(no|n|stop)\b/;
const APR_ID_PATTERN = /\bapr-([a-z0-9]{4})\b/;

export function parseApprovalIntent(prompt: string): ParsedApprovalIntent | null {
  const t = prompt.trim().toLowerCase();
  if (!t) return null;
  const idMatch = APR_ID_PATTERN.exec(t);
  const approvalId = idMatch ? `apr-${idMatch[1]}` : undefined;

  if (STRONG_APPROVE.test(t) || STRONG_APPROVE_EMOJI.test(t)) {
    return approvalId ? { decision: 'approve', approvalId } : { decision: 'approve' };
  }
  if (STRONG_REJECT.test(t) || STRONG_REJECT_EMOJI.test(t)) {
    return approvalId ? { decision: 'reject', approvalId } : { decision: 'reject' };
  }
  // Loose verbs only count when an apr-xxxx code is also present —
  // that's the explicit signal "yes I mean THIS approval".
  if (approvalId && LOOSE_APPROVE_WITH_ID.test(t)) {
    return { decision: 'approve', approvalId };
  }
  if (approvalId && LOOSE_REJECT_WITH_ID.test(t)) {
    return { decision: 'reject', approvalId };
  }
  return null;
}

/**
 * Slash-style command parser for harness-channel control. Distinct
 * from parseApprovalIntent so the two surfaces don't bleed into each
 * other — `cancel` used to count as a reject, which conflated
 * "abandon this whole session" with "say no to the specific tool the
 * bot asked permission for." Now `/cancel` is its own thing.
 *
 * Recognized:
 *   /cancel     — abandon the paused approval(s) on this channel,
 *                 clear the session's interrupt state, mark the
 *                 session 'cancelled'. Frees the channel for a fresh
 *                 turn.
 *   /new        — start a fresh session on this channel ignoring any
 *                 paused one. The paused session stays addressable
 *                 via its apr-xxxx code for later.
 *
 * Accepts both `/cancel` and bare `cancel` / `new` on a line by
 * itself, so the user doesn't need to know the prefix.
 */
export type HarnessCommand = 'cancel' | 'new' | 'continue';
export function parseHarnessCommand(prompt: string): HarnessCommand | null {
  const t = prompt.trim().toLowerCase();
  if (t === '/cancel' || t === 'cancel') return 'cancel';
  if (t === '/new' || t === 'new') return 'new';
  // /continue (T1.3 graceful continue) — the loop emits a "Reply
  // `continue` to keep going" message when it hits a step or wall-clock
  // limit. Honor a bare `continue` or `keep going` so the user can
  // resume long-running work without re-typing the original request.
  if (t === '/continue' || t === 'continue' || t === 'keep going') return 'continue';
  return null;
}

/**
 * Find the most recent `conversation_completed` event for a session.
 * Used by the /continue path to inspect whether the session ended on
 * an awaiting_continue limit and to extract the last orchestrator
 * summary as continuation context.
 */
export function readLastConversationCompletion(sessionId: string): {
  reason?: string;
  limitKind?: string;
  lastDecisionSummary?: string;
} | null {
  try {
    const db = openEventLog();
    const row = db
      .prepare(`SELECT data_json FROM events WHERE session_id = ? AND type = 'conversation_completed' ORDER BY seq DESC LIMIT 1`)
      .get(sessionId) as { data_json: string } | undefined;
    if (!row) return null;
    const parsed = JSON.parse(row.data_json) as Record<string, unknown>;
    return {
      reason: typeof parsed.reason === 'string' ? parsed.reason : undefined,
      limitKind: typeof parsed.limitKind === 'string' ? parsed.limitKind : undefined,
      lastDecisionSummary: typeof parsed.lastDecisionSummary === 'string' ? parsed.lastDecisionSummary : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Build the synthetic input the orchestrator sees on a /continue
 * resume. The session history is replayed in full via
 * session.toInputItems, so the model already has all prior turns —
 * this prompt just gives it explicit permission to keep going + a
 * pointer to the last decision's summary so it doesn't restart from
 * scratch.
 */
function buildContinueInput(lastSummary: string | undefined): string {
  return [
    'You hit a step / time budget on the previous turn and the user has now replied `continue`.',
    'Pick up where you left off; do not restart the workflow from scratch.',
    lastSummary
      ? `Your last summary on the prior turn was: "${lastSummary.slice(0, 400)}".`
      : 'Use the conversation history above to figure out where you were.',
    'Continue with the next step of your plan. If you have nothing left to do, set done=true and nextAction=completed.',
  ].join('\n\n');
}

/**
 * True if the harness session for this channel is currently paused
 * awaiting approval. Hydrates from SQLite if the in-memory map was
 * cleared (e.g. by a daemon restart) so the durable interrupt state
 * stays addressable through "approve" / "reject" replies.
 */
export function isChannelSessionAwaitingApproval(channelId: string): boolean {
  const entry = getOrHydrateChannelSession(channelId);
  if (!entry) return false;
  const sess = HarnessSession.load(entry.sessionId);
  return !!sess && !!sess.loadInterruptState();
}

/**
 * Discord-channel-side approval router. Called BEFORE the v0.2
 * `handleDiscordRestCommand` / `handleDiscordCommand` paths so the
 * v0.2 `resolveNaturalApproval` resolver doesn't intercept the
 * user's "approve" / "reject" — the v0.2 approval store knows
 * nothing about the harness's pending interruption and replies with
 * "No pending approval is waiting".
 *
 * Returns true if the prompt was an approval intent AND a harness
 * session was paused for this channel. In that case the resume has
 * been kicked off and the caller should NOT continue to the v0.2
 * gateway path.
 */
export async function tryHandleHarnessApprovalReply(opts: {
  channelId: string;
  prompt: string;
  transport: DiscordHarnessTransport;
}): Promise<boolean> {
  if (!isChannelSessionAwaitingApproval(opts.channelId)) return false;
  const intent = parseApprovalIntent(opts.prompt);
  if (!intent) return false;
  await runDiscordHarnessResume({
    channelId: opts.channelId,
    decision: intent.decision,
    approvalId: intent.approvalId,
    transport: opts.transport,
  });
  return true;
}

/**
 * Abstraction over "where do we send the placeholder and where do we
 * edit it as progress arrives." The two Discord paths into the harness
 * need different transports:
 *
 *   - Gateway path: real Discord.js Message — uses message.reply +
 *     reply.edit. Used when the bot is connected to Discord's
 *     WebSocket gateway.
 *   - REST/DM polling path: no Message object — we POST a fresh
 *     message and PATCH it by id. Used when intents make DMs
 *     unavailable over the gateway and we poll DMs via REST.
 *
 * Both end up driving the same conversation flow; only the transport
 * differs. `runDiscordHarnessConversation` owns the state machine.
 */
export interface DiscordHarnessTransport {
  /** Send the initial placeholder. Returns a handle for subsequent edits. */
  sendInitial(content: string): Promise<DiscordHarnessReplyHandle>;
  /** Send a one-shot error message when we never get to start the run. */
  sendError(content: string): Promise<void>;
  /**
   * Post a follow-up message into the same conversation. Used to deliver
   * the tail of a reply that exceeds Discord's 2000-char per-message
   * cap, so the user sees the whole answer instead of `…obje…`.
   */
  sendFollowup?(content: string): Promise<void>;
}

export interface DiscordHarnessReplyHandle {
  edit(content: string): Promise<void>;
}

interface DisplayState {
  summary: string;
  status: string;
  done: boolean;
  // Visibility extensions — surfaced in the rolling message body so
  // the user can see what the agent is actually doing in real time.
  // Without these, long runs look identical to stuck runs.
  toolsCalled: string[];
  currentAgent?: string;
  toolCount: number;
}

function renderBody(state: DisplayState): string {
  const head = state.summary ? `> ${state.summary}\n\n` : '';
  // Live-progress block: only shown while not-done. Pulls the agent
  // currently running, the count of tool calls so far, and the last
  // ~4 tool names so the user can see "what is it doing?" at a glance.
  let activity = '';
  if (!state.done) {
    const lines: string[] = [];
    if (state.currentAgent) lines.push(`**${state.currentAgent}** is working…`);
    if (state.toolCount > 0) {
      const recent = state.toolsCalled.slice(-4).join(', ');
      lines.push(`Tools used: ${state.toolCount} (${recent})`);
    }
    if (state.status) lines.push(`_${state.status}_`);
    activity = lines.join('\n');
  }
  const body = (head + activity).trim() || '_working…_';
  // In-progress edits still truncate — the live-edit message is just a
  // status display, not the answer. The FULL reply goes through
  // renderFullBody + splitForLongReply at terminal time.
  return body.length > MAX_DISCORD_MESSAGE ? body.slice(0, MAX_DISCORD_MESSAGE - 1) + '…' : body;
}

/**
 * Final-message renderer — no truncation. Used by finalFlush when the
 * conversation reaches a terminal state. The caller pairs this with
 * splitForLongReply to fan the body across multiple Discord messages
 * when it exceeds the 2000-char per-message cap.
 *
 * The activity block is only included when state.done is false, which
 * can happen if we're rendering a timed-out state (state.done=true was
 * set by the safety timer); in that case the status string carries the
 * useful info already, so we leave activity off and just show the
 * summary.
 */
function renderFullBody(state: DisplayState): string {
  const head = state.summary ? `> ${state.summary}\n\n` : '';
  let activity = '';
  if (!state.done) {
    const lines: string[] = [];
    if (state.currentAgent) lines.push(`**${state.currentAgent}** is working…`);
    if (state.toolCount > 0) {
      const recent = state.toolsCalled.slice(-4).join(', ');
      lines.push(`Tools used: ${state.toolCount} (${recent})`);
    }
    if (state.status) lines.push(`_${state.status}_`);
    activity = lines.join('\n');
  }
  return (head + activity).trim() || '_working…_';
}

/**
 * Split a Discord message body into chunks <= MAX_DISCORD_MESSAGE,
 * preferring paragraph then line then space boundaries. Mirrors the
 * splitForDiscord shape used by notification-delivery so the same
 * "your reply spilled into N parts" semantics apply across surfaces.
 */
function splitForLongReply(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [''];
  if (trimmed.length <= MAX_DISCORD_MESSAGE) return [trimmed];

  const chunks: string[] = [];
  let remaining = trimmed;
  while (remaining.length > MAX_DISCORD_MESSAGE) {
    const window = remaining.slice(0, MAX_DISCORD_MESSAGE);
    // Prefer a paragraph break, then a newline, then a space, then
    // hard-cut. The 400-char threshold avoids giving up the cap
    // entirely on a stubborn block of unbroken text.
    let cut = window.lastIndexOf('\n\n');
    if (cut < 400) cut = window.lastIndexOf('\n');
    if (cut < 400) cut = window.lastIndexOf(' ');
    if (cut < 400) cut = MAX_DISCORD_MESSAGE;
    chunks.push(remaining.slice(0, cut).trim());
    remaining = remaining.slice(cut).trim();
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

/**
 * Transport-agnostic harness conversation runner. Subscribes to the
 * actionBus for the session's events, debounces edits, and resolves
 * once the conversation reaches a terminal state.
 */
export async function runDiscordHarnessConversation(opts: {
  prompt: string;
  channelId: string;
  userId: string;
  guildId: string | null;
  transport: DiscordHarnessTransport;
}): Promise<void> {
  const { channelId, userId, guildId, transport } = opts;
  // `prompt` is `let` (not destructured const) because the /continue
  // command path rewrites it from the bare "continue" the user typed
  // into a structured continuation directive the orchestrator can
  // act on. The rest of the function treats it as the user's input
  // verbatim.
  let prompt = opts.prompt;

  const auth = await configureHarnessRuntime();
  if (!auth.ok) {
    await transport.sendError(`Cannot start: ${auth.reason}`);
    return;
  }

  // Harness-control commands (/cancel, /new, /continue) — handled
  // BEFORE approval routing so a user-typed "cancel" abandons the
  // pause instead of counting as a reject (the old matcher conflated
  // the two and left the user with no way to back out without
  // "resolving" the action).
  const command = parseHarnessCommand(prompt);
  if (command === 'cancel') {
    await handleHarnessCancel({ channelId, transport });
    return;
  }
  if (command === 'new') {
    await handleHarnessNew({ channelId, transport });
    // Fall through is intentional — /new just clears the
    // channel-cached session; the rest of this function then creates
    // a fresh one. But the user's actual prompt was "/new", not
    // something the agent should reason about. Return so the user
    // sees the confirmation and can send their real first message.
    return;
  }
  if (command === 'continue') {
    // /continue is only meaningful when the session's last
    // conversation_completed was an "awaiting_continue" — the
    // synthetic prompt we emit from the loop's max-step / wall-clock
    // branch. When that's the case, rewrite the bare "continue" into
    // a structured continuation directive the orchestrator can act
    // on (with the prior turn's summary inlined for context), and
    // fall through to the normal turn path. Otherwise leave `continue`
    // as-is and let the agent handle it as a regular message.
    const entry = getOrHydrateChannelSession(channelId);
    if (entry) {
      const lastCompletion = readLastConversationCompletion(entry.sessionId);
      if (lastCompletion?.reason === 'awaiting_continue') {
        prompt = buildContinueInput(lastCompletion.lastDecisionSummary);
      }
    }
  }

  // Approval-resume path: if the channel has a paused session and
  // the user typed an approve/reject phrase, resolve the pending
  // approval and continue THAT session instead of starting fresh.
  // Anything else while paused is treated as a regular new turn
  // (which will append on top of the existing session via continuity).
  if (isChannelSessionAwaitingApproval(channelId)) {
    const intent = parseApprovalIntent(prompt);
    if (intent) {
      await runDiscordHarnessResume({
        channelId,
        decision: intent.decision,
        approvalId: intent.approvalId,
        transport,
      });
      return;
    }
  }

  const session = resolveOrCreateSession({ channelId, userId, guildId, prompt });

  let handle: DiscordHarnessReplyHandle;
  try {
    handle = await transport.sendInitial('🍊 starting…');
  } catch (err) {
    // Couldn't even post the placeholder — nothing we can do from
    // here; record the failure for offline replay.
    try {
      appendHarnessEvent({
        sessionId: session.id,
        turn: 0,
        role: 'system',
        type: 'run_failed',
        data: { error: err instanceof Error ? err.message : String(err), stage: 'initial_reply' },
      });
    } catch {
      /* last-ditch */
    }
    return;
  }

  const state: DisplayState = { summary: '', status: 'starting', done: false, toolsCalled: [], toolCount: 0 };
  let lastEditAt = 0;
  let pendingEdit: NodeJS.Timeout | null = null;

  const flush = async (): Promise<void> => {
    pendingEdit = null;
    lastEditAt = Date.now();
    try {
      await handle.edit(renderBody(state));
    } catch {
      // Discord can transiently refuse edits (network blip, rate
      // limit). The next event will retry; nothing fatal.
    }
  };

  /**
   * Final flush on conversation completion. Unlike progress edits,
   * this one preserves the full reply: if the body exceeds Discord's
   * per-message cap, post the head into the existing message and the
   * tail as follow-up messages. The user sees the whole answer
   * instead of the previous `…obje…` truncation marker.
   */
  const finalFlush = async (): Promise<void> => {
    pendingEdit = null;
    lastEditAt = Date.now();
    const fullBody = renderFullBody(state);
    const chunks = splitForLongReply(fullBody);
    try {
      await handle.edit(chunks[0] ?? '_working…_');
      if (chunks.length > 1 && transport.sendFollowup) {
        for (let i = 1; i < chunks.length; i++) {
          await transport.sendFollowup(chunks[i]);
        }
      }
    } catch {
      // Edit can transiently fail. Don't crash settle — the user can
      // re-ping if they don't see the full reply.
    }
  };

  const scheduleEdit = (): void => {
    if (pendingEdit) return;
    const elapsed = Date.now() - lastEditAt;
    const wait = Math.max(0, EDIT_DEBOUNCE_MS - elapsed);
    pendingEdit = setTimeout(() => {
      void flush();
    }, wait);
  };

  const finished: Promise<void> = new Promise((resolve) => {
    let unsubscribe: (() => void) | null = null;
    let safetyTimer: NodeJS.Timeout | null = null;

    const settle = async (): Promise<void> => {
      if (unsubscribe) unsubscribe();
      unsubscribe = null;
      if (safetyTimer) clearTimeout(safetyTimer);
      if (pendingEdit) {
        clearTimeout(pendingEdit);
        pendingEdit = null;
      }
      await finalFlush();
      resolve();
    };

    unsubscribe = actionBus.subscribe((bus) => {
      if (bus.kind !== 'harness.event') return;
      if (bus.sessionId !== session.id) return;
      applyEventToState(bus.event, state);
      if (state.done) {
        void settle();
        return;
      }
      scheduleEdit();
    });

    safetyTimer = setTimeout(() => {
      state.status = 'timed out waiting for completion';
      state.done = true;
      void settle();
    }, SAFETY_TIMEOUT_MS);
  });

  void (async () => {
    try {
      const agent = await buildOrchestratorAgent();
      await runConversation({ agent, sessionId: session.id, input: prompt });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      try {
        appendHarnessEvent({
          sessionId: session.id,
          turn: 0,
          role: 'system',
          type: 'run_failed',
          data: { error: errorMessage, stage: 'pre_first_turn' },
        });
      } catch {
        /* last-ditch */
      }
    }
  })();

  await finished;
}

/**
 * Approval-resume helper. Same live-edit loop as
 * runDiscordHarnessConversation, but bound to an existing paused
 * session and a yes/no decision instead of fresh user input. The
 * conversation continues from where the SDK paused — the orchestrator
 * sees the approval result on its next decision and proceeds (or
 * halts, on reject).
 */
async function runDiscordHarnessResume(opts: {
  channelId: string;
  decision: 'approve' | 'reject';
  /** When the user typed `approve apr-xy7q`, route to that specific
   *  pending approval (even if it belongs to a different session
   *  than the channel's most-recent). Without this, multi-session
   *  channels silently routed "approve" to the most-recent paused
   *  session, losing work on the older one (audit 2026-05-18). */
  approvalId?: string;
  transport: DiscordHarnessTransport;
}): Promise<void> {
  const { channelId, decision, approvalId, transport } = opts;

  // Configure the codex bridge BEFORE driving the SDK runner. The
  // resume path can be the first thing the daemon does after a
  // restart (paused session lives in SQLite, "approve" arrives via
  // DM polling) — without this, getDefaultModelProvider() returns
  // the SDK's built-in default that requires OPENAI_API_KEY, and
  // the post-approval model call fails with
  // "Missing credentials. Please pass an `apiKey`...".
  const auth = await configureHarnessRuntime();
  if (!auth.ok) {
    await transport.sendError(`Cannot resume: ${auth.reason}`);
    return;
  }

  // ── Route the approval ────────────────────────────────────────
  // Three cases, in priority order:
  //   1. `approvalId` supplied → look it up in the registry. If it
  //      points to a session paused for the same channel, switch to
  //      that session (overrides the channelSessions "most recent"
  //      heuristic). If it's missing / already resolved / not on this
  //      channel, tell the user and bail.
  //   2. No `approvalId` AND exactly one session paused on this
  //      channel → continue with the channelSessions entry (today's
  //      behavior).
  //   3. No `approvalId` AND multiple distinct sessions paused on
  //      this channel → tell the user the list of apr-xxx codes and
  //      bail. Never silently route to the wrong session.
  let sessionId: string;
  if (approvalId) {
    const row = approvalRegistry.get(approvalId);
    if (!row) {
      await transport.sendError(`No pending approval matches \`${approvalId}\`. It may have already been resolved or expired.`);
      return;
    }
    if (row.status !== 'pending') {
      await transport.sendError(`Approval \`${approvalId}\` was already ${row.status}${row.resolution ? ` (${row.resolution})` : ''}.`);
      return;
    }
    if (row.channel && row.channel !== 'discord' && row.channel !== 'discord-dm') {
      // Cross-channel approvals are intentionally blocked — the user
      // should resolve from the channel where the approval originated.
      await transport.sendError(`Approval \`${approvalId}\` belongs to a different channel.`);
      return;
    }
    sessionId = row.sessionId;
  } else {
    const pendingOnChannel = approvalRegistry
      .listPending({ status: 'pending' })
      .filter((row) => row.channel === 'discord' || row.channel === 'discord-dm');
    const distinctSessions = [...new Set(pendingOnChannel.map((r) => r.sessionId))];
    const fallback = channelSessions.get(channelId);
    if (distinctSessions.length > 1) {
      // Multiple paused sessions — make the user pick.
      const summary = distinctSessions.slice(0, 5).map((sid) => {
        const rows = pendingOnChannel.filter((r) => r.sessionId === sid);
        const first = rows[0];
        return `  • \`${first.approvalId}\` — ${first.subject}`;
      }).join('\n');
      await transport.sendError(
        `You have ${distinctSessions.length} paused approvals on this channel. Reply \`${decision} apr-xxxx\` for the one you mean:\n${summary}`,
      );
      return;
    }
    if (distinctSessions.length === 1) {
      sessionId = distinctSessions[0];
    } else if (fallback) {
      // Registry has nothing recorded (pre-migration session or a
      // race) — fall back to today's "most recent on channel" so we
      // don't regress sessions that paused before the registry
      // existed.
      sessionId = fallback.sessionId;
    } else {
      await transport.sendError('No paused session to resume.');
      return;
    }
  }

  const entry = channelSessions.get(channelId);
  if (entry && entry.sessionId === sessionId) {
    entry.lastUsedAt = Date.now();
  } else {
    // The chosen session may not be the channel-cached one (when
    // routing by approvalId). Update the cache so subsequent
    // interactions in this channel target the now-active session.
    channelSessions.set(channelId, { sessionId, lastUsedAt: Date.now() });
  }

  let handle: DiscordHarnessReplyHandle;
  try {
    handle = await transport.sendInitial(
      decision === 'approve' ? '🍊 approved — resuming…' : '🍊 rejected — winding down…',
    );
  } catch (err) {
    try {
      appendHarnessEvent({
        sessionId,
        turn: 0,
        role: 'system',
        type: 'run_failed',
        data: {
          error: err instanceof Error ? err.message : String(err),
          stage: 'resume_initial_reply',
        },
      });
    } catch {
      /* last-ditch */
    }
    return;
  }

  const state: DisplayState = {
    summary: '',
    status: decision === 'approve' ? 'resuming after approval' : 'cancelling',
    done: false,
    toolsCalled: [],
    toolCount: 0,
  };
  let lastEditAt = 0;
  let pendingEdit: NodeJS.Timeout | null = null;

  const flush = async (): Promise<void> => {
    pendingEdit = null;
    lastEditAt = Date.now();
    try {
      await handle.edit(renderBody(state));
    } catch {
      /* transient — next event retries */
    }
  };

  // See renderFullBody / splitForLongReply at the bottom of this file:
  // resume completions can also exceed Discord's 2000-char cap; mirror
  // the head-edit + tail-followup pattern from the main path.
  const finalFlush = async (): Promise<void> => {
    pendingEdit = null;
    lastEditAt = Date.now();
    const fullBody = renderFullBody(state);
    const chunks = splitForLongReply(fullBody);
    try {
      await handle.edit(chunks[0] ?? '_working…_');
      if (chunks.length > 1 && transport.sendFollowup) {
        for (let i = 1; i < chunks.length; i++) {
          await transport.sendFollowup(chunks[i]);
        }
      }
    } catch {
      /* transient — user can re-ping if they don't see the full reply */
    }
  };

  const scheduleEdit = (): void => {
    if (pendingEdit) return;
    const elapsed = Date.now() - lastEditAt;
    const wait = Math.max(0, EDIT_DEBOUNCE_MS - elapsed);
    pendingEdit = setTimeout(() => {
      void flush();
    }, wait);
  };

  const finished: Promise<void> = new Promise((resolve) => {
    let unsubscribe: (() => void) | null = null;
    let safetyTimer: NodeJS.Timeout | null = null;

    const settle = async (): Promise<void> => {
      if (unsubscribe) unsubscribe();
      unsubscribe = null;
      if (safetyTimer) clearTimeout(safetyTimer);
      if (pendingEdit) {
        clearTimeout(pendingEdit);
        pendingEdit = null;
      }
      await finalFlush();
      resolve();
    };

    unsubscribe = actionBus.subscribe((bus) => {
      if (bus.kind !== 'harness.event') return;
      if (bus.sessionId !== sessionId) return;
      applyEventToState(bus.event, state);
      if (state.done) {
        void settle();
        return;
      }
      scheduleEdit();
    });

    safetyTimer = setTimeout(() => {
      state.status = 'timed out waiting for completion';
      state.done = true;
      void settle();
    }, SAFETY_TIMEOUT_MS);
  });

  void (async () => {
    try {
      const agent = await buildOrchestratorAgent();
      const result = await runConversationFromResume({
        agent,
        sessionId,
        decision,
      });
      // Resolve every still-pending registry row for this session.
      // The SDK's resume processes ALL interrupted tool calls at once
      // (it's a single state, not per-tool), so we mirror that by
      // marking every pending apr-xxx for this session as resolved
      // with the user's chosen decision. Best-effort — if the row was
      // already expired by the reaper between user click and resume,
      // the resolve() returns ok:false reason:'already_resolved' and
      // we move on.
      const pendingForSession = approvalRegistry.listPending({ sessionId, status: 'pending' });
      const resolution = decision === 'approve' ? 'approved' : 'rejected';
      for (const row of pendingForSession) {
        approvalRegistry.resolve(row.approvalId, resolution, 'discord-user');
      }
      // If reject — the run pivoted to "no work to do" and the
      // conversation is effectively done. Force the UI into the
      // completed state so the placeholder updates with a final
      // message even when no run_completed event fires post-reject.
      if (decision === 'reject' && result.status === 'completed' && !state.done) {
        state.summary = state.summary || 'Action rejected. No work performed.';
        state.status = 'rejected';
        state.done = true;
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      try {
        appendHarnessEvent({
          sessionId,
          turn: 0,
          role: 'system',
          type: 'run_failed',
          data: { error: errorMessage, stage: 'resume' },
        });
      } catch {
        /* last-ditch */
      }
    }
  })();

  await finished;
}

/**
 * Gateway entry point — wraps Discord.js Message into the transport
 * abstraction and runs the conversation.
 */
export async function handleDiscordHarnessMessage(
  message: Message<boolean>,
  prompt: string,
): Promise<void> {
  const transport: DiscordHarnessTransport = {
    async sendInitial(content) {
      const reply = (await message.reply(content)) as unknown as {
        edit(opts: { content: string }): Promise<unknown>;
      };
      return {
        edit: async (next) => {
          await reply.edit({ content: next });
        },
      };
    },
    async sendError(content) {
      await message.reply(content);
    },
    async sendFollowup(content) {
      // Post a new message in the same channel for the tail of a long
      // reply. message.reply() threads it to the original prompt so the
      // user sees it as a continuation of the same conversation.
      await message.reply(content);
    },
  };
  await runDiscordHarnessConversation({
    prompt,
    channelId: message.channelId,
    userId: message.author.id,
    guildId: message.guildId ?? null,
    transport,
  });
}

/**
 * Translate one harness event into the Discord reply's display
 * state. Exported for unit tests; the Discord live-edit loop just
 * applies it and schedules a debounced flush.
 */
export function applyEventToState(event: EventRow, state: DisplayState): void {
  const data = event.data ?? {};
  switch (event.type) {
    case 'turn_started': {
      // role on a turn_started event is the agent that's starting
      // (Orchestrator, Researcher, Executor, Writer, etc.). Surface it
      // so the user sees who's running.
      const role = typeof event.role === 'string' && event.role !== 'system' && event.role !== 'user'
        ? event.role
        : '';
      if (role) state.currentAgent = role;
      state.status = 'thinking…';
      return;
    }
    case 'tool_called': {
      const tool = String(data.tool ?? data.name ?? 'tool');
      state.status = `using ${tool}`;
      state.toolsCalled.push(tool);
      state.toolCount += 1;
      return;
    }
    case 'handoff': {
      const to = String(data.to ?? data.target ?? 'sub-agent');
      state.status = `→ ${to}`;
      return;
    }
    case 'turn_ended': {
      // Each agent turn's output lands here. For sub-agents
      // (Researcher / Writer / Executor / etc.) that don't define an
      // outputType, `output` is the agent's plain-text reply — which
      // becomes the final answer when the orchestrator doesn't take
      // another turn (the "no_structured_output" path in
      // runConversation). For the Orchestrator itself, `output` is
      // the OrchestratorDecision JSON — extract `.summary` so we
      // surface the human-readable line, not raw JSON.
      if (event.role === 'system') return;
      const output = String(data.output ?? '');
      if (!output) return;
      try {
        const parsed = JSON.parse(output);
        if (parsed && typeof parsed === 'object' && typeof parsed.summary === 'string') {
          state.summary = parsed.summary;
          return;
        }
      } catch {
        /* not JSON — fall through */
      }
      state.summary = output;
      return;
    }
    case 'conversation_step': {
      const decision = (data.decision ?? null) as { summary?: string; reply?: string | null } | null;
      // Prefer reply (user-facing text) over summary (META log). Without
      // this, a step's META summary leaks into state.summary and survives
      // even when conversation_completed later carries a real reply.
      const stepText = decision?.reply && decision.reply.trim() ? decision.reply : decision?.summary;
      if (stepText) state.summary = stepText;
      const step = data.step ? `step ${String(data.step)}` : 'step';
      state.status = step;
      return;
    }
    case 'approval_requested': {
      const subject = String(data.subject ?? data.tool ?? 'action');
      // When the registry-side write succeeded, the event data carries
      // an apr-xxxx ID. Include it in the body so the user can
      // disambiguate when multiple sessions are paused on the same
      // channel ("Reply `approve apr-xy7q`"). Fall back to plain
      // "approve" when no ID is present (pre-migration sessions).
      const approvalId = typeof data.approvalId === 'string' ? data.approvalId : null;
      const replyHint = approvalId
        ? `Reply \`approve ${approvalId}\` (or \`reject ${approvalId}\`) to continue.`
        : 'Reply **approve** to continue or **reject** to cancel.';
      // Move the approval text into summary (which survives the
      // done=true render path) instead of status (which renderBody
      // hides when done). Without this the placeholder degrades to
      // "working…" forever — the user never sees what's pending.
      state.summary = `Approval required: ${subject}\n\n${replyHint}`;
      state.status = 'approval required';
      state.done = true;
      return;
    }
    case 'approval_resolved': {
      const decision = String(data.decision ?? 'resolved');
      state.status = decision === 'approved' ? 'approved — continuing' : 'rejected — stopping';
      return;
    }
    case 'run_resumed': {
      state.status = 'resuming';
      return;
    }
    case 'guardrail_tripped': {
      const name = String(data.name ?? 'guardrail');
      state.status = `⚠ ${name}`;
      return;
    }
    case 'awaiting_user_input': {
      const question = String(data.question ?? 'waiting for your reply');
      state.summary = question;
      state.status = 'awaiting reply';
      state.done = true;
      return;
    }
    case 'conversation_completed': {
      // Render priority: explicit `reply` (the user-facing message) over
      // `summary` (which loop.ts now also stuffs the reply into when
      // present, but defense-in-depth — if a producer somewhere forgets
      // the fallback, reading reply first still wins).
      const reply = typeof data.reply === 'string' && data.reply.trim() ? data.reply : '';
      const summary = reply
        ? reply
        : data.summary
          ? String(data.summary)
          : state.summary;
      if (summary) state.summary = summary;
      const reason = data.reason ? String(data.reason) : '';
      state.status = reason === 'abandoned_by_orchestrator' ? 'abandoned' : 'complete';
      state.done = true;
      return;
    }
    case 'run_failed': {
      const error = String(data.error ?? 'failed');
      state.summary = `Error: ${error}`;
      state.status = 'failed';
      state.done = true;
      return;
    }
    case 'conversation_limit_exceeded': {
      const reason = String(data.reason ?? 'limit');
      state.status = `stopped: ${reason}`;
      state.done = true;
      return;
    }
  }
}
