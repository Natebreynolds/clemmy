/**
 * Run: npx tsx --test src/execution/workflow-builder-synthesis.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { synthesizeWorkflowDefinition } from './workflow-builder-synthesis.js';
import { prepareWorkflowCreateForWrite } from './workflow-authoring.js';
import type { WorkflowBuilderAnalysis } from './workflow-builder-analysis.js';

test('synthesis carries root workflow inputs into mechanical direct-tool steps so create can codify them', () => {
  const analysis: WorkflowBuilderAnalysis = {
    name: 'domain-rank-report',
    description: 'Fetch domain rank metrics and analyze them.',
    suggestedInputs: {
      domain: { type: 'string', description: 'Target domain' },
    },
    suggestedSteps: [
      {
        id: 'fetch_metrics',
        title: 'Fetch metrics',
        description: 'Fetch the domain rank overview.',
        intent: 'fetch',
        suggestedTools: ['dataforseo_domain_rank_overview'],
        expectedOutputType: 'object',
      },
      {
        id: 'analyze',
        title: 'Analyze metrics',
        description: 'Analyze the retrieved metrics.',
        intent: 'analyze',
        suggestedTools: ['composio_execute_tool'],
        dependsOn: ['fetch_metrics'],
        expectedOutputType: 'object',
      },
    ],
    parallelizationOpportunities: [],
    concerns: [],
    confidence: 0.9,
  };

  const def = synthesizeWorkflowDefinition(analysis);
  assert.deepEqual(def.steps[0].inputs, {
    domain: {
      from: 'input.domain',
      type: 'string',
      description: 'Target domain',
    },
  });
  assert.match(def.steps[0].prompt, /Required inputs: domain/);
  assert.equal(def.steps[1].inputs, undefined);

  const prepared = prepareWorkflowCreateForWrite(def);
  assert.equal(prepared.def.steps[0].call?.tool, 'dataforseo_domain_rank_overview');
  assert.deepEqual(prepared.def.steps[0].call?.args, { domain: '{{input.domain}}' });
  assert.equal(prepared.codifyNotes.length, 1);
});
