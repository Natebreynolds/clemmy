import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveWorkflowName,
  textRefersToWorkflow,
  workflowNamesEqual,
  type ResolverEntry,
} from './workflow-resolve.js';

const E = (name: string, slug = name.replace(/[^a-zA-Z0-9]+/g, '-').toLowerCase()): ResolverEntry => ({
  name,
  slug,
});

const PROSPECT = E('Morning Prospect Prep', 'morning-prospect-prep');
const SF_AIRTABLE = E('Salesforce to Airtable Prospect Enrichment', 'salesforce-to-airtable-prospect-enrichment');
const SEO = E('Weekly SEO Audit', 'weekly-seo-audit');

test('resolve: exact display name regardless of case/spacing', () => {
  const r = resolveWorkflowName('morning prospect prep', [PROSPECT, SEO]);
  assert.equal(r.kind, 'exact');
  if (r.kind === 'exact') assert.equal(r.name, 'Morning Prospect Prep');
});

test('resolve: exact slug', () => {
  assert.equal(resolveWorkflowName('morning-prospect-prep', [PROSPECT, SEO]).kind, 'exact');
});

test('resolve: single fuzzy match for a loose name', () => {
  const r = resolveWorkflowName('prospecting flow', [PROSPECT, SEO]);
  assert.equal(r.kind, 'fuzzy');
  if (r.kind === 'fuzzy') assert.equal(r.name, 'Morning Prospect Prep');
});

test('resolve: strips action verbs ("kick off my ...") before matching', () => {
  const r = resolveWorkflowName('kick off my prospecting flow', [PROSPECT, SEO]);
  assert.equal(r.kind, 'fuzzy');
  if (r.kind === 'fuzzy') assert.equal(r.name, 'Morning Prospect Prep');
});

test('resolve: strong partial naming is fuzzy single', () => {
  const r = resolveWorkflowName('run the salesforce to airtable workflow', [PROSPECT, SF_AIRTABLE, SEO]);
  assert.equal(r.kind, 'fuzzy');
  if (r.kind === 'fuzzy') assert.equal(r.name, 'Salesforce to Airtable Prospect Enrichment');
});

test('resolve: ambiguous when several workflows share the named token', () => {
  const research = E('Prospect Research', 'prospect-research');
  const outreach = E('Prospect Outreach', 'prospect-outreach');
  const r = resolveWorkflowName('prospect', [research, outreach, SEO]);
  assert.equal(r.kind, 'ambiguous');
  if (r.kind === 'ambiguous') {
    assert.ok(r.candidates.includes('Prospect Research'));
    assert.ok(r.candidates.includes('Prospect Outreach'));
  }
});

test('resolve: none for an unrelated ad-hoc request (2026-05-31 incident)', () => {
  const r = resolveWorkflowName('scrape their top keywords into a google sheet', [PROSPECT, SEO]);
  assert.equal(r.kind, 'none');
});

test('resolve: none for empty input', () => {
  assert.equal(resolveWorkflowName('   ', [PROSPECT, SEO]).kind, 'none');
});

test('textRefersToWorkflow: recognizes the loosely-named workflow', () => {
  assert.equal(textRefersToWorkflow('kick off my prospecting flow', PROSPECT, [PROSPECT, SF_AIRTABLE, SEO]), true);
});

test('textRefersToWorkflow: does not match a different workflow', () => {
  assert.equal(textRefersToWorkflow('kick off my prospecting flow', SEO, [PROSPECT, SF_AIRTABLE, SEO]), false);
});

test('textRefersToWorkflow: refuses an unrelated ad-hoc request', () => {
  assert.equal(textRefersToWorkflow('scrape keywords into a sheet', PROSPECT, [PROSPECT, SF_AIRTABLE, SEO]), false);
});

test('textRefersToWorkflow: false for empty text', () => {
  assert.equal(textRefersToWorkflow('', PROSPECT, [PROSPECT, SEO]), false);
});

test('workflowNamesEqual: ignores case and punctuation', () => {
  assert.equal(workflowNamesEqual('Morning Prospect Prep', 'morning-prospect-prep'), true);
  assert.equal(workflowNamesEqual('a', 'b'), false);
});
