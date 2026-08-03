import type { ExecutionRecord } from '../types.js';
import {
  getToolOutput,
  listEvents,
  resolveToolOutputForAuthority,
  type EventRow,
  type ListEventsOptions,
} from '../runtime/harness/eventlog.js';
import { redactSensitiveText, redactSensitiveValue } from '../runtime/security.js';
import {
  completionEvidenceToolName,
  isControlOnlyTool,
  isToolSurfaceProbeTool,
  toolOutputLooksSuccessful,
} from '../runtime/harness/tool-evidence.js';
import { projectCanonicalTopLevelToolEvents } from '../runtime/harness/tool-effect.js';

const MAX_RECEIPTS = 8;
const MAX_RECEIPT_CHARS = 1_500;
const MAX_ARGUMENT_CHARS = 500;
const MAX_TOTAL_CHARS = 7_000;
const MAX_COUNT_CHARS = 1_200;

const EXECUTION_BOOKKEEPING_RE =
  /^(?:execution_|focus_|tool_choice_|memory_|working_memory$|reflect$)/i;
const VERIFICATION_ACTION_RE =
  /(?:^|_)(?:batch_get|get|read|fetch|query|list|search|status|inspect|verify|check|probe|count)(?:_|$)/i;
const EVIDENCE_VALUE_RE =
  /\b(?:receipt|message[_ -]?id|spreadsheet|document|file|url|range|values?|rows?|cells?|deployed|published|created|updated|written|sent|success(?:ful)?)\b/i;

export interface ExecutionToolEvidenceDeps {
  listEventsFn?: (sessionId: string, options?: ListEventsOptions) => EventRow[];
  getToolOutputFn?: (
    sessionId: string,
    callId: string,
  ) => { output: string; tool?: string | null } | null;
  resolveToolOutputForAuthorityFn?: typeof resolveToolOutputForAuthority;
}

interface CompletionReceipt {
  seq: number;
  callId: string;
  action: string;
  effect: string;
  args: string;
  output: string;
  score: number;
}

function eventData(event: EventRow): Record<string, unknown> {
  return event.data && typeof event.data === 'object' && !Array.isArray(event.data)
    ? event.data
    : {};
}

