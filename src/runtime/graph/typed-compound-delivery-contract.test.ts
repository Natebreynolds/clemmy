/**
 * Regression for the private admitted compiler seam.
 *
 * The live chat loop currently declines the retired semantic ceremony before
 * it can reach compileDurableAcceptedTurnGraph. This test replaces only that
 * function's dynamic preparation import, allowing the production-private
 * sealer to brand the prepared semantics. No seal or authority-minting helper
 * is exported from runtime code.
 */
import '../semantic-boundary/typed-source-test-home.js';
import { rmSync } from 'node:fs';
import { registerHooks } from 'node:module';
import assert from 'node:assert/strict';
import test from 'node:test';

const eventlog = await import('../harness/eventlog.js');
const shadow = await import('./turn-graph-shadow.js');
const authority = await import('../harness/accepted-task-authority.js');
const contracts = await import('../harness/expected-work-contract.js');
const admittedCompiler = await import('./admitted-turn-semantics.js');
const semanticHost = await import('../semantic-boundary/build-semantic-host-view.js');
const semanticAdmission = await import('../semantic-boundary/admit-turn-semantics.js');

const TEST_HOME = process.env.CLEMENTINE_HOME!;
const PREPARED_KEY = Symbol.for('clem.test.typed-compound-delivery-prepared');
const PREPARED_MODULE_URL = 'clem-test:typed-compound-delivery-prepared';

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier === '../semantic-boundary/admit-and-compile-accepted-source.js'
      && /\/runtime\/graph\/admitted-turn-semantics\.(?:js|ts)$/.test(context.parentURL ?? '')
    ) {
      return { url: PREPARED_MODULE_URL, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === PREPARED_MODULE_URL) {
      return {
        format: 'module',
        shortCircuit: true,
        source: `
          const key = Symbol.for('clem.test.typed-compound-delivery-prepared');
          export async function prepareDurableAcceptedTurnCompile() {
            return globalThis[key];
          }
        `,
      };
    }
    return nextLoad(url, context);
  },
});

test.after(() => {
  hooks.deregister();
  eventlog.closeEventLog();
  delete (globalThis as Record<PropertyKey, unknown>)[PREPARED_KEY];
  rmSync(TEST_HOME, { recursive: true, force: true });
});

