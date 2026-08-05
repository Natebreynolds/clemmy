/**
 * NowStrip — a live one-line-per-run rail of what the daemon is working on,
 * above the Tasks board.
 *
 * It renders the SERVER activity projection and decides nothing itself. It used
 * to subscribe to the raw telemetry stream, fold events into its own lane map,
 * and drop lanes it judged stale after fifteen minutes — so the rail could show
 * work the server considered finished, hide work the server considered live,
 * and disagree with Slack and Discord about the same run. Membership, liveness,
 * counts, and the terminal now all come from /api/console/activity/v2.
 *
 * Clicking a row that maps to a board card opens the existing LiveTraceDrawer.
 */
import { useEffect, useMemo, useState } from 'react';
import { Radio, Users, Hand, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/cn';
import { usePoll } from '@/lib/poll';
import { activityCounts, elapsedLabel, listWorkingNow, type ActivityEntry } from '@/lib/activity';
import type { BoardCard } from '@/lib/board';

/** Matches the board's own poll: the rail and the cards move together. */
const POLL_MS = 4_000;

export function NowStrip({ cards, onOpen }: { cards: BoardCard[]; onOpen: (card: BoardCard) => void }) {
  const query = usePoll(['activity-working-now'], listWorkingNow, POLL_MS);
  const [nowMs, setNowMs] = useState(() => Date.now());

  // Tick only the elapsed LABEL. Nothing here may change which rows exist or
  // what state they are in — that is the server's call.
  useEffect(() => {
    const timer = window.setInterval(() => setNowMs(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const rows = query.data ?? [];

  const cardForEntry = useMemo(() => {
    return (entry: ActivityEntry): BoardCard | undefined =>
      cards.find((card) =>
        (!!entry.sessionId && card.sessionId === entry.sessionId)
        || (!!entry.taskId && card.id === entry.taskId)
        || (!!entry.runId && card.raw.runId === entry.runId));
  }, [cards]);

  if (rows.length === 0) return null;

  return (
    <section className="mb-4 rounded-lg border border-border bg-surface p-3" aria-label="Running now">
      <div className="mb-2 flex items-center gap-2 text-caption font-semibold uppercase tracking-wide text-faint">
        <Radio className="h-3.5 w-3.5 animate-breathe text-primary" />
        Now · {rows.length}
      </div>
      <ul className="flex flex-col gap-1.5">
        {rows.map((entry) => {
          const card = cardForEntry(entry);
          const clickable = !!card;
          const counts = activityCounts(entry);
          const stale = entry.liveness === 'stale';
          return (
            <li key={entry.runKey}>
              <div
                role={clickable ? 'button' : undefined}
                tabIndex={clickable ? 0 : undefined}
                onClick={clickable ? () => onOpen(card!) : undefined}
                onKeyDown={clickable ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onOpen(card!); } } : undefined}
                className={cn(
                  'flex items-center gap-2 rounded-md px-2 py-1.5 text-body',
                  clickable ? 'cursor-pointer hover:bg-hover' : 'cursor-default',
                )}
              >
                <span className="rounded-sm bg-subtle px-1.5 py-0.5 text-caption font-semibold text-muted">
                  {entry.origin || entry.kind}
                </span>
                <span className="min-w-0 flex-1 truncate font-medium text-fg">{entry.headline}</span>

                {entry.activity?.text && (
                  <span className="hidden max-w-[14rem] truncate text-caption text-primary sm:inline">
                    {entry.activity.text}
                  </span>
                )}

                {counts && (
                  <span className="inline-flex items-center gap-1 text-caption text-muted" title="settled of admitted">
                    <Users className="h-3 w-3" />{counts}
                  </span>
                )}

                {stale && (
                  <span className="inline-flex items-center gap-1 text-caption text-warning" title="the owner stopped renewing its lease">
                    <AlertTriangle className="h-3 w-3" />stalled
                  </span>
                )}

                {entry.needsAttention && !stale && (
                  <span className="inline-flex items-center gap-1 text-caption text-warning" title={entry.nextAction ?? 'needs you'}>
                    <Hand className="h-3 w-3" />
                  </span>
                )}

                <span className="w-9 shrink-0 text-right text-caption text-faint">
                  {elapsedLabel(entry.startedAt, nowMs)}
                </span>
              </div>

              {entry.nextAction && (
                <p className="ml-8 mt-0.5 truncate text-caption text-muted">{entry.nextAction}</p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
