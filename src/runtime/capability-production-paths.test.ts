/**
 * Production-path pins.
 *
 * These deliberately do NOT call helpers in isolation. Each one enters the real
 * producer, the real constructor, or the real settlement path, and asserts an
 * observable side effect — a server that was never connected, a call that never
 * reached a transport, a budget that did or did not move. A green helper test
 * proves a function works; only these prove the runtime uses it.
 *
 * Servers are fictional (alpha/beta/gamma) so nothing here can pass by knowing
 * a real provider's name.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-production-paths-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-production-paths\n', 'utf-8');
mkdirSync(path.join(TMP_HOME, 'mcp'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'mcp', 'servers.json'), JSON.stringify({
  alpha: { type: 'stdio', command: 'node', args: ['alpha.js'], enabled: true },
  beta: { type: 'stdio', command: 'node', args: ['beta.js'], enabled: true },
  gamma: { type: 'stdio', command: 'node', args: ['gamma.js'], enabled: true },
}), 'utf-8');

const eventlog = await import('./harness/eventlog.js');
const { mcpToolAllowedByScope } = await import('./mcp-tool-authority.js');
const { resolveMcpToolScope, mcpToolScopeAuthority } = await import('./mcp-tool-scope.js');
const {
  externalMcpScopeFromResolvedTools,
  externalMcpScopeFromExactToolNames,
  workerPacketMcpToolScope,
} = await import('../agents/external-mcp-scope-lock.js');
const { mcpServersTestHooks, enabledExternalServerNames } = await import('./mcp-servers.js');
const { withHarnessRunContext, ToolCallsCounter } = await import('./harness/brackets.js');
const { recordTurnGraphShadow } = await import('./graph/turn-graph-shadow.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

const SERVERS = ['alpha', 'beta', 'gamma'];

// ── P0.1 — the real producer, not an inference ───────────────────────────────

test('a real wildcard worker producer emits server_set and cannot execute a sibling', () => {
  // This is the production path an orchestrator worker takes: prose naming a
  // server family becomes the lane's lease.
  const scope = externalMcpScopeFromResolvedTools('use `alpha__*` for this step', SERVERS);
  assert.ok(scope, 'the real producer must yield a lease');
  assert.equal(scope!.authority, 'server_set', 'stated by the producer, not inferred');
  assert.equal(mcpToolAllowedByScope('alpha__do_thing', scope!), true);
  assert.equal(
    mcpToolAllowedByScope('beta__do_thing', scope!),
    false,
    'a bounded worker must not reach a sibling system',
  );
});

test('a real typed lease producer emits exact and refuses same-server siblings', () => {
  const scope = externalMcpScopeFromExactToolNames(['alpha__read_one'], SERVERS);
  assert.ok(scope);
  assert.equal(scope!.authority, 'exact');
  assert.equal(mcpToolAllowedByScope('alpha__read_one', scope!), true);
  assert.equal(mcpToolAllowedByScope('alpha__read_one_more', scope!), false);
  assert.equal(mcpToolAllowedByScope('beta__read_one', scope!), false);
});

test('the real intersection keeps the strictest authority, never the looser side', () => {
  const parentCatalog = {
    reason: 'chat turn',
    authority: 'catalog' as const,
    failOpenCandidate: true,
    maxTools: 12,
  };
  const composed = workerPacketMcpToolScope({
    buildScope: parentCatalog,
    runtimeScope: undefined,
    resolvedTools: 'use `alpha__*`',
    serverNames: SERVERS,
  });
  assert.ok(composed);
  assert.equal(
    mcpToolScopeAuthority(composed as never),
    'server_set',
    'a catalog parent must not relax a bounded child',
  );
  assert.equal(mcpToolAllowedByScope('beta__anything', composed as never), false);

  // ...and the reverse: a bounded parent is not widened by a broad child.
  const boundedParent = {
    reason: 'bound lane',
    authority: 'server_set' as const,
    allowedServerSlugs: ['alpha'],
  };
  const widened = workerPacketMcpToolScope({
    buildScope: boundedParent,
    runtimeScope: undefined,
    resolvedTools: 'use `alpha__x` and `beta__y`',
    serverNames: SERVERS,
  });
  assert.equal(
    widened === null || mcpToolAllowedByScope('beta__y', widened as never),
    false,
    'a child may narrow its parent but never widen it',
  );
});

// ── P0.2 — an exclusion reaches zero provider contact ────────────────────────

test('a mixed allow/deny turn makes the excluded server unexecutable and unbuilt', () => {
  const scope = resolveMcpToolScope({
    userInput: 'pull the rows from alpha; do not use beta for anything',
    configuredServerNames: enabledExternalServerNames(),
  });
  assert.deepEqual(scope.deniedServerSlugs, ['beta'], 'the refusal is structural');
  assert.equal(mcpToolAllowedByScope('beta__send', scope), false, 'excluded means unexecutable');

  // The decisive assertion: nothing for beta is ever CONSTRUCTED. Filtering it
  // out of an advertised list would still have spawned and handshaked it.
  mcpServersTestHooks.resetCachesForTests?.();
  mcpServersTestHooks.getOrCreate({
    ...scope,
    allowedServerSlugs: ['alpha', 'beta'],
    maxTools: 8,
  });
  const built = mcpServersTestHooks.cacheState().scopedExternalBaseKeys.join('|');
  assert.ok(!built.includes('beta'), `beta must never be constructed; built=[${built}]`);
  assert.ok(built.includes('alpha'), `alpha should still be built; built=[${built}]`);
});

// ── PHASE A: the constraint compiler, on the real resolver ───────────────────

/**
 * Multiword configured names, so "Alpha Sheets" and "Alpha Drive" share a word
 * and the shared word must never decide which one the user meant.
 */
