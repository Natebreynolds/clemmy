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
