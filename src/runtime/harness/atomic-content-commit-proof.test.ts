import assert from 'node:assert/strict';
import test from 'node:test';
import Database from 'better-sqlite3';
import { documentedComposioManifestOperationSemantics } from '../../integrations/composio/operation-semantics.js';
import {
  compileAtomicInputContentContract,
} from './atomic-input-content-contract.js';
import {
  admitDocumentedCreateResultProjection,
  projectDocumentedCreateResult,
  type DocumentedCreateResultAuthorityV1,
} from './documented-create-result-evidence.js';
import { verifyAtomicContentCommit } from './atomic-content-commit-proof.js';
import type { SealedNodeBinding } from './host-capability-catalog-factory.js';
import type { ObligationManifest } from './obligation-manifest.js';

const SESSION = 'atomic-content-proof';
const SOURCE_SEQ = 1;
const TASK = 'task:atomic-content-proof#1';
const CONTRACT = 'contract:atomic-content-proof';
const READ_CALL = 'read-call';
const WRITE_CALL = 'write-call';
const READ_NODE = 'read_source';
const WRITE_NODE = 'write_once';
const PROVIDER_OPERATION = 'GOOGLESHEETS_SHEET_FROM_JSON';
const LOGICAL_TOOL = 'googlesheets_sheet_from_json';
const ARGUMENT_DIGEST = 'b'.repeat(64);
const SCHEMA_DIGEST = 'a'.repeat(64);
const ACCOUNT = 'conn-googlesheets';
const PHYSICAL = 'physical-sheet-create';
const SHEET_ID = 'sheet-atomic-proof';
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`;
const ROWS = [
  { name: 'One', rating: 4.8 },
  { name: 'Two', rating: 4.7 },
];

const operationSemantics = documentedComposioManifestOperationSemantics(PROVIDER_OPERATION);
assert.ok(operationSemantics?.atomicInputContent);
const contentContract = compileAtomicInputContentContract({
  declaration: operationSemantics.atomicInputContent,
  providerArguments: {
  title: 'Two restaurants',
  sheet_name: 'Restaurants',
  sheet_json: JSON.stringify(ROWS),
  },
});
assert.ok(contentContract);

const authority: DocumentedCreateResultAuthorityV1 = {
  version: 1,
  acceptedTaskId: TASK,
  logicalToolCallId: WRITE_CALL,
  requirementId: WRITE_NODE,
  operationId: PROVIDER_OPERATION,
  accountId: ACCOUNT,
  providerInputSchemaDigest: SCHEMA_DIGEST,
  argumentDigest: ARGUMENT_DIGEST,
  submittedContentDigest: contentContract.submittedContentDigest,
  resultIdentity: contentContract.resultIdentity,
  effect: 'external_write',
};

const manifest: ObligationManifest = {
  version: 1,
  mode: 'authoritative',
  readiness: 'ready',
  manifestId: 'manifest:atomic-content-proof',
  graphId: 'graph:atomic-content-proof',
  graphHash: 'c'.repeat(64),
  identity: { sessionId: SESSION, sourceUserSeq: SOURCE_SEQ, turn: 1 },
  nodes: [
    {
      nodeId: 'execute/read_source',
      effectKind: 'read',
      reversibility: 'reversible',
      resolvedTool: 'restaurants_search',
      operationId: READ_NODE,
      operationMode: 'collection_read',
      obligations: ['source_observed', 'source_completeness'],
    },
    {
      nodeId: 'execute/write_once',
      effectKind: 'external_write',
      reversibility: 'irreversible',
      resolvedTool: LOGICAL_TOOL,
      operationId: WRITE_NODE,
      operationMode: 'irreversible_write',
      contentCommitMode: 'documented_atomic_input',
      obligations: ['derivation_from_current_source', 'commit_effect', 'verify_committed_content'],
    },
  ],
  edges: [{
    fromNodeId: 'execute/read_source',
    fromObligation: 'source_completeness',
    toNodeId: 'execute/write_once',
    toObligation: 'derivation_from_current_source',
  }],
};
const writeNode = manifest.nodes[1]!;

function projected(binding = authority) {
  const admission = admitDocumentedCreateResultProjection({ authority: binding, actual: binding });
  assert.equal(admission.status, 'ready');
  if (admission.status !== 'ready') throw new Error(admission.reason);
  const result = projectDocumentedCreateResult(admission, {
    successful: true,
    spreadsheetId: SHEET_ID,
    spreadsheetUrl: SHEET_URL,
  });
  assert.equal(result.status, 'projected');
  if (result.status !== 'projected') throw new Error(result.reason);
  return result.value;
}

function sealed(overrides: Partial<SealedNodeBinding> = {}): SealedNodeBinding {
  return {
    nodeId: WRITE_NODE,
    capabilityId: 'cap:googlesheets-sheet-from-json',
    providerOperationId: PROVIDER_OPERATION,
    logicalToolName: LOGICAL_TOOL,
    toolName: PROVIDER_OPERATION,
    schemaVersion: '1',
    schemaDigest: SCHEMA_DIGEST,
    argumentDigest: ARGUMENT_DIGEST,
    account: ACCOUNT,
    effect: 'external_write',
    destination: { family: 'workbook', posture: 'create_new' },
    operationSemantics,
    bindingDigest: 'd'.repeat(64),
    ...overrides,
  };
}

function fixtureDb(): Database.Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE expected_work_call_bindings (
      session_id TEXT, source_user_seq INTEGER, accepted_task_id TEXT,
      contract_id TEXT, requirement_id TEXT, logical_tool_call_id TEXT,
      tool_name TEXT, argument_digest TEXT, effect_kind TEXT
    );
    CREATE TABLE host_call_capability_bindings (
      session_id TEXT, source_user_seq INTEGER, logical_tool_call_id TEXT
    );
    CREATE TABLE accepted_turn_call_authorities (
      session_id TEXT, source_user_seq INTEGER, accepted_task_id TEXT, authority_kind TEXT
    );
    CREATE TABLE expected_work_generated_artifact_contracts (
      session_id TEXT, source_user_seq INTEGER, logical_tool_call_id TEXT, contract_json TEXT
    );
    CREATE TABLE accepted_task_work_contracts (
      session_id TEXT, source_user_seq INTEGER, accepted_task_id TEXT,
      contract_id TEXT, contract_json TEXT
    );
    CREATE TABLE logical_call_settlements (
      session_id TEXT, source_user_seq INTEGER, logical_tool_call_id TEXT,
      outcome_kind TEXT, continues_requirement INTEGER
    );
    CREATE TABLE artifact_source_roots (
      session_id TEXT, source_user_seq INTEGER, root_scope_id TEXT
    );
    CREATE TABLE run_artifacts (
      session_id TEXT, run_scope_id TEXT, source_call_id TEXT,
      resource_id TEXT, uri TEXT, status TEXT
    );
  `);
  db.prepare(`INSERT INTO accepted_turn_call_authorities VALUES (?, ?, ?, 'turn_graph')`)
    .run(SESSION, SOURCE_SEQ, TASK);
  const insertBinding = db.prepare(`
    INSERT INTO expected_work_call_bindings
      (session_id, source_user_seq, accepted_task_id, contract_id, requirement_id,
       logical_tool_call_id, tool_name, argument_digest, effect_kind)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertBinding.run(
    SESSION, SOURCE_SEQ, TASK, CONTRACT, WRITE_NODE, WRITE_CALL,
    LOGICAL_TOOL, ARGUMENT_DIGEST, 'external_write',
  );
  insertBinding.run(
    SESSION, SOURCE_SEQ, TASK, CONTRACT, READ_NODE, READ_CALL,
    'restaurants_search', 'e'.repeat(64), 'read',
  );
  db.prepare(`INSERT INTO expected_work_generated_artifact_contracts VALUES (?, ?, ?, ?)`)
    .run(SESSION, SOURCE_SEQ, WRITE_CALL, JSON.stringify(contentContract));
  db.prepare(`INSERT INTO accepted_task_work_contracts VALUES (?, ?, ?, ?, ?)`)
    .run(SESSION, SOURCE_SEQ, TASK, CONTRACT, JSON.stringify({
      operations: [
        { id: READ_NODE, effect: 'read', dependsOn: [], dataFrom: [], cardinality: { kind: 'once' } },
        {
          id: WRITE_NODE,
          effect: 'external_write',
          dependsOn: [READ_NODE],
          dataFrom: [READ_NODE],
          cardinality: { kind: 'once' },
        },
      ],
    }));
  db.prepare(`INSERT INTO logical_call_settlements VALUES (?, ?, ?, 'succeeded', 0)`)
    .run(SESSION, SOURCE_SEQ, READ_CALL);
  db.prepare(`INSERT INTO artifact_source_roots VALUES (?, ?, 'run:atomic-content-proof')`)
    .run(SESSION, SOURCE_SEQ);
  db.prepare(`INSERT INTO run_artifacts VALUES (?, 'run:atomic-content-proof', ?, ?, ?, 'bound')`)
    .run(SESSION, WRITE_CALL, SHEET_ID, SHEET_URL);
  return db;
}

function prove(input: {
  rawPayload?: unknown;
  toolName?: string;
  executionSite?: 'host' | 'provider';
  binding?: SealedNodeBinding;
  rootKind?: 'turn_graph' | 'host_v1';
  plantHostLookalike?: boolean;
  typedAuthority?: 'exact' | 'missing' | 'conflict';
}) {
  const db = fixtureDb();
  try {
    if (input.rootKind) {
      db.prepare(`UPDATE accepted_turn_call_authorities SET authority_kind = ?`).run(input.rootKind);
    }
    if (input.plantHostLookalike) {
      db.prepare(`INSERT INTO host_call_capability_bindings VALUES (?, ?, ?)`).run(
        SESSION,
        SOURCE_SEQ,
        WRITE_CALL,
      );
    }
    return verifyAtomicContentCommit({
      db,
      sessionId: SESSION,
      sourceUserSeq: SOURCE_SEQ,
      acceptedTaskId: TASK,
      manifest,
      node: writeNode,
      logicalToolCallId: WRITE_CALL,
      created: {
        rawPayload: input.rawPayload ?? projected(),
        toolName: input.toolName ?? LOGICAL_TOOL,
        executionSite: input.executionSite ?? 'provider',
        physicalDispatchId: PHYSICAL,
      },
      resolveSealedNodeAuthority: () => ({ ok: true, binding: input.binding ?? sealed() }),
      resolveTypedPhysicalAuthority: () => input.typedAuthority === 'missing'
        ? { status: 'missing', reason: 'typed physical authority is absent' }
        : input.typedAuthority === 'conflict'
          ? { status: 'conflict', reason: 'typed physical authority is corrupt' }
          : {
              status: 'ok',
              authority: {
                acceptedTaskId: TASK,
                graphId: manifest.graphId,
                graphHash: manifest.graphHash,
                nodeId: WRITE_NODE,
                logicalCallId: WRITE_CALL,
                physicalDispatchId: PHYSICAL,
                operationId: PROVIDER_OPERATION,
                capabilityRef: sealed().capabilityId,
                manifestId: sealed().capabilityId,
                manifestDigest: '9'.repeat(64),
                operationVersion: sealed().schemaVersion,
                providerInputSchemaDigest: SCHEMA_DIGEST,
                logicalArgumentDigest: ARGUMENT_DIGEST,
                canonicalArgumentDigest: '8'.repeat(64),
                accountId: ACCOUNT,
                resolvedEffect: 'external_write',
                liveFingerprint: '7'.repeat(64),
                catalogSnapshotDigest: '6'.repeat(64),
                authorityDigest: '5'.repeat(64),
              },
            },
      resolveSuccessfulResult: () => ({ ok: true, rawPayload: { records: ROWS } }),
    });
  } finally {
    db.close();
  }
}

test('atomic content proof binds the canonical result to sealed account, schema, and actual provider tool/site', () => {
  assert.equal(prove({}).ok, true);

  const otherAccount = { ...authority, accountId: 'conn-other' };
  const otherSchema = { ...authority, providerInputSchemaDigest: 'f'.repeat(64) };
  for (const candidate of [
    prove({ rawPayload: projected(otherAccount) }),
    prove({ rawPayload: projected(otherSchema) }),
    prove({ toolName: 'googlesheets_sheet_from_json_lookalike' }),
    prove({ executionSite: 'host' }),
    prove({ binding: sealed({ nodeId: writeNode.nodeId }) }),
    prove({ rootKind: 'host_v1' }),
    prove({ plantHostLookalike: true }),
    prove({ typedAuthority: 'missing' }),
    prove({ typedAuthority: 'conflict' }),
  ]) {
    assert.deepEqual(candidate.ok, false);
    if (!candidate.ok) assert.equal(candidate.status, 'conflict');
  }
});
