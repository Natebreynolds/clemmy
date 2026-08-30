/**
 * Production local-envelope regression for argument-dependent planning safety.
 *
 * Run:
 *   node scripts/run-tests-isolated.mjs src/runtime/harness/local-planning-call-envelope.test.ts
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { after, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-local-planning-envelope-'));
process.env.CLEMENTINE_HOME = HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';
process.env.EMBEDDINGS_DISABLED = 'true';
mkdirSync(path.join(HOME, 'state'), { recursive: true });
writeFileSync(path.join(HOME, 'state', 'machine-id'), 'machine-local-planning-envelope\n', 'utf8');

const eventlog = await import('./eventlog.js');
const authority = await import('./accepted-turn-call-authority.js');
const bindings = await import('./host-call-capability-binding.js');
const contracts = await import('./logical-call-contract.js');
const identities = await import('./attempt-identity.js');
const consent = await import('./host-interactive-consent.js');
const consentPolicy = await import('./interactive-consent-policy.js');
const local = await import('./local-planning-capability.js');

after(() => {
  eventlog.closeEventLog();
  rmSync(HOME, { recursive: true, force: true });
});

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function evaluateLocalEnvelope(
  label: string,
  toolName: string,
  args: Record<string, unknown>,
) {
  const session = eventlog.createSession({ id: `local-envelope-${label}`, kind: 'chat' });
  const source = eventlog.appendEvent({
    sessionId: session.id,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Create one reversible local deliverable.' },
  });
  const catalogRevisionDigest = digest(`catalog:${session.id}`);
  const bindingRevisionDigest = digest(`binding:${session.id}`);
  const armed = authority.armHostCallAuthority({
    sessionId: session.id,
    sourceUserSeq: source.seq,
    catalogRevisionDigest,
    bindingRevisionDigest,
    maxLogicalCalls: 4,
    maxParallelCalls: 1,
  });
  assert.equal(armed.status, 'armed', JSON.stringify(armed));
  if (armed.status !== 'armed') throw new Error(JSON.stringify(armed));

  const observed = await local.observeCurrentLocalPlanningDefinition({
    name: toolName,
    carrier: 'work_call',
  });
  assert.equal(observed.ok, true, observed.ok ? '' : observed.reason);
  if (!observed.ok) throw new Error(observed.reason);
  const acceptedTaskId = identities.acceptedTaskIdFor(session.id, source.seq);
  const logicalToolCallId = `${toolName}-${label}`;
  const contract = contracts.durableLogicalCallContract(acceptedTaskId, toolName, args);
  assert.ok(contract);
  if (!contract) throw new Error(`${toolName} arguments did not produce a logical contract`);

  const base = {
    sessionId: session.id,
    sourceUserSeq: source.seq,
    acceptedTaskId,
    sourceEventId: armed.authority.sourceEventId,
    sourceEventDigest: armed.authority.sourceEventDigest,
    logicalToolCallId,
    toolName: contract.toolName,
    argumentDigest: contract.argumentDigest,
    effect: 'local_write' as const,
    bindingKind: 'local_envelope' as const,
    capabilityId: observed.definition.capabilityRef,
    schemaFingerprint: observed.definition.schemaFingerprint,
    accountId: '',
    invokePortId: `configured-wrapper:${observed.definition.schemaFingerprint}`,
    operationId: toolName,
    manifestId: '',
    manifestDigest: '',
    engineVersion: armed.authority.engineVersion,
    surfaceVersion: armed.authority.surfaceVersion,
    authorityDigest: armed.authority.authorityDigest,
    authorityRevision: armed.authority.revision,
    surfaceDigest: armed.authority.surfaceDigest,
    catalogRevisionDigest,
    bindingRevisionDigest,
  };
  const attestation: authority.HostCallAttestation = Object.freeze({
    ...base,
    bindingDigest: bindings.hostCallAttestationBindingDigest(base),
  });
  return authority.withHostCallAttestation(attestation, () => (
    consent.evaluateUncoveredHostMutationConsent({ attestation, args })
  ));
}

function evaluateWriteEnvelope(
  label: string,
  args: { path: string; content: string; mode: 'create' | 'append' | 'overwrite' | null; append: boolean | null },
) {
  return evaluateLocalEnvelope(label, 'write_file', args);
}

test('production local call envelope projects each exact write_file mode without risk inheritance', async () => {
  const strictNullable = await evaluateWriteEnvelope('strict-null', {
    path: 'new-null.txt', content: 'new', mode: null, append: null,
  });
  assert.equal(strictNullable.status, 'decided', JSON.stringify(strictNullable));
  if (strictNullable.status !== 'decided') return;
  assert.deepEqual(strictNullable.call.risk, {
    reversibility: 'reversible',
    consequence: 'create',
    destructive: false,
  }, 'the production envelope must preserve write_file null -> create semantics');

  const explicitCreate = await evaluateWriteEnvelope('explicit-create', {
    path: 'new-create.txt', content: 'new', mode: 'create', append: null,
  });
  assert.equal(explicitCreate.status, 'decided', JSON.stringify(explicitCreate));
  if (explicitCreate.status !== 'decided') return;
  assert.deepEqual(strictNullable.call.risk, explicitCreate.call.risk);

  for (const [label, args, expectedRisk] of [
    ['overwrite', { path: 'existing.txt', content: 'replace', mode: 'overwrite' as const, append: null }, {
      reversibility: 'irreversible', consequence: 'update', destructive: true,
    }],
    ['append-override', { path: 'existing.txt', content: 'add', mode: 'create' as const, append: true }, {
      reversibility: 'irreversible', consequence: 'update', destructive: false,
    }],
    ['overwrite-override', { path: 'existing.txt', content: 'replace', mode: null, append: false }, {
      reversibility: 'irreversible', consequence: 'update', destructive: true,
    }],
  ] as const) {
    const projected = await evaluateWriteEnvelope(label, args);
    assert.equal(projected.status, 'decided', JSON.stringify(projected));
    if (projected.status !== 'decided') continue;
    assert.deepEqual(projected.call.risk, expectedRisk, `${label} keeps its exact declared risk`);
  }
});

test('exact accepted coverage auto-runs create and emits one canonical approval for append or overwrite', async () => {
  for (const [label, args, expectedKind] of [
    ['create', { path: 'new.txt', content: 'new', mode: 'create' as const, append: null }, 'proceed'],
    ['append', { path: 'existing.txt', content: 'add', mode: 'append' as const, append: null }, 'needs_user'],
    ['overwrite', { path: 'existing.txt', content: 'replace', mode: 'overwrite' as const, append: null }, 'needs_user'],
  ] as const) {
    const projected = await evaluateWriteEnvelope(`policy-${label}`, args);
    assert.equal(projected.status, 'decided', JSON.stringify(projected));
    if (projected.status !== 'decided') continue;
    const call = projected.call;
    const coverage: import('./interactive-consent-policy.js').ExactWorkCoverageV1 = {
      version: 1,
      source: { ...call.source },
      acceptedTaskId: call.acceptedTaskId,
      contractId: `contract:${label}`,
      requirementId: `requirement:${label}`,
      requirementDigest: digest(`requirement:${label}`),
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
        logicalToolCallId: call.logicalToolCallId,
        argumentDigest: call.argumentDigest,
        bindingDigest: call.bindingDigest,
      },
      reservationKey: `reservation:${label}`,
    };
    const decision = consentPolicy.evaluateInteractiveConsentV1({
      call,
      coverage,
      userGrant: null,
      readiness: { kind: 'ready' },
      crossing: 'not_started',
      reservationAlreadyClaimed: false,
    });
    assert.equal(decision.kind, expectedKind, JSON.stringify(decision));
    if (expectedKind === 'proceed') {
      assert.equal(decision.kind === 'proceed' ? decision.basis : null, 'exact_reversible_work');
    } else {
      assert.equal(decision.kind === 'needs_user' ? decision.need : null, 'approval');
      assert.equal(
        decision.kind === 'needs_user' ? decision.subjectDigest : null,
        call.bindingDigest,
        'the approval is bound to this one exact logical call',
      );
    }
  }
});

test('inline Workspace creation remains one exact reversible local mutation envelope', async () => {
  const args = {
    slug: 'inline-envelope',
    title: 'Inline Envelope',
    objective: null,
    success_criteria: null,
    invariants: null,
    view_html: '<html><body><h1>One commit</h1></body></html>',
    view_path: null,
    data_sources: null,
    actions: null,
    reengage_triggers: null,
    reengage_guidance: null,
    origin_session_id: null,
  };
  const result = await evaluateLocalEnvelope('space-save-inline', 'space_save', args);
  assert.equal(result.status, 'decided', JSON.stringify(result));
  if (result.status !== 'decided') return;
  assert.equal(result.call.operationId, 'cap:local:space_save:reversible');
  assert.equal(result.call.effect, 'local_write');
  assert.deepEqual(result.call.cardinality, { kind: 'once' });
  assert.deepEqual(result.call.risk, {
    reversibility: 'reversible',
    consequence: 'create',
    destructive: false,
  });
  assert.equal(result.coverage, null, 'the graph-neutral envelope must not manufacture extra work');
});
