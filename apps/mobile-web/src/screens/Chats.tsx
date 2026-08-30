import { useEffect, useState } from 'preact/hooks';
import { useBackGesture } from '../lib/back-gesture';
import { listChatSessions, type ChatSession } from '../lib/api';
import { Chat } from './Chat';
import { relativeTime } from '../components/Approvals';
import { ScreenNotice } from '../components/ScreenNotice';
import { useScreenData } from '../lib/use-screen-data';

interface Props {
  /** Home hands over a question to ask, or a thread to open. Consumed once. */
  handoff?: { draft?: string; session?: ChatSession } | null;
  onHandoffConsumed?: () => void;
}

export function Chats({ handoff, onHandoffConsumed }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  useBackGesture(selectedId !== null, () => setSelectedId(null));
  const [composing, setComposing] = useState<{ draft?: string } | null>(null);
  // The list keeps polling and wake-refreshing only while it is the visible
  // surface — an open thread owns its own stream.
  const listVisible = !composing && !selectedId;
  const { data, loading, error, offline, refresh } = useScreenData(
    listChatSessions,
    { intervalMs: 8000, disabled: !listVisible },
  );
  const sessions = data?.sessions ?? [];

  // An ask typed on Home opens straight into a new chat with the text
  // already in the composer; a tapped thread opens that thread.
  useEffect(() => {
    if (!handoff) return;
    if (handoff.session) setSelectedId(handoff.session.id);
    else setComposing({ draft: handoff.draft });
    onHandoffConsumed?.();
  }, [handoff, onHandoffConsumed]);

  if (composing) {
    return <Chat initialDraft={composing.draft} onBack={() => { setComposing(null); void refresh(); }} />;
  }

  if (selectedId) {
    const session = sessions.find((s) => s.id === selectedId);
    return <Chat sessionId={selectedId} initialTitle={session?.title ?? ''} onBack={() => { setSelectedId(null); void refresh(); }} />;
  }

  return (
    <div>
      <button class="btn-new" onClick={() => setComposing({})}>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <path d="M12 5v14M5 12h14" />
        </svg>
        New chat
      </button>

      <ScreenNotice error={error} offline={offline} onRetry={() => void refresh()} hasData={sessions.length > 0} />

      {loading && sessions.length === 0 ? (
        <div class="skeleton-stack" aria-hidden="true"><i /><i /><i /></div>
      ) : null}

      {!loading && !error && !offline && sessions.length === 0 ? (
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
