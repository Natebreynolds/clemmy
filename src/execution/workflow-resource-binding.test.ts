/**
 * Run: npx tsx --test src/execution/workflow-resource-binding.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { WorkflowDefinition } from '../memory/workflow-store.js';
import { buildWorkflowResourceBindingReport } from './workflow-resource-binding.js';

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
