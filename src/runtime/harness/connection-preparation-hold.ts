/** A provider metadata refusal parks the existing execution. It grants no
 * retry lease, installs no checkpoint and never settles the original task. */
import type { SelectedComposioRevalidationRefusalCode } from '../../integrations/composio/selected-definition-revalidation.js';
import { readConnectionExecutionActivation } from './connection-execution-activation-proof.js';
import { appendEvent, openEventLog, withEventPublicationTransaction } from './eventlog.js';

type NextAction = 'retry' | 'reconnect' | 'review_plan';
type PreparationCode = SelectedComposioRevalidationRefusalCode
  | 'operation_outside_reviewed_plan' | 'reviewed_account_changed'
  | 'reviewed_operation_changed' | 'reviewed_definition_incomplete';

// Provider codes, not exception prose or model guesses, determine the next
// action. New refusal codes must make this policy explicit at compile time.
const actions: Record<PreparationCode, NextAction> = {
  selected_connection_refresh_unavailable: 'retry',
  selected_definition_exact_refresh_unavailable: 'retry',
  selected_definition_operation_version_unavailable: 'retry',
  selected_connection_missing_or_changed: 'reconnect',
  selected_connection_inactive_or_suppressed: 'reconnect',
  selected_definition_selection_limit_exceeded: 'review_plan',
  selected_definition_identity_conflict: 'review_plan',
  selected_definition_digest_invalid: 'review_plan',
  selected_definition_schema_drift: 'review_plan',
  selected_definition_output_schema_drift: 'review_plan',
  selected_definition_operation_version_drift: 'review_plan',
  selected_definition_fingerprint_drift: 'review_plan',
  selected_definition_semantic_contract_drift: 'review_plan',
  operation_outside_reviewed_plan: 'review_plan',
  reviewed_account_changed: 'review_plan',
  reviewed_operation_changed: 'review_plan',
  reviewed_definition_incomplete: 'review_plan',
};

export class ConnectionPreparationHoldError extends Error {
  constructor(readonly code: PreparationCode) {
    super(`Connection preparation paused: ${code}`);
    this.name = 'ConnectionPreparationHoldError';
  }
}

export interface ConnectionPreparationHold {
  owner: 'host';
  wake: 'connection';
  reason: 'connection_preparation';
  requestId: string;
  code: PreparationCode;
  nextAction: NextAction;
}

export function connectionPreparationHoldText(hold: ConnectionPreparationHold): string {
  if (hold.nextAction === 'retry') return 'I couldn’t verify the connection right now. Your task is paused with its completed work saved. Retry when the connection is available.';
  if (hold.nextAction === 'reconnect') return 'The reviewed account is unavailable. Your task is paused with its completed work saved. Reconnect that account before continuing.';
  return 'The connected operation no longer matches the reviewed plan. Your task is paused with its completed work saved. Review the changes before continuing.';
}

type OwnerInput = { sessionId: string; requestId: string; assertOwned: () => void };

function latestPreparationState(sessionId: string, activationEventId: string): Record<string, unknown> | null {
  const prior = openEventLog().prepare(`SELECT data_json FROM events WHERE session_id = ?
    AND type = 'restart_recovery_decision' AND parent_event_id = ?
    AND json_extract(data_json, '$.decision') IN ('connection_preparation_held', 'connection_preparation_ready')
    ORDER BY seq DESC LIMIT 1`).get(sessionId, activationEventId) as { data_json: string } | undefined;
  if (!prior) return null;
  const value: unknown = JSON.parse(prior.data_json);
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/** A wait is evidence to retain work, never authority to execute it. Exact
 * recovery scans use this to avoid polling a task that explicitly needs a
 * connection action. An explicit owned retry performs fresh checks itself. */
export function readConnectionPreparationHold(input: { sessionId: string; deliverySourceUserSeq: number }): ConnectionPreparationHold | null {
  const marker = readConnectionExecutionActivation(openEventLog(), input);
  if (!marker) return null;
  const last = latestPreparationState(input.sessionId, marker.eventId);
  if (last?.decision !== 'connection_preparation_held'
    || last.sourceUserSeq !== marker.activation.deliverySourceUserSeq
    || last.executionSourceUserSeq !== marker.activation.executionSourceUserSeq
    || last.requestId !== marker.activation.requestId || typeof last.code !== 'string'
    || !Object.hasOwn(actions, last.code)) return null;
  const code = last.code as PreparationCode;
  if (last.nextAction !== actions[code]) return null;
  return { owner: 'host', wake: 'connection', reason: 'connection_preparation',
    requestId: marker.activation.requestId, code, nextAction: actions[code] };
}

/** Deduplicate against the last preparation state for this activation. The
 * durable recovery owner remains the authority; this is UI/diagnostic state. */
function recordPreparationState(input: OwnerInput, hold?: ConnectionPreparationHold): void {
  withEventPublicationTransaction(() => {
    input.assertOwned();
    const db = openEventLog();
    const marker = readConnectionExecutionActivation(db, input);
    if (!marker) throw new Error('The connection preparation lost its retained execution.');
    const last = latestPreparationState(input.sessionId, marker.eventId);
    const decision = hold ? 'connection_preparation_held' : 'connection_preparation_ready';
    if (!hold && (!last || last.decision === decision)) return;
    if (hold && last?.decision === decision && last.code === hold.code && last.nextAction === hold.nextAction) return;
    appendEvent({ sessionId: input.sessionId, turn: 0, role: 'system', type: 'restart_recovery_decision',
      parentEventId: marker.eventId, data: { decision, sourceUserSeq: marker.activation.deliverySourceUserSeq,
        executionSourceUserSeq: marker.activation.executionSourceUserSeq, requestId: input.requestId,
        ...(hold ? { code: hold.code, nextAction: hold.nextAction } : {}) } });
  });
}

export function retainConnectionPreparationHold(input: OwnerInput, error: ConnectionPreparationHoldError): ConnectionPreparationHold {
  const hold: ConnectionPreparationHold = { owner: 'host', wake: 'connection', reason: 'connection_preparation',
    requestId: input.requestId, code: error.code, nextAction: actions[error.code] };
  recordPreparationState(input, hold);
  return hold;
}

export function clearConnectionPreparationHold(input: OwnerInput): void {
  recordPreparationState(input);
}
