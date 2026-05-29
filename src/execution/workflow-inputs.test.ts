/**
 * Run: npx tsx --test src/execution/workflow-inputs.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { WorkflowDefinition } from '../memory/workflow-store.js';
import {
  collectRequiredWorkflowInputs,
  missingWorkflowRunInputs,
  normalizeWorkflowRunInputs,
} from './workflow-inputs.js';

function workflow(patch: Partial<WorkflowDefinition> = {}): WorkflowDefinition {
  return {
    name: 'audit',
    description: 'Audit workflow',
    enabled: true,
    trigger: { manual: true },
    steps: [
      {
        id: 'normalize',
        prompt: 'Required input: {{url}}. Use {{input.clientName}} when supplied.',
      },
    ],
    ...patch,
  };
}

test('collectRequiredWorkflowInputs reads declared and legacy placeholders', () => {
  assert.deepEqual(
    collectRequiredWorkflowInputs(workflow({
      inputs: {
        clientName: { type: 'string', default: '' },
        market: { type: 'string', default: 'Los Angeles' },
      },
    })),
    ['clientName', 'url'],
  );
});

test('normalizeWorkflowRunInputs trims values and maps website/domain aliases to url', () => {
  assert.deepEqual(normalizeWorkflowRunInputs({ website: ' https://example.com ', empty: '   ' }), {
    website: 'https://example.com',
    url: 'https://example.com',
  });
});

test('missingWorkflowRunInputs reports missing required values only', () => {
  const def = workflow({ inputs: { market: { type: 'string', default: 'Los Angeles' } } });
  assert.deepEqual(missingWorkflowRunInputs(def, normalizeWorkflowRunInputs({})), ['clientName', 'url']);
  assert.deepEqual(missingWorkflowRunInputs(def, normalizeWorkflowRunInputs({ domain: 'example.com', clientName: 'Example' })), []);
});
