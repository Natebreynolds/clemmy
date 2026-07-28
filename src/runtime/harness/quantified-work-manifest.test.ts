import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { WorkerManifestDescriptor } from './work-manifest.js';

process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-quantified-manifest-'));

const eventlog = await import('./eventlog.js');
const {
  evaluateQuantifiedWorkManifestGate: evaluateGate,
} = await import('./quantified-work-manifest.js');
const { prepareWorkerManifest } = await import('./work-manifest.js');
const sourceSeqBySession = new Map<string, number>();

function openTurn(
  id: string,
  kind: 'chat' | 'execution',
  text: string,
  options: { policyCount?: number } = {},
): string {
  eventlog.createSession({ id, kind, title: id });
  const input = eventlog.appendEvent({
    sessionId: id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text },
  });
  sourceSeqBySession.set(id, input.seq);
  eventlog.appendEvent({
    sessionId: id,
    turn: 1,
    role: 'system',
    type: 'turn_started',
    data: { sourceUserSeq: input.seq },
  });
  if (options.policyCount) {
    eventlog.appendEvent({
      sessionId: id,
      turn: 1,
      role: 'system',
      type: 'fanout_policy_decision',
      data: {
        sourceUserSeq: input.seq,
        detected: true,
        itemCount: options.policyCount,
        inputPreview: text,
      },
    });
  }
  return id;
}

function gate(input: {
  sessionId: string;
  items: string[];
  workManifest?: WorkerManifestDescriptor | null;
}) {
  return evaluateGate({
    ...input,
    sourceUserSeq: sourceSeqBySession.get(input.sessionId),
  });
}

function descriptor(id = 'prospect-research') {
  return {
    id,
    contractVersion: '1',
    phase: 'research',
    mode: 'declare' as const,
    phases: [{ id: 'research' }],
  };
}

test.after(() => {
  eventlog.closeEventLog();
});

test('background quantifiable work refuses an unbound or successful-subset worker batch', () => {
  const sessionId = openTurn(
    'quantified-background',
    'execution',
    'Research these 10 prospects and summarize each one.',
    { policyCount: 10 },
  );
  const ten = Array.from({ length: 10 }, (_, index) => `prospect-${index + 1}`);

  const unbound = gate({
    sessionId,
    items: ten,
    workManifest: null,
  });
  assert.equal(unbound.ok, false);
  assert.match(unbound.error ?? '', /workManifest/);
  assert.match(unbound.error ?? '', /fixed 10-item contract/);

  const subset = gate({
    sessionId,
    items: ten.slice(0, 7),
    workManifest: descriptor(),
  });
  assert.equal(subset.ok, false);
  assert.match(subset.error ?? '', /7\/10/);
  assert.match(subset.error ?? '', /full 10-item `items` array/i);

  const complete = gate({
    sessionId,
    items: ten,
    workManifest: descriptor(),
  });
  assert.equal(complete.ok, true);
  assert.equal(complete.required, true);
  assert.equal(complete.expectedCount, 10);
});

test('a declared full universe permits later phase slices but rejects universe drift', () => {
  const sessionId = openTurn(
    'quantified-phases',
    'execution',
    'Analyze these 10 records and validate each one.',
    { policyCount: 10 },
  );
  const ten = Array.from({ length: 10 }, (_, index) => `record-${index + 1}`);
  const declared = prepareWorkerManifest({
    sessionId,
    items: ten,
    descriptor: {
      ...descriptor('records'),
      phases: [
        { id: 'research' },
        { id: 'validate', dependsOn: ['research'] },
      ],
    },
  });
  assert.equal(declared.ok, true);

  const slice = gate({
    sessionId,
    items: ten.slice(0, 3),
    workManifest: {
      id: 'records',
      contractVersion: '1',
      phase: 'validate',
      mode: 'reconcile',
    },
  });
  assert.equal(slice.ok, true, 'the existing ten-item universe keeps a later slice honest');

  const drift = gate({
    sessionId,
    items: ['record-11'],
    workManifest: {
      id: 'records',
      contractVersion: '1',
      phase: 'validate',
      mode: 'extend',
    },
  });
  assert.equal(drift.ok, false);
  assert.match(drift.error ?? '', /fixed 10-item contract|new user request/i);
});

