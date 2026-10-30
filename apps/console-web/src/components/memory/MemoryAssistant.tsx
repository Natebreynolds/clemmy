import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowDown, ArrowUpRight, MessageCircle, X } from 'lucide-react';
import { APPROVAL_ANSWER_WORDS } from '@clem/chat-engine';
import { ChatBubble } from '@/components/chat/ChatBubble';
import { Composer, type ComposerSendInput } from '@/components/chat/Composer';
import { ConversationTasks } from '@/components/chat/ConversationTasks';
import { Button } from '@/components/ui/Button';
import { readComposerDraft, writeComposerDraft } from '@/lib/composer-drafts';
import { useConversationTasks } from '@/lib/conversation-tasks';
import { decidePlanProposal } from '@/lib/inbox';
import { unifiedChatSessionId } from '@/lib/last-session';
import type { MemoryHit } from '@/lib/memory';
import { captureMemoryAssistantSubmission, handoffMemoryAssistantDraft, memoryAssistantMessage, memoryAssistantOwner, retainMemoryAssistantOwner, settleMemoryAssistantRetry, type MemoryAssistantSubmission } from '@/lib/memory-assistant-state';
import { chatDecisionIntent, useChat, type ChatMessage } from '@/lib/useChat';

export interface MemoryAssistantProps {
  open: boolean;
  onClose: () => void;
  context: MemoryHit | null;
  onClearContext: () => void;
  onMemoryChanged?: () => void;
  onBusyChange?: (busy: boolean) => void;
}

/** Keep mounted when hidden: a close is only a layout choice, not Stop or
 * New chat. No session, prompt, or mutation is created by opening the pane. */
