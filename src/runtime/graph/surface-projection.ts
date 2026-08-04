/**
 * The shared activity projection (Clem 4 Stage 9, U1).
 *
 * The product currently holds several independent activity truths — shared
 * snapshot, console reducer, Background work panel, NowStrip, trace drawer,
 * mobile serializer, native/notch — and they disagree in ways users see:
 * queued counted as running, a 60-second silence heuristic vanishing live
 * work, poll failure masquerading as Ready, green checks on children that
 * never settled. This module is the ONE server-owned truth those surfaces
 * will migrate onto: a versioned snapshot plus monotonic revisioned deltas,
 * idempotent under duplicate and out-of-order replay.
 *
 * U1 lands the contract BEHIND current rendering: nothing consumes it yet,
 * no behavior gate exists, and each surface migrates in its own later slice
 * (U2–U6) by deleting its private reducer. The semantic rules below are the
 * charter's, pinned by conformance tests:
 *
 *   - lifecycle, run liveness, and transport connectivity are INDEPENDENT
 *     axes; blocked, stale, and offline never masquerade as idle;
 *   - queued is not running;
 *   - a terminal is COPIED from the typed public projection, never inferred
 *     from an event name;
 *   - a child is successful only after its own successful terminal;
 *   - progress numbers exist only when the admitted graph owns a real
 *     denominator;
 *   - `lastEvidenceAt` derives from durable evidence, never poll time.
 *
 * Pure: no clock, no filesystem, no environment. Time enters as data.
 */

export const SURFACE_PROJECTION_SCHEMA_VERSION = 1;

export type SurfaceLifecycle =
  | 'accepted'
  | 'queued'
  | 'reasoning'
  | 'retrieving'
  | 'using_tool'
  | 'fanout'
  | 'reducing'
  | 'verifying'
  | 'awaiting_input'
  | 'awaiting_approval'
  | 'paused_budget'
  | 'retrying'
  | 'completing'
  | 'blocked'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type SurfaceLiveness = 'live' | 'stale' | 'unknown';
export type SurfaceConnectivity = 'connected' | 'reconnecting' | 'offline' | 'error';

const RUNNING_LIFECYCLES: ReadonlySet<SurfaceLifecycle> = new Set([
  'reasoning', 'retrieving', 'using_tool', 'fanout', 'reducing', 'verifying', 'retrying', 'completing',
]);
const TERMINAL_LIFECYCLES: ReadonlySet<SurfaceLifecycle> = new Set([
  'completed', 'failed', 'blocked', 'cancelled',
]);

export interface SurfaceTerminal {
  status: 'completed' | 'failed' | 'blocked' | 'cancelled';
  kind: string;
  text: string;
  resumable: boolean;
}

export interface SurfaceRunSnapshot {
  schemaVersion: typeof SURFACE_PROJECTION_SCHEMA_VERSION;
  runKey: string;
  attemptId: string;
  presentationLane: 'foreground' | 'detached' | 'scheduled';
  lifecycle: SurfaceLifecycle;
  liveness: SurfaceLiveness;
  connectivity: SurfaceConnectivity;
  headline: string;
  detail?: string;
  startedAt: string;
  /** Durable-evidence time only. A poll's wall clock is not evidence. */
  lastEvidenceAt: string;
  revision: number;
  /** Present only when the admitted graph owns a real denominator. */
  progress?: { completed: number; total: number };
  children?: { running: number; completed: number; failed: number; total: number };
  terminal?: SurfaceTerminal;
}

/** A delta is a partial snapshot with a strictly increasing revision. */
export interface SurfaceRunDelta {
  runKey: string;
  revision: number;
  patch: Partial<Omit<SurfaceRunSnapshot, 'schemaVersion' | 'runKey' | 'revision'>>;
}

export interface ProjectRunInput {
  runKey: string;
  attemptId: string;
  presentationLane: 'foreground' | 'detached' | 'scheduled';
  lifecycle: SurfaceLifecycle;
  /** ISO time of the LAST durable evidence row for this run. */
  lastEvidenceAt: string;
  startedAt: string;
  headline: string;
  detail?: string;
  /** The lease/evidence expiry horizon, when the run's contract declares one. */
  staleAfter?: string;
  /** The observer's transport state — INDEPENDENT of run state. */
  connectivity: SurfaceConnectivity;
  /** "Now" as data, for liveness derivation only. */
  observedAt: string;
  revision: number;
  /** Only when the admitted graph owns the denominator. */
  admittedTotal?: number;
  completedCount?: number;
  childTerminals?: Array<{ status: 'completed' | 'failed' | 'blocked' | 'cancelled' } | null>;
  /** The typed public terminal, when one is committed. NEVER derived here. */
  typedTerminal?: SurfaceTerminal;
}