test('large chat batches require manifests while small and ordinary chat remain untouched', () => {
  const large = openTurn(
    'quantified-large-chat',
    'chat',
    'Research these 12 prospects and summarize each one.',
    { policyCount: 12 },
  );
  const largeGate = gate({
    sessionId: large,
    items: Array.from({ length: 12 }, (_, index) => `prospect-${index + 1}`),
  });
  assert.equal(largeGate.ok, false);
  assert.equal(largeGate.required, true);

  const small = openTurn(
    'quantified-small-chat',
    'chat',
    'Research these 4 prospects and summarize each one.',
    { policyCount: 4 },
  );
  const smallGate = gate({
    sessionId: small,
    items: ['a', 'b', 'c', 'd'],
  });
  assert.equal(smallGate.ok, true);
  assert.equal(smallGate.required, false);

  const ordinary = openTurn('ordinary-chat', 'chat', 'Help me refine this one draft.');
  const ordinaryGate = gate({
    sessionId: ordinary,
    items: ['draft'],
  });
  assert.equal(ordinaryGate.ok, true);
  assert.equal(ordinaryGate.required, false);
});

test('a stale prior batch signal never taxes a newer unrelated chat turn', () => {
  const sessionId = openTurn(
    'quantified-stale-chat',
    'chat',
    'Research these 12 prospects and summarize each one.',
    { policyCount: 12 },
  );
  const nextInput = eventlog.appendEvent({
    sessionId,
    turn: 2,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Please rewrite this one headline.' },
  });
  sourceSeqBySession.set(sessionId, nextInput.seq);
  eventlog.appendEvent({
    sessionId,
    turn: 2,
    role: 'system',
    type: 'turn_started',
    data: { sourceUserSeq: nextInput.seq },
  });

  const decision = gate({
    sessionId,
    items: ['headline'],
  });
  assert.equal(decision.ok, true);
  assert.equal(decision.required, false);
});

