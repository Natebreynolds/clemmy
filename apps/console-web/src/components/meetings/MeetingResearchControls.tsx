import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, ChevronRight, Pause, RefreshCw } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { renderMarkdown } from '@clem/chat-engine';
import { Button } from '@/components/ui/Button';
import { Field, Input } from '@/components/ui/Field';
import { getMeetingResearch, getMeetingResearchDocuments, meetingResearchJobLabel, meetingResearchNotice, meetingResearchReviewNotice,
  meetingResearchRefsCurrent, setMeetingResearch, stopMeetingResearch, type MeetingResearchDocumentRef } from '@/lib/meeting-research';
import { MeetingContext } from './MeetingContext';

export function MeetingResearchControls({ meetingId, active, presentation = 'default', onOpenLookup }: { meetingId: string; active: boolean; presentation?: 'default' | 'live'; onOpenLookup?: (sessionId: string) => void }) {
  const qc = useQueryClient();
  const key = ['meeting-research', meetingId];
  const research = useQuery({ queryKey: key, queryFn: () => getMeetingResearch(meetingId),
    refetchInterval: query => active || query.state.data?.status === 'running' ? 3000 : false, staleTime: 0, retry: 1 });
  const documents = useQuery({ queryKey: ['meeting-research-documents', meetingId],
    queryFn: () => getMeetingResearchDocuments(meetingId), refetchInterval: active ? 10_000 : false, staleTime: 0, retry: 1 });
  const [useMemory, setUseMemory] = useState(false);
  const [maxLookups, setMaxLookups] = useState('3');
  const [selected, setSelected] = useState<MeetingResearchDocumentRef[]>([]);
  const [draftVersion, setDraftVersion] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [pending, setPending] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ownedAction = useRef(false);
  const ownedStop = useRef(false);
  const view = research.data;
  useEffect(() => {
    if (!view || dirty) return;
    setUseMemory(view.useMemory); setMaxLookups(String(view.maxLookups));
    setSelected(view.documentRefs); setDraftVersion(view.version);
  }, [view, dirty]);
  useEffect(() => { if (!active) { void research.refetch(); void documents.refetch(); } },
    [active, research.refetch, documents.refetch]);
  const edit = (change: () => void) => { if (!dirty && view) setDraftVersion(view.version); setDirty(true); change(); setError(null); };
  const act = async (work: () => Promise<void>) => {
    if (ownedAction.current) return;
    ownedAction.current = true; setPending(true); setError(null);
    try { await work(); setDirty(false); }
    catch { setError('Research permission couldn’t be saved. Refresh, check your choices and try again.'); }
    finally { ownedAction.current = false; setPending(false); void research.refetch(); }
  };
  const pause = async () => {
    if (ownedStop.current) return;
    ownedStop.current = true; setStopping(true); setError(null);
    try { qc.setQueryData(key, await stopMeetingResearch(meetingId)); }
    catch { setError('Research couldn’t be paused. Try Pause research again.'); }
    finally { ownedStop.current = false; setStopping(false); void research.refetch(); }
  };
  const notes = documents.data?.documents ?? [];
  const selectedCurrent = meetingResearchRefsCurrent(selected, notes);
  const limit = Number(maxLookups);
  const validLimit = Number.isInteger(limit) && limit >= 1 && limit <= 8;
  const canSave = !!view && draftVersion !== null && active && !research.isError && !documents.isError
    && !!documents.data && selectedCurrent && validLimit && (useMemory || selected.length > 0);
  const lookupList = !!view?.jobs.length ? <div className={presentation === 'live' ? 'mt-4' : 'mb-4 mt-4'}>
      <h3 className="text-small font-semibold text-fg">Private lookups</h3>
      <ul className="mt-1 divide-y divide-border">{view.jobs.map(job => <li key={job.id} className="flex min-w-0 flex-wrap items-center gap-2 py-3">
        <div className="min-w-0 flex-1"><p className="break-words text-small text-fg">{job.question}</p>
          <p className="mt-1 text-caption text-muted">{meetingResearchJobLabel(job)}</p>
          {meetingResearchReviewNotice(job) && <p className={`mt-1 max-w-prose text-caption ${job.reviewState === 'unverified' || !job.reviewState ? 'text-warning' : 'text-muted'}`}>{meetingResearchReviewNotice(job)}</p>}</div>
        {job.task && (onOpenLookup ? <Button size="sm" variant="ghost" onClick={() => onOpenLookup(job.task!.sessionId)}>{job.status === 'completed' ? job.answer ? 'Open conversation' : 'Show answer' : 'Show lookup'}</Button> : <Link className="inline-flex min-h-11 shrink-0 items-center gap-1 text-small text-primary hover:underline" to={`/chat/${encodeURIComponent(job.task.sessionId)}`}>
          {job.status === 'completed' ? job.answer ? 'Open conversation' : 'Open answer' : 'Open lookup'}<ArrowUpRight size={14} aria-hidden />
        </Link>)}
        {job.answer && <div className="min-w-0 basis-full pt-2">
          <div className="max-h-80 min-w-0 overflow-y-auto rounded-md bg-surface px-3 py-3" role="region" aria-label={`Clem’s saved answer: ${job.question}`} tabIndex={0}>
            {/* Shared renderer escapes model content before adding markup. No
                chat composer or run reattachment mounts for this preview. */}
            <div className="chat-prose min-w-0" dangerouslySetInnerHTML={{ __html: renderMarkdown(job.answer.text, { workspaceLinks: false }) }} />
          </div>
          {research.isError && <p className="mt-1 text-caption text-muted">Showing the last saved answer. Its status couldn’t refresh.</p>}
        </div>}
      </li>)}</ul>
    </div> : null;
  return <>{lookupList}<details className="group/research mt-5 min-w-0 border-t border-border pt-4">
    <summary className="flex min-h-11 cursor-pointer flex-wrap items-center gap-x-3 gap-y-1 text-small font-semibold text-fg">
      <ChevronRight size={16} aria-hidden className="shrink-0 transition-transform group-open/research:rotate-90 motion-reduce:transition-none" />
      Research privately
      {view && <span className="font-normal text-muted">{research.isError ? 'Couldn’t refresh' : view.status === 'running' ? 'Researching' : view.status === 'ready' ? 'On for this meeting' : view.status === 'exhausted' ? 'Limit reached' : view.status === 'disabled' ? 'Off' : 'Paused'}</span>}
    </summary>
    <p className="mt-2 max-w-prose text-small text-muted">Let Clem answer useful meeting questions from the sources you choose. Answers stay in Clem; she won’t speak, message participants or change connected apps.</p>
    {research.isLoading && !view && <p className="mt-3 text-small text-muted" role="status">Loading research permission…</p>}
    {research.isError && <p className="mt-3 text-small text-warning" role="status">Research couldn’t refresh. Its last status may be out of date.</p>}
    {view && <div className="mt-3 flex flex-wrap items-start justify-between gap-2">
      <p className="max-w-prose text-small text-fg" role={view.status === 'running' ? 'status' : undefined}>{meetingResearchNotice(view)}</p>
      {view.enabled && <Button size="sm" variant="secondary" disabled={stopping} onClick={() => void pause()}><Pause size={14} aria-hidden />{stopping ? 'Pausing…' : 'Pause research'}</Button>}
    </div>}
    {(research.isError || documents.isError || error) && <Button className="mt-2" size="sm" variant="ghost" disabled={pending} onClick={() => {
      setDirty(false); setError(null); void research.refetch(); void documents.refetch();
    }}><RefreshCw size={14} aria-hidden />Refresh research</Button>}
    {view && <form className="mt-4 max-w-prose" onSubmit={event => { event.preventDefault(); if (!canSave) return; void act(async () => {
      qc.setQueryData(key, await setMeetingResearch(meetingId, { expectedVersion: draftVersion!, enabled: true,
        useMemory, maxLookups: limit, documentRefs: selected }));
    }); }}>
      <fieldset className="min-w-0" disabled={pending || stopping || research.isError || !active}>
        <legend className="text-small font-semibold text-fg">What Clem can use</legend>
        <label className="mt-1 flex min-h-11 cursor-pointer items-center gap-3 text-small text-fg">
          <input className="h-4 w-4 shrink-0 accent-primary" type="checkbox" checked={useMemory} onChange={event => edit(() => setUseMemory(event.target.checked))} />General memory
        </label>
        <p className="max-w-prose text-caption text-muted">Facts saved for use across Clem. Project memories and connected accounts aren’t included.</p>
        <p className="mt-1 max-w-prose text-caption text-muted">Your saved standing instructions and profile still apply.</p>
        {notes.length > 0 && <div className="mt-3">
          <p className="text-small font-medium text-fg">Saved meeting context</p>
          {notes.map(note => <label key={note.id} className="flex min-h-11 cursor-pointer items-center gap-3 text-small text-fg">
            <input className="h-4 w-4 shrink-0 accent-primary" type="checkbox" checked={selected.some(ref => ref.id === note.id && ref.revision === note.revision && ref.digest === note.digest)}
              onChange={event => edit(() => setSelected(refs => event.target.checked
                ? [...refs.filter(ref => ref.id !== note.id), { id: note.id, revision: note.revision, digest: note.digest }]
                : refs.filter(ref => ref.id !== note.id)))} />
            <span className="min-w-0 break-words">{note.title}<span className="ml-2 text-caption text-muted">Version {note.revision}</span></span>
          </label>)}
        </div>}
        {!documents.isLoading && !documents.isError && notes.length === 0 && <p className="mt-3 text-caption text-muted">You can add a brief or agenda under Meeting context below, then choose it here.</p>}
        {documents.isError && <p className="mt-3 text-small text-warning">Meeting context couldn’t refresh. Refresh before saving permission.</p>}
        {!selectedCurrent && <div className="mt-3"><p className="text-small text-warning">A selected note changed or was removed. Clear outdated selections, then choose the notes you want.</p>
          <Button className="mt-2" size="sm" variant="ghost" disabled={pending || documents.isError} onClick={() => edit(() => setSelected(refs => refs.filter(ref => meetingResearchRefsCurrent([ref], notes))))}>Clear outdated selections</Button>
        </div>}
        <div className="mt-4 max-w-52"><Field label="Maximum private lookups" hint="For this meeting only. You can pause at any time.">{id => <Input id={id} type="number" inputMode="numeric" min={1} max={8} step={1} value={maxLookups} onChange={event => edit(() => setMaxLookups(event.target.value))} required />}</Field></div>
        <Button size="sm" type="submit" disabled={pending || !canSave}>{pending ? 'Saving…' : view.enabled ? 'Save research permission' : 'Allow private research'}</Button>
        {!active && <p className="mt-2 text-caption text-muted">Research can run only while this meeting is recording.</p>}
      </fieldset>
      <p className="mt-2 text-caption text-muted">Permission ends with the meeting or after two hours. Changing a note requires saving permission again.</p>
    </form>}
    {error && <p className="mt-3 text-small text-danger" role="alert">{error}</p>}
    {view && <p className="mt-3 text-caption text-muted">{view.usedLookups} of {view.maxLookups} private lookups used</p>}
  </details><MeetingContext key={meetingId} meetingId={meetingId} state={documents} /></>;
}
