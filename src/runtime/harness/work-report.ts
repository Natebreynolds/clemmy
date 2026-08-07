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

export interface ResolvedWriteEvidence {
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
  // A new reservation must settle the exact call it reserved. Falling back to
  // shape/targets can let a terminal event from another invocation settle it.
  if (attempt.data.preDispatch === true) {
    return Boolean(attemptCallId && resolutionCallId && attemptCallId === resolutionCallId);
  }
  // Legacy rows predate reliable correlation ids. Preserve their historical
  // shape/target reconciliation when one side lacks an id.
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
 * New `preDispatch` external-write rows are reservations, not completion
 * evidence. They become confirmed only when the exact same call records
 * `external_write_succeeded`; failure proves no dispatch, while an orphan
 * remains uncertain. Legacy rows without `preDispatch` keep their historical
 * success meaning. Process in sequence order so one invocation cannot settle
 * another retry of the same action.
 */
export function resolveWriteEvidence(events: readonly EventRow[]): ResolvedWriteEvidence {
  const attempts: Array<{
    event: EventRow;
    state: 'pending' | 'confirmed' | 'failed' | 'uncertain';
  }> = [];
  const unmatchedOrphans: EventRow[] = [];
  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    if (event.type === 'external_write') {
      attempts.push({
        event,
        state: event.data.preDispatch === true ? 'pending' : 'confirmed',
      });
      continue;
    }
    if (
      event.type !== 'external_write_succeeded'
      && event.type !== 'external_write_failed'
      && event.type !== 'external_write_orphaned'
    ) continue;
    let match = -1;
    for (let index = attempts.length - 1; index >= 0; index -= 1) {
      if (attempts[index]?.state === 'failed') continue;
      if (sameWriteAttempt(attempts[index]!.event, event)) {
        match = index;
        break;
      }
    }
    if (match >= 0) {
      attempts[match]!.state = event.type === 'external_write_succeeded'
        ? 'confirmed'
        : event.type === 'external_write_failed'
          ? 'failed'
          : 'uncertain';
    } else if (event.type === 'external_write_orphaned') {
      // A few legacy transports emitted only the timeout row. Preserve that
      // uncertainty instead of dropping the only durable evidence.
      unmatchedOrphans.push(event);
    }
  }
  return {
    confirmed: attempts.filter((attempt) => attempt.state === 'confirmed').map((attempt) => attempt.event),
    uncertain: [
      ...attempts
        .filter((attempt) => attempt.state === 'pending' || attempt.state === 'uncertain')
        .map((attempt) => attempt.event),
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
 * Provider JOBS this window started — actor runs, crawls, exports. They are
 * billable the moment they start, whatever their settlement says, so a run has
 * to be able to tell the user it launched them.
 *
 * Live 2026-08-07: a 50-firm scrape started four Apify runs; the user only
 * discovered the spend by opening the provider's own dashboard, because
 * nothing in the run ever mentioned a paid job existed.
 */
export interface ProviderJobSummary {
  started: number;
  /** Started but never settled with a confirmed result — the ones whose paid
   *  output may still be unfetched. */
  unresolved: number;
  families: string[];
}

const JOB_START_VERB_RE =
  /(?:^|_)(?:RUN|RUNS|ACTOR|ACTORS|TASK|TASKS|START|TRIGGER|LAUNCH|CRAWL|SCRAPE|EXPORT|IMPORT|JOB)(?:_|$)/;

function jobSlugOf(event: EventRow): string {
  return eventText(event.data as Record<string, unknown>, 'shapeKey', 'slug', 'toolName', 'tool').toUpperCase();
}

export function summarizeProviderJobs(evidence: readonly EventRow[]): ProviderJobSummary | null {
  const started = new Map<string, EventRow>();
  const settledOk = new Set<string>();
  for (const event of evidence) {
    const slug = jobSlugOf(event);
    if (!slug || !JOB_START_VERB_RE.test(slug)) continue;
    const callId = writeCallId(event);
    if (event.type === 'external_write') {
      started.set(callId || `${slug}:${event.seq}`, event);
    } else if (event.type === 'external_write_succeeded' && callId) {
      settledOk.add(callId);
    }
  }
  if (started.size === 0) return null;
  const families = [...new Set(
    [...started.values()].map((event) => (jobSlugOf(event).split('_')[0] ?? '').toLowerCase()).filter(Boolean),
  )].sort();
  const unresolved = [...started.keys()].filter((key) => !settledOk.has(key)).length;
  return { started: started.size, unresolved, families };
}

function providerJobLine(evidence: readonly EventRow[]): string | null {
  const jobs = summarizeProviderJobs(evidence);
  if (!jobs) return null;
  const where = jobs.families.length ? ` on ${jobs.families.join(', ')}` : '';
  const plural = jobs.started === 1 ? 'job' : 'jobs';
  const tail = jobs.unresolved > 0
    ? ` — ${jobs.unresolved} of them ${jobs.unresolved === 1 ? 'has' : 'have'} no confirmed result yet, so check the provider before starting more.`
    : '.';
  return `• Started ${jobs.started} provider ${plural}${where}${tail} These are billable whether or not I fetched their output`;
}

/**
 * Build a report from the COMPLETE external-write evidence window for one
 * turn/run: `external_write`, `external_write_succeeded`,
 * `external_write_failed`, and `external_write_orphaned`. A pre-dispatch row
 * without its exact success is reported as uncertain, never completed.
 * Returns null when there is nothing durable to report.
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
  const jobLine = providerJobLine(evidence);
  if (lines.length === 0 && uncertainLines.length === 0 && !jobLine) return null;
  if (uncertainLines.length === 0) {
    return [
      `I finished — here's what I did this turn:`,
      ...lines,
      ...(jobLine ? [jobLine] : []),
    ].join('\n');
  }
  if (lines.length === 0) {
    return [
      'I could not confirm whether this external action completed. Verify the destination before retrying:',
      ...uncertainLines,
      ...(jobLine ? [jobLine] : []),
    ].join('\n');
  }
  return [
    'The action ledger confirmed some work, but at least one external action is still uncertain:',
    ...lines,
    ...uncertainLines,
    ...(jobLine ? [jobLine] : []),
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
      || event.type === 'external_write_succeeded'
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
