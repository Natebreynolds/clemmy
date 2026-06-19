/**
 * Engine-over-prompt — the rubric A/B substrate (Phase 0c).
 *
 * Selects which Codex/native orchestrator rubric variant a run uses, via
 * `CLEMMY_RUBRIC_VARIANT`, and lets every build path tag the event log with the
 * variant in force so live sessions are attributable to an arm. This is the
 * mechanism the whole engine-over-prompt plan depends on: the LEAN rubric content
 * arrives later (Phase 5, characterization-tested + live A/B), but the switch and
 * the telemetry land now — DEFAULT 'legacy', byte-identical, zero behavior change.
 *
 * Kept dependency-free (no rubric-content imports) so it can't create an import
 * cycle with orchestrator.ts, which owns the variant→instructions map.
 */

export type RubricVariant = string;

/** The proven default — the full 34KB rubric. Never regress off this implicitly. */
export const DEFAULT_RUBRIC_VARIANT = 'legacy';

export interface ResolvedRubricVariant {
  /** The variant actually in force (after any fallback to the default). */
  variant: string;
  /** The raw value the operator requested via CLEMMY_RUBRIC_VARIANT (normalized). */
  requested: string;
  /** True when `requested` was unknown/unimplemented and we fell back to default. */
  fellBack: boolean;
}

/**
 * Resolve the rubric variant from the environment, bounded by what the caller
 * actually implements (`available`). Unknown/unset → the proven default, with
 * `fellBack` set so the fallback is observable (never a silent wrong-variant run).
 * Pure — reads only the env.
 */
export function resolveRubricVariant(available: readonly string[]): ResolvedRubricVariant {
  const raw = (process.env.CLEMMY_RUBRIC_VARIANT ?? '').trim().toLowerCase();
  const requested = raw || DEFAULT_RUBRIC_VARIANT;
  // Normalize the available list the SAME way as the request so a mixed-case
  // registry key (e.g. a future 'Lean') can't cause a silent fallback.
  const avail = new Set(available.map((v) => v.trim().toLowerCase()));
  if (avail.has(requested)) {
    return { variant: requested, requested, fellBack: false };
  }
  return {
    variant: DEFAULT_RUBRIC_VARIANT,
    requested,
    fellBack: requested !== DEFAULT_RUBRIC_VARIANT,
  };
}
