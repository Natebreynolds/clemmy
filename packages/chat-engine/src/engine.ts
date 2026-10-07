import { readQuestionOptions } from './question-options.js';
import { readLiveApprovalControl } from './live-approval-control.js';
import type { PendingMessageStore } from './pending-request.js';
import { readTaskMode, readPlanRevisionRef, snapshotTaskMode, sameTaskMode, type TaskMode } from './task-mode.js';
/**
 * ChatEngine — the framework-agnostic chat state machine.
 *
 * Owns: the message list, the live turn's streamed text + activity strip,
 * send with idempotent retry, and the stream lifecycle (via runChatStream).
 * A UI layer (React hook, Preact hook) is a thin subscriber: it renders
 * snapshots and forwards user intent. Everything here is plain TS with
 * injected transports so both the desktop console and the mobile PWA can
 * drive it.
 */
import type { ApprovalConfirm, ChatAttachment,
  ChatMessage, ConnectionState, EngineSnapshot, HarnessEvent, MessageStatus,
} from './types.js';
import { approvalPreviewFrom, approvalResolutionFrom, approvalRevisionFrom, cardDecisionOf, type CardDecision } from './types.js';
import { reduceFeed } from './reduce-lifecycle.js';
import { applyStreamToken, withoutAnswerDraft } from './answer-stream.js';
import { terminalCompletionPresentation } from './terminal-presentation.js';
import { settleTerminalActivity, activityTerminalOutcomeForMessageStatus } from './activity-presentation.js';
import { runChatStream, type ChatStreamHandle, type StreamTransport } from './stream.js';
import { acceptedConversationSource, appendConversationCheckIn } from './conversation-check-in.js';

export interface SendResult {
  sessionId: string;
  accepted: boolean;
  steered?: boolean;
}

/** The user's own words for a user_input_received row: displayText when the
 *  server folded attachment contents into text, else text. */
function userVisibleText(d: Record<string, unknown>): string {
  const shown = typeof d.displayText === 'string' ? d.displayText.trim() : '';
  if (shown) return shown;
  return typeof d.text === 'string' ? d.text.trim() : '';
}

export interface ChatApi {
  /** Async-accepted send: resolves as soon as the turn is durably claimed.
   *  Retries with the SAME idempotency key must be safe. A mid-run steer
   *  (steerOnly) must never claim a competing attempt. */
  send(input: {
    message: string;
    sessionId: string | null;
    idempotencyKey: string;
    connectionRequestId?: string;
    steerOnly?: boolean;
    taskMode?: TaskMode;
    /** Saved agent a NEW conversation opens inside. The server binds it at
     *  creation and ignores it once the session exists. */
    agentId?: string;
    /** Inbox ids of files uploaded ahead of this message. */
    attachments?: string[];
  }): Promise<SendResult>;
  /** Full transcript load for opening an existing session. */
  loadSession(sessionId: string): Promise<{ events: HarnessEvent[]; latestSeq: number; title?: string }>;
}

export interface ChatEngineOptions {
  transport: StreamTransport;
  api: ChatApi;
  sessionId?: string | null;
  /** Agent the first message of a fresh conversation binds it to; forwarded
   *  on every send, harmless once the session exists. */
  agentId?: string | null;
  pendingStore?: PendingMessageStore;
  newIdempotencyKey?: () => string;
  now?: () => number;
  /** Stream timing overrides ride through to runChatStream (tests). */
  streamTimings?: Partial<Parameters<typeof runChatStream>[0]>;
}

let engineIdSeq = 0;
const nextLocalId = (): string => `m${++engineIdSeq}-${Math.random().toString(36).slice(2, 8)}`;

