/**
 * Which effects stop a turn when their outcome is uncertain: an external
 * write or an admin action, which may have half-landed somewhere else and
 * cannot simply be run again. A read, a computation or a local write (inside
 * Clem's own home or this Mac) that may have started is corrected in place:
 * it settles, the model sees the tool's own result, and nothing replays it.
 *
 * One rule for the live runner and for the checkpoint that must accept what
 * the runner showed the model, so the two can never disagree about a turn.
 */
export function uncertainEffectStopsTurn(effect: string | null | undefined): boolean {
  return effect === 'external_write' || effect === 'admin';
}
