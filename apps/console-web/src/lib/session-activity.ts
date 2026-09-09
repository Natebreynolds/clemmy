/**
 * One session's event stream as activity rows — the seam that lets ANY run
 * (a workflow run, an authoring session, a background task) feed the same
 * ActivityCard the chat reply uses. Frames are folded through the chat's own
 * reducer, so a tool call reads identically whether it happened in a turn or
 * inside a workflow step. Owner 2026-09-08: "similar pass with the workflow
 * section visibility" — same card, same rows, a different session id.
 */
import { useEffect, useRef, useState } from 'react';
import { withToken } from './api';
import type { HarnessEvent } from './types';
import { progressLabel, reduceActivity, type ActivityItem } from './useChat';

export interface SessionActivity {
  items: ActivityItem[];
  /** The rolling human line from the newest frame that carried one. */
  progress?: string;
  /** Highest seq folded so far — a reconnect resumes from here. */
  seq: number;
  /** Frames folded (a zero after connect means the run has not spoken yet). */
  count: number;
  /** The stream said the session is not running (replay payload status). */
  sessionStatus?: string;
}

export const EMPTY_SESSION_ACTIVITY: SessionActivity = { items: [], seq: 0, count: 0 };

/** Fold one frame. Pure; the hook and tests share it. */
export function foldSessionActivity(prev: SessionActivity, ev: HarnessEvent): SessionActivity {
  if (!ev || typeof ev.type !== 'string') return prev;
  const items = reduceActivity(prev.items, ev);
  const line = progressLabel(ev);
  const seq = typeof ev.seq === 'number' && ev.seq > prev.seq ? ev.seq : prev.seq;
  return {
    ...prev,
    items,
    seq,
    count: prev.count + 1,
    ...(line ? { progress: line } : {}),
  };
}

/** Whether the folded rows say something is still in flight. */
export function sessionActivityLive(state: SessionActivity, sessionStatusRunning: boolean): boolean {
  return sessionStatusRunning || state.items.some((row) => row.status === 'running');
}

/**
 * Subscribe to `/api/sessions/:id/events` (replay + live) and fold every
 * frame — the session's own AND the ones the route bridges in (a workflow's
 * step sessions, a helper's worker session). `null` means "no session yet":
 * the hook stays idle and returns the empty state.
 */
export function useSessionActivity(sessionId: string | null): SessionActivity {
  return useActivityStream(sessionId ? `/api/sessions/${encodeURIComponent(sessionId)}/events` : null);
}

/** A workflow run's activity — every step session and helper, one feed. */
export function useWorkflowRunActivity(runId: string | null): SessionActivity {
  return useActivityStream(runId ? `/api/console/workflows/runs/${encodeURIComponent(runId)}/activity` : null);
}

/** Any SSE endpoint that speaks `replay` + `event` frames of HarnessEvents. */
export function useActivityStream(streamPath: string | null): SessionActivity {
  const [state, setState] = useState<SessionActivity>(EMPTY_SESSION_ACTIVITY);
  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => {
    setState(EMPTY_SESSION_ACTIVITY);
    stateRef.current = EMPTY_SESSION_ACTIVITY;
    if (!streamPath) return;
    let closed = false;
    let es: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const fold = (ev: HarnessEvent) => {
      const next = foldSessionActivity(stateRef.current, ev);
      stateRef.current = next;
      setState(next);
    };
    const connect = () => {
      if (closed) return;
      const base = streamPath;
      const since = stateRef.current.seq;
      es = new EventSource(withToken(since > 0 ? `${base}?sinceSeq=${since}` : base));
      es.addEventListener('replay', (e) => {
        try {
          const payload = JSON.parse((e as MessageEvent).data) as { events?: HarnessEvent[]; sessionStatus?: string };
          for (const ev of payload.events ?? []) fold(ev);
          if (typeof payload.sessionStatus === 'string') {
            const next = { ...stateRef.current, sessionStatus: payload.sessionStatus };
            stateRef.current = next;
            setState(next);
          }
        } catch { /* malformed frame — skip */ }
      });
      es.addEventListener('event', (e) => {
        try { fold(JSON.parse((e as MessageEvent).data) as HarnessEvent); } catch { /* skip */ }
      });
      es.onerror = () => {
        if (closed) return;
        try { es?.close(); } catch { /* ignore */ }
        es = null;
        retry = setTimeout(connect, 2000);
      };
    };
    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      try { es?.close(); } catch { /* ignore */ }
    };
  }, [streamPath]);
  return state;
}
