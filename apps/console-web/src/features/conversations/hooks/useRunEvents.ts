import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { apiGet } from '@/lib/api';
import { runHarnessStream } from '@/lib/chat';
import type { HarnessEvent } from '@/lib/types';
import {
  endsTheRun,
  latestRunBoundary,
  observedRunStatus,
  runIsOver,
  runLivenessFromSteps,
  runStepsFor,
  type RunLiveness,
  type RunReadCoverage,
  type RunSessionLike,
} from '@/lib/run-presentation';
import { sessionKeys } from './keys';
import { rawId } from '../lib/ids';
import { advanceRunEventPage, appendRunEvents, recentEventsUrl, type RecentEventsPage, type StepBuffer } from '../lib/run-event-buffer';

/**
 * A run's events, for the run page.
 *
 * ONE READ PER STEP. A workflow run is one rail row and N eventlog sessions,
 * so the page reads every step and concatenates them in step order. Reading
 * only the row's own id gave the collapse representative's ledger and called
 * it the run's.
 *
 * WATCHING IS NOT STREAMING. `runHarnessStream` resolves on the composer's
 * terminals — `approval_requested`, `awaiting_user_input`,
 * `async_work_dispatched` — which are decisions about an input box, not the
 * end of a run. Treating one as the end froze a blocked run forever: still
 * labelled Running, elapsed stopped, every later event lost, and Stop removed
 * at the exact moment it was most needed. So the stream resolving only ends
 * the STREAM; the page then polls /events/recent until the server's own
 * `sessionStatus` genuinely leaves its active set.
 *
 * The buffers are per step and merge by seq rather than being replaced, so a
 * frame already on the page — a bridged child-session write, say — cannot
 * disappear when a later read comes back narrower.
 */
export interface RunEventsState {
  events: HarnessEvent[];
  liveness: RunLiveness;
  loading: boolean;
  error: string | null;
  coverage: RunReadCoverage;
}

/** The route caps a page at 500 (console-routes.ts), and orders seq ASC — so a
 *  single fetch of a long run returns its FIRST 500 events and silently drops
 *  the reply at the end. Page until the log is exhausted. */
const PAGE_LIMIT = 500;
/** ~10k events per step. Beyond this the page says it is showing only part. */
const MAX_PAGES = 20;
/** Events arrive one frame at a time; a live run would otherwise re-render the
 *  whole timeline per token. */
const FLUSH_MS = 120;
/** How often a run that is still going is re-read once its stream has closed. */
const WATCH_POLL_MS = 3_000;
/** How often the run ROW is re-read while the run has not settled but no step
 *  session is active — a workflow between two steps. Slower than the event
 *  poll because rebuilding a detail costs more than reading a tail. */
const ROW_POLL_MS = 10_000;
/** Two failed reads in a row before the page says the history is unreadable —
 *  one is usually a daemon bouncing, and it recovers on the next tick. */
const FAILURES_BEFORE_ERROR = 2;

