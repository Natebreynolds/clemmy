/**
 * Run: npx tsx --test src/execution/workflow-routing-check.test.ts
 *
 * The model-routing validator: silent-intent-no-match + missed-routing-opportunity,
 * plus the cases that must NOT fire (correct tag, pinned model, non-LLM step, no
 * rules). Bindings are passed explicitly so the match decisions are hermetic.
 */
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
process.env.CLEMENTINE_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-routing-'));

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeWorkflowRouting } from './workflow-routing-check.js';
import type { RoleBinding } from '../runtime/harness/model-roles.js';
import type { WorkflowStepInput } from '../memory/workflow-store.js';

const DESIGN_RULE: RoleBinding[] = [
  { role: 'worker', modelId: 'claude-opus-4-8', whenIntent: 'design', scope: 'durable', source: 'chat-rule' },
];
const step = (s: Partial<WorkflowStepInput> & { id: string }): WorkflowStepInput => ({ prompt: '', ...s } as WorkflowStepInput);
const kinds = (steps: WorkflowStepInput[], b = DESIGN_RULE) => analyzeWorkflowRouting({ steps }, b).map((a) => `${a.kind}:${a.stepId}`);

test('silent_intent_no_match: a tag with no matching rule is flagged (acme-audit produce intent:"writing")', () => {
  const a = analyzeWorkflowRouting({ steps: [step({ id: 'produce', prompt: 'compose the brief', intent: 'writing' })] }, DESIGN_RULE);
  assert.equal(a.length, 1);
  assert.equal(a[0].kind, 'silent_intent_no_match');
  assert.equal(a[0].unmatchedIntent, 'writing');
});

test('missed_routing_opportunity: an untagged step that reads like "design" (proposal-audit-brief produce)', () => {
  const a = analyzeWorkflowRouting({ steps: [step({ id: 'produce', prompt: 'Compose and generate the finished audit site — J&T Design System v3' })] }, DESIGN_RULE);
  assert.equal(a.length, 1);
  assert.equal(a[0].kind, 'missed_routing_opportunity');
  assert.equal(a[0].suggestedIntent, 'design');
  assert.equal(a[0].suggestedModel, 'claude-opus-4-8');
});

test('correctly tagged intent:"design" → NO advisory', () => {
  assert.deepEqual(kinds([step({ id: 'produce', prompt: 'generate the design', intent: 'design' })]), []);
});

test('explicit pinned model wins → NO advisory even if it looks like design', () => {
  assert.deepEqual(kinds([step({ id: 'produce', prompt: 'design the hero', model: 'gpt-5.4' })]), []);
});

test('non-LLM steps (deterministic / structured call) never produce an advisory', () => {
  const deterministic = step({ id: 'design-export', prompt: '', deterministic: { runner: 'export.py' } });
  const call = step({ id: 'design-fetch', prompt: '', call: { tool: 'firecrawl_scrape' } } as Partial<WorkflowStepInput> & { id: string });
  assert.deepEqual(kinds([deterministic, call]), []);
});

test('no worker intent rules → empty (nothing to route to)', () => {
  const roleWideOnly: RoleBinding[] = [{ role: 'worker', modelId: 'claude-sonnet-5', scope: 'durable', source: 'settings' }];
  assert.deepEqual(analyzeWorkflowRouting({ steps: [step({ id: 'produce', prompt: 'design it', intent: 'writing' })] }, roleWideOnly), []);
});

test('multi-word category matches only when all words are present', () => {
  const rule: RoleBinding[] = [{ role: 'worker', modelId: 'claude-opus-4-8', whenIntent: 'product-design', scope: 'durable', source: 'chat-rule' }];
  assert.deepEqual(kinds([step({ id: 's', prompt: 'design the product hero' })], rule), ['missed_routing_opportunity:s']);
  assert.deepEqual(kinds([step({ id: 's', prompt: 'design the hero' })], rule), [], 'missing "product" → no match');
});
