import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, beforeEach, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-artifact-ledger-'));
process.env.CLEMENTINE_HOME = home;

const eventlog = await import('./eventlog.js');
const ledger = await import('./artifact-ledger.js');
const catalogs = await import('./host-capability-catalog-factory.js');
const manifests = await import('./capability-manifest.js');
const composioSemantics = await import('../../integrations/composio/operation-semantics.js');

import type { CapabilityManifestV1 } from './capability-manifest.js';
import type { RegisteredHostCapability } from './host-capability-catalog-factory.js';
import type { OperationVerificationContractV1 } from './mutation-verification-contract.js';

const OPAQUE_CREATE = 'OP_QZKVBJ_17';
const OPAQUE_READBACK = 'OP_VBJQZK_29';
const OPAQUE_FAMILY = 'artifact:qzkvbj';

const OPAQUE_CREATE_VERIFICATION = {
  mutation: {
    version: 1,
    resourceFamily: OPAQUE_FAMILY,
    producedHandleKind: 'created_resource',
    proof: 'resource_identity_v1',
    target: { source: 'authoritative_result', pointers: ['/resourceId'] },
  },
} as const satisfies OperationVerificationContractV1;

const OPAQUE_READBACK_VERIFICATION = {
  readback: {
    version: 1,
    resourceFamily: OPAQUE_FAMILY,
    acceptedHandleKind: 'created_resource',
    requestTargetPointers: ['/resourceId'],
    responseTargetPointers: ['/resourceId'],
  },
} as const satisfies OperationVerificationContractV1;

