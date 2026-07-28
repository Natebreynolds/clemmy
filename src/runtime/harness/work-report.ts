/**
 * ALWAYS REPORT BACK (northstar). When a turn does real work but the model emits no
 * reply text, the user must still learn what happened — never a silent
 * "(Finished without a written reply.)". This synthesizes an honest, human report
 * from the durable `external_write` events the turn recorded.
 *
 * Effect-anchored + GENERAL: the description keys off the write's shapeKey/slug
 * (SEND / CREATE / UPDATE / …), never a specific tool name, so it covers email, chat,
 * SMS, CRM, files — anything. A pure ack (no writes) reports nothing (returns null),
 * so we don't fabricate a report where there is genuinely nothing to say.
 */
import { listEvents, type EventRow } from './eventlog.js';
import {
  isControlOnlyTool,
  isToolSurfaceProbeTool,
  toolOutputLooksSuccessful,
} from './tool-evidence.js';
import { projectCanonicalTopLevelToolEvents } from './tool-effect.js';

interface ResolvedWriteEvidence {
  confirmed: EventRow[];
  uncertain: EventRow[];
}

function eventText(data: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    const value = data[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function writeCallId(event: EventRow): string {
  return eventText(event.data, 'canonicalCallId', 'callId');
}

function writeShape(event: EventRow): string {
  return eventText(event.data, 'shapeKey', 'slug', 'toolName', 'tool').toLowerCase();
}

function writeTargets(event: EventRow): string[] {
  const value = event.data.targets;
  if (!Array.isArray(value)) return [];
  return value
    .filter((target): target is string => typeof target === 'string' && target.trim().length > 0)
    .map((target) => target.trim().toLowerCase())
    .sort();
}

function sameWriteAttempt(attempt: EventRow, resolution: EventRow): boolean {
  const attemptCallId = writeCallId(attempt);
  const resolutionCallId = writeCallId(resolution);
  if (attemptCallId && resolutionCallId) return attemptCallId === resolutionCallId;

  const attemptShape = writeShape(attempt);
  const resolutionShape = writeShape(resolution);
  if (!attemptShape || !resolutionShape || attemptShape !== resolutionShape) return false;
  const attemptTargets = writeTargets(attempt);
  const resolutionTargets = writeTargets(resolution);
  if (attemptTargets.length === 0 || resolutionTargets.length === 0) return true;
  return attemptTargets.length === resolutionTargets.length
    && attemptTargets.every((target, index) => target === resolutionTargets[index]);
}

/**
 * External-write rows are conservative pre-dispatch claims. A later failure
 * removes exactly one matching claim; an orphan changes it to "uncertain."
 * Process in sequence order so a failed first attempt cannot erase a later
 * successful retry of the same action.
 */
function resolveWriteEvidence(events: readonly EventRow[]): ResolvedWriteEvidence {
  const attempts: Array<{ event: EventRow; state: 'confirmed' | 'failed' | 'uncertain' }> = [];
  const unmatchedOrphans: EventRow[] = [];
  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    if (event.type === 'external_write') {
      attempts.push({ event, state: 'confirmed' });
      continue;
    }
    if (event.type !== 'external_write_failed' && event.type !== 'external_write_orphaned') continue;
    let match = -1;
    for (let index = attempts.length - 1; index >= 0; index -= 1) {
      if (attempts[index]?.state !== 'confirmed') continue;
      if (sameWriteAttempt(attempts[index]!.event, event)) {
        match = index;
        break;
      }
    }
    if (match >= 0) {
      attempts[match]!.state = event.type === 'external_write_failed' ? 'failed' : 'uncertain';
    } else if (event.type === 'external_write_orphaned') {
      // A few legacy transports emitted only the timeout row. Preserve that
      // uncertainty instead of dropping the only durable evidence.
      unmatchedOrphans.push(event);
    }
  }
  return {
    confirmed: attempts.filter((attempt) => attempt.state === 'confirmed').map((attempt) => attempt.event),
    uncertain: [
      ...attempts.filter((attempt) => attempt.state === 'uncertain').map((attempt) => attempt.event),
      ...unmatchedOrphans,
    ],
  };
}

function describeUncertainWrite(event: EventRow): string {
  const data = event.data as { shapeKey?: string; slug?: string; toolName?: string; tool?: string; targets?: unknown };
  const shape = data.shapeKey ?? data.slug ?? data.toolName ?? data.tool ?? 'external action';
  const targets = Array.isArray(data.targets)
    ? data.targets.filter((target): target is string => typeof target === 'string' && target.trim().length > 0)
    : [];
  const to = targets.length
    ? ` to ${targets.slice(0, 5).join(', ')}${targets.length > 5 ? ` (+${targets.length - 5} more)` : ''}`
    : '';
  return `Could not confirm whether ${shape.toLowerCase().replace(/_/g, ' ')}${to} completed`;
}

/** Humanize ONE recorded external write into a report line. */
export function describeExternalWrite(shapeKey: string | undefined, toolName: string, targets: string[]): string {
  const key = (shapeKey || toolName || 'action').toUpperCase();
  const to = targets.length
    ? ` to ${targets.slice(0, 5).join(', ')}${targets.length > 5 ? ` (+${targets.length - 5} more)` : ''}`
    : '';
  if (/DRAFT/.test(key) && !/SEND|PUBLISH/.test(key)) return `Created a draft${to}`;
  if (/SEND|EMAIL|DELIVER|DISPATCH|DM\b|MESSAGE|SMS|TEXT/.test(key)) return `Sent a message${to}`;
  if (/PUBLISH|POST|TWEET/.test(key)) return `Published a post${to}`;
  if (/CREATE|ADD|INSERT|UPSERT/.test(key)) return `Created a record${to}`;
  if (/UPDATE|PATCH|EDIT|MODIFY|SET_/.test(key)) return `Updated a record${to}`;
  if (/DELETE|REMOVE|ARCHIVE|TRASH/.test(key)) return `Deleted a record${to}`;
  if (/UPLOAD|SAVE|WRITE/.test(key)) return `Saved a file${to}`;
  return `Ran ${key.toLowerCase().replace(/_/g, ' ')}${to}`;
}

/**
 * Build a report from the COMPLETE external-write evidence window for one
 * turn/run: `external_write`, `external_write_failed`, and
 * `external_write_orphaned`. Passing only provisional `external_write` rows
 * cannot net later failures/timeouts and is safe only when the caller already
 * performed that resolution. Returns null when there is nothing durable to
 * report.
 */
export function synthesizeWorkReport(evidence: readonly EventRow[]): string | null {
  if (!evidence || evidence.length === 0) return null;
  const { confirmed: writes, uncertain } = resolveWriteEvidence(evidence);
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const w of writes) {
    const d = (w.data ?? {}) as { shapeKey?: string; toolName?: string; targets?: unknown };
    const targets = Array.isArray(d.targets) ? d.targets.filter((t): t is string => typeof t === 'string') : [];
    const line = `• ${describeExternalWrite(d.shapeKey, d.toolName ?? '', targets)}`;
    if (seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
  }
  const uncertainLines: string[] = [];
  for (const event of uncertain) {
    const line = `• ${describeUncertainWrite(event)}`;
    if (seen.has(line)) continue;
    seen.add(line);
    uncertainLines.push(line);
  }
  if (lines.length === 0 && uncertainLines.length === 0) return null;
  if (uncertainLines.length === 0) {
    return `I finished — here's what I did this turn:\n${lines.join('\n')}`;
  }
  if (lines.length === 0) {
    return [
      'I could not confirm whether this external action completed. Verify the destination before retrying:',
      ...uncertainLines,
    ].join('\n');
  }
  return [
    'The action ledger confirmed some work, but at least one external action is still uncertain:',
    ...lines,
    ...uncertainLines,
    'Verify the uncertain destination before retrying it.',
  ].join('\n');
}

/**
 * The best available report for a turn that produced NO reply text, from the
 * durable event log. Order: (1) resolved write evidence; (2) else meaningful,
 * matched successful tool returns; (3) else null. A started or failed call can
 * never become a completion claim. `afterSeq` scopes evidence to the current
 * request (events with seq > afterSeq).
 */
export function synthesizeTurnReport(sessionId: string, afterSeq?: number): string | null {
  let events: readonly EventRow[];
  try {
    events = listEvents(sessionId);
  } catch {
    return null;
  }
  const inScope = (e: EventRow): boolean => afterSeq == null || e.seq > afterSeq;

  const writeReport = synthesizeWorkReport(events.filter((event) =>
    inScope(event)
    && (
      event.type === 'external_write'
      || event.type === 'external_write_failed'
      || event.type === 'external_write_orphaned'
    )));
  if (writeReport) return writeReport;

  const toolEvents = projectCanonicalTopLevelToolEvents(
    events.filter((event) =>
      inScope(event) && (event.type === 'tool_called' || event.type === 'tool_returned')),
  );
  const calls = new Map<string, EventRow>();
  for (const event of toolEvents) {
    if (event.type !== 'tool_called') continue;
    const callId = eventText(event.data, 'canonicalCallId', 'callId');
    if (callId) calls.set(callId, event);
  }

  const toolCounts = new Map<string, number>();
  const countedCallIds = new Set<string>();
  for (const event of toolEvents) {
    if (event.type !== 'tool_returned') continue;
    const callId = eventText(event.data, 'canonicalCallId', 'callId');
    if (!callId || countedCallIds.has(callId)) continue;
    const called = calls.get(callId);
    if (!called) continue;
    const explicitFailure =
      event.data.ok === false
      || event.data.isError === true
      || event.data.error === true
      || (typeof event.data.error === 'string' && event.data.error.trim().length > 0)
      || (
        event.data.error !== null
        && typeof event.data.error === 'object'
        && Object.keys(event.data.error).length > 0
      );
    const result = event.data.preview
      ?? event.data.output
      ?? event.data.result
      ?? event.data.summary
      ?? '';
    if (explicitFailure || !toolOutputLooksSuccessful(result, event.data.ok)) continue;
    const rawName = event.data.tool ?? called.data.tool;
    if (typeof rawName !== 'string' || rawName.trim().length === 0) continue;
    const name = rawName.trim();
    if (isToolSurfaceProbeTool(name) || isControlOnlyTool(name)) continue;
    countedCallIds.add(callId);
    toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
  }
  if (toolCounts.size === 0) return null;

  // This is deliberately an evidence digest, not a task-completion claim.
  // A matched successful return proves the named call completed; it does not
  // prove the whole objective finished or that its results were saved.
  const digest = [...toolCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([name, n]) => `${name.replace(/_/g, ' ')}${n > 1 ? ` ×${n}` : ''}`)
    .join(', ');
  const total = [...toolCounts.values()].reduce((a, b) => a + b, 0);
  return `Verified activity this turn (${total} successful call${total === 1 ? '' : 's'}): ${digest}. `
    + 'A reliable written summary of the results was not available.';
}
