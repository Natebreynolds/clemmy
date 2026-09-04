/**
 * Settle a carrier refusal after the host has resolved its inner callable.
 *
 * Once a transport such as call_tool/work_call refines the durable logical
 * contract from the outer envelope to the exact inner tool + arguments, every
 * later refusal belongs to that inner contract. Letting the outer SDK wrapper
 * settle its carrier envelope would contradict the refinement and erase the
 * useful recovery. This provider-neutral seam records the trusted no-dispatch
 * fact once; the outer wrapper then observes a settled logical row and skips
 * its transport mirror.
 */
import { ExternalWritePreDispatchError } from './external-write-admission.js';
import { settleToolAttempt, type SettleToolAttemptInput } from './attempt-settlement.js';
import {
  actionTopologyRoleForRuntimeCall,
  classifyRuntimeToolEffect,
  unwrapRuntimeEffectiveToolIdentity,
} from './tool-effect.js';

export interface ResolvedCarrierTarget {
  sessionId: string;
  sourceUserSeq?: number;
  turn?: number;
  logicalToolCallId?: string;
  targetName: string;
  targetArgs: unknown;
  targetInputSchema?: unknown | null;
}

export function settleResolvedCarrierRefusal(input: {
  resolved: ResolvedCarrierTarget;
  lane: SettleToolAttemptInput['lane'];
  refusal: unknown;
  classification: 'invalid_arguments' | 'policy_denial';
  businessCall?: boolean;
}): boolean {
  const { resolved } = input;
  if (
    !Number.isSafeInteger(resolved.sourceUserSeq)
    || (resolved.sourceUserSeq ?? 0) <= 0
    || !resolved.logicalToolCallId
  ) return false;

  // A carrier may have already refined the durable logical row to its exact
  // semantic operation. Refusing/settling the transport spelling (for example
  // `composio_execute_tool`) contradicts that row and poisons the accepted
  // root. Project to the provider-neutral effective identity before writing
  // any no-dispatch settlement; malformed carriers deliberately retain their
  // raw identity and continue to fail closed.
  const effective = unwrapRuntimeEffectiveToolIdentity(
    resolved.targetName,
    resolved.targetArgs,
  );
  const settledToolName = effective.toolName ?? resolved.targetName;
  const settledArgs = effective.toolName ? effective.args : resolved.targetArgs;
  const effect = classifyRuntimeToolEffect(settledToolName, settledArgs).effect;
  const refusedByThrow = input.refusal instanceof ExternalWritePreDispatchError;
  settleToolAttempt({
    sessionId: resolved.sessionId,
    sourceUserSeq: resolved.sourceUserSeq as number,
    turn: resolved.turn,
    lane: input.lane,
    toolName: settledToolName,
    callId: resolved.logicalToolCallId,
    args: settledArgs,
    mutating: effect === 'local_write' || effect === 'external_write' || effect === 'admin',
    // Match the rule the settling bracket uses for an ordinary call. The host
    // freezes mutating/businessCall before invoking, then ADOPTS the inner
    // settlement and refuses any row that disagrees — so a refusal that simply
    // assumed "business" turned a correct, recoverable refusal of a CONTROL
    // tool into a lane-ending authority conflict. A pre-dispatch refusal has no
    // bracket outcome, so the bracket's discovery term is vacuously satisfied
    // and the role alone decides.
    businessCall: input.businessCall
      ?? actionTopologyRoleForRuntimeCall(settledToolName, settledArgs) === 'business',
    ...(refusedByThrow ? { thrown: input.refusal } : { result: input.refusal }),
    signals: {
      preDispatch: true,
      ...(input.classification === 'invalid_arguments'
        ? {
            argumentValidationFailed: true,
            schemaAvailable: resolved.targetInputSchema != null,
          }
        : { policyRefused: true }),
    },
  });
  return true;
}
