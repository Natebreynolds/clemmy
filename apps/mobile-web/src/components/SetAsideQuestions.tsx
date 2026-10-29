import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import { listAttentionPresentations, listQuestionPresentations } from '../lib/api';
import { setAsideReturnLabel, setAsideViewFromSearch, type SetAsideView } from '../lib/set-aside-questions';
import { matchesSavedAttention, restoreSavedAttention, savedAttentionItems, type SavedAttentionItem, type SavedAttentionReceipt } from '../lib/attention-presentation';
import { useScreenData } from '../lib/use-screen-data';
import { ScreenNotice, type ScreenNote } from './ScreenNotice';
import { haptic } from '../lib/native-bridge';

/** Recovery reads durable server receipts, independently of the last Undo. */
export function SetAsideQuestions({ onRestored, onReply }: {
  onRestored: (receipt: SavedAttentionReceipt) => void;
  onReply: (sessionId: string | null, draft: string) => void;
}) {
  const questions = useScreenData(listQuestionPresentations, { intervalMs: 6_000 });
  const attention = useScreenData(listAttentionPresentations, { intervalMs: 6_000 });
  const refresh = useCallback(async () => { await Promise.allSettled([questions.refresh(), attention.refresh()]); }, [questions.refresh, attention.refresh]);
  const hasData = Boolean(questions.data || attention.data);
  const error = questions.error || attention.error;
  const offline = questions.offline || attention.offline;
  const refreshing = questions.refreshing || attention.refreshing;
  const loading = !hasData && (questions.loading || attention.loading);
  const [view, setView] = useState<SetAsideView>(() => setAsideViewFromSearch(window.location.search));
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<ScreenNote | null>(null);
  const lock = useRef(false);
  const rows = savedAttentionItems(questions.data?.questions ?? [], attention.data?.items ?? []);
  const filtered = rows.filter(row => matchesSavedAttention(row, view, search));
  useEffect(() => {
    const sync = () => setView(setAsideViewFromSearch(window.location.search));
    const changed = () => { void refresh(); };
    window.addEventListener('popstate', sync);
    window.addEventListener('clem:needs-you-changed', changed);
    return () => { window.removeEventListener('popstate', sync); window.removeEventListener('clem:needs-you-changed', changed); };
  }, [refresh]);
  const changeView = (next: SetAsideView) => {
    setView(next);
    const url = new URL(window.location.href);
    if (next === 'all') url.searchParams.delete('view'); else url.searchParams.set('view', next);
    window.history.pushState(window.history.state, '', `${url.pathname}${url.search}`);
  };
  const restore = async (row: SavedAttentionItem) => {
    if (lock.current) return;
    lock.current = true; setBusy(row.id); setNote(null);
    try {
      await restoreSavedAttention(row);
      haptic('light');
      setNote({ tone: 'success', text: 'Restored to Needs you. This does not resume or change the work.' });
      onRestored(row);
    } catch (cause) {
      setNote({ tone: 'error', text: (cause as { status?: number }).status === 409
        ? 'This item changed. Check the refreshed list before trying again.'
        : 'Could not confirm restoration. Refresh the list before trying again.' });
    } finally {
      // Refresh even after a refusal: the stored receipt may have moved on.
      await refresh(); lock.current = false; setBusy(null);
    }
  };
  const filters: Array<{ id: SetAsideView; label: string; count: number }> = [
    { id: 'all', label: 'All', count: rows.length },
    { id: 'later', label: 'Later', count: rows.filter(row => row.action === 'defer').length },
    { id: 'dismissed', label: 'Dismissed', count: rows.filter(row => row.action === 'dismiss').length },
  ];
  return <section class="set-aside" aria-labelledby="set-aside-heading" aria-busy={refreshing}>
    <div><h2 id="set-aside-heading" class="section-head">Set aside</h2><p class="card-note">Questions, stopped work and other requests you cleared from attention. Restore an item when you’re ready. This never answers, resumes or cancels work.</p></div>
    <ScreenNotice error={error} offline={offline} onRetry={() => void refresh()} hasData={hasData} note={note} />
    {error && hasData ? <p class="card-note">Some saved items couldn’t be refreshed. The available lists remain here.</p> : null}
    {loading ? <div class="skeleton-stack" role="status" aria-label="Loading set-aside items"><i /><i /></div> : null}
    {hasData ? <>
      {rows.length > 0 ? <>
        <div class="set-aside-filters" role="group" aria-label="Set aside items">{filters.map(filter => <button key={filter.id} type="button" aria-pressed={view === filter.id} onClick={() => changeView(filter.id)}>{filter.label} <span>{filter.count}</span></button>)}</div>
        <label class="set-aside-search"><span class="sr-only">Find a set-aside item</span><input type="search" value={search} placeholder="Find an item…" onInput={event => setSearch(event.currentTarget.value)} /></label>
      </> : null}
      {rows.length === 0 ? <p class="section-empty">{error ? 'No items in the available saved lists. Refresh to check the rest.' : 'Nothing set aside. Items you put off or dismiss will appear here while they still need attention.'}</p>
        : filtered.length === 0 ? <div class="set-aside-empty"><p class="section-empty">No matching items.</p><button type="button" class="btn-quiet" onClick={() => { setSearch(''); changeView('all'); }}>Clear filters</button></div>
        : <ul class="set-aside-list">{filtered.map(row => <li key={`${row.id}:${row.generation}:${row.mutationToken}`} class="inbox-card">
          <div class="inbox-card-meta"><span>{setAsideReturnLabel(row)}</span><span>{row.meta}</span></div>
          <h3 class="set-aside-question">{row.title}</h3>
          {row.context ? <details class="set-aside-context"><summary>Context</summary><p>{row.context}</p>{row.at ? <p>{new Date(row.at).toLocaleString()}</p> : null}</details> : null}
          <div class="inbox-card-actions"><button type="button" class="btn-reply" disabled={busy !== null} onClick={() => void restore(row)}>{busy === row.id ? 'Restoring…' : 'Restore'}</button>
            {row.sessionId ? <button type="button" class="btn-quiet" onClick={() => onReply(row.sessionId, '')}>Open conversation</button> : null}
          </div>
        </li>)}</ul>}
    </> : null}
  </section>;
}