const MULTIWORD_CATALOG = ['Alpha Sheets', 'Alpha Drive', 'Beta Mail', 'Gamma CRM'];

test('PHASE A: an exception inside a refusal GRANTS, it does not ban', () => {
  const scope = resolveMcpToolScope({
    userInput: 'Do not call external connectors except Gamma CRM',
    configuredServerNames: MULTIWORD_CATALOG,
  });
  assert.equal(mcpToolScopeAuthority(scope), 'server_set', 'the carve-out is the whole permission');
  assert.deepEqual(scope.allowedServerSlugs, ['gamma_crm']);
  assert.equal(mcpToolAllowedByScope('gamma_crm__query', scope), true, 'the exception is permitted');
  for (const other of ['alpha_sheets__read', 'beta_mail__send', 'alpha_drive__list']) {
    assert.equal(mcpToolAllowedByScope(other, scope), false, `${other} must stay refused`);
  }
});

test('PHASE A: "use only X, never Y" restricts to X and forbids Y', () => {
  const scope = resolveMcpToolScope({
    userInput: 'Use only Alpha Sheets, never Beta Mail',
    configuredServerNames: MULTIWORD_CATALOG,
  });
  assert.equal(mcpToolScopeAuthority(scope), 'server_set');
  assert.deepEqual(scope.allowedServerSlugs, ['alpha_sheets']);
  assert.equal(mcpToolAllowedByScope('alpha_sheets__append', scope), true);
  assert.equal(mcpToolAllowedByScope('beta_mail__send', scope), false);
  assert.equal(
    mcpToolAllowedByScope('gamma_crm__query', scope),
    false,
    '"only" excludes systems the user never mentioned',
  );
});

test('PHASE A: "use X, not Y" keeps X usable and Y forbidden', () => {
  const scope = resolveMcpToolScope({
    userInput: 'Use Alpha Sheets, not Beta Mail',
    configuredServerNames: MULTIWORD_CATALOG,
  });
  assert.equal(mcpToolAllowedByScope('alpha_sheets__append', scope), true);
  assert.equal(mcpToolAllowedByScope('beta_mail__send', scope), false, 'the named refusal holds');
});

test('PHASE A: a multiword name is matched whole and its shared word decides nothing', () => {
  const scope = resolveMcpToolScope({
    userInput: 'pull the rows but do not use Alpha Drive',
    configuredServerNames: MULTIWORD_CATALOG,
  });
  assert.deepEqual(scope.deniedServerSlugs, ['alpha_drive']);
  assert.equal(mcpToolAllowedByScope('alpha_drive__download', scope), false);
  assert.equal(
    mcpToolAllowedByScope('alpha_sheets__read', scope),
    true,
    'the sibling that merely shares a word stays reachable',
  );
});

