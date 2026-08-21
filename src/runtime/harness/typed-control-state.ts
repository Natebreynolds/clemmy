/**
 * Host-owned rendering and ownership for non-final control states.
 *
 * A pause is not a generic failed turn. `blocked`, `needs_input`, and
 * `uncertain` always have an owner and a wake condition, and they always have
 * a deterministic user-safe sentence the host can publish without a model.
 * Optional authoring may polish that sentence; empty, malformed, or timed-out
 * author output must not convert a valid control state into `failed`.
 */
import type { DeterministicHold, GateReason } from '../gate-reason.js';
import type { TurnNeed, TurnOutcomeStatus } from './turn-outcome.js';

export type ControlStateOwner = 'user' | 'host';

export type ControlStateWake =
  | { kind: 'user_answer' }
  | { kind: 'user_connection' }
  | { kind: 'user_approval' }
  | { kind: 'host_retry' }
  | { kind: 'host_reconcile' }
  | { kind: 'host_peer' };

export interface TypedControlHold {
  owner: ControlStateOwner;
  wake: ControlStateWake;
  hold?: DeterministicHold;
  gate?: GateReason;
}

export type TypedControlStatus = Extract<TurnOutcomeStatus, 'blocked' | 'needs_input' | 'uncertain'>;

export function isTypedControlStatus(status: TurnOutcomeStatus): status is TypedControlStatus {
  return status === 'blocked' || status === 'needs_input' || status === 'uncertain';
}

export function defaultHoldForControlState(input: {
  status: TypedControlStatus;
  needs?: TurnNeed;
  gate?: GateReason;
  hold?: DeterministicHold;
}): TypedControlHold {
  if (input.status === 'uncertain' || input.gate === 'uncertain_external_effect_requires_user') {
    return {
      owner: input.gate === 'uncertain_external_effect_requires_user' ? 'user' : 'host',
      wake: input.gate === 'uncertain_external_effect_requires_user'
        ? { kind: 'user_answer' }
        : { kind: 'host_reconcile' },
      ...(input.gate ? { gate: input.gate } : {}),
    };
  }
  if (input.status === 'needs_input') {
    const gate = input.gate
      ?? (input.needs?.kind === 'approval' ? 'irreversible_approval_required' : 'essential_input_required');
    const wake: ControlStateWake = gate === 'credential_connection_required'
      ? { kind: 'user_connection' }
      : gate === 'irreversible_approval_required' || input.needs?.kind === 'approval'
        ? { kind: 'user_approval' }
        : { kind: 'user_answer' };
    return { owner: 'user', wake, gate };
  }
  const hold = input.hold ?? 'provider_unavailable';
  const wake: ControlStateWake = hold === 'reconciliation_pending'
    ? { kind: 'host_reconcile' }
    : hold === 'lease_unavailable'
      ? { kind: 'host_peer' }
      : { kind: 'host_retry' };
  return { owner: 'host', wake, hold };
}

export function renderTypedControlState(input: {
  status: TypedControlStatus;
  hold?: TypedControlHold;
  needs?: TurnNeed;
}): string {
  const hold = input.hold ?? defaultHoldForControlState({
    status: input.status,
    ...(input.needs ? { needs: input.needs } : {}),
  });
  if (input.status === 'uncertain' || hold.wake.kind === 'host_reconcile') {
    return 'An external effect may already have happened. I have not retried it. I will reconcile this exact request and continue; nothing new was started.';
  }
  if (input.status === 'needs_input') {
    if (hold.wake.kind === 'user_connection') {
      return 'I understood the task, but a required connection is missing. Connect it — I will continue this exact request. Nothing was started.';
    }
    if (hold.wake.kind === 'user_approval') {
      return 'This next step needs your approval before I can continue. Approve or reject here — I will resume this exact request.';
    }
    return 'I need something only you can provide before this can continue. Answer here — I will resume this exact request.';
  }
  switch (hold.hold) {
    case 'budget_exhausted':
      return 'This run hit a host budget and is parked. I will continue this exact request when the budget renews. Nothing further will execute until then.';
    case 'lease_unavailable':
      return 'Another activation still holds this work. I am waiting on that owner; I will continue this exact request when the lease is free.';
    case 'reconciliation_pending':
      return 'An external effect may already have happened. I have not retried it. I will reconcile this exact request and continue.';
    case 'admission_refused':
    case 'capability_identity_mismatch':
      return 'I could not admit this plan against the live catalog. That is a host defect, not a missing connection. Nothing was started; I have logged it for repair.';
    case 'observation_unavailable':
    case 'provider_unavailable':
    default:
      return 'Work is paused on a host-owned dependency. I will continue this exact request when it clears. Nothing further will execute until then.';
  }
}
