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

test('P1-9 flags a list-pulling step with a consumer and no emptiness contract', () => {
  const def = wf({
    steps: [
      { id: 'pull', prompt: 'Query Salesforce for new prospects since yesterday.' },
      { id: 'write', prompt: 'Add them to Airtable.', dependsOn: ['pull'] },
    ],
  });
  const gaps = analyzeWorkflowGaps(def);
  assert.ok(gaps.some((g) => g.stepId === 'pull' && /ZERO items|empty/i.test(g.question)));
});

test('P1-9 does NOT flag empty when the step declares a non_empty contract', () => {
  const def = wf({
    steps: [
      {
        id: 'pull',
        prompt: 'Query Salesforce for new prospects since yesterday.',
        output: { non_empty: ['prospects'] },
      },
      { id: 'write', prompt: 'Add them to Airtable.', dependsOn: ['pull'] },
    ],
  });
  assert.ok(!analyzeWorkflowGaps(def).some((g) => g.stepId === 'pull' && /ZERO items/i.test(g.question)));
});

test('P1-9 does NOT flag empty when min_items is declared', () => {
  const def = wf({
    steps: [
      {
        id: 'pull',
        prompt: 'Fetch the list of leads from the CRM.',
        output: { min_items: { leads: 1 } },
      },
      { id: 'write', prompt: 'Process them.', dependsOn: ['pull'] },
    ],
  });
  assert.ok(!analyzeWorkflowGaps(def).some((g) => g.stepId === 'pull' && /ZERO items/i.test(g.question)));
});

test('P1-9 does NOT flag a list-pull with no downstream consumer', () => {
  const def = wf({
    steps: [
      { id: 'pull', prompt: 'Query Salesforce for new prospects since yesterday.' },
    ],
  });
  assert.ok(!analyzeWorkflowGaps(def).some((g) => g.stepId === 'pull' && /ZERO items/i.test(g.question)));
});

test('flags reference-backed HTML producer with no durable renderer or reference asset', () => {
  const def = wf({
    description_body: 'Use https://amador.example/proposal as the quality bar and reference design.',
    steps: [
      {
        id: 'produce',
        prompt: 'Build a single-file HTML audit site modeled after the reference page and write index.html.',
        output: { type: 'object', verify: { path_exists: ['file_path'] } },
      },
    ],
  });
  const gaps = analyzeWorkflowGaps(def);
  assert.ok(gaps.some((g) => g.stepId === 'produce' && /reference design/i.test(g.question)));
});

test('does NOT flag reference-backed HTML producer when deterministic renderer is declared', () => {
  const def = wf({
    steps: [
      {
        id: 'produce',
        prompt: 'Build a single-file HTML audit site modeled after the reference page.',
        deterministic: { runner: 'scripts/render-audit.mjs' },
        output: { type: 'object', verify: { path_exists: ['file_path'] } },
      },
    ],
  });
  assert.ok(!analyzeWorkflowGaps(def).some((g) => g.stepId === 'produce' && /reference design/i.test(g.question)));
});

test('does NOT flag reference-backed HTML producer when workflow-local references are explicit', () => {
  const def = wf({
    description_body: 'Reference HTML is stored in references/amador.html.',
    steps: [
      {
        id: 'produce',
        prompt: 'Build a proposal page based on the reference HTML in references/amador.html.',
        output: { type: 'object', verify: { path_exists: ['file_path'] } },
      },
    ],
  });
  assert.ok(!analyzeWorkflowGaps(def).some((g) => g.stepId === 'produce' && /reference design/i.test(g.question)));
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
