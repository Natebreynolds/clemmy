import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-capability-recovery-'));
process.env.CLEMENTINE_HOME = TMP_HOME;

const eventlog = await import('./harness/eventlog.js');
const { DiscoveryGovernor, MAX_DISCOVERY_EPOCHS } = await import('./harness/discovery-governor.js');
const { mcpToolAllowedByScope } = await import('./mcp-tool-authority.js');
const { filterMcpToolsForScope } = await import('./mcp-tool-filter.js');
const { mcpServersTestHooks } = await import('./mcp-servers.js');
const { recordTurnGraphShadow } = await import('./graph/turn-graph-shadow.js');

test.after(() => {
  eventlog.closeEventLog();
  if (!process.env.CLEM_TEST_KEEP_HOME) rmSync(TMP_HOME, { recursive: true, force: true });
});

/**
 * A catalog big enough that the needed tool is never conveniently first.
 *
 * Deterministic but adversarial: the order is a fixed shuffle, so the tool a
 * scenario needs sits wherever the shuffle put it rather than wherever a
 * fixture author would have put it. A pass here means the mechanism worked, not
 * that the fixture was kind.
 */
function largeAuthorizedCatalog(): Array<{ name: string; description: string }> {
  const servers = ['dataforseo', 'outlook', 'salesforce', 'airtable', 'slack', 'github', 'sheets'];
  const ops = ['search', 'list', 'get', 'create', 'update', 'delete', 'summarize'];
  const tools: Array<{ name: string; description: string }> = [];
  for (const server of servers) {
    for (const op of ops) {
      tools.push({ name: `${server}__${op}_record`, description: `${op} a ${server} record` });
    }
  }
  // Fixed multiplicative shuffle — reproducible, and unrelated to insertion order.
  return tools
    .map((tool, index) => ({ tool, key: (index * 37) % tools.length }))
    .sort((a, b) => a.key - b.key)
    .map((entry) => entry.tool);
}

