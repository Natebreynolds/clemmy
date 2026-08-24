/** Run: npx tsx --test src/runtime/graph/accepted-goal.test.ts */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertAuthorityConsistency,
  clarificationBlockedByGoal,
  compileAcceptedGoal,
  destinationsOf,
  projectionRolesFromText,
} from './accepted-goal.js';
import { detectMultiItemIntent } from '../harness/multi-item-intent.js';
import { compileTurnGraph, type CompileTurnGraphInput } from './turn-graph-compiler.js';
import { compileDeterministicExpectedWorkProposal } from '../harness/expected-work-contract.js';
import { classifyTurnPreflight } from '../harness/turn-control.js';
import { evaluateGoalEvidence } from './goal-evidence.js';
import {
  fallbackProposedGraph,
  proposeTurnGraphFromGoal,
  validateProposedGraph,
} from './turn-graph-proposal.js';
import type { TurnGraphIR, TurnGraphPolicySnapshot } from './turn-graph-ir.js';

const POLICY: TurnGraphPolicySnapshot = {
  version: 'turn-policy-v1',
  autoApproveScope: 'yolo',
  proactiveWorkAllowed: true,
  allowComposioActions: true,
  allowComputerActions: true,
  requireWorkflowApprovalForExecution: true,
  batchConfirmThreshold: 5,
};

const SEQ_54846 =
  'Find the official blog for stripe.com, grab the last 5 blog post, and put the title, date, and link on a new Google Sheet for me. Paste the link here when it’s done.';
const PISMO_COLLECTION_TO_SHEET =
  'Find me the top 5 restaurants in Pismo Beach CA based on Google reviews, give me the review count and phone number for each, and create a new Google Sheet.';
const PISMO_ROW_ECHO =
  'Find the top 5 restaurants in Pismo Beach by Google review count. Include each restaurant name, review count, and phone number, then create one new Google Sheet containing those 5 rows. Do not email or share it.';
const LIVE_ALL_TO_SHEET =
  'Find me 25 personal injury lawyers. The best decision market contact info including name email and phone number. Scrape the websites give me a rundown of them as a firm and then lastly run a small SEO audit and put it all in a google sheet';

function compile(input: string, sourceUserSeq = 41) {
  return compileTurnGraph({
    identity: { sessionId: 'goal-test', turn: 1, sourceUserSeq },
    input,
    sessionKind: 'chat',
    surface: 'home',
    policy: POLICY,
  } satisfies CompileTurnGraphInput);
}

function paraphrase(input: {
  host: string;
  count: number;
  fields: string;
  dest: string;
}): string {
  return `Find the official index for ${input.host}, grab the last ${input.count} entries, and put the ${input.fields} on a new ${input.dest} for me. Paste the link here when it is done.`;
}

test('seq 54846 and paraphrases share one construct goal', () => {
  for (const text of [
    SEQ_54846,
    paraphrase({ host: 'example.com', count: 5, fields: 'title, date, and link', dest: 'workbook' }),
    paraphrase({ host: 'docs.example.org', count: 8, fields: 'name, rating, and address', dest: 'spreadsheet' }),
  ]) {
    const goal = compileAcceptedGoal({
      text,
      sourceUserSeq: 41,
      multiItem: detectMultiItemIntent(text),
    });
    assert.equal(goal.construct, 'collect_then_construct', text);
    assert.equal(goal.route, 'act', text);
    assert.equal(goal.effectCeiling, 'external_write', text);
    assert.ok((goal.collection?.count ?? 0) >= 3, text);
    assert.ok(goal.destination?.handleRequired, text);
    const compiled = compile(text);
    assert.equal(compiled.graph.classification.route, 'act', text);
    assert.equal(compiled.graph.effectCeiling, 'external_write', text);
    assert.equal(compiled.graph.classification.multiItem.collectThenConstruct, true, text);
    assert.equal(compiled.graph.nodes.filter((node) => node.kind === 'retrieve').length, 1, text);
    assert.equal(compiled.graph.nodes.some((node) => node.kind === 'fanout'), false, text);
    assert.ok(compiled.graph.nodes.some((node) => node.kind === 'execute'), text);
    const contract = compileDeterministicExpectedWorkProposal(compiled.graph);
    assert.ok(contract, text);
    assert.ok(contract.operations.some((operation) => operation.effect === 'external_write'), text);
    const consistent = assertAuthorityConsistency({ graph: compiled.graph, contract });
    assert.equal(consistent.ok, true, consistent.ok ? text : consistent.reason);
  }
});

