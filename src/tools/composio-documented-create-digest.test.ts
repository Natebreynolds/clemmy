/** Run: node scripts/run-tests-isolated.mjs src/tools/composio-documented-create-digest.test.ts
 *
 * ADMIT bytes vs SETTLE bytes, documented-create edition.
 *
 * The host freezes a call attestation at admission from the model's exact
 * inner `arguments` object. The Composio gateway then deletes host-only keys
 * from that object before dispatch (`artifact_key`, an inline
 * `connected_account_id`, `account_alias`) — the dispatch ledger already
 * understands this as ONE raw -> effective refinement of the same logical
 * call. The documented-create projection compared the frozen attestation
 * digest against the provider-ready digest and refused its own planned
 * create ("host call attestation conflicts with the exact provider call")
 * although nothing changed semantically. Same class as 39d00400/0c63a90b.
 */
const PRIOR_CLEMENTINE_HOME = process.env.CLEMENTINE_HOME;
const PRIOR_TEST_ISOLATED_HOME = process.env.CLEMMY_TEST_ISOLATED_HOME;
const TEMP_ROOT = (process.env.TMPDIR?.trim() || '/tmp').replace(/\/+$/, '');
const TMP_HOME = `${TEMP_ROOT}/clemmy-documented-create-digest-${process.pid}-${Date.now()}`;
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.COMPOSIO_BACKEND = 'sdk';
delete process.env.COMPOSIO_API_KEY;

const { createHash } = await import('node:crypto');
const { mkdirSync, rmSync, writeFileSync } = await import('node:fs');
const path = await import('node:path');
const { test } = await import('node:test');
const { default: assert } = await import('node:assert/strict');

mkdirSync(path.join(TMP_HOME, 'state'), { recursive: true });
writeFileSync(path.join(TMP_HOME, 'state', 'machine-id'), 'documented-create-digest-test\n', 'utf8');

const { runComposioExecuteWithGatewayForTest } = await import('./composio-tools.js');
const { rememberToolSchema, resetToolSchemaCache } = await import('./composio-schema-cache.js');
const { digestSchema } = await import('./tool-contract-store.js');
const client = await import('../integrations/composio/client.js');
const providerIdentity = await import('../integrations/composio/provider-definition-identity.js');
const { withHarnessRunContext, ToolCallsCounter } = await import('../runtime/harness/brackets.js');
const { appendEvent, closeEventLog, createSession, openEventLog } = await import('../runtime/harness/eventlog.js');
const { recordTurnGraphShadow } = await import('../runtime/graph/turn-graph-shadow.js');
const { acceptedTaskIdFor, withLogicalToolCall } = await import('../runtime/harness/attempt-identity.js');
const { durableLogicalCallContract } = await import('../runtime/harness/logical-call-contract.js');
const callAuthority = await import('../runtime/harness/accepted-turn-call-authority.js');
const hostBindings = await import('../runtime/harness/host-call-capability-binding.js');
const manifests = await import('../runtime/harness/capability-manifest.js');
const manifestStores = await import('../runtime/harness/capability-manifest-store.js');
const dispatchLeases = await import('../runtime/harness/dispatch-lease.js');
const { withExpectedWorkBinding } = await import('../runtime/harness/expected-work-admission.js');
const { verifyAtomicContentCommit } = await import('../runtime/harness/atomic-content-commit-proof.js');
const { redeemSuccessfulSettlementResultForHost } = await import('../runtime/harness/result-handle.js');
const { default: Database } = await import('better-sqlite3');
const { compileAtomicInputContentContract } = await import('../runtime/harness/atomic-input-content-contract.js');
const { closeOperationalTelemetryDb } = await import('../runtime/operational-telemetry.js');

const SLUG = 'ACME_CREATE_SHEET';
const ACCOUNT_ID = 'ca_acme_sheets';
const OPERATION_VERSION = '20260905_01';
const INVOKE_PORT_ID = 'composio:execute';
const INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'rows'],
  properties: {
    title: { type: 'string' },
    rows: { type: 'string', description: 'JSON array of row objects' },
  },
};
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: { spreadsheetId: { type: 'string' }, spreadsheetUrl: { type: 'string' } },
};
const CONTENT_DECLARATION = {
  version: 1 as const,
  compiler: {
    version: 1 as const,
    kind: 'tabular_record_set_v1' as const,
    namePointer: '/title',
    recordsPointer: '/rows',
    recordsEncoding: 'json_or_value' as const,
    selector: 'a1_grid_v1' as const,
  },
  resultIdentity: {
    version: 1 as const,
    kind: 'pointer_resource_identity_v1' as const,
    idPointers: ['/data/spreadsheetId'],
    handlePointers: ['/data/spreadsheetUrl'],
    handleTemplate: {
      version: 1 as const,
      kind: 'prefix_suffix_v1' as const,
      prefix: 'https://docs.google.com/spreadsheets/d/',
      suffix: '/edit',
    },
  },
  evidence: ['receipt', 'content_commit'] as const,
};