function acceptedTask(label: string): { sessionId: string; sourceUserSeq: number; turn: number } {
  const session = eventlog.createSession({ id: `capability-recovery-${label}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: `do the ${label} task` },
  });
  // A dispatch settles against the accepted source that authorized it, and the
  // persisted graph is what makes that source an authority the ledger accepts.
  assert.ok(recordTurnGraphShadow({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn },
  }), 'fixture persisted the turn graph for the accepted task');
  return { sessionId: session.id, sourceUserSeq: source.seq, turn: source.turn };
}

function fakeBase(tools: Array<{ name: string; description: string }>) {
  const dispatched: string[] = [];
  return {
    dispatched,
    server: {
      cacheToolsList: true,
      name: 'fake-large-catalog',
      async connect() {},
      async close() {},
      async listTools() {
        return tools;
      },
      async callTool(toolName: string) {
        dispatched.push(toolName);
        return [{ type: 'text', text: 'ok' }];
      },
      async invalidateToolsCache() {},
    },
  };
}

// ── Scenario 1 + 2: the required tool is outside the initial working set ──────

test('scenario 1/2: a required authorized tool outside the working set still runs', async () => {
  const catalog = largeAuthorizedCatalog();
  assert.ok(catalog.length > 40, `catalog must be large; got ${catalog.length}`);

  const { server, dispatched } = fakeBase(catalog);
  const scope = {
    reason: 'seo intent',
    authority: 'catalog' as const,
    allowedServerSlugs: ['dataforseo'],
    priorityKeywords: ['search'],
    maxTools: 4,
  };
  const scoped = mcpServersTestHooks.scopedView(server as never, scope);

  const advertised = (await scoped.listTools()).map((tool) => tool.name);
  assert.equal(advertised.length, 4, 'the context budget is still enforced');

  // The task turns out to need an Outlook tool. It is authorized, it is
  // connected, and it is nowhere near the advertised four.
  const needed = 'outlook__create_record';
  assert.ok(!advertised.includes(needed), 'precondition: the needed tool was not advertised');
  assert.equal(mcpToolAllowedByScope(needed, scope), true, 'authorized means executable');

  await scoped.callTool(needed, {});
  assert.deepEqual(dispatched, [needed], 'a sibling system stays reachable mid-task');
});

test('scenario 1/2: the advertised cap never becomes the dispatch allowlist', async () => {
  const catalog = largeAuthorizedCatalog().filter((tool) => tool.name.startsWith('dataforseo__'));
  const { server, dispatched } = fakeBase(catalog);
  const scoped = mcpServersTestHooks.scopedView(server as never, {
    reason: 'seo intent',
    authority: 'catalog' as const,
    allowedServerSlugs: ['dataforseo'],
    maxTools: 2,
  });

  const advertised = (await scoped.listTools()).map((tool) => tool.name);
  assert.equal(advertised.length, 2);
  const dropped = catalog.map((tool) => tool.name).find((name) => !advertised.includes(name))!;

  await scoped.callTool(dropped, {});
  assert.deepEqual(dispatched, [dropped], 'the tool the cap dropped still dispatched');
});

// ── Scenario 3/4: candidate-local failover ───────────────────────────────────

test('scenario 3/4: a failed candidate reopens discovery instead of closing the class', () => {
  const key = acceptedTask('failover');
  const governor = new DiscoveryGovernor();
  governor.initializeTask({ ...key, knownCapability: false });

  const first = governor.admit({ ...key, category: 'broad_discovery', callId: 'search-1' });
  assert.equal(first.admitted, true);
  governor.settle({ ...key, category: 'broad_discovery', callId: 'search-1', outcome: 'succeeded' });

  // Same task, no new evidence: the repeat neither mints a claim nor receives
  // provider authority under a different physical id.
  const repeat = governor.admit({ ...key, category: 'broad_discovery', callId: 'search-2' });
  assert.equal(repeat.admitted, false);
  assert.equal(repeat.reason, 'new_call_requires_retry_epoch');
  assert.equal(repeat.consumedBudget, false);

  // The candidate that search produced turns out not to support the operation.
  const evidence = governor.recordEvidence({
    ...key,
    kind: 'candidate_unsupported',
    detail: 'SOME_TOOL_SLUG',
  });
  assert.equal(evidence.outcome, 'epoch_opened');
  assert.equal(evidence.epoch, 1);

  // Now looking for a sibling is allowed — the capability class was never the
  // thing that failed.
  const sibling = governor.admit({ ...key, category: 'broad_discovery', callId: 'search-3' });
  assert.equal(sibling.admitted, true);
  assert.equal(sibling.reason, 'new_evidence_admitted');
});

test('scenario 3: repairing a DIFFERENT tool never spends the first tool schema budget', () => {
  const key = acceptedTask('schema-per-subject');
  const governor = new DiscoveryGovernor();
  governor.initializeTask({ ...key, knownCapability: false });

  const first = governor.admit({
    ...key, category: 'exact_schema_refresh', subject: 'OUTLOOK_SEND_MAIL', callId: 'schema-1',
  });
  assert.equal(first.admitted, true);

  // A second tool needs its callable schema to repair an invalid-argument call.
  // Charging that against the first tool is what turned one bad argument into a
  // guessing spiral.
  const second = governor.admit({
    ...key, category: 'exact_schema_refresh', subject: 'AIRTABLE_CREATE_RECORD', callId: 'schema-2',
  });
  assert.equal(second.admitted, true, 'a different tool has its own schema budget');

  // The same tool twice in one epoch mints neither a claim nor another provider
  // invocation. A different tool still keeps its independent subject above.
  const repeat = governor.admit({
    ...key, category: 'exact_schema_refresh', subject: 'OUTLOOK_SEND_MAIL', callId: 'schema-3',
  });
  assert.equal(repeat.admitted, false);
  assert.equal(repeat.reason, 'new_call_requires_retry_epoch');
  assert.equal(repeat.consumedBudget, false);
});

// ── Scenario 11/12: cold correctness, and what a receipt may change ───────────

test('scenario 11: a cold user with no learned memory gets a full discovery budget', () => {
  const key = acceptedTask('cold');
  const governor = new DiscoveryGovernor();
  const init = governor.initializeTask({ ...key, knownCapability: false });
  assert.equal(init.policy.broadDiscoveryAllowance, 1);
  assert.equal(governor.admit({ ...key, category: 'broad_discovery', callId: 'cold-1' }).admitted, true);
});

test('scenario 12: a warm receipt orders the work but never withholds bounded discovery', () => {
  const key = acceptedTask('warm');
  const governor = new DiscoveryGovernor();
  governor.initializeTask({ ...key, knownCapability: true });

  // The receipt ranks the remembered path, but a task-global bit cannot prove
  // that every capability in a multi-system request is covered.
  const first = governor.admit({ ...key, category: 'broad_discovery', callId: 'warm-search-1' });
  assert.equal(first.admitted, true);
  assert.equal(first.reason, 'novel_discovery_admitted');

  // The attempted path fails. Observed evidence opens one new bounded epoch.
  const evidence = governor.recordEvidence({
    ...key, kind: 'candidate_unsupported', detail: 'STALE_REMEMBERED_SLUG',
  });
  assert.equal(evidence.outcome, 'epoch_opened');

  const recovery = governor.admit({ ...key, category: 'broad_discovery', callId: 'warm-search-2' });
  assert.equal(recovery.admitted, true, 'a stale receipt costs one attempt, not the task');
  assert.equal(
    governor.getTaskState(key)?.policy.knownCapability,
    true,
    'the receipt itself is unchanged — it ranks, it does not gate',
  );
});

// ── Bounded recovery: it must terminate ──────────────────────────────────────

test('recovery is bounded: a task that has tried every angle stops hunting', () => {
  const key = acceptedTask('bounded');
  const governor = new DiscoveryGovernor();
  governor.initializeTask({ ...key, knownCapability: false });

  let opened = 0;
  for (let attempt = 0; attempt < MAX_DISCOVERY_EPOCHS + 3; attempt += 1) {
    const epoch = governor.getTaskState(key)?.policy.epoch ?? 0;
    const decision = governor.admit({
      ...key, category: 'broad_discovery', callId: `bounded-${attempt}`,
    });
    if (decision.admitted) {
      governor.settle({
        ...key, category: 'broad_discovery', callId: `bounded-${attempt}`, outcome: 'failed',
      });
    }
    const evidence = governor.recordEvidence({ ...key, kind: 'candidate_unavailable' });
    if (evidence.outcome === 'epoch_opened') opened += 1;
    if (evidence.outcome === 'epoch_ceiling_reached') {
      assert.equal(epoch, MAX_DISCOVERY_EPOCHS - 1);
      break;
    }
  }
  assert.equal(opened, MAX_DISCOVERY_EPOCHS - 1, 'epochs are capped, not unlimited');
  assert.equal(
    governor.recordEvidence({ ...key, kind: 'candidate_unavailable' }).outcome,
    'epoch_ceiling_reached',
    'past the ceiling, more searching is not the answer',
  );
});

// ── Scenario 10: a genuine policy denial stops safely ────────────────────────

test('scenario 10: a user prohibition denies every tool, however exactly it is named', () => {
  const denied = {
    reason: 'user declined external connectors',
    authority: 'none' as const,
    allowedServerSlugs: [],
    maxTools: 0,
  };
  for (const tool of largeAuthorizedCatalog().slice(0, 10)) {
    assert.equal(mcpToolAllowedByScope(tool.name, denied), false, tool.name);
  }
});

// ── The wiring, not just the mechanism ───────────────────────────────────────

test('a real failed dispatch reopens the epoch — the recovery path is CONNECTED', async () => {
  const { runComposioExecuteForTestInSession } = await import('../tools/composio-tools.js');
  const { withHarnessRunContext, ToolCallsCounter } = await import('./harness/brackets.js');

  const key = acceptedTask('wired');
  const governor = new DiscoveryGovernor();
  // A warm task: memory ranks a capability but never removes its bounded search.
  governor.initializeTask({ ...key, knownCapability: true });
  assert.equal(
    governor.admit({ ...key, category: 'broad_discovery', callId: 'wired-search-1' }).admitted,
    true,
  );

  // An act-routed source arms the expected-work wall; the dispatch rides the
  // same mandate live traffic uses — a resolved-approved card for the exact
  // call — so the failed PROVIDER result (not a wall refusal) is what travels.
  const approvals = await import('./harness/approval-registry.js');
  const card = approvals.register({
    sessionId: key.sessionId,
    subject: 'Run SOME_LIST_RECORDS',
    tool: 'SOME_LIST_RECORDS',
    args: {},
  });
  approvals.resolve(card.approvalId, 'approved', 'fixture-user');

  // Drive the ACTUAL dispatch entry point with a failed provider result, so the
  // evidence has to travel the whole way — execute -> attempt settlement ->
  // governor. If this pin called the governor (or a learning helper beside it)
  // directly it would prove the function works while the runtime never reaches
  // it, which is how the escape hatch came to exist unwired in the first place.
  await withHarnessRunContext(
    { ...key, counter: new ToolCallsCounter(10) },
    () => runComposioExecuteForTestInSession(
      'SOME_LIST_RECORDS',
      {},
      // A bare `successful:false` is deliberately inert now (it proves the
      // attempt failed, not that the capability is absent). The epoch reopens
      // on NARROW rejection evidence — an explicit pre-effect status.
      (async () => ({ successful: false, status: 405, error: 'unsupported operation', data: {} })) as never,
      key.sessionId,
    ),
  );

  assert.equal(
    governor.getTaskState(key)?.policy.epoch,
    1,
    'a failed READ candidate must reopen discovery through the live code path',
  );
  const recovery = governor.admit({
    ...key, category: 'broad_discovery', callId: 'wired-search-2',
  });
  assert.equal(recovery.admitted, true, 'and the reopened budget is usable');
});

test('a failed WRITE reconciles instead of hunting for a sibling', async () => {
  const { runComposioExecuteForTestInSession } = await import('../tools/composio-tools.js');
  const { withHarnessRunContext, ToolCallsCounter } = await import('./harness/brackets.js');

  const key = acceptedTask('write-no-hunt');
  const governor = new DiscoveryGovernor();
  governor.initializeTask({ ...key, knownCapability: false });
  governor.admit({ ...key, category: 'broad_discovery', callId: 'write-search-1' });

  // The same live dispatch path as its READ sibling above — the difference the
  // pin is proving belongs to the effect class, not to how the test called in.
  await withHarnessRunContext(
    { ...key, counter: new ToolCallsCounter(10) },
    () => runComposioExecuteForTestInSession(
      'SOME_SEND_MESSAGE',
      {},
      (async () => ({ successful: false, error: 'gateway timeout', data: {} })) as never,
      key.sessionId,
    ),
  );

  // A mutation whose fate is unknown must be reconciled, not replaced. Sending
  // the user's message twice because the first attempt was ambiguous is worse
  // than not sending it at all.
  assert.equal(
    governor.getTaskState(key)?.policy.epoch,
    0,
    'an unacknowledged write must not open a search for another way to send it',
  );
});

// ── Producer/consumer agreement ──────────────────────────────────────────────

test('every scope the resolver produces states its authority outright', async () => {
  const { resolveMcpToolScope, resolveMcpToolScopeWithContinuity, mcpToolScopeAuthority } =
    await import('./mcp-tool-scope.js');

  // A prohibition and a budget both advertise nothing. The whole defect was
  // that they were indistinguishable downstream, so the resolver must be the
  // one that tells them apart — never a hand-written fixture, and never a
  // reader inferring intent from a zero.
  const prohibitions = [
    'use only local memory for this',
    'do not call any external connectors',
  ];
  for (const input of prohibitions) {
    const scope = resolveMcpToolScope({ userInput: input });
    assert.equal(scope.authority, 'none', `prohibition must be explicit: ${input}`);
  }

  const declined = resolveMcpToolScopeWithContinuity({
    userInput: 'no thanks',
    answerDisposition: 'declined',
  });
  assert.equal(declined.authority, 'none', 'a decline is zero authority');

  const budgets = [
    'update the report we just ran with what we already have',
    'deploy the site to netlify',
    'draft an outlook email to the team',
    'something entirely unrecognised by any keyword family',
  ];
  for (const input of budgets) {
    const scope = resolveMcpToolScope({ userInput: input });
    assert.equal(
      mcpToolScopeAuthority(scope),
      'catalog',
      `advertising little is not a prohibition: ${input}`,
    );
  }
});

// ── The separation itself ────────────────────────────────────────────────────

test('the working set is a budget and the catalog is the boundary', () => {
  const catalog = largeAuthorizedCatalog();
  const scope = {
    reason: 'narrow relevance guess',
    authority: 'catalog' as const,
    allowedServerSlugs: ['dataforseo'],
    toolPatterns: ['search'],
    maxTools: 3,
  };

  const advertised = filterMcpToolsForScope(catalog as never, scope).map((tool) => tool.name);
  assert.ok(advertised.length <= 3, 'the budget bounds what the model is shown');
  assert.ok(
    advertised.every((name) => name.startsWith('dataforseo__')),
    'relevance still decides what is shown first',
  );

  // ...and every one of those decisions is invisible to authority.
  const everythingAuthorized = catalog.every((tool) => mcpToolAllowedByScope(tool.name, scope));
  assert.equal(everythingAuthorized, true, 'no relevance signal may withdraw authority');
});
