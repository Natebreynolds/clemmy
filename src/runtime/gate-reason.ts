/**
 * Closed, host-owned interactive-gate contract.
 *
 * Interrupting the user is exceptional. A gate is justified only when the user
 * genuinely owns the next safe edge — a discretionary choice, authority or a
 * credential only they hold, essential input nobody can derive, an uncovered
 * irreversible action, or an external effect that stayed uncertain after
 * reconciliation.
 *
 * Everything else the host knows how to handle is a deterministic hold: it stops
 * the affected work, explains the dependency, and resumes on its own. Model
 * uncertainty, checker disagreement, low confidence, tool use, task size and
 * generic risk labels are not gates.
 *
 * The enforcement is structural rather than advisory. `deriveGateReason` accepts
 * only durable facts the host can verify, so there is no field through which a
 * model or checker could assert that a gate is needed. A gate reason cannot be
 * spelled; it can only be derived.
 */

/** Every interactive reason the host may ever raise. Closed on purpose. */
export type GateReason =
  | 'discretion_required'
  | 'user_authority_required'
  | 'credential_connection_required'
  | 'essential_input_required'
  | 'irreversible_approval_required'
  | 'uncertain_external_effect_requires_user';

export const GATE_REASONS: readonly GateReason[] = Object.freeze([
  'discretion_required',
  'user_authority_required',
  'credential_connection_required',
  'essential_input_required',
  'irreversible_approval_required',
  'uncertain_external_effect_requires_user',
]);

/**
 * Deterministic holds. The host knows work cannot continue, and also knows no
 * user decision is inherently required, so these publish `blocked` and resume
 * automatically once the dependency clears.
 */
export type DeterministicHold =
  | 'admission_refused'
  | 'capability_identity_mismatch'
  | 'observation_unavailable'
  | 'provider_unavailable'
  | 'lease_unavailable'
  | 'reconciliation_pending'
  | 'budget_exhausted';

/** What the work is, as the host durably classified it — never as prose. */
export type WorkPosture =
  /** No action requested. Never gates, never pays execution ceremony. */
  | 'conversation'
  /** Authorized read. Never gates: looking is not doing. */
  | 'authorized_read'
  /** Authorized and reversible. Proceeds; a mistake can be undone. */
  | 'authorized_reversible'
  /** Consequential and irreversible. May gate, but only when uncovered. */
  | 'irreversible';

/**
 * Durable facts only.
 *
 * Note what is absent and cannot be added without changing this type: model
 * confidence, checker verdicts, risk scores, tool counts, step counts. Those
 * were the historical sources of unnecessary prompts.
 */
export interface GateFacts {
  posture: WorkPosture;
  /** The user must choose between materially different acceptable outcomes. */
  discretionaryChoice?: { optionIds: readonly string[] };
  /** A connection only the user can authorize. */
  missingCredentialConnection?: { capabilityId: string };
  /** Authority the user holds and has not granted. */
  missingUserAuthority?: { requiredScope: string };
  /** Task input that cannot be derived from the accepted source. */
  missingEssentialInput?: { slotIds: readonly string[] };
  /** An irreversible effect not covered by accepted or standing authority. */
  uncoveredIrreversibleEffect?: { effect: string };
  /**
   * A possibly-committed external effect. `reconciliation` must already have
   * run: `present`/`absent` are determinate and resolve without the user, so
   * only `unknown` can reach a gate.
   */
  possiblyCommittedEffect?: {
    physicalDispatchId: string;
    reconciliation: 'present' | 'absent' | 'unknown';
  };
  /** A deterministic dependency the host is holding on. */
  deterministicHold?: DeterministicHold;
}

export type GateDisposition =
  | { status: 'proceed' }
  | { status: 'blocked'; hold: DeterministicHold }
  | { status: 'needs_input'; reason: GateReason };

/**
 * The one place a gate reason comes from.
 *
 * Order matters: a possibly-committed effect outranks everything, because
 * retrying it could duplicate a real external change.
 */
export function deriveGateReason(facts: GateFacts): GateReason | null {
  if (facts.possiblyCommittedEffect?.reconciliation === 'unknown') {
    return 'uncertain_external_effect_requires_user';
  }
  // Talking never requires a connection. Looking does not require permission
  // to look — but a missing credential is a user-owned connection act, not a
  // "may I read?" prompt, so it still gates.
  if (facts.posture === 'conversation') return null;
  if (facts.missingCredentialConnection) return 'credential_connection_required';
  if (facts.posture === 'authorized_read') return null;
  if (facts.missingUserAuthority) return 'user_authority_required';
  if (facts.missingEssentialInput?.slotIds.length) return 'essential_input_required';
  if (facts.discretionaryChoice && facts.discretionaryChoice.optionIds.length > 1) {
    return 'discretion_required';
  }
  if (facts.posture === 'irreversible' && facts.uncoveredIrreversibleEffect) {
    return 'irreversible_approval_required';
  }
  return null;
}

/**
 * The full matrix: proceed, hold deterministically, or ask exactly once.
 *
 * A gate outranks a deterministic hold, since the user's answer is what would
 * clear it; a hold the host can clear itself never becomes a question.
 */
export function disposeGate(facts: GateFacts): GateDisposition {
  const reason = deriveGateReason(facts);
  if (reason) return { status: 'needs_input', reason };
  if (facts.deterministicHold) return { status: 'blocked', hold: facts.deterministicHold };
  return { status: 'proceed' };
}

/** True when this disposition interrupts the user. Used to count prompts. */
export function interruptsUser(disposition: GateDisposition): boolean {
  return disposition.status === 'needs_input';
}
