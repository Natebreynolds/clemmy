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
const continuity = await import('../../memory/task-continuity.js');

const CONNECTION_QUESTION = 'Firecrawl isn’t connected, so I can’t use FIRECRAWL_SEARCH for this task yet. [Open Connections](/m/?tab=settings&toolkit=firecrawl&capability=FIRECRAWL_SEARCH) on this Mac and connect Firecrawl, then choose how you want me to continue:';
const CONNECTION_OPTIONS = [
  'I’ve connected Firecrawl — continue this same task',
  'Pause so I can change the research scope',
];
const CONNECTION_SUBJECT = {
  kind: 'exact_capability_connection' as const,
  provider: 'authorized_composio' as const,
  toolkit: 'firecrawl',
  capability: 'FIRECRAWL_SEARCH',
  capabilityRef: 'cap:resolved:firecrawl_search',
  discoveryQuery: 'web search',
  discoveryRole: 'source',
  continueOptionId: 'opt-1',
  continueOptionLabel: CONNECTION_OPTIONS[0]!,
};

function unavailableConnectionSubject(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    kind: 'exact_capability_connection',
    source: 'authorized_composio',
    query: 'web search',
    roleKey: 'source',
    toolkit: 'firecrawl',
    capability: 'FIRECRAWL_SEARCH',
    capabilityRef: 'cap:resolved:firecrawl_search',
    ...overrides,
  };
}

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
  question?: string;
  options?: string[];
}): void {
  const output = JSON.stringify({
    query: 'web search',
    role_key: 'source',
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
  if (input.question) {
    eventlog.appendEvent({
      sessionId: input.sessionId,
      turn: 1,
      role: 'Clem',
      type: 'awaiting_user_input',
      data: {
        sourceUserSeq: input.sourceUserSeq,
        question: input.question,
        options: input.options ?? [],
      },
    });
  }
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
      source: 'authorized_composio',
      code: 'no_connections',
      reason: 'No current connection is available.',
      dependencySubject: unavailableConnectionSubject(),
    }],
    results: [{
      name: 'unrelated_local_control',
      capabilityRef: 'cap:local:unrelated',
      planningProvenance: 'authorized_local_registry',
    }],
    question: CONNECTION_QUESTION,
    options: CONNECTION_OPTIONS,
  });
  const first = dependencies.parkObservedConnectionDependencyForSource({
    sessionId: accepted.sessionId,
    sourceUserSeq: accepted.seq,
    turn: 1,
    text: CONNECTION_QUESTION,
  });
  const replay = dependencies.parkObservedConnectionDependencyForSource({
    sessionId: accepted.sessionId,
    sourceUserSeq: accepted.seq,
    turn: 1,
    text: CONNECTION_QUESTION,
  });
  assert.equal(first?.kind, 'connection_missing');
  assert.equal(first?.wake.kind, 'user_connection');
  assert.deepEqual(first?.connectionSubject, CONNECTION_SUBJECT);
  assert.equal(replay?.requestId, first?.requestId);
  const rows = eventlog.openEventLog().prepare(
    'SELECT kind, status, text FROM dependency_requests WHERE session_id = ?',
  ).all(accepted.sessionId) as Array<{ kind: string; status: string; text: string }>;
  assert.deepEqual(rows, [{
    kind: 'connection_missing',
    status: 'open',
    text: CONNECTION_QUESTION,
  }]);
});