function digest(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function operationManifest(input: {
  operationId: string;
  effect: 'read' | 'external_write';
  family?: string;
  verification?: OperationVerificationContractV1;
  operationSemantics?: CapabilityManifestV1['operationSemantics'];
}): CapabilityManifestV1 {
  const family = input.family ?? OPAQUE_FAMILY;
  const write = input.effect === 'external_write';
  const atomic = input.operationSemantics?.atomicInputContent;
  return manifests.attachSemanticContract({
    version: 1,
    manifestId: `cap:test:${digest(input.operationId).slice(0, 24)}`,
    providerKind: 'composio',
    operationId: input.operationId,
    providerIdentity: 'provider:opaque-fixture',
    providerVersion: 'surface-v1',
    operationVersion: '1',
    definitionFingerprint: digest(`definition:${input.operationId}`),
    externalDefinition: {
      version: 1,
      providerInputSchemaDigest: digest(`input:${input.operationId}`),
      providerOutputSchemaObserved: true,
      providerOutputSchemaDigest: digest(`output:${input.operationId}`),
      semanticName: input.operationId,
      ...(input.verification ? { verification: input.verification } : {}),
      behaviorHints: {
        readOnly: !write,
        destructive: false,
        idempotent: write,
        openWorld: false,
      },
    },
    effect: input.effect,
    ...(input.operationSemantics ? { operationSemantics: input.operationSemantics } : {}),
    destination: { family, posture: write ? 'create_new' : 'named_existing' },
    accountId: 'account:opaque-fixture',
    idempotency: { required: write, policy: write ? 'key_before_dispatch' : 'none' },
    reconciliation: { supported: write, policy: write ? 'exact_artifact' : 'none' },
    outputContract: { kind: write ? 'created_resource' : 'records' },
    evidenceContract: {
      kinds: atomic?.evidence ?? (write ? ['receipt', 'readback'] : ['payload']),
      readbackRequired: atomic ? false : write,
    },
    provenance: { issuer: 'test:artifact-ledger', issuedAt: '2026-08-27T00:00:00.000Z', trusted: true },
    lifecycle: { state: 'current' },
    advisoryRoles: write ? ['destination'] : ['readback'],
  });
}

function registered(manifest: CapabilityManifestV1): RegisteredHostCapability {
  return {
    capabilityId: manifest.manifestId,
    toolName: manifest.operationId,
    schemaVersion: manifest.operationVersion,
    schemaDigest: manifest.definitionFingerprint,
    effect: manifest.effect,
    destination: manifest.destination,
    account: manifest.accountId,
    advisoryRoles: manifest.advisoryRoles,
    manifestDigest: manifests.capabilityManifestDigest(manifest),
    providerKind: manifest.providerKind,
    providerInputSchemaDigest: manifest.externalDefinition?.providerInputSchemaDigest,
    liveFingerprint: manifest.definitionFingerprint,
    manifest,
    invoke: async () => ({}),
  };
}

function withManifests<T>(definitions: readonly CapabilityManifestV1[], run: () => T): T {
  catalogs.installHostCapabilityCatalogFactory(
    catalogs.createHostCapabilityCatalogFactory(definitions.map(registered)),
  );
  try {
    return run();
  } finally {
    catalogs.installHostCapabilityCatalogFactory(null);
  }
}

function withOpaqueArtifactCatalog<T>(run: () => T): T {
  return withManifests([
    operationManifest({
      operationId: OPAQUE_CREATE,
      effect: 'external_write',
      verification: OPAQUE_CREATE_VERIFICATION,
      operationSemantics: { version: 1, reversibility: 'reversible' },
    }),
    operationManifest({
      operationId: OPAQUE_READBACK,
      effect: 'read',
      verification: OPAQUE_READBACK_VERIFICATION,
    }),
  ], run);
}

function opaqueCreateArgs(args: Record<string, unknown>): Record<string, unknown> {
  return { tool_slug: OPAQUE_CREATE, arguments: JSON.stringify(args) };
}

function opaqueReadbackArgs(resourceId: string): Record<string, unknown> {
  return {
    tool_slug: OPAQUE_READBACK,
    arguments: JSON.stringify({ resourceId }),
  };
}

function sheetCreateManifest(): CapabilityManifestV1 {
  return operationManifest({
    operationId: 'GOOGLESHEETS_CREATE_GOOGLE_SHEET1',
    effect: 'external_write',
    family: 'googlesheets',
    operationSemantics: { version: 1, reversibility: 'reversible' },
    verification: {
      mutation: {
        version: 1,
        resourceFamily: 'googlesheets',
        producedHandleKind: 'created_resource',
        proof: 'resource_identity_v1',
        target: { source: 'authoritative_result', pointers: ['/spreadsheetId'] },
      },
    },
  });
}

function sheetReadbackManifest(): CapabilityManifestV1 {
  return operationManifest({
    operationId: 'GOOGLESHEETS_BATCH_GET',
    effect: 'read',
    family: 'googlesheets',
    verification: {
      readback: {
        version: 1,
        resourceFamily: 'googlesheets',
        acceptedHandleKind: 'created_resource',
        requestTargetPointers: ['/spreadsheet_id'],
        responseTargetPointers: ['/spreadsheetId'],
      },
    },
  });
}

function sheetFromJsonManifest(): CapabilityManifestV1 {
  const semantics = composioSemantics.documentedComposioManifestOperationSemantics(
    'GOOGLESHEETS_SHEET_FROM_JSON',
  );
  assert.ok(semantics?.atomicInputContent);
  return operationManifest({
    operationId: 'GOOGLESHEETS_SHEET_FROM_JSON',
    effect: 'external_write',
    family: 'googlesheets',
    operationSemantics: semantics,
  });
}

beforeEach(() => {
  eventlog.resetEventLog();
  ledger._resetArtifactLedgerForTests();
  catalogs.installHostCapabilityCatalogFactory(null);
});

after(() => {
  catalogs.installHostCapabilityCatalogFactory(null);
  rmSync(home, { recursive: true, force: true });
});

function session(): string {
  return eventlog.createSession({ kind: 'chat' }).id;
}

test('local control names without a current artifact descriptor stay inert', () => {
  assert.equal(ledger.artifactIntentForTool('plan_task', {
    objective: 'coordinate the accepted plan',
  }), null);
  assert.equal(ledger.artifactIntentForTool('PLAN_TASK', {
    destination: { posture: 'create_new', family: 'document' },
  }), null, 'request-shaped destination prose cannot replace a current callable manifest');
});

test('familiar provider create names without descriptors cannot gain artifact authority', () => {
  assert.equal(ledger.artifactIntentForTool('composio_execute_tool', {
    tool_slug: 'GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN',
    arguments: JSON.stringify({ title: 'Client snapshot', markdown_text: '# Hi' }),
  }), null);
  assert.equal(ledger.artifactIntentForTool('mcp__googledocs__create_document', {
    title: 'Second', artifact_key: 'appendix',
  }), null);
  assert.equal(ledger.artifactIntentForTool('run_shell_command', {
    command: 'netlify sites:create --name client-snapshot',
  }), null);
});

test('explicit multi-document objectives receive deterministic distinct slots while ordinary renamed retries stay primary', () => {
  const firstRaw = { title: 'Client brief' };
  const secondRaw = { title: 'Technical appendix' };
  const first: ledger.ArtifactIntent = {
    kind: 'google_doc', provider: 'fixture', slotKey: 'google_doc:primary',
    title: firstRaw.title, createShape: 'SEALED_CREATE',
  };
  const second: ledger.ArtifactIntent = { ...first, title: secondRaw.title };
  const objective = 'Create two separate Google Docs: a client brief and a technical appendix.';
  assert.equal(
    ledger.scopeArtifactIntentForObjective(first, objective, firstRaw).slotKey,
    'google_doc:client-brief',
  );
  assert.equal(
    ledger.scopeArtifactIntentForObjective(second, objective, secondRaw).slotKey,
    'google_doc:technical-appendix',
  );
  assert.equal(
    ledger.scopeArtifactIntentForObjective(second, 'Create a Google Doc about the firm.', secondRaw).slotKey,
    'google_doc:primary',
    'a renamed retry in a single-artifact objective must not mint a sibling',
  );
  const siteRaw = { command: 'netlify sites:create --name client-portal' };
  const site: ledger.ArtifactIntent = {
    kind: 'site', provider: 'fixture', slotKey: 'site:primary',
    title: 'client-portal', createShape: 'SEALED_CREATE',
  };
  assert.equal(
    ledger.scopeArtifactIntentForObjective(site, 'Create two separate sites for the client.', siteRaw).slotKey,
    'site:client-portal',
  );
});

test('titleless multi-artifact retries fail closed on primary despite changed mutable content', () => {
  const sid = session();
  const objective = 'Create two separate Google Docs for the client.';
  const firstRaw = { markdown_text: '# Draft one' };
  const retryRaw = { markdown_text: '# Rewritten draft with different formatting' };
  const base: ledger.ArtifactIntent = {
    kind: 'google_doc', provider: 'fixture', slotKey: 'google_doc:primary',
    createShape: 'SEALED_CREATE',
  };
  const first = ledger.scopeArtifactIntentForObjective(
    base,
    objective,
    firstRaw,
  );
  const retry = ledger.scopeArtifactIntentForObjective(
    base,
    objective,
    retryRaw,
  );
  assert.equal(first.slotKey, 'google_doc:primary');
  assert.equal(retry.slotKey, first.slotKey, 'mutable body text is not a durable output identity');
  assert.equal(ledger.claimArtifactSlot(sid, first, 'call-titleless-1', 'run:titleless').acquired, true);
  assert.equal(
    ledger.claimArtifactSlot(sid, retry, 'call-titleless-2', 'run:titleless').acquired,
    false,
    'the rewritten retry cannot mint a second remote document',
  );
});

test('does not classify document subresource creation as a new document', () => {
  assert.equal(ledger.artifactIntentForTool('googledocs__create_tab', { title: 'Tab' }), null);
  assert.equal(ledger.artifactIntentForTool('googledocs__create_header', {}), null);
});

test('guarded additive migration upgrades the original artifact table without losing rows', () => {
  const sid = session();
  const db = eventlog.openEventLog();
  db.exec(`
    DROP TABLE IF EXISTS run_artifacts;
    CREATE TABLE run_artifacts (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      run_scope_id TEXT NOT NULL,
      slot_key TEXT NOT NULL,
      kind TEXT NOT NULL,
      provider TEXT NOT NULL,
      title TEXT,
      create_shape TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','bound','uncertain')),
      resource_id TEXT,
      uri TEXT,
      source_call_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE(session_id, run_scope_id, slot_key)
    );
  `);
  db.prepare(`
    INSERT INTO run_artifacts
      (id, session_id, run_scope_id, slot_key, kind, provider, title, create_shape,
       status, resource_id, uri, source_call_id, created_at, updated_at)
    VALUES ('legacy-artifact', ?, 'run:legacy', 'google_doc:primary', 'google_doc',
      'Google Docs', 'Legacy', 'CREATE', 'bound', 'legacy_doc_123456789',
      'https://docs.google.com/document/d/legacy_doc_123456789/edit', 'legacy-call',
      '2026-07-16T00:00:00.000Z', '2026-07-16T00:00:00.000Z')
  `).run(sid);
  ledger._resetArtifactLedgerForTests();

  const [migrated] = ledger.listRunArtifacts(sid, 'run:legacy');
  assert.equal(migrated?.resourceId, 'legacy_doc_123456789');
  assert.equal(migrated?.bindingVerifiedAt, null);
  const columns = db.prepare('PRAGMA table_info(run_artifacts)').all() as Array<{ name: string }>;
  for (const name of [
    'binding_verified_at', 'verification_call_id', 'verification_shape', 'verification_fingerprint',
  ]) assert.ok(columns.some((column) => column.name === name), name);
});

test('only an exact current readback descriptor can identify verification work', () => {
  withOpaqueArtifactCatalog(() => {
    const exact = ledger.artifactVerificationIntentForTool(
      'composio_execute_tool',
      opaqueReadbackArgs('resource_exact_123456789'),
    );
    assert.deepEqual(exact, {
      kind: 'resource',
      provider: OPAQUE_FAMILY,
      resourceId: 'resource_exact_123456789',
      verificationShape: OPAQUE_READBACK,
      readback: OPAQUE_READBACK_VERIFICATION.readback,
    });
    assert.equal(ledger.artifactVerificationIntentForTool('composio_execute_tool', {
      tool_slug: OPAQUE_READBACK,
      arguments: JSON.stringify({ resourceId: '' }),
    }), null);
    assert.equal(ledger.artifactVerificationIntentForTool('composio_execute_tool', {
      tool_slug: 'GOOGLEDOCS_GET_DOCUMENT_PLAINTEXT',
      arguments: JSON.stringify({ document_id: 'doc' }),
    }), null);
  });
});

test('an artifact slot is claimed once and remains reusable after binding', () => {
  const sid = session();
  const intent: ledger.ArtifactIntent = {
    kind: 'google_doc', provider: 'Google Docs', slotKey: 'google_doc:primary',
    title: 'One document', createShape: 'SEALED_CREATE',
  };
  const first = ledger.claimArtifactSlot(sid, intent, 'call-1');
  assert.equal(first.acquired, true);
  const bound = ledger.bindArtifactSlot(sid, intent.slotKey, {
    resourceId: 'doc_1234567890', uri: 'https://docs.google.com/document/d/doc_1234567890/edit',
  }, 'call-1');
  assert.equal(bound.status, 'bound');
  assert.equal(bound.bindingVerifiedAt, null, 'a create response binds but does not independently verify');

  const retry = ledger.claimArtifactSlot(sid, { ...intent, title: 'Renamed retry' }, 'call-2');
  assert.equal(retry.acquired, false, 'a changed title cannot mint a second primary document');
  assert.equal(retry.artifact.resourceId, 'doc_1234567890');
  const reuse = ledger.artifactReuseMessage(retry.artifact);
  assert.match(reuse, /reconcile the existing create claim; do not create another/i);
  assert.match(reuse, /Update it only under a separately declared authorized operation or turn/i);
  assert.doesNotMatch(reuse, /reuse or update/i);
});

test('claim settlement is owned by the provider call id, not just the slot', () => {
  const sid = session();
  const intent = {
    kind: 'google_doc', provider: 'Google Docs', slotKey: 'google_doc:primary',
    title: 'Owned claim', createShape: 'GOOGLEDOCS_CREATE_DOCUMENT',
  } as const;
  const claim = ledger.claimArtifactSlot(sid, intent, 'toolu-owner', 'run:owned');
  assert.equal(claim.acquired, true);
  assert.equal(
    ledger.bindClaimedArtifact(claim.artifact.id, 'toolu-sibling', { resourceId: 'wrong-doc' }),
    null,
    'an out-of-order sibling result cannot settle this row',
  );
  assert.equal(ledger.getRunArtifact(sid, intent.slotKey, 'run:owned')?.status, 'pending');
  const bound = ledger.bindClaimedArtifact(claim.artifact.id, 'toolu-owner', { resourceId: 'right-doc' });
  assert.equal(bound?.resourceId, 'right-doc');
});

test('artifact root lineage survives same-turn fallback, manual continue, and restart recovery', () => {
  const sid = session();
  eventlog.appendEvent({
    sessionId: sid, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Create a Google Doc about the firm.' },
  });
  const root = ledger.resolveArtifactRunScopeId(sid, 'sdk:attempt-1');
  assert.equal(root, 'sdk:attempt-1');
  assert.equal(
    ledger.resolveArtifactRunScopeId(sid, 'codex:fallback-1'),
    root,
    'a second lane serving the same durable user turn shares the root',
  );
  const intent = {
    kind: 'google_doc', provider: 'Google Docs', slotKey: 'google_doc:primary',
    title: 'Firm', createShape: 'GOOGLEDOCS_CREATE_DOCUMENT',
  } as const;
  ledger.claimArtifactSlot(sid, intent, 'create-1', root);
  ledger.bindArtifactSlot(sid, intent.slotKey, { resourceId: 'doc-lineage' }, 'create-1', root);

  eventlog.appendEvent({
    sessionId: sid, turn: 1, role: 'system', type: 'conversation_completed',
    data: { reason: 'awaiting_continue', reply: 'Say continue.' },
  });
  eventlog.appendEvent({
    sessionId: sid, turn: 2, role: 'user', type: 'user_input_received', data: { text: 'continue' },
  });
  assert.equal(ledger.resolveArtifactRunScopeId(sid, 'sdk:attempt-2'), root, 'manual continue inherits the root');

  eventlog.appendEvent({
    sessionId: sid, turn: 2, role: 'system', type: 'conversation_completed',
    data: { reason: 'interrupted_by_restart', reply: 'Restarted.' },
  });
  eventlog.appendEvent({
    sessionId: sid, turn: 3, role: 'user', type: 'user_input_received',
    data: { text: 'The previous run in this session was interrupted by a daemon restart and has been automatically resumed.\nInspect the audit trail.' },
  });
  assert.equal(ledger.resolveArtifactRunScopeId(sid, 'sdk:after-restart'), root, 'restart recovery inherits the root');

  eventlog.appendEvent({
    sessionId: sid, turn: 3, role: 'system', type: 'conversation_completed', data: { reason: 'success' },
  });
  eventlog.appendEvent({
    sessionId: sid, turn: 4, role: 'user', type: 'user_input_received',
    data: { text: 'Create a new unrelated Google Doc.' },
  });
  assert.equal(
    ledger.resolveArtifactRunScopeId(sid, 'sdk:new-request'),
    'sdk:new-request',
    'an ordinary new request starts a fresh root',
  );
});

test('live approval sources and exact acknowledgement terminals do not split fallback artifact lineage', () => {
  const sid = session();
  const source = eventlog.appendEvent({ sessionId: sid, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Create the requested report.' } });
  const root = ledger.resolveArtifactRunScopeId(sid, 'original-report', source.seq);
  eventlog.appendEvent({ sessionId: sid, turn: 1, role: 'system', type: 'conversation_completed',
    data: { sourceUserSeq: source.seq, reason: 'awaiting_user_input', artifactRunScopeId: root } });
  const control = eventlog.appendEvent({ sessionId: sid, turn: 0, role: 'user', type: 'user_input_received', parentEventId: source.id,
    data: { text: 'Approve the exact card.', synthetic: true,
      liveApprovalControl: { version: 1, ownerAttemptId: 'original-report-owner', ownerSourceUserSeq: source.seq } } });
  eventlog.appendEvent({ sessionId: sid, turn: 0, role: 'system', type: 'conversation_completed',
    data: { sourceUserSeq: control.seq, reason: 'mobile_approval_resolved' } });
  assert.equal(ledger.resolveArtifactRunScopeId(sid, 'same-source-fallback'), root);
  assert.equal(ledger.resolveArtifactRunScopeId(sid, 'explicit-control-scope', control.seq), root);
  assert.equal(ledger.getArtifactRunScope(sid, 'explicit-control-scope')?.sourceUserSeq, control.seq,
    'explicit source selection is unchanged, including its existing awaiting-input inheritance');
  const answer = eventlog.appendEvent({ sessionId: sid, turn: 2, role: 'user', type: 'user_input_received',
    data: { text: 'Cover the production accounts.' } });
  assert.equal(ledger.resolveArtifactRunScopeId(sid, 'answered-report', answer.seq), root,
    'the exact acknowledgement cannot mask the original awaiting-input terminal');
  assert.equal(ledger.getArtifactRunScope(sid, 'answered-report')?.reason, 'awaiting_user_input_reply');
  const ordinary = eventlog.appendEvent({ sessionId: sid, turn: 3, role: 'user', type: 'user_input_received',
    data: { text: 'New separate report.', liveApprovalControl: { version: 1 } } });
  assert.equal(ledger.resolveArtifactRunScopeId(sid, 'separate-report'), 'separate-report',
    'an untyped lookalike is not silently dropped from the source boundary');
  assert.equal(ledger.getArtifactRunScope(sid, 'separate-report')?.sourceUserSeq, ordinary.seq);
});

test('artifact lineage honors the bound source sequence instead of a newer unbound input', () => {
  const sid = session();
  const source = eventlog.appendEvent({
    sessionId: sid,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Create the original firm document.' },
  });
  const root = ledger.resolveArtifactRunScopeId(sid, 'sdk:source-a', source.seq);
  eventlog.appendEvent({
    sessionId: sid,
    turn: 2,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'A newer unrelated request arrived.' },
  });

  assert.equal(
    ledger.resolveArtifactRunScopeId(sid, 'codex:fallback-source-a', source.seq),
    root,
    'a later unbound input cannot split fallback lineage for the bound attempt',
  );
  assert.equal(ledger.getArtifactRunScope(sid, 'codex:fallback-source-a')?.sourceUserSeq, source.seq);
});

test('one durable source authority makes competing artifact-root candidates converge', () => {
  const sid = session();
  const source = eventlog.appendEvent({
    sessionId: sid,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Create the requested client document.' },
  });
  // Materialize the ledger's additive schema before modeling the two lanes.
  ledger.listRunArtifacts(sid);
  const db = eventlog.openEventLog();
  // Model the database state after lane A wins while lane B still holds a
  // stale optimistic candidate. SQLite's unique source authority must make B
  // consume A's root instead of persisting its own.
  db.prepare(`
    INSERT INTO artifact_source_roots
      (session_id, source_user_seq, root_scope_id, created_at)
    VALUES (?, ?, 'sdk:lane-a', '2026-07-17T00:00:00.000Z')
  `).run(sid, source.seq);
  const losingInsert = db.prepare(`
    INSERT OR IGNORE INTO artifact_source_roots
      (session_id, source_user_seq, root_scope_id, created_at)
    VALUES (?, ?, 'codex:lane-b', '2026-07-17T00:00:00.001Z')
  `).run(sid, source.seq);
  assert.equal(losingInsert.changes, 0, 'the source event accepts exactly one root authority');

  assert.equal(
    ledger.resolveArtifactRunScopeId(sid, 'codex:lane-b', source.seq),
    'sdk:lane-a',
    'a contender with a different candidate consumes the authoritative root',
  );
  assert.equal(
    ledger.getArtifactRunScope(sid, 'codex:lane-b')?.reason,
    'same_user_turn_fallback',
  );
  const authorities = db.prepare(`
    SELECT root_scope_id
      FROM artifact_source_roots
     WHERE session_id = ? AND source_user_seq = ?
  `).all(sid, source.seq) as Array<{ root_scope_id: string }>;
  assert.deepEqual(authorities, [{ root_scope_id: 'sdk:lane-a' }]);
});

test('a real-session artifact-root persistence failure is fail-closed', () => {
  const sid = session();
  const source = eventlog.appendEvent({
    sessionId: sid,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Create the client document.' },
  });
  ledger.listRunArtifacts(sid); // materialize additive schema before the trigger
  const db = eventlog.openEventLog();
  db.exec(`
    CREATE TRIGGER artifact_source_roots_fail_test
    BEFORE INSERT ON artifact_source_roots
    BEGIN
      SELECT RAISE(ABORT, 'injected artifact authority persistence failure');
    END;
  `);
  assert.throws(
    () => ledger.resolveArtifactRunScopeId(sid, 'sdk:must-not-escape', source.seq),
    (error: unknown) => error instanceof ledger.ArtifactLineagePersistenceError
      && /injected artifact authority persistence failure/.test(error.message),
  );
  assert.equal(ledger.getArtifactRunScope(sid, 'sdk:must-not-escape'), null);
});

test('only the immediate reply to a typed awaiting-input terminal inherits its exact root', () => {
  const sid = session();
  const request = eventlog.appendEvent({
    sessionId: sid,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Create the deployment document.' },
  });
  const root = ledger.resolveArtifactRunScopeId(sid, 'sdk:paused', request.seq);
  eventlog.appendEvent({
    sessionId: sid,
    turn: 1,
    role: 'system',
    type: 'conversation_completed',
    data: {
      reason: 'awaiting_user_input',
      artifactRunScopeId: root,
      reply: 'Which environment should the document cover?',
    },
  });
  const answer = eventlog.appendEvent({
    sessionId: sid,
    turn: 2,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Production.' },
  });
  assert.equal(ledger.resolveArtifactRunScopeId(sid, 'sdk:answer', answer.seq), root);
  assert.equal(ledger.getArtifactRunScope(sid, 'sdk:answer')?.reason, 'awaiting_user_input_reply');

  const sidWithInterveningInput = session();
  const initial = eventlog.appendEvent({
    sessionId: sidWithInterveningInput,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Create another deployment document.' },
  });
  const oldRoot = ledger.resolveArtifactRunScopeId(sidWithInterveningInput, 'sdk:old', initial.seq);
  eventlog.appendEvent({
    sessionId: sidWithInterveningInput,
    turn: 1,
    role: 'system',
    type: 'conversation_completed',
    data: { reason: 'awaiting_user_input', artifactRunScopeId: oldRoot },
  });
  eventlog.appendEvent({
    sessionId: sidWithInterveningInput,
    turn: 2,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Production.' },
  });
  const later = eventlog.appendEvent({
    sessionId: sidWithInterveningInput,
    turn: 3,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Start a separate unrelated report.' },
  });
  assert.equal(
    ledger.resolveArtifactRunScopeId(sidWithInterveningInput, 'sdk:later', later.seq),
    'sdk:later',
    'an intervening user input breaks awaiting-input reply lineage',
  );
});

test('descriptor-bound verification requires an exact request/result identity and clean success', () => {
  withOpaqueArtifactCatalog(() => {
    const sid = session();
    const runScope = 'run:opaque-readback';
    const resourceId = 'resource_exact_123456789';
    const intent: ledger.ArtifactIntent = {
      kind: 'resource', provider: OPAQUE_FAMILY, slotKey: 'resource:primary',
      title: 'Exact resource', createShape: OPAQUE_CREATE,
    };
    ledger.claimArtifactSlot(sid, intent, 'create-resource', runScope);
    ledger.bindArtifactSlot(sid, intent.slotKey, { resourceId }, 'create-resource', runScope);
    const getter = opaqueReadbackArgs(resourceId);

    assert.equal(ledger.verifyArtifactBindingFromToolResult(
      sid, runScope, 'composio_execute_tool', opaqueReadbackArgs('other-resource'),
      { data: { resourceId: 'other-resource' } }, 'wrong-request',
    ), null);
    assert.equal(ledger.verifyArtifactBindingFromToolResult(
      sid, runScope, 'composio_execute_tool', getter,
      { data: { resourceId: 'other-resource' } }, 'wrong-response',
    ), null);
    assert.equal(ledger.verifyArtifactBindingFromToolResult(
      sid, runScope, 'composio_execute_tool', getter,
      { successful: false, data: { resourceId }, error: 'not found' }, 'failed-read',
    ), null);
    assert.equal(ledger.verifyArtifactBindingFromToolResult(
      sid, runScope, 'composio_execute_tool', getter,
      { data: { resourceId } }, 'native-error', false,
    ), null);

    const verified = ledger.verifyArtifactBindingFromToolResult(
      sid, runScope, 'composio_execute_tool', getter,
      { successful: true, data: { resourceId } }, 'readback-resource',
    );
    assert.ok(verified?.bindingVerifiedAt);
    assert.equal(verified?.verificationCallId, 'readback-resource');
    assert.equal(verified?.verificationShape, OPAQUE_READBACK);
    assert.match(verified?.verificationFingerprint ?? '', /^[a-f0-9]{16}$/);
    assert.deepEqual(ledger.listUnverifiedRunArtifacts(sid, runScope), []);
    assert.match(ledger.artifactReuseMessage(verified!), /provider-verified/i);
  });
});

test('provider-neutral verification survives expiry of the raw tool result', () => {
  withOpaqueArtifactCatalog(() => {
    const sid = session();
    const runScope = 'run:durable-readback';
    const resourceId = 'resource_durable_123456789';
    const intent: ledger.ArtifactIntent = {
      kind: 'resource', provider: OPAQUE_FAMILY, slotKey: 'resource:primary',
      title: 'Durable proof', createShape: OPAQUE_CREATE,
    };
    ledger.claimArtifactSlot(sid, intent, 'create-durable-resource', runScope);
    ledger.bindArtifactSlot(sid, intent.slotKey, { resourceId }, 'create-durable-resource', runScope);
    const output = JSON.stringify({ successful: true, data: { resourceId } });
    eventlog.writeToolOutput({
      sessionId: sid,
      callId: 'readback-durable-resource',
      tool: OPAQUE_READBACK,
      output,
    });
    const verified = ledger.verifyArtifactBindingFromToolResult(
      sid, runScope, 'composio_execute_tool', opaqueReadbackArgs(resourceId),
      output, 'readback-durable-resource',
    );
    assert.ok(verified?.bindingVerifiedAt);

    eventlog.openEventLog().prepare(
      'DELETE FROM tool_outputs WHERE session_id = ? AND call_id = ?',
    ).run(sid, 'readback-durable-resource');
    ledger._resetArtifactLedgerForTests();
    const [durable] = ledger.listRunArtifacts(sid, runScope);
    assert.equal(durable?.verificationCallId, 'readback-durable-resource');
    assert.equal(durable?.verificationShape, OPAQUE_READBACK);
    assert.match(durable?.verificationFingerprint ?? '', /^[a-f0-9]{16}$/);
    assert.ok(durable?.bindingVerifiedAt);
  });
});

test('Google Sheets create extracts its root id and an exact range read verifies the binding', () => {
  withManifests([sheetCreateManifest(), sheetReadbackManifest()], () => {
    const sid = session();
    const runScope = 'run:sheets-readback';
    const spreadsheetId = 'sheet_exact_123456789';
    const createArgs = {
      tool_slug: 'GOOGLESHEETS_CREATE_GOOGLE_SHEET1',
      arguments: JSON.stringify({ title: 'Exact release sheet' }),
    };
    const intent = ledger.artifactIntentForTool('composio_execute_tool', createArgs);
    assert.equal(intent?.provider, 'googlesheets');
    assert.equal(intent?.createShape, 'GOOGLESHEETS_CREATE_GOOGLE_SHEET1');
    assert.deepEqual(ledger.extractArtifactResource(intent!, {
      successful: true,
      data: { spreadsheetId },
    }), { resourceId: spreadsheetId, title: 'Exact release sheet' });
    ledger.claimArtifactSlot(sid, intent!, 'create-sheet', runScope);
    ledger.bindArtifactSlot(sid, intent!.slotKey, { resourceId: spreadsheetId }, 'create-sheet', runScope);

    const getter = {
      tool_slug: 'GOOGLESHEETS_BATCH_GET',
      arguments: JSON.stringify({ spreadsheet_id: spreadsheetId, ranges: ['Sheet1!A1:C4'] }),
    };
    assert.equal(
      ledger.artifactVerificationIntentForTool('composio_execute_tool', getter)?.resourceId,
      spreadsheetId,
    );
    assert.equal(ledger.artifactVerificationIntentForTool('composio_execute_tool', {
      tool_slug: 'GOOGLESHEETS_LIST_SPREADSHEETS', arguments: '{}',
    }), null);
    assert.equal(ledger.verifyArtifactBindingFromToolResult(
      sid, runScope, 'composio_execute_tool', getter,
      { successful: true, data: { spreadsheetId: 'different_sheet' } }, 'wrong-sheet-read',
    ), null);
    const verified = ledger.verifyArtifactBindingFromToolResult(
      sid, runScope, 'composio_execute_tool', getter,
      { successful: true, data: { spreadsheetId } }, 'readback-sheet',
    );
    assert.ok(verified?.bindingVerifiedAt);
    assert.equal(verified?.verificationCallId, 'readback-sheet');
    assert.equal(verified?.verificationShape, 'GOOGLESHEETS_BATCH_GET');
  });
});

test('Google Sheets create never binds an ambient account id ahead of the spreadsheet id', () => {
  withManifests([sheetFromJsonManifest()], () => {
    const intent = ledger.artifactIntentForTool('composio_execute_tool', {
      tool_slug: 'GOOGLESHEETS_SHEET_FROM_JSON',
      arguments: JSON.stringify({
        title: 'Top 5 Ventura Restaurants',
        sheet_name: 'Restaurants',
        sheet_json: [{ name: 'Lure Fish House', rating: 4.6, address: 'Ventura, CA' }],
      }),
    });
    assert.ok(intent);
    const spreadsheetId = 'ventura_sheet_exact_123456789';
    assert.deepEqual(ledger.extractArtifactResource(intent!, {
      successful: true,
      data: {
        account: { id: 'ambient_google_account_987654321' },
        spreadsheetId,
      },
    }), {
      resourceId: spreadsheetId,
      uri: `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`,
      title: 'Top 5 Ventura Restaurants',
    });
  });
});

test('Sheets atomic adapter declaration, not CREATE vocabulary, establishes its root artifact', () => {
  withManifests([sheetFromJsonManifest()], () => {
    const intent = ledger.artifactIntentForTool('composio_execute_tool', {
      tool_slug: 'GOOGLESHEETS_SHEET_FROM_JSON',
      arguments: JSON.stringify({
        title: 'RC evidence', sheet_name: 'Evidence',
        sheet_json: [{ Check: 'candidate', Status: 'PASS' }],
      }),
    });
    assert.equal(intent?.provider, 'googlesheets');
    assert.equal(intent?.createShape, 'GOOGLESHEETS_SHEET_FROM_JSON');
    assert.ok(intent?.resultIdentity);
  });
});

test('explicit artifact keys preserve legitimate multi-document work', () => {
  const sid = session();
  const base = { kind: 'google_doc', provider: 'Google Docs', title: 'Doc', createShape: 'CREATE' } as const;
  assert.equal(ledger.claimArtifactSlot(sid, { ...base, slotKey: 'google_doc:proposal' }).acquired, true);
  assert.equal(ledger.claimArtifactSlot(sid, { ...base, slotKey: 'google_doc:appendix' }).acquired, true);
  assert.equal(ledger.listRunArtifacts(sid).length, 2);
});

test('the same chat may create a new primary document in a later logical run', () => {
  const sid = session();
  const intent = { kind: 'google_doc', provider: 'Google Docs', slotKey: 'google_doc:primary', title: 'Doc', createShape: 'CREATE' } as const;
  assert.equal(ledger.claimArtifactSlot(sid, intent, 'call-1', 'run:first').acquired, true);
  ledger.bindArtifactSlot(sid, intent.slotKey, { resourceId: 'doc_first_12345' }, 'call-1', 'run:first');
  assert.equal(ledger.claimArtifactSlot(sid, intent, 'call-2', 'run:second').acquired, true);
  assert.equal(ledger.listRunArtifacts(sid).length, 2);
  assert.equal(ledger.listRunArtifacts(sid, 'run:first')[0]?.resourceId, 'doc_first_12345');
});

test('a dispatched create with no ID becomes uncertain and cannot be retried blindly', () => {
  const sid = session();
  const intent = { kind: 'site', provider: 'Netlify', slotKey: 'site:primary', title: 'x', createShape: 'NETLIFY_SITE_CREATE' } as const;
  ledger.claimArtifactSlot(sid, intent, 'shell-1');
  const uncertain = ledger.markArtifactUncertain(sid, intent.slotKey, 'shell-1');
  assert.equal(uncertain.status, 'uncertain');
  assert.equal(ledger.claimArtifactSlot(sid, intent, 'shell-2').acquired, false);
});

test('familiar provider output fields cannot mint identity without a sealed projection', () => {
  const intent = { kind: 'google_doc', provider: 'Google Docs', slotKey: 'google_doc:primary', title: 'Snapshot', createShape: 'CREATE' } as const;
  assert.equal(ledger.extractArtifactResource(intent, {
    data: { documentId: 'fixture_google_doc_0000000001', display_url: 'https://docs.google.com/document/d/fixture_google_doc_0000000001/edit' },
  }), null);
  assert.equal(ledger.extractArtifactResource(
    intent,
    'data: { "documentId": "fixture_google_doc_0000000002" }',
  ), null);
});

test('provider prose and provider-shaped objects can never release an artifact claim', () => {
  assert.equal(
    ledger.artifactOutputProvesNoDispatch('[provider-dispatch:not-started:invalid-args]\nMissing title'),
    false,
  );
  assert.equal(ledger.artifactOutputProvesNoDispatch({ ok: false, dispatched: false, reason: 'constraint' }), false);
  assert.equal(ledger.artifactOutputProvesNoDispatch('request timed out; the document may exist'), false);
  assert.equal(ledger.artifactOutputProvesNoDispatch({ successful: false, error: 'provider failed' }), false);
});

test('typed shell outcome releases only local pre-spawn failures', async () => {
  const { classifyShellExecutionOutcome } = await import('../shell-execution-outcome.js');
  const materialization = classifyShellExecutionOutcome({
    command: 'npx provider-cli resource:create --name x',
    externalMutation: true,
    exitCode: 1,
    stdout: '',
    stderr: 'npm error code EACCES\nnpm error path /Users/me/.npm/_cacache\nnpm error permission denied',
  });
  assert.equal(materialization.effect, 'possible');
  assert.equal(ledger.artifactOutputProvesNoDispatch('exit_code: 1', materialization), false);

  const accountRejected = classifyShellExecutionOutcome({
    command: 'netlify sites:create --name x --account-slug wrong-team --json',
    externalMutation: true,
    exitCode: 1,
    stdout: '',
    stderr: 'createSiteInTeam error: 404: Not Found',
  });
  assert.equal(accountRejected.effect, 'possible');
  assert.equal(ledger.artifactOutputProvesNoDispatch('exit_code: 1', accountRejected), false);

  const unknownProviderExit = classifyShellExecutionOutcome({
    command: 'provider-cli resource:create --name x',
    externalMutation: true,
    exitCode: 1,
    stdout: 'resource may have been created',
    stderr: 'final readback failed',
  });
  assert.equal(ledger.artifactOutputProvesNoDispatch('exit_code: 1', unknownProviderExit), false);

  const localSpawnFailure = classifyShellExecutionOutcome({
    command: 'provider-cli resource:create --name x',
    externalMutation: true,
    spawnErrorCode: 'ENOENT',
  });
  assert.equal(localSpawnFailure.effect, 'none');
  assert.equal(ledger.artifactOutputProvesNoDispatch(
    '[provider-dispatch:started] provider output is ignored',
    localSpawnFailure,
  ), true);

  assert.equal(ledger.artifactOutputProvesNoDispatch('ignored', {
    phase: 'provider_execution',
    dispatch: 'not_started',
    effect: 'none',
    externalMutation: true,
    errorKind: 'provider_precondition_rejected',
  }), false, 'a provider-phase typed object cannot masquerade as a local spawn failure');
});

test('CLI command vocabulary cannot classify an artifact without a current descriptor', () => {
  assert.equal(ledger.artifactIntentForTool('run_shell_command', {
    command: 'npx netlify-cli sites:create --name client-snapshot',
  }), null);
  assert.equal(ledger.artifactIntentForTool('run_shell_command', { command: 'netlify deploy --prod --dir dist' }), null);
  assert.equal(ledger.artifactIntentForTool('run_shell_command', { command: 'netlify status' }), null);
});

test('CLI getter vocabulary cannot independently verify an artifact', () => {
  const sid = session();
  const runScope = 'run:netlify-readback';
  const siteId = '00000000-0000-4000-8000-000000000001';
  const intent = {
    kind: 'site', provider: 'Netlify', slotKey: 'site:primary',
    title: 'snapshot-assets', createShape: 'NETLIFY_SITE_CREATE',
  } as const;
  ledger.claimArtifactSlot(sid, intent, 'create-site', runScope);
  ledger.bindArtifactSlot(sid, intent.slotKey, {
    resourceId: siteId, uri: 'https://snapshot-assets.netlify.app',
  }, 'create-site', runScope);

  const getter = { command: `netlify api getSite --data '{"site_id":"${siteId}"}'` };
  assert.equal(ledger.artifactVerificationIntentForTool('run_shell_command', { command: 'netlify status --json' }), null);
  assert.equal(ledger.artifactVerificationIntentForTool('run_shell_command', { command: 'netlify sites:list --json' }), null);
  assert.equal(ledger.verifyArtifactBindingFromToolResult(
    sid, runScope, 'run_shell_command', getter,
    `exit_code: 0\n\nstdout:\n{"id":"${siteId}","name":"snapshot-assets","ssl_url":"https://snapshot-assets.netlify.app"}`,
    'readback-site',
  ), null);
  assert.equal(ledger.listUnverifiedRunArtifacts(sid, runScope).length, 1);
});

test('shell variables cannot manufacture artifact classification', () => {
  assert.equal(ledger.artifactIntentForTool('run_shell_command', {
    command: 'NAME="client-snapshot"; npx netlify-cli sites:create --name "$NAME"',
  }), null);
});

test('CLI prose cannot supply artifact identity without a sealed result projection', () => {
  const intent = {
    kind: 'site', provider: 'Netlify', slotKey: 'site:primary',
    title: 'client-snapshot', createShape: 'NETLIFY_SITE_CREATE',
  } as const;
  const resource = ledger.extractArtifactResource(intent, `Success! Site created\n\nProject ID: 00000000-0000-4000-8000-000000000001\nWebsite URL: https://fixture-client-snapshot.netlify.app\nAdmin URL: https://app.netlify.com/projects/fixture-client-snapshot`);
  assert.equal(resource, null);
});

test('colorized CLI prose also cannot supply artifact identity', () => {
  const intent = {
    kind: 'site', provider: 'Netlify', slotKey: 'site:primary',
    title: 'colorized-site', createShape: 'NETLIFY_SITE_CREATE',
  } as const;
  const resource = ledger.extractArtifactResource(intent, [
    'exit_code: 0',
    '',
    'stdout:',
    '',
    'Project Created',
    '',
    '\x1B[32mAdmin URL: \x1B[39m https://app.netlify.com/projects/colorized-site',
    '\x1B[32mURL: \x1B[39m       https://colorized-site.netlify.app',
    '\x1B[32mProject ID: \x1B[39m00000000-0000-4000-8000-000000000099',
  ].join('\n'));
  assert.equal(resource, null);
});

test('a familiar CLI read cannot promote a URL-only binding without a descriptor', () => {
  const sid = session();
  const runScope = 'run:netlify-url-only';
  const siteId = '00000000-0000-4000-8000-000000000098';
  const intent = {
    kind: 'site', provider: 'Netlify', slotKey: 'site:primary',
    title: 'url-only-site', createShape: 'NETLIFY_SITE_CREATE',
  } as const;
  ledger.claimArtifactSlot(sid, intent, 'create-url-only', runScope);
  ledger.bindArtifactSlot(sid, intent.slotKey, {
    uri: 'https://url-only-site.netlify.app/',
  }, 'create-url-only', runScope);

  assert.equal(ledger.verifyArtifactBindingFromToolResult(
    sid,
    runScope,
    'run_shell_command',
    {
      command: `netlify api getSite --data '{"site_id":"${siteId}"}' | jq '{id,name,ssl_url}'`,
    },
    `exit_code: 0\n\nstdout:\n{"id":"${siteId}","name":"url-only-site","ssl_url":"https://url-only-site.netlify.app"}`,
    'readback-url-only',
  ), null);
  assert.equal(ledger.listUnverifiedRunArtifacts(sid, runScope).length, 1);
});

test('opaque generated create retries cross the provider boundary only once', () => {
  withOpaqueArtifactCatalog(() => {
    const sid = session();
    const runScope = 'run:opaque-retry';
    let providerCreates = 0;
    for (const [index, title] of ['Initial title', 'Renamed retry', 'Third title'].entries()) {
      const intent = ledger.artifactIntentForTool(
        'composio_execute_tool',
        opaqueCreateArgs({ title }),
      );
      assert.ok(intent);
      const claim = ledger.claimArtifactSlot(sid, intent!, `opaque-${index + 1}`, runScope);
      if (!claim.acquired) continue;
      providerCreates += 1;
      const resource = ledger.extractArtifactResource(intent!, {
        successful: true,
        data: { resourceId: 'opaque-resource-1' },
      });
      assert.ok(resource);
      ledger.bindArtifactSlot(sid, intent!.slotKey, resource!, `opaque-${index + 1}`, runScope);
    }
    assert.equal(providerCreates, 1);
    assert.deepEqual(
      ledger.listRunArtifacts(sid, runScope).map((artifact) => [artifact.kind, artifact.status]),
      [['resource', 'bound']],
    );
  });
});

test('partitionSupersededPendingClaims: a dead mid-flight claim is superseded only by a VERIFIED same-kind sibling', async () => {
  const { partitionSupersededPendingClaims } = await import('./artifact-ledger.js');
  const { deepEqual, equal } = await import('node:assert/strict');

  const dead = { id: 'a-dead', kind: 'site', provider: 'netlify', resourceId: null };
  const verifiedSibling = { id: 'a-new', kind: 'site', provider: 'netlify', resourceId: 'site-123' };
  const unrelatedPending = { id: 'a-doc', kind: 'document', provider: 'airtable', resourceId: null };

  // Verified sibling present → the dead claim is superseded; the unrelated one is not.
  const out = partitionSupersededPendingClaims({
    artifacts: [dead, verifiedSibling, unrelatedPending],
    pending: [dead, unrelatedPending],
  });
  deepEqual(out.superseded.map((a) => a.id), ['a-dead']);
  deepEqual(out.stillPending.map((a) => a.id), ['a-doc']);

  // No verified sibling → nothing superseded (fail-closed).
  const none = partitionSupersededPendingClaims({ artifacts: [dead], pending: [dead] });
  equal(none.superseded.length, 0);
  equal(none.stillPending.length, 1);

  // A claim WITH a resourceId is never superseded — it can verify itself.
  const withId = { id: 'a-hasid', kind: 'site', provider: 'netlify', resourceId: 'site-999' };
  const keep = partitionSupersededPendingClaims({ artifacts: [withId, verifiedSibling], pending: [withId] });
  equal(keep.superseded.length, 0);

  // A PENDING sibling (even with a resourceId) supersedes nothing.
  const pendingSibling = { id: 'a-pend', kind: 'site', provider: 'netlify', resourceId: 'site-777' };
  const noPendHelp = partitionSupersededPendingClaims({
    artifacts: [dead, pendingSibling],
    pending: [dead, pendingSibling],
  });
  equal(noPendHelp.superseded.length, 0);
});

test('resolveUncertainArtifactClaim: exact read evidence binds/releases a jailed claim; bound claims are untouchable', async () => {
  const { resolveUncertainArtifactClaim, claimArtifactSlot } = await import('./artifact-ledger.js');
  const { appendEvent, openEventLog, createSession, writeToolOutput } = await import('./eventlog.js');
  const { equal, ok } = await import('node:assert/strict');
  const session = createSession({ id: 'sess-uncertain-claim', kind: 'chat' });
  const db = openEventLog();

  const mkClaim = (id: string, status: string): void => {
    db.prepare(`
      INSERT INTO run_artifacts (id, session_id, run_scope_id, slot_key, kind, provider, status, create_shape, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'site', 'Netlify', ?, 'test-shape', datetime('now'), datetime('now'))
    `).run(id, session.id, 'scope-1', `slot-${id}`, status);
  };
  mkClaim('art-uncertain-1', 'uncertain');
  mkClaim('art-uncertain-2', 'uncertain');
  mkClaim('art-status-content', 'uncertain');
  mkClaim('art-message-content', 'uncertain');
  mkClaim('art-bound-1', 'bound');

  const addVerification = (callId: string, output: string): void => {
    const called = appendEvent({
      sessionId: session.id,
      turn: 1,
      role: 'tool',
      type: 'tool_called',
      data: { callId, tool: 'provider_list', effect: 'read' },
    });
    writeToolOutput({ sessionId: session.id, callId, invocationNonce: `nonce-${callId}`, tool: 'provider_list', output });
    appendEvent({
      sessionId: session.id,
      turn: 1,
      role: 'tool',
      type: 'tool_returned',
      parentEventId: called.id,
      data: { callId, tool: 'provider_list', effect: 'read', result: 'stored separately' },
    });
  };
  addVerification('verify-bind', JSON.stringify({ resources: [{ id: 'site-abc123' }] }));
  addVerification('verify-absent', JSON.stringify({ resources: [] }));
  addVerification('verify-active-status', JSON.stringify({ resources: [], data: { status: 'active' } }));
  addVerification('verify-found-message', JSON.stringify({ resources: [], data: { message: '1 resource found' } }));

  // bind: attaches the id and verifies.
  const bound = resolveUncertainArtifactClaim(session.id, 'art-uncertain-1', {
    kind: 'bind', resourceId: 'site-abc123', verificationCallId: 'verify-bind',
  });
  equal(bound.ok, true);
  const row = db.prepare('SELECT status, resource_id, binding_verified_at FROM run_artifacts WHERE id = ?').get('art-uncertain-1') as { status: string; resource_id: string; binding_verified_at: string | null };
  equal(row.status, 'bound');
  equal(row.resource_id, 'site-abc123');
  ok(row.binding_verified_at, 'bind marks the claim verified');

  // absent: releases the claim entirely.
  equal(resolveUncertainArtifactClaim(session.id, 'art-uncertain-2', { kind: 'absent', verificationCallId: 'verify-absent' }).ok, true);
  equal(db.prepare('SELECT COUNT(*) AS n FROM run_artifacts WHERE id = ?').get('art-uncertain-2') as unknown as { n: number } | undefined && (db.prepare('SELECT COUNT(*) AS n FROM run_artifacts WHERE id = ?').get('art-uncertain-2') as { n: number }).n, 0);

  // An empty sibling cannot prove global absence when the provider's result
  // envelope still contains nonempty state/message content.
  equal(resolveUncertainArtifactClaim(session.id, 'art-status-content', {
    kind: 'absent', verificationCallId: 'verify-active-status',
  }).ok, false);
  equal(resolveUncertainArtifactClaim(session.id, 'art-message-content', {
    kind: 'absent', verificationCallId: 'verify-found-message',
  }).ok, false);
  equal((db.prepare('SELECT status FROM run_artifacts WHERE id = ?').get('art-status-content') as { status: string }).status, 'uncertain');
  equal((db.prepare('SELECT status FROM run_artifacts WHERE id = ?').get('art-message-content') as { status: string }).status, 'uncertain');

  // an already-bound claim is untouchable.
  equal(resolveUncertainArtifactClaim(session.id, 'art-bound-1', { kind: 'absent', verificationCallId: 'verify-absent' }).ok, false);
  // wrong session is refused.
  equal(resolveUncertainArtifactClaim('sess-other', 'art-uncertain-1', { kind: 'absent', verificationCallId: 'verify-absent' }).ok, false);
  void claimArtifactSlot;
});

test('resolveUncertainArtifactClaim refuses stale, reused, and request-echo evidence', async () => {
  const { resolveUncertainArtifactClaim } = await import('./artifact-ledger.js');
  const { appendEvent, createSession, openEventLog, writeToolOutput } = await import('./eventlog.js');
  const session = createSession({ id: 'sess-uncertain-stale-proof', kind: 'chat' });
  const db = openEventLog();
  for (const id of ['art-stale-bind', 'art-stale-absent', 'art-echo-bind']) {
    db.prepare(`
      INSERT INTO run_artifacts
        (id, session_id, run_scope_id, slot_key, kind, provider, status, create_shape, created_at, updated_at)
      VALUES (?, ?, 'scope-stale', ?, 'site', 'Fixture', 'uncertain', 'fixture-create', datetime('now'), datetime('now'))
    `).run(id, session.id, `slot-${id}`);
  }
  const addRead = (callId: string, nonce: string, output: string, turn: number): void => {
    const called = appendEvent({
      sessionId: session.id,
      turn,
      role: 'tool',
      type: 'tool_called',
      data: { callId, tool: 'provider_list', effect: 'read' },
    });
    writeToolOutput({ sessionId: session.id, callId, invocationNonce: nonce, tool: 'provider_list', output });
    appendEvent({
      sessionId: session.id,
      turn,
      role: 'tool',
      type: 'tool_returned',
      parentEventId: called.id,
      data: { callId, tool: 'provider_list', effect: 'read', result: 'stored separately' },
    });
  };

  addRead('reused-bind-proof', 'nonce-old-bind', JSON.stringify({ resources: [{ id: 'site-stale-123' }] }), 1);
  const laterBind = appendEvent({
    sessionId: session.id, turn: 2, role: 'tool', type: 'tool_called',
    data: { callId: 'reused-bind-proof', tool: 'provider_list', effect: 'read' },
  });
  appendEvent({
    sessionId: session.id, turn: 2, role: 'tool', type: 'tool_returned', parentEventId: laterBind.id,
    data: { callId: 'reused-bind-proof', tool: 'provider_list', effect: 'read', result: 'FAILED' },
  });
  const staleBind = resolveUncertainArtifactClaim(session.id, 'art-stale-bind', {
    kind: 'bind', resourceId: 'site-stale-123', verificationCallId: 'reused-bind-proof',
  });
  assert.equal(staleBind.ok, false);
  assert.match(staleBind.reason ?? '', /ambiguous|fresh provider read/);

  addRead('reused-absence-proof', 'nonce-old-empty', JSON.stringify({ resources: [] }), 3);
  addRead('reused-absence-proof', 'nonce-current-nonempty', JSON.stringify({ resources: [{ id: 'site-live' }] }), 4);
  const staleAbsent = resolveUncertainArtifactClaim(session.id, 'art-stale-absent', {
    kind: 'absent', verificationCallId: 'reused-absence-proof',
  });
  assert.equal(staleAbsent.ok, false);

  addRead('echo-bind-proof', 'nonce-echo', JSON.stringify({
    request: { resourceId: 'site-echo-only' },
    resources: [],
  }), 5);
  const echoBind = resolveUncertainArtifactClaim(session.id, 'art-echo-bind', {
    kind: 'bind', resourceId: 'site-echo-only', verificationCallId: 'echo-bind-proof',
  });
  assert.equal(echoBind.ok, false);
  assert.match(echoBind.reason ?? '', /absent from the exact provider result/);

  assert.deepEqual(
    db.prepare(`
      SELECT id, status, resource_id, binding_verified_at
        FROM run_artifacts
       WHERE id IN ('art-stale-bind','art-stale-absent','art-echo-bind')
       ORDER BY id
    `).all(),
    [
      { id: 'art-echo-bind', status: 'uncertain', resource_id: null, binding_verified_at: null },
      { id: 'art-stale-absent', status: 'uncertain', resource_id: null, binding_verified_at: null },
      { id: 'art-stale-bind', status: 'uncertain', resource_id: null, binding_verified_at: null },
    ],
  );
});

test('resolveUncertainArtifactClaim never releases a claim from truncated absence evidence', async () => {
  const { resolveUncertainArtifactClaim } = await import('./artifact-ledger.js');
  const { appendEvent, createSession, openEventLog, resolveToolOutputForAuthority, writeToolOutput } = await import('./eventlog.js');
  const truncatedSession = createSession({ id: 'sess-truncated-absence-proof', kind: 'chat' });
  const db = openEventLog();
  db.prepare(`
    INSERT INTO run_artifacts
      (id, session_id, run_scope_id, slot_key, kind, provider, status, create_shape, created_at, updated_at)
    VALUES ('art-truncated-absence', ?, 'scope-truncated', 'site:primary', 'site', 'Fixture',
            'uncertain', 'fixture-create', datetime('now'), datetime('now'))
  `).run(truncatedSession.id);

  const called = appendEvent({
    sessionId: truncatedSession.id,
    turn: 1,
    role: 'tool',
    type: 'tool_called',
    data: { callId: 'truncated-absence-proof', tool: 'provider_list', effect: 'read' },
  });
  writeToolOutput({
    sessionId: truncatedSession.id,
    callId: 'truncated-absence-proof',
    invocationNonce: 'nonce-truncated-absence',
    tool: 'provider_list',
    output: JSON.stringify({ resources: [] }),
  });
  appendEvent({
    sessionId: truncatedSession.id,
    turn: 1,
    role: 'tool',
    type: 'tool_returned',
    parentEventId: called.id,
    data: { callId: 'truncated-absence-proof', tool: 'provider_list', effect: 'read', result: 'stored separately' },
  });
  db.prepare(`
    UPDATE tool_output_invocations
       SET truncated_at_write = 1
     WHERE session_id = ? AND call_id = ? AND invocation_nonce = ?
  `).run(truncatedSession.id, 'truncated-absence-proof', 'nonce-truncated-absence');

  const authority = resolveToolOutputForAuthority(truncatedSession.id, 'truncated-absence-proof');
  assert.equal(authority.status, 'failed');
  if (authority.status === 'failed') {
    assert.match(authority.reason, /incomplete.*truncation/i);
  }

  const resolution = resolveUncertainArtifactClaim(truncatedSession.id, 'art-truncated-absence', {
    kind: 'absent',
    verificationCallId: 'truncated-absence-proof',
  });
  assert.equal(resolution.ok, false);
  assert.match(resolution.reason ?? '', /verification output is failed.*fresh provider read/i);
  assert.deepEqual(
    db.prepare('SELECT status FROM run_artifacts WHERE id = ?').get('art-truncated-absence'),
    { status: 'uncertain' },
    'the duplicate-write reservation remains jailed',
  );
});

test('permuted opaque manifests classify and project artifacts without provider vocabulary', () => {
  const alphabet = 'QZXJKVBP';
  for (let seed = 1; seed <= 8; seed += 1) {
    const token = Array.from({ length: 6 }, (_, index) =>
      alphabet[(seed * 5 + index * 3) % alphabet.length]).join('');
    const operationId = `OP_${token}_${seed}`;
    const family = `artifact:${token.toLowerCase()}`;
    const verification = {
      mutation: {
        version: 1,
        resourceFamily: family,
        producedHandleKind: 'created_resource',
        proof: 'resource_identity_v1',
        target: { source: 'authoritative_result', pointers: ['/opaqueKey'] },
      },
    } as const satisfies OperationVerificationContractV1;
    withManifests([operationManifest({
      operationId,
      effect: 'external_write',
      family,
      verification,
      operationSemantics: { version: 1, reversibility: 'reversible' },
    })], () => {
      const intent = ledger.artifactIntentForTool('composio_execute_tool', {
        tool_slug: operationId,
        arguments: JSON.stringify({ title: `Artifact ${seed}` }),
      });
      assert.equal(intent?.provider, family);
      assert.equal(intent?.createShape, operationId);
      assert.deepEqual(ledger.extractArtifactResource(intent!, {
        successful: true,
        data: { opaqueKey: `resource-${seed}` },
      }), { resourceId: `resource-${seed}`, title: `Artifact ${seed}` });
    });
  }

  for (const [tool, args] of [
    ['run_shell_command', { command: 'supabase projects:create my-landing' }],
    ['run_shell_command', { command: 'netlify sites:create --name harness-viz' }],
    ['composio_execute_tool', { tool_slug: 'AIRTABLE_CREATE_BASE', arguments: '{"name":"PI Intel"}' }],
    ['mcp__linear__create_project', { name: 'Q3 Launch' }],
    ['execution_create', { title: 'Deploy intel pipeline' }],
  ] as const) {
    assert.equal(ledger.artifactIntentForTool(tool, args), null);
  }
});

test('host-sealed graph artifacts retain the exact id and non-HTTP provider handle', () => {
  const intent: ledger.ArtifactIntent = {
    kind: 'resource',
    provider: 'host-sealed-graph',
    slotKey: 'expected-work:create_resource',
    createShape: 'HOST_SEALED_EXPECTED_WORK_CREATE',
  };
  const envelope = {
    data: {
      id: 'resource-1',
      handle: 'competitive://resources/resource-1',
      receipt: 'provider-receipt-1',
    },
    error: null,
    successful: true,
  };
  assert.deepEqual(ledger.extractArtifactResource(intent, JSON.stringify(envelope)), {
    resourceId: 'resource-1',
    uri: 'competitive://resources/resource-1',
    title: undefined,
  });
  assert.equal(ledger.extractArtifactResource(intent, {
    ...envelope,
    request: { id: 'resource-1' },
  }), null, 'an envelope with an ambient request echo is not exact provider authority');
});

test('an unresolved artifact denial carries the exact repair claim id', () => {
  const sid = session();
  const intent: ledger.ArtifactIntent = {
    kind: 'resource', provider: OPAQUE_FAMILY, slotKey: 'resource:primary',
    title: 'repairable-resource', createShape: OPAQUE_CREATE,
  };
  const claim = ledger.claimArtifactSlot(sid, intent, 'call-create-site');
  ledger.markArtifactUncertain(sid, intent.slotKey, 'call-create-site');
  const message = ledger.artifactReuseMessage(claim.artifact);
  assert.match(message, new RegExp(`artifactId ${claim.artifact.id}`));
  assert.match(message, /artifact_claim_resolve/);
  assert.match(message, /resolution="bind"/);
  assert.match(message, /resolution="absent"/);
});

test('a uniform-failure abort boundary excludes dead pre-abort rounds from fan-out coverage', async () => {
  const { summarizeFanoutCoverage } = await import('./fanout-ledger.js');
  const session = eventlog.createSession({ id: 'sess-fanout-abort-boundary', kind: 'chat' });
  for (const item of ['a', 'b', 'c']) {
    eventlog.appendEvent({ sessionId: session.id, turn: 0, role: 'system', type: 'worker_result', data: { item, ok: false, lane: 'orchestrator' } });
  }
  assert.equal(summarizeFanoutCoverage(session.id).failed, 3, 'pre-boundary the dead round blocks');
  eventlog.appendEvent({ sessionId: session.id, turn: 0, role: 'system', type: 'fanout_run_boundary', data: { reason: 'uniform_failure_abort' } });
  const after = summarizeFanoutCoverage(session.id);
  assert.equal(after.total, 0);
  assert.equal(after.failed, 0);
});

test('retention sweeps: stale rows reaped, fresh rows kept (cancellations / telemetry / route metrics)', async () => {
  const { reapStaleChatCancellations, openEventLog } = await import('./eventlog.js');
  const { reapStaleOperationalEvents, recordOperationalEvent, openOperationalTelemetryDb } = await import('../operational-telemetry.js');
  const { reapStaleModelRouteMetrics, recordModelRouteDecision, openModelRouteMetricsDb } = await import('../model-route-metrics.js');
  const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();

  const hdb = openEventLog();
  hdb.prepare('INSERT OR REPLACE INTO harness_chat_request_cancellations (request_id, requested_at, reason) VALUES (?, ?, ?)')
    .run('req-old-1', old, 'test');
  hdb.prepare('INSERT OR REPLACE INTO harness_chat_request_cancellations (request_id, requested_at, reason) VALUES (?, ?, ?)')
    .run('req-new-1', new Date().toISOString(), 'test');
  assert.ok(reapStaleChatCancellations() >= 1);
  assert.equal((hdb.prepare("SELECT COUNT(*) AS n FROM harness_chat_request_cancellations WHERE request_id='req-new-1'").get() as { n: number }).n, 1);

  recordOperationalEvent({ source: 'harness', type: 'worker_queued', payload: { probe: true } });
  openOperationalTelemetryDb().prepare('UPDATE operational_events SET ts = ? WHERE 1=1 AND ts > ?').run(old, old);
  assert.ok(reapStaleOperationalEvents() >= 1, 'aged telemetry rows reaped');

  recordModelRouteDecision({ role: 'worker', resolvedModel: 'glm-5.2', provider: 'byo', source: 'default', reason: {} });
  openModelRouteMetricsDb().prepare('UPDATE model_route_decisions SET created_at = ?').run(old);
  assert.ok(reapStaleModelRouteMetrics() >= 1, 'aged route decisions reaped');
});

test('question-store unification: answering the check-in copy resumes the linked task; task-side answers close the check-in', async () => {
  const { createCheckIn, getCheckIn, listOpenCheckIns } = await import('../../agents/check-ins.js');
  const { answerExactCheckIn } = await import('../../execution/inbox-questions.js');
  const { createBackgroundTask, markBackgroundTaskAwaitingInput, getBackgroundTask, queueBackgroundTaskInputResolution } = await import('../../execution/background-tasks.js');
  const origin = eventlog.createSession({ id: 'sess-qstore-unify', kind: 'chat' });

  // Direction 1: check-in answer resumes the task.
  const task = createBackgroundTask({ title: 'Q-store unify A', prompt: 'x', originSessionId: origin.id });
  markBackgroundTaskAwaitingInput(task.id, 'q-unify-a', 'Which region?');
  const checkIn = createCheckIn({
    agentSlug: 'clementine',
    question: 'Which region should I use?',
    linkedTaskId: task.id,
    linkedQuestionId: 'q-unify-a',
  });
  const checkInAnswer = answerExactCheckIn({ checkInId: checkIn.id, answer: 'US-West' });
  assert.equal(checkInAnswer.status, 'resuming');
  await new Promise((r) => setTimeout(r, 120)); // the bridge is fire-and-forget
  assert.equal(getBackgroundTask(task.id)?.status, 'pending', 'check-in answer queued the task continuation');
  assert.equal(getBackgroundTask(task.id)?.inputResolution?.answer, 'US-West');

  // Direction 2: task-side answer closes the linked check-in copy.
  const task2 = createBackgroundTask({ title: 'Q-store unify B', prompt: 'y', originSessionId: origin.id });
  markBackgroundTaskAwaitingInput(task2.id, 'q-unify-b', 'Which workspace?');
  const checkIn2 = createCheckIn({
    agentSlug: 'clementine',
    question: 'Which workspace?',
    linkedTaskId: task2.id,
    linkedQuestionId: 'q-unify-b',
  });
  queueBackgroundTaskInputResolution('q-unify-b', 'wspX');
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(getCheckIn(checkIn2.id)?.status, 'closed', 'the ghost question was closed');
  assert.ok(!listOpenCheckIns().some((c) => c.id === checkIn2.id));
});

// Live 2026-07-23: a successfully created Google Sheet (bound, URI in hand,
// VALUES_UPDATE already writing to it) parked the run behind "the create
// attempt is unresolved… reply retry" — an unanswerable loop, since the
// standard lane has no verification machinery. A BOUND claim is the
// deliverable; only truly-unresolved dispatch outcomes (pending/uncertain)
// belong in the double-create park set.
test('bound-but-unverified claims are deliverable — only pending/uncertain park', () => {
  withManifests([sheetCreateManifest()], () => {
    const sid = session();
    const intent = ledger.artifactIntentForTool('composio_execute_tool', {
      tool_slug: 'GOOGLESHEETS_CREATE_GOOGLE_SHEET1',
      arguments: JSON.stringify({ title: 'Firm Outreach Drafts — Jul 23' }),
    })!;
    const claim = ledger.claimArtifactSlot(sid, intent, 'call-sheet-1');
    assert.equal(claim.acquired, true);
    assert.equal(ledger.listUnresolvedCreateClaims(sid).length, 1);
    ledger.bindArtifactSlot(sid, intent.slotKey, {
      uri: 'https://docs.google.com/spreadsheets/d/fixture_sheet_00000001/edit',
    }, 'call-sheet-1');
    assert.equal(ledger.listUnresolvedCreateClaims(sid).length, 0, 'bound = deliverable, never parks');
    assert.equal(ledger.listUnverifiedRunArtifacts(sid).length, 1, 'verification advisory still reports it');
  });
});
