/**
 * Claude local-MCP adapter for the provider-neutral `work_call` carrier.
 *
 * Registration is not a feature flag: the exact persisted accepted task must
 * already be an activated action. Direct/retrieve turns therefore keep their
 * existing tool surface byte-for-byte, while an action turn receives one
 * first-class carrier whose inner call still crosses the ordinary harness
 * brackets and capability authority.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Tool } from '@openai/agents';
import { wrapToolForHarness } from '../runtime/harness/brackets.js';
import { actionExpectedWorkState } from '../runtime/harness/expected-work-admission.js';
import { ExternalWritePreDispatchResult } from '../runtime/harness/external-write-admission.js';
import {
  claimClaudeLocalPermissionAdmission,
} from '../runtime/harness/claude-local-tool-correlation.js';
import {
  parseDispatchLease,
  type DispatchLeaseRef,
} from '../runtime/harness/dispatch-lease.js';
import {
  buildWorkCall,
  WorkCallInputSchema,
  type BuildWorkCallOptions,
  type WorkCallInput,
} from './work-call.js';
import { isHarnessRefusalText, textResult } from './shared.js';

type InvokableWorkCall = Tool<unknown> & {
  invoke?: (
    runContext: unknown,
    input: string,
    details?: { toolCall?: { callId?: string; id?: string } },
  ) => Promise<unknown>;
  description?: string;
};

const EXPECTED_WORK_REFUSAL_KINDS = new Set([
  'work_contract_required',
  'work_contract_invalid',
  'work_contract_conflict',
  'work_binding_required',
  'work_requirement_unknown',
  'work_effect_mismatch',
  'work_dependency_pending',
  'work_cardinality_mismatch',
  'work_universe_unsealed',
  'work_source_witness_missing',
  'work_already_satisfied',
  'work_evidence_incomplete',
  'work_effect_already_executed',
  'work_authority_unavailable',
]);

/** Exact model-facing error detection. Provider payload prose cannot trip it:
 * a work refusal must be the carrier's own JSON envelope and prove no dispatch. */
export function isExpectedWorkMcpRefusal(text: string): boolean {
  if (isHarnessRefusalText(text)) return true;
  try {
    const value = JSON.parse(text) as { error?: unknown; dispatch_state?: unknown };
    return value.dispatch_state === 'not_started'
      && typeof value.error === 'string'
      && EXPECTED_WORK_REFUSAL_KINDS.has(value.error);
  } catch {
    return false;
  }
}

export interface RegisterClaudeActionWorkCallOptions extends BuildWorkCallOptions {
  enabled: boolean;
  sessionId?: string;
  sourceUserSeq?: number;
  runScopeId?: string;
  directOrchestrator?: boolean;
  dispatchLease?: DispatchLeaseRef;
}

/** Returns true only when the exact action-owned carrier was registered. */
export function registerClaudeActionWorkCall(
  server: McpServer,
  options: RegisterClaudeActionWorkCallOptions,
): boolean {
  if (!options.enabled) return false;
  const sessionId = options.sessionId?.trim()
    || process.env.CLEMENTINE_MCP_SESSION_ID?.trim()
    || '';
  const sourceUserSeq = Number.isSafeInteger(options.sourceUserSeq) && (options.sourceUserSeq ?? 0) > 0
    ? options.sourceUserSeq
    : (() => {
        const parsed = Number.parseInt(process.env.CLEMENTINE_MCP_SOURCE_USER_SEQ ?? '', 10);
        return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
      })();
  const runScopeId = options.runScopeId?.trim()
    || process.env.CLEMENTINE_MCP_RUN_SCOPE_ID?.trim()
    || '';
  const directOrchestrator = options.directOrchestrator
    ?? (process.env.CLEMENTINE_MCP_DIRECT_ORCHESTRATOR ?? '').trim().toLowerCase() === 'on';
  const dispatchLease = options.dispatchLease
    ?? parseDispatchLease(process.env.CLEMENTINE_MCP_DISPATCH_LEASE_JSON);
  if (!sessionId || !Number.isSafeInteger(sourceUserSeq) || (sourceUserSeq ?? 0) <= 0) return false;
  const authority = actionExpectedWorkState({
    sessionId,
    sourceUserSeq: sourceUserSeq as number,
  });
  if (authority.status !== 'required') return false;

  const base = buildWorkCall({
    ...options,
    settlementLane: options.settlementLane ?? 'claude_sdk',
  }) as unknown as InvokableWorkCall;
  if (typeof base.invoke !== 'function') return false;
  const wrapped = wrapToolForHarness(base as never) as InvokableWorkCall;

  const registered = server.tool(
    'work_call',
    base.description ?? 'Invoke one business tool under the exact frozen semantic work contract.',
    WorkCallInputSchema.shape,
    async (input: WorkCallInput) => {
      const claim = claimClaudeLocalPermissionAdmission({
        sessionId,
        sourceUserSeq: sourceUserSeq as number,
        runScopeId,
        toolName: 'work_call',
        rawInput: input,
        directOrchestrator,
        // Registration above proved this exact accepted source is an active
        // expected-work action. Workers inherit that authority even though
        // they are not the direct conversational orchestrator.
        actionExpectedWork: true,
        dispatchLease,
      });
      // The SDK permission seam owns the provider call id and records the exact
      // admission before returning ALLOW. Unlike the older read-only bridge,
      // work_call is action authority: an absent/ambiguous claim must not mint
      // a second identity and dispatch under it. Fail closed on the MCP wire.
      if (!claim) {
        const rendered = JSON.stringify({
          isError: true,
          ok: false,
          error: 'work_authority_unavailable',
          dispatch_state: 'not_started',
          detail: 'The exact Claude permission admission for this work_call is missing or ambiguous.',
          repair: 'Retry the same intended work through one fresh work_call. If the problem repeats, explain the blocker conversationally.',
        });
        return textResult(rendered, { isError: true });
      }
      const callId = claim.providerCallId;
      const output = await wrapped.invoke!(
        { context: { sessionId } },
        JSON.stringify(input),
        { toolCall: { callId } },
      );
      const rendered = output instanceof ExternalWritePreDispatchResult
        ? output.output
        : typeof output === 'string'
          ? output
          : JSON.stringify(output ?? null);
      return textResult(rendered, { isError: isExpectedWorkMcpRefusal(rendered) });
    },
  );
  return registered !== undefined;
}
