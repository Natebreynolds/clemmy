import { useCallback, useRef, useState } from 'react';
import { postChat, runHarnessStream, cancelSession, humanHarnessText, type StreamHandle } from './chat';
import type { ApiError } from './api';
import type { HarnessEvent } from './types';

export type MessageStatus =
  | 'thinking' | 'complete' | 'failed' | 'stopped'
  | 'awaiting-approval' | 'awaiting-reply' | 'awaiting-plan';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  status?: MessageStatus;
  progress?: string;
  approval?: { subject: string; reason?: string; approvalId?: string | null };
  planProposalId?: string;
  attachmentNames?: string[];
}

let idSeq = 0;
const nextId = () => `m${++idSeq}-${performance.now().toFixed(0)}`;

/** A short, human label for an intermediate event (the "working on…" line). */
function progressLabel(ev: HarnessEvent): string | null {
  const d = (ev.data ?? {}) as Record<string, unknown>;
  const tool = typeof d.tool === 'string' ? d.tool : typeof d.toolName === 'string' ? d.toolName : '';
  switch (ev.type) {
    case 'turn_started': return 'Thinking…';
    case 'plan_drafted':
    case 'plan_first_started': return 'Drafting a plan…';
    case 'step_started': return typeof d.title === 'string' ? String(d.title) : 'Working on a step…';
    case 'tool_called': return tool ? `Using ${tool.replace(/_/g, ' ')}…` : 'Using a tool…';
    case 'tool_returned': return tool ? `Got results from ${tool.replace(/_/g, ' ')}` : 'Got results';
    case 'handoff': return 'Handing off…';
    case 'memory_signals_captured': return 'Learning from this…';
    default: return null;
  }
}

export interface UseChatOptions {
  /** Resume an existing harness session (its turns post back to this id). */
  initialSessionId?: string | null;
  /** Seed the thread with already-loaded history (e.g. a reopened session). */
  initialMessages?: ChatMessage[];
}

export function useChat(options?: UseChatOptions) {
  const [messages, setMessages] = useState<ChatMessage[]>(options?.initialMessages ?? []);
  const [busy, setBusy] = useState(false);
  const sessionIdRef = useRef<string | null>(options?.initialSessionId ?? null);
  const streamRef = useRef<StreamHandle | null>(null);
  const activeAssistantId = useRef<string | null>(null);

  const patch = useCallback((id: string, fields: Partial<ChatMessage>) => {
    setMessages((prev) => prev.map((m) => (m.id === id ? { ...m, ...fields } : m)));
  }, []);

  const applyEvent = useCallback((assistantId: string, ev: HarnessEvent) => {
    const d = (ev.data ?? {}) as Record<string, unknown>;
    if (ev.type === 'conversation_completed') {
      const text = humanHarnessText((d.reply ?? d.summary), '');
      const reason = typeof d.reason === 'string' ? d.reason : '';
      const planProposalId = typeof d.planProposalId === 'string' ? d.planProposalId : '';
      if (reason === 'plan_first' && planProposalId) {
        patch(assistantId, { text: text || 'I drafted a plan — approve it to go ahead.', status: 'awaiting-plan', planProposalId, progress: undefined });
      } else {
        patch(assistantId, {
          text: text || (reason === 'no_structured_output' ? '(Finished without a written reply.)' : '(Done.)'),
          status: 'complete',
          progress: undefined,
        });
      }
    } else if (ev.type === 'run_failed') {
      patch(assistantId, { text: `Something went wrong: ${String(d.error ?? 'failed')}`, status: 'failed', progress: undefined });
    } else if (ev.type === 'conversation_limit_exceeded') {
      patch(assistantId, { status: 'stopped', progress: undefined });
    } else if (ev.type === 'awaiting_user_input') {
      patch(assistantId, { text: String(d.question ?? 'I have a question for you.'), status: 'awaiting-reply', progress: undefined });
    } else if (ev.type === 'approval_requested') {
      patch(assistantId, {
        status: 'awaiting-approval',
        progress: undefined,
        approval: {
          subject: String(d.subject ?? d.tool ?? 'this action'),
          reason: typeof d.reason === 'string' ? d.reason : undefined,
          approvalId: typeof d.approvalId === 'string' ? d.approvalId : null,
        },
      });
    } else {
      const label = progressLabel(ev);
      if (label) patch(assistantId, { progress: label });
    }
  }, [patch]);

  const send = useCallback(async (input: { text: string; attachmentIds?: string[]; attachmentNames?: string[] }) => {
    const text = input.text.trim();
    const attachmentIds = input.attachmentIds ?? [];
    if (!text && attachmentIds.length === 0) return;
    if (busy) return;

    const userId = nextId();
    const assistantId = nextId();
    activeAssistantId.current = assistantId;
    setMessages((prev) => [
      ...prev,
      { id: userId, role: 'user', text, attachmentNames: input.attachmentNames },
      { id: assistantId, role: 'assistant', text: '', status: 'thinking', progress: 'Starting up…' },
    ]);
    setBusy(true);

    try {
      const body = await postChat(text, sessionIdRef.current, attachmentIds);
      sessionIdRef.current = body.sessionId;
      const handle = runHarnessStream(body.sessionId, {
        sinceSeq: body.sinceSeq ?? 0,
        onEvent: (ev) => applyEvent(assistantId, ev),
      });
      streamRef.current = handle;
      const result = await handle.promise;
      streamRef.current = null;
      if (!result.ok) {
        setMessages((prev) => prev.map((m) => {
          if (m.id !== assistantId) return m;
          if (m.status && m.status !== 'thinking') return m; // a terminal event already landed
          const note = 'I lost the live connection before this finished. Check Inbox for the latest, or say “continue”.';
          return { ...m, text: m.text ? `${m.text}\n\n${note}` : note, status: 'stopped', progress: undefined };
        }));
      }
    } catch (err) {
      const e = err as ApiError;
      if (e.status === 404) sessionIdRef.current = null;
      patch(assistantId, { text: `Couldn't send: ${e.message || 'error'}`, status: 'failed', progress: undefined });
    } finally {
      activeAssistantId.current = null;
      setBusy(false);
    }
  }, [busy, applyEvent, patch]);

  const stop = useCallback(() => {
    const sid = sessionIdRef.current;
    streamRef.current?.stop();
    streamRef.current = null;
    if (activeAssistantId.current) patch(activeAssistantId.current, { status: 'stopped', progress: undefined });
    if (sid) void cancelSession(sid);
    setBusy(false);
  }, [patch]);

  const reset = useCallback(() => {
    sessionIdRef.current = null;
    setMessages([]);
  }, []);

  return { messages, busy, send, stop, reset, sessionId: sessionIdRef };
}
