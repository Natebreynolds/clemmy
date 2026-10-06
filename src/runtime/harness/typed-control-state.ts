/**
 * Host-owned rendering and ownership for non-final control states.
 *
 * A pause is not a generic failed turn. `blocked`, `needs_input`, and
 * `uncertain` have a declared owner and wake condition, and they always have
 * a deterministic user-safe sentence the host can publish without a model.
 * A declared wake is not proof that a physical retry/reconciliation is armed.
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
  if (input.status === 'blocked' && !input.hold) {
    return 'The next step is blocked, so this request is unfinished. The cause is not confirmed yet. Ask me to check the blocker and any completed work before continuing.';
  }
  const hold = input.hold ?? defaultHoldForControlState({
    status: input.status,
    ...(input.needs ? { needs: input.needs } : {}),
  });
  if (input.status === 'uncertain' || hold.wake.kind === 'host_reconcile') {
    return 'An external effect may already have happened, so this request is still unfinished. Ask me to check the outcome of this exact request before continuing.';
  }
  if (input.status === 'needs_input') {
    if (input.needs?.kind === 'continue') {
      return 'This request is unfinished and needs your decision to continue. Use Continue here when you are ready.';
    }
    if (hold.wake.kind === 'user_connection') {
      return 'A required connection is missing, so this request is unfinished. Complete the requested connection, then ask me to continue this exact request.';
    }
    if (hold.wake.kind === 'user_approval') {
      return 'The next step needs your approval, so this request is unfinished. Review the approval request and approve or reject it here.';
    }
    return 'This request is unfinished because it needs more information from you. Ask me to check what information is still missing before continuing this exact request.';
  }
  switch (hold.hold) {
    case 'budget_exhausted':
      return 'This run hit a host budget, so this request is unfinished. Ask me to check the saved progress and remaining budget before continuing this exact request.';
    case 'lease_unavailable':
      return 'Another activation holds this work, so this request is unfinished. Ask me to check that owner and the completed work before continuing this exact request.';
    case 'reconciliation_pending':
      return 'An external effect may already have happened, so this request is unfinished. Ask me to check the outcome of this exact request before continuing.';
    case 'admission_refused':
    case 'capability_identity_mismatch':
      return 'I could not admit this plan against the live catalog, so this request is unfinished. Ask me to check the blocker and any completed work before continuing.';
    case 'observation_unavailable':
      return 'A required observation is unavailable, so this request is unfinished. Ask me to check the missing evidence and any completed work before continuing.';
    case 'provider_unavailable':
      return 'A required provider is unavailable, so this request is unfinished. Ask me to check the provider and any completed work before continuing.';
    default:
      return 'A host dependency is blocking this request, so it is unfinished. Ask me to check the blocker and any completed work before continuing.';
  }
}
