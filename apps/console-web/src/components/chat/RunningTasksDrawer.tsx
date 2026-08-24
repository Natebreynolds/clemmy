import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { Asterisk, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { StatusPill, type Tone } from '@/components/ui/StatusPill';
import { usePoll } from '@/lib/poll';
import {
  listForegroundWorkingNowSnapshot,
  type ForegroundActivityEntry,
} from '@/lib/activity';
import {
  listForegroundTaskControls,
  runBoardAction,
  type BoardButtonIntent,
  type BoardCard,
} from '@/lib/board';
import {
  boardCardForActivity,
  runningTaskActions,
  serverElapsedLabel,
} from '@/lib/running-tasks';
import { cn } from '@/lib/cn';

const POLL_MS = 4_000;
const MAX_RENDERED_TASKS = 12;

export function RunningTasksDrawer({
  className,
  composerRef,
}: {
  className?: string;
  composerRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const qc = useQueryClient();
  const activity = usePoll(['chat-running-tasks'], listForegroundWorkingNowSnapshot, POLL_MS);
  const board = usePoll(['chat-running-task-controls'], listForegroundTaskControls, POLL_MS);
  const [open, setOpen] = useState(false);
  const [confirmStop, setConfirmStop] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const rows = (activity.data?.entries ?? []).slice(0, MAX_RENDERED_TASKS);
  const total = activity.data?.entries.length ?? 0;
  const cards = useMemo(() => board.data?.cards ?? [], [board.data]);

  const close = useCallback(() => {
    setOpen(false);
    setConfirmStop(null);
    setNotice(null);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { close(); return; }
      if (event.key !== 'Tab' || !panelRef.current) return;
      const focusable = [...panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])',
      )];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault(); first.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close, open]);

  useEffect(() => {
    if (open && total === 0 && !activity.isLoading) {
      setOpen(false);
      setConfirmStop(null);
      setNotice(null);
      window.requestAnimationFrame(() => composerRef.current?.focus());
    }
  }, [activity.isLoading, composerRef, open, total]);

  if (total === 0) return null;

  const act = async (entry: ForegroundActivityEntry, card: BoardCard, intent: BoardButtonIntent) => {
    const key = `${entry.runKey}:${intent}`;
    setBusy(key);
    setNotice(null);
    try {
      const result = await runBoardAction(card, intent);
      if (!result.ok) setNotice(result.reason || 'That action is no longer available.');
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'That action did not go through.');
    } finally {
      setBusy(null);
      setConfirmStop(null);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['chat-running-tasks'] }),
        qc.invalidateQueries({ queryKey: ['activity-working-now'] }),
        qc.invalidateQueries({ queryKey: ['chat-running-task-controls'] }),
      ]);
    }
  };

  return (
    <div className={cn('flex', className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
        className="inline-flex min-h-11 items-center gap-2 rounded-md px-2 text-small font-medium text-muted transition-colors hover:bg-hover hover:text-fg cursor-pointer"
      >
        <Asterisk className="h-4 w-4 text-primary" aria-hidden />
        <span aria-live="polite">{total} current {total === 1 ? 'task' : 'tasks'}</span>
      </button>

      {open && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-stretch sm:justify-end" role="dialog" aria-modal="true" aria-labelledby="chat-running-tasks-title">
          <button type="button" aria-label="Close running tasks" className="absolute inset-0 bg-black/35" onClick={close} />
          <section
            ref={panelRef}
            className="relative flex max-h-[86dvh] w-full flex-col rounded-t-xl border border-border bg-surface shadow-lg sm:h-full sm:max-h-none sm:max-w-md sm:rounded-none sm:border-y-0 sm:border-r-0"
          >
            <header className="flex items-center justify-between gap-3 border-b border-border px-5 py-4">
              <div>
                <h2 id="chat-running-tasks-title" className="text-h3 text-fg">Background tasks</h2>
                <p className="mt-0.5 text-caption text-faint">Current · {total}</p>
              </div>
              <Button ref={closeRef} size="icon" variant="ghost" className="h-11 w-11" aria-label="Close" onClick={close}>
                <X className="h-4 w-4" aria-hidden />
              </Button>
            </header>

            <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] overscroll-contain sm:p-4">
              {notice && <p role="status" className="rounded-md bg-danger-tint px-3 py-2 text-small text-danger">{notice}</p>}
              {rows.map((entry) => {
                const card = boardCardForActivity(entry, cards);
                const actions = runningTaskActions(entry, card);
                const elapsed = serverElapsedLabel(entry.startedAt, activity.data?.observedAt ?? entry.lastEvidenceAt);
                const stopping = confirmStop === entry.runKey;
                return (
                  <article key={entry.runKey} className="rounded-lg border border-border bg-canvas p-4">
                    <div className="flex items-start gap-3">
                      <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-primary" aria-hidden />
                      <div className="min-w-0 flex-1">
                        <h3 className="truncate text-body font-semibold text-fg">{entry.headline}</h3>
                        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-caption text-faint">
                          <span>{kindLabel(entry.kind)}</span>
                          <StatusPill tone={entryTone(entry)}>{lifecycleLabel(entry.lifecycle)}</StatusPill>
                          {elapsed && <span>{elapsed}</span>}
                        </div>
                      </div>
                    </div>

                    <TaskFacts entry={entry} />

                    <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
                      {actions.openHref && (
                        <Link to={actions.openHref} onClick={close} className="inline-flex min-h-11 items-center rounded-md border border-border px-3 text-small font-semibold text-fg hover:bg-hover">
                          {actions.openLabel}
                        </Link>
                      )}
                      {actions.resume && card && (
                        <Button
                          size="sm"
                          variant="secondary"
                          className="min-h-11"
                          disabled={busy !== null}
                          onClick={() => void act(entry, card, actions.resume!)}
                        >
                          {busy === `${entry.runKey}:${actions.resume}` ? 'Resuming…' : 'Resume'}
                        </Button>
                      )}
                      {actions.stop && card && !stopping && (
                        <Button size="sm" variant="ghost" className="min-h-11" disabled={busy !== null} onClick={() => setConfirmStop(entry.runKey)}>Stop</Button>
                      )}
                      {actions.stop && card && stopping && (
                        <>
                          <span className="text-caption text-muted">Stop this task?</span>
                          <Button
                            size="sm"
                            variant="danger"
                            className="min-h-11"
                            disabled={busy !== null}
                            onClick={() => void act(entry, card, actions.stop!)}
                          >
                            {busy === `${entry.runKey}:${actions.stop}` ? 'Stopping…' : 'Stop'}
                          </Button>
                          <Button size="sm" variant="ghost" className="min-h-11" disabled={busy !== null} onClick={() => setConfirmStop(null)}>Keep running</Button>
                        </>
                      )}
                    </div>
                  </article>
                );
              })}
              {total > rows.length && <p className="text-center text-caption text-faint">+{total - rows.length} more</p>}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

function TaskFacts({ entry }: { entry: ForegroundActivityEntry }) {
  const progress = entry.progress && entry.progress.total > 0
    ? `${entry.progress.completed}/${entry.progress.total}`
    : '';
  const workers = entry.children && entry.children.total > 0
    ? [
        `${entry.children.running} running`,
        `${entry.children.completed}/${entry.children.total} done`,
        entry.children.failed > 0 ? `${entry.children.failed} failed` : '',
      ].filter(Boolean).join(' · ')
    : '';
  if (!entry.activity && !progress && !workers) return null;
  return (
    <dl className="mt-3 grid grid-cols-[auto,minmax(0,1fr)] gap-x-4 gap-y-1 border-t border-border pt-3 text-caption">
      {entry.activity && <><dt className="text-faint">Phase</dt><dd className="text-right font-medium text-muted">{entry.activity.text}</dd></>}
      {progress && <><dt className="text-faint">Progress</dt><dd className="text-right font-medium text-muted">{progress}</dd></>}
      {workers && <><dt className="text-faint">Workers</dt><dd className="text-right font-medium text-muted">{workers}</dd></>}
    </dl>
  );
}

function kindLabel(kind: ForegroundActivityEntry['kind']): string {
  if (kind === 'background') return 'Task';
  if (kind === 'workflow') return 'Workflow';
  if (kind === 'fanout') return 'Plan';
  return 'Chat';
}

function lifecycleLabel(lifecycle: string): string {
  const labels: Record<string, string> = {
    accepted: 'Accepted', queued: 'Queued', reasoning: 'Running', retrieving: 'Reading',
    using_tool: 'Running', fanout: 'Running', reducing: 'Combining', verifying: 'Verifying',
    awaiting_input: 'Waiting for input', awaiting_approval: 'Waiting for approval',
    paused_budget: 'Stopped', retrying: 'Retrying', completing: 'Finishing', blocked: 'Needs review',
  };
  return labels[lifecycle] ?? 'Status unavailable';
}

function entryTone(entry: ForegroundActivityEntry): Tone {
  if (entry.needsAttention || entry.liveness === 'stale') return 'warning';
  return entry.lifecycle === 'queued' || entry.lifecycle === 'accepted' ? 'neutral' : 'live';
}