/**
 * Project one run's snapshot from durable inputs.
 *
 * Liveness is derived, not asserted: a run past its declared staleAfter is
 * `stale`; with no declared horizon it is `unknown` when non-terminal work has
 * been silent — never silently promoted to `live`, and never demoted to idle.
 * A committed typed terminal forces the terminal lifecycle even if a caller
 * passes a running phase — the terminal is the truth, the phase is not.
 */
export function projectRunSnapshot(input: ProjectRunInput): SurfaceRunSnapshot {
  const terminal = input.typedTerminal;
  const lifecycle: SurfaceLifecycle = terminal ? terminal.status : input.lifecycle;

  let liveness: SurfaceLiveness;
  if (TERMINAL_LIFECYCLES.has(lifecycle)) {
    liveness = 'live'; // a settled truth is not stale
  } else if (input.staleAfter) {
    liveness = input.observedAt > input.staleAfter ? 'stale' : 'live';
  } else {
    liveness = 'unknown';
  }

  const children = input.childTerminals
    ? {
        running: input.childTerminals.filter((child) => child === null).length,
        // A child is successful only after ITS OWN successful terminal.
        completed: input.childTerminals.filter((child) => child?.status === 'completed').length,
        failed: input.childTerminals.filter(
          (child) => child !== null && child.status !== 'completed',
        ).length,
        total: input.childTerminals.length,
      }
    : undefined;

  return {
    schemaVersion: SURFACE_PROJECTION_SCHEMA_VERSION,
    runKey: input.runKey,
    attemptId: input.attemptId,
    presentationLane: input.presentationLane,
    lifecycle,
    liveness,
    connectivity: input.connectivity,
    headline: input.headline,
    ...(input.detail !== undefined ? { detail: input.detail } : {}),
    startedAt: input.startedAt,
    lastEvidenceAt: input.lastEvidenceAt,
    revision: input.revision,
    // No denominator without an admitted total: a percentage invented from a
    // guess is how progress bars lie.
    ...(typeof input.admittedTotal === 'number' && input.admittedTotal > 0
      ? { progress: { completed: input.completedCount ?? 0, total: input.admittedTotal } }
      : {}),
    ...(children ? { children } : {}),
    ...(terminal ? { terminal } : {}),
  };
}

/** Is this snapshot RUNNING for counting purposes? Queued is not. */
export function isRunningLifecycle(lifecycle: SurfaceLifecycle): boolean {
  return RUNNING_LIFECYCLES.has(lifecycle);
}

export function isTerminalLifecycle(lifecycle: SurfaceLifecycle): boolean {
  return TERMINAL_LIFECYCLES.has(lifecycle);
}

/**
 * Apply a delta stream to a snapshot, idempotently and order-safely.
 *
 * A delta at or below the current revision is a duplicate or a straggler and
 * is dropped — replay converges on the same bytes no matter how the transport
 * reordered or repeated. A delta for another run refuses rather than
 * cross-painting. A terminal, once present, is immutable: a later delta may
 * not overwrite or remove it, because exactly-one-terminal is the product's
 * spine invariant and the projection must not be the place it leaks.
 */
export function applyRunDelta(
  snapshot: SurfaceRunSnapshot,
  delta: SurfaceRunDelta,
): SurfaceRunSnapshot {
  if (delta.runKey !== snapshot.runKey) return snapshot;
  if (delta.revision <= snapshot.revision) return snapshot;
  const patch = { ...delta.patch };
  if (snapshot.terminal) {
    delete patch.terminal;
    delete patch.lifecycle;
  }
  const next: SurfaceRunSnapshot = {
    ...snapshot,
    ...patch,
    schemaVersion: SURFACE_PROJECTION_SCHEMA_VERSION,
    runKey: snapshot.runKey,
    revision: delta.revision,
  };
  if (next.terminal) next.lifecycle = next.terminal.status;
  return next;
}
