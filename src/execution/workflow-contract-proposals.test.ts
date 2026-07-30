import test from 'node:test';
import assert from 'node:assert/strict';

import type { WorkflowDefinition } from '../memory/workflow-store.js';
import {
  proposeWorkflowContractUpgrades,
  renderWorkflowContractProposalReport,
  workflowAuthoringAdvisories,
} from './workflow-contract-proposals.js';

function wf(overrides: Partial<WorkflowDefinition>): WorkflowDefinition {
  return {
    name: 'lunar-local-audit',
    description: 'Run a local lunar audit for a website.',
    enabled: false,
    trigger: { manual: true },
    steps: [],
    ...overrides,
  };
}

test('proposes missing input, pinned goal, and concrete output contracts', () => {
  const proposal = proposeWorkflowContractUpgrades(wf({
    description: 'Run an audit for {{input.url}} and produce a local report.',
    synthesis: { prompt: 'Return the deployed audit page and the saved local file.' },
    steps: [
      {
        id: 'audit',
        prompt: 'Generate a local HTML audit file and deploy it, returning the URL and path. Use {{input.url}}.',
      },
      {
        id: 'salesforce_meetings',
        prompt: 'Find overdue Salesforce meetings and return the list of meetings.',
      },
    ],
  }));

  assert.equal(proposal.needsUpgrade, true);
  assert.deepEqual(proposal.proposedInputs.map((p) => p.key), ['url']);
  assert.ok(proposal.proposedGoal);
  assert.equal(proposal.proposedGoal!.maxAttempts, 2);
  assert.ok(proposal.proposedGoal!.successCriteria?.some((c) => /http\(s\) URL at "url"/.test(c)));
  assert.ok(proposal.proposedGoal!.successCriteria?.some((c) => /existing local file path at "path"/.test(c)));
  assert.ok(proposal.proposedGoal!.successCriteria?.some((c) => /meetings/.test(c)));

  const audit = proposal.proposedStepOutputs.find((p) => p.stepId === 'audit');
  assert.ok(audit);
  assert.deepEqual(audit!.output.required_keys, ['url', 'path']);
  assert.deepEqual(audit!.output.verify, { path_exists: ['path'], url_present: ['url'] });

  const meetings = proposal.proposedStepOutputs.find((p) => p.stepId === 'salesforce_meetings');
  assert.ok(meetings);
  assert.deepEqual(meetings!.output.required_keys, ['meetings']);
  assert.deepEqual(meetings!.output.non_empty, ['meetings']);
  assert.deepEqual(meetings!.output.min_items, { meetings: 1 });
});

test('does not propose contracts when a workflow already has them', () => {
  const proposal = proposeWorkflowContractUpgrades(wf({
    goal: {
      objective: 'Produce the saved audit report.',
      successCriteria: ['The report file exists.'],
      maxAttempts: 2,
    },
    steps: [
      {
        id: 'audit',
        prompt: 'Generate an HTML audit file.',
        output: { type: 'object', required_keys: ['path'], verify: { path_exists: ['path'] } },
      },
    ],
  }));

  assert.equal(proposal.needsUpgrade, false);
  assert.equal(proposal.alreadyPinnedGoal, true);
  assert.equal(proposal.proposedGoal, undefined);
  assert.deepEqual(proposal.proposedStepOutputs, []);
});

test('flags legacy raw common inputs as declarations plus prompt rewrites', () => {
  const proposal = proposeWorkflowContractUpgrades(wf({
    steps: [
      { id: 'normalize', prompt: 'Normalize {{url}} before running the audit.' },
    ],
  }));

  assert.deepEqual(proposal.proposedInputs.map((p) => p.key), ['url']);
  assert.match(proposal.proposedInputs[0].reasons.join('\n'), /legacy \{\{url\}\}/);
  assert.match(proposal.notes.join('\n'), /rewrite/);
});

