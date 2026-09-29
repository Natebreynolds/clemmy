/**
 * The tasks this conversation handed off, drawn under its messages: one card
 * each, with who owns it and where it stands. The card replaces the live
 * strip a background run used to get here, and keeps that strip's view of
 * the work under Details.
 */
import { ActivityCard } from '@/components/chat/ActivityCard';
import { DelegatedTaskCard } from '@/components/projects/DelegatedTaskCard';
import { reportInThread } from '@/lib/conversation-tasks';
import type { DelegatedTask } from '@/lib/projects';
import type { ChatMessage } from '@/lib/useChat';

export function ConversationTasks({
  cards,
  tasks,
  messages,
  onChanged,
}: {
  cards: readonly DelegatedTask[];
  /** Every task the conversation delegated, so a card can name the one it follows. */
  tasks?: readonly DelegatedTask[];
  messages: readonly ChatMessage[];
  onChanged?: () => void;
}) {
  if (cards.length === 0) return null;
  return (
    <section aria-label="Work handed off from this conversation" className="flex flex-col gap-2">
      {cards.map((task) => {
        const strip = messages.find((message) => message.delegated?.taskId === task.taskId);
        return (
          <DelegatedTaskCard
            key={task.taskId}
            task={task}
            beside={tasks ?? cards}
            onChanged={onChanged}
            hideResult={reportInThread(task.taskId, messages)}
            liveWork={strip?.activity?.length
              ? <ActivityCard items={strip.activity} live={task.phase === 'working'} className="border-0 shadow-none" />
              : undefined}
          />
        );
      })}
    </section>
  );
}
