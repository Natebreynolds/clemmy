/**
 * What happened when we called a tool — one typed answer, for every lane.
 *
 * Before this, each boundary computed a classification and then destroyed it:
 * a kind was rendered into English and thrown as a bare Error, a Composio
 * refusal became a string banner, a scope denial became prose. Nothing
 * downstream could branch on any of it, so recovery was decided by whoever
 * happened to regex the message next.
 *
 * Two rules hold this module together:
 *
 *  1. **It is a returned value, never a throw.** The Agents SDK launders thrown
 *     errors into prose (`error_as_result`), which is exactly how the typed
 *     refusal was lost crossing the MCP boundary. The repo already worked around
 *     this once with a pre-dispatch *result*; this generalizes that precedent.
 *
 *  2. **Nominal evidence outranks text.** Structure the provider actually gave
 *     us — an error class, a status code, an envelope field — decides first.
 *     Prose matching may only ever produce `unknown`, never a variant that
 *     changes a budget or authorizes a retry. A wrong guess about wording must
 *     not be able to spend the user's money or close their task.
 */

export type AttemptOutcomeKind =
  /** The call did what was asked. */
  | 'succeeded'
  /** The call was shaped wrong. Repairable: return the callable schema. */
  | 'invalid_arguments'
  /** Transport or server hiccup. Repairable by waiting. */
  | 'transient'
  /** This carrier cannot do this, at all. The candidate is wrong, not the goal. */
  | 'unsupported_capability'
  /** The carrier accepted the call and quietly dropped something required —
   *  the most dangerous outcome, because it looks like success. */
  | 'ignored_requirement'
  /** Only the user can supply what is missing. */
  | 'input_required'
  /** The connection is expired, revoked, or absent. */
  | 'auth_failure'
  /** Refused on policy. Not a candidate problem; stop and explain. */
  | 'policy_denial'
  /** A mutation may or may not have landed. Reconcile before ANY retry. */
  | 'uncertain_write'
  /** The call worked and returned nothing. Not a failure, not an answer. */
  | 'empty_result'
  /** Unclassifiable. Deliberately inert: it authorizes nothing. */
  | 'unknown';

/**
 * What the RUNTIME should do next. The model still writes the words; this
 * decides whether there is anything to write them about.
 */
export type RecoveryAction =
  | 'settle'
  | 'repair_arguments'
  | 'retry_with_backoff'
  | 'try_sibling_candidate'
  | 'ask_user'
  | 'recover_connection'
  | 'stop_and_explain'
  | 'reconcile_then_decide';

export interface RecoveryDirective {
  action: RecoveryAction;
  /** May the SAME candidate with the SAME canonical arguments be called again? */
  retrySameCandidate: boolean;
  /** Is this candidate now unsuitable for the current requirement? */
  eliminatesCandidate: boolean;
  /** Should discovery get a fresh evidence epoch? */
  opensDiscoveryEpoch: boolean;
  /** Must an external mutation be reconciled before anything else? */
  requiresReconciliation: boolean;
}

