/** A retained budget reference is identity only, never a fresh allowance. */
export interface SourceBudgetPolicyRef { eventId: string; digest: string }

export function assertSourceBudgetPolicyRef(value: SourceBudgetPolicyRef): void {
  if (!value || typeof value.eventId !== 'string' || !value.eventId
    || typeof value.digest !== 'string' || !/^[a-f0-9]{64}$/.test(value.digest)) {
    throw new Error('The retained task budget reference is invalid.');
  }
}

