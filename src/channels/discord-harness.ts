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

  const session = createHarnessSession({
    kind: 'chat',
    title: prompt.length > 60 ? `${prompt.slice(0, 57)}...` : prompt,
    metadata: { source: 'discord', channelId, userId, guildId },
  });

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
