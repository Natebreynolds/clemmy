import {
  loadAsyncReadRefinementOwner,
} from './async-read-refinement-store.js';
import { redeemDurableLogicalCallSettlementForHost } from './logical-call-settlement-store.js';
import { redeemSuccessfulSettlementResultForHost } from './result-handle.js';
import {
  parseAsyncReadRefinementTerminalResult,
  type AsyncReadRefinementAwaitingInputPresentation,
} from './terminal-tool.js';

function samePresentation(
  left: AsyncReadRefinementAwaitingInputPresentation,
  right: AsyncReadRefinementAwaitingInputPresentation,
): boolean {
  return left.protocol === right.protocol
    && left.terminalKind === right.terminalKind
    && left.reason === right.reason
    && left.question === right.question
    && left.options.length === right.options.length
    && left.options.every((option, index) => option === right.options[index]);
}

/**
 * Reopen one exact async terminal as host authority. The visible JSON is never
 * sufficient: an unrelated/model-controlled work_call can return identical
 * bytes. Authority requires the immutable intent and terminal receipt, the
 * exact succeeded+continues-requirement R settlement, and the exact durable
 * result handle that carried those same bytes.
 */
export function projectHostOwnedAsyncReadRefinementTerminal(input: {
  sessionId: string;
  sourceUserSeq: number;
  logicalToolCallId: string;
  rawToolName: string;
  output: unknown;
}): AsyncReadRefinementAwaitingInputPresentation | null {
  if (
    !input.sessionId.trim()
    || !Number.isSafeInteger(input.sourceUserSeq)
    || input.sourceUserSeq <= 0
    || !input.logicalToolCallId.trim()
  ) return null;
  const visible = parseAsyncReadRefinementTerminalResult(input.rawToolName, input.output);
  if (!visible) return null;
  const owner = loadAsyncReadRefinementOwner({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    startLogicalToolCallId: input.logicalToolCallId,
  });
  if (!owner?.terminalGate) return null;
  const durableGate = parseAsyncReadRefinementTerminalResult('work_call', owner.terminalGate);
  if (!durableGate || !samePresentation(visible, durableGate)) return null;

  const identity = {
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    acceptedTaskId: owner.intent.acceptedTaskId,
    logicalToolCallId: input.logicalToolCallId,
  };
  const settlement = redeemDurableLogicalCallSettlementForHost(identity);
  if (
    settlement.status !== 'ok'
    || settlement.settlement.outcome.kind !== 'succeeded'
    || settlement.settlement.recovery.businessCall !== true
    || settlement.settlement.recovery.mutating !== false
    || settlement.settlement.recovery.continuesRequirement !== true
    || settlement.settlement.recovery.requirementId !== owner.intent.requirementId
    || !settlement.settlement.resultHandleId
  ) return null;
  const result = redeemSuccessfulSettlementResultForHost(identity);
  if (
    result.status !== 'ok'
    || result.value.resultHandleId !== settlement.settlement.resultHandleId
  ) return null;
  const durableResult = parseAsyncReadRefinementTerminalResult('work_call', result.value.rawPayload);
  if (!durableResult || !samePresentation(visible, durableResult)) return null;
  return visible;
}