test('hash-bound admitted compilation preserves compound communication and both contract guards', async () => {
  const acceptedText = 'Collect the top five restaurants into one tabular artifact, '
    + 'then send me the verified link.';
  const session = eventlog.createSession({ id: 'typed-compound-delivery', kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: acceptedText },
  });
  const identity = { sessionId: session.id, turn: 1, sourceUserSeq: source.seq };
  const policyRevision = 'd'.repeat(64);
  const policy = {
    version: 'turn-policy-v1' as const,
    autoApproveScope: 'yolo' as const,
    proactiveWorkAllowed: true,
    allowComposioActions: true,
    allowComputerActions: true,
    requireWorkflowApprovalForExecution: true,
    batchConfirmThreshold: 5,
  };
  const host = semanticHost.buildTurnSemanticHostViewV1({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    acceptedText,
    audienceKey: 'typed-compound-audience',
    userId: 'typed-compound-user',
    conversationKey: 'typed-compound-conversation',
    policyRevision,
  });
  const hostAuthority = {
    policyRevision,
    audienceHash: host.source.audienceHash,
    policyMaxCeiling: 'external_write' as const,
    allowedEffects: ['none', 'read', 'compute', 'host_only', 'unknown', 'local_write', 'external_write'] as const,
  };
  const admitted = semanticAdmission.admitTurnSemantics({
    version: 1,
    relation: 'new_goal',
    targetGoal: null,
    goal: {
      objective: 'Collect five restaurants, construct one artifact, and deliver its verified link.',
      criteria: [{ id: 'complete-delivery', statement: 'The verified artifact link is delivered.' }],
      openSlots: [],
      candidates: [],
    },
    work: {
      construct: 'collect_then_construct',
      cardinality: { count: 5, fields: ['name', 'review', 'link'] },
      destination: { posture: 'create_new', family: 'tabular_artifact', handleRequired: true },
      requestedEffect: 'external_write',
      operations: [],
      deliverables: [{ id: 'artifact', kind: 'tabular_artifact' }],
      evidenceRequirements: ['complete_collection', 'destination_readback'],
    },
    slotAnswers: [],
    rationale: 'One bounded collection, one artifact, then one delivery.',
  }, host, hostAuthority);
  assert.equal(admitted.ok, true, admitted.ok ? '' : JSON.stringify(admitted.issues));
  if (!admitted.ok) return;

  (globalThis as Record<PropertyKey, unknown>)[PREPARED_KEY] = {
    ok: true,
    source: admitted.source,
    policyRevision: admitted.policyRevision,
    clamped: admitted.clamped,
    payloadHash: admitted.payloadHash,
    contextHash: admitted.contextHash,
    semanticProvenanceDigest: 'c'.repeat(64),
    authority: hostAuthority,
    acceptedText,
    sessionKind: 'chat',
    policy,
  };

  const result = await admittedCompiler.compileDurableAcceptedTurnGraph({
    identity,
    surface: 'home',
  });
  assert.equal(result.ok, true, result.ok ? '' : result.reason);
  if (!result.ok) return;

  assert.equal(result.compiled.graph.classification.multiItem.collectThenConstruct, true);
  assert.ok(result.compiled.graph.classification.externalEffectKinds.includes('communication'));
  assert.equal(contracts.requiresPostConstructCommunicationDelivery(result.compiled.graph), true);
  assert.equal(contracts.compileDeterministicExpectedWorkProposal(result.compiled.graph), null);

  const graphEvent = shadow.recordTurnGraphShadow({
    identity,
    surface: 'home',
    graph: result.compiled.graph,
    persistenceTicket: result.persistenceTicket,
  });
  assert.ok(graphEvent, 'the exact privately sealed graph persists with its production ticket');
  assert.equal(authority.armAcceptedTaskAuthority({
    sessionId: session.id,
    sourceUserSeq: source.seq,
  }).status, 'armed');

  const incomplete = contracts.prepareActionExpectedWorkContract({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    proposal: {
      version: 1,
      operations: [
        {
          id: 'source', effect: 'read', coverage: 'complete_set',
          dependsOn: [], dataFrom: [], cardinality: { kind: 'once' },
        },
        {
          id: 'construct', effect: 'external_write',
          dependsOn: ['source'], dataFrom: ['source'], cardinality: { kind: 'once' },
        },
      ],
      universes: [],
    },
  });
  assert.equal(incomplete.status, 'invalid');
  assert.match(
    incomplete.status === 'invalid' ? incomplete.reason : '',
    /source read -> construct write -> verification read -> terminal external write/,
  );
  assert.equal(contracts.loadExpectedWorkContract(session.id, source.seq).status, 'missing');

  const complete = contracts.prepareActionExpectedWorkContract({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    proposal: {
      version: 1,
      operations: [
        {
          id: 'source', effect: 'read', coverage: 'complete_set',
          dependsOn: [], dataFrom: [], cardinality: { kind: 'once' },
        },
        {
          id: 'construct', effect: 'external_write',
          dependsOn: ['source'], dataFrom: ['source'], cardinality: { kind: 'once' },
        },
        {
          id: 'verify', effect: 'read', coverage: 'single',
          dependsOn: ['construct'], dataFrom: ['construct'], cardinality: { kind: 'once' },
        },
        {
          id: 'deliver', effect: 'external_write',
          dependsOn: ['verify'], dataFrom: ['verify'], cardinality: { kind: 'once' },
        },
      ],
      universes: [],
    },
  });
  assert.equal(complete.status, 'prepared', JSON.stringify(complete));
});
