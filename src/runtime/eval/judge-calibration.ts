/**
 * judge-calibration — does a boundary judge agree with a HUMAN? (Lane A
 * trust-layer P3).
 *
 * The gates (grounding, goal-fidelity, the new numeric/output-grounding) decide
 * whether to bounce an action. We trust them unsupervised only if we've measured
 * that their verdicts match a human's on a labeled gold set — Cohen's κ, per
 * judge-model-family pair (a Codex brain judged by Claude, etc.). κ corrects for
 * chance agreement, so it doesn't flatter a judge that just says "pass" a lot.
 *
 * This module is the PURE, deterministic core (the math + the gold-set types),
 * CI-tested without any model call. scripts/measure-judge-calibration.ts wires
 * the live cross-family judges around it.
 *
 * κ bands (Landis & Koch): <0 worse than chance, 0–.2 slight, .21–.4 fair,
 * .41–.6 moderate, .61–.8 substantial, .81–1 almost perfect. We gate at ≥0.6.
 */

export type Label = 'pass' | 'fail';
export type JudgeKind = 'grounding' | 'goal_fidelity' | 'numeric_grounding';

export interface GoldCase {
  id: string;
  judge: JudgeKind;
  /** Judge-specific input (payload+sources, goal+skill+evidence, …). */
  input: Record<string, unknown>;
  /** The human verdict: pass = the judge SHOULD allow; fail = SHOULD bounce. */
  humanLabel: Label;
  /** Where this label came from (an incident, a hand-authored case). */
  provenance?: string;
}

export interface GoldSet {
  version: number;
  capturedAt: string;
  note?: string;
  cases: GoldCase[];
}

export interface Confusion {
  /** human pass & judge pass */ a: number;
  /** human pass & judge fail */ b: number;
  /** human fail & judge pass */ c: number;
  /** human fail & judge fail */ d: number;
}

export interface KappaResult {
  n: number;
  /** observed agreement */ po: number;
  /** chance agreement */ pe: number;
  /** Cohen's κ ∈ [-1, 1]; NaN when n=0. */ kappa: number;
  confusion: Confusion;
}

/**
 * Cohen's κ for binary pass/fail rater pairs. Degenerate case (all labels in one
 * category → pe=1): returns κ=1 on perfect agreement, else 0 (the standard
 * convention — chance can't be corrected for, so credit only exact agreement).
 */
export function cohensKappa(rows: Array<{ human: Label; judge: Label }>): KappaResult {
  const conf: Confusion = { a: 0, b: 0, c: 0, d: 0 };
  for (const r of rows) {
    if (r.human === 'pass' && r.judge === 'pass') conf.a += 1;
    else if (r.human === 'pass' && r.judge === 'fail') conf.b += 1;
    else if (r.human === 'fail' && r.judge === 'pass') conf.c += 1;
    else conf.d += 1;
  }
  const n = conf.a + conf.b + conf.c + conf.d;
  if (n === 0) return { n: 0, po: NaN, pe: NaN, kappa: NaN, confusion: conf };
  const po = (conf.a + conf.d) / n;
  const pe =
    ((conf.a + conf.b) * (conf.a + conf.c) + (conf.c + conf.d) * (conf.b + conf.d)) / (n * n);
  const kappa = (1 - pe) === 0 ? (po === 1 ? 1 : 0) : (po - pe) / (1 - pe);
  return { n, po, pe, kappa, confusion: conf };
}

/** Landis & Koch band label for a κ value (for the readout). */
export function kappaBand(kappa: number): string {
  if (Number.isNaN(kappa)) return 'n/a';
  if (kappa < 0) return 'worse-than-chance';
  if (kappa <= 0.2) return 'slight';
  if (kappa <= 0.4) return 'fair';
  if (kappa <= 0.6) return 'moderate';
  if (kappa <= 0.8) return 'substantial';
  return 'almost-perfect';
}

/** The κ floor a judge-family pair must clear to gate CI (per the plan). */
export const KAPPA_GATE = 0.6;
