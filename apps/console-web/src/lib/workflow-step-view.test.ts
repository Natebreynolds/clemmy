import { test } from 'node:test';
import assert from 'node:assert/strict';
import { choosePositions, type CanvasGraph } from './workflow-canvas.js';
import {
  askAboutStepPrompt,
  dependentsOf,
  describeStepRun,
  draftChanged,
  firstSentence,
  shortModelName,
  stepDraftFrom,
  stepFlags,
  stepPatchFromDraft,
  workflowShape,
} from './workflow-step-view.js';

const graph: CanvasGraph = {
  nodes: [
    { id: 'pull', label: 'Pull posts', dependsOn: [], meta: { sideEffect: 'read', executor: 'call', callTool: 'BLOG_LIST' } },
    { id: 'caption', label: 'Write captions', dependsOn: ['pull'], meta: { sideEffect: 'unknown', executor: 'model', model: 'claude-sonnet-5', forEach: 'pull' } },
    { id: 'review', label: 'Show me', dependsOn: ['caption'], flags: { approval: true }, meta: { sideEffect: 'unknown', executor: 'model' } },
    { id: 'post', label: 'Schedule', dependsOn: ['review'], meta: { sideEffect: 'send', executor: 'skill' }, flags: { skill: 'social-post' } },
  ],
  edges: [],
};

test('a step says what runs it, in words a person uses', () => {
  assert.deepEqual(describeStepRun(graph.nodes[0]), { kind: 'call', label: 'Direct call · BLOG_LIST' });
  assert.deepEqual(describeStepRun(graph.nodes[1]), { kind: 'model', label: 'AI · Sonnet' });
  assert.deepEqual(describeStepRun(graph.nodes[3]), { kind: 'skill', label: 'Skill · social-post' });
  assert.deepEqual(describeStepRun({ id: 'x', meta: { executor: 'deterministic', runner: 'dedupe.py' } }), { kind: 'script', label: 'Script · dedupe.py' });
  // A model pinned on the stored step counts when the graph carries none.
  assert.equal(describeStepRun({ id: 'x', meta: { executor: 'model' } }, { id: 'x', model: 'gpt-5.4' }).label, 'AI · GPT-5.4');
  assert.equal(describeStepRun({ id: 'x' }).label, 'AI · default model');
});

test('model names read the way they are said, and an unknown id is left alone', () => {
  assert.equal(shortModelName('claude-opus-5-5'), 'Opus');
  assert.equal(shortModelName('gpt-5.4'), 'GPT-5.4');
  assert.equal(shortModelName('glm-5.2'), 'glm-5.2');
  assert.equal(shortModelName(null), 'default model');
});

test('flags come from the graph first and the stored step second', () => {
  assert.deepEqual(stepFlags(graph.nodes[2]), { asksFirst: true, keepGoing: false, perItem: null, newItemsOnly: false });
  assert.deepEqual(stepFlags(graph.nodes[1], { id: 'caption', optional: true, forEachNewOnly: true }), {
    asksFirst: false, keepGoing: true, perItem: 'pull', newItemsOnly: true,
  });
  // requiresApproval on the stored step alone still reads as asking first.
  assert.equal(stepFlags({ id: 'x' }, { id: 'x', requiresApproval: true }).asksFirst, true);
});

test('dependents are the steps that wait on this one', () => {
  assert.deepEqual(dependentsOf(graph, 'pull'), ['caption']);
  assert.deepEqual(dependentsOf(graph, 'post'), []);
});

test('the one-line summary is the first sentence, tidied', () => {
  assert.equal(firstSentence('Pull the week\'s posts.\n\nThen sort them by date.'), 'Pull the week\'s posts.');
  assert.equal(firstSentence('   '), '');
  assert.equal(firstSentence('x'.repeat(200)).length, 160);
});

test('asking about a step opens with the workflow and the step, then stops', () => {
  assert.equal(askAboutStepPrompt('Weekly posts', 'review'), 'About the "review" step of my "Weekly posts" workflow: ');
});

test('the workflow shape counts effects and approvals from the graph', () => {
  assert.deepEqual(workflowShape(graph), { steps: 4, reads: 1, writes: 0, sends: 1, approvals: 1 });
});

test('shared placement wins, the browser copy is the fallback, and nothing is shared by reference', () => {
  const shared = { a: { x: 1, y: 2 } };
  const local = { a: { x: 9, y: 9 }, b: { x: 3, y: 4 } };
  assert.deepEqual(choosePositions(shared, local), { a: { x: 1, y: 2 } });
  assert.deepEqual(choosePositions({}, local), local);
  assert.deepEqual(choosePositions(null, local), local);
  assert.deepEqual(choosePositions(undefined, undefined), {});
  const chosen = choosePositions(shared, null);
  chosen.a = { x: 0, y: 0 };
  assert.equal(shared.a.x, 1);
});

test('a draft starts from the stored step, and only what changed is sent', () => {
  const base = stepDraftFrom(graph.nodes[1], { id: 'caption', prompt: 'Write a caption for each post.', forEach: 'pull' });
  assert.deepEqual(base, { prompt: 'Write a caption for each post.', asksFirst: false, keepGoing: false, perItem: 'pull' });
  assert.equal(draftChanged(base, { ...base }), false);
  assert.equal(draftChanged(base, { ...base, prompt: 'Write a caption for each post. ' }), false, 'whitespace is not a change');

  const draft = { prompt: 'Write a short caption for each post.', asksFirst: true, keepGoing: true, perItem: '' };
  assert.equal(draftChanged(base, draft), true);
  assert.deepEqual(stepPatchFromDraft(base, draft), {
    prompt: 'Write a short caption for each post.',
    requiresApproval: true,
    optional: true,
    forEach: null,
  });
  // Turning flags off removes them; turning per-item on names the source.
  assert.deepEqual(stepPatchFromDraft({ ...base, asksFirst: true, keepGoing: true, perItem: '' }, { ...base, asksFirst: false, keepGoing: false, perItem: 'pull' }), {
    requiresApproval: null,
    optional: null,
    forEach: 'pull',
  });
  assert.deepEqual(stepPatchFromDraft(base, base), {});
});
