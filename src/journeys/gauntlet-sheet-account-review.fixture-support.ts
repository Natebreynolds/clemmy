/** Test-only semantic reviewer. No production imports or authority writes. */
import assert from 'node:assert/strict';
import type { SourceAccountJudgeCall, SourceAccountJudgeResult } from '../runtime/semantic-boundary/turn-semantic-model-port.js';

type AcceptedSource = { seq: number; sessionId: string; role: string; data: Record<string, unknown> };
export function currentSourceAccountReviewer(input: {
  sessionId: () => string;
  acceptedText: string;
  toolkit: string;
  accountIdentity: string;
  acceptedSource: (sessionId: string, seq: number) => AcceptedSource | undefined;
}): (call: SourceAccountJudgeCall) => Promise<SourceAccountJudgeResult> {
  return async (call) => {
    assert.equal(call.purpose, 'turn_semantics_account_selection');
    assert.equal(call.sessionId, input.sessionId());
    assert.ok(Number.isSafeInteger(call.sourceUserSeq) && call.sourceUserSeq > 0);
    const source = input.acceptedSource(call.sessionId, call.sourceUserSeq);
    assert.ok(source, 'account review must reopen the exact accepted source');
    assert.equal(source.seq, call.sourceUserSeq);
    assert.equal(source.sessionId, input.sessionId());
    assert.equal(source.role, 'user');
    const text = typeof source.data.displayText === 'string' && source.data.displayText
      ? source.data.displayText : source.data.text;
    assert.equal(text, input.acceptedText);
    assert.equal(call.acceptedText, input.acceptedText);
    assert.equal(call.toolkit, input.toolkit);
    assert.equal(call.accountIdentity, input.accountIdentity);
    assert.equal(call.mode, 'current_source_default');
    assert.equal(call.sourceQuote, null);
    assert.equal(call.establishedSource, null);
    assert.match(call.proposalDigest, /^[a-f0-9]{64}$/);
    return { verdict: 'default_compatible', proposalDigest: call.proposalDigest,
      modelIdentity: 'fixture-current-source-account-reviewer' };
  };
}