const digest = (value: string): string => createHash('sha256').update(value).digest('hex');

function sheetManifest() {
  const definitionFingerprint = providerIdentity.fingerprintComposioProviderDefinition({
    operationId: SLUG,
    operationVersion: OPERATION_VERSION,
    accountId: ACCOUNT_ID,
    invokePortId: INVOKE_PORT_ID,
    inputSchema: INPUT_SCHEMA,
    outputSchema: OUTPUT_SCHEMA,
  });
  assert.ok(definitionFingerprint);
  return manifests.attachSemanticContract({
    version: 1,
    manifestId: `cap:resolved:${SLUG.toLowerCase()}`,
    providerKind: 'composio',
    operationId: SLUG,
    providerIdentity: 'composio',
    providerVersion: providerIdentity.COMPOSIO_PROVIDER_SURFACE_VERSION,
    operationVersion: OPERATION_VERSION,
    definitionFingerprint,
    externalDefinition: {
      version: 1,
      providerInputSchemaDigest: digestSchema(INPUT_SCHEMA),
      providerOutputSchemaObserved: true,
      providerOutputSchemaDigest: digestSchema(OUTPUT_SCHEMA),
      semanticName: SLUG,
      behaviorHints: { readOnly: false, destructive: null, idempotent: null, openWorld: null },
    },
    effect: 'external_write',
    destination: { family: 'acme', posture: 'create_new' },
    accountId: ACCOUNT_ID,
    idempotency: { required: true, policy: 'key_before_dispatch' },
    reconciliation: { supported: false, policy: 'none' },
    outputContract: { kind: 'receipt' },
    evidenceContract: { kinds: ['receipt'], readbackRequired: false },
    provenance: { issuer: 'host:documented-create-digest-test', issuedAt: '2026-09-05T00:00:00.000Z', trusted: true },
    lifecycle: { state: 'current' },
    advisoryRoles: ['destination'],
    argumentCompiler: { id: 'compile:documented-create-digest-test', version: '1' },
    invokePortId: INVOKE_PORT_ID,
    reconcilePortId: `reconcile:${INVOKE_PORT_ID}`,
    acceptedInputKinds: ['evidence'],
    producedOutputKinds: ['evidence'],
    applicableDeliverableKinds: ['evidence'],
  });
}

const PRIOR_MANIFEST_STORE = manifestStores.peekCapabilityManifestStore();
const MANIFEST = sheetManifest();

test.before(async () => {
  manifestStores.installCapabilityManifestStore(
    manifestStores.createCapabilityManifestStore([MANIFEST]),
  );
  client.__test__.setComposioApiKeyOverride('documented-create-digest-test-key');
  client.__test__.setConnectedAccountsLoader(async () => [{
    id: ACCOUNT_ID,
    status: 'ACTIVE',
    user_id: 'hermetic-owner',
    toolkit: { slug: 'acme' },
  }]);
  await client.listConnectedToolkits({ requireFresh: true });
  rememberToolSchema(SLUG, INPUT_SCHEMA, Date.now(), OPERATION_VERSION, OUTPUT_SCHEMA);
});

test.after(() => {
  try {
    client.__test__.setConnectedAccountsLoader(null);
    client.__test__.setComposioApiKeyOverride(null);
    client.resetComposioClient();
    resetToolSchemaCache();
    manifestStores.installCapabilityManifestStore(PRIOR_MANIFEST_STORE);
    closeEventLog();
    closeOperationalTelemetryDb();
  } finally {
    rmSync(TMP_HOME, { recursive: true, force: true });
    if (PRIOR_CLEMENTINE_HOME === undefined) delete process.env.CLEMENTINE_HOME;
    else process.env.CLEMENTINE_HOME = PRIOR_CLEMENTINE_HOME;
    if (PRIOR_TEST_ISOLATED_HOME === undefined) delete process.env.CLEMMY_TEST_ISOLATED_HOME;
    else process.env.CLEMMY_TEST_ISOLATED_HOME = PRIOR_TEST_ISOLATED_HOME;
  }
});

