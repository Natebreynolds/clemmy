import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, utimesSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const home = mkdtempSync(path.join(os.tmpdir(), 'clem-conversation-retention-'));
process.env.CLEMENTINE_HOME = home;
process.env.CLEMMY_TEST_ISOLATED_HOME = '1';
process.env.EMBEDDINGS_DISABLED = 'true';
const eventlog = await import('../runtime/harness/eventlog.js');
const retention = await import('./conversation-retention.js');
after(() => { eventlog.closeEventLog(); rmSync(home, { recursive: true, force: true }); });

test('automatic maintenance keeps aged conversation, exact results, Stop and working memory through reopen by default', () => {
  eventlog.resetEventLog();
  const session = eventlog.createSession({ kind: 'chat', title: 'A conversation to recall months later' });
  eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'Remember the full old conversation.' } });
  eventlog.writeToolOutput({ sessionId: session.id, callId: 'old-result', invocationNonce: 'old-result-nonce',
    tool: 'read_file', output: 'Complete retained result with its exact tail.' });
  eventlog.updateSession(session.id, { status: 'completed' });
  const db = eventlog.openEventLog();
  const old = '2020-01-01T00:00:00.000Z';
  db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(old, session.id);
  db.prepare('UPDATE tool_outputs SET created_at = ?').run(old);
  db.prepare('UPDATE tool_output_invocations SET created_at = ?').run(old);
  db.prepare('INSERT INTO harness_chat_request_cancellations VALUES (?, ?, ?)').run('old-stop', old, 'Do not restart this request.');
  const directory = path.join(home, 'state', 'working-memory');
  mkdirSync(directory, { recursive: true });
  const file = path.join(directory, `${createHash('sha1').update(session.id).digest('hex')}.md`);
  writeFileSync(file, 'Complete old working memory.');
  utimesSync(file, new Date(old), new Date(old));
  assert.deepEqual(retention.reapConfiguredConversationHistory({ policy: retention.automaticConversationRetentionPolicy({}) }),
    { toolOutputs: 0, sessions: 0, cancellations: 0, workingMemory: 0 });
  eventlog.closeEventLog();
  assert.ok(eventlog.getSession(session.id));
  assert.equal(eventlog.listEvents(session.id)[0]?.data.text, 'Remember the full old conversation.');
  const reopened = eventlog.openEventLog();
  for (const table of ['tool_outputs', 'tool_output_invocations']) {
    assert.equal((reopened.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n, 1);
  }
  assert.ok(eventlog.getHarnessChatCancellation('old-stop'));
  assert.equal(readFileSync(file, 'utf8'), 'Complete old working memory.');

  // An explicit operator policy still reaches the existing exact cleanup path.
  const failures: unknown[] = [];
  const reaped = retention.reapConfiguredConversationHistory({
    policy: retention.automaticConversationRetentionPolicy({ CLEMMY_SESSION_TTL_DAYS: '14', CLEMMY_TOOL_OUTPUT_TTL_DAYS: '14' }),
    onError: (store, error) => failures.push({ store, error }),
  });
  assert.deepEqual(failures, []);
  assert.deepEqual(reaped, { toolOutputs: 2, sessions: 1, cancellations: 1, workingMemory: 1 });
  assert.equal(eventlog.getSession(session.id), null);
  assert.equal(eventlog.getHarnessChatCancellation('old-stop'), null);
  assert.equal(existsSync(file), false);
});

test('missing, invalid, empty or disabled retention settings never authorize automatic deletion', () => {
  for (const value of [undefined, '', '  ', 'invalid', 'Infinity', '0', '-1']) {
    assert.deepEqual(retention.automaticConversationRetentionPolicy({ CLEMMY_SESSION_TTL_DAYS: value,
      CLEMMY_TOOL_OUTPUT_TTL_DAYS: value }), { sessionDays: null, toolOutputDays: null });
  }
  assert.deepEqual(retention.automaticConversationRetentionPolicy({ CLEMMY_SESSION_TTL_DAYS: '30' }),
    { sessionDays: 30, toolOutputDays: null });
});
