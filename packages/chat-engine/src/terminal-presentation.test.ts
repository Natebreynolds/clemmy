/**
 * The frontend mirrors the backend's TYPED terminal.
 *
 * The harness ends every turn with `presentation.{status,kind,text}` and
 * `turnOutcome.{status,needs,resumable}`. Both apps used to re-derive state from
 * the `reason` string with regexes — the desktop kept a stale regex-only copy of
 * this mapper — so needs_input / blocked / cancelled / continue collapsed into
 * "awaiting-reply" or "failed" and the model that ran was thrown away. The shared
 * mapper is now the only projection, and it carries the typed facts through.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { terminalCompletionPresentation, terminalFactsFrom } from './terminal-presentation.js';

const typed = (status: string, kind: string, needs?: string, resumable?: boolean) => ({
  reply: 'Here is the answer.',
  presentation: { version: 1, status, kind, text: 'Here is the answer.' },
  turnOutcome: { version: 2, status, ...(needs ? { needs: { kind: needs } } : {}), ...(resumable !== undefined ? { resumable } : {}) },
});

test('a typed terminal carries status, kind, needs and resumable onto the message', () => {
  const m = terminalCompletionPresentation(typed('needs_input', 'continue', 'continue', true), '');
  assert.equal(m.status, 'awaiting-reply', 'legacy MessageStatus still derived');
  assert.deepEqual(m.terminal, { status: 'needs_input', kind: 'continue', needs: 'continue', resumable: true });
});

test('a done answer is typed as done/answer and not resumable', () => {
  const m = terminalCompletionPresentation(typed('done', 'answer', undefined, false), '');
  assert.equal(m.status, 'complete');
  assert.deepEqual(m.terminal, { status: 'done', kind: 'answer', resumable: false });
});

test('blocked is preserved as blocked on the typed facts even though MessageStatus collapses it', () => {
  const m = terminalCompletionPresentation(typed('blocked', 'answer'), '');
  assert.equal(m.status, 'failed', 'the legacy union has no blocked — renderers must read terminal.status');
  assert.equal(m.terminal?.status, 'blocked');
});

test('a presentation/turnOutcome disagreement is uncertain, never green', () => {
  const m = terminalCompletionPresentation({
    reply: 'x', presentation: { status: 'done', kind: 'answer', text: 'x' }, turnOutcome: { status: 'blocked' },
  }, '');
  assert.equal(m.terminal?.status, 'uncertain');
  assert.notEqual(m.status, 'complete');
});

test('a legacy event with no typed terminal yields no facts and the old fallbacks', () => {
  assert.equal(terminalFactsFrom({ reason: 'model_exhausted' }), undefined);
  for (const data of [{}, { reason: 'model_exhausted' }, { reply: 'Done.' }, { reason: 'no_structured_output' }]) {
    const m = terminalCompletionPresentation(data, '');
    assert.equal(m.status, 'failed', JSON.stringify(data));
    assert.equal(m.terminal, undefined);
  }
});

test('unknown kinds and needs are dropped, never invented', () => {
  const facts = terminalFactsFrom({
    presentation: { status: 'done', kind: 'celebration' },
    turnOutcome: { status: 'done', needs: { kind: 'hug' }, resumable: 'yes' },
  });
  assert.deepEqual(facts, { status: 'done' });
});

// Live 2026-09-25: an approval turn showed the host's filler as prose
// ("Approval required for Slack open dm. Review apr-k42z to continue.") under
// which its own card also appeared, and, typed as awaiting a reply, invited the
// owner to type "approve apr-k42z".
test('the host approval filler is not repeated as prose under its card; words the model wrote are kept', () => {
  const approvalTerminal = (text: string, approvalId = 'apr-k42z') => ({
    reason: 'awaiting_approval',
    reply: text,
    presentation: { version: 1, status: 'needs_input', kind: 'approval', text, approvalId },
    turnOutcome: { version: 2, status: 'needs_input', needs: { kind: 'approval' }, resumable: true },
  });
  const filler = terminalCompletionPresentation(approvalTerminal('Approval required for Send Slack message. Review apr-k42z to continue.'), '');
  assert.equal(filler.text, '');
  assert.equal(filler.status, 'awaiting-approval');
  const several = terminalCompletionPresentation(approvalTerminal("2 approvals are waiting, starting with Slack open dm (apr-k42z). Approve or reject each and I'll continue."), '');
  assert.equal(several.text, '');
  const spoken = terminalCompletionPresentation(approvalTerminal('Here is the note for your teammate; approve it below and I will send it.'), '');
  assert.equal(spoken.text, 'Here is the note for your teammate; approve it below and I will send it.');
  const foreign = terminalCompletionPresentation(approvalTerminal('Approval required for X. Review apr-other to continue.'), '');
  assert.notEqual(foreign.text, '', 'only the filler naming this presentation\'s own approval is dropped');
});
