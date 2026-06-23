/**
 * Per-agent trace drawer for the multi-agent workspace. Lists an agent's
 * recent autonomy runs and, on selection, its event timeline. Reads the
 * run-events store via /api/console/agents/:slug/runs (events embedded),
 * so unlike the board's LiveTraceDrawer there's no live SSE pipe — agent
 * cycles are short, already-recorded daemon runs. Styled to match.
 */
import { useEffect, useMemo, useState } from 'react';
import { X, Wrench, CheckCircle2, AlertCircle, Cpu, Dot, Radio, Pencil, Pause, Play, Trash2 } from 'lucide-react';
import { getAgentRuns, updateAgent, deleteAgent, type AgentRun, type AgentSummary } from '@/lib/agents';
import { relativeTime } from '@/lib/inbox';
import { cn } from '@/lib/cn';
import { Button } from '@/components/ui/Button';
import { StatusPill, type Tone } from '@/components/ui/StatusPill';

function runTone(status: string): { tone: Tone; label: string } {
  if (status === 'completed') return { tone: 'success', label: 'Completed' };
  if (status === 'failed') return { tone: 'danger', label: 'Failed' };
  if (status === 'running' || status === 'queued') return { tone: 'live', label: 'Running' };
  if (status === 'awaiting_approval') return { tone: 'warning', label: 'Needs you' };
  return { tone: 'neutral', label: status };
}

const EVENT_ICON: Record<string, typeof Radio> = {
  tool_started: Wrench,
  status: Dot,
  error: AlertCircle,
};
function eventIcon(type: string): typeof Radio {
  if (type.startsWith('tool')) return Wrench;
  return EVENT_ICON[type] ?? Dot;
}

