/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/host-interactive-consent-schema.test.ts */
import assert from 'node:assert/strict';
import test from 'node:test';

import { canonicalExternalInputSchemaDigestV1 } from './external-capability-risk-loader.js';
import { durableLogicalCallContract } from './logical-call-contract.js';
import { selectExactPreparedExternalCall } from './host-interactive-consent.js';

const PROVIDER_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['title'],
  properties: { title: { type: 'string' } },
});
const WRAPPER_SCHEMA = Object.freeze({
  type: 'object',
  additionalProperties: false,
  required: ['tool_slug', 'arguments'],
  properties: {
    tool_slug: { type: 'string' },
    arguments: { type: 'string' },
  },
});
const PROVIDER_DIGEST = canonicalExternalInputSchemaDigestV1(PROVIDER_SCHEMA)!;
const ACCEPTED_TASK_ID = 'task:external-schema-pair';
const PROVIDER_ARGS = Object.freeze({ title: 'Quarterly brief' });
const PROVIDER_CONTRACT = durableLogicalCallContract(
  ACCEPTED_TASK_ID,
  'GOOGLEDOCS_CREATE_DOCUMENT',
  PROVIDER_ARGS,
)!;

function select(candidates: Parameters<typeof selectExactPreparedExternalCall>[0]['candidates']) {
  return selectExactPreparedExternalCall({
    providerInputSchemaDigest: PROVIDER_DIGEST,
    acceptedTaskId: ACCEPTED_TASK_ID,
    effectiveArgumentDigest: PROVIDER_CONTRACT.argumentDigest,
    effectiveToolName: PROVIDER_CONTRACT.toolName,
    candidates,
  });
}

test('selects a direct prepared provider schema and argument pair by exact authority', () => {
  const selected = select([{
    inputSchema: PROVIDER_SCHEMA,
    arguments: PROVIDER_ARGS,
    logicalToolName: 'GOOGLEDOCS_CREATE_DOCUMENT',
  }]);
  assert.equal(selected?.inputSchema, PROVIDER_SCHEMA);
  assert.equal(selected?.arguments, PROVIDER_ARGS);
});

test('selects wrapped-call evidence schema with its paired evidence arguments', () => {
  const selected = select([
    {
      inputSchema: WRAPPER_SCHEMA,
      arguments: { tool_slug: 'GOOGLEDOCS_CREATE_DOCUMENT', arguments: JSON.stringify(PROVIDER_ARGS) },
      logicalToolName: 'composio_execute_tool',
    },
    {
      inputSchema: PROVIDER_SCHEMA,
      arguments: PROVIDER_ARGS,
      logicalToolName: 'GOOGLEDOCS_CREATE_DOCUMENT',
    },
  ]);
  assert.equal(selected?.inputSchema, PROVIDER_SCHEMA);
  assert.equal(selected?.arguments, PROVIDER_ARGS);
});

test('canonical-equal duplicate candidate pairs are one semantic call value', () => {
  const selected = select([
    { inputSchema: PROVIDER_SCHEMA, arguments: PROVIDER_ARGS, logicalToolName: 'GOOGLEDOCS_CREATE_DOCUMENT' },
    {
      inputSchema: structuredClone(PROVIDER_SCHEMA),
      arguments: structuredClone(PROVIDER_ARGS),
      logicalToolName: 'GOOGLEDOCS_CREATE_DOCUMENT',
    },
  ]);
  assert.deepEqual(selected?.inputSchema, PROVIDER_SCHEMA);
  assert.deepEqual(selected?.arguments, PROVIDER_ARGS);
});

test('missing exact provider-schema authority refuses selection', () => {
  assert.equal(select([{
    inputSchema: WRAPPER_SCHEMA,
    arguments: PROVIDER_ARGS,
    logicalToolName: 'GOOGLEDOCS_CREATE_DOCUMENT',
  }]), null);
});

test('target match is retained when a poisoned evidence pair cannot reproduce the logical digest', () => {
  const selected = select([
    { inputSchema: PROVIDER_SCHEMA, arguments: PROVIDER_ARGS, logicalToolName: 'GOOGLEDOCS_CREATE_DOCUMENT' },
    {
      inputSchema: PROVIDER_SCHEMA,
      arguments: { title: 'poisoned evidence' },
      logicalToolName: 'GOOGLEDOCS_CREATE_DOCUMENT',
    },
  ]);
  assert.equal(selected?.arguments, PROVIDER_ARGS);
});

test('evidence match is retained when a poisoned target pair cannot reproduce the logical digest', () => {
  const selected = select([
    {
      inputSchema: PROVIDER_SCHEMA,
      arguments: { title: 'poisoned target' },
      logicalToolName: 'GOOGLEDOCS_CREATE_DOCUMENT',
    },
    { inputSchema: PROVIDER_SCHEMA, arguments: PROVIDER_ARGS, logicalToolName: 'GOOGLEDOCS_CREATE_DOCUMENT' },
  ]);
  assert.equal(selected?.arguments, PROVIDER_ARGS);
});

test('exact selection refusal reports bounded value-free candidate mismatch categories', () => {
  const seen: unknown[] = [];
  const input = {
    providerInputSchemaDigest: PROVIDER_DIGEST,
    acceptedTaskId: ACCEPTED_TASK_ID,
    effectiveArgumentDigest: PROVIDER_CONTRACT.argumentDigest,
    effectiveToolName: PROVIDER_CONTRACT.toolName,
    candidates: [
      { inputSchema: null, arguments: {}, logicalToolName: 'GOOGLEDOCS_CREATE_DOCUMENT' },
      { inputSchema: WRAPPER_SCHEMA, arguments: PROVIDER_ARGS, logicalToolName: 'GOOGLEDOCS_CREATE_DOCUMENT' },
      { inputSchema: PROVIDER_SCHEMA, arguments: PROVIDER_ARGS, logicalToolName: 'OTHER_CREATE_DOCUMENT' },
      { inputSchema: PROVIDER_SCHEMA, arguments: { title: 'PRIVATE-CHANGED-BODY' }, logicalToolName: 'GOOGLEDOCS_CREATE_DOCUMENT' },
    ],
    onMismatch: (diagnostic: unknown) => seen.push(diagnostic),
  };
  assert.equal(selectExactPreparedExternalCall(input), null);
  assert.deepEqual(seen, [{ reason: 'no_matching_candidate', candidates: [
    { index: 0, reason: 'schema_missing_or_invalid' },
    { index: 1, reason: 'schema_digest_mismatch', schemaDigestMatches: false },
    { index: 2, reason: 'tool_identity_mismatch', schemaDigestMatches: true, toolIdentityMatches: false },
    { index: 3, reason: 'argument_digest_mismatch', schemaDigestMatches: true, toolIdentityMatches: true, argumentDigestMatches: false },
  ] }]);
  assert.doesNotMatch(JSON.stringify(seen), /PRIVATE|Quarterly|GOOGLEDOCS|OTHER|title|properties/);
});
