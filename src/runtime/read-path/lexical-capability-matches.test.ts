import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requestSemanticSegments } from '../../assistant/request-segments.js';
import {
  diversifyCapabilities,
  lexicalCapabilityMatchesForRequest,
  lexicalCapabilityProjectionForRequest,
} from './lexical-capability-matches.js';

function choice(intent: string, identifier: string) {
  return {
    intent,
    description: intent,
    choice: {
      kind: 'composio' as const,
      identifier,
      testedAt: '2026-01-01T00:00:00.000Z',
    },
    fallbacks: [],
    body: '',
    filePath: `/fixture/${identifier}`,
  };
}

test('semantic request segmentation drops field-list fragments but keeps load-bearing clauses', () => {
  const segments = requestSemanticSegments(
    'Pull the top 5 restaurants from the source API, put them in a new table with name, rating, and address, then notify me with the link.',
  );
  assert.deepEqual(segments, [
    'Pull the top 5 restaurants from the source API',
    'put them in a new table with name',
    'notify me with the link',
  ]);
  assert.deepEqual(
    requestSemanticSegments('Gather records, then make table.'),
    ['Gather records', 'make table'],
    'short unfamiliar action clauses are not lost to a verb allowlist',
  );
});

test('Ventura compound retrieval keeps the proven source and one destination family', () => {
  const request = 'Pull the top 5 restaurants in Ventura CA from the Apify API, put them in a new Google Sheet with name, rating, and address, then email me the link.';
  const matches = lexicalCapabilityMatchesForRequest({
    userInput: request,
    limit: 4,
    choices: [
      choice('apify restaurants fetch', 'APIFY_FETCH_RESTAURANTS'),
      choice('google sheets create spreadsheet', 'GOOGLESHEETS_CREATE_SPREADSHEET'),
      choice('google sheets add worksheet', 'GOOGLESHEETS_ADD_SHEET'),
      choice('google sheets update cells', 'GOOGLESHEETS_UPDATE_CELLS'),
      choice('slack find user by email address', 'SLACK_FIND_USER_BY_EMAIL_ADDRESS'),
    ] as never,
  });
  const identifiers = matches.map((match) => match.identifier);
  assert.ok(identifiers.includes('APIFY_FETCH_RESTAURANTS'), identifiers.join(', '));
  assert.equal(
    identifiers.filter((identifier) => identifier.startsWith('GOOGLESHEETS_')).length,
    1,
    'near-identical destination variants cannot crowd out another role',
  );
  assert.ok(!identifiers.includes('SLACK_FIND_USER_BY_EMAIL_ADDRESS'), 'a one-word field fragment is not a requirement');
  assert.equal(matches.find((match) => match.identifier === 'APIFY_FETCH_RESTAURANTS')?.roleKey, 'clause-0:read');
});

test('role projection is load-bearing for open-vocabulary compound clauses', () => {
  const projection = lexicalCapabilityProjectionForRequest({
    userInput: 'Collect restaurant records through SourceHub, place the results in a TableStore table, then notify me through MailRelay.',
    limit: 3,
    choices: [
      choice('sourcehub collect restaurant records', 'SOURCEHUB_FETCH_RECORDS'),
      choice('tablestore place results table', 'TABLESTORE_CREATE_TABLE'),
      choice('mailrelay notify with link', 'MAILRELAY_SEND_MESSAGE'),
    ] as never,
  });
  assert.deepEqual(
    projection.requirements.map((requirement) => requirement.roleKey),
    ['clause-0:read', 'clause-1:write', 'clause-2:write'],
    'receipt-backed effects refine unknown phrasing without provider/task verb rules',
  );
  assert.deepEqual(
    new Set(projection.matches.map((match) => match.roleKey)),
    new Set(['clause-0:read', 'clause-1:write', 'clause-2:write']),
  );
});