export function AgentTraceDrawer({
  agent,
  onClose,
  onEdit,
  onChanged,
}: {
  agent: AgentSummary;
  onClose: () => void;
  onEdit?: () => void;
  onChanged?: () => void;
}) {
  const [runs, setRuns] = useState<AgentRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const isPrimary = agent.slug === 'clementine';
  const togglePause = async () => {
    setBusy(true);
    try { await updateAgent(agent.slug, { autonomyEnabled: !agent.autonomyEnabled }); onChanged?.(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    setBusy(true);
    try { await deleteAgent(agent.slug); onChanged?.(); onClose(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); setBusy(false); }
  };

  useEffect(() => {
    let alive = true;
    setRuns(null); setError(null); setSelectedId(null);
    getAgentRuns(agent.slug, 20)
      .then((r) => { if (alive) { setRuns(r); setSelectedId(r[0]?.id ?? null); } })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [agent.slug]);

  const selected = useMemo(() => runs?.find((r) => r.id === selectedId) ?? null, [runs, selectedId]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-label={`Agent: ${agent.name}`}>
      <div className="absolute inset-0 bg-black/30 animate-fade-in" onClick={onClose} />
      <div className="relative flex h-full w-full max-w-xl flex-col border-l border-border bg-surface shadow-lg animate-fade-in">
        <header className="flex items-start justify-between gap-3 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              {agent.role && <span className="rounded-sm bg-subtle px-1.5 py-0.5 text-caption font-semibold text-muted">{agent.role}</span>}
              <StatusPill tone={agent.status === 'active' ? 'live' : agent.status === 'blocked' ? 'danger' : 'neutral'}>
                {agent.status}
              </StatusPill>
            </div>
            <h3 className="mt-1.5 truncate text-h3 text-fg">{agent.name}</h3>
            <p className="mt-0.5 text-caption text-faint">{agent.description}</p>
          </div>
          <button onClick={onClose} className="shrink-0 rounded-sm p-1.5 text-muted hover:bg-hover hover:text-fg" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </header>

        {agent.lastError && (
          <div className="border-b border-border bg-danger-tint px-5 py-2.5 text-caption text-danger">
            <AlertCircle className="mr-1.5 inline h-3.5 w-3.5" aria-hidden /> {agent.lastError}
          </div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto">
          {/* Run list */}
          <div className="border-b border-border px-5 py-3">
            <div className="mb-2 flex items-center gap-2 text-caption font-semibold uppercase tracking-wide text-faint">
              <Cpu className="h-3.5 w-3.5" aria-hidden /> Recent cycles
            </div>
            {error && <p className="text-body text-danger">Couldn't load runs: {error}</p>}
            {!error && runs === null && <p className="text-body text-faint">Loading…</p>}
            {!error && runs?.length === 0 && <p className="text-body text-faint">No autonomy runs yet for this agent.</p>}
            <ul className="space-y-1">
              {runs?.map((run) => {
                const t = runTone(run.status);
                return (
                  <li key={run.id}>
                    <button
                      type="button"
                      onClick={() => setSelectedId(run.id)}
                      className={cn('flex w-full items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-body hover:bg-hover',
                        run.id === selectedId && 'bg-subtle')}
                    >
                      <span className="min-w-0 truncate text-fg">{run.outputPreview || run.title || run.input || 'cycle'}</span>
                      <span className="flex shrink-0 items-center gap-2">
                        <span className="text-caption text-faint">{relativeTime(run.createdAt)}</span>
                        <StatusPill tone={t.tone}>{t.label}</StatusPill>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>

          {/* Selected run timeline */}
          {selected && (
            <div className="px-5 py-4">
              <div className="mb-2 text-caption font-semibold uppercase tracking-wide text-faint">Timeline</div>
              {selected.events.length === 0 ? (
                <p className="text-body text-faint">No events recorded for this cycle.</p>
              ) : (
                <ol className="space-y-2.5">
                  {selected.events.map((ev) => {
                    const Icon = eventIcon(ev.type);
                    const isErr = ev.type === 'error' || /error|fail/i.test(ev.message.slice(0, 12));
                    return (
                      <li key={ev.id} className="flex items-start gap-2.5">
                        <Icon className={cn('mt-0.5 h-4 w-4 shrink-0', isErr ? 'text-danger' : ev.type.startsWith('tool') ? 'text-primary' : 'text-faint')} />
                        <div className="min-w-0">
                          <span className="text-body text-fg">{ev.message}</span>
                          <span className="ml-2 text-caption text-faint">{relativeTime(ev.createdAt)}</span>
                        </div>
                      </li>
                    );
                  })}
                </ol>
              )}
              {selected.status === 'completed' && (
                <div className="mt-3 flex items-center gap-1.5 text-caption text-success">
                  <CheckCircle2 className="h-3.5 w-3.5" /> Cycle completed
                </div>
              )}
            </div>
          )}
        </div>

        <footer className="flex items-center justify-between gap-2 border-t border-border px-5 py-3">
          {confirmDelete ? (
            <>
              <span className="text-caption text-danger">Delete {agent.name}? This can't be undone.</span>
              <span className="flex items-center gap-2">
                <Button variant="secondary" size="sm" onClick={() => setConfirmDelete(false)} disabled={busy}>Cancel</Button>
                <Button variant="danger" size="sm" onClick={remove} disabled={busy}>Delete</Button>
              </span>
            </>
          ) : (
            <>
              <span className="flex items-center gap-2">
                <Button variant="secondary" size="sm" onClick={onEdit} disabled={busy || !onEdit}>
                  <Pencil className="h-3.5 w-3.5" /> Edit
                </Button>
                {!isPrimary && (
                  <Button variant="secondary" size="sm" onClick={togglePause} disabled={busy}>
                    {agent.autonomyEnabled ? <><Pause className="h-3.5 w-3.5" /> Pause</> : <><Play className="h-3.5 w-3.5" /> Resume</>}
                  </Button>
                )}
              </span>
              {!isPrimary && (
                <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(true)} disabled={busy} className="text-danger hover:bg-danger-tint">
                  <Trash2 className="h-3.5 w-3.5" /> Delete
                </Button>
              )}
            </>
          )}
        </footer>
      </div>
    </div>
  );
}
