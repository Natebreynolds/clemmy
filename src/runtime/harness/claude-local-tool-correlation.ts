import {
  appendEvent,
  listEvents,
  getRunAttemptSourceUserEvent,
  openEventLog,
  type EventRow,
} from './eventlog.js';
import { toolCallCorrelationFingerprint } from './tool-correlation.js';
import { runtimeToolAccountingMetadata } from './tool-effect.js';
import { isDispatchLeaseCurrent, type DispatchLeaseRef } from './dispatch-lease.js';
import { TOOL_REGISTRY } from '../../tools/tool-registry.js';
import { stableJsonDigest } from '../../shared/stable-json-digest.js';

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
const LOCAL_CALL_TOOL = 'call_tool';
const LOCAL_SDK_PREFIX = 'mcp__clementine-local__';
const SPACE_WRITES = new Set(TOOL_REGISTRY.filter(tool => tool.featureGroup === 'spaces-dock'
  && tool.name.startsWith('space_') && tool.sideEffect !== 'read').map(tool => tool.name));

/** Registry membership identifies the write; naming a provider lookalike or
 * an unknown Space-prefixed tool never creates a local execution surface. */
export function claudeLocalSpaceWriteTarget(toolName: string, input: unknown): string | null {
  if (SPACE_WRITES.has(toolName)) return toolName;
  if (toolName !== LOCAL_CALL_TOOL || !input || typeof input !== 'object' || Array.isArray(input)) return null;
  const name = (input as Record<string, unknown>).name;
  const target = typeof name === 'string' ? name.trim() : '';
  return SPACE_WRITES.has(target) ? target : null;
}

export function isClaudeLocalSpaceWriteSdkTool(toolName: string, input: unknown): boolean {
  return toolName.startsWith(LOCAL_SDK_PREFIX)
    && claudeLocalSpaceWriteTarget(toolName.slice(LOCAL_SDK_PREFIX.length), input) !== null;
}

/** The legacy read fingerprint normalizes nulls and JSON-looking strings.
 * Writes additionally bind the entire original JSON wire value losslessly. */
export function claudeLocalSpaceWriteInputDigest(toolName: string, input: unknown): string | undefined {
  const local = toolName.startsWith(LOCAL_SDK_PREFIX) ? toolName.slice(LOCAL_SDK_PREFIX.length) : toolName;
  return claudeLocalSpaceWriteTarget(local, input) ? stableJsonDigest(input) : undefined;
}

/** Claude Code 0.3.280 sends its original tool-use id in MCP request metadata.
 * This is transport data, never an argument/schema field. Matching only the
 * arguments cannot distinguish a replay of A from pending same-payload B. */
export function claudeLocalMcpProviderCallId(extra: unknown): string | undefined {
  if (!extra || typeof extra !== 'object' || !Object.hasOwn(extra, '_meta')) return undefined;
  const meta = (extra as Record<string, unknown>)._meta;
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)
    || !Object.hasOwn(meta, 'claudecode/toolUseId')) return undefined;
  const id = (meta as Record<string, unknown>)['claudecode/toolUseId'];
  return typeof id === 'string' && id.length > 0 && id.length <= 512 && id === id.trim()
    && !/[\u0000-\u001f\u007f]/u.test(id) ? id : undefined;
}

function spaceWriteLeaseBound(sessionId: string, sourceUserSeq: number, lease: DispatchLeaseRef | undefined): boolean {
  if (!lease || lease.sessionId !== sessionId || !lease.leaseId || !isDispatchLeaseCurrent(lease)
    || (lease.sourceUserSeq !== undefined && lease.sourceUserSeq !== sourceUserSeq)) return false;
  const actual = openEventLog().prepare(`SELECT run_attempt_id FROM run_dispatch_leases
    WHERE session_id = ? AND scope_id = ? AND lease_id = ?`).get(sessionId, lease.scopeId, lease.leaseId) as { run_attempt_id: string | null } | undefined;
  if (!actual?.run_attempt_id || actual.run_attempt_id !== lease.runAttemptId) return false;
  // Query leases are intentionally call-unbound. When they carry a durable
  // attempt, reopen that exact attempt's source rather than the latest chat.
  return getRunAttemptSourceUserEvent({ sessionId, attemptId: actual.run_attempt_id })?.seq === sourceUserSeq;
}

