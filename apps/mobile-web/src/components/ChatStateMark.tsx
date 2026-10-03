/**
 * The one mark a conversation row carries at its end: a turning ring while
 * work is in flight, a dot when a reply finished since the owner last looked,
 * nothing otherwise. The same mark in the menu and in the full list.
 */
export function ChatStateMark({ running, news }: { running?: boolean; news?: boolean }) {
  if (running) return <span class="chat-state chat-state-running" role="img" aria-label="Working" />;
  if (news) return <span class="chat-state chat-state-news" role="img" aria-label="New reply" />;
  return null;
}