test('infers a summary contract without treating prospect site as a list', () => {
  const proposal = proposeWorkflowContractUpgrades(wf({
    description: 'x',
    steps: [
      { id: 'summary', prompt: 'Fetch the prospect site and return a summary.' },
    ],
  }));

  assert.equal(proposal.proposedGoal?.objective, 'Fetch the prospect site and return a summary.');
  assert.equal(proposal.proposedGoal?.successCriteria?.filter((c) => /Step "summary"/.test(c)).length, 2);
  assert.equal(proposal.proposedStepOutputs.length, 1);
  assert.deepEqual(proposal.proposedStepOutputs[0].output.required_keys, ['summary']);
  assert.deepEqual(proposal.proposedStepOutputs[0].output.non_empty, ['summary']);
  assert.equal(proposal.proposedStepOutputs[0].output.min_items, undefined);
});

test('prefers an explicitly declared tracker payload over nearby account/summary nouns', () => {
  const proposal = proposeWorkflowContractUpgrades(wf({
    description: 'Maintain a Salesforce account tracker and summarize the run.',
    steps: [
      {
        id: 'find_tracker',
        prompt: 'Find the account tracker sheet and read all account rows. Return structured JSON via workflow_step_result with the complete tracker information, including: spreadsheetId, sheetName, sheetUrl, columns, and existingRows.',
      },
    ],
  }));

  const output = proposal.proposedStepOutputs[0]?.output;
  assert.deepEqual(output?.required_keys, ['spreadsheetId', 'sheetName', 'sheetUrl', 'columns', 'existingRows']);
  assert.deepEqual(output?.verify, { url_present: ['sheetUrl'] });
  assert.equal(output?.min_items, undefined, 'existingRows is not forced non-empty merely because accounts are discussed');
  assert.ok(!output?.required_keys?.includes('accounts'));
  assert.ok(!output?.required_keys?.includes('summary'));
  assert.ok(!output?.required_keys?.includes('url'));
});

test('preserves exact object-literal return keys without inventing generic fields', () => {
  const proposal = proposeWorkflowContractUpgrades(wf({
    steps: [
      {
        id: 'upsert',
        prompt: 'Upsert every prepared account into the sheet. Return exactly {preparedCount, sheetUrl, upsertedRowNumbers}.',
      },
    ],
  }));

  const output = proposal.proposedStepOutputs[0]?.output;
  assert.deepEqual(output?.required_keys, ['preparedCount', 'sheetUrl', 'upsertedRowNumbers']);
  assert.deepEqual(output?.verify, { url_present: ['sheetUrl'] });
});

test('does not invent prose-derived output keys for a structured provider call', () => {
  const proposal = proposeWorkflowContractUpgrades(wf({
    description: 'Read a provider row back after a write.',
    steps: [
      {
        id: 'readback',
        prompt: 'Read the provider row back before this workflow can complete.',
        call: {
          tool: 'GOOGLESHEETS_VALUES_GET',
          args: { spreadsheet_id: 'sheet-1', range: 'Receipts!A:L' },
        },
      },
    ],
  }));

  assert.deepEqual(
    proposal.proposedStepOutputs,
    [],
    'provider response fields must come from an explicit/schema-derived contract, never nouns in the prompt',
  );
});

test('renders a reviewable non-mutating proposal report', () => {
  const proposal = proposeWorkflowContractUpgrades(wf({
    synthesis: { prompt: 'Return the live audit URL.' },
    steps: [
      { id: 'deploy', prompt: 'Deploy the audit page and return the URL.' },
    ],
  }));
  const report = renderWorkflowContractProposalReport([proposal]);

  assert.match(report, /Workflow Contract Proposals/);
  assert.match(report, /Suggested pinned goal/);
  assert.match(report, /Step "deploy"/);
  assert.match(report, /url_present: \["url"\]/);
});

