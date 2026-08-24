/**
 * The authority + typed-recovery kernel, pinned defect by defect.
 *
 * Each test here corresponds to a production probe that reproduced after the
 * first wave. They are written to FAIL against the pre-kernel runtime, so a
 * green run means the behaviour actually moved — not that a helper exists.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clemmy-authority-kernel-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'machine-authority-kernel\n', 'utf-8');
mkdirSync(path.join(TMP_HOME, 'mcp'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'mcp', 'servers.json'), JSON.stringify({
  firecrawl: { type: 'stdio', command: 'node', args: ['fc.js'], enabled: true },
  salesforce: { type: 'stdio', command: 'node', args: ['sf.js'], enabled: true },
  outlook: { type: 'stdio', command: 'node', args: ['ol.js'], enabled: true },
}), 'utf-8');

const eventlog = await import('./harness/eventlog.js');
const { mcpToolAllowedByScope } = await import('./mcp-tool-authority.js');
const { resolveMcpToolScopeWithContinuity } = await import('./mcp-tool-scope.js');
const { DiscoveryGovernor } = await import('./harness/discovery-governor.js');
const { admitDiscoveryBoundary, classifyDiscoveryCall } = await import('./harness/discovery-boundary.js');
const { mcpServersTestHooks } = await import('./mcp-servers.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TMP_HOME, { recursive: true, force: true });
});

function acceptedTask(label: string): { sessionId: string; sourceUserSeq: number } {
  const session = eventlog.createSession({ id: `authority-kernel-${label}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: `${label} task` },
  });
  return { sessionId: session.id, sourceUserSeq: source.seq };
}

// ── 1. A bounded worker does not hold the whole catalog ──────────────────────

test('D1: a server-bound worker authorizes its own server and nothing else', () => {
  // A worker handed one system is not a licence for every system the user has
  // ever connected. "Anything in the catalog" is the right default for a chat
  // turn and the wrong one for a bound lane.
  const workerScope = {
    reason: 'firecrawl-only worker lane',
    authority: 'server_set' as const,
    allowedServerSlugs: ['firecrawl'],
    maxTools: 8,
  };
  assert.equal(mcpToolAllowedByScope('firecrawl__scrape', workerScope), true);
  assert.equal(
    mcpToolAllowedByScope('salesforce__query_records', workerScope),
    false,
    'a bounded worker must not reach an unrelated authorized system',
  );
  assert.equal(
    mcpToolAllowedByScope('firecrawl_mcp_server__scrape', workerScope),
    true,
    'canonical server aliases still resolve inside the bound set',
  );
  assert.equal(
    mcpToolAllowedByScope('evil_firecrawl_proxy__scrape', workerScope),
    false,
    'a confusable namespace is not the bound server',
  );
});

// ── 2. A prohibition is not a gap for continuity to fill ─────────────────────

test('D2: an explicit no-external-tools turn never inherits a prior scope', () => {
  const scope = resolveMcpToolScopeWithContinuity({
    userInput: 'use only local memory for this — do not call any external connectors',
    priorUserInputs: ['draft an outlook email to the team about the release'],
    awaitingAnswer: true,
  });
  assert.equal(scope.authority, 'none', 'a prohibition stays a prohibition');
  assert.equal(
    mcpToolAllowedByScope('outlook__send_mail', scope),
    false,
    'continuity must not resurrect the connector the user just refused',
  );
});

// ── 3. The local inventory tool is inside the boundary, not beside it ────────

test('D3: mcp_list_tools respects a prohibition instead of minting its own scope', async () => {
  const { registerMcpStatusTools } = await import('../tools/mcp-status-tools.js');
  const { withHarnessRunContext, ToolCallsCounter } = await import('./harness/brackets.js');

  // Drive the REAL registered handler, not a reimplementation of it.
  const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
  registerMcpStatusTools({
    tool(name: string, _desc: unknown, _schema: unknown, handler: never) {
      handlers.set(name, handler as unknown as (a: Record<string, unknown>) => Promise<unknown>);
    },
  } as never);
  const listTools = handlers.get('mcp_list_tools');
  assert.ok(listTools, 'mcp_list_tools must be registered');

  const out = await withHarnessRunContext(
    {
      sessionId: 'authority-kernel-d3',
      counter: new ToolCallsCounter(10),
      mcpToolScope: {
        reason: 'user declined external connectors',
        authority: 'none',
        allowedServerSlugs: [],
        maxTools: 0,
      },
    } as never,
    () => listTools!({ server: 'outlook' }),
  );
  const rendered = JSON.stringify(out);
  assert.ok(
    !/outlook__/.test(rendered),
    `a discovery helper must not be a side door around the turn authority: ${rendered.slice(0, 300)}`,
  );
});

// ── 4. One task may legitimately need two capabilities ───────────────────────

test('D4: finishing a step earns the next search; rephrasing one does not', () => {
  const key = acceptedTask('two-capabilities');
  const governor = new DiscoveryGovernor();
  governor.initializeTask({ ...key, knownCapability: false });

  const first = governor.admit({ ...key, category: 'broad_discovery', callId: 'search-A' });
  assert.equal(first.admitted, true);
  governor.settle({
    ...key, category: 'broad_discovery', callId: 'search-A', outcome: 'succeeded',
  });

  // Shopping the same requirement around still buys no NEW claim — it replays
  // the one already held. It is no longer refused for it: measured on the real
  // home, refusing cost a model call that had already been paid for and simply
  // produced a reworded retry. One turn issued 41 discovery calls, 37 of them
  // denied. The bound that matters is "one claim per subject per epoch", and
  // that is what is asserted here.
  const shopping = governor.admit({ ...key, category: 'broad_discovery', callId: 'search-A2' });
  assert.equal(shopping.admitted, true);
  assert.equal(shopping.reason, 'subject_replay');
  assert.equal(shopping.consumedBudget, false, 'no second claim is minted');

  // Actually USING what was found is different: "pull the rankings, then email
  // them" is one task and two systems, and the second system has genuinely not
  // been searched for. Progress is evidence the model cannot fabricate.
  const progress = governor.recordEvidence({ ...key, kind: 'capability_satisfied' });
  assert.equal(progress.outcome, 'epoch_opened');

  // More progress before spending the new budget does not stack another.
  assert.equal(
    governor.recordEvidence({ ...key, kind: 'capability_satisfied' }).outcome,
    'epoch_already_fresh',
  );

  const second = governor.admit({ ...key, category: 'broad_discovery', callId: 'search-B' });
  assert.equal(second.admitted, true, 'the next requirement gets its own search');
  assert.equal(second.reason, 'new_evidence_admitted');
});

// ── 5. The subject must survive the production boundary ──────────────────────

test('D5: the production boundary carries the exact tool identity into the budget', () => {
  const key = acceptedTask('subject-survives');
  const governor = new DiscoveryGovernor();
  governor.initializeTask({ ...key, knownCapability: false });

  // Classification must extract WHICH tool a schema refresh is about...
  const classified = classifyDiscoveryCall('composio_execute_tool', {
    tool_slug: 'OUTLOOK_GET_SCHEMA',
  });
  assert.equal(classified?.category, 'exact_schema_refresh');
  assert.equal(
    classified?.subject,
    'outlook_get_schema',
    'classification must name the tool the schema belongs to',
  );

  // ...and the boundary must pass it through, or per-tool budgeting is a
  // no-op that only unit tests can see.
  const first = admitDiscoveryBoundary({
    ...key, toolName: 'tool_search', input: { query: 'OUTLOOK_SEND_MAIL' }, callId: 'schema-1',
  });
  assert.ok(first, 'an exact schema lookup is admitted');
  const second = admitDiscoveryBoundary({
    ...key, toolName: 'tool_search', input: { query: 'AIRTABLE_CREATE_RECORD' }, callId: 'schema-2',
  });
  assert.ok(second, 'a DIFFERENT tool has its own schema budget at the real boundary');

  const state = governor.getTaskState(key);
  const subjects = state?.epochClaims
    .filter((c) => c.category === 'exact_schema_refresh')
    .map((c) => c.subject)
    .sort();
  assert.deepEqual(subjects, ['airtable_create_record', 'outlook_send_mail']);
});

// ── 6. An acquired tool stays acquired ───────────────────────────────────────

test('D6: a cross-server acquired tool keeps working on later calls', async () => {
  const dispatched: string[] = [];
  const turnBase = {
    cacheToolsList: true,
    name: 'firecrawl-only-base',
    async connect() {},
    async close() {},
    async listTools() {
      return [{ name: 'firecrawl__scrape', description: 'scrape' }];
    },
    async callTool(toolName: string) {
      dispatched.push(`turnBase:${toolName}`);
      return [{ type: 'text', text: 'ok' }];
    },
    async invalidateToolsCache() {},
  };
  const routed: string[] = [];
  const restore = mcpServersTestHooks.setServerShimResolverForTests?.((slug: string) => ({
    cacheToolsList: true,
    name: `resolved-${slug}`,
    async connect() {},
    async close() {},
    async listTools() {
      return [{ name: 'outlook__send_mail', description: 'send' }];
    },
    async callTool(toolName: string) {
      routed.push(`${slug}:${toolName}`);
      return [{ type: 'text', text: 'ok' }];
    },
    async invalidateToolsCache() {},
  }));
  try {
    const scoped = mcpServersTestHooks.scopedView(turnBase as never, {
      reason: 'web intent',
      authority: 'catalog',
      allowedServerSlugs: ['firecrawl'],
      maxTools: 8,
    });
    await scoped.listTools();
    await scoped.callTool('outlook__send_mail', {});
    await scoped.callTool('outlook__send_mail', {});
    assert.deepEqual(
      routed,
      ['outlook:outlook__send_mail', 'outlook:outlook__send_mail'],
      'the second call must reach the SAME server the acquisition resolved, not the turn base',
    );
    assert.deepEqual(dispatched, [], 'the turn base never sees a tool it does not host');
  } finally {
    restore?.();
  }
});

// ── 7. One typed recovery kernel, provider-neutral ───────────────────────────

test('D7: every attempt outcome maps to exactly one recovery, from structure not prose', async () => {
  const { classifyAttemptOutcome, recoveryDirectiveFor } = await import('./harness/attempt-outcome.js');

  const cases: Array<[string, Parameters<typeof classifyAttemptOutcome>[0], string]> = [
    ['generic native envelope failure', { envelopeSuccessful: false }, 'unknown'],
    ['empty but successful', { envelopeSuccessful: true, emptyResult: true }, 'empty_result'],
    ['thrown timeout on a read', { errorName: 'TimeoutError' }, 'transient'],
    ['thrown timeout on a write', { errorName: 'TimeoutError', mutating: true }, 'uncertain_write'],
    ['expired connection', { connectionMissing: true }, 'auth_failure'],
    ['bad arguments', { argumentValidationFailed: true }, 'invalid_arguments'],
    ['silently dropped requirement', { droppedRequiredParameter: true }, 'ignored_requirement'],
    ['policy refusal', { policyRefused: true }, 'policy_denial'],
    ['needs the user', { needsUserInput: true }, 'input_required'],
    ['rate limited', { httpStatus: 429 }, 'transient'],
    ['not implemented', { httpStatus: 501 }, 'unsupported_capability'],
    ['unacknowledged mutation', { mutating: true, acknowledged: false }, 'uncertain_write'],
  ];
  for (const [label, signals, expected] of cases) {
    const got = classifyAttemptOutcome(signals);
    assert.equal(got.kind, expected, `${label} → ${got.kind}`);
    assert.notEqual(got.evidence, 'text', `${label} must be decided by structure, not wording`);
  }

  // Prose alone decides nothing, and `unknown` authorizes nothing.
  const proseOnly = classifyAttemptOutcome({ text: 'Error: the widget exploded, please retry' });
  assert.equal(proseOnly.kind, 'unknown');
  assert.deepEqual(
    {
      retry: proseOnly.directive.retrySameCandidate,
      eliminates: proseOnly.directive.eliminatesCandidate,
      opens: proseOnly.directive.opensDiscoveryEpoch,
    },
    { retry: false, eliminates: false, opens: false },
    'an unclassifiable result must not spend a budget or kill a candidate',
  );

  // The state machine the brief specifies, asserted directly.
  assert.equal(recoveryDirectiveFor('invalid_arguments').action, 'repair_arguments');
  assert.equal(recoveryDirectiveFor('invalid_arguments').retrySameCandidate, true);
  assert.equal(recoveryDirectiveFor('unsupported_capability').eliminatesCandidate, true);
  assert.equal(recoveryDirectiveFor('unsupported_capability').opensDiscoveryEpoch, true);
  assert.equal(recoveryDirectiveFor('policy_denial').opensDiscoveryEpoch, false);
  assert.equal(recoveryDirectiveFor('uncertain_write').requiresReconciliation, true);
  assert.equal(recoveryDirectiveFor('uncertain_write').retrySameCandidate, false);
});

// ── 9. Discovery attribution belongs to the task, not the session ────────────

test('D9: composio discovery attribution is keyed by accepted task, not session', async () => {
  const { composioSearchAttributionKey } = await import('../tools/composio-tools.js');
  const sameSession = 'sess-shared';
  assert.notEqual(
    composioSearchAttributionKey(sameSession, 10),
    composioSearchAttributionKey(sameSession, 11),
    'two accepted tasks in one session must not share one search attribution slot',
  );
  assert.equal(
    composioSearchAttributionKey(sameSession, 10),
    composioSearchAttributionKey(sameSession, 10),
    'the same task keeps one slot',
  );
  // A caller with no task identity still gets a stable key rather than a crash;
  // it just cannot be credited across tasks.
  assert.equal(composioSearchAttributionKey(sameSession), sameSession);
});
