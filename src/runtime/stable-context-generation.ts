/**
 * Invalidation generation for STABLE-context snapshots.
 *
 * The Claude-brain system append freezes its stable memory block per session
 * so the prompt-prefix cache stays byte-stable (a single re-rendered fact was
 * measured busting it down to ~28% hit rate). Freezing is only safe if every
 * EXPLICIT mutation of what that block renders — user-stated facts, profile
 * edits, pins/corrections, skill installs — bumps this generation so the next
 * turn re-renders. Automatic reflection churn deliberately does NOT bump:
 * deferring that churn to session end is the snapshot's whole point.
 *
 * A zero-import leaf on purpose: memory-layer writers and harness-layer
 * readers can both import it with no cycle risk.
 */

let generation = 0;

/** Call after an EXPLICIT stable-context mutation (never from reflection). */
export function bumpStableContextGeneration(): void {
  generation += 1;
}

export function stableContextGeneration(): number {
  return generation;
}
