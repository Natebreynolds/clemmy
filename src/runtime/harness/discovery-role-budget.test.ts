import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-discovery-role-budget-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const eventlog = await import('./eventlog.js');
const { recordTurnGraphShadow } = await import('../graph/turn-graph-shadow.js');
const {
  DiscoveryGovernor,
  discoveryGovernor,
} = await import('./discovery-governor.js');
const {
  DiscoveryBudgetDeniedError,
  admitDiscoveryBoundary,
  classifyDiscoveryCall,
  settleDiscoveryBoundary,
} = await import('./discovery-boundary.js');
const { renderCapabilityCandidateCard } = await import('../read-path/capability-candidates.js');
const { registerToolSearchTool } = await import('../../tools/tool-search-tool.js');
const {
  ToolCallsCounter,
  withHarnessRunContext,
  wrapToolForHarness,
} = await import('./brackets.js');
const { buildCallTool } = await import('../../tools/call-tool.js');
const {
  _setExternalMcpToolsForTests,
  dispatchCodeModeTool,
} = await import('../../tools/code-mode-tool.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

interface RequirementFixture {
  roleKey: string;
  clauseIndex: number;
  text: string;
  resolved: boolean;
}

function acceptedTask(
  label: string,
  requirements: RequirementFixture[],
): { sessionId: string; sourceUserSeq: number } {
  const session = eventlog.createSession({ id: `role-budget-${label}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: label },
  });
  assert.ok(recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
  }));
  discoveryGovernor.initializeTask({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    knownCapability: requirements.some((requirement) => requirement.resolved),
  });
  discoveryGovernor.initializeRoles({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    requirements,
    brokerCoverage: 'authorized_external_v1',
  });
  return { sessionId: session.id, sourceUserSeq: source.seq };
}

function assertDeniedAttemptTerminal(
  key: { sessionId: string; sourceUserSeq: number },
): void {
  const rows = eventlog.openEventLog().prepare(`
    SELECT l.state, l.conflict_reason, s.outcome_kind, s.execution_kind,
           (SELECT COUNT(*) FROM physical_dispatches p
             WHERE p.session_id = l.session_id
               AND p.source_user_seq = l.source_user_seq
               AND p.logical_tool_call_id = l.logical_tool_call_id) AS crossings
      FROM logical_tool_calls l
      JOIN logical_call_settlements s
        ON s.session_id = l.session_id
       AND s.source_user_seq = l.source_user_seq
       AND s.logical_tool_call_id = l.logical_tool_call_id
     WHERE l.session_id = ? AND l.source_user_seq = ?
  `).all(key.sessionId, key.sourceUserSeq) as Array<{
    state: string;
    conflict_reason: string | null;
    outcome_kind: string;
    execution_kind: string;
    crossings: number;
  }>;
  assert.deepEqual(rows, [{
    state: 'settled',
    conflict_reason: null,
    outcome_kind: 'policy_denial',
    execution_kind: 'refused_pre_dispatch',
    crossings: 0,
  }]);
}

test('distinct unresolved roles each get one slot while synonyms and carriers share the role claim', () => {
  const sourceRole = 'clause-0:read';
  const destinationRole = 'clause-1:write';
  const deliveryRole = 'clause-2:write';
  const key = acceptedTask('role-scoped compound request', [
    { roleKey: sourceRole, clauseIndex: 0, text: 'collect the current source records', resolved: false },
    { roleKey: destinationRole, clauseIndex: 1, text: 'write the artifact', resolved: false },
    { roleKey: deliveryRole, clauseIndex: 2, text: 'deliver the finished result', resolved: true },
  ]);

  const first = admitDiscoveryBoundary({
    ...key,
    toolName: 'tool_search',
    input: { query: 'find a source record reader', role_key: sourceRole },
    callId: 'source-search-1',
  });
  assert.ok(first);
  assert.equal(first.subject, sourceRole);
  settleDiscoveryBoundary(first, 'succeeded');

  assert.throws(() => admitDiscoveryBoundary({
    ...key,
    toolName: 'ToolSearch',
    input: { query: `[role:${sourceRole}] locate something that retrieves the records` },
    callId: 'source-search-synonym',
  }), (error: unknown) => {
    assert.ok(error instanceof DiscoveryBudgetDeniedError);
    assert.equal(error.reason, 'category_budget_exhausted');
    return true;
  });

  const second = admitDiscoveryBoundary({
    ...key,
    toolName: 'mcp__clementine-local__tool_search',
    input: { query: 'find an artifact creation tool', role_key: destinationRole },
    callId: 'destination-search-1',
  });
  assert.ok(second, 'a distinct unresolved requirement owns an independent slot');
  assert.equal(second.subject, destinationRole);

  assert.throws(() => admitDiscoveryBoundary({
    ...key,
    toolName: 'tool_search',
    input: { query: 'find another provider', role_key: 'provider:invented-by-model' },
    callId: 'spoofed-role',
  }), (error: unknown) => {
    assert.ok(error instanceof DiscoveryBudgetDeniedError);
    assert.equal(error.reason, 'role_not_unresolved');
    return true;
  });

  assert.throws(() => admitDiscoveryBoundary({
    ...key,
    toolName: 'tool_search',
    input: { query: 'find a delivery tool', role_key: deliveryRole },
    callId: 'resolved-role',
  }), (error: unknown) => {
    assert.ok(error instanceof DiscoveryBudgetDeniedError);
    assert.equal(error.reason, 'role_resolved');
    return true;
  });

  // Alternate broad surfaces are not extra brokers. Their schemas carry no
  // role_key, so the central boundary refuses them before provider I/O.
  for (const [toolName, input] of [
    ['composio_search_tools', { query: 'artifact creator' }],
    ['composio_list_tools', { toolkit_slug: 'anything' }],
    ['mcp_list_tools', { server: 'anything', query: 'artifact creator' }],
    ['local_cli_list', { filter: 'anything' }],
    ['clem.listTools', undefined],
  ] as const) {
    assert.throws(() => admitDiscoveryBoundary({
      ...key,
      toolName,
      input,
      callId: `alternate-${toolName}`,
    }), (error: unknown) => {
      assert.ok(error instanceof DiscoveryBudgetDeniedError);
      assert.equal(error.reason, 'role_required');
      return true;
    });
  }

  const exact = admitDiscoveryBoundary({
    ...key,
    toolName: 'tool_search',
    input: { query: 'workspace_roots' },
    callId: 'exact-schema-refresh',
  });
  assert.ok(exact, 'exact selected-tool schema refresh stays independent of role budgets');
  assert.equal(exact.category, 'exact_schema_refresh');

  eventlog.closeEventLog();
  const restarted = new DiscoveryGovernor();
  const state = restarted.getTaskState(key);
  assert.equal(state?.policy.roleScoped, true);
  assert.equal(state?.roles.length, 3);
  assert.deepEqual(
    state?.epochClaims
      .filter((claim) => claim.category === 'broad_discovery')
      .map((claim) => claim.subject)
      .sort(),
    [destinationRole, sourceRole].sort(),
  );
  const afterRestart = restarted.admit({
    ...key,
    category: 'broad_discovery',
    subject: sourceRole,
    callId: 'source-after-restart',
  });
  assert.equal(afterRestart.admitted, false);
  assert.equal(afterRestart.reason, 'category_budget_exhausted');
});

test('an all-resolved role projection has zero broad slots without disabling exact schema repair', () => {
  const roleKey = 'clause-0:read';
  const key = acceptedTask('all resolved request', [{
    roleKey,
    clauseIndex: 0,
    text: 'read the current workspace state',
    resolved: true,
  }]);
  const state = discoveryGovernor.getTaskState(key);
  assert.equal(state?.policy.roleScoped, true);
  assert.equal(state?.policy.unresolvedRoleCount, 0);
  assert.equal(state?.policy.broadDiscoveryAllowance, 0);

  assert.throws(() => admitDiscoveryBoundary({
    ...key,
    toolName: 'tool_search',
    input: { query: 'find workspace reader', role_key: roleKey },
    callId: 'resolved-broad',
  }), (error: unknown) => {
    assert.ok(error instanceof DiscoveryBudgetDeniedError);
    assert.equal(error.reason, 'role_resolved');
    return true;
  });
  assert.ok(admitDiscoveryBoundary({
    ...key,
    toolName: 'tool_search',
    input: { query: 'workspace_roots' },
    callId: 'resolved-exact',
  }));
});

test('direct, nested boundary, and code-mode alternate broad doors deny before provider I/O', async () => {
  const roleKey = 'clause-0:unknown';
  const requirement = {
    roleKey,
    clauseIndex: 0,
    text: 'discover the unresolved external operation',
    resolved: false,
  };
  const directKey = acceptedTask('direct carrier parity', [requirement]);
  const directContext = { ...directKey, turn: 1, counter: new ToolCallsCounter(50) };

  let directCalls = 0;
  const direct = wrapToolForHarness({
    name: 'composio_search_tools',
    execute: async () => {
      directCalls += 1;
      return 'provider result';
    },
  });
  const directOutput = await withHarnessRunContext(
    directContext,
    () => direct.execute!({ query: 'external operation' }),
  );
  assert.match(String(directOutput), /role_required/);
  assert.equal(directCalls, 0);
  assertDeniedAttemptTerminal(directKey);

  const nestedKey = acceptedTask('nested carrier parity', [requirement]);
  // call_tool's trusted resolver sends its effective inner identity through
  // this same boundary. The carrier's one-call settlement/refinement invariant
  // has a dedicated production-path red pin; this pin owns the new role policy.
  assert.throws(() => admitDiscoveryBoundary({
    ...nestedKey,
    turn: 1,
    toolName: 'composio_search_tools',
    input: { query: 'external operation' },
    callId: 'role-nested-denial',
  }), (error: unknown) => {
    assert.ok(error instanceof DiscoveryBudgetDeniedError);
    assert.equal(error.reason, 'role_required');
    return true;
  });
  assertDeniedAttemptTerminal(nestedKey);

  const codeModeKey = acceptedTask('code mode carrier parity', [requirement]);
  const codeModeContext = {
    ...codeModeKey,
    turn: 1,
    counter: new ToolCallsCounter(50),
  };
  let codeModeInventoryReads = 0;
  _setExternalMcpToolsForTests(async () => {
    codeModeInventoryReads += 1;
    return [{ name: 'vendor__read', description: 'read', inputSchema: {} }];
  });
  try {
    await assert.rejects(
      withHarnessRunContext(
        codeModeContext,
        () => dispatchCodeModeTool(
          'listTools',
          undefined,
          codeModeKey.sessionId,
          codeModeContext.counter,
        ),
      ),
      (error: unknown) => {
        assert.ok(error instanceof DiscoveryBudgetDeniedError);
        assert.equal(error.reason, 'role_required');
        return true;
      },
    );
    assert.equal(codeModeInventoryReads, 0);
  } finally {
    _setExternalMcpToolsForTests(null);
  }
  assertDeniedAttemptTerminal(codeModeKey);
});

test('a nested call_tool broad denial settles the refined carrier call once', async () => {
  const key = acceptedTask('nested production carrier parity', [{
    roleKey: 'clause-0:unknown',
    clauseIndex: 0,
    text: 'discover the unresolved external operation',
    resolved: false,
  }]);
  const nested = wrapToolForHarness(buildCallTool({
    reachableBuiltinNames: new Set(['composio_search_tools']),
  }) as never) as unknown as {
    invoke: (ctx: unknown, input: string, details: unknown) => Promise<unknown>;
  };
  const output = await withHarnessRunContext(
    { ...key, turn: 1, counter: new ToolCallsCounter(50) },
    () => nested.invoke(
      { context: { sessionId: key.sessionId } },
      JSON.stringify({
        name: 'composio_search_tools',
        args_json: JSON.stringify({ query: 'external operation' }),
      }),
      { toolCall: { callId: 'role-nested-production-denial' } },
    ),
  );
  assert.match(String(output), /role_required/);
  assertDeniedAttemptTerminal(key);
});

test('role membership is immutable and resolution only tightens across fallover', () => {
  const key = acceptedTask('monotonic roles', [{
    roleKey: 'clause-0:unknown',
    clauseIndex: 0,
    text: 'perform the unfamiliar operation',
    resolved: false,
  }]);
  const governor = new DiscoveryGovernor();
  const tightened = governor.initializeRoles({
    ...key,
    brokerCoverage: 'authorized_external_v1',
    requirements: [{
      roleKey: 'clause-0:read',
      clauseIndex: 0,
      text: 'perform the unfamiliar operation',
      resolved: true,
    }],
  });
  assert.equal(tightened.status, 'tightened');
  assert.equal(tightened.roles[0]?.resolved, true);
  assert.equal(tightened.roles[0]?.roleKey, 'clause-0:unknown', 'fallover keeps the frozen role identity');

  const cannotLoosen = governor.initializeRoles({
    ...key,
    brokerCoverage: 'authorized_external_v1',
    requirements: [{
      roleKey: 'clause-0:unknown',
      clauseIndex: 0,
      text: 'perform the unfamiliar operation',
      resolved: false,
    }],
  });
  assert.equal(cannotLoosen.status, 'existing');
  assert.equal(cannotLoosen.roles[0]?.resolved, true);

  assert.throws(() => governor.initializeRoles({
    ...key,
    brokerCoverage: 'authorized_external_v1',
    requirements: [{
      roleKey: 'provider-shaped-spoof',
      clauseIndex: 0,
      text: 'perform the unfamiliar operation',
      resolved: false,
    }],
  }), /conflicts with the frozen accepted task/i);
});

test('a builtins-only broker leaves the legacy discovery path reachable', () => {
  const session = eventlog.createSession({ id: 'role-budget-compatibility', kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'use an unresolved external capability' },
  });
  const governor = new DiscoveryGovernor();
  governor.initializeTask({ sessionId: session.id, sourceUserSeq: source.seq, knownCapability: false });
  const compatibility = governor.initializeRoles({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    requirements: [{
      roleKey: 'clause-0:unknown',
      clauseIndex: 0,
      text: 'use an unresolved external capability',
      resolved: false,
    }],
    // The construction seam reports this exact host capability fact until both
    // authorized MCP and Composio candidate sources are bound to tool_search.
    brokerCoverage: 'builtins_only',
  });
  assert.equal(compatibility.policy.roleScoped, false);
  assert.equal(compatibility.roles.length, 0);
  const legacy = governor.admit({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    category: 'broad_discovery',
    callId: 'legacy-external-search',
  });
  assert.equal(legacy.admitted, true);
  assert.equal(legacy.subject, '');
  const sameTaskSecondRole = governor.admit({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    category: 'broad_discovery',
    subject: 'model-invented-before-role-policy',
    callId: 'legacy-external-search-2',
  });
  assert.equal(sameTaskSecondRole.admitted, false, 'legacy role-shaped text cannot mint another slot');
  assert.equal(sameTaskSecondRole.reason, 'category_budget_exhausted');
});

test('missing requirement projection never masquerades as all-resolved', () => {
  const session = eventlog.createSession({ id: 'role-budget-missing-projection', kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'perform novel action work' },
  });
  const governor = new DiscoveryGovernor();
  governor.initializeTask({ sessionId: session.id, sourceUserSeq: source.seq, knownCapability: false });
  const compatibility = governor.initializeRoles({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    requirements: [],
    brokerCoverage: 'authorized_external_v1',
  });
  assert.equal(compatibility.policy.roleScoped, false);
  assert.equal(governor.admit({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    category: 'broad_discovery',
    callId: 'missing-projection-search',
  }).admitted, true);
});

test('only the tool_search broker transports broad role identity on Codex and Claude spellings', () => {
  const roleKey = 'clause-4:unknown';
  for (const [name, input] of [
    ['tool_search', { query: 'find a capability', role_key: roleKey }],
    ['mcp__clementine-local__tool_search', { query: 'find a capability', role_key: roleKey }],
    ['ToolSearch', { query: `[role:${roleKey}] find a capability` }],
  ] as const) {
    assert.deepEqual(classifyDiscoveryCall(name, input), {
      category: 'broad_discovery',
      subject: roleKey,
      surface: 'tool_search',
    });
  }
  assert.deepEqual(
    classifyDiscoveryCall('ToolSearch', { query: `[role:${roleKey}] select:mcp__alpha__read_rows` }),
    {
      category: 'exact_schema_refresh',
      subject: 'alpha__read_rows',
      surface: 'tool_search',
    },
    'the opaque prefix never contaminates exact tool identity',
  );
  assert.equal(classifyDiscoveryCall('composio_search_tools', {
    query: 'find a capability',
    role_key: roleKey,
  })?.subject, '', 'alternate broad surfaces cannot smuggle a role field');
});

test('the candidate card exposes only unresolved opaque roles and the broker schema accepts the key', async () => {
  const card = renderCapabilityCandidateCard({
    candidates: [],
    matches: [],
    pinnedTools: [],
    semanticApplied: false,
    requirements: [
      { roleKey: 'clause-0:read', text: 'collect source rows', resolved: true },
      { roleKey: 'clause-1:write', text: 'create the requested artifact', resolved: false },
    ],
  } as never);
  assert.match(card, /role_key `clause-1:write`/);
  assert.doesNotMatch(card, /role_key `clause-0:read`/);
  assert.match(card, /For broad `tool_search`/);
  assert.match(card, /\[role:<role_key>\]/);

  let shape: Record<string, unknown> | undefined;
  let handler: ((input: Record<string, unknown>) => Promise<unknown>) | undefined;
  registerToolSearchTool({
    tool: (_name: string, _description: string, parameters: Record<string, unknown>, fn: typeof handler) => {
      shape = parameters;
      handler = fn;
    },
  } as never, { allowedNames: new Set(['workspace_roots']) });
  assert.ok(shape?.role_key, 'the one broad broker exposes role_key');
  const result = await handler?.({
    query: 'workspace roots',
    role_key: 'clause-1:write',
  }) as { content?: Array<{ text?: string }> } | undefined;
  assert.match(result?.content?.[0]?.text ?? '', /"role_key":"clause-1:write"/);
});