test('cross-turn retry slices and one exact extension delta preserve the existing universe', () => {
  const sessionId = openTurn(
    'quantified-cross-turn-retry',
    'execution',
    'Analyze these 10 records and validate each one.',
  );
  const ten = Array.from({ length: 10 }, (_, index) => `record-${index + 1}`);
  assert.equal(prepareWorkerManifest({
    sessionId,
    items: ten,
    descriptor: descriptor('records-cross-turn'),
  }).ok, true);

  const retryInput = eventlog.appendEvent({
    sessionId,
    turn: 2,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Retry these 3 failed records and validate each one.' },
  });
  sourceSeqBySession.set(sessionId, retryInput.seq);
  const retryItems = ten.slice(0, 3);
  const retryDescriptor: WorkerManifestDescriptor = {
    id: 'records-cross-turn',
    contractVersion: '1',
    phase: 'research',
    mode: 'reconcile',
  };
  assert.equal(gate({
    sessionId,
    items: retryItems,
    workManifest: retryDescriptor,
  }).ok, true, 'the current 3-item retry is not compared to the older 10-item universe total');
  assert.equal(prepareWorkerManifest({
    sessionId,
    items: retryItems,
    descriptor: retryDescriptor,
  }).ok, true);
  assert.equal(gate({
    sessionId,
    items: retryItems.slice(0, 1),
    workManifest: retryDescriptor,
  }).ok, true, 'after the exact retry delta is bound, a later phase slice is allowed');

  const extendInput = eventlog.appendEvent({
    sessionId,
    turn: 3,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Analyze these 3 additional records and validate each one.' },
  });
  sourceSeqBySession.set(sessionId, extendInput.seq);
  const added = ['record-11', 'record-12', 'record-13'];
  const extendDescriptor: WorkerManifestDescriptor = {
    id: 'records-cross-turn',
    contractVersion: '1',
    phase: 'research',
    mode: 'extend',
  };
  assert.equal(gate({
    sessionId,
    items: ten.slice(0, 3),
    workManifest: extendDescriptor,
  }).ok, false, 'old ids cannot masquerade as the three requested additions');
  assert.equal(gate({
    sessionId,
    items: added,
    workManifest: extendDescriptor,
  }).ok, true, 'an exact new user-authored 3-item scope delta may extend the universe');
  assert.equal(prepareWorkerManifest({
    sessionId,
    items: added,
    descriptor: extendDescriptor,
  }).ok, true);
  assert.equal(gate({
    sessionId,
    items: ['record-14'],
    workManifest: extendDescriptor,
  }).ok, false, 'the same request cannot silently grow beyond its bound 3-item delta');

  const phaseInput = eventlog.appendEvent({
    sessionId,
    turn: 4,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Validate these 3 failed records against the final contract.' },
  });
  sourceSeqBySession.set(sessionId, phaseInput.seq);
  assert.equal(gate({
    sessionId,
    items: ten.slice(0, 3),
    workManifest: {
      id: 'records-cross-turn',
      contractVersion: '1',
      phase: 'validate',
      mode: 'extend',
      phases: [
        { id: 'research' },
        { id: 'validate', dependsOn: ['research'] },
      ],
    },
  }).ok, true, 'an undeclared phase may extend the graph over existing canonical items');
});

test('one report with bullet requirements is not hardened into a fictitious 3-item batch', () => {
  const prompts = [
    ['Create a report with:', '- Executive summary', '- Competitive analysis', '- Recommendations'],
    ['Create a report:', '1. Research the market', '2. Analyze competitors', '3. Present recommendations'],
    ['Create one presentation:', '- Cover slide', '- Market context', '- Recommendations'],
    ['Make me a report:', '- Executive summary', '- Risks', '- Recommendations'],
    ['Create the report with:', '- Executive summary', '- Competitive analysis', '- Recommendations'],
    ['Draft my report:', '- Executive summary', '- Risks', '- Recommendations'],
  ];
  prompts.forEach((lines, index) => {
    const sessionId = openTurn(
      `quantified-bullet-requirements-${index}`,
      'execution',
      lines.join('\n'),
    );
    const decision = gate({ sessionId, items: ['artifact'] });
    assert.equal(decision.ok, true, lines[0]);
    assert.equal(decision.required, false, lines[0]);
  });
});

test('completed batch findings may feed one synthesis artifact without inheriting the old universe', () => {
  const sessionId = openTurn(
    'quantified-completed-not-proposal',
    'execution',
    'Research these 12 prospects and summarize each one.',
  );
  eventlog.appendEvent({
    sessionId,
    turn: 1,
    role: 'assistant',
    type: 'conversation_step',
    data: {
      decision: {
        reply: 'I completed research on these 12 prospects and saved every summary.',
      },
    },
  });
  const synthesisInput = eventlog.appendEvent({
    sessionId,
    turn: 2,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Use these findings to write one report.' },
  });
  sourceSeqBySession.set(sessionId, synthesisInput.seq);

  const decision = gate({ sessionId, items: ['report'] });
  assert.equal(decision.ok, true);
  assert.equal(decision.required, false);
});

test('a proposal for one synthesis artifact carries only its proposal clause, not an old batch count', () => {
  const sessionId = openTurn(
    'quantified-proposal-clause',
    'execution',
    'Research these 12 prospects and summarize each one.',
  );
  eventlog.appendEvent({
    sessionId,
    turn: 1,
    role: 'assistant',
    type: 'conversation_step',
    data: {
      decision: {
        reply: 'I completed research on these 12 prospects. Would you like me to create one combined report?',
      },
    },
  });
  const yes = eventlog.appendEvent({
    sessionId,
    turn: 2,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Yes.' },
  });
  sourceSeqBySession.set(sessionId, yes.seq);
  const decision = gate({ sessionId, items: ['combined-report'] });
  assert.equal(decision.ok, true);
  assert.equal(decision.required, false);
});

