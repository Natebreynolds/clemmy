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
import pino from 'pino';
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
import {
  getActiveFocus as getActiveFocusForPrefix,
  createFocus as createFocusForPrefix,
  checkResourceMatchesFocus,
  extractResourceIdFromApprovalArgs,
} from '../memory/focus.js';
import * as approvalRegistry from '../runtime/harness/approval-registry.js';
import { previewToolCall } from '../runtime/approval-summary.js';
import { buildOrchestratorAgent } from '../agents/orchestrator.js';

const EDIT_DEBOUNCE_MS = 2_000;
const SAFETY_TIMEOUT_MS = 35 * 60_000;
const MAX_DISCORD_MESSAGE = 1_900;

// v0.5.19 F8 — after a Discord interaction token expires (at minute 15),
// the existing flush() returns silently because intermediate edits go
// nowhere. For 80+ tool-call runs that span >15 min, the user sees
// nothing until the very end. POST_EXPIRY_CHECKIN_MS spaces out
// "still working" follow-ups via sendFollowup so the user knows the
// bot didn't die. 5 minutes balances "I see progress" against
// "Discord channel noise."
export const POST_EXPIRY_CHECKIN_MS = 5 * 60_000;

/**
 * v0.5.19 F8 — exported predicate so the verify-long-running smoke
 * can exercise the throttle logic without spinning up the full Discord
 * harness closure. Returns true iff we should post a "still working"
 * follow-up RIGHT NOW. Knob `CLEMMY_DISCORD_POST_EXPIRY_CHECKINS=off`
 * forces false.
 */
export function shouldPostExpiryCheckIn(input: {
  tokenExpired: boolean;
  stateDone: boolean;
  lastCheckInAt: number;
  now: number;
  hasSendFollowup: boolean;
}): boolean {
  if (!input.tokenExpired) return false;
  if (input.stateDone) return false;
  if (!input.hasSendFollowup) return false;
  if ((process.env.CLEMMY_DISCORD_POST_EXPIRY_CHECKINS ?? 'on').toLowerCase() === 'off') return false;
  return input.now - input.lastCheckInAt >= POST_EXPIRY_CHECKIN_MS;
}

// Structured logger for Discord edit failures. The previous
// `catch { }` blocks at the edit sites swallowed errors silently —
// rate limits, token expiry (Discord interaction tokens die at 15
// min), network blips — all invisible to the dev + user. With this
// logger, every edit failure lands in ~/.clementine-next/logs/daemon.log
// so long-running workflows that go quiet on Discord can be
// diagnosed instead of guessed at. Pure observability — no behavior
// change.
const logger = pino({ name: 'clementine-next.discord-harness' });

/**
 * Discord interaction tokens issued at the start of a /command or
 * button interaction are valid for ~15 minutes. After that, calls to
 * the webhook (which is what `handle.edit()` ultimately hits) fail
 * with one of:
 *   - HTTP 401 "Invalid Webhook Token" (Discord error code 50027)
 *   - HTTP 404 "Unknown Webhook" (Discord error code 10015)
 *   - Discord.js DiscordAPIError with the same codes attached
 *
 * This helper recognizes all the shapes I've seen in the wild without
 * blindly trusting any single field. False positives are cheap (we
 * just stop trying to edit and use followups, which is the right
 * behavior for any persistent edit failure anyway). False negatives
 * mean we keep logging the same error every flush — annoying but not
 * broken, and the structured-logging shipped in v0.5.3 makes it
 * obvious in daemon.log when it happens.
 */
function isDiscordTokenExpired(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; status?: unknown; httpStatus?: unknown; message?: unknown };
  const codeNum = typeof e.code === 'number'
    ? e.code
    : typeof e.code === 'string' && /^\d+$/.test(e.code) ? parseInt(e.code, 10) : NaN;
  if (codeNum === 50027 || codeNum === 10015) return true;
  const status = typeof e.status === 'number' ? e.status : (typeof e.httpStatus === 'number' ? e.httpStatus : NaN);
  if (status === 401 || status === 404) return true;
  const msg = typeof e.message === 'string' ? e.message.toLowerCase() : '';
  return msg.includes('invalid webhook token')
    || msg.includes('unknown webhook')
    || msg.includes('interaction has expired')
    || msg.includes('interaction expired');
}

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
    // Older sessions did not populate the `channel` column, so keep
    // the metadata fallback to preserve continuity across upgrades.
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
 * Bumped 5 min → 30 min on 2026-05-24. The 5-minute default was set
 * for workflow-approval-era usage. Real chat conversations routinely
 * gap 5-15 minutes (bathroom, quick call, reading a long agent
 * reply). A 5:31-second gap fragmented one coherent "score the leads
 * via firecrawl to fill the Keep/Drop dropdowns" thread into 5
 * separate harness sessions, with the last message ("first 10 please")
 * arriving in a fresh session that had no idea what "first 10" meant.
 * 30 min is wide enough to absorb normal interruptions, tight enough
 * that "this morning's conversation" doesn't bleed into "this evening's
 * unrelated topic."
 */
