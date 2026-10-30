import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/Button';
import { cn } from '@/lib/cn';
import { usePoll } from '@/lib/poll';
import { applyTidy, describeTidy, getTidyPlan, TIDY_INVALIDATIONS, TIDY_ROWS, type TidyClass, type TidyCounts, type TidyScope } from '@/lib/tidy';

/** Settings › Clean up: exact counts for what is stale and for everything,
 *  one button per class per scope, and "clear everything". Nothing is
 *  deleted — updates are read, asks cancelled, runs stopped, conversations
 *  archived. "Everything" asks once before it acts. */
export function CleanupCard() {
  const qc = useQueryClient();
  const stalePlan = usePoll(['tidy-plan', 'stale'], () => getTidyPlan('stale'), 60_000);
  const allPlan = usePoll(['tidy-plan', 'all'], () => getTidyPlan('all'), 60_000);
  const stale = (stalePlan.data as { counts: TidyCounts } | undefined)?.counts;
  const all = (allPlan.data as { counts: TidyCounts } | undefined)?.counts;
  const staleAvailable = Boolean(stale) && !stalePlan.isError;
  const allAvailable = Boolean(all) && !allPlan.isError;
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  // "Clear all" on one row reaches today's items too (a decision still in
  // play, a run that just stopped), so it asks once, like "everything" does.
  const [confirmRow, setConfirmRow] = useState<TidyClass | null>(null);
  const [outcome, setOutcome] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const actionOwner = useRef(false);
  const sum = (c?: TidyCounts) => (c ? c.updates + c.staleAsks + c.stuckRuns + c.oldConversations : 0);

  const run = async (classes: TidyClass[], scope: TidyScope, key: string) => {
    if (actionOwner.current || (scope === 'stale' ? !staleAvailable : !allAvailable)) return;
    actionOwner.current = true;
    setBusy(key);
    setOutcome(null);
    setConfirmAll(false);
    setConfirmRow(null);
    try {
      const { result } = await applyTidy(classes, scope);
      setOutcome({ tone: 'ok', text: describeTidy(result) });
      for (const k of TIDY_INVALIDATIONS) void qc.invalidateQueries({ queryKey: [k] });
    } catch (err) {
      setOutcome({ tone: 'error', text: err instanceof Error ? err.message : 'Could not tidy up right now.' });
    } finally {
      actionOwner.current = false;
      setBusy(null);
    }
  };

  return (
    <div className="rounded-lg border border-border bg-surface">
      {(stalePlan.isError || allPlan.isError) && <p role="alert" className="px-4 py-3 text-small text-muted">Clean-up counts couldn’t be refreshed. {stale || all ? 'Last loaded counts are shown; affected actions are unavailable until refreshed.' : 'The current counts are unknown.'} <Button size="sm" variant="link" onClick={() => { void stalePlan.refetch(); void allPlan.refetch(); }}>Retry counts</Button></p>}
      <ul className="divide-y divide-border">
        {TIDY_ROWS.map((row) => {
          const s = stale?.[row.id] ?? 0;
          const a = all?.[row.id] ?? 0;
          return (
            <li key={row.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <div className="text-body font-semibold text-fg">{row.label}</div>
                <div className="text-small text-muted">{row.note}</div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Button variant="secondary" size="sm" disabled={!staleAvailable || s === 0 || busy !== null} onClick={() => void run([row.id], 'stale', `${row.id}:stale`)}>
                  {busy === `${row.id}:stale` ? 'Clearing…' : `Clear stale${s > 0 ? ` (${s})` : ''}`}
                </Button>
                {confirmRow === row.id ? (
                  <>
                    <Button variant="danger" size="sm" disabled={!allAvailable || busy !== null} onClick={() => void run([row.id], 'all', `${row.id}:all`)}>
                      {busy === `${row.id}:all` ? 'Clearing…' : `Yes, clear ${a}`}
                    </Button>
                    <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => setConfirmRow(null)}>Keep</Button>
                  </>
                ) : (
                  <Button variant="secondary" size="sm" disabled={!allAvailable || a === 0 || busy !== null} onClick={() => setConfirmRow(row.id)}>
                    {`Clear all${a > 0 ? ` (${a})` : ''}`}
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-4 py-3">
        <div className={cn('min-w-0 flex-1 text-small text-muted', outcome?.tone === 'error' && 'text-danger')}>
          {outcome
            ? outcome.text
            : confirmAll
              ? `This clears every item above — ${sum(all)} in total, including today's. Updates are marked read, open asks are declined, stuck runs are stopped and old chats are archived; nothing is deleted.`
              : stalePlan.isError || allPlan.isError ? 'Refresh the counts to continue.' : stale && all
                ? (sum(all) === 0 ? 'Nothing to clear right now.' : 'Counts refresh every minute.')
                : 'Checking…'}
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="secondary" size="sm" disabled={!staleAvailable || sum(stale) === 0 || busy !== null} onClick={() => void run(TIDY_ROWS.map((r) => r.id), 'stale', 'all:stale')}>
            {busy === 'all:stale' ? 'Tidying…' : `Tidy up stale${sum(stale) > 0 ? ` (${sum(stale)})` : ''}`}
          </Button>
          {confirmAll ? (
            <>
              <Button variant="danger" size="sm" disabled={!allAvailable || busy !== null} onClick={() => void run(TIDY_ROWS.map((r) => r.id), 'all', 'all:all')}>
                {busy === 'all:all' ? 'Clearing…' : `Yes, clear ${sum(all)}`}
              </Button>
              <Button variant="ghost" size="sm" disabled={busy !== null} onClick={() => setConfirmAll(false)}>Keep</Button>
            </>
          ) : (
            <Button variant="secondary" size="sm" disabled={!allAvailable || sum(all) === 0 || busy !== null} onClick={() => setConfirmAll(true)}>
              Clear everything{sum(all) > 0 ? ` (${sum(all)})` : ''}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
