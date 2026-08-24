/** Test support for the production v62 staged-transfer authority path. */
import { createHash } from 'node:crypto';
import * as eventlog from './eventlog.js';
import * as shadow from '../graph/turn-graph-shadow.js';
import * as expectedContracts from './expected-work-contract.js';
import * as expectedAdmission from './expected-work-admission.js';
import * as callAuthority from './accepted-turn-call-authority.js';
import * as hostBindings from './host-call-capability-binding.js';
import * as capabilityManifests from './capability-manifest.js';
import * as capabilityManifestStore from './capability-manifest-store.js';
import * as capabilityCatalogs from './host-capability-catalog-factory.js';
import * as capabilityResolution from './capability-resolution.js';
import * as observations from './independent-capability-observation.js';
import * as semanticPorts from '../semantic-boundary/turn-semantic-port-registry.js';
import * as semanticCompile from '../semantic-boundary/admit-and-compile-accepted-source.js';
import * as identities from './attempt-identity.js';
import * as ledger from './dispatch-ledger.js';
import * as logicalContracts from './logical-call-contract.js';
import * as nested from './nested-tool-approval-admission.js';
import * as approvals from './approval-registry.js';
import * as hostConsent from './host-interactive-consent.js';
import * as staged from './staged-transfer-authority.js';
import * as leases from './dispatch-lease.js';
import * as schemas from '../../tools/composio-schema-cache.js';
import * as composio from '../../integrations/composio/client.js';
import * as providerIdentity from '../../integrations/composio/provider-definition-identity.js';
import * as toolContracts from '../../tools/tool-contract-store.js';
import * as workCalls from '../../tools/work-call.js';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

let serial = 0;

export type ProductionStagedConsentScenario =
  | 'missing'
  | 'wrong'
  | 'rejected'
  | 'expired'
  | 'edited'
  | 'approved';

interface ProductionFixtureInternalOptions {
  uploadSourcePath?: string;
  uploadSourceUrl?: string;
  highConsequence?: boolean;
  consentScenario?: ProductionStagedConsentScenario;
  returnPlanRefusal?: boolean;
  startFirstStage?: boolean;
  /** Test-only fault at the exact plan INSERT, after consent claim CAS. */
  failPlanInsert?: boolean;
}