/**
 * Drive ONE planned documented create through the production host shape:
 * armed host_v1 root -> frozen attestation over the model's exact carrier ->
 * admitted logical call + persisted capability binding -> expected-work
 * binding carrying the frozen content contract -> the real gateway.
 */
async function runPlannedDocumentedCreate(input: {
  sessionId: string;
  innerArgs: Record<string, unknown>;
}) {
  const { sessionId } = input;
  createSession({ id: sessionId, kind: 'chat' });
  const source = appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Create the prospects sheet from the rows we collected.' },
  });
  assert.ok(recordTurnGraphShadow({
    identity: { sessionId, sourceUserSeq: source.seq, turn: 1 },
  }));
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
  const acceptedTaskId = acceptedTaskIdFor(sessionId, source.seq);
  const root = callAuthority.acceptedTurnCallAuthorityFor(sessionId, source.seq);
  assert.equal(root.status, 'ok');
  if (root.status !== 'ok') throw new Error('host fixture authority unavailable');

  // The model's exact carrier: the host attests THESE bytes at admission.
  const gatewayArgs = {
    tool_slug: SLUG,
    arguments: JSON.stringify(input.innerArgs),
    connected_account_id: null,
  };
  const logical = durableLogicalCallContract(acceptedTaskId, 'composio_execute_tool', gatewayArgs);
  assert.ok(logical, 'the gateway carrier peels to one provider contract');
  const callId = `call-${sessionId}`;
  const attestationBase = {
    sessionId,
    sourceUserSeq: source.seq,
    acceptedTaskId,
    sourceEventId: root.authority.sourceEventId,
    sourceEventDigest: root.authority.sourceEventDigest,
    logicalToolCallId: callId,
    toolName: logical.toolName,
    argumentDigest: logical.argumentDigest,
    effect: 'external_write' as const,
    bindingKind: 'catalog_manifest' as const,
    capabilityId: MANIFEST.manifestId,
    providerInputSchemaDigest: MANIFEST.externalDefinition!.providerInputSchemaDigest,
    schemaFingerprint: MANIFEST.definitionFingerprint,
    accountId: MANIFEST.accountId,
    invokePortId: MANIFEST.invokePortId,
    operationId: MANIFEST.operationId,
    manifestId: MANIFEST.manifestId,
    manifestDigest: manifests.capabilityManifestDigest(MANIFEST),
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

  // The frozen work contract is compiled from the SAME inner arguments the
  // model wrote; host-only keys are not provider fields and are not content.
  const frozenContent = compileAtomicInputContentContract({
    declaration: CONTENT_DECLARATION,
    providerArguments: input.innerArgs,
  });
  assert.ok(frozenContent, 'the planned create compiles to a content contract');
  const work = {
    sessionId,
    sourceUserSeq: source.seq,
    acceptedTaskId,
    logicalToolCallId: callId,
    contractId: `contract-${sessionId}`,
    requirementId: 'create_prospects_sheet',
    effect: 'external_write' as const,
    cardinality: 'once' as const,
    generatedArtifactContentContract: frozenContent,
  };

  const providerBodies: Array<Record<string, unknown>> = [];
  const lease = dispatchLeases.activateDispatchLease({
    sessionId,
    scopeId: `${sessionId}::host-parent`,
  });
  try {
    const output = await callAuthority.withHostCallAttestation(attestation, () =>
      withHarnessRunContext({
        sessionId,
        sourceUserSeq: source.seq,
        turn: 1,
        counter: new ToolCallsCounter(20),
        dispatchLease: lease,
      }, () => withLogicalToolCall({
        sessionId,
        sourceUserSeq: source.seq,
        tool: 'composio_execute_tool',
        args: gatewayArgs,
        logicalToolCallId: callId,
      }, async () => {
        const bound = hostBindings.persistHostCallCapabilityBinding({
          db: openEventLog(),
          attestation,
          sessionId,
          sourceUserSeq: source.seq,
          logicalToolCallId: callId,
          acceptedTaskId,
          toolName: attestation.toolName,
          argumentDigest: attestation.argumentDigest,
          effect: 'external_write',
        });
        assert.equal(bound.status, 'bound', bound.status === 'bound' ? '' : (bound as { reason?: string }).reason);
        return withExpectedWorkBinding(work, () => runComposioExecuteWithGatewayForTest(
          SLUG,
          { ...input.innerArgs },
          (async (_slug: string, args: Record<string, unknown>) => {
            providerBodies.push(args);
            return {
              successful: true,
              error: null,
              data: {
                spreadsheetId: 'sheet-1',
                spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-1/edit',
              },
            };
          }) as never,
          sessionId,
        ));
      })));
    const text = typeof output === 'string'
      ? output
      : (output as unknown as { output: string }).output;
    const row = openEventLog().prepare(`
      SELECT state, conflict_reason, raw_argument_digest, effective_argument_digest
        FROM logical_tool_calls
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
    `).get(sessionId, source.seq, callId) as {
      state: string;
      conflict_reason: string | null;
      raw_argument_digest: string;
      effective_argument_digest: string | null;
    };
    // The settled authoritative handle is the projection's own canonical result.
    const handle = openEventLog().prepare(`
      SELECT h.argument_digest, h.raw_payload_json
        FROM durable_result_handles h
        JOIN logical_call_settlements s ON s.result_handle_id = h.handle_id
       WHERE s.session_id = ? AND s.source_user_seq = ? AND s.logical_tool_call_id = ?
    `).get(sessionId, source.seq, callId) as { argument_digest: string; raw_payload_json: string } | undefined;
    return {
      text,
      providerBodies,
      row,
      handle,
      acceptedTaskId,
      attestation,
      sourceUserSeq: source.seq,
      callId,
      logicalToolName: logical.toolName,
      frozenContent,
    };
  } finally {
    dispatchLeases.revokeDispatchLease(lease);
  }
}

