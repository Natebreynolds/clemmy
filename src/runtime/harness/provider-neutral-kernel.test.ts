import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Architectural boundary: adapters may name the service they adapt and tests
 * may use realistic fixtures. The shared decision, authority, workflow,
 * entity, coverage, and recurrence kernels may not acquire those nouns.
 *
 * This catches the incident class where an example-shaped repair quietly
 * becomes production policy (for example, selecting a capability because a
 * particular application name appears in approval prose).
 */
const KERNEL_FILES = [
  './host-turn-runner.ts',
  './accepted-turn-call-authority.ts',
  './workflow-read-only-call-kernel.ts',
  './workflow-paginated-read-authority.ts',
  './workflow-paginated-read-kernel.ts',
  '../../memory/workflow-node-invocation-plan.ts',
  '../../execution/workflow-node-invocation-admission.ts',
  '../../execution/workflow-node-invocation-executor.ts',
  '../../execution/automation-workflow-bridge.ts',
  '../../execution/automation-opportunity-review-control-plane.ts',
  '../../execution/automation-read-pilot-run.ts',
  '../../execution/automation-read-pilot-control-plane.ts',
  '../../execution/canonical-entity-resolution.ts',
  '../../execution/canonical-entity-store-schema.ts',
  '../../execution/canonical-entity-store.ts',
  '../../shared/workflow-interval.ts',
  '../../execution/workflow-interval-scheduler.ts',
  '../../execution/workflow-interval-run-identity.ts',
  '../../spaces/canonical-entity-workspace-projection.ts',
  '../../spaces/canonical-entity-workspace-store-projection.ts',
] as const;

const CUSTOMER_OR_PROVIDER_RECIPE =
  /\b(?:restaurant|attorney|lawyer|salesforce|outlook|slack|gmail|asana|apify|dataforseo|netlify|airtable|supabase|browsermcp|composio)\b|google.?sheets?|\bserp\b|GOOGLESHEETS_|OUTLOOK_|GMAIL_/i;

test('shared execution kernel contains no customer-shaped or provider-branded policy', () => {
  for (const relative of KERNEL_FILES) {
    const path = fileURLToPath(new URL(relative, import.meta.url));
    const source = readFileSync(path, 'utf8');
    assert.doesNotMatch(source, CUSTOMER_OR_PROVIDER_RECIPE, relative);
  }
});