export function claudeLocalSpaceWriteRefusal(): string {
  return JSON.stringify({ isError: true, ok: false, error: 'space_call_identity_unavailable', dispatch_state: 'not_started',
    detail: 'This Workspace call was not started here. Its exact permission is missing, ambiguous, or already claimed; an earlier admitted change may have completed or still be uncertain.',
    repair: 'Keep the original result if available. Reconcile any earlier uncertain change before requesting another write; do not repeat a completed change.' });
}

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
export function isClaudeLocalCorrelatableSdkTool(toolName: string, input?: unknown): boolean {
  return toolName === LOCAL_COMPOSIO_SDK_NAME || toolName === LOCAL_WORK_CALL_SDK_NAME
    || isClaudeLocalSpaceWriteSdkTool(toolName, input);
}

function correlatableLocalToolFromSdkName(toolName: string, input: unknown): string | null {
  if (toolName === LOCAL_COMPOSIO_SDK_NAME) return LOCAL_COMPOSIO_TOOL;
  if (toolName === LOCAL_WORK_CALL_SDK_NAME) return LOCAL_WORK_CALL_TOOL;
  if (isClaudeLocalSpaceWriteSdkTool(toolName, input)) return toolName.slice(LOCAL_SDK_PREFIX.length);
  return null;
}

function localCorrelationAllowed(toolName: string, input: unknown): boolean {
  if (toolName === LOCAL_WORK_CALL_TOOL) return true;
  if (claudeLocalSpaceWriteTarget(toolName, input)) return true;
  if (toolName !== LOCAL_COMPOSIO_TOOL) return false;
  const metadata = runtimeToolAccountingMetadata(toolName, input);
  return metadata.effect === 'read' && Boolean(metadata.toolSlug);
}

/**
 * Correlation authority follows the carrier's real owner, not one lane label.
 *
 * The legacy bare Composio bridge is a conversational-orchestrator read replay
 * and remains direct-only. `work_call` is different: its MCP registration is
 * already conditional on the exact persisted source having active expected-work
 * authority, and workers/steps inherit that accepted source without becoming
 * the direct conversational orchestrator. Requiring both facts stranded every
 * Claude worker action before provider dispatch (live 2026-08-12).
 */
function localCorrelationAuthorityAllowed(input: {
  toolName: string;
  directOrchestrator: boolean;
  actionExpectedWork?: boolean;
  rawInput?: unknown;
}): boolean {
  if (input.toolName === LOCAL_WORK_CALL_TOOL) return input.actionExpectedWork === true;
  if (input.toolName === LOCAL_COMPOSIO_TOOL) return input.directOrchestrator === true;
  if (claudeLocalSpaceWriteTarget(input.toolName, input.rawInput)) return true;
  return false;
}

function eventCarriesLocalCorrelationAuthority(event: EventRow, toolName: string, spaceWriteTarget: string | null = null): boolean {
  if (spaceWriteTarget) return event.data.spaceWriteTarget === spaceWriteTarget;
  return toolName === LOCAL_WORK_CALL_TOOL
    ? event.data.actionExpectedWork === true
    : toolName === LOCAL_COMPOSIO_TOOL && event.data.directOrchestrator === true;
}

