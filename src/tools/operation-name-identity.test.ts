/**
 * AN EXACT OPERATION ID IS AN ANSWER, NOT A RANKING SIGNAL.
 *
 * Live 2026-09-18: a workflow step whose scope cites `salesforce_sf_soql_query`
 * searched tool_search for that exact id TWELVE times and was handed
 * `space_save` at the top of twenty results. The named-operation detector
 * matched UPPER_SNAKE — composio's spelling — so a lower_snake reviewed CLI
 * read was never recognised as named at all, and generic relevance decided a
 * question identity had already answered.
 *
 * That was the fifth place in the codebase asking "is this an operation?" by
 * spelling. This module is the one answer; these pin it.
 *
 * Run: node scripts/run-tests-isolated.mjs src/tools/operation-name-identity.test.ts
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-operation-identity-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-operation-identity\n', 'utf8');

import assert from 'node:assert/strict';
import { test } from 'node:test';

const { isKnownOperationName, operationNamedInQuery, sameOperationName } = await import('./operation-name-identity.js');

/** The exact id the owner's Friday step cites, and the query it actually sent. */
const CLI_READ = 'salesforce_sf_soql_query';
const LIVE_QUERY = 'salesforce_sf_soql_query authenticated local sf CLI execute SOQL query and return records, including schema/describe mappings if supported';

test.after(() => { rmSync(TMP_HOME, { recursive: true, force: true }); });

test('a lower_snake reviewed-CLI read is a known operation', () => {
  assert.equal(
    isKnownOperationName(CLI_READ),
    true,
    'THE REGRESSION: UPPER_SNAKE-only detection classified this as "not an operation"',
  );
  assert.equal(isKnownOperationName('SALESFORCE_SF_SOQL_QUERY'), true, 'identity is case-insensitive');
});

test('the live query that returned space_save now names its operation', () => {
  assert.equal(
    operationNamedInQuery(LIVE_QUERY),
    CLI_READ,
    'the exact id in the query is detected, so the caller can lead with it',
  );
});

test('a composio slug no registry carries still resolves by shape', () => {
  // Fallback preserved: a freshly discovered action must not stop being
  // detectable just because no registry has it yet.
  assert.equal(operationNamedInQuery('please run OUTLOOK_OUTLOOK_SEND_EMAIL now'), 'OUTLOOK_OUTLOOK_SEND_EMAIL');
});

test('ordinary prose names no operation', () => {
  assert.equal(operationNamedInQuery('pull this week closed won pipeline from salesforce'), '');
  assert.equal(operationNamedInQuery('summarize the results'), '');
  assert.equal(isKnownOperationName('totally_unknown_local_thing'), false);
  assert.equal(isKnownOperationName(''), false);
});

test('operation names compare as identities', () => {
  assert.equal(sameOperationName(' Salesforce_SF_SOQL_Query ', CLI_READ), true);
  assert.equal(sameOperationName('space_save', CLI_READ), false);
});
