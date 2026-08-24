import type {
  Model,
  ModelRequest,
  ModelResponse,
  StreamEvent,
} from '@openai/agents-core';
import type { AgentInputItem } from '@openai/agents';
import {
  inspectConversationProtocol,
  type ProtocolIssue,
} from './conversation-protocol.js';

/**
 * Assertion raised before provider I/O when canonical structured history is
 * malformed. It carries operator-only facts and deliberately has no public
 * presentation text or repair behavior.
 */
/** Bounded, deterministic issue summary for the assertion message. Codes first
 * (they name the defect class), then a capped set of call ids for locating it. */
function summarizeProtocolIssues(issues: readonly ProtocolIssue[]): string {
  if (issues.length === 0) return '';
  const codes: string[] = [];
  for (const issue of issues) {
    if (!codes.includes(issue.code)) codes.push(issue.code);
    if (codes.length >= 6) break;
  }
  const located = issues
    .filter((issue) => typeof issue.callId === 'string' && issue.callId)
    .slice(0, 3)
    .map((issue) => `${issue.code}@${issue.callId}#${issue.index}`);
  const detail = located.length > 0 ? ` [${located.join(', ')}]` : '';
  const more = issues.length > located.length ? ` (${issues.length} issue${issues.length === 1 ? '' : 's'})` : '';
  return `: ${codes.join(',')}${detail}${more}`;
}

export class ConversationProtocolBoundaryAssertionError extends Error {
  override readonly name = 'ConversationProtocolBoundaryAssertionError';

  constructor(
    readonly boundary: string,
    readonly issues: readonly ProtocolIssue[],
  ) {
    // Carry a BOUNDED issue summary in the message. Nothing catches this class
    // by name — it reaches the canonical error reducer as a plain Error, so
    // `message` is the only field that survives into `run_failed`. Without the
    // codes, a live failure reads "conversation protocol assertion failed at
    // codex.responses" and the actual defect has to be reproduced offline to be
    // named at all (2026-08-24: the real cause was
    // `conversation_advanced_with_open_call`, invisible in the durable log).
    // Operator-only: `run_failed` is deliberately not published to a surface.
    super(`conversation protocol assertion failed at ${boundary}${summarizeProtocolIssues(issues)}`);
  }
}

/**
 * Assertion-only provider canary. String prompts are single-source requests
 * and have no call/result frame to inspect. Arrays are inspected by reference;
 * this function never clones, rewrites, truncates, or repairs them.
 */
export function assertConversationProtocolAtProviderBoundary(
  input: ModelRequest['input'] | readonly AgentInputItem[] | string,
  boundary: string,
): void {
  if (!Array.isArray(input)) return;
  const inspection = inspectConversationProtocol(input as readonly AgentInputItem[]);
  if (inspection.status === 'invalid') {
    throw new ConversationProtocolBoundaryAssertionError(boundary, inspection.issues);
  }
}

/** Keep provider adapters translation-only while placing the assertion directly
 * outside their request boundary. */
export function withConversationProtocolBoundaryAssertion(
  inner: Model,
  boundary: string,
): Model {
  return {
    async getResponse(request: ModelRequest): Promise<ModelResponse> {
      assertConversationProtocolAtProviderBoundary(request.input, boundary);
      return inner.getResponse(request);
    },
    async *getStreamedResponse(request: ModelRequest): AsyncIterable<StreamEvent> {
      assertConversationProtocolAtProviderBoundary(request.input, boundary);
      yield* inner.getStreamedResponse(request);
    },
  };
}