const STALE_SESSION_MS = 30 * 60 * 1000;

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
    channel: 'discord',
    userId: opts.userId,
    title: opts.prompt.length > 60 ? `${opts.prompt.slice(0, 57)}...` : opts.prompt,
    metadata: {
      source: 'discord',
      channelId: opts.channelId,
      userId: opts.userId,
      guildId: opts.guildId,
    },
  });
  channelSessions.set(opts.channelId, { sessionId: session.id, lastUsedAt: now });

  // Cross-session prefix: a fresh session created within the
  // CROSS_SESSION_PREFIX_WINDOW of a prior same-channel session gets
  // a synthetic system event prepended with the prior session's last
  // user message + agent reply. Without this, session_history returns
  // empty on turn 1 of the new session and the agent can't interpret
  // back-references like "first 10 please" against the prior plan.
  // (Observed 2026-05-24: 5:31s gap fragmented one coherent scoring
  // conversation; the new session asked for clarification on something
  // the prior session had already specified — 25/batch via firecrawl.)
  try {
    seedCrossSessionPrefix(session.id, opts.channelId, now);
  } catch (err) {
    logger.warn({ err: err instanceof Error ? err.message : String(err), channelId: opts.channelId }, 'cross-session prefix seed failed (non-fatal)');
  }

  return { id: session.id, isContinuation: false };
}

const CROSS_SESSION_PREFIX_WINDOW_MS = 2 * 60 * 60 * 1000; // 2 hours

// Generous lookback so multi-turn back-references ("first 10 please" →
// referring to a 25/batch decision made 2 turns ago) carry across the
// session boundary. The user's principle: missing context is fatal,
// extra context is fine. Pulls from the most recent N prior sessions
// (not just the immediately previous one) so a workflow that spanned
// e.g. five 5-minute sessions still surfaces its full arc.
const PREFIX_LOOKBACK_SESSIONS = 4;
const PREFIX_MAX_TURNS_PER_SESSION = 6;

interface PriorTurn { who: 'user' | 'assistant'; text: string; at: string }

function seedCrossSessionPrefix(newSessionId: string, channelId: string, now: number): void {
  const db = openEventLog();
  // Find the most recent N prior sessions for this channel (exclude
  // the newly-created one). We walk multiple sessions because the
  // arc may have been fragmented across several short sessions
  // before STALE_SESSION_MS got bumped — and a "first 10" back-ref
  // can land 30+ minutes after the planning turn it points to.
  const priorRows = db.prepare(
    `SELECT id, updated_at FROM sessions
       WHERE channel = 'discord'
         AND id != ?
         AND json_extract(metadata_json, '$.channelId') = ?
       ORDER BY updated_at DESC
       LIMIT ?`,
  ).all(newSessionId, channelId, PREFIX_LOOKBACK_SESSIONS) as Array<{ id: string; updated_at: string }>;
  if (priorRows.length === 0) return;

  // Filter to those still inside the prefix window.
  const inWindow = priorRows.filter((r) => {
    const ms = Date.parse(r.updated_at);
    return Number.isFinite(ms) && now - ms <= CROSS_SESSION_PREFIX_WINDOW_MS;
  });
  if (inWindow.length === 0) return;

  // Pull recent turns from each in-window session, oldest sessions
  // first so the resulting text reads chronologically.
  const sectionBlocks: string[] = [];
  let totalChars = 0;
  const MAX_TOTAL_CHARS = 8_000; // generous, but bounded
  for (const session of inWindow.slice().reverse()) {
    const turns = pullRecentTurnsForSession(db, session.id, PREFIX_MAX_TURNS_PER_SESSION);
    if (turns.length === 0) continue;
    const elapsedMin = Math.round((now - Date.parse(session.updated_at)) / 60_000);
    const lines = [`--- Prior session ${session.id} (ended ~${elapsedMin} min ago) ---`];
    for (const turn of turns) {
      const label = turn.who === 'user' ? 'USER' : 'YOU';
      const trimmed = turn.text.length > 800 ? turn.text.slice(0, 800) + '…' : turn.text;
      lines.push(`  ${label}: ${trimmed}`);
    }
    const block = lines.join('\n');
    if (totalChars + block.length > MAX_TOTAL_CHARS) break;
    sectionBlocks.push(block);
    totalChars += block.length;
  }
  if (sectionBlocks.length === 0) return;

  // Surface active focus state too — if a focus is pinned, the new
  // session should treat it as authoritative context.
  let focusBlock = '';
  try {
    let active = getActiveFocusForPrefix();
    // Auto-pin a focus when (a) no active focus exists, AND (b) the
    // prior sessions had a clear "currently working on" resource we
    // can extract from their tool calls. This is the automation that
    // prevents the "agent re-discovers and picks the WRONG sheet"
    // failure mode (sess-mpjbmoez 2026-05-24): without a focus
    // anchor, memory_recall surfaced a similarly-named workflow
    // SKILL.md whose sheet_id was different from the one the user
    // had actually been editing across 5 prior sessions.
    if (!active) {
      const autoPinned = autoPinFocusFromPriorSessions(db, inWindow.map((r) => r.id));
      if (autoPinned) {
        active = autoPinned;
      }
    }
    if (active) {
      focusBlock = `Active focus (cross-channel): #${active.id} "${active.title}" — ${active.summary}\nResource: ${active.resource_ref}`;
    }
  } catch { /* ignore */ }

  const headerLines = [
    '[CONTINUATION CONTEXT — the user\'s message in this fresh session likely refers back to the recent conversation thread below. Treat this as authoritative context; do NOT ask the user to repeat decisions already made.]',
  ];
  if (focusBlock) headerLines.push('', focusBlock);

  appendHarnessEvent({
    sessionId: newSessionId,
    turn: 0,
    role: 'system',
    type: 'cross_session_prefix',
    data: {
      priorSessionIds: inWindow.map((r) => r.id),
      sessionsIncluded: sectionBlocks.length,
      totalChars,
      text: [
        ...headerLines,
        '',
        ...sectionBlocks,
        '',
        '[End of continuation context. The user\'s next message follows.]',
      ].join('\n'),
    },
  });
}