test('a documented create whose inner arguments carry a host-only key dispatches after the gateway strips it', async () => {
  const innerArgs = {
    title: 'Family Law Prospects',
    rows: JSON.stringify([{ firm: 'Acme Family Law', phone: '555-0100' }]),
    // Clementine-only output-slot selector: read by the artifact ledger,
    // deleted by the gateway, never a provider field.
    artifact_key: 'proposal',
  };
  const run = await runPlannedDocumentedCreate({
    sessionId: 'sess-documented-create-artifact-key',
    innerArgs,
  });

  assert.doesNotMatch(run.text, /provider-dispatch:not-started/,
    `the host refused its own planned create: ${run.text.slice(0, 400)}`);
  assert.doesNotMatch(run.text, /host call attestation conflicts with the exact provider call/);
  assert.equal(run.providerBodies.length, 1, 'exactly one provider crossing');
  assert.deepEqual(run.providerBodies[0], { title: innerArgs.title, rows: innerArgs.rows },
    'the provider receives the exact stripped payload');

  // The ledger recorded the ONE raw -> effective refinement; the attestation
  // is the raw side, the provider-ready bytes are the effective side.
  assert.notEqual(run.row.state, 'conflict', run.row.conflict_reason ?? '');
  assert.equal(run.row.raw_argument_digest, run.attestation.argumentDigest);
  const effective = durableLogicalCallContract(
    run.acceptedTaskId,
    SLUG,
    { title: innerArgs.title, rows: innerArgs.rows },
  );
  assert.ok(effective);
  assert.equal(run.row.effective_argument_digest, effective.argumentDigest);

  // The projection RAN (this is not a not_applicable pass-through) and its
  // frozen authority speaks the effective digest every later proof compares
  // against — never the raw attestation bytes.
  assert.ok(run.handle, 'the settled create owns an authoritative result handle');
  const settled = JSON.parse(run.handle.raw_payload_json) as {
    kind: string;
    binding: { argumentDigest: string; requirementId: string };
  };
  assert.equal(settled.kind, 'documented_provider_create_result');
  assert.equal(settled.binding.requirementId, 'create_prospects_sheet');
  assert.equal(settled.binding.argumentDigest, effective.argumentDigest);
  assert.equal(run.handle.argument_digest, effective.argumentDigest);
  assert.notEqual(settled.binding.argumentDigest, run.attestation.argumentDigest,
    'raw admission bytes are not the identity of the provider crossing');
});

