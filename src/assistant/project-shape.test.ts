/**
 * Run: npx tsx --test src/assistant/project-shape.test.ts
 *
 * Regression pins for the sess-desktop-387d3dae failure: an ordinary project
 * request classified as complexity `simple` / fastPath `single_action` with
 * `externalEffectRequested=false`, and was then served inside one chat turn
 * until it died on the tool ceiling with no durable checkpoint.
 *
 * These assert SHAPE, never subject matter. Every project case below is from a
 * different domain, and none of the rules mention sales, dashboards, or any
 * product name.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { classifyProjectShape } from './project-shape.js';
import { classifyExternalEffectRequest } from './external-effect-taxonomy.js';
import { compileTurnGraph } from '../runtime/graph/turn-graph-compiler.js';

/** The exact live prompt that regressed. */
const LIVE_PROMPT = 'Can you create an end-of-month sales summary for my team '
  + 'and build a shareable dashboard that we can keep using to track sales trends? '
  + 'Use the data and tools I already have connected, and host it somewhere my team can access.';

const POLICY = {
  version: 'turn-policy-v1',
  autoApproveScope: 'yolo',
  proactiveWorkAllowed: true,
  allowComposioActions: true,
  allowComputerActions: true,
  requireWorkflowApprovalForExecution: true,
  batchConfirmThreshold: 5,
} as never;

function graphFor(input: string) {
  return compileTurnGraph({
    identity: { sessionId: 'sess-project-shape-test', turn: 1, sourceUserSeq: 41 },
    input,
    sessionKind: 'chat',
    surface: 'home',
    policy: POLICY,
  }).graph;
}

test('the exact live prompt compiles as a project with an external hosting effect', () => {
  const shape = classifyProjectShape(LIVE_PROMPT);
  assert.equal(shape.isProject, true, 'the request that broke v3.6.2 must read as a project');
  assert.deepEqual([...shape.signals].sort(), ['construction', 'continuity', 'sourced']);

  // "host it somewhere my team can access" is external effect intent. In
  // v3.6.2 it sat mid-clause after ", and", where no clause-anchored rule could
  // reach it, and there was no publication kind at all.
  const effect = classifyExternalEffectRequest(LIVE_PROMPT);
  assert.equal(effect.requested, true, 'hosting is an external effect');
  assert.ok(effect.kinds.includes('publication'));

  const graph = graphFor(LIVE_PROMPT);
  assert.equal(graph.classification.projectShaped, true);
  assert.equal(graph.classification.externalEffectRequested, true);
  assert.notEqual(graph.fastPath, 'single_action', 'a project is never a single action');
  assert.equal(graph.fastPath, 'project');
  assert.equal(graph.classification.route, 'act');
});

test('domain-neutral paraphrases take the same project route', () => {
  const paraphrases = [
    'Build a marketing website from our brand assets and deploy it.',
    'Set up a research portal from the papers I have collected and share it with the lab.',
    'Create a weekly operations report from our ticket data that runs every Monday.',
    'Put together an onboarding hub using the docs we already have, and host it for new hires.',
    'Assemble a quarterly board pack from our finance records that we can keep reusing.',
  ];
  for (const prompt of paraphrases) {
    const shape = classifyProjectShape(prompt);
    assert.equal(shape.isProject, true, `must be a project: ${prompt}`);
    const graph = graphFor(prompt);
    assert.equal(graph.fastPath, 'project', `must route as project: ${prompt}`);
    assert.notEqual(graph.fastPath, 'single_action');
  }
});

test('small status and read requests keep the fast path', () => {
  const smallReads = [
    "What's my pipeline this month?",
    'Summarize last month sales.',
    'How many deals closed yesterday?',
    'What is the status of the deploy?',
    'Show me today’s meetings.',
  ];
  for (const prompt of smallReads) {
    assert.equal(classifyProjectShape(prompt).isProject, false, `must stay small: ${prompt}`);
    const graph = graphFor(prompt);
    assert.notEqual(graph.fastPath, 'project', `must not become a project: ${prompt}`);
  }
});

test('trivial constructions are not projects', () => {
  // "make a note", "create a list" construct nothing durable and must not
  // acquire a project lane just for containing a construction verb.
  for (const prompt of [
    'Make a note that the demo went well.',
    'Create a list of three ideas.',
    'Generate a title for this doc.',
  ]) {
    assert.equal(classifyProjectShape(prompt).isProject, false, prompt);
  }
});

test('construction alone is a task; construction plus data or continuity is a project', () => {
  // The rule is structural and stated explicitly so it cannot drift into a
  // keyword list: CONSTRUCTION is necessary, and one of SOURCED/CONTINUITY
  // makes it a project.
  const bare = classifyProjectShape('Build a login form component.');
  assert.equal(bare.isProject, false, 'a bounded build with no data and no continuity is a task');

  const sourced = classifyProjectShape('Build a dashboard using my pipeline numbers.');
  assert.equal(sourced.isProject, true);
  assert.ok(sourced.signals.includes('sourced'));

  const continued = classifyProjectShape('Build a status page and keep it updated every week.');
  assert.equal(continued.isProject, true);
  assert.ok(continued.signals.includes('continuity'));
});

test('publication intent is recognised from any clause, not only the first', () => {
  // The v3.6.2 clause splitter treated ", but"/", then" as boundaries but not
  // ", and", so a trailing second imperative was unreachable.
  const trailing = classifyExternalEffectRequest(
    'Use the data I already have connected, and host it somewhere the team can access.',
  );
  assert.equal(trailing.requested, true);

  // A coordinated predicate inside one clause is also reachable for publication
  // verbs specifically, because host/deploy/publish have no local homograph.
  const coordinated = classifyExternalEffectRequest('Build the site and deploy it.');
  assert.equal(coordinated.requested, true);
  assert.ok(coordinated.kinds.includes('publication'));
});

test('publication rules do not fire on local or figurative senses', () => {
  for (const prompt of [
    'What is the host header for that request?',
    'Share your thoughts on the draft.',
    'Explain how deployment pipelines usually work.',
    'Summarize last month sales.',
  ]) {
    assert.equal(
      classifyExternalEffectRequest(prompt).requested,
      false,
      `must not read as an external effect: ${prompt}`,
    );
  }
});
