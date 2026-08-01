/**
 * Run: npx tsx --test src/runtime/graph/capability-resolve.test.ts
 *
 * Pins the capability_resolve answer. The load-bearing case is the DEGRADED one:
 * a plan that promises a capability the runtime already knows is broken is how
 * the live 2026-07-23 run died mid-flight on an expired Salesforce login, eight
 * minutes after confidently proposing "read-only via the Salesforce CLI".
 */
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-capability-resolve-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });

import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const { resolveTurnCapabilities, renderCapabilityGrounding } = await import('./capability-resolve.js');
const { recordHarnessCapabilityHealth, _resetHarnessCapabilityHealthForTest } =
  await import('../harness/capability-health.js');

type Requirement = import('./turn-graph-ir.js').TurnGraphCapabilityRequirement;

/** The exact shape the compiler emits for an action turn. */
const ACT_REQUIREMENTS: Requirement[] = [
  { kind: 'tool', resolution: 'deferred' },
  { kind: 'mcp_server', resolution: 'deferred' },
  { kind: 'skill', resolution: 'deferred' },
  { kind: 'workflow', resolution: 'deferred' },
];

beforeEach(() => { _resetHarnessCapabilityHealthForTest(); });

test('a known-broken capability is reported, and reported as unpromisable', () => {
  recordHarnessCapabilityHealth({
    id: 'salesforce',
    state: 'unavailable',
    summary: 'Salesforce CLI not authenticated',
    reason: 'the saved login expired',
  });

  const resolved = resolveTurnCapabilities({
    objective: 'find 20 law firms from my Salesforce and draft outreach for each',
    requirements: ACT_REQUIREMENTS,
  });

  const salesforce = resolved.capabilities.find((capability) => capability.id === 'salesforce');
  assert.ok(salesforce, 'the broken capability must surface at all');
  assert.equal(salesforce.standing, 'degraded');
  assert.match(salesforce.because, /expired/, 'the reason travels with it, not just the state');

  const grounding = renderCapabilityGrounding(resolved);
  assert.match(grounding, /DO NOT PROMISE/, 'the plan must be told it cannot promise this');
  assert.match(grounding, /salesforce/i);

  // And it must appear ONLY as unpromisable. The objective names Salesforce, so
  // the scope resolver also offers it as a connected server; a per-kind de-dup
  // let both rows survive and a plan reading the CONNECTED line would promise
  // the broken thing anyway. Ill health belongs to the thing, not the kind.
  const salesforceRows = resolved.capabilities.filter((capability) => capability.id === 'salesforce');
  assert.equal(salesforceRows.length, 1, `expected one row, got ${JSON.stringify(salesforceRows)}`);
  assert.doesNotMatch(
    grounding.split('DO NOT PROMISE')[0] ?? '',
    /salesforce/i,
    'a broken capability must never appear above the do-not-promise line',
  );
});

test('a degraded capability is reported even when the objective never mentions it', () => {
  // A plan the user reads as "everything is fine" is itself a claim. Whatever
  // was asked for, the one thing known to be broken belongs in front of them.
  recordHarnessCapabilityHealth({ id: 'outlook', state: 'degraded', summary: 'token refresh failing', reason: null });
  const resolved = resolveTurnCapabilities({
    objective: 'scrape ten firms and put them in a spreadsheet',
    requirements: ACT_REQUIREMENTS,
  });
  assert.ok(resolved.capabilities.some((capability) => capability.id === 'outlook' && capability.standing === 'degraded'));
});

test('a healthy capability is not reported as broken', () => {
  recordHarnessCapabilityHealth({ id: 'googlesheets', state: 'healthy', summary: 'ok', reason: null });
  const resolved = resolveTurnCapabilities({ objective: 'put the rows in a spreadsheet', requirements: ACT_REQUIREMENTS });
  assert.equal(
    resolved.capabilities.some((capability) => capability.id === 'googlesheets' && capability.standing === 'degraded'),
    false,
  );
});

test('a cold intent says so instead of implying experience it does not have', () => {
  const resolved = resolveTurnCapabilities({
    objective: 'do something nobody has ever asked for involving quokkas',
    requirements: ACT_REQUIREMENTS,
  });
  assert.equal(resolved.cold, true, 'nothing proven → cold');
  const grounding = renderCapabilityGrounding(resolved);
  if (grounding) assert.match(grounding, /Nothing is proven/);
});

test('explicit tool authority is passed through, never re-derived', () => {
  // When the caller already pinned exact authority, resolution must not quietly
  // widen it — undefined-versus-empty semantics are load-bearing in the IR.
  const resolved = resolveTurnCapabilities({
    objective: 'read the local file',
    requirements: [{ kind: 'tool', resolution: 'explicit', names: ['read_file'] }],
  });
  assert.deepEqual(resolved.explicit, ['read_file']);
});

test('an empty objective resolves without throwing and promises nothing', () => {
  const resolved = resolveTurnCapabilities({ objective: '   ', requirements: ACT_REQUIREMENTS });
  assert.equal(resolved.cold, true);
  assert.equal(resolved.capabilities.filter((capability) => capability.standing === 'proven').length, 0);
});

test('grounding is empty when there is nothing to ground — an ordinary turn is unchanged', () => {
  const resolved = resolveTurnCapabilities({ objective: 'hey', requirements: [] });
  assert.equal(renderCapabilityGrounding(resolved), '');
});

process.on('exit', () => { rmSync(TMP_HOME, { recursive: true, force: true }); });
