export interface OriginHandoffCorrelation {
  token: string;
  handoffId?: string;
  generation?: number;
}

export interface OriginHandoffAdoptionDeps {
  alreadyAuthenticated(): Promise<boolean>;
  adopt(value: OriginHandoffCorrelation): Promise<void>;
  finalize(handoffId: string, generation: number): Promise<void>;
  isExplicitlyInvalid(error: unknown): boolean;
  report(
    handoffId: string,
    generation: number,
    outcome: 'consumed' | 'invalid',
  ): void;
}

/**
 * One truth-bearing adoption ceremony shared by the React effect and tests.
 * Native acknowledgement is emitted only after the server's exact correlated
 * success. Transport failures, 5xx responses, and mismatched ACKs retain the
 * Keychain lease for a retry.
 */
export async function runOriginHandoffAdoption(
  value: OriginHandoffCorrelation,
  deps: OriginHandoffAdoptionDeps,
): Promise<'already_authenticated' | 'adopted'> {
  if (await deps.alreadyAuthenticated()) {
    if (value.handoffId && value.generation) {
      try {
        // Covers the crash/lost-callback window after Set-Cookie succeeded but
        // before native learned that the durable lease could be removed.
        await deps.finalize(value.handoffId, value.generation);
        deps.report(value.handoffId, value.generation, 'consumed');
      } catch {
        // A different already-authenticated origin did not spend this lease,
        // or the finalize request was transiently unavailable. Retain it.
      }
    }
    return 'already_authenticated';
  }
  try {
    await deps.adopt(value);
  } catch (error) {
    if (value.handoffId && value.generation && deps.isExplicitlyInvalid(error)) {
      deps.report(value.handoffId, value.generation, 'invalid');
    }
    throw error;
  }
  if (value.handoffId && value.generation) {
    // The adopted cookie/fingerprint is installed before this authenticated
    // call. Only its exact durable ACK permits native Keychain deletion.
    await deps.finalize(value.handoffId, value.generation);
    deps.report(value.handoffId, value.generation, 'consumed');
  }
  return 'adopted';
}
