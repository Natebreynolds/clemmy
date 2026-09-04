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
import {
  actionTargetsUnsentDraft,
  actionTokens,
  classifyComposioActionConsequence,
} from '../../integrations/composio/slug-effect.js';

export interface ResolvedWriteEvidence {
  confirmed: EventRow[];
  /** Reservations whose exact call recorded a proved not-applied terminal.
   * Kept separate from `uncertain` so settlement/finalization can distinguish
   * a reconciled absence from an effect whose provider outcome is still
   * unknown. */
  failed: EventRow[];
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

function sameWriteAttempt(
  attempt: EventRow,
  resolution: EventRow,
  options: { allowUnparentedPreDispatch: boolean },
): boolean {
  const attemptCallId = writeCallId(attempt);
  const resolutionCallId = writeCallId(resolution);
  // A new reservation must settle the exact call it reserved. Falling back to
  // shape/targets can let a terminal event from another invocation settle it.
  // Reused SDK call ids exist in historical data, so a parented terminal must
  // also name the exact reservation event. An unparented compatibility receipt
  // is accepted only while exactly one reservation owns that call id.
  if (attempt.data.preDispatch === true) {
    if (!attemptCallId || !resolutionCallId || attemptCallId !== resolutionCallId) return false;
    return resolution.parentEventId
      ? resolution.parentEventId === attempt.id
      : options.allowUnparentedPreDispatch;
  }
  if (resolution.parentEventId && resolution.parentEventId !== attempt.id) return false;
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
    state: 'pending' | 'confirmed' | 'failed' | 'uncertain' | 'conflicted';
    decisive: boolean;
  }> = [];
  const unmatchedOrphans: EventRow[] = [];
  for (const event of [...events].sort((left, right) => left.seq - right.seq)) {
    if (event.type === 'external_write') {
      attempts.push({
        event,
        state: event.data.preDispatch === true ? 'pending' : 'confirmed',
        // A legacy reservation without preDispatch historically carried
        // provisional success meaning. A later explicit terminal may still
        // correct it; only a terminal makes the state decisive.
        decisive: false,
      });
      continue;
    }
    if (
      event.type !== 'external_write_succeeded'
      && event.type !== 'external_write_failed'
      && event.type !== 'external_write_orphaned'
    ) continue;
    const resolutionCallId = writeCallId(event);
    const matchingPreDispatchReservations = resolutionCallId
      ? attempts.filter((attempt) => (
          attempt.event.data.preDispatch === true
          && writeCallId(attempt.event) === resolutionCallId
        )).length
      : 0;
    let match = -1;
    for (let index = attempts.length - 1; index >= 0; index -= 1) {
      if (sameWriteAttempt(attempts[index]!.event, event, {
        allowUnparentedPreDispatch: !event.parentEventId && matchingPreDispatchReservations === 1,
      })) {
        match = index;
        break;
      }
    }
    if (match >= 0) {
      const attempt = attempts[match]!;
      if (event.type === 'external_write_orphaned') {
        // Orphan records an ambiguity observation. Once the exact reservation
        // has a decisive success/failure, an older or racing orphan can never
        // downgrade that truth.
        if (!attempt.decisive) {
          attempt.state = 'uncertain';
        }
      } else if (event.type === 'external_write_succeeded') {
        if ((attempt.state === 'failed' && attempt.decisive) || attempt.state === 'conflicted') {
          attempt.state = 'conflicted';
        } else {
          attempt.state = 'confirmed';
          attempt.decisive = true;
        }
      } else if ((attempt.state === 'confirmed' && attempt.decisive) || attempt.state === 'conflicted') {
        attempt.state = 'conflicted';
      } else {
        attempt.state = 'failed';
        attempt.decisive = true;
      }
    } else if (event.type === 'external_write_orphaned') {
      // A few legacy transports emitted only the timeout row. Preserve that
      // uncertainty instead of dropping the only durable evidence.
      unmatchedOrphans.push(event);
    }
  }
  return {
    confirmed: attempts.filter((attempt) => attempt.state === 'confirmed').map((attempt) => attempt.event),
    failed: attempts.filter((attempt) => attempt.state === 'failed').map((attempt) => attempt.event),
    uncertain: [
      ...attempts
        .filter((attempt) => (
          attempt.state === 'pending'
          || attempt.state === 'uncertain'
          || attempt.state === 'conflicted'
        ))
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

/**
 * Humanize ONE recorded external write into a report line.
 *
 * The phrase derives from the action's CONSEQUENCE class (the same verb
 * evidence the effect classifier uses) plus the write's own recorded
 * `irreversible` bit — never from an ordered slug-regex chain. The chain shipped
 * two live lies in one weekend: OUTLOOK_UPDATE_EMAIL fell through /EMAIL/ to
 * "Sent a message" on a draft-only task, and SLACK_DELETE_MESSAGE matched
 * /MESSAGE/ before /DELETE/. Invariant enforced here, not by pattern order:
 * a write recorded as reversible (`irreversible === false`) may NEVER render
 * as delivery ("Sent…", "Published…") — reversible actions did not deliver
 * anything. Legacy rows without the bit keep their historical reading.
 */
export function describeExternalWrite(
  shapeKey: string | undefined,
  toolName: string,
  targets: string[],
  write?: { irreversible?: boolean; actionKey?: string },
): string {
  const key = shapeKey || write?.actionKey || toolName || 'action';
  const to = targets.length
    ? ` to ${targets.slice(0, 5).join(', ')}${targets.length > 5 ? ` (+${targets.length - 5} more)` : ''}`
    : '';
  const tokens = actionTokens(key);
  const deliveryAllowed = write?.irreversible !== false;
  const fileShaped = tokens.includes('UPLOAD') || tokens.includes('SAVE') || tokens.includes('WRITE') || tokens.includes('FILE');
  const fallback = `Ran ${key.toLowerCase().replace(/[_:]/g, ' ')}${to}`;

  if (actionTargetsUnsentDraft(key)) {
    return classifyComposioActionConsequence(key) === 'update'
      ? `Updated a draft${to}`
      : `Created a draft${to}`;
  }
  switch (classifyComposioActionConsequence(key)) {
    case 'delete':
      return `Deleted a record${to}`;
    case 'send': {
      if (!deliveryAllowed) return fallback;
      const postShaped = tokens.includes('PUBLISH') || tokens.includes('POST') || tokens.includes('TWEET');
      return postShaped ? `Published a post${to}` : `Sent a message${to}`;
    }
    case 'update':
      return fileShaped ? `Saved a file${to}` : `Updated a record${to}`;
    case 'create':
      return fileShaped ? `Saved a file${to}` : `Created a record${to}`;
    case 'read':
      return fallback;
    default:
      return fileShaped ? `Saved a file${to}` : fallback;
  }
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
    const d = (w.data ?? {}) as {
      shapeKey?: string; toolName?: string; targets?: unknown;
      irreversible?: unknown; actionKey?: unknown;
    };
    const targets = Array.isArray(d.targets) ? d.targets.filter((t): t is string => typeof t === 'string') : [];
    const line = `• ${describeExternalWrite(d.shapeKey, d.toolName ?? '', targets, {
      irreversible: typeof d.irreversible === 'boolean' ? d.irreversible : undefined,
      actionKey: typeof d.actionKey === 'string' ? d.actionKey : undefined,
    })}`;
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
