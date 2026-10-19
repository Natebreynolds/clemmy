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
import { terminalNoticeLine } from './terminal-status.js';
import { noticeReplacesReply } from './types.js';

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

test('only the exact host-typed blocked memory reason carries a current-memory read hint', () => {
  const pending = { ...typed('blocked', 'answer'), sourceUserSeq: 41, blockedReason: 'memory_consolidation_pending' };
  assert.deepEqual(terminalFactsFrom(pending)?.memoryWork, { sourceUserSeq: 41, reason: 'memory_consolidation_pending' });
  assert.deepEqual(terminalFactsFrom({ ...pending, blockedReason: 'memory_work_unverified' })?.memoryWork, { sourceUserSeq: 41, reason: 'memory_work_unverified' });
  for (const data of [{ ...pending, sourceUserSeq: 0 }, { ...pending, sourceUserSeq: '41' }, { ...pending, sourceUserSeq: undefined },
    { ...pending, blockedReason: undefined, reply: 'memory_consolidation_pending' }, { ...typed('done', 'answer'), sourceUserSeq: 41, blockedReason: pending.blockedReason },
    { ...typed('cancelled', 'answer'), sourceUserSeq: 41, blockedReason: pending.blockedReason }]) {
    assert.equal(terminalFactsFrom(data)?.memoryWork, undefined);
  }
  const next = terminalCompletionPresentation({ ...typed('done', 'answer'), sourceUserSeq: 42 }, '');
  assert.equal(next.terminal?.memoryWork, undefined, 'a new terminal is freshly projected and does not inherit an earlier hint');
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

const withFacts = (status: string, extra: Record<string, unknown>, text = 'Here is the answer.') => ({
  reply: text,
  presentation: { version: 1, status, kind: 'answer', text },
  turnOutcome: { version: 2, status, resumable: true },
  ...extra,
});

test('review, review note, retained facts and notice are read from the terminal', () => {
  const facts = terminalFactsFrom(withFacts('blocked', {
    review: 'needs_recheck',
    reviewNote: '  The totals rest on   last week’s export.\n',
    retained: { results: 3, outsideChange: 'went_through' },
    notice: { code: 'provider_out_of_credit', model: 'Vendor V4', agentName: 'Desk', providerSaid: 'Insufficient balance.' },
  }));
  assert.equal(facts?.review, 'needs_recheck');
  assert.equal(facts?.reviewNote, 'The totals rest on last week’s export.');
  assert.deepEqual(facts?.retained, { results: 3, outsideChange: 'went_through' });
  assert.deepEqual(facts?.notice, { code: 'provider_out_of_credit', agentName: 'Desk', model: 'Vendor V4', providerSaid: 'Insufficient balance.' });
});

test('unknown review, retained and notice values are ignored, never invented', () => {
  const facts = terminalFactsFrom(withFacts('done', {
    review: 'approved-ish',
    reviewNote: 'A finding with no ruling.',
    retained: { results: 0, outsideChange: 'none' },
    notice: { code: 'party_time', model: 'Vendor V4' },
  }));
  assert.deepEqual(facts, { status: 'done', kind: 'answer', resumable: true });
  assert.equal(terminalFactsFrom(withFacts('done', { retained: { results: -2, outsideChange: 'sideways' } }))?.retained, undefined);
  assert.deepEqual(terminalFactsFrom(withFacts('done', { retained: { results: 1.5, outsideChange: 'refused' } }))?.retained,
    { results: 0, outsideChange: 'refused' }, 'a settled outside change survives a malformed count');
  assert.deepEqual(terminalFactsFrom(withFacts('done', { notice: { code: 'stopped', model: 42, agentName: '  ' } }))?.notice,
    { code: 'stopped' });
  assert.equal(terminalFactsFrom(withFacts('done', { notice: 'stopped' }))?.notice, undefined);
  assert.equal(terminalFactsFrom({ review: 'checked', notice: { code: 'stopped' } }), undefined,
    'an event with no typed terminal carries no facts at all');
});

test('the review note is bounded to the contract length', () => {
  const facts = terminalFactsFrom(withFacts('done', { review: 'rejected', reviewNote: 'x'.repeat(900) }));
  assert.equal(facts?.reviewNote?.length, 400);
  assert.ok(facts?.reviewNote?.endsWith('…'));
});

test('a notice in place of a reply yields no assistant text, whatever the event or the stream carried', () => {
  const stopped = terminalCompletionPresentation(
    withFacts('cancelled', { notice: { code: 'stopped' }, retained: { results: 1, outsideChange: 'none' } }, 'Stopped. 1 result kept.'),
    'Let me read the first fi',
    'thinking',
  );
  assert.equal(stopped.text, '');
  assert.equal(stopped.status, 'stopped');
  assert.deepEqual(stopped.terminal?.notice, { code: 'stopped' });
  assert.deepEqual(stopped.terminal?.retained, { results: 1, outsideChange: 'none' });

  const credit = terminalCompletionPresentation(withFacts('failed', { notice: { code: 'provider_out_of_credit' } }, 'The model account is out of credit.'), '');
  assert.equal(credit.text, '');
  assert.equal(credit.status, 'failed');

  const decided = terminalCompletionPresentation(withFacts('done', { notice: { code: 'card_decision' } }, 'Approved.'), '');
  assert.equal(decided.text, '');
  assert.equal(decided.status, 'complete');
});

// The old fallbacks put a sentence in Clem's mouth ("I reached this run's
// current limit…") whenever a typed terminal arrived with no words. Typed
// terminals now carry a status the surfaces draw as a pill instead.
test('a typed terminal with no words gets its status, never a sentence written in Clem’s place', () => {
  for (const status of ['blocked', 'failed', 'cancelled', 'transferred', 'uncertain', 'needs_input'] as const) {
    for (const extra of [{}, { retained: { results: 2, outsideChange: 'did_not' } }]) {
      const m = terminalCompletionPresentation(withFacts(status, extra, ''), '');
      assert.equal(m.text, '', `${status} ${JSON.stringify(extra)}`);
      assert.equal(m.terminal?.status, status);
    }
  }
  const cancelled = terminalCompletionPresentation(withFacts('cancelled', { reason: 'cancelled' }, ''), '');
  assert.equal(cancelled.status, 'stopped', 'the message status is decided as before');
  const placeholder = terminalCompletionPresentation(withFacts('blocked', {}, 'Done.'), '');
  assert.equal(placeholder.text, '', 'a bare placeholder is no words either');
});

test('a typed terminal keeps Clem’s own words, streamed or delivered', () => {
  const streamed = terminalCompletionPresentation(withFacts('blocked', { retained: { results: 3, outsideChange: 'none' } }, ''), 'I read two of the three files.');
  assert.equal(streamed.text, 'I read two of the three files.');
  const delivered = terminalCompletionPresentation(withFacts('blocked', { review: 'rejected' }, 'Here is what I found.'), '');
  assert.equal(delivered.text, 'Here is what I found.');
  assert.equal(delivered.terminal?.review, 'rejected');
});

// The host holds a draft that may not be in the format the owner asked for and
// publishes Clem's own words with the format notice beside them. Blanking every
// notice terminal hid her answer, leaving only the status line.
test('a format notice sits beside Clem’s own draft: her words stay and the notice line is drawn', () => {
  const draft = '```json\n{"value":"fixture"}\n```\nIts completeness is unknown.';
  for (const code of ['response_format_unmet', 'response_format_unqualified'] as const) {
    assert.equal(noticeReplacesReply(code), false);
    const held = terminalCompletionPresentation({
      reply: draft,
      presentation: { status: 'blocked', kind: 'answer', text: draft },
      turnOutcome: { status: 'blocked', resumable: true },
      review: 'rejected',
      notice: { code },
    }, '');
    assert.equal(held.text, draft, code);
    assert.equal(held.status, 'failed');
    assert.equal(held.terminal?.review, 'rejected');
    assert.deepEqual(held.terminal?.notice, { code });
    assert.ok(terminalNoticeLine(held.terminal)?.label, 'the notice line is drawn as well');

    const streamed = terminalCompletionPresentation({
      reply: '',
      presentation: { status: 'blocked', kind: 'answer', text: '' },
      turnOutcome: { status: 'blocked' },
      notice: { code },
    }, 'Streamed words of hers.', 'thinking');
    assert.equal(streamed.text, 'Streamed words of hers.', 'words she streamed are kept too');
  }
  for (const code of ['stopped', 'provider_quota', 'card_decision', 'run_failed'] as const) {
    assert.equal(noticeReplacesReply(code), true, code);
  }
});