test('only unanimous exact receipt effects refine an open-vocabulary role', () => {
  const request = 'Reconcile DeltaHub records.';
  const read = choice('deltahub reconcile records', 'DELTAHUB_LIST_RECORDS');
  const write = choice('deltahub reconcile records', 'DELTAHUB_UPDATE_RECORD');

  assert.equal(lexicalCapabilityProjectionForRequest({
    userInput: request,
    choices: [read] as never,
  }).requirements[0]?.roleKey, 'clause-0:read');
  assert.equal(lexicalCapabilityProjectionForRequest({
    userInput: request,
    choices: [write] as never,
  }).requirements[0]?.roleKey, 'clause-0:write');
  assert.equal(lexicalCapabilityProjectionForRequest({
    userInput: request,
    choices: [read, write] as never,
  }).requirements[0]?.roleKey, 'clause-0:unknown',
    'conflicting proven effects cannot guess a role');
});

test('sibling destination variants cannot crowd out an independent delivery role', () => {
  const matches = lexicalCapabilityMatchesForRequest({
    userInput: 'Collect restaurant records through AlphaSource, create a BetaStore table, then send its link through GammaMail.',
    limit: 4,
    choices: [
      choice('alphasource collect restaurant records', 'ALPHASOURCE_FETCH_RECORDS'),
      choice('betastore create restaurant table', 'BETASTORE_CREATE_TABLE'),
      choice('betastore verify restaurant table', 'BETASTORE_VERIFY_TABLE'),
      choice('betastore append restaurant rows', 'BETASTORE_APPEND_ROWS'),
      choice('gammamail send table link', 'GAMMAMAIL_SEND_MESSAGE'),
    ] as never,
  });
  assert.ok(matches.some((match) => match.identifier === 'ALPHASOURCE_FETCH_RECORDS'));
  assert.ok(matches.some((match) => match.identifier === 'GAMMAMAIL_SEND_MESSAGE'));
  assert.deepEqual(
    new Set(matches.map((match) => match.roleKey)),
    new Set(['clause-0:read', 'clause-1:write', 'clause-2:write']),
  );
});

test('diversity preserves every account provenance for the selected physical capability', () => {
  const roleKey = 'clause-0:read';
  const matches = diversifyCapabilities([
    {
      kind: 'composio', identifier: 'MAILCO_FETCH_INVOICES', score: 1,
      accountIdentity: 'ap@northco.example', roleKey,
    },
    {
      kind: 'composio', identifier: 'MAILCO_FETCH_INVOICES', score: 0.99,
      accountIdentity: 'billing@southco.example', roleKey,
    },
    {
      kind: 'composio', identifier: 'MAILCO_FETCH_ARCHIVED_INVOICES', score: 0.8,
      accountIdentity: 'ap@northco.example', roleKey,
    },
  ], 4);
  assert.deepEqual(
    new Set(matches.map((match) => match.accountIdentity)),
    new Set(['ap@northco.example', 'billing@southco.example']),
    'account variants of one operation are provenance, not sibling-operation noise',
  );
  assert.equal(matches.some((match) => match.identifier === 'MAILCO_FETCH_ARCHIVED_INVOICES'), false,
    'a different sibling operation remains deduplicated');
});

test('per-clause retrieval is integration-neutral across compound phrasing mutations', () => {
  const fixtures = [
    choice('sourcehub collect restaurant records', 'SOURCEHUB_FETCH_RECORDS'),
    choice('tablestore create table', 'TABLESTORE_CREATE_TABLE'),
    choice('tablestore append rows', 'TABLESTORE_APPEND_ROWS'),
  ] as never;
  const mutations = [
    'Fetch restaurant records from SourceHub, then create a TableStore table.',
    'Find the restaurant records in SourceHub; put the result into a new TableStore table.',
    'Retrieve restaurant records using SourceHub, and then add them to TableStore.',
    'Look up restaurant records through SourceHub. Create the TableStore destination after that.',
    'Gather restaurant records through SourceHub; make a TableStore table for the result.',
  ];
  for (const userInput of mutations) {
    const identifiers = lexicalCapabilityMatchesForRequest({
      userInput,
      limit: 3,
      choices: fixtures,
    }).map((match) => match.identifier);
    assert.ok(identifiers.some((identifier) => identifier.startsWith('SOURCEHUB_')), userInput);
    assert.ok(identifiers.some((identifier) => identifier.startsWith('TABLESTORE_')), userInput);
  }
});
