/**
 * Which conversations have news since the owner last looked, on this phone.
 *
 * A conversation has news when it changed after the owner last had it open
 * here and nothing is running in it: the reply that finished while they were
 * somewhere else. Times are the Mac's own (`updatedAt`), never the phone's
 * clock, so a clock difference cannot invent or hide news. The first list a
 * phone ever loads is the baseline: everything already there counts as read.
 *
 * Storage is a per-phone convenience: if it is unavailable, nothing is marked
 * and the list still works.
 */
export interface ChatSeenState {
  /** Everything at or before this time counted as read when the phone began. */
  since: number;
  /** The latest change of each conversation the owner has had open. */
  seen: Record<string, number>;
}

export interface ChatSeenRow {
  id: string;
  updatedAt: number;
  running?: boolean;
}

const KEY = 'clem.chats.seen.v1';
const MAX_ENTRIES = 300;

function storage(): Storage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage; } catch { return null; }
}

export function readChatSeen(store: Storage | null = storage()): ChatSeenState | null {
  try {
    const raw = store?.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<ChatSeenState>;
    if (typeof parsed.since !== 'number' || !parsed.seen || typeof parsed.seen !== 'object') return null;
    return { since: parsed.since, seen: parsed.seen as Record<string, number> };
  } catch {
    return null;
  }
}

function write(state: ChatSeenState, store: Storage | null): void {
  const entries = Object.entries(state.seen).sort((a, b) => b[1] - a[1]).slice(0, MAX_ENTRIES);
  try { store?.setItem(KEY, JSON.stringify({ since: state.since, seen: Object.fromEntries(entries) })); } catch { /* a convenience */ }
}

/** The stored state, or a baseline made from the first list this phone sees. */
export function chatSeenBaseline(rows: ReadonlyArray<ChatSeenRow>, store: Storage | null = storage()): ChatSeenState | null {
  const current = readChatSeen(store);
  if (current || rows.length === 0) return current;
  write({ since: Math.max(...rows.map((row) => row.updatedAt)), seen: {} }, store);
  return readChatSeen(store);
}

/** The owner has this conversation as of its change at `updatedAt`. */
export function markChatSeen(id: string, updatedAt: number, store: Storage | null = storage()): void {
  if (!id || !Number.isFinite(updatedAt)) return;
  const state = readChatSeen(store);
  if (!state) return;
  if ((state.seen[id] ?? 0) >= updatedAt) return;
  write({ since: state.since, seen: { ...state.seen, [id]: updatedAt } }, store);
}

export function chatHasNews(row: ChatSeenRow, state: ChatSeenState | null): boolean {
  if (!state || row.running) return false;
  return row.updatedAt > (state.seen[row.id] ?? state.since);
}
