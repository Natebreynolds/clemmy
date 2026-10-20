/**
 * The status line under a turn is the app's, never Clem's. It says how the
 * turn ended and what it kept, and for a turn no model spoke for, what the
 * owner can do about it. It never says "I".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cardDecisionNoticeOnly,
  retainedOutsideChange,
  terminalNoticeLine,
  terminalNoticeVoiceFact,
  terminalStatusPill,
} from './terminal-status.js';
import type { RetainedOutsideChange, TerminalFacts, TerminalNoticeCode } from './types.js';

const ALL_STATUSES: TerminalFacts['status'][] = ['done', 'needs_input', 'blocked', 'cancelled', 'failed', 'transferred', 'uncertain'];
const ALL_NOTICES: TerminalNoticeCode[] = [
  'stopped', 'response_format_unmet', 'response_format_unqualified', 'provider_quota', 'card_decision',
  'saved_model_unavailable', 'model_unavailable_on_sign_in', 'no_model_connected', 'codex_sign_in_expired',
  'provider_out_of_credit', 'model_stalled', 'run_failed', 'steering_unavailable', 'continuation_unavailable',
];
const ALL_OUTSIDE: RetainedOutsideChange[] = ['went_through', 'did_not', 'mixed', 'refused', 'uncertain', 'none'];

test('pills append the results a stopped turn kept', () => {
  assert.equal(terminalStatusPill({ status: 'blocked', retained: { results: 3, outsideChange: 'none' } })?.label, 'Stopped here — 3 results kept');
  assert.equal(terminalStatusPill({ status: 'cancelled', retained: { results: 1, outsideChange: 'none' } })?.label, 'Cancelled · 1 result kept');
  assert.equal(terminalStatusPill({ status: 'failed', retained: { results: 2, outsideChange: 'mixed' } })?.label, 'Didn’t finish · 2 results kept');
  assert.equal(terminalStatusPill({ status: 'uncertain', retained: { results: 1, outsideChange: 'uncertain' } })?.label,
    'Outcome uncertain — check before repeating · 1 result kept');
  assert.equal(terminalStatusPill({ status: 'transferred', retained: { results: 4, outsideChange: 'none' } })?.label, 'Handed off · 4 results kept');
  assert.equal(terminalStatusPill({ status: 'needs_input', kind: 'continue', retained: { results: 2, outsideChange: 'none' } })?.label,
    'Paused — say “continue” to pick up · 2 results kept');
});

test('pills read as before when nothing was kept', () => {
  assert.equal(terminalStatusPill({ status: 'blocked' })?.label, 'Stopped here — your work is kept');
  assert.equal(terminalStatusPill({ status: 'cancelled' })?.label, 'Cancelled');
  assert.equal(terminalStatusPill({ status: 'transferred' })?.label, 'Handed off');
  assert.equal(terminalStatusPill({ status: 'needs_input', needs: 'continue' })?.label, 'Paused — say “continue” to pick up');
  assert.equal(terminalStatusPill({ status: 'needs_input', kind: 'approval' })?.label, 'Waiting for your approval');
  assert.equal(terminalStatusPill({ status: 'needs_input', kind: 'question' }), null, 'a question keeps each surface’s own reply prompt');
  assert.equal(terminalStatusPill({ status: 'done', retained: { results: 2, outsideChange: 'none' } }), null);
  assert.equal(terminalStatusPill(undefined), null);
});

test('a stop with no words names its next edge on the pill; one the owner asked for does not', () => {
  assert.equal(terminalStatusPill({ status: 'blocked', resumable: true }, { wordless: true })?.label,
    'Stopped here — your work is kept · say “continue” to pick up');
  assert.equal(terminalStatusPill({ status: 'failed' }, { wordless: true })?.label, 'Didn’t finish · say “continue” to pick up');
  assert.equal(terminalStatusPill({ status: 'failed', resumable: false }, { wordless: true })?.label, 'Didn’t finish');
  assert.equal(terminalStatusPill({ status: 'cancelled', retained: { results: 1, outsideChange: 'none' } }, { wordless: true })?.label,
    'Cancelled · 1 result kept');
  assert.equal(terminalStatusPill({ status: 'blocked' }, { wordless: false })?.label, 'Stopped here — your work is kept');
});

test('a lost continuation offers a work check without promising a saved checkpoint or voice narration', () => {
  const terminal: TerminalFacts = { status: 'blocked', resumable: true, notice: { code: 'continuation_unavailable' } };
  assert.deepEqual(terminalStatusPill(terminal, { wordless: true }), { label: 'Request unfinished', tone: 'warning' });
  const notice = terminalNoticeLine(terminal)!;
  assert.match(notice.label, /Ask her to check what completed and what remains before continuing/);
  assert.equal(notice.action, undefined);
  assert.doesNotMatch(notice.label, /say .continue|try again|work is kept|nothing (?:ran|changed)/i);
  assert.equal(terminalNoticeVoiceFact(terminal), null, 'publishing this stopped owner never asks a voice model to narrate');
  assert.deepEqual(terminalStatusPill({ ...terminal, retained: { results: 2, outsideChange: 'uncertain' } }, { wordless: true }),
    { label: 'Request unfinished · 2 results kept', tone: 'warning' });
  assert.match(terminalNoticeLine({ ...terminal, retained: { results: 2, outsideChange: 'uncertain' } })!.label, /2 results kept$/);
  assert.equal(retainedOutsideChange({ ...terminal, retained: { results: 2, outsideChange: 'uncertain' } })?.label,
    'Change in another app not confirmed — check before repeating');
});

test('an outside change with a settled state gets its own chip', () => {
  const label = (outsideChange: RetainedOutsideChange, status: TerminalFacts['status'] = 'blocked') =>
    retainedOutsideChange({ status, retained: { results: 0, outsideChange } })?.label ?? null;
  assert.equal(label('went_through'), 'Change in another app went through');
  assert.equal(label('did_not'), 'Change in another app didn’t go through');
  assert.equal(label('mixed'), 'Some changes in other apps went through');
  assert.equal(label('refused'), 'Another app turned the change down');
  assert.equal(label('uncertain'), 'Change in another app not confirmed — check before repeating');
  assert.equal(label('uncertain', 'uncertain'), null, 'the uncertain pill already says it');
  assert.equal(label('none'), null);
  assert.equal(retainedOutsideChange({ status: 'blocked' }), null);
});

test('each notice is an app status line with the action that resolves it', () => {
  const line = (code: TerminalNoticeCode, extra: Partial<NonNullable<TerminalFacts['notice']>> = {}) =>
    terminalNoticeLine({ status: 'failed', notice: { code, ...extra } });
  assert.deepEqual(line('saved_model_unavailable', { agentName: 'Desk', model: 'Vendor V4' }),
    { label: 'Desk’s saved model, Vendor V4, isn’t available', tone: 'warning', action: 'change_model' });
  assert.equal(line('model_unavailable_on_sign_in', { model: 'Vendor V4' })?.action, 'change_model');
  assert.equal(line('no_model_connected')?.action, 'change_model');
  assert.equal(line('codex_sign_in_expired')?.action, 'sign_in');
  assert.equal(line('provider_out_of_credit')?.action, 'add_credit');
  assert.equal(line('model_stalled')?.action, 'try_again');
  assert.equal(line('run_failed')?.action, 'try_again');
  // A steering record that cannot be read blocks every message in that
  // conversation: a retry reproduces it, so the line names the edge instead.
  assert.deepEqual(line('steering_unavailable'),
    { label: 'This conversation’s steering record couldn’t be read — the message didn’t start. Start a new conversation to continue', tone: 'warning' });
  assert.equal(line('steering_unavailable')?.action, undefined);
  assert.equal(line('response_format_unmet')?.action, undefined);
  assert.deepEqual(line('provider_quota', { model: 'Vendor V4', providerSaid: 'Weekly limit reached.' }),
    { label: 'Vendor V4 reached its usage limit', tone: 'warning', detail: 'The provider said: Weekly limit reached.', action: 'change_model' });
  assert.equal(terminalNoticeLine({ status: 'failed', notice: { code: 'run_failed' }, retained: { results: 2, outsideChange: 'none' } })?.label,
    'This run stopped on an error · 2 results kept');
});

test('a stop the owner asked for is the pill only, and a card decision is the card’s', () => {
  assert.equal(terminalNoticeLine({ status: 'cancelled', notice: { code: 'stopped' } }), null);
  assert.equal(terminalNoticeLine({ status: 'done', notice: { code: 'card_decision' } }), null);
  assert.equal(terminalNoticeLine({ status: 'done' }), null);
  assert.equal(cardDecisionNoticeOnly({ text: '', status: 'complete', terminal: { status: 'done', notice: { code: 'card_decision' } } }), true);
  assert.equal(cardDecisionNoticeOnly({ text: '', status: 'failed', terminal: { status: 'failed', notice: { code: 'card_decision' } } }), false);
  assert.equal(cardDecisionNoticeOnly({ text: '', status: 'stopped', terminal: { status: 'cancelled', notice: { code: 'stopped' } } }), false);
});

test('approved execution completion is an app notice without a second voice request', () => {
  const terminal: TerminalFacts = { status: 'done', notice: { code: 'approved_action_completed' } };
  assert.deepEqual(terminalNoticeLine(terminal), { label: 'Approved action completed', tone: 'neutral' });
  assert.equal(terminalNoticeVoiceFact(terminal), null);
  for (const status of ['failed', 'blocked', 'cancelled', 'uncertain', 'needs_input'] as const) {
    assert.equal(terminalNoticeLine({ ...terminal, status }), null);
  }
});

test('no status line, chip or notice the app writes ever speaks as Clem', () => {
  const firstPerson = /\b(?:I|I’m|I'm|I’ll|I'll|I’ve|I've|me|my)\b/;
  const seen: string[] = [];
  for (const status of ALL_STATUSES) {
    for (const results of [0, 1, 3]) {
      for (const outsideChange of ALL_OUTSIDE) {
        const retained = results > 0 || outsideChange !== 'none' ? { results, outsideChange } : undefined;
        for (const kind of [undefined, 'continue', 'approval', 'question'] as const) {
          for (const wordless of [false, true]) {
            const terminal: TerminalFacts = { status, ...(kind ? { kind } : {}), ...(retained ? { retained } : {}) };
            const pill = terminalStatusPill(terminal, { wordless });
            if (pill) seen.push(pill.label);
            const chip = retainedOutsideChange(terminal);
            if (chip) seen.push(chip.label);
          }
        }
        for (const code of ALL_NOTICES) {
          const notice = terminalNoticeLine({ status, notice: { code, agentName: 'Desk', model: 'Vendor V4', providerSaid: 'Refused.' }, ...(retained ? { retained } : {}) });
          if (notice) seen.push(notice.label, notice.detail ?? '');
        }
      }
    }
  }
  assert.ok(seen.length > 100);
  for (const label of seen) assert.doesNotMatch(label, firstPerson, label);
});

test('live voice gets a notice as its typed fact, never its wording, and nothing for a chosen stop or a card decision', () => {
  const fact = terminalNoticeVoiceFact({
    notice: { code: 'provider_out_of_credit', model: 'Vendor V4', agentName: 'Desk', providerSaid: 'Insufficient balance.' },
    retained: { results: 2, outsideChange: 'none' },
  });
  assert.ok(fact);
  assert.match(fact!, /provider_out_of_credit \(model: Vendor V4; agent: Desk\)/);
  assert.match(fact!, /The provider said: Insufficient balance\./);
  assert.match(fact!, /Add credit/);
  assert.match(fact!, /2 results kept/);
  assert.match(fact!, /not Clem's words/);
  const line = terminalNoticeLine({ status: 'failed', notice: { code: 'provider_out_of_credit', model: 'Vendor V4' } });
  assert.equal(fact!.includes(line!.label), false, 'the status line wording is not handed over');
  assert.equal(terminalNoticeVoiceFact({ notice: { code: 'stopped' } }), null);
  assert.equal(terminalNoticeVoiceFact({ notice: { code: 'card_decision' } }), null);
  assert.equal(terminalNoticeVoiceFact({ retained: { results: 3, outsideChange: 'none' } }), null);
  assert.equal(terminalNoticeVoiceFact(undefined), null);
  for (const code of ALL_NOTICES) {
    const said = terminalNoticeVoiceFact({ notice: { code } });
    if (said) assert.match(said, new RegExp(`: ${code}\\.`), code);
  }
});
