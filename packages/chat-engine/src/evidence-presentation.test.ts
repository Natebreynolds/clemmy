import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evidenceChips, evidenceSummary, openableEvidence } from './evidence-presentation.js';
import { terminalFactsFrom } from './terminal-presentation.js';

test('a turn that wrote, saved and read says so in that order', () => {
  assert.equal(evidenceSummary([
    { kind: 'source', id: 's1' },
    { kind: 'tool_result', id: 't1' },
    { kind: 'external_receipt', id: 'r1' },
    { kind: 'artifact', id: 'a1', uri: 'file:///tmp/brief.md' },
    { kind: 'external_receipt', id: 'r2' },
    { kind: 'source', id: 's2' },
    { kind: 'memory', id: 'm1' },
  ]), '2 writes confirmed · 1 file · 1 remembered · 2 sources · 1 result');
});

test('an absent kind is absent, never a zero', () => {
  // "0 writes confirmed" would be a claim the harness never made.
  const chips = evidenceChips([{ kind: 'source', id: 's1' }]);
  assert.deepEqual(chips.map((c) => c.kind), ['source']);
  assert.equal(evidenceSummary([]), '');
  assert.equal(evidenceSummary(undefined), '');
});

test('malformed refs are dropped rather than rendered', () => {
  assert.equal(evidenceSummary([
    { kind: 'artifact', id: '' },
    { kind: 'nonsense' as never, id: 'x' },
    { kind: 'artifact', id: 'a1' },
  ]), '1 file');
});

test('only refs with a uri are offered as openable', () => {
  const refs = [
    { kind: 'artifact' as const, id: 'a1', uri: 'file:///tmp/brief.md' },
    { kind: 'artifact' as const, id: 'a2' },
    { kind: 'external_receipt' as const, id: 'r1', uri: '' },
  ];
  assert.deepEqual(openableEvidence(refs).map((r) => r.id), ['a1']);
});

test('terminalFactsFrom lifts the harness evidence onto the message', () => {
  const facts = terminalFactsFrom({
    turnOutcome: {
      version: 2,
      status: 'done',
      resumable: false,
      evidenceRefs: [
        { kind: 'external_receipt', id: 'r1' },
        { kind: 'artifact', id: 'a1', uri: 'file:///tmp/sheet.csv' },
      ],
    },
    presentation: { status: 'done', kind: 'answer', text: 'Done.' },
  });
  assert.equal(facts?.status, 'done');
  assert.equal(evidenceSummary(facts?.evidenceRefs), '1 write confirmed · 1 file');
});

test('a legacy terminal with no evidence stays absent, not empty', () => {
  const facts = terminalFactsFrom({
    turnOutcome: { version: 2, status: 'done', resumable: false },
    presentation: { status: 'done', kind: 'answer', text: 'Done.' },
  });
  assert.equal(facts?.evidenceRefs, undefined);
});

test('a malformed evidenceRefs payload never becomes a claim', () => {
  for (const evidenceRefs of ['nope', 42, {}, [null], [{ kind: 'artifact' }], [{ id: 'a1' }]]) {
    const facts = terminalFactsFrom({
      turnOutcome: { version: 2, status: 'done', resumable: false, evidenceRefs },
      presentation: { status: 'done', kind: 'answer', text: 'Done.' },
    });
    assert.equal(facts?.evidenceRefs, undefined, `evidenceRefs: ${JSON.stringify(evidenceRefs)}`);
  }
});