test('advises when a recurring schedule carries a minimum-items floor', () => {
  // Live class (platform-49 Slack review, 2026-07-30): a daily scan authored
  // with min_items ≥ 1 reports a legitimately quiet day as a failed run. The
  // advisory informs the authoring model; it never blocks the write.
  const scanStep = {
    id: 'main',
    prompt: 'Daily scrape of the channel; classify requests into the tracker sheet.',
    output: {
      type: 'object' as const,
      required_keys: ['url', 'leads'],
      non_empty: ['leads'],
      min_items: { leads: 1 },
    },
  };
  const scheduled = wf({
    trigger: { manual: true, schedule: '0 8 * * *', timezone: 'America/Los_Angeles' },
    steps: [scanStep],
  });
  const warnings = workflowAuthoringAdvisories(scheduled);
  assert.equal(warnings.filter((w) => /quiet period/i.test(w)).length, 1);
  assert.match(warnings[0], /"main"/);
  assert.match(warnings[0], /leads/);
  assert.match(warnings[0], /keep the floor only if/i, 'must read as a consideration, not a rule');

  // Manual one-shot: demanding items is normal — stay quiet.
  assert.equal(
    workflowAuthoringAdvisories(wf({ steps: [scanStep] })).filter((w) => /quiet period/i.test(w)).length,
    0,
  );

  // The author explicitly demanded a count — that intent wins, stay quiet.
  const explicit = wf({
    trigger: { manual: true, schedule: '0 8 * * *' },
    steps: [{ ...scanStep, prompt: 'Return at least 3 drafts for the daily digest.' }],
  });
  assert.equal(workflowAuthoringAdvisories(explicit).filter((w) => /quiet period/i.test(w)).length, 0);
});

test('advises when live research has an identity-only output contract', () => {
  const warnings = workflowAuthoringAdvisories(wf({
    steps: [
      {
        id: 'research',
        prompt: 'Research the SEO audit with DataForSEO keywords, backlinks, SERP, and Lighthouse evidence.',
        allowedTools: ['mcp__dataforseo_labs_google_ranked_keywords'],
        output: { type: 'object', required_keys: ['domain', 'client'] },
      },
    ],
  }));

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /research/);
  assert.match(warnings[0], /sources/);
  assert.match(warnings[0], /key_findings/);
});

test('does not advise when live research already requires evidence keys', () => {
  const warnings = workflowAuthoringAdvisories(wf({
    steps: [
      {
        id: 'research',
        prompt: 'Research the SEO audit with DataForSEO keywords, backlinks, SERP, and Lighthouse evidence.',
        allowedTools: ['mcp__dataforseo_labs_google_ranked_keywords'],
        output: {
          type: 'object',
          required_keys: ['domain', 'client', 'sources', 'key_findings', 'source_errors'],
          non_empty: ['sources', 'key_findings'],
          min_items: { sources: 3, key_findings: 3 },
        },
      },
    ],
  }));

  assert.deepEqual(warnings, []);
});

test('does not add generic research-summary keys to evidence-bearing account collections', () => {
  const warnings = workflowAuthoringAdvisories(wf({
    steps: [
      {
        id: 'enrich_accounts',
        prompt: 'Enrich the selected accounts with DataForSEO rank and keyword metrics and preserve the source on every account.',
        allowedTools: ['dataforseo__dataforseo_labs_google_ranked_keywords'],
        output: {
          type: 'object',
          required_keys: ['accounts'],
          non_empty: ['accounts'],
          min_items: { accounts: 1 },
        },
        sideEffect: 'read',
      },
    ],
  }));

  assert.deepEqual(warnings, [], 'the account records are the evidence payload; top-level sources/key_findings would be redundant');
});

test('any domain collection declared must-carry-data is evidence-bearing, not just enumerated nouns', () => {
  const warnings = workflowAuthoringAdvisories(wf({
    steps: [
      {
        id: 'enrich_invoices',
        prompt: 'Research each vendor and enrich the open invoices with competitor pricing analysis.',
        allowedTools: ['firecrawl'],
        output: {
          type: 'object',
          required_keys: ['invoices'],
          non_empty: ['invoices'],
          min_items: { invoices: 1 },
        },
        sideEffect: 'read',
      },
    ],
  }));

  assert.deepEqual(warnings, [], 'a non-empty invoices collection is the evidence payload — no noun list required');
});