test('a per-member field projection still compiles as one collect-then-construct goal', () => {
  const multiItem = detectMultiItemIntent(PISMO_COLLECTION_TO_SHEET);
  assert.equal(multiItem.isMultiItem, false, 'the five rows are not five destination writes');
  assert.equal(multiItem.collectThenConstruct, true);
  assert.equal(multiItem.itemCount, 5);

  const goal = compileAcceptedGoal({
    text: PISMO_COLLECTION_TO_SHEET,
    sourceUserSeq: 68054,
    multiItem,
  });
  assert.equal(goal.construct, 'collect_then_construct');
  assert.equal(goal.route, 'act');
  assert.equal(goal.effectCeiling, 'external_write');
  assert.equal(goal.collection?.count, 5);
  assert.deepEqual(goal.collection?.projection, ['review count', 'phone number']);
  assert.deepEqual(goal.destination, {
    posture: 'create_new',
    family: 'workbook',
    handleRequired: false,
  });
});

test('a leading per-member field list preserves every requested source projection', () => {
  const multiItem = detectMultiItemIntent(PISMO_ROW_ECHO);
  assert.equal(multiItem.isMultiItem, false, 'the destination row count is not a fanout request');
  assert.equal(multiItem.collectThenConstruct, true);
  assert.equal(multiItem.itemCount, 5);

  const goal = compileAcceptedGoal({
    text: PISMO_ROW_ECHO,
    sourceUserSeq: 68487,
    multiItem,
  });
  assert.equal(goal.construct, 'collect_then_construct');
  assert.deepEqual(goal.collection, {
    count: 5,
    projection: ['name', 'review count', 'phone number'],
    completeness: 'count',
  });
  assert.deepEqual(goal.destination, {
    posture: 'create_new',
    family: 'workbook',
    handleRequired: false,
  });
});

test('source-call parameter reuse cannot drift a create-new destination to named-existing', () => {
  const continuationTask = [
    PISMO_ROW_ECHO,
    '[assistant-question] Use the equivalent source call with the same parameters, then bundle that single pull into one new Google Sheet?',
    '[user-answer] Use Apify as the restaurant source.',
  ].join('\n');
  const goal = compileAcceptedGoal({
    text: continuationTask,
    sourceUserSeq: 69102,
    multiItem: detectMultiItemIntent(continuationTask),
  });
  assert.equal(goal.destination?.posture, 'create_new');

  const existing = 'Find the top 5 restaurants and put them into the same Google Sheet.';
  assert.equal(compileAcceptedGoal({
    text: existing,
    sourceUserSeq: 69103,
    multiItem: detectMultiItemIntent(existing),
  }).destination?.posture, 'named_existing');
});

test('anaphoric "it all" / "all of it" preserves the counted set into one container', () => {
  for (const text of [
    LIVE_ALL_TO_SHEET,
    'Find 12 renewal accounts, audit them, and put all of it into one workbook.',
  ]) {
    const multiItem = detectMultiItemIntent(text);
    assert.equal(multiItem.itemCount, text === LIVE_ALL_TO_SHEET ? 25 : 12, text);
    assert.equal(multiItem.isMultiItem, false, text);
    assert.equal(multiItem.collectThenConstruct, true, text);
  }

  const compiled = compile(LIVE_ALL_TO_SHEET, 57579);
  assert.equal(compiled.validation.ok, true, compiled.validation.errors.join('\n'));
  assert.equal(compiled.graph.classification.goalConstraints?.collection?.count, 25);
  assert.equal(compiled.graph.classification.multiItem.collectThenConstruct, true);
  assert.equal(compiled.graph.nodes.filter((node) => node.kind === 'retrieve').length, 1);
  assert.equal(compiled.graph.nodes.filter((node) => node.kind === 'execute').length, 1);
  assert.equal(compiled.graph.nodes.some((node) => node.kind === 'fanout'), false);
});

