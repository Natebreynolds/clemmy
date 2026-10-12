/**
 * The host's retained-work checkpoint, as text. It rides at the end of an
 * incomplete terminal so a later turn can reuse the exact results it names
 * (recall_tool_result redeems the rh_ handles) instead of fetching them again.
 * Leaf module: the public projection reads it without the evidence store.
 */
export const RETAINED_WORK_TERMINAL_HEADER = 'Retained work (durable checkpoint):';

/** Whether anything outside this machine changed, as the checkpoint records it.
 * `none` covers both "no settled external write is recorded" and a checkpoint
 * with no write-state line at all: neither is a fact worth showing. */
export type RetainedOutsideChange = 'went_through' | 'did_not' | 'mixed' | 'refused' | 'uncertain' | 'none';

export interface RetainedWorkCheckpoint {
  /** Everything before the checkpoint, exactly as authored (trailing space
   * trimmed). The text itself when there is no checkpoint. May be empty. */
  head: string;
  /** Redeemable results the checkpoint names. Unknown bullets count for nothing. */
  results: number;
  outsideChange: RetainedOutsideChange;
}

const WRITE_STATE_TO_OUTSIDE_CHANGE: Readonly<Record<string, RetainedOutsideChange>> = {
  succeeded: 'went_through',
  failed: 'did_not',
  mixed: 'mixed',
  uncertain: 'uncertain',
  refused: 'refused',
  'no settled': 'none',
};

/**
 * Split a terminal into the words a person reads and the checkpoint's facts.
 * The words are never extended: no sentence is written here, so what a person
 * reads before the checkpoint is exactly what was authored. Record handles and
 * tool names stay in the durable terminal for the model; the counts travel as
 * data so a client can show them as chrome.
 */
export function parseRetainedWorkCheckpoint(text: string): RetainedWorkCheckpoint {
  const index = text.indexOf(RETAINED_WORK_TERMINAL_HEADER);
  if (index < 0) return { head: text, results: 0, outsideChange: 'none' };
  const head = text.slice(0, index).trimEnd();
  const lines = text.slice(index + RETAINED_WORK_TERMINAL_HEADER.length).split('\n').map((line) => line.trim()).filter(Boolean);
  let results = 0;
  let outsideChange: RetainedOutsideChange = 'none';
  for (const line of lines) {
    if (line.startsWith('- ')) {
      const more = /^- (\d+) additional retained results?\.$/.exec(line);
      const count = more ? Number(more[1]) : 0;
      if (Number.isSafeInteger(count) && count > 0) results += count;
      else if (/^- Source\/tool [^\n]+: [^\n]+ retained as rh_[A-Za-z0-9_]+\.$/.test(line)) results += 1;
      continue;
    }
    const state = /^External write state(?: \([^)]*\))?: (succeeded|failed|mixed|uncertain|refused|no settled)/.exec(line);
    if (state) outsideChange = WRITE_STATE_TO_OUTSIDE_CHANGE[state[1]!] ?? 'none';
  }
  return { head, results: Number.isSafeInteger(results) ? results : 0, outsideChange };
}

/**
 * The part of a terminal a person reads: the words before the retained-work
 * checkpoint, and nothing else. Empty when the terminal is only a checkpoint;
 * callers that need a line in that case use the typed control state.
 */
export function withoutRetainedWorkCheckpoint(text: string): string {
  return parseRetainedWorkCheckpoint(text).head;
}
