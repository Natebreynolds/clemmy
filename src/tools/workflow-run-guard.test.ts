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
