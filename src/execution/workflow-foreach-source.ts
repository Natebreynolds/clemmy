/**
 * One reading of a step's `forEach` source, shared by every stage that reads
 * it: authoring validation, auto-repair, graph validation, dry-run simulation
 * and execution. A source the author may write is a source every stage
 * accepts, so a workflow that passes its test cannot fail its first run on a
 * different spelling of the same rule.
 *
 * Accepted spellings: `steps.<id>.output[.path]`, `{{steps.<id>.output[.path]}}`,
 * a bare step id, and `input.<key>` / `{{input.<key>}}` for a run input.
 */

const TEMPLATED_STEP = /^\{\{\s*steps\.([a-zA-Z0-9_-]+)\.output(?:\.[a-zA-Z0-9_.-]+)?\s*\}\}$/;
const DIRECT_STEP = /^steps\.([a-zA-Z0-9_-]+)\.output(?:\.[a-zA-Z0-9_.-]+)?$/;
const BARE_STEP = /^[a-zA-Z0-9_-]+$/;
const TEMPLATED_INPUT = /^\{\{\s*input\.([a-zA-Z0-9_-]+)\s*\}\}$/;
const DIRECT_INPUT = /^input\.([a-zA-Z0-9_-]+)$/;

/** The step whose output a `forEach` iterates, or null for an input or an
 * unreadable expression. */
export function forEachSourceStepId(expr: string | undefined): string | null {
  const raw = (expr ?? '').trim();
  if (!raw) return null;
  const templated = TEMPLATED_STEP.exec(raw);
  if (templated) return templated[1]!;
  const direct = DIRECT_STEP.exec(raw);
  if (direct) return direct[1]!;
  return BARE_STEP.test(raw) ? raw : null;
}

/** The run input a `forEach` iterates, or null when it iterates a step. */
export function forEachSourceInputKey(expr: string | undefined): string | null {
  const raw = (expr ?? '').trim();
  const templated = TEMPLATED_INPUT.exec(raw);
  if (templated) return templated[1]!;
  return DIRECT_INPUT.exec(raw)?.[1] ?? null;
}