test('PHASE A: consent survives the advertisement kill-switch', () => {
  const previous = process.env.CLEMMY_SCOPED_MCP_TOOLS;
  process.env.CLEMMY_SCOPED_MCP_TOOLS = 'off';
  try {
    const scope = resolveMcpToolScope({
      userInput: 'do not use any external connectors for this',
      configuredServerNames: MULTIWORD_CATALOG,
    });
    assert.equal(mcpToolScopeAuthority(scope), 'none', 'a display flag cannot revoke a refusal');
    assert.notEqual(scope.allowAll, true);
    for (const tool of ['alpha_sheets__read', 'beta_mail__send']) {
      assert.equal(mcpToolAllowedByScope(tool, scope), false);
    }
  } finally {
    if (previous === undefined) delete process.env.CLEMMY_SCOPED_MCP_TOOLS;
    else process.env.CLEMMY_SCOPED_MCP_TOOLS = previous;
  }
});

test('PHASE A: an excluded system is never constructed on the real path', () => {
  const scope = resolveMcpToolScope({
    userInput: 'read from alpha but do not use beta',
    configuredServerNames: enabledExternalServerNames(),
  });
  mcpServersTestHooks.resetCachesForTests?.();
  mcpServersTestHooks.getOrCreate({ ...scope, allowedServerSlugs: ['alpha', 'beta'], maxTools: 8 });
  const state = mcpServersTestHooks.cacheState();
  const built = [...state.scopedExternalBaseKeys, state.allExternalBaseCreated ? 'ALL' : ''].join('|');
  assert.ok(!built.includes('beta') && !built.includes('ALL'), `beta must never be built; built=[${built}]`);
});

test('an "everything except X" turn excludes only X and keeps the rest reachable', () => {
  const scope = resolveMcpToolScope({
    userInput: 'check anything except gamma and report back',
    configuredServerNames: enabledExternalServerNames(),
  });
  assert.deepEqual(scope.deniedServerSlugs, ['gamma']);
  assert.equal(mcpToolAllowedByScope('gamma__read', scope), false);
  assert.equal(mcpToolAllowedByScope('alpha__read', scope), true);
});

// ── Shared settlement: one seam, structured evidence, enacted directive ──────

