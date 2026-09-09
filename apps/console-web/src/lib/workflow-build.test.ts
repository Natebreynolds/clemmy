import { test } from 'node:test';
import assert from 'node:assert/strict';
import { authoringRowLabel, workflowBuildFromMessages, workflowDraftFromArgs } from './workflow-build.js';
import type { ChatMessage } from './useChat.js';

const args = {
  name: 'Friday pipeline digest',
  description: 'Every Friday, summarize the pipeline and email it to me.',
  trigger_schedule: '0 7 * * 5',
  steps: [
    { id: 'collect', prompt: 'Pull open opportunities from Salesforce\nwith owner = me', sideEffect: 'read', call: { tool: 'salesforce_query', args: {} } },
    { id: 'digest', prompt: 'Write the digest', dependsOn: ['collect'] },
    { id: 'send', prompt: 'Email the digest to me', sideEffect: 'send', requiresApproval: true, dependsOn: ['digest'] },
  ],
  goal: { objective: 'A digest in my inbox by 7:30 every Friday' },
};

test('the authoring call’s arguments are the draft: name, schedule, steps with effects and gates', () => {
  const d = workflowDraftFromArgs('workflow_create', args);
  assert.ok(d);
  assert.equal(d.name, 'Friday pipeline digest');
  assert.equal(d.schedule, '0 7 * * 5');
  assert.equal(d.goal, 'A digest in my inbox by 7:30 every Friday');
  assert.deepEqual(d.steps.map((s) => [s.id, s.effect, s.gated, s.tool ?? '', s.dependsOn]), [
    ['collect', 'read', false, 'salesforce_query', []],
    ['digest', 'unknown', false, '', ['collect']],
    ['send', 'send', true, '', ['digest']],
  ]);
  assert.equal(d.steps[0].purpose, 'Pull open opportunities from Salesforce', 'first line only');
});

test('string-encoded arguments parse; non-authoring tools and empty calls are not drafts', () => {
  assert.ok(workflowDraftFromArgs('workflow_update', JSON.stringify(args)));
  assert.equal(workflowDraftFromArgs('web_search', args), null);
  assert.equal(workflowDraftFromArgs('workflow_create', {}), null);
  assert.equal(workflowDraftFromArgs('workflow_create', 'not json'), null);
});

test('the build state follows the model’s own call: drafting → writing → written → testing', () => {
  const draft = workflowDraftFromArgs('workflow_create', args)!;
  const msg = (over: Partial<ChatMessage>): ChatMessage => ({ id: 'a', role: 'assistant', text: '', status: 'complete', ...over } as ChatMessage);
  assert.equal(workflowBuildFromMessages([msg({ status: 'thinking', activity: [] })]).state, 'drafting');
  const writing = workflowBuildFromMessages([msg({ status: 'thinking', activity: [{ id: 't-1', kind: 'tool', label: 'Create workflow', status: 'running', draft }] })]);
  assert.equal(writing.state, 'writing');
  assert.equal(writing.draft?.name, 'Friday pipeline digest');
  const written = workflowBuildFromMessages([msg({ activity: [{ id: 't-1', kind: 'tool', label: 'Create workflow', status: 'done', draft }] })]);
  assert.equal(written.state, 'written');
  assert.equal(written.writtenName, 'Friday pipeline digest');
  const testing = workflowBuildFromMessages([msg({ status: 'thinking', activity: [
    { id: 't-1', kind: 'tool', label: 'Create workflow', status: 'done', draft },
    { id: 'step-collect', kind: 'event', variant: 'lifecycle', label: 'collect', status: 'running' },
  ] })]);
  assert.equal(testing.state, 'testing');
  const failed = workflowBuildFromMessages([msg({ activity: [{ id: 't-1', kind: 'tool', label: 'Create workflow', status: 'failed', draft }] })]);
  assert.equal(failed.state, 'failed');
});

test('the authoring row reads as writing the named workflow', () => {
  const draft = workflowDraftFromArgs('workflow_create', args)!;
  assert.equal(authoringRowLabel({ label: 'Create workflow', draft }), 'Writing “Friday pipeline digest” · 3 steps');
  assert.equal(authoringRowLabel({ label: 'Create workflow' }), 'Create workflow');
});
