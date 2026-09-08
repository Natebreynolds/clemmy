import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowUpRight, MessageSquare } from 'lucide-react';
import { RunHeader } from '@/components/run/RunHeader';
import { RunSection } from '@/components/run/RunSection';
import { RunTimeline } from '@/components/run/RunTimeline';
import { RunWriteLedger } from '@/components/run/RunWriteLedger';
import { linkify } from '@/lib/linkify';
import { usePoll } from '@/lib/poll';
import {
  getBackgroundTaskDetail,
  listForegroundTaskControls,
  runBoardAction,
} from '@/lib/board';
import {
  backgroundTaskIdForRun,
  conversationHref,
  foldRunDeliverables,
  runActivityItems,
  runCoverageNotice,
  runElapsedLabel,
  runEmptyStateText,
  runFinalReply,
  runLedgerIsComplete,
  runStatusMeta,
  runStepsFor,
  runStepsLabel,
  runWriteRows,
  runWriteSummary,
  stoppableRunCard,
} from '@/lib/run-presentation';
import { useRunEvents } from '../hooks/useRunEvents';
import { useSessionMutations } from '../hooks/useSessionMutations';
import { originMeta } from '../lib/origin';
import type { Session } from '../types';

/**
 * A run, as a page.
 *
 * A workflow / execution / agent session used to land here as chat bubbles
 * behind a lock icon: the console rendered work as if it were talk. It is not
 * talk. The order below is the order of the questions a person actually has
 * about work done on their behalf, and it is the same order the phone already
 * uses (apps/mobile-web/src/screens/Run.tsx) so the two surfaces cannot tell
 * the owner different stories about the same run:
 *
 *   what did it change out there  → the write ledger, first and unignorable
 *   what did it leave me          → deliverables
 *   what did it tell me           → the final reply
 *   how did it get there          → the narrated timeline, folded once settled
 */
const TICK_MS = 1_000;
const STOP_CONTROLS_POLL_MS = 5_000;

