import { useCallback, useEffect, useState } from 'preact/hooks';
import { listChatSessions, type ChatSession } from '../lib/api';
import { Chat } from './Chat';

export function Chats() {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = await listChatSessions();
      setSessions(result.sessions);
      setError(null);
    } catch (err) {
      setError((err as Error).message ?? 'Failed to load sessions');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 8000);
    return () => clearInterval(id);
  }, [refresh]);

  const [composing, setComposing] = useState(false);

  if (composing) {
    return <Chat onBack={() => { setComposing(false); refresh(); }} />;
  }

  if (selectedId) {
    const session = sessions.find((s) => s.id === selectedId);
    return <Chat sessionId={selectedId} initialTitle={session?.title ?? ''} onBack={() => { setSelectedId(null); refresh(); }} />;
  }

  return (
    <div>
      <button class="chat-new" onClick={() => setComposing(true)}>+ New chat</button>
      {loading && sessions.length === 0 ? <div class="inbox-empty">Loading…</div> : null}
      {!loading && error && sessions.length === 0 ? <div class="inbox-empty">{error}</div> : null}
      {!loading && !error && sessions.length === 0 ? <div class="inbox-empty">No chat sessions yet. Tap “New chat” above.</div> : null}
      {sessions.map((session) => (
        <button key={session.id} class="chat-row" onClick={() => setSelectedId(session.id)}>
          <div class="chat-row-title">{session.title}</div>
          <div class="chat-row-meta">
            <span class={`status status-${session.status}`}>{session.status}</span>
            <span>{relativeTime(session.updatedAt)}</span>
          </div>
        </button>
      ))}
    </div>
  );
}

function relativeTime(ms: number): string {
  if (!Number.isFinite(ms)) return '';
  const seconds = Math.round((Date.now() - ms) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
}