test('an unknown key with only non_empty (no min_items) is NOT collection evidence', () => {
  // A required non-empty scalar ("vibe": "good") must not satisfy the
  // evidence requirement — only a declared collection (min_items >= 1) or an
  // enumerated evidence key does.
  const warnings = workflowAuthoringAdvisories(wf({
    steps: [
      {
        id: 'research_vendors',
        prompt: 'Research each vendor with live SERP analysis and competitor audit data.',
        allowedTools: ['dataforseo__serp_organic_live_advanced'],
        output: {
          type: 'object',
          required_keys: ['assessment'],
          non_empty: ['assessment'],
        },
        sideEffect: 'read',
      },
    ],
  }));

  assert.ok(warnings.length >= 1, 'a non_empty scalar alone must still trigger the weak-contract advisory');
});

test('does not mistake a write that preserves SEO fields for a live-research step', () => {
  const warnings = workflowAuthoringAdvisories(wf({
    steps: [
      {
        id: 'upsert_accounts',
        prompt: 'Upsert account and SEO fields, then read back the exact written sheet rows.',
        allowedTools: ['composio_execute_tool'],
        output: {
          type: 'object',
          required_keys: ['sheetUrl', 'upsertedRowNumbers'],
          non_empty: ['sheetUrl', 'upsertedRowNumbers'],
        },
        sideEffect: 'write',
      },
    ],
  }));

  assert.deepEqual(warnings, [], 'write receipt/read-back proof should not be inflated with research-summary keys');
});

test('advises when an unattended generic Composio write has neither a pinned action nor discovery', () => {
  const warnings = workflowAuthoringAdvisories(wf({
    enabled: true,
    trigger: { schedule: '0 8 * * *', timezone: 'America/Los_Angeles' },
    steps: [
      {
        id: 'upsert_accounts',
        prompt: 'Upsert every prepared account into the existing tracker, then read the written rows back.',
        allowedTools: ['composio_execute_tool', 'run_tool_program'],
        sideEffect: 'write',
      },
    ],
  }));

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unattended external write/);
  assert.match(warnings[0], /Pin a proven TOOLKIT_ACTION slug/);
});

test('accepts an unattended Composio write with a pinned mutation slug', () => {
  const warnings = workflowAuthoringAdvisories(wf({
    enabled: true,
    trigger: { schedule: '0 8 * * *', timezone: 'America/Los_Angeles' },
    steps: [
      {
        id: 'upsert_accounts',
        prompt: 'Call GOOGLESHEETS_UPDATE_VALUES_BATCH with the pinned spreadsheet_id and exact data ranges, then read them back.',
        allowedTools: ['composio_execute_tool', 'run_tool_program'],
        sideEffect: 'write',
      },
    ],
  }));

  assert.deepEqual(warnings, []);
});

test('accepts an unattended generic Composio write that retains bounded discovery', () => {
  const warnings = workflowAuthoringAdvisories(wf({
    enabled: true,
    trigger: { schedule: '0 8 * * *', timezone: 'America/Los_Angeles' },
    steps: [
      {
        id: 'upsert_accounts',
        prompt: 'Find the correct Sheets upsert action, execute it once, then read the written rows back.',
        allowedTools: ['composio_search_tools', 'composio_execute_tool'],
        sideEffect: 'write',
      },
    ],
  }));

  assert.deepEqual(warnings, []);
});

test('advises when a verified artifact step is model-written instead of deterministic', () => {
  const warnings = workflowAuthoringAdvisories(wf({
    steps: [
      {
        id: 'build_html',
        prompt: 'Build the HTML audit report and save the local file.',
        allowedTools: ['write_file'],
        output: { type: 'object', required_keys: ['path'], verify: { path_exists: ['path'] } },
      },
      {
        id: 'deterministic_build',
        prompt: 'Build the HTML audit report and save the local file.',
        deterministic: { runner: 'render-audit.mjs' },
        output: { type: 'object', required_keys: ['path'], verify: { path_exists: ['path'] } },
      },
    ],
  }));

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /build_html/);
  assert.match(warnings[0], /deterministic runner/);
});
