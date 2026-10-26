import type { WorkflowDefinition, WorkflowStepInput } from '../memory/workflow-store.js';
import type { WorkflowEvent } from './workflow-events.js';
import { stepExecutionSurface } from './workflow-enforce.js';

/**
 * What a creation test can take from the one just before it.
 *
 * Every edit of a workflow re-tests it, and the test used to run every read
 * step again: a prompt change to the last step re-read every source above it,
 * and two edits a few seconds apart read the same sources twice (live: about
 * four minutes for a one-line change). A read step's earlier result stands in
 * for a fresh one when that step and every step it reads from are exactly as
 * they were in a test that settled minutes ago. A creation test never anchors
 * the run goal and gets no watcher steering, so its step results depend only
 * on the steps, the workflow's tools and inputs, and the sources themselves;
 * a goal change leaves them as they were. Anything changed, written or sent
 * runs (or is previewed) as before.
 */
export const CREATION_TEST_REUSE_WINDOW_MS = 15 * 60_000;

/** A copy of a read result does not create a new observation. Keep both its
 * original completion clock and the admission boundary for file changes. */
export interface CreationTestReadOrigin {
  runId: string;
  observedAt: string;
  admittedAt: string;
}

/** Recover provenance alongside the journal's latest completed step outputs.
 * Old fresh completions have their own observation clock; old inherited
 * completions without explicit provenance must be read again. */
export function creationTestReadOrigins(
  events: readonly WorkflowEvent[],
  runId: string,
  admittedAt: string,
): Map<string, CreationTestReadOrigin> {
  const origins = new Map<string, CreationTestReadOrigin>();
  for (const event of events) {
    if (!event.stepId) continue;
    if (event.kind === 'step_invalidated' || event.kind === 'step_skipped') {
      origins.delete(event.stepId);
      continue;
    }
    if (event.kind !== 'step_completed') continue;
    origins.delete(event.stepId);
    const meta = event.meta ?? {};
    const inherited = 'inheritedFromRunId' in meta || 'reusedUnchangedInCreationTest' in meta;
    let origin: CreationTestReadOrigin;
    if (inherited) {
      const value = meta.creationTestReadOrigin;
      if (meta.reusedUnchangedInCreationTest !== true
        || typeof meta.inheritedFromRunId !== 'string' || !meta.inheritedFromRunId.trim()
        || meta.inheritedFromRunId === runId
        || !value || typeof value !== 'object' || Array.isArray(value)) continue;
      const candidate = value as Record<string, unknown>;
      if (typeof candidate.runId !== 'string' || !candidate.runId.trim() || candidate.runId === runId
        || typeof candidate.observedAt !== 'string' || typeof candidate.admittedAt !== 'string') continue;
      origin = { runId: candidate.runId, observedAt: candidate.observedAt, admittedAt: candidate.admittedAt };
    } else {
      // Unexpected provenance on a non-inherited completion is not a fresh read.
      if ('creationTestReadOrigin' in meta) continue;
      origin = { runId, observedAt: event.t, admittedAt };
    }
    const admitted = Date.parse(origin.admittedAt);
    const observed = Date.parse(origin.observedAt);
    const copied = Date.parse(event.t);
    if (![admitted, observed, copied].every(Number.isFinite) || admitted > observed || observed > copied) continue;
    origins.set(event.stepId, origin);
  }
  return origins;
}

/** The workflow-wide settings every step runs under. */
function stepContext(def: WorkflowDefinition): string {
  return JSON.stringify({
    project: def.project ?? null,
    allowedTools: def.allowedTools ?? null,
    inputs: def.inputs ?? null,
    allowSends: def.allowSends ?? null,
  });
}

/** Ids of the read steps that run exactly as they did in `prior`, along with
 *  every step they read from. A forEach step is left to run: its items are
 *  their own results. */
export function readStepsUnchangedSince(
  prior: WorkflowDefinition,
  current: WorkflowDefinition,
  isRead: (step: WorkflowStepInput) => boolean,
): Set<string> {
  const unchanged = new Set<string>();
  if (stepContext(prior) !== stepContext(current)) return unchanged;
  const before = new Map((prior.steps ?? []).map((step) => [step.id, step]));
  const now = new Map((current.steps ?? []).map((step) => [step.id, step]));
  const decided = new Map<string, boolean>();
  const visit = (id: string, path: Set<string>): boolean => {
    const known = decided.get(id);
    if (known !== undefined) return known;
    const step = now.get(id);
    const earlier = before.get(id);
    let same = Boolean(step && earlier && !path.has(id))
      && isRead(step!) && !step!.forEach
      && JSON.stringify(stepExecutionSurface(step!)) === JSON.stringify(stepExecutionSurface(earlier!));
    if (same) {
      const next = new Set(path).add(id);
      same = (step!.dependsOn ?? []).every((dep) => visit(dep, next));
    }
    decided.set(id, same);
    return same;
  };
  for (const id of now.keys()) if (visit(id, new Set())) unchanged.add(id);
  return unchanged;
}

/** True when an earlier test's result is recent enough to stand in: inside
 *  the window and on the same calendar day, since a step may read the date. */
export function creationTestResultStillCurrent(observedAt: string, nowMs: number): boolean {
  const observed = Date.parse(observedAt);
  if (!Number.isFinite(observed) || observed > nowMs) return false;
  if (nowMs - observed > CREATION_TEST_REUSE_WINDOW_MS) return false;
  return new Date(observed).toDateString() === new Date(nowMs).toDateString();
}

/** How long ago, as the step line says it. */
export function creationTestReuseAge(observedAt: string, nowMs: number): string {
  const seconds = Math.max(0, Math.round((nowMs - Date.parse(observedAt)) / 1000));
  if (seconds < 90) return `${seconds} s`;
  return `${Math.round(seconds / 60)} min`;
}
