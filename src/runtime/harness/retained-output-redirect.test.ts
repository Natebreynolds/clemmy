/**
 * Run: npx tsx --test src/runtime/harness/retained-output-redirect.test.ts
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  describeMissingRetainedOutput,
  isCapabilityReference,
  queryableRetainedOutputs,
} from './retained-output-redirect.js';

const CAL_REF = 'cap:resolved:outlook_get_calendar_view:definition:890911f634558ec9c128fad4';

test('a capability reference is named as an operation and gets the exact composio carrier call', () => {
  const text = describeMissingRetainedOutput({
    requestedId: CAL_REF,
    readerTool: 'tool_output_query',
    retained: [],
    lookupCapability: (id) => (id === CAL_REF
      ? { capabilityId: id, toolName: 'outlook_get_calendar_view', providerKind: 'composio', operationId: 'OUTLOOK_GET_CALENDAR_VIEW' }
      : null),
  });
  assert.match(text, /CAPABILITY reference, not a result handle/);
  assert.match(text, /no call has been made with it in this turn/);
  assert.match(text, /"tool":"work_call"/);
  assert.match(text, /composio_execute_tool/);
  assert.match(text, /OUTLOOK_GET_CALENDAR_VIEW/);
  assert.match(text, new RegExp(`"requirement_id":"${CAL_REF.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
  assert.match(text, /Nothing has been retrieved in this turn yet/);
  // The old dead end must be gone: it read as "empty data" and looped 13×.
  assert.doesNotMatch(text, /^No tool output found/);
});

test('a local operation is invoked by its own name; an unregistered ref is sent through tool_search', () => {
  const local = describeMissingRetainedOutput({
    requestedId: 'cap:local:read_file:reversible',
    readerTool: 'recall_tool_result',
    retained: [],
    lookupCapability: () => ({ capabilityId: 'cap:local:read_file:reversible', toolName: 'read_file', providerKind: 'local_registry', operationId: 'read_file' }),
  });
  assert.match(local, /calling read_file directly/);
  const unknown = describeMissingRetainedOutput({
    requestedId: 'cap:resolved:some_op:definition:abc',
    readerTool: 'tool_output_query',
    retained: [],
    lookupCapability: () => null,
  });
  assert.match(unknown, /call tool_search/);
});

test('an unknown plain id lists what this turn retained and never a reader\'s own miss text', () => {
  const retained = [
    { callId: 'call-cal-1', tool: 'work_call', contentBytes: 12_400, createdAt: '2026-09-22T00:00:02.000Z' },
    { callId: 'call-miss-1', tool: 'tool_output_query', contentBytes: 126, createdAt: '2026-09-22T00:00:01.000Z' },
    { callId: 'call-recall-1', tool: 'recall_tool_result', contentBytes: 500, createdAt: '2026-09-22T00:00:00.000Z' },
  ];
  assert.deepEqual(queryableRetainedOutputs(retained).map((row) => row.callId), ['call-cal-1']);
  const text = describeMissingRetainedOutput({
    requestedId: 'call-does-not-exist',
    readerTool: 'tool_output_query',
    retained,
    lookupCapability: () => null,
  });
  assert.match(text, /No tool output found for call_id "call-does-not-exist"/);
  assert.match(text, /call-cal-1 \(work_call, 12 KB\)/);
  assert.doesNotMatch(text, /call-miss-1|call-recall-1/);
  assert.match(text, /make the provider call \(or call tool_search/);
});

test('isCapabilityReference recognises the host ref grammar only', () => {
  assert.equal(isCapabilityReference(CAL_REF), true);
  assert.equal(isCapabilityReference('cap:local:workflow_create:reversible'), true);
  assert.equal(isCapabilityReference('call-b85950a9-c104-4811-8dfa-9dd3caa53b62-0'), false);
  assert.equal(isCapabilityReference('rh_abc'), false);
  assert.equal(isCapabilityReference(''), false);
});
