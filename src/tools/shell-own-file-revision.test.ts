/**
 * Run: node scripts/run-tests-isolated.mjs src/tools/shell-own-file-revision.test.ts
 *
 * A file this request wrote and then changed with its own shell command is
 * checked against the file it finished with, not reported as drift. Live
 * 2026-10-18: a reviewed, correct read log Clem appended to in the shell ended
 * the turn blocked on completion_review_artifact_drift.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const tmpHome = mkdtempSync(path.join(os.tmpdir(), 'clem-shell-own-file-'));
process.env.HOME = tmpHome;
process.env.CLEMENTINE_HOME = path.join(tmpHome, '.clementine-next');
process.env.EMBEDDINGS_DISABLED = 'true';
mkdirSync(process.env.CLEMENTINE_HOME, { recursive: true });
mkdirSync(path.join(tmpHome, 'out'), { recursive: true });

const { getComputerTools, executeLocalFileWrite } = await import('./computer-tools.js');
const eventlog = await import('../runtime/harness/eventlog.js');
const { withToolOutputContext } = await import('../runtime/harness/tool-output-context.js');
const { parseHostLocalWriteCommitFacts, readCommittedArtifactContent } = await import('../runtime/harness/host-local-write-commit.js');
const runner = await import('../runtime/harness/host-turn-runner.js');
after(() => { eventlog.closeEventLog(); rmSync(tmpHome, { recursive: true, force: true }); });

type Facts = NonNullable<ReturnType<typeof parseHostLocalWriteCommitFacts>>;

async function requestThatWrote(name: string, content: string) {
  const session = eventlog.createSession({ kind: 'chat', title: name });
  const source = eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'user', type: 'user_input_received',
    data: { text: 'TEST FIXTURE: write the read log, then fix it.' } });
  const file = path.join(tmpHome, 'out', `${name}.txt`);
  const result = await withToolOutputContext({ sessionId: session.id, sourceUserSeq: source.seq }, () => executeLocalFileWrite({
    path: file, content, mode: 'create', append: null, find: null,
  }));
  eventlog.appendEvent({ sessionId: session.id, turn: 1, role: 'tool', type: 'tool_returned',
    data: { sourceUserSeq: source.seq, tool: 'write_file', callId: `write-${name}`, accounting: 'top_level', result } });
  const facts = parseHostLocalWriteCommitFacts(result);
  assert.ok(facts, 'the write returned its receipt');
  return { sessionId: session.id, sourceUserSeq: source.seq, file, facts: facts as Facts };
}

async function shell(request: { sessionId: string; sourceUserSeq: number }, command: string, callId: string): Promise<string> {
  const tool = getComputerTools().find((candidate) => candidate.name === 'run_shell_command') as unknown as {
    invoke: (runContext: unknown, input: string, details: unknown) => Promise<string>;
  };
  return tool.invoke({ context: { sessionId: request.sessionId, sourceUserSeq: request.sourceUserSeq, turn: 1 } },
    JSON.stringify({ command, cwd: null, timeout_ms: 10_000 }), { toolCall: { callId } });
}

const recorded = (sessionId: string) => eventlog.listEvents(sessionId, { types: ['guardrail_tripped'] })
  .filter((event) => event.data.kind === 'own_file_revision_after_command');

test('a file this request wrote and then appended to in the shell is checked as the file it finished with', async () => {
  const request = await requestThatWrote('read-log', 'read:Olio');
  await shell(request, `printf 'unread:Olio\\n' >> '${request.file}'`, 'shell-append');
  assert.equal(readFileSync(request.file, 'utf8'), 'read:Olio\nunread:Olio\n');
  assert.equal(readCommittedArtifactContent(request.facts).verified, false, 'the write receipt alone now reads as drift');

  const events = recorded(request.sessionId);
  assert.equal(events.length, 1);
  assert.equal(events[0]?.data.callId, 'shell-append');
  assert.equal(events[0]?.role, 'system');
  const generations = runner.commandRevisionGenerations(request, [{ handle: request.facts.handle, facts: request.facts }]);
  assert.equal(generations.length, 1);
  assert.equal(generations[0]?.callId, 'shell-append');
  assert.equal(generations[0]?.facts.handle, request.facts.handle);
  const content = readCommittedArtifactContent(generations[0]!.facts);
  assert.equal(content.verified, true, 'the recorded revision is the file as it stands');
  assert.equal(content.parts[0]?.bytes.toString('utf8'), 'read:Olio\nunread:Olio\n');

  // The earlier bytes are kept as the revision's previous state, as a write keeps them.
  const descriptor = JSON.parse(readFileSync(path.join(process.env.CLEMENTINE_HOME!, request.facts.handle), 'utf8')) as {
    previous: { handle: string }; observedAfter: { tool: string; callId: string };
  };
  assert.deepEqual(descriptor.observedAfter, { tool: 'run_shell_command', callId: 'shell-append' });
  assert.equal(readFileSync(path.join(process.env.CLEMENTINE_HOME!, descriptor.previous.handle), 'utf8'), 'read:Olio\n');
});

test('a command that leaves the file alone, or deletes it, records nothing', async () => {
  const untouched = await requestThatWrote('untouched', 'kept');
  await shell(untouched, 'echo hello', 'shell-echo');
  assert.equal(recorded(untouched.sessionId).length, 0);
  assert.equal(readCommittedArtifactContent(untouched.facts).verified, true);

  const deleted = await requestThatWrote('deleted', 'gone soon');
  await shell(deleted, `rm '${deleted.file}'`, 'shell-rm');
  assert.equal(existsSync(deleted.file), false);
  assert.equal(recorded(deleted.sessionId).length, 0, 'a deleted file stays a real finding');
});

test('a file already changed before the command is not credited to it', async () => {
  const request = await requestThatWrote('changed-before', 'original');
  writeFileSync(request.file, 'edited outside this request\n');
  await shell(request, `printf 'more\\n' >> '${request.file}'`, 'shell-after-outside-edit');
  assert.equal(recorded(request.sessionId).length, 0, 'the host did not see the file at its recorded revision before the command');
  assert.deepEqual(runner.commandRevisionGenerations(request, [{ handle: request.facts.handle, facts: request.facts }]), []);
});

test('a recorded revision counts only for a file this request wrote, and only while the file still is that revision', async () => {
  const request = await requestThatWrote('later-write', 'one');
  await shell(request, `printf 'two\\n' >> '${request.file}'`, 'shell-two');
  assert.equal(runner.commandRevisionGenerations(request, [{ handle: 'state/local-file-revisions/' + 'f'.repeat(64) + '/current.json', facts: {} }]).length, 0,
    'another file\'s revision is not this request\'s');
  writeFileSync(request.file, 'three\n');
  assert.deepEqual(runner.commandRevisionGenerations(request, [{ handle: request.facts.handle, facts: request.facts }]), [],
    'a file changed again since is no longer that revision');
  unlinkSync(request.file);
});
