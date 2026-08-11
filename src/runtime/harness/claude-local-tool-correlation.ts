import {
  appendEvent,
  listEvents,
  type EventRow,
} from './eventlog.js';
import { toolCallCorrelationFingerprint } from './tool-correlation.js';
import { runtimeToolAccountingMetadata } from './tool-effect.js';
import type { DispatchLeaseRef } from './dispatch-lease.js';

/**
 * Claude's host-side canUseTool callback owns the provider toolUseID, while the
 * local MCP handler normally sees only its own transport request. This marker
 * bridges that boundary without pretending permission admission is a physical
 * tool call. The dedicated private event type keeps raw tool counters and
 * lifecycle pairing honest as well as canonical attempt readers.
 */
export const CLAUDE_LOCAL_PERMISSION_ADMISSION_EVENT = 'claude_local_permission_admitted' as const;
export const CLAUDE_LOCAL_PERMISSION_CLAIM_EVENT = 'claude_local_permission_claimed' as const;

const LOCAL_COMPOSIO_TOOL = 'composio_execute_tool';
const LOCAL_COMPOSIO_SDK_NAME = 'mcp__clementine-local__composio_execute_tool';
const LOCAL_WORK_CALL_TOOL = 'work_call';
const LOCAL_WORK_CALL_SDK_NAME = 'mcp__clementine-local__work_call';

function eventString(event: EventRow, key: string): string {
  const value = event.data[key];
  return typeof value === 'string' ? value.trim() : '';
}

