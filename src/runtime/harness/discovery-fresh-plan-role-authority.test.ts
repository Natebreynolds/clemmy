import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { tool } from '@openai/agents';
import { z } from 'zod';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-fresh-role-authority-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const eventlog = await import('./eventlog.js');
const { discoveryGovernor } = await import('./discovery-governor.js');
const {
  DiscoveryBudgetDeniedError,
  admitDiscoveryBoundary,
} = await import('./discovery-boundary.js');
const { recordTurnGraphShadow } = await import('../graph/turn-graph-shadow.js');
const {
  ToolCallsCounter,
  withHarnessRunContext,
  wrapToolForHarness,
} = await import('./brackets.js');
const { markFreshPlanDisclosureSearch } = await import('../../tools/tool-search-mode.js');

interface RoleFixture {
  roleKey: string;
  resolved?: boolean;
}

function acceptedTask(label: string, fixtures: readonly RoleFixture[]) {
  const session = eventlog.createSession({ id: `fresh-role-${label}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: label },
  });
  recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
  });
  discoveryGovernor.initializeTask({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    knownCapability: fixtures.some((fixture) => fixture.resolved === true),
  });
  discoveryGovernor.initializeRoles({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    brokerCoverage: 'authorized_external_v1',
    requirements: fixtures.map((fixture, index) => ({
      roleKey: fixture.roleKey,
      clauseIndex: index,
      text: `requirement ${index} for ${label}`,
      resolved: fixture.resolved === true,
    })),
  });
  return { sessionId: session.id, sourceUserSeq: source.seq };
}

after(() => {
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('fresh-plan authority preserves one exact claim per frozen unresolved role', () => {
  const key = acceptedTask('two-live-roles', [
    { roleKey: 'clause-0:read' },
    { roleKey: 'clause-1:write' },
    { roleKey: 'clause-2:write', resolved: true },
  ]);
  const source = admitDiscoveryBoundary({
    ...key,
    toolName: 'tool_search',
    input: { query: 'find source', role_key: 'clause-0:read', limit: 8 },
    callId: 'fresh-source',
    freshPlanCatalogDisclosure: true,
  });
  const destination = admitDiscoveryBoundary({
    ...key,
    toolName: 'tool_search',
    input: { query: 'find destination', role_key: 'clause-1:write', limit: 8 },
    callId: 'fresh-destination',
    freshPlanCatalogDisclosure: true,
  });
  assert.equal(source?.subject, 'clause-0:read');
  assert.equal(destination?.subject, 'clause-1:write');
  assert.deepEqual(
    discoveryGovernor.getTaskState(key)?.epochClaims
      .filter((claim) => claim.category === 'broad_discovery')
      .map((claim) => claim.subject)
      .sort(),
    ['clause-0:read', 'clause-1:write'],
  );

  for (const [roleKey, reason] of [
    ['invented-provider-role', 'role_not_unresolved'],
    ['clause-2:write', 'role_resolved'],
  ] as const) {
    assert.throws(() => admitDiscoveryBoundary({
      ...key,
      toolName: 'tool_search',
      input: { query: 'spoofed search', role_key: roleKey, limit: 8 },
      callId: `fresh-denied-${roleKey}`,
      freshPlanCatalogDisclosure: true,
    }), (error: unknown) => {
      assert.ok(error instanceof DiscoveryBudgetDeniedError);
      assert.equal(error.reason, reason);
      return true;
    });
  }
});

test('role-scoped broad search has an eight-claim ceiling even with more frozen roles', () => {
  const roles = Array.from({ length: 9 }, (_, index) => ({ roleKey: `clause-${index}:unknown` }));
  const key = acceptedTask('nine-live-roles', roles);
  for (let index = 0; index < 8; index += 1) {
    assert.ok(admitDiscoveryBoundary({
      ...key,
      toolName: 'tool_search',
      input: { query: `find requirement ${index}`, role_key: roles[index]!.roleKey, limit: 8 },
      callId: `fresh-role-${index}`,
      freshPlanCatalogDisclosure: true,
    }));
  }
  assert.throws(() => admitDiscoveryBoundary({
    ...key,
    toolName: 'tool_search',
    input: { query: 'find ninth requirement', role_key: roles[8]!.roleKey, limit: 8 },
    callId: 'fresh-role-8',
    freshPlanCatalogDisclosure: true,
  }), (error: unknown) => {
    assert.ok(error instanceof DiscoveryBudgetDeniedError);
    assert.equal(error.reason, 'category_budget_exhausted');
    return true;
  });
  assert.equal(
    discoveryGovernor.getTaskState(key)?.epochClaims
      .filter((claim) => claim.category === 'broad_discovery').length,
    8,
  );
});

test('reusing a physical call id with changed role arguments is refused before provider code', async () => {
  const key = acceptedTask('changed-args', [
    { roleKey: 'clause-0:read' },
    { roleKey: 'clause-1:write' },
  ]);
  let providerCalls = 0;
  const configured = markFreshPlanDisclosureSearch(tool({
    name: 'tool_search',
    description: 'fresh role argument-binding fixture',
    parameters: z.object({
      query: z.string().min(1),
      role_key: z.string().min(1),
      limit: z.number().int().positive().max(8),
    }),
    execute: async ({ role_key }) => {
      providerCalls += 1;
      return `provider:${role_key}`;
    },
  }));
  const wrapped = wrapToolForHarness(configured);
  const context = { ...key, turn: 1, counter: new ToolCallsCounter(10) };
  const invoke = (input: Record<string, unknown>) => withHarnessRunContext(
    context,
    () => wrapped.invoke(
      undefined as never,
      JSON.stringify(input),
      { toolCall: { callId: 'same-physical-discovery-id' } } as never,
    ),
  );

  assert.equal(await invoke({
    query: 'find source', role_key: 'clause-0:read', limit: 8,
  }), 'provider:clause-0:read');
  await assert.rejects(
    () => invoke({
      query: 'find destination', role_key: 'clause-1:write', limit: 8,
    }),
    /conflict|changed|refus|already|argument/i,
  );
  assert.equal(providerCalls, 1);
});
