import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Loader2, MoonStar } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import {
  decideMissedRun, dismissMissedRuns, dueWords, getMissedRuns, missedRunInMotion, missedRunState, startWorkflowRun,
  type MissedNotice,
} from '@/lib/missed-runs';

const toneClass = { muted: 'text-muted', working: 'text-muted', done: 'text-success', ask: 'text-warning', fail: 'text-danger' } as const;

/** Scheduled runs that came due while Clementine was closed: tick the ones to
 *  run now (each counts from now), or skip them, then watch them go. */
export function MissedRunsCard() {
  const missed = useQuery({
    queryKey: ['missed-runs'],
    queryFn: getMissedRuns,
    refetchInterval: (query) => (query.state.data?.notices.some((notice) => notice.items.some(missedRunInMotion)) ? 3_000 : 30_000),
  });
  const notices = missed.data?.notices ?? [];
  if (notices.length === 0) return null;
  return <div className="flex flex-col gap-2">{notices.map((notice) => <MissedNoticeCard key={notice.id} notice={notice} />)}</div>;
}

function MissedNoticeCard({ notice }: { notice: MissedNotice }) {
  const qc = useQueryClient();
  const open = notice.items.filter((item) => !item.decision);
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState<'run' | 'skip' | 'dismiss' | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const refresh = () => qc.invalidateQueries({ queryKey: ['missed-runs'] });
  const checked = open.filter((item) => !unchecked.has(item.workflow));
  const moving = notice.items.some(missedRunInMotion);

  const runChecked = async () => {
    setBusy('run'); setErrors({});
    for (const item of checked) {
      try {
        const started = await startWorkflowRun(item.workflow);
        if (!started.id) throw new Error('It could not start right now.');
        await decideMissedRun(notice.id, item.workflow, 'run', started.id);
      } catch (error) {
        setErrors((all) => ({ ...all, [item.workflow]: error instanceof Error ? error.message : String(error) }));
      }
    }
    setBusy(null);
    await refresh();
  };
  const skipOpen = async () => {
    setBusy('skip');
    for (const item of open) {
      try { await decideMissedRun(notice.id, item.workflow, 'skip'); } catch { /* the row stays open to try again */ }
    }
    setBusy(null);
    await refresh();
  };
  const dismiss = async () => {
    setBusy('dismiss');
    try { await dismissMissedRuns(notice.id); } finally { setBusy(null); await refresh(); }
  };

  return (
    <section aria-label="Runs missed while Clementine was closed" className="rounded-xl border border-border bg-surface px-4 py-3.5 shadow-xs">
      <div className="flex items-start gap-2.5">
        <MoonStar className="mt-0.5 h-5 w-5 shrink-0 text-muted" aria-hidden />
        <div className="min-w-0 flex-1">
          <h3 className="text-body font-semibold text-fg">
            {open.length > 0 ? 'While you were away, these didn’t run' : 'Missed while you were away'}
          </h3>
          {open.length > 0 && <p className="text-small text-muted">Pick what to run now. A run started now counts from now.</p>}
        </div>
      </div>
      <ul className="mt-2.5 divide-y divide-border">
        {notice.items.map((item) => {
          const state = missedRunState(item);
          const decided = Boolean(item.decision);
          const runId = item.decision?.action === 'run' ? item.decision.runId : null;
          return (
            <li key={item.workflow} className="flex flex-wrap items-center gap-2 py-2">
              {decided ? (
                state?.tone === 'done'
                  ? <Check className="h-4 w-4 shrink-0 text-success" aria-hidden />
                  : state?.tone === 'working'
                    ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted motion-reduce:animate-none" aria-hidden />
                    : <span className="h-4 w-4 shrink-0" aria-hidden />
              ) : (
                <input type="checkbox" className="h-4 w-4 shrink-0 accent-primary" checked={!unchecked.has(item.workflow)} disabled={busy !== null}
                  aria-label={`Run ${item.name} now`}
                  onChange={() => setUnchecked((all) => { const next = new Set(all); if (next.has(item.workflow)) next.delete(item.workflow); else next.add(item.workflow); return next; })} />
              )}
              <span className="min-w-0 flex-1">
                <span className="text-body text-fg">{item.name}</span>
                <span className="text-small text-muted"> · due {dueWords(item.dueAt)}{item.times > 1 ? ` · missed ${item.times} times` : ''}</span>
                {errors[item.workflow] && <span className="block text-small text-danger">{errors[item.workflow]}</span>}
              </span>
              {state && <span className={cn('text-small font-semibold', toneClass[state.tone])}>{state.text}</span>}
              {runId && (
                <Link to={`/automate?workflow=${encodeURIComponent(item.workflow)}&run=${encodeURIComponent(runId)}`}
                  className="text-small font-semibold text-primary hover:underline">Open run</Link>
              )}
            </li>
          );
        })}
      </ul>
      <div className="mt-2.5 flex flex-wrap items-center gap-2">
        {open.length > 0 ? (
          <>
            <Button size="sm" disabled={busy !== null || checked.length === 0} onClick={() => { void runChecked(); }}>
              {busy === 'run' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />}
              {checked.length === open.length ? 'Run now' : `Run ${checked.length} now`}
            </Button>
            <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => { void skipOpen(); }}>
              {open.length === notice.items.length ? 'Skip' : 'Skip the rest'}
            </Button>
          </>
        ) : !moving && (
          <Button size="sm" variant="secondary" disabled={busy !== null} onClick={() => { void dismiss(); }}>Done</Button>
        )}
      </div>
    </section>
  );
}