export interface ClaudeLocalPermissionAdmissionInput {
  sessionId: string;
  sourceUserSeq: number;
  runScopeId: string;
  providerCallId: string;
  sdkToolName: string;
  input: unknown;
  directOrchestrator: boolean;
  /** Host-derived from the exact persisted accepted source. Never model input. */
  actionExpectedWork?: boolean;
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
    const localTool = correlatableLocalToolFromSdkName(input.sdkToolName, input.input);
    const spaceWriteTarget = localTool ? claudeLocalSpaceWriteTarget(localTool, input.input) : null;
    if (!localTool
      || !localCorrelationAuthorityAllowed({
        toolName: localTool,
        directOrchestrator: input.directOrchestrator,
        actionExpectedWork: input.actionExpectedWork,
        rawInput: input.input,
      })
      || !input.sessionId.trim()
      || !input.runScopeId.trim()
      || !input.providerCallId.trim()
      || !Number.isSafeInteger(input.sourceUserSeq)
      || input.sourceUserSeq <= 0
      || (spaceWriteTarget && !spaceWriteLeaseBound(input.sessionId, input.sourceUserSeq, input.dispatchLease))) return null;
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
        ...(spaceWriteTarget ? { spaceWriteTarget, exactInputDigest: claudeLocalSpaceWriteInputDigest(localTool, input.input) } : {}),
        effect: metadata.effect,
        ...(metadata.effectiveTool ? { effectiveTool: metadata.effectiveTool } : {}),
        ...(metadata.toolSlug ? { toolSlug: metadata.toolSlug } : {}),
        dispatchLeaseId: dispatchLeaseId(input.dispatchLease),
        directOrchestrator: input.directOrchestrator === true,
        ...(localTool === LOCAL_WORK_CALL_TOOL ? { actionExpectedWork: true } : {}),
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
  /** Host-derived from the exact persisted accepted source. Never model input. */
  actionExpectedWork?: boolean;
  dispatchLease?: DispatchLeaseRef;
  /** Original Claude MCP transport metadata. Required for Space mutations;
   * legacy work_call/read correlation retains its existing matching policy. */
  providerCallId?: string;
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
  exactInputDigest?: string;
}): EventRow[] {
  return input.events.filter((event) =>
    event.type === 'tool_called'
    && eventString(event, 'accounting') === 'top_level'
    && eventString(event, 'callId') === input.providerCallId
    && eventNumber(event, 'sourceUserSeq') === input.sourceUserSeq
    && eventString(event, 'runScopeId') === input.runScopeId
    && eventString(event, 'tool') === input.toolName
    && eventString(event, 'correlationFingerprint') === input.correlationFingerprint
    && (input.exactInputDigest === undefined || eventString(event, 'exactInputDigest') === input.exactInputDigest)
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
    const spaceWriteTarget = claudeLocalSpaceWriteTarget(input.toolName, input.rawInput);
    const exactInputDigest = claudeLocalSpaceWriteInputDigest(input.toolName, input.rawInput);
    if (!localCorrelationAuthorityAllowed(input)
      || !localCorrelationAllowed(input.toolName, input.rawInput)
      || !input.sessionId.trim()
      || !input.runScopeId.trim()
      || !Number.isSafeInteger(input.sourceUserSeq)
      || input.sourceUserSeq <= 0
      || (spaceWriteTarget && (!spaceWriteLeaseBound(input.sessionId, input.sourceUserSeq, input.dispatchLease)
        || !input.providerCallId || input.providerCallId !== input.providerCallId.trim()))) return null;
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
      && eventCarriesLocalCorrelationAuthority(event, input.toolName, spaceWriteTarget)
      && (exactInputDigest === undefined || eventString(event, 'exactInputDigest') === exactInputDigest)
      && (!spaceWriteTarget || eventString(event, 'providerCallId') === input.providerCallId)
    );
    const claimedAdmissionIds = handlerClaimedAdmissionIds(events);
    const unclaimed = admissions.filter((admission) => !claimedAdmissionIds.has(admission.id));
    if (unclaimed.length !== 1 || (spaceWriteTarget && admissions.length !== 1)) return null;
    const admission = unclaimed[0]!;
    const providerCallId = eventString(admission, 'providerCallId');
    if (!providerCallId) return null;
    // Never append another outer occurrence when this provider id already
    // names different original write bytes, tool, or query scope.
    if (spaceWriteTarget && events.some(event => event.type === 'tool_called'
      && eventString(event, 'accounting') === 'top_level'
      && eventString(event, 'callId') === providerCallId
      && eventNumber(event, 'sourceUserSeq') === input.sourceUserSeq
      && (eventString(event, 'tool') !== input.toolName || eventString(event, 'runScopeId') !== input.runScopeId
        || eventString(event, 'exactInputDigest') !== exactInputDigest))) return null;

    // The assistant tool_use frame can occasionally reach the host stream
    // before the local handler. Reuse that one exact still-open canonical row.
    const alreadyCanonical = matchingCanonicalCalls({
      events,
      providerCallId,
      sourceUserSeq: input.sourceUserSeq,
      runScopeId: input.runScopeId,
      toolName: input.toolName,
      correlationFingerprint,
      exactInputDigest,
    });
    if (alreadyCanonical.length > 1) return null;
    if (alreadyCanonical.length === 1) {
      const called = alreadyCanonical[0]!;
      if (hasParentedReturn(events, called.id)) return null;
      const linkedAdmissionId = eventString(called, 'claudePermissionAdmissionEventId');
      if (linkedAdmissionId && linkedAdmissionId !== admission.id) return null;
      // The SDK stream won the append race. Record handler consumption as its
      // own private event rather than rewriting the immutable canonical row.
      // A second handler now sees this admission as claimed. Legacy optional
      // read correlation may fall back; the Space write adapters fail closed.
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
          ...(spaceWriteTarget ? { spaceWriteTarget, exactInputDigest } : {}),
          directOrchestrator: input.directOrchestrator === true,
          ...(input.toolName === LOCAL_WORK_CALL_TOOL ? { actionExpectedWork: true } : {}),
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
        ...(spaceWriteTarget ? { spaceWriteTarget, exactInputDigest } : {}),
        effect: metadata.effect,
        ...(metadata.effectiveTool ? { effectiveTool: metadata.effectiveTool } : {}),
        ...(metadata.toolSlug ? { toolSlug: metadata.toolSlug } : {}),
        arguments: exactArgumentsPreview(input.rawInput),
        claudePermissionAdmissionEventId: admission.id,
        claudeLocalHandlerClaimed: true,
        directOrchestrator: input.directOrchestrator === true,
        ...(input.toolName === LOCAL_WORK_CALL_TOOL ? { actionExpectedWork: true } : {}),
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
  directOrchestrator: boolean;
  actionExpectedWork?: boolean;
}): EventRow | null {
  try {
    const localTool = correlatableLocalToolFromSdkName(input.sdkToolName, input.rawInput);
    const spaceWriteTarget = localTool ? claudeLocalSpaceWriteTarget(localTool, input.rawInput) : null;
    const exactInputDigest = localTool ? claudeLocalSpaceWriteInputDigest(localTool, input.rawInput) : undefined;
    if (!input.sessionId.trim()
      || !input.runScopeId.trim()
      || !input.providerCallId.trim()
      || !Number.isSafeInteger(input.sourceUserSeq)
      || input.sourceUserSeq <= 0
      || !localTool
      || !localCorrelationAuthorityAllowed({
        toolName: localTool,
        directOrchestrator: input.directOrchestrator,
        actionExpectedWork: input.actionExpectedWork,
        rawInput: input.rawInput,
      })
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
      && eventCarriesLocalCorrelationAuthority(event, localTool, spaceWriteTarget)
      && (exactInputDigest === undefined || eventString(event, 'exactInputDigest') === exactInputDigest)
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
      && (exactInputDigest === undefined || eventString(event, 'exactInputDigest') === exactInputDigest)
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
      && eventCarriesLocalCorrelationAuthority(event, localTool, spaceWriteTarget)
      && (exactInputDigest === undefined || eventString(event, 'exactInputDigest') === exactInputDigest)
    );
    return handlerAuthored || streamFirstClaims.length === 1 ? called : null;
  } catch {
    return null;
  }
}
