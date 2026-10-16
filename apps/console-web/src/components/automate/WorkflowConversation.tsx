import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { PanelLeftClose } from 'lucide-react';
import { APPROVAL_ANSWER_WORDS, workflowConversationSessionId } from '@clem/chat-engine';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { QueryUnavailable } from '@/components/ui/QueryUnavailable';
import { ChatBubble } from '@/components/chat/ChatBubble';
import { Composer } from '@/components/chat/Composer';
import { RunningTasksDrawer } from '@/components/chat/RunningTasksDrawer';
import { useSession, isMissingConversation } from '@/features/conversations/hooks/useSession';
import { sessionHistoryReady } from '@/features/conversations/hooks/session-history-readiness';
import { sessionKeys } from '@/features/conversations/hooks/keys';
import { historyToMessages } from '@/features/conversations/chat/conversation-history';
import type { Turn } from '@/features/conversations/types';
import { chatDecisionIntent, useChat, type ChatMessage } from '@/lib/useChat';
import { unifiedChatSessionId } from '@/lib/last-session';
import { decidePlanProposal } from '@/lib/inbox';
import { prepareWorkflowQuestion, type WorkflowConversationQuestion } from '@/lib/workflow-conversation';

interface Props {
  workflowSlug: string;
  title: string;
  question: WorkflowConversationQuestion | null;
  unsavedChanges: boolean;
  onClose: () => void;
}

/** Definition editing is an ordinary owned chat, separate from run sessions. */
export function WorkflowConversation(props: Props) {
  const id = workflowConversationSessionId(props.workflowSlug);
  const history = useSession(id ? unifiedChatSessionId(id) : undefined);
  return (
    <>
      <div className="flex items-center gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-body font-semibold text-fg">{props.title}</h2>
          <p className="text-caption text-muted">with Clementine</p>
        </div>
        <Button variant="ghost" size="icon" onClick={props.onClose} aria-label="Hide the workflow conversation">
          <PanelLeftClose className="h-4 w-4" aria-hidden />
        </Button>
      </div>
      {!id ? (
        <p role="alert" className="p-4 text-small text-danger">This workflow cannot be opened for conversation.</p>
      ) : history.isError && !isMissingConversation(history.error) ? (
        <QueryUnavailable className="m-3" title="Couldn’t open this conversation"
          description="Your conversation is kept. Try connecting again."
          onRetry={() => { void history.refetch(); }} />
      ) : !sessionHistoryReady(history) ? (
        <div role="status" aria-label="Opening the workflow conversation" className="space-y-3 p-4">
          <Skeleton className="h-16" /><Skeleton className="ml-8 h-12" />
        </div>
      ) : (
        <WorkflowConversationLoaded key={id} {...props} sessionId={id} turns={history.data?.turns ?? []} />
      )}
    </>
  );
}

function WorkflowConversationLoaded({ workflowSlug, sessionId, turns, question, unsavedChanges }: Props & {
  sessionId: string;
  turns: Turn[];
}) {
  const qc = useQueryClient();
  const chat = useChat({ initialSessionId: sessionId, conversationSessionId: sessionId,
    initialMessages: historyToMessages(turns), reattachActiveRun: true, rememberAsLastSession: false });
  const composer = useRef<HTMLTextAreaElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const preparedQuestion = useRef<number | null>(null);
  const [suggested, setSuggested] = useState<WorkflowConversationQuestion | null>(null);
  useEffect(() => {
    if (!question || preparedQuestion.current === question.id) return;
    preparedQuestion.current = question.id;
    const result = prepareWorkflowQuestion(workflowSlug, question);
    setSuggested(result === 'draft-kept' ? question : null);
    if (result === 'prepared') composer.current?.focus({ preventScroll: true });
  }, [workflowSlug, question]);
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [chat.messages]);

  const decide = async (message: ChatMessage, decision: 'approve' | 'reject') => {
    const intent = chatDecisionIntent(message, decision);
    if (intent.kind === 'invalid-plan') throw new Error(intent.message);
    if (intent.kind === 'approval-reply') {
      await chat.send({ text: intent.text, displayText: APPROVAL_ANSWER_WORDS[decision], attachmentIds: [], attachmentNames: [] });
      return;
    }
    await decidePlanProposal(intent.planProposalId, intent.decision);
    await Promise.all([
      qc.invalidateQueries({ queryKey: sessionKeys.detail(unifiedChatSessionId(sessionId)) }),
      qc.invalidateQueries({ queryKey: ['plan-proposals'] }),
      qc.invalidateQueries({ queryKey: ['workflow', workflowSlug] }),
    ]);
  };

  return (
    <>
      {unsavedChanges && <p role="note" className="border-b border-border px-4 py-2 text-small text-muted">
        Your unsaved changes are kept. Save or revert them before asking Clem to edit these steps.
      </p>}
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-3 py-4">
        {chat.messages.length === 0 ? (
          <div className="px-2 py-6">
            <p className="text-body font-medium text-fg">What would you like to change?</p>
            <p className="mt-2 text-small text-muted">Ask Clem to explain this workflow, adjust its steps or schedule, or help with a run.</p>
          </div>
        ) : chat.messages.map(message => (
          <ChatBubble key={message.id} message={message} sessionId={chat.sessionId.current ?? undefined}
            executionBusy={chat.busy} onExecutePlan={chat.executePlan}
            onRevisePlan={() => { chat.setComposerMode('plan'); composer.current?.focus(); }}
            onApprove={() => decide(message, 'approve')} onReject={() => decide(message, 'reject')} />
        ))}
        <div ref={end} />
      </div>
      {suggested && <div role="status" className="border-t border-border px-3 py-2 text-small text-muted">
        <p>Your draft is kept. Add this question when you’re ready:</p>
        <p className="mt-1 line-clamp-3 text-fg">{suggested.text}</p>
        <Button variant="ghost" size="sm" className="mt-1" onClick={() => {
          if (prepareWorkflowQuestion(workflowSlug, suggested, true) === 'prepared') {
            setSuggested(null); composer.current?.focus();
          }
        }}>Add to draft</Button>
      </div>}
      <div className="border-t border-border p-2.5">
        <RunningTasksDrawer className="mb-1" composerRef={composer} />
        <Composer inputRef={composer} sessionId={chat.sessionId.current ?? undefined}
          draftSessionId={chat.conversationSessionId.current} busy={chat.busy}
          mode={chat.composerMode} onModeChange={chat.setComposerMode} activeTaskMode={chat.activeTaskMode}
          pendingPost={chat.pendingPost} onRetryPending={chat.retryPending} onCancelPending={chat.cancelPending}
          onSend={chat.send} onStop={chat.stop} voiceMessages={chat.messages}
          placeholder="Ask a question or describe a change…" />
      </div>
    </>
  );
}