test('model CTA synonyms, suffixes, translation, and a different well-formed link cannot alter host subject authority', () => {
  const presentations = [
    {
      question: 'Reconnect Firecrawl in settings, then tell me to keep going.',
      options: ['Connected — carry on', 'Stop'],
    },
    {
      question: 'Open [Connections](/m/?tab=settings&toolkit=firecrawl&capability=FIRECRAWL_SEARCH_DROPBOX_EXPORT) and continue.',
      options: ['I’ve linked it — proceed', 'Pause'],
    },
    {
      question: 'Firecrawl n’est pas connecté ; ouvrez « Connexions », puis continuez…',
      options: ['C’est connecté — continuer', 'Mettre en pause'],
    },
    {
      question: 'Open [Connections](/m/?tab=settings&toolkit=google_drive&capability=GOOGLE_DRIVE_UPLOAD_FILE), then continue.',
      options: ['I’ve connected Google Drive — continue this same task', 'Pause'],
    },
  ];
  for (const [index, proposed] of presentations.entries()) {
    eventlog.resetEventLog();
    const accepted = source(`dep-presentation-is-not-authority-${index}`);
    returnedSearch({
      sessionId: accepted.sessionId,
      sourceUserSeq: accepted.seq,
      callId: `search-${index}`,
      unavailable: [{
        source: 'authorized_composio',
        code: 'no_connections',
        reason: 'No current connection is available.',
        dependencySubject: unavailableConnectionSubject(),
      }],
      question: proposed.question,
      options: proposed.options,
    });
    const projection = dependencies.observedConnectionDependencyPresentationForSource({
      sessionId: accepted.sessionId,
      sourceUserSeq: accepted.seq,
    });
    assert.equal(projection?.question, CONNECTION_QUESTION, proposed.question);
    assert.deepEqual(projection?.options, CONNECTION_OPTIONS, proposed.question);
    assert.deepEqual(projection?.subject, CONNECTION_SUBJECT, proposed.question);
    const parked = dependencies.parkObservedConnectionDependencyForSource({
      sessionId: accepted.sessionId,
      sourceUserSeq: accepted.seq,
      turn: accepted.turn,
      text: proposed.question,
    });
    assert.equal(parked?.text, CONNECTION_QUESTION, proposed.question);
    assert.deepEqual(parked?.connectionSubject, CONNECTION_SUBJECT, proposed.question);
  }
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
      dependencySubject: unavailableConnectionSubject(),
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
      dependencySubject: unavailableConnectionSubject(),
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

function consumedConnectionContinuation(
  sessionId: string,
  resolution: {
    disposition: 'selected' | 'provided' | 'declined' | 'declined_with_new_task';
    selectedOption?: string;
  } = { disposition: 'selected', selectedOption: 'opt-1' },
) {
  const parent = source(sessionId, 'Research the current topic using the connected web provider.');
  dependencies.parkDependencyRequest({
    sessionId,
    sourceUserSeq: parent.seq,
    turn: parent.turn,
    kind: 'connection_missing',
    text: CONNECTION_QUESTION,
    connectionSubject: CONNECTION_SUBJECT,
  });
  const awaiting = eventlog.appendEvent({
    sessionId,
    turn: parent.turn,
    role: 'Clem',
    type: 'awaiting_user_input',
    data: {
      sourceUserSeq: parent.seq,
      question: CONNECTION_QUESTION,
      options: CONNECTION_OPTIONS,
    },
  });
  const terminal = eventlog.appendEvent({
    sessionId,
    turn: parent.turn,
    role: 'system',
    type: 'conversation_completed',
    data: {
      sourceUserSeq: parent.seq,
      reply: CONNECTION_QUESTION,
    },
  });
  continuity.createTaskContinuityPacket({
    sessionId,
    originatingSourceUserSeq: parent.seq,
    pause: {
      kind: 'clarification',
      question: CONNECTION_QUESTION,
      options: CONNECTION_OPTIONS,
    },
    publicDeliveryBinding: {
      awaitingEventId: awaiting.id,
      terminalEventId: terminal.id,
    },
  });
  const answer = eventlog.appendEvent({
    sessionId,
    turn: 2,
    role: 'user',
    type: 'user_input_received',
    data: {
      text: resolution.selectedOption === 'opt-2'
        ? CONNECTION_OPTIONS[1]
        : CONNECTION_OPTIONS[0],
    },
  });
  const consumed = continuity.consumeTaskContinuityPacket({
    sessionId,
    consumingSourceUserSeq: answer.seq,
    resolution: {
      resolverVersion: 'clarification-resolver-v2',
      disposition: resolution.disposition,
      ...(resolution.selectedOption ? { selectedOption: resolution.selectedOption } : {}),
      semanticInputHash: 'c'.repeat(64),
    },
  });
  assert.equal(consumed.status, 'consumed');
  return { parent, answer };
}

function successfulConnectedSearch(input: {
  sessionId: string;
  sourceUserSeq: number;
  callId: string;
  result?: Record<string, unknown>;
}) {
  const invocationNonce = `nonce:${input.callId}`;
  const output = JSON.stringify({
    query: 'web search',
    role_key: 'source',
    results: [input.result ?? {
      name: 'FIRECRAWL_SEARCH',
      capabilityRef: 'cap:resolved:firecrawl_search',
      planningProvenance: 'authorized_composio',
      carrier: 'work_call',
      selectedAccount: {
        toolkit: 'firecrawl',
        accountIdentity: 'conn-firecrawl-current',
        accountIdentityKind: 'connection_id',
      },
    }],
    brokerCoverage: 'authorized_external_v1',
  });
  eventlog.writeToolOutput({
    sessionId: input.sessionId,
    callId: input.callId,
    tool: 'tool_search',
    output,
    invocationNonce,
  });
  return eventlog.appendEvent({
    sessionId: input.sessionId,
    turn: 2,
    role: 'tool',
    type: 'tool_returned',
    data: {
      sourceUserSeq: input.sourceUserSeq,
      tool: 'tool_search',
      callId: input.callId,
      invocationNonce,
      accounting: 'top_level',
      topologyRole: 'control',
      ok: true,
    },
  });
}

test('a restarted legacy null-subject park is CAS-enriched only by canonical discovery and then resumes', () => {
  const parent = source('dep-legacy-subject-upgrade', 'Research the current topic.');
  const legacy = dependencies.parkDependencyRequest({
    sessionId: parent.sessionId,
    sourceUserSeq: parent.seq,
    turn: parent.turn,
    kind: 'connection_missing',
    text: 'Legacy reconnect copy with no bound subject.',
  });
  eventlog.closeEventLog();
  returnedSearch({
    sessionId: parent.sessionId,
    sourceUserSeq: parent.seq,
    callId: 'legacy-canonical-search',
    unavailable: [{
      source: 'authorized_composio',
      code: 'no_connections',
      reason: 'No current connection is available.',
      dependencySubject: unavailableConnectionSubject(),
    }],
  });
  const repaired = dependencies.parkObservedConnectionDependencyForSource({
    sessionId: parent.sessionId,
    sourceUserSeq: parent.seq,
    turn: parent.turn,
    text: 'Model prose cannot supply the missing subject.',
  });
  assert.equal(repaired?.requestId, legacy.requestId);
  assert.equal(repaired?.text, CONNECTION_QUESTION);
  assert.deepEqual(repaired?.connectionSubject, CONNECTION_SUBJECT);
  const row = eventlog.openEventLog().prepare(`
    SELECT subject_kind, subject_provider, subject_toolkit, subject_capability,
           subject_capability_ref, status FROM dependency_requests WHERE request_id = ?
  `).get(legacy.requestId);
  assert.deepEqual(row, {
    subject_kind: 'exact_capability_connection',
    subject_provider: 'authorized_composio',
    subject_toolkit: 'firecrawl',
    subject_capability: 'FIRECRAWL_SEARCH',
    subject_capability_ref: 'cap:resolved:firecrawl_search',
    status: 'open',
  });

  const awaiting = eventlog.appendEvent({
    sessionId: parent.sessionId,
    turn: parent.turn,
    role: 'Clem',
    type: 'awaiting_user_input',
    data: {
      sourceUserSeq: parent.seq,
      question: CONNECTION_QUESTION,
      options: CONNECTION_OPTIONS,
    },
  });
  const terminal = eventlog.appendEvent({
    sessionId: parent.sessionId,
    turn: parent.turn,
    role: 'system',
    type: 'conversation_completed',
    data: { sourceUserSeq: parent.seq, reply: CONNECTION_QUESTION },
  });
  continuity.createTaskContinuityPacket({
    sessionId: parent.sessionId,
    originatingSourceUserSeq: parent.seq,
    pause: {
      kind: 'clarification',
      question: CONNECTION_QUESTION,
      options: CONNECTION_OPTIONS,
    },
    publicDeliveryBinding: {
      awaitingEventId: awaiting.id,
      terminalEventId: terminal.id,
    },
  });
  const answer = eventlog.appendEvent({
    sessionId: parent.sessionId,
    turn: 2,
    role: 'user',
    type: 'user_input_received',
    data: { text: CONNECTION_OPTIONS[0] },
  });
  assert.equal(continuity.consumeTaskContinuityPacket({
    sessionId: parent.sessionId,
    consumingSourceUserSeq: answer.seq,
    resolution: {
      resolverVersion: 'clarification-resolver-v2',
      disposition: 'selected',
      selectedOption: 'opt-1',
      semanticInputHash: 'd'.repeat(64),
    },
  }).status, 'consumed');
  const returned = successfulConnectedSearch({
    sessionId: parent.sessionId,
    sourceUserSeq: answer.seq,
    callId: 'legacy-connected-search',
  });
  assert.equal(dependencies.satisfyObservedConnectionDependencyForContinuation({
    sessionId: parent.sessionId,
    sourceUserSeq: answer.seq,
    returnedEventId: returned.id,
  }), true);
});

test('fresh account-bound discovery on the consumed continuation CAS-satisfies exactly its parent dependency', () => {
  const { parent, answer } = consumedConnectionContinuation('dep-satisfy-observed');
  const returned = successfulConnectedSearch({
    sessionId: parent.sessionId,
    sourceUserSeq: answer.seq,
    callId: 'search-connected-firecrawl',
  });
  assert.equal(dependencies.satisfyObservedConnectionDependencyForContinuation({
    sessionId: parent.sessionId,
    sourceUserSeq: answer.seq,
    returnedEventId: returned.id,
  }), true);
  assert.equal(dependencies.satisfyObservedConnectionDependencyForContinuation({
    sessionId: parent.sessionId,
    sourceUserSeq: answer.seq,
    returnedEventId: returned.id,
  }), false, 'replaying the same durable observation cannot satisfy twice');
  const row = eventlog.openEventLog().prepare(`
    SELECT source_user_seq, kind, owner, wake_kind, status, satisfied_at
      FROM dependency_requests WHERE session_id = ?
  `).get(parent.sessionId) as {
    source_user_seq: number;
    kind: string;
    owner: string;
    wake_kind: string;
    status: string;
    satisfied_at: string | null;
  };
  assert.equal(row.source_user_seq, parent.seq);
  assert.equal(row.kind, 'connection_missing');
  assert.equal(row.owner, 'user');
  assert.equal(row.wake_kind, 'user_connection');
  assert.equal(row.status, 'satisfied');
  assert.match(row.satisfied_at ?? '', /^\d{4}-\d{2}-\d{2}T/);
});

test('foreign, malformed, account-free, wrong-toolkit, and wrong-capability observations leave the parent dependency open', () => {
  for (const variant of [
    'foreign', 'no-account', 'malformed-account', 'wrong-toolkit', 'wrong-capability',
  ] as const) {
    eventlog.resetEventLog();
    const { parent, answer } = consumedConnectionContinuation(`dep-satisfy-negative-${variant}`);
    const foreign = variant === 'foreign'
      ? eventlog.appendEvent({
          sessionId: parent.sessionId,
          turn: 3,
          role: 'user',
          type: 'user_input_received',
          data: { text: 'Unrelated new request.' },
        })
      : null;
    const result = variant === 'no-account'
      ? {
          name: 'FIRECRAWL_SEARCH',
          capabilityRef: 'cap:resolved:firecrawl_search',
          planningProvenance: 'authorized_composio',
          carrier: 'work_call',
        }
      : variant === 'malformed-account'
        ? {
            name: 'FIRECRAWL_SEARCH',
            capabilityRef: 'cap:resolved:firecrawl_search',
            planningProvenance: 'authorized_composio',
            carrier: 'work_call',
            selectedAccount: {
              toolkit: 'FireCrawl',
              accountIdentity: '',
              accountIdentityKind: 'connection_id',
            },
          }
        : variant === 'wrong-toolkit'
          ? {
              name: 'FIRECRAWL_SEARCH',
              capabilityRef: 'cap:resolved:firecrawl_search',
              planningProvenance: 'authorized_composio',
              carrier: 'work_call',
              selectedAccount: {
                toolkit: 'google_drive',
                accountIdentity: 'conn-google-drive-current',
                accountIdentityKind: 'connection_id',
              },
            }
          : variant === 'wrong-capability'
            ? {
                name: 'FIRECRAWL_SCRAPE',
                capabilityRef: 'cap:resolved:firecrawl_scrape',
                planningProvenance: 'authorized_composio',
                carrier: 'work_call',
                selectedAccount: {
                  toolkit: 'firecrawl',
                  accountIdentity: 'conn-firecrawl-current',
                  accountIdentityKind: 'connection_id',
                },
              }
        : undefined;
    const returned = successfulConnectedSearch({
      sessionId: parent.sessionId,
      sourceUserSeq: foreign?.seq ?? answer.seq,
      callId: `search-${variant}`,
      ...(result ? { result } : {}),
    });
    assert.equal(dependencies.satisfyObservedConnectionDependencyForContinuation({
      sessionId: parent.sessionId,
      sourceUserSeq: answer.seq,
      returnedEventId: returned.id,
    }), false, variant);
    assert.equal((eventlog.openEventLog().prepare(`
      SELECT status FROM dependency_requests WHERE session_id = ?
    `).get(parent.sessionId) as { status: string }).status, 'open');
  }
});

test('pause, free text, and a stale option id cannot satisfy the exact Continue dependency', () => {
  for (const resolution of [
    { disposition: 'selected' as const, selectedOption: 'opt-2' },
    { disposition: 'provided' as const },
    { disposition: 'selected' as const, selectedOption: 'opt-9' },
  ]) {
    eventlog.resetEventLog();
    const sessionId = `dep-satisfy-wrong-disposition-${resolution.disposition}-${resolution.selectedOption ?? 'none'}`;
    const { parent, answer } = consumedConnectionContinuation(sessionId, resolution);
    const returned = successfulConnectedSearch({
      sessionId,
      sourceUserSeq: answer.seq,
      callId: `search-${resolution.selectedOption ?? resolution.disposition}`,
    });
    assert.equal(dependencies.satisfyObservedConnectionDependencyForContinuation({
      sessionId,
      sourceUserSeq: answer.seq,
      returnedEventId: returned.id,
    }), false, JSON.stringify(resolution));
    assert.equal((eventlog.openEventLog().prepare(`
      SELECT status FROM dependency_requests WHERE session_id = ?
    `).get(parent.sessionId) as { status: string }).status, 'open');
  }
});