test('later delivery does not erase the bounded source collection', () => {
  const text = 'Find the top 5 restaurants, put them in a new Google Sheet, then email me the link.';
  const multiItem = detectMultiItemIntent(text);
  assert.equal(multiItem.itemCount, 5);
  assert.equal(multiItem.isMultiItem, false);
  assert.equal(multiItem.collectThenConstruct, true);

  const compiled = compile(text, 57580);
  assert.equal(compiled.validation.ok, true, compiled.validation.errors.join('\n'));
  assert.equal(compiled.graph.classification.goalConstraints?.collection?.count, 5);
  assert.equal(compiled.graph.classification.multiItem.collectThenConstruct, true);
  assert.equal(compiled.graph.nodes.filter((node) => node.kind === 'retrieve').length, 1);
  assert.equal(compiled.graph.nodes.some((node) => node.kind === 'fanout'), false);
});

test('a second-turn construct still compiles act + write', () => {
  const compiled = compile(SEQ_54846, 99);
  assert.equal(compiled.graph.identity.sourceUserSeq, 99);
  assert.equal(compiled.graph.classification.route, 'act');
  assert.equal(compiled.graph.effectCeiling, 'external_write');
});

test('observation-only calendar stays retrieve', () => {
  const compiled = compile('whats on my calendar next monday');
  assert.equal(compiled.graph.classification.route, 'retrieve');
  assert.equal(compiled.graph.effectCeiling, 'read');
});

test('preflight and graph agree on the construct write ceiling', () => {
  const text = paraphrase({ host: 'example.com', count: 5, fields: 'title, date, and link', dest: 'workbook' });
  const compiled = compile(text);
  const preflight = classifyTurnPreflight({
    message: text,
    sessionId: 'goal-test',
    sessionKind: 'chat',
    sourceUserSeq: 41,
  });
  assert.equal(preflight.phase, 'align');
  assert.equal(preflight.reason, 'collect_then_construct');
  assert.ok(preflight.allowedMutationEffects?.includes('external_write'));
  assert.equal(
    assertAuthorityConsistency({
      graph: compiled.graph,
      contract: compileDeterministicExpectedWorkProposal(compiled.graph),
      preflight,
    }).ok,
    true,
  );
});

test('consistency refuses a retrieve graph with write preflight', () => {
  const compiled = compile('whats on my calendar next monday');
  const result = assertAuthorityConsistency({
    graph: compiled.graph,
    preflight: { allowedMutationEffects: ['external_write'] },
  });
  assert.equal(result.ok, false);
});

test('one record cannot satisfy a requested count of five', () => {
  const compiled = compile(paraphrase({
    host: 'example.com', count: 5, fields: 'title, date, and link', dest: 'workbook',
  }));
  const verdict = evaluateGoalEvidence({
    graph: compiled.graph,
    observation: {
      collectedCount: 1,
      projectionPresent: ['title', 'date', 'link'],
      createdArtifactId: 'art-1',
      readbackVerified: true,
      readbackContent: { id: 'art-1' },
      artifactHandle: 'https://example.invalid/sheet',
    },
  });
  assert.equal(verdict.status, 'incomplete');
  if (verdict.status === 'incomplete') {
    assert.match(verdict.reason, /5 members/);
  }
});

test('missing required projection cannot satisfy the goal', () => {
  const compiled = compile(paraphrase({
    host: 'example.com', count: 5, fields: 'title, date, and link', dest: 'workbook',
  }));
  const verdict = evaluateGoalEvidence({
    graph: compiled.graph,
    observation: {
      collectedCount: 5,
      projectionPresent: ['title', 'link'],
      createdArtifactId: 'art-1',
      readbackVerified: true,
      readbackContent: { id: 'art-1' },
      artifactHandle: 'https://example.invalid/sheet',
    },
  });
  assert.equal(verdict.status, 'incomplete');
  if (verdict.status === 'incomplete') {
    assert.match(verdict.reason, /date/);
    assert.equal(verdict.repair, 'rebind-schema');
  }
});

