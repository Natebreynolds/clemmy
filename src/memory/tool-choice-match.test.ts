/**
 * Run: npx tsx --test src/memory/tool-choice-match.test.ts
 *
 * The matcher behind TIGHT AUTHORING: given a workflow step prompt, find the
 * user's PROVEN remembered tool-choice for what the step does, with enough
 * precision to AUTO-BIND a high-confidence cli/mcp match (and only advise on a
 * fuzzy / composio match). This is the centerpiece — these contracts must hold:
 *   - a step that clearly names a proven cli choice → HIGH tier, auto-bindable
 *   - composio matches are advise-only (autoBindable false) — connection rot
 *   - already-bound steps are flagged so they're never re-bound
 *   - a clean cli choice beats a poisoned/mislabeled composio one on a near-tie
 *   - a single short/generic token never triggers a match (precision)
 *   - below-threshold / empty inputs return nothing
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchToolChoicesForStep, type ToolChoiceRecord } from './tool-choice-store.js';

function rec(
  intent: string,
  kind: 'cli' | 'mcp' | 'composio',
  identifier: string,
  invocationTemplate?: string,
  description?: string,
): ToolChoiceRecord {
  return {
    intent,
    description,
    choice: { kind, identifier, invocationTemplate, testedAt: '2026-06-01T00:00:00Z' },
    fallbacks: [],
    body: '',
    filePath: `/tmp/${intent}.md`,
  };
}

const SF_CLI = rec(
  'salesforce.cli.query',
  'cli',
  'sf',
  'sf data query --target-org nathan.reynolds@scorpion.co --json --query "{{soql}}"',
  'Run a SOQL query against Salesforce via the sf CLI',
);

test('HIGH-confidence cli match → auto-bindable with the right family + command', () => {
  const matches = matchToolChoicesForStep(
    'Query Salesforce for new prospect accounts using a SOQL query and return them as JSON.',
    { choices: [SF_CLI] },
  );
  assert.equal(matches.length, 1);
  const m = matches[0];
  assert.equal(m.tier, 'high');
  assert.equal(m.autoBindable, true);
  assert.equal(m.kind, 'cli');
  assert.deepEqual(m.family, ['run_shell_command']);
  assert.match(m.command, /sf data query/);
  assert.equal(m.alreadyBound, false);
});

test('composio match is ADVISE-only (never auto-bind — connection/identifier rot)', () => {
  const composio = rec(
    'salesforce.query.soql',
    'composio',
    'SALESFORCE_RUN_SOQL_QUERY',
    undefined,
    'Run a Salesforce SOQL query',
  );
  const matches = matchToolChoicesForStep(
    'Query Salesforce with a SOQL query for new prospects.',
    { choices: [composio] },
  );
  assert.equal(matches.length, 1);
  assert.equal(matches[0].autoBindable, false);
});

test('already-bound: a prompt that already embeds the command is flagged', () => {
  const matches = matchToolChoicesForStep(
    'Query Salesforce: run `sf data query --json --query "SELECT Id FROM Account"` and return JSON.',
    { choices: [SF_CLI] },
  );
  assert.equal(matches.length, 1);
  assert.equal(matches[0].alreadyBound, true);
});

test('poisoned-composio routing: a clean cli choice beats a mislabeled composio one on a near tie', () => {
  // The live trap: a composio choice whose intent says salesforce but whose
  // identifier is mislabeled AIRTABLE_LIST_RECORDS. For a salesforce prompt,
  // the clean sf-CLI choice must come first so the binder picks it.
  const poisoned = rec(
    'salesforce.query.records.soql',
    'composio',
    'AIRTABLE_LIST_RECORDS',
    undefined,
    'Query Salesforce records via SOQL',
  );
  const matches = matchToolChoicesForStep(
    'Query Salesforce for new prospect accounts via a SOQL query.',
    { choices: [poisoned, SF_CLI] },
  );
  assert.ok(matches.length >= 1);
  assert.equal(matches[0].kind, 'cli', 'cli choice should rank first on a near tie');
  assert.equal(matches[0].autoBindable, true);
});

test('precision: a single generic/short token does NOT trigger a match', () => {
  // "data" is generic, "sf" is too short to anchor — a prompt that only brushes
  // those must not match the SF CLI choice.
  const matches = matchToolChoicesForStep(
    'Summarize the data in the attached report and write a short paragraph.',
    { choices: [SF_CLI] },
  );
  assert.equal(matches.length, 0);
});

test('mcp match is auto-bindable and locks to the mcp tool name', () => {
  const mcp = rec(
    'airtable.records.list',
    'mcp',
    'airtable__list_records_for_table',
    undefined,
    'List Airtable records for a table',
  );
  const matches = matchToolChoicesForStep(
    'List the Airtable records for the prospects table.',
    { choices: [mcp] },
  );
  assert.equal(matches.length, 1);
  assert.equal(matches[0].autoBindable, true);
  assert.deepEqual(matches[0].family, ['airtable__list_records_for_table']);
});

test('inactive (invalidated) choices are skipped', () => {
  const inactive: ToolChoiceRecord = { ...SF_CLI, choice: null };
  const matches = matchToolChoicesForStep('Query Salesforce for new prospects via SOQL.', {
    choices: [inactive],
  });
  assert.equal(matches.length, 0);
});

test('empty prompt and empty store both return nothing', () => {
  assert.deepEqual(matchToolChoicesForStep('', { choices: [SF_CLI] }), []);
  assert.deepEqual(matchToolChoicesForStep('Query Salesforce via SOQL', { choices: [] }), []);
});

test('multiple matches are capped by limit, strongest first', () => {
  const firecrawl = rec('firecrawl.scrape', 'cli', 'firecrawl', 'firecrawl scrape {{url}}', 'Scrape a URL with firecrawl');
  const matches = matchToolChoicesForStep(
    'Scrape the firecrawl site and query Salesforce via SOQL, both for prospects.',
    { choices: [SF_CLI, firecrawl], limit: 1 },
  );
  assert.equal(matches.length, 1);
});

test('below the medium threshold → no match (only a faint overlap)', () => {
  // One incidental description word ("prospect") overlaps but no CORE identity
  // token (salesforce/soql/query-as-core) is present.
  const matches = matchToolChoicesForStep(
    'Write a friendly note to the prospect thanking them for their time.',
    { choices: [SF_CLI] },
  );
  assert.equal(matches.length, 0);
});

test('precision: a lone SERVICE mention (no operation token) does NOT bind', () => {
  // Names the service but NOT the operation → only 1 core token → no false bind.
  // (Adversarial review repro: "screenshot the salesforce dashboard".)
  assert.deepEqual(
    matchToolChoicesForStep('Open the salesforce accounts dashboard in a browser and screenshot it.', { choices: [SF_CLI] }),
    [],
  );
});

test('precision: an incidental shared DESCRIPTION word never clears the floor on its own', () => {
  // "against" is a preposition from the choice description — a single service
  // token + one incidental description word must NOT match (review repro B).
  assert.deepEqual(
    matchToolChoicesForStep('Compare the figures against salesforce numbers.', { choices: [SF_CLI] }),
    [],
  );
});
