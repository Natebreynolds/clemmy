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
  type EventRow,
} from '../runtime/harness/eventlog.js';
import { runConversation } from '../runtime/harness/loop.js';
import { buildOrchestratorAgent } from '../agents/orchestrator.js';

const EDIT_DEBOUNCE_MS = 2_000;
const SAFETY_TIMEOUT_MS = 35 * 60_000;
const MAX_DISCORD_MESSAGE = 1_900;

interface DiscordLikeReply {
  edit(opts: { content: string }): Promise<unknown>;
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
 * Run one Discord-routed harness conversation. Reads the message
 * prompt, creates a session, kicks off runConversation in the
 * background, and edits the placeholder reply with live progress
 * until the conversation reaches a terminal state.
 */
export async function handleDiscordHarnessMessage(
  message: Message<boolean>,
  prompt: string,
): Promise<void> {
  // Auth gate: same OAuth bridge the desktop chat and CLI use.
  const auth = await configureHarnessRuntime();
  if (!auth.ok) {
    await message.reply(`Cannot start: ${auth.reason}`);
    return;
  }

  const session = createHarnessSession({
    kind: 'chat',
    title: prompt.length > 60 ? `${prompt.slice(0, 57)}...` : prompt,
    metadata: {
      source: 'discord',
      channelId: message.channelId,
      userId: message.author.id,
      guildId: message.guildId ?? null,
    },
  });

  const reply = (await message.reply('🍊 starting…')) as unknown as DiscordLikeReply;

  const state: DisplayState = { summary: '', status: 'starting', done: false };
  let lastEditAt = 0;
  let pendingEdit: NodeJS.Timeout | null = null;

  const flush = async (): Promise<void> => {
    pendingEdit = null;
    lastEditAt = Date.now();
    try {
      await reply.edit({ content: renderBody(state) });
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

    // Safety net: if for any reason the conversation never emits a
    // terminal event (e.g. the daemon's clock drifts and the wall-
    // clock guard inside runConversation never fires), give up after
    // 35 minutes so the Discord reply stops looking stuck.
    safetyTimer = setTimeout(() => {
      state.status = 'timed out waiting for completion';
      state.done = true;
      void settle();
    }, SAFETY_TIMEOUT_MS);
  });

  // Run the conversation off the message handler — Discord wants the
  // event loop free to keep handling other messages, and the
  // actionBus subscription below feeds the UI without needing the
  // run's return value.
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
        // last-ditch — don't escalate an unhandled rejection
      }
    }
  })();

  await finished;
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
    case 'conversation_step': {
      const decision = (data.decision ?? null) as { summary?: string } | null;
      if (decision?.summary) state.summary = decision.summary;
      const step = data.step ? `step ${String(data.step)}` : 'step';
      state.status = step;
      return;
    }
    case 'approval_requested': {
      const subject = String(data.subject ?? data.tool ?? 'action');
      state.status = `approval required: ${subject}`;
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