function decoded(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function safeJson(value: unknown): string {
  if (value == null) return '';
  try {
    return JSON.stringify(redactSensitiveValue(decoded(value)));
  } catch {
    return redactSensitiveText(String(value));
  }
}

function clipMiddle(value: string, maxChars: number): string {
  const text = value.trim();
  if (text.length <= maxChars) return text;
  const marker = ` …[clipped ${text.length - maxChars} chars]… `;
  const remaining = Math.max(0, maxChars - marker.length);
  const head = Math.ceil(remaining * 0.68);
  const tail = Math.max(0, remaining - head);
  return `${text.slice(0, head)}${marker}${tail > 0 ? text.slice(-tail) : ''}`;
}

function normalizedOutput(value: string): string {
  const redacted = redactSensitiveText(value);
  const parsed = decoded(redacted);
  if (parsed && typeof parsed === 'object') return safeJson(parsed);
  return redacted.replace(/\s+/g, ' ').trim();
}

function actionName(
  tool: string,
  callData: Record<string, unknown>,
  returnData: Record<string, unknown>,
): string {
  const explicitSlug = returnData.toolSlug ?? callData.toolSlug;
  if (typeof explicitSlug === 'string' && explicitSlug.trim()) return explicitSlug.trim();
  const input = decoded(callData.arguments ?? callData.args ?? callData.input);
  return completionEvidenceToolName(tool, input);
}

function isBookkeepingTool(tool: string, action: string): boolean {
  return EXECUTION_BOOKKEEPING_RE.test(tool)
    || EXECUTION_BOOKKEEPING_RE.test(action)
    || isControlOnlyTool(tool)
    || isControlOnlyTool(action)
    || isToolSurfaceProbeTool(tool)
    || isToolSurfaceProbeTool(action);
}

function receiptScore(action: string, effect: string, output: string): number {
  let score = 0;
  if (effect === 'read' && VERIFICATION_ACTION_RE.test(action)) score += 120;
  else if (effect === 'external_write') score += 100;
  else if (effect === 'local_write') score += 75;
  else if (effect === 'compute') score += 65;
  else if (effect === 'read') score += 55;
  else score += 35;
  if (EVIDENCE_VALUE_RE.test(output)) score += 20;
  return score;
}

/**
 * Build a small, execution-scoped digest of real successful tool receipts for
 * completion judging. The model's summary remains evidence, but it no longer
 * has to duplicate exact values, receipt ids, or artifact URLs that are already
 * durable in the tool-output ledger.
 *
 * Only canonical top-level calls are considered, bookkeeping/discovery chatter
 * is excluded, and both per-receipt and aggregate character caps keep a large
 * research run from flooding the judge context.
 */
export function recentExecutionToolEvidence(
  execution: Pick<ExecutionRecord, 'sessionId' | 'createdAt'>,
  deps: ExecutionToolEvidenceDeps = {},
): string {
  if (!execution.sessionId) return '';
  const list = deps.listEventsFn ?? listEvents;
  const getOutput = deps.getToolOutputFn ?? getToolOutput;
  // Unit callers that inject the old output reader retain their isolated
  // fixture behavior. Production authority always goes through the exact
  // invocation resolver, which refuses a reused/ambiguous SDK call id.
  const resolveOutput = deps.resolveToolOutputForAuthorityFn
    ?? (deps.getToolOutputFn ? null : resolveToolOutputForAuthority);
  let events: EventRow[];
  try {
    events = list(execution.sessionId, {
      sinceAt: execution.createdAt,
      types: ['tool_called', 'tool_returned'],
    });
  } catch {
    return '';
  }

  const canonical = projectCanonicalTopLevelToolEvents(events);
  const calls = new Map<string, EventRow>();
  for (const event of canonical) {
    if (event.type !== 'tool_called') continue;
    const callId = eventData(event).callId;
    if (typeof callId === 'string' && callId) calls.set(callId, event);
  }

  const receipts: CompletionReceipt[] = [];
  for (const event of canonical) {
    if (event.type !== 'tool_returned') continue;
    const returned = eventData(event);
    const callId = typeof returned.callId === 'string' ? returned.callId : '';
    if (!callId) continue;
    const called = calls.get(callId);
    const calledData = called ? eventData(called) : {};
    const toolValue = returned.tool ?? calledData.tool;
    const tool = typeof toolValue === 'string' ? toolValue.trim() : '';
    if (!tool) continue;
    const action = actionName(tool, calledData, returned);
    if (isBookkeepingTool(tool, action)) continue;

    let rawOutput = '';
    try {
      if (resolveOutput) {
        const resolution = resolveOutput(execution.sessionId, callId);
        if (resolution.status === 'ambiguous') continue;
        rawOutput = resolution.status === 'ok' ? resolution.record.output : '';
      } else {
        rawOutput = getOutput(execution.sessionId, callId)?.output ?? '';
      }
    } catch {
      // The durable full-output side store is best effort; event previews are
      // sufficient fallback evidence when it is unavailable.
    }
    if (!rawOutput) {
      const fallback = returned.preview ?? returned.output ?? returned.result ?? returned.summary;
      rawOutput = typeof fallback === 'string' ? fallback : safeJson(fallback);
    }
    if (!rawOutput || !toolOutputLooksSuccessful(rawOutput, returned.ok)) continue;

    const output = normalizedOutput(rawOutput);
    const argsValue = calledData.arguments ?? calledData.args ?? calledData.input;
    const args = argsValue == null ? '' : clipMiddle(safeJson(argsValue), MAX_ARGUMENT_CHARS);
    const effectValue = returned.effect ?? calledData.effect;
    const effect = typeof effectValue === 'string' && effectValue.trim()
      ? effectValue.trim()
      : 'unknown';
    receipts.push({
      seq: event.seq,
      callId,
      action,
      effect,
      args,
      output: clipMiddle(output, MAX_RECEIPT_CHARS),
      score: receiptScore(action, effect, output),
    });
  }
  if (receipts.length === 0) return '';

  const counts = new Map<string, number>();
  for (const receipt of receipts) {
    const key = `${receipt.action} [${receipt.effect}]`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const countText = clipMiddle(
    [...counts.entries()]
      .map(([name, count]) => `${name}=${count}`)
      .join('; '),
    MAX_COUNT_CHARS,
  );

  const selected = [...receipts]
    .sort((left, right) => right.score - left.score || right.seq - left.seq)
    .slice(0, MAX_RECEIPTS)
    .sort((left, right) => left.seq - right.seq);
  const lines = selected.map((receipt) => [
    `- ${receipt.action} [${receipt.effect}] call=${receipt.callId}`,
    receipt.args ? `  request: ${receipt.args}` : '',
    `  receipt: ${receipt.output}`,
  ].filter(Boolean).join('\n'));
  const omitted = receipts.length - selected.length;
  return clipMiddle([
    `Successful relevant receipt counts (${receipts.length} total): ${countText}`,
    ...lines,
    omitted > 0 ? `- ${omitted} additional successful receipt(s) omitted by the evidence cap.` : '',
  ].filter(Boolean).join('\n'), MAX_TOTAL_CHARS);
}
