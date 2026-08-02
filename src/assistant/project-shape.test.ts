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
import { classifyMessageIntent } from './message-intent.js';
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

function shapeFor(input: string) {
  return classifyProjectShape(input, classifyMessageIntent(input));
}

test('the exact live prompt compiles as a project with an external hosting effect', () => {
  const shape = shapeFor(LIVE_PROMPT);
  assert.equal(shape.isProject, true, 'the request that broke v3.6.2 must read as a project');
  assert.deepEqual([...shape.signals].sort(), ['compound', 'construction', 'continuity', 'durable_artifact', 'sourced']);

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
    'Assemble a knowledge base from our support records that we can keep reusing.',
  ];
  for (const prompt of paraphrases) {
    const shape = shapeFor(prompt);
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
    assert.equal(shapeFor(prompt).isProject, false, `must stay small: ${prompt}`);
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
    assert.equal(shapeFor(prompt).isProject, false, prompt);
  }
});

test('bounded builds stay inline while durable artifacts and standing operations become candidates', () => {
  // This classifier is an early candidate hint, not the authoritative topology
  // decision. The planner/runtime checkpoint remains responsible for promoting
  // unfamiliar long work that the small artifact vocabulary does not know.
  const bare = shapeFor('Build a login form component.');
  assert.equal(bare.isProject, false, 'a bounded build with no data and no continuity is a task');

  const sourced = shapeFor('Build a dashboard using my pipeline numbers.');
  assert.equal(sourced.isProject, true);
  assert.ok(sourced.signals.includes('sourced'));

  const continued = shapeFor('Build a status page and keep it updated every week.');
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

  // A plain coordinated predicate is intentionally NOT split here. Losing the
  // outer clause's advisory/negation scope is more dangerous than missing an
  // early hint; the actual deploy tool remains classified at its boundary.
  const coordinated = classifyExternalEffectRequest('Build the site and deploy it.');
  assert.equal(coordinated.requested, false);
});

test('publication rules do not fire on local or figurative senses', () => {
  for (const prompt of [
    'What is the host header for that request?',
    'Share your thoughts on the draft.',
    'Explain how deployment pipelines usually work.',
    'Explain build and deploy strategies.',
    'What is the build and deploy status?',
    'Compare build and deploy options.',
    'Make this available locally.',
    'Make this available offline.',
    'Deploy it to localhost.',
    'Publish it to a local preview.',
    'Host it on localhost.',
    'Put the server live locally.',
    'Make this method public.',
    'Make it accessible to screen readers.',
    'Make it available on disk.',
    'Summarize last month sales.',
  ]) {
    assert.equal(
      classifyExternalEffectRequest(prompt).requested,
      false,
      `must not read as an external effect: ${prompt}`,
    );
  }
});

test('shape cannot upgrade advice, status, or comparison requests into actions', () => {
  const informational = [
    'Explain build and deploy strategies.',
    'Explain how to build and deploy the site.',
    'How do I build and deploy a web app?',
    'Should we build and deploy the site?',
    'Research how teams build and host a service.',
    'Did we build the dashboard?',
    'I wonder whether we should build an app.',
    'What is the build and deploy status?',
    'Compare build and deploy options.',
  ];
  for (const prompt of informational) {
    const graph = graphFor(prompt);
    assert.notEqual(graph.classification.messageIntent, 'action', prompt);
    assert.notEqual(graph.classification.route, 'act', prompt);
    assert.equal(graph.classification.projectShaped, false, prompt);
    assert.equal(graph.classification.externalEffectRequested, false, prompt);
  }

  // Prohibitions and declarative mentions retain the legacy conservative
  // tool_intent route, but cannot acquire the project envelope or an external
  // effect. The runtime must hear the constraint; it must not execute it.
  for (const prompt of [
    'Do not build and deploy the site.',
    'The plan is to build an app.',
  ]) {
    const graph = graphFor(prompt);
    assert.notEqual(graph.classification.messageIntent, 'action', prompt);
    assert.equal(graph.classification.projectShaped, false, prompt);
    assert.equal(graph.classification.externalEffectRequested, false, prompt);
  }

  // This is a real action, but its direct object is a bounded plan. Merely
  // mentioning a web app in the plan's subject must not make the plan itself a
  // durable build or pre-arm a deployment effect.
  const plan = graphFor('Create a plan explaining how to build and deploy a web app.');
  assert.equal(plan.classification.messageIntent, 'action');
  assert.equal(plan.classification.projectShaped, false);
  assert.equal(plan.classification.externalEffectRequested, false);
});

test('obvious durable builds route as projects while small sourced transforms stay bounded', () => {
  for (const prompt of [
    'Build me a web app.',
    'Create a shareable dashboard for my team.',
    'Implement OAuth + an admin console.',
    'Build a dashboard from Salesforce.',
    'Prepare a client portal.',
    'Redesign our website.',
    'Write a book.',
    'Migrate our CRM.',
    'Generate a report every Monday.',
    'Monitor uptime and alert me when it fails.',
    'Automate the report so it runs every week.',
  ]) {
    assert.equal(graphFor(prompt).fastPath, 'project', prompt);
  }

  for (const prompt of [
    'Create a chart from my data.',
    'Create a CSV from my report.',
    'Create a quick summary from my data.',
    'Write a summary about our dashboard.',
    'Create a chart of app usage from our data.',
    'Make the dashboard blue.',
    'Build a site header.',
    'Build an API endpoint.',
    'Create a reusable checklist.',
    'Create a monthly report.',
    'Create a chart tracking trends.',
    'Create a database table.',
    'Create a CSV from my data, then sort it.',
  ]) {
    assert.notEqual(graphFor(prompt).fastPath, 'project', prompt);
  }
});
