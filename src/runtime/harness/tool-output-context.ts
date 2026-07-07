import { AsyncLocalStorage } from 'node:async_hooks';

export interface ToolOutputContext {
  sessionId?: string;
  callId?: string;
  toolName?: string;
  /** Set when the tool runs inside a workflow STEP — carries the run attribution
   *  so a fan-out spawned here (run_worker) is recorded under its workflow, not
   *  just the session (subagent-runs visibility spine). */
  workflowRunId?: string;
  workflowName?: string;
  stepId?: string;
}

export const toolOutputContextStorage = new AsyncLocalStorage<ToolOutputContext>();

export function withToolOutputContext<T>(
  context: ToolOutputContext,
  work: () => T | Promise<T>,
): T | Promise<T> {
  return toolOutputContextStorage.run(context, work);
}

export function getToolOutputContext(): ToolOutputContext | undefined {
  return toolOutputContextStorage.getStore();
}

export function sessionIdFromRunContext(context: unknown): string | undefined {
  if (!context || typeof context !== 'object') return undefined;
  const runtimeContext = (context as { context?: unknown }).context;
  if (!runtimeContext || typeof runtimeContext !== 'object') return undefined;
  const sessionId = (runtimeContext as { sessionId?: unknown }).sessionId;
  return typeof sessionId === 'string' && sessionId ? sessionId : undefined;
}

export function callIdFromToolDetails(details: unknown): string | undefined {
  if (!details || typeof details !== 'object') return undefined;
  const toolCall = (details as { toolCall?: unknown }).toolCall;
  if (!toolCall || typeof toolCall !== 'object') return undefined;
  const callId = (toolCall as { callId?: unknown; call_id?: unknown; id?: unknown }).callId
    ?? (toolCall as { callId?: unknown; call_id?: unknown; id?: unknown }).call_id
    ?? (toolCall as { callId?: unknown; call_id?: unknown; id?: unknown }).id;
  return typeof callId === 'string' && callId ? callId : undefined;
}

export function toolOutputContextFromSdk(
  toolName: string,
  runContext: unknown,
  details: unknown,
): ToolOutputContext {
  return {
    sessionId: sessionIdFromRunContext(runContext),
    callId: callIdFromToolDetails(details),
    toolName,
  };
}
