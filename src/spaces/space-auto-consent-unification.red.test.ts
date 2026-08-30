/**
 * Run:
 *   node scripts/run-tests-isolated.mjs --test-concurrency=1 \
 *     src/spaces/space-auto-consent-unification.red.test.ts
 *
 * Causal RED for the Workspace parallel-consent plane.
 *
 * An exact ordinary external create is already classified by the canonical
 * provider-neutral reducer as Auto/proceed. `space_action_prepare` currently
 * ignores that reducer and turns every non-read Composio action into a human
 * approval. Account ambiguity is likewise converted into a blind approval
 * instead of one account choice. These tests stay red until Workspace action
 * preparation projects its exact v3 binding through interactive-consent-policy.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-space-auto-consent-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

const approvals = await import('../runtime/harness/approval-registry.js');
const catalogs = await import('../runtime/harness/host-capability-catalog-factory.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const externalRisk = await import('../runtime/harness/external-capability-risk-loader.js');
const consent = await import('../runtime/harness/interactive-consent-policy.js');
const manifests = await import('../runtime/harness/capability-manifest.js');
const manifestStores = await import('../runtime/harness/capability-manifest-store.js');
const observations = await import('../runtime/harness/independent-capability-observation.js');
const ports = await import('../runtime/harness/production-capability-ports.js');
const toolOutput = await import('../runtime/harness/tool-output-context.js');
const closedJson = await import('../shared/closed-canonical-json.js');
const schemaCache = await import('../tools/composio-schema-cache.js');
const toolContracts = await import('../tools/tool-contract-store.js');
const { registerSpaceTools } = await import('../tools/space-tools.js');
const { spaceStore } = await import('./store.js');

const OPERATION = 'PROOF_CREATE_WORKSPACE_CASE';
const SEND_OPERATION = 'PROOF_SEND_WORKSPACE_MESSAGE';
const INPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    case_title: { type: 'string' },
    details: { type: 'string' },
  },
  required: ['case_title'],
  additionalProperties: false,
});

type Handler = (input: Record<string, unknown>) => Promise<unknown> | unknown;

function captureSpaceActionPrepare(): Handler {
  let handler: Handler | null = null;
  registerSpaceTools({
    tool(name: string, _description: string, _schema: unknown, candidate: Handler) {
      if (name === 'space_action_prepare') handler = candidate;
    },
  } as never);
  assert.ok(handler, 'space_action_prepare is registered');
  return handler!;
}

const spaceActionPrepare = captureSpaceActionPrepare();

function digest(value: unknown): string {
  return createHash('sha256')
    .update(closedJson.closedCanonicalJson(value), 'utf8')
    .digest('hex');
}

function resultText(result: unknown): string {
  return (result as { content?: Array<{ text?: string }> })?.content?.[0]?.text ?? '';
}

interface InstalledCapability {
  accountId: string;
  capabilityId: string;
  manifest: manifests.CapabilityManifestV1;
  manifestDigest: string;
}

function installCapabilities(
  accounts: string[],
  options: {
    operation?: string;
    inputSchema?: Record<string, unknown>;
    behaviorHints?: {
      readOnly: boolean;
      destructive: boolean;
      idempotent: boolean;
      openWorld: boolean;
    };
  } = {},
): {
  installed: InstalledCapability[];
  bodies: () => number;
} {
  const operation = options.operation ?? OPERATION;
  const inputSchema = options.inputSchema ?? INPUT_SCHEMA;
  schemaCache.rememberToolSchema(
    operation,
    inputSchema,
    Date.now(),
    '2026-08-29.1',
    { type: 'object', additionalProperties: true },
  );
  const definitionFingerprint = schemaCache.liveComposioSchemaFingerprint(operation);
  assert.ok(definitionFingerprint, 'the exact current Composio definition is present');
  const providerInputSchemaDigest = toolContracts.digestSchema(inputSchema);
  const store = manifestStores.createCapabilityManifestStore([], { durable: false });
  const catalog = catalogs.createHostCapabilityCatalogFactory();
  let providerBodies = 0;

  const installed = accounts.map((accountId): InstalledCapability => {
    const identitySuffix = createHash('sha256')
      .update(accountId, 'utf8')
      .digest('hex')
      .slice(0, 16);
    const capabilityId = `manifest.workspace.auto-create.${identitySuffix}`;
    const manifest = manifests.attachSemanticContract({
      version: 1,
      manifestId: capabilityId,
      providerKind: 'composio',
      operationId: operation,
      providerIdentity: 'composio:workspace-auto-consent-fixture',
      providerVersion: 'fixture.1',
      operationVersion: '2026-08-29.1',
      definitionFingerprint,
      externalDefinition: {
        version: 1,
        providerInputSchemaDigest,
        semanticName: operation,
        behaviorHints: options.behaviorHints ?? {
          readOnly: false,
          destructive: false,
          idempotent: true,
          openWorld: false,
        },
      },
      effect: 'external_write',
      destination: { family: 'workspace_case', posture: 'create_new' },
      accountId,
      idempotency: { required: true, policy: 'key_before_dispatch' },
      reconciliation: { supported: false, policy: 'none' },
      outputContract: { kind: 'created_case' },
      purpose: 'create_one_bounded_case',
      acceptedInputKinds: ['arguments'],
      producedOutputKinds: ['created_case'],
      applicableDeliverableKinds: ['case'],
      evidenceContract: { kinds: ['receipt'], readbackRequired: false },
      provenance: {
        issuer: 'space-auto-consent-unification.red.test',
        issuedAt: '2026-08-29T00:00:00.000Z',
        trusted: true,
      },
      lifecycle: { state: 'current' },
      advisoryRoles: ['write'],
    });
    const manifestDigest = manifests.capabilityManifestDigest(manifest);
    assert.deepEqual(store.install(manifest), { ok: true, digest: manifestDigest });
    assert.deepEqual(ports.registerFixtureCapabilityPort(
      ports.productionPortIdentityFromManifest(manifest),
      {
        invoke: async (input) => {
          providerBodies += 1;
          return { data: { id: `case-${providerBodies}`, args: input.binding.args } };
        },
      },
    ), { ok: true });
    assert.deepEqual(observations.registerIndependentCapabilityObservation({
      operationId: operation,
      accountId,
      definitionFingerprint,
      providerVersion: manifest.providerVersion,
      operationVersion: manifest.operationVersion,
      observedAt: Date.now(),
      origin: 'independent',
      observe: () => ({
        operationId: operation,
        accountId,
        definitionFingerprint,
        providerVersion: manifest.providerVersion,
        operationVersion: manifest.operationVersion,
        observedAt: Date.now(),
      }),
    }), { ok: true });
    catalog.register({
      capabilityId,
      toolName: operation,
      schemaVersion: manifest.operationVersion,
      schemaDigest: manifest.definitionFingerprint,
      providerInputSchemaDigest,
      effect: manifest.effect,
      destination: manifest.destination,
      account: manifest.accountId,
      advisoryRoles: manifest.advisoryRoles,
      manifestDigest,
      providerKind: manifest.providerKind,
      liveFingerprint: manifest.definitionFingerprint,
      manifest,
      invoke: async () => { throw new Error('catalog callback cannot own provider I/O'); },
    });
    return { accountId, capabilityId, manifest, manifestDigest };
  });

  manifestStores.installCapabilityManifestStore(store);
  catalogs.installHostCapabilityCatalogFactory(catalog);
  return { installed, bodies: () => providerBodies };
}

function canonicalOrdinaryCreateDecision(input: {
  capability: InstalledCapability;
  slug: string;
  actionId: string;
  args: Record<string, unknown>;
}): consent.InteractiveConsentDecisionV1 {
  const capability = input.capability;
  const loaded = externalRisk.loadCatalogManifestExternalRiskAttestationV1({
    version: 1,
    binding: {
      bindingKind: 'catalog_manifest',
      capabilityId: capability.capabilityId,
      providerInputSchemaDigest:
        capability.manifest.externalDefinition!.providerInputSchemaDigest,
      schemaFingerprint: capability.manifest.definitionFingerprint,
      accountId: capability.accountId,
      invokePortId: capability.manifest.invokePortId,
      operationId: capability.manifest.operationId,
      manifestId: capability.manifest.manifestId,
      manifestDigest: capability.manifestDigest,
      effect: capability.manifest.effect,
    },
    inputSchema: INPUT_SCHEMA,
    destination: {
      posture: 'create_new',
      digest: digest({
        workspace: input.slug,
        action: input.actionId,
        args: input.args,
        manifest: capability.manifestDigest,
      }),
    },
    callSignals: { outboundDelivery: null },
    safety: 'admissible',
  });
  assert.equal(loaded.ok, true, JSON.stringify(loaded));
  if (!loaded.ok) throw new Error(loaded.reason);
  assert.deepEqual(loaded.attestation.projection.risk, {
    reversibility: 'ordinary_non_destructive',
    consequence: 'create',
    destructive: false,
  });

  const source = {
    kind: 'workspace_action' as const,
    id: `workspace:${input.slug}:${input.actionId}`,
    digest: digest({ workspace: input.slug, action: input.actionId }),
  };
  const acceptedTaskId = `workspace-task:${input.slug}:${input.actionId}`;
  const logicalToolCallId = `workspace-call:${input.slug}:${input.actionId}`;
  const argumentDigest = digest(input.args);
  const bindingDigest = digest({
    source,
    acceptedTaskId,
    logicalToolCallId,
    argumentDigest,
    manifest: capability.manifestDigest,
  });
  const call: consent.CapabilityRiskAttestationV1 = {
    version: 1,
    source,
    acceptedTaskId,
    bindingDigest,
    logicalToolCallId,
    operationId: capability.manifest.operationId,
    argumentDigest,
    schemaFingerprint: capability.manifest.definitionFingerprint,
    effect: 'external_write',
    accountId: capability.accountId,
    destination: {
      posture: 'create_new',
      digest: digest({
        workspace: input.slug,
        action: input.actionId,
        args: input.args,
        manifest: capability.manifestDigest,
      }),
    },
    cardinality: { kind: 'once' },
    risk: loaded.attestation.projection.risk,
    semanticBasis: loaded.attestation.projection.semanticBasis,
    safety: loaded.attestation.projection.safety,
  };
  const coverage: consent.ExactWorkCoverageV1 = {
    version: 1,
    source: { ...source },
    acceptedTaskId,
    contractId: `workspace-contract:${input.slug}`,
    requirementId: `workspace-requirement:${input.actionId}`,
    requirementDigest: digest({
      workspace: input.slug,
      action: input.actionId,
      manifest: capability.manifestDigest,
      args: input.args,
    }),
    semanticScope: {
      operationId: call.operationId,
      schemaFingerprint: call.schemaFingerprint,
      effect: call.effect,
      accountId: call.accountId,
      destination: { ...call.destination },
      cardinality: { ...call.cardinality },
      semanticBasis: { ...call.semanticBasis },
    },
    callBinding: {
      logicalToolCallId,
      argumentDigest,
      bindingDigest,
    },
    reservationKey: `workspace-reservation:${bindingDigest}`,
  };
  return consent.evaluateInteractiveConsentV1({
    call,
    coverage,
    userGrant: null,
    readiness: { kind: 'ready' },
    crossing: 'not_started',
    reservationAlreadyClaimed: false,
  });
}

async function invokePrepare(input: {
  sessionId: string;
  sourceUserSeq: number;
  callId: string;
  slug: string;
  actionId: string;
  args: Record<string, unknown>;
}): Promise<string> {
  return toolOutput.withToolOutputContext({
    sessionId: input.sessionId,
    sourceUserSeq: input.sourceUserSeq,
    callId: input.callId,
    toolName: 'space_action_prepare',
  }, async () => resultText(await spaceActionPrepare({
    slug: input.slug,
    action_id: input.actionId,
    args_json: JSON.stringify(input.args),
  })));
}

function acceptedSource(sessionId: string, text: string) {
  const session = eventlog.createSession({ id: sessionId, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text },
  });
  return { session, source };
}

test.afterEach(() => {
  catalogs.installHostCapabilityCatalogFactory(null);
  manifestStores.installCapabilityManifestStore(null);
  observations.clearIndependentCapabilityObservations();
  ports.clearProductionCapabilityPorts();
  schemaCache.resetToolSchemaCache();
});

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('RED: an exact ordinary Workspace create follows canonical Auto and emits no approval card', async () => {
  const capability = installCapabilities(['account:workspace:auto-create']);
  const slug = 'auto-create-case';
  const actionId = 'create-case';
  const args = { case_title: 'Bounded customer follow-up', details: 'One exact case.' };
  spaceStore.save({
    id: slug,
    title: 'Auto create case',
    // `confirm` is display/author intent metadata, never execution authority.
    // The current provider definition and canonical reducer still own whether
    // this exact invocation needs a human.
    actions: [{ id: actionId, label: 'Create case', composioSlug: OPERATION, confirm: true }],
  });

  const decision = canonicalOrdinaryCreateDecision({
    capability: capability.installed[0]!,
    slug,
    actionId,
    args,
  });
  assert.equal(decision.kind, 'proceed', JSON.stringify(decision));
  if (decision.kind === 'proceed') assert.equal(decision.basis, 'exact_ordinary_work');

  const accepted = acceptedSource(
    'space-auto-create-source',
    'Create the one exact declared Workspace case now.',
  );
  const output = await invokePrepare({
    sessionId: accepted.session.id,
    sourceUserSeq: accepted.source.seq,
    callId: 'space-auto-create-call',
    slug,
    actionId,
    args,
  });

  assert.equal(
    approvals.listPending({ sessionId: `space-${slug}`, status: 'pending' }).length,
    0,
    `ordinary Auto work must not mint a card: ${output}`,
  );
  assert.equal(capability.bodies(), 1, `ordinary Auto work should execute once: ${output}`);
  assert.match(output, /ran|executed/i);
  assert.doesNotMatch(output, /waiting for approval|not run or dispatched/i);

  const activationSessionId = `workspace-action:${slug}`;
  const decisions = eventlog.listEvents(activationSessionId, {
    types: ['workflow_v3_auto_consent_decided'],
  });
  const activations = eventlog.listEvents(activationSessionId, {
    types: ['workflow_node_invocation_activated'],
  });
  assert.equal(decisions.length, 1, 'one durable Auto decision receipt is committed');
  assert.equal(activations.length, 1, 'the exact v3 activation commits beside the decision');
  assert.equal(
    (decisions[0]?.data.receipt as { decision?: { basis?: string } })?.decision?.basis,
    'exact_ordinary_work',
  );

  const replay = await invokePrepare({
    sessionId: accepted.session.id,
    sourceUserSeq: accepted.source.seq,
    callId: 'space-auto-create-call',
    slug,
    actionId,
    args,
  });
  assert.equal(capability.bodies(), 1, `same one-shot request must replay, not redispatch: ${replay}`);
  assert.equal(eventlog.listEvents(activationSessionId, {
    types: ['workflow_v3_auto_consent_decided'],
  }).length, 1, 'settled replay cannot mint another decision receipt');
  assert.equal(eventlog.listEvents(activationSessionId, {
    types: ['workflow_node_invocation_activated'],
  }).length, 1, 'settled replay cannot mint another activation');
});

test('RED: ambiguous Workspace account asks one choice and never mints a blind approval', async () => {
  const capability = installCapabilities([
    'account:workspace:first',
    'account:workspace:second',
  ]);
  const slug = 'choose-create-account';
  const actionId = 'create-case';
  const args = { case_title: 'Choose the owning account' };
  spaceStore.save({
    id: slug,
    title: 'Choose create account',
    actions: [{ id: actionId, label: 'Create case', composioSlug: OPERATION }],
  });
  const accepted = acceptedSource(
    'space-ambiguous-account-source',
    'Create the declared Workspace case.',
  );
  const output = await invokePrepare({
    sessionId: accepted.session.id,
    sourceUserSeq: accepted.source.seq,
    callId: 'space-ambiguous-account-call',
    slug,
    actionId,
    args,
  });

  assert.equal(capability.bodies(), 0, 'account ambiguity never crosses the provider');
  assert.equal(
    approvals.listPending({ sessionId: `space-${slug}`, status: 'pending' }).length,
    0,
    `account ambiguity is a choice, not an approval: ${output}`,
  );
  assert.match(output, /ambiguous|which account|choose.*account/i);
  assert.doesNotMatch(output, /waiting for approval|prepared.*approval/i);
});

test('high-consequence Workspace sends retain one exact visible approval and zero provider bodies', async () => {
  const sendSchema = {
    type: 'object',
    properties: {
      to: { type: 'string' },
      body: { type: 'string' },
    },
    required: ['to', 'body'],
    additionalProperties: false,
  };
  const capability = installCapabilities(['account:workspace:send'], {
    operation: SEND_OPERATION,
    inputSchema: sendSchema,
    behaviorHints: {
      readOnly: false,
      destructive: false,
      idempotent: false,
      openWorld: false,
    },
  });
  const slug = 'send-workspace-message';
  const actionId = 'send-message';
  const args = { to: 'owner-controlled@example.test', body: 'Exact Workspace safety proof.' };
  spaceStore.save({
    id: slug,
    title: 'Send Workspace message',
    actions: [{ id: actionId, label: 'Send message', composioSlug: SEND_OPERATION }],
  });
  const accepted = acceptedSource(
    'space-send-source',
    'Send the one exact declared Workspace message.',
  );
  const output = await invokePrepare({
    sessionId: accepted.session.id,
    sourceUserSeq: accepted.source.seq,
    callId: 'space-send-call',
    slug,
    actionId,
    args,
  });

  assert.equal(capability.bodies(), 0, 'send cannot cross before the human decision');
  assert.equal(
    approvals.listPending({ sessionId: `space-${slug}`, status: 'pending' }).length,
    1,
    `send should mint exactly one visible card: ${output}`,
  );
  assert.match(output, /waiting for approval|prepared.*approval/i);
  assert.equal(eventlog.listEvents(`workspace-action:${slug}`, {
    types: ['workflow_v3_auto_consent_decided'],
  }).length, 0, 'a needs-approval decision cannot mint an Auto receipt');
});