test('the execution gate protects explicitly listed plural artifacts', () => {
  for (const [index, lines] of [
    [
      'Create the following reports:',
      '- North report',
      '- South report',
      '- West report',
    ],
    [
      'Create the following reports for one client:',
      '- North report',
      '- South report',
      '- West report',
    ],
    [
      'Draft the following emails for one account:',
      '- North email',
      '- South email',
      '- West email',
    ],
  ].entries()) {
    const sessionId = openTurn(
      `quantified-following-artifacts-${index}`,
      'execution',
      lines.join('\n'),
    );
    const decision = gate({ sessionId, items: ['first-artifact'] });
    assert.equal(decision.ok, false, lines[0]);
    assert.equal(decision.required, true, lines[0]);
    assert.equal(decision.expectedCount, 3, lines[0]);
    assert.match(decision.error ?? '', /fixed 3-item contract/, lines[0]);
  }
});

test('the execution gate treats counted source material as one synthesis artifact', () => {
  for (const [index, prompt] of [
    'Using these 12 completed summaries, create one combined report.',
    'Create one combined report from these 12 completed summaries.',
    'Create a report summarizing these 12 interviews.',
    'Create one report that summarizes these 12 interviews.',
    'Create one report that covers these 12 interviews.',
    'Create one report which summarizes these 12 interviews.',
    'Create one report about these 12 interviews.',
    'Create one report about these 12 interviews, then publish the report.',
    'Summarize these 12 interviews in one report.',
    'Summarize these 12 interviews in the report.',
    'Combine these 12 completed summaries into one report.',
    'Turn these 12 findings into a single report.',
    'Synthesize these 12 interviews into one report.',
    'Write up these 12 summaries as one report.',
    'Write the following 3 sections in one report.',
  ].entries()) {
    const sessionId = openTurn(
      `quantified-counted-synthesis-${index}`,
      'execution',
      prompt,
    );
    const decision = gate({ sessionId, items: ['combined-report'] });
    assert.equal(decision.ok, true, prompt);
    assert.equal(decision.required, false, prompt);
  }
});

test('an affirmed counted synthesis proposal does not inherit its input cardinality', () => {
  for (const [index, proposal] of [
    'Would you like me to create one combined report using these 12 prospect summaries?',
    'I researched these 18 firms. Should I combine them into one report?',
    'There are 18 summaries ready. Shall I synthesize them into one report?',
  ].entries()) {
    const sessionId = openTurn(
      `quantified-counted-synthesis-proposal-${index}`,
      'execution',
      'Research these 18 prospects and summarize each one.',
    );
    eventlog.appendEvent({
      sessionId,
      turn: 1,
      role: 'assistant',
      type: 'conversation_step',
      data: {
        decision: { reply: proposal },
      },
    });
    const yes = eventlog.appendEvent({
      sessionId,
      turn: 2,
      role: 'user',
      type: 'user_input_received',
      data: { text: 'Yes.' },
    });
    sourceSeqBySession.set(sessionId, yes.seq);

    const decision = gate({ sessionId, items: ['combined-report'] });
    assert.equal(decision.ok, true, proposal);
    assert.equal(decision.required, false, proposal);
  }
});

