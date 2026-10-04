/**
 * The sections of the prompt a delegated job is handed. Dependency-free, so
 * the code that writes the prompt and the code that reads it agree on one
 * shape.
 *
 * The success criteria and the context to load are the host's checklist for
 * the job, written as bullet lines. They are never the job's work items: a
 * reader that counts list lines must count only the objective and plan.
 */
export const DELEGATED_JOB_OBJECTIVE_PREFIX = 'Objective: ';
export const DELEGATED_JOB_CRITERIA_HEADING = 'Success criteria (the run is done only when ALL hold):';
export const DELEGATED_JOB_CONTEXT_HEADING = 'Load this context FIRST, before producing any artifact:';
/** A job never ends without a clear direction for the owner. */
export const DELEGATED_JOB_DIRECTION =
  'If something stops you finishing every part, finish the rest, then ask the owner the one decision that lets you finish (offer the choices) instead of ending the job.';

/** What the job is asked to do: its objective and plan, without the host's
 *  checklist sections. Null for text that is not a delegated job prompt. */
export function delegatedJobWorkText(text: string): string | null {
  if (!text.startsWith(DELEGATED_JOB_OBJECTIVE_PREFIX)) return null;
  const cuts = [DELEGATED_JOB_CRITERIA_HEADING, DELEGATED_JOB_CONTEXT_HEADING]
    .map((heading) => text.indexOf(`\n${heading}`))
    .filter((index) => index >= 0);
  return cuts.length > 0 ? text.slice(0, Math.min(...cuts)).trimEnd() : text;
}
