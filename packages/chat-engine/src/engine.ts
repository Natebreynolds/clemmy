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
import type {
  ChatMessage, ConnectionState, EngineSnapshot, HarnessEvent, MessageStatus,
} from './types.js';
import { reduceActivity } from './reduce-activity.js';
import { terminalCompletionPresentation } from './terminal-presentation.js';
import { settleTerminalActivity, activityTerminalOutcomeForMessageStatus } from './activity-presentation.js';
import { runChatStream, type ChatStreamHandle, type StreamTransport } from './stream.js';

export interface SendResult {
  sessionId: string;
  accepted: boolean;
}

export interface ChatApi {
  /** Async-accepted send: resolves as soon as the turn is durably claimed.
   *  Retries with the SAME idempotency key must be safe. */
  send(input: { message: string; sessionId: string | null; idempotencyKey: string }): Promise<SendResult>;
  /** Full transcript load for opening an existing session. */
  loadSession(sessionId: string): Promise<{ events: HarnessEvent[]; latestSeq: number; title?: string }>;
}

export interface ChatEngineOptions {
  transport: StreamTransport;
  api: ChatApi;
  sessionId?: string | null;
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

export class ChatEngine {
  private readonly transport: StreamTransport;
  private readonly api: ChatApi;
  private readonly newKey: () => string;
  private readonly now: () => number;
  private readonly streamTimings: Partial<Parameters<typeof runChatStream>[0]>;

  private sessionId: string | null;
  private messages: ChatMessage[] = [];
  private busy = false;
  private connection: ConnectionState = 'idle';
  private stream: ChatStreamHandle | null = null;
  private activeAssistantId: string | null = null;
  private listeners = new Set<(snapshot: EngineSnapshot) => void>();
  private disposed = false;
  private cursor = 0;