test('a preceding singleton artifact cannot suppress a later independent batch action', () => {
  for (const [index, prompt] of [
    'Create one workspace, then research these 12 prospects.',
    'Build one Airtable base, then draft emails for these 12 prospects.',
    'Create one workspace for these 12 prospects, then research each one.',
    'Create one workspace for these 12 prospects, and research them all.',
    'Create one workspace for these 12 prospects, then research those prospects.',
    'Create one workspace for these 12 prospects, then research the prospects.',
  ].entries()) {
    const sessionId = openTurn(
      `quantified-compound-batch-${index}`,
      'execution',
      prompt,
    );
    const decision = gate({
      sessionId,
      items: Array.from({ length: 7 }, (_, itemIndex) => `prospect-${itemIndex + 1}`),
    });
    assert.equal(decision.ok, false, prompt);
    assert.equal(decision.required, true, prompt);
    assert.equal(decision.expectedCount, 12, prompt);
  }
});

test('explicit per-record, per-row, and parallel item batches are protected without a policy event', () => {
  const cases = [
    ['quantified-records', 'Analyze these 10 records and validate each one.', 10],
    ['quantified-rows', 'Research each of these 120 rows and summarize them.', 120],
    ['quantified-items', 'Process these 20 items in parallel.', 20],
    ['quantified-process-items', 'Process each of these 20 items.', 20],
    ['quantified-validate-rows', 'Validate each of these 20 rows against the contract.', 20],
    ['quantified-update-rows', 'Update each of these 20 rows with the validated status.', 20],
  ] as const;
  for (const [sessionId, text, expectedCount] of cases) {
    openTurn(sessionId, 'execution', text);
    const decision = gate({
      sessionId,
      items: Array.from({ length: expectedCount }, (_, index) => `${sessionId}-${index + 1}`),
    });
    assert.equal(decision.ok, false, text);
    assert.equal(decision.required, true, text);
    assert.equal(decision.expectedCount, expectedCount, text);
  }

  const aggregate = openTurn(
    'quantified-aggregate-rows',
    'execution',
    'Pull 200 rows from the customer table.',
  );
  const aggregateDecision = gate({
    sessionId: aggregate,
    items: ['customer-table'],
  });
  assert.equal(aggregateDecision.ok, true);
  assert.equal(aggregateDecision.required, false);
});

test('explicit per-target output wording cannot collapse a quantified contract to one item', () => {
  for (const [index, prompt] of [
    'Create one report per client for these 12 clients.',
    'Create one report per case for these 12 cases.',
    'Create one report per-case for these 12 cases.',
    'Create one report for every client across these 12 clients.',
    'Create one report per house for these 12 houses.',
    'Create one label per box for these 12 boxes.',
    'Convert these 12 files to one PDF per file.',
    'Transform these 12 records into one normalized record each.',
  ].entries()) {
    const sessionId = openTurn(
      `quantified-per-target-${index}`,
      'execution',
      prompt,
    );
    const decision = gate({
      sessionId,
      items: ['only-one-output'],
      workManifest: descriptor(`per-target-${index}`),
    });
    assert.equal(decision.ok, false, prompt);
    assert.equal(decision.required, true, prompt);
    assert.equal(decision.expectedCount, 12, prompt);
    assert.match(decision.error ?? '', /1\/12/, prompt);
  }
});

test('numeric target modifiers and arbitrary per-item verbs retain the user-owned count', () => {
  for (const [index, prompt, expectedCount] of [
    [0, 'Research these 12 Fortune 500 companies and summarize each one.', 12],
    [1, 'Review these 15 ISO 27001 controls and validate each one.', 15],
    [2, 'Analyze these 10 2025 reports and summarize each one.', 10],
    [3, 'Design these 12 social assets and save each one.', 12],
    [4, 'Research the top 12 Fortune 500 companies and summarize each one.', 12],
    [5, 'Research the first 12 Fortune 500 companies and summarize each one.', 12],
    [6, 'Research these 12 S&P 500 companies and summarize each one.', 12],
    [7, 'Review these 15 ISO/IEC 27001 controls and validate each one.', 15],
    [8, 'Tag each of these 12 records.', 12],
    [9, 'Tag every one of these 12 records.', 12],
    [10, 'Illustrate one icon per feature for these 12 features.', 12],
  ] as const) {
    const sessionId = openTurn(
      `quantified-numeric-modifier-${index}`,
      'execution',
      prompt,
    );
    const decision = gate({
      sessionId,
      items: Array.from({ length: 7 }, (_, itemIndex) => `item-${itemIndex + 1}`),
      workManifest: descriptor(`numeric-modifier-${index}`),
    });
    assert.equal(decision.ok, false, prompt);
    assert.equal(decision.required, true, prompt);
    assert.equal(decision.expectedCount, expectedCount, prompt);
  }
});

