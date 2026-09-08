/**
 * What a finished run's row says.
 *
 * The row used to print `run.status.replace(/_/g, ' ')` — "completed with
 * errors", "awaiting input" — which is the engine's own vocabulary shown to a
 * person. It also threw away work the daemon had already done: /m/api/runs
 * rows arrive from the SAME enrichment the desktop reads
 * (src/runtime/activity-format.ts via collectRecentActivityRuns), carrying a
 * human `statusLabel` and a `preview` line — the run's own output preview, or
 * its error, or what it is doing right now.
 *
 * So this reads what is there and never invents what is not: a row with no
 * preview gets a state and nothing else, rather than a manufactured sentence
 * about work this list cannot see.
 */
import type { RunSummary } from './api';

/** Fallback vocabulary for a row that predates the enriched list contract. */
const STATE_WORDS: Record<string, string> = {
  received: 'Queued',
  queued: 'Queued',
  running: 'Working',
  awaiting_approval: 'Waiting for your approval',
  awaiting_input: 'Waiting for your input',
  completed: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export interface RunRowLabel {
  /** The run's state, in words. Never a raw status token. */
  state: string;
  /** What it did, produced, or is doing — '' when the list does not say. */
  detail: string;
}

function clean(value: string | null | undefined): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}

// `status` is widened to string on purpose: the same vocabulary serves the
// activity list, one run's detail, and a workflow run — three routes whose
// status sets overlap but are not identical, and none of which may print a
// raw token.
export function runStateLabel(run: { status: string; statusLabel?: string }): string {
  const server = clean(run.statusLabel);
  if (server) return server;
  const known = STATE_WORDS[run.status];
  if (known) return known;
  // An unknown status is the daemon's word, not ours to translate — but it is
  // never shown as a snake_case token either.
  const words = clean(run.status).replace(/[_-]+/g, ' ');
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Status unavailable';
}

/**
 * The two lines a run row shows. `detail` is dropped when it merely repeats the
 * state (the server's preview falls back to the state label when a run left no
 * output), so the row never says "Done · Done".
 */
export function runRowLabel(run: Pick<RunSummary, 'status' | 'statusLabel' | 'preview'>): RunRowLabel {
  const state = runStateLabel(run);
  const preview = clean(run.preview);
  return { state, detail: preview && preview.toLowerCase() !== state.toLowerCase() ? preview : '' };
}

/** The same treatment for a workflow run row, whose terminal outcome is its
 *  own short vocabulary rather than the activity list's status set. */
export function workflowRunStateLabel(run: { status: string; terminalOutcome?: string }): string {
  const outcomes: Record<string, string> = {
    succeeded: 'Done',
    partial: 'Done, with some items failed',
    blocked: 'Needs a look',
    failed: 'Failed',
    cancelled: 'Cancelled',
  };
  const outcome = run.terminalOutcome ? outcomes[run.terminalOutcome] : undefined;
  if (outcome) return outcome;
  return runStateLabel({ status: run.status });
}