test('create without exact-id readback cannot pass', () => {
  const compiled = compile(paraphrase({
    host: 'example.com', count: 5, fields: 'title, date, and link', dest: 'workbook',
  }));
  const verdict = evaluateGoalEvidence({
    graph: compiled.graph,
    observation: {
      collectedCount: 5,
      projectionPresent: ['title', 'date', 'link'],
      createdArtifactId: 'art-1',
      readbackVerified: false,
    },
  });
  assert.equal(verdict.status, 'incomplete');
});

test('tool_returned without a physical receipt cannot satisfy a construct', () => {
  const compiled = compile(paraphrase({
    host: 'example.com', count: 5, fields: 'title, date, and link', dest: 'workbook',
  }));
  const verdict = evaluateGoalEvidence({
    graph: compiled.graph,
    observation: {
      toolReturned: true,
      collectedCount: 5,
      projectionPresent: ['title', 'date', 'link'],
    },
  });
  assert.equal(verdict.status, 'incomplete');
});

test('a qualitative judge cannot fail-open an action graph', () => {
  const compiled = compile(paraphrase({
    host: 'example.com', count: 5, fields: 'title, date, and link', dest: 'workbook',
  }));
  const verdict = evaluateGoalEvidence({
    graph: compiled.graph,
    observation: {
      collectedCount: 5,
      projectionPresent: ['title', 'date', 'link'],
      createdArtifactId: 'art-1',
      readbackVerified: true,
      readbackContent: { id: 'art-1' },
      artifactHandle: 'https://example.invalid/sheet',
    },
    qualitative: { status: 'blocked', reason: 'destination not verified by the judge' },
  });
  assert.equal(verdict.status, 'incomplete');
});

test('complete evidence includes the verified handle', () => {
  const compiled = compile(paraphrase({
    host: 'example.com', count: 5, fields: 'title, date, and link', dest: 'workbook',
  }));
  const verdict = evaluateGoalEvidence({
    graph: compiled.graph,
    observation: {
      collectedCount: 5,
      projectionPresent: ['title', 'date', 'link'],
      createdArtifactId: 'art-1',
      readbackVerified: true,
      readbackContent: { id: 'art-1' },
      artifactHandle: 'https://example.invalid/sheet',
    },
  });
  assert.equal(verdict.status, 'done');
});

test('a source locator without the collection admits a second read', () => {
  const compiled = compile(paraphrase({
    host: 'example.com', count: 5, fields: 'title, date, and link', dest: 'workbook',
  }));
  const verdict = evaluateGoalEvidence({
    graph: compiled.graph,
    observation: { sourceLocated: true, collectedCount: 0 },
  });
  assert.equal(verdict.status, 'incomplete');
  if (verdict.status === 'incomplete') {
    assert.equal(verdict.repair, 'add-read-node');
  }
});

test('planner fallback topology is legal for a counted construct', () => {
  const plannerText = paraphrase({ host: 'example.com', count: 5, fields: 'title, date, and link', dest: 'workbook' });
  const goal = compileAcceptedGoal({
    text: plannerText,
    sourceUserSeq: 41,
    multiItem: detectMultiItemIntent(plannerText),
  });
  const { proposed, plannerSource } = proposeTurnGraphFromGoal(goal);
  assert.equal(plannerSource, 'deterministic_fallback');
  assert.equal(validateProposedGraph(goal, proposed).ok, true);
  assert.equal(validateProposedGraph(goal, { nodes: [{ kind: 'execute', effect: 'read' }] }).ok, false);
  assert.equal(validateProposedGraph(goal, {
    ...proposed,
    nodes: [
      { kind: 'retrieve', effect: 'read', capabilityRole: 'source' },
      ...proposed.nodes,
    ],
  }).ok, false, 'the fallback cannot silently reintroduce a second source ceremony');
  assert.deepEqual(
    fallbackProposedGraph(goal).nodes.map((node) => node.kind),
    ['retrieve', 'execute', 'verify', 'compose_reply'],
  );
  const aggregateRead = fallbackProposedGraph(goal).nodes[0];
  assert.equal(aggregateRead?.capabilityRole, 'collection');
  assert.equal(aggregateRead?.cardinality, 5);
  assert.deepEqual(aggregateRead?.requiredFields, ['title', 'date', 'link']);
});