async function createProductionStagedBusinessFixtureInternal(
  label: string,
  options: ProductionFixtureInternalOptions = {},
) {
  if (options.uploadSourcePath && options.uploadSourceUrl) {
    throw new Error('production staged fixture accepts exactly one upload source');
  }
  const n = ++serial;
  const session = eventlog.createSession({ id: `staged-production-${n}-${label}`, kind: 'chat' });
  const acceptedText = options.highConsequence
    ? 'Send one exact email with the supplied attachment to recipient@example.test.'
    : 'Run the prepared Drive operation.';
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
    maxLogicalCalls: 32,
    maxParallelCalls: 8,
  });
  if (root.status !== 'armed') throw new Error(`host authority refused: ${JSON.stringify(root)}`);

  const acceptedTaskId = identities.acceptedTaskIdFor(session.id, source.seq);
  const logicalToolCallId = `logical:staged-production:${n}`;
  const operationId = options.highConsequence ? 'GMAIL_SEND_EMAIL' : 'GOOGLEDRIVE_UPLOAD_FILE';
  const operationVersion = `20260824_fixture_${n}`;
  const accountId = `connection-drive-fixture-${n}`;
  const ownerUserId = `owner-drive-fixture-${n}`;
  const invokePortId = 'composio:execute-one-shot';
  const uploadSource = options.uploadSourcePath ?? options.uploadSourceUrl;
  const args = options.highConsequence
    ? {
        to: 'recipient@example.test',
        subject: 'Exact staged report',
        body: 'Please review the attached exact report.',
        ...(uploadSource ? { attachment: uploadSource } : {}),
      }
    : uploadSource
      ? { folder_id: 'root', file: uploadSource }
      : { folder_id: 'root' };
  const inputSchema = options.highConsequence
    ? {
        type: 'object',
        properties: {
          to: { type: 'string' },
          subject: { type: 'string' },
          body: { type: 'string' },
          ...(uploadSource ? {
            attachment: { type: 'string', file_uploadable: true },
          } : {}),
        },
        required: uploadSource
          ? ['to', 'subject', 'body', 'attachment']
          : ['to', 'subject', 'body'],
        additionalProperties: false,
      }
    : {
        type: 'object',
        properties: {
          folder_id: { type: 'string' },
          ...(uploadSource ? {
            file: { type: 'string', file_uploadable: true },
          } : {}),
        },
        required: uploadSource ? ['folder_id', 'file'] : ['folder_id'],
        additionalProperties: false,
      };
  const outputSchema = {
    type: 'object',
    properties: {
      id: { type: 'string' },
      file: {
        type: 'object',
        file_downloadable: true,
        properties: {
          s3url: { type: 'string' },
          mimetype: { type: 'string' },
        },
        required: ['s3url'],
      },
    },
    required: ['id'],
    additionalProperties: false,
  };
  schemas.rememberToolSchema(operationId, inputSchema, Date.now(), operationVersion, outputSchema);
  composio.__test__.setConnectedAccountsLoader(async () => [{
    id: accountId,
    status: 'ACTIVE',
    user_id: ownerUserId,
    toolkit: { slug: options.highConsequence ? 'gmail' : 'googledrive' },
  }]);
  await composio.listConnectedToolkits({ requireFresh: true });

  const inputDigest = toolContracts.digestSchema(inputSchema);
  const outputDigest = toolContracts.digestSchema(outputSchema);
  const definitionFingerprint = providerIdentity.fingerprintComposioProviderDefinition({
    operationId,
    operationVersion,
    accountId,
    invokePortId,
    inputSchema,
    outputSchema,
  });
  if (!definitionFingerprint) throw new Error('provider definition fingerprint refused');
  const hostManifest = capabilityManifests.attachSemanticContract({
    version: 1,
    manifestId: `manifest:composio:fixture:${session.id}`,
    providerKind: 'composio',
    operationId,
    providerIdentity: 'composio-sdk',
    providerVersion: providerIdentity.COMPOSIO_PROVIDER_SURFACE_VERSION,
    operationVersion,
    definitionFingerprint,
    externalDefinition: {
      version: 1,
      providerInputSchemaDigest: inputDigest,
      providerOutputSchemaObserved: true,
      providerOutputSchemaDigest: outputDigest,
      semanticName: operationId,
      behaviorHints: {
        readOnly: false,
        destructive: false,
        idempotent: null,
        openWorld: false,
      },
    },
    effect: 'external_write',
    destination: options.highConsequence
      ? { family: 'external_message', posture: 'named_existing' }
      : { family: 'external_file', posture: 'create_new' },
    accountId,
    idempotency: { required: true, policy: 'key_before_dispatch' },
    reconciliation: { supported: true, policy: 'exact_artifact' },
    outputContract: { kind: 'json' },
    purpose: options.highConsequence
      ? 'Send the exact prepared email with its attachment.'
      : 'Execute the exact prepared Drive operation.',
    acceptedInputKinds: ['json'],
    producedOutputKinds: ['provider_receipt'],
    applicableDeliverableKinds: ['file'],
    evidenceContract: { kinds: ['receipt'], readbackRequired: false },
    provenance: { issuer: 'staged-production-fixture', issuedAt: new Date().toISOString(), trusted: true },
    lifecycle: { state: 'current' },
    advisoryRoles: options.highConsequence ? ['destination', 'send'] : ['destination'],
    argumentCompiler: { id: `compiler:${operationId}`, version: operationVersion },
    invokePortId,
    reconcilePortId: 'composio:reconcile-upload',
  });
  const manifestStore = capabilityManifestStore.createCapabilityManifestStore([], { durable: true });
  const installed = manifestStore.install(hostManifest);
  if (!installed.ok) throw new Error(`manifest install refused: ${JSON.stringify(installed)}`);
  if (installed.digest !== capabilityManifests.capabilityManifestDigest(hostManifest)) {
    throw new Error('manifest digest changed');
  }
  capabilityManifestStore.installCapabilityManifestStore(manifestStore);

  let graph: unknown;
  if (options.highConsequence) {
    const capabilityId = hostManifest.manifestId;
    const catalog = capabilityCatalogs.createHostCapabilityCatalogFactory();
    catalog.register({
      capabilityId,
      toolName: operationId,
      schemaVersion: operationVersion,
      schemaDigest: definitionFingerprint,
      providerInputSchemaDigest: inputDigest,
      effect: 'external_write',
      destination: hostManifest.destination,
      account: accountId,
      advisoryRoles: hostManifest.advisoryRoles,
      manifestDigest: installed.digest,
      providerKind: 'composio',
      liveFingerprint: definitionFingerprint,
      manifest: hostManifest,
      invoke: async () => ({ successful: true }),
    });
    capabilityCatalogs.installHostCapabilityCatalogFactory(catalog);
    const observed = observations.registerIndependentCapabilityObservation({
      operationId,
      accountId,
      definitionFingerprint,
      providerVersion: hostManifest.providerVersion,
      operationVersion,
      observedAt: Date.now(),
      origin: 'independent',
    });
    if (!observed.ok) throw new Error(`independent capability observation refused: ${observed.reason}`);
    capabilityResolution.recordAdmissionCapabilityResolution({
      sessionId: session.id,
      sourceUserSeq: source.seq,
      acceptedInput: acceptedText,
      entries: [{
        intent: 'send the exact staged email attachment',
        kind: 'composio',
        identifier: operationId,
        status: 'proven',
        connection: 'active',
        effectClass: 'write',
        accountIdentity: accountId,
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
                id: 'upload_report',
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
            rationale: 'The user supplied one exact outbound email and attachment.',
          },
          modelIdentity: 'staged-consent-semantic-fixture',
          inputTokens: 1,
          outputTokens: 1,
          latencyMs: 1,
        };
      },
      async judgeSourceEffect(call) {
        return {
          verdict: 'entailed' as const,
          effect: call.proposedEffect,
          destinationPosture: call.proposedDestinationPosture,
          proposalDigest: call.proposalDigest,
          modelIdentity: 'staged-consent-effect-judge',
          inputTokens: 1,
          outputTokens: 1,
          latencyMs: 1,
        };
      },
      async judgePlanGrounding(call) {
        return {
          verdict: 'entailed' as const,
          operations: call.dag.operations.map((operation) => ({
            operationId: operation.id,
            verdict: 'entailed' as const,
            rationale: 'The exact selected capability entails this staged send.',
          })),
          modelIdentity: 'staged-consent-grounding-judge',
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
    if (!compiled.ok) throw new Error(`semantic graph refused: ${compiled.reason}`);
    graph = compiled.compiled.graph;
  } else {
    const graphEvent = shadow.recordTurnGraphShadow({
      identity: { sessionId: session.id, sourceUserSeq: source.seq, turn: 1 },
    });
    if (!graphEvent) throw new Error('graph shadow refused');
  }
  const frozen = expectedContracts.freezeActionExpectedWorkContract({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    ...(graph ? { graph } : {}),
    proposal: {
      version: 1,
      operations: [{
        id: 'upload_report',
        effect: 'external_write',
        dependsOn: [],
        dataFrom: [],
        cardinality: { kind: 'once' },
      }],
      universes: [],
    },
  });
  if (frozen.status !== 'fixed' && frozen.status !== 'replayed') {
    throw new Error(`work contract refused: ${JSON.stringify(frozen)}`);
  }
  const activated = expectedAdmission.activateActionExpectedWork({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  });
  if (activated.status !== 'activated' && activated.status !== 'replayed') {
    throw new Error(`work activation refused: ${JSON.stringify(activated)}`);
  }

  const contract = logicalContracts.durableLogicalCallContract(acceptedTaskId, operationId, args);
  if (!contract) throw new Error('logical contract refused');
  const rootState = callAuthority.acceptedTurnCallAuthorityFor(session.id, source.seq);
  if (rootState.status !== 'ok') throw new Error(rootState.reason);
  const attestationBase = {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    acceptedTaskId,
    sourceEventId: rootState.authority.sourceEventId,
    sourceEventDigest: rootState.authority.sourceEventDigest,
    logicalToolCallId,
    toolName: contract.toolName,
    argumentDigest: contract.argumentDigest,
    effect: 'external_write' as const,
    bindingKind: 'catalog_manifest' as const,
    capabilityId: hostManifest.manifestId,
    providerInputSchemaDigest: inputDigest,
    schemaFingerprint: definitionFingerprint,
    accountId,
    invokePortId,
    operationId,
    manifestId: hostManifest.manifestId,
    manifestDigest: installed.digest,
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
  const logical = callAuthority.withHostCallAttestation(attestation, () => ledger.admitLogicalCall({
    identity: { sessionId: session.id, sourceUserSeq: source.seq, acceptedTaskId, logicalToolCallId },
    tool: operationId,
    args,
  }));
  if (logical.status !== 'inserted') throw new Error(`logical admission refused: ${JSON.stringify(logical)}`);
  const work = expectedAdmission.admitExpectedWorkInvocation({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    logicalToolCallId,
    requirementId: 'upload_report',
    tool: operationId,
    args,
  });
  if (work.status !== 'bound' && work.status !== 'replayed') {
    throw new Error(`work binding refused: ${JSON.stringify(work)}`);
  }
  const host = callAuthority.withHostCallAttestation(attestation, () =>
    hostBindings.persistHostCallCapabilityBinding({
      db: eventlog.openEventLog(),
      attestation: callAuthority.currentHostCallAttestation(),
      sessionId: session.id,
      sourceUserSeq: source.seq,
      logicalToolCallId,
      acceptedTaskId,
      toolName: contract.toolName,
      argumentDigest: contract.argumentDigest,
      effect: 'external_write',
    }));
  if (host.status !== 'bound' && host.status !== 'replayed') {
    throw new Error(`host binding refused: ${JSON.stringify(host)}`);
  }
  let approvalEvidence: {
    scenario: ProductionStagedConsentScenario;
    approvalId?: string;
    matched: boolean;
    claimState?: string;
  } | undefined;
  let nestedAdmission: object | null = null;
  if (options.highConsequence) {
    const scenario = options.consentScenario ?? 'missing';
    approvalEvidence = { scenario, matched: false };
    const preparedConsent = callAuthority.withHostCallAttestation(attestation, () =>
      workCalls.prepareExactBoundHostCallForConsent({
        sessionId: session.id,
        sourceUserSeq: source.seq,
        logicalToolCallId,
        targetName: operationId,
        targetArgs: args,
        targetInputSchema: inputSchema,
        settlementLane: 'byo',
      }));
    if (preparedConsent.status !== 'prepared') {
      throw new Error(`host consent preparation refused: ${JSON.stringify(preparedConsent)}`);
    }
    const ungranted = await hostConsent.evaluatePreparedHostWorkCallConsent({
      preparation: preparedConsent.preparation,
    });
    if (
      ungranted.status !== 'decided'
      || ungranted.decision.kind !== 'needs_user'
      || ungranted.decision.need !== 'approval'
      || !ungranted.consentSubject
    ) throw new Error(`host consent did not request the exact approval: ${JSON.stringify(ungranted)}`);
    const consentSubject = ungranted.consentSubject;
    if (scenario !== 'missing') {
      const persistedSubject = scenario === 'wrong'
        ? { ...consentSubject, logicalToolCallId: `${logicalToolCallId}:wrong` }
        : consentSubject;
      const resumeKey = hostConsent.hostInteractiveConsentApprovalResumeKey(persistedSubject);
      if (!resumeKey) throw new Error('host consent resume key refused');
      const outerRawArguments = JSON.stringify(args);
      const row = approvals.registerResumable({
        sessionId: session.id,
        subject: 'Confirm the exact high-consequence staged send.',
        tool: operationId,
        args,
        resumeKey,
        ...(scenario === 'expired' ? { ttlMs: -1 } : {}),
      }).row;
      approvalEvidence.approvalId = row.approvalId;
      const resolution = approvals.resolve(
        row.approvalId,
        scenario === 'rejected' ? 'rejected' : 'approved',
        'staged-production-consent-fixture',
      );
      const matched = hostConsent.durableHostApprovalResolutionMatches({
        approvalId: row.approvalId,
        persistedSubject: consentSubject,
        outerToolName: operationId,
        outerRawArguments: scenario === 'edited'
          ? JSON.stringify({ ...args, subject: 'Edited after approval' })
          : outerRawArguments,
      });
      approvalEvidence.matched = matched;
      if (scenario === 'approved' && resolution.ok && matched) {
        const granted = await hostConsent.evaluatePreparedHostWorkCallConsent({
          preparation: preparedConsent.preparation,
          durableApproval: {
            approvalId: row.approvalId,
            persistedSubject: consentSubject,
            outerToolName: operationId,
            outerRawArguments,
          },
        });
        if (
          granted.status !== 'decided'
          || granted.decision.kind !== 'proceed'
          || granted.decision.basis !== 'exact_user_grant'
          || !granted.nestedAdmission
        ) throw new Error(`exact host consent did not mint nested admission: ${JSON.stringify(granted)}`);
        nestedAdmission = granted.nestedAdmission;
      }
    }
  }
  nestedAdmission ??= nested.issueNestedCallAdmission({
    hostCapabilityBinding: host.binding,
    workBinding: work.binding,
    targetName: operationId,
    targetArgs: args,
    effect: 'external_write',
    authorityDigest: rootState.authority.authorityDigest,
    consentBasis: 'exact_ordinary_work',
  });
  if (!nestedAdmission) throw new Error('nested admission refused');
  let stagedParentAdmission: NonNullable<ReturnType<typeof nested.issueStagedParentCallAdmission>> | null = null;
  const planFaultTrigger = `staged_fixture_plan_fault_${n}`;
  if (options.failPlanInsert) {
    eventlog.openEventLog().exec(`
      CREATE TEMP TRIGGER ${planFaultTrigger}
      BEFORE INSERT ON staged_transfer_plans
      BEGIN
        SELECT RAISE(ABORT, 'injected staged plan insert fault');
      END
    `);
  }
  let preparedPlan: staged.PrepareStagedTransferPlanResult;
  try {
    preparedPlan = await callAuthority.withHostCallAttestation(attestation, () =>
      identities.withLogicalToolCall({
        sessionId: session.id,
        sourceUserSeq: source.seq,
        tool: operationId,
        args,
        logicalToolCallId,
      }, async () => nested.withNestedCallAdmission(nestedAdmission, async () => {
        if (!nested.consumeNestedCallAdmission({ sessionId: session.id, toolName: operationId, args })) {
          throw new Error('nested admission did not consume');
        }
        const parentAdmission = nested.issueStagedParentCallAdmission({
          sessionId: session.id,
          toolName: operationId,
          args,
        });
        if (!parentAdmission) throw new Error('staged parent admission refused');
        stagedParentAdmission = parentAdmission;
        return staged.prepareStagedTransferPlan({ parentAdmission, providerArgs: args });
      })));
  } finally {
    if (options.failPlanInsert) {
      eventlog.openEventLog().exec(`DROP TRIGGER IF EXISTS ${planFaultTrigger}`);
    }
  }
  if (
    preparedPlan.status !== 'prepared'
    && preparedPlan.status !== 'replayed'
    && options.returnPlanRefusal
  ) {
    return {
      session,
      source,
      acceptedTaskId,
      logicalToolCallId,
      operationId,
      operationVersion,
      accountId,
      args,
      outputSchema,
      preparedPlan,
      approvalEvidence,
    };
  }
  if (preparedPlan.status !== 'prepared' && preparedPlan.status !== 'replayed') {
    throw new Error(`staged plan refused: ${JSON.stringify(preparedPlan)}`);
  }
  if (approvalEvidence?.scenario === 'approved' && approvalEvidence.approvalId) {
    const claimed = eventlog.openEventLog().prepare(`
      SELECT consumed_at FROM pending_approvals WHERE approval_id = ?
    `).get(approvalEvidence.approvalId) as { consumed_at: string | null } | undefined;
    approvalEvidence.claimState = claimed?.consumed_at ? 'approved' : 'unclaimed';
  }
  if (!stagedParentAdmission) throw new Error('staged parent admission was lost');
  const recovery = logicalContracts.durableLogicalCallRecoveryMaterial(acceptedTaskId, operationId, args);
  if (!recovery) throw new Error('recovery contract refused');
  const parentLease = leases.activateDispatchLease({
    sessionId: session.id,
    scopeId: `${session.id}::parent`,
  });
  const callLease = leases.activateDispatchLease({
    sessionId: session.id,
    scopeId: `${session.id}::business`,
    parentLease,
    sourceUserSeq: source.seq,
    acceptedTaskId,
    logicalToolCallId,
    recovery: {
      effect: 'external_write',
      businessCall: true,
      material: recovery,
      turn: 1,
    },
  });
  if (options.startFirstStage === false) {
    return {
      session,
      source,
      acceptedTaskId,
      logicalToolCallId,
      operationId,
      operationVersion,
      accountId,
      args,
      outputSchema,
      parentAdmission: stagedParentAdmission,
      callLease,
      preparedPlan,
      approvalEvidence,
      startStatus: 'not_started' as const,
    };
  }
  const preparedStage = staged.prepareStagedPhysicalDispatch({
    planAuthority: preparedPlan.authority,
    stageOrdinal: 1,
    parentDispatchLease: callLease,
  });
  if (preparedStage.status !== 'prepared' && preparedStage.status !== 'replayed') {
    throw new Error(`staged attempt refused: ${JSON.stringify(preparedStage)}`);
  }
  const started = ledger.beginStagedPhysicalDispatch({ authority: preparedStage.authority });
  if (started.status !== 'inserted') throw new Error(`staged crossing refused: ${JSON.stringify(started)}`);
  return {
    session,
    source,
    acceptedTaskId,
    logicalToolCallId,
    operationId,
    operationVersion,
    accountId,
    args,
    outputSchema,
    parentAdmission: stagedParentAdmission,
    callLease,
    preparedPlan,
    preparedStage,
    started,
    approvalEvidence,
  };
}

type ProductionStagedInternalFixture = Awaited<ReturnType<typeof createProductionStagedBusinessFixtureInternal>>;
type ProductionStagedStartedFixture = Extract<ProductionStagedInternalFixture, { preparedStage: unknown }>;
type ProductionStagedUnstartedFixture = Extract<ProductionStagedInternalFixture, { startStatus: 'not_started' }>;
type ProductionStagedBusinessFixtureOptions = {
  uploadSourcePath?: string;
  uploadSourceUrl?: string;
};

export function createProductionStagedBusinessFixture(
  label: string,
  options?: ProductionStagedBusinessFixtureOptions & { startFirstStage?: true },
): Promise<ProductionStagedStartedFixture>;
export function createProductionStagedBusinessFixture(
  label: string,
  options: ProductionStagedBusinessFixtureOptions & { startFirstStage: false },
): Promise<ProductionStagedUnstartedFixture>;
export async function createProductionStagedBusinessFixture(
  label: string,
  options: ProductionStagedBusinessFixtureOptions & { startFirstStage?: boolean } = {},
): Promise<ProductionStagedStartedFixture | ProductionStagedUnstartedFixture> {
  const fixture = await createProductionStagedBusinessFixtureInternal(label, options);
  if (options.startFirstStage === false) {
    if (!('startStatus' in fixture) || fixture.startStatus !== 'not_started') {
      throw new Error(`staged production fixture unexpectedly started: ${JSON.stringify(fixture.preparedPlan)}`);
    }
    return fixture;
  }
  if (!('preparedStage' in fixture) || !fixture.preparedStage || !('started' in fixture) || !fixture.started) {
    throw new Error(`staged production fixture unexpectedly refused: ${JSON.stringify(fixture.preparedPlan)}`);
  }
  return fixture as ProductionStagedStartedFixture;
}

/**
 * High-consequence test fixture. Approval rows are created, resolved, and
 * claimed only through the production host-consent/approval APIs; callers can
 * assert the pre-grant zero-work state or continue from the exact granted
 * staged authority.
 */
export async function createProductionStagedConsentFixture(
  label: string,
  options: {
    uploadSourcePath?: string;
    uploadSourceUrl?: string;
    consentScenario: ProductionStagedConsentScenario;
    failPlanInsert?: boolean;
  },
) {
  return createProductionStagedBusinessFixtureInternal(label, {
    ...options,
    highConsequence: true,
    returnPlanRefusal: true,
  });
}