/**
 * Heuristic auto-pin: scan the most recent prior-session events for
 * a stable resource reference (Google Sheets id, Google Doc id, full
 * URL). If found, pin it as the active focus so the new session
 * inherits a hard anchor — the agent's resource-fingerprint check
 * has something concrete to compare future tool calls against.
 *
 * Conservative: only fires when no active focus exists AND the prior
 * session produced ≥ 2 composio_execute_tool calls against the same
 * resource (signal that it was real work, not exploratory peeking).
 * Returns the newly-created focus row, or null when nothing pinnable.
 */
function autoPinFocusFromPriorSessions(
  db: ReturnType<typeof openEventLog>,
  priorSessionIds: string[],
): ReturnType<typeof getActiveFocusForPrefix> | null {
  if (priorSessionIds.length === 0) return null;
  const counts = new Map<string, { kind: string; count: number; sessionId: string }>();

  for (const sid of priorSessionIds) {
    const rows = db.prepare(
      `SELECT data_json FROM events
         WHERE session_id = ? AND type = 'tool_called'
         ORDER BY seq DESC LIMIT 30`,
    ).all(sid) as Array<{ data_json: string }>;
    for (const row of rows) {
      try {
        const data = JSON.parse(row.data_json) as { tool?: string; arguments?: string };
        if (data.tool !== 'composio_execute_tool' || typeof data.arguments !== 'string') continue;
        const inner = JSON.parse(data.arguments) as { tool_slug?: string; arguments?: string };
        const slug = inner.tool_slug ?? '';
        const argText = typeof inner.arguments === 'string' ? inner.arguments : JSON.stringify(inner.arguments ?? {});
        // Google Sheets / Docs id pattern: long alphanumeric + dashes/underscores.
        const sheetMatch = argText.match(/"spreadsheet_id"\s*:\s*"([A-Za-z0-9_-]{20,})"/);
        const docMatch = argText.match(/"document_id"\s*:\s*"([A-Za-z0-9_-]{20,})"/);
        const id = sheetMatch?.[1] ?? docMatch?.[1] ?? null;
        if (!id) continue;
        const kind = slug.toLowerCase().startsWith('googlesheets') ? 'sheet'
          : slug.toLowerCase().startsWith('googledocs') ? 'doc'
          : 'resource';
        const ref = kind === 'sheet'
          ? `https://docs.google.com/spreadsheets/d/${id}`
          : kind === 'doc'
            ? `https://docs.google.com/document/d/${id}`
            : id;
        const existing = counts.get(ref);
        if (existing) {
          existing.count += 1;
        } else {
          counts.set(ref, { kind, count: 1, sessionId: sid });
        }
      } catch { /* skip */ }
    }
  }

  // Need at least 2 hits on the same resource for it to count as
  // "real work" worth auto-pinning. Picks the most-mentioned resource.
  let best: { ref: string; kind: string; count: number; sessionId: string } | null = null;
  for (const [ref, info] of counts.entries()) {
    if (info.count < 2) continue;
    if (!best || info.count > best.count) best = { ref, ...info };
  }
  if (!best) return null;

  // Derive a title from the prior session's session title (which is
  // the first ~60 chars of the user's first prompt) and a summary
  // from the prior session's last conversation_completed summary.
  const sessionRow = db.prepare(
    `SELECT title FROM sessions WHERE id = ?`,
  ).get(best.sessionId) as { title?: string } | undefined;
  const lastSummaryRow = db.prepare(
    `SELECT data_json FROM events
       WHERE session_id = ? AND type = 'conversation_completed'
       ORDER BY seq DESC LIMIT 1`,
  ).get(best.sessionId) as { data_json?: string } | undefined;
  let lastSummary = '';
  try { lastSummary = String(JSON.parse(lastSummaryRow?.data_json ?? '{}')?.summary ?? '').slice(0, 300); } catch { /* ignore */ }

  const title = (sessionRow?.title ?? `Work on ${best.kind}`).slice(0, 100);
  const summary = lastSummary
    || `Continuing work on this ${best.kind} from a prior session — auto-pinned because no focus was set.`;

  try {
    return createFocusForPrefix({
      resourceRef: best.ref,
      title: `${title}`,
      summary,
      resourceKind: best.kind,
      relatedSessionId: best.sessionId,
    });
  } catch {
    return null;
  }
}

