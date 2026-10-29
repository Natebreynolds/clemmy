import { useRef, useState } from 'preact/hooks';
import { listSessionFiles, type SessionFileRef } from '../lib/session-files';
import { taskResultFiles } from '../lib/task-results';
import { useScreenData } from '../lib/use-screen-data';
import { CompletedFiles, SavedFileSheet } from './CompletedFiles';

/** The task hints that it saved files; resolve their actual recorded IDs. */
export function TaskResultFiles({ sessionId, savedKey, onOpenRun }: {
  sessionId: string;
  savedKey: string;
  onOpenRun?: (sessionId: string) => void;
}) {
  const { data, loading, error, refresh } = useScreenData(() => listSessionFiles(sessionId), { resourceKey: `task-files:${sessionId}:${savedKey}` });
  const rows = taskResultFiles(sessionId, data ?? []);
  const [selected, setSelected] = useState<SessionFileRef | null>(null);
  const [openRequest, setOpenRequest] = useState(0);
  const opener = useRef<HTMLButtonElement | null>(null);
  return <div class="task-result-files" aria-label="Saved results">
    {loading ? <p class="card-note" role="status">Finding saved results…</p> : null}
    {error ? <p class="card-note" role="status">Saved files could not be loaded. <button type="button" class="link-btn" onClick={() => void refresh()}>Try again</button></p> : null}
    {rows.length > 0 ? <ul class="task-result-list">{rows.slice(0, 3).map(row => <li key={row.ref.fileId}><button type="button" onClick={event => { opener.current = event.currentTarget; setSelected(row.ref); }}><span>{row.file.name}</span><span>Open</span></button></li>)}</ul> : null}
    {rows.length > 3 ? <button type="button" class="link-btn" onClick={event => { opener.current = event.currentTarget; setOpenRequest(value => value + 1); }}>All files from this run ({rows.length})</button> : null}
    {!loading && rows.length === 0 && onOpenRun ? <button type="button" class="link-btn" onClick={() => onOpenRun(sessionId)}>Review saved results in the run</button> : null}
    {!loading && !error && rows.length === 0 && !onOpenRun ? <p class="card-note">No saved files are available to open from this run.</p> : null}
    <SavedFileSheet fileRef={selected} onClose={() => { setSelected(null); requestAnimationFrame(() => opener.current?.focus()); }} returnLabel="Task" />
    <CompletedFiles conversationId={sessionId} openRequest={openRequest} onReturn={() => opener.current?.focus()} />
  </div>;
}
