/**
 * Decisions stay in view; normal background work and earlier results stay
 * available without competing with the conversation. Every control is still
 * the shared task card's control, governed by the current task record.
 */
import { useId, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { ActivityCard } from '@/components/chat/ActivityCard';
import { DelegatedTaskCard } from '@/components/projects/DelegatedTaskCard';
import { reportInThread } from '@/lib/conversation-tasks';
import { conversationTaskGroups, conversationTaskGroupOpen, readConversationTaskExpansion, rememberConversationTaskExpansion, type ConversationTaskGroup } from '@/lib/conversation-task-area';
import type { DelegatedTask } from '@/lib/projects';
import type { ChatMessage } from '@/lib/useChat';

export function ConversationTasks({
  conversationId,
  cards,
  tasks,
  messages,
  onChanged,
}: {
  conversationId?: string;
  cards: readonly DelegatedTask[];
  /** Every task the conversation delegated, so a card can name the one it follows. */
  tasks?: readonly DelegatedTask[];
  messages: readonly ChatMessage[];
  onChanged?: () => void;
}) {
  return <TaskArea key={conversationId ?? 'current'} conversationId={conversationId} cards={cards} tasks={tasks} messages={messages} onChanged={onChanged} />;
}

function TaskArea({ conversationId, cards, tasks, messages, onChanged }: {
  conversationId?: string;
  cards: readonly DelegatedTask[];
  tasks?: readonly DelegatedTask[];
  messages: readonly ChatMessage[];
  onChanged?: () => void;
}) {
  const id = useId();
  const [preferences, setPreferences] = useState(() => readConversationTaskExpansion(conversationId));
  const groups = conversationTaskGroups(cards);
  const toggle = (group: ConversationTaskGroup) => {
    setPreferences(previous => {
      const next = { ...previous, [group.kind]: { open: !conversationTaskGroupOpen(group, previous), seen: group.attentionKeys } };
      rememberConversationTaskExpansion(conversationId, next);
      return next;
    });
  };
  if (cards.length === 0) return null;
  return (
    <section aria-label="Work handed off from this conversation" className="flex flex-col divide-y divide-border">
      {groups.map(group => {
        const open = conversationTaskGroupOpen(group, preferences);
        const contentId = `${id}-${group.kind}`;
        return <div key={group.kind} className="py-2 first:pt-0 last:pb-0">
          <h3>
            <button type="button" className="flex min-h-11 w-full items-center gap-2 rounded-sm py-2 text-left text-small text-muted transition-colors hover:text-fg" aria-expanded={open} aria-controls={contentId} onClick={() => toggle(group)}>
              <ChevronRight className={`h-4 w-4 shrink-0 transition-transform motion-reduce:transition-none${open ? ' rotate-90' : ''}`} aria-hidden />
              <span className="min-w-0 flex-1"><span className={`block font-semibold${group.defaultOpen ? ' text-fg' : ''}`}>{group.title} <span className="font-normal text-muted">· {group.tasks.length}</span></span>{!open ? <span className="mt-0.5 block truncate text-caption text-muted" title={group.summary}>{group.summary}</span> : null}</span>
            </button>
          </h3>
          {/* Keep mounted so folding a group does not erase an unsent answer. */}
          <div id={contentId} hidden={!open}>
            <div className="flex flex-col gap-2 pb-2">
              {group.tasks.map(task => {
                const strip = messages.find(message => message.delegated?.taskId === task.taskId);
                return <DelegatedTaskCard key={task.taskId} task={task} beside={tasks ?? cards} onChanged={onChanged}
                  hideResult={reportInThread(task.taskId, messages)}
                  liveWork={strip?.activity?.length ? <ActivityCard items={strip.activity} live={task.phase === 'working'} className="border-0 shadow-none" /> : undefined} />;
              })}
            </div>
          </div>
        </div>;
      })}
    </section>
  );
}
