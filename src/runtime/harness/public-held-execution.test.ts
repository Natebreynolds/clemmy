/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/public-held-execution.test.ts */
import assert from 'node:assert/strict';
import test from 'node:test';

const { heldExecutionTextForInternalReason, publicHeldExecutionText, publicCompletionText, projectHarnessEventForPublic } = await import('./public-presentation.js');
const { presentationEventForOutcome, turnOutcomeId } = await import('./turn-outcome.js');

test('blocked account and uncertain write copy stay user-facing and secret-free', () => {
  const blocked = publicHeldExecutionText({
    kind: 'blocked',
    cause: 'account',
    providerCallOccurred: false,
    externalChangePossible: false,
    retrySafe: true,
    willResumeAutomatically: false,
  });
  assert.match(blocked, /No provider call was made/);
  assert.match(blocked, /reconnect the exact account/i);
  assert.doesNotMatch(blocked, /could not interpret/i);
  assert.doesNotMatch(blocked, /authorityDigest|canonicalArgs|acct:beta/i);

  const uncertain = publicHeldExecutionText({
    kind: 'uncertain',
    cause: 'reconciliation',
    providerCallOccurred: true,
    externalChangePossible: true,
    retrySafe: false,
    willResumeAutomatically: false,
  });
  assert.match(uncertain, /provider call was already reserved/);
  assert.match(uncertain, /will not write again/);
  assert.match(uncertain, /verify the artifact/i);
});

test('legacy account and reconciliation reasons ask for an exact progress check without inferring execution facts', () => {
  const blocked = heldExecutionTextForInternalReason('account_mismatch: live lease missing', 'blocked');
  const uncertain = heldExecutionTextForInternalReason('reconciliation_required: recovered crossing could not settle', 'uncertain');
  assert.match(blocked, /blocked.*unfinished.*check the required account.*completed work.*exact request/i);
  assert.match(uncertain, /cannot confirm the outcome.*unfinished.*check the recorded execution state/i);
  for (const text of [blocked, uncertain]) {
    assert.doesNotMatch(text, /provider call|external change|retry is safe|will not write|automatically|will wait|restate|approve|reconnect|authorityDigest|canonicalArgs|acct:beta/i);
  }
});

test('legacy storage and settlement reasons do not manufacture a recovery owner or a no-effects receipt', () => {
  for (const reason of [
    'expected-work freeze storage_error: database is locked',
    'expected-work activation storage_error: database is locked',
    'settlement_failed: logical call could not settle (storage_error)',
    'capability schema missing after provider call already reserved',
  ]) {
    const text = heldExecutionTextForInternalReason(reason, 'blocked');
    assert.match(text, /unfinished.*Ask me to check.*completed work.*exact request.*before continuing/i);
    assert.doesNotMatch(text, /automatically|wait for recovery|will wait|No provider call|No external change|already reserved|retry is|approve|provision|database|storage_error/i);
  }
  assert.equal(heldExecutionTextForInternalReason('A concrete reply outside this legacy category.'), 'A concrete reply outside this legacy category.');
});

function typedApprovalFixture() {
  const identity = { sessionId: 'held-copy-approval', turn: 2, sourceUserSeq: 41 };
  const text = 'Approve the prepared change to the named draft.';
  const outcome = {
    version: 2, id: turnOutcomeId(identity), identity,
    status: 'needs_input', resumable: true, needs: { kind: 'approval' },
    presentation: { kind: 'approval', approvalId: 'approval-held-copy-41', text },
  } as const;
  const presentation = presentationEventForOutcome(outcome);
  return {
    identity, text, presentation,
    event: {
      seq: 42, id: 'held-copy-terminal-41', sessionId: identity.sessionId, turn: identity.turn,
      role: 'system' as const, type: 'conversation_completed' as const, parentEventId: null,
      createdAt: '2026-10-05T00:00:00.000Z',
      data: {
        logicalTerminalVersion: 1, terminalKey: outcome.id, sourceUserSeq: identity.sourceUserSeq,
        presentation, turnOutcome: outcome, reply: text, summary: text,
        reason: 'expected-work freeze storage_error: database is locked',
      },
    },
  };
}

test('a coherent typed approval retains its text and exact approval control over a legacy held reason', () => {
  const { identity, text, presentation, event } = typedApprovalFixture();
  assert.equal(publicCompletionText(event.data), text);
  assert.equal(publicCompletionText({ ...event.data, reply: event.data.reason }), text,
    'valid typed text takes precedence over non-authoritative legacy prose');
  const projected = projectHarnessEventForPublic(event)!;
  assert.equal(projected.data.reply, text);
  assert.equal(publicCompletionText(projected.data), text, 'the public canonical mirror revalidates');
  const shown = projected.data.presentation as typeof presentation;
  assert.equal(shown.kind, 'approval');
  assert.equal(shown.status, 'needs_input');
  assert.equal(shown.resumable, true);
  assert.deepEqual(shown.needs, { kind: 'approval' });
  assert.equal(shown.approvalId, 'approval-held-copy-41');
  assert.deepEqual(shown.identity, identity);
});

test('an invalid source mirror cannot launder a duplicate reply into typed approval controls', () => {
  const { event, text } = typedApprovalFixture();
  const { sourceUserSeq: _source, ...missingSource } = event.data;
  for (const sourceData of [missingSource, { ...event.data, sourceUserSeq: event.data.sourceUserSeq + 1 }]) {
    const invalid = { ...event, data: { ...sourceData,
      reply: 'expected-work freeze storage_error: database is locked',
    } };
    const projected = projectHarnessEventForPublic(invalid)!;
    assert.equal(publicCompletionText(invalid.data), projected.data.reply);
    assert.notEqual(projected.data.reply, text);
    assert.match(String(projected.data.reply), /final reply was not safe to display.*cannot confirm.*complete.*activity log/i);
    assert.doesNotMatch(String(projected.data.reply), /Approve|storage_error|database|automatically|retry/i);
    const shown = projected.data.presentation as Record<string, unknown>;
    assert.equal(shown.status, 'failed');
    assert.equal(shown.kind, 'error');
    assert.equal(shown.resumable, false);
    assert.equal(shown.needs, undefined);
    assert.equal(shown.approvalId, undefined);
    assert.equal(shown.identity, undefined);
    assert.equal(projected.data.turnOutcome, undefined);
  }
});