export function RunThread({ session }: { session: Session }) {
  const qc = useQueryClient();
  const mutations = useSessionMutations();
  const { events, liveness, loading, error, coverage } = useRunEvents(session);
  const { live, over } = liveness;
  const [stopping, setStopping] = useState(false);
  const [stopNotice, setStopNotice] = useState<string | null>(null);

  // A live elapsed counter is the cheapest honest signal that work is still
  // moving. It stops the moment the run does.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!live) return;
    const timer = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(timer);
  }, [live]);

  // One object so every section below reads the same liveness, and so the
  // memos key off primitives rather than a fresh object per render.
  const run = useMemo(
    () => ({ live, over, status: liveness.status }),
    [live, over, liveness.status],
  );
  const steps = runStepsFor(session);
  const stepsLabel = runStepsLabel(steps);

  const writes = useMemo(() => runWriteRows(events, run), [events, run]);
  const deliverables = useMemo(() => foldRunDeliverables(events), [events]);
  const reply = useMemo(() => runFinalReply(events), [events]);
  const activity = useMemo(() => runActivityItems(events, run), [events, run]);
  const coverageNotice = runCoverageNotice(coverage);
  const ledgerIsWhole = runLedgerIsComplete(run, coverage);
  const emptyText = runEmptyStateText({
    loading,
    failed: Boolean(error),
    eventCount: events.length,
    coverage,
  });

  const startedAt = events[0]?.createdAt ?? session.createdAt;
  const lastEventAt = events[events.length - 1]?.createdAt ?? session.updatedAt;
  const elapsed = runElapsedLabel(startedAt, lastEventAt, live, now);

  // Stop authority is the board's to grant, and only for an exactly identified
  // card — see stoppableRunCard. It is withheld once the run has REACHED A
  // TERMINAL, never merely because no work is happening this instant: a run
  // parked on an approval is exactly when Stop matters most.
  const controls = usePoll(
    ['run-stop-controls'],
    listForegroundTaskControls,
    STOP_CONTROLS_POLL_MS,
    { enabled: !over },
  );
  const stopCard = over ? undefined : stoppableRunCard(session.id, controls.data?.cards ?? []);

  const stop = async () => {
    if (!stopCard) return;
    setStopping(true);
    setStopNotice(null);
    try {
      const result = await runBoardAction(stopCard, 'cancel');
      if (!result.ok) setStopNotice(result.reason || 'That run is no longer stoppable.');
    } catch (err) {
      setStopNotice(err instanceof Error ? err.message : 'Could not stop this run. Try again.');
    } finally {
      setStopping(false);
      void qc.invalidateQueries({ queryKey: ['run-stop-controls'] });
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <RunHeader
        title={session.title || 'Run'}
        originLabel={originMeta(session.origin).label}
        status={runStatusMeta(run.status)}
        steps={stepsLabel}
        elapsed={elapsed}
        pinned={session.pinned}
        onTogglePin={() => mutations.setPinned(session.id, !session.pinned)}
        {...(stopCard ? { onStop: () => void stop() } : {})}
        stopping={stopping}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-3xl space-y-3 px-6 py-6">
          {stopNotice && (
            <p className="rounded-md border border-warning bg-warning-tint px-3 py-2 text-body text-fg">
              {stopNotice}
            </p>
          )}
          {error && (
            <p className="rounded-md border border-border bg-subtle px-3 py-2 text-body text-muted">{error}</p>
          )}
          {coverageNotice && (
            <p className="rounded-md border border-warning bg-warning-tint px-3 py-2 text-body text-fg">
              {coverageNotice}
            </p>
          )}

          <RunWriteLedger rows={writes} summary={runWriteSummary(writes)} settled={ledgerIsWhole} />

          {deliverables.length > 0 && (
            <RunSection title="What it produced" meta={`${deliverables.length} file${deliverables.length === 1 ? '' : 's'}`}>
              <ul className="space-y-3">
                {deliverables.map((file) => (
                  <li key={file.key}>
                    <p className="text-body text-fg">{file.name}</p>
                    {file.dir && <p className="text-caption text-muted">in {file.dir}</p>}
                    {file.excerpt && (
                      <pre className="mt-1.5 overflow-x-auto rounded-sm bg-subtle px-2.5 py-2 text-caption text-muted">
                        {file.excerpt}
                      </pre>
                    )}
                  </li>
                ))}
              </ul>
            </RunSection>
          )}

          {reply && (
            <RunSection title="What it reported">
              <p className="whitespace-pre-wrap text-body text-fg">{linkify(reply)}</p>
            </RunSection>
          )}

          <RunTimeline items={activity} live={live} />

          {loading && events.length === 0 && (
            <p className="py-8 text-center text-body text-faint">Reading this run…</p>
          )}
          {emptyText && <p className="py-8 text-center text-body text-faint">{emptyText}</p>}
        </div>
      </div>
      <RunFooter session={session} />
    </div>
  );
}

/**
 * Where a run leads. A background run's session id carries its task id, and
 * the task knows the conversation it was dispatched from — so that link is
 * real and is offered. A workflow or agent run carries no origin on the public
 * plane, so no origin link is invented for it; it still leads somewhere,
 * because a new chat about it is always an available next move.
 */
function RunFooter({ session }: { session: Session }) {
  const taskId = backgroundTaskIdForRun(session.id);
  const task = usePoll(
    ['run-origin', session.id],
    () => getBackgroundTaskDetail(taskId!),
    0,
    { enabled: Boolean(taskId) },
  );
  const originSessionId = task.data?.task.originSessionId;

  return (
    <div className="border-t border-border bg-subtle px-5 py-2.5">
      <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center gap-x-4 gap-y-1">
        {originSessionId && (
          <Link
            to={conversationHref(originSessionId)}
            className="inline-flex items-center gap-1.5 text-small text-primary hover:underline"
          >
            <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
            The conversation that started this
          </Link>
        )}
        <Link
          to="/chat"
          state={{ newChat: Date.now() }}
          className="inline-flex items-center gap-1.5 text-small text-muted transition-colors hover:text-fg"
        >
          <MessageSquare className="h-3.5 w-3.5" aria-hidden />
          Start a chat about this run
        </Link>
      </div>
    </div>
  );
}
