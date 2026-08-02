import assert from 'node:assert/strict';
import test from 'node:test';

import { isReservedProjectWorkflowRunRecord } from './compiled-project-run-contract.js';

test('slug-only project reservation preserves ordinary compiled-prefix catalog identities', () => {
  assert.equal(
    isReservedProjectWorkflowRunRecord({ workflowSlug: 'compiled-existing' }),
    false,
  );
  assert.equal(
    isReservedProjectWorkflowRunRecord({
      workflowSlug: `compiled-${'a'.repeat(32)}`,
    }),
    true,
  );
});

test('non-slug project lineage markers remain fail-closed with malformed slugs', () => {
  assert.equal(
    isReservedProjectWorkflowRunRecord({
      source: 'project_graph',
      workflowSlug: 'compiled-existing',
    }),
    true,
  );
  assert.equal(
    isReservedProjectWorkflowRunRecord({
      sourceExecutionId: null,
      workflowSlug: 'compiled-',
    }),
    true,
  );
});