  constructor(options: ChatEngineOptions) {
    this.transport = options.transport;
    this.api = options.api;
    this.newKey = options.newIdempotencyKey ?? defaultIdempotencyKey;
    this.now = options.now ?? Date.now;
    this.streamTimings = options.streamTimings ?? {};
    this.sessionId = options.sessionId ?? null;
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

  /** Open an existing session: load the transcript, then attach live. */
  async open(): Promise<void> {
    if (!this.sessionId) return;
    const { events, latestSeq } = await this.api.loadSession(this.sessionId);
    if (this.disposed) return;
    this.messages = foldTranscript(events);
    this.cursor = latestSeq;
    // A turn may still be in flight (user sent from another surface, or the
    // app was reopened mid-run): if the last user input has no terminal after
    // it, re-enter the live state and resume from just before it.
    const inFlightSince = inFlightTurnSince(events);
    if (inFlightSince !== null) {
      this.busy = true;
      this.ensureActiveAssistant();
      this.attachStream(inFlightSince);
    } else {
      this.attachStream(latestSeq);
    }
    this.emit();
  }

  async send(text: string): Promise<void> {
    const message = text.trim();
    if (!message || this.busy) return;
    const idempotencyKey = this.newKey();
    const userMessage: ChatMessage = {
      id: nextLocalId(),
      role: 'user',
      text: message,
      pending: 'sending',
      idempotencyKey,
    };
    const assistant: ChatMessage = {
      id: nextLocalId(),
      role: 'assistant',
      text: '',
      status: 'thinking',
      activity: [],
    };
    this.messages = [...this.messages, userMessage, assistant];
    this.activeAssistantId = assistant.id;
    this.busy = true;
    this.emit();
    await this.postWithRetry(userMessage, message, idempotencyKey);
  }

  async retry(messageId: string): Promise<void> {
    const failed = this.messages.find((m) => m.id === messageId && m.pending === 'failed');
    if (!failed || !failed.idempotencyKey || this.busy) return;
    this.messages = this.messages.map((m) => (m.id === messageId ? { ...m, pending: 'sending', pendingError: undefined } : m));
    this.busy = true;
    this.ensureActiveAssistant();
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
        const result = await this.api.send({ message, sessionId: this.sessionId, idempotencyKey });
        if (this.disposed) return;
        this.messages = this.messages.map((m) => (m.id === userMessage.id
          ? { ...m, pending: undefined, pendingError: undefined }
          : m));
        if (!this.sessionId) {
          this.sessionId = result.sessionId;
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

  private applyEvent(event: HarnessEvent): void {
    if (this.disposed) return;
    const d = (event.data ?? {}) as Record<string, unknown>;
    if (event.seq > this.cursor && (!event.sessionId || event.sessionId === this.sessionId)) {
      this.cursor = event.seq;
    }
    switch (event.type) {
      case 'stream_token': {
        const delta = typeof d.delta === 'string' ? d.delta : '';
        if (!delta || !this.busy) return;
        this.updateActive((m) => ({ ...m, text: m.text + delta }));
        break;
      }
      case 'user_input_received': {
        const text = typeof d.text === 'string' ? d.text.trim() : '';
        if (!text) return;
        // Confirm the local echo; a foreign-surface send appends as its own row.
        const pendingIndex = this.messages.findIndex((m) => m.role === 'user' && m.pending === 'sending' && m.text === text);
        if (pendingIndex >= 0) {
          this.messages = this.messages.map((m, i) => (i === pendingIndex ? { ...m, pending: undefined } : m));
        } else if (!this.messages.some((m) => m.role === 'user' && m.text === text && m.pending === undefined)) {
          this.messages = [...this.messages, { id: `u-${event.seq}`, role: 'user', text }];
        }
        break;
      }
      case 'stall_retry_attempted': {
        // The streamed draft was detected-bad; the retry replaces it.
        if (this.busy) this.updateActive((m) => ({ ...m, text: '' }));
        break;
      }
      case 'approval_requested': {
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
          },
        }];
        this.busy = false;
        break;
      }
      case 'conversation_completed': {
        const presentation = terminalCompletionPresentation(d, this.activeText(), this.activeStatus());
        const planProposalId = typeof d.planProposalId === 'string' ? d.planProposalId : undefined;
        const statusRaw = typeof d.planProposalStatus === 'string' ? d.planProposalStatus : 'pending';
        this.updateActive((m) => ({
          ...m,
          ...presentation,
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
        const error = typeof d.error === 'string' && d.error ? d.error : 'The run failed.';
        this.updateActive((m) => ({
          ...m,
          text: m.text || error,
          status: 'failed',
          activity: settleTerminalActivity(m.activity ?? [], 'failed'),
        }));
        this.busy = false;
        this.activeAssistantId = null;
        break;
      }
      case 'awaiting_user_input': {
        this.updateActive((m) => ({ ...m, status: 'awaiting-reply' }));
        break;
      }
      default: {
        if (!this.busy && !this.activeAssistantId) return;
        this.updateActive((m) => {
          const activity = reduceActivity(m.activity ?? [], event, this.now);
          return activity === m.activity ? m : { ...m, activity };
        });
      }
    }
    this.emit();
  }

  private activeText(): string {
    return this.messages.find((m) => m.id === this.activeAssistantId)?.text ?? '';
  }

  private activeStatus(): MessageStatus | undefined {
    return this.messages.find((m) => m.id === this.activeAssistantId)?.status;
  }

  private emit(): void {
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
    if (event.type === 'user_input_received') {
      lastUserSeq = event.seq;
    } else if (lastUserSeq !== null && event.seq > lastUserSeq
      && (event.type === 'conversation_completed' || event.type === 'run_failed'
        || event.type === 'awaiting_user_input' || event.type === 'approval_requested'
        || event.type === 'async_work_dispatched')) {
      lastUserSeq = null;
    }
  }
  // Resume from just before the user input so the replay reconstructs the
  // whole turn (streamed text is not persisted; activity events are).
  return lastUserSeq === null ? null : lastUserSeq - 1;
}

/** Rebuild a message list from a session's persisted, public-projected
 *  events — the transcript a reopened chat renders instantly. */
export function foldTranscript(events: readonly HarnessEvent[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  let activity: ChatMessage['activity'] = [];
  for (const event of events) {
    const d = (event.data ?? {}) as Record<string, unknown>;
    switch (event.type) {
      case 'user_input_received': {
        const text = typeof d.text === 'string' ? d.text.trim() : '';
        if (text) messages.push({ id: `u-${event.seq}`, role: 'user', text });
        activity = [];
        break;
      }
      case 'conversation_completed': {
        const presentation = terminalCompletionPresentation(d, '', undefined);
        const planProposalId = typeof d.planProposalId === 'string' ? d.planProposalId : undefined;
        const statusRaw = typeof d.planProposalStatus === 'string' ? d.planProposalStatus : 'pending';
        messages.push({
          id: `a-${event.seq}`,
          role: 'assistant',
          text: presentation.text,
          status: presentation.status,
          ...(planProposalId ? {
            planProposalId,
            planProposalStatus: statusRaw === 'approved' || statusRaw === 'rejected' ? statusRaw : 'pending',
            planProposalNeedsUserInput: d.planProposalNeedsUserInput === true,
          } : {}),
          activity: settleTerminalActivity(activity ?? [], activityTerminalOutcomeForMessageStatus(presentation.status)),
        });
        activity = [];
        break;
      }
      case 'run_failed': {
        const error = typeof d.error === 'string' && d.error ? d.error : 'The run failed.';
        messages.push({
          id: `a-${event.seq}`,
          role: 'assistant',
          text: error,
          status: 'failed',
          activity: settleTerminalActivity(activity ?? [], 'failed'),
        });
        activity = [];
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
          },
        });
        break;
      }
      default: {
        activity = reduceActivity(activity ?? [], event);
      }
    }
  }
  return messages;
}
