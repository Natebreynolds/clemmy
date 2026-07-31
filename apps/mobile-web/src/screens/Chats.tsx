import { useCallback, useEffect, useState } from 'preact/hooks';
import { listChatSessions, type ChatSession } from '../lib/api';
import { Chat } from './Chat';
import { relativeTime } from '../components/Approvals';

interface Props {
  /** Home hands over a question to ask, or a thread to open. Consumed once. */
  handoff?: { draft?: string; session?: ChatSession } | null;
  onHandoffConsumed?: () => void;
}

export function Chats({ handoff, onHandoffConsumed }: Props) {
  const [sessions, setSessions] = useState<ChatSession[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [composing, setComposing] = useState<{ draft?: string } | null>(null);

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

  // An ask typed on Home opens straight into a new chat with the text
  // already in the composer; a tapped thread opens that thread.
  useEffect(() => {
    if (!handoff) return;
    if (handoff.session) setSelectedId(handoff.session.id);
    else setComposing({ draft: handoff.draft });
    onHandoffConsumed?.();
  }, [handoff, onHandoffConsumed]);

  if (composing) {
    return <Chat initialDraft={composing.draft} onBack={() => { setComposing(null); refresh(); }} />;
  }

  if (selectedId) {
    const session = sessions.find((s) => s.id === selectedId);
    return <Chat sessionId={selectedId} initialTitle={session?.title ?? ''} onBack={() => { setSelectedId(null); refresh(); }} />;
  }

  return (
    <div>
      <button class="btn-new" onClick={() => setComposing({})}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <path d="M12 5v14M5 12h14" />
        </svg>
        New chat
      </button>

      {loading && sessions.length === 0 ? (
        <div class="skeleton-stack" aria-hidden="true"><i /><i /><i /></div>
      ) : null}

      {!loading && error && sessions.length === 0 ? (
        <div class="empty">
          <p class="empty-title">Couldn't reach Clem</p>
          <p class="empty-body">{error}</p>
        </div>
      ) : null}

      {!loading && !error && sessions.length === 0 ? (
        <div class="empty">
          <img class="empty-mark" src="/m/clemmy.png" alt="" width="72" height="72" />
          <p class="empty-title">No conversations yet</p>
          <p class="empty-body">Start one above — she picks up all the context from your Mac.</p>
        </div>
      ) : null}

      <div class="stack">
        {sessions.map((session, i) => (
          <button key={session.id} class="card card-tap rise" style={{ '--i': i }} onClick={() => setSelectedId(session.id)}>
            <div class="min-w-0">
              <div class="card-title-sm truncate">{session.title || 'Untitled'}</div>
              <div class="card-when">
                <span class={`status-dot status-${session.status}`} aria-hidden="true" />
                {session.status.replace(/_/g, ' ')} · {relativeTime(session.updatedAt)}
              </div>
            </div>
            <svg class="card-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
              <path d="m9 18 6-6-6-6" />
            </svg>
          </button>
        ))}
      </div>
    </div>
  );
}
