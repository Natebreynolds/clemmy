import assert from 'node:assert/strict';
import test from 'node:test';
import {
  admitDocumentedCreateResultProjection,
  projectDocumentedCreateResult,
  verifyCanonicalDocumentedCreateResult,
  type DocumentedCreateResultActualCallV1,
  type DocumentedCreateResultAuthorityV1,
} from './documented-create-result-evidence.js';

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const DIGEST_C = 'c'.repeat(64);
const OPERATION = 'GOOGLESHEETS_SHEET_FROM_JSON';
const SHEET_ID = 'sheet_Abc-123';
const SHEET_URL = `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit`;

const authority: DocumentedCreateResultAuthorityV1 = {
  version: 1,
  acceptedTaskId: 'task:sheet-create',
  logicalToolCallId: 'call:sheet-create',
  requirementId: 'write_once',
  operationId: OPERATION,
  accountId: 'conn-google-sheets',
  providerInputSchemaDigest: DIGEST_A,
  argumentDigest: DIGEST_B,
  submittedContentDigest: DIGEST_C,
  effect: 'external_write',
};

const actual: DocumentedCreateResultActualCallV1 = {
  acceptedTaskId: authority.acceptedTaskId,
  logicalToolCallId: authority.logicalToolCallId,
  operationId: authority.operationId,
  accountId: authority.accountId,
  providerInputSchemaDigest: authority.providerInputSchemaDigest,
  argumentDigest: authority.argumentDigest,
  submittedContentDigest: authority.submittedContentDigest,
  effect: authority.effect,
};

function ready() {
  const admitted = admitDocumentedCreateResultProjection({ authority, actual });
  assert.equal(admitted.status, 'ready');
  return admitted;
}

test('documented Sheet create projection accepts exact direct, nested, and id-only provider shapes', () => {
  const cases: Array<{ raw: unknown; handle: string }> = [
    {
      raw: { successful: true, spreadsheetId: SHEET_ID, spreadsheetUrl: SHEET_URL },
      handle: SHEET_URL,
    },
    {
      raw: {
        successful: true,
        data: { spreadsheet_id: SHEET_ID, spreadsheet_url: SHEET_URL },
      },
      handle: SHEET_URL,
    },
    {
      raw: { success: true, response: { spreadsheet_id: SHEET_ID } },
      handle: SHEET_URL,
    },
  ];
  for (const fixture of cases) {
    const projected = projectDocumentedCreateResult(ready(), fixture.raw);
    assert.equal(projected.status, 'projected');
    if (projected.status !== 'projected') continue;
    assert.equal(projected.value.created.id, SHEET_ID);
    assert.equal(projected.value.created.handle, fixture.handle);
    assert.match(projected.value.created.receipt, /^provider-ack:v1:[a-f0-9]{64}$/);
    assert.equal(projected.value.created.writtenDigest, DIGEST_C);
    assert.deepEqual(projected.value.contentCommit, {
      kind: 'provider_acknowledged_atomic_input_v1',
      submittedContentDigest: DIGEST_C,
    });
    assert.equal(projected.value.rawProviderResult, fixture.raw,
      'the exact raw provider value is retained, not reconstructed');
    assert.deepEqual(projected.value.binding, authority);
    assert.deepEqual(verifyCanonicalDocumentedCreateResult({
      value: projected.value,
      expectedAuthority: authority,
    }), { status: 'verified', value: projected.value });
  }
});

test('missing, conflicting, contradicted, and lookalike Sheet identities never project success', () => {
  const invalid = [
    {},
    { successful: true },
    {
      successful: true,
      spreadsheetId: 'sheet-one',
      spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-two/edit',
    },
    {
      successful: false,
      spreadsheetId: SHEET_ID,
      spreadsheetUrl: SHEET_URL,
      error: 'create failed',
    },
    {
      successful: true,
      documentId: SHEET_ID,
      documentUrl: SHEET_URL,
    },
  ];
  for (const raw of invalid) {
    const projected = projectDocumentedCreateResult(ready(), raw);
    assert.deepEqual(projected, {
      status: 'uncertain',
      reason: 'artifact_identity_missing_or_ambiguous',
      rawProviderResult: raw,
    });
  }
});

test('projection admission is exact across task, call, operation, account, schema, args, and effect', () => {
  const changed: Array<[keyof DocumentedCreateResultActualCallV1, unknown, string]> = [
    ['acceptedTaskId', 'task:other', 'accepted_task_mismatch'],
    ['logicalToolCallId', 'call:other', 'logical_call_mismatch'],
    ['operationId', 'GOOGLESHEETS_SHEET_FROM_JSON_PREVIEW', 'operation_is_not_a_documented_root_create'],
    ['accountId', 'conn-other', 'account_mismatch'],
    ['providerInputSchemaDigest', 'c'.repeat(64), 'schema_mismatch'],
    ['argumentDigest', 'd'.repeat(64), 'argument_mismatch'],
    ['submittedContentDigest', 'e'.repeat(64), 'submitted_content_mismatch'],
    ['effect', 'read', 'actual_call_is_malformed'],
  ];
  for (const [key, value, reason] of changed) {
    const next = { ...actual, [key]: value } as DocumentedCreateResultActualCallV1;
    assert.deepEqual(admitDocumentedCreateResultProjection({ authority, actual: next }), {
      status: reason === 'operation_is_not_a_documented_root_create' ? 'not_applicable' : 'refused',
      reason,
    });
  }

  const wrongBoundOperation = {
    ...authority,
    operationId: 'GOOGLEDOCS_CREATE_DOCUMENT_MARKDOWN',
  };
  assert.deepEqual(admitDocumentedCreateResultProjection({
    authority: wrongBoundOperation,
    actual,
  }), {
    status: 'refused',
    reason: 'operation_mismatch',
  });
});

test('non-JSON provider objects are retained as uncertain and cannot invoke accessors', () => {
  let getterReads = 0;
  const raw = Object.defineProperty({}, 'spreadsheetId', {
    enumerable: true,
    get() {
      getterReads += 1;
      return SHEET_ID;
    },
  });
  const projected = projectDocumentedCreateResult(ready(), raw);
  assert.deepEqual(projected, {
    status: 'uncertain',
    reason: 'provider_result_not_canonical_json',
    rawProviderResult: raw,
  });
  assert.equal(getterReads, 0);
});
