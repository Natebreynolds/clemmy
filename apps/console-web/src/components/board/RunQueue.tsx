/**
 * The expandable SUB-TASK QUEUE under a workflow-run card. Lazily fetches
 * GET /api/console/board/run/:slug/:runId/queue (reconstructed from the durable
 * event log) so a campaign card shows its real queue — each step/forEach unit
 * with status (done / running / failed / queued / blocked), forEach progress,
 * and which step runs NEXT — instead of one opaque "running" pill.
 */
import { useState } from 'react';
import { ChevronRight, ChevronDown, Check, Radio, AlertTriangle, Circle, Lock, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/cn';
import { getRunQueue, type RunQueue as RunQueueT, type RunQueueStepStatus } from '@/lib/board';

const STATUS_META: Record<RunQueueStepStatus, { Icon: LucideIcon; cls: string }> = {
  done: { Icon: Check, cls: 'text-success' },
  running: { Icon: Radio, cls: 'text-primary animate-breathe' },
  failed: { Icon: AlertTriangle, cls: 'text-danger' },
  queued: { Icon: Circle, cls: 'text-muted' },
  blocked: { Icon: Lock, cls: 'text-faint' },
};

export function RunQueue({ slug, runId }: { slug: string; runId: string }) {
  const [open, setOpen] = useState(false);
  const [queue, setQueue] = useState<RunQueueT | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    // Lazy-load on first expand; refresh on each re-expand so a live run updates.
    if (next) {
      setLoading(true);
      setErr(null);
      try { setQueue(await getRunQueue(slug, runId)); }
      catch (e) { setErr(e instanceof Error ? e.message : 'failed to load queue'); }
      finally { setLoading(false); }
    }
  };

  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={toggle}
        onPointerDown={(e) => e.stopPropagation()}
        className="inline-flex items-center gap-1 text-caption font-semibold text-muted hover:text-fg focus:text-fg"
      >
        {open ? <ChevronDown className="h-3 w-3" aria-hidden /> : <ChevronRight className="h-3 w-3" aria-hidden />}
        {queue ? `Task queue · ${queue.doneCount}/${queue.totalCount} done` : 'View task queue'}
      </button>

      {open && (
        <div className="mt-1.5 space-y-1 border-l border-border pl-2">
          {loading && <p className="text-caption text-faint">Loading queue…</p>}
          {err && <p className="text-caption text-danger">{err}</p>}
          {queue && !loading && queue.steps.length === 0 && (
            <p className="text-caption text-faint">No queued tasks yet.</p>
          )}
          {queue?.steps.map((s) => {
            const meta = STATUS_META[s.status];
            const Icon = meta.Icon;
            return (
              <div
                key={s.stepId}
                className={cn('flex items-start gap-1.5 text-caption', s.isNext && 'font-semibold text-fg')}
              >
                <Icon className={cn('mt-0.5 h-3 w-3 shrink-0', meta.cls)} aria-hidden />
                <span className={cn('flex-1 line-clamp-1', s.isNext ? 'text-fg' : 'text-muted')}>{s.title}</span>
                {s.itemsTotal ? (
                  <span className="shrink-0 tabular-nums text-faint">{s.itemsDone ?? 0}/{s.itemsTotal}</span>
                ) : null}
                {s.itemsFailed ? (
                  <span className="shrink-0 tabular-nums text-danger">{s.itemsFailed} failed</span>
                ) : null}
                {s.isNext && <span className="shrink-0 text-primary">next</span>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
