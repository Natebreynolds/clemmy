/**
 * Production routing regression for source 50404.
 *
 * Mobile dictation often produces one run-on imperative instead of punctuated
 * clauses.  A leading read verb must not erase an explicit downstream artifact
 * or delivery action: that mistake freezes the deterministic one-read contract
 * and makes the accepted write/send impossible to represent.
 *
 * Run: npx tsx --test src/runtime/graph/compound-action-route.red.test.ts
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyExternalEffectRequest } from '../../assistant/external-effect-taxonomy.js';
import { classifyMessageIntent } from '../../assistant/message-intent.js';
import { requestSemanticSegments } from '../../assistant/request-segments.js';
import { compileDeterministicExpectedWorkProposal } from '../harness/expected-work-contract.js';
import { resolveTurnCapabilityCandidates } from '../read-path/capability-candidates.js';
import { compileTurnGraph } from './turn-graph-compiler.js';
import type { TurnGraphPolicySnapshot } from './turn-graph-ir.js';

const POLICY: TurnGraphPolicySnapshot = {
  version: 'turn-policy-v1',
  autoApproveScope: 'yolo',
  proactiveWorkAllowed: false,
  allowComposioActions: true,
  allowComputerActions: true,
  requireWorkflowApprovalForExecution: true,
  batchConfirmThreshold: 5,
};

const LIVE_PISMO_PROMPT = 'Find me the best date night restaurants maybe 5 of them in pismo beach ca '
  + 'put them in a sheet with reviews and send me an email with the link to the sheet please';

function compile(input: string) {
  return compileTurnGraph({
    identity: { sessionId: 'compound-action-route', turn: 1, sourceUserSeq: 50_404 },
    input,
    sessionKind: 'chat',
    surface: 'discord',
    policy: POLICY,
  });
}

test('exact source 50404 keeps the read, Sheet, and delivery request on an external-write action graph', () => {
  assert.deepEqual(classifyExternalEffectRequest(LIVE_PISMO_PROMPT), {
    requested: true,
    kinds: ['communication'],
  });
  assert.equal(classifyMessageIntent(LIVE_PISMO_PROMPT).intent, 'action');

  const result = compile(LIVE_PISMO_PROMPT);
  assert.equal(result.validation.ok, true, result.validation.errors.join('\n'));
  assert.equal(result.graph.classification.route, 'act');
  assert.equal(result.graph.classification.externalEffectRequested, true);
  assert.deepEqual(result.graph.classification.externalEffectKinds, ['communication']);
  assert.equal(result.graph.effectCeiling, 'external_write');
  assert.equal(
    result.graph.nodes.filter((node) => node.kind === 'retrieve').length,
    1,
    'the compound ask keeps one aggregate source-read phase',
  );
  assert.ok(
    result.graph.nodes.some((node) => node.kind === 'execute' || node.kind === 'fanout'),
    'the downstream construct cannot be erased by the leading read verb',
  );
  assert.equal(compileDeterministicExpectedWorkProposal(result.graph), null,
    'an action must wait for its explicit nonzero operation contract');
});

test('provider-neutral read plus artifact/delivery compounds retain action authority', () => {
  const cases = [
    {
      input: 'Find the five current accounts and send me an email with the summary.',
      external: true,
      ceiling: 'external_write',
    },
    {
      input: 'Research the strongest vendors and email me the comparison.',
      external: true,
      ceiling: 'external_write',
    },
    {
      input: 'Find the current records and put them in a new spreadsheet.',
      external: true,
      ceiling: 'external_write',
    },
    {
      input: 'Research the market and write a brief with sources.',
      external: false,
      ceiling: 'unknown',
    },
  ] as const;

  for (const fixture of cases) {
    const result = compile(fixture.input);
    assert.equal(result.validation.ok, true, `${fixture.input}: ${result.validation.errors.join('\n')}`);
    assert.equal(result.graph.classification.route, 'act', fixture.input);
    assert.equal(result.graph.classification.externalEffectRequested, fixture.external, fixture.input);
    assert.equal(result.graph.effectCeiling, fixture.ceiling, fixture.input);
    assert.equal(compileDeterministicExpectedWorkProposal(result.graph), null, fixture.input);
  }
});

test('source 50404 projects three unresolved capability roles instead of one false Sheet read', async () => {
  assert.deepEqual(requestSemanticSegments(LIVE_PISMO_PROMPT), [
    'Find me the best date night restaurants maybe 5 of them in pismo beach ca',
    'put them in a sheet with reviews',
    'send me an email with the link to the sheet please',
  ]);

  const resolved = await resolveTurnCapabilityCandidates({
    userInput: LIVE_PISMO_PROMPT,
    semantic: false,
    limit: 5,
    // This is the exact unrelated receipt that falsely settled the whole live
    // run-on request as one read role.  Once the source/destination/delivery
    // requirements are separate, its read effect cannot resolve the Sheet
    // write and its Sheet nouns cannot resolve the restaurant source.
    choices: [
      {
        intent: 'googlesheets.get_sheet_names',
        description: 'Get names of sheets in a spreadsheet and put them in a list.',
        choice: {
          kind: 'composio', identifier: 'GOOGLESHEETS_GET_SHEET_NAMES',
          testedAt: '2026-08-13T00:00:00.000Z',
        },
        fallbacks: [], body: '', filePath: '/fixture/GOOGLESHEETS_GET_SHEET_NAMES',
      },
      {
        intent: 'google_sheets.add_tab',
        description: 'Add a sheet tab.',
        choice: {
          kind: 'composio', identifier: 'GOOGLESHEETS_ADD_SHEET',
          testedAt: '2026-08-13T00:00:00.000Z',
        },
        fallbacks: [], body: '', filePath: '/fixture/GOOGLESHEETS_ADD_SHEET',
      },
      {
        intent: 'slack.send_message',
        description: 'Send a message.',
        choice: {
          kind: 'composio', identifier: 'SLACK_SEND_MESSAGE',
          testedAt: '2026-08-13T00:00:00.000Z',
        },
        fallbacks: [], body: '', filePath: '/fixture/SLACK_SEND_MESSAGE',
      },
    ] as never,
  });
  assert.deepEqual(resolved.requirements.map((requirement) => ({
    roleKey: requirement.roleKey,
    resolved: requirement.resolved,
  })), [
    { roleKey: 'clause-0:read', resolved: false },
    { roleKey: 'clause-1:write', resolved: false },
    { roleKey: 'clause-2:write', resolved: false },
  ]);
  assert.ok(resolved.candidates.every((candidate) => candidate.resolutionRoleKeys?.length === 0),
    'medium Sheet/Slack lexical overlap may remain advice but cannot settle any frozen clause role');
  assert.ok(resolved.requirements.every((requirement) => requirement.resolvedCapabilities.length === 0));
});

test('discussion about communication remains read-only', () => {
  for (const input of [
    'Find me a guide explaining how to send an email.',
    'Research how the automation finds restaurants and sends me an email.',
    'Explain how to find restaurants and send me an email.',
    'Find the build and deploy status.',
  ]) {
    const result = compile(input);
    assert.equal(result.graph.classification.externalEffectRequested, false, input);
    assert.notEqual(result.graph.classification.route, 'act', input);
    assert.notEqual(result.graph.effectCeiling, 'external_write', input);
  }
});
