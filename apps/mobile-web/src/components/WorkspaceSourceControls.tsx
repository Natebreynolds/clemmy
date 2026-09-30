import { useRef, useState } from 'preact/hooks';
import { controlWorkspaceSource, getWorkspaceSourceControls, type WorkspaceSourceControlRequest, type WorkspaceSourceControlView } from '../lib/api';
import { useScreenData } from '../lib/use-screen-data';

type Command = { sourceId: string; request: WorkspaceSourceControlRequest };
export function WorkspaceSourceControls({ workspaceId, onOpenApprovals }: { workspaceId: string; onOpenApprovals: () => void }) {
  const [open, setOpen] = useState(false);
  return <details class="ws-source-controls" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>Saved source permissions</summary>
    {open && <SourceControlsBody key={workspaceId} workspaceId={workspaceId} onOpenApprovals={onOpenApprovals} />}
  </details>;
}
function SourceControlsBody({ workspaceId, onOpenApprovals }: { workspaceId: string; onOpenApprovals: () => void }) {
  const status = useScreenData(() => getWorkspaceSourceControls(workspaceId), { intervalMs: 10_000, resourceKey: workspaceId });
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
      if (!code || code >= 500) setRetry(command);
    } finally { await status.refresh(); lock.current = false; setBusy(false); }
  }
  return <div aria-busy={busy}>
    <p>Manage permission for scripts that refresh this Space.</p>
    {status.loading && <p role="status">Loading source status…</p>}
    {status.error && <p role="alert">Source status is unavailable. <button class="link-btn" onClick={() => void status.refresh()}>Reload status</button></p>}
    {error && <p class="ws-source-error" role="alert">{error}</p>}
    {retry && <button class="btn-quiet" disabled={busy} onClick={() => void send(retry)}>Retry same action</button>}
    {message && <p role="status">{message}</p>}
    {status.data?.sources.length === 0 && <p>No saved script sources.</p>}
    {status.data?.sources.map(source => <MobileSourceControlRow key={`${source.sourceId}:${source.run?.occurrenceId ?? ''}`}
      source={source} disabled={busy || status.stale || !!retry} onOpenApprovals={onOpenApprovals}
      onAction={(action, extra) => void send({ sourceId: source.sourceId, request: {
        controlId: crypto.randomUUID(), expectedRevision: source.revision, action, ...extra,
      } })} />)}
  </div>;
}
export function MobileSourceControlRow({ source, disabled, onOpenApprovals, onAction }: {
  source: WorkspaceSourceControlView; disabled: boolean; onOpenApprovals: () => void;
  onAction: (action: WorkspaceSourceControlRequest['action'], extra?: Pick<WorkspaceSourceControlRequest, 'note' | 'reviewedEffects'>) => void;
}) {
  const [closing, setClosing] = useState(false);
  const [checked, setChecked] = useState(false);
  const [note, setNote] = useState('');
  return <div class="ws-source-row">
    <div class="ws-source-title"><h3>{source.sourceId}</h3><span>{source.permission === 'active' ? 'Allowed' : source.permission === 'stopped' ? 'Stopped' : 'Permission needed'}</span></div>
    <p>{source.detail}</p>
    <div class="ws-source-actions">
      {source.canStop && <button class="btn-quiet" disabled={disabled} onClick={() => onAction('stop')}>Stop source</button>}
      {source.approvalId ? <button class="btn-quiet" onClick={onOpenApprovals}>Open permission review</button>
        : source.canReview && <button class="btn-quiet" disabled={disabled} onClick={() => onAction('review')}>Review permission</button>}
      {source.canResolve && !closing && <button class="btn-quiet" disabled={disabled} onClick={() => setClosing(true)}>Close stopped run…</button>}
    </div>
    {closing && source.canResolve && <form class="ws-source-close" onSubmit={event => { event.preventDefault(); if (checked && note.trim() && !disabled) onAction('resolve', { reviewedEffects: true, note: note.trim() }); }}>
      <p>Closing keeps the original result. It does not undo effects or run the source again. New runs need another permission review.</p>
      <label class="ws-source-check"><input type="checkbox" checked={checked} disabled={disabled} onChange={event => setChecked(event.currentTarget.checked)} />I checked this run’s effects</label>
      <label>What did you verify?<textarea maxLength={2000} required value={note} disabled={disabled} onInput={event => setNote(event.currentTarget.value)} /></label>
      <div class="ws-source-actions"><button type="submit" class="btn-quiet" disabled={disabled || !checked || !note.trim()}>Close stopped run</button><button type="button" class="link-btn" disabled={disabled} onClick={() => setClosing(false)}>Cancel</button></div>
    </form>}
  </div>;
}
