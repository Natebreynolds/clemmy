/**
 * The server-side activity projector (Clem 4 Stage 9, U1's second half).
 *
 * U1 landed the pure truth contract (`surface-projection.ts`); this module is
 * the server projector the charter names in the same breath: real durable run
 * records mapped into `SurfaceRunSnapshot`s, behind current rendering — no
 * surface consumes it yet, no behavior gate exists, and U2+ migrates surfaces
 * onto the endpoint one at a time by deleting their private reducers.
 *
 * Privacy discipline is inherited, not re-decided: the same rule that keeps
 * step outputs, prompts, and inputs out of the runs-list projection keeps
 * them out of snapshots. Headlines and details are built from status
 * vocabulary and already-public fields only.
 *
 * Snapshots only, for now: this endpoint has no delta stream, so every
 * response is a fresh snapshot at revision 1. The delta stream arrives with
 * the durable journal's event feed; `applyRunDelta`'s idempotence is already
 * pinned for that day.
 */
import {
  projectRunSnapshot,
  type SurfaceLifecycle,
  type SurfaceRunSnapshot,
  type SurfaceTerminal,
} from '../runtime/graph/surface-projection.js';

interface RawRunRecordLike {
  id?: unknown;
  workflow?: unknown;
  status?: unknown;
  createdAt?: unknown;
  startedAt?: unknown;
  finishedAt?: unknown;
  source?: unknown;
  error?: unknown;
  capabilityBlock?: unknown;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** Status vocabulary → lifecycle. Unknown statuses map to 'accepted' — an
 *  honest "we know it exists" — never to running or completed. */
const LIFECYCLES: Record<string, SurfaceLifecycle> = {
  queued: 'queued',
  pending: 'queued',
  running: 'reasoning',
  finalizing: 'completing',
  blocked_capability: 'blocked',
  awaiting_approval: 'awaiting_approval',
  parked: 'awaiting_approval',
  completed: 'completed',
  failed: 'failed',
  error: 'failed',
  cancelled: 'cancelled',
};

const TERMINALS: Record<string, SurfaceTerminal['status']> = {
  completed: 'completed',
  failed: 'failed',
  error: 'failed',
  cancelled: 'cancelled',
};

/**
 * Project one durable workflow-run record into the shared snapshot shape.
 * Returns null for records too malformed to identify — a projection never
 * invents identity.
 */
export function projectWorkflowRunActivity(
  raw: RawRunRecordLike,
  observedAt: string,
): SurfaceRunSnapshot | null {
  const id = text(raw.id);
  const workflow = text(raw.workflow);
  if (!id || !workflow) return null;
  const status = text(raw.status) ?? 'unknown';
  const lifecycle = LIFECYCLES[status] ?? 'accepted';

  const terminalStatus = TERMINALS[status];
  const terminal: SurfaceTerminal | undefined = terminalStatus
    ? {
        status: terminalStatus,
        kind: status,
        // Bounded, already-public vocabulary only — the run's OUTPUT is
        // deliberately absent, same as the runs-list projection.
        text: text(raw.error)?.slice(0, 500)
          ?? (terminalStatus === 'completed' ? 'Run completed.' : `Run ${status}.`),
        resumable: false,
      }
    : undefined;

  const block = raw.capabilityBlock && typeof raw.capabilityBlock === 'object'
    ? raw.capabilityBlock as { message?: unknown; toolkit?: unknown }
    : undefined;

  return projectRunSnapshot({
    runKey: `workflow:${id}`,
    attemptId: id,
    presentationLane: text(raw.source) === 'cron' ? 'scheduled' : 'detached',
    lifecycle,
    headline: workflow,
    ...(lifecycle === 'blocked' && block
      ? { detail: text(block.message)?.slice(0, 300) ?? `Connect ${text(block.toolkit) ?? 'the required account'} to resume.` }
      : {}),
    startedAt: text(raw.startedAt) ?? text(raw.createdAt) ?? observedAt,
    // Durable-evidence time only: the record's own timestamps, never poll time.
    lastEvidenceAt: text(raw.finishedAt) ?? text(raw.startedAt) ?? text(raw.createdAt) ?? observedAt,
    connectivity: 'connected',
    observedAt,
    revision: 1,
    ...(terminal ? { typedTerminal: terminal } : {}),
  });
}