test('a documented create whose inner arguments carry an inline connected-account id dispatches on its attested account', async () => {
  const innerArgs = {
    title: 'Estate Planning Prospects',
    rows: JSON.stringify([{ firm: 'Beta Estate Law', phone: '555-0200' }]),
    connected_account_id: ACCOUNT_ID,
  };
  const run = await runPlannedDocumentedCreate({
    sessionId: 'sess-documented-create-inline-account',
    innerArgs,
  });

  assert.doesNotMatch(run.text, /provider-dispatch:not-started/,
    `the host refused its own planned create: ${run.text.slice(0, 400)}`);
  assert.equal(run.providerBodies.length, 1, 'exactly one provider crossing');
  assert.deepEqual(run.providerBodies[0], { title: innerArgs.title, rows: innerArgs.rows });
  assert.notEqual(run.row.state, 'conflict', run.row.conflict_reason ?? '');
});

test('a documented create with no host-only keys still dispatches (raw and effective digests coincide)', async () => {
  const innerArgs = {
    title: 'Plain Prospects',
    rows: JSON.stringify([{ firm: 'Gamma Law', phone: '555-0300' }]),
  };
  const run = await runPlannedDocumentedCreate({
    sessionId: 'sess-documented-create-plain',
    innerArgs,
  });
  assert.doesNotMatch(run.text, /provider-dispatch:not-started/,
    `the host refused its own planned create: ${run.text.slice(0, 400)}`);
  assert.equal(run.providerBodies.length, 1);
  // A rewrite that changes nothing is a replay, not a refinement: the ledger
  // keeps the raw digest as the call's one contract.
  assert.equal(run.row.effective_argument_digest, null);
  assert.equal(run.row.raw_argument_digest, run.attestation.argumentDigest);
});

/**
 * Part 2 of the same class: the bytes that ADMIT the call vs the bytes that
 * later PROVE it. The expected-work binding is written once at admission over
 * the raw inner arguments — the schema trigger pins it to the OPEN
 * zero-crossing logical row's digest — and is never updated. After part 1 the
 * settled projection and the host capability binding both speak the EFFECTIVE
 * digest. `verifyAtomicContentCommit` compared the admission identity against
 * the crossing identity and refused content_commit evidence for every refined
 * create AFTER the provider had written it.
 *
 * Every identity-bearing row here is REAL and produced by the gateway run:
 * the refined ledger row, the host_v1 root, the host capability binding, the
 * settlement and its canonical projection. A host turn binds expected work
 * only through the plan_task checkpoint machinery, which is out of this pin's
 * reach; so the proof runs on a snapshot of the live store into which the ONE
 * admission-time binding row is written exactly as admission writes it
 * (expected-work-admission.ts: `logicalContract.argumentDigest` of the
 * model's carrier = the raw attestation digest).
 */
