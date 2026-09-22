/**
 * When a write step ends with nothing written, the reason must be the true
 * one. Live 2026-09-22: the worker called write_file three times with the
 * right arguments; the host refused each call before dispatch
 * (coverage_missing); the run's diagnosis said the step "completed without
 * calling any tool". The step session's own refusal events say what
 * happened; this reads them.
 */
import { listEvents } from '../runtime/harness/eventlog.js';

export interface PreDispatchRefusalSummary {
  count: number;
  tools: string[];
  details: string[];
}

export function summarizePreDispatchRefusals(
  events: ReadonlyArray<{ type: string; data: unknown }>,
  sourceUserSeq?: number,
): PreDispatchRefusalSummary {
  let count = 0;
  const tools = new Set<string>();
  const details = new Set<string>();
  for (const event of events) {
    if (event.type !== 'guardrail_tripped') continue;
    const data = event.data as { kind?: unknown; sourceUserSeq?: unknown; refusalDetail?: unknown; calls?: unknown; recoveryToolNames?: unknown } | null;
    if (!data || data.kind !== 'refused_pre_dispatch') continue;
    if (sourceUserSeq !== undefined && data.sourceUserSeq !== sourceUserSeq) continue;
    const calls = Array.isArray(data.calls) ? data.calls : [];
    count += Math.max(1, calls.length);
    for (const call of calls) {
      const name = (call as { name?: unknown })?.name;
      if (typeof name === 'string' && name) tools.add(name);
    }
    if (Array.isArray(data.recoveryToolNames)) {
      for (const name of data.recoveryToolNames) if (typeof name === 'string' && name) tools.add(name);
    }
    if (typeof data.refusalDetail === 'string' && data.refusalDetail) details.add(data.refusalDetail);
  }
  return { count, tools: [...tools], details: [...details] };
}

export function readPreDispatchRefusals(sessionId: string, sourceUserSeq?: number): PreDispatchRefusalSummary {
  try {
    return summarizePreDispatchRefusals(listEvents(sessionId), sourceUserSeq);
  } catch {
    return { count: 0, tools: [], details: [] };
  }
}

/** The honest blocked reason for a write/send step that ended with no effect. */
export function noEffectStepReason(input: {
  stepId: string;
  effectClass: 'send' | 'write';
  refusals: PreDispatchRefusalSummary;
}): string {
  const verb = input.effectClass === 'send' ? 'send' : 'write';
  if (input.refusals.count > 0) {
    const tools = input.refusals.tools.length > 0 ? input.refusals.tools.join(', ') : `its ${verb} tool`;
    const why = input.refusals.details.length > 0 ? ` (${input.refusals.details.join(', ')})` : '';
    return `Step "${input.stepId}" is a ${input.effectClass} step: it called ${tools} ${input.refusals.count} time${input.refusals.count === 1 ? '' : 's'} and the host refused every call before dispatch${why}, so the ${verb} was not performed. The step's arguments were not the problem; the refusal was.`;
  }
  return `Step "${input.stepId}" is a ${input.effectClass} step but completed without calling any tool — the ${verb} was not actually performed (it returned output instead of acting). Re-run the step or fix it to call its tool.`;
}
