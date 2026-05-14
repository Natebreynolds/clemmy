/**
 * Run: npx tsx --test src/agents/autonomy-guardrails.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { z } from 'zod';
import type { AgentDecisionSchema } from './autonomy-v2.js';
import {
  commitmentRealismGuardrail,
  followUpRealismGuardrail,
  runGuardrailForTest,
  summarySubstanceGuardrail,
} from './autonomy-guardrails.js';

type Decision = z.infer<typeof AgentDecisionSchema>;

const goodDecision: Decision = {
  summary: 'Notified user about deal A stalling and queued a follow-up task for Friday.',
  commitments: ['Check deal A status Friday 9am.'],
  followUpMinutes: 60,
};

test('summary_substance: passes a substantive summary', async () => {
  const r = await runGuardrailForTest(summarySubstanceGuardrail, goodDecision);
  assert.equal(r.tripwireTriggered, false);
});

test('summary_substance: trips on empty summary', async () => {
  const r = await runGuardrailForTest(summarySubstanceGuardrail, { ...goodDecision, summary: '' });
  assert.equal(r.tripwireTriggered, true);
});

test('summary_substance: trips on placeholder phrases', async () => {
  for (const phrase of ['Did some work.', 'Reviewed inbox.', 'Processed items.']) {
    const r = await runGuardrailForTest(summarySubstanceGuardrail, { ...goodDecision, summary: phrase });
    assert.equal(r.tripwireTriggered, true, `expected trip for "${phrase}"`);
  }
});

test('summary_substance: trips on very short summaries', async () => {
  const r = await runGuardrailForTest(summarySubstanceGuardrail, { ...goodDecision, summary: 'ok done' });
  assert.equal(r.tripwireTriggered, true);
});

test('commitment_realism: passes specific commitments', async () => {
  const r = await runGuardrailForTest(commitmentRealismGuardrail, goodDecision);
  assert.equal(r.tripwireTriggered, false);
});

test('commitment_realism: trips on vague commitments', async () => {
  for (const phrase of ['follow up', 'do stuff', 'check in', 'tbd']) {
    const r = await runGuardrailForTest(commitmentRealismGuardrail, { ...goodDecision, commitments: [phrase] });
    assert.equal(r.tripwireTriggered, true, `expected trip for "${phrase}"`);
  }
});

test('commitment_realism: trips on too many commitments', async () => {
  const many: string[] = [];
  for (let i = 0; i < 8; i++) many.push(`Specific commitment number ${i} for tomorrow.`);
  const r = await runGuardrailForTest(commitmentRealismGuardrail, { ...goodDecision, commitments: many });
  assert.equal(r.tripwireTriggered, true);
});

test('commitment_realism: passes empty commitment list', async () => {
  const r = await runGuardrailForTest(commitmentRealismGuardrail, { ...goodDecision, commitments: [] });
  assert.equal(r.tripwireTriggered, false, 'empty list is allowed');
});

test('followup_realism: passes omitted followUpMinutes', async () => {
  const decision: Decision = { summary: goodDecision.summary, commitments: [] };
  const r = await runGuardrailForTest(followUpRealismGuardrail, decision);
  assert.equal(r.tripwireTriggered, false);
});

test('followup_realism: trips on followUpMinutes < 5', async () => {
  for (const minutes of [0, 1, 4]) {
    const r = await runGuardrailForTest(followUpRealismGuardrail, { ...goodDecision, followUpMinutes: minutes });
    assert.equal(r.tripwireTriggered, true, `expected trip for ${minutes} minutes`);
  }
});

test('followup_realism: passes reasonable followUpMinutes', async () => {
  for (const minutes of [5, 30, 60, 720, 1440]) {
    const r = await runGuardrailForTest(followUpRealismGuardrail, { ...goodDecision, followUpMinutes: minutes });
    assert.equal(r.tripwireTriggered, false, `${minutes} minutes should pass`);
  }
});
