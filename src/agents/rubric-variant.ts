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
import { createHash } from 'node:crypto';

export type RubricVariant = string;

/** The proven default — the full 34KB rubric. Never regress off this implicitly. */
export const DEFAULT_RUBRIC_VARIANT = 'legacy';

/** The two arms a live A/B compares: the lean rubric vs the proven legacy one. */
export type RubricArm = 'lean' | 'legacy';

export interface ResolvedRubricVariant {
  /** The variant actually in force (after any fallback to the default). */
  variant: string;
  /** The raw value the operator requested via CLEMMY_RUBRIC_VARIANT (normalized). */
  requested: string;
  /** True when `requested` was unknown/unimplemented and we fell back to default. */
  fellBack: boolean;
  /** True when a per-session A/B (not the global flag) governed this resolution. */
  experiment: boolean;
  /** The assigned arm when the A/B is running; null otherwise. */
  arm: RubricArm | null;
}

/** Live A/B on: bucket each SESSION into an arm instead of flipping the rubric
 *  globally, so lean vs legacy is compared on the SAME daemon (not confounded by
 *  time). Default OFF → the global CLEMMY_RUBRIC_VARIANT governs, byte-identical. */
export function rubricVariantExperimentEnabled(): boolean {
  return /^(1|true|on|yes)$/i.test((process.env.CLEMMY_RUBRIC_VARIANT_AB ?? '').trim());
}

/** Fraction of sessions assigned to the LEAN arm (rest = legacy). Default 0.5. */
function rubricAbRatio(): number {
  const r = Number.parseFloat(process.env.CLEMMY_RUBRIC_VARIANT_AB_RATIO ?? '');
  return Number.isFinite(r) && r >= 0 && r <= 1 ? r : 0.5;
}

/** Deterministic, stable arm for a session: same sessionId → same arm for the
 *  whole conversation (no flapping mid-session). Pure hash, no state. Mirrors
 *  assignToolJitArm so the two A/Bs bucket identically. */
export function assignRubricArm(sessionId: string): RubricArm {
  const digest = createHash('sha1').update(`rubric_variant_ab::${sessionId}`).digest();
  const frac = digest.readUInt32BE(0) / 0xffffffff;
  return frac < rubricAbRatio() ? 'lean' : 'legacy';
}

/**
 * Resolve the rubric variant. When the live A/B is on AND we have a session AND
 * both arms are available, the per-session ARM governs (overriding the global
 * flag) so real traffic splits lean/legacy. Otherwise the env CLEMMY_RUBRIC_VARIANT
 * governs (unknown/unset → the proven default, with `fellBack` set so a
 * wrong-variant run is never silent). Pure — reads only the env + the sessionId.
 */
export function resolveRubricVariant(available: readonly string[], sessionId?: string | null): ResolvedRubricVariant {
  // Normalize the available list the SAME way as the request so a mixed-case
  // registry key (e.g. a future 'Lean') can't cause a silent fallback.
  const avail = new Set(available.map((v) => v.trim().toLowerCase()));
  if (rubricVariantExperimentEnabled() && sessionId && avail.has('lean') && avail.has('legacy')) {
    const arm = assignRubricArm(sessionId);
    return { variant: arm, requested: `ab:${arm}`, fellBack: false, experiment: true, arm };
  }
  const raw = (process.env.CLEMMY_RUBRIC_VARIANT ?? '').trim().toLowerCase();
  const requested = raw || DEFAULT_RUBRIC_VARIANT;
  if (avail.has(requested)) {
    return { variant: requested, requested, fellBack: false, experiment: false, arm: null };
  }
  return {
    variant: DEFAULT_RUBRIC_VARIANT,
    requested,
    fellBack: requested !== DEFAULT_RUBRIC_VARIANT,
    experiment: false,
    arm: null,
  };
}
