/** Run: node scripts/run-tests-isolated.mjs src/tools/composio-contract-single-owner.test.ts
 *
 * ONE REFINEMENT OWNER (live 2026-08-18, sess-synthetic-005 seq 58772→58775):
 * the model sent FIRECRAWL_SEARCH `query` where the schema requires `q`.
 * The gateway's schema repair fixes that — but call_tool had already frozen
 * the pre-repair bytes as the logical call's effective contract, so the
 * gateway's own trusted refinement became a poisoning conflict
 * ("logical call already has a different effective contract"), the first
 * construct step died, and maxTurns:1 turned one poisoned call into a parked
 * task. These pin the fix at both layers:
 *   - the deterministic `query`→`q` rename repair (value untouched, surfaced
 *     as a note);
 *   - call_tool does NOT refine the effective contract for the trusted
 *     Composio carrier — the gateway downstream is the single refinement
 *     owner, so its post-repair refinement is the FIRST one and lands clean.
 * The kernel invariant is untouched: a genuinely conflicting second
 * refinement still poisons (logical-call-contract-refinement.test.ts).
 */
const PRIOR_CLEMENTINE_HOME = process.env.CLEMENTINE_HOME;
const PRIOR_TEST_ISOLATED_HOME = process.env.CLEMMY_TEST_ISOLATED_HOME;
const TEMP_ROOT = (process.env.TMPDIR?.trim() || '/tmp').replace(/\/+$/, '');
if (!TEMP_ROOT.startsWith('/')) throw new Error('fixture temp root must be absolute');
const TMP_HOME = `${TEMP_ROOT}/clemmy-composio-single-owner-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
// This assignment deliberately precedes EVERY import. Project modules capture
// the home during initialization; importing even one of them first can route
// fixed fixture sessions into the live daemon database.
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.COMPOSIO_BACKEND = 'sdk';
delete process.env.COMPOSIO_API_KEY;

const { createHash } = await import('node:crypto');
const { existsSync, mkdirSync, rmSync, writeFileSync } = await import('node:fs');
const os = await import('node:os');
const path = await import('node:path');
const { test } = await import('node:test');
const { default: assert } = await import('node:assert/strict');
const { default: Database } = await import('better-sqlite3');

const resolvedTempHome = path.resolve(TMP_HOME);
assert.ok(
  resolvedTempHome.startsWith(`${path.resolve(TEMP_ROOT)}${path.sep}`),
  'fixture home must remain below the resolved temp root',
);
mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'composio-single-owner-test\n', 'utf8');

const LIVE_HOME = path.resolve(
  PRIOR_CLEMENTINE_HOME?.trim() || path.join(os.homedir(), '.clementine-next'),
);
const FIXED_FIXTURE_SESSION_IDS = Object.freeze([
  'sess-single-owner',
  'sess-production-nested-reservation',
  'sess-prepared-connection-failure',
  'sess-prepared-account-absent',
  'sess-prepared-schema-absent',
  'sess-no-hidden-receipt-poll',
]);

function assertFixedFixtureSessionsAbsentFromLiveHome(): void {
  assert.notEqual(resolvedTempHome, LIVE_HOME, 'fixture and live homes must never coincide');
  const liveDbPath = path.join(LIVE_HOME, 'state', 'harness.db');
  if (!existsSync(liveDbPath)) return;
  const db = new Database(liveDbPath, { readonly: true, fileMustExist: true });
  try {
    const placeholders = FIXED_FIXTURE_SESSION_IDS.map(() => '?').join(', ');
    const rows = db.prepare(`
      SELECT id
        FROM sessions
       WHERE id IN (${placeholders})
       ORDER BY id
    `).all(...FIXED_FIXTURE_SESSION_IDS) as Array<{ id: string }>;
    assert.deepEqual(
      rows.map((row) => row.id),
      [],
      `fixed composio-contract fixture sessions escaped into live home ${LIVE_HOME}`,
    );
  } finally {
    db.close();
  }
}

// Pre-import sentinel: a contaminated live home blocks the fixture before any
// Clementine module initializes. The after-hook repeats it to prove this run
// did not write those ids outside TMP_HOME.
assertFixedFixtureSessionsAbsentFromLiveHome();

const { buildCallTool } = await import('./call-tool.js');
const { _setInnerDispatchToolsForTests } = await import('./inner-dispatch.js');
const { repairUnambiguousFieldRename } = await import('./composio-batch-validator.js');
const {
  getComposioRuntimeTools,
  runComposioExecuteForTestInSession,
  runComposioExecuteWithGatewayForTest,
} = await import('./composio-tools.js');
const { rememberToolSchema, resetToolSchemaCache } = await import('./composio-schema-cache.js');
const {
  __test__: composioClientTest,
  listUsableConnectedToolkits,
  resetComposioClient,
} = await import('../integrations/composio/client.js');
const { withToolOutputContext } = await import('../runtime/harness/tool-output-context.js');
const {
  withHarnessRunContext,
  ToolCallsCounter,
  wrapToolForHarness,
} = await import('../runtime/harness/brackets.js');
const {
  appendEvent,
  closeEventLog,
  createSession,
  listEvents,
  openEventLog,
} = await import('../runtime/harness/eventlog.js');
const { recordTurnGraphShadow } = await import('../runtime/graph/turn-graph-shadow.js');
const { authorizeResolvedLogicalCallContract, acceptedTaskIdFor, currentLogicalCall } = await import('../runtime/harness/attempt-identity.js');
const { settleToolAttempt } = await import('../runtime/harness/attempt-settlement.js');
const { durableLogicalCallContract } = await import('../runtime/harness/logical-call-contract.js');
const { closeOperationalTelemetryDb } = await import('../runtime/operational-telemetry.js');
const dispatchLeases = await import('../runtime/harness/dispatch-lease.js');
const callAuthority = await import('../runtime/harness/accepted-turn-call-authority.js');
const hostBindings = await import('../runtime/harness/host-call-capability-binding.js');
const hostInvocation = await import('../runtime/harness/host-tool-invocation.js');
const manifests = await import('../runtime/harness/capability-manifest.js');
const manifestStores = await import('../runtime/harness/capability-manifest-store.js');
const capabilityCatalogs = await import('../runtime/harness/host-capability-catalog-factory.js');
const providerIdentity = await import('../integrations/composio/provider-definition-identity.js');
const { digestSchema } = await import('./tool-contract-store.js');

type ToolLike = { invoke?: (ctx: unknown, input: string, details: unknown) => Promise<unknown> };

const FIRECRAWL_SCHEMA = {
  type: 'object',
  required: ['q'],
  properties: {
    q: { type: 'string', description: 'search query' },
    limit: { type: 'integer' },
  },
};
const PROVIDER_OPERATION_VERSION = '20260824_01';
const FIRECRAWL_OUTPUT_SCHEMA = {
  type: 'object',
  properties: { results: { type: 'array' } },
};
const FIRECRAWL_ACCOUNT_ID = 'ca_firecrawl_test';
const FIRECRAWL_INVOKE_PORT_ID = 'composio:execute';

/** The production gateway admits a prepared host call only when its attestation
 * names a capability manifest that is INSTALLED, current, and digest-identical
 * in the manifest store — an attestation cannot vouch for itself. So the host
 * fixture below mints the same sealed identity connect-time provisioning mints
 * (capabilityId === manifestId, definition fingerprint closed over the exact
 * input schema, output schema, operation version, account, and invoke port). */
function firecrawlSearchManifest() {
  const definitionFingerprint = providerIdentity.fingerprintComposioProviderDefinition({
    operationId: 'FIRECRAWL_SEARCH',
    operationVersion: PROVIDER_OPERATION_VERSION,
    accountId: FIRECRAWL_ACCOUNT_ID,
    invokePortId: FIRECRAWL_INVOKE_PORT_ID,
    inputSchema: FIRECRAWL_SCHEMA,
    outputSchema: FIRECRAWL_OUTPUT_SCHEMA,
  });
  assert.ok(definitionFingerprint, 'the fixture provider definition is fully observed');
  return manifests.attachSemanticContract({
    version: 1,
    manifestId: 'cap:resolved:firecrawl_search',
    providerKind: 'composio',
    operationId: 'FIRECRAWL_SEARCH',
    providerIdentity: 'composio',
    providerVersion: providerIdentity.COMPOSIO_PROVIDER_SURFACE_VERSION,
    operationVersion: PROVIDER_OPERATION_VERSION,
    definitionFingerprint,
    externalDefinition: {
      version: 1,
      providerInputSchemaDigest: digestSchema(FIRECRAWL_SCHEMA),
      providerOutputSchemaObserved: true,
      providerOutputSchemaDigest: digestSchema(FIRECRAWL_OUTPUT_SCHEMA),
      semanticName: 'FIRECRAWL_SEARCH',
      behaviorHints: {
        readOnly: true,
        destructive: null,
        idempotent: null,
        openWorld: null,
      },
    },
    effect: 'read',
    accountId: FIRECRAWL_ACCOUNT_ID,
    idempotency: { required: false, policy: 'none' },
    reconciliation: { supported: false, policy: 'none' },
    outputContract: { kind: 'records' },
    evidenceContract: { kinds: ['payload'], readbackRequired: false },
    provenance: {
      issuer: 'host:composio-contract-single-owner-test',
      issuedAt: '2026-08-25T00:00:00.000Z',
      trusted: true,
    },
    lifecycle: { state: 'current' },
    advisoryRoles: ['source'],
    argumentCompiler: { id: 'compile:composio-contract-single-owner-test', version: '1' },
    invokePortId: FIRECRAWL_INVOKE_PORT_ID,
    acceptedInputKinds: ['evidence'],
    producedOutputKinds: ['evidence'],
    applicableDeliverableKinds: ['evidence'],
  });
}

function registeredFirecrawlSearchCapability(
  manifest: ReturnType<typeof firecrawlSearchManifest>,
) {
  return {
    capabilityId: manifest.manifestId,
    toolName: manifest.operationId,
    schemaVersion: manifest.operationVersion,
    schemaDigest: manifest.definitionFingerprint,
    effect: manifest.effect,
    account: manifest.accountId,
    manifestDigest: manifests.capabilityManifestDigest(manifest),
    providerKind: manifest.providerKind,
    providerInputSchemaDigest: manifest.externalDefinition!.providerInputSchemaDigest,
    liveFingerprint: manifest.definitionFingerprint,
    manifest,
    invoke: async () => ({ successful: true, data: { results: [] } }),
  };
}

const PRIOR_HOST_CAPABILITY_CATALOG = capabilityCatalogs.peekHostCapabilityCatalogFactory();
const FIRECRAWL_MANIFEST = firecrawlSearchManifest();
capabilityCatalogs.installHostCapabilityCatalogFactory(
  capabilityCatalogs.createHostCapabilityCatalogFactory([
    registeredFirecrawlSearchCapability(FIRECRAWL_MANIFEST),
  ]),
);

test.after(() => {
  try {
    _setInnerDispatchToolsForTests(null);
    composioClientTest.setConnectedAccountsLoader(null);
    resetComposioClient();
    resetToolSchemaCache();
    capabilityCatalogs.installHostCapabilityCatalogFactory(PRIOR_HOST_CAPABILITY_CATALOG);
    closeEventLog();
    closeOperationalTelemetryDb();
    assertFixedFixtureSessionsAbsentFromLiveHome();
  } finally {
    rmSync(resolvedTempHome, { recursive: true, force: true });
    if (PRIOR_CLEMENTINE_HOME === undefined) delete process.env.CLEMENTINE_HOME;
    else process.env.CLEMENTINE_HOME = PRIOR_CLEMENTINE_HOME;
    if (PRIOR_TEST_ISOLATED_HOME === undefined) delete process.env.CLEMMY_TEST_ISOLATED_HOME;
    else process.env.CLEMMY_TEST_ISOLATED_HOME = PRIOR_TEST_ISOLATED_HOME;
  }
});

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

function acceptedRun(sessionId: string, text: string): { sourceUserSeq: number; turn: number } {
  createSession({ id: sessionId, kind: 'chat' });
  const source = appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text },
  });
  assert.ok(recordTurnGraphShadow({
    identity: { sessionId, sourceUserSeq: source.seq, turn: source.turn },
  }));
  return { sourceUserSeq: source.seq, turn: source.turn };
}

function withAcceptedRun<T>(
  sessionId: string,
  accepted: { sourceUserSeq: number; turn: number },
  work: () => Promise<T>,
): Promise<T> {
  return withHarnessRunContext({
    sessionId,
    sourceUserSeq: accepted.sourceUserSeq,
    turn: accepted.turn,
    counter: new ToolCallsCounter(20),
  }, work) as Promise<T>;
}

test('the live FIRECRAWL_SEARCH shape: `query` renames to the schema\'s required `q`, value untouched', () => {
  const repaired = repairUnambiguousFieldRename(
    'FIRECRAWL_SEARCH',
    { limit: 8, query: 'top 5 best restaurants Big Bear Lake CA Google rating phone number' },
    FIRECRAWL_SCHEMA,
  );
  assert.ok(repaired, 'one missing required + one unknown key is the unambiguous rename');
  assert.deepEqual(repaired.args, {
    limit: 8,
    q: 'top 5 best restaurants Big Bear Lake CA Google rating phone number',
  });
  assert.match(repaired.note, /renamed `query`/);
});

test('call_tool leaves the Composio carrier contract to the gateway — the post-repair refinement lands clean, never poisons', async () => {
  const sessionId = 'sess-single-owner';
  createSession({ id: sessionId, kind: 'chat' });
  const source = appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Find the top five Big Bear Lake restaurants and their ratings.' },
  });
  assert.ok(recordTurnGraphShadow({
    identity: { sessionId, sourceUserSeq: source.seq, turn: 1 },
  }));

  const rawInner = { limit: 8, query: 'top 5 best restaurants Big Bear Lake CA Google rating phone number' };
  let dispatchedInner: Record<string, unknown> | null = null;
  // The fake carrier reproduces the gateway seam exactly: schema repair on the
  // inner args, then the trusted-resolver refinement with the REPAIRED bytes
  // (composio-tools.ts authorizeResolvedLogicalCallContract before provider
  // I/O). Live, this second-writer refinement is what poisoned the call.
  _setInnerDispatchToolsForTests(new Map([[
    'composio_execute_tool',
    {
      name: 'composio_execute_tool',
      invoke: async (_ctx: unknown, input: unknown) => {
        const carrier = typeof input === 'string' ? JSON.parse(input) : input as Record<string, unknown>;
        const inner = JSON.parse(String(carrier.arguments)) as Record<string, unknown>;
        const repaired = repairUnambiguousFieldRename(String(carrier.tool_slug), inner, FIRECRAWL_SCHEMA);
        const effective = repaired?.args ?? inner;
        authorizeResolvedLogicalCallContract({
          sessionId,
          sourceUserSeq: source.seq,
          turn: 1,
          tool: String(carrier.tool_slug),
          effectiveArgs: effective,
        });
        dispatchedInner = effective;
        // Mirror settleComposioReturned: the gateway settles its own attempt
        // with the exact provider-ready args it dispatched.
        settleToolAttempt({
          sessionId,
          sourceUserSeq: source.seq,
          turn: 1,
          lane: 'composio',
          toolName: String(carrier.tool_slug),
          callId: currentLogicalCall()?.logicalToolCallId,
          args: effective,
          businessCall: true,
          mutating: false,
          result: { successful: true, data: { results: [] } },
        });
        return JSON.stringify({ successful: true, data: { results: [] } });
      },
    },
  ]]));

  // The wrapper opens the ambient logical call exactly as the live work_call
  // carrier does — without it, call_tool has no frame to freeze and the
  // regression this pins (pre-repair freeze → gateway poison) cannot occur.
  const callTool = wrapToolForHarness(buildCallTool() as never) as unknown as ToolLike;
  const output = await withHarnessRunContext(
    { sessionId, sourceUserSeq: source.seq, turn: 1, counter: new ToolCallsCounter(10) },
    () => withToolOutputContext(
      { sessionId, sourceUserSeq: source.seq, callId: 'call-single-owner', toolName: 'call_tool' },
      () => callTool.invoke!(
        { context: { sessionId, sourceUserSeq: source.seq, turn: 1 } },
        JSON.stringify({
          name: 'composio_execute_tool',
          args_json: JSON.stringify({
            tool_slug: 'FIRECRAWL_SEARCH',
            arguments: JSON.stringify(rawInner),
            connected_account_id: null,
          }),
        }),
        { toolCall: { callId: 'call-single-owner' } },
      ) as Promise<unknown>,
    ),
  );

  assert.doesNotMatch(String(output), /poisoned|different effective contract/,
    'the first construct step must not die on the host\'s own repair');
  assert.deepEqual(dispatchedInner, {
    limit: 8,
    q: 'top 5 best restaurants Big Bear Lake CA Google rating phone number',
  }, 'the provider-ready args carry the schema\'s required `q`');

  // Exactly ONE refinement — the gateway's, with the repaired bytes.
  const refinements = listEvents(sessionId, { types: ['logical_call_contract_refined'] });
  assert.equal(refinements.length, 1, 'a single refinement owner, downstream of the repairs');
  const expected = durableLogicalCallContract(
    acceptedTaskIdFor(sessionId, source.seq),
    'FIRECRAWL_SEARCH',
    dispatchedInner,
  );
  assert.ok(expected);
  assert.equal(refinements[0]!.data.effectiveArgumentDigest, expected.argumentDigest);

  const row = openEventLog().prepare(`
    SELECT state, conflict_reason FROM logical_tool_calls
     WHERE session_id = ? AND source_user_seq = ?
  `).get(sessionId, source.seq) as { state: string; conflict_reason: string | null };
  assert.notEqual(row.state, 'conflict', 'the logical call survives its own repair');
  assert.equal(row.conflict_reason, null);
});

test('nested host reservation waits for the production Composio gateway to finish provider-final refinement', async () => {
  const sessionId = 'sess-production-nested-reservation';
  createSession({ id: sessionId, kind: 'chat' });
  const source = appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Find the top five Big Bear Lake restaurants and their ratings.' },
  });
  const catalogRevisionDigest = digest(`catalog:${sessionId}`);
  const bindingRevisionDigest = digest(`binding:${sessionId}`);
  const armed = callAuthority.armHostCallAuthority({
    sessionId,
    sourceUserSeq: source.seq,
    catalogRevisionDigest,
    bindingRevisionDigest,
    maxLogicalCalls: 8,
    maxParallelCalls: 4,
  });
  assert.equal(armed.status, 'armed');

  const rawInner = {
    limit: 8,
    query: 'top 5 best restaurants Big Bear Lake CA Google rating phone number',
  };
  const gatewayArgs = {
    tool_slug: 'FIRECRAWL_SEARCH',
    arguments: JSON.stringify(rawInner),
    connected_account_id: null,
  };
  const carrierArgs = {
    name: 'composio_execute_tool',
    args_json: JSON.stringify(gatewayArgs),
  };
  const acceptedTaskId = acceptedTaskIdFor(sessionId, source.seq);
  const logical = durableLogicalCallContract(acceptedTaskId, 'call_tool', carrierArgs);
  assert.ok(logical, 'the trusted carriers peel to one FIRECRAWL_SEARCH contract');
  const root = callAuthority.acceptedTurnCallAuthorityFor(sessionId, source.seq);
  assert.equal(root.status, 'ok');
  if (root.status !== 'ok' || !logical) throw new Error('host fixture authority unavailable');
  const callId = 'call-production-nested-reservation';
  const manifest = firecrawlSearchManifest();
  const priorManifestStore = manifestStores.peekCapabilityManifestStore();
  manifestStores.installCapabilityManifestStore(
    manifestStores.createCapabilityManifestStore([manifest]),
  );
  const attestationBase = {
    sessionId,
    sourceUserSeq: source.seq,
    acceptedTaskId,
    sourceEventId: root.authority.sourceEventId,
    sourceEventDigest: root.authority.sourceEventDigest,
    logicalToolCallId: callId,
    toolName: logical.toolName,
    argumentDigest: logical.argumentDigest,
    effect: 'read' as const,
    bindingKind: 'catalog_manifest' as const,
    capabilityId: manifest.manifestId,
    providerInputSchemaDigest: manifest.externalDefinition!.providerInputSchemaDigest,
    schemaFingerprint: manifest.definitionFingerprint,
    accountId: manifest.accountId,
    invokePortId: manifest.invokePortId,
    operationId: manifest.operationId,
    manifestId: manifest.manifestId,
    manifestDigest: manifests.capabilityManifestDigest(manifest),
    engineVersion: root.authority.engineVersion,
    surfaceVersion: root.authority.surfaceVersion,
    authorityDigest: root.authority.authorityDigest,
    authorityRevision: root.authority.revision,
    surfaceDigest: root.authority.surfaceDigest,
    catalogRevisionDigest,
    bindingRevisionDigest,
  };
  const attestation = {
    ...attestationBase,
    bindingDigest: hostBindings.hostCallAttestationBindingDigest(attestationBase),
  };
  const parentLease = dispatchLeases.activateDispatchLease({
    sessionId,
    scopeId: `${sessionId}::host-parent`,
  });

  let providerBodies = 0;
  composioClientTest.setConnectedAccountsLoader(async () => [{
    id: 'ca_firecrawl_test',
    status: 'ACTIVE',
    toolkit: { slug: 'firecrawl' },
    user_id: 'hermetic-owner',
  }]);
  await listUsableConnectedToolkits({ requireFresh: true });
  composioClientTest.setComposioClient({
    getClient: () => ({
      withOptions: (options: { maxRetries?: number }) => {
        assert.equal(options.maxRetries, 0);
        return {
          tools: {
            execute: async (slug: string, body: Record<string, unknown>) => {
              providerBodies += 1;
              assert.equal(slug, 'FIRECRAWL_SEARCH');
              assert.deepEqual(body.arguments, {
                limit: 8,
                q: rawInner.query,
              });
              assert.equal(body.version, PROVIDER_OPERATION_VERSION);
              return { successful: true, data: { results: [] }, error: null };
            },
          },
        };
      },
    }),
    tools: {
      execute: async () => assert.fail('core execute would hide schema/modifier crossings'),
    },
  });
  // The sealed identity closes over the provider's OUTPUT definition too, so
  // the observation the gateway re-derives has to carry it — a live schema with
  // an unobserved output can never match a manifest that names one.
  rememberToolSchema(
    'FIRECRAWL_SEARCH',
    FIRECRAWL_SCHEMA,
    Date.now(),
    PROVIDER_OPERATION_VERSION,
    FIRECRAWL_OUTPUT_SCHEMA,
  );
  const composioExecute = getComposioRuntimeTools()
    .find((tool) => tool.name === 'composio_execute_tool');
  assert.ok(composioExecute?.invoke, 'production composio_execute_tool is invokable');
  _setInnerDispatchToolsForTests(new Map([['composio_execute_tool', composioExecute as never]]));
  const callTool = wrapToolForHarness(
    buildCallTool({ reachableBuiltinNames: new Set(['composio_execute_tool']) }) as never,
  ) as unknown as ToolLike;

  try {
    const invoked = await callAuthority.withHostCallAttestation(attestation, () =>
      withHarnessRunContext({
        sessionId,
        sourceUserSeq: source.seq,
        turn: 1,
        counter: new ToolCallsCounter(20),
        dispatchLease: parentLease,
      }, () => hostInvocation.invokeHostToolCall({
        identity: {
          sessionId,
          sourceUserSeq: source.seq,
          modelCallId: callId,
          toolName: 'call_tool',
          args: carrierArgs,
          turn: 1,
        },
        parentLease,
        effect: 'read',
        boundary: 'nested_owned',
        deadlineMs: 3_000,
        invoke: ({ signal }) => withToolOutputContext(
          { sessionId, sourceUserSeq: source.seq, callId, toolName: 'call_tool' },
          () => callTool.invoke!(
            { context: { sessionId } },
            JSON.stringify(carrierArgs),
            { toolCall: { callId }, signal },
          ) as Promise<unknown>,
        ),
      })),
    );
    assert.doesNotMatch(String(invoked.value), /different effective contract|frozen by execution|poisoned/i);
    assert.equal(providerBodies, 1, 'the provider body runs exactly once after refinement');

    const db = openEventLog();
    const logicalRow = db.prepare(`
      SELECT state, conflict_reason, effective_argument_digest
        FROM logical_tool_calls
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
    `).get(sessionId, source.seq, callId) as {
      state: string;
      conflict_reason: string | null;
      effective_argument_digest: string | null;
    };
    assert.notEqual(logicalRow.state, 'conflict');
    assert.equal(logicalRow.conflict_reason, null);
    assert.ok(logicalRow.effective_argument_digest, 'provider-final repaired bytes were frozen');
    const physicalRows = db.prepare(`
      SELECT state, execution_site
        FROM physical_dispatches
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
    `).all(sessionId, source.seq, callId) as Array<{ state: string; execution_site: string | null }>;
    assert.deepEqual(physicalRows, [{ state: 'returned', execution_site: null }],
      'one provider-owned crossing starts after refinement; the outer carrier mints none');
  } finally {
    dispatchLeases.revokeDispatchLease(parentLease);
    manifestStores.installCapabilityManifestStore(priorManifestStore);
  }
});

test('prepared execution never refreshes account inventory after a returned connection failure', async () => {
  const sessionId = 'sess-prepared-connection-failure';
  const accepted = acceptedRun(sessionId, 'Search Firecrawl for Big Bear restaurants.');
  resetComposioClient();
  resetToolSchemaCache();
  rememberToolSchema('FIRECRAWL_SEARCH', FIRECRAWL_SCHEMA, Date.now(), PROVIDER_OPERATION_VERSION);
  let inventoryReads = 0;
  composioClientTest.setConnectedAccountsLoader(async () => {
    inventoryReads += 1;
    return [{
      id: 'ca_firecrawl_returned_failure',
      status: 'ACTIVE',
      toolkit: { slug: 'firecrawl' },
      user_id: 'hermetic-owner',
    }];
  });
  await listUsableConnectedToolkits({ requireFresh: true });
  assert.equal(inventoryReads, 1, 'preparation owns the one account observation');
  // The real gateway now requires a prepared exact one-request SDK transport
  // even when this characterization injects the terminal body. The injected
  // body remains the only callable used; this transport proves readiness and
  // would fail the test if execution accidentally reached it.
  composioClientTest.setComposioClient({
    getClient: () => ({
      withOptions: () => ({
        tools: {
          execute: async () => {
            throw new Error('unexpected raw transport execution');
          },
        },
      }),
    }),
  });
  let providerBodies = 0;

  const output = await withAcceptedRun(sessionId, accepted, () =>
    runComposioExecuteWithGatewayForTest(
      'FIRECRAWL_SEARCH',
      { q: 'Big Bear restaurants', limit: 5 },
      (async () => {
        providerBodies += 1;
        return {
          successful: false,
          error: 'No connected account found for Firecrawl',
        };
      }) as never,
      sessionId,
    ));

  assert.equal(providerBodies, 1);
  assert.equal(inventoryReads, 1, 'failure explanation is cache-only; it cannot hide a second provider read');
  assert.match(output, /no hidden account refresh was attempted inside this call/i);
  const rows = openEventLog().prepare(`
    SELECT state, execution_site FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ?
  `).all(sessionId, accepted.sourceUserSeq) as Array<{ state: string; execution_site: string | null }>;
  assert.deepEqual(rows, [{ state: 'returned', execution_site: null }],
    'the one provider body owns the one provider crossing');
});

test('prepared execution with no current account observation returns typed repair with zero crossing', async () => {
  const sessionId = 'sess-prepared-account-absent';
  const accepted = acceptedRun(sessionId, 'Create the Outlook draft after preparing its account.');
  resetComposioClient();
  resetToolSchemaCache();
  rememberToolSchema('OUTLOOK_CREATE_DRAFT', {
    type: 'object',
    required: ['subject'],
    properties: { subject: { type: 'string' } },
  }, Date.now(), PROVIDER_OPERATION_VERSION);
  let hiddenInventoryReads = 0;
  composioClientTest.setConnectedAccountsLoader(async () => {
    hiddenInventoryReads += 1;
    return [{
      id: 'ca_must_not_be_loaded_inline',
      status: 'ACTIVE',
      toolkit: { slug: 'outlook' },
    }];
  });
  let providerBodies = 0;

  const output = await withAcceptedRun(sessionId, accepted, () =>
    runComposioExecuteWithGatewayForTest(
      'OUTLOOK_CREATE_DRAFT',
      { subject: 'Big Bear restaurants' },
      (async () => {
        providerBodies += 1;
        return { successful: true, data: { results: [] } };
      }) as never,
      sessionId,
    ));

  const outputText = typeof output === 'string'
    ? output
    : (output as unknown as { output: string }).output;
  assert.match(outputText, /PREPARATION-REQUIRED.*no current connected-account observation/is);
  assert.equal(hiddenInventoryReads, 0, 'resolver cannot materialize account state inside the business call');
  assert.equal(providerBodies, 0);
  assert.equal((openEventLog().prepare(`
    SELECT COUNT(*) AS count FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ?
  `).get(sessionId, accepted.sourceUserSeq) as { count: number }).count, 0);
});

test('prepared execution with no current provider definition returns typed repair with zero crossing', async () => {
  const sessionId = 'sess-prepared-schema-absent';
  const accepted = acceptedRun(sessionId, 'Run the exact prepared Firecrawl action.');
  const slug = 'FIRECRAWL_UNPREPARED_ACTION';
  resetComposioClient();
  resetToolSchemaCache();
  let inventoryReads = 0;
  composioClientTest.setConnectedAccountsLoader(async () => {
    inventoryReads += 1;
    return [{
      id: 'ca_firecrawl_schema_absent',
      status: 'ACTIVE',
      toolkit: { slug: 'firecrawl' },
      user_id: 'hermetic-owner',
    }];
  });
  await listUsableConnectedToolkits({ requireFresh: true });
  let providerBodies = 0;

  const output = await withAcceptedRun(sessionId, accepted, () =>
    runComposioExecuteWithGatewayForTest(
      slug,
      { q: 'Big Bear restaurants' },
      (async () => {
        providerBodies += 1;
        return { successful: true, data: { results: [] } };
      }) as never,
      sessionId,
    ));

  const outputText = typeof output === 'string'
    ? output
    : (output as unknown as { output: string }).output;
  assert.match(outputText, /PREPARATION-REQUIRED.*exact current provider input definition/is);
  assert.equal(inventoryReads, 1, 'execution consumes the prepared snapshot only');
  assert.equal(providerBodies, 0);
  assert.equal((openEventLog().prepare(`
    SELECT COUNT(*) AS count FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ?
  `).get(sessionId, accepted.sourceUserSeq) as { count: number }).count, 0);
});

test('a queued provider receipt surfaces without any hidden inline poll or getter dispatch', async () => {
  const sessionId = 'sess-no-hidden-receipt-poll';
  const accepted = acceptedRun(sessionId, 'Run the actor and return its queued receipt.');
  resetToolSchemaCache();
  rememberToolSchema('APIFY_RUN_ACTOR', {
    type: 'object',
    required: ['actor_id'],
    properties: { actor_id: { type: 'string' } },
  }, Date.now(), PROVIDER_OPERATION_VERSION);
  let providerBodies = 0;

  const output = await withAcceptedRun(sessionId, accepted, () =>
    runComposioExecuteForTestInSession(
      'APIFY_RUN_ACTOR',
      { actor_id: 'actor-1' },
      (async () => {
        providerBodies += 1;
        return {
          data: {
            id: 'Rv5AM2u9CRMGBYt2P',
            status: 'READY',
            defaultDatasetId: '71epPtxtXZshtjnV4',
          },
          successful: true,
          error: null,
        };
      }) as never,
      sessionId,
    ));

  assert.equal(providerBodies, 1, 'receipt handling cannot issue a getter or poll behind the model');
  assert.match(output, /QUEUED JOB/i);
  assert.match(output, /Rv5AM2u9CRMGBYt2P/);
  assert.doesNotMatch(output, /auto-resolved|background watcher/i);
  const rows = openEventLog().prepare(`
    SELECT ordinal, relation, state FROM physical_dispatches
     WHERE session_id = ? AND source_user_seq = ?
  `).all(sessionId, accepted.sourceUserSeq) as Array<{ ordinal: number; relation: string; state: string }>;
  assert.deepEqual(rows, [{ ordinal: 1, relation: 'primary', state: 'returned' }]);
});