function acceptedTask(label: string): { sessionId: string; sourceUserSeq: number } {
  const session = eventlog.createSession({ id: `prod-settle-${label}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: `${label} task` },
  });
  // Durable settlement authority: the accepted source above plus a persisted
  // turn graph for the accepted task (authority spine).
  assert.ok(recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn },
  }), 'fixture persisted the turn graph for the accepted task');
  return { sessionId: session.id, sourceUserSeq: source.seq };
}

test('a returned 400 repairs the call and does NOT spend a discovery epoch', async () => {
  const { settleToolAttempt } = await import('./harness/attempt-settlement.js');
  const { DiscoveryGovernor } = await import('./harness/discovery-governor.js');
  const key = acceptedTask('http400');
  const governor = new DiscoveryGovernor();
  governor.initializeTask({ ...key, knownCapability: false });
  governor.admit({ ...key, category: 'broad_discovery', callId: 'search-1' });

  // Every lane opens a logical tool call before settling; an uncorrelated
  // settlement is refused, so modelling the lane means opening one here too.
  const { withLogicalToolCall } = await import('./harness/attempt-identity.js');
  const settled = withLogicalToolCall(
    { ...key, tool: 'alpha__create' },
    () => settleToolAttempt({
      ...key, lane: 'native_mcp', toolName: 'alpha__create', businessCall: true,
      result: { status: 400, error: 'missing required field' },
    }),
  );
  assert.equal(settled.outcome.kind, 'invalid_arguments');
  assert.equal(settled.outcome.evidence, 'structured');
  assert.equal(settled.outcome.directive.retrySameCandidate, true, 'the call is repairable');
  assert.equal(settled.openedDiscoveryEpoch, false);
  assert.equal(governor.getTaskState(key)?.policy.epoch, 0, 'a typo must not cost the search budget');
});

test('a THROWN unsupported error eliminates the candidate and reopens discovery', async () => {
  const { settleToolAttempt } = await import('./harness/attempt-settlement.js');
  const { DiscoveryGovernor } = await import('./harness/discovery-governor.js');
  const key = acceptedTask('thrown-unsupported');
  const governor = new DiscoveryGovernor();
  governor.initializeTask({ ...key, knownCapability: false });
  governor.admit({ ...key, category: 'broad_discovery', callId: 'search-1' });

  const thrown = Object.assign(new Error('operation not available'), { status: 501 });
  // Every lane opens a logical tool call before settling; an uncorrelated
  // settlement is refused, so modelling the lane means opening one here too.
  const { withLogicalToolCall } = await import('./harness/attempt-identity.js');
  const settled = withLogicalToolCall({ ...key, tool: 'alpha__unsupported' }, () => settleToolAttempt({
    ...key, lane: 'native_mcp', toolName: 'alpha__unsupported', businessCall: true, thrown,
  }));
  assert.equal(settled.outcome.kind, 'unsupported_capability');
  assert.equal(settled.outcome.directive.eliminatesCandidate, true);
  assert.equal(settled.openedDiscoveryEpoch, true, 'the search must come back');
  assert.equal(governor.getTaskState(key)?.policy.epoch, 1);
});

test('an uncertain mutation reconciles and is never replayed', async () => {
  const { settleToolAttempt } = await import('./harness/attempt-settlement.js');
  const { DiscoveryGovernor } = await import('./harness/discovery-governor.js');
  const key = acceptedTask('uncertain-write');
  const governor = new DiscoveryGovernor();
  governor.initializeTask({ ...key, knownCapability: false });
  governor.admit({ ...key, category: 'broad_discovery', callId: 'search-1' });

  // Every lane opens a logical tool call before settling; an uncorrelated
  // settlement is refused, so modelling the lane means opening one here too.
  const { withLogicalToolCall } = await import('./harness/attempt-identity.js');
  const settled = withLogicalToolCall(
    { ...key, tool: 'alpha__send' },
    () => settleToolAttempt({
      ...key, lane: 'native_mcp', toolName: 'alpha__send', mutating: true, businessCall: true,
      thrown: new Error('socket hang up'),
    }),
  );
  assert.equal(settled.outcome.kind, 'uncertain_write');
  assert.equal(settled.outcome.directive.requiresReconciliation, true);
  assert.equal(settled.outcome.directive.retrySameCandidate, false, 'never replay an unacknowledged write');
  assert.equal(
    governor.getTaskState(key)?.policy.epoch, 0,
    'and never go shopping for another way to send it',
  );
});

test('capability_satisfied comes from a successful BUSINESS call, not from looking around', async () => {
  const { settleToolAttempt } = await import('./harness/attempt-settlement.js');
  const { DiscoveryGovernor } = await import('./harness/discovery-governor.js');
  const key = acceptedTask('progress');
  const governor = new DiscoveryGovernor();
  governor.initializeTask({ ...key, knownCapability: false });
  governor.admit({ ...key, category: 'broad_discovery', callId: 'search-1' });

  // Three SEPARATE logical tool calls. Each opens its own, the way a lane does:
  // sharing one would make the second and third duplicates of the first.
  const { withLogicalToolCall } = await import('./harness/attempt-identity.js');

  // Succeeding at discovery is not progress.
  withLogicalToolCall({ ...key, tool: 'alpha__list' }, () => settleToolAttempt({
    ...key, lane: 'native_mcp', toolName: 'alpha__list', businessCall: false,
    result: { successful: true, data: [{ id: 1 }] },
  }));
  assert.equal(governor.getTaskState(key)?.policy.epoch, 0, 'a search is not a finished step');

  // Neither is an empty answer.
  withLogicalToolCall({ ...key, tool: 'alpha__read' }, () => settleToolAttempt({
    ...key, lane: 'native_mcp', toolName: 'alpha__read', businessCall: true,
    result: { successful: true, data: [] },
  }));
  assert.equal(governor.getTaskState(key)?.policy.epoch, 0, 'nothing found is not progress');

  // Real work is.
  const done = withLogicalToolCall({ ...key, tool: 'alpha__read' }, () => settleToolAttempt({
    ...key, lane: 'native_mcp', toolName: 'alpha__read', businessCall: true,
    result: { successful: true, data: [{ id: 1 }] },
  }));
  assert.equal(done.creditedProgress, true);
  assert.equal(governor.getTaskState(key)?.policy.epoch, 1, 'the next requirement is genuinely new');
});

// ── Concurrent searches keep their own attribution ───────────────────────────

test('two concurrent searches in one task each keep the slug they surfaced', async () => {
  const composio = await import('../tools/composio-tools.js');
  const key = acceptedTask('two-searches');

  await withHarnessRunContext(
    { sessionId: key.sessionId, sourceUserSeq: key.sourceUserSeq, counter: new ToolCallsCounter(20) } as never,
    async () => {
      composio.noteComposioSearchIntent(key.sessionId, 'find a way to read rows', ['ALPHA_LIST_ROWS']);
      composio.noteComposioSearchIntent(key.sessionId, 'find a way to notify the team', ['BETA_SEND_NOTE']);

      // Recency would credit the notify search for BOTH slugs. Correlation by
      // what each search actually surfaced is what keeps them straight.
      assert.match(
        composio.executionIntentForSession(key.sessionId, 'ALPHA_LIST_ROWS'),
        /read rows/,
        'the read slug keeps the read search',
      );
      assert.match(
        composio.executionIntentForSession(key.sessionId, 'BETA_SEND_NOTE'),
        /notify the team/,
        'the notify slug keeps the notify search',
      );
    },
  );
});

test('canonical exact subjects collapse every spelling of one tool to one key', async () => {
  const { canonicalExactSubject } = await import('./harness/discovery-boundary.js');
  const spellings = [
    'alpha__read_rows',
    'mcp__alpha__read_rows',
    '`alpha__read_rows`',
    'select:mcp__alpha__read_rows',
    'show me the alpha__read_rows schema please',
    '"alpha__read_rows"',
  ];
  const keys = new Set(spellings.map(canonicalExactSubject));
  assert.equal(keys.size, 1, `one tool must be one key, got ${[...keys].join(' | ')}`);
  assert.equal([...keys][0], 'alpha__read_rows');
  // ...and a genuinely different tool stays a different key.
  assert.notEqual(canonicalExactSubject('alpha__write_rows'), [...keys][0]);
});

// ── P0.3 — the ambient ceiling binds every caller shape ──────────────────────

test('an exact ambient lease stops a helper constructing an unrelated server', async () => {
  const ambient = {
    reason: 'typed lease on alpha',
    authority: 'exact' as const,
    allowedServerSlugs: ['alpha'],
    allowedToolNames: ['alpha__read_one'],
  };

  for (const [label, requested] of [
    ['undefined caller scope', undefined],
    ['allowAll caller scope', { reason: 'helper', allowAll: true }],
    ['catalog caller scope', { reason: 'helper', authority: 'catalog' as const, allowedServerSlugs: ['beta'], maxTools: 50 }],
    ['server_set caller scope', { reason: 'helper', authority: 'server_set' as const, allowedServerSlugs: ['beta'] }],
  ] as const) {
    mcpServersTestHooks.resetCachesForTests?.();
    await withHarnessRunContext(
      { sessionId: 'prod-paths-ceiling', counter: new ToolCallsCounter(5), mcpToolScope: ambient } as never,
      async () => { mcpServersTestHooks.getOrCreate(requested as never); },
    );
    const state = mcpServersTestHooks.cacheState();
    const built = [...state.scopedExternalBaseKeys, state.allExternalBaseCreated ? 'ALL' : ''].join('|');
    assert.ok(
      !built.includes('beta') && !built.includes('ALL'),
      `${label}: nothing outside the lease may be constructed; built=[${built}]`,
    );
  }
});
