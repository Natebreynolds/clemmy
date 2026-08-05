/**
 * The server activity projection, as the console reads it.
 *
 * There is no client reducer here on purpose. The console used to fold the
 * operational-telemetry stream into its own lane map and decide for itself when
 * a lane had gone stale — which meant the rail, the board, and the channels
 * could each believe something different about the same run. Every field below
 * is served by /api/console/activity/v2; the components render it and infer
 * nothing.
 */
import { apiGet } from './api';

export type ActivityKind = 'chat' | 'background' | 'workflow' | 'fanout';
export type ActivityLiveness = 'live' | 'stale' | 'unknown';

export interface ActivityEntry {
  runKey: string;
  kind: ActivityKind;
  lifecycle: string;
  /** Server-owned: lease truth, never "no event for N seconds". */
  liveness: ActivityLiveness;
  needsAttention: boolean;
  headline: string;
  detail?: string;
  /** Privacy-safe phase label with its rendered text. */
  activity?: { phase: string; text: string; completed?: number; total?: number };
  /** Only present when the admitted plan owns a real denominator. */
  progress?: { completed: number; total: number };
  children?: { running: number; completed: number; failed: number; total: number };
  terminal?: { status: string; kind: string; text: string; resumable: boolean };
  origin?: string;
  nextAction?: string;
  owner?: string;
  startedAt: string;
  lastEvidenceAt: string;
  revision: number;
  sessionId?: string;
  taskId?: string;
  runId?: string;
  planId?: string;
}

interface ActivityResponse {
  schemaVersion: number;
  observedAt: string;
  entries?: ActivityEntry[];
  snapshots?: ActivityEntry[];
}

/**
 * Work the server says is running now. The Working Now gate lives on the
 * server: detached and scheduled work always, an ordinary foreground chat turn
 * only once it has run long enough to be work the user may have left behind.
 */
export async function listWorkingNow(): Promise<ActivityEntry[]> {
  const body = await apiGet<ActivityResponse>('/api/console/activity/v2?workingNow=1');
  return body.entries ?? body.snapshots ?? [];
}

/** The count line a row shows, when the server owns a real denominator. */
export function activityCounts(entry: ActivityEntry): string {
  if (entry.children && entry.children.total > 0) {
    return `${entry.children.completed}/${entry.children.total}`;
  }
  if (entry.progress && entry.progress.total > 0) {
    return `${entry.progress.completed}/${entry.progress.total}`;
  }
  return '';
}

/** Elapsed is a LABEL, never a status: it may not decide whether a row shows,
 *  what tone it takes, or whether the run is alive. */
export function elapsedLabel(startedAt: string | undefined, nowMs: number): string {
  if (!startedAt) return '';
  const ms = nowMs - Date.parse(startedAt);
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 60_000) return '<1m';
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min}m`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h`;
  return `${Math.round(hr / 24)}d`;
}
