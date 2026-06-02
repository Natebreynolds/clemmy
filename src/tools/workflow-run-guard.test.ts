import { test } from 'node:test';
import assert from 'node:assert/strict';
import { workflowExplicitlyRequested } from './workflow-run-guard.js';

test('matches exact workflow name in user text', () => {
  assert.equal(
    workflowExplicitlyRequested('morning-prospect-prep', [], 'run morning-prospect-prep now'),
    true,
  );
});

test('matches hyphen→space variant', () => {
  assert.equal(
    workflowExplicitlyRequested('morning-prospect-prep', [], 'run the morning prospect prep'),
    true,
  );
});

test('matches hyphen-removed variant', () => {
  assert.equal(
    workflowExplicitlyRequested('morning-prospect-prep', [], 'kick off morningprospectprep'),
    true,
  );
});

test('does NOT match unrelated request (the incident — must block)', () => {
  assert.equal(
    workflowExplicitlyRequested(
      'morning-prospect-prep',
      [],
      'scrape their top keywords and put it in a google sheet',
    ),
    false,
  );
});

test('STRONG PARTIAL match: distinctive tokens identify the workflow without the full slug', () => {
  // The live friction: "fire off the salesforce to airtable workflow" should
  // resolve salesforce-to-airtable-prospect-enrichment (salesforce + airtable
  // = 2 distinctive tokens) without typing the exact name.
  assert.equal(
    workflowExplicitlyRequested(
      'salesforce-to-airtable-prospect-enrichment',
      ['salesforce-to-airtable-prospect-enrichment'],
      'can you fire off the salesforce to airtable workflow please',
    ),
    true,
  );
});

test('strong-partial needs >=2 distinctive tokens — a single shared word does NOT match', () => {
  // "prospect" alone is shared by several workflows → must not trigger.
  assert.equal(
    workflowExplicitlyRequested('salesforce-to-airtable-prospect-enrichment', [], 'run my prospect thing'),
    false,
  );
  // The incident text has 0 distinctive-token overlap with this workflow too.
  assert.equal(
    workflowExplicitlyRequested('salesforce-to-airtable-prospect-enrichment', [], 'scrape keywords into a google sheet'),
    false,
  );
});

test('empty user text returns false', () => {
  assert.equal(workflowExplicitlyRequested('morning-prospect-prep', [], ''), false);
});

test('whitespace-only user text returns false', () => {
  assert.equal(workflowExplicitlyRequested('morning-prospect-prep', [], '   \n  '), false);
});

test('short/degenerate name does not trivially match unrelated text', () => {
  // name "ab" (< MIN_NEEDLE_LEN) must not match arbitrary text that
  // happens to contain "ab" (e.g. "about").
  assert.equal(workflowExplicitlyRequested('ab', [], 'tell me about the weather'), false);
});

test('slug candidate matches when name itself does not', () => {
  assert.equal(
    workflowExplicitlyRequested('Morning Prospect Prep', ['morning-prospect-prep'], 'run morning-prospect-prep'),
    true,
  );
});

test('case-insensitive matching', () => {
  assert.equal(
    workflowExplicitlyRequested('Morning-Prospect-Prep', [], 'RUN MORNING-PROSPECT-PREP'),
    true,
  );
});