function pullRecentTurnsForSession(db: ReturnType<typeof openEventLog>, sessionId: string, maxTurns: number): PriorTurn[] {
  // Read the last 2*maxTurns events (user inputs + agent completions)
  // so we have headroom to filter and reorder chronologically.
  const rows = db.prepare(
    `SELECT type, data_json, created_at FROM events
       WHERE session_id = ?
         AND type IN ('user_input_received', 'conversation_completed')
       ORDER BY seq DESC
       LIMIT ?`,
  ).all(sessionId, maxTurns * 2) as Array<{ type: string; data_json: string; created_at: string }>;
  const turns: PriorTurn[] = [];
  for (const row of rows) {
    try {
      const data = JSON.parse(row.data_json) as { text?: string; summary?: string; reply?: string };
      if (row.type === 'user_input_received' && typeof data.text === 'string') {
        turns.push({ who: 'user', text: data.text, at: row.created_at });
      } else if (row.type === 'conversation_completed') {
        // Prefer the user-facing summary (already trimmed); fall back
        // to the reply field if summary is missing.
        const text = typeof data.summary === 'string' && data.summary
          ? data.summary
          : (typeof data.reply === 'string' ? data.reply : '');
        if (text) turns.push({ who: 'assistant', text, at: row.created_at });
      }
    } catch { /* skip malformed rows */ }
  }
  // Newest last (chronological); cap to maxTurns of each kind.
  turns.reverse();
  return turns.slice(-maxTurns * 2);
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

function isDiscordApproval(row: approvalRegistry.PendingApprovalRow): boolean {
  return row.channel === 'discord' || row.channel === 'discord-dm';
}

function approvalBelongsToDiscordChannel(
  row: approvalRegistry.PendingApprovalRow,
  channelId: string,
): boolean {
  if (!isDiscordApproval(row)) return false;
  if (!approvalRegistry.isActionable(row)) return false;
  if (row.channelId) return row.channelId === channelId;

  // Legacy rows created before channel_id was populated may still be
  // valid, but only if they are the currently-hydrated paused session
  // for this channel. This keeps pre-migration approvals usable
  // without letting old approvals from another Discord thread bleed in.
  const entry = getOrHydrateChannelSession(channelId);
  return entry?.sessionId === row.sessionId;
}

function pendingDiscordApprovalsForChannel(channelId: string): approvalRegistry.PendingApprovalRow[] {
  return approvalRegistry
    .listPending({ status: 'pending' })
    .filter((row) => approvalBelongsToDiscordChannel(row, channelId));
}

export const __test__ = {
  approvalBelongsToDiscordChannel,
  isDiscordTokenExpired,
};

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
  const intent = parseApprovalIntent(opts.prompt);
  if (!intent) return false;
  // T-WF-1 addendum: when the user types `approve apr-xxxx`, the
  // approval may belong to a WORKFLOW session that isn't bound to
  // their current Discord channel (workflow sessions have channel
  // 'workflow', not the Discord channel id). The legacy gate
  // `isChannelSessionAwaitingApproval` returns false in that case
  // and the message falls through to a fresh turn — leaving the
  // workflow's polling loop never seeing the resolution.
  //
  // If the user supplied an approval ID AND the registry has it
  // pending, either resume the paused Discord session (interactive
  // harness chat) or resolve it directly (workflow/cron-style harness
  // sessions that are waiting in a polling loop).
  if (intent.approvalId) {
    const row = approvalRegistry.get(intent.approvalId);
    if (row && row.status === 'pending') {
      if (approvalRegistry.isExpired(row)) {
        approvalRegistry.resolve(row.approvalId, 'expired', 'discord-user');
        await opts.transport.sendError(`Approval \`${row.approvalId}\` has expired. Re-ask and I'll redo that work.`);
        return true;
      }
      const canResumeInDiscord = approvalBelongsToDiscordChannel(row, opts.channelId);
      if (canResumeInDiscord && isChannelSessionAwaitingApproval(opts.channelId)) {
        await runDiscordHarnessResume({
          channelId: opts.channelId,
          decision: intent.decision,
          approvalId: intent.approvalId,
          transport: opts.transport,
        });
        return true;
      }

      if (isDiscordApproval(row)) {
        await opts.transport.sendError(`Approval \`${row.approvalId}\` belongs to a different or stale Discord conversation.`);
        return true;
      }

      const resolution = intent.decision === 'approve' ? 'approved' : 'rejected';
      const result = approvalRegistry.resolve(row.approvalId, resolution, 'discord-user');
      try {
        await opts.transport.sendInitial(
          result.ok
            ? `🍊 ${resolution === 'approved' ? 'approved' : 'rejected'} \`${row.approvalId}\` — ${row.subject}`
            : `Couldn't resolve \`${row.approvalId}\`: ${result.reason ?? 'unknown'}`,
        );
      } catch { /* transport is best-effort */ }
      return true;
    }
  }
  if (!isChannelSessionAwaitingApproval(opts.channelId)) return false;
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
  edit(content: string, options?: { components?: unknown[] }): Promise<void>;
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
  // When an approval_requested event fires, we stash the approvalId
  // here. The next flush attaches Approve/Reject buttons to the
  // message so the user clicks instead of typing "approve apr-xxxx".
  // Cleared on approval_resolved / awaiting_user_input / completion.
  pendingApprovalId?: string;
  // Wall-clock when the turn started, in ms. Set on the first
  // turn_started event. renderBody uses this to show an elapsed-time
  // counter so the user can tell "still working at 4m 12s" vs
  // "nothing happening." The heartbeat ticker also reads this so it
  // can decide whether to push a "still working" pulse.
  turnStartedAt?: number;
  // v0.5.10 auto-compact: percent of input budget the most recent
  // condenser_applied event reported. Used to render a small `[ctx
  // 42%]` footer so the user sees the context filling up before it
  // explodes. Only shown when > 30%.
  contextPct?: number;
}

