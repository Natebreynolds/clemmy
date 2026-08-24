/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/host-consent-grant-admission.test.ts */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { tool } from '@openai/agents';
import { z } from 'zod';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-host-consent-admission-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-host-consent-admission\n');

const eventlog = await import('./eventlog.js');
const brackets = await import('./brackets.js');
const identities = await import('./attempt-identity.js');
const callAuthority = await import('./accepted-turn-call-authority.js');
const hostBindings = await import('./host-call-capability-binding.js');
const expectedContracts = await import('./expected-work-contract.js');
const expectedAdmission = await import('./expected-work-admission.js');
const logicalContracts = await import('./logical-call-contract.js');
const capabilityManifests = await import('./capability-manifest.js');
const manifestStores = await import('./capability-manifest-store.js');
const capabilityCatalogs = await import('./host-capability-catalog-factory.js');
const capabilityResolution = await import('./capability-resolution.js');
const observations = await import('./independent-capability-observation.js');
const semanticPorts = await import('../semantic-boundary/turn-semantic-port-registry.js');
const semanticCompile = await import('../semantic-boundary/admit-and-compile-accepted-source.js');
const composioSchemas = await import('../../tools/composio-schema-cache.js');
const toolContracts = await import('../../tools/tool-contract-store.js');
const workCalls = await import('../../tools/work-call.js');
const workCallMode = await import('../../tools/work-call-mode.js');
const innerDispatch = await import('../../tools/inner-dispatch.js');
const approvals = await import('./approval-registry.js');
const consent = await import('./host-interactive-consent.js');
const nested = await import('./nested-tool-approval-admission.js');

const priorCatalog = capabilityCatalogs.peekHostCapabilityCatalogFactory();
const priorManifestStore = manifestStores.peekCapabilityManifestStore();
const priorSemanticPort = semanticPorts.peekTurnSemanticModelPort();

test.after(() => {
  innerDispatch._setInnerDispatchToolsForTests(null);
  observations.clearIndependentCapabilityObservations();
  capabilityCatalogs.installHostCapabilityCatalogFactory(priorCatalog);
  manifestStores.installCapabilityManifestStore(priorManifestStore);
  semanticPorts.installTurnSemanticModelPort(priorSemanticPort);
  eventlog.closeEventLog();
  rmSync(HOME, { recursive: true, force: true });
});

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