export function MemoryAssistant({ open, onClose, context, onClearContext, onMemoryChanged, onBusyChange }: MemoryAssistantProps) {
  const [owner] = useState(memoryAssistantOwner);
  const scope = owner.scope;
  const draftKey = `session:${scope}`;
  const chat = useChat({ pendingStorageScope: scope, rememberAsLastSession: false,
    initialSessionId: owner.executionSessionId, conversationSessionId: owner.conversationSessionId, reattachActiveRun: true });
  const conversationId = chat.conversationSessionId.current;
  const delegated = useConversationTasks(conversationId, chat.delegatedTaskTick);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickRef = useRef(true);
  const [showLatest, setShowLatest] = useState(false);
  const [handoffError, setHandoffError] = useState('');
  const submissionRef = useRef<MemoryAssistantSubmission | null>(null);
  const callbacks = useRef({ onMemoryChanged, onBusyChange });
  callbacks.current = { onMemoryChanged, onBusyChange };
  const wasBusy = useRef(false);
  const latest = useRef({ context, chat });
  latest.current = { context, chat };
  useEffect(() => () => {
    const current = latest.current;
    if (!retainMemoryAssistantOwner(scope, current.chat.sessionId.current, current.chat.conversationSessionId.current)) return;
    // Keep a selected identity with an unsent draft without caching its body.
    const draft = readComposerDraft(draftKey);
    if (current.context && (draft.text.trim() || draft.attachments.length || draft.artifact)) {
      writeComposerDraft(draftKey, value => ({ ...value, text: memoryAssistantMessage(value.text, current.context) }));
    }
  }, [scope, draftKey]);

  useEffect(() => {
    callbacks.current.onBusyChange?.(chat.busy);
    if (wasBusy.current && !chat.busy) callbacks.current.onMemoryChanged?.();
    wasBusy.current = chat.busy;
  }, [chat.busy]);
  useEffect(() => () => callbacks.current.onBusyChange?.(false), []);
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => composerRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [open]);
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (open && scroller && stickRef.current) scroller.scrollTop = scroller.scrollHeight;
  }, [chat.messages, delegated.cards, open]);

  const send = async (input: ComposerSendInput) => {
    const text = memoryAssistantMessage(input.text, context);
    if (!chat.busy) submissionRef.current = captureMemoryAssistantSubmission(text, input.text, input.attachmentIds, readComposerDraft(draftKey));
    // Keep the reference in the visible transcript too, including retries.
    // Clearing/changing the chip cannot change an already submitted request.
    await chat.send({ ...input, text });
  };
  const retry = async (onAccepted?: () => void) => {
    const pending = chat.pendingPost;
    if (!pending) return;
    const sent = submissionRef.current;
    await chat.retryPending(() => {
      settleMemoryAssistantRetry(draftKey, pending.input, sent);
      onAccepted?.();
    });
  };
  const decide = async (message: ChatMessage, decision: 'approve' | 'reject') => {
    const intent = chatDecisionIntent(message, decision);
    if (intent.kind === 'invalid-plan') throw new Error(intent.message);
    if (intent.kind === 'plan-proposal') {
      await decidePlanProposal(intent.planProposalId, intent.decision);
      callbacks.current.onMemoryChanged?.();
    } else {
      await chat.send({ text: intent.text, displayText: APPROVAL_ANSWER_WORDS[decision], onAccepted: () => undefined });
    }
  };
  const fill = (text: string) => {
    writeComposerDraft(draftKey, current => ({ ...current, text: current.text.trim() ? `${current.text}\n\n${text}` : text }));
    requestAnimationFrame(() => {
      const input = composerRef.current;
      if (!input) return;
      input.focus({ preventScroll: true });
      input.style.height = 'auto';
      input.style.height = `${Math.min(input.scrollHeight, 220)}px`;
      input.setSelectionRange(input.value.length, input.value.length);
    });
  };
  const examples = context
    ? ['Where did this memory come from?', 'Is this memory still current?', 'Help me correct this memory.']
    : ['What have you learned recently?', 'What do you remember about my preferences?', 'How do you choose which tools to use?'];

  return (
    <aside hidden={!open} aria-label="Ask Clem about memory" className="memory-assistant flex h-full min-h-0 min-w-0 flex-col bg-surface" style={!open ? { display: 'none' } : undefined}>
      <header className="flex shrink-0 items-center gap-3 border-b border-border px-4 py-3">
        <MessageCircle className="h-4 w-4 shrink-0 text-primary" aria-hidden />
        <h2 className="min-w-0 flex-1 text-body font-semibold text-fg">Ask Clem</h2>
        {conversationId && (chat.pendingPost
          ? <button type="button" disabled className="inline-flex min-h-9 items-center gap-1 rounded-md px-2 text-small text-muted opacity-50" title="Resolve the pending message here before opening Chat">Open chat <ArrowUpRight className="h-3.5 w-3.5" aria-hidden /></button>
          : <Link to={`/chat/${encodeURIComponent(unifiedChatSessionId(conversationId))}`} className="inline-flex min-h-9 items-center gap-1 rounded-md px-2 text-small text-muted hover:bg-hover hover:text-fg" title="Open this conversation in Chat" onClick={event => {
            // A separate browser window cannot receive this window's draft.
            // Keep it here when the owner explicitly opens a separate tab.
            if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
            const result = handoffMemoryAssistantDraft(draftKey, conversationId, Boolean(chat.pendingPost), context);
            if (result !== 'moved') {
              event.preventDefault();
              setHandoffError(result === 'pending' ? 'Resolve the pending message here before opening Chat.' : 'Chat already has an unsent draft. Your Memory draft is still here; neither draft was replaced.');
            }
          }}>Open chat <ArrowUpRight className="h-3.5 w-3.5" aria-hidden /></Link>)}
        <Button variant="ghost" size="icon" aria-label="Hide Ask Clem" onClick={onClose}><X className="h-4 w-4" aria-hidden /></Button>
      </header>
      {handoffError && <p role="status" className="shrink-0 px-4 pt-3 text-small text-warning">{handoffError}</p>}
      {context && <div className="flex shrink-0 items-start gap-2 border-b border-border bg-subtle px-4 py-3">
        <div className="min-w-0 flex-1">
          <p className="text-caption text-muted">Selected memory · {context.ref.type}:{context.ref.id}</p>
          <p className="mt-1 line-clamp-2 break-words text-small text-fg">{context.title || context.text || 'Selected memory'}</p>
        </div>
        <Button variant="ghost" size="icon" aria-label="Remove selected memory from future messages" onClick={() => { onClearContext(); composerRef.current?.focus({ preventScroll: true }); }}><X className="h-4 w-4" aria-hidden /></Button>
      </div>}
      <div ref={scrollRef} onScroll={() => {
        const scroller = scrollRef.current;
        if (!scroller) return;
        stickRef.current = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
        setShowLatest(!stickRef.current);
      }} className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-4">
        {chat.messages.length === 0 ? <div className="space-y-5">
          <p className="text-body text-muted">{conversationId ? 'Your memory conversation is saved in Chat. Your draft is still here; Open chat shows its full history.' : 'Ask about what Clem remembers, explore how she learned it, or describe a correction.'}</p>
          <div className="space-y-1">
            {examples.map(example => <button key={example} type="button" onClick={() => fill(example)} className="block min-h-10 w-full rounded-md px-2 py-2 text-left text-small text-fg hover:bg-hover">{example}</button>)}
          </div>
        </div> : <div className="space-y-5">
          {chat.messages.map((message, index) => <ChatBubble key={message.id} message={message}
            sessionId={chat.sessionId.current ?? undefined} ownedTaskIds={delegated.ownedIds} executionBusy={chat.busy}
            onExecutePlan={chat.executePlan} onPreparePlan={chat.preparePlan}
            onRevisePlan={() => { chat.setComposerMode('plan'); composerRef.current?.focus({ preventScroll: true }); }}
            onApprove={() => decide(message, 'approve')} onReject={() => decide(message, 'reject')}
            onApproveWithEdits={fields => chat.approveWithEdits(message, fields)} onBackground={chat.background}
            onAnswer={index === chat.messages.length - 1 ? (text, connectionResume) => chat.send({ text, connectionResume, onAccepted: () => undefined }) : undefined}
            traceHref={chat.sessionId.current ? `/tasks?select=${encodeURIComponent(chat.sessionId.current)}` : undefined}
          />)}
          <ConversationTasks conversationId={conversationId ?? undefined} cards={delegated.cards} tasks={delegated.tasks} messages={chat.messages} onChanged={delegated.refresh} />
        </div>}
      </div>
      {showLatest && <div className="flex shrink-0 justify-center pb-2"><Button size="sm" variant="secondary" onClick={() => {
        stickRef.current = true;
        if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        setShowLatest(false);
      }}><ArrowDown className="h-3.5 w-3.5" aria-hidden />Jump to latest</Button></div>}
      <div className="shrink-0 border-t border-border p-3">
        <Composer inputRef={composerRef} sessionId={chat.sessionId.current ?? undefined} draftSessionId={scope}
          busy={chat.busy} mode={chat.composerMode} onModeChange={chat.setComposerMode} activeTaskMode={chat.activeTaskMode}
          pendingPost={chat.pendingPost} onRetryPending={retry} onCancelPending={chat.cancelPending}
          onSend={send} onStop={chat.stop} onBackground={chat.background} placeholder="Ask about memory…" />
      </div>
    </aside>
  );
}