test('a format question is closed once the goal named projection roles', () => {
  const formatText = paraphrase({ host: 'example.com', count: 5, fields: 'title, date, and link', dest: 'workbook' });
  const goal = compileAcceptedGoal({
    text: formatText,
    multiItem: detectMultiItemIntent(formatText),
  });
  assert.equal(
    clarificationBlockedByGoal(goal, 'Should I use one row per post with columns for title, date, and link?'),
    true,
  );
  assert.equal(clarificationBlockedByGoal(goal, 'Which connected account should own the workbook?'), false);
});

test('projection roles come from the field list, not a vendor dictionary', () => {
  assert.deepEqual(
    projectionRolesFromText('put the title, date, and link on a new workbook'),
    ['title', 'date', 'link'],
  );
});

test('listed fields plus a database sink compile as collect-then-construct', () => {
  const text = [
    'Populate a database of matching local professionals, grouped by category.',
    'The information that I would like pulled is the following:',
    'Name',
    'Organization',
    'Category',
    'Phone',
    'Email',
    'Website',
    'Address',
  ].join('\n');
  const goal = compileAcceptedGoal({
    text,
    sourceUserSeq: 91,
    multiItem: detectMultiItemIntent(text),
  });
  assert.equal(goal.construct, 'collect_then_construct');
  assert.equal(goal.route, 'act');
  assert.equal(goal.destination?.family, 'records');
  for (const field of ['name', 'organization', 'category', 'phone', 'email', 'website', 'address']) {
    assert.ok(goal.collection?.projection.includes(field), field);
  }
});

test('capability inventory omits instance-bound command payloads', async () => {
  const { renderCapabilityResolutionForContext } = await import('../harness/capability-resolution.js');
  const rendered = renderCapabilityResolutionForContext({
    entries: [{
      intent: 'append rows to a new tab in google sheets',
      kind: 'composio',
      identifier: 'GOOGLESHEETS_VALUES_UPDATE',
      status: 'proven',
      connection: 'active',
      effectClass: 'write',
      command: '{"spreadsheet_id":"1CNgMp0XziiciY91I5aNXD87ToNQJo9FFf6nGeQZmMd4","values":[["company"]]}',
    }],
    registryAvailable: true,
  });
  assert.doesNotMatch(rendered, /1CNgMp0XziiciY91I5aNXD87ToNQJo9FFf6nGeQZmMd4|company/);
  assert.match(rendered, /GOOGLESHEETS_VALUES_UPDATE/);
});

test('a retrieve graph is a valid empty contract consistency subject', () => {
  const graph = compile('whats on my calendar next monday').graph;
  const empty: TurnGraphIR = graph;
  assert.equal(assertAuthorityConsistency({ graph: empty }).ok, true);
});

test('admitted plural destinations are canonical; destination is the first-sink projection', () => {
  const goal = compileAcceptedGoal({
    text: 'Read the catalog, derive ranked changes, create one artifact, then patch the tracker',
    sourceUserSeq: 81,
    multiItem: { itemCount: 5, isMultiItem: false, collectThenConstruct: true },
    destinations: [
      { posture: 'create_new', family: 'artifact-alpha', handleRequired: true },
      { posture: 'named_existing', family: 'tracker-beta', handleRequired: false },
    ],
  });
  assert.deepEqual(destinationsOf(goal).map((sink) => sink.family), ['artifact-alpha', 'tracker-beta']);
  assert.equal(goal.destination?.family, 'artifact-alpha');
  assert.equal(goal.destination?.handleRequired, true);
  assert.equal(goal.construct, 'collect_then_construct');
  assert.equal(goal.route, 'act');
});
