/**
 * The host's retained-work checkpoint, as text. It rides at the end of an
 * incomplete terminal so a later turn can reuse the exact results it names
 * (recall_tool_result redeems the rh_ handles) instead of fetching them again.
 * Leaf module: the public projection reads it without the evidence store.
 */
export const RETAINED_WORK_TERMINAL_HEADER = 'Retained work (durable checkpoint):';

/**
 * The part of a terminal a person reads while Clem waits on them: the words
 * before the retained-work checkpoint. Someone answering a question or an
 * approval has no use for record counts and handle ids; the durable terminal
 * keeps them for the model.
 */
export function withoutRetainedWorkCheckpoint(text: string): string {
  const index = text.indexOf(RETAINED_WORK_TERMINAL_HEADER);
  if (index < 0) return text;
  const kept = text.slice(0, index).trimEnd();
  return kept || text;
}

/**
 * The same checkpoint as a person reads it on a turn that did NOT end well
 * (blocked, failed, uncertain): what was kept and whether anything outside
 * this machine changed, in plain words. Record handles and tool names stay
 * in the durable terminal for the model; they mean nothing to the owner.
 */
export function ownerFacingRetainedWorkCheckpoint(text: string): string {
  const index = text.indexOf(RETAINED_WORK_TERMINAL_HEADER);
  if (index < 0) return text;
  const head = text.slice(0, index).trimEnd();
  const lines = text.slice(index + RETAINED_WORK_TERMINAL_HEADER.length).split('\n').map((line) => line.trim()).filter(Boolean);
  let kept = 0;
  type WriteState = 'succeeded' | 'failed' | 'mixed' | 'uncertain' | 'refused' | 'not_recorded';
  let writeState: WriteState | null = null;
  for (const line of lines) {
    if (line.startsWith('- ')) {
      const more = /^- (\d+) additional retained result/.exec(line);
      kept += more ? Number(more[1]) : 1;
      continue;
    }
    const state = /^External write state(?: \([^)]*\))?: (succeeded|failed|mixed|uncertain|refused|no settled)/.exec(line);
    if (state) writeState = (state[1] === 'no settled' ? 'not_recorded' : state[1]) as WriteState;
  }
  const sentences: string[] = [];
  if (kept > 0) sentences.push(`I kept ${kept === 1 ? 'the result' : `${kept} results`} from this turn, so a retry won't fetch ${kept === 1 ? 'it' : 'them'} again.`);
  switch (writeState) {
    case 'succeeded': sentences.push('The change outside this machine went through; I won\'t repeat it.'); break;
    case 'failed': sentences.push('The change outside this machine did not go through.'); break;
    case 'mixed': sentences.push('Some changes outside this machine went through and at least one did not; I won\'t repeat the ones that did.'); break;
    case 'uncertain': sentences.push('I can\'t yet confirm whether the change outside this machine went through; I\'ll check before trying again.'); break;
    case 'refused': sentences.push('The app turned the change down; I won\'t try it again without asking you.'); break;
    case 'not_recorded': sentences.push('Nothing outside this machine was changed.'); break;
    default: break;
  }
  // A checkpoint this reader does not recognise (free-form notes) stays as is.
  if (sentences.length === 0) return text;
  return `${head}\n\n${sentences.join(' ')}`.trim();
}