const DIRECTIVES: Record<AttemptOutcomeKind, RecoveryDirective> = {
  succeeded: {
    action: 'settle',
    retrySameCandidate: false,
    eliminatesCandidate: false,
    opensDiscoveryEpoch: false,
    requiresReconciliation: false,
  },
  invalid_arguments: {
    // The candidate is right and the call was wrong: hand back the schema and
    // let it correct itself. Searching for a different tool here would abandon
    // the correct one over a typo.
    action: 'repair_arguments',
    retrySameCandidate: true,
    eliminatesCandidate: false,
    opensDiscoveryEpoch: false,
    requiresReconciliation: false,
  },
  transient: {
    action: 'retry_with_backoff',
    retrySameCandidate: true,
    eliminatesCandidate: false,
    opensDiscoveryEpoch: false,
    requiresReconciliation: false,
  },
  unsupported_capability: {
    action: 'try_sibling_candidate',
    retrySameCandidate: false,
    eliminatesCandidate: true,
    opensDiscoveryEpoch: true,
    requiresReconciliation: false,
  },
  ignored_requirement: {
    action: 'try_sibling_candidate',
    retrySameCandidate: false,
    eliminatesCandidate: true,
    opensDiscoveryEpoch: true,
    requiresReconciliation: false,
  },
  input_required: {
    action: 'ask_user',
    retrySameCandidate: false,
    eliminatesCandidate: false,
    opensDiscoveryEpoch: false,
    requiresReconciliation: false,
  },
  auth_failure: {
    action: 'recover_connection',
    retrySameCandidate: false,
    eliminatesCandidate: false,
    // NOT here. A reconnect changes what is reachable — but the reconnect has
    // not happened yet. Opening an epoch on the failure itself spends a search
    // on a catalog that is still broken, and calls it recovery. The epoch opens
    // when recovery is OBSERVED (see `auth_recovered` evidence).
    opensDiscoveryEpoch: false,
    requiresReconciliation: false,
  },
  policy_denial: {
    // Discovery must never be a way around a refusal.
    action: 'stop_and_explain',
    retrySameCandidate: false,
    eliminatesCandidate: false,
    opensDiscoveryEpoch: false,
    requiresReconciliation: false,
  },
  uncertain_write: {
    action: 'reconcile_then_decide',
    retrySameCandidate: false,
    eliminatesCandidate: false,
    opensDiscoveryEpoch: false,
    requiresReconciliation: true,
  },
  empty_result: {
    action: 'try_sibling_candidate',
    retrySameCandidate: false,
    eliminatesCandidate: false,
    opensDiscoveryEpoch: true,
    requiresReconciliation: false,
  },
  unknown: {
    // Inert by construction. An unclassifiable result must not spend a budget,
    // eliminate a candidate, or authorize a retry — otherwise every regex miss
    // becomes a decision.
    action: 'stop_and_explain',
    retrySameCandidate: false,
    eliminatesCandidate: false,
    opensDiscoveryEpoch: false,
    requiresReconciliation: false,
  },
};

export function recoveryDirectiveFor(kind: AttemptOutcomeKind): RecoveryDirective {
  return DIRECTIVES[kind];
}

export interface AttemptOutcome {
  kind: AttemptOutcomeKind;
  /** How the kind was decided. `text` never yields anything but `unknown`. */
  evidence: 'nominal' | 'structured' | 'text';
  /** Provider status/code when one was observed, preserved for lane adapters. */
  providerStatus?: number | string;
  /** Bounded classification detail — never raw provider output. */
  detail?: string;
  directive: RecoveryDirective;
}

/**
 * Structural facts a lane can supply. Every field is optional because lanes
 * genuinely differ in what they observe; none of them is a provider name, and
 * adding a provider would not add a field here.
 */
export interface AttemptSignals {
  /** The call never left the process. */
  preDispatch?: boolean;
  /** Transport status, when the lane sees one. */
  httpStatus?: number;
  /** A typed error class name the lane trusts (nominal). */
  errorName?: string;
  /** Provider envelope success flag, when the envelope is structured. */
  envelopeSuccessful?: boolean;
  /** Provider envelope error code, when the envelope carries one. */
  envelopeErrorCode?: string | number;
  /** The call mutated (or may have mutated) something outside Clementine. */
  mutating?: boolean;
  /** Dispatch completed but no acknowledgement was observed. */
  acknowledged?: boolean;
  /** The call returned a well-formed but empty result set. */
  emptyResult?: boolean;
  /** A required parameter was accepted and then absent from the effect. */
  droppedRequiredParameter?: boolean;
  /** The lane already knows the connection is missing/expired (nominal). */
  connectionMissing?: boolean;
  /** A local policy/approval layer refused (nominal). */
  policyRefused?: boolean;
  /** The lane needs something only the user can give (nominal). */
  needsUserInput?: boolean;
  /** Argument validation failed before dispatch (nominal). */
  argumentValidationFailed?: boolean;
  /**
   * MCP's own error flag on a returned result. Nominal: the server said so in
   * a field, not in a sentence.
   */
  providerReportedError?: boolean;
  /** The callable contract was available to hand back for repair. */
  schemaAvailable?: boolean;
  /** Free text, consulted last and only able to yield `unknown`. */
  text?: string;
}

const TRANSIENT_STATUS = new Set([408, 425, 429, 500, 502, 503, 504, 529]);