test('the content-commit proof of a refined documented create holds against its admission-time binding', async () => {
  const SESSION = 'sess-documented-create-proof';
  const READ_REQUIREMENT = 'collect_prospects';
  const CREATE_REQUIREMENT = 'create_prospects_sheet';
  const innerArgs = {
    title: 'Refined Proof Prospects',
    rows: JSON.stringify([{ firm: 'Delta Family Law', phone: '555-0400' }]),
    artifact_key: 'proposal',
  };
  const run = await runPlannedDocumentedCreate({ sessionId: SESSION, innerArgs });
  assert.doesNotMatch(run.text, /provider-dispatch:not-started/,
    `the host refused its own planned create: ${run.text.slice(0, 400)}`);
  assert.notEqual(run.row.effective_argument_digest, null, 'the ledger refined this call');
  assert.notEqual(run.row.effective_argument_digest, run.row.raw_argument_digest);
  const { sourceUserSeq, callId, acceptedTaskId } = run;

  const created = redeemSuccessfulSettlementResultForHost({
    sessionId: SESSION,
    sourceUserSeq,
    acceptedTaskId,
    logicalToolCallId: callId,
  });
  assert.equal(created.status, 'ok', JSON.stringify(created));
  if (created.status !== 'ok') throw new Error(created.reason);

  const manifest = {
    version: 1 as const,
    mode: 'authoritative' as const,
    readiness: 'ready' as const,
    manifestId: 'manifest:documented-create-proof',
    graphId: 'graph:documented-create-proof',
    graphHash: digest(`graph:${SESSION}`),
    identity: { sessionId: SESSION, sourceUserSeq, turn: 1 },
    nodes: [
      {
        nodeId: `execute/${READ_REQUIREMENT}`,
        effectKind: 'read' as const,
        reversibility: 'reversible' as const,
        resolvedTool: 'prospects_search',
        operationId: READ_REQUIREMENT,
        operationMode: 'collection_read' as const,
        obligations: ['source_observed' as const, 'source_completeness' as const],
      },
      {
        nodeId: `execute/${CREATE_REQUIREMENT}`,
        effectKind: 'external_write' as const,
        reversibility: 'irreversible' as const,
        resolvedTool: run.logicalToolName,
        operationId: CREATE_REQUIREMENT,
        operationMode: 'irreversible_write' as const,
        contentCommitMode: 'documented_atomic_input' as const,
        obligations: ['derivation_from_current_source' as const, 'commit_effect' as const, 'verify_committed_content' as const],
      },
    ],
    edges: [{
      fromNodeId: `execute/${READ_REQUIREMENT}`,
      fromObligation: 'source_completeness' as const,
      toNodeId: `execute/${CREATE_REQUIREMENT}`,
      toObligation: 'derivation_from_current_source' as const,
    }],
  };

  let snapshots = 0;
  const proveOnSnapshot = async (admittedArgumentDigest: string) => {
    const copyPath = path.join(TMP_HOME, `proof-snapshot-${++snapshots}.sqlite`);
    await openEventLog().backup(copyPath);
    const db = new Database(copyPath);
    try {
      // The snapshot is a proof substrate, not a second writer: the admission
      // trigger (open zero-crossing row) and the work-contract foreign key
      // belong to the plan_task path this pin does not drive.
      db.pragma('foreign_keys = OFF');
      db.exec('DROP TRIGGER IF EXISTS trg_expected_work_call_binding_exact_authority');
      db.prepare(`
        INSERT INTO expected_work_call_bindings
          (session_id, source_user_seq, accepted_task_id, logical_tool_call_id,
           contract_id, requirement_id, tool_name, argument_digest, effect_kind,
           cardinality_kind, bound_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'external_write', 'once', ?)
      `).run(
        SESSION, sourceUserSeq, acceptedTaskId, callId,
        `contract-${SESSION}`, CREATE_REQUIREMENT, run.logicalToolName,
        admittedArgumentDigest, new Date().toISOString(),
      );
      db.prepare(`
        INSERT INTO expected_work_generated_artifact_contracts
          (session_id, source_user_seq, logical_tool_call_id, contract_json, created_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(SESSION, sourceUserSeq, callId, JSON.stringify(run.frozenContent), new Date().toISOString());
      return verifyAtomicContentCommit({
        db,
        sessionId: SESSION,
        sourceUserSeq,
        acceptedTaskId,
        manifest: manifest as never,
        node: manifest.nodes[1] as never,
        logicalToolCallId: callId,
        created: {
          rawPayload: created.value.rawPayload,
          toolName: created.value.toolName,
          executionSite: created.value.executionSite,
          physicalDispatchId: created.value.physicalDispatchId,
        },
        resolveSuccessfulResult: () => ({ ok: true, rawPayload: { records: JSON.parse(innerArgs.rows) } }),
        resolveSealedNodeAuthority: () => ({ ok: false, reason: 'host_v1 create owns no sealed graph node' }),
        resolveTypedPhysicalAuthority: () => ({ status: 'missing', reason: 'host_v1 create owns no typed physical authority' }),
      });
    } finally {
      db.close();
    }
  };

  // The admission-time binding and the effective crossing are ONE call: the
  // proof must get past both the expected-work compare and the host-authority
  // compare on the same refined ledger row. What remains is lineage, which
  // this fixture does not freeze.
  const proof = await proveOnSnapshot(run.attestation.argumentDigest);
  assert.notEqual(
    (proof as { reason?: string }).reason,
    'atomic create has no exact expected-work binding',
    JSON.stringify(proof),
  );
  assert.notEqual(
    (proof as { reason?: string }).reason,
    'atomic create result conflicts with durable host account, schema, tool, or argument authority',
    JSON.stringify(proof),
  );
  assert.ok(
    proof.ok || /lineage/.test(proof.reason),
    `the refined create is refused for a non-lineage reason: ${JSON.stringify(proof)}`,
  );

  // An edited admission — bytes the ledger never refined — still conflicts.
  const edited = await proveOnSnapshot(digest(`edited:${SESSION}`));
  assert.equal(edited.ok, false);
  if (!edited.ok) assert.equal(edited.reason, 'atomic create has no exact expected-work binding');
});