test('an internal comma-formatted count owned by one subject remains one task', () => {
  const sessionId = openTurn(
    'quantified-internal-owner-comma',
    'execution',
    "Research this firm's 1,000 competitors.",
  );
  const decision = gate({ sessionId, items: ['firm-research'] });
  assert.equal(decision.ok, true);
  assert.equal(decision.required, false);
});

test('conversation-carried cardinality protects an affirmed large batch without a policy event', () => {
  const sessionId = openTurn(
    'quantified-carried-chat',
    'chat',
    'Found 20 accounts; should I research these 18 email-ready firms next?',
  );
  eventlog.appendEvent({
    sessionId,
    turn: 1,
    role: 'assistant',
    type: 'conversation_step',
    data: {
      decision: {
        reply: 'I found 20 accounts. Want me to research these 18 email-ready firms next?',
      },
    },
  });
  const input = eventlog.appendEvent({
    sessionId,
    turn: 2,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Yes, go ahead with those.' },
  });
  sourceSeqBySession.set(sessionId, input.seq);
  eventlog.appendEvent({
    sessionId,
    turn: 2,
    role: 'system',
    type: 'turn_started',
    data: { sourceUserSeq: input.seq },
  });

  const decision = gate({
    sessionId,
    items: Array.from({ length: 18 }, (_, index) => `firm-${index + 1}`),
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.required, true);
  assert.equal(decision.expectedCount, 18);
});

test('conversation carry retains a count that precedes an anaphoric proposal cue', () => {
  const sessionId = openTurn(
    'quantified-carried-count-before-cue',
    'chat',
    'Find the firms that are ready for research.',
  );
  eventlog.appendEvent({
    sessionId,
    turn: 1,
    role: 'assistant',
    type: 'conversation_step',
    data: {
      decision: {
        reply: 'I found these 18 firms. Should I research them next?',
      },
    },
  });
  const input = eventlog.appendEvent({
    sessionId,
    turn: 2,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Yes.' },
  });
  sourceSeqBySession.set(sessionId, input.seq);

  const decision = gate({
    sessionId,
    items: Array.from({ length: 7 }, (_, index) => `firm-${index + 1}`),
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.required, true);
  assert.equal(decision.expectedCount, 18);
});

test('a quantified batch above the run_worker schema cap routes to durable workflow fan-out', () => {
  for (const [count, renderedCount] of [
    [300, '300'],
    [501, '501'],
    [1000, '1000'],
    [1000, '1,000'],
  ] as const) {
    const sessionId = openTurn(
      `quantified-over-cap-${renderedCount.replace(',', '-')}`,
      'execution',
      `Research these ${renderedCount} prospects and summarize each one.`,
      renderedCount === '300' ? { policyCount: count } : {},
    );
    const decision = gate({
      sessionId,
      items: Array.from({ length: 256 }, (_, index) => `prospect-${index + 1}`),
      workManifest: descriptor(),
    });
    assert.equal(decision.ok, false, String(count));
    assert.equal(decision.required, true, String(count));
    assert.equal(decision.expectedCount, count, String(count));
    assert.match(decision.error ?? '', /run_worker supports at most 256/i);
    assert.match(decision.error ?? '', /workflow.*forEach/i);
    assert.match(decision.error ?? '', /subset/i);
  }
});
