/**
 * Run: node scripts/run-tests-isolated.mjs \
 *   src/execution/workflow-run-readiness-account-advisory.red.test.ts
 *
 * OPEN-THE-GATES Slice 4. `requiredResourceReadiness` re-hardcoded `cli !== 'sf'`
 * in the kernel and had no ok-path for a required account: a valid Salesforce
 * selector always became a blocker, so friday-dashboard-daily-refresh and
 * team-activity-slack-updates could never queue. Readiness owns no CLI
 * execution authority — that is a host-internal gap. Warn and admit.
 * Invalid selectors still block (the durable fact is outside the host).
 *
 * Re-break two ways:
 *   (i)  restore the `cli !== 'sf'` special case
 *   (ii) push a valid selector onto blockers
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { WorkflowDefinition, WorkflowResourceBinding } from '../memory/workflow-store.js';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-wf-readiness-account-advisory-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.HOME = TMP_HOME;

const { checkWorkflowRunReadiness } = await import('./workflow-run-readiness.js');
const SRC = new URL('./workflow-run-readiness.ts', import.meta.url);

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});

const SLUG = 'daily-dashboard-refresh-shape';
mkdirSync(path.join(TMP_HOME, 'vault', '00-System', 'workflows', SLUG, 'scripts'), { recursive: true });
writeFileSync(
  path.join(TMP_HOME, 'vault', '00-System', 'workflows', SLUG, 'scripts', 'refresh.mjs'),
  'process.stdout.write("{}\\n");\n',
  'utf8',
);

function workflow(resource: WorkflowResourceBinding): WorkflowDefinition {
  return {
    name: SLUG,
    description: 'Refresh a dashboard from a required source account.',
    enabled: true,
    trigger: { type: 'schedule', schedule: '0 7 * * *' },
    resources: { salesforce_org: resource },
    steps: [{ id: 'refresh', prompt: 'Refresh the dashboard.', sideEffect: 'read' }],
  };
}

test('NEGATIVE: a required account with a valid selector must not refuse the run', () => {
  const readiness = checkWorkflowRunReadiness(workflow({
    id: 'salesforce_org',
    kind: 'account',
    cli: 'sf',
    account: 'ops@example.test',
    required: true,
  }), SLUG);
  assert.equal(readiness.ok, true);
  assert.equal(readiness.blockers.length, 0);
  assert.equal(readiness.warnings.some((item) => item.name === 'sf:salesforce_org'), true);
});

test('an invalid selector is still a blocker — that fact is outside the host', () => {
  const readiness = checkWorkflowRunReadiness(workflow({
    id: 'salesforce_org',
    kind: 'account',
    cli: 'sf',
    account: '--json; touch /tmp/not-allowed',
    required: true,
  }), SLUG);
  assert.equal(readiness.ok, false);
  assert.match(readiness.blockers[0]?.reason ?? '', /selector is missing or invalid/i);
});

test('re-break (i): the kernel must not special-case a provider CLI', () => {
  const src = readFileSync(SRC, 'utf8');
  assert.doesNotMatch(src, /cli !== 'sf'/);
  assert.doesNotMatch(src, /cli === 'sf'/);
});

test('re-break (ii): a valid selector must not be pushed onto blockers', () => {
  const src = readFileSync(SRC, 'utf8');
  const fn = src.slice(src.indexOf('function requiredResourceReadiness'), src.indexOf('function resourceProbeItem'));
  const marker = 'No CLI is special-cased here';
  assert.ok(fn.includes(marker), 'the valid-selector path must exist as a single CLI-neutral warning');
  const validPath = fn.slice(fn.indexOf(marker));
  assert.match(validPath, /warnings\.push\(resourceProbeItem/);
  assert.doesNotMatch(
    validPath,
    /blockers\.push/,
    'the unverifiable-account path must warn, not block',
  );
});
