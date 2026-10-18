import { useRef, useState } from 'react';
import { ChevronRight, RefreshCw, Trash2 } from 'lucide-react';
import { useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { Button } from '@/components/ui/Button';
import { Field, Input, Textarea } from '@/components/ui/Field';
import { addMeetingResearchDocument, removeMeetingResearchDocument,
  MEETING_DOCUMENT_COUNT_LIMIT, MEETING_DOCUMENT_TEXT_LIMIT, MEETING_DOCUMENT_TITLE_LIMIT, type MeetingResearchDocuments } from '@/lib/meeting-research';

/** Owner-pasted plaintext only. A saved note never grants access to a URL,
 * filesystem path, connected account or the rest of a document collection. */
export function MeetingContext({ meetingId, state }: { meetingId: string; state: UseQueryResult<MeetingResearchDocuments, Error> }) {
  const qc = useQueryClient();
  const key = ['meeting-research-documents', meetingId];
  const [title, setTitle] = useState('');
  const [text, setText] = useState('');
  const [adding, setAdding] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ownedAction = useRef(false);
  const documents = state.data?.documents ?? [];
  const act = async (work: () => Promise<void>) => {
    if (ownedAction.current) return;
    ownedAction.current = true; setPending(true); setError(null);
    try { await work(); }
    catch { setError('That note couldn’t be saved. Refresh meeting context and try again.'); }
    finally {
      ownedAction.current = false; setPending(false);
      void state.refetch();
      void qc.invalidateQueries({ queryKey: ['meeting-research', meetingId] });
    }
  };
  return <details className="group/context mt-5 min-w-0 border-t border-border pt-4">
    <summary className="flex min-h-11 cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 text-small font-semibold text-fg">
      <ChevronRight size={16} aria-hidden className="shrink-0 transition-transform group-open/context:rotate-90 motion-reduce:transition-none" />
      Meeting context
      {state.data && <span className="font-normal text-muted">{documents.length} saved {documents.length === 1 ? 'note' : 'notes'}</span>}
    </summary>
    <p className="mt-2 max-w-prose text-small text-muted">Paste an agenda, brief or reference for Clem to use privately. It stays with this meeting; it isn’t shared with participants.</p>
    {state.isLoading && !state.data && <p className="mt-3 text-small text-muted" role="status">Loading meeting context…</p>}
    {state.isError && <div className="mt-3 flex flex-wrap items-center gap-2" role="status">
      <p className="text-small text-warning">Meeting context couldn’t refresh. Saved notes may be out of date.</p>
      <Button size="sm" variant="ghost" onClick={() => void state.refetch()}><RefreshCw size={14} aria-hidden />Refresh context</Button>
    </div>}
    {documents.length > 0 && <ul className="mt-3 divide-y divide-border">
      {documents.map(document => <li key={document.id} className="flex min-w-0 items-center gap-2 py-2">
        <div className="min-w-0 flex-1"><p className="break-words text-small font-medium text-fg">{document.title}</p>
          <p className="text-caption text-muted">Version {document.revision} · {document.charCount.toLocaleString()} characters</p></div>
        <Button size="sm" variant="ghost" disabled={pending || state.isError} aria-label={`Remove ${document.title}`} onClick={() => void act(async () => {
          if (!state.data || state.isError) throw new Error('Refresh required');
          qc.setQueryData(key, await removeMeetingResearchDocument(meetingId, state.data, document));
        })}><Trash2 size={15} aria-hidden /><span className="sr-only sm:not-sr-only">Remove</span></Button>
      </li>)}
    </ul>}
    {!adding && <Button className="mt-3" size="sm" variant="secondary" disabled={pending || state.isError || !state.data || documents.length >= MEETING_DOCUMENT_COUNT_LIMIT}
      onClick={() => { setAdding(true); setError(null); }}>Add context</Button>}
    {documents.length >= MEETING_DOCUMENT_COUNT_LIMIT && <p className="mt-2 text-caption text-muted">This meeting has {MEETING_DOCUMENT_COUNT_LIMIT} notes. Remove one before adding another.</p>}
    {adding && <form className="mt-4 max-w-prose" onSubmit={event => { event.preventDefault(); void act(async () => {
      if (!state.data || state.isError) throw new Error('Refresh required');
      qc.setQueryData(key, await addMeetingResearchDocument(meetingId, state.data, title.trim(), text));
      setTitle(''); setText(''); setAdding(false);
    }); }}>
      <Field label="Title">{id => <Input id={id} value={title} onChange={event => setTitle(event.target.value)} maxLength={MEETING_DOCUMENT_TITLE_LIMIT} required disabled={pending} placeholder="For example, today’s launch brief" />}</Field>
      <Field label="Context for Clem" hint={`Plain text, up to ${MEETING_DOCUMENT_TEXT_LIMIT.toLocaleString()} characters.`}>{id => <Textarea id={id} value={text} onChange={event => setText(event.target.value)} maxLength={MEETING_DOCUMENT_TEXT_LIMIT} rows={5} required disabled={pending} />}</Field>
      <div className="flex flex-wrap gap-2"><Button size="sm" type="submit" disabled={pending || state.isError || !title.trim() || !text.trim()}>{pending ? 'Saving…' : 'Save context'}</Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => { setAdding(false); setTitle(''); setText(''); setError(null); }}>Cancel</Button></div>
    </form>}
    {error && <p className="mt-3 text-small text-danger" role="alert">{error}</p>}
  </details>;
}