function eventNumber(event: EventRow, key: string): number | null {
  const value = event.data[key];
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

function exactArgumentsPreview(input: unknown): string {
  try { return JSON.stringify(input ?? {}).slice(0, 8_000); } catch { return String(input ?? '').slice(0, 8_000); }
}

function dispatchLeaseId(dispatchLease: DispatchLeaseRef | undefined): string {
  return dispatchLease?.leaseId?.trim() ?? '';
}

export function isClaudeLocalComposioSdkTool(toolName: string): boolean {
  return toolName === LOCAL_COMPOSIO_SDK_NAME;
}

/** Local MCP calls whose provider tool-use id must survive into the inner
 * harness bracket. `work_call` needs this for one logical call/settlement;
 * the Composio read bridge predates it and additionally powers read replay. */
export function isClaudeLocalCorrelatableSdkTool(toolName: string): boolean {
  return toolName === LOCAL_COMPOSIO_SDK_NAME || toolName === LOCAL_WORK_CALL_SDK_NAME;
}

function correlatableLocalToolFromSdkName(toolName: string): string | null {
  if (toolName === LOCAL_COMPOSIO_SDK_NAME) return LOCAL_COMPOSIO_TOOL;
  if (toolName === LOCAL_WORK_CALL_SDK_NAME) return LOCAL_WORK_CALL_TOOL;
  return null;
}

function localCorrelationAllowed(toolName: string, input: unknown): boolean {
  if (toolName === LOCAL_WORK_CALL_TOOL) return true;
  if (toolName !== LOCAL_COMPOSIO_TOOL) return false;
  const metadata = runtimeToolAccountingMetadata(toolName, input);
  return metadata.effect === 'read' && Boolean(metadata.toolSlug);
}

export interface ClaudeLocalPermissionAdmissionInput {
  sessionId: string;
  sourceUserSeq: number;
  runScopeId: string;
  providerCallId: string;
  sdkToolName: string;
  input: unknown;
  directOrchestrator: boolean;
  dispatchLease?: DispatchLeaseRef;
}

/**
 * Persist the final ALLOW decision for a local MCP carrier that needs the outer
 * provider id before its handler begins. A Composio read may retain the legacy
 * fail-open behavior. `work_call` treats a missing marker as absent action
 * authority and fails closed in its adapter.
 */
export function recordClaudeLocalPermissionAdmission(
  input: ClaudeLocalPermissionAdmissionInput,
): EventRow | null {
  try {
    const localTool = correlatableLocalToolFromSdkName(input.sdkToolName);
    if (!input.directOrchestrator
      || !localTool
      || !input.sessionId.trim()
      || !input.runScopeId.trim()
      || !input.providerCallId.trim()
      || !Number.isSafeInteger(input.sourceUserSeq)
      || input.sourceUserSeq <= 0) return null;
    const metadata = runtimeToolAccountingMetadata(localTool, input.input);
    if (!localCorrelationAllowed(localTool, input.input)) return null;
    return appendEvent({
      sessionId: input.sessionId,
      turn: 0,
      role: 'system',
      type: CLAUDE_LOCAL_PERMISSION_ADMISSION_EVENT,
      data: {
        sourceUserSeq: input.sourceUserSeq,
        runScopeId: input.runScopeId,
        tool: localTool,
        providerCallId: input.providerCallId,
        correlationFingerprint: toolCallCorrelationFingerprint(localTool, input.input),
        effect: metadata.effect,
        ...(metadata.effectiveTool ? { effectiveTool: metadata.effectiveTool } : {}),
        ...(metadata.toolSlug ? { toolSlug: metadata.toolSlug } : {}),
        dispatchLeaseId: dispatchLeaseId(input.dispatchLease),
        directOrchestrator: true,
      },
    });
  } catch {
    return null;
  }
}

export interface ClaudeLocalCanonicalClaimInput {
  sessionId: string;
  sourceUserSeq: number;
  runScopeId: string;
  toolName: string;
  rawInput: unknown;
  directOrchestrator: boolean;
  dispatchLease?: DispatchLeaseRef;
}

export interface ClaudeLocalCanonicalClaim {
  providerCallId: string;
  calledEventId: string;
  admissionEventId: string;
}

function matchingCanonicalCalls(input: {
  events: readonly EventRow[];
  providerCallId: string;
  sourceUserSeq: number;
  runScopeId: string;
  toolName: string;
  correlationFingerprint: string;
}): EventRow[] {
  return input.events.filter((event) =>
    event.type === 'tool_called'
    && eventString(event, 'accounting') === 'top_level'
    && eventString(event, 'callId') === input.providerCallId
    && eventNumber(event, 'sourceUserSeq') === input.sourceUserSeq
    && eventString(event, 'runScopeId') === input.runScopeId
    && eventString(event, 'tool') === input.toolName
    && eventString(event, 'correlationFingerprint') === input.correlationFingerprint
  );
}

function hasParentedReturn(events: readonly EventRow[], calledEventId: string): boolean {
  return events.some((event) => event.type === 'tool_returned' && event.parentEventId === calledEventId);
}

function handlerClaimedAdmissionIds(events: readonly EventRow[]): ReadonlySet<string> {
  const claimed = new Set<string>();
  for (const event of events) {
    if (
      event.type === 'tool_called'
      && event.data.claudeLocalHandlerClaimed === true
    ) {
      const admissionEventId = eventString(event, 'claudePermissionAdmissionEventId');
      if (admissionEventId) claimed.add(admissionEventId);
      continue;
    }
    if (event.type === CLAUDE_LOCAL_PERMISSION_CLAIM_EVENT) {
      const admissionEventId = eventString(event, 'admissionEventId');
      if (admissionEventId) claimed.add(admissionEventId);
    }
  }
  return claimed;
}

/**
 * Claim one exact permission marker at actual MCP-handler entry and ensure the
 * provider's outer toolUseID already has its canonical tool_called row before
 * the bracket replay decision. Matching and append are synchronous, so sibling
 * handlers in one MCP process cannot interleave between the uniqueness check
 * and claim. Missing or ambiguous state declines correlation. Consumers decide
 * whether that is an optional read correlation miss or mandatory authority;
 * the action-only `work_call` adapter always treats it as mandatory.
 */
export function claimClaudeLocalPermissionAdmission(
  input: ClaudeLocalCanonicalClaimInput,
): ClaudeLocalCanonicalClaim | null {
  try {
    if (!input.directOrchestrator
      || !localCorrelationAllowed(input.toolName, input.rawInput)
      || !input.sessionId.trim()
      || !input.runScopeId.trim()
      || !Number.isSafeInteger(input.sourceUserSeq)
      || input.sourceUserSeq <= 0) return null;
    const metadata = runtimeToolAccountingMetadata(input.toolName, input.rawInput);
    const correlationFingerprint = toolCallCorrelationFingerprint(input.toolName, input.rawInput);
    const leaseId = dispatchLeaseId(input.dispatchLease);
    const events = listEvents(input.sessionId, {
      sinceSeq: input.sourceUserSeq - 1,
      types: [
        CLAUDE_LOCAL_PERMISSION_ADMISSION_EVENT,
        CLAUDE_LOCAL_PERMISSION_CLAIM_EVENT,
        'tool_called',
        'tool_returned',
      ],
    });
    const admissions = events.filter((event) =>
      event.type === CLAUDE_LOCAL_PERMISSION_ADMISSION_EVENT
      && eventNumber(event, 'sourceUserSeq') === input.sourceUserSeq
      && eventString(event, 'runScopeId') === input.runScopeId
      && eventString(event, 'tool') === input.toolName
      && eventString(event, 'correlationFingerprint') === correlationFingerprint
      && eventString(event, 'dispatchLeaseId') === leaseId
      && event.data.directOrchestrator === true
    );
    const claimedAdmissionIds = handlerClaimedAdmissionIds(events);
    const unclaimed = admissions.filter((admission) => !claimedAdmissionIds.has(admission.id));
    if (unclaimed.length !== 1) return null;
    const admission = unclaimed[0]!;
    const providerCallId = eventString(admission, 'providerCallId');
    if (!providerCallId) return null;

    // The assistant tool_use frame can occasionally reach the host stream
    // before the local handler. Reuse that one exact still-open canonical row.
    const alreadyCanonical = matchingCanonicalCalls({
      events,
      providerCallId,
      sourceUserSeq: input.sourceUserSeq,
      runScopeId: input.runScopeId,
      toolName: input.toolName,
      correlationFingerprint,
    });
    if (alreadyCanonical.length > 1) return null;
    if (alreadyCanonical.length === 1) {
      const called = alreadyCanonical[0]!;
      if (hasParentedReturn(events, called.id)) return null;
      const linkedAdmissionId = eventString(called, 'claudePermissionAdmissionEventId');
      if (linkedAdmissionId && linkedAdmissionId !== admission.id) return null;
      // The SDK stream won the append race. Record handler consumption as its
      // own private event rather than rewriting the immutable canonical row.
      // A second handler now sees this admission as claimed and fails open.
      appendEvent({
        sessionId: input.sessionId,
        turn: 0,
        role: 'system',
        type: CLAUDE_LOCAL_PERMISSION_CLAIM_EVENT,
        data: {
          admissionEventId: admission.id,
          calledEventId: called.id,
          providerCallId,
          sourceUserSeq: input.sourceUserSeq,
          runScopeId: input.runScopeId,
          tool: input.toolName,
          correlationFingerprint,
          directOrchestrator: true,
        },
      });
      return { providerCallId, calledEventId: called.id, admissionEventId: admission.id };
    }

    const called = appendEvent({
      sessionId: input.sessionId,
      turn: 0,
      role: 'Clem',
      type: 'tool_called',
      data: {
        sourceUserSeq: input.sourceUserSeq,
        runScopeId: input.runScopeId,
        tool: input.toolName,
        callId: providerCallId,
        canonicalCallId: providerCallId,
        accounting: 'top_level',
        correlationFingerprint,
        effect: metadata.effect,
        ...(metadata.effectiveTool ? { effectiveTool: metadata.effectiveTool } : {}),
        ...(metadata.toolSlug ? { toolSlug: metadata.toolSlug } : {}),
        arguments: exactArgumentsPreview(input.rawInput),
        claudePermissionAdmissionEventId: admission.id,
        claudeLocalHandlerClaimed: true,
      },
    });
    return { providerCallId, calledEventId: called.id, admissionEventId: admission.id };
  } catch {
    return null;
  }
}

/** Reuse only the exact handler-authored canonical occurrence in the later SDK
 * assistant frame. Ordinary SDK calls keep the existing append behavior. */
export function findClaimedClaudeLocalCanonicalCall(input: {
  sessionId: string;
  sourceUserSeq: number;
  runScopeId: string;
  providerCallId: string;
  sdkToolName: string;
  rawInput: unknown;
}): EventRow | null {
  try {
    const localTool = correlatableLocalToolFromSdkName(input.sdkToolName);
    if (!input.sessionId.trim()
      || !input.runScopeId.trim()
      || !input.providerCallId.trim()
      || !Number.isSafeInteger(input.sourceUserSeq)
      || input.sourceUserSeq <= 0
      || !localTool
      || !localCorrelationAllowed(localTool, input.rawInput)) return null;
    const fingerprint = toolCallCorrelationFingerprint(localTool, input.rawInput);
    const events = listEvents(input.sessionId, {
      sinceSeq: input.sourceUserSeq - 1,
      types: [
        CLAUDE_LOCAL_PERMISSION_ADMISSION_EVENT,
        CLAUDE_LOCAL_PERMISSION_CLAIM_EVENT,
        'tool_called',
        'tool_returned',
      ],
    });
    const admissions = events.filter((event) =>
      event.type === CLAUDE_LOCAL_PERMISSION_ADMISSION_EVENT
      && eventNumber(event, 'sourceUserSeq') === input.sourceUserSeq
      && eventString(event, 'runScopeId') === input.runScopeId
      && eventString(event, 'tool') === localTool
      && eventString(event, 'providerCallId') === input.providerCallId
      && eventString(event, 'correlationFingerprint') === fingerprint
      && event.data.directOrchestrator === true
    );
    if (admissions.length !== 1) return null;
    const admission = admissions[0]!;
    const matches = events.filter((event) =>
      event.type === 'tool_called'
      && eventString(event, 'accounting') === 'top_level'
      && eventString(event, 'callId') === input.providerCallId
      && eventNumber(event, 'sourceUserSeq') === input.sourceUserSeq
      && eventString(event, 'runScopeId') === input.runScopeId
      && eventString(event, 'tool') === localTool
      && eventString(event, 'correlationFingerprint') === fingerprint
    );
    if (matches.length !== 1) return null;
    const called = matches[0]!;
    const handlerAuthored = called.data.claudeLocalHandlerClaimed === true
      && eventString(called, 'claudePermissionAdmissionEventId') === admission.id;
    const streamFirstClaims = events.filter((event) =>
      event.type === CLAUDE_LOCAL_PERMISSION_CLAIM_EVENT
      && eventString(event, 'admissionEventId') === admission.id
      && eventString(event, 'calledEventId') === called.id
      && eventString(event, 'providerCallId') === input.providerCallId
      && eventNumber(event, 'sourceUserSeq') === input.sourceUserSeq
      && eventString(event, 'runScopeId') === input.runScopeId
      && eventString(event, 'tool') === localTool
      && eventString(event, 'correlationFingerprint') === fingerprint
      && event.data.directOrchestrator === true
    );
    return handlerAuthored || streamFirstClaims.length === 1 ? called : null;
  } catch {
    return null;
  }
}