/**
 * Build Discord button components for a pending approval, or null when
 * the state has no active approval. The components encode the same
 * custom-id format that the desktop's `buildApprovalActions` uses, so
 * the existing button interaction handler in discord.ts resolves the
 * apr-xxxx id and triggers `runDiscordHarnessResume`.
 */
function approvalComponentsForState(state: DisplayState): unknown[] | null {
  if (!state.pendingApprovalId) return null;
  const id = state.pendingApprovalId;
  return [
    {
      type: 1, // ActionRow
      components: [
        { type: 2 /* Button */, style: 3 /* Success */, label: 'Approve', custom_id: `clementine:approve:${id}` },
        // Edit opens a Discord modal pre-filled with the tool's args
        // JSON. User can change time, recipient, content, etc. before
        // approving. Cheaper than reject + ask the agent to retry.
        { type: 2, style: 1 /* Primary */, label: 'Edit', custom_id: `clementine:edit:${id}` },
        { type: 2, style: 4 /* Danger */, label: 'Reject', custom_id: `clementine:reject:${id}` },
      ],
    },
  ];
}

function renderBody(state: DisplayState): string {
  // Done states (final reply / approval / awaiting input) show ONLY
  // the summary — no progress noise. The summary already carries the
  // user-facing message, the approval prompt, or the awaiting-input
  // question.
  if (state.done) {
    const body = state.summary || '_done._';
    return body.length > MAX_DISCORD_MESSAGE ? body.slice(0, MAX_DISCORD_MESSAGE - 1) + '…' : body;
  }
  // In-progress: a short status line PLUS an elapsed-time counter so
  // the user can tell "still working at 4m 12s" vs "nothing
  // happening." Tool count is included once 3+ tools have fired —
  // signals real progress, not churn. Still no full tool-call
  // history — that read as "the agent is confused" in earlier UX.
  const verb = state.currentAgent ? `${state.currentAgent} · ${state.status || 'working…'}` : (state.status || 'working…');
  const elapsed = formatElapsedMs(state.turnStartedAt ? Date.now() - state.turnStartedAt : 0);
  const counter = state.toolCount >= 3 ? ` · ${state.toolCount} tools` : '';
  // Context-window footer: surfaces when auto-compact has reported the
  // session at >30% of input budget. Lets the user see the meter climb
  // and decide to /new before Layer 3 forks.
  const ctx = typeof state.contextPct === 'number' && state.contextPct > 30
    ? ` · ctx ${Math.min(99, Math.round(state.contextPct))}%`
    : '';
  const body = elapsed
    ? `_${verb} · ${elapsed}${counter}${ctx}_`
    : `_${verb}${counter}${ctx}_`;
  return body.length > MAX_DISCORD_MESSAGE ? body.slice(0, MAX_DISCORD_MESSAGE - 1) + '…' : body;
}

/** Human-friendly "Ns" / "Nm Ms" / "Nh Mm" elapsed time. Returns
 *  empty for sub-5-second runs so brand-new turns don't blink "1s"
 *  on the very first flush. */
function formatElapsedMs(ms: number): string {
  if (!Number.isFinite(ms) || ms < 5_000) return '';
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  const hr = Math.floor(min / 60);
  return `${hr}h ${min % 60}m`;
}

/**
 * Translate raw harness/SDK error strings into user-facing copy that
 * names the cause AND the fix. The default `run_failed.error` field
 * carries the raw exception message ("Failed to run function tools:
 * ToolCallsLimitExceeded..."), which tells the user nothing they can
 * act on. Each case-match here turns one of those into plain English
 * with the next step the user can actually take.
 */
function humanizeRunFailure(error: string): string {
  const lower = error.toLowerCase();
  if (lower.includes('toolcallslimitexceeded') || lower.includes('tool calls per turn exceeded')) {
    const m = error.match(/limit of (\d+)/i);
    const limit = m ? m[1] : 'the current';
    return [
      `🍊 I hit the per-turn tool budget (${limit} tool calls in one turn) and stopped before finishing.`,
      '',
      'This usually means I was doing more discovery / file reads than I should have. The single-agent shape lets one turn fan out to 30+ calls for real work, so the default ceiling has been raised — try the request again and I should fit comfortably.',
      '',
      'If it keeps happening on the same prompt, you can raise the limit further via the dashboard (Settings → Harness Budget → "Long workflow" preset, or set `HARNESS_TOOL_CALLS_PER_TURN=80` in `~/.clementine-next/.env`).',
    ].join('\n');
  }
  if (lower.includes('maxturnsexceeded') || lower.includes('max_turns')) {
    return [
      '🍊 I hit the max-turns ceiling for this conversation and stopped.',
      '',
      'That usually means the work is too large for a single chat turn. Either narrow the scope ("just do step 1"), or switch the budget preset to "Long workflow" (Settings → Harness Budget).',
    ].join('\n');
  }
  if (lower.includes('boundary') && lower.includes('codex')) {
    return `🍊 The model boundary errored mid-turn:\n\n${error}\n\nRetry the same prompt — if it keeps happening, share the supervisor log.`;
  }
  if (lower.includes('timeout') || lower.includes('aborted')) {
    return `🍊 A tool timed out. Raw error:\n\n${error}\n\nUsually a slow external API. Try once more, or skip the failing step and continue.`;
  }
  if (lower.includes('unauthorized') || lower.includes('401')) {
    return `🍊 Got an auth failure mid-turn:\n\n${error}\n\nCheck the integration on the failing toolkit (Settings → Credentials) and reconnect if expired.`;
  }
  // Fallback: keep the raw error but frame it so the user knows it's
  // an honest failure, not a fabricated past-tense lie.
  return `🍊 The run hit an error and stopped:\n\n${error}\n\nRe-send your request to retry; share this message if it persists.`;
}

