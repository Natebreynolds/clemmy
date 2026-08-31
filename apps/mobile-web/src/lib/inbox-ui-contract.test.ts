import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (relative: string): string => readFileSync(new URL(relative, import.meta.url), 'utf8');

test('Inbox never publishes an unknown zero or claims caught-up from a partial snapshot', () => {
  const source = read('../screens/Inbox.tsx');
  assert.match(source, /if \(data\?\.needsCountKnown\) onCount\(needsCount\)/);
  assert.doesNotMatch(source, /onCount\(0\)/);
  assert.match(source, /data\?\.needsCountKnown && needsCount === 0/);
  assert.match(source, /mergeInboxLastGood/);
});

test('question decisions are one-shot, answerability-gated, and receipt the exact answer', () => {
  const source = read('../screens/Inbox.tsx');
  assert.match(source, /if \(!question\.answerable \|\| !text \|\| actionLock\.current\) return/);
  assert.match(source, /actionLock\.current = true/);
  assert.match(source, /disabled=\{busy \|\| !question\.answerable\}/);
  assert.match(source, /title: 'Answer sent', text: `“\$\{text\}”`/);
  assert.match(source, /title: 'Already handled'/);
  assert.match(source, /Your answer was not sent again/);
});

test('plan clarification opens only its exact serialized conversation', () => {
  const cards = read('../components/Approvals.tsx');
  const api = read('./api.ts');
  assert.match(api, /sessionId: string \| null/);
  assert.match(cards, /needsInput && onReply && row\.sessionId/);
  assert.match(cards, /onReply\(row\.sessionId!?, `About the plan/);
  assert.doesNotMatch(cards, /onReply\('', `About the plan/);
  assert.match(cards, /This plan has no safe linked conversation on the phone yet/);
});

test('approve, reject, and conflict receipts stay action-specific without overclaiming', () => {
  const cards = read('../components/Approvals.tsx');
  assert.match(cards, /Plan approved and queued\. Clem will continue it in the original conversation\./);
  assert.match(cards, /Plan rejected\. Clem will not start it\./);
  assert.match(cards, /Rejected\. Clem will not perform that action\./);
  assert.match(cards, /The approval could not be applied from this card\. I refreshed its current status\./);
  assert.match(cards, /The rejection could not be applied from this card\. I refreshed its current status\./);
  assert.match(cards, /if \(actionLock\.current\) return/);
});

test('workflow capability cards expose exact choices and truthful recovery actions', () => {
  const source = read('../screens/Inbox.tsx');
  const api = read('./api.ts');
  assert.match(source, /WorkflowCapabilityCard/);
  assert.match(source, /account \{candidate\.accountId\}/);
  assert.match(source, /capability \{candidate\.capabilityId\}/);
  assert.match(source, /if \(actionLock\.current \|\| gate\.resolution\.kind === 'review_run'\) return/);
  assert.match(source, /I connected it on my Mac — resume/);
  assert.match(source, /Retry exact metadata now/);
  assert.match(source, /Review preserved run/);
  assert.match(api, /choiceSetDigest: gate\.resolution\.choiceSetDigest/);
});
