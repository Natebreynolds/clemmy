/** Run: node scripts/run-tests-isolated.mjs src/runtime/harness/dependency-request.test.ts */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

const HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-dependency-evidence-'));
process.env.CLEMENTINE_HOME = HOME;

const eventlog = await import('./eventlog.js');
const dependencies = await import('./dependency-request.js');

function source(sessionId: string, text = 'Use the generated provider account.') {
  eventlog.createSession({ id: sessionId, kind: 'chat', userId: 'user' });
  return eventlog.appendEvent({
    sessionId,
    turn: 1,
    role: 'user',
    type: 'user_input_received',
    data: { text },
  });
}

function returnedSearch(input: {
  sessionId: string;
  sourceUserSeq: number;
  callId: string;
  unavailable: unknown[];
  results?: unknown[];
}): void {
  const output = JSON.stringify({
    query: 'generated provider operation',
    results: input.results ?? [],
    unavailable: input.unavailable,
    brokerCoverage: 'authorized_external_v1',
  });
  eventlog.writeToolOutput({
    sessionId: input.sessionId,
    callId: input.callId,
    tool: 'tool_search',
    output,
  });
  eventlog.appendEvent({
    sessionId: input.sessionId,
    turn: 1,
    role: 'Clem',
    type: 'tool_returned',
    data: {
      sourceUserSeq: input.sourceUserSeq,
      tool: 'tool_search',
      callId: input.callId,
      accounting: 'top_level',
      topologyRole: 'control',
      result: output,
    },
  });
}

beforeEach(() => eventlog.resetEventLog());

after(() => {
  eventlog.closeEventLog();
  rmSync(HOME, { recursive: true, force: true });
});

test('host-observed no-connections evidence parks one typed connection dependency', () => {
  const accepted = source('dep-observed');
  returnedSearch({
    sessionId: accepted.sessionId,
    sourceUserSeq: accepted.seq,
    callId: 'search-1',
    unavailable: [{
      source: 'authorized_external_mcp',
      code: 'no_connections',
      reason: 'No current connection is available.',
    }],
    results: [{
      name: 'unrelated_local_control',
      capabilityRef: 'cap:local:unrelated',
      planningProvenance: 'authorized_local_registry',
    }],
  });
  const first = dependencies.parkObservedConnectionDependencyForSource({
    sessionId: accepted.sessionId,
    sourceUserSeq: accepted.seq,
    turn: 1,
    text: 'Connect the generated provider account so I can continue?',
  });
  const replay = dependencies.parkObservedConnectionDependencyForSource({
    sessionId: accepted.sessionId,
    sourceUserSeq: accepted.seq,
    turn: 1,
    text: 'Different presentation cannot create a second request.',
  });
  assert.equal(first?.kind, 'connection_missing');
  assert.equal(first?.wake.kind, 'user_connection');
  assert.equal(replay?.requestId, first?.requestId);
  const rows = eventlog.openEventLog().prepare(
    'SELECT kind, status, text FROM dependency_requests WHERE session_id = ?',
  ).all(accepted.sessionId) as Array<{ kind: string; status: string; text: string }>;
  assert.deepEqual(rows, [{
    kind: 'connection_missing',
    status: 'open',
    text: 'Connect the generated provider account so I can continue?',
  }]);
});

test('model prose, another source, and a usable external ref cannot mint connection_missing', () => {
  const first = source('dep-negative', 'First request');
  const second = eventlog.appendEvent({
    sessionId: first.sessionId,
    turn: 2,
    role: 'user',
    type: 'user_input_received',
    data: { text: 'Second request' },
  });
  returnedSearch({
    sessionId: first.sessionId,
    sourceUserSeq: first.seq,
    callId: 'old-search',
    unavailable: [{
      source: 'authorized_composio',
      code: 'no_connections',
      reason: 'No connection.',
    }],
  });
  assert.equal(dependencies.parkObservedConnectionDependencyForSource({
    sessionId: second.sessionId,
    sourceUserSeq: second.seq,
    turn: 2,
    text: 'The model says credentials are missing.',
  }), null, 'same-session evidence from an older accepted source cannot replay');

  returnedSearch({
    sessionId: second.sessionId,
    sourceUserSeq: second.seq,
    callId: 'current-search',
    unavailable: [{
      source: 'authorized_composio',
      code: 'no_connections',
      reason: 'One adapter has no connection.',
    }],
    results: [{
      name: 'generated_live_read',
      capabilityRef: 'cap:live:v1:generated',
      planningProvenance: 'authorized_external_mcp',
    }],
  });
  assert.equal(dependencies.parkObservedConnectionDependencyForSource({
    sessionId: second.sessionId,
    sourceUserSeq: second.seq,
    turn: 2,
    text: 'Ask anyway.',
  }), null, 'a current executable external ref disproves a global connection dependency');
});