function humanHarnessText(value: unknown, fallback = ''): string {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') {
    const obj = value as { reply?: unknown; summary?: unknown };
    const reply = typeof obj.reply === 'string' ? obj.reply.trim() : '';
    const summary = typeof obj.summary === 'string' ? obj.summary.trim() : '';
    return reply || summary || fallback;
  }
  const text = String(value).trim();
  if (!text) return fallback;
  if ((text.startsWith('{') && text.endsWith('}')) || (text.startsWith('[') && text.endsWith(']'))) {
    try {
      const parsed = JSON.parse(text) as { reply?: unknown; summary?: unknown } | null;
      if (parsed && typeof parsed === 'object') {
        const reply = typeof parsed.reply === 'string' ? parsed.reply.trim() : '';
        const summary = typeof parsed.summary === 'string' ? parsed.summary.trim() : '';
        if (reply || summary) return reply || summary;
      }
    } catch {
      // Not JSON after all; use the raw text below.
    }
  }
  return text;
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
  // Track which approval the LAST flush attached buttons for, so a
  // subsequent flush after the approval resolves (or a new approval
  // arrives) clears/replaces them — passing components:[] drops them.
  let lastAttachedApprovalId: string | undefined;
  // Discord interaction tokens expire 15 min after the initial
  // interaction. Past that, `handle.edit()` throws (401 Invalid Webhook
  // Token / 10015 Unknown Webhook). Without the fallback below, a
  // multi-hour workflow would go SILENT on Discord after minute 15 —
  // intermediate progress disappears, the final reply never arrives,
  // and the user has no idea anything's still running. With this flag
  // set, intermediate progress edits go quietly (no spam — the user
  // wouldn't see them anyway since the token's gone) and the final
  // reply routes through transport.sendFollowup so the user DOES see
  // the answer as a fresh message in the same channel.
  let tokenExpired = false;
  // v0.5.19 F8 — track the last post-expiry "still working" follow-up
  // so we can throttle to one per POST_EXPIRY_CHECKIN_MS window.
  let lastExpiryCheckInAt = 0;

  const flush = async (): Promise<void> => {
    pendingEdit = null;
    lastEditAt = Date.now();
    // If the interaction token already expired, intermediate progress
    // edits are silently dropped — the user wouldn't see them. But
    // v0.5.19 F8 keeps the user informed by posting one "still working"
    // follow-up per POST_EXPIRY_CHECKIN_MS window so an 80-call run
    // doesn't go dark past minute 15. Revert via
    // CLEMMY_DISCORD_POST_EXPIRY_CHECKINS=off.
    if (tokenExpired) {
      if (shouldPostExpiryCheckIn({
        tokenExpired,
        stateDone: state.done,
        lastCheckInAt: lastExpiryCheckInAt,
        now: Date.now(),
        hasSendFollowup: !!transport.sendFollowup,
      })) {
        lastExpiryCheckInAt = Date.now();
        const tools = state.toolCount ?? 0;
        const headline = `🍊 still working on this (${tools} tool${tools === 1 ? '' : 's'} so far)…`;
        try {
          await transport.sendFollowup!(headline);
        } catch (err) {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err), sessionId: session.id, stage: 'expiry-checkin' },
            'discord post-expiry check-in failed',
          );
        }
      }
      return;
    }
    try {
      const components = approvalComponentsForState(state);
      const needsUpdate = state.pendingApprovalId !== lastAttachedApprovalId;
      if (components || needsUpdate) {
        // Pass components (or an empty array when we need to clear
        // previously-attached buttons).
        await handle.edit(renderBody(state), { components: components ?? [] });
        lastAttachedApprovalId = state.pendingApprovalId;
      } else {
        await handle.edit(renderBody(state));
      }
    } catch (err) {
      // Discord can transiently refuse edits (network blip, rate
      // limit, or — at minute 15+ — interaction-token expiry). The
      // next event will retry; nothing fatal. Log so long-workflow
      // failures are diagnosable instead of silent.
      if (isDiscordTokenExpired(err)) {
        tokenExpired = true;
        logger.warn(
          { sessionId: session.id, stage: 'flush-token-expired' },
          'discord interaction token expired — switching to sendFollowup for final reply',
        );
        return;
      }
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), sessionId: session.id, stage: 'flush' },
        'discord edit failed',
      );
    }
  };

  /**
   * Final flush on conversation completion. Unlike progress edits,
   * this one preserves the full reply: if the body exceeds Discord's
   * per-message cap, post the head into the existing message and the
   * tail as follow-up messages. The user sees the whole answer
   * instead of the previous `…obje…` truncation marker.
   *
   * Approval pauses are weird: the harness's approval_requested handler
   * sets state.done=true so the subscriber unsubscribes (the turn is
   * "done" from the harness POV — control belongs to the human now).
   * But that means we hit finalFlush instead of the regular flush, and
   * without attaching components here the Approve/Edit/Reject buttons
   * never render on the message — leaving the user with text-only
   * "approve apr-xxx" fallback (seen 2026-05-21 on workflow_schedule).
   * Attach them in finalFlush too when state still carries an approval.
   */
  const finalFlush = async (): Promise<void> => {
    pendingEdit = null;
    lastEditAt = Date.now();
    const fullBody = renderFullBody(state);
    const chunks = splitForLongReply(fullBody);
    const components = approvalComponentsForState(state);
    const needsComponentUpdate = state.pendingApprovalId !== lastAttachedApprovalId || !!components;

    // Token-expired path: skip handle.edit entirely and route the full
    // reply through sendFollowup as a fresh message in the channel.
    // Without this, runs that exceed 15 minutes go dark — the user
    // never sees the result.
    if (tokenExpired) {
      if (transport.sendFollowup) {
        try {
          for (const chunk of chunks) {
            await transport.sendFollowup(chunk);
          }
        } catch (err) {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err), sessionId: session.id, stage: 'finalFlush-postExpiry' },
            'discord final followup failed after token expiry',
          );
        }
      }
      return;
    }

    try {
      if (needsComponentUpdate) {
        await handle.edit(chunks[0] ?? '_working…_', { components: components ?? [] });
        lastAttachedApprovalId = state.pendingApprovalId;
      } else {
        await handle.edit(chunks[0] ?? '_working…_');
      }
      if (chunks.length > 1 && transport.sendFollowup) {
        for (let i = 1; i < chunks.length; i++) {
          await transport.sendFollowup(chunks[i]);
        }
      }
    } catch (err) {
      // Token expired DURING the final flush (run was just at the 15-min
      // boundary). Try the whole thing via followup so the user still
      // gets the answer.
      if (isDiscordTokenExpired(err)) {
        tokenExpired = true;
        logger.warn(
          { sessionId: session.id, stage: 'finalFlush-token-expired' },
          'discord interaction token expired during final flush — falling back to sendFollowup',
        );
        if (transport.sendFollowup) {
          try {
            for (const chunk of chunks) {
              await transport.sendFollowup(chunk);
            }
          } catch (followupErr) {
            logger.warn(
              { err: followupErr instanceof Error ? followupErr.message : String(followupErr), sessionId: session.id, stage: 'finalFlush-fallback' },
              'discord followup fallback after token expiry also failed',
            );
          }
        }
        return;
      }
      // Edit can transiently fail. Don't crash settle — the user can
      // re-ping if they don't see the full reply. Log so long-workflow
      // settle failures are diagnosable instead of silent.
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), sessionId: session.id, stage: 'finalFlush' },
        'discord final edit failed',
      );
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

  // "Still working" pulse: every PROGRESS_PULSE_MS while the run is
  // active, force a flush so the elapsed-time counter in renderBody
  // ticks forward — even if no harness.event fires during that
  // window. Without this, a tool that takes 90 seconds (e.g. the
  // 84-second `draft_plan` we saw in sess-mpg7ue2d) leaves the
  // Discord message frozen at its old timestamp, indistinguishable
  // from a stuck run.
  //
  // Suppressed when:
  //   - state.done (approval pause, awaiting input, completed) — the
  //     message is already terminal; no pulse needed
  //   - tokenExpired — Discord won't accept the edit anyway; the
  //     followup-on-finalFlush path delivers the final answer
  //
  // The pulse goes through scheduleEdit, which already debounces +
  // rate-limits, so EDIT_DEBOUNCE_MS still protects against burst
  // edits if a real event fires right before a pulse tick.
  const PROGRESS_PULSE_MS = 30_000;
  let progressPulse: NodeJS.Timeout | null = setInterval(() => {
    if (state.done) return;
    if (tokenExpired) return;
    if (!state.turnStartedAt) return;
    scheduleEdit();
  }, PROGRESS_PULSE_MS);
  progressPulse?.unref?.();

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
      if (progressPulse) {
        clearInterval(progressPulse);
        progressPulse = null;
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
    if (approvalRegistry.isExpired(row)) {
      approvalRegistry.resolve(row.approvalId, 'expired', 'discord-user');
      await transport.sendError(`Approval \`${approvalId}\` has expired. Re-ask and I'll redo that work.`);
      return;
    }
    if (!approvalBelongsToDiscordChannel(row, channelId)) {
      // Cross-channel approvals are intentionally blocked for Discord
      // sessions. Workflow approvals are resolved by
      // tryHandleHarnessApprovalReply before this resume helper runs.
      await transport.sendError(`Approval \`${approvalId}\` belongs to a different or stale Discord conversation.`);
      return;
    }
    sessionId = row.sessionId;
  } else {
    const pendingOnChannel = pendingDiscordApprovalsForChannel(channelId);
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
        edit(opts: { content: string; components?: unknown[] }): Promise<unknown>;
      };
      return {
        edit: async (next, options) => {
          const payload: { content: string; components?: unknown[] } = { content: next };
          if (options && Array.isArray(options.components)) {
            payload.components = options.components;
          }
          await reply.edit(payload);
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
      if (!state.turnStartedAt) state.turnStartedAt = Date.now();
      return;
    }
    case 'tool_called': {
      const tool = String(data.tool ?? data.name ?? 'tool');
      // Richer status line: "running: pwd && ls -la" vs the bare
      // "using run_shell_command". During a skill execution the agent
      // can fire 7 sequential shell commands and "using
      // run_shell_command" 7 times in a row gives the Discord viewer
      // zero info. previewToolCall pulls the meaningful field from
      // the args (command for shell, slug for composio, path for
      // write_file) and renders one short label. When the helper
      // can't extract anything useful, it returns the bare tool name
      // — in that fallback case we still prepend "using " so the
      // user reads it as an in-progress action instead of a noun.
      const preview = previewToolCall(tool, data.arguments);
      state.status = preview === tool ? `using ${tool}` : preview;
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
      state.summary = humanHarnessText(output, output);
      return;
    }
    case 'conversation_step': {
      const decision = (data.decision ?? null) as { summary?: string; reply?: string | null } | null;
      // Prefer reply (user-facing text) over summary (META log). Without
      // this, a step's META summary leaks into state.summary and survives
      // even when conversation_completed later carries a real reply.
      const stepText = humanHarnessText(decision?.reply && decision.reply.trim() ? decision.reply : decision?.summary);
      if (stepText) state.summary = stepText;
      const step = data.step ? `step ${String(data.step)}` : 'step';
      state.status = step;
      return;
    }
    case 'approval_requested': {
      const subject = String(data.subject ?? data.tool ?? 'action');
      const approvalId = typeof data.approvalId === 'string' ? data.approvalId : null;
      // Stash the approval id so the next flush attaches Approve/Reject
      // buttons (rendered server-side by the Discord transport via the
      // standard buildApprovalActions helper). Text fallback stays in
      // the body for clients that ignore components or for users who
      // prefer to type — never required.
      if (approvalId) state.pendingApprovalId = approvalId;

      // Resource-fingerprint warning: if the approval's args mention a
      // resource id that DOESN'T match the active focus, surface a
      // visible warning so the user can catch a wrong-sheet mutation
      // before approving. Catches the failure mode from sess-mpjbmoez
      // (2026-05-24) where the agent updated the wrong Google Sheet.
      let mismatchWarning = '';
      try {
        const resourceId = extractResourceIdFromApprovalArgs(data.args);
        const fp = checkResourceMatchesFocus(resourceId);
        if (fp.result === 'mismatch') {
          mismatchWarning = `\n\n⚠ **RESOURCE MISMATCH** — this would act on \`${resourceId}\`, but your active focus is **${fp.focusTitle}** (\`${fp.focusRef}\`). Verify before approving.`;
        }
      } catch { /* graceful */ }

      const replyHint = approvalId
        ? `Tap **Approve** or **Reject** below — or type \`approve ${approvalId}\` / \`reject ${approvalId}\` if you prefer.`
        : 'Tap a button below — or reply **approve** / **reject**.';
      state.summary = `Approval required: ${subject}${mismatchWarning}\n\n${replyHint}`;
      state.status = 'approval required';
      state.done = true;
      return;
    }
    case 'approval_resolved': {
      const decision = String(data.decision ?? 'resolved');
      state.status = decision === 'approved' ? 'approved — continuing' : 'rejected — stopping';
      // Buttons are no longer relevant; clear so the next flush drops them.
      state.pendingApprovalId = undefined;
      return;
    }
    case 'condenser_applied': {
      // v0.5.10 — surface the post-compaction context fill so the user
      // sees the meter, not just the result. afterTokens is the most
      // recent post-Layer-1 (and post-Layer-2 if applied) estimate.
      const after = Number(data.afterTokens);
      const budget = Number(data.budgetTokens);
      if (Number.isFinite(after) && Number.isFinite(budget) && budget > 0) {
        state.contextPct = Math.max(0, Math.min(100, (after / budget) * 100));
      }
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
      const summary = humanHarnessText(reply || data.summary, state.summary);
      if (summary) state.summary = summary;
      const reason = data.reason ? String(data.reason) : '';
      state.status =
        reason === 'abandoned_by_orchestrator'
          ? 'abandoned'
          : reason === 'sub_agent_stalled'
            ? 'stalled'
            : 'complete';
      state.done = true;
      return;
    }
    case 'run_failed': {
      const error = String(data.error ?? 'failed');
      // Translate cryptic SDK / harness errors into plain English with
      // an actionable next step. The default "Failed to run function
      // tools: ToolCallsLimitExceeded" tells the user nothing they can
      // act on; this case-matches common failure shapes and rewrites
      // them into user-facing copy that names the cause and the fix.
      state.summary = humanizeRunFailure(error);
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
