import { Link } from 'react-router-dom';
import { FileText } from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useFileDock } from '@/components/chat/FileDock';
import { listSessionFiles } from '@/lib/session-files';
import { taskResultFiles } from '@/lib/task-results';
import { savedFilesDestination } from '@/lib/saved-file-navigation';

/** Resolve saved-file identities only when the task says it has saved work. */
export function TaskResultFiles({ sessionId, savedKey }: { taskId: string; sessionId: string; savedKey: string }) {
  const dock = useFileDock();
  const files = useQuery({ queryKey: ['task-result-files', sessionId, savedKey], queryFn: () => listSessionFiles(sessionId),
    enabled: Boolean(sessionId), staleTime: 60_000, retry: 1 });
  const rows = taskResultFiles(sessionId, files.data ?? []);
  return <div className="mt-3 border-t border-border pt-3" aria-label="Saved results">
    {rows.length > 0 ? <ul className="divide-y divide-border">{rows.slice(0, 3).map(({ file, ref }) => <li key={ref.fileId}>
      {dock ? <button type="button" onClick={() => dock.open({ kind: 'file', ref })}
        className="flex min-h-11 w-full items-center gap-2 rounded-md px-1 py-2 text-left text-small hover:bg-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
        <FileText className="h-4 w-4 shrink-0 text-muted" aria-hidden /><span className="min-w-0 flex-1 truncate font-semibold text-fg" title={file.name}>{file.name}</span><span className="shrink-0 font-semibold text-primary">Open</span>
      </button> : <Link to={savedFilesDestination(sessionId, ref).pathname} state={savedFilesDestination(sessionId, ref).state} className="inline-flex min-h-11 items-center gap-2 text-small font-semibold text-primary hover:underline"><FileText className="h-4 w-4" aria-hidden /> Open {file.name}</Link>}
    </li>)}</ul> : null}
    {files.isLoading ? <p role="status" className="text-small text-muted">Finding saved results…</p> : null}
    {files.isError ? <p role="status" className="text-small text-muted">Saved results couldn’t be loaded. <button type="button" onClick={() => { void files.refetch(); }} className="font-semibold text-primary hover:underline">Retry</button></p> : null}
    {!files.isLoading && !files.isError && (rows.length === 0 || rows.length > 3) ? dock?.hasFilesList
      ? <button type="button" onClick={dock.showFiles} className="mt-1 inline-flex min-h-9 items-center text-small font-semibold text-primary hover:underline">{rows.length > 3 ? `All saved results (${rows.length})` : 'Files from this conversation'}</button>
      : <Link to={savedFilesDestination(sessionId).pathname} state={savedFilesDestination(sessionId).state} className="mt-1 inline-flex min-h-9 items-center text-small font-semibold text-primary hover:underline">{rows.length > 3 ? `All saved results (${rows.length})` : 'Files from this conversation'}</Link> : null}
  </div>;
}
