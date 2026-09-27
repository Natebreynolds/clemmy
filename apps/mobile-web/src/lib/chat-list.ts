/**
 * The conversation list, arranged the way a person scans it: what they
 * pinned first, then the rest newest first; a search narrows by title (and
 * by the agent's name). Pure, so the screen and its test agree.
 */
export interface ChatListRow {
  id: string;
  title: string;
  updatedAt: number;
  pinned?: boolean;
  archived?: boolean;
  agentName?: string | null;
}

export function arrangeChatList<T extends ChatListRow>(sessions: ReadonlyArray<T>, query: string): { pinned: T[]; rest: T[] } {
  const q = query.trim().toLowerCase();
  const matches = (s: T) => !q || s.title.toLowerCase().includes(q) || (s.agentName ?? '').toLowerCase().includes(q);
  const byTime = (a: T, b: T) => b.updatedAt - a.updatedAt;
  const visible = sessions.filter(matches);
  return {
    pinned: visible.filter((s) => s.pinned).sort(byTime),
    rest: visible.filter((s) => !s.pinned).sort(byTime),
  };
}

/** A rename keeps to one line and never saves an empty title. */
export function cleanChatTitle(raw: string): string | null {
  const title = raw.replace(/\s+/g, ' ').trim().slice(0, 120);
  return title ? title : null;
}
