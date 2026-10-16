/**
 * An activation that can never succeed as configured: the ownership, source or
 * evidence it was bound to is gone. Retrying it only spends model work, so a
 * recovery that meets one stops at once instead of rescheduling.
 */
export class PermanentActivationError extends Error {
  readonly permanent = true as const;
  constructor(message: string) {
    super(message);
    this.name = 'PermanentActivationError';
  }
}

export function isPermanentActivationError(error: unknown): boolean {
  return error instanceof PermanentActivationError
    || (typeof error === 'object' && error !== null && (error as { permanent?: unknown }).permanent === true);
}