export function useRunEvents(session: RunSessionLike): RunEventsState {
  const qc = useQueryClient();
  const steps = runStepsFor(session);
  const stepKey = steps.map((step) => step.id).join('|');

  const [events, setEvents] = useState<HarnessEvent[]>([]);
  const [observed, setObserved] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [coverage, setCoverage] = useState<RunReadCoverage>({
    steps: steps.length,
    read: 0,
    truncated: false,
  });
  const buffersRef = useRef(new Map<string, StepBuffer>());

  useEffect(() => {
    let cancelled = false;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const stepIds = stepKey ? stepKey.split('|') : [];
    const buffers = buffersRef.current;
    // A run that GAINED a step re-runs this effect. Keep the buffers it already
    // filled — re-reading resumes from each one's last seq — and drop only the
    // steps that are no longer part of this run.
    for (const id of [...buffers.keys()]) if (!stepIds.includes(id)) buffers.delete(id);
    const bufferFor = (id: string): StepBuffer => {
      const existing = buffers.get(id);
      if (existing) return existing;
      const fresh: StepBuffer = { events: [], maxSeq: 0, scanSeq: 0 };
      buffers.set(id, fresh);
      return fresh;
    };

    const readSteps = new Set<string>();
    const missingStepCoverage = session.kind === 'workflow' && !session.runSteps?.length;
    const knownStepsOnly = session.kind === 'workflow';
    const recordUnavailable = knownStepsOnly && session.runCoverage?.state !== 'available';
    const truncatedSteps = new Set<string>();
    let consecutiveFailures = 0;

    const flush = () => {
      flushTimer = null;
      if (cancelled) return;
      setEvents(stepIds.flatMap((id) => buffers.get(id)?.events ?? []));
      setLoading(false);
    };
    const scheduleFlush = () => {
      if (cancelled || flushTimer !== null) return;
      flushTimer = setTimeout(flush, FLUSH_MS);
    };
    const publishCoverage = () => {
      if (cancelled) return;
      setCoverage({ steps: stepIds.length, read: readSteps.size, truncated: missingStepCoverage || truncatedSteps.size > 0, knownStepsOnly, recordUnavailable });
    };
    const noteStatus = (id: string, status: string | undefined) => {
      if (cancelled || !status) return;
      setObserved((prev) => (prev[id] === status ? prev : { ...prev, [id]: status }));
    };
    const noteRead = (id: string) => {
      consecutiveFailures = 0;
      if (cancelled) return;
      setError(null);
      readSteps.add(id);
      publishCoverage();
    };
    const noteFailure = (err: unknown) => {
      consecutiveFailures += 1;
      if (cancelled || consecutiveFailures < FAILURES_BEFORE_ERROR) return;
      setError(err instanceof Error ? err.message : 'This run’s history could not be read.');
    };
    const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

    /** Read one step forward from wherever its buffer stopped, following the
     *  route's pages until the log is exhausted. `status` is the server's word
     *  on that session, or null when the read failed. */
    const readStep = async (id: string): Promise<{ status: string | null; sawFinal: boolean }> => {
      const buffer = bufferFor(id);
      const raw = rawId(id);
      let status: string | undefined;
      let sawFinal = false;
      try {
        for (let page = 0; page < MAX_PAGES; page += 1) {
          const data = await apiGet<RecentEventsPage>(recentEventsUrl(raw, buffer, PAGE_LIMIT));
          if (cancelled) return { status: null, sawFinal };
          status = data.sessionStatus ?? status;
          const batch = data.events ?? [];
          if (appendRunEvents(buffer, batch) > 0) scheduleFlush();
          const boundary = latestRunBoundary(buffer.events);
          sawFinal = boundary !== null && endsTheRun(boundary);
          const progress = advanceRunEventPage(buffer, data, PAGE_LIMIT);
          if (progress.complete) truncatedSteps.delete(id);
          else truncatedSteps.add(id);
          if (!progress.more) break;
        }
      } catch (err) {
        noteFailure(err);
        return { status: null, sawFinal };
      }
      noteRead(id);
      status = observedRunStatus(buffer.events, status ?? '');
      noteStatus(id, status);
      return { status, sawFinal };
    };

    const handles: Array<{ stop: () => void }> = [];

    /**
     * Follow one step to its REAL end. The stream resolving is not that end:
     * it resolves on an approval card and on dispatched async work too. So the
     * watch continues until either a genuinely final event lands
     * (conversation_completed / run_failed) or the session's own status leaves
     * the active set — polling /events/recent when the stream is gone.
     */
    const followStep = async (id: string) => {
      const buffer = bufferFor(id);
      let sawFinal = false;
      const handle = runHarnessStream(rawId(id), {
        sinceSeq: buffer.maxSeq,
        onEvent: (event) => {
          if (cancelled) return;
          if (appendRunEvents(buffer, [event]) > 0) scheduleFlush();
          const boundary = latestRunBoundary(buffer.events);
          sawFinal = boundary !== null && endsTheRun(boundary);
          if (boundary && !sawFinal) noteStatus(id, 'paused');
        },
      });
      handles.push(handle);
      await handle.promise;
      if (cancelled) return;
      if (sawFinal) { const result = await readStep(id); if (result.sawFinal) return; }
      while (!cancelled) {
        const result = await readStep(id);
        if (cancelled) return;
        if (result.sawFinal) return;
        if (result.status !== null && runIsOver(result.status)) return;
        await sleep(WATCH_POLL_MS);
      }
    };

    void (async () => {
      // Read every step first, so a multi-step run shows its whole ledger
      // before anything is followed, and so `loading` ends on real content
      // rather than on a timer.
      const reads = await Promise.all(stepIds.map((id) => readStep(id)));
      if (cancelled) return;
      if (flushTimer === null) flush();
      publishCoverage();

      // An unreadable step is followed too: its status is unknown, and
      // "unknown" is not "finished".
      const following = stepIds.filter((_id, i) => {
        const { status } = reads[i];
        return status === null || !runIsOver(status);
      });
      if (following.length === 0) return;
      await Promise.all(following.map((id) => followStep(id)));
      if (cancelled) return;
      // Every step has reached a terminal. The header's status and the rail's
      // row both come from the session row, so re-read it — and pick up any
      // step this run started while we were watching the previous one.
      void qc.invalidateQueries({ queryKey: sessionKeys.detail(session.id) });
      void qc.invalidateQueries({ queryKey: sessionKeys.lists() });
    })();

    return () => {
      cancelled = true;
      if (flushTimer) clearTimeout(flushTimer);
      for (const handle of handles) handle.stop();
    };
  }, [stepKey, session.id, session.kind, session.runCoverage?.state, qc]);

  const liveness = runLivenessFromSteps(steps, observed, session.status);

  // Between two steps of a workflow there is no active session to follow, and
  // the next step's session does not exist yet — so nothing above would ever
  // notice it appear. Keep asking for the row (whose status consults the
  // workflow's own run log) until the run genuinely settles.
  const waitingForNextStep = !liveness.live && !runIsOver(session.status);
  useEffect(() => {
    if (!waitingForNextStep) return;
    const timer = setInterval(() => {
      void qc.invalidateQueries({ queryKey: sessionKeys.detail(session.id) });
    }, ROW_POLL_MS);
    return () => clearInterval(timer);
  }, [waitingForNextStep, session.id, qc]);

  return { events, liveness, loading, error, coverage };
}
