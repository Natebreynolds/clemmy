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

function resolveOrCreateSession(opts: {
  channelId: string;
  userId: string;
  guildId: string | null;
  prompt: string;
}): { id: string; isContinuation: boolean } {
  const now = Date.now();
  const existing = getOrHydrateChannelSession(opts.channelId);
  if (existing) {
    existing.lastUsedAt = now;
    return { id: existing.sessionId, isContinuation: true };
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
 * Detect approve / reject intent in a Discord prompt. Conservative —
 * only matches at the start of the message and only when a session
 * is actually awaiting approval. "Yes" mid-conversation when nothing
 * is pending should be treated as a regular new turn, not an approval.
 */
export function parseApprovalIntent(prompt: string): 'approve' | 'reject' | null {
  const t = prompt.trim().toLowerCase();
  if (!t) return null;
  if (/^(approve(d)?|yes|y|go( ahead)?|proceed|ok|okay|lgtm|sounds good|do it|👍)\b/.test(t)) {
    return 'approve';
  }
  if (/^(reject(ed)?|no|n|cancel|stop|abort|nevermind|never mind|don'?t|👎)\b/.test(t)) {
    return 'reject';
  }
  return null;
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
    decision: intent,
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
}

export interface DiscordHarnessReplyHandle {
  edit(content: string): Promise<void>;
}

interface DisplayState {
  summary: string;
  status: string;
  done: boolean;
}

function renderBody(state: DisplayState): string {
  const head = state.summary ? `> ${state.summary}\n\n` : '';
  const status = state.done ? '' : `_${state.status}_`;
  const body = (head + status).trim() || '_working…_';
  return body.length > MAX_DISCORD_MESSAGE ? body.slice(0, MAX_DISCORD_MESSAGE - 1) + '…' : body;
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
  const { prompt, channelId, userId, guildId, transport } = opts;

  const auth = await configureHarnessRuntime();
  if (!auth.ok) {
    await transport.sendError(`Cannot start: ${auth.reason}`);
    return;
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
        decision: intent,
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

  const state: DisplayState = { summary: '', status: 'starting', done: false };
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
      await flush();
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
  transport: DiscordHarnessTransport;
}): Promise<void> {
  const { channelId, decision, transport } = opts;

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

  const entry = channelSessions.get(channelId);
  if (!entry) {
    await transport.sendError('No paused session to resume.');
    return;
  }
  const sessionId = entry.sessionId;
  entry.lastUsedAt = Date.now();

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
      await flush();
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
    case 'turn_started':
      state.status = 'thinking…';
      return;
    case 'tool_called': {
      const tool = String(data.tool ?? data.name ?? 'tool');
      state.status = `using ${tool}`;
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
      const decision = (data.decision ?? null) as { summary?: string } | null;
      if (decision?.summary) state.summary = decision.summary;
      const step = data.step ? `step ${String(data.step)}` : 'step';
      state.status = step;
      return;
    }
    case 'approval_requested': {
      const subject = String(data.subject ?? data.tool ?? 'action');
      // Move the approval text into summary (which survives the
      // done=true render path) instead of status (which renderBody
      // hides when done). Without this the placeholder degrades to
      // "working…" — what Nathan hit on the LegalLady test.
      state.summary = `Approval required: ${subject}\n\nReply **approve** to continue or **reject** to cancel.`;
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
      const summary = data.summary ? String(data.summary) : state.summary;
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