function outcome(
  kind: AttemptOutcomeKind,
  evidence: AttemptOutcome['evidence'],
  detail?: string,
  providerStatus?: number | string,
): AttemptOutcome {
  return {
    kind,
    evidence,
    ...(providerStatus !== undefined ? { providerStatus } : {}),
    ...(detail ? { detail: detail.replace(/\s+/g, ' ').trim().slice(0, 160) } : {}),
    directive: DIRECTIVES[kind],
  };
}

/**
 * Classify one attempt. Order is deliberate: the cheapest, most certain
 * structural facts first, and text last — where it can only ever say "I don't
 * know", which authorizes nothing.
 */
export function classifyAttemptOutcome(signals: AttemptSignals): AttemptOutcome {
  // Nominal — the lane told us directly what happened.
  if (signals.policyRefused) return outcome('policy_denial', 'nominal', 'policy');
  if (signals.needsUserInput) return outcome('input_required', 'nominal', 'input');
  if (signals.connectionMissing) return outcome('auth_failure', 'nominal', 'connection');
  if (signals.argumentValidationFailed) return outcome('invalid_arguments', 'nominal', 'validation');
  if (signals.droppedRequiredParameter) {
    return outcome('ignored_requirement', 'nominal', 'required_parameter_dropped');
  }

  // A request the provider REJECTED never became an effect, so its fate is not
  // in doubt. Only statuses that prove pre-effect rejection qualify — a 500 is
  // exactly the case where the write may well have landed.
  const rejectedBeforeEffect = typeof signals.httpStatus === 'number'
    && [400, 401, 403, 404, 405, 422, 501].includes(signals.httpStatus);

  // A mutation whose fate we cannot observe outranks every other reading: the
  // one thing worse than failing is doing it twice.
  if (
    signals.mutating
    && signals.acknowledged === false
    && signals.preDispatch !== true
    && !rejectedBeforeEffect
  ) {
    return outcome('uncertain_write', 'nominal', 'unacknowledged_mutation');
  }

  // Structured — the transport or envelope carried a machine-readable verdict.
  if (typeof signals.httpStatus === 'number') {
    const status = signals.httpStatus;
    if (status === 401 || status === 403) {
      return outcome(status === 403 ? 'policy_denial' : 'auth_failure', 'structured', `http_${status}`, status);
    }
    if (status === 400 || status === 422) return outcome('invalid_arguments', 'structured', `http_${status}`, status);
    if (status === 404 || status === 405 || status === 501) {
      return outcome('unsupported_capability', 'structured', `http_${status}`, status);
    }
    if (TRANSIENT_STATUS.has(status)) return outcome('transient', 'structured', `http_${status}`, status);
    if (status >= 200 && status < 300 && signals.emptyResult) {
      return outcome('empty_result', 'structured', `http_${status}`);
    }
    if (status >= 200 && status < 300) return outcome('succeeded', 'structured', `http_${status}`);
  }

  // MCP's own error flag is the server saying "this failed" in a field.
  if (signals.providerReportedError === true) {
    return outcome('unsupported_capability', 'structured', 'mcp_is_error');
  }
  if (signals.envelopeSuccessful === true || signals.providerReportedError === false) {
    return signals.emptyResult
      ? outcome('empty_result', 'structured', 'envelope_empty')
      : outcome('succeeded', 'structured', 'envelope');
  }
  if (signals.envelopeSuccessful === false) {
    // A structured failure is real, but WHY it failed is not stated; treat the
    // candidate as unproven rather than guessing a reason from prose.
    return outcome('unsupported_capability', 'structured', 'envelope_failure');
  }

  if (signals.emptyResult) return outcome('empty_result', 'structured', 'empty');

  // Nominal error classes the lane trusts.
  if (signals.errorName) {
    const name = signals.errorName;
    if (/PreDispatch/i.test(name)) return outcome('invalid_arguments', 'nominal', name);
    if (/Timeout|Abort/i.test(name)) {
      return signals.mutating
        ? outcome('uncertain_write', 'nominal', name)
        : outcome('transient', 'nominal', name);
    }
  }

  // Text is last and cannot produce anything actionable — by design.
  return outcome('unknown', 'text', signals.text ? 'unclassified' : undefined);
}