const defaultIdempotencyKey = (): string =>
  (globalThis.crypto as { randomUUID?: () => string } | undefined)?.randomUUID?.()
    ?? `key-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

const DELEGATED_ASSISTANT_ID_PREFIX = 'a-delegated-';

function delegatedAssistantMessageId(sourceUserSeq: number, dispatchSeq: number): string {
  return `${DELEGATED_ASSISTANT_ID_PREFIX}${sourceUserSeq}-${dispatchSeq}`;
}

function delegatedSourceSeqFromMessageId(id: string): number | null {
  if (!id.startsWith(DELEGATED_ASSISTANT_ID_PREFIX)) return null;
  const raw = id.slice(DELEGATED_ASSISTANT_ID_PREFIX.length).split('-')[0];
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function sourceUserSeqOf(event: HarnessEvent): number | null {
  const artifact = event.data?.artifact;
  const direct = event.data?.sourceUserSeq ?? (artifact && typeof artifact === 'object' ? (artifact as Record<string, unknown>).sourceUserSeq : undefined);
  if (typeof direct === 'number' && Number.isSafeInteger(direct) && direct > 0) return direct;
  const presentation = event.data?.presentation;
  if (!presentation || typeof presentation !== 'object' || Array.isArray(presentation)) return null;
  const identity = (presentation as Record<string, unknown>).identity;
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) return null;
  const nested = (identity as Record<string, unknown>).sourceUserSeq;
  return typeof nested === 'number' && Number.isSafeInteger(nested) && nested > 0
    ? nested
    : null;
}

function delegatedSourceUserSeq(message: ChatMessage): number | null {
  const direct = message.delegatedWork?.sourceUserSeq;
  return typeof direct === 'number' && Number.isSafeInteger(direct) && direct > 0
    ? direct
    : delegatedSourceSeqFromMessageId(message.id);
}

function exactRunIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((id): id is string => (
    typeof id === 'string'
    && id.trim().length > 0
    && id.length <= 200
    && /^[A-Za-z0-9_.:-]+$/.test(id)
  )))];
}

export class ChatEngine {
  private readonly transport: StreamTransport;
  private readonly api: ChatApi;
  private readonly pendingStore?: PendingMessageStore;
  private readonly newKey: () => string;
  private readonly now: () => number;
  private readonly streamTimings: Partial<Parameters<typeof runChatStream>[0]>;

  private sessionId: string | null;
  private readonly agentId: string | null;
  private messages: ChatMessage[] = [];
  private busy = false;
  /** Key of the turn in flight; see EngineSnapshot.cancelKey. */
  private inFlightKey: string | null = null;
  private connection: ConnectionState = 'idle';
  private stream: ChatStreamHandle | null = null;
  private activeAssistantId: string | null = null;
  /** Card taps seen in this session, by their accepted source. */
  private readonly cardDecisionsBySource = new Map<number, CardDecision>();
  private listeners = new Set<(snapshot: EngineSnapshot) => void>();
  private disposed = false;
  private cursor = 0;
  /** Exact accepted source currently owning activeAssistantId, once its
   * user_input_received row has crossed the stream. */
  private activeSourceUserSeq: number | null = null;
  /** Cursor immediately before the current ordinary send. A terminal naming a
   * source at/below this fence is a trailing terminal for earlier work. */
  private activeSourceFloorSeq = 0;

  constructor(options: ChatEngineOptions) {
    this.transport = options.transport;
    this.api = options.api;
    this.pendingStore = options.pendingStore;
    this.messages = options.pendingStore?.load() ?? [];
    this.newKey = options.newIdempotencyKey ?? defaultIdempotencyKey;
    this.now = options.now ?? Date.now;
    this.streamTimings = options.streamTimings ?? {};
    this.sessionId = options.sessionId ?? null;
    this.agentId = options.agentId ?? null;
  }

  /** Spread into every api.send call so a fresh conversation opens inside its agent. */
  private agentField(): { agentId?: string } {
    return this.agentId ? { agentId: this.agentId } : {};
  }

  subscribe(listener: (snapshot: EngineSnapshot) => void): () => void {
    this.listeners.add(listener);
    listener(this.snapshot());
    return () => { this.listeners.delete(listener); };
  }

  snapshot(): EngineSnapshot {
    return {
      sessionId: this.sessionId,
      messages: this.messages,
      busy: this.busy,
      connection: this.connection,
      // Derived rather than cleared at each of the several places busy drops,
      // so a stale key can never outlive the turn it belonged to.
      cancelKey: this.busy ? this.inFlightKey : null,
      activeTaskMode: this.busy ? this.messages.find(message => message.id === this.activeAssistantId)?.taskMode : undefined,
    };
  }

  dispose(): void {
    this.disposed = true;
    this.stream?.stop();
    this.stream = null;
    this.listeners.clear();
  }

  /** Webview resumed / network returned — recover the stream and catch up. */
  resume(): void {
    this.stream?.resume();
  }

  /** Reflect one source-bound delegated cancellation without borrowing the
   * foreground turn's busy state. The eventual canonical report-back still
   * replaces this exact bubble and remains terminal authority. */
  setDelegatedWorkState(
    sourceUserSeq: number,
    state: 'running' | 'cancelling' | 'stopped',
  ): boolean {
    if (!Number.isSafeInteger(sourceUserSeq) || sourceUserSeq <= 0) return false;
    let changed = false;
    this.messages = this.messages.map((message) => {
      if (message.delegatedWork?.sourceUserSeq !== sourceUserSeq) return message;
      changed = true;
      return {
        ...message,
        status: state === 'stopped' ? 'stopped' : 'thinking',
        progress: state === 'cancelling'
          ? 'Stopping…'
          : state === 'stopped'
            ? 'Stopped'
            : undefined,
        activity: state === 'stopped'
          ? settleTerminalActivity(message.activity ?? [], 'interrupted')
          : message.activity,
        delegatedWork: { ...message.delegatedWork, state },
      };
    });
    if (changed) this.emit();
    return changed;
  }

  /** Open an existing session: load the transcript, then attach live. */
  async open(): Promise<void> {
    if (!this.sessionId) return;
    const { events, latestSeq } = await this.api.loadSession(this.sessionId);
    if (this.disposed) return;
    const unacknowledged = this.messages.filter(message => message.role === 'user' && message.pending);
    this.messages = [...foldTranscript(events, this.sessionId), ...unacknowledged];
    this.cursor = latestSeq;
    // A turn may still be in flight (user sent from another surface, or the
    // app was reopened mid-run): if the last user input has no terminal after
    // it, re-enter the live state and resume from just before it.
    const inFlightSince = inFlightTurnSince(events);
    if (inFlightSince !== null) {
      this.busy = true;
      this.activeSourceFloorSeq = inFlightSince;
      this.activeSourceUserSeq = inFlightSince + 1;
      this.ensureActiveAssistant();
      const source = events.find(event => event.type === 'user_input_received' && event.seq === inFlightSince + 1);
      this.updateActive(message => ({ ...message, taskMode: readTaskMode(source?.data?.taskMode),
        acceptedSource: source ? acceptedConversationSource(source, this.sessionId) : undefined }));
      this.attachStream(inFlightSince);
    } else if (events.length > 0 || latestSeq > 0) {
      // Delegated work releases the composer, but its durable running card is
      // still the assistant message that the later report-back must settle.
      // Keep that exact replayed bubble active without marking the foreground
      // chat busy, so a reload neither loses progress nor creates a second
      // assistant bubble when the workflow terminal arrives.
      const delegated = this.messages.at(-1);
      const delegatedSourceSeq = delegated?.role === 'assistant'
        ? delegatedSourceUserSeq(delegated)
        : null;
      if (delegated && delegatedSourceSeq !== null) {
        this.activeAssistantId = delegated.id;
        this.activeSourceUserSeq = delegatedSourceSeq;
        this.activeSourceFloorSeq = Math.max(0, delegatedSourceSeq - 1);
      }
      this.attachStream(latestSeq);
    }
    // A session with no history may not exist server-side yet (stable
    // workspace thread ids are minted lazily on first message) — attaching a
    // stream would just 404-loop. send() attaches after the accepted claim.
    this.emit();
  }

  async send(text: string, selectedMode?: TaskMode, options: {
    attachments?: ChatAttachment[];
    connectionResume?: { connectionRequestId: string; clientRequestId: string };
    /** The message answers an approval card: the card shows the decision,
     *  so this exchange stays out of the transcript unless it fails. */
    cardDecision?: CardDecision;
  } = {}): Promise<void> {
    if (options.connectionResume && this.busy) throw new Error('Another turn is running. Check the connection again when it finishes.');
    const taskMode = snapshotTaskMode(options.connectionResume ? undefined : selectedMode);
    if (this.busy && (taskMode?.kind === 'execute' || !sameTaskMode(taskMode, this.snapshot().activeTaskMode))) {
      throw new Error('Wait for the current turn to finish before changing modes or executing a plan.');
    }
    const message = text.trim();
    const attachments = (options.attachments ?? []).filter((a) => a.id);
    // A photo with no words is a complete message; words with nothing are not.
    if (!message && attachments.length === 0) return;
    if (this.busy) {
      // Mid-run steering (OPEN-THE-GATES 4.2). The composer stays open; the
      // text is delivered into the live turn. Never claim a competing attempt.
      if (!this.sessionId) return;
      const steerId = nextLocalId();
      const steerMessage: ChatMessage = {
        id: steerId,
        role: 'user',
        text: message,
        pending: 'sending',
        requestSessionId: this.sessionId,
        steer: 'pending',
        idempotencyKey: this.newKey(),
      };
      this.messages = [...this.messages, steerMessage];
      this.emit();
      try {
        const result = await this.api.send({
          message,
          sessionId: this.sessionId,
          idempotencyKey: steerMessage.idempotencyKey!,
          steerOnly: true,
          ...this.agentField(),
        });
        this.messages = this.messages.map((entry) => (
          entry.id === steerId
            ? {
                ...entry,
                pending: result.steered ? undefined : 'failed',
                steer: result.steered ? 'delivered' : 'failed',
              }
            : entry
        ));
      } catch {
        this.messages = this.messages.map((entry) => (
          entry.id === steerId ? { ...entry, pending: 'failed', steer: 'failed' } : entry
        ));
      }
      this.emit();
      return;
    }
    const idempotencyKey = options.connectionResume?.clientRequestId ?? this.newKey();
    const userMessage: ChatMessage = {
      id: nextLocalId(),
      role: 'user',
      text: message,
      ...(attachments.length ? { attachments } : {}),
      pending: 'sending',
      ...(taskMode ? { taskMode } : {}),
      requestSessionId: this.sessionId,
      idempotencyKey,
      ...(options.connectionResume ? { connectionRequestId: options.connectionResume.connectionRequestId } : {}),
      ...(options.cardDecision ? { cardDecision: options.cardDecision } : {}),
    };
    const assistant: ChatMessage = {
      id: nextLocalId(),
      role: 'assistant',
      text: '',
      status: 'thinking',
      ...(options.cardDecision ? { cardDecision: options.cardDecision } : {}),
      ...(taskMode ? { taskMode, ...(taskMode.kind === 'plan' ? { progress: 'Investigating with read-only tools…' } : {}) } : {}),
      activity: [],
    };
    this.messages = [...this.messages, userMessage, assistant];
    this.activeAssistantId = assistant.id;
    this.activeSourceFloorSeq = this.cursor;
    this.activeSourceUserSeq = null;
    this.busy = true;
    this.inFlightKey = idempotencyKey;
    this.emit();
    await this.postWithRetry(userMessage, message, idempotencyKey);
  }

  async retry(messageId: string): Promise<void> {
    const failed = this.messages.find((m) => m.id === messageId && m.pending === 'failed');
    if (!failed || !failed.idempotencyKey || (this.busy && !failed.steer)) return;
    if (failed.steer) {
      this.messages = this.messages.map(message => message.id === messageId ? { ...message, pending: 'sending' } : message);
      this.emit();
      try {
        const result = await this.api.send({ message: failed.text, sessionId: failed.requestSessionId ?? this.sessionId,
          idempotencyKey: failed.idempotencyKey, steerOnly: true, ...(failed.taskMode ? { taskMode: failed.taskMode } : {}),
          ...this.agentField() });
        this.messages = this.messages.map(message => message.id === messageId
          ? { ...message, pending: result.steered ? undefined : 'failed', steer: result.steered ? 'delivered' : 'failed' } : message);
      } catch (error) {
        this.messages = this.messages.map(message => message.id === messageId
          ? { ...message, pending: 'failed', pendingError: error instanceof Error ? error.message : 'Steering was not confirmed.' } : message);
      }
      this.emit();
      return;
    }
    this.messages = this.messages.map((m) => (m.id === messageId ? { ...m, pending: 'sending', pendingError: undefined } : m));
    this.busy = true;
    this.inFlightKey = failed.idempotencyKey;
    this.activeSourceFloorSeq = this.cursor;
    this.activeSourceUserSeq = null;
    this.ensureActiveAssistant();
    this.updateActive(message => ({ ...message, taskMode: failed.taskMode }));
    this.emit();
    await this.postWithRetry(failed, failed.text, failed.idempotencyKey);
  }

  discard(messageId: string): void {
    this.messages = this.messages.filter((m) => !(m.id === messageId && m.pending === 'failed'));
    this.emit();
  }

  private async postWithRetry(userMessage: ChatMessage, message: string, idempotencyKey: string): Promise<void> {
    // Same identity on every attempt: a lost 202 replays the server's durable
    // receipt instead of starting a second run.
    const delays = [500, 1500, 3500];
    for (let attempt = 0; ; attempt += 1) {
      try {
        const result = await this.api.send({ message, sessionId: userMessage.requestSessionId !== undefined ? userMessage.requestSessionId : this.sessionId, idempotencyKey,
          ...(userMessage.connectionRequestId ? { connectionRequestId: userMessage.connectionRequestId } : {}),
          ...(userMessage.taskMode ? { taskMode: userMessage.taskMode } : {}),
          ...(userMessage.steer ? { steerOnly: true } : {}),
          ...(userMessage.attachments?.length ? { attachments: userMessage.attachments.map((a) => a.id) } : {}),
          ...this.agentField(),
        });
        if (this.disposed) return;
        this.messages = this.messages.map((m) => (m.id === userMessage.id
          ? { ...m, pending: undefined, pendingError: undefined }
          : m));
        if (result.sessionId !== this.sessionId) {
          this.stream?.stop();
          this.stream = null;
          this.sessionId = result.sessionId;
          this.cursor = 0;
          this.activeSourceFloorSeq = 0;
          this.activeSourceUserSeq = null;
        }
        // (Re)attach the stream from the current cursor so the accepted
        // turn's events land here.
        this.attachStream(this.cursor);
        this.emit();
        return;
      } catch (err) {
        if (this.disposed) return;
        if (attempt < delays.length) {
          await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
          continue;
        }
        this.messages = this.messages.map((m) => (m.id === userMessage.id
          ? { ...m, pending: 'failed', pendingError: err instanceof Error ? err.message : 'Failed to send' }
          : m));
        // The assistant placeholder for a send that never left the phone is
        // noise — drop it.
        if (this.activeAssistantId) {
          const active = this.activeAssistantId;
          this.messages = this.messages.filter((m) => !(m.id === active && m.role === 'assistant' && !m.text && (m.activity?.length ?? 0) === 0));
          this.activeAssistantId = null;
        }
        this.busy = false;
        this.emit();
        // Connection setup awaits this callback before declaring its task
        // continued. Keep the retryable echo, but do not report acceptance
        // through a fulfilled Promise when every delivery attempt failed.
        if (userMessage.connectionRequestId) throw err;
        return;
      }
    }
  }

  private ensureActiveAssistant(): void {
    if (this.activeAssistantId && this.messages.some((m) => m.id === this.activeAssistantId)) return;
    const assistant: ChatMessage = {
      id: nextLocalId(),
      role: 'assistant',
      text: '',
      status: 'thinking',
      activity: [],
    };
    this.messages = [...this.messages, assistant];
    this.activeAssistantId = assistant.id;
  }

  private attachStream(sinceSeq: number): void {
    if (!this.sessionId || this.disposed) return;
    this.stream?.stop();
    this.stream = runChatStream({
      sessionId: this.sessionId,
      transport: this.transport,
      sinceSeq,
      onEvent: (event) => this.applyEvent(event),
      shouldStopOnTerminal: (event) => this.terminalOwnsActiveTurn(event),
      onConnectionState: (state) => {
        this.connection = state;
        this.emit();
      },
      onTerminal: () => {
        this.connection = 'idle';
        this.emit();
      },
      now: this.now,
      ...this.streamTimings,
    } as Parameters<typeof runChatStream>[0]);
  }

  private updateActive(mutate: (m: ChatMessage) => ChatMessage): void {
    this.ensureActiveAssistant();
    const id = this.activeAssistantId;
    this.messages = this.messages.map((m) => (m.id === id ? mutate(m) : m));
  }

  /**
   * A question is rendered immediately at awaiting_user_input, while its
   * canonical conversation_completed row is appended just after it. If the
   * user answers before that completion has crossed this client's cursor, a
   * reconnect sees the old completion before the new accepted source. Bind
   * terminals to their durable source identity so that old row is drained,
   * never applied to the new assistant placeholder and never allowed to close
   * the new stream.
   */
  private terminalOwnsActiveTurn(event: HarnessEvent): boolean {
    const sourceUserSeq = sourceUserSeqOf(event);
    if (sourceUserSeq !== null) {
      const delegatedTarget = this.messages.find((message) => (
        message.role === 'assistant'
        && message.delegatedWork !== undefined
        && delegatedSourceUserSeq(message) === sourceUserSeq
      ));
      if (delegatedTarget) {
        // A foreground turn is never closed by an older background result.
        if (this.busy && this.activeAssistantId !== delegatedTarget.id) return false;
        // Keep one shared stream alive until every independently delegated
        // bubble has received its own terminal.
        const pendingDelegated = this.messages.filter((message) => (
          message.role === 'assistant'
          && message.delegatedWork !== undefined
        ));
        return pendingDelegated.length <= 1;
      }
    }
    if (!this.activeAssistantId) return true;
    const activeMessage = this.messages.find((message) => message.id === this.activeAssistantId);
    const delegated = activeMessage ? delegatedSourceUserSeq(activeMessage) !== null : false;
    if (!this.busy && !delegated) return true;
    // Legacy terminal projections without an identity retain their existing
    // behavior. Modern source-bound terminals take the exact path below.
    if (sourceUserSeq === null) return true;
    if (this.activeSourceUserSeq !== null) return sourceUserSeq === this.activeSourceUserSeq;
    return sourceUserSeq > this.activeSourceFloorSeq;
  }

  /** Settle a background workflow bubble without touching a newer foreground
   * placeholder. A source-bound terminal that loses this race must remain
   * visible live, not merely appear after a full transcript reload. */
  private settleDetachedDelegatedCompletion(
    event: HarnessEvent,
    data: Record<string, unknown>,
  ): boolean {
    const sourceUserSeq = sourceUserSeqOf(event);
    if (sourceUserSeq === null) return false;
    const index = this.messages.findIndex((message) => (
      message.role === 'assistant'
      && delegatedSourceUserSeq(message) === sourceUserSeq
    ));
    if (index < 0) return false;
    const current = this.messages[index]!;
    const presentation = terminalCompletionPresentation(data, current.text, current.status);
    this.messages = this.messages.map((message, messageIndex) => (
      messageIndex === index
        ? {
            ...message,
            ...presentation,
            delegatedWork: undefined,
            activity: settleTerminalActivity(
              message.activity ?? [],
              activityTerminalOutcomeForMessageStatus(presentation.status),
            ),
          }
        : message
    ));
    return true;
  }

  private settleDetachedDelegatedFailure(
    event: HarnessEvent,
    data: Record<string, unknown>,
  ): boolean {
    const sourceUserSeq = sourceUserSeqOf(event);
    if (sourceUserSeq === null) return false;
    const index = this.messages.findIndex((message) => (
      message.role === 'assistant'
      && delegatedSourceUserSeq(message) === sourceUserSeq
    ));
    if (index < 0) return false;
    const error = typeof data.error === 'string' && data.error ? data.error : 'The run failed.';
    this.messages = this.messages.map((message, messageIndex) => (
      messageIndex === index
        ? {
            ...message,
            text: message.text || error,
            status: 'failed',
            delegatedWork: undefined,
            activity: settleTerminalActivity(message.activity ?? [], 'failed'),
          }
        : message
    ));
    return true;
  }

  private applyEvent(event: HarnessEvent): void {
    if (this.disposed) return;
    const d = (event.data ?? {}) as Record<string, unknown>;
    if (event.seq > this.cursor && (!event.sessionId || event.sessionId === this.sessionId)) {
      this.cursor = event.seq;
    }
    if (readLiveApprovalControl(event)) {
      if (event.sessionId && event.sessionId !== this.sessionId) return;
      if (event.type === 'conversation_completed') {
        const id = `control-ack-${event.seq}`;
        if (!this.messages.some(message => message.id === id)) this.messages = [...this.messages, {
          id, role: 'assistant', ...terminalCompletionPresentation(d, ''),
        }];
        this.emit();
      }
      // Keep the current work bubble, mode, busy state and Stop request intact.
      return;
    }
    switch (event.type) {
      case 'stream_token': {
        if (!this.busy) return;
        // A draft belongs to one accepted source; never paint it into another.
        const source = typeof d.sourceUserSeq === 'number' ? d.sourceUserSeq : null;
        if (source !== null && this.activeSourceUserSeq !== null && source !== this.activeSourceUserSeq) return;
        this.updateActive((m) => applyStreamToken(m, d));
        break;
      }
      case 'conversation_preamble': {
        // Host-owned opening is the start of the user-visible reply. Discord
        // already projects it; dropping it here left mobile on a discovery
        // stand-in after the plan had already spoken (live 2026-08-28).
        const text = typeof d.text === 'string' ? d.text.trim() : '';
        if (!text || !this.busy) return;
        this.updateActive((m) => (m.text.trim() ? m : { ...m, text }));
        break;
      }
      case 'conversation_check_in': {
        const messages = appendConversationCheckIn(this.messages, event, this.sessionId);
        if (messages === this.messages) return;
        this.messages = messages;
        break;
      }
      case 'user_input_received': {
        if (event.sessionId && event.sessionId !== this.sessionId) return;
        // What the person typed is the bubble; `text` may carry folded
        // attachment contents meant for the model, never for the screen.
        const text = userVisibleText(d);
        const cardDecision = cardDecisionOf(d);
        if (cardDecision) {
          this.cardDecisionsBySource.set(event.seq, cardDecision);
        }
        if (!text) return;
        const acceptedSource = acceptedConversationSource(event, this.sessionId);
        if (
          this.busy
          && this.activeAssistantId
          && event.seq > this.activeSourceFloorSeq
          && this.activeSourceUserSeq === null
        ) {
          this.activeSourceUserSeq = event.seq;
        }
        if (acceptedSource && this.activeSourceUserSeq === event.seq && this.activeAssistantId) {
          this.updateActive(message => ({ ...message, acceptedSource }));
        }
        // Confirm the local echo; a foreign-surface send appends as its own row.
        const alreadyAccepted = acceptedSource && this.messages.some(message => message.role === 'user'
          && message.acceptedSource?.sessionId === acceptedSource.sessionId
          && message.acceptedSource.sourceUserSeq === event.seq);
        const pendingIndex = alreadyAccepted || (acceptedSource && this.activeSourceUserSeq !== event.seq)
          ? -1
          : this.messages.findIndex((m) => m.role === 'user' && !m.steer
            && (m.pending === 'sending' || (acceptedSource && !m.acceptedSource && m.idempotencyKey === this.inFlightKey))
            && m.text === text && sameTaskMode(m.taskMode, readTaskMode(d.taskMode)));
        if (pendingIndex >= 0) {
          this.messages = this.messages.map((m, i) => (i === pendingIndex ? { ...m, pending: undefined, acceptedSource } : m));
        } else if (!this.messages.some((m) => m.role === 'user' && (acceptedSource
          ? m.acceptedSource?.sourceUserSeq === event.seq && m.acceptedSource.sessionId === acceptedSource.sessionId
          : m.text === text && sameTaskMode(m.taskMode, readTaskMode(d.taskMode)) && m.pending === undefined))) {
          this.messages = [...this.messages, { id: `u-${event.seq}`, role: 'user', text, taskMode: readTaskMode(d.taskMode), acceptedSource,
            ...(cardDecision ? { cardDecision } : {}) }];
        }
        break;
      }
      case 'stall_retry_attempted': {
        // The streamed draft was detected-bad; the retry replaces it.
        if (this.busy) this.updateActive((m) => ({ ...m, text: '', answerDraft: undefined }));
        break;
      }
      case 'approval_requested': {
        if (!this.terminalOwnsActiveTurn(event)) return;
        const approvalId = typeof d.approvalId === 'string' ? d.approvalId : null;
        const id = `approval-${approvalId ?? event.seq}`;
        if (this.messages.some((m) => m.id === id || (!!approvalId && m.approval?.approvalId === approvalId))) return;
        this.messages = [...this.messages, {
          id,
          role: 'assistant',
          text: '',
          status: 'awaiting-approval',
          approval: {
            subject: String(d.subject ?? d.tool ?? 'this action'),
            reason: typeof d.reason === 'string' ? d.reason : undefined,
            approvalId,
            ...(d.consentCall ? { consentCall: d.consentCall as NonNullable<ChatMessage['approval']>['consentCall'] } : {}),
            ...(approvalPreviewFrom(d.preview) ? { preview: approvalPreviewFrom(d.preview) } : {}),
            ...(approvalRevisionFrom(d.revises) ? { revises: approvalRevisionFrom(d.revises) } : {}),
          },
        }];
        this.busy = false;
        break;
      }
      case 'approval_resolved': {
        const approvalId = typeof d.approvalId === 'string' ? d.approvalId : null;
        const resolution = approvalResolutionFrom(d);
        if (!approvalId || !resolution) break;
        this.messages = this.messages.map((m) => (
          m.approval?.approvalId === approvalId ? { ...m, approval: { ...m.approval, resolution } } : m
        ));
        break;
      }
      case 'plan_revision_published': {
        const ref = readPlanRevisionRef(d.planArtifactRef ?? d.artifact);
        if (ref && this.terminalOwnsActiveTurn(event)) this.updateActive(message => ({ ...message, planArtifactRef: ref }));
        break;
      }
      case 'conversation_completed': {
        const delegatedTargetId = sourceUserSeqOf(event) === null
          ? null
          : this.messages.find((message) => (
              message.role === 'assistant'
              && delegatedSourceUserSeq(message) === sourceUserSeqOf(event)
            ))?.id ?? null;
        if (delegatedTargetId && this.settleDetachedDelegatedCompletion(event, d)) {
          if (this.activeAssistantId === delegatedTargetId) {
            this.activeAssistantId = null;
            this.activeSourceUserSeq = null;
          }
          this.emit();
          return;
        }
        if (!this.terminalOwnsActiveTurn(event)) {
          return;
        }
        const presentation = terminalCompletionPresentation(d, this.activeText(), this.activeStatus());
        const planProposalId = typeof d.planProposalId === 'string' ? d.planProposalId : undefined;
        const statusRaw = typeof d.planProposalStatus === 'string' ? d.planProposalStatus : 'pending';
        this.updateActive((m) => ({
          ...withoutAnswerDraft(m),
          ...presentation,
          ...(readPlanRevisionRef(d.planArtifactRef ?? d.artifact) ? { planArtifactRef: readPlanRevisionRef(d.planArtifactRef ?? d.artifact) } : {}),
          ...(planProposalId ? {
            planProposalId,
            planProposalStatus: statusRaw === 'approved' || statusRaw === 'rejected' ? statusRaw : 'pending',
            planProposalNeedsUserInput: d.planProposalNeedsUserInput === true,
          } : {}),
          activity: settleTerminalActivity(
            m.activity ?? [],
            activityTerminalOutcomeForMessageStatus(presentation.status),
          ),
        }));
        this.busy = false;
        this.activeAssistantId = null;
        break;
      }
      case 'run_failed': {
        const delegatedTargetId = sourceUserSeqOf(event) === null
          ? null
          : this.messages.find((message) => (
              message.role === 'assistant'
              && delegatedSourceUserSeq(message) === sourceUserSeqOf(event)
            ))?.id ?? null;
        if (delegatedTargetId && this.settleDetachedDelegatedFailure(event, d)) {
          if (this.activeAssistantId === delegatedTargetId) {
            this.activeAssistantId = null;
            this.activeSourceUserSeq = null;
          }
          this.emit();
          return;
        }
        if (!this.terminalOwnsActiveTurn(event)) {
          return;
        }
        const error = typeof d.error === 'string' && d.error ? d.error : 'The run failed.';
        this.updateActive((active) => {
          const m = withoutAnswerDraft(active);
          return {
            ...m,
            text: m.text || error,
            status: 'failed',
            activity: settleTerminalActivity(m.activity ?? [], 'failed'),
          };
        });
        this.busy = false;
        this.activeAssistantId = null;
        break;
      }
      case 'awaiting_user_input': {
        if (!this.terminalOwnsActiveTurn(event)) return;
        const confirm = approvalConfirmFromEvent(d);
        if (confirm && this.messages.some((m) => m.approval?.approvalId === confirm.approvalId)) {
          // The card's own question, asked back: drawn ON the waiting card
          // (the owner's words, Clem's line, the same two answers); the
          // placeholder turn that would have carried it draws nothing.
          const placeholder = this.activeAssistantId;
          this.messages = this.messages
            .filter((m) => !(m.id === placeholder && !m.text.trim() && !m.approval && !m.planArtifactRef))
            .map((m) => (m.approval?.approvalId === confirm.approvalId ? { ...m, approval: { ...m.approval, confirm: confirm.confirm } } : m));
          this.busy = false;
          break;
        }
        // This event is itself a public terminal for the live stream. The
        // stream closes immediately after delivering it, so waiting for the
        // later conversation_completed projection leaves mobile permanently
        // busy with an empty bubble and a Stop button (live source 100077).
        // Render and settle the question at this exact boundary; the durable
        // completion remains the replay/cross-surface terminal authority.
        const question = typeof d.question === 'string' && d.question.trim()
          ? d.question.trim()
          : 'I have a question for you.';
        const options = readQuestionOptions(d.options);
        this.updateActive((m) => ({
          ...m,
          text: question,
          answerDraft: undefined,
          status: 'awaiting-reply',
          progress: undefined,
          ...(options.length ? { options } : {}),
          activity: settleTerminalActivity(
            m.activity ?? [],
            activityTerminalOutcomeForMessageStatus('awaiting-reply'),
          ),
        }));
        this.busy = false;
        this.activeAssistantId = null;
        break;
      }
      case 'async_work_dispatched': {
        const sourceUserSeq = sourceUserSeqOf(event);
        const runIds = exactRunIds(d.runIds);
        if (
          sourceUserSeq !== null
          && runIds.length > 0
          && this.activeAssistantId
          && (this.activeSourceUserSeq === null || this.activeSourceUserSeq === sourceUserSeq)
        ) {
          const currentId = this.activeAssistantId;
          const delegatedId = delegatedAssistantMessageId(sourceUserSeq, event.seq);
          this.messages = this.messages.map((current) => {
            if (current.id !== currentId) return current;
            const message = withoutAnswerDraft(current);
            return {
              ...message,
              id: delegatedId,
              text: message.text.trim()
                ? message.text
                : runIds.length === 1
                  ? 'The workflow is running. I’ll report back here when it finishes.'
                  : `${runIds.length} workflows are running. I’ll report back here when they finish.`,
              status: 'thinking',
              delegatedWork: { sourceUserSeq, runIds, state: 'running' },
              activity: reduceFeed(message.activity ?? [], event, this.now),
            };
          });
          this.activeAssistantId = delegatedId;
          this.activeSourceUserSeq = sourceUserSeq;
          // The background workflow retains its exact bubble and live stream,
          // while the foreground composer is free for a new turn.
          this.busy = false;
          break;
        }
        if (!this.busy && !this.activeAssistantId) return;
        this.updateActive((message) => {
          const activity = reduceFeed(message.activity ?? [], event, this.now);
          return activity === message.activity ? message : { ...message, activity };
        });
        break;
      }
      default: {
        if (!this.busy && !this.activeAssistantId) return;
        this.updateActive((m) => {
          const activity = reduceFeed(m.activity ?? [], event, this.now);
          return activity === m.activity ? m : { ...m, activity };
        });
      }
    }
    if (event.type === 'conversation_completed') this.tagCardDecisionReply(event);
    this.emit();
  }

  /** The host's reply to a card tap from another surface is the tap's too. */
  private tagCardDecisionReply(event: HarnessEvent): void {
    const source = sourceUserSeqOf(event);
    const cardDecision = source === null ? undefined : this.cardDecisionsBySource.get(source);
    if (!cardDecision) return;
    this.messages = this.messages.map((message) => (
      message.role === 'assistant' && !message.cardDecision
        && (message.acceptedSource?.sourceUserSeq === source || message.id === `a-${event.seq}`)
        ? { ...message, cardDecision }
        : message
    ));
  }

  /** The active reply's own text. A live answer draft is never read as it. */
  private activeText(): string {
    const active = this.messages.find((m) => m.id === this.activeAssistantId);
    return active ? withoutAnswerDraft(active).text : '';
  }

  private activeStatus(): MessageStatus | undefined {
    return this.messages.find((m) => m.id === this.activeAssistantId)?.status;
  }

  private emit(): void {
    this.pendingStore?.save(this.messages);
    if (this.disposed) return;
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
}

/** Seq of the last non-terminal-covered user input, or null when the session
 *  is settled. Mirrors the desktop's reattach rule: a user_input_received with
 *  no terminal event after it means a turn is still in flight. */
export function inFlightTurnSince(events: readonly HarnessEvent[]): number | null {
  let lastUserSeq: number | null = null;
  for (const event of events) {
    if (readLiveApprovalControl(event)) continue;
    if (event.type === 'user_input_received') {
      lastUserSeq = event.seq;
    } else if (lastUserSeq !== null && event.seq > lastUserSeq
      && (event.type === 'conversation_completed' || event.type === 'run_failed'
        || event.type === 'awaiting_user_input' || event.type === 'approval_requested'
        || event.type === 'async_work_dispatched')) {
      const terminalSourceUserSeq = sourceUserSeqOf(event);
      // A delayed terminal for an older source must not make a newer accepted
      // turn look settled on reopen. Legacy rows without source identity retain
      // their prior ordered-stream behavior.
      if (terminalSourceUserSeq === null || terminalSourceUserSeq === lastUserSeq) {
        lastUserSeq = null;
      }
    }
  }
  // Resume from just before the user input so the replay reconstructs the
  // whole turn (streamed text is not persisted; activity events are).
  return lastUserSeq === null ? null : lastUserSeq - 1;
}

/** Rebuild a message list from a session's persisted, public-projected
 *  events — the transcript a reopened chat renders instantly. */
export function foldTranscript(events: readonly HarnessEvent[], sessionId?: string | null): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let activity: ChatMessage['activity'] = [];
  let opening = '';
  // awaiting_user_input is independently deliverable, while the canonical
  // conversation_completed row normally follows it. Retain the raw question
  // when it is the only row, but replace it with the canonical projection on
  // full replay so one logical pause never renders as two assistant bubbles.
  let pendingAwaitingMessageIndex: number | null = null;
  const awaitingMessageIndexBySource = new Map<number, number>();
  const delegatedMessageIndexBySource = new Map<number, number>();
  let currentSourceUserSeq: number | null = null;
  const taskModesBySource = new Map<number, TaskMode>();
  const planRefsBySource = new Map<number, NonNullable<ChatMessage['planArtifactRef']>>();
  const cardDecisionsBySource = new Map<number, CardDecision>();
  for (const event of events) {
    const d = (event.data ?? {}) as Record<string, unknown>;
    if (readLiveApprovalControl(event)) {
      if (event.type === 'conversation_completed' && !messages.some(message => message.id === `control-ack-${event.seq}`)) messages.push({
        id: `control-ack-${event.seq}`, role: 'assistant', ...terminalCompletionPresentation(d, ''),
      });
      continue;
    }
    switch (event.type) {
      case 'user_input_received': {
        const text = userVisibleText(d);
        const cardDecision = cardDecisionOf(d);
        if (cardDecision) {
          cardDecisionsBySource.set(event.seq, cardDecision);
        }
        if (text) messages.push({ id: `u-${event.seq}`, role: 'user', text, taskMode: readTaskMode(d.taskMode),
          acceptedSource: acceptedConversationSource(event, sessionId), ...(cardDecision ? { cardDecision } : {}) });
        currentSourceUserSeq = event.seq;
        const mode = readTaskMode(d.taskMode);
        if (mode) taskModesBySource.set(event.seq, mode);
        activity = [];
        opening = '';
        pendingAwaitingMessageIndex = null;
        break;
      }
      case 'conversation_preamble': {
        const text = typeof d.text === 'string' ? d.text.trim() : '';
        if (text) opening = text;
        break;
      }
      // Fold after the source/answer groups exist: inserting an older note
      // here would shift the source-bound terminal index maps below.
      case 'conversation_check_in': break;
      case 'plan_revision_published': {
        const ref = readPlanRevisionRef(d.planArtifactRef ?? d.artifact);
        const source = sourceUserSeqOf(event) ?? currentSourceUserSeq;
        if (ref && source !== null) planRefsBySource.set(source, ref);
        break;
      }
      case 'conversation_completed': {
        const presentation = terminalCompletionPresentation(d, opening, undefined);
        const planProposalId = typeof d.planProposalId === 'string' ? d.planProposalId : undefined;
        const statusRaw = typeof d.planProposalStatus === 'string' ? d.planProposalStatus : 'pending';
        const sourceUserSeq = sourceUserSeqOf(event);
        const delegatedIndex = sourceUserSeq === null
          ? undefined
          : delegatedMessageIndexBySource.get(sourceUserSeq);
        const awaitingIndex = sourceUserSeq === null
          ? undefined
          : awaitingMessageIndexBySource.get(sourceUserSeq);
        const delegatedMessage = delegatedIndex === undefined
          ? undefined
          : messages[delegatedIndex];
        const awaitingMessage = awaitingIndex === undefined
          ? undefined
          : messages[awaitingIndex];
        const cardDecision = sourceUserSeq === null ? undefined : cardDecisionsBySource.get(sourceUserSeq);
        const terminalMessage: ChatMessage = {
          id: delegatedMessage?.id ?? awaitingMessage?.id ?? `a-${event.seq}`,
          role: 'assistant',
          text: presentation.text,
          status: presentation.status,
          ...(cardDecision ? { cardDecision } : {}),
          taskMode: taskModesBySource.get(sourceUserSeq ?? currentSourceUserSeq ?? -1),
          planArtifactRef: readPlanRevisionRef(d.planArtifactRef ?? d.artifact) ?? (sourceUserSeq === null ? undefined : planRefsBySource.get(sourceUserSeq)),
          ...(planProposalId ? {
            planProposalId,
            planProposalStatus: statusRaw === 'approved' || statusRaw === 'rejected' ? statusRaw : 'pending',
            planProposalNeedsUserInput: d.planProposalNeedsUserInput === true,
          } : {}),
          activity: settleTerminalActivity(
            delegatedMessage?.activity ?? awaitingMessage?.activity ?? activity ?? [],
            activityTerminalOutcomeForMessageStatus(presentation.status),
          ),
        };
        if (delegatedIndex !== undefined) {
          messages[delegatedIndex] = terminalMessage;
          delegatedMessageIndexBySource.delete(sourceUserSeq!);
        } else if (awaitingIndex !== undefined) {
          messages[awaitingIndex] = terminalMessage;
          awaitingMessageIndexBySource.delete(sourceUserSeq!);
        } else if (pendingAwaitingMessageIndex !== null) {
          messages[pendingAwaitingMessageIndex] = terminalMessage;
        } else {
          messages.push(terminalMessage);
        }
        // A detached workflow terminal must not consume the activity/opening
        // accumulated for a newer foreground source.
        const terminalOwnsCurrentSource = sourceUserSeq === null
          || currentSourceUserSeq === null
          || sourceUserSeq === currentSourceUserSeq;
        if (delegatedIndex === undefined && terminalOwnsCurrentSource) {
          activity = [];
          opening = '';
          pendingAwaitingMessageIndex = null;
        }
        break;
      }
      case 'run_failed': {
        const error = typeof d.error === 'string' && d.error ? d.error : 'The run failed.';
        const sourceUserSeq = sourceUserSeqOf(event);
        const delegatedIndex = sourceUserSeq === null
          ? undefined
          : delegatedMessageIndexBySource.get(sourceUserSeq);
        const awaitingIndex = sourceUserSeq === null
          ? undefined
          : awaitingMessageIndexBySource.get(sourceUserSeq);
        const delegatedMessage = delegatedIndex === undefined
          ? undefined
          : messages[delegatedIndex];
        const awaitingMessage = awaitingIndex === undefined
          ? undefined
          : messages[awaitingIndex];
        const failure: ChatMessage = {
          id: delegatedMessage?.id ?? awaitingMessage?.id ?? `a-${event.seq}`,
          role: 'assistant',
          text: delegatedMessage?.text || awaitingMessage?.text || error,
          status: 'failed',
          activity: settleTerminalActivity(
            delegatedMessage?.activity ?? awaitingMessage?.activity ?? activity ?? [],
            'failed',
          ),
        };
        if (delegatedIndex !== undefined) {
          messages[delegatedIndex] = failure;
          delegatedMessageIndexBySource.delete(sourceUserSeq!);
        } else if (awaitingIndex !== undefined) {
          messages[awaitingIndex] = failure;
          awaitingMessageIndexBySource.delete(sourceUserSeq!);
        } else {
          messages.push(failure);
        }
        if (
          sourceUserSeq === null
          || currentSourceUserSeq === null
          || sourceUserSeq === currentSourceUserSeq
        ) {
          activity = [];
          opening = '';
          pendingAwaitingMessageIndex = null;
        }
        break;
      }
      case 'awaiting_user_input': {
        const question = typeof d.question === 'string' && d.question.trim()
          ? d.question.trim()
          : 'I have a question for you.';
        const message: ChatMessage = {
          id: `a-awaiting-${event.seq}`,
          role: 'assistant',
          text: question,
          status: 'awaiting-reply',
          activity: settleTerminalActivity(activity ?? [], 'interrupted'),
        };
        const sourceUserSeq = sourceUserSeqOf(event) ?? currentSourceUserSeq;
        const sourceBoundIndex = sourceUserSeq === null
          ? undefined
          : awaitingMessageIndexBySource.get(sourceUserSeq);
        if (sourceBoundIndex !== undefined) {
          messages[sourceBoundIndex] = message;
        } else if (pendingAwaitingMessageIndex !== null) {
          messages[pendingAwaitingMessageIndex] = message;
        } else {
          messages.push(message);
          pendingAwaitingMessageIndex = messages.length - 1;
        }
        if (sourceUserSeq !== null) {
          awaitingMessageIndexBySource.set(
            sourceUserSeq,
            sourceBoundIndex ?? pendingAwaitingMessageIndex!,
          );
        }
        activity = [];
        opening = '';
        break;
      }
      case 'approval_requested': {
        const approvalId = typeof d.approvalId === 'string' ? d.approvalId : null;
        messages.push({
          id: `approval-${approvalId ?? event.seq}`,
          role: 'assistant',
          text: '',
          status: 'awaiting-approval',
          approval: {
            subject: String(d.subject ?? d.tool ?? 'this action'),
            reason: typeof d.reason === 'string' ? d.reason : undefined,
            approvalId,
            ...(d.consentCall ? { consentCall: d.consentCall as NonNullable<ChatMessage['approval']>['consentCall'] } : {}),
            ...(approvalPreviewFrom(d.preview) ? { preview: approvalPreviewFrom(d.preview) } : {}),
          },
        });
        break;
      }
      case 'approval_resolved': {
        const approvalId = typeof d.approvalId === 'string' ? d.approvalId : null;
        const resolution = approvalResolutionFrom(d);
        if (!approvalId || !resolution) break;
        for (let index = 0; index < messages.length; index += 1) {
          const message = messages[index]!;
          if (message.approval?.approvalId === approvalId) {
            messages[index] = { ...message, approval: { ...message.approval, resolution } };
          }
        }
        break;
      }
      case 'async_work_dispatched': {
        activity = reduceFeed(activity ?? [], event);
        const runIds = exactRunIds(d.runIds);
        const sourceUserSeq = sourceUserSeqOf(event);
        if (runIds.length > 0 && sourceUserSeq !== null) {
          const priorIndex = delegatedMessageIndexBySource.get(sourceUserSeq);
          const delegatedMessage: ChatMessage = {
            id: delegatedAssistantMessageId(sourceUserSeq, event.seq),
            role: 'assistant',
            text: runIds.length === 1
              ? 'The workflow is running. I’ll report back here when it finishes.'
              : `${runIds.length} workflows are running. I’ll report back here when they finish.`,
            status: 'thinking',
            delegatedWork: { sourceUserSeq, runIds, state: 'running' },
            activity,
          };
          if (priorIndex === undefined) {
            messages.push(delegatedMessage);
            delegatedMessageIndexBySource.set(sourceUserSeq, messages.length - 1);
          } else {
            messages[priorIndex] = delegatedMessage;
          }
          activity = [];
          opening = '';
        }
        break;
      }
      default: {
        activity = reduceFeed(activity ?? [], event);
      }
    }
  }
  return events.reduce((current, event) => event.type === 'conversation_check_in'
    ? appendConversationCheckIn(current, event, sessionId) : current, messages);
}

/** An `awaiting_user_input` that is the card's own question asked back. */
export function approvalConfirmFromEvent(d: Record<string, unknown>): { approvalId: string; confirm: ApprovalConfirm } | null {
  if (d.reason !== 'approval_confirmation_required') return null;
  const approvalId = typeof d.approvalId === 'string' && d.approvalId.trim() ? d.approvalId : '';
  const question = typeof d.question === 'string' ? d.question.trim() : '';
  if (!approvalId || !question) return null;
  const leaning = d.leaning === 'approves' || d.leaning === 'declines' ? d.leaning : 'unread';
  const replyText = typeof d.replyText === 'string' && d.replyText.trim() ? d.replyText.trim() : undefined;
  return { approvalId, confirm: { question, leaning, ...(replyText ? { replyText } : {}) } };
}
