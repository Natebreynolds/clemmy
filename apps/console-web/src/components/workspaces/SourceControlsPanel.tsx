import { useRef, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { usePoll } from '@/lib/poll';
import { controlWorkspaceSource, getWorkspaceSourceControls,
  type WorkspaceSourceControlRequest, type WorkspaceSourceControlView } from '@/lib/spaces';

type Command = { sourceId: string; request: WorkspaceSourceControlRequest };
export function SourceControlsPanel({ workspaceId, onOpenApprovals }: { workspaceId: string; onOpenApprovals: () => void }) {
  const status = usePoll(['source-controls', workspaceId], () => getWorkspaceSourceControls(workspaceId), 10_000);
  const lock = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState<Command | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  async function send(command: Command) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(null); setMessage(null); setRetry(null);
    try {
      const result = await controlWorkspaceSource(workspaceId, command.sourceId, command.request);
      setMessage(result.pendingApprovalId ? 'Permission review is ready in Needs you. This source has not been approved yet.'
        : command.request.action === 'stop' ? 'Source stopped. Any running work is being cancelled.'
        : command.request.action === 'resolve' ? 'Run closed. Its original result is kept; no effects were undone.' : 'Source status updated.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not confirm this action.');
      const code = (err as { status?: number } | null)?.status;
      // An uncertain HTTP outcome retries the exact command, never a new run.
      if (!code || code >= 500) setRetry(command);
    } finally {
      await status.refetch(); lock.current = false; setBusy(false);
    }
  }
  return <section className="rounded-md border border-border bg-surface p-3" aria-label="Saved source controls" aria-busy={busy}>
    <h3 className="text-small font-semibold text-fg">Saved sources</h3>
    <p className="mt-1 text-small text-muted">Manage permission for scripts that refresh this Space.</p>
    {status.isPending && <p className="mt-3 text-small text-muted" role="status">Loading source status…</p>}
    {status.error && <div className="mt-3 text-small text-warning" role="alert">Source status is unavailable. <Button variant="link" size="sm" onClick={() => void status.refetch()}>Reload status</Button></div>}
    {error && <p className="mt-3 text-small text-warning" role="alert">{error}</p>}
    {retry && <Button variant="secondary" size="sm" className="mt-2" disabled={busy} onClick={() => void send(retry)}>Retry same action</Button>}
    {message && <p className="mt-3 text-small text-muted" role="status">{message}</p>}
    {status.data?.sources.length === 0 && <p className="mt-3 text-small text-muted">No saved script sources.</p>}
    {status.data?.sources.map(source => <SourceControlRow key={`${source.sourceId}:${source.run?.occurrenceId ?? ''}`}
      source={source} disabled={busy || !!status.error || !!retry} onOpenApprovals={onOpenApprovals}
      onAction={(action, extra) => void send({ sourceId: source.sourceId, request: {
        controlId: crypto.randomUUID(), expectedRevision: source.revision, action, ...extra,
      } })} />)}
  </section>;
}

export function SourceControlRow({ source, disabled, onOpenApprovals, onAction }: {
  source: WorkspaceSourceControlView; disabled: boolean; onOpenApprovals: () => void;
  onAction: (action: WorkspaceSourceControlRequest['action'], extra?: Pick<WorkspaceSourceControlRequest, 'note' | 'reviewedEffects'>) => void;
}) {
  const [closing, setClosing] = useState(false);
  const [checked, setChecked] = useState(false);
  const [note, setNote] = useState('');
  return <div className="mt-4 border-t border-border pt-3">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h4 className="min-w-0 break-words text-small font-semibold text-fg">{source.sourceId}</h4>
      <span className="text-caption text-muted">{source.permission === 'active' ? 'Allowed' : source.permission === 'stopped' ? 'Stopped' : 'Permission needed'}</span>
    </div>
    <p className="mt-1 break-words text-small text-muted">{source.detail}</p>
    <div className="mt-3 flex flex-wrap gap-2">
      {source.canStop && <Button size="sm" variant="secondary" disabled={disabled} onClick={() => onAction('stop')}>Stop source</Button>}
      {source.approvalId ? <Button size="sm" variant="secondary" onClick={onOpenApprovals}>Open permission review</Button>
        : source.canReview && <Button size="sm" variant="secondary" disabled={disabled} onClick={() => onAction('review')}>Review permission</Button>}
      {source.canResolve && !closing && <Button size="sm" variant="secondary" disabled={disabled} onClick={() => setClosing(true)}>Close stopped run…</Button>}
    </div>
    {closing && source.canResolve && <form className="mt-4 space-y-3" onSubmit={e => { e.preventDefault(); if (checked && note.trim() && !disabled) onAction('resolve', { reviewedEffects: true, note: note.trim() }); }}>
      <p className="text-small text-muted">Closing keeps the original result. It does not undo effects or run the source again. New runs need another permission review.</p>
      <label className="flex min-h-11 items-center gap-2 text-small text-fg"><input type="checkbox" checked={checked} disabled={disabled} onChange={e => setChecked(e.target.checked)} />I checked this run’s effects</label>
      <label className="block text-small text-fg">What did you verify?
        <textarea className="mt-1 block min-h-24 w-full resize-y rounded-md border border-border bg-surface px-3 py-2 text-small text-fg" maxLength={2000} required value={note} disabled={disabled} onChange={e => setNote(e.target.value)} />
      </label>
      <div className="flex flex-wrap gap-2"><Button size="sm" type="submit" disabled={disabled || !checked || !note.trim()}>Close stopped run</Button><Button size="sm" variant="ghost" disabled={disabled} onClick={() => setClosing(false)}>Cancel</Button></div>
    </form>}
  </div>;
}
