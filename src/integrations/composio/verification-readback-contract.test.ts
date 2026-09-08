/**
 * Run: node scripts/run-tests-isolated.mjs src/integrations/composio/verification-readback-contract.test.ts
 *
 * A verifier declares itself. Nothing infers one.
 *
 * A mutation discharges only against a host-issued readback, so whichever
 * capability gets treated as "the verifier" is authority-bearing: it is the
 * thing allowed to say a real resource exists and holds the intended content.
 * Earlier attempts derived that status from schema shape, id-looking argument
 * names, sibling writes in the same toolkit, and advisory roles — every one of
 * which a lookalike operation can wear by accident.
 *
 * So the adapter DECLARES the contract for one exact reviewed operation, and
 * validates it against the schemas actually observed. Core consumes the
 * declaration and never interprets a provider name.
 *
 * These pins hold the declaration's exactness: the reviewed operation has it,
 * near-misses do not, and a declaration that disagrees with the observed schema
 * is refused rather than trusted.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  documentedComposioMutationVerification,
  documentedComposioReadbackVerification,
  validateDocumentedComposioVerification,
} from './operation-semantics.js';

const BATCH_GET_INPUT = Object.freeze({
  type: 'object',
  required: ['spreadsheet_id'],
  properties: {
    spreadsheet_id: { type: 'string' },
    ranges: { type: 'array', items: { type: 'string' } },
  },
});
const BATCH_GET_OUTPUT = Object.freeze({
  type: 'object',
  required: ['data', 'successful'],
  properties: {
    data: { type: 'object' },
    error: {},
    successful: { type: 'boolean' },
  },
});

test('the exact reviewed readback operation carries a versioned declaration', () => {
  const declared = documentedComposioReadbackVerification('GOOGLESHEETS_BATCH_GET');
  assert.ok(declared, 'the reviewed exact-ID getter is the declared verifier');
  assert.equal(declared!.version, 1);
  assert.equal(declared!.resourceFamily, 'googlesheets');
  assert.equal(declared!.acceptedHandleKind, 'created_resource');
  assert.deepEqual([...declared!.requestTargetPointers], ['/spreadsheet_id'],
    'target pointers are RFC 6901 JSON pointers, not bare property names');
  assert.deepEqual(declared!.responseTarget, { version: 1, kind: 'request_bound_success_v1' });
  assert.equal(declared!.resultEnvelope, 'successful_data_envelope_v1');
  assert.deepEqual(declared!.observedContent, {
    projection: { version: 1, kind: 'exact_range_values_v1', entriesPointer: '/valueRanges',
      rangePointer: '/range', valuesPointer: '/values' },
    requestRangePointer: '/ranges',
  });
});

test('a lookalike or generic read is never a declared verifier', () => {
  for (const near of [
    'GOOGLESHEETS_BATCH_GET_BY_DATA_FILTER',
    'GOOGLESHEETS_BATCH_GETX',
    'GOOGLESHEETS_GET_SPREADSHEET_INFO',
    'GOOGLESHEETS_SEARCH',
    'AIRTABLE_BATCH_GET',
    '',
    null,
  ]) {
    assert.equal(documentedComposioReadbackVerification(near), null,
      `${String(near)} must not inherit verifier authority`);
  }
});

test('a transport prefix or alias does not confer the declaration', () => {
  // The atomic-content-commit precedent: exact canonical spelling only. A
  // wrapper prefix is transport, and accepting it here would let a dynamic
  // wrapper smuggle verifier authority.
  assert.equal(documentedComposioReadbackVerification('CX_GOOGLESHEETS_BATCH_GET'), null);
  assert.equal(documentedComposioReadbackVerification('googlesheets_batch_get'),
    documentedComposioReadbackVerification('GOOGLESHEETS_BATCH_GET'),
    'durable call identity is case-normalized; that exact canonical spelling still qualifies');
});

test('the declaration must agree with the schemas actually observed', () => {
  const operationId = 'GOOGLESHEETS_BATCH_GET';
  assert.deepEqual(validateDocumentedComposioVerification({
    operationId, inputSchema: BATCH_GET_INPUT, outputSchema: BATCH_GET_OUTPUT,
  }), { readback: documentedComposioReadbackVerification(operationId) },
  'the reviewed declaration matches the reviewed schemas');

  assert.equal(validateDocumentedComposioVerification({
    operationId,
    inputSchema: { type: 'object', required: ['sheetId'], properties: { sheetId: { type: 'string' } } },
    outputSchema: BATCH_GET_OUTPUT,
  }), null, 'a target pointer naming an argument the schema does not require is refused');

  assert.equal(validateDocumentedComposioVerification({
    operationId,
    inputSchema: BATCH_GET_INPUT,
    outputSchema: { type: 'object', required: ['successful'], properties: { successful: { type: 'boolean' } } },
  }), null, 'a response missing the acknowledged data envelope cannot prove the request-bound readback');

  assert.equal(validateDocumentedComposioVerification({
    operationId, inputSchema: null, outputSchema: BATCH_GET_OUTPUT,
  }), null, 'an unobserved input schema is not evidence of agreement');
});

test('drift in the observed definition refuses rather than reusing the declaration', () => {
  const operationId = 'GOOGLESHEETS_BATCH_GET';
  const drifted = {
    type: 'object',
    required: ['spreadsheet_id', 'majorDimension'],
    properties: {
      spreadsheet_id: { type: 'number' },
      majorDimension: { type: 'string' },
    },
  };
  assert.equal(validateDocumentedComposioVerification({
    operationId, inputSchema: drifted, outputSchema: BATCH_GET_OUTPUT,
  }), null, 'a target that is no longer a string identifier is not the reviewed contract');
});

test('only the exact reviewed mutations declare a verification requirement', () => {
  const create = documentedComposioMutationVerification('GOOGLESHEETS_CREATE_GOOGLE_SHEET1');
  assert.ok(create, 'the reviewed create declares identity proof');
  assert.equal(create!.version, 1);
  assert.equal(create!.proof, 'resource_identity_v1');
  assert.equal(create!.resourceFamily, 'googlesheets');
  assert.equal(create!.producedHandleKind, 'created_resource');

  const update = documentedComposioMutationVerification('GOOGLESHEETS_VALUES_UPDATE');
  assert.ok(update, 'the reviewed update declares exact-content proof');
  assert.equal(update!.proof, 'exact_content_v1');
  assert.deepEqual(update!.target, { source: 'provider_arguments', pointers: ['/spreadsheet_id'] });
  assert.deepEqual(update!.expectedContent, {
    projection: { version: 1, kind: 'exact_single_range_values_v1', rangePointer: '/range', valuesPointer: '/values' },
    verifierRequestRangePointer: '/ranges',
  });
});

test('a generic write never acquires a verification requirement', () => {
  // The regression this pins: applying a Sheets-shaped verifier requirement to
  // every proof-provisioned write made unrelated writes demand a readback they
  // never had, breaking ordinary discovery. Only reviewed operations opt in.
  for (const generic of [
    'SLACK_CHAT_POST_MESSAGE',
    'AIRTABLE_UPDATE_RECORD',
    'GOOGLESHEETS_BATCH_UPDATE_VALUES_BY_DATA_FILTER',
    'GOOGLESHEETS_CREATE_SPREADSHEET_ROW',
    'GOOGLESHEETS_BATCH_UPDATE',
    'CX_GOOGLESHEETS_VALUES_UPDATE',
    'CX_GOOGLESHEETS_BATCH_UPDATE',
    '',
    null,
  ]) {
    assert.equal(documentedComposioMutationVerification(generic), null,
      `${String(generic)} must keep its prior evidence behaviour`);
  }
});
