/**
 * Run: npx tsx --test src/execution/workflow-resource-binding.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { WorkflowDefinition } from '../memory/workflow-store.js';
import { buildWorkflowResourceBindingReport, completeWorkflowResourceBindings, workflowResourceBindingGaps } from './workflow-resource-binding.js';

function def(overrides: Partial<WorkflowDefinition>): WorkflowDefinition {
  return {
    name: 'resource-bind-wf',
    description: 'Bind workflow resources.',
    enabled: true,
    trigger: { manual: true },
    steps: [{ id: 'step', prompt: 'Use the bound resource.' }],
    ...overrides,
  };
}

const baseInventory = {
  composio: {
    apiKeyPresent: true,
    connected: [
      { slug: 'googlesheets', connectionId: 'conn-sheet', status: 'ACTIVE', accountEmail: 'ops@example.com' },
    ],
    catalog: [
      { slug: 'googlesheets', name: 'Google Sheets', authMode: 'managed' as const, categories: [] },
      { slug: 'googleads', name: 'Google Ads', authMode: 'managed' as const, categories: [] },
    ],
  },
  clis: {
    connected: [
      { id: 'salesforce', command: 'sf', vendor: 'Salesforce', name: 'Salesforce CLI', installedAt: '2026-01-01T00:00:00.000Z', authDocsUrl: 'https://example.com' },
    ],
    savedCommands: [],
  },
};

test('a declared binding keeps the app word and the named address an author wrote', async () => {
  const { normalizeWorkflowResources } = await import('./workflow-authoring.js');
  const normalized = normalizeWorkflowResources({
    mailbox: { kind: 'outlook', identity: 'ops@example.com' },
    sheet: { kind: 'sheet', toolkit: 'googlesheets', resource_id: 'abc', label: 'Leads' },
  });
  assert.deepEqual(normalized?.mailbox, { id: 'mailbox', kind: 'other', label: 'outlook', name: 'ops@example.com' });
  assert.deepEqual(normalized?.sheet, { id: 'sheet', kind: 'sheet', label: 'Leads', toolkit: 'googlesheets', resourceId: 'abc' });
});

test('a declared app and account are bound from the connected inventory at save time', () => {
  // Live 2026-10-27: {"kind":"outlook","identity":"<address>"} saved as an
  // unbound "other" resource; the creation test passed and the first run
  // then stopped on NEEDS RESOURCE BINDING for that very account.
  const inventory = {
    ...baseInventory,
    composio: {
      ...baseInventory.composio,
      connected: [
        ...baseInventory.composio.connected,
        { slug: 'outlook', connectionId: 'conn-outlook-a', status: 'ACTIVE', accountEmail: 'ops@example.com' },
        { slug: 'outlook', connectionId: 'conn-outlook-b', status: 'ACTIVE', accountEmail: 'sales@example.com' },
      ],
    },
  };
  const named = completeWorkflowResourceBindings(def({
    resources: { mailbox: { id: 'mailbox', kind: 'other', label: 'outlook', name: 'ops@example.com' } },
  }), inventory);
  assert.equal(named.resources?.mailbox?.toolkit, 'outlook');
  assert.equal(named.resources?.mailbox?.connectionId, 'conn-outlook-a', 'the named identity picks its connection');
  assert.deepEqual(workflowResourceBindingGaps(def({ resources: named.resources })), []);
  assert.match(named.notes[0] ?? '', /mailbox.*Outlook/i);

  // Live 2026-10-27 (again): the author wrote the connection's own id as the
  // resource id under kind "other"; with two accounts connected that id is
  // the choice, not a question.
  const byId = completeWorkflowResourceBindings(def({
    resources: { 'conn-outlook-b': { id: 'conn-outlook-b', kind: 'other', label: 'connected_account', toolkit: 'outlook' } },
  }), inventory);
  assert.equal(byId.resources?.['conn-outlook-b']?.connectionId, 'conn-outlook-b', 'a connection id as the resource id binds that connection');
  assert.deepEqual(workflowResourceBindingGaps(def({ resources: byId.resources })), []);

  const unnamed = completeWorkflowResourceBindings(def({
    resources: { mailbox: { id: 'mailbox', kind: 'other', label: 'outlook' } },
  }), inventory);
  assert.equal(unnamed.resources?.mailbox?.toolkit, 'outlook');
  assert.equal(unnamed.resources?.mailbox?.connectionId, undefined, 'two accounts and no name: the account stays a question');
  assert.equal(workflowResourceBindingGaps(def({ resources: unnamed.resources })).length, 1);

  const single = completeWorkflowResourceBindings(def({
    resources: { sheet: { id: 'sheet', kind: 'sheet', label: 'Google Sheets leads' } },
  }), baseInventory);
  assert.equal(single.resources?.sheet?.toolkit, 'googlesheets');
  assert.equal(single.resources?.sheet?.connectionId, 'conn-sheet', 'the only connection of that app is the account');

  const explicit = completeWorkflowResourceBindings(def({
    resources: { ads: { id: 'ads', kind: 'account', toolkit: 'googleads', account: '123' } },
  }), baseInventory);
  assert.deepEqual(explicit.resources?.ads, { id: 'ads', kind: 'account', toolkit: 'googleads', account: '123' }, 'what the author set is untouched');
  assert.deepEqual(explicit.notes, []);
});

test('connected sheet surface still needs a concrete selector', () => {
  const report = buildWorkflowResourceBindingReport(def({
    resources: {
      lead_sheet: { id: 'lead_sheet', kind: 'sheet', label: 'Lead sheet', toolkit: 'googlesheets' },
    },
  }), baseInventory);

  assert.equal(report.needsBindingCount, 1);
  assert.equal(report.proposals[0].status, 'needs_selector');
  assert.equal(report.proposals[0].recommended?.status, 'ready');
  assert.match(report.proposals[0].gaps[0], /concrete object/);
});

test('unselected sheet gets a ready Google Sheets surface recommendation', () => {
  const report = buildWorkflowResourceBindingReport(def({
    resources: {
      lead_sheet: { id: 'lead_sheet', kind: 'sheet', label: 'Google Sheets lead sheet' },
    },
  }), baseInventory);

  assert.equal(report.proposals[0].status, 'needs_surface');
  assert.equal(report.proposals[0].recommended?.toolkit, 'googlesheets');
  assert.equal(report.proposals[0].recommended?.status, 'ready');
  assert.match(report.proposals[0].nextActions[0], /workflow_update/);
});

test('selected but disconnected toolkit asks for connection before selector work', () => {
  const report = buildWorkflowResourceBindingReport(def({
    resources: {
      ads_account: { id: 'ads_account', kind: 'account', label: 'Google Ads account', toolkit: 'googleads', account: '123-456-7890' },
    },
  }), baseInventory);

  assert.equal(report.proposals[0].status, 'needs_connection');
  assert.equal(report.proposals[0].recommended?.toolkit, 'googleads');
  assert.equal(report.proposals[0].recommended?.status, 'missing');
  assert.match(report.proposals[0].nextActions[0], /Connect Google Ads/);
});

test('CLI resource is bound when the command is connected', () => {
  const report = buildWorkflowResourceBindingReport(def({
    resources: {
      salesforce_cli: { id: 'salesforce_cli', kind: 'cli', label: 'Salesforce CLI', cli: 'sf' },
    },
  }), baseInventory);

  assert.equal(report.boundCount, 1);
  assert.equal(report.needsBindingCount, 0);
  assert.equal(report.proposals[0].status, 'bound');
  assert.equal(report.proposals[0].recommended?.command, 'sf');
});

test('Workspace resource is locally bound by its stable slug without an external connector', () => {
  const report = buildWorkflowResourceBindingReport(def({
    resources: {
      content_calendar: {
        id: 'social-content-calendar',
        kind: 'workspace',
        label: 'Content calendar Workspace',
      },
    },
  }), baseInventory);

  assert.equal(report.boundCount, 1);
  assert.equal(report.needsBindingCount, 0);
  assert.equal(report.proposals[0].status, 'bound');
  assert.equal(report.proposals[0].recommended?.kind, 'workspace');
  assert.equal(report.proposals[0].recommended?.status, 'ready');
});

test('workflowResourceBindingGaps names each required resource without a surface or a selector, and nothing for optional or bound ones', () => {
  const def = {
    name: 'gaps-fixture',
    description: 'fixture',
    steps: [{ id: 'read', prompt: 'read' }],
    resources: {
      sheet: { id: 'sheet', kind: 'sheet', label: 'Pipeline sheet', required: true },
      notes: { id: 'notes', kind: 'document', required: false },
    },
  } as unknown as WorkflowDefinition;
  const gaps = workflowResourceBindingGaps(def);
  assert.ok(gaps.some((gap) => gap.startsWith('Pipeline sheet:') && /execution surface/.test(gap)), 'surface gap is named');
  assert.ok(gaps.some((gap) => gap.startsWith('Pipeline sheet:') && /bind a concrete spreadsheet, tab, or sheet URL/.test(gap)), 'selector gap is named');
  assert.ok(!gaps.some((gap) => gap.startsWith('notes:')), 'an optional resource never gaps');
  assert.deepEqual(workflowResourceBindingGaps({ ...def, resources: {} } as WorkflowDefinition), []);
});
