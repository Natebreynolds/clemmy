import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeWorkflowGaps, renderWorkflowGapQuestions } from './workflow-gap-test.js';
import type { WorkflowDefinition } from '../memory/workflow-store.js';

function wf(partial: Partial<WorkflowDefinition>): WorkflowDefinition {
  return {
    name: 'test',
    description: '',
    enabled: true,
    trigger: { manual: true },
    steps: [],
    ...partial,
  };
}

test('clean, well-formed workflow produces no gaps', () => {
  const def = wf({
    steps: [
      { id: 'research', prompt: 'Research the company background and summarize key facts.' },
    ],
  });
  assert.equal(analyzeWorkflowGaps(def).length, 0);
});

test('flags a deliverable producer with no output contract', () => {
  const def = wf({
    steps: [
      { id: 'build', prompt: 'Generate a Google Sheet with the prospect data and populate every row.' },
    ],
  });
  const gaps = analyzeWorkflowGaps(def);
  assert.ok(gaps.some((g) => g.stepId === 'build'));
});

test('does NOT flag a deliverable producer that declares an output contract', () => {
  const def = wf({
    steps: [
      {
        id: 'build',
        prompt: 'Generate a Google Sheet with the prospect data.',
        output: { type: 'object', verify: { url_present: ['sheetUrl'] } },
      },
    ],
  });
  assert.equal(analyzeWorkflowGaps(def).length, 0);
});

test('flags an irreversible send for recipient clarity', () => {
  const def = wf({
    steps: [
      { id: 'send', prompt: 'Send the outreach emails to the list.', requiresApproval: true },
    ],
  });
  const gaps = analyzeWorkflowGaps(def);
  assert.ok(gaps.some((g) => g.stepId === 'send' && /who/i.test(g.question)));
});

test('flags an undeclared referenced input', () => {
  const def = wf({
    steps: [
      { id: 's1', prompt: 'Email the report to {{input.recipientEmail}} when done.' },
    ],
  });
  const gaps = analyzeWorkflowGaps(def);
  assert.ok(gaps.some((g) => /recipientEmail/.test(g.question)));
});

test('does NOT flag a declared input', () => {
  const def = wf({
    inputs: { recipientEmail: { type: 'string', description: 'who to email' } },
    steps: [
      { id: 's1', prompt: 'Email the summary to {{input.recipientEmail}}.' },
    ],
  });
  // No send/deliverable signal; declared input → no input gap.
  assert.ok(!analyzeWorkflowGaps(def).some((g) => /recipientEmail/.test(g.question)));
});

test('does NOT flag a common injectable input key', () => {
  const def = wf({
    steps: [{ id: 's1', prompt: 'Audit {{input.url}} for SEO issues.' }],
  });
  assert.ok(!analyzeWorkflowGaps(def).some((g) => /"url"/.test(g.question)));
});

test('flags cadence prose with no schedule', () => {
  const def = wf({
    description: 'Every morning, summarize overnight signups.',
    trigger: { manual: true },
    steps: [{ id: 's1', prompt: 'Summarize the signups.' }],
  });
  assert.ok(analyzeWorkflowGaps(def).some((g) => /schedule/i.test(g.question)));
});

test('does NOT flag cadence when a schedule is set', () => {
  const def = wf({
    description: 'Every morning, summarize overnight signups.',
    trigger: { schedule: '0 8 * * *', manual: true },
    steps: [{ id: 's1', prompt: 'Summarize the signups.' }],
  });
  assert.ok(!analyzeWorkflowGaps(def).some((g) => /schedule/i.test(g.question)));
});

test('flags a per-item step with an upstream but no forEach', () => {
  const def = wf({
    steps: [
      { id: 'pull', prompt: 'Pull the list of prospects.' },
      { id: 'enrich', prompt: 'For each prospect, research their firm and write notes.', dependsOn: ['pull'] },
    ],
  });
  const gaps = analyzeWorkflowGaps(def);
  assert.ok(gaps.some((g) => g.stepId === 'enrich' && /fan out|forEach/i.test(g.question)));
});

test('does NOT flag per-item prose when forEach is already set', () => {
  const def = wf({
    steps: [
      { id: 'pull', prompt: 'Pull the list of prospects.' },
      { id: 'enrich', prompt: 'For each prospect, research their firm.', dependsOn: ['pull'], forEach: 'pull' },
    ],
  });
  assert.ok(!analyzeWorkflowGaps(def).some((g) => g.stepId === 'enrich'));
});

test('caps the number of gaps', () => {
  const def = wf({
    description: 'Every morning do this.',
    steps: Array.from({ length: 10 }, (_, i) => ({
      id: `s${i}`,
      prompt: 'Generate a report and send the emails to the list.',
    })),
  });
  assert.ok(analyzeWorkflowGaps(def).length <= 5);
});

test('renderWorkflowGapQuestions: empty for no gaps, formatted otherwise', () => {
  assert.equal(renderWorkflowGapQuestions([]), '');
  const rendered = renderWorkflowGapQuestions([
    { severity: 'clarify', question: 'Q?', why: 'because' },
  ]);
  assert.ok(rendered.includes('Gap test'));
  assert.ok(rendered.includes('Q?'));
});
