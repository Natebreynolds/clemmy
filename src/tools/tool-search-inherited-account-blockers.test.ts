/**
 * Run:
 *   node scripts/run-tests-isolated.mjs src/tools/tool-search-inherited-account-blockers.test.ts
 *
 * The open account blockers of a source are read from its own tool_search
 * returns. An answering continuation source may widen that read to its
 * same-session parent sources so an account the parent already settled is not
 * re-asked, and an account the parent left open is still asked exactly once.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const TEST_HOME = mkdtempSync(path.join(os.tmpdir(), 'clem-inherited-account-blockers-'));
process.env.CLEMENTINE_HOME = TEST_HOME;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.EMBEDDINGS_DISABLED = 'true';
process.env.MCP_AUTO_IMPORT_ENABLED = 'false';

const eventlog = await import('../runtime/harness/eventlog.js');
const provider = await import('./tool-search-provider-sources.js');

test.after(() => {
  eventlog.closeEventLog();
  rmSync(TEST_HOME, { recursive: true, force: true });
});

const FIRST = 'operator@first.invalid';
const SECOND = 'operator@second.invalid';

function source(sessionId: string, text: string) {
  if (!eventlog.getSession(sessionId)) eventlog.createSession({ id: sessionId, kind: 'chat' });
  return eventlog.appendEvent({ sessionId, turn: 1, role: 'user', type: 'user_input_received', data: { text } }).seq;
}

function returned(sessionId: string, sourceUserSeq: number, results: unknown[]) {
  eventlog.appendEvent({
    sessionId,
    turn: 1,
    role: 'tool',
    type: 'tool_returned',
    data: { sourceUserSeq, tool: 'tool_search', result: JSON.stringify({ results }) },
  });
}

const blocked = { name: 'OUTLOOK_CREATE_DRAFT', planningRefStatus: 'account_selection_required', accountChoices: [FIRST, SECOND] };
const resolved = { name: 'OUTLOOK_CREATE_DRAFT', capabilityRef: 'composio:OUTLOOK_CREATE_DRAFT' };

test('an open parent blocker is visible only when the parent source is inherited', () => {
  const sessionId = 'inherited-blockers-open';
  const parent = source(sessionId, 'Draft the follow-up in Outlook.');
  returned(sessionId, parent, [blocked]);
  const answer = source(sessionId, 'The first mailbox.');

  assert.deepEqual(provider.thisTurnSearchAccountSelectionBlockers({ sessionId, sourceUserSeq: answer }), [],
    'own-source reads stay own-source');
  assert.deepEqual(
    provider.thisTurnSearchAccountSelectionBlockers({ sessionId, sourceUserSeq: answer, inheritedSourceUserSeqs: [parent] }),
    [{ name: 'OUTLOOK_CREATE_DRAFT', choices: [FIRST, SECOND] }],
    'the inherited parent blocker is still open for the answering source',
  );
  assert.deepEqual(
    provider.thisTurnSearchAccountSelectionBlockers({ sessionId, sourceUserSeq: answer, inheritedSourceUserSeqs: [parent + 1000] }),
    [],
    'a source that is not listed is not read',
  );
});

test('a parent blocker the parent itself resolved is not re-raised on the answering source', () => {
  const sessionId = 'inherited-blockers-settled';
  const parent = source(sessionId, 'Draft the follow-up in Outlook for the first mailbox.');
  returned(sessionId, parent, [blocked]);
  returned(sessionId, parent, [resolved]);
  const answer = source(sessionId, 'Yes, go ahead.');
  assert.deepEqual(
    provider.thisTurnSearchAccountSelectionBlockers({ sessionId, sourceUserSeq: answer, inheritedSourceUserSeqs: [parent] }),
    [],
    'the parent\'s later resolved return clears its own earlier blocker in durable order',
  );
});

test('the answering source\'s own resolved return clears an inherited open blocker', () => {
  const sessionId = 'inherited-blockers-answer-resolves';
  const parent = source(sessionId, 'Draft the follow-up in Outlook.');
  returned(sessionId, parent, [blocked]);
  const answer = source(sessionId, 'Use the first mailbox.');
  returned(sessionId, answer, [resolved]);
  assert.deepEqual(
    provider.thisTurnSearchAccountSelectionBlockers({ sessionId, sourceUserSeq: answer, inheritedSourceUserSeqs: [parent] }),
    [],
  );
});
