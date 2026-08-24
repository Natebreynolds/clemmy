/**
 * Run: node scripts/run-tests-isolated.mjs src/runtime/harness/staged-transfer-schema-v62.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';

const TMP_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-staged-transfer-v62-'));
process.env.CLEMENTINE_HOME = TMP_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';

const schema = await import('./eventlog-schema.js');
const { HARNESS_SCHEMA_VERSION } = await import('./schema-version.js');

const NOW = '2026-08-24T12:00:00.000Z';
const V61_RETIREMENT_REASON = 'staged_transfer_v61_authority_retired';
const STAGED_TABLES = [
  'staged_transfer_plans',
  'staged_transfer_stages',
  'staged_transfer_stage_authorities',
  'physical_dispatch_return_checkpoints',
  'staged_transfer_stage_receipts',
  'staged_transfer_download_topology_receipts',
  'staged_transfer_attempt_reconciliations',
  'staged_transfer_consent_redemptions',
  'staged_transfer_secret_payloads',
  'staged_transfer_blob_owners',
] as const;

interface SeededV61Authority {
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  parentLogicalCallId: string;
  childLogicalCallId: string;
  unrelatedLogicalCallId: string;
  parentLeaseScopeId: string;
  parentLeaseId: string;
  childLeaseScopeId: string;
  childLeaseId: string;
  unrelatedLeaseScopeId: string;
  unrelatedLeaseId: string;
  childPhysicalDispatchId: string;
  unrelatedPhysicalDispatchId: string;
  oldStageAuthorityDigest: string;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function appendEvent(db: Database.Database, input: {
  id: string;
  sessionId: string;
  role: 'user' | 'system';
  type: string;
}): number {
  const inserted = db.prepare(`
    INSERT INTO events
      (id, session_id, turn, role, type, parent_event_id, data_json, created_at)
    VALUES (?, ?, 1, ?, ?, NULL, '{}', ?)
  `).run(input.id, input.sessionId, input.role, input.type, NOW);
  return Number(inserted.lastInsertRowid);
}

function insertLogicalCall(db: Database.Database, input: {
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  logicalToolCallId: string;
  toolName: string;
  argumentDigest: string;
}): void {
  db.prepare(`
    INSERT INTO logical_tool_calls
      (session_id, source_user_seq, accepted_task_id, logical_tool_call_id,
       tool_name, argument_digest, raw_argument_digest, state, opened_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)
  `).run(
    input.sessionId,
    input.sourceUserSeq,
    input.acceptedTaskId,
    input.logicalToolCallId,
    input.toolName,
    input.argumentDigest,
    input.argumentDigest,
    NOW,
  );
}

function insertCallLease(db: Database.Database, input: {
  scopeId: string;
  sessionId: string;
  leaseId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  logicalToolCallId: string;
  effect: 'read' | 'external_write';
  businessCall: 0 | 1;
  toolName: string;
  argumentDigest: string;
}): void {
  db.prepare(`
    INSERT INTO run_dispatch_leases
      (scope_id, session_id, lease_id, activated_at,
       source_user_seq, accepted_task_id, logical_tool_call_id,
       recovery_effect, recovery_business_call, recovery_tool_name,
       recovery_argument_digest, recovery_argument_cipher, recovery_turn)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(
    input.scopeId,
    input.sessionId,
    input.leaseId,
    NOW,
    input.sourceUserSeq,
    input.acceptedTaskId,
    input.logicalToolCallId,
    input.effect,
    input.businessCall,
    input.toolName,
    input.argumentDigest,
    `sealed:${input.logicalToolCallId}`,
  );
}

function insertPhysicalDispatch(db: Database.Database, input: {
  eventId: string;
  sessionId: string;
  sourceUserSeq: number;
  acceptedTaskId: string;
  logicalToolCallId: string;
  physicalDispatchId: string;
  ordinal: number;
  relation: 'primary' | 'child';
  toolName: string;
  argumentDigest: string;
  leaseScopeId: string;
  leaseId: string;
  stagedAuthorityDigest?: string;
}): void {
  appendEvent(db, {
    id: input.eventId,
    sessionId: input.sessionId,
    role: 'system',
    type: 'physical_dispatch_started',
  });
  const stagedColumn = input.stagedAuthorityDigest === undefined
    ? ''
    : ', staged_authority_digest';
  const stagedValue = input.stagedAuthorityDigest === undefined ? '' : ', ?';
  db.prepare(`
    INSERT INTO physical_dispatches
      (session_id, source_user_seq, accepted_task_id, logical_tool_call_id,
       physical_dispatch_id, ordinal, relation, retry_of, tool_name,
       argument_digest, state, started_at, start_event_id, execution_site,
       lease_scope_id, lease_id${stagedColumn})
    VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'started', ?, ?, 'host', ?, ?${stagedValue})
  `).run(
    input.sessionId,
    input.sourceUserSeq,
    input.acceptedTaskId,
    input.logicalToolCallId,
    input.physicalDispatchId,
    input.ordinal,
    input.relation,
    input.toolName,
    input.argumentDigest,
    NOW,
    input.eventId,
    input.leaseScopeId,
    input.leaseId,
    ...(input.stagedAuthorityDigest === undefined ? [] : [input.stagedAuthorityDigest]),
  );
}

function dropV61StagedAdmissionTriggersForAdversarialFixture(db: Database.Database): void {
  // TEST-ONLY ADVERSARIAL FIXTURE: v61 rows could have been written by a
  // compromised/old process after its admission triggers were removed. v62
  // must retire these bytes, never reinterpret or copy them into v62 authority.
  const triggers = db.prepare(`
    SELECT name FROM sqlite_master
     WHERE type = 'trigger'
       AND (name LIKE 'trg_staged_transfer_%'
         OR name LIKE 'trg_physical_return_checkpoint_%')
  `).all() as Array<{ name: string }>;
  for (const { name } of triggers) {
    db.exec(`DROP TRIGGER "${name.replace(/"/g, '""')}"`);
  }
}

function seedPopulatedAdversarialV61(db: Database.Database): SeededV61Authority {
  const sessionId = 'staged-v61-session';
  db.prepare(`
    INSERT INTO sessions
      (id, kind, created_at, updated_at, status, metadata_json)
    VALUES (?, 'chat', ?, ?, 'active', '{}')
  `).run(sessionId, NOW, NOW);
  const sourceUserSeq = appendEvent(db, {
    id: 'staged-v61-source',
    sessionId,
    role: 'user',
    type: 'user_input_received',
  });
  const acceptedTaskId = `task:${sessionId}#${sourceUserSeq}`;
  db.prepare(`
    INSERT INTO accepted_turn_call_authorities
      (session_id, source_user_seq, accepted_task_id, authority_protocol,
       authority_kind, source_event_id, source_event_digest, source_turn,
       engine_version, surface_version, surface_digest, effect_ceiling,
       effect_bounds_json, max_logical_calls, max_parallel_calls,
       catalog_revision_digest, binding_revision_digest,
       authority_digest, state, revision, opened_at)
    VALUES (?, ?, ?, 1, 'host_v1', 'staged-v61-source', ?, 1,
            'host_v1', 'configured_harness_capability_surface_v1', ?, 'admin',
            '["admin","compute","external_write","host_only","local_write","read"]',
            8, 4, ?, ?, ?, 'open', 0, ?)
  `).run(
    sessionId,
    sourceUserSeq,
    acceptedTaskId,
    digest('source-event'),
    digest('surface'),
    digest('catalog'),
    digest('binding'),
    digest('root-authority'),
    NOW,
  );

  const parentLogicalCallId = 'logical:v61-business';
  const childLogicalCallId = 'logical:v61-upload';
  const unrelatedLogicalCallId = 'logical:unrelated';
  const parentToolName = 'COMPOSIO_GMAIL_SEND_EMAIL';
  const childToolName = 'staged_upload_transfer';
  const unrelatedToolName = 'unrelated_read';
  const parentArgumentDigest = digest('parent-arguments');
  const childArgumentDigest = digest('child-arguments');
  const unrelatedArgumentDigest = digest('unrelated-arguments');
  for (const call of [
    { logicalToolCallId: parentLogicalCallId, toolName: parentToolName, argumentDigest: parentArgumentDigest },
    { logicalToolCallId: childLogicalCallId, toolName: childToolName, argumentDigest: childArgumentDigest },
    { logicalToolCallId: unrelatedLogicalCallId, toolName: unrelatedToolName, argumentDigest: unrelatedArgumentDigest },
  ]) {
    insertLogicalCall(db, { sessionId, sourceUserSeq, acceptedTaskId, ...call });
  }

  const parentLeaseScopeId = 'scope:v61-business';
  const parentLeaseId = 'lease:v61-business';
  const childLeaseScopeId = 'scope:v61-upload';
  const childLeaseId = 'lease:v61-upload';
  const unrelatedLeaseScopeId = 'scope:unrelated';
  const unrelatedLeaseId = 'lease:unrelated';
  insertCallLease(db, {
    scopeId: parentLeaseScopeId,
    sessionId,
    leaseId: parentLeaseId,
    sourceUserSeq,
    acceptedTaskId,
    logicalToolCallId: parentLogicalCallId,
    effect: 'external_write',
    businessCall: 1,
    toolName: parentToolName,
    argumentDigest: parentArgumentDigest,
  });
  insertCallLease(db, {
    scopeId: childLeaseScopeId,
    sessionId,
    leaseId: childLeaseId,
    sourceUserSeq,
    acceptedTaskId,
    logicalToolCallId: childLogicalCallId,
    effect: 'external_write',
    businessCall: 0,
    toolName: childToolName,
    argumentDigest: childArgumentDigest,
  });
  insertCallLease(db, {
    scopeId: unrelatedLeaseScopeId,
    sessionId,
    leaseId: unrelatedLeaseId,
    sourceUserSeq,
    acceptedTaskId,
    logicalToolCallId: unrelatedLogicalCallId,
    effect: 'read',
    businessCall: 1,
    toolName: unrelatedToolName,
    argumentDigest: unrelatedArgumentDigest,
  });

  const childPhysicalDispatchId = 'physical:v61-upload';
  const unrelatedPhysicalDispatchId = 'physical:unrelated-v61';
  insertPhysicalDispatch(db, {
    eventId: 'event:v61-upload-started',
    sessionId,
    sourceUserSeq,
    acceptedTaskId,
    logicalToolCallId: childLogicalCallId,
    physicalDispatchId: childPhysicalDispatchId,
    ordinal: 1,
    relation: 'primary',
    toolName: childToolName,
    argumentDigest: childArgumentDigest,
    leaseScopeId: childLeaseScopeId,
    leaseId: childLeaseId,
  });
  insertPhysicalDispatch(db, {
    eventId: 'event:unrelated-v61-started',
    sessionId,
    sourceUserSeq,
    acceptedTaskId,
    logicalToolCallId: unrelatedLogicalCallId,
    physicalDispatchId: unrelatedPhysicalDispatchId,
    ordinal: 1,
    relation: 'primary',
    toolName: unrelatedToolName,
    argumentDigest: unrelatedArgumentDigest,
    leaseScopeId: unrelatedLeaseScopeId,
    leaseId: unrelatedLeaseId,
  });

  db.prepare(`
    INSERT INTO accepted_source_session_pointers
      (root_session_id, continuity_digest, head_session_id, revision, updated_at)
    VALUES ('unrelated-v60-root', ?, ?, 3, ?)
  `).run(digest('v60-continuity'), sessionId, NOW);
  db.prepare(`
    INSERT INTO accepted_source_session_bindings
      (durable_source_digest, root_session_id, continuity_digest,
       session_id, disposition, selected_after_seq, created_at)
    VALUES (?, 'unrelated-v60-root', ?, ?, 'reused', ?, ?)
  `).run(digest('v60-source'), digest('v60-continuity'), sessionId, sourceUserSeq, NOW);
  db.prepare(`
    INSERT INTO capability_manifests
      (manifest_id, digest, manifest_json, lifecycle, installed_at)
    VALUES ('unrelated-v61-manifest', ?, '{"version":1,"unrelated":true}', 'retired', ?)
  `).run(digest('unrelated-manifest'), NOW);

  dropV61StagedAdmissionTriggersForAdversarialFixture(db);
  db.prepare(`
    INSERT INTO staged_transfer_plans
      (plan_id, session_id, source_user_seq, accepted_task_id,
       parent_logical_tool_call_id, parent_tool_name, parent_argument_digest,
       parent_effect_kind, expected_work_contract_id,
       expected_work_requirement_id, expected_work_binding_digest,
       host_durable_binding_digest, host_capability_id, host_account_id,
       host_invoke_port_id, host_operation_id,
       host_provider_input_schema_digest, host_schema_fingerprint,
       host_definition_fingerprint, host_manifest_id, host_manifest_digest,
       input_schema_digest, output_schema_digest, operation_version,
       toolkit_slug, account_identity_digest, transfer_manifest_digest,
       manifest_binding_digest, manifest_payload_id, manifest_format,
       manifest_plaintext_sha256, manifest_plaintext_bytes,
       manifest_chunk_count, manifest_sealed_sha256, manifest_sealed_bytes,
       state, created_at, updated_at)
    VALUES
      ('plan:v61-adversarial', ?, ?, ?, ?, ?, ?, 'external_write',
       'contract:v61', 'requirement:v61', ?, ?, 'capability:v61',
       'account:v61', 'invoke:v61', 'operation:v61', ?, ?, ?,
       'manifest:v61', ?, ?, NULL, 'v61', 'gmail', ?, ?, ?,
       'authority-payload:v61-manifest', 'staged_transfer_manifest_v1',
       ?, 16, 1, ?, 32, 'prepared', ?, ?)
  `).run(
    sessionId,
    sourceUserSeq,
    acceptedTaskId,
    parentLogicalCallId,
    parentToolName,
    parentArgumentDigest,
    digest('expected-binding'),
    digest('host-binding'),
    digest('input-schema'),
    digest('host-schema'),
    digest('host-definition'),
    digest('host-manifest'),
    digest('input-schema'),
    digest('account'),
    digest('transfer-manifest'),
    digest('manifest-binding'),
    digest('manifest-plaintext'),
    digest('manifest-sealed'),
    NOW,
    NOW,
  );

  const oldStageAuthorityDigest = digest('copyable-v61-stage-authority');
  db.prepare(`
    INSERT INTO staged_transfer_stage_authorities
      (stage_authority_id, plan_id, session_id, source_user_seq,
       accepted_task_id, stage_ordinal, stage_kind, json_pointer_digest,
       logical_tool_call_id, physical_dispatch_id, tool_name, argument_digest,
       effect_kind, lease_scope_id, lease_id, depends_on_stage_ordinal,
       authority_digest, created_at)
    VALUES
      ('stage-authority:v61-business', 'plan:v61-adversarial', ?, ?, ?,
       1, 'business_execute', NULL, ?, 'physical:v61-business', ?, ?,
       'external_write', ?, ?, NULL, ?, ?),
      ('stage-authority:v61-upload', 'plan:v61-adversarial', ?, ?, ?,
       2, 'upload_transfer', ?, ?, ?, ?, ?, 'external_write', ?, ?, 1, ?, ?)
  `).run(
    sessionId,
    sourceUserSeq,
    acceptedTaskId,
    parentLogicalCallId,
    parentToolName,
    parentArgumentDigest,
    parentLeaseScopeId,
    parentLeaseId,
    digest('v61-business-authority'),
    NOW,
    sessionId,
    sourceUserSeq,
    acceptedTaskId,
    digest('/attachments/0'),
    childLogicalCallId,
    childPhysicalDispatchId,
    childToolName,
    childArgumentDigest,
    childLeaseScopeId,
    childLeaseId,
    oldStageAuthorityDigest,
    NOW,
  );

  return {
    sessionId,
    sourceUserSeq,
    acceptedTaskId,
    parentLogicalCallId,
    childLogicalCallId,
    unrelatedLogicalCallId,
    parentLeaseScopeId,
    parentLeaseId,
    childLeaseScopeId,
    childLeaseId,
    unrelatedLeaseScopeId,
    unrelatedLeaseId,
    childPhysicalDispatchId,
    unrelatedPhysicalDispatchId,
    oldStageAuthorityDigest,
  };
}

function stagedSchemaObjects(db: Database.Database): unknown[] {
  const stagedNames = new Set<string>(STAGED_TABLES);
  return (db.prepare(`
    SELECT type, name, tbl_name, sql
      FROM sqlite_master
     WHERE sql IS NOT NULL
     ORDER BY type, name
  `).all() as Array<{ type: string; name: string; tbl_name: string; sql: string }>)
    .filter((row) => stagedNames.has(row.name)
      || row.name.startsWith('idx_staged_transfer_')
      || row.name.startsWith('uq_staged_transfer_')
      || row.name.startsWith('trg_staged_transfer_')
      || row.name.startsWith('trg_physical_return_checkpoint_'));
}

function columnNames(db: Database.Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info("${table.replace(/"/g, '""')}")`).all() as Array<{ name: string }>)
    .map((column) => column.name);
}

function tableParents(db: Database.Database, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA foreign_key_list("${table.replace(/"/g, '""')}")`).all() as Array<{
    table: string;
  }>).map((fk) => fk.table));
}

function snapshotUnrelatedRows(db: Database.Database, seed: SeededV61Authority): unknown {
  return {
    root: db.prepare(`
      SELECT * FROM accepted_turn_call_authorities
       WHERE session_id = ? AND source_user_seq = ?
    `).get(seed.sessionId, seed.sourceUserSeq),
    logical: db.prepare(`
      SELECT * FROM logical_tool_calls
       WHERE session_id = ? AND source_user_seq = ? AND logical_tool_call_id = ?
    `).get(seed.sessionId, seed.sourceUserSeq, seed.unrelatedLogicalCallId),
    lease: db.prepare(`SELECT * FROM run_dispatch_leases WHERE scope_id = ?`)
      .get(seed.unrelatedLeaseScopeId),
    physical: db.prepare(`
      SELECT session_id, source_user_seq, accepted_task_id, logical_tool_call_id,
             physical_dispatch_id, ordinal, relation, retry_of, tool_name,
             argument_digest, state, started_at, settled_at, start_event_id,
             settle_event_id, execution_site, lease_scope_id, lease_id
        FROM physical_dispatches
       WHERE session_id = ? AND source_user_seq = ? AND physical_dispatch_id = ?
    `).get(seed.sessionId, seed.sourceUserSeq, seed.unrelatedPhysicalDispatchId),
    pointer: db.prepare(`
      SELECT * FROM accepted_source_session_pointers
       WHERE root_session_id = 'unrelated-v60-root'
    `).get(),
    binding: db.prepare(`
      SELECT * FROM accepted_source_session_bindings
       WHERE root_session_id = 'unrelated-v60-root'
    `).get(),
    manifest: db.prepare(`
      SELECT * FROM capability_manifests
       WHERE manifest_id = 'unrelated-v61-manifest'
    `).get(),
  };
}

function assertFreshV62Shape(db: Database.Database): void {
  assert.equal((db.prepare('SELECT MAX(version) AS version FROM schema_version').get() as {
    version: number;
  }).version, HARNESS_SCHEMA_VERSION);
  assert.ok(HARNESS_SCHEMA_VERSION >= 62);
  const tables = new Set((db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table'
  `).all() as Array<{ name: string }>).map((row) => row.name));
  for (const table of STAGED_TABLES) assert.ok(tables.has(table), `${table} is present`);

  assert.deepEqual(
    columnNames(db, 'staged_transfer_stage_authorities').filter((name) => [
      'stage_id',
      'attempt_ordinal',
      'retry_of_stage_authority_id',
      'authority_digest',
    ].includes(name)),
    ['stage_id', 'attempt_ordinal', 'retry_of_stage_authority_id', 'authority_digest'],
  );
  assert.ok(columnNames(db, 'staged_transfer_stages').includes('stage_digest'));
  assert.ok(columnNames(db, 'staged_transfer_plans').includes('plan_authority_digest'));
  assert.ok(columnNames(db, 'physical_dispatches').includes('staged_authority_digest'));
  const planSql = (db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'staged_transfer_plans'
  `).get() as { sql: string }).sql;
  assert.match(planSql, /staged_transfer_manifest_v2/);

  const triggerNames = new Set((db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'trigger'
  `).all() as Array<{ name: string }>).map((row) => row.name));
  for (const trigger of [
    'trg_staged_transfer_plan_exact_parent',
    'trg_staged_transfer_attempt_exact_stage',
    'trg_staged_transfer_physical_exact_attempt',
    'trg_physical_return_checkpoint_exact_return',
    'trg_staged_transfer_receipt_exact_attempt',
    'trg_staged_transfer_one_success_per_stage',
    'trg_staged_transfer_reconciliation_requires_opaque_kernel',
    'trg_staged_transfer_logical_settlement_fence',
    'trg_staged_transfer_child_no_progress',
  ]) assert.ok(triggerNames.has(trigger), `${trigger} is present`);

  const expectedParents: Record<string, string[]> = {
    staged_transfer_plans: ['logical_tool_calls'],
    staged_transfer_stages: ['staged_transfer_plans'],
    staged_transfer_stage_authorities: [
      'logical_tool_calls',
      'staged_transfer_plans',
      'staged_transfer_stages',
      'staged_transfer_stage_authorities',
    ],
    physical_dispatch_return_checkpoints: [
      'physical_dispatches',
      'staged_transfer_stage_authorities',
    ],
    staged_transfer_stage_receipts: [
      'staged_transfer_plans',
      'staged_transfer_stages',
      'staged_transfer_stage_authorities',
    ],
    staged_transfer_attempt_reconciliations: [
      'staged_transfer_plans',
      'staged_transfer_stage_authorities',
    ],
    staged_transfer_consent_redemptions: ['staged_transfer_plans'],
    staged_transfer_secret_payloads: ['staged_transfer_stage_authorities'],
    staged_transfer_blob_owners: ['staged_transfer_plans', 'staged_transfer_stages'],
  };
  for (const [table, parents] of Object.entries(expectedParents)) {
    const actual = tableParents(db, table);
    for (const parent of parents) assert.ok(actual.has(parent), `${table} references ${parent}`);
  }
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  assert.deepEqual(db.pragma('integrity_check'), [{ integrity_check: 'ok' }]);
}

test('fresh v62 installs the complete staged-transfer table, trigger, and foreign-key graph', () => {
  const db = new Database(path.join(TMP_HOME, 'fresh-v62.db'));
  try {
    db.pragma('foreign_keys = ON');
    schema.applyHarnessMigrations(db);
    assertFreshV62Shape(db);
    assert.throws(() => db.prepare(`
      INSERT INTO staged_transfer_attempt_reconciliations
        (reconciliation_id, prior_stage_authority_id, plan_id,
         disposition, evidence_digest, recorded_at)
      VALUES ('forged-reconcile', 'forged-attempt', 'forged-plan',
              'not_applied', ?, ?)
    `).run(digest('forged reconciliation evidence'), NOW),
    /staged reconciliation requires its opaque provider kernel/);
  } finally {
    db.close();
  }
});

test('populated adversarial v61 is retired, unrelated rows survive, and reopen is idempotent', () => {
  const dbPath = path.join(TMP_HOME, 'populated-v61-to-v62.db');
  let db = new Database(dbPath);
  try {
    db.pragma('foreign_keys = ON');
    schema.applyHarnessMigrationsThroughVersionForTests(db, 61);
    const seed = seedPopulatedAdversarialV61(db);
    const unrelatedBefore = snapshotUnrelatedRows(db, seed);
    assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM staged_transfer_plans`).get() as {
      count: number;
    }).count, 1);
    assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM staged_transfer_stage_authorities`).get() as {
      count: number;
    }).count, 2);

    schema.applyHarnessMigrations(db);

    assertFreshV62Shape(db);
    assert.deepEqual(snapshotUnrelatedRows(db, seed), unrelatedBefore,
      'v60 pointers and unrelated v61-era durable rows remain byte-identical');
    const logicalStates = db.prepare(`
      SELECT logical_tool_call_id, state, conflict_reason
        FROM logical_tool_calls
       WHERE session_id = ? AND source_user_seq = ?
       ORDER BY logical_tool_call_id
    `).all(seed.sessionId, seed.sourceUserSeq) as Array<{
      logical_tool_call_id: string;
      state: string;
      conflict_reason: string | null;
    }>;
    assert.deepEqual(logicalStates, [
      {
        logical_tool_call_id: seed.unrelatedLogicalCallId,
        state: 'open',
        conflict_reason: null,
      },
      {
        logical_tool_call_id: seed.parentLogicalCallId,
        state: 'conflict',
        conflict_reason: V61_RETIREMENT_REASON,
      },
      {
        logical_tool_call_id: seed.childLogicalCallId,
        state: 'conflict',
        conflict_reason: V61_RETIREMENT_REASON,
      },
    ]);
    const leases = db.prepare(`
      SELECT scope_id, revoked_at FROM run_dispatch_leases
       WHERE scope_id IN (?, ?, ?)
       ORDER BY scope_id
    `).all(
      seed.parentLeaseScopeId,
      seed.childLeaseScopeId,
      seed.unrelatedLeaseScopeId,
    ) as Array<{ scope_id: string; revoked_at: string | null }>;
    assert.notEqual(leases.find((lease) => lease.scope_id === seed.parentLeaseScopeId)?.revoked_at, null);
    assert.notEqual(leases.find((lease) => lease.scope_id === seed.childLeaseScopeId)?.revoked_at, null);
    assert.equal(leases.find((lease) => lease.scope_id === seed.unrelatedLeaseScopeId)?.revoked_at, null);

    for (const table of STAGED_TABLES) {
      assert.equal((db.prepare(`SELECT COUNT(*) AS count FROM "${table}"`).get() as {
        count: number;
      }).count, 0, `${table} contains no reinterpreted v61 rows`);
    }
    assert.deepEqual(db.prepare(`
      SELECT state, staged_authority_digest
        FROM physical_dispatches
       WHERE session_id = ? AND source_user_seq = ? AND physical_dispatch_id = ?
    `).get(seed.sessionId, seed.sourceUserSeq, seed.childPhysicalDispatchId), {
      state: 'started',
      staged_authority_digest: null,
    }, 'the old crossing remains forensic history but carries no v62 authority');

    assert.throws(
      () => insertPhysicalDispatch(db, {
        eventId: 'event:old-v61-authority-reuse',
        sessionId: seed.sessionId,
        sourceUserSeq: seed.sourceUserSeq,
        acceptedTaskId: seed.acceptedTaskId,
        logicalToolCallId: seed.unrelatedLogicalCallId,
        physicalDispatchId: 'physical:old-v61-authority-reuse',
        ordinal: 2,
        relation: 'child',
        toolName: 'unrelated_read',
        argumentDigest: digest('unrelated-arguments'),
        leaseScopeId: seed.unrelatedLeaseScopeId,
        leaseId: seed.unrelatedLeaseId,
        stagedAuthorityDigest: seed.oldStageAuthorityDigest,
      }),
      /staged physical dispatch lacks exact opaque attempt authority/,
      'a copyable v61 digest cannot authorize any new physical crossing',
    );

    const fresh = new Database(path.join(TMP_HOME, 'fresh-parity-v62.db'));
    let freshObjects: unknown[];
    try {
      fresh.pragma('foreign_keys = ON');
      schema.applyHarnessMigrations(fresh);
      freshObjects = stagedSchemaObjects(fresh);
    } finally {
      fresh.close();
    }
    assert.deepEqual(stagedSchemaObjects(db), freshObjects,
      'upgraded and fresh stores expose byte-identical v62 staged schema objects');

    const schemaBeforeReopen = stagedSchemaObjects(db);
    const versionsBeforeReopen = db.prepare(`SELECT * FROM schema_version ORDER BY version`).all();
    const rowsBeforeReopen = snapshotUnrelatedRows(db, seed);
    db.close();
    db = new Database(dbPath);
    db.pragma('foreign_keys = ON');
    schema.applyHarnessMigrations(db);
    assert.deepEqual(stagedSchemaObjects(db), schemaBeforeReopen);
    assert.deepEqual(db.prepare(`SELECT * FROM schema_version ORDER BY version`).all(), versionsBeforeReopen);
    assert.deepEqual(snapshotUnrelatedRows(db, seed), rowsBeforeReopen);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally {
    db.close();
  }
});

test('an injected v62 failure rolls back poisoning, DDL, lease revocation, and the version stamp', () => {
  const db = new Database(path.join(TMP_HOME, 'rollback-v61-to-v62.db'));
  try {
    db.pragma('foreign_keys = ON');
    schema.applyHarnessMigrationsThroughVersionForTests(db, 61);
    const seed = seedPopulatedAdversarialV61(db);
    const stagedBefore = db.prepare(`
      SELECT * FROM staged_transfer_stage_authorities ORDER BY stage_authority_id
    `).all();
    db.exec(`
      CREATE TRIGGER test_inject_v62_retirement_failure
      BEFORE UPDATE OF state ON logical_tool_calls
      WHEN NEW.conflict_reason = '${V61_RETIREMENT_REASON}'
      BEGIN SELECT RAISE(ABORT, 'test injected v62 failure'); END;
    `);

    assert.throws(() => schema.applyHarnessMigrations(db), /test injected v62 failure/);
    assert.equal((db.prepare(`SELECT MAX(version) AS version FROM schema_version`).get() as {
      version: number;
    }).version, 61);
    assert.equal(columnNames(db, 'physical_dispatches').includes('staged_authority_digest'), false,
      'ALTER TABLE is rolled back with the failed migration');
    assert.deepEqual(db.prepare(`
      SELECT * FROM staged_transfer_stage_authorities ORDER BY stage_authority_id
    `).all(), stagedBefore);
    assert.deepEqual(db.prepare(`
      SELECT logical_tool_call_id, state, conflict_reason
        FROM logical_tool_calls
       WHERE session_id = ? AND source_user_seq = ?
         AND logical_tool_call_id IN (?, ?)
       ORDER BY logical_tool_call_id
    `).all(
      seed.sessionId,
      seed.sourceUserSeq,
      seed.parentLogicalCallId,
      seed.childLogicalCallId,
    ), [
      {
        logical_tool_call_id: seed.parentLogicalCallId,
        state: 'open',
        conflict_reason: null,
      },
      {
        logical_tool_call_id: seed.childLogicalCallId,
        state: 'open',
        conflict_reason: null,
      },
    ]);
    assert.deepEqual(db.prepare(`
      SELECT scope_id, revoked_at FROM run_dispatch_leases
       WHERE scope_id IN (?, ?) ORDER BY scope_id
    `).all(seed.parentLeaseScopeId, seed.childLeaseScopeId), [
      { scope_id: seed.parentLeaseScopeId, revoked_at: null },
      { scope_id: seed.childLeaseScopeId, revoked_at: null },
    ]);

    db.exec('DROP TRIGGER test_inject_v62_retirement_failure');
    schema.applyHarnessMigrations(db);
    assertFreshV62Shape(db);
  } finally {
    db.close();
  }
});

test.after(() => {
  rmSync(TMP_HOME, { recursive: true, force: true });
});