test('real prepared host consent grants only A, rejects sibling B, and redeems once', async () => {
  const operationId = 'EXAMPLE_SEND_EMAIL';
  const accountId = 'account:consent:email-owner';
  const capabilityId = 'cap:consent:send-email';
  const inputSchema = {
    type: 'object',
    properties: {
      to: { type: 'string' },
      subject: { type: 'string' },
      body: { type: 'string' },
    },
    required: ['to', 'subject', 'body'],
    additionalProperties: false,
  };
  const providerInputSchemaDigest = toolContracts.digestSchema(inputSchema);
  const definitionFingerprint = sha256(JSON.stringify({
    operationId,
    accountId,
    providerInputSchemaDigest,
    version: 1,
  }));
  const manifest = capabilityManifests.attachSemanticContract({
    version: 1,
    manifestId: capabilityId,
    providerKind: 'composio',
    operationId,
    providerIdentity: 'composio:consent-fixture',
    providerVersion: 'composio-catalog-v23',
    operationVersion: '20260824_01',
    definitionFingerprint,
    externalDefinition: {
      version: 1,
      providerInputSchemaDigest,
      semanticName: operationId,
      behaviorHints: {
        readOnly: false,
        destructive: false,
        idempotent: null,
        openWorld: false,
      },
    },
    effect: 'external_write',
    destination: { family: 'external_message', posture: 'named_existing' },
    accountId,
    idempotency: { required: true, policy: 'key_before_dispatch' },
    reconciliation: { supported: true, policy: 'provider_lookup' },
    outputContract: { kind: 'send_receipt' },
    purpose: 'invoke_live_operation',
    acceptedInputKinds: ['arguments'],
    producedOutputKinds: ['send_receipt'],
    applicableDeliverableKinds: ['message'],
    evidenceContract: { kinds: ['receipt'], readbackRequired: false },
    provenance: {
      issuer: 'host-consent-grant-admission:test',
      issuedAt: '2026-08-24T00:00:00.000Z',
      trusted: true,
    },
    lifecycle: { state: 'current' },
    advisoryRoles: ['destination', 'send'],
  });
  const manifestDigest = capabilityManifests.capabilityManifestDigest(manifest);
  const manifestStore = manifestStores.createCapabilityManifestStore([], { durable: true });
  assert.deepEqual(manifestStore.install(manifest), { ok: true, digest: manifestDigest });
  manifestStores.installCapabilityManifestStore(manifestStore);
  const catalog = capabilityCatalogs.createHostCapabilityCatalogFactory();
  catalog.register({
    capabilityId,
    toolName: operationId,
    schemaVersion: manifest.operationVersion,
    schemaDigest: definitionFingerprint,
    providerInputSchemaDigest,
    effect: 'external_write',
    destination: manifest.destination,
    account: accountId,
    advisoryRoles: manifest.advisoryRoles,
    manifestDigest,
    providerKind: 'composio',
    liveFingerprint: definitionFingerprint,
    manifest,
    invoke: async () => ({ successful: true }),
  });
  capabilityCatalogs.installHostCapabilityCatalogFactory(catalog);
  assert.deepEqual(observations.registerIndependentCapabilityObservation({
    operationId,
    accountId,
    definitionFingerprint,
    providerVersion: manifest.providerVersion,
    operationVersion: manifest.operationVersion,
    observedAt: Date.now(),
    origin: 'independent',
  }), { ok: true });
  composioSchemas.rememberToolSchema(
    operationId,
    inputSchema,
    Date.now(),
    manifest.operationVersion,
    { type: 'object', additionalProperties: true },
  );

  const session = eventlog.createSession({ id: 'host-consent-real-preparation', kind: 'chat' });
  const acceptedText = 'Send one email to owner@example.test with the exact supplied subject and body.';
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: acceptedText },
  });
  const catalogRevisionDigest = sha256(`catalog:${session.id}`);
  const bindingRevisionDigest = sha256(`binding:${session.id}`);
  const root = callAuthority.armHostCallAuthority({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    catalogRevisionDigest,
    bindingRevisionDigest,
    maxLogicalCalls: 8,
    maxParallelCalls: 2,
  });
  assert.equal(root.status, 'armed', JSON.stringify(root));

  capabilityResolution.recordAdmissionCapabilityResolution({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    acceptedInput: acceptedText,
    entries: [{
      intent: 'send the exact requested email',
      kind: 'composio',
      identifier: operationId,
      status: 'proven',
      connection: 'active',
      effectClass: 'send',
    }],
  });
  semanticPorts.installTurnSemanticModelPort({
    async interpret() {
      return {
        raw: {
          version: 1,
          relation: 'new_goal',
          targetGoal: null,
          goal: {
            objective: acceptedText,
            criteria: [{ id: 'email-sent', statement: 'The exact requested email is sent once.' }],
            openSlots: [],
            candidates: [{ kind: 'capability', id: capabilityId }],
          },
          work: {
            construct: 'single_act',
            cardinality: null,
            destinations: [{ posture: 'named_existing', family: 'external_message', handleRequired: false }],
            destination: { posture: 'named_existing', family: 'external_message', handleRequired: false },
            requestedEffect: 'external_write',
            operations: [{
              id: 'send-email-once',
              role: 'destination',
              requestedEffect: 'external_write',
              capabilityRef: capabilityId,
              dependsOn: [],
              evidence: ['receipt'],
            }],
            deliverables: [{ id: 'email-receipt', kind: 'message' }],
            evidenceRequirements: ['receipt'],
          },
          slotAnswers: [],
          rationale: 'The user supplied one exact outbound message request.',
        },
        modelIdentity: 'host-consent-semantic-fixture',
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
      };
    },
    async judgeSourceEffect(call) {
      return {
        verdict: 'entailed',
        effect: call.proposedEffect,
        destinationPosture: call.proposedDestinationPosture,
        proposalDigest: call.proposalDigest,
        modelIdentity: 'host-consent-effect-judge',
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
      };
    },
    async judgePlanGrounding(call) {
      return {
        verdict: 'entailed',
        operations: call.dag.operations.map((operation) => ({
          operationId: operation.id,
          verdict: 'entailed' as const,
          rationale: 'The exact selected capability entails this operation.',
        })),
        modelIdentity: 'host-consent-grounding-judge',
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
      };
    },
  });
  const compiled = await semanticCompile.admitAndCompileAcceptedSource({
    identity: { sessionId: session.id, turn: 1, sourceUserSeq: source.seq },
    surface: 'direct',
  });
  assert.equal(compiled.ok, true, compiled.ok ? '' : compiled.reason);
  if (!compiled.ok) return;
  const frozen = expectedContracts.freezeActionExpectedWorkContract({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    graph: compiled.compiled.graph,
    proposal: {
      version: 1,
      operations: [{
        id: 'send-email-once',
        effect: 'external_write',
        dependsOn: [],
        dataFrom: [],
        cardinality: { kind: 'once' },
      }],
      universes: [],
    },
  });
  assert.ok(frozen.status === 'fixed' || frozen.status === 'replayed', JSON.stringify(frozen));
  if (frozen.status !== 'fixed' && frozen.status !== 'replayed') return;
  assert.ok(['activated', 'replayed'].includes(expectedAdmission.activateActionExpectedWork({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  }).status));
  const requirement = frozen.contract.operations.find((entry) => entry.effect === 'external_write');
  assert.ok(requirement);
  if (!requirement) return;

  const gateway = tool({
    name: 'composio_execute_tool',
    description: 'Exact fixture Composio gateway.',
    parameters: z.object({
      tool_slug: z.string(),
      arguments: z.string().nullable(),
      connected_account_id: z.string().nullable(),
    }),
    execute: async () => {
      throw new Error('host consent preparation must stop before the provider body');
    },
  });
  innerDispatch._setInnerDispatchToolsForTests(new Map([
    ['composio_execute_tool', gateway as never],
  ]));
  const workCall = workCalls.buildWorkCall({
    frozenContract: frozen.contract,
    reachableBuiltinNames: new Set(['composio_execute_tool']),
    firstClassNames: new Set<string>(),
    catalogIdentifiers: [operationId],
    settlementLane: 'byo',
  });
  const providerArgs = {
    to: 'owner@example.test',
    subject: 'Release review',
    body: 'Please review the exact candidate.',
  };
  const outerArgs = {
    proposal: null,
    requirement_id: requirement.id,
    universe_item_id: null,
    universe_selector: null,
    seal_amendment: null,
    name: 'composio_execute_tool',
    args_json: JSON.stringify({
      tool_slug: operationId,
      arguments: JSON.stringify(providerArgs),
      connected_account_id: null,
    }),
  };
  const acceptedTaskId = identities.acceptedTaskIdFor(session.id, source.seq);
  const logicalToolCallId = 'host-consent-call-A';
  const outerContract = logicalContracts.durableLogicalCallContract(
    acceptedTaskId,
    'work_call',
    outerArgs,
  );
  assert.ok(outerContract);
  if (!outerContract) return;
  const rootState = callAuthority.acceptedTurnCallAuthorityFor(session.id, source.seq);
  assert.equal(rootState.status, 'ok');
  if (rootState.status !== 'ok') return;
  const attestationBase = {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    acceptedTaskId,
    sourceEventId: rootState.authority.sourceEventId,
    sourceEventDigest: rootState.authority.sourceEventDigest,
    logicalToolCallId,
    toolName: outerContract.toolName,
    argumentDigest: outerContract.argumentDigest,
    effect: 'external_write' as const,
    bindingKind: 'catalog_manifest' as const,
    capabilityId,
    providerInputSchemaDigest,
    schemaFingerprint: definitionFingerprint,
    accountId,
    invokePortId: manifest.invokePortId,
    operationId,
    manifestId: manifest.manifestId,
    manifestDigest,
    engineVersion: rootState.authority.engineVersion,
    surfaceVersion: rootState.authority.surfaceVersion,
    authorityDigest: rootState.authority.authorityDigest,
    authorityRevision: rootState.authority.revision,
    surfaceDigest: rootState.authority.surfaceDigest,
    catalogRevisionDigest,
    bindingRevisionDigest,
  };
  const attestation = {
    ...attestationBase,
    bindingDigest: hostBindings.hostCallAttestationBindingDigest(attestationBase),
  };
  const ambient = {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    turn: 1,
    counter: new brackets.ToolCallsCounter(8),
    behaviorScopeId: `${session.id}::turn:1`,
  };
  const runContext = { context: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 } };
  const prepared = await brackets.withHarnessRunContext(ambient, () =>
    callAuthority.withHostCallAttestation(attestation, () => workCallMode.prepareHostWorkCall(
      workCall,
      {
        sessionId: session.id,
        sourceUserSeq: source.seq,
        logicalToolCallId,
        outerArgs,
        runContext,
        details: { toolCall: { callId: logicalToolCallId, name: 'work_call', arguments: JSON.stringify(outerArgs) } },
      },
    )));
  assert.equal(prepared.status, 'prepared', JSON.stringify(prepared));
  if (prepared.status !== 'prepared') return;
  const captured = workCalls.inspectPreparedHostWorkCall(prepared.preparation);
  assert.ok(captured);
  if (!captured) return;

  const ungranted = await consent.evaluatePreparedHostWorkCallConsent({
    preparation: prepared.preparation,
  });
  assert.equal(ungranted.status, 'decided', JSON.stringify(ungranted));
  assert.equal(ungranted.status === 'decided' ? ungranted.decision.kind : null, 'needs_user');
  if (
    ungranted.status !== 'decided'
    || ungranted.decision.kind !== 'needs_user'
    || ungranted.decision.need !== 'approval'
    || !ungranted.consentSubject
  ) return;
  const resumeKey = consent.hostInteractiveConsentApprovalResumeKey(ungranted.consentSubject);
  assert.ok(resumeKey);
  if (!resumeKey) return;
  const outerRawArguments = JSON.stringify(outerArgs);
  const approval = approvals.registerResumable({
    sessionId: session.id,
    subject: 'Confirm this exact outbound email.',
    tool: 'work_call',
    args: outerArgs,
    resumeKey,
  }).row;
  assert.equal(approvals.resolve(approval.approvalId, 'approved', 'host-consent-test').ok, true);
  const granted = await consent.evaluatePreparedHostWorkCallConsent({
    preparation: prepared.preparation,
    durableApproval: {
      approvalId: approval.approvalId,
      persistedSubject: ungranted.consentSubject,
      outerToolName: 'work_call',
      outerRawArguments,
    },
  });
  assert.equal(granted.status, 'decided', JSON.stringify(granted));
  assert.equal(granted.status === 'decided' ? granted.decision.kind : null, 'proceed');
  assert.equal(
    granted.status === 'decided' && granted.decision.kind === 'proceed'
      ? granted.decision.basis
      : null,
    'exact_user_grant',
  );
  assert.ok(granted.status === 'decided' && granted.nestedAdmission);
  if (granted.status !== 'decided' || !granted.nestedAdmission) return;
  assert.deepEqual(Reflect.ownKeys(granted.nestedAdmission), [], 'no approval tuple is reflectable');

  await callAuthority.withHostCallAttestation(attestation, () => identities.withLogicalToolCall({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    logicalToolCallId,
    tool: captured.targetName,
    args: captured.targetArgs,
  }, async () => nested.withNestedCallAdmission(granted.nestedAdmission!, async () => {
    const siblingArgs = {
      ...(captured.targetArgs as Record<string, unknown>),
      arguments: JSON.stringify({ ...providerArgs, subject: 'Sibling B' }),
    };
    assert.equal(nested.consumeNestedCallAdmission({
      sessionId: session.id,
      toolName: captured.targetName,
      args: siblingArgs,
    }), false, 'A grant cannot be transplanted onto sibling B arguments');
    assert.equal(nested.issueStagedParentCallAdmission({
      sessionId: session.id,
      toolName: captured.targetName,
      args: siblingArgs,
    }), null, 'a rejected sibling cannot mint staged parent authority');
    assert.equal((eventlog.openEventLog().prepare(`
      SELECT COUNT(*) AS n FROM staged_transfer_plans
       WHERE session_id = ? AND source_user_seq = ?
    `).get(session.id, source.seq) as { n: number }).n, 0,
    'a rejected sibling leaves staged plan authority at zero');
    assert.equal(nested.consumeNestedCallAdmission({
      sessionId: session.id,
      toolName: captured.targetName,
      args: captured.targetArgs,
    }), true, 'the exact approved A call redeems');
    assert.equal(nested.consumeNestedCallAdmission({
      sessionId: session.id,
      toolName: captured.targetName,
      args: captured.targetArgs,
    }), false, 'the exact A admission is one-shot');
  })));
});
